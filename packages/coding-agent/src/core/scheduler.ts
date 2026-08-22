/**
 * Scheduler v1 core (T1 type / state-machine / serializer freeze).
 *
 * Pure Host-side control-plane types for line 12B. This module does not
 * register a production Scheduler, scan Task Graph, tick, claim from a
 * ledger, or construct a types-only facade. T5 is the sole later owner of
 * production tick and Graph ready-scan. Queue persistence is T2. Executor
 * registration is T3. Dispatch wiring is T4.
 *
 * Facts are typed durable `scheduler.*` catalog events on the existing
 * Session ledger. Claim fencing uses an opaque string token with the same
 * equality semantics as `LedgerWriterLeaseV1.fencingToken`, but
 * `SchedulerClaimV1` carries its own token and lease and is not that writer
 * lease. Session ledger append still uses the existing writer lease.
 *
 * Event producer for `scheduler.*` is the existing harness producer. Inbox
 * `queue.enqueued` / `queue.cancelled` are not reused.
 */
import {
	type AgentBindingV1,
	type ExecutionProviderDescriptorV1,
	type FingerprintV1,
	FoundationError,
	type FoundationErrorCode,
	type FoundationProviderCapabilityV1,
	fingerprintFoundationValue,
	type IdempotencyV1,
	isSideEffectRetryable,
	Result,
	type Result as ResultValue,
	type SideEffectStateV1,
	type TaskEnvelopeV1,
	type TaskResultV1,
} from "@aos-agent/agent-core";
import type { SchedulerDispatchOutcomeV1, SchedulerRunDispatchRequestV1 } from "./scheduler-dispatch.ts";
import type { SchedulerFanInSettlementV1, SchedulerFanInSettleRequestV1 } from "./scheduler-fan-in.ts";
import type {
	SchedulerClaimAcquireResultV1,
	SchedulerQueueSnapshotV1,
	SchedulerQueueTerminalRequestV1,
} from "./scheduler-queue.ts";
import type {
	TaskGraphListFilter,
	TaskGraphListResult,
	TaskGraphMutationResult,
	TaskGraphNodeAttachRequest,
	TaskGraphNodeSettleRequest,
	TaskGraphNodeView,
	TaskGraphRecord,
} from "./task-graph.ts";

export const SCHEDULER_SCHEMA_VERSION = 1 as const;

/** Bounded default for `TaskEnvelopeV1.attempts.max` when the envelope omits it. */
export const SCHEDULER_DEFAULT_MAX_ATTEMPTS = 3;
export const SCHEDULER_CLAIM_MIN_LEASE_TTL_MS = 1_000;
export const SCHEDULER_CLAIM_MAX_LEASE_TTL_MS = 10 * 60 * 1000;
export const SCHEDULER_QUEUE_MAX_DEPTH = 1024;
export const SCHEDULER_SESSION_MAX_ACTIVE_ATTEMPTS = 8;
export const SCHEDULER_GLOBAL_MAX_ACTIVE_ATTEMPTS = 32;
export const SCHEDULER_ID_MAX_LENGTH = 256;
export const SCHEDULER_REASON_SUMMARY_MAX_LENGTH = 64;

export const SCHEDULER_QUEUE_STATES = ["queued", "claimed", "dispatched", "settled", "cancelled", "expired"] as const;
export type SchedulerQueueStateV1 = (typeof SCHEDULER_QUEUE_STATES)[number];

export const SCHEDULER_DISPATCH_STATUSES = ["prepared", "in_flight", "settled", "cancelled", "expired"] as const;
export type SchedulerDispatchStatusV1 = (typeof SCHEDULER_DISPATCH_STATUSES)[number];

export const SCHEDULER_HANDOFF_STATES = ["offered", "accepted", "rejected", "timed_out", "cancelled"] as const;
export type SchedulerHandoffStateV1 = (typeof SCHEDULER_HANDOFF_STATES)[number];

export const SCHEDULER_MESSAGE_TYPES = [
	"handoff.offer",
	"handoff.answer",
	"result.ready",
	"result.reclaim",
	"wake",
	"note",
] as const;
export type SchedulerMessageTypeV1 = (typeof SCHEDULER_MESSAGE_TYPES)[number];

export const SCHEDULER_MESSAGE_ACK = ["none", "required"] as const;
export type SchedulerMessageAckV1 = (typeof SCHEDULER_MESSAGE_ACK)[number];

export const SCHEDULER_JOIN_POLICIES = ["require_all", "allow_partial"] as const;
export type SchedulerJoinPolicyV1 = (typeof SCHEDULER_JOIN_POLICIES)[number];

export const SCHEDULER_WAIT_EDGE_KINDS = ["dependsOn", "gate", "ask", "handoff", "claim"] as const;
export type SchedulerWaitEdgeKindV1 = (typeof SCHEDULER_WAIT_EDGE_KINDS)[number];

export const SCHEDULER_EXECUTOR_COST_CLASSES = ["local", "remote_paid"] as const;
export type SchedulerExecutorCostClassV1 = (typeof SCHEDULER_EXECUTOR_COST_CLASSES)[number];

export const SCHEDULER_PROVIDER_CLASSES = ["scheduler", "task_executor", "agent", "external_connector"] as const;
export type SchedulerProviderClassV1 = (typeof SCHEDULER_PROVIDER_CLASSES)[number];

export const SCHEDULER_ENGINE_PHASES = [
	"idle",
	"scanning",
	"enqueueing",
	"claiming",
	"reserving",
	"dispatching",
	"settling",
] as const;
export type SchedulerEnginePhaseV1 = (typeof SCHEDULER_ENGINE_PHASES)[number];

export const SCHEDULER_DURABLE_EVENT_CATEGORIES = [
	"scheduler.queue_transitioned",
	"scheduler.claim_acquired",
	"scheduler.claim_renewed",
	"scheduler.claim_released",
	"scheduler.dispatch_transitioned",
	"scheduler.executor_selected",
	"scheduler.join_recorded",
	"scheduler.message_posted",
	"scheduler.message_acked",
	"scheduler.handoff_transitioned",
	"scheduler.wake_scheduled",
	"scheduler.wake_fired",
	"scheduler.deadlock_detected",
] as const;
export type SchedulerDurableEventCategoryV1 = (typeof SCHEDULER_DURABLE_EVENT_CATEGORIES)[number];

export const SCHEDULER_ERROR_CODES = [
	"scheduler_queue_invalid",
	"scheduler_queue_conflict",
	"scheduler_claim_conflict",
	"scheduler_claim_expired",
	"scheduler_lease_lost",
	"scheduler_no_executor",
	"scheduler_executor_unavailable",
	"scheduler_budget_exhausted_wait",
	"scheduler_dispatch_invalid",
	"scheduler_attempt_recovery_failed",
	"scheduler_fanin_invalid",
	"scheduler_settlement_rejected",
	"scheduler_handoff_invalid",
	"scheduler_handoff_timeout",
	"scheduler_handoff_target_unavailable",
	"scheduler_message_invalid",
	"scheduler_message_timeout",
	"scheduler_wake_invalid",
	"scheduler_deadlock_detected",
	"scheduler_backpressure",
	"scheduler_not_found",
	"scheduler_persistence_failed",
] as const;
export type SchedulerErrorCodeV1 = (typeof SCHEDULER_ERROR_CODES)[number];

const SCHEDULER_ERROR_MESSAGES: Readonly<Record<SchedulerErrorCodeV1, string>> = {
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

const RETRYABLE_SCHEDULER_ERROR_CODES: ReadonlySet<SchedulerErrorCodeV1> = new Set([
	"scheduler_claim_conflict",
	"scheduler_budget_exhausted_wait",
	"scheduler_backpressure",
]);

export const SCHEDULER_QUEUE_TRANSITIONS: Readonly<Record<SchedulerQueueStateV1, readonly SchedulerQueueStateV1[]>> = {
	queued: ["claimed", "cancelled"],
	claimed: ["dispatched", "expired", "cancelled"],
	dispatched: ["settled", "expired", "cancelled"],
	expired: ["queued", "cancelled"],
	settled: [],
	cancelled: [],
};

export const SCHEDULER_DISPATCH_TRANSITIONS: Readonly<
	Record<SchedulerDispatchStatusV1, readonly SchedulerDispatchStatusV1[]>
> = {
	prepared: ["in_flight", "cancelled", "expired"],
	in_flight: ["settled", "cancelled", "expired"],
	settled: [],
	cancelled: [],
	expired: [],
};

export const SCHEDULER_HANDOFF_TRANSITIONS: Readonly<
	Record<SchedulerHandoffStateV1, readonly SchedulerHandoffStateV1[]>
> = {
	offered: ["accepted", "rejected", "timed_out", "cancelled"],
	accepted: [],
	rejected: [],
	timed_out: [],
	cancelled: [],
};

export const SCHEDULER_ENGINE_TRANSITIONS: Readonly<Record<SchedulerEnginePhaseV1, readonly SchedulerEnginePhaseV1[]>> =
	{
		idle: ["scanning"],
		scanning: ["enqueueing", "idle"],
		enqueueing: ["claiming", "idle"],
		claiming: ["reserving", "idle"],
		reserving: ["dispatching", "idle"],
		dispatching: ["settling", "idle"],
		settling: ["idle", "scanning"],
	};

export interface SchedulerNodeRefV1 {
	readonly taskId: string;
	readonly graphRevision: number;
	readonly nodeId: string;
}

export interface SchedulerQueueEntryV1 {
	readonly schemaVersion: 1;
	readonly queueEntryId: string;
	readonly sessionId: string;
	readonly taskId: string;
	readonly nodeRef?: SchedulerNodeRefV1;
	readonly goalId?: string;
	readonly workflowId?: string;
	readonly state: SchedulerQueueStateV1;
	readonly priority: number;
	readonly attemptsUsed: number;
	readonly notBefore?: string;
	readonly deadlineAt?: string;
	readonly claimId?: string;
	readonly enqueuedAt: string;
	readonly revision: number;
}

/**
 * Exclusive ownership of a queue entry. `fencingToken` is an opaque string
 * with the same equality semantics as `LedgerWriterLeaseV1.fencingToken`.
 * The claim carries its own lease (`acquiredAt` / `expiresAt` as canonical
 * UTC ISO timestamps) and is not a writer-lease mutex.
 */
export interface SchedulerClaimV1 {
	readonly schemaVersion: 1;
	readonly claimId: string;
	readonly queueEntryId: string;
	readonly taskId: string;
	readonly ownerId: string;
	readonly fencingToken: string;
	readonly acquiredAt: string;
	readonly expiresAt: string;
	readonly revision: number;
}

export interface SchedulerDispatchRecordV1 {
	readonly schemaVersion: 1;
	readonly queueEntryId: string;
	readonly claimId: string;
	readonly dispatchId: string;
	readonly attemptId?: string;
	readonly providerId: string;
	readonly providerClass: SchedulerProviderClassV1;
	readonly reservationId?: string;
	readonly deadlineAt?: string;
	readonly status: SchedulerDispatchStatusV1;
	readonly revision: number;
}

export interface SchedulerExecutorAffinityV1 {
	readonly sessionId?: string;
	readonly workspaceDigest?: FingerprintV1;
}

export interface SchedulerExecutorEntryV1 {
	readonly schemaVersion: 1;
	readonly descriptor: ExecutionProviderDescriptorV1;
	readonly capabilities: readonly FoundationProviderCapabilityV1[];
	readonly costClass: SchedulerExecutorCostClassV1;
	readonly affinity?: SchedulerExecutorAffinityV1;
	readonly registeredAt: string;
}

export interface SchedulerSelectionScoreV1 {
	readonly providerId: string;
	readonly score: number;
}

export interface SchedulerSelectionFactV1 {
	readonly schemaVersion: 1;
	readonly queueEntryId: string;
	readonly taskId: string;
	readonly chosenProviderId: string;
	readonly scores: readonly SchedulerSelectionScoreV1[];
	readonly inputsDigest: FingerprintV1;
	readonly decidedAt: string;
}

export interface SchedulerJoinPlanV1 {
	readonly schemaVersion: 1;
	readonly joinId: string;
	readonly taskId: string;
	readonly nodeRef?: SchedulerNodeRefV1;
	readonly policy: SchedulerJoinPolicyV1;
	readonly predecessorTaskIds: readonly string[];
	readonly createdAt: string;
}

export interface SchedulerJoinSnapshotV1 {
	readonly schemaVersion: 1;
	readonly joinId: string;
	readonly sourceAttemptReceiptIds: readonly string[];
	readonly sourceTaskResultIds: readonly string[];
	readonly policy: SchedulerJoinPolicyV1;
	readonly degradedCriterionIds: readonly string[];
	readonly settledTaskResultId?: string;
	readonly settledAt?: string;
}

export interface SchedulerMessageCorrelationV1 {
	readonly taskId?: string;
	readonly goalId?: string;
	readonly workflowId?: string;
	readonly transferId?: string;
	readonly askId?: string;
}

export interface SchedulerMessageV1 {
	readonly schemaVersion: 1;
	readonly messageId: string;
	readonly type: SchedulerMessageTypeV1;
	readonly threadId: string;
	readonly fromSessionId: string;
	readonly toSessionId: string;
	readonly correlation: SchedulerMessageCorrelationV1;
	readonly ack: SchedulerMessageAckV1;
	readonly ackedAt?: string;
	readonly expiresAt?: string;
	readonly payloadDigest?: FingerprintV1;
	readonly createdAt: string;
	readonly revision: number;
}

export interface SchedulerOwnershipTransferV1 {
	readonly schemaVersion: 1;
	readonly transferId: string;
	readonly taskId: string;
	readonly fromOwnerId: string;
	readonly toOwnerId: string;
	readonly state: SchedulerHandoffStateV1;
	readonly reasonSummary?: string;
	readonly fencingToken: string;
	readonly deadlineAt: string;
	readonly createdAt: string;
	readonly decidedAt?: string;
	readonly revision: number;
}

export interface SchedulerWakeV1 {
	readonly schemaVersion: 1;
	readonly wakeId: string;
	readonly workflowId: string;
	readonly stepId?: string;
	readonly dueAt: string;
	readonly firedAt?: string;
	readonly revision: number;
}

export interface SchedulerDeadlockFactV1 {
	readonly schemaVersion: 1;
	readonly detectionId: string;
	readonly memberTaskIds: readonly string[];
	readonly edgeKinds: readonly SchedulerWaitEdgeKindV1[];
	readonly failedTaskIds: readonly string[];
	readonly detectedAt: string;
}

export interface SchedulerEnqueueResultV1 {
	readonly entry: SchedulerQueueEntryV1;
	readonly idempotent: boolean;
}

const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const CANONICAL_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

const QUEUE_ENTRY_KEYS = new Set([
	"schemaVersion",
	"queueEntryId",
	"sessionId",
	"taskId",
	"nodeRef",
	"goalId",
	"workflowId",
	"state",
	"priority",
	"attemptsUsed",
	"notBefore",
	"deadlineAt",
	"claimId",
	"enqueuedAt",
	"revision",
]);
const NODE_REF_KEYS = new Set(["taskId", "graphRevision", "nodeId"]);
const CLAIM_KEYS = new Set([
	"schemaVersion",
	"claimId",
	"queueEntryId",
	"taskId",
	"ownerId",
	"fencingToken",
	"acquiredAt",
	"expiresAt",
	"revision",
]);
const DISPATCH_KEYS = new Set([
	"schemaVersion",
	"queueEntryId",
	"claimId",
	"dispatchId",
	"attemptId",
	"providerId",
	"providerClass",
	"reservationId",
	"deadlineAt",
	"status",
	"revision",
]);
const EXECUTOR_ENTRY_KEYS = new Set([
	"schemaVersion",
	"descriptor",
	"capabilities",
	"costClass",
	"affinity",
	"registeredAt",
]);
const DESCRIPTOR_KEYS = new Set(["schemaVersion", "providerId", "providerClass"]);
const CAPABILITY_KEYS = new Set(["schemaVersion", "id", "version"]);
const AFFINITY_KEYS = new Set(["sessionId", "workspaceDigest"]);
const FINGERPRINT_KEYS = new Set(["algorithm", "value"]);
const SELECTION_FACT_KEYS = new Set([
	"schemaVersion",
	"queueEntryId",
	"taskId",
	"chosenProviderId",
	"scores",
	"inputsDigest",
	"decidedAt",
]);
const SELECTION_SCORE_KEYS = new Set(["providerId", "score"]);
const JOIN_PLAN_KEYS = new Set([
	"schemaVersion",
	"joinId",
	"taskId",
	"nodeRef",
	"policy",
	"predecessorTaskIds",
	"createdAt",
]);
const JOIN_SNAPSHOT_KEYS = new Set([
	"schemaVersion",
	"joinId",
	"sourceAttemptReceiptIds",
	"sourceTaskResultIds",
	"policy",
	"degradedCriterionIds",
	"settledTaskResultId",
	"settledAt",
]);
const MESSAGE_KEYS = new Set([
	"schemaVersion",
	"messageId",
	"type",
	"threadId",
	"fromSessionId",
	"toSessionId",
	"correlation",
	"ack",
	"ackedAt",
	"expiresAt",
	"payloadDigest",
	"createdAt",
	"revision",
]);
const MESSAGE_CORRELATION_KEYS = new Set(["taskId", "goalId", "workflowId", "transferId", "askId"]);
const HANDOFF_KEYS = new Set([
	"schemaVersion",
	"transferId",
	"taskId",
	"fromOwnerId",
	"toOwnerId",
	"state",
	"reasonSummary",
	"fencingToken",
	"deadlineAt",
	"createdAt",
	"decidedAt",
	"revision",
]);
const WAKE_KEYS = new Set(["schemaVersion", "wakeId", "workflowId", "stepId", "dueAt", "firedAt", "revision"]);
const DEADLOCK_KEYS = new Set([
	"schemaVersion",
	"detectionId",
	"memberTaskIds",
	"edgeKinds",
	"failedTaskIds",
	"detectedAt",
]);

export const SCHEDULER_FORBIDDEN_PAYLOAD_KEYS = Object.freeze([
	"prompt",
	"message",
	"messages",
	"diff",
	"command",
	"args",
	"cwd",
	"path",
	"content",
	"stdout",
	"stderr",
	"env",
	"environment",
	"headers",
	"authorization",
	"credentials",
	"credential",
	"password",
	"secret",
	"apiKey",
	"providerError",
	"stack",
	"finalText",
	"usage",
	"output",
	"url",
	"payload",
	"callback",
	"instructions",
	"body",
	"raw",
	"data",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
	return Object.keys(value).every((key) => allowed.has(key));
}

function isSafeIdentifier(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= SCHEDULER_ID_MAX_LENGTH &&
		SAFE_IDENTIFIER_PATTERN.test(value) &&
		!value.includes("/") &&
		!value.includes("\\") &&
		!value.includes("?") &&
		!value.includes("#") &&
		!value.includes("@")
	);
}

function isCanonicalTimestamp(value: unknown): value is string {
	return typeof value === "string" && CANONICAL_TIMESTAMP_PATTERN.test(value) && !Number.isNaN(Date.parse(value));
}

function isNonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isFiniteInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && Number.isSafeInteger(value);
}

function isMember<T extends string>(value: unknown, allowed: readonly T[]): value is T {
	return typeof value === "string" && (allowed as readonly string[]).includes(value);
}

function isFingerprint(value: unknown): value is FingerprintV1 {
	return (
		isRecord(value) &&
		hasOnlyKeys(value, FINGERPRINT_KEYS) &&
		value.algorithm === "sha256" &&
		typeof value.value === "string" &&
		SHA256_HEX_PATTERN.test(value.value)
	);
}

function copyFingerprint(value: FingerprintV1): FingerprintV1 {
	return { algorithm: "sha256", value: value.value };
}

function isIdentifierList(value: unknown): value is readonly string[] {
	if (!Array.isArray(value)) return false;
	const seen = new Set<string>();
	for (const item of value) {
		if (!isSafeIdentifier(item) || seen.has(item)) return false;
		seen.add(item);
	}
	return true;
}

function copyIdentifiers(value: readonly string[]): readonly string[] {
	return [...value];
}

function schedulerError(code: SchedulerErrorCodeV1): FoundationError {
	return new FoundationError(code, SCHEDULER_ERROR_MESSAGES[code], {
		retryable: RETRYABLE_SCHEDULER_ERROR_CODES.has(code),
	});
}

function fail<T>(code: SchedulerErrorCodeV1): ResultValue<T, FoundationError> {
	return Result.err(schedulerError(code));
}

export function isSchedulerErrorCode(value: unknown): value is SchedulerErrorCodeV1 {
	return typeof value === "string" && (SCHEDULER_ERROR_CODES as readonly string[]).includes(value);
}

export function schedulerErrorRetryable(code: SchedulerErrorCodeV1): boolean {
	return RETRYABLE_SCHEDULER_ERROR_CODES.has(code);
}

export function isLegalSchedulerQueueTransition(from: SchedulerQueueStateV1, to: SchedulerQueueStateV1): boolean {
	return SCHEDULER_QUEUE_TRANSITIONS[from].includes(to);
}

export function isLegalSchedulerDispatchTransition(
	from: SchedulerDispatchStatusV1,
	to: SchedulerDispatchStatusV1,
): boolean {
	return SCHEDULER_DISPATCH_TRANSITIONS[from].includes(to);
}

export function isLegalSchedulerHandoffTransition(from: SchedulerHandoffStateV1, to: SchedulerHandoffStateV1): boolean {
	return SCHEDULER_HANDOFF_TRANSITIONS[from].includes(to);
}

export function isLegalSchedulerEngineTransition(from: SchedulerEnginePhaseV1, to: SchedulerEnginePhaseV1): boolean {
	return SCHEDULER_ENGINE_TRANSITIONS[from].includes(to);
}

export function isSchedulerQueueTerminal(state: SchedulerQueueStateV1): boolean {
	return state === "settled" || state === "cancelled";
}

export function isSchedulerDispatchTerminal(status: SchedulerDispatchStatusV1): boolean {
	return status === "settled" || status === "cancelled" || status === "expired";
}

export function isSchedulerHandoffTerminal(state: SchedulerHandoffStateV1): boolean {
	return state !== "offered";
}

/** C061 mapping: `side_effect_unknown` is never auto-retried. */
export function isSchedulerSideEffectRetryable(
	state: SideEffectStateV1,
	idempotency: IdempotencyV1 = "non_idempotent",
): boolean {
	return isSideEffectRetryable(state, idempotency);
}

export function schedulerFencingTokensEqual(left: string, right: string): boolean {
	return left === right;
}

export function isSchedulerClaimActive(claim: SchedulerClaimV1, nowIso: string): boolean {
	return Date.parse(nowIso) < Date.parse(claim.expiresAt);
}

export function schedulerNodeRefKey(nodeRef: SchedulerNodeRefV1 | undefined): string {
	if (nodeRef === undefined) return "";
	return `${nodeRef.taskId}:${nodeRef.graphRevision}:${nodeRef.nodeId}`;
}

/** Session-scoped business key. Cross-session identity requires `sessionId`. */
export function schedulerQueueBusinessKey(sessionId: string, taskId: string, nodeRef?: SchedulerNodeRefV1): string {
	return `${sessionId}\0${taskId}\0${schedulerNodeRefKey(nodeRef)}`;
}

function queueIdentityKey(entry: SchedulerQueueEntryV1): string {
	const goal = entry.goalId ?? "";
	const workflow = entry.workflowId ?? "";
	return `${schedulerQueueBusinessKey(entry.sessionId, entry.taskId, entry.nodeRef)}\0${goal}\0${workflow}`;
}

function isNodeRef(value: unknown): value is SchedulerNodeRefV1 {
	return (
		isRecord(value) &&
		hasOnlyKeys(value, NODE_REF_KEYS) &&
		isSafeIdentifier(value.taskId) &&
		isNonNegativeInteger(value.graphRevision) &&
		value.graphRevision >= 1 &&
		isSafeIdentifier(value.nodeId)
	);
}

function copyNodeRef(value: SchedulerNodeRefV1): SchedulerNodeRefV1 {
	return { taskId: value.taskId, graphRevision: value.graphRevision, nodeId: value.nodeId };
}

export function isSchedulerQueueEntry(value: unknown): value is SchedulerQueueEntryV1 {
	if (!isRecord(value) || !hasOnlyKeys(value, QUEUE_ENTRY_KEYS)) return false;
	if (value.schemaVersion !== SCHEDULER_SCHEMA_VERSION) return false;
	if (
		!isSafeIdentifier(value.queueEntryId) ||
		!isSafeIdentifier(value.sessionId) ||
		!isSafeIdentifier(value.taskId) ||
		!isMember(value.state, SCHEDULER_QUEUE_STATES) ||
		!isFiniteInteger(value.priority) ||
		!isNonNegativeInteger(value.attemptsUsed) ||
		!isCanonicalTimestamp(value.enqueuedAt) ||
		!isNonNegativeInteger(value.revision)
	) {
		return false;
	}
	if (value.nodeRef !== undefined && !isNodeRef(value.nodeRef)) return false;
	if (value.nodeRef !== undefined && value.nodeRef.taskId !== value.taskId) return false;
	if (value.goalId !== undefined && !isSafeIdentifier(value.goalId)) return false;
	if (value.workflowId !== undefined && !isSafeIdentifier(value.workflowId)) return false;
	if (value.notBefore !== undefined && !isCanonicalTimestamp(value.notBefore)) return false;
	if (value.deadlineAt !== undefined && !isCanonicalTimestamp(value.deadlineAt)) return false;
	if (value.claimId !== undefined && !isSafeIdentifier(value.claimId)) return false;
	if ((value.state === "claimed" || value.state === "dispatched") && value.claimId === undefined) return false;
	if (value.state === "queued" && value.claimId !== undefined) return false;
	return true;
}

export function serializeSchedulerQueueEntry(value: SchedulerQueueEntryV1): SchedulerQueueEntryV1 {
	const entry: SchedulerQueueEntryV1 = {
		schemaVersion: 1,
		queueEntryId: value.queueEntryId,
		sessionId: value.sessionId,
		taskId: value.taskId,
		state: value.state,
		priority: value.priority,
		attemptsUsed: value.attemptsUsed,
		enqueuedAt: value.enqueuedAt,
		revision: value.revision,
	};
	if (value.nodeRef !== undefined) (entry as { nodeRef?: SchedulerNodeRefV1 }).nodeRef = copyNodeRef(value.nodeRef);
	if (value.goalId !== undefined) (entry as { goalId?: string }).goalId = value.goalId;
	if (value.workflowId !== undefined) (entry as { workflowId?: string }).workflowId = value.workflowId;
	if (value.notBefore !== undefined) (entry as { notBefore?: string }).notBefore = value.notBefore;
	if (value.deadlineAt !== undefined) (entry as { deadlineAt?: string }).deadlineAt = value.deadlineAt;
	if (value.claimId !== undefined) (entry as { claimId?: string }).claimId = value.claimId;
	return entry;
}

export function parseSchedulerQueueEntry(value: unknown): ResultValue<SchedulerQueueEntryV1, FoundationError> {
	if (!isSchedulerQueueEntry(value)) return fail("scheduler_queue_invalid");
	return Result.ok(serializeSchedulerQueueEntry(value));
}

export function isSchedulerClaim(value: unknown): value is SchedulerClaimV1 {
	if (!isRecord(value) || !hasOnlyKeys(value, CLAIM_KEYS)) return false;
	if (value.schemaVersion !== SCHEDULER_SCHEMA_VERSION) return false;
	if (
		!isSafeIdentifier(value.claimId) ||
		!isSafeIdentifier(value.queueEntryId) ||
		!isSafeIdentifier(value.taskId) ||
		!isSafeIdentifier(value.ownerId) ||
		!isSafeIdentifier(value.fencingToken) ||
		!isCanonicalTimestamp(value.acquiredAt) ||
		!isCanonicalTimestamp(value.expiresAt) ||
		!isNonNegativeInteger(value.revision)
	) {
		return false;
	}
	return Date.parse(value.expiresAt) > Date.parse(value.acquiredAt);
}

export function serializeSchedulerClaim(value: SchedulerClaimV1): SchedulerClaimV1 {
	return {
		schemaVersion: 1,
		claimId: value.claimId,
		queueEntryId: value.queueEntryId,
		taskId: value.taskId,
		ownerId: value.ownerId,
		fencingToken: value.fencingToken,
		acquiredAt: value.acquiredAt,
		expiresAt: value.expiresAt,
		revision: value.revision,
	};
}

export function parseSchedulerClaim(value: unknown): ResultValue<SchedulerClaimV1, FoundationError> {
	if (!isSchedulerClaim(value)) return fail("scheduler_queue_invalid");
	return Result.ok(serializeSchedulerClaim(value));
}

export function isSchedulerDispatchRecord(value: unknown): value is SchedulerDispatchRecordV1 {
	if (!isRecord(value) || !hasOnlyKeys(value, DISPATCH_KEYS)) return false;
	if (value.schemaVersion !== SCHEDULER_SCHEMA_VERSION) return false;
	if (
		!isSafeIdentifier(value.queueEntryId) ||
		!isSafeIdentifier(value.claimId) ||
		!isSafeIdentifier(value.dispatchId) ||
		!isSafeIdentifier(value.providerId) ||
		!isMember(value.providerClass, SCHEDULER_PROVIDER_CLASSES) ||
		!isMember(value.status, SCHEDULER_DISPATCH_STATUSES) ||
		!isNonNegativeInteger(value.revision)
	) {
		return false;
	}
	if (value.attemptId !== undefined && !isSafeIdentifier(value.attemptId)) return false;
	if (value.reservationId !== undefined && !isSafeIdentifier(value.reservationId)) return false;
	if (value.deadlineAt !== undefined && !isCanonicalTimestamp(value.deadlineAt)) return false;
	if ((value.status === "in_flight" || value.status === "settled") && value.attemptId === undefined) return false;
	return true;
}

export function serializeSchedulerDispatchRecord(value: SchedulerDispatchRecordV1): SchedulerDispatchRecordV1 {
	const record: SchedulerDispatchRecordV1 = {
		schemaVersion: 1,
		queueEntryId: value.queueEntryId,
		claimId: value.claimId,
		dispatchId: value.dispatchId,
		providerId: value.providerId,
		providerClass: value.providerClass,
		status: value.status,
		revision: value.revision,
	};
	if (value.attemptId !== undefined) (record as { attemptId?: string }).attemptId = value.attemptId;
	if (value.reservationId !== undefined) (record as { reservationId?: string }).reservationId = value.reservationId;
	if (value.deadlineAt !== undefined) (record as { deadlineAt?: string }).deadlineAt = value.deadlineAt;
	return record;
}

export function parseSchedulerDispatchRecord(value: unknown): ResultValue<SchedulerDispatchRecordV1, FoundationError> {
	if (!isSchedulerDispatchRecord(value)) return fail("scheduler_dispatch_invalid");
	return Result.ok(serializeSchedulerDispatchRecord(value));
}

function isCapability(value: unknown): value is FoundationProviderCapabilityV1 {
	return (
		isRecord(value) &&
		hasOnlyKeys(value, CAPABILITY_KEYS) &&
		value.schemaVersion === 1 &&
		isSafeIdentifier(value.id) &&
		typeof value.version === "number" &&
		Number.isInteger(value.version) &&
		value.version >= 1
	);
}

function isDescriptor(value: unknown): value is ExecutionProviderDescriptorV1 {
	return (
		isRecord(value) &&
		hasOnlyKeys(value, DESCRIPTOR_KEYS) &&
		value.schemaVersion === 1 &&
		isSafeIdentifier(value.providerId) &&
		isMember(value.providerClass, [
			"operation_worker",
			"scheduler",
			"task_executor",
			"agent",
			"external_connector",
		] as const)
	);
}

function isAffinity(value: unknown): value is SchedulerExecutorAffinityV1 {
	if (!isRecord(value) || !hasOnlyKeys(value, AFFINITY_KEYS)) return false;
	if (value.sessionId !== undefined && !isSafeIdentifier(value.sessionId)) return false;
	if (value.workspaceDigest !== undefined && !isFingerprint(value.workspaceDigest)) return false;
	return true;
}

export function isSchedulerExecutorEntry(value: unknown): value is SchedulerExecutorEntryV1 {
	if (!isRecord(value) || !hasOnlyKeys(value, EXECUTOR_ENTRY_KEYS)) return false;
	if (value.schemaVersion !== SCHEDULER_SCHEMA_VERSION) return false;
	if (!isDescriptor(value.descriptor) || !isMember(value.costClass, SCHEDULER_EXECUTOR_COST_CLASSES)) return false;
	if (!isCanonicalTimestamp(value.registeredAt)) return false;
	if (!Array.isArray(value.capabilities) || !value.capabilities.every(isCapability)) return false;
	if (value.affinity !== undefined && !isAffinity(value.affinity)) return false;
	if (value.descriptor.providerClass === "operation_worker") return false;
	return true;
}

export function serializeSchedulerExecutorEntry(value: SchedulerExecutorEntryV1): SchedulerExecutorEntryV1 {
	const entry: SchedulerExecutorEntryV1 = {
		schemaVersion: 1,
		descriptor: {
			schemaVersion: 1,
			providerId: value.descriptor.providerId,
			providerClass: value.descriptor.providerClass,
		},
		capabilities: value.capabilities.map((item) => ({ schemaVersion: 1, id: item.id, version: item.version })),
		costClass: value.costClass,
		registeredAt: value.registeredAt,
	};
	if (value.affinity !== undefined) {
		const affinity: SchedulerExecutorAffinityV1 = {};
		if (value.affinity.sessionId !== undefined)
			(affinity as { sessionId?: string }).sessionId = value.affinity.sessionId;
		if (value.affinity.workspaceDigest !== undefined) {
			(affinity as { workspaceDigest?: FingerprintV1 }).workspaceDigest = copyFingerprint(
				value.affinity.workspaceDigest,
			);
		}
		(entry as { affinity?: SchedulerExecutorAffinityV1 }).affinity = affinity;
	}
	return entry;
}

export function parseSchedulerExecutorEntry(value: unknown): ResultValue<SchedulerExecutorEntryV1, FoundationError> {
	if (!isSchedulerExecutorEntry(value)) return fail("scheduler_no_executor");
	return Result.ok(serializeSchedulerExecutorEntry(value));
}

function isSelectionScore(value: unknown): value is SchedulerSelectionScoreV1 {
	return (
		isRecord(value) &&
		hasOnlyKeys(value, SELECTION_SCORE_KEYS) &&
		isSafeIdentifier(value.providerId) &&
		typeof value.score === "number" &&
		Number.isFinite(value.score)
	);
}

export function isSchedulerSelectionFact(value: unknown): value is SchedulerSelectionFactV1 {
	if (!isRecord(value) || !hasOnlyKeys(value, SELECTION_FACT_KEYS)) return false;
	if (value.schemaVersion !== SCHEDULER_SCHEMA_VERSION) return false;
	if (
		!isSafeIdentifier(value.queueEntryId) ||
		!isSafeIdentifier(value.taskId) ||
		!isSafeIdentifier(value.chosenProviderId) ||
		!isFingerprint(value.inputsDigest) ||
		!isCanonicalTimestamp(value.decidedAt)
	) {
		return false;
	}
	if (!Array.isArray(value.scores) || !value.scores.every(isSelectionScore)) return false;
	return value.scores.some((item) => item.providerId === value.chosenProviderId);
}

export function serializeSchedulerSelectionFact(value: SchedulerSelectionFactV1): SchedulerSelectionFactV1 {
	return {
		schemaVersion: 1,
		queueEntryId: value.queueEntryId,
		taskId: value.taskId,
		chosenProviderId: value.chosenProviderId,
		scores: value.scores.map((item) => ({ providerId: item.providerId, score: item.score })),
		inputsDigest: copyFingerprint(value.inputsDigest),
		decidedAt: value.decidedAt,
	};
}

export function parseSchedulerSelectionFact(value: unknown): ResultValue<SchedulerSelectionFactV1, FoundationError> {
	if (!isSchedulerSelectionFact(value)) return fail("scheduler_no_executor");
	return Result.ok(serializeSchedulerSelectionFact(value));
}

export function isSchedulerJoinPlan(value: unknown): value is SchedulerJoinPlanV1 {
	if (!isRecord(value) || !hasOnlyKeys(value, JOIN_PLAN_KEYS)) return false;
	if (value.schemaVersion !== SCHEDULER_SCHEMA_VERSION) return false;
	if (
		!isSafeIdentifier(value.joinId) ||
		!isSafeIdentifier(value.taskId) ||
		!isMember(value.policy, SCHEDULER_JOIN_POLICIES) ||
		!isCanonicalTimestamp(value.createdAt) ||
		!isIdentifierList(value.predecessorTaskIds)
	) {
		return false;
	}
	if (value.nodeRef !== undefined && (!isNodeRef(value.nodeRef) || value.nodeRef.taskId !== value.taskId))
		return false;
	if (value.predecessorTaskIds.includes(value.taskId)) return false;
	return value.predecessorTaskIds.length > 0;
}

export function serializeSchedulerJoinPlan(value: SchedulerJoinPlanV1): SchedulerJoinPlanV1 {
	const plan: SchedulerJoinPlanV1 = {
		schemaVersion: 1,
		joinId: value.joinId,
		taskId: value.taskId,
		policy: value.policy,
		predecessorTaskIds: copyIdentifiers(value.predecessorTaskIds),
		createdAt: value.createdAt,
	};
	if (value.nodeRef !== undefined) (plan as { nodeRef?: SchedulerNodeRefV1 }).nodeRef = copyNodeRef(value.nodeRef);
	return plan;
}

export function parseSchedulerJoinPlan(value: unknown): ResultValue<SchedulerJoinPlanV1, FoundationError> {
	if (!isSchedulerJoinPlan(value)) return fail("scheduler_fanin_invalid");
	return Result.ok(serializeSchedulerJoinPlan(value));
}

export function isSchedulerJoinSnapshot(value: unknown): value is SchedulerJoinSnapshotV1 {
	if (!isRecord(value) || !hasOnlyKeys(value, JOIN_SNAPSHOT_KEYS)) return false;
	if (value.schemaVersion !== SCHEDULER_SCHEMA_VERSION) return false;
	if (!isSafeIdentifier(value.joinId) || !isMember(value.policy, SCHEDULER_JOIN_POLICIES)) return false;
	if (
		!isIdentifierList(value.sourceAttemptReceiptIds) ||
		!isIdentifierList(value.sourceTaskResultIds) ||
		!isIdentifierList(value.degradedCriterionIds)
	) {
		return false;
	}
	if (value.settledTaskResultId !== undefined && !isSafeIdentifier(value.settledTaskResultId)) return false;
	if (value.settledAt !== undefined && !isCanonicalTimestamp(value.settledAt)) return false;
	if ((value.settledTaskResultId === undefined) !== (value.settledAt === undefined)) return false;
	return true;
}

export function serializeSchedulerJoinSnapshot(value: SchedulerJoinSnapshotV1): SchedulerJoinSnapshotV1 {
	const snapshot: SchedulerJoinSnapshotV1 = {
		schemaVersion: 1,
		joinId: value.joinId,
		sourceAttemptReceiptIds: copyIdentifiers(value.sourceAttemptReceiptIds),
		sourceTaskResultIds: copyIdentifiers(value.sourceTaskResultIds),
		policy: value.policy,
		degradedCriterionIds: copyIdentifiers(value.degradedCriterionIds),
	};
	if (value.settledTaskResultId !== undefined) {
		(snapshot as { settledTaskResultId?: string }).settledTaskResultId = value.settledTaskResultId;
	}
	if (value.settledAt !== undefined) (snapshot as { settledAt?: string }).settledAt = value.settledAt;
	return snapshot;
}

export function parseSchedulerJoinSnapshot(value: unknown): ResultValue<SchedulerJoinSnapshotV1, FoundationError> {
	if (!isSchedulerJoinSnapshot(value)) return fail("scheduler_fanin_invalid");
	return Result.ok(serializeSchedulerJoinSnapshot(value));
}

function isMessageCorrelation(value: unknown): value is SchedulerMessageCorrelationV1 {
	if (!isRecord(value) || !hasOnlyKeys(value, MESSAGE_CORRELATION_KEYS)) return false;
	if (value.taskId !== undefined && !isSafeIdentifier(value.taskId)) return false;
	if (value.goalId !== undefined && !isSafeIdentifier(value.goalId)) return false;
	if (value.workflowId !== undefined && !isSafeIdentifier(value.workflowId)) return false;
	if (value.transferId !== undefined && !isSafeIdentifier(value.transferId)) return false;
	if (value.askId !== undefined && !isSafeIdentifier(value.askId)) return false;
	return true;
}

function copyMessageCorrelation(value: SchedulerMessageCorrelationV1): SchedulerMessageCorrelationV1 {
	const correlation: SchedulerMessageCorrelationV1 = {};
	if (value.taskId !== undefined) (correlation as { taskId?: string }).taskId = value.taskId;
	if (value.goalId !== undefined) (correlation as { goalId?: string }).goalId = value.goalId;
	if (value.workflowId !== undefined) (correlation as { workflowId?: string }).workflowId = value.workflowId;
	if (value.transferId !== undefined) (correlation as { transferId?: string }).transferId = value.transferId;
	if (value.askId !== undefined) (correlation as { askId?: string }).askId = value.askId;
	return correlation;
}

export function isSchedulerMessage(value: unknown): value is SchedulerMessageV1 {
	if (!isRecord(value) || !hasOnlyKeys(value, MESSAGE_KEYS)) return false;
	if (value.schemaVersion !== SCHEDULER_SCHEMA_VERSION) return false;
	if (
		!isSafeIdentifier(value.messageId) ||
		!isMember(value.type, SCHEDULER_MESSAGE_TYPES) ||
		!isSafeIdentifier(value.threadId) ||
		!isSafeIdentifier(value.fromSessionId) ||
		!isSafeIdentifier(value.toSessionId) ||
		!isMessageCorrelation(value.correlation) ||
		!isMember(value.ack, SCHEDULER_MESSAGE_ACK) ||
		!isCanonicalTimestamp(value.createdAt) ||
		!isNonNegativeInteger(value.revision)
	) {
		return false;
	}
	if (value.fromSessionId === value.toSessionId) return false;
	if (value.ackedAt !== undefined && !isCanonicalTimestamp(value.ackedAt)) return false;
	if (value.expiresAt !== undefined && !isCanonicalTimestamp(value.expiresAt)) return false;
	if (value.payloadDigest !== undefined && !isFingerprint(value.payloadDigest)) return false;
	if (value.ack === "required" && value.expiresAt === undefined) return false;
	if (value.ackedAt !== undefined && value.ack !== "required") return false;
	return true;
}

export function serializeSchedulerMessage(value: SchedulerMessageV1): SchedulerMessageV1 {
	const message: SchedulerMessageV1 = {
		schemaVersion: 1,
		messageId: value.messageId,
		type: value.type,
		threadId: value.threadId,
		fromSessionId: value.fromSessionId,
		toSessionId: value.toSessionId,
		correlation: copyMessageCorrelation(value.correlation),
		ack: value.ack,
		createdAt: value.createdAt,
		revision: value.revision,
	};
	if (value.ackedAt !== undefined) (message as { ackedAt?: string }).ackedAt = value.ackedAt;
	if (value.expiresAt !== undefined) (message as { expiresAt?: string }).expiresAt = value.expiresAt;
	if (value.payloadDigest !== undefined) {
		(message as { payloadDigest?: FingerprintV1 }).payloadDigest = copyFingerprint(value.payloadDigest);
	}
	return message;
}

export function parseSchedulerMessage(value: unknown): ResultValue<SchedulerMessageV1, FoundationError> {
	if (!isSchedulerMessage(value)) return fail("scheduler_message_invalid");
	return Result.ok(serializeSchedulerMessage(value));
}

export function isSchedulerOwnershipTransfer(value: unknown): value is SchedulerOwnershipTransferV1 {
	if (!isRecord(value) || !hasOnlyKeys(value, HANDOFF_KEYS)) return false;
	if (value.schemaVersion !== SCHEDULER_SCHEMA_VERSION) return false;
	if (
		!isSafeIdentifier(value.transferId) ||
		!isSafeIdentifier(value.taskId) ||
		!isSafeIdentifier(value.fromOwnerId) ||
		!isSafeIdentifier(value.toOwnerId) ||
		!isMember(value.state, SCHEDULER_HANDOFF_STATES) ||
		!isSafeIdentifier(value.fencingToken) ||
		!isCanonicalTimestamp(value.deadlineAt) ||
		!isCanonicalTimestamp(value.createdAt) ||
		!isNonNegativeInteger(value.revision)
	) {
		return false;
	}
	if (value.fromOwnerId === value.toOwnerId) return false;
	if (value.reasonSummary !== undefined) {
		if (
			typeof value.reasonSummary !== "string" ||
			value.reasonSummary.length === 0 ||
			value.reasonSummary.length > SCHEDULER_REASON_SUMMARY_MAX_LENGTH ||
			!SAFE_IDENTIFIER_PATTERN.test(value.reasonSummary)
		) {
			return false;
		}
	}
	if (value.decidedAt !== undefined && !isCanonicalTimestamp(value.decidedAt)) return false;
	if (value.state === "offered" && value.decidedAt !== undefined) return false;
	if (value.state !== "offered" && value.decidedAt === undefined) return false;
	return true;
}

export function serializeSchedulerOwnershipTransfer(value: SchedulerOwnershipTransferV1): SchedulerOwnershipTransferV1 {
	const transfer: SchedulerOwnershipTransferV1 = {
		schemaVersion: 1,
		transferId: value.transferId,
		taskId: value.taskId,
		fromOwnerId: value.fromOwnerId,
		toOwnerId: value.toOwnerId,
		state: value.state,
		fencingToken: value.fencingToken,
		deadlineAt: value.deadlineAt,
		createdAt: value.createdAt,
		revision: value.revision,
	};
	if (value.reasonSummary !== undefined) (transfer as { reasonSummary?: string }).reasonSummary = value.reasonSummary;
	if (value.decidedAt !== undefined) (transfer as { decidedAt?: string }).decidedAt = value.decidedAt;
	return transfer;
}

export function parseSchedulerOwnershipTransfer(
	value: unknown,
): ResultValue<SchedulerOwnershipTransferV1, FoundationError> {
	if (!isSchedulerOwnershipTransfer(value)) return fail("scheduler_handoff_invalid");
	return Result.ok(serializeSchedulerOwnershipTransfer(value));
}

export function isSchedulerWake(value: unknown): value is SchedulerWakeV1 {
	if (!isRecord(value) || !hasOnlyKeys(value, WAKE_KEYS)) return false;
	if (value.schemaVersion !== SCHEDULER_SCHEMA_VERSION) return false;
	if (
		!isSafeIdentifier(value.wakeId) ||
		!isSafeIdentifier(value.workflowId) ||
		!isCanonicalTimestamp(value.dueAt) ||
		!isNonNegativeInteger(value.revision)
	) {
		return false;
	}
	if (value.stepId !== undefined && !isSafeIdentifier(value.stepId)) return false;
	if (value.firedAt !== undefined && !isCanonicalTimestamp(value.firedAt)) return false;
	return true;
}

export function serializeSchedulerWake(value: SchedulerWakeV1): SchedulerWakeV1 {
	const wake: SchedulerWakeV1 = {
		schemaVersion: 1,
		wakeId: value.wakeId,
		workflowId: value.workflowId,
		dueAt: value.dueAt,
		revision: value.revision,
	};
	if (value.stepId !== undefined) (wake as { stepId?: string }).stepId = value.stepId;
	if (value.firedAt !== undefined) (wake as { firedAt?: string }).firedAt = value.firedAt;
	return wake;
}

export function parseSchedulerWake(value: unknown): ResultValue<SchedulerWakeV1, FoundationError> {
	if (!isSchedulerWake(value)) return fail("scheduler_wake_invalid");
	return Result.ok(serializeSchedulerWake(value));
}

export function isSchedulerDeadlockFact(value: unknown): value is SchedulerDeadlockFactV1 {
	if (!isRecord(value) || !hasOnlyKeys(value, DEADLOCK_KEYS)) return false;
	if (value.schemaVersion !== SCHEDULER_SCHEMA_VERSION) return false;
	if (!isSafeIdentifier(value.detectionId) || !isCanonicalTimestamp(value.detectedAt)) return false;
	if (!isIdentifierList(value.memberTaskIds) || value.memberTaskIds.length < 2) return false;
	if (!Array.isArray(value.edgeKinds) || value.edgeKinds.length === 0) return false;
	const seenEdges = new Set<string>();
	for (const kind of value.edgeKinds) {
		if (!isMember(kind, SCHEDULER_WAIT_EDGE_KINDS) || seenEdges.has(kind)) return false;
		seenEdges.add(kind);
	}
	if (!isIdentifierList(value.failedTaskIds) || value.failedTaskIds.length === 0) return false;
	for (const taskId of value.failedTaskIds) {
		if (!value.memberTaskIds.includes(taskId)) return false;
	}
	return true;
}

export function serializeSchedulerDeadlockFact(value: SchedulerDeadlockFactV1): SchedulerDeadlockFactV1 {
	return {
		schemaVersion: 1,
		detectionId: value.detectionId,
		memberTaskIds: copyIdentifiers(value.memberTaskIds),
		edgeKinds: [...value.edgeKinds],
		failedTaskIds: copyIdentifiers(value.failedTaskIds),
		detectedAt: value.detectedAt,
	};
}

export function parseSchedulerDeadlockFact(value: unknown): ResultValue<SchedulerDeadlockFactV1, FoundationError> {
	if (!isSchedulerDeadlockFact(value)) return fail("scheduler_deadlock_detected");
	return Result.ok(serializeSchedulerDeadlockFact(value));
}

function sameOptional(left: string | undefined, right: string | undefined): boolean {
	return left === right;
}

function sameNodeRef(left: SchedulerNodeRefV1 | undefined, right: SchedulerNodeRefV1 | undefined): boolean {
	if (left === undefined || right === undefined) return left === right;
	return left.taskId === right.taskId && left.graphRevision === right.graphRevision && left.nodeId === right.nodeId;
}

function queueIdentityMatches(left: SchedulerQueueEntryV1, right: SchedulerQueueEntryV1): boolean {
	return (
		left.sessionId === right.sessionId &&
		left.taskId === right.taskId &&
		left.queueEntryId === right.queueEntryId &&
		sameNodeRef(left.nodeRef, right.nodeRef) &&
		sameOptional(left.goalId, right.goalId) &&
		sameOptional(left.workflowId, right.workflowId)
	);
}

function nextRevision(current: number, next: number): boolean {
	return next === current + 1;
}

export function enqueueSchedulerQueueEntry(
	existing: SchedulerQueueEntryV1 | undefined,
	candidate: unknown,
): ResultValue<SchedulerEnqueueResultV1, FoundationError> {
	const parsed = parseSchedulerQueueEntry(candidate);
	if (!parsed.ok) return parsed;
	const next = parsed.value;
	if (next.state !== "queued" || next.claimId !== undefined || next.attemptsUsed !== 0) {
		return fail("scheduler_queue_invalid");
	}
	if (existing === undefined) {
		if (next.revision !== 0) return fail("scheduler_queue_invalid");
		return Result.ok({ entry: next, idempotent: false });
	}
	const existingParsed = parseSchedulerQueueEntry(existing);
	if (!existingParsed.ok) return existingParsed;
	const current = existingParsed.value;
	if (
		schedulerQueueBusinessKey(current.sessionId, current.taskId, current.nodeRef) !==
		schedulerQueueBusinessKey(next.sessionId, next.taskId, next.nodeRef)
	) {
		return fail("scheduler_queue_invalid");
	}
	if (queueIdentityKey(current) !== queueIdentityKey(next)) return fail("scheduler_queue_conflict");
	if (current.priority !== next.priority || current.enqueuedAt !== next.enqueuedAt) {
		return fail("scheduler_queue_conflict");
	}
	if (!sameOptional(current.notBefore, next.notBefore) || !sameOptional(current.deadlineAt, next.deadlineAt)) {
		return fail("scheduler_queue_conflict");
	}
	return Result.ok({ entry: serializeSchedulerQueueEntry(current), idempotent: true });
}

export function applySchedulerQueueTransition(
	current: SchedulerQueueEntryV1,
	next: unknown,
): ResultValue<SchedulerQueueEntryV1, FoundationError> {
	const currentParsed = parseSchedulerQueueEntry(current);
	if (!currentParsed.ok) return currentParsed;
	const parsed = parseSchedulerQueueEntry(next);
	if (!parsed.ok) return parsed;
	const from = currentParsed.value;
	const to = parsed.value;
	if (!queueIdentityMatches(from, to)) return fail("scheduler_queue_invalid");
	if (from.priority !== to.priority || from.enqueuedAt !== to.enqueuedAt) return fail("scheduler_queue_invalid");
	if (!sameOptional(from.notBefore, to.notBefore) || !sameOptional(from.deadlineAt, to.deadlineAt)) {
		return fail("scheduler_queue_invalid");
	}
	if (isSchedulerQueueTerminal(from.state)) return fail("scheduler_queue_invalid");
	if (!isLegalSchedulerQueueTransition(from.state, to.state)) return fail("scheduler_queue_invalid");
	if (!nextRevision(from.revision, to.revision)) return fail("scheduler_queue_invalid");
	if (to.state === "claimed" || to.state === "dispatched") {
		if (to.claimId === undefined) return fail("scheduler_queue_invalid");
		if (from.claimId !== undefined && from.claimId !== to.claimId) return fail("scheduler_claim_conflict");
	}
	if (to.state === "queued") {
		if (from.state !== "expired" || to.claimId !== undefined) return fail("scheduler_queue_invalid");
		if (to.attemptsUsed !== from.attemptsUsed + 1) return fail("scheduler_queue_invalid");
	} else if (to.attemptsUsed !== from.attemptsUsed) {
		return fail("scheduler_queue_invalid");
	}
	if (
		to.state === "expired" &&
		(from.state === "claimed" || from.state === "dispatched") &&
		to.claimId === undefined
	) {
		return fail("scheduler_queue_invalid");
	}
	if (to.state === "cancelled" && from.state === "queued" && to.claimId !== undefined)
		return fail("scheduler_queue_invalid");
	return Result.ok(to);
}

export function applySchedulerEngineTransition(
	from: SchedulerEnginePhaseV1,
	to: SchedulerEnginePhaseV1,
): ResultValue<SchedulerEnginePhaseV1, FoundationError> {
	if (!isMember(from, SCHEDULER_ENGINE_PHASES) || !isMember(to, SCHEDULER_ENGINE_PHASES)) {
		return fail("scheduler_queue_invalid");
	}
	if (!isLegalSchedulerEngineTransition(from, to)) return fail("scheduler_queue_invalid");
	return Result.ok(to);
}

export function applySchedulerClaimAcquire(
	entry: SchedulerQueueEntryV1,
	claim: unknown,
	nowIso: string,
): ResultValue<{ entry: SchedulerQueueEntryV1; claim: SchedulerClaimV1 }, FoundationError> {
	if (!isCanonicalTimestamp(nowIso)) return fail("scheduler_queue_invalid");
	const parsedEntry = parseSchedulerQueueEntry(entry);
	if (!parsedEntry.ok) return parsedEntry;
	const current = parsedEntry.value;
	const parsedClaim = parseSchedulerClaim(claim);
	if (!parsedClaim.ok) return parsedClaim;
	const nextClaim = parsedClaim.value;
	if (current.state !== "queued") return fail("scheduler_claim_conflict");
	if (current.claimId !== undefined) return fail("scheduler_claim_conflict");
	if (nextClaim.queueEntryId !== current.queueEntryId || nextClaim.taskId !== current.taskId) {
		return fail("scheduler_queue_invalid");
	}
	if (nextClaim.revision !== 0) return fail("scheduler_queue_invalid");
	if (!isSchedulerClaimActive(nextClaim, nowIso)) return fail("scheduler_claim_expired");
	const ttlMs = Date.parse(nextClaim.expiresAt) - Date.parse(nextClaim.acquiredAt);
	if (ttlMs < SCHEDULER_CLAIM_MIN_LEASE_TTL_MS || ttlMs > SCHEDULER_CLAIM_MAX_LEASE_TTL_MS) {
		return fail("scheduler_queue_invalid");
	}
	const nextEntry: SchedulerQueueEntryV1 = {
		...serializeSchedulerQueueEntry(current),
		state: "claimed",
		claimId: nextClaim.claimId,
		revision: current.revision + 1,
	};
	const applied = applySchedulerQueueTransition(current, nextEntry);
	if (!applied.ok) return applied;
	return Result.ok({ entry: applied.value, claim: nextClaim });
}

export function applySchedulerClaimRenew(
	claim: SchedulerClaimV1,
	next: unknown,
	expectedFencingToken: string,
	nowIso: string,
): ResultValue<SchedulerClaimV1, FoundationError> {
	if (!isCanonicalTimestamp(nowIso)) return fail("scheduler_queue_invalid");
	const parsed = parseSchedulerClaim(next);
	if (!parsed.ok) return parsed;
	const renewed = parsed.value;
	if (!schedulerFencingTokensEqual(claim.fencingToken, expectedFencingToken)) return fail("scheduler_lease_lost");
	if (!isSchedulerClaimActive(claim, nowIso)) return fail("scheduler_claim_expired");
	if (
		renewed.claimId !== claim.claimId ||
		renewed.queueEntryId !== claim.queueEntryId ||
		renewed.taskId !== claim.taskId ||
		renewed.ownerId !== claim.ownerId ||
		!schedulerFencingTokensEqual(renewed.fencingToken, claim.fencingToken) ||
		renewed.acquiredAt !== claim.acquiredAt
	) {
		return fail("scheduler_queue_invalid");
	}
	if (!nextRevision(claim.revision, renewed.revision)) return fail("scheduler_queue_invalid");
	if (!isSchedulerClaimActive(renewed, nowIso)) return fail("scheduler_claim_expired");
	const remainingMs = Date.parse(renewed.expiresAt) - Date.parse(nowIso);
	if (remainingMs < SCHEDULER_CLAIM_MIN_LEASE_TTL_MS || remainingMs > SCHEDULER_CLAIM_MAX_LEASE_TTL_MS) {
		return fail("scheduler_queue_invalid");
	}
	if (Date.parse(renewed.expiresAt) <= Date.parse(claim.expiresAt)) return fail("scheduler_queue_invalid");
	return Result.ok(renewed);
}

export function applySchedulerDispatchTransition(
	current: SchedulerDispatchRecordV1,
	next: unknown,
): ResultValue<SchedulerDispatchRecordV1, FoundationError> {
	const currentParsed = parseSchedulerDispatchRecord(current);
	if (!currentParsed.ok) return currentParsed;
	const parsed = parseSchedulerDispatchRecord(next);
	if (!parsed.ok) return parsed;
	const from = currentParsed.value;
	const to = parsed.value;
	if (
		from.queueEntryId !== to.queueEntryId ||
		from.claimId !== to.claimId ||
		from.dispatchId !== to.dispatchId ||
		from.providerId !== to.providerId ||
		from.providerClass !== to.providerClass ||
		!sameOptional(from.reservationId, to.reservationId) ||
		!sameOptional(from.deadlineAt, to.deadlineAt)
	) {
		return fail("scheduler_dispatch_invalid");
	}
	if (isSchedulerDispatchTerminal(from.status)) return fail("scheduler_dispatch_invalid");
	if (!isLegalSchedulerDispatchTransition(from.status, to.status)) return fail("scheduler_dispatch_invalid");
	if (!nextRevision(from.revision, to.revision)) return fail("scheduler_dispatch_invalid");
	if (from.attemptId !== undefined && from.attemptId !== to.attemptId) return fail("scheduler_dispatch_invalid");
	return Result.ok(to);
}

export function applySchedulerHandoffTransition(
	current: SchedulerOwnershipTransferV1,
	next: unknown,
	nowIso: string,
): ResultValue<SchedulerOwnershipTransferV1, FoundationError> {
	if (!isCanonicalTimestamp(nowIso)) return fail("scheduler_handoff_invalid");
	const currentParsed = parseSchedulerOwnershipTransfer(current);
	if (!currentParsed.ok) return currentParsed;
	const parsed = parseSchedulerOwnershipTransfer(next);
	if (!parsed.ok) return parsed;
	const from = currentParsed.value;
	const to = parsed.value;
	if (
		from.transferId !== to.transferId ||
		from.taskId !== to.taskId ||
		from.fromOwnerId !== to.fromOwnerId ||
		from.toOwnerId !== to.toOwnerId ||
		from.fencingToken !== to.fencingToken ||
		from.deadlineAt !== to.deadlineAt ||
		from.createdAt !== to.createdAt ||
		!sameOptional(from.reasonSummary, to.reasonSummary)
	) {
		return fail("scheduler_handoff_invalid");
	}
	if (isSchedulerHandoffTerminal(from.state)) return fail("scheduler_handoff_invalid");
	if (!isLegalSchedulerHandoffTransition(from.state, to.state)) return fail("scheduler_handoff_invalid");
	if (!nextRevision(from.revision, to.revision)) return fail("scheduler_handoff_invalid");
	if (to.state === "timed_out" && Date.parse(nowIso) < Date.parse(from.deadlineAt)) {
		return fail("scheduler_handoff_invalid");
	}
	if (to.state !== "timed_out" && Date.parse(nowIso) >= Date.parse(from.deadlineAt) && to.state !== "cancelled") {
		return fail("scheduler_handoff_timeout");
	}
	if (to.decidedAt === undefined || Date.parse(to.decidedAt) < Date.parse(from.createdAt)) {
		return fail("scheduler_handoff_invalid");
	}
	return Result.ok(to);
}

export function applySchedulerMessageAck(
	current: SchedulerMessageV1,
	ackedAt: string,
): ResultValue<SchedulerMessageV1, FoundationError> {
	const parsed = parseSchedulerMessage(current);
	if (!parsed.ok) return parsed;
	const message = parsed.value;
	if (message.ack !== "required") return fail("scheduler_message_invalid");
	if (message.ackedAt !== undefined) return fail("scheduler_message_invalid");
	if (!isCanonicalTimestamp(ackedAt)) return fail("scheduler_message_invalid");
	if (message.expiresAt !== undefined && Date.parse(ackedAt) > Date.parse(message.expiresAt)) {
		return fail("scheduler_message_timeout");
	}
	if (Date.parse(ackedAt) < Date.parse(message.createdAt)) return fail("scheduler_message_invalid");
	return Result.ok(
		serializeSchedulerMessage({
			...message,
			ackedAt,
			revision: message.revision + 1,
		}),
	);
}

export function applySchedulerWakeFire(
	current: SchedulerWakeV1,
	firedAt: string,
): ResultValue<SchedulerWakeV1, FoundationError> {
	const parsed = parseSchedulerWake(current);
	if (!parsed.ok) return parsed;
	const wake = parsed.value;
	if (wake.firedAt !== undefined) return fail("scheduler_wake_invalid");
	if (!isCanonicalTimestamp(firedAt)) return fail("scheduler_wake_invalid");
	if (Date.parse(firedAt) < Date.parse(wake.dueAt)) return fail("scheduler_wake_invalid");
	return Result.ok(serializeSchedulerWake({ ...wake, firedAt, revision: wake.revision + 1 }));
}

export function assertSchedulerFencingToken(
	claim: SchedulerClaimV1,
	fencingToken: string,
	nowIso: string,
): ResultValue<SchedulerClaimV1, FoundationError> {
	if (!isSchedulerClaim(claim)) return fail("scheduler_queue_invalid");
	if (!isCanonicalTimestamp(nowIso)) return fail("scheduler_queue_invalid");
	if (!schedulerFencingTokensEqual(claim.fencingToken, fencingToken)) return fail("scheduler_lease_lost");
	if (!isSchedulerClaimActive(claim, nowIso)) return fail("scheduler_claim_expired");
	return Result.ok(serializeSchedulerClaim(claim));
}

export function schedulerErrorCode(error: FoundationError): FoundationErrorCode {
	return error.code;
}

export const SCHEDULER_HOST_DEFAULT_POLL_INTERVAL_MS = 5_000;
export const SCHEDULER_HOST_MIN_POLL_INTERVAL_MS = 50;
export const SCHEDULER_HOST_MAX_POLL_INTERVAL_MS = 60_000;
export const SCHEDULER_HOST_DEFAULT_MAX_GRAPHS_PER_TICK = 50;
export const SCHEDULER_HOST_DEFAULT_MAX_NODES_PER_TICK = 64;

export interface SchedulerHostGraphV1 {
	list(filter?: TaskGraphListFilter): TaskGraphListResult;
	attach(input: TaskGraphNodeAttachRequest): TaskGraphMutationResult;
	settle(input: TaskGraphNodeSettleRequest): TaskGraphMutationResult;
}

export interface SchedulerHostQueueV1 {
	recoverExpired(): Promise<ResultValue<readonly unknown[], FoundationError>>;
	snapshot(): Promise<ResultValue<SchedulerQueueSnapshotV1, FoundationError>>;
	enqueue(
		candidate: unknown,
		options?: { readonly maxAttempts?: number },
	): Promise<ResultValue<SchedulerEnqueueResultV1, FoundationError>>;
	claim(request: {
		readonly queueEntryId: string;
		readonly ownerId: string;
		readonly ttlMs?: number;
	}): Promise<ResultValue<SchedulerClaimAcquireResultV1, FoundationError>>;
	renew(request: {
		readonly claimId: string;
		readonly fencingToken: string;
		readonly ttlMs?: number;
	}): Promise<ResultValue<SchedulerClaimV1, FoundationError>>;
	markTerminal(request: SchedulerQueueTerminalRequestV1): Promise<ResultValue<unknown, FoundationError>>;
}

export interface SchedulerHostDispatchV1 {
	dispatchRunClaimed(
		request: SchedulerRunDispatchRequestV1,
	): Promise<ResultValue<SchedulerDispatchOutcomeV1, FoundationError>>;
}

export interface SchedulerHostFanInV1 {
	settle(request: SchedulerFanInSettleRequestV1): Promise<ResultValue<SchedulerFanInSettlementV1, FoundationError>>;
}

export interface SchedulerHostRunAssociationV1 {
	readonly runId: string;
	readonly task: TaskEnvelopeV1;
	readonly binding: AgentBindingV1;
	readonly joinPolicy?: SchedulerJoinPolicyV1;
}

export interface SchedulerHostSettlementEvidenceV1 {
	readonly summary: string;
	readonly artifacts?: SchedulerFanInSettleRequestV1["artifacts"];
	readonly diff?: SchedulerFanInSettleRequestV1["diff"];
	readonly tests: SchedulerFanInSettleRequestV1["tests"];
	readonly evidence: SchedulerFanInSettleRequestV1["evidence"];
	readonly validation?: SchedulerFanInSettleRequestV1["validation"];
}

export interface SchedulerHostRunTerminalInputV1 {
	readonly runId: string;
	readonly taskId: string;
	readonly nodeId: string;
	readonly taskResult?: TaskResultV1;
	readonly rejectionCode?: string;
}

export interface SchedulerHostEventSourceV1 {
	subscribe(wake: () => void): () => void;
}

export interface SchedulerHostOptionsV1 {
	/** The production control plane is inert unless explicitly enabled. */
	readonly enabled?: boolean;
	readonly sessionId: string;
	readonly ownerId: string;
	readonly graph: SchedulerHostGraphV1;
	readonly queue: SchedulerHostQueueV1;
	readonly dispatch: SchedulerHostDispatchV1;
	readonly fanIn: SchedulerHostFanInV1;
	readonly resolveRunAssociation: (
		graph: TaskGraphRecord,
		node: TaskGraphNodeView,
		entry: SchedulerQueueEntryV1,
	) => Promise<ResultValue<SchedulerHostRunAssociationV1, FoundationError>>;
	readonly settlementEvidence?: (
		graph: TaskGraphRecord,
		node: TaskGraphNodeView,
		outcome: SchedulerDispatchOutcomeV1,
	) => Promise<ResultValue<SchedulerHostSettlementEvidenceV1, FoundationError>>;
	/** Host-owned terminal gate. Scheduler never writes RunReceipt/Run state. */
	readonly settleRunAtHost: (input: SchedulerHostRunTerminalInputV1) => Promise<ResultValue<void, FoundationError>>;
	readonly eventSource?: SchedulerHostEventSourceV1;
	readonly pollIntervalMs?: number;
	readonly maxGraphsPerTick?: number;
	readonly maxNodesPerTick?: number;
	readonly maxConcurrentAttempts?: number;
	readonly claimTtlMs?: number;
	readonly now?: () => string;
}

export interface SchedulerHostTickErrorV1 {
	readonly taskId: string;
	readonly nodeId: string;
	readonly code: string;
}

export interface SchedulerHostTickResultV1 {
	readonly enabled: boolean;
	readonly scannedGraphs: number;
	readonly scannedNodes: number;
	readonly enqueued: number;
	readonly claimed: number;
	readonly dispatched: number;
	readonly settled: number;
	readonly rejected: number;
	readonly errors: readonly SchedulerHostTickErrorV1[];
}

interface SchedulerHostWorkItemV1 {
	readonly graph: TaskGraphRecord;
	readonly node: TaskGraphNodeView;
	readonly entry: SchedulerQueueEntryV1;
	readonly claim?: SchedulerClaimV1;
	readonly attach: boolean;
}

interface SchedulerHostWorkOutcomeV1 {
	readonly claimed: boolean;
	readonly dispatched: boolean;
	readonly settled: boolean;
	readonly rejected: boolean;
	readonly error?: SchedulerHostTickErrorV1;
}

interface SchedulerHostClaimRenewalV1 {
	failure(): FoundationError | undefined;
	stop(): Promise<void>;
}

function schedulerHostQueueEntryId(nodeRef: SchedulerNodeRefV1): string {
	return `queue_${fingerprintFoundationValue(nodeRef).value}`;
}

function schedulerHostJoinId(nodeRef: SchedulerNodeRefV1): string {
	return `join_${fingerprintFoundationValue(nodeRef).value}`;
}

function schedulerHostErrorCode(error: unknown): string {
	if (error instanceof FoundationError) return error.code;
	if (error !== null && typeof error === "object" && "code" in error && typeof error.code === "string") {
		return error.code;
	}
	return "scheduler_persistence_failed";
}

function emptySchedulerHostTick(enabled: boolean): SchedulerHostTickResultV1 {
	return {
		enabled,
		scannedGraphs: 0,
		scannedNodes: 0,
		enqueued: 0,
		claimed: 0,
		dispatched: 0,
		settled: 0,
		rejected: 0,
		errors: [],
	};
}

/**
 * Single-Host Scheduler loop. Event wakes coalesce into one bounded tick;
 * the timer is only a bounded recovery poll and is never a busy loop.
 */
export class SchedulerHostV1 {
	private readonly enabled: boolean;
	private readonly sessionId: string;
	private readonly ownerId: string;
	private readonly graph: SchedulerHostGraphV1;
	private readonly queue: SchedulerHostQueueV1;
	private readonly dispatch: SchedulerHostDispatchV1;
	private readonly fanIn: SchedulerHostFanInV1;
	private readonly resolveRunAssociation: SchedulerHostOptionsV1["resolveRunAssociation"];
	private readonly settlementEvidence: SchedulerHostOptionsV1["settlementEvidence"];
	private readonly settleRunAtHost: SchedulerHostOptionsV1["settleRunAtHost"];
	private readonly eventSource: SchedulerHostEventSourceV1 | undefined;
	private readonly pollIntervalMs: number;
	private readonly maxGraphsPerTick: number;
	private readonly maxNodesPerTick: number;
	private readonly maxConcurrentAttempts: number;
	private readonly claimTtlMs: number | undefined;
	private readonly active = new Set<Promise<SchedulerHostWorkOutcomeV1>>();
	private unsubscribe: (() => void) | undefined;
	private pollTimer: ReturnType<typeof setTimeout> | undefined;
	private currentTick: Promise<SchedulerHostTickResultV1> | undefined;
	private started = false;
	private wakeQueued = false;

	constructor(options: SchedulerHostOptionsV1) {
		this.enabled = options.enabled ?? false;
		this.sessionId = options.sessionId;
		this.ownerId = options.ownerId;
		this.graph = options.graph;
		this.queue = options.queue;
		this.dispatch = options.dispatch;
		this.fanIn = options.fanIn;
		this.resolveRunAssociation = options.resolveRunAssociation;
		this.settlementEvidence = options.settlementEvidence;
		this.settleRunAtHost = options.settleRunAtHost;
		this.eventSource = options.eventSource;
		this.pollIntervalMs = Math.min(
			SCHEDULER_HOST_MAX_POLL_INTERVAL_MS,
			Math.max(
				SCHEDULER_HOST_MIN_POLL_INTERVAL_MS,
				options.pollIntervalMs ?? SCHEDULER_HOST_DEFAULT_POLL_INTERVAL_MS,
			),
		);
		this.maxGraphsPerTick = Math.min(
			100,
			Math.max(1, options.maxGraphsPerTick ?? SCHEDULER_HOST_DEFAULT_MAX_GRAPHS_PER_TICK),
		);
		this.maxNodesPerTick = Math.min(
			SCHEDULER_QUEUE_MAX_DEPTH,
			Math.max(1, options.maxNodesPerTick ?? SCHEDULER_HOST_DEFAULT_MAX_NODES_PER_TICK),
		);
		this.maxConcurrentAttempts = Math.min(
			SCHEDULER_GLOBAL_MAX_ACTIVE_ATTEMPTS,
			Math.max(1, options.maxConcurrentAttempts ?? SCHEDULER_SESSION_MAX_ACTIVE_ATTEMPTS),
		);
		this.claimTtlMs = options.claimTtlMs;
	}

	start(): boolean {
		if (!this.enabled || this.started) return false;
		this.started = true;
		this.unsubscribe = this.eventSource?.subscribe(() => this.wake());
		this.wake();
		return true;
	}

	stop(): void {
		if (!this.started) return;
		this.started = false;
		this.wakeQueued = false;
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		if (this.pollTimer !== undefined) clearTimeout(this.pollTimer);
		this.pollTimer = undefined;
	}

	wake(): void {
		if (!this.enabled || !this.started || this.wakeQueued) return;
		this.wakeQueued = true;
		queueMicrotask(() => {
			if (!this.started || !this.wakeQueued) return;
			this.wakeQueued = false;
			void this.tick();
		});
	}

	tick(): Promise<SchedulerHostTickResultV1> {
		if (!this.enabled) return Promise.resolve(emptySchedulerHostTick(false));
		if (this.currentTick !== undefined) return this.currentTick;
		this.currentTick = this.tickOnce().finally(() => {
			this.currentTick = undefined;
			if (!this.started) return;
			if (this.wakeQueued) {
				this.wakeQueued = false;
				this.wake();
			} else this.schedulePoll();
		});
		return this.currentTick;
	}

	private schedulePoll(): void {
		if (!this.started || this.pollTimer !== undefined) return;
		this.pollTimer = setTimeout(() => {
			this.pollTimer = undefined;
			this.wake();
		}, this.pollIntervalMs);
		this.pollTimer.unref();
	}

	private async tickOnce(): Promise<SchedulerHostTickResultV1> {
		const errors: SchedulerHostTickErrorV1[] = [];
		const recovered = await this.queue.recoverExpired();
		if (!recovered.ok) {
			return {
				...emptySchedulerHostTick(true),
				errors: [{ taskId: "scheduler", nodeId: "recovery", code: recovered.error.code }],
			};
		}
		const listed = this.graph.list({ status: "active", limit: this.maxGraphsPerTick });
		const snapshot = await this.queue.snapshot();
		if (!snapshot.ok) {
			return {
				...emptySchedulerHostTick(true),
				errors: [{ taskId: "scheduler", nodeId: "queue", code: snapshot.error.code }],
			};
		}
		const entryById = new Map(snapshot.value.entries.map((entry) => [entry.queueEntryId, entry]));
		const claimById = new Map(snapshot.value.claims.map((claim) => [claim.claimId, claim]));
		const work: SchedulerHostWorkItemV1[] = [];
		let scannedNodes = 0;
		let enqueued = 0;
		for (const graph of listed.graphs) {
			for (const node of graph.nodes) {
				if (scannedNodes >= this.maxNodesPerTick) break;
				scannedNodes++;
				const nodeRef: SchedulerNodeRefV1 = {
					taskId: graph.taskId,
					graphRevision: graph.graphRevision,
					nodeId: node.nodeId,
				};
				const queueEntryId = schedulerHostQueueEntryId(nodeRef);
				if (node.status === "pending" && node.availability === "ready") {
					const candidate: SchedulerQueueEntryV1 = {
						schemaVersion: 1,
						queueEntryId,
						sessionId: this.sessionId,
						taskId: graph.taskId,
						nodeRef,
						state: "queued",
						priority: 0,
						attemptsUsed: 0,
						enqueuedAt: graph.createdAt,
						revision: 0,
					};
					const queued = await this.queue.enqueue(candidate);
					if (!queued.ok) {
						errors.push({ taskId: graph.taskId, nodeId: node.nodeId, code: queued.error.code });
						continue;
					}
					if (!queued.value.idempotent) enqueued++;
					entryById.set(queueEntryId, queued.value.entry);
					if (queued.value.entry.state === "queued") {
						work.push({ graph, node, entry: queued.value.entry, attach: true });
					}
					continue;
				}
				if (node.status !== "running" || node.runRef === undefined) continue;
				const entry = entryById.get(queueEntryId);
				if (
					entry === undefined ||
					(entry.state !== "claimed" && entry.state !== "dispatched") ||
					entry.claimId === undefined
				) {
					continue;
				}
				const claim = claimById.get(entry.claimId);
				if (claim !== undefined) work.push({ graph, node, entry, claim, attach: false });
			}
			if (scannedNodes >= this.maxNodesPerTick) break;
		}
		let activeTotal = this.active.size;
		const activeByTaskId = new Map<string, number>();
		const taskCapacityByTaskId = new Map<string, number>();
		const pending: Promise<SchedulerHostWorkOutcomeV1>[] = [];
		const immediate: SchedulerHostWorkOutcomeV1[] = [];
		for (let item of work) {
			if (activeTotal >= this.maxConcurrentAttempts) break;
			const knownTaskCapacity = taskCapacityByTaskId.get(item.graph.taskId);
			const knownTaskActive = activeByTaskId.get(item.graph.taskId) ?? 0;
			if (knownTaskCapacity !== undefined && knownTaskActive >= knownTaskCapacity) {
				immediate.push(this.workError(item, schedulerError("scheduler_budget_exhausted_wait"), false, false));
				continue;
			}
			const associated = await this.resolveRunAssociation(item.graph, item.node, item.entry);
			if (!associated.ok) {
				immediate.push(this.workError(item, associated.error, false, false));
				continue;
			}
			const taskId = associated.value.task.taskId;
			if (taskId !== item.graph.taskId) {
				immediate.push(this.workError(item, schedulerError("scheduler_dispatch_invalid"), false, false));
				continue;
			}
			const taskActive = activeByTaskId.get(taskId) ?? 0;
			const taskCapacity = Math.min(
				this.maxConcurrentAttempts,
				associated.value.task.budget.concurrency ?? this.maxConcurrentAttempts,
			);
			taskCapacityByTaskId.set(taskId, taskCapacity);
			if (taskActive >= taskCapacity) {
				immediate.push(this.workError(item, schedulerError("scheduler_budget_exhausted_wait"), false, false));
				continue;
			}
			if (item.claim === undefined) {
				const claimed = await this.queue.claim({
					queueEntryId: item.entry.queueEntryId,
					ownerId: this.ownerId,
					...(this.claimTtlMs === undefined ? {} : { ttlMs: this.claimTtlMs }),
				});
				if (!claimed.ok) {
					immediate.push(this.workError(item, claimed.error, false, false));
					continue;
				}
				item = { ...item, entry: claimed.value.entry, claim: claimed.value.claim };
			}
			activeTotal++;
			activeByTaskId.set(taskId, taskActive + 1);
			let job: Promise<SchedulerHostWorkOutcomeV1>;
			job = this.process(item, associated.value).finally(() => this.active.delete(job));
			this.active.add(job);
			pending.push(job);
		}
		const outcomes = [...immediate, ...(await Promise.all(pending))];
		for (const outcome of outcomes) if (outcome.error !== undefined) errors.push(outcome.error);
		return {
			enabled: true,
			scannedGraphs: listed.graphs.length,
			scannedNodes,
			enqueued,
			claimed: outcomes.filter((outcome) => outcome.claimed).length,
			dispatched: outcomes.filter((outcome) => outcome.dispatched).length,
			settled: outcomes.filter((outcome) => outcome.settled).length,
			rejected: outcomes.filter((outcome) => outcome.rejected).length,
			errors,
		};
	}

	private async process(
		item: SchedulerHostWorkItemV1,
		association: SchedulerHostRunAssociationV1,
	): Promise<SchedulerHostWorkOutcomeV1> {
		let claim = item.claim;
		if (claim === undefined) {
			const claimed = await this.queue.claim({
				queueEntryId: item.entry.queueEntryId,
				ownerId: this.ownerId,
				...(this.claimTtlMs === undefined ? {} : { ttlMs: this.claimTtlMs }),
			});
			if (!claimed.ok) return this.workError(item, claimed.error, false, false);
			claim = claimed.value.claim;
			item = { ...item, entry: claimed.value.entry };
		}
		if (!item.attach && item.node.runRef?.runId !== association.runId) {
			return this.workError(item, schedulerError("scheduler_dispatch_invalid"), true, false);
		}
		if (item.attach) {
			try {
				this.graph.attach({
					taskId: item.graph.taskId,
					graphRevision: item.graph.graphRevision,
					nodeId: item.node.nodeId,
					runId: association.runId,
					clientRequestId: `scheduler-attach-${item.entry.queueEntryId}`,
				});
			} catch (error) {
				return this.workError(item, error, true, false);
			}
		}
		const renewal = this.startClaimRenewal(claim);
		try {
			const dispatched = await this.dispatch.dispatchRunClaimed({
				runId: association.runId,
				queueEntryId: item.entry.queueEntryId,
				fencingToken: claim.fencingToken,
				binding: association.binding,
			});
			if (!dispatched.ok) return this.workError(item, dispatched.error, true, false);
			const renewalFailure = renewal.failure();
			if (renewalFailure !== undefined) return this.workError(item, renewalFailure, true, true);
			const evidence: ResultValue<SchedulerHostSettlementEvidenceV1, FoundationError> =
				this.settlementEvidence === undefined
					? Result.ok<SchedulerHostSettlementEvidenceV1>({
							summary: `Scheduler settled node ${item.node.nodeId}.`,
							tests: [],
							evidence: [],
						})
					: await this.settlementEvidence(item.graph, item.node, dispatched.value);
			if (!evidence.ok)
				return this.rejectAfterDispatch(item, claim, dispatched.value, association, evidence.error);
			const nodeRef = item.entry.nodeRef;
			if (nodeRef === undefined) {
				return this.rejectAfterDispatch(
					item,
					claim,
					dispatched.value,
					association,
					schedulerError("scheduler_fanin_invalid"),
				);
			}
			const plan: SchedulerJoinPlanV1 | undefined =
				item.node.dependsOn.length === 0
					? undefined
					: {
							schemaVersion: 1,
							joinId: schedulerHostJoinId(nodeRef),
							taskId: item.graph.taskId,
							nodeRef,
							policy: association.joinPolicy ?? "require_all",
							predecessorTaskIds: [...item.node.dependsOn],
							createdAt: item.graph.createdAt,
						};
			const settled = await this.fanIn.settle({
				task: association.task,
				nodeRef,
				currentAttemptReceiptIds: [dispatched.value.receipt.attemptReceiptId],
				...(plan === undefined ? {} : { plan }),
				summary: evidence.value.summary,
				...(evidence.value.artifacts === undefined ? {} : { artifacts: evidence.value.artifacts }),
				...(evidence.value.diff === undefined ? {} : { diff: evidence.value.diff }),
				tests: evidence.value.tests,
				evidence: evidence.value.evidence,
				...(evidence.value.validation === undefined ? {} : { validation: evidence.value.validation }),
			});
			if (!settled.ok)
				return this.rejectAfterDispatch(item, claim, dispatched.value, association, settled.error);
			const hostSettled = await this.settleRunAtHost({
				runId: association.runId,
				taskId: item.graph.taskId,
				nodeId: item.node.nodeId,
				taskResult: settled.value.taskResult,
			});
			if (!hostSettled.ok) return this.workError(item, hostSettled.error, true, true);
			try {
				this.graph.settle({
					taskId: item.graph.taskId,
					graphRevision: item.graph.graphRevision,
					nodeId: item.node.nodeId,
					clientRequestId: `scheduler-settle-${item.entry.queueEntryId}`,
				});
			} catch (error) {
				return this.workError(item, error, true, true);
			}
			const finalRenewalFailure = renewal.failure();
			if (finalRenewalFailure !== undefined) return this.workError(item, finalRenewalFailure, true, true);
			const queueSettled = await this.queue.markTerminal({
				queueEntryId: item.entry.queueEntryId,
				dispatchId: dispatched.value.dispatch.dispatchId,
				attemptId: dispatched.value.attempt.attemptId,
				fencingToken: claim.fencingToken,
				outcome: "settled",
			});
			if (!queueSettled.ok) return this.workError(item, queueSettled.error, true, true);
			return { claimed: true, dispatched: true, settled: true, rejected: false };
		} finally {
			await renewal.stop();
		}
	}

	private startClaimRenewal(claim: SchedulerClaimV1): SchedulerHostClaimRenewalV1 {
		const ttlMs = this.claimTtlMs ?? SCHEDULER_CLAIM_MAX_LEASE_TTL_MS;
		const intervalMs = Math.max(SCHEDULER_CLAIM_MIN_LEASE_TTL_MS, Math.floor(ttlMs / 2));
		let timer: ReturnType<typeof setTimeout> | undefined;
		let stopped = false;
		let failure: FoundationError | undefined;
		let inFlight: Promise<void> = Promise.resolve();
		const schedule = (): void => {
			if (stopped || failure !== undefined) return;
			timer = setTimeout(() => {
				timer = undefined;
				inFlight = this.queue
					.renew({
						claimId: claim.claimId,
						fencingToken: claim.fencingToken,
						ttlMs,
					})
					.then((renewed) => {
						if (!renewed.ok) failure = renewed.error;
						else schedule();
					});
			}, intervalMs);
			timer.unref();
		};
		schedule();
		return {
			failure: () => failure,
			async stop() {
				stopped = true;
				if (timer !== undefined) clearTimeout(timer);
				await inFlight;
			},
		};
	}

	private async rejectAfterDispatch(
		item: SchedulerHostWorkItemV1,
		claim: SchedulerClaimV1,
		dispatched: SchedulerDispatchOutcomeV1,
		association: SchedulerHostRunAssociationV1,
		error: FoundationError,
	): Promise<SchedulerHostWorkOutcomeV1> {
		const hostSettled = await this.settleRunAtHost({
			runId: association.runId,
			taskId: item.graph.taskId,
			nodeId: item.node.nodeId,
			rejectionCode: error.code,
		});
		if (!hostSettled.ok) return this.workError(item, hostSettled.error, true, true);
		try {
			this.graph.settle({
				taskId: item.graph.taskId,
				graphRevision: item.graph.graphRevision,
				nodeId: item.node.nodeId,
				clientRequestId: `scheduler-settle-${item.entry.queueEntryId}`,
			});
		} catch (settleError) {
			return this.workError(item, settleError, true, true);
		}
		const terminal = await this.queue.markTerminal({
			queueEntryId: item.entry.queueEntryId,
			dispatchId: dispatched.dispatch.dispatchId,
			attemptId: dispatched.attempt.attemptId,
			fencingToken: claim.fencingToken,
			outcome: "cancelled",
		});
		if (!terminal.ok) return this.workError(item, terminal.error, true, true);
		return {
			claimed: true,
			dispatched: true,
			settled: false,
			rejected: true,
			error: { taskId: item.graph.taskId, nodeId: item.node.nodeId, code: error.code },
		};
	}

	private workError(
		item: SchedulerHostWorkItemV1,
		error: unknown,
		claimed: boolean,
		dispatched: boolean,
	): SchedulerHostWorkOutcomeV1 {
		return {
			claimed,
			dispatched,
			settled: false,
			rejected: false,
			error: {
				taskId: item.graph.taskId,
				nodeId: item.node.nodeId,
				code: schedulerHostErrorCode(error),
			},
		};
	}
}
