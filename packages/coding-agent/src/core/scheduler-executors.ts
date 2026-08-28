/**
 * Scheduler v1 executor registry, selection, and Host in-process provider (T3).
 *
 * The durable source of truth for an opt-in exact choice is the immutable
 * selection fact owned by `SchedulerSelectionReservationStore`. The legacy,
 * default-off path retains its in-memory `SchedulerSelectionFactV1` journal.
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
	type AgentBinding,
	type Attempt,
	type AttemptReceipt,
	type AttemptReceiptUsage,
	type Budget,
	type BudgetUsage,
	type ConnectorCapabilitySnapshot,
	canonicalFoundationJson,
	createAttempt,
	type Dispatch,
	type Fingerprint,
	FoundationError,
	type FoundationProviderCapability,
	type FoundationProviderExecutionOptions,
	fingerprintFoundationValue,
	type QuotaAttribution,
	type QuotaProvider,
	type QuotaReservation,
	Result,
	type Result as ResultValue,
	type SchedulerTaskExecutorProvider,
	type TaskExecutorAttemptContext,
	type TaskExecutorProvider,
	validateAttemptReceiptForProvider,
	validateAttemptReceiptUsage,
	validateBudget,
	validateBudgetUsage,
	validateConnectorCapabilitySnapshot,
	validateFingerprint,
	validateImmutableAgentBinding,
	validateQuotaAttribution,
} from "@aos-agent/agent-core";
import {
	parseSchedulerExecutorEntry,
	parseSchedulerQueueEntry,
	parseSchedulerSelectionFact,
	SCHEDULER_PROVIDER_CLASSES,
	SCHEDULER_SESSION_MAX_ACTIVE_ATTEMPTS,
	type SchedulerExecutorEntryV1,
	type SchedulerProviderClassV1,
	type SchedulerQueueEntryV1,
	type SchedulerSelectionFactV1,
	type SchedulerSelectionScoreV1,
	serializeSchedulerExecutorEntry,
	serializeSchedulerSelectionFact,
} from "./scheduler.ts";
import {
	createSchedulerDurableSelectionFactV1,
	type SchedulerDurableSelectionFactV1,
	type SchedulerSelectionBeginSettlementV1,
	type SchedulerSelectionCandidateDecisionV1,
	type SchedulerSelectionDecisionInputsV1,
	type SchedulerSelectionRejectionStageV1,
	type SchedulerSelectionReservationRecordV1,
	type SchedulerSelectionReservationStore,
	type SchedulerSelectionSettlementReasonV1,
} from "./scheduler-selection-reservations.ts";

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
	/** Required only when the registry owns durable exact selection. */
	readonly runtimeSnapshot?: SchedulerExecutorRuntimeSnapshotV1;
	/** Durable selection owns this quota reservation; providers must not reserve it again. */
	readonly quota?: QuotaProvider;
	readonly budget?: Budget;
}

export interface SchedulerExecutorRuntimeSnapshotV1 {
	readonly schemaVersion: 1;
	readonly capabilitySnapshot: ConnectorCapabilitySnapshot;
	readonly configRevision: Fingerprint;
	readonly bindingRequirementDigests: readonly Fingerprint[];
	readonly toolSelectionDigests: readonly Fingerprint[];
	readonly policyRevisionDigests: readonly Fingerprint[];
	readonly reviewRevisionDigests: readonly Fingerprint[];
	readonly credentialTargetRefs: readonly string[];
	readonly sandboxTargetRefs: readonly string[];
	readonly observedAt: string;
	readonly expiresAt: string;
	readonly digest: Fingerprint;
}

export interface SchedulerExactExecutorRequirementsV1 {
	readonly binding: AgentBinding;
	readonly attemptId: string;
	readonly bindingEpochId: string;
	readonly agentInstanceId?: string;
	readonly requireResume: boolean;
	readonly modelAccess: ConnectorCapabilitySnapshot["modelAccess"];
	readonly reviewRevision?: Fingerprint;
	readonly credentialTargetRefs?: readonly string[];
	readonly sandboxTargetRefs?: readonly string[];
}

export interface SchedulerExecutorRegistryOptionsV1 {
	readonly reservationStore?: SchedulerSelectionReservationStore;
}

export type SchedulerSelectionSettlementUsageV1 = AttemptReceiptUsage | Readonly<Record<string, never>>;

export interface SchedulerExecutorSelectionInputV1 {
	readonly queueEntry: SchedulerQueueEntryV1;
	readonly requiredCapabilities?: readonly FoundationProviderCapability[];
	readonly sessionId?: string;
	readonly workspaceDigest?: Fingerprint;
	readonly decidedAt: string;
	readonly signal?: AbortSignal;
	/** Enables the durable exact-selection path. Required by a registry with a reservation store. */
	readonly exactRequirements?: SchedulerExactExecutorRequirementsV1;
}

export interface SchedulerExecutorSelectionResultV1 {
	readonly fact: SchedulerSelectionFactV1;
	readonly entry: SchedulerExecutorEntryV1;
	readonly provider: TaskExecutorProvider;
	readonly catalogPayload: SchedulerExecutorSelectedCatalogPayloadV1;
	readonly durableFact?: SchedulerDurableSelectionFactV1;
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

function capabilitySatisfied(
	have: readonly FoundationProviderCapability[],
	required: FoundationProviderCapability,
): boolean {
	return have.some((item) => item.id === required.id && item.version >= required.version);
}

function copyCapabilities(value: readonly FoundationProviderCapability[]): FoundationProviderCapability[] {
	return value
		.map((item) => ({ schemaVersion: 1 as const, id: item.id, version: item.version }))
		.sort(compareCapabilities);
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
	if (value !== null && typeof value === "object") {
		if (seen.has(value)) return value;
		seen.add(value);
		for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child, seen);
		Object.freeze(value);
	}
	return value;
}

function isFingerprint(value: unknown): value is Fingerprint {
	return validateFingerprint(value).ok;
}

function fingerprintKey(value: Fingerprint): string {
	return `${value.algorithm}:${value.value}`;
}

function normalizedFingerprints(
	values: readonly Fingerprint[],
	field: string,
): ResultValue<readonly Fingerprint[], FoundationError> {
	if (!Array.isArray(values) || values.some((value) => !isFingerprint(value))) {
		return Result.err(
			new FoundationError("foundation_schema_invalid_shape", `Scheduler ${field} must contain fingerprints.`),
		);
	}
	const byKey = new Map(
		values.map((value) => [fingerprintKey(value), { algorithm: "sha256" as const, value: value.value }]),
	);
	return Result.ok(deepFreeze([...byKey.values()].sort((left, right) => left.value.localeCompare(right.value))));
}

const SAFE_TARGET_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;

function normalizedTargetRefs(
	values: readonly string[],
	field: string,
): ResultValue<readonly string[], FoundationError> {
	if (
		!Array.isArray(values) ||
		values.some((value) => typeof value !== "string" || !SAFE_TARGET_REFERENCE.test(value))
	) {
		return Result.err(
			new FoundationError(
				"foundation_schema_invalid_shape",
				`Scheduler ${field} must contain safe target references.`,
			),
		);
	}
	return Result.ok(deepFreeze([...new Set(values)].sort()));
}

function runtimeSnapshotBase(
	value: Omit<SchedulerExecutorRuntimeSnapshotV1, "digest">,
): Omit<SchedulerExecutorRuntimeSnapshotV1, "digest"> {
	return value;
}

export function createSchedulerExecutorRuntimeSnapshotV1(
	input: Omit<SchedulerExecutorRuntimeSnapshotV1, "digest">,
): ResultValue<SchedulerExecutorRuntimeSnapshotV1, FoundationError> {
	const capabilitySnapshot = validateConnectorCapabilitySnapshot(input.capabilitySnapshot);
	if (!capabilitySnapshot.ok) return capabilitySnapshot;
	if (!isFingerprint(input.configRevision)) {
		return Result.err(
			new FoundationError("foundation_schema_invalid_shape", "Scheduler config revision must be a fingerprint."),
		);
	}
	const bindingRequirementDigests = normalizedFingerprints(
		input.bindingRequirementDigests,
		"binding requirement digests",
	);
	if (!bindingRequirementDigests.ok) return bindingRequirementDigests;
	const toolSelectionDigests = normalizedFingerprints(input.toolSelectionDigests, "tool selection digests");
	if (!toolSelectionDigests.ok) return toolSelectionDigests;
	const policyRevisionDigests = normalizedFingerprints(input.policyRevisionDigests, "policy revision digests");
	if (!policyRevisionDigests.ok) return policyRevisionDigests;
	const reviewRevisionDigests = normalizedFingerprints(input.reviewRevisionDigests, "review revision digests");
	if (!reviewRevisionDigests.ok) return reviewRevisionDigests;
	const credentialTargetRefs = normalizedTargetRefs(input.credentialTargetRefs, "credential target refs");
	if (!credentialTargetRefs.ok) return credentialTargetRefs;
	const sandboxTargetRefs = normalizedTargetRefs(input.sandboxTargetRefs, "sandbox target refs");
	if (!sandboxTargetRefs.ok) return sandboxTargetRefs;
	const observedAt = Date.parse(input.observedAt);
	const expiresAt = Date.parse(input.expiresAt);
	if (!Number.isFinite(observedAt) || !Number.isFinite(expiresAt) || expiresAt <= observedAt) {
		return Result.err(
			new FoundationError("foundation_schema_invalid_shape", "Scheduler runtime snapshot timestamps are invalid."),
		);
	}
	const base = deepFreeze(
		runtimeSnapshotBase({
			schemaVersion: 1,
			capabilitySnapshot: capabilitySnapshot.value,
			configRevision: { algorithm: "sha256", value: input.configRevision.value },
			bindingRequirementDigests: bindingRequirementDigests.value,
			toolSelectionDigests: toolSelectionDigests.value,
			policyRevisionDigests: policyRevisionDigests.value,
			reviewRevisionDigests: reviewRevisionDigests.value,
			credentialTargetRefs: credentialTargetRefs.value,
			sandboxTargetRefs: sandboxTargetRefs.value,
			observedAt: input.observedAt,
			expiresAt: input.expiresAt,
		}),
	);
	return Result.ok(deepFreeze({ ...base, digest: fingerprintFoundationValue(base) }));
}

function validateSchedulerExecutorRuntimeSnapshotV1(
	value: SchedulerExecutorRuntimeSnapshotV1,
): ResultValue<SchedulerExecutorRuntimeSnapshotV1, FoundationError> {
	if (
		value === null ||
		typeof value !== "object" ||
		Array.isArray(value) ||
		Object.keys(value).sort().join("\u001f") !==
			[
				"bindingRequirementDigests",
				"capabilitySnapshot",
				"configRevision",
				"credentialTargetRefs",
				"digest",
				"expiresAt",
				"observedAt",
				"policyRevisionDigests",
				"reviewRevisionDigests",
				"sandboxTargetRefs",
				"schemaVersion",
				"toolSelectionDigests",
			]
				.sort()
				.join("\u001f") ||
		value.schemaVersion !== 1 ||
		!isFingerprint(value.digest)
	) {
		return Result.err(
			new FoundationError("foundation_schema_invalid_shape", "Scheduler runtime snapshot has an invalid shape."),
		);
	}
	const { digest: _digest, ...base } = value;
	const rebuilt = createSchedulerExecutorRuntimeSnapshotV1(runtimeSnapshotBase(base));
	if (!rebuilt.ok) return rebuilt;
	if (rebuilt.value.digest.value !== value.digest.value) {
		return Result.err(
			new FoundationError(
				"foundation_schema_invalid_shape",
				"Scheduler runtime snapshot digest does not match its fields.",
			),
		);
	}
	return rebuilt;
}

export function schedulerBindingRequirementDigestV1(value: AgentBinding): ResultValue<Fingerprint, FoundationError> {
	const binding = validateImmutableAgentBinding(value);
	if (!binding.ok) return binding;
	const {
		fingerprint: _fingerprint,
		mcpSelection: _mcpSelection,
		policyRevision: _policyRevision,
		...requirements
	} = binding.value;
	return Result.ok(fingerprintFoundationValue(requirements));
}

function exactDecisionInputs(
	requirements: SchedulerExactExecutorRequirementsV1,
): ResultValue<SchedulerSelectionDecisionInputsV1, FoundationError> {
	const binding = validateImmutableAgentBinding(requirements.binding);
	if (!binding.ok) return binding;
	if (
		typeof requirements.requireResume !== "boolean" ||
		!["none", "agent_owned", "aos_gateway"].includes(requirements.modelAccess) ||
		typeof requirements.attemptId !== "string" ||
		requirements.attemptId.length === 0 ||
		typeof requirements.bindingEpochId !== "string" ||
		requirements.bindingEpochId.length === 0 ||
		(requirements.agentInstanceId !== undefined &&
			(typeof requirements.agentInstanceId !== "string" || requirements.agentInstanceId.length === 0)) ||
		(requirements.reviewRevision !== undefined && !isFingerprint(requirements.reviewRevision))
	) {
		return Result.err(
			new FoundationError("foundation_schema_invalid_shape", "Scheduler exact executor requirements are invalid."),
		);
	}
	const credentialTargetRefs = normalizedTargetRefs(requirements.credentialTargetRefs ?? [], "credential target refs");
	if (!credentialTargetRefs.ok) return credentialTargetRefs;
	const sandboxTargetRefs = normalizedTargetRefs(requirements.sandboxTargetRefs ?? [], "sandbox target refs");
	if (!sandboxTargetRefs.ok) return sandboxTargetRefs;
	const bindingRequirementDigest = schedulerBindingRequirementDigestV1(binding.value);
	if (!bindingRequirementDigest.ok) return bindingRequirementDigest;
	if (!isFingerprint(binding.value.policyRevision.fingerprint)) {
		return Result.err(
			new FoundationError(
				"binding_required_fact",
				"Scheduler exact requirements need a fingerprinted policy revision.",
			),
		);
	}
	return Result.ok(
		deepFreeze({
			requireResume: requirements.requireResume,
			modelAccess: requirements.modelAccess,
			bindingRequirementDigest: bindingRequirementDigest.value,
			toolSelectionDigest: binding.value.mcpSelection.digest,
			toolGatewayRequired: binding.value.mcpSelection.servers.some((server) => server.tools.length > 0),
			policyRevisionDigest: binding.value.policyRevision.fingerprint,
			...(requirements.reviewRevision === undefined ? {} : { reviewRevisionDigest: requirements.reviewRevision }),
			credentialTargetRefs: credentialTargetRefs.value,
			sandboxTargetRefs: sandboxTargetRefs.value,
		}),
	);
}

function includesFingerprint(values: readonly Fingerprint[], required: Fingerprint): boolean {
	return values.some((value) => fingerprintKey(value) === fingerprintKey(required));
}

function runtimeRejectionStage(
	registration: SchedulerExecutorRegistrationV1,
	decisionInputs: SchedulerSelectionDecisionInputsV1,
	requiredCapabilities: readonly FoundationProviderCapability[],
	decidedAt: string,
): SchedulerSelectionRejectionStageV1 | undefined {
	const runtime = registration.runtimeSnapshot;
	if (
		registration.trusted !== true ||
		runtime === undefined ||
		runtime.capabilitySnapshot.providerId !== registration.entry.descriptor.providerId ||
		Date.parse(runtime.expiresAt) <= Date.parse(decidedAt) ||
		(decisionInputs.requireResume && !runtime.capabilitySnapshot.resume)
	) {
		return "resume_replay";
	}
	if (runtime.capabilitySnapshot.modelAccess !== decisionInputs.modelAccess) return "model_access";
	if (
		!requiredCapabilities.every((required) => capabilitySatisfied(registration.entry.capabilities, required)) ||
		!includesFingerprint(runtime.bindingRequirementDigests, decisionInputs.bindingRequirementDigest) ||
		(decisionInputs.toolGatewayRequired &&
			(!runtime.capabilitySnapshot.toolGateway ||
				!includesFingerprint(runtime.toolSelectionDigests, decisionInputs.toolSelectionDigest)))
	) {
		return "binding_tools";
	}
	if (
		!includesFingerprint(runtime.policyRevisionDigests, decisionInputs.policyRevisionDigest) ||
		(decisionInputs.reviewRevisionDigest !== undefined &&
			!includesFingerprint(runtime.reviewRevisionDigests, decisionInputs.reviewRevisionDigest))
	) {
		return "policy_review";
	}
	if (
		decisionInputs.credentialTargetRefs.some((target) => !runtime.credentialTargetRefs.includes(target)) ||
		decisionInputs.sandboxTargetRefs.some((target) => !runtime.sandboxTargetRefs.includes(target))
	) {
		return "credential_sandbox";
	}
	return undefined;
}

function schedulerSelectionBudgetUsageV1(
	value: SchedulerSelectionSettlementUsageV1,
): ResultValue<BudgetUsage, FoundationError> {
	if (Object.keys(value).length === 0) return Result.ok({});
	const canonical = validateAttemptReceiptUsage(value);
	if (!canonical.ok) return canonical;
	const tokens =
		canonical.value.inputTokens +
		canonical.value.outputTokens +
		canonical.value.cacheReadInputTokens +
		canonical.value.cacheCreationInputTokens;
	if (!Number.isSafeInteger(tokens)) {
		return Result.err(
			new FoundationError(
				"foundation_schema_invalid_shape",
				"Canonical AttemptReceipt usage exceeds safe quota bounds.",
			),
		);
	}
	return validateBudgetUsage({ tokens, costUsd: canonical.value.costUsd });
}

/** Quota ownerKind is fixed by provider class; task_executor is Host-owned. */
export function schedulerQuotaOwnerKind(providerClass: SchedulerProviderClassV1): QuotaAttribution["ownerKind"] {
	if (providerClass === "task_executor" || providerClass === "scheduler") return "host";
	if (providerClass === "agent") return "agent_executor";
	return "external_connector";
}

function isSchedulerProviderClass(value: string): value is SchedulerProviderClassV1 {
	return (SCHEDULER_PROVIDER_CLASSES as readonly string[]).includes(value);
}

export function scoreSchedulerExecutorV1(
	candidate: SchedulerExecutorCandidateV1,
	input: Pick<SchedulerExecutorSelectionInputV1, "sessionId" | "workspaceDigest">,
): number {
	const cost =
		candidate.entry.costClass === "local"
			? SCHEDULER_EXECUTOR_SCORE_COST_LOCAL
			: SCHEDULER_EXECUTOR_SCORE_COST_REMOTE;
	const latency = Math.max(
		0,
		SCHEDULER_EXECUTOR_SCORE_LATENCY_MAX - Math.floor(candidate.latencyMs / SCHEDULER_EXECUTOR_SCORE_LATENCY_STEP_MS),
	);
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
	if (!(SCHEDULER_PROVIDER_CLASSES as readonly string[]).includes(candidate.entry.descriptor.providerClass))
		return false;
	if (candidate.trusted !== true) return false;
	return requiredCapabilities.every((required) => capabilitySatisfied(candidate.entry.capabilities, required));
}

function executorHasCapacity(candidate: SchedulerExecutorCandidateV1): boolean {
	return candidate.load < candidate.maxConcurrency;
}

function selectionInputs(
	candidates: readonly SchedulerExecutorCandidateV1[],
	input: SchedulerExecutorSelectionInputV1,
	requiredCapabilities: readonly FoundationProviderCapability[],
) {
	return {
		queueEntryId: input.queueEntry.queueEntryId,
		taskId: input.queueEntry.taskId,
		requiredCapabilities: copyCapabilities(requiredCapabilities),
		sessionId: input.sessionId ?? null,
		workspaceDigest:
			input.workspaceDigest === undefined
				? null
				: { algorithm: input.workspaceDigest.algorithm, value: input.workspaceDigest.value },
		candidates: [...candidates]
			.map((candidate) => ({
				providerId: candidate.entry.descriptor.providerId,
				providerClass: candidate.entry.descriptor.providerClass,
				costClass: candidate.entry.costClass,
				capabilities: copyCapabilities(candidate.entry.capabilities),
				affinity:
					candidate.entry.affinity === undefined
						? null
						: {
								...(candidate.entry.affinity.sessionId === undefined
									? {}
									: { sessionId: candidate.entry.affinity.sessionId }),
								...(candidate.entry.affinity.workspaceDigest === undefined
									? {}
									: {
											workspaceDigest: {
												algorithm: candidate.entry.affinity.workspaceDigest.algorithm,
												value: candidate.entry.affinity.workspaceDigest.value,
											},
										}),
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
export function projectSchedulerSelectionFactV1(
	fact: SchedulerSelectionFactV1,
): ResultValue<SchedulerExecutorSelectedCatalogPayloadV1, FoundationError> {
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
	private readonly reservationStore: SchedulerSelectionReservationStore | undefined;
	private selectionTail: Promise<void> = Promise.resolve();

	constructor(options: SchedulerExecutorRegistryOptionsV1 = {}) {
		this.reservationStore = options.reservationStore;
	}

	durableSelectionsEnabled(): boolean {
		return this.reservationStore !== undefined;
	}

	async register(
		registration: SchedulerExecutorRegistrationV1,
	): Promise<ResultValue<SchedulerExecutorEntryV1, FoundationError>> {
		const parsed = parseSchedulerExecutorEntry(registration.entry);
		if (!parsed.ok) return parsed;
		if (typeof registration.trusted !== "boolean") {
			return Result.err(
				new FoundationError(
					"foundation_schema_invalid_shape",
					"Scheduler executor trust must be an explicit boolean",
				),
			);
		}
		if (
			!isNonNegativeInteger(registration.latencyMs) ||
			(registration.load !== undefined && !isNonNegativeInteger(registration.load))
		) {
			return Result.err(
				new FoundationError(
					"foundation_schema_invalid_shape",
					"Scheduler executor latency and load must be non-negative integers",
				),
			);
		}
		const maxConcurrency = registration.maxConcurrency ?? SCHEDULER_SESSION_MAX_ACTIVE_ATTEMPTS;
		if (!isNonNegativeInteger(maxConcurrency) || maxConcurrency < 1) {
			return Result.err(
				new FoundationError(
					"foundation_schema_invalid_shape",
					"Scheduler executor maxConcurrency must be a positive integer",
				),
			);
		}
		if (registration.provider.schemaVersion !== 1) {
			return Result.err(
				new FoundationError(
					"task_executor_invalid_provider_class",
					"Scheduler executor provider schemaVersion must be 1",
				),
			);
		}
		if (registration.provider.providerId !== parsed.value.descriptor.providerId) {
			return Result.err(
				new FoundationError(
					"task_executor_invalid_provider_class",
					"Scheduler executor provider identity does not match its descriptor",
				),
			);
		}
		if (registration.provider.providerClass !== parsed.value.descriptor.providerClass) {
			return Result.err(
				new FoundationError(
					"task_executor_invalid_provider_class",
					"Scheduler executor provider class does not match its descriptor",
				),
			);
		}
		if (!(SCHEDULER_PROVIDER_CLASSES as readonly string[]).includes(registration.provider.providerClass)) {
			return Result.err(
				new FoundationError(
					"task_executor_invalid_provider_class",
					"Only scheduler executor provider classes may be registered",
				),
			);
		}
		let runtimeSnapshot: SchedulerExecutorRuntimeSnapshotV1 | undefined;
		if (registration.runtimeSnapshot !== undefined) {
			const checkedRuntime = validateSchedulerExecutorRuntimeSnapshotV1(registration.runtimeSnapshot);
			if (!checkedRuntime.ok) return checkedRuntime;
			if (checkedRuntime.value.capabilitySnapshot.providerId !== parsed.value.descriptor.providerId) {
				return Result.err(
					new FoundationError(
						"foundation_schema_invalid_shape",
						"Scheduler runtime snapshot provider identity does not match registration.",
					),
				);
			}
			runtimeSnapshot = checkedRuntime.value;
		}
		if (this.reservationStore !== undefined && runtimeSnapshot === undefined) {
			return schedulerFail("scheduler_no_executor");
		}
		if (registration.budget !== undefined) {
			const budget = validateBudget(registration.budget);
			if (!budget.ok) return budget;
			if (registration.quota === undefined) {
				return Result.err(
					new FoundationError(
						"foundation_schema_invalid_shape",
						"Scheduler registration budget requires a quota provider.",
					),
				);
			}
		}
		const liveCapabilities = await registration.provider.capabilities();
		const liveCoverDeclared = parsed.value.capabilities.every((required) =>
			capabilitySatisfied(liveCapabilities, required),
		);
		if (!liveCoverDeclared) return schedulerFail("scheduler_no_executor");
		if (this.byId.has(parsed.value.descriptor.providerId)) return schedulerFail("scheduler_queue_conflict");
		const stored: SchedulerExecutorRegistrationV1 = {
			entry: serializeSchedulerExecutorEntry(parsed.value),
			provider: registration.provider,
			trusted: registration.trusted,
			latencyMs: registration.latencyMs,
			load: registration.load ?? 0,
			maxConcurrency,
			...(runtimeSnapshot === undefined ? {} : { runtimeSnapshot }),
			...(registration.quota === undefined ? {} : { quota: registration.quota }),
			...(registration.budget === undefined ? {} : { budget: { ...registration.budget } }),
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
			if (canonicalFoundationJson(replayed) !== canonicalFoundationJson(stored))
				return schedulerFail("scheduler_queue_conflict");
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
		return found === undefined
			? undefined
			: {
					...found,
					entry: serializeSchedulerExecutorEntry(found.entry),
					...(found.runtimeSnapshot === undefined ? {} : { runtimeSnapshot: found.runtimeSnapshot }),
					...(found.budget === undefined ? {} : { budget: { ...found.budget } }),
				};
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

	async select(
		input: SchedulerExecutorSelectionInputV1,
	): Promise<ResultValue<SchedulerExecutorSelectionResultV1, FoundationError>> {
		if (this.reservationStore !== undefined) {
			return this.serializeSelection(() => this.selectDurable(input, this.reservationStore!));
		}
		const parsedQueue = parseSchedulerQueueEntry(input.queueEntry);
		if (!parsedQueue.ok) return parsedQueue;
		const existing = this.factsByQueueEntryId.get(parsedQueue.value.queueEntryId);
		const fact =
			existing === undefined ? this.persistNewSelection(input) : this.replayExistingSelection(parsedQueue.value);
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

	async reservationRecord(
		queueEntryId: string,
	): Promise<ResultValue<SchedulerSelectionReservationRecordV1 | undefined, FoundationError>> {
		if (this.reservationStore === undefined) return Result.ok(undefined);
		return this.reservationStore.get(queueEntryId);
	}

	async settleSelection(
		queueEntryId: string,
		reason: SchedulerSelectionSettlementReasonV1,
		usage: SchedulerSelectionSettlementUsageV1 = {},
	): Promise<ResultValue<void, FoundationError>> {
		if (this.reservationStore === undefined) return Result.ok(undefined);
		const budgetUsage = schedulerSelectionBudgetUsageV1(usage);
		if (!budgetUsage.ok) return budgetUsage;
		const current = await this.reservationStore.get(queueEntryId);
		if (!current.ok) return current;
		if (current.value === undefined) return schedulerFail("scheduler_not_found");
		const begun = await this.reservationStore.beginSettlement(queueEntryId, reason, budgetUsage.value);
		if (!begun.ok) return begun;
		return this.completeSelectionSettlement(begun.value);
	}

	async reconcileReservations(activeQueueEntryIds: readonly string[]): Promise<ResultValue<void, FoundationError>> {
		if (this.reservationStore === undefined) return Result.ok(undefined);
		const interrupted = await this.reservationStore.markInterruptedSettlementsForReconciliation();
		if (!interrupted.ok) return interrupted;
		const records = await this.reservationStore.list();
		if (!records.ok) return records;
		const active = new Set(activeQueueEntryIds);
		for (const record of records.value) {
			if (record.status === "reconcile_required") {
				const resumed = await this.reservationStore.resumeSettlement(record.fact.queueEntryId);
				if (!resumed.ok) return resumed;
				const settled = await this.completeSelectionSettlement(resumed.value);
				if (!settled.ok) return settled;
				continue;
			}
			if (record.status !== "reserved" || active.has(record.fact.queueEntryId)) continue;
			const settled = await this.settleSelection(record.fact.queueEntryId, "restart_reconciled");
			if (!settled.ok) return settled;
		}
		return Result.ok(undefined);
	}

	private async completeSelectionSettlement(
		begun: SchedulerSelectionBeginSettlementV1,
	): Promise<ResultValue<void, FoundationError>> {
		if (this.reservationStore === undefined) return Result.ok(undefined);
		const registration = this.byId.get(begun.record.fact.chosenProviderId);
		const quotaReservation = begun.record.fact.quotaReservation;
		if (quotaReservation === undefined) {
			const finished = await this.reservationStore.finishSettlement(begun.record.fact.queueEntryId, true);
			return finished.ok ? Result.ok(undefined) : Result.err(finished.error);
		}
		if (!begun.shouldSettleQuota) return Result.ok(undefined);
		if (registration?.quota === undefined) {
			await this.reservationStore.finishSettlement(begun.record.fact.queueEntryId, false);
			return schedulerFail("scheduler_executor_unavailable");
		}
		let settled: ResultValue<BudgetUsage, FoundationError>;
		try {
			settled = await registration.quota.settle(quotaReservation, begun.record.usage ?? {});
		} catch (error) {
			settled = Result.err(
				new FoundationError("scheduler_budget_exhausted_wait", "Scheduler quota settlement failed.", {
					retryable: true,
					cause: error,
				}),
			);
		}
		if (!settled.ok) {
			await this.reservationStore.finishSettlement(begun.record.fact.queueEntryId, false);
			return Result.err(
				new FoundationError("scheduler_budget_exhausted_wait", "Scheduler quota settlement failed.", {
					retryable: true,
					cause: settled.error,
				}),
			);
		}
		const finished = await this.reservationStore.finishSettlement(begun.record.fact.queueEntryId, true);
		return finished.ok ? Result.ok(undefined) : finished;
	}

	private async serializeSelection<T>(
		operation: () => Promise<ResultValue<T, FoundationError>>,
	): Promise<ResultValue<T, FoundationError>> {
		const current = this.selectionTail.then(operation, operation);
		this.selectionTail = current.then(
			() => undefined,
			() => undefined,
		);
		try {
			return await current;
		} catch (error) {
			return Result.err(
				new FoundationError("scheduler_persistence_failed", "Scheduler durable selection failed.", {
					cause: error,
				}),
			);
		}
	}

	private async selectDurable(
		input: SchedulerExecutorSelectionInputV1,
		store: SchedulerSelectionReservationStore,
	): Promise<ResultValue<SchedulerExecutorSelectionResultV1, FoundationError>> {
		const queue = parseSchedulerQueueEntry(input.queueEntry);
		if (!queue.ok) return queue;
		if (input.exactRequirements === undefined) {
			return Result.err(
				new FoundationError(
					"foundation_schema_invalid_shape",
					"Durable Scheduler selection requires exact binding requirements.",
				),
			);
		}
		const binding = validateImmutableAgentBinding(input.exactRequirements.binding);
		if (!binding.ok) return binding;
		if (binding.value.taskId !== queue.value.taskId) return schedulerFail("scheduler_queue_conflict");
		const decisionInputs = exactDecisionInputs(input.exactRequirements);
		if (!decisionInputs.ok) return decisionInputs;
		const requiredCapabilities = copyCapabilities(input.requiredCapabilities ?? []);
		const requestDigest = fingerprintFoundationValue({
			schemaVersion: 1,
			queueEntryId: queue.value.queueEntryId,
			taskId: queue.value.taskId,
			goalId: queue.value.goalId ?? null,
			attemptId: input.exactRequirements.attemptId,
			bindingId: binding.value.bindingId,
			bindingEpochId: input.exactRequirements.bindingEpochId,
			agentInstanceId: input.exactRequirements.agentInstanceId ?? null,
			requiredCapabilities,
			sessionId: input.sessionId ?? null,
			workspaceDigest: input.workspaceDigest ?? null,
			decisionInputs: decisionInputs.value,
		});
		const existing = await store.get(queue.value.queueEntryId);
		if (!existing.ok) return existing;
		if (existing.value !== undefined) {
			return this.replayDurableSelection(queue.value, requestDigest, existing.value, input.decidedAt);
		}
		const activeCounts = await store.activeCounts();
		if (!activeCounts.ok) return activeCounts;
		const registrations = [...this.byId.values()].sort((left, right) =>
			left.entry.descriptor.providerId.localeCompare(right.entry.descriptor.providerId),
		);
		const decisions: SchedulerSelectionCandidateDecisionV1[] = [];
		const runnable: SchedulerExecutorCandidateV1[] = [];
		for (const registration of registrations) {
			const runtime = registration.runtimeSnapshot;
			if (runtime === undefined) continue;
			const stage = runtimeRejectionStage(registration, decisionInputs.value, requiredCapabilities, input.decidedAt);
			const load = activeCounts.value.get(registration.entry.descriptor.providerId) ?? 0;
			const maxConcurrency = registration.maxConcurrency ?? SCHEDULER_SESSION_MAX_ACTIVE_ATTEMPTS;
			const capacityStage = stage === undefined && load >= maxConcurrency ? ("capacity_quota" as const) : stage;
			const candidate: SchedulerExecutorCandidateV1 = {
				entry: registration.entry,
				trusted: registration.trusted,
				latencyMs: registration.latencyMs,
				load,
				maxConcurrency,
			};
			const score = capacityStage === undefined ? scoreSchedulerExecutorV1(candidate, input) : undefined;
			decisions.push(
				deepFreeze({
					providerId: registration.entry.descriptor.providerId,
					capabilityRevision: runtime.capabilitySnapshot.revision,
					capabilityDigest: runtime.capabilitySnapshot.digest,
					configRevision: runtime.configRevision,
					accepted: capacityStage === undefined,
					...(capacityStage === undefined ? {} : { rejectionStage: capacityStage }),
					...(score === undefined ? {} : { score }),
				}),
			);
			if (capacityStage === undefined) runnable.push(candidate);
		}
		if (runnable.length === 0) {
			const capacityBlocked = decisions.some((decision) => decision.rejectionStage === "capacity_quota");
			if (capacityBlocked) return schedulerFail("scheduler_backpressure", true);
			return Result.err(
				new FoundationError(
					"scheduler_no_executor",
					"No eligible scheduler executor satisfies the exact requirements.",
					{
						details: {
							rejections: decisions.map((decision) => ({
								providerId: decision.providerId,
								stage: decision.rejectionStage ?? "capacity_quota",
							})),
						},
					},
				),
			);
		}
		const scores: SchedulerSelectionScoreV1[] = runnable
			.map((candidate) => ({
				providerId: candidate.entry.descriptor.providerId,
				score: scoreSchedulerExecutorV1(candidate, input),
			}))
			.sort(compareScores);
		const chosenScore = scores[0];
		if (chosenScore === undefined) return schedulerFail("scheduler_no_executor");
		const registration = this.byId.get(chosenScore.providerId);
		const runtime = registration?.runtimeSnapshot;
		if (registration === undefined || runtime === undefined) return schedulerFail("scheduler_executor_unavailable");
		const providerClass = registration.entry.descriptor.providerClass;
		if (!isSchedulerProviderClass(providerClass)) return schedulerFail("scheduler_executor_unavailable");
		const agentInstanceId = providerClass === "agent" ? input.exactRequirements.agentInstanceId : undefined;
		if (providerClass === "agent" && agentInstanceId === undefined) {
			return Result.err(
				new FoundationError(
					"agent_instance_required_for_agent_provider",
					"Durable Scheduler agent selection requires an exact AgentInstance identity.",
				),
			);
		}
		let quotaReservation: QuotaReservation | undefined;
		if (registration.quota !== undefined) {
			const attribution = validateQuotaAttribution({
				schemaVersion: 1,
				taskId: queue.value.taskId,
				...(queue.value.goalId === undefined ? {} : { goalId: queue.value.goalId }),
				attemptId: input.exactRequirements.attemptId,
				...(agentInstanceId === undefined ? {} : { agentInstanceId }),
				providerId: registration.entry.descriptor.providerId,
				ownerKind: schedulerQuotaOwnerKind(providerClass),
			});
			if (!attribution.ok) return attribution;
			let reserved: ResultValue<QuotaReservation, FoundationError>;
			try {
				reserved = await registration.quota.reserve(
					attribution.value,
					registration.budget ?? binding.value.budget,
					input.signal === undefined ? {} : { signal: input.signal },
				);
			} catch (error) {
				reserved = Result.err(
					new FoundationError("scheduler_budget_exhausted_wait", "Scheduler quota reservation failed.", {
						retryable: true,
						cause: error,
					}),
				);
			}
			if (!reserved.ok) {
				return Result.err(
					new FoundationError(
						"scheduler_budget_exhausted_wait",
						"Scheduler concurrency or quota is exhausted; keep the entry queued.",
						{ retryable: true, cause: reserved.error },
					),
				);
			}
			quotaReservation = reserved.value;
		}
		const reservationId = `scheduler_reservation_${
			fingerprintFoundationValue({
				queueEntryId: queue.value.queueEntryId,
				requestDigest,
				providerId: registration.entry.descriptor.providerId,
				attemptId: input.exactRequirements.attemptId,
			}).value
		}`;
		const durableFact = createSchedulerDurableSelectionFactV1({
			schemaVersion: 1,
			queueEntryId: queue.value.queueEntryId,
			taskId: queue.value.taskId,
			requestDigest,
			chosenProviderId: registration.entry.descriptor.providerId,
			chosenProviderClass: providerClass,
			attemptId: input.exactRequirements.attemptId,
			bindingId: binding.value.bindingId,
			bindingEpochId: input.exactRequirements.bindingEpochId,
			...(agentInstanceId === undefined ? {} : { agentInstanceId }),
			capabilityRevision: runtime.capabilitySnapshot.revision,
			capabilityDigest: runtime.capabilitySnapshot.digest,
			configRevision: runtime.configRevision,
			decisionInputs: decisionInputs.value,
			candidateDecisions: decisions,
			scores,
			reservationId,
			...(quotaReservation === undefined ? {} : { quotaReservation }),
			decidedAt: input.decidedAt,
		});
		if (!durableFact.ok) {
			if (quotaReservation !== undefined) await this.releaseUnpersistedQuota(registration, quotaReservation);
			return durableFact;
		}
		const reserved = await store.reserve(
			durableFact.value,
			registration.maxConcurrency ?? SCHEDULER_SESSION_MAX_ACTIVE_ATTEMPTS,
		);
		if (!reserved.ok) {
			if (quotaReservation !== undefined) await this.releaseUnpersistedQuota(registration, quotaReservation);
			return reserved;
		}
		return this.selectionResultFromDurable(durableFact.value, registration);
	}

	private async replayDurableSelection(
		queueEntry: SchedulerQueueEntryV1,
		requestDigest: Fingerprint,
		record: SchedulerSelectionReservationRecordV1,
		decidedAt: string,
	): Promise<ResultValue<SchedulerExecutorSelectionResultV1, FoundationError>> {
		if (record.fact.taskId !== queueEntry.taskId) return schedulerFail("scheduler_queue_conflict");
		const registration = this.byId.get(record.fact.chosenProviderId);
		const runtime = registration?.runtimeSnapshot;
		const stale =
			record.status !== "reserved" ||
			record.fact.requestDigest.value !== requestDigest.value ||
			registration === undefined ||
			runtime === undefined ||
			registration.entry.descriptor.providerClass !== record.fact.chosenProviderClass ||
			Date.parse(runtime.expiresAt) <= Date.parse(decidedAt) ||
			runtime.capabilitySnapshot.revision !== record.fact.capabilityRevision ||
			runtime.capabilitySnapshot.digest.value !== record.fact.capabilityDigest.value ||
			runtime.configRevision.value !== record.fact.configRevision.value;
		if (stale) {
			if (record.status === "reserved") {
				await this.settleSelection(record.fact.queueEntryId, "restart_reconciled");
			}
			return schedulerFail("scheduler_executor_unavailable");
		}
		return this.selectionResultFromDurable(record.fact, registration);
	}

	private selectionResultFromDurable(
		durableFact: SchedulerDurableSelectionFactV1,
		registration: SchedulerExecutorRegistrationV1,
	): ResultValue<SchedulerExecutorSelectionResultV1, FoundationError> {
		const fact: SchedulerSelectionFactV1 = {
			schemaVersion: 1,
			queueEntryId: durableFact.queueEntryId,
			taskId: durableFact.taskId,
			chosenProviderId: durableFact.chosenProviderId,
			scores: durableFact.scores,
			inputsDigest: durableFact.requestDigest,
			decidedAt: durableFact.decidedAt,
		};
		const parsed = parseSchedulerSelectionFact(serializeSchedulerSelectionFact(fact));
		if (!parsed.ok) return parsed;
		this.factsByQueueEntryId.set(parsed.value.queueEntryId, serializeSchedulerSelectionFact(parsed.value));
		const catalogPayload = projectSchedulerSelectionFactV1(parsed.value);
		if (!catalogPayload.ok) return catalogPayload;
		return Result.ok({
			fact: parsed.value,
			entry: serializeSchedulerExecutorEntry(registration.entry),
			provider: registration.provider,
			catalogPayload: catalogPayload.value,
			durableFact,
		});
	}

	private async releaseUnpersistedQuota(
		registration: SchedulerExecutorRegistrationV1,
		reservation: QuotaReservation,
	): Promise<void> {
		if (registration.quota === undefined) return;
		try {
			await registration.quota.settle(reservation, {});
		} catch {
			// The reserve was never published; one bounded settlement attempt is the only safe action.
		}
	}

	private persistNewSelection(
		input: SchedulerExecutorSelectionInputV1,
	): ResultValue<SchedulerSelectionFactV1, FoundationError> {
		const selected = selectSchedulerExecutorV1(this.candidates(), input);
		if (!selected.ok) return selected;
		return this.persistSelectionFact(selected.value);
	}

	private replayExistingSelection(
		queueEntry: SchedulerQueueEntryV1,
	): ResultValue<SchedulerSelectionFactV1, FoundationError> {
		const replayed = this.replaySelectionFact(queueEntry.queueEntryId);
		if (!replayed.ok) return replayed;
		if (replayed.value.taskId !== queueEntry.taskId) return schedulerFail("scheduler_queue_conflict");
		return replayed;
	}
}

function inProcessCapability(): FoundationProviderCapability {
	return { schemaVersion: 1, id: SCHEDULER_IN_PROCESS_CAPABILITY_ID, version: 1 };
}

function receiptCorrelation(
	attempt: Attempt,
	options: FoundationProviderExecutionOptions | undefined,
	attemptReceiptId: string,
) {
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
		if (context === undefined)
			return Result.err(
				new FoundationError("invalid_correlation", "In-process scheduler executor requires attempt context"),
			);
		if (context.agentInstance !== undefined || context.initialBindingEpoch.agentInstanceId !== undefined) {
			return Result.err(
				new FoundationError(
					"agent_instance_forbidden_for_provider",
					"In-process scheduler executor cannot carry an AgentInstance",
				),
			);
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
				return Result.err(
					new FoundationError(
						"agent_instance_forbidden_for_provider",
						"In-process scheduler executor cannot carry an AgentInstance",
					),
				);
			}
			if (attempt.providerId !== this.providerId) {
				return Result.err(
					new FoundationError(
						"task_executor_invalid_provider_class",
						"Attempt provider identity does not match the in-process executor",
					),
				);
			}
			const attemptReceiptId = `attempt_receipt_${attempt.attemptId}`;
			const correlation = receiptCorrelation(attempt, options, attemptReceiptId);
			if (correlation === undefined) {
				return Result.err(
					new FoundationError(
						"invalid_correlation",
						"In-process scheduler executor requires Host execution correlation without AgentInstance",
					),
				);
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
			let work: ResultValue<SchedulerHostAttemptWorkV1, FoundationError>;
			try {
				work = await this.hostAttemptRunner(attempt, options);
			} catch (error) {
				work = Result.err(
					new FoundationError("scheduler_executor_unavailable", "Scheduler Host attempt runner failed.", {
						details: { schedulerFailure: "runner_throw" },
						cause: error,
					}),
				);
			}
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
		let reserved: ResultValue<QuotaReservation, FoundationError>;
		try {
			reserved = await this.quota.reserve(
				checkedAttribution.value,
				this.budget,
				options?.signal === undefined ? {} : { signal: options.signal },
			);
		} catch (error) {
			reserved = Result.err(
				new FoundationError("scheduler_budget_exhausted_wait", "Scheduler quota reservation failed.", {
					retryable: true,
					cause: error,
				}),
			);
		}
		if (!reserved.ok) {
			return Result.err(
				new FoundationError(
					"scheduler_budget_exhausted_wait",
					"Scheduler concurrency or quota is exhausted; keep the entry queued.",
					{ retryable: true, cause: reserved.error },
				),
			);
		}
		let work: ResultValue<SchedulerHostAttemptWorkV1, FoundationError>;
		try {
			work = await this.hostAttemptRunner(attempt, options);
		} catch (error) {
			work = Result.err(
				new FoundationError("scheduler_executor_unavailable", "Scheduler Host attempt runner failed.", {
					details: { schedulerFailure: "runner_throw" },
					cause: error,
				}),
			);
		}
		const usage = work.ok ? validateBudgetUsage(work.value.usage) : Result.ok({});
		const settledUsage = usage.ok ? usage.value : {};
		let settled: ResultValue<BudgetUsage, FoundationError>;
		try {
			settled = await this.quota.settle(reserved.value, settledUsage);
		} catch (error) {
			settled = Result.err(
				new FoundationError("scheduler_budget_exhausted_wait", "Scheduler quota settlement failed.", {
					retryable: true,
					cause: error,
				}),
			);
		}
		if (!settled.ok) {
			return Result.err(
				new FoundationError(
					"scheduler_budget_exhausted_wait",
					"Scheduler concurrency or quota is exhausted; keep the entry queued.",
					{ retryable: true, cause: settled.error },
				),
			);
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
			return Result.err(
				new FoundationError("invalid_correlation", "Host runner AttemptReceipt does not match its Attempt"),
			);
		}
		if (
			value.bindingEpochIds.length === 0 ||
			attempt.bindingEpochIds.some((id) => !value.bindingEpochIds.includes(id)) ||
			value.bindingEpochIds[0] !== attempt.bindingEpochIds[0]
		) {
			return Result.err(
				new FoundationError(
					"invalid_correlation",
					"Host runner AttemptReceipt does not retain the Attempt BindingEpoch chain",
				),
			);
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
			(provenanceCorrelation.attemptReceiptId !== undefined &&
				provenanceCorrelation.attemptReceiptId !== value.attemptReceiptId)
		) {
			return Result.err(
				new FoundationError(
					"invalid_correlation",
					"Host runner AttemptReceipt provenance does not match Host execution correlation",
				),
			);
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
		return validateAttemptReceiptForProvider(receipt, {
			providerId: this.providerId,
			providerClass: this.providerClass,
		});
	}
}
