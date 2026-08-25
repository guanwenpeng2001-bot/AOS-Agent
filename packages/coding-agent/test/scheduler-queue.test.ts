import {
	type AppendFoundationRecordResult,
	createDurableEvent,
	type DurableLedgerApi,
	DurableLedgerError,
	EVENT_CATALOG,
	type EventProducer,
	FOUNDATION_ERROR_CODES,
	FoundationError,
	type FoundationObjectResult,
	type FoundationRecordQuery,
	type FoundationRecord,
	type FoundationRetentionPolicy,
	InMemorySessionStorage,
	type LedgerWriterLease,
	type ProvisionedFoundationRecord,
	Result,
	Session,
	type SetRetentionPolicyOptions,
	validateDurableEvent,
} from "@aos-agent/agent-core";
import { describe, expect, it } from "vitest";
import {
	applySchedulerClaimAcquire,
	applySchedulerClaimRenew,
	applySchedulerDispatchTransition,
	applySchedulerEngineTransition,
	applySchedulerHandoffTransition,
	applySchedulerMessageAck,
	applySchedulerQueueTransition,
	applySchedulerWakeFire,
	assertSchedulerFencingToken,
	enqueueSchedulerQueueEntry,
	isLegalSchedulerQueueTransition,
	isSchedulerClaim,
	isSchedulerQueueTerminal,
	isSchedulerSideEffectRetryable,
	parseSchedulerDeadlockFact,
	parseSchedulerDispatchRecord,
	parseSchedulerJoinPlan,
	parseSchedulerJoinSnapshot,
	parseSchedulerMessage,
	parseSchedulerOwnershipTransfer,
	parseSchedulerQueueEntry,
	parseSchedulerSelectionFact,
	parseSchedulerWake,
	SCHEDULER_CLAIM_MAX_LEASE_TTL_MS,
	SCHEDULER_CLAIM_MIN_LEASE_TTL_MS,
	SCHEDULER_DEFAULT_MAX_ATTEMPTS,
	SCHEDULER_DISPATCH_TRANSITIONS,
	SCHEDULER_DURABLE_EVENT_CATEGORIES,
	SCHEDULER_ENGINE_PHASES,
	SCHEDULER_ERROR_CODES,
	SCHEDULER_FORBIDDEN_PAYLOAD_KEYS,
	SCHEDULER_HANDOFF_TRANSITIONS,
	SCHEDULER_QUEUE_STATES,
	SCHEDULER_QUEUE_TRANSITIONS,
	type SchedulerClaimV1,
	type SchedulerDispatchRecordV1,
	type SchedulerMessageV1,
	type SchedulerOwnershipTransferV1,
	type SchedulerQueueEntryV1,
	type SchedulerWakeV1,
	schedulerErrorRetryable,
	schedulerFencingTokensEqual,
	schedulerQueueBusinessKey,
	serializeSchedulerClaim,
	serializeSchedulerQueueEntry,
} from "../src/core/scheduler.ts";
import {
	isSchedulerQueueLedgerObjectType,
	SCHEDULER_ATTEMPT_POLICY_OBJECT_TYPE,
	SCHEDULER_CLAIM_OBJECT_TYPE,
	SCHEDULER_CLAIM_TRANSFER_OBJECT_TYPE,
	SCHEDULER_DISPATCH_OBJECT_TYPE,
	SCHEDULER_QUEUE_ENTRY_OBJECT_TYPE,
	SCHEDULER_QUEUE_KEY_OBJECT_TYPE,
	SCHEDULER_QUEUE_LEDGER_OBJECT_TYPES,
	type SchedulerCancelAttemptV1,
	SchedulerQueueStore,
} from "../src/core/scheduler-queue.ts";

const NOW = "2026-08-21T12:00:00.000Z";
const LATER = "2026-08-21T12:00:30.000Z";
const EXPIRES = "2026-08-21T12:05:00.000Z";
const DIGEST = "ab".repeat(32);

function queued(overrides: Partial<SchedulerQueueEntryV1> = {}): SchedulerQueueEntryV1 {
	return {
		schemaVersion: 1,
		queueEntryId: "queue_1",
		sessionId: "session_a",
		taskId: "task_1",
		nodeRef: { taskId: "task_1", graphRevision: 1, nodeId: "node_ready" },
		state: "queued",
		priority: 10,
		attemptsUsed: 0,
		enqueuedAt: NOW,
		revision: 0,
		...overrides,
	};
}

function claim(overrides: Partial<SchedulerClaimV1> = {}): SchedulerClaimV1 {
	return {
		schemaVersion: 1,
		claimId: "claim_1",
		queueEntryId: "queue_1",
		taskId: "task_1",
		ownerId: "scheduler_host_1",
		fencingToken: "fence_abc",
		acquiredAt: NOW,
		expiresAt: EXPIRES,
		revision: 0,
		...overrides,
	};
}

function dispatch(overrides: Partial<SchedulerDispatchRecordV1> = {}): SchedulerDispatchRecordV1 {
	return {
		schemaVersion: 1,
		queueEntryId: "queue_1",
		claimId: "claim_1",
		dispatchId: "dispatch_1",
		providerId: "aos.builtin.in-process",
		providerClass: "task_executor",
		status: "prepared",
		revision: 0,
		...overrides,
	};
}

function transfer(overrides: Partial<SchedulerOwnershipTransferV1> = {}): SchedulerOwnershipTransferV1 {
	return {
		schemaVersion: 1,
		transferId: "transfer_1",
		taskId: "task_1",
		fromOwnerId: "owner_a",
		toOwnerId: "owner_b",
		state: "offered",
		fencingToken: "fence_handoff",
		deadlineAt: EXPIRES,
		createdAt: NOW,
		revision: 0,
		...overrides,
	};
}

function message(overrides: Partial<SchedulerMessageV1> = {}): SchedulerMessageV1 {
	return {
		schemaVersion: 1,
		messageId: "msg_1",
		type: "result.ready",
		threadId: "thread_1",
		fromSessionId: "session_a",
		toSessionId: "session_b",
		correlation: { taskId: "task_1" },
		ack: "required",
		expiresAt: EXPIRES,
		payloadDigest: { algorithm: "sha256", value: DIGEST },
		createdAt: NOW,
		revision: 0,
		...overrides,
	};
}

function wake(overrides: Partial<SchedulerWakeV1> = {}): SchedulerWakeV1 {
	return {
		schemaVersion: 1,
		wakeId: "wake_1",
		workflowId: "workflow_1",
		dueAt: NOW,
		revision: 0,
		...overrides,
	};
}

function expectCode(result: { ok: false; error: { code: string } } | { ok: true }, code: string): void {
	expect(result.ok).toBe(false);
	if (!result.ok) expect(result.error.code).toBe(code);
}

describe("scheduler T1 type freeze", () => {
	it("freezes the complete scheduler_* error family onto the Foundation catalog", () => {
		expect(SCHEDULER_ERROR_CODES).toHaveLength(22);
		expect(new Set(SCHEDULER_ERROR_CODES).size).toBe(22);
		for (const code of SCHEDULER_ERROR_CODES) {
			expect(FOUNDATION_ERROR_CODES).toContain(code);
		}
		expect(schedulerErrorRetryable("scheduler_claim_conflict")).toBe(true);
		expect(schedulerErrorRetryable("scheduler_budget_exhausted_wait")).toBe(true);
		expect(schedulerErrorRetryable("scheduler_backpressure")).toBe(true);
		expect(schedulerErrorRetryable("scheduler_persistence_failed")).toBe(false);
		expect(SCHEDULER_DEFAULT_MAX_ATTEMPTS).toBe(3);
		expect(SCHEDULER_CLAIM_MIN_LEASE_TTL_MS).toBeLessThan(SCHEDULER_CLAIM_MAX_LEASE_TTL_MS);
	});

	it("maps scheduler.* durable events to existing harness producer and does not reuse Inbox queue categories", () => {
		const producers: readonly EventProducer[] = [
			"harness",
			"reducer",
			"model",
			"tool",
			"queue",
			"role",
			"goal",
			"workflow",
			"ask",
			"artifact",
			"migration",
		];
		expect(producers).not.toContain("scheduler");
		expect(EVENT_CATALOG["queue.enqueued"]).toMatchObject({ class: "durable", category: "queue.enqueued" });
		expect(EVENT_CATALOG["queue.cancelled"].category).toBe("queue.cancelled");
		expect(SCHEDULER_DURABLE_EVENT_CATEGORIES).not.toContain("queue.enqueued");
		expect(SCHEDULER_DURABLE_EVENT_CATEGORIES).not.toContain("queue.cancelled");
		for (const category of SCHEDULER_DURABLE_EVENT_CATEGORIES) {
			expect(EVENT_CATALOG[category]).toMatchObject({
				class: "durable",
				producer: "harness",
				replay: "must",
				retention: "ledger",
			});
			expect(EVENT_CATALOG[category].correlationFields).toEqual([
				"sessionId",
				"taskId",
				"dispatchId",
				"attemptId",
				"workflowId",
				"askId",
			]);
			expect(EVENT_CATALOG[category].correlationFields).not.toContain("queueEntryId");
			expect(EVENT_CATALOG[category].redacted).toEqual(expect.arrayContaining(["prompt", "payload", "content"]));
		}
	});

	it("accepts scheduler durable envelopes with catalog payload rules and rejects extra fields", () => {
		const event = createDurableEvent({
			category: "scheduler.queue_transitioned",
			eventId: "event_1",
			streamId: "session_a",
			sequence: 1,
			timestamp: NOW,
			correlation: { sessionId: "session_a", taskId: "task_1" },
			payload: {
				schemaVersion: 1,
				queueEntryId: "queue_1",
				sessionId: "session_a",
				taskId: "task_1",
				state: "queued",
				revision: 0,
			},
		});
		expect(event.payload).toMatchObject({ queueEntryId: "queue_1", state: "queued" });
		expect(
			validateDurableEvent({
				...event,
				payload: { ...event.payload, prompt: "hidden" },
			}).ok,
		).toBe(false);
		expect(event.category).toBe("scheduler.queue_transitioned");
		expect(event.category).not.toBe("queue.enqueued");
		expect(EVENT_CATALOG["scheduler.queue_transitioned"].category).not.toBe("queue.enqueued");
	});
});

describe("scheduler queue state machine", () => {
	it("accepts the legal happy-path transitions queued -> claimed -> dispatched -> settled", () => {
		const start = queued();
		expect(parseSchedulerQueueEntry(start).ok).toBe(true);
		const claimed = applySchedulerQueueTransition(start, {
			...start,
			state: "claimed",
			claimId: "claim_1",
			revision: 1,
		});
		expect(claimed.ok).toBe(true);
		if (!claimed.ok) return;
		const dispatched = applySchedulerQueueTransition(claimed.value, {
			...claimed.value,
			state: "dispatched",
			revision: 2,
		});
		expect(dispatched.ok).toBe(true);
		if (!dispatched.ok) return;
		const settled = applySchedulerQueueTransition(dispatched.value, {
			...dispatched.value,
			state: "settled",
			revision: 3,
		});
		expect(settled.ok).toBe(true);
		if (!settled.ok) return;
		expect(isSchedulerQueueTerminal(settled.value.state)).toBe(true);
	});

	it("accepts queued -> cancelled and claimed/dispatched -> expired -> queued|cancelled", () => {
		const cancelled = applySchedulerQueueTransition(queued(), { ...queued(), state: "cancelled", revision: 1 });
		expect(cancelled.ok).toBe(true);
		const claimed = applySchedulerQueueTransition(queued(), {
			...queued(),
			state: "claimed",
			claimId: "claim_1",
			revision: 1,
		});
		expect(claimed.ok).toBe(true);
		if (!claimed.ok) return;
		const expired = applySchedulerQueueTransition(claimed.value, {
			...claimed.value,
			state: "expired",
			revision: 2,
		});
		expect(expired.ok).toBe(true);
		if (!expired.ok) return;
		const requeued = applySchedulerQueueTransition(expired.value, {
			...expired.value,
			state: "queued",
			claimId: undefined,
			attemptsUsed: 1,
			revision: 3,
		});
		expect(requeued.ok).toBe(true);
		const failed = applySchedulerQueueTransition(expired.value, {
			...expired.value,
			state: "cancelled",
			revision: 3,
		});
		expect(failed.ok).toBe(true);
	});

	it("rejects illegal transitions, duplicate terminals, and revision gaps", () => {
		expect(isLegalSchedulerQueueTransition("queued", "dispatched")).toBe(false);
		expect(isLegalSchedulerQueueTransition("queued", "settled")).toBe(false);
		expect(isLegalSchedulerQueueTransition("claimed", "queued")).toBe(false);
		expect(isLegalSchedulerQueueTransition("settled", "queued")).toBe(false);
		expectCode(
			applySchedulerQueueTransition(queued(), { ...queued(), state: "dispatched", claimId: "claim_1", revision: 1 }),
			"scheduler_queue_invalid",
		);
		const settled = applySchedulerQueueTransition(
			{
				...queued(),
				state: "dispatched",
				claimId: "claim_1",
				revision: 2,
			},
			{
				...queued(),
				state: "settled",
				claimId: "claim_1",
				revision: 3,
			},
		);
		expect(settled.ok).toBe(true);
		if (!settled.ok) return;
		expectCode(
			applySchedulerQueueTransition(settled.value, {
				...settled.value,
				state: "queued",
				claimId: undefined,
				revision: 4,
			}),
			"scheduler_queue_invalid",
		);
		expectCode(
			applySchedulerQueueTransition(queued(), { ...queued(), state: "claimed", claimId: "claim_1", revision: 2 }),
			"scheduler_queue_invalid",
		);
		for (const state of SCHEDULER_QUEUE_STATES) {
			expect(Array.isArray(SCHEDULER_QUEUE_TRANSITIONS[state])).toBe(true);
		}
	});

	it("treats same-session duplicate enqueue as idempotent and payload mismatch as conflict", () => {
		const first = enqueueSchedulerQueueEntry(undefined, queued());
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		expect(first.value.idempotent).toBe(false);
		const replay = enqueueSchedulerQueueEntry(first.value.entry, queued());
		expect(replay.ok).toBe(true);
		if (!replay.ok) return;
		expect(replay.value.idempotent).toBe(true);
		expect(replay.value.entry.revision).toBe(0);
		expectCode(
			enqueueSchedulerQueueEntry(first.value.entry, queued({ goalId: "goal_other" })),
			"scheduler_queue_conflict",
		);
		expectCode(enqueueSchedulerQueueEntry(undefined, queued({ revision: 1 })), "scheduler_queue_invalid");
	});

	it("keeps cross-session and cross-task identities distinct", () => {
		const a = queued({ sessionId: "session_a", taskId: "task_1" });
		const b = queued({ sessionId: "session_b", taskId: "task_1", queueEntryId: "queue_2" });
		const c = queued({
			sessionId: "session_a",
			taskId: "task_2",
			queueEntryId: "queue_3",
			nodeRef: { taskId: "task_2", graphRevision: 1, nodeId: "node_ready" },
		});
		expect(schedulerQueueBusinessKey(a.sessionId, a.taskId, a.nodeRef)).not.toBe(
			schedulerQueueBusinessKey(b.sessionId, b.taskId, b.nodeRef),
		);
		expect(schedulerQueueBusinessKey(a.sessionId, a.taskId, a.nodeRef)).not.toBe(
			schedulerQueueBusinessKey(c.sessionId, c.taskId, c.nodeRef),
		);
		expectCode(enqueueSchedulerQueueEntry(a, b), "scheduler_queue_invalid");
	});
});

describe("scheduler claim fencing", () => {
	it("acquires a claim with its own fencing token and lease, not a writer-lease shape", () => {
		const acquired = applySchedulerClaimAcquire(queued(), claim(), NOW);
		expect(acquired.ok).toBe(true);
		if (!acquired.ok) return;
		expect(acquired.value.entry.state).toBe("claimed");
		expect(acquired.value.claim.fencingToken).toBe("fence_abc");
		expect(typeof acquired.value.claim.acquiredAt).toBe("string");
		expect(typeof acquired.value.claim.expiresAt).toBe("string");
		expect(isSchedulerClaim({ ...claim(), acquiredAt: Date.parse(NOW), expiresAt: Date.parse(EXPIRES) })).toBe(false);
		expect(schedulerFencingTokensEqual("fence_abc", "fence_abc")).toBe(true);
		expect(schedulerFencingTokensEqual("fence_abc", "fence_other")).toBe(false);
	});

	it("rejects concurrent claim, stale fencing, and expired lease", () => {
		const claimed = applySchedulerClaimAcquire(queued(), claim(), NOW);
		expect(claimed.ok).toBe(true);
		if (!claimed.ok) return;
		expectCode(
			applySchedulerClaimAcquire(claimed.value.entry, claim({ claimId: "claim_2" }), NOW),
			"scheduler_claim_conflict",
		);
		expectCode(assertSchedulerFencingToken(claimed.value.claim, "fence_stale", NOW), "scheduler_lease_lost");
		expectCode(
			assertSchedulerFencingToken(claimed.value.claim, "fence_abc", "2026-08-21T12:06:00.000Z"),
			"scheduler_claim_expired",
		);
		expectCode(
			applySchedulerClaimRenew(
				claimed.value.claim,
				{ ...claimed.value.claim, revision: 1, expiresAt: "2026-08-21T12:08:00.000Z" },
				"fence_stale",
				NOW,
			),
			"scheduler_lease_lost",
		);
		const renewed = applySchedulerClaimRenew(
			claimed.value.claim,
			{ ...claimed.value.claim, revision: 1, expiresAt: "2026-08-21T12:08:00.000Z" },
			"fence_abc",
			NOW,
		);
		expect(renewed.ok).toBe(true);
	});

	it("fails closed when acquire is given an unparsed queue entry", () => {
		expectCode(
			applySchedulerClaimAcquire(
				{ ...queued(), state: "claimed", claimId: "claim_1", prompt: "secret" } as SchedulerQueueEntryV1,
				claim(),
				NOW,
			),
			"scheduler_queue_invalid",
		);
	});

	it("renews an active claim older than MAX for a legal remaining interval", () => {
		const acquiredAt = "2026-08-21T11:45:00.000Z";
		const oldExpiresAt = "2026-08-21T12:02:00.000Z";
		const newExpiresAt = "2026-08-21T12:08:00.000Z";
		expect(Date.parse(NOW) - Date.parse(acquiredAt)).toBeGreaterThan(SCHEDULER_CLAIM_MAX_LEASE_TTL_MS);
		const oldClaim = claim({ acquiredAt, expiresAt: oldExpiresAt, revision: 3 });
		const renewed = applySchedulerClaimRenew(
			oldClaim,
			{ ...oldClaim, revision: 4, expiresAt: newExpiresAt },
			"fence_abc",
			NOW,
		);
		expect(renewed.ok).toBe(true);
		if (!renewed.ok) return;
		expect(renewed.value.acquiredAt).toBe(acquiredAt);
		expect(renewed.value.expiresAt).toBe(newExpiresAt);
		expect(Date.parse(renewed.value.expiresAt)).toBeGreaterThan(Date.parse(oldExpiresAt));
		const remainingMs = Date.parse(renewed.value.expiresAt) - Date.parse(NOW);
		expect(remainingMs).toBeGreaterThanOrEqual(SCHEDULER_CLAIM_MIN_LEASE_TTL_MS);
		expect(remainingMs).toBeLessThanOrEqual(SCHEDULER_CLAIM_MAX_LEASE_TTL_MS);
	});
});

describe("scheduler dispatch, handoff, message, wake, join, and engine", () => {
	it("advances dispatch prepared -> in_flight -> settled and rejects illegal or terminal replay", () => {
		const prepared = dispatch();
		expect(parseSchedulerDispatchRecord(prepared).ok).toBe(true);
		const inFlight = applySchedulerDispatchTransition(prepared, {
			...prepared,
			status: "in_flight",
			attemptId: "attempt_1",
			revision: 1,
		});
		expect(inFlight.ok).toBe(true);
		if (!inFlight.ok) return;
		const settled = applySchedulerDispatchTransition(inFlight.value, {
			...inFlight.value,
			status: "settled",
			revision: 2,
		});
		expect(settled.ok).toBe(true);
		if (!settled.ok) return;
		expectCode(
			applySchedulerDispatchTransition(settled.value, { ...settled.value, status: "prepared", revision: 3 }),
			"scheduler_dispatch_invalid",
		);
		expect(SCHEDULER_DISPATCH_TRANSITIONS.prepared).toEqual(["in_flight", "cancelled", "expired"]);
	});

	it("accepts handoff offered -> accepted|rejected|timed_out|cancelled and rejects non-offered answers", () => {
		const offered = transfer();
		expect(parseSchedulerOwnershipTransfer(offered).ok).toBe(true);
		const accepted = applySchedulerHandoffTransition(
			offered,
			{ ...offered, state: "accepted", decidedAt: LATER, revision: 1 },
			LATER,
		);
		expect(accepted.ok).toBe(true);
		if (!accepted.ok) return;
		expectCode(
			applySchedulerHandoffTransition(accepted.value, { ...accepted.value, state: "cancelled", revision: 2 }, LATER),
			"scheduler_handoff_invalid",
		);
		expect(
			applySchedulerHandoffTransition(
				offered,
				{ ...offered, state: "rejected", decidedAt: LATER, revision: 1 },
				LATER,
			).ok,
		).toBe(true);
		expect(
			applySchedulerHandoffTransition(
				offered,
				{ ...offered, state: "cancelled", decidedAt: LATER, revision: 1 },
				LATER,
			).ok,
		).toBe(true);
		const timedOut = applySchedulerHandoffTransition(
			offered,
			{ ...offered, state: "timed_out", decidedAt: "2026-08-21T12:06:00.000Z", revision: 1 },
			"2026-08-21T12:06:00.000Z",
		);
		expect(timedOut.ok).toBe(true);
		expect(SCHEDULER_HANDOFF_TRANSITIONS.offered).toEqual(["accepted", "rejected", "timed_out", "cancelled"]);
	});

	it("acks required messages and times out after expiresAt", () => {
		const posted = message();
		expect(parseSchedulerMessage(posted).ok).toBe(true);
		const acked = applySchedulerMessageAck(posted, LATER);
		expect(acked.ok).toBe(true);
		if (!acked.ok) return;
		expect(acked.value.ackedAt).toBe(LATER);
		expect(acked.value.revision).toBe(1);
		expectCode(applySchedulerMessageAck(posted, "2026-08-21T12:06:00.000Z"), "scheduler_message_timeout");
		expectCode(
			parseSchedulerMessage({ ...posted, fromSessionId: "session_a", toSessionId: "session_a" }),
			"scheduler_message_invalid",
		);
	});

	it("fires a due wake once and rejects early or duplicate fire", () => {
		const scheduled = wake();
		expect(parseSchedulerWake(scheduled).ok).toBe(true);
		const fired = applySchedulerWakeFire(scheduled, LATER);
		expect(fired.ok).toBe(true);
		if (!fired.ok) return;
		expectCode(applySchedulerWakeFire(fired.value, "2026-08-21T12:01:00.000Z"), "scheduler_wake_invalid");
		expectCode(applySchedulerWakeFire(scheduled, "2026-08-20T12:00:00.000Z"), "scheduler_wake_invalid");
	});

	it("validates join plans/snapshots and deadlock facts", () => {
		expect(
			parseSchedulerJoinPlan({
				schemaVersion: 1,
				joinId: "join_1",
				taskId: "task_join",
				policy: "require_all",
				predecessorTaskIds: ["task_a", "task_b"],
				createdAt: NOW,
			}).ok,
		).toBe(true);
		expectCode(
			parseSchedulerJoinPlan({
				schemaVersion: 1,
				joinId: "join_1",
				taskId: "task_join",
				policy: "unknown",
				predecessorTaskIds: ["task_a"],
				createdAt: NOW,
			}),
			"scheduler_fanin_invalid",
		);
		expect(
			parseSchedulerJoinSnapshot({
				schemaVersion: 1,
				joinId: "join_1",
				sourceAttemptReceiptIds: ["receipt_1"],
				sourceTaskResultIds: ["result_1"],
				policy: "allow_partial",
				degradedCriterionIds: ["crit_1"],
			}).ok,
		).toBe(true);
		expect(
			parseSchedulerDeadlockFact({
				schemaVersion: 1,
				detectionId: "deadlock_1",
				memberTaskIds: ["task_a", "task_b"],
				edgeKinds: ["dependsOn", "claim"],
				failedTaskIds: ["task_a"],
				detectedAt: NOW,
			}).ok,
		).toBe(true);
		expect(
			parseSchedulerSelectionFact({
				schemaVersion: 1,
				queueEntryId: "queue_1",
				taskId: "task_1",
				chosenProviderId: "exec_1",
				scores: [{ providerId: "exec_1", score: 4 }],
				inputsDigest: { algorithm: "sha256", value: DIGEST },
				decidedAt: NOW,
			}).ok,
		).toBe(true);
	});

	it("accepts only the frozen engine phase cycle and never auto-retries side_effect_unknown", () => {
		expect(applySchedulerEngineTransition("idle", "scanning").ok).toBe(true);
		expect(applySchedulerEngineTransition("scanning", "idle").ok).toBe(true);
		expect(applySchedulerEngineTransition("settling", "scanning").ok).toBe(true);
		expectCode(applySchedulerEngineTransition("idle", "dispatching"), "scheduler_queue_invalid");
		expect(SCHEDULER_ENGINE_PHASES).toEqual([
			"idle",
			"scanning",
			"enqueueing",
			"claiming",
			"reserving",
			"dispatching",
			"settling",
		]);
		expect(isSchedulerSideEffectRetryable("none")).toBe(true);
		expect(isSchedulerSideEffectRetryable("unknown", "idempotent")).toBe(true);
		expect(isSchedulerSideEffectRetryable("side_effect_unknown")).toBe(false);
		expect(isSchedulerSideEffectRetryable("side_effect_unknown", "idempotent")).toBe(false);
	});
});

describe("scheduler safe serializers", () => {
	it("rejects forbidden payload keys, extra fields, unsafe identifiers, and non-canonical timestamps", () => {
		expect(SCHEDULER_FORBIDDEN_PAYLOAD_KEYS).toContain("prompt");
		expectCode(parseSchedulerQueueEntry({ ...queued(), prompt: "secret instruction" }), "scheduler_queue_invalid");
		expectCode(parseSchedulerQueueEntry({ ...queued(), payload: { text: "raw" } }), "scheduler_queue_invalid");
		expectCode(parseSchedulerQueueEntry({ ...queued(), queueEntryId: "../etc/passwd" }), "scheduler_queue_invalid");
		expectCode(
			parseSchedulerQueueEntry({ ...queued(), enqueuedAt: "2026-08-21T12:00:00Z" }),
			"scheduler_queue_invalid",
		);
		expectCode(parseSchedulerMessage({ ...message(), content: "do not persist" }), "scheduler_message_invalid");
		expectCode(
			parseSchedulerOwnershipTransfer({ ...transfer(), reasonSummary: "contains /secret/path and prompt" }),
			"scheduler_handoff_invalid",
		);
		const copied = serializeSchedulerQueueEntry(queued({ goalId: "goal_1" }));
		expect(copied).toEqual(queued({ goalId: "goal_1" }));
		expect(copied).not.toHaveProperty("prompt");
		const copiedClaim = serializeSchedulerClaim(claim());
		expect(copiedClaim.fencingToken).toBe("fence_abc");
		expect(JSON.stringify(copiedClaim)).not.toContain("prompt");
	});
});

class FakeLedger implements DurableLedgerApi {
	readonly inner: DurableLedgerApi;
	readonly appends: ProvisionedFoundationRecord[] = [];
	staleNextAppend = false;
	staleFencingToken: string | undefined;
	failOnObjectType: string | undefined;

	constructor(inner: DurableLedgerApi) {
		this.inner = inner;
	}

	acquireWriterLease(options: { ownerId: string; ttlMs?: number }): Promise<LedgerWriterLease> {
		return this.inner.acquireWriterLease(options);
	}
	renewWriterLease(options: { fencingToken: string; ttlMs?: number }): Promise<LedgerWriterLease> {
		return this.inner.renewWriterLease(options);
	}
	releaseWriterLease(options: { fencingToken: string }): Promise<void> {
		return this.inner.releaseWriterLease(options);
	}
	getWriterLease(): Promise<LedgerWriterLease | null> {
		return this.inner.getWriterLease();
	}
	getLedgerRevision(): Promise<number> {
		return this.inner.getLedgerRevision();
	}
	async appendFoundationRecord(record: ProvisionedFoundationRecord): Promise<AppendFoundationRecordResult> {
		this.appends.push(record);
		if (this.staleNextAppend) {
			this.staleNextAppend = false;
			throw new DurableLedgerError("session_writer_stale_revision", "Forced stale scheduler write");
		}
		if (this.staleFencingToken !== undefined && record.fencingToken === this.staleFencingToken) {
			throw new DurableLedgerError("session_writer_fencing_token", "Forced stale writer fencing token");
		}
		if (
			this.failOnObjectType !== undefined &&
			record.kind === "fact" &&
			record.objectType === this.failOnObjectType
		) {
			throw new DurableLedgerError("session_writer_busy", "Forced interrupted scheduler write");
		}
		return this.inner.appendFoundationRecord(record);
	}
	setRetentionPolicy(
		policy: FoundationRetentionPolicy,
		options: SetRetentionPolicyOptions,
	): Promise<AppendFoundationRecordResult> {
		return this.inner.setRetentionPolicy(policy, options);
	}
	findFoundationRecords(query?: FoundationRecordQuery): Promise<FoundationRecord[]> {
		return this.inner.findFoundationRecords(query);
	}
	getFoundationObject(objectType: string, objectId: string): Promise<FoundationObjectResult | undefined> {
		return this.inner.getFoundationObject(objectType, objectId);
	}
	getFoundationRevision(objectType: string, objectId: string): Promise<number> {
		return this.inner.getFoundationRevision(objectType, objectId);
	}
	isObjectTombstoned(objectType: string, objectId: string): Promise<boolean> {
		return this.inner.isObjectTombstoned(objectType, objectId);
	}
	getRetentionPolicy(): Promise<FoundationRetentionPolicy | undefined> {
		return this.inner.getRetentionPolicy();
	}
	prunableFoundationRecords(): Promise<readonly FoundationRecord[]> {
		return this.inner.prunableFoundationRecords();
	}
}

function createQueueHarness(
	options: { now: () => string; ownerId?: string; cancelAttempt?: SchedulerCancelAttemptV1; maxAttempts?: number } = {
		now: () => NOW,
	},
): {
	session: Session;
	ledger: FakeLedger;
	store: SchedulerQueueStore;
} {
	const session = new Session(new InMemorySessionStorage({ id: "session_a", createdAt: 1 }));
	const ledger = new FakeLedger(session);
	const store = new SchedulerQueueStore({
		ledger,
		sessionId: "session_a",
		ownerId: options.ownerId ?? "scheduler_host_1",
		now: options.now,
		...(options.cancelAttempt === undefined ? {} : { cancelAttempt: options.cancelAttempt }),
		...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
	});
	return { session, ledger, store };
}

describe("scheduler T2 durable queue store", () => {
	it("enqueues idempotently by business key on the Session ledger", async () => {
		const { store } = createQueueHarness();
		const first = await store.enqueue(queued());
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		expect(first.value.idempotent).toBe(false);
		const replay = await store.enqueue(queued());
		expect(replay.ok).toBe(true);
		if (!replay.ok) return;
		expect(replay.value.idempotent).toBe(true);
		expectCode(await store.enqueue(queued({ goalId: "goal_other" })), "scheduler_queue_conflict");
	});

	it("rejects concurrent claims so only one owner wins", async () => {
		const session = new Session(new InMemorySessionStorage({ id: "session_a", createdAt: 1 }));
		const ledgerA = new FakeLedger(session);
		const ledgerB = new FakeLedger(session);
		const now = () => NOW;
		const a = new SchedulerQueueStore({
			ledger: ledgerA,
			sessionId: "session_a",
			ownerId: "scheduler_host_1",
			now,
		});
		const b = new SchedulerQueueStore({
			ledger: ledgerB,
			sessionId: "session_a",
			ownerId: "scheduler_host_2",
			now,
		});
		expect((await a.enqueue(queued())).ok).toBe(true);
		const [left, right] = await Promise.all([
			a.claim({
				queueEntryId: "queue_1",
				ownerId: "scheduler_host_1",
				claimId: "claim_1",
				fencingToken: "fence_abc",
			}),
			b.claim({
				queueEntryId: "queue_1",
				ownerId: "scheduler_host_2",
				claimId: "claim_2",
				fencingToken: "fence_other",
			}),
		]);
		expect(left.ok !== right.ok).toBe(true);
		const winner = left.ok ? left.value : right.ok ? right.value : undefined;
		expect(winner).toBeDefined();
		if (winner === undefined) return;
		expect(winner.entry.state).toBe("claimed");
		const loser = left.ok ? right : left;
		expect(loser.ok).toBe(false);
		if (loser.ok) return;
		expect(["scheduler_claim_conflict", "scheduler_persistence_failed"]).toContain(loser.error.code);
		const snapshot = await a.snapshot();
		expect(snapshot.ok).toBe(true);
		if (!snapshot.ok) return;
		expect(snapshot.value.claims).toHaveLength(1);
	});

	it("recovers an expired claim by requeueing attemptsUsed+1 and rejects the stale fence", async () => {
		let now = NOW;
		const { store } = createQueueHarness({ now: () => now });
		expect((await store.enqueue(queued())).ok).toBe(true);
		const acquired = await store.claim({
			queueEntryId: "queue_1",
			ownerId: "scheduler_host_1",
			claimId: "claim_1",
			fencingToken: "fence_abc",
			ttlMs: 5 * 60 * 1000,
		});
		expect(acquired.ok).toBe(true);
		if (!acquired.ok) return;
		now = "2026-08-21T12:06:00.000Z";
		expectCode(await store.renew({ claimId: "claim_1", fencingToken: "fence_abc" }), "scheduler_claim_expired");
		const recovered = await store.recoverExpired();
		expect(recovered.ok).toBe(true);
		if (!recovered.ok) return;
		expect(recovered.value).toHaveLength(1);
		expect(recovered.value[0]?.action).toBe("requeued");
		expect(recovered.value[0]?.entry.state).toBe("queued");
		expect(recovered.value[0]?.entry.attemptsUsed).toBe(1);
		expect(recovered.value[0]?.entry.claimId).toBeUndefined();
		expectCode(await store.renew({ claimId: "claim_1", fencingToken: "fence_abc" }), "scheduler_claim_expired");
	});

	it("cancels a dispatched attempt before requeue and fails closed when cancelAttempt fails", async () => {
		let now = NOW;
		const cancelled: string[] = [];
		const { store } = createQueueHarness({
			now: () => now,
			cancelAttempt: async (attemptId) => {
				cancelled.push(attemptId);
				return Result.ok(undefined);
			},
		});
		expect((await store.enqueue(queued())).ok).toBe(true);
		expect(
			(
				await store.claim({
					queueEntryId: "queue_1",
					ownerId: "scheduler_host_1",
					claimId: "claim_1",
					fencingToken: "fence_abc",
				})
			).ok,
		).toBe(true);
		const dispatched = await store.markDispatched({
			queueEntryId: "queue_1",
			fencingToken: "fence_abc",
			dispatchId: "dispatch_1",
			attemptId: "attempt_1",
			providerId: "aos.builtin.in-process",
			providerClass: "task_executor",
		});
		expect(dispatched.ok).toBe(true);
		now = "2026-08-21T12:20:00.000Z";
		const recovered = await store.recoverExpired();
		expect(recovered.ok).toBe(true);
		if (!recovered.ok) return;
		expect(cancelled).toEqual(["attempt_1"]);
		expect(recovered.value[0]?.cancelledAttemptId).toBe("attempt_1");
		expect(recovered.value[0]?.action).toBe("requeued");
		expect(recovered.value[0]?.entry.attemptsUsed).toBe(1);

		let failNow = NOW;
		const failing = createQueueHarness({
			now: () => failNow,
			cancelAttempt: async () => Result.err(new FoundationError("worker_cancel_failed", "Attempt cancel failed")),
		});
		expect((await failing.store.enqueue(queued({ queueEntryId: "queue_fail" }))).ok).toBe(true);
		expect(
			(
				await failing.store.claim({
					queueEntryId: "queue_fail",
					ownerId: "scheduler_host_1",
					claimId: "claim_fail",
					fencingToken: "fence_fail",
				})
			).ok,
		).toBe(true);
		expect(
			(
				await failing.store.markDispatched({
					queueEntryId: "queue_fail",
					fencingToken: "fence_fail",
					dispatchId: "dispatch_fail",
					attemptId: "attempt_fail",
					providerId: "aos.builtin.in-process",
					providerClass: "task_executor",
				})
			).ok,
		).toBe(true);
		failNow = "2026-08-21T12:20:00.000Z";
		expectCode(await failing.store.recoverExpired(), "scheduler_attempt_recovery_failed");
		const stuck = await failing.store.getEntry("queue_fail");
		expect(stuck.ok).toBe(true);
		if (!stuck.ok) return;
		expect(stuck.value.state).toBe("dispatched");
	});

	it("renews with T1 sliding remaining TTL and rejects a stale fencing token", async () => {
		let now = NOW;
		const { store } = createQueueHarness({ now: () => now });
		expect((await store.enqueue(queued())).ok).toBe(true);
		const acquired = await store.claim({
			queueEntryId: "queue_1",
			ownerId: "scheduler_host_1",
			claimId: "claim_1",
			fencingToken: "fence_abc",
			ttlMs: 5 * 60 * 1000,
		});
		expect(acquired.ok).toBe(true);
		if (!acquired.ok) return;
		expectCode(await store.renew({ claimId: "claim_1", fencingToken: "fence_stale" }), "scheduler_lease_lost");
		now = "2026-08-21T12:03:00.000Z";
		const renewed = await store.renew({
			claimId: "claim_1",
			fencingToken: "fence_abc",
			ttlMs: SCHEDULER_CLAIM_MAX_LEASE_TTL_MS,
		});
		expect(renewed.ok).toBe(true);
		if (!renewed.ok) return;
		expect(renewed.value.acquiredAt).toBe(NOW);
		const remainingMs = Date.parse(renewed.value.expiresAt) - Date.parse(now);
		expect(remainingMs).toBe(SCHEDULER_CLAIM_MAX_LEASE_TTL_MS);
		expect(remainingMs).toBeGreaterThanOrEqual(SCHEDULER_CLAIM_MIN_LEASE_TTL_MS);
		expect(store.writerLeaseToken()).toBeDefined();
		expect(store.writerLeaseToken()).not.toBe("fence_abc");
	});

	it("reconstructs from ledger replay and rejects a revision gap", async () => {
		const { session, ledger, store } = createQueueHarness();
		expect((await store.enqueue(queued())).ok).toBe(true);
		expect(
			(
				await store.claim({
					queueEntryId: "queue_1",
					ownerId: "scheduler_host_1",
					claimId: "claim_1",
					fencingToken: "fence_abc",
				})
			).ok,
		).toBe(true);
		const reloaded = new SchedulerQueueStore({
			ledger,
			sessionId: "session_a",
			ownerId: "scheduler_host_reload",
			now: () => NOW,
		});
		const snapshot = await reloaded.snapshot();
		expect(snapshot.ok).toBe(true);
		if (!snapshot.ok) return;
		expect(snapshot.value.entries[0]?.state).toBe("claimed");
		expect(snapshot.value.claims[0]?.fencingToken).toBe("fence_abc");

		const writer = await session.getWriterLease();
		expect(writer).not.toBeNull();
		if (writer === null) return;
		const gap = await session.appendFoundationRecord({
			schemaVersion: 1,
			kind: "fact",
			id: "sched_gap_queue_1_rev3",
			lane: "main",
			objectType: SCHEDULER_QUEUE_ENTRY_OBJECT_TYPE,
			objectId: "queue_1",
			clientRequestId: "scheduler.queue_entry:queue_1:3",
			expectedRevision: 2,
			payload: {
				schemaVersion: 1,
				queueEntryId: "queue_1",
				sessionId: "session_a",
				taskId: "task_1",
				nodeRef: { taskId: "task_1", graphRevision: 1, nodeId: "node_ready" },
				state: "dispatched",
				priority: 10,
				attemptsUsed: 0,
				claimId: "claim_1",
				enqueuedAt: NOW,
				revision: 3,
			},
			correlation: { sessionId: "session_a", laneId: "main", taskId: "task_1" },
			fencingToken: writer.fencingToken,
		});
		expect(gap.replayed).toBe(false);
		expectCode(await reloaded.reload(), "scheduler_queue_invalid");
		expectCode(
			await store.markDispatched({
				queueEntryId: "queue_1",
				fencingToken: "fence_abc",
				dispatchId: "dispatch_gap",
				attemptId: "attempt_gap",
				providerId: "aos.builtin.in-process",
				providerClass: "task_executor",
			}),
			"scheduler_queue_invalid",
		);
	});

	it("resumes markDispatched after in_flight crash so reload remains legal", async () => {
		const { session, ledger, store } = createQueueHarness();
		expect((await store.enqueue(queued())).ok).toBe(true);
		expect(
			(
				await store.claim({
					queueEntryId: "queue_1",
					ownerId: "scheduler_host_1",
					claimId: "claim_1",
					fencingToken: "fence_abc",
				})
			).ok,
		).toBe(true);
		const request = {
			queueEntryId: "queue_1",
			fencingToken: "fence_abc",
			dispatchId: "dispatch_1",
			attemptId: "attempt_1",
			providerId: "aos.builtin.in-process",
			providerClass: "task_executor" as const,
		};
		ledger.failOnObjectType = SCHEDULER_QUEUE_ENTRY_OBJECT_TYPE;
		expectCode(await store.markDispatched(request), "scheduler_persistence_failed");
		ledger.failOnObjectType = undefined;

		const crashed = new SchedulerQueueStore({
			ledger,
			sessionId: "session_a",
			ownerId: "scheduler_host_1",
			now: () => NOW,
		});
		const crashedSnapshot = await crashed.snapshot();
		expect(crashedSnapshot.ok).toBe(true);
		if (!crashedSnapshot.ok) return;
		expect(crashedSnapshot.value.entries[0]?.state).toBe("claimed");
		expect(crashedSnapshot.value.dispatches[0]?.status).toBe("in_flight");
		expect(crashedSnapshot.value.dispatches[0]?.dispatchId).toBe("dispatch_1");

		const resumed = await crashed.markDispatched(request);
		expect(resumed.ok).toBe(true);
		if (!resumed.ok) return;
		expect(resumed.value.entry.state).toBe("dispatched");
		expect(resumed.value.dispatch.status).toBe("in_flight");
		expect(resumed.value.dispatch.dispatchId).toBe("dispatch_1");
		expect(resumed.value.dispatch.attemptId).toBe("attempt_1");

		const reloaded = await crashed.reload();
		expect(reloaded.ok).toBe(true);
		if (!reloaded.ok) return;
		expect(reloaded.value.entries[0]?.state).toBe("dispatched");
		expect(reloaded.value.dispatches[0]?.status).toBe("in_flight");

		const replayed = await store.markDispatched(request);
		expect(replayed.ok).toBe(true);
		if (!replayed.ok) return;
		expect(replayed.value.entry.state).toBe("dispatched");
		expect(replayed.value.dispatch.status).toBe("in_flight");

		const records = await session.findFoundationRecords({ order: "oldestFirst", includePruned: true });
		const dispatchStatuses: string[] = [];
		for (const record of records) {
			if (record.kind !== "fact" || record.objectType !== SCHEDULER_DISPATCH_OBJECT_TYPE) continue;
			const parsed = parseSchedulerDispatchRecord(record.payload);
			expect(parsed.ok).toBe(true);
			if (!parsed.ok) return;
			if (dispatchStatuses[dispatchStatuses.length - 1] === "in_flight") {
				expect(parsed.value.status).not.toBe("prepared");
			}
			dispatchStatuses.push(parsed.value.status);
		}
		expect(dispatchStatuses).toEqual(["prepared", "in_flight"]);
	});

	it("terminalizes a dispatched entry under its active fence and never recovers it", async () => {
		let now = NOW;
		const { ledger, store } = createQueueHarness({ now: () => now });
		expect((await store.enqueue(queued())).ok).toBe(true);
		expect(
			(
				await store.claim({
					queueEntryId: "queue_1",
					ownerId: "scheduler_host_1",
					claimId: "claim_1",
					fencingToken: "fence_abc",
				})
			).ok,
		).toBe(true);
		expect(
			(
				await store.markDispatched({
					queueEntryId: "queue_1",
					fencingToken: "fence_abc",
					dispatchId: "dispatch_1",
					attemptId: "attempt_1",
					providerId: "aos.builtin.in-process",
					providerClass: "task_executor",
				})
			).ok,
		).toBe(true);

		expectCode(
			await store.markTerminal({
				queueEntryId: "queue_1",
				dispatchId: "dispatch_1",
				attemptId: "attempt_1",
				fencingToken: "fence_stale",
				outcome: "settled",
			}),
			"scheduler_lease_lost",
		);
		const settled = await store.markTerminal({
			queueEntryId: "queue_1",
			dispatchId: "dispatch_1",
			attemptId: "attempt_1",
			fencingToken: "fence_abc",
			outcome: "settled",
		});
		expect(settled.ok).toBe(true);
		if (!settled.ok) return;
		expect(settled.value.entry.state).toBe("settled");
		expect(settled.value.dispatch.status).toBe("settled");
		expectCode(
			await store.markTerminal({
				queueEntryId: "queue_1",
				dispatchId: "dispatch_1",
				attemptId: "attempt_1",
				fencingToken: "fence_abc",
				outcome: "settled",
			}),
			"scheduler_dispatch_invalid",
		);

		now = "2026-08-21T12:20:00.000Z";
		const reloaded = new SchedulerQueueStore({
			ledger,
			sessionId: "session_a",
			ownerId: "scheduler_host_reload",
			now: () => now,
		});
		const snapshot = await reloaded.snapshot();
		expect(snapshot.ok).toBe(true);
		if (!snapshot.ok) return;
		expect(snapshot.value.entries[0]?.state).toBe("settled");
		expect(snapshot.value.dispatches[0]?.status).toBe("settled");
		const recovered = await reloaded.recoverExpired();
		expect(recovered.ok).toBe(true);
		if (!recovered.ok) return;
		expect(recovered.value).toEqual([]);
	});

	it("atomically transfers a claimed entry to a unique target claim and fences the source", async () => {
		const { ledger, store } = createQueueHarness();
		expect((await store.enqueue(queued())).ok).toBe(true);
		expect(
			(
				await store.claim({
					queueEntryId: "queue_1",
					ownerId: "scheduler_host_1",
					claimId: "claim_source",
					fencingToken: "fence_source",
				})
			).ok,
		).toBe(true);

		const transferred = await store.transferClaim({
			transferId: "transfer_1",
			queueEntryId: "queue_1",
			sourceFencingToken: "fence_source",
			targetOwnerId: "scheduler_host_2",
			targetClaimId: "claim_target",
			targetFencingToken: "fence_target",
		});
		expect(transferred.ok).toBe(true);
		if (!transferred.ok) return;
		expect(transferred.value.entry).toMatchObject({ state: "claimed", claimId: "claim_target" });
		expect(transferred.value.sourceClaim.ownerId).toBe("scheduler_host_1");
		expect(transferred.value.targetClaim).toMatchObject({
			claimId: "claim_target",
			ownerId: "scheduler_host_2",
			fencingToken: "fence_target",
		});
		expect(transferred.value.transfer.state).toBe("committed");
		expectCode(
			await store.markDispatched({
				queueEntryId: "queue_1",
				fencingToken: "fence_source",
				dispatchId: "dispatch_stale",
				attemptId: "attempt_stale",
				providerId: "aos.builtin.in-process",
				providerClass: "task_executor",
			}),
			"scheduler_lease_lost",
		);
		expectCode(await store.renew({ claimId: "claim_source", fencingToken: "fence_source" }), "scheduler_lease_lost");

		const reloaded = new SchedulerQueueStore({
			ledger,
			sessionId: "session_a",
			ownerId: "scheduler_host_reload",
			now: () => NOW,
		});
		const replayed = await reloaded.transferClaim({
			transferId: "transfer_1",
			queueEntryId: "queue_1",
			sourceFencingToken: "fence_source",
			targetOwnerId: "scheduler_host_2",
		});
		expect(replayed.ok).toBe(true);
		if (!replayed.ok) return;
		expect(replayed.value.transfer.state).toBe("committed");
		expect(replayed.value.entry.claimId).toBe("claim_target");
		const snapshot = await reloaded.snapshot();
		expect(snapshot.ok).toBe(true);
		if (!snapshot.ok) return;
		expect(snapshot.value.claims).toHaveLength(2);
		const persistedTransfer = await reloaded.getClaimTransfer("transfer_1");
		expect(persistedTransfer.ok).toBe(true);
		if (!persistedTransfer.ok) return;
		expect(persistedTransfer.value.state).toBe("committed");
	});

	it("permits sequential committed transfers and fences every prior owner", async () => {
		const { store } = createQueueHarness();
		expect((await store.enqueue(queued())).ok).toBe(true);
		expect(
			(
				await store.claim({
					queueEntryId: "queue_1",
					ownerId: "owner_a",
					claimId: "claim_a",
					fencingToken: "fence_a",
				})
			).ok,
		).toBe(true);

		const aToB = await store.transferClaim({
			transferId: "transfer_a_b",
			queueEntryId: "queue_1",
			sourceFencingToken: "fence_a",
			targetOwnerId: "owner_b",
			targetClaimId: "claim_b",
			targetFencingToken: "fence_b",
		});
		expect(aToB.ok).toBe(true);
		if (!aToB.ok) return;
		expect(aToB.value.transfer.state).toBe("committed");

		const bToC = await store.transferClaim({
			transferId: "transfer_b_c",
			queueEntryId: "queue_1",
			sourceFencingToken: "fence_b",
			targetOwnerId: "owner_c",
			targetClaimId: "claim_c",
			targetFencingToken: "fence_c",
		});
		expect(bToC.ok).toBe(true);
		if (!bToC.ok) return;
		expect(bToC.value.entry).toMatchObject({ state: "claimed", claimId: "claim_c" });
		expect(bToC.value.transfer.state).toBe("committed");

		for (const stale of [
			{ claimId: "claim_a", fencingToken: "fence_a", suffix: "a" },
			{ claimId: "claim_b", fencingToken: "fence_b", suffix: "b" },
		]) {
			expectCode(
				await store.renew({ claimId: stale.claimId, fencingToken: stale.fencingToken }),
				"scheduler_lease_lost",
			);
			expectCode(
				await store.markDispatched({
					queueEntryId: "queue_1",
					fencingToken: stale.fencingToken,
					dispatchId: `dispatch_stale_${stale.suffix}`,
					attemptId: `attempt_stale_${stale.suffix}`,
					providerId: "aos.builtin.in-process",
					providerClass: "task_executor",
				}),
				"scheduler_lease_lost",
			);
		}

		const dispatched = await store.markDispatched({
			queueEntryId: "queue_1",
			fencingToken: "fence_c",
			dispatchId: "dispatch_c",
			attemptId: "attempt_c",
			providerId: "aos.builtin.in-process",
			providerClass: "task_executor",
		});
		expect(dispatched.ok).toBe(true);
		for (const fencingToken of ["fence_a", "fence_b"]) {
			expectCode(
				await store.markTerminal({
					queueEntryId: "queue_1",
					dispatchId: "dispatch_c",
					attemptId: "attempt_c",
					fencingToken,
					outcome: "settled",
				}),
				"scheduler_lease_lost",
			);
		}
	});

	it("resumes a crash between durable source release and target claim issuance", async () => {
		const { ledger, store } = createQueueHarness();
		expect((await store.enqueue(queued())).ok).toBe(true);
		expect(
			(
				await store.claim({
					queueEntryId: "queue_1",
					ownerId: "scheduler_host_1",
					claimId: "claim_source",
					fencingToken: "fence_source",
				})
			).ok,
		).toBe(true);
		ledger.failOnObjectType = SCHEDULER_CLAIM_OBJECT_TYPE;
		expectCode(
			await store.transferClaim({
				transferId: "transfer_crash",
				queueEntryId: "queue_1",
				sourceFencingToken: "fence_source",
				targetOwnerId: "scheduler_host_2",
				targetClaimId: "claim_target",
				targetFencingToken: "fence_target",
			}),
			"scheduler_persistence_failed",
		);
		ledger.failOnObjectType = undefined;
		const releaseIndex = ledger.appends.findIndex(
			(append) => append.kind === "fact" && append.objectType === "scheduler.claim_released",
		);
		const targetIndex = ledger.appends.findIndex(
			(append) =>
				append.kind === "fact" &&
				append.objectType === SCHEDULER_CLAIM_OBJECT_TYPE &&
				append.objectId === "claim_target",
		);
		expect(releaseIndex).toBeGreaterThanOrEqual(0);
		expect(targetIndex).toBeGreaterThan(releaseIndex);

		const crashed = new SchedulerQueueStore({
			ledger,
			sessionId: "session_a",
			ownerId: "scheduler_host_1",
			now: () => NOW,
		});
		const half = await crashed.snapshot();
		expect(half.ok).toBe(true);
		if (!half.ok) return;
		expect(half.value.entries[0]).toMatchObject({ state: "claimed", claimId: "claim_source" });
		expect(half.value.claims).toHaveLength(1);
		const halfTransfer = await crashed.getClaimTransfer("transfer_crash");
		expect(halfTransfer.ok).toBe(true);
		if (!halfTransfer.ok) return;
		expect(halfTransfer.value).toMatchObject({ transferId: "transfer_crash", state: "prepared" });
		expectCode(
			await crashed.markDispatched({
				queueEntryId: "queue_1",
				fencingToken: "fence_source",
				dispatchId: "dispatch_stale",
				attemptId: "attempt_stale",
				providerId: "aos.builtin.in-process",
				providerClass: "task_executor",
			}),
			"scheduler_lease_lost",
		);

		const resumed = await crashed.transferClaim({
			transferId: "transfer_crash",
			queueEntryId: "queue_1",
			sourceFencingToken: "fence_source",
			targetOwnerId: "scheduler_host_2",
		});
		expect(resumed.ok).toBe(true);
		if (!resumed.ok) return;
		expect(resumed.value.entry).toMatchObject({ state: "claimed", claimId: "claim_target" });
		expect(resumed.value.transfer.state).toBe("committed");
	});

	it("transfers dispatched ownership without conflicting with expiry redispatch", async () => {
		let now = NOW;
		const cancelled: string[] = [];
		const { store } = createQueueHarness({
			now: () => now,
			cancelAttempt: async (attemptId) => {
				cancelled.push(attemptId);
				return Result.ok(undefined);
			},
		});
		expect((await store.enqueue(queued())).ok).toBe(true);
		expect(
			(
				await store.claim({
					queueEntryId: "queue_1",
					ownerId: "scheduler_host_1",
					claimId: "claim_source",
					fencingToken: "fence_source",
				})
			).ok,
		).toBe(true);
		expect(
			(
				await store.markDispatched({
					queueEntryId: "queue_1",
					fencingToken: "fence_source",
					dispatchId: "dispatch_source",
					attemptId: "attempt_source",
					providerId: "aos.builtin.in-process",
					providerClass: "task_executor",
				})
			).ok,
		).toBe(true);
		const transferred = await store.transferClaim({
			transferId: "transfer_dispatched",
			queueEntryId: "queue_1",
			sourceFencingToken: "fence_source",
			targetOwnerId: "scheduler_host_2",
			targetClaimId: "claim_target",
			targetFencingToken: "fence_target",
			cancelledAttemptId: "attempt_source",
		});
		expect(transferred.ok).toBe(true);
		if (!transferred.ok) return;
		expect(transferred.value.entry).toMatchObject({ state: "claimed", claimId: "claim_target" });
		expectCode(
			await store.markTerminal({
				queueEntryId: "queue_1",
				dispatchId: "dispatch_source",
				attemptId: "attempt_source",
				fencingToken: "fence_source",
				outcome: "cancelled",
			}),
			"scheduler_lease_lost",
		);
		expect(
			(
				await store.markDispatched({
					queueEntryId: "queue_1",
					fencingToken: "fence_target",
					dispatchId: "dispatch_target",
					attemptId: "attempt_target",
					providerId: "aos.builtin.in-process",
					providerClass: "task_executor",
				})
			).ok,
		).toBe(true);

		now = "2026-08-21T12:20:00.000Z";
		const recovered = await store.recoverExpired();
		expect(recovered.ok).toBe(true);
		if (!recovered.ok) return;
		expect(cancelled).toEqual(["attempt_target"]);
		expect(recovered.value[0]?.entry).toMatchObject({ state: "queued", attemptsUsed: 1 });
		const redispatchClaim = await store.claim({
			queueEntryId: "queue_1",
			ownerId: "scheduler_host_3",
			claimId: "claim_redispatch",
			fencingToken: "fence_redispatch",
		});
		expect(redispatchClaim.ok).toBe(true);
		if (!redispatchClaim.ok) return;
		expect(redispatchClaim.value.claim.ownerId).toBe("scheduler_host_3");
	});

	it("redispatches a new dispatchId after expiry recovery and retains both histories", async () => {
		let now = NOW;
		const cancelled: string[] = [];
		const { ledger, store } = createQueueHarness({
			now: () => now,
			cancelAttempt: async (attemptId) => {
				cancelled.push(attemptId);
				return Result.ok(undefined);
			},
		});
		expect((await store.enqueue(queued())).ok).toBe(true);
		expect(
			(
				await store.claim({
					queueEntryId: "queue_1",
					ownerId: "scheduler_host_1",
					claimId: "claim_1",
					fencingToken: "fence_abc",
				})
			).ok,
		).toBe(true);
		const first = await store.markDispatched({
			queueEntryId: "queue_1",
			fencingToken: "fence_abc",
			dispatchId: "dispatch_1",
			attemptId: "attempt_1",
			providerId: "aos.builtin.in-process",
			providerClass: "task_executor",
		});
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		expectCode(
			await store.markDispatched({
				queueEntryId: "queue_1",
				fencingToken: "fence_abc",
				dispatchId: "dispatch_2",
				attemptId: "attempt_2",
				providerId: "aos.builtin.in-process",
				providerClass: "task_executor",
			}),
			"scheduler_dispatch_invalid",
		);

		now = "2026-08-21T12:20:00.000Z";
		const recovered = await store.recoverExpired();
		expect(recovered.ok).toBe(true);
		if (!recovered.ok) return;
		expect(cancelled).toEqual(["attempt_1"]);
		expect(recovered.value[0]?.cancelledAttemptId).toBe("attempt_1");
		expect(recovered.value[0]?.action).toBe("requeued");
		expect(recovered.value[0]?.entry.state).toBe("queued");
		expect(recovered.value[0]?.entry.claimId).toBeUndefined();
		expectCode(await store.renew({ claimId: "claim_1", fencingToken: "fence_abc" }), "scheduler_claim_expired");

		const secondClaim = await store.claim({
			queueEntryId: "queue_1",
			ownerId: "scheduler_host_1",
			claimId: "claim_2",
			fencingToken: "fence_new",
		});
		expect(secondClaim.ok).toBe(true);
		if (!secondClaim.ok) return;
		expect(secondClaim.value.claim.claimId).toBe("claim_2");
		expect(secondClaim.value.claim.fencingToken).toBe("fence_new");
		expectCode(
			await store.markDispatched({
				queueEntryId: "queue_1",
				fencingToken: "fence_abc",
				dispatchId: "dispatch_2",
				attemptId: "attempt_2",
				providerId: "aos.builtin.in-process",
				providerClass: "task_executor",
			}),
			"scheduler_lease_lost",
		);
		expectCode(
			await store.markDispatched({
				queueEntryId: "queue_1",
				fencingToken: "fence_new",
				dispatchId: "dispatch_1",
				attemptId: "attempt_1",
				providerId: "aos.builtin.in-process",
				providerClass: "task_executor",
			}),
			"scheduler_dispatch_invalid",
		);

		const second = await store.markDispatched({
			queueEntryId: "queue_1",
			fencingToken: "fence_new",
			dispatchId: "dispatch_2",
			attemptId: "attempt_2",
			providerId: "aos.builtin.in-process",
			providerClass: "task_executor",
		});
		expect(second.ok).toBe(true);
		if (!second.ok) return;
		expect(second.value.claim.claimId).toBe("claim_2");
		expect(second.value.claim.fencingToken).toBe("fence_new");
		expect(second.value.dispatch.dispatchId).toBe("dispatch_2");
		expect(second.value.dispatch.status).toBe("in_flight");
		expect(second.value.dispatch.attemptId).toBe("attempt_2");

		const reloaded = new SchedulerQueueStore({
			ledger,
			sessionId: "session_a",
			ownerId: "scheduler_host_reload",
			now: () => now,
		});
		const snapshot = await reloaded.snapshot();
		expect(snapshot.ok).toBe(true);
		if (!snapshot.ok) return;
		expect(snapshot.value.dispatches).toHaveLength(2);
		const byId = new Map(snapshot.value.dispatches.map((record) => [record.dispatchId, record]));
		expect(byId.get("dispatch_1")?.status).toBe("expired");
		expect(byId.get("dispatch_1")?.claimId).toBe("claim_1");
		expect(byId.get("dispatch_1")?.attemptId).toBe("attempt_1");
		expect(byId.get("dispatch_2")?.status).toBe("in_flight");
		expect(byId.get("dispatch_2")?.claimId).toBe("claim_2");
		expect(byId.get("dispatch_2")?.attemptId).toBe("attempt_2");
		expectCode(
			await reloaded.markDispatched({
				queueEntryId: "queue_1",
				fencingToken: "fence_abc",
				dispatchId: "dispatch_1",
				attemptId: "attempt_1",
				providerId: "aos.builtin.in-process",
				providerClass: "task_executor",
			}),
			"scheduler_lease_lost",
		);
		expectCode(
			await reloaded.markDispatched({
				queueEntryId: "queue_1",
				fencingToken: "fence_new",
				dispatchId: "dispatch_1",
				attemptId: "attempt_1",
				providerId: "aos.builtin.in-process",
				providerClass: "task_executor",
			}),
			"scheduler_dispatch_invalid",
		);
		const resumedSecond = await reloaded.markDispatched({
			queueEntryId: "queue_1",
			fencingToken: "fence_new",
			dispatchId: "dispatch_2",
			attemptId: "attempt_2",
			providerId: "aos.builtin.in-process",
			providerClass: "task_executor",
		});
		expect(resumedSecond.ok).toBe(true);
		if (!resumedSecond.ok) return;
		expect(resumedSecond.value.dispatch.dispatchId).toBe("dispatch_2");
		expect(resumedSecond.value.dispatch.status).toBe("in_flight");
	});

	it("fails closed when replaying a queue entry from another session", async () => {
		const { session, store } = createQueueHarness();
		expect((await store.enqueue(queued())).ok).toBe(true);
		const writer = await session.getWriterLease();
		expect(writer).not.toBeNull();
		if (writer === null) return;
		const appended = await session.appendFoundationRecord({
			schemaVersion: 1,
			kind: "fact",
			id: "sched_queue_foreign_session_b",
			lane: "main",
			objectType: SCHEDULER_QUEUE_ENTRY_OBJECT_TYPE,
			objectId: "queue_foreign",
			clientRequestId: "scheduler.queue_entry:queue_foreign:0",
			expectedRevision: 0,
			payload: {
				schemaVersion: 1,
				queueEntryId: "queue_foreign",
				sessionId: "session_b",
				taskId: "task_foreign",
				nodeRef: { taskId: "task_foreign", graphRevision: 1, nodeId: "node_ready" },
				state: "queued",
				priority: 10,
				attemptsUsed: 0,
				enqueuedAt: NOW,
				revision: 0,
			},
			correlation: { sessionId: "session_a", laneId: "main", taskId: "task_foreign" },
			fencingToken: writer.fencingToken,
		});
		expect(appended.replayed).toBe(false);
		expectCode(await store.reload(), "scheduler_queue_invalid");
	});

	it("cancels when TaskEnvelope attempt bounds are exhausted", async () => {
		let now = NOW;
		const { store } = createQueueHarness({ now: () => now, maxAttempts: 1 });
		expect((await store.enqueue(queued(), { maxAttempts: 1 })).ok).toBe(true);
		expect(
			(
				await store.claim({
					queueEntryId: "queue_1",
					ownerId: "scheduler_host_1",
					claimId: "claim_1",
					fencingToken: "fence_abc",
				})
			).ok,
		).toBe(true);
		now = "2026-08-21T12:20:00.000Z";
		const recovered = await store.recoverExpired();
		expect(recovered.ok).toBe(true);
		if (!recovered.ok) return;
		expect(recovered.value[0]?.action).toBe("cancelled");
		expect(recovered.value[0]?.entry.state).toBe("cancelled");
		expect(recovered.value[0]?.entry.attemptsUsed).toBe(0);
		expect(isSchedulerQueueTerminal(recovered.value[0]!.entry.state)).toBe(true);
	});

	it("uses the Session ledger as the only store and never Inbox queue.enqueued/cancelled", async () => {
		const { session, ledger, store } = createQueueHarness();
		expect((await store.enqueue(queued())).ok).toBe(true);
		const acquired = await store.claim({
			queueEntryId: "queue_1",
			ownerId: "scheduler_host_1",
			claimId: "claim_1",
			fencingToken: "fence_abc",
		});
		expect(acquired.ok).toBe(true);
		const records = await session.findFoundationRecords({ order: "oldestFirst", includePruned: true });
		expect(records.length).toBeGreaterThan(0);
		for (const record of records) {
			if (record.kind === "retention") continue;
			expect(isSchedulerQueueLedgerObjectType(record.objectType)).toBe(true);
			expect(record.objectType).not.toBe("queue.enqueued");
			expect(record.objectType).not.toBe("queue.cancelled");
			expect(SCHEDULER_QUEUE_LEDGER_OBJECT_TYPES).toContain(record.objectType);
		}
		expect(
			records.some((record) => record.kind === "fact" && record.objectType === SCHEDULER_QUEUE_ENTRY_OBJECT_TYPE),
		).toBe(true);
		expect(
			records.some((record) => record.kind === "fact" && record.objectType === SCHEDULER_QUEUE_KEY_OBJECT_TYPE),
		).toBe(true);
		expect(
			records.some((record) => record.kind === "fact" && record.objectType === SCHEDULER_CLAIM_OBJECT_TYPE),
		).toBe(true);
		expect(
			records.some((record) => record.kind === "fact" && record.objectType === "scheduler.queue_transitioned"),
		).toBe(true);
		expect(records.some((record) => record.kind === "fact" && record.objectType === "scheduler.claim_acquired")).toBe(
			true,
		);
		const inbox = await session.findRecords({ type: "queue_enqueued" });
		expect(inbox).toEqual([]);
		const cancelled = await session.findRecords({ type: "queue_cancelled" });
		expect(cancelled).toEqual([]);
		const writer = await session.getWriterLease();
		expect(writer).not.toBeNull();
		if (writer === null) return;
		expect(ledger.appends.length).toBeGreaterThan(0);
		for (const append of ledger.appends) {
			expect(append.fencingToken).toBe(writer.fencingToken);
			expect(append.fencingToken).not.toBe("fence_abc");
			if (append.kind !== "fact") continue;
			expect(append.objectType.startsWith("scheduler.")).toBe(true);
		}
		expect(store.writerLeaseToken()).toBe(writer.fencingToken);
		expect(SCHEDULER_DISPATCH_OBJECT_TYPE.startsWith("scheduler.")).toBe(true);
		expect(SCHEDULER_CLAIM_TRANSFER_OBJECT_TYPE.startsWith("scheduler.")).toBe(true);
		expect(SCHEDULER_QUEUE_LEDGER_OBJECT_TYPES).toContain(SCHEDULER_CLAIM_TRANSFER_OBJECT_TYPE);
		expect(SCHEDULER_ATTEMPT_POLICY_OBJECT_TYPE.startsWith("scheduler.")).toBe(true);
		expect(
			(
				await store.enqueue(
					queued({
						queueEntryId: "queue_2",
						taskId: "task_2",
						nodeRef: { taskId: "task_2", graphRevision: 1, nodeId: "node_ready" },
					}),
				)
			).ok,
		).toBe(true);
		ledger.staleNextAppend = true;
		expectCode(
			await store.claim({
				queueEntryId: "queue_2",
				ownerId: "scheduler_host_1",
				claimId: "claim_stale",
				fencingToken: "fence_stale",
			}),
			"scheduler_claim_conflict",
		);
	});
});
