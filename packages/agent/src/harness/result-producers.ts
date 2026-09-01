import {
	canonicalFoundationJson,
	sha256HexValue,
	type ExecutionCorrelation,
} from "./foundation/identity.ts";
import type { FoundationJsonValue } from "./foundation/event-catalog.ts";
import { FoundationError, redactText } from "./foundation/errors.ts";
import { validateArtifactRef, type ArtifactRef } from "./foundation/reference.ts";
import type { ValidationResult } from "./foundation/results.ts";
import type { AttemptReceipt } from "./foundation/results.ts";
import type { SideEffectState } from "./foundation/side-effect.ts";
import type { SessionArtifactStore } from "./artifacts.ts";
import type { Session } from "./session/session.ts";
import type { StepAttemptRecord, ToolStartedRecord } from "./session/types.ts";
import {
	projectToolReceiptExecutionSemantics,
	validateAndVerifyToolReceipt,
	type ToolReceipt,
	type ToolReceiptOutcome,
} from "./tool-pipeline.ts";

export const TASK_RESULT_SUMMARY_MAX_LENGTH = 4_096;
const VALIDATION_COMMAND_MAX_LENGTH = 512;
const VALIDATION_COMMAND_PATTERN = /(?:^|(?:&&|\|\||;|\n)\s*)(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:check|lint|test|typecheck)\b|(?:npx\s+)?(?:vitest|jest|eslint|tsc|biome)\b|(?:\.\/)?test\.sh\b|pytest\b|python(?:3)?\s+-m\s+pytest\b|cargo\s+test\b|go\s+test\b|dotnet\s+test\b|mvn(?:w)?\s+(?:[^;&|\n]+\s+)?test\b|gradle(?:w)?\s+(?:[^;&|\n]+\s+)?test\b|ruff\s+check\b)/i;

export interface DurableTaskResultToolSource {
	readonly objectType: string;
	readonly objectId: string;
	readonly revision: number;
	readonly digest: string;
}

/**
 * A tool result admitted by a durable-record reader. Callers must not create
 * these from assistant text or other model-authored result claims.
 */
export interface DurableTaskResultToolRecord {
	readonly toolCallId: string;
	readonly toolName: string;
	readonly arguments: FoundationJsonValue;
	readonly outcome: ToolReceiptOutcome;
	readonly sideEffectState: SideEffectState;
	readonly artifacts: readonly ArtifactRef[];
	readonly result?: ToolReceipt["result"];
	readonly source: DurableTaskResultToolSource;
}

export interface FileChangeArtifactWrite {
	readonly content: Uint8Array;
	readonly name: string;
	readonly mediaType: string;
	readonly producer: string;
	readonly clientRequestId: string;
}

export interface TaskResultProducerInput {
	readonly summary?: string;
	readonly finalAssistantText?: string;
	readonly artifacts?: readonly ArtifactRef[];
	readonly tests?: readonly ValidationResult[];
	readonly durableTools?: readonly DurableTaskResultToolRecord[];
	readonly attemptReceipt?: Pick<AttemptReceipt, "providerId" | "status" | "artifacts" | "error">;
	readonly writeArtifact?: (input: FileChangeArtifactWrite) => Promise<ArtifactRef>;
}

export interface TaskResultProducerOutput {
	readonly summary: string;
	readonly artifacts: readonly ArtifactRef[];
	readonly tests: readonly ValidationResult[];
}

function boundedRedactedText(value: string, maxLength: number): string {
	const redacted = redactText(value).trim();
	if (redacted.length <= maxLength) return redacted;
	return `${redacted.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: undefined;
}

export function isValidationCommand(value: unknown): value is string {
	return typeof value === "string" && value.trim().length > 0 && VALIDATION_COMMAND_PATTERN.test(value);
}

function addArtifact(target: Map<string, ArtifactRef>, artifact: ArtifactRef): void {
	const checked = validateArtifactRef(artifact);
	if (!checked.ok) throw new FoundationError("task_result_validation_failed", "Durable result producer returned an invalid ArtifactRef");
	const prior = target.get(checked.value.artifactId);
	if (prior !== undefined && canonicalFoundationJson(prior) !== canonicalFoundationJson(checked.value)) {
		throw new FoundationError("session_ledger_conflict", "Durable result producers disagree about one artifact identity");
	}
	target.set(checked.value.artifactId, checked.value);
}

function fileChangeContent(record: DurableTaskResultToolRecord): { readonly bytes: Uint8Array; readonly mediaType: string } | undefined {
	const args = recordValue(record.arguments);
	if (record.toolName === "write") {
		const content = args?.content;
		return typeof content === "string"
			? { bytes: new TextEncoder().encode(content), mediaType: "text/plain" }
			: undefined;
	}
	if (record.toolName !== "edit") return undefined;
	const details = recordValue(record.result?.details);
	const patch = details?.patch;
	return typeof patch === "string" && patch.length > 0
		? { bytes: new TextEncoder().encode(patch), mediaType: "text/x-diff" }
		: undefined;
}

function validationResult(record: DurableTaskResultToolRecord): ValidationResult | undefined {
	if (record.toolName !== "bash") return undefined;
	const command = recordValue(record.arguments)?.command;
	if (!isValidationCommand(command)) return undefined;
	const sourceCommand = boundedRedactedText(command, VALIDATION_COMMAND_MAX_LENGTH);
	return {
		name: sourceCommand,
		required: true,
		status: record.outcome === "succeeded" && record.sideEffectState === "none" ? "passed" : "failed",
		summary: `Tool receipt ${record.source.objectId}; source command: ${sourceCommand}`,
	};
}

function producedSummary(input: TaskResultProducerInput, artifactCount: number, testCount: number): string {
	for (const candidate of [input.summary, input.finalAssistantText]) {
		if (candidate === undefined) continue;
		const bounded = boundedRedactedText(candidate, TASK_RESULT_SUMMARY_MAX_LENGTH);
		if (bounded.length > 0) return bounded;
	}
	if (input.attemptReceipt !== undefined) {
		const provider = boundedRedactedText(input.attemptReceipt.providerId, 256);
		const error = input.attemptReceipt.error?.message === undefined
			? ""
			: ` ${boundedRedactedText(input.attemptReceipt.error.message, 1_024)}`;
		return boundedRedactedText(
			`${provider} ${input.attemptReceipt.status} with ${artifactCount} durable artifact(s) and ${testCount} validation result(s).${error}`,
			TASK_RESULT_SUMMARY_MAX_LENGTH,
		);
	}
	return boundedRedactedText(
		`Execution recorded ${artifactCount} durable artifact(s) and ${testCount} validation result(s).`,
		TASK_RESULT_SUMMARY_MAX_LENGTH,
	);
}

async function validationEvidence(
	record: DurableTaskResultToolRecord,
	writeArtifact: TaskResultProducerInput["writeArtifact"],
): Promise<ArtifactRef | undefined> {
	if (writeArtifact === undefined) return undefined;
	const command = recordValue(record.arguments)?.command;
	if (typeof command !== "string") return undefined;
	const result = record.result?.content.map((item) => item.type === "text"
		? { type: "text", text: boundedRedactedText(item.text, 8_192) }
		: { type: "artifact", artifactId: item.artifact.artifactId, digest: item.artifact.digest });
	const content = canonicalFoundationJson({
		schemaVersion: 1,
		toolReceiptId: record.source.objectId,
		toolReceiptDigest: record.source.digest,
		command: boundedRedactedText(command, VALIDATION_COMMAND_MAX_LENGTH),
		outcome: record.outcome,
		sideEffectState: record.sideEffectState,
		...(result === undefined ? {} : { result }),
	});
	return writeArtifact({
		content: new TextEncoder().encode(content),
		name: `validation-${record.toolCallId}.json`,
		mediaType: "application/json",
		producer: `tool-receipt:${record.source.digest.slice(0, 32)}`,
		clientRequestId: `task-result-validation:${record.source.objectId}`,
	});
}

export async function aggregateTaskResultProducers(input: TaskResultProducerInput): Promise<TaskResultProducerOutput> {
	const artifacts = new Map<string, ArtifactRef>();
	for (const artifact of input.artifacts ?? []) addArtifact(artifacts, artifact);
	const tests = [...(input.tests ?? [])];
	for (const record of input.durableTools ?? []) {
		for (const artifact of record.artifacts) addArtifact(artifacts, artifact);
		const validation = validationResult(record);
		if (validation !== undefined) {
			const evidence = await validationEvidence(record, input.writeArtifact);
			if (evidence !== undefined) {
				addArtifact(artifacts, evidence);
				tests.push({ ...validation, evidenceRefs: [evidence] });
			} else {
				tests.push(validation);
			}
		}
		if (
			input.writeArtifact === undefined ||
			record.outcome !== "succeeded" ||
			record.sideEffectState !== "none"
		) continue;
		const content = fileChangeContent(record);
		if (content === undefined) continue;
		const expectedId = sha256HexValue(content.bytes);
		const stored = await input.writeArtifact({
			content: content.bytes,
			name: `file-change-${record.toolCallId}`,
			mediaType: content.mediaType,
			producer: `tool-receipt:${record.source.digest.slice(0, 32)}`,
			clientRequestId: `task-result-file-change:${record.source.objectId}`,
		});
		const checked = validateArtifactRef(stored);
		if (
			!checked.ok ||
			checked.value.artifactId !== expectedId ||
			checked.value.digest !== `sha256:${expectedId}` ||
			(checked.value.sizeBytes !== undefined && checked.value.sizeBytes !== content.bytes.byteLength)
		) {
			throw new FoundationError("task_result_validation_failed", "File-change artifact failed digest verification");
		}
		addArtifact(artifacts, checked.value);
	}
	return {
		summary: producedSummary(input, artifacts.size, tests.length),
		artifacts: [...artifacts.values()],
		tests,
	};
}

export async function writeTaskResultArtifact(
	store: SessionArtifactStore,
	input: FileChangeArtifactWrite,
): Promise<ArtifactRef> {
	const stored = await store.put(input.content, {
		name: input.name,
		mediaType: input.mediaType,
		producer: input.producer,
		clientRequestId: input.clientRequestId,
		retention: { policy: "task" },
	});
	return {
		schemaVersion: 1,
		artifactId: stored.artifactId,
		mediaType: stored.mediaType,
		digest: stored.digest,
		...(stored.producer === undefined ? {} : { producer: stored.producer }),
		sizeBytes: stored.sizeBytes,
	};
}

export async function loadDurableFinalAssistantText(
	session: Session,
	input: { readonly laneId: string; readonly runId: string },
): Promise<string | undefined> {
	const steps = (await session.findRecords({
		lane: input.laneId,
		runId: input.runId,
		type: "step_attempt",
		order: "oldestFirst",
	})).filter((record): record is StepAttemptRecord => record.type === "step_attempt" && record.step === "assistant");
	for (const step of [...steps].reverse()) {
		const entry = await session.getEntry(step.resultEntryId);
		if (entry?.type !== "message" || entry.message.role !== "assistant") continue;
		const text = entry.message.content
			.filter((item) => item.type === "text")
			.map((item) => item.text)
			.join("\n")
			.trim();
		if (text.length > 0) return text;
	}
	return undefined;
}

function correlationMismatch(
	actual: ExecutionCorrelation,
	expected: ExecutionCorrelation | undefined,
): string | undefined {
	if (expected === undefined) return undefined;
	for (const field of [
		"sessionId",
		"laneId",
		"runId",
		"operationId",
		"taskId",
		"dispatchId",
		"bindingId",
		"bindingEpochId",
		"providerId",
		"agentInstanceId",
	] as const) {
		const value = expected[field];
		if (value !== undefined && actual[field] !== value) return field;
	}
	return undefined;
}

function receiptRecordMismatch(
	receipt: ToolReceipt,
	recordCorrelation: ExecutionCorrelation,
	expectedCorrelation: ExecutionCorrelation | undefined,
): string | undefined {
	const binding = receipt.binding;
	for (const [field, actual, expected] of [
		["toolCallId", receipt.toolCallId, recordCorrelation.toolCallId],
		["sessionId", binding.sessionId, recordCorrelation.sessionId],
		["laneId", binding.laneId, recordCorrelation.laneId],
		["runId", binding.runId, recordCorrelation.runId],
		["operationId", binding.operationId, recordCorrelation.operationId],
		["taskId", binding.taskId, recordCorrelation.taskId],
		["dispatchId", binding.dispatchId, recordCorrelation.dispatchId],
		["attemptId", binding.attemptId, recordCorrelation.attemptId],
		["bindingId", binding.bindingId, recordCorrelation.bindingId],
		["bindingEpochId", binding.bindingEpochId, recordCorrelation.bindingEpochId],
		["providerId", binding.providerId, recordCorrelation.providerId],
		["agentInstanceId", binding.agentInstanceId, recordCorrelation.agentInstanceId],
	] as const) {
		if (actual !== expected) return field;
	}
	const mismatch = correlationMismatch(recordCorrelation, expectedCorrelation);
	return mismatch === undefined ? undefined : `settlement.${mismatch}`;
}

function uniqueToolStarts(starts: readonly ToolStartedRecord[]): Map<string, ToolStartedRecord> {
	const byCallId = new Map<string, ToolStartedRecord>();
	for (const start of starts) {
		const prior = byCallId.get(start.toolCallId);
		if (
			prior !== undefined &&
			canonicalFoundationJson({
				toolCallId: prior.toolCallId,
				toolName: prior.toolName,
				effectiveArgs: prior.effectiveArgs,
			}) !== canonicalFoundationJson({
				toolCallId: start.toolCallId,
				toolName: start.toolName,
				effectiveArgs: start.effectiveArgs,
			})
		) {
			throw new FoundationError("session_ledger_conflict", "Durable tool starts conflict for one tool call");
		}
		byCallId.set(start.toolCallId, prior ?? start);
	}
	return byCallId;
}

export async function loadDurableTaskResultToolRecords(
	session: Session,
	input: {
		readonly laneId: string;
		readonly runId: string;
		readonly correlation?: ExecutionCorrelation;
	},
): Promise<readonly DurableTaskResultToolRecord[]> {
	const starts = uniqueToolStarts(await session.findRecords({
		lane: input.laneId,
		runId: input.runId,
		type: "tool_started",
		order: "oldestFirst",
	}));
	if (starts.size === 0) return [];
	const metadata = await session.getMetadata();
	const facts = await session.findFoundationRecords({
		kind: "fact",
		objectType: "tool_receipt",
		includePruned: true,
		order: "oldestFirst",
		correlation: {
			sessionId: metadata.id,
			laneId: input.laneId,
			runId: input.runId,
			operationId: input.runId,
		},
	});
	const receipts = new Map<string, { readonly receipt: ToolReceipt; readonly objectId: string; readonly revision: number }>();
	const conflictedToolCallIds = new Set<string>();
	for (const fact of facts) {
		if (fact.kind !== "fact") continue;
		const checked = validateAndVerifyToolReceipt(fact.payload);
		if (!checked.ok || fact.objectId !== checked.value.toolReceiptId) {
			throw new FoundationError("task_result_validation_failed", "Durable TaskResult tool receipt failed validation");
		}
		const start = starts.get(checked.value.toolCallId);
		const correlationMismatch = receiptRecordMismatch(checked.value, fact.correlation, input.correlation);
		if (
			start === undefined ||
			start.toolName !== checked.value.toolName ||
			correlationMismatch !== undefined
		) {
			throw new FoundationError("invalid_correlation", `Durable TaskResult tool receipt does not match its tool start (${correlationMismatch ?? "identity"})`);
		}
		const prior = receipts.get(checked.value.toolCallId);
		if (
			prior !== undefined &&
			projectToolReceiptExecutionSemantics(prior.receipt) !== projectToolReceiptExecutionSemantics(checked.value)
		) {
			receipts.delete(checked.value.toolCallId);
			conflictedToolCallIds.add(checked.value.toolCallId);
			continue;
		}
		if (conflictedToolCallIds.has(checked.value.toolCallId)) continue;
		if (prior === undefined || fact.objectId.localeCompare(prior.objectId) < 0) {
			receipts.set(checked.value.toolCallId, {
				receipt: checked.value,
				objectId: fact.objectId,
				revision: fact.revision,
			});
		}
	}
	return [...starts.values()].flatMap((start) => {
		const durable = receipts.get(start.toolCallId);
		if (durable === undefined) return [];
		return [{
			toolCallId: start.toolCallId,
			toolName: start.toolName,
			arguments: structuredClone(start.effectiveArgs) as FoundationJsonValue,
			outcome: durable.receipt.outcome,
			sideEffectState: durable.receipt.sideEffectState,
			artifacts: [...(durable.receipt.artifacts ?? [])],
			...(durable.receipt.result === undefined ? {} : { result: durable.receipt.result }),
			source: {
				objectType: "tool_receipt",
				objectId: durable.objectId,
				revision: durable.revision,
				digest: durable.receipt.digest.value,
			},
		} satisfies DurableTaskResultToolRecord];
	});
}
