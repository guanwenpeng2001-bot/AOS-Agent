/**
 * Scheduler durable queue store for queueing, claims, and fencing.
 *
 * Persistence uses the existing Session durable ledger as the only
 * authority. Claim fencing is a claim-owned opaque token and lease, not
 * `LedgerWriterLeaseV1`. Ledger appends still go through that writer lease.
 * There is no production tick: callers invoke `recoverExpired` explicitly.
 */
import { createHash, randomUUID } from "node:crypto";
import {
	createDurableEvent,
	type DurableEventCategory,
	type DurableLedgerApi,
	DurableLedgerError,
	type EventCorrelationRef,
	FoundationError,
	type FoundationFactRecord,
	type FoundationJsonValue,
	type FoundationRecord,
	type LedgerWriterLease,
	Result,
	type ResultValue,
} from "@aos-agent/agent-core";
import { runtimeClockFor, type RuntimeClock } from "../runtime/clock.ts";
import {
	applySchedulerClaimAcquire,
	applySchedulerClaimRenew,
	applySchedulerDispatchTransition,
	applySchedulerQueueTransition,
	assertSchedulerFencingToken,
	enqueueSchedulerQueueEntry,
	isSchedulerClaim,
	isSchedulerClaimActive,
	isSchedulerDispatchRecord,
	isSchedulerDispatchTerminal,
	isSchedulerQueueEntry,
	isSchedulerQueueTerminal,
	parseSchedulerClaim,
	parseSchedulerDispatchRecord,
	parseSchedulerQueueEntry,
	SCHEDULER_CLAIM_MAX_LEASE_TTL_MS,
	SCHEDULER_CLAIM_MIN_LEASE_TTL_MS,
	SCHEDULER_DEFAULT_MAX_ATTEMPTS,
	SCHEDULER_DURABLE_EVENT_CATEGORIES,
	SCHEDULER_ERROR_CODES,
	SCHEDULER_QUEUE_MAX_DEPTH,
	type SchedulerClaim,
	type SchedulerDispatchRecord,
	type SchedulerEnqueueResult,
	type SchedulerErrorCode,
	type SchedulerProviderClass,
	type SchedulerQueueEntry,
	schedulerQueueBusinessKey,
	serializeSchedulerClaim,
	serializeSchedulerDispatchRecord,
	serializeSchedulerQueueEntry,
} from "./host.ts";

export const SCHEDULER_QUEUE_ENTRY_OBJECT_TYPE = "scheduler.queue_entry";
export const SCHEDULER_QUEUE_KEY_OBJECT_TYPE = "scheduler.queue_key";
export const SCHEDULER_CLAIM_OBJECT_TYPE = "scheduler.claim";
export const SCHEDULER_CLAIM_TRANSFER_OBJECT_TYPE = "scheduler.claim_transfer";
export const SCHEDULER_DISPATCH_OBJECT_TYPE = "scheduler.dispatch";
export const SCHEDULER_ATTEMPT_POLICY_OBJECT_TYPE = "scheduler.attempt_policy";

export const SCHEDULER_QUEUE_LEDGER_OBJECT_TYPES = Object.freeze([
	SCHEDULER_QUEUE_ENTRY_OBJECT_TYPE,
	SCHEDULER_QUEUE_KEY_OBJECT_TYPE,
	SCHEDULER_CLAIM_OBJECT_TYPE,
	SCHEDULER_CLAIM_TRANSFER_OBJECT_TYPE,
	SCHEDULER_DISPATCH_OBJECT_TYPE,
	SCHEDULER_ATTEMPT_POLICY_OBJECT_TYPE,
	...SCHEDULER_DURABLE_EVENT_CATEGORIES,
]);

const WRITER_LEASE_REFRESH_MS = 1000;

const ERROR_MESSAGES: Readonly<Record<SchedulerErrorCode, string>> = {
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

const RETRYABLE = new Set<SchedulerErrorCode>([
	"scheduler_claim_conflict",
	"scheduler_budget_exhausted_wait",
	"scheduler_backpressure",
]);

export type SchedulerCancelAttempt = (attemptId: string) => Promise<ResultValue<void, FoundationError>>;

export interface SchedulerQueueStoreOptions {
	readonly ledger: DurableLedgerApi;
	readonly sessionId: string;
	readonly ownerId: string;
	readonly lane?: string;
	readonly now?: () => string;
	readonly writerLeaseTtlMs?: number;
	readonly cancelAttempt?: SchedulerCancelAttempt;
	readonly maxAttempts?: number;
}

export interface SchedulerClaimRequest {
	readonly queueEntryId: string;
	readonly ownerId: string;
	readonly claimId?: string;
	readonly fencingToken?: string;
	readonly ttlMs?: number;
}

export interface SchedulerClaimRenewRequest {
	readonly claimId: string;
	readonly fencingToken: string;
	readonly ttlMs?: number;
}

export type SchedulerClaimTransferState = "prepared" | "committed";

export interface SchedulerClaimTransferRequest {
	readonly transferId: string;
	readonly queueEntryId: string;
	readonly sourceFencingToken: string;
	readonly targetOwnerId: string;
	readonly targetClaimId?: string;
	readonly targetFencingToken?: string;
	readonly cancelledAttemptId?: string;
	readonly ttlMs?: number;
}

export interface SchedulerClaimTransfer {
	readonly schemaVersion: 1;
	readonly transferId: string;
	readonly queueEntryId: string;
	readonly taskId: string;
	readonly sourceClaimId: string;
	readonly sourceOwnerId: string;
	readonly sourceFencingToken: string;
	readonly sourceEntryState: "claimed" | "dispatched";
	readonly sourceAttemptId?: string;
	readonly targetClaimId: string;
	readonly targetOwnerId: string;
	readonly targetFencingToken: string;
	readonly targetAcquiredAt: string;
	readonly targetExpiresAt: string;
	readonly state: SchedulerClaimTransferState;
	readonly createdAt: string;
	readonly committedAt?: string;
	readonly revision: number;
}

export interface SchedulerClaimTransferResult {
	readonly entry: SchedulerQueueEntry;
	readonly sourceClaim: SchedulerClaim;
	readonly targetClaim: SchedulerClaim;
	readonly transfer: SchedulerClaimTransfer;
}

export interface SchedulerDispatchRequest {
	readonly queueEntryId: string;
	readonly fencingToken: string;
	readonly dispatchId: string;
	readonly attemptId: string;
	readonly providerId: string;
	readonly providerClass: SchedulerProviderClass;
	readonly reservationId?: string;
}

export interface SchedulerQueueTerminalRequest {
	readonly queueEntryId: string;
	readonly dispatchId: string;
	readonly attemptId: string;
	readonly fencingToken: string;
	readonly outcome: "settled" | "cancelled";
}

export interface SchedulerClaimAcquireResult {
	readonly entry: SchedulerQueueEntry;
	readonly claim: SchedulerClaim;
}

export interface SchedulerDispatchResult {
	readonly entry: SchedulerQueueEntry;
	readonly claim: SchedulerClaim;
	readonly dispatch: SchedulerDispatchRecord;
}

export type SchedulerRecoveryAction = "requeued" | "cancelled";

export interface SchedulerRecoveryOutcome {
	readonly entry: SchedulerQueueEntry;
	readonly action: SchedulerRecoveryAction;
	readonly attemptsUsed: number;
	readonly cancelledAttemptId?: string;
}

export interface SchedulerQueueSnapshot {
	readonly entries: readonly SchedulerQueueEntry[];
	readonly claims: readonly SchedulerClaim[];
	readonly dispatches: readonly SchedulerDispatchRecord[];
}

interface QueueKeyPayloadV1 {
	readonly schemaVersion: 1;
	readonly queueEntryId: string;
}

interface AttemptPolicyPayloadV1 {
	readonly schemaVersion: 1;
	readonly taskId: string;
	readonly maxAttempts: number;
}

const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

const CLAIM_TRANSFER_KEYS = new Set([
	"schemaVersion",
	"transferId",
	"queueEntryId",
	"taskId",
	"sourceClaimId",
	"sourceOwnerId",
	"sourceFencingToken",
	"sourceEntryState",
	"sourceAttemptId",
	"targetClaimId",
	"targetOwnerId",
	"targetFencingToken",
	"targetAcquiredAt",
	"targetExpiresAt",
	"state",
	"createdAt",
	"committedAt",
	"revision",
]);

function schedulerError(code: SchedulerErrorCode): FoundationError {
	return new FoundationError(code, ERROR_MESSAGES[code], { retryable: RETRYABLE.has(code) });
}

function fail<T>(code: SchedulerErrorCode): ResultValue<T, FoundationError> {
	return Result.err(schedulerError(code));
}

function isSchedulerErrorCode(value: string): value is SchedulerErrorCode {
	return (SCHEDULER_ERROR_CODES as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function jsonPayload(value: FoundationJsonValue | object): FoundationJsonValue {
	return value as FoundationJsonValue;
}

function newSafeId(prefix: string): string {
	return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

function keyObjectId(sessionId: string, taskId: string, nodeRef: SchedulerQueueEntry["nodeRef"]): string {
	const digest = createHash("sha256")
		.update(schedulerQueueBusinessKey(sessionId, taskId, nodeRef))
		.digest("hex");
	return `key_${digest}`;
}

function plusMs(nowIso: string, ttlMs: number): string {
	return new Date(Date.parse(nowIso) + ttlMs).toISOString();
}

function asFact(record: FoundationRecord): FoundationFactRecord | undefined {
	return record.kind === "fact" ? record : undefined;
}

function ledgerCode(error: unknown): string | undefined {
	if (error instanceof DurableLedgerError) return error.code;
	if (error instanceof FoundationError) return error.code;
	if (isRecord(error) && typeof error.code === "string") return error.code;
	return undefined;
}

function mapLedgerError(error: unknown, staleCode: SchedulerErrorCode): FoundationError {
	if (error instanceof FoundationError) return error;
	const code = ledgerCode(error);
	if (code === "session_writer_stale_revision") return schedulerError(staleCode);
	if (code === "session_writer_duplicate_request") return schedulerError("scheduler_queue_conflict");
	if (
		code === "session_writer_lease_lost" ||
		code === "session_writer_fencing_token" ||
		code === "session_writer_lease_expired" ||
		code === "session_writer_busy"
	) {
		return schedulerError("scheduler_persistence_failed");
	}
	if (code !== undefined && isSchedulerErrorCode(code)) return schedulerError(code);
	return schedulerError("scheduler_persistence_failed");
}

function parseQueueKey(value: unknown): QueueKeyPayloadV1 | undefined {
	if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.queueEntryId !== "string") return undefined;
	return { schemaVersion: 1, queueEntryId: value.queueEntryId };
}

function parseAttemptPolicy(value: unknown): AttemptPolicyPayloadV1 | undefined {
	if (
		!isRecord(value) ||
		value.schemaVersion !== 1 ||
		typeof value.taskId !== "string" ||
		typeof value.maxAttempts !== "number" ||
		!Number.isInteger(value.maxAttempts) ||
		value.maxAttempts < 1
	) {
		return undefined;
	}
	return { schemaVersion: 1, taskId: value.taskId, maxAttempts: value.maxAttempts };
}

function isCanonicalTimestamp(value: unknown): value is string {
	if (typeof value !== "string") return false;
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function isSafeIdentifier(value: unknown): value is string {
	return typeof value === "string" && SAFE_IDENTIFIER_PATTERN.test(value);
}

function serializeClaimTransfer(value: SchedulerClaimTransfer): SchedulerClaimTransfer {
	const transfer: SchedulerClaimTransfer = {
		schemaVersion: 1,
		transferId: value.transferId,
		queueEntryId: value.queueEntryId,
		taskId: value.taskId,
		sourceClaimId: value.sourceClaimId,
		sourceOwnerId: value.sourceOwnerId,
		sourceFencingToken: value.sourceFencingToken,
		sourceEntryState: value.sourceEntryState,
		targetClaimId: value.targetClaimId,
		targetOwnerId: value.targetOwnerId,
		targetFencingToken: value.targetFencingToken,
		targetAcquiredAt: value.targetAcquiredAt,
		targetExpiresAt: value.targetExpiresAt,
		state: value.state,
		createdAt: value.createdAt,
		revision: value.revision,
	};
	if (value.sourceAttemptId !== undefined) {
		(transfer as { sourceAttemptId?: string }).sourceAttemptId = value.sourceAttemptId;
	}
	if (value.committedAt !== undefined) (transfer as { committedAt?: string }).committedAt = value.committedAt;
	return transfer;
}

function parseClaimTransfer(value: unknown): ResultValue<SchedulerClaimTransfer, FoundationError> {
	if (!isRecord(value) || Object.keys(value).some((key) => !CLAIM_TRANSFER_KEYS.has(key))) {
		return fail("scheduler_handoff_invalid");
	}
	if (
		value.schemaVersion !== 1 ||
		!isSafeIdentifier(value.transferId) ||
		!isSafeIdentifier(value.queueEntryId) ||
		!isSafeIdentifier(value.taskId) ||
		!isSafeIdentifier(value.sourceClaimId) ||
		!isSafeIdentifier(value.sourceOwnerId) ||
		!isSafeIdentifier(value.sourceFencingToken) ||
		(value.sourceEntryState !== "claimed" && value.sourceEntryState !== "dispatched") ||
		!isSafeIdentifier(value.targetClaimId) ||
		!isSafeIdentifier(value.targetOwnerId) ||
		!isSafeIdentifier(value.targetFencingToken) ||
		!isCanonicalTimestamp(value.targetAcquiredAt) ||
		!isCanonicalTimestamp(value.targetExpiresAt) ||
		(value.state !== "prepared" && value.state !== "committed") ||
		!isCanonicalTimestamp(value.createdAt) ||
		typeof value.revision !== "number" ||
		!Number.isInteger(value.revision)
	) {
		return fail("scheduler_handoff_invalid");
	}
	if (value.sourceAttemptId !== undefined && !isSafeIdentifier(value.sourceAttemptId)) {
		return fail("scheduler_handoff_invalid");
	}
	if (
		value.sourceOwnerId === value.targetOwnerId ||
		value.sourceClaimId === value.targetClaimId ||
		value.sourceFencingToken === value.targetFencingToken ||
		value.targetAcquiredAt !== value.createdAt ||
		Date.parse(value.targetExpiresAt) - Date.parse(value.targetAcquiredAt) < SCHEDULER_CLAIM_MIN_LEASE_TTL_MS ||
		Date.parse(value.targetExpiresAt) - Date.parse(value.targetAcquiredAt) > SCHEDULER_CLAIM_MAX_LEASE_TTL_MS
	) {
		return fail("scheduler_handoff_invalid");
	}
	if (value.sourceEntryState === "claimed" && value.sourceAttemptId !== undefined) {
		return fail("scheduler_handoff_invalid");
	}
	if (value.sourceEntryState === "dispatched" && value.sourceAttemptId === undefined) {
		return fail("scheduler_handoff_invalid");
	}
	if (
		(value.state === "prepared" && (value.revision !== 0 || value.committedAt !== undefined)) ||
		(value.state === "committed" &&
			(value.revision !== 1 ||
				!isCanonicalTimestamp(value.committedAt) ||
				Date.parse(value.committedAt) < Date.parse(value.createdAt)))
	) {
		return fail("scheduler_handoff_invalid");
	}
	return Result.ok(serializeClaimTransfer(value as unknown as SchedulerClaimTransfer));
}

function sameClaimTransferIdentity(left: SchedulerClaimTransfer, right: SchedulerClaimTransfer): boolean {
	return (
		left.transferId === right.transferId &&
		left.queueEntryId === right.queueEntryId &&
		left.taskId === right.taskId &&
		left.sourceClaimId === right.sourceClaimId &&
		left.sourceOwnerId === right.sourceOwnerId &&
		left.sourceFencingToken === right.sourceFencingToken &&
		left.sourceEntryState === right.sourceEntryState &&
		left.sourceAttemptId === right.sourceAttemptId &&
		left.targetClaimId === right.targetClaimId &&
		left.targetOwnerId === right.targetOwnerId &&
		left.targetFencingToken === right.targetFencingToken &&
		left.targetAcquiredAt === right.targetAcquiredAt &&
		left.targetExpiresAt === right.targetExpiresAt &&
		left.createdAt === right.createdAt
	);
}

function optionalCorrelation(
	entry: SchedulerQueueEntry,
	extra: { dispatchId?: string; attemptId?: string } = {},
): EventCorrelationRef {
	const correlation: EventCorrelationRef = { sessionId: entry.sessionId, taskId: entry.taskId };
	if (entry.workflowId !== undefined) correlation.workflowId = entry.workflowId;
	if (extra.dispatchId !== undefined) correlation.dispatchId = extra.dispatchId;
	if (extra.attemptId !== undefined) correlation.attemptId = extra.attemptId;
	return correlation;
}

function queueEventPayload(entry: SchedulerQueueEntry): FoundationJsonValue {
	const payload: {
		schemaVersion: 1;
		queueEntryId: string;
		sessionId: string;
		taskId: string;
		state: string;
		revision: number;
		nodeId?: string;
		graphRevision?: number;
		claimId?: string;
		workflowId?: string;
		goalId?: string;
	} = {
		schemaVersion: 1,
		queueEntryId: entry.queueEntryId,
		sessionId: entry.sessionId,
		taskId: entry.taskId,
		state: entry.state,
		revision: entry.revision,
	};
	if (entry.nodeRef !== undefined) {
		payload.nodeId = entry.nodeRef.nodeId;
		payload.graphRevision = entry.nodeRef.graphRevision;
	}
	if (entry.claimId !== undefined) payload.claimId = entry.claimId;
	if (entry.workflowId !== undefined) payload.workflowId = entry.workflowId;
	if (entry.goalId !== undefined) payload.goalId = entry.goalId;
	return payload;
}

function claimEventPayload(claim: SchedulerClaim, sessionId: string): FoundationJsonValue {
	return {
		schemaVersion: 1,
		claimId: claim.claimId,
		queueEntryId: claim.queueEntryId,
		taskId: claim.taskId,
		ownerId: claim.ownerId,
		revision: claim.revision,
		sessionId,
	};
}

function dispatchEventPayload(dispatch: SchedulerDispatchRecord): FoundationJsonValue {
	const payload: {
		schemaVersion: 1;
		queueEntryId: string;
		claimId: string;
		dispatchId: string;
		providerId: string;
		providerClass: string;
		status: string;
		revision: number;
		attemptId?: string;
		reservationId?: string;
	} = {
		schemaVersion: 1,
		queueEntryId: dispatch.queueEntryId,
		claimId: dispatch.claimId,
		dispatchId: dispatch.dispatchId,
		providerId: dispatch.providerId,
		providerClass: dispatch.providerClass,
		status: dispatch.status,
		revision: dispatch.revision,
	};
	if (dispatch.attemptId !== undefined) payload.attemptId = dispatch.attemptId;
	if (dispatch.reservationId !== undefined) payload.reservationId = dispatch.reservationId;
	return payload;
}

export class SchedulerQueueStore {
	private readonly ledger: DurableLedgerApi;
	private readonly sessionId: string;
	private readonly ownerId: string;
	private readonly lane: string;
	private readonly clock: RuntimeClock;
	private readonly nowFn: () => string;
	private readonly writerLeaseTtlMs: number;
	private readonly cancelAttempt: SchedulerCancelAttempt | undefined;
	private readonly defaultMaxAttempts: number;
	private writerLease: LedgerWriterLease | undefined;
	private entries = new Map<string, SchedulerQueueEntry>();
	private keys = new Map<string, string>();
	private claims = new Map<string, SchedulerClaim>();
	private claimTransfers = new Map<string, SchedulerClaimTransfer>();
	private dispatches = new Map<string, SchedulerDispatchRecord>();
	private policies = new Map<string, number>();
	private objectRevisions = new Map<string, number>();
	private mutationTail: Promise<void> = Promise.resolve();

	constructor(options: SchedulerQueueStoreOptions) {
		this.clock = runtimeClockFor(options);
		this.ledger = options.ledger;
		this.sessionId = options.sessionId;
		this.ownerId = options.ownerId;
		this.lane = options.lane ?? "main";
		this.nowFn = options.now ?? (() => new Date(this.clock.wallNow()).toISOString());
		this.writerLeaseTtlMs = options.writerLeaseTtlMs ?? 15 * 60 * 1000;
		this.cancelAttempt = options.cancelAttempt;
		this.defaultMaxAttempts = options.maxAttempts ?? SCHEDULER_DEFAULT_MAX_ATTEMPTS;
	}

	async reload(): Promise<ResultValue<SchedulerQueueSnapshot, FoundationError>> {
		try {
			const records = await this.ledger.findFoundationRecords({ order: "oldestFirst", includePruned: true });
			return this.replay(records);
		} catch (error) {
			return Result.err(mapLedgerError(error, "scheduler_persistence_failed"));
		}
	}

	async enqueue(
		candidate: unknown,
		options: { maxAttempts?: number } = {},
	): Promise<ResultValue<SchedulerEnqueueResult, FoundationError>> {
		const loaded = await this.reload();
		if (!loaded.ok) return loaded;
		const parsed = parseSchedulerQueueEntry(candidate);
		if (!parsed.ok) return parsed;
		const next = parsed.value;
		if (next.sessionId !== this.sessionId) return fail("scheduler_queue_invalid");
		const maxAttempts = options.maxAttempts ?? this.defaultMaxAttempts;
		if (!Number.isInteger(maxAttempts) || maxAttempts < 1) return fail("scheduler_queue_invalid");
		const keyId = keyObjectId(next.sessionId, next.taskId, next.nodeRef);
		const existingId = this.keys.get(keyId);
		const existing = existingId === undefined ? undefined : this.entries.get(existingId);
		if (existingId !== undefined && existing === undefined) {
			if (existingId !== next.queueEntryId) return fail("scheduler_queue_conflict");
			const interrupted = enqueueSchedulerQueueEntry(undefined, next);
			if (!interrupted.ok) return interrupted;
			const completed = await this.writeInterruptedEnqueue(next, maxAttempts);
			if (!completed.ok) return completed;
			return interrupted;
		}
		if (existing !== undefined && existing.queueEntryId !== next.queueEntryId) return fail("scheduler_queue_invalid");
		const queued = this.entries.get(next.queueEntryId);
		if (queued !== undefined && existing === undefined) return fail("scheduler_queue_invalid");
		const applied = enqueueSchedulerQueueEntry(existing, next);
		if (!applied.ok) return applied;
		if (applied.value.idempotent) {
			const policy = this.policies.get(next.taskId);
			if (policy !== undefined && policy !== maxAttempts) return fail("scheduler_queue_conflict");
			return applied;
		}
		const active = [...this.entries.values()].filter((entry) => !isSchedulerQueueTerminal(entry.state)).length;
		if (active >= SCHEDULER_QUEUE_MAX_DEPTH) return fail("scheduler_backpressure");
		const written = await this.writeEnqueue(next, keyId, maxAttempts);
		if (!written.ok) return written;
		return applied;
	}

	async claim(request: SchedulerClaimRequest): Promise<ResultValue<SchedulerClaimAcquireResult, FoundationError>> {
		const loaded = await this.reload();
		if (!loaded.ok) return loaded;
		const nowIso = this.nowIso();
		const current = this.entries.get(request.queueEntryId);
		if (current === undefined) return fail("scheduler_not_found");
		if (current.sessionId !== this.sessionId) return fail("scheduler_queue_invalid");
		if (current.notBefore !== undefined && Date.parse(nowIso) < Date.parse(current.notBefore)) {
			return fail("scheduler_queue_invalid");
		}
		const ttlMs = request.ttlMs ?? SCHEDULER_CLAIM_MAX_LEASE_TTL_MS;
		if (ttlMs < SCHEDULER_CLAIM_MIN_LEASE_TTL_MS || ttlMs > SCHEDULER_CLAIM_MAX_LEASE_TTL_MS) {
			return fail("scheduler_queue_invalid");
		}
		const claim: SchedulerClaim = {
			schemaVersion: 1,
			claimId: request.claimId ?? newSafeId("claim"),
			queueEntryId: current.queueEntryId,
			taskId: current.taskId,
			ownerId: request.ownerId,
			fencingToken: request.fencingToken ?? newSafeId("fence"),
			acquiredAt: nowIso,
			expiresAt: plusMs(nowIso, ttlMs),
			revision: 0,
		};
		const acquired = applySchedulerClaimAcquire(current, claim, nowIso);
		if (!acquired.ok) return acquired;
		const persisted = await this.writeClaimAcquire(acquired.value.entry, acquired.value.claim);
		if (!persisted.ok) return persisted;
		return Result.ok(acquired.value);
	}

	async renew(request: SchedulerClaimRenewRequest): Promise<ResultValue<SchedulerClaim, FoundationError>> {
		const loaded = await this.reload();
		if (!loaded.ok) return loaded;
		const nowIso = this.nowIso();
		const current = this.claims.get(request.claimId);
		if (current === undefined) return fail("scheduler_not_found");
		const fenced = assertSchedulerFencingToken(current, request.fencingToken, nowIso);
		if (!fenced.ok) return fenced;
		const entry = this.entries.get(current.queueEntryId);
		if (
			entry?.claimId !== current.claimId ||
			this.isReleasedSourceFence(current.queueEntryId, request.fencingToken)
		) {
			return fail("scheduler_lease_lost");
		}
		const ttlMs = request.ttlMs ?? SCHEDULER_CLAIM_MAX_LEASE_TTL_MS;
		const next: SchedulerClaim = {
			...serializeSchedulerClaim(current),
			revision: current.revision + 1,
			expiresAt: plusMs(nowIso, ttlMs),
		};
		const renewed = applySchedulerClaimRenew(current, next, request.fencingToken, nowIso);
		if (!renewed.ok) return renewed;
		const persisted = await this.writeClaim(renewed.value, "scheduler.claim_renewed");
		if (!persisted.ok) return persisted;
		this.claims.set(renewed.value.claimId, renewed.value);
		return Result.ok(renewed.value);
	}

	/**
	 * Explicitly transfer one claimed/dispatched entry to a new claim. The
	 * prepared transfer fact fences the source before the target claim is
	 * issued. Replaying the same transferId resumes the durable sequence.
	 */
	async transferClaim(
		request: SchedulerClaimTransferRequest,
	): Promise<ResultValue<SchedulerClaimTransferResult, FoundationError>> {
		return this.withDurableMutation(() => this.transferClaimUnlocked(request));
	}

	private async transferClaimUnlocked(
		request: SchedulerClaimTransferRequest,
	): Promise<ResultValue<SchedulerClaimTransferResult, FoundationError>> {
		const loaded = await this.reload();
		if (!loaded.ok) return loaded;
		const existing = this.claimTransfers.get(request.transferId);
		if (existing !== undefined) {
			if (
				existing.queueEntryId !== request.queueEntryId ||
				existing.sourceFencingToken !== request.sourceFencingToken ||
				existing.targetOwnerId !== request.targetOwnerId ||
				(request.targetClaimId !== undefined && existing.targetClaimId !== request.targetClaimId) ||
				(request.targetFencingToken !== undefined &&
					existing.targetFencingToken !== request.targetFencingToken) ||
				(request.cancelledAttemptId !== undefined &&
					existing.sourceAttemptId !== request.cancelledAttemptId)
			) {
				return fail("scheduler_handoff_invalid");
			}
			return this.resumeClaimTransfer(existing);
		}
		if (!isSafeIdentifier(request.transferId) || !isSafeIdentifier(request.targetOwnerId)) {
			return fail("scheduler_handoff_invalid");
		}
		const entry = this.entries.get(request.queueEntryId);
		if (entry === undefined) return fail("scheduler_not_found");
		if ((entry.state !== "claimed" && entry.state !== "dispatched") || entry.claimId === undefined) {
			return fail("scheduler_handoff_invalid");
		}
		const sourceClaim = this.claims.get(entry.claimId);
		if (sourceClaim === undefined) return fail("scheduler_not_found");
		const fenced = assertSchedulerFencingToken(sourceClaim, request.sourceFencingToken, this.nowIso());
		if (!fenced.ok) return fenced;
		if (sourceClaim.ownerId === request.targetOwnerId) return fail("scheduler_handoff_invalid");
		if (
			[...this.claimTransfers.values()].some(
				(transfer) => transfer.queueEntryId === entry.queueEntryId && transfer.state === "prepared",
			)
		) {
			return fail("scheduler_claim_conflict");
		}
		const liveDispatches = this.nonTerminalDispatchesFor(entry.queueEntryId);
		let sourceAttemptId: string | undefined;
		if (entry.state === "dispatched") {
			if (
				liveDispatches.length !== 1 ||
				liveDispatches[0]?.claimId !== sourceClaim.claimId ||
				liveDispatches[0].attemptId === undefined ||
				liveDispatches[0].attemptId !== request.cancelledAttemptId
			) {
				return fail("scheduler_attempt_recovery_failed");
			}
			sourceAttemptId = liveDispatches[0].attemptId;
		} else if (liveDispatches.length > 0 || request.cancelledAttemptId !== undefined) {
			return fail("scheduler_handoff_invalid");
		}
		const ttlMs = request.ttlMs ?? SCHEDULER_CLAIM_MAX_LEASE_TTL_MS;
		if (ttlMs < SCHEDULER_CLAIM_MIN_LEASE_TTL_MS || ttlMs > SCHEDULER_CLAIM_MAX_LEASE_TTL_MS) {
			return fail("scheduler_handoff_invalid");
		}
		const createdAt = this.nowIso();
		const targetClaimId = request.targetClaimId ?? newSafeId("claim");
		const targetFencingToken = request.targetFencingToken ?? newSafeId("fence");
		const targetClaim: SchedulerClaim = {
			schemaVersion: 1,
			claimId: targetClaimId,
			queueEntryId: entry.queueEntryId,
			taskId: entry.taskId,
			ownerId: request.targetOwnerId,
			fencingToken: targetFencingToken,
			acquiredAt: createdAt,
			expiresAt: plusMs(createdAt, ttlMs),
			revision: 0,
		};
		const parsedTarget = parseSchedulerClaim(targetClaim);
		if (!parsedTarget.ok) return parsedTarget;
		const prepared: SchedulerClaimTransfer = {
			schemaVersion: 1,
			transferId: request.transferId,
			queueEntryId: entry.queueEntryId,
			taskId: entry.taskId,
			sourceClaimId: sourceClaim.claimId,
			sourceOwnerId: sourceClaim.ownerId,
			sourceFencingToken: sourceClaim.fencingToken,
			sourceEntryState: entry.state,
			...(sourceAttemptId === undefined ? {} : { sourceAttemptId }),
			targetClaimId: parsedTarget.value.claimId,
			targetOwnerId: parsedTarget.value.ownerId,
			targetFencingToken: parsedTarget.value.fencingToken,
			targetAcquiredAt: parsedTarget.value.acquiredAt,
			targetExpiresAt: parsedTarget.value.expiresAt,
			state: "prepared",
			createdAt,
			revision: 0,
		};
		const parsedTransfer = parseClaimTransfer(prepared);
		if (!parsedTransfer.ok) return parsedTransfer;
		const written = await this.writeClaimTransfer(parsedTransfer.value);
		if (!written.ok) return written;
		this.claimTransfers.set(parsedTransfer.value.transferId, parsedTransfer.value);
		return this.resumeClaimTransfer(parsedTransfer.value);
	}

	async markDispatched(
		request: SchedulerDispatchRequest,
	): Promise<ResultValue<SchedulerDispatchResult, FoundationError>> {
		return this.withDurableMutation(() => this.markDispatchedUnlocked(request));
	}

	private async markDispatchedUnlocked(
		request: SchedulerDispatchRequest,
	): Promise<ResultValue<SchedulerDispatchResult, FoundationError>> {
		const loaded = await this.reload();
		if (!loaded.ok) return loaded;
		const nowIso = this.nowIso();
		const current = this.entries.get(request.queueEntryId);
		if (current === undefined) return fail("scheduler_not_found");
		if (this.isReleasedSourceFence(current.queueEntryId, request.fencingToken)) {
			return fail("scheduler_lease_lost");
		}
		if (current.claimId === undefined) return fail("scheduler_queue_invalid");
		const claim = this.claims.get(current.claimId);
		if (claim === undefined) return fail("scheduler_not_found");
		const fenced = assertSchedulerFencingToken(claim, request.fencingToken, nowIso);
		if (!fenced.ok) return fenced;
		const existingDispatch = this.dispatches.get(request.dispatchId);
		if (existingDispatch !== undefined) {
			return this.resumeMarkDispatched(current, claim, existingDispatch, request);
		}
		if (this.nonTerminalDispatchesFor(current.queueEntryId).length > 0) {
			return fail("scheduler_dispatch_invalid");
		}
		const dispatchedEntry: SchedulerQueueEntry = {
			...serializeSchedulerQueueEntry(current),
			state: "dispatched",
			claimId: claim.claimId,
			revision: current.revision + 1,
		};
		const applied = applySchedulerQueueTransition(current, dispatchedEntry);
		if (!applied.ok) return applied;
		const prepared: SchedulerDispatchRecord = {
			schemaVersion: 1,
			queueEntryId: current.queueEntryId,
			claimId: claim.claimId,
			dispatchId: request.dispatchId,
			providerId: request.providerId,
			providerClass: request.providerClass,
			status: "prepared",
			revision: 0,
		};
		if (request.reservationId !== undefined) {
			(prepared as { reservationId?: string }).reservationId = request.reservationId;
		}
		const parsedPrepared = parseSchedulerDispatchRecord(prepared);
		if (!parsedPrepared.ok) return parsedPrepared;
		const inFlight: SchedulerDispatchRecord = {
			...parsedPrepared.value,
			status: "in_flight",
			attemptId: request.attemptId,
			revision: 1,
		};
		const appliedDispatch = applySchedulerDispatchTransition(parsedPrepared.value, inFlight);
		if (!appliedDispatch.ok) return appliedDispatch;
		const persisted = await this.writeDispatch(applied.value, claim, parsedPrepared.value, appliedDispatch.value);
		if (!persisted.ok) return persisted;
		return Result.ok({ entry: applied.value, claim, dispatch: appliedDispatch.value });
	}

	/**
	 * Fence and terminalize the queue projection after Host settlement. The
	 * dispatch fact is terminalized before the queue entry so a crash between
	 * the two appends can resume the exact transition without reopening work.
	 */
	async markTerminal(
		request: SchedulerQueueTerminalRequest,
	): Promise<ResultValue<SchedulerDispatchResult, FoundationError>> {
		return this.withDurableMutation(() => this.markTerminalUnlocked(request));
	}

	private async markTerminalUnlocked(
		request: SchedulerQueueTerminalRequest,
	): Promise<ResultValue<SchedulerDispatchResult, FoundationError>> {
		const loaded = await this.reload();
		if (!loaded.ok) return loaded;
		const entry = this.entries.get(request.queueEntryId);
		if (entry === undefined) return fail("scheduler_not_found");
		if (this.isReleasedSourceFence(entry.queueEntryId, request.fencingToken)) {
			return fail("scheduler_lease_lost");
		}
		if (entry.state === "settled" || entry.state === "cancelled") {
			return fail("scheduler_dispatch_invalid");
		}
		if (entry.state !== "dispatched" || entry.claimId === undefined) {
			return fail("scheduler_queue_invalid");
		}
		const claim = this.claims.get(entry.claimId);
		if (claim === undefined) return fail("scheduler_not_found");
		const fenced = assertSchedulerFencingToken(claim, request.fencingToken, this.nowIso());
		if (!fenced.ok) return fenced;
		const dispatch = this.dispatches.get(request.dispatchId);
		if (
			dispatch === undefined ||
			dispatch.queueEntryId !== entry.queueEntryId ||
			dispatch.claimId !== claim.claimId ||
			dispatch.attemptId !== request.attemptId
		) {
			return fail("scheduler_dispatch_invalid");
		}
		const dispatchStatus = request.outcome === "settled" ? "settled" : "cancelled";
		let terminalDispatch = dispatch;
		if (dispatch.status === "in_flight") {
			const candidate: SchedulerDispatchRecord = {
				...serializeSchedulerDispatchRecord(dispatch),
				status: dispatchStatus,
				revision: dispatch.revision + 1,
			};
			const appliedDispatch = applySchedulerDispatchTransition(dispatch, candidate);
			if (!appliedDispatch.ok) return appliedDispatch;
			const persistedDispatch = await this.writeDispatchRecord(appliedDispatch.value);
			if (!persistedDispatch.ok) return persistedDispatch;
			terminalDispatch = appliedDispatch.value;
			this.dispatches.set(terminalDispatch.dispatchId, terminalDispatch);
		} else if (dispatch.status !== dispatchStatus) {
			return fail("scheduler_dispatch_invalid");
		}
		const terminalEntry: SchedulerQueueEntry = {
			...serializeSchedulerQueueEntry(entry),
			state: request.outcome,
			revision: entry.revision + 1,
		};
		const appliedEntry = applySchedulerQueueTransition(entry, terminalEntry);
		if (!appliedEntry.ok) return appliedEntry;
		const persistedEntry = await this.writeQueueEntry(appliedEntry.value);
		if (!persistedEntry.ok) return persistedEntry;
		this.entries.set(appliedEntry.value.queueEntryId, appliedEntry.value);
		const released = await this.writeClaimEvent(claim, "scheduler.claim_released");
		if (!released.ok) return released;
		return Result.ok({ entry: appliedEntry.value, claim, dispatch: terminalDispatch });
	}

	async recoverExpired(): Promise<ResultValue<readonly SchedulerRecoveryOutcome[], FoundationError>> {
		const loaded = await this.reload();
		if (!loaded.ok) return loaded;
		const nowIso = this.nowIso();
		const outcomes: SchedulerRecoveryOutcome[] = [];
		const candidates = [...this.entries.values()].filter(
			(entry) => entry.state === "claimed" || entry.state === "dispatched",
		);
		for (const entry of candidates) {
			const claim = entry.claimId === undefined ? undefined : this.claims.get(entry.claimId);
			if (claim !== undefined && isSchedulerClaimActive(claim, nowIso)) continue;
			const recovered = await this.recoverOne(entry, claim);
			if (!recovered.ok) return recovered;
			outcomes.push(recovered.value);
		}
		return Result.ok(outcomes);
	}

	async getEntry(queueEntryId: string): Promise<ResultValue<SchedulerQueueEntry, FoundationError>> {
		const loaded = await this.reload();
		if (!loaded.ok) return loaded;
		const entry = this.entries.get(queueEntryId);
		return entry === undefined ? fail("scheduler_not_found") : Result.ok(serializeSchedulerQueueEntry(entry));
	}

	async getClaim(claimId: string): Promise<ResultValue<SchedulerClaim, FoundationError>> {
		const loaded = await this.reload();
		if (!loaded.ok) return loaded;
		const claim = this.claims.get(claimId);
		return claim === undefined ? fail("scheduler_not_found") : Result.ok(serializeSchedulerClaim(claim));
	}

	async getClaimTransfer(
		transferId: string,
	): Promise<ResultValue<SchedulerClaimTransfer, FoundationError>> {
		const loaded = await this.reload();
		if (!loaded.ok) return loaded;
		const transfer = this.claimTransfers.get(transferId);
		return transfer === undefined ? fail("scheduler_not_found") : Result.ok(serializeClaimTransfer(transfer));
	}

	async snapshot(): Promise<ResultValue<SchedulerQueueSnapshot, FoundationError>> {
		return this.reload();
	}

	writerLeaseToken(): string | undefined {
		return this.writerLease?.fencingToken;
	}

	private nowIso(): string {
		return this.nowFn();
	}

	private async withDurableMutation<T>(
		operation: () => Promise<ResultValue<T, FoundationError>>,
	): Promise<ResultValue<T, FoundationError>> {
		const predecessor = this.mutationTail;
		let release = (): void => {};
		const current = new Promise<void>((resolve) => {
			release = resolve;
		});
		this.mutationTail = predecessor.then(() => current);
		await predecessor;
		try {
			return await operation();
		} finally {
			release();
		}
	}

	private objectKey(objectType: string, objectId: string): string {
		return `${objectType}\0${objectId}`;
	}

	private replay(records: readonly FoundationRecord[]): ResultValue<SchedulerQueueSnapshot, FoundationError> {
		this.entries = new Map();
		this.keys = new Map();
		this.claims = new Map();
		this.claimTransfers = new Map();
		this.dispatches = new Map();
		this.policies = new Map();
		this.objectRevisions = new Map();
		for (const record of records) {
			const fact = asFact(record);
			if (fact === undefined) continue;
			this.objectRevisions.set(this.objectKey(fact.objectType, fact.objectId), fact.revision);
			if (fact.objectType === SCHEDULER_QUEUE_ENTRY_OBJECT_TYPE) {
				const parsed = parseSchedulerQueueEntry(fact.payload);
				if (!parsed.ok) return parsed;
				if (parsed.value.sessionId !== this.sessionId) return fail("scheduler_queue_invalid");
				const previous = this.entries.get(parsed.value.queueEntryId);
				if (previous === undefined) {
					if (parsed.value.state !== "queued" || parsed.value.revision !== 0)
						return fail("scheduler_queue_invalid");
					this.entries.set(parsed.value.queueEntryId, parsed.value);
					continue;
				}
				const transferred = this.replayTransferredEntry(previous, parsed.value);
				if (transferred !== undefined) {
					if (!transferred.ok) return transferred;
					this.entries.set(transferred.value.queueEntryId, transferred.value);
					continue;
				}
				const applied = applySchedulerQueueTransition(previous, parsed.value);
				if (!applied.ok) return applied;
				this.entries.set(applied.value.queueEntryId, applied.value);
				continue;
			}
			if (fact.objectType === SCHEDULER_QUEUE_KEY_OBJECT_TYPE) {
				const key = parseQueueKey(fact.payload);
				if (key === undefined) return fail("scheduler_queue_invalid");
				this.keys.set(fact.objectId, key.queueEntryId);
				continue;
			}
			if (fact.objectType === SCHEDULER_CLAIM_OBJECT_TYPE) {
				const parsed = parseSchedulerClaim(fact.payload);
				if (!parsed.ok) return parsed;
				const previous = this.claims.get(parsed.value.claimId);
				if (previous === undefined) {
					if (parsed.value.revision !== 0) return fail("scheduler_queue_invalid");
					this.claims.set(parsed.value.claimId, parsed.value);
					continue;
				}
				if (parsed.value.revision !== previous.revision + 1) return fail("scheduler_queue_invalid");
				if (
					parsed.value.queueEntryId !== previous.queueEntryId ||
					parsed.value.taskId !== previous.taskId ||
					parsed.value.ownerId !== previous.ownerId ||
					parsed.value.fencingToken !== previous.fencingToken ||
					parsed.value.acquiredAt !== previous.acquiredAt
				) {
					return fail("scheduler_queue_invalid");
				}
				this.claims.set(parsed.value.claimId, parsed.value);
				continue;
			}
			if (fact.objectType === SCHEDULER_CLAIM_TRANSFER_OBJECT_TYPE) {
				const parsed = parseClaimTransfer(fact.payload);
				if (!parsed.ok) return parsed;
				const previous = this.claimTransfers.get(parsed.value.transferId);
				if (previous === undefined) {
					if (parsed.value.state !== "prepared" || parsed.value.revision !== 0) {
						return fail("scheduler_handoff_invalid");
					}
					this.claimTransfers.set(parsed.value.transferId, parsed.value);
					continue;
				}
				if (
					previous.state !== "prepared" ||
					parsed.value.state !== "committed" ||
					parsed.value.revision !== previous.revision + 1 ||
					!sameClaimTransferIdentity(previous, parsed.value)
				) {
					return fail("scheduler_handoff_invalid");
				}
				this.claimTransfers.set(parsed.value.transferId, parsed.value);
				continue;
			}
			if (fact.objectType === SCHEDULER_DISPATCH_OBJECT_TYPE) {
				const parsed = parseSchedulerDispatchRecord(fact.payload);
				if (!parsed.ok) return parsed;
				const previous = this.dispatches.get(parsed.value.dispatchId);
				if (previous === undefined) {
					this.dispatches.set(parsed.value.dispatchId, parsed.value);
					continue;
				}
				const applied = applySchedulerDispatchTransition(previous, parsed.value);
				if (!applied.ok) return applied;
				this.dispatches.set(applied.value.dispatchId, applied.value);
				continue;
			}
			if (fact.objectType === SCHEDULER_ATTEMPT_POLICY_OBJECT_TYPE) {
				const policy = parseAttemptPolicy(fact.payload);
				if (policy === undefined) return fail("scheduler_queue_invalid");
				this.policies.set(policy.taskId, policy.maxAttempts);
			}
		}
		return Result.ok(this.currentSnapshot());
	}

	private currentSnapshot(): SchedulerQueueSnapshot {
		return {
			entries: [...this.entries.values()].map(serializeSchedulerQueueEntry),
			claims: [...this.claims.values()].map(serializeSchedulerClaim),
			dispatches: [...this.dispatches.values()].map(serializeSchedulerDispatchRecord),
		};
	}

	private replayTransferredEntry(
		previous: SchedulerQueueEntry,
		next: SchedulerQueueEntry,
	): ResultValue<SchedulerQueueEntry, FoundationError> | undefined {
		const transfer = [...this.claimTransfers.values()].find(
			(candidate) =>
				candidate.queueEntryId === previous.queueEntryId &&
				candidate.sourceClaimId === previous.claimId &&
				candidate.targetClaimId === next.claimId,
		);
		if (transfer === undefined) return undefined;
		const targetClaim = this.claims.get(transfer.targetClaimId);
		if (
			previous.state !== transfer.sourceEntryState ||
			next.state !== "claimed" ||
			next.revision !== previous.revision + 1 ||
			targetClaim === undefined ||
			targetClaim.queueEntryId !== next.queueEntryId ||
			targetClaim.taskId !== next.taskId ||
			targetClaim.ownerId !== transfer.targetOwnerId ||
			targetClaim.fencingToken !== transfer.targetFencingToken ||
			!this.sameTransferredEntryIdentity(previous, next)
		) {
			return fail("scheduler_handoff_invalid");
		}
		return Result.ok(next);
	}

	private sameTransferredEntryIdentity(left: SchedulerQueueEntry, right: SchedulerQueueEntry): boolean {
		return (
			left.queueEntryId === right.queueEntryId &&
			left.sessionId === right.sessionId &&
			left.taskId === right.taskId &&
			JSON.stringify(left.nodeRef) === JSON.stringify(right.nodeRef) &&
			left.goalId === right.goalId &&
			left.workflowId === right.workflowId &&
			left.priority === right.priority &&
			left.attemptsUsed === right.attemptsUsed &&
			left.notBefore === right.notBefore &&
			left.deadlineAt === right.deadlineAt &&
			left.enqueuedAt === right.enqueuedAt
		);
	}

	private isReleasedSourceFence(queueEntryId: string, fencingToken: string): boolean {
		return [...this.claimTransfers.values()].some(
			(transfer) =>
				transfer.queueEntryId === queueEntryId &&
				transfer.sourceFencingToken === fencingToken,
		);
	}

	private async resumeClaimTransfer(
		transfer: SchedulerClaimTransfer,
	): Promise<ResultValue<SchedulerClaimTransferResult, FoundationError>> {
		const sourceClaim = this.claims.get(transfer.sourceClaimId);
		if (
			sourceClaim === undefined ||
			sourceClaim.queueEntryId !== transfer.queueEntryId ||
			sourceClaim.taskId !== transfer.taskId ||
			sourceClaim.ownerId !== transfer.sourceOwnerId ||
			sourceClaim.fencingToken !== transfer.sourceFencingToken
		) {
			return fail("scheduler_handoff_invalid");
		}
		const targetCandidate: SchedulerClaim = {
			schemaVersion: 1,
			claimId: transfer.targetClaimId,
			queueEntryId: transfer.queueEntryId,
			taskId: transfer.taskId,
			ownerId: transfer.targetOwnerId,
			fencingToken: transfer.targetFencingToken,
			acquiredAt: transfer.targetAcquiredAt,
			expiresAt: transfer.targetExpiresAt,
			revision: 0,
		};
		const parsedTarget = parseSchedulerClaim(targetCandidate);
		if (!parsedTarget.ok) return parsedTarget;
		if (transfer.state === "prepared") {
			const released = await this.writeClaimEvent(sourceClaim, "scheduler.claim_released");
			if (!released.ok) return released;
		}
		if (transfer.sourceAttemptId !== undefined) {
			const sourceDispatch = [...this.dispatches.values()].find(
				(dispatch) =>
					dispatch.queueEntryId === transfer.queueEntryId &&
					dispatch.claimId === transfer.sourceClaimId &&
					dispatch.attemptId === transfer.sourceAttemptId,
			);
			if (sourceDispatch === undefined) return fail("scheduler_attempt_recovery_failed");
			if (!isSchedulerDispatchTerminal(sourceDispatch.status)) {
				const cancelled: SchedulerDispatchRecord = {
					...serializeSchedulerDispatchRecord(sourceDispatch),
					status: "cancelled",
					revision: sourceDispatch.revision + 1,
				};
				const applied = applySchedulerDispatchTransition(sourceDispatch, cancelled);
				if (!applied.ok) return applied;
				const written = await this.writeDispatchRecord(applied.value);
				if (!written.ok) return written;
				this.dispatches.set(applied.value.dispatchId, applied.value);
			} else if (sourceDispatch.status !== "cancelled") {
				return fail("scheduler_handoff_invalid");
			}
		}

		let targetClaim = this.claims.get(transfer.targetClaimId);
		if (targetClaim === undefined) {
			if (transfer.state === "committed") return fail("scheduler_handoff_invalid");
			const writtenTarget = await this.writeClaim(parsedTarget.value, "scheduler.claim_acquired");
			if (!writtenTarget.ok) return writtenTarget;
			targetClaim = parsedTarget.value;
			this.claims.set(targetClaim.claimId, targetClaim);
		} else if (
			targetClaim.queueEntryId !== parsedTarget.value.queueEntryId ||
			targetClaim.taskId !== parsedTarget.value.taskId ||
			targetClaim.ownerId !== parsedTarget.value.ownerId ||
			targetClaim.fencingToken !== parsedTarget.value.fencingToken ||
			targetClaim.acquiredAt !== parsedTarget.value.acquiredAt ||
			targetClaim.expiresAt !== parsedTarget.value.expiresAt
		) {
			return fail("scheduler_claim_conflict");
		}

		let entry = this.entries.get(transfer.queueEntryId);
		if (entry === undefined) return fail("scheduler_not_found");
		if (entry.claimId === transfer.sourceClaimId && entry.state === transfer.sourceEntryState) {
			const transferred: SchedulerQueueEntry = {
				...serializeSchedulerQueueEntry(entry),
				state: "claimed",
				claimId: targetClaim.claimId,
				revision: entry.revision + 1,
			};
			const parsedEntry = parseSchedulerQueueEntry(transferred);
			if (!parsedEntry.ok) return parsedEntry;
			if (!this.sameTransferredEntryIdentity(entry, parsedEntry.value)) {
				return fail("scheduler_handoff_invalid");
			}
			const writtenEntry = await this.writeQueueEntry(parsedEntry.value);
			if (!writtenEntry.ok) return writtenEntry;
			entry = parsedEntry.value;
			this.entries.set(entry.queueEntryId, entry);
		} else if (
			entry.claimId !== transfer.targetClaimId ||
			(entry.state !== "claimed" && entry.state !== "dispatched")
		) {
			return fail("scheduler_handoff_invalid");
		}

		if (transfer.state === "prepared") {
			const committedCandidate: SchedulerClaimTransfer = {
				...serializeClaimTransfer(transfer),
				state: "committed",
				committedAt: this.nowIso(),
				revision: transfer.revision + 1,
			};
			const parsedCommitted = parseClaimTransfer(committedCandidate);
			if (!parsedCommitted.ok) return parsedCommitted;
			const writtenCommitted = await this.writeClaimTransfer(parsedCommitted.value);
			if (!writtenCommitted.ok) return writtenCommitted;
			transfer = parsedCommitted.value;
			this.claimTransfers.set(transfer.transferId, transfer);
		}
		return Result.ok({ entry, sourceClaim, targetClaim, transfer });
	}

	private nonTerminalDispatchesFor(queueEntryId: string): SchedulerDispatchRecord[] {
		const live: SchedulerDispatchRecord[] = [];
		for (const dispatch of this.dispatches.values()) {
			if (dispatch.queueEntryId === queueEntryId && !isSchedulerDispatchTerminal(dispatch.status)) {
				live.push(dispatch);
			}
		}
		return live;
	}

	private async recoverOne(
		entry: SchedulerQueueEntry,
		claim: SchedulerClaim | undefined,
	): Promise<ResultValue<SchedulerRecoveryOutcome, FoundationError>> {
		let cancelledAttemptId: string | undefined;
		for (const dispatch of this.nonTerminalDispatchesFor(entry.queueEntryId)) {
			const attemptId = dispatch.attemptId;
			if (attemptId !== undefined) {
				if (this.cancelAttempt === undefined) return fail("scheduler_attempt_recovery_failed");
				let cancelled: ResultValue<void, FoundationError>;
				try {
					cancelled = await this.cancelAttempt(attemptId);
				} catch (error) {
					return Result.err(mapLedgerError(error, "scheduler_attempt_recovery_failed"));
				}
				if (!cancelled.ok) return fail("scheduler_attempt_recovery_failed");
				cancelledAttemptId = attemptId;
			}
			const expiredDispatch: SchedulerDispatchRecord = {
				...serializeSchedulerDispatchRecord(dispatch),
				status: "expired",
				revision: dispatch.revision + 1,
			};
			const appliedDispatch = applySchedulerDispatchTransition(dispatch, expiredDispatch);
			if (!appliedDispatch.ok) return appliedDispatch;
			const persistedDispatch = await this.writeDispatchRecord(appliedDispatch.value);
			if (!persistedDispatch.ok) return persistedDispatch;
			this.dispatches.set(appliedDispatch.value.dispatchId, appliedDispatch.value);
		}
		const expiredEntry: SchedulerQueueEntry = {
			...serializeSchedulerQueueEntry(entry),
			state: "expired",
			claimId: entry.claimId,
			revision: entry.revision + 1,
		};
		const expired = applySchedulerQueueTransition(entry, expiredEntry);
		if (!expired.ok) return expired;
		const persistedExpired = await this.writeQueueEntry(expired.value);
		if (!persistedExpired.ok) return persistedExpired;
		this.entries.set(expired.value.queueEntryId, expired.value);
		// attemptsUsed is the failed-recycle count; maxAttempts=1 cancels on first expiry with attemptsUsed still 0.
		const maxAttempts = this.policies.get(entry.taskId) ?? this.defaultMaxAttempts;
		const exhausted = expired.value.attemptsUsed + 1 >= maxAttempts;
		const nextEntry: SchedulerQueueEntry = exhausted
			? {
					...serializeSchedulerQueueEntry(expired.value),
					state: "cancelled",
					revision: expired.value.revision + 1,
				}
			: {
					...serializeSchedulerQueueEntry(expired.value),
					state: "queued",
					claimId: undefined,
					attemptsUsed: expired.value.attemptsUsed + 1,
					revision: expired.value.revision + 1,
				};
		const applied = applySchedulerQueueTransition(expired.value, nextEntry);
		if (!applied.ok) return applied;
		const persistedNext = await this.writeQueueEntry(applied.value);
		if (!persistedNext.ok) return persistedNext;
		this.entries.set(applied.value.queueEntryId, applied.value);
		if (claim !== undefined) {
			const released = await this.writeClaimEvent(claim, "scheduler.claim_released");
			if (!released.ok) return released;
		}
		const outcome: SchedulerRecoveryOutcome = {
			entry: applied.value,
			action: exhausted ? "cancelled" : "requeued",
			attemptsUsed: applied.value.attemptsUsed,
		};
		if (cancelledAttemptId !== undefined) {
			(outcome as { cancelledAttemptId?: string }).cancelledAttemptId = cancelledAttemptId;
		}
		return Result.ok(outcome);
	}

	private async writeEnqueue(
		entry: SchedulerQueueEntry,
		keyId: string,
		maxAttempts: number,
	): Promise<ResultValue<void, FoundationError>> {
		const keyWrite = await this.appendFact(
			SCHEDULER_QUEUE_KEY_OBJECT_TYPE,
			keyId,
			{ schemaVersion: 1, queueEntryId: entry.queueEntryId },
			`scheduler.queue_key:${keyId}`,
			0,
			optionalCorrelation(entry),
			"scheduler_queue_conflict",
		);
		if (!keyWrite.ok) {
			if (keyWrite.error.code === "scheduler_queue_conflict") {
				const reloaded = await this.reload();
				if (!reloaded.ok) return reloaded;
				const existingId = this.keys.get(keyId);
				const existing = existingId === undefined ? undefined : this.entries.get(existingId);
				const replayed = enqueueSchedulerQueueEntry(existing, entry);
				if (replayed.ok && replayed.value.idempotent) return Result.ok(undefined);
				return fail("scheduler_queue_conflict");
			}
			return keyWrite;
		}
		this.keys.set(keyId, entry.queueEntryId);
		return this.writeInterruptedEnqueue(entry, maxAttempts);
	}

	private async writeInterruptedEnqueue(
		entry: SchedulerQueueEntry,
		maxAttempts: number,
	): Promise<ResultValue<void, FoundationError>> {
		const entryWrite = await this.writeQueueEntry(entry);
		if (!entryWrite.ok) return entryWrite;
		this.entries.set(entry.queueEntryId, entry);
		if (!this.policies.has(entry.taskId)) {
			const policyWrite = await this.appendFact(
				SCHEDULER_ATTEMPT_POLICY_OBJECT_TYPE,
				entry.taskId,
				{ schemaVersion: 1, taskId: entry.taskId, maxAttempts },
				`scheduler.attempt_policy:${entry.taskId}`,
				0,
				optionalCorrelation(entry),
				"scheduler_queue_conflict",
			);
			if (!policyWrite.ok && policyWrite.error.code !== "scheduler_queue_conflict") return policyWrite;
			if (policyWrite.ok) this.policies.set(entry.taskId, maxAttempts);
		}
		return Result.ok(undefined);
	}

	private async resumeMarkDispatched(
		current: SchedulerQueueEntry,
		claim: SchedulerClaim,
		existingDispatch: SchedulerDispatchRecord,
		request: SchedulerDispatchRequest,
	): Promise<ResultValue<SchedulerDispatchResult, FoundationError>> {
		const parsedExisting = parseSchedulerDispatchRecord(existingDispatch);
		if (!parsedExisting.ok) return parsedExisting;
		const existing = parsedExisting.value;
		if (
			existing.dispatchId !== request.dispatchId ||
			existing.queueEntryId !== current.queueEntryId ||
			existing.claimId !== claim.claimId ||
			existing.providerId !== request.providerId ||
			existing.providerClass !== request.providerClass ||
			existing.reservationId !== request.reservationId
		) {
			return fail("scheduler_dispatch_invalid");
		}
		if (existing.status === "in_flight") {
			if (existing.attemptId !== request.attemptId) return fail("scheduler_dispatch_invalid");
			return this.finishDispatchedEntry(current, claim, existing);
		}
		if (existing.status !== "prepared") return fail("scheduler_dispatch_invalid");
		const inFlight: SchedulerDispatchRecord = {
			...serializeSchedulerDispatchRecord(existing),
			status: "in_flight",
			attemptId: request.attemptId,
			revision: existing.revision + 1,
		};
		const appliedDispatch = applySchedulerDispatchTransition(existing, inFlight);
		if (!appliedDispatch.ok) return appliedDispatch;
		const persistedDispatch = await this.writeDispatchRecord(appliedDispatch.value);
		if (!persistedDispatch.ok) return persistedDispatch;
		return this.finishDispatchedEntry(current, claim, appliedDispatch.value);
	}

	private async finishDispatchedEntry(
		current: SchedulerQueueEntry,
		claim: SchedulerClaim,
		dispatch: SchedulerDispatchRecord,
	): Promise<ResultValue<SchedulerDispatchResult, FoundationError>> {
		if (current.state === "dispatched") {
			this.claims.set(claim.claimId, claim);
			this.dispatches.set(dispatch.dispatchId, dispatch);
			return Result.ok({ entry: current, claim, dispatch });
		}
		if (current.state !== "claimed") return fail("scheduler_queue_invalid");
		const dispatchedEntry: SchedulerQueueEntry = {
			...serializeSchedulerQueueEntry(current),
			state: "dispatched",
			claimId: claim.claimId,
			revision: current.revision + 1,
		};
		const applied = applySchedulerQueueTransition(current, dispatchedEntry);
		if (!applied.ok) return applied;
		const persisted = await this.writeQueueEntry(applied.value);
		if (!persisted.ok) return persisted;
		this.entries.set(applied.value.queueEntryId, applied.value);
		this.claims.set(claim.claimId, claim);
		this.dispatches.set(dispatch.dispatchId, dispatch);
		return Result.ok({ entry: applied.value, claim, dispatch });
	}

	private async writeClaimAcquire(
		entry: SchedulerQueueEntry,
		claim: SchedulerClaim,
	): Promise<ResultValue<void, FoundationError>> {
		const entryWrite = await this.writeQueueEntry(entry, "scheduler_claim_conflict");
		if (!entryWrite.ok) return entryWrite;
		const claimWrite = await this.writeClaim(claim, "scheduler.claim_acquired");
		if (!claimWrite.ok) return claimWrite;
		this.entries.set(entry.queueEntryId, entry);
		this.claims.set(claim.claimId, claim);
		return Result.ok(undefined);
	}

	private async writeDispatch(
		entry: SchedulerQueueEntry,
		claim: SchedulerClaim,
		prepared: SchedulerDispatchRecord,
		inFlight: SchedulerDispatchRecord,
	): Promise<ResultValue<void, FoundationError>> {
		const preparedWrite = await this.writeDispatchRecord(prepared);
		if (!preparedWrite.ok) return preparedWrite;
		const inFlightWrite = await this.writeDispatchRecord(inFlight);
		if (!inFlightWrite.ok) return inFlightWrite;
		const entryWrite = await this.writeQueueEntry(entry);
		if (!entryWrite.ok) return entryWrite;
		this.entries.set(entry.queueEntryId, entry);
		this.claims.set(claim.claimId, claim);
		this.dispatches.set(inFlight.dispatchId, inFlight);
		return Result.ok(undefined);
	}

	private async writeQueueEntry(
		entry: SchedulerQueueEntry,
		staleCode: SchedulerErrorCode = "scheduler_persistence_failed",
	): Promise<ResultValue<void, FoundationError>> {
		const expectedRevision =
			this.objectRevisions.get(this.objectKey(SCHEDULER_QUEUE_ENTRY_OBJECT_TYPE, entry.queueEntryId)) ?? 0;
		const written = await this.appendFact(
			SCHEDULER_QUEUE_ENTRY_OBJECT_TYPE,
			entry.queueEntryId,
			serializeSchedulerQueueEntry(entry),
			`scheduler.queue_entry:${entry.queueEntryId}:${entry.revision}`,
			expectedRevision,
			optionalCorrelation(entry),
			staleCode,
		);
		if (!written.ok) return written;
		const eventWrite = await this.writeDurableEvent(
			"scheduler.queue_transitioned",
			`evt_queue_${entry.queueEntryId}_${entry.revision}`,
			optionalCorrelation(entry),
			queueEventPayload(entry),
			`scheduler.queue_transitioned:${entry.queueEntryId}:${entry.revision}`,
		);
		if (!eventWrite.ok) return eventWrite;
		this.objectRevisions.set(
			this.objectKey(SCHEDULER_QUEUE_ENTRY_OBJECT_TYPE, entry.queueEntryId),
			expectedRevision + (written.value.replayed ? 0 : 1),
		);
		return Result.ok(undefined);
	}

	private async writeClaim(
		claim: SchedulerClaim,
		category: "scheduler.claim_acquired" | "scheduler.claim_renewed",
	): Promise<ResultValue<void, FoundationError>> {
		const expectedRevision =
			this.objectRevisions.get(this.objectKey(SCHEDULER_CLAIM_OBJECT_TYPE, claim.claimId)) ?? 0;
		const written = await this.appendFact(
			SCHEDULER_CLAIM_OBJECT_TYPE,
			claim.claimId,
			serializeSchedulerClaim(claim),
			`scheduler.claim:${claim.claimId}:${claim.revision}`,
			expectedRevision,
			{ sessionId: this.sessionId, taskId: claim.taskId },
			"scheduler_persistence_failed",
		);
		if (!written.ok) return written;
		const eventWrite = await this.writeClaimEvent(claim, category);
		if (!eventWrite.ok) return eventWrite;
		this.objectRevisions.set(
			this.objectKey(SCHEDULER_CLAIM_OBJECT_TYPE, claim.claimId),
			expectedRevision + (written.value.replayed ? 0 : 1),
		);
		return Result.ok(undefined);
	}

	private async writeClaimTransfer(
		transfer: SchedulerClaimTransfer,
	): Promise<ResultValue<void, FoundationError>> {
		const expectedRevision =
			this.objectRevisions.get(this.objectKey(SCHEDULER_CLAIM_TRANSFER_OBJECT_TYPE, transfer.transferId)) ?? 0;
		const written = await this.appendFact(
			SCHEDULER_CLAIM_TRANSFER_OBJECT_TYPE,
			transfer.transferId,
			serializeClaimTransfer(transfer),
			`scheduler.claim_transfer:${transfer.transferId}:${transfer.revision}`,
			expectedRevision,
			{ sessionId: this.sessionId, taskId: transfer.taskId },
			"scheduler_persistence_failed",
		);
		if (!written.ok) return written;
		this.objectRevisions.set(
			this.objectKey(SCHEDULER_CLAIM_TRANSFER_OBJECT_TYPE, transfer.transferId),
			expectedRevision + (written.value.replayed ? 0 : 1),
		);
		return Result.ok(undefined);
	}

	private async writeClaimEvent(
		claim: SchedulerClaim,
		category: "scheduler.claim_acquired" | "scheduler.claim_renewed" | "scheduler.claim_released",
	): Promise<ResultValue<void, FoundationError>> {
		return this.writeDurableEvent(
			category,
			`evt_claim_${claim.claimId}_${claim.revision}_${category.split(".")[1] ?? "event"}`,
			{ sessionId: this.sessionId, taskId: claim.taskId },
			claimEventPayload(claim, this.sessionId),
			`${category}:${claim.claimId}:${claim.revision}`,
		);
	}

	private async writeDispatchRecord(dispatch: SchedulerDispatchRecord): Promise<ResultValue<void, FoundationError>> {
		const expectedRevision =
			this.objectRevisions.get(this.objectKey(SCHEDULER_DISPATCH_OBJECT_TYPE, dispatch.dispatchId)) ?? 0;
		const written = await this.appendFact(
			SCHEDULER_DISPATCH_OBJECT_TYPE,
			dispatch.dispatchId,
			serializeSchedulerDispatchRecord(dispatch),
			`scheduler.dispatch:${dispatch.dispatchId}:${dispatch.revision}`,
			expectedRevision,
			{
				sessionId: this.sessionId,
				taskId: this.entries.get(dispatch.queueEntryId)?.taskId ?? dispatch.queueEntryId,
				dispatchId: dispatch.dispatchId,
				...(dispatch.attemptId === undefined ? {} : { attemptId: dispatch.attemptId }),
			},
			"scheduler_persistence_failed",
		);
		if (!written.ok) return written;
		const eventWrite = await this.writeDurableEvent(
			"scheduler.dispatch_transitioned",
			`evt_dispatch_${dispatch.dispatchId}_${dispatch.revision}`,
			{
				sessionId: this.sessionId,
				taskId: this.entries.get(dispatch.queueEntryId)?.taskId ?? dispatch.queueEntryId,
				dispatchId: dispatch.dispatchId,
				...(dispatch.attemptId === undefined ? {} : { attemptId: dispatch.attemptId }),
			},
			dispatchEventPayload(dispatch),
			`scheduler.dispatch_transitioned:${dispatch.dispatchId}:${dispatch.revision}`,
		);
		if (!eventWrite.ok) return eventWrite;
		this.objectRevisions.set(
			this.objectKey(SCHEDULER_DISPATCH_OBJECT_TYPE, dispatch.dispatchId),
			expectedRevision + (written.value.replayed ? 0 : 1),
		);
		return Result.ok(undefined);
	}

	private async writeDurableEvent(
		category: DurableEventCategory,
		eventId: string,
		correlation: EventCorrelationRef,
		payload: FoundationJsonValue,
		clientRequestId: string,
	): Promise<ResultValue<void, FoundationError>> {
		let sequence = 1;
		try {
			sequence = (await this.ledger.getLedgerRevision()) + 1;
		} catch (error) {
			return Result.err(mapLedgerError(error, "scheduler_persistence_failed"));
		}
		if (sequence < 1) sequence = 1;
		try {
			createDurableEvent({
				category,
				eventId,
				streamId: this.sessionId,
				sequence,
				timestamp: this.nowIso(),
				correlation,
				payload,
			});
		} catch (error) {
			return Result.err(mapLedgerError(error, "scheduler_queue_invalid"));
		}
		const expectedRevision = this.objectRevisions.get(this.objectKey(category, eventId)) ?? 0;
		const written = await this.appendFact(
			category,
			eventId,
			payload,
			clientRequestId,
			expectedRevision,
			correlation,
			"scheduler_persistence_failed",
		);
		if (!written.ok) return written;
		this.objectRevisions.set(this.objectKey(category, eventId), expectedRevision + (written.value.replayed ? 0 : 1));
		return Result.ok(undefined);
	}

	private async appendFact(
		objectType: string,
		objectId: string,
		payload: FoundationJsonValue | object,
		clientRequestId: string,
		expectedRevision: number,
		correlation: EventCorrelationRef,
		staleCode: SchedulerErrorCode,
	): Promise<ResultValue<{ replayed: boolean }, FoundationError>> {
		try {
			const lease = await this.ensureWriterLease();
			const result = await this.ledger.appendFoundationRecord({
				schemaVersion: 1,
				kind: "fact",
				id: `sched_${objectType.replaceAll(".", "_")}_${objectId}_${clientRequestId}`,
				lane: this.lane,
				objectType,
				objectId,
				clientRequestId,
				expectedRevision,
				payload: jsonPayload(payload),
				correlation: {
					...omitUndefinedCorrelation(correlation),
					sessionId: this.sessionId,
					laneId: this.lane,
				},
				fencingToken: lease.fencingToken,
			});
			if (result.record.kind !== "fact") return fail("scheduler_persistence_failed");
			return Result.ok({ replayed: result.replayed });
		} catch (error) {
			return Result.err(mapLedgerError(error, staleCode));
		}
	}

	private async ensureWriterLease(): Promise<LedgerWriterLease> {
		const nowMs = this.clock.wallNow();
		const current = await this.ledger.getWriterLease();
		if (
			this.writerLease !== undefined &&
			current?.fencingToken === this.writerLease.fencingToken &&
			current.expiresAt > nowMs + Math.min(WRITER_LEASE_REFRESH_MS, Math.floor(this.writerLeaseTtlMs / 4))
		) {
			return this.writerLease;
		}
		if (current?.ownerId === this.ownerId && current.expiresAt > nowMs) {
			try {
				this.writerLease = await this.ledger.renewWriterLease({
					fencingToken: current.fencingToken,
					ttlMs: this.writerLeaseTtlMs,
				});
				return this.writerLease;
			} catch (error) {
				const code = ledgerCode(error);
				if (
					code !== "session_writer_lease_expired" &&
					code !== "session_writer_fencing_token" &&
					code !== "session_writer_lease_lost"
				) {
					throw error;
				}
				this.writerLease = undefined;
			}
		}
		this.writerLease = await this.ledger.acquireWriterLease({
			ownerId: this.ownerId,
			ttlMs: this.writerLeaseTtlMs,
		});
		return this.writerLease;
	}
}

function omitUndefinedCorrelation(correlation: EventCorrelationRef): EventCorrelationRef {
	const next: EventCorrelationRef = { sessionId: correlation.sessionId };
	if (correlation.laneId !== undefined) next.laneId = correlation.laneId;
	if (correlation.taskId !== undefined) next.taskId = correlation.taskId;
	if (correlation.dispatchId !== undefined) next.dispatchId = correlation.dispatchId;
	if (correlation.attemptId !== undefined) next.attemptId = correlation.attemptId;
	if (correlation.workflowId !== undefined) next.workflowId = correlation.workflowId;
	if (correlation.askId !== undefined) next.askId = correlation.askId;
	if (correlation.goalId !== undefined) next.goalId = correlation.goalId;
	return next;
}

export function isSchedulerQueueLedgerObjectType(value: string): boolean {
	return (SCHEDULER_QUEUE_LEDGER_OBJECT_TYPES as readonly string[]).includes(value);
}

export function isSchedulerQueueProjectionEntry(value: unknown): value is SchedulerQueueEntry {
	return isSchedulerQueueEntry(value);
}

export function isSchedulerQueueProjectionClaim(value: unknown): value is SchedulerClaim {
	return isSchedulerClaim(value);
}

export function isSchedulerQueueProjectionTransfer(value: unknown): value is SchedulerClaimTransfer {
	return parseClaimTransfer(value).ok;
}

export function isSchedulerQueueProjectionDispatch(value: unknown): value is SchedulerDispatchRecord {
	return isSchedulerDispatchRecord(value);
}
