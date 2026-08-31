import { Result, type ResultValue } from "../result.ts";
import { Type } from "typebox";
import type { JsonValue } from "../session/types.ts";
import { FoundationError, redactProjection } from "./errors.ts";
import { canonicalFoundationJson, fingerprintFoundationValue, newFoundationId, type Fingerprint } from "./identity.ts";
import { cloneDeepFrozen } from "./immutability.ts";
import { McpSelectionSchema, type McpSelection } from "./mcp-selection.ts";
import { AgentBindingSchema, ModelProfileSchema, ModelRouteSchema, RoleDefinitionSchema, RoleRevisionSchema, createRoleRevision, resolveAgentBinding, validateRoleDefinition, type ModelProfile, type AgentBinding, type BindingConflict, type BindingSourceTrace, type RoleDefinition, type RoleRevision, type RoleScope, type ModelRoute } from "./role.ts";
import { ResourceSelectorSchema, RevisionReferenceSchema, selectorsNarrow, type ResourceSelector, type RevisionReference, type VersionedReference, VersionedReferenceSchema } from "./reference.ts";
import { TaskEnvelopeSchema, type TaskEnvelope } from "./task.ts";
import { BudgetSchema } from "./budget.ts";
import { FoundationJsonValueSchema, parseExactShape, serializeExactShape, validateExactShape } from "./schema.ts";

export interface RoleResolutionOverride {
	schemaVersion: 1;
	layer: RoleResolutionLayerName;
	referenceId: string;
	revision: number;
	overrideReason: string;
	roleRevision?: RoleRevision;
	modelProfile?: ModelProfile;
	modelRoute?: ModelRoute;
	capabilitySelector?: ResourceSelector;
	budget?: TaskEnvelope["budget"];
	contextRevision?: RevisionReference;
	externalAgentBindingRevision?: RevisionReference;
	modelBrokerBindingRevision?: RevisionReference;
	policyRevision?: RevisionReference;
}

/** Ordered precedence layers used by the resolver; later layers may only tighten. */
export type RoleResolutionLayerName = BindingSourceTrace["layer"];
export const ROLE_RESOLUTION_ORDER = ["managed_lock", "global", "project", "path", "goal", "task", "run"] as const;
export type RoleResolutionOrder = (typeof ROLE_RESOLUTION_ORDER)[number];
export interface RoleResolutionLayer {
	schemaVersion: 1;
	layer: RoleResolutionLayerName;
	ordinal: number;
	referenceId: string;
	revision: number;
	overrideReason: string;
}

/** One resolved field with the source and conflict that produced its value. */
export interface RoleResolvedField {
	schemaVersion: 1;
	field: string;
	source: BindingSourceTrace;
	revision: number;
	overrideReason: string;
	/** Only a redacted safe projection may be returned; raw prompts, paths, URLs and credentials are excluded. */
	safeValue: JsonValue;
	conflict?: BindingConflict;
}

export interface RoleResolutionPreview {
	schemaVersion: 1;
	taskId: string;
	roleId: string;
	roleRevision: RevisionReference;
	modelProfileRevision: RevisionReference;
	modelRoute: ModelRoute;
	contextRevision: RevisionReference;
	capabilityRevision: RevisionReference;
	modelBrokerBindingRevision: RevisionReference;
	policyRevision: RevisionReference;
	capabilitySelector: ResourceSelector;
	budget: TaskEnvelope["budget"];
	orderedLayers: readonly RoleResolutionLayer[];
	fields: readonly RoleResolvedField[];
	sourceTrace: readonly BindingSourceTrace[];
	conflicts: readonly BindingConflict[];
	binding: AgentBinding;
	fingerprint: Fingerprint;
}

export interface RoleRegistryRecord {
	schemaVersion: 1;
	roleId: string;
	scope: RoleScope;
	definition: RoleDefinition;
	currentRevision: RoleRevision;
	revisions: readonly RoleRevision[];
	tombstone?: RoleTombstone;
}

/** Delete is a durable tombstone; it never erases prior immutable revisions. */
export interface RoleTombstone {
	schemaVersion: 1;
	roleId: string;
	scope: RoleScope;
	deletedRevision: number;
	deletedAt: string;
	deletedBy?: string;
	reason?: string;
}

export interface RoleRegistryCreateInput { definition: RoleDefinition; }
export interface RoleRegistryGetQuery { roleId: string; scope?: RoleScope; includeTombstone?: boolean; revision?: number; }
export interface RoleRegistryListQuery { scope?: RoleScope; includeTombstones?: boolean; }
export interface RoleRegistrySearchQuery { text: string; scope?: RoleScope; includeTombstones?: boolean; }
export interface RoleDefinitionPatch {
	name?: string;
	description?: string;
	whenToUse?: string;
	persona?: string;
	customInstructions?: string;
	modelProfileRef?: VersionedReference;
	capabilitySelector?: ResourceSelector;
	skillSelector?: ResourceSelector;
	mcpSelector?: ResourceSelector;
	contextPolicyRef?: VersionedReference;
	memoryPolicyRef?: VersionedReference;
	executionPolicyRef?: VersionedReference;
	resultPolicyRef?: VersionedReference;
	overridesRoleId?: string;
}
export interface RoleRegistryEditInput { roleId: string; scope: RoleScope; expectedRevision: number; patch: RoleDefinitionPatch; }
export interface RoleRegistryCopyInput { sourceRoleId: string; sourceScope: RoleScope; targetRoleId: string; targetScope: RoleScope; expectedRevision: number; }
export interface RoleRegistryDeleteInput { roleId: string; scope: RoleScope; expectedRevision: number; deletedAt: string; deletedBy?: string; reason?: string; }
export interface RoleRegistryImport { schemaVersion: 1; exportedAt: string; records: readonly RoleRegistryRecord[]; }
export interface RoleRegistryExportQuery { scope?: RoleScope; includeTombstones?: boolean; }
export interface RoleRegistryExport { schemaVersion: 1; exportedAt: string; records: readonly RoleRegistryRecord[]; fingerprint: Fingerprint; }

/** Resolver input is task-first: a role cannot be resolved from a bare task id. */
export interface RoleResolveInput {
	schemaVersion: 1;
	task: TaskEnvelope;
	roleId: string;
	scope: RoleScope;
	modelProfile: ModelProfile;
	orderedLayers: readonly RoleResolutionLayer[];
	contextRevision?: RevisionReference;
	externalAgentBindingRevision?: RevisionReference;
	capabilityRevision?: RevisionReference;
	modelBrokerBindingRevision?: RevisionReference;
	policyRevision?: RevisionReference;
	mcpSelection?: McpSelection;
	overrides?: readonly RoleResolutionOverride[];
	bindingId?: string;
	now?: () => string;
}

export interface RoleResolver {
	resolve(input: RoleResolveInput): ResultValue<RoleResolutionPreview, FoundationError>;
}

/**
 * Public role registry surface. Implementations may be local or remote; this contract contains no
 * persistence algorithm. `edit` and `copy` create immutable revisions, and `delete` creates a
 * tombstone. `scope` is always explicit so Global/Project overrides retain the stable roleId.
 */
export interface RoleRegistry extends RoleResolver {
	create(input: RoleRegistryCreateInput): ResultValue<RoleRegistryRecord, FoundationError>;
	get(query: RoleRegistryGetQuery): ResultValue<RoleRegistryRecord, FoundationError>;
	list(query?: RoleRegistryListQuery): ResultValue<readonly RoleRegistryRecord[], FoundationError>;
	search(query: RoleRegistrySearchQuery): ResultValue<readonly RoleRegistryRecord[], FoundationError>;
	edit(input: RoleRegistryEditInput): ResultValue<RoleRegistryRecord, FoundationError>;
	copy(input: RoleRegistryCopyInput): ResultValue<RoleRegistryRecord, FoundationError>;
	delete(input: RoleRegistryDeleteInput): ResultValue<RoleTombstone, FoundationError>;
	import(input: RoleRegistryImport): ResultValue<readonly RoleRegistryRecord[], FoundationError>;
	export(query?: RoleRegistryExportQuery): ResultValue<RoleRegistryExport, FoundationError>;
}

const roleScopeSchema = Type.Union([Type.Literal("global"), Type.Literal("project")]);
const roleTraceSchema = Type.Object({ field: Type.String({ minLength: 1 }), layer: Type.Union(ROLE_RESOLUTION_ORDER.map((layer) => Type.Literal(layer))), referenceId: Type.String({ minLength: 1 }), revision: Type.Optional(Type.Integer({ minimum: 0 })), overrideReason: Type.Optional(Type.String()) }, { additionalProperties: false });
export const RoleResolutionLayerSchema = Type.Object({ schemaVersion: Type.Literal(1), layer: Type.Union(ROLE_RESOLUTION_ORDER.map((layer) => Type.Literal(layer))), ordinal: Type.Integer({ minimum: 0 }), referenceId: Type.String({ minLength: 1 }), revision: Type.Integer({ minimum: 0 }), overrideReason: Type.String({ minLength: 1 }) }, { additionalProperties: false });
export const RoleResolvedFieldSchema = Type.Object({ schemaVersion: Type.Literal(1), field: Type.String({ minLength: 1 }), source: roleTraceSchema, revision: Type.Integer({ minimum: 0 }), overrideReason: Type.String({ minLength: 1 }), safeValue: FoundationJsonValueSchema, conflict: Type.Optional(Type.Object({ field: Type.String({ minLength: 1 }), source: roleTraceSchema, conflictsWith: roleTraceSchema }, { additionalProperties: false })) }, { additionalProperties: false });
export const RoleTombstoneSchema = Type.Object({ schemaVersion: Type.Literal(1), roleId: Type.String({ minLength: 1 }), scope: roleScopeSchema, deletedRevision: Type.Integer({ minimum: 0 }), deletedAt: Type.String({ minLength: 1 }), deletedBy: Type.Optional(Type.String({ minLength: 1 })), reason: Type.Optional(Type.String()) }, { additionalProperties: false });
export const RoleRegistryRecordSchema = Type.Object({ schemaVersion: Type.Literal(1), roleId: Type.String({ minLength: 1 }), scope: roleScopeSchema, definition: RoleDefinitionSchema, currentRevision: RoleRevisionSchema, revisions: Type.Array(RoleRevisionSchema), tombstone: Type.Optional(RoleTombstoneSchema) }, { additionalProperties: false });
export const RoleRegistryCreateInputSchema = Type.Object({ definition: RoleDefinitionSchema }, { additionalProperties: false });
export const RoleRegistryGetQuerySchema = Type.Object({ roleId: Type.String({ minLength: 1 }), scope: Type.Optional(roleScopeSchema), includeTombstone: Type.Optional(Type.Boolean()), revision: Type.Optional(Type.Integer({ minimum: 0 })) }, { additionalProperties: false });
export const RoleRegistryListQuerySchema = Type.Object({ scope: Type.Optional(roleScopeSchema), includeTombstones: Type.Optional(Type.Boolean()) }, { additionalProperties: false });
export const RoleRegistrySearchQuerySchema = Type.Object({ text: Type.String(), scope: Type.Optional(roleScopeSchema), includeTombstones: Type.Optional(Type.Boolean()) }, { additionalProperties: false });
export const RoleDefinitionPatchSchema = Type.Object({ name: Type.Optional(Type.String()), description: Type.Optional(Type.String()), whenToUse: Type.Optional(Type.String()), persona: Type.Optional(Type.String()), customInstructions: Type.Optional(Type.String()), modelProfileRef: Type.Optional(VersionedReferenceSchema), capabilitySelector: Type.Optional(ResourceSelectorSchema), skillSelector: Type.Optional(ResourceSelectorSchema), mcpSelector: Type.Optional(ResourceSelectorSchema), contextPolicyRef: Type.Optional(VersionedReferenceSchema), memoryPolicyRef: Type.Optional(VersionedReferenceSchema), executionPolicyRef: Type.Optional(VersionedReferenceSchema), resultPolicyRef: Type.Optional(VersionedReferenceSchema), overridesRoleId: Type.Optional(Type.String({ minLength: 1 })) }, { additionalProperties: false });
export const RoleRegistryEditInputSchema = Type.Object({ roleId: Type.String({ minLength: 1 }), scope: roleScopeSchema, expectedRevision: Type.Integer({ minimum: 0 }), patch: RoleDefinitionPatchSchema }, { additionalProperties: false });
export const RoleRegistryCopyInputSchema = Type.Object({ sourceRoleId: Type.String({ minLength: 1 }), sourceScope: roleScopeSchema, targetRoleId: Type.String({ minLength: 1 }), targetScope: roleScopeSchema, expectedRevision: Type.Integer({ minimum: 0 }) }, { additionalProperties: false });
export const RoleRegistryDeleteInputSchema = Type.Object({ roleId: Type.String({ minLength: 1 }), scope: roleScopeSchema, expectedRevision: Type.Integer({ minimum: 0 }), deletedAt: Type.String({ minLength: 1 }), deletedBy: Type.Optional(Type.String({ minLength: 1 })), reason: Type.Optional(Type.String()) }, { additionalProperties: false });
export const RoleRegistryImportSchema = Type.Object({ schemaVersion: Type.Literal(1), exportedAt: Type.String({ minLength: 1 }), records: Type.Array(RoleRegistryRecordSchema) }, { additionalProperties: false });
export const RoleRegistryExportQuerySchema = Type.Object({ scope: Type.Optional(roleScopeSchema), includeTombstones: Type.Optional(Type.Boolean()) }, { additionalProperties: false });
export const RoleRegistryExportSchema = Type.Object({ schemaVersion: Type.Literal(1), exportedAt: Type.String({ minLength: 1 }), records: Type.Array(RoleRegistryRecordSchema), fingerprint: Type.Object({ algorithm: Type.Literal("sha256"), value: Type.String({ minLength: 1 }) }, { additionalProperties: false }) }, { additionalProperties: false });
export const RoleResolutionOverrideSchema = Type.Object({ schemaVersion: Type.Literal(1), layer: Type.Union(ROLE_RESOLUTION_ORDER.map((layer) => Type.Literal(layer))), referenceId: Type.String({ minLength: 1 }), revision: Type.Integer({ minimum: 0 }), overrideReason: Type.String({ minLength: 1 }), roleRevision: Type.Optional(RoleRevisionSchema), modelProfile: Type.Optional(ModelProfileSchema), modelRoute: Type.Optional(ModelRouteSchema), capabilitySelector: Type.Optional(ResourceSelectorSchema), budget: Type.Optional(BudgetSchema), contextRevision: Type.Optional(RevisionReferenceSchema), externalAgentBindingRevision: Type.Optional(RevisionReferenceSchema), modelBrokerBindingRevision: Type.Optional(RevisionReferenceSchema), policyRevision: Type.Optional(RevisionReferenceSchema) }, { additionalProperties: false });
export const RoleResolveInputSchema = Type.Object({ schemaVersion: Type.Literal(1), task: TaskEnvelopeSchema, roleId: Type.String({ minLength: 1 }), scope: roleScopeSchema, modelProfile: ModelProfileSchema, orderedLayers: Type.Array(RoleResolutionLayerSchema), contextRevision: Type.Optional(RevisionReferenceSchema), externalAgentBindingRevision: Type.Optional(RevisionReferenceSchema), capabilityRevision: Type.Optional(RevisionReferenceSchema), modelBrokerBindingRevision: Type.Optional(RevisionReferenceSchema), policyRevision: Type.Optional(RevisionReferenceSchema), mcpSelection: Type.Optional(McpSelectionSchema), overrides: Type.Optional(Type.Array(RoleResolutionOverrideSchema)), bindingId: Type.Optional(Type.String({ minLength: 1 })) }, { additionalProperties: false });
export const RoleResolutionPreviewSchema = Type.Object({ schemaVersion: Type.Literal(1), taskId: Type.String({ minLength: 1 }), roleId: Type.String({ minLength: 1 }), roleRevision: RevisionReferenceSchema, modelProfileRevision: RevisionReferenceSchema, modelRoute: ModelRouteSchema, contextRevision: RevisionReferenceSchema, capabilityRevision: RevisionReferenceSchema, modelBrokerBindingRevision: RevisionReferenceSchema, policyRevision: RevisionReferenceSchema, capabilitySelector: ResourceSelectorSchema, budget: BudgetSchema, orderedLayers: Type.Array(RoleResolutionLayerSchema), fields: Type.Array(RoleResolvedFieldSchema), sourceTrace: Type.Array(roleTraceSchema), conflicts: Type.Array(Type.Object({ field: Type.String({ minLength: 1 }), source: roleTraceSchema, conflictsWith: roleTraceSchema }, { additionalProperties: false })), binding: AgentBindingSchema, fingerprint: Type.Object({ algorithm: Type.Literal("sha256"), value: Type.String({ minLength: 1 }) }, { additionalProperties: false }) }, { additionalProperties: false });
export function validateRoleResolutionLayer(value: unknown): ResultValue<RoleResolutionLayer, FoundationError> { return validateExactShape<RoleResolutionLayer>(RoleResolutionLayerSchema, value, "role_resolution_layer"); }
export function serializeRoleResolutionLayer(value: RoleResolutionLayer): string { return serializeExactShape(RoleResolutionLayerSchema, value, "role_resolution_layer"); }
export function parseRoleResolutionLayer(text: string): ResultValue<RoleResolutionLayer, FoundationError> { return parseExactShape(RoleResolutionLayerSchema, text, "role_resolution_layer"); }
export function validateRoleRegistryRecord(value: unknown): ResultValue<RoleRegistryRecord, FoundationError> { return validateExactShape<RoleRegistryRecord>(RoleRegistryRecordSchema, value, "role_registry_record"); }
export function serializeRoleRegistryRecord(value: RoleRegistryRecord): string { return serializeExactShape(RoleRegistryRecordSchema, value, "role_registry_record"); }
export function parseRoleRegistryRecord(text: string): ResultValue<RoleRegistryRecord, FoundationError> { return parseExactShape(RoleRegistryRecordSchema, text, "role_registry_record"); }
export function validateRoleResolutionPreview(value: unknown): ResultValue<RoleResolutionPreview, FoundationError> { return validateExactShape<RoleResolutionPreview>(RoleResolutionPreviewSchema, value, "role_resolution_preview"); }
export function serializeRoleResolutionPreview(value: RoleResolutionPreview): string { return serializeExactShape(RoleResolutionPreviewSchema, value, "role_resolution_preview"); }
export function parseRoleResolutionPreview(text: string): ResultValue<RoleResolutionPreview, FoundationError> { return parseExactShape(RoleResolutionPreviewSchema, text, "role_resolution_preview"); }
export function validateRoleResolveInput(value: unknown): ResultValue<RoleResolveInput, FoundationError> { return validateExactShape<RoleResolveInput>(RoleResolveInputSchema, value, "role_resolve_input"); }
export function serializeRoleResolveInput(value: RoleResolveInput): string { return serializeExactShape(RoleResolveInputSchema, value, "role_resolve_input"); }
export function parseRoleResolveInput(text: string): ResultValue<RoleResolveInput, FoundationError> { return parseExactShape<RoleResolveInput>(RoleResolveInputSchema, text, "role_resolve_input"); }

/** Reject reordered or duplicate precedence layers before a Resolver consumes them. */
export function validateRoleResolutionOrder(layers: readonly RoleResolutionLayer[]): ResultValue<readonly RoleResolutionLayer[], FoundationError> {
	if (layers.length !== ROLE_RESOLUTION_ORDER.length) return Result.err(new FoundationError("role_resolver_order_invalid", "Role resolution must include every frozen precedence layer exactly once", { details: { expected: [...ROLE_RESOLUTION_ORDER], actual: layers.map((layer) => layer.layer) } }));
	const seen = new Set<string>();
	for (const [ordinal, layer] of layers.entries()) {
		const index = ROLE_RESOLUTION_ORDER.indexOf(layer.layer as RoleResolutionOrder);
		if (index < 0 || seen.has(layer.layer) || index !== ordinal || layer.ordinal !== ordinal) return Result.err(new FoundationError("role_resolver_order_invalid", "Role resolution layers must follow the frozen precedence order without duplicates", { details: { layer: layer.layer, ordinal } }));
		seen.add(layer.layer);
	}
	return Result.ok(layers);
}

/** Lower-precedence scopes may narrow but never widen the managed-lock selector. */
export function validateRoleSelectorTightening(parent: ResourceSelector, child: ResourceSelector, field = "capabilitySelector"): ResultValue<ResourceSelector, FoundationError> {
	return selectorsNarrow(parent, child) ? Result.ok(child) : Result.err(new FoundationError("role_resolver_scope_widened", "A lower-precedence selector cannot widen its parent scope", { details: { field } }));
}
export function validateRoleScopeTightening(parent: { capabilitySelector: ResourceSelector; policySelector: ResourceSelector }, child: { capabilitySelector: ResourceSelector; policySelector: ResourceSelector }): ResultValue<typeof child, FoundationError> {
	if (!selectorsNarrow(parent.capabilitySelector, child.capabilitySelector)) return Result.err(new FoundationError("role_resolver_scope_widened", "A lower-precedence capability selector cannot widen its parent scope", { details: { field: "capabilitySelector" } }));
	if (!selectorsNarrow(parent.policySelector, child.policySelector)) return Result.err(new FoundationError("role_resolver_scope_widened", "A lower-precedence policy selector cannot widen its parent scope", { details: { field: "policySelector" } }));
	return Result.ok(child);
}

/** Safe preview values are redacted before crossing the public resolver boundary. */
export function redactRoleResolutionValue(value: JsonValue): JsonValue {
	return redactProjection(value) as JsonValue;
}

/** Shared precondition used by registry and resolver implementations. */
export function requireRoleResolutionTask(task: TaskEnvelope | undefined): ResultValue<TaskEnvelope, FoundationError> {
	return task?.taskId ? Result.ok(task) : Result.err(new FoundationError("role_resolver_task_required", "Role resolution requires a persisted TaskEnvelope", { details: { reason: "task_before_binding" } }));
}

/** Build a deterministic preview fingerprint from its public fields. */
export function fingerprintRoleResolutionPreview(preview: Omit<RoleResolutionPreview, "fingerprint">): Fingerprint {
	return fingerprintFoundationValue(preview);
}

function registryKey(roleId: string, scope: RoleScope): string {
	return `${scope}\u001f${roleId}`;
}

function registryFailure(code: FoundationError["code"], message: string, details?: Record<string, string | number>): ResultValue<never, FoundationError> {
	return Result.err(new FoundationError(code, message, details === undefined ? {} : { details: details as never }));
}

function copyRecord(record: RoleRegistryRecord): RoleRegistryRecord {
	return cloneDeepFrozen(record);
}

/**
 * A deterministic contract implementation for hosts that do not yet have a durable Role store.
 * Every edit replaces the record with a frozen snapshot; delete only adds a tombstone.
 */
export class InMemoryRoleRegistry implements RoleRegistry {
	private readonly records = new Map<string, RoleRegistryRecord>();
	private readonly now: () => string;

	constructor(options: { now?: () => string } = {}) {
		this.now = options.now ?? (() => new Date().toISOString());
	}

	create(input: RoleRegistryCreateInput): ResultValue<RoleRegistryRecord, FoundationError> {
		const definition = validateRoleDefinition(input.definition);
		if (!definition.ok) return definition;
		const key = registryKey(definition.value.roleId, definition.value.scope);
		if (this.records.has(key)) return registryFailure("role_slug_conflict", "Role identity is already registered", { roleId: definition.value.roleId, scope: definition.value.scope });
		const revision = createRoleRevision({ definition: definition.value, now: this.now });
		const record = cloneDeepFrozen({ schemaVersion: 1 as const, roleId: definition.value.roleId, scope: definition.value.scope, definition: definition.value, currentRevision: revision, revisions: [revision] });
		this.records.set(key, record);
		return Result.ok(copyRecord(record));
	}

	get(query: RoleRegistryGetQuery): ResultValue<RoleRegistryRecord, FoundationError> {
		const candidates = query.scope === undefined ? ["project", "global"] as const : [query.scope];
		for (const scope of candidates) {
			const record = this.records.get(registryKey(query.roleId, scope));
			if (record === undefined) continue;
			if (record.tombstone !== undefined && query.includeTombstone !== true) continue;
			if (query.revision === undefined) return Result.ok(copyRecord(record));
			const revision = record.revisions.find((candidate) => candidate.revision === query.revision);
			if (revision === undefined) return registryFailure("role_revision_immutable", "Requested role revision is not registered", { roleId: query.roleId, revision: query.revision });
			return Result.ok(copyRecord({ ...record, currentRevision: revision }));
		}
		return registryFailure("role_not_found", "Role is not registered", { roleId: query.roleId });
	}

	list(query: RoleRegistryListQuery = {}): ResultValue<readonly RoleRegistryRecord[], FoundationError> {
		const records = [...this.records.values()]
			.filter((record) => query.scope === undefined || record.scope === query.scope)
			.filter((record) => query.includeTombstones === true || record.tombstone === undefined)
			.sort(compareRecords)
			.map(copyRecord);
		return Result.ok(records);
	}

	search(query: RoleRegistrySearchQuery): ResultValue<readonly RoleRegistryRecord[], FoundationError> {
		const text = query.text.trim().toLocaleLowerCase();
		const listed = this.list({ scope: query.scope, includeTombstones: query.includeTombstones });
		if (!listed.ok || text.length === 0) return listed;
		return Result.ok(listed.value.filter((record) => {
			const fields = [record.roleId, record.definition.slug, record.definition.name, record.definition.description, record.definition.persona];
			return fields.some((field) => field.toLocaleLowerCase().includes(text));
		}));
	}

	edit(input: RoleRegistryEditInput): ResultValue<RoleRegistryRecord, FoundationError> {
		const current = this.get({ roleId: input.roleId, scope: input.scope, includeTombstone: true });
		if (!current.ok) return current;
		if (current.value.tombstone !== undefined) return registryFailure("role_not_found", "Cannot edit a tombstoned role", { roleId: input.roleId });
		if (current.value.currentRevision.revision !== input.expectedRevision) return registryFailure("role_revision_immutable", "Role revision does not match the expected revision", { roleId: input.roleId, expectedRevision: input.expectedRevision });
		const patch = input.patch;
		const nextDefinition: RoleDefinition = {
			...current.value.definition,
			...patch,
			revision: current.value.currentRevision.revision,
			roleId: current.value.roleId,
			scope: current.value.scope,
			slug: current.value.definition.slug,
		};
		const nextRevision = createRoleRevision({ definition: nextDefinition, previous: current.value.currentRevision, now: this.now });
		const next = cloneDeepFrozen({ ...current.value, definition: nextDefinition, currentRevision: nextRevision, revisions: [...current.value.revisions, nextRevision] });
		this.records.set(registryKey(input.roleId, input.scope), next);
		return Result.ok(copyRecord(next));
	}

	copy(input: RoleRegistryCopyInput): ResultValue<RoleRegistryRecord, FoundationError> {
		const source = this.get({ roleId: input.sourceRoleId, scope: input.sourceScope });
		if (!source.ok) return source;
		if (source.value.currentRevision.revision !== input.expectedRevision) return registryFailure("role_revision_immutable", "Source role revision does not match the expected revision", { roleId: input.sourceRoleId });
		const targetKey = registryKey(input.targetRoleId, input.targetScope);
		if (this.records.has(targetKey)) return registryFailure("role_slug_conflict", "Target role identity is already registered", { roleId: input.targetRoleId });
		const definition: RoleDefinition = { ...source.value.definition, roleId: input.targetRoleId, scope: input.targetScope, overridesRoleId: input.targetScope === "global" ? undefined : source.value.definition.overridesRoleId, revision: 0 };
		return this.create({ definition });
	}

	delete(input: RoleRegistryDeleteInput): ResultValue<RoleTombstone, FoundationError> {
		const current = this.get({ roleId: input.roleId, scope: input.scope, includeTombstone: true });
		if (!current.ok) return current;
		if (current.value.tombstone !== undefined) return Result.ok(current.value.tombstone);
		if (current.value.currentRevision.revision !== input.expectedRevision) return registryFailure("role_revision_immutable", "Role revision does not match the expected revision", { roleId: input.roleId, expectedRevision: input.expectedRevision });
		const tombstone: RoleTombstone = cloneDeepFrozen({ schemaVersion: 1, roleId: input.roleId, scope: input.scope, deletedRevision: current.value.currentRevision.revision, deletedAt: input.deletedAt, ...(input.deletedBy === undefined ? {} : { deletedBy: input.deletedBy }), ...(input.reason === undefined ? {} : { reason: input.reason }) });
		const next = cloneDeepFrozen({ ...current.value, tombstone });
		this.records.set(registryKey(input.roleId, input.scope), next);
		return Result.ok(tombstone);
	}

	import(input: RoleRegistryImport): ResultValue<readonly RoleRegistryRecord[], FoundationError> {
		const checked = validateExactShape<RoleRegistryImport>(RoleRegistryImportSchema, input, "role_registry_import");
		if (!checked.ok) return checked;
		const next = new Map<string, RoleRegistryRecord>();
		for (const record of checked.value.records) {
			const valid = validateRoleRegistryRecord(record);
			if (!valid.ok) return valid;
			const key = registryKey(record.roleId, record.scope);
			if (next.has(key)) return registryFailure("role_slug_conflict", "Role import contains duplicate identities", { roleId: record.roleId });
			next.set(key, cloneDeepFrozen(record));
		}
		this.records.clear();
		for (const [key, record] of next) this.records.set(key, record);
		return this.list({ includeTombstones: true });
	}

	export(query: RoleRegistryExportQuery = {}): ResultValue<RoleRegistryExport, FoundationError> {
		const listed = this.list({ scope: query.scope, includeTombstones: query.includeTombstones });
		if (!listed.ok) return listed;
		const exportedAt = this.now();
		const base = { schemaVersion: 1 as const, exportedAt, records: listed.value };
		return Result.ok(cloneDeepFrozen({ ...base, fingerprint: fingerprintFoundationValue(base) }));
	}

	resolve(input: RoleResolveInput): ResultValue<RoleResolutionPreview, FoundationError> {
		const record = this.get({ roleId: input.roleId, scope: input.scope });
		if (!record.ok) return record;
		if (record.value.tombstone !== undefined) return registryFailure("role_not_found", "Cannot resolve a tombstoned role", { roleId: input.roleId });
		return resolveRoleResolution({ ...input, roleRevision: record.value.currentRevision, now: input.now ?? this.now });
	}
}

function compareRecords(left: RoleRegistryRecord, right: RoleRegistryRecord): number {
	const scopeOrder = left.scope === right.scope ? 0 : left.scope === "global" ? -1 : 1;
	return scopeOrder || left.roleId.localeCompare(right.roleId);
}

export interface RoleResolutionInput extends RoleResolveInput {
	roleRevision?: RoleRevision;
}

/** Resolve all precedence layers into a redacted preview and immutable AgentBinding. */
export function resolveRoleResolution(input: RoleResolutionInput): ResultValue<RoleResolutionPreview, FoundationError> {
	const task = requireRoleResolutionTask(input.task);
	if (!task.ok) return task;
	const order = validateRoleResolutionOrder(input.orderedLayers);
	if (!order.ok) return order;
	const role = input.roleRevision;
	if (role === undefined) return registryFailure("role_not_found", "Role resolution requires a role revision", { roleId: input.roleId });
	if (role.roleId !== input.roleId) return registryFailure("role_resolver_conflict", "Role revision source does not match the requested role", { roleId: input.roleId });
	const model = input.modelProfile;
	const overrides = input.overrides ?? [];
	const overrideByLayer = new Map(overrides.map((override) => [override.layer, override]));
	if (new Set(overrides.map((override) => override.layer)).size !== overrides.length) return registryFailure("role_resolver_conflict", "Role resolution cannot apply a layer twice", { roleId: input.roleId });
	let effectiveRole = role;
	let effectiveModel = model;
	let effectiveSelector: ResourceSelector = { policy: "all" };
	let effectiveBudget = mergeBudget(model.budget, task.value.budget);
	let effectiveRoute: ModelRoute = routeFromModel(model);
	if (input.externalAgentBindingRevision !== undefined && input.contextRevision !== undefined && canonicalFoundationJson(input.externalAgentBindingRevision) !== canonicalFoundationJson(input.contextRevision)) return registryFailure("binding_required_fact", "Role resolution received conflicting External-Agent Binding aliases", { roleId: input.roleId });
	let effectiveContext = input.externalAgentBindingRevision ?? input.contextRevision;
	const effectiveCapability = input.capabilityRevision;
	let effectiveModelBroker = input.modelBrokerBindingRevision;
	let effectivePolicy = input.policyRevision;
	if (effectiveContext === undefined || effectiveCapability === undefined || effectiveModelBroker === undefined || effectivePolicy === undefined) {
		return registryFailure("binding_required_fact", "Role resolution requires all four existing immutable binding facts", { roleId: input.roleId, taskId: task.value.taskId });
	}
	const values = new Map<string, { value: unknown; source: BindingSourceTrace }>();
	const conflicts: BindingConflict[] = [];
	const trace: BindingSourceTrace[] = [];
	const addValue = (field: string, value: unknown, source: BindingSourceTrace): void => {
		const previous = values.get(field);
		if (previous !== undefined && fingerprintFoundationValue(previous.value).value !== fingerprintFoundationValue(value).value) conflicts.push({ field, source, conflictsWith: previous.source });
		values.set(field, { value, source });
	};
	const baseLayer = role.scope === "global" ? "global" : "project";
	const baseSource = (field: string): BindingSourceTrace => ({ field, layer: baseLayer, referenceId: role.roleRevisionId, revision: role.revision });
	addValue("roleRevision", { id: role.roleRevisionId, revision: role.revision }, baseSource("roleRevision"));
	addValue("modelProfileRevision", { id: model.modelProfileId, revision: model.revision }, { field: "modelProfileRevision", layer: baseLayer, referenceId: model.modelProfileId, revision: model.revision });
	addValue("modelRoute", effectiveRoute, baseSource("modelRoute"));
	addValue("budget", effectiveBudget, { field: "budget", layer: "task", referenceId: task.value.taskId });
	addValue("contextRevision", effectiveContext, baseSource("contextRevision"));
	addValue("capabilityRevision", effectiveCapability, { field: "capabilityRevision", layer: "task", referenceId: task.value.taskId, revision: effectiveCapability.revision });
	addValue("modelBrokerBindingRevision", effectiveModelBroker, { field: "modelBrokerBindingRevision", layer: baseLayer, referenceId: effectiveModelBroker.id, revision: effectiveModelBroker.revision });
	addValue("policyRevision", effectivePolicy, baseSource("policyRevision"));
	let roleSelectorApplied = false;
	for (const layer of order.value) {
		if (layer.layer === baseLayer) {
			const narrowed = validateRoleSelectorTightening(effectiveSelector, role.capabilitySelector);
			if (!narrowed.ok) return narrowed;
			effectiveSelector = narrowed.value;
			addValue("capabilitySelector", effectiveSelector, baseSource("capabilitySelector"));
			roleSelectorApplied = true;
		}
		const override = overrideByLayer.get(layer.layer);
		if (override === undefined) continue;
		const source = (field: string): BindingSourceTrace => ({ field, layer: override.layer, referenceId: override.referenceId, revision: override.revision, overrideReason: override.overrideReason });
		if (override.roleRevision !== undefined) {
			const scopedRoleOverride = override.layer === "global" || override.layer === "project";
			if (override.roleRevision.roleId !== input.roleId || scopedRoleOverride && override.roleRevision.scope !== override.layer || override.roleRevision.roleRevisionId !== override.referenceId || override.roleRevision.revision !== override.revision) return registryFailure("role_resolver_conflict", "Role override source must identify the immutable RoleRevision for its layer", { roleId: input.roleId });
			const narrowed = validateRoleSelectorTightening(effectiveSelector, override.roleRevision.capabilitySelector);
			if (!narrowed.ok) return narrowed;
			effectiveSelector = narrowed.value;
			roleSelectorApplied = true;
			effectiveRole = override.roleRevision;
			addValue("roleRevision", { id: effectiveRole.roleRevisionId, revision: effectiveRole.revision }, source("roleRevision"));
			addValue("capabilitySelector", effectiveSelector, source("capabilitySelector"));
		}
		if (override.modelProfile !== undefined) {
			if (override.modelProfile.modelProfileId !== override.referenceId || override.modelProfile.revision !== override.revision) return registryFailure("role_resolver_conflict", "Model Profile override source must identify its immutable revision", { roleId: input.roleId });
			effectiveModel = override.modelProfile;
			effectiveRoute = routeFromModel(effectiveModel);
			addValue("modelProfileRevision", { id: effectiveModel.modelProfileId, revision: effectiveModel.revision }, source("modelProfileRevision"));
			addValue("modelRoute", effectiveRoute, source("modelRoute"));
		}
		if (override.modelRoute !== undefined) { effectiveRoute = { ...override.modelRoute }; addValue("modelRoute", effectiveRoute, source("modelRoute")); }
		if (override.capabilitySelector !== undefined) {
			const narrowed = validateRoleSelectorTightening(effectiveSelector, override.capabilitySelector);
			if (!narrowed.ok) return narrowed;
			effectiveSelector = narrowed.value;
			addValue("capabilitySelector", effectiveSelector, source("capabilitySelector"));
		}
		if (override.budget !== undefined) { effectiveBudget = mergeBudget(effectiveBudget, override.budget); addValue("budget", effectiveBudget, source("budget")); }
		if (override.externalAgentBindingRevision !== undefined && override.contextRevision !== undefined && canonicalFoundationJson(override.externalAgentBindingRevision) !== canonicalFoundationJson(override.contextRevision)) return registryFailure("role_resolver_conflict", "External-Agent Binding override aliases conflict", { roleId: input.roleId });
		const externalAgentBindingRevision = override.externalAgentBindingRevision ?? override.contextRevision;
		if (externalAgentBindingRevision !== undefined) {
			if (externalAgentBindingRevision.type !== "external_agent_binding" || externalAgentBindingRevision.id !== override.referenceId || externalAgentBindingRevision.revision !== override.revision || externalAgentBindingRevision.fingerprint === undefined) return registryFailure("role_resolver_conflict", "External-Agent Binding override must identify its immutable source revision", { roleId: input.roleId });
			effectiveContext = externalAgentBindingRevision;
			addValue("contextRevision", effectiveContext, source("contextRevision"));
		}
		if (override.modelBrokerBindingRevision !== undefined) {
			if (override.modelBrokerBindingRevision.type !== "model_broker_binding" || override.modelBrokerBindingRevision.id !== override.referenceId || override.modelBrokerBindingRevision.revision !== override.revision || override.modelBrokerBindingRevision.fingerprint === undefined) return registryFailure("role_resolver_conflict", "ModelBroker Binding override must identify its immutable source revision", { roleId: input.roleId });
			effectiveModelBroker = override.modelBrokerBindingRevision;
			addValue("modelBrokerBindingRevision", effectiveModelBroker, source("modelBrokerBindingRevision"));
		}
		if (override.policyRevision !== undefined) {
			if (override.policyRevision.type !== "policy_binding" || override.policyRevision.id !== override.referenceId || override.policyRevision.revision !== override.revision || override.policyRevision.fingerprint === undefined) return registryFailure("role_resolver_conflict", "Policy Binding override must identify its immutable source revision", { roleId: input.roleId });
			effectivePolicy = override.policyRevision;
			addValue("policyRevision", effectivePolicy, source("policyRevision"));
		}
	}
	if (!roleSelectorApplied) return registryFailure("role_resolver_conflict", "Role resolution did not apply its immutable RoleRevision selector", { roleId: input.roleId });
	if (effectiveContext === undefined || effectiveModelBroker === undefined || effectivePolicy === undefined) return registryFailure("binding_required_fact", "Role resolution lost a required immutable binding fact", { roleId: input.roleId });
	for (const item of values.values()) trace.push(item.source);
	const binding = resolveAgentBinding({ task: task.value, roleRevision: effectiveRole, modelProfile: effectiveModel, modelRoute: effectiveRoute, contextRevision: effectiveContext, capabilityRevision: effectiveCapability, modelBrokerBindingRevision: effectiveModelBroker, policyRevision: effectivePolicy, mcpSelection: input.mcpSelection, budget: effectiveBudget, sourceTrace: trace, conflicts, newBindingId: input.bindingId ?? newFoundationId("binding"), now: input.now });
	if (!binding.ok) return binding;
	const fields = [...values.entries()].map(([field, item]) => ({ schemaVersion: 1 as const, field, source: item.source, revision: item.source.revision ?? 1, overrideReason: item.source.overrideReason ?? "resolved", safeValue: redactRoleResolutionValue(item.value as JsonValue) }));
	const previewBase: Omit<RoleResolutionPreview, "fingerprint"> = { schemaVersion: 1, taskId: task.value.taskId, roleId: effectiveRole.roleId, roleRevision: binding.value.roleRevision, modelProfileRevision: binding.value.modelProfileRevision, modelRoute: binding.value.modelRoute, contextRevision: binding.value.contextRevision, capabilityRevision: binding.value.capabilityRevision, modelBrokerBindingRevision: binding.value.modelBrokerBindingRevision, policyRevision: binding.value.policyRevision, capabilitySelector: binding.value.capabilitySelector, budget: binding.value.budget, orderedLayers: order.value, fields, sourceTrace: binding.value.sourceTrace, conflicts: binding.value.conflicts, binding: binding.value };
	return Result.ok(cloneDeepFrozen({ ...previewBase, fingerprint: fingerprintRoleResolutionPreview(previewBase) }));
}

function routeFromModel(model: ModelProfile): ModelRoute {
	return { provider: model.provider, model: model.model, ...(model.effort === undefined ? {} : { effort: model.effort }), ...(model.serviceTier === undefined ? {} : { serviceTier: model.serviceTier }), ...(model.fallback === undefined ? {} : { fallback: model.fallback.map((route) => ({ ...route })) }) };
}

function mergeBudget(left: TaskEnvelope["budget"], right: TaskEnvelope["budget"]): TaskEnvelope["budget"] {
	const result: TaskEnvelope["budget"] = {};
	for (const key of ["tokens", "costUsd", "modelCalls", "toolCalls", "wallClockMs", "concurrency"] as const) {
		const a = left[key];
		const b = right[key];
		if (a !== undefined || b !== undefined) result[key] = a === undefined ? b : b === undefined ? a : Math.min(a, b);
	}
	return result;
}

export class DeterministicRoleResolver implements RoleResolver {
	private readonly registry: RoleRegistry;
	constructor(registry: RoleRegistry) { this.registry = registry; }
	resolve(input: RoleResolveInput): ResultValue<RoleResolutionPreview, FoundationError> { return this.registry.resolve(input); }
}
