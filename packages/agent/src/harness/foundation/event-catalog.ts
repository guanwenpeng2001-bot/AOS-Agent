import { Result, type Result as ResultValue } from "../result.ts";
import { redactProjection } from "./errors.ts";
import { canonicalFoundationJson } from "./identity.ts";

export const EVENT_SCHEMA_VERSION = 1 as const;
export type EventSchemaVersionV1 = typeof EVENT_SCHEMA_VERSION;
export type FoundationJsonValue = null | boolean | number | string | FoundationJsonValue[] | { [key: string]: FoundationJsonValue };
export type EventCategoryClassV1 = "durable" | "live" | "derived";
export type EventProducerV1 = "harness" | "reducer" | "model" | "tool" | "queue" | "role" | "goal" | "workflow" | "ask" | "artifact" | "migration";
export type EventConsumerV1 = "observer" | "recovery" | "reducer" | "audit" | "rpc" | "ui" | "sdk" | "workflow" | "control_plane";
export interface EventCorrelationRefV1 { sessionId: string; laneId?: string; operationId?: string; runId?: string; turnId?: string; stepId?: string; toolCallId?: string; roleId?: string; roleRevisionId?: string; modelProfileId?: string; modelProfileRevisionId?: string; bindingId?: string; bindingEpochId?: string; attemptId?: string; attemptReceiptId?: string; workerReceiptId?: string; agentInstanceId?: string; goalId?: string; planId?: string; stageId?: string; taskId?: string; dispatchId?: string; taskResultId?: string; runReceiptId?: string; workflowId?: string; askId?: string; artifactId?: string; receiptId?: string; }
export type DurableEventCategoryV1 = "session.created" | "session.closed" | "lane.created" | "lane.moved" | "message.persisted" | "operation.started" | "operation.finished" | "abort.requested" | "step.checkpointed" | "write.deferred" | "tool.started" | "tool.finished" | "queue.enqueued" | "queue.cancelled" | "usage.recorded" | "model.request" | "compaction.persisted" | "navigation.completed" | "binding.activated" | "binding.created" | "binding.revised" | "binding.epoch_activated" | "attempt.started" | "attempt.finished" | "attempt_receipt.written" | "task_result.settled" | "run_receipt.written" | "role.created" | "role.revised" | "role.tombstoned" | "profile.created" | "profile.revised" | "profile.tombstoned" | "task.created" | "task.updated" | "dispatch.created" | "dispatch.updated" | "worker_receipt.written" | "goal.created" | "goal.updated" | "plan.created" | "plan.updated" | "todo.created" | "todo.updated" | "todo.completed" | "ask.created" | "ask.answered" | "ask.expired" | "ask.escalated" | "ask.cancelled" | "workflow.started" | "workflow.paused" | "workflow.resumed" | "workflow.stopped" | "workflow.step_transitioned" | "artifact.registered" | "migration.applied";
export type LiveEventCategoryV1 = "stream.text" | "stream.thinking" | "stream.tool_progress" | "stream.partial_result" | "turn.started" | "turn.finished";
export type DerivedEventCategoryV1 = "run_start" | "run_end" | "snapshot.session" | "snapshot.lane" | "resume_boundary.derived" | "queue.derived" | "pending_writes.derived" | "budget.derived" | "usage.derived" | "epoch.derived" | "position.derived" | "attempt.derived" | "run.derived";
export type EventCategoryIdV1 = DurableEventCategoryV1 | LiveEventCategoryV1 | DerivedEventCategoryV1;
export type EventReplayRuleV1 = "must" | "never";
export type EventRetentionV1 = "ledger" | "session" | "ephemeral";
export type EventMigrationV1 = "stable" | "additive";
export interface EventCatalogEntryBaseV1<TClass extends EventCategoryClassV1 = EventCategoryClassV1> { category: EventCategoryIdV1; class: TClass; schemaVersion: 1; producer: EventProducerV1; consumers: readonly EventConsumerV1[]; stableFields: readonly string[]; correlationFields: readonly (keyof EventCorrelationRefV1)[]; replay: EventReplayRuleV1; retention: EventRetentionV1; migration: EventMigrationV1; redacted: readonly string[]; description: string; }
export interface DurableEventCatalogEntryV1 extends EventCatalogEntryBaseV1<"durable"> { replay: "must"; retention: "ledger"; derivedFrom?: never; }
export interface LiveEventCatalogEntryV1 extends EventCatalogEntryBaseV1<"live"> { replay: "never"; retention: "ephemeral"; derivedFrom?: never; }
export interface DerivedEventCatalogEntryV1 extends EventCatalogEntryBaseV1<"derived"> { replay: "never"; retention: "session"; derivedFrom: readonly DurableEventCategoryV1[]; }
export type EventCatalogEntryV1 = DurableEventCatalogEntryV1 | LiveEventCatalogEntryV1 | DerivedEventCatalogEntryV1;

const durableCategories: readonly DurableEventCategoryV1[] = ["session.created", "session.closed", "lane.created", "lane.moved", "message.persisted", "operation.started", "operation.finished", "abort.requested", "step.checkpointed", "write.deferred", "tool.started", "tool.finished", "queue.enqueued", "queue.cancelled", "usage.recorded", "model.request", "compaction.persisted", "navigation.completed", "binding.activated", "binding.created", "binding.revised", "binding.epoch_activated", "attempt.started", "attempt.finished", "attempt_receipt.written", "task_result.settled", "run_receipt.written", "role.created", "role.revised", "role.tombstoned", "profile.created", "profile.revised", "profile.tombstoned", "task.created", "task.updated", "dispatch.created", "dispatch.updated", "worker_receipt.written", "goal.created", "goal.updated", "plan.created", "plan.updated", "todo.created", "todo.updated", "todo.completed", "ask.created", "ask.answered", "ask.expired", "ask.escalated", "ask.cancelled", "workflow.started", "workflow.paused", "workflow.resumed", "workflow.stopped", "workflow.step_transitioned", "artifact.registered", "migration.applied"];
const liveCategories: readonly LiveEventCategoryV1[] = ["stream.text", "stream.thinking", "stream.tool_progress", "stream.partial_result", "turn.started", "turn.finished"];
const derivedCategories: readonly DerivedEventCategoryV1[] = ["run_start", "run_end", "snapshot.session", "snapshot.lane", "resume_boundary.derived", "queue.derived", "pending_writes.derived", "budget.derived", "usage.derived", "epoch.derived", "position.derived", "attempt.derived", "run.derived"];
export type RoleEventPayloadV1 = { schemaVersion: 1; roleId: string; roleRevisionId: string; revision: number; scope: "global" | "project"; [key: string]: FoundationJsonValue };
export type ProfileEventPayloadV1 = { schemaVersion: 1; profileId: string; profileRevisionId: string; revision: number; [key: string]: FoundationJsonValue };
export type BindingEventPayloadV1 = { schemaVersion: 1; bindingId: string; taskId: string; [key: string]: FoundationJsonValue };
export type BindingEpochEventPayloadV1 = { schemaVersion: 1; bindingId: string; bindingEpochId: string; taskId: string; attemptId: string; ordinal: number; [key: string]: FoundationJsonValue };
export type AttemptEventPayloadV1 = { schemaVersion: 1; attemptId: string; dispatchId: string; taskId: string; [key: string]: FoundationJsonValue };
export type AttemptReceiptEventPayloadV1 = { schemaVersion: 1; attemptReceiptId: string; attemptId: string; taskId: string; [key: string]: FoundationJsonValue };
export type TaskEventPayloadV1 = { schemaVersion: 1; taskId: string; goalId: string; [key: string]: FoundationJsonValue };
export type DispatchEventPayloadV1 = { schemaVersion: 1; dispatchId: string; taskId: string; [key: string]: FoundationJsonValue };
export type WorkerReceiptEventPayloadV1 = { schemaVersion: 1; workerReceiptId: string; operationId: string; [key: string]: FoundationJsonValue };
export type TaskResultEventPayloadV1 = { schemaVersion: 1; taskResultId: string; taskId: string; [key: string]: FoundationJsonValue };
export type RunReceiptEventPayloadV1 = { schemaVersion: 1; runReceiptId: string; runId: string; [key: string]: FoundationJsonValue };
export type GoalEventPayloadV1 = { schemaVersion: 1; goalId: string; sessionId: string; revision: number; [key: string]: FoundationJsonValue };
export type PlanEventPayloadV1 = { schemaVersion: 1; planId: string; goalId: string; revision: number; [key: string]: FoundationJsonValue };
export type TodoEventPayloadV1 = { schemaVersion: 1; todoId: string; revision: number; [key: string]: FoundationJsonValue };
export type AskEventPayloadV1 = { schemaVersion: 1; askId: string; sessionId: string; revision: number; [key: string]: FoundationJsonValue };
export type WorkflowEventPayloadV1 = { schemaVersion: 1; workflowId: string; revision: number; [key: string]: FoundationJsonValue };
export type ArtifactEventPayloadV1 = { schemaVersion: 1; artifactId: string; digest: string; [key: string]: FoundationJsonValue };
export interface EventPayloadMapV1 {
	"role.created": RoleEventPayloadV1; "role.revised": RoleEventPayloadV1; "role.tombstoned": RoleEventPayloadV1;
	"profile.created": ProfileEventPayloadV1; "profile.revised": ProfileEventPayloadV1; "profile.tombstoned": ProfileEventPayloadV1;
	"binding.created": BindingEventPayloadV1; "binding.revised": BindingEventPayloadV1; "binding.activated": BindingEventPayloadV1; "binding.epoch_activated": BindingEpochEventPayloadV1;
	"attempt.started": AttemptEventPayloadV1; "attempt.finished": AttemptEventPayloadV1; "attempt_receipt.written": AttemptReceiptEventPayloadV1;
	"task.created": TaskEventPayloadV1; "task.updated": TaskEventPayloadV1; "dispatch.created": DispatchEventPayloadV1; "dispatch.updated": DispatchEventPayloadV1;
	"worker_receipt.written": WorkerReceiptEventPayloadV1; "task_result.settled": TaskResultEventPayloadV1; "run_receipt.written": RunReceiptEventPayloadV1;
	"goal.created": GoalEventPayloadV1; "goal.updated": GoalEventPayloadV1; "plan.created": PlanEventPayloadV1; "plan.updated": PlanEventPayloadV1;
	"todo.created": TodoEventPayloadV1; "todo.updated": TodoEventPayloadV1; "todo.completed": TodoEventPayloadV1; "ask.created": AskEventPayloadV1; "ask.answered": AskEventPayloadV1; "ask.expired": AskEventPayloadV1; "ask.escalated": AskEventPayloadV1; "ask.cancelled": AskEventPayloadV1;
	"workflow.started": WorkflowEventPayloadV1; "workflow.paused": WorkflowEventPayloadV1; "workflow.resumed": WorkflowEventPayloadV1; "workflow.stopped": WorkflowEventPayloadV1; "workflow.step_transitioned": WorkflowEventPayloadV1;
	"artifact.registered": ArtifactEventPayloadV1;
}
export type EventPayloadForCategoryV1<TCategory extends EventCategoryIdV1> = TCategory extends keyof EventPayloadMapV1 ? EventPayloadMapV1[TCategory] : FoundationJsonValue;
const producerFor = (category: string): EventProducerV1 => category.startsWith("role") || category.startsWith("binding") || category.startsWith("profile") ? "role" : category.startsWith("goal") || category.startsWith("plan") || category.startsWith("task") || category.startsWith("dispatch") || category.startsWith("attempt") || category.startsWith("worker_receipt") || category.startsWith("task_result") || category.startsWith("run_receipt") ? "harness" : category.startsWith("ask") ? "ask" : category.startsWith("workflow") ? "workflow" : category.startsWith("artifact") ? "artifact" : category.startsWith("stream") ? "model" : "harness";
const derivedFrom: Readonly<Record<DerivedEventCategoryV1, readonly DurableEventCategoryV1[]>> = {
	run_start: ["operation.started"], run_end: ["run_receipt.written"], "snapshot.session": ["session.created", "session.closed", "operation.started", "operation.finished", "task.updated", "run_receipt.written"], "snapshot.lane": ["lane.created", "lane.moved", "navigation.completed"],
	"resume_boundary.derived": ["operation.finished", "attempt.finished", "run_receipt.written"], "queue.derived": ["queue.enqueued", "queue.cancelled"], "pending_writes.derived": ["write.deferred", "operation.finished"], "budget.derived": ["usage.recorded"], "usage.derived": ["usage.recorded"], "epoch.derived": ["binding.epoch_activated"], "position.derived": ["step.checkpointed", "navigation.completed"], "attempt.derived": ["attempt.started", "attempt.finished", "attempt_receipt.written"], "run.derived": ["task_result.settled", "run_receipt.written"],
};
const correlationFor = (category: EventCategoryIdV1): readonly (keyof EventCorrelationRefV1)[] => {
	if (category.startsWith("role")) return ["sessionId", "roleId", "roleRevisionId"];
	if (category.startsWith("profile")) return ["sessionId", "modelProfileId", "modelProfileRevisionId"];
	if (category.startsWith("binding")) return ["sessionId", "taskId", "bindingId", "bindingEpochId", "roleRevisionId", "modelProfileRevisionId"];
	if (category.startsWith("attempt_receipt")) return ["sessionId", "taskId", "attemptId", "attemptReceiptId", "dispatchId", "agentInstanceId"];
	if (category.startsWith("attempt")) return ["sessionId", "taskId", "dispatchId", "attemptId", "bindingId", "agentInstanceId"];
	if (category.startsWith("worker_receipt")) return ["sessionId", "taskId", "operationId", "workerReceiptId"];
	if (category.startsWith("task_result")) return ["sessionId", "taskId", "attemptReceiptId", "taskResultId"];
	if (category.startsWith("run_receipt")) return ["sessionId", "runId", "taskResultId", "runReceiptId"];
	if (category.startsWith("task")) return ["sessionId", "goalId", "taskId"];
	if (category.startsWith("dispatch")) return ["sessionId", "taskId", "dispatchId", "bindingId"];
	if (category.startsWith("goal")) return ["sessionId", "goalId"];
	if (category.startsWith("plan")) return ["sessionId", "goalId", "planId"];
	if (category.startsWith("todo")) return ["sessionId", "goalId", "taskId"];
	if (category.startsWith("ask")) return ["sessionId", "askId", "taskId", "goalId"];
	if (category.startsWith("workflow")) return ["sessionId", "workflowId", "goalId", "planId", "stageId", "stepId"];
	if (category.startsWith("artifact")) return ["sessionId", "artifactId", "taskId", "attemptId"];
	if (category.startsWith("stream") || category.startsWith("turn")) return ["sessionId", "laneId", "runId", "turnId", "stepId"];
	return ["sessionId", "laneId", "operationId", "runId", "turnId", "stepId"];
};
interface EventPayloadRuleV1 { required: readonly string[]; allowed: readonly string[]; stringFields: readonly string[]; integerFields: readonly string[]; }
const typedPayloadRules: Readonly<Record<string, EventPayloadRuleV1>> = {
	"role.created": { required: ["schemaVersion", "roleId", "roleRevisionId", "revision", "scope"], allowed: ["schemaVersion", "roleId", "roleRevisionId", "revision", "scope", "fingerprint"], stringFields: ["roleId", "roleRevisionId", "scope"], integerFields: ["revision"] },
	"role.revised": { required: ["schemaVersion", "roleId", "roleRevisionId", "revision", "scope"], allowed: ["schemaVersion", "roleId", "roleRevisionId", "revision", "scope", "fingerprint"], stringFields: ["roleId", "roleRevisionId", "scope"], integerFields: ["revision"] },
	"role.tombstoned": { required: ["schemaVersion", "roleId", "roleRevisionId", "revision", "scope"], allowed: ["schemaVersion", "roleId", "roleRevisionId", "revision", "scope", "fingerprint"], stringFields: ["roleId", "roleRevisionId", "scope"], integerFields: ["revision"] },
	"profile.created": { required: ["schemaVersion", "profileId", "profileRevisionId", "revision"], allowed: ["schemaVersion", "profileId", "profileRevisionId", "revision", "fingerprint"], stringFields: ["profileId", "profileRevisionId"], integerFields: ["revision"] },
	"profile.revised": { required: ["schemaVersion", "profileId", "profileRevisionId", "revision"], allowed: ["schemaVersion", "profileId", "profileRevisionId", "revision", "fingerprint"], stringFields: ["profileId", "profileRevisionId"], integerFields: ["revision"] },
	"profile.tombstoned": { required: ["schemaVersion", "profileId", "profileRevisionId", "revision"], allowed: ["schemaVersion", "profileId", "profileRevisionId", "revision", "fingerprint"], stringFields: ["profileId", "profileRevisionId"], integerFields: ["revision"] },
	"binding.created": { required: ["schemaVersion", "bindingId", "taskId"], allowed: ["schemaVersion", "bindingId", "taskId", "revision", "fingerprint"], stringFields: ["bindingId", "taskId"], integerFields: ["revision"] },
	"binding.revised": { required: ["schemaVersion", "bindingId", "taskId"], allowed: ["schemaVersion", "bindingId", "taskId", "revision", "fingerprint"], stringFields: ["bindingId", "taskId"], integerFields: ["revision"] },
	"binding.activated": { required: ["schemaVersion", "bindingId", "taskId"], allowed: ["schemaVersion", "bindingId", "taskId", "revision", "fingerprint"], stringFields: ["bindingId", "taskId"], integerFields: ["revision"] },
	"binding.epoch_activated": { required: ["schemaVersion", "bindingId", "bindingEpochId", "taskId", "attemptId", "ordinal"], allowed: ["schemaVersion", "bindingId", "bindingEpochId", "taskId", "attemptId", "ordinal"], stringFields: ["bindingId", "bindingEpochId", "taskId", "attemptId"], integerFields: ["ordinal"] },
	"attempt.started": { required: ["schemaVersion", "attemptId", "dispatchId", "taskId"], allowed: ["schemaVersion", "attemptId", "dispatchId", "taskId"], stringFields: ["attemptId", "dispatchId", "taskId"], integerFields: [] },
	"attempt.finished": { required: ["schemaVersion", "attemptId", "dispatchId", "taskId"], allowed: ["schemaVersion", "attemptId", "dispatchId", "taskId"], stringFields: ["attemptId", "dispatchId", "taskId"], integerFields: [] },
	"attempt_receipt.written": { required: ["schemaVersion", "attemptReceiptId", "attemptId", "taskId"], allowed: ["schemaVersion", "attemptReceiptId", "attemptId", "taskId"], stringFields: ["attemptReceiptId", "attemptId", "taskId"], integerFields: [] },
	"task.created": { required: ["schemaVersion", "taskId", "goalId"], allowed: ["schemaVersion", "taskId", "goalId", "revision", "fingerprint"], stringFields: ["taskId", "goalId"], integerFields: ["revision"] },
	"task.updated": { required: ["schemaVersion", "taskId", "goalId"], allowed: ["schemaVersion", "taskId", "goalId", "revision", "fingerprint"], stringFields: ["taskId", "goalId"], integerFields: ["revision"] },
	"dispatch.created": { required: ["schemaVersion", "dispatchId", "taskId"], allowed: ["schemaVersion", "dispatchId", "taskId", "revision"], stringFields: ["dispatchId", "taskId"], integerFields: ["revision"] },
	"dispatch.updated": { required: ["schemaVersion", "dispatchId", "taskId"], allowed: ["schemaVersion", "dispatchId", "taskId", "revision"], stringFields: ["dispatchId", "taskId"], integerFields: ["revision"] },
	"worker_receipt.written": { required: ["schemaVersion", "workerReceiptId", "operationId"], allowed: ["schemaVersion", "workerReceiptId", "operationId", "taskId"], stringFields: ["workerReceiptId", "operationId"], integerFields: [] },
	"task_result.settled": { required: ["schemaVersion", "taskResultId", "taskId"], allowed: ["schemaVersion", "taskResultId", "taskId"], stringFields: ["taskResultId", "taskId"], integerFields: [] },
	"run_receipt.written": { required: ["schemaVersion", "runReceiptId", "runId"], allowed: ["schemaVersion", "runReceiptId", "runId"], stringFields: ["runReceiptId", "runId"], integerFields: [] },
	"goal.created": { required: ["schemaVersion", "goalId", "sessionId", "revision"], allowed: ["schemaVersion", "goalId", "sessionId", "revision"], stringFields: ["goalId", "sessionId"], integerFields: ["revision"] },
	"goal.updated": { required: ["schemaVersion", "goalId", "sessionId", "revision"], allowed: ["schemaVersion", "goalId", "sessionId", "revision"], stringFields: ["goalId", "sessionId"], integerFields: ["revision"] },
	"plan.created": { required: ["schemaVersion", "planId", "goalId", "revision"], allowed: ["schemaVersion", "planId", "goalId", "revision"], stringFields: ["planId", "goalId"], integerFields: ["revision"] },
	"plan.updated": { required: ["schemaVersion", "planId", "goalId", "revision"], allowed: ["schemaVersion", "planId", "goalId", "revision"], stringFields: ["planId", "goalId"], integerFields: ["revision"] },
	"todo.created": { required: ["schemaVersion", "todoId", "revision"], allowed: ["schemaVersion", "todoId", "taskId", "goalId", "revision"], stringFields: ["todoId", "taskId", "goalId"], integerFields: ["revision"] },
	"todo.updated": { required: ["schemaVersion", "todoId", "revision"], allowed: ["schemaVersion", "todoId", "taskId", "goalId", "revision"], stringFields: ["todoId", "taskId", "goalId"], integerFields: ["revision"] },
	"todo.completed": { required: ["schemaVersion", "todoId", "revision"], allowed: ["schemaVersion", "todoId", "taskId", "goalId", "revision"], stringFields: ["todoId", "taskId", "goalId"], integerFields: ["revision"] },
	"ask.created": { required: ["schemaVersion", "askId", "sessionId", "revision"], allowed: ["schemaVersion", "askId", "sessionId", "revision"], stringFields: ["askId", "sessionId"], integerFields: ["revision"] },
	"ask.answered": { required: ["schemaVersion", "askId", "sessionId", "revision"], allowed: ["schemaVersion", "askId", "sessionId", "revision"], stringFields: ["askId", "sessionId"], integerFields: ["revision"] },
	"ask.expired": { required: ["schemaVersion", "askId", "sessionId", "revision"], allowed: ["schemaVersion", "askId", "sessionId", "revision"], stringFields: ["askId", "sessionId"], integerFields: ["revision"] },
	"ask.escalated": { required: ["schemaVersion", "askId", "sessionId", "revision"], allowed: ["schemaVersion", "askId", "sessionId", "revision"], stringFields: ["askId", "sessionId"], integerFields: ["revision"] },
	"ask.cancelled": { required: ["schemaVersion", "askId", "sessionId", "revision"], allowed: ["schemaVersion", "askId", "sessionId", "revision"], stringFields: ["askId", "sessionId"], integerFields: ["revision"] },
	"workflow.started": { required: ["schemaVersion", "workflowId", "revision"], allowed: ["schemaVersion", "workflowId", "goalId", "revision", "stepId"], stringFields: ["workflowId", "goalId", "stepId"], integerFields: ["revision"] },
	"workflow.paused": { required: ["schemaVersion", "workflowId", "revision"], allowed: ["schemaVersion", "workflowId", "goalId", "revision", "stepId"], stringFields: ["workflowId", "goalId", "stepId"], integerFields: ["revision"] },
	"workflow.resumed": { required: ["schemaVersion", "workflowId", "revision"], allowed: ["schemaVersion", "workflowId", "goalId", "revision", "stepId"], stringFields: ["workflowId", "goalId", "stepId"], integerFields: ["revision"] },
	"workflow.stopped": { required: ["schemaVersion", "workflowId", "revision"], allowed: ["schemaVersion", "workflowId", "goalId", "revision", "stepId"], stringFields: ["workflowId", "goalId", "stepId"], integerFields: ["revision"] },
	"workflow.step_transitioned": { required: ["schemaVersion", "workflowId", "revision", "stepId"], allowed: ["schemaVersion", "workflowId", "goalId", "revision", "stepId"], stringFields: ["workflowId", "goalId", "stepId"], integerFields: ["revision"] },
	"artifact.registered": { required: ["schemaVersion", "artifactId", "digest"], allowed: ["schemaVersion", "artifactId", "digest"], stringFields: ["artifactId", "digest"], integerFields: [] },
};
function typedEventPayload(category: EventCategoryIdV1, value: unknown): value is FoundationJsonValue {
	try { canonicalFoundationJson(value); } catch { return false; }
	const rule = typedPayloadRules[category]; if (!rule) return true;
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	if (Object.keys(record).some((key) => !rule.allowed.includes(key)) || rule.required.some((key) => !(key in record))) return false;
	if (record.schemaVersion !== 1 || rule.stringFields.some((key) => typeof record[key] !== "string" || (record[key] as string).length === 0) || rule.integerFields.some((key) => typeof record[key] !== "number" || !Number.isInteger(record[key]))) return false;
	return true;
}
function entry(category: EventCategoryIdV1): EventCatalogEntryV1 {
	if ((durableCategories as readonly string[]).includes(category)) return { category, class: "durable", schemaVersion: 1, producer: producerFor(category), consumers: ["observer", "rpc", "sdk", "audit"], stableFields: ["category", "eventId", "sequence", "timestamp", "correlation", "payload"], correlationFields: correlationFor(category), replay: "must", retention: "ledger", migration: "additive", redacted: category.startsWith("goal") || category.startsWith("ask") ? ["prompt", "answer", "acceptanceCriteria"] : [], description: `Durable ${category} ledger event` };
	if ((liveCategories as readonly string[]).includes(category)) return { category, class: "live", schemaVersion: 1, producer: producerFor(category), consumers: ["observer", "rpc", "ui", "sdk"], stableFields: ["category", "eventId", "offset", "timestamp", "correlation", "payload"], correlationFields: correlationFor(category), replay: "never", retention: "ephemeral", migration: "additive", redacted: category === "stream.thinking" ? ["delta"] : [], description: `Live ${category} stream delta` };
	return { category, class: "derived", schemaVersion: 1, producer: producerFor(category), consumers: ["observer", "rpc", "sdk"], stableFields: ["category", "eventId", "sequence", "timestamp", "correlation", "payload"], correlationFields: correlationFor(category), replay: "never", retention: "session", migration: "stable", redacted: [], derivedFrom: derivedFrom[category as DerivedEventCategoryV1], description: `Derived ${category} projection` };
}
const catalog = {} as Record<EventCategoryIdV1, EventCatalogEntryV1>;
for (const category of [...durableCategories, ...liveCategories, ...derivedCategories]) catalog[category] = entry(category);
export const EVENT_CATALOG: Readonly<Record<EventCategoryIdV1, EventCatalogEntryV1>> = Object.freeze(catalog);
export function eventCatalogEntriesV1(): readonly EventCatalogEntryV1[] { return Object.values(EVENT_CATALOG); }
export function lookupEventCategoryV1(category: string): EventCatalogEntryV1 | undefined { return EVENT_CATALOG[category as EventCategoryIdV1]; }
export function eventClassV1(category: EventCategoryIdV1): EventCategoryClassV1 { return EVENT_CATALOG[category].class; }
export function isDurableEventCategoryV1(category: string): category is DurableEventCategoryV1 { return EVENT_CATALOG[category as EventCategoryIdV1]?.class === "durable"; }
export function isLiveEventCategoryV1(category: string): category is LiveEventCategoryV1 { return EVENT_CATALOG[category as EventCategoryIdV1]?.class === "live"; }
export function isDerivedEventCategoryV1(category: string): category is DerivedEventCategoryV1 { return EVENT_CATALOG[category as EventCategoryIdV1]?.class === "derived"; }
export function partitionEventCatalogV1(): { durable: readonly DurableEventCatalogEntryV1[]; live: readonly LiveEventCatalogEntryV1[]; derived: readonly DerivedEventCatalogEntryV1[] } {
	const durable: DurableEventCatalogEntryV1[] = []; const live: LiveEventCatalogEntryV1[] = []; const derived: DerivedEventCatalogEntryV1[] = [];
	for (const item of Object.values(EVENT_CATALOG)) { if (item.class === "durable") durable.push(item); else if (item.class === "live") live.push(item); else derived.push(item); }
	return { durable, live, derived };
}

export interface DurableEventEnvelopeV1<TCategory extends DurableEventCategoryV1 = DurableEventCategoryV1, TPayload extends FoundationJsonValue = FoundationJsonValue> { schemaVersion: 1; class: "durable"; category: TCategory; eventId: string; streamId: string; sequence: number; timestamp: string; correlation: EventCorrelationRefV1; payload: TPayload; }
export interface LiveDeltaEnvelopeV1<TCategory extends LiveEventCategoryV1 = LiveEventCategoryV1, TPayload extends FoundationJsonValue = FoundationJsonValue> { schemaVersion: 1; class: "live"; category: TCategory; eventId: string; streamId: string; offset: number; timestamp: string; correlation: EventCorrelationRefV1; payload: TPayload; }
export interface DerivedEventEnvelopeV1<TPayload extends FoundationJsonValue = FoundationJsonValue> { schemaVersion: 1; class: "derived"; category: DerivedEventCategoryV1; eventId: string; streamId: string; sequence: number; timestamp: string; correlation: EventCorrelationRefV1; payload: TPayload; }
export type FoundationDurableEventV1 = DurableEventEnvelopeV1; export type FoundationLiveDeltaV1 = LiveDeltaEnvelopeV1; export type FoundationDerivedEventV1 = DerivedEventEnvelopeV1; export type FoundationEventEnvelopeV1 = FoundationDurableEventV1 | FoundationLiveDeltaV1 | FoundationDerivedEventV1;
export interface CreateEventInputV1<TCorrelation extends EventCorrelationRefV1 = EventCorrelationRefV1, TPayload extends FoundationJsonValue = FoundationJsonValue> { eventId: string; streamId: string; correlation: TCorrelation; timestamp: string; payload: TPayload; }
export interface CreateDurableEventInputV1<TCategory extends DurableEventCategoryV1 = DurableEventCategoryV1> extends CreateEventInputV1<EventCorrelationRefV1, EventPayloadForCategoryV1<TCategory>> { category: TCategory; sequence: number; }
export function createDurableEventV1<TCategory extends DurableEventCategoryV1>(input: CreateDurableEventInputV1<TCategory>): DurableEventEnvelopeV1<TCategory, EventPayloadForCategoryV1<TCategory>> { const envelope: DurableEventEnvelopeV1<TCategory, EventPayloadForCategoryV1<TCategory>> = { schemaVersion: 1, class: "durable", category: input.category, eventId: input.eventId, streamId: input.streamId, sequence: input.sequence, timestamp: input.timestamp, correlation: input.correlation, payload: input.payload }; const checked = validateDurableEventV1(envelope); if (!checked.ok) throw checked.error; return envelope; }
export interface CreateLiveDeltaInputV1<TCategory extends LiveEventCategoryV1 = LiveEventCategoryV1> extends CreateEventInputV1<EventCorrelationRefV1, FoundationJsonValue> { category: TCategory; offset: number; }
export function createLiveDeltaV1<TCategory extends LiveEventCategoryV1>(input: CreateLiveDeltaInputV1<TCategory>): LiveDeltaEnvelopeV1<TCategory, FoundationJsonValue> { const envelope: LiveDeltaEnvelopeV1<TCategory, FoundationJsonValue> = { schemaVersion: 1, class: "live", category: input.category, eventId: input.eventId, streamId: input.streamId, offset: input.offset, timestamp: input.timestamp, correlation: input.correlation, payload: input.payload }; const checked = validateLiveDeltaV1(envelope); if (!checked.ok) throw checked.error; return envelope; }
export interface CreateDerivedEventInputV1<TCategory extends DerivedEventCategoryV1 = DerivedEventCategoryV1> extends CreateEventInputV1<EventCorrelationRefV1, FoundationJsonValue> { category: TCategory; sequence: number; }
export function createDerivedEventV1<TCategory extends DerivedEventCategoryV1>(input: CreateDerivedEventInputV1<TCategory>): DerivedEventEnvelopeV1<FoundationJsonValue> { const envelope: DerivedEventEnvelopeV1<FoundationJsonValue> = { schemaVersion: 1, class: "derived", category: input.category, eventId: input.eventId, streamId: input.streamId, sequence: input.sequence, timestamp: input.timestamp, correlation: input.correlation, payload: input.payload }; const checked = validateDerivedEventV1(envelope); if (!checked.ok) throw checked.error; return envelope; }

export type EventEnvelopeErrorCodeV1 = "event_envelope_unknown_category" | "event_envelope_class_mismatch" | "event_envelope_invalid_schema_version" | "event_envelope_invalid_sequence" | "event_envelope_invalid_shape";
export class EventEnvelopeErrorV1 extends Error { readonly _tag = "EventEnvelopeErrorV1" as const; readonly code: EventEnvelopeErrorCodeV1; constructor(code: EventEnvelopeErrorCodeV1, message: string) { super(String(message).replace(/https?:\/\/[^\s]+/g, "[redacted-url]")); this.name = "EventEnvelopeErrorV1"; this.code = code; } }
function plain(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function stringValue(value: unknown): value is string { return typeof value === "string" && value.length > 0; }
function jsonValue(value: unknown): value is FoundationJsonValue {
	try { canonicalFoundationJson(value); return true; } catch { return false; }
}
export function validateEventPayloadForCategoryV1(category: EventCategoryIdV1, value: unknown): value is FoundationJsonValue { return typedEventPayload(category, value); }
const correlationKeys: readonly (keyof EventCorrelationRefV1)[] = ["sessionId", "laneId", "operationId", "runId", "turnId", "stepId", "toolCallId", "roleId", "roleRevisionId", "modelProfileId", "modelProfileRevisionId", "bindingId", "bindingEpochId", "attemptId", "attemptReceiptId", "workerReceiptId", "agentInstanceId", "goalId", "planId", "stageId", "taskId", "dispatchId", "taskResultId", "runReceiptId", "workflowId", "askId", "artifactId", "receiptId"];
function correlation(value: unknown): value is EventCorrelationRefV1 {
	if (!plain(value) || !stringValue(value.sessionId) || !Object.keys(value).every((key) => correlationKeys.includes(key as keyof EventCorrelationRefV1))) return false;
	return Object.values(value).every((item) => stringValue(item));
}
function exactKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean { return Object.keys(value).every((key) => allowed.includes(key)); }
export function validateDurableEventV1(value: unknown): ResultValue<FoundationDurableEventV1, EventEnvelopeErrorV1> {
	if (!plain(value) || !exactKeys(value, ["schemaVersion", "class", "category", "eventId", "streamId", "sequence", "timestamp", "correlation", "payload"])) return Result.err(new EventEnvelopeErrorV1("event_envelope_invalid_shape", "durable event has an invalid exact shape"));
	if (value.schemaVersion !== 1) return Result.err(new EventEnvelopeErrorV1("event_envelope_invalid_schema_version", "unsupported event schema version"));
	if (typeof value.category !== "string" || !isDurableEventCategoryV1(value.category)) return Result.err(new EventEnvelopeErrorV1("event_envelope_unknown_category", "unknown durable event category"));
	if (value.class !== "durable") return Result.err(new EventEnvelopeErrorV1("event_envelope_class_mismatch", "durable category must use class durable"));
	if (!stringValue(value.eventId) || !stringValue(value.streamId) || !stringValue(value.timestamp) || typeof value.sequence !== "number" || !Number.isInteger(value.sequence) || value.sequence < 0 || !correlation(value.correlation) || !jsonValue(value.payload) || !typedEventPayload(value.category, value.payload)) return Result.err(new EventEnvelopeErrorV1("event_envelope_invalid_shape", "durable event fields are invalid"));
	return Result.ok({ schemaVersion: 1, class: "durable", category: value.category as DurableEventCategoryV1, eventId: value.eventId as string, streamId: value.streamId as string, sequence: value.sequence as number, timestamp: value.timestamp as string, correlation: value.correlation as EventCorrelationRefV1, payload: value.payload as FoundationJsonValue });
}
export function validateLiveDeltaV1(value: unknown): ResultValue<FoundationLiveDeltaV1, EventEnvelopeErrorV1> {
	if (!plain(value) || !exactKeys(value, ["schemaVersion", "class", "category", "eventId", "streamId", "offset", "timestamp", "correlation", "payload"])) return Result.err(new EventEnvelopeErrorV1("event_envelope_invalid_shape", "live event has an invalid exact shape"));
	if (value.schemaVersion !== 1) return Result.err(new EventEnvelopeErrorV1("event_envelope_invalid_schema_version", "unsupported event schema version"));
	if (typeof value.category !== "string" || !isLiveEventCategoryV1(value.category)) return Result.err(new EventEnvelopeErrorV1("event_envelope_unknown_category", "unknown live event category"));
	if (value.class !== "live") return Result.err(new EventEnvelopeErrorV1("event_envelope_class_mismatch", "live category must use class live"));
	if (!stringValue(value.eventId) || !stringValue(value.streamId) || !stringValue(value.timestamp) || typeof value.offset !== "number" || !Number.isInteger(value.offset) || value.offset < 0 || !correlation(value.correlation) || !jsonValue(value.payload) || !typedEventPayload(value.category, value.payload)) return Result.err(new EventEnvelopeErrorV1("event_envelope_invalid_shape", "live event fields are invalid"));
	return Result.ok({ schemaVersion: 1, class: "live", category: value.category as LiveEventCategoryV1, eventId: value.eventId as string, streamId: value.streamId as string, offset: value.offset as number, timestamp: value.timestamp as string, correlation: value.correlation as EventCorrelationRefV1, payload: value.payload as FoundationJsonValue });
}
export function validateDerivedEventV1(value: unknown): ResultValue<FoundationDerivedEventV1, EventEnvelopeErrorV1> {
	if (!plain(value) || !exactKeys(value, ["schemaVersion", "class", "category", "eventId", "streamId", "sequence", "timestamp", "correlation", "payload"])) return Result.err(new EventEnvelopeErrorV1("event_envelope_invalid_shape", "derived event has an invalid exact shape"));
	if (value.schemaVersion !== 1) return Result.err(new EventEnvelopeErrorV1("event_envelope_invalid_schema_version", "unsupported event schema version"));
	if (typeof value.category !== "string" || !isDerivedEventCategoryV1(value.category)) return Result.err(new EventEnvelopeErrorV1("event_envelope_unknown_category", "unknown derived event category"));
	if (value.class !== "derived") return Result.err(new EventEnvelopeErrorV1("event_envelope_class_mismatch", "derived category must use class derived"));
	if (!stringValue(value.eventId) || !stringValue(value.streamId) || !stringValue(value.timestamp) || typeof value.sequence !== "number" || !Number.isInteger(value.sequence) || value.sequence < 0 || !correlation(value.correlation) || !jsonValue(value.payload) || !typedEventPayload(value.category, value.payload)) return Result.err(new EventEnvelopeErrorV1("event_envelope_invalid_shape", "derived event fields are invalid"));
	return Result.ok({ schemaVersion: 1, class: "derived", category: value.category as DerivedEventCategoryV1, eventId: value.eventId as string, streamId: value.streamId as string, sequence: value.sequence as number, timestamp: value.timestamp as string, correlation: value.correlation as EventCorrelationRefV1, payload: value.payload as FoundationJsonValue });
}
export function redactEventValueV1(value: FoundationJsonValue, extraRedacted: ReadonlySet<string>): FoundationJsonValue { const redacted = redactProjection(value) as FoundationJsonValue; if (typeof redacted !== "object" || redacted === null || Array.isArray(redacted)) return redacted; const copy: Record<string, FoundationJsonValue> = { ...redacted }; for (const key of extraRedacted) if (key in copy) copy[key] = "[redacted]"; return copy; }
export interface EventPublicProjectionV1 { schemaVersion: 1; class: EventCategoryClassV1; category: EventCategoryIdV1; eventId: string; streamId: string; sequence?: number; offset?: number; timestamp: string; correlation: EventCorrelationRefV1; payload: FoundationJsonValue; }
export function projectEventEnvelopeV1(envelope: FoundationEventEnvelopeV1): EventPublicProjectionV1 { const entry = EVENT_CATALOG[envelope.category]; const base = { schemaVersion: 1 as const, class: envelope.class, category: envelope.category, eventId: envelope.eventId, streamId: envelope.streamId, timestamp: envelope.timestamp, correlation: envelope.correlation, payload: redactEventValueV1(envelope.payload, new Set(entry.redacted)) }; return envelope.class === "live" ? { ...base, offset: envelope.offset } : { ...base, sequence: envelope.sequence }; }
export function serializeDurableEventV1(value: FoundationDurableEventV1): string { const checked = validateDurableEventV1(value); if (!checked.ok) throw checked.error; return stableEventJson(checked.value); }
export function serializeLiveDeltaV1(value: FoundationLiveDeltaV1): string { const checked = validateLiveDeltaV1(value); if (!checked.ok) throw checked.error; return stableEventJson(checked.value); }
export function serializeDerivedEventV1(value: FoundationDerivedEventV1): string { const checked = validateDerivedEventV1(value); if (!checked.ok) throw checked.error; return stableEventJson(checked.value); }
export function parseDurableEventV1(text: string): ResultValue<FoundationDurableEventV1, EventEnvelopeErrorV1> { try { return validateDurableEventV1(JSON.parse(text) as unknown); } catch { return Result.err(new EventEnvelopeErrorV1("event_envelope_invalid_shape", "event payload is not valid JSON")); } }
export function parseLiveDeltaV1(text: string): ResultValue<FoundationLiveDeltaV1, EventEnvelopeErrorV1> { try { return validateLiveDeltaV1(JSON.parse(text) as unknown); } catch { return Result.err(new EventEnvelopeErrorV1("event_envelope_invalid_shape", "event payload is not valid JSON")); } }
export function parseDerivedEventV1(text: string): ResultValue<FoundationDerivedEventV1, EventEnvelopeErrorV1> { try { return validateDerivedEventV1(JSON.parse(text) as unknown); } catch { return Result.err(new EventEnvelopeErrorV1("event_envelope_invalid_shape", "event payload is not valid JSON")); } }
function stableEventJson(value: FoundationEventEnvelopeV1): string { if (value.class === "durable") return JSON.stringify({ ...value, payload: value.payload }); if (value.class === "live") return JSON.stringify({ ...value, payload: value.payload }); return JSON.stringify({ ...value, payload: value.payload }); }
