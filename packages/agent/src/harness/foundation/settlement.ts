import { Result, type Result as ResultValue } from "../result.ts";
import type { Session } from "../session/session.ts";
import { DurableLedgerError } from "../session/durable/errors.ts";
import { FoundationError, toFoundationError, type FoundationErrorCode, type PublicExecutionError } from "./errors.ts";
import { canonicalFoundationJson, extendFoundationLineage, fingerprintFoundationValue, type ExecutionCorrelation, type FoundationLineage } from "./identity.ts";
import { cloneDeepFrozen } from "./immutability.ts";
import { executeDispatch, executeOperation, executeAgentSpawn, startDispatchAttempt, switchAgentMode, type DispatchAttemptStartResult, type DispatchExecutionInput, type DispatchExecutionResult, type OperationExecutionInput, type ChildSpawnExecutionInput, type ModeSwitchExecutionInput } from "./execution.ts";
import { validateImmutableAgentBinding } from "./binding.ts";
import { validateAttemptReceiptForProvider, validateWorkerReceiptForProvider } from "./conformance.ts";
import {
	finalizeRunReceipt,
	settleTaskResult,
	validateAttemptReceipt,
	validateWorkerReceipt,
	validateRunReceipt,
	validateTaskResult,
	type AttemptReceipt,
	type FinalizeRunReceiptInput,
	type HostTerminalGateAuthority,
	type RunReceipt,
	type RunReceiptUsage,
	type SettleTaskResultInput,
	type TaskResult,
	type WorkerReceipt,
} from "./results.ts";
import { validateChildSpawnRequest, validateChildSpawnResult, type ChildAgentProvider, type ChildSpawnRequest, type ChildSpawnResult, type ExternalAgentConnector, type FoundationProviderExecutionOptions, type TaskExecutorProvider } from "./providers.ts";
import { validateAgentInstance, validateBindingEpoch, validateRoleRevision, type AgentBinding, type AgentInstance, type BindingEpoch, type ModelProfile, type ModelRoute, type RoleRevision } from "./role.ts";
import { validateRoleRegistryRecord } from "./role-registry.ts";
import { validateSecretFreeModelProfile } from "./model-profile.ts";
import { validateAttempt, validateDispatch, validateSpawnAgentIntent, validateTaskEnvelope, type Attempt, type Dispatch, type SpawnAgentIntent, type TaskEnvelope } from "./task.ts";
import { validateLineage } from "./schema.ts";
import { SessionLedger } from "./session-ledger.ts";
import { createDurableEvent, type DurableEventEnvelope, type EventCorrelationRef, type FoundationJsonValue, type RunReceiptEventPayload } from "./event-catalog.ts";
import type { FoundationFactRecord, FoundationIntentRecord } from "../session/durable/types.ts";
import type { SessionLedgerWriter } from "../session/ledger-writer.ts";

export interface FoundationTaskPersistenceOptions {
	readonly ownerId?: string;
	readonly writer?: SessionLedgerWriter;
}

export type RunReceiptWrittenEvent = DurableEventEnvelope<"run_receipt.written", RunReceiptEventPayload>;

/** One canonical, replay-safe result projection rooted in the Host RunReceipt fact. */
export interface CanonicalRunResult {
	readonly schemaVersion: 1;
	readonly runReceipt: RunReceipt;
	readonly taskResult?: TaskResult;
	readonly attemptReceipts: readonly AttemptReceipt[];
	readonly writtenEvent: RunReceiptWrittenEvent;
}

interface DurableRunReceipt {
	readonly record: FoundationFactRecord;
	readonly receipt: RunReceipt;
}

/**
 * The public execution surface establishes the TaskEnvelope in Session before
 * binding or role resolution can consume it. Existing task identities are
 * immutable; a caller cannot replace a durable task with a caller-shaped copy.
 */
export async function persistTaskEnvelopeBeforeResolver(session: Session, task: TaskEnvelope, options: FoundationTaskPersistenceOptions = {}): Promise<ResultValue<TaskEnvelope, FoundationError>> {
	const checked = validateTaskEnvelope(task);
	if (!checked.ok) return checked;
	const ledger = new SessionLedger(session, { ownerId: options.ownerId, writer: options.writer });
	try {
		const existing = await ledger.get("task", checked.value.taskId);
		if (existing?.kind === "fact") {
			if (canonicalFoundationJson(existing.payload) !== canonicalFoundationJson(checked.value)) return Result.err(new FoundationError("session_ledger_conflict", "A durable TaskEnvelope already exists with different content", { details: { taskId: checked.value.taskId } }));
			return Result.ok(cloneDeepFrozen(existing.payload as unknown as TaskEnvelope));
		}
		if (existing !== undefined) return Result.err(new FoundationError("session_ledger_tombstoned", "A durable TaskEnvelope identity cannot replace a terminal object", { details: { taskId: checked.value.taskId } }));
		const stored = await ledger.appendFact("task", checked.value.taskId, checked.value, { clientRequestId: `task:${checked.value.taskId}`, expectedRevision: 0, correlation: { taskId: checked.value.taskId, goalId: checked.value.goalId } });
		return Result.ok(cloneDeepFrozen(stored.payload));
	} catch (error) {
		if (error instanceof DurableLedgerError) throw error;
		return Result.err(toFoundationError(error, "session_writer_stale_revision"));
	} finally {
		await ledger.release();
	}
}

/** Validate every immutable reference used by an AgentBinding against Session facts. */
export async function validateDurableBindingSources(session: Session, binding: AgentBinding, task?: TaskEnvelope): Promise<ResultValue<AgentBinding, FoundationError>> {
	const checked = validateImmutableAgentBinding(binding);
	if (!checked.ok) return checked;
	const ledger = new SessionLedger(session);
	try {
		await requireDurableBindingSources(ledger, checked.value, task);
		return Result.ok(cloneDeepFrozen(checked.value));
	} catch (error) {
		if (error instanceof FoundationError) return Result.err(error);
		if (error instanceof DurableLedgerError) throw error;
		return Result.err(toFoundationError(error, "binding_required_fact"));
	} finally {
		await ledger.release();
	}
}

export interface LayeredTaskSettlementInput {
	readonly taskResultId: string;
	readonly task: TaskEnvelope;
	/** Receipts that determine the TaskResult status for this Task. */
	readonly sourceAttemptReceiptIds: readonly string[];
	/** Additional Host-selected composition receipts retained only as provenance. */
	readonly provenanceAttemptReceiptIds?: readonly string[];
	readonly summary: string;
	readonly artifacts?: SettleTaskResultInput["artifacts"];
	readonly diff?: SettleTaskResultInput["diff"];
	readonly tests: SettleTaskResultInput["tests"];
	readonly evidence: SettleTaskResultInput["evidence"];
	readonly producer: SettleTaskResultInput["producer"];
	readonly validation?: SettleTaskResultInput["validation"];
}

export interface LayeredRunFinalizationInput {
	readonly runReceiptId: string;
	readonly runId: string;
	readonly terminalStatus: FinalizeRunReceiptInput["terminalStatus"];
	readonly authority: HostTerminalGateAuthority;
	readonly attemptReceiptIds: readonly string[];
	readonly taskResultId?: string;
	readonly usage: RunReceiptUsage;
	readonly terminalErrorCode?: string;
	readonly terminalError?: PublicExecutionError;
	readonly completedAt?: string;
}

/** Durable idempotency identity for child-agent provider side effects. */
export const AGENT_SPAWN_OBJECT_TYPE = "agent_spawn";
export interface AgentSpawnIntentPayload {
	readonly schemaVersion: 1;
	readonly spawnId: string;
	readonly providerId: string;
	readonly request: ChildSpawnRequest;
	readonly correlation: ExecutionCorrelation;
}
export interface AgentSpawnFactPayload {
	readonly schemaVersion: 1;
	readonly spawnId: string;
	readonly providerId: string;
	readonly request: ChildSpawnRequest;
	readonly result: ChildSpawnResult;
	readonly contextId: string;
}

export interface DurableBindingFacts {
	readonly roleRevision: RoleRevision;
	readonly modelProfile: ModelProfile;
	readonly modelRoute: ModelRoute;
}

export interface DispatchStartResult extends DispatchAttemptStartResult {
	readonly receipt?: AttemptReceipt;
}

interface TaskExecutorProviderResumeSurface extends TaskExecutorProvider {
	readonly resumeAttempt?: (attemptId: string, options: FoundationProviderExecutionOptions) => Promise<ResultValue<AttemptReceipt, FoundationError>>;
	readonly resume?: (attemptId: string, options?: { readonly signal?: AbortSignal }) => Promise<ResultValue<AttemptReceipt, FoundationError>>;
}

function durableReferenceMatches(reference: { readonly id: string; readonly revision: number; readonly fingerprint?: { readonly value: string } }, payload: unknown): boolean {
	if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return false;
	const record = payload as Record<string, unknown>;
	if (record.revision !== reference.revision) return false;
	if (reference.fingerprint === undefined) return false;
	return fingerprintFoundationValue(payload).value === reference.fingerprint.value;
}

function sourceRequired(reference: { readonly id: string; readonly revision: number }, field: string): FoundationError {
	return new FoundationError("binding_required_fact", `AgentBinding ${field} must resolve to a durable immutable source fact`, { details: { field, objectId: reference.id, revision: reference.revision } });
}

function immutableEntityFingerprintValid(payload: { readonly fingerprint: { readonly value: string } } & Record<string, unknown>): boolean {
	const { fingerprint, ...base } = payload;
	return fingerprint.value === fingerprintFoundationValue(base).value;
}

function correlationRecord(correlation: ExecutionCorrelation): Record<string, string | undefined> {
	const record: Record<string, string | undefined> = {};
	for (const [key, value] of Object.entries(correlation)) if (typeof value === "string") record[key] = value;
	return record;
}

async function findDurableRoleRevision(ledger: SessionLedger, reference: AgentBinding["roleRevision"]): Promise<RoleRevision> {
	const direct = await ledger.get("role_revision", reference.id);
	if (direct?.kind === "fact") {
		const checked = validateRoleRevision(direct.payload);
		if (checked.ok && checked.value.roleRevisionId === reference.id && checked.value.revision === reference.revision && checked.value.fingerprint.value === reference.fingerprint?.value && immutableEntityFingerprintValid(checked.value as unknown as { readonly fingerprint: { readonly value: string } } & Record<string, unknown>)) return checked.value;
	}
	const records = await ledger.find({ kind: "fact", objectType: "role_registry", order: "oldestFirst" });
	for (const record of records) {
		if (record.kind !== "fact") continue;
		const checked = validateRoleRegistryRecord(record.payload);
		if (!checked.ok) continue;
		const revision = checked.value.revisions.find((candidate) => candidate.roleRevisionId === reference.id && candidate.revision === reference.revision);
		if (revision !== undefined && revision.fingerprint.value === reference.fingerprint?.value && immutableEntityFingerprintValid(revision as unknown as { readonly fingerprint: { readonly value: string } } & Record<string, unknown>)) return revision;
	}
	throw sourceRequired(reference, "roleRevision");
}

async function findCanonicalRoleRevision(ledger: SessionLedger, roleRevisionId: string, revision: number): Promise<RoleRevision> {
	const direct = await ledger.get("role_revision", roleRevisionId);
	if (direct?.kind === "fact") {
		const checked = validateRoleRevision(direct.payload);
		if (checked.ok && checked.value.roleRevisionId === roleRevisionId && checked.value.revision === revision && immutableEntityFingerprintValid(checked.value as unknown as { readonly fingerprint: { readonly value: string } } & Record<string, unknown>)) return checked.value;
	}
	const records = await ledger.find({ kind: "fact", objectType: "role_registry", order: "oldestFirst" });
	for (const record of records) {
		if (record.kind !== "fact") continue;
		const checked = validateRoleRegistryRecord(record.payload);
		if (!checked.ok) continue;
		const candidate = checked.value.revisions.find((item) => item.roleRevisionId === roleRevisionId && item.revision === revision);
		if (candidate !== undefined && immutableEntityFingerprintValid(candidate as unknown as { readonly fingerprint: { readonly value: string } } & Record<string, unknown>)) return candidate;
	}
	throw new FoundationError("binding_required_fact", "Requested RoleRevision is not present in the durable registry", { details: { roleRevisionId, revision } });
}

function profileFromRecord(payload: unknown, reference: AgentBinding["modelProfileRevision"]): ModelProfile | undefined {
	const direct = validateSecretFreeModelProfile(payload);
	if (direct.ok && direct.value.modelProfileId === reference.id && direct.value.revision === reference.revision && direct.value.fingerprint.value === reference.fingerprint?.value) return direct.value;
	if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return undefined;
	const record = payload as Record<string, unknown>;
	if (record.modelProfileId !== reference.id || !Array.isArray(record.revisions)) return undefined;
	for (const candidate of record.revisions) {
		const checked = validateSecretFreeModelProfile(candidate);
		if (checked.ok && checked.value.modelProfileId === reference.id && checked.value.revision === reference.revision && checked.value.fingerprint.value === reference.fingerprint?.value) return checked.value;
	}
	return undefined;
}

function profileFromIdentity(payload: unknown, modelProfileId: string, revision: number): ModelProfile | undefined {
	const direct = validateSecretFreeModelProfile(payload);
	if (direct.ok && direct.value.modelProfileId === modelProfileId && direct.value.revision === revision) return direct.value;
	if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return undefined;
	const record = payload as Record<string, unknown>;
	if (record.modelProfileId !== modelProfileId || !Array.isArray(record.revisions)) return undefined;
	for (const candidate of record.revisions) {
		const checked = validateSecretFreeModelProfile(candidate);
		if (checked.ok && checked.value.modelProfileId === modelProfileId && checked.value.revision === revision) return checked.value;
	}
	return undefined;
}

async function findDurableModelProfile(ledger: SessionLedger, reference: AgentBinding["modelProfileRevision"]): Promise<ModelProfile> {
	const direct = await ledger.get("model_profile_revision", reference.id);
	if (direct?.kind === "fact") {
		const profile = profileFromRecord(direct.payload, reference);
		if (profile !== undefined) return profile;
	}
	const records = await ledger.find({ kind: "fact", objectType: "model_profile", order: "oldestFirst" });
	for (const record of records) {
		if (record.kind !== "fact") continue;
		const profile = profileFromRecord(record.payload, reference);
		if (profile !== undefined) return profile;
	}
	throw sourceRequired(reference, "modelProfileRevision");
}

async function findCanonicalModelProfile(ledger: SessionLedger, modelProfileId: string, revision: number): Promise<ModelProfile> {
	const direct = await ledger.get("model_profile_revision", modelProfileId);
	if (direct?.kind === "fact") {
		const profile = profileFromIdentity(direct.payload, modelProfileId, revision);
		if (profile !== undefined) return profile;
	}
	const records = await ledger.find({ kind: "fact", objectType: "model_profile", order: "oldestFirst" });
	for (const record of records) {
		if (record.kind !== "fact") continue;
		const profile = profileFromIdentity(record.payload, modelProfileId, revision);
		if (profile !== undefined) return profile;
	}
	throw new FoundationError("binding_required_fact", "Requested ModelProfile is not present in the durable registry", { details: { modelProfileId, revision } });
}

function routeFromProfile(profile: ModelProfile): ModelRoute {
	return { provider: profile.provider, model: profile.model, ...(profile.effort === undefined ? {} : { effort: profile.effort }), ...(profile.serviceTier === undefined ? {} : { serviceTier: profile.serviceTier }), ...(profile.fallback === undefined ? {} : { fallback: profile.fallback.map((route) => ({ ...route })) }) };
}

function canonicalBindingFromFacts(binding: AgentBinding, facts: DurableBindingFacts): AgentBinding {
	const { fingerprint: _callerFingerprint, ...bindingBase } = binding;
	const base = {
		...bindingBase,
		roleRevision: { schemaVersion: 1 as const, type: "role_revision" as const, id: facts.roleRevision.roleRevisionId, revision: facts.roleRevision.revision, fingerprint: facts.roleRevision.fingerprint },
		modelProfileRevision: { schemaVersion: 1 as const, type: "model_profile_revision" as const, id: facts.modelProfile.modelProfileId, revision: facts.modelProfile.revision, fingerprint: facts.modelProfile.fingerprint },
		modelRoute: facts.modelRoute,
	};
	return { ...base, fingerprint: fingerprintFoundationValue(base) };
}

function canonicalAgentInstanceRole(agent: AgentInstance, role: RoleRevision): ResultValue<AgentInstance, FoundationError> {
	if (agent.roleRevision.id !== role.roleRevisionId || agent.roleRevision.revision !== role.revision) return Result.err(new FoundationError("invalid_correlation", "AgentInstance RoleRevision does not match the canonical durable RoleRevision", { details: { agentInstanceId: agent.agentInstanceId, roleRevisionId: role.roleRevisionId, revision: role.revision } }));
	return Result.ok({ ...agent, roleRevision: { schemaVersion: 1, type: "role_revision", id: role.roleRevisionId, revision: role.revision, fingerprint: role.fingerprint } });
}

function spawnCorrelationValid(correlation: ExecutionCorrelation, request: ChildSpawnRequest): boolean {
	return typeof correlation.sessionId === "string" && correlation.sessionId.length > 0 && typeof correlation.laneId === "string" && correlation.laneId.length > 0 && Number.isSafeInteger(correlation.revision) && correlation.revision >= 0 && correlation.taskId === request.taskEnvelope.taskId && typeof correlation.agentInstanceId === "string" && correlation.agentInstanceId.length > 0;
}

interface SpawnContextRecordV1 {
	readonly schemaVersion: 1;
	readonly contextId: string;
	readonly taskId: string;
	readonly spawnId: string;
	readonly forkScope: ChildSpawnRequest["forkScope"];
	readonly parentTaskId?: string;
	readonly parentContextId?: string;
	readonly parentAttemptId?: string;
	readonly parentAgentInstanceId?: string;
	readonly lineage: FoundationLineage;
	readonly createdAt: string;
}

function spawnContextId(spawnId: string): string {
	return `context_${spawnId}`;
}

function validateSpawnIntentIdentity(intent: SpawnAgentIntent, request: ChildSpawnRequest, providerId: string): ResultValue<SpawnAgentIntent, FoundationError> {
	const checked = validateSpawnAgentIntent(intent);
	if (!checked.ok) return checked;
	if (intent.spawnId === request.spawnId) return Result.err(new FoundationError("invalid_correlation", "Agent spawn must allocate a child Context identity distinct from its parent Context", { details: { spawnId: request.spawnId } }));
	if (intent.newTaskEnvelopeRef.id !== request.taskEnvelope.taskId) return Result.err(new FoundationError("invalid_correlation", "Agent spawn parent intent does not identify the requested child TaskEnvelope", { details: { spawnId: request.spawnId } }));
	if (intent.providerId !== undefined && intent.providerId !== providerId) return Result.err(new FoundationError("invalid_correlation", "Agent spawn parent intent provider does not match the selected child provider", { details: { spawnId: request.spawnId } }));
	if (intent.newTaskEnvelopeRef.providerId !== undefined && intent.newTaskEnvelopeRef.providerId !== providerId) return Result.err(new FoundationError("invalid_correlation", "Agent spawn TaskEnvelope reference provider does not match the selected child provider", { details: { spawnId: request.spawnId } }));
	return Result.ok(checked.value);
}

function parseSpawnContext(payload: unknown, expectedContextId: string): ResultValue<SpawnContextRecordV1, FoundationError> {
	if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return Result.err(new FoundationError("invalid_correlation", "Agent spawn parent Context is not a durable object", { details: { contextId: expectedContextId } }));
	const candidate = payload as Record<string, unknown>;
	if (candidate.schemaVersion !== 1 || candidate.contextId !== expectedContextId || typeof candidate.taskId !== "string" || candidate.taskId.length === 0 || typeof candidate.spawnId !== "string" || candidate.spawnId.length === 0 || typeof candidate.forkScope !== "string" || !["none", "all", "recent_n", "task_package"].includes(candidate.forkScope) || typeof candidate.createdAt !== "string") return Result.err(new FoundationError("invalid_correlation", "Agent spawn parent Context identity is incomplete", { details: { contextId: expectedContextId } }));
	if (candidate.parentTaskId !== undefined && (typeof candidate.parentTaskId !== "string" || candidate.parentTaskId.length === 0)) return Result.err(new FoundationError("invalid_correlation", "Agent spawn parent Context Task identity is invalid", { details: { contextId: expectedContextId } }));
	if (candidate.lineage === undefined) return Result.err(new FoundationError("invalid_correlation", "Agent spawn parent Context is missing durable lineage", { details: { contextId: expectedContextId } }));
	const lineage = validateLineage(candidate.lineage);
	if (!lineage.ok) return Result.err(new FoundationError("invalid_correlation", "Agent spawn parent Context lineage is invalid", { details: { contextId: expectedContextId } }));
	if (lineage.value.entityType !== "context" || lineage.value.entityId !== expectedContextId) return Result.err(new FoundationError("invalid_correlation", "Agent spawn parent Context lineage does not match its identity", { details: { contextId: expectedContextId } }));
	if (candidate.parentContextId !== undefined && (typeof candidate.parentContextId !== "string" || candidate.parentContextId.length === 0)) return Result.err(new FoundationError("invalid_correlation", "Agent spawn parent Context parent identity is invalid", { details: { contextId: expectedContextId } }));
	if (candidate.parentAttemptId !== undefined && (typeof candidate.parentAttemptId !== "string" || candidate.parentAttemptId.length === 0)) return Result.err(new FoundationError("invalid_correlation", "Agent spawn parent Context Attempt identity is invalid", { details: { contextId: expectedContextId } }));
	if (candidate.parentAgentInstanceId !== undefined && (typeof candidate.parentAgentInstanceId !== "string" || candidate.parentAgentInstanceId.length === 0)) return Result.err(new FoundationError("invalid_correlation", "Agent spawn parent Context AgentInstance identity is invalid", { details: { contextId: expectedContextId } }));
	return Result.ok({ schemaVersion: 1, contextId: expectedContextId, taskId: candidate.taskId, spawnId: candidate.spawnId, forkScope: candidate.forkScope as SpawnContextRecordV1["forkScope"], ...(candidate.parentTaskId === undefined ? {} : { parentTaskId: candidate.parentTaskId }), ...(candidate.parentContextId === undefined ? {} : { parentContextId: candidate.parentContextId }), ...(candidate.parentAttemptId === undefined ? {} : { parentAttemptId: candidate.parentAttemptId }), ...(candidate.parentAgentInstanceId === undefined ? {} : { parentAgentInstanceId: candidate.parentAgentInstanceId }), lineage: lineage.value, createdAt: candidate.createdAt });
}

function parseSpawnFact(payload: unknown, spawnId: string, providerId: string): ResultValue<AgentSpawnFactPayload, FoundationError> {
	if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return Result.err(new FoundationError("session_ledger_conflict", "Durable spawn fact is not an object", { details: { spawnId } }));
	const candidate = payload as Record<string, unknown>;
	if (candidate.schemaVersion !== 1 || candidate.spawnId !== spawnId || candidate.providerId !== providerId || typeof candidate.contextId !== "string") return Result.err(new FoundationError("session_ledger_conflict", "Durable spawn fact identity does not match the request", { details: { spawnId, providerId } }));
	const request = validateChildSpawnRequest(candidate.request);
	if (!request.ok) return Result.err(new FoundationError("session_ledger_conflict", "Durable spawn fact contains an invalid request", { details: { spawnId } }));
	const result = validateChildSpawnResult(candidate.result);
	if (!result.ok) return Result.err(new FoundationError("session_ledger_conflict", "Durable spawn fact contains an invalid result", { details: { spawnId } }));
	return Result.ok({ schemaVersion: 1, spawnId, providerId, request: request.value, result: result.value, contextId: candidate.contextId });
}

function parseSpawnIntent(record: FoundationIntentRecord, spawnId: string, providerId: string, expectedRequest: ChildSpawnRequest, expectedCorrelation: ExecutionCorrelation): ResultValue<AgentSpawnIntentPayload, FoundationError> {
	const details = { spawnId, providerId };
	if (record.objectId !== spawnId || record.intent !== "create" || record.clientRequestId !== `agent-spawn:${spawnId}`) return Result.err(new FoundationError("session_ledger_conflict", "Durable spawn intent identity does not match the stable spawn request", { details }));
	if (record.payload === undefined || typeof record.payload !== "object" || Array.isArray(record.payload)) return Result.err(new FoundationError("session_ledger_conflict", "Durable spawn intent has no replayable request", { details }));
	const candidate = record.payload as Record<string, unknown>;
	if (candidate.schemaVersion !== 1 || candidate.spawnId !== spawnId || candidate.providerId !== providerId) return Result.err(new FoundationError("session_ledger_conflict", "Durable spawn intent provider identity does not match the current provider", { details }));
	const request = validateChildSpawnRequest(candidate.request);
	if (!request.ok || canonicalFoundationJson(request.value) !== canonicalFoundationJson(expectedRequest)) return Result.err(new FoundationError("session_ledger_conflict", "A stable spawnId is already bound to a different canonical request", { details }));
	const correlation = candidate.correlation;
	if (correlation === undefined || typeof correlation !== "object" || Array.isArray(correlation) || canonicalFoundationJson(correlation) !== canonicalFoundationJson(expectedCorrelation) || !spawnCorrelationValid(correlation as ExecutionCorrelation, request.value)) return Result.err(new FoundationError("session_ledger_conflict", "Durable spawn intent correlation does not match the current request", { details }));
	return Result.ok({ schemaVersion: 1, spawnId, providerId, request: request.value, correlation: correlation as ExecutionCorrelation });
}

function canonicalizeSpawnResult(result: ChildSpawnResult, request: ChildSpawnRequest, providerId: string, role: RoleRevision): ResultValue<ChildSpawnResult, FoundationError> {
	const checkedAttempt = validateAttempt(result.attempt);
	if (!checkedAttempt.ok) return checkedAttempt;
	const checkedAgent = validateAgentInstance(result.agentInstance);
	if (!checkedAgent.ok) return checkedAgent;
	const checkedEpoch = validateBindingEpoch(result.initialBindingEpoch);
	if (!checkedEpoch.ok) return checkedEpoch;
	if (checkedAttempt.value.providerId !== providerId || checkedAttempt.value.taskId !== request.taskEnvelope.taskId) return Result.err(new FoundationError("invalid_correlation", "Agent spawn Attempt does not match its provider or canonical TaskEnvelope", { details: { spawnId: request.spawnId } }));
	if (checkedAgent.value.providerId !== providerId || checkedAgent.value.taskId !== checkedAttempt.value.taskId || checkedAgent.value.agentInstanceId !== checkedAttempt.value.agentInstanceId) return Result.err(new FoundationError("invalid_correlation", "Agent spawn must bind one AgentInstance to its Attempt", { details: { spawnId: request.spawnId } }));
	if (checkedAgent.value.roleRevision.id !== role.roleRevisionId || checkedAgent.value.roleRevision.revision !== role.revision) return Result.err(new FoundationError("invalid_correlation", "Agent spawn AgentInstance must retain the canonical durable RoleRevision", { details: { spawnId: request.spawnId } }));
	if (checkedEpoch.value.ordinal !== 0 || checkedEpoch.value.attemptId !== checkedAttempt.value.attemptId || checkedEpoch.value.taskId !== checkedAttempt.value.taskId || checkedEpoch.value.bindingId !== checkedAttempt.value.bindingId || checkedEpoch.value.agentInstanceId !== checkedAgent.value.agentInstanceId) return Result.err(new FoundationError("invalid_correlation", "Agent spawn epoch does not match its Attempt or AgentInstance", { details: { spawnId: request.spawnId } }));
	if (!checkedAttempt.value.bindingEpochIds.includes(checkedEpoch.value.bindingEpochId)) return Result.err(new FoundationError("invalid_correlation", "Agent spawn Attempt omitted its initial BindingEpoch", { details: { spawnId: request.spawnId } }));
	if (request.parentSpawn !== undefined && (request.parentSpawn.parentTaskId === request.taskEnvelope.taskId || request.parentSpawn.newTaskEnvelopeRef.id !== request.taskEnvelope.taskId)) return Result.err(new FoundationError("invalid_correlation", "Agent spawn parent intent does not identify a distinct requested child TaskEnvelope", { details: { spawnId: request.spawnId } }));
	if (request.parentAgentInstanceId !== undefined && checkedAgent.value.lineage.parentId !== request.parentAgentInstanceId) return Result.err(new FoundationError("invalid_correlation", "Agent spawn child AgentInstance lineage does not identify its parent", { details: { spawnId: request.spawnId } }));
	return Result.ok({ schemaVersion: 1, attempt: checkedAttempt.value, agentInstance: { ...checkedAgent.value, roleRevision: { schemaVersion: 1, type: "role_revision", id: role.roleRevisionId, revision: role.revision, fingerprint: role.fingerprint } }, initialBindingEpoch: checkedEpoch.value });
}

async function requireDurableRevisionFact(ledger: SessionLedger, objectType: string, reference: AgentBinding["contextRevision"]): Promise<void> {
	const fact = await ledger.get(objectType, reference.id);
	if (fact?.kind !== "fact" || !durableReferenceMatches(reference, fact.payload)) throw sourceRequired(reference, reference.type);
}

async function requireDurableBindingSources(ledger: SessionLedger, binding: AgentBinding, task?: TaskEnvelope): Promise<DurableBindingFacts> {
	const role = await findDurableRoleRevision(ledger, binding.roleRevision);
	const profile = await findDurableModelProfile(ledger, binding.modelProfileRevision);
	if (task !== undefined && binding.taskId !== task.taskId) throw new FoundationError("binding_task_before_binding", "Binding references a different durable TaskEnvelope", { details: { bindingId: binding.bindingId, taskId: task.taskId } });
	if (task !== undefined && binding.goalId !== task.goalId) throw new FoundationError("binding_task_before_binding", "Binding goal identity does not match its durable TaskEnvelope", { details: { bindingId: binding.bindingId, taskId: task.taskId } });
	if (binding.roleRevision.id !== role.roleRevisionId || binding.roleRevision.revision !== role.revision || binding.roleRevision.fingerprint?.value !== role.fingerprint.value) throw sourceRequired(binding.roleRevision, "roleRevision");
	if (binding.modelProfileRevision.id !== profile.modelProfileId || binding.modelProfileRevision.revision !== profile.revision || binding.modelProfileRevision.fingerprint?.value !== profile.fingerprint.value) throw sourceRequired(binding.modelProfileRevision, "modelProfileRevision");
	const expectedRoute = routeFromProfile(profile);
	if (canonicalFoundationJson(binding.modelRoute) !== canonicalFoundationJson(expectedRoute)) throw new FoundationError("binding_required_fact", "AgentBinding model route does not match the durable ModelProfile", { details: { bindingId: binding.bindingId, modelProfileId: profile.modelProfileId } });
	await requireDurableRevisionFact(ledger, "external_agent_binding", binding.contextRevision);
	await requireDurableRevisionFact(ledger, "capability_binding", binding.capabilityRevision);
	await requireDurableRevisionFact(ledger, "model_broker_binding", binding.modelBrokerBindingRevision);
	await requireDurableRevisionFact(ledger, "policy_binding", binding.policyRevision);
	return { roleRevision: role, modelProfile: profile, modelRoute: expectedRoute };
}

/**
 * Session-backed provider consumer and Host terminal gate. The Session ledger is
 * the sole authority; this class retains only its writer lease token.
 */
export class LayeredResultSettlement {
	private readonly ledger: SessionLedger;
	private finalizationTail: Promise<void> = Promise.resolve();

	constructor(session: Session, options: { readonly ownerId?: string; readonly writer?: SessionLedgerWriter; readonly laneId?: string } = {}) {
		this.ledger = new SessionLedger(session, { ownerId: options.ownerId, writer: options.writer, laneId: options.laneId });
	}

	async executeOperation(input: OperationExecutionInput): Promise<ResultValue<WorkerReceipt, FoundationError>> {
		const executed = await executeOperation(input);
		if (!executed.ok) return executed;
		const checked = validateWorkerReceiptForProvider(executed.value, { providerId: input.provider.providerId, providerClass: input.provider.providerClass });
		if (!checked.ok) return checked;
		try {
			const stored = await this.persistFact("worker_receipt", checked.value.workerReceiptId, checked.value, { taskId: checked.value.taskId, dispatchId: checked.value.dispatchId, attemptId: checked.value.attemptId }, { immutable: true });
			return Result.ok(cloneDeepFrozen(stored.payload));
		} catch (error) {
			return this.persistenceError(error, "worker_receipt_invalid_producer");
		}
	}

	/** Persist the provider-created Attempt before any provider run side effect. */
	async startDispatch(input: DispatchExecutionInput & { readonly agentInstance?: AgentInstance }): Promise<ResultValue<DispatchStartResult, FoundationError>> {
		const checkedDispatch = validateDispatch(input.dispatch);
		if (!checkedDispatch.ok) return checkedDispatch;
		const checkedBinding = validateImmutableAgentBinding(input.binding);
		if (!checkedBinding.ok) return checkedBinding;
		const checkedEpoch = validateBindingEpoch(input.initialBindingEpoch);
		if (!checkedEpoch.ok) return checkedEpoch;
		if (input.provider.providerClass === "agent") {
			if (input.agentInstance === undefined) return Result.err(new FoundationError("agent_instance_required_for_agent_provider", "Agent provider execution requires a durable AgentInstance", { details: { providerId: input.provider.providerId } }));
			const checkedAgent = validateAgentInstance(input.agentInstance);
			if (!checkedAgent.ok) return checkedAgent;
			if (checkedAgent.value.agentInstanceId !== checkedEpoch.value.agentInstanceId || checkedAgent.value.taskId !== checkedDispatch.value.taskId || checkedAgent.value.providerId !== input.provider.providerId) return Result.err(new FoundationError("invalid_correlation", "AgentInstance does not match the dispatch epoch", { details: { dispatchId: checkedDispatch.value.dispatchId } }));
		} else if (input.agentInstance !== undefined) {
			return Result.err(new FoundationError("agent_instance_forbidden_for_provider", "Non-agent provider execution cannot carry an AgentInstance", { details: { providerId: input.provider.providerId } }));
		}
		try {
			await this.requireExistingTask(checkedDispatch.value.taskId);
			const durableFacts = await this.requireExistingBindingFacts(checkedBinding.value, checkedDispatch.value.taskId);
			const canonicalBinding = canonicalBindingFromFacts(checkedBinding.value, durableFacts);
			const canonicalAgent = input.agentInstance === undefined ? undefined : canonicalAgentInstanceRole(input.agentInstance, durableFacts.roleRevision);
			if (canonicalAgent !== undefined && !canonicalAgent.ok) return canonicalAgent;
			await this.persistFact("agent_binding", canonicalBinding.bindingId, canonicalBinding, { taskId: canonicalBinding.taskId, bindingId: canonicalBinding.bindingId }, { immutable: true });
			await this.persistFact("binding_epoch", checkedEpoch.value.bindingEpochId, checkedEpoch.value, { taskId: checkedEpoch.value.taskId, attemptId: checkedEpoch.value.attemptId, bindingId: checkedEpoch.value.bindingId, bindingEpochId: checkedEpoch.value.bindingEpochId, agentInstanceId: checkedEpoch.value.agentInstanceId }, { immutable: true });
			if (canonicalAgent?.ok) await this.persistFact("agent_instance", canonicalAgent.value.agentInstanceId, canonicalAgent.value, { taskId: canonicalAgent.value.taskId, agentInstanceId: canonicalAgent.value.agentInstanceId }, { immutable: true });
			await this.persistFact("dispatch", checkedDispatch.value.dispatchId, checkedDispatch.value, {
				taskId: checkedDispatch.value.taskId,
				dispatchId: checkedDispatch.value.dispatchId,
				bindingId: checkedDispatch.value.bindingId,
				...(canonicalAgent?.ok ? { agentInstanceId: canonicalAgent.value.agentInstanceId } : {}),
			}, { immutable: true });
			const replayed = await this.findDurableDispatchExecution(checkedDispatch.value, canonicalBinding, checkedEpoch.value, input.provider);
			if (replayed !== undefined) return Result.ok({ ...replayed, receipt: replayed.receipt });
			const existingAttempt = await this.findDurableAttempt(checkedDispatch.value, canonicalBinding, checkedEpoch.value, input.provider);
			const started = await startDispatchAttempt({
				...input,
				binding: canonicalBinding,
				...(canonicalAgent === undefined ? {} : { agentInstance: canonicalAgent.value }),
				roleRevision: durableFacts.roleRevision,
				modelProfile: durableFacts.modelProfile,
				modelRoute: durableFacts.modelRoute,
				existingAttempt,
			});
			if (!started.ok) return started;
			try {
				await this.persistFact("attempt", started.value.attempt.attemptId, started.value.attempt, { taskId: started.value.attempt.taskId, dispatchId: started.value.attempt.dispatchId, attemptId: started.value.attempt.attemptId, bindingId: started.value.attempt.bindingId, bindingEpochId: started.value.attempt.bindingEpochIds[0], agentInstanceId: started.value.attempt.agentInstanceId }, { immutable: true });
				return Result.ok({ ...started.value });
			} catch (error) {
				return this.persistenceError(error, "session_writer_stale_revision");
			}
		} catch (error) {
			return this.persistenceError(error, "session_writer_stale_revision");
		}
	}

	async executeDispatch(input: DispatchExecutionInput & { readonly agentInstance?: AgentInstance }): Promise<ResultValue<DispatchExecutionResult, FoundationError>> {
		const started = await this.startDispatch(input);
		if (!started.ok) return started;
		if (started.value.receipt !== undefined) return Result.ok({ attempt: started.value.attempt, receipt: started.value.receipt, providerId: started.value.providerId, providerClass: started.value.providerClass });
		const executed = await executeDispatch({ ...input, existingAttempt: started.value.attempt });
		if (!executed.ok) return executed;
		return this.acceptProviderExecution(executed.value, input.provider.providerId, input.provider.providerClass);
	}

	/** Resume a durable Attempt through an optional provider resume surface. */
	async resumeDispatch(input: DispatchExecutionInput & { readonly agentInstance?: AgentInstance }): Promise<ResultValue<DispatchStartResult, FoundationError>> {
		const started = await this.startDispatch(input);
		if (!started.ok || started.value.receipt !== undefined && started.value.receipt.status !== "suspended") return started;
		try {
			let resumed: ResultValue<AttemptReceipt, FoundationError>;
			const options = { correlation: input.correlation, ...(input.signal === undefined ? {} : { signal: input.signal }) };
			if (input.provider.providerClass === "external_connector") resumed = await (input.provider as ExternalAgentConnector).resumeAttempt(started.value.attempt, options);
			else {
				const provider = input.provider as TaskExecutorProviderResumeSurface;
				if (provider.resumeAttempt !== undefined) resumed = await provider.resumeAttempt(started.value.attempt.attemptId, options);
				else if (provider.resume !== undefined) resumed = await provider.resume(started.value.attempt.attemptId, { signal: input.signal });
				else return started;
			}
			if (!resumed.ok) return resumed;
			const accepted = await this.acceptProviderExecution({ ...started.value, receipt: resumed.value }, input.provider.providerId, input.provider.providerClass);
			if (!accepted.ok) return accepted;
			return Result.ok({ ...accepted.value, receipt: accepted.value.receipt });
		} catch (error) {
			return this.persistenceError(error, "worker_receipt_invalid_producer");
		}
	}

	/** Cancel the durable Attempt through the provider. No terminal receipt is fabricated here. */
	async cancelAttempt(input: DispatchExecutionInput & { readonly agentInstance?: AgentInstance }): Promise<ResultValue<void, FoundationError>> {
		const started = await this.startDispatch(input);
		if (!started.ok) return started;
		if (started.value.receipt !== undefined) return Result.ok(undefined);
		try {
			const cancelled = await input.provider.cancelAttempt(started.value.attempt.attemptId);
			return cancelled;
		} catch (error) {
			return this.persistenceError(error, "task_executor_invalid_provider_class");
		}
	}

	/** Provider execution is consumed and persisted privately; no public structured accept path exists. */
	private async acceptProviderExecution(execution: DispatchExecutionResult, providerId: string, providerClass: DispatchExecutionResult["providerClass"]): Promise<ResultValue<DispatchExecutionResult, FoundationError>> {
		const checked = validateAttemptReceiptForProvider(execution.receipt, { providerId, providerClass });
		if (!checked.ok) return checked;
		if (checked.value.attemptId !== execution.attempt.attemptId || checked.value.dispatchId !== execution.attempt.dispatchId || checked.value.taskId !== execution.attempt.taskId || checked.value.bindingId !== execution.attempt.bindingId || checked.value.agentInstanceId !== execution.attempt.agentInstanceId) return Result.err(new FoundationError("invalid_correlation", "Provider AttemptReceipt does not match its consumed Attempt", { details: { attemptReceiptId: checked.value.attemptReceiptId } }));
		for (const reference of checked.value.workerReceiptRefs) {
			const stored = await this.ledger.get("worker_receipt", reference.id);
			if (stored === undefined || stored.kind !== "fact") return Result.err(new FoundationError("invalid_correlation", "AttemptReceipt references a WorkerReceipt that is not present in Session", { details: { attemptReceiptId: checked.value.attemptReceiptId, workerReceiptId: reference.id } }));
			const worker = validateWorkerReceipt(stored.payload);
			if (!worker.ok || (reference.revision > 0 && stored.revision !== reference.revision) || (reference.providerId !== undefined && worker.ok && worker.value.provenance.providerId !== reference.providerId) || (reference.fingerprint !== undefined && worker.ok && fingerprintFoundationValue(worker.value).value !== reference.fingerprint.value)) return Result.err(new FoundationError("invalid_correlation", "AttemptReceipt WorkerReceipt reference does not match the durable WorkerReceipt", { details: { attemptReceiptId: checked.value.attemptReceiptId, workerReceiptId: reference.id } }));
		}
		const correlation = checked.value.provenance.correlation;
		if (correlation === undefined) return Result.err(new FoundationError("invalid_correlation", "Provider AttemptReceipt provenance is missing its required correlation"));
		if (providerClass === "agent" && checked.value.status === "suspended") {
			return Result.ok({ ...execution, receipt: cloneDeepFrozen(checked.value) });
		}
		try {
			await this.persistFact("attempt_receipt", checked.value.attemptReceiptId, checked.value, correlationRecord(correlation), { immutable: true });
			return Result.ok({ ...execution, receipt: cloneDeepFrozen(checked.value) });
		} catch (error) {
			return this.persistenceError(error, "worker_receipt_invalid_producer");
		}
	}

	async executeAgentSpawn(input: ChildSpawnExecutionInput): Promise<ResultValue<ChildSpawnResult, FoundationError>> {
		const checkedRequest = validateChildSpawnRequest(input.request);
		if (!checkedRequest.ok) return checkedRequest;
		if (input.provider.providerClass !== "agent") return Result.err(new FoundationError("agent_instance_not_agent_provider", "Agent spawn requires an Agent provider", { details: { providerId: input.provider.providerId } }));
		try {
			const request = checkedRequest.value;
			if (!spawnCorrelationValid(input.correlation, request)) return Result.err(new FoundationError("invalid_correlation", "Agent spawn requires a complete child Task and AgentInstance correlation", { details: { spawnId: request.spawnId } }));
			if (request.parentSpawn === undefined) return Result.err(new FoundationError("role_resolver_task_required", "Agent spawn requires a durable parent Task and Context", { details: { spawnId: request.spawnId } }));
			const prevalidatedIntent = validateSpawnAgentIntent(request.parentSpawn);
			if (!prevalidatedIntent.ok) return prevalidatedIntent;
			const checkedParentIntent = validateSpawnIntentIdentity(request.parentSpawn, request, input.provider.providerId);
			if (!checkedParentIntent.ok) return checkedParentIntent;
			const parentTask = await this.requireExistingTask(checkedParentIntent.value.parentTaskId);
			const parentContext = await this.requireParentSpawnContext(checkedParentIntent.value, parentTask, request);
			await this.validateChildTaskReference(request, checkedParentIntent.value);
			const durableSources = await this.requireDurableSpawnSources(request.roleRevision, request.modelProfile);
			const durableTask = await this.persistFact("task", request.taskEnvelope.taskId, request.taskEnvelope, { taskId: request.taskEnvelope.taskId }, { immutable: true });
			const persistedIntent = validateSpawnAgentIntent(checkedParentIntent.value, { taskExists: (taskId) => taskId === (durableTask.payload as TaskEnvelope).taskId });
			if (!persistedIntent.ok) return persistedIntent;
			const canonicalRequest = cloneDeepFrozen({ ...request, taskEnvelope: durableTask.payload as TaskEnvelope, roleRevision: durableSources.roleRevision, modelProfile: durableSources.modelProfile });
			const existingFact = await this.ledger.get(AGENT_SPAWN_OBJECT_TYPE, canonicalRequest.spawnId);
			if (existingFact?.kind === "fact") {
				const fact = parseSpawnFact(existingFact.payload, canonicalRequest.spawnId, input.provider.providerId);
				if (!fact.ok) return fact;
				if (canonicalFoundationJson(fact.value.request) !== canonicalFoundationJson(canonicalRequest)) return Result.err(new FoundationError("session_ledger_conflict", "A stable spawnId is already bound to a different canonical request", { details: { spawnId: canonicalRequest.spawnId } }));
				const childContext = this.createChildSpawnContext(canonicalRequest, parentContext);
				if (fact.value.contextId !== childContext.contextId) return Result.err(new FoundationError("session_ledger_conflict", "A durable spawn fact reuses a different child Context identity", { details: { spawnId: canonicalRequest.spawnId } }));
				await this.persistFact("context", childContext.contextId, childContext, { taskId: childContext.taskId }, { immutable: true });
				await this.persistSpawnChain(fact.value.request, fact.value.result, fact.value.contextId);
				return Result.ok(cloneDeepFrozen(fact.value.result));
			}
			const intents = await this.ledger.find({ kind: "intent", objectType: AGENT_SPAWN_OBJECT_TYPE, objectId: canonicalRequest.spawnId, includePruned: true, order: "oldestFirst" });
			const existingIntent = intents[0];
			const parsedExistingIntent = existingIntent?.kind === "intent" ? parseSpawnIntent(existingIntent, canonicalRequest.spawnId, input.provider.providerId, canonicalRequest, input.correlation) : undefined;
			if (parsedExistingIntent !== undefined && !parsedExistingIntent.ok) return parsedExistingIntent;
			if (existingIntent !== undefined && existingIntent.kind !== "intent") return Result.err(new FoundationError("session_ledger_conflict", "A durable non-create spawn intent already occupies this spawnId", { details: { spawnId: canonicalRequest.spawnId } }));
			const childContext = this.createChildSpawnContext(canonicalRequest, parentContext);
			await this.persistFact("context", childContext.contextId, childContext, { taskId: childContext.taskId }, { immutable: true });
			let spawned: ResultValue<ChildSpawnResult, FoundationError>;
			if (parsedExistingIntent?.ok) {
				const provider = input.provider as ChildAgentProvider;
				if (provider.lookupSpawn === undefined) return Result.err(new FoundationError("agent_spawn_recovery_required", "A durable spawn intent exists without a provider idempotency lookup; refusing to spawn again", { details: { spawnId: canonicalRequest.spawnId } }));
				const recovered = await provider.lookupSpawn(canonicalRequest.spawnId, input.signal === undefined ? undefined : { signal: input.signal });
				if (!recovered.ok) return recovered;
				if (recovered.value === undefined) return Result.err(new FoundationError("agent_spawn_recovery_required", "Provider cannot recover the durable spawn intent without spawning again", { details: { spawnId: canonicalRequest.spawnId } }));
				spawned = Result.ok(recovered.value);
			} else {
				const intentPayload: AgentSpawnIntentPayload = { schemaVersion: 1, spawnId: canonicalRequest.spawnId, providerId: input.provider.providerId, request: canonicalRequest, correlation: input.correlation };
				const appendedIntent = await this.ledger.appendIntent(AGENT_SPAWN_OBJECT_TYPE, canonicalRequest.spawnId, { clientRequestId: `agent-spawn:${canonicalRequest.spawnId}`, expectedRevision: 0, intent: "create", payload: intentPayload as unknown as FoundationJsonValue, correlation: input.correlation });
				if (appendedIntent.replayed) {
					const parsedIntent = parseSpawnIntent(appendedIntent.record, canonicalRequest.spawnId, input.provider.providerId, canonicalRequest, input.correlation);
					if (!parsedIntent.ok) return parsedIntent;
					const provider = input.provider as ChildAgentProvider;
					if (provider.lookupSpawn === undefined) return Result.err(new FoundationError("agent_spawn_recovery_required", "A durable spawn intent exists without a provider idempotency lookup; refusing to spawn again", { details: { spawnId: canonicalRequest.spawnId } }));
					const recovered = await provider.lookupSpawn(canonicalRequest.spawnId, input.signal === undefined ? undefined : { signal: input.signal });
					if (!recovered.ok) return recovered;
					if (recovered.value === undefined) return Result.err(new FoundationError("agent_spawn_recovery_required", "Provider cannot recover the durable spawn intent without spawning again", { details: { spawnId: canonicalRequest.spawnId } }));
					spawned = Result.ok(recovered.value);
				} else {
					spawned = await executeAgentSpawn({ ...input, request: canonicalRequest });
				}
			}
			if (!spawned.ok) return spawned;
			const canonicalResult = canonicalizeSpawnResult(spawned.value, canonicalRequest, input.provider.providerId, durableSources.roleRevision);
			if (!canonicalResult.ok) return canonicalResult;
			const spawnFact: AgentSpawnFactPayload = { schemaVersion: 1, spawnId: canonicalRequest.spawnId, providerId: input.provider.providerId, request: canonicalRequest, result: canonicalResult.value, contextId: childContext.contextId };
			await this.persistFact(AGENT_SPAWN_OBJECT_TYPE, canonicalRequest.spawnId, spawnFact, { taskId: canonicalRequest.taskEnvelope.taskId }, { expectedRevision: 1 });
			await this.persistSpawnChain(canonicalRequest, canonicalResult.value, childContext.contextId);
			return Result.ok(cloneDeepFrozen(canonicalResult.value));
		} catch (error) {
			return this.persistenceError(error, "session_writer_stale_revision");
		}
	}

	private async validateChildTaskReference(request: ChildSpawnRequest, intent: SpawnAgentIntent): Promise<void> {
		const stored = await this.ledger.get("task", request.taskEnvelope.taskId);
		if (intent.newTaskEnvelopeRef.revision !== (stored?.revision ?? 1)) throw new FoundationError("invalid_correlation", "Agent spawn TaskEnvelope reference revision does not match the durable child Task", { details: { spawnId: request.spawnId, taskId: request.taskEnvelope.taskId } });
		if (stored === undefined) {
			if (intent.newTaskEnvelopeRef.fingerprint !== undefined && request.taskEnvelope.fingerprint?.value !== intent.newTaskEnvelopeRef.fingerprint.value) throw new FoundationError("invalid_correlation", "Agent spawn TaskEnvelope reference fingerprint does not match the child Task", { details: { spawnId: request.spawnId, taskId: request.taskEnvelope.taskId } });
			return;
		}
		if (stored.kind !== "fact") throw new FoundationError("role_resolver_task_required", "Agent spawn child TaskEnvelope identity is terminal", { details: { spawnId: request.spawnId, taskId: request.taskEnvelope.taskId } });
		const task = validateTaskEnvelope(stored.payload);
		if (!task.ok || task.value.taskId !== request.taskEnvelope.taskId) throw new FoundationError("role_resolver_task_required", "Agent spawn child TaskEnvelope is not a valid durable task", { details: { spawnId: request.spawnId, taskId: request.taskEnvelope.taskId } });
		if (intent.newTaskEnvelopeRef.fingerprint !== undefined && task.value.fingerprint?.value !== intent.newTaskEnvelopeRef.fingerprint.value) throw new FoundationError("invalid_correlation", "Agent spawn TaskEnvelope reference fingerprint does not match the durable child Task", { details: { spawnId: request.spawnId, taskId: request.taskEnvelope.taskId } });
	}

	private async requireParentSpawnContext(intent: SpawnAgentIntent, parentTask: TaskEnvelope, request: ChildSpawnRequest): Promise<SpawnContextRecordV1> {
		const expectedContextId = spawnContextId(intent.spawnId);
		const stored = await this.ledger.get("context", expectedContextId);
		if (stored === undefined || stored.kind !== "fact") throw new FoundationError("role_resolver_task_required", "Agent spawn requires a durable parent Context", { details: { spawnId: request.spawnId, parentTaskId: intent.parentTaskId, parentContextId: expectedContextId } });
		const checked = parseSpawnContext(stored.payload, expectedContextId);
		if (!checked.ok) throw checked.error;
		const parentLineage = checked.value.lineage;
		const lineageParentMatchesContext = checked.value.parentContextId === parentLineage.parentId;
		const lineageDepthMatchesParent = parentLineage.depth === 0 ? checked.value.parentContextId === undefined && parentLineage.parentId === undefined && (parentLineage.ancestorIds === undefined || parentLineage.ancestorIds.length === 0) : checked.value.parentContextId !== undefined && parentLineage.parentId !== undefined && (parentLineage.ancestorIds ?? []).includes(parentLineage.parentId);
		if (checked.value.contextId === spawnContextId(request.spawnId) || checked.value.spawnId !== intent.spawnId || checked.value.taskId !== parentTask.taskId || (checked.value.parentTaskId !== undefined && checked.value.parentTaskId === request.taskEnvelope.taskId) || !lineageParentMatchesContext || !lineageDepthMatchesParent || checked.value.parentContextId === spawnContextId(request.spawnId) || parentLineage.ancestorIds?.includes(checked.value.contextId)) throw new FoundationError("invalid_correlation", "Agent spawn parent Context does not match the parent Task or child identity", { details: { spawnId: request.spawnId, parentContextId: checked.value.contextId } });
		if (request.parentAttemptId !== undefined) {
			const attemptRecord = await this.ledger.get("attempt", request.parentAttemptId);
			if (attemptRecord === undefined || attemptRecord.kind !== "fact") throw new FoundationError("invalid_correlation", "Agent spawn parent Attempt is not durable", { details: { spawnId: request.spawnId, parentAttemptId: request.parentAttemptId } });
			const attempt = validateAttempt(attemptRecord.payload);
			if (!attempt.ok || attempt.value.taskId !== parentTask.taskId) throw new FoundationError("invalid_correlation", "Agent spawn parent Attempt does not match the parent Task", { details: { spawnId: request.spawnId, parentAttemptId: request.parentAttemptId } });
		}
		if (request.parentAgentInstanceId !== undefined) {
			const agentRecord = await this.ledger.get("agent_instance", request.parentAgentInstanceId);
			if (agentRecord === undefined || agentRecord.kind !== "fact") throw new FoundationError("invalid_correlation", "Agent spawn parent AgentInstance is not durable", { details: { spawnId: request.spawnId, parentAgentInstanceId: request.parentAgentInstanceId } });
			const agent = validateAgentInstance(agentRecord.payload);
			if (!agent.ok || agent.value.taskId !== parentTask.taskId) throw new FoundationError("invalid_correlation", "Agent spawn parent AgentInstance does not match the parent Task", { details: { spawnId: request.spawnId, parentAgentInstanceId: request.parentAgentInstanceId } });
		}
		return checked.value;
	}

	private createChildSpawnContext(request: ChildSpawnRequest, parentContext: SpawnContextRecordV1): SpawnContextRecordV1 {
		if (request.parentSpawn === undefined) throw new FoundationError("role_resolver_task_required", "Agent spawn requires a parent intent before creating child Context", { details: { spawnId: request.spawnId } });
		const contextId = spawnContextId(request.spawnId);
		if (contextId === parentContext.contextId || parentContext.lineage.ancestorIds?.includes(contextId)) throw new FoundationError("invalid_correlation", "Agent spawn child Context would reuse or cycle through the parent Context", { details: { spawnId: request.spawnId, parentContextId: parentContext.contextId } });
		return cloneDeepFrozen({ schemaVersion: 1, contextId, taskId: request.taskEnvelope.taskId, spawnId: request.spawnId, forkScope: request.forkScope, parentTaskId: request.parentSpawn.parentTaskId, parentContextId: parentContext.contextId, ...(request.parentAttemptId === undefined ? {} : { parentAttemptId: request.parentAttemptId }), ...(request.parentAgentInstanceId === undefined ? {} : { parentAgentInstanceId: request.parentAgentInstanceId }), lineage: extendFoundationLineage(parentContext.lineage, { entityType: "context", entityId: contextId }), createdAt: request.taskEnvelope.createdAt });
	}

	private async persistSpawnChain(request: ChildSpawnRequest, spawned: ChildSpawnResult, contextId: string): Promise<void> {
		await this.requireExistingBindingFactsFromId(spawned.attempt.bindingId, spawned.attempt.taskId);
		const contextRecord = await this.ledger.get("context", contextId);
		if (contextRecord === undefined || contextRecord.kind !== "fact") throw new FoundationError("role_resolver_task_required", "Agent spawn Dispatch requires its durable child Context", { details: { spawnId: request.spawnId, contextId } });
		const context = parseSpawnContext(contextRecord.payload, contextId);
		if (!context.ok) throw context.error;
		if (context.value.taskId !== request.taskEnvelope.taskId || context.value.spawnId !== request.spawnId) throw new FoundationError("invalid_correlation", "Agent spawn child Context does not match the child Task or spawn identity", { details: { spawnId: request.spawnId, contextId } });
		const childDispatch: Dispatch = { schemaVersion: 1, dispatchId: spawned.attempt.dispatchId, taskId: spawned.attempt.taskId, bindingId: spawned.attempt.bindingId, taskExecutorProviderId: spawned.attempt.providerId, status: "pending", createdAt: spawned.attempt.startedAt };
		const checkedDispatch = validateDispatch(childDispatch);
		if (!checkedDispatch.ok) throw checkedDispatch.error;
		await this.persistFact("dispatch", checkedDispatch.value.dispatchId, checkedDispatch.value, { taskId: checkedDispatch.value.taskId, dispatchId: checkedDispatch.value.dispatchId, bindingId: checkedDispatch.value.bindingId, agentInstanceId: spawned.agentInstance.agentInstanceId }, { immutable: true });
		await this.persistFact("agent_instance", spawned.agentInstance.agentInstanceId, spawned.agentInstance, { taskId: spawned.agentInstance.taskId, agentInstanceId: spawned.agentInstance.agentInstanceId }, { immutable: true });
		await this.persistFact("binding_epoch", spawned.initialBindingEpoch.bindingEpochId, spawned.initialBindingEpoch, { taskId: spawned.initialBindingEpoch.taskId, attemptId: spawned.initialBindingEpoch.attemptId, bindingId: spawned.initialBindingEpoch.bindingId, bindingEpochId: spawned.initialBindingEpoch.bindingEpochId, agentInstanceId: spawned.initialBindingEpoch.agentInstanceId }, { immutable: true });
		await this.persistFact("attempt", spawned.attempt.attemptId, spawned.attempt, { taskId: spawned.attempt.taskId, dispatchId: spawned.attempt.dispatchId, attemptId: spawned.attempt.attemptId, bindingId: spawned.attempt.bindingId, bindingEpochId: spawned.attempt.bindingEpochIds[0], agentInstanceId: spawned.attempt.agentInstanceId }, { immutable: true });
	}

	async switchAgentMode(input: ModeSwitchExecutionInput): Promise<ResultValue<BindingEpoch, FoundationError>> {
		const switched = switchAgentMode(input);
		if (!switched.ok) return switched;
		if (input.nextBinding === undefined) return Result.err(new FoundationError("binding_required_fact", "Mode switch requires the next immutable Binding"));
		try {
			await this.requireExistingEpoch(input.currentEpoch);
			await this.requireExistingBindingFactsFromId(input.currentEpoch.bindingId, input.currentEpoch.taskId);
			await this.requireExistingAgentInstance(input.currentEpoch);
			const attemptRecord = await this.ledger.get("attempt", input.currentEpoch.attemptId);
			if (attemptRecord === undefined || attemptRecord.kind !== "fact") throw new FoundationError("binding_required_fact", "Mode switch requires the current Attempt to be durable", { details: { attemptId: input.currentEpoch.attemptId } });
			const checkedAttempt = validateAttempt(attemptRecord.payload);
			if (!checkedAttempt.ok || checkedAttempt.value.taskId !== input.currentEpoch.taskId || checkedAttempt.value.bindingId !== input.currentEpoch.bindingId || !checkedAttempt.value.bindingEpochIds.includes(input.currentEpoch.bindingEpochId)) throw new FoundationError("binding_epoch_mismatch", "Mode switch current BindingEpoch is not part of the durable Attempt chain", { details: { attemptId: input.currentEpoch.attemptId, bindingEpochId: input.currentEpoch.bindingEpochId } });
			await this.requireExistingBindingFacts(input.nextBinding);
			await this.persistFact("agent_binding", input.nextBinding.bindingId, input.nextBinding, { taskId: input.nextBinding.taskId, bindingId: input.nextBinding.bindingId }, { immutable: true });
			await this.persistFact("binding_epoch", switched.value.bindingEpochId, switched.value, { taskId: switched.value.taskId, attemptId: switched.value.attemptId, bindingId: switched.value.bindingId, bindingEpochId: switched.value.bindingEpochId, agentInstanceId: switched.value.agentInstanceId }, { immutable: true });
			const nextAttempt: Attempt = checkedAttempt.value.bindingEpochIds.includes(switched.value.bindingEpochId)
				? checkedAttempt.value
				: { ...checkedAttempt.value, bindingEpochIds: [...checkedAttempt.value.bindingEpochIds, switched.value.bindingEpochId] };
			await this.persistFact("attempt", nextAttempt.attemptId, nextAttempt, { taskId: nextAttempt.taskId, dispatchId: nextAttempt.dispatchId, attemptId: nextAttempt.attemptId, bindingId: nextAttempt.bindingId, bindingEpochId: switched.value.bindingEpochId, agentInstanceId: nextAttempt.agentInstanceId }, { expectedRevision: attemptRecord.revision });
			await this.persistFact("binding.activated", switched.value.bindingEpochId, switched.value, { taskId: switched.value.taskId, attemptId: switched.value.attemptId, bindingId: switched.value.bindingId, bindingEpochId: switched.value.bindingEpochId, agentInstanceId: switched.value.agentInstanceId }, { immutable: true });
			return switched;
		} catch (error) {
			return this.persistenceError(error, "session_writer_stale_revision");
		}
	}

	async settle(input: LayeredTaskSettlementInput): Promise<ResultValue<TaskResult, FoundationError>> {
		const allSourceAttemptReceiptIds = [...input.sourceAttemptReceiptIds, ...(input.provenanceAttemptReceiptIds ?? [])];
		if (input.sourceAttemptReceiptIds.length === 0 || new Set(allSourceAttemptReceiptIds).size !== allSourceAttemptReceiptIds.length) return Result.err(new FoundationError("task_result_no_source_receipts", "Task settlement requires unique provider AttemptReceipt sources", { details: { taskResultId: input.taskResultId } }));
		try {
			const durableTask = await this.requireExistingTask(input.task.taskId);
			if (canonicalFoundationJson(durableTask) !== canonicalFoundationJson(input.task)) return Result.err(new FoundationError("role_resolver_task_required", "Task settlement must consume the durable TaskEnvelope", { details: { taskId: input.task.taskId } }));
			const receipts: AttemptReceipt[] = [];
			for (const id of allSourceAttemptReceiptIds) {
				const stored = await this.ledger.get("attempt_receipt", id);
				if (stored === undefined || stored.kind !== "fact") return Result.err(new FoundationError("task_result_no_source_receipts", "Task settlement source was not produced by a provider consumer", { details: { taskResultId: input.taskResultId, attemptReceiptId: id } }));
				const checked = validateAttemptReceipt(stored.payload);
				if (!checked.ok) return checked;
				await this.requireWorkerReceiptRefs(checked.value);
				receipts.push(checked.value);
			}
			// Composition receipts remain durable TaskResult provenance, but only the
			// explicitly identified parent receipts determine the parent outcome.
			const outcomeReceipts = receipts.slice(0, input.sourceAttemptReceiptIds.length);
			const settled = settleTaskResult({ taskResultId: input.taskResultId, task: input.task, receipts: outcomeReceipts, summary: input.summary, ...(input.artifacts === undefined ? {} : { artifacts: input.artifacts }), ...(input.diff === undefined ? {} : { diff: input.diff }), tests: input.tests, evidence: input.evidence, producer: input.producer, ...(input.validation === undefined ? {} : { validation: input.validation }) });
			if (!settled.ok) return settled;
			const withProvenance = validateTaskResult({ ...settled.value, sourceAttemptReceiptIds: allSourceAttemptReceiptIds });
			if (!withProvenance.ok) return withProvenance;
			const correlation = input.producer.correlation;
			if (correlation === undefined) return Result.err(new FoundationError("invalid_correlation", "Host TaskResult provenance is missing its required correlation"));
			const stored = await this.persistFact("task_result", withProvenance.value.taskResultId, withProvenance.value, correlationRecord(correlation), { immutable: true });
			return Result.ok(cloneDeepFrozen(stored.payload));
		} catch (error) {
			return this.persistenceError(error, "task_result_validation_failed");
		}
	}

	async finalize(input: LayeredRunFinalizationInput): Promise<ResultValue<RunReceipt, FoundationError>> {
		const result = this.finalizationTail.then(() => this.finalizeInternal(input));
		this.finalizationTail = result.then(() => undefined, () => undefined);
		return result;
	}

	private async finalizeInternal(input: LayeredRunFinalizationInput): Promise<ResultValue<RunReceipt, FoundationError>> {
		try {
			let sourceTaskId: string | undefined;
			const sourceAttempts: AttemptReceipt[] = [];
			for (const id of input.attemptReceiptIds) {
				const stored = await this.ledger.get("attempt_receipt", id);
				if (stored === undefined || stored.kind !== "fact") return Result.err(new FoundationError("task_result_no_source_receipts", "Run finalization references an AttemptReceipt not accepted by a provider consumer", { details: { runId: input.runId, attemptReceiptId: id } }));
				const checkedAttempt = validateAttemptReceipt(stored.payload);
				if (!checkedAttempt.ok) return Result.err(checkedAttempt.error);
				if (checkedAttempt.value.attemptReceiptId !== id) return Result.err(new FoundationError("invalid_correlation", "Run finalization source identity does not match its durable key", { details: { runId: input.runId, attemptReceiptId: id } }));
				sourceTaskId ??= checkedAttempt.value.taskId;
				sourceAttempts.push(checkedAttempt.value);
			}
			const taskResultRecord = input.taskResultId === undefined ? undefined : await this.ledger.get("task_result", input.taskResultId);
			if (input.taskResultId !== undefined && (taskResultRecord === undefined || taskResultRecord.kind !== "fact")) return Result.err(new FoundationError("task_result_terminal_requires_task_result", "Run finalization references a TaskResult that has not crossed the Host settlement gate", { details: { runId: input.runId, taskResultId: input.taskResultId } }));
			let taskResult: TaskResult | undefined;
			if (taskResultRecord?.kind === "fact") {
				const checkedTaskResult = validateTaskResult(taskResultRecord.payload);
				if (!checkedTaskResult.ok) return checkedTaskResult;
				if (checkedTaskResult.value.taskResultId !== input.taskResultId || sourceTaskId !== undefined && checkedTaskResult.value.taskId !== sourceTaskId) return Result.err(new FoundationError("invalid_correlation", "Run finalization TaskResult does not match its durable key or source Task", { details: { runId: input.runId, taskResultId: checkedTaskResult.value.taskResultId } }));
				taskResult = checkedTaskResult.value;
			}
			const crossTaskAttempts = sourceAttempts.filter((receipt) => receipt.taskId !== sourceTaskId);
			if (
				crossTaskAttempts.length > 0 &&
				(taskResult === undefined || crossTaskAttempts.some((receipt) => !taskResult.sourceAttemptReceiptIds.includes(receipt.attemptReceiptId)))
			) return Result.err(new FoundationError("invalid_correlation", "Cross-task RunReceipt sources must be Host-settled TaskResult provenance", { details: { runId: input.runId } }));
			const unresolvedSideEffect = sourceAttempts.find((receipt) => receipt.sideEffectState !== "none");
			if (unresolvedSideEffect !== undefined && input.terminalStatus !== "failed") return Result.err(new FoundationError("side_effect_unknown", "A Run with unresolved side effects must fail closed", { details: { runId: input.runId, attemptReceiptId: unresolvedSideEffect.attemptReceiptId, sideEffectState: unresolvedSideEffect.sideEffectState } }));
			if (input.terminalStatus === "completed" && (input.terminalErrorCode !== undefined || input.terminalError !== undefined)) return Result.err(new FoundationError("run_terminal_authority_invalid", "A completed run cannot carry a terminal error", { details: { runId: input.runId } }));
			const existingByRun = await this.findRunTerminalRecord(input.runId);
			const existingByReceipt = await this.findRunReceiptRecordById(input.runReceiptId);
			const existingReceipt = existingByRun?.receipt ?? existingByReceipt?.receipt;
			const sourceError = taskResult?.error ?? sourceAttempts.find((receipt) => receipt.error !== undefined)?.error;
			if (input.terminalStatus !== "completed" && unresolvedSideEffect === undefined && input.terminalErrorCode === undefined && input.terminalError === undefined && existingReceipt?.terminalError === undefined && sourceError === undefined) return Result.err(new FoundationError("run_terminal_authority_invalid", "A non-completed run requires canonical terminal error detail", { details: { runId: input.runId } }));
			const terminalErrorCode = input.terminalStatus === "completed"
				? undefined
				: unresolvedSideEffect === undefined
					? input.terminalErrorCode ?? input.terminalError?.code ?? existingReceipt?.terminalErrorCode ?? existingReceipt?.terminalError?.code ?? sourceError?.code ?? (input.terminalStatus === "cancelled" ? "run_cancelled" : "agent_run_failed")
					: unresolvedSideEffect.error?.code ?? "side_effect_unknown";
			const terminalError: PublicExecutionError | undefined = input.terminalStatus === "completed"
				? undefined
				: unresolvedSideEffect !== undefined
					? unresolvedSideEffect.error === undefined
						? { code: "side_effect_unknown", message: "Run failed because an attempt has unresolved side effects", category: "side_effect_unknown", retryable: false }
						: { ...unresolvedSideEffect.error, category: "side_effect_unknown" }
					: input.terminalError
						?? (existingReceipt?.terminalError?.code === terminalErrorCode ? existingReceipt?.terminalError : undefined)
						?? (sourceError?.code === terminalErrorCode ? sourceError : undefined)
						?? { code: terminalErrorCode as string, message: input.terminalStatus === "cancelled" ? "Run was cancelled" : "Run failed", category: input.terminalStatus === "cancelled" ? "cancelled" : "unknown", retryable: false };
			const replayTimestamp = existingByRun?.receipt.completedAt ?? existingByReceipt?.receipt.completedAt;
			const completedAt = input.completedAt ?? replayTimestamp;
			const finalized = finalizeRunReceipt({ runReceiptId: input.runReceiptId, runId: input.runId, terminalStatus: input.terminalStatus, authority: input.authority, attemptReceiptIds: input.attemptReceiptIds, ...(taskResult === undefined ? {} : { taskResult }), usage: input.usage, ...(terminalErrorCode === undefined ? {} : { terminalErrorCode }), ...(terminalError === undefined ? {} : { terminalError }), ...(completedAt === undefined ? {} : { completedAt }) });
			if (!finalized.ok) return finalized;
			const checked = validateRunReceipt(finalized.value);
			if (!checked.ok) return checked;
			if (existingByRun !== undefined && canonicalFoundationJson(existingByRun.receipt) !== canonicalFoundationJson(checked.value)) return Result.err(new FoundationError("run_terminal_authority_invalid", "Conflicting terminal replay for a runId is rejected", { details: { runId: input.runId } }));
			if (existingByReceipt !== undefined && canonicalFoundationJson(existingByReceipt.receipt) !== canonicalFoundationJson(checked.value)) return Result.err(new FoundationError("run_terminal_authority_invalid", "A runReceiptId is already bound to a different terminal run identity", { details: { runReceiptId: input.runReceiptId } }));
			if (existingByRun !== undefined) return Result.ok(cloneDeepFrozen(existingByRun.receipt));
			if (existingByReceipt !== undefined) return Result.ok(cloneDeepFrozen(existingByReceipt.receipt));
			const firstAttempt = sourceAttempts[0];
			const stored = await this.persistFact("run_receipt", checked.value.runId, checked.value, { taskId: taskResult?.taskId ?? sourceTaskId, runId: checked.value.runId, runReceiptId: checked.value.runReceiptId, taskResultId: checked.value.taskResultId, attemptId: firstAttempt?.attemptId, attemptReceiptId: firstAttempt?.attemptReceiptId }, { immutable: true });
			return Result.ok(cloneDeepFrozen(stored.payload));
		} catch (error) {
			return this.persistenceError(error, "run_terminal_authority_invalid");
		}
	}

	async getAttemptReceipt(attemptReceiptId: string): Promise<AttemptReceipt | undefined> {
		const stored = await this.ledger.get("attempt_receipt", attemptReceiptId);
		if (stored === undefined) return undefined;
		if (stored.kind !== "fact") throw new FoundationError("session_ledger_tombstoned", "AttemptReceipt lookup found a terminal non-fact", { details: { attemptReceiptId } });
		const checked = validateAttemptReceipt(stored.payload);
		if (!checked.ok) throw checked.error;
		if (checked.value.attemptReceiptId !== attemptReceiptId) throw new FoundationError("invalid_correlation", "AttemptReceipt lookup found a mismatched durable identity", { details: { attemptReceiptId } });
		return cloneDeepFrozen(checked.value);
	}

	async getTaskResult(taskResultId: string): Promise<TaskResult | undefined> {
		const stored = await this.ledger.get("task_result", taskResultId);
		if (stored === undefined) return undefined;
		if (stored.kind !== "fact") throw new FoundationError("session_ledger_tombstoned", "TaskResult lookup found a terminal non-fact", { details: { taskResultId } });
		const checked = validateTaskResult(stored.payload);
		if (!checked.ok) throw checked.error;
		if (checked.value.taskResultId !== taskResultId) throw new FoundationError("invalid_correlation", "TaskResult lookup found a mismatched durable identity", { details: { taskResultId } });
		return cloneDeepFrozen(checked.value);
	}

	async getRunReceipt(runReceiptId: string): Promise<RunReceipt | undefined> { return cloneDeepFrozen((await this.findRunReceiptRecordById(runReceiptId))?.receipt); }

	async getRunReceiptByRunId(runId: string): Promise<RunReceipt | undefined> { return cloneDeepFrozen((await this.findRunTerminalRecord(runId))?.receipt); }

	/**
	 * Project the canonical receipt fact as the terminal durable event. The
	 * event reuses the fact id, sequence, timestamp, and correlation, so replay
	 * and restart cannot create a second terminal event or a post-receipt gap.
	 */
	async getRunReceiptWrittenEvent(runId: string): Promise<RunReceiptWrittenEvent | undefined> {
		const durable = await this.findRunTerminalRecord(runId);
		if (durable === undefined) return undefined;
		const firstAttemptReceiptId = durable.receipt.attemptReceiptIds[0];
		const firstAttemptReceipt = firstAttemptReceiptId === undefined ? undefined : await this.getAttemptReceipt(firstAttemptReceiptId);
		if (firstAttemptReceipt === undefined) throw new FoundationError("invalid_correlation", "Canonical RunReceipt event references a missing AttemptReceipt", { details: { runId, attemptReceiptId: firstAttemptReceiptId ?? "missing" } });
		return this.projectRunReceiptWritten(durable, firstAttemptReceipt);
	}

	/** Resolve every canonical result layer from the single Host terminal fact. */
	async lookupCanonicalRun(runId: string): Promise<ResultValue<CanonicalRunResult | undefined, FoundationError>> {
		try {
			const durable = await this.findRunTerminalRecord(runId);
			if (durable === undefined) return Result.ok(undefined);
			const attemptReceipts: AttemptReceipt[] = [];
			for (const attemptReceiptId of durable.receipt.attemptReceiptIds) {
				const attemptReceipt = await this.getAttemptReceipt(attemptReceiptId);
				if (attemptReceipt === undefined) return Result.err(new FoundationError("invalid_correlation", "Canonical RunReceipt references a missing AttemptReceipt", { details: { runId, attemptReceiptId } }));
				attemptReceipts.push(attemptReceipt);
			}
			const taskResult = durable.receipt.taskResultId === undefined ? undefined : await this.getTaskResult(durable.receipt.taskResultId);
			if (durable.receipt.taskResultId !== undefined && taskResult === undefined) return Result.err(new FoundationError("invalid_correlation", "Canonical RunReceipt references a missing TaskResult", { details: { runId, taskResultId: durable.receipt.taskResultId } }));
			const firstAttemptReceipt = attemptReceipts[0];
			if (firstAttemptReceipt === undefined) return Result.err(new FoundationError("invalid_correlation", "Canonical RunReceipt has no source AttemptReceipt", { details: { runId } }));
			return Result.ok(cloneDeepFrozen({ schemaVersion: 1, runReceipt: durable.receipt, ...(taskResult === undefined ? {} : { taskResult }), attemptReceipts, writtenEvent: this.projectRunReceiptWritten(durable, firstAttemptReceipt) }));
		} catch (error) {
			return this.persistenceError(error, "run_terminal_authority_invalid");
		}
	}

	async release(): Promise<void> { await this.ledger.release(); }

	private async persistFact<T>(objectType: string, objectId: string, payload: T, correlation: Record<string, string | undefined>, options: { readonly immutable?: boolean; readonly expectedRevision?: number } = {}): Promise<{ readonly payload: T }> {
		if (options.immutable === true) {
			const existing = await this.ledger.get(objectType, objectId);
			if (existing?.kind === "fact") {
				if (canonicalFoundationJson(existing.payload) !== canonicalFoundationJson(payload)) throw new FoundationError("session_ledger_conflict", "An immutable Foundation fact already exists with different content", { details: { objectType, objectId } });
				return { payload: existing.payload as T };
			}
			if (existing !== undefined) throw new FoundationError("session_ledger_tombstoned", "An immutable Foundation fact cannot replace a terminal object", { details: { objectType, objectId } });
		}
		if (options.expectedRevision !== undefined) {
			const existing = await this.ledger.get(objectType, objectId);
			if (existing?.kind === "fact" && canonicalFoundationJson(existing.payload) === canonicalFoundationJson(payload)) return { payload: existing.payload as T };
		}
		const compact = Object.fromEntries(Object.entries(correlation).filter(([, value]) => value !== undefined)) as Record<string, string>;
		const result = await this.ledger.appendFact(objectType, objectId, payload, { clientRequestId: `${objectType}:${objectId}`, ...(options.immutable === true ? { expectedRevision: 0 } : options.expectedRevision === undefined ? {} : { expectedRevision: options.expectedRevision }), correlation: compact });
		return { payload: result.payload };
	}

	private async requireExistingTask(taskId: string): Promise<TaskEnvelope> {
		const stored = await this.ledger.get("task", taskId);
		if (stored === undefined || stored.kind !== "fact") throw new FoundationError("role_resolver_task_required", "Execution requires a TaskEnvelope that is durable in Session", { details: { taskId } });
		const checked = validateTaskEnvelope(stored.payload);
		if (!checked.ok || checked.value.taskId !== taskId) throw new FoundationError("role_resolver_task_required", "Durable TaskEnvelope identity is invalid", { details: { taskId } });
		return checked.value;
	}

	private async requireExistingBindingFacts(binding: AgentBinding, taskId?: string): Promise<DurableBindingFacts> {
		const task = taskId === undefined ? undefined : await this.requireExistingTask(taskId);
		const durableFacts = await requireDurableBindingSources(this.ledger, binding, task);
		const refs: readonly [string, string, string][] = [
			["external_agent_binding", binding.contextRevision.id, binding.contextRevision.fingerprint?.value ?? ""],
			["capability_binding", binding.capabilityRevision.id, binding.capabilityRevision.fingerprint?.value ?? ""],
			["model_broker_binding", binding.modelBrokerBindingRevision.id, binding.modelBrokerBindingRevision.fingerprint?.value ?? ""],
			["policy_binding", binding.policyRevision.id, binding.policyRevision.fingerprint?.value ?? ""],
		];
		const revisions = [binding.contextRevision, binding.capabilityRevision, binding.modelBrokerBindingRevision, binding.policyRevision];
		for (const [index, [objectType, objectId, fingerprint]] of refs.entries()) {
			const fact = await this.ledger.get(objectType, objectId);
			const reference = revisions[index];
			if (fact === undefined || fact.kind !== "fact" || fact.revision <= 0 || reference === undefined || fact.payload === undefined || fact.payload === null || typeof fact.payload !== "object" || !("revision" in fact.payload) || fact.payload.revision !== reference.revision || fingerprint.length === 0 || fingerprintFoundationValue(fact.payload).value !== fingerprint) throw new FoundationError("binding_required_fact", "AgentBinding references a missing or different immutable binding fact", { details: { objectType, objectId, revision: reference?.revision } });
		}
		return durableFacts;
	}

	private async requireDurableSpawnSources(roleRevision: RoleRevision, modelProfile: ModelProfile): Promise<DurableBindingFacts> {
		const canonicalRole = await findCanonicalRoleRevision(this.ledger, roleRevision.roleRevisionId, roleRevision.revision);
		const canonicalProfile = await findCanonicalModelProfile(this.ledger, modelProfile.modelProfileId, modelProfile.revision);
		return { roleRevision: canonicalRole, modelProfile: canonicalProfile, modelRoute: routeFromProfile(canonicalProfile) };
	}

	private async requireExistingBindingFactsFromId(bindingId: string, taskId: string): Promise<void> {
		const binding = await this.ledger.get("agent_binding", bindingId);
		if (binding === undefined || binding.kind !== "fact") throw new FoundationError("binding_required_fact", "Agent execution references a binding that is not durable", { details: { bindingId, taskId } });
		const checked = validateImmutableAgentBinding(binding.payload);
		if (!checked.ok || checked.value.taskId !== taskId) throw new FoundationError("binding_required_fact", "Agent execution references a binding with a different task", { details: { bindingId, taskId } });
		await this.requireExistingBindingFacts(checked.value);
	}

	private async requireExistingAgentInstance(epoch: BindingEpoch): Promise<void> {
		if (epoch.agentInstanceId === undefined) throw new FoundationError("agent_instance_required_for_agent_provider", "Agent mode switch requires a durable AgentInstance", { details: { bindingEpochId: epoch.bindingEpochId } });
		const stored = await this.ledger.get("agent_instance", epoch.agentInstanceId);
		if (stored === undefined || stored.kind !== "fact") throw new FoundationError("agent_instance_required_for_agent_provider", "Agent mode switch requires a durable AgentInstance", { details: { bindingEpochId: epoch.bindingEpochId, agentInstanceId: epoch.agentInstanceId } });
		const checked = validateAgentInstance(stored.payload);
		if (!checked.ok || checked.value.taskId !== epoch.taskId || checked.value.agentInstanceId !== epoch.agentInstanceId) throw new FoundationError("invalid_correlation", "Durable AgentInstance does not match the current BindingEpoch", { details: { bindingEpochId: epoch.bindingEpochId, agentInstanceId: epoch.agentInstanceId } });
	}

	private async requireExistingEpoch(epoch: BindingEpoch): Promise<void> {
		const stored = await this.ledger.get("binding_epoch", epoch.bindingEpochId);
		if (stored === undefined || stored.kind !== "fact" || canonicalFoundationJson(stored.payload) !== canonicalFoundationJson(epoch)) throw new FoundationError("binding_required_fact", "Mode switch requires the current immutable BindingEpoch to be durable", { details: { bindingEpochId: epoch.bindingEpochId } });
	}

	private async findDurableAttempt(dispatch: Dispatch, binding: AgentBinding, epoch: BindingEpoch, provider: DispatchExecutionInput["provider"]): Promise<Attempt | undefined> {
		const record = await this.ledger.get("attempt", epoch.attemptId);
		if (record === undefined) return undefined;
		if (record.kind !== "fact") throw new FoundationError("session_ledger_tombstoned", "A durable Attempt identity cannot be replaced by a terminal object", { details: { attemptId: epoch.attemptId } });
		const checked = validateAttempt(record.payload);
		if (!checked.ok) throw checked.error;
		if (checked.value.taskId !== dispatch.taskId || checked.value.dispatchId !== dispatch.dispatchId || checked.value.bindingId !== binding.bindingId || checked.value.providerId !== provider.providerId || !checked.value.bindingEpochIds.includes(epoch.bindingEpochId) || checked.value.agentInstanceId !== epoch.agentInstanceId) throw new FoundationError("invalid_correlation", "Durable Attempt does not match the replayed Dispatch", { details: { attemptId: checked.value.attemptId, dispatchId: dispatch.dispatchId } });
		return cloneDeepFrozen(checked.value);
	}

	private async findDurableDispatchExecution(dispatch: DispatchExecutionInput["dispatch"], binding: AgentBinding, epoch: BindingEpoch, provider: DispatchExecutionInput["provider"]): Promise<DispatchExecutionResult | undefined> {
		const records = await this.ledger.find({ kind: "fact", objectType: "attempt_receipt", order: "oldestFirst" });
		for (const record of records) {
			if (record.kind !== "fact") continue;
			const genericReceipt = validateAttemptReceipt(record.payload);
			if (!genericReceipt.ok) continue;
			if (genericReceipt.value.attemptId !== epoch.attemptId) continue;
			if (genericReceipt.value.taskId !== dispatch.taskId || genericReceipt.value.dispatchId !== dispatch.dispatchId || genericReceipt.value.bindingId !== binding.bindingId || genericReceipt.value.bindingEpochIds[0] !== epoch.bindingEpochId) throw new FoundationError("invalid_correlation", "Durable AttemptReceipt does not match the replayed Dispatch", { details: { attemptReceiptId: genericReceipt.value.attemptReceiptId, dispatchId: dispatch.dispatchId } });
			const checkedReceipt = validateAttemptReceiptForProvider(genericReceipt.value, { providerId: provider.providerId, providerClass: provider.providerClass });
			if (!checkedReceipt.ok) {
				if (genericReceipt.value.providerId !== provider.providerId) throw new FoundationError("session_ledger_conflict", "Existing AttemptReceipt conflicts with its deterministic reconstruction", { details: { attemptReceiptId: genericReceipt.value.attemptReceiptId, expectedProviderId: provider.providerId, actualProviderId: genericReceipt.value.providerId } });
				throw checkedReceipt.error;
			}
			const attemptRecord = await this.ledger.get("attempt", epoch.attemptId);
			if (attemptRecord === undefined || attemptRecord.kind !== "fact") throw new FoundationError("invalid_correlation", "Durable AttemptReceipt is missing its Attempt fact", { details: { attemptReceiptId: checkedReceipt.value.attemptReceiptId, attemptId: epoch.attemptId } });
			const checkedAttempt = validateAttempt(attemptRecord.payload);
			if (!checkedAttempt.ok) throw checkedAttempt.error;
			if (checkedAttempt.value.taskId !== dispatch.taskId || checkedAttempt.value.dispatchId !== dispatch.dispatchId || checkedAttempt.value.bindingId !== binding.bindingId || checkedAttempt.value.providerId !== provider.providerId || !checkedAttempt.value.bindingEpochIds.includes(epoch.bindingEpochId) || checkedAttempt.value.agentInstanceId !== epoch.agentInstanceId) throw new FoundationError("invalid_correlation", "Durable Attempt does not match the replayed Dispatch", { details: { attemptId: checkedAttempt.value.attemptId, dispatchId: dispatch.dispatchId } });
			await this.requireWorkerReceiptRefs(checkedReceipt.value);
			return { attempt: cloneDeepFrozen(checkedAttempt.value), receipt: cloneDeepFrozen(checkedReceipt.value), providerId: provider.providerId, providerClass: provider.providerClass };
		}
		return undefined;
	}

	private async requireWorkerReceiptRefs(receipt: AttemptReceipt): Promise<void> {
		for (const reference of receipt.workerReceiptRefs) {
			const worker = await this.ledger.get("worker_receipt", reference.id);
			if (worker === undefined || worker.kind !== "fact" || worker.revision !== reference.revision || reference.fingerprint !== undefined && fingerprintFoundationValue(worker.payload).value !== reference.fingerprint.value) throw new FoundationError("invalid_correlation", "AttemptReceipt references a missing or different WorkerReceipt", { details: { attemptReceiptId: receipt.attemptReceiptId, workerReceiptId: reference.id } });
		}
	}

	private async findRunTerminalRecord(runId: string): Promise<DurableRunReceipt | undefined> {
		const records = await this.ledger.find({ kind: "fact", objectType: "run_receipt", order: "oldestFirst" });
		let found: DurableRunReceipt | undefined;
		for (const record of records) {
			if (record.kind !== "fact") continue;
			const checked = validateRunReceipt(record.payload);
			if (!checked.ok) throw checked.error;
			if (checked.value.runId !== record.objectId) throw new FoundationError("run_terminal_authority_invalid", "Canonical RunReceipt durable key does not match its payload", { details: { runId: checked.value.runId, objectId: record.objectId } });
			if (checked.value.runId !== runId) continue;
			if (found !== undefined) throw new FoundationError("run_terminal_authority_invalid", "A runId has more than one durable terminal fact", { details: { runId } });
			found = { record, receipt: checked.value };
		}
		return found;
	}

	private async findRunReceiptRecordById(runReceiptId: string): Promise<DurableRunReceipt | undefined> {
		const records = await this.ledger.find({ kind: "fact", objectType: "run_receipt", order: "oldestFirst" });
		let found: DurableRunReceipt | undefined;
		for (const record of records) {
			if (record.kind !== "fact") continue;
			const checked = validateRunReceipt(record.payload);
			if (!checked.ok) throw checked.error;
			if (checked.value.runId !== record.objectId) throw new FoundationError("run_terminal_authority_invalid", "Canonical RunReceipt durable key does not match its payload", { details: { runReceiptId: checked.value.runReceiptId, objectId: record.objectId } });
			if (checked.value.runReceiptId !== runReceiptId) continue;
			if (found !== undefined) throw new FoundationError("run_terminal_authority_invalid", "A runReceiptId has more than one durable terminal fact", { details: { runReceiptId } });
			found = { record, receipt: checked.value };
		}
		return found;
	}

	private projectRunReceiptWritten(durable: DurableRunReceipt, firstAttemptReceipt: AttemptReceipt): RunReceiptWrittenEvent {
		const source = durable.record.correlation;
		const correlation: EventCorrelationRef = {
			sessionId: source.sessionId,
			laneId: source.laneId,
			taskId: firstAttemptReceipt.taskId,
			runId: durable.receipt.runId,
			runReceiptId: durable.receipt.runReceiptId,
			...(durable.receipt.taskResultId === undefined ? {} : { taskResultId: durable.receipt.taskResultId }),
			attemptId: firstAttemptReceipt.attemptId,
			attemptReceiptId: firstAttemptReceipt.attemptReceiptId,
		};
		return createDurableEvent({
			category: "run_receipt.written",
			eventId: durable.record.id,
			streamId: source.sessionId,
			sequence: durable.record.seq,
			timestamp: new Date(durable.record.timestamp).toISOString(),
			correlation,
			payload: { schemaVersion: 1, runReceiptId: durable.receipt.runReceiptId, runId: durable.receipt.runId },
		});
	}

	private persistenceError<T>(error: unknown, fallback: FoundationErrorCode): ResultValue<T, FoundationError> {
		if (error instanceof DurableLedgerError) throw error;
		return Result.err(toFoundationError(error, fallback));
	}
}
