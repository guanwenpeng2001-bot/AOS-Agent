import { Result, type Result as ResultValue } from "../result.ts";
import { Type } from "typebox";
import type { AcceptanceCriterionV1 } from "./goal.ts";
import type { BudgetV1 } from "./budget.ts";
import { FoundationError } from "./errors.ts";
import { fingerprintFoundationValue, type FingerprintV1 } from "./identity.ts";
import { cloneDeepFrozen } from "./immutability.ts";
import { FingerprintV1Schema } from "./schema.ts";
import { ArtifactRefV1Schema, type ArtifactRefV1, type RevisionReferenceV1, type VersionedReferenceV1 } from "./reference.ts";
import type { BindingEpochV1 } from "./role.ts";
import { parseExactShape, serializeExactShape, validateExactShape } from "./schema.ts";

export type TaskStatusV1 = "draft" | "ready" | "running" | "succeeded" | "failed" | "cancelled";
export const TASK_ENVELOPE_KINDS = ["run", "compaction", "navigation", "task"] as const;
export type TaskEnvelopeKind = (typeof TASK_ENVELOPE_KINDS)[number];

/**
 * Optional execution constraints are explicit references, not untyped extension bags. A task may
 * omit this object when the Resolver is free to choose the role/model/quota, but a supplied value
 * is always consumable by a provider without reaching into implementation-specific settings.
 */
export interface TaskRequirementsV1 {
	role?: VersionedReferenceV1;
	modelProfile?: VersionedReferenceV1;
	quota?: BudgetV1;
	deadlineAt?: string;
}

export interface TaskEnvelopeV1 {
	schemaVersion: 1;
	taskId: string;
	/** A task is always attached to a persisted goal; the goal itself is not inferred from a title. */
	goalId: string;
	/** Deterministic task objective consumed by Resolver and executors. */
	goal: string;
	kind?: TaskEnvelopeKind;
	/** Optional display label; `goal` is the execution-semantic field. */
	title?: string;
	description?: string;
	/** Workspace address consumed by the executor; it is required even when the address is opaque. */
	workspace: string;
	/** Allowlisted permission/capability scope snapshot consumed by Resolver and executors. */
	capabilityRefs: readonly ArtifactRefV1[];
	/** Deterministic input artifacts; an empty list means the task has no artifact inputs. */
	inputs: readonly ArtifactRefV1[];
	/** Deterministic output contract; an empty list means no artifact is prescribed. */
	expectedOutputs: readonly ArtifactRefV1[];
	/** Legacy transport packaging is optional because `inputs`/`expectedOutputs` are canonical. */
	payload?: { kind: "artifacts" | "reference"; refs: readonly ArtifactRefV1[] };
	budget: BudgetV1;
	acceptanceCriteria: readonly AcceptanceCriterionV1[];
	requirements?: TaskRequirementsV1;
	/** Retry policy is optional: the scheduler supplies its bounded default when absent. */
	attempts?: { max: number };
	/** Persistence may calculate this after validation; consumers never infer it from mutable fields. */
	fingerprint?: FingerprintV1;
	status: TaskStatusV1; createdAt: string; updatedAt: string;
}
export type TaskEnvelope = TaskEnvelopeV1;
export const DISPATCH_STATUSES = ["pending", "in_flight", "completed", "failed", "cancelled"] as const;
export type DispatchStatusV1 = (typeof DISPATCH_STATUSES)[number];
export interface DispatchV1 { schemaVersion: 1; dispatchId: string; taskId: string; bindingId: string; taskExecutorProviderId: string; status: DispatchStatusV1; correlationId?: string; deadlineAt?: string; maxAttempts?: number; createdAt: string; completedAt?: string; }
export type Dispatch = DispatchV1;
export interface AttemptV1 { schemaVersion: 1; attemptId: string; dispatchId: string; taskId: string; providerId: string; agentInstanceId?: string; bindingId: string; bindingEpochIds: readonly string[]; status: "starting" | "running" | "awaiting_checkpoint" | "suspended" | "succeeded" | "failed" | "cancelled"; startedAt: string; completedAt?: string; }
export type Attempt = AttemptV1;
export type AttemptProviderClassV1 = "scheduler" | "task_executor" | "agent" | "external_connector";
export interface CreateAttemptInput { attemptId: string; dispatch: DispatchV1; providerId: string; initialBindingEpoch: BindingEpochV1; providerClass: AttemptProviderClassV1; agentInstanceId?: string; now?: () => string; }
export function createAttempt(input: CreateAttemptInput): ResultValue<AttemptV1, FoundationError> {
	if (input.initialBindingEpoch.ordinal !== 0) return Result.err(new FoundationError("binding_epoch_invalid_ordinal", "Initial attempt epoch must have ordinal 0", { details: { attemptId: input.attemptId } }));
	if (input.initialBindingEpoch.attemptId !== input.attemptId || input.initialBindingEpoch.taskId !== input.dispatch.taskId || input.initialBindingEpoch.bindingId !== input.dispatch.bindingId) return Result.err(new FoundationError("binding_epoch_mismatch", "Initial attempt epoch must match its Dispatch", { details: { attemptId: input.attemptId } }));
	if (input.providerClass !== "scheduler" && input.providerClass !== "task_executor" && input.providerClass !== "agent" && input.providerClass !== "external_connector") return Result.err(new FoundationError("task_executor_invalid_provider_class", "Only task-executor provider classes may create attempts", { details: { attemptId: input.attemptId } }));
	if (input.providerClass !== "agent" && input.agentInstanceId !== undefined) return Result.err(new FoundationError("agent_instance_forbidden_for_provider", "Only agent-class executors may carry an AgentInstance", { details: { attemptId: input.attemptId } }));
	if (input.providerClass === "agent" && input.agentInstanceId === undefined) return Result.err(new FoundationError("agent_instance_required_for_agent_provider", "Agent-class providers require an AgentInstance", { details: { attemptId: input.attemptId } }));
	if (input.providerClass === "agent" && input.initialBindingEpoch.agentInstanceId !== input.agentInstanceId) return Result.err(new FoundationError("binding_epoch_mismatch", "Agent attempt must use the epoch AgentInstance", { details: { attemptId: input.attemptId } }));
	if (input.providerClass !== "agent" && input.initialBindingEpoch.agentInstanceId !== undefined) return Result.err(new FoundationError("agent_instance_forbidden_for_provider", "Non-agent attempt epochs cannot carry an AgentInstance", { details: { attemptId: input.attemptId } }));
	return Result.ok({ schemaVersion: 1, attemptId: input.attemptId, dispatchId: input.dispatch.dispatchId, taskId: input.dispatch.taskId, providerId: input.providerId, bindingId: input.initialBindingEpoch.bindingId, bindingEpochIds: [input.initialBindingEpoch.bindingEpochId], status: "starting", startedAt: (input.now ?? (() => new Date().toISOString()))(), ...(input.agentInstanceId === undefined ? {} : { agentInstanceId: input.agentInstanceId }) });
}
export interface ModeSwitchIntentV1 { schemaVersion: 1; type: "role.switch"; modeSwitchId: string; taskId: string; attemptId: string; agentInstanceId: string; /** Current binding identity retained for correlation. */ bindingId: string; /** New immutable binding activated at the safe boundary. */ newBindingId?: string; activationReason: "mode_switch"; activatedByCommandId: string; createdAt: string; }
export interface TaskEnvelopeRefV1 extends RevisionReferenceV1 { type: "task_envelope"; }
export interface SpawnAgentIntentV1 { schemaVersion: 1; type: "agent.spawn"; spawnId: string; parentTaskId: string; newTaskEnvelopeRef: TaskEnvelopeRefV1; providerId?: string; createdAt: string; }
export interface ValidateModeSwitchInput { intent: ModeSwitchIntentV1; currentEpoch?: BindingEpochV1; providerDeclaredAgent: boolean; }
export function validateModeSwitchInput(input: ValidateModeSwitchInput): ResultValue<ModeSwitchIntentV1, FoundationError> {
	if (!input.providerDeclaredAgent) return Result.err(new FoundationError("agent_instance_not_agent_provider", "Mode switch requires an agent-class provider", { details: { modeSwitchId: input.intent.modeSwitchId } }));
	if (input.currentEpoch === undefined || input.currentEpoch.attemptId !== input.intent.attemptId) return Result.err(new FoundationError("binding_epoch_mismatch", "Mode switch requires the current attempt epoch", { details: { modeSwitchId: input.intent.modeSwitchId } }));
	if (input.currentEpoch.taskId !== input.intent.taskId || input.currentEpoch.bindingId !== input.intent.bindingId) return Result.err(new FoundationError("binding_epoch_mismatch", "Mode switch must retain the current task and current binding correlation", { details: { modeSwitchId: input.intent.modeSwitchId } }));
	if (input.currentEpoch.agentInstanceId !== input.intent.agentInstanceId) return Result.err(new FoundationError("binding_epoch_mismatch", "Mode switch retains one AgentInstance", { details: { modeSwitchId: input.intent.modeSwitchId } }));
	return Result.ok(input.intent);
}
export function validateSpawnAgentIntent(intent: SpawnAgentIntentV1, options: { taskExists?: (taskId: string) => boolean } = {}): ResultValue<SpawnAgentIntentV1, FoundationError> {
	const shape = validateExactShape<SpawnAgentIntentV1>(SpawnAgentIntentV1Schema, intent, "spawn_agent_intent");
	if (!shape.ok) return shape;
	if (intent.parentTaskId === intent.newTaskEnvelopeRef.id) return Result.err(new FoundationError("role_resolver_conflict", "agent.spawn must reference a distinct child task", { details: { spawnId: intent.spawnId } }));
	if (options.taskExists && !options.taskExists(intent.newTaskEnvelopeRef.id)) return Result.err(new FoundationError("role_resolver_task_required", "Spawn references a task that has not been persisted", { details: { spawnId: intent.spawnId } }));
	return Result.ok(intent);
}

const criterionSchema = Type.Object({ schemaVersion: Type.Literal(1), criterionId: Type.String({ minLength: 1 }), description: Type.String(), satisfiedBy: Type.Union([Type.Literal("artifact"), Type.Literal("test"), Type.Literal("evidence"), Type.Literal("manual")]), required: Type.Boolean() }, { additionalProperties: false });
const budgetSchema = Type.Object({ tokens: Type.Optional(Type.Number({ minimum: 0 })), costUsd: Type.Optional(Type.Number({ minimum: 0 })), modelCalls: Type.Optional(Type.Integer({ minimum: 0 })), toolCalls: Type.Optional(Type.Integer({ minimum: 0 })), wallClockMs: Type.Optional(Type.Integer({ minimum: 0 })), concurrency: Type.Optional(Type.Integer({ minimum: 0 })) }, { additionalProperties: false });
const versionedReferenceSchema = Type.Object({ schemaVersion: Type.Literal(1), type: Type.String({ minLength: 1 }), id: Type.String({ minLength: 1 }), revision: Type.Optional(Type.Integer({ minimum: 0 })), fingerprint: Type.Optional(FingerprintV1Schema), providerId: Type.Optional(Type.String({ minLength: 1 })) }, { additionalProperties: false });
const requirementsSchema = Type.Object({ role: Type.Optional(versionedReferenceSchema), modelProfile: Type.Optional(versionedReferenceSchema), quota: Type.Optional(budgetSchema), deadlineAt: Type.Optional(Type.String({ minLength: 1 })) }, { additionalProperties: false });
const taskEnvelopeRefSchema = Type.Object(
	{
		schemaVersion: Type.Literal(1),
		type: Type.Literal("task_envelope"),
		id: Type.String({ minLength: 1 }),
		revision: Type.Integer({ minimum: 0 }),
		fingerprint: Type.Optional(FingerprintV1Schema),
		providerId: Type.Optional(Type.String({ minLength: 1 })),
	},
	{ additionalProperties: false },
);
export const SpawnAgentIntentV1Schema = Type.Object({ schemaVersion: Type.Literal(1), type: Type.Literal("agent.spawn"), spawnId: Type.String({ minLength: 1 }), parentTaskId: Type.String({ minLength: 1 }), newTaskEnvelopeRef: taskEnvelopeRefSchema, providerId: Type.Optional(Type.String({ minLength: 1 })), createdAt: Type.String({ minLength: 1 }) }, { additionalProperties: false });
export const ModeSwitchIntentV1Schema = Type.Object({ schemaVersion: Type.Literal(1), type: Type.Literal("role.switch"), modeSwitchId: Type.String({ minLength: 1 }), taskId: Type.String({ minLength: 1 }), attemptId: Type.String({ minLength: 1 }), agentInstanceId: Type.String({ minLength: 1 }), bindingId: Type.String({ minLength: 1 }), newBindingId: Type.Optional(Type.String({ minLength: 1 })), activationReason: Type.Literal("mode_switch"), activatedByCommandId: Type.String({ minLength: 1 }), createdAt: Type.String({ minLength: 1 }) }, { additionalProperties: false });
export const TaskEnvelopeV1Schema = Type.Object({ schemaVersion: Type.Literal(1), taskId: Type.String({ minLength: 1 }), goalId: Type.String({ minLength: 1 }), goal: Type.String({ minLength: 1 }), kind: Type.Optional(Type.Union([Type.Literal("run"), Type.Literal("compaction"), Type.Literal("navigation"), Type.Literal("task")])), title: Type.Optional(Type.String()), description: Type.Optional(Type.String()), workspace: Type.String({ minLength: 1 }), capabilityRefs: Type.Array(ArtifactRefV1Schema), inputs: Type.Array(ArtifactRefV1Schema), expectedOutputs: Type.Array(ArtifactRefV1Schema), payload: Type.Optional(Type.Object({ kind: Type.Union([Type.Literal("artifacts"), Type.Literal("reference")]), refs: Type.Array(ArtifactRefV1Schema) }, { additionalProperties: false })), budget: budgetSchema, acceptanceCriteria: Type.Array(criterionSchema), requirements: Type.Optional(requirementsSchema), attempts: Type.Optional(Type.Object({ max: Type.Integer({ minimum: 1 }) }, { additionalProperties: false })), fingerprint: Type.Optional(FingerprintV1Schema), status: Type.Union([Type.Literal("draft"), Type.Literal("ready"), Type.Literal("running"), Type.Literal("succeeded"), Type.Literal("failed"), Type.Literal("cancelled")]), createdAt: Type.String({ minLength: 1 }), updatedAt: Type.String({ minLength: 1 }) }, { additionalProperties: false });
export const DispatchV1Schema = Type.Object({ schemaVersion: Type.Literal(1), dispatchId: Type.String({ minLength: 1 }), taskId: Type.String({ minLength: 1 }), bindingId: Type.String({ minLength: 1 }), taskExecutorProviderId: Type.String({ minLength: 1 }), status: Type.Union(DISPATCH_STATUSES.map((status) => Type.Literal(status))), correlationId: Type.Optional(Type.String({ minLength: 1 })), deadlineAt: Type.Optional(Type.String({ minLength: 1 })), maxAttempts: Type.Optional(Type.Integer({ minimum: 1 })), createdAt: Type.String({ minLength: 1 }), completedAt: Type.Optional(Type.String({ minLength: 1 })) }, { additionalProperties: false });
export const AttemptV1Schema = Type.Object({ schemaVersion: Type.Literal(1), attemptId: Type.String({ minLength: 1 }), dispatchId: Type.String({ minLength: 1 }), taskId: Type.String({ minLength: 1 }), providerId: Type.String({ minLength: 1 }), agentInstanceId: Type.Optional(Type.String({ minLength: 1 })), bindingId: Type.String({ minLength: 1 }), bindingEpochIds: Type.Array(Type.String({ minLength: 1 })), status: Type.Union([Type.Literal("starting"), Type.Literal("running"), Type.Literal("awaiting_checkpoint"), Type.Literal("suspended"), Type.Literal("succeeded"), Type.Literal("failed"), Type.Literal("cancelled")]), startedAt: Type.String({ minLength: 1 }), completedAt: Type.Optional(Type.String({ minLength: 1 })) }, { additionalProperties: false });
export function createTaskEnvelopeV1(input: Omit<TaskEnvelopeV1, "fingerprint">): ResultValue<TaskEnvelopeV1, FoundationError> {
	const base = { ...input };
	const checked = validateExactShape<TaskEnvelopeV1>(TaskEnvelopeV1Schema, { ...base, fingerprint: fingerprintFoundationValue(base) }, "task_envelope");
	return checked.ok ? Result.ok(cloneDeepFrozen(checked.value)) : checked;
}
export function validateTaskEnvelope(value: unknown): ResultValue<TaskEnvelopeV1, FoundationError> { return validateExactShape<TaskEnvelopeV1>(TaskEnvelopeV1Schema, value, "task_envelope"); }
export function serializeTaskEnvelope(value: TaskEnvelopeV1): string { return serializeExactShape(TaskEnvelopeV1Schema, value, "task_envelope"); }
export function parseTaskEnvelope(text: string): ResultValue<TaskEnvelopeV1, FoundationError> { return parseExactShape(TaskEnvelopeV1Schema, text, "task_envelope"); }
export function validateDispatch(value: unknown): ResultValue<DispatchV1, FoundationError> { return validateExactShape<DispatchV1>(DispatchV1Schema, value, "dispatch"); }
export function serializeDispatch(value: DispatchV1): string { return serializeExactShape(DispatchV1Schema, value, "dispatch"); }
export function parseDispatch(text: string): ResultValue<DispatchV1, FoundationError> { return parseExactShape(DispatchV1Schema, text, "dispatch"); }
export function validateAttempt(value: unknown): ResultValue<AttemptV1, FoundationError> { return validateExactShape<AttemptV1>(AttemptV1Schema, value, "attempt"); }
export function validateModeSwitchIntentV1(value: unknown): ResultValue<ModeSwitchIntentV1, FoundationError> { return validateExactShape<ModeSwitchIntentV1>(ModeSwitchIntentV1Schema, value, "mode_switch_intent"); }
export const validateTaskEnvelopeV1 = validateTaskEnvelope;
export const validateDispatchV1 = validateDispatch;
export const validateAttemptV1 = validateAttempt;
export const createTaskEnvelope = createTaskEnvelopeV1;
export function serializeAttempt(value: AttemptV1): string { return serializeExactShape(AttemptV1Schema, value, "attempt"); }
export function parseAttempt(text: string): ResultValue<AttemptV1, FoundationError> { return parseExactShape(AttemptV1Schema, text, "attempt"); }

export interface TaskArtifactProjectionV1 { schemaVersion: 1; artifactId: string; mediaType: string; digest: string; }
export interface TaskWorkspaceProjectionV1 { schemaVersion: 1; workspaceDigest: FingerprintV1; }
export interface TaskEnvelopePublicProjectionV1 { schemaVersion: 1; taskId: string; goalId: string; goalDigest: FingerprintV1; workspaceDigest: FingerprintV1; capabilityRefs: readonly TaskArtifactProjectionV1[]; inputs: readonly TaskArtifactProjectionV1[]; expectedOutputs: readonly TaskArtifactProjectionV1[]; acceptanceCriterionIds: readonly string[]; status: TaskStatusV1; fingerprint?: FingerprintV1; }
const taskArtifactProjectionSchema = Type.Object({ schemaVersion: Type.Literal(1), artifactId: Type.String({ minLength: 1 }), mediaType: Type.String({ minLength: 1 }), digest: Type.String({ minLength: 1 }) }, { additionalProperties: false });
export const TaskWorkspaceProjectionV1Schema = Type.Object({ schemaVersion: Type.Literal(1), workspaceDigest: FingerprintV1Schema }, { additionalProperties: false });
export const TaskEnvelopePublicProjectionV1Schema = Type.Object({ schemaVersion: Type.Literal(1), taskId: Type.String({ minLength: 1 }), goalId: Type.String({ minLength: 1 }), goalDigest: FingerprintV1Schema, workspaceDigest: FingerprintV1Schema, capabilityRefs: Type.Array(taskArtifactProjectionSchema), inputs: Type.Array(taskArtifactProjectionSchema), expectedOutputs: Type.Array(taskArtifactProjectionSchema), acceptanceCriterionIds: Type.Array(Type.String({ minLength: 1 })), status: Type.Union([Type.Literal("draft"), Type.Literal("ready"), Type.Literal("running"), Type.Literal("succeeded"), Type.Literal("failed"), Type.Literal("cancelled")]), fingerprint: Type.Optional(FingerprintV1Schema) }, { additionalProperties: false });
function projectTaskArtifact(artifact: ArtifactRefV1): TaskArtifactProjectionV1 { return { schemaVersion: 1, artifactId: artifact.artifactId, mediaType: artifact.mediaType, digest: artifact.digest }; }
export function projectWorkspaceV1(workspace: string): TaskWorkspaceProjectionV1 { return { schemaVersion: 1, workspaceDigest: fingerprintFoundationValue(workspace) }; }
export function projectTaskEnvelopeV1(task: TaskEnvelopeV1): TaskEnvelopePublicProjectionV1 { return { schemaVersion: 1, taskId: task.taskId, goalId: task.goalId, goalDigest: fingerprintFoundationValue(task.goal), workspaceDigest: fingerprintFoundationValue(task.workspace), capabilityRefs: task.capabilityRefs.map(projectTaskArtifact), inputs: task.inputs.map(projectTaskArtifact), expectedOutputs: task.expectedOutputs.map(projectTaskArtifact), acceptanceCriterionIds: task.acceptanceCriteria.map((criterion) => criterion.criterionId), status: task.status, ...(task.fingerprint === undefined ? {} : { fingerprint: task.fingerprint }) }; }
export function validateTaskWorkspaceProjectionV1(value: unknown): ResultValue<TaskWorkspaceProjectionV1, FoundationError> { return validateExactShape<TaskWorkspaceProjectionV1>(TaskWorkspaceProjectionV1Schema, value, "task_workspace_projection"); }
export function serializeTaskWorkspaceProjectionV1(value: TaskWorkspaceProjectionV1): string { return serializeExactShape(TaskWorkspaceProjectionV1Schema, value, "task_workspace_projection"); }
export function parseTaskWorkspaceProjectionV1(text: string): ResultValue<TaskWorkspaceProjectionV1, FoundationError> { return parseExactShape(TaskWorkspaceProjectionV1Schema, text, "task_workspace_projection"); }
export function validateTaskEnvelopePublicProjectionV1(value: unknown): ResultValue<TaskEnvelopePublicProjectionV1, FoundationError> { return validateExactShape<TaskEnvelopePublicProjectionV1>(TaskEnvelopePublicProjectionV1Schema, value, "task_envelope_public_projection"); }
export function serializeTaskEnvelopePublicProjectionV1(value: TaskEnvelopePublicProjectionV1): string { return serializeExactShape(TaskEnvelopePublicProjectionV1Schema, value, "task_envelope_public_projection"); }
export function parseTaskEnvelopePublicProjectionV1(text: string): ResultValue<TaskEnvelopePublicProjectionV1, FoundationError> { return parseExactShape(TaskEnvelopePublicProjectionV1Schema, text, "task_envelope_public_projection"); }
