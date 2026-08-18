import { Result, type Result as ResultValue } from "../result.ts";
import { Type } from "typebox";
import type { JsonValue } from "../session/types.ts";
import { FoundationError, redactProjection } from "./errors.ts";
import { canonicalFoundationJson, fingerprintFoundationValue, newFoundationId, type FingerprintV1 } from "./identity.ts";
import { cloneDeepFrozen } from "./immutability.ts";
import { AgentBindingV1Schema, ModelProfileV1Schema, ModelRouteV1Schema, RoleDefinitionV1Schema, RoleRevisionV1Schema, createRoleRevision, resolveAgentBinding, validateRoleDefinitionV1, type ModelProfileV1, type AgentBindingV1, type BindingConflictV1, type BindingSourceTraceV1, type RoleDefinitionV1, type RoleRevisionV1, type RoleScopeV1, type ModelRouteV1 } from "./role.ts";
import { CapabilitySelectorV1Schema, ResourceSelectorV1Schema, RevisionReferenceV1Schema, selectorsNarrow, type CapabilitySelectorV1, type ResourceSelectorV1, type RevisionReferenceV1, type VersionedReferenceV1, VersionedReferenceV1Schema } from "./reference.ts";
import { TaskEnvelopeV1Schema, type TaskEnvelopeV1 } from "./task.ts";
import { BudgetV1Schema } from "./budget.ts";
import { FoundationJsonValueSchema, parseExactShape, serializeExactShape, validateExactShape } from "./schema.ts";

export interface RoleResolutionOverrideV1 {
	schemaVersion: 1;
	layer: RoleResolutionLayerNameV1;
	referenceId: string;
	revision: number;
	overrideReason: string;
	roleRevision?: RoleRevisionV1;
	modelProfile?: ModelProfileV1;
	modelRoute?: ModelRouteV1;
	capabilitySelector?: CapabilitySelectorV1;
	budget?: TaskEnvelopeV1["budget"];
	contextRevision?: RevisionReferenceV1;
	externalAgentBindingRevision?: RevisionReferenceV1;
	modelBrokerBindingRevision?: RevisionReferenceV1;
	policyRevision?: RevisionReferenceV1;
}

/** Ordered precedence layers used by the resolver; later layers may only tighten. */
export type RoleResolutionLayerNameV1 = BindingSourceTraceV1["layer"];
export const ROLE_RESOLUTION_ORDER_V1 = ["managed_lock", "global", "project", "path", "goal", "task", "run"] as const;
export type RoleResolutionOrderV1 = (typeof ROLE_RESOLUTION_ORDER_V1)[number];
export interface RoleResolutionLayerV1 {
	schemaVersion: 1;
	layer: RoleResolutionLayerNameV1;
	ordinal: number;
	referenceId: string;
	revision: number;
	overrideReason: string;
}

/** One resolved field with the source and conflict that produced its value. */
export interface RoleResolvedFieldV1 {
	schemaVersion: 1;
	field: string;
	source: BindingSourceTraceV1;
	revision: number;
	overrideReason: string;
	/** Only a redacted safe projection may be returned; raw prompts, paths, URLs and credentials are excluded. */
	safeValue: JsonValue;
	conflict?: BindingConflictV1;
}

export interface RoleResolutionPreviewV1 {
	schemaVersion: 1;
	taskId: string;
	roleId: string;
	roleRevision: RevisionReferenceV1;
	modelProfileRevision: RevisionReferenceV1;
	modelRoute: ModelRouteV1;
	contextRevision: RevisionReferenceV1;
	capabilityRevision: RevisionReferenceV1;
	modelBrokerBindingRevision: RevisionReferenceV1;
	policyRevision: RevisionReferenceV1;
	capabilitySelector: CapabilitySelectorV1;
	budget: TaskEnvelopeV1["budget"];
	orderedLayers: readonly RoleResolutionLayerV1[];
	fields: readonly RoleResolvedFieldV1[];
	sourceTrace: readonly BindingSourceTraceV1[];
	conflicts: readonly BindingConflictV1[];
	binding: AgentBindingV1;
	fingerprint: FingerprintV1;
}

export interface RoleRegistryRecordV1 {
	schemaVersion: 1;
	roleId: string;
	scope: RoleScopeV1;
	definition: RoleDefinitionV1;
	currentRevision: RoleRevisionV1;
	revisions: readonly RoleRevisionV1[];
	tombstone?: RoleTombstoneV1;
}

/** Delete is a durable tombstone; it never erases prior immutable revisions. */
export interface RoleTombstoneV1 {
	schemaVersion: 1;
	roleId: string;
	scope: RoleScopeV1;
	deletedRevision: number;
	deletedAt: string;
	deletedBy?: string;
	reason?: string;
}

export interface RoleRegistryCreateInputV1 { definition: RoleDefinitionV1; }
export interface RoleRegistryGetQueryV1 { roleId: string; scope?: RoleScopeV1; includeTombstone?: boolean; revision?: number; }
export interface RoleRegistryListQueryV1 { scope?: RoleScopeV1; includeTombstones?: boolean; }
export interface RoleRegistrySearchQueryV1 { text: string; scope?: RoleScopeV1; includeTombstones?: boolean; }
export interface RoleDefinitionPatchV1 {
	name?: string;
	description?: string;
	whenToUse?: string;
	persona?: string;
	customInstructions?: string;
	modelProfileRef?: VersionedReferenceV1;
	capabilitySelector?: CapabilitySelectorV1;
	skillSelector?: ResourceSelectorV1;
	mcpSelector?: ResourceSelectorV1;
	contextPolicyRef?: VersionedReferenceV1;
	memoryPolicyRef?: VersionedReferenceV1;
	executionPolicyRef?: VersionedReferenceV1;
	resultPolicyRef?: VersionedReferenceV1;
	overridesRoleId?: string;
}
export interface RoleRegistryEditInputV1 { roleId: string; scope: RoleScopeV1; expectedRevision: number; patch: RoleDefinitionPatchV1; }
export interface RoleRegistryCopyInputV1 { sourceRoleId: string; sourceScope: RoleScopeV1; targetRoleId: string; targetScope: RoleScopeV1; expectedRevision: number; }
export interface RoleRegistryDeleteInputV1 { roleId: string; scope: RoleScopeV1; expectedRevision: number; deletedAt: string; deletedBy?: string; reason?: string; }
export interface RoleRegistryImportV1 { schemaVersion: 1; exportedAt: string; records: readonly RoleRegistryRecordV1[]; }
export interface RoleRegistryExportQueryV1 { scope?: RoleScopeV1; includeTombstones?: boolean; }
export interface RoleRegistryExportV1 { schemaVersion: 1; exportedAt: string; records: readonly RoleRegistryRecordV1[]; fingerprint: FingerprintV1; }

/** Resolver input is task-first: a role cannot be resolved from a bare task id. */
export interface RoleResolveInputV1 {
	schemaVersion: 1;
	task: TaskEnvelopeV1;
	roleId: string;
	scope: RoleScopeV1;
	modelProfile: ModelProfileV1;
	orderedLayers: readonly RoleResolutionLayerV1[];
	contextRevision?: RevisionReferenceV1;
	externalAgentBindingRevision?: RevisionReferenceV1;
	capabilityRevision?: RevisionReferenceV1;
	modelBrokerBindingRevision?: RevisionReferenceV1;
	policyRevision?: RevisionReferenceV1;
	overrides?: readonly RoleResolutionOverrideV1[];
	bindingId?: string;
	now?: () => string;
}

export interface RoleResolverV1 {
	resolve(input: RoleResolveInputV1): ResultValue<RoleResolutionPreviewV1, FoundationError>;
}

/**
 * Public role registry surface. Implementations may be local or remote; this contract contains no
 * persistence algorithm. `edit` and `copy` create immutable revisions, and `delete` creates a
 * tombstone. `scope` is always explicit so Global/Project overrides retain the stable roleId.
 */
export interface RoleRegistryV1 extends RoleResolverV1 {
	create(input: RoleRegistryCreateInputV1): ResultValue<RoleRegistryRecordV1, FoundationError>;
	get(query: RoleRegistryGetQueryV1): ResultValue<RoleRegistryRecordV1, FoundationError>;
	list(query?: RoleRegistryListQueryV1): ResultValue<readonly RoleRegistryRecordV1[], FoundationError>;
	search(query: RoleRegistrySearchQueryV1): ResultValue<readonly RoleRegistryRecordV1[], FoundationError>;
	edit(input: RoleRegistryEditInputV1): ResultValue<RoleRegistryRecordV1, FoundationError>;
	copy(input: RoleRegistryCopyInputV1): ResultValue<RoleRegistryRecordV1, FoundationError>;
	delete(input: RoleRegistryDeleteInputV1): ResultValue<RoleTombstoneV1, FoundationError>;
	import(input: RoleRegistryImportV1): ResultValue<readonly RoleRegistryRecordV1[], FoundationError>;
	export(query?: RoleRegistryExportQueryV1): ResultValue<RoleRegistryExportV1, FoundationError>;
}

export type RoleRegistryContractV1 = RoleRegistryV1;

const roleScopeSchema = Type.Union([Type.Literal("global"), Type.Literal("project")]);
const roleTraceSchema = Type.Object({ field: Type.String({ minLength: 1 }), layer: Type.Union(ROLE_RESOLUTION_ORDER_V1.map((layer) => Type.Literal(layer))), referenceId: Type.String({ minLength: 1 }), revision: Type.Optional(Type.Integer({ minimum: 0 })), overrideReason: Type.Optional(Type.String()) }, { additionalProperties: false });
export const RoleResolutionLayerV1Schema = Type.Object({ schemaVersion: Type.Literal(1), layer: Type.Union(ROLE_RESOLUTION_ORDER_V1.map((layer) => Type.Literal(layer))), ordinal: Type.Integer({ minimum: 0 }), referenceId: Type.String({ minLength: 1 }), revision: Type.Integer({ minimum: 0 }), overrideReason: Type.String({ minLength: 1 }) }, { additionalProperties: false });
export const RoleResolvedFieldV1Schema = Type.Object({ schemaVersion: Type.Literal(1), field: Type.String({ minLength: 1 }), source: roleTraceSchema, revision: Type.Integer({ minimum: 0 }), overrideReason: Type.String({ minLength: 1 }), safeValue: FoundationJsonValueSchema, conflict: Type.Optional(Type.Object({ field: Type.String({ minLength: 1 }), source: roleTraceSchema, conflictsWith: roleTraceSchema }, { additionalProperties: false })) }, { additionalProperties: false });
export const RoleTombstoneV1Schema = Type.Object({ schemaVersion: Type.Literal(1), roleId: Type.String({ minLength: 1 }), scope: roleScopeSchema, deletedRevision: Type.Integer({ minimum: 0 }), deletedAt: Type.String({ minLength: 1 }), deletedBy: Type.Optional(Type.String({ minLength: 1 })), reason: Type.Optional(Type.String()) }, { additionalProperties: false });
export const RoleRegistryRecordV1Schema = Type.Object({ schemaVersion: Type.Literal(1), roleId: Type.String({ minLength: 1 }), scope: roleScopeSchema, definition: RoleDefinitionV1Schema, currentRevision: RoleRevisionV1Schema, revisions: Type.Array(RoleRevisionV1Schema), tombstone: Type.Optional(RoleTombstoneV1Schema) }, { additionalProperties: false });
export const RoleRegistryCreateInputV1Schema = Type.Object({ definition: RoleDefinitionV1Schema }, { additionalProperties: false });
export const RoleRegistryGetQueryV1Schema = Type.Object({ roleId: Type.String({ minLength: 1 }), scope: Type.Optional(roleScopeSchema), includeTombstone: Type.Optional(Type.Boolean()), revision: Type.Optional(Type.Integer({ minimum: 0 })) }, { additionalProperties: false });
export const RoleRegistryListQueryV1Schema = Type.Object({ scope: Type.Optional(roleScopeSchema), includeTombstones: Type.Optional(Type.Boolean()) }, { additionalProperties: false });
export const RoleRegistrySearchQueryV1Schema = Type.Object({ text: Type.String(), scope: Type.Optional(roleScopeSchema), includeTombstones: Type.Optional(Type.Boolean()) }, { additionalProperties: false });
export const RoleDefinitionPatchV1Schema = Type.Object({ name: Type.Optional(Type.String()), description: Type.Optional(Type.String()), whenToUse: Type.Optional(Type.String()), persona: Type.Optional(Type.String()), customInstructions: Type.Optional(Type.String()), modelProfileRef: Type.Optional(VersionedReferenceV1Schema), capabilitySelector: Type.Optional(CapabilitySelectorV1Schema), skillSelector: Type.Optional(ResourceSelectorV1Schema), mcpSelector: Type.Optional(ResourceSelectorV1Schema), contextPolicyRef: Type.Optional(VersionedReferenceV1Schema), memoryPolicyRef: Type.Optional(VersionedReferenceV1Schema), executionPolicyRef: Type.Optional(VersionedReferenceV1Schema), resultPolicyRef: Type.Optional(VersionedReferenceV1Schema), overridesRoleId: Type.Optional(Type.String({ minLength: 1 })) }, { additionalProperties: false });
export const RoleRegistryEditInputV1Schema = Type.Object({ roleId: Type.String({ minLength: 1 }), scope: roleScopeSchema, expectedRevision: Type.Integer({ minimum: 0 }), patch: RoleDefinitionPatchV1Schema }, { additionalProperties: false });
export const RoleRegistryCopyInputV1Schema = Type.Object({ sourceRoleId: Type.String({ minLength: 1 }), sourceScope: roleScopeSchema, targetRoleId: Type.String({ minLength: 1 }), targetScope: roleScopeSchema, expectedRevision: Type.Integer({ minimum: 0 }) }, { additionalProperties: false });
export const RoleRegistryDeleteInputV1Schema = Type.Object({ roleId: Type.String({ minLength: 1 }), scope: roleScopeSchema, expectedRevision: Type.Integer({ minimum: 0 }), deletedAt: Type.String({ minLength: 1 }), deletedBy: Type.Optional(Type.String({ minLength: 1 })), reason: Type.Optional(Type.String()) }, { additionalProperties: false });
export const RoleRegistryImportV1Schema = Type.Object({ schemaVersion: Type.Literal(1), exportedAt: Type.String({ minLength: 1 }), records: Type.Array(RoleRegistryRecordV1Schema) }, { additionalProperties: false });
export const RoleRegistryExportQueryV1Schema = Type.Object({ scope: Type.Optional(roleScopeSchema), includeTombstones: Type.Optional(Type.Boolean()) }, { additionalProperties: false });
export const RoleRegistryExportV1Schema = Type.Object({ schemaVersion: Type.Literal(1), exportedAt: Type.String({ minLength: 1 }), records: Type.Array(RoleRegistryRecordV1Schema), fingerprint: Type.Object({ algorithm: Type.Literal("sha256"), value: Type.String({ minLength: 1 }) }, { additionalProperties: false }) }, { additionalProperties: false });
export const RoleResolutionOverrideV1Schema = Type.Object({ schemaVersion: Type.Literal(1), layer: Type.Union(ROLE_RESOLUTION_ORDER_V1.map((layer) => Type.Literal(layer))), referenceId: Type.String({ minLength: 1 }), revision: Type.Integer({ minimum: 0 }), overrideReason: Type.String({ minLength: 1 }), roleRevision: Type.Optional(RoleRevisionV1Schema), modelProfile: Type.Optional(ModelProfileV1Schema), modelRoute: Type.Optional(ModelRouteV1Schema), capabilitySelector: Type.Optional(CapabilitySelectorV1Schema), budget: Type.Optional(BudgetV1Schema), contextRevision: Type.Optional(RevisionReferenceV1Schema), externalAgentBindingRevision: Type.Optional(RevisionReferenceV1Schema), modelBrokerBindingRevision: Type.Optional(RevisionReferenceV1Schema), policyRevision: Type.Optional(RevisionReferenceV1Schema) }, { additionalProperties: false });
export const RoleResolveInputV1Schema = Type.Object({ schemaVersion: Type.Literal(1), task: TaskEnvelopeV1Schema, roleId: Type.String({ minLength: 1 }), scope: roleScopeSchema, modelProfile: ModelProfileV1Schema, orderedLayers: Type.Array(RoleResolutionLayerV1Schema), contextRevision: Type.Optional(RevisionReferenceV1Schema), externalAgentBindingRevision: Type.Optional(RevisionReferenceV1Schema), capabilityRevision: Type.Optional(RevisionReferenceV1Schema), modelBrokerBindingRevision: Type.Optional(RevisionReferenceV1Schema), policyRevision: Type.Optional(RevisionReferenceV1Schema), overrides: Type.Optional(Type.Array(RoleResolutionOverrideV1Schema)), bindingId: Type.Optional(Type.String({ minLength: 1 })) }, { additionalProperties: false });
export const RoleResolutionPreviewV1Schema = Type.Object({ schemaVersion: Type.Literal(1), taskId: Type.String({ minLength: 1 }), roleId: Type.String({ minLength: 1 }), roleRevision: RevisionReferenceV1Schema, modelProfileRevision: RevisionReferenceV1Schema, modelRoute: ModelRouteV1Schema, contextRevision: RevisionReferenceV1Schema, capabilityRevision: RevisionReferenceV1Schema, modelBrokerBindingRevision: RevisionReferenceV1Schema, policyRevision: RevisionReferenceV1Schema, capabilitySelector: CapabilitySelectorV1Schema, budget: BudgetV1Schema, orderedLayers: Type.Array(RoleResolutionLayerV1Schema), fields: Type.Array(RoleResolvedFieldV1Schema), sourceTrace: Type.Array(roleTraceSchema), conflicts: Type.Array(Type.Object({ field: Type.String({ minLength: 1 }), source: roleTraceSchema, conflictsWith: roleTraceSchema }, { additionalProperties: false })), binding: AgentBindingV1Schema, fingerprint: Type.Object({ algorithm: Type.Literal("sha256"), value: Type.String({ minLength: 1 }) }, { additionalProperties: false }) }, { additionalProperties: false });
export function validateRoleResolutionLayerV1(value: unknown): ResultValue<RoleResolutionLayerV1, FoundationError> { return validateExactShape<RoleResolutionLayerV1>(RoleResolutionLayerV1Schema, value, "role_resolution_layer"); }
export function serializeRoleResolutionLayerV1(value: RoleResolutionLayerV1): string { return serializeExactShape(RoleResolutionLayerV1Schema, value, "role_resolution_layer"); }
export function parseRoleResolutionLayerV1(text: string): ResultValue<RoleResolutionLayerV1, FoundationError> { return parseExactShape(RoleResolutionLayerV1Schema, text, "role_resolution_layer"); }
export function validateRoleRegistryRecordV1(value: unknown): ResultValue<RoleRegistryRecordV1, FoundationError> { return validateExactShape<RoleRegistryRecordV1>(RoleRegistryRecordV1Schema, value, "role_registry_record"); }
export function serializeRoleRegistryRecordV1(value: RoleRegistryRecordV1): string { return serializeExactShape(RoleRegistryRecordV1Schema, value, "role_registry_record"); }
export function parseRoleRegistryRecordV1(text: string): ResultValue<RoleRegistryRecordV1, FoundationError> { return parseExactShape(RoleRegistryRecordV1Schema, text, "role_registry_record"); }
export function validateRoleResolutionPreviewV1(value: unknown): ResultValue<RoleResolutionPreviewV1, FoundationError> { return validateExactShape<RoleResolutionPreviewV1>(RoleResolutionPreviewV1Schema, value, "role_resolution_preview"); }
export function serializeRoleResolutionPreviewV1(value: RoleResolutionPreviewV1): string { return serializeExactShape(RoleResolutionPreviewV1Schema, value, "role_resolution_preview"); }
export function parseRoleResolutionPreviewV1(text: string): ResultValue<RoleResolutionPreviewV1, FoundationError> { return parseExactShape(RoleResolutionPreviewV1Schema, text, "role_resolution_preview"); }
export function validateRoleResolveInputV1(value: unknown): ResultValue<RoleResolveInputV1, FoundationError> { return validateExactShape<RoleResolveInputV1>(RoleResolveInputV1Schema, value, "role_resolve_input"); }
export function serializeRoleResolveInputV1(value: RoleResolveInputV1): string { return serializeExactShape(RoleResolveInputV1Schema, value, "role_resolve_input"); }
export function parseRoleResolveInputV1(text: string): ResultValue<RoleResolveInputV1, FoundationError> { return parseExactShape<RoleResolveInputV1>(RoleResolveInputV1Schema, text, "role_resolve_input"); }

/** Reject reordered or duplicate precedence layers before a Resolver consumes them. */
export function validateRoleResolutionOrder(layers: readonly RoleResolutionLayerV1[]): ResultValue<readonly RoleResolutionLayerV1[], FoundationError> {
	if (layers.length !== ROLE_RESOLUTION_ORDER_V1.length) return Result.err(new FoundationError("role_resolver_order_invalid", "Role resolution must include every frozen precedence layer exactly once", { details: { expected: [...ROLE_RESOLUTION_ORDER_V1], actual: layers.map((layer) => layer.layer) } }));
	const seen = new Set<string>();
	for (const [ordinal, layer] of layers.entries()) {
		const index = ROLE_RESOLUTION_ORDER_V1.indexOf(layer.layer as RoleResolutionOrderV1);
		if (index < 0 || seen.has(layer.layer) || index !== ordinal || layer.ordinal !== ordinal) return Result.err(new FoundationError("role_resolver_order_invalid", "Role resolution layers must follow the frozen precedence order without duplicates", { details: { layer: layer.layer, ordinal } }));
		seen.add(layer.layer);
	}
	return Result.ok(layers);
}

/** Lower-precedence scopes may narrow but never widen the managed-lock selector. */
export function validateRoleSelectorTightening(parent: CapabilitySelectorV1, child: CapabilitySelectorV1, field = "capabilitySelector"): ResultValue<CapabilitySelectorV1, FoundationError> {
	return selectorsNarrow(parent, child) ? Result.ok(child) : Result.err(new FoundationError("role_resolver_scope_widened", "A lower-precedence selector cannot widen its parent scope", { details: { field } }));
}
export function validateRoleScopeTightening(parent: { capabilitySelector: CapabilitySelectorV1; policySelector: ResourceSelectorV1 }, child: { capabilitySelector: CapabilitySelectorV1; policySelector: ResourceSelectorV1 }): ResultValue<typeof child, FoundationError> {
	if (!selectorsNarrow(parent.capabilitySelector, child.capabilitySelector)) return Result.err(new FoundationError("role_resolver_scope_widened", "A lower-precedence capability selector cannot widen its parent scope", { details: { field: "capabilitySelector" } }));
	if (!selectorsNarrow(parent.policySelector, child.policySelector)) return Result.err(new FoundationError("role_resolver_scope_widened", "A lower-precedence policy selector cannot widen its parent scope", { details: { field: "policySelector" } }));
	return Result.ok(child);
}

/** Safe preview values are redacted before crossing the public resolver boundary. */
export function redactRoleResolutionValue(value: JsonValue): JsonValue {
	return redactProjection(value) as JsonValue;
}

/** Shared precondition used by registry and resolver implementations. */
export function requireRoleResolutionTask(task: TaskEnvelopeV1 | undefined): ResultValue<TaskEnvelopeV1, FoundationError> {
	return task?.taskId ? Result.ok(task) : Result.err(new FoundationError("role_resolver_task_required", "Role resolution requires a persisted TaskEnvelope", { details: { reason: "task_before_binding" } }));
}

/** Build a deterministic preview fingerprint from its public fields. */
export function fingerprintRoleResolutionPreview(preview: Omit<RoleResolutionPreviewV1, "fingerprint">): FingerprintV1 {
	return fingerprintFoundationValue(preview);
}

function registryKey(roleId: string, scope: RoleScopeV1): string {
	return `${scope}\u001f${roleId}`;
}

function registryFailure(code: FoundationError["code"], message: string, details?: Record<string, string | number>): ResultValue<never, FoundationError> {
	return Result.err(new FoundationError(code, message, details === undefined ? {} : { details: details as never }));
}

function copyRecord(record: RoleRegistryRecordV1): RoleRegistryRecordV1 {
	return cloneDeepFrozen(record);
}

/**
 * A deterministic contract implementation for hosts that do not yet have a durable Role store.
 * Every edit replaces the record with a frozen snapshot; delete only adds a tombstone.
 */
export class InMemoryRoleRegistryV1 implements RoleRegistryV1 {
	private readonly records = new Map<string, RoleRegistryRecordV1>();
	private readonly now: () => string;

	constructor(options: { now?: () => string } = {}) {
		this.now = options.now ?? (() => new Date().toISOString());
	}

	create(input: RoleRegistryCreateInputV1): ResultValue<RoleRegistryRecordV1, FoundationError> {
		const definition = validateRoleDefinitionV1(input.definition);
		if (!definition.ok) return definition;
		const key = registryKey(definition.value.roleId, definition.value.scope);
		if (this.records.has(key)) return registryFailure("role_slug_conflict", "Role identity is already registered", { roleId: definition.value.roleId, scope: definition.value.scope });
		const revision = createRoleRevision({ definition: definition.value, now: this.now });
		const record = cloneDeepFrozen({ schemaVersion: 1 as const, roleId: definition.value.roleId, scope: definition.value.scope, definition: definition.value, currentRevision: revision, revisions: [revision] });
		this.records.set(key, record);
		return Result.ok(copyRecord(record));
	}

	get(query: RoleRegistryGetQueryV1): ResultValue<RoleRegistryRecordV1, FoundationError> {
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

	list(query: RoleRegistryListQueryV1 = {}): ResultValue<readonly RoleRegistryRecordV1[], FoundationError> {
		const records = [...this.records.values()]
			.filter((record) => query.scope === undefined || record.scope === query.scope)
			.filter((record) => query.includeTombstones === true || record.tombstone === undefined)
			.sort(compareRecords)
			.map(copyRecord);
		return Result.ok(records);
	}

	search(query: RoleRegistrySearchQueryV1): ResultValue<readonly RoleRegistryRecordV1[], FoundationError> {
		const text = query.text.trim().toLocaleLowerCase();
		const listed = this.list({ scope: query.scope, includeTombstones: query.includeTombstones });
		if (!listed.ok || text.length === 0) return listed;
		return Result.ok(listed.value.filter((record) => {
			const fields = [record.roleId, record.definition.slug, record.definition.name, record.definition.description, record.definition.persona];
			return fields.some((field) => field.toLocaleLowerCase().includes(text));
		}));
	}

	edit(input: RoleRegistryEditInputV1): ResultValue<RoleRegistryRecordV1, FoundationError> {
		const current = this.get({ roleId: input.roleId, scope: input.scope, includeTombstone: true });
		if (!current.ok) return current;
		if (current.value.tombstone !== undefined) return registryFailure("role_not_found", "Cannot edit a tombstoned role", { roleId: input.roleId });
		if (current.value.currentRevision.revision !== input.expectedRevision) return registryFailure("role_revision_immutable", "Role revision does not match the expected revision", { roleId: input.roleId, expectedRevision: input.expectedRevision });
		const patch = input.patch;
		const nextDefinition: RoleDefinitionV1 = {
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

	copy(input: RoleRegistryCopyInputV1): ResultValue<RoleRegistryRecordV1, FoundationError> {
		const source = this.get({ roleId: input.sourceRoleId, scope: input.sourceScope });
		if (!source.ok) return source;
		if (source.value.currentRevision.revision !== input.expectedRevision) return registryFailure("role_revision_immutable", "Source role revision does not match the expected revision", { roleId: input.sourceRoleId });
		const targetKey = registryKey(input.targetRoleId, input.targetScope);
		if (this.records.has(targetKey)) return registryFailure("role_slug_conflict", "Target role identity is already registered", { roleId: input.targetRoleId });
		const definition: RoleDefinitionV1 = { ...source.value.definition, roleId: input.targetRoleId, scope: input.targetScope, overridesRoleId: input.targetScope === "global" ? undefined : source.value.definition.overridesRoleId, revision: 0 };
		return this.create({ definition });
	}

	delete(input: RoleRegistryDeleteInputV1): ResultValue<RoleTombstoneV1, FoundationError> {
		const current = this.get({ roleId: input.roleId, scope: input.scope, includeTombstone: true });
		if (!current.ok) return current;
		if (current.value.tombstone !== undefined) return Result.ok(current.value.tombstone);
		if (current.value.currentRevision.revision !== input.expectedRevision) return registryFailure("role_revision_immutable", "Role revision does not match the expected revision", { roleId: input.roleId, expectedRevision: input.expectedRevision });
		const tombstone: RoleTombstoneV1 = cloneDeepFrozen({ schemaVersion: 1, roleId: input.roleId, scope: input.scope, deletedRevision: current.value.currentRevision.revision, deletedAt: input.deletedAt, ...(input.deletedBy === undefined ? {} : { deletedBy: input.deletedBy }), ...(input.reason === undefined ? {} : { reason: input.reason }) });
		const next = cloneDeepFrozen({ ...current.value, tombstone });
		this.records.set(registryKey(input.roleId, input.scope), next);
		return Result.ok(tombstone);
	}

	import(input: RoleRegistryImportV1): ResultValue<readonly RoleRegistryRecordV1[], FoundationError> {
		const checked = validateExactShape<RoleRegistryImportV1>(RoleRegistryImportV1Schema, input, "role_registry_import");
		if (!checked.ok) return checked;
		const next = new Map<string, RoleRegistryRecordV1>();
		for (const record of checked.value.records) {
			const valid = validateRoleRegistryRecordV1(record);
			if (!valid.ok) return valid;
			const key = registryKey(record.roleId, record.scope);
			if (next.has(key)) return registryFailure("role_slug_conflict", "Role import contains duplicate identities", { roleId: record.roleId });
			next.set(key, cloneDeepFrozen(record));
		}
		this.records.clear();
		for (const [key, record] of next) this.records.set(key, record);
		return this.list({ includeTombstones: true });
	}

	export(query: RoleRegistryExportQueryV1 = {}): ResultValue<RoleRegistryExportV1, FoundationError> {
		const listed = this.list({ scope: query.scope, includeTombstones: query.includeTombstones });
		if (!listed.ok) return listed;
		const exportedAt = this.now();
		const base = { schemaVersion: 1 as const, exportedAt, records: listed.value };
		return Result.ok(cloneDeepFrozen({ ...base, fingerprint: fingerprintFoundationValue(base) }));
	}

	resolve(input: RoleResolveInputV1): ResultValue<RoleResolutionPreviewV1, FoundationError> {
		const record = this.get({ roleId: input.roleId, scope: input.scope });
		if (!record.ok) return record;
		if (record.value.tombstone !== undefined) return registryFailure("role_not_found", "Cannot resolve a tombstoned role", { roleId: input.roleId });
		return resolveRoleResolutionV1({ ...input, roleRevision: record.value.currentRevision, now: input.now ?? this.now });
	}
}

function compareRecords(left: RoleRegistryRecordV1, right: RoleRegistryRecordV1): number {
	const scopeOrder = left.scope === right.scope ? 0 : left.scope === "global" ? -1 : 1;
	return scopeOrder || left.roleId.localeCompare(right.roleId);
}

export interface RoleResolutionInputV1 extends RoleResolveInputV1 {
	roleRevision?: RoleRevisionV1;
}

/** Resolve all precedence layers into a redacted preview and immutable AgentBinding. */
export function resolveRoleResolutionV1(input: RoleResolutionInputV1): ResultValue<RoleResolutionPreviewV1, FoundationError> {
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
	let effectiveSelector: CapabilitySelectorV1 = { policy: "all" };
	let effectiveBudget = { ...task.value.budget };
	let effectiveRoute: ModelRouteV1 = routeFromModel(model);
	if (input.externalAgentBindingRevision !== undefined && input.contextRevision !== undefined && canonicalFoundationJson(input.externalAgentBindingRevision) !== canonicalFoundationJson(input.contextRevision)) return registryFailure("binding_required_fact", "Role resolution received conflicting External-Agent Binding aliases", { roleId: input.roleId });
	let effectiveContext = input.externalAgentBindingRevision ?? input.contextRevision;
	const effectiveCapability = input.capabilityRevision;
	let effectiveModelBroker = input.modelBrokerBindingRevision;
	let effectivePolicy = input.policyRevision;
	if (effectiveContext === undefined || effectiveCapability === undefined || effectiveModelBroker === undefined || effectivePolicy === undefined) {
		return registryFailure("binding_required_fact", "Role resolution requires all four existing immutable binding facts", { roleId: input.roleId, taskId: task.value.taskId });
	}
	const values = new Map<string, { value: unknown; source: BindingSourceTraceV1 }>();
	const conflicts: BindingConflictV1[] = [];
	const trace: BindingSourceTraceV1[] = [];
	const addValue = (field: string, value: unknown, source: BindingSourceTraceV1): void => {
		const previous = values.get(field);
		if (previous !== undefined && fingerprintFoundationValue(previous.value).value !== fingerprintFoundationValue(value).value) conflicts.push({ field, source, conflictsWith: previous.source });
		values.set(field, { value, source });
	};
	const baseLayer = role.scope === "global" ? "global" : "project";
	const baseSource = (field: string): BindingSourceTraceV1 => ({ field, layer: baseLayer, referenceId: role.roleRevisionId, revision: role.revision });
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
		const source = (field: string): BindingSourceTraceV1 => ({ field, layer: override.layer, referenceId: override.referenceId, revision: override.revision, overrideReason: override.overrideReason });
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
	const binding = resolveAgentBinding({ task: task.value, roleRevision: effectiveRole, modelProfile: effectiveModel, modelRoute: effectiveRoute, contextRevision: effectiveContext, capabilityRevision: effectiveCapability, modelBrokerBindingRevision: effectiveModelBroker, policyRevision: effectivePolicy, sourceTrace: trace, conflicts, newBindingId: input.bindingId ?? newFoundationId("binding"), now: input.now });
	if (!binding.ok) return binding;
	const fields = [...values.entries()].map(([field, item]) => ({ schemaVersion: 1 as const, field, source: item.source, revision: item.source.revision ?? 1, overrideReason: item.source.overrideReason ?? "resolved", safeValue: redactRoleResolutionValue(item.value as JsonValue) }));
	const previewBase: Omit<RoleResolutionPreviewV1, "fingerprint"> = { schemaVersion: 1, taskId: task.value.taskId, roleId: effectiveRole.roleId, roleRevision: binding.value.roleRevision, modelProfileRevision: binding.value.modelProfileRevision, modelRoute: binding.value.modelRoute, contextRevision: binding.value.contextRevision, capabilityRevision: binding.value.capabilityRevision, modelBrokerBindingRevision: binding.value.modelBrokerBindingRevision, policyRevision: binding.value.policyRevision, capabilitySelector: binding.value.capabilitySelector, budget: binding.value.budget, orderedLayers: order.value, fields, sourceTrace: binding.value.sourceTrace, conflicts: binding.value.conflicts, binding: binding.value };
	return Result.ok(cloneDeepFrozen({ ...previewBase, fingerprint: fingerprintRoleResolutionPreview(previewBase) }));
}

function routeFromModel(model: ModelProfileV1): ModelRouteV1 {
	return { provider: model.provider, model: model.model, ...(model.effort === undefined ? {} : { effort: model.effort }), ...(model.serviceTier === undefined ? {} : { serviceTier: model.serviceTier }) };
}

function mergeBudget(left: TaskEnvelopeV1["budget"], right: TaskEnvelopeV1["budget"]): TaskEnvelopeV1["budget"] {
	const result: TaskEnvelopeV1["budget"] = {};
	for (const key of ["tokens", "costUsd", "modelCalls", "toolCalls", "wallClockMs", "concurrency"] as const) {
		const a = left[key];
		const b = right[key];
		if (a !== undefined || b !== undefined) result[key] = a === undefined ? b : b === undefined ? a : Math.min(a, b);
	}
	return result;
}

export class DeterministicRoleResolverV1 implements RoleResolverV1 {
	private readonly registry: RoleRegistryV1;
	constructor(registry: RoleRegistryV1) { this.registry = registry; }
	resolve(input: RoleResolveInputV1): ResultValue<RoleResolutionPreviewV1, FoundationError> { return this.registry.resolve(input); }
}

export const InMemoryRoleRegistry = InMemoryRoleRegistryV1;
export const DeterministicRoleResolver = DeterministicRoleResolverV1;
export const resolveRoleResolution = resolveRoleResolutionV1;
export const resolveRoleBindingV1 = resolveRoleResolutionV1;
