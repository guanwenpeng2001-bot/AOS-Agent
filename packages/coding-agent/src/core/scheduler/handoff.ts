/**
 * Durable Scheduler v1 ownership handoff.
 *
 * An offered handoff retains the source claim. Acceptance first records its
 * durable intent, explicitly cancels any in-flight source Attempt, and only
 * then invokes SchedulerQueueStore.transferClaim. Recovery replays the same
 * acceptance identity, so a crash cannot reactivate the source or create a
 * second target owner.
 */
import { randomUUID } from "node:crypto";
import {
	createDurableEvent,
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
	type SchedulerHandoffEventPayload,
} from "@aos-agent/agent-core";
import { runtimeClockFor, type RuntimeClock } from "../runtime/clock.ts";
import {
	applySchedulerHandoffTransition,
	isSchedulerDispatchTerminal,
	parseSchedulerOwnershipTransfer,
	SCHEDULER_CLAIM_MAX_LEASE_TTL_MS,
	SCHEDULER_CLAIM_MIN_LEASE_TTL_MS,
	serializeSchedulerOwnershipTransfer,
	type SchedulerErrorCode,
	type SchedulerOwnershipTransfer,
} from "./host.ts";
import type { SchedulerClaimTransferResult, SchedulerQueueStore } from "./queue.ts";

export const SCHEDULER_HANDOFF_OBJECT_TYPE = "scheduler.handoff";
export const SCHEDULER_HANDOFF_ACCEPTANCE_OBJECT_TYPE = "scheduler.handoff_acceptance";

const WRITER_LEASE_REFRESH_MS = 1000;
const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

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

export type SchedulerCancelSourceDispatch = (
	queueEntryId: string,
	fencingToken: string,
) => Promise<ResultValue<void, FoundationError>>;

export type SchedulerHandoffTargetAvailable = (ownerId: string) => Promise<boolean>;

export interface SchedulerHandoffControllerOptions {
	readonly ledger: DurableLedgerApi;
	readonly queue: SchedulerQueueStore;
	readonly sessionId: string;
	readonly ownerId: string;
	readonly lane?: string;
	readonly now?: () => string;
	readonly writerLeaseTtlMs?: number;
	readonly cancelSourceDispatch?: SchedulerCancelSourceDispatch;
	readonly targetAvailable?: SchedulerHandoffTargetAvailable;
}

export interface SchedulerHandoffOfferRequest {
	readonly queueEntryId: string;
	readonly transfer: unknown;
}

export interface SchedulerHandoffAcceptRequest {
	readonly transferId: string;
	readonly targetClaimId?: string;
	readonly targetFencingToken?: string;
	readonly ttlMs?: number;
}

export type SchedulerHandoffDecision = "rejected" | "cancelled";

export interface SchedulerHandoffResult {
	readonly transfer: SchedulerOwnershipTransfer;
	readonly claimTransfer?: SchedulerClaimTransferResult;
}

export interface SchedulerHandoffSnapshot {
	readonly transfers: readonly SchedulerOwnershipTransfer[];
	readonly acceptances: readonly SchedulerHandoffAcceptance[];
}

export type SchedulerHandoffAcceptanceState = "accepting" | "source_cancelled" | "claim_transferred";

export interface SchedulerHandoffAcceptance {
	readonly schemaVersion: 1;
	readonly transferId: string;
	readonly queueEntryId: string;
	readonly sourceFencingToken: string;
	readonly sourceAttemptId?: string;
	readonly targetOwnerId: string;
	readonly targetClaimId: string;
	readonly targetFencingToken: string;
	readonly ttlMs?: number;
	readonly state: SchedulerHandoffAcceptanceState;
	readonly startedAt: string;
	readonly revision: number;
}

interface SchedulerHandoffRecordV1 {
	readonly schemaVersion: 1;
	readonly queueEntryId: string;
	readonly transfer: SchedulerOwnershipTransfer;
}

const HANDOFF_RECORD_KEYS = new Set(["schemaVersion", "queueEntryId", "transfer"]);
const ACCEPTANCE_KEYS = new Set([
	"schemaVersion",
	"transferId",
	"queueEntryId",
	"sourceFencingToken",
	"sourceAttemptId",
	"targetOwnerId",
	"targetClaimId",
	"targetFencingToken",
	"ttlMs",
	"state",
	"startedAt",
	"revision",
]);

function schedulerError(code: SchedulerErrorCode): FoundationError {
	return new FoundationError(code, ERROR_MESSAGES[code], { retryable: RETRYABLE.has(code) });
}

function fail<T>(code: SchedulerErrorCode): ResultValue<T, FoundationError> {
	return Result.err(schedulerError(code));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSafeIdentifier(value: unknown): value is string {
	return typeof value === "string" && SAFE_IDENTIFIER_PATTERN.test(value);
}

function isCanonicalTimestamp(value: unknown): value is string {
	if (typeof value !== "string") return false;
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

function asFact(record: FoundationRecord): FoundationFactRecord | undefined {
	return record.kind === "fact" ? record : undefined;
}

function ledgerCode(error: unknown): string | undefined {
	if (error instanceof DurableLedgerError || error instanceof FoundationError) return error.code;
	if (isRecord(error) && typeof error.code === "string") return error.code;
	return undefined;
}

function mapLedgerError(error: unknown): FoundationError {
	if (error instanceof FoundationError) return error;
	return schedulerError("scheduler_persistence_failed");
}

function serializeHandoffRecord(value: SchedulerHandoffRecordV1): SchedulerHandoffRecordV1 {
	return {
		schemaVersion: 1,
		queueEntryId: value.queueEntryId,
		transfer: serializeSchedulerOwnershipTransfer(value.transfer),
	};
}

function parseHandoffRecord(value: unknown): ResultValue<SchedulerHandoffRecordV1, FoundationError> {
	if (
		!isRecord(value) ||
		Object.keys(value).some((key) => !HANDOFF_RECORD_KEYS.has(key)) ||
		value.schemaVersion !== 1 ||
		!isSafeIdentifier(value.queueEntryId)
	) {
		return fail("scheduler_handoff_invalid");
	}
	const transfer = parseSchedulerOwnershipTransfer(value.transfer);
	if (!transfer.ok) return transfer;
	return Result.ok({ schemaVersion: 1, queueEntryId: value.queueEntryId, transfer: transfer.value });
}

function serializeAcceptance(value: SchedulerHandoffAcceptance): SchedulerHandoffAcceptance {
	const acceptance: SchedulerHandoffAcceptance = {
		schemaVersion: 1,
		transferId: value.transferId,
		queueEntryId: value.queueEntryId,
		sourceFencingToken: value.sourceFencingToken,
		targetOwnerId: value.targetOwnerId,
		targetClaimId: value.targetClaimId,
		targetFencingToken: value.targetFencingToken,
		state: value.state,
		startedAt: value.startedAt,
		revision: value.revision,
	};
	if (value.sourceAttemptId !== undefined) {
		(acceptance as { sourceAttemptId?: string }).sourceAttemptId = value.sourceAttemptId;
	}
	if (value.ttlMs !== undefined) (acceptance as { ttlMs?: number }).ttlMs = value.ttlMs;
	return acceptance;
}

function parseAcceptance(value: unknown): ResultValue<SchedulerHandoffAcceptance, FoundationError> {
	if (
		!isRecord(value) ||
		Object.keys(value).some((key) => !ACCEPTANCE_KEYS.has(key)) ||
		value.schemaVersion !== 1 ||
		!isSafeIdentifier(value.transferId) ||
		!isSafeIdentifier(value.queueEntryId) ||
		!isSafeIdentifier(value.sourceFencingToken) ||
		!isSafeIdentifier(value.targetOwnerId) ||
		!isSafeIdentifier(value.targetClaimId) ||
		!isSafeIdentifier(value.targetFencingToken) ||
		(value.state !== "accepting" && value.state !== "source_cancelled" && value.state !== "claim_transferred") ||
		!isCanonicalTimestamp(value.startedAt) ||
		typeof value.revision !== "number" ||
		!Number.isInteger(value.revision) ||
		value.revision < 0
	) {
		return fail("scheduler_handoff_invalid");
	}
	if (value.sourceAttemptId !== undefined && !isSafeIdentifier(value.sourceAttemptId)) {
		return fail("scheduler_handoff_invalid");
	}
	if (
		value.ttlMs !== undefined &&
		(typeof value.ttlMs !== "number" ||
			!Number.isInteger(value.ttlMs) ||
			value.ttlMs < SCHEDULER_CLAIM_MIN_LEASE_TTL_MS ||
			value.ttlMs > SCHEDULER_CLAIM_MAX_LEASE_TTL_MS)
	) {
		return fail("scheduler_handoff_invalid");
	}
	const expectedRevision = value.state === "accepting" ? 0 : value.state === "source_cancelled" ? 1 : 2;
	if (value.revision !== expectedRevision) return fail("scheduler_handoff_invalid");
	return Result.ok(serializeAcceptance(value as unknown as SchedulerHandoffAcceptance));
}

function sameAcceptanceIdentity(left: SchedulerHandoffAcceptance, right: SchedulerHandoffAcceptance): boolean {
	return (
		left.transferId === right.transferId &&
		left.queueEntryId === right.queueEntryId &&
		left.sourceFencingToken === right.sourceFencingToken &&
		left.sourceAttemptId === right.sourceAttemptId &&
		left.targetOwnerId === right.targetOwnerId &&
		left.targetClaimId === right.targetClaimId &&
		left.targetFencingToken === right.targetFencingToken &&
		left.ttlMs === right.ttlMs &&
		left.startedAt === right.startedAt
	);
}

function acceptanceMatchesRequest(
	acceptance: SchedulerHandoffAcceptance,
	request: SchedulerHandoffAcceptRequest,
): boolean {
	return (
		(request.targetClaimId === undefined || request.targetClaimId === acceptance.targetClaimId) &&
		(request.targetFencingToken === undefined ||
			request.targetFencingToken === acceptance.targetFencingToken) &&
		(request.ttlMs === undefined || request.ttlMs === acceptance.ttlMs)
	);
}

function handoffEventPayload(transfer: SchedulerOwnershipTransfer): SchedulerHandoffEventPayload {
	const payload: {
		schemaVersion: 1;
		transferId: string;
		taskId: string;
		fromOwnerId: string;
		toOwnerId: string;
		state: string;
		revision: number;
		reasonSummary?: string;
	} = {
		schemaVersion: 1,
		transferId: transfer.transferId,
		taskId: transfer.taskId,
		fromOwnerId: transfer.fromOwnerId,
		toOwnerId: transfer.toOwnerId,
		state: transfer.state,
		revision: transfer.revision,
	};
	if (transfer.reasonSummary !== undefined) payload.reasonSummary = transfer.reasonSummary;
	return payload;
}

export class SchedulerHandoffController {
	private readonly ledger: DurableLedgerApi;
	private readonly queue: SchedulerQueueStore;
	private readonly sessionId: string;
	private readonly ownerId: string;
	private readonly lane: string;
	private readonly clock: RuntimeClock;
	private readonly nowFn: () => string;
	private readonly writerLeaseTtlMs: number;
	private readonly cancelSourceDispatch: SchedulerCancelSourceDispatch | undefined;
	private readonly targetAvailable: SchedulerHandoffTargetAvailable | undefined;
	private writerLease: LedgerWriterLease | undefined;
	private transfers = new Map<string, SchedulerHandoffRecordV1>();
	private acceptances = new Map<string, SchedulerHandoffAcceptance>();
	private objectRevisions = new Map<string, number>();
	private mutationTail: Promise<void> = Promise.resolve();

	constructor(options: SchedulerHandoffControllerOptions) {
		this.clock = runtimeClockFor(options);
		this.ledger = options.ledger;
		this.queue = options.queue;
		this.sessionId = options.sessionId;
		this.ownerId = options.ownerId;
		this.lane = options.lane ?? "main";
		this.nowFn = options.now ?? (() => new Date(this.clock.wallNow()).toISOString());
		this.writerLeaseTtlMs = options.writerLeaseTtlMs ?? 15 * 60 * 1000;
		this.cancelSourceDispatch = options.cancelSourceDispatch;
		this.targetAvailable = options.targetAvailable;
	}

	async reload(): Promise<ResultValue<SchedulerHandoffSnapshot, FoundationError>> {
		try {
			const records = await this.ledger.findFoundationRecords({ order: "oldestFirst", includePruned: true });
			return this.replay(records);
		} catch (error) {
			return Result.err(mapLedgerError(error));
		}
	}

	async offer(
		request: SchedulerHandoffOfferRequest,
	): Promise<ResultValue<SchedulerHandoffResult, FoundationError>> {
		return this.withDurableMutation(() => this.offerUnlocked(request));
	}

	private async offerUnlocked(
		request: SchedulerHandoffOfferRequest,
	): Promise<ResultValue<SchedulerHandoffResult, FoundationError>> {
		const loaded = await this.reload();
		if (!loaded.ok) return loaded;
		if (!isSafeIdentifier(request.queueEntryId)) return fail("scheduler_handoff_invalid");
		const parsed = parseSchedulerOwnershipTransfer(request.transfer);
		if (!parsed.ok) return parsed;
		const transfer = parsed.value;
		if (transfer.state !== "offered" || transfer.revision !== 0) return fail("scheduler_handoff_invalid");
		const existing = this.transfers.get(transfer.transferId);
		if (existing !== undefined) {
			return JSON.stringify(existing) === JSON.stringify({ schemaVersion: 1, queueEntryId: request.queueEntryId, transfer })
				? Result.ok({ transfer: existing.transfer })
				: fail("scheduler_handoff_invalid");
		}
		const nowIso = this.nowIso();
		if (
			Date.parse(transfer.deadlineAt) <= Date.parse(transfer.createdAt) ||
			Date.parse(nowIso) < Date.parse(transfer.createdAt)
		) {
			return fail("scheduler_handoff_invalid");
		}
		if (Date.parse(nowIso) >= Date.parse(transfer.deadlineAt)) return fail("scheduler_handoff_timeout");
		const entry = await this.queue.getEntry(request.queueEntryId);
		if (!entry.ok) return entry;
		if (
			entry.value.sessionId !== this.sessionId ||
			entry.value.taskId !== transfer.taskId ||
			(entry.value.state !== "claimed" && entry.value.state !== "dispatched") ||
			entry.value.claimId === undefined
		) {
			return fail("scheduler_handoff_invalid");
		}
		const claim = await this.queue.getClaim(entry.value.claimId);
		if (!claim.ok) return claim;
		if (claim.value.ownerId !== transfer.fromOwnerId || claim.value.fencingToken !== transfer.fencingToken) {
			return fail("scheduler_lease_lost");
		}
		const record: SchedulerHandoffRecordV1 = {
			schemaVersion: 1,
			queueEntryId: request.queueEntryId,
			transfer,
		};
		const written = await this.writeHandoffRecord(record);
		if (!written.ok) return written;
		this.transfers.set(transfer.transferId, record);
		return Result.ok({ transfer });
	}

	async accept(
		request: SchedulerHandoffAcceptRequest,
	): Promise<ResultValue<SchedulerHandoffResult, FoundationError>> {
		return this.withDurableMutation(() => this.acceptUnlocked(request));
	}

	private async acceptUnlocked(
		request: SchedulerHandoffAcceptRequest,
	): Promise<ResultValue<SchedulerHandoffResult, FoundationError>> {
		const loaded = await this.reload();
		if (!loaded.ok) return loaded;
		const record = this.transfers.get(request.transferId);
		if (record === undefined) return fail("scheduler_not_found");
		let acceptance = this.acceptances.get(request.transferId);
		if (record.transfer.state === "accepted") {
			if (
				acceptance === undefined ||
				acceptance.state !== "claim_transferred" ||
				!acceptanceMatchesRequest(acceptance, request)
			) {
				return fail("scheduler_handoff_invalid");
			}
			return this.resumeAcceptance(record, acceptance);
		}
		if (record.transfer.state !== "offered") return fail("scheduler_handoff_invalid");
		if (acceptance !== undefined) {
			if (!acceptanceMatchesRequest(acceptance, request)) {
				return fail("scheduler_handoff_invalid");
			}
			return this.resumeAcceptance(record, acceptance);
		}
		const nowIso = this.nowIso();
		if (Date.parse(nowIso) >= Date.parse(record.transfer.deadlineAt)) return fail("scheduler_handoff_timeout");
		if (this.targetAvailable !== undefined) {
			let available = false;
			try {
				available = await this.targetAvailable(record.transfer.toOwnerId);
			} catch {
				return fail("scheduler_handoff_target_unavailable");
			}
			if (!available) return fail("scheduler_handoff_target_unavailable");
		}
		const snapshot = await this.queue.snapshot();
		if (!snapshot.ok) return snapshot;
		const entry = snapshot.value.entries.find((candidate) => candidate.queueEntryId === record.queueEntryId);
		if (
			entry === undefined ||
			entry.taskId !== record.transfer.taskId ||
			(entry.state !== "claimed" && entry.state !== "dispatched") ||
			entry.claimId === undefined
		) {
			return fail("scheduler_handoff_invalid");
		}
		const sourceClaim = snapshot.value.claims.find((claim) => claim.claimId === entry.claimId);
		if (
			sourceClaim === undefined ||
			sourceClaim.ownerId !== record.transfer.fromOwnerId ||
			sourceClaim.fencingToken !== record.transfer.fencingToken
		) {
			return fail("scheduler_lease_lost");
		}
		let sourceAttemptId: string | undefined;
		if (entry.state === "dispatched") {
			const live = snapshot.value.dispatches.filter(
				(dispatch) =>
					dispatch.queueEntryId === entry.queueEntryId &&
					dispatch.claimId === sourceClaim.claimId &&
					!isSchedulerDispatchTerminal(dispatch.status),
			);
			if (live.length !== 1 || live[0]?.attemptId === undefined) {
				return fail("scheduler_attempt_recovery_failed");
			}
			sourceAttemptId = live[0].attemptId;
		}
		acceptance = {
			schemaVersion: 1,
			transferId: record.transfer.transferId,
			queueEntryId: record.queueEntryId,
			sourceFencingToken: record.transfer.fencingToken,
			...(sourceAttemptId === undefined ? {} : { sourceAttemptId }),
			targetOwnerId: record.transfer.toOwnerId,
			targetClaimId: request.targetClaimId ?? `claim_${randomUUID().replaceAll("-", "")}`,
			targetFencingToken: request.targetFencingToken ?? `fence_${randomUUID().replaceAll("-", "")}`,
			...(request.ttlMs === undefined ? {} : { ttlMs: request.ttlMs }),
			state: "accepting",
			startedAt: nowIso,
			revision: 0,
		};
		const parsedAcceptance = parseAcceptance(acceptance);
		if (!parsedAcceptance.ok) return parsedAcceptance;
		const written = await this.writeAcceptance(parsedAcceptance.value);
		if (!written.ok) return written;
		this.acceptances.set(parsedAcceptance.value.transferId, parsedAcceptance.value);
		return this.resumeAcceptance(record, parsedAcceptance.value);
	}

	async decide(
		transferId: string,
		decision: SchedulerHandoffDecision,
	): Promise<ResultValue<SchedulerHandoffResult, FoundationError>> {
		return this.withDurableMutation(async () => {
			const loaded = await this.reload();
			if (!loaded.ok) return loaded;
			return this.decideUnlocked(transferId, decision, this.nowIso());
		});
	}

	async recover(): Promise<ResultValue<readonly SchedulerHandoffResult[], FoundationError>> {
		return this.withDurableMutation(async () => {
			const loaded = await this.reload();
			if (!loaded.ok) return loaded;
			const outcomes: SchedulerHandoffResult[] = [];
			for (const record of [...this.transfers.values()]) {
				if (record.transfer.state !== "offered") continue;
				const acceptance = this.acceptances.get(record.transfer.transferId);
				if (acceptance !== undefined) {
					const resumed = await this.resumeAcceptance(record, acceptance);
					if (!resumed.ok) return resumed;
					outcomes.push(resumed.value);
					continue;
				}
				if (Date.parse(this.nowIso()) < Date.parse(record.transfer.deadlineAt)) continue;
				const timedOut = await this.decideUnlocked(record.transfer.transferId, "timed_out", this.nowIso());
				if (!timedOut.ok) return timedOut;
				outcomes.push(timedOut.value);
			}
			return Result.ok(outcomes);
		});
	}

	async snapshot(): Promise<ResultValue<SchedulerHandoffSnapshot, FoundationError>> {
		return this.reload();
	}

	private async resumeAcceptance(
		record: SchedulerHandoffRecordV1,
		initial: SchedulerHandoffAcceptance,
	): Promise<ResultValue<SchedulerHandoffResult, FoundationError>> {
		let acceptance = initial;
		if (acceptance.state === "accepting") {
			if (acceptance.sourceAttemptId !== undefined) {
				if (this.cancelSourceDispatch === undefined) return fail("scheduler_attempt_recovery_failed");
				let cancelled: ResultValue<void, FoundationError>;
				try {
					cancelled = await this.cancelSourceDispatch(
						acceptance.queueEntryId,
						acceptance.sourceFencingToken,
					);
				} catch {
					return fail("scheduler_attempt_recovery_failed");
				}
				if (!cancelled.ok) return fail("scheduler_attempt_recovery_failed");
			}
			const sourceCancelled: SchedulerHandoffAcceptance = {
				...serializeAcceptance(acceptance),
				state: "source_cancelled",
				revision: acceptance.revision + 1,
			};
			const written = await this.writeAcceptance(sourceCancelled);
			if (!written.ok) return written;
			acceptance = sourceCancelled;
			this.acceptances.set(acceptance.transferId, acceptance);
		}

		const claimTransfer = await this.queue.transferClaim({
			transferId: acceptance.transferId,
			queueEntryId: acceptance.queueEntryId,
			sourceFencingToken: acceptance.sourceFencingToken,
			targetOwnerId: acceptance.targetOwnerId,
			targetClaimId: acceptance.targetClaimId,
			targetFencingToken: acceptance.targetFencingToken,
			...(acceptance.sourceAttemptId === undefined ? {} : { cancelledAttemptId: acceptance.sourceAttemptId }),
			...(acceptance.ttlMs === undefined ? {} : { ttlMs: acceptance.ttlMs }),
		});
		if (!claimTransfer.ok) return claimTransfer;
		if (acceptance.state === "source_cancelled") {
			const claimTransferred: SchedulerHandoffAcceptance = {
				...serializeAcceptance(acceptance),
				state: "claim_transferred",
				revision: acceptance.revision + 1,
			};
			const written = await this.writeAcceptance(claimTransferred);
			if (!written.ok) return written;
			acceptance = claimTransferred;
			this.acceptances.set(acceptance.transferId, acceptance);
		}

		const latest = this.transfers.get(record.transfer.transferId);
		if (latest === undefined) return fail("scheduler_not_found");
		if (latest.transfer.state === "accepted") {
			return Result.ok({ transfer: latest.transfer, claimTransfer: claimTransfer.value });
		}
		const acceptedCandidate: SchedulerOwnershipTransfer = {
			...serializeSchedulerOwnershipTransfer(latest.transfer),
			state: "accepted",
			decidedAt: acceptance.startedAt,
			revision: latest.transfer.revision + 1,
		};
		const accepted = applySchedulerHandoffTransition(latest.transfer, acceptedCandidate, acceptance.startedAt);
		if (!accepted.ok) return accepted;
		const acceptedRecord: SchedulerHandoffRecordV1 = {
			schemaVersion: 1,
			queueEntryId: latest.queueEntryId,
			transfer: accepted.value,
		};
		const writtenAccepted = await this.writeHandoffRecord(acceptedRecord);
		if (!writtenAccepted.ok) return writtenAccepted;
		this.transfers.set(accepted.value.transferId, acceptedRecord);
		return Result.ok({ transfer: accepted.value, claimTransfer: claimTransfer.value });
	}

	private async decideUnlocked(
		transferId: string,
		decision: SchedulerHandoffDecision | "timed_out",
		decidedAt: string,
	): Promise<ResultValue<SchedulerHandoffResult, FoundationError>> {
		const record = this.transfers.get(transferId);
		if (record === undefined) return fail("scheduler_not_found");
		if (record.transfer.state === decision) return Result.ok({ transfer: record.transfer });
		if (record.transfer.state !== "offered" || this.acceptances.has(transferId)) {
			return fail("scheduler_handoff_invalid");
		}
		const candidate: SchedulerOwnershipTransfer = {
			...serializeSchedulerOwnershipTransfer(record.transfer),
			state: decision,
			decidedAt,
			revision: record.transfer.revision + 1,
		};
		const applied = applySchedulerHandoffTransition(record.transfer, candidate, decidedAt);
		if (!applied.ok) return applied;
		const next: SchedulerHandoffRecordV1 = {
			schemaVersion: 1,
			queueEntryId: record.queueEntryId,
			transfer: applied.value,
		};
		const written = await this.writeHandoffRecord(next);
		if (!written.ok) return written;
		this.transfers.set(transferId, next);
		return Result.ok({ transfer: applied.value });
	}

	private replay(records: readonly FoundationRecord[]): ResultValue<SchedulerHandoffSnapshot, FoundationError> {
		this.transfers = new Map();
		this.acceptances = new Map();
		this.objectRevisions = new Map();
		for (const record of records) {
			const fact = asFact(record);
			if (fact === undefined) continue;
			this.objectRevisions.set(this.objectKey(fact.objectType, fact.objectId), fact.revision);
			if (fact.objectType === SCHEDULER_HANDOFF_OBJECT_TYPE) {
				const parsed = parseHandoffRecord(fact.payload);
				if (!parsed.ok) return parsed;
				const previous = this.transfers.get(parsed.value.transfer.transferId);
				if (previous === undefined) {
					if (parsed.value.transfer.state !== "offered" || parsed.value.transfer.revision !== 0) {
						return fail("scheduler_handoff_invalid");
					}
					this.transfers.set(parsed.value.transfer.transferId, parsed.value);
					continue;
				}
				if (previous.queueEntryId !== parsed.value.queueEntryId) return fail("scheduler_handoff_invalid");
				const applied = applySchedulerHandoffTransition(
					previous.transfer,
					parsed.value.transfer,
					parsed.value.transfer.decidedAt ?? parsed.value.transfer.createdAt,
				);
				if (!applied.ok) return applied;
				this.transfers.set(parsed.value.transfer.transferId, parsed.value);
				continue;
			}
			if (fact.objectType === SCHEDULER_HANDOFF_ACCEPTANCE_OBJECT_TYPE) {
				const parsed = parseAcceptance(fact.payload);
				if (!parsed.ok) return parsed;
				const previous = this.acceptances.get(parsed.value.transferId);
				if (previous === undefined) {
					if (parsed.value.state !== "accepting" || parsed.value.revision !== 0) {
						return fail("scheduler_handoff_invalid");
					}
					this.acceptances.set(parsed.value.transferId, parsed.value);
					continue;
				}
				const expectedState = previous.state === "accepting" ? "source_cancelled" : "claim_transferred";
				if (
					previous.state === "claim_transferred" ||
					parsed.value.state !== expectedState ||
					parsed.value.revision !== previous.revision + 1 ||
					!sameAcceptanceIdentity(previous, parsed.value)
				) {
					return fail("scheduler_handoff_invalid");
				}
				this.acceptances.set(parsed.value.transferId, parsed.value);
			}
		}
		for (const acceptance of this.acceptances.values()) {
			const record = this.transfers.get(acceptance.transferId);
			if (
				record === undefined ||
				record.queueEntryId !== acceptance.queueEntryId ||
				record.transfer.fencingToken !== acceptance.sourceFencingToken ||
				record.transfer.toOwnerId !== acceptance.targetOwnerId ||
				Date.parse(acceptance.startedAt) < Date.parse(record.transfer.createdAt) ||
				Date.parse(acceptance.startedAt) >= Date.parse(record.transfer.deadlineAt) ||
				(record.transfer.state !== "offered" &&
					(record.transfer.state !== "accepted" || acceptance.state !== "claim_transferred"))
			) {
				return fail("scheduler_handoff_invalid");
			}
		}
		for (const record of this.transfers.values()) {
			if (
				record.transfer.state === "accepted" &&
				this.acceptances.get(record.transfer.transferId)?.state !== "claim_transferred"
			) {
				return fail("scheduler_handoff_invalid");
			}
		}
		return Result.ok({
			transfers: [...this.transfers.values()].map((record) =>
				serializeSchedulerOwnershipTransfer(record.transfer),
			),
			acceptances: [...this.acceptances.values()].map(serializeAcceptance),
		});
	}

	private async writeHandoffRecord(record: SchedulerHandoffRecordV1): Promise<ResultValue<void, FoundationError>> {
		const transfer = record.transfer;
		const expectedRevision = this.objectRevisions.get(this.objectKey(SCHEDULER_HANDOFF_OBJECT_TYPE, transfer.transferId)) ?? 0;
		const written = await this.appendFact(
			SCHEDULER_HANDOFF_OBJECT_TYPE,
			transfer.transferId,
			serializeHandoffRecord(record),
			`scheduler.handoff:${transfer.transferId}:${transfer.revision}`,
			expectedRevision,
			{ sessionId: this.sessionId, taskId: transfer.taskId },
		);
		if (!written.ok) return written;
		const eventWritten = await this.writeHandoffEvent(transfer);
		if (!eventWritten.ok) return eventWritten;
		this.objectRevisions.set(
			this.objectKey(SCHEDULER_HANDOFF_OBJECT_TYPE, transfer.transferId),
			expectedRevision + (written.value.replayed ? 0 : 1),
		);
		return Result.ok(undefined);
	}

	private async writeAcceptance(
		acceptance: SchedulerHandoffAcceptance,
	): Promise<ResultValue<void, FoundationError>> {
		const expectedRevision =
			this.objectRevisions.get(this.objectKey(SCHEDULER_HANDOFF_ACCEPTANCE_OBJECT_TYPE, acceptance.transferId)) ?? 0;
		const written = await this.appendFact(
			SCHEDULER_HANDOFF_ACCEPTANCE_OBJECT_TYPE,
			acceptance.transferId,
			serializeAcceptance(acceptance),
			`scheduler.handoff_acceptance:${acceptance.transferId}:${acceptance.revision}`,
			expectedRevision,
			{ sessionId: this.sessionId, taskId: this.transfers.get(acceptance.transferId)?.transfer.taskId },
		);
		if (!written.ok) return written;
		this.objectRevisions.set(
			this.objectKey(SCHEDULER_HANDOFF_ACCEPTANCE_OBJECT_TYPE, acceptance.transferId),
			expectedRevision + (written.value.replayed ? 0 : 1),
		);
		return Result.ok(undefined);
	}

	private async writeHandoffEvent(
		transfer: SchedulerOwnershipTransfer,
	): Promise<ResultValue<void, FoundationError>> {
		let sequence = 1;
		try {
			sequence = (await this.ledger.getLedgerRevision()) + 1;
			createDurableEvent({
				category: "scheduler.handoff_transitioned",
				eventId: `evt_handoff_${transfer.transferId}_${transfer.revision}`,
				streamId: this.sessionId,
				sequence,
				timestamp: this.nowIso(),
				correlation: { sessionId: this.sessionId, taskId: transfer.taskId },
				payload: handoffEventPayload(transfer),
			});
		} catch (error) {
			return Result.err(mapLedgerError(error));
		}
		const eventId = `evt_handoff_${transfer.transferId}_${transfer.revision}`;
		const expectedRevision = this.objectRevisions.get(this.objectKey("scheduler.handoff_transitioned", eventId)) ?? 0;
		const written = await this.appendFact(
			"scheduler.handoff_transitioned",
			eventId,
			handoffEventPayload(transfer),
			`scheduler.handoff_transitioned:${transfer.transferId}:${transfer.revision}`,
			expectedRevision,
			{ sessionId: this.sessionId, taskId: transfer.taskId },
		);
		if (!written.ok) return written;
		this.objectRevisions.set(
			this.objectKey("scheduler.handoff_transitioned", eventId),
			expectedRevision + (written.value.replayed ? 0 : 1),
		);
		return Result.ok(undefined);
	}

	private async appendFact(
		objectType: string,
		objectId: string,
		payload: FoundationJsonValue | object,
		clientRequestId: string,
		expectedRevision: number,
		correlation: EventCorrelationRef,
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
				payload: payload as FoundationJsonValue,
				correlation: {
					sessionId: this.sessionId,
					laneId: this.lane,
					...(correlation.taskId === undefined ? {} : { taskId: correlation.taskId }),
				},
				fencingToken: lease.fencingToken,
			});
			if (result.record.kind !== "fact") return fail("scheduler_persistence_failed");
			return Result.ok({ replayed: result.replayed });
		} catch (error) {
			const code = ledgerCode(error);
			if (code === "session_writer_stale_revision") return fail("scheduler_persistence_failed");
			return Result.err(mapLedgerError(error));
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

	private objectKey(objectType: string, objectId: string): string {
		return `${objectType}\0${objectId}`;
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
}
