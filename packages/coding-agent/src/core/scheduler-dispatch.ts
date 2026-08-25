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
	FoundationError,
	LayeredResultSettlementV1,
	Result,
	createBindingEpoch,
	createExecutionCorrelation,
	fingerprintFoundationValue,
	validateAttempt,
	validateBindingEpochV1,
	validateDispatch,
	validateImmutableAgentBinding,
	type AgentBindingV1,
	type AttemptReceiptV1,
	type AttemptV1,
	type BindingEpochV1,
	type BudgetV1,
	type DispatchExecutionResultV1,
	type DispatchStartResultV1,
	type DispatchV1,
	type ExecutionCorrelationV1,
	type FingerprintV1,
	type FoundationProviderCapabilityV1,
	type FoundationProviderExecutionOptionsV1,
	type QuotaProvider,
	type Result as ResultValue,
	type Session,
	type TaskExecutorProvider,
} from "@aos-agent/agent-core";
import { runtimeClockFor, type RuntimeClock, type RuntimeTimerHandle } from "./runtime-clock.ts";
import {
	SCHEDULER_IN_PROCESS_CAPABILITY_ID,
	SchedulerInProcessTaskExecutorProvider,
	type SchedulerExecutorRegistry,
	type SchedulerHostAttemptRunnerV1,
} from "./scheduler-executors.ts";
import {
	RUN_LEDGER_CUSTOM_TYPE,
	registerRunSchedulerLifecycleHooks,
	type RunId,
	type RunLedgerSession,
	type RunSchedulerLifecycleHooks,
} from "./run-lifecycle.ts";
import type { SchedulerCancelAttemptV1, SchedulerQueueStore } from "./scheduler-queue.ts";
import {
	SCHEDULER_ERROR_CODES,
	assertSchedulerFencingToken,
	parseSchedulerClaim,
	parseSchedulerDispatchRecord,
	parseSchedulerQueueEntry,
	type SchedulerClaimV1,
	type SchedulerDispatchRecordV1,
	type SchedulerErrorCodeV1,
	type SchedulerExecutorEntryV1,
	type SchedulerProviderClassV1,
	type SchedulerQueueEntryV1,
	type SchedulerSelectionFactV1,
} from "./scheduler.ts";

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
	readonly requiredCapabilities?: readonly FoundationProviderCapabilityV1[];
	readonly workspaceDigest?: FingerprintV1;
}

export interface SchedulerDispatchRequestV1 {
	readonly queueEntryId: string;
	readonly fencingToken: string;
	readonly binding: AgentBindingV1;
	readonly requiredCapabilities?: readonly FoundationProviderCapabilityV1[];
	readonly workspaceDigest?: FingerprintV1;
	readonly signal?: AbortSignal;
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
	readonly binding: AgentBindingV1;
	readonly providerId: string;
	readonly providerClass: SchedulerProviderClassV1;
	readonly sessionId: string;
	readonly laneId: string;
	readonly now: string;
}

export interface SchedulerDispatchAssemblyV1 {
	readonly dispatch: DispatchV1;
	readonly initialBindingEpoch: BindingEpochV1;
	readonly correlation: ExecutionCorrelationV1;
	readonly dispatchId: string;
	readonly attemptId: string;
	readonly bindingEpochId: string;
}

export interface SchedulerDispatchOutcomeV1 {
	readonly entry: SchedulerQueueEntryV1;
	readonly claim: SchedulerClaimV1;
	readonly dispatchRecord: SchedulerDispatchRecordV1;
	readonly dispatch: DispatchV1;
	readonly attempt: AttemptV1;
	readonly receipt: AttemptReceiptV1;
	readonly selection: SchedulerSelectionFactV1;
	readonly providerId: string;
	readonly providerClass: SchedulerProviderClassV1;
}

export interface SchedulerInProcessHostBindingOptionsV1 {
	readonly hostAttemptRunner: SchedulerHostAttemptRunnerV1;
	readonly quota?: QuotaProvider;
	readonly now?: () => string;
	readonly budget?: BudgetV1;
	readonly sessionId?: string;
	readonly workspaceDigest?: FingerprintV1;
	readonly latencyMs?: number;
	readonly trusted?: boolean;
}

interface SchedulerProviderResumeSurfaceV1 extends TaskExecutorProvider {
	readonly resumeAttempt?: (
		attemptId: string,
		options: FoundationProviderExecutionOptionsV1,
	) => Promise<ResultValue<AttemptReceiptV1, FoundationError>>;
	readonly resume?: (
		attemptId: string,
		options?: { readonly signal?: AbortSignal },
	) => Promise<ResultValue<AttemptReceiptV1, FoundationError>>;
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
	readonly provider: TaskExecutorProvider;
	readonly dispatch: DispatchV1;
	readonly binding: AgentBindingV1;
	readonly initialBindingEpoch: BindingEpochV1;
	readonly correlation: ExecutionCorrelationV1;
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

function inProcessCapability(): FoundationProviderCapabilityV1 {
	return { schemaVersion: 1, id: SCHEDULER_IN_PROCESS_CAPABILITY_ID, version: 1 };
}

/** True when the selected provider exposes the settlement resume surface. */
export function schedulerProviderResumeSupportedV1(provider: TaskExecutorProvider): boolean {
	const surface: SchedulerProviderResumeSurfaceV1 = provider;
	return typeof surface.resumeAttempt === "function" || typeof surface.resume === "function";
}

export function schedulerDispatchIdentityV1(
	queueEntryId: string,
	claimId: string,
): { readonly dispatchId: string; readonly attemptId: string; readonly bindingEpochId: string; readonly commandId: string } {
	const digest = fingerprintFoundationValue({ schemaVersion: 1, queueEntryId, claimId }).value;
	return {
		dispatchId: `dispatch_${digest}`,
		attemptId: `attempt_${digest}`,
		bindingEpochId: `epoch_${digest}`,
		commandId: `command_${digest}`,
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
	if (claim.queueEntryId !== entry.queueEntryId || claim.taskId !== entry.taskId) return fail("scheduler_queue_invalid");
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
	const dispatchCandidate: DispatchV1 = {
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
		return Result.err(
			new FoundationError(
				"agent_instance_required_for_agent_provider",
				"Scheduler dispatch does not assemble an AgentInstance for an agent provider",
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
			new FoundationError("agent_instance_forbidden_for_provider", "Non-agent provider dispatch cannot carry an AgentInstance", {
				details: { providerId: input.providerId },
			}),
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
		...(entry.goalId === undefined && binding.goalId === undefined
			? {}
			: { goalId: entry.goalId ?? binding.goalId }),
	});
	if (correlation.agentInstanceId !== undefined) {
		return Result.err(
			new FoundationError("agent_instance_forbidden_for_provider", "Non-agent provider dispatch cannot carry an AgentInstance", {
				details: { providerId: input.providerId },
			}),
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

function schedulerRunDispatchSignalV1(
	requestSignal: AbortSignal | undefined,
	runSignal: AbortSignal,
): AbortSignal {
	return requestSignal === undefined ? runSignal : AbortSignal.any([requestSignal, runSignal]);
}

/** Bind the real in-process TaskExecutor Host runner seam. A missing runner is a type error; registration still fails closed if the provider cannot run. */
export async function bindSchedulerInProcessTaskExecutorV1(
	registry: SchedulerExecutorRegistry,
	options: SchedulerInProcessHostBindingOptionsV1,
): Promise<ResultValue<SchedulerExecutorEntryV1, FoundationError>> {
	const nowIso = (options.now ?? (() => new Date().toISOString()))();
	const provider = new SchedulerInProcessTaskExecutorProvider({
		hostAttemptRunner: options.hostAttemptRunner,
		...(options.quota === undefined ? {} : { quota: options.quota }),
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
	});
}

export class SchedulerDispatchController {
	private readonly session: Session;
	private readonly queue: SchedulerQueueStore;
	private readonly registry: SchedulerExecutorRegistry;
	private readonly settlement: LayeredResultSettlementV1;
	private readonly sessionId: string;
	private readonly runLifecycleSession: RunLedgerSession | undefined;
	private readonly schedulerLifecycleHooks: RunSchedulerLifecycleHooks;
	private readonly unregisterRunLifecycleHooks: (() => void) | undefined;
	private readonly laneId: string;
	private readonly clock: RuntimeClock;
	private readonly nowFn: () => string;
	private readonly requiredCapabilities: readonly FoundationProviderCapabilityV1[];
	private readonly workspaceDigest: FingerprintV1 | undefined;
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
		this.settlement = new LayeredResultSettlementV1(options.session, { ownerId: options.ownerId });
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
		this.unregisterRunLifecycleHooks = options.runLifecycleSession === undefined || options.runLifecycleHookOwnership === "host"
			? undefined
			: registerRunSchedulerLifecycleHooks(options.runLifecycleSession, this.schedulerLifecycleHooks);
		this.laneId = options.laneId ?? "main";
		this.nowFn = options.now ?? (() => new Date(this.clock.wallNow()).toISOString());
		this.requiredCapabilities = options.requiredCapabilities ?? [inProcessCapability()];
		this.workspaceDigest = options.workspaceDigest;
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
			...(request.requiredCapabilities === undefined
				? {}
				: { requiredCapabilities: request.requiredCapabilities }),
			...(request.workspaceDigest === undefined ? {} : { workspaceDigest: request.workspaceDigest }),
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
				if (!repaired.ok) return repaired;
				return this.resumePrepared(request, {
					...prepared.value,
					entry: repaired.value.entry,
					claim: repaired.value.claim,
					dispatchRecord: repaired.value.dispatch,
				}, runAssociation);
			}
			return this.resumePrepared(request, prepared.value, runAssociation);
		}
		if (prepared.value.entry.state === "dispatched") return fail("scheduler_dispatch_invalid");
		return this.executePrepared(request, prepared.value, runAssociation);
	}

	async cancelAttempt(attemptId: string): Promise<ResultValue<void, FoundationError>> {
		const loaded = await this.loadDurableAttempt(attemptId);
		if (!loaded.ok) return loaded;
		const cancelled = await this.settlement.cancelAttempt({
			provider: loaded.value.provider,
			dispatch: loaded.value.dispatch,
			binding: loaded.value.binding,
			initialBindingEpoch: loaded.value.initialBindingEpoch,
			correlation: loaded.value.correlation,
		});
		if (cancelled.ok) {
			const association = this.attemptRunDispatches.get(attemptId);
			if (association !== undefined) this.releaseRunDispatchAssociation(association);
		}
		return cancelled;
	}

	async cancelDispatch(
		queueEntryId: string,
		fencingToken: string,
	): Promise<ResultValue<void, FoundationError>> {
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
		binding: AgentBindingV1,
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
		const cancellation: Promise<ResultValue<void, FoundationError>> = association.cancel().catch(() =>
			fail("scheduler_settlement_rejected"),
		);
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
		if (
			association.attemptId !== undefined &&
			this.attemptRunDispatches.get(association.attemptId) === association
		) {
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
		const selected = await this.registry.select({
			queueEntry: entry,
			requiredCapabilities: request.requiredCapabilities ?? this.requiredCapabilities,
			sessionId: this.sessionId,
			decidedAt: nowIso,
			...(request.workspaceDigest === undefined && this.workspaceDigest === undefined
				? {}
				: { workspaceDigest: request.workspaceDigest ?? this.workspaceDigest }),
		});
		if (!selected.ok) return selected;
		const providerClass = selected.value.provider.providerClass;
		if (
			providerClass !== "scheduler" &&
			providerClass !== "task_executor" &&
			providerClass !== "agent" &&
			providerClass !== "external_connector"
		) {
			return fail("scheduler_executor_unavailable");
		}
		if (
			selected.value.fact.chosenProviderId !== selected.value.provider.providerId ||
			selected.value.entry.descriptor.providerId !== selected.value.provider.providerId ||
			selected.value.entry.descriptor.providerClass !== providerClass
		) {
			return fail("scheduler_executor_unavailable");
		}
		const assembly = assembleSchedulerDispatchV1({
			entry,
			claim: fenced.value,
			binding: request.binding,
			providerId: selected.value.provider.providerId,
			providerClass,
			sessionId: this.sessionId,
			laneId: this.laneId,
			now: nowIso,
		});
		if (!assembly.ok) return assembly;
		const live = await this.liveDispatch(entry.queueEntryId);
		if (!live.ok) return live;
		if (live.value !== undefined) {
			if (
				live.value.dispatchId !== assembly.value.dispatchId ||
				live.value.providerId !== selected.value.provider.providerId ||
				live.value.providerClass !== providerClass ||
				(live.value.attemptId !== undefined && live.value.attemptId !== assembly.value.attemptId)
			) {
				return fail("scheduler_dispatch_invalid");
			}
		}
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
		let executed: ResultValue<DispatchExecutionResultV1, FoundationError>;
		try {
			executed = await this.settlement.executeDispatch({
				provider: prepared.selection.provider,
				dispatch: prepared.assembly.dispatch,
				binding: request.binding,
				initialBindingEpoch: prepared.assembly.initialBindingEpoch,
				correlation: prepared.assembly.correlation,
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
		if (executed.value.attempt.agentInstanceId !== undefined || executed.value.receipt.agentInstanceId !== undefined) {
			return Result.err(
				new FoundationError("agent_instance_forbidden_for_provider", "Non-agent provider dispatch cannot carry an AgentInstance", {
					details: { attemptId: executed.value.attempt.attemptId },
				}),
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
		let resumed: ResultValue<DispatchStartResultV1, FoundationError>;
		try {
			resumed = await this.settlement.resumeDispatch({
				provider: prepared.selection.provider,
				dispatch: prepared.assembly.dispatch,
				binding: request.binding,
				initialBindingEpoch: prepared.assembly.initialBindingEpoch,
				correlation: prepared.assembly.correlation,
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
			if (resumed.value.attempt.agentInstanceId !== undefined || resumed.value.receipt.agentInstanceId !== undefined) {
				return Result.err(
					new FoundationError(
						"agent_instance_forbidden_for_provider",
						"Non-agent provider dispatch cannot carry an AgentInstance",
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
		binding: AgentBindingV1,
	): Promise<ResultValue<void, FoundationError>> {
		return this.settlement.cancelAttempt({
			provider: prepared.selection.provider,
			dispatch: prepared.assembly.dispatch,
			binding,
			initialBindingEpoch: prepared.assembly.initialBindingEpoch,
			correlation: prepared.assembly.correlation,
		});
	}

	private async persistInFlight(
		prepared: SchedulerPreparedDispatchV1,
		attempt: AttemptV1,
	): Promise<ResultValue<void, FoundationError>> {
		const checked = validateAttempt(attempt);
		if (!checked.ok) return checked;
		if (checked.value.agentInstanceId !== undefined) {
			return Result.err(
				new FoundationError("agent_instance_forbidden_for_provider", "Non-agent Attempt cannot carry an AgentInstance", {
					details: { attemptId: checked.value.attemptId },
				}),
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
				new FoundationError("invalid_correlation", "Provider-created Attempt does not match its Dispatch, Binding, or epoch", {
					details: { attemptId: checked.value.attemptId, dispatchId: prepared.assembly.dispatchId },
				}),
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
		attempt: AttemptV1,
		receipt: AttemptReceiptV1,
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
			(record) =>
				record.attemptId === attemptId &&
				(record.status === "in_flight" || record.status === "prepared"),
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
		if (checkedAttempt.value.agentInstanceId !== undefined) {
			return Result.err(
				new FoundationError("agent_instance_forbidden_for_provider", "Non-agent Attempt cannot carry an AgentInstance", {
					details: { attemptId: checkedAttempt.value.attemptId },
				}),
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
		const stored = validateBindingEpochV1(epochRecord.payload);
		if (!stored.ok) return stored;
		if (
			stored.value.bindingEpochId !== epochId ||
			stored.value.attemptId !== checkedAttempt.value.attemptId ||
			stored.value.taskId !== checkedAttempt.value.taskId ||
			stored.value.bindingId !== checkedAttempt.value.bindingId ||
			stored.value.ordinal !== 0 ||
			stored.value.activationReason !== "attempt_started" ||
			stored.value.agentInstanceId !== undefined
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
		const correlation = createExecutionCorrelation(this.sessionId, this.laneId, {
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
			...(queueEntry.goalId === undefined && checkedBinding.value.goalId === undefined
				? {}
				: { goalId: queueEntry.goalId ?? checkedBinding.value.goalId }),
		});
		return Result.ok({
			provider: registered.provider,
			dispatch: checkedDispatch.value,
			binding: checkedBinding.value,
			initialBindingEpoch: stored.value,
			correlation,
		});
	}
}

export function isSchedulerDispatchErrorCode(value: unknown): value is SchedulerErrorCodeV1 {
	return typeof value === "string" && isSchedulerErrorCode(value);
}
