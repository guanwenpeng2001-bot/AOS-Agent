/** Foundation ExternalAgentConnector runtime with a durable start boundary. */

import { randomUUID } from "node:crypto";
import {
	canonicalFoundationJson,
	createAttempt as createFoundationAttempt,
	fingerprintFoundationValue,
	FoundationError,
	Result,
	validateAttemptReceiptForProvider,
	validateConnectorCapabilitySnapshotForProvider,
	validateExecutionCorrelation,
	validateImmutableAgentBinding,
	type AgentBinding,
	type Attempt,
	type AttemptReceipt,
	type ConnectorCapabilitySnapshot,
	type Dispatch,
	type ExecutionCorrelation,
	type ExternalAgentConnector,
	type FoundationProviderCapability,
	type FoundationProviderExecutionOptions,
	type Result as ResultValue,
	type TaskExecutorAttemptContext,
} from "@aos-agent/agent-core";
import {
	cloneExternalConnectorOperation,
	transitionExternalConnectorOperation,
	type ExternalConnectorDurableStore,
	type ExternalConnectorOperation,
	type ExternalConnectorReconcileReason,
} from "./external-agent-operation.ts";
import {
	cloneCanonicalExternalConnectorMapping,
	isCanonicalExternalConnectorMappingTimestamp,
	type CanonicalExternalConnectorMapping,
} from "./external-session-mapping.ts";
import type {
	ExternalConnectorDriverHandle,
	ExternalConnectorVendorDriver,
} from "./vendor-drivers/types.ts";
import {
	ExternalConnectorBoundedSupervisor,
	ExternalConnectorSupervisorError,
	externalConnectorSupervisorFailure,
	runExternalConnectorHostDispose,
	type ExternalConnectorProcessContainment,
	type ExternalConnectorProcessController,
	type ExternalConnectorSupervisorDeadlineOverrides,
	type ExternalConnectorSupervisorLimits,
	type ExternalConnectorSupervisorPrivateStateEntry,
	type ExternalConnectorSupervisorReference,
	type ExternalConnectorSupervisorPrivateStateStore,
} from "./external-connector-supervisor.ts";
import type { RuntimeClock } from "./runtime-clock.ts";
import {
	translateExternalModelProjection,
	type ExternalModelTranslationResult,
	type ExternalResolvedModelProjection,
} from "./external-model-projection.ts";
import {
	cloneExternalConnectorTerminalEvidence,
	isExternalConnectorDriverHandle,
	isExternalConnectorDriverLookup,
	type ExternalConnectorTerminalEvidence,
} from "./vendor-drivers/types.ts";

export interface ExternalAgentConnectorRuntimeOptions {
	readonly providerId: string;
	readonly capability: ConnectorCapabilitySnapshot;
	readonly store: ExternalConnectorDurableStore;
	readonly driver: ExternalConnectorVendorDriver;
	readonly supervision: {
		readonly containment: ExternalConnectorProcessContainment;
		readonly processController: ExternalConnectorProcessController;
		readonly privateStateStore: ExternalConnectorSupervisorPrivateStateStore;
		readonly deadlines?: ExternalConnectorSupervisorDeadlineOverrides;
		readonly limits?: Partial<ExternalConnectorSupervisorLimits>;
		readonly clock?: RuntimeClock;
	};
	readonly now?: () => string;
	readonly operationNonce?: () => string;
}

export interface ExternalConnectorStartupRecoveryResult {
	readonly attemptId: string;
	readonly status: "cleanup_confirmed_state_retained" | "quarantined" | "reaped";
}

const EXTERNAL_CONNECTOR_CAPABILITIES: readonly FoundationProviderCapability[] = Object.freeze([
	Object.freeze({ schemaVersion: 1, id: "external_connector.lifecycle", version: 1 }),
]);

export interface HostSupervisedExternalAgentConnectorImplementation {
	readonly schemaVersion: ExternalAgentConnector["schemaVersion"];
	readonly providerId: ExternalAgentConnector["providerId"];
	readonly providerClass: ExternalAgentConnector["providerClass"];
	readonly preflightModelProjection: (
		projection: ExternalResolvedModelProjection,
	) => ExternalModelTranslationResult;
	readonly capabilities: ExternalAgentConnector["capabilities"];
	readonly dispose: ExternalAgentConnector["dispose"];
	readonly probeCapabilities: ExternalAgentConnector["probeCapabilities"];
	readonly createAttempt: ExternalAgentConnector["createAttempt"];
	readonly runAttempt: ExternalAgentConnector["runAttempt"];
	readonly cancelAttempt: ExternalAgentConnector["cancelAttempt"];
	readonly resumeAttempt: ExternalAgentConnector["resumeAttempt"];
	readonly reconcileAttempt: ExternalAgentConnector["reconcileAttempt"];
}

type HostSupervisedExternalAgentConnectorProperty = keyof HostSupervisedExternalAgentConnectorImplementation;

interface CapturedExternalConnectorProperty {
	readonly key: HostSupervisedExternalAgentConnectorProperty;
	readonly owner: object;
	readonly descriptor: Readonly<PropertyDescriptor>;
}

interface HostSupervisedExternalAgentConnectorProof {
	readonly prototype: object | null;
	readonly properties: readonly CapturedExternalConnectorProperty[];
	readonly implementation: HostSupervisedExternalAgentConnectorImplementation;
}

const HOST_SUPERVISED_EXTERNAL_CONNECTOR_PROPERTIES = Object.freeze([
	"schemaVersion",
	"providerId",
	"providerClass",
	"preflightModelProjection",
	"capabilities",
	"dispose",
	"probeCapabilities",
	"createAttempt",
	"runAttempt",
	"cancelAttempt",
	"resumeAttempt",
	"reconcileAttempt",
] satisfies readonly HostSupervisedExternalAgentConnectorProperty[]);
const HOST_SUPERVISED_EXTERNAL_CONNECTORS = new WeakMap<object, HostSupervisedExternalAgentConnectorProof>();

function resolveExternalConnectorProperty(
	value: object,
	key: HostSupervisedExternalAgentConnectorProperty,
): Omit<CapturedExternalConnectorProperty, "key"> | undefined {
	let owner: object | null = value;
	while (owner !== null) {
		const descriptor = Object.getOwnPropertyDescriptor(owner, key);
		if (descriptor !== undefined) return { owner, descriptor };
		owner = Object.getPrototypeOf(owner) as object | null;
	}
	return undefined;
}

function sameExternalConnectorProperty(
	value: object,
	captured: CapturedExternalConnectorProperty,
): boolean {
	const current = resolveExternalConnectorProperty(value, captured.key);
	if (current === undefined || current.owner !== captured.owner) return false;
	const left = current.descriptor;
	const right = captured.descriptor;
	return (
		left.configurable === right.configurable &&
		left.enumerable === right.enumerable &&
		left.writable === right.writable &&
		left.get === right.get &&
		left.set === right.set &&
		Object.is(left.value, right.value)
	);
}

function captureHostSupervisedExternalAgentConnector(
	connector: DurableExternalAgentConnector,
	methods: Pick<
		HostSupervisedExternalAgentConnectorImplementation,
		| "capabilities"
		| "preflightModelProjection"
		| "dispose"
		| "probeCapabilities"
		| "createAttempt"
		| "runAttempt"
		| "cancelAttempt"
		| "resumeAttempt"
		| "reconcileAttempt"
	>,
): HostSupervisedExternalAgentConnectorProof {
	if (
		connector.preflightModelProjection !== methods.preflightModelProjection ||
		connector.capabilities !== methods.capabilities ||
		connector.dispose !== methods.dispose ||
		connector.probeCapabilities !== methods.probeCapabilities ||
		connector.createAttempt !== methods.createAttempt ||
		connector.runAttempt !== methods.runAttempt ||
		connector.cancelAttempt !== methods.cancelAttempt ||
		connector.resumeAttempt !== methods.resumeAttempt ||
		connector.reconcileAttempt !== methods.reconcileAttempt
	) {
		throw new Error("Host-supervised external connector implementation changed before construction.");
	}
	const properties = HOST_SUPERVISED_EXTERNAL_CONNECTOR_PROPERTIES.map((key) => {
		const resolved = resolveExternalConnectorProperty(connector, key);
		if (resolved === undefined) {
			throw new Error(`Host-supervised external connector property ${key} is unavailable.`);
		}
		return Object.freeze({
			key,
			owner: resolved.owner,
			descriptor: Object.freeze({ ...resolved.descriptor }),
		});
	});
	return Object.freeze({
		prototype: Object.getPrototypeOf(connector) as object | null,
		properties: Object.freeze(properties),
		implementation: Object.freeze({
			schemaVersion: connector.schemaVersion,
			providerId: connector.providerId,
			providerClass: connector.providerClass,
			preflightModelProjection: methods.preflightModelProjection,
			capabilities: methods.capabilities,
			dispose: methods.dispose,
			probeCapabilities: methods.probeCapabilities,
			createAttempt: methods.createAttempt,
			runAttempt: methods.runAttempt,
			cancelAttempt: methods.cancelAttempt,
			resumeAttempt: methods.resumeAttempt,
			reconcileAttempt: methods.reconcileAttempt,
		}),
	});
}

/** @internal Exact runtime proof minted only by the Host-supervised durable connector factory. */
export function getHostSupervisedExternalAgentConnectorImplementation(
	value: unknown,
): HostSupervisedExternalAgentConnectorImplementation | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const proof = HOST_SUPERVISED_EXTERNAL_CONNECTORS.get(value);
	if (
		proof === undefined ||
		Object.getPrototypeOf(value) !== proof.prototype ||
		!proof.properties.every((property) => sameExternalConnectorProperty(value, property))
	) {
		return undefined;
	}
	return proof.implementation;
}

/** @internal Runtime proof minted only by the Host-supervised durable connector factory. */
export function isHostSupervisedExternalAgentConnector(value: unknown): value is ExternalAgentConnector {
	return getHostSupervisedExternalAgentConnectorImplementation(value) !== undefined;
}

export function externalConnectorAttemptId(providerId: string, dispatchId: string): string {
	return `external_attempt_${fingerprintFoundationValue({ providerId, dispatchId }).value}`;
}

function sameFingerprint(
	left: { readonly algorithm: "sha256"; readonly value: string },
	right: { readonly algorithm: "sha256"; readonly value: string },
): boolean {
	return left.algorithm === right.algorithm && left.value === right.value;
}

function externalFailure(
	code:
		| "binding_epoch_mismatch"
		| "binding_required_fact"
		| "invalid_correlation"
		| "provider_spawn_failed"
		| "scheduler_attempt_recovery_failed"
		| "side_effect_unknown"
		| "unsupported_feature"
		| "worker_cancel_failed"
		| "worker_lost",
	message: string,
	attemptId?: string,
): FoundationError {
	return new FoundationError(code, message, attemptId === undefined ? {} : { details: { attemptId } });
}

function isDeadlineAbort(signal: AbortSignal | undefined): boolean {
	const reason = signal?.reason;
	return (
		typeof reason === "object" &&
		reason !== null &&
		(("code" in reason && reason.code === "deadline_exceeded") ||
			("name" in reason && reason.name === "AgentDeadlineExceeded"))
	);
}

function isAbortedSignal(signal: AbortSignal | undefined): boolean {
	return signal?.aborted === true;
}

function supervisedFailureEvidence(
	error: unknown,
	handle: ExternalConnectorDriverHandle,
	now: () => string,
	sourceSignal?: AbortSignal,
): ExternalConnectorTerminalEvidence | undefined {
	let code: "external_event_invalid" | "external_resource_limit_exceeded" | "run_deadline_exceeded";
	let message: string;
	let category: "side_effect_unknown" | "deadline";
	if (isDeadlineAbort(sourceSignal)) {
		code = "run_deadline_exceeded";
		message = "External connector run deadline was exceeded.";
		category = "deadline";
	} else if (
		error instanceof ExternalConnectorSupervisorError &&
		(error.code === "external_event_invalid" || error.code === "external_resource_limit_exceeded")
	) {
		code = error.code;
		message = error.code === "external_event_invalid"
			? "External connector emitted invalid supervised output."
			: "External connector exceeded a supervised resource limit.";
		category = "side_effect_unknown";
	} else {
		return undefined;
	}
	return {
		externalSessionId: handle.externalSessionId,
		...(handle.externalTurnId === undefined ? {} : { externalTurnId: handle.externalTurnId }),
		operationNonce: handle.operationNonce,
		status: "failed",
		artifacts: [],
		error: { code, message, category, retryable: false },
		sideEffectState: "unknown",
		producedAt: now(),
	};
}

/**
 * One runtime implements the merged Foundation ExternalAgentConnector and
 * TaskExecutorProvider contract. Only runAttempt crosses the durable start
 * intent into driver.spawn; resume and reconcile never call spawn.
 */
export class DurableExternalAgentConnector implements ExternalAgentConnector {
	readonly schemaVersion = 1 as const;
	readonly providerClass = "external_connector" as const;
	readonly providerId: string;
	readonly #capability: ConnectorCapabilitySnapshot;
	readonly #store: ExternalConnectorDurableStore;
	readonly #driver: ExternalConnectorVendorDriver;
	readonly #supervision: ExternalAgentConnectorRuntimeOptions["supervision"];
	readonly #now: () => string;
	readonly #operationNonce: () => string;
	readonly #supervisors = new Map<string, ExternalConnectorBoundedSupervisor>();
	readonly #driverHandles = new Map<string, ExternalConnectorDriverHandle>();
	readonly #observationControllers = new Map<string, AbortController>();
	readonly #pendingCancellations = new Set<string>();
	readonly #active = new Map<string, Promise<ResultValue<AttemptReceipt, FoundationError>>>();
	readonly #cancelling = new Map<string, Promise<ResultValue<void, FoundationError>>>();

	constructor(options: ExternalAgentConnectorRuntimeOptions) {
		const checked = validateConnectorCapabilitySnapshotForProvider(options.capability, {
			providerId: options.providerId,
			providerClass: "external_connector",
		});
		if (!checked.ok) throw checked.error;
		if (
			options.supervision === undefined ||
			(options.supervision.containment !== "process_group" && options.supervision.containment !== "job_object") ||
			typeof options.supervision.processController?.launch !== "function" ||
			typeof options.supervision.privateStateStore?.list !== "function" ||
			typeof options.supervision.privateStateStore?.read !== "function" ||
			typeof options.supervision.privateStateStore?.write !== "function" ||
			typeof options.supervision.privateStateStore?.delete !== "function"
		) throw externalFailure("invalid_correlation", "External connector supervision is invalid");
		this.providerId = options.providerId;
		this.#capability = checked.value;
		this.#store = options.store;
		this.#driver = options.driver;
		this.#supervision = options.supervision;
		this.#now = options.now ?? (() => new Date().toISOString());
		this.#operationNonce = options.operationNonce ?? randomUUID;
	}

	/** Reap every provable Host-owned process tree before production accepts lifecycle work. */
	async recoverPrivateSupervisorState(): Promise<readonly ExternalConnectorStartupRecoveryResult[]> {
		const entries = await this.#supervision.privateStateStore.list();
		const results: ExternalConnectorStartupRecoveryResult[] = [];
		for (const entry of entries) {
			const supervisor = this.#createSupervisorForReference(entry.state.reference);
			try {
				await supervisor.recoverAndReap(entry.state);
			} catch {
				await this.#markStartupReconcile(entry);
				results.push(Object.freeze({ attemptId: entry.attemptId, status: "quarantined" }));
				continue;
			}
			if (!supervisor.snapshot.cleaned) {
				await this.#markStartupReconcile(entry);
				results.push(Object.freeze({ attemptId: entry.attemptId, status: "quarantined" }));
				continue;
			}
			try {
				await this.#supervision.privateStateStore.delete(entry.attemptId);
			} catch {
				await this.#markStartupReconcile(entry);
				results.push(Object.freeze({
					attemptId: entry.attemptId,
					status: "cleanup_confirmed_state_retained",
				}));
				continue;
			}
			await this.#markStartupReconcile(entry);
			results.push(Object.freeze({ attemptId: entry.attemptId, status: "reaped" }));
		}
		return Object.freeze(results);
	}

	preflightModelProjection(projection: ExternalResolvedModelProjection): ExternalModelTranslationResult {
		return translateExternalModelProjection(projection, this.#driver.modelSupportMatrix);
	}

	async capabilities(): Promise<readonly FoundationProviderCapability[]> {
		return EXTERNAL_CONNECTOR_CAPABILITIES;
	}

	async probeCapabilities(): Promise<ResultValue<ConnectorCapabilitySnapshot, FoundationError>> {
		return Result.ok(this.#capability);
	}

	async createAttempt(
		dispatch: Dispatch,
		binding: AgentBinding,
		context?: TaskExecutorAttemptContext,
	): Promise<ResultValue<Attempt, FoundationError>> {
		if (
			dispatch.taskExecutorProviderId !== this.providerId ||
			dispatch.bindingId !== binding.bindingId ||
			dispatch.taskId !== binding.taskId
		) {
			return Result.err(externalFailure("invalid_correlation", "External connector Dispatch and binding do not match"));
		}
		const checkedBinding = validateImmutableAgentBinding(binding);
		if (!checkedBinding.ok) return checkedBinding;
		if (context === undefined) {
			return Result.err(externalFailure("binding_epoch_mismatch", "External connector Attempt requires its initial BindingEpoch"));
		}
		const attemptId = externalConnectorAttemptId(this.providerId, dispatch.dispatchId);
		return createFoundationAttempt({
			attemptId,
			dispatch,
			providerId: this.providerId,
			providerClass: this.providerClass,
			initialBindingEpoch: context.initialBindingEpoch,
			now: () => context.initialBindingEpoch.activatedAt,
		});
	}

	runAttempt(
		attempt: Attempt,
		options?: FoundationProviderExecutionOptions,
	): Promise<ResultValue<AttemptReceipt, FoundationError>> {
		return this.#exclusive(attempt.attemptId, () => this.#run(attempt, options));
	}

	resumeAttempt(
		attempt: Attempt,
		options?: FoundationProviderExecutionOptions,
	): Promise<ResultValue<AttemptReceipt, FoundationError>> {
		return this.#exclusive(attempt.attemptId, () => this.#resume(attempt, options));
	}

	reconcileAttempt(
		attempt: Attempt,
		options?: FoundationProviderExecutionOptions,
	): Promise<ResultValue<AttemptReceipt, FoundationError>> {
		return this.#exclusive(attempt.attemptId, () => this.#reconcile(attempt, options));
	}

	cancelAttempt(attemptId: string): Promise<ResultValue<void, FoundationError>> {
		const active = this.#cancelling.get(attemptId);
		if (active !== undefined) return active;
		const cancellation = this.#captureVoid(() => this.#cancel(attemptId));
		this.#cancelling.set(attemptId, cancellation);
		void cancellation.finally(() => this.#cancelling.delete(attemptId));
		return cancellation;
	}

	async dispose(): Promise<void> {
		const supervisors = [...this.#supervisors.entries()];
		const disposalSupervisor = supervisors[0]?.[1];
		let disposalFailure: unknown;
		try {
			if (disposalSupervisor !== undefined) {
				await disposalSupervisor.run(
					"dispose",
					(signal) => this.#driver.dispose({ signal }),
				);
			} else {
				await runExternalConnectorHostDispose(
					(signal) => this.#driver.dispose({ signal }),
					{
						...(this.#supervision.deadlines?.dispose === undefined
							? {}
							: { deadline: this.#supervision.deadlines.dispose }),
						...(this.#supervision.clock === undefined ? {} : { clock: this.#supervision.clock }),
					},
				);
			}
		} catch (error) {
			disposalFailure = error;
		}
		const cleanupResults = await Promise.allSettled(supervisors.map(async ([attemptId, supervisor]) => {
			await supervisor.dispose();
			if (supervisor.snapshot.cleaned) await this.#supervision.privateStateStore.delete(attemptId);
		}));
		this.#supervisors.clear();
		this.#driverHandles.clear();
		for (const controller of this.#observationControllers.values()) controller.abort();
		this.#observationControllers.clear();
		this.#pendingCancellations.clear();
		disposalFailure ??= cleanupResults.find((result) => result.status === "rejected")?.reason;
		if (disposalFailure !== undefined) throw disposalFailure;
	}

	#exclusive(
		attemptId: string,
		operation: () => Promise<ResultValue<AttemptReceipt, FoundationError>>,
	): Promise<ResultValue<AttemptReceipt, FoundationError>> {
		const active = this.#active.get(attemptId);
		if (active !== undefined) return active;
		const current = this.#capture(operation);
		this.#active.set(attemptId, current);
		void current.finally(() => this.#active.delete(attemptId));
		return current;
	}

	async #capture(
		operation: () => Promise<ResultValue<AttemptReceipt, FoundationError>>,
	): Promise<ResultValue<AttemptReceipt, FoundationError>> {
		try {
			return await operation();
		} catch (error) {
			return Result.err(
				error instanceof FoundationError
					? error
					: error instanceof ExternalConnectorSupervisorError
						? externalConnectorSupervisorFailure(error)
					: externalFailure("worker_lost", "External connector lifecycle operation failed"),
			);
		}
	}

	async #captureVoid(operation: () => Promise<ResultValue<void, FoundationError>>): Promise<ResultValue<void, FoundationError>> {
		try {
			return await operation();
		} catch (error) {
			return Result.err(
				error instanceof FoundationError
					? error
					: error instanceof ExternalConnectorSupervisorError
						? externalConnectorSupervisorFailure(error)
					: externalFailure("worker_cancel_failed", "External connector cancellation failed"),
			);
		}
	}

	#createSupervisor(operation: ExternalConnectorOperation): ExternalConnectorBoundedSupervisor {
		return this.#createSupervisorForReference({
				schemaVersion: 1,
				supervisorRef: `external_supervisor_${fingerprintFoundationValue({
					providerId: this.providerId,
					attemptId: operation.attemptId,
				}).value.slice(0, 32)}`,
				operationNonce: operation.operationNonce,
			});
	}

	#createSupervisorForReference(reference: ExternalConnectorSupervisorReference): ExternalConnectorBoundedSupervisor {
		return new ExternalConnectorBoundedSupervisor({
			reference,
			containment: this.#supervision.containment,
			processController: this.#supervision.processController,
			artifactsAllowed: this.#capability.artifacts,
			deadlines: this.#supervision.deadlines,
			limits: this.#supervision.limits,
			clock: this.#supervision.clock,
		});
	}

	async #markStartupReconcile(entry: ExternalConnectorSupervisorPrivateStateEntry): Promise<void> {
		try {
			const operationValue = await this.#store.readOperation(entry.attemptId);
			if (operationValue === undefined) return;
			const operation = cloneExternalConnectorOperation(operationValue);
			if (
				operation.providerId !== this.providerId ||
				operation.attemptId !== entry.attemptId ||
				operation.operationNonce !== entry.state.reference.operationNonce ||
				operation.status === "terminal" ||
				operation.status === "reconcile_required"
			) return;
			await this.#markReconcile(operation, "driver_failure");
		} catch {
			// Process cleanup is authoritative only for private identity; corrupt canonical state stays untouched.
		}
	}

	async #launchSupervisor(
		operation: ExternalConnectorOperation,
		signal?: AbortSignal,
	): Promise<ExternalConnectorBoundedSupervisor> {
		const supervisor = this.#createSupervisor(operation);
		let statePersisted = false;
		try {
			if (signal?.aborted === true) throw signal.reason;
			await supervisor.launch(async (state) => {
				await this.#supervision.privateStateStore.write(operation.attemptId, state);
				statePersisted = true;
			});
			this.#supervisors.set(operation.attemptId, supervisor);
			return supervisor;
		} catch (error) {
			const privateState = supervisor.hostPrivateState;
			if (privateState !== undefined) {
				try {
					await supervisor.dispose();
				} catch (cleanupError) {
					if (!statePersisted) {
						await this.#supervision.privateStateStore
							.write(operation.attemptId, privateState)
							.catch(() => undefined);
					}
					throw externalConnectorSupervisorFailure(cleanupError);
				}
				if (supervisor.snapshot.cleaned) {
					await this.#supervision.privateStateStore.delete(operation.attemptId).catch(() => undefined);
				}
			}
			throw externalConnectorSupervisorFailure(error);
		}
	}

	async #releaseSupervisor(attemptId: string, supervisor: ExternalConnectorBoundedSupervisor): Promise<void> {
		await supervisor.dispose();
		if (!supervisor.snapshot.cleaned) {
			throw externalConnectorSupervisorFailure(
				new Error("External Connector supervisor process did not terminate"),
			);
		}
		this.#supervisors.delete(attemptId);
		this.#driverHandles.delete(attemptId);
		this.#observationControllers.delete(attemptId);
		await this.#supervision.privateStateStore.delete(attemptId);
	}

	async #recoverSupervisorWithoutMapping(operation: ExternalConnectorOperation): Promise<void> {
		const privateState = await this.#supervision.privateStateStore.read(operation.attemptId);
		if (privateState === undefined) return;
		const supervisor = this.#createSupervisor(operation);
		await supervisor.recoverAndReap(privateState);
		if (!supervisor.snapshot.cleaned) {
			throw externalConnectorSupervisorFailure(
				new Error("External Connector recovered process did not terminate"),
			);
		}
		await this.#supervision.privateStateStore.delete(operation.attemptId);
		this.#supervisors.delete(operation.attemptId);
		this.#driverHandles.delete(operation.attemptId);
		this.#observationControllers.delete(operation.attemptId);
	}

	async #reattachSupervisor(
		operation: ExternalConnectorOperation,
		signal?: AbortSignal,
	): Promise<ExternalConnectorBoundedSupervisor> {
		const throwIfAborted = (): void => {
			if (signal?.aborted === true) throw externalConnectorSupervisorFailure(signal.reason);
		};
		throwIfAborted();
		const active = this.#supervisors.get(operation.attemptId);
		if (active !== undefined) return active;
		const state = await this.#supervision.privateStateStore.read(operation.attemptId);
		throwIfAborted();
		if (state === undefined) {
			throw externalConnectorSupervisorFailure(
				new ExternalConnectorSupervisorError("reconcile_required", "dispose", false),
			);
		}
		const supervisor = this.#createSupervisor(operation);
		try {
			supervisor.reattach(state);
			this.#supervisors.set(operation.attemptId, supervisor);
			return supervisor;
		} catch (error) {
			throw externalConnectorSupervisorFailure(error);
		}
	}

	#requireAuthoritativeDriverHandle(
		value: unknown,
		supervisor: ExternalConnectorBoundedSupervisor,
		mapping?: CanonicalExternalConnectorMapping,
	): ResultValue<ExternalConnectorDriverHandle, FoundationError> {
		if (
			!isExternalConnectorDriverHandle(value) ||
			value.supervisorRef !== supervisor.reference.supervisorRef ||
			value.operationNonce !== supervisor.reference.operationNonce ||
			(mapping !== undefined &&
				(value.externalSessionId !== mapping.externalSessionId ||
					(value.externalTurnId ?? undefined) !== (mapping.externalTurnId ?? undefined) ||
					value.supervisorRef !== mapping.supervisor.ref ||
					value.operationNonce !== mapping.supervisor.nonce))
		) {
			return Result.err(externalFailure("invalid_correlation", "External connector driver handle conflicts with durable authority"));
		}
		return Result.ok(Object.freeze({
			externalSessionId: value.externalSessionId,
			...(value.externalTurnId === undefined ? {} : { externalTurnId: value.externalTurnId }),
			supervisorRef: value.supervisorRef,
			operationNonce: value.operationNonce,
		}));
	}

	async #run(
		attempt: Attempt,
		options?: FoundationProviderExecutionOptions,
	): Promise<ResultValue<AttemptReceipt, FoundationError>> {
		const isAborted = (): boolean =>
			options?.signal?.aborted === true || this.#pendingCancellations.has(attempt.attemptId);
		const durable = await this.#requireDurableAttempt(attempt);
		if (!durable.ok) return durable;
		const priorReceipt = await this.#requirePriorReceipt(attempt);
		if (!priorReceipt.ok) return priorReceipt;
		if (priorReceipt.value !== undefined) return Result.ok(priorReceipt.value);
		if (attempt.status !== "starting") {
			return Result.err(externalFailure("scheduler_attempt_recovery_failed", "runAttempt requires a not-started durable Attempt", attempt.attemptId));
		}
		const binding = await this.#requireBinding(attempt);
		if (!binding.ok) return binding;
		const correlation = this.#requireCorrelation(attempt, options?.correlation);
		if (!correlation.ok) return correlation;
		if (isAborted()) {
			return this.#settleCancelledBeforeLaunch(attempt, correlation.value, undefined, options?.signal);
		}
		const executionInput = await this.#store.readExecutionInput(attempt.taskId);
		if (executionInput === undefined) {
			return Result.err(externalFailure("binding_required_fact", "External connector requires durable canonical input", attempt.attemptId));
		}
		if (
			(this.#capability.modelAccess === "aos_gateway") !== (executionInput.modelProjection !== undefined) ||
			(executionInput.modelProjection === undefined) !== (executionInput.modelTranslation === undefined)
		) {
			return Result.err(externalFailure("binding_required_fact", "External connector model projection does not match its capability", attempt.attemptId));
		}
		let modelTranslation = executionInput.modelTranslation;
		if (executionInput.modelProjection !== undefined) {
			const translated = translateExternalModelProjection(
				executionInput.modelProjection,
				this.#driver.modelSupportMatrix,
			);
			if (
				!translated.ok ||
				modelTranslation === undefined ||
				canonicalFoundationJson(translated.translation) !== canonicalFoundationJson(modelTranslation)
			) {
				return Result.err(externalFailure("binding_required_fact", "External connector model translation is unavailable or drifted", attempt.attemptId));
			}
			modelTranslation = translated.translation;
		}

		let operation = await this.#store.readOperation(attempt.attemptId);
		if (operation === undefined) {
			operation = await this.#store.writeOperation({
				schemaVersion: 1,
				providerId: this.providerId,
				attemptId: attempt.attemptId,
				bindingId: attempt.bindingId,
				bindingEpochId: attempt.bindingEpochIds[0]!,
				bindingDigest: binding.value.fingerprint,
				bindingRevision: binding.value.contextRevision.revision,
				capabilityDigest: this.#capability.digest,
				capabilityRevision: this.#capability.revision,
				operationNonce: this.#operationNonce(),
				correlation: correlation.value,
				status: "prepared",
				revision: 1,
				updatedAt: this.#now(),
			});
		}
		if (isAborted()) {
			return this.#settleCancelledBeforeLaunch(attempt, correlation.value, operation, options?.signal);
		}
		const frozen = await this.#requireFrozenFacts(operation, attempt, binding.value);
		if (!frozen.ok) return frozen;
		if (operation.status !== "prepared") {
			if (operation.status === "start_intent") {
				await this.#markReconcile(operation, "start_outcome_unknown");
			}
			return Result.err(externalFailure("scheduler_attempt_recovery_failed", "External connector Attempt is not safe to start", attempt.attemptId));
		}

		operation = await this.#store.writeOperation(
			transitionExternalConnectorOperation(operation, "start_intent", { now: this.#now() }),
		);
		if (isAborted()) {
			return this.#settleCancelledBeforeLaunch(attempt, correlation.value, operation, options?.signal);
		}
		const operationNonce = operation.operationNonce;
		let supervisor: ExternalConnectorBoundedSupervisor;
		try {
			supervisor = await this.#launchSupervisor(operation, options?.signal);
		} catch {
			if (isAborted()) {
				return this.#settleCancelledBeforeLaunch(attempt, correlation.value, operation, options?.signal);
			}
			await this.#markReconcile(operation, "start_outcome_unknown");
			return Result.err(externalFailure("side_effect_unknown", "External connector process launch could not be proven", attempt.attemptId));
		}
		if (isAborted()) {
			await this.#releaseSupervisor(attempt.attemptId, supervisor).catch(() => undefined);
			return this.#settleCancelledBeforeLaunch(attempt, correlation.value, operation, options?.signal);
		}
		let handle: ExternalConnectorDriverHandle;
		let spawnCalled = false;
		try {
			handle = await supervisor.run("start", (signal) => {
				spawnCalled = true;
				return this.#driver.spawn({
					attempt,
					input: executionInput.input,
					...(executionInput.modelProjection === undefined ? {} : { modelProjection: executionInput.modelProjection }),
					...(modelTranslation === undefined ? {} : { modelTranslation }),
					capability: this.#capability,
					bindingDigest: binding.value.fingerprint.value,
					bindingRevision: binding.value.contextRevision.revision,
					supervisorRef: supervisor.reference.supervisorRef,
					operationNonce,
					signal,
				});
			}, options?.signal);
		} catch {
			if (supervisor.snapshot.cleaned) {
				this.#supervisors.delete(attempt.attemptId);
				await this.#supervision.privateStateStore.delete(attempt.attemptId);
			}
			if (isAborted()) {
				return spawnCalled
					? this.#settleFailedWithoutMapping(attempt, correlation.value, operation, options?.signal)
					: this.#settleCancelledBeforeLaunch(attempt, correlation.value, operation, options?.signal);
			}
			await this.#markReconcile(operation, "start_outcome_unknown");
			return Result.err(externalFailure("provider_spawn_failed", "External connector start outcome is unknown", attempt.attemptId));
		}

		const checkedHandle = this.#requireAuthoritativeDriverHandle(handle, supervisor);
		if (!checkedHandle.ok) {
			await this.#releaseSupervisor(attempt.attemptId, supervisor).catch(() => undefined);
			await this.#markReconcile(operation, "mapping_conflict");
			return Result.err(checkedHandle.error);
		}
		handle = checkedHandle.value;
		let mapping: CanonicalExternalConnectorMapping;
		try {
			mapping = cloneCanonicalExternalConnectorMapping({
				schemaVersion: 1,
				providerId: this.providerId,
				attemptId: attempt.attemptId,
				externalSessionId: handle.externalSessionId,
				...(handle.externalTurnId === undefined ? {} : { externalTurnId: handle.externalTurnId }),
				binding: {
					digest: binding.value.fingerprint,
					revision: binding.value.contextRevision.revision,
				},
				capability: { digest: this.#capability.digest, revision: this.#capability.revision },
				supervisor: { ref: handle.supervisorRef, nonce: handle.operationNonce },
				createdAt: this.#now(),
			});
			mapping = await this.#store.writeMapping(mapping, operation.correlation);
		} catch {
			await this.#releaseSupervisor(attempt.attemptId, supervisor).catch(() => undefined);
			await this.#markReconcile(operation, "mapping_persistence_unknown");
			return Result.err(externalFailure("side_effect_unknown", "External connector mapping could not be proven durable", attempt.attemptId));
		}
		this.#driverHandles.set(attempt.attemptId, handle);
		operation = await this.#store.writeOperation(
			transitionExternalConnectorOperation(operation, "running", { now: this.#now() }),
		);
		if (this.#pendingCancellations.has(attempt.attemptId)) {
			const cancellation = await this.#cancel(attempt.attemptId);
			if (!cancellation.ok) return Result.err(cancellation.error);
			const cancelledReceipt = await this.#requirePriorReceipt(attempt);
			if (!cancelledReceipt.ok) return cancelledReceipt;
			if (cancelledReceipt.value !== undefined) return Result.ok(cancelledReceipt.value);
		}
		try {
			const evidence = await this.#observeToReceipt(attempt.attemptId, supervisor, handle, options?.signal);
			const concurrentReceipt = await this.#requirePriorReceipt(attempt);
			if (!concurrentReceipt.ok) return concurrentReceipt;
			if (concurrentReceipt.value !== undefined) {
				await this.#releaseSupervisor(attempt.attemptId, supervisor).catch(() => undefined);
				return Result.ok(concurrentReceipt.value);
			}
			await this.#releaseSupervisor(attempt.attemptId, supervisor);
			return await this.#settle(attempt, operation, mapping, evidence);
		} catch (error) {
			if (supervisor.snapshot.cleaned) {
				this.#supervisors.delete(attempt.attemptId);
				await this.#supervision.privateStateStore.delete(attempt.attemptId);
			}
			this.#driverHandles.delete(attempt.attemptId);
			this.#observationControllers.delete(attempt.attemptId);
			const concurrentReceipt = await this.#requirePriorReceipt(attempt);
			if (concurrentReceipt.ok && concurrentReceipt.value !== undefined) {
				return Result.ok(concurrentReceipt.value);
			}
			if (options?.signal?.aborted === true && !supervisor.snapshot.cleaned) {
				await this.#markReconcile(operation, "driver_failure");
				return Result.err(externalFailure("side_effect_unknown", "External connector process cleanup is unknown", attempt.attemptId));
			}
			const failureEvidence = supervisedFailureEvidence(error, handle, this.#now, options?.signal);
			if (failureEvidence !== undefined) {
				return this.#settle(attempt, operation, mapping, failureEvidence);
			}
			await this.#markReconcile(
				operation,
				error instanceof ExternalConnectorSupervisorError && error.code === "terminal_evidence_invalid"
					? "mapping_conflict"
					: "driver_failure",
			);
			return Result.err(externalFailure("worker_lost", "External connector terminal state is unknown", attempt.attemptId));
		}
	}

	async #resume(
		attempt: Attempt,
		options?: FoundationProviderExecutionOptions,
	): Promise<ResultValue<AttemptReceipt, FoundationError>> {
		if (options?.signal?.aborted === true) {
			return Result.err(externalFailure("scheduler_attempt_recovery_failed", "External connector resume was aborted before recovery", attempt.attemptId));
		}
		const durable = await this.#requireDurableAttempt(attempt);
		if (!durable.ok) return durable;
		const priorReceipt = await this.#requirePriorReceipt(attempt);
		if (!priorReceipt.ok) return priorReceipt;
		if (priorReceipt.value !== undefined) return Result.ok(priorReceipt.value);
		if (!this.#capability.resume) {
			return Result.err(externalFailure("unsupported_feature", "External connector does not support resume", attempt.attemptId));
		}
		const operation = await this.#store.readOperation(attempt.attemptId);
		if (operation === undefined || operation.status !== "running") {
			return Result.err(externalFailure("scheduler_attempt_recovery_failed", "External connector Attempt is not resumable", attempt.attemptId));
		}
		const binding = await this.#requireBinding(attempt);
		if (!binding.ok) return binding;
		const frozen = await this.#requireFrozenFacts(operation, attempt, binding.value);
		if (!frozen.ok) return frozen;
		const mapping = await this.#requireMapping(operation);
		if (!mapping.ok) return mapping;
		let supervisor: ExternalConnectorBoundedSupervisor | undefined;
		let handle: ExternalConnectorDriverHandle | undefined;
		try {
			supervisor = await this.#reattachSupervisor(operation, options?.signal);
			const connected = await supervisor.run(
				"start",
				(signal) => this.#driver.connect(mapping.value, { signal }),
				options?.signal,
			);
			const checkedHandle = this.#requireAuthoritativeDriverHandle(connected, supervisor, mapping.value);
			if (!checkedHandle.ok) {
				await this.#releaseSupervisor(attempt.attemptId, supervisor).catch(() => undefined);
				await this.#markReconcile(operation, "mapping_conflict");
				return Result.err(checkedHandle.error);
			}
			handle = checkedHandle.value;
			this.#driverHandles.set(attempt.attemptId, handle);
			const evidence = await this.#observeToReceipt(attempt.attemptId, supervisor, handle, options?.signal);
			await this.#releaseSupervisor(attempt.attemptId, supervisor);
			return await this.#settle(attempt, operation, mapping.value, evidence);
		} catch (error) {
			const cleanupUnknown = isAbortedSignal(options?.signal) && supervisor?.snapshot.cleaned !== true;
			if (supervisor?.snapshot.cleaned === true) {
				this.#supervisors.delete(attempt.attemptId);
				await this.#supervision.privateStateStore.delete(attempt.attemptId);
			}
			this.#driverHandles.delete(attempt.attemptId);
			this.#observationControllers.delete(attempt.attemptId);
			if (cleanupUnknown) {
				await this.#markReconcile(operation, "driver_failure");
				return Result.err(externalFailure("side_effect_unknown", "External connector process cleanup is unknown", attempt.attemptId));
			}
			if (handle !== undefined) {
				const failureEvidence = supervisedFailureEvidence(error, handle, this.#now, options?.signal);
				if (failureEvidence !== undefined) {
					return this.#settle(attempt, operation, mapping.value, failureEvidence);
				}
			}
			await this.#markReconcile(
				operation,
				error instanceof ExternalConnectorSupervisorError && error.code === "terminal_evidence_invalid"
					? "mapping_conflict"
					: "driver_failure",
			);
			return Result.err(externalFailure("worker_lost", "External connector resume state is unknown", attempt.attemptId));
		}
	}

	async #reconcile(
		attempt: Attempt,
		options?: FoundationProviderExecutionOptions,
	): Promise<ResultValue<AttemptReceipt, FoundationError>> {
		if (options?.signal?.aborted === true) {
			return Result.err(externalFailure("scheduler_attempt_recovery_failed", "External connector reconciliation was aborted before recovery", attempt.attemptId));
		}
		const durable = await this.#requireDurableAttempt(attempt);
		if (!durable.ok) return durable;
		const priorReceipt = await this.#requirePriorReceipt(attempt);
		if (!priorReceipt.ok) return priorReceipt;
		if (priorReceipt.value !== undefined) return Result.ok(priorReceipt.value);
		let operation = await this.#store.readOperation(attempt.attemptId);
		if (operation === undefined) {
			return Result.err(externalFailure("scheduler_attempt_recovery_failed", "External connector operation does not exist", attempt.attemptId));
		}
		if (operation.status === "terminal") {
			return Result.err(externalFailure("scheduler_attempt_recovery_failed", "External connector terminal operation has no canonical receipt", attempt.attemptId));
		}
		const binding = await this.#requireBinding(attempt);
		if (!binding.ok) return binding;
		const frozen = await this.#requireFrozenFacts(operation, attempt, binding.value);
		if (!frozen.ok) return frozen;
		const mapping = await this.#requireMapping(operation);
		if (!mapping.ok) return mapping;
		let supervisor: ExternalConnectorBoundedSupervisor;
		try {
			supervisor = await this.#reattachSupervisor(operation, options?.signal);
		} catch {
			await this.#markReconcile(operation, "driver_failure");
			return Result.err(externalFailure("side_effect_unknown", "External connector process identity requires reconciliation", attempt.attemptId));
		}
		let lookup: unknown;
		try {
			lookup = await supervisor.run(
				"receipt",
				(signal) => this.#driver.lookup(mapping.value, { signal }),
				options?.signal,
			);
		} catch {
			if (supervisor.snapshot.cleaned) {
				this.#supervisors.delete(attempt.attemptId);
				await this.#supervision.privateStateStore.delete(attempt.attemptId);
			}
			await this.#markReconcile(operation, "driver_failure");
			return Result.err(externalFailure("worker_lost", "External connector reconciliation lookup failed", attempt.attemptId));
		}
		if (!isExternalConnectorDriverLookup(lookup)) {
			await this.#releaseSupervisor(attempt.attemptId, supervisor).catch(() => undefined);
			await this.#markReconcile(operation, "mapping_conflict");
			return Result.err(externalFailure("invalid_correlation", "External connector lookup result is invalid", attempt.attemptId));
		}
		if (lookup.status === "missing" || lookup.status === "ambiguous") {
			await this.#releaseSupervisor(attempt.attemptId, supervisor).catch(() => undefined);
			await this.#markReconcile(
				operation,
				lookup.status === "missing" ? "driver_state_missing" : "driver_state_ambiguous",
			);
			return Result.err(externalFailure("side_effect_unknown", "External connector state requires operator reconciliation", attempt.attemptId));
		}
		if (lookup.status === "terminal") {
			if (operation.status === "start_intent") {
				operation = await this.#store.writeOperation(
					transitionExternalConnectorOperation(operation, "running", { now: this.#now() }),
				);
			}
			try {
				const evidence = await supervisor.run(
					"receipt",
					() => Promise.resolve(lookup.evidence),
					options?.signal,
					"terminal_evidence",
				);
				await this.#releaseSupervisor(attempt.attemptId, supervisor);
				return this.#settle(attempt, operation, mapping.value, evidence);
			} catch (error) {
				if (supervisor.snapshot.cleaned) {
					this.#supervisors.delete(attempt.attemptId);
					await this.#supervision.privateStateStore.delete(attempt.attemptId);
				}
				const failureEvidence = supervisedFailureEvidence(error, {
					externalSessionId: mapping.value.externalSessionId,
					...(mapping.value.externalTurnId === undefined
						? {}
						: { externalTurnId: mapping.value.externalTurnId }),
					supervisorRef: mapping.value.supervisor.ref,
					operationNonce: mapping.value.supervisor.nonce,
				}, this.#now, options?.signal);
				if (failureEvidence !== undefined) {
					return this.#settle(attempt, operation, mapping.value, failureEvidence);
				}
				await this.#markReconcile(operation, "driver_failure");
				return Result.err(externalFailure("side_effect_unknown", "External connector process cleanup is unknown", attempt.attemptId));
			}
		}
		if (operation.status === "start_intent") {
			operation = await this.#store.writeOperation(
				transitionExternalConnectorOperation(operation, "running", { now: this.#now() }),
			);
		}
		const checkedHandle = this.#requireAuthoritativeDriverHandle(lookup.handle, supervisor, mapping.value);
		if (!checkedHandle.ok) {
			await this.#releaseSupervisor(attempt.attemptId, supervisor).catch(() => undefined);
			await this.#markReconcile(operation, "mapping_conflict");
			return Result.err(checkedHandle.error);
		}
		const handle = checkedHandle.value;
		this.#driverHandles.set(attempt.attemptId, handle);
		try {
			const evidence = await this.#observeToReceipt(attempt.attemptId, supervisor, handle, options?.signal);
			await this.#releaseSupervisor(attempt.attemptId, supervisor);
			return await this.#settle(attempt, operation, mapping.value, evidence);
		} catch (error) {
			const cleanupUnknown = isAbortedSignal(options?.signal) && !supervisor.snapshot.cleaned;
			if (supervisor.snapshot.cleaned) {
				this.#supervisors.delete(attempt.attemptId);
				await this.#supervision.privateStateStore.delete(attempt.attemptId);
			}
			this.#driverHandles.delete(attempt.attemptId);
			this.#observationControllers.delete(attempt.attemptId);
			if (cleanupUnknown) {
				await this.#markReconcile(operation, "driver_failure");
				return Result.err(externalFailure("side_effect_unknown", "External connector process cleanup is unknown", attempt.attemptId));
			}
			const failureEvidence = supervisedFailureEvidence(error, handle, this.#now, options?.signal);
			if (failureEvidence !== undefined) {
				return this.#settle(attempt, operation, mapping.value, failureEvidence);
			}
			await this.#markReconcile(
				operation,
				error instanceof ExternalConnectorSupervisorError && error.code === "terminal_evidence_invalid"
					? "mapping_conflict"
					: "driver_failure",
			);
			return Result.err(externalFailure("worker_lost", "External connector reconciled execution did not settle", attempt.attemptId));
		}
	}

	async #cancel(attemptId: string): Promise<ResultValue<void, FoundationError>> {
		const attempt = await this.#store.readAttempt(attemptId);
		if (attempt === undefined) {
			this.#pendingCancellations.add(attemptId);
			return Result.ok(undefined);
		}
		if (attempt.providerId !== this.providerId) {
			return Result.err(externalFailure("invalid_correlation", "cancelAttempt requires this connector's durable Attempt", attemptId));
		}
		const priorReceipt = await this.#requirePriorReceipt(attempt);
		if (!priorReceipt.ok) return Result.err(priorReceipt.error);
		if (priorReceipt.value !== undefined) return Result.ok(undefined);
		this.#pendingCancellations.add(attemptId);
		let operation = await this.#store.readOperation(attemptId);
		if (operation === undefined || operation.status === "prepared") return Result.ok(undefined);
		if (operation.status === "terminal") {
			return Result.err(externalFailure("scheduler_attempt_recovery_failed", "External connector terminal operation has no canonical receipt", attemptId));
		}
		if (operation.status === "cancelling") {
			const reconciled = await this.#reconcile(attempt);
			return reconciled.ok ? Result.ok(undefined) : Result.err(reconciled.error);
		}
		const binding = await this.#requireBinding(attempt);
		if (!binding.ok) return Result.err(binding.error);
		const frozen = await this.#requireFrozenFacts(operation, attempt, binding.value);
		if (!frozen.ok) return Result.err(frozen.error);
		if (operation.status === "start_intent") {
			if (this.#active.has(attemptId)) return Result.ok(undefined);
			await this.#markReconcile(operation, "start_outcome_unknown");
			return Result.err(externalFailure("side_effect_unknown", "External connector start outcome must be reconciled before cancellation", attemptId));
		}
		if (operation.status === "reconcile_required") {
			return Result.err(externalFailure("side_effect_unknown", "External connector state must be reconciled before cancellation", attemptId));
		}
		const mapping = await this.#requireMapping(operation);
		if (!mapping.ok) return Result.err(mapping.error);
		if (operation.status === "running") {
			operation = await this.#store.writeOperation(
				transitionExternalConnectorOperation(operation, "cancelling", { now: this.#now() }),
			);
		}
		let supervisor: ExternalConnectorBoundedSupervisor | undefined;
		try {
			supervisor = await this.#reattachSupervisor(operation);
			const activeHandle = this.#driverHandles.get(attemptId);
			const connected = activeHandle ?? await supervisor.run(
				"start",
				(signal) => this.#driver.connect(mapping.value, { signal }),
			);
			const checkedHandle = this.#requireAuthoritativeDriverHandle(connected, supervisor, mapping.value);
			if (!checkedHandle.ok) {
				await this.#releaseSupervisor(attemptId, supervisor).catch(() => undefined);
				await this.#markReconcile(operation, "mapping_conflict");
				return Result.err(checkedHandle.error);
			}
			const handle = checkedHandle.value;
			const evidence = await supervisor.run(
				"cancel",
				(signal) => this.#driver.cancel(handle, { signal }),
				undefined,
				"optional_terminal_evidence",
			);
			if (evidence !== undefined) {
				const settled = await this.#settle(attempt, operation, mapping.value, evidence);
				if (!settled.ok) {
					const concurrentReceipt = await this.#requirePriorReceipt(attempt);
					if (!concurrentReceipt.ok || concurrentReceipt.value === undefined) return Result.err(settled.error);
				}
				this.#observationControllers.get(attemptId)?.abort();
				await this.#releaseSupervisor(attemptId, supervisor).catch(() => undefined);
				this.#pendingCancellations.delete(attemptId);
			}
			return Result.ok(undefined);
		} catch {
			if (supervisor?.snapshot.cleaned === true) {
				this.#supervisors.delete(attemptId);
				await this.#supervision.privateStateStore.delete(attemptId);
			}
			const concurrentReceipt = await this.#requirePriorReceipt(attempt);
			if (concurrentReceipt.ok && concurrentReceipt.value !== undefined) return Result.ok(undefined);
			await this.#markReconcile(operation, "driver_failure");
			return Result.err(externalFailure("worker_cancel_failed", "External connector cancellation outcome is unknown", attemptId));
		}
	}

	async #observeToReceipt(
		attemptId: string,
		supervisor: ExternalConnectorBoundedSupervisor,
		handle: ExternalConnectorDriverHandle,
		sourceSignal?: AbortSignal,
	): Promise<ExternalConnectorTerminalEvidence> {
		if (sourceSignal?.aborted === true) {
			await this.#releaseSupervisor(attemptId, supervisor);
			throw sourceSignal.reason;
		}
		const controller = new AbortController();
		this.#observationControllers.set(attemptId, controller);
		const abort = (): void => controller.abort(sourceSignal?.reason);
		sourceSignal?.addEventListener("abort", abort, { once: true });
		const events = supervisor.consumeEvents(
			(signal) => this.#driver.events(handle, { signal }),
			handle,
			controller.signal,
		);
		const receipt = supervisor.run(
			"receipt",
			(signal) => this.#driver.read(handle, { signal }),
			controller.signal,
			"terminal_evidence",
		);
		try {
			const [, evidence] = await Promise.all([events, receipt]);
			return evidence;
		} catch (error) {
			if (!controller.signal.aborted) controller.abort();
			await Promise.allSettled([events, receipt]);
			throw error;
		} finally {
			sourceSignal?.removeEventListener("abort", abort);
			if (this.#observationControllers.get(attemptId) === controller) {
				this.#observationControllers.delete(attemptId);
			}
		}
	}

	async #requirePriorReceipt(
		attempt: Attempt,
	): Promise<ResultValue<AttemptReceipt | undefined, FoundationError>> {
		const receipt = await this.#store.readReceipt(attempt.attemptId);
		if (receipt === undefined) return Result.ok(undefined);
		const checked = validateAttemptReceiptForProvider(receipt, {
			providerId: this.providerId,
			providerClass: this.providerClass,
		});
		const receiptId = `attempt_receipt_${attempt.attemptId}`;
		if (!checked.ok) {
			return Result.err(externalFailure("invalid_correlation", "External connector prior receipt is not canonical", attempt.attemptId));
		}
		const correlation = checked.value.provenance.correlation;
		if (
			checked.value.attemptReceiptId !== receiptId ||
			checked.value.providerId !== this.providerId ||
			checked.value.taskId !== attempt.taskId ||
			checked.value.dispatchId !== attempt.dispatchId ||
			checked.value.attemptId !== attempt.attemptId ||
			checked.value.bindingId !== attempt.bindingId ||
			checked.value.bindingEpochIds.length !== attempt.bindingEpochIds.length ||
			checked.value.bindingEpochIds.some((epochId, index) => epochId !== attempt.bindingEpochIds[index]) ||
			!isCanonicalExternalConnectorMappingTimestamp(checked.value.provenance.producedAt) ||
			correlation === undefined ||
			correlation.taskId !== attempt.taskId ||
			correlation.dispatchId !== attempt.dispatchId ||
			correlation.attemptId !== attempt.attemptId ||
			correlation.attemptReceiptId !== receiptId ||
			correlation.bindingId !== attempt.bindingId ||
			correlation.bindingEpochId !== attempt.bindingEpochIds[0] ||
			correlation.providerId !== this.providerId ||
			correlation.agentInstanceId !== undefined
		) {
			return Result.err(externalFailure("invalid_correlation", "External connector prior receipt does not match its Attempt", attempt.attemptId));
		}
		const operation = await this.#store.readOperation(attempt.attemptId);
		if (operation !== undefined) {
			if (
				operation.providerId !== this.providerId ||
				operation.attemptId !== attempt.attemptId ||
				operation.bindingId !== attempt.bindingId ||
				operation.bindingEpochId !== attempt.bindingEpochIds[0] ||
				operation.correlation.taskId !== attempt.taskId ||
				operation.correlation.dispatchId !== attempt.dispatchId ||
				operation.correlation.attemptId !== attempt.attemptId ||
				operation.correlation.bindingId !== attempt.bindingId ||
				operation.correlation.bindingEpochId !== attempt.bindingEpochIds[0] ||
				operation.correlation.providerId !== this.providerId ||
				operation.correlation.agentInstanceId !== undefined
			) {
				return Result.err(externalFailure("invalid_correlation", "External connector operation does not match its canonical receipt", attempt.attemptId));
			}
			if (operation.status === "terminal") {
				if (operation.receiptId !== receiptId) {
					return Result.err(externalFailure("invalid_correlation", "External connector terminal operation references a different receipt", attempt.attemptId));
				}
			} else {
				await this.#store.writeOperation(
					transitionExternalConnectorOperation(operation, "terminal", {
						now: this.#now(),
						receiptId,
					}),
				);
			}
		}
		return Result.ok(checked.value);
	}

	async #requireDurableAttempt(attempt: Attempt): Promise<ResultValue<Attempt, FoundationError>> {
		const durable = await this.#store.readAttempt(attempt.attemptId);
		if (
			durable === undefined ||
			durable.providerId !== this.providerId ||
			canonicalFoundationJson(durable) !== canonicalFoundationJson(attempt)
		) {
			return Result.err(externalFailure("invalid_correlation", "External connector requires the exact durable Attempt", attempt.attemptId));
		}
		return Result.ok(durable);
	}

	async #requireBinding(attempt: Attempt): Promise<ResultValue<AgentBinding, FoundationError>> {
		const binding = await this.#store.readBinding(attempt.bindingId);
		if (binding === undefined || binding.taskId !== attempt.taskId) {
			return Result.err(externalFailure("binding_required_fact", "External connector requires the durable AgentBinding", attempt.attemptId));
		}
		const checked = validateImmutableAgentBinding(binding);
		return checked.ok ? Result.ok(checked.value) : Result.err(checked.error);
	}

	#requireCorrelation(
		attempt: Attempt,
		correlation: ExecutionCorrelation | undefined,
	): ResultValue<ExecutionCorrelation, FoundationError> {
		const bindingEpochId = attempt.bindingEpochIds[0];
		const checked = correlation === undefined ? undefined : validateExecutionCorrelation(correlation);
		if (
			checked === undefined ||
			!checked.ok ||
			bindingEpochId === undefined ||
			checked.value.agentInstanceId !== undefined ||
			(checked.value.taskId !== undefined && checked.value.taskId !== attempt.taskId) ||
			(checked.value.dispatchId !== undefined && checked.value.dispatchId !== attempt.dispatchId) ||
			(checked.value.attemptId !== undefined && checked.value.attemptId !== attempt.attemptId) ||
			(checked.value.bindingId !== undefined && checked.value.bindingId !== attempt.bindingId) ||
			(checked.value.bindingEpochId !== undefined && checked.value.bindingEpochId !== bindingEpochId) ||
			(checked.value.providerId !== undefined && checked.value.providerId !== this.providerId)
		) {
			return Result.err(externalFailure("invalid_correlation", "External connector execution correlation is invalid", attempt.attemptId));
		}
		const canonical = {
			...checked.value,
			taskId: attempt.taskId,
			dispatchId: attempt.dispatchId,
			attemptId: attempt.attemptId,
			bindingId: attempt.bindingId,
			bindingEpochId,
			providerId: this.providerId,
		};
		const canonicalChecked = validateExecutionCorrelation(canonical);
		return canonicalChecked.ok
			? Result.ok(canonicalChecked.value)
			: Result.err(externalFailure("invalid_correlation", "External connector execution correlation is invalid", attempt.attemptId));
	}

	async #requireFrozenFacts(
		operation: ExternalConnectorOperation,
		attempt: Attempt,
		binding: AgentBinding,
	): Promise<ResultValue<void, FoundationError>> {
		let canonicalOperation: ExternalConnectorOperation;
		try {
			canonicalOperation = cloneExternalConnectorOperation(operation);
		} catch {
			return Result.err(externalFailure("invalid_correlation", "External connector durable operation is invalid", attempt.attemptId));
		}
		if (
			canonicalOperation.providerId !== this.providerId ||
			canonicalOperation.attemptId !== attempt.attemptId ||
			canonicalOperation.bindingId !== attempt.bindingId ||
			canonicalOperation.bindingEpochId !== attempt.bindingEpochIds[0] ||
			canonicalOperation.bindingId !== binding.bindingId ||
			canonicalOperation.bindingRevision !== binding.contextRevision.revision ||
			!sameFingerprint(canonicalOperation.bindingDigest, binding.fingerprint) ||
			canonicalOperation.correlation.taskId !== attempt.taskId ||
			canonicalOperation.correlation.dispatchId !== attempt.dispatchId ||
			canonicalOperation.correlation.attemptId !== attempt.attemptId ||
			canonicalOperation.correlation.bindingId !== attempt.bindingId ||
			canonicalOperation.correlation.bindingEpochId !== attempt.bindingEpochIds[0] ||
			canonicalOperation.correlation.providerId !== this.providerId ||
			canonicalOperation.correlation.agentInstanceId !== undefined
		) {
			await this.#markReconcile(canonicalOperation, "binding_drift");
			return Result.err(externalFailure("binding_required_fact", "External connector binding drift requires reconciliation", canonicalOperation.attemptId));
		}
		if (
			canonicalOperation.capabilityRevision !== this.#capability.revision ||
			!sameFingerprint(canonicalOperation.capabilityDigest, this.#capability.digest)
		) {
			await this.#markReconcile(canonicalOperation, "capability_drift");
			return Result.err(externalFailure("scheduler_attempt_recovery_failed", "External connector capability drift requires reconciliation", canonicalOperation.attemptId));
		}
		return Result.ok(undefined);
	}

	async #requireMapping(
		operation: ExternalConnectorOperation,
	): Promise<ResultValue<CanonicalExternalConnectorMapping, FoundationError>> {
		const mapping = await this.#store.readMapping(operation.attemptId);
		if (mapping === undefined) {
			await this.#markReconcile(operation, "mapping_missing");
			await this.#recoverSupervisorWithoutMapping(operation);
			return Result.err(externalFailure("side_effect_unknown", "External connector durable mapping is missing", operation.attemptId));
		}
		if (
			mapping.providerId !== operation.providerId ||
			mapping.attemptId !== operation.attemptId ||
			mapping.binding.revision !== operation.bindingRevision ||
			!sameFingerprint(mapping.binding.digest, operation.bindingDigest) ||
			mapping.capability.revision !== operation.capabilityRevision ||
			!sameFingerprint(mapping.capability.digest, operation.capabilityDigest) ||
			mapping.supervisor.nonce !== operation.operationNonce
		) {
			await this.#markReconcile(operation, "mapping_conflict");
			return Result.err(externalFailure("side_effect_unknown", "External connector durable mapping conflicts with its Attempt", operation.attemptId));
		}
		return Result.ok(mapping);
	}

	async #markReconcile(operation: ExternalConnectorOperation, reason: ExternalConnectorReconcileReason): Promise<void> {
		if (operation.status === "terminal" || operation.status === "reconcile_required" && operation.reconcileReason === reason) return;
		await this.#store.writeOperation(
			transitionExternalConnectorOperation(operation, "reconcile_required", {
				now: this.#now(),
				reconcileReason: reason,
			}),
		);
	}

	async #settle(
		attempt: Attempt,
		operation: ExternalConnectorOperation,
		mapping: CanonicalExternalConnectorMapping,
		evidence: ExternalConnectorTerminalEvidence,
	): Promise<ResultValue<AttemptReceipt, FoundationError>> {
		const priorReceipt = await this.#requirePriorReceipt(attempt);
		if (!priorReceipt.ok) return priorReceipt;
		if (priorReceipt.value !== undefined) return Result.ok(priorReceipt.value);
		if (operation.status === "terminal") {
			return Result.err(externalFailure("scheduler_attempt_recovery_failed", "External connector operation is already terminal", attempt.attemptId));
		}
		let canonicalEvidence: ExternalConnectorTerminalEvidence;
		try {
			canonicalEvidence = cloneExternalConnectorTerminalEvidence(evidence);
		} catch {
			await this.#markReconcile(operation, "mapping_conflict");
			return Result.err(externalFailure("side_effect_unknown", "External connector terminal evidence is invalid", attempt.attemptId));
		}
		if (
			canonicalEvidence.externalSessionId !== mapping.externalSessionId ||
			(canonicalEvidence.externalTurnId ?? undefined) !== (mapping.externalTurnId ?? undefined) ||
			canonicalEvidence.operationNonce !== operation.operationNonce ||
			canonicalEvidence.operationNonce !== mapping.supervisor.nonce
		) {
			await this.#markReconcile(operation, "mapping_conflict");
			return Result.err(externalFailure("side_effect_unknown", "External connector terminal evidence conflicts with its durable mapping", attempt.attemptId));
		}
		const receiptId = `attempt_receipt_${attempt.attemptId}`;
		const receipt: AttemptReceipt = {
			schemaVersion: 1,
			attemptReceiptId: receiptId,
			taskId: attempt.taskId,
			dispatchId: attempt.dispatchId,
			attemptId: attempt.attemptId,
			providerId: this.providerId,
			bindingId: attempt.bindingId,
			bindingEpochIds: [...attempt.bindingEpochIds],
			status: canonicalEvidence.status,
			workerReceiptRefs: [],
			artifacts: [...(canonicalEvidence.artifacts ?? [])],
			...(canonicalEvidence.error === undefined ? {} : { error: canonicalEvidence.error }),
			provenance: {
				producerKind: "external_connector",
				providerId: this.providerId,
				producedAt: canonicalEvidence.producedAt,
				correlation: { ...operation.correlation, attemptReceiptId: receiptId },
			},
			sideEffectState: canonicalEvidence.sideEffectState,
		};
		const checked = validateAttemptReceiptForProvider(receipt, {
			providerId: this.providerId,
			providerClass: this.providerClass,
		});
		if (!checked.ok) return checked;
		const persisted = await this.#store.writeReceipt(checked.value);
		await this.#store.writeOperation(
			transitionExternalConnectorOperation(operation, "terminal", {
				now: this.#now(),
				receiptId: persisted.attemptReceiptId,
			}),
		);
		this.#pendingCancellations.delete(attempt.attemptId);
		return Result.ok(persisted);
	}

	async #settleCancelledBeforeLaunch(
		attempt: Attempt,
		correlation: ExecutionCorrelation,
		operation?: ExternalConnectorOperation,
		sourceSignal?: AbortSignal,
	): Promise<ResultValue<AttemptReceipt, FoundationError>> {
		const deadline = isDeadlineAbort(sourceSignal);
		const receiptId = `attempt_receipt_${attempt.attemptId}`;
		const checked = validateAttemptReceiptForProvider({
			schemaVersion: 1,
			attemptReceiptId: receiptId,
			taskId: attempt.taskId,
			dispatchId: attempt.dispatchId,
			attemptId: attempt.attemptId,
			providerId: this.providerId,
			bindingId: attempt.bindingId,
			bindingEpochIds: [...attempt.bindingEpochIds],
			status: deadline ? "failed" : "cancelled",
			workerReceiptRefs: [],
			artifacts: [],
			...(deadline ? {
				error: {
					code: "run_deadline_exceeded",
					message: "External connector run deadline was exceeded.",
					category: "deadline" as const,
					retryable: false,
				},
			} : {}),
			provenance: {
				producerKind: "external_connector",
				providerId: this.providerId,
				producedAt: this.#now(),
				correlation: { ...correlation, attemptReceiptId: receiptId },
			},
			sideEffectState: "none",
		}, {
			providerId: this.providerId,
			providerClass: this.providerClass,
		});
		if (!checked.ok) return checked;
		const persisted = await this.#store.writeReceipt(checked.value);
		if (operation !== undefined && operation.status !== "terminal") {
			await this.#store.writeOperation(
				transitionExternalConnectorOperation(operation, "terminal", {
					now: this.#now(),
					receiptId: persisted.attemptReceiptId,
				}),
			);
		}
		this.#pendingCancellations.delete(attempt.attemptId);
		return Result.ok(persisted);
	}

	async #settleFailedWithoutMapping(
		attempt: Attempt,
		correlation: ExecutionCorrelation,
		operation: ExternalConnectorOperation,
		sourceSignal?: AbortSignal,
	): Promise<ResultValue<AttemptReceipt, FoundationError>> {
		const deadline = isDeadlineAbort(sourceSignal);
		const receiptId = `attempt_receipt_${attempt.attemptId}`;
		const checked = validateAttemptReceiptForProvider({
			schemaVersion: 1,
			attemptReceiptId: receiptId,
			taskId: attempt.taskId,
			dispatchId: attempt.dispatchId,
			attemptId: attempt.attemptId,
			providerId: this.providerId,
			bindingId: attempt.bindingId,
			bindingEpochIds: [...attempt.bindingEpochIds],
			status: "failed",
			workerReceiptRefs: [],
			artifacts: [],
			error: {
				code: deadline ? "run_deadline_exceeded" : "side_effect_unknown",
				message: deadline
					? "External connector run deadline was exceeded."
					: "External connector start outcome could not be proven.",
				category: deadline ? "deadline" as const : "side_effect_unknown" as const,
				retryable: false,
			},
			provenance: {
				producerKind: "external_connector",
				providerId: this.providerId,
				producedAt: this.#now(),
				correlation: { ...correlation, attemptReceiptId: receiptId },
			},
			sideEffectState: "unknown",
		}, {
			providerId: this.providerId,
			providerClass: this.providerClass,
		});
		if (!checked.ok) return checked;
		const persisted = await this.#store.writeReceipt(checked.value);
		await this.#store.writeOperation(
			transitionExternalConnectorOperation(operation, "terminal", {
				now: this.#now(),
				receiptId: persisted.attemptReceiptId,
			}),
		);
		return Result.ok(persisted);
	}
}

const DURABLE_EXTERNAL_AGENT_CONNECTOR_METHODS = Object.freeze({
	preflightModelProjection: DurableExternalAgentConnector.prototype.preflightModelProjection,
	capabilities: DurableExternalAgentConnector.prototype.capabilities,
	dispose: DurableExternalAgentConnector.prototype.dispose,
	probeCapabilities: DurableExternalAgentConnector.prototype.probeCapabilities,
	createAttempt: DurableExternalAgentConnector.prototype.createAttempt,
	runAttempt: DurableExternalAgentConnector.prototype.runAttempt,
	cancelAttempt: DurableExternalAgentConnector.prototype.cancelAttempt,
	resumeAttempt: DurableExternalAgentConnector.prototype.resumeAttempt,
	reconcileAttempt: DurableExternalAgentConnector.prototype.reconcileAttempt,
});

export function createDurableExternalAgentConnector(
	options: ExternalAgentConnectorRuntimeOptions,
): DurableExternalAgentConnector {
	const connector = new DurableExternalAgentConnector(options);
	HOST_SUPERVISED_EXTERNAL_CONNECTORS.set(
		connector,
		captureHostSupervisedExternalAgentConnector(connector, DURABLE_EXTERNAL_AGENT_CONNECTOR_METHODS),
	);
	return connector;
}
