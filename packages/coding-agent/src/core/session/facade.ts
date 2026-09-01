import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import {
	AgentHarness,
	InMemoryArtifactBlobStore,
	Session,
	type AgentContext,
	type Agent,
	type AgentEvent,
	type AgentMessage,
	type AgentState,
	type AgentTool,
	type HarnessCompactionHookInput,
	type HarnessCompactionHookResult,
	type HarnessCompactionResult,
	type HarnessTool,
	type HarnessContextPreparationInput,
	type HarnessModelCallBoundaryInput,
	type McpCapabilityBinding,
	type McpToolRoute,
	type Entry,
	type FoundationJsonValue,
	type ProvisionedEntry,
	type PrepareNextTurnContext,
	type QueueMode,
	type StreamFn,
	type ThinkingLevel,
	type ToolGatewayRouteCatalog,
	createCompactionSummaryMessage,
} from "@aos-agent/agent-core";
import {
	createAssistantMessageEventStream,
	isContextOverflow,
	isRecoverableLength,
	type Api,
	type AssistantMessage,
	type AssistantMessageEvent,
	type AssistantMessageEventStream,
	type ImageContent,
	type Model,
	modelsAreEqual,
	type ThinkingLevel as AiThinkingLevel,
	type Usage,
} from "@aos-agent/ai";
import { clampThinkingLevel, getSupportedThinkingLevels } from "@aos-agent/ai/compat";
import type {
	AgentSessionConfig,
	AgentSessionEvent,
	AgentSessionEventListener,
	ExtensionBindings,
	ModelCycleResult,
	PromptOptions,
	SessionStats,
} from "./agent-session.ts";
import {
	bindAgentRuntimeSchedulerComposition,
	bindAgentRuntimeToolGatewayPolicy,
	createAgentRuntimeCompositionFactory,
	materializeAgentRuntimeComposition,
	type AgentRuntimeComposition,
	type AgentRuntimeCompositionFactory,
} from "../runtime/composition-factory.ts";
import type { CapabilityBinding, CapabilityCatalogView } from "../policy/capability-registry.ts";
import { ExtensionRunner, type ContextUsage, type ReplacedSessionContext, type SessionStartEvent, type ToolDefinition, type ToolInfo } from "../extensions/index.ts";
import { emitSessionShutdownEvent } from "../extensions/runner.ts";
import { wrapRegisteredTools } from "../extensions/wrapper.ts";
import { wrapToolDefinitions } from "../tools/tool-definition-wrapper.ts";
import { ModelRegistry } from "../runtime/model-registry.ts";
import { ModelBroker, type ModelResolution, type NormalizedModelReference } from "../runtime/model-broker.ts";
import {
	persistModelAttempt,
	persistModelBinding,
	type ModelAttemptLedgerRecord,
	type ModelBindingLedgerRecord,
} from "../runtime/model-broker-ledger.ts";
import { classifyProviderFailure } from "../execution-error.ts";
import type { ModelRuntime } from "../runtime/model-runtime.ts";
import type { ResourceLoader } from "../runtime/resource-loader.ts";
import type {
	ExternalConnectorRegistry,
} from "../connector/registry.ts";
import {
	getLatestCompactionEntry,
	SessionManager,
	type BranchSummaryEntry,
	type CompactionEntry as LegacyCompactionEntry,
	type SessionEntry,
} from "./manager.ts";
import {
	type CodingAgentSessionMetadata,
	createHarnessCompatibilityWriter,
	normalizeSessionName,
	SessionManagerStorage,
} from "./manager-storage.ts";
import type { SettingsManager } from "../runtime/settings-manager.ts";
import type { BashResult } from "../runtime/bash-executor.ts";
import {
	ContextMemoryStore,
	CONTEXT_MEMORY_CUSTOM_TYPE,
	memoryToContextSourceInputs,
	type ContextMemory,
	type ContextMemoryScope,
} from "./context-memory-store.ts";
import {
	CONTEXT_SNAPSHOT_CUSTOM_TYPE,
	createContextExtensionSourceInput,
	createContextError,
	digestContextContent,
	freezeContext,
	resolveContext,
	type ContextError,
	type ContextSnapshot,
	type ContextSourceInput,
	type ContextSourceDrift,
	type ContextSourceReceipt,
} from "./context-engine.ts";
import type {
	MCPPromptListResult,
	MCPResourceListResult,
	MCPResourceTemplateListResult,
	MCPServerConfigView,
	MCPConnectionStatus,
} from "../runtime/mcp-types.ts";
import { MCPError } from "../runtime/mcp-types.ts";
import type { MCPAuthManager, MCPAuthStartOptions, MCPAuthStartResult } from "../policy/mcp-auth-manager.ts";
import type { MCPCredentialStatus } from "../policy/mcp-auth-storage.ts";
import {
	MCPContentError,
	mapMCPNormalizedBlocksToAgentContent,
	type MCPGetPromptResult,
	type MCPReadResourceResult,
} from "../runtime/mcp-content.ts";
import {
	McpAttachmentRegistry,
	MCP_ATTACHMENT_CUSTOM_TYPE,
	createMcpAttachmentContextSourceInput,
	createMcpAttachmentTombstone,
	foldMcpAttachmentEntries,
	normalizeMcpAttachmentRecord,
	serializeMcpAttachmentRecord,
	wrapMcpPromptAttachment,
	wrapMcpResourceAttachment,
	type McpAttachment,
} from "../runtime/mcp-attachment.ts";
import type {
	PolicyApprovalRequest,
	PolicyApprovalSource,
	PolicyBinding,
	PolicyReviewDecision,
	PolicyReviewEvidence,
	PolicyReviewerIdentity,
	PublicPolicySummary,
} from "../policy/execution.ts";
import type { BindingHandle } from "../binding-handles.ts";
import type { TaskCredentialService } from "../policy/task-credential-service.ts";
import type { TaskCredentialProviderAvailability } from "../policy/task-credential-provider.ts";
import type { BashOperations } from "../tools/bash.ts";
import { exportSessionToHtml } from "../export-html/index.ts";
import type { BashExecutionMessage, CustomMessage } from "../messages.ts";
import { calculateContextTokens, estimateContextTokens, shouldCompact, type CompactionPreparation as LegacyCompactionPreparation, type CompactionResult } from "../compaction/index.ts";
import { expandPromptTemplate } from "../runtime/prompt-templates.ts";
import { formatNoApiKeyFoundMessage, formatNoModelSelectedMessage } from "../runtime/auth-guidance.ts";
import { stripFrontmatter } from "../../utils/frontmatter.ts";
import {
	FoundationControlPlane,
	type SchedulerSafeStatus,
} from "../runtime/foundation-control-plane.ts";
import type { WorkerSandboxProvider } from "../worker/sandbox-provider.ts";
import { createAllTools } from "../tools/index.ts";
import { normalizeToolResultImages } from "../../utils/tool-result-images.ts";
import { buildSystemPrompt, type BuildSystemPromptOptions } from "../runtime/system-prompt.ts";
import {
	BUILTIN_CODING_AGENT_PROVIDER_ID,
	ProductPromptIngress,
	type ProductPromptDependencySnapshotContext,
} from "../runtime/prompt-ingress.ts";
import type { PromptTaskDependencyName } from "../runtime/prompt-task-adapter.ts";
import type { RuntimeSessionSurface } from "../runtime/session-surface.ts";
import type {
	SubagentComposition,
} from "../subagent/composition.ts";
import {
	createAgentSessionReadProjection,
	type AgentSessionReadProjection,
} from "./read-projection.ts";
import { acquireSessionProcessingLease } from "./processing-lease.ts";
import { DlpScanner } from "../dlp.ts";

function sandboxProviderIds(providers: AgentSessionConfig["sandboxProviders"]): string[] {
	if (providers === undefined) return [];
	if (Array.isArray(providers)) return providers.map((provider) => provider.id);
	return [...(providers as ReadonlyMap<string, { readonly id: string }>).keys()];
}

/**
 * Construction inputs for the compatibility facade. The canonical Session and
 * AgentHarness are created before this object is exposed to any entry surface.
 */
export interface CanonicalAgentSessionOptions {
	harness: AgentHarness;
	canonicalSession: Session<CodingAgentSessionMetadata>;
	canonicalStorage?: SessionManagerStorage;
	systemPrompt?: string;
	sessionStartEvent?: SessionStartEvent;
	sessionManager: SessionManager;
	settingsManager: SettingsManager;
	telemetryShutdown?: () => Promise<void>;
	cwd: string;
	agentDir?: string;
	resourceLoader: ResourceLoader;
	modelRuntime: ModelRuntime;
	modelBroker?: ModelBroker;
	modelBrokerConfigRevision?: string;
	runtimeComposition?: AgentRuntimeCompositionFactory;
	scopedModels?: Array<{ model: Model<Api>; thinkingLevel?: ThinkingLevel }>;
	customTools?: ToolDefinition[];
	extensionRunner?: ExtensionRunner;
	extensionRunnerRef?: { current?: ExtensionRunner };
	initialActiveToolNames?: string[];
	modelBrokerResolution?: ModelResolution;
	capabilityRegistry?: AgentSessionConfig["capabilityRegistry"];
	mcpTransportFactory?: AgentSessionConfig["mcpTransportFactory"];
	mcpAuthProvider?: AgentSessionConfig["mcpAuthProvider"];
	mcpAuthManagerOptions?: AgentSessionConfig["mcpAuthManagerOptions"];
	sandboxProviders?: AgentSessionConfig["sandboxProviders"];
	policyProfile?: string;
	taskCredentialProviderAvailability?: TaskCredentialProviderAvailability;
	noTools?: "all" | "builtin";
	allowedToolNames?: string[];
	excludedToolNames?: string[];
}

interface CanonicalAgentCompatibility extends Omit<Agent, "state"> {
	readonly state: AgentState;
	setCanonicalStreamFunction(stream: StreamFn): void;
}

/** @internal Legacy ledger shape whose writes still flow through AgentHarness. */
export interface AgentSessionLedgerProjection {
	getEntries(): SessionEntry[];
	getPhysicalEntries(): SessionEntry[];
	getSessionId(): string;
	getSessionFile(): string | undefined;
	appendCustomEntry(customType: string, data: unknown): string;
}

interface AgentSessionForkTarget {
	readonly session: Session<CodingAgentSessionMetadata>;
	readonly sessionFile?: string;
	readonly selectedText?: string;
}

const agentSessionForkManagers = new WeakMap<AgentSessionForkTarget, SessionManager>();

class ModelSelectionState {
	private selected?: ModelResolution;
	private lastBindingId?: string;

	setSelection(resolution: ModelResolution, _previousBindingId?: string): void {
		this.selected = resolution;
		this.lastBindingId = resolution.bindingId;
	}

	get bindingId(): string | undefined {
		return this.lastBindingId ?? this.selected?.bindingId;
	}

	get resolution(): ModelResolution | undefined {
		return this.selected;
	}
}

interface PendingModelAttempt {
	resolution: ModelResolution;
	attempt: ModelAttemptLedgerRecord;
	model: Model<Api>;
	order: number;
	reservationId?: string;
}

function modelEventHasVisibleOutput(event: AssistantMessageEvent): boolean {
	if (event.type === "toolcall_start" || event.type === "toolcall_delta" || event.type === "toolcall_end") return true;
	if (event.type === "text_delta") return event.delta.length > 0;
	if (event.type === "thinking_delta") return event.delta.length > 0;
	if (event.type === "done") {
		return event.reason === "toolUse" || event.message.content.some((part) => {
			if (part.type === "toolCall") return true;
			if (part.type === "text") return part.text.length > 0;
			return part.thinking.length > 0;
		});
	}
	return false;
}

function syntheticModelError(model: Model<Api>, errorMessage: string, aborted = false): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "" }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: aborted ? "aborted" : "error",
		errorMessage,
		timestamp: Date.now(),
	};
}

function createCanonicalOptionsFromLegacy(options: AgentSessionConfig): CanonicalAgentSessionOptions {
	const dlpScanner = new DlpScanner({
		policy: () => options.settingsManager.getExecutionPolicySettings({ policyProfile: options.policyProfile }).selectedProfile.dlp,
		credentialMaterials: () => options.modelRuntime.getDlpCredentialMaterials(),
		initialCredentialMaterials: options.dlpCredentialMaterials,
	});
	const storage = new SessionManagerStorage(options.sessionManager, { dlpScanner });
	const session = new Session(storage);
	const legacyAgent = options.agent;
	const harnessModels = typeof options.modelRuntime.getModel === "function"
		? options.modelRuntime
		: new Proxy(options.modelRuntime, {
			get(target, property, receiver) {
				if (property === "getModel") {
					return (provider: string, id: string): Model<Api> | undefined => {
						const model = legacyAgent.state.model as Model<Api>;
						return model.provider === provider && model.id === id ? model : undefined;
					};
				}
				return Reflect.get(target, property, receiver);
			},
		});
	const builtinTools = options.baseToolsOverride === undefined
		? Object.values(createAllTools(options.cwd))
		: Object.values(options.baseToolsOverride);
	const toolsByName = new Map<string, HarnessTool>();
	for (const tool of builtinTools) toolsByName.set(tool.name, tool as HarnessTool);
	for (const tool of legacyAgent.state.tools) toolsByName.set(tool.name, tool as HarnessTool);
	for (const tool of wrapToolDefinitions(options.customTools ?? [])) toolsByName.set(tool.name, tool as HarnessTool);
	const tools = [...toolsByName.values()];
	const defaultActiveToolNames = options.baseToolsOverride === undefined
		? ["read", "bash", "edit", "write"]
		: Object.keys(options.baseToolsOverride);
	const buildLegacySystemPrompt = async (): Promise<string> => {
		const activeToolNames = [...harness.activeToolNamesSnapshot];
		const toolSnippets: Record<string, string> = {};
		const promptGuidelines: string[] = [];
		for (const tool of harness.toolsSnapshot) {
			if (!activeToolNames.includes(tool.name)) continue;
			const candidate = tool as HarnessTool & { promptGuidelines?: readonly unknown[]; promptSnippet?: unknown };
			if (typeof candidate.promptSnippet === "string" && candidate.promptSnippet.trim().length > 0) {
				toolSnippets[tool.name] = candidate.promptSnippet;
			}
			if (Array.isArray(candidate.promptGuidelines)) {
				for (const guideline of candidate.promptGuidelines) {
					if (typeof guideline === "string") promptGuidelines.push(guideline);
				}
			}
		}
		const appendSystemPrompt = options.resourceLoader.getAppendSystemPrompt().join("\n\n");
		const contextEnabled = options.settingsManager.getContextSettings().enabled;
		const instructionBlocks = contextEnabled
			? []
			: options.resourceLoader.getContextSources().contextSources
				.filter((source) => source.injectable)
				.map((source) => ({
					sourceId: source.sourceId,
					path: source.path,
					content: source.content,
					scope: source.scope,
					trust: source.trust,
				}));
		return buildSystemPrompt({
			cwd: options.cwd,
			customPrompt: options.resourceLoader.getSystemPrompt(),
			...(appendSystemPrompt.length === 0 ? {} : { appendSystemPrompt }),
			selectedTools: activeToolNames,
			toolSnippets,
			promptGuidelines,
			instructionBlocks,
			skills: contextEnabled ? [] : options.resourceLoader.getSkills().skills,
		});
	};
	const harness = AgentHarness.createUnrestored({
		session,
		models: harnessModels,
		model: legacyAgent.state.model as Model<Api>,
		thinkingLevel: legacyAgent.state.thinkingLevel,
		activeToolNames: options.noTools === "all" ? [] : options.initialActiveToolNames ?? defaultActiveToolNames,
		tools,
		systemPrompt: buildLegacySystemPrompt,
		streamFunction: legacyAgent.streamFunction,
		streamFunctionOverridden: false,
		toProviderMessages: legacyAgent.convertToLlm,
		getApiKey: legacyAgent.getApiKey,
		transformContext: legacyAgent.transformContext,
		streamOptions: {
			...(legacyAgent.onPayload === undefined ? {} : { onPayload: legacyAgent.onPayload }),
			...(legacyAgent.onResponse === undefined ? {} : { onResponse: legacyAgent.onResponse }),
		},
		beforeToolCall: legacyAgent.beforeToolCall,
		afterToolCall: legacyAgent.afterToolCall,
		shouldStopAfterTurn: legacyAgent.shouldStopAfterTurn,
		prepareNextTurn: legacyAgent.prepareNextTurnWithContext ?? (legacyAgent.prepareNextTurn === undefined
			? undefined
			: async (_context: PrepareNextTurnContext, signal?: AbortSignal) => legacyAgent.prepareNextTurn?.(signal)),
		steeringMode: options.settingsManager.getSteeringMode(),
		followUpMode: options.settingsManager.getFollowUpMode(),
		retry: options.settingsManager.getRetrySettings(),
		compaction: options.settingsManager.getCompactionSettings(),
		context: options.telemetryContext,
		compatibilityWriter: createHarnessCompatibilityWriter(session, storage),
		...(options.sessionManager.isPersisted()
			? {}
			: { ledgerOptions: { artifactBlobStore: new InMemoryArtifactBlobStore() } }),
	});
	return {
		harness,
		canonicalSession: session,
		canonicalStorage: storage,
		systemPrompt: legacyAgent.state.systemPrompt,
		sessionManager: options.sessionManager,
		settingsManager: options.settingsManager,
		telemetryShutdown: options.telemetryShutdown,
		cwd: options.cwd,
		agentDir: options.agentDir,
		resourceLoader: options.resourceLoader,
		modelRuntime: options.modelRuntime,
		modelBroker: options.modelBroker,
		modelBrokerConfigRevision: options.modelBrokerConfigRevision,
		runtimeComposition: options.runtimeComposition,
		scopedModels: options.scopedModels,
		customTools: options.customTools,
		initialActiveToolNames: options.initialActiveToolNames,
		sessionStartEvent: options.sessionStartEvent,
		extensionRunnerRef: options.extensionRunnerRef,
		capabilityRegistry: options.capabilityRegistry,
		mcpTransportFactory: options.mcpTransportFactory,
		mcpAuthProvider: options.mcpAuthProvider,
		mcpAuthManagerOptions: options.mcpAuthManagerOptions,
		sandboxProviders: options.sandboxProviders,
		policyProfile: options.policyProfile,
		taskCredentialProviderAvailability: options.taskCredentialProviderAvailability,
		noTools: options.noTools,
		allowedToolNames: options.allowedToolNames,
		excludedToolNames: options.excludedToolNames,
	};
}

function resultError(value: unknown): Error | undefined {
	if (typeof value !== "object" || value === null || !("ok" in value)) return undefined;
	const top = value as { ok?: unknown; error?: unknown; value?: unknown };
	if (top.ok !== false && top.ok !== true) return undefined;
	const error = top.error;
	if (error instanceof Error) return error;
	const failedValue = typeof top.value === "object" && top.value !== null ? top.value as { kind?: unknown; error?: unknown } : undefined;
	const sourceError = failedValue?.kind === "failed" ? failedValue.error : error;
	if (sourceError === undefined) return undefined;
	const details = typeof sourceError === "object" && sourceError !== null
		? sourceError as { message?: unknown; code?: unknown; details?: unknown }
		: {};
	const result = new Error(typeof details.message === "string" ? details.message : "Agent operation failed") as Error & { code?: string; contextError?: unknown };
	if (typeof details.code === "string") result.code = details.code;
	if (details.details !== undefined) {
		result.contextError = details.details;
		if (typeof details.details === "object" && details.details !== null && "code" in details.details && typeof details.details.code === "string") {
			result.name = "ContextRuntimeError";
		}
	}
	return result;
}

function isNonThrowingAssistantFailure(value: unknown): boolean {
	if (typeof value !== "object" || value === null || !("ok" in value)) return false;
	const result = value as { ok?: unknown; value?: unknown };
	if (result.ok !== true || typeof result.value !== "object" || result.value === null) return false;
	const failed = result.value as {
		kind?: unknown;
		error?: { code?: unknown; details?: unknown };
		finalMessage?: { role?: unknown; stopReason?: unknown };
	};
	return failed.kind === "failed" && failed.error?.details === undefined && failed.finalMessage?.role === "assistant" &&
		(failed.finalMessage.stopReason === "error" || failed.finalMessage.stopReason === "aborted");
}

function messageText(message: AgentMessage): string {
	if (!("content" in message)) return "";
	if (typeof message.content === "string") return message.content;
	return message.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text")
		.map((part) => part.text)
		.join("");
}

function omitUndefined(value: unknown): unknown {
	if (Array.isArray(value)) return value.map((item) => omitUndefined(item));
	if (value !== null && typeof value === "object") {
		const result: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value)) {
			if (item !== undefined) result[key] = omitUndefined(item);
		}
		return result;
	}
	return value;
}

function agentEventToSessionEvent(event: AgentEvent): AgentSessionEvent {
	if (event.type === "agent_end") return { ...event, willRetry: false };
	return event;
}

function emptyUsage(): { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number } } {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function recordValue(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function normalizeCompatibilityMessage(message: AgentMessage): AgentMessage {
	if ("content" in message && message.content == null) {
		return { ...message, content: [] } as AgentMessage;
	}
	return message;
}

function normalizeContextUsageAfterSummary(messages: AgentMessage[]): AgentMessage[] {
	const latestSummary = [...messages]
		.reverse()
		.find((message) => message.role === "compactionSummary" || message.role === "branchSummary");
	if (latestSummary === undefined) return messages;
	return messages.map((message) => message.role === "assistant" && message.timestamp <= latestSummary.timestamp
		? { ...message, usage: emptyUsage() }
		: message);
}

function contextEngineError(contextError: ContextError): Error {
	const error = new Error(contextError.message) as Error & { contextError: typeof contextError };
	error.name = "ContextEngineError";
	error.contextError = contextError;
	return error;
}

function contextOperationError(
	code: "context_memory_disabled" | "context_memory_not_found",
	message: string,
): Error {
	return contextEngineError(createContextError(code, message, false));
}

function toLegacyCompactionPreparation(input: HarnessCompactionHookInput): LegacyCompactionPreparation {
	const preparation = input.preparation;
	const firstRetained = preparation.retainedTail[0];
	const firstKeptEntryId = firstRetained === undefined
		? ""
		: input.branchEntries.find((entry) => entry.type === "message" && JSON.stringify(entry.message) === JSON.stringify(firstRetained))?.id ?? "";
	return {
		firstKeptEntryId,
		messagesToSummarize: preparation.messagesToSummarize,
		turnPrefixMessages: preparation.turnPrefixMessages,
		isSplitTurn: preparation.isSplitTurn,
		tokensBefore: preparation.tokensBefore,
		...(preparation.previousSummary === undefined ? {} : { previousSummary: preparation.previousSummary }),
		fileOps: preparation.fileOps as unknown as LegacyCompactionPreparation["fileOps"],
		settings: preparation.settings as unknown as LegacyCompactionPreparation["settings"],
	};
}

function toLegacyCompactionResult(result: HarnessCompactionResult): CompactionResult {
	return {
		summary: result.summary,
		firstKeptEntryId: result.firstKeptEntryId,
		tokensBefore: result.tokensBefore,
		estimatedTokensAfter: result.estimatedTokensAfter,
		...(result.usage === undefined ? {} : { usage: result.usage }),
		...(result.details === undefined ? {} : { details: result.details }),
	};
}

function mcpAuditReasonCode(error: unknown): string | undefined {
	if (error instanceof MCPContentError) return error.code;
	if (error instanceof MCPError) return error.kind;
	if (error instanceof Error && "code" in error && typeof error.code === "string") return error.code;
	return undefined;
}

const extensionCommandTransitionOrigin = new AsyncLocalStorage<AgentSession>();

/**
 * Stateless compatibility surface over one canonical AgentHarness.
 *
 * The facade stores service references and performs derived reads only. It has
 * no transcript, queue, run flag, abort controller, event cursor, or loop.
 */
export class CanonicalAgentSessionServices {
	readonly sessionManager: SessionManager;
	readonly sessionLedger: AgentSessionLedgerProjection;
	readonly settingsManager: SettingsManager;
	private readonly harness: AgentHarness;
	private readonly sessionReadProjection: AgentSessionReadProjection;
	readonly canonicalSession: Session<CodingAgentSessionMetadata>;
	readonly runtimeComposition: AgentRuntimeComposition;
	private readonly storage: SessionManagerStorage;
	private readonly _resourceLoader: ResourceLoader;
	private readonly _modelRuntime: ModelRuntime;
	private readonly _modelBroker: ModelBroker;
	private readonly _modelBrokerConfigRevision: string;
	private readonly modelSelection = new ModelSelectionState();
	private readonly persistedModelBrokerBindingIds = new Set<string>();
	private readonly modelBrokerOperations = new Map<string, ModelResolution>();
	private readonly pendingModelAttempts = new Map<string, PendingModelAttempt>();
	private readonly _cwd: string;
	private readonly _systemPromptOptions: BuildSystemPromptOptions;
	private _scopedModels: Array<{ model: Model<Api>; thinkingLevel?: ThinkingLevel }>;
	private readonly _customTools: ToolDefinition[];
	private _extensionRunner: ExtensionRunner;
	private compatibilityEventEmitter: ((event: AgentEvent) => Promise<AgentEvent | undefined>) | undefined;
	private readonly controlPlane: FoundationControlPlane;
	private readonly productPromptIngress: ProductPromptIngress;
	private readonly compatibilityAgent: CanonicalAgentCompatibility;
	private readonly contextMemoryStore: ContextMemoryStore;
	private readonly mcpAttachmentRegistry: McpAttachmentRegistry;
	private _systemPrompt: string;
	private compatibilityMessagesProjection: AgentMessage[] = [];
	private _sessionStartEvent: SessionStartEvent | undefined;
	private promptSurface: RuntimeSessionSurface = "sdk";
	private compatibilityFacade: AgentSession | undefined;
	private extensionToolsReady: Promise<void> = Promise.resolve();
	private pendingActiveToolNames: string[] | undefined;
	private readonly pendingExternalMessages: AgentMessage[] = [];
	private readonly activePromptTasks = new Set<Promise<void>>();
	private admissionPaused = false;
	private promptPreflightPending = false;
	private manualCompactionPending = false;
	private disposed = false;
	private disposePromise: Promise<void> | undefined;
	private readonly sessionInfoSubscribers = new Set<AgentSessionEventListener>();
	private readonly telemetryShutdown: (() => Promise<void>) | undefined;

	constructor(options: CanonicalAgentSessionOptions);
	/** @deprecated Legacy construction is a synchronous compatibility composition root. */
	constructor(options: AgentSessionConfig);
	constructor(options: CanonicalAgentSessionOptions | AgentSessionConfig) {
		const canonical: CanonicalAgentSessionOptions = "harness" in options && "canonicalSession" in options
			? options
			: createCanonicalOptionsFromLegacy(options);
		const storage = canonical.canonicalStorage ?? new SessionManagerStorage(canonical.sessionManager);
		this.harness = canonical.harness;
		this.harness.enableProductPostToolCompaction();
		this.canonicalSession = canonical.canonicalSession;
		this.storage = storage;
		this.sessionManager = canonical.sessionManager;
		this.sessionReadProjection = createAgentSessionReadProjection(canonical.sessionManager, storage.getDlpScanner());
		this.sessionLedger = {
			getEntries: () => this.sessionRead.getEntries(),
			getPhysicalEntries: () => this.storage.getAuditEntriesSnapshot(),
			getSessionId: () => this.sessionRead.getSessionId(),
			getSessionFile: () => this.sessionRead.getSessionFile(),
			appendCustomEntry: (customType: string, data: unknown) => this.harness.recordCustomEntry(customType, data),
		};
		this.settingsManager = canonical.settingsManager;
		this.telemetryShutdown = canonical.telemetryShutdown;
		this._resourceLoader = canonical.resourceLoader;
		this._modelRuntime = canonical.modelRuntime;
		this._modelBroker = canonical.modelBroker ?? new ModelBroker();
		this._modelBrokerConfigRevision = canonical.modelBrokerConfigRevision ?? "runtime";
		this._cwd = canonical.cwd;
		this.ensureBuiltinToolDefinitions(canonical.noTools);
		this._systemPromptOptions = {
			cwd: this._cwd,
			selectedTools: [...this.harness.activeToolNamesSnapshot],
			toolSnippets: Object.fromEntries(
				this.harness.toolsSnapshot.map((tool) => [tool.name, tool.description]),
			),
		};
		this._scopedModels = [...(canonical.scopedModels ?? [])];
		this._customTools = [...(canonical.customTools ?? [])];
		this._systemPrompt = canonical.systemPrompt ?? this._resourceLoader.getSystemPrompt() ?? "";
		this._sessionStartEvent = canonical.sessionStartEvent;
		this.contextMemoryStore = new ContextMemoryStore({ agentDir: canonical.agentDir ?? this._cwd });
		this.mcpAttachmentRegistry = new McpAttachmentRegistry();
		this._extensionRunner = canonical.extensionRunner ?? new ExtensionRunner(
			canonical.resourceLoader.getExtensions().extensions,
			canonical.resourceLoader.getExtensions().runtime,
			canonical.cwd,
			this.sessionRead,
			new ModelRegistry(canonical.modelRuntime),
		);
		const runtimeCompositionFactory = canonical.runtimeComposition ?? createAgentRuntimeCompositionFactory();
		this.runtimeComposition = materializeAgentRuntimeComposition(runtimeCompositionFactory, {
			session: this.canonicalSession,
			harness: this.harness,
			sessionId: this.sessionManager.getSessionId(),
			models: this._modelRuntime,
			modelBroker: this._modelBroker,
			capabilityRegistry: canonical.capabilityRegistry,
			mcpTransportFactory: canonical.mcpTransportFactory,
			mcpAuthProvider: canonical.mcpAuthProvider,
			mcpAuthManagerOptions: canonical.mcpAuthManagerOptions,
			sandboxProviders: canonical.sandboxProviders,
		});
		this.controlPlane = new FoundationControlPlane({
			harness: this.harness,
			sessionManager: this.sessionManager,
			sessionLedger: this.sessionLedger,
			settingsManager: this.settingsManager,
			resourceLoader: this._resourceLoader,
			modelRuntime: this._modelRuntime,
			extensionRunner: this._extensionRunner,
			cwd: this._cwd,
			agentDir: canonical.agentDir ?? this._cwd,
			customTools: this._customTools,
			capabilityRegistry: this.runtimeComposition.capabilityRegistry,
			mcpTransportFactory: this.runtimeComposition.mcpTransportFactory,
			mcpAuthProvider: this.runtimeComposition.mcpAuthProvider,
			mcpAuthManagerOptions: this.runtimeComposition.mcpAuthManagerOptions,
			sandboxProviders: this.runtimeComposition.sandboxProviders,
			workerSandboxProvider: this.runtimeComposition.workerSandboxProvider,
			subagents: this.runtimeComposition.subagents,
			scheduler: bindAgentRuntimeSchedulerComposition(this.runtimeComposition, this.sessionManager),
			policyProfile: canonical.policyProfile,
			externalConnectorRegistry: this.runtimeComposition.externalConnectorRegistry,
			taskCredentialProvider: this.runtimeComposition.taskCredentialProvider,
			taskCredentialPolicyMaxTtlMs: this.runtimeComposition.taskCredentialPolicyMaxTtlMs,
			taskCredentialProviderAvailability: canonical.taskCredentialProviderAvailability,
			noTools: canonical.noTools,
			allowedToolNames: canonical.allowedToolNames,
			excludedToolNames: canonical.excludedToolNames,
			canonicalSession: this.canonicalSession,
		});
		this.storage.getDlpScanner()?.setPolicyProvider(
			() => this.settingsManager.getExecutionPolicySettings({
				policyProfile: this.controlPlane.getActiveExecutionPolicyProfile(),
				registeredProviderIds: ["legacy-host", "host-policy", ...sandboxProviderIds(this.runtimeComposition.sandboxProviders)],
			}).selectedProfile.dlp,
		);
		bindAgentRuntimeToolGatewayPolicy(this.runtimeComposition, {
			authorizeExternalToolGatewayRequest: (request, route) =>
				this.controlPlane.authorizeExternalToolGatewayRequest(request, route),
		});
		const subagents = this.controlPlane.getSubagentComposition();
		this.productPromptIngress = new ProductPromptIngress({
			session: this.canonicalSession,
			harness: this.harness,
			models: this._modelRuntime,
			cwd: this._cwd,
			currentModel: () => {
				const model = this.model;
				if (model === undefined) throw new Error(formatNoModelSelectedMessage());
				return model;
			},
			currentThinkingLevel: () => this.thinkingLevel,
			mcpSelectionSource: () => {
				const binding = this.controlPlane.getActiveCapabilityBinding();
				if (binding === undefined) throw new Error("Product Prompt MCP selection requires an active CapabilityBinding");
				const descriptors: McpCapabilityBinding["descriptors"] = binding.descriptors.map((descriptor) => {
					if (descriptor.kind === undefined || descriptor.name === undefined) {
						throw new Error("Product Prompt MCP selection requires exact CapabilityBinding descriptors");
					}
					return {
						id: descriptor.id,
						revision: descriptor.revision,
						kind: descriptor.kind,
						name: descriptor.name,
						...(descriptor.exposedToolName === undefined ? {} : { exposedToolName: descriptor.exposedToolName }),
						...(descriptor.parentId === undefined ? {} : { parentId: descriptor.parentId }),
						...(descriptor.mcpServerId === undefined ? {} : { mcpServerId: descriptor.mcpServerId }),
					};
				});
				const gateway = this.runtimeComposition.toolGateway;
				let routeCatalog: readonly McpToolRoute[] = [];
				if (gateway !== undefined) {
					const catalog = gateway as typeof gateway & Partial<ToolGatewayRouteCatalog>;
					if (typeof catalog.getRouteCatalog !== "function") {
						throw new Error("Product Prompt MCP selection requires the current Tool Gateway route catalog");
					}
					routeCatalog = catalog.getRouteCatalog();
				} else routeCatalog = this.controlPlane.getMcpToolRoutes();
				return {
					capabilityBinding: {
						id: binding.id,
						descriptors,
						toolAllowlist: binding.toolAllowlist,
					},
					routeCatalog,
				};
			},
			dependencySnapshot: (name, context) => this.productPromptDependencySnapshot(name, context),
			...(subagents === undefined ? {} : { subagents }),
		});
		if (canonical.extensionRunnerRef !== undefined) canonical.extensionRunnerRef.current = this._extensionRunner;
		this.compatibilityAgent = this.createCompatibilityAgent();
		this.bindExtensionRuntime();
		this.harness.setToolCallHooks({
			beforeToolCall: async ({ toolCall, args }) => {
				if (!this._extensionRunner.hasHandlers("tool_call")) return undefined;
				return this._extensionRunner.emitToolCall({
					type: "tool_call",
					toolCallId: toolCall.id,
					toolName: toolCall.name,
					input: recordValue(args),
				});
			},
			afterToolCall: async ({ toolCall, args, result, isError }) => {
				const hookResult = this._extensionRunner.hasHandlers("tool_result")
					? await this._extensionRunner.emitToolResult({
						type: "tool_result",
						toolCallId: toolCall.id,
						toolName: toolCall.name,
						input: recordValue(args),
						content: result.content ?? [],
						details: result.details,
						isError,
						...(result.usage === undefined ? {} : { usage: result.usage }),
					})
					: undefined;
				const content = hookResult?.content ?? result.content ?? [];
				const normalizedContent = await normalizeToolResultImages(content, {
					autoResizeImages: this.settingsManager.getImageAutoResize(),
				});
				if (hookResult === undefined && normalizedContent === content) return undefined;
				return {
					content: normalizedContent,
					details: hookResult?.details,
					isError: hookResult?.isError ?? isError,
					usage: hookResult?.usage,
				};
			},
		});
		this.harness.setStreamRequestPreparation(async ({ model, options }) => {
			if (this.harness.hasCustomStreamFunction) return { model, options };
			const resolution = await this._modelRuntime.getAuth(model, {
				...(options?.apiKey === undefined ? {} : { apiKey: options.apiKey }),
				...(options?.env === undefined ? {} : { env: options.env }),
				...(options?.signal === undefined ? {} : { signal: options.signal }),
			});
			if (resolution === undefined) return { model, options };
			const auth = resolution.auth;
			if (auth === undefined || typeof auth !== "object" || auth === null) {
				// Legacy embedded ModelRuntime shims may return { type, key } rather
				// than the current { auth, env } result. Preserve the supplied key
				// when present, but never dereference the missing auth object or infer
				// endpoint/header state from an untrusted shape.
				const legacy = resolution as unknown as { type?: unknown; key?: unknown };
				const apiKey = options?.apiKey ?? (typeof legacy.key === "string" ? legacy.key : undefined);
				return {
					model,
					options: {
						...options,
						...(apiKey === undefined ? {} : { apiKey }),
					},
				};
			}
			const requestModel = auth.baseUrl === undefined ? model : { ...model, baseUrl: auth.baseUrl };
			const apiKey = options?.apiKey ?? auth.apiKey;
			const headers = auth.headers === undefined && options?.headers === undefined
				? undefined
				: { ...auth.headers, ...options?.headers };
			const env = resolution.env === undefined && options?.env === undefined
				? undefined
				: { ...resolution.env, ...options?.env };
			return {
				model: requestModel,
				options: {
					...options,
					...(apiKey === undefined ? {} : { apiKey }),
					...(headers === undefined ? {} : { headers }),
					...(env === undefined ? {} : { env }),
				},
			};
		});
		this.harness.setCompactionHooks({
			before: async (input) => {
				if (!this._extensionRunner.hasHandlers("session_before_compact")) return undefined;
				const result = await this._extensionRunner.emit({
					type: "session_before_compact",
					preparation: toLegacyCompactionPreparation(input),
					branchEntries: this.sessionManager.getBranch(),
					...(input.customInstructions === undefined ? {} : { customInstructions: input.customInstructions }),
					reason: input.reason,
					willRetry: input.willRetry,
					signal: input.signal,
				});
				return result as unknown as HarnessCompactionHookResult | undefined;
			},
			after: async ({ entry, result, reason, willRetry }) => {
				if (!this._extensionRunner.hasHandlers("session_compact")) return;
				const legacyEntry = this.sessionManager.getEntries().find(
					(candidate): candidate is LegacyCompactionEntry => candidate.type === "compaction" && candidate.id === entry.id,
				);
				if (legacyEntry === undefined) return;
				await this._extensionRunner.emit({
					type: "session_compact",
					compactionEntry: legacyEntry,
					fromExtension: result.fromExtension,
					reason,
					willRetry,
				});
			},
			failed: async (event) => {
				if (!this._extensionRunner.hasHandlers("session_compact_failed")) return;
				await this._extensionRunner.emit({ type: "session_compact_failed", ...event });
			},
		});
		this.harness.setNavigationHooks({
			before: async (input) => {
				if (!this._extensionRunner.hasHandlers("session_before_tree")) return undefined;
				const entriesToSummarize = input.preparation.entriesToSummarize
					.map((entry) => this.sessionManager.getEntries().find((candidate) => candidate.id === entry.id))
					.filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);
				const result = await this._extensionRunner.emit({
					type: "session_before_tree",
					preparation: {
						targetId: input.preparation.targetId ?? "",
						oldLeafId: input.preparation.oldLeafId,
						commonAncestorId: input.preparation.commonAncestorId,
						entriesToSummarize,
						userWantsSummary: input.preparation.userWantsSummary,
						...(input.preparation.customInstructions === undefined ? {} : { customInstructions: input.preparation.customInstructions }),
						...(input.preparation.replaceInstructions === undefined ? {} : { replaceInstructions: input.preparation.replaceInstructions }),
						...(input.preparation.label === undefined ? {} : { label: input.preparation.label }),
					},
					signal: input.signal,
				});
				return result;
			},
			after: async ({ oldLeafId, summaryEntry, fromExtension }) => {
				if (!this._extensionRunner.hasHandlers("session_tree")) return;
				const legacySummary = summaryEntry === undefined
					? undefined
					: this.sessionManager.getEntries().find((candidate) => candidate.id === summaryEntry.id);
				await this._extensionRunner.emit({
					type: "session_tree",
					newLeafId: this.sessionManager.getLeafId(),
					oldLeafId,
					...(legacySummary?.type === "branch_summary" ? { summaryEntry: legacySummary } : {}),
					...(fromExtension === undefined ? {} : { fromExtension }),
				});
			},
		});
		this.harness.setContextPreparation((input) => this.prepareHarnessContext(input));
		this.harness.setModelContextPreparationStart((input) => this.beginModelBrokerAttempt(input));
		this.harness.setModelCallBoundary((input) => this.streamWithModelBroker(input));
		this.harness.setContextSnapshotIdForOperation((operationId, purpose) => {
			const snapshots = this.sessionManager.getContextSnapshots().filter((snapshot) => snapshot.purpose === purpose);
			return snapshots.filter((snapshot) => snapshot.runId === operationId).at(-1)?.id;
		});
		if (canonical.modelBrokerResolution !== undefined) {
			this.setModelBrokerResolution(canonical.modelBrokerResolution);
		}
		this.harness.setEntryProjectors({
			[MCP_ATTACHMENT_CUSTOM_TYPE]: (entry) => {
				if (entry.type !== "custom") return [];
				const record = normalizeMcpAttachmentRecord(entry.data);
				if (record.kind === "remove") return [];
				const attachment = this.mcpAttachmentRegistry.get(record.attachment.id);
				if (attachment === undefined) return [];
				return [{
					role: "user",
					content: mapMCPNormalizedBlocksToAgentContent(attachment.attachableBlocks),
					timestamp: Date.parse(attachment.createdAt),
				}];
			},
		});
		this.compatibilityMessagesProjection = this.projectCompatibilityMessages(this.canonicalEntriesSnapshot());
	}

	/** @internal Bind the public facade so consumer overrides remain observable. */
	bindCompatibilityFacade(facade: AgentSession): void {
		this.compatibilityFacade = facade;
	}

	private async prepareHarnessContext(input: HarnessContextPreparationInput): Promise<AgentContext> {
		const contextSettings = this.settingsManager.getContextSettings();
		if (!contextSettings.enabled) {
			const legacyInstructions = this._resourceLoader
				.getContextSources()
				.contextSources
				.filter((source) => source.injectable)
				.map((source) => `<project_instructions path="${source.path ?? source.sourceId}">\n${source.content}\n</project_instructions>`);
			return {
				...input.context,
				systemPrompt: [input.context.systemPrompt, ...legacyInstructions].filter((part) => part.length > 0).join("\n\n"),
			};
		}

		if (this._extensionRunner.hasHandlers("before_provider_request")) {
			throw contextEngineError(createContextError(
				"context_extension_source_missing",
				"before_provider_request is unavailable while Context Engine is enabled because provider payload rewrites cannot be verified against the Context snapshot",
				false,
			));
		}
		const contextMessages = normalizeContextUsageAfterSummary(input.context.messages);

		const extraSources: ContextSourceInput[] = [];
		if (input.purpose === "agent_turn" && this._extensionRunner.hasHandlers("before_agent_start")) {
			const lastMessage = input.context.messages.at(-1);
			const prompt = lastMessage?.role === "user" ? messageText(lastMessage) : "";
			const images = lastMessage?.role === "user" && Array.isArray(lastMessage.content)
				? lastMessage.content.filter((part): part is ImageContent => part.type === "image")
				: undefined;
			const combined = await this._extensionRunner.emitBeforeAgentStart(prompt, images, input.context.systemPrompt, { cwd: this._cwd });
			if (combined?.contributionError !== undefined || combined?.unattributedMutation === true) {
				throw contextEngineError(createContextError(
					"context_extension_source_missing",
					combined?.contributionError?.message ?? "Context extensions must use a typed contribution while Context Engine is enabled",
					false,
				));
			}
			for (const attribution of combined?.contributions ?? []) {
				try {
					extraSources.push(createContextExtensionSourceInput(attribution.contribution));
				} catch {
					throw contextEngineError(createContextError(
						"context_extension_source_missing",
						`Invalid Context extension contribution: ${attribution.contribution.sourceId}`,
						false,
					));
				}
			}
		}

		const sources: ContextSourceInput[] = [{
			sourceId: input.purpose === "agent_turn" ? "system:runtime" : `system:${input.purpose}:runtime`,
			kind: "system",
			scope: "global",
			trust: "builtin",
			content: input.context.systemPrompt,
			required: true,
		}];
		if (input.purpose === "agent_turn") {
			const subagents = this.controlPlane.getSubagentComposition();
			if (subagents !== undefined) {
				const childContext = await subagents.consumeParentNextTurnForRun(input.operationId);
				if (!childContext.ok) {
					throw contextEngineError(createContextError(
						"context_source_unavailable",
						"Child Agent next-turn Context projection failed closed",
						false,
					));
				}
				if (childContext.value.contextText.length > 0) {
					sources.push({
						sourceId: `subagent:next-turn:${input.operationId}`,
						kind: "session_message",
						scope: "turn",
						trust: "untrusted_child_output",
						content: childContext.value.contextText,
						required: true,
						placement: "message",
						message: { role: "user", content: childContext.value.contextText, timestamp: Date.now() },
					});
				}
			}
		}
		for (const source of this._resourceLoader.toContextSourceInputs()) {
			if (source.kind !== "system") sources.push(source);
		}

		const sessionEntries = this.sessionManager
			.getEntries()
			.filter((entry) => entry.type === "custom")
			.map((entry) => ({ customType: entry.customType, data: entry.data }));
		const memorySettings = this.settingsManager.getMemorySettings();
		if (memorySettings.sessionEnabled) {
			const memories = await this.contextMemoryStore.list({
				scope: "session",
				sessionId: this.sessionManager.getSessionId(),
				projectRoot: this._cwd,
				sessionCustomEntries: sessionEntries,
			});
			sources.push(...memoryToContextSourceInputs(memories, { enabled: true }));
		}
		if (memorySettings.projectEnabled) {
			const memories = await this.contextMemoryStore.list({
				scope: "project",
				projectRoot: this._cwd,
				sessionId: this.sessionManager.getSessionId(),
				sessionCustomEntries: sessionEntries,
			});
			sources.push(...memoryToContextSourceInputs(memories, { enabled: true }));
		}

		const attachments = this.mcpAttachmentRegistry.list();
		for (const attachment of attachments) {
			const source = createMcpAttachmentContextSourceInput(attachment);
			sources.push({ ...source, alreadyIncludedInMessages: input.purpose === "agent_turn" });
		}

		const capabilityMetadata = this.controlPlane.getCapabilityContextMetadata();
		const toolsByName = new Map((input.context.tools ?? []).map((tool) => [tool.name, tool]));
		for (const tool of capabilityMetadata.tools) {
			const toolValue = toolsByName.get(tool.name);
			const serialized = JSON.stringify(toolValue ?? { name: tool.name, id: tool.id, revision: tool.revision });
			sources.push({
				sourceId: `capability:tool:${tool.name}`,
				kind: "capability_index",
				scope: "turn",
				trust: "builtin",
				content: serialized ?? `${tool.name}:${tool.revision}`,
				required: true,
				capabilityId: tool.id,
				capabilityRevision: tool.revision,
				...(capabilityMetadata.bindingId === undefined ? {} : { capabilityBindingId: capabilityMetadata.bindingId }),
			});
		}

		for (const [index, message] of contextMessages.entries()) {
			const serialized = JSON.stringify(message);
			const kind = message.role === "branchSummary" || message.role === "compactionSummary" ? "session_summary" : "session_message";
			sources.push({
				sourceId: `session:${kind}:${index}`,
				kind,
				scope: "session",
				trust: "builtin",
				content: serialized ?? "",
				required: true,
				placement: "message",
				message,
				alreadyIncludedInMessages: true,
			});
		}
		sources.push(...extraSources);

		const reserveTokens = Math.min(contextSettings.reserveTokens, Math.floor(input.model.contextWindow / 2));
		const resolved = resolveContext({
			purpose: input.purpose,
			sessionId: this.sessionManager.getSessionId(),
			runId: input.operationId,
			contextWindow: input.model.contextWindow,
			reserveTokens,
			sources,
			sessionMessages: contextMessages,
			turnMessages: [],
		});
		if (!resolved.ok) throw contextEngineError(resolved.error);
		const snapshot = freezeContext(resolved.plan, {
			id: randomUUID(),
			createdAt: new Date().toISOString(),
			...(this.sessionManager.getContextSnapshots().at(-1)?.id === undefined
				? {}
				: { parentSnapshotId: this.sessionManager.getContextSnapshots().at(-1)?.id }),
		});
		this.harness.recordCustomEntry(CONTEXT_SNAPSHOT_CUSTOM_TYPE, snapshot);
		return {
			...input.context,
			systemPrompt: resolved.plan.systemPrompt,
			messages: resolved.plan.messages,
		};
	}

	private resolveModelBrokerOperation(operationId: string, model: Model<Api>): ModelResolution {
		const existing = this.modelBrokerOperations.get(operationId);
		if (existing !== undefined) return existing;
		const selected = this.modelSelection.resolution;
		const resolution = selected !== undefined && selected.reference.provider === model.provider && selected.reference.id === model.id
			? selected
			: this._modelBroker.hasDefaultSelection()
				? this._modelBroker.resolve({})
				: this._modelBroker.resolve({
					direct: {
						provider: model.provider,
						id: model.id,
						thinkingLevel: this.thinkingLevel,
					},
				});
		this._modelBroker.beginBindingOperation(resolution.binding.id);
		this.modelBrokerOperations.set(operationId, resolution);
		this.modelSelection.setSelection(resolution);
		this.controlPlane.setModelBrokerBindingId(resolution.binding.id);
		this.persistModelBrokerBinding(resolution);
		return resolution;
	}

	private persistModelBrokerBinding(resolution: ModelResolution): void {
		const binding = resolution.binding;
		if (this.persistedModelBrokerBindingIds.has(binding.id)) return;
		const ledgerBinding: ModelBindingLedgerRecord = {
			bindingId: binding.id,
			mode: resolution.source === "role" ? "route" : resolution.source,
			...(resolution.routeId === undefined ? {} : { routeId: resolution.routeId }),
			...(resolution.role === undefined ? {} : { role: resolution.role }),
			candidates: resolution.candidatesConsidered.map((candidate, order) => ({
				order,
				model: {
					provider: candidate.provider,
					modelId: candidate.id,
					...(candidate.thinkingLevel === undefined ? {} : { thinkingLevel: candidate.thinkingLevel as ThinkingLevel }),
				},
			})),
			fallback: binding.fallback ?? { maxAttempts: 1, on: [] },
			budget: {
				...(binding.budget?.maxModelCalls === undefined ? {} : { maxModelCalls: binding.budget.maxModelCalls }),
				...(binding.budget?.maxInputTokens === undefined ? {} : { maxInputTokens: binding.budget.maxInputTokens }),
				...(binding.budget?.maxOutputTokens === undefined ? {} : { maxOutputTokens: binding.budget.maxOutputTokens }),
				...(binding.budget?.maxTotalTokens === undefined ? {} : { maxTotalTokens: binding.budget.maxTotalTokens }),
				...(binding.budget?.maxCost === undefined ? {} : { maxCostUsd: binding.budget.maxCost }),
				...(binding.budget?.maxCostUsd === undefined ? {} : { maxCostUsd: binding.budget.maxCostUsd }),
			},
			configRevision: binding.configRevision ?? this._modelBrokerConfigRevision,
			createdAt: binding.createdAt,
		};
		try {
			persistModelBinding(this.sessionLedger, ledgerBinding);
		} catch {
			// Ledger serialization must not replace the provider result.
		}
		this.persistedModelBrokerBindingIds.add(binding.id);
	}

	private createStartedModelAttempt(
		resolution: ModelResolution,
		order: number,
		model: Model<Api>,
	): PendingModelAttempt {
		const reference = resolution.candidatesConsidered[order] ?? resolution.reference;
		const attempt: ModelAttemptLedgerRecord = {
			attemptId: `model-attempt:${randomUUID()}`,
			bindingId: resolution.binding.id,
			candidate: {
				provider: reference.provider,
				modelId: reference.id,
				...(reference.thinkingLevel === undefined ? {} : { thinkingLevel: reference.thinkingLevel as ThinkingLevel }),
			},
			order,
			status: "started",
			startedAt: new Date().toISOString(),
		};
		let reservationId: string | undefined;
		if (this._modelBroker.hasBudgetForBinding(resolution.binding.id)) {
			const preflight = this._modelBroker.preflightBudgetForBinding(resolution.binding.id, {
				bindingId: resolution.binding.id,
			});
			if (!preflight.ok) {
				this.persistModelBrokerAttempt({
					...attempt,
					status: "failed",
					endedAt: new Date().toISOString(),
					failureCategory: preflight.error.code,
				});
				throw new Error("Model budget exceeded.");
			}
			reservationId = preflight.preflight.reservation.id;
		}
		this.persistModelBrokerAttempt(attempt);
		return {
			resolution,
			attempt,
			model,
			order,
			...(reservationId === undefined ? {} : { reservationId }),
		};
	}

	private persistModelBrokerAttempt(attempt: ModelAttemptLedgerRecord): void {
		try {
			persistModelAttempt(this.sessionLedger, attempt);
		} catch {
			// Ledger serialization must not replace the provider result.
		}
	}

	private async beginModelBrokerAttempt(input: HarnessContextPreparationInput): Promise<void> {
		const resolution = this.resolveModelBrokerOperation(input.operationId, input.model);
		const reference = resolution.reference;
		const order = Math.max(0, resolution.candidatesConsidered.findIndex(
			(candidate) => candidate.provider === reference.provider && candidate.id === reference.id,
		));
		const selectedModel = typeof this._modelRuntime.getModel === "function"
			? this._modelRuntime.getModel(reference.provider, reference.id) ?? input.model
			: input.model;
		this.pendingModelAttempts.set(
			input.operationId,
			this.createStartedModelAttempt(resolution, order, selectedModel),
		);
	}

	private modelAttemptSnapshotId(runId: string): string | undefined {
		return this.sessionManager
			.getContextSnapshots()
			.filter((snapshot) => snapshot.purpose === "agent_turn" && snapshot.runId === runId)
			.at(-1)?.id;
	}

	private modelForReference(reference: NormalizedModelReference): Model<Api> | undefined {
		return typeof this._modelRuntime.getModel === "function"
			? this._modelRuntime.getModel(reference.provider, reference.id)
			: undefined;
	}

	private streamWithModelBroker(input: HarnessModelCallBoundaryInput): AssistantMessageEventStream {
		const initial = this.pendingModelAttempts.get(input.runId);
		this.pendingModelAttempts.delete(input.runId);
		if (initial === undefined) {
			const stream = createAssistantMessageEventStream();
			void input.invoke(input.model, input.context, input.options).then(async (source) => {
				for await (const event of source) stream.push(event);
				stream.end();
			}).catch((error: unknown) => {
				stream.push({ type: "error", reason: "error", error: syntheticModelError(input.model, error instanceof Error ? error.message : String(error)) });
				stream.end();
			});
			return stream;
		}

		const output = createAssistantMessageEventStream();
		void this.runModelBrokerStream(input, initial, output);
		return output;
	}

	private async runModelBrokerStream(
		input: HarnessModelCallBoundaryInput,
		initial: PendingModelAttempt,
		output: AssistantMessageEventStream,
	): Promise<void> {
		let current = initial;
		let context = input.context;
		let attempts = 0;
		try {
			while (true) {
				attempts += 1;
				const snapshotId = this.modelAttemptSnapshotId(input.runId);
				let visibleOutput = false;
				let terminalError: AssistantMessage | undefined;
				const attemptThinkingLevel = current.resolution.candidatesConsidered[current.order]?.thinkingLevel;
				const options = attemptThinkingLevel === undefined || attemptThinkingLevel === "off"
					? input.options
					: { ...input.options, reasoning: attemptThinkingLevel as AiThinkingLevel };
				const source = await input.invoke(current.model, context, options);
				for await (const event of source) {
					if (modelEventHasVisibleOutput(event)) visibleOutput = true;
					if (event.type === "error") {
						terminalError = event.error;
						break;
					}
					if (event.type === "done") {
						const usage = {
							input: event.message.usage.input,
							output: event.message.usage.output,
							total: event.message.usage.totalTokens,
							cost: event.message.usage.cost.total,
						};
						const settlement = current.reservationId === undefined
							? undefined
							: this._modelBroker.settleBudgetForBinding(current.resolution.binding.id, current.reservationId, usage);
						const budgetExceeded = settlement?.ok === false && settlement.error.code === "model_budget_exceeded";
						this.persistModelBrokerAttempt({
							...current.attempt,
							status: "completed",
							endedAt: new Date().toISOString(),
							visibleOutput,
							...(snapshotId === undefined ? {} : { contextSnapshotId: snapshotId }),
							usage,
							...(budgetExceeded ? { summary: "Model budget exceeded; subsequent calls are blocked." } : {}),
						});
						if (budgetExceeded) {
							const error = syntheticModelError(current.model, "The operation outcome is unknown after a possible side effect.");
							output.push({ type: "error", reason: "error", error });
							output.end();
						} else {
							output.push(event);
							output.end();
						}
						return;
					}
					output.push(event);
				}

				if (terminalError === undefined) {
					terminalError = syntheticModelError(current.model, "The model request failed.");
				}
				const failure = classifyProviderFailure(terminalError, { visibleOutput });
				const settlement = current.reservationId === undefined
					? undefined
					: this._modelBroker.settleBudgetForBinding(current.resolution.binding.id, current.reservationId, {
						input: terminalError.usage.input,
						output: terminalError.usage.output,
						total: terminalError.usage.totalTokens,
						cost: terminalError.usage.cost.total,
					});
				const budgetBlocked = settlement?.ok === false;
				const nextOrder = current.resolution.candidatesConsidered.findIndex((candidate, index) =>
					index > current.order && (candidate.provider !== current.model.provider || candidate.id !== current.model.id));
				const fallbackEligible = !visibleOutput
					&& !budgetBlocked
					&& current.resolution.binding.fallbackAllowed
					&& failure.fallbackReason !== undefined
					&& current.resolution.binding.fallback?.on.includes(failure.fallbackReason) === true
					&& this._modelBroker.classifyFallback({
						category: failure.category,
						sideEffectStatus: failure.sideEffectStatus,
					}).eligible;
				const fallbackAllowed = fallbackEligible
					&& attempts < (current.resolution.binding.fallback?.maxAttempts ?? 1)
					&& nextOrder >= 0;
				this.persistModelBrokerAttempt({
					...current.attempt,
					status: "failed",
					endedAt: new Date().toISOString(),
					failureCategory: budgetBlocked ? "model_budget_exceeded" : (failure.fallbackReason ?? failure.category),
					visibleOutput,
					...(snapshotId === undefined ? {} : { contextSnapshotId: snapshotId }),
				});
				if (!fallbackAllowed) {
					const error = budgetBlocked
						? syntheticModelError(current.model, "Model budget exceeded.")
						: terminalError;
					output.push({ type: "error", reason: error.stopReason === "aborted" ? "aborted" : "error", error });
					output.end();
					return;
				}
				const nextReference = current.resolution.candidatesConsidered[nextOrder];
				const nextModel = nextReference === undefined ? undefined : this.modelForReference(nextReference);
				if (nextModel === undefined) {
					const error = syntheticModelError(current.model, "Model fallback exhausted.");
					output.push({ type: "error", reason: "error", error });
					output.end();
					return;
				}
				current = this.createStartedModelAttempt(current.resolution, nextOrder, nextModel);
				context = await input.prepareContext(nextModel);
			}
		} catch (error) {
			const message = syntheticModelError(current.model, error instanceof Error ? error.message : String(error), input.options?.signal?.aborted === true);
			output.push({ type: "error", reason: message.stopReason === "aborted" ? "aborted" : "error", error: message });
			output.end();
		}
	}

	private bindExtensionRuntime(): void {
		const runner = this._extensionRunner;
		runner.bindCore(
			{
				sendMessage: (message, options) => {
					const task = this.trackPromptTask(this.sendCustomMessage(message, options));
					this.harness.trackCompatibilityTask(task);
					void task.catch((error: unknown) => {
						runner.emitError({
							extensionPath: "<runtime>",
							event: "send_message",
							error: error instanceof Error ? error.message : String(error),
						});
					});
				},
				sendUserMessage: (content, options) => {
					const task = this.sendUserMessage(content, options);
					this.harness.trackCompatibilityTask(task);
					return task.catch((error: unknown) => {
						runner.emitError({
							extensionPath: "<runtime>",
							event: "send_user_message",
							error: error instanceof Error ? error.message : String(error),
						});
						throw error;
					});
				},
				appendEntry: (customType, data) => {
					const task = this.harness.appendCustomEntry(customType, data);
					this.harness.trackCompatibilityTask(task);
				},
				setSessionName: (name) => this.setSessionName(name),
				getSessionName: () => this.sessionName,
				setLabel: (entryId, label) => {
					this.harness.setSessionLabelSync(entryId, label);
				},
				getActiveTools: () => this.getActiveToolNames(),
				getAllTools: () => this.getAllTools(),
				setActiveTools: (toolNames) => this.setActiveToolsByName(toolNames),
				refreshTools: () => {
					this.extensionToolsReady = this.installExtensionTools();
				},
				getCommands: () => this._extensionRunner.getRegisteredCommands().map((command) => ({
					name: command.invocationName,
					description: command.description,
					source: "extension" as const,
					sourceInfo: command.sourceInfo,
				})),
				setModel: async (model) => {
					if (!this._modelRuntime.hasConfiguredAuth(model.provider)) return false;
					await this.setModel(model);
					return true;
				},
				getThinkingLevel: () => this.thinkingLevel,
				setThinkingLevel: (level) => this.setThinkingLevel(level),
				exec: (command, args, options) => this.controlPlane.executeCommand(command, args, options),
			},
			{
				getModel: () => this.model,
				getScopedModels: () => this._scopedModels.map((item) => ({ model: item.model, thinkingLevel: item.thinkingLevel })),
				isIdle: () => this.isIdle,
				isProjectTrusted: () => true,
				getSignal: () => this.harness.currentSignal,
				abort: () => {
					void this.abort();
				},
				hasPendingMessages: () => this.pendingMessageCount > 0,
				shutdown: () => {},
				getContextUsage: () => this.getContextUsage(),
				compact: (options) => {
					void this.compact(options?.customInstructions).then(options?.onComplete).catch(options?.onError);
				},
				getSystemPrompt: () => this.systemPrompt,
				getSystemPromptOptions: () => this._systemPromptOptions,
			},
			{
				registerProvider: (name, config) => {
					this._modelRuntime.registerProvider(name, config);
					this.refreshCurrentModelFromRegistry();
				},
				registerNativeProvider: (provider) => {
					this._modelRuntime.registerNativeProvider(provider);
					this.refreshCurrentModelFromRegistry();
				},
				unregisterProvider: (name) => {
					this._modelRuntime.unregisterProvider(name);
					this.refreshCurrentModelFromRegistry();
				},
			},
		);
		this.harness.events.on("retry_scheduled", () => {
			// The legacy extension contract observes every failed attempt as an
			// agent_end. The public session event is emitted separately below with
			// willRetry=true; keep the extension projection on the same Harness
			// event boundary so it cannot outlive the retry lifecycle.
			void runner.emit({ type: "agent_end", messages: [] });
		});
		this.harness.events.on("agent_settled", () => {
			this.flushPendingExternalMessages();
			void runner.emit({ type: "agent_settled" });
		});
		this.harness.setEventTransform(async (event) => (await this.emitEventThroughCompatibilityHook(event)) ?? event);
		this.extensionToolsReady = this.installExtensionTools();
	}

	private ensureBuiltinToolDefinitions(noTools: "all" | "builtin" | undefined): void {
		if (noTools !== "builtin") return;
		const existingTools = new Map(this.harness.toolsSnapshot.map((tool) => [tool.name, tool]));
		const missingTools = Object.values(createAllTools(this._cwd)).filter((tool) => !existingTools.has(tool.name));
		if (missingTools.length === 0) return;
		void this.harness.setTools(
			[...existingTools.values(), ...missingTools],
			[...this.harness.activeToolNamesSnapshot],
		);
	}

	private async _emitExtensionEvent(event: AgentEvent): Promise<AgentEvent | undefined> {
		const currentRunner = this._extensionRunner;
		if (event.type === "message_start" && currentRunner.hasHandlers("message_start")) {
			await currentRunner.emit({ type: "message_start", message: event.message });
		}
		if (event.type === "message_end") {
			const replacement = await currentRunner.emitMessageEnd({ type: "message_end", message: event.message });
			return replacement === undefined ? event : { ...event, message: normalizeCompatibilityMessage(replacement) };
		}
		if (event.type === "tool_execution_start" && currentRunner.hasHandlers("tool_execution_start")) {
			await currentRunner.emit({
				type: "tool_execution_start",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: recordValue(event.args),
			});
		}
		if (event.type === "tool_execution_update" && currentRunner.hasHandlers("tool_execution_update")) {
			await currentRunner.emit({
				type: "tool_execution_update",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: recordValue(event.args),
				partialResult: event.partialResult,
			});
		}
		if (event.type === "tool_execution_end" && currentRunner.hasHandlers("tool_execution_end")) {
			await currentRunner.emit({
				type: "tool_execution_end",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				result: event.result,
				isError: event.isError,
			});
		}
		if (event.type === "agent_start" && currentRunner.hasHandlers("agent_start")) await currentRunner.emit({ type: "agent_start" });
		if (event.type === "agent_end" && currentRunner.hasHandlers("agent_end")) await currentRunner.emit({ type: "agent_end", messages: event.messages });
		return event;
	}

	private async emitEventThroughCompatibilityHook(event: AgentEvent): Promise<AgentEvent | undefined> {
		return this.compatibilityEventEmitter === undefined
			? this._emitExtensionEvent(event)
			: this.compatibilityEventEmitter(event);
	}

	setCompatibilityExtensionRunner(runner: ExtensionRunner): void {
		this._extensionRunner = runner;
	}

	getCompatibilityExtensionRunner(): ExtensionRunner {
		return this._extensionRunner;
	}

	setCompatibilityEventEmitter(handler: (event: AgentEvent) => Promise<AgentEvent | undefined>): void {
		this.compatibilityEventEmitter = handler;
	}

	getCompatibilityEventEmitter(): (event: AgentEvent) => Promise<AgentEvent | undefined> {
		return this._emitExtensionEvent.bind(this);
	}

	private refreshCurrentModelFromRegistry(): void {
		const current = this.model;
		if (current === undefined) return;
		const refreshed = this._modelRuntime.getModel(current.provider, current.id);
		if (refreshed !== undefined) void this.harness.setModel(refreshed);
	}

	private async installExtensionTools(): Promise<void> {
		if (this.disposed) return;
		const extensionTools = wrapRegisteredTools(this._extensionRunner.getAllRegisteredTools(), this._extensionRunner);
		if (extensionTools.length === 0) return;
		const existingNames = new Set(this.harness.toolsSnapshot.map((tool) => tool.name));
		const newTools = extensionTools.filter((tool) => !existingNames.has(tool.name));
		if (newTools.length === 0) return;
		if (this.disposed) return;
		try {
			await this.harness.setTools(
				[...this.harness.toolsSnapshot, ...newTools],
				[...new Set([...this.harness.activeToolNamesSnapshot, ...newTools.map((tool) => tool.name)])],
			);
		} catch (error) {
			if (!this.disposed) throw error;
		}
	}

	/** Complete extension tool registration before an entry surface accepts input. */
	async initializeExtensions(): Promise<void> {
		await this.restoreMcpAttachments();
		await this.extensionToolsReady;
		this.extensionToolsReady = this.installExtensionTools();
		await this.extensionToolsReady;
		this.controlPlane.synchronizeTools();
		this._systemPrompt = await this.harness.getSystemPrompt();
		await this.refreshCompatibilityMessages();
	}

	/**
	 * Rebuild the in-memory MCP attachment projection from the canonical
	 * append-only ledger. Every selected record is validated by the fold; an
	 * unknown schema, kind, or malformed payload therefore aborts initialization
	 * instead of silently dropping durable state.
	 */
	private async restoreMcpAttachments(): Promise<void> {
		const entries = await this.harness.findEntries({
			type: "custom",
			customType: MCP_ATTACHMENT_CUSTOM_TYPE,
			order: "oldestFirst",
		});
		const folded = foldMcpAttachmentEntries(entries);
		this.mcpAttachmentRegistry.clear();
		for (const attachment of folded.attachments) this.mcpAttachmentRegistry.attach(attachment);
	}

	private createCompatibilityAgent(): CanonicalAgentCompatibility {
		const facade = this;
		const state: AgentState = {
			get systemPrompt() {
				return facade.systemPrompt;
			},
			set systemPrompt(_value: string) {
				// System prompt configuration is owned by the Harness source.
			},
			get model() {
				return facade.model as Model<Api>;
			},
			set model(value: Model<Api>) {
				if ((value as Model<Api> | undefined) === undefined) facade.harness.clearModel();
				else void facade.harness.setModel(value as Model<Api>);
			},
			get thinkingLevel() {
				return facade.harness.currentThinkingLevel;
			},
			set thinkingLevel(value: ThinkingLevel) {
				void facade.harness.setThinkingLevel(value);
			},
			get tools() {
				return [...facade.harness.toolsSnapshot] as AgentTool[];
			},
			set tools(value: AgentTool[]) {
				void facade.harness.setTools(value as HarnessTool[], facade.harness.activeToolNamesSnapshot as string[]);
			},
			get messages() {
				return facade.messages;
			},
			set messages(value: AgentMessage[]) {
				facade.syncCompatibilityMessages(value);
			},
			get isStreaming() {
				return facade.harness.isRunning;
			},
			get streamingMessage() {
				return undefined;
			},
			get pendingToolCalls() {
				return new Set<string>();
			},
		get errorMessage() {
				return undefined;
			},
		};

		const agent = {
			state,
			get streamFunction() {
				return facade.harness.streamFunction;
			},
			set streamFunction(value: StreamFn) {
				facade.harness.setStreamFunction(value);
			},
			get signal() {
				return facade.harness.currentSignal;
			},
			get steeringMode() {
				return facade.harness.currentSteeringMode;
			},
			set steeringMode(value: QueueMode) {
				void facade.harness.setSteeringMode(value);
			},
			get followUpMode() {
				return facade.harness.currentFollowUpMode;
			},
			set followUpMode(value: QueueMode) {
				void facade.harness.setFollowUpMode(value);
			},
			get transport() {
				return "auto" as const;
			},
			set transport(value: "auto" | "sse" | "websocket") {
				void facade.harness.patchStreamOptions({ transport: value });
			},
			prompt: async (input: string | AgentMessage | AgentMessage[], images?: ImageContent[]) => {
				if (typeof input === "string") await facade.prompt(input, { images });
				else await facade.prompt(messageText(Array.isArray(input) ? input[0] : input), { images });
			},
			continue: async () => {
				const result = await facade.harness.resume();
				const error = resultError(result);
				if (error) throw error;
			},
			steer: (message: AgentMessage) => {
				const queue = facade.harness.isRunning ? facade.harness.steer(message) : facade.harness.nextRun(message);
				void queue.then((result) => {
					const error = resultError(result);
					if (error) throw error;
				});
			},
			followUp: (message: AgentMessage) => {
				const queue = facade.harness.isRunning ? facade.harness.followUp(message) : facade.harness.nextRun(message);
				void queue.then((result) => {
					const error = resultError(result);
					if (error) throw error;
				});
			},
			clearSteeringQueue: () => {
				void facade.harness.cancelAllQueued();
			},
			clearFollowUpQueue: () => {
				void facade.harness.cancelAllQueued();
			},
			clearAllQueues: () => {
				void facade.harness.cancelAllQueued();
			},
			hasQueuedMessages: () => facade.harness.hasQueuedMessages,
			abort: () => {
				void facade.abort();
			},
			waitForIdle: () => facade.waitForIdle(),
			subscribe: (listener: (event: AgentEvent, signal: AbortSignal) => void | Promise<void>) =>
			facade.subscribe((event) => void listener(event as AgentEvent, facade.harness.currentSignal as AbortSignal)),
			setCanonicalStreamFunction: (streamFunction: StreamFn) => facade.harness.setStreamFunction(streamFunction),
		} as unknown as CanonicalAgentCompatibility;
		return agent;
	}

	get agent(): Agent {
		return this.compatibilityAgent as unknown as Agent;
	}

	get sessionRead(): AgentSessionReadProjection {
		return this.sessionReadProjection;
	}

	get modelRuntime(): ModelRuntime {
		return this._modelRuntime;
	}

	get agentRuntimeComposition(): AgentRuntimeComposition {
		return this.runtimeComposition;
	}

	get modelBroker(): ModelBroker {
		return this._modelBroker;
	}

	get modelBrokerConfigRevision(): string {
		return this._modelBrokerConfigRevision;
	}

	get resourceLoader(): ResourceLoader {
		return this._resourceLoader;
	}

	get cwd(): string {
		return this._cwd;
	}

	get sessionFile(): string | undefined {
		return this.sessionManager.getSessionFile();
	}

	get sessionId(): string {
		return this.sessionManager.getSessionId();
	}

	get sessionName(): string | undefined {
		return this.sessionManager.getSessionName();
	}

	get state(): AgentState {
		return this.compatibilityAgent.state;
	}

	get model(): Model<Api> | undefined {
		return this.harness.hasModel ? this.harness.currentModel : undefined;
	}

	get thinkingLevel(): ThinkingLevel {
		return this.harness.currentThinkingLevel;
	}

	get isStreaming(): boolean {
		return this.promptPreflightPending || this.harness.isRunning;
	}

	get isIdle(): boolean {
		return !this.isStreaming;
	}

	get systemPrompt(): string {
		const promptCwd = this._cwd.replaceAll("\\", "/");
		return this._systemPrompt.replace(`Current working directory: ${promptCwd}`, `Current working directory: ${this._cwd}`);
	}

	get retryAttempt(): number {
		return this.harness.retryAttempt;
	}

	getActiveToolNames(): string[] {
		return [...(this.pendingActiveToolNames ?? this.harness.activeToolNamesSnapshot)];
	}

	get messages(): AgentMessage[] {
		return structuredClone(this.compatibilityMessagesProjection);
	}

	private projectCompatibilityMessages(entries: Entry[]): AgentMessage[] {
		let compactionIndex = -1;
		for (let index = entries.length - 1; index >= 0; index -= 1) {
			if (entries[index]?.type === "compaction") {
				compactionIndex = index;
				break;
			}
		}
		if (compactionIndex < 0) {
			return entries
				.filter((entry): entry is Extract<Entry, { type: "message" }> => entry.type === "message")
				.map((entry) => structuredClone(normalizeCompatibilityMessage(entry.message)));
		}
		const compaction = entries[compactionIndex];
		if (compaction.type !== "compaction") return [];
		return [
			createCompactionSummaryMessage(compaction.summary, compaction.tokensBefore, compaction.timestamp),
			...compaction.retainedTail.map((message) => structuredClone(normalizeCompatibilityMessage(message))),
			...entries
				.slice(compactionIndex + 1)
				.filter((entry): entry is Extract<Entry, { type: "message" }> => entry.type === "message")
				.map((entry) => structuredClone(normalizeCompatibilityMessage(entry.message))),
		];
	}

	private async refreshCompatibilityMessages(): Promise<void> {
		this.compatibilityMessagesProjection = (await this.harness.getMessages()).map(normalizeCompatibilityMessage);
	}

	private syncCompatibilityMessages(messages: AgentMessage[]): void {
		const available = new Map<string, number>();
		for (const entry of this.canonicalEntriesSnapshot()) {
			if (entry.type !== "message") continue;
			const key = JSON.stringify(entry.message);
			if (key !== undefined) available.set(key, (available.get(key) ?? 0) + 1);
		}
		for (const sourceMessage of messages) {
			const message = normalizeCompatibilityMessage(sourceMessage);
			const key = JSON.stringify(message);
			if (key !== undefined) {
				const count = available.get(key) ?? 0;
				if (count > 0) {
					available.set(key, count - 1);
					continue;
				}
			}
			if (
				message.role !== "user" &&
				message.role !== "assistant" &&
				message.role !== "toolResult" &&
				message.role !== "custom" &&
				message.role !== "bashExecution"
			) continue;
			this.harness.recordCompatibilityMessage(omitUndefined(message) as AgentMessage);
		}
		this.compatibilityMessagesProjection = structuredClone(messages.map(normalizeCompatibilityMessage));
	}

	private flushPendingExternalMessages(): void {
		for (const message of this.pendingExternalMessages.splice(0)) {
			void this.harness.recordExternalMessage(message);
		}
		this.compatibilityMessagesProjection = this.projectCompatibilityMessages(this.canonicalEntriesSnapshot());
	}

	private canonicalEntriesSnapshot(): Entry[] {
		return this.storage?.getEntriesSnapshot() ?? [];
	}

	get steeringMode(): QueueMode {
		return this.harness.currentSteeringMode;
	}

	get followUpMode(): QueueMode {
		return this.harness.currentFollowUpMode;
	}

	get scopedModels(): ReadonlyArray<{ model: Model<Api>; thinkingLevel?: ThinkingLevel }> {
		return this._scopedModels;
	}

	setScopedModels(models: Array<{ model: Model<Api>; thinkingLevel?: ThinkingLevel }>): void {
		this._scopedModels = [...models];
	}

	get promptTemplates() {
		return this._resourceLoader.getPrompts().prompts;
	}

	get skills() {
		return this._resourceLoader.getSkills().skills;
	}

	get pendingMessageCount(): number {
		if (!this.harness.isRunning && this.harness.durablePendingMessageCount === 0) return 0;
		return this.harness.pendingMessageCount;
	}

	get isCompacting(): boolean {
		return this.harness.currentOperationKind === "compaction";
	}

	get isRetrying(): boolean {
		return this.harness.isRetrying;
	}

	get autoRetryEnabled(): boolean {
		return this.settingsManager.getRetryEnabled();
	}

	get autoCompactionEnabled(): boolean {
		return this.settingsManager.getCompactionEnabled();
	}

	subscribe(listener: AgentSessionEventListener): () => void {
		this.sessionInfoSubscribers.add(listener);
		const unsubscribeAgent = this.harness.events.on("agent_event", (value) => {
			if (!this.isAgentEventEnvelope(value)) return;
			listener(this.projectDlpEvent(agentEventToSessionEvent(value.event)));
		});
		const unsubscribeQueue = this.harness.events.on("queue_update", (value) => {
			if (!this.isQueueUpdate(value)) return;
			listener(value);
		});
		const unsubscribeRetryScheduled = this.harness.events.on("retry_scheduled", (value) => {
			if (!this.isRetryScheduled(value)) return;
			listener({
				type: "auto_retry_start",
				attempt: value.attempt,
				maxAttempts: value.maxAttempts,
				delayMs: value.delayMs,
				errorMessage: value.errorMessage,
			});
			listener({ type: "agent_end", messages: [], willRetry: true });
		});
		const unsubscribeRetryFinished = this.harness.events.on("retry_finished", (value) => {
			if (!this.isRetryFinished(value)) return;
			listener({
				type: "auto_retry_end",
				success: value.success,
				attempt: value.attempt,
				...(value.finalError === undefined ? {} : { finalError: value.finalError }),
			});
		});
		const unsubscribeSettled = this.harness.events.on("agent_settled", () => {
			listener({ type: "agent_settled" });
		});
		const unsubscribeBash = this.harness.events.on("bash_execution_update", (value) => {
			if (!this.isBashExecutionUpdate(value)) return;
			listener({ type: "bash_execution_update", ...(value.id === undefined ? {} : { id: value.id }), delta: value.delta });
		});
		const unsubscribeCompactionStart = this.harness.events.on("compaction_start", (value) => {
			if (!this.isCompactionStart(value)) return;
			listener({ type: "compaction_start", reason: value.reason });
		});
		const unsubscribeCompactionEnd = this.harness.events.on("compaction_end", (value) => {
			if (!this.isCompactionEnd(value)) return;
			listener({
				type: "compaction_end",
				reason: value.reason,
				result: value.result === undefined ? undefined : toLegacyCompactionResult(value.result),
				aborted: value.aborted,
				willRetry: value.willRetry,
				...(value.errorMessage === undefined ? {} : { errorMessage: value.errorMessage }),
			});
		});
		const unsubscribeSummarizationRetryScheduled = this.harness.events.on("summarization_retry_scheduled", (value) => {
			listener(value);
		});
		const unsubscribeSummarizationRetryAttemptStart = this.harness.events.on("summarization_retry_attempt_start", (value) => {
			listener(value);
		});
		const unsubscribeSummarizationRetryFinished = this.harness.events.on("summarization_retry_finished", () => {
			listener({ type: "summarization_retry_finished" });
		});
		return () => {
			this.sessionInfoSubscribers.delete(listener);
			unsubscribeAgent();
			unsubscribeQueue();
			unsubscribeRetryScheduled();
			unsubscribeRetryFinished();
			unsubscribeSettled();
			unsubscribeBash();
			unsubscribeCompactionStart();
			unsubscribeCompactionEnd();
			unsubscribeSummarizationRetryScheduled();
			unsubscribeSummarizationRetryAttemptStart();
			unsubscribeSummarizationRetryFinished();
		};
	}

	private projectDlpEvent(event: AgentSessionEvent): AgentSessionEvent {
		const scanner = this.storage.getDlpScanner();
		if (scanner === undefined) return event;
		switch (event.type) {
			case "entry_appended":
				return event.entry.type === "message" && event.entry.message.role === "toolResult"
					? { ...event, entry: { ...event.entry, message: scanner.projectToolResult(event.entry.message) } }
					: event;
			case "message_start":
			case "message_end":
				return event.message.role === "toolResult" ? { ...event, message: scanner.projectToolResult(event.message) } : event;
			case "turn_end":
				return { ...event, toolResults: event.toolResults.map((message) => scanner.projectToolResult(message)) };
			case "tool_execution_update":
				return { ...event, partialResult: scanner.projectStructured(event.partialResult) };
			case "tool_execution_end":
				return { ...event, result: scanner.projectStructured(event.result) };
			case "agent_end":
				return { ...event, messages: event.messages.map((message) => scanner.projectToolResult(message)) };
			case "bash_execution_update":
				return { ...event, delta: scanner.projectStructured(event.delta) };
			default:
				return event;
		}
	}

	private isAgentEventEnvelope(value: unknown): value is { type: "agent_event"; event: AgentEvent } {
		return typeof value === "object" && value !== null && (value as { type?: unknown }).type === "agent_event" && "event" in value;
	}

	private isQueueUpdate(value: unknown): value is { type: "queue_update"; steering: readonly string[]; followUp: readonly string[] } {
		return typeof value === "object" && value !== null && (value as { type?: unknown }).type === "queue_update" && Array.isArray((value as { steering?: unknown }).steering) && Array.isArray((value as { followUp?: unknown }).followUp);
	}

	private isRetryScheduled(value: unknown): value is { type: "retry_scheduled"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string } {
		return typeof value === "object" && value !== null &&
			(value as { type?: unknown }).type === "retry_scheduled" &&
			typeof (value as { attempt?: unknown }).attempt === "number" &&
			typeof (value as { maxAttempts?: unknown }).maxAttempts === "number" &&
			typeof (value as { delayMs?: unknown }).delayMs === "number" &&
			typeof (value as { errorMessage?: unknown }).errorMessage === "string";
	}

	private isRetryFinished(value: unknown): value is { type: "retry_finished"; success: boolean; attempt: number; finalError?: string } {
		return typeof value === "object" && value !== null &&
			(value as { type?: unknown }).type === "retry_finished" &&
		typeof (value as { success?: unknown }).success === "boolean" &&
		typeof (value as { attempt?: unknown }).attempt === "number" &&
		((value as { finalError?: unknown }).finalError === undefined || typeof (value as { finalError?: unknown }).finalError === "string");
	}

	private isBashExecutionUpdate(value: unknown): value is { type: "bash_execution_update"; id?: string; delta: string } {
		return typeof value === "object" && value !== null &&
			(value as { type?: unknown }).type === "bash_execution_update" &&
			typeof (value as { delta?: unknown }).delta === "string" &&
			((value as { id?: unknown }).id === undefined || typeof (value as { id?: unknown }).id === "string");
	}

	private isCompactionStart(value: unknown): value is { type: "compaction_start"; reason: "manual" | "threshold" | "overflow" } {
		return typeof value === "object" && value !== null &&
			(value as { type?: unknown }).type === "compaction_start" &&
			((value as { reason?: unknown }).reason === "manual" || (value as { reason?: unknown }).reason === "threshold" || (value as { reason?: unknown }).reason === "overflow");
	}

	private isCompactionEnd(value: unknown): value is {
		type: "compaction_end";
		reason: "manual" | "threshold" | "overflow";
		result?: HarnessCompactionResult;
		aborted: boolean;
		willRetry: boolean;
		errorMessage?: string;
	} {
		return typeof value === "object" && value !== null &&
			(value as { type?: unknown }).type === "compaction_end" &&
			((value as { reason?: unknown }).reason === "manual" || (value as { reason?: unknown }).reason === "threshold" || (value as { reason?: unknown }).reason === "overflow") &&
			typeof (value as { aborted?: unknown }).aborted === "boolean" &&
			typeof (value as { willRetry?: unknown }).willRetry === "boolean";
	}

	private expandSkillCommand(text: string): string {
		if (!text.startsWith("/skill:")) return text;
		const match = text.match(/^\/skill:([^\s]+)(?:\s+([\s\S]*))?$/);
		if (!match) return text;
		const skill = this.skills.find((candidate) => candidate.name === match[1]);
		if (skill === undefined) return text;
		try {
			const body = stripFrontmatter(readFileSync(skill.filePath, "utf8")).trim();
			const block = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
			const args = match[2]?.trim();
			return args ? `${block}\n\n${args}` : block;
		} catch (error) {
			this._extensionRunner.emitError({
				extensionPath: skill.filePath,
				event: "skill",
				error: error instanceof Error ? error.message : String(error),
			});
			return text;
		}
	}

	private expandPromptText(text: string, enabled: boolean): string {
		if (!enabled) return text;
		return expandPromptTemplate(this.expandSkillCommand(text), [...this.promptTemplates]);
	}

	private async assertModelAndAuth(options: { allowCustomStream: boolean }): Promise<Model<Api>> {
		const model = this.model;
		if (model === undefined) throw new Error(formatNoModelSelectedMessage());
		if (options.allowCustomStream && this.harness.hasCustomStreamFunction) return model;
		const authRuntime = this._modelRuntime as unknown as {
			hasConfiguredAuth?: (providerId: string) => boolean;
			checkAuth?: (providerId: string) => Promise<unknown>;
			getAuth?: (providerOrModel: string | Model<Api>) => Promise<unknown>;
		};
		if (authRuntime.hasConfiguredAuth === undefined) return model;
		if (authRuntime.hasConfiguredAuth?.(model.provider) === true) return model;
		try {
			if (authRuntime.checkAuth !== undefined && (await authRuntime.checkAuth(model.provider)) !== undefined) return model;
		} catch {
			// Resolve below so a transient check failure still produces the stable
			// user-facing auth error when no credentials can be resolved.
		}
		throw new Error(formatNoApiKeyFoundMessage(model.provider));
	}

	private assertQueueableMessage(text: string): void {
		if (!text.startsWith("/")) return;
		const separator = text.indexOf(" ");
		const name = separator < 0 ? text.slice(1) : text.slice(1, separator);
		if (this._extensionRunner.getCommand(name) !== undefined) {
			throw new Error(`Extension command "/${name}" cannot be queued. Use prompt() or execute the command when not streaming.`);
		}
	}

	private async transformInput(
		text: string,
		images: ImageContent[] | undefined,
		source: "interactive" | "rpc" | "extension",
		streamingBehavior?: "steer" | "followUp",
	): Promise<{ text: string; images?: ImageContent[] } | undefined> {
		const result = await this._extensionRunner.emitInput(text, images, source, streamingBehavior);
		if (result.action === "handled") return undefined;
		if (result.action === "transform") return { text: result.text, images: result.images };
		return { text, images };
	}

	async prompt(text: string, options: PromptOptions = {}): Promise<void> {
		if (this.admissionPaused) throw new Error("Session scope transition is in progress");
		return this.promptAccepted(text, options);
	}

	private async promptAccepted(text: string, options: PromptOptions): Promise<void> {
		if (options.signal?.aborted) throw options.signal.reason ?? new DOMException("Operation aborted", "AbortError");
		if ((options.expandPromptTemplates ?? true) && text.startsWith("/")) {
			const handled = await this.tryExecuteExtensionCommand(text);
			if (handled) {
				options.preflightResult?.(true);
				return;
			}
		}
		if (this.isCompacting) {
			options.preflightResult?.(false);
			throw new Error("Cannot submit a prompt while compaction is in progress. Wait for compaction to finish and retry.");
		}
		const input = await this.transformInput(
			text,
			options.images,
			options.source ?? "interactive",
			this.isStreaming ? options.streamingBehavior : undefined,
		);
		if (input === undefined) {
			options.preflightResult?.(true);
			return;
		}
		// transformInput and extension-command lookup are asynchronous admission
		// preflight. Recheck the fence after their final await, then track the
		// accepted task without yielding so a scope transition cannot pass its
		// drain while this prompt is still untracked.
		if (this.admissionPaused) throw new Error("Session scope transition is in progress");
		await this.trackPromptTask(
			this.promptPrepared(this.expandPromptText(input.text, options.expandPromptTemplates ?? true), input.images, options),
		);
	}

	private trackPromptTask(task: Promise<void>): Promise<void> {
		let tracked!: Promise<void>;
		tracked = (async () => {
			try {
				await task;
			} finally {
				this.activePromptTasks.delete(tracked);
			}
		})();
		this.activePromptTasks.add(tracked);
		return tracked;
	}

	private trackPromptOperation(
		operation: (tracking: { pause(): void; resume(): void }) => Promise<void>,
	): Promise<void> {
		let start!: () => void;
		let task!: Promise<void>;
		let activeGate: Promise<void> | undefined;
		let pauseActiveGate: (() => void) | undefined;
		let settled = false;
		const tracking = {
			pause: (): void => {
				if (activeGate === undefined) return;
				const gate = activeGate;
				activeGate = undefined;
				pauseActiveGate?.();
				pauseActiveGate = undefined;
				this.activePromptTasks.delete(gate);
			},
			resume: (): void => {
				if (settled || activeGate !== undefined) return;
				const paused = new Promise<void>((resolve) => {
					pauseActiveGate = resolve;
				});
				const gate = Promise.race([task, paused]);
				void gate.catch(() => undefined);
				activeGate = gate;
				this.activePromptTasks.add(gate);
			},
		};
		const operationTask = new Promise<void>((resolve, reject) => {
			start = () => {
				try {
					operation(tracking).then(resolve, reject);
				} catch (error) {
					reject(error);
				}
			};
		});
		task = (async () => {
			try {
				await operationTask;
			} finally {
				settled = true;
				tracking.pause();
			}
		})();
		tracking.resume();
		start();
		return task;
	}

	private async syncHarnessRetryPolicy(): Promise<void> {
		await this.harness.setRetryPolicy(this.settingsManager.getRetrySettings());
	}

	private async syncHarnessCompactionSettings(): Promise<void> {
		const settings = this.settingsManager.getCompactionSettings();
		const contextWindow = this.model?.contextWindow;
		await this.harness.setCompactionSettings({
			...settings,
			reserveTokens: contextWindow === undefined
				? settings.reserveTokens
				: Math.min(settings.reserveTokens, Math.floor(contextWindow / 2)),
		});
	}

	private productPromptDependencySnapshot(
		name: PromptTaskDependencyName,
		context: ProductPromptDependencySnapshotContext,
	): FoundationJsonValue {
		const capability = this.controlPlane.getCapabilityContextMetadata();
		switch (name) {
			case "context":
				return {
					state: "resolved_at_harness_context_boundary",
					sessionId: this.sessionId,
					runId: context.runId,
				};
			case "model":
				return {
					state: "bound",
					bindingId: this.modelBrokerBindingId ?? null,
					provider: context.model.provider,
					model: context.model.id,
					thinkingLevel: context.thinkingLevel,
				};
			case "capability":
				return {
					state: capability.bindingId === undefined ? "inactive" : "active",
					bindingId: capability.bindingId ?? null,
					profile: this.controlPlane.getActiveCapabilityProfile(),
					tools: capability.tools.map((tool) => ({ id: tool.id, revision: tool.revision, name: tool.name })),
					hasSkills: capability.hasSkills,
				};
			case "mcp":
				return {
					state: "managed_by_control_plane",
					attachmentIds: this.mcpAttachmentRegistry.list().map((attachment) => attachment.id),
				};
			case "policy":
				return {
					state: this.controlPlane.getActiveExecutionPolicyBinding() === undefined ? "inactive" : "active",
					profile: this.controlPlane.getActiveExecutionPolicyProfile(),
					bindingId: this.controlPlane.getActiveExecutionPolicyBinding()?.id ?? null,
				};
			case "sandbox":
				return { state: this.controlPlane.getSandboxHandle() === undefined ? "inactive" : "active" };
			case "audit":
				return { state: "session_ledger", sessionId: this.sessionId };
			case "run":
				return { state: "same_harness", runId: context.runId };
			case "gate":
				return { state: "host_terminal_gate", authorityId: "aos.host.terminal-gate" };
			case "graph":
				return { state: "implicit_goal", goalId: context.goalId, taskId: context.taskId };
			case "credential":
				return { state: this.controlPlane.getTaskCredentialService() === undefined ? "inactive" : "available" };
			case "adapter":
				return { state: "local_agent_executor", providerId: BUILTIN_CODING_AGENT_PROVIDER_ID };
		}
	}

	private async promptPrepared(text: string, images: ImageContent[] | undefined, options: PromptOptions): Promise<void> {
		if (this.isCompacting) {
			options.preflightResult?.(false);
			throw new Error("Cannot submit a prompt while compaction is in progress. Wait for compaction to finish and retry.");
		}
		if (this.promptPreflightPending || this.harness.currentSignal !== undefined) {
			if (options.streamingBehavior === "steer") {
				await this.steer(text, images);
				options.preflightResult?.(true);
				return;
			}
			if (options.streamingBehavior === "followUp") {
				await this.followUp(text, images);
				options.preflightResult?.(true);
				return;
			}
			throw new Error("Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.");
		}
		const processingLease = this.sessionFile === undefined
			? undefined
			: acquireSessionProcessingLease(this.sessionFile);
		try {
			await this.recoverInterruptedOperation();
			await this.executePreparedPrompt(text, images, options);
		} finally {
			processingLease?.release();
		}
	}

	private async recoverInterruptedOperation(): Promise<void> {
		const aborted = await this.harness.abort();
		const abortError = resultError(aborted);
		if (abortError !== undefined) {
			if (/No active operation/.test(abortError.message)) return;
			throw abortError;
		}
		const resumed = await this.harness.resume();
		const resumeError = resultError(resumed);
		if (
			resumeError !== undefined &&
			!("code" in resumeError && resumeError.code === "suspended" && !this.harness.isRunning)
		) {
			throw resumeError;
		}
		await this.refreshCompatibilityMessages();
	}

	private async executePreparedPrompt(
		text: string,
		images: ImageContent[] | undefined,
		options: PromptOptions,
	): Promise<void> {
		const runId = options.runId ?? randomUUID();
		const deadlineSignal = options.deadlineMs === undefined ? undefined : AbortSignal.timeout(options.deadlineMs);
		const signal = options.signal === undefined
			? deadlineSignal
			: deadlineSignal === undefined
				? options.signal
				: AbortSignal.any([options.signal, deadlineSignal]);
		this.promptPreflightPending = true;
		try {
			await this.assertModelAndAuth({ allowCustomStream: false });
			await this.syncHarnessRetryPolicy();
			if (options.deadlineMs !== undefined && (!Number.isFinite(options.deadlineMs) || options.deadlineMs < 0)) {
				throw new Error("Prompt deadlineMs must be a non-negative finite number");
			}
			await (this.compatibilityFacade?.whenCapabilitiesReady(runId, signal) ?? this.whenCapabilitiesReady(runId, signal));
			if (signal?.aborted) throw signal.reason ?? new DOMException("Operation aborted", "AbortError");
		} catch (error) {
			options.preflightResult?.(false);
			throw error;
		} finally {
			this.promptPreflightPending = false;
		}
		options.preflightResult?.(true);
		this.harness.beginPromptCompactionCycle();
		const previousAssistant = [...this.messages].reverse().find((message): message is AssistantMessage => message.role === "assistant");
		if (previousAssistant !== undefined) await this._checkCompaction(previousAssistant);
		let execution = await this.productPromptIngress.execute({
			prompt: text,
			surface: options.surface ?? this.promptSurface,
			...(images === undefined ? {} : { images }),
			runId,
			...(signal === undefined ? {} : { signal }),
		});
		await this.refreshCompatibilityMessages();
		const result = { ok: true, value: execution.run };
		const error = resultError(result);
		if (error) {
			if (isNonThrowingAssistantFailure(result)) return;
			options.preflightResult?.(false);
			throw error;
		}
		const assistant = [...this.messages].reverse().find((message): message is AssistantMessage => message.role === "assistant");
		if (assistant === undefined) return;
		const postToolCompactionRequested = this.harness.consumePostToolCompactionRequest();
		const model = this.model;
		const overflowNeedsContinuation = model !== undefined && assistant.stopReason !== "stop" && (
			isContextOverflow(assistant, model.contextWindow) || isRecoverableLength(assistant, model.maxTokens)
		);
		const compacted = postToolCompactionRequested
			? await this._runAutoCompaction("threshold", false)
			: await this._checkCompaction(assistant);
		if (!compacted || (!overflowNeedsContinuation && !postToolCompactionRequested)) return;
		execution = await this.productPromptIngress.execute({
			prompt: text,
			surface: options.surface ?? this.promptSurface,
			continuation: true,
			runId: randomUUID(),
			...(signal === undefined ? {} : { signal }),
		});
		await this.refreshCompatibilityMessages();
		const continuationResult = { ok: true, value: execution.run };
		const continuationError = resultError(continuationResult);
		if (continuationError) {
			if (isNonThrowingAssistantFailure(continuationResult)) return;
			throw continuationError;
		}
		const continuationAssistant = [...this.messages].reverse().find((message): message is AssistantMessage => message.role === "assistant");
		if (continuationAssistant !== undefined) await this._checkCompaction(continuationAssistant);
	}

	async resume(): Promise<void> {
		await this.syncHarnessRetryPolicy();
		const result = await this.harness.resume();
		await this.refreshCompatibilityMessages();
		const error = resultError(result);
		if (error) throw error;
	}

	async abort(): Promise<void> {
		this.controlPlane.cancelMcpContentOperations();
		const workerCancellation = (async (): Promise<unknown> => {
			try {
				await this.controlPlane.cancelWorkerOperations();
				return undefined;
			} catch (error) {
				return error;
			}
		})();
		const hostCancellation = (async (): Promise<unknown> => {
			try {
				const result = await this.harness.abort();
				const error = resultError(result);
				return error !== undefined && !/No active operation/.test(error.message) ? error : undefined;
			} catch (error) {
				return error;
			}
		})();
		const [workerFailure, hostFailure] = await Promise.all([workerCancellation, hostCancellation]);
		let failure = workerFailure ?? hostFailure;
		try {
			await this.harness.waitForIdle();
		} catch (error) {
			failure ??= error;
		}
		while (this.activePromptTasks.size > 0) {
			await Promise.allSettled([...this.activePromptTasks]);
		}
		if (failure !== undefined) throw failure;
	}

	async waitForIdle(): Promise<void> {
		await this.harness.waitForIdle();
		this.flushPendingExternalMessages();
		await this.refreshCompatibilityMessages();
	}

	/** @internal Stop new prompt admission synchronously. */
	pauseAdmission(): void {
		this.admissionPaused = true;
	}

	/** @internal Drain canonical agent and storage work without awaiting the caller that initiated a transition. */
	async drainAcceptedWrites(): Promise<void> {
		await this.waitForIdle();
		await this.storage.drain();
	}

	/** @internal Re-open a scope whose replacement failed before publication. */
	resumeAdmission(): void {
		this.admissionPaused = false;
	}

	async waitForDispose(): Promise<void> {
		if (this.disposePromise !== undefined) {
			await this.disposePromise;
			return;
		}
		await this.waitForIdle();
	}

	async steer(text: string, images?: ImageContent[]): Promise<void> {
		this.assertQueueableMessage(text);
		const result = await this.harness.steer(text, images);
		const error = resultError(result);
		if (error) throw error;
	}

	async followUp(text: string, images?: ImageContent[]): Promise<void> {
		this.assertQueueableMessage(text);
		const result = await this.harness.followUp(text, images);
		const error = resultError(result);
		if (error) throw error;
	}

	async sendUserMessage(
		content: string | Array<{ type: "text" | "image"; text?: string; data?: string; mimeType?: string }>,
		options?: { deliverAs?: "steer" | "followUp" },
	): Promise<void> {
		const text = typeof content === "string" ? content : content.filter((part) => part.type === "text").map((part) => part.text ?? "").join("");
		const images = typeof content === "string" ? undefined : content
			.filter((part): part is { type: "image"; data: string; mimeType: string } => part.type === "image" && part.data !== undefined && part.mimeType !== undefined)
			.map((part) => ({ type: "image" as const, data: part.data, mimeType: part.mimeType }));
		const input = await this.transformInput(text, images, "extension", options?.deliverAs);
		if (input === undefined) return;
		if (options?.deliverAs === "steer") {
			const result = await this.harness.steer(input.text, input.images);
			const error = resultError(result);
			if (error) throw error;
			return;
		}
		if (options?.deliverAs === "followUp") {
			const result = await this.harness.followUp(input.text, input.images);
			const error = resultError(result);
			if (error) throw error;
			return;
		}
		return this.trackPromptTask(this.promptPrepared(input.text, input.images, { images: input.images, source: "extension" }));
	}

	private async tryExecuteExtensionCommand(text: string): Promise<boolean> {
		const separator = text.indexOf(" ");
		const name = separator < 0 ? text.slice(1) : text.slice(1, separator);
		const command = this._extensionRunner.getCommand(name);
		if (command === undefined) return false;
		const args = separator < 0 ? "" : text.slice(separator + 1);
		await this.trackPromptOperation(async (tracking) => {
			const context = this._extensionRunner.createCommandContext();
			const originSession = this.compatibilityFacade;
			if (originSession === undefined) throw new Error("Extension command Session facade is unavailable");
			const runReplacingAction = async <TResult>(
				action: () => Promise<TResult>,
			): Promise<TResult> => {
				tracking.pause();
				try {
					return await extensionCommandTransitionOrigin.run(originSession, action);
				} finally {
					tracking.resume();
				}
			};
			const newSession = context.newSession;
			const fork = context.fork;
			const switchSession = context.switchSession;
			const reload = context.reload;
			context.newSession = (options) => runReplacingAction(() => newSession(options));
			context.fork = (entryId, options) => runReplacingAction(() => fork(entryId, options));
			context.switchSession = (sessionPath, options) => runReplacingAction(() => switchSession(sessionPath, options));
			context.reload = () => runReplacingAction(reload);
			try {
				await command.handler(args, context);
			} catch (error) {
				this._extensionRunner.emitError({
					extensionPath: `command:${name}`,
					event: "command",
					error: error instanceof Error ? error.message : String(error),
				});
			}
		});
		return true;
	}

	async sendCustomMessage<T = unknown>(
		message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
	): Promise<void> {
		const customMessage = omitUndefined({
			role: "custom",
			customType: message.customType,
			content: message.content ?? [],
			display: message.display,
			details: message.details,
			timestamp: Date.now(),
		}) as CustomMessage<T>;
		if (options?.deliverAs === "steer") {
			const result = await this.harness.steer(customMessage);
			const error = resultError(result);
			if (error) throw error;
			return;
		}
		if (options?.deliverAs === "followUp") {
			const result = await this.harness.followUp(customMessage);
			const error = resultError(result);
			if (error) throw error;
			return;
		}
		if (options?.deliverAs === "nextTurn") {
			const result = await this.harness.nextRun(customMessage);
			const error = resultError(result);
			if (error) throw error;
			return;
		}
		await this.harness.recordCompatibilityMessage(customMessage);
		this.compatibilityMessagesProjection = this.projectCompatibilityMessages(this.canonicalEntriesSnapshot());
		if (options?.triggerTurn) await this.resume();
	}

	clearQueue(): { steering: string[]; followUp: string[] } {
		const result = {
			steering: this.harness.steeringMessagesSnapshot.map(messageText),
			followUp: this.harness.followUpMessagesSnapshot.map(messageText),
		};
		void this.harness.cancelAllQueued();
		return result;
	}

	getSteeringMessages(): readonly string[] {
		return this.harness.steeringMessagesSnapshot.map(messageText);
	}

	getFollowUpMessages(): readonly string[] {
		return this.harness.followUpMessagesSnapshot.map(messageText);
	}

	async compact(customInstructions?: string): Promise<CompactionResult> {
		this.manualCompactionPending = true;
		try {
			await this.harness.waitForIdle();
			await this.assertModelAndAuth({ allowCustomStream: true });
			await this.syncHarnessRetryPolicy();
			await this.syncHarnessCompactionSettings();
			const result = await this.harness.compact({ customInstructions });
			await this.refreshCompatibilityMessages();
			const error = resultError(result);
			if (error) throw error;
			if (!result.ok) throw new Error("Compaction failed");
			if (result.value.kind === "completed") {
				return {
					summary: result.value.entry.summary,
					firstKeptEntryId: result.value.entry.firstKeptEntryId ?? result.value.entry.id,
					tokensBefore: result.value.entry.tokensBefore,
					estimatedTokensAfter: estimateContextTokens(this.messages).tokens,
					...(result.value.entry.usage === undefined ? {} : { usage: result.value.entry.usage }),
					...(result.value.entry.details === undefined ? {} : { details: result.value.entry.details }),
				};
			}
			if (result.value.kind === "aborted") throw new Error("Compaction cancelled");
			if (result.value.kind === "declined") throw new Error("No compactable session history");
			if (result.value.kind !== "failed") throw new Error("Compaction failed");
			const failure = new Error(result.value.error.message) as Error & { code?: string };
			failure.code = result.value.error.code;
			throw failure;
		} finally {
			this.manualCompactionPending = false;
		}
	}

	async _checkCompaction(
		assistantMessage: Parameters<AgentHarness["checkCompaction"]>[0],
		skipAbortedCheck = true,
		autoCompaction?: (reason: "overflow" | "threshold", willRetry: boolean) => Promise<boolean>,
	): Promise<boolean> {
		if (this.manualCompactionPending) return false;
		await this.syncHarnessRetryPolicy();
		await this.syncHarnessCompactionSettings();
		const compacted = await this.harness.checkCompaction(
			assistantMessage,
			skipAbortedCheck,
			autoCompaction ?? ((reason, willRetry) => this._runAutoCompaction(reason, willRetry)),
		);
		if (compacted) return true;
		const model = this.model;
		if (
			model === undefined
			|| assistantMessage.provider !== model.provider
			|| assistantMessage.model !== model.id
			|| (assistantMessage.stopReason !== "error" && calculateContextTokens(assistantMessage.usage) !== 0)
			|| isContextOverflow(assistantMessage, model.contextWindow)
			|| isRecoverableLength(assistantMessage, model.maxTokens)
		) return false;
		const estimate = estimateContextTokens(this.agent.state.messages);
		const latestCompaction = getLatestCompactionEntry(this.sessionManager.getBranch());
		if (estimate.lastUsageIndex !== null) {
			const usageMessage = this.agent.state.messages[estimate.lastUsageIndex];
			if (
				latestCompaction !== null
				&& usageMessage?.role === "assistant"
				&& usageMessage.timestamp <= Date.parse(latestCompaction.timestamp)
			) return false;
		}
		const settings = this.settingsManager.getCompactionSettings();
		return shouldCompact(estimate.tokens, model.contextWindow, settings)
			? (autoCompaction ?? ((reason, willRetry) => this._runAutoCompaction(reason, willRetry)))("threshold", false)
			: false;
	}

	async _runAutoCompaction(reason: "overflow" | "threshold", willRetry: boolean): Promise<boolean> {
		await this.syncHarnessRetryPolicy();
		await this.syncHarnessCompactionSettings();
		return this.harness.runAutoCompaction(reason, willRetry);
	}

	abortCompaction(): void {
		void this.abort();
	}

	abortBranchSummary(): void {
		void this.abort();
	}

	async navigateTree(
		targetId: string,
		options: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string } = {},
	): Promise<{ editorText?: string; cancelled: boolean; aborted?: boolean; summaryEntry?: BranchSummaryEntry }> {
		if (this.isStreaming) {
			throw new Error("Wait for the current response to finish before navigating the session tree.");
		}
		const target = this.canonicalEntriesSnapshot().find((entry) => entry.id === targetId);
		await this.syncHarnessRetryPolicy();
		const result = await this.harness.navigateTree(targetId, {
			summarize: options.summarize,
			customInstructions: options.customInstructions,
			replaceInstructions: options.replaceInstructions,
			label: options.label,
		});
		await this.refreshCompatibilityMessages();
		const error = resultError(result);
		if (error) {
			if (error.name === "LaneBusy") throw new Error(error.message);
			throw error;
		}
		if (!result.ok) throw new Error("Navigation failed");
		const navigation = result.value;
		if (navigation.kind !== "completed") {
			return { cancelled: true, ...(navigation.kind === "aborted" ? { aborted: true } : {}) };
		}
		const editorText = target?.type === "message" && (target.message.role === "user" || target.message.role === "custom") ? messageText(target.message) : undefined;
		const projectedSummary = navigation.summaryEntry === undefined
			? undefined
			: this.sessionManager.getEntries().find((candidate) => candidate.id === navigation.summaryEntry?.id);
		return {
			editorText,
			cancelled: false,
			summaryEntry: projectedSummary as BranchSummaryEntry | undefined,
		};
	}

	async setModel(model: Model<Api>, options: { persist?: boolean } = {}): Promise<void> {
		await this.setModelInternal(model, "set", options.persist === true);
	}

	/** @internal Persist SDK bootstrap facts through the canonical Session. */
	async recordInitialSessionConfiguration(
		model: Model<Api> | undefined,
		thinkingLevel: ThinkingLevel,
		includeModel: boolean,
	): Promise<void> {
		if (includeModel && model !== undefined) {
			await this.canonicalSession.appendEntry(
				{ type: "model_change", id: this.canonicalSession.idGenerator.next(), provider: model.provider, modelId: model.id },
				"main",
			);
		}
		await this.canonicalSession.appendEntry(
			{ type: "thinking_level_change", id: this.canonicalSession.idGenerator.next(), thinkingLevel },
			"main",
		);
	}

	private async setModelInternal(
		model: Model<Api>,
		source: "set" | "cycle" | "restore",
		persist = false,
	): Promise<void> {
		const auth = await this._modelRuntime.checkAuth(model.provider);
		if (auth === undefined) throw new Error(`No API key for ${model.provider}/${model.id}`);
		const previousModel = this.model;
		await this.harness.setModel(model);
		if (persist) {
			this.settingsManager.setDefaultModelAndProvider(model.provider, model.id);
			this.addPersistedDefaultToNonEmptyScope(model);
		}
		const effectiveThinkingLevel = clampThinkingLevel(model, this.thinkingLevel) as ThinkingLevel;
		this.applyThinkingLevel(effectiveThinkingLevel);
		await this._extensionRunner.emit({
			type: "model_select",
			model,
			previousModel,
			source,
		});
	}

	private addPersistedDefaultToNonEmptyScope(model: Model<Api>): void {
		if (this._scopedModels.length === 0 || this._scopedModels.some((item) => modelsAreEqual(item.model, model))) return;
		this._scopedModels = [...this._scopedModels, { model }];
		const enabledModels = this.settingsManager.getEnabledModels();
		if (!enabledModels?.length) return;
		const reference = `${model.provider}/${model.id}`;
		if (enabledModels.some((pattern) => pattern.toLowerCase() === reference.toLowerCase())) return;
		this.settingsManager.setEnabledModels([...enabledModels, reference]);
	}

	private applyThinkingLevel(level: ThinkingLevel): void {
		const previousLevel = this.thinkingLevel;
		if (previousLevel === level) return;
		void this.harness.setThinkingLevel(level);
		for (const listener of this.sessionInfoSubscribers) listener({ type: "thinking_level_changed", level });
		void this._extensionRunner.emit({ type: "thinking_level_select", level, previousLevel });
	}

	setThinkingLevel(level: ThinkingLevel): void {
		const effective = this.model ? (clampThinkingLevel(this.model, level) as ThinkingLevel) : "off";
		this.applyThinkingLevel(effective);
	}

	getAvailableThinkingLevels(): ThinkingLevel[] {
		return this.model ? (getSupportedThinkingLevels(this.model) as ThinkingLevel[]) : ["off"];
	}

	supportsThinking(): boolean {
		return this.model?.reasoning === true;
	}

	cycleThinkingLevel(): ThinkingLevel | undefined {
		if (!this.supportsThinking()) return undefined;
		const levels = this.getAvailableThinkingLevels();
		if (levels.length === 0) return undefined;
		const next = levels[(levels.indexOf(this.thinkingLevel) + 1) % levels.length];
		this.setThinkingLevel(next);
		return next;
	}

	async cycleModel(direction: "forward" | "backward" = "forward"): Promise<ModelCycleResult | undefined> {
		const models: Array<{ model: Model<Api>; thinkingLevel?: ThinkingLevel }> = this._scopedModels.length > 0
			? this._scopedModels
			: this._modelRuntime.getModels().map((model) => ({ model }));
		if (models.length === 0) return undefined;
		const currentIndex = Math.max(0, models.findIndex((item) => item.model.provider === this.model?.provider && item.model.id === this.model?.id));
		const offset = direction === "forward" ? 1 : -1;
		const next = models[(currentIndex + offset + models.length) % models.length];
		if (!next) return undefined;
		await this.setModelInternal(next.model, "cycle");
		if (next.thinkingLevel !== undefined) this.setThinkingLevel(next.thinkingLevel);
		return { model: next.model, thinkingLevel: this.thinkingLevel, isScoped: this._scopedModels.length > 0 };
	}

	setSteeringMode(mode: QueueMode): void {
		void this.harness.setSteeringMode(mode);
		this.settingsManager.setSteeringMode(mode);
	}

	setFollowUpMode(mode: QueueMode): void {
		void this.harness.setFollowUpMode(mode);
		this.settingsManager.setFollowUpMode(mode);
	}

	setActiveToolsByName(names: string[]): void {
		const requestedNames = [...names];
		this.pendingActiveToolNames = requestedNames;
		const update = this.harness.setActiveTools(requestedNames);
		void update.then(
			() => {
				if (this.pendingActiveToolNames === requestedNames) this.pendingActiveToolNames = undefined;
			},
			() => {
				if (this.pendingActiveToolNames === requestedNames) this.pendingActiveToolNames = undefined;
			},
		);
	}

	getAllTools(): ToolInfo[] {
		return this.controlPlane.getToolDefinitions().map((tool) => ({
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters,
			promptGuidelines: tool.promptGuidelines,
			sourceInfo: this.controlPlane.getToolSourceInfo(tool.name),
		} as ToolInfo));
	}

	getToolDefinition(name: string): ToolDefinition | undefined {
		return this.controlPlane.getToolDefinition(name);
	}

	getSessionStats(): SessionStats {
		let userMessages = 0;
		let assistantMessages = 0;
		let toolCalls = 0;
		let toolResults = 0;
		let totalMessages = 0;
		const usageTotals = emptyUsage();
		const addUsage = (usage: Usage): void => {
			usageTotals.input += usage.input;
			usageTotals.output += usage.output;
			usageTotals.cacheRead += usage.cacheRead;
			usageTotals.cacheWrite += usage.cacheWrite;
			usageTotals.cost.total += usage.cost.total;
		};
		for (const entry of this.canonicalEntriesSnapshot()) {
			if (entry.type === "compaction" || entry.type === "branch_summary") {
				if (entry.usage !== undefined) addUsage(entry.usage);
				continue;
			}
			if (entry.type !== "message") continue;
			totalMessages += 1;
			if (entry.message.role === "user") userMessages += 1;
			if (entry.message.role === "toolResult") {
				toolResults += 1;
				if (entry.message.usage !== undefined) addUsage(entry.message.usage);
			}
			if (entry.message.role === "assistant") {
				assistantMessages += 1;
				toolCalls += entry.message.content.filter((part) => part.type === "toolCall").length;
				addUsage(entry.message.usage);
			}
		}
		return {
			sessionFile: this.sessionFile,
			sessionId: this.sessionId,
			userMessages,
			assistantMessages,
			toolCalls,
			toolResults,
			totalMessages,
			tokens: {
				input: usageTotals.input,
				output: usageTotals.output,
				cacheRead: usageTotals.cacheRead,
				cacheWrite: usageTotals.cacheWrite,
				total: usageTotals.input + usageTotals.output + usageTotals.cacheRead + usageTotals.cacheWrite,
			},
			cost: usageTotals.cost.total,
			contextUsage: this.getContextUsage(),
		};
	}

	getContextUsage(): ContextUsage | undefined {
		const model = this.model;
		if (!model || model.contextWindow <= 0) return undefined;
		const contextWindow = model.contextWindow;
		const branchEntries = this.sessionManager.getBranch();
		const latestCompaction = getLatestCompactionEntry(branchEntries);
		if (latestCompaction !== null) {
			const compactionIndex = branchEntries.lastIndexOf(latestCompaction);
			let hasPostCompactionUsage = false;
			for (let index = branchEntries.length - 1; index > compactionIndex; index -= 1) {
				const entry = branchEntries[index];
				if (entry?.type !== "message" || entry.message.role !== "assistant") continue;
				if (entry.message.stopReason === "aborted" || entry.message.stopReason === "error") continue;
				if (calculateContextTokens(entry.message.usage) > 0) {
					hasPostCompactionUsage = true;
					break;
				}
			}
			if (!hasPostCompactionUsage) return { tokens: null, contextWindow, percent: null };
		}
		const estimate = estimateContextTokens(this.messages);
		return {
			tokens: estimate.tokens,
			contextWindow,
			percent: (estimate.tokens / contextWindow) * 100,
		};
	}

	getLastAssistantText(): string | undefined {
		const last = [...this.messages].reverse().find((message): message is Extract<AgentMessage, { role: "assistant" }> => message.role === "assistant");
		if (!last) return undefined;
		return last.content.filter((part): part is { type: "text"; text: string } => part.type === "text").map((part) => part.text).join("").trim() || undefined;
	}

	setSessionName(name: string): void {
		const normalizedName = normalizeSessionName(name);
		if (this.storage === undefined) {
			throw new Error("Canonical session storage is required for session name changes");
		}
		// Startup may persist --name before runtime construction so validation
		// failures still retain it. Preserve the successful runtime notification
		// without appending the same durable fact a second time.
		if (this.sessionName !== normalizedName) this.harness.setSessionNameSync(normalizedName);
		for (const listener of this.sessionInfoSubscribers) listener({ type: "session_info_changed", name: normalizedName });
		this._extensionRunner.emitSessionInfoChanged({ type: "session_info_changed", name: normalizedName });
	}

	setSessionLabel(entryId: string, label: string | undefined): void {
		this.harness.setSessionLabelSync(entryId, label);
	}

	createReplacedSessionContext(): ReplacedSessionContext {
		const context = this._extensionRunner.createCommandContext() as ReplacedSessionContext;
		context.sendMessage = async (message, options) => {
			await this.sendCustomMessage(message, options);
		};
		context.sendUserMessage = async (content, options) => {
			await this.sendUserMessage(content, options);
		};
		return context;
	}

	get extensionRunner(): ExtensionRunner {
		return this._extensionRunner;
	}

	private applyExtensionBindings(bindings: ExtensionBindings): void {
		if (bindings.mode !== undefined) {
			this.promptSurface = bindings.mode === "tui"
				? "tui"
				: bindings.mode === "rpc"
					? "rpc"
					: bindings.mode === "json"
						? "headless"
						: "print";
		}
		if (bindings.uiContext !== undefined || bindings.mode !== undefined) this._extensionRunner.setUIContext(bindings.uiContext, bindings.mode);
		this._extensionRunner.bindCommandContext(bindings.commandContextActions);
		if (bindings.onError !== undefined) this._extensionRunner.onError(bindings.onError);
	}

	private async emitSessionStart(): Promise<void> {
		const startEvent = this._sessionStartEvent ?? { type: "session_start", reason: "startup" };
		this._sessionStartEvent = undefined;
		await this._extensionRunner.emit(startEvent);
	}

	private async waitForActivePromptTasks(): Promise<void> {
		while (this.activePromptTasks.size > 0) {
			await Promise.allSettled([...this.activePromptTasks]);
		}
	}

	/** Prepare fallible extension bindings without publishing lifecycle events. */
	async prepareExtensionBindings(bindings: ExtensionBindings): Promise<void> {
		this.applyExtensionBindings(bindings);
		await this.initializeExtensions();
	}

	/** Activate a prepared binding after its Session scope is current. */
	async activateExtensionBindings(): Promise<void> {
		const registeredBefore = new Set(
			this._extensionRunner.getAllRegisteredTools().map((tool) => tool.definition.name),
		);
		const activeBefore = this.harness.activeToolNamesSnapshot;
		await this.emitSessionStart();
		// session_start handlers may register tools. This refresh is lifecycle
		// activation work, not host binding preparation, so any failure is a
		// post-commit diagnostic during a transactional scope replacement.
		await this.initializeExtensions();
		const selectedTools = new Set(this.controlPlane.getToolNames());
		const newlyRegisteredTools = this._extensionRunner
			.getAllRegisteredTools()
			.map((tool) => tool.definition.name)
			.filter((name) => !registeredBefore.has(name) && selectedTools.has(name));
		if (newlyRegisteredTools.length > 0) {
			await this.controlPlane.whenCapabilitiesReady();
			await this.harness.setActiveTools([...new Set([...activeBefore, ...newlyRegisteredTools])]);
			this._systemPrompt = await this.harness.getSystemPrompt();
		}
		await this.waitForActivePromptTasks();
		await this.harness.waitForCompatibilityTasks();
	}

	async bindExtensions(bindings: ExtensionBindings): Promise<void> {
		await this.prepareExtensionBindings(bindings);
		await this.activateExtensionBindings();
	}

	getLastContextSnapshotId(): string | undefined {
		return this.sessionManager.getContextSnapshots().at(-1)?.id;
	}

	getContextSnapshotIdForRun(runId: string): string | undefined {
		return this.sessionManager.getContextSnapshots().filter((snapshot) => snapshot.runId === runId).at(-1)?.id;
	}

	private createContextSnapshot(): ContextSnapshot {
		const metadata = this.controlPlane.getCapabilityContextMetadata();
		const policyBindingId = this.getActiveExecutionPolicyBinding()?.id;
		const sources: ContextSourceReceipt[] = [];
		if (metadata.hasSkills) {
			sources.push({
				sourceId: "capability_index:skills",
				kind: "capability_index",
				scope: "project",
				trust: this.settingsManager.isProjectTrusted() ? "trusted_project" : "untrusted_project",
				contentDigest: digestContextContent("skills"),
				estimatedTokens: 0,
				disposition: "included",
				...(metadata.bindingId === undefined ? {} : { capabilityBindingId: metadata.bindingId }),
				...(policyBindingId === undefined ? {} : { policyBindingId }),
			});
		}
		for (const tool of metadata.tools) {
			const builtin = tool.kind === "builtin_tool";
			sources.push({
				sourceId: `capability:tool:${tool.name}`,
				kind: "capability_index",
				scope: builtin ? "global" : "session",
				trust: builtin ? "builtin" : "user_owned",
				contentDigest: digestContextContent(`${tool.id}@${tool.revision}`),
				estimatedTokens: 0,
				disposition: "included",
				capabilityId: tool.id,
				capabilityRevision: tool.revision,
				...(metadata.bindingId === undefined ? {} : { capabilityBindingId: metadata.bindingId }),
				...(policyBindingId === undefined ? {} : { policyBindingId }),
			});
		}
		const id = `context:${this.sessionId}:${metadata.bindingId ?? "unbound"}`;
		return {
			schemaVersion: 1,
			id,
			purpose: "agent_turn",
			sessionId: this.sessionId,
			createdAt: new Date().toISOString(),
			sources,
			budget: {
				contextWindow: this.model?.contextWindow ?? 0,
				reserveTokens: 0,
				inputLimit: this.model?.contextWindow ?? 0,
				estimatedInputTokens: 0,
			},
		};
	}

	async inspectContext(options?: { snapshotId?: string }): Promise<{
		snapshot: ContextSnapshot;
		drift: ContextSourceDrift[];
		preview: boolean;
	}> {
		await this.whenCapabilitiesReady();
		const stored = options?.snapshotId === undefined
			? this.sessionManager.getContextSnapshots().at(-1)
			: this.sessionManager.getContextSnapshot(options.snapshotId);
		if (stored !== undefined) return { snapshot: stored, drift: [], preview: false };
		const snapshot = this.createContextSnapshot();
		this.harness.recordCustomEntry(CONTEXT_SNAPSHOT_CUSTOM_TYPE, snapshot);
		return { snapshot, drift: [], preview: true };
	}

	async addContextMemory(input: {
		scope: ContextMemoryScope;
		text: string;
		sourceEntryIds?: string[];
	}): Promise<ContextMemory> {
		const settings = this.settingsManager.getMemorySettings();
		if (input.scope === "session" && !settings.sessionEnabled) {
			throw contextOperationError("context_memory_disabled", "Session memory is disabled");
		}
		if (input.scope === "project" && !settings.projectEnabled) {
			throw contextOperationError("context_memory_disabled", "Project memory is disabled");
		}
		return this.contextMemoryStore.add({
			scope: input.scope,
			text: input.text,
			sourceEntryIds: input.sourceEntryIds,
			sessionId: this.sessionId,
			projectRoot: this._cwd,
			appendSessionEntry: (customType, data) => this.harness.recordCustomEntry(customType, data),
		});
	}

	async listContextMemory(scope?: ContextMemoryScope): Promise<ContextMemory[]> {
		const scopes: ContextMemoryScope[] = scope === undefined ? ["session", "project"] : [scope];
		const entries = await this.canonicalSession.findEntries({
			type: "custom",
			customType: CONTEXT_MEMORY_CUSTOM_TYPE,
			order: "oldestFirst",
		});
		const sessionCustomEntries = entries
			.filter((entry): entry is Extract<Entry, { type: "custom" }> => entry.type === "custom")
			.map((entry) => ({ customType: entry.customType, data: entry.data }));
		const result: ContextMemory[] = [];
		for (const memoryScope of scopes) {
			const settings = this.settingsManager.getMemorySettings();
			if (memoryScope === "session" && !settings.sessionEnabled) continue;
			if (memoryScope === "project" && !settings.projectEnabled) continue;
			result.push(...await this.contextMemoryStore.list({
				scope: memoryScope,
				sessionId: this.sessionId,
				projectRoot: this._cwd,
				sessionCustomEntries,
			}));
		}
		return result;
	}

	async revokeContextMemory(input: { id: string; scope?: ContextMemoryScope }): Promise<void> {
		let scope = input.scope;
		if (scope === undefined) {
			const matches = (await this.listContextMemory()).filter((memory) => memory.id === input.id);
			if (matches.length !== 1) {
				throw contextOperationError(
					"context_memory_not_found",
					matches.length === 0 ? "Active context memory was not found" : "Context memory id is ambiguous",
				);
			}
			scope = matches[0]!.scope;
		}
		const settings = this.settingsManager.getMemorySettings();
		if (scope === "session" && !settings.sessionEnabled) {
			throw contextOperationError("context_memory_disabled", "Session memory is disabled");
		}
		if (scope === "project" && !settings.projectEnabled) {
			throw contextOperationError("context_memory_disabled", "Project memory is disabled");
		}
		await this.contextMemoryStore.revoke({
			id: input.id,
			scope,
			sessionId: this.sessionId,
			projectRoot: this._cwd,
			appendSessionEntry: (customType, data) => this.harness.recordCustomEntry(customType, data),
		});
	}

	async runExternalAgentPreflight(_runId?: string, _signal?: AbortSignal): Promise<void> {
		await this.controlPlane.whenCapabilitiesReady(_runId, _signal);
	}

	getCapabilityBindingId(): string | undefined {
		return this.getActiveCapabilityBinding()?.id;
	}

	async whenCapabilitiesReady(_policyRunId?: string, _signal?: AbortSignal): Promise<void> {
		await this.extensionToolsReady;
		if (this.controlPlane.getActiveCapabilityBinding() === undefined) this.controlPlane.synchronizeTools();
		await this.controlPlane.whenCapabilitiesReady(_policyRunId, _signal);
	}

	async setCapabilityProfile(_profileName?: string, _options?: { runId?: string }): Promise<void> {
		await this.harness.runWhenIdle(() => this.controlPlane.setCapabilityProfile(_profileName));
	}

	async approveCapability(_descriptorId: string): Promise<void> {
		await this.harness.runWhenIdle(() => this.controlPlane.approveCapability(_descriptorId));
	}

	async setExecutionPolicyProfile(_profileName?: string): Promise<void> {
		await this.controlPlane.setExecutionPolicyProfile(_profileName);
	}

	async startMcpAuth(_serverId: string, _serverUrl: string | URL, _options: MCPAuthStartOptions): Promise<MCPAuthStartResult> {
		return this.controlPlane.startMcpAuth(_serverId, _serverUrl, _options);
	}

	async startMcpOAuth(serverId: string, serverUrl: string | URL, options: MCPAuthStartOptions): Promise<MCPAuthStartResult> {
		return this.startMcpAuth(serverId, serverUrl, options);
	}

	async logoutMcpAuth(_serverId: string, _serverUrl?: string | URL): Promise<void> {
		return this.controlPlane.logoutMcpAuth(_serverId, _serverUrl);
	}

	async logoutMcp(serverId: string, serverUrl?: string | URL): Promise<void> {
		return this.logoutMcpAuth(serverId, serverUrl);
	}

	async getMcpAuthStatus(_serverId: string, _serverUrl: string | URL): Promise<MCPCredentialStatus | undefined> {
		return this.controlPlane.getMcpAuthStatus(_serverId, _serverUrl);
	}

	async listMcpCredentialStatuses(): Promise<readonly MCPCredentialStatus[]> {
		return this.controlPlane.listMcpCredentialStatuses();
	}

	async listMcpResources(
		_serverId: string,
		_params?: { cursor?: string },
		_signal?: AbortSignal,
	): Promise<MCPResourceListResult> {
		return this.controlPlane.listMcpResources(_serverId, _params, _signal);
	}

	async listMcpResourceTemplates(
		_serverId: string,
		_params?: { cursor?: string },
		_signal?: AbortSignal,
	): Promise<MCPResourceTemplateListResult> {
		return this.controlPlane.listMcpResourceTemplates(_serverId, _params, _signal);
	}

	async listMcpPrompts(
		_serverId: string,
		_params?: { cursor?: string },
		_signal?: AbortSignal,
	): Promise<MCPPromptListResult> {
		return this.controlPlane.listMcpPrompts(_serverId, _params, _signal);
	}

	async readMcpResource(_serverId: string, _uri: string, _signal?: AbortSignal): Promise<MCPReadResourceResult> {
		return this.controlPlane.readMcpResource(_serverId, _uri, _signal);
	}

	async getMcpPrompt(
		_serverId: string,
		_name: string,
		_args?: Record<string, string>,
		_signal?: AbortSignal,
	): Promise<MCPGetPromptResult> {
		return this.controlPlane.getMcpPrompt(_serverId, _name, _args, _signal);
	}

	async attachMcpResource(input: { serverId: string; uri: string; signal?: AbortSignal }): Promise<McpAttachment> {
		try {
			const result = await this.controlPlane.readMcpResource(input.serverId, input.uri, input.signal);
			this.controlPlane.authorizeMcpContentAttachment(input.serverId);
			const attachment = wrapMcpResourceAttachment(
				result,
				this.controlPlane.getMcpAttachmentBindingRefs("mcp_resource", input.serverId, result.resourceId),
			);
			if (attachment.attachableBlocks.length === 0) throw new MCPContentError("mcp_content_unsupported", input.serverId);
			let registered = this.mcpAttachmentRegistry.get(attachment.id);
			if (registered === undefined) {
				await this.persistMcpAttachment(attachment);
				registered = this.mcpAttachmentRegistry.attach(attachment);
			}
			this.recordMcpAttachmentAudit(input.serverId, registered);
			return registered;
		} catch (error) {
			this.controlPlane.recordMcpContentAudit({
				serverId: input.serverId,
				outcome: error instanceof Error && error.name === "AbortError" ? "cancelled" : "failed",
				reasonCode: mcpAuditReasonCode(error),
				capabilityBindingId: this.getCapabilityBindingId(),
				policyBindingId: this.getActiveExecutionPolicyBinding()?.id,
			});
			throw error;
		}
	}

	async attachMcpPrompt(input: { serverId: string; name: string; args?: Record<string, string>; signal?: AbortSignal }): Promise<McpAttachment> {
		try {
			const result = await this.controlPlane.getMcpPrompt(input.serverId, input.name, input.args, input.signal);
			this.controlPlane.authorizeMcpContentAttachment(input.serverId);
			const attachment = wrapMcpPromptAttachment(
				result,
				this.controlPlane.getMcpAttachmentBindingRefs("mcp_prompt", input.serverId, result.promptId),
			);
			if (attachment.attachableBlocks.length === 0) throw new MCPContentError("mcp_content_unsupported", input.serverId);
			let registered = this.mcpAttachmentRegistry.get(attachment.id);
			if (registered === undefined) {
				await this.persistMcpAttachment(attachment);
				registered = this.mcpAttachmentRegistry.attach(attachment);
			}
			this.recordMcpAttachmentAudit(input.serverId, registered);
			return registered;
		} catch (error) {
			this.controlPlane.recordMcpContentAudit({
				serverId: input.serverId,
				outcome: error instanceof Error && error.name === "AbortError" ? "cancelled" : "failed",
				reasonCode: mcpAuditReasonCode(error),
				capabilityBindingId: this.getCapabilityBindingId(),
				policyBindingId: this.getActiveExecutionPolicyBinding()?.id,
			});
			throw error;
		}
	}

	private async persistMcpAttachment(attachment: McpAttachment): Promise<void> {
		await this.harness.appendCustomEntry(MCP_ATTACHMENT_CUSTOM_TYPE, serializeMcpAttachmentRecord(attachment));
	}

	private recordMcpAttachmentAudit(serverId: string, attachment: McpAttachment): void {
		this.controlPlane.recordMcpContentAudit({
			serverId,
			outcome: "success",
			descriptorId: attachment.descriptorId,
			revision: attachment.descriptorRevision,
			provenanceId: attachment.sourceId,
			capabilityBindingId: attachment.capabilityBindingId,
			policyBindingId: attachment.policyBindingId,
			contentDigest: attachment.contentDigest,
			byteCount: attachment.byteCount,
			blockCount: attachment.blockCount,
			mimeTypes: attachment.mimeTypes,
		});
	}

	getActiveCapabilityBinding(): CapabilityBinding | undefined {
		return this.controlPlane.getActiveCapabilityBinding();
	}

	inspectCapabilityCatalog(): CapabilityCatalogView {
		return this.controlPlane.inspectCapabilityCatalog();
	}

	getActiveCapabilityProfile(): string {
		return this.controlPlane.getActiveCapabilityProfile();
	}

	setModelBrokerResolution(resolution: ModelResolution, previousModelBindingId?: string): void {
		this.controlPlane.setModelBrokerBindingId(resolution.bindingId);
		this.modelSelection.setSelection(resolution, previousModelBindingId);
		void this.harness.appendCustomEntry("__aos.foundation.model-resolution.v1", resolution);
	}

	get modelBrokerBindingId(): string | undefined {
		return this.controlPlane.getModelBrokerBindingId() ?? this.modelSelection.bindingId;
	}

	getActiveBindingHandles(): ReadonlyArray<BindingHandle> {
		return this.controlPlane.getActiveBindingHandles();
	}

	getExternalConnectorRegistry(): ExternalConnectorRegistry | undefined {
		return this.controlPlane.getExternalConnectorRegistry();
	}

	getWorkerRegistry():
		| Pick<WorkerSandboxProvider, "getWorkerRecord" | "listWorkerRecords" | "reclaimWorker">
		| undefined {
		if (this.controlPlane.getWorkerSandboxProvider() === undefined) return undefined;

		return {
			getWorkerRecord: (workerId) => this.controlPlane.getWorkerRecord(workerId),
			listWorkerRecords: () => this.controlPlane.listWorkerRecords(),
			reclaimWorker: async (workerId) => {
				const result = await this.controlPlane.reclaimWorker(workerId);
				if (result === undefined) throw new Error("Worker registry became unavailable");
				return result;
			},
		};
	}

	getSubagentRegistry(): Pick<SubagentComposition, "get" | "list" | "cancel"> | undefined {
		const subagents = this.controlPlane.getSubagentComposition();
		if (subagents === undefined) return undefined;
		return {
			get: (runId, childAgentInstanceId) => subagents.get(runId, childAgentInstanceId),
			list: (runId, filter) => subagents.list(runId, filter),
			cancel: (runId, childAgentInstanceId) => subagents.cancel(runId, childAgentInstanceId),
		};
	}

	getTaskCredentialService(): TaskCredentialService | undefined {
		return this.controlPlane.getTaskCredentialService();
	}

	getSchedulerStatus(): SchedulerSafeStatus | undefined {
		return this.controlPlane.getSchedulerStatus();
	}

	/**
	 * Narrow compatibility projection used by the RPC credential regression
	 * tests. The live sandbox remains owned by FoundationControlPlane; this
	 * method does not expose or duplicate its state.
	 */
	getActiveSandboxSessionForCompatibility(): { dispose(): Promise<void> } | undefined {
		return this.controlPlane.getSandboxSessionForCompatibility();
	}

	setAutoCompactionEnabled(enabled: boolean): void {
		this.settingsManager.setCompactionEnabled(enabled);
	}

	setAutoRetryEnabled(enabled: boolean): void {
		this.settingsManager.setRetryEnabled(enabled);
	}

	abortRetry(): void {
		void this.harness.abortRetry();
	}

	abortBash(): void {
		this.controlPlane.abortBash();
	}

	get isBashRunning(): boolean {
		return this.controlPlane.isBashRunning;
	}

	get hasPendingBashMessages(): boolean {
		return this.pendingExternalMessages.some((message) => message.role === "bashExecution");
	}

	async authorizeUserBashExtension(command: string, options?: { id?: string }): Promise<boolean> {
		return this.controlPlane.authorizeUserBash(command, options?.id);
	}

	async executeBash(
		command: string,
		onChunk?: (chunk: string) => void,
		options?: {
			excludeFromContext?: boolean;
			id?: string;
			operations?: BashOperations;
			signal?: AbortSignal;
			deadlineMs?: number;
		},
	): Promise<BashResult> {
		const result = await this.controlPlane.executeBash(command, (chunk) => {
			onChunk?.(chunk);
			this.harness.emitBashExecutionUpdate(options?.id, chunk);
		}, options);
		this.recordBashResult(command, result, options);
		return result;
	}

	recordBashResult(command: string, result: BashResult, options?: { excludeFromContext?: boolean }): void {
		const message: BashExecutionMessage = {
			role: "bashExecution",
			command,
			output: result.output,
			...(result.exitCode === undefined ? {} : { exitCode: result.exitCode }),
			cancelled: result.cancelled,
			truncated: result.truncated,
			...(result.fullOutputPath === undefined ? {} : { fullOutputPath: result.fullOutputPath }),
			...(options?.excludeFromContext === undefined ? {} : { excludeFromContext: options.excludeFromContext }),
			timestamp: Date.now(),
		};
		if (this.harness.isRunning) {
			this.pendingExternalMessages.push(message);
			return;
		}
		void this.harness.recordExternalMessage(message);
		this.compatibilityMessagesProjection = this.projectCompatibilityMessages(this.canonicalEntriesSnapshot());
	}

	getUserMessagesForForking(): Array<{ entryId: string; text: string }> {
		return this.canonicalEntriesSnapshot()
			.filter((entry): entry is Extract<typeof entry, { type: "message" }> => entry.type === "message" && entry.message.role === "user")
			.map((entry) => ({ entryId: entry.id, text: messageText(entry.message) }));
	}

	/**
	 * Materialize a fork from the canonical Session ledger. The compatibility
	 * SessionManager only supplies the legacy view; it must not clone its
	 * physical wrapper IDs or reconstruct a second transcript.
	 */
	async createForkedSessionTarget(
		entryId: string,
		position: "before" | "at",
		onTargetCreated?: (sessionFile: string | undefined) => void,
	): Promise<AgentSessionForkTarget> {
		await this.waitForIdle();
		const selectedEntry = await this.canonicalSession.getEntry(entryId);
		if (selectedEntry === undefined) throw new Error("Invalid entry ID for forking");

		let targetId: string | null;
		let selectedText: string | undefined;
		if (position === "at") {
			targetId = selectedEntry.id;
		} else {
			if (selectedEntry.type !== "message" || selectedEntry.message.role !== "user") {
				throw new Error("Invalid entry ID for forking");
			}
			targetId = selectedEntry.parentId;
			selectedText = messageText(selectedEntry.message);
		}

		const sourceSessionFile = this.sessionFile;
		if (this.sessionManager.isPersisted() && sourceSessionFile !== undefined && !existsSync(sourceSessionFile)) {
			throw new Error(
				"This session has not been saved yet. Wait for the first assistant response before cloning or forking it.",
			);
		}
		if (this.sessionManager.isPersisted() && sourceSessionFile === undefined) {
			throw new Error("Persisted session is missing a session file");
		}

		const targetManager = this.sessionManager.isPersisted()
			? SessionManager.create(this._cwd, this.sessionManager.getSessionDir(), {
					parentSession: sourceSessionFile,
				})
			: SessionManager.inMemory(this._cwd);
		const targetSessionFile = targetManager.getSessionFile();
		onTargetCreated?.(targetSessionFile);
		try {
			const targetStorage = new SessionManagerStorage(targetManager, { dlpScanner: this.storage.getDlpScanner() });
			const targetSession = new Session(targetStorage);
			const copiedEntries = targetId === null
				? []
				: await this.canonicalSession.findEntriesOnBranch({ start: targetId, order: "oldestFirst" });
			for (const entry of copiedEntries) {
				const { parentId: _parentId, seq: _seq, timestamp: _timestamp, ...provisioned } = entry;
				await targetSession.appendEntry(provisioned as ProvisionedEntry, "main");
			}

			const name = await this.canonicalSession.getName();
			if (name !== undefined) await targetSession.setName(name);
			for (const entry of copiedEntries) {
				const label = await this.canonicalSession.getLabel(entry.id);
				if (label !== undefined) await targetSession.setLabel(entry.id, label);
			}
			const target: AgentSessionForkTarget = {
				session: targetSession,
				sessionFile: targetSessionFile,
				...(selectedText === undefined ? {} : { selectedText }),
			};
			agentSessionForkManagers.set(target, targetManager);
			return target;
		} catch (error) {
			if (onTargetCreated !== undefined) throw error;
			try {
				if (targetSessionFile !== undefined && existsSync(targetSessionFile)) unlinkSync(targetSessionFile);
			} catch (cleanupError) {
				throw new AggregateError(
					[error, cleanupError],
					"Fork target creation failed and its candidate session artifact could not be removed",
				);
			}
			throw error;
		}
	}

	setPreviousExecutionPolicyBindingIdForNextRun(bindingId?: string): void {
		this.controlPlane.setPreviousExecutionPolicyBindingIdForNextRun(bindingId);
	}

	getActiveExecutionPolicyProfile(): string {
		return this.controlPlane.getActiveExecutionPolicyProfile();
	}

	getActiveExecutionPolicyBinding(): PolicyBinding | undefined {
		return this.controlPlane.getActiveExecutionPolicyBinding();
	}

	getActiveExecutionPolicySummary(): PublicPolicySummary {
		return this.controlPlane.getActiveExecutionPolicySummary();
	}

	getPendingExecutionPolicyApprovals(): ReadonlyArray<PolicyApprovalRequest> {
		return this.controlPlane.getPendingExecutionPolicyApprovals();
	}

	/** Legacy test projection; policy approval ownership stays in the control plane. */
	get _pendingExecutionPolicyApprovals(): Map<string, PolicyApprovalRequest> {
		return this.controlPlane.getPendingExecutionPolicyApprovalsMap();
	}

	approveExecutionPolicyRequest(_requestId: string, _source: PolicyApprovalSource = "interactive"): void {
		this.controlPlane.approveExecutionPolicyRequest(_requestId, _source);
	}

	rejectExecutionPolicyRequest(_requestId: string, _source: PolicyApprovalSource = "interactive"): void {
		this.controlPlane.rejectExecutionPolicyRequest(_requestId, _source);
	}

	resolveExecutionPolicyReview(
		_requestId: string,
		_reviewer: PolicyReviewerIdentity,
		_decision: PolicyReviewDecision,
		_resolvedAt: string,
		_source: PolicyApprovalSource = "system",
	): PolicyReviewEvidence {
		return this.controlPlane.resolveExecutionPolicyReview(
			_requestId,
			_reviewer,
			_decision,
			_resolvedAt,
			_source,
		);
	}

	getMcpConnectionStatus(_serverId: string): MCPConnectionStatus | undefined {
		return this.controlPlane.getMcpConnectionStatus(_serverId);
	}

	getMcpServerConfigView(_serverId: string): MCPServerConfigView | undefined {
		return this.controlPlane.getMcpServerConfigView(_serverId);
	}

	getMcpAuthManager(): MCPAuthManager | undefined {
		return this.controlPlane.getMcpAuthManager();
	}

	listMcpAttachments(): ReadonlyArray<McpAttachment> {
		return this.mcpAttachmentRegistry.list();
	}

	getMcpAttachment(attachmentId: string): McpAttachment | undefined {
		return this.mcpAttachmentRegistry.get(attachmentId);
	}

	detachMcpAttachment(attachmentId: string): boolean {
		if (this.mcpAttachmentRegistry.get(attachmentId) === undefined) return false;
		this.harness.recordCustomEntry(MCP_ATTACHMENT_CUSTOM_TYPE, createMcpAttachmentTombstone(attachmentId));
		return this.mcpAttachmentRegistry.detach(attachmentId);
	}

	clearMcpAttachments(): void {
		const attachments = this.mcpAttachmentRegistry.list();
		for (const attachment of attachments) {
			this.harness.recordCustomEntry(MCP_ATTACHMENT_CUSTOM_TYPE, createMcpAttachmentTombstone(attachment.id));
		}
		this.mcpAttachmentRegistry.clear();
	}

	cancelMcpContentOperations(): void {
		this.controlPlane.cancelMcpContentOperations();
	}

	async reload(options?: { beforeSessionStart?: () => void | Promise<void> }): Promise<void> {
		await this.waitForIdle();
		const previousExtensionsResult = this._resourceLoader.getExtensions();
		await this._resourceLoader.reload();
		const nextExtensionsResult = this._resourceLoader.getExtensions();
		const runtimeReplaced = nextExtensionsResult.runtime !== previousExtensionsResult.runtime;
		await options?.beforeSessionStart?.();
		await emitSessionShutdownEvent(
			this._extensionRunner,
			{ type: "session_shutdown", reason: "reload" },
		);
		if (runtimeReplaced) {
			// A resource loader may replace its result without sharing the runner's
			// previous runtime. Release the loader-owned generation as well so no
			// event-bus subscriptions survive a reload.
			previousExtensionsResult.runtime.invalidate();
			this._extensionRunner.replaceExtensions(nextExtensionsResult.extensions, nextExtensionsResult.runtime);
			await this.initializeExtensions();
		}
		await this.controlPlane.reload();
		const subagentRecovery = await this.controlPlane.getSubagentComposition()?.reload();
		if (subagentRecovery !== undefined && !subagentRecovery.ok) throw subagentRecovery.error;
		await this._extensionRunner.emit({ type: "session_start", reason: "reload" });
		await this.waitForActivePromptTasks();
		await this.harness.waitForCompatibilityTasks();
	}

	async exportToHtml(outputPath?: string): Promise<string> {
		return exportSessionToHtml(this.canonicalSession, this.state, outputPath);
	}

	async exportToJsonl(outputPath?: string): Promise<string> {
		const target = outputPath ?? this.sessionFile;
		if (target === undefined) throw new Error("Cannot export an in-memory session to JSONL");
		const metadata = await this.canonicalSession.getMetadata();
		const entries = await this.canonicalSession.findEntries({ order: "oldestFirst" });
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(
			target,
			`${[
				{
					type: "session",
					version: 3,
					id: metadata.id,
					timestamp: new Date(metadata.createdAt).toISOString(),
					cwd: this._cwd,
					...(metadata.parentSessionId === undefined ? {} : { parentSession: metadata.parentSessionId }),
				},
				...entries,
			].map((entry) => JSON.stringify(entry)).join("\n")}\n`,
			"utf8",
		);
		return target;
	}

	async dispose(): Promise<void> {
		if (this.disposePromise !== undefined) return this.disposePromise;
		this.disposed = true;
		this.disposePromise = this.disposeInternal();
		return this.disposePromise;
	}

	private async disposeInternal(): Promise<void> {
		try {
			this._extensionRunner.invalidate();
			await this.controlPlane.dispose();
			this.flushPendingExternalMessages();
			await this.harness.close();
			await this.storage.drain();
		} finally {
			await this.telemetryShutdown?.();
		}
	}
}

const COMPATIBILITY_FORWARDERS = [
	"agent",
	"agentRuntimeComposition",
	"sessionRead",
	"modelRuntime",
	"modelBroker",
	"modelBrokerConfigRevision",
	"resourceLoader",
	"cwd",
	"sessionFile",
	"sessionId",
	"sessionName",
	"state",
	"model",
	"thinkingLevel",
	"isStreaming",
	"isIdle",
	"systemPrompt",
	"retryAttempt",
	"getActiveToolNames",
	"messages",
	"steeringMode",
	"followUpMode",
	"scopedModels",
	"promptTemplates",
	"skills",
	"pendingMessageCount",
	"isCompacting",
	"isRetrying",
	"autoRetryEnabled",
	"autoCompactionEnabled",
	"extensionRunner",
	"modelBrokerBindingId",
	"isBashRunning",
	"hasPendingBashMessages",
	"_pendingExecutionPolicyApprovals",
	"initializeExtensions",
	"subscribe",
	"prompt",
	"resume",
	"abort",
	"waitForIdle",
	"waitForDispose",
	"steer",
	"followUp",
	"sendUserMessage",
	"sendCustomMessage",
	"clearQueue",
	"getSteeringMessages",
	"getFollowUpMessages",
	"compact",
	"abortCompaction",
	"abortBranchSummary",
	"navigateTree",
	"setScopedModels",
	"setModel",
	"setThinkingLevel",
	"getAvailableThinkingLevels",
	"supportsThinking",
	"cycleThinkingLevel",
	"cycleModel",
	"setSteeringMode",
	"setFollowUpMode",
	"setActiveToolsByName",
	"getAllTools",
	"getToolDefinition",
	"getSessionStats",
	"getContextUsage",
	"getLastAssistantText",
	"setSessionName",
	"setSessionLabel",
	"createReplacedSessionContext",
	"prepareExtensionBindings",
	"activateExtensionBindings",
	"bindExtensions",
	"getLastContextSnapshotId",
	"getContextSnapshotIdForRun",
	"inspectContext",
	"addContextMemory",
	"listContextMemory",
	"revokeContextMemory",
	"runExternalAgentPreflight",
	"getCapabilityBindingId",
	"whenCapabilitiesReady",
	"setCapabilityProfile",
	"approveCapability",
	"setExecutionPolicyProfile",
	"startMcpAuth",
	"startMcpOAuth",
	"logoutMcpAuth",
	"logoutMcp",
	"getMcpAuthStatus",
	"listMcpCredentialStatuses",
	"listMcpResources",
	"listMcpResourceTemplates",
	"listMcpPrompts",
	"readMcpResource",
	"getMcpPrompt",
	"attachMcpResource",
	"attachMcpPrompt",
	"getActiveCapabilityBinding",
	"inspectCapabilityCatalog",
	"getActiveCapabilityProfile",
	"setModelBrokerResolution",
	"getActiveBindingHandles",
	"getExternalConnectorRegistry",
	"getWorkerRegistry",
	"getSubagentRegistry",
	"getTaskCredentialService",
	"getSchedulerStatus",
	"getActiveSandboxSessionForCompatibility",
	"setAutoCompactionEnabled",
	"setAutoRetryEnabled",
	"abortRetry",
	"abortBash",
	"authorizeUserBashExtension",
	"executeBash",
	"recordBashResult",
	"getUserMessagesForForking",
	"setPreviousExecutionPolicyBindingIdForNextRun",
	"getActiveExecutionPolicyProfile",
	"getActiveExecutionPolicyBinding",
	"getActiveExecutionPolicySummary",
	"getPendingExecutionPolicyApprovals",
	"approveExecutionPolicyRequest",
	"rejectExecutionPolicyRequest",
	"resolveExecutionPolicyReview",
	"getMcpConnectionStatus",
	"getMcpServerConfigView",
	"getMcpAuthManager",
	"listMcpAttachments",
	"getMcpAttachment",
	"detachMcpAttachment",
	"clearMcpAttachments",
	"cancelMcpContentOperations",
	"exportToHtml",
	"exportToJsonl",
	"dispose",
] as const;

function installCompatibilityForwarders(
	target: object,
): void {
	const delegateFor = (receiver: object): CanonicalAgentSessionServices => {
		const delegate = Reflect.get(receiver, "delegate");
		if (!(delegate instanceof CanonicalAgentSessionServices)) {
			throw new Error("AgentSession compatibility facade is not bound to canonical services");
		}
		return delegate;
	};
	for (const name of ["settingsManager"] as const) {
		Object.defineProperty(target, name, {
			configurable: true,
			enumerable: false,
			get: function (this: object) {
				return Reflect.get(delegateFor(this), name);
			},
		});
	}
	for (const name of COMPATIBILITY_FORWARDERS) {
		const descriptor = Object.getOwnPropertyDescriptor(CanonicalAgentSessionServices.prototype, name);
		if (descriptor === undefined) {
			throw new Error(`Canonical AgentSession service member is missing: ${name}`);
		}
		if (descriptor.get !== undefined || descriptor.set !== undefined) {
			Object.defineProperty(target, name, {
				configurable: true,
				enumerable: false,
				get: descriptor.get === undefined ? undefined : function (this: object) {
					return descriptor.get?.call(delegateFor(this));
				},
				set: descriptor.set === undefined ? undefined : function (this: object, value: unknown) {
					descriptor.set?.call(delegateFor(this), value);
				},
			});
			continue;
		}
		if (typeof descriptor.value !== "function") {
			throw new Error(`Canonical AgentSession service member is not callable: ${name}`);
		}
		Object.defineProperty(target, name, {
			configurable: true,
			enumerable: false,
			writable: true,
			value: function (this: object, ...args: unknown[]) {
				return Reflect.apply(descriptor.value, delegateFor(this), args);
			},
		});
	}
	Object.defineProperty(target, "_extensionRunner", {
		configurable: true,
		enumerable: false,
		get: function (this: object) {
			return delegateFor(this).getCompatibilityExtensionRunner();
		},
		set: function (this: object, value: unknown) {
			delegateFor(this).setCompatibilityExtensionRunner(value as ExtensionRunner);
		},
	});
	Object.defineProperty(target, "_emitExtensionEvent", {
		configurable: true,
		enumerable: false,
		get: function (this: object) {
			return delegateFor(this).getCompatibilityEventEmitter();
		},
		set: function (this: object, value: unknown) {
			delegateFor(this).setCompatibilityEventEmitter(value as (event: AgentEvent) => Promise<AgentEvent | undefined>);
		},
	});
}

const agentSessionDelegates = new WeakMap<AgentSession, CanonicalAgentSessionServices>();
const agentSessionRuntimeReloads = new WeakMap<
	AgentSession,
	(options?: { beforeSessionStart?: () => void | Promise<void> }) => Promise<void>
>();

/** @internal Return the Session whose extension command initiated the current async call chain. */
export function getAgentSessionTransitionOrigin(): AgentSession | undefined {
	return extensionCommandTransitionOrigin.getStore();
}

export class AgentSession {
	private readonly delegate: CanonicalAgentSessionServices;
	declare readonly settingsManager: CanonicalAgentSessionServices["settingsManager"];
	declare readonly agent: CanonicalAgentSessionServices["agent"];
	declare readonly agentRuntimeComposition: CanonicalAgentSessionServices["agentRuntimeComposition"];
	declare readonly sessionRead: CanonicalAgentSessionServices["sessionRead"];
	declare readonly modelRuntime: CanonicalAgentSessionServices["modelRuntime"];
	declare readonly modelBroker: CanonicalAgentSessionServices["modelBroker"];
	declare readonly modelBrokerConfigRevision: CanonicalAgentSessionServices["modelBrokerConfigRevision"];
	declare readonly resourceLoader: CanonicalAgentSessionServices["resourceLoader"];
	declare readonly cwd: CanonicalAgentSessionServices["cwd"];
	declare readonly sessionFile: CanonicalAgentSessionServices["sessionFile"];
	declare readonly sessionId: CanonicalAgentSessionServices["sessionId"];
	declare readonly sessionName: CanonicalAgentSessionServices["sessionName"];
	declare readonly state: CanonicalAgentSessionServices["state"];
	declare readonly model: CanonicalAgentSessionServices["model"];
	declare readonly thinkingLevel: CanonicalAgentSessionServices["thinkingLevel"];
	declare readonly isStreaming: CanonicalAgentSessionServices["isStreaming"];
	declare readonly isIdle: CanonicalAgentSessionServices["isIdle"];
	declare readonly systemPrompt: CanonicalAgentSessionServices["systemPrompt"];
	declare readonly retryAttempt: CanonicalAgentSessionServices["retryAttempt"];
	declare readonly getActiveToolNames: CanonicalAgentSessionServices["getActiveToolNames"];
	declare readonly messages: CanonicalAgentSessionServices["messages"];
	declare readonly steeringMode: CanonicalAgentSessionServices["steeringMode"];
	declare readonly followUpMode: CanonicalAgentSessionServices["followUpMode"];
	declare readonly scopedModels: CanonicalAgentSessionServices["scopedModels"];
	declare readonly promptTemplates: CanonicalAgentSessionServices["promptTemplates"];
	declare readonly skills: CanonicalAgentSessionServices["skills"];
	declare readonly pendingMessageCount: CanonicalAgentSessionServices["pendingMessageCount"];
	declare readonly isCompacting: CanonicalAgentSessionServices["isCompacting"];
	declare readonly isRetrying: CanonicalAgentSessionServices["isRetrying"];
	declare readonly autoRetryEnabled: CanonicalAgentSessionServices["autoRetryEnabled"];
	declare readonly autoCompactionEnabled: CanonicalAgentSessionServices["autoCompactionEnabled"];
	declare readonly extensionRunner: CanonicalAgentSessionServices["extensionRunner"];
	declare readonly modelBrokerBindingId: CanonicalAgentSessionServices["modelBrokerBindingId"];
	declare readonly isBashRunning: CanonicalAgentSessionServices["isBashRunning"];
	declare readonly hasPendingBashMessages: CanonicalAgentSessionServices["hasPendingBashMessages"];
	declare readonly _pendingExecutionPolicyApprovals: CanonicalAgentSessionServices["_pendingExecutionPolicyApprovals"];
	declare readonly initializeExtensions: CanonicalAgentSessionServices["initializeExtensions"];
	declare readonly subscribe: CanonicalAgentSessionServices["subscribe"];
	declare readonly prompt: CanonicalAgentSessionServices["prompt"];
	declare readonly resume: CanonicalAgentSessionServices["resume"];
	declare readonly abort: CanonicalAgentSessionServices["abort"];
	declare readonly waitForIdle: CanonicalAgentSessionServices["waitForIdle"];
	declare readonly waitForDispose: CanonicalAgentSessionServices["waitForDispose"];
	declare readonly steer: CanonicalAgentSessionServices["steer"];
	declare readonly followUp: CanonicalAgentSessionServices["followUp"];
	declare readonly sendUserMessage: CanonicalAgentSessionServices["sendUserMessage"];
	declare readonly sendCustomMessage: CanonicalAgentSessionServices["sendCustomMessage"];
	declare readonly clearQueue: CanonicalAgentSessionServices["clearQueue"];
	declare readonly getSteeringMessages: CanonicalAgentSessionServices["getSteeringMessages"];
	declare readonly getFollowUpMessages: CanonicalAgentSessionServices["getFollowUpMessages"];
	declare readonly compact: CanonicalAgentSessionServices["compact"];
	declare _extensionRunner: ExtensionRunner;
	declare _emitExtensionEvent: (event: AgentEvent) => Promise<AgentEvent | undefined>;
	declare readonly abortCompaction: CanonicalAgentSessionServices["abortCompaction"];
	declare readonly abortBranchSummary: CanonicalAgentSessionServices["abortBranchSummary"];
	declare readonly navigateTree: CanonicalAgentSessionServices["navigateTree"];
	declare readonly setScopedModels: CanonicalAgentSessionServices["setScopedModels"];
	declare readonly setModel: CanonicalAgentSessionServices["setModel"];
	declare readonly setThinkingLevel: CanonicalAgentSessionServices["setThinkingLevel"];
	declare readonly getAvailableThinkingLevels: CanonicalAgentSessionServices["getAvailableThinkingLevels"];
	declare readonly supportsThinking: CanonicalAgentSessionServices["supportsThinking"];
	declare readonly cycleThinkingLevel: CanonicalAgentSessionServices["cycleThinkingLevel"];
	declare readonly cycleModel: CanonicalAgentSessionServices["cycleModel"];
	declare readonly setSteeringMode: CanonicalAgentSessionServices["setSteeringMode"];
	declare readonly setFollowUpMode: CanonicalAgentSessionServices["setFollowUpMode"];
	declare readonly setActiveToolsByName: CanonicalAgentSessionServices["setActiveToolsByName"];
	declare readonly getAllTools: CanonicalAgentSessionServices["getAllTools"];
	declare readonly getToolDefinition: CanonicalAgentSessionServices["getToolDefinition"];
	declare readonly getSessionStats: CanonicalAgentSessionServices["getSessionStats"];
	declare readonly getContextUsage: CanonicalAgentSessionServices["getContextUsage"];
	declare readonly getLastAssistantText: CanonicalAgentSessionServices["getLastAssistantText"];
	declare readonly setSessionName: CanonicalAgentSessionServices["setSessionName"];
	declare readonly setSessionLabel: CanonicalAgentSessionServices["setSessionLabel"];
	declare readonly createReplacedSessionContext: CanonicalAgentSessionServices["createReplacedSessionContext"];
	declare readonly prepareExtensionBindings: CanonicalAgentSessionServices["prepareExtensionBindings"];
	declare readonly activateExtensionBindings: CanonicalAgentSessionServices["activateExtensionBindings"];
	declare readonly bindExtensions: CanonicalAgentSessionServices["bindExtensions"];
	declare readonly getLastContextSnapshotId: CanonicalAgentSessionServices["getLastContextSnapshotId"];
	declare readonly getContextSnapshotIdForRun: CanonicalAgentSessionServices["getContextSnapshotIdForRun"];
	declare readonly inspectContext: CanonicalAgentSessionServices["inspectContext"];
	declare readonly addContextMemory: CanonicalAgentSessionServices["addContextMemory"];
	declare readonly listContextMemory: CanonicalAgentSessionServices["listContextMemory"];
	declare readonly revokeContextMemory: CanonicalAgentSessionServices["revokeContextMemory"];
	declare readonly runExternalAgentPreflight: CanonicalAgentSessionServices["runExternalAgentPreflight"];
	declare readonly getCapabilityBindingId: CanonicalAgentSessionServices["getCapabilityBindingId"];
	declare readonly whenCapabilitiesReady: CanonicalAgentSessionServices["whenCapabilitiesReady"];
	declare readonly setCapabilityProfile: CanonicalAgentSessionServices["setCapabilityProfile"];
	declare readonly approveCapability: CanonicalAgentSessionServices["approveCapability"];
	declare readonly setExecutionPolicyProfile: CanonicalAgentSessionServices["setExecutionPolicyProfile"];
	declare readonly startMcpAuth: CanonicalAgentSessionServices["startMcpAuth"];
	declare readonly startMcpOAuth: CanonicalAgentSessionServices["startMcpOAuth"];
	declare readonly logoutMcpAuth: CanonicalAgentSessionServices["logoutMcpAuth"];
	declare readonly logoutMcp: CanonicalAgentSessionServices["logoutMcp"];
	declare readonly getMcpAuthStatus: CanonicalAgentSessionServices["getMcpAuthStatus"];
	declare readonly listMcpCredentialStatuses: CanonicalAgentSessionServices["listMcpCredentialStatuses"];
	declare readonly listMcpResources: CanonicalAgentSessionServices["listMcpResources"];
	declare readonly listMcpResourceTemplates: CanonicalAgentSessionServices["listMcpResourceTemplates"];
	declare readonly listMcpPrompts: CanonicalAgentSessionServices["listMcpPrompts"];
	declare readonly readMcpResource: CanonicalAgentSessionServices["readMcpResource"];
	declare readonly getMcpPrompt: CanonicalAgentSessionServices["getMcpPrompt"];
	declare readonly attachMcpResource: CanonicalAgentSessionServices["attachMcpResource"];
	declare readonly attachMcpPrompt: CanonicalAgentSessionServices["attachMcpPrompt"];
	declare readonly getActiveCapabilityBinding: CanonicalAgentSessionServices["getActiveCapabilityBinding"];
	declare readonly inspectCapabilityCatalog: CanonicalAgentSessionServices["inspectCapabilityCatalog"];
	declare readonly getActiveCapabilityProfile: CanonicalAgentSessionServices["getActiveCapabilityProfile"];
	declare readonly setModelBrokerResolution: CanonicalAgentSessionServices["setModelBrokerResolution"];
	declare readonly getActiveBindingHandles: CanonicalAgentSessionServices["getActiveBindingHandles"];
	declare readonly getExternalConnectorRegistry: CanonicalAgentSessionServices["getExternalConnectorRegistry"];
	declare readonly getWorkerRegistry: CanonicalAgentSessionServices["getWorkerRegistry"];
	declare readonly getSubagentRegistry: CanonicalAgentSessionServices["getSubagentRegistry"];
	declare readonly getTaskCredentialService: CanonicalAgentSessionServices["getTaskCredentialService"];
	declare readonly getSchedulerStatus: CanonicalAgentSessionServices["getSchedulerStatus"];
	declare readonly getActiveSandboxSessionForCompatibility: CanonicalAgentSessionServices["getActiveSandboxSessionForCompatibility"];
	declare readonly setAutoCompactionEnabled: CanonicalAgentSessionServices["setAutoCompactionEnabled"];
	declare readonly setAutoRetryEnabled: CanonicalAgentSessionServices["setAutoRetryEnabled"];
	declare readonly abortRetry: CanonicalAgentSessionServices["abortRetry"];
	declare readonly abortBash: CanonicalAgentSessionServices["abortBash"];
	declare readonly authorizeUserBashExtension: CanonicalAgentSessionServices["authorizeUserBashExtension"];
	declare readonly executeBash: CanonicalAgentSessionServices["executeBash"];
	declare readonly recordBashResult: CanonicalAgentSessionServices["recordBashResult"];
	declare readonly getUserMessagesForForking: CanonicalAgentSessionServices["getUserMessagesForForking"];
	declare readonly setPreviousExecutionPolicyBindingIdForNextRun: CanonicalAgentSessionServices["setPreviousExecutionPolicyBindingIdForNextRun"];
	declare readonly getActiveExecutionPolicyProfile: CanonicalAgentSessionServices["getActiveExecutionPolicyProfile"];
	declare readonly getActiveExecutionPolicyBinding: CanonicalAgentSessionServices["getActiveExecutionPolicyBinding"];
	declare readonly getActiveExecutionPolicySummary: CanonicalAgentSessionServices["getActiveExecutionPolicySummary"];
	declare readonly getPendingExecutionPolicyApprovals: CanonicalAgentSessionServices["getPendingExecutionPolicyApprovals"];
	declare readonly approveExecutionPolicyRequest: CanonicalAgentSessionServices["approveExecutionPolicyRequest"];
	declare readonly rejectExecutionPolicyRequest: CanonicalAgentSessionServices["rejectExecutionPolicyRequest"];
	declare readonly resolveExecutionPolicyReview: CanonicalAgentSessionServices["resolveExecutionPolicyReview"];
	declare readonly getMcpConnectionStatus: CanonicalAgentSessionServices["getMcpConnectionStatus"];
	declare readonly getMcpServerConfigView: CanonicalAgentSessionServices["getMcpServerConfigView"];
	declare readonly getMcpAuthManager: CanonicalAgentSessionServices["getMcpAuthManager"];
	declare readonly listMcpAttachments: CanonicalAgentSessionServices["listMcpAttachments"];
	declare readonly getMcpAttachment: CanonicalAgentSessionServices["getMcpAttachment"];
	declare readonly detachMcpAttachment: CanonicalAgentSessionServices["detachMcpAttachment"];
	declare readonly clearMcpAttachments: CanonicalAgentSessionServices["clearMcpAttachments"];
	declare readonly cancelMcpContentOperations: CanonicalAgentSessionServices["cancelMcpContentOperations"];
	declare readonly exportToHtml: CanonicalAgentSessionServices["exportToHtml"];
	declare readonly exportToJsonl: CanonicalAgentSessionServices["exportToJsonl"];
	declare readonly dispose: CanonicalAgentSessionServices["dispose"];

	constructor(delegate: CanonicalAgentSessionServices | AgentSessionConfig) {
		this.delegate = delegate instanceof CanonicalAgentSessionServices ? delegate : new CanonicalAgentSessionServices(delegate);
		if (!(this.delegate instanceof CanonicalAgentSessionServices)) {
			throw new Error("AgentSession compatibility facade requires canonical services");
		}
		agentSessionDelegates.set(this, this.delegate);
		this.delegate.bindCompatibilityFacade(this);
	}

	async _checkCompaction(
		assistantMessage: Parameters<AgentHarness["checkCompaction"]>[0],
		skipAbortedCheck = true,
	): Promise<boolean> {
		return this.delegate._checkCompaction(
			assistantMessage,
			skipAbortedCheck,
			(reason, willRetry) => this._runAutoCompaction(reason, willRetry),
		);
	}

	_runAutoCompaction(reason: "overflow" | "threshold", willRetry: boolean): Promise<boolean> {
		return this.delegate._runAutoCompaction(reason, willRetry);
	}

	async reload(options?: { beforeSessionStart?: () => void | Promise<void> }): Promise<void> {
		const runtimeReload = agentSessionRuntimeReloads.get(this);
		if (runtimeReload !== undefined) return runtimeReload(options);
		return this.delegate.reload(options);
	}
}

/** @internal Route public reload through the owning runtime transaction. */
export function bindAgentSessionRuntimeReload(
	session: AgentSession,
	reload: (options?: { beforeSessionStart?: () => void | Promise<void> }) => Promise<void>,
): void {
	agentSessionRuntimeReloads.set(session, reload);
}

/** @internal Stop new prompt admission before the one-pointer commit. */
export function pauseAgentSessionAdmission(session: AgentSession): void {
	const delegate = agentSessionDelegates.get(session);
	if (delegate === undefined) throw new Error("AgentSession is not bound to canonical services");
	delegate.pauseAdmission();
}

/** @internal Drain work already accepted by the canonical agent and storage pipeline. */
export async function drainAgentSessionWrites(session: AgentSession): Promise<void> {
	const delegate = agentSessionDelegates.get(session);
	if (delegate === undefined) throw new Error("AgentSession is not bound to canonical services");
	await delegate.drainAcceptedWrites();
}

/** @internal Restore admission when a candidate fails before publication. */
export function resumeAgentSessionAdmission(session: AgentSession): void {
	const delegate = agentSessionDelegates.get(session);
	if (delegate === undefined) throw new Error("AgentSession is not bound to canonical services");
	delegate.resumeAdmission();
}

/** @internal Materialize a canonical fork without exposing its physical runtime target. */
export function createAgentSessionForkTarget(
	session: AgentSession,
	entryId: string,
	position: "before" | "at",
	onTargetCreated?: (sessionFile: string | undefined) => void,
): Promise<AgentSessionForkTarget> {
	const delegate = agentSessionDelegates.get(session);
	if (delegate === undefined) throw new Error("AgentSession is not bound to canonical services");
	return delegate.createForkedSessionTarget(entryId, position, onTargetCreated);
}

/** @internal Consume the physical store behind a canonical fork target. */
export function useAgentSessionForkTarget<TValue>(
	target: AgentSessionForkTarget,
	use: (sessionManager: SessionManager) => Promise<TValue>,
): Promise<TValue> {
	const sessionManager = agentSessionForkManagers.get(target);
	if (sessionManager === undefined) throw new Error("AgentSession fork target is not bound to a physical store");
	return use(sessionManager);
}

/** @internal Return a read/append adapter whose append path is AgentHarness. */
export function getAgentSessionLedger(session: AgentSession): AgentSessionLedgerProjection {
	const delegate = agentSessionDelegates.get(session);
	if (delegate === undefined) throw new Error("AgentSession is not bound to canonical services");
	return delegate.sessionLedger;
}

/** @internal Return the canonical Session without exposing its physical store. */
export function getAgentCanonicalSession(session: AgentSession): Session<CodingAgentSessionMetadata> {
	const delegate = agentSessionDelegates.get(session);
	if (delegate === undefined) throw new Error("AgentSession is not bound to canonical services");
	return delegate.canonicalSession;
}

/** @internal Persist SDK bootstrap facts after canonical composition exists. */
export async function recordInitialAgentSessionConfiguration(
	session: AgentSession,
	model: Model<Api> | undefined,
	thinkingLevel: ThinkingLevel,
	includeModel: boolean,
): Promise<void> {
	const delegate = agentSessionDelegates.get(session);
	if (delegate === undefined) throw new Error("AgentSession is not bound to canonical services");
	await delegate.recordInitialSessionConfiguration(model, thinkingLevel, includeModel);
}

installCompatibilityForwarders(AgentSession.prototype);

/**
 * Compose the stateful coding-agent services before exposing the compatibility
 * facade. The facade constructor accepts only this already-created delegate;
 * it is never a composition root and cannot create a second runtime authority.
 */
export function createAgentSessionDelegate(options: CanonicalAgentSessionOptions): CanonicalAgentSessionServices {
	return new CanonicalAgentSessionServices(options);
}

/**
 * Explicit legacy adapter for tests and integrations that still provide the
 * pre-Foundation AgentSessionConfig shape. Production entry points use
 * createAgentSessionDelegate directly from their composition root.
 */
export function createLegacyAgentSession(options: AgentSessionConfig): AgentSession {
	return new AgentSession(options);
}

/** Create one Session from the unified trusted runtime composition root. */
export function createAgentSessionWithRuntimeComposition(
	options: AgentSessionConfig,
	runtimeComposition: AgentRuntimeCompositionFactory,
): AgentSession {
	if (options.runtimeComposition !== undefined && options.runtimeComposition !== runtimeComposition) {
		throw new TypeError("AgentSession accepts one runtime composition factory");
	}
	return new AgentSession({ ...options, runtimeComposition });
}
