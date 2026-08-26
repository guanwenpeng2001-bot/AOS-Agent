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
	transitionExternalConnectorOperation,
	type ExternalConnectorDurableStore,
	type ExternalConnectorOperation,
	type ExternalConnectorReconcileReason,
} from "./external-agent-operation.ts";
import {
	cloneCanonicalExternalConnectorMapping,
	type CanonicalExternalConnectorMapping,
} from "./external-session-mapping.ts";
import type {
	ExternalConnectorDriverHandle,
	ExternalConnectorTerminalEvidence,
	ExternalConnectorVendorDriver,
} from "./vendor-drivers/types.ts";

export interface ExternalAgentConnectorRuntimeOptions {
	readonly providerId: string;
	readonly capability: ConnectorCapabilitySnapshot;
	readonly store: ExternalConnectorDurableStore;
	readonly driver: ExternalConnectorVendorDriver;
	readonly now?: () => string;
	readonly operationNonce?: () => string;
	readonly disposeTimeoutMs?: number;
}

const EXTERNAL_CONNECTOR_CAPABILITIES: readonly FoundationProviderCapability[] = Object.freeze([
	Object.freeze({ schemaVersion: 1, id: "external_connector.lifecycle", version: 1 }),
]);

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
	readonly #now: () => string;
	readonly #operationNonce: () => string;
	readonly #disposeTimeoutMs: number;
	readonly #active = new Map<string, Promise<ResultValue<AttemptReceipt, FoundationError>>>();
	readonly #cancelling = new Map<string, Promise<ResultValue<void, FoundationError>>>();

	constructor(options: ExternalAgentConnectorRuntimeOptions) {
		const checked = validateConnectorCapabilitySnapshotForProvider(options.capability, {
			providerId: options.providerId,
			providerClass: "external_connector",
		});
		if (!checked.ok) throw checked.error;
		if (!Number.isFinite(options.disposeTimeoutMs ?? 1_000) || (options.disposeTimeoutMs ?? 1_000) < 0) {
			throw externalFailure("invalid_correlation", "External connector dispose timeout is invalid");
		}
		this.providerId = options.providerId;
		this.#capability = checked.value;
		this.#store = options.store;
		this.#driver = options.driver;
		this.#now = options.now ?? (() => new Date().toISOString());
		this.#operationNonce = options.operationNonce ?? randomUUID;
		this.#disposeTimeoutMs = options.disposeTimeoutMs ?? 1_000;
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
		await new Promise<void>((resolve) => {
			let settled = false;
			const finish = (): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				resolve();
			};
			const timer = setTimeout(finish, this.#disposeTimeoutMs);
			void this.#driver.dispose().then(finish, finish);
		});
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
					: externalFailure("worker_cancel_failed", "External connector cancellation failed"),
			);
		}
	}

	async #run(
		attempt: Attempt,
		options?: FoundationProviderExecutionOptions,
	): Promise<ResultValue<AttemptReceipt, FoundationError>> {
		const durable = await this.#requireDurableAttempt(attempt);
		if (!durable.ok) return durable;
		const priorReceipt = await this.#store.readReceipt(attempt.attemptId);
		if (priorReceipt !== undefined) return Result.ok(priorReceipt);
		if (attempt.status !== "starting") {
			return Result.err(externalFailure("scheduler_attempt_recovery_failed", "runAttempt requires a not-started durable Attempt", attempt.attemptId));
		}
		const binding = await this.#requireBinding(attempt);
		if (!binding.ok) return binding;
		const correlation = this.#requireCorrelation(attempt, options?.correlation);
		if (!correlation.ok) return correlation;

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
		const frozen = await this.#requireFrozenFacts(operation, binding.value);
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
		let handle: ExternalConnectorDriverHandle;
		try {
			handle = await this.#driver.spawn({
				attempt,
				capability: this.#capability,
				bindingDigest: binding.value.fingerprint.value,
				bindingRevision: binding.value.contextRevision.revision,
				operationNonce: operation.operationNonce,
				...(options?.signal === undefined ? {} : { signal: options.signal }),
			});
		} catch {
			await this.#markReconcile(operation, "start_outcome_unknown");
			return Result.err(externalFailure("provider_spawn_failed", "External connector start outcome is unknown", attempt.attemptId));
		}

		let mapping: CanonicalExternalConnectorMapping;
		try {
			if (handle.operationNonce !== operation.operationNonce) {
				throw externalFailure("invalid_correlation", "External connector driver returned a different operation nonce", attempt.attemptId);
			}
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
			await this.#markReconcile(operation, "mapping_persistence_unknown");
			return Result.err(externalFailure("side_effect_unknown", "External connector mapping could not be proven durable", attempt.attemptId));
		}
		operation = await this.#store.writeOperation(
			transitionExternalConnectorOperation(operation, "running", { now: this.#now() }),
		);
		try {
			const evidence = await this.#driver.read(handle, options?.signal === undefined ? undefined : { signal: options.signal });
			return await this.#settle(attempt, operation, evidence);
		} catch {
			await this.#markReconcile(operation, "driver_failure");
			return Result.err(externalFailure("worker_lost", "External connector terminal state is unknown", attempt.attemptId));
		}
	}

	async #resume(
		attempt: Attempt,
		options?: FoundationProviderExecutionOptions,
	): Promise<ResultValue<AttemptReceipt, FoundationError>> {
		const durable = await this.#requireDurableAttempt(attempt);
		if (!durable.ok) return durable;
		const priorReceipt = await this.#store.readReceipt(attempt.attemptId);
		if (priorReceipt !== undefined) return Result.ok(priorReceipt);
		if (!this.#capability.resume) {
			return Result.err(externalFailure("unsupported_feature", "External connector does not support resume", attempt.attemptId));
		}
		const operation = await this.#store.readOperation(attempt.attemptId);
		if (operation === undefined || operation.status !== "running") {
			return Result.err(externalFailure("scheduler_attempt_recovery_failed", "External connector Attempt is not resumable", attempt.attemptId));
		}
		const binding = await this.#requireBinding(attempt);
		if (!binding.ok) return binding;
		const frozen = await this.#requireFrozenFacts(operation, binding.value);
		if (!frozen.ok) return frozen;
		const mapping = await this.#requireMapping(operation);
		if (!mapping.ok) return mapping;
		try {
			const handle = await this.#driver.connect(
				mapping.value,
				options?.signal === undefined ? undefined : { signal: options.signal },
			);
			const evidence = await this.#driver.read(handle, options?.signal === undefined ? undefined : { signal: options.signal });
			return await this.#settle(attempt, operation, evidence);
		} catch {
			await this.#markReconcile(operation, "driver_failure");
			return Result.err(externalFailure("worker_lost", "External connector resume state is unknown", attempt.attemptId));
		}
	}

	async #reconcile(
		attempt: Attempt,
		options?: FoundationProviderExecutionOptions,
	): Promise<ResultValue<AttemptReceipt, FoundationError>> {
		const durable = await this.#requireDurableAttempt(attempt);
		if (!durable.ok) return durable;
		const priorReceipt = await this.#store.readReceipt(attempt.attemptId);
		if (priorReceipt !== undefined) return Result.ok(priorReceipt);
		let operation = await this.#store.readOperation(attempt.attemptId);
		if (operation === undefined) {
			return Result.err(externalFailure("scheduler_attempt_recovery_failed", "External connector operation does not exist", attempt.attemptId));
		}
		const binding = await this.#requireBinding(attempt);
		if (!binding.ok) return binding;
		const frozen = await this.#requireFrozenFacts(operation, binding.value);
		if (!frozen.ok) return frozen;
		const mapping = await this.#requireMapping(operation);
		if (!mapping.ok) return mapping;
		let lookup: Awaited<ReturnType<ExternalConnectorVendorDriver["lookup"]>>;
		try {
			lookup = await this.#driver.lookup(
				mapping.value,
				options?.signal === undefined ? undefined : { signal: options.signal },
			);
		} catch {
			await this.#markReconcile(operation, "driver_failure");
			return Result.err(externalFailure("worker_lost", "External connector reconciliation lookup failed", attempt.attemptId));
		}
		if (lookup.status === "missing" || lookup.status === "ambiguous") {
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
			return this.#settle(attempt, operation, lookup.evidence);
		}
		if (operation.status === "start_intent") {
			operation = await this.#store.writeOperation(
				transitionExternalConnectorOperation(operation, "running", { now: this.#now() }),
			);
		}
		try {
			const evidence = await this.#driver.read(
				lookup.handle,
				options?.signal === undefined ? undefined : { signal: options.signal },
			);
			return await this.#settle(attempt, operation, evidence);
		} catch {
			await this.#markReconcile(operation, "driver_failure");
			return Result.err(externalFailure("worker_lost", "External connector reconciled execution did not settle", attempt.attemptId));
		}
	}

	async #cancel(attemptId: string): Promise<ResultValue<void, FoundationError>> {
		const attempt = await this.#store.readAttempt(attemptId);
		if (attempt === undefined || attempt.providerId !== this.providerId) {
			return Result.err(externalFailure("invalid_correlation", "cancelAttempt requires an existing durable Attempt", attemptId));
		}
		if ((await this.#store.readReceipt(attemptId)) !== undefined) return Result.ok(undefined);
		let operation = await this.#store.readOperation(attemptId);
		if (operation === undefined || operation.status === "prepared") return Result.ok(undefined);
		if (operation.status === "terminal" || operation.status === "cancelling") return Result.ok(undefined);
		if (operation.status === "start_intent") {
			await this.#markReconcile(operation, "start_outcome_unknown");
			return Result.err(externalFailure("side_effect_unknown", "External connector start outcome must be reconciled before cancellation", attemptId));
		}
		if (operation.status === "reconcile_required") {
			return Result.err(externalFailure("side_effect_unknown", "External connector state must be reconciled before cancellation", attemptId));
		}
		const mapping = await this.#store.readMapping(attemptId);
		if (mapping === undefined) {
			await this.#markReconcile(operation, "mapping_missing");
			return Result.err(externalFailure("side_effect_unknown", "External connector cancellation has no durable mapping", attemptId));
		}
		if (operation.status === "running") {
			operation = await this.#store.writeOperation(
				transitionExternalConnectorOperation(operation, "cancelling", { now: this.#now() }),
			);
		}
		try {
			const handle = await this.#driver.connect(mapping);
			const evidence = await this.#driver.cancel(handle);
			if (evidence !== undefined) {
				const settled = await this.#settle(attempt, operation, evidence);
				if (!settled.ok) return Result.err(settled.error);
			}
			return Result.ok(undefined);
		} catch {
			await this.#markReconcile(operation, "driver_failure");
			return Result.err(externalFailure("worker_cancel_failed", "External connector cancellation outcome is unknown", attemptId));
		}
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
		if (
			correlation === undefined ||
			bindingEpochId === undefined ||
			correlation.sessionId.length === 0 ||
			correlation.laneId.length === 0 ||
			!Number.isSafeInteger(correlation.revision) ||
			correlation.revision < 0 ||
			(correlation.taskId !== undefined && correlation.taskId !== attempt.taskId) ||
			(correlation.dispatchId !== undefined && correlation.dispatchId !== attempt.dispatchId) ||
			(correlation.attemptId !== undefined && correlation.attemptId !== attempt.attemptId) ||
			(correlation.bindingId !== undefined && correlation.bindingId !== attempt.bindingId) ||
			(correlation.bindingEpochId !== undefined && correlation.bindingEpochId !== bindingEpochId) ||
			(correlation.providerId !== undefined && correlation.providerId !== this.providerId)
		) {
			return Result.err(externalFailure("invalid_correlation", "External connector execution correlation is invalid", attempt.attemptId));
		}
		return Result.ok({
			...correlation,
			taskId: attempt.taskId,
			dispatchId: attempt.dispatchId,
			attemptId: attempt.attemptId,
			bindingId: attempt.bindingId,
			bindingEpochId,
			providerId: this.providerId,
		});
	}

	async #requireFrozenFacts(
		operation: ExternalConnectorOperation,
		binding: AgentBinding,
	): Promise<ResultValue<void, FoundationError>> {
		if (
			operation.providerId !== this.providerId ||
			operation.bindingId !== binding.bindingId ||
			operation.bindingRevision !== binding.contextRevision.revision ||
			!sameFingerprint(operation.bindingDigest, binding.fingerprint)
		) {
			await this.#markReconcile(operation, "binding_drift");
			return Result.err(externalFailure("binding_required_fact", "External connector binding drift requires reconciliation", operation.attemptId));
		}
		if (
			operation.capabilityRevision !== this.#capability.revision ||
			!sameFingerprint(operation.capabilityDigest, this.#capability.digest)
		) {
			await this.#markReconcile(operation, "capability_drift");
			return Result.err(externalFailure("scheduler_attempt_recovery_failed", "External connector capability drift requires reconciliation", operation.attemptId));
		}
		return Result.ok(undefined);
	}

	async #requireMapping(
		operation: ExternalConnectorOperation,
	): Promise<ResultValue<CanonicalExternalConnectorMapping, FoundationError>> {
		const mapping = await this.#store.readMapping(operation.attemptId);
		if (mapping === undefined) {
			await this.#markReconcile(operation, "mapping_missing");
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
		if (operation.status === "terminal" || operation.status === "reconcile_required") return;
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
		evidence: ExternalConnectorTerminalEvidence,
	): Promise<ResultValue<AttemptReceipt, FoundationError>> {
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
			status: evidence.status,
			workerReceiptRefs: [],
			artifacts: [...(evidence.artifacts ?? [])],
			...(evidence.error === undefined ? {} : { error: evidence.error }),
			provenance: {
				producerKind: "external_connector",
				providerId: this.providerId,
				producedAt: evidence.producedAt,
				correlation: { ...operation.correlation, attemptReceiptId: receiptId },
			},
			sideEffectState: evidence.sideEffectState,
		};
		const checked = validateAttemptReceiptForProvider(receipt, {
			providerId: this.providerId,
			providerClass: this.providerClass,
		});
		if (!checked.ok) return checked;
		const persisted = await this.#store.writeReceipt(checked.value);
		if (operation.status !== "terminal") {
			await this.#store.writeOperation(
				transitionExternalConnectorOperation(operation, "terminal", {
					now: this.#now(),
					receiptId: persisted.attemptReceiptId,
				}),
			);
		}
		return Result.ok(persisted);
	}
}

export function createDurableExternalAgentConnector(
	options: ExternalAgentConnectorRuntimeOptions,
): ExternalAgentConnector {
	return new DurableExternalAgentConnector(options);
}
