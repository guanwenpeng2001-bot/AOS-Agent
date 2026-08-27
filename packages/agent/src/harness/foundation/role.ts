import { Result, type Result as ResultValue } from "../result.ts";
import { Type } from "typebox";
import type { Budget } from "./budget.ts";
import { FoundationError } from "./errors.ts";
import { ResourceSelectorSchema, RevisionReferenceSchema, VersionedReferenceSchema, type ResourceSelector, type RevisionReference, type VersionedReference } from "./reference.ts";
import { LineageSchema, parseExactShape, serializeExactShape, validateExactShape } from "./schema.ts";
import { FOUNDATION_SCHEMA_VERSION, canonicalFoundationJson, type Fingerprint, fingerprintFoundationValue, type FoundationLineage } from "./identity.ts";
import { createEmptyMcpSelection, McpSelectionSchema, validateMcpSelectionForBinding, type McpSelection } from "./mcp-selection.ts";
import type { TaskEnvelope } from "./task.ts";

export type RoleScope = "global" | "project";
export interface RoleRef { roleId: string; roleVersion: string; scope?: string; }
export interface RoleDefinition {
	schemaVersion: 1; roleId: string; scope: RoleScope; slug: string; name: string; description: string; whenToUse?: string;
	revision: number; persona: string; customInstructions?: string; modelProfileRef: VersionedReference;
	capabilitySelector: ResourceSelector; skillSelector: ResourceSelector; mcpSelector: ResourceSelector;
	contextPolicyRef?: VersionedReference; memoryPolicyRef?: VersionedReference; executionPolicyRef?: VersionedReference; resultPolicyRef?: VersionedReference; overridesRoleId?: string;
}
export interface RoleRevision {
	readonly schemaVersion: 1; readonly roleRevisionId: string; readonly roleId: string; readonly scope: RoleScope; readonly revision: number; readonly slug: string; readonly name: string; readonly description: string; readonly whenToUse?: string;
	readonly persona: string; readonly customInstructions?: string; readonly modelProfileRef: VersionedReference; readonly capabilitySelector: ResourceSelector; readonly skillSelector: ResourceSelector; readonly mcpSelector: ResourceSelector;
	readonly contextPolicyRef?: VersionedReference; readonly memoryPolicyRef?: VersionedReference; readonly executionPolicyRef?: VersionedReference; readonly resultPolicyRef?: VersionedReference; readonly overridesRoleId?: string;
	readonly fingerprint: Fingerprint; readonly createdAt: string; readonly previousRoleRevisionId?: string;
}

export interface ModelProfile {
	readonly schemaVersion: 1; readonly modelProfileId: string; readonly name?: string; readonly provider: string; readonly model: string; readonly effort?: string; readonly serviceTier?: string;
	readonly fallback?: readonly { readonly provider: string; readonly model: string }[]; readonly budget: Budget; readonly revision: number; readonly createdAt: string; readonly fingerprint: Fingerprint;
}
/** Resolved route metadata frozen into an AgentBinding; credentials never enter this value. */
export interface ModelRoute {
	provider: string;
	model: string;
	effort?: string;
	serviceTier?: string;
	/** Fallback is frozen as route metadata in T6; the T6 host never executes it. */
	fallback?: readonly { readonly provider: string; readonly model: string }[];
}
/** Independent immutable ModelProfile revision constructor. */
export function createModelProfileRevision(input: Omit<ModelProfile, "fingerprint">): ModelProfile {
	const snapshot = { ...input, budget: { ...input.budget }, ...(input.fallback === undefined ? {} : { fallback: input.fallback.map((route) => ({ ...route })) }) };
	return deepFreeze({ ...snapshot, fingerprint: fingerprintFoundationValue(snapshot) });
}
export interface BindingSourceTrace { field: string; layer: "managed_lock" | "global" | "project" | "path" | "goal" | "task" | "run"; referenceId: string; revision?: number; overrideReason?: string; }
export interface BindingConflict { field: string; source: BindingSourceTrace; conflictsWith: BindingSourceTrace; }
export interface AgentBinding {
	schemaVersion: 1; bindingId: string; taskId: string; goalId?: string;
	/** All four runtime binding facts are immutable references; none has a synthetic fallback. */
	roleRevision: RevisionReference; modelProfileRevision: RevisionReference; modelRoute: ModelRoute;
	/** External-Agent Binding is retained under the historical contextRevision field for wire stability. */
	contextRevision: RevisionReference;
	capabilityRevision: RevisionReference;
	modelBrokerBindingRevision: RevisionReference;
	policyRevision: RevisionReference;
	capabilitySelector: ResourceSelector; mcpSelection: McpSelection; budget: Budget; sourceTrace: readonly BindingSourceTrace[]; conflicts: readonly BindingConflict[]; fingerprint: Fingerprint; resolvedAt: string;
}
export type BindingEpochActivationReason = "attempt_started" | "mode_switch" | "policy_rebind";
export const BINDING_EPOCH_ACTIVATION_REASONS = ["attempt_started", "mode_switch", "policy_rebind"] as const;
export interface BindingEpoch {
	schemaVersion: 1; bindingEpochId: string; taskId: string; attemptId: string; agentInstanceId?: string; bindingId: string; ordinal: number; previousBindingEpochId?: string; activationReason: BindingEpochActivationReason; activatedByCommandId: string; activatedAt: string;
}
export type AgentInstanceStatus = "starting" | "active" | "suspended" | "stopped";
export const AGENT_INSTANCE_STATUSES = ["starting", "active", "suspended", "stopped"] as const;
export interface AgentInstance {
	schemaVersion: 1; agentInstanceId: string; providerId: string; taskId: string; roleRevision: VersionedReference; bindingEpochIds: readonly string[]; status: AgentInstanceStatus; lineage: FoundationLineage; createdAt: string; updatedAt: string;
}

export interface CreateRoleRevisionInput { definition: RoleDefinition; previous?: RoleRevision; now?: () => string; }
function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
	if (value !== null && typeof value === "object") {
		if (seen.has(value)) return value;
		seen.add(value);
		for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child, seen);
		Object.freeze(value);
	}
	return value;
}
export function createRoleRevision(input: CreateRoleRevisionInput): RoleRevision {
	const previous = input.previous; const revision = previous === undefined ? 1 : previous.revision + 1;
	const snapshot: Omit<RoleRevision, "fingerprint"> = {
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
	task: TaskEnvelope;
	roleRevision: RoleRevision;
	modelProfile: ModelProfile;
	modelRoute?: ModelRoute;
	/** Existing External-Agent Binding revision (historically named contextRevision). */
	contextRevision?: RevisionReference;
	capabilityRevision?: RevisionReference;
	modelBrokerBindingRevision?: RevisionReference;
	policyRevision?: RevisionReference;
	/** Resolved budget is frozen into the immutable Binding. */
	budget?: Budget;
	/** Exact MCP server/tool set already resolved against CapabilityBinding + Tool Gateway routes. */
	mcpSelection?: McpSelection;
	/** Explicit alias used by callers that use the entity name rather than the legacy field. */
	externalAgentBindingRevision?: RevisionReference;
	sourceTrace?: readonly BindingSourceTrace[];
	conflicts?: readonly BindingConflict[];
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

function requireBindingFact(reference: RevisionReference | undefined, field: string, type: string): ResultValue<RevisionReference, FoundationError> {
	if (reference === undefined || reference.id.length === 0 || reference.revision < 1 || reference.fingerprint === undefined) {
		return Result.err(new FoundationError("binding_required_fact", `AgentBinding requires an existing immutable ${field} revision`, { details: { field, type } }));
	}
	if (reference.type !== type) {
		return Result.err(new FoundationError("binding_required_fact", `AgentBinding ${field} reference has the wrong immutable fact type`, { details: { field, expectedType: type, actualType: reference.type } }));
	}
	return Result.ok({ ...reference });
}

export function resolveAgentBinding(input: ResolveAgentBindingInput): ResultValue<AgentBinding, FoundationError> {
	if (!input.task?.taskId) return Result.err(new FoundationError("role_resolver_task_required", "AgentBinding resolution requires a persisted task envelope", { details: { newBindingId: input.newBindingId } }));
	if (input.externalAgentBindingRevision !== undefined && input.contextRevision !== undefined && canonicalFoundationJson(input.externalAgentBindingRevision) !== canonicalFoundationJson(input.contextRevision)) return Result.err(new FoundationError("binding_required_fact", "AgentBinding received conflicting External-Agent Binding aliases", { details: { newBindingId: input.newBindingId } }));
	const contextRevision = input.externalAgentBindingRevision ?? input.contextRevision;
	const requiredFacts: Record<(typeof REQUIRED_BINDING_FACTS)[number][0], RevisionReference | undefined> = {
		contextRevision,
		capabilityRevision: input.capabilityRevision,
		modelBrokerBindingRevision: input.modelBrokerBindingRevision,
		policyRevision: input.policyRevision,
	};
	const resolvedFacts: Partial<Record<(typeof REQUIRED_BINDING_FACTS)[number][0], RevisionReference>> = {};
	for (const [field, type] of REQUIRED_BINDING_FACTS) {
		const checked = requireBindingFact(requiredFacts[field], field, type);
		if (!checked.ok) return checked;
		resolvedFacts[field] = checked.value;
	}
	const capabilityRevision = resolvedFacts.capabilityRevision!;
	const requestedMcpSelection = input.mcpSelection ?? (
		input.roleRevision.mcpSelector.policy === "none"
			? createEmptyMcpSelection(capabilityRevision.id)
			: undefined
	);
	if (requestedMcpSelection === undefined) {
		return Result.err(new FoundationError("binding_required_fact", "AgentBinding requires an exact MCP selection for a non-empty Role selector", { details: { newBindingId: input.newBindingId } }));
	}
	const mcpSelection = validateMcpSelectionForBinding(
		requestedMcpSelection,
		input.roleRevision.mcpSelector,
		capabilityRevision.id,
	);
	if (!mcpSelection.ok) return mcpSelection;
	const profileRoute: ModelRoute = {
		provider: input.modelProfile.provider,
		model: input.modelProfile.model,
		...(input.modelProfile.effort === undefined ? {} : { effort: input.modelProfile.effort }),
		...(input.modelProfile.serviceTier === undefined ? {} : { serviceTier: input.modelProfile.serviceTier }),
		...(input.modelProfile.fallback === undefined ? {} : { fallback: input.modelProfile.fallback.map((route) => ({ ...route })) }),
	};
	const requestedRoute = input.modelRoute ?? profileRoute;
	if (canonicalFoundationJson(requestedRoute) !== canonicalFoundationJson(profileRoute)) return Result.err(new FoundationError("binding_required_fact", "AgentBinding model route must be frozen from its durable ModelProfile", { details: { modelProfileId: input.modelProfile.modelProfileId } }));
	const base = {
		schemaVersion: 1 as const, bindingId: input.newBindingId, taskId: input.task.taskId, goalId: input.goalId ?? input.task.goalId,
		roleRevision: { schemaVersion: 1 as const, type: "role_revision", id: input.roleRevision.roleRevisionId, revision: input.roleRevision.revision, fingerprint: input.roleRevision.fingerprint },
		modelProfileRevision: { schemaVersion: 1 as const, type: "model_profile_revision", id: input.modelProfile.modelProfileId, revision: input.modelProfile.revision, fingerprint: input.modelProfile.fingerprint },
		modelRoute: requestedRoute,
		contextRevision: resolvedFacts.contextRevision!,
		capabilityRevision: resolvedFacts.capabilityRevision!,
		modelBrokerBindingRevision: resolvedFacts.modelBrokerBindingRevision!,
		policyRevision: resolvedFacts.policyRevision!,
		capabilitySelector: { ...input.roleRevision.capabilitySelector }, mcpSelection: mcpSelection.value, budget: { ...(input.budget ?? mergeBudget(input.modelProfile.budget, input.task.budget)) }, sourceTrace: [...(input.sourceTrace ?? [])], conflicts: [...(input.conflicts ?? [])], resolvedAt: (input.now ?? (() => new Date().toISOString()))(),
	};
	return Result.ok(deepFreeze({ ...base, fingerprint: fingerprintFoundationValue(base) }));
}

function mergeBudget(left: Budget, right: Budget): Budget {
	const result: Budget = {};
	for (const key of ["tokens", "costUsd", "modelCalls", "toolCalls", "wallClockMs", "concurrency"] as const) {
		const a = left[key];
		const b = right[key];
		if (a !== undefined || b !== undefined) result[key] = a === undefined ? b : b === undefined ? a : Math.min(a, b);
	}
	return result;
}

export interface CreateBindingEpochInput { bindingEpochId: string; taskId: string; attemptId: string; bindingId: string; activationReason: BindingEpochActivationReason; activatedByCommandId: string; agentInstanceId?: string; previous?: BindingEpoch; now?: () => string; }
export function createBindingEpoch(input: CreateBindingEpochInput): ResultValue<BindingEpoch, FoundationError> {
	if (input.previous === undefined && input.activationReason !== "attempt_started") return Result.err(new FoundationError("binding_epoch_invalid_ordinal", "Initial epoch must use attempt_started", { details: { bindingEpochId: input.bindingEpochId } }));
	if (input.previous !== undefined && input.activationReason === "attempt_started") return Result.err(new FoundationError("binding_epoch_invalid_ordinal", "Only the initial epoch may use attempt_started", { details: { bindingEpochId: input.bindingEpochId } }));
	if (input.previous && (input.previous.taskId !== input.taskId || input.previous.attemptId !== input.attemptId)) return Result.err(new FoundationError("binding_epoch_mismatch", "Binding epochs cannot span tasks or attempts", { details: { bindingEpochId: input.bindingEpochId } }));
	if (input.previous && input.previous.bindingId !== input.bindingId && input.activationReason !== "mode_switch") return Result.err(new FoundationError("binding_epoch_mismatch", "Only a mode switch may activate a new Binding inside an attempt", { details: { bindingEpochId: input.bindingEpochId } }));
	if (input.previous && input.previous.agentInstanceId !== input.agentInstanceId) return Result.err(new FoundationError("binding_epoch_mismatch", "Binding epochs cannot change AgentInstance inside an attempt", { details: { bindingEpochId: input.bindingEpochId } }));
	const value: BindingEpoch = { schemaVersion: 1, bindingEpochId: input.bindingEpochId, taskId: input.taskId, attemptId: input.attemptId, bindingId: input.bindingId, ordinal: input.previous ? input.previous.ordinal + 1 : 0, activationReason: input.activationReason, activatedByCommandId: input.activatedByCommandId, activatedAt: (input.now ?? (() => new Date().toISOString()))(), ...(input.agentInstanceId === undefined ? {} : { agentInstanceId: input.agentInstanceId }), ...(input.previous === undefined ? {} : { previousBindingEpochId: input.previous.bindingEpochId }) };
	return Result.ok(deepFreeze(value));
}

export interface CreateAgentInstanceInput { agentInstanceId: string; providerId: string; providerDeclaredAgent: boolean; roleRevision: RoleRevision; taskId: string; parent?: AgentInstance; now?: () => string; }
export function createAgentInstance(input: CreateAgentInstanceInput): ResultValue<AgentInstance, FoundationError> {
	if (!input.providerDeclaredAgent) return Result.err(new FoundationError("agent_instance_not_agent_provider", "Only agent-class providers may carry an AgentInstance", { details: { providerId: input.providerId } }));
	const now = (input.now ?? (() => new Date().toISOString()))();
	const lineage: FoundationLineage = input.parent === undefined ? { schemaVersion: 1, entityType: "agent_instance", entityId: input.agentInstanceId, depth: 0 } : { schemaVersion: 1, entityType: "agent_instance", entityId: input.agentInstanceId, parentId: input.parent.agentInstanceId, ancestorIds: [...(input.parent.lineage.ancestorIds ?? []), input.parent.agentInstanceId], depth: input.parent.lineage.depth + 1 };
	return Result.ok(deepFreeze({ schemaVersion: 1, agentInstanceId: input.agentInstanceId, providerId: input.providerId, taskId: input.taskId, roleRevision: { schemaVersion: 1 as const, type: "role_revision", id: input.roleRevision.roleRevisionId, revision: input.roleRevision.revision }, bindingEpochIds: [], status: "starting" as const, lineage, createdAt: now, updatedAt: now }));
}

export function assertBindingHasTaskId(binding: AgentBinding, taskId: string): ResultValue<AgentBinding, FoundationError> {
	return binding.taskId === taskId ? Result.ok(binding) : Result.err(new FoundationError("binding_task_before_binding", "Binding references a different task", { details: { bindingId: binding.bindingId } }));
}

const budgetSchema = Type.Object({ tokens: Type.Optional(Type.Number({ minimum: 0 })), costUsd: Type.Optional(Type.Number({ minimum: 0 })), modelCalls: Type.Optional(Type.Integer({ minimum: 0 })), toolCalls: Type.Optional(Type.Integer({ minimum: 0 })), wallClockMs: Type.Optional(Type.Integer({ minimum: 0 })), concurrency: Type.Optional(Type.Integer({ minimum: 0 })) }, { additionalProperties: false });
const traceSchema = Type.Object({ field: Type.String({ minLength: 1 }), layer: Type.String({ minLength: 1 }), referenceId: Type.String({ minLength: 1 }), revision: Type.Optional(Type.Integer({ minimum: 0 })), overrideReason: Type.Optional(Type.String()) }, { additionalProperties: false });
export const RoleDefinitionSchema = Type.Object({ schemaVersion: Type.Literal(1), roleId: Type.String({ minLength: 1 }), scope: Type.Union([Type.Literal("global"), Type.Literal("project")]), slug: Type.String({ minLength: 1 }), name: Type.String(), description: Type.String(), whenToUse: Type.Optional(Type.String()), revision: Type.Integer({ minimum: 0 }), persona: Type.String(), customInstructions: Type.Optional(Type.String()), modelProfileRef: VersionedReferenceSchema, capabilitySelector: ResourceSelectorSchema, skillSelector: ResourceSelectorSchema, mcpSelector: ResourceSelectorSchema, contextPolicyRef: Type.Optional(VersionedReferenceSchema), memoryPolicyRef: Type.Optional(VersionedReferenceSchema), executionPolicyRef: Type.Optional(VersionedReferenceSchema), resultPolicyRef: Type.Optional(VersionedReferenceSchema), overridesRoleId: Type.Optional(Type.String({ minLength: 1 })) }, { additionalProperties: false });
export const RoleRevisionSchema = Type.Object({ schemaVersion: Type.Literal(1), roleRevisionId: Type.String({ minLength: 1 }), roleId: Type.String({ minLength: 1 }), scope: Type.Union([Type.Literal("global"), Type.Literal("project")]), revision: Type.Integer({ minimum: 0 }), slug: Type.String({ minLength: 1 }), name: Type.String(), description: Type.String(), whenToUse: Type.Optional(Type.String()), persona: Type.String(), customInstructions: Type.Optional(Type.String()), modelProfileRef: VersionedReferenceSchema, capabilitySelector: ResourceSelectorSchema, skillSelector: ResourceSelectorSchema, mcpSelector: ResourceSelectorSchema, contextPolicyRef: Type.Optional(VersionedReferenceSchema), memoryPolicyRef: Type.Optional(VersionedReferenceSchema), executionPolicyRef: Type.Optional(VersionedReferenceSchema), resultPolicyRef: Type.Optional(VersionedReferenceSchema), overridesRoleId: Type.Optional(Type.String({ minLength: 1 })), fingerprint: Type.Object({ algorithm: Type.Literal("sha256"), value: Type.String({ minLength: 1 }) }, { additionalProperties: false }), createdAt: Type.String({ minLength: 1 }), previousRoleRevisionId: Type.Optional(Type.String({ minLength: 1 })) }, { additionalProperties: false });
export const ModelProfileSchema = Type.Object({ schemaVersion: Type.Literal(1), modelProfileId: Type.String({ minLength: 1 }), name: Type.Optional(Type.String()), provider: Type.String({ minLength: 1 }), model: Type.String({ minLength: 1 }), effort: Type.Optional(Type.String({ minLength: 1 })), serviceTier: Type.Optional(Type.String({ minLength: 1 })), fallback: Type.Optional(Type.Array(Type.Object({ provider: Type.String({ minLength: 1 }), model: Type.String({ minLength: 1 }) }, { additionalProperties: false }))), budget: budgetSchema, revision: Type.Integer({ minimum: 0 }), createdAt: Type.String({ minLength: 1 }), fingerprint: Type.Object({ algorithm: Type.Literal("sha256"), value: Type.String({ minLength: 1 }) }, { additionalProperties: false }) }, { additionalProperties: false });
const fallbackRouteSchema = Type.Object({ provider: Type.String({ minLength: 1 }), model: Type.String({ minLength: 1 }) }, { additionalProperties: false });
export const ModelRouteSchema = Type.Object({ provider: Type.String({ minLength: 1 }), model: Type.String({ minLength: 1 }), effort: Type.Optional(Type.String({ minLength: 1 })), serviceTier: Type.Optional(Type.String({ minLength: 1 })), fallback: Type.Optional(Type.Array(fallbackRouteSchema)) }, { additionalProperties: false });
export const AgentBindingSchema = Type.Object({ schemaVersion: Type.Literal(1), bindingId: Type.String({ minLength: 1 }), taskId: Type.String({ minLength: 1 }), goalId: Type.Optional(Type.String({ minLength: 1 })), roleRevision: RevisionReferenceSchema, modelProfileRevision: RevisionReferenceSchema, modelRoute: ModelRouteSchema, contextRevision: RevisionReferenceSchema, capabilityRevision: RevisionReferenceSchema, modelBrokerBindingRevision: RevisionReferenceSchema, policyRevision: RevisionReferenceSchema, capabilitySelector: ResourceSelectorSchema, mcpSelection: McpSelectionSchema, budget: budgetSchema, sourceTrace: Type.Array(traceSchema), conflicts: Type.Array(Type.Object({ field: Type.String({ minLength: 1 }), source: traceSchema, conflictsWith: traceSchema }, { additionalProperties: false })), fingerprint: Type.Object({ algorithm: Type.Literal("sha256"), value: Type.String({ minLength: 1 }) }, { additionalProperties: false }), resolvedAt: Type.String({ minLength: 1 }) }, { additionalProperties: false });
export const BindingEpochSchema = Type.Object({ schemaVersion: Type.Literal(1), bindingEpochId: Type.String({ minLength: 1 }), taskId: Type.String({ minLength: 1 }), attemptId: Type.String({ minLength: 1 }), agentInstanceId: Type.Optional(Type.String({ minLength: 1 })), bindingId: Type.String({ minLength: 1 }), ordinal: Type.Integer({ minimum: 0 }), previousBindingEpochId: Type.Optional(Type.String({ minLength: 1 })), activationReason: Type.Union([Type.Literal("attempt_started"), Type.Literal("mode_switch"), Type.Literal("policy_rebind")]), activatedByCommandId: Type.String({ minLength: 1 }), activatedAt: Type.String({ minLength: 1 }) }, { additionalProperties: false });
export const AgentInstanceSchema = Type.Object({ schemaVersion: Type.Literal(1), agentInstanceId: Type.String({ minLength: 1 }), providerId: Type.String({ minLength: 1 }), taskId: Type.String({ minLength: 1 }), roleRevision: VersionedReferenceSchema, bindingEpochIds: Type.Array(Type.String({ minLength: 1 })), status: Type.Union([Type.Literal("starting"), Type.Literal("active"), Type.Literal("suspended"), Type.Literal("stopped")]), lineage: LineageSchema, createdAt: Type.String({ minLength: 1 }), updatedAt: Type.String({ minLength: 1 }) }, { additionalProperties: false });
export function validateRoleDefinition(value: unknown): ResultValue<RoleDefinition, FoundationError> { return validateExactShape<RoleDefinition>(RoleDefinitionSchema, value, "role_definition"); }
export function serializeRoleDefinition(value: RoleDefinition): string { return serializeExactShape(RoleDefinitionSchema, value, "role_definition"); }
export function parseRoleDefinition(text: string): ResultValue<RoleDefinition, FoundationError> { return parseExactShape(RoleDefinitionSchema, text, "role_definition"); }
export function validateRoleRevision(value: unknown): ResultValue<RoleRevision, FoundationError> { return validateExactShape<RoleRevision>(RoleRevisionSchema, value, "role_revision"); }
export function serializeRoleRevision(value: RoleRevision): string { return serializeExactShape(RoleRevisionSchema, value, "role_revision"); }
export function parseRoleRevision(text: string): ResultValue<RoleRevision, FoundationError> { return parseExactShape(RoleRevisionSchema, text, "role_revision"); }
export function validateModelProfile(value: unknown): ResultValue<ModelProfile, FoundationError> { return validateExactShape<ModelProfile>(ModelProfileSchema, value, "model_profile"); }
export function serializeModelProfile(value: ModelProfile): string { return serializeExactShape(ModelProfileSchema, value, "model_profile"); }
export function parseModelProfile(text: string): ResultValue<ModelProfile, FoundationError> { return parseExactShape(ModelProfileSchema, text, "model_profile"); }
export function validateAgentBinding(value: unknown): ResultValue<AgentBinding, FoundationError> {
	const checked = validateExactShape<AgentBinding>(AgentBindingSchema, value, "agent_binding");
	if (!checked.ok) return checked;
	const binding = checked.value;
	const facts: readonly [string, RevisionReference, string][] = [
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
export function serializeAgentBinding(value: AgentBinding): string { return serializeExactShape(AgentBindingSchema, value, "agent_binding"); }
export function parseAgentBinding(text: string): ResultValue<AgentBinding, FoundationError> { return parseExactShape(AgentBindingSchema, text, "agent_binding"); }
export function validateBindingEpoch(value: unknown): ResultValue<BindingEpoch, FoundationError> { return validateExactShape<BindingEpoch>(BindingEpochSchema, value, "binding_epoch"); }
export function serializeBindingEpoch(value: BindingEpoch): string { return serializeExactShape(BindingEpochSchema, value, "binding_epoch"); }
export function parseBindingEpoch(text: string): ResultValue<BindingEpoch, FoundationError> { return parseExactShape(BindingEpochSchema, text, "binding_epoch"); }
export function validateAgentInstance(value: unknown): ResultValue<AgentInstance, FoundationError> { return validateExactShape<AgentInstance>(AgentInstanceSchema, value, "agent_instance"); }
export function serializeAgentInstance(value: AgentInstance): string { return serializeExactShape(AgentInstanceSchema, value, "agent_instance"); }
export function parseAgentInstance(text: string): ResultValue<AgentInstance, FoundationError> { return parseExactShape(AgentInstanceSchema, text, "agent_instance"); }
