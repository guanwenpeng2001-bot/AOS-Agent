import { Result, type Result as ResultValue } from "../result.ts";
import type { AcceptanceFactV1 } from "./goal.ts";
import { FoundationError, type PublicExecutionErrorV1 } from "./errors.ts";
import { fingerprintFoundationValue, type ExecutionCorrelationV1, type FingerprintV1, type FoundationLineageV1 } from "./identity.ts";
import { ArtifactRefV1Schema, FOUNDATION_SHA256_DIGEST_PATTERN_V1, WorkerReceiptRefV1Schema, type ArtifactRefV1, type WorkerReceiptRefV1 } from "./reference.ts";
import type { AttemptProviderClassV1, TaskEnvelopeV1 } from "./task.ts";
import { SideEffectStateV1Schema, type SideEffectStateV1 } from "./side-effect.ts";
import { Type } from "typebox";
import { ExecutionCorrelationV1Schema, exactShapeIssues, LineageV1Schema, makeExactShapeGuard, parseExactShape, serializeExactShape, validateExactShape } from "./schema.ts";

export type ResultProducerKindV1 = "operation_worker" | "scheduler" | "agent_executor" | "external_connector" | "host";
export interface ResultProvenanceV1 { producerKind: ResultProducerKindV1; providerId: string; producedAt: string; lineage?: FoundationLineageV1; /** Correlation is optional for legacy records but required by provider consumers when an expectation is supplied. */ correlation?: ExecutionCorrelationV1; }
export type ResultStatusV1 = "succeeded" | "failed" | "cancelled" | "suspended";
export interface WorkerReceiptV1 { schemaVersion: 1; workerReceiptId: string; sandboxProviderId: string; operationId: string; taskId?: string; dispatchId?: string; attemptId?: string; status: ResultStatusV1; sideEffectState: SideEffectStateV1; artifacts?: readonly ArtifactRefV1[]; error?: PublicExecutionErrorV1; provenance: ResultProvenanceV1; startedAt: string; completedAt: string; }
export type WorkerReceipt = WorkerReceiptV1;
export interface AttemptReceiptV1 { schemaVersion: 1; attemptReceiptId: string; taskId: string; dispatchId: string; attemptId: string; providerId: string; agentInstanceId?: string; bindingId: string; bindingEpochIds: readonly string[]; status: ResultStatusV1; workerReceiptRefs: readonly WorkerReceiptRefV1[]; artifacts: readonly ArtifactRefV1[]; error?: PublicExecutionErrorV1; provenance: ResultProvenanceV1; sideEffectState: SideEffectStateV1; }
export type AttemptReceipt = AttemptReceiptV1;
export interface ValidationResultV1 { name: string; required: boolean; status: "passed" | "failed" | "skipped" | "pending"; summary?: string; evidenceRefs?: readonly ArtifactRefV1[]; }
export interface ResultValidationV1 { schemaValid: boolean; artifactDigestsValid: boolean; acceptanceVerified: boolean; requiredEvidencePresent: boolean; notes?: readonly string[]; }
export interface TaskResultV1 { schemaVersion: 1; taskResultId: string; taskId: string; sourceAttemptReceiptIds: readonly string[]; status: ResultStatusV1; summary: string; artifacts: readonly ArtifactRefV1[]; diff?: ArtifactRefV1; tests: readonly ValidationResultV1[]; evidence: readonly AcceptanceFactV1[]; error?: PublicExecutionErrorV1; provenance: ResultProvenanceV1; validation: ResultValidationV1; }
export type TaskResult = TaskResultV1;
export type RunTerminalStatusV1 = "completed" | "failed" | "cancelled";
export interface RunReceiptV1 { schemaVersion: 1; runReceiptId: string; runId: string; terminalStatus: RunTerminalStatusV1; taskResultId?: string; attemptReceiptIds: readonly string[]; terminalErrorCode?: string; completedAt: string; }
export type RunReceipt = RunReceiptV1;
export interface HostTerminalGateAuthorityV1 { schemaVersion: 1; type: "host_terminal_gate"; authorityId: string; revision: number; fingerprint: FingerprintV1; }

const provenanceSchema = Type.Object({ producerKind: Type.Union([Type.Literal("operation_worker"), Type.Literal("scheduler"), Type.Literal("agent_executor"), Type.Literal("external_connector"), Type.Literal("host")]), providerId: Type.String({ minLength: 1 }), producedAt: Type.String({ minLength: 1 }), lineage: Type.Optional(LineageV1Schema), correlation: Type.Optional(ExecutionCorrelationV1Schema) }, { additionalProperties: false });
const artifactSchema = ArtifactRefV1Schema;
const publicErrorSchema = Type.Object({ code: Type.String({ minLength: 1 }), message: Type.String({ minLength: 1 }), category: Type.Optional(Type.String()), retryable: Type.Boolean() }, { additionalProperties: false });
export const PublicExecutionErrorV1Schema = publicErrorSchema;
export const AttemptReceiptV1Schema = Type.Object({ schemaVersion: Type.Literal(1), attemptReceiptId: Type.String({ minLength: 1 }), taskId: Type.String({ minLength: 1 }), dispatchId: Type.String({ minLength: 1 }), attemptId: Type.String({ minLength: 1 }), providerId: Type.String({ minLength: 1 }), agentInstanceId: Type.Optional(Type.String({ minLength: 1 })), bindingId: Type.String({ minLength: 1 }), bindingEpochIds: Type.Array(Type.String({ minLength: 1 })), status: Type.Union([Type.Literal("succeeded"), Type.Literal("failed"), Type.Literal("cancelled"), Type.Literal("suspended")]), workerReceiptRefs: Type.Array(WorkerReceiptRefV1Schema), artifacts: Type.Array(artifactSchema), error: Type.Optional(publicErrorSchema), provenance: provenanceSchema, sideEffectState: SideEffectStateV1Schema }, { additionalProperties: false });
export const WorkerReceiptV1Schema = Type.Object({ schemaVersion: Type.Literal(1), workerReceiptId: Type.String({ minLength: 1 }), sandboxProviderId: Type.String({ minLength: 1 }), operationId: Type.String({ minLength: 1 }), taskId: Type.Optional(Type.String({ minLength: 1 })), dispatchId: Type.Optional(Type.String({ minLength: 1 })), attemptId: Type.Optional(Type.String({ minLength: 1 })), status: Type.Union([Type.Literal("succeeded"), Type.Literal("failed"), Type.Literal("cancelled"), Type.Literal("suspended")]), sideEffectState: SideEffectStateV1Schema, artifacts: Type.Optional(Type.Array(artifactSchema)), error: Type.Optional(publicErrorSchema), provenance: provenanceSchema, startedAt: Type.String({ minLength: 1 }), completedAt: Type.String({ minLength: 1 }) }, { additionalProperties: false });
export type AttemptReceiptV1Shape = AttemptReceiptV1; export type WorkerReceiptV1Shape = WorkerReceiptV1;
export const isAttemptReceiptV1Shape = makeExactShapeGuard<AttemptReceiptV1>(AttemptReceiptV1Schema, "attempt_receipt");
export const isWorkerReceiptV1Shape = makeExactShapeGuard<WorkerReceiptV1>(WorkerReceiptV1Schema, "worker_receipt");
function requireResultCorrelation(provenance: ResultProvenanceV1, required: readonly (keyof ExecutionCorrelationV1)[], objectId: string): ResultValue<ExecutionCorrelationV1, FoundationError> {
	const correlation = provenance.correlation;
	if (correlation === undefined || typeof correlation.sessionId !== "string" || correlation.sessionId.length === 0 || typeof correlation.laneId !== "string" || correlation.laneId.length === 0 || !Number.isSafeInteger(correlation.revision) || correlation.revision < 0) return Result.err(new FoundationError("invalid_correlation", "Result provenance requires a complete ExecutionCorrelation", { details: { objectId } }));
	for (const field of required) {
		const value = correlation[field];
		const valid = field === "revision" ? Number.isSafeInteger(value) && (value as number) >= 0 : typeof value === "string" && value.length > 0;
		if (!valid) return Result.err(new FoundationError("invalid_correlation", "Result provenance is missing a required identity field", { details: { objectId, field } }));
	}
	return Result.ok(correlation);
}
export function validateAttemptReceipt(value: unknown, options: { agentProvider?: boolean; providerClass?: AttemptProviderClassV1 } = {}): ResultValue<AttemptReceiptV1, FoundationError> {
	if (!isAttemptReceiptV1Shape(value)) return Result.err(new FoundationError("foundation_schema_invalid_shape", "attempt_receipt failed exact-shape validation", { details: { issues: exactShapeIssues(AttemptReceiptV1Schema, value) } }));
	const receipt = value as AttemptReceiptV1;
	const correlation = requireResultCorrelation(receipt.provenance, ["sessionId", "laneId", "taskId", "dispatchId", "attemptId", "bindingId", "bindingEpochId"], receipt.attemptReceiptId);
	if (!correlation.ok) return Result.err(correlation.error);
	if (correlation.value.taskId !== receipt.taskId || correlation.value.dispatchId !== receipt.dispatchId || correlation.value.attemptId !== receipt.attemptId || correlation.value.bindingId !== receipt.bindingId || receipt.bindingEpochIds.length === 0 || correlation.value.bindingEpochId !== receipt.bindingEpochIds[0]) return Result.err(new FoundationError("invalid_correlation", "AttemptReceipt provenance does not match its immutable execution identity", { details: { attemptReceiptId: receipt.attemptReceiptId } }));
	if (receipt.provenance.providerId !== receipt.providerId) return Result.err(new FoundationError("worker_receipt_invalid_producer", "AttemptReceipt provider identity must match provenance", { details: { attemptReceiptId: receipt.attemptReceiptId } }));
	if (receipt.status === "succeeded" && receipt.sideEffectState !== "none") return Result.err(new FoundationError("side_effect_unknown", "A succeeded AttemptReceipt must prove that no side effect remains unknown", { details: { attemptReceiptId: receipt.attemptReceiptId, sideEffectState: receipt.sideEffectState } }));
	if (options.agentProvider === true && receipt.agentInstanceId === undefined) return Result.err(new FoundationError("agent_instance_required_for_agent_provider", "Agent-class providers require an AgentInstance", { details: { attemptReceiptId: receipt.attemptReceiptId } }));
	if (options.agentProvider === false && receipt.agentInstanceId !== undefined) return Result.err(new FoundationError("agent_instance_forbidden_for_provider", "Non-agent providers cannot carry an AgentInstance", { details: { attemptReceiptId: receipt.attemptReceiptId } }));
	if (receipt.provenance.producerKind === "agent_executor" && receipt.agentInstanceId === undefined) return Result.err(new FoundationError("agent_instance_required_for_agent_provider", "agent_executor receipts require an AgentInstance", { details: { attemptReceiptId: receipt.attemptReceiptId } }));
	if (receipt.provenance.producerKind !== "agent_executor" && receipt.agentInstanceId !== undefined) return Result.err(new FoundationError("agent_instance_forbidden_for_provider", "Non-agent producers cannot carry an AgentInstance", { details: { attemptReceiptId: receipt.attemptReceiptId } }));
	if (options.providerClass === "agent" && receipt.provenance.producerKind !== "agent_executor") return Result.err(new FoundationError("agent_instance_not_agent_provider", "Agent providers must produce agent_executor receipts", { details: { attemptReceiptId: receipt.attemptReceiptId } }));
	if (options.providerClass === "agent" && receipt.agentInstanceId === undefined) return Result.err(new FoundationError("agent_instance_required_for_agent_provider", "Agent-class providers require an AgentInstance", { details: { attemptReceiptId: receipt.attemptReceiptId } }));
	if (options.providerClass !== undefined && options.providerClass !== "agent" && receipt.agentInstanceId !== undefined) return Result.err(new FoundationError("agent_instance_forbidden_for_provider", "Only agent-class executors may carry an AgentInstance", { details: { attemptReceiptId: receipt.attemptReceiptId } }));
	if ((options.providerClass === "scheduler" || options.providerClass === "task_executor") && receipt.provenance.producerKind !== "scheduler") return Result.err(new FoundationError("agent_instance_not_agent_provider", "scheduler/task-executor providers must produce scheduler receipts", { details: { attemptReceiptId: receipt.attemptReceiptId } }));
	if (options.providerClass === "external_connector" && receipt.provenance.producerKind !== "external_connector") return Result.err(new FoundationError("agent_instance_not_agent_provider", "external connectors must produce external_connector receipts", { details: { attemptReceiptId: receipt.attemptReceiptId } }));
	return Result.ok(receipt);
}
export function validateWorkerReceipt(value: unknown): ResultValue<WorkerReceiptV1, FoundationError> {
	if (!isWorkerReceiptV1Shape(value)) return Result.err(new FoundationError("foundation_schema_invalid_shape", "worker_receipt failed exact-shape validation", { details: { issues: exactShapeIssues(WorkerReceiptV1Schema, value) } }));
	const receipt = value as WorkerReceiptV1;
	const correlation = requireResultCorrelation(receipt.provenance, ["sessionId", "laneId"], receipt.workerReceiptId);
	if (!correlation.ok) return Result.err(correlation.error);
	for (const field of ["taskId", "dispatchId", "attemptId"] as const) {
		if (receipt[field] !== undefined && correlation.value[field] !== receipt[field]) return Result.err(new FoundationError("invalid_correlation", "WorkerReceipt provenance does not match its operation identity", { details: { workerReceiptId: receipt.workerReceiptId, field } }));
	}
	if (receipt.provenance.producerKind !== "operation_worker" || receipt.provenance.providerId !== receipt.sandboxProviderId) return Result.err(new FoundationError("worker_receipt_invalid_producer", "WorkerReceipt provenance must identify its operation worker", { details: { workerReceiptId: receipt.workerReceiptId } }));
	if (receipt.status === "succeeded" && receipt.sideEffectState !== "none") return Result.err(new FoundationError("side_effect_unknown", "A succeeded WorkerReceipt must prove that no side effect remains unknown", { details: { workerReceiptId: receipt.workerReceiptId, sideEffectState: receipt.sideEffectState } }));
	return Result.ok(receipt);
}
export interface SettleTaskResultInput { taskResultId: string; task: TaskEnvelopeV1; receipts: readonly AttemptReceiptV1[]; summary: string; artifacts?: readonly ArtifactRefV1[]; diff?: ArtifactRefV1; tests: readonly ValidationResultV1[]; evidence: readonly AcceptanceFactV1[]; producer: ResultProvenanceV1; validation?: ResultValidationV1; }
export function settleTaskResult(input: SettleTaskResultInput): ResultValue<TaskResultV1, FoundationError> {
	if (input.taskResultId.length === 0) return Result.err(new FoundationError("task_result_validation_failed", "TaskResult requires a stable id"));
	if (input.producer.producerKind !== "host") return Result.err(new FoundationError("task_result_validation_failed", "Only the Host settlement gate may produce a TaskResult", { details: { taskResultId: input.taskResultId } }));
	const producerCorrelation = requireResultCorrelation(input.producer, ["sessionId", "laneId", "taskId", "taskResultId"], input.taskResultId);
	if (!producerCorrelation.ok) return Result.err(producerCorrelation.error);
	if (producerCorrelation.value.taskId !== input.task.taskId || producerCorrelation.value.taskResultId !== input.taskResultId) return Result.err(new FoundationError("invalid_correlation", "Host TaskResult provenance does not match its task identity", { details: { taskResultId: input.taskResultId } }));
	if (input.receipts.length === 0) return Result.err(new FoundationError("task_result_no_source_receipts", "Task settlement requires AttemptReceipt sources", { details: { taskResultId: input.taskResultId } }));
	const receiptIds = input.receipts.map((receipt) => receipt.attemptReceiptId);
	if (new Set(receiptIds).size !== receiptIds.length) return Result.err(new FoundationError("task_result_validation_failed", "TaskResult sources must not repeat an AttemptReceipt", { details: { taskResultId: input.taskResultId } }));
	for (const receipt of input.receipts) { const checked = validateAttemptReceipt(receipt); if (!checked.ok) return checked; if (receipt.taskId !== input.task.taskId) return Result.err(new FoundationError("task_result_receipt_task_mismatch", "AttemptReceipt does not belong to the task", { details: { taskResultId: input.taskResultId } })); }
	const status: ResultStatusV1 = input.receipts.some((receipt) => receipt.status === "failed") ? "failed" : input.receipts.every((receipt) => receipt.status === "cancelled") ? "cancelled" : input.receipts.some((receipt) => receipt.status === "suspended") ? "suspended" : "succeeded";
	const artifacts = [...(input.artifacts ?? [])];
	const validArtifactRef = (artifact: unknown): artifact is ArtifactRefV1 => {
		if (artifact === null || typeof artifact !== "object" || Array.isArray(artifact)) return false;
		const record = artifact as Record<string, unknown>;
		if (!Object.keys(record).every((key) => ["schemaVersion", "artifactId", "mediaType", "digest", "producer", "sizeBytes"].includes(key))) return false;
		if (record.schemaVersion !== 1 || typeof record.artifactId !== "string" || record.artifactId.length === 0) return false;
		if (typeof record.mediaType !== "string" || record.mediaType.length === 0) return false;
		if (typeof record.digest !== "string" || !new RegExp(FOUNDATION_SHA256_DIGEST_PATTERN_V1).test(record.digest)) return false;
		if (record.producer !== undefined && typeof record.producer !== "string") return false;
		return record.sizeBytes === undefined || typeof record.sizeBytes === "number" && Number.isInteger(record.sizeBytes) && record.sizeBytes >= 0;
	};
	const validArtifacts = artifacts.every(validArtifactRef) && (input.diff === undefined || validArtifactRef(input.diff));
	const expectedOutputs = Array.isArray(input.task.expectedOutputs) ? input.task.expectedOutputs : undefined;
	const expectedOutputsValid = expectedOutputs?.every(validArtifactRef);
	const expectedOutputsPresent = expectedOutputsValid === true && expectedOutputs.every((expected) => artifacts.some((actual) => actual.artifactId === expected.artifactId && actual.digest === expected.digest));
	const requiredTests = input.tests.filter((test) => test.required);
	const testsValid = input.tests.length > 0 && requiredTests.length > 0 && requiredTests.every((test) => test.status === "passed");
	const requiredCriteria = Array.isArray(input.task.acceptanceCriteria) ? input.task.acceptanceCriteria.filter((criterion) => criterion.required) : [];
	const validTest = (test: ValidationResultV1): boolean => typeof test.name === "string" && test.name.length > 0 && typeof test.required === "boolean" && ["passed", "failed", "skipped", "pending"].includes(test.status) && (test.evidenceRefs === undefined || test.evidenceRefs.every(validArtifactRef));
	const validEvidence = (fact: AcceptanceFactV1): boolean => fact.schemaVersion === 1 && typeof fact.factId === "string" && fact.factId.length > 0 && typeof fact.criterionId === "string" && fact.criterionId.length > 0 && ["satisfied", "unsatisfied", "pending"].includes(fact.outcome) && typeof fact.recordedAt === "string" && fact.recordedAt.length > 0 && (fact.evidenceRefs === undefined || fact.evidenceRefs.every(validArtifactRef));
	const evidenceValid = input.evidence.every(validEvidence) && requiredCriteria.every((criterion) => input.evidence.some((fact) => { const evidenceRefs = fact.evidenceRefs; return fact.criterionId === criterion.criterionId && fact.outcome === "satisfied" && evidenceRefs !== undefined && evidenceRefs.length > 0 && evidenceRefs.every(validArtifactRef); }));
	const validation = { schemaValid: validArtifacts && input.tests.every(validTest) && input.evidence.every(validEvidence), artifactDigestsValid: validArtifacts && artifacts.every(validArtifactRef), acceptanceVerified: evidenceValid, requiredEvidencePresent: evidenceValid };
	if (status === "succeeded" && (!expectedOutputsPresent || !expectedOutputsValid || !validArtifacts || !testsValid || !evidenceValid || !validation.schemaValid || input.validation !== undefined && Object.values(input.validation).some((value) => typeof value === "boolean" && !value))) return Result.err(new FoundationError("task_result_validation_failed", "Succeeded TaskResult failed required output, test, evidence, or validation checks", { details: { taskResultId: input.taskResultId, expectedOutputsPresent: expectedOutputsPresent === true, testsValid, evidenceValid, artifactDigestsValid: validArtifacts } }));
	if (status === "succeeded" && !evidenceValid) return Result.err(new FoundationError("task_result_acceptance_unverified", "Required acceptance criteria are not satisfied", { details: { taskResultId: input.taskResultId, unverifiedCriterionIds: requiredCriteria.filter((criterion) => !input.evidence.some((fact) => fact.criterionId === criterion.criterionId && fact.outcome === "satisfied")).map((criterion) => criterion.criterionId) } }));
	return Result.ok({ schemaVersion: 1, taskResultId: input.taskResultId, taskId: input.task.taskId, sourceAttemptReceiptIds: input.receipts.map((receipt) => receipt.attemptReceiptId), status, summary: input.summary, artifacts, ...(input.diff === undefined ? {} : { diff: input.diff }), tests: [...input.tests], evidence: [...input.evidence], provenance: input.producer, validation });
}
export const HostTerminalGateAuthorityV1Schema = Type.Object({ schemaVersion: Type.Literal(1), type: Type.Literal("host_terminal_gate"), authorityId: Type.String({ minLength: 1 }), revision: Type.Integer({ minimum: 0 }), fingerprint: Type.Object({ algorithm: Type.Literal("sha256"), value: Type.String({ minLength: 1 }) }, { additionalProperties: false }) }, { additionalProperties: false });
export function createHostTerminalGateAuthorityV1(authorityId: string, revision = 1): HostTerminalGateAuthorityV1 { const base = { schemaVersion: 1 as const, type: "host_terminal_gate" as const, authorityId, revision }; return { ...base, fingerprint: fingerprintFoundationValue(base) }; }
export function validateHostTerminalGateAuthorityV1(value: unknown): ResultValue<HostTerminalGateAuthorityV1, FoundationError> {
	const checked = validateExactShape<HostTerminalGateAuthorityV1>(HostTerminalGateAuthorityV1Schema, value, "host_terminal_gate_authority");
	if (!checked.ok) return checked;
	const { fingerprint, ...base } = checked.value;
	return fingerprint.value === fingerprintFoundationValue(base).value ? checked : Result.err(new FoundationError("run_terminal_authority_invalid", "Host terminal-gate fingerprint does not match its authority", { details: { authorityId: checked.value.authorityId } }));
}
export function serializeHostTerminalGateAuthorityV1(value: HostTerminalGateAuthorityV1): string { return serializeExactShape(HostTerminalGateAuthorityV1Schema, value, "host_terminal_gate_authority"); }
export function parseHostTerminalGateAuthorityV1(text: string): ResultValue<HostTerminalGateAuthorityV1, FoundationError> { return parseExactShape(HostTerminalGateAuthorityV1Schema, text, "host_terminal_gate_authority"); }
export interface FinalizeRunReceiptInput { runReceiptId: string; runId: string; terminalStatus: RunTerminalStatusV1; authority: HostTerminalGateAuthorityV1; taskResult?: TaskResultV1; attemptReceiptIds: readonly string[]; terminalErrorCode?: string; completedAt?: string; }
export function finalizeRunReceipt(input: FinalizeRunReceiptInput): ResultValue<RunReceiptV1, FoundationError> {
	if (input.runReceiptId.length === 0 || input.runId.length === 0) return Result.err(new FoundationError("run_terminal_authority_invalid", "Run receipt finalization requires stable run and receipt ids", { details: { runId: input.runId } }));
	if (input.authority === undefined) return Result.err(new FoundationError("run_terminal_authority_required", "Run receipt finalization requires an explicit Host terminal-gate authority", { details: { runId: input.runId } }));
	const authority = validateHostTerminalGateAuthorityV1(input.authority);
	if (!authority.ok) return Result.err(new FoundationError("run_terminal_authority_invalid", "Run receipt finalization requires a valid Host terminal-gate authority", { details: { runId: input.runId } }));
	if (input.terminalStatus === "completed" && input.taskResult === undefined) return Result.err(new FoundationError("task_result_terminal_requires_task_result", "A completed run requires a TaskResult", { details: { runId: input.runId } }));
	if (input.taskResult !== undefined) {
		const taskResult = validateTaskResultV1(input.taskResult);
		if (!taskResult.ok || taskResult.value.provenance.producerKind !== "host") return Result.err(new FoundationError("task_result_validation_failed", "Run terminal gate requires an exact host TaskResult", { details: { runId: input.runId } }));
		if (input.terminalStatus === "completed" && taskResult.value.status !== "succeeded") return Result.err(new FoundationError("task_result_terminal_requires_task_result", "Completed run requires a succeeded TaskResult", { details: { runId: input.runId } }));
	}
	if (input.attemptReceiptIds.length === 0) return Result.err(new FoundationError("task_result_no_source_receipts", "Run receipt requires source AttemptReceipt ids", { details: { runId: input.runId } }));
	if (input.attemptReceiptIds.some((id) => id.length === 0) || new Set(input.attemptReceiptIds).size !== input.attemptReceiptIds.length) return Result.err(new FoundationError("task_result_validation_failed", "Run receipt source AttemptReceipt ids must be unique and non-empty", { details: { runId: input.runId } }));
	if (input.taskResult?.sourceAttemptReceiptIds.some((id) => !input.attemptReceiptIds.includes(id))) return Result.err(new FoundationError("task_result_validation_failed", "Run receipt sources must include every TaskResult source receipt", { details: { runId: input.runId } }));
	return Result.ok({ schemaVersion: 1, runReceiptId: input.runReceiptId, runId: input.runId, terminalStatus: input.terminalStatus, attemptReceiptIds: [...input.attemptReceiptIds], ...(input.taskResult === undefined ? {} : { taskResultId: input.taskResult.taskResultId }), ...(input.terminalErrorCode === undefined ? {} : { terminalErrorCode: input.terminalErrorCode }), completedAt: input.completedAt ?? new Date().toISOString() });
}

const validationSchema = Type.Object({ name: Type.String({ minLength: 1 }), required: Type.Boolean(), status: Type.Union([Type.Literal("passed"), Type.Literal("failed"), Type.Literal("skipped"), Type.Literal("pending")]), summary: Type.Optional(Type.String()), evidenceRefs: Type.Optional(Type.Array(ArtifactRefV1Schema)) }, { additionalProperties: false });
const acceptanceFactSchema = Type.Object({ schemaVersion: Type.Literal(1), factId: Type.String({ minLength: 1 }), criterionId: Type.String({ minLength: 1 }), outcome: Type.Union([Type.Literal("satisfied"), Type.Literal("unsatisfied"), Type.Literal("pending")]), evidenceRefs: Type.Optional(Type.Array(artifactSchema)), recordedAt: Type.String({ minLength: 1 }), recordedBy: Type.Optional(Type.String({ minLength: 1 })) }, { additionalProperties: false });
export const TaskResultV1Schema = Type.Object({ schemaVersion: Type.Literal(1), taskResultId: Type.String({ minLength: 1 }), taskId: Type.String({ minLength: 1 }), sourceAttemptReceiptIds: Type.Array(Type.String({ minLength: 1 })), status: Type.Union([Type.Literal("succeeded"), Type.Literal("failed"), Type.Literal("cancelled"), Type.Literal("suspended")]), summary: Type.String(), artifacts: Type.Array(ArtifactRefV1Schema), diff: Type.Optional(ArtifactRefV1Schema), tests: Type.Array(validationSchema), evidence: Type.Array(acceptanceFactSchema), error: Type.Optional(publicErrorSchema), provenance: provenanceSchema, validation: Type.Object({ schemaValid: Type.Boolean(), artifactDigestsValid: Type.Boolean(), acceptanceVerified: Type.Boolean(), requiredEvidencePresent: Type.Boolean(), notes: Type.Optional(Type.Array(Type.String())) }, { additionalProperties: false }) }, { additionalProperties: false });
export const RunReceiptV1Schema = Type.Object({ schemaVersion: Type.Literal(1), runReceiptId: Type.String({ minLength: 1 }), runId: Type.String({ minLength: 1 }), terminalStatus: Type.Union([Type.Literal("completed"), Type.Literal("failed"), Type.Literal("cancelled")]), taskResultId: Type.Optional(Type.String({ minLength: 1 })), attemptReceiptIds: Type.Array(Type.String({ minLength: 1 })), terminalErrorCode: Type.Optional(Type.String({ minLength: 1 })), completedAt: Type.String({ minLength: 1 }) }, { additionalProperties: false });
export function validateWorkerReceiptV1(value: unknown): ResultValue<WorkerReceiptV1, FoundationError> { return validateWorkerReceipt(value); }
export function validatePublicExecutionErrorV1(value: unknown): ResultValue<PublicExecutionErrorV1, FoundationError> { return validateExactShape<PublicExecutionErrorV1>(PublicExecutionErrorV1Schema, value, "public_execution_error"); }
export function serializePublicExecutionErrorV1(value: PublicExecutionErrorV1): string { return serializeExactShape(PublicExecutionErrorV1Schema, value, "public_execution_error"); }
export function parsePublicExecutionErrorV1(text: string): ResultValue<PublicExecutionErrorV1, FoundationError> { return parseExactShape(PublicExecutionErrorV1Schema, text, "public_execution_error"); }
export function serializeWorkerReceipt(value: WorkerReceiptV1): string { return serializeExactShape(WorkerReceiptV1Schema, value, "worker_receipt"); }
export function parseWorkerReceipt(text: string): ResultValue<WorkerReceiptV1, FoundationError> { return parseExactShape(WorkerReceiptV1Schema, text, "worker_receipt"); }
export function serializeAttemptReceiptV1(value: AttemptReceiptV1): string { return serializeExactShape(AttemptReceiptV1Schema, value, "attempt_receipt"); }
export function parseAttemptReceiptV1(text: string): ResultValue<AttemptReceiptV1, FoundationError> { return parseExactShape(AttemptReceiptV1Schema, text, "attempt_receipt"); }
export function validateTaskResultV1(value: unknown): ResultValue<TaskResultV1, FoundationError> {
	const checked = validateExactShape<TaskResultV1>(TaskResultV1Schema, value, "task_result");
	if (!checked.ok) return checked;
	const correlation = requireResultCorrelation(checked.value.provenance, ["sessionId", "laneId", "taskId", "taskResultId"], checked.value.taskResultId);
	if (!correlation.ok) return Result.err(correlation.error);
	return correlation.value.taskId === checked.value.taskId && correlation.value.taskResultId === checked.value.taskResultId ? checked : Result.err(new FoundationError("invalid_correlation", "TaskResult provenance does not match its task identity", { details: { taskResultId: checked.value.taskResultId } }));
}
export function serializeTaskResultV1(value: TaskResultV1): string { return serializeExactShape(TaskResultV1Schema, value, "task_result"); }
export function parseTaskResultV1(text: string): ResultValue<TaskResultV1, FoundationError> { return parseExactShape(TaskResultV1Schema, text, "task_result"); }
export function validateRunReceiptV1(value: unknown): ResultValue<RunReceiptV1, FoundationError> { return validateExactShape<RunReceiptV1>(RunReceiptV1Schema, value, "run_receipt"); }
export function serializeRunReceiptV1(value: RunReceiptV1): string { return serializeExactShape(RunReceiptV1Schema, value, "run_receipt"); }
export function parseRunReceiptV1(text: string): ResultValue<RunReceiptV1, FoundationError> { return parseExactShape(RunReceiptV1Schema, text, "run_receipt"); }
export const validateAttemptReceiptV1 = validateAttemptReceipt;
export const serializeAttemptReceipt = serializeAttemptReceiptV1;
export const parseAttemptReceipt = parseAttemptReceiptV1;
export const validateTaskResult = validateTaskResultV1;
export const serializeTaskResult = serializeTaskResultV1;
export const parseTaskResult = parseTaskResultV1;
export const validateRunReceipt = validateRunReceiptV1;
export const serializeRunReceipt = serializeRunReceiptV1;
export const parseRunReceipt = parseRunReceiptV1;
