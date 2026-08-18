import { Result, type Result as ResultValue } from "../result.ts";
import { Type } from "typebox";
import type { BudgetV1 } from "./budget.ts";
import { FoundationError } from "./errors.ts";
import { CapabilitySelectorV1Schema, ResourceSelectorV1Schema, RevisionReferenceV1Schema, VersionedReferenceV1Schema, type CapabilitySelectorV1, type ResourceSelectorV1, type RevisionReferenceV1, type VersionedReferenceV1 } from "./reference.ts";
import { LineageV1Schema, parseExactShape, serializeExactShape, validateExactShape } from "./schema.ts";
import { FOUNDATION_SCHEMA_VERSION, canonicalFoundationJson, type FingerprintV1, fingerprintFoundationValue, type FoundationLineageV1 } from "./identity.ts";
import type { TaskEnvelopeV1 } from "./task.ts";

export type RoleScopeV1 = "global" | "project";
export interface RoleRef { roleId: string; roleVersion: string; scope?: string; }
export interface RoleDefinitionV1 {
	schemaVersion: 1; roleId: string; scope: RoleScopeV1; slug: string; name: string; description: string; whenToUse?: string;
	revision: number; persona: string; customInstructions?: string; modelProfileRef: VersionedReferenceV1;
	capabilitySelector: CapabilitySelectorV1; skillSelector: ResourceSelectorV1; mcpSelector: ResourceSelectorV1;
	contextPolicyRef?: VersionedReferenceV1; memoryPolicyRef?: VersionedReferenceV1; executionPolicyRef?: VersionedReferenceV1; resultPolicyRef?: VersionedReferenceV1; overridesRoleId?: string;
}
export interface RoleRevisionV1 {
	readonly schemaVersion: 1; readonly roleRevisionId: string; readonly roleId: string; readonly scope: RoleScopeV1; readonly revision: number; readonly slug: string; readonly name: string; readonly description: string; readonly whenToUse?: string;
	readonly persona: string; readonly customInstructions?: string; readonly modelProfileRef: VersionedReferenceV1; readonly capabilitySelector: CapabilitySelectorV1; readonly skillSelector: ResourceSelectorV1; readonly mcpSelector: ResourceSelectorV1;
	readonly contextPolicyRef?: VersionedReferenceV1; readonly memoryPolicyRef?: VersionedReferenceV1; readonly executionPolicyRef?: VersionedReferenceV1; readonly resultPolicyRef?: VersionedReferenceV1; readonly overridesRoleId?: string;
	readonly fingerprint: FingerprintV1; readonly createdAt: string; readonly previousRoleRevisionId?: string;
}

export interface ModelProfileV1 {
	readonly schemaVersion: 1; readonly modelProfileId: string; readonly name?: string; readonly provider: string; readonly model: string; readonly effort?: string; readonly serviceTier?: string;
	readonly fallback?: readonly { readonly provider: string; readonly model: string }[]; readonly budget: BudgetV1; readonly revision: number; readonly createdAt: string; readonly fingerprint: FingerprintV1;
}
export type ModelProfile = ModelProfileV1;
/** Resolved route metadata frozen into an AgentBinding; credentials never enter this value. */
export interface ModelRouteV1 { provider: string; model: string; effort?: string; serviceTier?: string; }
/** Independent immutable ModelProfile revision constructor. */
export function createModelProfileRevision(input: Omit<ModelProfileV1, "fingerprint">): ModelProfileV1 {
	const snapshot = { ...input, budget: { ...input.budget }, ...(input.fallback === undefined ? {} : { fallback: input.fallback.map((route) => ({ ...route })) }) };
	return deepFreeze({ ...snapshot, fingerprint: fingerprintFoundationValue(snapshot) });
}
export interface BindingSourceTraceV1 { field: string; layer: "managed_lock" | "global" | "project" | "path" | "goal" | "task" | "run"; referenceId: string; revision?: number; overrideReason?: string; }
export type SourceTraceV1 = BindingSourceTraceV1;
export interface BindingConflictV1 { field: string; source: BindingSourceTraceV1; conflictsWith: BindingSourceTraceV1; }
export interface AgentBindingV1 {
	schemaVersion: 1; bindingId: string; taskId: string; goalId?: string;
	/** All four runtime binding facts are immutable references; none has a synthetic fallback. */
	roleRevision: RevisionReferenceV1; modelProfileRevision: RevisionReferenceV1; modelRoute: ModelRouteV1;
	/** External-Agent Binding is retained under the historical contextRevision field for wire stability. */
	contextRevision: RevisionReferenceV1;
	capabilityRevision: RevisionReferenceV1;
	modelBrokerBindingRevision: RevisionReferenceV1;
	policyRevision: RevisionReferenceV1;
	capabilitySelector: CapabilitySelectorV1; budget: BudgetV1; sourceTrace: readonly BindingSourceTraceV1[]; conflicts: readonly BindingConflictV1[]; fingerprint: FingerprintV1; resolvedAt: string;
}
export type AgentBinding = AgentBindingV1;
export type BindingEpochActivationReasonV1 = "attempt_started" | "mode_switch" | "policy_rebind";
export const BINDING_EPOCH_ACTIVATION_REASONS = ["attempt_started", "mode_switch", "policy_rebind"] as const;
export interface BindingEpochV1 {
	schemaVersion: 1; bindingEpochId: string; taskId: string; attemptId: string; agentInstanceId?: string; bindingId: string; ordinal: number; previousBindingEpochId?: string; activationReason: BindingEpochActivationReasonV1; activatedByCommandId: string; activatedAt: string;
}
export type BindingEpoch = BindingEpochV1;
export type AgentInstanceStatusV1 = "starting" | "active" | "suspended" | "stopped";
export const AGENT_INSTANCE_STATUSES = ["starting", "active", "suspended", "stopped"] as const;
export interface AgentInstanceV1 {
	schemaVersion: 1; agentInstanceId: string; providerId: string; taskId: string; roleRevision: VersionedReferenceV1; bindingEpochIds: readonly string[]; status: AgentInstanceStatusV1; lineage: FoundationLineageV1; createdAt: string; updatedAt: string;
}
export type AgentInstance = AgentInstanceV1;

export interface CreateRoleRevisionInput { definition: RoleDefinitionV1; previous?: RoleRevisionV1; now?: () => string; }
function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
	if (value !== null && typeof value === "object") {
		if (seen.has(value)) return value;
		seen.add(value);
		for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child, seen);
		Object.freeze(value);
	}
	return value;
}
export function createRoleRevision(input: CreateRoleRevisionInput): RoleRevisionV1 {
	const previous = input.previous; const revision = previous === undefined ? 1 : previous.revision + 1;
	const snapshot: Omit<RoleRevisionV1, "fingerprint"> = {
		schemaVersion: FOUNDATION_SCHEMA_VERSION, roleRevisionId: `role_revision_${input.definition.roleId}_${revision}`, roleId: input.definition.roleId, revision, slug: input.definition.slug,
		scope: input.definition.scope,
		name: input.definition.name, description: input.definition.description,
		...(input.definition.whenToUse === undefined ? {} : { whenToUse: input.definition.whenToUse }), persona: input.definition.persona,
		...(input.definition.customInstructions === undefined ? {} : { customInstructions: input.definition.customInstructions }), modelProfileRef: { ...input.definition.modelProfileRef },
		capabilitySelector: { ...input.definition.capabilitySelector }, skillSelector: { ...input.definition.skillSelector }, mcpSelector: { ...input.definition.mcpSelector }, ...(input.definition.contextPolicyRef === undefined ? {} : { contextPolicyRef: { ...input.definition.contextPolicyRef } }),
		...(input.definition.memoryPolicyRef === undefined ? {} : { memoryPolicyRef: { ...input.definition.memoryPolicyRef } }), ...(input.definition.executionPolicyRef === undefined ? {} : { executionPolicyRef: { ...input.definition.executionPolicyRef } }),
		...(input.definition.resultPolicyRef === undefined ? {} : { resultPolicyRef: { ...input.definition.resultPolicyRef } }), ...(input.definition.overridesRoleId === undefined ? {} : { overridesRoleId: input.definition.overridesRoleId }),
		...(previous === undefined ? {} : { previousRoleRevisionId: previous.roleRevisionId }), createdAt: (input.now ?? (() => new Date().toISOString()))(),
	};
	return deepFreeze({ ...snapshot, fingerprint: fingerprintFoundationValue(snapshot) });
}

export interface ResolveAgentBindingInput {
	task: TaskEnvelopeV1;
	roleRevision: RoleRevisionV1;
	modelProfile: ModelProfileV1;
	modelRoute?: ModelRouteV1;
	/** Existing External-Agent Binding revision (historically named contextRevision). */
	contextRevision?: RevisionReferenceV1;
	capabilityRevision?: RevisionReferenceV1;
	modelBrokerBindingRevision?: RevisionReferenceV1;
	policyRevision?: RevisionReferenceV1;
	/** Explicit alias used by callers that use the entity name rather than the legacy field. */
	externalAgentBindingRevision?: RevisionReferenceV1;
	sourceTrace?: readonly BindingSourceTraceV1[];
	conflicts?: readonly BindingConflictV1[];
	goalId?: string;
	newBindingId: string;
	now?: () => string;
}

const REQUIRED_BINDING_FACTS = [
	["contextRevision", "external_agent_binding"],
	["capabilityRevision", "capability_binding"],
	["modelBrokerBindingRevision", "model_broker_binding"],
	["policyRevision", "policy_binding"],
] as const;

function requireBindingFact(reference: RevisionReferenceV1 | undefined, field: string, type: string): ResultValue<RevisionReferenceV1, FoundationError> {
	if (reference === undefined || reference.id.length === 0 || reference.revision < 1 || reference.fingerprint === undefined) {
		return Result.err(new FoundationError("binding_required_fact", `AgentBinding requires an existing immutable ${field} revision`, { details: { field, type } }));
	}
	if (reference.type !== type) {
		return Result.err(new FoundationError("binding_required_fact", `AgentBinding ${field} reference has the wrong immutable fact type`, { details: { field, expectedType: type, actualType: reference.type } }));
	}
	return Result.ok({ ...reference });
}

export function resolveAgentBinding(input: ResolveAgentBindingInput): ResultValue<AgentBindingV1, FoundationError> {
	if (!input.task?.taskId) return Result.err(new FoundationError("role_resolver_task_required", "AgentBinding resolution requires a persisted task envelope", { details: { newBindingId: input.newBindingId } }));
	if (input.externalAgentBindingRevision !== undefined && input.contextRevision !== undefined && canonicalFoundationJson(input.externalAgentBindingRevision) !== canonicalFoundationJson(input.contextRevision)) return Result.err(new FoundationError("binding_required_fact", "AgentBinding received conflicting External-Agent Binding aliases", { details: { newBindingId: input.newBindingId } }));
	const contextRevision = input.externalAgentBindingRevision ?? input.contextRevision;
	const requiredFacts: Record<(typeof REQUIRED_BINDING_FACTS)[number][0], RevisionReferenceV1 | undefined> = {
		contextRevision,
		capabilityRevision: input.capabilityRevision,
		modelBrokerBindingRevision: input.modelBrokerBindingRevision,
		policyRevision: input.policyRevision,
	};
	const resolvedFacts: Partial<Record<(typeof REQUIRED_BINDING_FACTS)[number][0], RevisionReferenceV1>> = {};
	for (const [field, type] of REQUIRED_BINDING_FACTS) {
		const checked = requireBindingFact(requiredFacts[field], field, type);
		if (!checked.ok) return checked;
		resolvedFacts[field] = checked.value;
	}
	const base = {
		schemaVersion: 1 as const, bindingId: input.newBindingId, taskId: input.task.taskId, goalId: input.goalId ?? input.task.goalId,
		roleRevision: { schemaVersion: 1 as const, type: "role_revision", id: input.roleRevision.roleRevisionId, revision: input.roleRevision.revision, fingerprint: input.roleRevision.fingerprint },
		modelProfileRevision: { schemaVersion: 1 as const, type: "model_profile_revision", id: input.modelProfile.modelProfileId, revision: input.modelProfile.revision, fingerprint: input.modelProfile.fingerprint },
		modelRoute: input.modelRoute ?? { provider: input.modelProfile.provider, model: input.modelProfile.model, ...(input.modelProfile.effort === undefined ? {} : { effort: input.modelProfile.effort }), ...(input.modelProfile.serviceTier === undefined ? {} : { serviceTier: input.modelProfile.serviceTier }) },
		contextRevision: resolvedFacts.contextRevision!,
		capabilityRevision: resolvedFacts.capabilityRevision!,
		modelBrokerBindingRevision: resolvedFacts.modelBrokerBindingRevision!,
		policyRevision: resolvedFacts.policyRevision!,
		capabilitySelector: { ...input.roleRevision.capabilitySelector }, budget: { ...input.task.budget }, sourceTrace: [...(input.sourceTrace ?? [])], conflicts: [...(input.conflicts ?? [])], resolvedAt: (input.now ?? (() => new Date().toISOString()))(),
	};
	return Result.ok(deepFreeze({ ...base, fingerprint: fingerprintFoundationValue(base) }));
}

export interface CreateBindingEpochInput { bindingEpochId: string; taskId: string; attemptId: string; bindingId: string; activationReason: BindingEpochActivationReasonV1; activatedByCommandId: string; agentInstanceId?: string; previous?: BindingEpochV1; now?: () => string; }
export function createBindingEpoch(input: CreateBindingEpochInput): ResultValue<BindingEpochV1, FoundationError> {
	if (input.previous === undefined && input.activationReason !== "attempt_started") return Result.err(new FoundationError("binding_epoch_invalid_ordinal", "Initial epoch must use attempt_started", { details: { bindingEpochId: input.bindingEpochId } }));
	if (input.previous !== undefined && input.activationReason === "attempt_started") return Result.err(new FoundationError("binding_epoch_invalid_ordinal", "Only the initial epoch may use attempt_started", { details: { bindingEpochId: input.bindingEpochId } }));
	if (input.previous && (input.previous.taskId !== input.taskId || input.previous.attemptId !== input.attemptId)) return Result.err(new FoundationError("binding_epoch_mismatch", "Binding epochs cannot span tasks or attempts", { details: { bindingEpochId: input.bindingEpochId } }));
	if (input.previous && input.previous.bindingId !== input.bindingId && input.activationReason !== "mode_switch") return Result.err(new FoundationError("binding_epoch_mismatch", "Only a mode switch may activate a new Binding inside an attempt", { details: { bindingEpochId: input.bindingEpochId } }));
	if (input.previous && input.previous.agentInstanceId !== input.agentInstanceId) return Result.err(new FoundationError("binding_epoch_mismatch", "Binding epochs cannot change AgentInstance inside an attempt", { details: { bindingEpochId: input.bindingEpochId } }));
	const value: BindingEpochV1 = { schemaVersion: 1, bindingEpochId: input.bindingEpochId, taskId: input.taskId, attemptId: input.attemptId, bindingId: input.bindingId, ordinal: input.previous ? input.previous.ordinal + 1 : 0, activationReason: input.activationReason, activatedByCommandId: input.activatedByCommandId, activatedAt: (input.now ?? (() => new Date().toISOString()))(), ...(input.agentInstanceId === undefined ? {} : { agentInstanceId: input.agentInstanceId }), ...(input.previous === undefined ? {} : { previousBindingEpochId: input.previous.bindingEpochId }) };
	return Result.ok(deepFreeze(value));
}

export interface CreateAgentInstanceInput { agentInstanceId: string; providerId: string; providerDeclaredAgent: boolean; roleRevision: RoleRevisionV1; taskId: string; parent?: AgentInstanceV1; now?: () => string; }
export function createAgentInstance(input: CreateAgentInstanceInput): ResultValue<AgentInstanceV1, FoundationError> {
	if (!input.providerDeclaredAgent) return Result.err(new FoundationError("agent_instance_not_agent_provider", "Only agent-class providers may carry an AgentInstance", { details: { providerId: input.providerId } }));
	const now = (input.now ?? (() => new Date().toISOString()))();
	const lineage: FoundationLineageV1 = input.parent === undefined ? { schemaVersion: 1, entityType: "agent_instance", entityId: input.agentInstanceId, depth: 0 } : { schemaVersion: 1, entityType: "agent_instance", entityId: input.agentInstanceId, parentId: input.parent.agentInstanceId, ancestorIds: [...(input.parent.lineage.ancestorIds ?? []), input.parent.agentInstanceId], depth: input.parent.lineage.depth + 1 };
	return Result.ok(deepFreeze({ schemaVersion: 1, agentInstanceId: input.agentInstanceId, providerId: input.providerId, taskId: input.taskId, roleRevision: { schemaVersion: 1 as const, type: "role_revision", id: input.roleRevision.roleRevisionId, revision: input.roleRevision.revision }, bindingEpochIds: [], status: "starting" as const, lineage, createdAt: now, updatedAt: now }));
}

export function assertBindingHasTaskId(binding: AgentBindingV1, taskId: string): ResultValue<AgentBindingV1, FoundationError> {
	return binding.taskId === taskId ? Result.ok(binding) : Result.err(new FoundationError("binding_task_before_binding", "Binding references a different task", { details: { bindingId: binding.bindingId } }));
}

const budgetSchema = Type.Object({ tokens: Type.Optional(Type.Number({ minimum: 0 })), costUsd: Type.Optional(Type.Number({ minimum: 0 })), modelCalls: Type.Optional(Type.Integer({ minimum: 0 })), toolCalls: Type.Optional(Type.Integer({ minimum: 0 })), wallClockMs: Type.Optional(Type.Integer({ minimum: 0 })), concurrency: Type.Optional(Type.Integer({ minimum: 0 })) }, { additionalProperties: false });
const traceSchema = Type.Object({ field: Type.String({ minLength: 1 }), layer: Type.String({ minLength: 1 }), referenceId: Type.String({ minLength: 1 }), revision: Type.Optional(Type.Integer({ minimum: 0 })), overrideReason: Type.Optional(Type.String()) }, { additionalProperties: false });
export const RoleDefinitionV1Schema = Type.Object({ schemaVersion: Type.Literal(1), roleId: Type.String({ minLength: 1 }), scope: Type.Union([Type.Literal("global"), Type.Literal("project")]), slug: Type.String({ minLength: 1 }), name: Type.String(), description: Type.String(), whenToUse: Type.Optional(Type.String()), revision: Type.Integer({ minimum: 0 }), persona: Type.String(), customInstructions: Type.Optional(Type.String()), modelProfileRef: VersionedReferenceV1Schema, capabilitySelector: CapabilitySelectorV1Schema, skillSelector: ResourceSelectorV1Schema, mcpSelector: ResourceSelectorV1Schema, contextPolicyRef: Type.Optional(VersionedReferenceV1Schema), memoryPolicyRef: Type.Optional(VersionedReferenceV1Schema), executionPolicyRef: Type.Optional(VersionedReferenceV1Schema), resultPolicyRef: Type.Optional(VersionedReferenceV1Schema), overridesRoleId: Type.Optional(Type.String({ minLength: 1 })) }, { additionalProperties: false });
export const RoleRevisionV1Schema = Type.Object({ schemaVersion: Type.Literal(1), roleRevisionId: Type.String({ minLength: 1 }), roleId: Type.String({ minLength: 1 }), scope: Type.Union([Type.Literal("global"), Type.Literal("project")]), revision: Type.Integer({ minimum: 0 }), slug: Type.String({ minLength: 1 }), name: Type.String(), description: Type.String(), whenToUse: Type.Optional(Type.String()), persona: Type.String(), customInstructions: Type.Optional(Type.String()), modelProfileRef: VersionedReferenceV1Schema, capabilitySelector: CapabilitySelectorV1Schema, skillSelector: ResourceSelectorV1Schema, mcpSelector: ResourceSelectorV1Schema, contextPolicyRef: Type.Optional(VersionedReferenceV1Schema), memoryPolicyRef: Type.Optional(VersionedReferenceV1Schema), executionPolicyRef: Type.Optional(VersionedReferenceV1Schema), resultPolicyRef: Type.Optional(VersionedReferenceV1Schema), overridesRoleId: Type.Optional(Type.String({ minLength: 1 })), fingerprint: Type.Object({ algorithm: Type.Literal("sha256"), value: Type.String({ minLength: 1 }) }, { additionalProperties: false }), createdAt: Type.String({ minLength: 1 }), previousRoleRevisionId: Type.Optional(Type.String({ minLength: 1 })) }, { additionalProperties: false });
export const ModelProfileV1Schema = Type.Object({ schemaVersion: Type.Literal(1), modelProfileId: Type.String({ minLength: 1 }), name: Type.Optional(Type.String()), provider: Type.String({ minLength: 1 }), model: Type.String({ minLength: 1 }), effort: Type.Optional(Type.String({ minLength: 1 })), serviceTier: Type.Optional(Type.String({ minLength: 1 })), fallback: Type.Optional(Type.Array(Type.Object({ provider: Type.String({ minLength: 1 }), model: Type.String({ minLength: 1 }) }, { additionalProperties: false }))), budget: budgetSchema, revision: Type.Integer({ minimum: 0 }), createdAt: Type.String({ minLength: 1 }), fingerprint: Type.Object({ algorithm: Type.Literal("sha256"), value: Type.String({ minLength: 1 }) }, { additionalProperties: false }) }, { additionalProperties: false });
export const ModelRouteV1Schema = Type.Object({ provider: Type.String({ minLength: 1 }), model: Type.String({ minLength: 1 }), effort: Type.Optional(Type.String({ minLength: 1 })), serviceTier: Type.Optional(Type.String({ minLength: 1 })) }, { additionalProperties: false });
export const AgentBindingV1Schema = Type.Object({ schemaVersion: Type.Literal(1), bindingId: Type.String({ minLength: 1 }), taskId: Type.String({ minLength: 1 }), goalId: Type.Optional(Type.String({ minLength: 1 })), roleRevision: RevisionReferenceV1Schema, modelProfileRevision: RevisionReferenceV1Schema, modelRoute: ModelRouteV1Schema, contextRevision: RevisionReferenceV1Schema, capabilityRevision: RevisionReferenceV1Schema, modelBrokerBindingRevision: RevisionReferenceV1Schema, policyRevision: RevisionReferenceV1Schema, capabilitySelector: CapabilitySelectorV1Schema, budget: budgetSchema, sourceTrace: Type.Array(traceSchema), conflicts: Type.Array(Type.Object({ field: Type.String({ minLength: 1 }), source: traceSchema, conflictsWith: traceSchema }, { additionalProperties: false })), fingerprint: Type.Object({ algorithm: Type.Literal("sha256"), value: Type.String({ minLength: 1 }) }, { additionalProperties: false }), resolvedAt: Type.String({ minLength: 1 }) }, { additionalProperties: false });
export const BindingEpochV1Schema = Type.Object({ schemaVersion: Type.Literal(1), bindingEpochId: Type.String({ minLength: 1 }), taskId: Type.String({ minLength: 1 }), attemptId: Type.String({ minLength: 1 }), agentInstanceId: Type.Optional(Type.String({ minLength: 1 })), bindingId: Type.String({ minLength: 1 }), ordinal: Type.Integer({ minimum: 0 }), previousBindingEpochId: Type.Optional(Type.String({ minLength: 1 })), activationReason: Type.Union([Type.Literal("attempt_started"), Type.Literal("mode_switch"), Type.Literal("policy_rebind")]), activatedByCommandId: Type.String({ minLength: 1 }), activatedAt: Type.String({ minLength: 1 }) }, { additionalProperties: false });
export const AgentInstanceV1Schema = Type.Object({ schemaVersion: Type.Literal(1), agentInstanceId: Type.String({ minLength: 1 }), providerId: Type.String({ minLength: 1 }), taskId: Type.String({ minLength: 1 }), roleRevision: VersionedReferenceV1Schema, bindingEpochIds: Type.Array(Type.String({ minLength: 1 })), status: Type.Union([Type.Literal("starting"), Type.Literal("active"), Type.Literal("suspended"), Type.Literal("stopped")]), lineage: LineageV1Schema, createdAt: Type.String({ minLength: 1 }), updatedAt: Type.String({ minLength: 1 }) }, { additionalProperties: false });
export function validateRoleDefinitionV1(value: unknown): ResultValue<RoleDefinitionV1, FoundationError> { return validateExactShape<RoleDefinitionV1>(RoleDefinitionV1Schema, value, "role_definition"); }
export function serializeRoleDefinitionV1(value: RoleDefinitionV1): string { return serializeExactShape(RoleDefinitionV1Schema, value, "role_definition"); }
export function parseRoleDefinitionV1(text: string): ResultValue<RoleDefinitionV1, FoundationError> { return parseExactShape(RoleDefinitionV1Schema, text, "role_definition"); }
export function validateRoleRevisionV1(value: unknown): ResultValue<RoleRevisionV1, FoundationError> { return validateExactShape<RoleRevisionV1>(RoleRevisionV1Schema, value, "role_revision"); }
export function serializeRoleRevisionV1(value: RoleRevisionV1): string { return serializeExactShape(RoleRevisionV1Schema, value, "role_revision"); }
export function parseRoleRevisionV1(text: string): ResultValue<RoleRevisionV1, FoundationError> { return parseExactShape(RoleRevisionV1Schema, text, "role_revision"); }
export function validateModelProfileV1(value: unknown): ResultValue<ModelProfileV1, FoundationError> { return validateExactShape<ModelProfileV1>(ModelProfileV1Schema, value, "model_profile"); }
export function serializeModelProfileV1(value: ModelProfileV1): string { return serializeExactShape(ModelProfileV1Schema, value, "model_profile"); }
export function parseModelProfileV1(text: string): ResultValue<ModelProfileV1, FoundationError> { return parseExactShape(ModelProfileV1Schema, text, "model_profile"); }
export function validateAgentBindingV1(value: unknown): ResultValue<AgentBindingV1, FoundationError> {
	const checked = validateExactShape<AgentBindingV1>(AgentBindingV1Schema, value, "agent_binding");
	if (!checked.ok) return checked;
	const binding = checked.value;
	const facts: readonly [string, RevisionReferenceV1, string][] = [
		["roleRevision", binding.roleRevision, "role_revision"],
		["modelProfileRevision", binding.modelProfileRevision, "model_profile_revision"],
		["contextRevision", binding.contextRevision, "external_agent_binding"],
		["capabilityRevision", binding.capabilityRevision, "capability_binding"],
		["modelBrokerBindingRevision", binding.modelBrokerBindingRevision, "model_broker_binding"],
		["policyRevision", binding.policyRevision, "policy_binding"],
	];
	for (const [field, reference, type] of facts) {
		const fact = requireBindingFact(reference, field, type);
		if (!fact.ok) return fact;
	}
	const { fingerprint, ...snapshot } = binding;
	if (fingerprintFoundationValue(snapshot).value !== fingerprint.value) return Result.err(new FoundationError("profile_conflict", "AgentBinding fingerprint does not match immutable fields", { details: { bindingId: binding.bindingId } }));
	return Result.ok(deepFreeze(binding));
}
export function serializeAgentBindingV1(value: AgentBindingV1): string { return serializeExactShape(AgentBindingV1Schema, value, "agent_binding"); }
export function parseAgentBindingV1(text: string): ResultValue<AgentBindingV1, FoundationError> { return parseExactShape(AgentBindingV1Schema, text, "agent_binding"); }
export function validateBindingEpochV1(value: unknown): ResultValue<BindingEpochV1, FoundationError> { return validateExactShape<BindingEpochV1>(BindingEpochV1Schema, value, "binding_epoch"); }
export function serializeBindingEpochV1(value: BindingEpochV1): string { return serializeExactShape(BindingEpochV1Schema, value, "binding_epoch"); }
export function parseBindingEpochV1(text: string): ResultValue<BindingEpochV1, FoundationError> { return parseExactShape(BindingEpochV1Schema, text, "binding_epoch"); }
export function validateAgentInstanceV1(value: unknown): ResultValue<AgentInstanceV1, FoundationError> { return validateExactShape<AgentInstanceV1>(AgentInstanceV1Schema, value, "agent_instance"); }
export function serializeAgentInstanceV1(value: AgentInstanceV1): string { return serializeExactShape(AgentInstanceV1Schema, value, "agent_instance"); }
export function parseAgentInstanceV1(text: string): ResultValue<AgentInstanceV1, FoundationError> { return parseExactShape(AgentInstanceV1Schema, text, "agent_instance"); }
export const validateRoleDefinition = validateRoleDefinitionV1;
export const serializeRoleDefinition = serializeRoleDefinitionV1;
export const parseRoleDefinition = parseRoleDefinitionV1;
export const validateRoleRevision = validateRoleRevisionV1;
export const serializeRoleRevision = serializeRoleRevisionV1;
export const parseRoleRevision = parseRoleRevisionV1;
export const validateModelProfile = validateModelProfileV1;
export const serializeModelProfile = serializeModelProfileV1;
export const parseModelProfile = parseModelProfileV1;
export const validateAgentBinding = validateAgentBindingV1;
export const serializeAgentBinding = serializeAgentBindingV1;
export const parseAgentBinding = parseAgentBindingV1;
export const validateBindingEpoch = validateBindingEpochV1;
export const serializeBindingEpoch = serializeBindingEpochV1;
export const parseBindingEpoch = parseBindingEpochV1;
export const validateAgentInstance = validateAgentInstanceV1;
export const serializeAgentInstance = serializeAgentInstanceV1;
export const parseAgentInstance = parseAgentInstanceV1;
