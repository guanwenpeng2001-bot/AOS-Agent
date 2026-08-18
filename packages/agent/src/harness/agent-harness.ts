import type {
	Api,
	AssistantMessage,
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
import { runAgentLoopContinue } from "../agent-loop.ts";
import type { AgentContext, AgentEvent, AgentLoopConfig, AgentMessage, AgentTool, QueueMode, ThinkingLevel } from "../types.ts";
import {
	canonicalFoundationJson,
	createExecutionCorrelation,
	finalizeRunReceipt,
	settleTaskResult,
	validateAttemptReceipt,
	validateDispatchV1,
	validateHostTerminalGateAuthorityV1,
	validateImmutableAgentBindingV1,
	validateTaskEnvelopeV1,
	validateRunReceiptV1,
	validateTaskResultV1,
	type AcceptanceFactV1,
	type AgentBindingV1,
	type ArtifactRefV1,
	type AttemptReceiptV1,
	type DispatchV1,
	type ExecutionCorrelationV1,
	type FoundationJsonValue,
	type HostTerminalGateAuthorityV1,
	type ResultStatusV1,
	type RunReceiptV1,
	type SideEffectStateV1,
	type TaskEnvelopeV1,
	type TaskResultV1,
	type ValidationResultV1,
} from "./foundation/index.ts";
import { compact as generateCompaction, prepareCompaction, type CompactionSettings } from "./compaction/compaction.ts";
import { generateBranchSummary } from "./compaction/branch-summarization.ts";
import { convertToLlm } from "./messages.ts";
import { buildSessionContextAsync, type AsyncCustomEntryContextMessageProjector } from "./session/context.ts";
import { formatPromptTemplateInvocation } from "./prompt-templates.ts";
import { formatSkillInvocation } from "./skills.ts";
import { formatSkillsForSystemPrompt } from "./system-prompt.ts";
import { HarnessEventBus, type HarnessEventListener } from "./events.ts";
import { type Result as ResultValue, Result, TaggedError } from "./result.ts";
import {
	assertJsonSerializable,
	type BranchSummaryEntry,
	type CompactionEntry,
	type Entry,
	type JsonValue,
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
	type FoundationFactRecordV1,
	type FoundationRecordV1,
	type LedgerWriterLeaseV1,
	type ProvisionedFoundationRecordV1,
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
	on(type: string, listener: (event: unknown) => void | Promise<void>): () => void;
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

	on(type: string, listener: (event: unknown) => void | Promise<void>): () => void {
		if (type !== "run_start" && type !== "run_end") return () => {};
		return this.bus.on(type, listener as HarnessEventListener);
	}
}

export type HarnessTool = AgentTool & { replay?: "never" | "safe" };
export type Resources = AgentHarnessResources<Skill, PromptTemplate>;
export type StreamOptions = SimpleStreamOptions;
export type StreamOptionsPatch = Partial<SimpleStreamOptions>;
export type EntryProjector = (entry: Entry) => AgentMessage[] | Promise<AgentMessage[]>;

/**
 * Product execution identity supplied by the caller. The harness never creates
 * a Task, Binding, Dispatch, or AgentInstance on behalf of a prompt.
 */
export interface AgentHarnessFoundationExecution {
	task: TaskEnvelopeV1;
	dispatch: DispatchV1;
	binding: AgentBindingV1;
	providerId: string;
	agentInstanceId: string;
	bindingEpochIds: readonly string[];
	settlement?: {
		summary?: string;
		artifacts?: readonly ArtifactRefV1[];
		diff?: ArtifactRefV1;
		tests?: readonly ValidationResultV1[];
		evidence?: readonly AcceptanceFactV1[];
	};
	hostAuthority?: HostTerminalGateAuthorityV1;
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
	context?: TelemetryContext;
	/** Optional explicit product execution graph; omitted prompts remain session-only. */
	foundationExecution?: AgentHarnessFoundationExecution;
}

export interface WatchHandle<TSnapshot> {
	snapshot: TSnapshot;
	start(listener: (event: unknown) => void): void;
	unsubscribe(): void;
}

interface ActiveOperation {
	id: string;
	lane: string;
	controller: AbortController;
	promise: Promise<void>;
}

interface FoundationReceiptBundle {
	attemptId: string;
	attemptReceipt: AttemptReceiptV1;
	taskResult?: TaskResultV1;
	runReceipt?: RunReceiptV1;
	correlation: ExecutionCorrelationV1;
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

function sessionStopReason(message: AssistantMessage): SessionStopReason {
	return message.stopReason === "pending" ? "error" : message.stopReason;
}

function operationError(error: unknown): OperationError {
	const normalized = toError(error);
	const code = error instanceof SessionError && error.code ? error.code : error instanceof Error ? error.name : "error";
	return { code, message: normalized.message };
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
	readonly hooks: Hooks;
	readonly events: Events;
	private readonly durableSession: Session;
	private readonly models: Models;
	private readonly defaultModel: Model<Api>;
	private readonly defaultThinkingLevel: ThinkingLevel;
	private readonly defaultActiveToolNames: string[];
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
	private readonly entryProjectors: Record<string, EntryProjector>;
	private readonly toolExecution: "sequential" | "parallel";
	private foundationExecution?: AgentHarnessFoundationExecution;
	private readonly foundationOwnerId?: string;
	private foundationSessionId?: string;
	private foundationLease?: LedgerWriterLeaseV1;
	private readonly foundationReceipts = new Map<string, FoundationReceiptBundle>();
	private readonly eventBus = new HarnessEventBus();
	private readonly hookRegistry = new HookRegistry();
	private readonly activeOperations = new Map<string, ActiveOperation>();
	private readonly laneReductions = new Map<string, LaneReductionResult>();
	private readonly mutationTails = new Map<string, Promise<void>>();
	private readonly laneSnapshots = new Map<string, LaneSnapshot>();
	private sessionSnapshot: SessionSnapshot = { lanes: [], faulted: false };
	private readonly assistantEntries = new Map<string, string>();
	private closed = false;
	private closing = false;
	private closePromise?: Promise<void>;
	private faulted = false;

	private constructor(options: AgentHarnessOptions) {
		this.durableSession = options.session;
		this.session = options.session;
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
		this.toolExecution = options.toolExecution ?? "parallel";
		this.foundationExecution = options.foundationExecution === undefined ? undefined : structuredClone(options.foundationExecution);
		this.foundationOwnerId = options.foundationExecution === undefined ? undefined : `agent-harness:${options.session.idGenerator.next()}`;
		this.hooks = this.hookRegistry;
		this.events = new EventsFacade(this.eventBus);
	}

	static async create(
		options: AgentHarnessOptions,
	): Promise<{ harness: AgentHarness; suspended: SuspendedOperation[] }> {
		const harness = new AgentHarness(options);
		try {
			await harness.initializeFoundationExecution();
			const suspended = await harness.restore();
			return { harness, suspended };
		} catch (error) {
			await harness.releaseFoundationLease();
			throw error;
		}
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
		const checkedTask = validateTaskEnvelopeV1(execution.task);
		if (!checkedTask.ok) throw new HarnessFault("Foundation execution task is not an established TaskEnvelope", checkedTask.error);
		const checkedDispatch = validateDispatchV1(execution.dispatch);
		if (!checkedDispatch.ok) throw new HarnessFault("Foundation execution dispatch is not an established Dispatch", checkedDispatch.error);
		const checkedBinding = validateImmutableAgentBindingV1(execution.binding);
		if (!checkedBinding.ok) throw new HarnessFault("Foundation execution binding is not an established immutable AgentBinding", checkedBinding.error);
		if ((execution.hostAuthority === undefined) !== (execution.settlement === undefined)) {
			throw new HarnessFault("Foundation hostAuthority and settlement must be supplied together", undefined);
		}
		const checkedAuthority = execution.hostAuthority === undefined ? undefined : validateHostTerminalGateAuthorityV1(execution.hostAuthority);
		if (checkedAuthority !== undefined && !checkedAuthority.ok) throw new HarnessFault("Foundation host authority is not an established terminal gate", checkedAuthority.error);
		if (execution.providerId !== checkedDispatch.value.taskExecutorProviderId) {
			throw new HarnessFault("Foundation execution provider does not match the Dispatch executor", undefined);
		}
		if (checkedDispatch.value.taskId !== checkedTask.value.taskId || checkedDispatch.value.bindingId !== checkedBinding.value.bindingId) {
			throw new HarnessFault("Foundation execution Dispatch does not match its Task or Binding", undefined);
		}
		if (checkedBinding.value.taskId !== checkedTask.value.taskId) {
			throw new HarnessFault("Foundation execution Binding does not match its Task", undefined);
		}
		const normalizedExecution: AgentHarnessFoundationExecution = {
			...execution,
			task: structuredClone(checkedTask.value),
			dispatch: structuredClone(checkedDispatch.value),
			binding: structuredClone(checkedBinding.value),
			bindingEpochIds: [...execution.bindingEpochIds],
			...(checkedAuthority === undefined ? {} : { hostAuthority: structuredClone(checkedAuthority.value) }),
			...(execution.settlement === undefined ? {} : { settlement: structuredClone(execution.settlement) }),
		};
		this.foundationExecution = normalizedExecution;
		if (normalizedExecution.task.taskId !== normalizedExecution.dispatch.taskId || normalizedExecution.task.taskId !== normalizedExecution.binding.taskId) {
			throw new HarnessFault("Foundation execution task identity does not match the prompt context", undefined);
		}
		if (normalizedExecution.dispatch.bindingId !== normalizedExecution.binding.bindingId) {
			throw new HarnessFault("Foundation execution binding identity does not match the dispatch", undefined);
		}
		if (normalizedExecution.bindingEpochIds.length === 0 || normalizedExecution.bindingEpochIds.some((id) => id.length === 0)) {
			throw new HarnessFault("Foundation execution requires at least one binding epoch", undefined);
		}
		if (normalizedExecution.providerId.length === 0 || normalizedExecution.agentInstanceId.length === 0) {
			throw new HarnessFault("Foundation execution requires provider and AgentInstance identities", undefined);
		}
		const metadata = await this.durableSession.getMetadata();
		this.foundationSessionId = metadata.id;
		try {
			this.foundationLease = await this.durableSession.acquireWriterLease({ ownerId: this.foundationOwnerId! });
		} catch (error) {
			throw new HarnessFault("Failed to acquire the Foundation session writer lease", error);
		}
	}

	private async releaseFoundationLease(): Promise<void> {
		const lease = this.foundationLease;
		if (lease === undefined) return;
		this.foundationLease = undefined;
		await this.durableSession.releaseWriterLease({ fencingToken: lease.fencingToken });
	}

	private async ensureFoundationLease(): Promise<LedgerWriterLeaseV1> {
		const ownerId = this.foundationOwnerId;
		if (ownerId === undefined) throw new HarnessFault("Foundation execution is not initialized", undefined);
		const current = this.foundationLease;
		if (current !== undefined) {
			try {
				const renewed = await this.durableSession.renewWriterLease({ fencingToken: current.fencingToken });
				this.foundationLease = renewed;
				return renewed;
			} catch (error) {
				if (
					!(error instanceof DurableLedgerError) ||
					(error.code !== "session_writer_lease_expired" &&
						error.code !== "session_writer_fencing_token" &&
						error.code !== "session_writer_lease_lost")
				) {
					throw error;
				}
				// Expiry or fencing must be followed by an ownership acquisition. A
				// competing live owner is rejected by acquireWriterLease.
				this.foundationLease = undefined;
			}
		}
		const acquired = await this.durableSession.acquireWriterLease({ ownerId });
		this.foundationLease = acquired;
		return acquired;
	}

	private foundationCorrelation(lane: string, runId: string, fields: Partial<ExecutionCorrelationV1> = {}): ExecutionCorrelationV1 | undefined {
		const execution = this.foundationExecution;
		if (execution === undefined || this.foundationSessionId === undefined) return undefined;
		return createExecutionCorrelation(this.foundationSessionId, lane, {
			bindingId: execution.binding.bindingId,
			bindingEpochId: execution.bindingEpochIds[0],
			agentInstanceId: execution.agentInstanceId,
			goalId: execution.task.goalId,
			taskId: execution.task.taskId,
			dispatchId: execution.dispatch.dispatchId,
			runId,
			...fields,
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

	private async appendFoundation(record: ProvisionedFoundationRecordV1): Promise<FoundationRecordV1> {
		if (this.foundationExecution === undefined) throw new HarnessFault("Foundation execution is not initialized", undefined);
		const lease = await this.ensureFoundationLease();
		const fencingToken = lease.fencingToken;
		const correlation = { ...record.correlation, fencingToken };
		const result = await this.durableSession.appendFoundationRecord({ ...record, fencingToken, correlation });
		return result.record;
	}

	private async appendFoundationFact(
		lane: string,
		objectType: string,
		objectId: string,
		clientRequestId: string,
		payload: FoundationJsonValue,
		correlation: ExecutionCorrelationV1,
	): Promise<FoundationFactRecordV1> {
		const existing = await this.durableSession.getFoundationObject(objectType, objectId);
		if (existing !== undefined) {
			if (existing.kind !== "fact") throw new HarnessFault(`Foundation object ${objectType}/${objectId} is not a fact`, undefined);
			try {
				if (existing.clientRequestId !== clientRequestId || canonicalFoundationJson(existing.payload) !== canonicalFoundationJson(payload)) {
					throw new HarnessFault(`Foundation object ${objectType}/${objectId} conflicts with the replay payload`, undefined);
				}
			} catch (error) {
				if (error instanceof HarnessFault) throw error;
				throw new HarnessFault(`Foundation object ${objectType}/${objectId} is not canonical JSON`, error);
			}
		}
		const record = await this.appendFoundation({
			schemaVersion: 1,
			kind: "fact",
			id: `${objectType}:${objectId}`,
			lane,
			objectType,
			objectId,
			clientRequestId,
			payload,
			correlation,
		});
		if (record.kind !== "fact") throw new HarnessFault(`Foundation fact ${objectType}/${objectId} was not accepted`, undefined);
		return record;
	}

	private async persistFoundationIntent(lane: string, runId: string): Promise<void> {
		if (this.foundationExecution === undefined) return;
		const ids = this.foundationIds(runId);
		const correlation = this.foundationCorrelation(lane, runId, { attemptId: ids.attemptId });
		if (correlation === undefined) throw new HarnessFault("Missing execution correlation for Foundation intent", undefined);
		await this.appendFoundation({
			schemaVersion: 1,
			kind: "intent",
			id: `attempt_intent:${runId}`,
			lane,
			objectType: "attempt",
			objectId: ids.attemptId,
			clientRequestId: `harness:intent:${runId}`,
			intent: "create",
			payload: this.foundationJson({
				schemaVersion: 1,
				attemptId: ids.attemptId,
				taskId: this.foundationExecution.task.taskId,
				dispatchId: this.foundationExecution.dispatch.dispatchId,
				bindingId: this.foundationExecution.binding.bindingId,
				bindingEpochIds: [...this.foundationExecution.bindingEpochIds],
				agentInstanceId: this.foundationExecution.agentInstanceId,
				runId,
			}, "intent payload"),
			correlation,
		});
	}

	private async ensureFoundationIntentForOperation(lane: string, runId: string): Promise<void> {
		await this.persistFoundationIntent(lane, runId);
		if (this.foundationExecution === undefined) return;
		const ids = this.foundationIds(runId);
		const records = await this.durableSession.findFoundationRecords({ kind: "intent", objectType: "attempt", objectId: ids.attemptId, includePruned: true, order: "oldestFirst" });
		const intent = records.find((record) => record.kind === "intent" && record.clientRequestId === `harness:intent:${runId}`);
		if (intent === undefined || intent.kind !== "intent") throw new HarnessFault(`Foundation intent is missing for operation ${runId}`, undefined);
		const payload = intent.payload;
		if (payload === undefined || asRecord(payload)?.runId !== runId) throw new HarnessFault(`Foundation intent is invalid for operation ${runId}`, undefined);
	}

	private foundationPublicError(error: OperationError | undefined, fallbackCode: string, fallbackMessage: string): NonNullable<AttemptReceiptV1["error"]> {
		return {
			code: error?.code ?? fallbackCode,
			message: error?.message ?? fallbackMessage,
			category: "unknown",
			retryable: false,
		};
	}

	private async persistFoundationReceipts(
		lane: string,
		runId: string,
		outcome: "completed" | "declined" | "failed" | "aborted",
		error?: OperationError,
	): Promise<FoundationReceiptBundle | undefined> {
		if (this.foundationExecution === undefined) return undefined;
		const prior = this.foundationReceipts.get(runId);
		if (prior !== undefined) return prior;
		const execution = this.foundationExecution;
		const ids = this.foundationIds(runId);
		const now = await this.foundationReceiptTimestamp(lane, runId);
		const terminalStatus: ResultStatusV1 = outcome === "completed" ? "succeeded" : outcome === "aborted" ? "cancelled" : "failed";
		const candidate: AttemptReceiptV1 = {
			schemaVersion: 1,
			attemptReceiptId: ids.attemptReceiptId,
			taskId: execution.task.taskId,
			dispatchId: execution.dispatch.dispatchId,
			attemptId: ids.attemptId,
			providerId: execution.providerId,
			agentInstanceId: execution.agentInstanceId,
			bindingId: execution.binding.bindingId,
			bindingEpochIds: [...execution.bindingEpochIds],
			status: terminalStatus,
			workerReceiptRefs: [],
			artifacts: [...(execution.settlement?.artifacts ?? [])],
			provenance: { producerKind: "agent_executor", providerId: execution.providerId, producedAt: now },
			sideEffectState: await this.foundationSideEffectState(lane, runId),
			...(terminalStatus === "failed" ? { error: this.foundationPublicError(error, "agent_run_failed", "Agent run failed") } : {}),
		};
		const existingAttempt = await this.durableSession.getFoundationObject("attempt_receipt", ids.attemptReceiptId);
		let attemptReceipt = candidate;
		if (existingAttempt !== undefined) {
			if (existingAttempt.kind !== "fact") throw new HarnessFault("AttemptReceipt object is not a fact", undefined);
			if (canonicalFoundationJson(existingAttempt.payload) !== canonicalFoundationJson(candidate)) throw new HarnessFault("Existing AttemptReceipt conflicts with its deterministic reconstruction", undefined);
			attemptReceipt = existingAttempt.payload as unknown as AttemptReceiptV1;
		}
		const checkedAttempt = validateAttemptReceipt(attemptReceipt, { agentProvider: true, providerClass: "agent" });
		if (!checkedAttempt.ok) throw new HarnessFault("AgentHarness produced an invalid AttemptReceipt", checkedAttempt.error);
		attemptReceipt = checkedAttempt.value;
		const attemptCorrelation = this.foundationCorrelation(lane, runId, { attemptId: ids.attemptId, attemptReceiptId: attemptReceipt.attemptReceiptId });
		if (attemptCorrelation === undefined) throw new HarnessFault("Missing execution correlation for Foundation AttemptReceipt", undefined);
		const attemptFact = await this.appendFoundationFact(lane, "attempt_receipt", attemptReceipt.attemptReceiptId, `harness:attempt_receipt:${runId}`, this.foundationJson(attemptReceipt, "AttemptReceipt"), attemptCorrelation);
		const checkedAttemptFact = validateAttemptReceipt(attemptFact.payload, { agentProvider: true, providerClass: "agent" });
		if (!checkedAttemptFact.ok) throw new HarnessFault("Persisted AttemptReceipt is invalid", checkedAttemptFact.error);
		attemptReceipt = checkedAttemptFact.value;

		const settlement = execution.settlement;
		const authority = execution.hostAuthority;
		if (settlement === undefined || authority === undefined) {
			const bundle: FoundationReceiptBundle = { attemptId: ids.attemptId, attemptReceipt, correlation: attemptFact.correlation };
			this.foundationReceipts.set(runId, bundle);
			return bundle;
		}
		const settleInput = {
			taskResultId: ids.taskResultId,
			task: execution.task,
			receipts: [attemptReceipt],
			summary: settlement?.summary ?? (outcome === "completed" ? "Agent run completed; awaiting host settlement evidence" : "Agent run did not complete successfully"),
			artifacts: settlement?.artifacts,
			diff: settlement?.diff,
			tests: settlement?.tests ?? [],
			evidence: settlement?.evidence ?? [],
			producer: { producerKind: "host" as const, providerId: authority.authorityId, producedAt: now },
		};
		let settled = settleTaskResult(settleInput);
		if (!settled.ok && outcome === "completed" && attemptReceipt.status === "succeeded") {
			attemptReceipt = {
				...attemptReceipt,
				status: "suspended",
				error: this.foundationPublicError(undefined, "awaiting_host_settlement", "Host acceptance evidence is required before task settlement"),
			};
			settled = settleTaskResult({ ...settleInput, receipts: [attemptReceipt] });
		}
		if (!settled.ok) throw new HarnessFault("AgentHarness could not settle TaskResult", settled.error);
		let taskResult = settled.value;
		if (error !== undefined && taskResult.error === undefined) {
			taskResult = { ...taskResult, error: this.foundationPublicError(error, "agent_run_failed", "Agent run failed") };
		}
		const checkedTaskResult = validateTaskResultV1(taskResult);
		if (!checkedTaskResult.ok) throw new HarnessFault("AgentHarness produced an invalid TaskResult", checkedTaskResult.error);
		const finalStatus = outcome === "completed" && taskResult.status === "succeeded" ? "completed" : outcome === "aborted" ? "cancelled" : "failed";
		const finalized = finalizeRunReceipt({
			runReceiptId: ids.runReceiptId,
			runId,
			terminalStatus: finalStatus,
			taskResult,
			attemptReceiptIds: [attemptReceipt.attemptReceiptId],
			authority,
			...(finalStatus === "completed" ? {} : { terminalErrorCode: error?.code ?? (taskResult.status === "suspended" ? "awaiting_host_settlement" : "agent_run_failed") }),
			completedAt: now,
		});
		if (!finalized.ok) throw new HarnessFault("AgentHarness produced an invalid RunReceipt", finalized.error);
		const checkedRunReceipt = validateRunReceiptV1(finalized.value);
		if (!checkedRunReceipt.ok) throw new HarnessFault("AgentHarness produced an invalid RunReceipt", checkedRunReceipt.error);
		const taskCorrelation = this.foundationCorrelation(lane, runId, { attemptId: ids.attemptId, attemptReceiptId: attemptReceipt.attemptReceiptId, taskResultId: taskResult.taskResultId });
		const runCorrelation = this.foundationCorrelation(lane, runId, { attemptId: ids.attemptId, attemptReceiptId: attemptReceipt.attemptReceiptId, taskResultId: taskResult.taskResultId, runReceiptId: finalized.value.runReceiptId });
		if (taskCorrelation === undefined || runCorrelation === undefined) throw new HarnessFault("Missing execution correlation for Foundation receipts", undefined);
		const taskFact = await this.appendFoundationFact(lane, "task_result", taskResult.taskResultId, `harness:task_result:${runId}`, this.foundationJson(taskResult, "TaskResult"), taskCorrelation);
		const checkedTaskFact = validateTaskResultV1(taskFact.payload);
		if (!checkedTaskFact.ok) throw new HarnessFault("Persisted TaskResult is invalid", checkedTaskFact.error);
		taskResult = checkedTaskFact.value;
		const runFact = await this.appendFoundationFact(lane, "run_receipt", checkedRunReceipt.value.runReceiptId, `harness:run_receipt:${runId}`, this.foundationJson(checkedRunReceipt.value, "RunReceipt"), runCorrelation);
		const checkedRunFact = validateRunReceiptV1(runFact.payload);
		if (!checkedRunFact.ok) throw new HarnessFault("Persisted RunReceipt is invalid", checkedRunFact.error);
		const bundle: FoundationReceiptBundle = { attemptId: ids.attemptId, attemptReceipt, taskResult, runReceipt: checkedRunFact.value, correlation: runFact.correlation };
		this.foundationReceipts.set(runId, bundle);
		return bundle;
	}

	private async foundationSideEffectState(lane: string, runId: string): Promise<SideEffectStateV1> {
		const starts = await this.durableSession.findRecords({ lane, runId, type: "tool_started", order: "oldestFirst" });
		if (starts.length === 0) return "none";
		for (const start of starts) {
			const result = await this.durableSession.getEntry(start.resultEntryId);
			if (result?.type !== "message" || result.message.role !== "toolResult") return "side_effect_unknown";
		}
		return "unknown";
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
				(entry.type === "custom" && data?.runId === runId);
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
		const reduction = reduceLaneState({
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

	private projectorMap(): Record<string, AsyncCustomEntryContextMessageProjector> {
		const projectors: Record<string, AsyncCustomEntryContextMessageProjector> = {};
		for (const [customType, projector] of Object.entries(this.entryProjectors)) {
			projectors[customType] = (entry) => projector(entry);
		}
		return projectors;
	}

	private async contextForOperation(lane: string): Promise<{ context: AgentContext; reduction: LaneReductionResult; model: Model<Api>; thinkingLevel: ThinkingLevel; activeToolNames: string[] }> {
		const reduction = await this.getLaneReduction(lane);
		const context = await buildSessionContextAsync(await this.getLaneEntries(lane), { entryProjectors: this.projectorMap() });
		const model = this.models.getModel(reduction.effectiveConfiguration.model.provider, reduction.effectiveConfiguration.model.modelId);
		if (!model) throw new MissingIdentities({ lane, tools: [], models: [`${reduction.effectiveConfiguration.model.provider}/${reduction.effectiveConfiguration.model.modelId}`,], message: "Configured model is unavailable" });
		const thinkingLevel = isThinkingLevel(reduction.effectiveConfiguration.thinkingLevel) ? reduction.effectiveConfiguration.thinkingLevel : this.defaultThinkingLevel;
		const activeToolNames = [...reduction.effectiveConfiguration.activeToolNames];
		return {
			context: {
				systemPrompt: await this.systemPrompt(),
				messages: context.messages,
				tools: this.tools.filter((tool) => activeToolNames.includes(tool.name)),
			},
			reduction,
			model,
			thinkingLevel,
			activeToolNames,
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
			toolExecution: this.toolExecution,
			convertToLlm: this.toProviderMessages,
			getSteeringMessages: async () => {
				if (skipInitialSteeringPoll) {
					skipInitialSteeringPoll = false;
					return [];
				}
				return this.enqueue(lane, () => this.consumeQueueMessages(lane, operationId, "steer", this.steeringMode));
			},
			getFollowUpMessages: async () => this.enqueue(lane, () => this.consumeQueueMessages(lane, operationId, "followUp", this.followUpMode)),
			transformContext: async (messages) => messages,
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

	private async startRun(lane: string, messages: AgentMessage[]): Promise<ResultValue<string, RunRejected>> {
		return this.enqueue(lane, async () => {
			try {
				this.ensureOpen();
				const invalid = this.validatePrompt(lane, messages);
				if (invalid) return Result.err<RunRejected>(invalid);
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
					...reduction.laneState.pendingNextRun,
					...messages.map((message) => ({ type: "message" as const, id: this.durableSession.idGenerator.next(), message })),
				];
				const id = this.durableSession.idGenerator.next();
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
					},
				} satisfies NewRecord<OperationStartedRecord>);
				await this.persistFoundationIntent(lane, id);
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
		if (!records.some((record) => record.target.id === target.id)) {
			await this.durableSession.appendRecord({
				type: "write_deferred",
				id: this.durableSession.idGenerator.next(),
				lane,
				runId,
				target: structuredClone(target),
			} satisfies NewRecord<WriteDeferredRecord>);
		}
	}

	private async persistOperationEntry(lane: string, runId: string, target: ProvisionedEntry): Promise<void> {
		const existing = await this.durableSession.getEntry(target.id);
		if (existing) return;
		await this.appendWriteDeferred(lane, runId, target);
		await this.durableSession.appendEntry(target, lane);
	}

	private async ensureInitialMessage(lane: string, reduction: LaneReductionResult): Promise<void> {
		const operation = reduction.laneState.operation;
		if (!operation || operation.intent.kind !== "run") return;
		const target = operation.missingInitialMessages[0];
		if (target) await this.persistOperationEntry(lane, operation.id, target);
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
			effectiveArgs: asRecord(event.args) ?? {},
			resultEntryId: this.durableSession.idGenerator.next(),
			replay: this.tools.find((tool) => tool.name === event.toolName)?.replay ?? "never",
		};
		return this.durableSession.appendRecord(target) as Promise<ToolStartedRecord>;
	}

	private async appendToolResult(lane: string, runId: string, message: ToolResultMessage): Promise<void> {
		const records = await this.durableSession.findRecords({ lane, runId, type: "tool_started", order: "oldestFirst" });
		const started = records.find((record) => record.toolCallId === message.toolCallId);
		if (!started) throw new HarnessFault(`Tool result ${message.toolCallId} has no durable start`, undefined);
		const target: ProvisionedEntry = { type: "message", id: started.resultEntryId, message: structuredClone(message) };
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
		return entry.message.content.findIndex((content) => content.type === "toolCall" && content.id === toolCallId);
	}

	private async processAgentEvent(lane: string, runId: string, event: AgentEvent, signal: AbortSignal): Promise<void> {
		switch (event.type) {
			case "turn_start": {
				const reduction = await this.getLaneReduction(lane);
				if (reduction.laneState.operation?.id === runId && reduction.laneState.operation.step === null) {
					await this.ensureStep(lane, reduction, "assistant");
				}
				break;
			}
			case "message_end":
				if (event.message.role === "assistant") await this.appendAssistantEntry(lane, runId, event.message);
				else if (event.message.role === "toolResult") await this.appendToolResult(lane, runId, event.message);
				break;
			case "tool_execution_start":
				await this.appendToolStarted(lane, runId, event);
				break;
			case "agent_end": {
				const finalMessage = [...event.messages].reverse().find((message): message is AssistantMessage => message.role === "assistant");
				if (!finalMessage || finalMessage.stopReason === "deferred") break;
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
				await this.finishOperation(
					lane,
					runId,
					outcome,
					signal.aborted
						? USER_ABORT_ERROR
						: finalMessage.stopReason === "error"
							? operationError(finalMessage.errorMessage ?? "Agent loop failed")
							: undefined,
				);
				break;
			}
		}
		await this.refreshSnapshots();
	}

	private async finishActiveOperation(runId: string): Promise<void> {
		this.activeOperations.delete(runId);
		try {
			await this.refreshSnapshots();
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
			controller,
			promise: Promise.resolve(),
		};
		let operationModel = this.defaultModel;
		const promise = (async () => {
			try {
				await this.hookRegistry.emit("before_request", { lane, runId });
				const prepared = await this.contextForOperation(lane);
				operationModel = prepared.model;
				const config = this.loopConfig(lane, runId, prepared.context, controller.signal, prepared.model, prepared.thinkingLevel);
				await runAgentLoopContinue(
					prepared.context,
					config,
					(event) => this.enqueue(lane, () => this.processAgentEvent(lane, runId, event, controller.signal)),
					controller.signal,
					(model, context, options) => this.models.streamSimple(model, context, options),
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
		const operation: ActiveOperation = { id: runId, lane, controller, promise: Promise.resolve() };
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
		const preparationResult = prepareCompaction(await this.getLaneEntries(lane), this.compactionSettings);
		if (!preparationResult.ok || preparationResult.value === undefined) {
			await this.finishOperation(lane, operation.id, "declined");
			return;
		}
		const prepared = await this.contextForOperation(lane);
		const step = await this.ensureStep(lane, reduction, "compaction", "manual");
		this.startActiveOperation(
			lane,
			operation.id,
			async (signal) => {
				const result = await generateCompaction(
					preparationResult.value!,
					this.models,
					prepared.model,
					intent.customInstructions,
					signal,
					prepared.thinkingLevel,
					this.retryPolicy,
				);
				await this.enqueue(lane, async () => {
					if (!result.ok) {
						const aborted = result.error.code === "aborted";
						await this.finishOperation(lane, operation.id, aborted && signal.aborted ? "aborted" : "failed", aborted ? (signal.aborted ? USER_ABORT_ERROR : providerAbortError(result.error.message)) : operationError(result.error));
						return;
					}
					const entry: ProvisionedEntry = {
						type: "compaction",
						id: step.resultEntryId,
						summary: result.value.summary,
						retainedTail: result.value.retainedTail,
						tokensBefore: result.value.tokensBefore,
						...(result.value.details !== undefined ? { details: result.value.details } : {}),
						...(result.value.usage ? { usage: result.value.usage } : {}),
					};
					await this.persistOperationEntry(lane, operation.id, entry);
					if (result.value.usage) await this.durableSession.appendRecord({ type: "usage", id: this.durableSession.idGenerator.next(), lane, cause: "compaction", runId: operation.id, entryId: entry.id, attempt: step.attempt, stopReason: "stop", usage: result.value.usage });
					await this.finishOperation(lane, operation.id, "completed");
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
		if (!intent.summarize) {
			await this.durableSession.moveLane(lane, intent.targetId);
			await this.finishOperation(lane, operation.id, "completed");
			return;
		}
		const step = await this.ensureStep(lane, reduction, "branch_summary");
		const sourceEntries = operation.resumeBoundary.branchId
			? await this.durableSession.findEntriesOnBranch({ start: operation.resumeBoundary.branchId, stopAtId: intent.targetId ?? undefined, order: "oldestFirst" })
			: [];
		const prepared = await this.contextForOperation(lane);
		this.startActiveOperation(
			lane,
			operation.id,
			async (signal) => {
				const result = await generateBranchSummary(sourceEntries, { models: this.models, model: prepared.model, signal, customInstructions: intent.customInstructions });
				await this.enqueue(lane, async () => {
					if (!result.ok) {
						const aborted = result.error.code === "aborted";
						await this.finishOperation(lane, operation.id, aborted && signal.aborted ? "aborted" : "failed", aborted ? (signal.aborted ? USER_ABORT_ERROR : providerAbortError(result.error.message)) : operationError(result.error));
						return;
					}
					await this.durableSession.moveLane(lane, intent.targetId);
					const summaryEntry: ProvisionedEntry = { type: "branch_summary", id: step.resultEntryId, fromId: operation.resumeBoundary.branchId ?? intent.targetId ?? "root", summary: result.value.summary, ...(result.value.usage ? { usage: result.value.usage } : {}) };
					await this.persistOperationEntry(lane, operation.id, summaryEntry);
					if (result.value.usage) await this.durableSession.appendRecord({ type: "usage", id: this.durableSession.idGenerator.next(), lane, cause: "branch_summary", runId: operation.id, entryId: summaryEntry.id, attempt: step.attempt, stopReason: "stop", usage: result.value.usage });
					await this.finishOperation(lane, operation.id, "completed");
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
		if (records.length > 0) return;
		await this.hookRegistry.emit("before_run_end", { lane, runId, outcome });
		const foundationBundle = await this.persistFoundationReceipts(lane, runId, outcome, error);
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
			outcome,
			...(correlation === undefined ? {} : { correlation }),
			...(error ? { error } : {}),
		});
		const leafId = await this.durableSession.view(lane).getLeafId();
		const finalEntry = leafId ? await this.durableSession.view(lane).findEntryOnBranch({ start: leafId, type: "message" }) : undefined;
		const checkpointId = finalEntry?.id;
		this.eventBus.emit({
			type: "run_end",
			lane,
			runId,
			outcome: outcome === "declined" ? "failed" : outcome,
			leafId: leafId ?? "",
			...(checkpointId ? { checkpointId } : {}),
		});
		await this.refreshSnapshots();
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
			if (!operation.intent.summarize && reduction.laneState.leafId !== operation.intent.targetId) return { kind: "move_lane", to: operation.intent.targetId };
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
		const leafId = await this.durableSession.view(lane).getLeafId();
		const branchMessages = leafId
			? await this.durableSession.view(lane).findEntriesOnBranch({ start: leafId, type: "message", order: "newestFirst" })
			: [];
		const finalEntry = branchMessages.find((entry) => entry.type === "message" && entry.message.role === "assistant");
		const finalMessage = finalEntry?.type === "message" && finalEntry.message.role === "assistant" ? finalEntry.message : undefined;
		if (!finish || !finalEntry || !finalMessage) {
			return Result.ok({ runId, kind: "failed", leafId: leafId ?? "", error: { code: "suspended", message: "Run is not finished" }, ...(finalEntry ? { finalEntryId: finalEntry.id } : {}) });
		}
		if (finish.outcome === "aborted") return Result.ok({ runId, kind: "aborted", leafId: leafId ?? "", finalEntryId: finalEntry.id, finalMessage });
		if (finish.outcome === "failed") return Result.ok({ runId, kind: "failed", leafId: leafId ?? "", error: finish.error ?? { code: "failed", message: finalMessage.errorMessage ?? "Run failed" }, finalEntryId: finalEntry.id, finalMessage });
		return Result.ok({ runId, kind: "completed", leafId: leafId ?? "", finalEntryId: finalEntry.id, finalMessage });
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

	private async promptImpl(lane: string, input: string | AgentMessage | AgentMessage[], images?: ImageContent[]): Promise<RunResult> {
		if (this.closed) return Result.err(new Closed({ message: "AgentHarness is closed" }));
		const started = await this.startRun(lane, this.normalizePrompt(input, images));
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
		return this.compactOnLane("main", options);
	}

	async compactOnLane(lane: string, options: { customInstructions?: string } = {}): Promise<CompactionResult> {
		return this.runWithLane(lane, () => this.compactImpl(lane, options));
	}

	private async compactImpl(lane: string, options: { customInstructions?: string } = {}): Promise<CompactionResult> {
		if (this.closed) return Result.err(new Closed({ message: "AgentHarness is closed" }));
		const started = await this.enqueue(lane, async () => {
			const reduction = await this.getLaneReduction(lane);
			if (reduction.laneState.operation) return Result.err<CompactionRejected>(new LaneBusy({ lane, operationId: reduction.laneState.operation.id, operationKind: reduction.laneState.operation.kind, message: "Lane already has an open operation" }));
			const preparation = prepareCompaction(await this.getLaneEntries(lane), this.compactionSettings);
			if (!preparation.ok || preparation.value === undefined) return Result.err<CompactionRejected>(new NothingToCompact({ lane, message: "No compactable session history" }));
			const id = this.durableSession.idGenerator.next();
			const resultEntryId = this.durableSession.idGenerator.next();
			const correlation = this.foundationCorrelation(lane, id, { runId: id });
			await this.durableSession.appendRecord({ type: "operation_started", id, lane, sourceLeafId: reduction.laneState.leafId, ...(correlation === undefined ? {} : { correlation }), intent: { kind: "compaction", ...(options.customInstructions === undefined ? {} : { customInstructions: options.customInstructions }), resultEntryId } } satisfies NewRecord<OperationStartedRecord>);
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
			await this.durableSession.appendRecord({ type: "operation_started", id, lane, sourceLeafId: reduction.laneState.leafId, ...(correlation === undefined ? {} : { correlation }), intent: { kind: "navigation", targetId, summarize: options.summarize === true, ...(options.customInstructions === undefined ? {} : { customInstructions: options.customInstructions }), ...(options.label === undefined ? {} : { label: options.label }), ...(summaryEntryId ? { summaryEntryId } : {}) } } satisfies NewRecord<OperationStartedRecord>);
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
			this.activeOperations.get(operation.id)?.controller.abort();
			await this.refreshSnapshots();
			return Result.ok({ runId: operation.id, steer, followUp });
		});
	}

	async steer(_text: string, _images?: ImageContent[]): Promise<QueueResult>;
	async steer(_message: AgentMessage): Promise<QueueResult>;
	async steer(input: string | AgentMessage, images?: ImageContent[]): Promise<QueueResult> {
		return this.steerOnLane("main", input, images);
	}

	async steerOnLane(lane: string, input: string | AgentMessage, images?: ImageContent[]): Promise<QueueResult> {
		return this.runWithLane(lane, () => this.enqueue(lane, async () => this.enqueueMessage(lane, "steer", this.normalizePrompt(input, images)[0])));
	}

	async followUp(_text: string, _images?: ImageContent[]): Promise<QueueResult>;
	async followUp(_message: AgentMessage): Promise<QueueResult>;
	async followUp(input: string | AgentMessage, images?: ImageContent[]): Promise<QueueResult> {
		return this.followUpOnLane("main", input, images);
	}

	async followUpOnLane(lane: string, input: string | AgentMessage, images?: ImageContent[]): Promise<QueueResult> {
		return this.runWithLane(lane, () => this.enqueue(lane, async () => this.enqueueMessage(lane, "followUp", this.normalizePrompt(input, images)[0])));
	}

	async nextRun(_text: string, _images?: ImageContent[]): Promise<QueueResult>;
	async nextRun(_message: AgentMessage): Promise<QueueResult>;
	async nextRun(input: string | AgentMessage, images?: ImageContent[]): Promise<QueueResult> {
		return this.nextRunOnLane("main", input, images);
	}

	async nextRunOnLane(lane: string, input: string | AgentMessage, images?: ImageContent[]): Promise<QueueResult> {
		return this.runWithLane(lane, () => this.enqueue(lane, async () => this.enqueueMessage(lane, "nextRun", this.normalizePrompt(input, images)[0])));
	}

	private async enqueueMessage(lane: string, queue: "steer" | "followUp" | "nextRun", message: AgentMessage | undefined): Promise<QueueResult> {
		if (this.closed) return Result.err(new Closed({ message: "AgentHarness is closed" }));
		if (!message) return Result.err(new InvalidMessage({ lane, reason: "empty", message: "Queued message is empty" }));
		const invalid = this.validatePrompt(lane, [message]);
		if (invalid) return Result.err(invalid);
		const reduction = await this.getLaneReduction(lane);
		const operation = reduction.laneState.operation;
		if ((queue === "steer" || queue === "followUp") && !operation) return Result.err(new NoActiveRun({ lane, message: "No active run" }));
		const target: ProvisionedEntry = { type: "message", id: this.durableSession.idGenerator.next(), message };
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
				runId: operation!.id,
				target,
			});
		}
		await this.refreshSnapshots();
		return Result.ok({ entryId: target.id });
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
			const model = this.models.getModel(
				reduction.effectiveConfiguration.model.provider,
				reduction.effectiveConfiguration.model.modelId,
			);
			if (model === undefined) {
				throw new HarnessFault(
					`Configured model is unavailable: ${reduction.effectiveConfiguration.model.provider}/${reduction.effectiveConfiguration.model.modelId}`,
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
		return this.runWithLane(lane, () => this.setModelImpl(lane, model));
	}

	private async setModelImpl(lane: string, model: Model<Api>): Promise<void> {
		this.ensureOpen();
		await this.enqueue(lane, async () => {
			await this.durableSession.appendEntry({ type: "model_change", id: this.durableSession.idGenerator.next(), provider: model.provider, modelId: model.id }, lane);
			await this.refreshSnapshots();
		});
	}

	async getThinkingLevel(): Promise<ThinkingLevel> {
		return this.getThinkingLevelOnLane("main");
	}

	async getThinkingLevelOnLane(lane: string): Promise<ThinkingLevel> {
		return this.runWithLane(lane, async () => (await this.getLaneReduction(lane)).effectiveConfiguration.thinkingLevel);
	}

	async setThinkingLevel(level: ThinkingLevel): Promise<void> {
		return this.setThinkingLevelOnLane("main", level);
	}

	async setThinkingLevelOnLane(lane: string, level: ThinkingLevel): Promise<void> {
		return this.runWithLane(lane, () => this.setThinkingLevelImpl(lane, level));
	}

	private async setThinkingLevelImpl(lane: string, level: ThinkingLevel): Promise<void> {
		this.ensureOpen();
		await this.enqueue(lane, async () => {
			await this.durableSession.appendEntry({ type: "thinking_level_change", id: this.durableSession.idGenerator.next(), thinkingLevel: level }, lane);
			await this.refreshSnapshots();
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
		await this.enqueue(lane, async () => {
			await this.durableSession.appendEntry({ type: "active_tools_change", id: this.durableSession.idGenerator.next(), activeToolNames: [...names] }, lane);
			await this.refreshSnapshots();
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
		await this.enqueue(lane, async () => {
			const selectedActiveNames = [...(activeNames ?? tools.map((tool) => tool.name))];
			this.tools = [...tools];
			await this.durableSession.appendEntry({ type: "active_tools_change", id: this.durableSession.idGenerator.next(), activeToolNames: selectedActiveNames }, lane);
			await this.persistConfiguration(lane, HARNESS_CONFIGURATION_TYPES.tools, { activeToolNames: selectedActiveNames });
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
					await this.releaseFoundationLease();
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
