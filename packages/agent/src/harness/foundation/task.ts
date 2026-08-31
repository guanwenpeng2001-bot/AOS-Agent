import { Result, type ResultValue } from "../result.ts";
import { Type } from "typebox";
import type { AcceptanceCriterion } from "./goal.ts";
import type { Budget } from "./budget.ts";
import { FoundationError } from "./errors.ts";
import { PROVIDER_CLASS } from "./providers.ts";
import { fingerprintFoundationValue, type Fingerprint } from "./identity.ts";
import { cloneDeepFrozen } from "./immutability.ts";
import { FingerprintSchema } from "./schema.ts";
import { ArtifactRefSchema, type ArtifactRef, type RevisionReference, type VersionedReference } from "./reference.ts";
import type { BindingEpoch } from "./role.ts";
import { parseExactShape, serializeExactShape, validateExactShape } from "./schema.ts";

export type TaskStatus = "draft" | "ready" | "running" | "succeeded" | "failed" | "cancelled";
export const TASK_ENVELOPE_KINDS = ["run", "compaction", "navigation", "task"] as const;
export type TaskEnvelopeKind = (typeof TASK_ENVELOPE_KINDS)[number];

/**
 * Optional execution constraints are explicit references, not untyped extension bags. A task may
 * omit this object when the Resolver is free to choose the role/model/quota, but a supplied value
 * is always consumable by a provider without reaching into implementation-specific settings.
 */
export interface TaskRequirements {
	role?: VersionedReference;
	modelProfile?: VersionedReference;
	quota?: Budget;
	deadlineAt?: string;
}

export interface TaskEnvelope {
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
	capabilityRefs: readonly ArtifactRef[];
	/** Deterministic input artifacts; an empty list means the task has no artifact inputs. */
	inputs: readonly ArtifactRef[];
	/** Deterministic output contract; an empty list means no artifact is prescribed. */
	expectedOutputs: readonly ArtifactRef[];
	/** Legacy transport packaging is optional because `inputs`/`expectedOutputs` are canonical. */
	payload?: { kind: "artifacts" | "reference"; refs: readonly ArtifactRef[] };
	budget: Budget;
	acceptanceCriteria: readonly AcceptanceCriterion[];
	requirements?: TaskRequirements;
	/** Retry policy is optional: the scheduler supplies its bounded default when absent. */
	attempts?: { max: number };
	/** Persistence may calculate this after validation; consumers never infer it from mutable fields. */
	fingerprint?: Fingerprint;
	status: TaskStatus; createdAt: string; updatedAt: string;
}
export const DISPATCH_STATUSES = ["pending", "in_flight", "completed", "failed", "cancelled"] as const;
export type DispatchStatus = (typeof DISPATCH_STATUSES)[number];
export interface Dispatch { schemaVersion: 1; dispatchId: string; taskId: string; bindingId: string; taskExecutorProviderId: string; status: DispatchStatus; correlationId?: string; deadlineAt?: string; maxAttempts?: number; createdAt: string; completedAt?: string; }
export interface Attempt { schemaVersion: 1; attemptId: string; dispatchId: string; taskId: string; providerId: string; agentInstanceId?: string; bindingId: string; bindingEpochIds: readonly string[]; status: "starting" | "running" | "awaiting_checkpoint" | "suspended" | "succeeded" | "failed" | "cancelled"; startedAt: string; completedAt?: string; }
export type AttemptProviderClass = "scheduler" | "task_executor" | "agent" | "external_connector";
export interface CreateAttemptInput { attemptId: string; dispatch: Dispatch; providerId: string; initialBindingEpoch: BindingEpoch; providerClass: AttemptProviderClass; agentInstanceId?: string; now?: () => string; }
export function createAttempt(input: CreateAttemptInput): ResultValue<Attempt, FoundationError> {
	if (input.initialBindingEpoch.ordinal !== 0) return Result.err(new FoundationError("binding_epoch_invalid_ordinal", "Initial attempt epoch must have ordinal 0", { details: { attemptId: input.attemptId } }));
	if (input.initialBindingEpoch.attemptId !== input.attemptId || input.initialBindingEpoch.taskId !== input.dispatch.taskId || input.initialBindingEpoch.bindingId !== input.dispatch.bindingId) return Result.err(new FoundationError("binding_epoch_mismatch", "Initial attempt epoch must match its Dispatch", { details: { attemptId: input.attemptId } }));
	if (input.providerClass !== "scheduler" && input.providerClass !== "task_executor" && input.providerClass !== "agent" && input.providerClass !== PROVIDER_CLASS.externalConnector) return Result.err(new FoundationError("task_executor_invalid_provider_class", "Only task-executor provider classes may create attempts", { details: { attemptId: input.attemptId } }));
	if (input.providerClass !== "agent" && input.agentInstanceId !== undefined) return Result.err(new FoundationError("agent_instance_forbidden_for_provider", "Only agent-class executors may carry an AgentInstance", { details: { attemptId: input.attemptId } }));
	if (input.providerClass === "agent" && input.agentInstanceId === undefined) return Result.err(new FoundationError("agent_instance_required_for_agent_provider", "Agent-class providers require an AgentInstance", { details: { attemptId: input.attemptId } }));
	if (input.providerClass === "agent" && input.initialBindingEpoch.agentInstanceId !== input.agentInstanceId) return Result.err(new FoundationError("binding_epoch_mismatch", "Agent attempt must use the epoch AgentInstance", { details: { attemptId: input.attemptId } }));
	if (input.providerClass !== "agent" && input.initialBindingEpoch.agentInstanceId !== undefined) return Result.err(new FoundationError("agent_instance_forbidden_for_provider", "Non-agent attempt epochs cannot carry an AgentInstance", { details: { attemptId: input.attemptId } }));
	return Result.ok({ schemaVersion: 1, attemptId: input.attemptId, dispatchId: input.dispatch.dispatchId, taskId: input.dispatch.taskId, providerId: input.providerId, bindingId: input.initialBindingEpoch.bindingId, bindingEpochIds: [input.initialBindingEpoch.bindingEpochId], status: "starting", startedAt: (input.now ?? (() => new Date().toISOString()))(), ...(input.agentInstanceId === undefined ? {} : { agentInstanceId: input.agentInstanceId }) });
}
export interface ModeSwitchIntent { schemaVersion: 1; type: "role.switch"; modeSwitchId: string; taskId: string; attemptId: string; agentInstanceId: string; /** Current binding identity retained for correlation. */ bindingId: string; /** New immutable binding activated at the safe boundary. */ newBindingId?: string; activationReason: "mode_switch"; activatedByCommandId: string; createdAt: string; }
export interface TaskEnvelopeRef extends RevisionReference { type: "task_envelope"; }
export interface SpawnAgentIntent { schemaVersion: 1; type: "agent.spawn"; spawnId: string; parentTaskId: string; newTaskEnvelopeRef: TaskEnvelopeRef; providerId?: string; createdAt: string; }
export interface ValidateModeSwitchInput { intent: ModeSwitchIntent; currentEpoch?: BindingEpoch; providerDeclaredAgent: boolean; }
export function validateModeSwitchInput(input: ValidateModeSwitchInput): ResultValue<ModeSwitchIntent, FoundationError> {
	if (!input.providerDeclaredAgent) return Result.err(new FoundationError("agent_instance_not_agent_provider", "Mode switch requires an agent-class provider", { details: { modeSwitchId: input.intent.modeSwitchId } }));
	if (input.currentEpoch === undefined || input.currentEpoch.attemptId !== input.intent.attemptId) return Result.err(new FoundationError("binding_epoch_mismatch", "Mode switch requires the current attempt epoch", { details: { modeSwitchId: input.intent.modeSwitchId } }));
	if (input.currentEpoch.taskId !== input.intent.taskId || input.currentEpoch.bindingId !== input.intent.bindingId) return Result.err(new FoundationError("binding_epoch_mismatch", "Mode switch must retain the current task and current binding correlation", { details: { modeSwitchId: input.intent.modeSwitchId } }));
	if (input.currentEpoch.agentInstanceId !== input.intent.agentInstanceId) return Result.err(new FoundationError("binding_epoch_mismatch", "Mode switch retains one AgentInstance", { details: { modeSwitchId: input.intent.modeSwitchId } }));
	return Result.ok(input.intent);
}
export function validateSpawnAgentIntent(intent: SpawnAgentIntent, options: { taskExists?: (taskId: string) => boolean } = {}): ResultValue<SpawnAgentIntent, FoundationError> {
	const shape = validateExactShape<SpawnAgentIntent>(SpawnAgentIntentSchema, intent, "spawn_agent_intent");
	if (!shape.ok) return shape;
	if (intent.parentTaskId === intent.newTaskEnvelopeRef.id) return Result.err(new FoundationError("role_resolver_conflict", "agent.spawn must reference a distinct child task", { details: { spawnId: intent.spawnId } }));
	if (options.taskExists && !options.taskExists(intent.newTaskEnvelopeRef.id)) return Result.err(new FoundationError("role_resolver_task_required", "Spawn references a task that has not been persisted", { details: { spawnId: intent.spawnId } }));
	return Result.ok(intent);
}

const criterionSchema = Type.Object({ schemaVersion: Type.Literal(1), criterionId: Type.String({ minLength: 1 }), description: Type.String(), satisfiedBy: Type.Union([Type.Literal("artifact"), Type.Literal("test"), Type.Literal("evidence"), Type.Literal("manual")]), required: Type.Boolean() }, { additionalProperties: false });
const budgetSchema = Type.Object({ tokens: Type.Optional(Type.Number({ minimum: 0 })), costUsd: Type.Optional(Type.Number({ minimum: 0 })), modelCalls: Type.Optional(Type.Integer({ minimum: 0 })), toolCalls: Type.Optional(Type.Integer({ minimum: 0 })), wallClockMs: Type.Optional(Type.Integer({ minimum: 0 })), concurrency: Type.Optional(Type.Integer({ minimum: 0 })) }, { additionalProperties: false });
const versionedReferenceSchema = Type.Object({ schemaVersion: Type.Literal(1), type: Type.String({ minLength: 1 }), id: Type.String({ minLength: 1 }), revision: Type.Optional(Type.Integer({ minimum: 0 })), fingerprint: Type.Optional(FingerprintSchema), providerId: Type.Optional(Type.String({ minLength: 1 })) }, { additionalProperties: false });
const requirementsSchema = Type.Object({ role: Type.Optional(versionedReferenceSchema), modelProfile: Type.Optional(versionedReferenceSchema), quota: Type.Optional(budgetSchema), deadlineAt: Type.Optional(Type.String({ minLength: 1 })) }, { additionalProperties: false });
const taskEnvelopeRefSchema = Type.Object(
	{
		schemaVersion: Type.Literal(1),
		type: Type.Literal("task_envelope"),
		id: Type.String({ minLength: 1 }),
		revision: Type.Integer({ minimum: 0 }),
		fingerprint: Type.Optional(FingerprintSchema),
		providerId: Type.Optional(Type.String({ minLength: 1 })),
	},
	{ additionalProperties: false },
);
export const SpawnAgentIntentSchema = Type.Object({ schemaVersion: Type.Literal(1), type: Type.Literal("agent.spawn"), spawnId: Type.String({ minLength: 1 }), parentTaskId: Type.String({ minLength: 1 }), newTaskEnvelopeRef: taskEnvelopeRefSchema, providerId: Type.Optional(Type.String({ minLength: 1 })), createdAt: Type.String({ minLength: 1 }) }, { additionalProperties: false });
export const ModeSwitchIntentSchema = Type.Object({ schemaVersion: Type.Literal(1), type: Type.Literal("role.switch"), modeSwitchId: Type.String({ minLength: 1 }), taskId: Type.String({ minLength: 1 }), attemptId: Type.String({ minLength: 1 }), agentInstanceId: Type.String({ minLength: 1 }), bindingId: Type.String({ minLength: 1 }), newBindingId: Type.Optional(Type.String({ minLength: 1 })), activationReason: Type.Literal("mode_switch"), activatedByCommandId: Type.String({ minLength: 1 }), createdAt: Type.String({ minLength: 1 }) }, { additionalProperties: false });
export const TaskEnvelopeSchema = Type.Object({ schemaVersion: Type.Literal(1), taskId: Type.String({ minLength: 1 }), goalId: Type.String({ minLength: 1 }), goal: Type.String({ minLength: 1 }), kind: Type.Optional(Type.Union([Type.Literal("run"), Type.Literal("compaction"), Type.Literal("navigation"), Type.Literal("task")])), title: Type.Optional(Type.String()), description: Type.Optional(Type.String()), workspace: Type.String({ minLength: 1 }), capabilityRefs: Type.Array(ArtifactRefSchema), inputs: Type.Array(ArtifactRefSchema), expectedOutputs: Type.Array(ArtifactRefSchema), payload: Type.Optional(Type.Object({ kind: Type.Union([Type.Literal("artifacts"), Type.Literal("reference")]), refs: Type.Array(ArtifactRefSchema) }, { additionalProperties: false })), budget: budgetSchema, acceptanceCriteria: Type.Array(criterionSchema), requirements: Type.Optional(requirementsSchema), attempts: Type.Optional(Type.Object({ max: Type.Integer({ minimum: 1 }) }, { additionalProperties: false })), fingerprint: Type.Optional(FingerprintSchema), status: Type.Union([Type.Literal("draft"), Type.Literal("ready"), Type.Literal("running"), Type.Literal("succeeded"), Type.Literal("failed"), Type.Literal("cancelled")]), createdAt: Type.String({ minLength: 1 }), updatedAt: Type.String({ minLength: 1 }) }, { additionalProperties: false });
export const DispatchSchema = Type.Object({ schemaVersion: Type.Literal(1), dispatchId: Type.String({ minLength: 1 }), taskId: Type.String({ minLength: 1 }), bindingId: Type.String({ minLength: 1 }), taskExecutorProviderId: Type.String({ minLength: 1 }), status: Type.Union(DISPATCH_STATUSES.map((status) => Type.Literal(status))), correlationId: Type.Optional(Type.String({ minLength: 1 })), deadlineAt: Type.Optional(Type.String({ minLength: 1 })), maxAttempts: Type.Optional(Type.Integer({ minimum: 1 })), createdAt: Type.String({ minLength: 1 }), completedAt: Type.Optional(Type.String({ minLength: 1 })) }, { additionalProperties: false });
export const AttemptSchema = Type.Object({ schemaVersion: Type.Literal(1), attemptId: Type.String({ minLength: 1 }), dispatchId: Type.String({ minLength: 1 }), taskId: Type.String({ minLength: 1 }), providerId: Type.String({ minLength: 1 }), agentInstanceId: Type.Optional(Type.String({ minLength: 1 })), bindingId: Type.String({ minLength: 1 }), bindingEpochIds: Type.Array(Type.String({ minLength: 1 })), status: Type.Union([Type.Literal("starting"), Type.Literal("running"), Type.Literal("awaiting_checkpoint"), Type.Literal("suspended"), Type.Literal("succeeded"), Type.Literal("failed"), Type.Literal("cancelled")]), startedAt: Type.String({ minLength: 1 }), completedAt: Type.Optional(Type.String({ minLength: 1 })) }, { additionalProperties: false });
export function createTaskEnvelope(input: Omit<TaskEnvelope, "fingerprint">): ResultValue<TaskEnvelope, FoundationError> {
	const base = { ...input };
	const checked = validateExactShape<TaskEnvelope>(TaskEnvelopeSchema, { ...base, fingerprint: fingerprintFoundationValue(base) }, "task_envelope");
	return checked.ok ? Result.ok(cloneDeepFrozen(checked.value)) : checked;
}
export function validateTaskEnvelope(value: unknown): ResultValue<TaskEnvelope, FoundationError> { return validateExactShape<TaskEnvelope>(TaskEnvelopeSchema, value, "task_envelope"); }
export function serializeTaskEnvelope(value: TaskEnvelope): string { return serializeExactShape(TaskEnvelopeSchema, value, "task_envelope"); }
export function parseTaskEnvelope(text: string): ResultValue<TaskEnvelope, FoundationError> { return parseExactShape(TaskEnvelopeSchema, text, "task_envelope"); }
export function validateDispatch(value: unknown): ResultValue<Dispatch, FoundationError> { return validateExactShape<Dispatch>(DispatchSchema, value, "dispatch"); }
export function serializeDispatch(value: Dispatch): string { return serializeExactShape(DispatchSchema, value, "dispatch"); }
export function parseDispatch(text: string): ResultValue<Dispatch, FoundationError> { return parseExactShape(DispatchSchema, text, "dispatch"); }
export function validateAttempt(value: unknown): ResultValue<Attempt, FoundationError> { return validateExactShape<Attempt>(AttemptSchema, value, "attempt"); }
export function validateModeSwitchIntent(value: unknown): ResultValue<ModeSwitchIntent, FoundationError> { return validateExactShape<ModeSwitchIntent>(ModeSwitchIntentSchema, value, "mode_switch_intent"); }
export function serializeAttempt(value: Attempt): string { return serializeExactShape(AttemptSchema, value, "attempt"); }
export function parseAttempt(text: string): ResultValue<Attempt, FoundationError> { return parseExactShape(AttemptSchema, text, "attempt"); }

export interface TaskArtifactProjection { schemaVersion: 1; artifactId: string; mediaType: string; digest: string; }
export interface TaskWorkspaceProjection { schemaVersion: 1; workspaceDigest: Fingerprint; }
export interface TaskEnvelopePublicProjection { schemaVersion: 1; taskId: string; goalId: string; goalDigest: Fingerprint; workspaceDigest: Fingerprint; capabilityRefs: readonly TaskArtifactProjection[]; inputs: readonly TaskArtifactProjection[]; expectedOutputs: readonly TaskArtifactProjection[]; acceptanceCriterionIds: readonly string[]; status: TaskStatus; fingerprint?: Fingerprint; }
const taskArtifactProjectionSchema = Type.Object({ schemaVersion: Type.Literal(1), artifactId: Type.String({ minLength: 1 }), mediaType: Type.String({ minLength: 1 }), digest: Type.String({ minLength: 1 }) }, { additionalProperties: false });
export const TaskWorkspaceProjectionSchema = Type.Object({ schemaVersion: Type.Literal(1), workspaceDigest: FingerprintSchema }, { additionalProperties: false });
export const TaskEnvelopePublicProjectionSchema = Type.Object({ schemaVersion: Type.Literal(1), taskId: Type.String({ minLength: 1 }), goalId: Type.String({ minLength: 1 }), goalDigest: FingerprintSchema, workspaceDigest: FingerprintSchema, capabilityRefs: Type.Array(taskArtifactProjectionSchema), inputs: Type.Array(taskArtifactProjectionSchema), expectedOutputs: Type.Array(taskArtifactProjectionSchema), acceptanceCriterionIds: Type.Array(Type.String({ minLength: 1 })), status: Type.Union([Type.Literal("draft"), Type.Literal("ready"), Type.Literal("running"), Type.Literal("succeeded"), Type.Literal("failed"), Type.Literal("cancelled")]), fingerprint: Type.Optional(FingerprintSchema) }, { additionalProperties: false });
function projectTaskArtifact(artifact: ArtifactRef): TaskArtifactProjection { return { schemaVersion: 1, artifactId: artifact.artifactId, mediaType: artifact.mediaType, digest: artifact.digest }; }
export function projectWorkspace(workspace: string): TaskWorkspaceProjection { return { schemaVersion: 1, workspaceDigest: fingerprintFoundationValue(workspace) }; }
export function projectTaskEnvelope(task: TaskEnvelope): TaskEnvelopePublicProjection { return { schemaVersion: 1, taskId: task.taskId, goalId: task.goalId, goalDigest: fingerprintFoundationValue(task.goal), workspaceDigest: fingerprintFoundationValue(task.workspace), capabilityRefs: task.capabilityRefs.map(projectTaskArtifact), inputs: task.inputs.map(projectTaskArtifact), expectedOutputs: task.expectedOutputs.map(projectTaskArtifact), acceptanceCriterionIds: task.acceptanceCriteria.map((criterion) => criterion.criterionId), status: task.status, ...(task.fingerprint === undefined ? {} : { fingerprint: task.fingerprint }) }; }
export function validateTaskWorkspaceProjection(value: unknown): ResultValue<TaskWorkspaceProjection, FoundationError> { return validateExactShape<TaskWorkspaceProjection>(TaskWorkspaceProjectionSchema, value, "task_workspace_projection"); }
export function serializeTaskWorkspaceProjection(value: TaskWorkspaceProjection): string { return serializeExactShape(TaskWorkspaceProjectionSchema, value, "task_workspace_projection"); }
export function parseTaskWorkspaceProjection(text: string): ResultValue<TaskWorkspaceProjection, FoundationError> { return parseExactShape(TaskWorkspaceProjectionSchema, text, "task_workspace_projection"); }
export function validateTaskEnvelopePublicProjection(value: unknown): ResultValue<TaskEnvelopePublicProjection, FoundationError> { return validateExactShape<TaskEnvelopePublicProjection>(TaskEnvelopePublicProjectionSchema, value, "task_envelope_public_projection"); }
export function serializeTaskEnvelopePublicProjection(value: TaskEnvelopePublicProjection): string { return serializeExactShape(TaskEnvelopePublicProjectionSchema, value, "task_envelope_public_projection"); }
export function parseTaskEnvelopePublicProjection(text: string): ResultValue<TaskEnvelopePublicProjection, FoundationError> { return parseExactShape(TaskEnvelopePublicProjectionSchema, text, "task_envelope_public_projection"); }
