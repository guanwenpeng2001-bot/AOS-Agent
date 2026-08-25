import { canonicalFoundationJson, type AgentMessage, type Entry, type LaneRecord } from "@aos-agent/agent-core";
import type { Usage } from "@aos-agent/ai";
import { parseFoundationMutation } from "../../../../agent/src/harness/session/durable/codec.ts";
import type { FoundationRecord } from "../../../../agent/src/harness/session/durable/types.ts";
import type { SessionEntry } from "../session-manager.ts";
import { PrivateMigrationError } from "./session-entry.ts";

export type ReservedFoundationCompatibilityKind = "entry" | "record" | "lane" | "name" | "label" | "durable";

const RESERVED_TYPES = new Map<string, ReservedFoundationCompatibilityKind>([
	["__aos.foundation.entry.v1", "entry"],
	["__aos.foundation.record.v1", "record"],
	["__aos.foundation.lane.v1", "lane"],
	["__aos.foundation.fact.v1", "name"],
	["__aos.foundation.durable.v1", "durable"],
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
	const allowed = new Set([...required, ...optional]);
	return required.every((key) => Object.hasOwn(value, key)) && Object.keys(value).every((key) => allowed.has(key));
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function assertCanonical(value: unknown, label: string): void {
	try {
		canonicalFoundationJson(value);
	} catch {
		throw new PrivateMigrationError(`${label} is not canonical JSON`);
	}
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isUsage(value: unknown): value is Usage {
	if (
		!isRecord(value) ||
		!hasExactKeys(
			value,
			["input", "output", "cacheRead", "cacheWrite", "totalTokens", "cost"],
			["cacheWrite1h", "reasoning"],
		) ||
		!["input", "output", "cacheRead", "cacheWrite", "totalTokens"].every((key) => isNonNegativeNumber(value[key])) ||
		(value.cacheWrite1h !== undefined && !isNonNegativeNumber(value.cacheWrite1h)) ||
		(value.reasoning !== undefined && !isNonNegativeNumber(value.reasoning)) ||
		!isRecord(value.cost) ||
		!hasExactKeys(value.cost, ["input", "output", "cacheRead", "cacheWrite", "total"]) ||
		!["input", "output", "cacheRead", "cacheWrite", "total"].every((key) => isNonNegativeNumber((value.cost as Record<string, unknown>)[key]))
	) {
		return false;
	}
	return true;
}

function isTextContent(value: unknown): boolean {
	return (
		isRecord(value) &&
		hasExactKeys(value, ["type", "text"], ["textSignature"]) &&
		value.type === "text" &&
		typeof value.text === "string" &&
		(value.textSignature === undefined || typeof value.textSignature === "string")
	);
}

function isImageContent(value: unknown): boolean {
	return (
		isRecord(value) &&
		hasExactKeys(value, ["type", "data", "mimeType"]) &&
		value.type === "image" &&
		typeof value.data === "string" &&
		typeof value.mimeType === "string"
	);
}

function isUserContent(value: unknown): boolean {
	return typeof value === "string" || (Array.isArray(value) && value.every((item) => isTextContent(item) || isImageContent(item)));
}

function isThinkingContent(value: unknown): boolean {
	return (
		isRecord(value) &&
		hasExactKeys(value, ["type", "thinking"], ["thinkingSignature", "redacted"]) &&
		value.type === "thinking" &&
		typeof value.thinking === "string" &&
		(value.thinkingSignature === undefined || typeof value.thinkingSignature === "string") &&
		(value.redacted === undefined || typeof value.redacted === "boolean")
	);
}

function isToolCall(value: unknown): boolean {
	return (
		isRecord(value) &&
		hasExactKeys(value, ["type", "id", "name", "arguments"], ["thoughtSignature", "namespace"]) &&
		value.type === "toolCall" &&
		typeof value.id === "string" &&
		typeof value.name === "string" &&
		isRecord(value.arguments) &&
		(value.thoughtSignature === undefined || typeof value.thoughtSignature === "string") &&
		(value.namespace === undefined || typeof value.namespace === "string")
	);
}

function isDiagnosticError(value: unknown): boolean {
	return (
		isRecord(value) &&
		hasExactKeys(value, ["message"], ["name", "stack", "code"]) &&
		typeof value.message === "string" &&
		(value.name === undefined || typeof value.name === "string") &&
		(value.stack === undefined || typeof value.stack === "string") &&
		(value.code === undefined || typeof value.code === "string" || typeof value.code === "number")
	);
}

function isAssistantDiagnostic(value: unknown): boolean {
	return (
		isRecord(value) &&
		hasExactKeys(value, ["type", "timestamp"], ["error", "details"]) &&
		typeof value.type === "string" &&
		isNonNegativeNumber(value.timestamp) &&
		(value.error === undefined || isDiagnosticError(value.error)) &&
		(value.details === undefined || isRecord(value.details))
	);
}

function isDeferredHandle(value: unknown): boolean {
	return (
		isRecord(value) &&
		hasExactKeys(value, ["provider", "modelId", "api", "id"], ["expiresAt", "pollAfterMs", "data"]) &&
		typeof value.provider === "string" &&
		typeof value.modelId === "string" &&
		typeof value.api === "string" &&
		typeof value.id === "string" &&
		(value.expiresAt === undefined || isNonNegativeNumber(value.expiresAt)) &&
		(value.pollAfterMs === undefined || isNonNegativeNumber(value.pollAfterMs))
	);
}

function isAgentMessage(value: unknown): value is AgentMessage {
	if (!isRecord(value) || typeof value.role !== "string") return false;
	if (value.role === "user") {
		return hasExactKeys(value, ["role", "content", "timestamp"]) && isUserContent(value.content) && isNonNegativeNumber(value.timestamp);
	}
	if (value.role === "assistant") {
		return (
			hasExactKeys(
				value,
				["role", "content", "api", "provider", "model", "usage", "stopReason", "timestamp"],
				["responseModel", "responseId", "diagnostics", "deferred", "errorMessage", "rawStopReason", "endTurn"],
			) &&
			Array.isArray(value.content) &&
			value.content.every((item) => isTextContent(item) || isThinkingContent(item) || isToolCall(item)) &&
			typeof value.api === "string" &&
			typeof value.provider === "string" &&
			typeof value.model === "string" &&
			isUsage(value.usage) &&
			(value.stopReason === "pending" ||
				value.stopReason === "stop" ||
				value.stopReason === "length" ||
				value.stopReason === "toolUse" ||
				value.stopReason === "error" ||
				value.stopReason === "aborted" ||
				value.stopReason === "deferred") &&
			isNonNegativeNumber(value.timestamp) &&
			(value.responseModel === undefined || typeof value.responseModel === "string") &&
			(value.responseId === undefined || typeof value.responseId === "string") &&
			(value.diagnostics === undefined ||
				(Array.isArray(value.diagnostics) && value.diagnostics.every(isAssistantDiagnostic))) &&
			(value.deferred === undefined || isDeferredHandle(value.deferred)) &&
			(value.errorMessage === undefined || typeof value.errorMessage === "string") &&
			(value.rawStopReason === undefined || typeof value.rawStopReason === "string") &&
			(value.endTurn === undefined || typeof value.endTurn === "boolean")
		);
	}
	if (value.role === "toolResult") {
		return (
			hasExactKeys(
				value,
				["role", "toolCallId", "toolName", "content", "isError", "timestamp"],
				["details", "usage", "addedToolNames"],
			) &&
			typeof value.toolCallId === "string" &&
			typeof value.toolName === "string" &&
			Array.isArray(value.content) &&
			value.content.every((item) => isTextContent(item) || isImageContent(item)) &&
			typeof value.isError === "boolean" &&
			isNonNegativeNumber(value.timestamp) &&
			(value.usage === undefined || isUsage(value.usage)) &&
			(value.addedToolNames === undefined || isStringArray(value.addedToolNames))
		);
	}
	if (value.role === "bashExecution") {
		return (
			hasExactKeys(
				value,
				["role", "command", "output", "cancelled", "truncated", "timestamp"],
				["exitCode", "fullOutputPath", "excludeFromContext"],
			) &&
			typeof value.command === "string" &&
			typeof value.output === "string" &&
			(value.exitCode === undefined || typeof value.exitCode === "number") &&
			typeof value.cancelled === "boolean" &&
			typeof value.truncated === "boolean" &&
			(value.fullOutputPath === undefined || typeof value.fullOutputPath === "string") &&
			isNonNegativeNumber(value.timestamp) &&
			(value.excludeFromContext === undefined || typeof value.excludeFromContext === "boolean")
		);
	}
	if (value.role === "custom") {
		return (
			hasExactKeys(value, ["role", "customType", "content", "display", "timestamp"], ["details"]) &&
			typeof value.customType === "string" &&
			isUserContent(value.content) &&
			typeof value.display === "boolean" &&
			isNonNegativeNumber(value.timestamp)
		);
	}
	if (value.role === "branchSummary") {
		return (
			hasExactKeys(value, ["role", "summary", "fromId", "timestamp"]) &&
			typeof value.summary === "string" &&
			typeof value.fromId === "string" &&
			isNonNegativeNumber(value.timestamp)
		);
	}
	if (value.role === "compactionSummary") {
		return (
			hasExactKeys(value, ["role", "summary", "tokensBefore", "timestamp"]) &&
			typeof value.summary === "string" &&
			isNonNegativeNumber(value.tokensBefore) &&
			isNonNegativeNumber(value.timestamp)
		);
	}
	return false;
}

function entryKeys(type: string, persisted: boolean): { required: string[]; optional: string[] } | undefined {
	const base = persisted ? ["type", "id", "seq", "parentId", "timestamp"] : ["type", "id"];
	switch (type) {
		case "message":
			return { required: [...base, "message"], optional: ["terminate"] };
		case "model_change":
			return { required: [...base, "provider", "modelId"], optional: [] };
		case "thinking_level_change":
			return { required: [...base, "thinkingLevel"], optional: [] };
		case "active_tools_change":
			return { required: [...base, "activeToolNames"], optional: [] };
		case "compaction":
			return {
				required: [...base, "summary", "retainedTail", "tokensBefore"],
				optional: ["firstKeptEntryId", "details", "usage", "fromExtension"],
			};
		case "branch_summary":
			return { required: [...base, "fromId", "summary"], optional: ["details", "usage", "fromExtension"] };
		case "custom":
			return { required: [...base, "customType"], optional: ["data"] };
		default:
			return undefined;
	}
}

function isCurrentEntry(value: unknown, persisted: boolean): value is Entry {
	if (!isRecord(value) || typeof value.type !== "string") return false;
	const keys = entryKeys(value.type, persisted);
	if (keys === undefined || !hasExactKeys(value, keys.required, keys.optional) || !isNonEmptyString(value.id)) return false;
	if (
		persisted &&
		(!isPositiveInteger(value.seq) ||
			(value.parentId !== null && typeof value.parentId !== "string") ||
			!isNonNegativeInteger(value.timestamp))
	) {
		return false;
	}
	switch (value.type) {
		case "message":
			return isAgentMessage(value.message) && (value.terminate === undefined || value.terminate === true);
		case "model_change":
			return typeof value.provider === "string" && typeof value.modelId === "string";
		case "thinking_level_change":
			return typeof value.thinkingLevel === "string";
		case "active_tools_change":
			return isStringArray(value.activeToolNames);
		case "compaction":
			return (
				typeof value.summary === "string" &&
				Array.isArray(value.retainedTail) &&
				value.retainedTail.every(isAgentMessage) &&
				(value.firstKeptEntryId === undefined || typeof value.firstKeptEntryId === "string") &&
				isNonNegativeNumber(value.tokensBefore) &&
				(value.usage === undefined || isUsage(value.usage)) &&
				(value.fromExtension === undefined || typeof value.fromExtension === "boolean")
			);
		case "branch_summary":
			return (
				typeof value.fromId === "string" &&
				typeof value.summary === "string" &&
				(value.usage === undefined || isUsage(value.usage)) &&
				(value.fromExtension === undefined || typeof value.fromExtension === "boolean")
			);
		case "custom":
			return typeof value.customType === "string";
	}
	return false;
}

function isCorrelation(value: unknown): boolean {
	if (!isRecord(value)) return false;
	const optional = [
		"roleId",
		"roleRevisionId",
		"modelProfileId",
		"modelProfileRevisionId",
		"bindingId",
		"bindingEpochId",
		"agentInstanceId",
		"goalId",
		"planId",
		"stageId",
		"taskId",
		"dispatchId",
		"operationId",
		"attemptId",
		"attemptReceiptId",
		"taskResultId",
		"runReceiptId",
		"runId",
		"providerId",
		"toolCallId",
		"turnId",
		"stepId",
		"parentId",
		"ancestorIds",
		"fencingToken",
	];
	if (!hasExactKeys(value, ["sessionId", "laneId", "revision"], optional)) return false;
	if (!isNonEmptyString(value.sessionId) || !isNonEmptyString(value.laneId) || !isNonNegativeInteger(value.revision)) return false;
	for (const key of optional) {
		if (key === "ancestorIds") {
			if (value[key] !== undefined && !isStringArray(value[key])) return false;
		} else if (value[key] !== undefined && typeof value[key] !== "string") return false;
	}
	return true;
}

function isOperationIntent(value: unknown): boolean {
	if (!isRecord(value) || typeof value.kind !== "string") return false;
	if (value.kind === "run") {
		return (
			hasExactKeys(value, ["kind", "originalPrompt", "initialMessages"], ["continuation", "systemPromptOverride", "resumeData"]) &&
			Array.isArray(value.originalPrompt) &&
			value.originalPrompt.every(isAgentMessage) &&
			Array.isArray(value.initialMessages) &&
			value.initialMessages.every((entry) => isCurrentEntry(entry, false)) &&
			(value.continuation === undefined || typeof value.continuation === "boolean") &&
			(value.systemPromptOverride === undefined || typeof value.systemPromptOverride === "string") &&
			(value.resumeData === undefined || isRecord(value.resumeData))
		);
	}
	if (value.kind === "compaction") {
		return (
			hasExactKeys(value, ["kind", "resultEntryId"], ["customInstructions", "reason", "willRetry"]) &&
			typeof value.resultEntryId === "string" &&
			(value.customInstructions === undefined || typeof value.customInstructions === "string") &&
			(value.reason === undefined || value.reason === "manual" || value.reason === "threshold" || value.reason === "overflow") &&
			(value.willRetry === undefined || typeof value.willRetry === "boolean")
		);
	}
	if (value.kind === "navigation") {
		return (
			hasExactKeys(
				value,
				["kind", "targetId", "summarize"],
				["customInstructions", "replaceInstructions", "label", "summaryEntryId"],
			) &&
			(value.targetId === null || typeof value.targetId === "string") &&
			typeof value.summarize === "boolean" &&
			(value.customInstructions === undefined || typeof value.customInstructions === "string") &&
			(value.replaceInstructions === undefined || typeof value.replaceInstructions === "boolean") &&
			(value.label === undefined || typeof value.label === "string") &&
			(value.summaryEntryId === undefined || typeof value.summaryEntryId === "string")
		);
	}
	return false;
}

function recordBaseValid(value: Record<string, unknown>): boolean {
	return (
		isNonEmptyString(value.id) &&
		isPositiveInteger(value.seq) &&
		isNonEmptyString(value.lane) &&
		isNonNegativeInteger(value.timestamp) &&
		(value.correlation === undefined || isCorrelation(value.correlation))
	);
}

function hasRecordKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
	return hasExactKeys(value, ["type", "id", "seq", "lane", "timestamp", ...required], ["correlation", ...optional]);
}

function isCurrentLaneRecord(value: unknown): value is LaneRecord {
	if (!isRecord(value) || typeof value.type !== "string" || !recordBaseValid(value)) return false;
	switch (value.type) {
		case "operation_started":
			return hasRecordKeys(value, ["sourceLeafId", "intent"]) &&
				(value.sourceLeafId === null || typeof value.sourceLeafId === "string") && isOperationIntent(value.intent);
		case "abort_requested":
			return hasRecordKeys(value, ["runId"]) && typeof value.runId === "string";
		case "operation_finished":
			return (
				hasRecordKeys(value, ["runId", "outcome"], ["error"]) &&
				typeof value.runId === "string" &&
				(value.outcome === "completed" || value.outcome === "aborted" || value.outcome === "failed" || value.outcome === "declined") &&
				(value.error === undefined ||
					(isRecord(value.error) &&
						hasExactKeys(value.error, ["code", "message"]) &&
						typeof value.error.code === "string" &&
						typeof value.error.message === "string"))
			);
		case "step_attempt":
			return (
				hasRecordKeys(value, ["runId", "step", "attempt", "resultEntryId"], ["compactionReason"]) &&
				typeof value.runId === "string" &&
				(value.step === "assistant" || value.step === "branch_summary" || value.step === "compaction") &&
				isNonNegativeInteger(value.attempt) &&
				typeof value.resultEntryId === "string" &&
				(value.step === "compaction"
					? value.compactionReason === "manual" || value.compactionReason === "threshold" || value.compactionReason === "overflow"
					: value.compactionReason === undefined)
			);
		case "tool_started":
			return (
				hasRecordKeys(value, ["runId", "assistantEntryId", "toolIndex", "toolCallId", "toolName", "effectiveArgs", "resultEntryId", "replay"]) &&
				typeof value.runId === "string" &&
				typeof value.assistantEntryId === "string" &&
				isNonNegativeInteger(value.toolIndex) &&
				typeof value.toolCallId === "string" &&
				typeof value.toolName === "string" &&
				isRecord(value.effectiveArgs) &&
				typeof value.resultEntryId === "string" &&
				(value.replay === "never" || value.replay === "safe")
			);
		case "queue_enqueued":
			return (
				hasRecordKeys(value, ["queue", "target"], ["runId"]) &&
				(value.queue === "steer" || value.queue === "followUp" || value.queue === "nextRun") &&
				(value.queue === "nextRun" ? value.runId === undefined : typeof value.runId === "string") &&
				isCurrentEntry(value.target, false)
			);
		case "queue_cancelled":
			return hasRecordKeys(value, ["entryId"], ["runId"]) &&
				typeof value.entryId === "string" && (value.runId === undefined || typeof value.runId === "string");
		case "write_deferred":
			return hasRecordKeys(value, ["runId", "target"]) &&
				typeof value.runId === "string" && isCurrentEntry(value.target, false);
		case "usage": {
			if (!hasRecordKeys(value, ["usage", "cause"], ["runId", "entryId", "attempt", "stopReason", "toolCallId", "details"]) || !isUsage(value.usage)) return false;
			if (value.cause === "assistant" || value.cause === "compaction" || value.cause === "branch_summary" || value.cause === "deferred_fetch") {
				return typeof value.runId === "string" && typeof value.entryId === "string" && isNonNegativeInteger(value.attempt) &&
					(value.stopReason === "stop" || value.stopReason === "length" || value.stopReason === "toolUse" || value.stopReason === "error" || value.stopReason === "aborted" || value.stopReason === "deferred") &&
					value.toolCallId === undefined && value.details === undefined;
			}
			if (value.cause === "tool") {
				return typeof value.runId === "string" && typeof value.entryId === "string" && typeof value.toolCallId === "string" &&
					value.attempt === undefined && value.stopReason === undefined && value.details === undefined;
			}
			if (value.cause === "hook") {
				return typeof value.runId === "string" && typeof value.entryId === "string" && value.attempt === undefined &&
					value.stopReason === undefined && value.toolCallId === undefined && value.details === undefined;
			}
			return value.cause === "adjustment" &&
				(value.runId === undefined || typeof value.runId === "string") &&
				(value.entryId === undefined || typeof value.entryId === "string") &&
				value.attempt === undefined && value.stopReason === undefined && value.toolCallId === undefined;
		}
		default:
			return false;
	}
}

export function decodeCurrentSessionEntry(value: unknown): SessionEntry {
	assertCanonical(value, "Migrated Session entry");
	if (!isRecord(value) || typeof value.type !== "string") {
		throw new PrivateMigrationError("Migrated Session entry is invalid");
	}
	const base = ["type", "id", "parentId", "timestamp"];
	if (
		!isNonEmptyString(value.id) ||
		(value.parentId !== null && typeof value.parentId !== "string") ||
		typeof value.timestamp !== "string"
	) {
		throw new PrivateMigrationError(`Migrated Session ${value.type} entry has invalid identity fields`);
	}
	let valid = false;
	switch (value.type) {
		case "message":
			valid = hasExactKeys(value, [...base, "message"]) && isAgentMessage(value.message);
			break;
		case "thinking_level_change":
			valid = hasExactKeys(value, [...base, "thinkingLevel"]) && typeof value.thinkingLevel === "string";
			break;
		case "model_change":
			valid = hasExactKeys(value, [...base, "provider", "modelId"]) && typeof value.provider === "string" && typeof value.modelId === "string";
			break;
		case "compaction":
			valid = hasExactKeys(value, [...base, "summary", "firstKeptEntryId", "tokensBefore"], ["details", "usage", "fromHook"]) &&
				typeof value.summary === "string" && typeof value.firstKeptEntryId === "string" && isNonNegativeNumber(value.tokensBefore) &&
				(value.usage === undefined || isUsage(value.usage)) && (value.fromHook === undefined || typeof value.fromHook === "boolean");
			break;
		case "branch_summary":
			valid = hasExactKeys(value, [...base, "fromId", "summary"], ["details", "usage", "fromHook"]) &&
				typeof value.fromId === "string" && typeof value.summary === "string" &&
				(value.usage === undefined || isUsage(value.usage)) && (value.fromHook === undefined || typeof value.fromHook === "boolean");
			break;
		case "custom":
			valid = hasExactKeys(value, [...base, "customType"], ["data"]) && typeof value.customType === "string";
			break;
		case "custom_message":
			valid = hasExactKeys(value, [...base, "customType", "content", "display"], ["details"]) &&
				typeof value.customType === "string" && isUserContent(value.content) && typeof value.display === "boolean";
			break;
		case "label":
			valid = hasExactKeys(value, [...base, "targetId"], ["label"]) && typeof value.targetId === "string" &&
				(value.label === undefined || typeof value.label === "string");
			break;
		case "session_info":
			valid = hasExactKeys(value, base, ["name"]) && (value.name === undefined || typeof value.name === "string");
			break;
	}
	if (!valid) throw new PrivateMigrationError(`Migrated Session ${value.type} entry has an invalid exact shape`);
	return structuredClone(value) as unknown as SessionEntry;
}

export function decodeReservedFoundationCompatibilityWrapper(
	customType: string,
	value: unknown,
): { readonly kind: ReservedFoundationCompatibilityKind; readonly value: unknown } {
	const expected = RESERVED_TYPES.get(customType);
	if (expected === undefined) throw new PrivateMigrationError(`Unknown historical Foundation compatibility type ${customType}`);
	assertCanonical(value, "Historical Foundation compatibility wrapper");
	if (!isRecord(value) || value.schemaVersion !== 1 || typeof value.kind !== "string") {
		throw new PrivateMigrationError(`Historical Foundation compatibility wrapper ${customType} is invalid`);
	}
	let kind = expected;
	if (expected === "entry") {
		if (!hasExactKeys(value, ["schemaVersion", "kind", "entry"]) || value.kind !== "entry" || !isCurrentEntry(value.entry, true)) {
			throw new PrivateMigrationError("Historical Foundation entry wrapper has an invalid exact shape");
		}
	} else if (expected === "record") {
		if (!hasExactKeys(value, ["schemaVersion", "kind", "record"]) || value.kind !== "record" || !isCurrentLaneRecord(value.record)) {
			throw new PrivateMigrationError("Historical Foundation record wrapper has an invalid exact shape");
		}
	} else if (expected === "lane") {
		if (!hasExactKeys(value, ["schemaVersion", "kind", "lane", "leafId"]) || value.kind !== "lane" ||
			!isNonEmptyString(value.lane) || (value.leafId !== null && typeof value.leafId !== "string")) {
			throw new PrivateMigrationError("Historical Foundation lane wrapper has an invalid exact shape");
		}
	} else if (expected === "name") {
		if (value.kind === "name") {
			if (!hasExactKeys(value, ["schemaVersion", "kind"], ["name"]) || (value.name !== undefined && typeof value.name !== "string")) {
				throw new PrivateMigrationError("Historical Foundation name wrapper has an invalid exact shape");
			}
		} else {
			if (!hasExactKeys(value, ["schemaVersion", "kind", "targetId"], ["label"]) || value.kind !== "label" ||
				typeof value.targetId !== "string" || (value.label !== undefined && typeof value.label !== "string")) {
				throw new PrivateMigrationError("Historical Foundation label wrapper has an invalid exact shape");
			}
			kind = "label";
		}
	} else {
		if (!hasExactKeys(value, ["schemaVersion", "kind", "record"]) || value.kind !== "durable" || !isRecord(value.record)) {
			throw new PrivateMigrationError("Historical Foundation durable wrapper has an invalid exact shape");
		}
		let decoded: FoundationRecord | undefined;
		try {
			const parsed = parseFoundationMutation(canonicalFoundationJson({ kind: "foundation", schemaVersion: 1, record: value.record }));
			if (parsed.ok) decoded = parsed.value;
		} catch {
			decoded = undefined;
		}
		if (
			decoded?.kind === "retention" &&
			(!isRecord(decoded.policy) || !hasExactKeys(decoded.policy, ["schemaVersion", "cutSequence"], ["reason"]))
		) {
			decoded = undefined;
		}
		if (decoded === undefined) throw new PrivateMigrationError("Historical Foundation durable record is invalid");
	}
	return { kind, value: structuredClone(value) };
}
