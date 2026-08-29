/**
 * Scheduler v1 dispatch controller (T4).
 *
 * After a durable claim this module assembles DispatchV1, the immutable
 * AgentBindingV1 / initial BindingEpochV1, and a complete ExecutionCorrelationV1,
 * selects the exact registry provider/fact, and consumes
 * LayeredResultSettlementV1.startDispatch/executeDispatch/resumeDispatch/cancelAttempt
 * as the only execution and persistence boundary. Queue
 * SchedulerDispatchRecordV1 prepared -> in_flight is persisted through
 * SchedulerQueueStore.markDispatched in beforeRunAttempt, before provider
 * side effects. Crash recovery reloads in_flight and supplies the durable
 * Attempt on the settlement resume surface; a provider that cannot resume
 * fails closed with no fabricated success or Host fallback. Cancel, deadline,
 * claim-expiry, handoff rejection, and deadlock cancellation converge on
 * provider cancelAttempt via the settlement cancel surface. Quota reserve/settle
 * remains the T3 in-process provider path. This module does not tick, scan
 * Task Graph, write TaskResult/RunReceipt, or register a production Scheduler.
 */
import {
	type AgentBinding,
	type AgentInstance,
	type Attempt,
	type AttemptReceipt,
	type BindingEpoch,
	type Budget,
	type ConnectorCapabilitySnapshot,
	createBindingEpoch,
	createConnectorCapabilitySnapshot,
	createExecutionCorrelation,
	type Dispatch,
	type DispatchExecutionResult,
	type DispatchStartResult,
	type ExecutionCorrelation,
	type Fingerprint,
	FoundationError,
	type FoundationProviderCapability,
	type FoundationProviderExecutionOptions,
	fingerprintFoundationValue,
	LayeredResultSettlement,
	type QuotaProvider,
	Result,
	type Result as ResultValue,
	type Session,
	type TaskExecutorProvider,
	validateAgentInstance,
	validateAttempt,
	validateBindingEpoch,
	validateDispatch,
	validateExecutionCorrelation,
	validateImmutableAgentBinding,
} from "@aos-agent/agent-core";
import {
	RUN_LEDGER_CUSTOM_TYPE,
	type RunId,
	type RunLedgerSession,
	type RunSchedulerLifecycleHooks,
	registerRunSchedulerLifecycleHooks,
} from "./run-lifecycle.ts";
import { type RuntimeClock, type RuntimeTimerHandle, runtimeClockFor } from "./runtime-clock.ts";
import {
	assertSchedulerFencingToken,
	parseSchedulerClaim,
	parseSchedulerDispatchRecord,
	parseSchedulerQueueEntry,
	SCHEDULER_ERROR_CODES,
	type SchedulerClaimV1,
	type SchedulerDispatchRecordV1,
	type SchedulerErrorCodeV1,
	type SchedulerExecutorEntryV1,
	type SchedulerProviderClassV1,
	type SchedulerQueueEntryV1,
	type SchedulerSelectionFactV1,
} from "./scheduler.ts";
import {
	createSchedulerExecutorRuntimeSnapshotV1,
	SCHEDULER_IN_PROCESS_CAPABILITY_ID,
	SCHEDULER_IN_PROCESS_PROVIDER_ID,
	type SchedulerExecutorRegistry,
	type SchedulerExecutorRuntimeSnapshotV1,
	type SchedulerHostAttemptRunnerV1,
	SchedulerInProcessTaskExecutorProvider,
} from "./scheduler-executors.ts";
import type { SchedulerCancelAttemptV1, SchedulerQueueStore } from "./scheduler-queue.ts";
import type { SchedulerSelectionSettlementReasonV1 } from "./scheduler-selection-reservations.ts";

const ERROR_MESSAGES: Readonly<Record<SchedulerErrorCodeV1, string>> = {
	scheduler_queue_invalid: "Scheduler queue entry is invalid.",
	scheduler_queue_conflict: "Scheduler queue business key already has a different payload.",
	scheduler_claim_conflict: "Scheduler claim conflict: the task already has an active claim.",
	scheduler_claim_expired: "Scheduler claim lease is expired.",
	scheduler_lease_lost: "Scheduler fencing token is not the current claim token.",
	scheduler_no_executor: "No eligible scheduler executor is available.",
	scheduler_executor_unavailable: "The selected scheduler executor is unavailable.",
	scheduler_budget_exhausted_wait: "Scheduler concurrency or quota is exhausted; keep the entry queued.",
	scheduler_dispatch_invalid: "Scheduler dispatch record is invalid.",
	scheduler_attempt_recovery_failed: "Scheduler existing-attempt recovery failed.",
	scheduler_fanin_invalid: "Scheduler join input is invalid.",
	scheduler_settlement_rejected: "Scheduler settlement was rejected by the host gate.",
	scheduler_handoff_invalid: "Scheduler ownership transfer is invalid.",
	scheduler_handoff_timeout: "Scheduler ownership transfer timed out.",
	scheduler_handoff_target_unavailable: "Scheduler handoff target is unavailable.",
	scheduler_message_invalid: "Scheduler message is invalid or carries forbidden content.",
	scheduler_message_timeout: "Scheduler message acknowledgment timed out.",
	scheduler_wake_invalid: "Scheduler wake fact is invalid.",
	scheduler_deadlock_detected: "Scheduler wait-for cycle was detected.",
	scheduler_backpressure: "Scheduler queue or concurrency limit is exceeded.",
	scheduler_not_found: "Scheduler record was not found.",
	scheduler_persistence_failed: "Scheduler durable append failed; re-read current state.",
};

const RETRYABLE = new Set<SchedulerErrorCodeV1>([
	"scheduler_claim_conflict",
	"scheduler_budget_exhausted_wait",
	"scheduler_backpressure",
]);

export interface SchedulerDispatchControllerOptionsV1 {
	readonly session: Session;
	readonly queue: SchedulerQueueStore;
	readonly registry: SchedulerExecutorRegistry;
	readonly sessionId: string;
	readonly ownerId: string;
	/**
	 * Session-owned Run ledger used to register the Scheduler lifecycle observer.
	 * Omission preserves the existing default-off Scheduler composition.
	 */
	readonly runLifecycleSession?: RunLedgerSession;
	/** The production composition owns the one Session hook and forwards it here. */
	readonly runLifecycleHookOwnership?: "dispatch" | "host";
	readonly laneId?: string;
	readonly now?: () => string;
	readonly requiredCapabilities?: readonly FoundationProviderCapability[];
	readonly workspaceDigest?: Fingerprint;
	/** Explicit trusted Native Subagent bridge. Omission keeps agent providers unavailable. */
	readonly nativeAgentBridge?: SchedulerNativeAgentBridgeV1;
}

export interface SchedulerDispatchRequestV1 {
	readonly queueEntryId: string;
	readonly fencingToken: string;
	readonly binding: AgentBinding;
	readonly requiredCapabilities?: readonly FoundationProviderCapability[];
	readonly workspaceDigest?: Fingerprint;
	/** Explicit exact requirements activate durable selection; omission preserves the legacy path. */
	readonly executorRequirements?: SchedulerDispatchExecutorRequirementsV1;
	readonly signal?: AbortSignal;
}

export interface SchedulerDispatchExecutorRequirementsV1 {
	readonly requireResume: boolean;
	readonly modelAccess: ConnectorCapabilitySnapshot["modelAccess"];
	readonly reviewRevision?: Fingerprint;
	readonly credentialTargetRefs?: readonly string[];
	readonly sandboxTargetRefs?: readonly string[];
}

/**
 * T5/T9 composition input: attach one claimed Scheduler dispatch to a durable
 * Run in the same Session before provider execution starts.
 */
export interface SchedulerRunDispatchRequestV1 extends SchedulerDispatchRequestV1 {
	readonly runId: RunId;
}

export interface SchedulerDispatchAssemblyInputV1 {
	readonly entry: SchedulerQueueEntryV1;
	readonly claim: SchedulerClaimV1;
	readonly binding: AgentBinding;
	readonly providerId: string;
	readonly providerClass: SchedulerProviderClassV1;
	readonly sessionId: string;
	readonly laneId: string;
	readonly now: string;
	readonly nativeAgent?: SchedulerNativeAgentResolutionV1;
}

export interface SchedulerDispatchAssemblyV1 {
	readonly dispatch: Dispatch;
	readonly initialBindingEpoch: BindingEpoch;
	readonly correlation: ExecutionCorrelation;
	readonly dispatchId: string;
	readonly attemptId: string;
	readonly bindingEpochId: string;
	readonly agentInstance?: AgentInstance;
	readonly agentInstanceId?: string;
}

export interface SchedulerNativeAgentResolveInputV1 {
	readonly schemaVersion: 1;
	readonly provider: TaskExecutorProvider;
	readonly entry: SchedulerQueueEntryV1;
	readonly claim: SchedulerClaimV1;
	readonly binding: AgentBinding;
	readonly sessionId: string;
	readonly dispatchId: string;
	readonly attemptId: string;
	readonly bindingEpochId: string;
	readonly agentInstanceId: string;
	readonly laneId: string;
	readonly spawnId: string;
	readonly activatedByCommandId: string;
	readonly now: string;
	readonly signal?: AbortSignal;
}

export interface SchedulerNativeAgentResolutionV1 {
	readonly schemaVersion: 1;
	readonly providerId: string;
	readonly dispatch: Dispatch;
	readonly agentInstance: AgentInstance;
	readonly initialBindingEpoch: BindingEpoch;
	readonly correlation: ExecutionCorrelation;
}

export interface SchedulerNativeAgentRevalidateInputV1 {
	readonly schemaVersion: 1;
	readonly provider: TaskExecutorProvider;
	readonly binding: AgentBinding;
	readonly resolution: SchedulerNativeAgentResolutionV1;
	readonly signal?: AbortSignal;
}

/** Trusted product bridge from Scheduler selection to the Native Subagent owner. */
export interface SchedulerNativeAgentBridgeV1 {
	resolve(
		input: SchedulerNativeAgentResolveInputV1,
	): Promise<ResultValue<SchedulerNativeAgentResolutionV1, FoundationError>>;
	revalidate(input: SchedulerNativeAgentRevalidateInputV1): Promise<ResultValue<void, FoundationError>>;
}

export interface SchedulerDispatchOutcomeV1 {
	readonly entry: SchedulerQueueEntryV1;
	readonly claim: SchedulerClaimV1;
	readonly dispatchRecord: SchedulerDispatchRecordV1;
	readonly dispatch: Dispatch;
	readonly attempt: Attempt;
	readonly receipt: AttemptReceipt;
	readonly selection: SchedulerSelectionFactV1;
	readonly providerId: string;
	readonly providerClass: SchedulerProviderClassV1;
}

export interface SchedulerInProcessHostBindingOptionsV1 {
	readonly hostAttemptRunner: SchedulerHostAttemptRunnerV1;
	/** Register an inert durable candidate when no exact runtime snapshot exists. */
	readonly allowFailClosedRegistration?: boolean;
	readonly quota?: QuotaProvider;
	readonly now?: () => string;
	readonly budget?: Budget;
	readonly sessionId?: string;
	readonly workspaceDigest?: Fingerprint;
	readonly latencyMs?: number;
	readonly trusted?: boolean;
	readonly runtimeSnapshot?: SchedulerExecutorRuntimeSnapshotV1;
}

interface SchedulerProviderResumeSurfaceV1 extends TaskExecutorProvider {
	readonly resumeAttempt?: (
		attemptId: string,
		options: FoundationProviderExecutionOptions,
	) => Promise<ResultValue<AttemptReceipt, FoundationError>>;
	readonly resume?: (
		attemptId: string,
		options?: { readonly signal?: AbortSignal },
	) => Promise<ResultValue<AttemptReceipt, FoundationError>>;
}

interface SchedulerPreparedDispatchV1 {
	readonly entry: SchedulerQueueEntryV1;
	readonly claim: SchedulerClaimV1;
	readonly selection: {
		readonly fact: SchedulerSelectionFactV1;
		readonly provider: TaskExecutorProvider;
		readonly providerClass: SchedulerProviderClassV1;
		readonly providerId: string;
	};
	readonly assembly: SchedulerDispatchAssemblyV1;
	readonly dispatchRecord: SchedulerDispatchRecordV1 | undefined;
}

interface SchedulerDurableAttemptV1 {
	readonly queueEntryId: string;
	readonly provider: TaskExecutorProvider;
	readonly dispatch: Dispatch;
	readonly binding: AgentBinding;
	readonly initialBindingEpoch: BindingEpoch;
	readonly correlation: ExecutionCorrelation;
	readonly agentInstance?: AgentInstance;
}

interface SchedulerExecutionSignalV1 {
	readonly signal: AbortSignal | undefined;
	dispose(): void;
}

interface SchedulerRunDispatchCancellationV1 {
	readonly runId: RunId;
	readonly queueEntryId: string;
	readonly controller: AbortController;
	attemptId?: string;
	durable: boolean;
	cancel?: () => Promise<ResultValue<void, FoundationError>>;
	cancellation?: Promise<ResultValue<void, FoundationError>>;
}

type SchedulerRunLedgerStateV1 = "live" | "terminal";

function schedulerError(code: SchedulerErrorCodeV1): FoundationError {
	return new FoundationError(code, ERROR_MESSAGES[code], { retryable: RETRYABLE.has(code) });
}

function fail<T>(code: SchedulerErrorCodeV1): ResultValue<T, FoundationError> {
	return Result.err(schedulerError(code));
}

function isSchedulerErrorCode(value: string): value is SchedulerErrorCodeV1 {
	return (SCHEDULER_ERROR_CODES as readonly string[]).includes(value);
}

function inProcessCapability(): FoundationProviderCapability {
	return { schemaVersion: 1, id: SCHEDULER_IN_PROCESS_CAPABILITY_ID, version: 1 };
}

function failClosedInProcessRuntimeSnapshot(
	nowIso: string,
): ResultValue<SchedulerExecutorRuntimeSnapshotV1, FoundationError> {
	const observedAt = Date.parse(nowIso);
	if (!Number.isFinite(observedAt)) {
		return Result.err(new FoundationError("foundation_schema_invalid_shape", "Scheduler clock is invalid."));
	}
	return createSchedulerExecutorRuntimeSnapshotV1({
		schemaVersion: 1,
		capabilitySnapshot: createConnectorCapabilitySnapshot({
			schemaVersion: 1,
			providerId: SCHEDULER_IN_PROCESS_PROVIDER_ID,
			revision: 1,
			protocol: { name: "aos-scheduler-in-process", version: "1" },
			modelAccess: "none",
			resume: false,
			toolGateway: false,
			artifacts: false,
			images: false,
		}),
		configRevision: fingerprintFoundationValue("aos-scheduler-in-process:fail-closed"),
		bindingRequirementDigests: [],
		toolSelectionDigests: [],
		policyRevisionDigests: [],
		reviewRevisionDigests: [],
		credentialTargetRefs: [],
		sandboxTargetRefs: [],
		observedAt: nowIso,
		expiresAt: new Date(observedAt + 24 * 60 * 60 * 1_000).toISOString(),
	});
}

/** True when the selected provider exposes the settlement resume surface. */
export function schedulerProviderResumeSupportedV1(provider: TaskExecutorProvider): boolean {
	const surface: SchedulerProviderResumeSurfaceV1 = provider;
	return typeof surface.resumeAttempt === "function" || typeof surface.resume === "function";
}

export function schedulerDispatchIdentityV1(
	queueEntryId: string,
	claimId: string,
): {
	readonly dispatchId: string;
	readonly attemptId: string;
	readonly bindingEpochId: string;
	readonly agentInstanceId: string;
	readonly laneId: string;
	readonly spawnId: string;
	readonly commandId: string;
} {
	const digest = fingerprintFoundationValue({ schemaVersion: 1, queueEntryId, claimId }).value;
	const spawnId = `spawn_${digest}`;
	return {
		dispatchId: `dispatch_${digest}`,
		attemptId: `attempt_${digest}`,
		bindingEpochId: `epoch_${digest}`,
		agentInstanceId: `agent_${digest}`,
		laneId: `lane_${digest}`,
		spawnId,
		commandId: `command:${spawnId}`,
	};
}

/**
 * Deterministically assemble DispatchV1, the initial BindingEpochV1, and a
 * complete ExecutionCorrelationV1. deadlineAt is copied from the queue entry
 * onto DispatchV1. Non-agent epochs never carry an AgentInstance.
 */
export function assembleSchedulerDispatchV1(
	input: SchedulerDispatchAssemblyInputV1,
): ResultValue<SchedulerDispatchAssemblyV1, FoundationError> {
	const parsedEntry = parseSchedulerQueueEntry(input.entry);
	if (!parsedEntry.ok) return parsedEntry;
	const parsedClaim = parseSchedulerClaim(input.claim);
	if (!parsedClaim.ok) return parsedClaim;
	const checkedBinding = validateImmutableAgentBinding(input.binding);
	if (!checkedBinding.ok) return checkedBinding;
	const entry = parsedEntry.value;
	const claim = parsedClaim.value;
	const binding = checkedBinding.value;
	if (entry.sessionId !== input.sessionId) return fail("scheduler_queue_invalid");
	if (claim.queueEntryId !== entry.queueEntryId || claim.taskId !== entry.taskId)
		return fail("scheduler_queue_invalid");
	if (binding.taskId !== entry.taskId) {
		return Result.err(
			new FoundationError("binding_task_before_binding", "Binding references a different durable TaskEnvelope", {
				details: { bindingId: binding.bindingId, taskId: entry.taskId },
			}),
		);
	}
	if (entry.goalId !== undefined && binding.goalId !== entry.goalId) {
		return Result.err(
			new FoundationError("invalid_correlation", "Scheduler queue goal does not match its immutable Binding", {
				details: { bindingId: binding.bindingId, goalId: entry.goalId },
			}),
		);
	}
	if (entry.state !== "claimed" && entry.state !== "dispatched") return fail("scheduler_queue_invalid");
	if (entry.claimId !== claim.claimId) return fail("scheduler_claim_conflict");
	const ids = schedulerDispatchIdentityV1(entry.queueEntryId, claim.claimId);
	const dispatchCandidate: Dispatch = {
		schemaVersion: 1,
		dispatchId: ids.dispatchId,
		taskId: entry.taskId,
		bindingId: binding.bindingId,
		taskExecutorProviderId: input.providerId,
		status: "pending",
		createdAt: input.now,
		...(entry.deadlineAt === undefined ? {} : { deadlineAt: entry.deadlineAt }),
	};
	const checkedDispatch = validateDispatch(dispatchCandidate);
	if (!checkedDispatch.ok) return checkedDispatch;
	if (input.providerClass === "agent") {
		const nativeAgent = input.nativeAgent;
		if (nativeAgent === undefined) {
			return Result.err(
				new FoundationError(
					"agent_instance_required_for_agent_provider",
					"Scheduler agent dispatch requires the trusted Native Subagent bridge",
					{ details: { providerId: input.providerId } },
				),
			);
		}
		const nativeDispatch = validateDispatch(nativeAgent.dispatch);
		const nativeInstance = validateAgentInstance(nativeAgent.agentInstance);
		const nativeEpoch = validateBindingEpoch(nativeAgent.initialBindingEpoch);
		const nativeCorrelation = validateExecutionCorrelation(nativeAgent.correlation);
		if (!nativeDispatch.ok || !nativeInstance.ok || !nativeEpoch.ok || !nativeCorrelation.ok) {
			return Result.err(
				new FoundationError("invalid_correlation", "Native Scheduler bridge returned invalid Foundation identity"),
			);
		}
		if (
			nativeAgent.schemaVersion !== 1 ||
			nativeAgent.providerId !== input.providerId ||
			nativeDispatch.value.dispatchId !== ids.dispatchId ||
			nativeDispatch.value.taskId !== entry.taskId ||
			nativeDispatch.value.bindingId !== binding.bindingId ||
			nativeDispatch.value.taskExecutorProviderId !== input.providerId ||
			nativeDispatch.value.status !== "pending" ||
			nativeDispatch.value.deadlineAt !== entry.deadlineAt ||
			nativeInstance.value.agentInstanceId !== ids.agentInstanceId ||
			nativeInstance.value.providerId !== input.providerId ||
			nativeInstance.value.taskId !== entry.taskId ||
			nativeInstance.value.roleRevision.id !== binding.roleRevision.id ||
			nativeInstance.value.roleRevision.revision !== binding.roleRevision.revision ||
			nativeEpoch.value.bindingEpochId !== ids.bindingEpochId ||
			nativeEpoch.value.taskId !== entry.taskId ||
			nativeEpoch.value.attemptId !== ids.attemptId ||
			nativeEpoch.value.agentInstanceId !== ids.agentInstanceId ||
			nativeEpoch.value.bindingId !== binding.bindingId ||
			nativeEpoch.value.ordinal !== 0 ||
			nativeEpoch.value.activationReason !== "attempt_started" ||
			nativeEpoch.value.activatedByCommandId !== ids.commandId ||
			nativeCorrelation.value.sessionId !== input.sessionId ||
			nativeCorrelation.value.laneId !== input.laneId ||
			nativeCorrelation.value.taskId !== entry.taskId ||
			nativeCorrelation.value.dispatchId !== ids.dispatchId ||
			nativeCorrelation.value.attemptId !== ids.attemptId ||
			nativeCorrelation.value.bindingId !== binding.bindingId ||
			nativeCorrelation.value.bindingEpochId !== ids.bindingEpochId ||
			nativeCorrelation.value.agentInstanceId !== ids.agentInstanceId ||
			nativeCorrelation.value.providerId !== input.providerId ||
			nativeCorrelation.value.parentId !== nativeInstance.value.lineage.parentId ||
			JSON.stringify(nativeCorrelation.value.ancestorIds ?? []) !==
				JSON.stringify(nativeInstance.value.lineage.ancestorIds ?? [])
		) {
			return Result.err(
				new FoundationError(
					"invalid_correlation",
					"Native Scheduler bridge identity does not match the selected provider and deterministic dispatch",
					{ details: { providerId: input.providerId, dispatchId: ids.dispatchId } },
				),
			);
		}
		return Result.ok({
			dispatch: nativeDispatch.value,
			initialBindingEpoch: nativeEpoch.value,
			correlation: nativeCorrelation.value,
			dispatchId: ids.dispatchId,
			attemptId: ids.attemptId,
			bindingEpochId: ids.bindingEpochId,
			agentInstance: nativeInstance.value,
			agentInstanceId: ids.agentInstanceId,
		});
	}
	if (input.nativeAgent !== undefined) {
		return Result.err(
			new FoundationError(
				"agent_instance_forbidden_for_provider",
				"Non-agent Scheduler dispatch cannot carry a Native Agent resolution",
				{ details: { providerId: input.providerId } },
			),
		);
	}
	const epoch = createBindingEpoch({
		bindingEpochId: ids.bindingEpochId,
		taskId: entry.taskId,
		attemptId: ids.attemptId,
		bindingId: binding.bindingId,
		activationReason: "attempt_started",
		activatedByCommandId: ids.commandId,
		now: () => input.now,
	});
	if (!epoch.ok) return epoch;
	if (epoch.value.agentInstanceId !== undefined) {
		return Result.err(
			new FoundationError(
				"agent_instance_forbidden_for_provider",
				"Non-agent provider dispatch cannot carry an AgentInstance",
				{
					details: { providerId: input.providerId },
				},
			),
		);
	}
	const correlation = createExecutionCorrelation(input.sessionId, input.laneId, {
		revision: 1,
		roleRevisionId: binding.roleRevision.id,
		modelProfileId: binding.modelProfileRevision.id,
		modelProfileRevisionId: binding.modelProfileRevision.id,
		taskId: entry.taskId,
		dispatchId: ids.dispatchId,
		attemptId: ids.attemptId,
		bindingId: binding.bindingId,
		bindingEpochId: ids.bindingEpochId,
		providerId: input.providerId,
		...(entry.goalId === undefined && binding.goalId === undefined ? {} : { goalId: entry.goalId ?? binding.goalId }),
	});
	if (correlation.agentInstanceId !== undefined) {
		return Result.err(
			new FoundationError(
				"agent_instance_forbidden_for_provider",
				"Non-agent provider dispatch cannot carry an AgentInstance",
				{
					details: { providerId: input.providerId },
				},
			),
		);
	}
	return Result.ok({
		dispatch: checkedDispatch.value,
		initialBindingEpoch: epoch.value,
		correlation,
		dispatchId: ids.dispatchId,
		attemptId: ids.attemptId,
		bindingEpochId: ids.bindingEpochId,
	});
}

function schedulerExecutionSignal(
	deadlineAt: string | undefined,
	nowIso: string,
	parent: AbortSignal | undefined,
	clock: RuntimeClock,
): SchedulerExecutionSignalV1 {
	if (deadlineAt === undefined) return { signal: parent, dispose() {} };
	const controller = new AbortController();
	let remainingMs = Date.parse(deadlineAt) - Date.parse(nowIso);
	let timeout: RuntimeTimerHandle | undefined;
	const abortFromParent = (): void => {
		controller.abort(parent?.reason);
	};
	const schedule = (): void => {
		if (remainingMs <= 0) {
			controller.abort(new FoundationError("scheduler_claim_expired", "Scheduler dispatch deadline expired"));
			return;
		}
		const delayMs = Math.min(remainingMs, 2_147_483_647);
		timeout = clock.setTimeout(() => {
			remainingMs -= delayMs;
			schedule();
		}, delayMs);
		clock.unrefTimeout(timeout);
	};
	if (parent?.aborted === true) abortFromParent();
	else parent?.addEventListener("abort", abortFromParent, { once: true });
	if (!controller.signal.aborted) schedule();
	return {
		signal: controller.signal,
		dispose() {
			if (timeout !== undefined) clock.clearTimeout(timeout);
			parent?.removeEventListener("abort", abortFromParent);
		},
	};
}

function schedulerRunLedgerStateV1(
	session: RunLedgerSession,
	sessionId: string,
	runId: RunId,
): SchedulerRunLedgerStateV1 | undefined {
	let accepted = false;
	let terminal = false;
	for (const entry of session.getEntries()) {
		if (entry.type !== "custom" || entry.customType !== RUN_LEDGER_CUSTOM_TYPE) continue;
		if (typeof entry.data !== "object" || entry.data === null || Array.isArray(entry.data)) continue;
		const fact = entry.data as Record<string, unknown>;
		if (fact.schemaVersion !== 1) continue;
		if (fact.kind === "accepted") {
			if (typeof fact.record !== "object" || fact.record === null || Array.isArray(fact.record)) continue;
			const record = fact.record as Record<string, unknown>;
			if (record.id !== runId) continue;
			if (record.sessionId !== sessionId) return undefined;
			accepted = true;
		} else if (fact.kind === "terminal") {
			if (typeof fact.receipt !== "object" || fact.receipt === null || Array.isArray(fact.receipt)) continue;
			const receipt = fact.receipt as Record<string, unknown>;
			if (receipt.runId !== runId) continue;
			if (receipt.sessionId !== sessionId) return undefined;
			terminal = true;
		}
	}
	if (!accepted) return undefined;
	return terminal ? "terminal" : "live";
}

function schedulerRunDispatchSignalV1(requestSignal: AbortSignal | undefined, runSignal: AbortSignal): AbortSignal {
	return requestSignal === undefined ? runSignal : AbortSignal.any([requestSignal, runSignal]);
}

function schedulerSelectionFailureReasonV1(
	error: FoundationError,
	signal: AbortSignal | undefined,
	deadlineAt: string | undefined,
	nowIso: string,
): SchedulerSelectionSettlementReasonV1 {
	const details = error.details;
	if (
		details !== null &&
		typeof details === "object" &&
		!Array.isArray(details) &&
		(details as { schedulerFailure?: unknown }).schedulerFailure === "runner_throw"
	) {
		return "runner_throw";
	}
	if (signal?.aborted === true) {
		if (
			(signal.reason instanceof FoundationError && signal.reason.code === "scheduler_claim_expired") ||
			(deadlineAt !== undefined && Date.parse(deadlineAt) <= Date.parse(nowIso))
		) {
			return "timeout";
		}
		return "cancelled";
	}
	if (
		error.code === "scheduler_persistence_failed" ||
		error.code === "session_transition_failed" ||
		error.code === "control_state_write_failed" ||
		error.code.startsWith("session_writer_")
	) {
		return "persistence_failure";
	}
	if (
		error.code === "scheduler_settlement_rejected" ||
		error.code === "external_review_rejected" ||
		error.code === "external_review_required" ||
		error.code === "external_tool_route_denied"
	) {
		return "rejected";
	}
	return "failed";
}

function schedulerSelectionOutcomeReasonV1(receipt: AttemptReceipt): SchedulerSelectionSettlementReasonV1 | undefined {
	if (receipt.status === "suspended") return undefined;
	if (receipt.status === "succeeded") return "succeeded";
	if (receipt.status === "cancelled") return "cancelled";
	return "failed";
}

/** Bind the in-process TaskExecutor seam. Without a trusted runner, execution remains fail-closed. */
export async function bindSchedulerInProcessTaskExecutorV1(
	registry: SchedulerExecutorRegistry,
	options: SchedulerInProcessHostBindingOptionsV1,
): Promise<ResultValue<SchedulerExecutorEntryV1, FoundationError>> {
	const nowIso = (options.now ?? (() => new Date().toISOString()))();
	const durableSelection = registry.durableSelectionsEnabled();
	let runtimeSnapshot = options.runtimeSnapshot;
	if (durableSelection && runtimeSnapshot === undefined && options.allowFailClosedRegistration === true) {
		const created = failClosedInProcessRuntimeSnapshot(nowIso);
		if (!created.ok) return created;
		runtimeSnapshot = created.value;
	}
	const provider = new SchedulerInProcessTaskExecutorProvider({
		hostAttemptRunner: options.hostAttemptRunner,
		...(options.quota === undefined || durableSelection ? {} : { quota: options.quota }),
		...(options.now === undefined ? {} : { now: options.now }),
		...(options.budget === undefined ? {} : { budget: options.budget }),
	});
	const affinity =
		options.sessionId === undefined && options.workspaceDigest === undefined
			? undefined
			: {
					...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
					...(options.workspaceDigest === undefined ? {} : { workspaceDigest: options.workspaceDigest }),
				};
	return registry.register({
		entry: {
			schemaVersion: 1,
			descriptor: {
				schemaVersion: 1,
				providerId: provider.providerId,
				providerClass: provider.providerClass,
			},
			capabilities: [inProcessCapability()],
			costClass: "local",
			registeredAt: nowIso,
			...(affinity === undefined ? {} : { affinity }),
		},
		provider,
		trusted: options.trusted ?? true,
		latencyMs: options.latencyMs ?? 0,
		...(runtimeSnapshot === undefined ? {} : { runtimeSnapshot }),
		...(durableSelection && options.quota !== undefined ? { quota: options.quota } : {}),
		...(durableSelection && options.quota !== undefined && options.budget !== undefined
			? { budget: options.budget }
			: {}),
	});
}

export class SchedulerDispatchController {
	private readonly session: Session;
	private readonly queue: SchedulerQueueStore;
	private readonly registry: SchedulerExecutorRegistry;
	private readonly settlements = new Map<string, LayeredResultSettlement>();
	private readonly sessionId: string;
	private readonly ownerId: string;
	private readonly runLifecycleSession: RunLedgerSession | undefined;
	private readonly schedulerLifecycleHooks: RunSchedulerLifecycleHooks;
	private readonly unregisterRunLifecycleHooks: (() => void) | undefined;
	private readonly laneId: string;
	private readonly clock: RuntimeClock;
	private readonly nowFn: () => string;
	private readonly requiredCapabilities: readonly FoundationProviderCapability[];
	private readonly workspaceDigest: Fingerprint | undefined;
	private readonly nativeAgentBridge: SchedulerNativeAgentBridgeV1 | undefined;
	private readonly runsRequiringCancellation = new Set<RunId>();
	private readonly runDispatches = new Map<RunId, Set<SchedulerRunDispatchCancellationV1>>();
	private readonly queueRunDispatches = new Map<string, Set<SchedulerRunDispatchCancellationV1>>();
	private readonly attemptRunDispatches = new Map<string, SchedulerRunDispatchCancellationV1>();
	private runLifecycleDisposed = false;

	constructor(options: SchedulerDispatchControllerOptionsV1) {
		this.clock = runtimeClockFor(options);
		this.session = options.session;
		this.queue = options.queue;
		this.registry = options.registry;
		this.ownerId = options.ownerId;
		this.sessionId = options.sessionId;
		if (
			options.runLifecycleSession !== undefined &&
			options.runLifecycleSession.getSessionId() !== options.sessionId
		) {
			throw new FoundationError(
				"service_conflict",
				"Scheduler Run lifecycle observer must own the same Session as the dispatch controller",
			);
		}
		this.runLifecycleSession = options.runLifecycleSession;
		this.schedulerLifecycleHooks = Object.freeze({
			onRunCancelRequested: (runId: RunId) => this.observeRunCancellation(runId),
			onRunDeadlineExceeded: (runId: RunId) => this.observeRunCancellation(runId),
			onRunTerminal: (runId: RunId) => this.observeRunCancellation(runId, true),
		});
		this.unregisterRunLifecycleHooks =
			options.runLifecycleSession === undefined || options.runLifecycleHookOwnership === "host"
				? undefined
				: registerRunSchedulerLifecycleHooks(options.runLifecycleSession, this.schedulerLifecycleHooks);
		this.laneId = options.laneId ?? "main";
		this.nowFn = options.now ?? (() => new Date(this.clock.wallNow()).toISOString());
		this.requiredCapabilities = options.requiredCapabilities ?? [inProcessCapability()];
		this.workspaceDigest = options.workspaceDigest;
		this.nativeAgentBridge = options.nativeAgentBridge;
	}

	runLifecycleHooks(): RunSchedulerLifecycleHooks {
		return this.schedulerLifecycleHooks;
	}

	/** Queue recoverExpired / handoff / deadlock cancel hook. Goes through settlement.cancelAttempt only. */
	queueCancelAttempt(): SchedulerCancelAttemptV1 {
		return (attemptId) => this.cancelAttempt(attemptId);
	}

	/** Release this controller's Session-owned Run observer registration. */
	dispose(): void {
		if (this.runLifecycleDisposed) return;
		this.runLifecycleDisposed = true;
		this.unregisterRunLifecycleHooks?.();
	}

	async dispatchClaimed(
		request: SchedulerDispatchRequestV1,
	): Promise<ResultValue<SchedulerDispatchOutcomeV1, FoundationError>> {
		return this.dispatchClaimedInternal(request);
	}

	/**
	 * Dispatch a claimed queue entry as part of one durable Run. T5/T9 call this
	 * after attach/composition has selected the Run; association never crosses
	 * the controller's Session and is installed before provider execution.
	 */
	async dispatchRunClaimed(
		request: SchedulerRunDispatchRequestV1,
	): Promise<ResultValue<SchedulerDispatchOutcomeV1, FoundationError>> {
		if (this.runLifecycleDisposed || this.runLifecycleSession === undefined) {
			return fail("scheduler_dispatch_invalid");
		}
		try {
			if ((await this.session.getMetadata()).id !== this.sessionId) return fail("scheduler_dispatch_invalid");
		} catch {
			return fail("scheduler_dispatch_invalid");
		}
		let runState: SchedulerRunLedgerStateV1 | undefined;
		try {
			runState = schedulerRunLedgerStateV1(this.runLifecycleSession, this.sessionId, request.runId);
		} catch {
			return fail("scheduler_dispatch_invalid");
		}
		if (runState === undefined) return fail("scheduler_dispatch_invalid");
		const associated = this.createRunDispatchAssociation(request.runId, request.queueEntryId);
		if (!associated.ok) return associated;
		const association = associated.value;
		if (runState === "terminal") {
			this.observeRunCancellation(request.runId, true);
		} else if (this.runsRequiringCancellation.has(request.runId)) {
			this.observeRunCancellation(request.runId);
		}
		const dispatchRequest: SchedulerDispatchRequestV1 = {
			queueEntryId: request.queueEntryId,
			fencingToken: request.fencingToken,
			binding: request.binding,
			...(request.requiredCapabilities === undefined ? {} : { requiredCapabilities: request.requiredCapabilities }),
			...(request.workspaceDigest === undefined ? {} : { workspaceDigest: request.workspaceDigest }),
			...(request.executorRequirements === undefined ? {} : { executorRequirements: request.executorRequirements }),
			signal: schedulerRunDispatchSignalV1(request.signal, association.controller.signal),
		};
		let result: ResultValue<SchedulerDispatchOutcomeV1, FoundationError> | undefined;
		try {
			result = await this.dispatchClaimedInternal(dispatchRequest, association);
			return result;
		} finally {
			if (!association.durable || result?.ok === true) this.releaseRunDispatchAssociation(association);
		}
	}

	private async dispatchClaimedInternal(
		request: SchedulerDispatchRequestV1,
		runAssociation?: SchedulerRunDispatchCancellationV1,
	): Promise<ResultValue<SchedulerDispatchOutcomeV1, FoundationError>> {
		const prepared = await this.prepareClaimed(request);
		if (!prepared.ok) return prepared;
		let result: ResultValue<SchedulerDispatchOutcomeV1, FoundationError>;
		try {
			const dispatchRecord = prepared.value.dispatchRecord;
			if (dispatchRecord?.status === "in_flight") {
				if (prepared.value.entry.state === "claimed") {
					const repaired = await this.queue.markDispatched({
						queueEntryId: prepared.value.entry.queueEntryId,
						fencingToken: prepared.value.claim.fencingToken,
						dispatchId: prepared.value.assembly.dispatchId,
						attemptId: prepared.value.assembly.attemptId,
						providerId: prepared.value.selection.providerId,
						providerClass: prepared.value.selection.providerClass,
					});
					result = repaired.ok
						? await this.resumePrepared(
								request,
								{
									...prepared.value,
									entry: repaired.value.entry,
									claim: repaired.value.claim,
									dispatchRecord: repaired.value.dispatch,
								},
								runAssociation,
							)
						: repaired;
				} else {
					result = await this.resumePrepared(request, prepared.value, runAssociation);
				}
			} else if (prepared.value.entry.state === "dispatched") {
				result = fail("scheduler_dispatch_invalid");
			} else {
				result = await this.executePrepared(request, prepared.value, runAssociation);
			}
		} catch (error) {
			result = Result.err(
				new FoundationError(
					"scheduler_executor_unavailable",
					"Scheduler executor threw outside its Result boundary.",
					{ details: { schedulerFailure: "runner_throw" }, cause: error },
				),
			);
		}
		const reason = result.ok
			? schedulerSelectionOutcomeReasonV1(result.value.receipt)
			: schedulerSelectionFailureReasonV1(
					result.error,
					request.signal,
					prepared.value.assembly.dispatch.deadlineAt,
					this.nowIso(),
				);
		if (reason === undefined) return result;
		const settled = await this.registry.settleSelection(
			prepared.value.entry.queueEntryId,
			reason,
			result.ok ? (result.value.receipt.usage ?? {}) : {},
		);
		return settled.ok ? result : Result.err(settled.error);
	}

	async cancelAttempt(attemptId: string): Promise<ResultValue<void, FoundationError>> {
		const loaded = await this.loadDurableAttempt(attemptId);
		if (!loaded.ok) return loaded;
		const cancelled = await this.settlementFor(loaded.value.correlation).cancelAttempt({
			provider: loaded.value.provider,
			dispatch: loaded.value.dispatch,
			binding: loaded.value.binding,
			initialBindingEpoch: loaded.value.initialBindingEpoch,
			correlation: loaded.value.correlation,
			...(loaded.value.agentInstance === undefined ? {} : { agentInstance: loaded.value.agentInstance }),
		});
		if (!cancelled.ok) return cancelled;
		const association = this.attemptRunDispatches.get(attemptId);
		if (association !== undefined) this.releaseRunDispatchAssociation(association);
		const settled = await this.registry.settleSelection(loaded.value.queueEntryId, "cancelled", {});
		return settled.ok ? cancelled : Result.err(settled.error);
	}

	async cancelDispatch(queueEntryId: string, fencingToken: string): Promise<ResultValue<void, FoundationError>> {
		const entry = await this.queue.getEntry(queueEntryId);
		if (!entry.ok) return entry;
		if (entry.value.sessionId !== this.sessionId) return fail("scheduler_queue_invalid");
		if (entry.value.claimId === undefined) return fail("scheduler_queue_invalid");
		const claim = await this.queue.getClaim(entry.value.claimId);
		if (!claim.ok) return claim;
		const fenced = assertSchedulerFencingToken(claim.value, fencingToken, this.nowIso());
		if (!fenced.ok) return fenced;
		const live = await this.liveDispatch(queueEntryId);
		if (!live.ok) return live;
		if (live.value === undefined || live.value.attemptId === undefined) return fail("scheduler_not_found");
		return this.cancelAttempt(live.value.attemptId);
	}

	private createRunDispatchAssociation(
		runId: RunId,
		queueEntryId: string,
	): ResultValue<SchedulerRunDispatchCancellationV1, FoundationError> {
		for (const existing of this.queueRunDispatches.get(queueEntryId) ?? []) {
			if (existing.runId !== runId) return fail("scheduler_dispatch_invalid");
		}
		const association: SchedulerRunDispatchCancellationV1 = {
			runId,
			queueEntryId,
			controller: new AbortController(),
			durable: false,
		};
		let runDispatches = this.runDispatches.get(runId);
		if (runDispatches === undefined) {
			runDispatches = new Set();
			this.runDispatches.set(runId, runDispatches);
		}
		runDispatches.add(association);
		let queueDispatches = this.queueRunDispatches.get(queueEntryId);
		if (queueDispatches === undefined) {
			queueDispatches = new Set();
			this.queueRunDispatches.set(queueEntryId, queueDispatches);
		}
		queueDispatches.add(association);
		return Result.ok(association);
	}

	private activateRunDispatchAssociation(
		association: SchedulerRunDispatchCancellationV1,
		prepared: SchedulerPreparedDispatchV1,
		binding: AgentBinding,
	): ResultValue<void, FoundationError> {
		if (association.durable) {
			return association.attemptId === prepared.assembly.attemptId
				? Result.ok(undefined)
				: fail("scheduler_dispatch_invalid");
		}
		const existing = this.attemptRunDispatches.get(prepared.assembly.attemptId);
		if (existing !== undefined && existing !== association) return fail("scheduler_dispatch_invalid");
		association.attemptId = prepared.assembly.attemptId;
		association.durable = true;
		association.cancel = () => this.cancelPrepared(prepared, binding);
		this.attemptRunDispatches.set(prepared.assembly.attemptId, association);
		if (this.runsRequiringCancellation.has(association.runId)) {
			if (!association.controller.signal.aborted) {
				association.controller.abort(new DOMException("Run lifecycle ended", "AbortError"));
			}
			this.beginRunDispatchCancellation(association);
		}
		return Result.ok(undefined);
	}

	private beginRunDispatchCancellation(association: SchedulerRunDispatchCancellationV1): void {
		if (!association.durable || association.cancel === undefined || association.cancellation !== undefined) return;
		const cancellation: Promise<ResultValue<void, FoundationError>> = association
			.cancel()
			.catch(() => fail("scheduler_settlement_rejected"));
		association.cancellation = cancellation.then((result) => {
			if (result.ok) this.releaseRunDispatchAssociation(association);
			return result;
		});
	}

	private observeRunCancellation(runId: RunId, terminal = false): void {
		if (terminal) this.runsRequiringCancellation.delete(runId);
		else this.runsRequiringCancellation.add(runId);
		for (const association of this.runDispatches.get(runId) ?? []) {
			if (!association.controller.signal.aborted) {
				association.controller.abort(new DOMException("Run lifecycle ended", "AbortError"));
			}
			this.beginRunDispatchCancellation(association);
		}
	}

	private releaseRunDispatchAssociation(association: SchedulerRunDispatchCancellationV1): void {
		if (association.attemptId !== undefined && this.attemptRunDispatches.get(association.attemptId) === association) {
			this.attemptRunDispatches.delete(association.attemptId);
		}
		const runDispatches = this.runDispatches.get(association.runId);
		runDispatches?.delete(association);
		if (runDispatches?.size === 0) this.runDispatches.delete(association.runId);
		const queueDispatches = this.queueRunDispatches.get(association.queueEntryId);
		queueDispatches?.delete(association);
		if (queueDispatches?.size === 0) this.queueRunDispatches.delete(association.queueEntryId);
	}

	private nowIso(): string {
		return this.nowFn();
	}

	private async prepareClaimed(
		request: SchedulerDispatchRequestV1,
	): Promise<ResultValue<SchedulerPreparedDispatchV1, FoundationError>> {
		const entryResult = await this.queue.getEntry(request.queueEntryId);
		if (!entryResult.ok) return entryResult;
		const entry = entryResult.value;
		if (entry.sessionId !== this.sessionId) return fail("scheduler_queue_invalid");
		if (entry.claimId === undefined) return fail("scheduler_queue_invalid");
		if (entry.state !== "claimed" && entry.state !== "dispatched") return fail("scheduler_queue_invalid");
		const claimResult = await this.queue.getClaim(entry.claimId);
		if (!claimResult.ok) return claimResult;
		const nowIso = this.nowIso();
		const fenced = assertSchedulerFencingToken(claimResult.value, request.fencingToken, nowIso);
		if (!fenced.ok) return fenced;
		const identity = schedulerDispatchIdentityV1(entry.queueEntryId, fenced.value.claimId);
		const selected = await this.registry.select({
			queueEntry: entry,
			requiredCapabilities: request.requiredCapabilities ?? this.requiredCapabilities,
			sessionId: this.sessionId,
			decidedAt: nowIso,
			...(request.workspaceDigest === undefined && this.workspaceDigest === undefined
				? {}
				: { workspaceDigest: request.workspaceDigest ?? this.workspaceDigest }),
			...(request.executorRequirements === undefined
				? {}
				: {
						exactRequirements: {
							binding: request.binding,
							attemptId: identity.attemptId,
							bindingEpochId: identity.bindingEpochId,
							agentInstanceId: identity.agentInstanceId,
							requireResume: request.executorRequirements.requireResume,
							modelAccess: request.executorRequirements.modelAccess,
							...(request.executorRequirements.reviewRevision === undefined
								? {}
								: { reviewRevision: request.executorRequirements.reviewRevision }),
							...(request.executorRequirements.credentialTargetRefs === undefined
								? {}
								: { credentialTargetRefs: request.executorRequirements.credentialTargetRefs }),
							...(request.executorRequirements.sandboxTargetRefs === undefined
								? {}
								: { sandboxTargetRefs: request.executorRequirements.sandboxTargetRefs }),
						},
					}),
			...(request.signal === undefined ? {} : { signal: request.signal }),
		});
		if (!selected.ok) return selected;
		const rejectSelected = async <T>(
			failure: ResultValue<T, FoundationError>,
		): Promise<ResultValue<T, FoundationError>> => {
			if (failure.ok) return failure;
			const released = await this.registry.settleSelection(
				entry.queueEntryId,
				schedulerSelectionFailureReasonV1(failure.error, request.signal, entry.deadlineAt, this.nowIso()),
				{},
			);
			return released.ok ? failure : Result.err(released.error);
		};
		const providerClass = selected.value.provider.providerClass;
		if (
			providerClass !== "scheduler" &&
			providerClass !== "task_executor" &&
			providerClass !== "agent" &&
			providerClass !== "external_connector"
		) {
			return rejectSelected(fail("scheduler_executor_unavailable"));
		}
		if (
			selected.value.fact.chosenProviderId !== selected.value.provider.providerId ||
			selected.value.entry.descriptor.providerId !== selected.value.provider.providerId ||
			selected.value.entry.descriptor.providerClass !== providerClass
		) {
			return rejectSelected(fail("scheduler_executor_unavailable"));
		}
		const live = await this.liveDispatch(entry.queueEntryId);
		if (!live.ok) return rejectSelected(live);
		if (
			live.value !== undefined &&
			(live.value.dispatchId !== identity.dispatchId ||
				live.value.providerId !== selected.value.provider.providerId ||
				live.value.providerClass !== providerClass ||
				(live.value.attemptId !== undefined && live.value.attemptId !== identity.attemptId))
		) {
			return rejectSelected(fail("scheduler_dispatch_invalid"));
		}
		let nativeAgent: SchedulerNativeAgentResolutionV1 | undefined;
		if (providerClass === "agent") {
			if (this.nativeAgentBridge === undefined) {
				return rejectSelected(
					Result.err(
						new FoundationError(
							"agent_instance_required_for_agent_provider",
							"Scheduler selected an agent provider without a trusted Native Subagent bridge",
							{ details: { providerId: selected.value.provider.providerId } },
						),
					),
				);
			}
			const resolved = await this.nativeAgentBridge.resolve({
				schemaVersion: 1,
				provider: selected.value.provider,
				entry,
				claim: fenced.value,
				binding: request.binding,
				sessionId: this.sessionId,
				laneId: identity.laneId,
				dispatchId: identity.dispatchId,
				attemptId: identity.attemptId,
				bindingEpochId: identity.bindingEpochId,
				agentInstanceId: identity.agentInstanceId,
				spawnId: identity.spawnId,
				activatedByCommandId: identity.commandId,
				now: nowIso,
				...(request.signal === undefined ? {} : { signal: request.signal }),
			});
			if (!resolved.ok) return rejectSelected(resolved);
			nativeAgent = resolved.value;
		}
		const assembly = assembleSchedulerDispatchV1({
			entry,
			claim: fenced.value,
			binding: request.binding,
			providerId: selected.value.provider.providerId,
			providerClass,
			sessionId: this.sessionId,
			laneId: providerClass === "agent" ? identity.laneId : this.laneId,
			now: nowIso,
			...(nativeAgent === undefined ? {} : { nativeAgent }),
		});
		if (!assembly.ok) return rejectSelected(assembly);
		return Result.ok({
			entry,
			claim: fenced.value,
			selection: {
				fact: selected.value.fact,
				provider: selected.value.provider,
				providerClass,
				providerId: selected.value.provider.providerId,
			},
			assembly: assembly.value,
			dispatchRecord: live.value,
		});
	}

	private async executePrepared(
		request: SchedulerDispatchRequestV1,
		prepared: SchedulerPreparedDispatchV1,
		runAssociation?: SchedulerRunDispatchCancellationV1,
	): Promise<ResultValue<SchedulerDispatchOutcomeV1, FoundationError>> {
		const scheduled = schedulerExecutionSignal(
			prepared.assembly.dispatch.deadlineAt,
			this.nowIso(),
			request.signal,
			this.clock,
		);
		let markResolved = false;
		let resolveMarked: (marked: boolean) => void = () => {};
		const marked = new Promise<boolean>((resolve) => {
			resolveMarked = resolve;
		});
		let cancellation: Promise<ResultValue<void, FoundationError>> | undefined;
		const requestCancellation = (): void => {
			if (runAssociation !== undefined) {
				this.beginRunDispatchCancellation(runAssociation);
				return;
			}
			cancellation ??= marked.then((durable) =>
				durable ? this.cancelPrepared(prepared, request.binding) : Result.ok(undefined),
			);
		};
		scheduled.signal?.addEventListener("abort", requestCancellation, { once: true });
		if (scheduled.signal?.aborted === true) requestCancellation();
		let executed: ResultValue<DispatchExecutionResult, FoundationError>;
		try {
			executed = await this.settlementFor(prepared.assembly.correlation).executeDispatch({
				provider: prepared.selection.provider,
				dispatch: prepared.assembly.dispatch,
				binding: request.binding,
				initialBindingEpoch: prepared.assembly.initialBindingEpoch,
				correlation: prepared.assembly.correlation,
				...(prepared.assembly.agentInstance === undefined
					? {}
					: { agentInstance: prepared.assembly.agentInstance }),
				beforeRunAttempt: async (attempt) => {
					const persisted = await this.persistInFlight(prepared, attempt);
					markResolved = true;
					resolveMarked(persisted.ok);
					if (persisted.ok && runAssociation !== undefined) {
						const activated = this.activateRunDispatchAssociation(runAssociation, prepared, request.binding);
						if (!activated.ok) return activated;
					}
					if (persisted.ok && scheduled.signal?.aborted === true) {
						requestCancellation();
						const pendingCancellation = runAssociation?.cancellation ?? cancellation;
						if (pendingCancellation !== undefined) {
							const cancelled = await pendingCancellation;
							if (!cancelled.ok) return cancelled;
						}
					}
					if (persisted.ok && prepared.selection.providerClass === "agent") {
						const revalidated = await this.revalidateNativeAgent(prepared, request.binding, scheduled.signal);
						if (!revalidated.ok) return revalidated;
					}
					return persisted;
				},
				...(scheduled.signal === undefined ? {} : { signal: scheduled.signal }),
			});
		} finally {
			if (!markResolved) resolveMarked(false);
			scheduled.signal?.removeEventListener("abort", requestCancellation);
			scheduled.dispose();
		}
		const pendingCancellation = runAssociation?.cancellation ?? cancellation;
		const cancelled = pendingCancellation === undefined ? undefined : await pendingCancellation;
		if (cancelled !== undefined && !cancelled.ok) return cancelled;
		if (!executed.ok) return executed;
		if (!this.executionAgentIdentityMatches(prepared, executed.value.attempt, executed.value.receipt)) {
			return Result.err(
				new FoundationError(
					"invalid_correlation",
					"Provider execution AgentInstance does not match its Scheduler dispatch",
					{
						details: { attemptId: executed.value.attempt.attemptId },
					},
				),
			);
		}
		return this.completeOutcome(prepared, executed.value.attempt, executed.value.receipt);
	}

	private async resumePrepared(
		request: SchedulerDispatchRequestV1,
		prepared: SchedulerPreparedDispatchV1,
		runAssociation?: SchedulerRunDispatchCancellationV1,
	): Promise<ResultValue<SchedulerDispatchOutcomeV1, FoundationError>> {
		if (prepared.dispatchRecord === undefined || prepared.dispatchRecord.status !== "in_flight") {
			return fail("scheduler_dispatch_invalid");
		}
		if (prepared.dispatchRecord.attemptId === undefined) return fail("scheduler_dispatch_invalid");
		if (runAssociation !== undefined) {
			const activated = this.activateRunDispatchAssociation(runAssociation, prepared, request.binding);
			if (!activated.ok) return activated;
		}
		const scheduled = schedulerExecutionSignal(
			prepared.assembly.dispatch.deadlineAt,
			this.nowIso(),
			request.signal,
			this.clock,
		);
		let cancellation: Promise<ResultValue<void, FoundationError>> | undefined;
		const requestCancellation = (): void => {
			if (runAssociation !== undefined) {
				this.beginRunDispatchCancellation(runAssociation);
				return;
			}
			cancellation ??= this.cancelPrepared(prepared, request.binding);
		};
		scheduled.signal?.addEventListener("abort", requestCancellation, { once: true });
		if (scheduled.signal?.aborted === true) requestCancellation();
		let resumed: ResultValue<DispatchStartResult, FoundationError>;
		try {
			if (prepared.selection.providerClass === "agent") {
				const revalidated = await this.revalidateNativeAgent(prepared, request.binding, scheduled.signal);
				if (!revalidated.ok) return revalidated;
			}
			resumed = await this.settlementFor(prepared.assembly.correlation).resumeDispatch({
				provider: prepared.selection.provider,
				dispatch: prepared.assembly.dispatch,
				binding: request.binding,
				initialBindingEpoch: prepared.assembly.initialBindingEpoch,
				correlation: prepared.assembly.correlation,
				...(prepared.assembly.agentInstance === undefined
					? {}
					: { agentInstance: prepared.assembly.agentInstance }),
				...(scheduled.signal === undefined ? {} : { signal: scheduled.signal }),
			});
		} finally {
			scheduled.signal?.removeEventListener("abort", requestCancellation);
			scheduled.dispose();
		}
		const pendingCancellation = runAssociation?.cancellation ?? cancellation;
		const cancelled = pendingCancellation === undefined ? undefined : await pendingCancellation;
		if (cancelled !== undefined && !cancelled.ok) return cancelled;
		if (!resumed.ok) return resumed;
		if (resumed.value.receipt !== undefined) {
			if (!this.executionAgentIdentityMatches(prepared, resumed.value.attempt, resumed.value.receipt)) {
				return Result.err(
					new FoundationError(
						"invalid_correlation",
						"Provider resume AgentInstance does not match its Scheduler dispatch",
						{ details: { attemptId: resumed.value.attempt.attemptId } },
					),
				);
			}
			return this.completeOutcome(prepared, resumed.value.attempt, resumed.value.receipt);
		}
		if (!schedulerProviderResumeSupportedV1(prepared.selection.provider)) {
			return fail("scheduler_attempt_recovery_failed");
		}
		return fail("scheduler_attempt_recovery_failed");
	}

	private async cancelPrepared(
		prepared: SchedulerPreparedDispatchV1,
		binding: AgentBinding,
	): Promise<ResultValue<void, FoundationError>> {
		return this.settlementFor(prepared.assembly.correlation).cancelAttempt({
			provider: prepared.selection.provider,
			dispatch: prepared.assembly.dispatch,
			binding,
			initialBindingEpoch: prepared.assembly.initialBindingEpoch,
			correlation: prepared.assembly.correlation,
			...(prepared.assembly.agentInstance === undefined ? {} : { agentInstance: prepared.assembly.agentInstance }),
		});
	}

	private async revalidateNativeAgent(
		prepared: SchedulerPreparedDispatchV1,
		binding: AgentBinding,
		signal: AbortSignal | undefined,
	): Promise<ResultValue<void, FoundationError>> {
		const bridge = this.nativeAgentBridge;
		const agentInstance = prepared.assembly.agentInstance;
		if (bridge === undefined || agentInstance === undefined || prepared.selection.providerClass !== "agent") {
			return Result.err(
				new FoundationError(
					"agent_instance_required_for_agent_provider",
					"Scheduler agent execution requires its captured Native Subagent bridge identity",
					{ details: { providerId: prepared.selection.providerId } },
				),
			);
		}
		return bridge.revalidate({
			schemaVersion: 1,
			provider: prepared.selection.provider,
			binding,
			resolution: {
				schemaVersion: 1,
				providerId: prepared.selection.providerId,
				dispatch: prepared.assembly.dispatch,
				agentInstance,
				initialBindingEpoch: prepared.assembly.initialBindingEpoch,
				correlation: prepared.assembly.correlation,
			},
			...(signal === undefined ? {} : { signal }),
		});
	}

	private executionAgentIdentityMatches(
		prepared: SchedulerPreparedDispatchV1,
		attempt: Attempt,
		receipt: AttemptReceipt,
	): boolean {
		const expected = prepared.assembly.agentInstanceId;
		return prepared.selection.providerClass === "agent"
			? expected !== undefined && attempt.agentInstanceId === expected && receipt.agentInstanceId === expected
			: expected === undefined && attempt.agentInstanceId === undefined && receipt.agentInstanceId === undefined;
	}

	private settlementFor(correlation: ExecutionCorrelation): LayeredResultSettlement {
		const existing = this.settlements.get(correlation.laneId);
		if (existing !== undefined) return existing;
		const settlement = new LayeredResultSettlement(this.session, {
			ownerId: this.ownerId,
			laneId: correlation.laneId,
		});
		this.settlements.set(correlation.laneId, settlement);
		return settlement;
	}

	private async persistInFlight(
		prepared: SchedulerPreparedDispatchV1,
		attempt: Attempt,
	): Promise<ResultValue<void, FoundationError>> {
		const checked = validateAttempt(attempt);
		if (!checked.ok) return checked;
		if (
			(prepared.selection.providerClass === "agent" &&
				checked.value.agentInstanceId !== prepared.assembly.agentInstanceId) ||
			(prepared.selection.providerClass !== "agent" && checked.value.agentInstanceId !== undefined)
		) {
			return Result.err(
				new FoundationError(
					"invalid_correlation",
					"Scheduler Attempt AgentInstance does not match its selected provider",
					{
						details: { attemptId: checked.value.attemptId },
					},
				),
			);
		}
		if (
			checked.value.attemptId !== prepared.assembly.attemptId ||
			checked.value.dispatchId !== prepared.assembly.dispatchId ||
			checked.value.taskId !== prepared.entry.taskId ||
			checked.value.providerId !== prepared.selection.providerId ||
			checked.value.bindingId !== prepared.assembly.dispatch.bindingId ||
			checked.value.bindingEpochIds.length !== 1 ||
			checked.value.bindingEpochIds[0] !== prepared.assembly.bindingEpochId
		) {
			return Result.err(
				new FoundationError(
					"invalid_correlation",
					"Provider-created Attempt does not match its Dispatch, Binding, or epoch",
					{
						details: { attemptId: checked.value.attemptId, dispatchId: prepared.assembly.dispatchId },
					},
				),
			);
		}
		const marked = await this.queue.markDispatched({
			queueEntryId: prepared.entry.queueEntryId,
			fencingToken: prepared.claim.fencingToken,
			dispatchId: prepared.assembly.dispatchId,
			attemptId: prepared.assembly.attemptId,
			providerId: prepared.selection.providerId,
			providerClass: prepared.selection.providerClass,
		});
		if (!marked.ok) return marked;
		return Result.ok(undefined);
	}

	private async completeOutcome(
		prepared: SchedulerPreparedDispatchV1,
		attempt: Attempt,
		receipt: AttemptReceipt,
	): Promise<ResultValue<SchedulerDispatchOutcomeV1, FoundationError>> {
		const snapshot = await this.queue.snapshot();
		if (!snapshot.ok) return snapshot;
		const entry = snapshot.value.entries.find((item) => item.queueEntryId === prepared.claim.queueEntryId);
		const dispatchRecord = snapshot.value.dispatches.find((item) => item.dispatchId === prepared.assembly.dispatchId);
		if (entry === undefined || dispatchRecord === undefined) return fail("scheduler_not_found");
		if (
			entry.state !== "dispatched" ||
			dispatchRecord.status !== "in_flight" ||
			dispatchRecord.attemptId !== attempt.attemptId ||
			dispatchRecord.claimId !== prepared.claim.claimId
		) {
			return fail("scheduler_dispatch_invalid");
		}
		return Result.ok({
			entry,
			claim: prepared.claim,
			dispatchRecord,
			dispatch: prepared.assembly.dispatch,
			attempt,
			receipt,
			selection: prepared.selection.fact,
			providerId: prepared.selection.providerId,
			providerClass: prepared.selection.providerClass,
		});
	}

	private async liveDispatch(
		queueEntryId: string,
	): Promise<ResultValue<SchedulerDispatchRecordV1 | undefined, FoundationError>> {
		const snapshot = await this.queue.snapshot();
		if (!snapshot.ok) return snapshot;
		const live: SchedulerDispatchRecordV1[] = [];
		for (const dispatch of snapshot.value.dispatches) {
			if (dispatch.queueEntryId !== queueEntryId) continue;
			const parsed = parseSchedulerDispatchRecord(dispatch);
			if (!parsed.ok) return parsed;
			if (parsed.value.status === "prepared" || parsed.value.status === "in_flight") live.push(parsed.value);
		}
		if (live.length > 1) return fail("scheduler_dispatch_invalid");
		return Result.ok(live[0]);
	}

	private async loadDurableAttempt(
		attemptId: string,
	): Promise<ResultValue<SchedulerDurableAttemptV1, FoundationError>> {
		const queueSnapshot = await this.queue.snapshot();
		if (!queueSnapshot.ok) return queueSnapshot;
		const queueDispatches = queueSnapshot.value.dispatches.filter(
			(record) => record.attemptId === attemptId && (record.status === "in_flight" || record.status === "prepared"),
		);
		if (queueDispatches.length !== 1) return fail("scheduler_not_found");
		const queueDispatchResult = parseSchedulerDispatchRecord(queueDispatches[0]);
		if (!queueDispatchResult.ok) return queueDispatchResult;
		const queueDispatch = queueDispatchResult.value;
		const queueEntryCandidate = queueSnapshot.value.entries.find(
			(entry) => entry.queueEntryId === queueDispatch.queueEntryId,
		);
		if (queueEntryCandidate === undefined) return fail("scheduler_not_found");
		const queueEntryResult = parseSchedulerQueueEntry(queueEntryCandidate);
		if (!queueEntryResult.ok) return queueEntryResult;
		const queueEntry = queueEntryResult.value;
		if (queueEntry.sessionId !== this.sessionId || queueEntry.claimId !== queueDispatch.claimId) {
			return fail("scheduler_dispatch_invalid");
		}
		const claimCandidate = queueSnapshot.value.claims.find((item) => item.claimId === queueDispatch.claimId);
		if (claimCandidate === undefined) return fail("scheduler_not_found");
		const claimResult = parseSchedulerClaim(claimCandidate);
		if (!claimResult.ok) return claimResult;
		const claim = claimResult.value;
		if (claim.queueEntryId !== queueEntry.queueEntryId || claim.taskId !== queueEntry.taskId) {
			return fail("scheduler_dispatch_invalid");
		}
		const attemptRecord = await this.session.getFoundationObject("attempt", attemptId);
		if (attemptRecord === undefined || attemptRecord.kind !== "fact") return fail("scheduler_not_found");
		const checkedAttempt = validateAttempt(attemptRecord.payload);
		if (!checkedAttempt.ok) return checkedAttempt;
		if (
			checkedAttempt.value.taskId !== queueEntry.taskId ||
			checkedAttempt.value.dispatchId !== queueDispatch.dispatchId ||
			checkedAttempt.value.providerId !== queueDispatch.providerId
		) {
			return fail("scheduler_dispatch_invalid");
		}
		let agentInstance: AgentInstance | undefined;
		if (queueDispatch.providerClass === "agent") {
			if (checkedAttempt.value.agentInstanceId === undefined) {
				return Result.err(
					new FoundationError(
						"agent_instance_required_for_agent_provider",
						"Durable Scheduler agent Attempt is missing its AgentInstance",
						{ details: { attemptId: checkedAttempt.value.attemptId } },
					),
				);
			}
			const agentRecord = await this.session.getFoundationObject(
				"agent_instance",
				checkedAttempt.value.agentInstanceId,
			);
			if (agentRecord === undefined || agentRecord.kind !== "fact") {
				return Result.err(
					new FoundationError(
						"agent_instance_required_for_agent_provider",
						"Durable Scheduler agent Attempt cannot resolve its AgentInstance",
						{ details: { attemptId: checkedAttempt.value.attemptId } },
					),
				);
			}
			const checkedAgent = validateAgentInstance(agentRecord.payload);
			if (!checkedAgent.ok) return checkedAgent;
			if (
				checkedAgent.value.agentInstanceId !== checkedAttempt.value.agentInstanceId ||
				checkedAgent.value.providerId !== checkedAttempt.value.providerId ||
				checkedAgent.value.taskId !== checkedAttempt.value.taskId
			) {
				return fail("scheduler_dispatch_invalid");
			}
			agentInstance = checkedAgent.value;
		} else if (checkedAttempt.value.agentInstanceId !== undefined) {
			return Result.err(
				new FoundationError(
					"agent_instance_forbidden_for_provider",
					"Non-agent Attempt cannot carry an AgentInstance",
					{ details: { attemptId: checkedAttempt.value.attemptId } },
				),
			);
		}
		const dispatchRecord = await this.session.getFoundationObject("dispatch", checkedAttempt.value.dispatchId);
		if (dispatchRecord === undefined || dispatchRecord.kind !== "fact") return fail("scheduler_not_found");
		const checkedDispatch = validateDispatch(dispatchRecord.payload);
		if (!checkedDispatch.ok) return checkedDispatch;
		if (
			checkedDispatch.value.taskId !== queueEntry.taskId ||
			checkedDispatch.value.taskExecutorProviderId !== queueDispatch.providerId ||
			checkedDispatch.value.deadlineAt !== queueEntry.deadlineAt
		) {
			return fail("scheduler_dispatch_invalid");
		}
		const bindingRecord = await this.session.getFoundationObject("agent_binding", checkedAttempt.value.bindingId);
		if (bindingRecord === undefined || bindingRecord.kind !== "fact") {
			return Result.err(
				new FoundationError("binding_required_fact", "Agent execution references a binding that is not durable", {
					details: { bindingId: checkedAttempt.value.bindingId, taskId: checkedAttempt.value.taskId },
				}),
			);
		}
		const checkedBinding = validateImmutableAgentBinding(bindingRecord.payload);
		if (!checkedBinding.ok) return checkedBinding;
		if (
			checkedBinding.value.taskId !== queueEntry.taskId ||
			checkedBinding.value.bindingId !== checkedDispatch.value.bindingId ||
			(queueEntry.goalId !== undefined && checkedBinding.value.goalId !== queueEntry.goalId)
		) {
			return fail("scheduler_dispatch_invalid");
		}
		const epochId = checkedAttempt.value.bindingEpochIds[0];
		if (epochId === undefined) return fail("scheduler_dispatch_invalid");
		const epochRecord = await this.session.getFoundationObject("binding_epoch", epochId);
		if (epochRecord === undefined || epochRecord.kind !== "fact") return fail("scheduler_not_found");
		const stored = validateBindingEpoch(epochRecord.payload);
		if (!stored.ok) return stored;
		if (
			stored.value.bindingEpochId !== epochId ||
			stored.value.attemptId !== checkedAttempt.value.attemptId ||
			stored.value.taskId !== checkedAttempt.value.taskId ||
			stored.value.bindingId !== checkedAttempt.value.bindingId ||
			stored.value.ordinal !== 0 ||
			stored.value.activationReason !== "attempt_started" ||
			stored.value.agentInstanceId !== agentInstance?.agentInstanceId
		) {
			return fail("scheduler_dispatch_invalid");
		}
		const registered = this.registry.get(checkedAttempt.value.providerId);
		if (registered === undefined) return fail("scheduler_executor_unavailable");
		if (
			registered.entry.descriptor.providerClass !== queueDispatch.providerClass ||
			registered.provider.providerClass !== queueDispatch.providerClass ||
			registered.provider.providerId !== queueDispatch.providerId
		) {
			return fail("scheduler_executor_unavailable");
		}
		const identity = schedulerDispatchIdentityV1(queueEntry.queueEntryId, claim.claimId);
		const correlation = createExecutionCorrelation(
			this.sessionId,
			queueDispatch.providerClass === "agent" ? identity.laneId : this.laneId,
			{
				revision: 1,
				roleRevisionId: checkedBinding.value.roleRevision.id,
				modelProfileId: checkedBinding.value.modelProfileRevision.id,
				modelProfileRevisionId: checkedBinding.value.modelProfileRevision.id,
				taskId: checkedAttempt.value.taskId,
				dispatchId: checkedAttempt.value.dispatchId,
				attemptId: checkedAttempt.value.attemptId,
				bindingId: checkedAttempt.value.bindingId,
				bindingEpochId: epochId,
				providerId: checkedAttempt.value.providerId,
				...(agentInstance === undefined
					? {}
					: {
							agentInstanceId: agentInstance.agentInstanceId,
							...(agentInstance.lineage.parentId === undefined
								? {}
								: { parentId: agentInstance.lineage.parentId }),
							...(agentInstance.lineage.ancestorIds === undefined
								? {}
								: { ancestorIds: agentInstance.lineage.ancestorIds }),
						}),
				...(queueEntry.goalId === undefined && checkedBinding.value.goalId === undefined
					? {}
					: { goalId: queueEntry.goalId ?? checkedBinding.value.goalId }),
			},
		);
		return Result.ok({
			queueEntryId: queueEntry.queueEntryId,
			provider: registered.provider,
			dispatch: checkedDispatch.value,
			binding: checkedBinding.value,
			initialBindingEpoch: stored.value,
			correlation,
			...(agentInstance === undefined ? {} : { agentInstance }),
		});
	}
}

export function isSchedulerDispatchErrorCode(value: unknown): value is SchedulerErrorCodeV1 {
	return typeof value === "string" && isSchedulerErrorCode(value);
}
