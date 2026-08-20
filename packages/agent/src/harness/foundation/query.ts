import { Type } from "typebox";
import type { Result as ResultValue } from "../result.ts";
import type { FoundationError } from "./errors.ts";
import type { FoundationEnvelopeV1 } from "./schema.ts";
import type { FingerprintV1 } from "./identity.ts";
import type { ArtifactRefV1 } from "./reference.ts";
import type { RoleDefinitionV1, RoleRevisionV1, ModelProfileV1, AgentBindingV1, BindingEpochV1, AgentInstanceV1 } from "./role.ts";
import type { TaskEnvelopeV1, DispatchV1, AttemptV1 } from "./task.ts";
import type { WorkerReceiptV1, AttemptReceiptV1, TaskResultV1, RunReceiptV1 } from "./results.ts";
import type { GoalV1, PlanV1, StageV1, TodoV1, AskV1 } from "./goal.ts";
import type { WorkflowV1 } from "./workflow.ts";
import type { PluginContractV1 } from "./plugin.ts";
import type { ServiceContractV1 } from "./service.ts";
import type { ProfileContractV1 } from "./profile.ts";
import { parseExactShape, serializeExactShape, validateExactShape } from "./schema.ts";

/** Stable queryable T1 entities. This is an identity/query surface, not a persistence engine. */
export const FOUNDATION_ENTITY_KINDS_V1 = [
	"execution_correlation", "lineage", "fingerprint", "envelope", "event", "task", "artifact",
	"role_definition", "role_revision", "model_profile", "agent_binding", "binding_epoch", "agent_instance",
	"dispatch", "attempt", "worker_receipt", "attempt_receipt", "task_result", "run_receipt", "provider_contract",
	"protocol_negotiation", "observer_cursor", "observer_snapshot", "plugin", "service", "profile",
	"session", "goal", "plan", "stage", "todo", "ask", "workflow", "run", "turn", "step", "inbox",
] as const;
export type FoundationEntityKindV1 = (typeof FOUNDATION_ENTITY_KINDS_V1)[number];

export interface FoundationEntityIdV1 {
	schemaVersion: 1;
	entityType: FoundationEntityKindV1;
	id: string;
	revision: number;
	fingerprint?: FingerprintV1;
}
export type EntityIdV1 = FoundationEntityIdV1;

export interface FoundationEntityQueryV1 {
	schemaVersion: 1;
	entityType: FoundationEntityKindV1;
	id?: string;
	revision?: number;
	fingerprint?: FingerprintV1;
	text?: string;
	includeTombstones?: boolean;
	limit?: number;
	cursor?: string;
}
export type EntityQueryV1 = FoundationEntityQueryV1;
export type FoundationQueryV1 = FoundationEntityQueryV1;

export interface FoundationEntityValueMapV1 {
	execution_correlation: FoundationEntityIdV1;
	lineage: FoundationEntityIdV1;
	fingerprint: FingerprintV1;
	envelope: FoundationEnvelopeV1;
	event: FoundationEnvelopeV1;
	task: TaskEnvelopeV1;
	artifact: ArtifactRefV1;
	role_definition: RoleDefinitionV1;
	role_revision: RoleRevisionV1;
	model_profile: ModelProfileV1;
	agent_binding: AgentBindingV1;
	binding_epoch: BindingEpochV1;
	agent_instance: AgentInstanceV1;
	dispatch: DispatchV1;
	attempt: AttemptV1;
	worker_receipt: WorkerReceiptV1;
	attempt_receipt: AttemptReceiptV1;
	task_result: TaskResultV1;
	run_receipt: RunReceiptV1;
	provider_contract: { schemaVersion: 1; providerId: string };
	protocol_negotiation: { schemaVersion: 1; version: number };
	observer_cursor: { schemaVersion: 1; sessionId: string; sequence: number };
	observer_snapshot: { schemaVersion: 1; snapshotId: string };
	plugin: PluginContractV1;
	service: ServiceContractV1;
	profile: ProfileContractV1;
	session: { schemaVersion: 1; sessionId: string };
	goal: GoalV1;
	plan: PlanV1;
	stage: StageV1;
	todo: TodoV1;
	ask: AskV1;
	workflow: WorkflowV1;
	run: { schemaVersion: 1; runId: string };
	turn: { schemaVersion: 1; turnId: string };
	step: { schemaVersion: 1; stepId: string };
	inbox: { schemaVersion: 1; inboxId: string };
}

export type FoundationEntityRecordV1 = {
	[K in FoundationEntityKindV1]: { schemaVersion: 1; entityType: K; id: string; revision: number; value: FoundationEntityValueMapV1[K] }
}[FoundationEntityKindV1];

export interface FoundationEntityQueryResultV1 {
	schemaVersion: 1;
	query: FoundationEntityQueryV1;
	/** Query results are safe identity projections; providers never return raw task/prompt/config values here. */
	records: readonly FoundationEntityPublicProjectionV1[];
	nextCursor?: string;
}
/** Public query records contain only stable identity and digest data; values remain provider-local. */
export interface FoundationEntityPublicProjectionV1 { schemaVersion: 1; entityType: FoundationEntityKindV1; id: string; revision: number; fingerprint?: FingerprintV1; }
export const FoundationEntityPublicProjectionV1Schema = Type.Object({ schemaVersion: Type.Literal(1), entityType: Type.Union(FOUNDATION_ENTITY_KINDS_V1.map((kind) => Type.Literal(kind))), id: Type.String({ minLength: 1 }), revision: Type.Integer({ minimum: 0 }), fingerprint: Type.Optional(Type.Object({ algorithm: Type.Literal("sha256"), value: Type.String({ minLength: 1 }) }, { additionalProperties: false })) }, { additionalProperties: false });
export function projectFoundationEntityRecordV1(record: FoundationEntityRecordV1): FoundationEntityPublicProjectionV1 { return { schemaVersion: 1, entityType: record.entityType, id: record.id, revision: record.revision }; }
export function validateFoundationEntityPublicProjectionV1(value: unknown): ResultValue<FoundationEntityPublicProjectionV1, FoundationError> { return validateExactShape<FoundationEntityPublicProjectionV1>(FoundationEntityPublicProjectionV1Schema, value, "foundation_entity_public_projection"); }
export function serializeFoundationEntityPublicProjectionV1(value: FoundationEntityPublicProjectionV1): string { return serializeExactShape(FoundationEntityPublicProjectionV1Schema, value, "foundation_entity_public_projection"); }
export function parseFoundationEntityPublicProjectionV1(text: string): ResultValue<FoundationEntityPublicProjectionV1, FoundationError> { return parseExactShape(FoundationEntityPublicProjectionV1Schema, text, "foundation_entity_public_projection"); }

/** Read-only query adapter for T1 identity surfaces; it does not imply T2 storage. */
export interface FoundationEntityQueryProviderV1 {
	query(query: FoundationEntityQueryV1): ResultValue<FoundationEntityQueryResultV1, FoundationError>;
}
export type FoundationQueryProviderV1 = FoundationEntityQueryProviderV1;

export const FoundationEntityIdV1Schema = Type.Object({ schemaVersion: Type.Literal(1), entityType: Type.Union(FOUNDATION_ENTITY_KINDS_V1.map((kind) => Type.Literal(kind))), id: Type.String({ minLength: 1 }), revision: Type.Integer({ minimum: 0 }), fingerprint: Type.Optional(Type.Object({ algorithm: Type.Literal("sha256"), value: Type.String({ minLength: 1 }) }, { additionalProperties: false })) }, { additionalProperties: false });
export const FoundationEntityQueryV1Schema = Type.Object({ schemaVersion: Type.Literal(1), entityType: Type.Union(FOUNDATION_ENTITY_KINDS_V1.map((kind) => Type.Literal(kind))), id: Type.Optional(Type.String({ minLength: 1 })), revision: Type.Optional(Type.Integer({ minimum: 0 })), fingerprint: Type.Optional(Type.Object({ algorithm: Type.Literal("sha256"), value: Type.String({ minLength: 1 }) }, { additionalProperties: false })), text: Type.Optional(Type.String()), includeTombstones: Type.Optional(Type.Boolean()), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })), cursor: Type.Optional(Type.String({ minLength: 1 })) }, { additionalProperties: false });

export function validateFoundationEntityIdV1(value: unknown): ResultValue<FoundationEntityIdV1, FoundationError> { return validateExactShape<FoundationEntityIdV1>(FoundationEntityIdV1Schema, value, "foundation_entity_id"); }
export function serializeFoundationEntityIdV1(value: FoundationEntityIdV1): string { return serializeExactShape(FoundationEntityIdV1Schema, value, "foundation_entity_id"); }
export function parseFoundationEntityIdV1(text: string): ResultValue<FoundationEntityIdV1, FoundationError> { return parseExactShape(FoundationEntityIdV1Schema, text, "foundation_entity_id"); }
export function validateFoundationEntityQueryV1(value: unknown): ResultValue<FoundationEntityQueryV1, FoundationError> { return validateExactShape<FoundationEntityQueryV1>(FoundationEntityQueryV1Schema, value, "foundation_entity_query"); }
export function serializeFoundationEntityQueryV1(value: FoundationEntityQueryV1): string { return serializeExactShape(FoundationEntityQueryV1Schema, value, "foundation_entity_query"); }
export function parseFoundationEntityQueryV1(text: string): ResultValue<FoundationEntityQueryV1, FoundationError> { return parseExactShape(FoundationEntityQueryV1Schema, text, "foundation_entity_query"); }
