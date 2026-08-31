/** Foundation ExternalAgentConnector runtime with a durable start boundary. */

import { randomUUID } from "node:crypto";
import {
	canonicalFoundationJson,
	cloneDeepFrozen,
	createAttempt as createFoundationAttempt,
	EXTERNAL_ERROR_MESSAGES,
	fingerprintFoundationValue,
	FoundationError,
	isToolGatewayRoute,
	Result,
	validateAttemptReceiptForProvider,
	validateConnectorCapabilitySnapshotForProvider,
	validateExecutionCorrelation,
	validateImmutableAgentBinding,
	validateMcpSelection,
	type AgentBinding,
	type Attempt,
	type AttemptReceipt,
	type ConnectorCapabilitySnapshot,
	type Dispatch,
	type ExecutionCorrelation,
	type ExternalAgentConnector,
	type Fingerprint,
	type FoundationProviderCapability,
	type FoundationProviderExecutionOptions,
	type ResultValue,
	type TaskExecutorAttemptContext,
	type ToolExecutionResult,
	type ToolGatewayRequest,
	type ToolGatewayRoute,
} from "@aos-agent/agent-core";
import { PROVIDER_CLASS } from "./provider-class.ts";
import {
	EXTERNAL_CONNECTOR_TOOL_GATEWAY_EXECUTION_OBJECT_TYPE,
	attachExternalConnectorCredentialLease,
	cloneExternalConnectorCredentialLease,
	cloneExternalConnectorCredentialRequirement,
	cloneExternalConnectorOperation,
	externalConnectorToolGatewayExchangeId,
	externalConnectorToolGatewayRequestMatchesExecution,
	transitionExternalConnectorOperation,
	type ExternalConnectorDurableStore,
	type ExternalConnectorCredentialLease,
	type ExternalConnectorCredentialRequirement,
	type ExternalConnectorOperation,
	type ExternalConnectorReconcileReason,
	type ExternalConnectorToolGatewayIntent,
	type ExternalConnectorToolGatewayTerminal,
} from "./operation.ts";
import {
	cloneCanonicalExternalConnectorMapping,
	isCanonicalExternalConnectorMappingTimestamp,
	isExternalConnectorMappingIdentifier,
	type CanonicalExternalConnectorMapping,
} from "./session-mapping.ts";
import type {
	ExternalConnectorDriverEvent,
	ExternalConnectorDriverHandle,
	ExternalConnectorVendorDriver,
} from "./vendor/types.ts";
import {
	calculateScopeDigest,
	isTaskCredentialIdentifier,
	normalizeTaskCredentialScopes,
	type TaskCredentialScope,
} from "../policy/task-credential-lease.ts";
import type {
	TaskCredentialDeliveredLeaseLookupResult,
	TaskCredentialDeliveredLeaseReference,
	TaskCredentialDeliveredLeaseReleaseInput,
	TaskCredentialLifecycleReasonCode,
	TaskCredentialRunIssueContext,
	TaskCredentialServiceMutationResult,
	TaskCredentialServiceIssueResult,
	TaskCredentialWorkerTarget,
} from "../policy/task-credential-service.ts";
import {
	validateOperationWorkerLeaseProjection,
	validateOperationWorkerLeaseReference,
	type SafeLeaseProjection,
	type SafeLeaseReference,
} from "../worker/protocol.ts";

export interface ExternalConnectorCredentialService {
	issueForTaskRun(context: TaskCredentialRunIssueContext): TaskCredentialServiceIssueResult;
	lookupDeliveredLease(input: TaskCredentialDeliveredLeaseReference): TaskCredentialDeliveredLeaseLookupResult;
	releaseDeliveredLease(input: TaskCredentialDeliveredLeaseReleaseInput): TaskCredentialServiceMutationResult;
}

export interface ExternalConnectorCredentialRuntime {
	/** Host-owned lifecycle authority; Connector code never receives material. */
	readonly service: ExternalConnectorCredentialService;
	/** Pure exact target/binding selection for this already durable Attempt. */
	readonly resolveIssueContext: (
		attempt: Attempt,
		binding: AgentBinding,
	) => TaskCredentialRunIssueContext | undefined;
}
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
} from "./supervisor.ts";
import type { RuntimeClock } from "../runtime/clock.ts";
import {
	decodeRuntimeLimitsOperationNonce,
	encodeRuntimeLimitsOperationNonce,
	resolveRuntimeLimitsSource,
	runtimeLimitsFromSupervisorOptions,
	runtimeLimitsShutdownDeadline,
	runtimeLimitsSupervisorDeadlines,
	runtimeLimitsSupervisorLimits,
	type RuntimeLimitsOperationNonce,
	type RuntimeLimitsSnapshot,
	type RuntimeLimitsSource,
} from "../runtime/limits.ts";
import {
	translateExternalModelProjection,
	type ExternalModelTranslationResult,
	type ExternalResolvedModelProjection,
} from "./model-projection.ts";
import {
	cloneExternalConnectorTerminalEvidence,
	isExternalConnectorDriverHandle,
	isExternalConnectorDriverLookup,
	type ExternalConnectorTerminalEvidence,
} from "./vendor/types.ts";

export interface ExternalAgentConnectorRuntimeOptions {
	readonly providerId: string;
	readonly capability: ConnectorCapabilitySnapshot;
	/** @internal Trusted Host probe used for registry admission and lifecycle truth rechecks. */
	readonly capabilityProbe: (
		options?: FoundationProviderExecutionOptions,
	) => Promise<ResultValue<ConnectorCapabilitySnapshot, FoundationError>>;
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
	/** Trusted reloadable source; it is sampled exactly once when each Attempt is accepted. */
	readonly runtimeLimits?: RuntimeLimitsSource;
	/** Optional and default-off Host credential authority for external targets. */
	readonly credential?: ExternalConnectorCredentialRuntime;
	readonly now?: () => string;
	readonly operationNonce?: () => string;
}

export interface ExternalConnectorStartupRecoveryResult {
	readonly attemptId: string;
	readonly status: "cleanup_confirmed_state_retained" | "quarantined" | "reattached" | "reaped";
}

export interface ExternalConnectorToolGatewayScope {
	readonly schemaVersion: 1;
	readonly gatewayId: string;
	readonly catalogDigest: Fingerprint;
	readonly bindingId: string;
	readonly capabilityBindingId: string;
	readonly policyBindingId: string;
	readonly policyRevision: number;
	readonly policyBindingDigest: Fingerprint;
	readonly mcpSelectionDigest: Fingerprint;
	readonly routes: readonly ToolGatewayRoute[];
}

export type ExternalConnectorToolGatewayConsumer = ((
	request: ToolGatewayRequest,
	options?: { readonly signal?: AbortSignal },
) => Promise<ResultValue<ToolExecutionResult, FoundationError>>) & {
	/** Immutable, exact route list visible to this durable AgentBinding. */
	readonly scope: ExternalConnectorToolGatewayScope;
};

const EXTERNAL_CONNECTOR_CAPABILITIES: readonly FoundationProviderCapability[] = Object.freeze([
	Object.freeze({ schemaVersion: 1, id: "external_connector.lifecycle", version: 1 }),
]);

export interface HostSupervisedExternalAgentConnectorImplementation {
	readonly schemaVersion: ExternalAgentConnector["schemaVersion"];
	readonly providerId: ExternalAgentConnector["providerId"];
	readonly providerClass: ExternalAgentConnector["providerClass"];
	readonly preflightModelProjection: (projection: ExternalResolvedModelProjection) => ExternalModelTranslationResult;
	readonly bindToolGatewayConsumer: (attemptId: string, consumer: ExternalConnectorToolGatewayConsumer) => () => void;
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
	"bindToolGatewayConsumer",
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
export type ExternalConnectorRecoveryFailureSettler = (
	attempt: Attempt,
	error: FoundationError,
) => Promise<ResultValue<AttemptReceipt, FoundationError>>;
const HOST_SUPERVISED_RECOVERY_FAILURE_SETTLERS = new WeakMap<object, ExternalConnectorRecoveryFailureSettler>();

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

function sameExternalConnectorProperty(value: object, captured: CapturedExternalConnectorProperty): boolean {
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
		| "bindToolGatewayConsumer"
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
		connector.bindToolGatewayConsumer !== methods.bindToolGatewayConsumer ||
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
			bindToolGatewayConsumer: methods.bindToolGatewayConsumer,
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

/** @internal Distinguishes a changed factory-created instance from a public SPI implementation. */
export function hasHostSupervisedExternalAgentConnectorProof(value: unknown): boolean {
	return typeof value === "object" && value !== null && HOST_SUPERVISED_EXTERNAL_CONNECTORS.has(value);
}

/** @internal Runtime proof minted only by the Host-supervised durable connector factory. */
export function isHostSupervisedExternalAgentConnector(value: unknown): value is ExternalAgentConnector {
	return getHostSupervisedExternalAgentConnectorImplementation(value) !== undefined;
}

/** @internal Connector-owned recovery-failure receipt authority. */
export function getHostSupervisedExternalConnectorRecoveryFailureSettler(
	value: unknown,
): ExternalConnectorRecoveryFailureSettler | undefined {
	if (!isHostSupervisedExternalAgentConnector(value)) return undefined;
	return HOST_SUPERVISED_RECOVERY_FAILURE_SETTLERS.get(value);
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

interface ExternalConnectorCredentialPlan {
	readonly context: TaskCredentialRunIssueContext;
	readonly requirement: ExternalConnectorCredentialRequirement;
}

function externalConnectorCredentialIssueRequestId(attemptId: string): string {
	return `external_credential_issue_${fingerprintFoundationValue({ attemptId }).value.slice(0, 48)}`;
}

function externalConnectorCredentialReference(
	lease: ExternalConnectorCredentialLease,
): SafeLeaseReference {
	const reference: SafeLeaseReference = {
		schemaVersion: 1,
		leaseId: lease.projection.leaseId,
		grantId: lease.projection.grantId,
		bindingId: lease.projection.bindingId,
		clientRequestId: lease.projection.clientRequestId,
	};
	if (!validateOperationWorkerLeaseReference(reference)) {
		throw externalFailure("external_credential_unavailable", "External connector lease reference is invalid");
	}
	return Object.freeze(reference);
}

function externalFailure(
	code:
		| "binding_epoch_mismatch"
		| "binding_required_fact"
		| "external_binding_invalid"
		| "external_capability_mismatch"
		| "external_connector_config_invalid"
		| "external_credential_unavailable"
		| "external_mapping_conflict"
		| "external_resource_limit_exceeded"
		| "external_resume_unsupported"
		| "external_terminal_ambiguous"
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

function credentialReasonForTerminal(
	status: AttemptReceipt["status"] | ExternalConnectorTerminalEvidence["status"],
	errorCode?: string,
): TaskCredentialLifecycleReasonCode {
	if (status === "succeeded") return "run_completed";
	if (status === "cancelled") return "run_cancelled";
	if (errorCode === "run_deadline_exceeded") return "run_deadline_exceeded";
	return status === "suspended" ? "run_interrupted" : "run_failed";
}

function supervisedFailureEvidence(
	error: unknown,
	handle: ExternalConnectorDriverHandle,
	now: () => string,
	sourceSignal?: AbortSignal,
): ExternalConnectorTerminalEvidence | undefined {
	let code:
		| "external_event_invalid"
		| "external_resource_limit_exceeded"
		| "external_tool_route_denied"
		| "external_frame_oversize"
		| "external_process_identity_ambiguous"
		| "run_deadline_exceeded"
		| "side_effect_unknown";
	let message: string;
	let category: "side_effect_unknown" | "deadline" | "permission";
	let sideEffectState: "none" | "unknown" = "unknown";
	if (isDeadlineAbort(sourceSignal)) {
		code = "run_deadline_exceeded";
		message = "External connector run deadline was exceeded.";
		category = "deadline";
	} else if (
		error instanceof ExternalConnectorSupervisorError &&
		error.code === "external_tool_route_denied"
	) {
		code = "external_tool_route_denied";
		message = "External connector Tool Gateway policy or route denied the request.";
		category = "permission";
		sideEffectState = "none";
	} else if (
		error instanceof ExternalConnectorSupervisorError &&
		(error.code === "tool_gateway_ambiguous" || error.code === "tool_gateway_callback_failed")
	) {
		code = "side_effect_unknown";
		message =
			error.code === "tool_gateway_ambiguous"
				? "External connector Tool Gateway intent has no proven terminal result."
				: "External connector could not receive the durable Tool Gateway result.";
		category = "side_effect_unknown";
	} else if (
		error instanceof ExternalConnectorSupervisorError &&
		(error.code === "external_event_invalid" ||
			error.code === "external_resource_limit_exceeded" ||
			error.code === "external_frame_oversize" ||
			error.code === "external_process_identity_ambiguous")
	) {
		code = error.code;
		message = EXTERNAL_ERROR_MESSAGES[error.code];
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
		sideEffectState,
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
	readonly providerClass = PROVIDER_CLASS.externalConnector;
	readonly providerId: string;
	readonly #capability: ConnectorCapabilitySnapshot;
	readonly #capabilityProbe: (
		options?: FoundationProviderExecutionOptions,
	) => Promise<ResultValue<ConnectorCapabilitySnapshot, FoundationError>>;
	readonly #store: ExternalConnectorDurableStore;
	readonly #driver: ExternalConnectorVendorDriver;
	readonly #supervision: ExternalAgentConnectorRuntimeOptions["supervision"];
	readonly #now: () => string;
	readonly #operationNonce: () => string;
	readonly #runtimeLimitsSource: RuntimeLimitsSource;
	readonly #credentialRuntime: ExternalConnectorCredentialRuntime | undefined;
	readonly #hostRuntimeLimits: RuntimeLimitsSnapshot;
	readonly #attemptRuntimeLimits = new Map<string, RuntimeLimitsSnapshot>();
	readonly #supervisors = new Map<string, ExternalConnectorBoundedSupervisor>();
	readonly #driverHandles = new Map<string, ExternalConnectorDriverHandle>();
	readonly #observationControllers = new Map<string, AbortController>();
	readonly #startCancellationControllers = new Map<string, AbortController>();
	readonly #pendingCancellations = new Set<string>();
	readonly #active = new Map<string, Promise<ResultValue<AttemptReceipt, FoundationError>>>();
	readonly #cancelling = new Map<string, Promise<ResultValue<void, FoundationError>>>();
	readonly #toolGatewayConsumers = new Map<string, ExternalConnectorToolGatewayConsumer>();
	readonly #toolGatewayInFlight = new Map<string, Map<string, string>>();
	readonly #credentialLeases = new Map<string, ExternalConnectorCredentialLease>();
	readonly #drainWaiters = new Set<() => void>();
	#lifecycle: "accepting" | "draining" | "disposed" = "accepting";
	#disposal: Promise<void> | undefined;

	constructor(options: ExternalAgentConnectorRuntimeOptions) {
		const checked = validateConnectorCapabilitySnapshotForProvider(options.capability, {
			providerId: options.providerId,
			providerClass: PROVIDER_CLASS.externalConnector,
		});
		if (!checked.ok) throw checked.error;
		if (typeof options.capabilityProbe !== "function") {
			throw new TypeError("External connector requires an explicit capability probe.");
		}
		if (
			options.supervision === undefined ||
			(options.supervision.containment !== "process_group" && options.supervision.containment !== "job_object") ||
			typeof options.supervision.processController?.launch !== "function" ||
			typeof options.supervision.privateStateStore?.list !== "function" ||
			typeof options.supervision.privateStateStore?.read !== "function" ||
			typeof options.supervision.privateStateStore?.write !== "function" ||
			typeof options.supervision.privateStateStore?.delete !== "function"
		)
			throw externalFailure("invalid_correlation", "External connector supervision is invalid");
		if (
			options.credential !== undefined &&
			(typeof options.credential.service?.issueForTaskRun !== "function" ||
				typeof options.credential.service.lookupDeliveredLease !== "function" ||
				typeof options.credential.service.releaseDeliveredLease !== "function" ||
				typeof options.credential.resolveIssueContext !== "function")
		) {
			throw externalFailure("external_connector_config_invalid", "External connector credential authority is invalid");
		}
		this.providerId = options.providerId;
		this.#capability = checked.value;
		this.#capabilityProbe = options.capabilityProbe;
		this.#store = options.store;
		this.#driver = options.driver;
		this.#supervision = options.supervision;
		this.#runtimeLimitsSource =
			options.runtimeLimits ?? runtimeLimitsFromSupervisorOptions(options.supervision.deadlines, options.supervision.limits);
		this.#hostRuntimeLimits = resolveRuntimeLimitsSource(this.#runtimeLimitsSource);
		this.#credentialRuntime = options.credential;
		this.#now = options.now ?? (() => new Date().toISOString());
		this.#operationNonce = options.operationNonce ?? randomUUID;
	}

	#resolveCredentialPlan(
		attempt: Attempt,
		binding: AgentBinding,
	): ResultValue<ExternalConnectorCredentialPlan | undefined, FoundationError> {
		const runtime = this.#credentialRuntime;
		if (runtime === undefined) return Result.ok(undefined);
		let context: TaskCredentialRunIssueContext | undefined;
		try {
			context = runtime.resolveIssueContext(attempt, binding);
		} catch {
			return Result.err(
				externalFailure(
					"external_credential_unavailable",
					"External connector credential target selection failed",
					attempt.attemptId,
				),
			);
		}
		if (context === undefined) return Result.ok(undefined);
		let scopes: ReadonlyArray<TaskCredentialScope>;
		try {
			scopes = normalizeTaskCredentialScopes(context.scopes);
		} catch {
			return Result.err(
				externalFailure(
					"external_credential_unavailable",
					"External connector credential scope selection is invalid",
					attempt.attemptId,
				),
			);
		}
		if (
			context.taskId !== attempt.taskId ||
			context.capabilityBindingId !== binding.capabilityRevision.id ||
			context.policyBindingId !== binding.policyRevision.id ||
			context.targetId === undefined ||
			context.targetKind === undefined ||
			!isTaskCredentialIdentifier(context.targetId) ||
			!isTaskCredentialIdentifier(context.targetKind) ||
			context.workerId !== undefined ||
			context.workerTarget !== undefined ||
			scopes.length === 0
		) {
			return Result.err(
				externalFailure(
					"external_credential_unavailable",
					"External connector credential selection does not match the exact binding",
					attempt.attemptId,
				),
			);
		}
		const requirement = cloneExternalConnectorCredentialRequirement({
			schemaVersion: 1,
			targetId: context.targetId,
			targetKind: context.targetKind,
			capabilityBindingId: context.capabilityBindingId,
			policyBindingId: context.policyBindingId,
			scopeDigest: calculateScopeDigest(scopes),
			scopeCount: scopes.length,
		});
		return Result.ok(Object.freeze({ context: Object.freeze({ ...context, scopes }), requirement }));
	}

	async #issueCredentialLease(
		attempt: Attempt,
		plan: ExternalConnectorCredentialPlan,
	): Promise<ResultValue<ExternalConnectorCredentialLease, FoundationError>> {
		const runtime = this.#credentialRuntime;
		if (runtime === undefined) {
			return Result.err(
				externalFailure(
					"external_credential_unavailable",
					"External connector credential authority is unavailable",
					attempt.attemptId,
				),
			);
		}
		let projected: SafeLeaseProjection | undefined;
		const target: TaskCredentialWorkerTarget = Object.freeze({
			project: (lease: SafeLeaseProjection) => {
				if (
					!validateOperationWorkerLeaseProjection(lease) ||
					lease.scopeDigest !== plan.requirement.scopeDigest
				) {
					return Object.freeze({ ok: false });
				}
				projected = Object.freeze({ ...lease });
				return Object.freeze({ ok: true });
			},
			renew: (lease: SafeLeaseProjection) => {
				if (
					!validateOperationWorkerLeaseProjection(lease) ||
					lease.scopeDigest !== plan.requirement.scopeDigest ||
					(projected !== undefined &&
						(lease.leaseId !== projected.leaseId ||
							lease.grantId !== projected.grantId ||
							lease.bindingId !== projected.bindingId))
				) {
					return Object.freeze({ ok: false });
				}
				projected = Object.freeze({ ...lease });
				return Object.freeze({ ok: true });
			},
			revoke: (lease: SafeLeaseReference) => {
				if (
					!validateOperationWorkerLeaseReference(lease) ||
					(projected !== undefined &&
						(lease.leaseId !== projected.leaseId ||
							lease.grantId !== projected.grantId ||
							lease.bindingId !== projected.bindingId))
				) {
					return Object.freeze({ ok: false });
				}
				projected = undefined;
				this.#credentialLeases.delete(attempt.attemptId);
				return Object.freeze({ ok: true });
			},
		});
		const clientRequestId = externalConnectorCredentialIssueRequestId(attempt.attemptId);
		const issued = runtime.service.issueForTaskRun({
			...plan.context,
			clientRequestId,
			workerId: attempt.attemptId,
			workerTarget: target,
			targetLifecycle: "external_connector",
		});
		if (!issued.ok || issued.delivery === undefined || issued.delivery.status !== "succeeded") {
			return Result.err(
				externalFailure(
					"external_credential_unavailable",
					"External connector credential could not be issued and delivered",
					attempt.attemptId,
				),
			);
		}
		const projection: SafeLeaseProjection = projected ?? Object.freeze({
			schemaVersion: 1,
			leaseId: issued.grant.leaseId,
			grantId: issued.grant.grantId,
			bindingId: issued.grant.bindingId,
			scopeDigest: issued.grant.scopeDigest,
			expiresAt: issued.grant.expiresAt,
			clientRequestId,
		});
		const leaseFacts = {
			projection,
			targetId: plan.requirement.targetId,
			targetKind: plan.requirement.targetKind,
			scopeCount: plan.requirement.scopeCount,
			issuedAt: issued.grant.issuedAt,
			delivery: issued.delivery,
		};
		let lease: ExternalConnectorCredentialLease;
		try {
			lease = cloneExternalConnectorCredentialLease({
				schemaVersion: 1,
				...leaseFacts,
				leaseDigest: fingerprintFoundationValue(leaseFacts),
			});
		} catch {
			runtime.service.releaseDeliveredLease({
				reference: {
					schemaVersion: 1,
					leaseId: issued.grant.leaseId,
					grantId: issued.grant.grantId,
					bindingId: issued.grant.bindingId,
					clientRequestId,
				},
				targetId: plan.requirement.targetId,
				reasonCode: "run_interrupted",
			});
			return Result.err(
				externalFailure(
					"external_credential_unavailable",
					"External connector credential delivery facts are invalid",
					attempt.attemptId,
				),
			);
		}
		this.#credentialLeases.set(attempt.attemptId, lease);
		return Result.ok(lease);
	}

	#requireCredentialLease(
		operation: ExternalConnectorOperation,
	): ResultValue<SafeLeaseProjection | undefined, FoundationError> {
		if (operation.credentialRequirement === undefined && operation.credential === undefined) {
			return Result.ok(undefined);
		}
		const lease = operation.credential;
		const runtime = this.#credentialRuntime;
		if (lease === undefined || runtime === undefined) {
			return Result.err(
				externalFailure(
					"external_credential_unavailable",
					"External connector credential authority or lease reference is unavailable",
					operation.attemptId,
				),
			);
		}
		const lookup = runtime.service.lookupDeliveredLease({
			projection: lease.projection,
			targetId: lease.targetId,
		});
		if (
			!lookup.ok ||
			lookup.grant.scopeCount !== lease.scopeCount ||
			lookup.grant.issuedAt !== lease.issuedAt
		) {
			return Result.err(
				externalFailure(
					"external_credential_unavailable",
					"External connector credential lease is expired, revoked, or inconsistent",
					operation.attemptId,
				),
			);
		}
		this.#credentialLeases.set(operation.attemptId, lease);
		return Result.ok(Object.freeze({ ...lookup.projection }));
	}

	#releaseCredentialLease(
		attemptId: string,
		lease: ExternalConnectorCredentialLease,
		reasonCode: TaskCredentialLifecycleReasonCode,
	): boolean {
		this.#credentialLeases.delete(attemptId);
		const runtime = this.#credentialRuntime;
		if (runtime === undefined) return false;
		const result = runtime.service.releaseDeliveredLease({
			reference: externalConnectorCredentialReference(lease),
			targetId: lease.targetId,
			reasonCode,
		});
		return result.ok;
	}

	#releaseCredential(
		operation: ExternalConnectorOperation | undefined,
		reasonCode: TaskCredentialLifecycleReasonCode,
	): boolean {
		if (operation?.credential === undefined) return true;
		return this.#releaseCredentialLease(operation.attemptId, operation.credential, reasonCode);
	}

	#requireExactMcpToolGatewayRoutes(
		attempt: Attempt,
		binding: AgentBinding,
	): ResultValue<readonly ToolGatewayRoute[] | undefined, FoundationError> {
		if (!this.#capability.toolGateway) return Result.ok(undefined);
		const driverSelectionValue = this.#driver.toolGatewayMcpSelection;
		const driverSelection =
			driverSelectionValue === undefined ? undefined : validateMcpSelection(driverSelectionValue);
		const bindingSelection =
			driverSelection === undefined ? undefined : validateMcpSelection(binding.mcpSelection);
		const consumer = this.#toolGatewayConsumers.get(attempt.attemptId);
		if (
			consumer === undefined ||
			(driverSelection !== undefined &&
				(bindingSelection === undefined ||
					!driverSelection.ok ||
					!bindingSelection.ok ||
					canonicalFoundationJson(driverSelection.value) !== canonicalFoundationJson(bindingSelection.value) ||
					consumer.scope.bindingId !== binding.bindingId ||
					consumer.scope.capabilityBindingId !== bindingSelection.value.capabilityBindingId ||
					consumer.scope.mcpSelectionDigest.algorithm !== bindingSelection.value.digest.algorithm ||
					consumer.scope.mcpSelectionDigest.value !== bindingSelection.value.digest.value))
		) {
			return Result.err(
				externalFailure(
					"external_binding_invalid",
					"External connector MCP selection does not match its exact Tool Gateway authority",
					attempt.attemptId,
				),
			);
		}
		const routeKeys = new Set<string>();
		for (const route of consumer.scope.routes) {
			const key = canonicalFoundationJson([route.namespace ?? "", route.toolName]);
			if (!isToolGatewayRoute(route) || routeKeys.has(key)) {
				return Result.err(
					externalFailure(
						"external_binding_invalid",
						"External connector Tool Gateway scope is malformed or ambiguous",
						attempt.attemptId,
					),
				);
			}
			routeKeys.add(key);
			if (route.kind !== "mcp") continue;
			if (bindingSelection === undefined || !bindingSelection.ok) continue;
			const selectedServer = bindingSelection.value.servers.find(
				(server) => server.serverId === route.namespace,
			);
			const selectedTool = selectedServer?.tools.find((tool) => tool.toolId === route.toolName);
			if (
				selectedTool === undefined ||
				selectedTool.providerId !== route.providerId ||
				selectedTool.routeRevision !== route.revision
			) {
				return Result.err(
					externalFailure(
						"external_binding_invalid",
						"External connector Tool Gateway scope widens its exact MCP selection",
						attempt.attemptId,
					),
				);
			}
		}
		return Result.ok(consumer.scope.routes);
	}

	/** Reattach mapped live operations and reap private trees that cannot be resumed or reconciled. */
	async recoverPrivateSupervisorState(): Promise<readonly ExternalConnectorStartupRecoveryResult[]> {
		const entries = await this.#supervision.privateStateStore.list();
		const results: ExternalConnectorStartupRecoveryResult[] = [];
		for (const entry of entries) {
			if (this.#supervisors.has(entry.attemptId)) {
				results.push(Object.freeze({ attemptId: entry.attemptId, status: "reattached" }));
				continue;
			}
			const runtimeLimits = await this.#runtimeLimitsForStartupEntry(entry);
			const supervisor = this.#createSupervisorForReference(entry.state.reference, runtimeLimits);
			if (await this.#isStartupReattachable(entry)) {
				try {
					supervisor.reattach(entry.state);
					this.#supervisors.set(entry.attemptId, supervisor);
					this.#notifyDrain();
					results.push(Object.freeze({ attemptId: entry.attemptId, status: "reattached" }));
				} catch {
					await this.#markStartupReconcile(entry);
					results.push(Object.freeze({ attemptId: entry.attemptId, status: "quarantined" }));
				}
				continue;
			}
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
				results.push(
					Object.freeze({
						attemptId: entry.attemptId,
						status: "cleanup_confirmed_state_retained",
					}),
				);
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

	bindToolGatewayConsumer(attemptId: string, consumer: ExternalConnectorToolGatewayConsumer): () => void {
		if (
			!isExternalConnectorMappingIdentifier(attemptId) ||
			typeof consumer !== "function" ||
			consumer.scope?.schemaVersion !== 1 ||
			consumer.scope.gatewayId.length === 0 ||
			consumer.scope.catalogDigest.algorithm !== "sha256" ||
			!Array.isArray(consumer.scope.routes) ||
			!Object.isFrozen(consumer.scope) ||
			!Object.isFrozen(consumer.scope.routes)
		) {
			throw externalFailure("invalid_correlation", "External connector Tool Gateway consumer binding is invalid");
		}
		if (this.#toolGatewayConsumers.has(attemptId)) {
			throw externalFailure(
				"invalid_correlation",
				"External connector Tool Gateway consumer is already bound",
				attemptId,
			);
		}
		this.#toolGatewayConsumers.set(attemptId, consumer);
		let released = false;
		return () => {
			if (released) return;
			released = true;
			if (this.#toolGatewayConsumers.get(attemptId) === consumer) {
				this.#toolGatewayConsumers.delete(attemptId);
			}
		};
	}

	async capabilities(): Promise<readonly FoundationProviderCapability[]> {
		return EXTERNAL_CONNECTOR_CAPABILITIES;
	}

	async probeCapabilities(
		options?: FoundationProviderExecutionOptions,
	): Promise<ResultValue<ConnectorCapabilitySnapshot, FoundationError>> {
		return this.#capabilityProbe(options);
	}

	/** @internal Safe immutable projection used by direct execution-boundary verification. */
	async runtimeLimitsForAttempt(attemptId: string): Promise<RuntimeLimitsSnapshot | undefined> {
		const operation = await this.#store.readOperation(attemptId);
		if (operation !== undefined) return decodeRuntimeLimitsOperationNonce(operation.operationNonce)?.snapshot;
		return this.#attemptRuntimeLimits.get(attemptId);
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
			return Result.err(
				externalFailure("invalid_correlation", "External connector Dispatch and binding do not match"),
			);
		}
		const bindingResult = validateImmutableAgentBinding(binding);
		if (!bindingResult.ok) return bindingResult;
		if (context === undefined) {
			return Result.err(
				externalFailure("binding_epoch_mismatch", "External connector Attempt requires its initial BindingEpoch"),
			);
		}
		const attemptId = externalConnectorAttemptId(this.providerId, dispatch.dispatchId);
		let runtimeLimits = this.#attemptRuntimeLimits.get(attemptId);
		if (runtimeLimits === undefined) {
			try {
				runtimeLimits = resolveRuntimeLimitsSource(this.#runtimeLimitsSource);
			} catch {
				return Result.err(
					externalFailure(
						"external_connector_config_invalid",
						"External connector RuntimeLimits are invalid",
						attemptId,
					),
				);
			}
			if (this.#attemptRuntimeLimits.size >= runtimeLimits.values.maxBacklog) {
				return Result.err(
					externalFailure(
						"external_resource_limit_exceeded",
						"External connector accepted Attempt backlog is full",
						attemptId,
					),
				);
			}
		}
		const created = createFoundationAttempt({
			attemptId,
			dispatch,
			providerId: this.providerId,
			providerClass: this.providerClass,
			initialBindingEpoch: context.initialBindingEpoch,
			now: () => context.initialBindingEpoch.activatedAt,
		});
		if (created.ok) this.#attemptRuntimeLimits.set(attemptId, runtimeLimits);
		return created;
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

	settleRecoveryFailure(
		attempt: Attempt,
		error: FoundationError,
	): Promise<ResultValue<AttemptReceipt, FoundationError>> {
		return this.#exclusive(attempt.attemptId, () => this.#settleRecoveryFailure(attempt, error));
	}

	cancelAttempt(attemptId: string): Promise<ResultValue<void, FoundationError>> {
		if (this.#lifecycle !== "accepting") {
			return Promise.resolve(
				Result.err(externalFailure("side_effect_unknown", "External connector is draining", attemptId)),
			);
		}
		const active = this.#cancelling.get(attemptId);
		if (active !== undefined) return active;
		const cancellation = this.#captureVoid(() => this.#cancel(attemptId));
		this.#cancelling.set(attemptId, cancellation);
		void cancellation.finally(() => {
			this.#cancelling.delete(attemptId);
			this.#notifyDrain();
		});
		return cancellation;
	}

	dispose(): Promise<void> {
		if (this.#disposal !== undefined) return this.#disposal;
		this.#lifecycle = "draining";
		for (const controller of this.#observationControllers.values()) controller.abort();
		for (const controller of this.#startCancellationControllers.values()) controller.abort();
		this.#disposal = this.#drainAndDispose();
		return this.#disposal;
	}

	async #drainAndDispose(): Promise<void> {
		let disposalFailure: unknown;
		for (;;) {
			for (const controller of this.#observationControllers.values()) controller.abort();
			for (const controller of this.#startCancellationControllers.values()) controller.abort();
			const supervisors = [...this.#supervisors.entries()];
			const cleanupResults = await Promise.allSettled(
				supervisors.map(async ([attemptId, supervisor]) => {
					await supervisor.dispose();
					if (supervisor.snapshot.cleaned) {
						await this.#supervision.privateStateStore.delete(attemptId);
						if (this.#supervisors.get(attemptId) === supervisor) this.#supervisors.delete(attemptId);
					}
				}),
			);
			disposalFailure ??= cleanupResults.find((result) => result.status === "rejected")?.reason;
			const operations = [...this.#active.values(), ...this.#cancelling.values()];
			if (this.#active.size === 0 && this.#cancelling.size === 0) {
				const hasUnseenSupervisor = [...this.#supervisors.entries()].some(
					([attemptId, supervisor]) =>
						!supervisors.some(
							([currentAttemptId, currentSupervisor]) =>
								currentAttemptId === attemptId && currentSupervisor === supervisor,
						),
				);
				if (!hasUnseenSupervisor) break;
				continue;
			}
			const changed = new Promise<void>((resolve) => this.#drainWaiters.add(resolve));
			await Promise.race([
				changed,
				...operations.map((operation) =>
					operation.then(
						() => undefined,
						() => undefined,
					),
				),
			]);
		}
		for (const [attemptId, lease] of [...this.#credentialLeases]) {
			if (!this.#releaseCredentialLease(attemptId, lease, "session_shutdown")) {
				disposalFailure ??= externalFailure(
					"external_credential_unavailable",
					"External connector credential cleanup could not be confirmed",
					attemptId,
				);
			}
		}
		try {
			const shutdownDeadline = runtimeLimitsShutdownDeadline(this.#hostRuntimeLimits);
			await runExternalConnectorHostDispose((signal) => this.#driver.dispose({ signal }), {
				deadline: shutdownDeadline,
				...(this.#supervision.clock === undefined ? {} : { clock: this.#supervision.clock }),
			});
		} catch (error) {
			disposalFailure ??= error;
		} finally {
			this.#supervisors.clear();
			this.#driverHandles.clear();
			this.#observationControllers.clear();
			this.#startCancellationControllers.clear();
			this.#pendingCancellations.clear();
			this.#attemptRuntimeLimits.clear();
			this.#toolGatewayConsumers.clear();
			this.#toolGatewayInFlight.clear();
			this.#credentialLeases.clear();
			this.#drainWaiters.clear();
			this.#lifecycle = "disposed";
		}
		if (disposalFailure !== undefined) throw disposalFailure;
	}

	#exclusive(
		attemptId: string,
		operation: () => Promise<ResultValue<AttemptReceipt, FoundationError>>,
	): Promise<ResultValue<AttemptReceipt, FoundationError>> {
		if (this.#lifecycle !== "accepting") {
			return Promise.resolve(
				Result.err(externalFailure("side_effect_unknown", "External connector is draining", attemptId)),
			);
		}
		const active = this.#active.get(attemptId);
		if (active !== undefined) return active;
		const current = this.#capture(operation);
		this.#active.set(attemptId, current);
		void current.finally(() => {
			this.#active.delete(attemptId);
			this.#notifyDrain();
		});
		return current;
	}

	#notifyDrain(): void {
		for (const resolve of this.#drainWaiters) resolve();
		this.#drainWaiters.clear();
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

	async #captureVoid(
		operation: () => Promise<ResultValue<void, FoundationError>>,
	): Promise<ResultValue<void, FoundationError>> {
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

	#decodeOperationRuntimeLimits(
		operation: ExternalConnectorOperation,
	): ResultValue<RuntimeLimitsOperationNonce, FoundationError> {
		const decoded = decodeRuntimeLimitsOperationNonce(operation.operationNonce);
		return decoded === undefined
			? Result.err(
					externalFailure(
						"external_connector_config_invalid",
						"External connector Attempt has no valid frozen RuntimeLimits",
						operation.attemptId,
					),
				)
			: Result.ok(decoded);
	}

	#createSupervisor(operation: ExternalConnectorOperation): ExternalConnectorBoundedSupervisor {
		const runtimeLimits = this.#decodeOperationRuntimeLimits(operation);
		if (!runtimeLimits.ok) throw runtimeLimits.error;
		return this.#createSupervisorForReference({
			schemaVersion: 1,
			supervisorRef: `external_supervisor_${fingerprintFoundationValue({
				providerId: this.providerId,
				attemptId: operation.attemptId,
			}).value.slice(0, 32)}`,
			operationNonce: runtimeLimits.value.processNonce,
		}, runtimeLimits.value.snapshot);
	}

	#createSupervisorForReference(
		reference: ExternalConnectorSupervisorReference,
		runtimeLimits: RuntimeLimitsSnapshot,
	): ExternalConnectorBoundedSupervisor {
		return new ExternalConnectorBoundedSupervisor({
			reference,
			containment: this.#supervision.containment,
			processController: this.#supervision.processController,
			artifactsAllowed: this.#capability.artifacts,
			deadlines: runtimeLimitsSupervisorDeadlines(runtimeLimits),
			limits: runtimeLimitsSupervisorLimits(runtimeLimits),
			clock: this.#supervision.clock,
		});
	}

	async #markStartupReconcile(entry: ExternalConnectorSupervisorPrivateStateEntry): Promise<void> {
		const operationValue = await this.#store.readOperation(entry.attemptId);
		if (operationValue === undefined) return;
		let operation: ExternalConnectorOperation;
		try {
			operation = cloneExternalConnectorOperation(operationValue);
		} catch {
			return;
		}
		if (
			operation.providerId !== this.providerId ||
			operation.attemptId !== entry.attemptId ||
			decodeRuntimeLimitsOperationNonce(operation.operationNonce)?.processNonce !==
				entry.state.reference.operationNonce ||
			operation.status === "terminal" ||
			operation.status === "reconcile_required"
		)
			return;
		await this.#markReconcile(operation, "driver_failure");
	}

	async #runtimeLimitsForStartupEntry(
		entry: ExternalConnectorSupervisorPrivateStateEntry,
	): Promise<RuntimeLimitsSnapshot> {
		const operationValue = await this.#store.readOperation(entry.attemptId);
		if (operationValue === undefined) return this.#hostRuntimeLimits;
		let operation: ExternalConnectorOperation;
		try {
			operation = cloneExternalConnectorOperation(operationValue);
		} catch {
			return this.#hostRuntimeLimits;
		}
		const decoded = decodeRuntimeLimitsOperationNonce(operation.operationNonce);
		return decoded !== undefined && decoded.processNonce === entry.state.reference.operationNonce
			? decoded.snapshot
			: this.#hostRuntimeLimits;
	}

	async #isStartupReattachable(entry: ExternalConnectorSupervisorPrivateStateEntry): Promise<boolean> {
		const operationValue = await this.#store.readOperation(entry.attemptId);
		if (operationValue === undefined) return false;
		let operation: ExternalConnectorOperation;
		try {
			operation = cloneExternalConnectorOperation(operationValue);
		} catch {
			return false;
		}
		const runtimeLimits = decodeRuntimeLimitsOperationNonce(operation.operationNonce);
		if (
			operation.providerId !== this.providerId ||
			operation.attemptId !== entry.attemptId ||
			runtimeLimits === undefined ||
			runtimeLimits.processNonce !== entry.state.reference.operationNonce ||
			operation.status === "prepared" ||
			operation.status === "terminal"
		)
			return false;
		const mapping = await this.#store.readMapping(entry.attemptId);
		return (
			mapping !== undefined &&
			mapping.providerId === operation.providerId &&
			mapping.attemptId === operation.attemptId &&
			mapping.binding.revision === operation.bindingRevision &&
			sameFingerprint(mapping.binding.digest, operation.bindingDigest) &&
			mapping.capability.revision === operation.capabilityRevision &&
			sameFingerprint(mapping.capability.digest, operation.capabilityDigest) &&
			mapping.supervisor.ref === entry.state.reference.supervisorRef &&
			mapping.supervisor.nonce === runtimeLimits.processNonce
		);
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
			}, signal);
			this.#supervisors.set(operation.attemptId, supervisor);
			this.#notifyDrain();
			return supervisor;
		} catch (error) {
			const privateState = supervisor.hostPrivateState;
			if (privateState !== undefined) {
				try {
					await supervisor.dispose();
				} catch (cleanupError) {
					this.#supervisors.set(operation.attemptId, supervisor);
					this.#notifyDrain();
					if (!statePersisted) {
						await this.#supervision.privateStateStore.write(operation.attemptId, privateState);
					}
					throw externalConnectorSupervisorFailure(cleanupError);
				}
				if (supervisor.snapshot.cleaned) {
					await this.#supervision.privateStateStore.delete(operation.attemptId);
				}
			}
			throw externalConnectorSupervisorFailure(error);
		}
	}

	async #releaseSupervisor(attemptId: string, supervisor: ExternalConnectorBoundedSupervisor): Promise<void> {
		await supervisor.dispose();
		if (!supervisor.snapshot.cleaned) {
			throw externalConnectorSupervisorFailure(new Error("External Connector supervisor process did not terminate"));
		}
		this.#supervisors.delete(attemptId);
		this.#driverHandles.delete(attemptId);
		this.#observationControllers.delete(attemptId);
		await this.#supervision.privateStateStore.delete(attemptId);
	}

	#hasAttemptCapacity(attemptId: string, runtimeLimits: RuntimeLimitsSnapshot): boolean {
		if (this.#cancelling.has(attemptId)) return true;
		let preceding = 0;
		for (const activeAttemptId of this.#active.keys()) {
			if (activeAttemptId === attemptId) return preceding < runtimeLimits.values.maxConcurrency;
			preceding += 1;
		}
		return false;
	}

	async #recoverSupervisorWithoutMapping(operation: ExternalConnectorOperation): Promise<void> {
		const privateState = await this.#supervision.privateStateStore.read(operation.attemptId);
		if (privateState === undefined) return;
		const supervisor = this.#createSupervisor(operation);
		await supervisor.recoverAndReap(privateState);
		if (!supervisor.snapshot.cleaned) {
			throw externalConnectorSupervisorFailure(new Error("External Connector recovered process did not terminate"));
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
			this.#notifyDrain();
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
			return Result.err(
				externalFailure("invalid_correlation", "External connector driver handle conflicts with durable authority"),
			);
		}
		return Result.ok(
			Object.freeze({
				externalSessionId: value.externalSessionId,
				...(value.externalTurnId === undefined ? {} : { externalTurnId: value.externalTurnId }),
				supervisorRef: value.supervisorRef,
				operationNonce: value.operationNonce,
			}),
		);
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
		if (priorReceipt.value !== undefined) {
			this.#attemptRuntimeLimits.delete(attempt.attemptId);
			return Result.ok(priorReceipt.value);
		}
		if (attempt.status !== "starting") {
			return Result.err(
				externalFailure(
					"scheduler_attempt_recovery_failed",
					"runAttempt requires a not-started durable Attempt",
					attempt.attemptId,
				),
			);
		}
		const binding = await this.#requireBinding(attempt);
		if (!binding.ok) return binding;
		const correlation = this.#requireCorrelation(attempt, options?.correlation);
		if (!correlation.ok) return correlation;
		if (isAborted()) {
			return this.#settleCancelledBeforeLaunch(attempt, correlation.value, undefined, options?.signal);
		}
		const mcpToolGatewayRoutes = this.#requireExactMcpToolGatewayRoutes(attempt, binding.value);
		if (!mcpToolGatewayRoutes.ok) return mcpToolGatewayRoutes;
		const executionInput = await this.#store.readExecutionInput(attempt.taskId);
		if (executionInput === undefined) {
			return Result.err(
				externalFailure(
					"external_binding_invalid",
					"External connector requires durable canonical input",
					attempt.attemptId,
				),
			);
		}
		if (
			(this.#capability.modelAccess === "aos_gateway") !== (executionInput.modelProjection !== undefined) ||
			(executionInput.modelProjection === undefined) !== (executionInput.modelTranslation === undefined)
		) {
			return Result.err(
				externalFailure(
					"binding_required_fact",
					"External connector model projection does not match its capability",
					attempt.attemptId,
				),
			);
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
				return Result.err(
					externalFailure(
						"binding_required_fact",
						"External connector model translation is unavailable or drifted",
						attempt.attemptId,
					),
				);
			}
			modelTranslation = translated.translation;
		}
		const credentialPlan = this.#resolveCredentialPlan(attempt, binding.value);
		if (!credentialPlan.ok) return credentialPlan;

		let operation = await this.#store.readOperation(attempt.attemptId);
		let runtimeLimits: RuntimeLimitsSnapshot;
		if (operation === undefined) {
			const acceptedRuntimeLimits = this.#attemptRuntimeLimits.get(attempt.attemptId);
			if (acceptedRuntimeLimits === undefined) {
				return Result.err(
					externalFailure(
						"external_connector_config_invalid",
						"External connector Attempt has no frozen RuntimeLimits",
						attempt.attemptId,
					),
				);
			}
			runtimeLimits = acceptedRuntimeLimits;
		} else {
			const decoded = this.#decodeOperationRuntimeLimits(operation);
			if (!decoded.ok) {
				await this.#markReconcile(operation, "capability_drift");
				return Result.err(decoded.error);
			}
			runtimeLimits = decoded.value.snapshot;
			this.#attemptRuntimeLimits.delete(attempt.attemptId);
		}
		if (!this.#hasAttemptCapacity(attempt.attemptId, runtimeLimits)) {
			return Result.err(
				externalFailure(
					"external_resource_limit_exceeded",
					"External connector Attempt concurrency limit is full",
					attempt.attemptId,
				),
			);
		}
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
				operationNonce: encodeRuntimeLimitsOperationNonce(runtimeLimits, this.#operationNonce()),
				correlation: correlation.value,
				status: "prepared",
				revision: 1,
				updatedAt: this.#now(),
				...(credentialPlan.value === undefined
					? {}
					: { credentialRequirement: credentialPlan.value.requirement }),
			});
			this.#attemptRuntimeLimits.delete(attempt.attemptId);
		}
		if (isAborted()) {
			return this.#settleCancelledBeforeLaunch(attempt, correlation.value, operation, options?.signal);
		}
		const frozen = await this.#requireFrozenFacts(operation, attempt, binding.value);
		if (!frozen.ok) return frozen;
		const credentialRequirementMatches =
			credentialPlan.value === undefined
				? operation.credentialRequirement === undefined
				: canonicalFoundationJson(credentialPlan.value.requirement) ===
					canonicalFoundationJson(operation.credentialRequirement);
		if (!credentialRequirementMatches) {
			await this.#markReconcile(operation, "credential_unavailable");
			return Result.err(
				externalFailure(
					"external_credential_unavailable",
					"External connector credential selection drifted from its durable requirement",
					attempt.attemptId,
				),
			);
		}
		const recoverCredentialIssue =
			operation.status === "start_intent" &&
			operation.credentialRequirement !== undefined &&
			operation.credential === undefined;
		if (operation.status !== "prepared" && !recoverCredentialIssue) {
			if (operation.status === "start_intent") {
				await this.#markReconcile(operation, "start_outcome_unknown");
			}
			return Result.err(
				externalFailure(
					"external_capability_mismatch",
					"External connector Attempt is not safe to start",
					attempt.attemptId,
				),
			);
		}

		if (operation.status === "prepared") {
			operation = await this.#store.writeOperation(
				transitionExternalConnectorOperation(operation, "start_intent", { now: this.#now() }),
			);
		}
		if (isAborted()) {
			return this.#settleCancelledBeforeLaunch(attempt, correlation.value, operation, options?.signal);
		}
		if (operation.credentialRequirement !== undefined && operation.credential === undefined) {
			if (credentialPlan.value === undefined) {
				await this.#markReconcile(operation, "credential_unavailable");
				return Result.err(
					externalFailure(
						"external_credential_unavailable",
						"External connector credential authority is unavailable",
						attempt.attemptId,
					),
				);
			}
			const issuedCredential = await this.#issueCredentialLease(attempt, credentialPlan.value);
			if (!issuedCredential.ok) {
				await this.#markReconcile(operation, "credential_unavailable");
				return issuedCredential;
			}
			try {
				operation = await this.#store.writeOperation(
					attachExternalConnectorCredentialLease(operation, issuedCredential.value, this.#now()),
				);
			} catch {
				this.#releaseCredentialLease(attempt.attemptId, issuedCredential.value, "run_interrupted");
				await this.#markReconcile(operation, "credential_unavailable");
				return Result.err(
					externalFailure(
						"external_credential_unavailable",
						"External connector credential delivery facts could not be persisted",
						attempt.attemptId,
					),
				);
			}
		}
		if (isAborted()) {
			return this.#settleCancelledBeforeLaunch(attempt, correlation.value, operation, options?.signal);
		}
		const operationNonce = frozen.value.processNonce;
		const launchOperation = operation;
		let supervisor: ExternalConnectorBoundedSupervisor;
		try {
			supervisor = await this.#launchSupervisor(operation, options?.signal);
		} catch {
			await this.#markReconcile(operation, "start_outcome_unknown");
			return Result.err(
				externalFailure(
					"side_effect_unknown",
					"External connector process launch could not be proven",
					attempt.attemptId,
				),
			);
		}
		if (isAborted()) {
			try {
				await this.#releaseSupervisor(attempt.attemptId, supervisor);
			} catch {
				await this.#markReconcile(operation, "start_outcome_unknown");
				return Result.err(
					externalFailure(
						"side_effect_unknown",
						"External connector process cleanup could not be proven",
						attempt.attemptId,
					),
				);
			}
			return this.#settleCancelledBeforeLaunch(attempt, correlation.value, operation, options?.signal);
		}
		let handle: ExternalConnectorDriverHandle;
		let spawnCalled = false;
		const startCancellation = new AbortController();
		this.#startCancellationControllers.set(attempt.attemptId, startCancellation);
		if (this.#pendingCancellations.has(attempt.attemptId)) startCancellation.abort();
		try {
			handle = await supervisor.run(
				"start",
				(signal) => {
					spawnCalled = true;
					return this.#driver.spawn({
						attempt,
						correlation: launchOperation.correlation,
						input: executionInput.input,
						...(executionInput.modelProjection === undefined
							? {}
							: { modelProjection: executionInput.modelProjection }),
						...(modelTranslation === undefined ? {} : { modelTranslation }),
						capability: this.#capability,
						bindingDigest: binding.value.fingerprint.value,
						bindingRevision: binding.value.contextRevision.revision,
						...(launchOperation.credential === undefined
							? {}
							: { credential: launchOperation.credential.projection }),
						mcpSelection: binding.value.mcpSelection,
						...(mcpToolGatewayRoutes.value === undefined
							? {}
							: { toolGatewayRoutes: mcpToolGatewayRoutes.value }),
						supervisorRef: supervisor.reference.supervisorRef,
						operationNonce,
						signal,
					});
				},
				options?.signal,
				"opaque",
				undefined,
				startCancellation.signal,
			);
		} catch {
			if (supervisor.snapshot.cleaned) {
				this.#supervisors.delete(attempt.attemptId);
				await this.#supervision.privateStateStore.delete(attempt.attemptId);
			}
			if (isAborted()) {
				if (!supervisor.snapshot.cleaned) {
					await this.#markReconcile(operation, "start_outcome_unknown");
					return Result.err(
						externalFailure(
							"side_effect_unknown",
							"External connector process cleanup is unknown",
							attempt.attemptId,
						),
					);
				}
				return spawnCalled
					? this.#settleFailedWithoutMapping(attempt, correlation.value, operation, options?.signal)
					: this.#settleCancelledBeforeLaunch(attempt, correlation.value, operation, options?.signal);
			}
			await this.#markReconcile(operation, "start_outcome_unknown");
			return Result.err(
				externalFailure("provider_spawn_failed", "External connector start outcome is unknown", attempt.attemptId),
			);
		} finally {
			if (this.#startCancellationControllers.get(attempt.attemptId) === startCancellation) {
				this.#startCancellationControllers.delete(attempt.attemptId);
			}
		}

		const handleResult = this.#requireAuthoritativeDriverHandle(handle, supervisor);
		if (!handleResult.ok) {
			await this.#releaseSupervisor(attempt.attemptId, supervisor).catch(() => undefined);
			await this.#markReconcile(operation, "mapping_conflict");
			return Result.err(handleResult.error);
		}
		handle = handleResult.value;
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
				capability: { digest: operation.capabilityDigest, revision: operation.capabilityRevision },
				supervisor: { ref: handle.supervisorRef, nonce: handle.operationNonce },
				createdAt: this.#now(),
			});
			mapping = await this.#store.writeMapping(mapping, operation.correlation);
		} catch (error) {
			await this.#releaseSupervisor(attempt.attemptId, supervisor).catch(() => undefined);
			const mappingConflict = error instanceof FoundationError && error.code === "session_ledger_conflict";
			await this.#markReconcile(operation, mappingConflict ? "mapping_conflict" : "mapping_persistence_unknown");
			return Result.err(
				externalFailure(
					mappingConflict ? "external_mapping_conflict" : "side_effect_unknown",
					mappingConflict
						? "External connector mapping conflicts with another durable Attempt"
						: "External connector mapping could not be proven durable",
					attempt.attemptId,
				),
			);
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
			const evidence = await this.#observeToReceipt(operation, supervisor, handle, options?.signal);
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
			if (this.#pendingCancellations.has(attempt.attemptId)) {
				return Result.err(
					externalFailure(
						"worker_cancel_failed",
						"External connector cancellation is containing the active process",
						attempt.attemptId,
					),
				);
			}
			if (options?.signal?.aborted === true && !supervisor.snapshot.cleaned) {
				await this.#markReconcile(operation, "driver_failure");
				return Result.err(
					externalFailure(
						"side_effect_unknown",
						"External connector process cleanup is unknown",
						attempt.attemptId,
					),
				);
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
			return Result.err(
				externalFailure("worker_lost", "External connector terminal state is unknown", attempt.attemptId),
			);
		}
	}

	async #resume(
		attempt: Attempt,
		options?: FoundationProviderExecutionOptions,
	): Promise<ResultValue<AttemptReceipt, FoundationError>> {
		if (options?.signal?.aborted === true) {
			return Result.err(
				externalFailure(
					"scheduler_attempt_recovery_failed",
					"External connector resume was aborted before recovery",
					attempt.attemptId,
				),
			);
		}
		const durable = await this.#requireDurableAttempt(attempt);
		if (!durable.ok) return durable;
		const priorReceipt = await this.#requirePriorReceipt(attempt);
		if (!priorReceipt.ok) return priorReceipt;
		if (priorReceipt.value !== undefined) {
			this.#attemptRuntimeLimits.delete(attempt.attemptId);
			return Result.ok(priorReceipt.value);
		}
		if (!this.#capability.resume) {
			return Result.err(
				externalFailure(
					"external_resume_unsupported",
					"External connector does not support resume",
					attempt.attemptId,
				),
			);
		}
		const operation = await this.#store.readOperation(attempt.attemptId);
		if (operation === undefined || operation.status !== "running") {
			return Result.err(
				externalFailure(
					"scheduler_attempt_recovery_failed",
					"External connector Attempt is not resumable",
					attempt.attemptId,
				),
			);
		}
		const binding = await this.#requireBinding(attempt);
		if (!binding.ok) return binding;
		const frozen = await this.#requireFrozenFacts(operation, attempt, binding.value);
		if (!frozen.ok) return frozen;
		const credential = this.#requireCredentialLease(operation);
		if (!credential.ok) {
			await this.#markReconcile(operation, "credential_unavailable");
			return credential;
		}
		if (!this.#hasAttemptCapacity(attempt.attemptId, frozen.value.snapshot)) {
			return Result.err(
				externalFailure(
					"external_resource_limit_exceeded",
					"External connector Attempt concurrency limit is full",
					attempt.attemptId,
				),
			);
		}
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
			const handleResult = this.#requireAuthoritativeDriverHandle(connected, supervisor, mapping.value);
			if (!handleResult.ok) {
				await this.#releaseSupervisor(attempt.attemptId, supervisor).catch(() => undefined);
				await this.#markReconcile(operation, "mapping_conflict");
				return Result.err(handleResult.error);
			}
			handle = handleResult.value;
			this.#driverHandles.set(attempt.attemptId, handle);
			const evidence = await this.#observeToReceipt(operation, supervisor, handle, options?.signal);
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
			if (this.#pendingCancellations.has(attempt.attemptId)) {
				return Result.err(
					externalFailure(
						"worker_cancel_failed",
						"External connector cancellation is containing the active process",
						attempt.attemptId,
					),
				);
			}
			if (cleanupUnknown) {
				await this.#markReconcile(operation, "driver_failure");
				return Result.err(
					externalFailure(
						"side_effect_unknown",
						"External connector process cleanup is unknown",
						attempt.attemptId,
					),
				);
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
			return Result.err(
				externalFailure("worker_lost", "External connector resume state is unknown", attempt.attemptId),
			);
		}
	}

	async #reconcile(
		attempt: Attempt,
		options?: FoundationProviderExecutionOptions,
	): Promise<ResultValue<AttemptReceipt, FoundationError>> {
		if (options?.signal?.aborted === true) {
			return Result.err(
				externalFailure(
					"scheduler_attempt_recovery_failed",
					"External connector reconciliation was aborted before recovery",
					attempt.attemptId,
				),
			);
		}
		const durable = await this.#requireDurableAttempt(attempt);
		if (!durable.ok) return durable;
		const priorReceipt = await this.#requirePriorReceipt(attempt);
		if (!priorReceipt.ok) return priorReceipt;
		if (priorReceipt.value !== undefined) {
			this.#attemptRuntimeLimits.delete(attempt.attemptId);
			return Result.ok(priorReceipt.value);
		}
		let operation = await this.#store.readOperation(attempt.attemptId);
		if (operation === undefined) {
			return Result.err(
				externalFailure(
					"scheduler_attempt_recovery_failed",
					"External connector operation does not exist",
					attempt.attemptId,
				),
			);
		}
		if (operation.status === "terminal") {
			return Result.err(
				externalFailure(
					"scheduler_attempt_recovery_failed",
					"External connector terminal operation has no canonical receipt",
					attempt.attemptId,
				),
			);
		}
		const binding = await this.#requireBinding(attempt);
		if (!binding.ok) return binding;
		const frozen = await this.#requireFrozenFacts(operation, attempt, binding.value);
		if (!frozen.ok) return frozen;
		const credential = this.#requireCredentialLease(operation);
		if (!credential.ok) {
			await this.#markReconcile(operation, "credential_unavailable");
			return credential;
		}
		if (!this.#hasAttemptCapacity(attempt.attemptId, frozen.value.snapshot)) {
			return Result.err(
				externalFailure(
					"external_resource_limit_exceeded",
					"External connector Attempt concurrency limit is full",
					attempt.attemptId,
				),
			);
		}
		const mapping = await this.#requireMapping(operation);
		if (!mapping.ok) return mapping;
		let supervisor: ExternalConnectorBoundedSupervisor;
		try {
			supervisor = await this.#reattachSupervisor(operation, options?.signal);
		} catch {
			await this.#markReconcile(operation, "driver_failure");
			return Result.err(
				externalFailure(
					"side_effect_unknown",
					"External connector process identity requires reconciliation",
					attempt.attemptId,
				),
			);
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
			return Result.err(
				externalFailure("worker_lost", "External connector reconciliation lookup failed", attempt.attemptId),
			);
		}
		if (!isExternalConnectorDriverLookup(lookup)) {
			await this.#releaseSupervisor(attempt.attemptId, supervisor).catch(() => undefined);
			await this.#markReconcile(operation, "mapping_conflict");
			return Result.err(
				externalFailure("invalid_correlation", "External connector lookup result is invalid", attempt.attemptId),
			);
		}
		if (lookup.status === "missing" || lookup.status === "ambiguous") {
			await this.#releaseSupervisor(attempt.attemptId, supervisor).catch(() => undefined);
			await this.#markReconcile(
				operation,
				lookup.status === "missing" ? "driver_state_missing" : "driver_state_ambiguous",
			);
			return Result.err(
				externalFailure(
					lookup.status === "ambiguous" ? "external_terminal_ambiguous" : "side_effect_unknown",
					lookup.status === "ambiguous"
						? "External connector terminal lookup is ambiguous and requires operator reconciliation"
						: "External connector state requires operator reconciliation",
					attempt.attemptId,
				),
			);
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
				const failureEvidence = supervisedFailureEvidence(
					error,
					{
						externalSessionId: mapping.value.externalSessionId,
						...(mapping.value.externalTurnId === undefined
							? {}
							: { externalTurnId: mapping.value.externalTurnId }),
						supervisorRef: mapping.value.supervisor.ref,
						operationNonce: mapping.value.supervisor.nonce,
					},
					this.#now,
					options?.signal,
				);
				if (failureEvidence !== undefined) {
					return this.#settle(attempt, operation, mapping.value, failureEvidence);
				}
				await this.#markReconcile(operation, "driver_failure");
				return Result.err(
					externalFailure(
						"side_effect_unknown",
						"External connector process cleanup is unknown",
						attempt.attemptId,
					),
				);
			}
		}
		if (operation.status === "start_intent") {
			operation = await this.#store.writeOperation(
				transitionExternalConnectorOperation(operation, "running", { now: this.#now() }),
			);
		}
		const handleResult = this.#requireAuthoritativeDriverHandle(lookup.handle, supervisor, mapping.value);
		if (!handleResult.ok) {
			await this.#releaseSupervisor(attempt.attemptId, supervisor).catch(() => undefined);
			await this.#markReconcile(operation, "mapping_conflict");
			return Result.err(handleResult.error);
		}
		const handle = handleResult.value;
		this.#driverHandles.set(attempt.attemptId, handle);
		try {
			const evidence = await this.#observeToReceipt(operation, supervisor, handle, options?.signal);
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
			if (this.#pendingCancellations.has(attempt.attemptId)) {
				return Result.err(
					externalFailure(
						"worker_cancel_failed",
						"External connector cancellation is containing the active process",
						attempt.attemptId,
					),
				);
			}
			if (cleanupUnknown) {
				await this.#markReconcile(operation, "driver_failure");
				return Result.err(
					externalFailure(
						"side_effect_unknown",
						"External connector process cleanup is unknown",
						attempt.attemptId,
					),
				);
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
			return Result.err(
				externalFailure("worker_lost", "External connector reconciled execution did not settle", attempt.attemptId),
			);
		}
	}

	async #cancel(attemptId: string): Promise<ResultValue<void, FoundationError>> {
		const attempt = await this.#store.readAttempt(attemptId);
		if (attempt === undefined) {
			this.#pendingCancellations.add(attemptId);
			return Result.ok(undefined);
		}
		if (attempt.providerId !== this.providerId) {
			return Result.err(
				externalFailure(
					"invalid_correlation",
					"cancelAttempt requires this connector's durable Attempt",
					attemptId,
				),
			);
		}
		const priorReceipt = await this.#requirePriorReceipt(attempt);
		if (!priorReceipt.ok) return Result.err(priorReceipt.error);
		if (priorReceipt.value !== undefined) {
			this.#attemptRuntimeLimits.delete(attemptId);
			return Result.ok(undefined);
		}
		this.#pendingCancellations.add(attemptId);
		let operation = await this.#store.readOperation(attemptId);
		if (operation === undefined || operation.status === "prepared") return Result.ok(undefined);
		if (operation.status === "terminal") {
			return Result.err(
				externalFailure(
					"scheduler_attempt_recovery_failed",
					"External connector terminal operation has no canonical receipt",
					attemptId,
				),
			);
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
			const active = this.#active.get(attemptId);
			if (active !== undefined) {
				this.#startCancellationControllers.get(attemptId)?.abort();
				const completed = await active;
				return completed.ok ? Result.ok(undefined) : Result.err(completed.error);
			}
			await this.#markReconcile(operation, "start_outcome_unknown");
			return Result.err(
				externalFailure(
					"side_effect_unknown",
					"External connector start outcome must be reconciled before cancellation",
					attemptId,
				),
			);
		}
		if (operation.status === "reconcile_required") {
			return Result.err(
				externalFailure(
					"side_effect_unknown",
					"External connector state must be reconciled before cancellation",
					attemptId,
				),
			);
		}
		const credential = this.#requireCredentialLease(operation);
		if (!credential.ok) {
			await this.#markReconcile(operation, "credential_unavailable");
			return Result.err(credential.error);
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
			const connected =
				activeHandle ??
				(await supervisor.run("start", (signal) => this.#driver.connect(mapping.value, { signal })));
			const handleResult = this.#requireAuthoritativeDriverHandle(connected, supervisor, mapping.value);
			if (!handleResult.ok) {
				await this.#releaseSupervisor(attemptId, supervisor).catch(() => undefined);
				await this.#markReconcile(operation, "mapping_conflict");
				return Result.err(handleResult.error);
			}
			const handle = handleResult.value;
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
				return Result.ok(undefined);
			}
			this.#observationControllers.get(attemptId)?.abort();
			try {
				await supervisor.containAfterCancellationGrace();
			} finally {
				if (supervisor.snapshot.cleaned) {
					await this.#releaseSupervisor(attemptId, supervisor).catch(() => undefined);
				}
			}
			await this.#markReconcile(operation, "driver_failure");
			this.#pendingCancellations.delete(attemptId);
			return Result.err(
				externalFailure(
					"worker_cancel_failed",
					"External connector cancellation produced no terminal evidence",
					attemptId,
				),
			);
		} catch {
			if (supervisor?.snapshot.cleaned === true) {
				this.#supervisors.delete(attemptId);
				await this.#supervision.privateStateStore.delete(attemptId);
			}
			const concurrentReceipt = await this.#requirePriorReceipt(attempt);
			if (concurrentReceipt.ok && concurrentReceipt.value !== undefined) return Result.ok(undefined);
			await this.#markReconcile(operation, "driver_failure");
			this.#pendingCancellations.delete(attemptId);
			return Result.err(
				externalFailure("worker_cancel_failed", "External connector cancellation outcome is unknown", attemptId),
			);
		}
	}

	async #observeToReceipt(
		operation: ExternalConnectorOperation,
		supervisor: ExternalConnectorBoundedSupervisor,
		handle: ExternalConnectorDriverHandle,
		sourceSignal?: AbortSignal,
	): Promise<ExternalConnectorTerminalEvidence> {
		const attemptId = operation.attemptId;
		if (sourceSignal?.aborted === true) {
			await this.#releaseSupervisor(attemptId, supervisor);
			throw sourceSignal.reason;
		}
		const stopController = new AbortController();
		this.#observationControllers.set(attemptId, stopController);
		const events = supervisor.consumeEvents(
			(signal) => this.#driver.events(handle, { signal }),
			handle,
			sourceSignal,
			(event, signal) => this.#consumeToolGatewayEvent(operation, handle, event, signal),
			stopController.signal,
		);
		const receipt = supervisor.run(
			"receipt",
			(signal) => this.#driver.read(handle, { signal }),
			sourceSignal,
			"terminal_evidence",
			stopController.signal,
		);
		try {
			const [, evidence] = await Promise.all([events, receipt]);
			return evidence;
		} catch (error) {
			if (!stopController.signal.aborted) stopController.abort();
			await Promise.allSettled([events, receipt]);
			throw error;
		} finally {
			if (this.#observationControllers.get(attemptId) === stopController) {
				this.#observationControllers.delete(attemptId);
			}
		}
	}

	async #consumeToolGatewayEvent(
		operation: ExternalConnectorOperation,
		handle: ExternalConnectorDriverHandle,
		event: ExternalConnectorDriverEvent,
		signal: AbortSignal,
	): Promise<void> {
		if (event.type !== "tool_gateway_request") return;
		let inFlight: Map<string, string> | undefined;
		let claimed = false;
		try {
			const runtimeLimits = this.#decodeOperationRuntimeLimits(operation);
			if (!runtimeLimits.ok) throw new ExternalConnectorSupervisorError("external_event_invalid", "event", false);
			const request = event.request;
			const correlation: ExecutionCorrelation = {
				...operation.correlation,
				toolCallId: request.toolCallId,
			};
			if (
				!this.#capability.toolGateway ||
				event.operationNonce !== handle.operationNonce ||
				handle.operationNonce !== runtimeLimits.value.processNonce ||
				!externalConnectorToolGatewayRequestMatchesExecution(
					request,
					operation.providerId,
					operation.attemptId,
					operation.bindingId,
					operation.bindingEpochId,
					correlation,
				)
			) {
				throw new ExternalConnectorSupervisorError("external_event_invalid", "event", false);
			}
			const consumer = this.#toolGatewayConsumers.get(operation.attemptId);
			if (consumer === undefined) {
				throw new ExternalConnectorSupervisorError("external_event_invalid", "event", false);
			}
			inFlight = this.#toolGatewayInFlight.get(operation.attemptId);
			if (inFlight === undefined) {
				inFlight = new Map<string, string>();
				this.#toolGatewayInFlight.set(operation.attemptId, inFlight);
			}
			if (inFlight.has(request.toolCallId)) {
				throw new ExternalConnectorSupervisorError("external_event_invalid", "event", false);
			}
			inFlight.set(request.toolCallId, event.operationNonce);
			claimed = true;
			let execution = await this.#store.readToolGatewayExecution(operation.attemptId, request.toolCallId);
			if (
				execution !== undefined &&
				canonicalFoundationJson(execution.intent.request) !== canonicalFoundationJson(request)
			) {
				throw new ExternalConnectorSupervisorError("external_event_invalid", "event", false);
			}
			if (execution?.terminal === undefined) {
				if (execution !== undefined) {
					throw new ExternalConnectorSupervisorError("tool_gateway_ambiguous", "event", false);
				}
				const intent: ExternalConnectorToolGatewayIntent = {
					schemaVersion: 1,
					type: EXTERNAL_CONNECTOR_TOOL_GATEWAY_EXECUTION_OBJECT_TYPE,
					id: externalConnectorToolGatewayExchangeId(operation.attemptId, request.toolCallId),
					phase: "intent",
					providerId: operation.providerId,
					attemptId: operation.attemptId,
					bindingId: operation.bindingId,
					bindingEpochId: operation.bindingEpochId,
					correlation,
					request: cloneDeepFrozen(request),
					createdAt: this.#now(),
				};
				const writtenIntent = await this.#store.writeToolGatewayIntent(intent);
				if (!writtenIntent.claimed) {
					execution = await this.#store.readToolGatewayExecution(operation.attemptId, request.toolCallId);
					if (execution?.terminal === undefined) {
						throw new ExternalConnectorSupervisorError("tool_gateway_ambiguous", "event", false);
					}
				} else {
					const gatewayResult = await consumer(request, { signal });
					if (!gatewayResult.ok) {
						if (gatewayResult.error.code === "external_tool_route_denied") {
							throw new ExternalConnectorSupervisorError("external_tool_route_denied", "event", false);
						}
						throw gatewayResult.error;
					}
					const terminal: ExternalConnectorToolGatewayTerminal = {
						schemaVersion: 1,
						type: EXTERNAL_CONNECTOR_TOOL_GATEWAY_EXECUTION_OBJECT_TYPE,
						id: intent.id,
						phase: "terminal",
						providerId: intent.providerId,
						attemptId: intent.attemptId,
						bindingId: intent.bindingId,
						bindingEpochId: intent.bindingEpochId,
						correlation,
						request: intent.request,
						result: gatewayResult.value,
						createdAt: intent.createdAt,
						completedAt: this.#now(),
					};
					execution = {
						intent: writtenIntent.intent,
						terminal: await this.#store.writeToolGatewayTerminal(terminal),
					};
				}
			}
			const terminal = execution?.terminal;
			if (terminal === undefined) {
				throw new ExternalConnectorSupervisorError("tool_gateway_ambiguous", "event", false);
			}
			if (!terminal.result.ok && terminal.result.error?.code === "external_tool_route_denied") {
				throw new ExternalConnectorSupervisorError("external_tool_route_denied", "event", false);
			}
			if (
				inFlight.get(request.toolCallId) !== runtimeLimits.value.processNonce ||
				terminal.result.toolCallId !== request.toolCallId
			) {
				throw new ExternalConnectorSupervisorError("external_event_invalid", "event", false);
			}
			try {
				await this.#driver.write(
					handle,
					{
						schemaVersion: 1,
						kind: "tool_gateway_result",
						operationNonce: runtimeLimits.value.processNonce,
						result: terminal.result,
					},
					{ signal },
				);
			} catch {
				throw new ExternalConnectorSupervisorError("tool_gateway_callback_failed", "event", false);
			}
		} catch (error) {
			if (error instanceof ExternalConnectorSupervisorError) throw error;
			throw new ExternalConnectorSupervisorError("tool_gateway_ambiguous", "event", false);
		} finally {
			if (claimed && inFlight !== undefined) {
				inFlight.delete(event.request.toolCallId);
				if (inFlight.size === 0) this.#toolGatewayInFlight.delete(operation.attemptId);
			}
		}
	}

	async #requirePriorReceipt(attempt: Attempt): Promise<ResultValue<AttemptReceipt | undefined, FoundationError>> {
		const receipt = await this.#store.readReceipt(attempt.attemptId);
		if (receipt === undefined) return Result.ok(undefined);
		const checked = validateAttemptReceiptForProvider(receipt, {
			providerId: this.providerId,
			providerClass: this.providerClass,
		});
		const receiptId = `attempt_receipt_${attempt.attemptId}`;
		if (!checked.ok) {
			return Result.err(
				externalFailure(
					"invalid_correlation",
					"External connector prior receipt is not canonical",
					attempt.attemptId,
				),
			);
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
			return Result.err(
				externalFailure(
					"invalid_correlation",
					"External connector prior receipt does not match its Attempt",
					attempt.attemptId,
				),
			);
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
				return Result.err(
					externalFailure(
						"invalid_correlation",
						"External connector operation does not match its canonical receipt",
						attempt.attemptId,
					),
				);
			}
			this.#releaseCredential(
				operation,
				credentialReasonForTerminal(checked.value.status, checked.value.error?.code),
			);
			if (operation.status === "terminal") {
				if (operation.receiptId !== receiptId) {
					return Result.err(
						externalFailure(
							"invalid_correlation",
							"External connector terminal operation references a different receipt",
							attempt.attemptId,
						),
					);
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
			return Result.err(
				externalFailure(
					"invalid_correlation",
					"External connector requires the exact durable Attempt",
					attempt.attemptId,
				),
			);
		}
		return Result.ok(durable);
	}

	async #requireBinding(attempt: Attempt): Promise<ResultValue<AgentBinding, FoundationError>> {
		const binding = await this.#store.readBinding(attempt.bindingId);
		if (binding === undefined || binding.taskId !== attempt.taskId) {
			return Result.err(
				externalFailure(
					"binding_required_fact",
					"External connector requires the durable AgentBinding",
					attempt.attemptId,
				),
			);
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
			return Result.err(
				externalFailure(
					"invalid_correlation",
					"External connector execution correlation is invalid",
					attempt.attemptId,
				),
			);
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
		const validated = validateExecutionCorrelation(canonical);
		return validated.ok
			? Result.ok(validated.value)
			: Result.err(
					externalFailure(
						"invalid_correlation",
						"External connector execution correlation is invalid",
						attempt.attemptId,
					),
				);
	}

	async #requireFrozenFacts(
		sourceOperation: ExternalConnectorOperation,
		attempt: Attempt,
		binding: AgentBinding,
	): Promise<ResultValue<RuntimeLimitsOperationNonce, FoundationError>> {
		let operation: ExternalConnectorOperation;
		try {
			operation = cloneExternalConnectorOperation(sourceOperation);
		} catch {
			return Result.err(
				externalFailure(
					"invalid_correlation",
					"External connector durable operation is invalid",
					attempt.attemptId,
				),
			);
		}
		const runtimeLimits = this.#decodeOperationRuntimeLimits(operation);
		if (!runtimeLimits.ok) {
			await this.#markReconcile(operation, "capability_drift");
			return runtimeLimits;
		}
		if (
			operation.providerId !== this.providerId ||
			operation.attemptId !== attempt.attemptId ||
			operation.bindingId !== attempt.bindingId ||
			operation.bindingEpochId !== attempt.bindingEpochIds[0] ||
			operation.bindingId !== binding.bindingId ||
			operation.bindingRevision !== binding.contextRevision.revision ||
			!sameFingerprint(operation.bindingDigest, binding.fingerprint) ||
			operation.correlation.taskId !== attempt.taskId ||
			operation.correlation.dispatchId !== attempt.dispatchId ||
			operation.correlation.attemptId !== attempt.attemptId ||
			operation.correlation.bindingId !== attempt.bindingId ||
			operation.correlation.bindingEpochId !== attempt.bindingEpochIds[0] ||
			operation.correlation.providerId !== this.providerId ||
			operation.correlation.agentInstanceId !== undefined ||
			(operation.credentialRequirement !== undefined &&
				(operation.credentialRequirement.capabilityBindingId !== binding.capabilityRevision.id ||
					operation.credentialRequirement.policyBindingId !== binding.policyRevision.id))
		) {
			await this.#markReconcile(operation, "binding_drift");
			return Result.err(
				externalFailure(
					"external_binding_invalid",
					"External connector binding drift requires reconciliation",
					operation.attemptId,
				),
			);
		}
		if (
			operation.capabilityRevision !== this.#capability.revision ||
			!sameFingerprint(operation.capabilityDigest, this.#capability.digest)
		) {
			await this.#markReconcile(operation, "capability_drift");
			return Result.err(
				externalFailure(
					"external_capability_mismatch",
					"External connector capability drift requires reconciliation",
					operation.attemptId,
				),
			);
		}
		return runtimeLimits;
	}

	async #requireMapping(
		operation: ExternalConnectorOperation,
	): Promise<ResultValue<CanonicalExternalConnectorMapping, FoundationError>> {
		const runtimeLimits = this.#decodeOperationRuntimeLimits(operation);
		if (!runtimeLimits.ok) {
			await this.#markReconcile(operation, "capability_drift");
			return runtimeLimits;
		}
		const mapping = await this.#store.readMapping(operation.attemptId);
		if (mapping === undefined) {
			await this.#markReconcile(operation, "mapping_missing");
			await this.#recoverSupervisorWithoutMapping(operation);
			return Result.err(
				externalFailure(
					"side_effect_unknown",
					"External connector durable mapping is missing",
					operation.attemptId,
				),
			);
		}
		if (
			mapping.providerId !== operation.providerId ||
			mapping.attemptId !== operation.attemptId ||
			mapping.binding.revision !== operation.bindingRevision ||
			!sameFingerprint(mapping.binding.digest, operation.bindingDigest) ||
			mapping.capability.revision !== operation.capabilityRevision ||
			!sameFingerprint(mapping.capability.digest, operation.capabilityDigest) ||
			mapping.supervisor.nonce !== runtimeLimits.value.processNonce
		) {
			await this.#markReconcile(operation, "mapping_conflict");
			return Result.err(
				externalFailure(
					"external_mapping_conflict",
					"External connector durable mapping conflicts with its Attempt",
					operation.attemptId,
				),
			);
		}
		return Result.ok(mapping);
	}

	async #markReconcile(
		operation: ExternalConnectorOperation,
		reason: ExternalConnectorReconcileReason,
	): Promise<void> {
		this.#releaseCredential(operation, "run_interrupted");
		if (
			operation.status === "terminal" ||
			(operation.status === "reconcile_required" && operation.reconcileReason === reason)
		)
			return;
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
		sourceEvidence: ExternalConnectorTerminalEvidence,
	): Promise<ResultValue<AttemptReceipt, FoundationError>> {
		const priorReceipt = await this.#requirePriorReceipt(attempt);
		if (!priorReceipt.ok) return priorReceipt;
		if (priorReceipt.value !== undefined) {
			this.#attemptRuntimeLimits.delete(attempt.attemptId);
			return Result.ok(priorReceipt.value);
		}
		if (operation.status === "terminal") {
			return Result.err(
				externalFailure(
					"scheduler_attempt_recovery_failed",
					"External connector operation is already terminal",
					attempt.attemptId,
				),
			);
		}
		const runtimeLimits = this.#decodeOperationRuntimeLimits(operation);
		if (!runtimeLimits.ok) {
			await this.#markReconcile(operation, "capability_drift");
			return runtimeLimits;
		}
		let evidence: ExternalConnectorTerminalEvidence;
		try {
			evidence = cloneExternalConnectorTerminalEvidence(sourceEvidence);
		} catch {
			await this.#markReconcile(operation, "mapping_conflict");
			return Result.err(
				externalFailure(
					"side_effect_unknown",
					"External connector terminal evidence is invalid",
					attempt.attemptId,
				),
			);
		}
		if (
			evidence.externalSessionId !== mapping.externalSessionId ||
			(evidence.externalTurnId ?? undefined) !== (mapping.externalTurnId ?? undefined) ||
			evidence.operationNonce !== runtimeLimits.value.processNonce ||
			evidence.operationNonce !== mapping.supervisor.nonce
		) {
			await this.#markReconcile(operation, "mapping_conflict");
			return Result.err(
				externalFailure(
					"side_effect_unknown",
					"External connector terminal evidence conflicts with its durable mapping",
					attempt.attemptId,
				),
			);
		}
		this.#releaseCredential(
			operation,
			credentialReasonForTerminal(evidence.status, evidence.error?.code),
		);
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
			...(evidence.usage === undefined ? {} : { usage: evidence.usage }),
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
		await this.#store.writeOperation(
			transitionExternalConnectorOperation(operation, "terminal", {
				now: this.#now(),
				receiptId: persisted.attemptReceiptId,
			}),
		);
		this.#pendingCancellations.delete(attempt.attemptId);
		this.#attemptRuntimeLimits.delete(attempt.attemptId);
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
		const checked = validateAttemptReceiptForProvider(
			{
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
				...(deadline
					? {
							error: {
								code: "run_deadline_exceeded",
								message: "External connector run deadline was exceeded.",
								category: "deadline" as const,
								retryable: false,
							},
						}
					: {}),
				provenance: {
					producerKind: "external_connector",
					providerId: this.providerId,
					producedAt: this.#now(),
					correlation: { ...correlation, attemptReceiptId: receiptId },
				},
				sideEffectState: "none",
			},
			{
				providerId: this.providerId,
				providerClass: this.providerClass,
			},
		);
		if (!checked.ok) return checked;
		this.#releaseCredential(
			operation,
			deadline ? "run_deadline_exceeded" : "run_cancelled",
		);
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
		this.#attemptRuntimeLimits.delete(attempt.attemptId);
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
		const checked = validateAttemptReceiptForProvider(
			{
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
					category: deadline ? ("deadline" as const) : ("side_effect_unknown" as const),
					retryable: false,
				},
				provenance: {
					producerKind: "external_connector",
					providerId: this.providerId,
					producedAt: this.#now(),
					correlation: { ...correlation, attemptReceiptId: receiptId },
				},
				sideEffectState: "unknown",
			},
			{
				providerId: this.providerId,
				providerClass: this.providerClass,
			},
		);
		if (!checked.ok) return checked;
		this.#releaseCredential(
			operation,
			deadline ? "run_deadline_exceeded" : "run_failed",
		);
		const persisted = await this.#store.writeReceipt(checked.value);
		await this.#store.writeOperation(
			transitionExternalConnectorOperation(operation, "terminal", {
				now: this.#now(),
				receiptId: persisted.attemptReceiptId,
			}),
		);
		this.#attemptRuntimeLimits.delete(attempt.attemptId);
		return Result.ok(persisted);
	}

	async #settleRecoveryFailure(
		attempt: Attempt,
		error: FoundationError,
	): Promise<ResultValue<AttemptReceipt, FoundationError>> {
		const durable = await this.#requireDurableAttempt(attempt);
		if (!durable.ok) return durable;
		const priorReceipt = await this.#requirePriorReceipt(attempt);
		if (!priorReceipt.ok) return priorReceipt;
		if (priorReceipt.value !== undefined) {
			this.#attemptRuntimeLimits.delete(attempt.attemptId);
			return Result.ok(priorReceipt.value);
		}
		const operation = await this.#store.readOperation(attempt.attemptId);
		if (operation === undefined || operation.status === "terminal") {
			return Result.err(
				externalFailure(
					"scheduler_attempt_recovery_failed",
					"External connector recovery failure requires a non-terminal durable operation",
					attempt.attemptId,
				),
			);
		}
		const receiptId = `attempt_receipt_${attempt.attemptId}`;
		const checked = validateAttemptReceiptForProvider(
			{
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
				error: error.toPublicExecutionError(),
				provenance: {
					producerKind: "external_connector",
					providerId: this.providerId,
					producedAt: this.#now(),
					correlation: { ...operation.correlation, attemptReceiptId: receiptId },
				},
				sideEffectState: "unknown",
			},
			{ providerId: this.providerId, providerClass: this.providerClass },
		);
		if (!checked.ok) return checked;
		this.#releaseCredential(operation, "run_failed");
		const persisted = await this.#store.writeReceipt(checked.value);
		await this.#store.writeOperation(
			transitionExternalConnectorOperation(operation, "terminal", {
				now: this.#now(),
				receiptId: persisted.attemptReceiptId,
			}),
		);
		this.#attemptRuntimeLimits.delete(attempt.attemptId);
		return Result.ok(persisted);
	}
}

const DURABLE_EXTERNAL_AGENT_CONNECTOR_METHODS = Object.freeze({
	preflightModelProjection: DurableExternalAgentConnector.prototype.preflightModelProjection,
	bindToolGatewayConsumer: DurableExternalAgentConnector.prototype.bindToolGatewayConsumer,
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
	HOST_SUPERVISED_RECOVERY_FAILURE_SETTLERS.set(connector, (attempt, error) =>
		connector.settleRecoveryFailure(attempt, error),
	);
	return connector;
}
