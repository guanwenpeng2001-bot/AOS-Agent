import { describe, expect, it } from "vitest";
import {
	DURABLE_LEDGER_ERROR_CODES,
	FOUNDATION_ERROR_CODES,
	SUBAGENT_ERROR_CODES,
} from "../../src/harness/foundation/errors.ts";
import {
	EVENT_CATALOG,
	createDurableEvent,
	eventCatalogEntries,
	projectEventEnvelope,
	validateDurableEvent,
	validateEventPayloadForCategory,
} from "../../src/harness/foundation/event-catalog.ts";

const SUBAGENT_CATEGORIES = [
	"subagent.lifecycle_transitioned",
	"subagent.mailbox_message_sent",
	"subagent.mailbox_message_acknowledged",
	"subagent.worktree_recorded",
] as const;

const SCHEDULER_CATEGORIES = [
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

const EXISTING_DURABLE_CATEGORIES = [
	"session.created", "session.closed", "lane.created", "lane.moved", "message.persisted", "operation.started", "operation.finished", "abort.requested", "step.checkpointed", "write.deferred", "tool.started", "tool.finished", "queue.enqueued", "queue.cancelled", "usage.recorded", "model.request", "compaction.persisted", "navigation.completed", "binding.activated", "binding.created", "binding.revised", "binding.epoch_activated", "attempt.started", "attempt.finished", "attempt_receipt.written", "task_result.settled", "run_receipt.written", "role.created", "role.revised", "role.tombstoned", "profile.created", "profile.revised", "profile.tombstoned", "task.created", "task.updated", "dispatch.created", "dispatch.updated", "worker.lifecycle_transitioned", "worker.operation_recorded", "worker_receipt.written", "goal.created", "goal.updated", "plan.created", "plan.updated", "todo.created", "todo.updated", "todo.completed", "ask.created", "ask.answered", "ask.expired", "ask.escalated", "ask.cancelled", "workflow.started", "workflow.paused", "workflow.resumed", "workflow.stopped", "workflow.step_transitioned", "artifact.registered", "migration.applied",
] as const;

const timestamp = "2026-08-22T00:00:00.000Z";
const correlation = {
	sessionId: "session-1",
	laneId: "child-lane-1",
	taskId: "task-1",
	dispatchId: "dispatch-1",
	attemptId: "attempt-1",
	agentInstanceId: "child-1",
};
const mailboxCorrelation = {
	sessionId: correlation.sessionId,
	laneId: correlation.laneId,
	taskId: correlation.taskId,
	attemptId: correlation.attemptId,
	agentInstanceId: correlation.agentInstanceId,
};
const lifecyclePayload = {
	schemaVersion: 1 as const,
	childAgentInstanceId: "child-1",
	parentAgentInstanceId: "parent-1",
	ancestorIds: ["root-1", "parent-1"],
	depth: 2,
	spawnId: "spawn-1",
	taskId: "task-1",
	dispatchId: "dispatch-1",
	attemptId: "attempt-1",
	bindingId: "binding-1",
	bindingEpochIds: ["epoch-1"],
	providerKind: "in_process" as const,
	providerId: "child-provider",
	forkScope: "none" as const,
	status: "running" as const,
	revision: 1,
	createdAt: timestamp,
};

describe("line 12A Foundation additions", () => {
	it("appends exactly the 19 specified errors without changing durable-ledger codes", () => {
		expect(FOUNDATION_ERROR_CODES.slice(-DURABLE_LEDGER_ERROR_CODES.length)).toEqual(
			DURABLE_LEDGER_ERROR_CODES,
		);
		const core = FOUNDATION_ERROR_CODES.slice(0, -DURABLE_LEDGER_ERROR_CODES.length);
		expect(core.slice(-SUBAGENT_ERROR_CODES.length)).toEqual(SUBAGENT_ERROR_CODES);
		expect(FOUNDATION_ERROR_CODES.filter((code) => code.startsWith("subagent_"))).toEqual(
			SUBAGENT_ERROR_CODES,
		);
		expect(new Set(FOUNDATION_ERROR_CODES).size).toBe(FOUNDATION_ERROR_CODES.length);
	});

	it("preserves the subagent additions before the later Scheduler catalog entries", () => {
		const partitions = eventCatalogEntries();
		expect(partitions.filter((entry) => entry.class === "durable").map((entry) => entry.category)).toEqual([
			...EXISTING_DURABLE_CATEGORIES,
			...SUBAGENT_CATEGORIES,
			...SCHEDULER_CATEGORIES,
		]);
		expect(partitions.filter((entry) => entry.class === "live").map((entry) => entry.category)).toEqual([
			"stream.text", "stream.thinking", "stream.tool_progress", "stream.partial_result", "turn.started", "turn.finished",
		]);
		expect(partitions.filter((entry) => entry.class === "derived").map((entry) => entry.category)).toEqual([
			"run_start", "run_end", "snapshot.session", "snapshot.lane", "resume_boundary.derived", "queue.derived", "pending_writes.derived", "budget.derived", "usage.derived", "epoch.derived", "position.derived", "attempt.derived", "run.derived",
		]);
		for (const category of SUBAGENT_CATEGORIES) {
			expect(EVENT_CATALOG[category]).toMatchObject({
				class: "durable",
				producer: "subagent",
				replay: "must",
				retention: "ledger",
				migration: "additive",
			});
		}
		expect(EVENT_CATALOG["subagent.lifecycle_transitioned"].correlationFields).toEqual([
			"sessionId", "laneId", "agentInstanceId", "taskId", "dispatchId", "attemptId",
		]);
		expect(EVENT_CATALOG["subagent.mailbox_message_sent"].correlationFields).toEqual([
			"sessionId", "laneId", "agentInstanceId", "taskId", "attemptId",
		]);
		expect(EVENT_CATALOG["subagent.worktree_recorded"].correlationFields).toEqual([
			"sessionId", "laneId", "agentInstanceId", "attemptId",
		]);
	});

	it("requires exact lifecycle payload and correlation identities", () => {
		const event = createDurableEvent({
			category: "subagent.lifecycle_transitioned",
			eventId: "event-lifecycle-1",
			streamId: "session-1",
			sequence: 1,
			timestamp,
			correlation,
			payload: lifecyclePayload,
		});
		expect(projectEventEnvelope(event).payload).toEqual(lifecyclePayload);
		for (const drift of [
			{ agentInstanceId: "child-2" },
			{ taskId: "task-2" },
			{ dispatchId: "dispatch-2" },
			{ attemptId: "attempt-2" },
		]) {
			expect(validateDurableEvent({ ...event, correlation: { ...correlation, ...drift } }).ok).toBe(false);
		}
		expect(validateDurableEvent({ ...event, correlation: { sessionId: "session-1" } }).ok).toBe(false);
		expect(validateEventPayloadForCategory(event.category, { ...lifecyclePayload, rawFrame: "forbidden" })).toBe(false);
		expect(validateEventPayloadForCategory(event.category, { ...lifecyclePayload, status: "terminal" })).toBe(false);
		expect(validateEventPayloadForCategory(event.category, { ...lifecyclePayload, ancestorIds: ["parent-2"] })).toBe(false);
		expect(validateEventPayloadForCategory(event.category, { ...lifecyclePayload, providerKind: "acp" })).toBe(false);
		expect(validateEventPayloadForCategory(event.category, { ...lifecyclePayload, providerKind: "sdk" })).toBe(false);
	});

	it("requires Scheduler payload identities to match the durable correlation", () => {
		const event = createDurableEvent({
			category: "scheduler.queue_transitioned",
			eventId: "event-scheduler-1",
			streamId: "session-1",
			sequence: 1,
			timestamp,
			correlation: { sessionId: "session-1", taskId: "task-1" },
			payload: {
				schemaVersion: 1,
				queueEntryId: "queue-1",
				sessionId: "session-1",
				taskId: "task-1",
				state: "queued",
				revision: 1,
			},
		});
		expect(validateDurableEvent({ ...event, correlation: { sessionId: "session-2", taskId: "task-1" } }).ok).toBe(false);
		expect(validateDurableEvent({ ...event, correlation: { sessionId: "session-1", taskId: "task-2" } }).ok).toBe(false);
	});

	it("validates sent and acknowledged mailbox events and redacts message bodies", () => {
		const sent = createDurableEvent({
			category: "subagent.mailbox_message_sent",
			eventId: "event-mailbox-1",
			streamId: "session-1",
			sequence: 2,
			timestamp,
			correlation,
			payload: {
				schemaVersion: 1,
				messageId: "message-1",
				fromAgentInstanceId: "parent-1",
				toAgentInstanceId: "child-1",
				kind: "input",
				body: { text: "untrusted child input" },
				correlation: mailboxCorrelation,
				createdAt: timestamp,
			},
		});
		expect(projectEventEnvelope(sent).payload).toMatchObject({ body: "[redacted]" });
		expect(validateDurableEvent({ ...sent, correlation: { ...correlation, agentInstanceId: "parent-1" } }).ok).toBe(false);
		expect(validateEventPayloadForCategory(sent.category, { ...sent.payload, ack: { at: timestamp, byAttemptId: "attempt-1" } })).toBe(false);

		const acknowledged = createDurableEvent({
			category: "subagent.mailbox_message_acknowledged",
			eventId: "event-mailbox-2",
			streamId: "session-1",
			sequence: 3,
			timestamp,
			correlation,
			payload: {
				schemaVersion: 1,
				messageId: "message-1",
				fromAgentInstanceId: "parent-1",
				toAgentInstanceId: "child-1",
				at: timestamp,
				byAttemptId: "attempt-1",
			},
		});
		expect(projectEventEnvelope(acknowledged).payload).toEqual(acknowledged.payload);
		expect(validateDurableEvent({ ...acknowledged, correlation: { ...correlation, attemptId: "attempt-2" } }).ok).toBe(false);
	});

	it("validates exact worktree audit facts without persisting a path", () => {
		const event = createDurableEvent({
			category: "subagent.worktree_recorded",
			eventId: "event-worktree-1",
			streamId: "session-1",
			sequence: 4,
			timestamp,
			correlation,
			payload: {
				schemaVersion: 1,
				childAgentInstanceId: "child-1",
				attemptId: "attempt-1",
				baseRef: "main",
				worktreeDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
				apply: { status: "applied", at: timestamp },
				cleanedUp: true,
			},
		});
		expect(projectEventEnvelope(event).payload).toEqual(event.payload);
		expect(validateEventPayloadForCategory(event.category, { ...event.payload, path: "C:\\private" })).toBe(false);
		expect(validateEventPayloadForCategory(event.category, { ...event.payload, baseRef: "C:\\private" })).toBe(false);
		expect(validateEventPayloadForCategory(event.category, { ...event.payload, apply: { status: "applied", at: timestamp, output: "raw" } })).toBe(false);
		expect(validateDurableEvent({ ...event, correlation: { ...correlation, agentInstanceId: "child-2" } }).ok).toBe(false);
	});
});
