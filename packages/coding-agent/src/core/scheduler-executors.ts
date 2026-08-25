/**
 * Scheduler v1 executor registry, selection, and Host in-process provider (T3).
 *
 * The durable source of truth for a choice is `SchedulerSelectionFactV1`.
 * This module persists and replays the full fact in an in-memory journal
 * keyed by `queueEntryId` via `serializeSchedulerSelectionFact` round-trip.
 * Catalog event `scheduler.executor_selected` is a flattening projection
 * only (digest hex + scoreCount) and is never a second authority. Selection
 * applies hard capability and trust filters, then deterministic
 * cost/latency/load/affinity scoring, and fails closed with no Host fallback
 * when none remain. The Host in-process TaskExecutor requires an injected
 * attempt-runner seam; a missing runner fails closed and never mints an
 * empty succeeded receipt. T4 binds that seam. Quota reserve wraps the
 * runner, settles the `BudgetUsage` returned by work, and `runAttempt`
 * propagates the runner's provider-valid `AttemptReceiptV1` after identity
 * and schema checks. Cancellation may still mint a local cancelled receipt.
 * This module does not register a production Scheduler, scan Task Graph,
 * tick, or settle TaskResult/RunReceipt.
 */
import {
	FoundationError,
	Result,
	canonicalFoundationJson,
	createAttempt,
	fingerprintFoundationValue,
	validateAttemptReceiptForProvider,
	validateBudgetUsage,
	validateQuotaAttribution,
	type AgentBinding,
	type AttemptReceipt,
	type Attempt,
	type BudgetUsage,
	type Budget,
	type Dispatch,
	type Fingerprint,
	type FoundationProviderCapability,
	type FoundationProviderExecutionOptions,
	type QuotaAttribution,
	type QuotaProvider,
	type Result as ResultValue,
	type SchedulerTaskExecutorProvider,
	type TaskExecutorAttemptContext,
	type TaskExecutorProvider,
} from "@aos-agent/agent-core";
import {
	SCHEDULER_PROVIDER_CLASSES,
	SCHEDULER_SESSION_MAX_ACTIVE_ATTEMPTS,
	parseSchedulerExecutorEntry,
	parseSchedulerQueueEntry,
	parseSchedulerSelectionFact,
	serializeSchedulerExecutorEntry,
	serializeSchedulerSelectionFact,
	type SchedulerExecutorEntryV1,
	type SchedulerProviderClassV1,
	type SchedulerQueueEntryV1,
	type SchedulerSelectionFactV1,
	type SchedulerSelectionScoreV1,
} from "./scheduler.ts";

export const SCHEDULER_IN_PROCESS_PROVIDER_ID = "aos.builtin.in-process";
export const SCHEDULER_IN_PROCESS_CAPABILITY_ID = "foundation.task-executor";

export const SCHEDULER_EXECUTOR_SCORE_COST_LOCAL = 8;
export const SCHEDULER_EXECUTOR_SCORE_COST_REMOTE = 0;
export const SCHEDULER_EXECUTOR_SCORE_LATENCY_MAX = 4;
export const SCHEDULER_EXECUTOR_SCORE_LATENCY_STEP_MS = 250;
export const SCHEDULER_EXECUTOR_SCORE_LOAD_MAX = 4;
export const SCHEDULER_EXECUTOR_SCORE_AFFINITY_SESSION = 4;
export const SCHEDULER_EXECUTOR_SCORE_AFFINITY_WORKSPACE = 2;

export interface SchedulerExecutorCandidateV1 {
	readonly entry: SchedulerExecutorEntryV1;
	readonly trusted: boolean;
	readonly latencyMs: number;
	readonly load: number;
	readonly maxConcurrency: number;
}

export interface SchedulerExecutorRegistrationV1 {
	readonly entry: SchedulerExecutorEntryV1;
	readonly provider: TaskExecutorProvider;
	readonly trusted: boolean;
	readonly latencyMs: number;
	readonly load?: number;
	readonly maxConcurrency?: number;
}

export interface SchedulerExecutorSelectionInputV1 {
	readonly queueEntry: SchedulerQueueEntryV1;
	readonly requiredCapabilities?: readonly FoundationProviderCapability[];
	readonly sessionId?: string;
	readonly workspaceDigest?: Fingerprint;
	readonly decidedAt: string;
}

export interface SchedulerExecutorSelectionResultV1 {
	readonly fact: SchedulerSelectionFactV1;
	readonly entry: SchedulerExecutorEntryV1;
	readonly provider: TaskExecutorProvider;
	readonly catalogPayload: SchedulerExecutorSelectedCatalogPayloadV1;
}

export interface SchedulerExecutorSelectedCatalogPayloadV1 {
	readonly schemaVersion: 1;
	readonly queueEntryId: string;
	readonly taskId: string;
	readonly chosenProviderId: string;
	readonly inputsDigest: string;
	readonly decidedAt: string;
	readonly scoreCount: number;
}

export interface SchedulerHostAttemptWorkV1 {
	readonly usage: BudgetUsage;
	readonly receipt: AttemptReceipt;
}

/** Host attempt-runner seam. T4 binds production work; a missing runner fails closed. */
export type SchedulerHostAttemptRunnerV1 = (
	attempt: Attempt,
	options?: FoundationProviderExecutionOptions,
) => Promise<ResultValue<SchedulerHostAttemptWorkV1, FoundationError>>;

export interface SchedulerInProcessTaskExecutorOptionsV1 {
	readonly providerId?: string;
	readonly quota?: QuotaProvider;
	readonly now?: () => string;
	readonly budget?: Budget;
	readonly hostAttemptRunner?: SchedulerHostAttemptRunnerV1;
}

function schedulerFail<T>(
	code:
		| "scheduler_no_executor"
		| "scheduler_backpressure"
		| "scheduler_budget_exhausted_wait"
		| "scheduler_queue_conflict"
		| "scheduler_executor_unavailable"
		| "scheduler_not_found",
	retryable = false,
): ResultValue<T, FoundationError> {
	const messages = {
		scheduler_no_executor: "No eligible scheduler executor is available.",
		scheduler_backpressure: "Scheduler queue or concurrency limit is exceeded.",
		scheduler_budget_exhausted_wait: "Scheduler concurrency or quota is exhausted; keep the entry queued.",
		scheduler_queue_conflict: "Scheduler queue business key already has a different payload.",
		scheduler_executor_unavailable: "The selected scheduler executor is unavailable.",
		scheduler_not_found: "Scheduler record was not found.",
	} as const;
	return Result.err(new FoundationError(code, messages[code], { retryable }));
}

function isNonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && Number.isFinite(value) && value >= 0;
}

function compareCapabilities(left: FoundationProviderCapability, right: FoundationProviderCapability): number {
	return left.id < right.id ? -1 : left.id > right.id ? 1 : left.version - right.version;
}

function capabilitySatisfied(have: readonly FoundationProviderCapability[], required: FoundationProviderCapability): boolean {
	return have.some((item) => item.id === required.id && item.version >= required.version);
}

function copyCapabilities(value: readonly FoundationProviderCapability[]): FoundationProviderCapability[] {
	return value.map((item) => ({ schemaVersion: 1 as const, id: item.id, version: item.version })).sort(compareCapabilities);
}

/** Quota ownerKind is fixed by provider class; task_executor is Host-owned. */
export function schedulerQuotaOwnerKind(providerClass: SchedulerProviderClassV1): QuotaAttribution["ownerKind"] {
	if (providerClass === "task_executor" || providerClass === "scheduler") return "host";
	if (providerClass === "agent") return "agent_executor";
	return "external_connector";
}

export function scoreSchedulerExecutorV1(
	candidate: SchedulerExecutorCandidateV1,
	input: Pick<SchedulerExecutorSelectionInputV1, "sessionId" | "workspaceDigest">,
): number {
	const cost = candidate.entry.costClass === "local" ? SCHEDULER_EXECUTOR_SCORE_COST_LOCAL : SCHEDULER_EXECUTOR_SCORE_COST_REMOTE;
	const latency = Math.max(0, SCHEDULER_EXECUTOR_SCORE_LATENCY_MAX - Math.floor(candidate.latencyMs / SCHEDULER_EXECUTOR_SCORE_LATENCY_STEP_MS));
	const load = Math.max(0, SCHEDULER_EXECUTOR_SCORE_LOAD_MAX - candidate.load);
	const sessionMatch = input.sessionId !== undefined && candidate.entry.affinity?.sessionId === input.sessionId;
	const workspaceMatch =
		input.workspaceDigest !== undefined &&
		candidate.entry.affinity?.workspaceDigest !== undefined &&
		candidate.entry.affinity.workspaceDigest.algorithm === input.workspaceDigest.algorithm &&
		candidate.entry.affinity.workspaceDigest.value === input.workspaceDigest.value;
	const affinity =
		(sessionMatch ? SCHEDULER_EXECUTOR_SCORE_AFFINITY_SESSION : 0) +
		(workspaceMatch ? SCHEDULER_EXECUTOR_SCORE_AFFINITY_WORKSPACE : 0);
	return cost + latency + load + affinity;
}

export function executorPassesHardFiltersV1(
	candidate: SchedulerExecutorCandidateV1,
	requiredCapabilities: readonly FoundationProviderCapability[],
): boolean {
	if (!(SCHEDULER_PROVIDER_CLASSES as readonly string[]).includes(candidate.entry.descriptor.providerClass)) return false;
	if (candidate.trusted !== true) return false;
	return requiredCapabilities.every((required) => capabilitySatisfied(candidate.entry.capabilities, required));
}

function executorHasCapacity(candidate: SchedulerExecutorCandidateV1): boolean {
	return candidate.load < candidate.maxConcurrency;
}

function selectionInputs(candidates: readonly SchedulerExecutorCandidateV1[], input: SchedulerExecutorSelectionInputV1, requiredCapabilities: readonly FoundationProviderCapability[]) {
	return {
		queueEntryId: input.queueEntry.queueEntryId,
		taskId: input.queueEntry.taskId,
		requiredCapabilities: copyCapabilities(requiredCapabilities),
		sessionId: input.sessionId ?? null,
		workspaceDigest: input.workspaceDigest === undefined ? null : { algorithm: input.workspaceDigest.algorithm, value: input.workspaceDigest.value },
		candidates: [...candidates]
			.map((candidate) => ({
				providerId: candidate.entry.descriptor.providerId,
				providerClass: candidate.entry.descriptor.providerClass,
				costClass: candidate.entry.costClass,
				capabilities: copyCapabilities(candidate.entry.capabilities),
				affinity: candidate.entry.affinity === undefined
					? null
					: {
						...(candidate.entry.affinity.sessionId === undefined ? {} : { sessionId: candidate.entry.affinity.sessionId }),
						...(candidate.entry.affinity.workspaceDigest === undefined
							? {}
							: { workspaceDigest: { algorithm: candidate.entry.affinity.workspaceDigest.algorithm, value: candidate.entry.affinity.workspaceDigest.value } }),
					},
				trusted: candidate.trusted === true,
				latencyMs: candidate.latencyMs,
				load: candidate.load,
				maxConcurrency: candidate.maxConcurrency,
			}))
			.sort((left, right) => (left.providerId < right.providerId ? -1 : 1)),
	};
}

function compareScores(left: SchedulerSelectionScoreV1, right: SchedulerSelectionScoreV1): number {
	if (left.score !== right.score) return right.score - left.score;
	return left.providerId < right.providerId ? -1 : left.providerId > right.providerId ? 1 : 0;
}

/** Pure selection. Empty hard-filter set is `scheduler_no_executor`; capacity exhaustion is backpressure. */
export function selectSchedulerExecutorV1(
	candidates: readonly SchedulerExecutorCandidateV1[],
	input: SchedulerExecutorSelectionInputV1,
): ResultValue<SchedulerSelectionFactV1, FoundationError> {
	const parsedQueue = parseSchedulerQueueEntry(input.queueEntry);
	if (!parsedQueue.ok) return parsedQueue;
	const seenProviderIds = new Set<string>();
	for (const candidate of candidates) {
		const providerId = candidate.entry.descriptor.providerId;
		if (seenProviderIds.has(providerId)) return schedulerFail("scheduler_queue_conflict");
		seenProviderIds.add(providerId);
	}
	const requiredCapabilities = input.requiredCapabilities ?? [];
	const hardEligible = candidates.filter((candidate) => executorPassesHardFiltersV1(candidate, requiredCapabilities));
	if (hardEligible.length === 0) return schedulerFail("scheduler_no_executor");
	const runnable = hardEligible.filter(executorHasCapacity);
	if (runnable.length === 0) return schedulerFail("scheduler_backpressure", true);
	const scores: SchedulerSelectionScoreV1[] = runnable
		.map((candidate) => ({
			providerId: candidate.entry.descriptor.providerId,
			score: scoreSchedulerExecutorV1(candidate, input),
		}))
		.sort(compareScores);
	const chosen = scores[0];
	if (chosen === undefined) return schedulerFail("scheduler_no_executor");
	const fact: SchedulerSelectionFactV1 = {
		schemaVersion: 1,
		queueEntryId: parsedQueue.value.queueEntryId,
		taskId: parsedQueue.value.taskId,
		chosenProviderId: chosen.providerId,
		scores,
		inputsDigest: fingerprintFoundationValue(selectionInputs(candidates, input, requiredCapabilities)),
		decidedAt: input.decidedAt,
	};
	return parseSchedulerSelectionFact(serializeSchedulerSelectionFact(fact));
}

/** Flatten the durable selection fact into the catalog event payload. Scores stay on the fact. */
export function projectSchedulerSelectionFactV1(fact: SchedulerSelectionFactV1): ResultValue<SchedulerExecutorSelectedCatalogPayloadV1, FoundationError> {
	const parsed = parseSchedulerSelectionFact(fact);
	if (!parsed.ok) return parsed;
	return Result.ok({
		schemaVersion: 1,
		queueEntryId: parsed.value.queueEntryId,
		taskId: parsed.value.taskId,
		chosenProviderId: parsed.value.chosenProviderId,
		inputsDigest: parsed.value.inputsDigest.value,
		decidedAt: parsed.value.decidedAt,
		scoreCount: parsed.value.scores.length,
	});
}

export class SchedulerExecutorRegistry {
	private readonly byId = new Map<string, SchedulerExecutorRegistrationV1>();
	private readonly factsByQueueEntryId = new Map<string, SchedulerSelectionFactV1>();

	async register(registration: SchedulerExecutorRegistrationV1): Promise<ResultValue<SchedulerExecutorEntryV1, FoundationError>> {
		const parsed = parseSchedulerExecutorEntry(registration.entry);
		if (!parsed.ok) return parsed;
		if (typeof registration.trusted !== "boolean") {
			return Result.err(new FoundationError("foundation_schema_invalid_shape", "Scheduler executor trust must be an explicit boolean"));
		}
		if (!isNonNegativeInteger(registration.latencyMs) || (registration.load !== undefined && !isNonNegativeInteger(registration.load))) {
			return Result.err(new FoundationError("foundation_schema_invalid_shape", "Scheduler executor latency and load must be non-negative integers"));
		}
		const maxConcurrency = registration.maxConcurrency ?? SCHEDULER_SESSION_MAX_ACTIVE_ATTEMPTS;
		if (!isNonNegativeInteger(maxConcurrency) || maxConcurrency < 1) {
			return Result.err(new FoundationError("foundation_schema_invalid_shape", "Scheduler executor maxConcurrency must be a positive integer"));
		}
		if (registration.provider.schemaVersion !== 1) {
			return Result.err(new FoundationError("task_executor_invalid_provider_class", "Scheduler executor provider schemaVersion must be 1"));
		}
		if (registration.provider.providerId !== parsed.value.descriptor.providerId) {
			return Result.err(new FoundationError("task_executor_invalid_provider_class", "Scheduler executor provider identity does not match its descriptor"));
		}
		if (registration.provider.providerClass !== parsed.value.descriptor.providerClass) {
			return Result.err(new FoundationError("task_executor_invalid_provider_class", "Scheduler executor provider class does not match its descriptor"));
		}
		if (!(SCHEDULER_PROVIDER_CLASSES as readonly string[]).includes(registration.provider.providerClass)) {
			return Result.err(new FoundationError("task_executor_invalid_provider_class", "Only scheduler executor provider classes may be registered"));
		}
		const liveCapabilities = await registration.provider.capabilities();
		const liveCoverDeclared = parsed.value.capabilities.every((required) => capabilitySatisfied(liveCapabilities, required));
		if (!liveCoverDeclared) return schedulerFail("scheduler_no_executor");
		if (this.byId.has(parsed.value.descriptor.providerId)) return schedulerFail("scheduler_queue_conflict");
		const stored: SchedulerExecutorRegistrationV1 = {
			entry: serializeSchedulerExecutorEntry(parsed.value),
			provider: registration.provider,
			trusted: registration.trusted,
			latencyMs: registration.latencyMs,
			load: registration.load ?? 0,
			maxConcurrency,
		};
		this.byId.set(stored.entry.descriptor.providerId, stored);
		return Result.ok(stored.entry);
	}

	persistSelectionFact(fact: SchedulerSelectionFactV1): ResultValue<SchedulerSelectionFactV1, FoundationError> {
		const parsed = parseSchedulerSelectionFact(serializeSchedulerSelectionFact(fact));
		if (!parsed.ok) return parsed;
		const stored = serializeSchedulerSelectionFact(parsed.value);
		const existing = this.factsByQueueEntryId.get(stored.queueEntryId);
		if (existing !== undefined) {
			const replayed = serializeSchedulerSelectionFact(existing);
			if (canonicalFoundationJson(replayed) !== canonicalFoundationJson(stored)) return schedulerFail("scheduler_queue_conflict");
			return parseSchedulerSelectionFact(serializeSchedulerSelectionFact(replayed));
		}
		this.factsByQueueEntryId.set(stored.queueEntryId, stored);
		return parseSchedulerSelectionFact(serializeSchedulerSelectionFact(stored));
	}

	replaySelectionFact(queueEntryId: string): ResultValue<SchedulerSelectionFactV1, FoundationError> {
		const stored = this.factsByQueueEntryId.get(queueEntryId);
		if (stored === undefined) return schedulerFail("scheduler_not_found");
		return parseSchedulerSelectionFact(serializeSchedulerSelectionFact(stored));
	}

	get(providerId: string): SchedulerExecutorRegistrationV1 | undefined {
		const found = this.byId.get(providerId);
		return found === undefined ? undefined : { ...found, entry: serializeSchedulerExecutorEntry(found.entry) };
	}

	list(): readonly SchedulerExecutorEntryV1[] {
		return [...this.byId.values()].map((item) => serializeSchedulerExecutorEntry(item.entry));
	}

	candidates(): readonly SchedulerExecutorCandidateV1[] {
		return [...this.byId.values()].map((item) => ({
			entry: serializeSchedulerExecutorEntry(item.entry),
			trusted: item.trusted,
			latencyMs: item.latencyMs,
			load: item.load ?? 0,
			maxConcurrency: item.maxConcurrency ?? SCHEDULER_SESSION_MAX_ACTIVE_ATTEMPTS,
		}));
	}

	async select(input: SchedulerExecutorSelectionInputV1): Promise<ResultValue<SchedulerExecutorSelectionResultV1, FoundationError>> {
		const parsedQueue = parseSchedulerQueueEntry(input.queueEntry);
		if (!parsedQueue.ok) return parsedQueue;
		const existing = this.factsByQueueEntryId.get(parsedQueue.value.queueEntryId);
		const fact = existing === undefined
			? this.persistNewSelection(input)
			: this.replayExistingSelection(parsedQueue.value);
		if (!fact.ok) return fact;
		const registered = this.byId.get(fact.value.chosenProviderId);
		if (registered === undefined) return schedulerFail("scheduler_executor_unavailable");
		const catalogPayload = projectSchedulerSelectionFactV1(fact.value);
		if (!catalogPayload.ok) return catalogPayload;
		return Result.ok({
			fact: fact.value,
			entry: serializeSchedulerExecutorEntry(registered.entry),
			provider: registered.provider,
			catalogPayload: catalogPayload.value,
		});
	}

	private persistNewSelection(input: SchedulerExecutorSelectionInputV1): ResultValue<SchedulerSelectionFactV1, FoundationError> {
		const selected = selectSchedulerExecutorV1(this.candidates(), input);
		if (!selected.ok) return selected;
		return this.persistSelectionFact(selected.value);
	}

	private replayExistingSelection(queueEntry: SchedulerQueueEntryV1): ResultValue<SchedulerSelectionFactV1, FoundationError> {
		const replayed = this.replaySelectionFact(queueEntry.queueEntryId);
		if (!replayed.ok) return replayed;
		if (replayed.value.taskId !== queueEntry.taskId) return schedulerFail("scheduler_queue_conflict");
		return replayed;
	}
}

function inProcessCapability(): FoundationProviderCapability {
	return { schemaVersion: 1, id: SCHEDULER_IN_PROCESS_CAPABILITY_ID, version: 1 };
}

function receiptCorrelation(attempt: Attempt, options: FoundationProviderExecutionOptions | undefined, attemptReceiptId: string) {
	const correlation = options?.correlation;
	if (
		correlation === undefined ||
		correlation.sessionId.length === 0 ||
		correlation.laneId.length === 0 ||
		correlation.taskId !== attempt.taskId ||
		correlation.dispatchId !== attempt.dispatchId ||
		correlation.attemptId !== attempt.attemptId ||
		correlation.bindingId !== attempt.bindingId ||
		correlation.bindingEpochId !== attempt.bindingEpochIds[0] ||
		correlation.agentInstanceId !== undefined
	) {
		return undefined;
	}
	return { ...correlation, attemptReceiptId };
}

/** Host in-process TaskExecutor. Not an Agent provider and not CodingAgentTaskExecutorProvider. */
export class SchedulerInProcessTaskExecutorProvider implements SchedulerTaskExecutorProvider {
	readonly schemaVersion = 1 as const;
	readonly providerId: string;
	readonly providerClass = "task_executor" as const;
	private readonly quota: QuotaProvider | undefined;
	private readonly now: () => string;
	private readonly budget: Budget;
	private readonly hostAttemptRunner: SchedulerHostAttemptRunnerV1 | undefined;
	private readonly cancelled = new Set<string>();

	constructor(options: SchedulerInProcessTaskExecutorOptionsV1 = {}) {
		this.providerId = options.providerId ?? SCHEDULER_IN_PROCESS_PROVIDER_ID;
		this.quota = options.quota;
		this.now = options.now ?? (() => new Date().toISOString());
		this.budget = options.budget ?? {};
		this.hostAttemptRunner = options.hostAttemptRunner;
	}

	async capabilities(): Promise<readonly FoundationProviderCapability[]> {
		return [inProcessCapability()];
	}

	async createAttempt(dispatch: Dispatch, _binding: AgentBinding, context?: TaskExecutorAttemptContext) {
		if (context === undefined) return Result.err(new FoundationError("invalid_correlation", "In-process scheduler executor requires attempt context"));
		if (context.agentInstance !== undefined || context.initialBindingEpoch.agentInstanceId !== undefined) {
			return Result.err(new FoundationError("agent_instance_forbidden_for_provider", "In-process scheduler executor cannot carry an AgentInstance"));
		}
		return createAttempt({
			attemptId: context.initialBindingEpoch.attemptId,
			dispatch,
			providerId: this.providerId,
			initialBindingEpoch: context.initialBindingEpoch,
			providerClass: this.providerClass,
			now: this.now,
		});
	}

	async runAttempt(attempt: Attempt, options?: FoundationProviderExecutionOptions) {
		try {
			if (attempt.agentInstanceId !== undefined) {
				return Result.err(new FoundationError("agent_instance_forbidden_for_provider", "In-process scheduler executor cannot carry an AgentInstance"));
			}
			if (attempt.providerId !== this.providerId) {
				return Result.err(new FoundationError("task_executor_invalid_provider_class", "Attempt provider identity does not match the in-process executor"));
			}
			const attemptReceiptId = `attempt_receipt_${attempt.attemptId}`;
			const correlation = receiptCorrelation(attempt, options, attemptReceiptId);
			if (correlation === undefined) {
				return Result.err(new FoundationError("invalid_correlation", "In-process scheduler executor requires Host execution correlation without AgentInstance"));
			}
			const aborted = (): boolean => this.cancelled.has(attempt.attemptId) || options?.signal?.aborted === true;
			if (aborted()) {
				return this.settle(attempt, attemptReceiptId, correlation, "cancelled");
			}
			const work = await this.runHostWork(attempt, options);
			if (!work.ok) return work;
			if (aborted()) {
				return this.settle(attempt, attemptReceiptId, correlation, "cancelled");
			}
			return this.acceptHostRunnerReceipt(work.value.receipt, attempt, correlation);
		} finally {
			this.cancelled.delete(attempt.attemptId);
		}
	}

	async cancelAttempt(attemptId: string) {
		this.cancelled.add(attemptId);
		return Result.ok(undefined);
	}

	async dispose(): Promise<void> {}

	private async runHostWork(
		attempt: Attempt,
		options: FoundationProviderExecutionOptions | undefined,
	): Promise<ResultValue<SchedulerHostAttemptWorkV1, FoundationError>> {
		if (this.hostAttemptRunner === undefined) return schedulerFail("scheduler_executor_unavailable");
		if (this.quota === undefined) {
			const work = await this.hostAttemptRunner(attempt, options);
			if (!work.ok) return work;
			const usage = validateBudgetUsage(work.value.usage);
			if (!usage.ok) return usage;
			return Result.ok({ usage: usage.value, receipt: work.value.receipt });
		}
		const attribution: QuotaAttribution = {
			schemaVersion: 1,
			taskId: attempt.taskId,
			attemptId: attempt.attemptId,
			providerId: this.providerId,
			ownerKind: schedulerQuotaOwnerKind(this.providerClass),
		};
		const checkedAttribution = validateQuotaAttribution(attribution);
		if (!checkedAttribution.ok) return checkedAttribution;
		const reserved = await this.quota.reserve(checkedAttribution.value, this.budget, options?.signal === undefined ? {} : { signal: options.signal });
		if (!reserved.ok) {
			return Result.err(new FoundationError("scheduler_budget_exhausted_wait", "Scheduler concurrency or quota is exhausted; keep the entry queued.", { retryable: true, cause: reserved.error }));
		}
		const work = await this.hostAttemptRunner(attempt, options);
		const usage = work.ok ? validateBudgetUsage(work.value.usage) : Result.ok({});
		const settledUsage = usage.ok ? usage.value : {};
		const settled = await this.quota.settle(reserved.value, settledUsage);
		if (!settled.ok) {
			return Result.err(new FoundationError("scheduler_budget_exhausted_wait", "Scheduler concurrency or quota is exhausted; keep the entry queued.", { retryable: true, cause: settled.error }));
		}
		if (!work.ok) return work;
		if (!usage.ok) return usage;
		return Result.ok({ usage: usage.value, receipt: work.value.receipt });
	}

	private acceptHostRunnerReceipt(
		receipt: AttemptReceipt,
		attempt: Attempt,
		expected: NonNullable<ReturnType<typeof receiptCorrelation>>,
	): ResultValue<AttemptReceipt, FoundationError> {
		const checked = validateAttemptReceiptForProvider(receipt, {
			providerId: this.providerId,
			providerClass: this.providerClass,
		});
		if (!checked.ok) return checked;
		const value = checked.value;
		if (
			value.providerId !== this.providerId ||
			value.provenance.providerId !== this.providerId ||
			value.taskId !== attempt.taskId ||
			value.dispatchId !== attempt.dispatchId ||
			value.attemptId !== attempt.attemptId ||
			value.bindingId !== attempt.bindingId ||
			value.agentInstanceId !== undefined
		) {
			return Result.err(new FoundationError("invalid_correlation", "Host runner AttemptReceipt does not match its Attempt"));
		}
		if (
			value.bindingEpochIds.length === 0 ||
			attempt.bindingEpochIds.some((id) => !value.bindingEpochIds.includes(id)) ||
			value.bindingEpochIds[0] !== attempt.bindingEpochIds[0]
		) {
			return Result.err(new FoundationError("invalid_correlation", "Host runner AttemptReceipt does not retain the Attempt BindingEpoch chain"));
		}
		const provenanceCorrelation = value.provenance.correlation;
		if (
			provenanceCorrelation === undefined ||
			provenanceCorrelation.sessionId !== expected.sessionId ||
			provenanceCorrelation.laneId !== expected.laneId ||
			provenanceCorrelation.taskId !== expected.taskId ||
			provenanceCorrelation.dispatchId !== expected.dispatchId ||
			provenanceCorrelation.attemptId !== expected.attemptId ||
			provenanceCorrelation.bindingId !== expected.bindingId ||
			provenanceCorrelation.bindingEpochId !== expected.bindingEpochId ||
			provenanceCorrelation.agentInstanceId !== undefined ||
			(provenanceCorrelation.attemptReceiptId !== undefined && provenanceCorrelation.attemptReceiptId !== value.attemptReceiptId)
		) {
			return Result.err(new FoundationError("invalid_correlation", "Host runner AttemptReceipt provenance does not match Host execution correlation"));
		}
		return checked;
	}

	private settle(
		attempt: Attempt,
		attemptReceiptId: string,
		correlation: NonNullable<ReturnType<typeof receiptCorrelation>>,
		status: "cancelled",
	): ResultValue<AttemptReceipt, FoundationError> {
		const receipt: AttemptReceipt = {
			schemaVersion: 1,
			attemptReceiptId,
			taskId: attempt.taskId,
			dispatchId: attempt.dispatchId,
			attemptId: attempt.attemptId,
			providerId: this.providerId,
			bindingId: attempt.bindingId,
			bindingEpochIds: [...attempt.bindingEpochIds],
			status,
			workerReceiptRefs: [],
			artifacts: [],
			provenance: {
				producerKind: "scheduler",
				providerId: this.providerId,
				producedAt: this.now(),
				correlation,
			},
			sideEffectState: "none",
			error: { code: "cancelled", message: "Attempt cancelled", retryable: false },
		};
		return validateAttemptReceiptForProvider(receipt, { providerId: this.providerId, providerClass: this.providerClass });
	}
}
