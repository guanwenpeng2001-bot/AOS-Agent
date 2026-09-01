import { Result, type ResultValue } from "../result.ts";
import { Type } from "typebox";
import { BudgetUsageSchema, BudgetSchema, type BudgetUsage, type Budget } from "./budget.ts";
import { FoundationError, type PublicExecutionError } from "./errors.ts";
import { fingerprintFoundationValue, canonicalFoundationJson, type ExecutionCorrelation, type Fingerprint } from "./identity.ts";
import { cloneDeepFrozen } from "./immutability.ts";
import { ArtifactRefSchema, type ArtifactDescriptor, type ArtifactRef, RevisionReferenceSchema, type RevisionReference } from "./reference.ts";
import type { SideEffectState } from "./side-effect.ts";
import { AgentInstanceSchema, BindingEpochSchema, ModelProfileSchema, RoleRevisionSchema, type AgentBinding, type AgentInstance, type BindingEpoch, type ModelProfile, type RoleRevision } from "./role.ts";
import { AttemptSchema, type Attempt, type Dispatch, SpawnAgentIntentSchema, type SpawnAgentIntent, TaskEnvelopeSchema, type TaskEnvelope } from "./task.ts";
import { PublicExecutionErrorSchema, type AttemptReceipt, type WorkerReceipt } from "./results.ts";
import type { FoundationEventEnvelope, FoundationJsonValue } from "./event-catalog.ts";
import { FingerprintSchema, FoundationJsonValueSchema, parseExactShape, serializeExactShape, validateExactShape } from "./schema.ts";

export type FoundationProviderClass = "operation_worker" | "scheduler" | "task_executor" | "agent" | "external_connector" | "gateway" | "store" | "quota" | "transport" | "observer";
export const PROVIDER_CLASS = Object.freeze({ externalConnector: "external_connector" as const });
export const PROVIDER_KINDS = ["model", "tool", "sandbox", "operation", "external"] as const;
export interface ExecutionProviderDescriptor { schemaVersion: 1; providerId: string; providerClass: "operation_worker" | "scheduler" | "task_executor" | "agent" | "external_connector"; }
export interface FoundationProviderCapability { schemaVersion: 1; id: string; version: number; }
export interface FoundationProvider { readonly schemaVersion: 1; readonly providerId: string; readonly providerClass: FoundationProviderClass; capabilities(): Promise<readonly FoundationProviderCapability[]>; dispose(): Promise<void>; }
/** Correlation carried by a provider consumer; credential material is never part of it. */
export interface FoundationProviderExecutionOptions { readonly correlation?: ExecutionCorrelation; readonly signal?: AbortSignal; }
export interface SandboxOperationRequest {
	schemaVersion: 1;
	operationId: string;
	/** Declared by the selected tool route; missing metadata remains fail-closed. */
	sideEffect?: "none" | "writes";
	providerId?: string;
	bindingId?: string;
	bindingEpochId?: string;
	agentInstanceId?: string;
	toolCallId?: string;
	toolName?: string;
	namespace?: string;
	payload?: FoundationJsonValue;
	taskId?: string;
	dispatchId?: string;
	attemptId?: string;
	credentialTargets?: readonly string[];
	workspace?: string;
	deadlineAt?: number;
}
export interface SandboxOperationProvider extends FoundationProvider { readonly providerClass: "operation_worker"; start(request: SandboxOperationRequest, options?: FoundationProviderExecutionOptions): Promise<Result<WorkerReceipt, FoundationError>>; cancel(operationId: string): Promise<Result<void, FoundationError>>; }
export interface ChildSpawnRequest { schemaVersion: 1; spawnId: string; parentSpawn?: SpawnAgentIntent; taskEnvelope: TaskEnvelope; roleRevision: RoleRevision; modelProfile: ModelProfile; parentAttemptId?: string; parentAgentInstanceId?: string; forkScope: "none" | "all" | "recent_n" | "task_package"; recentN?: number; taskPackageRef?: string; }
export interface ChildSpawnResult { schemaVersion: 1; attempt: Attempt; agentInstance: AgentInstance; initialBindingEpoch: BindingEpoch; }
export interface ChildAgentProvider extends FoundationProvider { readonly providerClass: "agent"; spawn(request: ChildSpawnRequest, options: FoundationProviderExecutionOptions): Promise<Result<ChildSpawnResult, FoundationError>>; /** Look up a provider-owned spawn by its stable id without starting a new child. */ lookupSpawn?(spawnId: string, options?: { signal?: AbortSignal }): Promise<Result<ChildSpawnResult | undefined, FoundationError>>; resume(attemptId: string, options?: { signal?: AbortSignal }): Promise<Result<AttemptReceipt, FoundationError>>; cancel(attemptId: string): Promise<Result<void, FoundationError>>; }
/** Context supplied by the Dispatch consumer; providers must use it when creating the first Attempt. */
export interface TaskExecutorAttemptContext { readonly initialBindingEpoch: BindingEpoch; readonly correlation?: ExecutionCorrelation; readonly signal?: AbortSignal; /** Canonical durable source facts selected by the resolver/settlement gate. */ readonly roleRevision?: RoleRevision; readonly modelProfile?: ModelProfile; readonly modelRoute?: { readonly provider: string; readonly model: string; readonly effort?: string; readonly serviceTier?: string }; readonly agentInstance?: AgentInstance; }
/** A TaskExecutor creates Attempts and settles AttemptReceipts; Operation Workers are excluded. */
export interface TaskExecutorProvider extends FoundationProvider { readonly providerClass: "scheduler" | "task_executor" | "agent" | "external_connector"; createAttempt(dispatch: Dispatch, binding: AgentBinding, context?: TaskExecutorAttemptContext): Promise<Result<Attempt, FoundationError>>; runAttempt(attempt: Attempt, options?: FoundationProviderExecutionOptions): Promise<Result<AttemptReceipt, FoundationError>>; cancelAttempt(attemptId: string): Promise<Result<void, FoundationError>>; }
/** Explicit non-agent scheduler surface. It cannot carry an AgentInstance. */
export interface SchedulerTaskExecutorProvider extends TaskExecutorProvider { readonly providerClass: "scheduler" | "task_executor"; }
/** Host-verified executable facts frozen before an external Attempt is created. */
export interface ConnectorCapabilitySnapshot {
	readonly schemaVersion: 1;
	readonly providerId: string;
	readonly revision: number;
	readonly protocol: { readonly name: string; readonly version: string };
	readonly modelAccess: "none" | "agent_owned" | "aos_gateway";
	readonly resume: boolean;
	readonly toolGateway: boolean;
	readonly artifacts: boolean;
	readonly images: boolean;
	readonly digest: Fingerprint;
}
export type ConnectorCapabilitySnapshotInput = Omit<ConnectorCapabilitySnapshot, "digest">;
/**
 * The sole current external execution contract. Vendor-specific lifecycle surfaces remain private
 * implementation details; every public execution consumes canonical Foundation records.
 */
export interface ExternalAgentConnector extends TaskExecutorProvider {
	readonly providerClass: "external_connector";
	probeCapabilities(options?: FoundationProviderExecutionOptions): Promise<Result<ConnectorCapabilitySnapshot, FoundationError>>;
	resumeAttempt(attempt: Attempt, options?: FoundationProviderExecutionOptions): Promise<Result<AttemptReceipt, FoundationError>>;
	reconcileAttempt(attempt: Attempt, options?: FoundationProviderExecutionOptions): Promise<Result<AttemptReceipt, FoundationError>>;
}
export interface ToolGatewayContext { schemaVersion: 1; bindingId: string; bindingEpochId: string; taskId: string; dispatchId?: string; providerId?: string; attemptId?: string; agentInstanceId?: string; operationId?: string; }
export interface ToolGatewayRequest { schemaVersion: 1; toolCallId: string; toolName: string; namespace?: string; originalArguments: FoundationJsonValue; context: ToolGatewayContext; idempotencyKey?: string; deadlineAt?: number; }
export interface ToolExecutionResult { schemaVersion: 1; toolCallId: string; toolName: string; ok: boolean; sideEffectState: SideEffectState; result?: FoundationJsonValue; artifacts?: readonly ArtifactRef[]; error?: PublicExecutionError; toolReceiptRef?: string; }
export interface ToolGateway extends FoundationProvider { readonly providerClass: "gateway"; execute(request: ToolGatewayRequest, options?: { signal?: AbortSignal }): Promise<Result<ToolExecutionResult, FoundationError>>; }
export interface ScopedModelRequest { schemaVersion: 1; requestId: string; modelProfileRevision: RevisionReference; bindingEpochId: string; taskId: string; attemptId?: string; agentInstanceId?: string; input: FoundationJsonValue; }
export interface ScopedModelResult { schemaVersion: 1; requestId: string; usage: BudgetUsage; stopReason: "stop" | "length" | "tool_use" | "error" | "aborted"; error?: PublicExecutionError; }
export interface ScopedModelGateway extends FoundationProvider { readonly providerClass: "gateway"; stream(request: ScopedModelRequest, options?: { signal?: AbortSignal }): Promise<Result<ScopedModelResult, FoundationError>>; }
export interface ArtifactPutResult { schemaVersion: 1; ref: string; sizeBytes: number; }
export interface ArtifactVerifyResult { schemaVersion: 1; digestValid: boolean; }
export interface ArtifactStoreProvider extends FoundationProvider { readonly providerClass: "store"; put(descriptor: ArtifactDescriptor, data: Uint8Array): Promise<Result<ArtifactPutResult, FoundationError>>; get(ref: string): Promise<Result<Uint8Array, FoundationError>>; verify(artifactId: string): Promise<Result<ArtifactVerifyResult, FoundationError>>; delete(artifactId: string): Promise<Result<void, FoundationError>>; }
export interface QuotaAttribution { schemaVersion: 1; taskId: string; goalId?: string; runId?: string; attemptId?: string; agentInstanceId?: string; providerId: string; ownerKind: "host" | "operation_worker" | "agent_executor" | "external_connector"; }
export interface QuotaReservation { schemaVersion: 1; reservationId: string; attribution: QuotaAttribution; budget: Budget; grantedAt: string; expiresAt?: string; }
export interface QuotaProvider extends FoundationProvider { readonly providerClass: "quota"; reserve(attribution: QuotaAttribution, budget: Budget, options?: { signal?: AbortSignal }): Promise<Result<QuotaReservation, FoundationError>>; settle(reservation: QuotaReservation, usage: BudgetUsage): Promise<Result<BudgetUsage, FoundationError>>; }
export interface TransportInitializeResult { schemaVersion: 1; protocolVersion: 1; features: readonly string[]; }
export interface TransportObserverCursor { schemaVersion: 1; sessionId: string; sequence: number; catalogVersion: 1; }
export interface TransportAdapter extends FoundationProvider { readonly providerClass: "transport"; initialize(): Promise<Result<TransportInitializeResult, FoundationError>>; attach(sessionId: string, cursor?: TransportObserverCursor): Promise<Result<TransportObserverCursor, FoundationError>>; observe(from: TransportObserverCursor, onEvent: (event: FoundationEventEnvelope) => void, options?: { signal?: AbortSignal }): Promise<Result<void, FoundationError>>; }
export interface ProductTimelineEntry { schemaVersion: 1; sequence: number; kind: "ask" | "task_result" | "run_receipt" | "artifact"; ref: { type: string; id: string }; recordedAt: string; }
export interface ProductAcceptanceFact { schemaVersion: 1; factId: string; outcome: string; }
export interface ProductObserverAdapter extends FoundationProvider { readonly providerClass: "observer"; operatorIntents(sessionId: string, after?: number): Promise<Result<readonly ProductTimelineEntry[], FoundationError>>; acceptanceFacts(taskId: string): Promise<Result<readonly ProductAcceptanceFact[], FoundationError>>; timeline(runId: string): Promise<Result<readonly ProductTimelineEntry[], FoundationError>>; }

/** Boundary implementations call this before emitting any provider payload. */
export function validateProviderJson(value: unknown): value is FoundationJsonValue {
	try { canonicalFoundationJson(value); return true; } catch { return false; }
}

export const SandboxOperationRequestSchema = Type.Object({ schemaVersion: Type.Literal(1), operationId: Type.String({ minLength: 1 }), sideEffect: Type.Optional(Type.Union([Type.Literal("none"), Type.Literal("writes")])), providerId: Type.Optional(Type.String({ minLength: 1 })), bindingId: Type.Optional(Type.String({ minLength: 1 })), bindingEpochId: Type.Optional(Type.String({ minLength: 1 })), agentInstanceId: Type.Optional(Type.String({ minLength: 1 })), toolCallId: Type.Optional(Type.String({ minLength: 1 })), toolName: Type.Optional(Type.String({ minLength: 1 })), namespace: Type.Optional(Type.String({ minLength: 1 })), payload: Type.Optional(FoundationJsonValueSchema), taskId: Type.Optional(Type.String({ minLength: 1 })), dispatchId: Type.Optional(Type.String({ minLength: 1 })), attemptId: Type.Optional(Type.String({ minLength: 1 })), credentialTargets: Type.Optional(Type.Array(Type.String({ minLength: 1 }))), workspace: Type.Optional(Type.String({ minLength: 1 })), deadlineAt: Type.Optional(Type.Number({ minimum: 0 })) }, { additionalProperties: false });
export const FoundationProviderCapabilitySchema = Type.Object({ schemaVersion: Type.Literal(1), id: Type.String({ minLength: 1 }), version: Type.Integer({ minimum: 1 }) }, { additionalProperties: false });
export const ConnectorCapabilitySnapshotSchema = Type.Object({ schemaVersion: Type.Literal(1), providerId: Type.String({ minLength: 1 }), revision: Type.Integer({ minimum: 1 }), protocol: Type.Object({ name: Type.String({ minLength: 1 }), version: Type.String({ minLength: 1 }) }, { additionalProperties: false }), modelAccess: Type.Union([Type.Literal("none"), Type.Literal("agent_owned"), Type.Literal("aos_gateway")]), resume: Type.Boolean(), toolGateway: Type.Boolean(), artifacts: Type.Boolean(), images: Type.Boolean(), digest: FingerprintSchema }, { additionalProperties: false });
export const ChildSpawnRequestSchema = Type.Object({ schemaVersion: Type.Literal(1), spawnId: Type.String({ minLength: 1 }), parentSpawn: Type.Optional(SpawnAgentIntentSchema), taskEnvelope: TaskEnvelopeSchema, roleRevision: RoleRevisionSchema, modelProfile: ModelProfileSchema, parentAttemptId: Type.Optional(Type.String({ minLength: 1 })), parentAgentInstanceId: Type.Optional(Type.String({ minLength: 1 })), forkScope: Type.Union([Type.Literal("none"), Type.Literal("all"), Type.Literal("recent_n"), Type.Literal("task_package")]), recentN: Type.Optional(Type.Integer({ minimum: 1 })), taskPackageRef: Type.Optional(Type.String({ minLength: 1 })) }, { additionalProperties: false });
export const ToolGatewayContextSchema = Type.Object({ schemaVersion: Type.Literal(1), bindingId: Type.String({ minLength: 1 }), bindingEpochId: Type.String({ minLength: 1 }), taskId: Type.String({ minLength: 1 }), dispatchId: Type.Optional(Type.String({ minLength: 1 })), providerId: Type.Optional(Type.String({ minLength: 1 })), attemptId: Type.Optional(Type.String({ minLength: 1 })), agentInstanceId: Type.Optional(Type.String({ minLength: 1 })), operationId: Type.Optional(Type.String({ minLength: 1 })) }, { additionalProperties: false });
export const ToolGatewayRequestSchema = Type.Object({ schemaVersion: Type.Literal(1), toolCallId: Type.String({ minLength: 1 }), toolName: Type.String({ minLength: 1 }), namespace: Type.Optional(Type.String({ minLength: 1 })), originalArguments: FoundationJsonValueSchema, context: ToolGatewayContextSchema, idempotencyKey: Type.Optional(Type.String({ minLength: 1 })), deadlineAt: Type.Optional(Type.Number({ minimum: 0 })) }, { additionalProperties: false });
export const ScopedModelRequestSchema = Type.Object({ schemaVersion: Type.Literal(1), requestId: Type.String({ minLength: 1 }), modelProfileRevision: RevisionReferenceSchema, bindingEpochId: Type.String({ minLength: 1 }), taskId: Type.String({ minLength: 1 }), attemptId: Type.Optional(Type.String({ minLength: 1 })), agentInstanceId: Type.Optional(Type.String({ minLength: 1 })), input: FoundationJsonValueSchema }, { additionalProperties: false });
export const TransportObserverCursorSchema = Type.Object({ schemaVersion: Type.Literal(1), sessionId: Type.String({ minLength: 1 }), sequence: Type.Integer({ minimum: 0 }), catalogVersion: Type.Literal(1) }, { additionalProperties: false });
export const TransportInitializeResultSchema = Type.Object({ schemaVersion: Type.Literal(1), protocolVersion: Type.Literal(1), features: Type.Array(Type.String({ minLength: 1 })) }, { additionalProperties: false });
export const ChildSpawnResultSchema = Type.Object({ schemaVersion: Type.Literal(1), attempt: AttemptSchema, agentInstance: AgentInstanceSchema, initialBindingEpoch: BindingEpochSchema }, { additionalProperties: false });
export const TOOL_EXECUTION_RESULT_MAX_BYTES = 1024 * 1024;
export const ToolExecutionResultSchema = Type.Object({ schemaVersion: Type.Literal(1), toolCallId: Type.String({ minLength: 1 }), toolName: Type.String({ minLength: 1 }), ok: Type.Boolean(), sideEffectState: Type.Union([Type.Literal("none"), Type.Literal("unknown"), Type.Literal("side_effect_unknown")]), result: Type.Optional(FoundationJsonValueSchema), artifacts: Type.Optional(Type.Array(ArtifactRefSchema)), error: Type.Optional(PublicExecutionErrorSchema), toolReceiptRef: Type.Optional(Type.String({ minLength: 1 })) }, { additionalProperties: false });
export const ScopedModelResultSchema = Type.Object({ schemaVersion: Type.Literal(1), requestId: Type.String({ minLength: 1 }), usage: BudgetUsageSchema, stopReason: Type.Union([Type.Literal("stop"), Type.Literal("length"), Type.Literal("tool_use"), Type.Literal("error"), Type.Literal("aborted")]), error: Type.Optional(PublicExecutionErrorSchema) }, { additionalProperties: false });
export const ArtifactPutResultSchema = Type.Object({ schemaVersion: Type.Literal(1), ref: Type.String({ minLength: 1 }), sizeBytes: Type.Integer({ minimum: 0 }) }, { additionalProperties: false });
export const ArtifactVerifyResultSchema = Type.Object({ schemaVersion: Type.Literal(1), digestValid: Type.Boolean() }, { additionalProperties: false });
export const QuotaAttributionSchema = Type.Object({ schemaVersion: Type.Literal(1), taskId: Type.String({ minLength: 1 }), goalId: Type.Optional(Type.String({ minLength: 1 })), runId: Type.Optional(Type.String({ minLength: 1 })), attemptId: Type.Optional(Type.String({ minLength: 1 })), agentInstanceId: Type.Optional(Type.String({ minLength: 1 })), providerId: Type.String({ minLength: 1 }), ownerKind: Type.Union([Type.Literal("host"), Type.Literal("operation_worker"), Type.Literal("agent_executor"), Type.Literal("external_connector")]) }, { additionalProperties: false });
export const QuotaReservationSchema = Type.Object({ schemaVersion: Type.Literal(1), reservationId: Type.String({ minLength: 1 }), attribution: QuotaAttributionSchema, budget: BudgetSchema, grantedAt: Type.String({ minLength: 1 }), expiresAt: Type.Optional(Type.String({ minLength: 1 })) }, { additionalProperties: false });
export const ProductTimelineEntrySchema = Type.Object({ schemaVersion: Type.Literal(1), sequence: Type.Integer({ minimum: 0 }), kind: Type.Union([Type.Literal("ask"), Type.Literal("task_result"), Type.Literal("run_receipt"), Type.Literal("artifact")]), ref: Type.Object({ type: Type.String({ minLength: 1 }), id: Type.String({ minLength: 1 }) }, { additionalProperties: false }), recordedAt: Type.String({ minLength: 1 }) }, { additionalProperties: false });
export const ProductAcceptanceFactSchema = Type.Object({ schemaVersion: Type.Literal(1), factId: Type.String({ minLength: 1 }), outcome: Type.String({ minLength: 1 }) }, { additionalProperties: false });
export const ExecutionProviderDescriptorSchema = Type.Object({ schemaVersion: Type.Literal(1), providerId: Type.String({ minLength: 1 }), providerClass: Type.Union([Type.Literal("operation_worker"), Type.Literal("scheduler"), Type.Literal("task_executor"), Type.Literal("agent"), Type.Literal("external_connector")]) }, { additionalProperties: false });
function validateProviderBoundary<T>(schema: Parameters<typeof validateExactShape>[0], value: unknown, kind: string, jsonFields: readonly string[] = []): ResultValue<T, FoundationError> {
	const record = value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
	if (record !== undefined && jsonFields.some((field) => record[field] !== undefined && !validateProviderJson(record[field]))) return Result.err(new FoundationError("foundation_schema_invalid_shape", `${kind} contains a non-JSON payload`));
	return validateExactShape<T>(schema, value, kind);
}
export function validateSandboxOperationRequest(value: unknown): ResultValue<SandboxOperationRequest, FoundationError> { return validateProviderBoundary<SandboxOperationRequest>(SandboxOperationRequestSchema, value, "sandbox_operation_request"); }
export function validateFoundationProviderCapability(value: unknown): ResultValue<FoundationProviderCapability, FoundationError> { return validateProviderBoundary<FoundationProviderCapability>(FoundationProviderCapabilitySchema, value, "provider_capability"); }
export function validateExecutionProviderDescriptor(value: unknown): ResultValue<ExecutionProviderDescriptor, FoundationError> { return validateProviderBoundary<ExecutionProviderDescriptor>(ExecutionProviderDescriptorSchema, value, "execution_provider_descriptor"); }
export function serializeSandboxOperationRequest(value: SandboxOperationRequest): string { return serializeExactShape(SandboxOperationRequestSchema, value, "sandbox_operation_request"); }
export function parseSandboxOperationRequest(text: string): ResultValue<SandboxOperationRequest, FoundationError> { return parseExactShape(SandboxOperationRequestSchema, text, "sandbox_operation_request"); }
export function createConnectorCapabilitySnapshot(input: ConnectorCapabilitySnapshotInput): ConnectorCapabilitySnapshot {
	const checked = validateConnectorCapabilitySnapshot({ ...input, digest: fingerprintFoundationValue(input) });
	if (!checked.ok) throw checked.error;
	return checked.value;
}
export function validateConnectorCapabilitySnapshot(value: unknown): ResultValue<ConnectorCapabilitySnapshot, FoundationError> {
	const checked = validateProviderBoundary<ConnectorCapabilitySnapshot>(ConnectorCapabilitySnapshotSchema, value, "connector_capability_snapshot");
	if (!checked.ok) return checked;
	const { digest, ...snapshot } = checked.value;
	if (fingerprintFoundationValue(snapshot).value !== digest.value) return Result.err(new FoundationError("foundation_schema_invalid_shape", "connector_capability_snapshot digest does not match its immutable fields", { details: { providerId: checked.value.providerId, revision: checked.value.revision } }));
	return Result.ok(cloneDeepFrozen(checked.value));
}
export function validateChildSpawnRequest(value: unknown): ResultValue<ChildSpawnRequest, FoundationError> { return validateProviderBoundary<ChildSpawnRequest>(ChildSpawnRequestSchema, value, "child_spawn_request"); }
export function validateToolGatewayRequest(value: unknown): ResultValue<ToolGatewayRequest, FoundationError> { return validateProviderBoundary<ToolGatewayRequest>(ToolGatewayRequestSchema, value, "tool_gateway_request", ["originalArguments"]); }
export function validateScopedModelRequest(value: unknown): ResultValue<ScopedModelRequest, FoundationError> { return validateProviderBoundary<ScopedModelRequest>(ScopedModelRequestSchema, value, "scoped_model_request", ["modelProfileRevision", "input"]); }
export function validateChildSpawnResult(value: unknown): ResultValue<ChildSpawnResult, FoundationError> { return validateProviderBoundary<ChildSpawnResult>(ChildSpawnResultSchema, value, "child_spawn_result"); }
export function validateToolExecutionResult(value: unknown): ResultValue<ToolExecutionResult, FoundationError> {
	const checked = validateProviderBoundary<ToolExecutionResult>(ToolExecutionResultSchema, value, "tool_execution_result", ["result"]);
	if (!checked.ok || checked.value.result === undefined) return checked;
	const resultBytes = new TextEncoder().encode(canonicalFoundationJson(checked.value.result)).byteLength;
	return resultBytes <= TOOL_EXECUTION_RESULT_MAX_BYTES
		? checked
		: Result.err(new FoundationError("foundation_schema_invalid_shape", "tool_execution_result result exceeds the bounded JSON size", {
			details: { resultBytes, maxBytes: TOOL_EXECUTION_RESULT_MAX_BYTES },
		}));
}
export function validateScopedModelResult(value: unknown): ResultValue<ScopedModelResult, FoundationError> { return validateProviderBoundary<ScopedModelResult>(ScopedModelResultSchema, value, "scoped_model_result"); }
export function validateArtifactPutResult(value: unknown): ResultValue<ArtifactPutResult, FoundationError> { return validateProviderBoundary<ArtifactPutResult>(ArtifactPutResultSchema, value, "artifact_put_result"); }
export function validateArtifactVerifyResult(value: unknown): ResultValue<ArtifactVerifyResult, FoundationError> { return validateProviderBoundary<ArtifactVerifyResult>(ArtifactVerifyResultSchema, value, "artifact_verify_result"); }
export function validateQuotaAttribution(value: unknown): ResultValue<QuotaAttribution, FoundationError> { return validateProviderBoundary<QuotaAttribution>(QuotaAttributionSchema, value, "quota_attribution"); }
export function validateQuotaReservation(value: unknown): ResultValue<QuotaReservation, FoundationError> { return validateProviderBoundary<QuotaReservation>(QuotaReservationSchema, value, "quota_reservation"); }
export function validateProductTimelineEntry(value: unknown): ResultValue<ProductTimelineEntry, FoundationError> { return validateProviderBoundary<ProductTimelineEntry>(ProductTimelineEntrySchema, value, "product_timeline_entry"); }
export function validateProductAcceptanceFact(value: unknown): ResultValue<ProductAcceptanceFact, FoundationError> { return validateProviderBoundary<ProductAcceptanceFact>(ProductAcceptanceFactSchema, value, "product_acceptance_fact"); }
export function serializeConnectorCapabilitySnapshot(value: ConnectorCapabilitySnapshot): string {
	const checked = validateConnectorCapabilitySnapshot(value);
	if (!checked.ok) throw checked.error;
	return serializeExactShape(ConnectorCapabilitySnapshotSchema, checked.value, "connector_capability_snapshot");
}
export function parseConnectorCapabilitySnapshot(text: string): ResultValue<ConnectorCapabilitySnapshot, FoundationError> {
	const parsed = parseExactShape<ConnectorCapabilitySnapshot>(ConnectorCapabilitySnapshotSchema, text, "connector_capability_snapshot");
	return parsed.ok ? validateConnectorCapabilitySnapshot(parsed.value) : parsed;
}
export function serializeChildSpawnRequest(value: ChildSpawnRequest): string { return serializeExactShape(ChildSpawnRequestSchema, value, "child_spawn_request"); }
export function parseChildSpawnRequest(text: string): ResultValue<ChildSpawnRequest, FoundationError> { return parseExactShape(ChildSpawnRequestSchema, text, "child_spawn_request"); }
export function serializeToolGatewayRequest(value: ToolGatewayRequest): string { return serializeExactShape(ToolGatewayRequestSchema, value, "tool_gateway_request"); }
export function parseToolGatewayRequest(text: string): ResultValue<ToolGatewayRequest, FoundationError> { return parseExactShape(ToolGatewayRequestSchema, text, "tool_gateway_request"); }
export function serializeScopedModelRequest(value: ScopedModelRequest): string { return serializeExactShape(ScopedModelRequestSchema, value, "scoped_model_request"); }
export function parseScopedModelRequest(text: string): ResultValue<ScopedModelRequest, FoundationError> { return parseExactShape(ScopedModelRequestSchema, text, "scoped_model_request"); }
export function serializeChildSpawnResult(value: ChildSpawnResult): string { return serializeExactShape(ChildSpawnResultSchema, value, "child_spawn_result"); }
export function parseChildSpawnResult(text: string): ResultValue<ChildSpawnResult, FoundationError> { return parseExactShape(ChildSpawnResultSchema, text, "child_spawn_result"); }
export function serializeToolExecutionResult(value: ToolExecutionResult): string {
	const checked = validateToolExecutionResult(value);
	if (!checked.ok) throw checked.error;
	return serializeExactShape(ToolExecutionResultSchema, checked.value, "tool_execution_result");
}
export function parseToolExecutionResult(text: string): ResultValue<ToolExecutionResult, FoundationError> {
	const parsed = parseExactShape<ToolExecutionResult>(ToolExecutionResultSchema, text, "tool_execution_result");
	return parsed.ok ? validateToolExecutionResult(parsed.value) : parsed;
}
export function serializeScopedModelResult(value: ScopedModelResult): string { return serializeExactShape(ScopedModelResultSchema, value, "scoped_model_result"); }
export function parseScopedModelResult(text: string): ResultValue<ScopedModelResult, FoundationError> { return parseExactShape(ScopedModelResultSchema, text, "scoped_model_result"); }
export function serializeFoundationProviderCapability(value: FoundationProviderCapability): string { return serializeExactShape(FoundationProviderCapabilitySchema, value, "provider_capability"); }
export function parseFoundationProviderCapability(text: string): ResultValue<FoundationProviderCapability, FoundationError> { return parseExactShape(FoundationProviderCapabilitySchema, text, "provider_capability"); }
export function serializeArtifactPutResult(value: ArtifactPutResult): string { return serializeExactShape(ArtifactPutResultSchema, value, "artifact_put_result"); }
export function parseArtifactPutResult(text: string): ResultValue<ArtifactPutResult, FoundationError> { return parseExactShape(ArtifactPutResultSchema, text, "artifact_put_result"); }
export function serializeArtifactVerifyResult(value: ArtifactVerifyResult): string { return serializeExactShape(ArtifactVerifyResultSchema, value, "artifact_verify_result"); }
export function parseArtifactVerifyResult(text: string): ResultValue<ArtifactVerifyResult, FoundationError> { return parseExactShape(ArtifactVerifyResultSchema, text, "artifact_verify_result"); }
export function serializeQuotaAttribution(value: QuotaAttribution): string { return serializeExactShape(QuotaAttributionSchema, value, "quota_attribution"); }
export function parseQuotaAttribution(text: string): ResultValue<QuotaAttribution, FoundationError> { return parseExactShape(QuotaAttributionSchema, text, "quota_attribution"); }
export function serializeQuotaReservation(value: QuotaReservation): string { return serializeExactShape(QuotaReservationSchema, value, "quota_reservation"); }
export function parseQuotaReservation(text: string): ResultValue<QuotaReservation, FoundationError> { return parseExactShape(QuotaReservationSchema, text, "quota_reservation"); }
export function serializeProductTimelineEntry(value: ProductTimelineEntry): string { return serializeExactShape(ProductTimelineEntrySchema, value, "product_timeline_entry"); }
export function parseProductTimelineEntry(text: string): ResultValue<ProductTimelineEntry, FoundationError> { return parseExactShape(ProductTimelineEntrySchema, text, "product_timeline_entry"); }
export function serializeProductAcceptanceFact(value: ProductAcceptanceFact): string { return serializeExactShape(ProductAcceptanceFactSchema, value, "product_acceptance_fact"); }
export function parseProductAcceptanceFact(text: string): ResultValue<ProductAcceptanceFact, FoundationError> { return parseExactShape(ProductAcceptanceFactSchema, text, "product_acceptance_fact"); }
