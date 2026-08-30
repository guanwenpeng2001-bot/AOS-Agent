import { Result, type ResultValue } from "../result.ts";
import type { AcceptanceFact } from "./goal.ts";
import { FoundationError, type PublicExecutionError } from "./errors.ts";
import { PROVIDER_CLASS } from "./providers.ts";
import { fingerprintFoundationValue, type ExecutionCorrelation, type Fingerprint, type FoundationLineage } from "./identity.ts";
import { ArtifactRefSchema, FOUNDATION_SHA256_DIGEST_PATTERN, WorkerReceiptRefSchema, type ArtifactRef, type WorkerReceiptRef } from "./reference.ts";
import type { AttemptProviderClass, TaskEnvelope } from "./task.ts";
import { SideEffectStateSchema, type SideEffectState } from "./side-effect.ts";
import { Type } from "typebox";
import { ExecutionCorrelationSchema, exactShapeIssues, LineageSchema, makeExactShapeGuard, parseExactShape, serializeExactShape, validateExactShape } from "./schema.ts";

export type ResultProducerKind = "operation_worker" | "scheduler" | "agent_executor" | "external_connector" | "host";
export interface ResultProvenance { producerKind: ResultProducerKind; providerId: string; producedAt: string; lineage?: FoundationLineage; /** Correlation is optional for legacy records but required by provider consumers when an expectation is supplied. */ correlation?: ExecutionCorrelation; }
export type ResultStatus = "succeeded" | "failed" | "cancelled" | "suspended";
export interface WorkerReceipt { schemaVersion: 1; workerReceiptId: string; sandboxProviderId: string; operationId: string; taskId?: string; dispatchId?: string; attemptId?: string; status: ResultStatus; sideEffectState: SideEffectState; artifacts?: readonly ArtifactRef[]; error?: PublicExecutionError; provenance: ResultProvenance; startedAt: string; completedAt: string; }
/** Exact bounded usage evidence owned by one canonical AttemptReceipt. */
export interface AttemptReceiptUsage { inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number; costUsd: number; }
export interface AttemptReceipt { schemaVersion: 1; attemptReceiptId: string; taskId: string; dispatchId: string; attemptId: string; providerId: string; agentInstanceId?: string; bindingId: string; bindingEpochIds: readonly string[]; status: ResultStatus; workerReceiptRefs: readonly WorkerReceiptRef[]; artifacts: readonly ArtifactRef[]; usage?: AttemptReceiptUsage; error?: PublicExecutionError; provenance: ResultProvenance; sideEffectState: SideEffectState; }
export interface ValidationResult { name: string; required: boolean; status: "passed" | "failed" | "skipped" | "pending"; summary?: string; evidenceRefs?: readonly ArtifactRef[]; }
export interface ResultValidation { schemaValid: boolean; artifactDigestsValid: boolean; acceptanceVerified: boolean; requiredEvidencePresent: boolean; notes?: readonly string[]; }
export interface TaskResult { schemaVersion: 1; taskResultId: string; taskId: string; sourceAttemptReceiptIds: readonly string[]; status: ResultStatus; summary: string; artifacts: readonly ArtifactRef[]; diff?: ArtifactRef; tests: readonly ValidationResult[]; evidence: readonly AcceptanceFact[]; error?: PublicExecutionError; provenance: ResultProvenance; validation: ResultValidation; }
export type RunTerminalStatus = "completed" | "failed" | "cancelled";
/** Cumulative token usage owned by the canonical RunReceipt. */
export interface RunReceiptUsage { inputTokens: number; outputTokens: number; totalTokens: number; }
export interface RunReceipt { schemaVersion: 1; runReceiptId: string; runId: string; terminalStatus: RunTerminalStatus; taskResultId?: string; attemptReceiptIds: readonly string[]; usage: RunReceiptUsage; terminalErrorCode?: string; terminalError?: PublicExecutionError; completedAt: string; }
export interface HostTerminalGateAuthority { schemaVersion: 1; type: "host_terminal_gate"; authorityId: string; revision: number; fingerprint: Fingerprint; }

const provenanceSchema = Type.Object({ producerKind: Type.Union([Type.Literal("operation_worker"), Type.Literal("scheduler"), Type.Literal("agent_executor"), Type.Literal("external_connector"), Type.Literal("host")]), providerId: Type.String({ minLength: 1 }), producedAt: Type.String({ minLength: 1 }), lineage: Type.Optional(LineageSchema), correlation: Type.Optional(ExecutionCorrelationSchema) }, { additionalProperties: false });
const artifactSchema = ArtifactRefSchema;
const publicErrorSchema = Type.Object({ code: Type.String({ minLength: 1 }), message: Type.String({ minLength: 1 }), category: Type.Optional(Type.Union([Type.Literal("permission"), Type.Literal("parameter"), Type.Literal("transient"), Type.Literal("deadline"), Type.Literal("cancelled"), Type.Literal("side_effect_unknown"), Type.Literal("unknown")])), retryable: Type.Boolean() }, { additionalProperties: false });
export const PublicExecutionErrorSchema = publicErrorSchema;
export const AttemptReceiptUsageSchema = Type.Object({ inputTokens: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }), outputTokens: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }), cacheReadInputTokens: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }), cacheCreationInputTokens: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }), costUsd: Type.Number({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }) }, { additionalProperties: false });
export const AttemptReceiptSchema = Type.Object({ schemaVersion: Type.Literal(1), attemptReceiptId: Type.String({ minLength: 1 }), taskId: Type.String({ minLength: 1 }), dispatchId: Type.String({ minLength: 1 }), attemptId: Type.String({ minLength: 1 }), providerId: Type.String({ minLength: 1 }), agentInstanceId: Type.Optional(Type.String({ minLength: 1 })), bindingId: Type.String({ minLength: 1 }), bindingEpochIds: Type.Array(Type.String({ minLength: 1 })), status: Type.Union([Type.Literal("succeeded"), Type.Literal("failed"), Type.Literal("cancelled"), Type.Literal("suspended")]), workerReceiptRefs: Type.Array(WorkerReceiptRefSchema), artifacts: Type.Array(artifactSchema), usage: Type.Optional(AttemptReceiptUsageSchema), error: Type.Optional(publicErrorSchema), provenance: provenanceSchema, sideEffectState: SideEffectStateSchema }, { additionalProperties: false });
export const WorkerReceiptSchema = Type.Object({ schemaVersion: Type.Literal(1), workerReceiptId: Type.String({ minLength: 1 }), sandboxProviderId: Type.String({ minLength: 1 }), operationId: Type.String({ minLength: 1 }), taskId: Type.Optional(Type.String({ minLength: 1 })), dispatchId: Type.Optional(Type.String({ minLength: 1 })), attemptId: Type.Optional(Type.String({ minLength: 1 })), status: Type.Union([Type.Literal("succeeded"), Type.Literal("failed"), Type.Literal("cancelled"), Type.Literal("suspended")]), sideEffectState: SideEffectStateSchema, artifacts: Type.Optional(Type.Array(artifactSchema)), error: Type.Optional(publicErrorSchema), provenance: provenanceSchema, startedAt: Type.String({ minLength: 1 }), completedAt: Type.String({ minLength: 1 }) }, { additionalProperties: false });
export const isAttemptReceiptShape = makeExactShapeGuard<AttemptReceipt>(AttemptReceiptSchema, "attempt_receipt");
export const isWorkerReceiptShape = makeExactShapeGuard<WorkerReceipt>(WorkerReceiptSchema, "worker_receipt");
function requireResultCorrelation(provenance: ResultProvenance, required: readonly (keyof ExecutionCorrelation)[], objectId: string): ResultValue<ExecutionCorrelation, FoundationError> {
	const correlation = provenance.correlation;
	if (correlation === undefined || typeof correlation.sessionId !== "string" || correlation.sessionId.length === 0 || typeof correlation.laneId !== "string" || correlation.laneId.length === 0 || !Number.isSafeInteger(correlation.revision) || correlation.revision < 0) return Result.err(new FoundationError("invalid_correlation", "Result provenance requires a complete ExecutionCorrelation", { details: { objectId } }));
	for (const field of required) {
		const value = correlation[field];
		const valid = field === "revision" ? Number.isSafeInteger(value) && (value as number) >= 0 : typeof value === "string" && value.length > 0;
		if (!valid) return Result.err(new FoundationError("invalid_correlation", "Result provenance is missing a required identity field", { details: { objectId, field } }));
	}
	return Result.ok(correlation);
}
export function validateAttemptReceipt(value: unknown, options: { agentProvider?: boolean; providerClass?: AttemptProviderClass } = {}): ResultValue<AttemptReceipt, FoundationError> {
	if (!isAttemptReceiptShape(value)) return Result.err(new FoundationError("foundation_schema_invalid_shape", "attempt_receipt failed exact-shape validation", { details: { issues: exactShapeIssues(AttemptReceiptSchema, value) } }));
	const receipt = value as AttemptReceipt;
	const correlation = requireResultCorrelation(receipt.provenance, ["sessionId", "laneId", "taskId", "dispatchId", "attemptId", "bindingId", "bindingEpochId"], receipt.attemptReceiptId);
	if (!correlation.ok) return Result.err(correlation.error);
	if (correlation.value.taskId !== receipt.taskId || correlation.value.dispatchId !== receipt.dispatchId || correlation.value.attemptId !== receipt.attemptId || correlation.value.bindingId !== receipt.bindingId || receipt.bindingEpochIds.length === 0 || correlation.value.bindingEpochId !== receipt.bindingEpochIds[0]) return Result.err(new FoundationError("invalid_correlation", "AttemptReceipt provenance does not match its immutable execution identity", { details: { attemptReceiptId: receipt.attemptReceiptId } }));
	if (receipt.provenance.providerId !== receipt.providerId) return Result.err(new FoundationError("worker_receipt_invalid_producer", "AttemptReceipt provider identity must match provenance", { details: { attemptReceiptId: receipt.attemptReceiptId } }));
	if (receipt.status === "succeeded" && receipt.sideEffectState !== "none") return Result.err(new FoundationError("side_effect_unknown", "A succeeded AttemptReceipt must prove that no side effect remains unknown", { details: { attemptReceiptId: receipt.attemptReceiptId, sideEffectState: receipt.sideEffectState } }));
	if (receipt.status === "cancelled" && receipt.sideEffectState !== "none") return Result.err(new FoundationError("side_effect_unknown", "A cancelled AttemptReceipt must prove that no side effect remains unknown", { details: { attemptReceiptId: receipt.attemptReceiptId, sideEffectState: receipt.sideEffectState } }));
	if (options.agentProvider === true && receipt.agentInstanceId === undefined) return Result.err(new FoundationError("agent_instance_required_for_agent_provider", "Agent-class providers require an AgentInstance", { details: { attemptReceiptId: receipt.attemptReceiptId } }));
	if (options.agentProvider === false && receipt.agentInstanceId !== undefined) return Result.err(new FoundationError("agent_instance_forbidden_for_provider", "Non-agent providers cannot carry an AgentInstance", { details: { attemptReceiptId: receipt.attemptReceiptId } }));
	if (receipt.provenance.producerKind === "agent_executor" && receipt.agentInstanceId === undefined) return Result.err(new FoundationError("agent_instance_required_for_agent_provider", "agent_executor receipts require an AgentInstance", { details: { attemptReceiptId: receipt.attemptReceiptId } }));
	if (receipt.provenance.producerKind !== "agent_executor" && receipt.agentInstanceId !== undefined) return Result.err(new FoundationError("agent_instance_forbidden_for_provider", "Non-agent producers cannot carry an AgentInstance", { details: { attemptReceiptId: receipt.attemptReceiptId } }));
	if (options.providerClass === "agent" && receipt.provenance.producerKind !== "agent_executor") return Result.err(new FoundationError("agent_instance_not_agent_provider", "Agent providers must produce agent_executor receipts", { details: { attemptReceiptId: receipt.attemptReceiptId } }));
	if (options.providerClass === "agent" && receipt.agentInstanceId === undefined) return Result.err(new FoundationError("agent_instance_required_for_agent_provider", "Agent-class providers require an AgentInstance", { details: { attemptReceiptId: receipt.attemptReceiptId } }));
	if (options.providerClass !== undefined && options.providerClass !== "agent" && receipt.agentInstanceId !== undefined) return Result.err(new FoundationError("agent_instance_forbidden_for_provider", "Only agent-class executors may carry an AgentInstance", { details: { attemptReceiptId: receipt.attemptReceiptId } }));
	if ((options.providerClass === "scheduler" || options.providerClass === "task_executor") && receipt.provenance.producerKind !== "scheduler") return Result.err(new FoundationError("agent_instance_not_agent_provider", "scheduler/task-executor providers must produce scheduler receipts", { details: { attemptReceiptId: receipt.attemptReceiptId } }));
	if (options.providerClass === PROVIDER_CLASS.externalConnector && receipt.provenance.producerKind !== "external_connector") return Result.err(new FoundationError("agent_instance_not_agent_provider", "external connectors must produce external_connector receipts", { details: { attemptReceiptId: receipt.attemptReceiptId } }));
	return Result.ok(receipt);
}
export function validateAttemptReceiptUsage(value: unknown): ResultValue<AttemptReceiptUsage, FoundationError> { return validateExactShape<AttemptReceiptUsage>(AttemptReceiptUsageSchema, value, "attempt_receipt_usage"); }
export function validateWorkerReceipt(value: unknown): ResultValue<WorkerReceipt, FoundationError> {
	if (!isWorkerReceiptShape(value)) return Result.err(new FoundationError("foundation_schema_invalid_shape", "worker_receipt failed exact-shape validation", { details: { issues: exactShapeIssues(WorkerReceiptSchema, value) } }));
	const receipt = value as WorkerReceipt;
	const correlation = requireResultCorrelation(receipt.provenance, ["sessionId", "laneId"], receipt.workerReceiptId);
	if (!correlation.ok) return Result.err(correlation.error);
	for (const field of ["taskId", "dispatchId", "attemptId"] as const) {
		if (receipt[field] !== undefined && correlation.value[field] !== receipt[field]) return Result.err(new FoundationError("invalid_correlation", "WorkerReceipt provenance does not match its operation identity", { details: { workerReceiptId: receipt.workerReceiptId, field } }));
	}
	if (receipt.provenance.producerKind !== "operation_worker" || receipt.provenance.providerId !== receipt.sandboxProviderId) return Result.err(new FoundationError("worker_receipt_invalid_producer", "WorkerReceipt provenance must identify its operation worker", { details: { workerReceiptId: receipt.workerReceiptId } }));
	if (receipt.status === "succeeded" && receipt.sideEffectState !== "none") return Result.err(new FoundationError("side_effect_unknown", "A succeeded WorkerReceipt must prove that no side effect remains unknown", { details: { workerReceiptId: receipt.workerReceiptId, sideEffectState: receipt.sideEffectState } }));
	return Result.ok(receipt);
}
export interface SettleTaskResultInput { taskResultId: string; task: TaskEnvelope; receipts: readonly AttemptReceipt[]; summary: string; artifacts?: readonly ArtifactRef[]; diff?: ArtifactRef; tests: readonly ValidationResult[]; evidence: readonly AcceptanceFact[]; producer: ResultProvenance; validation?: ResultValidation; }
export function settleTaskResult(input: SettleTaskResultInput): ResultValue<TaskResult, FoundationError> {
	if (input.taskResultId.length === 0) return Result.err(new FoundationError("task_result_validation_failed", "TaskResult requires a stable id"));
	if (input.producer.producerKind !== "host") return Result.err(new FoundationError("task_result_validation_failed", "Only the Host settlement gate may produce a TaskResult", { details: { taskResultId: input.taskResultId } }));
	const producerCorrelation = requireResultCorrelation(input.producer, ["sessionId", "laneId", "taskId", "taskResultId"], input.taskResultId);
	if (!producerCorrelation.ok) return Result.err(producerCorrelation.error);
	if (producerCorrelation.value.taskId !== input.task.taskId || producerCorrelation.value.taskResultId !== input.taskResultId) return Result.err(new FoundationError("invalid_correlation", "Host TaskResult provenance does not match its task identity", { details: { taskResultId: input.taskResultId } }));
	if (input.receipts.length === 0) return Result.err(new FoundationError("task_result_no_source_receipts", "Task settlement requires AttemptReceipt sources", { details: { taskResultId: input.taskResultId } }));
	const receiptIds = input.receipts.map((receipt) => receipt.attemptReceiptId);
	if (new Set(receiptIds).size !== receiptIds.length) return Result.err(new FoundationError("task_result_validation_failed", "TaskResult sources must not repeat an AttemptReceipt", { details: { taskResultId: input.taskResultId } }));
	for (const receipt of input.receipts) { const checked = validateAttemptReceipt(receipt); if (!checked.ok) return checked; if (receipt.taskId !== input.task.taskId) return Result.err(new FoundationError("task_result_receipt_task_mismatch", "AttemptReceipt does not belong to the task", { details: { taskResultId: input.taskResultId } })); }
	const status: ResultStatus = input.receipts.some((receipt) => receipt.status === "failed") ? "failed" : input.receipts.every((receipt) => receipt.status === "cancelled") ? "cancelled" : input.receipts.some((receipt) => receipt.status === "suspended") ? "suspended" : "succeeded";
	const artifacts = [...(input.artifacts ?? [])];
	const validArtifactRef = (artifact: unknown): artifact is ArtifactRef => {
		if (artifact === null || typeof artifact !== "object" || Array.isArray(artifact)) return false;
		const record = artifact as Record<string, unknown>;
		if (!Object.keys(record).every((key) => ["schemaVersion", "artifactId", "mediaType", "digest", "producer", "sizeBytes"].includes(key))) return false;
		if (record.schemaVersion !== 1 || typeof record.artifactId !== "string" || record.artifactId.length === 0) return false;
		if (typeof record.mediaType !== "string" || record.mediaType.length === 0) return false;
		if (typeof record.digest !== "string" || !new RegExp(FOUNDATION_SHA256_DIGEST_PATTERN).test(record.digest)) return false;
		if (record.producer !== undefined && typeof record.producer !== "string") return false;
		return record.sizeBytes === undefined || typeof record.sizeBytes === "number" && Number.isInteger(record.sizeBytes) && record.sizeBytes >= 0;
	};
	const validArtifacts = artifacts.every(validArtifactRef) && (input.diff === undefined || validArtifactRef(input.diff));
	const expectedOutputs = Array.isArray(input.task.expectedOutputs) ? input.task.expectedOutputs : undefined;
	const expectedOutputsValid = expectedOutputs?.every(validArtifactRef);
	const expectedOutputsPresent = expectedOutputsValid === true && expectedOutputs.every((expected) => artifacts.some((actual) => actual.artifactId === expected.artifactId && actual.digest === expected.digest));
	const requiredTests = input.tests.filter((test) => test.required);
	const requiredCriteria = Array.isArray(input.task.acceptanceCriteria) ? input.task.acceptanceCriteria.filter((criterion) => criterion.required) : [];
	const requiresAcceptanceProof = (expectedOutputs?.length ?? 0) > 0 || requiredCriteria.length > 0;
	const testsValid = requiredTests.length > 0
		? requiredTests.every((test) => test.status === "passed")
		: !requiresAcceptanceProof && input.tests.length === 0;
	const validTest = (test: ValidationResult): boolean => typeof test.name === "string" && test.name.length > 0 && typeof test.required === "boolean" && ["passed", "failed", "skipped", "pending"].includes(test.status) && (test.evidenceRefs === undefined || test.evidenceRefs.every(validArtifactRef));
	const validEvidence = (fact: AcceptanceFact): boolean => fact.schemaVersion === 1 && typeof fact.factId === "string" && fact.factId.length > 0 && typeof fact.criterionId === "string" && fact.criterionId.length > 0 && ["satisfied", "unsatisfied", "pending"].includes(fact.outcome) && typeof fact.recordedAt === "string" && fact.recordedAt.length > 0 && (fact.evidenceRefs === undefined || fact.evidenceRefs.every(validArtifactRef));
	const evidenceValid = input.evidence.every(validEvidence) && requiredCriteria.every((criterion) => input.evidence.some((fact) => { const evidenceRefs = fact.evidenceRefs; return fact.criterionId === criterion.criterionId && fact.outcome === "satisfied" && evidenceRefs !== undefined && evidenceRefs.length > 0 && evidenceRefs.every(validArtifactRef); }));
	const validation = { schemaValid: validArtifacts && input.tests.every(validTest) && input.evidence.every(validEvidence), artifactDigestsValid: validArtifacts && artifacts.every(validArtifactRef), acceptanceVerified: evidenceValid, requiredEvidencePresent: evidenceValid };
	if (status === "succeeded" && (!expectedOutputsPresent || !expectedOutputsValid || !validArtifacts || !testsValid || !evidenceValid || !validation.schemaValid || input.validation !== undefined && Object.values(input.validation).some((value) => typeof value === "boolean" && !value))) return Result.err(new FoundationError("task_result_validation_failed", "Succeeded TaskResult failed required output, test, evidence, or validation checks", { details: { taskResultId: input.taskResultId, expectedOutputsPresent: expectedOutputsPresent === true, testsValid, evidenceValid, artifactDigestsValid: validArtifacts } }));
	if (status === "succeeded" && !evidenceValid) return Result.err(new FoundationError("task_result_acceptance_unverified", "Required acceptance criteria are not satisfied", { details: { taskResultId: input.taskResultId, unverifiedCriterionIds: requiredCriteria.filter((criterion) => !input.evidence.some((fact) => fact.criterionId === criterion.criterionId && fact.outcome === "satisfied")).map((criterion) => criterion.criterionId) } }));
	return Result.ok({ schemaVersion: 1, taskResultId: input.taskResultId, taskId: input.task.taskId, sourceAttemptReceiptIds: input.receipts.map((receipt) => receipt.attemptReceiptId), status, summary: input.summary, artifacts, ...(input.diff === undefined ? {} : { diff: input.diff }), tests: [...input.tests], evidence: [...input.evidence], provenance: input.producer, validation });
}
export const HostTerminalGateAuthoritySchema = Type.Object({ schemaVersion: Type.Literal(1), type: Type.Literal("host_terminal_gate"), authorityId: Type.String({ minLength: 1 }), revision: Type.Integer({ minimum: 0 }), fingerprint: Type.Object({ algorithm: Type.Literal("sha256"), value: Type.String({ minLength: 1 }) }, { additionalProperties: false }) }, { additionalProperties: false });
export function createHostTerminalGateAuthority(authorityId: string, revision = 1): HostTerminalGateAuthority { const base = { schemaVersion: 1 as const, type: "host_terminal_gate" as const, authorityId, revision }; return { ...base, fingerprint: fingerprintFoundationValue(base) }; }
export function validateHostTerminalGateAuthority(value: unknown): ResultValue<HostTerminalGateAuthority, FoundationError> {
	const checked = validateExactShape<HostTerminalGateAuthority>(HostTerminalGateAuthoritySchema, value, "host_terminal_gate_authority");
	if (!checked.ok) return checked;
	const { fingerprint, ...base } = checked.value;
	return fingerprint.value === fingerprintFoundationValue(base).value ? checked : Result.err(new FoundationError("run_terminal_authority_invalid", "Host terminal-gate fingerprint does not match its authority", { details: { authorityId: checked.value.authorityId } }));
}
export function serializeHostTerminalGateAuthority(value: HostTerminalGateAuthority): string { return serializeExactShape(HostTerminalGateAuthoritySchema, value, "host_terminal_gate_authority"); }
export function parseHostTerminalGateAuthority(text: string): ResultValue<HostTerminalGateAuthority, FoundationError> { return parseExactShape(HostTerminalGateAuthoritySchema, text, "host_terminal_gate_authority"); }
export interface FinalizeRunReceiptInput { runReceiptId: string; runId: string; terminalStatus: RunTerminalStatus; authority: HostTerminalGateAuthority; taskResult?: TaskResult; attemptReceiptIds: readonly string[]; usage: RunReceiptUsage; terminalErrorCode?: string; terminalError?: PublicExecutionError; completedAt?: string; }
export function finalizeRunReceipt(input: FinalizeRunReceiptInput): ResultValue<RunReceipt, FoundationError> {
	if (input.runReceiptId.length === 0 || input.runId.length === 0) return Result.err(new FoundationError("run_terminal_authority_invalid", "Run receipt finalization requires stable run and receipt ids", { details: { runId: input.runId } }));
	if (input.authority === undefined) return Result.err(new FoundationError("run_terminal_authority_required", "Run receipt finalization requires an explicit Host terminal-gate authority", { details: { runId: input.runId } }));
	const authority = validateHostTerminalGateAuthority(input.authority);
	if (!authority.ok) return Result.err(new FoundationError("run_terminal_authority_invalid", "Run receipt finalization requires a valid Host terminal-gate authority", { details: { runId: input.runId } }));
	if (input.terminalStatus === "completed" && input.taskResult === undefined) return Result.err(new FoundationError("task_result_terminal_requires_task_result", "A completed run requires a TaskResult", { details: { runId: input.runId } }));
	if (input.terminalStatus === "completed" && (input.terminalErrorCode !== undefined || input.terminalError !== undefined)) return Result.err(new FoundationError("run_terminal_authority_invalid", "A completed run cannot carry a terminal error", { details: { runId: input.runId } }));
	if (input.terminalStatus !== "completed" && input.terminalError === undefined) return Result.err(new FoundationError("run_terminal_authority_invalid", "A non-completed run requires canonical terminal error detail", { details: { runId: input.runId } }));
	if (input.terminalError !== undefined) {
		const terminalError = validatePublicExecutionError(input.terminalError);
		if (!terminalError.ok || input.terminalErrorCode !== undefined && input.terminalErrorCode !== terminalError.value.code) return Result.err(new FoundationError("run_terminal_authority_invalid", "Run terminal error code and detail must agree", { details: { runId: input.runId } }));
	}
	const checkedUsage = validateRunReceiptUsage(input.usage);
	if (!checkedUsage.ok) return checkedUsage;
	if (input.taskResult !== undefined) {
		const taskResult = validateTaskResult(input.taskResult);
		if (!taskResult.ok || taskResult.value.provenance.producerKind !== "host") return Result.err(new FoundationError("task_result_validation_failed", "Run terminal gate requires an exact host TaskResult", { details: { runId: input.runId } }));
		if (input.terminalStatus === "completed" && taskResult.value.status !== "succeeded") return Result.err(new FoundationError("task_result_terminal_requires_task_result", "Completed run requires a succeeded TaskResult", { details: { runId: input.runId } }));
	}
	if (input.attemptReceiptIds.length === 0) return Result.err(new FoundationError("task_result_no_source_receipts", "Run receipt requires source AttemptReceipt ids", { details: { runId: input.runId } }));
	if (input.attemptReceiptIds.some((id) => id.length === 0) || new Set(input.attemptReceiptIds).size !== input.attemptReceiptIds.length) return Result.err(new FoundationError("task_result_validation_failed", "Run receipt source AttemptReceipt ids must be unique and non-empty", { details: { runId: input.runId } }));
	if (input.taskResult?.sourceAttemptReceiptIds.some((id) => !input.attemptReceiptIds.includes(id))) return Result.err(new FoundationError("task_result_validation_failed", "Run receipt sources must include every TaskResult source receipt", { details: { runId: input.runId } }));
	return Result.ok({ schemaVersion: 1, runReceiptId: input.runReceiptId, runId: input.runId, terminalStatus: input.terminalStatus, attemptReceiptIds: [...input.attemptReceiptIds], ...(input.taskResult === undefined ? {} : { taskResultId: input.taskResult.taskResultId }), usage: checkedUsage.value, ...(input.terminalErrorCode === undefined ? {} : { terminalErrorCode: input.terminalErrorCode }), ...(input.terminalError === undefined ? {} : { terminalError: input.terminalError }), completedAt: input.completedAt ?? new Date().toISOString() });
}

const validationSchema = Type.Object({ name: Type.String({ minLength: 1 }), required: Type.Boolean(), status: Type.Union([Type.Literal("passed"), Type.Literal("failed"), Type.Literal("skipped"), Type.Literal("pending")]), summary: Type.Optional(Type.String()), evidenceRefs: Type.Optional(Type.Array(ArtifactRefSchema)) }, { additionalProperties: false });
const acceptanceFactSchema = Type.Object({ schemaVersion: Type.Literal(1), factId: Type.String({ minLength: 1 }), criterionId: Type.String({ minLength: 1 }), outcome: Type.Union([Type.Literal("satisfied"), Type.Literal("unsatisfied"), Type.Literal("pending")]), evidenceRefs: Type.Optional(Type.Array(artifactSchema)), recordedAt: Type.String({ minLength: 1 }), recordedBy: Type.Optional(Type.String({ minLength: 1 })) }, { additionalProperties: false });
export const TaskResultSchema = Type.Object({ schemaVersion: Type.Literal(1), taskResultId: Type.String({ minLength: 1 }), taskId: Type.String({ minLength: 1 }), sourceAttemptReceiptIds: Type.Array(Type.String({ minLength: 1 })), status: Type.Union([Type.Literal("succeeded"), Type.Literal("failed"), Type.Literal("cancelled"), Type.Literal("suspended")]), summary: Type.String(), artifacts: Type.Array(ArtifactRefSchema), diff: Type.Optional(ArtifactRefSchema), tests: Type.Array(validationSchema), evidence: Type.Array(acceptanceFactSchema), error: Type.Optional(publicErrorSchema), provenance: provenanceSchema, validation: Type.Object({ schemaValid: Type.Boolean(), artifactDigestsValid: Type.Boolean(), acceptanceVerified: Type.Boolean(), requiredEvidencePresent: Type.Boolean(), notes: Type.Optional(Type.Array(Type.String())) }, { additionalProperties: false }) }, { additionalProperties: false });
export const RunReceiptUsageSchema = Type.Object({ inputTokens: Type.Integer({ minimum: 0 }), outputTokens: Type.Integer({ minimum: 0 }), totalTokens: Type.Integer({ minimum: 0 }) }, { additionalProperties: false });
export const RunReceiptSchema = Type.Object({ schemaVersion: Type.Literal(1), runReceiptId: Type.String({ minLength: 1 }), runId: Type.String({ minLength: 1 }), terminalStatus: Type.Union([Type.Literal("completed"), Type.Literal("failed"), Type.Literal("cancelled")]), taskResultId: Type.Optional(Type.String({ minLength: 1 })), attemptReceiptIds: Type.Array(Type.String({ minLength: 1 })), usage: RunReceiptUsageSchema, terminalErrorCode: Type.Optional(Type.String({ minLength: 1 })), terminalError: Type.Optional(publicErrorSchema), completedAt: Type.String({ minLength: 1 }) }, { additionalProperties: false });
export function validateRunReceiptUsage(value: unknown): ResultValue<RunReceiptUsage, FoundationError> {
	const checked = validateExactShape<RunReceiptUsage>(RunReceiptUsageSchema, value, "run_receipt_usage");
	if (!checked.ok) return checked;
	return Number.isSafeInteger(checked.value.inputTokens) && Number.isSafeInteger(checked.value.outputTokens) && Number.isSafeInteger(checked.value.totalTokens) && Number.isSafeInteger(checked.value.inputTokens + checked.value.outputTokens) && checked.value.totalTokens >= checked.value.inputTokens + checked.value.outputTokens
		? checked
		: Result.err(new FoundationError("run_terminal_authority_invalid", "RunReceipt usage must contain safe cumulative token totals and totalTokens must include inputTokens and outputTokens"));
}
export function validatePublicExecutionError(value: unknown): ResultValue<PublicExecutionError, FoundationError> { return validateExactShape<PublicExecutionError>(PublicExecutionErrorSchema, value, "public_execution_error"); }
export function serializePublicExecutionError(value: PublicExecutionError): string { return serializeExactShape(PublicExecutionErrorSchema, value, "public_execution_error"); }
export function parsePublicExecutionError(text: string): ResultValue<PublicExecutionError, FoundationError> { return parseExactShape(PublicExecutionErrorSchema, text, "public_execution_error"); }
export function serializeWorkerReceipt(value: WorkerReceipt): string { return serializeExactShape(WorkerReceiptSchema, value, "worker_receipt"); }
export function parseWorkerReceipt(text: string): ResultValue<WorkerReceipt, FoundationError> { return parseExactShape(WorkerReceiptSchema, text, "worker_receipt"); }
export function serializeAttemptReceipt(value: AttemptReceipt): string { return serializeExactShape(AttemptReceiptSchema, value, "attempt_receipt"); }
export function parseAttemptReceipt(text: string): ResultValue<AttemptReceipt, FoundationError> { return parseExactShape(AttemptReceiptSchema, text, "attempt_receipt"); }
export function validateTaskResult(value: unknown): ResultValue<TaskResult, FoundationError> {
	const checked = validateExactShape<TaskResult>(TaskResultSchema, value, "task_result");
	if (!checked.ok) return checked;
	const correlation = requireResultCorrelation(checked.value.provenance, ["sessionId", "laneId", "taskId", "taskResultId"], checked.value.taskResultId);
	if (!correlation.ok) return Result.err(correlation.error);
	return correlation.value.taskId === checked.value.taskId && correlation.value.taskResultId === checked.value.taskResultId ? checked : Result.err(new FoundationError("invalid_correlation", "TaskResult provenance does not match its task identity", { details: { taskResultId: checked.value.taskResultId } }));
}
export function serializeTaskResult(value: TaskResult): string { return serializeExactShape(TaskResultSchema, value, "task_result"); }
export function parseTaskResult(text: string): ResultValue<TaskResult, FoundationError> { return parseExactShape(TaskResultSchema, text, "task_result"); }
export function validateRunReceipt(value: unknown): ResultValue<RunReceipt, FoundationError> {
	const checked = validateExactShape<RunReceipt>(RunReceiptSchema, value, "run_receipt");
	if (!checked.ok) return checked;
	const usage = validateRunReceiptUsage(checked.value.usage);
	if (!usage.ok) return usage;
	if (checked.value.attemptReceiptIds.length === 0 || new Set(checked.value.attemptReceiptIds).size !== checked.value.attemptReceiptIds.length) return Result.err(new FoundationError("run_terminal_authority_invalid", "RunReceipt must reference unique source AttemptReceipts", { details: { runId: checked.value.runId } }));
	if (checked.value.terminalStatus === "completed" && checked.value.taskResultId === undefined) return Result.err(new FoundationError("task_result_terminal_requires_task_result", "A completed RunReceipt requires a TaskResult", { details: { runId: checked.value.runId } }));
	if (checked.value.terminalStatus === "completed" && (checked.value.terminalErrorCode !== undefined || checked.value.terminalError !== undefined)) return Result.err(new FoundationError("run_terminal_authority_invalid", "A completed RunReceipt cannot carry a terminal error", { details: { runId: checked.value.runId } }));
	if (checked.value.terminalStatus !== "completed" && checked.value.terminalError === undefined) return Result.err(new FoundationError("run_terminal_authority_invalid", "A non-completed RunReceipt requires canonical terminal error detail", { details: { runId: checked.value.runId } }));
	if (checked.value.terminalError !== undefined && checked.value.terminalErrorCode !== undefined && checked.value.terminalError.code !== checked.value.terminalErrorCode) return Result.err(new FoundationError("run_terminal_authority_invalid", "RunReceipt terminal error code and detail disagree", { details: { runId: checked.value.runId } }));
	return checked;
}
export function serializeRunReceipt(value: RunReceipt): string {
	const checked = validateRunReceipt(value);
	if (!checked.ok) throw checked.error;
	return serializeExactShape(RunReceiptSchema, checked.value, "run_receipt");
}
export function parseRunReceipt(text: string): ResultValue<RunReceipt, FoundationError> {
	const parsed = parseExactShape<RunReceipt>(RunReceiptSchema, text, "run_receipt");
	return parsed.ok ? validateRunReceipt(parsed.value) : parsed;
}
