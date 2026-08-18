import type { AssistantMessage, DeferredHandle, StopReason } from "@aos-agent/ai";
import { Guard } from "typebox/guard";
import type { AgentMessage, AgentToolCall, ThinkingLevel } from "../types.ts";
import type {
	Entry,
	LaneRecord,
	OperationStartedRecord,
	ProvisionedEntry,
	QueueEnqueuedRecord,
	StepAttemptRecord,
	ToolStartedRecord,
	WriteDeferredRecord,
} from "./session/types.ts";
import type { ExecutionCorrelationV1 } from "./foundation/identity.ts";
import { FOUNDATION_TOOL_RESULT_CUSTOM_TYPE, validateFoundationToolResultEntryV1, type ToolBindingRefV1, type ToolIntentV1, type ToolReceiptV1 } from "./tool-pipeline.ts";

/**
 * Machine-readable category for a contradiction in a lane's durable recovery
 * slice. These indicate states the single-writer record protocol cannot
 * produce, not ordinary operation failures or incomplete-but-recoverable
 * intent/result prefixes. Restore must reject such states rather than repair or
 * continue it; the accompanying error message supplies human-readable detail.
 */
export type RecordLogCorruptionReason =
	| "multiple_open_operations"
	| "non_monotonic_sequence"
	| "duplicate_record_id"
	| "open_operations_mismatch"
	| "unknown_operation"
	| "record_after_finish"
	| "non_consecutive_attempt"
	| "invalid_compaction_reason"
	| "queue_after_abort"
	| "invalid_queue_cancellation"
	| "inconsistent_step"
	| "tool_call_mismatch"
	| "duplicate_tool_invocation"
	| "provisioned_entry_mismatch"
	| "invalid_deferred_handle"
	| "invalid_deferred_fetch";

export class RecordLogCorruption extends Error {
	readonly reason: RecordLogCorruptionReason;

	constructor(reason: RecordLogCorruptionReason, message: string) {
		super(message);
		this.name = "RecordLogCorruption";
		this.reason = reason;
	}
}

export interface RecordLogSlice {
	lane: string;
	openOperations: readonly OperationStartedRecord[];
	records: readonly LaneRecord[];
	/** Operation-owned entries plus entries fetched directly by provisioned or referenced ids. */
	entries: readonly Entry[];
}

export interface EffectiveLaneConfiguration {
	model: { provider: string; modelId: string };
	thinkingLevel: ThinkingLevel;
	activeToolNames: string[];
}

export interface TerminalFailureState {
	entryId: string;
	source: "step" | "deferred_fetch";
	message: AssistantMessage;
}

export interface ToolBatchState {
	assistantEntryId: string;
	calls: {
		toolIndex: number;
		toolCall: AgentToolCall;
		started?: ToolStartedRecord;
		intent?: ToolIntentV1;
		receipt?: ToolReceiptV1;
		resultExists: boolean;
		terminate?: boolean;
	}[];
	truncated: boolean;
	unresolved: boolean;
}

/** Durable redemption prefix for one provider-deferred assistant response. */
export const DEFERRED_FETCH_INTENT_CUSTOM_TYPE = "harness.deferred_fetch.intent";
export const DEFERRED_FETCH_RESULT_CUSTOM_TYPE = "harness.deferred_fetch.result";

export type DeferredFetchResultStatus = "succeeded" | "failed" | "unknown";

export interface DeferredFetchState {
	intent: { entryId: string; runId: string; handle: DeferredHandle; responseEntryId: string };
	result?: {
		entryId: string;
		status: DeferredFetchResultStatus;
		responseEntryId?: string;
		response?: AssistantMessage;
		error?: { code: string; message: string };
	};
}

/** Why a loop must stop before another provider turn is started. */
export type LoopConvergenceReason = "max_iterations" | "duplicate_tool_call" | "dead_loop";

/** Explicit bounds for one provider/tool loop. */
export interface LoopConvergenceOptions {
	/** Maximum number of provider iterations, including the current observation. */
	maxIterations: number;
	/** Number of observations of one tool-call fingerprint allowed across iterations. */
	maxDuplicateToolCalls?: number;
	/** Consecutive observations without a progress token change before stopping. */
	maxNoProgressIterations?: number;
}

/** One provider-loop observation used by {@link advanceLoopConvergence}. */
export interface LoopIterationObservation {
	toolCalls?: readonly Pick<AgentToolCall, "arguments" | "name">[];
	progressToken?: string;
	madeProgress?: boolean;
}

export interface LoopConvergenceDecision {
	stop: boolean;
	iteration: number;
	reason?: LoopConvergenceReason;
	fingerprint?: string;
}

export interface LoopConvergenceState {
	readonly maxIterations: number;
	readonly maxDuplicateToolCalls: number;
	readonly maxNoProgressIterations: number;
	readonly iterations: number;
	readonly toolCallCounts: readonly { fingerprint: string; count: number }[];
	readonly lastProgressToken?: string;
	readonly noProgressIterations: number;
	readonly decision?: LoopConvergenceDecision;
}

/** Durable checkpoint boundary used to decide whether resume may re-enter a step. */
export type ResumeBoundaryStatus =
	| "before_step"
	| "awaiting_checkpoint"
	| "awaiting_tool_results"
	| "deferred"
	| "terminal_failure"
	| "checkpointed"
	| "aborting";

export interface ResumeBoundary {
	operationId: string;
	operationKind: OperationStartedRecord["intent"]["kind"];
	/** Source branch/leaf from which the operation was started. */
	branchId: string | null;
	/** Result/checkpoint identity, even when the result is not durable yet. */
	checkpointId: string | null;
	attempt: number;
	status: ResumeBoundaryStatus;
}

export interface LaneState {
	lane: string;
	leafId: string | null;
	operation: null | {
		id: string;
		kind: "run" | "compaction" | "navigation";
		intent: OperationStartedRecord["intent"];
		aborting: boolean;
		step: null | {
			kind: "assistant" | "compaction" | "branch_summary";
			attempts: number;
			resultEntryId: string;
			compactionReason?: "manual" | "threshold" | "overflow";
		};
		toolBatch: ToolBatchState | null;
		resumeBoundary: ResumeBoundary;
		missingInitialMessages: ProvisionedEntry[];
		pendingSteer: ProvisionedEntry[];
		pendingFollowUp: ProvisionedEntry[];
		pendingWrites: ProvisionedEntry[];
		deferred: DeferredHandle | null;
		deferredFetch: DeferredFetchState | null;
		overflowRecoveryUsed: boolean;
		newestOwn: null | {
			entryId: string;
			type: Entry["type"];
			role?: AgentMessage["role"];
			stopReason?: StopReason;
		};
		targets: { result?: boolean; summary?: boolean };
	};
	pendingNextRun: ProvisionedEntry[];
}

const DEFAULT_MAX_DUPLICATE_TOOL_CALLS = 2;
const DEFAULT_MAX_NO_PROGRESS_ITERATIONS = 3;

function assertPositiveInteger(value: number, name: string): void {
	if (!Number.isInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive integer`);
}

/** Return a deterministic representation for JSON-like tool arguments. */
function stableValue(value: unknown, active: Set<object>): string {
	if (value === null) return "null";
	if (typeof value === "string") return JSON.stringify(value);
	if (typeof value === "number" || typeof value === "boolean") return JSON.stringify(value);
	if (typeof value === "bigint") return `bigint:${value.toString()}`;
	if (typeof value !== "object") return String(value);
	if (active.has(value)) return "[Circular]";
	active.add(value);
	let result: string;
	if (Array.isArray(value)) result = `[${value.map((item) => stableValue(item, active)).join(",")}]`;
	else {
		const entries = Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${stableValue((value as Record<string, unknown>)[key], active)}`);
		result = `{${entries.join(",")}}`;
	}
	active.delete(value);
	return result;
}

type FingerprintToolCall = Pick<AgentToolCall, "arguments" | "name"> & { namespace?: string };

/** Fingerprint a tool call without using its provider-generated id. */
export function fingerprintToolCall(toolCall: FingerprintToolCall): string {
	const namespace = toolCall.namespace === undefined ? "" : `${toolCall.namespace}:`;
	return `${namespace}${toolCall.name}:${stableValue(toolCall.arguments, new Set<object>())}`;
}

/** Create an empty loop guard with explicit maximum iteration bounds. */
export function createLoopConvergenceState(options: LoopConvergenceOptions): LoopConvergenceState {
	assertPositiveInteger(options.maxIterations, "maxIterations");
	const maxDuplicateToolCalls = options.maxDuplicateToolCalls ?? DEFAULT_MAX_DUPLICATE_TOOL_CALLS;
	const maxNoProgressIterations = options.maxNoProgressIterations ?? DEFAULT_MAX_NO_PROGRESS_ITERATIONS;
	assertPositiveInteger(maxDuplicateToolCalls, "maxDuplicateToolCalls");
	assertPositiveInteger(maxNoProgressIterations, "maxNoProgressIterations");
	return {
		maxIterations: options.maxIterations,
		maxDuplicateToolCalls,
		maxNoProgressIterations,
		iterations: 0,
		toolCallCounts: [],
		noProgressIterations: 0,
	};
}

/** Observe one loop iteration and stop before the next one when convergence is unsafe. */
export function advanceLoopConvergence(
	state: LoopConvergenceState,
	observation: LoopIterationObservation,
): { state: LoopConvergenceState; decision: LoopConvergenceDecision } {
	if (state.decision?.stop) return { state, decision: state.decision };
	const iteration = state.iterations + 1;
	const counts = new Map(state.toolCallCounts.map((entry) => [entry.fingerprint, entry.count]));
	let duplicateFingerprint: string | undefined;
	const observedFingerprints = new Set<string>();
	for (const toolCall of observation.toolCalls ?? []) {
		const fingerprint = fingerprintToolCall(toolCall);
		if (observedFingerprints.has(fingerprint)) continue;
		observedFingerprints.add(fingerprint);
		const previousCount = counts.get(fingerprint) ?? 0;
		const count = previousCount + 1;
		counts.set(fingerprint, count);
		if (count >= state.maxDuplicateToolCalls && duplicateFingerprint === undefined) {
			duplicateFingerprint = fingerprint;
		}
	}
	const repeatedProgress =
		observation.progressToken !== undefined && observation.progressToken === state.lastProgressToken;
	const noProgress = observation.madeProgress === false || repeatedProgress;
	const noProgressIterations = noProgress ? state.noProgressIterations + 1 : 0;
	const decision: LoopConvergenceDecision =
		iteration >= state.maxIterations
			? { stop: true, iteration, reason: "max_iterations" }
			: duplicateFingerprint !== undefined
				? { stop: true, iteration, reason: "duplicate_tool_call", fingerprint: duplicateFingerprint }
				: noProgressIterations >= state.maxNoProgressIterations
					? { stop: true, iteration, reason: "dead_loop" }
					: { stop: false, iteration };
	const nextState: LoopConvergenceState = {
		...state,
		iterations: iteration,
		toolCallCounts: [...counts.entries()].map(([fingerprint, count]) => ({ fingerprint, count })),
		...(observation.progressToken === undefined ? {} : { lastProgressToken: observation.progressToken }),
		noProgressIterations,
		...(decision.stop ? { decision } : {}),
	};
	return { state: nextState, decision };
}

export interface LaneReductionInput extends RecordLogSlice {
	/** Session identity used to keep tool facts from another session out of the reduction. */
	sessionId?: string;
	leafId: string | null;
	/** Entries appended by the open operation, oldest first. Empty when idle. */
	ownEntries: readonly Entry[];
	/** Bounded effective-state lookups at the operation anchor or idle leaf, oldest first. */
	configurationEntries: readonly Entry[];
	/** Harness option fallbacks used when no persisted value exists. */
	defaults: EffectiveLaneConfiguration;
	toolIntents?: readonly ToolIntentV1[];
	toolReceipts?: readonly ToolReceiptV1[];
	/** Complete execution identity used to exclude tool facts from another attempt or operation. */
	toolIdentity?: Partial<ExecutionCorrelationV1>;
}

export interface LaneReductionResult {
	laneState: LaneState;
	effectiveConfiguration: EffectiveLaneConfiguration;
	terminalFailure: TerminalFailureState | null;
}

interface AttemptSeries {
	record: StepAttemptRecord;
}

function corrupt(reason: RecordLogCorruptionReason, message: string): never {
	throw new RecordLogCorruption(reason, message);
}

function hasRunId(record: LaneRecord): record is Exclude<LaneRecord, OperationStartedRecord> & { runId: string } {
	return "runId" in record && typeof record.runId === "string";
}

function matchesProvisionedEntry(entry: Entry, target: ProvisionedEntry): boolean {
	const { parentId: _parentId, seq: _seq, timestamp: _timestamp, ...payload } = entry;
	return Guard.IsDeepEqual(payload, target);
}

function validateExactProvisionedEntry(entriesById: ReadonlyMap<string, Entry>, target: ProvisionedEntry): void {
	const entry = entriesById.get(target.id);
	if (entry && !matchesProvisionedEntry(entry, target)) {
		corrupt(
			"provisioned_entry_mismatch",
			`Provisioned entry ${target.id} exists with content different from its intent`,
		);
	}
}

function validateResultEntry(
	entriesById: ReadonlyMap<string, Entry>,
	resultEntryId: string,
	matches: (entry: Entry) => boolean,
	description: string,
): void {
	const entry = entriesById.get(resultEntryId);
	if (entry && !matches(entry)) {
		corrupt(
			"provisioned_entry_mismatch",
			`Provisioned ${description} entry ${resultEntryId} exists with different content`,
		);
	}
}

function validateAttemptReason(record: StepAttemptRecord): void {
	const reason = (record as { compactionReason?: unknown }).compactionReason;
	if (record.step === "compaction") {
		if (reason !== "manual" && reason !== "threshold" && reason !== "overflow") {
			corrupt("invalid_compaction_reason", `Compaction attempt ${record.id} has no valid compaction reason`);
		}
	} else if (reason !== undefined) {
		corrupt("invalid_compaction_reason", `${record.step} attempt ${record.id} has a compaction reason`);
	}
}

function validateAttemptSequence(
	record: StepAttemptRecord,
	previous: AttemptSeries | undefined,
	entriesById: ReadonlyMap<string, Entry>,
): void {
	const previousRecord = previous?.record;
	const previousResult = previousRecord ? entriesById.get(previousRecord.resultEntryId) : undefined;
	const continuesSeries =
		previousRecord !== undefined &&
		previousRecord.step === record.step &&
		(previousResult === undefined || previousResult.seq >= record.seq);
	const expectedAttempt = continuesSeries ? previousRecord.attempt + 1 : 1;
	if (record.attempt !== expectedAttempt) {
		corrupt(
			"non_consecutive_attempt",
			`${record.step} attempt ${record.id} is ${record.attempt}; expected ${expectedAttempt}`,
		);
	}
	if (!continuesSeries || record.step === "assistant" || previousRecord === undefined) return;
	if (record.resultEntryId !== previousRecord.resultEntryId) {
		corrupt("inconsistent_step", `${record.step} attempts disagree on their result entry id`);
	}
	if (record.compactionReason !== previousRecord.compactionReason) {
		corrupt("inconsistent_step", `${record.step} attempts disagree on their compaction reason`);
	}
}

function validateAttemptResult(entriesById: ReadonlyMap<string, Entry>, record: StepAttemptRecord): void {
	switch (record.step) {
		case "assistant":
			validateResultEntry(
				entriesById,
				record.resultEntryId,
				(entry) => entry.type === "message" && entry.message.role === "assistant",
				"assistant result",
			);
			break;
		case "compaction":
			validateResultEntry(
				entriesById,
				record.resultEntryId,
				(entry) => entry.type === "compaction",
				"compaction result",
			);
			break;
		case "branch_summary":
			validateResultEntry(
				entriesById,
				record.resultEntryId,
				(entry) => entry.type === "branch_summary",
				"branch-summary result",
			);
			break;
	}
}

function validateToolStart(
	record: Extract<LaneRecord, { type: "tool_started" }>,
	entriesById: ReadonlyMap<string, Entry>,
	invocations: Set<string>,
): void {
	const invocation = `${record.assistantEntryId}\u0000${record.toolIndex}`;
	if (invocations.has(invocation)) {
		corrupt(
			"duplicate_tool_invocation",
			`Tool invocation ${record.assistantEntryId}:${record.toolIndex} is duplicated`,
		);
	}
	invocations.add(invocation);

	const assistantEntry = entriesById.get(record.assistantEntryId);
	if (!assistantEntry || assistantEntry.type !== "message" || assistantEntry.message.role !== "assistant") {
		corrupt("tool_call_mismatch", `Tool start ${record.id} does not reference an assistant entry`);
	}
	const toolCalls = assistantEntry.message.content.filter((content) => content.type === "toolCall");
	const toolCall = toolCalls[record.toolIndex];
	if (!toolCall || toolCall.id !== record.toolCallId || toolCall.name !== record.toolName) {
		corrupt("tool_call_mismatch", `Tool start ${record.id} does not match its assistant tool-call ordinal`);
	}

	validateResultEntry(
		entriesById,
		record.resultEntryId,
		(entry) => {
			if (entry.type === "message") return entry.message.role === "toolResult" && entry.message.toolCallId === record.toolCallId && entry.message.toolName === record.toolName;
			if (entry.type !== "custom" || entry.customType !== FOUNDATION_TOOL_RESULT_CUSTOM_TYPE) return false;
			const checked = validateFoundationToolResultEntryV1(entry.data);
			return checked.ok && checked.value.runId === record.runId && checked.value.operationId === record.runId && checked.value.toolCallId === record.toolCallId && checked.value.toolName === record.toolName;
		},
		"tool result",
	);
}

function validateDeferredHandles(entries: Iterable<Entry>): void {
	for (const entry of entries) {
		if (
			entry.type === "message" &&
			entry.message.role === "assistant" &&
			entry.message.stopReason === "deferred" &&
			!entry.message.deferred
		) {
			corrupt("invalid_deferred_handle", `Deferred assistant entry ${entry.id} does not carry a handle`);
		}
	}
}

function isJsonValue(value: unknown): boolean {
	if (value === null || typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (Array.isArray(value)) return value.every(isJsonValue);
	if (typeof value !== "object") return false;
	return Object.getPrototypeOf(value) === Object.prototype && Object.values(value).every(isJsonValue);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function parseDeferredHandle(value: unknown): DeferredHandle | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	if (
		typeof record.provider !== "string" || record.provider.length === 0 ||
		typeof record.modelId !== "string" || record.modelId.length === 0 ||
		typeof record.api !== "string" || record.api.length === 0 ||
		typeof record.id !== "string" || record.id.length === 0
	) return undefined;
	if (record.expiresAt !== undefined && (!Number.isSafeInteger(record.expiresAt) || (record.expiresAt as number) < 0)) return undefined;
	if (record.pollAfterMs !== undefined && (!Number.isSafeInteger(record.pollAfterMs) || (record.pollAfterMs as number) < 0)) return undefined;
	if (record.data !== undefined && !isJsonValue(record.data)) return undefined;
	return structuredClone(record) as unknown as DeferredHandle;
}

function parseDeferredFetchIntent(entry: Entry): DeferredFetchState["intent"] | undefined {
	if (entry.type !== "custom" || entry.customType !== DEFERRED_FETCH_INTENT_CUSTOM_TYPE) return undefined;
	const data = entry.data;
	if (typeof data !== "object" || data === null || Array.isArray(data)) corrupt("invalid_deferred_fetch", `Deferred fetch intent ${entry.id} is not an object`);
	const record = data as Record<string, unknown>;
	if (record.schemaVersion !== 1 || record.status !== "pending" || typeof record.runId !== "string" || record.runId.length === 0) {
		corrupt("invalid_deferred_fetch", `Deferred fetch intent ${entry.id} has an invalid prefix`);
	}
	if (typeof record.responseEntryId !== "string" || record.responseEntryId.length === 0) corrupt("invalid_deferred_fetch", `Deferred fetch intent ${entry.id} has no response association`);
	const handle = parseDeferredHandle(record.handle);
	if (!handle) corrupt("invalid_deferred_fetch", `Deferred fetch intent ${entry.id} has an invalid handle`);
	return { entryId: entry.id, runId: record.runId as string, handle, responseEntryId: record.responseEntryId as string };
}

function parseDeferredFetchResult(entry: Entry): DeferredFetchState["result"] | undefined {
	if (entry.type !== "custom" || entry.customType !== DEFERRED_FETCH_RESULT_CUSTOM_TYPE) return undefined;
	const data = entry.data;
	if (typeof data !== "object" || data === null || Array.isArray(data)) corrupt("invalid_deferred_fetch", `Deferred fetch result ${entry.id} is not an object`);
	const record = data as Record<string, unknown>;
	if (record.schemaVersion !== 1 || typeof record.runId !== "string" || record.runId.length === 0) {
		corrupt("invalid_deferred_fetch", `Deferred fetch result ${entry.id} has an invalid prefix`);
	}
	if (record.status !== "succeeded" && record.status !== "failed" && record.status !== "unknown") {
		corrupt("invalid_deferred_fetch", `Deferred fetch result ${entry.id} has an invalid status`);
	}
	if (record.responseEntryId !== undefined && (typeof record.responseEntryId !== "string" || record.responseEntryId.length === 0)) {
		corrupt("invalid_deferred_fetch", `Deferred fetch result ${entry.id} has an invalid response entry id`);
	}
	if (record.error !== undefined) {
		if (typeof record.error !== "object" || record.error === null || Array.isArray(record.error)) corrupt("invalid_deferred_fetch", `Deferred fetch result ${entry.id} has an invalid error`);
		const error = record.error as Record<string, unknown>;
		if (typeof error.code !== "string" || error.code.length === 0 || typeof error.message !== "string" || error.message.length === 0) corrupt("invalid_deferred_fetch", `Deferred fetch result ${entry.id} has an invalid error`);
	}
	if (record.response !== undefined) {
		if (typeof record.response !== "object" || record.response === null || Array.isArray(record.response) || (record.response as Record<string, unknown>).role !== "assistant") {
			corrupt("invalid_deferred_fetch", `Deferred fetch result ${entry.id} has an invalid response`);
		}
	}
	if (record.status === "succeeded" && (record.response === undefined || record.responseEntryId === undefined)) {
		corrupt("invalid_deferred_fetch", `Successful deferred fetch result ${entry.id} is missing its response association`);
	}
	return {
		entryId: entry.id,
		status: record.status as DeferredFetchResultStatus,
		...(record.responseEntryId === undefined ? {} : { responseEntryId: record.responseEntryId as string }),
		...(record.response === undefined ? {} : { response: structuredClone(record.response) as AssistantMessage }),
		...(record.error === undefined ? {} : { error: structuredClone(record.error) as { code: string; message: string } }),
	};
}

function validateDeferredFetchEntries(entries: Iterable<Entry>): void {
	const intents = new Map<string, { entry: Entry; value: DeferredFetchState["intent"] }>();
	const results = new Map<string, { entry: Entry; value: NonNullable<DeferredFetchState["result"]> }>();
	const allEntries = [...entries];
	for (const entry of allEntries) {
		const intent = parseDeferredFetchIntent(entry);
		if (intent) {
			if (intents.has(intent.runId)) corrupt("invalid_deferred_fetch", `Deferred fetch run ${intent.runId} has duplicate intents`);
			intents.set(intent.runId, { entry, value: intent });
		}
		const result = parseDeferredFetchResult(entry);
		if (result) {
			if (entry.type !== "custom") corrupt("invalid_deferred_fetch", `Deferred fetch result ${entry.id} is not a custom entry`);
			const data = entry.data as Record<string, unknown>;
			const runId = data.runId as string;
			if (results.has(runId)) corrupt("invalid_deferred_fetch", `Deferred fetch run ${runId} has duplicate results`);
			results.set(runId, { entry, value: result });
		}
	}
	for (const [runId, result] of results) {
		const intent = intents.get(runId);
		if (!intent || intent.entry.seq >= result.entry.seq) corrupt("invalid_deferred_fetch", `Deferred fetch result ${result.entry.id} has no preceding intent`);
		if (result.value.responseEntryId !== undefined && result.value.responseEntryId !== intent.value.responseEntryId) corrupt("invalid_deferred_fetch", `Deferred fetch result ${result.entry.id} changes its response association`);
		if (result.value.responseEntryId !== undefined) {
			const response = allEntries.find((candidate) => candidate.id === result.value.responseEntryId);
			if (response && (response.type !== "message" || response.message.role !== "assistant")) corrupt("invalid_deferred_fetch", `Deferred fetch result ${result.entry.id} references a non-assistant response`);
		}
	}
}

function deriveDeferredFetchState(operationId: string, entries: readonly Entry[]): DeferredFetchState | null {
	const ordered = bySequence(entries);
	const intentEntry = ordered.find((entry) => {
		const value = parseDeferredFetchIntent(entry);
		return value?.runId === operationId;
	});
	if (!intentEntry) return null;
	const intent = parseDeferredFetchIntent(intentEntry);
	if (!intent) return null;
	const resultEntry = ordered.find((entry) => {
		const data = entry.type === "custom" && entry.customType === DEFERRED_FETCH_RESULT_CUSTOM_TYPE ? asRecord(entry.data) : undefined;
		return data?.runId === operationId;
	});
	const result = resultEntry ? parseDeferredFetchResult(resultEntry) : undefined;
	return { intent, ...(result === undefined ? {} : { result }) };
}

function validateOperationResult(entriesById: ReadonlyMap<string, Entry>, record: OperationStartedRecord): void {
	switch (record.intent.kind) {
		case "run":
			for (const target of record.intent.initialMessages) validateExactProvisionedEntry(entriesById, target);
			break;
		case "compaction":
			validateResultEntry(
				entriesById,
				record.intent.resultEntryId,
				(entry) => entry.type === "compaction",
				"manual compaction",
			);
			break;
		case "navigation":
			if (record.intent.summaryEntryId) {
				validateResultEntry(
					entriesById,
					record.intent.summaryEntryId,
					(entry) => entry.type === "branch_summary",
					"navigation summary",
				);
			}
			break;
	}
}

/** Validates a bounded lane recovery slice without reading or mutating session state. */
export function validateRecordLog(input: RecordLogSlice): void {
	if (input.openOperations.length > 1) {
		corrupt("multiple_open_operations", `Lane ${input.lane} has at least two open operations`);
	}

	const entriesById = new Map(input.entries.map((entry) => [entry.id, entry]));
	validateDeferredHandles(entriesById.values());
	validateDeferredFetchEntries(entriesById.values());
	const starts = new Map<string, OperationStartedRecord>();
	const finishedAt = new Map<string, number>();
	const abortedAt = new Map<string, number>();
	const queueEnqueues = new Map<string, Extract<LaneRecord, { type: "queue_enqueued" }>>();
	const latestAttempt = new Map<string, AttemptSeries>();
	const toolInvocations = new Set<string>();
	const records = input.records;
	let previousSequence = 0;
	const recordIds = new Set<string>();

	for (const record of records) {
		if (!Number.isSafeInteger(record.seq) || record.seq <= previousSequence) {
			corrupt("non_monotonic_sequence", `Record ${record.id} does not follow the lane record sequence`);
		}
		if (recordIds.has(record.id)) corrupt("duplicate_record_id", `Record ${record.id} appears more than once`);
		recordIds.add(record.id);
		previousSequence = record.seq;
		if (record.type === "operation_started") {
			if (starts.has(record.id)) corrupt("duplicate_record_id", `Operation ${record.id} starts more than once`);
			starts.set(record.id, record);
			validateOperationResult(entriesById, record);
			continue;
		}

		if (hasRunId(record)) {
			if (!starts.has(record.runId)) {
				corrupt("unknown_operation", `Record ${record.id} references unknown operation ${record.runId}`);
			}
			const finishSeq = finishedAt.get(record.runId);
			if (finishSeq !== undefined && record.seq > finishSeq) {
				corrupt("record_after_finish", `Record ${record.id} follows the finish of operation ${record.runId}`);
			}
		}

		switch (record.type) {
			case "operation_finished":
				finishedAt.set(record.runId, record.seq);
				break;
			case "abort_requested":
				abortedAt.set(record.runId, record.seq);
				break;
			case "step_attempt":
				validateAttemptReason(record);
				validateAttemptSequence(record, latestAttempt.get(record.runId), entriesById);
				validateAttemptResult(entriesById, record);
				latestAttempt.set(record.runId, { record });
				break;
			case "tool_started":
				validateToolStart(record, entriesById, toolInvocations);
				break;
			case "queue_enqueued":
				if (
					record.queue !== "nextRun" &&
					abortedAt.get(record.runId) !== undefined &&
					record.seq > abortedAt.get(record.runId)!
				) {
					corrupt("queue_after_abort", `${record.queue} item ${record.target.id} was enqueued after abort`);
				}
				queueEnqueues.set(record.target.id, record);
				validateExactProvisionedEntry(entriesById, record.target);
				break;
			case "queue_cancelled": {
				const enqueue = queueEnqueues.get(record.entryId);
				if (
					!enqueue ||
					enqueue.seq >= record.seq ||
					enqueue.runId !== record.runId ||
					entriesById.has(record.entryId)
				) {
					corrupt("invalid_queue_cancellation", `Queue cancellation ${record.id} has no pending matching enqueue`);
				}
				break;
			}
			case "write_deferred":
				validateExactProvisionedEntry(entriesById, record.target);
				break;
			case "usage":
				break;
		}
	}

	const actualOpenOperationIds = new Set(
		[...starts.keys()].filter((operationId) => finishedAt.get(operationId) === undefined),
	);
	const suppliedOpenOperationIds = new Set(input.openOperations.map((operation) => operation.id));
	if (
		actualOpenOperationIds.size !== suppliedOpenOperationIds.size ||
		[...actualOpenOperationIds].some((operationId) => !suppliedOpenOperationIds.has(operationId))
	) {
		corrupt("open_operations_mismatch", `Lane ${input.lane} open operation index disagrees with its records`);
	}
}

function clone<T>(value: T): T {
	return structuredClone(value);
}

function bySequence<T extends { seq: number }>(values: readonly T[]): T[] {
	return [...values].sort((left, right) => left.seq - right.seq);
}

function deriveEffectiveConfiguration(input: LaneReductionInput): EffectiveLaneConfiguration {
	let configuration = clone(input.defaults);
	const entriesById = new Map<string, Entry>();
	for (const entry of [...input.configurationEntries, ...input.ownEntries]) entriesById.set(entry.id, entry);

	for (const entry of bySequence([...entriesById.values()])) {
		switch (entry.type) {
			case "model_change":
				configuration = { ...configuration, model: { provider: entry.provider, modelId: entry.modelId } };
				break;
			case "thinking_level_change":
				configuration = { ...configuration, thinkingLevel: entry.thinkingLevel as ThinkingLevel };
				break;
			case "active_tools_change":
				configuration = { ...configuration, activeToolNames: [...entry.activeToolNames] };
				break;
			case "message":
				if (entry.message.role === "assistant") {
					configuration = {
						...configuration,
						model: { provider: entry.message.provider, modelId: entry.message.model },
					};
				}
				break;
		}
	}
	return configuration;
}

function deriveNewestOwn(
	entry: Entry | undefined,
): NonNullable<NonNullable<LaneState["operation"]>["newestOwn"]> | null {
	if (!entry) return null;
	if (entry.type !== "message") return { entryId: entry.id, type: entry.type };
	if (entry.message.role !== "assistant") {
		return { entryId: entry.id, type: entry.type, role: entry.message.role };
	}
	return {
		entryId: entry.id,
		type: entry.type,
		role: entry.message.role,
		stopReason: entry.message.stopReason,
	};
}

function toolIdentityMatches(
	binding: ToolBindingRefV1,
	identity: Partial<ExecutionCorrelationV1>,
): boolean {
	const expected: Array<[keyof ToolBindingRefV1, string | undefined]> = [
		["sessionId", identity.sessionId],
		["laneId", identity.laneId],
		["runId", identity.runId],
		["operationId", identity.operationId],
		["taskId", identity.taskId],
		["dispatchId", identity.dispatchId],
		["attemptId", identity.attemptId],
		["bindingId", identity.bindingId],
		["bindingEpochId", identity.bindingEpochId],
		["providerId", identity.providerId],
		["agentInstanceId", identity.agentInstanceId],
	];
	for (const [field, expectedValue] of expected) {
		if (expectedValue !== undefined && binding[field] !== expectedValue) return false;
	}
	return true;
}

function deriveToolBatch(
	sessionId: string | undefined,
	laneId: string,
	operationId: string,
	records: readonly LaneRecord[],
	ownEntries: readonly Entry[],
	entriesById: ReadonlyMap<string, Entry>,
	deferredWriteIds: ReadonlySet<string>,
	toolIntents: readonly ToolIntentV1[] = [],
	toolReceipts: readonly ToolReceiptV1[] = [],
	toolIdentity: Partial<ExecutionCorrelationV1> = {},
): ToolBatchState | null {
	const assistantEntry = [...ownEntries]
		.reverse()
		.find(
			(entry) =>
				entry.type === "message" &&
				entry.message.role === "assistant" &&
				entry.message.content.some((content) => content.type === "toolCall"),
		);
	if (!assistantEntry || assistantEntry.type !== "message" || assistantEntry.message.role !== "assistant") return null;

	const toolCalls = assistantEntry.message.content.filter(
		(content): content is AgentToolCall => content.type === "toolCall",
	);
	const identity: Partial<ExecutionCorrelationV1> = {
		...toolIdentity,
		...(toolIdentity.sessionId === undefined && sessionId === undefined ? {} : { sessionId: toolIdentity.sessionId ?? sessionId }),
		laneId,
		runId: toolIdentity.runId ?? operationId,
		operationId: toolIdentity.operationId ?? operationId,
	};
	const starts = new Map<number, ToolStartedRecord>();
	const intents = new Map<string, ToolIntentV1>();
	for (const intent of toolIntents) {
		if (toolIdentityMatches(intent.binding, identity)) intents.set(intent.toolCallId, intent);
	}
	const receipts = new Map<string, ToolReceiptV1>();
	for (const receipt of toolReceipts) {
		if (toolIdentityMatches(receipt.binding, identity)) receipts.set(receipt.toolCallId, receipt);
	}
	for (const record of records) {
		if (
			record.type === "tool_started" &&
			record.runId === operationId &&
			record.assistantEntryId === assistantEntry.id
		) {
			starts.set(record.toolIndex, record);
		}
	}
	const isMatchingToolResultEntry = (entry: Entry | undefined, toolCallId: string, toolName: string, expectedRunId?: string): boolean => {
		if (entry === undefined) return false;
		if (entry.type === "message") {
			return entry.message.role === "toolResult" && entry.message.toolCallId === toolCallId && entry.message.toolName === toolName;
		}
		if (entry.type !== "custom" || entry.customType !== FOUNDATION_TOOL_RESULT_CUSTOM_TYPE) return false;
		const checked = validateFoundationToolResultEntryV1(entry.data);
		return checked.ok && (expectedRunId === undefined || (checked.value.runId === expectedRunId && checked.value.operationId === expectedRunId)) && checked.value.toolCallId === toolCallId && checked.value.toolName === toolName;
	};

	const calls = toolCalls.map((toolCall, toolIndex) => {
		const started = starts.get(toolIndex);
		const startedResult = started && isMatchingToolResultEntry(entriesById.get(started.resultEntryId), toolCall.id, toolCall.name, started.runId)
			? entriesById.get(started.resultEntryId)
			: undefined;
		const blockedResult = ownEntries.find(
			(entry) =>
				entry.seq > assistantEntry.seq &&
				!deferredWriteIds.has(entry.id) &&
				isMatchingToolResultEntry(entry, toolCall.id, toolCall.name),
		);
		const result = startedResult ?? blockedResult;
		return {
			toolIndex,
			toolCall: clone(toolCall),
			...(started ? { started: clone(started) } : {}),
			...(intents.get(toolCall.id) === undefined ? {} : { intent: clone(intents.get(toolCall.id)!) }),
			...(receipts.get(toolCall.id) === undefined ? {} : { receipt: clone(receipts.get(toolCall.id)!) }),
			resultExists: result !== undefined,
			...(result?.type === "message" && result.terminate === true ? { terminate: true } : {}),
		};
	});

	return {
		assistantEntryId: assistantEntry.id,
		calls,
		truncated: assistantEntry.message.stopReason === "length",
		unresolved: calls.some((call) => !call.resultExists),
	};
}

function deriveResumeBoundary(
	started: OperationStartedRecord,
	step: NonNullable<LaneState["operation"]>["step"],
	latestAttempt: StepAttemptRecord | undefined,
	toolBatch: ToolBatchState | null,
	newestOwnEntry: Entry | undefined,
	deferred: DeferredHandle | null,
	terminalFailure: TerminalFailureState | null,
	targets: { result?: boolean; summary?: boolean },
	aborting: boolean,
): ResumeBoundary {
	const checkpointId =
		(step && "resultEntryId" in step ? step.resultEntryId : undefined) ??
		latestAttempt?.resultEntryId ??
		(started.intent.kind === "compaction"
			? started.intent.resultEntryId
			: started.intent.kind === "navigation"
				? (started.intent.summaryEntryId ?? null)
				: (toolBatch?.assistantEntryId ??
					(newestOwnEntry?.type === "message" && newestOwnEntry.message.role === "assistant"
						? newestOwnEntry.id
						: null)));
	const attempt = step && "attempts" in step ? step.attempts : (latestAttempt?.attempt ?? 0);
	let status: ResumeBoundaryStatus = "before_step";
	if (aborting) status = "aborting";
	else if (terminalFailure) status = "terminal_failure";
	else if (deferred) status = "deferred";
	else if (toolBatch?.unresolved) status = "awaiting_tool_results";
	else if (step) status = "awaiting_checkpoint";
	else if (
		(started.intent.kind === "compaction" && targets.result) ||
		(started.intent.kind === "navigation" && targets.summary) ||
		(newestOwnEntry?.type === "message" && newestOwnEntry.message.role === "assistant")
	) {
		status = "checkpointed";
	}
	return {
		operationId: started.id,
		operationKind: started.intent.kind,
		branchId: started.sourceLeafId,
		checkpointId,
		attempt,
		status,
	};
}

/** Purely reconstructs one lane's orchestration state from its bounded recovery inputs. */
export function reduceLaneState(input: LaneReductionInput): LaneReductionResult {
	validateRecordLog(input);

	const records = bySequence(input.records);
	const ownEntries = bySequence(input.ownEntries);
	const entriesById = new Map<string, Entry>();
	for (const entry of [...input.entries, ...ownEntries]) entriesById.set(entry.id, entry);
	const cancelledQueueIds = new Set(
		records.filter((record) => record.type === "queue_cancelled").map((record) => record.entryId),
	);
	const pendingQueueRecords = records.filter(
		(record): record is QueueEnqueuedRecord =>
			record.type === "queue_enqueued" &&
			!entriesById.has(record.target.id) &&
			!cancelledQueueIds.has(record.target.id),
	);
	const started = input.openOperations[0];
	const capturedInitialMessageIds = new Set(
		started?.intent.kind === "run" ? started.intent.initialMessages.map((target) => target.id) : [],
	);
	const pendingNextRun = pendingQueueRecords
		.filter((record) => record.queue === "nextRun" && !capturedInitialMessageIds.has(record.target.id))
		.map((record) => clone(record.target));
	const effectiveConfiguration = deriveEffectiveConfiguration(input);

	if (!started) {
		return {
			laneState: { lane: input.lane, leafId: input.leafId, operation: null, pendingNextRun },
			effectiveConfiguration,
			terminalFailure: null,
		};
	}

	const operationRecords = records.filter((record) =>
		record.type === "operation_started" ? record.id === started.id : "runId" in record && record.runId === started.id,
	);
	const aborting = operationRecords.some((record) => record.type === "abort_requested");
	const pendingSteer = aborting
		? []
		: pendingQueueRecords
				.filter((record) => record.queue === "steer" && record.runId === started.id)
				.map((record) => clone(record.target));
	const pendingFollowUp = aborting
		? []
		: pendingQueueRecords
				.filter((record) => record.queue === "followUp" && record.runId === started.id)
				.map((record) => clone(record.target));
	const pendingWrites = operationRecords
		.filter(
			(record): record is WriteDeferredRecord =>
				record.type === "write_deferred" && !entriesById.has(record.target.id),
		)
		.map((record) => clone(record.target));
	const missingInitialMessages =
		started.intent.kind === "run"
			? started.intent.initialMessages.filter((target) => !entriesById.has(target.id)).map(clone)
			: [];

	const newestAttempt = operationRecords.filter((record) => record.type === "step_attempt").at(-1);
	const step =
		newestAttempt && !entriesById.has(newestAttempt.resultEntryId)
			? {
					kind: newestAttempt.step,
					attempts: newestAttempt.attempt,
					resultEntryId: newestAttempt.resultEntryId,
					...(newestAttempt.step === "compaction" ? { compactionReason: newestAttempt.compactionReason } : {}),
				}
			: null;
	const operationStep = step;

	const consumedInputIds = new Set<string>();
	if (started.intent.kind === "run") {
		for (const target of started.intent.initialMessages) consumedInputIds.add(target.id);
	}
	for (const record of operationRecords) {
		if (record.type === "queue_enqueued" && record.queue !== "nextRun") consumedInputIds.add(record.target.id);
	}
	let newestConsumedInputSequence = Number.NEGATIVE_INFINITY;
	for (const id of consumedInputIds) {
		const entry = entriesById.get(id);
		if (entry?.type === "message") newestConsumedInputSequence = Math.max(newestConsumedInputSequence, entry.seq);
	}
	const overflowRecoveryUsed = operationRecords.some(
		(record) =>
			record.type === "step_attempt" &&
			record.step === "compaction" &&
			record.compactionReason === "overflow" &&
			record.seq > newestConsumedInputSequence,
	);

	// Custom entries include configuration and harness lifecycle markers that
	// are not operation output. They must not hide the last assistant/tool or
	// compaction entry during recovery.
	const newestOwnEntry = [...ownEntries].reverse().find((entry) => entry.type !== "custom");
	const newestOwn = deriveNewestOwn(newestOwnEntry);
	const deferred =
		newestOwnEntry?.type === "message" &&
		newestOwnEntry.message.role === "assistant" &&
		newestOwnEntry.message.stopReason === "deferred" &&
		newestOwnEntry.message.deferred
			? clone(newestOwnEntry.message.deferred)
			: null;
	const targets: { result?: boolean; summary?: boolean } = {};
	if (started.intent.kind === "compaction") {
		targets.result = entriesById.has(started.intent.resultEntryId);
	} else if (started.intent.kind === "navigation" && started.intent.summaryEntryId) {
		targets.summary = entriesById.has(started.intent.summaryEntryId);
	}

	const deferredWriteIds = new Set(
		operationRecords.filter((record) => record.type === "write_deferred").map((record) => record.target.id),
	);
	const deferredFetch = deriveDeferredFetchState(started.id, ownEntries);
	const toolBatch = deriveToolBatch(input.sessionId, input.lane, started.id, operationRecords, ownEntries, entriesById, deferredWriteIds, input.toolIntents, input.toolReceipts, input.toolIdentity);
	let terminalFailure: TerminalFailureState | null = null;
	if (
		newestOwnEntry?.type === "message" &&
		newestOwnEntry.message.role === "assistant" &&
		newestOwnEntry.message.stopReason === "error" &&
		!deferredWriteIds.has(newestOwnEntry.id)
	) {
		const producedByStep = operationRecords.some(
			(record) => record.type === "step_attempt" && record.resultEntryId === newestOwnEntry.id,
		);
		const previousOwnEntry = ownEntries.at(-2);
		const producedByDeferredFetch =
			operationRecords.some(
				(record) =>
					record.type === "usage" && record.cause === "deferred_fetch" && record.entryId === newestOwnEntry.id,
			) ||
			(previousOwnEntry?.type === "message" &&
				previousOwnEntry.message.role === "assistant" &&
				previousOwnEntry.message.stopReason === "deferred");
		if (producedByStep || producedByDeferredFetch) {
			terminalFailure = {
				entryId: newestOwnEntry.id,
				source: producedByStep ? "step" : "deferred_fetch",
				message: clone(newestOwnEntry.message),
			};
		}
	}
	const resumeBoundary = deriveResumeBoundary(
		started,
		operationStep,
		newestAttempt,
		toolBatch,
		newestOwnEntry,
		deferred,
		terminalFailure,
		targets,
		aborting,
	);

	return {
		laneState: {
			lane: input.lane,
			leafId: input.leafId,
			operation: {
				id: started.id,
				kind: started.intent.kind,
				intent: clone(started.intent),
				aborting,
				step,
				toolBatch,
				resumeBoundary,
				missingInitialMessages,
				pendingSteer,
				pendingFollowUp,
				pendingWrites,
				deferred,
				deferredFetch,
				overflowRecoveryUsed,
				newestOwn,
				targets,
			},
			pendingNextRun,
		},
		effectiveConfiguration,
		terminalFailure,
	};
}
