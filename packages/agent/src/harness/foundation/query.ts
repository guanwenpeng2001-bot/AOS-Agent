import { Type } from "typebox";
import type { Result as ResultValue } from "../result.ts";
import type { FoundationError } from "./errors.ts";
import type { FoundationEnvelope } from "./schema.ts";
import type { Fingerprint } from "./identity.ts";
import type { ArtifactRef } from "./reference.ts";
import type { RoleDefinition, RoleRevision, ModelProfile, AgentBinding, BindingEpoch, AgentInstance } from "./role.ts";
import type { TaskEnvelope, Dispatch, Attempt } from "./task.ts";
import type { WorkerReceipt, AttemptReceipt, TaskResult, RunReceipt } from "./results.ts";
import type { Goal, Plan, Stage, Todo, Ask } from "./goal.ts";
import type { Workflow } from "./workflow.ts";
import type { PluginContract } from "./plugin.ts";
import type { ServiceContract } from "./service.ts";
import type { ProfileContract } from "./profile.ts";
import { parseExactShape, serializeExactShape, validateExactShape } from "./schema.ts";

/** Stable queryable T1 entities. This is an identity/query surface, not a persistence engine. */
export const FOUNDATION_ENTITY_KINDS = [
	"execution_correlation", "lineage", "fingerprint", "envelope", "event", "task", "artifact",
	"role_definition", "role_revision", "model_profile", "agent_binding", "binding_epoch", "agent_instance",
	"dispatch", "attempt", "worker_receipt", "attempt_receipt", "task_result", "run_receipt", "provider_contract",
	"protocol_negotiation", "observer_cursor", "observer_snapshot", "plugin", "service", "profile",
	"session", "goal", "plan", "stage", "todo", "ask", "workflow", "run", "turn", "step", "inbox",
] as const;
export type FoundationEntityKind = (typeof FOUNDATION_ENTITY_KINDS)[number];

export interface FoundationEntityId {
	schemaVersion: 1;
	entityType: FoundationEntityKind;
	id: string;
	revision: number;
	fingerprint?: Fingerprint;
}

export interface FoundationEntityQuery {
	schemaVersion: 1;
	entityType: FoundationEntityKind;
	id?: string;
	revision?: number;
	fingerprint?: Fingerprint;
	text?: string;
	includeTombstones?: boolean;
	limit?: number;
	cursor?: string;
}

export interface FoundationEntityValueMap {
	execution_correlation: FoundationEntityId;
	lineage: FoundationEntityId;
	fingerprint: Fingerprint;
	envelope: FoundationEnvelope;
	event: FoundationEnvelope;
	task: TaskEnvelope;
	artifact: ArtifactRef;
	role_definition: RoleDefinition;
	role_revision: RoleRevision;
	model_profile: ModelProfile;
	agent_binding: AgentBinding;
	binding_epoch: BindingEpoch;
	agent_instance: AgentInstance;
	dispatch: Dispatch;
	attempt: Attempt;
	worker_receipt: WorkerReceipt;
	attempt_receipt: AttemptReceipt;
	task_result: TaskResult;
	run_receipt: RunReceipt;
	provider_contract: { schemaVersion: 1; providerId: string };
	protocol_negotiation: { schemaVersion: 1; version: number };
	observer_cursor: { schemaVersion: 1; sessionId: string; sequence: number };
	observer_snapshot: { schemaVersion: 1; snapshotId: string };
	plugin: PluginContract;
	service: ServiceContract;
	profile: ProfileContract;
	session: { schemaVersion: 1; sessionId: string };
	goal: Goal;
	plan: Plan;
	stage: Stage;
	todo: Todo;
	ask: Ask;
	workflow: Workflow;
	run: { schemaVersion: 1; runId: string };
	turn: { schemaVersion: 1; turnId: string };
	step: { schemaVersion: 1; stepId: string };
	inbox: { schemaVersion: 1; inboxId: string };
}

export type FoundationEntityRecord = {
	[K in FoundationEntityKind]: { schemaVersion: 1; entityType: K; id: string; revision: number; value: FoundationEntityValueMap[K] }
}[FoundationEntityKind];

export interface FoundationEntityQueryResult {
	schemaVersion: 1;
	query: FoundationEntityQuery;
	/** Query results are safe identity projections; providers never return raw task/prompt/config values here. */
	records: readonly FoundationEntityPublicProjection[];
	nextCursor?: string;
}
/** Public query records contain only stable identity and digest data; values remain provider-local. */
export interface FoundationEntityPublicProjection { schemaVersion: 1; entityType: FoundationEntityKind; id: string; revision: number; fingerprint?: Fingerprint; }
export const FoundationEntityPublicProjectionSchema = Type.Object({ schemaVersion: Type.Literal(1), entityType: Type.Union(FOUNDATION_ENTITY_KINDS.map((kind) => Type.Literal(kind))), id: Type.String({ minLength: 1 }), revision: Type.Integer({ minimum: 0 }), fingerprint: Type.Optional(Type.Object({ algorithm: Type.Literal("sha256"), value: Type.String({ minLength: 1 }) }, { additionalProperties: false })) }, { additionalProperties: false });
export function projectFoundationEntityRecord(record: FoundationEntityRecord): FoundationEntityPublicProjection { return { schemaVersion: 1, entityType: record.entityType, id: record.id, revision: record.revision }; }
export function validateFoundationEntityPublicProjection(value: unknown): ResultValue<FoundationEntityPublicProjection, FoundationError> { return validateExactShape<FoundationEntityPublicProjection>(FoundationEntityPublicProjectionSchema, value, "foundation_entity_public_projection"); }
export function serializeFoundationEntityPublicProjection(value: FoundationEntityPublicProjection): string { return serializeExactShape(FoundationEntityPublicProjectionSchema, value, "foundation_entity_public_projection"); }
export function parseFoundationEntityPublicProjection(text: string): ResultValue<FoundationEntityPublicProjection, FoundationError> { return parseExactShape(FoundationEntityPublicProjectionSchema, text, "foundation_entity_public_projection"); }

/** Read-only query adapter for T1 identity surfaces; it does not imply T2 storage. */
export interface FoundationEntityQueryProvider {
	query(query: FoundationEntityQuery): ResultValue<FoundationEntityQueryResult, FoundationError>;
}

export const FoundationEntityIdSchema = Type.Object({ schemaVersion: Type.Literal(1), entityType: Type.Union(FOUNDATION_ENTITY_KINDS.map((kind) => Type.Literal(kind))), id: Type.String({ minLength: 1 }), revision: Type.Integer({ minimum: 0 }), fingerprint: Type.Optional(Type.Object({ algorithm: Type.Literal("sha256"), value: Type.String({ minLength: 1 }) }, { additionalProperties: false })) }, { additionalProperties: false });
export const FoundationEntityQuerySchema = Type.Object({ schemaVersion: Type.Literal(1), entityType: Type.Union(FOUNDATION_ENTITY_KINDS.map((kind) => Type.Literal(kind))), id: Type.Optional(Type.String({ minLength: 1 })), revision: Type.Optional(Type.Integer({ minimum: 0 })), fingerprint: Type.Optional(Type.Object({ algorithm: Type.Literal("sha256"), value: Type.String({ minLength: 1 }) }, { additionalProperties: false })), text: Type.Optional(Type.String()), includeTombstones: Type.Optional(Type.Boolean()), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })), cursor: Type.Optional(Type.String({ minLength: 1 })) }, { additionalProperties: false });

export function validateFoundationEntityId(value: unknown): ResultValue<FoundationEntityId, FoundationError> { return validateExactShape<FoundationEntityId>(FoundationEntityIdSchema, value, "foundation_entity_id"); }
export function serializeFoundationEntityId(value: FoundationEntityId): string { return serializeExactShape(FoundationEntityIdSchema, value, "foundation_entity_id"); }
export function parseFoundationEntityId(text: string): ResultValue<FoundationEntityId, FoundationError> { return parseExactShape(FoundationEntityIdSchema, text, "foundation_entity_id"); }
export function validateFoundationEntityQuery(value: unknown): ResultValue<FoundationEntityQuery, FoundationError> { return validateExactShape<FoundationEntityQuery>(FoundationEntityQuerySchema, value, "foundation_entity_query"); }
export function serializeFoundationEntityQuery(value: FoundationEntityQuery): string { return serializeExactShape(FoundationEntityQuerySchema, value, "foundation_entity_query"); }
export function parseFoundationEntityQuery(text: string): ResultValue<FoundationEntityQuery, FoundationError> { return parseExactShape(FoundationEntityQuerySchema, text, "foundation_entity_query"); }
