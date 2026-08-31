import type {
	Api,
	AssistantMessage,
	AssistantMessageEventStream,
	Context,
	DeferredHandle,
	ImageContent,
	Message,
	Model,
	Models,
	RetryPolicy,
	SimpleStreamOptions,
	ToolResultMessage,
	Usage,
} from "@aos-agent/ai";
import { createAssistantMessageEventStream, isContextOverflow, isRecoverableLength } from "@aos-agent/ai";
import { runAgentLoopContinue } from "../agent-loop.ts";
import type { AfterToolCallResult, AgentContext, AgentEvent, AgentLoopConfig, AgentMessage, AgentTool, AgentToolCall, AgentToolResult, AgentToolUpdateCallback, BeforeToolCallContext, QueueMode, StreamFn, ThinkingLevel } from "../types.ts";
import {
	canonicalFoundationJson,
	cloneDeepFrozen,
	createExecutionCorrelation,
	redactProjection,
	redactText,
	sha256HexValue,
	validateArtifactRef,
	validateArtifactDescriptor,
	validateArtifactPutResult,
	validateArtifactVerifyResult,
	validateDispatch,
	validateHostTerminalGateAuthority,
	validateImmutableAgentBinding,
	validateTaskEnvelope,
	LayeredResultSettlement,
	persistTaskEnvelopeBeforeResolver,
	validateDurableBindingSources,
	validateAgentInstance,
	validateBindingEpoch,
	createFoundationHostModelCallAdapter,
	foundationModelCallErrorStream,
	type AcceptanceFact,
	type AgentInstance,
	type AgentBinding,
	type BindingEpoch,
	type ArtifactRef,
	type ArtifactDescriptor,
	type ArtifactStoreProvider,
	type AttemptReceipt,
	type Dispatch,
	type ExecutionCorrelation,
	type FoundationJsonValue,
	type FoundationHostModelCallAdapter,
	type HostTerminalGateAuthority,
	type PublicExecutionError,
	type TaskExecutorProvider,
	type RunReceipt,
	type RunReceiptUsage,
	type SideEffectState,
	type TaskEnvelope,
	type TaskResult,
	type ValidationResult,
} from "./foundation/index.ts";
import { calculateContextTokens, compact as generateCompaction, estimateContextTokens, prepareCompaction, shouldCompact, type CompactionPreparation, type CompactionSettings } from "./compaction/compaction.ts";
import { generateBranchSummary } from "./compaction/branch-summarization.ts";
import { convertToLlm } from "./messages.ts";
import { buildSessionContextAsync, type AsyncCustomEntryContextMessageProjector } from "./session/context.ts";
import { formatPromptTemplateInvocation } from "./prompt-templates.ts";
import { formatSkillInvocation } from "./skills.ts";
import { formatSkillsForSystemPrompt } from "./system-prompt.ts";
import {
	HarnessEventBus,
	type HarnessEventListener,
	type HarnessEventOfType,
	type HarnessEventType,
} from "./events.ts";
import { type ResultValue, Result, TaggedError } from "./result.ts";
import { FoundationError, toFoundationError } from "./foundation/errors.ts";
import {
	FoundationToolPipeline,
	FoundationToolGuard,
	FoundationToolQuotaAccount,
	FOUNDATION_TOOL_RESULT_CUSTOM_TYPE,
	SessionToolPipelineStorage,
	projectToolReceiptExecutionSemantics,
	validateAndVerifyToolReceipt,
	validateFoundationToolResultEntry,
	validateToolIntent,
	validateToolReceipt,
	validateToolResultPayload,
	fingerprintToolArguments,
	type ToolDefinitionRegistry,
	type ToolDefinition,
	type ToolBindingRef,
	type ToolExecution,
	type ToolIntent,
	type ToolPipelineContext,
	type ToolPipelineOptions,
	type ToolGateScope,
	type ToolReceipt,
	type ToolReceiptOutcome,
	type FoundationToolResultEntry,
	type ToolResultPayload,
	type ToolResultContent,
	type ToolResultUsage,
	type ToolRevision,
} from "./tool-pipeline.ts";
import {
	assertJsonSerializable,
	type BranchSummaryEntry,
	type CompactionEntry,
	type CustomEntry,
	type Entry,
	type EntryQuery,
	type JsonValue,
	type MessageEntry,
	type NewRecord,
	type OperationStartedRecord,
	type ProvisionedEntry,
	type Session,
	type SessionTree,
	type SessionStopReason,
	type StepAttemptRecord,
	type ToolStartedRecord,
	type WriteDeferredRecord,
	SessionError,
	DurableLedgerError,
	type FoundationRecord,
	type ProvisionedFoundationRecord,
} from "./session/index.ts";
import type { TelemetryContext } from "./telemetry.ts";
import { type AgentHarnessResources, type PromptTemplate, type Skill, toError } from "./types.ts";
import {
	DEFERRED_FETCH_INTENT_CUSTOM_TYPE,
	DEFERRED_FETCH_RESULT_CUSTOM_TYPE,
	RecordLogCorruption,
	type DeferredFetchState,
	type LaneReductionResult,
	reduceLaneState,
} from "./reducer.ts";
import { ContextLedger, type ContextLedgerOptions } from "./context/ledger.ts";
import type { SessionArtifactStore } from "./artifacts.ts";
import type { SessionMemoryStore } from "./memory/memory.ts";
import { SessionLedgerBindingError } from "./session/ledger-writer.ts";

export class LaneBusy extends TaggedError("LaneBusy")<{
	lane: string;
	operationId: string;
	operationKind: "run" | "compaction" | "navigation";
	message: string;
}> {}
export class MissingIdentities extends TaggedError("MissingIdentities")<{
	lane: string;
	tools: string[];
	models: string[];
	message: string;
}> {}
export class NoActiveRun extends TaggedError("NoActiveRun")<{ lane: string; message: string }> {}
export class NoActiveOperation extends TaggedError("NoActiveOperation")<{ lane: string; message: string }> {}
export class NothingToResume extends TaggedError("NothingToResume")<{ lane: string; message: string }> {}
export class InvalidMessage extends TaggedError("InvalidMessage")<{ lane: string; reason: string; message: string }> {}
export class UnknownSkill extends TaggedError("UnknownSkill")<{ name: string; message: string }> {}
export class UnknownTemplate extends TaggedError("UnknownTemplate")<{ name: string; message: string }> {}
export class UnknownTarget extends TaggedError("UnknownTarget")<{ targetId: string; message: string }> {}
export class UnknownQueueItem extends TaggedError("UnknownQueueItem")<{
	lane: string;
	entryId: string;
	message: string;
}> {}
export class LaneExists extends TaggedError("LaneExists")<{ lane: string; message: string }> {}
export class InvalidLane extends TaggedError("InvalidLane")<{ lane: string; reason: string; message: string }> {}
export class NothingToCompact extends TaggedError("NothingToCompact")<{ lane: string; message: string }> {}
export class Closed extends TaggedError("Closed")<{ message: string }> {}

export class HarnessFault extends Error {
	readonly cause: unknown;

	constructor(message: string, cause: unknown) {
		super(message);
		this.name = "HarnessFault";
		this.cause = cause;
	}
}

export class HarnessClosed extends Error {
	constructor() {
		super("AgentHarness was closed while the operation was active");
		this.name = "HarnessClosed";
	}
}

export interface OperationError {
	code: string;
	message: string;
	details?: FoundationJsonValue;
}

const USER_ABORT_ERROR: OperationError = {
	code: "user_aborted",
	message: "Agent run was aborted by the user",
};

function providerAbortError(message: string | undefined): OperationError {
	const stableMessage = message ?? "Provider aborted the request";
	return /deadline/i.test(stableMessage)
		? { code: "deadline_exceeded", message: stableMessage }
		: { code: "provider_aborted", message: stableMessage };
}

export type RunOutcome =
	| { kind: "completed"; leafId: string; finalEntryId: string; finalMessage: AssistantMessage }
	| { kind: "aborted"; leafId: string; finalEntryId: string; finalMessage: AssistantMessage }
	| { kind: "failed"; leafId: string; error: OperationError; finalEntryId?: string; finalMessage?: AssistantMessage }
	| { kind: "suspended"; leafId: string; finalEntryId: string; deferred: DeferredHandle }
	| { kind: "pending"; leafId: string | null; operationId: string };

export type CompactionOutcome =
	| { kind: "completed"; leafId: string; entry: CompactionEntry }
	| { kind: "declined" | "aborted"; leafId: string }
	| { kind: "failed"; leafId: string; error: OperationError }
	| { kind: "pending"; leafId: string | null; operationId: string };

export type NavigationOutcome =
	| { kind: "completed"; newLeafId: string | null; summaryEntry?: BranchSummaryEntry }
	| { kind: "declined" | "aborted"; leafId: string | null }
	| { kind: "failed"; leafId: string | null; error: OperationError }
	| { kind: "pending"; leafId: string | null; operationId: string };

export type RunRejected = LaneBusy | InvalidMessage | UnknownSkill | UnknownTemplate | Closed;
export type CompactionRejected = LaneBusy | NothingToCompact | Closed;
export type NavigationRejected = LaneBusy | UnknownTarget | Closed;
export type ResumeRejected = LaneBusy | NothingToResume | MissingIdentities | Closed;
export type QueueRejected = NoActiveRun | InvalidMessage | Closed;
export type CancelQueuedRejected = UnknownQueueItem | Closed;
export type AbortRejected = NoActiveOperation | Closed;

export type RunResult = ResultValue<{ runId: string } & RunOutcome, RunRejected>;
export type CompactionResult = ResultValue<{ runId: string } & CompactionOutcome, CompactionRejected>;
export type NavigationResult = ResultValue<{ runId: string } & NavigationOutcome, NavigationRejected>;
export type QueueResult = ResultValue<{ entryId: string }, QueueRejected>;
export type CancelQueuedResult = ResultValue<
	{ outcome: "cancelled" | "already_consumed" | "already_cleared" },
	CancelQueuedRejected
>;
export type RecordUsageResult = ResultValue<void, Closed>;
export type AbortResult = ResultValue<
	{ runId: string; steer: AgentMessage[]; followUp: AgentMessage[] },
	AbortRejected
>;

export type ResumeOutcome =
	| ({ operation: "run"; runId: string } & RunOutcome)
	| ({ operation: "compaction"; runId: string } & CompactionOutcome)
	| ({ operation: "navigation"; runId: string } & NavigationOutcome);
export type ResumeResult = ResultValue<ResumeOutcome, ResumeRejected>;
export type CreateLaneResult = ResultValue<AgentLane, LaneExists | InvalidLane | UnknownTarget | Closed>;

export interface NavigateOptions {
	summarize?: boolean;
	customInstructions?: string;
	replaceInstructions?: boolean;
	label?: string;
}

export interface SuspendedOperation {
	lane: string;
	kind: "run" | "compaction" | "navigation";
	id: string;
	startedAt: number;
	reason: "crash" | "deferred";
	prompt?: AgentMessage[];
	deferred?: DeferredHandle;
	aborting?: { steer: AgentMessage[]; followUp: AgentMessage[] };
	missing: { tools: string[]; models: string[] };
}

export interface LaneInfo {
	name: string;
	leafId: string | null;
	operation: null | {
		id: string;
		kind: "run" | "compaction" | "navigation";
		status: "running" | "suspended" | "aborting";
	};
}

export interface QueuedItem {
	entryId: string;
	message: AgentMessage;
}

interface PendingQueueMutation {
	lane: string;
	queue: "steer" | "followUp" | "nextRun";
	runId?: string;
	target: { type: "message"; id: string; message: AgentMessage };
}

export interface LaneSnapshot {
	lane: string;
	transcript: Entry[];
	leafId: string | null;
	operation: LaneInfo["operation"];
	queues: { steer: QueuedItem[]; followUp: QueuedItem[]; nextRun: QueuedItem[] };
	pendingWrites: { id: string; entry: ProvisionedEntry }[];
	faulted: boolean;
}

export interface SessionSnapshot {
	lanes: (LaneInfo & { suspended?: SuspendedOperation })[];
	faulted: boolean;
}

export type ActionInfo =
	| { kind: "append_entry"; entryType: Entry["type"]; entryId: string }
	| { kind: "move_lane"; to: string | null }
	| { kind: "try_finish_run"; outcome: "completed" | "failed" | "aborted"; error?: OperationError }
	| { kind: "finish_operation"; outcome: "completed" | "declined" | "failed" | "aborted" }
	| { kind: "commit_follow_up" }
	| { kind: "consume_queue_item"; queue: "steer" | "followUp"; entryId: string }
	| { kind: "apply_pending_write"; entryId: string }
	| { kind: "stream_assistant"; step: "assistant" | "compaction" | "branch_summary"; attempt: number }
	| { kind: "execute_tool"; toolCallId: string; toolName: string }
	| { kind: "fetch_deferred"; provider: string; id: string }
	| { kind: "apply_deferred_fetch_result" };

export type HookName =
	| "before_run"
	| "before_resume"
	| "before_run_end"
	| "transform_context"
	| "before_request"
	| "before_payload"
	| "after_response"
	| "before_tool"
	| "after_tool"
	| "before_compaction"
	| "before_navigation";

export interface Hooks {
	on(name: HookName, handler: (event: unknown) => unknown | Promise<unknown>, options?: { id?: string }): () => void;
}

export interface Events {
	on<TType extends HarnessEventType>(
		type: TType,
		listener: HarnessEventListener<HarnessEventOfType<TType>>,
	): () => void;
}

class HookRegistry implements Hooks {
	private readonly handlers = new Map<HookName, Set<(event: unknown) => unknown | Promise<unknown>>>();
	private closed = false;

	setClosed(): void {
		this.closed = true;
	}

	on(
		name: HookName,
		handler: (event: unknown) => unknown | Promise<unknown>,
		_options?: { id?: string },
	): () => void {
		if (this.closed) throw new HarnessClosed();
		const handlers = this.handlers.get(name) ?? new Set<(event: unknown) => unknown | Promise<unknown>>();
		this.handlers.set(name, handlers);
		handlers.add(handler);
		return () => {
			handlers.delete(handler);
			if (handlers.size === 0) this.handlers.delete(name);
		};
	}

	async emit(name: HookName, event: unknown): Promise<void> {
		for (const handler of this.handlers.get(name) ?? []) await handler(event);
	}
}

class EventsFacade implements Events {
	private readonly bus: HarnessEventBus;

	constructor(bus: HarnessEventBus) {
		this.bus = bus;
	}

	on<TType extends HarnessEventType>(
		type: TType,
		listener: HarnessEventListener<HarnessEventOfType<TType>>,
	): () => void {
		return this.bus.on(type, listener);
	}
}

export type HarnessTool = AgentTool & { replay?: "never" | "safe"; sideEffectState?: SideEffectState };
export type Resources = AgentHarnessResources<Skill, PromptTemplate>;
export type StreamOptions = SimpleStreamOptions;
export type StreamOptionsPatch = Partial<SimpleStreamOptions>;
export type EntryProjector = (entry: Entry) => AgentMessage[] | Promise<AgentMessage[]>;

export interface HarnessCompatibilityWriter {
	recordMessage(message: AgentMessage): void | Promise<void>;
	recordCustomEntry(customType: string, data?: unknown): string;
	setSessionName(name: string | undefined): void;
	setSessionLabel(targetId: string, label: string | undefined): void;
}

export type HarnessContextPurpose = "agent_turn" | "compaction" | "branch_summary";
export interface HarnessContextPreparationInput {
	purpose: HarnessContextPurpose;
	operationId: string;
	model: Model<Api>;
	context: AgentContext;
	signal?: AbortSignal;
}
export type HarnessContextPreparation = (input: HarnessContextPreparationInput) => AgentContext | Promise<AgentContext>;
export type HarnessModelContextPreparationStart = (input: HarnessContextPreparationInput) => void | Promise<void>;
export interface HarnessModelCallBoundaryInput {
	lane: string;
	runId: string;
	model: Model<Api>;
	context: Context;
	options?: SimpleStreamOptions;
	prepareContext(model: Model<Api>): Promise<Context>;
	invoke(model: Model<Api>, context: Context, options?: SimpleStreamOptions): Promise<AssistantMessageEventStream>;
}
export type HarnessModelCallBoundary = (
	input: HarnessModelCallBoundaryInput,
) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>;
export interface HarnessStreamRequestPreparationInput {
	model: Model<Api>;
	options?: SimpleStreamOptions;
}
export interface HarnessStreamRequestPreparationResult {
	model: Model<Api>;
	options?: SimpleStreamOptions;
}
export type HarnessStreamRequestPreparation = (
	input: HarnessStreamRequestPreparationInput,
) => HarnessStreamRequestPreparationResult | Promise<HarnessStreamRequestPreparationResult>;
export interface HarnessCompactionHookInput {
	preparation: CompactionPreparation;
	branchEntries: Entry[];
	customInstructions?: string;
	reason: "manual" | "threshold" | "overflow";
	willRetry: boolean;
	signal: AbortSignal;
}
export interface HarnessCompactionHookResult {
	cancel?: boolean;
	compaction?: { summary: string; firstKeptEntryId: string; tokensBefore: number; usage?: Usage; details?: unknown };
}
export interface HarnessCompactionResult {
	summary: string;
	firstKeptEntryId: string;
	tokensBefore: number;
	estimatedTokensAfter: number;
	usage?: Usage;
	details?: unknown;
	fromExtension: boolean;
}
export interface HarnessCompactionHooks {
	before?: (input: HarnessCompactionHookInput) => HarnessCompactionHookResult | undefined | Promise<HarnessCompactionHookResult | undefined>;
	after?: (input: { entry: CompactionEntry; result: HarnessCompactionResult; reason: "manual" | "threshold" | "overflow"; willRetry: boolean }) => void | Promise<void>;
}
export interface HarnessNavigationHooks {
	before?: (input: { preparation: { targetId: string | null; oldLeafId: string | null; commonAncestorId: string | null; entriesToSummarize: Entry[]; userWantsSummary: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string }; signal: AbortSignal }) => HarnessNavigationHookResult | undefined | Promise<HarnessNavigationHookResult | undefined>;
	after?: (input: { oldLeafId: string | null; newLeafId: string | null; summaryEntry?: BranchSummaryEntry; fromExtension?: boolean }) => void | Promise<void>;
}

export interface HarnessNavigationHookResult {
	cancel?: boolean;
	summary?: { summary: string; details?: unknown; usage?: Usage };
	customInstructions?: string;
	replaceInstructions?: boolean;
	label?: string;
}

/**
 * Product execution identity supplied by the caller. The harness never creates
 * a Task, Binding, Dispatch, or AgentInstance on behalf of a prompt.
 */
export interface AgentHarnessFoundationExecution {
	task: TaskEnvelope;
	dispatch: Dispatch;
	binding: AgentBinding;
	providerId: string;
	initialBindingEpoch: BindingEpoch;
	agentInstanceId?: string;
	agentInstance?: AgentInstance;
	bindingEpochIds: readonly string[];
	settlement?: {
		summary?: string;
		artifacts?: readonly ArtifactRef[];
		diff?: ArtifactRef;
		tests?: readonly ValidationResult[];
		evidence?: readonly AcceptanceFact[];
	};
	hostAuthority?: HostTerminalGateAuthority;
}

export interface AgentHarnessOptions {
	session: Session;
	models: Models;
	model: Model<Api>;
	thinkingLevel?: ThinkingLevel;
	activeToolNames?: string[];
	tools?: HarnessTool[];
	toolContext?: object | (() => object | Promise<object>);
	systemPrompt?: string | (() => string | Promise<string>);
	resources?: Resources;
	streamOptions?: StreamOptions;
	retry?: RetryPolicy;
	compaction?: CompactionSettings;
	steeringMode?: QueueMode;
	followUpMode?: QueueMode;
	toolExecution?: "sequential" | "parallel";
	drive?: "automatic" | "manual";
	toProviderMessages?: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
	entryProjectors?: Record<string, EntryProjector>;
	streamFunction?: StreamFn;
	streamFunctionOverridden?: boolean;
	getApiKey?: AgentLoopConfig["getApiKey"];
	transformContext?: AgentLoopConfig["transformContext"];
	shouldStopAfterTurn?: AgentLoopConfig["shouldStopAfterTurn"];
	prepareNextTurn?: AgentLoopConfig["prepareNextTurn"];
	beforeToolCall?: AgentLoopConfig["beforeToolCall"];
	afterToolCall?: AgentLoopConfig["afterToolCall"];
	compatibilityWriter?: HarnessCompatibilityWriter;
	contextPreparation?: HarnessContextPreparation;
	streamRequestPreparation?: HarnessStreamRequestPreparation;
	context?: TelemetryContext;
	/** Optional context ledger authority; omitted harnesses create one bound to this Session. */
	ledger?: ContextLedger;
	/** Options for the harness-owned context ledger authority. */
	ledgerOptions?: ContextLedgerOptions;
	/** Optional explicit product execution graph; omitted prompts remain session-only. */
	foundationExecution?: AgentHarnessFoundationExecution;
	/** Trusted provider consumer. Receipts may only be obtained by consuming this provider. */
	foundationProvider?: TaskExecutorProvider;
	/** Host model-call boundary; defaults to the draft adapter over Models. */
	foundationModelCallAdapter?: FoundationHostModelCallAdapter;
	/** Host-owned artifact provider; method-bearing providers never enter durable execution state. */
	artifactStore?: ArtifactStoreProvider;
	/** Optional pipeline override; when Foundation execution is configured, storage defaults to the Session ledger. */
	toolPipeline?: FoundationToolPipeline;
	toolPipelineOptions?: Omit<ToolPipelineOptions, "registry" | "storage">;
}

export interface WatchHandle<TSnapshot> {
	snapshot: TSnapshot;
	start(listener: (event: unknown) => void): void;
	unsubscribe(): void;
}

interface ActiveOperation {
	id: string;
	lane: string;
	kind: "run" | "summary";
	controller: AbortController;
	promise: Promise<void>;
}

interface FoundationReceiptBundle {
	attemptId: string;
	attemptReceipt: AttemptReceipt;
	taskResult?: TaskResult;
	runReceipt?: RunReceipt;
	correlation: ExecutionCorrelation;
}

type FoundationModelInvocationStatus = "pending" | "succeeded" | "failed" | "unknown";

interface FoundationModelInvocation {
	readonly invocationId: string;
	readonly turnId: string;
	readonly ordinal: number;
	readonly bindingDigest: string;
	readonly route: FoundationJsonValue;
	readonly routeDigest: string;
	readonly selectedTarget: FoundationJsonValue;
	readonly contextSnapshotId?: string;
	readonly correlation: ExecutionCorrelation;
}

interface FoundationModelUsageSummary {
	modelCalls: number;
	input: number;
	output: number;
	totalTokens: number;
	costUsd: number;
}

interface FoundationModelInvocationPreparation {
	readonly invocation: FoundationModelInvocation;
	readonly remainingOutputTokens?: number;
}

function emptyModelUsage(): Usage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

interface FoundationToolOutcome {
	failed: boolean;
	sideEffectState: SideEffectState;
	error?: OperationError;
}

const HARNESS_CONFIGURATION_TYPES = {
	resources: "harness.config.resources",
	streamOptions: "harness.config.stream_options",
	retryPolicy: "harness.config.retry_policy",
	compaction: "harness.config.compaction",
	steeringMode: "harness.config.steering_mode",
	followUpMode: "harness.config.follow_up_mode",
	tools: "harness.config.tools",
} as const;

function isThinkingLevel(value: string): value is ThinkingLevel {
	return ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function messageText(message: AgentMessage): string {
	if (!("content" in message) || !Array.isArray(message.content)) return "";
	return message.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("");
}

interface SessionMetadataWithPath {
	readonly path?: unknown;
}

function hasExplicitArtifactBackend(options: ContextLedgerOptions | undefined): boolean {
	return options?.artifacts !== undefined || options?.artifactBlobStore !== undefined || options?.artifactRoot !== undefined;
}

async function composeLedgerOptions(options: AgentHarnessOptions): Promise<AgentHarnessOptions> {
	if (options.ledger !== undefined || hasExplicitArtifactBackend(options.ledgerOptions) || options.ledgerOptions?.allowInMemory !== undefined) return options;
	const metadata = await options.session.getMetadata();
	const hasPersistentPath = typeof (metadata as SessionMetadataWithPath).path === "string";
	if (hasPersistentPath) return options;
	return { ...options, ledgerOptions: { ...(options.ledgerOptions ?? {}), allowInMemory: true } };
}

function sessionStopReason(message: AssistantMessage): SessionStopReason {
	return message.stopReason === "pending" ? "error" : message.stopReason;
}

function durableAssistantMessage(message: AssistantMessage): AssistantMessage {
	const durable: AssistantMessage = {
		role: "assistant",
		content: message.content.map((content) => {
			if (content.type === "text") {
				return { type: "text", text: content.text, ...(content.textSignature === undefined ? {} : { textSignature: content.textSignature }) };
			}
			if (content.type === "thinking") {
				return {
					type: "thinking",
					thinking: content.thinking,
					...(content.thinkingSignature === undefined ? {} : { thinkingSignature: content.thinkingSignature }),
					...(content.redacted === undefined ? {} : { redacted: content.redacted }),
				};
			}
			return {
				type: "toolCall",
				id: content.id,
				name: content.name,
				arguments: structuredClone(content.arguments),
				...(content.thoughtSignature === undefined ? {} : { thoughtSignature: content.thoughtSignature }),
				...(content.namespace === undefined ? {} : { namespace: content.namespace }),
			};
		}),
		api: message.api,
		provider: message.provider,
		model: message.model,
		usage: {
			input: message.usage.input,
			output: message.usage.output,
			cacheRead: message.usage.cacheRead,
			cacheWrite: message.usage.cacheWrite,
			...(message.usage.cacheWrite1h === undefined ? {} : { cacheWrite1h: message.usage.cacheWrite1h }),
			...(message.usage.reasoning === undefined ? {} : { reasoning: message.usage.reasoning }),
			totalTokens: message.usage.totalTokens,
			cost: { ...message.usage.cost },
		},
		stopReason: message.stopReason,
		timestamp: message.timestamp,
		...(message.responseModel === undefined ? {} : { responseModel: message.responseModel }),
		...(message.responseId === undefined ? {} : { responseId: message.responseId }),
		...(message.diagnostics === undefined ? {} : {
			diagnostics: message.diagnostics.map((diagnostic) => ({
				type: diagnostic.type,
				timestamp: diagnostic.timestamp,
				...(diagnostic.error === undefined ? {} : {
					error: {
						message: diagnostic.error.message,
						...(diagnostic.error.name === undefined ? {} : { name: diagnostic.error.name }),
						...(diagnostic.error.stack === undefined ? {} : { stack: diagnostic.error.stack }),
						...(diagnostic.error.code === undefined ? {} : { code: diagnostic.error.code }),
					},
				}),
				...(diagnostic.details === undefined ? {} : { details: structuredClone(diagnostic.details) }),
			})),
		}),
		...(message.deferred === undefined ? {} : { deferred: structuredClone(message.deferred) }),
		...(message.errorMessage === undefined ? {} : { errorMessage: message.errorMessage }),
		...(message.rawStopReason === undefined ? {} : { rawStopReason: message.rawStopReason }),
		...(message.endTurn === undefined ? {} : { endTurn: message.endTurn }),
	};
	assertJsonSerializable(durable);
	return durable;
}

function operationError(error: unknown): OperationError {
	const normalized = toError(error);
	const code = error instanceof HarnessToolPipelineError
		? error.sideEffectState === "side_effect_unknown" ? "side_effect_unknown" : "tool_execution_failed"
		: error instanceof FoundationError ? error.code
		: error instanceof SessionError && error.code ? error.code : error instanceof Error ? error.name : "error";
	const contextError = error !== null && typeof error === "object" && "contextError" in error
		? error.contextError
		: undefined;
	return {
		code,
		message: normalized.message,
		...(contextError === undefined ? {} : { details: foundationJsonValue(contextError) }),
	};
}

function foundationToolUsage(usage: Usage): NonNullable<ToolExecution["usage"]> {
	return { tokens: usage.totalTokens, costUsd: usage.cost.total, toolCalls: 1 };
}

function agentUsageFromToolResultUsage(usage: ToolResultUsage): Usage {
	return {
		input: usage.input,
		output: usage.output,
		cacheRead: usage.cacheRead,
		cacheWrite: usage.cacheWrite,
		...(usage.cacheWrite1h === undefined ? {} : { cacheWrite1h: usage.cacheWrite1h }),
		...(usage.reasoning === undefined ? {} : { reasoning: usage.reasoning }),
		totalTokens: usage.totalTokens,
		cost: {
			input: usage.cost.input,
			output: usage.cost.output,
			cacheRead: usage.cost.cacheRead,
			cacheWrite: usage.cost.cacheWrite,
			total: usage.cost.total,
		},
	};
}

function foundationJsonValue(value: unknown): FoundationJsonValue {
	assertJsonSerializable(value);
	if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return value;
	if (Array.isArray(value)) return value.map((item) => foundationJsonValue(item));
	const record: Record<string, FoundationJsonValue> = {};
	const objectValue = value as Record<string, unknown>;
	for (const [key, item] of Object.entries(objectValue)) {
		record[key] = foundationJsonValue(item);
	}
	return record;
}

function matchesProvisionedEntryCanonical(entry: Entry, target: ProvisionedEntry): boolean {
	const { parentId: _parentId, seq: _seq, timestamp: _timestamp, ...payload } = entry;
	return canonicalFoundationJson(payload) === canonicalFoundationJson(target);
}

function toolStartedExecutionSemantics(start: ToolStartedRecord): string {
	try {
		return canonicalFoundationJson({
			type: start.type,
			runId: start.runId,
			assistantEntryId: start.assistantEntryId,
			toolIndex: start.toolIndex,
			toolCallId: start.toolCallId,
			toolName: start.toolName,
			effectiveArgs: start.effectiveArgs,
			resultEntryId: start.resultEntryId,
			replay: start.replay,
		});
	} catch (_error) {
		return "invalid_tool_started_execution_semantics";
	}
}

function foundationBindingCorrelationMismatch(binding: ToolBindingRef, correlation: ExecutionCorrelation): string | undefined {
	for (const [field, expected] of [
		["sessionId", correlation.sessionId],
		["laneId", correlation.laneId],
		["runId", correlation.runId],
		["operationId", correlation.operationId],
		["taskId", correlation.taskId],
		["dispatchId", correlation.dispatchId],
		["attemptId", correlation.attemptId],
		["bindingId", correlation.bindingId],
		["bindingEpochId", correlation.bindingEpochId],
		["providerId", correlation.providerId],
		["agentInstanceId", correlation.agentInstanceId],
	] as const) {
		if (expected !== undefined && binding[field] !== expected) return field;
	}
	return undefined;
}

function receiptMatchesIntentCanonical(receipt: ToolReceipt, intent: ToolIntent): boolean {
	return canonicalFoundationJson({
		toolCallId: receipt.toolCallId,
		toolName: receipt.toolName,
		...(receipt.namespace === undefined ? {} : { namespace: receipt.namespace }),
		toolRevision: receipt.toolRevision,
		binding: receipt.binding,
		...(receipt.idempotencyKey === undefined ? {} : { idempotencyKey: receipt.idempotencyKey }),
		argumentDigests: receipt.argumentDigests,
		transformProvenance: receipt.transformProvenance,
		attempt: receipt.attempt,
	}) === canonicalFoundationJson({
		toolCallId: intent.toolCallId,
		toolName: intent.toolName,
		...(intent.namespace === undefined ? {} : { namespace: intent.namespace }),
		toolRevision: intent.toolRevision,
		binding: intent.binding,
		...(intent.idempotencyKey === undefined ? {} : { idempotencyKey: intent.idempotencyKey }),
		argumentDigests: intent.argumentDigests,
		transformProvenance: intent.transformProvenance,
		attempt: intent.attempt,
	});
}

function sessionArtifactProvider(store: SessionArtifactStore): ArtifactStoreProvider {
	return {
		schemaVersion: 1,
		providerId: "aos.session-artifact-store",
		providerClass: "store",
		capabilities: async () => [],
		dispose: async () => {},
		put: async (descriptor, data) => {
			try {
				const producer = descriptor.producer ?? "system";
				const metadata = await store.put(data, {
					name: descriptor.name,
					mediaType: descriptor.mediaType,
					principal: producer,
					permissions: descriptor.permissions,
					acl: { owner: producer, readers: [producer, "system"], writers: [producer, "system"] },
					retention: descriptor.retention,
					producer,
					validation: { state: descriptor.validationState },
				});
				if (metadata.id !== descriptor.artifactId) {
					return Result.err(new FoundationError("side_effect_unknown", "session artifact identity does not match its descriptor"));
				}
				return Result.ok({ schemaVersion: 1, ref: metadata.id, sizeBytes: metadata.sizeBytes });
			} catch (error) {
				return Result.err(toFoundationError(error, "side_effect_unknown"));
			}
		},
		get: async (ref) => {
			try {
				return Result.ok((await store.get(ref)).content);
			} catch (error) {
				return Result.err(toFoundationError(error, "side_effect_unknown"));
			}
		},
		verify: async (artifactId) => {
			try {
				return Result.ok({ schemaVersion: 1, digestValid: (await store.verify(artifactId)) === "verified" });
			} catch (error) {
				return Result.err(toFoundationError(error, "side_effect_unknown"));
			}
		},
		delete: async (artifactId) => {
			try {
				await store.remove(artifactId);
				return Result.ok(undefined);
			} catch (error) {
				return Result.err(toFoundationError(error, "side_effect_unknown"));
			}
		},
	};
}

async function foundationToolResultPayload(
	result: AgentToolResult<unknown>,
	artifactStore: ArtifactStoreProvider | undefined,
	producerId: string | undefined,
	toolCallId: string,
): Promise<ResultValue<{ result: ToolResultPayload; artifacts: readonly ArtifactRef[] }, FoundationError>> {
	const content: ToolResultContent[] = [];
	for (const item of result.content) {
		if (item.type === "text") {
			const safeText = redactText(item.text);
			if (safeText !== item.text) return Result.err(new FoundationError("side_effect_unknown", "tool text cannot be safely persisted without changing its meaning"));
			content.push({ type: "text", text: safeText });
			continue;
		}
		if (artifactStore === undefined) return Result.err(new FoundationError("side_effect_unknown", "image tool result requires a durable ArtifactStore"));
		if (producerId === undefined) return Result.err(new FoundationError("side_effect_unknown", "image tool result has no durable provider identity"));
		if (!item.mimeType.startsWith("image/")) return Result.err(new FoundationError("side_effect_unknown", "image tool result has an invalid media type"));
		let bytes: Uint8Array;
		try {
			bytes = decodeBase64(item.data);
		} catch (_error) {
			return Result.err(new FoundationError("side_effect_unknown", "image tool result is not valid base64"));
		}
		const digest = rawSha256(bytes);
		const descriptor: ArtifactDescriptor = {
			schemaVersion: 1,
			artifactId: digest,
			name: `tool-result-image:${toolCallId}`,
			mediaType: item.mimeType,
			digest: `sha256:${digest}`,
			producer: producerId,
			permissions: [],
			retention: { policy: "session" },
			validationState: "pending",
			sizeBytes: bytes.byteLength,
		};
		const checkedDescriptor = validateArtifactDescriptor(descriptor);
		if (!checkedDescriptor.ok) return Result.err(new FoundationError("side_effect_unknown", "image ArtifactStore descriptor is invalid"));
		let stored: Awaited<ReturnType<ArtifactStoreProvider["put"]>>;
		try {
			stored = await artifactStore.put(checkedDescriptor.value, bytes);
		} catch (_error) {
			return Result.err(new FoundationError("side_effect_unknown", "image ArtifactStore put failed"));
		}
		if (!stored.ok) return Result.err(new FoundationError("side_effect_unknown", "image ArtifactStore put failed"));
		const putResult = validateArtifactPutResult(stored.value);
		if (!putResult.ok || putResult.value.ref !== checkedDescriptor.value.artifactId || putResult.value.sizeBytes !== bytes.byteLength) return Result.err(new FoundationError("side_effect_unknown", "image ArtifactStore put returned an unverifiable reference"));
		const artifactResult = validateArtifactRef({ schemaVersion: 1, artifactId: putResult.value.ref, mediaType: item.mimeType, digest: checkedDescriptor.value.digest, producer: producerId, sizeBytes: bytes.byteLength });
		if (!artifactResult.ok) {
			return Result.err(new FoundationError("side_effect_unknown", "image ArtifactStore returned an unverifiable ArtifactRef"));
		}
		const integrity = await verifyArtifactStoreRef(artifactStore, artifactResult.value);
		if (!integrity.ok) return integrity;
		content.push({ type: "image", artifact: artifactResult.value });
	}
	const payload: ToolResultPayload = {
		schemaVersion: 1,
		content,
		...(result.details === undefined ? {} : { details: foundationJsonValue(redactProjection(result.details)) }),
		...(result.usage === undefined ? {} : {
			usage: {
				input: result.usage.input,
				output: result.usage.output,
				cacheRead: result.usage.cacheRead,
				cacheWrite: result.usage.cacheWrite,
				...(result.usage.cacheWrite1h === undefined ? {} : { cacheWrite1h: result.usage.cacheWrite1h }),
				...(result.usage.reasoning === undefined ? {} : { reasoning: result.usage.reasoning }),
				totalTokens: result.usage.totalTokens,
				cost: {
					input: result.usage.cost.input,
					output: result.usage.cost.output,
					cacheRead: result.usage.cost.cacheRead,
					cacheWrite: result.usage.cost.cacheWrite,
					total: result.usage.cost.total,
				},
			} satisfies ToolResultUsage,
		}),
		...(result.addedToolNames === undefined ? {} : { addedToolNames: [...result.addedToolNames] }),
		...(result.terminate === undefined ? {} : { terminate: result.terminate }),
	};
	const payloadResult = validateToolResultPayload(payload);
	if (!payloadResult.ok) return payloadResult;
	return Result.ok({ result: payloadResult.value, artifacts: foundationToolResultArtifacts(payloadResult.value) });
}

async function restoreFoundationToolResult(payload: ToolResultPayload | undefined, artifactStore: ArtifactStoreProvider | undefined): Promise<ResultValue<AgentToolResult<unknown>, FoundationError>> {
	if (payload === undefined) return Result.err(new FoundationError("side_effect_unknown", "durable tool result payload is missing or unrecoverable"));
	const checked = validateToolResultPayload(payload);
	if (!checked.ok) return checked;
	const content: AgentToolResult<unknown>["content"] = [];
	for (const item of checked.value.content) {
		if (item.type === "text") {
			content.push({ type: "text", text: item.text });
			continue;
		}
		if (artifactStore === undefined) return Result.err(new FoundationError("side_effect_unknown", "durable image artifact cannot be recovered by this consumer"));
		const integrity = await verifyArtifactStoreRef(artifactStore, item.artifact);
		if (!integrity.ok) return integrity;
		const restoredImage: ImageContent & { artifact: ArtifactRef } = {
			type: "image",
			data: encodeBase64(integrity.value),
			mimeType: item.artifact.mediaType,
			artifact: item.artifact,
		};
		content.push(restoredImage);
	}
	return Result.ok({
		content,
		details: checked.value.details,
		...(checked.value.usage === undefined ? {} : {
			usage: {
				input: checked.value.usage.input,
				output: checked.value.usage.output,
				cacheRead: checked.value.usage.cacheRead,
				cacheWrite: checked.value.usage.cacheWrite,
				...(checked.value.usage.cacheWrite1h === undefined ? {} : { cacheWrite1h: checked.value.usage.cacheWrite1h }),
				...(checked.value.usage.reasoning === undefined ? {} : { reasoning: checked.value.usage.reasoning }),
				totalTokens: checked.value.usage.totalTokens,
				cost: {
					input: checked.value.usage.cost.input,
					output: checked.value.usage.cost.output,
					cacheRead: checked.value.usage.cost.cacheRead,
					cacheWrite: checked.value.usage.cost.cacheWrite,
					total: checked.value.usage.cost.total,
				},
			} satisfies Usage,
		}),
		...(checked.value.addedToolNames === undefined ? {} : { addedToolNames: [...checked.value.addedToolNames] }),
		...(checked.value.terminate === undefined ? {} : { terminate: checked.value.terminate }),
	});
}

async function verifyArtifactStoreRef(
	artifactStore: ArtifactStoreProvider,
	artifact: ArtifactRef,
): Promise<ResultValue<Uint8Array, FoundationError>> {
	const checkedArtifact = validateArtifactRef(artifact);
	if (!checkedArtifact.ok || checkedArtifact.value.sizeBytes === undefined) {
		return Result.err(new FoundationError("side_effect_unknown", "durable image artifact has no canonical size"));
	}
	let fetched: Awaited<ReturnType<ArtifactStoreProvider["get"]>>;
	try {
		fetched = await artifactStore.get(checkedArtifact.value.artifactId);
	} catch (_error) {
		return Result.err(new FoundationError("side_effect_unknown", "durable image artifact cannot be recovered by this consumer"));
	}
	if (fetched === null || typeof fetched !== "object" || !("ok" in fetched) || fetched.ok !== true || !("value" in fetched) || !(fetched.value instanceof Uint8Array)) {
		return Result.err(new FoundationError("side_effect_unknown", "durable image artifact cannot be recovered by this consumer"));
	}
	const bytes = fetched.value;
	if (bytes.byteLength !== checkedArtifact.value.sizeBytes || checkedArtifact.value.digest !== `sha256:${rawSha256(bytes)}`) {
		return Result.err(new FoundationError("side_effect_unknown", "durable image artifact failed integrity verification"));
	}
	let verified: Awaited<ReturnType<ArtifactStoreProvider["verify"]>>;
	try {
		verified = await artifactStore.verify(checkedArtifact.value.artifactId);
	} catch (_error) {
		return Result.err(new FoundationError("side_effect_unknown", "durable image artifact failed integrity verification"));
	}
	if (verified === null || typeof verified !== "object" || !("ok" in verified) || verified.ok !== true || !("value" in verified)) {
		return Result.err(new FoundationError("side_effect_unknown", "durable image artifact failed integrity verification"));
	}
	const verifyResult = validateArtifactVerifyResult(verified.value);
	if (!verifyResult.ok || !verifyResult.value.digestValid) {
		return Result.err(new FoundationError("side_effect_unknown", "durable image artifact failed integrity verification"));
	}
	return Result.ok(bytes);
}

function foundationToolResultArtifacts(payload: ToolResultPayload): readonly ArtifactRef[] {
	return payload.content.flatMap((item) => item.type === "image" ? [item.artifact] : []);
}

interface FoundationReceiptFold {
	representative: ToolReceipt;
	outcome: ToolReceiptOutcome;
	sideEffectState: SideEffectState;
	result?: ToolResultPayload;
}

function toolReceiptSeverity(receipt: ToolReceipt): 1 | 2 | 3 {
	if (receipt.outcome === "side_effect_unknown" || receipt.sideEffectState === "side_effect_unknown") return 3;
	if (receipt.outcome !== "succeeded" || receipt.sideEffectState !== "none") return 2;
	return 1;
}

function decodeBase64(value: string): Uint8Array {
	if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new TypeError("invalid base64");
	const binary = atob(value);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
	return bytes;
}

function encodeBase64(value: Uint8Array): string {
	let binary = "";
	for (const byte of value) binary += String.fromCharCode(byte);
	return btoa(binary);
}

function rawSha256(value: Uint8Array): string {
	return sha256HexValue(value);
}

class HarnessToolPipelineError extends Error {
	readonly sideEffectState: SideEffectState;

	constructor(message: string, sideEffectState: SideEffectState) {
		super(message);
		this.name = "HarnessToolPipelineError";
		this.sideEffectState = sideEffectState;
	}
}

function isHarnessInfrastructureFault(error: unknown): boolean {
	if (error instanceof HarnessFault || error instanceof DurableLedgerError) return true;
	// A SessionError crossing an active-operation boundary is a ledger or
	// persistence invariant failure. User input is validated before an active
	// operation starts, so it must not be converted into a model failure here.
	return error instanceof SessionError;
}

export class AgentHarness implements AgentLane {
	readonly name = "main";
	readonly session: SessionTree;
	readonly ledger: ContextLedger;
	/** Context operations are served by the same ledger authority as memory and artifacts. */
	readonly context: ContextLedger;
	readonly memory: SessionMemoryStore;
	readonly artifacts: SessionArtifactStore;
	readonly hooks: Hooks;
	readonly events: Events;
	private readonly durableSession: Session;
	private readonly models: Models;
	private defaultModel: Model<Api>;
	private readonly defaultThinkingLevel: ThinkingLevel;
	private readonly defaultActiveToolNames: string[];
	private modelAvailable = true;
	private readonly ownsLedger: boolean;
	private tools: HarnessTool[];
	private resources: Resources;
	private streamOptions: StreamOptions;
	private retryPolicy: RetryPolicy;
	private compactionSettings: CompactionSettings;
	private steeringMode: QueueMode;
	private followUpMode: QueueMode;
	private readonly drive: "automatic" | "manual";
	private readonly toolContext?: object | (() => object | Promise<object>);
	private readonly systemPromptSource?: string | (() => string | Promise<string>);
	private readonly toProviderMessages: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
	private entryProjectors: Record<string, EntryProjector>;
	private streamFunctionValue?: StreamFn;
	private streamFunctionOverridden: boolean;
	private readonly getApiKey?: AgentLoopConfig["getApiKey"];
	private readonly transformContext?: AgentLoopConfig["transformContext"];
	private readonly shouldStopAfterTurn?: AgentLoopConfig["shouldStopAfterTurn"];
	private readonly prepareNextTurn?: AgentLoopConfig["prepareNextTurn"];
	private beforeToolCall: AgentLoopConfig["beforeToolCall"];
	private afterToolCall: AgentLoopConfig["afterToolCall"];
	private eventTransform?: (event: AgentEvent) => AgentEvent | Promise<AgentEvent>;
	private readonly compatibilityWriter?: HarnessCompatibilityWriter;
	private contextPreparation?: HarnessContextPreparation;
	private modelContextPreparationStart?: HarnessModelContextPreparationStart;
	private modelCallBoundary?: HarnessModelCallBoundary;
	private streamRequestPreparation?: HarnessStreamRequestPreparation;
	private compactionHooks?: HarnessCompactionHooks;
	private navigationHooks?: HarnessNavigationHooks;
	private contextSnapshotIdForOperation?: (operationId: string, purpose: HarnessContextPurpose) => string | undefined;
	private readonly toolExecution: "sequential" | "parallel";
	private foundationExecution?: AgentHarnessFoundationExecution;
	private readonly artifactStore?: ArtifactStoreProvider;
	private foundationSessionId?: string;
	private toolPipeline?: FoundationToolPipeline;
	private readonly toolPipelineOptions?: AgentHarnessOptions["toolPipelineOptions"];
	private foundationProvider?: TaskExecutorProvider;
	private readonly foundationModelCallAdapter: FoundationHostModelCallAdapter;
	private readonly foundationOwnerId?: string;
	private readonly terminalToolFailureOperations = new Set<string>();
	private readonly eventBus = new HarnessEventBus();
	private readonly hookRegistry = new HookRegistry();
	private readonly activeOperations = new Map<string, ActiveOperation>();
	private readonly laneReductions = new Map<string, LaneReductionResult>();
	private readonly mutationTails = new Map<string, Promise<void>>();
	private readonly compatibilityTasks = new Set<Promise<unknown>>();
	private readonly pendingExternalMessageTasks = new Set<Promise<void>>();
	private readonly laneSnapshots = new Map<string, LaneSnapshot>();
	private readonly pendingQueueMutations = new Map<string, PendingQueueMutation>();
	private lastQueueUpdateFingerprint: string | undefined;
	private queueUpdatePending = false;
	private agentSettlementPending = false;
	private readonly pendingThinkingLevels = new Map<string, ThinkingLevel>();
	private readonly pendingModels = new Map<string, Model<Api>>();
	private readonly pendingActiveToolNames = new Map<string, string[]>();
	private readonly foundationToolHookResults = new Map<string, AfterToolCallResult>();
	private sessionSnapshot: SessionSnapshot = { lanes: [], faulted: false };
	private readonly assistantEntries = new Map<string, string>();
	private readonly contextPreparationErrors = new Map<string, unknown>();
	private readonly operationContextInputs = new Map<string, AgentContext>();
	private closed = false;
	private closing = false;
	private closePromise?: Promise<void>;
	private faulted = false;
	private retryAttemptValue = 0;
	private readonly retryCancelledOperations = new Set<string>();
	private readonly pendingPromptEvents = new Set<string>();
	private overflowRecoveryAttempted = false;

	private constructor(options: AgentHarnessOptions) {
		this.durableSession = options.session;
		this.session = options.session;
		if (options.ledger !== undefined && options.ledger.session !== options.session) {
			throw new SessionLedgerBindingError("AgentHarness ledger authority must use the supplied Session");
		}
		const foundationOwnerId =
			options.foundationExecution === undefined && options.foundationProvider === undefined
				? undefined
				: options.ledgerOptions?.ownerId ?? `agent-harness:${options.session.idGenerator.next()}`;
		this.foundationOwnerId = foundationOwnerId;
		const ledgerOptions =
			foundationOwnerId === undefined || options.ledgerOptions?.ownerId !== undefined
				? options.ledgerOptions
				: { ...(options.ledgerOptions ?? {}), ownerId: foundationOwnerId };
		this.ledger = options.ledger ?? new ContextLedger(options.session, ledgerOptions);
		this.context = this.ledger;
		this.memory = this.ledger.memory;
		this.artifacts = this.ledger.artifacts;
		this.ownsLedger = options.ledger === undefined;
		this.models = options.models;
		this.defaultModel = options.model;
		this.defaultThinkingLevel = options.thinkingLevel ?? "off";
		this.defaultActiveToolNames = [...(options.activeToolNames ?? options.tools?.map((tool) => tool.name) ?? [])];
		this.tools = [...(options.tools ?? [])];
		this.resources = {
			skills: options.resources?.skills ? [...options.resources.skills] : undefined,
			promptTemplates: options.resources?.promptTemplates ? [...options.resources.promptTemplates] : undefined,
		};
		this.streamOptions = { ...(options.streamOptions ?? {}) };
		this.retryPolicy = options.retry ?? { enabled: false, maxRetries: 0, baseDelayMs: 1000 };
		this.compactionSettings = options.compaction ?? {
			enabled: true,
			reserveTokens: 16384,
			keepRecentTokens: 20000,
		};
		this.steeringMode = options.steeringMode ?? "one-at-a-time";
		this.followUpMode = options.followUpMode ?? "one-at-a-time";
		this.drive = options.drive ?? "automatic";
		this.toolContext = options.toolContext;
		this.systemPromptSource = options.systemPrompt;
		this.toProviderMessages = options.toProviderMessages ?? convertToLlm;
		this.entryProjectors = { ...(options.entryProjectors ?? {}) };
		this.streamFunctionValue = options.streamFunction;
		this.streamFunctionOverridden = options.streamFunctionOverridden ?? options.streamFunction !== undefined;
		this.getApiKey = options.getApiKey;
		this.transformContext = options.transformContext;
		this.shouldStopAfterTurn = options.shouldStopAfterTurn;
		this.prepareNextTurn = options.prepareNextTurn;
		this.beforeToolCall = options.beforeToolCall;
		this.afterToolCall = options.afterToolCall;
		this.compatibilityWriter = options.compatibilityWriter;
		this.contextPreparation = options.contextPreparation;
		this.streamRequestPreparation = options.streamRequestPreparation;
		this.toolExecution = options.toolExecution ?? "parallel";
		this.foundationExecution = options.foundationExecution === undefined ? undefined : structuredClone(options.foundationExecution);
		this.foundationProvider = options.foundationProvider;
		this.foundationModelCallAdapter = options.foundationModelCallAdapter ?? createFoundationHostModelCallAdapter({
			streamSimple: (model, context, streamOptions) => this.streamFunctionValue?.(model, context, streamOptions) ?? options.models.streamSimple(model, context, streamOptions),
		});
		this.artifactStore = options.artifactStore ?? sessionArtifactProvider(this.artifacts);
		this.toolPipeline = options.toolPipeline;
		this.toolPipelineOptions = options.toolPipelineOptions;
		this.hooks = this.hookRegistry;
		this.events = new EventsFacade(this.eventBus);
	}

	static async create(
		options: AgentHarnessOptions,
	): Promise<{ harness: AgentHarness; suspended: SuspendedOperation[] }> {
		const harness = new AgentHarness(await composeLedgerOptions(options));
		try {
			await harness.initializeFoundationExecution();
			const suspended = await harness.restore();
			return { harness, suspended };
		} catch (error) {
			await harness.releaseOwnedLedgerLease();
			throw error;
		}
	}

	/** Synchronous composition for legacy constructors; the first operation still reduces the durable Session. */
	static createUnrestored(options: AgentHarnessOptions): AgentHarness {
		return new AgentHarness(options);
	}

	get currentModel(): Model<Api> {
		const pending = this.pendingModels.get("main");
		if (pending !== undefined) return pending;
		const route = this.foundationExecution?.binding.modelRoute;
		const configured = this.laneReductions.get("main")?.effectiveConfiguration.model;
		const provider = route?.provider ?? configured?.provider ?? this.defaultModel.provider;
		const modelId = route?.model ?? configured?.modelId ?? this.defaultModel.id;
		if (this.defaultModel.provider === provider && this.defaultModel.id === modelId) return this.defaultModel;
		return this.models.getModel(provider, modelId) ?? this.defaultModel;
	}
	get hasModel(): boolean { return this.modelAvailable; }
	get currentThinkingLevel(): ThinkingLevel {
		const pending = this.pendingThinkingLevels.get("main");
		if (pending !== undefined) return pending;
		const route = this.foundationExecution?.binding.modelRoute;
		if (route !== undefined) return route.effort !== undefined && isThinkingLevel(route.effort) ? route.effort : "off";
		const configured = this.laneReductions.get("main")?.effectiveConfiguration.thinkingLevel;
		return configured !== undefined && isThinkingLevel(configured) ? configured : this.defaultThinkingLevel;
	}
	get currentSteeringMode(): QueueMode { return this.steeringMode; }
	get currentFollowUpMode(): QueueMode { return this.followUpMode; }
	get activeToolNamesSnapshot(): readonly string[] {
		return [...(this.pendingActiveToolNames.get("main") ?? this.laneReductions.get("main")?.effectiveConfiguration.activeToolNames ?? this.defaultActiveToolNames)];
	}
	get toolsSnapshot(): readonly HarnessTool[] { return [...this.tools]; }
	get isRunning(): boolean { return this.activeOperations.size > 0 || this.sessionSnapshot.lanes.some((lane) => lane.operation !== null); }
	get currentSignal(): AbortSignal | undefined { return this.activeOperations.values().next().value?.controller.signal; }
	get hasCustomStreamFunction(): boolean { return this.streamFunctionOverridden; }
	get streamFunction(): StreamFn { return this.streamFunctionValue ?? ((model, context, options) => this.models.streamSimple(model, context, options)); }
	get pendingMessageCount(): number {
		return this.queuedItems("main", "steer").length + this.queuedItems("main", "followUp").length + this.queuedItems("main", "nextRun").length;
	}
	get durablePendingMessageCount(): number {
		const queues = this.laneSnapshots.get("main")?.queues;
		return queues === undefined ? 0 : queues.steer.length + queues.followUp.length + queues.nextRun.length;
	}
	get hasQueuedMessages(): boolean { return this.pendingMessageCount > 0; }
	get steeringMessagesSnapshot(): readonly AgentMessage[] { return this.queuedItems("main", "steer").map((item) => structuredClone(item.message)); }
	get followUpMessagesSnapshot(): readonly AgentMessage[] { return this.queuedItems("main", "followUp").map((item) => structuredClone(item.message)); }
	get currentOperationKind(): "run" | "compaction" | "navigation" | undefined { return this.laneSnapshots.get("main")?.operation?.kind; }
	get retryAttempt(): number { return this.retryAttemptValue; }
	get isRetrying(): boolean { return this.retryAttemptValue > 0; }
	get hasPendingExternalMessages(): boolean { return this.pendingExternalMessageTasks.size > 0; }

	setStreamFunction(streamFunction: StreamFn): void {
		this.ensureOpen();
		this.streamFunctionValue = streamFunction;
		this.streamFunctionOverridden = true;
	}

	setStreamRequestPreparation(preparation: HarnessStreamRequestPreparation | undefined): void {
		this.ensureOpen();
		this.streamRequestPreparation = preparation;
	}

	setCompactionHooks(hooks: HarnessCompactionHooks | undefined): void {
		this.ensureOpen();
		this.compactionHooks = hooks;
	}

	setNavigationHooks(hooks: HarnessNavigationHooks | undefined): void {
		this.ensureOpen();
		this.navigationHooks = hooks;
	}

	setContextPreparation(preparation: HarnessContextPreparation | undefined): void {
		this.ensureOpen();
		this.contextPreparation = preparation;
	}

	setModelContextPreparationStart(preparation: HarnessModelContextPreparationStart | undefined): void {
		this.ensureOpen();
		this.modelContextPreparationStart = preparation;
	}

	setModelCallBoundary(boundary: HarnessModelCallBoundary | undefined): void {
		this.ensureOpen();
		this.modelCallBoundary = boundary;
	}

	setContextSnapshotIdForOperation(
		reader: ((operationId: string, purpose: HarnessContextPurpose) => string | undefined) | undefined,
	): void {
		this.ensureOpen();
		this.contextSnapshotIdForOperation = reader;
	}

	setEventTransform(transform: ((event: AgentEvent) => AgentEvent | Promise<AgentEvent>) | undefined): void {
		this.ensureOpen();
		this.eventTransform = transform;
	}

	setToolCallHooks(hooks: { beforeToolCall?: AgentLoopConfig["beforeToolCall"]; afterToolCall?: AgentLoopConfig["afterToolCall"] }): void {
		this.ensureOpen();
		const previousBefore = this.beforeToolCall;
		const previousAfter = this.afterToolCall;
		this.beforeToolCall = hooks.beforeToolCall === undefined
			? previousBefore
			: async (context, signal) => {
					const previous = await previousBefore?.(context, signal);
					if (previous?.block === true) return previous;
					return (await hooks.beforeToolCall?.(context, signal)) ?? previous;
				};
		this.afterToolCall = hooks.afterToolCall === undefined
			? previousAfter
			: async (context, signal) => {
					const previous = await previousAfter?.(context, signal);
					const nextContext = previous === undefined ? context : { ...context, result: { ...context.result, ...previous } };
					const next = await hooks.afterToolCall?.(nextContext, signal);
					return next === undefined ? previous : { ...previous, ...next };
				};
	}

	setEntryProjectors(projectors: Record<string, EntryProjector>): void {
		this.ensureOpen();
		this.entryProjectors = { ...this.entryProjectors, ...projectors };
	}

	async getSystemPrompt(): Promise<string> {
		return this.systemPrompt();
	}

	clearModel(): void {
		this.ensureOpen();
		this.modelAvailable = false;
	}

	recordCustomEntry(customType: string, data?: unknown): string {
		this.ensureOpen();
		if (this.compatibilityWriter === undefined) throw new HarnessFault("No compatibility writer is bound", undefined);
		assertJsonSerializable(data);
		return this.compatibilityWriter.recordCustomEntry(customType, data);
	}

	setSessionNameSync(name: string | undefined): void {
		this.ensureOpen();
		if (this.compatibilityWriter === undefined) throw new HarnessFault("No compatibility writer is bound", undefined);
		this.compatibilityWriter.setSessionName(name);
	}

	setSessionLabelSync(targetId: string, label: string | undefined): void {
		this.ensureOpen();
		if (this.compatibilityWriter === undefined) throw new HarnessFault("No compatibility writer is bound", undefined);
		this.compatibilityWriter.setSessionLabel(targetId, label);
	}

	recordCompatibilityMessage(message: AgentMessage): Promise<void> {
		this.ensureOpen();
		if (this.compatibilityWriter === undefined) throw new HarnessFault("No compatibility writer is bound", undefined);
		const snapshot = structuredClone(message);
		const written = this.compatibilityWriter.recordMessage(snapshot);
		const task = Promise.resolve(written).then(() => {
			this.eventBus.emit({ type: "agent_event", event: { type: "message_start", message: structuredClone(snapshot) } });
			this.eventBus.emit({ type: "agent_event", event: { type: "message_end", message: structuredClone(snapshot) } });
		});
		this.trackCompatibilityTask(task);
		return task;
	}

	emitBashExecutionUpdate(id: string | undefined, delta: string): void {
		if (this.closed) return;
		this.eventBus.emit({ type: "bash_execution_update", ...(id === undefined ? {} : { id }), delta });
	}

	trackCompatibilityTask(task: Promise<unknown>): void {
		this.compatibilityTasks.add(task);
		void task.then(
			() => this.compatibilityTasks.delete(task),
			() => this.compatibilityTasks.delete(task),
		);
	}

	/** Wait until every compatibility write and its corresponding event publication has settled. */
	async waitForCompatibilityTasks(): Promise<void> {
		while (this.compatibilityTasks.size > 0) {
			await Promise.allSettled([...this.compatibilityTasks]);
		}
	}

	async appendCustomEntry(customType: string, data?: unknown): Promise<string> {
		this.ensureOpen();
		assertJsonSerializable(data);
		return this.durableSession.view("main").appendCustomEntry(customType, data);
	}

	findEntries(query?: EntryQuery): Promise<Entry[]> {
		return this.durableSession.findEntries(query);
	}

	async promptWithPreflight(
		text: string,
		preflight: (signal: AbortSignal) => void | Promise<void>,
		options: { images?: ImageContent[]; signal?: AbortSignal; deadlineMs?: number; runId?: string } = {},
	): Promise<RunResult> {
		return this.runWithPreflight(preflight, options, () => this.promptImpl("main", text, options.images, options.runId));
	}

	async continueWithPreflight(
		preflight: (signal: AbortSignal) => void | Promise<void>,
		options: { signal?: AbortSignal; deadlineMs?: number; runId?: string } = {},
	): Promise<RunResult> {
		return this.runWithPreflight(preflight, options, () => this.promptImpl("main", [], undefined, options.runId, true));
	}

	beginPromptCompactionCycle(): void {
		this.overflowRecoveryAttempted = false;
	}

	private async runWithPreflight(
		preflight: (signal: AbortSignal) => void | Promise<void>,
		options: { signal?: AbortSignal; deadlineMs?: number },
		operation: () => Promise<RunResult>,
	): Promise<RunResult> {
		const controller = new AbortController();
		const abort = (): void => controller.abort(options.signal?.reason);
		options.signal?.addEventListener("abort", abort, { once: true });
		let deadline: ReturnType<typeof setTimeout> | undefined;
		if (options.deadlineMs !== undefined) deadline = setTimeout(() => controller.abort(new DOMException("Operation deadline exceeded", "TimeoutError")), options.deadlineMs);
		try {
			await preflight(controller.signal);
			if (controller.signal.aborted) throw controller.signal.reason;
			const pending = operation();
			const onAbort = (): void => { void this.abort(); };
			controller.signal.addEventListener("abort", onAbort, { once: true });
			try { return await pending; } finally { controller.signal.removeEventListener("abort", onAbort); }
		} finally {
			options.signal?.removeEventListener("abort", abort);
			if (deadline !== undefined) clearTimeout(deadline);
		}
	}

	async cancelAllQueued(): Promise<{ steering: string[]; followUp: string[] }> {
		await this.refreshSnapshots();
		const queues = this.laneSnapshots.get("main")?.queues;
		const steering = queues?.steer.map((item) => messageText(item.message)) ?? [];
		const followUp = queues?.followUp.map((item) => messageText(item.message)) ?? [];
		for (const item of [...(queues?.steer ?? []), ...(queues?.followUp ?? []), ...(queues?.nextRun ?? [])]) {
			await this.cancelQueued(item.entryId);
		}
		return { steering, followUp };
	}

	async abortRetry(): Promise<void> {
		if (this.retryAttemptValue === 0) return;
		for (const operation of this.activeOperations.values()) {
			this.retryCancelledOperations.add(operation.id);
			operation.controller.abort(new Error("Retry cancelled"));
		}
	}

	recordExternalMessage(message: AgentMessage): Promise<void> {
		const task = this.recordCompatibilityMessage(message);
		this.pendingExternalMessageTasks.add(task);
		void task.then(
			() => this.pendingExternalMessageTasks.delete(task),
			() => this.pendingExternalMessageTasks.delete(task),
		);
		return task;
	}

	private enqueue<T>(lane: string, operation: () => Promise<T>): Promise<T> {
		const previous = this.mutationTails.get(lane) ?? Promise.resolve();
		const result = previous.then(operation);
		this.mutationTails.set(lane, result.then(
			() => undefined,
			() => undefined,
		));
		return result;
	}

	private async drainMutations(lane?: string): Promise<void> {
		const tails = lane === undefined
			? [...this.mutationTails.values()]
			: [this.mutationTails.get(lane) ?? Promise.resolve()];
		await Promise.all(tails.map((tail) => tail.catch(() => undefined)));
	}

	private runWithLane<T>(lane: string, operation: () => Promise<T>): Promise<T> {
		if (lane.length === 0) return Promise.reject(new SessionError("invalid_lane", "Lane name is empty"));
		return operation();
	}

	private queuedItems(lane: string, queue: PendingQueueMutation["queue"]): QueuedItem[] {
		const durable = this.laneSnapshots.get(lane)?.queues[queue] ?? [];
		const ids = new Set(durable.map((item) => item.entryId));
		const pending = [...this.pendingQueueMutations.values()]
			.filter((item) => item.lane === lane && item.queue === queue && !ids.has(item.target.id))
			.map((item) => ({ entryId: item.target.id, message: item.target.message }));
		return [...durable, ...pending];
	}

	private emitQueueUpdate(): void {
		const update = {
			steering: this.queuedItems("main", "steer").map((item) => messageText(item.message)),
			followUp: this.queuedItems("main", "followUp").map((item) => messageText(item.message)),
		};
		const fingerprint = JSON.stringify(update);
		if (fingerprint === this.lastQueueUpdateFingerprint) return;
		this.lastQueueUpdateFingerprint = fingerprint;
		this.eventBus.emit({ type: "queue_update", ...update });
	}

	private closedError(): Closed {
		return new Closed({ message: "AgentHarness is closed" });
	}

	private ensureOpen(): void {
		if (this.closed || this.closing) throw new HarnessClosed();
		if (this.faulted) throw new HarnessFault("AgentHarness is faulted", undefined);
	}

	private async initializeFoundationExecution(): Promise<void> {
		const execution = this.foundationExecution;
		if (execution === undefined) return;
		const taskResult = validateTaskEnvelope(execution.task);
		if (!taskResult.ok) throw new HarnessFault("Foundation execution task is not an established TaskEnvelope", taskResult.error);
		const persistedTask = await persistTaskEnvelopeBeforeResolver(this.durableSession, taskResult.value, { ownerId: this.foundationOwnerId, writer: this.ledger.writer });
		if (!persistedTask.ok) throw new HarnessFault("Foundation execution TaskEnvelope could not be durably established before binding resolution", persistedTask.error);
		const dispatchResult = validateDispatch(execution.dispatch);
		if (!dispatchResult.ok) throw new HarnessFault("Foundation execution dispatch is not an established Dispatch", dispatchResult.error);
		const bindingResult = validateImmutableAgentBinding(execution.binding);
		if (!bindingResult.ok) throw new HarnessFault("Foundation execution binding is not an established immutable AgentBinding", bindingResult.error);
		const resolvedBindingResult = await validateDurableBindingSources(this.durableSession, bindingResult.value, persistedTask.value);
		if (!resolvedBindingResult.ok) throw new HarnessFault("Foundation execution binding does not resolve from durable registry and source facts", resolvedBindingResult.error);
		const epochResult = validateBindingEpoch(execution.initialBindingEpoch);
		if (!epochResult.ok) throw new HarnessFault("Foundation execution epoch is not an established BindingEpoch", epochResult.error);
		const agentResult = execution.agentInstance === undefined ? undefined : validateAgentInstance(execution.agentInstance);
		if (agentResult !== undefined && !agentResult.ok) throw new HarnessFault("Foundation execution AgentInstance is not established", agentResult.error);
		const provider = this.foundationProvider;
		if (provider === undefined) throw new HarnessFault("Foundation execution requires a trusted provider consumer", undefined);
		if (provider.providerId !== execution.providerId) throw new HarnessFault("Foundation execution provider consumer does not match providerId", undefined);
		if ((execution.hostAuthority === undefined) !== (execution.settlement === undefined)) {
			throw new HarnessFault("Foundation hostAuthority and settlement must be supplied together", undefined);
		}
		const authorityResult = execution.hostAuthority === undefined ? undefined : validateHostTerminalGateAuthority(execution.hostAuthority);
		if (authorityResult !== undefined && !authorityResult.ok) throw new HarnessFault("Foundation host authority is not an established terminal gate", authorityResult.error);
		if (execution.providerId !== dispatchResult.value.taskExecutorProviderId) {
			throw new HarnessFault("Foundation execution provider does not match the Dispatch executor", undefined);
		}
		if (dispatchResult.value.taskId !== taskResult.value.taskId || dispatchResult.value.bindingId !== bindingResult.value.bindingId) {
			throw new HarnessFault("Foundation execution Dispatch does not match its Task or Binding", undefined);
		}
		if (bindingResult.value.taskId !== taskResult.value.taskId) {
			throw new HarnessFault("Foundation execution Binding does not match its Task", undefined);
		}
		const normalizedExecution: AgentHarnessFoundationExecution = {
			...execution,
			task: structuredClone(taskResult.value),
			dispatch: structuredClone(dispatchResult.value),
			binding: cloneDeepFrozen(resolvedBindingResult.value),
			initialBindingEpoch: structuredClone(epochResult.value),
			bindingEpochIds: [...execution.bindingEpochIds],
			...(execution.agentInstance === undefined ? {} : { agentInstance: structuredClone(execution.agentInstance) }),
			...(authorityResult === undefined ? {} : { hostAuthority: structuredClone(authorityResult.value) }),
			...(execution.settlement === undefined ? {} : { settlement: structuredClone(execution.settlement) }),
		};
		this.foundationExecution = normalizedExecution;
		if (normalizedExecution.task.taskId !== normalizedExecution.dispatch.taskId || normalizedExecution.task.taskId !== normalizedExecution.binding.taskId) {
			throw new HarnessFault("Foundation execution task identity does not match the prompt context", undefined);
		}
		if (normalizedExecution.dispatch.bindingId !== normalizedExecution.binding.bindingId) {
			throw new HarnessFault("Foundation execution binding identity does not match the dispatch", undefined);
		}
		if (normalizedExecution.bindingEpochIds.length === 0 || normalizedExecution.bindingEpochIds.some((id) => id.length === 0) || !normalizedExecution.bindingEpochIds.includes(normalizedExecution.initialBindingEpoch.bindingEpochId)) {
			throw new HarnessFault("Foundation execution requires at least one binding epoch", undefined);
		}
		if (normalizedExecution.providerId.length === 0) throw new HarnessFault("Foundation execution requires a provider identity", undefined);
		if (provider.providerClass === "agent") {
			if (normalizedExecution.agentInstanceId === undefined || normalizedExecution.agentInstanceId.length === 0 || normalizedExecution.agentInstance === undefined) throw new HarnessFault("Agent provider execution requires a durable AgentInstance", undefined);
			if (normalizedExecution.initialBindingEpoch.agentInstanceId !== normalizedExecution.agentInstanceId) throw new HarnessFault("Foundation execution epoch does not match its AgentInstance", undefined);
			if (agentResult === undefined || !agentResult.ok || agentResult.value.agentInstanceId !== normalizedExecution.agentInstanceId || agentResult.value.taskId !== normalizedExecution.task.taskId || agentResult.value.providerId !== normalizedExecution.providerId) throw new HarnessFault("Foundation execution AgentInstance does not match its provider, task, or epoch", undefined);
		} else if (normalizedExecution.agentInstanceId !== undefined || normalizedExecution.agentInstance !== undefined || normalizedExecution.initialBindingEpoch.agentInstanceId !== undefined) {
			throw new HarnessFault("Operation/non-agent provider execution cannot carry an AgentInstance", undefined);
		}
		if (normalizedExecution.initialBindingEpoch.taskId !== normalizedExecution.task.taskId || normalizedExecution.initialBindingEpoch.bindingId !== normalizedExecution.binding.bindingId || normalizedExecution.initialBindingEpoch.attemptId.length === 0) throw new HarnessFault("Foundation execution epoch does not match its task or binding", undefined);
		const metadata = await this.durableSession.getMetadata();
		this.foundationSessionId = metadata.id;
		try {
			await this.ledger.writer.ensureLease();
		} catch (error) {
			throw new HarnessFault("Failed to acquire the Foundation session writer lease", error);
		}
		if (this.toolPipeline === undefined) {
			const registry = this.createToolRegistry();
			const storage = new SessionToolPipelineStorage({
				ledger: this.durableSession,
				laneId: "main",
				correlationFor: (_kind, value) => this.toolCorrelation(value),
				fencingToken: async () => (await this.ledger.writer.ensureLease()).fencingToken,
			});
			const pipelineOptions = this.toolPipelineOptions ?? {};
			const quotaAccount = pipelineOptions.quotaAccount ?? new FoundationToolQuotaAccount({
				budget: normalizedExecution.binding.budget,
				maxToolCalls: pipelineOptions.maxToolCalls,
				idGenerator: pipelineOptions.idGenerator,
				now: pipelineOptions.now,
			});
			const durableAuthority = (field: string, objectType: string) => async (scope: ToolGateScope) => {
				const source = scope.context.binding.sourceTrace.find((candidate) => candidate.field === field);
				const reference = {
					schemaVersion: 1 as const,
					type: objectType,
					id: source?.referenceId ?? `missing:${field}`,
					revision: source?.revision ?? 0,
				};
				const fact = source === undefined ? undefined : await this.durableSession.getFoundationObject(objectType, source.referenceId);
				return Result.ok({
					allowed: fact?.kind === "fact" && fact.revision === source?.revision,
					reference,
					...(fact?.kind === "fact" && fact.revision === source?.revision ? {} : { reason: `${field} guard authority is not durably bound` }),
				});
			};
			const guard = pipelineOptions.guard ?? new FoundationToolGuard({
				policy: { check: durableAuthority("policy", "policy_binding") },
				approval: { check: durableAuthority("gate", "task_gate_binding") },
				sandbox: { check: durableAuthority("sandbox", "sandbox_binding") },
				quota: { account: quotaAccount },
			});
			this.toolPipeline = new FoundationToolPipeline({
				...pipelineOptions,
				registry,
				storage,
				quotaAccount,
				guard,
			});
		}
	}

	/**
	 * Activate the next immutable Prompt Task identity on this Harness.
	 *
	 * The Harness remains the single long-lived loop, queue, transcript, signal,
	 * and event authority. Rebinding is allowed only at an idle boundary; product
	 * entry points cannot create a second Harness for the next prompt.
	 */
	async activateFoundationExecution(
		execution: AgentHarnessFoundationExecution,
		provider?: TaskExecutorProvider,
	): Promise<void> {
		this.ensureOpen();
		await this.drainMutations("main");
		await this.refreshSnapshots();
		const mainQueues = this.laneSnapshots.get("main")?.queues;
		const hasQueuedMessages = mainQueues !== undefined && (mainQueues.steer.length > 0 || mainQueues.followUp.length > 0);
		if (this.activeOperations.size > 0 || this.sessionSnapshot.lanes.some((lane) => lane.operation !== null) || hasQueuedMessages) {
			throw new HarnessFault("Foundation execution can change only at an idle queue boundary", undefined);
		}
		const previous = this.foundationExecution;
		const previousProvider = this.foundationProvider;
		this.foundationExecution = structuredClone(execution);
		this.foundationProvider = provider ?? previousProvider;
		try {
			await this.initializeFoundationExecution();
		} catch (error) {
			this.foundationExecution = previous;
			this.foundationProvider = previousProvider;
			throw error;
		}
	}

	private async releaseOwnedLedgerLease(): Promise<void> {
		if (this.ownsLedger) await this.ledger.writer.releaseLease();
	}

	private foundationCorrelation(lane: string, runId: string, fields: Partial<ExecutionCorrelation> = {}): ExecutionCorrelation | undefined {
		const execution = this.foundationExecution;
		if (execution === undefined || this.foundationSessionId === undefined) return undefined;
		return createExecutionCorrelation(this.foundationSessionId, lane, {
			bindingId: execution.binding.bindingId,
			bindingEpochId: execution.initialBindingEpoch.bindingEpochId,
			...(execution.agentInstanceId === undefined ? {} : { agentInstanceId: execution.agentInstanceId }),
			goalId: execution.task.goalId,
			taskId: execution.task.taskId,
			dispatchId: execution.dispatch.dispatchId,
			operationId: runId,
			providerId: execution.providerId,
			runId,
			...fields,
			revision: 0,
		});
	}

	private toolCorrelation(value: ToolIntent | ToolReceipt): ExecutionCorrelation {
		const binding = value.binding;
		if (binding.sessionId === undefined || binding.laneId === undefined || binding.runId === undefined || binding.operationId === undefined || binding.attemptId === undefined || binding.providerId === undefined) {
			throw new HarnessFault("Tool pipeline correlation is missing a complete execution identity", undefined);
		}
		return createExecutionCorrelation(binding.sessionId, binding.laneId, {
			bindingId: binding.bindingId,
			bindingEpochId: binding.bindingEpochId,
			taskId: binding.taskId,
			dispatchId: binding.dispatchId,
			operationId: binding.operationId,
			runId: binding.runId,
			attemptId: binding.attemptId,
			providerId: binding.providerId,
			agentInstanceId: binding.agentInstanceId,
			toolCallId: value.toolCallId,
			revision: 0,
		});
	}

	private foundationIds(runId: string): { attemptId: string; attemptReceiptId: string; taskResultId: string; runReceiptId: string } {
		return {
			attemptId: `attempt_${runId}`,
			attemptReceiptId: `attempt_receipt_${runId}`,
			taskResultId: `task_result_${runId}`,
			runReceiptId: `run_receipt_${runId}`,
		};
	}

	private foundationJson(value: unknown, description: string): FoundationJsonValue {
		try {
			assertJsonSerializable(value);
			return structuredClone(value) as FoundationJsonValue;
		} catch (error) {
			throw new HarnessFault(`Foundation ${description} is not JSON serializable`, error);
		}
	}

	private foundationModelRoute(model?: Model<Api>): FoundationJsonValue {
		const execution = this.foundationExecution;
		if (execution === undefined) throw new HarnessFault("Foundation model route requested without execution authority", undefined);
		return this.foundationJson({
			...execution.binding.modelRoute,
			...(model === undefined ? {} : { provider: model.provider, model: model.id }),
			budget: { ...execution.binding.budget },
		}, "model invocation route");
	}

	private async foundationModelInvocationRecords(runId: string): Promise<Exclude<FoundationRecord, { readonly kind: "retention" }>[]> {
		return (await this.durableSession.findFoundationRecords({ objectType: "model_invocation", includePruned: true, order: "oldestFirst" })).filter((record): record is Exclude<FoundationRecord, { readonly kind: "retention" }> => record.kind !== "retention" && record.correlation.runId === runId);
	}

	private async foundationModelBindingInvocationRecords(): Promise<Exclude<FoundationRecord, { readonly kind: "retention" }>[]> {
		const execution = this.foundationExecution;
		if (execution === undefined) return [];
		return (await this.durableSession.findFoundationRecords({ objectType: "model_invocation", includePruned: true, order: "oldestFirst" })).filter((record): record is Exclude<FoundationRecord, { readonly kind: "retention" }> => record.kind !== "retention" && record.correlation.taskId === execution.task.taskId && record.correlation.bindingId === execution.binding.bindingId);
	}

	private foundationModelUsage(records: readonly Exclude<FoundationRecord, { readonly kind: "retention" }>[]): FoundationModelUsageSummary {
		const usage: FoundationModelUsageSummary = { modelCalls: 0, input: 0, output: 0, totalTokens: 0, costUsd: 0 };
		for (const record of records) {
			if (record.kind !== "fact") continue;
			const payload = asRecord(record.payload);
			const terminalUsage = payload === undefined ? undefined : asRecord(payload.usage);
			usage.modelCalls += typeof payload?.modelCalls === "number" ? payload.modelCalls : 1;
			usage.input += typeof terminalUsage?.input === "number" ? terminalUsage.input : 0;
			usage.output += typeof terminalUsage?.output === "number" ? terminalUsage.output : 0;
			usage.totalTokens += typeof terminalUsage?.totalTokens === "number" ? terminalUsage.totalTokens : 0;
			const cost = asRecord(terminalUsage?.cost);
			usage.costUsd += typeof cost?.total === "number" ? cost.total : 0;
		}
		return usage;
	}

	private async foundationRunUsage(lane: string, runId: string): Promise<RunReceiptUsage> {
		const usage: RunReceiptUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
		for (const record of await this.durableSession.findRecords({ lane, runId, type: "usage", order: "oldestFirst" })) {
			usage.inputTokens += record.usage.input;
			usage.outputTokens += record.usage.output;
			usage.totalTokens += record.usage.totalTokens;
		}
		return usage;
	}

	private foundationModelBudget(usage: FoundationModelUsageSummary): { readonly remainingOutputTokens?: number } {
		const budget = this.foundationExecution?.binding.budget ?? {};
		const exhausted = budget.modelCalls !== undefined && usage.modelCalls >= budget.modelCalls
			? "model_calls"
			: budget.tokens !== undefined && usage.totalTokens >= budget.tokens
				? "tokens"
				: budget.costUsd !== undefined && usage.costUsd >= budget.costUsd
					? "cost"
					: undefined;
		if (exhausted !== undefined) throw new FoundationError("budget_exhausted", `Foundation model budget exhausted: ${exhausted}`, { details: { reason: exhausted, modelCalls: usage.modelCalls, input: usage.input, output: usage.output, totalTokens: usage.totalTokens } });
		return budget.tokens === undefined ? {} : { remainingOutputTokens: Math.max(0, budget.tokens - usage.totalTokens) };
	}

	private modelInvocationOptions(options: SimpleStreamOptions | undefined, remainingOutputTokens: number | undefined): SimpleStreamOptions | undefined {
		if (remainingOutputTokens === undefined) return options;
		const maxTokens = options?.maxTokens === undefined ? remainingOutputTokens : Math.min(options.maxTokens, remainingOutputTokens);
		return { ...(options ?? {}), maxTokens };
	}

	private async recoverOrphanedModelInvocation(intent: Exclude<FoundationRecord, { readonly kind: "retention" }> & { readonly kind: "intent" }): Promise<void> {
		const payload = asRecord(intent.payload);
		const route = payload?.route;
		const invocationId = typeof payload?.invocationId === "string" ? payload.invocationId : intent.objectId;
		const turnId = typeof payload?.turnId === "string" ? payload.turnId : `turn:recovery:${invocationId}`;
		const execution = this.foundationExecution;
		const bindingDigest = typeof payload?.bindingDigest === "string" ? payload.bindingDigest : execution?.binding.fingerprint.value ?? "recovery-required";
		const routeValue = this.foundationJson(route ?? {}, "orphaned model invocation route");
		const routeRecord = asRecord(routeValue);
		const selectedTarget = this.foundationJson({ provider: typeof routeRecord?.provider === "string" ? routeRecord.provider : "unknown", model: typeof routeRecord?.model === "string" ? routeRecord.model : "unknown" }, "orphaned model invocation target");
		const correlation: ExecutionCorrelation = {
			...intent.correlation,
			...(intent.correlation.roleRevisionId === undefined && execution === undefined ? {} : { roleRevisionId: intent.correlation.roleRevisionId ?? execution?.binding.roleRevision.id }),
			...(intent.correlation.modelProfileId === undefined && execution === undefined ? {} : { modelProfileId: intent.correlation.modelProfileId ?? execution?.binding.modelProfileRevision.id }),
			...(intent.correlation.modelProfileRevisionId === undefined && execution === undefined ? {} : { modelProfileRevisionId: intent.correlation.modelProfileRevisionId ?? execution?.binding.modelProfileRevision.id }),
			...(intent.correlation.bindingEpochId === undefined && execution === undefined ? {} : { bindingEpochId: intent.correlation.bindingEpochId ?? execution?.initialBindingEpoch.bindingEpochId }),
			...(intent.correlation.agentInstanceId === undefined && execution?.agentInstanceId === undefined ? {} : { agentInstanceId: intent.correlation.agentInstanceId ?? execution?.agentInstanceId }),
			turnId,
			revision: 0,
		};
		const invocation: FoundationModelInvocation = {
			invocationId,
			turnId,
			ordinal: 0,
			bindingDigest,
			route: routeValue,
			routeDigest: sha256HexValue(canonicalFoundationJson(routeValue)),
			selectedTarget,
			...(typeof payload?.contextSnapshotId === "string" ? { contextSnapshotId: payload.contextSnapshotId } : {}),
			correlation: correlation as unknown as ExecutionCorrelation,
		};
		await this.persistFoundationModelInvocationFact(invocation, "unknown", emptyModelUsage(), "recovery_required", "unknown", "model_invocation_recovery_required", "A model invocation intent had no terminal fact during recovery");
	}

	private async prepareFoundationModelInvocation(lane: string, runId: string, model?: Model<Api>): Promise<FoundationModelInvocationPreparation> {
		const execution = this.foundationExecution;
		if (execution === undefined) throw new HarnessFault("Foundation model invocation requested without execution authority", undefined);
		const records = await this.foundationModelInvocationRecords(runId);
		const usage = this.foundationModelUsage(await this.foundationModelBindingInvocationRecords());
		const intents = records.filter((record) => record.kind === "intent");
		for (const [index, intent] of intents.entries()) {
			const fact = records.find((record) => record.kind === "fact" && record.objectId === intent.objectId);
			const status = fact?.kind === "fact" ? asRecord(fact.payload)?.status : undefined;
			if (fact === undefined) {
				await this.recoverOrphanedModelInvocation(intent);
				throw new FoundationError("model_invocation_recovery_required", "A model invocation intent had no terminal fact during recovery");
			}
			const supersededBySuccess = intents.slice(index + 1).some((laterIntent) => {
				const laterFact = records.find((record) => record.kind === "fact" && record.objectId === laterIntent.objectId);
				return laterFact?.kind === "fact" && asRecord(laterFact.payload)?.status === "succeeded";
			});
			if (status === "pending" || (status === "unknown" && this.retryAttemptValue === 0 && !supersededBySuccess)) throw new FoundationError("model_invocation_recovery_required", "A pending or unknown model invocation cannot be replayed");
		}
		const budget = this.foundationModelBudget(usage);
		const ordinal = intents.length;
		const invocationId = `${runId}:model:${ordinal}`;
		const turnId = `turn:${runId}:${ordinal}`;
		const correlation = this.foundationCorrelation(lane, runId, {
			attemptId: execution.initialBindingEpoch.attemptId,
			turnId,
			roleRevisionId: execution.binding.roleRevision.id,
			modelProfileId: execution.binding.modelProfileRevision.id,
			modelProfileRevisionId: execution.binding.modelProfileRevision.id,
		});
		if (correlation === undefined) throw new HarnessFault("Missing execution correlation for model invocation", undefined);
		const route = this.foundationModelRoute(model);
		const contextSnapshotId = this.contextSnapshotIdForOperation?.(runId, "agent_turn");
		const invocation: FoundationModelInvocation = {
			invocationId,
			turnId,
			ordinal,
			bindingDigest: execution.binding.fingerprint.value,
			route,
			routeDigest: sha256HexValue(canonicalFoundationJson(route)),
			selectedTarget: this.foundationJson({
				provider: model?.provider ?? execution.binding.modelRoute.provider,
				model: model?.id ?? execution.binding.modelRoute.model,
			}, "model invocation selected target"),
			...(contextSnapshotId === undefined ? {} : { contextSnapshotId }),
			correlation,
		};
		const existing = records.filter((record) => record.objectId === invocationId);
		const existingIntent = existing.find((record) => record.kind === "intent");
		if (existingIntent !== undefined) {
			const payload = asRecord(existingIntent.payload);
			const matches = payload !== undefined
				&& payload.invocationId === invocationId
				&& payload.turnId === turnId
				&& payload.bindingDigest === invocation.bindingDigest
				&& payload.routeDigest === invocation.routeDigest
				&& canonicalFoundationJson(payload.selectedTarget) === canonicalFoundationJson(invocation.selectedTarget)
				&& canonicalFoundationJson(payload.route) === canonicalFoundationJson(invocation.route)
				&& payload.contextSnapshotId === invocation.contextSnapshotId
				&& canonicalFoundationJson(payload.correlation) === canonicalFoundationJson(invocation.correlation);
			if (!matches) throw new HarnessFault("Existing model invocation intent conflicts with its immutable reconstruction", undefined);
			const fact = existing.find((record) => record.kind === "fact");
			const factStatus = fact?.kind === "fact" ? asRecord(fact.payload)?.status : undefined;
			if (factStatus !== "succeeded") throw new FoundationError("model_invocation_recovery_required", "A pending or unknown model invocation cannot be replayed");
			throw new FoundationError("model_invocation_recovery_required", "A completed model invocation has no durable assistant replay");
		}
		await this.appendFoundation({
			schemaVersion: 1,
			kind: "intent",
			id: `model_invocation_intent:${invocationId}`,
			lane,
			objectType: "model_invocation",
			objectId: invocationId,
			clientRequestId: `model-invocation:${invocationId}`,
			intent: "create",
			payload: this.foundationJson({ schemaVersion: 1, invocationId, status: "pending", turnId, bindingDigest: invocation.bindingDigest, routeDigest: invocation.routeDigest, selectedTarget: invocation.selectedTarget, route: invocation.route, ...(invocation.contextSnapshotId === undefined ? {} : { contextSnapshotId: invocation.contextSnapshotId }), correlation }, "model invocation intent"),
			correlation,
		});
		return { invocation, ...budget };
	}

	private async persistFoundationModelInvocationFact(
		invocation: FoundationModelInvocation,
		status: FoundationModelInvocationStatus,
		usage: Usage,
		stopReason?: string,
		sideEffectState: SideEffectState = status === "succeeded" ? "none" : "unknown",
		errorCode?: string,
		errorMessage?: string,
	): Promise<void> {
		const existing = await this.durableSession.findFoundationRecords({ objectType: "model_invocation", objectId: invocation.invocationId, kind: "fact", includePruned: true, order: "oldestFirst" });
		const payload = this.foundationJson({
			schemaVersion: 1,
			invocationId: invocation.invocationId,
			status,
			modelCalls: 1,
			usage: this.foundationJson(usage, "model invocation usage"),
			turnId: invocation.turnId,
			bindingDigest: invocation.bindingDigest,
			routeDigest: invocation.routeDigest,
			selectedTarget: invocation.selectedTarget,
			route: invocation.route,
			...(invocation.contextSnapshotId === undefined ? {} : { contextSnapshotId: invocation.contextSnapshotId }),
			correlation: invocation.correlation,
			sideEffectState,
			...(stopReason === undefined ? {} : { stopReason }),
			...(errorCode === undefined ? {} : { errorCode }),
			...(errorMessage === undefined ? {} : { errorMessage }),
		}, "model invocation fact");
		const prior = existing[0];
		if (prior !== undefined) {
			if (prior.kind !== "fact" || canonicalFoundationJson(prior.payload) !== canonicalFoundationJson(payload)) throw new HarnessFault("Model invocation fact conflicts with its immutable replay", undefined);
			return;
		}
		const expectedRevision = await this.durableSession.getFoundationRevision("model_invocation", invocation.invocationId);
		if (expectedRevision < 1) throw new HarnessFault("Model invocation fact has no durable intent", undefined);
		await this.appendFoundation({
			schemaVersion: 1,
			kind: "fact",
			id: `model_invocation_fact:${invocation.invocationId}`,
			lane: invocation.correlation.laneId,
			objectType: "model_invocation",
			objectId: invocation.invocationId,
			clientRequestId: `model-invocation:fact:${invocation.invocationId}`,
			expectedRevision,
			fencingToken: (await this.ledger.writer.ensureLease()).fencingToken,
			correlation: invocation.correlation,
			payload,
		});
	}

	private async foundationModelPreflightError(lane: string, runId: string): Promise<FoundationError | undefined> {
		const execution = this.foundationExecution;
		if (execution === undefined) return undefined;
		try {
			const prepared = await this.contextForOperation(lane, runId);
			const context: Context = {
				systemPrompt: prepared.context.systemPrompt,
				messages: await this.toProviderMessages(prepared.context.messages),
			};
			return this.foundationModelCallAdapter.validate({ route: execution.binding.modelRoute, model: prepared.model, context, options: this.streamOptions, budget: execution.binding.budget });
		} catch (_error) {
			return undefined;
		}
	}

	private async foundationModelInvocationBlocksSettlement(lane: string, runId: string): Promise<boolean> {
		if (this.foundationExecution === undefined) return false;
		const records = await this.foundationModelInvocationRecords(runId);
		if (records.length === 0) {
			try {
				this.foundationModelBudget(this.foundationModelUsage(await this.foundationModelBindingInvocationRecords()));
			} catch (error) {
				if (error instanceof FoundationError) return true;
				throw error;
			}
			if (await this.foundationModelPreflightError(lane, runId) !== undefined) return true;
		}
		const latestIntent = records.filter((record) => record.kind === "intent").at(-1);
		if (latestIntent === undefined) return false;
		const fact = records.find((record) => record.kind === "fact" && record.objectId === latestIntent.objectId);
		return fact === undefined || (fact.kind === "fact" && asRecord(fact.payload)?.status !== "succeeded");
	}

	private async foundationModelTerminalError(runId: string): Promise<OperationError | undefined> {
		const facts = (await this.foundationModelInvocationRecords(runId)).filter((record) => record.kind === "fact");
		const latest = facts.at(-1);
		if (latest === undefined || latest.kind !== "fact") return undefined;
		const payload = asRecord(latest.payload);
		const status = payload?.status;
		const code = payload?.errorCode;
		if ((status !== "failed" && status !== "unknown") || typeof code !== "string") return undefined;
		return { code, message: typeof payload?.errorMessage === "string" ? payload.errorMessage : "Foundation model invocation failed" };
	}

	private foundationModelDiagnosticError(message: AssistantMessage): OperationError | undefined {
		const diagnostic = message.diagnostics?.find((candidate) => candidate.type === "foundation_model_call");
		const code = diagnostic?.error?.code;
		return typeof code === "string" ? { code, message: diagnostic?.error?.message ?? message.errorMessage ?? "Foundation model invocation failed" } : undefined;
	}

	private async dispatchFoundationModel(lane: string, runId: string, model: Model<Api>, context: Context, options?: SimpleStreamOptions): Promise<AssistantMessageEventStream> {
		const preparedRequest = this.streamRequestPreparation === undefined
			? { model, options }
			: await this.streamRequestPreparation({ model, options });
		model = preparedRequest.model;
		options = preparedRequest.options;
		if (this.foundationExecution === undefined) return this.streamFunctionValue?.(model, context, options) ?? this.models.streamSimple(model, context, options);
		const bindingRoute = this.foundationExecution.binding.modelRoute;
		const route = this.modelCallBoundary === undefined
			? bindingRoute
			: { ...bindingRoute, provider: model.provider, model: model.id };
		const modelRequest = { route, model, context, options, budget: this.foundationExecution.binding.budget };
		const validationError = this.foundationModelCallAdapter.validate(modelRequest);
		if (validationError !== undefined) return foundationModelCallErrorStream(validationError, model);
		let preparation: FoundationModelInvocationPreparation;
		try {
			preparation = await this.prepareFoundationModelInvocation(lane, runId, this.modelCallBoundary === undefined ? undefined : model);
		} catch (error) {
			if (error instanceof FoundationError) return foundationModelCallErrorStream(error, model);
			throw error;
		}
		const invocation = preparation.invocation;
		const callOptions = this.modelInvocationOptions(options, preparation.remainingOutputTokens);
		let source: AssistantMessageEventStream;
		try {
			source = await this.foundationModelCallAdapter.stream({ ...modelRequest, options: callOptions });
		} catch (error) {
			const foundationError = error instanceof FoundationError ? error : toFoundationError(error, "unsupported_feature");
			await this.persistFoundationModelInvocationFact(invocation, "failed", emptyModelUsage(), "error", "unknown", foundationError.code, foundationError.message);
			return foundationModelCallErrorStream(foundationError, model);
		}
		const output = createAssistantMessageEventStream();
		void (async () => {
			let visibleOutput = false;
			try {
				for await (const event of source) {
					if (
						event.type === "toolcall_start"
						|| event.type === "toolcall_delta"
						|| event.type === "toolcall_end"
						|| (event.type === "text_delta" && event.delta.length > 0)
						|| (event.type === "thinking_delta" && event.delta.length > 0)
					) visibleOutput = true;
					if (event.type === "done") {
						const status: FoundationModelInvocationStatus = event.message.stopReason === "aborted" ? "unknown" : event.message.stopReason === "error" ? "failed" : "succeeded";
						await this.persistFoundationModelInvocationFact(invocation, status, event.message.usage, event.message.stopReason, status === "succeeded" ? "none" : "unknown", status === "failed" ? "provider_error" : status === "unknown" ? "model_stream_unknown" : undefined, event.message.errorMessage);
						output.push({ ...event, message: durableAssistantMessage(event.message) });
						output.end();
						return;
					}
					if (event.type === "error") {
						await this.persistFoundationModelInvocationFact(
							invocation,
							visibleOutput ? "unknown" : "failed",
							event.error.usage,
							"error",
							visibleOutput ? "unknown" : "none",
							visibleOutput ? "model_stream_unknown" : "provider_error",
							event.error.errorMessage,
						);
						output.push({ ...event, error: durableAssistantMessage(event.error) });
						output.end();
						return;
					}
					output.push(event);
				}
				await this.persistFoundationModelInvocationFact(invocation, "unknown", emptyModelUsage(), "unknown", "unknown", "model_stream_unknown", "Model stream ended without a terminal event");
				const failure = foundationModelCallErrorStream(new FoundationError("side_effect_unknown", "Model stream ended without a terminal event"), model);
				for await (const event of failure) output.push(event);
				output.end();
			} catch (error) {
				await this.persistFoundationModelInvocationFact(invocation, "unknown", emptyModelUsage(), "unknown", "unknown", "model_stream_unknown", "Model stream execution state is unknown");
				const foundationError = error instanceof FoundationError ? error : new FoundationError("side_effect_unknown", "Model stream execution state is unknown", { cause: error });
				const failure = foundationModelCallErrorStream(foundationError, model);
				for await (const event of failure) output.push(event);
				output.end();
			}
		})();
		return output;
	}

	private async streamFoundationModel(lane: string, runId: string, model: Model<Api>, context: Context, options?: SimpleStreamOptions): Promise<AssistantMessageEventStream> {
		if (this.modelCallBoundary === undefined) {
			return this.dispatchFoundationModel(lane, runId, model, context, options);
		}
		return this.modelCallBoundary({
			lane,
			runId,
			model,
			context,
			options,
			prepareContext: async (attemptModel) => {
				const baseContext = this.operationContextInputs.get(runId);
				if (baseContext === undefined || this.contextPreparation === undefined) return context;
				const prepared = await this.contextPreparation({
					purpose: "agent_turn",
					operationId: runId,
					model: attemptModel,
					context: {
						...baseContext,
						messages: [...baseContext.messages],
					},
					signal: options?.signal,
				});
				return {
					...prepared,
					messages: await this.toProviderMessages(prepared.messages),
				};
			},
			invoke: (attemptModel, attemptContext, attemptOptions) =>
				this.dispatchFoundationModel(lane, runId, attemptModel, attemptContext, attemptOptions),
		});
	}

	private completionProvider(lane: string, runId: string): Pick<Models, "completeSimple"> {
		if (this.foundationExecution === undefined && this.streamRequestPreparation === undefined) return this.models;
		return {
			completeSimple: async (model, context, options) =>
				(await this.streamFoundationModel(lane, runId, model, context, options)).result(),
		};
	}

	private async appendFoundation(record: ProvisionedFoundationRecord): Promise<FoundationRecord> {
		if (this.foundationExecution === undefined) throw new HarnessFault("Foundation execution is not initialized", undefined);
		const result = await this.ledger.writer.appendFoundationRecord(record);
		return result.record;
	}

	private async persistFoundationIntent(lane: string, runId: string): Promise<void> {
		if (this.foundationExecution === undefined) return;
		const ids = this.foundationIds(runId);
		const correlation = this.foundationCorrelation(lane, runId, { attemptId: ids.attemptId });
		if (correlation === undefined) throw new HarnessFault("Missing execution correlation for Foundation intent", undefined);
		const clientRequestId = `harness:intent:${runId}`;
		const payload = this.foundationJson({
			schemaVersion: 1,
			attemptId: ids.attemptId,
			taskId: this.foundationExecution.task.taskId,
				dispatchId: this.foundationExecution.dispatch.dispatchId,
				bindingId: this.foundationExecution.binding.bindingId,
				bindingEpochIds: [...this.foundationExecution.bindingEpochIds],
				...(this.foundationExecution.agentInstanceId === undefined ? {} : { agentInstanceId: this.foundationExecution.agentInstanceId }),
			runId,
		}, "intent payload");
		const existing = (await this.durableSession.findFoundationRecords({ kind: "intent", includePruned: true, order: "oldestFirst" }))
			.find((record) => record.kind === "intent" && (record.clientRequestId === clientRequestId || (record.objectType === "attempt" && record.objectId === ids.attemptId)));
		if (existing !== undefined && existing.kind === "intent") {
			const { revision: _existingRevision, fencingToken: _existingFencingToken, ...existingCorrelation } = existing.correlation;
			const { revision: _expectedRevision, fencingToken: _expectedFencingToken, ...expectedCorrelation } = correlation;
			const matches = existing.id === `attempt_intent:${runId}`
				&& existing.lane === lane
				&& existing.objectType === "attempt"
				&& existing.objectId === ids.attemptId
				&& existing.clientRequestId === clientRequestId
				&& existing.intent === "create"
				&& existing.payload !== undefined
				&& canonicalFoundationJson(existing.payload) === canonicalFoundationJson(payload)
				&& canonicalFoundationJson(existingCorrelation) === canonicalFoundationJson(expectedCorrelation);
			if (matches) return;
			throw new HarnessFault("Existing Foundation intent conflicts with its deterministic reconstruction", undefined);
		}
		await this.appendFoundation({
			schemaVersion: 1,
			kind: "intent",
			id: `attempt_intent:${runId}`,
			lane,
			objectType: "attempt",
			objectId: ids.attemptId,
			clientRequestId,
			intent: "create",
			payload,
			correlation,
		});
	}

	private async ensureFoundationIntentForOperation(lane: string, runId: string): Promise<void> {
		if (this.foundationExecution === undefined) return;
		const ids = this.foundationIds(runId);
		await this.persistFoundationIntent(lane, runId);
		const records = await this.durableSession.findFoundationRecords({ kind: "intent", objectType: "attempt", objectId: ids.attemptId, includePruned: true, order: "oldestFirst" });
		const intent = records.find((record) => record.kind === "intent" && record.clientRequestId === `harness:intent:${runId}`);
		if (intent === undefined || intent.kind !== "intent") throw new HarnessFault(`Foundation intent is missing for operation ${runId}`, undefined);
		const payload = intent.payload;
		if (payload === undefined || asRecord(payload)?.runId !== runId) throw new HarnessFault(`Foundation intent is invalid for operation ${runId}`, undefined);
	}

	private async startFoundationAttempt(lane: string, runId: string): Promise<void> {
		const execution = this.foundationExecution;
		const provider = this.foundationProvider;
		if (execution === undefined || provider === undefined) return;
		const correlation = this.foundationCorrelation(lane, runId, { attemptId: execution.initialBindingEpoch.attemptId });
		if (correlation === undefined) throw new HarnessFault("Missing execution correlation while starting Foundation Attempt", undefined);
		const settlement = new LayeredResultSettlement(this.durableSession, { ownerId: this.foundationOwnerId, writer: this.ledger.writer });
		const started = await settlement.startDispatch({ provider, dispatch: execution.dispatch, binding: execution.binding, initialBindingEpoch: execution.initialBindingEpoch, ...(execution.agentInstance === undefined ? {} : { agentInstance: execution.agentInstance }), correlation });
		if (!started.ok) throw new HarnessFault(`Trusted provider consumer rejected Foundation Attempt start: ${started.error.message}`, started.error);
	}

	private async resumeFoundationAttempt(lane: string, runId: string): Promise<void> {
		const execution = this.foundationExecution;
		const provider = this.foundationProvider;
		if (execution === undefined || provider === undefined) return;
		if (await this.foundationModelInvocationBlocksSettlement(lane, runId)) return;
		const correlation = this.foundationCorrelation(lane, runId, { attemptId: execution.initialBindingEpoch.attemptId });
		if (correlation === undefined) throw new HarnessFault("Missing execution correlation while resuming Foundation Attempt", undefined);
		const settlement = new LayeredResultSettlement(this.durableSession, { ownerId: this.foundationOwnerId, writer: this.ledger.writer });
		const resumed = await settlement.resumeDispatch({ provider, dispatch: execution.dispatch, binding: execution.binding, initialBindingEpoch: execution.initialBindingEpoch, ...(execution.agentInstance === undefined ? {} : { agentInstance: execution.agentInstance }), correlation });
		if (!resumed.ok) throw new HarnessFault(`Trusted provider consumer rejected Foundation Attempt resume: ${resumed.error.message}`, resumed.error);
	}

	private async cancelFoundationAttempt(lane: string, runId: string): Promise<void> {
		const execution = this.foundationExecution;
		const provider = this.foundationProvider;
		if (execution === undefined || provider === undefined) return;
		const correlation = this.foundationCorrelation(lane, runId, { attemptId: execution.initialBindingEpoch.attemptId });
		if (correlation === undefined) throw new HarnessFault("Missing execution correlation while cancelling Foundation Attempt", undefined);
		const settlement = new LayeredResultSettlement(this.durableSession, { ownerId: this.foundationOwnerId, writer: this.ledger.writer });
		const cancelled = await settlement.cancelAttempt({ provider, dispatch: execution.dispatch, binding: execution.binding, initialBindingEpoch: execution.initialBindingEpoch, ...(execution.agentInstance === undefined ? {} : { agentInstance: execution.agentInstance }), correlation });
		if (!cancelled.ok) throw new HarnessFault(`Trusted provider consumer rejected Foundation Attempt cancellation: ${cancelled.error.message}`, cancelled.error);
	}

	private async persistFoundationReceipts(
		lane: string,
		runId: string,
		outcome: "completed" | "declined" | "failed" | "aborted",
		error?: OperationError,
	): Promise<FoundationReceiptBundle | undefined> {
		if (this.foundationExecution === undefined) return undefined;
		const execution = this.foundationExecution;
		const provider = this.foundationProvider;
		if (provider === undefined) throw new HarnessFault("Foundation execution requires a trusted provider consumer", undefined);
		if (this.compatibilityWriter === undefined && await this.foundationModelInvocationBlocksSettlement(lane, runId)) return undefined;
		const correlation = this.foundationCorrelation(lane, runId, { attemptId: execution.initialBindingEpoch.attemptId });
		if (correlation === undefined) throw new HarnessFault("Missing execution correlation for provider consumption", undefined);
		const settlement = new LayeredResultSettlement(this.durableSession, { ownerId: this.foundationOwnerId, writer: this.ledger.writer });
		const executed = await settlement.executeDispatch({ provider, dispatch: execution.dispatch, binding: execution.binding, initialBindingEpoch: execution.initialBindingEpoch, ...(execution.agentInstance === undefined ? {} : { agentInstance: execution.agentInstance }), correlation });
		if (!executed.ok) throw new HarnessFault(`Trusted provider consumer rejected Foundation Dispatch: ${executed.error.message}`, executed.error);
		const attemptReceipt = executed.value.receipt;
		const authority = execution.hostAuthority;
		const settlementInput = execution.settlement;
		if (settlementInput === undefined || authority === undefined) return { attemptId: executed.value.attempt.attemptId, attemptReceipt, correlation };
		const taskResultId = `task_result_${runId}`;
		const producedAt = await this.foundationReceiptTimestamp(lane, runId);
		const settled = await settlement.settle({ taskResultId, task: execution.task, sourceAttemptReceiptIds: [attemptReceipt.attemptReceiptId], summary: settlementInput.summary ?? (outcome === "completed" ? "Agent run completed" : "Agent run did not complete successfully"), artifacts: settlementInput.artifacts, diff: settlementInput.diff, tests: settlementInput.tests ?? [], evidence: settlementInput.evidence ?? [], producer: { producerKind: "host", providerId: authority.authorityId, producedAt, correlation: { ...correlation, taskResultId, attemptReceiptId: attemptReceipt.attemptReceiptId } } });
		if (!settled.ok) throw new HarnessFault("Host settlement rejected provider TaskResult", settled.error);
		const finalStatus = outcome === "completed" && settled.value.status === "succeeded" ? "completed" : outcome === "aborted" ? "cancelled" : "failed";
		const usage = await this.foundationRunUsage(lane, runId);
		const terminalErrorCode = finalStatus === "completed" ? undefined : error?.code ?? (finalStatus === "cancelled" ? "user_aborted" : "agent_run_failed");
		const terminalError: PublicExecutionError | undefined = terminalErrorCode === undefined ? undefined : {
			code: terminalErrorCode,
			message: error?.message ?? (finalStatus === "cancelled" ? "Agent run was cancelled" : "Agent run failed"),
			category: terminalErrorCode === "side_effect_unknown" ? "side_effect_unknown" : finalStatus === "cancelled" ? "cancelled" : terminalErrorCode.includes("deadline") ? "deadline" : "unknown",
			retryable: false,
		};
		const finalized = await settlement.finalize({ runReceiptId: `run_receipt_${runId}`, runId, terminalStatus: finalStatus, authority, attemptReceiptIds: [attemptReceipt.attemptReceiptId], taskResultId: settled.value.taskResultId, usage, ...(terminalErrorCode === undefined || terminalError === undefined ? {} : { terminalErrorCode, terminalError }), completedAt: producedAt });
		if (!finalized.ok) throw new HarnessFault("Host terminal gate rejected provider RunReceipt", finalized.error);
		return { attemptId: executed.value.attempt.attemptId, attemptReceipt, taskResult: settled.value, runReceipt: finalized.value, correlation };
	}

	private async foundationToolOutcome(lane: string, runId: string): Promise<FoundationToolOutcome> {
		const starts = await this.durableSession.findRecords({ lane, runId, type: "tool_started", order: "oldestFirst" });
		if (starts.length === 0) return { failed: false, sideEffectState: "none" };
		const startsByToolCallId = new Map<string, ToolStartedRecord>();
		let ledgerConflict = false;
		for (const start of starts) {
			const existing = startsByToolCallId.get(start.toolCallId);
			if (existing === undefined) {
				startsByToolCallId.set(start.toolCallId, start);
				continue;
			}
			if (toolStartedExecutionSemantics(existing) !== toolStartedExecutionSemantics(start)) ledgerConflict = true;
		}
		const receipts = new Map<string, ToolReceipt>();
		const correlation = this.foundationCorrelation(lane, runId);
		if (correlation !== undefined) {
			const startedToolCallIds = new Set(startsByToolCallId.keys());
			const { revision: _revision, goalId: _goalId, ...queryCorrelation } = correlation;
			const records = await this.durableSession.findFoundationRecords({ kind: "fact", objectType: "tool_receipt", includePruned: true, order: "oldestFirst", correlation: queryCorrelation });
			for (const record of records) {
				if (record.kind !== "fact") continue;
				const checked = validateAndVerifyToolReceipt(record.payload);
				if (!checked.ok) throw new HarnessFault("Persisted tool receipt failed validation", checked.error);
				if (!startedToolCallIds.has(checked.value.toolCallId)) throw new HarnessFault(`Persisted tool receipt ${checked.value.toolCallId} is not part of operation ${runId}`, undefined);
				const existing = receipts.get(checked.value.toolCallId);
				if (existing === undefined) {
					receipts.set(checked.value.toolCallId, checked.value);
					continue;
				}
				if (projectToolReceiptExecutionSemantics(existing) !== projectToolReceiptExecutionSemantics(checked.value)) ledgerConflict = true;
			}
		}
		let failed = false;
		let sideEffectState: SideEffectState = "none";
		let firstError: OperationError | undefined;
		const mergeSideEffectState = (state: SideEffectState): void => {
			if (state === "side_effect_unknown") sideEffectState = state;
			else if (state === "unknown" && sideEffectState === "none") sideEffectState = state;
		};
		const recordError = (candidate: OperationError): void => {
			if (firstError === undefined) firstError = candidate;
		};
		const markLedgerConflict = (): void => {
			ledgerConflict = true;
			failed = true;
			mergeSideEffectState("side_effect_unknown");
			firstError = { code: "session_ledger_conflict", message: "Durable tool execution records conflict for one operation and tool call" };
		};
		if (ledgerConflict) {
			markLedgerConflict();
		}
		for (const start of startsByToolCallId.values()) {
			const receipt = receipts.get(start.toolCallId);
			if (receipt === undefined) {
				failed = true;
				mergeSideEffectState("side_effect_unknown");
				recordError({ code: "side_effect_unknown", message: "Durable tool receipt is missing" });
			} else {
				mergeSideEffectState(receipt.sideEffectState);
				if (receipt.outcome === "succeeded" && receipt.result === undefined) {
					failed = true;
					mergeSideEffectState("side_effect_unknown");
					recordError({ code: "side_effect_unknown", message: "Durable tool result payload is missing" });
				} else if (
					(receipt.outcome !== "succeeded" || receipt.sideEffectState !== "none") &&
					!(receipt.outcome === "blocked" && receipt.sideEffectState === "none")
				) {
					failed = true;
					recordError({ code: receipt.error?.code ?? (receipt.sideEffectState === "side_effect_unknown" ? "side_effect_unknown" : "tool_execution_failed"), message: receipt.error?.message ?? `Tool ${start.toolName} did not complete successfully` });
				}
			}
			const result = await this.durableSession.getEntry(start.resultEntryId);
			const durableResult = receipt?.outcome === "succeeded" && receipt.sideEffectState === "none" ? receipt.result : undefined;
			if (durableResult !== undefined) {
				if (result?.type !== "custom" || result.customType !== FOUNDATION_TOOL_RESULT_CUSTOM_TYPE) {
					markLedgerConflict();
					continue;
				}
				const entryResult = validateFoundationToolResultEntry(result.data);
				if (!entryResult.ok || entryResult.value.runId !== runId || entryResult.value.operationId !== runId || entryResult.value.toolCallId !== start.toolCallId || entryResult.value.toolName !== start.toolName || canonicalFoundationJson(entryResult.value.result) !== canonicalFoundationJson(durableResult)) {
					markLedgerConflict();
				}
				continue;
			}
			if (result?.type === "custom" && result.customType === FOUNDATION_TOOL_RESULT_CUSTOM_TYPE) {
				const entryResult = validateFoundationToolResultEntry(result.data);
				if (!entryResult.ok || receipt?.outcome !== "succeeded" || receipt.result === undefined) markLedgerConflict();
				continue;
			}
			if (result?.type !== "message" || result.message.role !== "toolResult") {
				failed = true;
				mergeSideEffectState("side_effect_unknown");
				recordError({ code: "side_effect_unknown", message: "Durable tool result message is missing" });
			} else if (result.message.content.some((content) => content.type === "image")) {
				failed = true;
				mergeSideEffectState("side_effect_unknown");
				recordError({ code: "side_effect_unknown", message: "Durable image tool result is not ArtifactRef-backed" });
			} else if (result.message.isError && receipt?.outcome === "succeeded") {
				failed = true;
				if (receipt.outcome === "succeeded") {
					mergeSideEffectState("side_effect_unknown");
					if (receipt.result !== undefined) markLedgerConflict();
				}
				const textContent = result.message.content.find((content) => content.type === "text");
				recordError({ code: receipt?.error?.code ?? "tool_execution_failed", message: receipt?.error?.message ?? (textContent?.type === "text" ? textContent.text : `Tool ${start.toolName} failed`) });
			}
		}
		return { failed, sideEffectState, ...(firstError === undefined ? {} : { error: firstError }) };
	}

	private async foundationReceiptTimestamp(lane: string, runId: string): Promise<string> {
		const started = await this.operationStarted(runId);
		if (started === undefined) throw new HarnessFault(`Missing durable operation start for Foundation run ${runId}`, undefined);
		let latest = started.timestamp;
		const records = await this.durableSession.findRecords({ lane, runId, order: "oldestFirst" });
		for (const record of records) latest = Math.max(latest, record.timestamp);
		const entries = await this.getLaneEntries(lane);
		for (const entry of entries) {
			if (entry.seq < started.seq) continue;
			const data = entry.type === "custom" ? asRecord(entry.data) : undefined;
			const operationEvidence =
				(entry.type === "message" && (entry.message.role === "assistant" || entry.message.role === "toolResult")) ||
				entry.type === "compaction" ||
				entry.type === "branch_summary" ||
				(entry.type === "custom" && entry.customType === FOUNDATION_TOOL_RESULT_CUSTOM_TYPE && data?.runId === runId && data?.operationId === runId);
			if (operationEvidence) latest = Math.max(latest, entry.timestamp);
		}
		return new Date(latest).toISOString();
	}

	private async persistConfiguration(lane: string, customType: string, data: JsonValue): Promise<void> {
		await this.durableSession.view(lane).appendCustomEntry(customType, structuredClone(data));
		await this.refreshSnapshots();
	}

	private async restoreRuntimeConfiguration(): Promise<void> {
		const leafId = await this.durableSession.view("main").getLeafId();
		if (leafId === null) return;
		const entries = await this.durableSession.view("main").findEntriesOnBranch({ start: leafId, order: "oldestFirst" });
		for (const entry of entries) {
			if (entry.type !== "custom" || entry.data === undefined) continue;
			const data = asRecord(entry.data);
			if (data === undefined) continue;
			switch (entry.customType) {
				case HARNESS_CONFIGURATION_TYPES.resources:
					this.resources = structuredClone(entry.data) as Resources;
					break;
				case HARNESS_CONFIGURATION_TYPES.streamOptions:
					this.streamOptions = structuredClone(entry.data) as StreamOptions;
					break;
				case HARNESS_CONFIGURATION_TYPES.retryPolicy:
					this.retryPolicy = structuredClone(entry.data) as RetryPolicy;
					break;
				case HARNESS_CONFIGURATION_TYPES.compaction:
					this.compactionSettings = structuredClone(entry.data) as CompactionSettings;
					break;
				case HARNESS_CONFIGURATION_TYPES.steeringMode:
					if (data.mode === "all" || data.mode === "one-at-a-time") this.steeringMode = data.mode;
					break;
				case HARNESS_CONFIGURATION_TYPES.followUpMode:
					if (data.mode === "all" || data.mode === "one-at-a-time") this.followUpMode = data.mode;
					break;
				case HARNESS_CONFIGURATION_TYPES.tools:
					// Active tools are lane configuration restored by the reducer.
					break;
			}
		}
	}

	private async restore(): Promise<SuspendedOperation[]> {
		try {
			await this.restoreRuntimeConfiguration();
			await this.refreshSnapshots();
			for (const pointer of await this.durableSession.getLanes()) await this.reconcileDeferredEntryWrites(pointer.lane);
			const suspended: SuspendedOperation[] = [];
			for (const pointer of await this.durableSession.getLanes()) {
				const reduction = this.laneReductions.get(pointer.lane);
				const operation = reduction?.laneState.operation;
				if (!operation) continue;
				await this.ensureFoundationIntentForOperation(pointer.lane, operation.id);
				const missingTools = this.missingTools(reduction.effectiveConfiguration.activeToolNames);
				const missingModels = this.missingModels(reduction.effectiveConfiguration.model);
				const prompt = operation.intent.kind === "run" ? [...operation.intent.originalPrompt] : undefined;
				const suspendedOperation: SuspendedOperation = {
					lane: pointer.lane,
					kind: operation.kind,
					id: operation.id,
					startedAt: (await this.operationStarted(operation.id))?.timestamp ?? Date.now(),
					reason: operation.deferred ? "deferred" : "crash",
					...(prompt ? { prompt } : {}),
					...(operation.deferred ? { deferred: operation.deferred } : {}),
					...(operation.aborting ? { aborting: { steer: [], followUp: [] } } : {}),
					missing: { tools: missingTools, models: missingModels },
				};
				suspended.push(suspendedOperation);
			}
			return suspended;
		} catch (error) {
			this.faulted = true;
			this.sessionSnapshot = { ...this.sessionSnapshot, faulted: true };
			if (error instanceof HarnessFault) throw error;
			if (error instanceof RecordLogCorruption) {
				throw new HarnessFault(`Harness recovery rejected corrupt record log (${error.reason})`, error);
			}
			throw new HarnessFault("Harness recovery failed closed", error);
		}
	}

	private async reconcileDeferredEntryWrites(lane: string): Promise<void> {
		const writes = await this.durableSession.findRecords({ lane, type: "write_deferred", order: "oldestFirst" });
		for (const write of writes) {
			const existing = await this.durableSession.getEntry(write.target.id);
			if (existing === undefined) continue;
			if (!matchesProvisionedEntryCanonical(existing, write.target)) throw new HarnessFault(`Durable entry ${write.target.id} conflicts with its write intent`, undefined);
			await this.ensureToolResultUsageRecord(lane, write.runId, write.target);
		}
	}

	private missingTools(names: readonly string[]): string[] {
		const available = new Set(this.tools.map((tool) => tool.name));
		return names.filter((name) => !available.has(name));
	}

	private missingModels(model: { provider: string; modelId: string }): string[] {
		return this.models.getModel(model.provider, model.modelId) ? [] : [`${model.provider}/${model.modelId}`];
	}

	private async operationStarted(id: string): Promise<OperationStartedRecord | undefined> {
		return (await this.durableSession.findRecords({ type: "operation_started", runId: id, order: "oldestFirst" }))[0];
	}

	private async readReduction(lane: string, allEntries?: Entry[]): Promise<LaneReductionResult> {
		const pointers = await this.durableSession.getLanes();
		const pointer = pointers.find((candidate) => candidate.lane === lane);
		if (!pointer) throw new SessionError("invalid_lane", `Lane not found: ${lane}`);
		const entries = allEntries ?? (await this.durableSession.findEntries({ order: "oldestFirst" }));
		const ownEntries = pointer.leafId === null
			? []
			: await this.durableSession.view(lane).findEntriesOnBranch({ start: pointer.leafId, order: "oldestFirst" });
		const records = await this.durableSession.findRecords({ lane, order: "oldestFirst" });
		const openOperations = await this.durableSession.findOpenOperations(lane, { limit: 2 });
		const operation = openOperations[0];
		const operationAttempt = operation === undefined
			? undefined
			: records.filter((record) => record.type === "step_attempt" && record.runId === operation.id).at(-1);
		const toolCorrelation = this.foundationExecution === undefined || operation === undefined || this.foundationSessionId === undefined
			? undefined
			: {
					sessionId: this.foundationSessionId,
					laneId: lane,
					runId: operation.id,
					operationId: operation.id,
					taskId: this.foundationExecution.task.taskId,
					dispatchId: this.foundationExecution.dispatch.dispatchId,
					bindingId: this.foundationExecution.binding.bindingId,
					bindingEpochId: this.foundationExecution.bindingEpochIds[0],
					...(operationAttempt === undefined ? {} : { attemptId: operationAttempt.id }),
					providerId: this.foundationExecution.providerId,
				};
		const toolCallIds = [...new Set(ownEntries.flatMap((entry) =>
			entry.type === "message" && entry.message.role === "assistant" && Array.isArray(entry.message.content)
				? entry.message.content.filter((content) => content.type === "toolCall").map((content) => content.id)
				: [],
		))];
		const findToolRecords = async (kind: "intent" | "fact", objectType: "tool_intent" | "tool_receipt"): Promise<FoundationRecord[]> => {
			if (toolCorrelation === undefined) return [];
			const batches = await Promise.all(toolCallIds.map((toolCallId) => this.durableSession.findFoundationRecords({ kind, objectType, includePruned: true, order: "oldestFirst", correlation: { ...toolCorrelation, toolCallId } })));
			return batches.flat();
		};
		const toolIntentRecords = await findToolRecords("intent", "tool_intent");
		const toolReceiptRecords = await findToolRecords("fact", "tool_receipt");
		const toolIntents = this.foundationExecution === undefined
			? []
			: toolIntentRecords.flatMap((record) => {
				if (record.kind !== "intent" || record.payload === undefined) return [];
				const checked = validateToolIntent(record.payload);
				if (!checked.ok) throw new HarnessFault("Persisted tool intent failed validation", checked.error);
				return [checked.value];
			});
		const toolReceipts = this.foundationExecution === undefined
			? []
			: toolReceiptRecords.flatMap((record) => {
				if (record.kind !== "fact") return [];
				const checked = validateToolReceipt(record.payload);
				if (!checked.ok) throw new HarnessFault("Persisted tool receipt failed validation", checked.error);
				return [checked.value];
			});
		const reduction = reduceLaneState({
			sessionId: this.foundationSessionId,
			lane,
			leafId: pointer.leafId,
			openOperations,
			records,
			entries,
			ownEntries,
			configurationEntries: ownEntries,
			defaults: {
				model: { provider: this.defaultModel.provider, modelId: this.defaultModel.id },
				thinkingLevel: this.defaultThinkingLevel,
				activeToolNames: [...this.defaultActiveToolNames],
			},
			toolIntents,
			toolReceipts,
			toolIdentity: toolCorrelation,
		});
		this.laneReductions.set(lane, reduction);
		return reduction;
	}

	private async refreshSnapshots(): Promise<void> {
		const pointers = await this.durableSession.getLanes();
		const allEntries = await this.durableSession.findEntries({ order: "oldestFirst" });
		const laneInfos: (LaneInfo & { suspended?: SuspendedOperation })[] = [];
		for (const pointer of pointers) {
			const reduction = await this.readReduction(pointer.lane, allEntries);
			const snapshot = await this.snapshotForReduction(pointer.lane, reduction);
			this.laneSnapshots.set(pointer.lane, snapshot);
			const operation = reduction.laneState.operation;
			const info: LaneInfo & { suspended?: SuspendedOperation } = {
				name: pointer.lane,
				leafId: pointer.leafId,
				operation: operation
					? {
							id: operation.id,
							kind: operation.kind,
							status: operation.aborting
								? "aborting"
								: this.activeOperations.has(operation.id)
									? "running"
									: "suspended",
						}
					: null,
			};
			if (operation && !this.activeOperations.has(operation.id)) {
				info.suspended = await this.suspendedFromReduction(pointer.lane, reduction);
			}
			laneInfos.push(info);
		}
		this.sessionSnapshot = { lanes: laneInfos, faulted: this.faulted };
	}

	private async snapshotForReduction(lane: string, reduction: LaneReductionResult): Promise<LaneSnapshot> {
		const pointer = (await this.durableSession.getLanes()).find((candidate) => candidate.lane === lane);
		const transcript = pointer?.leafId === null || pointer?.leafId === undefined
			? []
			: await this.durableSession.view(lane).findEntriesOnBranch({ start: pointer.leafId, order: "oldestFirst" });
		const operation = reduction.laneState.operation;
		const queued = (entries: ProvisionedEntry[]): QueuedItem[] =>
			entries.map((entry) => ({ entryId: entry.id, message: entry.type === "message" ? entry.message : ({ role: "custom", content: "", timestamp: Date.now() } as AgentMessage) }));
		return {
			lane,
			transcript,
			leafId: pointer?.leafId ?? null,
			operation: operation
				? {
						id: operation.id,
						kind: operation.kind,
						status: operation.aborting
							? "aborting"
							: this.activeOperations.has(operation.id)
								? "running"
								: "suspended",
					}
				: null,
			queues: {
				steer: queued(operation?.pendingSteer ?? []),
				followUp: queued(operation?.pendingFollowUp ?? []),
				nextRun: queued(reduction.laneState.pendingNextRun),
			},
			pendingWrites: (operation?.pendingWrites ?? []).map((entry) => ({ id: entry.id, entry })),
			faulted: this.faulted,
		};
	}

	private async suspendedFromReduction(lane: string, reduction: LaneReductionResult): Promise<SuspendedOperation> {
		const operation = reduction.laneState.operation!;
		const started = await this.operationStarted(operation.id);
		const missingTools = this.missingTools(reduction.effectiveConfiguration.activeToolNames);
		const missingModels = this.missingModels(reduction.effectiveConfiguration.model);
		return {
			lane,
			kind: operation.kind,
			id: operation.id,
			startedAt: started?.timestamp ?? Date.now(),
			reason: operation.deferred ? "deferred" : "crash",
			...(operation.intent.kind === "run" ? { prompt: [...operation.intent.originalPrompt] } : {}),
			...(operation.deferred ? { deferred: operation.deferred } : {}),
			missing: { tools: missingTools, models: missingModels },
		};
	}

	private async getLaneReduction(lane: string): Promise<LaneReductionResult> {
		return this.readReduction(lane);
	}

	private async getLaneEntries(lane: string): Promise<Entry[]> {
		const leafId = await this.durableSession.view(lane).getLeafId();
		if (leafId === null) return [];
		return this.durableSession.view(lane).findEntriesOnBranch({ start: leafId, order: "oldestFirst" });
	}

	private async systemPrompt(): Promise<string> {
		const base = typeof this.systemPromptSource === "function" ? await this.systemPromptSource() : (this.systemPromptSource ?? "");
		const skills = this.resources.skills ? formatSkillsForSystemPrompt(this.resources.skills) : "";
		return [base, skills].filter((part) => part.length > 0).join("\n\n");
	}

	private projectorMap(lane: string): Record<string, AsyncCustomEntryContextMessageProjector> {
		const projectors: Record<string, AsyncCustomEntryContextMessageProjector> = {};
		for (const [customType, projector] of Object.entries(this.entryProjectors)) {
			projectors[customType] = (entry) => projector(entry);
		}
		// This type is reserved by the Foundation harness. Install it after
		// caller projectors so the durable result cannot be overridden or read
		// without ArtifactStore verification.
		projectors[FOUNDATION_TOOL_RESULT_CUSTOM_TYPE] = (entry) => this.projectFoundationToolResultEntry(lane, entry);
		return projectors;
	}

	private async projectFoundationToolResultEntry(lane: string, entry: CustomEntry): Promise<readonly AgentMessage[]> {
		const checked = validateFoundationToolResultEntry(entry.data);
		if (!checked.ok) throw new HarnessToolPipelineError(checked.error.message, "side_effect_unknown");
		if (this.foundationExecution === undefined) throw new HarnessToolPipelineError("Foundation tool result has no execution authority", "side_effect_unknown");
		const starts = await this.durableSession.findRecords({ lane, runId: checked.value.runId, type: "tool_started", order: "oldestFirst" });
		const matchingStarts = starts.filter((start) => start.toolCallId === checked.value.toolCallId);
		if (matchingStarts.length !== 1) throw new HarnessToolPipelineError("Durable tool result entry is not authorized by a unique tool start", "side_effect_unknown");
		const start = matchingStarts[0]!;
		if (start.resultEntryId !== entry.id || start.toolName !== checked.value.toolName) throw new HarnessToolPipelineError("Durable tool result entry is not bound to its tool start", "side_effect_unknown");
		if (checked.value.operationId !== checked.value.runId) throw new HarnessToolPipelineError("Durable tool result entry has an invalid operation identity", "side_effect_unknown");
		const intent = await this.foundationIntentForToolCall(lane, checked.value.runId, checked.value.toolCallId);
		if (!intent.ok) throw new HarnessToolPipelineError(intent.error.message, "side_effect_unknown");
		const stepAttempts = await this.durableSession.findRecords({ lane, type: "step_attempt", order: "oldestFirst" });
		const matchingStepAttempts = stepAttempts.filter((attempt) => attempt.resultEntryId === start.assistantEntryId);
		if (matchingStepAttempts.length !== 1) throw new HarnessToolPipelineError("Durable tool start is not authorized by a unique assistant step attempt", "side_effect_unknown");
		const stepAttempt = matchingStepAttempts[0]!;
		if (
			stepAttempt.runId !== checked.value.runId ||
			intent.value.toolName !== start.toolName ||
			intent.value.attempt !== stepAttempt.attempt ||
			intent.value.binding.attemptId !== stepAttempt.id
		) throw new HarnessToolPipelineError("Durable tool intent is not bound to its assistant step attempt", "side_effect_unknown");
		let acceptedDigest: ReturnType<typeof fingerprintToolArguments>;
		try {
			acceptedDigest = fingerprintToolArguments(start.effectiveArgs);
		} catch (_error) {
			throw new HarnessToolPipelineError("Durable tool start has an invalid accepted argument projection", "side_effect_unknown");
		}
		if (acceptedDigest.algorithm !== intent.value.argumentDigests.accepted.algorithm || acceptedDigest.value !== intent.value.argumentDigests.accepted.value) throw new HarnessToolPipelineError("Durable tool result entry has a mismatched accepted argument digest", "side_effect_unknown");
		const folded = await this.foundationReceiptForToolCall(lane, checked.value.runId, checked.value.toolCallId);
		if (!folded.ok || folded.value.outcome !== "succeeded" || folded.value.sideEffectState !== "none" || folded.value.result === undefined || checked.value.isError || canonicalFoundationJson(folded.value.result) !== canonicalFoundationJson(checked.value.result)) {
			throw new HarnessToolPipelineError("Durable tool result entry does not match its authorized receipt", "side_effect_unknown");
		}
		const restored = await restoreFoundationToolResult(checked.value.result, this.artifactStore);
		if (!restored.ok) throw new HarnessToolPipelineError(restored.error.message, "side_effect_unknown");
		return [{
			role: "toolResult",
			toolCallId: checked.value.toolCallId,
			toolName: checked.value.toolName,
			content: restored.value.content,
			...(restored.value.details === undefined ? {} : { details: restored.value.details }),
			...(restored.value.usage === undefined ? {} : { usage: restored.value.usage }),
			...(restored.value.addedToolNames === undefined ? {} : { addedToolNames: [...restored.value.addedToolNames] }),
			isError: checked.value.isError,
			timestamp: entry.timestamp,
		}];
	}

	private async contextForOperation(
		lane: string,
		operationId?: string,
		purpose: HarnessContextPurpose = "agent_turn",
	): Promise<{ context: AgentContext; reduction: LaneReductionResult; model: Model<Api>; thinkingLevel: ThinkingLevel; activeToolNames: string[] }> {
		const reduction = await this.getLaneReduction(lane);
		const laneEntries = await this.getLaneEntries(lane);
		const projectedMessages = await this.contextMessages(lane, laneEntries);
		const operation = reduction.laneState.operation;
		const isContinuation = operation !== null && operation.id === operationId && operation.intent.kind === "run" && operation.intent.continuation === true;
		const messages = isContinuation && projectedMessages.at(-1)?.role === "assistant"
			? projectedMessages.slice(0, -1)
			: projectedMessages;
		const route = this.foundationExecution?.binding.modelRoute;
		const provider = route?.provider ?? reduction.effectiveConfiguration.model.provider;
		const modelId = route?.model ?? reduction.effectiveConfiguration.model.modelId;
		const model = this.defaultModel.provider === provider && this.defaultModel.id === modelId
			? this.defaultModel
			: this.models.getModel(provider, modelId) ?? this.defaultModel;
		const thinkingLevel = route === undefined
			? isThinkingLevel(reduction.effectiveConfiguration.thinkingLevel) ? reduction.effectiveConfiguration.thinkingLevel : this.defaultThinkingLevel
			: route.effort !== undefined && isThinkingLevel(route.effort) ? route.effort : "off";
		const activeToolNames = [...reduction.effectiveConfiguration.activeToolNames];
		const pipelineOperationId = operationId ?? reduction.laneState.operation?.id ?? "context";
		const activeTools = this.tools.filter((tool) => activeToolNames.includes(tool.name));
		const context: AgentContext = {
				systemPrompt: await this.systemPrompt(),
				messages,
				tools: this.foundationExecution === undefined || this.toolPipeline === undefined
					? activeTools
					: activeTools.map((tool) => this.pipelineTool(tool, lane, pipelineOperationId)),
			};
		const preparedContext = this.contextPreparation === undefined || purpose === "agent_turn"
			? context
			: await this.contextPreparation({ purpose, operationId: pipelineOperationId, model, context, signal: this.activeOperations.get(pipelineOperationId)?.controller.signal });
		return {
			context: preparedContext,
			reduction,
			model,
			thinkingLevel,
			activeToolNames,
		};
	}

	private async contextMessages(lane: string, laneEntries: Entry[]): Promise<AgentMessage[]> {
		const context = await buildSessionContextAsync(laneEntries, {
			entryProjectors: this.projectorMap(lane),
			messageProjector: (entry) => this.projectLedgerToolResultEntry(entry),
		});
		return context.messages;
	}

	private async projectLedgerToolResultEntry(entry: MessageEntry): Promise<readonly AgentMessage[] | undefined> {
		if (entry.message.role !== "toolResult") return undefined;
		const materialized = await this.ledger.materializeToolResult(entry.id);
		return materialized === undefined ? undefined : [materialized];
	}

	private createToolRegistry(): ToolDefinitionRegistry {
		return {
			resolve: (toolName, namespace) => {
				const tool = this.tools.find((candidate) => candidate.name === toolName && (namespace === undefined || namespace === (candidate as unknown as { namespace?: string }).namespace));
				return tool === undefined
					? Result.err(new FoundationError("invalid_identifier", `tool ${toolName} is not registered`))
					: Result.ok(this.toolDefinition(tool));
			},
		};
	}

	private foundationToolHookKey(operationId: string | undefined, toolCallId: string): string {
		return `${operationId ?? "unknown"}:${toolCallId}`;
	}

	private async toolHookContext(
		lane: string,
		toolCallId: string,
		toolName: string,
		args: Readonly<Record<string, unknown>>,
	): Promise<BeforeToolCallContext> {
		const messages = await this.contextMessages(lane, await this.getLaneEntries(lane));
		const assistantMessage = [...messages].reverse().find(
			(message): message is AssistantMessage => message.role === "assistant" && message.content.some((content) => content.type === "toolCall" && content.id === toolCallId),
		);
		if (assistantMessage === undefined) throw new HarnessFault(`Tool hook ${toolCallId} has no requesting assistant message`, undefined);
		const toolCall = assistantMessage.content.find(
			(content): content is AgentToolCall => content.type === "toolCall" && content.id === toolCallId,
		) ?? { type: "toolCall", id: toolCallId, name: toolName, arguments: { ...args } };
		return {
			assistantMessage,
			toolCall,
			args: { ...args },
			context: {
				systemPrompt: await this.systemPrompt(),
				messages,
				tools: [...this.tools],
			},
		};
	}

	private toolDefinition(tool: HarnessTool): ToolDefinition {
		const metadata = tool as unknown as {
			capabilities?: readonly string[];
			namespace?: string;
			toolRevision?: ToolRevision;
			idempotency?: "idempotent" | "non_idempotent";
			conflictKeys?: (args: Record<string, unknown>) => readonly string[];
		};
		return {
			name: tool.name,
			...(metadata.namespace === undefined ? {} : { namespace: metadata.namespace }),
			label: tool.label,
			description: tool.description,
			toolRevision: metadata.toolRevision ?? { schemaVersion: 1, type: "tool_revision", id: `tool:${tool.name}`, revision: 1 },
			capabilities: [...(metadata.capabilities ?? [])],
			parameters: tool.parameters,
			executionMode: tool.executionMode,
			preHook: async (scope) => {
				if (this.beforeToolCall === undefined) return;
				const lane = scope.context.laneId ?? "main";
				const hookContext = await this.toolHookContext(lane, scope.intent.toolCallId, tool.name, scope.args);
				const result = await this.beforeToolCall(hookContext);
				if (result?.block !== true) return;
				this.foundationToolHookResults.set(
					this.foundationToolHookKey(scope.context.operationId, scope.intent.toolCallId),
					{
						content: [{ type: "text", text: result.reason || "Tool execution was blocked" }],
						isError: true,
						...(result.terminate === undefined ? {} : { terminate: result.terminate }),
					},
				);
				return Result.err(new FoundationError("tool_pre_hook_denied", result.reason || "Tool execution was blocked"));
			},
			postProcessor: async (scope) => {
				if (this.afterToolCall === undefined || scope.execution.result === undefined) return undefined;
				const restored = await restoreFoundationToolResult(scope.execution.result, this.artifactStore);
				if (!restored.ok) return Result.err(restored.error);
				const lane = scope.context.laneId ?? "main";
				const beforeContext = await this.toolHookContext(lane, scope.intent.toolCallId, tool.name, scope.args);
				const result = await this.afterToolCall({
					...beforeContext,
					result: restored.value,
					isError: !scope.execution.ok,
				});
				if (result === undefined) return undefined;
				this.foundationToolHookResults.set(this.foundationToolHookKey(scope.context.operationId, scope.intent.toolCallId), result);
				const merged: AgentToolResult<unknown> = {
					...restored.value,
					content: result.content ?? restored.value.content,
					...(result.details === undefined ? {} : { details: result.details }),
					...(result.usage === undefined ? {} : { usage: result.usage }),
				};
				const durable = await foundationToolResultPayload(merged, this.artifactStore, this.foundationExecution?.providerId, scope.intent.toolCallId);
				if (!durable.ok) return Result.err(durable.error);
				return {
					result: durable.value.result,
					...(durable.value.artifacts.length === 0 ? {} : { artifacts: durable.value.artifacts }),
					...(merged.usage === undefined ? {} : { usage: foundationToolUsage(merged.usage) }),
				};
			},
			// AgentLoop prepares the public wrapper before invoking execute; the
			// pipeline must not apply the transform a second time.
			...(metadata.conflictKeys === undefined ? {} : { conflictKeys: metadata.conflictKeys }),
			...(metadata.idempotency === undefined ? {} : { idempotency: metadata.idempotency }),
			execute: async (args, options) => {
				const sideEffectState = tool.sideEffectState === "none" || (tool.sideEffectState === undefined && this.compatibilityWriter !== undefined)
					? "none"
					: "side_effect_unknown";
				try {
					const result = await tool.execute(options.toolCallId, args as never, options.signal, (partial) => options.onUpdate?.(partial));
					const payloadResult = await foundationToolResultPayload(result as AgentToolResult<unknown>, this.artifactStore, this.foundationExecution?.providerId, options.toolCallId);
					if (!payloadResult.ok) {
						return {
							ok: false,
							sideEffectState: "side_effect_unknown" as const,
							error: payloadResult.error.toPublicExecutionError(),
						};
					}
					return {
						ok: true,
						sideEffectState: sideEffectState === "none" ? "none" : "side_effect_unknown",
						...(result.usage === undefined ? {} : { usage: foundationToolUsage(result.usage) }),
						...(payloadResult.value.artifacts.length === 0 ? {} : { artifacts: payloadResult.value.artifacts }),
						result: payloadResult.value.result,
					};
				} catch (error) {
					const normalized = toFoundationError(error, "tool_execution_failed");
					const publicError = normalized.toPublicExecutionError();
					return {
						ok: false,
						sideEffectState,
						error: sideEffectState === "none" ? publicError : { ...publicError, category: "side_effect_unknown" as const, retryable: false },
					};
				}
			},
		};
	}

	private pipelineTool(tool: HarnessTool, lane: string, operationId: string): HarnessTool {
		const pipeline = this.toolPipeline;
		if (pipeline === undefined || this.foundationExecution === undefined) return tool;
		return {
			...tool,
			execute: async (toolCallId, params, signal, onUpdate: AgentToolUpdateCallback<unknown> | undefined) => {
				const pipelineArgs = this.foundationJson(params, "tool arguments");
				const context = await this.pipelineContext(lane, operationId);
				const idempotencyKey = this.defaultToolIdempotencyKey(context, toolCallId);
				const execution = await pipeline.execute(
					{ toolCallId, toolName: tool.name, idempotencyKey, ...(context.attempt === undefined ? {} : { attempt: context.attempt }), args: pipelineArgs },
					context,
					{ signal, onUpdate: onUpdate === undefined ? undefined : (partial) => onUpdate(partial as AgentToolResult<unknown>) },
				);
				if (execution.ok && execution.value.outcome === "succeeded") {
					const restored = await restoreFoundationToolResult(execution.value.result, this.artifactStore);
					if (restored.ok) return restored.value as AgentToolResult<never>;
					this.terminalToolFailureOperations.add(operationId);
					throw new HarnessToolPipelineError(restored.error.message, "side_effect_unknown");
				}
				if (execution.ok && execution.value.outcome === "blocked" && execution.value.sideEffectState === "none") {
					const hookResult = this.foundationToolHookResults.get(this.foundationToolHookKey(operationId, toolCallId));
					if (hookResult !== undefined) {
						return {
							content: hookResult.content ?? [{ type: "text", text: execution.value.error?.message ?? "Tool execution was blocked" }],
							...(hookResult.details === undefined ? {} : { details: hookResult.details }),
						};
					}
				}
				if (execution.ok && execution.value.sideEffectState === "side_effect_unknown") this.terminalToolFailureOperations.add(operationId);
				throw new HarnessToolPipelineError(
					execution.ok ? execution.value.error?.message ?? `Tool execution ${execution.value.outcome}` : execution.error.message,
					execution.ok && execution.value.sideEffectState === "none" ? "none" : "side_effect_unknown",
				);
			},
		} as HarnessTool;
	}

	private pipelineResultKey(context: ToolPipelineContext, toolCallId: string): string {
		return canonicalFoundationJson({
			sessionId: context.sessionId,
			laneId: context.laneId,
			runId: context.runId,
			operationId: context.operationId,
			taskId: context.taskId,
			dispatchId: context.dispatchId,
			attemptId: context.attemptId,
			bindingId: context.binding.bindingId,
			bindingEpochId: context.bindingEpoch.bindingEpochId,
			providerId: context.providerId,
			toolCallId,
		});
	}

	private defaultToolIdempotencyKey(context: ToolPipelineContext, toolCallId: string): string {
		return `agent-harness:${this.pipelineResultKey(context, toolCallId)}`;
	}

	private async pipelineContext(lane: string, operationId: string): Promise<ToolPipelineContext> {
		const execution = this.foundationExecution;
		if (execution === undefined) throw new HarnessFault("Tool pipeline requires Foundation execution", undefined);
		const attempts = await this.durableSession.findRecords({ lane, runId: operationId, type: "step_attempt", order: "oldestFirst" });
		const attempt = attempts.at(-1);
		if (attempt === undefined) throw new HarnessFault(`Tool pipeline operation ${operationId} has no durable attempt`, undefined);
		return {
			sessionId: this.foundationSessionId ?? execution.task.taskId,
			laneId: lane,
			runId: operationId,
			operationId,
			binding: execution.binding,
			bindingEpoch: {
				schemaVersion: 1,
				bindingEpochId: execution.bindingEpochIds[0]!,
				taskId: execution.task.taskId,
				attemptId: attempt.id,
				bindingId: execution.binding.bindingId,
				ordinal: 0,
				activationReason: "attempt_started",
				activatedByCommandId: execution.dispatch.dispatchId,
				activatedAt: execution.task.updatedAt,
				agentInstanceId: execution.agentInstanceId,
			},
			taskId: execution.task.taskId,
			dispatchId: execution.dispatch.dispatchId,
			providerId: execution.providerId,
			agentInstanceId: execution.agentInstanceId,
			attemptId: attempt.id,
			attempt: attempt.attempt,
			workspace: execution.task.workspace,
			...(execution.dispatch.deadlineAt === undefined && execution.task.requirements?.deadlineAt === undefined ? {} : { deadlineAt: Date.parse(execution.dispatch.deadlineAt ?? execution.task.requirements!.deadlineAt!) }),
		};
	}

	private loopConfig(
		lane: string,
		operationId: string,
		context: AgentContext,
		signal: AbortSignal,
		model: Model<Api>,
		thinkingLevel: ThinkingLevel,
	): AgentLoopConfig {
		let skipInitialSteeringPoll = false;
		return {
			...this.streamOptions,
			model,
			reasoning: thinkingLevel === "off" ? undefined : thinkingLevel,
			retry: { ...this.retryPolicy },
			preserveProviderRetryMessage: true,
			retryCallbacks: {
				onRetryScheduled: (attempt, maxAttempts, delayMs, errorMessage) => {
					this.retryAttemptValue = attempt;
					this.eventBus.emit({ type: "retry_scheduled", attempt, maxAttempts, delayMs, errorMessage });
				},
				onRetryFinished: (success, attempt, finalError) => {
					const retryFinalError = this.retryCancelledOperations.has(operationId) ? "Retry cancelled" : finalError;
					this.eventBus.emit({ type: "retry_finished", success, attempt, ...(retryFinalError === undefined ? {} : { finalError: retryFinalError }) });
					this.retryAttemptValue = 0;
				},
			},
			prepareContext: this.contextPreparation === undefined
				? undefined
				: async (attemptContext, attemptModel, attemptSignal) => {
					try {
						const activeToolNames = this.pendingActiveToolNames.get(lane)
							?? (await this.getLaneReduction(lane)).effectiveConfiguration.activeToolNames;
						const activeTools = this.tools.filter((tool) => activeToolNames.includes(tool.name));
						const refreshedContext: AgentContext = {
							...attemptContext,
							messages: [...attemptContext.messages],
							tools: this.foundationExecution === undefined || this.toolPipeline === undefined
								? activeTools
								: activeTools.map((tool) => this.pipelineTool(tool, lane, operationId)),
						};
						this.operationContextInputs.set(operationId, {
							...refreshedContext,
							messages: [...refreshedContext.messages],
						});
						await this.modelContextPreparationStart?.({
							purpose: "agent_turn",
							operationId,
							model: attemptModel,
							context: refreshedContext,
							signal: attemptSignal,
						});
						return await this.contextPreparation!({
							purpose: "agent_turn",
							operationId,
							model: attemptModel,
							context: refreshedContext,
							signal: attemptSignal,
						});
					} catch (error) {
						this.contextPreparationErrors.set(operationId, error);
						throw error;
					}
				},
			toolExecution: this.toolExecution,
			convertToLlm: this.toProviderMessages,
			getApiKey: this.getApiKey,
			getSteeringMessages: async () => {
				if (skipInitialSteeringPoll) {
					skipInitialSteeringPoll = false;
					return [];
				}
				return this.enqueue(lane, () => this.consumeQueueMessages(lane, operationId, "steer", this.steeringMode));
			},
			getFollowUpMessages: async () => this.enqueue(lane, () => this.consumeQueueMessages(lane, operationId, "followUp", this.followUpMode)),
			transformContext: this.transformContext ?? (async (messages) => messages),
			beforeToolCall: this.foundationExecution === undefined ? this.beforeToolCall : undefined,
			afterToolCall: this.foundationExecution === undefined
				? this.afterToolCall
				: async ({ toolCall }) => {
					const key = this.foundationToolHookKey(operationId, toolCall.id);
					const result = this.foundationToolHookResults.get(key);
					this.foundationToolHookResults.delete(key);
					return result;
				},
			shouldStopAfterTurn: async (messages) => this.terminalToolFailureOperations.has(operationId) || (await this.shouldStopAfterTurn?.(messages)) === true,
			prepareNextTurn: this.prepareNextTurn,
			...(signal ? { signal } : {}),
			...(context ? {} : {}),
		};
	}

	private normalizePrompt(input: string | AgentMessage | AgentMessage[], images?: ImageContent[]): AgentMessage[] {
		if (Array.isArray(input)) return [...input];
		if (typeof input !== "string") return [input];
		return [
			{
				role: "user",
				content: [{ type: "text", text: input }, ...(images ?? [])],
				timestamp: Date.now(),
			},
		];
	}

	private validatePrompt(lane: string, messages: AgentMessage[]): InvalidMessage | undefined {
		if (messages.length === 0) return new InvalidMessage({ lane, reason: "empty", message: "Prompt must contain at least one message" });
		try {
			for (const message of messages) assertJsonSerializable(message);
			return undefined;
		} catch (error) {
			return new InvalidMessage({ lane, reason: "not_serializable", message: toError(error).message });
		}
	}

	private promptReplayIdentity(messages: readonly AgentMessage[]): string {
		return canonicalFoundationJson(messages.map((message) => {
			const { timestamp: _timestamp, ...identity } = message;
			return identity;
		}));
	}

	private async startRun(
		lane: string,
		messages: AgentMessage[],
		requestedRunId?: string,
		continuation = false,
	): Promise<ResultValue<string, RunRejected>> {
		return this.enqueue(lane, async () => {
			try {
				this.ensureOpen();
				const invalid = continuation && messages.length === 0 ? undefined : this.validatePrompt(lane, messages);
				if (invalid) return Result.err<RunRejected>(invalid);
				if (requestedRunId !== undefined && requestedRunId.trim().length === 0) {
					return Result.err<RunRejected>(new InvalidMessage({
						lane,
						reason: "invalid_run_id",
						message: "Requested runId must be a non-empty string",
					}));
				}
				if (requestedRunId !== undefined) {
					const existingStarts = await this.durableSession.findRecords({
						type: "operation_started",
						runId: requestedRunId,
						order: "oldestFirst",
					});
					if (existingStarts.length > 0) {
						const matches = existingStarts.length === 1 && existingStarts[0]?.lane === lane &&
							existingStarts[0].intent.kind === "run" &&
							this.promptReplayIdentity(existingStarts[0].intent.originalPrompt) === this.promptReplayIdentity(messages);
						if (!matches) {
							return Result.err<RunRejected>(new InvalidMessage({
								lane,
								reason: "run_id_conflict",
								message: `Requested runId ${requestedRunId} conflicts with an existing operation`,
							}));
						}
						const existingReduction = await this.getLaneReduction(lane);
						if (existingReduction.laneState.operation !== null && existingReduction.laneState.operation.id !== requestedRunId) {
							return Result.err<RunRejected>(new LaneBusy({
								lane,
								operationId: existingReduction.laneState.operation.id,
								operationKind: existingReduction.laneState.operation.kind,
								message: "Lane already has an open operation",
							}));
						}
						return Result.ok<string>(requestedRunId);
					}
				}
				const reduction = await this.getLaneReduction(lane);
				if (reduction.laneState.operation) {
					return Result.err<RunRejected>(new LaneBusy({
						lane,
						operationId: reduction.laneState.operation.id,
						operationKind: reduction.laneState.operation.kind,
						message: "Lane already has an open operation",
					}));
				}
				const initialMessages: ProvisionedEntry[] = [
					...messages.map((message) => ({ type: "message" as const, id: this.durableSession.idGenerator.next(), message })),
					...reduction.laneState.pendingNextRun,
				];
				const id = requestedRunId ?? this.durableSession.idGenerator.next();
				const correlation = this.foundationCorrelation(lane, id, { runId: id });
				await this.durableSession.appendRecord({
					type: "operation_started",
					id,
					lane,
					sourceLeafId: reduction.laneState.leafId,
					...(correlation === undefined ? {} : { correlation }),
					intent: {
						kind: "run",
						originalPrompt: structuredClone(messages),
						initialMessages: structuredClone(initialMessages),
						...(continuation ? { continuation: true } : {}),
					},
				} satisfies NewRecord<OperationStartedRecord>);
				await this.persistFoundationIntent(lane, id);
				await this.startFoundationAttempt(lane, id);
				await this.refreshSnapshots();
				await this.hookRegistry.emit("before_run", { lane, runId: id, messages: structuredClone(messages) });
				return Result.ok<string>(id);
			} catch (error) {
				if (error instanceof HarnessClosed) return Result.err<RunRejected>(new Closed({ message: error.message }));
				if (isHarnessInfrastructureFault(error)) {
					this.faulted = true;
					throw error;
				}
				throw new HarnessFault("Failed to durably start run", error);
			}
		});
	}
	private async appendWriteDeferred(lane: string, runId: string, target: ProvisionedEntry): Promise<void> {
		const records = await this.durableSession.findRecords({ lane, type: "write_deferred", runId, order: "oldestFirst" });
		const existing = records.find((record) => record.target.id === target.id);
		if (existing !== undefined) {
			if (canonicalFoundationJson(existing.target) !== canonicalFoundationJson(target)) throw new HarnessFault(`Durable write intent ${target.id} conflicts with its replay payload`, undefined);
			return;
		}
		await this.durableSession.appendRecord({
			type: "write_deferred",
			id: this.durableSession.idGenerator.next(),
			lane,
			runId,
			target: structuredClone(target),
		} satisfies NewRecord<WriteDeferredRecord>);
	}

	private async ensureToolResultUsageRecord(lane: string, runId: string, target: ProvisionedEntry): Promise<void> {
		if (target.type !== "custom" || target.customType !== FOUNDATION_TOOL_RESULT_CUSTOM_TYPE) return;
		const checked = validateFoundationToolResultEntry(target.data);
		if (!checked.ok) throw new HarnessToolPipelineError(checked.error.message, "side_effect_unknown");
		const usage = checked.value.result.usage;
		const records = await this.durableSession.findRecords({ lane, type: "usage", order: "oldestFirst" });
		type ToolUsageRecord = Extract<(typeof records)[number], { type: "usage"; cause: "tool" }>;
		const existing = records.filter((record): record is ToolUsageRecord => record.type === "usage" && record.cause === "tool" && record.entryId === target.id);
		if (usage === undefined) {
			if (existing.length > 0) throw new HarnessFault("Durable tool usage record exists for a result without usage", undefined);
			return;
		}
		const expected = {
			cause: "tool" as const,
			runId,
			entryId: target.id,
			toolCallId: checked.value.toolCallId,
			usage: agentUsageFromToolResultUsage(usage),
		};
		if (existing.length > 1) throw new HarnessFault("Durable tool result has duplicate usage records", undefined);
		if (existing[0] !== undefined) {
			if (canonicalFoundationJson({ cause: existing[0].cause, runId: existing[0].runId, entryId: existing[0].entryId, toolCallId: existing[0].toolCallId, usage: existing[0].usage }) !== canonicalFoundationJson(expected)) {
				throw new HarnessFault("Durable tool usage record conflicts with its canonical result usage", undefined);
			}
			return;
		}
		await this.durableSession.appendRecord({
			type: "usage",
			id: this.durableSession.idGenerator.next(),
			lane,
			cause: "tool",
			runId,
			entryId: target.id,
			toolCallId: checked.value.toolCallId,
			usage: expected.usage,
		});
	}

	private async persistOperationEntry(lane: string, runId: string, target: ProvisionedEntry): Promise<void> {
		const existing = await this.durableSession.getEntry(target.id);
		if (!existing) {
			await this.appendWriteDeferred(lane, runId, target);
			await this.durableSession.appendEntry(target, lane);
		} else if (!matchesProvisionedEntryCanonical(existing, target)) {
			throw new HarnessFault(`Durable entry ${target.id} conflicts with its write intent`, undefined);
		}
		await this.ensureToolResultUsageRecord(lane, runId, target);
	}

	private async ensureInitialMessage(lane: string, reduction: LaneReductionResult): Promise<void> {
		const operation = reduction.laneState.operation;
		if (!operation || operation.intent.kind !== "run") return;
		const target = operation.missingInitialMessages[0];
		if (target) {
			await this.persistOperationEntry(lane, operation.id, target);
		}
	}

	private async ensureStep(
		lane: string,
		reduction: LaneReductionResult,
		step: StepAttemptRecord["step"],
		compactionReason?: "manual" | "threshold" | "overflow",
	): Promise<StepAttemptRecord> {
		const operation = reduction.laneState.operation;
		if (!operation) throw new HarnessFault("Cannot checkpoint a missing operation", undefined);
		if (operation.step) {
			const records = await this.durableSession.findRecords({ lane, runId: operation.id, type: "step_attempt", order: "oldestFirst" });
			const current = records.find((record) => record.resultEntryId === operation.step?.resultEntryId);
			if (current) return current;
		}
		const attempts = await this.durableSession.findRecords({ lane, runId: operation.id, type: "step_attempt", order: "oldestFirst" });
		const lastAttempt = attempts.at(-1);
		const lastResult = lastAttempt ? await this.durableSession.getEntry(lastAttempt.resultEntryId) : undefined;
		const attempt = lastAttempt && lastResult === undefined ? lastAttempt.attempt + 1 : 1;
		const resultEntryId =
			operation.intent.kind === "compaction" && step === "compaction"
				? operation.intent.resultEntryId
				: operation.intent.kind === "navigation" && step === "branch_summary"
					? operation.intent.summaryEntryId ?? this.durableSession.idGenerator.next()
					: this.durableSession.idGenerator.next();
		const record = {
			type: "step_attempt" as const,
			id: this.durableSession.idGenerator.next(),
			lane,
			runId: operation.id,
			step,
			attempt,
			resultEntryId,
			...(step === "compaction" ? { compactionReason: compactionReason ?? "manual" } : {}),
		};
		return this.durableSession.appendRecord(record as NewRecord<StepAttemptRecord>) as Promise<StepAttemptRecord>;
	}

	private async consumeQueueMessages(
		lane: string,
		runId: string,
		queue: "steer" | "followUp",
		mode: QueueMode,
	): Promise<AgentMessage[]> {
		const reduction = await this.getLaneReduction(lane);
		const operation = reduction.laneState.operation;
		if (!operation || operation.id !== runId || operation.aborting) return [];
		const pending = queue === "steer" ? operation.pendingSteer : operation.pendingFollowUp;
		const selected = mode === "all" ? pending : pending.slice(0, 1);
		const messages: AgentMessage[] = [];
		for (const target of selected) {
			if (target.type !== "message") continue;
			const existing = await this.durableSession.getEntry(target.id);
			if (!existing) await this.durableSession.appendEntry(target, lane);
			messages.push(target.message);
		}
		if (messages.length > 0) {
			await this.refreshSnapshots();
			this.queueUpdatePending = true;
		}
		return messages;
	}

	private async appendAssistantEntry(lane: string, runId: string, message: AssistantMessage): Promise<string> {
		const reduction = await this.getLaneReduction(lane);
		const operation = reduction.laneState.operation;
		if (!operation || operation.id !== runId) throw new HarnessFault("Assistant event references a closed operation", undefined);
		let step: StepAttemptRecord;
		if (operation.step) {
			const records = await this.durableSession.findRecords({ lane, runId, type: "step_attempt", order: "oldestFirst" });
			const current = records.find((record) => record.resultEntryId === operation.step?.resultEntryId);
			if (!current) throw new HarnessFault("Missing durable step checkpoint", undefined);
			step = current;
		} else {
			step = await this.ensureStep(lane, reduction, "assistant");
		}
		const target: ProvisionedEntry = { type: "message", id: step.resultEntryId, message: structuredClone(message) };
		await this.persistOperationEntry(lane, runId, target);
		this.assistantEntries.set(runId, target.id);
		const records = await this.durableSession.findRecords({ lane, runId, type: "usage", order: "oldestFirst" });
		if (!records.some((record) => record.type === "usage" && record.cause === "assistant" && record.entryId === target.id)) {
			await this.durableSession.appendRecord({
				type: "usage",
				id: this.durableSession.idGenerator.next(),
				lane,
				cause: "assistant",
				runId,
				entryId: target.id,
				attempt: step.attempt,
				stopReason: sessionStopReason(message),
				usage: structuredClone(message.usage),
			});
		}
		return target.id;
	}

	private async appendToolStarted(lane: string, runId: string, event: Extract<AgentEvent, { type: "tool_execution_start" }>): Promise<ToolStartedRecord> {
		const assistantEntryId = this.assistantEntries.get(runId);
		if (!assistantEntryId) throw new HarnessFault("Tool event has no durable assistant checkpoint", undefined);
		const records = await this.durableSession.findRecords({ lane, runId, type: "tool_started", order: "oldestFirst" });
		const existing = records.find((record) => record.assistantEntryId === assistantEntryId && record.toolCallId === event.toolCallId);
		if (existing) return existing;
		const target: NewRecord<ToolStartedRecord> = {
			type: "tool_started",
			id: this.durableSession.idGenerator.next(),
			lane,
			runId,
			assistantEntryId,
			toolIndex: this.toolIndex(lane, assistantEntryId, event.toolCallId),
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			effectiveArgs: this.acceptedToolArguments(event.toolName, event.args),
			resultEntryId: this.durableSession.idGenerator.next(),
			replay: this.tools.find((tool) => tool.name === event.toolName)?.replay ?? "never",
		};
		return this.durableSession.appendRecord(target) as Promise<ToolStartedRecord>;
	}

	private acceptedToolArguments(toolName: string, value: unknown): { [key: string]: unknown } {
		const original = asRecord(value) ?? {};
		const tool = this.tools.find((candidate) => candidate.name === toolName);
		if (tool?.prepareArguments === undefined) return structuredClone(original);
		try {
			const prepared = tool.prepareArguments(structuredClone(original));
			return structuredClone(asRecord(prepared) ?? original);
		} catch (error) {
			throw new HarnessFault(`Tool ${toolName} arguments could not be canonically prepared`, error);
		}
	}

	private async foundationIntentForToolCall(lane: string, runId: string, toolCallId: string): Promise<ResultValue<ToolIntent, FoundationError>> {
		const metadata = await this.durableSession.getMetadata();
		const records = await this.durableSession.findFoundationRecords({
			kind: "intent",
			objectType: "tool_intent",
			includePruned: true,
			order: "oldestFirst",
			correlation: { sessionId: metadata.id, laneId: lane, runId, operationId: runId, toolCallId },
		});
		const intents: ToolIntent[] = [];
		for (const record of records) {
			if (record.kind !== "intent" || record.payload === undefined) continue;
			const checked = validateToolIntent(record.payload);
			if (!checked.ok) return Result.err(new FoundationError("side_effect_unknown", "Persisted tool intent failed validation"));
			if (checked.value.toolCallId !== toolCallId) continue;
			const mismatch = foundationBindingCorrelationMismatch(checked.value.binding, record.correlation);
			if (mismatch !== undefined) return Result.err(new FoundationError("invalid_correlation", `Durable tool intent ${mismatch} does not match its record correlation`));
			intents.push(checked.value);
		}
		if (intents.length === 0) return Result.err(new FoundationError("side_effect_unknown", "Durable tool intent is missing"));
		const intentRepresentations = intents.map((intent) => canonicalFoundationJson(intent));
		if (intentRepresentations.some((value) => value !== intentRepresentations[0])) return Result.err(new FoundationError("session_ledger_conflict", "Durable tool intents conflict for one execution identity"));
		const ordered = [...intents].sort((left, right) => canonicalFoundationJson(left).localeCompare(canonicalFoundationJson(right)));
		return Result.ok(ordered[0]!);
	}

	private async foundationReceiptForToolCall(lane: string, runId: string, toolCallId: string): Promise<ResultValue<FoundationReceiptFold, FoundationError>> {
		const intent = await this.foundationIntentForToolCall(lane, runId, toolCallId);
		if (!intent.ok) return intent;
		const metadata = await this.durableSession.getMetadata();
		const records = await this.durableSession.findFoundationRecords({
			kind: "fact",
			objectType: "tool_receipt",
			includePruned: true,
			order: "oldestFirst",
			correlation: { sessionId: metadata.id, laneId: lane, runId, operationId: runId, toolCallId },
		});
		const receipts: ToolReceipt[] = [];
		for (const record of records) {
			if (record.kind !== "fact") continue;
			const checked = validateAndVerifyToolReceipt(record.payload);
			if (!checked.ok) return Result.err(new FoundationError("side_effect_unknown", "Persisted tool receipt failed validation"));
			if (checked.value.toolCallId !== toolCallId) continue;
			const mismatch = foundationBindingCorrelationMismatch(checked.value.binding, record.correlation);
			if (mismatch !== undefined || !receiptMatchesIntentCanonical(checked.value, intent.value)) return Result.err(new FoundationError("session_ledger_conflict", mismatch === undefined ? "Durable tool receipt identity does not match its intent" : `Durable tool receipt ${mismatch} does not match its record correlation`));
			receipts.push(checked.value);
		}
		if (receipts.length === 0) return Result.err(new FoundationError("side_effect_unknown", "Durable tool receipt is missing"));
		const semantic = projectToolReceiptExecutionSemantics(receipts[0]!);
		if (receipts.some((receipt) => projectToolReceiptExecutionSemantics(receipt) !== semantic)) return Result.err(new FoundationError("session_ledger_conflict", "Durable tool receipts conflict for one execution identity"));
		const ordered = [...receipts].sort((left, right) => canonicalFoundationJson(left).localeCompare(canonicalFoundationJson(right)));
		const representative = ordered[0]!;
		const worstSeverity = receipts.reduce<1 | 2 | 3>((worst, receipt) => Math.max(worst, toolReceiptSeverity(receipt)) as 1 | 2 | 3, 1);
		if (worstSeverity === 1) return Result.ok({ representative, outcome: "succeeded", sideEffectState: "none", ...(representative.result === undefined ? {} : { result: representative.result }) });
		const worst = receipts.find((receipt) => toolReceiptSeverity(receipt) === worstSeverity) ?? representative;
		return Result.ok({ representative, outcome: worst.outcome, sideEffectState: worst.sideEffectState });
	}

	private async appendToolResult(lane: string, runId: string, message: ToolResultMessage): Promise<void> {
		const records = await this.durableSession.findRecords({ lane, runId, type: "tool_started", order: "oldestFirst" });
		const started = records.find((record) => record.toolCallId === message.toolCallId);
		if (!started) throw new HarnessFault(`Tool result ${message.toolCallId} has no durable start`, undefined);
		if (started.toolName !== message.toolName) throw new HarnessToolPipelineError("Tool result identity does not match its durable start", "side_effect_unknown");
		const folded = this.foundationExecution === undefined ? undefined : await this.foundationReceiptForToolCall(lane, runId, message.toolCallId);
		if (folded !== undefined && !folded.ok) throw new HarnessToolPipelineError(folded.error.message, "side_effect_unknown");
		const receipt = folded?.ok === true ? folded.value : undefined;
		const terminalToolFailure = this.terminalToolFailureOperations.has(runId);
		if (receipt !== undefined && (receipt.representative.toolCallId !== started.toolCallId || receipt.representative.toolName !== started.toolName)) {
			throw new HarnessToolPipelineError("Durable tool receipt identity does not match its tool start", "side_effect_unknown");
		}
		if (receipt?.outcome === "succeeded" && receipt.sideEffectState === "none" && receipt.result === undefined) {
			throw new HarnessToolPipelineError("Durable tool result payload is missing", "side_effect_unknown");
		}
		const receiptResult = !terminalToolFailure && receipt?.outcome === "succeeded" && receipt.sideEffectState === "none" ? receipt.result : undefined;
		const useCanonicalReceipt = receiptResult !== undefined;
		const receiptFailureMessage: ToolResultMessage | undefined = receipt === undefined
			? undefined
			: {
					role: "toolResult",
					toolCallId: started.toolCallId,
					toolName: started.toolName,
					content: [{ type: "text", text: terminalToolFailure ? `Tool ${started.toolName} terminated after an infrastructure failure` : (receipt.representative.error?.message ?? `Tool ${started.toolName} failed`) }],
					isError: true,
					timestamp: started.timestamp,
				};
		let persisted: Awaited<ReturnType<ContextLedger["persistToolResult"]>> | undefined;
		if (!useCanonicalReceipt && (receiptFailureMessage === undefined || this.compatibilityWriter === undefined)) {
			persisted = await this.ledger.persistToolResult(receiptFailureMessage ?? message, {
				lane,
				runId,
				resultEntryId: started.resultEntryId,
				correlation: this.foundationCorrelation(lane, runId, { runId }),
			});
		}
		let target: ProvisionedEntry;
		if (useCanonicalReceipt) {
			const resultEntry: FoundationToolResultEntry = {
				schemaVersion: 1,
				runId,
				operationId: runId,
				toolCallId: message.toolCallId,
				toolName: message.toolName,
				isError: false,
				result: receiptResult,
			};
			target = {
				type: "custom",
				id: started.resultEntryId,
				customType: FOUNDATION_TOOL_RESULT_CUSTOM_TYPE,
				data: this.foundationJson(resultEntry, "tool result entry"),
			};
		} else if (receiptFailureMessage !== undefined && persisted === undefined) {
			target = { type: "message", id: started.resultEntryId, message: receiptFailureMessage };
		} else {
			if (persisted === undefined) throw new HarnessFault("Tool result projection was not persisted", undefined);
			target = { type: "message", id: started.resultEntryId, message: persisted.message };
		}
		await this.persistOperationEntry(lane, runId, target);
		if (message.usage) {
			const usageRecords = await this.durableSession.findRecords({ lane, runId, type: "usage", order: "oldestFirst" });
			if (!usageRecords.some((record) => record.type === "usage" && record.cause === "tool" && record.entryId === target.id)) {
				await this.durableSession.appendRecord({
					type: "usage",
					id: this.durableSession.idGenerator.next(),
					lane,
					cause: "tool",
					runId,
					entryId: target.id,
					toolCallId: message.toolCallId,
					usage: structuredClone(message.usage),
				});
			}
		}
	}

	private toolIndex(lane: string, assistantEntryId: string, toolCallId: string): number {
		const entry = this.laneSnapshots.get(lane)?.transcript.find((candidate) => candidate.id === assistantEntryId);
		if (entry?.type !== "message" || entry.message.role !== "assistant") return 0;
		return entry.message.content
			.filter((content) => content.type === "toolCall")
			.findIndex((content) => content.id === toolCallId);
	}

	private async publishAgentEvent(event: AgentEvent): Promise<AgentEvent> {
		event = this.eventTransform === undefined ? event : await this.eventTransform(event);
		this.eventBus.emit({ type: "agent_event", event: structuredClone(event) });
		return event;
	}

	private async processAgentEvent(lane: string, runId: string, event: AgentEvent, signal: AbortSignal): Promise<void> {
		event = await this.publishAgentEvent(event);
		switch (event.type) {
			case "turn_start": {
				if (this.queueUpdatePending) {
					this.queueUpdatePending = false;
					this.emitQueueUpdate();
				}
				const reduction = await this.getLaneReduction(lane);
				if (this.pendingPromptEvents.delete(runId) && reduction.laneState.operation?.intent.kind === "run") {
					for (const message of reduction.laneState.operation.intent.originalPrompt) {
						await this.publishAgentEvent({ type: "message_start", message });
						await this.publishAgentEvent({ type: "message_end", message });
					}
				}
				if (reduction.laneState.operation?.id === runId && reduction.laneState.operation.step === null) {
					await this.ensureStep(lane, reduction, "assistant");
				}
				break;
			}
			case "message_end":
				if (event.message.role === "assistant") {
					await this.appendAssistantEntry(lane, runId, event.message);
					if (event.message.stopReason !== "error" && event.message.stopReason !== "length") this.overflowRecoveryAttempted = false;
				}
				else if (event.message.role === "toolResult") await this.appendToolResult(lane, runId, event.message);
				break;
			case "tool_execution_start":
				await this.appendToolStarted(lane, runId, event);
				break;
			case "agent_end": {
				const finalMessage = [...event.messages].reverse().find((message): message is AssistantMessage => message.role === "assistant");
				if (!finalMessage || finalMessage.stopReason === "deferred") break;
				const current = await this.getLaneReduction(lane);
				if (
					current.laneState.operation?.id === runId &&
					(current.laneState.operation.pendingFollowUp.length > 0 || this.queuedItems(lane, "followUp").length > 0)
				) break;
				if (event.terminationReason !== undefined) {
					const message = `Agent loop terminated due to ${event.terminationReason}`;
					await this.finishOperation(lane, runId, "failed", { code: `agent_loop_${event.terminationReason}`, message });
					break;
				}
				if (finalMessage.stopReason === "aborted" && !signal.aborted) {
					await this.finishOperation(lane, runId, "failed", providerAbortError(finalMessage.errorMessage));
					break;
				}
				const outcome = signal.aborted || finalMessage.stopReason === "aborted"
					? "aborted"
					: finalMessage.stopReason === "error"
						? "failed"
						: "completed";
				const contextPreparationError = this.contextPreparationErrors.get(runId);
				const durableModelError = finalMessage.stopReason === "error" ? await this.foundationModelTerminalError(runId) : undefined;
				await this.finishOperation(
					lane,
					runId,
					outcome,
					signal.aborted
						? USER_ABORT_ERROR
						: finalMessage.stopReason === "error"
						? contextPreparationError === undefined
							? durableModelError ?? this.foundationModelDiagnosticError(finalMessage) ?? operationError(finalMessage.errorMessage ?? "Agent loop failed")
							: operationError(contextPreparationError)
							: undefined,
				);
				break;
			}
		}
		await this.refreshSnapshots();
	}

	private async finishActiveOperation(runId: string): Promise<void> {
		const activeOperation = this.activeOperations.get(runId);
		this.activeOperations.delete(runId);
		if (activeOperation?.kind === "run") this.agentSettlementPending = true;
		this.retryCancelledOperations.delete(runId);
		this.pendingPromptEvents.delete(runId);
		this.contextPreparationErrors.delete(runId);
		this.operationContextInputs.delete(runId);
		try {
			await this.refreshSnapshots();
			if (this.agentSettlementPending && this.activeOperations.size === 0 && this.sessionSnapshot.lanes.every((lane) => lane.operation === null)) {
				this.agentSettlementPending = false;
				this.eventBus.emit({ type: "agent_settled" });
			}
		} catch (error) {
			this.faulted = true;
			this.sessionSnapshot = { ...this.sessionSnapshot, faulted: true };
			if (isHarnessInfrastructureFault(error)) throw error;
			throw new HarnessFault("Harness failed closed while refreshing snapshots", error);
		}
	}

	private async runAgentOperation(lane: string, runId: string): Promise<void> {
		const existing = this.activeOperations.get(runId);
		if (existing) return existing.promise;
		const controller = new AbortController();
		const operation: ActiveOperation = {
			id: runId,
			lane,
			kind: "run",
			controller,
			promise: Promise.resolve(),
		};
		let operationModel = this.defaultModel;
		const promise = (async () => {
			try {
				await this.hookRegistry.emit("before_request", { lane, runId });
				const prepared = await this.contextForOperation(lane, runId);
				operationModel = prepared.model;
				const config = this.loopConfig(lane, runId, prepared.context, controller.signal, prepared.model, prepared.thinkingLevel);
				this.pendingPromptEvents.add(runId);
				await runAgentLoopContinue(
					prepared.context,
					config,
					(event) => this.enqueue(lane, () => this.processAgentEvent(lane, runId, event, controller.signal)),
					controller.signal,
					(model, context, options) => this.streamFoundationModel(lane, runId, model, context, options),
				);
			} catch (error) {
				if (isHarnessInfrastructureFault(error)) {
					this.faulted = true;
					throw error;
				}
				const message: AssistantMessage = {
					role: "assistant",
					content: [{ type: "text", text: "" }],
					api: operationModel.api,
					provider: operationModel.provider,
					model: operationModel.id,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: controller.signal.aborted ? "aborted" : "error",
					errorMessage: toError(error).message,
					timestamp: Date.now(),
				};
				try {
					await this.enqueue(lane, async () => {
						await this.appendAssistantEntry(lane, runId, message);
						await this.finishOperation(
							lane,
							runId,
							controller.signal.aborted ? "aborted" : "failed",
							controller.signal.aborted ? USER_ABORT_ERROR : operationError(error),
						);
					});
				} catch (persistenceError) {
					this.faulted = true;
					if (isHarnessInfrastructureFault(persistenceError)) throw persistenceError;
					throw new HarnessFault("Harness failed closed after operation error", persistenceError);
				}
			} finally {
				await this.finishActiveOperation(runId);
			}
		})();
		void promise.catch(() => undefined);
		operation.promise = promise;
		this.activeOperations.set(runId, operation);
		return promise;
	}

	private startActiveOperation(
		lane: string,
		runId: string,
		work: (signal: AbortSignal) => Promise<void>,
		onFailure: (error: unknown, signal: AbortSignal) => Promise<void>,
	): void {
		if (this.activeOperations.has(runId)) return;
		const controller = new AbortController();
		const operation: ActiveOperation = { id: runId, lane, kind: "summary", controller, promise: Promise.resolve() };
		const promise = (async () => {
			try {
				await work(controller.signal);
			} catch (error) {
				if (isHarnessInfrastructureFault(error)) {
					this.faulted = true;
					throw error;
				}
				try {
					await this.enqueue(lane, () => onFailure(error, controller.signal));
				} catch (persistenceError) {
					this.faulted = true;
					if (isHarnessInfrastructureFault(persistenceError)) throw persistenceError;
					throw new HarnessFault("Harness failed closed after active operation error", persistenceError);
				}
			} finally {
				await this.finishActiveOperation(runId);
			}
		})();
		void promise.catch(() => undefined);
		operation.promise = promise;
		this.activeOperations.set(runId, operation);
	}

	private async startCompactionOperation(lane: string, reduction: LaneReductionResult): Promise<void> {
		const operation = reduction.laneState.operation;
		if (!operation || operation.kind !== "compaction" || operation.intent.kind !== "compaction") return;
		const intent = operation.intent;
		await this.ensureFoundationIntentForOperation(lane, operation.id);
		const branchEntries = await this.getLaneEntries(lane);
		const preparationResult = prepareCompaction(branchEntries, this.compactionSettings);
		if (!preparationResult.ok || preparationResult.value === undefined) {
			await this.finishOperation(lane, operation.id, "declined");
			return;
		}
		const preparation = preparationResult.value;
		const reason = intent.reason ?? "manual";
		const willRetry = intent.willRetry ?? false;
		const step = await this.ensureStep(lane, reduction, "compaction", reason);
		this.startActiveOperation(
			lane,
			operation.id,
			async (signal) => {
				const hookResult = await this.compactionHooks?.before?.({
					preparation,
					branchEntries,
					...(intent.customInstructions === undefined ? {} : { customInstructions: intent.customInstructions }),
					reason,
					willRetry,
					signal,
				});
				if (hookResult?.cancel === true) {
					await this.enqueue(lane, () => this.finishOperation(lane, operation.id, "aborted", USER_ABORT_ERROR));
					return;
				}
				const extensionCompaction = hookResult?.compaction;
				let result: {
					summary: string;
					firstKeptEntryId: string;
					tokensBefore: number;
					retainedTail: AgentMessage[];
					usage?: Usage;
					details?: unknown;
					fromExtension: boolean;
				};
				if (extensionCompaction !== undefined) {
					const firstKeptIndex = extensionCompaction.firstKeptEntryId === ""
						? branchEntries.length
						: branchEntries.findIndex((entry) => entry.id === extensionCompaction.firstKeptEntryId);
					if (firstKeptIndex < 0) throw new FoundationError("invalid_identifier", "Extension compaction references an unknown first kept entry");
					result = {
						summary: extensionCompaction.summary,
						firstKeptEntryId: extensionCompaction.firstKeptEntryId,
						tokensBefore: extensionCompaction.tokensBefore,
						retainedTail: await this.contextMessages(lane, branchEntries.slice(firstKeptIndex)),
						...(extensionCompaction.usage === undefined ? {} : { usage: extensionCompaction.usage }),
						...(extensionCompaction.details === undefined ? {} : { details: extensionCompaction.details }),
						fromExtension: true,
					};
				} else {
					const prepared = await this.contextForOperation(lane, operation.id, "compaction");
					const generated = await generateCompaction(
						preparation,
						this.completionProvider(lane, operation.id),
						prepared.model,
						intent.customInstructions,
						signal,
						prepared.thinkingLevel,
						this.retryPolicy,
						{
							onRetryScheduled: (attempt, maxAttempts, delayMs, errorMessage) => {
								this.eventBus.emit({ type: "summarization_retry_scheduled", attempt, maxAttempts, delayMs, errorMessage });
							},
							onRetryAttemptStart: () => {
								this.eventBus.emit({ type: "summarization_retry_attempt_start", source: "compaction", reason });
							},
							onRetryFinished: () => {
								this.eventBus.emit({ type: "summarization_retry_finished" });
							},
						},
					);
					if (!generated.ok) {
						await this.enqueue(lane, async () => {
							const aborted = generated.error.code === "aborted";
							await this.finishOperation(lane, operation.id, aborted && signal.aborted ? "aborted" : "failed", aborted ? (signal.aborted ? USER_ABORT_ERROR : providerAbortError(generated.error.message)) : operationError(generated.error));
						});
						return;
					}
					const firstRetained = generated.value.retainedTail[0];
					const firstKeptEntryId = firstRetained === undefined
						? ""
						: branchEntries.find((entry) => entry.type === "message" && canonicalFoundationJson(entry.message) === canonicalFoundationJson(firstRetained))?.id ?? "";
					const contextSnapshotId = this.contextSnapshotIdForOperation?.(operation.id, "compaction");
					result = {
						...generated.value,
						firstKeptEntryId,
						details: {
							...(asRecord(generated.value.details) ?? {}),
							...(contextSnapshotId === undefined ? {} : { contextSnapshotId }),
						},
						fromExtension: false,
					};
				}
				await this.enqueue(lane, async () => {
					const entry: ProvisionedEntry = {
						type: "compaction",
						id: step.resultEntryId,
						summary: result.summary,
						retainedTail: result.retainedTail,
						firstKeptEntryId: result.firstKeptEntryId,
						tokensBefore: result.tokensBefore,
						...(result.details !== undefined ? { details: result.details } : {}),
						...(result.usage ? { usage: result.usage } : {}),
						...(result.fromExtension ? { fromExtension: true } : {}),
					};
					await this.persistOperationEntry(lane, operation.id, entry);
					if (result.usage) await this.durableSession.appendRecord({ type: "usage", id: this.durableSession.idGenerator.next(), lane, cause: "compaction", runId: operation.id, entryId: entry.id, attempt: step.attempt, stopReason: "stop", usage: result.usage });
					await this.finishOperation(lane, operation.id, "completed");
					const persisted = await this.durableSession.getEntry(entry.id);
					if (persisted?.type === "compaction") {
						await this.compactionHooks?.after?.({
							entry: persisted,
							result: {
								summary: result.summary,
								firstKeptEntryId: result.firstKeptEntryId,
								tokensBefore: result.tokensBefore,
								estimatedTokensAfter: estimateContextTokens([
									{ role: "compactionSummary", summary: result.summary, tokensBefore: result.tokensBefore, timestamp: Date.now() },
									...result.retainedTail,
								]).tokens,
								...(result.usage === undefined ? {} : { usage: result.usage }),
								...(result.details === undefined ? {} : { details: result.details }),
								fromExtension: result.fromExtension,
							},
							reason,
							willRetry,
						});
					}
				});
			},
			async (error, signal) => this.finishOperation(lane, operation.id, signal.aborted ? "aborted" : "failed", signal.aborted ? USER_ABORT_ERROR : operationError(error)),
		);
	}

	private async startNavigationOperation(lane: string, reduction: LaneReductionResult): Promise<void> {
		const operation = reduction.laneState.operation;
		if (!operation || operation.kind !== "navigation" || operation.intent.kind !== "navigation") return;
		await this.ensureFoundationIntentForOperation(lane, operation.id);
		const intent = operation.intent;
		const sourceEntries = operation.resumeBoundary.branchId
			? await this.durableSession.findEntriesOnBranch({ start: operation.resumeBoundary.branchId, stopAtId: intent.targetId ?? undefined, order: "oldestFirst" })
			: [];
		const targetPath = intent.targetId === null ? [] : await this.durableSession.findEntriesOnBranch({ start: intent.targetId, order: "newestFirst" });
		const sourceIds = new Set(operation.resumeBoundary.branchId === null ? [] : (await this.durableSession.findEntriesOnBranch({ start: operation.resumeBoundary.branchId, order: "newestFirst" })).map((entry) => entry.id));
		const commonAncestorId = targetPath.find((entry) => sourceIds.has(entry.id))?.id ?? null;
		const step = intent.summarize ? await this.ensureStep(lane, reduction, "branch_summary") : undefined;
		this.startActiveOperation(
			lane,
			operation.id,
			async (signal) => {
				const hookResult = await this.navigationHooks?.before?.({
					preparation: {
						targetId: intent.targetId,
						oldLeafId: operation.resumeBoundary.branchId,
						commonAncestorId,
						entriesToSummarize: sourceEntries,
						userWantsSummary: intent.summarize,
						...(intent.customInstructions === undefined ? {} : { customInstructions: intent.customInstructions }),
						...(intent.replaceInstructions === undefined ? {} : { replaceInstructions: intent.replaceInstructions }),
						...(intent.label === undefined ? {} : { label: intent.label }),
					},
					signal,
				});
				if (hookResult?.cancel === true) {
					await this.enqueue(lane, () => this.finishOperation(lane, operation.id, "declined"));
					return;
				}
				const customInstructions = hookResult?.customInstructions ?? intent.customInstructions;
				const replaceInstructions = hookResult?.replaceInstructions ?? intent.replaceInstructions;
				const label = hookResult?.label ?? intent.label;
				if (!intent.summarize) {
					await this.enqueue(lane, async () => {
						await this.durableSession.moveLane(lane, intent.targetId);
						if (label !== undefined && intent.targetId !== null) await this.durableSession.setLabel(intent.targetId, label);
						await this.finishOperation(lane, operation.id, "completed");
						await this.navigationHooks?.after?.({ oldLeafId: operation.resumeBoundary.branchId, newLeafId: intent.targetId });
					});
					return;
				}
				if (step === undefined) throw new HarnessFault("Navigation summary has no durable step", undefined);
				const extensionSummary = hookResult?.summary;
				const generated = extensionSummary === undefined
					? await (async () => {
							const prepared = await this.contextForOperation(lane, operation.id, "branch_summary");
							return generateBranchSummary(sourceEntries, {
								models: this.completionProvider(lane, operation.id),
								model: prepared.model,
								signal,
								customInstructions,
								replaceInstructions,
								retry: this.retryPolicy,
								callbacks: {
									onRetryScheduled: (attempt, maxAttempts, delayMs, errorMessage) => {
										this.eventBus.emit({ type: "summarization_retry_scheduled", attempt, maxAttempts, delayMs, errorMessage });
									},
									onRetryAttemptStart: () => {
										this.eventBus.emit({ type: "summarization_retry_attempt_start", source: "branchSummary" });
									},
									onRetryFinished: () => {
										this.eventBus.emit({ type: "summarization_retry_finished" });
									},
								},
							});
						})()
					: undefined;
				const contextSnapshotId = extensionSummary === undefined
					? this.contextSnapshotIdForOperation?.(operation.id, "branch_summary")
					: undefined;
				await this.enqueue(lane, async () => {
					if (generated !== undefined && !generated.ok) {
						const aborted = generated.error.code === "aborted";
						await this.finishOperation(lane, operation.id, aborted && signal.aborted ? "aborted" : "failed", aborted ? (signal.aborted ? USER_ABORT_ERROR : providerAbortError(generated.error.message)) : operationError(generated.error));
						return;
					}
					const summary = extensionSummary ?? generated!.value;
					await this.durableSession.moveLane(lane, intent.targetId);
					const summaryEntry: ProvisionedEntry = {
						type: "branch_summary",
						id: step.resultEntryId,
						fromId: operation.resumeBoundary.branchId ?? intent.targetId ?? "root",
						summary: summary.summary,
						...(extensionSummary === undefined
							? { details: {
									readFiles: generated!.value.readFiles,
									modifiedFiles: generated!.value.modifiedFiles,
									...(contextSnapshotId === undefined ? {} : { contextSnapshotId }),
								} }
							: extensionSummary.details === undefined ? {} : { details: extensionSummary.details }),
						...(summary.usage === undefined ? {} : { usage: summary.usage }),
						...(extensionSummary === undefined ? {} : { fromExtension: true }),
					};
					await this.persistOperationEntry(lane, operation.id, summaryEntry);
					if (summary.usage) await this.durableSession.appendRecord({ type: "usage", id: this.durableSession.idGenerator.next(), lane, cause: "branch_summary", runId: operation.id, entryId: summaryEntry.id, attempt: step.attempt, stopReason: "stop", usage: summary.usage });
					if (label !== undefined) await this.durableSession.setLabel(summaryEntry.id, label);
					await this.finishOperation(lane, operation.id, "completed");
					const persisted = await this.durableSession.getEntry(summaryEntry.id);
					await this.navigationHooks?.after?.({
						oldLeafId: operation.resumeBoundary.branchId,
						newLeafId: summaryEntry.id,
						...(persisted?.type === "branch_summary" ? { summaryEntry: persisted } : {}),
						fromExtension: extensionSummary !== undefined,
					});
				});
			},
			async (error, signal) => this.finishOperation(lane, operation.id, signal.aborted ? "aborted" : "failed", signal.aborted ? USER_ABORT_ERROR : operationError(error)),
		);
	}

	private async ensureDeferredFetchIntent(lane: string, runId: string, handle: DeferredHandle): Promise<DeferredFetchState> {
		const reduction = await this.getLaneReduction(lane);
		const existing = reduction.laneState.operation?.deferredFetch;
		if (existing !== null && existing !== undefined) {
			if (existing.intent.handle.provider !== handle.provider || existing.intent.handle.id !== handle.id) throw new HarnessFault("Deferred fetch intent does not match its assistant handle", undefined);
			return existing;
		}
		const responseEntryId = this.durableSession.idGenerator.next();
		await this.durableSession.view(lane).appendCustomEntry(DEFERRED_FETCH_INTENT_CUSTOM_TYPE, { schemaVersion: 1, runId, status: "pending", handle: structuredClone(handle), responseEntryId });
		await this.refreshSnapshots();
		const refreshed = (await this.getLaneReduction(lane)).laneState.operation?.deferredFetch;
		if (refreshed === null || refreshed === undefined) throw new HarnessFault("Deferred fetch intent was not durably recorded", undefined);
		return refreshed;
	}

	private async persistDeferredFetchResult(lane: string, runId: string, state: DeferredFetchState, status: "succeeded" | "failed" | "unknown", response?: AssistantMessage, error?: OperationError): Promise<void> {
		const data = { schemaVersion: 1, runId, status, responseEntryId: state.intent.responseEntryId, ...(response === undefined ? {} : { response: structuredClone(response) }), ...(error === undefined ? {} : { error: structuredClone(error) }) };
		const entries = await this.getLaneEntries(lane);
		const existing = entries.find((entry) => {
			if (entry.type !== "custom" || entry.customType !== DEFERRED_FETCH_RESULT_CUSTOM_TYPE) return false;
			return asRecord(entry.data)?.runId === runId;
		});
		if (existing !== undefined) {
			if (existing.type !== "custom" || canonicalFoundationJson(existing.data) !== canonicalFoundationJson(data)) throw new HarnessFault("Deferred fetch result conflicts with its replay payload", undefined);
			return;
		}
		await this.durableSession.view(lane).appendCustomEntry(DEFERRED_FETCH_RESULT_CUSTOM_TYPE, data);
	}

	private async applyDeferredFetchResult(lane: string, operation: NonNullable<LaneReductionResult["laneState"]["operation"]>): Promise<void> {
		const deferred = operation.deferredFetch;
		if (!deferred?.result) return;
		if (deferred.result.status !== "succeeded" || deferred.result.response === undefined) {
			await this.finishOperation(lane, operation.id, "failed", deferred.result.error ?? { code: "deferred_fetch_side_effect_unknown", message: "Deferred fetch execution state is unknown" });
			return;
		}
		const response = deferred.result.response;
		const target: ProvisionedEntry = { type: "message", id: deferred.intent.responseEntryId, message: response };
		await this.persistOperationEntry(lane, operation.id, target);
		const usageRecords = await this.durableSession.findRecords({ lane, runId: operation.id, type: "usage", order: "oldestFirst" });
		if (!usageRecords.some((record) => record.type === "usage" && record.cause === "deferred_fetch" && record.entryId === target.id)) {
			const stepAttempts = await this.durableSession.findRecords({ lane, runId: operation.id, type: "step_attempt", order: "oldestFirst" });
			const deferredAttempt = [...stepAttempts].reverse().find((record) => record.step === "assistant");
			if (deferredAttempt === undefined) throw new HarnessFault("Deferred fetch result has no assistant step attempt", undefined);
			await this.durableSession.appendRecord({ type: "usage", id: this.durableSession.idGenerator.next(), lane, cause: "deferred_fetch", runId: operation.id, entryId: target.id, attempt: deferredAttempt.attempt, stopReason: sessionStopReason(response), usage: response.usage });
		}
		await this.finishOperation(lane, operation.id, response.stopReason === "error" ? "failed" : "completed", response.stopReason === "error" ? operationError(response.errorMessage ?? "Deferred fetch failed") : undefined);
	}

	private async startDeferredOperation(lane: string, reduction: LaneReductionResult): Promise<void> {
		const operation = reduction.laneState.operation;
		if (!operation || operation.kind !== "run" || !operation.deferred) return;
		await this.ensureFoundationIntentForOperation(lane, operation.id);
		const fetchState = await this.ensureDeferredFetchIntent(lane, operation.id, operation.deferred);
		if (fetchState.result) {
			await this.applyDeferredFetchResult(lane, operation);
			return;
		}
		const model = (await this.contextForOperation(lane)).model;
		this.startActiveOperation(
			lane,
			operation.id,
			async (signal) => {
				try {
					const response = await this.models.fetchDeferred(model, operation.deferred!, { signal });
					await this.enqueue(lane, async () => {
						const unknown = response.stopReason === "aborted";
						const responseError = unknown
							? { code: "deferred_fetch_side_effect_unknown", message: "Deferred fetch execution state is unknown" }
							: response.stopReason === "error"
								? operationError(response.errorMessage ?? "Deferred fetch failed")
								: undefined;
						await this.persistDeferredFetchResult(lane, operation.id, fetchState, unknown ? "unknown" : response.stopReason === "error" ? "failed" : "succeeded", unknown ? undefined : response, responseError);
						await this.applyDeferredFetchResult(lane, (await this.getLaneReduction(lane)).laneState.operation!);
					});
				} catch (error) {
					await this.enqueue(lane, async () => {
						await this.persistDeferredFetchResult(lane, operation.id, fetchState, "unknown", undefined, { code: "deferred_fetch_side_effect_unknown", message: "Deferred fetch execution state is unknown" });
						throw error;
					});
				}
			},
			async (error, signal) => this.finishOperation(lane, operation.id, signal.aborted ? "aborted" : "failed", signal.aborted ? { code: "deferred_fetch_side_effect_unknown", message: "Deferred fetch execution state is unknown" } : operationError(error)),
		);
	}

	private async finishOperation(lane: string, runId: string, outcome: "completed" | "declined" | "failed" | "aborted", error?: OperationError): Promise<void> {
		const records = await this.durableSession.findRecords({ lane, runId, type: "operation_finished", order: "oldestFirst" });
		if (records.length > 0) {
			this.terminalToolFailureOperations.delete(runId);
			return;
		}
		const toolOutcome = this.foundationExecution === undefined ? undefined : await this.foundationToolOutcome(lane, runId);
		const effectiveOutcome = outcome === "completed" && toolOutcome?.failed === true ? "failed" : outcome;
		const effectiveError = error ?? toolOutcome?.error;
		await this.hookRegistry.emit("before_run_end", { lane, runId, outcome: effectiveOutcome });
		const foundationBundle = await this.persistFoundationReceipts(lane, runId, effectiveOutcome, effectiveError);
		const correlation = this.foundationCorrelation(lane, runId, {
			runId,
			...(foundationBundle === undefined ? {} : {
				attemptId: foundationBundle.attemptId,
				attemptReceiptId: foundationBundle.attemptReceipt.attemptReceiptId,
				...(foundationBundle.taskResult === undefined ? {} : { taskResultId: foundationBundle.taskResult.taskResultId }),
				...(foundationBundle.runReceipt === undefined ? {} : { runReceiptId: foundationBundle.runReceipt.runReceiptId }),
			}),
		});
		await this.durableSession.appendRecord({
			type: "operation_finished",
			id: this.durableSession.idGenerator.next(),
			lane,
			runId,
			outcome: effectiveOutcome,
			...(correlation === undefined ? {} : { correlation }),
			...(effectiveError ? { error: effectiveError } : {}),
		});
		const leafId = await this.durableSession.view(lane).getLeafId();
		const finalEntry = leafId ? await this.durableSession.view(lane).findEntryOnBranch({ start: leafId, type: "message" }) : undefined;
		const checkpointId = finalEntry?.id;
		this.eventBus.emit({
			type: "run_end",
			lane,
			runId,
			outcome: effectiveOutcome === "declined" ? "failed" : effectiveOutcome,
			leafId: leafId ?? "",
			...(checkpointId ? { checkpointId } : {}),
		});
		await this.refreshSnapshots();
		this.terminalToolFailureOperations.delete(runId);
	}

	private async actionForReduction(lane: string, reduction: LaneReductionResult): Promise<ActionInfo | undefined> {
		const operation = reduction.laneState.operation;
		if (!operation) return undefined;
		if (this.activeOperations.get(operation.id)?.lane === lane) return undefined;
		if (operation.intent.kind === "run" && operation.missingInitialMessages[0]) {
			return { kind: "append_entry", entryType: operation.missingInitialMessages[0].type, entryId: operation.missingInitialMessages[0].id };
		}
		if (operation.pendingWrites[0]) return { kind: "apply_pending_write", entryId: operation.pendingWrites[0].id };
		if (operation.aborting) return { kind: "try_finish_run", outcome: "aborted", error: USER_ABORT_ERROR };
		if (reduction.terminalFailure) return { kind: "try_finish_run", outcome: "failed" };
		if (operation.deferred) {
			if (operation.deferredFetch?.result?.status === "succeeded" && operation.deferredFetch.result.response !== undefined) return { kind: "apply_deferred_fetch_result" };
			if (operation.deferredFetch?.result !== undefined) return { kind: "try_finish_run", outcome: "failed" };
			if (operation.deferredFetch !== null) return { kind: "try_finish_run", outcome: "failed" };
			return { kind: "fetch_deferred", provider: operation.deferred.provider, id: operation.deferred.id };
		}
		if (operation.toolBatch?.receiptConflict) {
			return { kind: "try_finish_run", outcome: "failed", error: { code: "session_ledger_conflict", message: "Durable tool receipts conflict for one execution identity" } };
		}
		if (operation.toolBatch?.unresolved) {
			const call = operation.toolBatch.calls.find((candidate) => !candidate.resultExists);
			if (call) return { kind: "execute_tool", toolCallId: call.toolCall.id, toolName: call.toolCall.name };
		}
		if (operation.pendingSteer[0]) return { kind: "consume_queue_item", queue: "steer", entryId: operation.pendingSteer[0].id };
		if (operation.pendingFollowUp[0]) return { kind: "commit_follow_up" };
		if (operation.kind === "run") {
			if (operation.newestOwn?.role === "assistant") {
				const stopReason = operation.newestOwn.stopReason;
				if (stopReason === "aborted") return { kind: "try_finish_run", outcome: "aborted", error: { code: "aborted_recovered", message: "Recovered an aborted assistant outcome" } };
				if (stopReason === "error") return { kind: "try_finish_run", outcome: "failed" };
				if (operation.toolBatch && !operation.toolBatch.unresolved) return { kind: "stream_assistant", step: "assistant", attempt: 1 };
				return { kind: "finish_operation", outcome: "completed" };
			}
			return { kind: "stream_assistant", step: "assistant", attempt: 1 };
		}
		if (operation.step) return { kind: "stream_assistant", step: operation.step.kind, attempt: operation.step.attempts };
		if (operation.kind === "compaction" && operation.intent.kind === "compaction" && !operation.targets.result) {
			return { kind: "stream_assistant", step: "compaction", attempt: 1 };
		}
		if (operation.kind === "navigation" && operation.intent.kind === "navigation") {
			if (operation.intent.summarize && !operation.targets.summary) return { kind: "stream_assistant", step: "branch_summary", attempt: 1 };
			if (!operation.intent.summarize && reduction.laneState.leafId !== operation.intent.targetId) return { kind: "stream_assistant", step: "branch_summary", attempt: 1 };
		}
		return { kind: "finish_operation", outcome: "completed" };
	}

	private async performAction(lane: string, action: ActionInfo): Promise<void> {
		const reduction = await this.getLaneReduction(lane);
		const operation = reduction.laneState.operation;
		if (!operation) return;
		switch (action.kind) {
			case "append_entry":
				if (operation.intent.kind === "run") await this.ensureInitialMessage(lane, reduction);
				break;
			case "apply_pending_write":
				if (operation.pendingWrites[0]) await this.persistOperationEntry(lane, operation.id, operation.pendingWrites[0]);
				break;
			case "consume_queue_item":
				await this.consumeQueueMessages(lane, operation.id, action.queue, "one-at-a-time");
				break;
			case "commit_follow_up":
				await this.consumeQueueMessages(lane, operation.id, "followUp", "one-at-a-time");
				break;
			case "stream_assistant":
				if (operation.kind === "run") {
					await this.ensureFoundationIntentForOperation(lane, operation.id);
					await this.ensureStep(lane, reduction, "assistant");
					this.eventBus.emit({ type: "run_start", lane, runId: operation.id, operationId: operation.id });
					void this.runAgentOperation(lane, operation.id).catch(() => undefined);
				} else if (operation.kind === "compaction") await this.startCompactionOperation(lane, reduction);
				else await this.startNavigationOperation(lane, reduction);
				break;
			case "execute_tool":
				{
					const intentType = "harness.action.execute_tool.intent";
					const resultType = "harness.action.execute_tool.result";
					const prior = (await this.getLaneEntries(lane)).filter((entry) => entry.type === "custom" && entry.customType === resultType);
					const alreadyRecorded = prior.some((entry) => entry.type === "custom" && asRecord(entry.data)?.runId === operation.id && asRecord(entry.data)?.toolCallId === action.toolCallId);
					if (!alreadyRecorded) {
						await this.durableSession.view(lane).appendCustomEntry(intentType, { runId: operation.id, toolCallId: action.toolCallId, toolName: action.toolName, status: "replay_required" });
						await this.durableSession.view(lane).appendCustomEntry(resultType, { runId: operation.id, toolCallId: action.toolCallId, toolName: action.toolName, status: "failed", reason: "recovery_requires_explicit_tool_replay" });
					}
					await this.finishOperation(lane, operation.id, "failed", { code: "tool_replay_required", message: `Recovery requires explicit replay of tool ${action.toolName}` });
				}
				break;
			case "fetch_deferred":
				await this.startDeferredOperation(lane, reduction);
				break;
			case "apply_deferred_fetch_result":
				await this.applyDeferredFetchResult(lane, operation);
				break;
			case "move_lane":
				await this.durableSession.moveLane(lane, action.to);
				await this.finishOperation(lane, operation.id, "completed");
				break;
			case "try_finish_run":
				await this.finishOperation(
					lane,
					operation.id,
					action.outcome === "failed" ? "failed" : action.outcome === "aborted" ? "aborted" : "completed",
					action.outcome === "failed"
						? reduction.terminalFailure
							? operationError(reduction.terminalFailure.message.errorMessage ?? "Agent run failed")
							: operation.deferredFetch?.result && operation.deferredFetch.result.status !== "succeeded"
								? operation.deferredFetch.result.error ?? { code: "deferred_fetch_side_effect_unknown", message: "Deferred fetch execution state is unknown" }
								: undefined
						: action.error,
				);
				break;
			case "finish_operation":
				await this.finishOperation(lane, operation.id, action.outcome);
				break;
		}
		await this.refreshSnapshots();
	}

	private async runOutcome(lane: string, runId: string): Promise<RunResult> {
		const records = await this.durableSession.findRecords({ lane, runId, order: "oldestFirst" });
		const finish = records.find((record) => record.type === "operation_finished");
		const finalStep = records
			.filter((record): record is StepAttemptRecord => record.type === "step_attempt" && record.step === "assistant")
			.at(-1);
		const finalEntry = finalStep === undefined ? undefined : await this.durableSession.getEntry(finalStep.resultEntryId);
		const finalMessage = finalEntry?.type === "message" && finalEntry.message.role === "assistant" ? finalEntry.message : undefined;
		const leafId = finalEntry?.id ?? await this.durableSession.view(lane).getLeafId() ?? "";
		if (!finish || !finalEntry || !finalMessage) {
			return Result.ok({ runId, kind: "failed", leafId, error: { code: "suspended", message: "Run is not finished" }, ...(finalEntry ? { finalEntryId: finalEntry.id } : {}) });
		}
		if (finish.outcome === "aborted") return Result.ok({ runId, kind: "aborted", leafId, finalEntryId: finalEntry.id, finalMessage });
		if (finish.outcome === "failed") return Result.ok({ runId, kind: "failed", leafId, error: finish.error ?? { code: "failed", message: finalMessage.errorMessage ?? "Run failed" }, finalEntryId: finalEntry.id, finalMessage });
		return Result.ok({ runId, kind: "completed", leafId, finalEntryId: finalEntry.id, finalMessage });
	}

	private async compactOutcome(lane: string, runId: string): Promise<CompactionResult> {
		const records = await this.durableSession.findRecords({ lane, runId, order: "oldestFirst" });
		const finish = records.find((record) => record.type === "operation_finished");
		const compactionStep = records.find((record): record is StepAttemptRecord => record.type === "step_attempt" && record.step === "compaction");
		const entryId = compactionStep?.resultEntryId;
		const entry = entryId ? await this.durableSession.getEntry(entryId) : undefined;
		const leafId = await this.durableSession.view(lane).getLeafId();
		if (finish?.outcome === "completed" && entry?.type === "compaction") return Result.ok({ runId, kind: "completed", leafId: leafId ?? "", entry });
		if (finish?.outcome === "declined" || finish?.outcome === "aborted") return Result.ok({ runId, kind: finish.outcome, leafId: leafId ?? "" });
		return Result.ok({ runId, kind: "failed", leafId: leafId ?? "", error: finish?.error ?? { code: "failed", message: "Compaction failed" } });
	}

	private async navigationOutcome(lane: string, runId: string): Promise<NavigationResult> {
		const records = await this.durableSession.findRecords({ lane, runId, order: "oldestFirst" });
		const finish = records.find((record) => record.type === "operation_finished");
		const summaryStep = records.find((record): record is StepAttemptRecord => record.type === "step_attempt" && record.step === "branch_summary");
		const summaryId = summaryStep?.resultEntryId;
		const summary = summaryId ? await this.durableSession.getEntry(summaryId) : undefined;
		const leafId = await this.durableSession.view(lane).getLeafId();
		if (finish?.outcome === "completed") return Result.ok({ runId, kind: "completed", newLeafId: leafId, ...(summary?.type === "branch_summary" ? { summaryEntry: summary } : {}) });
		if (finish?.outcome === "declined" || finish?.outcome === "aborted") return Result.ok({ runId, kind: finish.outcome, leafId });
		return Result.ok({ runId, kind: "failed", leafId, error: finish?.error ?? { code: "failed", message: "Navigation failed" } });
	}

	private async pendingRunOutcome(lane: string, runId: string): Promise<RunResult> {
		return Result.ok({
			runId,
			kind: "pending",
			leafId: await this.durableSession.view(lane).getLeafId(),
			operationId: runId,
		});
	}

	private async pendingCompactionOutcome(lane: string, runId: string): Promise<CompactionResult> {
		return Result.ok({
			runId,
			kind: "pending",
			leafId: await this.durableSession.view(lane).getLeafId(),
			operationId: runId,
		});
	}

	private async pendingNavigationOutcome(lane: string, runId: string): Promise<NavigationResult> {
		return Result.ok({
			runId,
			kind: "pending",
			leafId: await this.durableSession.view(lane).getLeafId(),
			operationId: runId,
		});
	}

	async getLeafId(): Promise<string | null> {
		return this.getLeafIdOnLane("main");
	}

	async getMessages(): Promise<AgentMessage[]> {
		return this.getMessagesOnLane("main");
	}

	async getMessagesOnLane(lane: string): Promise<AgentMessage[]> {
		return this.runWithLane(lane, async () => structuredClone(await this.contextMessages(lane, await this.getLaneEntries(lane))));
	}

	async getLeafIdOnLane(lane: string): Promise<string | null> {
		return this.runWithLane(lane, () => this.durableSession.view(lane).getLeafId());
	}

	getSessionView(lane: string): SessionTree {
		return this.durableSession.view(lane);
	}

	async prompt(_text: string, _images?: ImageContent[]): Promise<RunResult>;
	async prompt(_message: AgentMessage | AgentMessage[]): Promise<RunResult>;
	async prompt(input: string | AgentMessage | AgentMessage[], images?: ImageContent[]): Promise<RunResult> {
		return this.promptOnLane("main", input, images);
	}

	async promptOnLane(lane: string, input: string | AgentMessage | AgentMessage[], images?: ImageContent[]): Promise<RunResult> {
		return this.runWithLane(lane, () => this.promptImpl(lane, input, images));
	}

	private async promptImpl(
		lane: string,
		input: string | AgentMessage | AgentMessage[],
		images?: ImageContent[],
		requestedRunId?: string,
		continuation = false,
	): Promise<RunResult> {
		if (this.closed) return Result.err(new Closed({ message: "AgentHarness is closed" }));
		const started = await this.startRun(lane, this.normalizePrompt(input, images), requestedRunId, continuation);
		if (!started.ok) return started;
		if (this.drive === "manual") return this.pendingRunOutcome(lane, started.value);
		await this.runToCompletionImpl(lane);
		return this.runOutcome(lane, started.value);
	}

	async skill(name: string, additionalInstructions?: string): Promise<RunResult> {
		return this.skillOnLane("main", name, additionalInstructions);
	}

	async skillOnLane(lane: string, name: string, additionalInstructions?: string): Promise<RunResult> {
		return this.runWithLane(lane, () => this.skillImpl(lane, name, additionalInstructions));
	}

	private async skillImpl(lane: string, name: string, additionalInstructions?: string): Promise<RunResult> {
		const skill = this.resources.skills?.find((candidate) => candidate.name === name);
		if (!skill) return Result.err(new UnknownSkill({ name, message: `Unknown skill: ${name}` }));
		return this.promptImpl(lane, formatSkillInvocation(skill, additionalInstructions));
	}

	async promptFromTemplate(name: string, args: string[] = []): Promise<RunResult> {
		return this.promptFromTemplateOnLane("main", name, args);
	}

	async promptFromTemplateOnLane(lane: string, name: string, args: string[] = []): Promise<RunResult> {
		return this.runWithLane(lane, () => this.promptFromTemplateImpl(lane, name, args));
	}

	private async promptFromTemplateImpl(lane: string, name: string, args: string[] = []): Promise<RunResult> {
		const template = this.resources.promptTemplates?.find((candidate) => candidate.name === name);
		if (!template) return Result.err(new UnknownTemplate({ name, message: `Unknown prompt template: ${name}` }));
		return this.promptImpl(lane, formatPromptTemplateInvocation(template, args));
	}

	async compact(options: { customInstructions?: string } = {}): Promise<CompactionResult> {
		this.eventBus.emit({ type: "compaction_start", reason: "manual" });
		const result = await this.compactOnLane("main", options);
		const completed = result.ok && result.value.kind === "completed";
		const entry = result.ok && result.value.kind === "completed" ? result.value.entry : undefined;
		this.eventBus.emit({
			type: "compaction_end",
			reason: "manual",
			aborted: result.ok && result.value.kind === "aborted",
			willRetry: false,
			...(entry === undefined ? {} : { result: this.compactionEventResult(entry) }),
			...(completed ? {} : { errorMessage: result.ok && result.value.kind === "failed" ? result.value.error.message : "Manual compaction did not complete" }),
		});
		return result;
	}

	async compactOnLane(lane: string, options: { customInstructions?: string } = {}): Promise<CompactionResult> {
		return this.runWithLane(lane, () => this.compactImpl(lane, options));
	}

	async checkCompaction(
		assistantMessage: AssistantMessage,
		skipAbortedCheck = true,
		autoCompaction: (reason: "overflow" | "threshold", willRetry: boolean) => Promise<boolean> = (reason, willRetry) => this.runAutoCompaction(reason, willRetry),
	): Promise<boolean> {
		if (!this.compactionSettings.enabled || !this.modelAvailable) return false;
		if (skipAbortedCheck && assistantMessage.stopReason === "aborted") return false;
		const model = this.currentModel;
		if (assistantMessage.provider !== model.provider || assistantMessage.model !== model.id) return false;
		const entries = await this.getLaneEntries("main");
		const latestCompaction = [...entries].reverse().find((entry): entry is CompactionEntry => entry.type === "compaction");
		if (latestCompaction !== undefined && assistantMessage.timestamp <= latestCompaction.timestamp) return false;
		if (isContextOverflow(assistantMessage, model.contextWindow) || isRecoverableLength(assistantMessage, model.maxTokens)) {
			const willRetry = assistantMessage.stopReason !== "stop";
			if (!willRetry) return autoCompaction("overflow", false);
			if (this.overflowRecoveryAttempted) {
				this.eventBus.emit({
					type: "compaction_end",
					reason: "overflow",
					aborted: false,
					willRetry: false,
					errorMessage: "Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model.",
				});
				return false;
			}
			this.overflowRecoveryAttempted = true;
			return autoCompaction("overflow", true);
		}
		const directContextTokens = calculateContextTokens(assistantMessage.usage);
		let contextTokens = directContextTokens;
		if (assistantMessage.stopReason === "error" || directContextTokens === 0) {
			const messages = await this.getMessages();
			const estimate = estimateContextTokens(messages);
			if (estimate.lastUsageIndex === null) return false;
			const usageMessage = messages[estimate.lastUsageIndex];
			if (
				latestCompaction !== undefined &&
				usageMessage?.role === "assistant" &&
				usageMessage.timestamp <= latestCompaction.timestamp
			) return false;
			contextTokens = estimate.tokens;
		}
		return shouldCompact(contextTokens, model.contextWindow, this.compactionSettings)
			? autoCompaction("threshold", false)
			: false;
	}

	async runAutoCompaction(reason: "overflow" | "threshold", willRetry: boolean): Promise<boolean> {
		if (this.isRunning) return false;
		this.eventBus.emit({ type: "compaction_start", reason });
		const result = await this.runWithLane("main", () => this.compactImpl("main", { reason, willRetry }));
		const completed = result.ok && result.value.kind === "completed";
		const entry = result.ok && result.value.kind === "completed" ? result.value.entry : undefined;
		this.eventBus.emit({
			type: "compaction_end",
			reason,
			aborted: result.ok && result.value.kind === "aborted",
			willRetry: completed && willRetry,
			...(entry === undefined ? {} : { result: this.compactionEventResult(entry) }),
			...(completed ? {} : { errorMessage: result.ok && result.value.kind === "failed" ? result.value.error.message : "Automatic compaction did not complete" }),
		});
		return completed;
	}

	private compactionEventResult(entry: CompactionEntry): HarnessCompactionResult {
		return {
			summary: entry.summary,
			firstKeptEntryId: entry.firstKeptEntryId ?? entry.id,
			tokensBefore: entry.tokensBefore,
			estimatedTokensAfter: estimateContextTokens([
				{ role: "compactionSummary", summary: entry.summary, tokensBefore: entry.tokensBefore, timestamp: entry.timestamp },
				...entry.retainedTail,
			]).tokens,
			...(entry.usage === undefined ? {} : { usage: entry.usage }),
			...(entry.details === undefined ? {} : { details: entry.details }),
			fromExtension: entry.fromExtension === true,
		};
	}

	private async compactImpl(lane: string, options: { customInstructions?: string; reason?: "manual" | "threshold" | "overflow"; willRetry?: boolean } = {}): Promise<CompactionResult> {
		if (this.closed) return Result.err(new Closed({ message: "AgentHarness is closed" }));
		const started = await this.enqueue(lane, async () => {
			const reduction = await this.getLaneReduction(lane);
			if (reduction.laneState.operation) return Result.err<CompactionRejected>(new LaneBusy({ lane, operationId: reduction.laneState.operation.id, operationKind: reduction.laneState.operation.kind, message: "Lane already has an open operation" }));
			const preparation = prepareCompaction(await this.getLaneEntries(lane), this.compactionSettings);
			if (!preparation.ok || preparation.value === undefined) return Result.err<CompactionRejected>(new NothingToCompact({ lane, message: "No compactable session history" }));
			const id = this.durableSession.idGenerator.next();
			const resultEntryId = this.durableSession.idGenerator.next();
			const correlation = this.foundationCorrelation(lane, id, { runId: id });
			await this.durableSession.appendRecord({ type: "operation_started", id, lane, sourceLeafId: reduction.laneState.leafId, ...(correlation === undefined ? {} : { correlation }), intent: { kind: "compaction", ...(options.customInstructions === undefined ? {} : { customInstructions: options.customInstructions }), resultEntryId, ...(options.reason === undefined ? {} : { reason: options.reason }), ...(options.willRetry === undefined ? {} : { willRetry: options.willRetry }) } } satisfies NewRecord<OperationStartedRecord>);
			await this.persistFoundationIntent(lane, id);
			await this.refreshSnapshots();
			return Result.ok<string>(id);
		});
		if (!started.ok) return started;
		if (this.drive === "manual") return this.pendingCompactionOutcome(lane, started.value);
		await this.runToCompletionImpl(lane);
		return this.compactOutcome(lane, started.value);
	}

	async navigateTree(targetId: string | null, options: NavigateOptions = {}): Promise<NavigationResult> {
		return this.navigateTreeOnLane("main", targetId, options);
	}

	async navigateTreeOnLane(targetLane: string, targetId: string | null, options: NavigateOptions = {}): Promise<NavigationResult> {
		return this.runWithLane(targetLane, () => this.navigateTreeImpl(targetLane, targetId, options));
	}

	private async navigateTreeImpl(lane: string, targetId: string | null, options: NavigateOptions = {}): Promise<NavigationResult> {
		if (this.closed) return Result.err(new Closed({ message: "AgentHarness is closed" }));
		const started = await this.enqueue(lane, async () => {
			if (targetId !== null && !(await this.durableSession.getEntry(targetId))) return Result.err<NavigationRejected>(new UnknownTarget({ targetId, message: `Unknown navigation target: ${targetId}` }));
			const reduction = await this.getLaneReduction(lane);
			if (reduction.laneState.operation) return Result.err<NavigationRejected>(new LaneBusy({ lane, operationId: reduction.laneState.operation.id, operationKind: reduction.laneState.operation.kind, message: "Lane already has an open operation" }));
			const id = this.durableSession.idGenerator.next();
			const summaryEntryId = options.summarize ? this.durableSession.idGenerator.next() : undefined;
			const correlation = this.foundationCorrelation(lane, id, { runId: id });
			await this.durableSession.appendRecord({ type: "operation_started", id, lane, sourceLeafId: reduction.laneState.leafId, ...(correlation === undefined ? {} : { correlation }), intent: { kind: "navigation", targetId, summarize: options.summarize === true, ...(options.customInstructions === undefined ? {} : { customInstructions: options.customInstructions }), ...(options.replaceInstructions === undefined ? {} : { replaceInstructions: options.replaceInstructions }), ...(options.label === undefined ? {} : { label: options.label }), ...(summaryEntryId ? { summaryEntryId } : {}) } } satisfies NewRecord<OperationStartedRecord>);
			await this.persistFoundationIntent(lane, id);
			await this.refreshSnapshots();
			return Result.ok<string>(id);
		});
		if (!started.ok) return started;
		if (this.drive === "manual") return this.pendingNavigationOutcome(lane, started.value);
		await this.runToCompletionImpl(lane);
		return this.navigationOutcome(lane, started.value);
	}

	async resume(): Promise<ResumeResult> {
		return this.resumeOnLane("main");
	}

	async resumeOnLane(lane: string): Promise<ResumeResult> {
		return this.runWithLane(lane, () => this.resumeImpl(lane));
	}

	private async resumeImpl(lane: string): Promise<ResumeResult> {
		if (this.closed) return Result.err(new Closed({ message: "AgentHarness is closed" }));
		const reduction = await this.getLaneReduction(lane);
		const operation = reduction.laneState.operation;
		if (!operation) return Result.err(new NothingToResume({ lane, message: "No suspended operation" }));
		if (this.activeOperations.get(operation.id)?.lane === lane) return Result.err(new LaneBusy({ lane, operationId: operation.id, operationKind: operation.kind, message: "Operation is already running" }));
		const missingTools = this.missingTools(reduction.effectiveConfiguration.activeToolNames);
		const missingModels = this.missingModels(reduction.effectiveConfiguration.model);
		if (missingTools.length > 0 || missingModels.length > 0) return Result.err(new MissingIdentities({ lane, tools: missingTools, models: missingModels, message: "Suspended operation requires unavailable identities" }));
		await this.hookRegistry.emit("before_resume", { lane, operationId: operation.id });
		await this.resumeFoundationAttempt(lane, operation.id);
		await this.runToCompletionImpl(lane);
		if (operation.kind === "run") {
			const result = await this.runOutcome(lane, operation.id);
			if (!result.ok) return Result.err(new NothingToResume({ lane, message: result.error.message }));
			return Result.ok({ operation: "run", ...result.value });
		}
		if (operation.kind === "compaction") {
			const result = await this.compactOutcome(lane, operation.id);
			if (!result.ok) return Result.err(new NothingToResume({ lane, message: result.error.message }));
			return Result.ok({ operation: "compaction", ...result.value });
		}
		const result = await this.navigationOutcome(lane, operation.id);
		if (!result.ok) return Result.err(new NothingToResume({ lane, message: result.error.message }));
		return Result.ok({ operation: "navigation", ...result.value });
	}

	async abort(): Promise<AbortResult> {
		return this.abortOnLane("main");
	}

	async abortOnLane(lane: string): Promise<AbortResult> {
		return this.runWithLane(lane, () => this.abortImpl(lane));
	}

	private async abortImpl(lane: string): Promise<AbortResult> {
		if (this.closed) return Result.err(new Closed({ message: "AgentHarness is closed" }));
		return this.enqueue(lane, async () => {
			const reduction = await this.getLaneReduction(lane);
			const operation = reduction.laneState.operation;
			if (!operation) return Result.err<AbortRejected>(new NoActiveOperation({ lane, message: "No active operation" }));
			const steer = operation.pendingSteer.filter((entry) => entry.type === "message").map((entry) => entry.message);
			const followUp = operation.pendingFollowUp.filter((entry) => entry.type === "message").map((entry) => entry.message);
			await this.durableSession.appendRecord({ type: "abort_requested", id: this.durableSession.idGenerator.next(), lane, runId: operation.id });
			for (const entry of [...operation.pendingSteer, ...operation.pendingFollowUp]) {
				await this.durableSession.appendRecord({ type: "queue_cancelled", id: this.durableSession.idGenerator.next(), lane, runId: operation.id, entryId: entry.id });
			}
			await this.cancelFoundationAttempt(lane, operation.id);
			this.activeOperations.get(operation.id)?.controller.abort();
			await this.refreshSnapshots();
			return Result.ok({ runId: operation.id, steer, followUp });
		});
	}

	steer(_text: string, _images?: ImageContent[]): Promise<QueueResult>;
	steer(_message: AgentMessage): Promise<QueueResult>;
	steer(input: string | AgentMessage, images?: ImageContent[]): Promise<QueueResult> {
		return this.steerOnLane("main", input, images);
	}

	steerOnLane(lane: string, input: string | AgentMessage, images?: ImageContent[]): Promise<QueueResult> {
		return this.runWithLane(lane, () => this.enqueueMessage(lane, "steer", this.normalizePrompt(input, images)[0]));
	}

	followUp(_text: string, _images?: ImageContent[]): Promise<QueueResult>;
	followUp(_message: AgentMessage): Promise<QueueResult>;
	followUp(input: string | AgentMessage, images?: ImageContent[]): Promise<QueueResult> {
		return this.followUpOnLane("main", input, images);
	}

	followUpOnLane(lane: string, input: string | AgentMessage, images?: ImageContent[]): Promise<QueueResult> {
		return this.runWithLane(lane, () => this.enqueueMessage(lane, "followUp", this.normalizePrompt(input, images)[0]));
	}

	nextRun(_text: string, _images?: ImageContent[]): Promise<QueueResult>;
	nextRun(_message: AgentMessage): Promise<QueueResult>;
	nextRun(input: string | AgentMessage, images?: ImageContent[]): Promise<QueueResult> {
		return this.nextRunOnLane("main", input, images);
	}

	nextRunOnLane(lane: string, input: string | AgentMessage, images?: ImageContent[]): Promise<QueueResult> {
		return this.runWithLane(lane, () => this.enqueueMessage(lane, "nextRun", this.normalizePrompt(input, images)[0]));
	}

	private enqueueMessage(lane: string, queue: "steer" | "followUp" | "nextRun", message: AgentMessage | undefined): Promise<QueueResult> {
		if (this.closed || this.closing) return Promise.resolve(Result.err(new Closed({ message: "AgentHarness is closed" })));
		if (!message) return Promise.resolve(Result.err(new InvalidMessage({ lane, reason: "empty", message: "Queued message is empty" })));
		const invalid = this.validatePrompt(lane, [message]);
		if (invalid) return Promise.resolve(Result.err(invalid));
		const runId = this.laneSnapshots.get(lane)?.operation?.id;
		if ((queue === "steer" || queue === "followUp") && runId === undefined) {
			return Promise.resolve(Result.err(new NoActiveRun({ lane, message: "No active run" })));
		}
		const target: ProvisionedEntry = { type: "message", id: this.durableSession.idGenerator.next(), message };
		this.pendingQueueMutations.set(target.id, { lane, queue, ...(runId === undefined ? {} : { runId }), target });
		this.emitQueueUpdate();
		return this.enqueue(lane, async () => {
			try {
				const reduction = await this.getLaneReduction(lane);
				const operation = reduction.laneState.operation;
				if ((queue === "steer" || queue === "followUp") && operation?.id !== runId) {
					return Result.err(new NoActiveRun({ lane, message: "No active run" }));
				}
				if (queue === "nextRun") {
					await this.durableSession.appendRecord({
						type: "queue_enqueued",
						id: this.durableSession.idGenerator.next(),
						lane,
						queue,
						target,
					});
				} else {
					await this.durableSession.appendRecord({
						type: "queue_enqueued",
						id: this.durableSession.idGenerator.next(),
						lane,
						queue,
						runId: runId!,
						target,
					});
				}
				await this.refreshSnapshots();
				return Result.ok({ entryId: target.id });
			} finally {
				this.pendingQueueMutations.delete(target.id);
				this.emitQueueUpdate();
			}
		});
	}

	async cancelQueued(entryId: string): Promise<CancelQueuedResult> {
		return this.cancelQueuedOnLane("main", entryId);
	}

	async cancelQueuedOnLane(lane: string, entryId: string): Promise<CancelQueuedResult> {
		return this.runWithLane(lane, () => this.cancelQueuedImpl(lane, entryId));
	}

	private async cancelQueuedImpl(lane: string, entryId: string): Promise<CancelQueuedResult> {
		if (this.closed) return Result.err(new Closed({ message: "AgentHarness is closed" }));
		return this.enqueue(lane, async () => {
			const records = await this.durableSession.findRecords({ lane, type: "queue_enqueued", order: "oldestFirst" });
			const enqueueRecord = records.find((record) => record.target.id === entryId);
			if (!enqueueRecord) return Result.err<CancelQueuedRejected>(new UnknownQueueItem({ lane, entryId, message: `Unknown queued item: ${entryId}` }));
			const entry = await this.durableSession.getEntry(entryId);
			if (entry) return Result.ok({ outcome: "already_consumed" });
			const cancellations = await this.durableSession.findRecords({ lane, type: "queue_cancelled", order: "oldestFirst" });
			if (cancellations.some((record) => record.entryId === entryId)) return Result.ok({ outcome: "already_cleared" });
			await this.durableSession.appendRecord({ type: "queue_cancelled", id: this.durableSession.idGenerator.next(), lane, ...(enqueueRecord.queue === "nextRun" ? {} : { runId: enqueueRecord.runId }), entryId });
			await this.refreshSnapshots();
			return Result.ok({ outcome: "cancelled" });
		});
	}

	async recordUsage(usage: Usage, options: { entryId?: string; details?: JsonValue } = {}): Promise<RecordUsageResult> {
		return this.recordUsageOnLane("main", usage, options);
	}

	async recordUsageOnLane(lane: string, usage: Usage, options: { entryId?: string; details?: JsonValue } = {}): Promise<RecordUsageResult> {
		return this.runWithLane(lane, () => this.recordUsageImpl(lane, usage, options));
	}

	private async recordUsageImpl(lane: string, usage: Usage, options: { entryId?: string; details?: JsonValue } = {}): Promise<RecordUsageResult> {
		if (this.closed) return Result.err(this.closedError());
		return this.enqueue(lane, async () => {
			assertJsonSerializable(usage);
			if (options.details !== undefined) assertJsonSerializable(options.details);
			const reduction = await this.getLaneReduction(lane);
			const runId = reduction.laneState.operation?.id;
			await this.durableSession.appendRecord({
				type: "usage",
				id: this.durableSession.idGenerator.next(),
				lane,
				cause: "adjustment",
				usage: structuredClone(usage),
				...(runId ? { runId } : {}),
				...(options.entryId ? { entryId: options.entryId } : {}),
				...(options.details !== undefined ? { details: structuredClone(options.details) } : {}),
			});
			await this.refreshSnapshots();
			return Result.ok<void>(undefined);
		});
	}

	async waitForIdle(): Promise<void> {
		return this.waitForIdleOnLane("main");
	}

	async waitForIdleOnLane(lane: string): Promise<void> {
		return this.runWithLane(lane, () => this.waitForIdleImpl(lane));
	}

	private async waitForIdleImpl(lane?: string): Promise<void> {
		this.ensureOpen();
		await Promise.all([...this.activeOperations.values()]
			.filter((operation) => lane === undefined || operation.lane === lane)
			.map((operation) => operation.promise.catch(() => undefined)));
		await this.drainMutations(lane);
	}

	async runWhenIdle(callback: () => void | Promise<void>): Promise<void> {
		return this.runWhenIdleOnLane("main", callback);
	}

	async runWhenIdleOnLane(lane: string, callback: () => void | Promise<void>): Promise<void> {
		return this.runWithLane(lane, () => this.runWhenIdleImpl(lane, callback));
	}

	private async runWhenIdleImpl(lane: string, callback: () => void | Promise<void>): Promise<void> {
		await this.waitForIdleImpl(lane);
		if (this.closed) throw new HarnessClosed();
		await callback();
	}

	async peekAction(): Promise<ActionInfo | undefined> {
		return this.peekActionOnLane("main");
	}

	async peekActionOnLane(lane: string): Promise<ActionInfo | undefined> {
		return this.runWithLane(lane, () => this.peekActionImpl(lane));
	}

	private async peekActionImpl(lane: string): Promise<ActionInfo | undefined> {
		this.ensureOpen();
		const reduction = await this.getLaneReduction(lane);
		return this.actionForReduction(lane, reduction);
	}

	async executeAction(): Promise<ActionInfo | undefined> {
		return this.executeActionOnLane("main");
	}

	async executeActionOnLane(lane: string): Promise<ActionInfo | undefined> {
		return this.runWithLane(lane, () => this.executeActionImpl(lane));
	}

	private async executeActionImpl(lane: string): Promise<ActionInfo | undefined> {
		return this.enqueue(lane, async () => {
			this.ensureOpen();
			const reduction = await this.getLaneReduction(lane);
			const action = await this.actionForReduction(lane, reduction);
			if (!action) return undefined;
			await this.performAction(lane, action);
			return action;
		});
	}

	async runToCompletion(): Promise<void> {
		return this.runToCompletionOnLane("main");
	}

	async runToCompletionOnLane(lane: string): Promise<void> {
		return this.runWithLane(lane, () => this.runToCompletionImpl(lane));
	}

	private async runToCompletionImpl(lane: string): Promise<void> {
		this.ensureOpen();
		for (let count = 0; count < 1000; count++) {
			const action = await this.executeActionImpl(lane);
			if (!action) {
				const active = [...this.activeOperations.values()].filter((operation) => operation.lane === lane);
				if (active.length === 0) return;
				// An active operation owns the provider-to-ledger boundary. Its
				// rejection must reach the caller so a durable storage/lease fault is
				// not replaced by a generic failed outcome on the next loop.
				await Promise.all(active.map((operation) => operation.promise));
			}
		}
		throw new HarnessFault("Harness action loop exceeded its deterministic bound", undefined);
	}

	async getModel(): Promise<Model<Api>> {
		return this.getModelOnLane("main");
	}

	async getModelOnLane(lane: string): Promise<Model<Api>> {
		return this.runWithLane(lane, async () => {
			const reduction = await this.getLaneReduction(lane);
			const route = this.foundationExecution?.binding.modelRoute;
			const provider = route?.provider ?? reduction.effectiveConfiguration.model.provider;
			const modelId = route?.model ?? reduction.effectiveConfiguration.model.modelId;
			const model = this.models.getModel(
				provider,
				modelId,
			);
			if (model === undefined) {
				throw new HarnessFault(
					`Configured model is unavailable: ${provider}/${modelId}`,
					undefined,
				);
			}
			return model;
		});
	}

	async setModel(model: Model<Api>): Promise<void> {
		return this.setModelOnLane("main", model);
	}

	async setModelOnLane(lane: string, model: Model<Api>): Promise<void> {
		if (this.foundationExecution !== undefined) return this.runWithLane(lane, () => this.setModelImpl(lane, model));
		this.pendingModels.set(lane, model);
		const mutation = this.runWithLane(lane, () => this.setModelImpl(lane, model));
		await mutation.finally(() => {
			if (this.pendingModels.get(lane) === model) this.pendingModels.delete(lane);
		});
	}

	private async setModelImpl(lane: string, model: Model<Api>): Promise<void> {
		this.ensureOpen();
		const route = this.foundationExecution?.binding.modelRoute;
		if (route !== undefined) {
			if (model.provider !== route.provider || model.id !== route.model) throw new FoundationError("binding_task_before_binding", "Foundation execution model is frozen by its AgentBinding route");
			return;
		}
		await this.enqueue(lane, async () => {
			this.defaultModel = model;
			await this.durableSession.appendEntry({ type: "model_change", id: this.durableSession.idGenerator.next(), provider: model.provider, modelId: model.id }, lane);
			this.modelAvailable = true;
			await this.refreshSnapshots();
		});
	}

	async getThinkingLevel(): Promise<ThinkingLevel> {
		return this.getThinkingLevelOnLane("main");
	}

	async getThinkingLevelOnLane(lane: string): Promise<ThinkingLevel> {
		return this.runWithLane(lane, async () => {
			const route = this.foundationExecution?.binding.modelRoute;
			if (route !== undefined) return route.effort !== undefined && isThinkingLevel(route.effort) ? route.effort : "off";
			return (await this.getLaneReduction(lane)).effectiveConfiguration.thinkingLevel;
		});
	}

	async setThinkingLevel(level: ThinkingLevel): Promise<void> {
		return this.setThinkingLevelOnLane("main", level);
	}

	async setThinkingLevelOnLane(lane: string, level: ThinkingLevel): Promise<void> {
		return this.runWithLane(lane, () => this.setThinkingLevelImpl(lane, level));
	}

	private async setThinkingLevelImpl(lane: string, level: ThinkingLevel): Promise<void> {
		this.ensureOpen();
		const route = this.foundationExecution?.binding.modelRoute;
		if (route !== undefined) {
			if ((route.effort ?? "off") !== level) throw new FoundationError("binding_task_before_binding", "Foundation execution thinking effort is frozen by its AgentBinding route");
			return;
		}
		this.pendingThinkingLevels.set(lane, level);
		const mutation = this.enqueue(lane, async () => {
			await this.durableSession.appendEntry({ type: "thinking_level_change", id: this.durableSession.idGenerator.next(), thinkingLevel: level }, lane);
			await this.refreshSnapshots();
		});
		await mutation.finally(() => {
			if (this.pendingThinkingLevels.get(lane) === level) this.pendingThinkingLevels.delete(lane);
		});
	}

	async getActiveTools(): Promise<string[]> {
		return this.getActiveToolsOnLane("main");
	}

	async getActiveToolsOnLane(lane: string): Promise<string[]> {
		return this.runWithLane(lane, async () => [...(await this.getLaneReduction(lane)).effectiveConfiguration.activeToolNames]);
	}

	async setActiveTools(names: string[]): Promise<void> {
		return this.setActiveToolsOnLane("main", names);
	}

	async setActiveToolsOnLane(lane: string, names: string[]): Promise<void> {
		return this.runWithLane(lane, () => this.setActiveToolsImpl(lane, names));
	}

	private async setActiveToolsImpl(lane: string, names: string[]): Promise<void> {
		this.ensureOpen();
		const requestedNames = [...names];
		this.pendingActiveToolNames.set(lane, requestedNames);
		const mutation = this.enqueue(lane, async () => {
			await this.durableSession.appendEntry({ type: "active_tools_change", id: this.durableSession.idGenerator.next(), activeToolNames: [...names] }, lane);
			await this.refreshSnapshots();
		});
		await mutation.finally(() => {
			if (this.pendingActiveToolNames.get(lane) === requestedNames) this.pendingActiveToolNames.delete(lane);
		});
	}

	async watch(): Promise<WatchHandle<LaneSnapshot>> {
		return this.watchOnLane("main");
	}

	async watchOnLane(lane: string): Promise<WatchHandle<LaneSnapshot>> {
		return this.runWithLane(lane, () => this.watchImpl(lane));
	}

	private async watchImpl(lane: string): Promise<WatchHandle<LaneSnapshot>> {
		this.ensureOpen();
		await this.refreshSnapshots();
		const handle = this.eventBus.watch(() => structuredClone(this.laneSnapshots.get(lane) ?? {
			lane,
			transcript: [],
			leafId: null,
			operation: null,
			queues: { steer: [], followUp: [], nextRun: [] },
			pendingWrites: [],
			faulted: this.faulted,
		}));
		return {
			snapshot: handle.snapshot,
			start: (listener) => handle.start(listener as HarnessEventListener),
			unsubscribe: () => handle.unsubscribe(),
		};
	}

	async lane(name: string): Promise<AgentLane | undefined> {
		if (!(await this.durableSession.getLanes()).some((lane) => lane.lane === name)) return undefined;
		return name === "main" ? this : new BoundAgentLane(this, name);
	}

	async createLane(name: string, at: string | null): Promise<CreateLaneResult> {
		if (this.closed) return Result.err(new Closed({ message: "AgentHarness is closed" }));
		if (name.length === 0 || name === "main") return Result.err(new InvalidLane({ lane: name, reason: "invalid_name", message: "Lane name is invalid" }));
		return this.enqueue("main", async () => {
			try {
				await this.durableSession.createLane(name, at);
				await this.refreshSnapshots();
				return Result.ok<AgentLane>(new BoundAgentLane(this, name));
			} catch (error) {
				if (error instanceof SessionError && error.code === "already_exists") return Result.err(new LaneExists({ lane: name, message: error.message }));
				if (error instanceof SessionError && (error.code === "not_found" || error.code === "invalid_fork_target")) return Result.err(new UnknownTarget({ targetId: at ?? "", message: error.message }));
				if (error instanceof SessionError) return Result.err(new InvalidLane({ lane: name, reason: error.code, message: error.message }));
				throw error;
			}
		});
	}

	async lanes(): Promise<LaneInfo[]> {
		await this.refreshSnapshots();
		return this.sessionSnapshot.lanes.map(({ suspended: _suspended, ...info }) => info);
	}

	async getTools(): Promise<HarnessTool[]> {
		return [...this.tools];
	}

	async setTools(tools: HarnessTool[], activeNames?: string[]): Promise<void> {
		return this.setToolsOnLane("main", tools, activeNames);
	}

	async setToolsOnLane(lane: string, tools: HarnessTool[], activeNames?: string[]): Promise<void> {
		return this.runWithLane(lane, () => this.setToolsImpl(lane, tools, activeNames));
	}

	private async setToolsImpl(lane: string, tools: HarnessTool[], activeNames?: string[]): Promise<void> {
		this.ensureOpen();
		const requestedTools = [...tools];
		const selectedActiveNames = [...(activeNames ?? tools.map((tool) => tool.name))];
		this.tools = requestedTools;
		this.pendingActiveToolNames.set(lane, selectedActiveNames);
		const mutation = this.enqueue(lane, async () => {
			await this.durableSession.appendEntry({ type: "active_tools_change", id: this.durableSession.idGenerator.next(), activeToolNames: selectedActiveNames }, lane);
			await this.persistConfiguration(lane, HARNESS_CONFIGURATION_TYPES.tools, { activeToolNames: selectedActiveNames });
		});
		await mutation.finally(() => {
			if (this.pendingActiveToolNames.get(lane) === selectedActiveNames) this.pendingActiveToolNames.delete(lane);
		});
	}

	async getResources(): Promise<Resources> {
		return {
			skills: this.resources.skills ? [...this.resources.skills] : undefined,
			promptTemplates: this.resources.promptTemplates ? [...this.resources.promptTemplates] : undefined,
		};
	}

	async setResources(resources: Resources): Promise<void> {
		this.ensureOpen();
		await this.enqueue("main", async () => {
			this.resources = {
				skills: resources.skills ? [...resources.skills] : undefined,
				promptTemplates: resources.promptTemplates ? [...resources.promptTemplates] : undefined,
			};
			await this.persistConfiguration("main", HARNESS_CONFIGURATION_TYPES.resources, this.foundationJson(this.resources, "resources") as JsonValue);
		});
	}

	async getStreamOptions(): Promise<StreamOptions> {
		return { ...this.streamOptions };
	}

	async setStreamOptions(options: StreamOptions): Promise<void> {
		this.ensureOpen();
		await this.enqueue("main", async () => {
			this.streamOptions = { ...options };
			await this.persistConfiguration("main", HARNESS_CONFIGURATION_TYPES.streamOptions, this.foundationJson(this.streamOptions, "stream options") as JsonValue);
		});
	}

	async patchStreamOptions(options: StreamOptionsPatch): Promise<void> {
		return this.setStreamOptions({ ...this.streamOptions, ...options });
	}

	async getRetryPolicy(): Promise<RetryPolicy> {
		return { ...this.retryPolicy };
	}

	async setRetryPolicy(policy: RetryPolicy): Promise<void> {
		this.ensureOpen();
		await this.enqueue("main", async () => {
			this.retryPolicy = { ...policy };
			await this.persistConfiguration("main", HARNESS_CONFIGURATION_TYPES.retryPolicy, this.foundationJson(this.retryPolicy, "retry policy") as JsonValue);
		});
	}

	async getCompactionSettings(): Promise<CompactionSettings> {
		return { ...this.compactionSettings };
	}

	async setCompactionSettings(settings: CompactionSettings): Promise<void> {
		this.ensureOpen();
		await this.enqueue("main", async () => {
			this.compactionSettings = { ...settings };
			await this.persistConfiguration("main", HARNESS_CONFIGURATION_TYPES.compaction, this.foundationJson(this.compactionSettings, "compaction settings") as JsonValue);
		});
	}

	async getSteeringMode(): Promise<QueueMode> {
		return this.steeringMode;
	}

	async setSteeringMode(mode: QueueMode): Promise<void> {
		this.ensureOpen();
		await this.enqueue("main", async () => {
			this.steeringMode = mode;
			await this.persistConfiguration("main", HARNESS_CONFIGURATION_TYPES.steeringMode, { mode });
		});
	}

	async getFollowUpMode(): Promise<QueueMode> {
		return this.followUpMode;
	}

	async setFollowUpMode(mode: QueueMode): Promise<void> {
		this.ensureOpen();
		await this.enqueue("main", async () => {
			this.followUpMode = mode;
			await this.persistConfiguration("main", HARNESS_CONFIGURATION_TYPES.followUpMode, { mode });
		});
	}

	async watchSession(): Promise<WatchHandle<SessionSnapshot>> {
		this.ensureOpen();
		await this.refreshSnapshots();
		const handle = this.eventBus.watch(() => structuredClone(this.sessionSnapshot));
		return {
			snapshot: handle.snapshot,
			start: (listener) => handle.start(listener as HarnessEventListener),
			unsubscribe: () => handle.unsubscribe(),
		};
	}

	async close(): Promise<void> {
		if (this.closed) return;
		if (this.closePromise !== undefined) return this.closePromise;
		this.closing = true;
		this.closePromise = (async () => {
			let failure: unknown;
			try {
				for (const operation of this.activeOperations.values()) operation.controller.abort();
				await Promise.all([...this.activeOperations.values()].map((operation) => operation.promise.catch((error) => { failure ??= error; })));
				await this.waitForCompatibilityTasks();
				await this.drainMutations();
				if (failure === undefined) {
					await this.refreshSnapshots();
					const hasOpenOperation = this.sessionSnapshot.lanes.some((lane) => lane.operation !== null);
					if (!this.faulted && !hasOpenOperation) await this.durableSession.appendCustomEntry("harness.closed", { closedAt: Date.now() });
					await this.durableSession.drain();
				}
			} catch (error) {
				failure ??= error;
			} finally {
				try {
					await this.releaseOwnedLedgerLease();
				} catch (error) {
					failure ??= error;
				}
				this.closed = true;
				this.closing = false;
				this.hookRegistry.setClosed();
			}
			if (failure !== undefined) throw failure;
		})();
		return this.closePromise;
	}
}

class BoundAgentLane implements AgentLane {
	readonly session: SessionTree;
	readonly name: string;
	private readonly harness: AgentHarness;

	constructor(harness: AgentHarness, name: string) {
		this.harness = harness;
		this.name = name;
		this.session = harness.getSessionView(name);
	}

	getLeafId(): Promise<string | null> {
		return this.harness.getLeafIdOnLane(this.name);
	}

	getMessages(): Promise<AgentMessage[]> {
		return this.harness.getMessagesOnLane(this.name);
	}

	prompt(text: string, images?: ImageContent[]): Promise<RunResult>;
	prompt(message: AgentMessage | AgentMessage[]): Promise<RunResult>;
	prompt(input: string | AgentMessage | AgentMessage[], images?: ImageContent[]): Promise<RunResult> {
		return this.harness.promptOnLane(this.name, input, images);
	}

	skill(name: string, additionalInstructions?: string): Promise<RunResult> {
		return this.harness.skillOnLane(this.name, name, additionalInstructions);
	}

	promptFromTemplate(name: string, args?: string[]): Promise<RunResult> {
		return this.harness.promptFromTemplateOnLane(this.name, name, args);
	}

	compact(options?: { customInstructions?: string }): Promise<CompactionResult> {
		return this.harness.compactOnLane(this.name, options);
	}

	navigateTree(targetId: string | null, options?: NavigateOptions): Promise<NavigationResult> {
		return this.harness.navigateTreeOnLane(this.name, targetId, options);
	}

	resume(): Promise<ResumeResult> {
		return this.harness.resumeOnLane(this.name);
	}

	abort(): Promise<AbortResult> {
		return this.harness.abortOnLane(this.name);
	}

	steer(text: string, images?: ImageContent[]): Promise<QueueResult>;
	steer(message: AgentMessage): Promise<QueueResult>;
	steer(input: string | AgentMessage, images?: ImageContent[]): Promise<QueueResult> {
		return this.harness.steerOnLane(this.name, input, images);
	}

	followUp(text: string, images?: ImageContent[]): Promise<QueueResult>;
	followUp(message: AgentMessage): Promise<QueueResult>;
	followUp(input: string | AgentMessage, images?: ImageContent[]): Promise<QueueResult> {
		return this.harness.followUpOnLane(this.name, input, images);
	}

	nextRun(text: string, images?: ImageContent[]): Promise<QueueResult>;
	nextRun(message: AgentMessage): Promise<QueueResult>;
	nextRun(input: string | AgentMessage, images?: ImageContent[]): Promise<QueueResult> {
		return this.harness.nextRunOnLane(this.name, input, images);
	}

	cancelQueued(entryId: string): Promise<CancelQueuedResult> {
		return this.harness.cancelQueuedOnLane(this.name, entryId);
	}

	recordUsage(usage: Usage, options?: { entryId?: string; details?: JsonValue }): Promise<RecordUsageResult> {
		return this.harness.recordUsageOnLane(this.name, usage, options);
	}

	waitForIdle(): Promise<void> {
		return this.harness.waitForIdleOnLane(this.name);
	}

	runWhenIdle(callback: () => void | Promise<void>): Promise<void> {
		return this.harness.runWhenIdleOnLane(this.name, callback);
	}

	peekAction(): Promise<ActionInfo | undefined> {
		return this.harness.peekActionOnLane(this.name);
	}

	executeAction(): Promise<ActionInfo | undefined> {
		return this.harness.executeActionOnLane(this.name);
	}

	runToCompletion(): Promise<void> {
		return this.harness.runToCompletionOnLane(this.name);
	}

	getModel(): Promise<Model<Api>> {
		return this.harness.getModelOnLane(this.name);
	}

	setModel(model: Model<Api>): Promise<void> {
		return this.harness.setModelOnLane(this.name, model);
	}

	getThinkingLevel(): Promise<ThinkingLevel> {
		return this.harness.getThinkingLevelOnLane(this.name);
	}

	setThinkingLevel(level: ThinkingLevel): Promise<void> {
		return this.harness.setThinkingLevelOnLane(this.name, level);
	}

	getActiveTools(): Promise<string[]> {
		return this.harness.getActiveToolsOnLane(this.name);
	}

	setActiveTools(names: string[]): Promise<void> {
		return this.harness.setActiveToolsOnLane(this.name, names);
	}

	watch(): Promise<WatchHandle<LaneSnapshot>> {
		return this.harness.watchOnLane(this.name);
	}
}

export interface AgentLane {
	readonly name: string;
	getLeafId(): Promise<string | null>;
	getMessages(): Promise<AgentMessage[]>;
	prompt(text: string, images?: ImageContent[]): Promise<RunResult>;
	prompt(message: AgentMessage | AgentMessage[]): Promise<RunResult>;
	skill(name: string, additionalInstructions?: string): Promise<RunResult>;
	promptFromTemplate(name: string, args?: string[]): Promise<RunResult>;
	compact(options?: { customInstructions?: string }): Promise<CompactionResult>;
	navigateTree(targetId: string | null, options?: NavigateOptions): Promise<NavigationResult>;
	resume(): Promise<ResumeResult>;
	abort(): Promise<AbortResult>;
	steer(text: string, images?: ImageContent[]): Promise<QueueResult>;
	steer(message: AgentMessage): Promise<QueueResult>;
	followUp(text: string, images?: ImageContent[]): Promise<QueueResult>;
	followUp(message: AgentMessage): Promise<QueueResult>;
	nextRun(text: string, images?: ImageContent[]): Promise<QueueResult>;
	nextRun(message: AgentMessage): Promise<QueueResult>;
	cancelQueued(entryId: string): Promise<CancelQueuedResult>;
	recordUsage(usage: Usage, options?: { entryId?: string; details?: JsonValue }): Promise<RecordUsageResult>;
	waitForIdle(): Promise<void>;
	runWhenIdle(callback: () => void | Promise<void>): Promise<void>;
	peekAction(): Promise<ActionInfo | undefined>;
	executeAction(): Promise<ActionInfo | undefined>;
	runToCompletion(): Promise<void>;
	getModel(): Promise<Model<Api>>;
	setModel(model: Model<Api>): Promise<void>;
	getThinkingLevel(): Promise<ThinkingLevel>;
	setThinkingLevel(level: ThinkingLevel): Promise<void>;
	getActiveTools(): Promise<string[]>;
	setActiveTools(names: string[]): Promise<void>;
	readonly session: SessionTree;
	watch(): Promise<WatchHandle<LaneSnapshot>>;
}
