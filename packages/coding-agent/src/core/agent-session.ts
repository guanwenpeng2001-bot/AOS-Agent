/**
 * AgentSession - Core abstraction for agent lifecycle and session management.
 *
 * This class is shared between all run modes (interactive, print, rpc).
 * It encapsulates:
 * - Agent state access
 * - Event subscription with automatic session persistence
 * - Model and thinking level management
 * - Compaction (manual and auto)
 * - Bash execution
 * - Session switching and branching
 *
 * Modes use this class and add their own I/O layer on top.
 */

import { randomUUID, createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import type {
	Agent,
	AgentEvent,
	AgentMessage,
	AgentState,
	AgentTool,
	PrepareNextTurnContext,
	StreamFn,
	ThinkingLevel,
} from "@aos-agent/agent-core";
import {
	type ThinkingLevel as AiThinkingLevel,
	type AuthInteraction,
	contentText,
	createAssistantMessageEventStream,
	type Tool,
} from "@aos-agent/ai";
import type {
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	AuthResult,
	Context,
	ImageContent,
	Model,
	ProviderHeaders,
	TextContent,
	Usage,
} from "@aos-agent/ai/compat";
import {
	clampThinkingLevel,
	cleanupSessionResources,
	getSupportedThinkingLevels,
	isContextOverflow,
	isRecoverableLength,
	modelsAreEqual,
	type RetryCallbacks,
	resetApiProviders,
	streamSimple,
} from "@aos-agent/ai/compat";
import { getThemeByName, theme } from "../modes/interactive/theme/theme.ts";
import { stripFrontmatter } from "../utils/frontmatter.ts";
import { resolvePath } from "../utils/paths.ts";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport";
import type { ExternalAgentEvent } from "./external-agent-adapter.ts";
import type { ExternalAgentAdapterRegistry } from "./external-agent-registry.ts";
import { getShellEnv } from "../utils/shell.ts";
import { sleep } from "../utils/sleep.ts";
import { normalizeToolResultImages } from "../utils/tool-result-images.ts";
import { formatNoApiKeyFoundMessage, formatNoModelSelectedMessage } from "./auth-guidance.ts";
import type { BindingHandle } from "./binding-handles.ts";
import { type BashResult, executeBashWithOperations } from "./bash-executor.ts";
import {
	type CapabilityBinding,
	type CapabilityCandidate,
	type CapabilityCatalog,
	type CapabilityCatalogView,
	CapabilityError,
	CapabilityNameConflictError,
	CapabilityProfileNotFoundError,
	CapabilityRegistry,
	getCapabilityLocalName,
	matchesCapabilityDescriptorId,
	type ResolveBindingInput,
	resolveCapabilityBinding,
	toCapabilityBindingHandle,
} from "./capability-registry.ts";
import {
	type CapabilitySettings,
	createMcpServerCapabilityCandidate,
	type McpServerDiagnostic,
} from "./capability-settings.ts";
import type { BranchSummaryDetails } from "./compaction/branch-summarization.ts";
import type { CompactionDetails } from "./compaction/compaction.ts";
import {
	type CompactionResult,
	calculateContextTokens,
	collectEntriesForBranchSummary,
	compact,
	estimateContextTokens,
	estimateTokens,
	generateBranchSummary,
	prepareCompaction,
	shouldCompact,
} from "./compaction/index.ts";
import {
	CONTEXT_SNAPSHOT_CUSTOM_TYPE,
	type ContextError,
	type ContextPlan,
	type ContextPurpose,
	type ContextSnapshot,
	type ContextSourceDrift,
	type ContextSourceInput,
	compareContextSources,
	createContextError,
	createContextExtensionSourceInput,
	freezeContext,
	resolveContext,
} from "./context-engine.ts";
import {
	type ContextMemory,
	type ContextMemoryScope,
	ContextMemoryStore,
	memoryToContextSourceInputs,
} from "./context-memory-store.ts";
import { DEFAULT_THINKING_LEVEL } from "./defaults.ts";
import { type ExecOptions, type ExecResult, execCommand } from "./exec.ts";
import { type ExecutionAssociationRecord, persistExecutionAssociation } from "./execution-association.ts";
import {
	classifyAssistantFailure,
	classifyProviderFailure,
	type ExecutionErrorClassification,
} from "./execution-error.ts";
import {
	authorizePolicyOperation,
	createWorkspaceIdentity,
	type ExecutionPolicyProfile,
	type PolicyApprovalOutcome,
	type PolicyApprovalRequest,
	type PolicyApprovalSource,
	type PolicyBinding,
	type PolicyDecision,
	PolicyError,
	type PolicyOperationRequest,
	type PolicyOperationSource,
	type PublicPolicySummary,
	resolveExecutionPolicyProfile,
	toPublicPolicySummary,
	toPolicyBindingHandle,
} from "./execution-policy.ts";
import { createExecutionPolicyLedger } from "./execution-policy-ledger.ts";
import { exportSessionToHtml, type ToolHtmlRenderer } from "./export-html/index.ts";
import { createToolHtmlRenderer } from "./export-html/tool-renderer.ts";
import {
	type ContextExtensionContributionAttribution,
	type ContextUsage,
	type Extension,
	type ExtensionCommandContextActions,
	type ExtensionErrorListener,
	type ExtensionMode,
	ExtensionRunner,
	type ExtensionUIContext,
	type InputSource,
	type MessageEndEvent,
	type MessageStartEvent,
	type MessageUpdateEvent,
	type ReplacedSessionContext,
	type SessionBeforeCompactResult,
	type SessionBeforeTreeResult,
	type SessionStartEvent,
	type ShutdownHandler,
	type ToolDefinition,
	type ToolExecutionEndEvent,
	type ToolExecutionStartEvent,
	type ToolExecutionUpdateEvent,
	type ToolInfo,
	type TreePreparation,
	type TurnEndEvent,
	type TurnStartEvent,
	wrapRegisteredTools,
} from "./extensions/index.ts";
import { emitSessionShutdownEvent } from "./extensions/runner.ts";
import {
	MCPAuthError,
	MCPAuthProvider,
	type MCPAuthContext,
	type MCPAuthOptions,
	type MCPAuthResult,
	type MCPAuthStatus,
	type MCPAuthStore,
} from "./mcp-auth.ts";
import {
	MCPCredentialNamespace,
	type MCPCredentialBinding,
	type MCPCredentialScope,
	type MCPCredentialStatusView,
} from "./mcp-auth-storage.ts";
import {
	DEFAULT_MCP_CONTENT_LIMITS,
	type MCPGetPromptResult,
	type MCPNormalizedContentBlock,
	type MCPPageResult,
	type MCPPromptView,
	type MCPReadResourceResult,
	type MCPResourceTemplateView,
	type MCPResourceView,
	utf8ByteLength,
	validateMcpPromptArguments,
} from "./mcp-content-types.ts";
import { createMCPDefaultTransportFactory, MCPLifecycleManager, type MCPServerAuthHooks } from "./mcp-lifecycle.ts";
import { type MCPToolDefinitionResult, mapMCPToolsToDefinitions } from "./mcp-tool-adapter.ts";
import { MCPError, type MCPServerConfig, type MCPTransportFactory, type MCPTransportFactoryOptions } from "./mcp-types.ts";
import { type BashExecutionMessage, type CustomMessage, convertToLlm } from "./messages.ts";
import { ModelBroker, ModelBrokerError, type ModelResolution, type NormalizedModelReference } from "./model-broker.ts";
import {
	type ModelAttemptLedgerRecord,
	type ModelBindingLedgerRecord,
	persistModelAttempt,
	persistModelBinding,
} from "./model-broker-ledger.ts";
import { ModelRegistry } from "./model-registry.ts";
import type { ModelRuntime } from "./model-runtime.ts";
import { createOperationBoundary } from "./operation-boundary.ts";
import { expandPromptTemplate, type PromptTemplate } from "./prompt-templates.ts";
import type { ResourceExtensionPaths, ResourceLoader } from "./resource-loader.ts";
import { type SandboxHandle, type SandboxProvider, SandboxSession, toSandboxBindingHandle } from "./sandbox.ts";
import { type BuiltinToolPolicy, createBuiltinToolPolicy } from "./sandbox-host.ts";
import {
	createSessionBranchBoundary,
	createSessionCheckpoint,
	getSessionBoundaries,
	recoverSessionCheckpoint,
	type SessionBoundaryRecord,
} from "./session-boundary.ts";
import type { BranchSummaryEntry, CompactionEntry, SessionEntry, SessionManager } from "./session-manager.ts";
import { CURRENT_SESSION_VERSION, getLatestCompactionEntry, type SessionHeader } from "./session-manager.ts";
import type { SettingsManager } from "./settings-manager.ts";
import { formatSkillsForPrompt, type Skill } from "./skills.ts";
import type { SlashCommandInfo } from "./slash-commands.ts";
import { createSyntheticSourceInfo, type SourceInfo } from "./source-info.ts";
import { type BuildSystemPromptOptions, buildSystemPrompt } from "./system-prompt.ts";
import { type BashOperations, createLocalBashOperations } from "./tools/bash.ts";
import { createAllToolDefinitions } from "./tools/index.ts";
import { createToolDefinitionFromAgentTool } from "./tools/tool-definition-wrapper.ts";
import { addUsageToTotals, createUsageTotals } from "./usage-totals.ts";

function isUnknownSandboxSideEffectError(value: unknown): boolean {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as {
		readonly category?: unknown;
		readonly sideEffects?: unknown;
		readonly sideEffectStatus?: unknown;
	};
	return (
		candidate.category === "side-effect-unknown" &&
		(candidate.sideEffects === "unknown" || candidate.sideEffectStatus === "unknown")
	);
}

function getActiveWorkspaceIdentity(cwd: string): string {
	try {
		return createWorkspaceIdentity(realpathSync(cwd));
	} catch {
		return createWorkspaceIdentity(cwd);
	}
}

// ============================================================================
// Skill Block Parsing
// ============================================================================

/** Parsed skill block from a user message */
export interface ParsedSkillBlock {
	name: string;
	location: string;
	content: string;
	userMessage: string | undefined;
}

/**
 * Parse a skill block from message text.
 * Returns null if the text doesn't contain a skill block.
 */
export function parseSkillBlock(text: string): ParsedSkillBlock | null {
	const match = text.match(/^<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/);
	if (!match) return null;
	return {
		name: match[1],
		location: match[2],
		content: match[3],
		userMessage: match[4]?.trim() || undefined,
	};
}

/** Session-specific events that extend the core AgentEvent */
export type AgentSessionEvent =
	| Exclude<AgentEvent, { type: "agent_end" }>
	| {
			type: "agent_end";
			messages: AgentMessage[];
			willRetry: boolean;
	  }
	| { type: "agent_settled" }
	| {
			type: "queue_update";
			steering: readonly string[];
			followUp: readonly string[];
	  }
	| { type: "compaction_start"; reason: "manual" | "threshold" | "overflow" }
	| { type: "entry_appended"; entry: SessionEntry }
	| { type: "session_info_changed"; name: string | undefined }
	| { type: "thinking_level_changed"; level: ThinkingLevel }
	| {
			type: "compaction_end";
			reason: "manual" | "threshold" | "overflow";
			result: CompactionResult | undefined;
			aborted: boolean;
			willRetry: boolean;
			errorMessage?: string;
	  }
	| { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
	| { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
	| {
			type: "summarization_retry_scheduled";
			attempt: number;
			maxAttempts: number;
			delayMs: number;
			errorMessage: string;
	  }
	| { type: "summarization_retry_attempt_start"; source: "branchSummary" }
	| {
			type: "summarization_retry_attempt_start";
			source: "compaction";
			reason: "manual" | "threshold" | "overflow";
	  }
	| { type: "summarization_retry_finished" }
	| { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
	| { type: "bash_execution_update"; id?: string; delta: string }
	| {
			/** Bounded External Agent Adapter observation, validated by the host driver. */
			type: "external_agent_event";
			event: ExternalAgentEvent;
	  };

/** Listener function for agent session events */
export type AgentSessionEventListener = (event: AgentSessionEvent) => void;

// ============================================================================
// Types
// ============================================================================

function withoutDeletedHeaders(headers: ProviderHeaders | undefined): Record<string, string> | undefined {
	return headers
		? Object.fromEntries(Object.entries(headers).filter((entry): entry is [string, string] => entry[1] !== null))
		: undefined;
}

/** Stable identity component for an extension descriptor id. */
function stableExtensionLocalName(extension: Extension): string {
	if (extension.path.startsWith("<") && extension.path.endsWith(">")) {
		return extension.path.slice(1, -1);
	}
	return basename(extension.path).replace(/\.(ts|js)$/, "");
}

function hasVisibleModelEvent(event: AssistantMessageEvent): boolean {
	const hasVisibleContent = (message: AssistantMessage): boolean =>
		message.content.some((part) => {
			if (part.type === "toolCall") return true;
			if (part.type === "text") return part.text.length > 0;
			return part.thinking.length > 0;
		});

	switch (event.type) {
		case "start":
			return hasVisibleContent(event.partial);
		case "text_start":
		case "text_delta":
		case "text_end":
		case "thinking_start":
		case "thinking_delta":
		case "thinking_end":
			return hasVisibleContent(event.partial);
		case "toolcall_start":
		case "toolcall_delta":
		case "toolcall_end":
			return true;
		case "done":
			return event.reason === "toolUse" || hasVisibleContent(event.message);
		default:
			return false;
	}
}

function classifyModelStreamFailure(
	value: AssistantMessage | string,
	options: { dispatched?: boolean; visibleOutput?: boolean } = {},
): ExecutionErrorClassification {
	return classifyProviderFailure(value, options);
}

function operationAbortReason(signal: AbortSignal): Error {
	return signal.reason instanceof Error ? signal.reason : new DOMException("Operation aborted", "AbortError");
}

async function awaitWithOperationSignal<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (signal === undefined) return operation;
	if (signal.aborted) throw operationAbortReason(signal);
	let onAbort: (() => void) | undefined;
	const aborted = new Promise<never>((_, reject) => {
		onAbort = () => reject(operationAbortReason(signal));
		signal.addEventListener("abort", onAbort, { once: true });
	});
	try {
		return await Promise.race([operation, aborted]);
	} finally {
		if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
	}
}

function createSyntheticModelError(
	model: Model<any>,
	reason: "error" | "aborted",
	errorMessage: string,
): AssistantMessage {
	return {
		role: "assistant",
		content: [],
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
		stopReason: reason,
		errorMessage,
		timestamp: Date.now(),
	};
}

/** Secret-free last-listed content of one MCP server. Never holds raw bodies. */
export interface McpContentCatalog {
	resources: ReadonlyArray<MCPResourceView>;
	resourceTemplates: ReadonlyArray<MCPResourceTemplateView>;
	prompts: ReadonlyArray<MCPPromptView>;
}

/** Result of an explicit MCP content attachment. */
export interface McpAttachmentResult {
	/** Stable context source id of the pending attachment. */
	attachmentId: string;
	/** Server id the content was attached from. */
	serverId: string;
	/** Normalized character count of the attached text content. */
	contentLength: number;
	/** True when the attached payload was truncated or had blocks dropped by normalization. */
	truncated: boolean;
}

/** Combined MCP OAuth + credential status of one server. Secret-free. */
export interface McpAuthStatusView {
	serverId: string;
	/** True only for streamable-http servers; stdio servers never authenticate. */
	authSupported: boolean;
	/** OAuth flow state of the session+server. */
	auth: MCPAuthStatus;
	/** Namespace credential slot status. */
	credential: MCPCredentialStatusView;
}

export interface AgentSessionConfig {
	agent: Agent;
	sessionManager: SessionManager;
	settingsManager: SettingsManager;
	agentDir?: string;
	cwd: string;
	/** Models to cycle through with Ctrl+P (from --models flag) */
	scopedModels?: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;
	/** Resource loader for extensions, skills, prompts, themes, context files, and system prompt */
	resourceLoader: ResourceLoader;
	/** SDK custom tools registered outside extensions */
	customTools?: ToolDefinition[];
	/** Canonical model/auth runtime used by coding-agent internals. */
	modelRuntime: ModelRuntime;
	/** Broker for safe model selection and metadata-only binding facts. */
	modelBroker?: ModelBroker;
	modelBrokerConfigRevision?: string;
	/** Whether the initial SDK model was an explicit manual selection. */
	initialModelSelection?: "manual" | "default";
	/** Initial active built-in tool names. Default: [read, bash, edit, write] */
	initialActiveToolNames?: string[];
	/** Optional allowlist of tool names. When provided, only these tool names are exposed. */
	allowedToolNames?: string[];
	/** Optional denylist of tool names. When provided, these tool names are not exposed. */
	excludedToolNames?: string[];
	/**
	 * Override base tools (useful for custom runtimes).
	 *
	 * These are synthesized into minimal ToolDefinitions internally so AgentSession can keep
	 * a definition-first registry even when callers provide plain AgentTool instances.
	 */
	baseToolsOverride?: Record<string, AgentTool>;
	/** Mutable ref used by Agent to access the current ExtensionRunner */
	extensionRunnerRef?: { current?: ExtensionRunner };
	/** Session start event metadata emitted when extensions bind to this runtime. */
	sessionStartEvent?: SessionStartEvent;
	/** Capability Registry facade used to freeze the session's capability binding. */
	capabilityRegistry?: CapabilityRegistry;
	/** MCP transport factory override; tests inject in-memory transports. */
	mcpTransportFactory?: MCPTransportFactory;
	/**
	 * Base fetch for MCP OAuth HTTP requests; defaults to the global fetch.
	 * Every OAuth request is execution-policy gated before this fetch runs.
	 */
	mcpAuthFetch?: FetchLike;
	/** Registered sandbox providers available to execution policy. */
	sandboxProviders?: ReadonlyMap<string, SandboxProvider> | ReadonlyArray<SandboxProvider>;
	/** Optional named Execution Policy profile selector for this session. */
	policyProfile?: string;
	/** Trusted External Agent Adapter registry composed by the Host. */
	externalAgentRegistry?: ExternalAgentAdapterRegistry;
	/** Session-local approvals for ask capabilities. Never overrides a deny. */
	capabilityApprovedDescriptorIds?: ReadonlyArray<string>;
	/** `noTools` suppression mode from createAgentSession: only narrows the binding. */
	noTools?: "all" | "builtin";
}

export interface ExtensionBindings {
	uiContext?: ExtensionUIContext;
	mode?: ExtensionMode;
	commandContextActions?: ExtensionCommandContextActions;
	abortHandler?: () => void;
	shutdownHandler?: ShutdownHandler;
	onError?: ExtensionErrorListener;
}

/** Options for AgentSession.prompt() */
export interface PromptOptions {
	/** Whether to expand file-based prompt templates (default: true) */
	expandPromptTemplates?: boolean;
	/** Image attachments */
	images?: ImageContent[];
	/** When streaming, how to queue the message: "steer" (interrupt) or "followUp" (wait). Required if streaming. */
	streamingBehavior?: "steer" | "followUp";
	/** Source of input for extension input event handlers. Defaults to "interactive". */
	source?: InputSource;
	/** Internal hook used by RPC mode to observe prompt preflight acceptance or rejection. */
	preflightResult?: (success: boolean) => void;
	/** Automation Host run identifier propagated to each model-call snapshot. */
	runId?: string;
	/** Caller cancellation signal linked to model, tool, MCP, and sandbox work. */
	signal?: AbortSignal;
	/** Maximum duration for the active Agent operation. */
	deadlineMs?: number;
}

/** Result from cycleModel() */
export interface ModelCycleResult {
	model: Model<any>;
	thinkingLevel: ThinkingLevel;
	/** Whether cycling through scoped models (--models flag) or all available */
	isScoped: boolean;
}

/** Session statistics for /session command */
export interface SessionStats {
	sessionFile: string | undefined;
	sessionId: string;
	userMessages: number;
	assistantMessages: number;
	toolCalls: number;
	toolResults: number;
	totalMessages: number;
	tokens: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
	cost: number;
	contextUsage?: ContextUsage;
}

interface ToolDefinitionEntry {
	definition: ToolDefinition;
	sourceInfo: SourceInfo;
}

function estimateMessagesTokens(messages: AgentMessage[]): number {
	let tokens = 0;
	for (const message of messages) {
		tokens += estimateTokens(message);
	}
	return tokens;
}

// ============================================================================
// Constants
// ============================================================================

/** Standard thinking levels */
const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high"];

class ContextRuntimeError extends Error {
	readonly contextError: ContextError;

	constructor(contextError: ContextError) {
		super(contextError.message);
		this.name = "ContextRuntimeError";
		this.contextError = contextError;
	}
}

// ============================================================================
// AgentSession Class
// ============================================================================

export class AgentSession {
	readonly agent: Agent;
	readonly sessionManager: SessionManager;
	readonly settingsManager: SettingsManager;

	private _scopedModels: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;

	// Event subscription state
	private _unsubscribeAgent?: () => void;
	private _eventListeners: AgentSessionEventListener[] = [];
	private _isAgentRunActive = false;
	private _idleWaitPromise: Promise<void> | undefined;
	private _resolveIdleWait: (() => void) | undefined;

	/** Tracks pending steering messages for UI display. Removed when delivered. */
	private _steeringMessages: string[] = [];
	/** Tracks pending follow-up messages for UI display. Removed when delivered. */
	private _followUpMessages: string[] = [];
	/** Messages queued to be included with the next user prompt as context ("asides"). */
	private _pendingNextTurnMessages: CustomMessage[] = [];

	// Compaction state
	private _compactionAbortController: AbortController | undefined = undefined;
	private _autoCompactionAbortController: AbortController | undefined = undefined;
	private _overflowRecoveryAttempted = false;

	// Branch summarization state
	private _branchSummaryAbortController: AbortController | undefined = undefined;

	// Retry state
	private _retryAbortController: AbortController | undefined = undefined;
	private _retryAttempt = 0;
	/** Classification captured at the provider boundary for the next retry decision. */
	private _pendingProviderFailure: ExecutionErrorClassification | undefined;

	// Bash execution state
	private readonly _bashAbortControllers = new Set<AbortController>();
	private _pendingBashMessages: BashExecutionMessage[] = [];

	// Extension system
	private _extensionRunner!: ExtensionRunner;
	private _turnIndex = 0;

	private _resourceLoader: ResourceLoader;
	private _customTools: ToolDefinition[];
	private _baseToolDefinitions: Map<string, ToolDefinition> = new Map();
	private _cwd: string;
	private _agentDir: string;
	private _extensionRunnerRef?: { current?: ExtensionRunner };
	private _initialActiveToolNames?: string[];
	private _allowedToolNames?: Set<string>;
	private _excludedToolNames?: Set<string>;
	private _baseToolsOverride?: Record<string, AgentTool>;
	private _sessionStartEvent: SessionStartEvent;
	private _extensionUIContext?: ExtensionUIContext;
	private _extensionMode: ExtensionMode = "print";
	private _extensionCommandContextActions?: ExtensionCommandContextActions;
	private _extensionAbortHandler?: () => void;
	private _extensionShutdownHandler?: ShutdownHandler;
	private _extensionErrorListener?: ExtensionErrorListener;
	private _extensionErrorUnsubscriber?: () => void;

	private _modelRuntime: ModelRuntime;
	private _modelBroker: ModelBroker;
	private _modelBrokerConfigRevision: string;
	/** Route/role binding selected for the next top-level operation. */
	private _selectedModelResolution: ModelResolution | undefined;
	/** Source binding when an Automation Run resumes with a successor binding. */
	private _previousModelBindingId: string | undefined;
	/** Direct/default binding reused by all provider calls in one agent operation. */
	private _operationModelResolution: ModelResolution | undefined;
	/** Most recently materialized binding, retained for read-only route inspection. */
	private _lastModelBrokerBindingId: string | undefined;
	/** Ledger binding ids already emitted by this Session instance. */
	private readonly _persistedModelBrokerBindingIds = new Set<string>();
	/** A model set or cycled by the caller takes precedence over broker defaults. */
	private _manualModelSelection = false;

	// Tool registry for extension getTools/setTools
	private _toolRegistry: Map<string, AgentTool> = new Map();
	private _toolDefinitions: Map<string, ToolDefinitionEntry> = new Map();
	private _toolPromptSnippets: Map<string, string> = new Map();
	private _toolPromptGuidelines: Map<string, string[]> = new Map();

	// Base system prompt (without extension appends) - used to apply fresh appends each turn
	private _baseSystemPrompt = "";
	private _baseSystemPromptOptions!: BuildSystemPromptOptions;
	private _systemPromptOverride?: string;

	/** Most recent Context Engine snapshot id (agent_turn / compaction / branch_summary). */
	private _lastContextSnapshotId: string | undefined;
	/** Parent snapshot for derived retries / overflow re-plans. */
	private _parentContextSnapshotId: string | undefined;
	private readonly _contextMemoryStore = new ContextMemoryStore();
	/** Underlying stream function; Context Engine wraps every actual model-call boundary. */
	private _agentStreamFunction: StreamFn;
	private _contextEngineStreamBoundary!: StreamFn;
	/** Run id supplied by Automation Host while an agent prompt is active. */
	private _activeContextRunId: string | undefined;
	/** Dynamic extension sources apply to every model call in the active agent run. */
	private _pendingExtensionContextSources: ContextSourceInput[] = [];
	/** Last frozen snapshot per Automation Host run. */
	private readonly _contextSnapshotIdsByRun = new Map<string, string>();
	/** Context errors raised inside Agent-core boundaries and rethrown to the caller. */
	private _pendingContextError: ContextError | undefined;

	// Capability Registry + MCP lifecycle state. The binding is frozen per runtime
	// build; an active agent run cannot mutate it.
	private _capabilityRegistry: CapabilityRegistry;
	private _capabilityApprovedDescriptorIds: ReadonlyArray<string>;
	/** Capability profile materialized into the active frozen binding; undefined uses settings.defaultProfile. */
	private _activeCapabilityProfile: string | undefined;
	private _noTools?: "all" | "builtin";
	private _mcpTransportFactory?: MCPTransportFactory;
	private _mcpAuthBaseFetch?: FetchLike;
	private _mcpLifecycleManager!: MCPLifecycleManager;
	private _mcpRegisteredServerIds = new Set<string>();
	private _mcpAuthorizedTransportValues = new Map<
		string,
		{ readonly environment: Readonly<Record<string, string>>; readonly headers: Readonly<Record<string, string>> }
	>();
	private _activeCapabilityBinding: CapabilityBinding | undefined;
	private _activeCapabilityCatalog: CapabilityCatalog | undefined;
	private _activeMcpTools: MCPToolDefinitionResult[] = [];
	private _activeMcpToolCandidates: CapabilityCandidate[] = [];
	/** Content capability candidates (mcp_resource / mcp_resource_template / mcp_prompt). */
	private _activeMcpContentCandidates: CapabilityCandidate[] = [];
	/** Last listed secret-free content per server, used for digest descriptor derivation. */
	private readonly _mcpContentCatalogs = new Map<string, McpContentCatalog>();
	/**
	 * Listed catalog identities (resourceId -> URI, promptId -> name) captured
	 * when an execution-policy boundary closes MCP transports, restored after
	 * the next explicit reconnect so already-listed content keeps resolving.
	 */
	private readonly _mcpCatalogIdentitySnapshots = new Map<string, unknown>();
	/** Explicitly attached MCP content, pending as untrusted context sources for the next turn. */
	private _pendingMcpAttachments: ContextSourceInput[] = [];
	/** MCP OAuth provider: one flow per (session, server), credentials in the MCP namespace. */
	private readonly _mcpAuthProvider: MCPAuthProvider;
	private readonly _mcpCredentialNamespace: MCPCredentialNamespace;
	/** Cancels pending MCP OAuth flows when the session is disposed. */
	private readonly _mcpAuthAbortController = new AbortController();
	/** Redacted capability error codes per MCP server that failed discovery. */
	private _mcpDiscoveryErrors = new Map<string, string>();
	/** Resolves when MCP capability discovery for the current runtime settles. */
	private _capabilityDiscoveryPromise: Promise<void> = Promise.resolve();
	private _capabilityDiscoveryError: Error | undefined;
	/**
	 * Whether discovery has been started for the current runtime. Discovery is
	 * lazy: it begins only when capability readiness is explicitly requested or
	 * at prompt/run preflight, never during runtime construction.
	 */
	private _capabilityDiscoveryStarted = false;
	/** Awaitable for the current server-selection teardown (deselection closes). */
	private _serverSelectionSyncPromise: Promise<void> = Promise.resolve();
	/**
	 * Tail of the serialized profile-materialization queue. Transitions run
	 * strictly in invocation order so a slow teardown (a delayed transport
	 * close) can never overlap a newer transition's connect or overwrite a
	 * later request: the last-invoked profile is always the last to materialize.
	 */
	private _profileMaterializationTail: Promise<void> = Promise.resolve();
	/** Tool registration that arrived mid-run; applied after the run settles. */
	private _pendingToolRegistryRefresh = false;
	private readonly _policyLedger: ReturnType<typeof createExecutionPolicyLedger>;
	private readonly _persistedPolicyBindingIds = new Set<string>();
	private readonly _sandboxProviders: ReadonlyMap<string, SandboxProvider>;
	private _activeExecutionPolicyProfile: ExecutionPolicyProfile | undefined;
	private _activeExecutionPolicyBinding: PolicyBinding | undefined;
	private _activeExecutionPolicyProfileSelection: string | undefined;
	private _nextPreviousExecutionPolicyBindingId: string | undefined;
	/** Source binding id retained across capability-discovery rebindings for one run. */
	private _executionPolicyPreviousBindingIdForRun: string | undefined;
	private _executionPolicyApprovedRequestIds: string[] = [];
	private _executionPolicyRejectedRequestIds: string[] = [];
	private _pendingExecutionPolicyApprovals = new Map<string, PolicyApprovalRequest>();
	private _activeSandboxSession: SandboxSession | undefined;
	private _activeSandboxHandle: SandboxHandle | undefined;
	/** Serializes policy binding teardown and sandbox preparation. */
	private _executionPolicyPreparationTail: Promise<void> = Promise.resolve();
	private _disposePolicyBoundaryPromise: Promise<void> | undefined;
	private _currentBuiltinToolPolicy: BuiltinToolPolicy | undefined;
	private _externalAgentRegistry: ExternalAgentAdapterRegistry | undefined;
	constructor(config: AgentSessionConfig) {
		this.agent = config.agent;
		this._agentStreamFunction = config.agent.streamFunction;
		this.sessionManager = config.sessionManager;
		this.settingsManager = config.settingsManager;
		this._scopedModels = config.scopedModels ?? [];
		this._resourceLoader = config.resourceLoader;
		this._customTools = config.customTools ?? [];
		this._cwd = config.cwd;
		this._agentDir = config.agentDir ?? config.cwd;
		this._modelRuntime = config.modelRuntime;
		this._modelBroker = config.modelBroker ?? new ModelBroker();
		this._modelBrokerConfigRevision = config.modelBrokerConfigRevision ?? "runtime";
		this._selectedModelResolution = undefined;
		this._previousModelBindingId = undefined;
		this._operationModelResolution = undefined;
		this._manualModelSelection = config.initialModelSelection === "manual";
		this._extensionRunnerRef = config.extensionRunnerRef;
		this._initialActiveToolNames = config.initialActiveToolNames;
		this._allowedToolNames = config.allowedToolNames ? new Set(config.allowedToolNames) : undefined;
		this._excludedToolNames = config.excludedToolNames ? new Set(config.excludedToolNames) : undefined;
		this._baseToolsOverride = config.baseToolsOverride;
		this._sessionStartEvent = config.sessionStartEvent ?? { type: "session_start", reason: "startup" };
		this._capabilityRegistry = config.capabilityRegistry ?? new CapabilityRegistry();
		this._capabilityApprovedDescriptorIds = config.capabilityApprovedDescriptorIds ?? [];
		this._activeCapabilityProfile = undefined;
		this._activeExecutionPolicyProfileSelection = config.policyProfile;
		this._noTools = config.noTools;
		this._mcpTransportFactory = config.mcpTransportFactory;
	this._mcpAuthBaseFetch = config.mcpAuthFetch;
	this._mcpCredentialNamespace = new MCPCredentialNamespace(this._modelRuntime.getCredentialStore());
	this._mcpAuthProvider = new MCPAuthProvider({ store: this._createMcpAuthStoreAdapter() });
		this._externalAgentRegistry = config.externalAgentRegistry;
		const sandboxProviders = config.sandboxProviders;
		this._sandboxProviders =
			sandboxProviders === undefined
				? new Map()
				: typeof (sandboxProviders as ReadonlyMap<string, SandboxProvider>).get === "function"
					? (sandboxProviders as ReadonlyMap<string, SandboxProvider>)
					: new Map(
							(sandboxProviders as ReadonlyArray<SandboxProvider>).map((provider) => [provider.id, provider]),
						);
		this._policyLedger = createExecutionPolicyLedger(this.sessionManager);

		// Always subscribe to agent events for internal handling
		// (session persistence, extensions, auto-compaction, retry logic)
		this._unsubscribeAgent = this.agent.subscribe(this._handleAgentEvent);
		this._installAgentToolHooks();
		this._installContextEngineTransformBoundary();
		this._installContextEnginePayloadBoundary();
		this._installAgentNextTurnRefresh();
		this._installContextEngineStreamBoundary();

		this._buildRuntime({
			activeToolNames: this._initialActiveToolNames,
			includeAllExtensionTools: true,
		});
	}

	get modelRuntime(): ModelRuntime {
		return this._modelRuntime;
	}

	get modelBroker(): ModelBroker {
		return this._modelBroker;
	}

	get modelBrokerConfigRevision(): string {
		return this._modelBrokerConfigRevision;
	}

	/** Safe binding identity selected for the current session operation. */
	get modelBrokerBindingId(): string | undefined {
		return (
			this._selectedModelResolution?.bindingId ??
			this._operationModelResolution?.bindingId ??
			this._lastModelBrokerBindingId
		);
	}

	/**
	 * Return the public-safe binding handles frozen for the current operation.
	 * Handles are references only; live providers, credentials, and runtime
	 * sandbox identifiers never cross this boundary.
	 */
	getActiveBindingHandles(): ReadonlyArray<BindingHandle> {
		const handles: BindingHandle[] = [];
		const modelBindingId = this.modelBrokerBindingId;
		if (modelBindingId !== undefined) {
			const modelHandle = this._modelBroker.getBindingHandle(modelBindingId);
			if (modelHandle !== undefined) handles.push(modelHandle);
		}
		if (this._activeCapabilityBinding !== undefined) {
			handles.push(toCapabilityBindingHandle(this._activeCapabilityBinding));
		}
		if (this._activeExecutionPolicyBinding !== undefined) {
			const policyBinding = this._activeExecutionPolicyBinding;
			handles.push(toPolicyBindingHandle(policyBinding));
			if (policyBinding.enforcement === "sandbox" || this._activeSandboxHandle !== undefined) {
				handles.push(
					toSandboxBindingHandle({
						binding: policyBinding,
						handle: this._activeSandboxHandle,
					}),
				);
			}
		}
		return handles;
	}

	/**
	 * Return the trusted External Agent Adapter registry composed by the Host,
	 * or undefined when no external agent support is wired into this session.
	 * The registry never exposes endpoints, commands, credentials, protocol
	 * names, or raw probe data; only safe descriptors and adapter instances.
	 */
	getExternalAgentRegistry(): ExternalAgentAdapterRegistry | undefined {
		return this._externalAgentRegistry;
	}

	/**
	 * Run the capability, policy, and sandbox preflight for an external agent
	 * run without entering the model loop. This mirrors the preflight half of
	 * {@link prompt}: capability discovery settlement, the prompt-preflight tool
	 * registry refresh, Execution Policy binding and sandbox preparation, and
	 * MCP transport reconnection for the settled policy binding. The caller
	 * still owns the Run reservation/accept/start/terminal lifecycle.
	 */
	async runExternalAgentPreflight(runId?: string, signal?: AbortSignal): Promise<void> {
		await this.whenCapabilitiesReady(runId, signal);
		this._applyPromptPreflightToolRegistryRefresh();
		// deferMcpReconnect makes the policy transition self-contained: the
		// binding change closes every MCP transport and immediately reconnects
		// the selected servers under the new binding.
		await this._ensureExecutionPolicyReady(runId, signal, { deferMcpReconnect: true });
	}

	/**
	 * Attach an already-resolved ModelBroker binding to the next model call.
	 * Runtime/RPC callers use this after validating the concrete ModelRuntime
	 * model; the stream boundary then reuses the same immutable binding instead
	 * of creating a second direct binding.
	 */
	setModelBrokerResolution(resolution: ModelResolution, previousModelBindingId?: string): void {
		if (!this.isIdle) {
			throw new Error("Cannot change the model route while the session is streaming.");
		}
		this._selectedModelResolution = resolution;
		this._previousModelBindingId = previousModelBindingId;
		this._lastModelBrokerBindingId = resolution.bindingId;
		this._manualModelSelection = false;
	}

	/** Clear an operation-scoped route selection without changing the current model. */
	clearModelBrokerResolution(): void {
		if (!this.isIdle) {
			throw new Error("Cannot clear the model route while the session is streaming.");
		}
		this._selectedModelResolution = undefined;
		this._previousModelBindingId = undefined;
		this._lastModelBrokerBindingId = undefined;
		this._manualModelSelection = false;
	}

	private _resolveModelBrokerOperation(model: Model<any>): { model: Model<any>; resolution: ModelResolution } {
		if (this._operationModelResolution !== undefined) {
			const operationModel =
				this._modelRuntime.getModel?.(
					this._operationModelResolution.reference.provider,
					this._operationModelResolution.reference.id,
				) ??
				(this._operationModelResolution.reference.provider === model.provider &&
				this._operationModelResolution.reference.id === model.id
					? model
					: undefined);
			if (operationModel === undefined) {
				throw new ModelBrokerError("model_binding_unavailable", "The selected model binding is unavailable", true);
			}
			return { model: operationModel, resolution: this._operationModelResolution };
		}

		let resolution = this._selectedModelResolution;
		if (resolution === undefined && !this._manualModelSelection) {
			const defaultResult = this._modelBroker.resolveResult({});
			if (defaultResult.ok) resolution = defaultResult.resolution;
			else if (this._modelBroker.hasDefaultSelection()) throw new ModelBrokerError(defaultResult.error);
		}
		if (resolution === undefined) {
			resolution = this._modelBroker.resolve({
				direct: {
					provider: model.provider,
					id: model.id,
					thinkingLevel: this.agent.state.thinkingLevel,
				},
			});
		}
		const resolvedModel =
			this._modelRuntime.getModel?.(resolution.reference.provider, resolution.reference.id) ??
			(resolution.reference.provider === model.provider && resolution.reference.id === model.id ? model : undefined);
		if (resolvedModel === undefined) {
			throw new ModelBrokerError("model_binding_unavailable", "The selected model binding is unavailable", true);
		}
		const requestModel =
			resolvedModel.provider === model.provider && resolvedModel.id === model.id
				? { ...resolvedModel, baseUrl: model.baseUrl }
				: resolvedModel;
		this._operationModelResolution = resolution;
		this._lastModelBrokerBindingId = resolution.bindingId;
		if (this._selectedModelResolution === undefined) {
			this._modelBroker.beginBindingOperation(resolution.bindingId);
		}
		return { model: requestModel, resolution };
	}

	private _beginModelBrokerOperation(): void {
		this._operationModelResolution = undefined;
		if (this._selectedModelResolution !== undefined) {
			this._modelBroker.beginBindingOperation(this._selectedModelResolution.bindingId);
		}
	}

	private async _getRequiredRequestAuth(model: Model<any>): Promise<{
		model: Model<any>;
		apiKey?: string;
		headers?: Record<string, string>;
		env?: Record<string, string>;
	}> {
		let result: AuthResult | undefined;
		try {
			result = await this._modelRuntime.getAuth(model);
		} catch (error) {
			const cause = error instanceof Error ? error.cause : undefined;
			if (cause instanceof Error && cause.message === "authHeader requires a resolved API key") {
				throw new Error(formatNoApiKeyFoundMessage(model.provider));
			}
			throw error;
		}
		if (result && (result.auth.apiKey || result.auth.headers)) {
			const requestModel = result.auth.baseUrl ? { ...model, baseUrl: result.auth.baseUrl } : model;
			return {
				model: requestModel,
				apiKey: result.auth.apiKey,
				headers: withoutDeletedHeaders(result.auth.headers),
				env: result.env,
			};
		}

		const isOAuth = this._modelRuntime.isUsingOAuth(model.provider);
		if (isOAuth) {
			throw new Error(
				`Authentication failed for "${model.provider}". ` +
					`Credentials may have expired or network is unavailable. ` +
					`Run '/login ${model.provider}' to re-authenticate.`,
			);
		}
		throw new Error(formatNoApiKeyFoundMessage(model.provider));
	}

	private async _getSummarizationRequestAuth(model: Model<any>): Promise<{
		model: Model<any>;
		apiKey?: string;
		headers?: Record<string, string>;
		env?: Record<string, string>;
	}> {
		if (this._getActiveAgentStreamFunction() === streamSimple) {
			return this._getRequiredRequestAuth(model);
		}

		try {
			const result = await this._modelRuntime.getAuth(model);
			if (!result) return { model };
			const requestModel = result.auth.baseUrl ? { ...model, baseUrl: result.auth.baseUrl } : model;
			return {
				model: requestModel,
				apiKey: result.auth.apiKey,
				headers: withoutDeletedHeaders(result.auth.headers),
				env: result.env,
			};
		} catch {
			return { model };
		}
	}

	/**
	 * Install tool hooks once on the Agent instance.
	 *
	 * The callbacks read `this._extensionRunner` at execution time, so extension reload swaps in the
	 * new runner without reinstalling hooks. Extension-specific tool wrappers are still used to adapt
	 * registered tool execution to the extension context. Tool call and tool result interception now
	 * happens here instead of in wrappers.
	 */
	private _installAgentToolHooks(): void {
		this.agent.beforeToolCall = async ({ toolCall, args }) => {
			const runner = this._extensionRunner;
			if (!runner.hasHandlers("tool_call")) {
				return undefined;
			}

			try {
				return await runner.emitToolCall({
					type: "tool_call",
					toolName: toolCall.name,
					toolCallId: toolCall.id,
					input: args as Record<string, unknown>,
				});
			} catch (err) {
				if (err instanceof Error) {
					throw err;
				}
				throw new Error(`Extension failed, blocking execution: ${String(err)}`);
			}
		};

		this.agent.afterToolCall = async ({ toolCall, args, result, isError }) => {
			const runner = this._extensionRunner;
			const hookResult = runner.hasHandlers("tool_result")
				? await runner.emitToolResult({
						type: "tool_result",
						toolName: toolCall.name,
						toolCallId: toolCall.id,
						input: args as Record<string, unknown>,
						content: result.content,
						details: result.details,
						isError,
						usage: result.usage,
					})
				: undefined;

			const content = hookResult?.content ?? result.content ?? [];
			// Runs after the extension hook so images injected or replaced by extensions are normalized too.
			const normalizedContent = await normalizeToolResultImages(content, {
				autoResizeImages: this.settingsManager.getImageAutoResize(),
			});

			if (!hookResult && normalizedContent === content) {
				return undefined;
			}

			return {
				content: normalizedContent,
				details: hookResult?.details,
				isError: hookResult?.isError ?? isError,
				usage: hookResult?.usage,
			};
		};
	}

	private _installAgentNextTurnRefresh(): void {
		const previousPrepareNextTurnWithContext =
			this.agent.prepareNextTurnWithContext ??
			(this.agent.prepareNextTurn
				? async (_turn: PrepareNextTurnContext, signal?: AbortSignal) => await this.agent.prepareNextTurn?.(signal)
				: undefined);
		this.agent.prepareNextTurnWithContext = async (turn, signal) => {
			const previousSnapshot = await previousPrepareNextTurnWithContext?.(turn, signal);
			const previousContext = previousSnapshot?.context ?? turn.context;

			return {
				...previousSnapshot,
				context: {
					...previousContext,
					// The stream boundary resolves a fresh plan from the exact next
					// request context. Never carry an already-packed prompt forward.
					systemPrompt: this._baseSystemPrompt,
					tools: this.agent.state.tools.slice(),
				},
				model: this.agent.state.model,
				thinkingLevel: this.agent.state.thinkingLevel,
			};
		};
	}

	private _installContextEngineTransformBoundary(): void {
		const previousTransform = this.agent.transformContext;
		if (!previousTransform) {
			return;
		}
		this.agent.transformContext = async (messages, signal) => {
			try {
				const before = JSON.stringify(messages);
				const transformed = await previousTransform(messages, signal);
				if (this.settingsManager.getContextSettings().enabled && before !== JSON.stringify(transformed)) {
					throw new ContextRuntimeError(
						createContextError(
							"context_extension_source_missing",
							"context handlers cannot change model input while Context Engine is enabled; use before_agent_start contribution instead",
							false,
						),
					);
				}
				return transformed;
			} catch (error) {
				this._captureContextError(error);
				throw error;
			}
		};
	}

	/**
	 * Provider adapters build their payload after the Context plan has frozen.
	 * A payload hook may observe it, but an Engine-enabled session cannot permit
	 * it to replace or mutate the payload because that would evade the snapshot.
	 */
	private _installContextEnginePayloadBoundary(): void {
		const previousOnPayload = this.agent.onPayload;
		if (!previousOnPayload) {
			return;
		}
		this.agent.onPayload = async (payload, model) => {
			try {
				const before = JSON.stringify(payload);
				const nextPayload = await previousOnPayload(payload, model);
				const providerPayload = nextPayload ?? payload;
				if (this.settingsManager.getContextSettings().enabled && before !== JSON.stringify(providerPayload)) {
					throw new ContextRuntimeError(
						createContextError(
							"context_extension_source_missing",
							"provider payload hooks cannot change model input while Context Engine is enabled; use before_agent_start contribution instead",
							false,
						),
					);
				}
				return nextPayload;
			} catch (error) {
				this._captureContextError(error);
				throw error;
			}
		};
	}

	private _captureContextError(error: unknown): void {
		if (error instanceof ContextRuntimeError) {
			this._pendingContextError = error.contextError;
		}
	}

	private _throwPendingContextError(): void {
		if (!this._pendingContextError) {
			return;
		}
		const contextError = this._pendingContextError;
		this._pendingContextError = undefined;
		throw new ContextRuntimeError(contextError);
	}

	/**
	 * The Agent stream function is the last in-process boundary before a provider
	 * request. Resolve and persist the plan there so first turns, tool-loop turns,
	 * steering, and follow-ups all receive a snapshot for the exact context that
	 * reaches the model.
	 */
	private _installContextEngineStreamBoundary(): void {
		this._contextEngineStreamBoundary = async (model, context, options) => {
			try {
				const operation = this._resolveModelBrokerOperation(model);
				model = operation.model;
				const originalMessages = context.messages.slice();
				const originalSystemPrompt = context.systemPrompt;
				const originalTools = context.tools;
				let prepareContext: (model: Model<any>, parentSnapshotId?: string) => Promise<Context>;
				if (this.settingsManager.getContextSettings().enabled) {
					this._assertContextPayloadHooksSupported();
					const extensionSources = [
						...this._pendingExtensionContextSources,
						...this._currentMcpAttachmentSources(),
					];
					prepareContext = async (nextModel, parentSnapshotId) => {
						const sources = await this._collectAgentTurnContextSources(
							originalMessages,
							extensionSources,
							originalTools,
						);
						const { plan } = this._resolveAndPersistContextSnapshot({
							purpose: "agent_turn",
							model: nextModel,
							messages: originalMessages,
							sources,
							runId: this._activeContextRunId,
							...(parentSnapshotId === undefined ? {} : { parentSnapshotId }),
						});
						return {
							...context,
							systemPrompt: plan.systemPrompt,
							messages: convertToLlm(plan.messages),
							...(originalTools === undefined ? {} : { tools: originalTools }),
						};
					};
				} else {
					prepareContext = async () => ({
						...context,
						systemPrompt: originalSystemPrompt,
						messages: [...originalMessages],
						...(originalTools === undefined ? {} : { tools: originalTools }),
					});
				}
				return this._streamWithModelBroker(
					model,
					context,
					options,
					(nextModel, nextContext, nextOptions) => this._agentStreamFunction(nextModel, nextContext, nextOptions),
					prepareContext,
					operation.resolution,
				);
			} catch (error) {
				this._captureContextError(error);
				throw error;
			}
		};
		this.agent.streamFunction = this._contextEngineStreamBoundary;
	}

	/**
	 * Extensions and SDK callers may replace `agent.streamFunction` after the
	 * session starts. Preserve that supported customization while restoring the
	 * Context Engine boundary before normal Agent runs.
	 */
	private _refreshContextEngineStreamBoundary(): void {
		if (this.agent.streamFunction === this._contextEngineStreamBoundary) {
			return;
		}
		this._agentStreamFunction = this.agent.streamFunction;
		this.agent.streamFunction = this._contextEngineStreamBoundary;
	}

	private _getActiveAgentStreamFunction(): StreamFn {
		return this.agent.streamFunction === this._contextEngineStreamBoundary
			? this._agentStreamFunction
			: this.agent.streamFunction;
	}

	/**
	 * Record one actual provider dispatch at the last in-process stream boundary.
	 * Only provider/model identity and safe lifecycle facts cross into the
	 * session ledger; authentication resolution remains owned by ModelRuntime.
	 */
	private async _streamWithModelBroker(
		model: Model<any>,
		context: Context,
		options: Parameters<StreamFn>[2],
		invoke: (model: Model<any>, context: Context, options: Parameters<StreamFn>[2]) => ReturnType<StreamFn>,
		prepareFallbackContext: (model: Model<any>, parentSnapshotId?: string) => Promise<Context>,
		operationResolution?: ModelResolution,
	): Promise<AssistantMessageEventStream> {
		const selected = operationResolution ?? this._selectedModelResolution;
		const modelMatchesSelection =
			selected !== undefined && selected.reference.provider === model.provider && selected.reference.id === model.id;
		const resolution = modelMatchesSelection
			? selected
			: this._modelBroker.resolve({
					direct: {
						provider: model.provider,
						id: model.id,
						thinkingLevel: this.agent.state.thinkingLevel,
					},
				});
		const candidates = resolution.candidatesConsidered;
		const initialCandidateIndex = Math.max(
			0,
			candidates.findIndex(
				(candidate) =>
					candidate.provider === resolution.reference.provider && candidate.id === resolution.reference.id,
			),
		);
		const binding = resolution.binding;
		const bindingHasBudget = this._modelBroker.hasBudgetForBinding(binding.id);
		const ledgerBinding: ModelBindingLedgerRecord = {
			bindingId: binding.id,
			mode: resolution.source === "role" ? "route" : resolution.source,
			...(resolution.routeId === undefined ? {} : { routeId: resolution.routeId }),
			...(resolution.role === undefined ? {} : { role: resolution.role }),
			candidates: candidates.map((candidate, order) => ({
				order,
				model: {
					provider: candidate.provider,
					modelId: candidate.id,
					...(candidate.thinkingLevel === undefined
						? {}
						: { thinkingLevel: candidate.thinkingLevel as ThinkingLevel }),
				},
			})),
			fallback: binding.fallback ?? { maxAttempts: 1, on: [] },
			budget: {
				...(binding.budget?.maxModelCalls === undefined ? {} : { maxModelCalls: binding.budget.maxModelCalls }),
				...(binding.budget?.maxInputTokens === undefined ? {} : { maxInputTokens: binding.budget.maxInputTokens }),
				...(binding.budget?.maxOutputTokens === undefined
					? {}
					: { maxOutputTokens: binding.budget.maxOutputTokens }),
				...(binding.budget?.maxTotalTokens === undefined ? {} : { maxTotalTokens: binding.budget.maxTotalTokens }),
				...(binding.budget?.maxCost === undefined ? {} : { maxCostUsd: binding.budget.maxCost }),
				...(binding.budget?.maxCostUsd === undefined ? {} : { maxCostUsd: binding.budget.maxCostUsd }),
			},
			configRevision: binding.configRevision ?? this._modelBrokerConfigRevision,
			createdAt: binding.createdAt,
			...(this._previousModelBindingId === undefined
				? {}
				: { previousModelBindingId: this._previousModelBindingId }),
		};
		if (!this._persistedModelBrokerBindingIds.has(ledgerBinding.bindingId)) {
			try {
				persistModelBinding(this.sessionManager, ledgerBinding);
			} catch {
				// The provider result must not be replaced by a ledger serialization error.
			}
			this._persistedModelBrokerBindingIds.add(ledgerBinding.bindingId);
		}

		const outerStream = createAssistantMessageEventStream();
		void (async () => {
			let currentModel = model;
			let currentContext: Context = {
				// Copy the caller's context so each attempt receives a separately planned
				// context and fallback preparation cannot alter the active attempt.
				...context,
				messages: [...context.messages],
			};
			let currentOrder = initialCandidateIndex;
			let attempts = 0;
			let parentSnapshotId = this._lastContextSnapshotId;
			let currentOptions =
				resolution.reference.thinkingLevel === undefined || resolution.reference.thinkingLevel === "off"
					? options
					: { ...options, reasoning: resolution.reference.thinkingLevel as AiThinkingLevel };

			const persistAttempt = (attempt: ModelAttemptLedgerRecord): void => {
				try {
					persistModelAttempt(this.sessionManager, attempt);
				} catch {
					// The provider result must not be replaced by a ledger serialization error.
				}
			};
			const persistAttemptAssociation = (attemptId: string, contextSnapshotId: string | undefined): void => {
				if (options?.signal?.aborted) return;
				const association: ExecutionAssociationRecord = {
					schemaVersion: 1,
					associationId: `association:${randomUUID()}`,
					sessionId: this.sessionManager.getSessionId(),
					modelAttemptId: attemptId,
					modelBindingId: ledgerBinding.bindingId,
					...(contextSnapshotId === undefined ? {} : { contextSnapshotId }),
					...(this._activeExecutionPolicyBinding?.id === undefined
						? {}
						: { policyBindingId: this._activeExecutionPolicyBinding.id }),
					...(this._activeCapabilityBinding?.id === undefined
						? {}
						: { capabilityBindingId: this._activeCapabilityBinding.id }),
					...(this._activeContextRunId === undefined ? {} : { runId: this._activeContextRunId }),
					createdAt: new Date().toISOString(),
				};
				try {
					persistExecutionAssociation(this.sessionManager, association);
				} catch {
					// Association persistence must not replace a provider result.
				}
			};
			const finishCancelledAttempt = (
				attempt: ModelAttemptLedgerRecord,
				contextSnapshotId: string | undefined,
				visibleOutput: boolean,
			): void => {
				this._pendingProviderFailure = {
					kind: "cancelled",
					category: "cancelled",
					sideEffectStatus: visibleOutput ? "visible" : "none",
					retryable: false,
				};
				persistAttempt({
					...attempt,
					status: "cancelled",
					endedAt: new Date().toISOString(),
					failureCategory: "cancelled",
					visibleOutput,
					...(contextSnapshotId === undefined ? {} : { contextSnapshotId }),
				});
				outerStream.push({
					type: "error",
					reason: "aborted",
					error: createSyntheticModelError(currentModel, "aborted", "Request aborted."),
				});
			};
			const usageForMessage = (message: AssistantMessage) => ({
				input: message.usage.input,
				output: message.usage.output,
				total: message.usage.totalTokens,
				cost: message.usage.cost.total,
			});

			while (true) {
				if (options?.signal?.reason instanceof Error && "code" in options.signal.reason) {
					const code = (options.signal.reason as { code?: unknown }).code;
					if (code === "deadline_exceeded" || code === "cancelled") {
						this._pendingProviderFailure = {
							kind: code,
							category: code,
							sideEffectStatus: "none",
							retryable: false,
						};
					}
				}
				if (options?.signal?.aborted) {
					outerStream.push({
						type: "error",
						reason: "aborted",
						error: createSyntheticModelError(currentModel, "aborted", "Request aborted."),
					});
					return;
				}
				let attemptContextSnapshotId: string | undefined;
				const candidateReference: NormalizedModelReference = candidates[currentOrder] ?? resolution.reference;
				const candidate = {
					provider: candidateReference.provider,
					modelId: candidateReference.id,
					...(candidateReference.thinkingLevel === undefined
						? {}
						: { thinkingLevel: candidateReference.thinkingLevel as ThinkingLevel }),
				};
				const startedAt = new Date().toISOString();
				const startedAttempt: ModelAttemptLedgerRecord = {
					attemptId: `model-attempt:${randomUUID()}`,
					bindingId: ledgerBinding.bindingId,
					candidate,
					order: currentOrder,
					status: "started",
					startedAt,
				};
				let budgetReservationId: string | undefined;
				if (bindingHasBudget) {
					const preflight = this._modelBroker.preflightBudgetForBinding(binding.id, {
						bindingId: binding.id,
					});
					if (!preflight.ok) {
						persistAttempt({
							...startedAttempt,
							status: "failed",
							endedAt: new Date().toISOString(),
							failureCategory: preflight.error.code,
						});
						outerStream.push({
							type: "error",
							reason: "error",
							error: createSyntheticModelError(currentModel, "error", "Model budget exceeded."),
						});
						return;
					}
					budgetReservationId = preflight.preflight.reservation.id;
				}
				persistAttempt(startedAttempt);
				attempts += 1;

				let visibleOutput = false;
				try {
					// Budget preflight and the started attempt are durable before the
					// Context Engine creates the exact snapshot dispatched below.
					currentContext = await prepareFallbackContext(
						currentModel,
						currentOrder === initialCandidateIndex ? undefined : parentSnapshotId,
					);
					if (options?.signal?.aborted) {
						finishCancelledAttempt(startedAttempt, undefined, visibleOutput);
						return;
					}
					if (this.settingsManager.getContextSettings().enabled) {
						attemptContextSnapshotId = this._lastContextSnapshotId;
					}
					persistAttemptAssociation(startedAttempt.attemptId, attemptContextSnapshotId);
					if (options?.signal?.aborted) {
						finishCancelledAttempt(startedAttempt, attemptContextSnapshotId, visibleOutput);
						return;
					}
					const stream = await invoke(currentModel, currentContext, currentOptions);
					let finalError: AssistantMessage | undefined;
					for await (const event of stream) {
						if (options?.signal?.aborted) {
							finishCancelledAttempt(startedAttempt, attemptContextSnapshotId, visibleOutput);
							return;
						}
						if (hasVisibleModelEvent(event)) visibleOutput = true;
						if (event.type === "error") {
							finalError = event.error;
							break;
						}
						if (event.type === "done") {
							this._pendingProviderFailure = undefined;
							const usage = usageForMessage(event.message);
							const budgetSettlement =
								budgetReservationId === undefined
									? undefined
									: this._modelBroker.settleBudgetForBinding(binding.id, budgetReservationId, usage);
							const budgetExceeded =
								budgetSettlement?.ok === false && budgetSettlement.error.code === "model_budget_exceeded";
							persistAttempt({
								...startedAttempt,
								status: "completed",
								endedAt: new Date().toISOString(),
								visibleOutput,
								...(attemptContextSnapshotId === undefined
									? {}
									: { contextSnapshotId: attemptContextSnapshotId }),
								usage,
								...(budgetExceeded ? { summary: "Model budget exceeded; subsequent calls are blocked." } : {}),
							});
							if (budgetExceeded) {
								outerStream.push({
									type: "error",
									reason: "error",
									error: {
										...event.message,
										stopReason: "error",
										errorMessage: "Model budget exceeded.",
									},
								});
							} else {
								outerStream.push(event);
								outerStream.end(event.message);
							}
							return;
						}
						if (!options?.signal?.aborted) outerStream.push(event);
					}

					if (finalError === undefined) {
						const message = await stream.result();
						finalError = message.stopReason === "error" || message.stopReason === "aborted" ? message : undefined;
					}
					if (finalError === undefined) {
						if (budgetReservationId !== undefined) {
							this._modelBroker.settleBudgetForBinding(binding.id, budgetReservationId, {});
						}
						persistAttempt({
							...startedAttempt,
							status: "failed",
							endedAt: new Date().toISOString(),
							failureCategory: "unknown",
							visibleOutput,
							...(attemptContextSnapshotId === undefined ? {} : { contextSnapshotId: attemptContextSnapshotId }),
						});
						outerStream.push({
							type: "error",
							reason: "error",
							error: createSyntheticModelError(currentModel, "error", "The model request failed."),
						});
						return;
					}

					const failure = classifyModelStreamFailure(finalError, { visibleOutput });
					this._pendingProviderFailure = failure;
					const budgetSettlement =
						budgetReservationId === undefined
							? undefined
							: this._modelBroker.settleBudgetForBinding(
									binding.id,
									budgetReservationId,
									usageForMessage(finalError),
								);
					const budgetBlocked = budgetSettlement !== undefined && budgetSettlement.ok === false;
					const fallbackCandidateEligible =
						!options?.signal?.aborted &&
						!visibleOutput &&
						!budgetBlocked &&
						binding.fallbackAllowed &&
						failure.fallbackReason !== undefined &&
						binding.fallback?.on.includes(failure.fallbackReason) === true &&
						this._modelBroker.classifyFallback({
							category: failure.category,
							sideEffectStatus: failure.sideEffectStatus,
						}).eligible;
					const fallbackAllowed = fallbackCandidateEligible && attempts < (binding.fallback?.maxAttempts ?? 1);
					const nextOrder = candidates.findIndex(
						(candidateValue, index) =>
							index > currentOrder &&
							(candidateValue.provider !== currentModel.provider || candidateValue.id !== currentModel.id),
					);
					const fallbackExhausted =
						fallbackCandidateEligible && (nextOrder < 0 || attempts >= (binding.fallback?.maxAttempts ?? 1));
					if (!fallbackAllowed || nextOrder < 0) {
						persistAttempt({
							...startedAttempt,
							status: options?.signal?.aborted ? "cancelled" : "failed",
							endedAt: new Date().toISOString(),
							failureCategory: options?.signal?.aborted
								? "cancelled"
								: budgetBlocked
									? "model_budget_exceeded"
									: (failure.fallbackReason ?? failure.category),
							visibleOutput,
							...(attemptContextSnapshotId === undefined ? {} : { contextSnapshotId: attemptContextSnapshotId }),
							...(budgetBlocked ? { summary: "Model budget exceeded; subsequent calls are blocked." } : {}),
						});
						outerStream.push({
							type: "error",
							reason: options?.signal?.aborted ? "aborted" : "error",
							error: options?.signal?.aborted
								? finalError
								: budgetBlocked
									? createSyntheticModelError(currentModel, "error", "Model budget exceeded.")
									: fallbackExhausted
										? createSyntheticModelError(currentModel, "error", "Model fallback exhausted.")
										: finalError,
						});
						return;
					}

					persistAttempt({
						...startedAttempt,
						status: "failed",
						endedAt: new Date().toISOString(),
						failureCategory: failure.fallbackReason ?? failure.category,
						visibleOutput,
						...(attemptContextSnapshotId === undefined ? {} : { contextSnapshotId: attemptContextSnapshotId }),
					});
					currentOrder = nextOrder;
					const nextReference = candidates[currentOrder];
					if (nextReference === undefined) return;
					const nextModel = this._modelRuntime.getModel(nextReference.provider, nextReference.id);
					if (nextModel === undefined) {
						outerStream.push({
							type: "error",
							reason: "error",
							error: createSyntheticModelError(currentModel, "error", "Model fallback exhausted."),
						});
						return;
					}
					parentSnapshotId = attemptContextSnapshotId ?? parentSnapshotId;
					currentModel = nextModel;
					currentOptions =
						nextReference.thinkingLevel === undefined || nextReference.thinkingLevel === "off"
							? options
							: { ...options, reasoning: nextReference.thinkingLevel as AiThinkingLevel };
				} catch (error) {
					if (error instanceof ContextRuntimeError) {
						this._captureContextError(error);
						if (budgetReservationId !== undefined) {
							this._modelBroker.settleBudgetForBinding(binding.id, budgetReservationId, {});
						}
						persistAttempt({
							...startedAttempt,
							status: "failed",
							endedAt: new Date().toISOString(),
							failureCategory: "context_error",
							visibleOutput,
							...(attemptContextSnapshotId === undefined ? {} : { contextSnapshotId: attemptContextSnapshotId }),
						});
						outerStream.push({
							type: "error",
							reason: "error",
							error: createSyntheticModelError(currentModel, "error", "Context preparation failed."),
						});
						return;
					}
					const failure = classifyModelStreamFailure(error instanceof Error ? error.message : String(error), {
						dispatched: true,
						visibleOutput,
					});
					this._pendingProviderFailure = failure;
					const budgetSettlement =
						budgetReservationId === undefined
							? undefined
							: this._modelBroker.settleBudgetForBinding(binding.id, budgetReservationId, {});
					const budgetBlocked = budgetSettlement !== undefined && budgetSettlement.ok === false;
					const fallbackCandidateEligible =
						!options?.signal?.aborted &&
						!visibleOutput &&
						!budgetBlocked &&
						binding.fallbackAllowed &&
						failure.fallbackReason !== undefined &&
						binding.fallback?.on.includes(failure.fallbackReason) === true &&
						this._modelBroker.classifyFallback({
							category: failure.category,
							sideEffectStatus: failure.sideEffectStatus,
						}).eligible;
					const fallbackAllowed = fallbackCandidateEligible && attempts < (binding.fallback?.maxAttempts ?? 1);
					const nextOrder = candidates.findIndex(
						(candidateValue, index) =>
							index > currentOrder &&
							(candidateValue.provider !== currentModel.provider || candidateValue.id !== currentModel.id),
					);
					const fallbackExhausted =
						fallbackCandidateEligible && (nextOrder < 0 || attempts >= (binding.fallback?.maxAttempts ?? 1));
					if (!fallbackAllowed || nextOrder < 0) {
						persistAttempt({
							...startedAttempt,
							status: options?.signal?.aborted ? "cancelled" : "failed",
							endedAt: new Date().toISOString(),
							failureCategory: options?.signal?.aborted
								? "cancelled"
								: budgetBlocked
									? "model_budget_exceeded"
									: (failure.fallbackReason ?? failure.category),
							visibleOutput,
							...(attemptContextSnapshotId === undefined ? {} : { contextSnapshotId: attemptContextSnapshotId }),
						});
						outerStream.push({
							type: "error",
							reason: options?.signal?.aborted ? "aborted" : "error",
							error: options?.signal?.aborted
								? createSyntheticModelError(currentModel, "aborted", "Request aborted.")
								: budgetBlocked
									? createSyntheticModelError(currentModel, "error", "Model budget exceeded.")
									: fallbackExhausted
										? createSyntheticModelError(currentModel, "error", "Model fallback exhausted.")
										: createSyntheticModelError(currentModel, "error", "The model request failed."),
						});
						return;
					}

					persistAttempt({
						...startedAttempt,
						status: "failed",
						endedAt: new Date().toISOString(),
						failureCategory: failure.fallbackReason ?? failure.category,
						visibleOutput,
						...(attemptContextSnapshotId === undefined ? {} : { contextSnapshotId: attemptContextSnapshotId }),
					});
					currentOrder = nextOrder;
					const nextReference = candidates[currentOrder];
					if (nextReference === undefined) return;
					const nextModel = this._modelRuntime.getModel(nextReference.provider, nextReference.id);
					if (nextModel === undefined) {
						outerStream.push({
							type: "error",
							reason: "error",
							error: createSyntheticModelError(currentModel, "error", "Model fallback exhausted."),
						});
						return;
					}
					parentSnapshotId = attemptContextSnapshotId ?? parentSnapshotId;
					currentModel = nextModel;
					currentOptions =
						nextReference.thinkingLevel === undefined || nextReference.thinkingLevel === "off"
							? options
							: { ...options, reasoning: nextReference.thinkingLevel as AiThinkingLevel };
				}
			}
		})();
		return outerStream;
	}

	/** Build a stream wrapper for direct compaction/branch-summary model calls. */
	private _createSummarizationStreamBoundary(
		purpose: Extract<ContextPurpose, "compaction" | "branch_summary">,
	): StreamFn {
		return async (model, context, options) => {
			try {
				const operation = this._resolveModelBrokerOperation(model);
				model = operation.model;
				const originalMessages = context.messages.slice();
				const originalSystemPrompt = context.systemPrompt;
				const originalTools = context.tools;
				const contextEnabled = this.settingsManager.getContextSettings().enabled;
				if (contextEnabled) {
					this._assertContextPayloadHooksSupported();
				}
				return this._streamWithModelBroker(
					model,
					context,
					options,
					(nextModel, nextContext, nextOptions) =>
						this._getActiveAgentStreamFunction()(nextModel, nextContext, nextOptions),
					async (nextModel, parentSnapshotId) => {
						if (!contextEnabled) {
							return {
								...context,
								systemPrompt: originalSystemPrompt,
								messages: [...originalMessages],
								...(originalTools === undefined ? {} : { tools: originalTools }),
							};
						}
						const sources: ContextSourceInput[] = [
							{
								sourceId: `system:${purpose}:runtime`,
								kind: "system",
								scope: "turn",
								trust: "builtin",
								content: originalSystemPrompt ?? "",
								required: true,
							},
							...this._providerToolContextSources(originalTools),
							...this._contextMessageSources(originalMessages),
						];
						const { plan } = this._resolveAndPersistContextSnapshot({
							purpose,
							model: nextModel,
							messages: originalMessages,
							sources,
							...(parentSnapshotId === undefined ? {} : { parentSnapshotId }),
						});
						return {
							...context,
							systemPrompt: plan.systemPrompt,
							messages: convertToLlm(plan.messages),
							...(originalTools === undefined ? {} : { tools: originalTools }),
						};
					},
					operation.resolution,
				);
			} catch (error) {
				this._captureContextError(error);
				throw error;
			}
		};
	}

	// =========================================================================
	// Event Subscription
	// =========================================================================

	/** Emit an event to all listeners */
	private _emit(event: AgentSessionEvent): void {
		for (const l of this._eventListeners) {
			l(event);
		}
	}

	private _emitQueueUpdate(): void {
		this._emit({
			type: "queue_update",
			steering: [...this._steeringMessages],
			followUp: [...this._followUpMessages],
		});
	}

	private _getIdleWaitPromise(): Promise<void> {
		if (!this._idleWaitPromise) {
			this._idleWaitPromise = new Promise((resolve) => {
				this._resolveIdleWait = resolve;
			});
		}
		return this._idleWaitPromise;
	}

	private _resolveIdleWaitIfIdle(): void {
		if (this._isAgentRunActive || !this._resolveIdleWait) {
			return;
		}
		const resolve = this._resolveIdleWait;
		this._idleWaitPromise = undefined;
		this._resolveIdleWait = undefined;
		resolve();
	}

	private _releaseAgentRunPreflightReservation(reserved: boolean): void {
		if (!reserved) {
			return;
		}
		this._isAgentRunActive = false;
		this._resolveIdleWaitIfIdle();
	}

	private _applyPromptPreflightToolRegistryRefresh(): void {
		if (!this._pendingToolRegistryRefresh) {
			return;
		}
		this._pendingToolRegistryRefresh = false;
		const wasActive = this._isAgentRunActive;
		this._isAgentRunActive = false;
		try {
			this._refreshToolRegistry();
		} finally {
			this._isAgentRunActive = wasActive;
		}
	}

	private async _emitAgentSettled(): Promise<void> {
		this._isAgentRunActive = false;
		try {
			await this._extensionRunner.emit({ type: "agent_settled" });
			this._emit({ type: "agent_settled" });
		} finally {
			this._resolveIdleWaitIfIdle();
		}
		if (this._pendingToolRegistryRefresh) {
			this._pendingToolRegistryRefresh = false;
			this._refreshToolRegistry();
		}
	}

	// Track last assistant message for auto-compaction check
	private _lastAssistantMessage: AssistantMessage | undefined = undefined;

	/** Internal handler for agent events - shared by subscribe and reconnect */
	private _handleAgentEvent = async (event: AgentEvent): Promise<void> => {
		// When a user message starts, check if it's from either queue and remove it BEFORE emitting
		// This ensures the UI sees the updated queue state
		if (event.type === "message_start" && event.message.role === "user") {
			this._overflowRecoveryAttempted = false;
			const messageText = contentText(event.message.content, "");
			if (messageText) {
				// Check steering queue first
				const steeringIndex = this._steeringMessages.indexOf(messageText);
				if (steeringIndex !== -1) {
					this._steeringMessages.splice(steeringIndex, 1);
					this._emitQueueUpdate();
				} else {
					// Check follow-up queue
					const followUpIndex = this._followUpMessages.indexOf(messageText);
					if (followUpIndex !== -1) {
						this._followUpMessages.splice(followUpIndex, 1);
						this._emitQueueUpdate();
					}
				}
			}
		}

		// Emit to extensions first
		await this._emitExtensionEvent(event);

		// Notify all listeners
		this._emit(event.type === "agent_end" ? { ...event, willRetry: this._willRetryAfterAgentEnd(event) } : event);

		// Handle session persistence
		if (event.type === "message_end") {
			// Check if this is a custom message from extensions
			if (event.message.role === "custom") {
				// Persist as CustomMessageEntry
				this.sessionManager.appendCustomMessageEntry(
					event.message.customType,
					event.message.content,
					event.message.display,
					event.message.details,
				);
			} else if (
				event.message.role === "user" ||
				event.message.role === "assistant" ||
				event.message.role === "toolResult"
			) {
				// Regular LLM message - persist as SessionMessageEntry
				this.sessionManager.appendMessage(event.message);
			}
			// Other message types (bashExecution, compactionSummary, branchSummary) are persisted elsewhere

			// Track assistant message for auto-compaction (checked on agent_end)
			if (event.message.role === "assistant") {
				this._lastAssistantMessage = event.message;

				const assistantMsg = event.message as AssistantMessage;
				if (assistantMsg.stopReason !== "error" && assistantMsg.stopReason !== "length") {
					this._overflowRecoveryAttempted = false;
				}

				// Reset retry counter immediately on successful assistant response
				// This prevents accumulation across multiple LLM calls within a turn
				if (assistantMsg.stopReason !== "error" && this._retryAttempt > 0) {
					this._emit({
						type: "auto_retry_end",
						success: true,
						attempt: this._retryAttempt,
					});
					this._retryAttempt = 0;
				}
			}
		}
	};

	private _willRetryAfterAgentEnd(event: Extract<AgentEvent, { type: "agent_end" }>): boolean {
		const settings = this.settingsManager.getRetrySettings();
		if (!settings.enabled || this._retryAttempt >= settings.maxRetries) {
			return false;
		}

		for (let i = event.messages.length - 1; i >= 0; i--) {
			const message = event.messages[i];
			if (message.role === "assistant") {
				return this._isRetryableError(message as AssistantMessage);
			}
		}
		return false;
	}

	/** Find the last assistant message in agent state (including aborted ones) */
	private _findLastAssistantMessage(): AssistantMessage | undefined {
		const messages = this.agent.state.messages;
		for (let i = messages.length - 1; i >= 0; i--) {
			const msg = messages[i];
			if (msg.role === "assistant") {
				return msg as AssistantMessage;
			}
		}
		return undefined;
	}

	private _replaceMessageInPlace(target: AgentMessage, replacement: AgentMessage): void {
		// Agent-core stores the finalized message object in its state before emitting message_end.
		// SessionManager persistence happens later in _handleAgentEvent() with event.message.
		// Mutating this object in place keeps agent state, later turn/agent events, listeners,
		// and the eventual SessionManager.appendMessage(event.message) persistence in sync.
		if (target === replacement) {
			return;
		}

		const targetRecord = target as unknown as Record<string, unknown>;
		for (const key of Object.keys(targetRecord)) {
			delete targetRecord[key];
		}
		Object.assign(targetRecord, replacement);
	}

	/** Emit extension events based on agent events */
	private async _emitExtensionEvent(event: AgentEvent): Promise<void> {
		if (event.type === "agent_start") {
			this._turnIndex = 0;
			await this._extensionRunner.emit({ type: "agent_start" });
		} else if (event.type === "agent_end") {
			await this._extensionRunner.emit({ type: "agent_end", messages: event.messages });
		} else if (event.type === "turn_start") {
			const extensionEvent: TurnStartEvent = {
				type: "turn_start",
				turnIndex: this._turnIndex,
				timestamp: Date.now(),
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "turn_end") {
			const extensionEvent: TurnEndEvent = {
				type: "turn_end",
				turnIndex: this._turnIndex,
				message: event.message,
				toolResults: event.toolResults,
			};
			await this._extensionRunner.emit(extensionEvent);
			this._turnIndex++;
		} else if (event.type === "message_start") {
			const extensionEvent: MessageStartEvent = {
				type: "message_start",
				message: event.message,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "message_update") {
			const extensionEvent: MessageUpdateEvent = {
				type: "message_update",
				message: event.message,
				assistantMessageEvent: event.assistantMessageEvent,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "message_end") {
			const extensionEvent: MessageEndEvent = {
				type: "message_end",
				message: event.message,
			};
			const replacement = await this._extensionRunner.emitMessageEnd(extensionEvent);
			if (replacement) {
				// Untyped extension handlers can return messages with null/missing content;
				// normalize so it never enters agent state or session history.
				const normalized =
					(replacement.role === "user" ||
						replacement.role === "assistant" ||
						replacement.role === "toolResult" ||
						replacement.role === "custom") &&
					replacement.content == null
						? ({ ...replacement, content: [] } as AgentMessage)
						: replacement;
				this._replaceMessageInPlace(event.message, normalized);
			}
		} else if (event.type === "tool_execution_start") {
			const extensionEvent: ToolExecutionStartEvent = {
				type: "tool_execution_start",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "tool_execution_update") {
			const extensionEvent: ToolExecutionUpdateEvent = {
				type: "tool_execution_update",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				args: event.args,
				partialResult: event.partialResult,
			};
			await this._extensionRunner.emit(extensionEvent);
		} else if (event.type === "tool_execution_end") {
			const extensionEvent: ToolExecutionEndEvent = {
				type: "tool_execution_end",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				result: event.result,
				isError: event.isError,
			};
			await this._extensionRunner.emit(extensionEvent);
		}
	}

	/**
	 * Subscribe to agent events.
	 * Session persistence is handled internally (saves messages on message_end).
	 * Multiple listeners can be added. Returns unsubscribe function for this listener.
	 */
	subscribe(listener: AgentSessionEventListener): () => void {
		this._eventListeners.push(listener);

		// Return unsubscribe function for this specific listener
		return () => {
			const index = this._eventListeners.indexOf(listener);
			if (index !== -1) {
				this._eventListeners.splice(index, 1);
			}
		};
	}

	/** Disconnect from agent events during disposal. */
	private _disconnectFromAgent(): void {
		if (this._unsubscribeAgent) {
			this._unsubscribeAgent();
			this._unsubscribeAgent = undefined;
		}
	}

	/**
	 * Remove all listeners and disconnect from agent.
	 * Call this when completely done with the session.
	 */
	dispose(): void {
		try {
			this.abortRetry();
			this.abortCompaction();
			this.abortBranchSummary();
			this.abortBash();
			this.agent.abort();
		} catch {
			// Dispose must succeed even if an abort hook throws.
		}
		this._disposePolicyBoundaryPromise ??= this._disposePolicyBoundaryResources();

		this._extensionRunner.invalidate(
			"This extension ctx is stale after session replacement or reload. Do not use a captured agent or command ctx after ctx.newSession(), ctx.fork(), ctx.switchSession(), or ctx.reload(). For newSession, fork, and switchSession, move post-replacement work into withSession and use the ctx passed to withSession. For reload, do not use the old ctx after await ctx.reload().",
		);
		this._disconnectFromAgent();
		this._eventListeners = [];
		cleanupSessionResources(this.sessionId);
	}

	/** Resolves after async policy-boundary cleanup started by dispose() settles. */
	waitForDispose(): Promise<void> {
		return this._disposePolicyBoundaryPromise ?? Promise.resolve();
	}

	// =========================================================================
	// Read-only State Access
	// =========================================================================

	/** Full agent state */
	get state(): AgentState {
		return this.agent.state;
	}

	/** Current model (may be undefined if not yet selected) */
	get model(): Model<any> | undefined {
		return this.agent.state.model;
	}

	/** Current thinking level */
	get thinkingLevel(): ThinkingLevel {
		return this.agent.state.thinkingLevel;
	}

	/** Whether the session is currently processing an agent run or post-run continuation. */
	get isStreaming(): boolean {
		return this._isAgentRunActive;
	}

	/** Whether the session has no active agent run, retry, auto-compaction, or queued continuation. */
	get isIdle(): boolean {
		return !this._isAgentRunActive;
	}

	/** Current effective system prompt (includes any per-turn extension modifications) */
	get systemPrompt(): string {
		return this.agent.state.systemPrompt;
	}

	/** Current retry attempt (0 if not retrying) */
	get retryAttempt(): number {
		return this._retryAttempt;
	}

	/**
	 * Get the names of currently active tools.
	 * Returns the names of tools currently set on the agent.
	 */
	getActiveToolNames(): string[] {
		return this.agent.state.tools.map((t) => t.name);
	}

	/**
	 * Get all configured tools with name, description, parameter schema, prompt guidelines, and source metadata.
	 */
	getAllTools(): ToolInfo[] {
		return Array.from(this._toolDefinitions.values()).map(({ definition, sourceInfo }) => ({
			name: definition.name,
			description: definition.description,
			parameters: definition.parameters,
			promptGuidelines: definition.promptGuidelines,
			sourceInfo,
		}));
	}

	getToolDefinition(name: string): ToolDefinition | undefined {
		return this._toolDefinitions.get(name)?.definition;
	}

	/**
	 * Set active tools by name.
	 * Only tools in the registry (already bounded by the frozen capability
	 * binding) can be enabled. Unknown tool names are ignored.
	 * Also rebuilds the system prompt to reflect the new tool set.
	 * Changes take effect on the next provider request. The capability binding and
	 * tool registry remain frozen during a run; changing the active subset does
	 * not rebuild either one.
	 */
	setActiveToolsByName(toolNames: string[]): void {
		const tools: AgentTool[] = [];
		const validToolNames: string[] = [];
		for (const name of toolNames) {
			const tool = this._toolRegistry.get(name);
			if (tool) {
				tools.push(tool);
				validToolNames.push(name);
			}
		}
		this.agent.state.tools = tools;

		// Rebuild base system prompt with new tool set
		this._baseSystemPrompt = this._rebuildSystemPrompt(validToolNames);
		this.agent.state.systemPrompt = this._systemPromptOverride ?? this._baseSystemPrompt;
	}

	/** Whether compaction or branch summarization is currently running */
	get isCompacting(): boolean {
		return (
			this._autoCompactionAbortController !== undefined ||
			this._compactionAbortController !== undefined ||
			this._branchSummaryAbortController !== undefined
		);
	}

	/** All messages including custom types like BashExecutionMessage */
	get messages(): AgentMessage[] {
		return this.agent.state.messages;
	}

	/** Current steering mode */
	get steeringMode(): "all" | "one-at-a-time" {
		return this.agent.steeringMode;
	}

	/** Current follow-up mode */
	get followUpMode(): "all" | "one-at-a-time" {
		return this.agent.followUpMode;
	}

	/** Current session file path, or undefined if sessions are disabled */
	get sessionFile(): string | undefined {
		return this.sessionManager.getSessionFile();
	}

	/** Current session ID */
	get sessionId(): string {
		return this.sessionManager.getSessionId();
	}

	/** Current session display name, if set */
	get sessionName(): string | undefined {
		return this.sessionManager.getSessionName();
	}

	/** Scoped models for cycling (from --models flag) */
	get scopedModels(): ReadonlyArray<{ model: Model<any>; thinkingLevel?: ThinkingLevel }> {
		return this._scopedModels;
	}

	/** Update scoped models for cycling */
	setScopedModels(scopedModels: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>): void {
		this._scopedModels = scopedModels;
	}

	/** File-based prompt templates */
	get promptTemplates(): ReadonlyArray<PromptTemplate> {
		return this._resourceLoader.getPrompts().prompts;
	}

	private _normalizePromptSnippet(text: string | undefined): string | undefined {
		if (!text) return undefined;
		const oneLine = text
			.replace(/[\r\n]+/g, " ")
			.replace(/\s+/g, " ")
			.trim();
		return oneLine.length > 0 ? oneLine : undefined;
	}

	private _normalizePromptGuidelines(guidelines: string[] | undefined): string[] {
		if (!guidelines || guidelines.length === 0) {
			return [];
		}

		const unique = new Set<string>();
		for (const guideline of guidelines) {
			const normalized = guideline.trim();
			if (normalized.length > 0) {
				unique.add(normalized);
			}
		}
		return Array.from(unique);
	}

	private _rebuildSystemPrompt(toolNames: string[]): string {
		const validToolNames = toolNames.filter((name) => this._toolRegistry.has(name));
		const toolSnippets: Record<string, string> = {};
		const promptGuidelines: string[] = [];
		for (const name of validToolNames) {
			const snippet = this._toolPromptSnippets.get(name);
			if (snippet) {
				toolSnippets[name] = snippet;
			}

			const toolGuidelines = this._toolPromptGuidelines.get(name);
			if (toolGuidelines) {
				promptGuidelines.push(...toolGuidelines);
			}
		}

		const loaderSystemPrompt = this._resourceLoader.getSystemPrompt();
		const loaderAppendSystemPrompt = this._resourceLoader.getAppendSystemPrompt();
		const appendSystemPrompt =
			loaderAppendSystemPrompt.length > 0 ? loaderAppendSystemPrompt.join("\n\n") : undefined;
		const contextEnabled = this.settingsManager.getContextSettings().enabled;
		const legacyInstructionBlocks = contextEnabled
			? []
			: this._resourceLoader
					.getContextSources()
					.contextSources.filter((source) => source.injectable)
					.map((source) => ({
						sourceId: source.sourceId,
						path: source.path,
						content: source.content,
						scope: source.scope,
						trust: source.trust,
					}));
		this._baseSystemPromptOptions = {
			cwd: this._cwd,
			// Context Engine appends only sources that its plan admitted. Keeping
			// instructions and the skill index out of its base prevents a second,
			// unaccounted injection path. An explicit opt-out retains legacy prompt
			// assembly for callers that disable the engine.
			skills: contextEnabled ? [] : this._resourceLoader.getSkills().skills,
			instructionBlocks: legacyInstructionBlocks,
			customPrompt: loaderSystemPrompt,
			appendSystemPrompt,
			selectedTools: validToolNames,
			toolSnippets,
			promptGuidelines,
		};
		return buildSystemPrompt(this._baseSystemPromptOptions);
	}

	/** Latest Context Snapshot id for Run receipts and inspection surfaces. */
	getLastContextSnapshotId(): string | undefined {
		return this._lastContextSnapshotId ?? this.sessionManager.getLatestContextSnapshotId();
	}

	/** Snapshot produced by the most recent actual model call for a given Automation Host run. */
	getContextSnapshotIdForRun(runId: string): string | undefined {
		return this._contextSnapshotIdsByRun.get(runId);
	}

	/**
	 * Read-only Context Engine inspection for `/context` and RPC `get_context`.
	 * Never returns raw instruction bodies, memory text, tool output, or credentials.
	 * Preview mode (no snapshotId) does not write Session.
	 */
	async inspectContext(options?: { snapshotId?: string }): Promise<{
		snapshot: ContextSnapshot;
		drift: ContextSourceDrift[];
		preview: boolean;
	}> {
		const currentSources = await this._collectCurrentContextSources();
		if (options?.snapshotId) {
			const snapshot = this.sessionManager.getContextSnapshot(options.snapshotId);
			if (!snapshot) {
				const error = createContextError(
					"context_snapshot_not_found",
					`Context snapshot not found: ${options.snapshotId}`,
					false,
				);
				const err = new Error(error.message) as Error & { contextError: ContextError };
				err.contextError = error;
				err.name = "ContextEngineError";
				throw err;
			}
			return {
				snapshot,
				drift: compareContextSources(snapshot, currentSources),
				preview: false,
			};
		}

		const contextSettings = this.settingsManager.getContextSettings();
		const resolveResult = resolveContext({
			purpose: "agent_turn",
			sessionId: this.sessionManager.getSessionId(),
			contextWindow: this.model?.contextWindow ?? 0,
			reserveTokens: contextSettings.reserveTokens,
			sources: currentSources,
			sessionMessages: this.sessionManager.buildSessionContext().messages,
			turnMessages: [],
		});
		if (!resolveResult.ok) {
			const err = new Error(resolveResult.error.message) as Error & { contextError: ContextError };
			err.contextError = resolveResult.error;
			err.name = "ContextEngineError";
			throw err;
		}
		const snapshot = freezeContext(resolveResult.plan, {
			id: "preview",
			createdAt: new Date().toISOString(),
		});
		return { snapshot, drift: [], preview: true };
	}

	/** Explicit session/project memory write. Requires settings enablement for the scope. */
	async addContextMemory(input: {
		scope: ContextMemoryScope;
		text: string;
		sourceEntryIds?: string[];
	}): Promise<ContextMemory> {
		const memorySettings = this.settingsManager.getMemorySettings();
		if (input.scope === "session" && !memorySettings.sessionEnabled) {
			const error = createContextError(
				"context_memory_disabled",
				"Session memory is disabled (settings.memory.sessionEnabled)",
				false,
			);
			const err = new Error(error.message) as Error & { contextError: ContextError };
			err.contextError = error;
			err.name = "ContextEngineError";
			throw err;
		}
		if (input.scope === "project" && !memorySettings.projectEnabled) {
			const error = createContextError(
				"context_memory_disabled",
				"Project memory is disabled (settings.memory.projectEnabled)",
				false,
			);
			const err = new Error(error.message) as Error & { contextError: ContextError };
			err.contextError = error;
			err.name = "ContextEngineError";
			throw err;
		}
		return this._contextMemoryStore.add({
			scope: input.scope,
			text: input.text,
			sourceEntryIds: input.sourceEntryIds,
			sessionId: this.sessionManager.getSessionId(),
			projectRoot: this._cwd,
			appendSessionEntry: (customType, data) => this.sessionManager.appendCustomEntry(customType, data),
		});
	}

	async listContextMemory(scope?: ContextMemoryScope): Promise<ContextMemory[]> {
		const scopes: ContextMemoryScope[] = scope ? [scope] : ["session", "project"];
		const sessionEntries = this.sessionManager
			.getEntries()
			.filter((entry): entry is Extract<SessionEntry, { type: "custom" }> => entry.type === "custom")
			.map((entry) => ({ customType: entry.customType, data: entry.data }));
		const out: ContextMemory[] = [];
		for (const s of scopes) {
			const list = await this._contextMemoryStore.list({
				scope: s,
				sessionId: this.sessionManager.getSessionId(),
				projectRoot: this._cwd,
				sessionCustomEntries: sessionEntries,
			});
			out.push(...list);
		}
		return out;
	}

	async revokeContextMemory(input: { id: string; scope?: ContextMemoryScope }): Promise<void> {
		let scope = input.scope;
		if (!scope) {
			const matches = (await this.listContextMemory()).filter((memory) => memory.id === input.id);
			const memory = matches[0];
			if (!memory || matches.length !== 1) {
				const error = createContextError(
					"context_memory_not_found",
					matches.length === 0
						? `Active context memory not found: ${input.id}`
						: `Context memory id is ambiguous: ${input.id}`,
					false,
				);
				const err = new Error(error.message) as Error & { contextError: ContextError };
				err.contextError = error;
				err.name = "ContextEngineError";
				throw err;
			}
			scope = memory.scope;
		}
		await this._contextMemoryStore.revoke({
			id: input.id,
			scope,
			sessionId: this.sessionManager.getSessionId(),
			projectRoot: this._cwd,
			appendSessionEntry: (customType, data) => this.sessionManager.appendCustomEntry(customType, data),
		});
	}

	private _contextMessageSources(messages: readonly AgentMessage[]): ContextSourceInput[] {
		return messages.map((message, index) => {
			const kind =
				message.role === "branchSummary" || message.role === "compactionSummary"
					? ("session_summary" as const)
					: ("session_message" as const);
			const serialized = JSON.stringify(message);
			return {
				sourceId: `session:${kind}:${index}`,
				kind,
				scope: "session",
				trust: "builtin",
				content: typeof serialized === "string" ? serialized : "",
				required: true,
				placement: "message",
				message,
				alreadyIncludedInMessages: true,
			};
		});
	}

	private _formatInstructionSource(source: ContextSourceInput): ContextSourceInput {
		const path = source.path ?? source.sourceId;
		return {
			...source,
			content: `<project_instructions path="${path}">\n${source.content}\n</project_instructions>`,
		};
	}

	private _formatMemorySource(source: ContextSourceInput): ContextSourceInput {
		const refId = source.refId ?? source.sourceId;
		return {
			...source,
			content: `<explicit_memory id="${refId}" scope="${source.scope}">\n${source.content}\n</explicit_memory>`,
		};
	}

	private _providerToolContextSources(tools: readonly Tool[] | undefined): ContextSourceInput[] {
		if (!tools || tools.length === 0) {
			return [];
		}

		const sourceIds = new Set<string>();
		return tools.map((tool) => {
			const sourceId = `capability:tool:${tool.name}`;
			if (sourceIds.has(sourceId)) {
				throw new ContextRuntimeError(
					createContextError(
						"context_source_unavailable",
						`Provider tool schema is ambiguous for tool: ${tool.name}`,
						false,
					),
				);
			}
			sourceIds.add(sourceId);

			let content: string;
			try {
				const serialized = JSON.stringify({
					name: tool.name,
					description: tool.description,
					parameters: tool.parameters,
					constrainedSampling: tool.constrainedSampling,
				});
				if (serialized === undefined) {
					throw new Error("Provider tool schema did not serialize");
				}
				content = serialized;
			} catch {
				throw new ContextRuntimeError(
					createContextError(
						"context_source_unavailable",
						`Provider tool schema cannot be serialized for tool: ${tool.name}`,
						false,
					),
				);
			}

			const capability = this._bindingDescriptorForToolName(tool.name);
			const source: ContextSourceInput = {
				sourceId,
				kind: "capability_index",
				scope: "turn",
				trust: "builtin",
				content,
				required: true,
			};
			if (capability) {
				source.capabilityId = capability.id;
				source.capabilityRevision = capability.revision;
				source.capabilityBindingId = this._activeCapabilityBinding?.id;
			}
			return source;
		});
	}

	private async _collectAgentTurnContextSources(
		messages: readonly AgentMessage[],
		extraSources: readonly ContextSourceInput[] = [],
		tools: readonly Tool[] | undefined = this.agent.state.tools,
	): Promise<ContextSourceInput[]> {
		const sources: ContextSourceInput[] = [
			{
				sourceId: "system:runtime",
				kind: "system",
				scope: "global",
				trust: "builtin",
				content: this._baseSystemPrompt,
				required: true,
			},
		];

		for (const source of this._resourceLoader.toContextSourceInputs()) {
			// Custom/append system prompts are already rendered in system:runtime.
			// Keeping them here would make a second, unplanned injection path.
			if (source.kind === "system") {
				continue;
			}
			sources.push(source.kind === "instruction" ? this._formatInstructionSource(source) : source);
		}

		// The Capability Registry binding decides which skills are exposed. The
		// loader no longer builds a full skill index; this source is derived from
		// the frozen binding and carries its id for audit.
		const skillIndex = this._skillCapabilityIndexSource();
		if (skillIndex) {
			sources.push(skillIndex);
		}

		for (const source of await this._collectMemorySources()) {
			sources.push(this._formatMemorySource(source));
		}

		sources.push(
			...this._providerToolContextSources(tools),
			...extraSources,
			...this._contextMessageSources(messages),
		);
		return sources;
	}

	private async _collectCurrentContextSources(): Promise<ContextSourceInput[]> {
		const messages = this.sessionManager.buildSessionContext().messages;
		return this._collectAgentTurnContextSources(messages, [], this.agent.state.tools);
	}

	/**
	 * Reject an initial prompt before Agent startup when required context cannot
	 * fit. The stream boundary still creates the authoritative snapshot from the
	 * provider-ready request immediately before every actual model call.
	 */
	private async _validateInitialContextBudget(turnMessages: readonly AgentMessage[]): Promise<void> {
		if (!this.settingsManager.getContextSettings().enabled || !this.model) {
			return;
		}
		// Pre-prompt compaction may intentionally remove a retriable overflow
		// response from agent state after rebuilding the persisted session context.
		// Validate the exact state that the next Agent run will use.
		const sessionMessages = this.agent.state.messages;
		const sources = await this._collectAgentTurnContextSources(
			[...sessionMessages, ...turnMessages],
			[...this._pendingExtensionContextSources, ...this._currentMcpAttachmentSources()],
			this.agent.state.tools,
		);
		const contextSettings = this.settingsManager.getContextSettings();
		const result = resolveContext({
			purpose: "agent_turn",
			sessionId: this.sessionManager.getSessionId(),
			runId: this._activeContextRunId,
			contextWindow: this.model.contextWindow,
			reserveTokens: contextSettings.reserveTokens,
			sources,
			sessionMessages,
			turnMessages,
		});
		if (result.ok) {
			return;
		}
		throw new ContextRuntimeError(result.error);
	}

	/**
	 * Resolve, freeze, and persist a metadata-only Context Snapshot immediately
	 * before an actual model call. The plan is also the exact system prompt and
	 * message set passed through the in-process stream boundary.
	 */
	private _resolveAndPersistContextSnapshot(input: {
		purpose: ContextPurpose;
		model: Model<any>;
		messages: readonly AgentMessage[];
		sources: readonly ContextSourceInput[];
		runId?: string;
		parentSnapshotId?: string;
	}): { plan: ContextPlan; snapshot: ContextSnapshot } {
		const contextSettings = this.settingsManager.getContextSettings();
		const resolveResult = resolveContext({
			purpose: input.purpose,
			sessionId: this.sessionManager.getSessionId(),
			runId: input.runId,
			contextWindow: input.model.contextWindow,
			reserveTokens: contextSettings.reserveTokens,
			sources: input.sources,
			sessionMessages: input.messages,
			turnMessages: [],
		});

		if (!resolveResult.ok) {
			throw new ContextRuntimeError(resolveResult.error);
		}

		const parentSnapshotId = input.parentSnapshotId ?? this._parentContextSnapshotId;
		const snapshot = freezeContext(resolveResult.plan, {
			id: randomUUID(),
			createdAt: new Date().toISOString(),
			parentSnapshotId,
		});

		try {
			this.sessionManager.appendCustomEntry(CONTEXT_SNAPSHOT_CUSTOM_TYPE, snapshot);
		} catch (cause) {
			const error = createContextError(
				"context_snapshot_persistence_failed",
				cause instanceof Error ? cause.message : "Failed to persist context snapshot",
				true,
			);
			throw new ContextRuntimeError(error);
		}

		this._lastContextSnapshotId = snapshot.id;
		this._parentContextSnapshotId = snapshot.id;
		if (input.runId) {
			this._contextSnapshotIdsByRun.set(input.runId, snapshot.id);
		}
		return { plan: resolveResult.plan, snapshot };
	}

	private async _collectMemorySources(): Promise<ContextSourceInput[]> {
		const memorySettings = this.settingsManager.getMemorySettings();
		const sources: ContextSourceInput[] = [];
		const sessionEntries = this.sessionManager
			.getEntries()
			.filter((entry): entry is Extract<SessionEntry, { type: "custom" }> => entry.type === "custom")
			.map((entry) => ({ customType: entry.customType, data: entry.data }));

		if (memorySettings.sessionEnabled) {
			const sessionMemories = await this._contextMemoryStore.list({
				scope: "session",
				sessionId: this.sessionManager.getSessionId(),
				sessionCustomEntries: sessionEntries,
			});
			sources.push(...memoryToContextSourceInputs(sessionMemories, { enabled: true }));
		}

		if (memorySettings.projectEnabled) {
			const projectMemories = await this._contextMemoryStore.list({
				scope: "project",
				projectRoot: this._cwd,
			});
			sources.push(...memoryToContextSourceInputs(projectMemories, { enabled: true }));
		}

		return sources;
	}

	private _extensionSourcesFromBeforeAgentStart(
		contributions: readonly ContextExtensionContributionAttribution[],
	): ContextSourceInput[] {
		const sources: ContextSourceInput[] = [];
		for (const { contribution } of contributions) {
			try {
				sources.push(createContextExtensionSourceInput(contribution));
			} catch {
				throw new ContextRuntimeError(
					createContextError(
						"context_extension_source_missing",
						`Invalid Context extension contribution: ${contribution.sourceId}`,
						false,
					),
				);
			}
		}
		return sources;
	}

	// =========================================================================
	// Prompting
	// =========================================================================

	private _assertContextPayloadHooksSupported(): void {
		if (
			this.settingsManager.getContextSettings().enabled &&
			this._extensionRunner.hasHandlers("before_provider_request")
		) {
			throw new ContextRuntimeError(
				createContextError(
					"context_extension_source_missing",
					"before_provider_request is unavailable while Context Engine is enabled because provider payload rewrites cannot be verified against the Context snapshot",
					false,
				),
			);
		}
	}

	private async _prepareAgentRun(signal?: AbortSignal): Promise<void> {
		this._refreshContextEngineStreamBoundary();
		this._assertContextPayloadHooksSupported();
		await this.whenCapabilitiesReady(this._activeContextRunId, signal);
		this._applyPromptPreflightToolRegistryRefresh();
		await this._ensureExecutionPolicyReady(this._activeContextRunId, signal, { deferMcpReconnect: true });
	}

	private async _runAgentPrompt(
		messages: AgentMessage | AgentMessage[],
		options: { agentRunAlreadyActive?: boolean } = {},
	): Promise<void> {
		this._isAgentRunActive = true;
		this._beginModelBrokerOperation();
		this._pendingContextError = undefined;
		const runPreparedPrompt = async (): Promise<void> => {
			await this.agent.runPreparedPrompt(messages);
			this._throwPendingContextError();
			while (await this._handlePostAgentRun()) {
				await this.agent.runPreparedContinuation();
				this._throwPendingContextError();
			}
		};
		try {
			if (options.agentRunAlreadyActive) {
				await runPreparedPrompt();
			} else {
				// Gate every run start on capability readiness so discovery (and any
				// fail-closed conflict) settles before any provider/tool execution,
				// including run starts that bypass prompt() preflight.
				await this.agent.runWithPreflight(
					async (signal) => await this._prepareAgentRun(signal),
					async () => await runPreparedPrompt(),
				);
			}
		} finally {
			if (!options.agentRunAlreadyActive) {
				await this._finishAgentPrompt();
			}
		}
	}

	private async _finishAgentPrompt(): Promise<void> {
		this._systemPromptOverride = undefined;
		this._activeContextRunId = undefined;
		this._pendingExtensionContextSources = [];
		this._pendingMcpAttachments = [];
		this._pendingContextError = undefined;
		this._pendingProviderFailure = undefined;
		this._flushPendingBashMessages();
		await this._emitAgentSettled();
		this._operationModelResolution = undefined;
		this._executionPolicyPreviousBindingIdForRun = undefined;
	}

	private async _handlePostAgentRun(): Promise<boolean> {
		const msg = this._lastAssistantMessage;
		this._lastAssistantMessage = undefined;
		if (!msg) {
			return false;
		}

		if (this._isRetryableError(msg) && (await this._prepareRetry(msg))) {
			return true;
		}

		if (msg.stopReason === "error" && this._retryAttempt > 0) {
			this._emit({
				type: "auto_retry_end",
				success: false,
				attempt: this._retryAttempt,
				finalError: msg.errorMessage,
			});
			this._retryAttempt = 0;
		}

		if (await this._checkCompaction(msg)) {
			return true;
		}

		// The agent loop drains both queues before emitting agent_end. Any messages
		// here were queued by agent_end extension handlers and need a continuation.
		return this.agent.hasQueuedMessages();
	}

	/**
	 * Send a prompt to the agent.
	 * - Handles extension commands (registered via agent.registerCommand) immediately, even during streaming
	 * - Expands file-based prompt templates by default
	 * - During streaming, queues via steer() or followUp() based on streamingBehavior option
	 * - Validates model and API key before sending (when not streaming)
	 * @throws Error if streaming and no streamingBehavior specified
	 * @throws Error if no model selected or no API key available (when not streaming)
	 */
	async prompt(text: string, options?: PromptOptions): Promise<void> {
		if (options?.signal?.aborted) throw operationAbortReason(options.signal);
		const expandPromptTemplates = options?.expandPromptTemplates ?? true;
		const preflightResult = options?.preflightResult;
		let messages: AgentMessage[] | undefined;
		let reservedRunActive = false;

		try {
			// Handle extension commands first (execute immediately, even during streaming)
			// Extension commands manage their own LLM interaction via agent.sendMessage()
			if (expandPromptTemplates && text.startsWith("/")) {
				const handled = await this._tryExecuteExtensionCommand(text);
				if (handled) {
					// Extension command executed, no prompt to send
					preflightResult?.(true);
					return;
				}
			}

			if (this._compactionAbortController !== undefined) {
				throw new Error(
					"Cannot submit a prompt while compaction is in progress. Wait for compaction to finish and retry.",
				);
			}

			// Emit input event for extension interception (before skill/template expansion)
			let currentText = text;
			let currentImages = options?.images;
			if (this._extensionRunner.hasHandlers("input")) {
				const inputResult = await this._extensionRunner.emitInput(
					currentText,
					currentImages,
					options?.source ?? "interactive",
					this.isStreaming ? options?.streamingBehavior : undefined,
				);
				if (inputResult.action === "handled") {
					preflightResult?.(true);
					return;
				}
				if (inputResult.action === "transform") {
					currentText = inputResult.text;
					currentImages = inputResult.images ?? currentImages;
				}
			}

			// Expand skill commands (/skill:name args) and prompt templates (/template args)
			let expandedText = currentText;
			if (expandPromptTemplates) {
				expandedText = this._expandSkillCommand(expandedText);
				expandedText = expandPromptTemplate(expandedText, [...this.promptTemplates]);
			}

			// If streaming, queue via steer() or followUp() based on option
			if (this.isStreaming) {
				if (!options?.streamingBehavior) {
					throw new Error(
						"Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
					);
				}
				if (options.streamingBehavior === "followUp") {
					await this._queueFollowUp(expandedText, currentImages);
				} else {
					await this._queueSteer(expandedText, currentImages);
				}
				preflightResult?.(true);
				return;
			}

			// Flush any pending bash messages before the new prompt
			this._flushPendingBashMessages();

			// Validate model
			if (!this.model) {
				throw new Error(formatNoModelSelectedMessage());
			}

			const hasConfiguredAuth =
				this._modelRuntime.hasConfiguredAuth(this.model.provider) ||
				(await this._modelRuntime.checkAuth(this.model.provider)) !== undefined;
			if (!hasConfiguredAuth) {
				const isOAuth = this._modelRuntime.isUsingOAuth(this.model.provider);
				if (isOAuth) {
					throw new Error(
						`Authentication failed for "${this.model.provider}". ` +
							`Credentials may have expired or network is unavailable. ` +
							`Run '/login ${this.model.provider}' to re-authenticate.`,
					);
				}
				throw new Error(formatNoApiKeyFoundMessage(this.model.provider));
			}

			// A provider payload rewrite is not structurally comparable with the
			// Context plan, so reject it before any compaction or Agent-loop call.
			this._assertContextPayloadHooksSupported();
			this._isAgentRunActive = true;
			reservedRunActive = true;

			// Check if we need to compact before sending (catches aborted responses).
			// The user's new prompt is sent below, so do not call agent.continue() here.
			const lastAssistant = this._findLastAssistantMessage();
			if (lastAssistant) {
				await this._checkCompaction(lastAssistant, false);
			}

			// Build messages array (custom message if any, then user message)
			messages = [];

			// Add user message
			const userContent: (TextContent | ImageContent)[] = [{ type: "text", text: expandedText }];
			if (currentImages) {
				userContent.push(...currentImages);
			}
			messages.push({
				role: "user",
				content: userContent,
				timestamp: Date.now(),
			});

			// Inject any pending "nextTurn" messages as context alongside the user message
			for (const msg of this._pendingNextTurnMessages) {
				messages.push(msg);
			}
			this._pendingNextTurnMessages = [];

			// Emit before_agent_start extension event
			const result = await this._extensionRunner.emitBeforeAgentStart(
				expandedText,
				currentImages,
				this._baseSystemPrompt,
				this._baseSystemPromptOptions,
			);
			const contextEnabled = this.settingsManager.getContextSettings().enabled;
			if (contextEnabled) {
				if (result?.contributionError) {
					throw new ContextRuntimeError(
						createContextError(result.contributionError.code, result.contributionError.message, false),
					);
				}
				if (result?.unattributedMutation) {
					throw new ContextRuntimeError(
						createContextError(
							"context_extension_source_missing",
							"before_agent_start changed model input without a typed Context contribution",
							false,
						),
					);
				}
				this._pendingExtensionContextSources = this._extensionSourcesFromBeforeAgentStart(
					result?.contributions ?? [],
				);
				this._systemPromptOverride = undefined;
				this.agent.state.systemPrompt = this._baseSystemPrompt;
			} else {
				// Legacy extension mutation remains available only when callers explicitly
				// disable Context Engine.
				if (result?.messages) {
					for (const msg of result.messages) {
						messages.push({
							role: "custom",
							customType: msg.customType,
							content: msg.content ?? [],
							display: msg.display,
							details: msg.details,
							timestamp: Date.now(),
						});
					}
				}
				if (result?.systemPrompt !== undefined) {
					this._systemPromptOverride = result.systemPrompt;
					this.agent.state.systemPrompt = result.systemPrompt;
				} else {
					this._systemPromptOverride = undefined;
					this.agent.state.systemPrompt = this._baseSystemPrompt;
				}
			}
			this._activeContextRunId = options?.runId;
			await this._validateInitialContextBudget(messages);
		} catch (error) {
			this._systemPromptOverride = undefined;
			this._activeContextRunId = undefined;
			this._pendingExtensionContextSources = [];
			this._pendingMcpAttachments = [];
			this._releaseAgentRunPreflightReservation(reservedRunActive);
			preflightResult?.(false);
			throw error;
		}

		if (!messages) {
			return;
		}

		let preflightAccepted = false;
		try {
			await this.agent.runWithPreflight(
				async (signal) => {
					await this._prepareAgentRun(signal);
					preflightResult?.(true);
					preflightAccepted = true;
				},
				async () => {
					try {
						await this._runAgentPrompt(messages, { agentRunAlreadyActive: true });
					} finally {
						await this._finishAgentPrompt();
					}
				},
				{ signal: options?.signal, deadlineMs: options?.deadlineMs },
			);
		} catch (error) {
			// Capability/policy failures and Automation Host acceptance failures happen
			// before the Agent loop begins. Release the reservation and run state without
			// carrying policy-bound context into a later turn.
			if (!preflightAccepted) {
				preflightResult?.(false);
				this._systemPromptOverride = undefined;
				this._activeContextRunId = undefined;
				this._pendingExtensionContextSources = [];
				this._pendingMcpAttachments = [];
				this._releaseAgentRunPreflightReservation(reservedRunActive);
			}
			throw error;
		}
	}

	/**
	 * Try to execute an extension command. Returns true if command was found and executed.
	 */
	private async _tryExecuteExtensionCommand(text: string): Promise<boolean> {
		// Parse command name and args
		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1);

		const command = this._extensionRunner.getCommand(commandName);
		if (!command) return false;

		// Get command context from extension runner (includes session control methods)
		const ctx = this._extensionRunner.createCommandContext();

		try {
			await command.handler(args, ctx);
			return true;
		} catch (err) {
			// Emit error via extension runner
			this._extensionRunner.emitError({
				extensionPath: `command:${commandName}`,
				event: "command",
				error: err instanceof Error ? err.message : String(err),
			});
			return true;
		}
	}

	/**
	 * Expand skill commands (/skill:name args) to their full content.
	 * Returns the expanded text, or the original text if not a skill command or skill not found.
	 * Emits errors via extension runner if file read fails.
	 */
	private _expandSkillCommand(text: string): string {
		if (!text.startsWith("/skill:")) return text;

		const spaceIndex = text.indexOf(" ");
		const skillName = spaceIndex === -1 ? text.slice(7) : text.slice(7, spaceIndex);
		const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1).trim();

		const skill = this.resourceLoader.getSkills().skills.find((s) => s.name === skillName);
		if (!skill) return text; // Unknown skill, pass through

		try {
			const content = readFileSync(skill.filePath, "utf-8");
			const body = stripFrontmatter(content).trim();
			const skillBlock = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
			return args ? `${skillBlock}\n\n${args}` : skillBlock;
		} catch (err) {
			// Emit error like extension commands do
			this._extensionRunner.emitError({
				extensionPath: skill.filePath,
				event: "skill_expansion",
				error: err instanceof Error ? err.message : String(err),
			});
			return text; // Return original on error
		}
	}

	/**
	 * Queue a steering message while the agent is running.
	 * Delivered after the current assistant turn finishes executing its tool calls,
	 * before the next LLM call.
	 * Expands skill commands and prompt templates. Errors on extension commands.
	 * @param images Optional image attachments to include with the message
	 * @throws Error if text is an extension command
	 */
	async steer(text: string, images?: ImageContent[]): Promise<void> {
		// Check for extension commands (cannot be queued)
		if (text.startsWith("/")) {
			this._throwIfExtensionCommand(text);
		}

		// Expand skill commands and prompt templates
		let expandedText = this._expandSkillCommand(text);
		expandedText = expandPromptTemplate(expandedText, [...this.promptTemplates]);

		await this._queueSteer(expandedText, images);
	}

	/**
	 * Queue a follow-up message to be processed after the agent finishes.
	 * Delivered only when agent has no more tool calls or steering messages.
	 * Expands skill commands and prompt templates. Errors on extension commands.
	 * @param images Optional image attachments to include with the message
	 * @throws Error if text is an extension command
	 */
	async followUp(text: string, images?: ImageContent[]): Promise<void> {
		// Check for extension commands (cannot be queued)
		if (text.startsWith("/")) {
			this._throwIfExtensionCommand(text);
		}

		// Expand skill commands and prompt templates
		let expandedText = this._expandSkillCommand(text);
		expandedText = expandPromptTemplate(expandedText, [...this.promptTemplates]);

		await this._queueFollowUp(expandedText, images);
	}

	/**
	 * Internal: Queue a steering message (already expanded, no extension command check).
	 */
	private async _queueSteer(text: string, images?: ImageContent[]): Promise<void> {
		this._steeringMessages.push(text);
		this._emitQueueUpdate();
		const content: (TextContent | ImageContent)[] = [{ type: "text", text }];
		if (images) {
			content.push(...images);
		}
		this.agent.steer({
			role: "user",
			content,
			timestamp: Date.now(),
		});
	}

	/**
	 * Internal: Queue a follow-up message (already expanded, no extension command check).
	 */
	private async _queueFollowUp(text: string, images?: ImageContent[]): Promise<void> {
		this._followUpMessages.push(text);
		this._emitQueueUpdate();
		const content: (TextContent | ImageContent)[] = [{ type: "text", text }];
		if (images) {
			content.push(...images);
		}
		this.agent.followUp({
			role: "user",
			content,
			timestamp: Date.now(),
		});
	}

	/**
	 * Throw an error if the text is an extension command.
	 */
	private _throwIfExtensionCommand(text: string): void {
		const spaceIndex = text.indexOf(" ");
		const commandName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);
		const command = this._extensionRunner.getCommand(commandName);

		if (command) {
			throw new Error(
				`Extension command "/${commandName}" cannot be queued. Use prompt() or execute the command when not streaming.`,
			);
		}
	}

	/**
	 * Send a custom message to the session. Creates a CustomMessageEntry.
	 *
	 * Handles three cases:
	 * - Streaming: queues message, processed when loop pulls from queue
	 * - Not streaming + triggerTurn: appends to state/session, starts new turn
	 * - Not streaming + no trigger: appends to state/session, no turn
	 *
	 * @param message Custom message with customType, content, display, details
	 * @param options.triggerTurn If true and not streaming, triggers a new LLM turn
	 * @param options.deliverAs Delivery mode: "steer", "followUp", or "nextTurn"
	 */
	async sendCustomMessage<T = unknown>(
		message: Pick<CustomMessage<T>, "customType" | "content" | "display" | "details">,
		options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" },
	): Promise<void> {
		const appMessage = {
			role: "custom" as const,
			customType: message.customType,
			// Untyped extensions can pass null/missing content; normalize at ingestion.
			content: message.content ?? [],
			display: message.display,
			details: message.details,
			timestamp: Date.now(),
		} satisfies CustomMessage<T>;
		if (options?.deliverAs === "nextTurn") {
			this._pendingNextTurnMessages.push(appMessage);
		} else if (this.isStreaming) {
			if (options?.deliverAs === "followUp") {
				this.agent.followUp(appMessage);
			} else {
				this.agent.steer(appMessage);
			}
		} else if (options?.triggerTurn) {
			await this._runAgentPrompt(appMessage);
		} else {
			this.agent.state.messages.push(appMessage);
			this.sessionManager.appendCustomMessageEntry(
				message.customType,
				message.content,
				message.display,
				message.details,
			);
			this._emit({ type: "message_start", message: appMessage });
			this._emit({ type: "message_end", message: appMessage });
		}
	}

	/**
	 * Send a user message to the agent. Always triggers a turn.
	 * When the agent is streaming, use deliverAs to specify how to queue the message.
	 *
	 * @param content User message content (string or content array)
	 * @param options.deliverAs Delivery mode when streaming: "steer" or "followUp"
	 */
	async sendUserMessage(
		content: string | (TextContent | ImageContent)[],
		options?: { deliverAs?: "steer" | "followUp" },
	): Promise<void> {
		// Normalize content to text string + optional images
		let text: string;
		let images: ImageContent[] | undefined;

		if (typeof content === "string") {
			text = content;
		} else {
			const textParts: string[] = [];
			images = [];
			for (const part of content) {
				if (part.type === "text") {
					textParts.push(part.text);
				} else {
					images.push(part);
				}
			}
			text = textParts.join("\n");
			if (images.length === 0) images = undefined;
		}

		// Use prompt() with expandPromptTemplates: false to skip command handling and template expansion
		await this.prompt(text, {
			expandPromptTemplates: false,
			streamingBehavior: options?.deliverAs,
			images,
			source: "extension",
		});
	}

	/**
	 * Clear all queued messages and return them.
	 * Useful for restoring to editor when user aborts.
	 * @returns Object with steering and followUp arrays
	 */
	clearQueue(): { steering: string[]; followUp: string[] } {
		const steering = [...this._steeringMessages];
		const followUp = [...this._followUpMessages];
		this._steeringMessages = [];
		this._followUpMessages = [];
		this.agent.clearAllQueues();
		this._emitQueueUpdate();
		return { steering, followUp };
	}

	/** Number of pending messages (includes both steering and follow-up) */
	get pendingMessageCount(): number {
		return this._steeringMessages.length + this._followUpMessages.length;
	}

	/** Get pending steering messages (read-only) */
	getSteeringMessages(): readonly string[] {
		return this._steeringMessages;
	}

	/** Get pending follow-up messages (read-only) */
	getFollowUpMessages(): readonly string[] {
		return this._followUpMessages;
	}

	get resourceLoader(): ResourceLoader {
		return this._resourceLoader;
	}

	/**
	 * The frozen CapabilityBinding for the current runtime. Immutable for the
	 * duration of any active agent run; reload / setActiveTools / dynamic
	 * registration resolve a fresh binding only when the session is idle.
	 */
	getActiveCapabilityBinding(): CapabilityBinding | undefined {
		return this._activeCapabilityBinding;
	}

	/** Binding id of the current frozen capability binding, when one is resolved. */
	getCapabilityBindingId(): string | undefined {
		return this._activeCapabilityBinding?.id;
	}

	/** Redacted MCP connection status for a configured server id. */
	getMcpConnectionStatus(serverId: string) {
		return this._mcpLifecycleManager?.getStatus(serverId);
	}

	// =========================================================================
	// Explicit MCP OAuth + content surface
	//
	// Everything here is explicit: auth starts only when requested, listing
	// registers secret-free content descriptors, reading returns normalized
	// bounded content, and attaching stages normalized content as an untrusted
	// turn-scoped context source. Nothing is read, attached, run, injected, or
	// approved automatically.
	// =========================================================================

	/**
	 * Combined OAuth flow + credential status of one configured MCP server.
	 * stdio servers report `authSupported: false` and never authenticate.
	 */
	async getMcpAuthStatus(serverId: string): Promise<McpAuthStatusView> {
		const diagnostic = this._requireMcpDiagnostic(serverId);
		if (diagnostic.server.transport !== "streamable-http" || diagnostic.server.oauth === undefined) {
			return {
				serverId,
				authSupported: false,
				auth: { serverId, state: "unauthenticated" },
				credential: {
					serverId,
					hasCredential: false,
					status: "none",
					expiresAt: 0,
					scopes: [],
					revision: 0,
				},
			};
		}
		const { context, options } = this._mcpAuthBinding(serverId);
		const [auth, credential] = await Promise.all([
			this._mcpAuthProvider.getStatus(context, options),
			this._mcpCredentialNamespace.status(this._mcpCredentialScope(serverId)),
		]);
		return { serverId, authSupported: true, auth, credential };
	}

	/**
	 * Starts (or joins) the interactive OAuth flow for a streamable-http server.
	 * Gated by `mcp.auth`; never runs without an explicit call.
	 */
	async startMcpAuth(serverId: string, interaction?: AuthInteraction): Promise<MCPAuthResult> {
		const diagnostic = this._requireMcpDiagnostic(serverId);
		this._assertMcpAuthSupported(diagnostic, serverId);
		return this._runMcpAudited(
			serverId,
			"auth",
			async () => {
				const capability = this._requireMcpServerCapability(serverId);
				await this._authorizeMcpOperation("mcp.auth", serverId, capability);
				return capability;
			},
			async () => {
				const { context, options } = this._mcpAuthBinding(serverId);
				const result = await this._mcpAuthProvider.startInteractive(context, options, interaction);
				return { result };
			},
			(result) =>
				result.outcome === "authorized" || result.outcome === "interaction_required"
					? { outcome: "success" }
					: result.outcome === "cancelled"
						? { outcome: "cancelled" }
						: { outcome: "failed", reasonCode: "mcp_auth_timeout" },
		);
	}

	/** Validates and delivers the OAuth callback code for a pending flow. Gated by `mcp.auth`. */
	async completeMcpAuth(
		serverId: string,
		code: string,
		params: { state?: string; redirectUri?: string },
	): Promise<void> {
		const diagnostic = this._requireMcpDiagnostic(serverId);
		this._assertMcpAuthSupported(diagnostic, serverId);
		return this._runMcpAudited(
			serverId,
			"auth",
			async () => {
				const capability = this._requireMcpServerCapability(serverId);
				await this._authorizeMcpOperation("mcp.auth", serverId, capability);
				return capability;
			},
			async () => {
				const { context, options } = this._mcpAuthBinding(serverId);
				await this._mcpAuthProvider.completeAuthorization(context, options, code, params);
				return { result: undefined };
			},
		);
	}

	/** Awaits the outcome of a headless OAuth flow. Gated by `mcp.auth`. */
	async waitForMcpAuth(serverId: string, signal?: AbortSignal): Promise<MCPAuthResult> {
		const diagnostic = this._requireMcpDiagnostic(serverId);
		this._assertMcpAuthSupported(diagnostic, serverId);
		return this._runMcpAudited(
			serverId,
			"auth",
			async () => {
				const capability = this._requireMcpServerCapability(serverId);
				await this._authorizeMcpOperation("mcp.auth", serverId, capability);
				return capability;
			},
			async () => {
				const { context, options } = this._mcpAuthBinding(serverId);
				// The caller signal cancels the pending flow itself (not just the
				// wait), so a headless cancellation can never let the flow
				// complete later and persist tokens.
				const result = await awaitWithOperationSignal(
					this._mcpAuthProvider.waitForAuthorization(context, options, signal),
					signal,
				);
				return { result };
			},
			(result) =>
				result.outcome === "authorized" || result.outcome === "interaction_required"
					? { outcome: "success" }
					: result.outcome === "cancelled"
						? { outcome: "cancelled" }
						: { outcome: "failed", reasonCode: "mcp_auth_timeout" },
		);
	}

	/**
	 * Cancels a pending headless OAuth flow for one server. The flow settles
	 * cancelled and can never persist late tokens; unknown or non-OAuth
	 * servers are ignored. No-op when no flow is pending.
	 */
	cancelMcpAuth(serverId: string): void {
		try {
			const diagnostic = this._requireMcpDiagnostic(serverId);
			this._assertMcpAuthSupported(diagnostic, serverId);
			const { context, options } = this._mcpAuthBinding(serverId);
			this._mcpAuthProvider.cancel(context, options);
		} catch {
			// Best-effort: unknown or unsupported servers have no pending flow.
		}
	}

	/**
	 * Logs out of one MCP server: local credential cleanup plus best-effort
	 * remote revocation. Gated by `mcp.auth`; revocation failures never block
	 * the local deletion.
	 */
	async logoutMcpAuth(serverId: string, signal?: AbortSignal): Promise<void> {
		const diagnostic = this._requireMcpDiagnostic(serverId);
		this._assertMcpAuthSupported(diagnostic, serverId);
		return this._runMcpAudited(
			serverId,
			"auth",
			async () => {
				const capability = this._requireMcpServerCapability(serverId);
				await this._authorizeMcpOperation("mcp.auth", serverId, capability);
				return capability;
			},
			async () => {
				const { context, options } = this._mcpAuthBinding(serverId);
				await awaitWithOperationSignal(this._mcpAuthProvider.logout(context, options), signal);
				return { result: undefined };
			},
		);
	}

	/**
	 * Lists one page of resources of a selected, connected server. Gated by
	 * `mcp.content.list`. The listing registers secret-free content capability
	 * descriptors (parented to the mcp_server) into the frozen binding; it never
	 * reads, attaches, or injects anything.
	 */
	async listMcpResources(
		serverId: string,
		cursor?: string,
		signal?: AbortSignal,
	): Promise<MCPPageResult<MCPResourceView>> {
		await this._ensureMcpContentIdle();
		return this._runMcpAudited(
			serverId,
			"resource.list",
			async () => {
				const capability = this._requireMcpServerCapability(serverId);
				await this._authorizeMcpOperation("mcp.content.list", serverId, capability);
				return capability;
			},
			async () => {
				await this._ensureMcpServerConnected(serverId, signal);
				const page = await this._mcpLifecycleManager.listResources(serverId, cursor, signal);
				// A fresh list (no cursor) starts a new catalog generation: entries a
				// server no longer returns lose their descriptors. Cursor pages merge
				// into the current generation so earlier pages stay readable.
				this._updateMcpContentCatalog(serverId, (catalog) => ({
					...catalog,
					resources:
						cursor === undefined
							? [...page.items]
							: mergeMcpCatalogItems(catalog.resources, page.items, (item) => item.resourceId),
				}));
				await this._refreshMcpContentBinding(serverId, signal);
				return { result: page };
			},
		);
	}

	/** Lists one page of resource templates. Gated by `mcp.content.list`. */
	async listMcpResourceTemplates(
		serverId: string,
		cursor?: string,
		signal?: AbortSignal,
	): Promise<MCPPageResult<MCPResourceTemplateView>> {
		await this._ensureMcpContentIdle();
		return this._runMcpAudited(
			serverId,
			"resource.list",
			async () => {
				const capability = this._requireMcpServerCapability(serverId);
				await this._authorizeMcpOperation("mcp.content.list", serverId, capability);
				return capability;
			},
			async () => {
				await this._ensureMcpServerConnected(serverId, signal);
				const page = await this._mcpLifecycleManager.listResourceTemplates(serverId, cursor, signal);
				this._updateMcpContentCatalog(serverId, (catalog) => ({
					...catalog,
					resourceTemplates:
						cursor === undefined
							? [...page.items]
							: mergeMcpCatalogItems(
									catalog.resourceTemplates,
									page.items,
									(item) => item.templateId,
								),
				}));
				await this._refreshMcpContentBinding(serverId, signal);
				return { result: page };
			},
		);
	}

	/** Lists one page of prompts. Gated by `mcp.content.list`. */
	async listMcpPrompts(
		serverId: string,
		cursor?: string,
		signal?: AbortSignal,
	): Promise<MCPPageResult<MCPPromptView>> {
		await this._ensureMcpContentIdle();
		return this._runMcpAudited(
			serverId,
			"prompt.list",
			async () => {
				const capability = this._requireMcpServerCapability(serverId);
				await this._authorizeMcpOperation("mcp.content.list", serverId, capability);
				return capability;
			},
			async () => {
				await this._ensureMcpServerConnected(serverId, signal);
				const page = await this._mcpLifecycleManager.listPrompts(serverId, cursor, signal);
				this._updateMcpContentCatalog(serverId, (catalog) => ({
					...catalog,
					prompts:
						cursor === undefined
							? [...page.items]
							: mergeMcpCatalogItems(catalog.prompts, page.items, (item) => item.promptId),
				}));
				await this._refreshMcpContentBinding(serverId, signal);
				return { result: page };
			},
		);
	}

	/**
	 * Reads a listed resource and returns its normalized bounded content. Gated
	 * by `mcp.content.read` with the exact descriptor revision the binding
	 * froze; a resource that was never listed, or whose descriptor is absent or
	 * stale, is denied.
	 */
	async readMcpResource(serverId: string, resourceId: string, signal?: AbortSignal): Promise<MCPReadResourceResult> {
		await this._ensureMcpContentIdle();
		return this._runMcpAudited(
			serverId,
			"resource.read",
			async () => {
				const capability = this._requireContentCapability(serverId, resourceId);
				await this._authorizeMcpOperation("mcp.content.read", serverId, capability);
				return capability;
			},
			async (capability) => {
				// Connect (reconnecting a selected server whose transport a policy
				// boundary closed) before resolving the listed identity, so the
				// preserved catalog identities are restored for the lookup.
				await this._ensureMcpServerConnected(serverId, signal);
				const uri = this._requireMcpResourceUri(serverId, resourceId);
				const result = await this._mcpLifecycleManager.readResource(serverId, uri, signal);
				return {
					result,
					byteCount: result.content.byteCount,
					blockCount: result.content.blocks.length,
				};
			},
		);
	}

	/**
	 * Fetches a listed prompt and returns its normalized bounded messages. Gated
	 * by `mcp.content.read` with the exact descriptor revision the binding
	 * froze. Argument sets are validated against the declared prompt arguments
	 * (required present, no unknown keys, bounded sizes) before any server call.
	 */
	async getMcpPrompt(
		serverId: string,
		promptId: string,
		args?: Readonly<Record<string, string>>,
		signal?: AbortSignal,
	): Promise<MCPGetPromptResult> {
		await this._ensureMcpContentIdle();
		return this._runMcpAudited(
			serverId,
			"prompt.get",
			async () => {
				const capability = this._requirePromptCapability(serverId, promptId);
				await this._authorizeMcpOperation("mcp.content.read", serverId, capability);
				return capability;
			},
			async (capability) => {
				this._validateMcpPromptArguments(serverId, promptId, args);
				await this._ensureMcpServerConnected(serverId, signal);
				const promptName = this._requireMcpPromptName(serverId, promptId);
				const result = await this._mcpLifecycleManager.getPrompt(serverId, promptName, args, signal);
				return {
					result,
					byteCount: result.messages.reduce((sum, message) => sum + message.content.byteCount, 0),
					blockCount: result.messages.reduce((sum, message) => sum + message.content.blocks.length, 0),
				};
			},
		);
	}

	/**
	 * Reads a listed resource and stages its normalized bounded text as an
	 * untrusted, turn-scoped user context source for the next agent turn. Gated
	 * by `mcp.content.attach`; the read itself never happens without the
	 * explicit attach.
	 *
	 * Fail-closed truncation: when normalization cut the payload short and the
	 * caller did not explicitly request the visible truncated result
	 * (`options.allowTruncated`), the attach is rejected with
	 * `content_limit_exceeded` instead of staging silently truncated content.
	 * Interactive surfaces that already showed the capped preview and received
	 * explicit confirmation pass `allowTruncated: true`.
	 */
	async attachMcpResource(
		serverId: string,
		resourceId: string,
		signal?: AbortSignal,
		options?: { allowTruncated?: boolean },
	): Promise<McpAttachmentResult> {
		await this._ensureMcpContentIdle();
		return this._runMcpAudited(
			serverId,
			"context.attach",
			async () => {
				const capability = this._requireContentCapability(serverId, resourceId);
				await this._authorizeMcpOperation("mcp.content.attach", serverId, capability);
				return capability;
			},
			async (capability) => {
				await this._ensureMcpServerConnected(serverId, signal);
				const uri = this._requireMcpResourceUri(serverId, resourceId);
				const result = await this._mcpLifecycleManager.readResource(serverId, uri, signal);
				if (result.content.truncated && options?.allowTruncated !== true) {
					throw new MCPError(
						"content_limit_exceeded",
						serverId,
						mcpContentFailureMessage("content_limit_exceeded", serverId),
					);
				}
				if (result.content.unsafe) {
					// Unknown/dangerous MIME or non-representable blocks never
					// stage: reads may return bounded metadata, attach fails closed.
					throw new MCPError(
						"content_invalid",
						serverId,
						mcpContentFailureMessage("content_invalid", serverId),
					);
				}
				const content = mcpAttachmentText(result.content.blocks);
				this._assertMcpAttachmentBudget(serverId, utf8ByteLength(content));
				const source = this._buildMcpAttachmentSource(
					serverId,
					"resource",
					capability,
					content,
					result.content.truncated,
					this._mcpContentCatalogs
						.get(serverId)
						?.resources.find((entry) => entry.resourceId === resourceId)?.mimeType,
				);
				this._pendingMcpAttachments = [...this._pendingMcpAttachments, source];
				return {
					result: {
						attachmentId: source.sourceId,
						serverId,
						contentLength: content.length,
						truncated: result.content.truncated,
					},
					contentDigest: mcpContentDigest(content),
					byteCount: result.content.byteCount,
					blockCount: result.content.blocks.length,
				};
			},
		);
	}

	/**
	 * Fetches a listed prompt and stages its normalized bounded text as an
	 * untrusted, turn-scoped user context source for the next agent turn. Gated
	 * by `mcp.content.attach`. Fail-closed truncation: when normalization cut
	 * any message short and the caller did not explicitly request the visible
	 * truncated result (`options.allowTruncated`), the attach is rejected with
	 * `content_limit_exceeded`.
	 */
	async attachMcpPrompt(
		serverId: string,
		promptId: string,
		args?: Readonly<Record<string, string>>,
		signal?: AbortSignal,
		options?: { allowTruncated?: boolean },
	): Promise<McpAttachmentResult> {
		await this._ensureMcpContentIdle();
		return this._runMcpAudited(
			serverId,
			"context.attach",
			async () => {
				const capability = this._requirePromptCapability(serverId, promptId);
				await this._authorizeMcpOperation("mcp.content.attach", serverId, capability);
				return capability;
			},
			async (capability) => {
				this._validateMcpPromptArguments(serverId, promptId, args);
				await this._ensureMcpServerConnected(serverId, signal);
				const promptName = this._requireMcpPromptName(serverId, promptId);
				const result = await this._mcpLifecycleManager.getPrompt(serverId, promptName, args, signal);
				const truncated = result.messages.some((message) => message.content.truncated);
				if (truncated && options?.allowTruncated !== true) {
					throw new MCPError(
						"content_limit_exceeded",
						serverId,
						mcpContentFailureMessage("content_limit_exceeded", serverId),
					);
				}
				if (result.messages.some((message) => message.content.unsafe)) {
					// Unknown/dangerous MIME or non-representable blocks never
					// stage: reads may return bounded metadata, attach fails closed.
					throw new MCPError(
						"content_invalid",
						serverId,
						mcpContentFailureMessage("content_invalid", serverId),
					);
				}
				const content = result.messages
					.map((message) => {
						const text = mcpAttachmentText(message.content.blocks);
						if (text.length === 0) {
							return "";
						}
						// Preserve the server-declared role as a non-instruction label:
						// the staged source stays user-role external_untrusted context
						// and can never become a system/developer directive.
						return `[${message.role}]\n${text}`;
					})
					.filter((text) => text.length > 0)
					.join("\n\n");
				this._assertMcpAttachmentBudget(serverId, utf8ByteLength(content));
				const source = this._buildMcpAttachmentSource(
					serverId,
					"prompt",
					capability,
					content,
					truncated,
				);
				this._pendingMcpAttachments = [...this._pendingMcpAttachments, source];
				return {
					result: {
						attachmentId: source.sourceId,
						serverId,
						contentLength: content.length,
						truncated,
					},
					contentDigest: mcpContentDigest(content),
					byteCount: result.messages.reduce((sum, message) => sum + message.content.byteCount, 0),
					blockCount: result.messages.reduce((sum, message) => sum + message.content.blocks.length, 0),
				};
			},
		);
	}

	/**
	 * Secret-free last-listed content catalog of one server. Raw bodies, URIs,
	 * arguments, and secrets are never retained; only the normalized views used
	 * for descriptor derivation are kept.
	 */
	getMcpContentCatalog(serverId: string): McpContentCatalog | undefined {
		const catalog = this._mcpContentCatalogs.get(serverId);
		return catalog === undefined ? undefined : { ...catalog };
	}

	/**
	 * Resolves once MCP capability discovery for the current runtime has settled
	 * (connect + listTools + binding re-resolution). Discovery is lazy: this
	 * call is what starts it for a freshly built runtime, so a session never
	 * connects to MCP servers during construction. Throws the recorded discovery
	 * failure when one occurred (e.g. a name conflict).
	 */
	async whenCapabilitiesReady(policyRunId?: string, signal?: AbortSignal): Promise<void> {
		this._ensureCapabilityDiscoveryStarted(policyRunId, signal);
		await awaitWithOperationSignal(this._capabilityDiscoveryPromise, signal);
		if (this._capabilityDiscoveryError) {
			throw this._capabilityDiscoveryError;
		}
	}

	/**
	 * Starts MCP capability discovery for the current runtime exactly once.
	 * The selected trusted servers are connected, their tools are listed, and
	 * the frozen binding is re-resolved with the namespaced mcp_tool
	 * descriptors. Failures are recorded and fail discovery closed.
	 */
	private _ensureCapabilityDiscoveryStarted(policyRunId?: string, signal?: AbortSignal): void {
		if (this._capabilityDiscoveryStarted) {
			return;
		}
		this._capabilityDiscoveryStarted = true;
		this._capabilityDiscoveryPromise = this._discoverMcpToolsForBinding(policyRunId, signal).catch((error) => {
			if (signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) {
				// A caller-scoped cancellation must not poison the runtime's one-shot
				// discovery state. A later run can retry against fresh MCP connections.
				this._capabilityDiscoveryStarted = false;
				this._capabilityDiscoveryError = undefined;
				return;
			}
			this._capabilityDiscoveryError = error instanceof Error ? error : new Error(String(error));
		});
	}

	/** The capability profile currently materialized into the frozen binding. */
	getActiveCapabilityProfile(): string {
		return this._activeCapabilityProfile ?? this.settingsManager.getCapabilitySettings().defaultProfile;
	}

	/**
	 * Materialize the named capability profile into the actual frozen binding,
	 * active tool set, and MCP setup. Omitting the profile resets to
	 * settings.defaultProfile; an unknown profile throws
	 * capability_profile_not_found (no silent fallback).
	 *
	 * While an agent run is active this waits for the run to settle so the
	 * running binding is never mutated; materialization and discovery readiness
	 * complete before the returned promise resolves.
	 */
	async setCapabilityProfile(profileName?: string, options?: { runId?: string }): Promise<void> {
		const capabilitySettings = this.settingsManager.getCapabilitySettings();
		const effectiveProfile = profileName ?? capabilitySettings.defaultProfile;
		if (capabilitySettings.profiles[effectiveProfile] === undefined) {
			throw new CapabilityProfileNotFoundError(effectiveProfile);
		}
		if (this._isAgentRunActive) {
			await this.waitForIdle();
		}
		await this._materializeCapabilityProfile(effectiveProfile, options?.runId);
	}

	/**
	 * Redacted view of the currently discovered capability catalog. Never
	 * includes command arguments, environment/header values, tokens, or
	 * unredacted URLs.
	 */
	inspectCapabilityCatalog(): CapabilityCatalogView {
		return this._capabilityRegistry.inspectCatalog() ?? { version: 1, descriptors: [] };
	}

	/**
	 * Approve an ask capability for this session only. The approval is session
	 * local (never written to settings). The current profile is the authority:
	 * an approval is retained only when it flips an ask descriptor into the
	 * binding; a denied, untrusted, or unavailable descriptor can never be
	 * approved (capability_denied). While an agent run is active this waits for
	 * the run to settle so the running binding is never mutated; the approval
	 * materializes before the returned promise resolves.
	 */
	async approveCapability(descriptorId: string): Promise<void> {
		// Wait for an active run to settle before reading the catalog or
		// resolving, so validation runs against the settled catalog/profile state.
		if (this._isAgentRunActive) {
			await this.waitForIdle();
		}
		const catalog = this._activeCapabilityCatalog;
		const descriptor = catalog?.descriptors.find((candidate) =>
			matchesCapabilityDescriptorId(candidate, descriptorId),
		);
		if (catalog === undefined || descriptor === undefined) {
			throw new CapabilityError("capability_denied", `Cannot approve unknown capability: ${descriptorId}`);
		}
		const approvedDescriptorId = descriptor.id;
		if (!descriptor.trusted || descriptor.availability !== "available") {
			throw new CapabilityError(
				"capability_denied",
				`Cannot approve capability "${descriptorId}": it is untrusted or unavailable`,
			);
		}
		if (this._capabilityApprovedDescriptorIds.includes(approvedDescriptorId)) {
			return;
		}
		// A capability already enabled by the profile (e.g. allow) has nothing to
		// approve; retain the approval only when it changes an ask into the binding.
		if (this._activeCapabilityBinding?.descriptors.some((ref) => ref.id === approvedDescriptorId)) {
			return;
		}
		const entered = resolveCapabilityBinding({
			...this._resolveBindingInput(),
			catalog,
			approvedDescriptorIds: [...this._capabilityApprovedDescriptorIds, approvedDescriptorId],
		}).descriptors.some((ref) => ref.id === approvedDescriptorId);
		if (!entered) {
			throw new CapabilityError(
				"capability_denied",
				`Cannot approve capability "${descriptorId}": it is denied by the profile or cannot be selected`,
			);
		}
		this._capabilityApprovedDescriptorIds = [...this._capabilityApprovedDescriptorIds, approvedDescriptorId];
		await this._refreshCapabilitySetup();
	}

	/** The named Execution Policy profile selected for the next binding. */
	getActiveExecutionPolicyProfile(): string {
		return (
			this._activeExecutionPolicyProfile?.id ??
			this._activeExecutionPolicyProfileSelection ??
			this.settingsManager.getExecutionPolicySettings({
				registeredProviderIds: ["legacy-host", "host-policy", ...this._sandboxProviders.keys()],
			}).selectedProfileId
		);
	}

	/**
	 * Select a named Execution Policy profile for this session. The selector is a
	 * name only; inline policy objects are never accepted here.
	 */
	async setExecutionPolicyProfile(profileName?: string): Promise<void> {
		if (this._isAgentRunActive) {
			await this.waitForIdle();
		}
		const policySettings = this.settingsManager.getExecutionPolicySettings({
			policyProfile: profileName,
			registeredProviderIds: ["legacy-host", "host-policy", ...this._sandboxProviders.keys()],
		});
		await this._enqueueExecutionPolicyTransition(async () => {
			await this._closeMcpConnectionsForPolicyBoundary();
			await this._disposeSandboxSession();
			this._activeExecutionPolicyProfileSelection = policySettings.selectedProfileId;
			this._activeExecutionPolicyProfile = undefined;
			this._activeExecutionPolicyBinding = undefined;
			this._nextPreviousExecutionPolicyBindingId = undefined;
			this._executionPolicyPreviousBindingIdForRun = undefined;
			this._currentBuiltinToolPolicy = undefined;
			this._pendingExecutionPolicyApprovals.clear();
			this._executionPolicyApprovedRequestIds = [];
			this._executionPolicyRejectedRequestIds = [];
		});
	}

	/** Redacted current Execution Policy binding, if one has been materialized. */
	getActiveExecutionPolicyBinding(): PolicyBinding | undefined {
		return this._activeExecutionPolicyBinding;
	}

	/** Redacted current Execution Policy summary; computes a read-only preview before first run. */
	getActiveExecutionPolicySummary(): PublicPolicySummary {
		if (this._activeExecutionPolicyBinding !== undefined) {
			return toPublicPolicySummary(this._activeExecutionPolicyBinding);
		}
		const policySettings = this.settingsManager.getExecutionPolicySettings({
			policyProfile: this._activeExecutionPolicyProfileSelection,
			registeredProviderIds: ["legacy-host", "host-policy", ...this._sandboxProviders.keys()],
		});
		const result = resolveExecutionPolicyProfile({
			profiles: policySettings.profiles,
			defaultProfile: policySettings.selectedProfileId,
			policyProfile: policySettings.selectedProfileId,
			projectTrusted: this.settingsManager.isProjectTrusted(),
			capabilityBinding: this._policyCapabilityBindingInput(),
			sandbox: this._createPolicySandboxPreflight(policySettings.selectedProfile),
			workspaceIdentity:
				policySettings.selectedProfile.enforcement === "sandbox"
					? getActiveWorkspaceIdentity(this._cwd)
					: "workspace:active",
			runId: this._activeContextRunId ?? "run:session",
			createdAt: new Date().toISOString(),
		});
		if (!result.ok) throw result.error;
		return result.summary;
	}

	getPendingExecutionPolicyApprovals(): ReadonlyArray<PolicyApprovalRequest> {
		return [...this._pendingExecutionPolicyApprovals.values()];
	}

	approveExecutionPolicyRequest(requestId: string, source: PolicyApprovalSource = "interactive"): void {
		const approval = this._pendingExecutionPolicyApprovals.get(requestId);
		if (approval === undefined) throw new PolicyError("policy_denied", "Cannot approve unknown policy request.");
		this._recordExecutionPolicyApproval(approval, "approved", source);
		this._executionPolicyRejectedRequestIds = this._executionPolicyRejectedRequestIds.filter(
			(id) => id !== requestId,
		);
		if (!this._executionPolicyApprovedRequestIds.includes(requestId)) {
			this._executionPolicyApprovedRequestIds = [...this._executionPolicyApprovedRequestIds, requestId];
		}
		this._pendingExecutionPolicyApprovals.delete(requestId);
		this._currentBuiltinToolPolicy = undefined;
	}

	rejectExecutionPolicyRequest(requestId: string, source: PolicyApprovalSource = "interactive"): void {
		const approval = this._pendingExecutionPolicyApprovals.get(requestId);
		if (approval === undefined) throw new PolicyError("policy_denied", "Cannot reject unknown policy request.");
		this._recordExecutionPolicyApproval(approval, "rejected", source);
		this._executionPolicyApprovedRequestIds = this._executionPolicyApprovedRequestIds.filter(
			(id) => id !== requestId,
		);
		if (!this._executionPolicyRejectedRequestIds.includes(requestId)) {
			this._executionPolicyRejectedRequestIds = [...this._executionPolicyRejectedRequestIds, requestId];
		}
		this._pendingExecutionPolicyApprovals.delete(requestId);
		this._currentBuiltinToolPolicy = undefined;
	}

	private _recordExecutionPolicyApproval(
		approval: PolicyApprovalRequest,
		outcome: PolicyApprovalOutcome,
		source: PolicyApprovalSource,
	): void {
		if (this._activeExecutionPolicyBinding?.id !== approval.bindingId) {
			throw new PolicyError("policy_denied", "Cannot resolve a policy request outside the current binding.");
		}
		this._policyLedger.appendApprovalOutcome(approval, { outcome, source });
	}

	setPreviousExecutionPolicyBindingIdForNextRun(bindingId?: string): void {
		this._nextPreviousExecutionPolicyBindingId = bindingId;
		this._executionPolicyPreviousBindingIdForRun = bindingId;
	}

	/**
	 * Abort current operation and wait for agent to become idle.
	 */
	async abort(): Promise<void> {
		this.abortRetry();
		this.agent.abort();
		await this.waitForIdle();
	}

	async waitForIdle(): Promise<void> {
		if (this.isIdle) {
			return;
		}
		await this._getIdleWaitPromise();
	}

	// =========================================================================
	// Model Management
	// =========================================================================

	private async _emitModelSelect(
		nextModel: Model<any>,
		previousModel: Model<any> | undefined,
		source: "set" | "cycle" | "restore",
	): Promise<void> {
		if (modelsAreEqual(previousModel, nextModel)) return;
		await this._extensionRunner.emit({
			type: "model_select",
			model: nextModel,
			previousModel,
			source,
		});
	}

	/**
	 * Set model directly.
	 * Validates that auth is configured, saves to session and settings.
	 * @throws Error if no auth is configured for the model
	 */
	async setModel(model: Model<any>): Promise<void> {
		if (!(await this._modelRuntime.checkAuth(model.provider))) {
			throw new Error(`No API key for ${model.provider}/${model.id}`);
		}

		// A direct set/cycle is an explicit manual selection. Route callers attach
		// their immutable resolution immediately after this method returns.
		this._selectedModelResolution = undefined;
		this._previousModelBindingId = undefined;
		this._lastModelBrokerBindingId = undefined;
		this._manualModelSelection = true;
		const previousModel = this.model;
		const thinkingLevel = this._getThinkingLevelForModelSwitch();
		this.agent.state.model = model;
		this.sessionManager.appendModelChange(model.provider, model.id);
		this.settingsManager.setDefaultModelAndProvider(model.provider, model.id);

		// Re-clamp thinking level for new model's capabilities
		this.setThinkingLevel(thinkingLevel);

		await this._emitModelSelect(model, previousModel, "set");
	}

	/**
	 * Cycle to next/previous model.
	 * Uses scoped models (from --models flag) if available, otherwise all available models.
	 * @param direction - "forward" (default) or "backward"
	 * @returns The new model info, or undefined if only one model available
	 */
	async cycleModel(direction: "forward" | "backward" = "forward"): Promise<ModelCycleResult | undefined> {
		if (this._scopedModels.length > 0) {
			return this._cycleScopedModel(direction);
		}
		return this._cycleAvailableModel(direction);
	}

	private async _cycleScopedModel(direction: "forward" | "backward"): Promise<ModelCycleResult | undefined> {
		const availableIds = new Set(
			this._modelRuntime.getAvailableSnapshot().map((model) => `${model.provider}\0${model.id}`),
		);
		const scopedModels = this._scopedModels.filter((scoped) =>
			availableIds.has(`${scoped.model.provider}\0${scoped.model.id}`),
		);
		if (scopedModels.length <= 1) return undefined;

		const currentModel = this.model;
		let currentIndex = scopedModels.findIndex((sm) => modelsAreEqual(sm.model, currentModel));

		if (currentIndex === -1) currentIndex = 0;
		const len = scopedModels.length;
		const nextIndex = direction === "forward" ? (currentIndex + 1) % len : (currentIndex - 1 + len) % len;
		const next = scopedModels[nextIndex];
		const thinkingLevel = this._getThinkingLevelForModelSwitch(next.thinkingLevel);

		// Apply model
		this._selectedModelResolution = undefined;
		this._previousModelBindingId = undefined;
		this._lastModelBrokerBindingId = undefined;
		this._manualModelSelection = true;
		this.agent.state.model = next.model;
		this.sessionManager.appendModelChange(next.model.provider, next.model.id);
		this.settingsManager.setDefaultModelAndProvider(next.model.provider, next.model.id);

		// Apply thinking level.
		// - Explicit scoped model thinking level overrides current session level
		// - Undefined scoped model thinking level inherits the current session preference
		// setThinkingLevel clamps to model capabilities.
		this.setThinkingLevel(thinkingLevel);

		await this._emitModelSelect(next.model, currentModel, "cycle");

		return { model: next.model, thinkingLevel: this.thinkingLevel, isScoped: true };
	}

	private async _cycleAvailableModel(direction: "forward" | "backward"): Promise<ModelCycleResult | undefined> {
		const availableModels = this._modelRuntime.getAvailableSnapshot();
		if (availableModels.length <= 1) return undefined;

		const currentModel = this.model;
		let currentIndex = availableModels.findIndex((m) => modelsAreEqual(m, currentModel));

		if (currentIndex === -1) currentIndex = 0;
		const len = availableModels.length;
		const nextIndex = direction === "forward" ? (currentIndex + 1) % len : (currentIndex - 1 + len) % len;
		const nextModel = availableModels[nextIndex];

		const thinkingLevel = this._getThinkingLevelForModelSwitch();
		this._selectedModelResolution = undefined;
		this._previousModelBindingId = undefined;
		this._lastModelBrokerBindingId = undefined;
		this._manualModelSelection = true;
		this.agent.state.model = nextModel;
		this.sessionManager.appendModelChange(nextModel.provider, nextModel.id);
		this.settingsManager.setDefaultModelAndProvider(nextModel.provider, nextModel.id);

		// Re-clamp thinking level for new model's capabilities
		this.setThinkingLevel(thinkingLevel);

		await this._emitModelSelect(nextModel, currentModel, "cycle");

		return { model: nextModel, thinkingLevel: this.thinkingLevel, isScoped: false };
	}

	// =========================================================================
	// Thinking Level Management
	// =========================================================================

	/**
	 * Set thinking level.
	 * Clamps to model capabilities based on available thinking levels.
	 * Saves to session and settings only if the level actually changes.
	 */
	setThinkingLevel(level: ThinkingLevel): void {
		const availableLevels = this.getAvailableThinkingLevels();
		const effectiveLevel = availableLevels.includes(level) ? level : this._clampThinkingLevel(level, availableLevels);

		// Only persist if actually changing
		const previousLevel = this.agent.state.thinkingLevel;
		const isChanging = effectiveLevel !== previousLevel;

		this.agent.state.thinkingLevel = effectiveLevel;

		if (isChanging) {
			this.sessionManager.appendThinkingLevelChange(effectiveLevel);
			if (this.supportsThinking() || effectiveLevel !== "off") {
				this.settingsManager.setDefaultThinkingLevel(effectiveLevel);
			}
			this._emit({ type: "thinking_level_changed", level: effectiveLevel });
			void this._extensionRunner.emit({
				type: "thinking_level_select",
				level: effectiveLevel,
				previousLevel,
			});
		}
	}

	/**
	 * Cycle to next thinking level.
	 * @returns New level, or undefined if model doesn't support thinking
	 */
	cycleThinkingLevel(): ThinkingLevel | undefined {
		if (!this.supportsThinking()) return undefined;

		const levels = this.getAvailableThinkingLevels();
		const currentIndex = levels.indexOf(this.thinkingLevel);
		const nextIndex = (currentIndex + 1) % levels.length;
		const nextLevel = levels[nextIndex];

		this.setThinkingLevel(nextLevel);
		return nextLevel;
	}

	/**
	 * Get available thinking levels for current model.
	 * The provider will clamp to what the specific model supports internally.
	 */
	getAvailableThinkingLevels(): ThinkingLevel[] {
		if (!this.model) return THINKING_LEVELS;
		return getSupportedThinkingLevels(this.model) as ThinkingLevel[];
	}

	/**
	 * Check if current model supports thinking/reasoning.
	 */
	supportsThinking(): boolean {
		return !!this.model?.reasoning;
	}

	private _getThinkingLevelForModelSwitch(explicitLevel?: ThinkingLevel): ThinkingLevel {
		if (explicitLevel !== undefined) {
			return explicitLevel;
		}
		if (!this.supportsThinking()) {
			return this.settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL;
		}
		return this.thinkingLevel;
	}

	private _clampThinkingLevel(level: ThinkingLevel, _availableLevels: ThinkingLevel[]): ThinkingLevel {
		return this.model ? (clampThinkingLevel(this.model, level) as ThinkingLevel) : "off";
	}

	// =========================================================================
	// Queue Mode Management
	// =========================================================================

	private syncQueueModesFromSettings(): void {
		this.agent.steeringMode = this.settingsManager.getSteeringMode();
		this.agent.followUpMode = this.settingsManager.getFollowUpMode();
	}

	/**
	 * Set steering message mode.
	 * Saves to settings.
	 */
	setSteeringMode(mode: "all" | "one-at-a-time"): void {
		this.agent.steeringMode = mode;
		this.settingsManager.setSteeringMode(mode);
	}

	/**
	 * Set follow-up message mode.
	 * Saves to settings.
	 */
	setFollowUpMode(mode: "all" | "one-at-a-time"): void {
		this.agent.followUpMode = mode;
		this.settingsManager.setFollowUpMode(mode);
	}

	// =========================================================================
	// Compaction
	// =========================================================================

	/**
	 * Manually compact the session context.
	 * Aborts current agent operation first.
	 * @param customInstructions Optional instructions for the compaction summary
	 */
	async compact(customInstructions?: string): Promise<CompactionResult> {
		await this.abort();
		this._beginModelBrokerOperation();
		this._compactionAbortController = new AbortController();
		this._emit({ type: "compaction_start", reason: "manual" });

		try {
			if (!this.model) {
				throw new Error(formatNoModelSelectedMessage());
			}

			const { model: requestModel, apiKey, headers, env } = await this._getSummarizationRequestAuth(this.model);

			const pathEntries = this.sessionManager.getBranch();
			const settings = this.settingsManager.getCompactionSettings();

			const preparation = prepareCompaction(pathEntries, settings);
			if (!preparation) {
				// Check why we can't compact
				const lastEntry = pathEntries[pathEntries.length - 1];
				if (lastEntry?.type === "compaction") {
					throw new Error("Already compacted");
				}
				throw new Error("Nothing to compact (session too small)");
			}

			let extensionCompaction: CompactionResult | undefined;
			let fromExtension = false;

			if (this._extensionRunner.hasHandlers("session_before_compact")) {
				const result = (await this._extensionRunner.emit({
					type: "session_before_compact",
					preparation,
					branchEntries: pathEntries,
					customInstructions,
					reason: "manual",
					willRetry: false,
					signal: this._compactionAbortController.signal,
				})) as SessionBeforeCompactResult | undefined;

				if (result?.cancel) {
					throw new Error("Compaction cancelled");
				}

				if (result?.compaction) {
					extensionCompaction = result.compaction;
					fromExtension = true;
				}
			}

			let summary: string;
			let firstKeptEntryId: string;
			let tokensBefore: number;
			let usage: Usage | undefined;
			let details: unknown;

			let compactionSnapshot: ContextSnapshot | undefined;

			if (extensionCompaction) {
				// Extension provided compaction content
				summary = extensionCompaction.summary;
				firstKeptEntryId = extensionCompaction.firstKeptEntryId;
				tokensBefore = extensionCompaction.tokensBefore;
				usage = extensionCompaction.usage;
				details = extensionCompaction.details;
			} else {
				// Generate compaction result
				const result = await compact(
					preparation,
					requestModel,
					apiKey,
					headers,
					customInstructions,
					this._compactionAbortController.signal,
					this.thinkingLevel,
					this._createSummarizationStreamBoundary("compaction"),
					env,
					this.settingsManager.getRetrySettings(),
					this._summarizationRetryCallbacks({ source: "compaction", reason: "manual" }),
				);
				summary = result.summary;
				firstKeptEntryId = result.firstKeptEntryId;
				tokensBefore = result.tokensBefore;
				usage = result.usage;
				details = result.details;
				if (this.settingsManager.getContextSettings().enabled) {
					const snapshotId = this.getLastContextSnapshotId();
					compactionSnapshot = snapshotId ? this.sessionManager.getContextSnapshot(snapshotId) : undefined;
				}
			}

			if (compactionSnapshot) {
				const baseDetails =
					details && typeof details === "object" && !Array.isArray(details)
						? (details as CompactionDetails)
						: ({ readFiles: [], modifiedFiles: [] } as CompactionDetails);
				const merged: CompactionDetails = {
					...baseDetails,
					readFiles: Array.isArray(baseDetails.readFiles) ? baseDetails.readFiles : [],
					modifiedFiles: Array.isArray(baseDetails.modifiedFiles) ? baseDetails.modifiedFiles : [],
					contextSnapshotId: compactionSnapshot.id,
					contextBudget: { ...compactionSnapshot.budget },
				};
				details = merged;
			}

			if (this._compactionAbortController.signal.aborted) {
				throw new Error("Compaction cancelled");
			}

			this.sessionManager.appendCompaction(summary, firstKeptEntryId, tokensBefore, details, fromExtension, usage);
			const newEntries = this.sessionManager.getEntries();
			const sessionContext = this.sessionManager.buildSessionContext();
			this.agent.state.messages = sessionContext.messages;
			const estimatedTokensAfter = estimateMessagesTokens(sessionContext.messages);

			// Get the saved compaction entry for the extension event
			const savedCompactionEntry = newEntries.find((e) => e.type === "compaction" && e.summary === summary) as
				| CompactionEntry
				| undefined;

			if (this._extensionRunner && savedCompactionEntry) {
				await this._extensionRunner.emit({
					type: "session_compact",
					compactionEntry: savedCompactionEntry,
					fromExtension,
					reason: "manual",
					willRetry: false,
				});
			}

			const compactionResult: CompactionResult = {
				summary,
				firstKeptEntryId,
				tokensBefore,
				estimatedTokensAfter,
				usage,
				details,
			};
			// compaction_end listeners may submit queued prompts, so expose idle state before notifying them.
			this._compactionAbortController = undefined;
			this._emit({
				type: "compaction_end",
				reason: "manual",
				result: compactionResult,
				aborted: false,
				willRetry: false,
			});
			return compactionResult;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const aborted = message === "Compaction cancelled" || (error instanceof Error && error.name === "AbortError");
			this._compactionAbortController = undefined;
			this._emit({
				type: "compaction_end",
				reason: "manual",
				result: undefined,
				aborted,
				willRetry: false,
				errorMessage: aborted ? undefined : `Compaction failed: ${message}`,
			});
			throw error;
		} finally {
			this._compactionAbortController = undefined;
		}
	}

	/**
	 * Cancel in-progress compaction (manual or auto).
	 */
	abortCompaction(): void {
		this._compactionAbortController?.abort();
		this._autoCompactionAbortController?.abort();
	}

	/**
	 * Cancel in-progress branch summarization.
	 */
	abortBranchSummary(): void {
		this._branchSummaryAbortController?.abort();
	}

	/**
	 * Check if compaction is needed and run it.
	 * Called after agent_end and before prompt submission.
	 *
	 * Two cases:
	 * 1. Recoverable failure: LLM returned context overflow or stopped below its desired output limit;
	 *    remove the assistant message, compact, and auto-retry once
	 * 2. Threshold: Context over threshold, compact, NO auto-retry (user continues manually)
	 *
	 * @param assistantMessage The assistant message to check
	 * @param skipAbortedCheck If false, include aborted messages (for pre-prompt check). Default: true
	 */
	private async _checkCompaction(assistantMessage: AssistantMessage, skipAbortedCheck = true): Promise<boolean> {
		const settings = this.settingsManager.getCompactionSettings();
		if (!settings.enabled) return false;

		// Skip if message was aborted (user cancelled) - unless skipAbortedCheck is false
		if (skipAbortedCheck && assistantMessage.stopReason === "aborted") return false;

		const contextWindow = this.model?.contextWindow ?? 0;

		// Skip overflow check if the message came from a different model.
		// This handles the case where user switched from a smaller-context model (e.g. opus)
		// to a larger-context model (e.g. codex) - the overflow error from the old model
		// shouldn't trigger compaction for the new model.
		const sameModel =
			this.model && assistantMessage.provider === this.model.provider && assistantMessage.model === this.model.id;

		// Skip compaction checks if this assistant message is older than the latest
		// compaction boundary. This prevents a stale pre-compaction usage/error
		// from retriggering compaction on the first prompt after compaction.
		const compactionEntry = getLatestCompactionEntry(this.sessionManager.getBranch());
		const assistantIsFromBeforeCompaction =
			compactionEntry !== null && assistantMessage.timestamp <= new Date(compactionEntry.timestamp).getTime();
		if (assistantIsFromBeforeCompaction) {
			return false;
		}

		// Case 1: Recoverable failure. Explicit/silent context overflow still uses context metadata.
		// A length stop is recoverable when output ended below the model's original desired limit,
		// independent of the configured context size or any context-clamped provider request limit.
		// A successful response over the configured window should compact but must not retry: the
		// assistant answer already completed and agent.continue() cannot continue from an assistant.
		const recoverableLength = sameModel && isRecoverableLength(assistantMessage, this.model?.maxTokens ?? 0);
		if (sameModel && (isContextOverflow(assistantMessage, contextWindow) || recoverableLength)) {
			const willRetry = assistantMessage.stopReason !== "stop";

			if (!willRetry) {
				return await this._runAutoCompaction("overflow", false);
			}

			if (this._overflowRecoveryAttempted) {
				this._emit({
					type: "compaction_end",
					reason: "overflow",
					result: undefined,
					aborted: false,
					willRetry: false,
					errorMessage:
						"Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model.",
				});
				return false;
			}

			this._overflowRecoveryAttempted = true;
			// Remove the failed or truncated message from agent state. It remains in session history,
			// but must not be included in the compact-and-retry context.
			const messages = this.agent.state.messages;
			if (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
				this.agent.state.messages = messages.slice(0, -1);
			}
			return await this._runAutoCompaction("overflow", willRetry);
		}

		// Case 2: Threshold - context is getting large
		// For error messages or all-zero usage messages, estimate from the last valid response.
		// This ensures sessions that hit persistent API errors (e.g. 529) or malformed zero-usage
		// responses can still compact and do not reset context accounting.
		let contextTokens: number;
		const directContextTokens = assistantMessage.usage ? calculateContextTokens(assistantMessage.usage) : 0;
		if (assistantMessage.stopReason === "error" || directContextTokens === 0) {
			const messages = this.agent.state.messages;
			const estimate = estimateContextTokens(messages);
			if (estimate.lastUsageIndex === null) return false; // No usage data at all
			// Verify the usage source is post-compaction. Kept pre-compaction messages
			// have stale usage reflecting the old (larger) context and would falsely
			// trigger compaction right after one just finished.
			const usageMsg = messages[estimate.lastUsageIndex];
			if (
				compactionEntry &&
				usageMsg.role === "assistant" &&
				(usageMsg as AssistantMessage).timestamp <= new Date(compactionEntry.timestamp).getTime()
			) {
				return false;
			}
			contextTokens = estimate.tokens;
		} else {
			contextTokens = directContextTokens;
		}
		if (shouldCompact(contextTokens, contextWindow, settings)) {
			return await this._runAutoCompaction("threshold", false);
		}
		return false;
	}

	/**
	 * Internal: Run auto-compaction with events.
	 */
	private async _runAutoCompaction(reason: "overflow" | "threshold", willRetry: boolean): Promise<boolean> {
		const settings = this.settingsManager.getCompactionSettings();
		let started = false;

		try {
			if (!this.model) {
				return false;
			}

			const { model: requestModel, apiKey, headers, env } = await this._getSummarizationRequestAuth(this.model);

			const pathEntries = this.sessionManager.getBranch();

			const preparation = prepareCompaction(pathEntries, settings);
			if (!preparation) {
				return false;
			}

			this._emit({ type: "compaction_start", reason });
			this._autoCompactionAbortController = new AbortController();
			started = true;

			let extensionCompaction: CompactionResult | undefined;
			let fromExtension = false;

			if (this._extensionRunner.hasHandlers("session_before_compact")) {
				const extensionResult = (await this._extensionRunner.emit({
					type: "session_before_compact",
					preparation,
					branchEntries: pathEntries,
					customInstructions: undefined,
					reason,
					willRetry,
					signal: this._autoCompactionAbortController.signal,
				})) as SessionBeforeCompactResult | undefined;

				if (extensionResult?.cancel) {
					this._emit({
						type: "compaction_end",
						reason,
						result: undefined,
						aborted: true,
						willRetry: false,
					});
					return false;
				}

				if (extensionResult?.compaction) {
					extensionCompaction = extensionResult.compaction;
					fromExtension = true;
				}
			}

			let summary: string;
			let firstKeptEntryId: string;
			let tokensBefore: number;
			let usage: Usage | undefined;
			let details: unknown;

			let autoCompactionSnapshot: ContextSnapshot | undefined;

			if (extensionCompaction) {
				// Extension provided compaction content
				summary = extensionCompaction.summary;
				firstKeptEntryId = extensionCompaction.firstKeptEntryId;
				tokensBefore = extensionCompaction.tokensBefore;
				usage = extensionCompaction.usage;
				details = extensionCompaction.details;
			} else {
				// Generate compaction result
				const compactResult = await compact(
					preparation,
					requestModel,
					apiKey,
					headers,
					undefined,
					this._autoCompactionAbortController.signal,
					this.thinkingLevel,
					this._createSummarizationStreamBoundary("compaction"),
					env,
					this.settingsManager.getRetrySettings(),
					this._summarizationRetryCallbacks({ source: "compaction", reason }),
				);
				summary = compactResult.summary;
				firstKeptEntryId = compactResult.firstKeptEntryId;
				tokensBefore = compactResult.tokensBefore;
				usage = compactResult.usage;
				details = compactResult.details;
				if (this.settingsManager.getContextSettings().enabled) {
					const snapshotId = this.getLastContextSnapshotId();
					autoCompactionSnapshot = snapshotId ? this.sessionManager.getContextSnapshot(snapshotId) : undefined;
				}
			}

			if (autoCompactionSnapshot) {
				const baseDetails =
					details && typeof details === "object" && !Array.isArray(details)
						? (details as CompactionDetails)
						: ({ readFiles: [], modifiedFiles: [] } as CompactionDetails);
				details = {
					...baseDetails,
					readFiles: Array.isArray(baseDetails.readFiles) ? baseDetails.readFiles : [],
					modifiedFiles: Array.isArray(baseDetails.modifiedFiles) ? baseDetails.modifiedFiles : [],
					contextSnapshotId: autoCompactionSnapshot.id,
					contextBudget: { ...autoCompactionSnapshot.budget },
				} satisfies CompactionDetails;
			}

			if (this._autoCompactionAbortController.signal.aborted) {
				this._emit({
					type: "compaction_end",
					reason,
					result: undefined,
					aborted: true,
					willRetry: false,
				});
				return false;
			}

			this.sessionManager.appendCompaction(summary, firstKeptEntryId, tokensBefore, details, fromExtension, usage);
			const newEntries = this.sessionManager.getEntries();
			const sessionContext = this.sessionManager.buildSessionContext();
			this.agent.state.messages = sessionContext.messages;
			const estimatedTokensAfter = estimateMessagesTokens(sessionContext.messages);

			// Get the saved compaction entry for the extension event
			const savedCompactionEntry = newEntries.find((e) => e.type === "compaction" && e.summary === summary) as
				| CompactionEntry
				| undefined;

			if (this._extensionRunner && savedCompactionEntry) {
				await this._extensionRunner.emit({
					type: "session_compact",
					compactionEntry: savedCompactionEntry,
					fromExtension,
					reason,
					willRetry,
				});
			}

			const result: CompactionResult = {
				summary,
				firstKeptEntryId,
				tokensBefore,
				estimatedTokensAfter,
				usage,
				details,
			};
			this._emit({ type: "compaction_end", reason, result, aborted: false, willRetry });

			if (willRetry) {
				const messages = this.agent.state.messages;
				const lastMsg = messages[messages.length - 1];
				// The overflow response was persisted on message_end before _checkCompaction() removed it
				// from agent state. Rebuilding state from the new compaction can restore that kept entry,
				// leaving an assistant as the final message. agent.continue() rejects that state, so remove
				// the retriable error or truncated-length response again before continuing the interrupted turn.
				if (lastMsg?.role === "assistant" && (lastMsg.stopReason === "error" || lastMsg.stopReason === "length")) {
					this.agent.state.messages = messages.slice(0, -1);
				}
				return true;
			}

			// Auto-compaction can complete while follow-up/steering/custom messages are waiting.
			// Continue once so queued messages are delivered.
			return this.agent.hasQueuedMessages();
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : "compaction failed";
			if (started) {
				this._emit({
					type: "compaction_end",
					reason,
					result: undefined,
					aborted: false,
					willRetry: false,
					errorMessage:
						reason === "overflow"
							? `Context overflow recovery failed: ${errorMessage}`
							: `Auto-compaction failed: ${errorMessage}`,
				});
			}
			return false;
		} finally {
			this._autoCompactionAbortController = undefined;
		}
	}

	/**
	 * Toggle auto-compaction setting.
	 */
	setAutoCompactionEnabled(enabled: boolean): void {
		this.settingsManager.setCompactionEnabled(enabled);
	}

	/** Whether auto-compaction is enabled */
	get autoCompactionEnabled(): boolean {
		return this.settingsManager.getCompactionEnabled();
	}

	async bindExtensions(bindings: ExtensionBindings): Promise<void> {
		if (bindings.uiContext !== undefined) {
			this._extensionUIContext = bindings.uiContext;
		}
		if (bindings.mode !== undefined) {
			this._extensionMode = bindings.mode;
		}
		if (bindings.commandContextActions !== undefined) {
			this._extensionCommandContextActions = bindings.commandContextActions;
		}
		if (bindings.abortHandler !== undefined) {
			this._extensionAbortHandler = bindings.abortHandler;
		}
		if (bindings.shutdownHandler !== undefined) {
			this._extensionShutdownHandler = bindings.shutdownHandler;
		}
		if (bindings.onError !== undefined) {
			this._extensionErrorListener = bindings.onError;
		}

		this._applyExtensionBindings(this._extensionRunner);
		await this._extensionRunner.emit(this._sessionStartEvent);
		await this.extendResourcesFromExtensions(this._sessionStartEvent.reason === "reload" ? "reload" : "startup");
	}

	private async extendResourcesFromExtensions(reason: "startup" | "reload"): Promise<void> {
		if (!this._extensionRunner.hasHandlers("resources_discover")) {
			return;
		}

		const { skillPaths, promptPaths, themePaths } = await this._extensionRunner.emitResourcesDiscover(
			this._cwd,
			reason,
		);

		if (skillPaths.length === 0 && promptPaths.length === 0 && themePaths.length === 0) {
			return;
		}

		const extensionPaths: ResourceExtensionPaths = {
			skillPaths: this.buildExtensionResourcePaths(skillPaths),
			promptPaths: this.buildExtensionResourcePaths(promptPaths),
			themePaths: this.buildExtensionResourcePaths(themePaths),
		};

		this._resourceLoader.extendResources(extensionPaths);
		this._baseSystemPrompt = this._rebuildSystemPrompt(this.getActiveToolNames());
		this.agent.state.systemPrompt = this._baseSystemPrompt;
	}

	private buildExtensionResourcePaths(entries: Array<{ path: string; extensionPath: string }>): Array<{
		path: string;
		metadata: { source: string; scope: "temporary"; origin: "top-level"; baseDir?: string };
	}> {
		return entries.map((entry) => {
			const source = this.getExtensionSourceLabel(entry.extensionPath);
			const baseDir = entry.extensionPath.startsWith("<") ? undefined : dirname(entry.extensionPath);
			return {
				path: entry.path,
				metadata: {
					source,
					scope: "temporary",
					origin: "top-level",
					baseDir,
				},
			};
		});
	}

	private getExtensionSourceLabel(extensionPath: string): string {
		if (extensionPath.startsWith("<")) {
			return `extension:${extensionPath.replace(/[<>]/g, "")}`;
		}
		const base = basename(extensionPath);
		const name = base.replace(/\.(ts|js)$/, "");
		return `extension:${name}`;
	}

	private _applyExtensionBindings(runner: ExtensionRunner): void {
		runner.setUIContext(this._extensionUIContext, this._extensionMode);
		runner.bindCommandContext(this._extensionCommandContextActions);

		this._extensionErrorUnsubscriber?.();
		this._extensionErrorUnsubscriber = this._extensionErrorListener
			? runner.onError(this._extensionErrorListener)
			: undefined;
	}

	private _refreshCurrentModelFromRegistry(): void {
		const currentModel = this.model;
		if (!currentModel) {
			return;
		}

		const refreshedModel = this._modelRuntime.getModel(currentModel.provider, currentModel.id);
		if (!refreshedModel || refreshedModel === currentModel) {
			return;
		}

		this.agent.state.model = refreshedModel;
	}

	private _bindExtensionCore(runner: ExtensionRunner): void {
		const getCommands = (): SlashCommandInfo[] => {
			const extensionCommands: SlashCommandInfo[] = runner.getRegisteredCommands().map((command) => ({
				name: command.invocationName,
				description: command.description,
				source: "extension",
				sourceInfo: command.sourceInfo,
			}));

			const templates: SlashCommandInfo[] = this.promptTemplates.map((template) => ({
				name: template.name,
				description: template.description,
				source: "prompt",
				sourceInfo: template.sourceInfo,
			}));

			const skills: SlashCommandInfo[] = this._resourceLoader.getSkills().skills.map((skill) => ({
				name: `skill:${skill.name}`,
				description: skill.description,
				source: "skill",
				sourceInfo: skill.sourceInfo,
			}));

			return [...extensionCommands, ...templates, ...skills];
		};

		runner.bindCore(
			{
				sendMessage: (message, options) => {
					this.sendCustomMessage(message, options).catch((err) => {
						runner.emitError({
							extensionPath: "<runtime>",
							event: "send_message",
							error: err instanceof Error ? err.message : String(err),
						});
					});
				},
				sendUserMessage: (content, options) => {
					this.sendUserMessage(content, options).catch((err) => {
						runner.emitError({
							extensionPath: "<runtime>",
							event: "send_user_message",
							error: err instanceof Error ? err.message : String(err),
						});
					});
				},
				appendEntry: (customType, data) => {
					const entryId = this.sessionManager.appendCustomEntry(customType, data);
					const entry = this.sessionManager.getEntry(entryId);
					if (entry) {
						this._emit({ type: "entry_appended", entry });
					}
				},
				setSessionName: (name) => {
					this.setSessionName(name);
				},
				getSessionName: () => {
					return this.sessionManager.getSessionName();
				},
				setLabel: (entryId, label) => {
					this.sessionManager.appendLabelChange(entryId, label);
				},
				getActiveTools: () => this.getActiveToolNames(),
				getAllTools: () => this.getAllTools(),
				setActiveTools: (toolNames) => this.setActiveToolsByName(toolNames),
				refreshTools: () => this._refreshToolRegistry(),
				getCommands,
				exec: (command, args, options) => this._executeExtensionExec(command, args, options),
				setModel: async (model) => {
					if (!this._modelRuntime.hasConfiguredAuth(model.provider)) return false;
					await this.setModel(model);
					return true;
				},
				getThinkingLevel: () => this.thinkingLevel,
				setThinkingLevel: (level) => this.setThinkingLevel(level),
			},
			{
				getModel: () => this.model,
				getScopedModels: () => this._scopedModels,
				isIdle: () => this.isIdle,
				isProjectTrusted: () => this.settingsManager.isProjectTrusted(),
				getSignal: () => this.agent.signal,
				abort: () => {
					if (this._extensionAbortHandler) {
						this._extensionAbortHandler();
						return;
					}
					void this.abort();
				},
				hasPendingMessages: () => this.pendingMessageCount > 0,
				shutdown: () => {
					this._extensionShutdownHandler?.();
				},
				getContextUsage: () => this.getContextUsage(),
				compact: (options) => {
					void (async () => {
						try {
							const result = await this.compact(options?.customInstructions);
							options?.onComplete?.(result);
						} catch (error) {
							const err = error instanceof Error ? error : new Error(String(error));
							options?.onError?.(err);
						}
					})();
				},
				getSystemPrompt: () => this.systemPrompt,
				getSystemPromptOptions: () => this._baseSystemPromptOptions,
			},
			{
				registerProvider: (name, config) => {
					this._modelRuntime.registerProvider(name, config);
					this._refreshCurrentModelFromRegistry();
				},
				registerNativeProvider: (provider) => {
					this._modelRuntime.registerNativeProvider(provider);
					this._refreshCurrentModelFromRegistry();
				},
				unregisterProvider: (name) => {
					this._modelRuntime.unregisterProvider(name);
					this._refreshCurrentModelFromRegistry();
				},
			},
		);
	}

	private _refreshToolRegistry(options?: { activeToolNames?: string[]; includeAllExtensionTools?: boolean }): void {
		// An active agent run is bound to the frozen capability binding. Tool
		// registration / allowlist changes cannot mutate it mid-run; defer until
		// the run settles so the next binding can be re-resolved.
		if (this._isAgentRunActive) {
			this._pendingToolRegistryRefresh = true;
			return;
		}

		// Re-resolve the frozen binding from the current candidates. `tools` /
		// `excludeTools` / `noTools` are applied as the final narrowing inside the
		// registry, so the binding's toolAllowlist is authoritative.
		let binding: CapabilityBinding;
		try {
			binding = this._resolveCapabilityBinding();
		} catch (error) {
			if (error instanceof CapabilityNameConflictError) {
				// Fail closed: two selected capabilities expose the same tool name.
				// Record the conflict and expose no ambiguous tool set so it
				// surfaces through whenCapabilitiesReady()/prompt preflight rather
				// than crashing construction or silently choosing a winner.
				this._capabilityDiscoveryError = error;
				this._activeCapabilityBinding = undefined;
				this._toolDefinitions = new Map();
				this._toolRegistry = new Map();
				this._toolPromptSnippets = new Map();
				this._toolPromptGuidelines = new Map();
				this.setActiveToolsByName([]);
				return;
			}
			throw error;
		}
		const allowedToolNames = new Set(binding.toolAllowlist);
		const previousRegistryNames = new Set(this._toolRegistry.keys());
		const previousActiveToolNames = this.getActiveToolNames();

		const registeredTools = this._extensionRunner.getAllRegisteredTools();
		const allCustomTools = [
			...registeredTools,
			...this._customTools.map((definition) => ({
				definition,
				sourceInfo: createSyntheticSourceInfo(`<sdk:${definition.name}>`, { source: "sdk" }),
			})),
		].filter((tool) => allowedToolNames.has(tool.definition.name));
		const definitionRegistry = new Map<string, ToolDefinitionEntry>(
			Array.from(this._baseToolDefinitions.entries())
				.filter(([name]) => allowedToolNames.has(name))
				.map(([name, definition]) => [
					name,
					{
						definition,
						sourceInfo: createSyntheticSourceInfo(`<builtin:${name}>`, { source: "builtin" }),
					},
				]),
		);
		for (const tool of allCustomTools) {
			definitionRegistry.set(tool.definition.name, {
				definition: tool.definition,
				sourceInfo: tool.sourceInfo,
			});
		}
		// MCP tools discovered from binding-selected servers enter the registry
		// under their namespaced names, bounded by the same capability binding.
		for (const result of this._activeMcpTools) {
			if (!allowedToolNames.has(result.definition.name)) {
				continue;
			}
			definitionRegistry.set(result.definition.name, {
				// The MCP adapter specializes ToolDefinition with MCPCallResult
				// details; the shared registry treats tool definitions opaquely.
				definition: result.definition as unknown as ToolDefinition,
				sourceInfo: createSyntheticSourceInfo(`<mcp:${result.mapping.exposedToolName}>`, {
					source: result.mapping.sourceIdentity,
				}),
			});
		}
		this._toolDefinitions = definitionRegistry;
		this._toolPromptSnippets = new Map(
			Array.from(definitionRegistry.values())
				.map(({ definition }) => {
					const snippet = this._normalizePromptSnippet(definition.promptSnippet);
					return snippet ? ([definition.name, snippet] as const) : undefined;
				})
				.filter((entry): entry is readonly [string, string] => entry !== undefined),
		);
		this._toolPromptGuidelines = new Map(
			Array.from(definitionRegistry.values())
				.map(({ definition }) => {
					const guidelines = this._normalizePromptGuidelines(definition.promptGuidelines);
					return guidelines.length > 0 ? ([definition.name, guidelines] as const) : undefined;
				})
				.filter((entry): entry is readonly [string, string[]] => entry !== undefined),
		);
		const runner = this._extensionRunner;
		const wrappedExtensionTools = wrapRegisteredTools(allCustomTools, runner).map((tool) =>
			this._wrapToolWithPolicyInvocation(tool, this._toolInvocationSourceFor(tool.name)),
		);
		const wrappedBuiltInTools = wrapRegisteredTools(
			Array.from(this._baseToolDefinitions.values())
				.filter((definition) => allowedToolNames.has(definition.name))
				.map((definition) => ({
					definition,
					sourceInfo: createSyntheticSourceInfo(`<builtin:${definition.name}>`, { source: "builtin" }),
				})),
			runner,
		).map((tool) => this._wrapToolWithPolicyInvocation(tool, "builtin"));
		const wrappedMcpTools = wrapRegisteredTools(
			Array.from(definitionRegistry.entries())
				.filter(([name, entry]) => allowedToolNames.has(name) && entry.sourceInfo.source.startsWith("mcp"))
				.map(([name, entry]) => ({
					definition: entry.definition,
					sourceInfo: entry.sourceInfo,
				})),
			runner,
		).map((tool) => this._wrapToolWithPolicyInvocation(tool, "mcp"));

		const toolRegistry = new Map(wrappedBuiltInTools.map((tool) => [tool.name, tool]));
		for (const tool of wrappedExtensionTools as AgentTool[]) {
			toolRegistry.set(tool.name, tool);
		}
		for (const tool of wrappedMcpTools as AgentTool[]) {
			toolRegistry.set(tool.name, tool);
		}
		this._toolRegistry = toolRegistry;

		const nextActiveToolNames = (
			options?.activeToolNames ? [...options.activeToolNames] : [...previousActiveToolNames]
		).filter((name) => allowedToolNames.has(name));

		if (this._allowedToolNames) {
			for (const toolName of this._toolRegistry.keys()) {
				if (this._allowedToolNames.has(toolName)) {
					nextActiveToolNames.push(toolName);
				}
			}
		} else if (options?.includeAllExtensionTools) {
			for (const tool of wrappedExtensionTools) {
				nextActiveToolNames.push(tool.name);
			}
			for (const tool of wrappedMcpTools) {
				nextActiveToolNames.push(tool.name);
			}
		} else if (!options?.activeToolNames) {
			for (const toolName of this._toolRegistry.keys()) {
				if (!previousRegistryNames.has(toolName)) {
					nextActiveToolNames.push(toolName);
				}
			}
		}

		this.setActiveToolsByName([...new Set(nextActiveToolNames)]);
	}

	/**
	 * Resolve the frozen capability binding for the current runtime. Builds
	 * candidate descriptors for builtin / extension / SDK tools and skills, plus
	 * configured MCP servers and any discovered MCP tools, then applies the
	 * profile rules and the tools / excludeTools / noTools narrowing.
	 *
	 * Same-named static tools remain in the complete catalog; the registry fails
	 * closed with capability_name_conflict when selected instead of applying an
	 * implicit source-precedence override.
	 */
	private _resolveCapabilityBinding(): CapabilityBinding {
		const capabilitySettings = this.settingsManager.getCapabilitySettings();
		this._registerConfiguredMcpServers(capabilitySettings);
		const candidates = this._collectCapabilityCandidates(capabilitySettings);
		const catalog = this._capabilityRegistry.buildCatalog({ candidates });
		this._activeCapabilityCatalog = catalog;
		const binding = this._capabilityRegistry.resolveBinding({
			...this._resolveBindingInput(),
			catalog,
		});

		this._activeCapabilityBinding = binding;
		this._syncSelectedMcpServers(binding, catalog);
		return binding;
	}

	/**
	 * Shared binding inputs for the current runtime: the active (or default)
	 * profile, session-local approvals, and the tools / excludeTools / noTools
	 * final narrowing. The catalog is supplied separately by the caller.
	 */
	private _resolveBindingInput(): Omit<ResolveBindingInput, "catalog"> {
		const capabilitySettings = this.settingsManager.getCapabilitySettings();
		const excludeToolNames = new Set(this._excludedToolNames ?? []);
		return {
			profile: this._activeCapabilityProfile ?? capabilitySettings.defaultProfile,
			profiles: capabilitySettings.profiles,
			approvedDescriptorIds: this._capabilityApprovedDescriptorIds,
			toolAllowlist: this._allowedToolNames ? [...this._allowedToolNames] : undefined,
			excludeToolNames: [...excludeToolNames],
			noTools: this._noTools === "all",
		};
	}

	/**
	 * Materialize a profile into the actual frozen binding, active tool set, and
	 * MCP selection. Only invoked while the session is idle (or after a run
	 * settles) so a running binding is never mutated.
	 *
	 * The previous profile's MCP selection is torn down before the new profile is
	 * resolved so materialization fails closed: if the new profile cannot resolve
	 * (for example a selected static name conflict), the previous profile can
	 * never leave selected/ready MCP connections alive. The new binding's server
	 * selection is applied by _refreshCapabilitySetup and connected during
	 * discovery.
	 *
	 * Transitions are serialized onto a queue so the session's profile transitions
	 * are deterministic: a transition blocked on a slow teardown (a delayed
	 * transport close) never overlaps a later transition's connect, and the
	 * last-invoked profile is the last to materialize. A rejected predecessor is
	 * swallowed so one failed transition cannot wedge the queue for later callers.
	 */
	private async _materializeCapabilityProfile(profileName: string, policyRunId?: string): Promise<void> {
		const run = async (): Promise<void> => {
			await this._mcpLifecycleManager.setSelectedServerIds([]);
			this._activeCapabilityProfile = profileName;
			await this._refreshCapabilitySetup(policyRunId);
		};
		const previous = this._profileMaterializationTail;
		const next = previous.catch(() => undefined).then(run);
		this._profileMaterializationTail = next;
		return next;
	}

	/**
	 * Rebuild the tool registry from the current frozen binding, clear any stale
	 * discovery error, apply the new server selection (awaiting deselection
	 * teardown so a profile -> default/deny transition closes removed servers),
	 * re-run MCP discovery readiness for the current selection, and await
	 * readiness so the caller's promise only resolves once setup is complete.
	 */
	private async _refreshCapabilitySetup(policyRunId?: string): Promise<void> {
		// A profile change starts a fresh MCP discovery attempt. Do not let tools
		// discovered under the previous binding remain visible while the new
		// binding is still being preflighted.
		this._activeMcpTools = [];
		this._activeMcpToolCandidates = [];
		this._activeMcpContentCandidates = [];
		this._pendingMcpAttachments = [];
		this._mcpAuthorizedTransportValues.clear();
		this._capabilityDiscoveryError = undefined;
		this._capabilityDiscoveryStarted = false;
		this._capabilityDiscoveryPromise = Promise.resolve();
		this._refreshToolRegistry({ includeAllExtensionTools: true });
		// The new binding's server selection is applied synchronously by the
		// lifecycle gate (the newest selection wins immediately) while removed
		// servers close in the background; wait for that teardown so no stale
		// live connection survives a profile change that drops a server.
		await this._serverSelectionSyncPromise;
		await this.whenCapabilitiesReady(policyRunId);
	}

	private _registerConfiguredMcpServers(capabilitySettings: CapabilitySettings): void {
		for (const diagnostic of capabilitySettings.mcpServers) {
			if (this._mcpRegisteredServerIds.has(diagnostic.id)) {
				continue;
			}
			const config = { id: diagnostic.id, ...diagnostic.server } as MCPServerConfig;
			this._mcpLifecycleManager.registerServers([config]);
			this._mcpRegisteredServerIds.add(diagnostic.id);
		}
	}

	/** Only binding-selected MCP servers are connectable; the lifecycle enforces this gate. */
	private _syncSelectedMcpServers(binding: CapabilityBinding, catalog: CapabilityCatalog): void {
		const selected = new Set<string>();
		for (const ref of binding.descriptors) {
			if (!ref.id.startsWith("mcp_server:")) {
				continue;
			}
			const descriptor = catalog.descriptors.find((candidate) => candidate.id === ref.id);
			if (descriptor?.mcpServerId !== undefined) {
				selected.add(descriptor.mcpServerId);
			}
		}
		// The gate updates synchronously (the newest selection wins immediately)
		// while the lifecycle closes removed servers in the background. The
		// returned promise is retained so async refresh boundaries can await the
		// deselection teardown before reporting the setup complete.
		this._serverSelectionSyncPromise = this._mcpLifecycleManager.setSelectedServerIds(selected);
	}

	/**
	 * Build the complete static capability catalog for the current runtime:
	 * builtin tools, extension tools, SDK custom tools, skills, configured MCP
	 * servers, and metadata-only extension descriptors. Every static candidate
	 * carries a stable, secret-free revisionInput so behavior changes are never
	 * erased from the revision.
	 *
	 * Same-named builtin / extension / SDK tools are NOT shadowed here: they are
	 * distinct capabilities and the registry fails closed with
	 * capability_name_conflict when a selected collision occurs, instead of this
	 * method silently choosing a winner.
	 *
	 * Extension tools are collected from the complete per-extension collection
	 * (each ResourceLoader extension's own `tools` map), not the runner's
	 * first-registration dedup, so two extensions registering the same exposed
	 * name both reach the registry and a selected collision fails closed before
	 * any provider or tool execution. First-registration runtime behavior is
	 * preserved for non-colliding names by _refreshToolRegistry, which still
	 * reads the runner's deduped set. Each extension_tool candidate links to its
	 * own extension descriptor via parentId so extension rules govern child
	 * tools exactly like an mcp_server governs its mcp_tools.
	 */
	private _collectCapabilityCandidates(capabilitySettings: CapabilitySettings): CapabilityCandidate[] {
		const candidates: CapabilityCandidate[] = [];

		candidates.push(...this._collectExtensionCandidates());

		for (const name of this._baseToolDefinitions.keys()) {
			const definition = this._baseToolDefinitions.get(name)!;
			candidates.push({
				kind: "builtin_tool",
				name,
				localName: name,
				sourceIdentity: "builtin",
				source: createSyntheticSourceInfo(`<builtin:${name}>`, { source: "builtin" }),
				exposedToolName: name,
				revisionInput: this._toolDefinitionRevisionInput(definition),
			});
		}
		for (const extension of this._resourceLoader.getExtensions().extensions) {
			const extensionLocalName = stableExtensionLocalName(extension);
			const extensionDescriptorId = this._capabilityRegistry.createCapabilityId(
				"extension",
				extension.sourceInfo.source,
				extensionLocalName,
			);
			for (const tool of extension.tools.values()) {
				candidates.push({
					kind: "extension_tool",
					name: tool.definition.name,
					localName: `${extensionLocalName}:${tool.definition.name}`,
					sourceIdentity: extension.sourceInfo.source,
					source: tool.sourceInfo,
					exposedToolName: tool.definition.name,
					parentId: extensionDescriptorId,
					trusted: this._staticCandidateTrust(tool.sourceInfo),
					revisionInput: this._toolDefinitionRevisionInput(tool.definition),
				});
			}
		}
		for (const definition of this._customTools) {
			candidates.push({
				kind: "sdk_tool",
				name: definition.name,
				localName: definition.name,
				sourceIdentity: "sdk",
				source: createSyntheticSourceInfo(`<sdk:${definition.name}>`, { source: "sdk" }),
				exposedToolName: definition.name,
				revisionInput: this._toolDefinitionRevisionInput(definition),
			});
		}
		for (const skill of this._resourceLoader.getSkills().skills) {
			const source = skill.sourceInfo ?? createSyntheticSourceInfo(`<skill:${skill.name}>`, { source: "skill" });
			candidates.push({
				kind: "skill",
				name: skill.name,
				localName: skill.name,
				sourceIdentity: source.source,
				source,
				trusted: this._staticCandidateTrust(source),
				revisionInput: this._skillRevisionInput(skill),
			});
		}
		for (const diagnostic of capabilitySettings.mcpServers) {
			candidates.push(createMcpServerCapabilityCandidate(diagnostic));
		}
		for (const candidate of this._activeMcpToolCandidates) {
			candidates.push(candidate);
		}
		for (const candidate of this._activeMcpContentCandidates) {
			candidates.push(candidate);
		}
		return candidates;
	}

	/**
	 * Metadata-only extension descriptors from ResourceLoader extensions. The
	 * descriptor carries public identity and the sorted set of tool names it
	 * registers; it claims no runtime controls beyond the registry's parent
	 * inheritance, so an extension profile rule governs its child tools.
	 */
	private _collectExtensionCandidates(): CapabilityCandidate[] {
		const candidates: CapabilityCandidate[] = [];
		for (const extension of this._resourceLoader.getExtensions().extensions) {
			const localName = stableExtensionLocalName(extension);
			candidates.push({
				kind: "extension",
				name: localName,
				localName,
				sourceIdentity: extension.sourceInfo.source,
				source: extension.sourceInfo,
				trusted: this._staticCandidateTrust(extension.sourceInfo),
				revisionInput: {
					name: localName,
					source: extension.sourceInfo,
					toolNames: [...extension.tools.keys()].sort(),
				},
			});
		}
		return candidates;
	}

	/**
	 * Explicit trust for static project resources. Project-scoped candidates
	 * inherit the project trust decision so a trusted project's extensions, their
	 * tools, and skills become trusted; untrusted projects stay force-denied. All
	 * other scopes (user/temporary) leave trust undefined so the registry's
	 * defaultTrustFor behavior is preserved exactly.
	 */
	private _staticCandidateTrust(source: SourceInfo): boolean | undefined {
		return source.scope === "project" ? this.settingsManager.isProjectTrusted() : undefined;
	}

	/**
	 * Stable, secret-free revision identity for a tool definition: the public
	 * behavior surface (name, label, description, schema, prompt snippet and
	 * guidelines, sampling/execution/rendering options). Execute callbacks,
	 * argument preparation, renderers, and any private state are excluded.
	 */
	private _toolDefinitionRevisionInput(definition: ToolDefinition): unknown {
		return {
			name: definition.name,
			label: definition.label,
			description: definition.description,
			parameters: definition.parameters,
			promptSnippet: definition.promptSnippet,
			promptGuidelines: definition.promptGuidelines,
			constrainedSampling: definition.constrainedSampling,
			executionMode: definition.executionMode,
			renderShell: definition.renderShell,
		};
	}

	/**
	 * Stable, secret-free revision identity for a skill: its stable identity plus
	 * the SKILL.md content and public metadata. Unreadable content resolves to a
	 * deterministic marker so the revision stays stable and never embeds an
	 * error string.
	 */
	private _skillRevisionInput(skill: Skill): unknown {
		let content: string | undefined;
		try {
			content = readFileSync(skill.filePath, "utf-8");
		} catch {
			content = undefined;
		}
		return {
			name: skill.name,
			description: skill.description,
			disableModelInvocation: skill.disableModelInvocation,
			source: skill.sourceInfo,
			content,
		};
	}

	/**
	 * Connect only binding-selected trusted MCP servers, discover their tools, and
	 * re-resolve the binding with the namespaced mcp_tool descriptors. Failures
	 * are recorded redacted and fail discovery closed; the server and its tools
	 * stay out of the binding.
	 */
	private async _discoverMcpToolsForBinding(policyRunId?: string, signal?: AbortSignal): Promise<void> {
		const binding = this._activeCapabilityBinding;
		const catalog = this._activeCapabilityCatalog;
		if (!binding || !catalog) {
			return;
		}
		const selectedServerIds = this._mcpLifecycleManager.getSelectedServerIds();
		if (selectedServerIds.size === 0) {
			return;
		}

		const capabilitySettings = this.settingsManager.getCapabilitySettings();
		const diagnosticByServerId = new Map(
			capabilitySettings.mcpServers.map((diagnostic) => [diagnostic.id, diagnostic]),
		);

		const mcpResults: MCPToolDefinitionResult[] = [];
		const mcpCandidates: CapabilityCandidate[] = [];
		for (const serverId of [...selectedServerIds]) {
			if (signal?.aborted) throw new DOMException("MCP capability discovery aborted", "AbortError");
			const diagnostic = diagnosticByServerId.get(serverId);
			// Untrusted servers are force-denied by the registry and never selected;
			// this check is belt-and-suspenders so a trusted override cannot leak.
			if (!diagnostic || !diagnostic.trusted) {
				throw new CapabilityError(
					"capability_denied",
					`MCP server "${serverId}" is not trusted for this capability binding`,
				);
			}
			const serverDescriptor = catalog.descriptors.find(
				(candidate) => candidate.kind === "mcp_server" && candidate.mcpServerId === serverId,
			);
			if (!serverDescriptor) {
				throw new CapabilityError(
					"capability_binding_unavailable",
					`MCP server "${serverId}" is missing from the capability catalog`,
				);
			}
			try {
				await this._ensureExecutionPolicyReady(policyRunId, signal, { deferMcpReconnect: true });
				await this._authorizeMcpStartup(diagnostic.server, serverId);
				await this._mcpLifecycleManager.connect(serverId, signal);
				const tools = await this._mcpLifecycleManager.listTools(serverId, signal);
				if (signal?.aborted) {
					throw new DOMException("MCP capability discovery aborted", "AbortError");
				}
				// The tool source identity embeds the server id so two same-scope
				// servers exposing the same local tool never share a descriptor id.
				const serverToolSourceIdentity = `${diagnostic.source.source}:${diagnostic.id}`;
				const results = mapMCPToolsToDefinitions(tools, {
					serverId,
					sourceIdentity: serverToolSourceIdentity,
					parentDescriptorId: serverDescriptor.id,
					registry: this._capabilityRegistry,
					callTool: (toolName, args, signal) =>
						this._mcpLifecycleManager.callTool(serverId, toolName, args, signal),
				});
				for (const result of results) {
					mcpResults.push(result);
					mcpCandidates.push({
						kind: "mcp_tool",
						name: result.mapping.toolName,
						localName: result.mapping.toolName,
						sourceIdentity: result.mapping.sourceIdentity,
						source: diagnostic.source,
						parentId: result.mapping.parentDescriptorId,
						mcpServerId: serverId,
						exposedToolName: result.mapping.exposedToolName,
						trusted: diagnostic.trusted,
						revisionInput: result.mapping.revisionInput,
					});
				}
			} catch (error) {
				if (signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) {
					throw error;
				}
				// The lifecycle records a redacted MCPError; the server and its tools
				// remain excluded from the binding. A selected server that cannot be
				// discovered must fail preflight instead of degrading to a partial
				// binding that silently omits the requested capability.
				const discoveryError =
					error instanceof MCPError || error instanceof CapabilityError || error instanceof PolicyError
						? error
						: new CapabilityError(
								"capability_mcp_connect_failed",
								`MCP capability discovery failed for server "${serverId}"`,
							);
				this._recordMcpDiscoveryError(serverId, discoveryError);
				throw discoveryError;
			}
		}

		if (signal?.aborted) {
			throw new DOMException("MCP capability discovery aborted", "AbortError");
		}
		this._activeMcpTools = mcpResults;
		this._activeMcpToolCandidates = mcpCandidates;
		if (mcpResults.length > 0) {
			if (this.isIdle) {
				if (signal?.aborted) {
					throw new DOMException("MCP capability discovery aborted", "AbortError");
				}
				this._refreshToolRegistry({ includeAllExtensionTools: true });
				// Discovered tools change the Capability Binding. Rebind the policy
				// before reconnecting so the live MCP transport belongs to the final
				// binding, not the discovery-only binding.
				await this._ensureExecutionPolicyReady(policyRunId, signal, { deferMcpReconnect: true });
			} else {
				// Discovery completed mid-run: the active run stays bound to the
				// frozen binding; re-resolve the registry only after the run settles.
				this._pendingToolRegistryRefresh = true;
			}
		}
	}

	private _recordMcpDiscoveryError(serverId: string, error: unknown): void {
		// Only the redacted capability code is retained; remote text never surfaces.
		const code =
			error instanceof Error && "code" in error && typeof error.code === "string"
				? error.code
				: "capability_mcp_connect_failed";
		this._mcpDiscoveryErrors.set(serverId, code);
	}

	/** The skill capability_index source, built only from binding-selected skills. */
	private _skillCapabilityIndexSource(): ContextSourceInput | undefined {
		const binding = this._activeCapabilityBinding;
		if (!binding) {
			return undefined;
		}
		const skills = this._resourceLoader.getSkills().skills;
		if (skills.length === 0) {
			return undefined;
		}
		const selectedSkillIds = new Set(
			binding.descriptors.filter((ref) => ref.id.startsWith("skill:")).map((ref) => ref.id),
		);
		const selectedSkills = skills.filter((skill) => {
			const source = skill.sourceInfo ?? createSyntheticSourceInfo(`<skill:${skill.name}>`, { source: "skill" });
			return selectedSkillIds.has(this._capabilityRegistry.createCapabilityId("skill", source.source, skill.name));
		});
		if (selectedSkills.length === 0) {
			return undefined;
		}
		return {
			sourceId: "capability_index:skills",
			kind: "capability_index",
			scope: "session",
			trust: "builtin",
			content: formatSkillsForPrompt(selectedSkills),
			required: false,
			capabilityBindingId: binding.id,
		};
	}

	/** Binding descriptor (id + revision) for a model-visible tool name, if selected. */
	private _bindingDescriptorForToolName(exposedName: string): { id: string; revision: string } | undefined {
		const binding = this._activeCapabilityBinding;
		if (!binding) {
			return undefined;
		}
		const ref = binding.descriptors.find((descriptor) => descriptor.exposedToolName === exposedName);
		return ref ? { id: ref.id, revision: ref.revision } : undefined;
	}

	private _policyCapabilityBindingInput(): {
		id?: string;
		descriptors?: ReadonlyArray<{ readonly id: string; readonly revision?: string }>;
		allowedCapabilityIds?: ReadonlyArray<string>;
	} {
		const binding = this._activeCapabilityBinding;
		if (binding === undefined) return {};
		const allowedCapabilityIds = binding.descriptors.map((descriptor) => descriptor.id);
		return {
			id: binding.id,
			// The frozen binding's descriptor revisions travel with the ids so MCP
			// operation gates (mcp.auth / mcp.content.*) can reject stale callers.
			descriptors: binding.descriptors.map((descriptor) => ({
				id: descriptor.id,
				...(descriptor.revision === undefined ? {} : { revision: descriptor.revision }),
			})),
			allowedCapabilityIds,
		};
	}

	private _createPolicySandboxPreflight(profile: ExecutionPolicyProfile):
		| {
				providerConfigured: boolean;
				providerId?: string;
				providerStatus: "ready" | "unavailable";
				providerCapabilities: SandboxProvider["capabilities"];
		  }
		| undefined {
		if (profile.enforcement !== "sandbox") return undefined;
		const providerId = profile.sandboxProvider;
		const provider = providerId === undefined ? undefined : this._sandboxProviders.get(providerId);
		const empty = { filesystem: false, process: false, network: false, credentialIsolation: false };
		return {
			providerConfigured: provider !== undefined,
			...(providerId === undefined ? {} : { providerId }),
			providerStatus: provider === undefined ? "unavailable" : "ready",
			providerCapabilities: provider?.capabilities ?? empty,
		};
	}

	private async _disposeSandboxSession(): Promise<void> {
		const session = this._activeSandboxSession;
		this._activeSandboxSession = undefined;
		this._activeSandboxHandle = undefined;
		if (session === undefined) return;
		let disposeError: unknown;
		try {
			await session.dispose();
		} catch (error) {
			disposeError = error;
		}
		this._policyLedger.appendSandboxLifecycle({
			bindingId: session.binding.id,
			status: "disposed",
			timestamp: new Date().toISOString(),
			providerId: session.provider.id,
			capabilities: session.provider.capabilities,
			...(disposeError === undefined
				? {}
				: { reasonCode: disposeError instanceof PolicyError ? disposeError.code : "sandbox_unavailable" }),
		});
	}

	private async _closeMcpConnectionsForPolicyBoundary(): Promise<void> {
		this._mcpAuthorizedTransportValues.clear();
		// Preserve the listed catalog identities (resourceId -> URI, promptId ->
		// name) of still-selected servers across the boundary close, so an
		// explicit content operation after the boundary can reconnect and keep
		// resolving already-listed items without re-listing. The first close of
		// a boundary owns the snapshot; a nested close (reconnect preflight)
		// runs after the maps were already cleared and must not overwrite it.
		for (const serverId of this._mcpLifecycleManager?.getSelectedServerIds() ?? []) {
			if (this._mcpCatalogIdentitySnapshots.has(serverId)) {
				continue;
			}
			this._mcpCatalogIdentitySnapshots.set(
				serverId,
				this._mcpLifecycleManager.snapshotCatalogIdentities(serverId),
			);
		}
		await this._mcpLifecycleManager?.closeAll().catch(() => undefined);
	}

	private async _disposePolicyBoundaryResources(): Promise<void> {
		// A session can be disposed while provider.prepare is still pending. Wait
		// for the serialized transition to settle before closing the live boundary.
		await this._executionPolicyPreparationTail;
		await this._closeMcpConnectionsForPolicyBoundary();
		await this._disposeSandboxSession();
		// Cancel pending MCP OAuth flows; credentials stay in the namespace store.
		this._mcpAuthAbortController.abort();
		await this._mcpAuthProvider.closeAll().catch(() => undefined);
	}

	private _enqueueExecutionPolicyTransition<T>(operation: () => Promise<T>): Promise<T> {
		const next = this._executionPolicyPreparationTail.catch(() => undefined).then(operation);
		this._executionPolicyPreparationTail = next.then(
			() => undefined,
			() => undefined,
		);
		return next;
	}

	private _recordPolicyDecision(decision: PolicyDecision): void {
		this._policyLedger.appendDecision(decision);
		if (decision.approval !== undefined) {
			const resolved =
				this._executionPolicyApprovedRequestIds.includes(decision.approval.id) ||
				this._executionPolicyRejectedRequestIds.includes(decision.approval.id);
			if (!resolved) {
				this._pendingExecutionPolicyApprovals.set(decision.approval.id, decision.approval);
				this._policyLedger.appendApproval(decision.approval);
			}
		}
		const approvedAsk =
			decision.outcome === "ask" &&
			decision.requestId !== undefined &&
			this._executionPolicyApprovedRequestIds.includes(decision.requestId);
		if (decision.outcome !== "allow" && !approvedAsk) {
			this._policyLedger.appendViolation({
				bindingId: decision.bindingId,
				timestamp: decision.timestamp,
				reasonCode: decision.reasonCode ?? "policy_denied",
				resource: decision.resource,
				...(decision.requestId === undefined ? {} : { requestId: decision.requestId }),
			});
		}
	}

	private async _prepareSandboxForBinding(
		profile: ExecutionPolicyProfile,
		binding: PolicyBinding,
		signal?: AbortSignal,
	): Promise<void> {
		await this._disposeSandboxSession();
		if (profile.enforcement !== "sandbox") {
			return;
		}
		const providerId = binding.sandboxProviderId;
		const provider = providerId === undefined ? undefined : this._sandboxProviders.get(providerId);
		if (provider === undefined) {
			throw new PolicyError(binding.sandboxStatus === "unavailable" ? "sandbox_unavailable" : "sandbox_required");
		}
		const session = new SandboxSession(provider, binding);
		this._activeSandboxSession = session;
		this._policyLedger.appendSandboxLifecycle({
			bindingId: binding.id,
			status: "preparing",
			timestamp: new Date().toISOString(),
			providerId,
			capabilities: provider.capabilities,
		});
		const preparationSignal = signal ?? this.agent.signal;
		try {
			const preparedHandle = await session.prepare(preparationSignal);
			if (this._activeSandboxSession !== session || session.currentStatus !== "ready") {
				await session.dispose();
				throw new PolicyError("sandbox_unavailable");
			}
			this._activeSandboxHandle = preparedHandle;
			this._policyLedger.appendSandboxLifecycle({
				bindingId: binding.id,
				status: "ready",
				timestamp: new Date().toISOString(),
				providerId,
				capabilities: provider.capabilities,
			});
		} catch (error) {
			if (preparationSignal?.aborted) {
				await this._disposeSandboxSession();
				throw error;
			}
			this._policyLedger.appendSandboxLifecycle({
				bindingId: binding.id,
				status: "failed",
				timestamp: new Date().toISOString(),
				providerId,
				capabilities: provider.capabilities,
				reasonCode: error instanceof PolicyError ? error.code : "sandbox_start_failed",
			});
			throw error;
		}
	}

	private _createSessionBuiltinToolPolicy(source: PolicyOperationSource): BuiltinToolPolicy {
		const session = this;
		return {
			get profile() {
				return session._requireExecutionPolicyProfile();
			},
			get binding() {
				return session._requireExecutionPolicyBinding();
			},
			roots: {
				workspace: this._cwd,
				agentInternal: [this._agentDir],
			},
			source,
			async authorizeFilesystem(input) {
				await session._ensureExecutionPolicyReady();
				return session._requireCurrentBuiltinToolPolicy(source).authorizeFilesystem(input);
			},
			async authorizeProcess(input) {
				await session._ensureExecutionPolicyReady();
				return session._requireCurrentBuiltinToolPolicy(source).authorizeProcess(input);
			},
			authorizeRaw(input) {
				return session._requireCurrentBuiltinToolPolicy(source).authorizeRaw(input);
			},
		};
	}

	private _requireExecutionPolicyProfile(): ExecutionPolicyProfile {
		if (this._activeExecutionPolicyProfile === undefined) {
			throw new PolicyError("policy_binding_failed");
		}
		return this._activeExecutionPolicyProfile;
	}

	private _requireExecutionPolicyBinding(): PolicyBinding {
		if (this._activeExecutionPolicyBinding === undefined) {
			throw new PolicyError("policy_binding_failed");
		}
		return this._activeExecutionPolicyBinding;
	}

	private _requireCurrentBuiltinToolPolicy(source: PolicyOperationSource): BuiltinToolPolicy {
		if (this._currentBuiltinToolPolicy === undefined || this._currentBuiltinToolPolicy.source !== source) {
			this._currentBuiltinToolPolicy = createBuiltinToolPolicy({
				profile: this._requireExecutionPolicyProfile(),
				binding: this._requireExecutionPolicyBinding(),
				roots: {
					workspace: this._cwd,
					agentInternal: [this._agentDir],
				},
				source,
				...(this._activeSandboxHandle === undefined ? {} : { sandbox: this._activeSandboxHandle }),
				approvedRequestIds: this._executionPolicyApprovedRequestIds,
				rejectedRequestIds: this._executionPolicyRejectedRequestIds,
				hooks: { onDecision: (decision) => this._recordPolicyDecision(decision) },
			});
		}
		return this._currentBuiltinToolPolicy;
	}

	private async _executeExtensionExec(command: string, args: string[], options?: ExecOptions): Promise<ExecResult> {
		await this._ensureExecutionPolicyReady();
		const cwd = options?.cwd ?? this.sessionManager.getCwd();
		const requestedEnv = options?.env ?? process.env;
		const authorized = await this._requireCurrentBuiltinToolPolicy("extension").authorizeProcess({
			command,
			args,
			cwd,
			env: requestedEnv,
			timeout: options?.timeout === undefined ? undefined : options.timeout / 1000,
		});

		if (authorized.sandbox === undefined) {
			const profile = this._requireExecutionPolicyProfile();
			const useHostDefaultEnv =
				options?.env === undefined && (profile.enforcement === "legacy" || profile.process.inheritEnvironment);
			return execCommand(command, args, cwd, {
				...options,
				cwd,
				...(useHostDefaultEnv ? {} : { env: authorized.env }),
			});
		}

		let killed = false;
		const stdoutChunks: string[] = [];
		const controller = new AbortController();
		let timeoutId: NodeJS.Timeout | undefined;
		const abort = () => {
			killed = true;
			controller.abort();
		};
		if (options?.signal) {
			if (options.signal.aborted) {
				abort();
			} else {
				options.signal.addEventListener("abort", abort, { once: true });
			}
		}
		if (options?.timeout !== undefined && options.timeout > 0) {
			timeoutId = setTimeout(abort, options.timeout);
		}
		try {
			const result = await authorized.sandbox.execute({
				bindingId: this._requireExecutionPolicyBinding().id,
				resource: "process.spawn",
				command,
				args,
				cwd,
				env: authorized.env,
				timeoutMs: options?.timeout,
				signal: controller.signal,
				onData: (data) => stdoutChunks.push(data.toString()),
			});
			if (result.content !== undefined) {
				stdoutChunks.push(Buffer.isBuffer(result.content) ? result.content.toString() : result.content);
			}
			const stdout =
				result.stdout === undefined
					? stdoutChunks.join("")
					: Buffer.isBuffer(result.stdout)
						? result.stdout.toString()
						: result.stdout;
			const stderr =
				result.stderr === undefined
					? ""
					: Buffer.isBuffer(result.stderr)
						? result.stderr.toString()
						: result.stderr;
			return {
				stdout,
				stderr,
				code: result.exitCode ?? 0,
				killed: killed || result.killed === true || result.exitCode === null,
			};
		} catch (error) {
			if (isUnknownSandboxSideEffectError(error)) throw error;
			if (!killed) throw error;
			return {
				stdout: stdoutChunks.join(""),
				stderr: "",
				code: 1,
				killed: true,
			};
		} finally {
			if (timeoutId) clearTimeout(timeoutId);
			if (options?.signal) {
				options.signal.removeEventListener("abort", abort);
			}
		}
	}

	private _ensureExecutionPolicyReady(
		runId?: string,
		signal?: AbortSignal,
		options?: { deferMcpReconnect?: boolean },
	): Promise<boolean> {
		if (signal?.aborted) return Promise.reject(new DOMException("Execution policy preparation aborted", "AbortError"));
		return this._enqueueExecutionPolicyTransition(() => this._ensureExecutionPolicyReadyInternal(runId, signal, options));
	}

	private async _ensureExecutionPolicyReadyInternal(
		runId?: string,
		signal?: AbortSignal,
		options?: { deferMcpReconnect?: boolean },
	): Promise<boolean> {
		if (signal?.aborted) throw new DOMException("Execution policy preparation aborted", "AbortError");
		const requestedRunId = runId ?? this._activeContextRunId;
		if (
			this._activeExecutionPolicyBinding !== undefined &&
			this._activeExecutionPolicyBinding.capabilityBindingId === this._activeCapabilityBinding?.id &&
			(requestedRunId === undefined || this._activeExecutionPolicyBinding.runId === requestedRunId)
		) {
			return false;
		}
		if (this._activeCapabilityBinding === undefined) {
			this._resolveCapabilityBinding();
		}
		const policySettings = this.settingsManager.getExecutionPolicySettings({
			policyProfile: this._activeExecutionPolicyProfileSelection,
			registeredProviderIds: ["legacy-host", "host-policy", ...this._sandboxProviders.keys()],
		});
		const selectedProfile = policySettings.selectedProfile;
		const previousPolicyBindingId =
			this._nextPreviousExecutionPolicyBindingId ?? this._executionPolicyPreviousBindingIdForRun;
		const result = resolveExecutionPolicyProfile({
			profiles: policySettings.profiles,
			defaultProfile: policySettings.selectedProfileId,
			policyProfile: policySettings.selectedProfileId,
			projectTrusted: this.settingsManager.isProjectTrusted(),
			capabilityBinding: this._policyCapabilityBindingInput(),
			sandbox: this._createPolicySandboxPreflight(selectedProfile),
			workspaceIdentity:
				selectedProfile.enforcement === "sandbox" ? getActiveWorkspaceIdentity(this._cwd) : "workspace:active",
			runId: runId ?? this._activeContextRunId ?? "run:session",
			createdAt: new Date().toISOString(),
			...(previousPolicyBindingId === undefined ? {} : { previousPolicyBindingId }),
		});
		if (!result.ok) throw result.error;
		const previousBindingId = this._activeExecutionPolicyBinding?.id;
		const bindingChanged = previousBindingId !== result.binding.id;
		if (bindingChanged) {
			// MCP transports never survive a policy binding change. Callers that
			// need the listed catalog identities (resourceId -> URI, promptId ->
			// name) after the change pass deferMcpReconnect: the identities are
			// snapshotted before the close and restored after the immediate
			// reconnect, so no MCP operation ever runs on a stale transport or
			// with stale identities.
			const identities = options?.deferMcpReconnect
				? new Map(
						[...this._mcpLifecycleManager.getSelectedServerIds()].map((serverId) => [
							serverId,
							this._mcpLifecycleManager.snapshotCatalogIdentities(serverId),
						] as const),
					)
				: undefined;
			await this._closeMcpConnectionsForPolicyBoundary();
			await this._disposeSandboxSession();
			if (signal?.aborted) throw new DOMException("Execution policy preparation aborted", "AbortError");
			this._activeExecutionPolicyProfile = result.profile;
			this._activeExecutionPolicyBinding = result.binding;
			this._currentBuiltinToolPolicy = undefined;
			this._pendingExecutionPolicyApprovals.clear();
			this._executionPolicyApprovedRequestIds = [];
			this._executionPolicyRejectedRequestIds = [];
			if (!this._persistedPolicyBindingIds.has(result.binding.id)) {
				if (signal?.aborted) throw new DOMException("Execution policy preparation aborted", "AbortError");
				this._policyLedger.appendBinding(result.binding);
				this._persistedPolicyBindingIds.add(result.binding.id);
			}
			await this._prepareSandboxForBinding(result.profile, result.binding, signal);
			if (options?.deferMcpReconnect) {
				await this._reconnectSelectedMcpServersForPolicyBinding(signal);
				if (identities !== undefined) {
					for (const [serverId, snapshot] of identities) {
						if (snapshot !== undefined) {
							this._mcpLifecycleManager.restoreCatalogIdentities(serverId, snapshot);
						}
					}
				}
			}
		}
		this._nextPreviousExecutionPolicyBindingId = undefined;
		return bindingChanged;
	}

	private _authorizeCapabilityInvocation(toolName: string, source: PolicyOperationSource, requestId: string): void {
		const profile = this._requireExecutionPolicyProfile();
		const binding = this._requireExecutionPolicyBinding();
		const capability = this._bindingDescriptorForToolName(toolName);
		const decision = authorizePolicyOperation({
			profile,
			binding,
			operation: {
				resource: "capability.invoke",
				source,
				id: requestId,
				...(capability === undefined ? {} : { capabilityId: capability.id }),
			},
			capabilityBinding: this._policyCapabilityBindingInput(),
		});
		this._recordPolicyDecision(decision);
		this._assertPolicyDecisionAllowed(decision);
	}

	private _assertPolicyDecisionAllowed(decision: PolicyDecision): void {
		if (decision.outcome === "allow") return;
		if (decision.outcome === "ask" && decision.requestId !== undefined) {
			if (this._executionPolicyRejectedRequestIds.includes(decision.requestId)) {
				throw new PolicyError("policy_denied", "The operation was rejected by execution policy approval.");
			}
			if (this._executionPolicyApprovedRequestIds.includes(decision.requestId)) return;
		}
		throw new PolicyError(decision.reasonCode ?? "policy_denied", decision.reason);
	}

	private _toolInvocationSourceFor(toolName: string): PolicyOperationSource {
		const source = this._toolDefinitions.get(toolName)?.sourceInfo.source ?? "";
		if (source === "sdk" || source.startsWith("<sdk:")) return "sdk";
		if (source.startsWith("mcp")) return "mcp";
		if (source === "builtin" || source.startsWith("<builtin:")) return "builtin";
		return "extension";
	}

	private async _authorizeMcpStartup(
		server: CapabilitySettings["mcpServers"][number]["server"],
		serverId: string,
	): Promise<void> {
		this._mcpAuthorizedTransportValues.delete(serverId);
		if (server.transport === "stdio") {
			const requestedEnv: Record<string, string> = {};
			for (const name of server.env ?? []) {
				const value = process.env[name];
				if (value !== undefined) {
					requestedEnv[name] = value;
				}
			}
			const authorized = await this._requireCurrentBuiltinToolPolicy("mcp").authorizeProcess({
				command: server.command,
				cwd: this._cwd,
				env: requestedEnv,
				requestId: `mcp-start:${serverId}`,
			});
			this._assertMcpSandboxTransportAvailable();
			const environment = Object.fromEntries(
				Object.entries(authorized.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
			);
			this._mcpAuthorizedTransportValues.set(serverId, { environment, headers: {} });
			return;
		}
		const url = new URL(server.url);
		const decision = authorizePolicyOperation({
			profile: this._requireExecutionPolicyProfile(),
			binding: this._requireExecutionPolicyBinding(),
			operation: {
				resource: "network.connect",
				source: "mcp",
				id: `mcp-connect:${serverId}`,
				destination: url.origin,
				...(url.port === "" ? {} : { port: Number(url.port) }),
			},
			capabilityBinding: this._policyCapabilityBindingInput(),
		});
		this._recordPolicyDecision(decision);
		this._assertPolicyDecisionAllowed(decision);
		const headerRefs = server.headersFromEnv ?? [];
		const credentialNames = [...new Set(headerRefs.map((header) => header.valueFromEnv))];
		const profile = this._requireExecutionPolicyProfile();
		if (profile.enforcement !== "legacy" && credentialNames.length > 0) {
			const credentialDecision = authorizePolicyOperation({
				profile,
				binding: this._requireExecutionPolicyBinding(),
				operation: {
					resource: "credential.expose",
					source: "mcp",
					id: `mcp-headers:${serverId}`,
					credentialNames,
				},
				capabilityBinding: this._policyCapabilityBindingInput(),
			});
			this._recordPolicyDecision(credentialDecision);
			this._assertPolicyDecisionAllowed(credentialDecision);
		}
		const headers: Record<string, string> = {};
		for (const header of headerRefs) {
			const value = process.env[header.valueFromEnv];
			if (value !== undefined) {
				headers[header.name] = value;
			}
		}
		this._assertMcpSandboxTransportAvailable();
		this._mcpAuthorizedTransportValues.set(serverId, { environment: {}, headers });
	}

	private async _reconnectSelectedMcpServersForPolicyBinding(signal?: AbortSignal): Promise<void> {
		const selectedServerIds = this._mcpLifecycleManager.getSelectedServerIds();
		if (selectedServerIds.size === 0) return;
		const diagnostics = new Map(
			this.settingsManager.getCapabilitySettings().mcpServers.map((diagnostic) => [diagnostic.id, diagnostic]),
		);
		for (const serverId of selectedServerIds) {
			const diagnostic = diagnostics.get(serverId);
			if (diagnostic === undefined || !diagnostic.trusted) {
				throw new CapabilityError(
					"capability_denied",
					`MCP server ${serverId} is not trusted for this capability binding`,
				);
			}
			if (signal?.aborted) throw new DOMException("MCP policy binding reconnect aborted", "AbortError");
			await this._authorizeMcpStartup(diagnostic.server, serverId);
			// reconnect (not connect) preserves the listed catalog identities
			// (resourceId -> URI, promptId -> name) across the policy-boundary
			// teardown so explicit content operations keep resolving.
			await this._mcpLifecycleManager.reconnect(serverId, signal);
		}
	}

	private _assertMcpSandboxTransportAvailable(): void {
		if (this._requireExecutionPolicyProfile().enforcement !== "sandbox") return;
		const sandbox = this._activeSandboxHandle;
		if (sandbox === undefined) {
			throw new PolicyError("sandbox_required");
		}
		if (sandbox.createMcpTransport === undefined) {
			throw new PolicyError("sandbox_capability_insufficient", "MCP sandbox transport is unavailable.");
		}
	}

	// ---- MCP auth + content private helpers -----------------------------------

	private _requireMcpDiagnostic(serverId: string): McpServerDiagnostic {
		const diagnostic = this.settingsManager
			.getCapabilitySettings()
			.mcpServers.find((candidate) => candidate.id === serverId);
		if (diagnostic === undefined) {
			throw new MCPError("invalid_config", serverId, `No configuration registered for MCP server "${serverId}"`);
		}
		return diagnostic;
	}

	private _assertMcpAuthSupported(diagnostic: McpServerDiagnostic, serverId: string): void {
		if (diagnostic.server.transport !== "streamable-http" || diagnostic.server.oauth === undefined) {
			throw new MCPAuthError("mcp_auth_unsupported", serverId);
		}
	}

	/** Namespace scope for one server: per source scope + server id. */
	private _mcpCredentialScope(serverId: string): MCPCredentialScope {
		const diagnostic = this._requireMcpDiagnostic(serverId);
		return {
			sourceId: diagnostic.scope,
			serverId,
			serverIdentity: diagnostic.source.source,
		};
	}

	/** OAuth binding for one streamable-http server: per session + server flow. */
	private _mcpAuthBinding(serverId: string): { context: MCPAuthContext; options: MCPAuthOptions } {
		const diagnostic = this._requireMcpDiagnostic(serverId);
		this._assertMcpAuthSupported(diagnostic, serverId);
		const server = diagnostic.server;
		if (server.transport !== "streamable-http" || server.oauth === undefined) {
			throw new MCPAuthError("mcp_auth_unsupported", serverId);
		}
		const oauth = server.oauth;
		const context: MCPAuthContext = {
			serverId,
			serverIdentity: diagnostic.source.source,
			sessionId: this.sessionId,
			signal: this._mcpAuthAbortController.signal,
		};
		const options: MCPAuthOptions = {
			serverUrl: server.url,
			redirectUrl: oauth.redirectUrl,
			...(oauth.canonicalResource === undefined ? {} : { canonicalResource: oauth.canonicalResource }),
			...(oauth.clientId === undefined ? {} : { clientId: oauth.clientId }),
			...(oauth.scope === undefined ? {} : { scope: oauth.scope }),
			...(oauth.clientName === undefined ? {} : { clientName: oauth.clientName }),
			fetchFn: this._createMcpAuthFetch(),
		};
		return { context, options };
	}

	/**
	 * MCPAuthStore adapter over the MCP credential namespace. Records are scoped
	 * per source + server and bound to issuer + canonical resource + scopes, so
	 * one server's credentials can never satisfy another server's binding.
	 */
	private _createMcpAuthStoreAdapter(): MCPAuthStore {
		const namespace = this._mcpCredentialNamespace;
		const scopeFor = (serverId: string): MCPCredentialScope => this._mcpCredentialScope(serverId);
		const bindingFor = (binding: {
			issuer: string;
			canonicalResource: string;
			clientId?: string;
			scope?: string;
		}): MCPCredentialBinding => ({
			issuer: binding.issuer,
			resource: binding.canonicalResource,
			scopes:
				binding.scope === undefined
					? []
					: binding.scope.split(/\s+/u).filter((scope) => scope.length > 0),
			...(binding.clientId === undefined ? {} : { clientId: binding.clientId }),
		});
		return {
			read: async (binding) => {
				const record = await namespace.read(scopeFor(binding.serverId), bindingFor(binding));
				if (record === undefined) return undefined;
				return {
					serverIdentity: record.serverIdentity,
					serverId: binding.serverId,
					canonicalResource: record.resource,
					issuer: record.issuer,
					...(record.clientId === undefined ? {} : { clientId: record.clientId }),
					...(record.scopes.length > 0 ? { scope: record.scopes.join(" ") } : {}),
					tokenType: "Bearer",
					accessToken: record.access,
					...(record.refresh === "" ? {} : { refreshToken: record.refresh }),
					...(record.expires > 0 ? { expiresAt: record.expires } : {}),
					updatedAt: 0,
				};
			},
			save: async (record) => {
				await namespace.save(
					scopeFor(record.serverId),
					{
						issuer: record.issuer,
						resource: record.canonicalResource,
						scopes:
							record.scope === undefined
								? []
								: record.scope.split(" ").filter((scope) => scope !== ""),
						...(record.clientId === undefined ? {} : { clientId: record.clientId }),
					},
					{
						access: record.accessToken,
						...(record.refreshToken === undefined ? {} : { refresh: record.refreshToken }),
						...(record.expiresAt === undefined ? {} : { expires: record.expiresAt }),
					},
				);
			},
			delete: async (binding) => {
				await namespace
					.logout(scopeFor(binding.serverId), bindingFor(binding))
					.catch(() => undefined);
			},
		};
	}

	/**
	 * OAuth hooks attached to the lifecycle manager: the SDK provider for the
	 * Streamable HTTP transport plus a single-flight refresh for the exactly-one
	 * 401 refresh/retry contract. stdio servers never get hooks.
	 */
	private _mcpAuthHooksFor(serverId: string): MCPServerAuthHooks | undefined {
		const diagnostic = this._requireMcpDiagnostic(serverId);
		if (diagnostic.server.transport !== "streamable-http" || diagnostic.server.oauth === undefined) {
			return undefined;
		}
		const { context, options } = this._mcpAuthBinding(serverId);
		const session = this._mcpAuthProvider.session(context, options);
		return {
			authProvider: session.createOAuthClientProvider(),
			refresh: () => this._mcpAuthProvider.refresh(context, options).then((result) => result.outcome),
		};
	}

	/**
	 * Policy-aware fetch for OAuth HTTP requests: every request origin is gated
	 * by `network.connect` and recorded in the policy ledger, so OAuth
	 * discovery/token/revocation traffic cannot bypass the execution policy.
	 */
	private _createMcpAuthFetch(): FetchLike {
		return (url, init) => {
			let origin: string;
			let port: number | undefined;
			try {
				const parsed = new URL(url);
				origin = parsed.origin;
				port = parsed.port === "" ? undefined : Number(parsed.port);
			} catch {
				throw new PolicyError("policy_denied", "MCP OAuth request URL is invalid");
			}
			const profile = this._requireExecutionPolicyProfile();
			const binding = this._requireExecutionPolicyBinding();
			const originId = createHash("sha256").update(origin).digest("hex").slice(0, 16);
			const decision = authorizePolicyOperation({
				profile,
				binding,
				operation: {
					resource: "network.connect",
					source: "mcp",
					id: `mcp-oauth-${originId}`,
					destination: origin,
					...(port === undefined ? {} : { port }),
				},
				capabilityBinding: this._policyCapabilityBindingInput(),
			});
			this._recordPolicyDecision(decision);
			this._assertPolicyDecisionAllowed(decision);
			return (this._mcpAuthBaseFetch ?? fetch)(url, init);
		};
	}

	/**
	 * The mcp_server capability (id + revision) from the active catalog. The
	 * binding is resolved on demand so a freshly built runtime can gate before
	 * any connection attempt; a server absent from the catalog fails closed.
	 */
	private _requireMcpServerCapability(serverId: string): { id: string; revision: string } {
		let catalog: CapabilityCatalog | undefined = this._activeCapabilityCatalog;
		if (catalog === undefined) {
			this._resolveCapabilityBinding();
			catalog = this._activeCapabilityCatalog;
		}
		if (catalog === undefined) {
			throw new CapabilityError(
				"capability_denied",
				`MCP server "${serverId}" is not available in the capability catalog`,
			);
		}
		const descriptor = catalog.descriptors.find(
			(candidate) => candidate.kind === "mcp_server" && candidate.mcpServerId === serverId,
		);
		if (descriptor === undefined) {
			throw new CapabilityError(
				"capability_denied",
				`MCP server "${serverId}" is not available in the capability catalog`,
			);
		}
		return { id: descriptor.id, revision: descriptor.revision };
	}

	/**
	 * Policy gate for MCP operations. `capability` is the mcp_server descriptor
	 * for `mcp.auth`/`mcp.content.list`, or the content item descriptor (with
	 * `parentId`) for `mcp.content.read`/`mcp.content.attach`. The frozen
	 * binding must contain the exact descriptor revision and, for content items,
	 * the parent mcp_server; anything else is denied.
	 */
	private async _authorizeMcpOperation(
		resource: "mcp.auth" | "mcp.content.list" | "mcp.content.read" | "mcp.content.attach",
		serverId: string,
		capability: { id: string; revision: string; parentId?: string; sourceId?: string },
	): Promise<void> {
		// mcp.auth gates never reconnect: the server may not be authorized yet, so
		// a policy-boundary reconnect would 401 before the OAuth flow exists.
		// Content operations defer the reconnect so transports are (re)created
		// under the new binding before any list/read/attach transport use.
		await this._ensureExecutionPolicyReady(undefined, undefined, {
			deferMcpReconnect: resource !== "mcp.auth",
		});
		const profile = this._requireExecutionPolicyProfile();
		const binding = this._requireExecutionPolicyBinding();
		const operation: PolicyOperationRequest = {
			resource,
			source: "mcp",
			id: `mcp-${resource}:${serverId}`,
			serverId,
			capabilityId: capability.id,
			revision: capability.revision,
			...(capability.parentId === undefined ? {} : { parentId: capability.parentId }),
			...(capability.sourceId === undefined ? {} : { sourceId: capability.sourceId }),
		};
		const decision = authorizePolicyOperation({
			profile,
			binding,
			operation,
			capabilityBinding: this._policyCapabilityBindingInput(),
		});
		this._recordPolicyDecision(decision);
		this._assertPolicyDecisionAllowed(decision);
	}

	/** Content operations wait for an active agent run to settle first. */
	private _ensureMcpContentIdle(): Promise<void> {
		return this._isAgentRunActive ? this.waitForIdle() : Promise.resolve();
	}

	/**
	 * Ensures MCP capability discovery settled and the server is connected. The
	 * server must be binding-selected; an unselected or failed server is
	 * unavailable.
	 *
	 * A selected server whose transport was closed by an execution-policy
	 * boundary (profile/binding change closes every MCP transport) or degraded
	 * is reconnected here through the policy-authorized path — full preflight,
	 * startup authorization, and the manager's selection-gated connect — so an
	 * explicit content operation never runs on a stale transport and never
	 * silently reopens a deselected or denied server.
	 */
	private async _ensureMcpServerConnected(serverId: string, signal?: AbortSignal): Promise<void> {
		await this.whenCapabilitiesReady(undefined, signal);
		const manager = this._mcpLifecycleManager;
		const status = manager?.getStatus(serverId);
		if (status === undefined) {
			throw new MCPError("unavailable", serverId, `MCP server "${serverId}" is unavailable`);
		}
		if (status.state !== "ready") {
			// The transport was closed or degraded (e.g. an execution-policy
			// boundary). Reconnect through the same policy-authorized path used
			// at discovery, then explicitly through the selection-gated manager
			// connect so a degraded server that prep did not touch is still
			// reconnected with a fresh transport. Nothing here reopens a
			// deselected or denied server.
			await this._ensureExecutionPolicyReady(undefined, signal, { deferMcpReconnect: true });
			await manager.connect(serverId, signal);
			const after = manager?.getStatus(serverId);
			if (after === undefined || after.state !== "ready") {
				throw new MCPError("unavailable", serverId, `MCP server "${serverId}" is unavailable`);
			}
		}
		// Restore the listed catalog identities captured when the boundary
		// closed the transports (the reconnect itself starts with an empty
		// catalog generation), so already-listed resources/prompts keep
		// resolving without re-listing.
		const snapshot = this._mcpCatalogIdentitySnapshots.get(serverId);
		if (snapshot !== undefined) {
			manager?.restoreCatalogIdentities(serverId, snapshot);
			this._mcpCatalogIdentitySnapshots.delete(serverId);
		}
	}

	/** Stable secret-free digest identity for one listed content item. */
	/**
	 * Validates an explicit prompt argument set against the prompt declared in
	 * the catalog: missing required arguments, unknown keys, oversized values,
	 * and an oversized total fail closed with a fixed message that never echoes
	 * argument names or values.
	 */
	private _validateMcpPromptArguments(
		serverId: string,
		promptId: string,
		args?: Readonly<Record<string, string>>,
	): void {
		const prompt = this._mcpContentCatalogs.get(serverId)?.prompts.find((entry) => entry.promptId === promptId);
		const problem = validateMcpPromptArguments(prompt?.arguments, args, DEFAULT_MCP_CONTENT_LIMITS);
		if (problem === undefined) {
			return;
		}
		const kind =
			problem.kind === "argument_too_long" || problem.kind === "arguments_too_large"
				? "content_limit_exceeded"
				: "content_invalid";
		throw new MCPError(kind, serverId, mcpContentFailureMessage(kind, serverId));
	}

	/**
	 * Best-effort session audit entry for one explicit MCP operation. Allowlist
	 * only: serverId, capability/policy refs, operation, outcome, a fixed
	 * reasonCode (never error text), content digest/bytes/blocks, timestamp.
	 * Persistence failures never change the operation outcome.
	 */
	private _recordMcpAuditEntry(entry: {
		serverId: string;
		operation: "auth" | "resource.list" | "prompt.list" | "resource.read" | "prompt.get" | "context.attach";
		outcome: "success" | "failed" | "cancelled";
		reasonCode?: string;
		capabilityId?: string;
		revision?: string;
		provenanceId?: string;
		capabilityBindingId?: string;
		policyBindingId?: string;
		contentDigest?: string;
		byteCount?: number;
		blockCount?: number;
	}): void {
		try {
			this.sessionManager.appendCustomEntry("mcp.content.audit", {
				serverId: entry.serverId,
				operation: entry.operation,
				outcome: entry.outcome,
				...(entry.reasonCode === undefined ? {} : { reasonCode: entry.reasonCode }),
				...(entry.capabilityId === undefined ? {} : { capabilityId: entry.capabilityId }),
				...(entry.revision === undefined ? {} : { revision: entry.revision }),
				...(entry.provenanceId === undefined ? {} : { provenanceId: entry.provenanceId }),
				...(entry.capabilityBindingId === undefined
					? {}
					: { capabilityBindingId: entry.capabilityBindingId }),
				...(entry.policyBindingId === undefined ? {} : { policyBindingId: entry.policyBindingId }),
				...(entry.contentDigest === undefined ? {} : { contentDigest: entry.contentDigest }),
				...(entry.byteCount === undefined ? {} : { byteCount: entry.byteCount }),
				...(entry.blockCount === undefined ? {} : { blockCount: entry.blockCount }),
				timestamp: new Date().toISOString(),
			});
		} catch {
			// Audit persistence is best-effort and never affects the operation.
		}
	}

	/** Fixed reason code for an MCP operation failure; never derived from error text. */
	private _mcpAuditReasonCode(error: unknown): string | undefined {
		if (error instanceof MCPError) {
			return error.kind;
		}
		if (error instanceof MCPAuthError) {
			return error.kind;
		}
		if (error instanceof CapabilityError || error instanceof PolicyError) {
			return error.code;
		}
		return undefined;
	}

	private _isMcpAbortError(error: unknown): boolean {
		return error instanceof Error && error.name === "AbortError";
	}

	/**
	 * Runs one explicit MCP operation under the audit contract: the capability
	 * gate (lookup + policy authorization) and the operation body both produce
	 * allowlist audit entries — denials included — and audit persistence never
	 * changes the operation outcome. `classify` maps a successful result to its
	 * audit outcome (default: success).
	 */
	private async _runMcpAudited<T>(
		serverId: string,
		operation: "auth" | "resource.list" | "prompt.list" | "resource.read" | "prompt.get" | "context.attach",
		gate: () => Promise<{ id: string; revision: string; sourceId?: string }>,
		run: (capability: { id: string; revision: string; sourceId?: string }) => Promise<{
			result: T;
			contentDigest?: string;
			byteCount?: number;
			blockCount?: number;
		}>,
		classify?: (result: T) => { outcome: "success" | "failed" | "cancelled"; reasonCode?: string },
	): Promise<T> {
		let capability: { id: string; revision: string; sourceId?: string };
		try {
			capability = await gate();
		} catch (error) {
			const reasonCode = this._mcpAuditReasonCode(error);
			this._recordMcpAuditEntry({
				serverId,
				operation,
				outcome: this._isMcpAbortError(error) ? "cancelled" : "failed",
				...(reasonCode === undefined ? {} : { reasonCode }),
				capabilityBindingId: this._activeCapabilityBinding?.id,
			});
			throw error;
		}
		let policyBindingId: string | undefined;
		try {
			policyBindingId = this._requireExecutionPolicyBinding().id;
		} catch {
			// Best-effort metadata; the operation gate already ran.
		}
		const base = {
			capabilityId: capability.id,
			revision: capability.revision,
			...(capability.sourceId === undefined ? {} : { provenanceId: capability.sourceId }),
			capabilityBindingId: this._activeCapabilityBinding?.id,
			...(policyBindingId === undefined ? {} : { policyBindingId }),
		};
		try {
			const outcome = await run(capability);
			const classification = classify?.(outcome.result) ?? { outcome: "success" as const };
			this._recordMcpAuditEntry({
				serverId,
				operation,
				outcome: classification.outcome,
				...(classification.reasonCode === undefined ? {} : { reasonCode: classification.reasonCode }),
				...base,
				...(outcome.contentDigest === undefined ? {} : { contentDigest: outcome.contentDigest }),
				...(outcome.byteCount === undefined ? {} : { byteCount: outcome.byteCount }),
				...(outcome.blockCount === undefined ? {} : { blockCount: outcome.blockCount }),
			});
			return outcome.result;
		} catch (error) {
			const reasonCode = this._mcpAuditReasonCode(error);
			this._recordMcpAuditEntry({
				serverId,
				operation,
				outcome: this._isMcpAbortError(error) ? "cancelled" : "failed",
				...(reasonCode === undefined ? {} : { reasonCode }),
				...base,
			});
			throw error;
		}
	}

	/**
	 * Resolves the raw URI of a listed resource by its opaque id. Fail-closed:
	 * an id that was never listed (or whose listing predates the current
	 * connection) is rejected with a fixed content error; the raw URI never
	 * leaves this resolution.
	 */
	private _requireMcpResourceUri(serverId: string, resourceId: string): string {
		const uri = this._mcpLifecycleManager?.getResourceUri(serverId, resourceId);
		if (uri === undefined) {
			throw new MCPError("content_invalid", serverId, mcpContentFailureMessage("content_invalid", serverId));
		}
		return uri;
	}

	/** Resolves the server-facing prompt name of a listed prompt by its opaque id. */
	private _requireMcpPromptName(serverId: string, promptId: string): string {
		const name = this._mcpLifecycleManager?.getPromptName(serverId, promptId);
		if (name === undefined) {
			throw new MCPError("content_invalid", serverId, mcpContentFailureMessage("content_invalid", serverId));
		}
		return name;
	}

	/**
	 * Rejects staging another attachment when the combined pending attachments
	 * would exceed the run-level budget. Fail-closed: no silent truncation at
	 * attach time — the caller must attach less or attach after a read preview.
	 */
	private _assertMcpAttachmentBudget(serverId: string, contentBytes: number): void {
		const pendingBytes = this._pendingMcpAttachments.reduce(
			(sum, source) => sum + utf8ByteLength(source.content ?? ""),
			0,
		);
		if (pendingBytes + contentBytes > DEFAULT_MCP_CONTENT_LIMITS.maxRunAttachmentBytes) {
			throw new MCPError(
				"content_limit_exceeded",
				serverId,
				mcpContentFailureMessage("content_limit_exceeded", serverId),
			);
		}
	}

	private _updateMcpContentCatalog(
		serverId: string,
		update: (catalog: McpContentCatalog) => McpContentCatalog,
	): void {
		const current = this._mcpContentCatalogs.get(serverId) ?? {
			resources: [],
			resourceTemplates: [],
			prompts: [],
		};
		this._mcpContentCatalogs.set(serverId, update(current));
	}

	/**
	 * Registers secret-free content capability descriptors parented to the
	 * mcp_server and re-resolves the frozen binding so allowed content enters it
	 * with stable revisions. Content descriptors carry no exposed tool name, so
	 * the model-visible tool set is unaffected.
	 */
	private _registerMcpContentDescriptors(serverId: string): void {
		const diagnostic = this._requireMcpDiagnostic(serverId);
		const catalog = this._mcpContentCatalogs.get(serverId);
		const server = this._requireMcpServerCapability(serverId);
		if (catalog === undefined) return;
		const sourceIdentity = `${diagnostic.source.source}:${diagnostic.id}`;
		const candidates: CapabilityCandidate[] = [];
		for (const resource of catalog.resources) {
			// The raw URI stays in the lifecycle; only the server-scoped opaque
			// identity and the provenance digest enter descriptor derivation.
			const uri = this._mcpLifecycleManager?.getResourceUri(serverId, resource.resourceId);
			if (uri === undefined) {
				continue;
			}
			candidates.push({
				kind: "mcp_resource",
				name: resource.name,
				localName: resource.provenanceId,
				sourceIdentity,
				source: diagnostic.source,
				parentId: server.id,
				mcpServerId: serverId,
				trusted: diagnostic.trusted,
				revisionInput: {
					uri,
					name: resource.name,
					...(resource.mimeType === undefined ? {} : { mimeType: resource.mimeType }),
					...(resource.description === undefined ? {} : { description: resource.description }),
					...(resource.size === undefined ? {} : { size: resource.size }),
				},
			});
		}
		for (const template of catalog.resourceTemplates) {
			const uriTemplate = this._mcpLifecycleManager?.getResourceUriTemplate(serverId, template.templateId);
			if (uriTemplate === undefined) {
				continue;
			}
			candidates.push({
				kind: "mcp_resource_template",
				name: template.name,
				localName: template.provenanceId,
				sourceIdentity,
				source: diagnostic.source,
				parentId: server.id,
				mcpServerId: serverId,
				trusted: diagnostic.trusted,
				revisionInput: {
					uriTemplate,
					name: template.name,
					...(template.mimeType === undefined ? {} : { mimeType: template.mimeType }),
					...(template.description === undefined ? {} : { description: template.description }),
				},
			});
		}
		for (const prompt of catalog.prompts) {
			candidates.push({
				kind: "mcp_prompt",
				name: prompt.name,
				localName: prompt.provenanceId,
				sourceIdentity,
				source: diagnostic.source,
				parentId: server.id,
				mcpServerId: serverId,
				trusted: diagnostic.trusted,
				revisionInput: {
					name: prompt.name,
					...(prompt.description === undefined ? {} : { description: prompt.description }),
					arguments: prompt.arguments,
				},
			});
		}
		this._activeMcpContentCandidates = candidates;
		this._resolveCapabilityBinding();
	}

	/**
	 * Listing changes the capability binding by adding metadata descriptors. A
	 * policy binding is immutable, so materialize the new capability binding and
	 * reconnect the selected servers before the next explicit content operation.
	 */
	private async _refreshMcpContentBinding(serverId: string, signal?: AbortSignal): Promise<void> {
		this._registerMcpContentDescriptors(serverId);
		// deferMcpReconnect keeps the policy-boundary close (transports never
		// survive a binding change) while restoring the listed catalog
		// identities (resourceId -> URI, promptId -> name) after the immediate
		// reconnect, so already-listed content keeps resolving.
		await this._ensureExecutionPolicyReady(undefined, signal, { deferMcpReconnect: true });
	}

	/** Content item capability for a listed resource URI; never-listed items are denied. */
	private _requireContentCapability(
		serverId: string,
		resourceId: string,
	): { id: string; revision: string; parentId: string; sourceId: string } {
		const resource = this._mcpContentCatalogs.get(serverId)?.resources.find((entry) => entry.resourceId === resourceId);
		if (resource === undefined) {
			throw new CapabilityError(
				"capability_denied",
				`MCP resource is not available in the selected capability binding for server "${serverId}"`,
			);
		}
		return this._requireContentCapabilityByLocalName(serverId, "mcp_resource", resource.provenanceId);
	}

	/** Content item capability for a listed prompt; never-listed prompts are denied. */
	private _requirePromptCapability(
		serverId: string,
		promptId: string,
	): { id: string; revision: string; parentId: string; sourceId: string } {
		const prompt = this._mcpContentCatalogs.get(serverId)?.prompts.find((entry) => entry.promptId === promptId);
		if (prompt === undefined) {
			throw new CapabilityError(
				"capability_denied",
				`MCP prompt is not available in the selected capability binding for server "${serverId}"`,
			);
		}
		return this._requireContentCapabilityByLocalName(serverId, "mcp_prompt", prompt.provenanceId);
	}

	private _requireContentCapabilityByLocalName(
		serverId: string,
		kind: "mcp_resource" | "mcp_prompt",
		localName: string,
	): { id: string; revision: string; parentId: string; sourceId: string } {
		const server = this._requireMcpServerCapability(serverId);
		const descriptor = this._activeCapabilityCatalog?.descriptors.find(
			(candidate) =>
				candidate.kind === kind &&
				candidate.mcpServerId === serverId &&
				getCapabilityLocalName(candidate) === localName,
		);
		if (descriptor === undefined) {
			throw new CapabilityError(
				"capability_denied",
				`MCP ${kind === "mcp_prompt" ? "prompt" : "resource"} for server "${serverId}" is not in the capability catalog`,
			);
		}
		return { id: descriptor.id, revision: descriptor.revision, parentId: server.id, sourceId: localName };
	}

	/**
	 * Pending attachments whose capability descriptor is still selected at the
	 * frozen binding's revision. Attachments staged against a superseded binding
	 * (server deselected or revision changed) are dropped safely; they are
	 * turn-scoped and never injected through a stale or degraded connection.
	 */
	private _currentMcpAttachmentSources(): ContextSourceInput[] {
		const binding = this._activeCapabilityBinding;
		if (binding === undefined || this._pendingMcpAttachments.length === 0) {
			return this._pendingMcpAttachments;
		}
		const selected = new Map(binding.descriptors.map((ref) => [ref.id, ref.revision]));
		return this._pendingMcpAttachments.filter((source) => {
			if (source.capabilityId === undefined || source.capabilityRevision === undefined) {
				return true;
			}
			return selected.get(source.capabilityId) === source.capabilityRevision;
		});
	}

	/**
	 * Builds the untrusted context source for one attachment. The content is
	 * normalized and bounded by the read; it reaches the model as a user-role
	 * message (never system/developer/assistant) and only the metadata receipt
	 * (digest, labels without raw URIs, capability refs) is ever persisted.
	 */
	private _buildMcpAttachmentSource(
		serverId: string,
		kind: "resource" | "prompt",
		capability: { id: string; revision: string; sourceId?: string },
		content: string,
		truncated: boolean,
		mimeType?: string,
	): ContextSourceInput {
		const sourceId = `mcp:attach:${kind}:${serverId}:${capability.sourceId}`;
		const label = `MCP ${kind} from server "${serverId}" (external, user-attached)`;
		const body = truncated
			? `${content}\n\n[truncated: attached MCP content was cut by normalization limits]`
			: content;
		const text = `<mcp_attachment server="${serverId}" kind="${kind}" truncated="${String(
			truncated,
		)}">\n${body}\n</mcp_attachment>`;
		return {
			sourceId,
			kind: "mcp_content",
			scope: "turn",
			trust: "external_untrusted",
			label,
			content: text,
			required: true,
			refId: capability.sourceId,
			capabilityId: capability.id,
			capabilityRevision: capability.revision,
			capabilityBindingId: this._activeCapabilityBinding?.id,
			// Allowlist receipt metadata only: provenance/digest/bytes/mime; the
			// wrapper text itself is never persisted on snapshots.
			provenanceId: capability.sourceId,
			byteCount: utf8ByteLength(content),
			...(mimeType === undefined ? {} : { mimeType }),
			placement: "message",
			message: {
				role: "user",
				content: [{ type: "text", text }],
				timestamp: Date.now(),
			},
		};
	}

	private _createPolicyAwareMcpTransportFactory(): MCPTransportFactory {
		const defaultFactory = createMCPDefaultTransportFactory();
		return async (config, env, options?: MCPTransportFactoryOptions) => {
			const profile = this._requireExecutionPolicyProfile();
			const authorized = this._mcpAuthorizedTransportValues.get(config.id) ?? {
				environment: {},
				headers: {},
			};
			if (profile.enforcement === "sandbox") {
				const binding = this._requireExecutionPolicyBinding();
				const sandbox = this._activeSandboxHandle;
				if (sandbox === undefined) {
					throw new PolicyError("sandbox_required");
				}
				if (sandbox.createMcpTransport === undefined) {
					throw new PolicyError("sandbox_capability_insufficient", "MCP sandbox transport is unavailable.");
				}
				return sandbox.createMcpTransport({
					bindingId: binding.id,
					serverId: config.id,
					config,
					environment: authorized.environment,
					headers: authorized.headers,
				});
			}
			const factory = this._mcpTransportFactory ?? defaultFactory;
			if (config.transport === "stdio") {
				return factory(config, (name) =>
					profile.enforcement === "legacy"
						? (authorized.environment[name] ?? env(name))
						: authorized.environment[name],
				);
			}
			return factory(config, (name) => {
				const header = (config.headersFromEnv ?? []).find((ref) => ref.valueFromEnv === name);
				if (header === undefined) return profile.enforcement === "legacy" ? env(name) : undefined;
				return profile.enforcement === "legacy"
					? (authorized.headers[header.name] ?? env(name))
					: authorized.headers[header.name];
			}, options);
		};
	}

	private _wrapToolWithPolicyInvocation(tool: AgentTool, source: PolicyOperationSource): AgentTool {
		const execute = tool.execute;
		return {
			...tool,
			execute: async (...args: Parameters<AgentTool["execute"]>) => {
				await this._ensureExecutionPolicyReady();
				if (source !== "builtin") {
					this._authorizeCapabilityInvocation(tool.name, source, String(args[0]));
				}
				return execute(...args);
			},
		};
	}

	private _buildRuntime(options: {
		activeToolNames?: string[];
		flagValues?: Map<string, boolean | string>;
		includeAllExtensionTools?: boolean;
	}): void {
		const autoResizeImages = this.settingsManager.getImageAutoResize();
		const shellCommandPrefix = this.settingsManager.getShellCommandPrefix();
		const shellPath = this.settingsManager.getShellPath();
		const baseToolDefinitions = this._baseToolsOverride
			? Object.fromEntries(
					Object.entries(this._baseToolsOverride).map(([name, tool]) => [
						name,
						createToolDefinitionFromAgentTool(tool),
					]),
				)
			: createAllToolDefinitions(this._cwd, {
					read: { autoResizeImages, policy: this._createSessionBuiltinToolPolicy("builtin") },
					bash: {
						commandPrefix: shellCommandPrefix,
						shellPath,
						policy: this._createSessionBuiltinToolPolicy("builtin"),
					},
					write: { policy: this._createSessionBuiltinToolPolicy("builtin") },
					edit: { policy: this._createSessionBuiltinToolPolicy("builtin") },
					grep: { policy: this._createSessionBuiltinToolPolicy("builtin") },
					find: { policy: this._createSessionBuiltinToolPolicy("builtin") },
					ls: { policy: this._createSessionBuiltinToolPolicy("builtin") },
				});

		this._baseToolDefinitions = new Map(
			Object.entries(baseToolDefinitions).map(([name, tool]) => [name, tool as ToolDefinition]),
		);

		const extensionsResult = this._resourceLoader.getExtensions();
		if (options.flagValues) {
			for (const [name, value] of options.flagValues) {
				extensionsResult.runtime.flagValues.set(name, value);
			}
		}

		this._extensionRunner = new ExtensionRunner(
			extensionsResult.extensions,
			extensionsResult.runtime,
			this._cwd,
			this.sessionManager,
			new ModelRegistry(this._modelRuntime),
		);
		if (this._extensionRunnerRef) {
			this._extensionRunnerRef.current = this._extensionRunner;
		}
		this._bindExtensionCore(this._extensionRunner);
		this._applyExtensionBindings(this._extensionRunner);

		// A fresh MCP lifecycle manager per runtime build. Registration never
		// connects; only binding-selected servers are connected during discovery.
		const previousMcpManager = this._mcpLifecycleManager;
		if (previousMcpManager) {
			void previousMcpManager.closeAll().catch(() => undefined);
		}
		this._mcpLifecycleManager = new MCPLifecycleManager({
			transportFactory: this._createPolicyAwareMcpTransportFactory(),
			authFor: (serverId) => this._mcpAuthHooksFor(serverId),
		});
		this._mcpRegisteredServerIds = new Set();
		this._mcpAuthorizedTransportValues = new Map();
		this._activeMcpTools = [];
		this._activeMcpToolCandidates = [];
		this._activeMcpContentCandidates = [];
		this._pendingMcpAttachments = [];
		this._mcpContentCatalogs.clear();
		this._mcpCatalogIdentitySnapshots.clear();
		this._activeCapabilityBinding = undefined;
		this._activeCapabilityCatalog = undefined;
		this._mcpDiscoveryErrors = new Map();
		this._capabilityDiscoveryError = undefined;
		this._capabilityDiscoveryStarted = false;
		this._capabilityDiscoveryPromise = Promise.resolve();
		this._serverSelectionSyncPromise = Promise.resolve();
		this._profileMaterializationTail = Promise.resolve();
		// A materialized profile is preserved across a rebuild (reload).

		const defaultActiveToolNames = this._baseToolsOverride
			? Object.keys(this._baseToolsOverride)
			: ["read", "bash", "edit", "write"];
		const baseActiveToolNames = options.activeToolNames ?? defaultActiveToolNames;
		this._refreshToolRegistry({
			activeToolNames: baseActiveToolNames,
			includeAllExtensionTools: options.includeAllExtensionTools,
		});
		// MCP capability discovery is deliberately NOT started here: a freshly
		// built runtime never connects to servers during construction. Discovery
		// begins only when capability readiness is explicitly requested
		// (whenCapabilitiesReady) or at prompt/run preflight, so no
		// constructor-time connection is silently retained.
	}

	async reload(options?: { beforeSessionStart?: () => void | Promise<void> }): Promise<void> {
		// Never rebuild the runtime (and thus the frozen capability binding) while
		// an agent run is active: the binding stays immutable for the run's
		// duration. Wait for the run to settle before any shutdown/rebuild.
		if (this._isAgentRunActive) {
			await this.waitForIdle();
		}
		const oldRunner = this._extensionRunner;
		const previousFlagValues = oldRunner.getFlagValues();
		await emitSessionShutdownEvent(oldRunner, { type: "session_shutdown", reason: "reload" });
		oldRunner.invalidate();
		await this.settingsManager.reload();
		this.syncQueueModesFromSettings();
		resetApiProviders();
		await this._resourceLoader.reload();
		this._buildRuntime({
			activeToolNames: this.getActiveToolNames(),
			flagValues: previousFlagValues,
			includeAllExtensionTools: true,
		});

		const hasBindings =
			this._extensionUIContext ||
			this._extensionCommandContextActions ||
			this._extensionShutdownHandler ||
			this._extensionErrorListener;
		if (hasBindings) {
			await options?.beforeSessionStart?.();
			await this._extensionRunner.emit({ type: "session_start", reason: "reload" });
			await this.extendResourcesFromExtensions("reload");
		}
	}

	// =========================================================================
	// Auto-Retry
	// =========================================================================

	/**
	 * Check if an error is retryable (overloaded, rate limit, server errors).
	 * Context overflow errors are NOT retryable (handled by compaction instead).
	 */
	private _isRetryableError(message: AssistantMessage): boolean {
		// Context overflow is handled by compaction, not retry.
		if (isContextOverflow(message, this.model?.contextWindow ?? 0)) return false;
		if (this._pendingProviderFailure !== undefined) {
			return this._pendingProviderFailure.retryable;
		}
		return classifyAssistantFailure(message).retryable;
	}

	/**
	 * Retry policy + callbacks shared by compaction and branch-summary summarization calls.
	 * Uses the same `settings.retry` budget/backoff as agent-turn retries so a single transient
	 * stream drop no longer fails the whole operation. `source` carries the context
	 * the TUI needs to render the retry and recreate the underlying indicator.
	 */
	private _summarizationRetryCallbacks(
		source: { source: "branchSummary" } | { source: "compaction"; reason: "manual" | "threshold" | "overflow" },
	): RetryCallbacks {
		return {
			onRetryScheduled: (attempt, maxAttempts, delayMs, errorMessage) => {
				this._emit({
					type: "summarization_retry_scheduled",
					attempt,
					maxAttempts,
					delayMs,
					errorMessage,
				});
			},
			onRetryAttemptStart: () => {
				this._emit({
					type: "summarization_retry_attempt_start",
					...source,
				});
			},
			onRetryFinished: () => {
				this._emit({ type: "summarization_retry_finished" });
			},
		};
	}

	/**
	 * Prepare a retryable error for continuation with exponential backoff.
	 * @returns true if the caller should continue the agent, false otherwise
	 */
	private async _prepareRetry(message: AssistantMessage): Promise<boolean> {
		const settings = this.settingsManager.getRetrySettings();
		if (!settings.enabled) {
			return false;
		}

		this._retryAttempt++;

		if (this._retryAttempt > settings.maxRetries) {
			// Preserve the completed attempt count so post-run handling can emit the final failure.
			this._retryAttempt--;
			return false;
		}

		const delayMs = settings.baseDelayMs * 2 ** (this._retryAttempt - 1);

		this._emit({
			type: "auto_retry_start",
			attempt: this._retryAttempt,
			maxAttempts: settings.maxRetries,
			delayMs,
			errorMessage: message.errorMessage || "Unknown error",
		});

		// Remove error message from agent state (keep in session for history)
		const messages = this.agent.state.messages;
		if (messages.length > 0 && messages[messages.length - 1].role === "assistant") {
			this.agent.state.messages = messages.slice(0, -1);
		}

		// Wait with exponential backoff (abortable)
		this._retryAbortController = new AbortController();
		try {
			await sleep(delayMs, this._retryAbortController.signal);
		} catch {
			// Aborted during sleep - emit end event so UI can clean up
			const attempt = this._retryAttempt;
			this._retryAttempt = 0;
			this._emit({
				type: "auto_retry_end",
				success: false,
				attempt,
				finalError: "Retry cancelled",
			});
			return false;
		} finally {
			this._retryAbortController = undefined;
		}

		return true;
	}

	/**
	 * Cancel in-progress retry.
	 */
	abortRetry(): void {
		this._retryAbortController?.abort();
	}

	/** Whether auto-retry is currently in progress */
	get isRetrying(): boolean {
		return this._retryAbortController !== undefined;
	}

	/** Whether auto-retry is enabled */
	get autoRetryEnabled(): boolean {
		return this.settingsManager.getRetryEnabled();
	}

	/**
	 * Toggle auto-retry setting.
	 */
	setAutoRetryEnabled(enabled: boolean): void {
		this.settingsManager.setRetryEnabled(enabled);
	}

	// =========================================================================
	// Bash Execution
	// =========================================================================

	/**
	 * Authorize extension handling for a user bash command before extension code
	 * can run. Returns false when strict sandbox execution must own the command.
	 */
	async authorizeUserBashExtension(command: string, options?: { id?: string }): Promise<boolean> {
		const prefix = this.settingsManager.getShellCommandPrefix();
		const resolvedCommand = prefix ? `${prefix}\n${command}` : command;
		await this._ensureExecutionPolicyReady();
		const authorized = await this._requireCurrentBuiltinToolPolicy("user_bash").authorizeProcess({
			command: resolvedCommand,
			cwd: this.sessionManager.getCwd(),
			env: getShellEnv(),
			requestId: options?.id,
		});
		return authorized.sandbox === undefined;
	}

	/**
	 * Execute a bash command.
	 * Adds result to agent context and session.
	 * @param command The bash command to execute
	 * @param onChunk Optional streaming callback for output
	 * @param options.excludeFromContext If true, command output won't be sent to LLM (!! prefix)
	 * @param options.id Optional identifier included in bash execution update events
	 * @param options.operations Custom BashOperations for remote execution
	 */
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
		const abortController = new AbortController();
		this._bashAbortControllers.add(abortController);
		const boundary = createOperationBoundary({
			signals: [this.agent.signal, options?.signal, abortController.signal],
			deadlineMs: options?.deadlineMs,
		});

		// Apply command prefix if configured (e.g., "shopt -s expand_aliases" for alias support)
		const prefix = this.settingsManager.getShellCommandPrefix();
		const shellPath = this.settingsManager.getShellPath();
		const resolvedCommand = prefix ? `${prefix}\n${command}` : command;

		try {
			await this._ensureExecutionPolicyReady(undefined, boundary.signal);
			if (boundary.signal.aborted) {
				return { output: "", exitCode: undefined, cancelled: true, truncated: false };
			}
			const cwd = this.sessionManager.getCwd();
			const authorized = await this._requireCurrentBuiltinToolPolicy("user_bash").authorizeProcess({
				command: resolvedCommand,
				cwd,
				env: getShellEnv(),
				requestId: options?.id,
			});
			const result = await executeBashWithOperations(
				resolvedCommand,
				cwd,
				options?.operations ?? createLocalBashOperations({ shellPath }),
				{
					onChunk: (delta) => {
						if (!boundary.signal.aborted) {
							onChunk?.(delta);
							this._emit({ type: "bash_execution_update", id: options?.id, delta });
						}
					},
					signal: boundary.signal,
					env: authorized.env,
					...(authorized.sandbox === undefined
						? {}
						: { sandbox: authorized.sandbox, bindingId: this._requireExecutionPolicyBinding().id }),
				},
			);

			if (!boundary.signal.aborted) this.recordBashResult(command, result, options);
			return result;
		} finally {
			this._bashAbortControllers.delete(abortController);
			boundary.dispose();
		}
	}

	/**
	 * Record a bash execution result in session history.
	 * Used by executeBash and by extensions that handle bash execution themselves.
	 */
	recordBashResult(command: string, result: BashResult, options?: { excludeFromContext?: boolean }): void {
		const bashMessage: BashExecutionMessage = {
			role: "bashExecution",
			command,
			output: result.output,
			exitCode: result.exitCode,
			cancelled: result.cancelled,
			truncated: result.truncated,
			fullOutputPath: result.fullOutputPath,
			timestamp: Date.now(),
			excludeFromContext: options?.excludeFromContext,
		};

		// If agent is streaming, defer adding to avoid breaking tool_use/tool_result ordering
		if (this.isStreaming) {
			// Queue for later - will be flushed on agent_end
			this._pendingBashMessages.push(bashMessage);
		} else {
			// Add to agent state immediately
			this.agent.state.messages.push(bashMessage);

			// Save to session
			this.sessionManager.appendMessage(bashMessage);
		}
	}

	/**
	 * Cancel running bash command.
	 */
	abortBash(): void {
		for (const abortController of [...this._bashAbortControllers]) {
			abortController.abort();
		}
	}

	/** Whether a bash command is currently running */
	get isBashRunning(): boolean {
		return this._bashAbortControllers.size > 0;
	}

	/** Whether there are pending bash messages waiting to be flushed */
	get hasPendingBashMessages(): boolean {
		return this._pendingBashMessages.length > 0;
	}

	/**
	 * Flush pending bash messages to agent state and session.
	 * Called after agent turn completes to maintain proper message ordering.
	 */
	private _flushPendingBashMessages(): void {
		if (this._pendingBashMessages.length === 0) return;

		for (const bashMessage of this._pendingBashMessages) {
			// Add to agent state
			this.agent.state.messages.push(bashMessage);

			// Save to session
			this.sessionManager.appendMessage(bashMessage);
		}

		this._pendingBashMessages = [];
	}

	// =========================================================================
	// Session Management
	// =========================================================================

	/** Persist a durable checkpoint at the current Session leaf. */
	createCheckpoint(reason?: string): SessionBoundaryRecord {
		if (this.isStreaming) throw new Error("Wait for the current response to finish before creating a checkpoint.");
		return createSessionCheckpoint(this.sessionManager, reason);
	}

	/** Return valid branch/checkpoint/recovery facts from this Session. */
	getSessionBoundaries(): SessionBoundaryRecord[] {
		return getSessionBoundaries(this.sessionManager);
	}

	/** Restore a checkpoint and rebuild the Agent transcript from the active branch. */
	recoverCheckpoint(checkpointId: string, reason?: string): SessionBoundaryRecord {
		if (this.isStreaming) throw new Error("Wait for the current response to finish before recovering a checkpoint.");
		const boundary = recoverSessionCheckpoint(this.sessionManager, checkpointId, reason);
		this.agent.state.messages = this.sessionManager.buildSessionContext().messages;
		return boundary;
	}

	/**
	 * Set a display name for the current session.
	 */
	setSessionName(name: string): void {
		this.sessionManager.appendSessionInfo(name);
		const event = { type: "session_info_changed", name: this.sessionManager.getSessionName() } as const;
		this._emit(event);
		void this._extensionRunner.emit(event);
	}

	// =========================================================================
	// Tree Navigation
	// =========================================================================

	/**
	 * Navigate to a different node in the session tree.
	 * Unlike fork() which creates a new session file, this stays in the same file.
	 *
	 * @param targetId The entry ID to navigate to
	 * @param options.summarize Whether user wants to summarize abandoned branch
	 * @param options.customInstructions Custom instructions for summarizer
	 * @param options.replaceInstructions If true, customInstructions replaces the default prompt
	 * @param options.label Label to attach to the branch summary entry
	 * @returns Result with editorText (if user message) and cancelled status
	 */
	async navigateTree(
		targetId: string,
		options: { summarize?: boolean; customInstructions?: string; replaceInstructions?: boolean; label?: string } = {},
	): Promise<{ editorText?: string; cancelled: boolean; aborted?: boolean; summaryEntry?: BranchSummaryEntry }> {
		if (this.isStreaming) {
			throw new Error("Wait for the current response to finish before navigating the session tree.");
		}

		const oldLeafId = this.sessionManager.getLeafId();

		// No-op if already at target
		if (targetId === oldLeafId) {
			return { cancelled: false };
		}
		this._beginModelBrokerOperation();

		// Model required for summarization
		if (options.summarize && !this.model) {
			throw new Error("No model available for summarization");
		}

		const targetEntry = this.sessionManager.getEntry(targetId);
		if (!targetEntry) {
			throw new Error(`Entry ${targetId} not found`);
		}

		// Collect entries to summarize (from old leaf to common ancestor)
		const { entries: entriesToSummarize, commonAncestorId } = collectEntriesForBranchSummary(
			this.sessionManager,
			oldLeafId,
			targetId,
		);

		// Prepare event data - mutable so extensions can override
		let customInstructions = options.customInstructions;
		let replaceInstructions = options.replaceInstructions;
		let label = options.label;

		const preparation: TreePreparation = {
			targetId,
			oldLeafId,
			commonAncestorId,
			entriesToSummarize,
			userWantsSummary: options.summarize ?? false,
			customInstructions,
			replaceInstructions,
			label,
		};

		// Set up abort controller for summarization
		this._branchSummaryAbortController = new AbortController();

		try {
			let extensionSummary: { summary: string; details?: unknown; usage?: Usage } | undefined;
			let fromExtension = false;

			// Emit session_before_tree event
			if (this._extensionRunner.hasHandlers("session_before_tree")) {
				const result = (await this._extensionRunner.emit({
					type: "session_before_tree",
					preparation,
					signal: this._branchSummaryAbortController.signal,
				})) as SessionBeforeTreeResult | undefined;

				if (result?.cancel) {
					return { cancelled: true };
				}

				if (result?.summary && options.summarize) {
					extensionSummary = result.summary;
					fromExtension = true;
				}

				// Allow extensions to override instructions and label
				if (result?.customInstructions !== undefined) {
					customInstructions = result.customInstructions;
				}
				if (result?.replaceInstructions !== undefined) {
					replaceInstructions = result.replaceInstructions;
				}
				if (result?.label !== undefined) {
					label = result.label;
				}
			}

			// Run default summarizer if needed
			let summaryText: string | undefined;
			let summaryDetails: unknown;
			let summaryUsage: Usage | undefined;
			if (options.summarize && entriesToSummarize.length > 0 && !extensionSummary) {
				const model = this.model!;
				const { model: requestModel, apiKey, headers, env } = await this._getSummarizationRequestAuth(model);
				const branchSummarySettings = this.settingsManager.getBranchSummarySettings();

				const result = await generateBranchSummary(entriesToSummarize, {
					model: requestModel,
					apiKey,
					headers,
					env,
					signal: this._branchSummaryAbortController.signal,
					customInstructions,
					replaceInstructions,
					reserveTokens: branchSummarySettings.reserveTokens,
					streamFn: this._createSummarizationStreamBoundary("branch_summary"),
					retry: this.settingsManager.getRetrySettings(),
					callbacks: this._summarizationRetryCallbacks({ source: "branchSummary" }),
				});
				if (result.aborted) {
					return { cancelled: true, aborted: true };
				}
				if (result.error) {
					throw new Error(result.error);
				}
				summaryText = result.summary;
				summaryUsage = result.usage;
				const branchDetails: BranchSummaryDetails = {
					readFiles: result.readFiles || [],
					modifiedFiles: result.modifiedFiles || [],
				};
				const snapshotId = this.settingsManager.getContextSettings().enabled
					? this.getLastContextSnapshotId()
					: undefined;
				const branchSnapshot = snapshotId ? this.sessionManager.getContextSnapshot(snapshotId) : undefined;
				if (branchSnapshot) {
					branchDetails.contextSnapshotId = branchSnapshot.id;
					branchDetails.contextBudget = { ...branchSnapshot.budget };
				}
				summaryDetails = branchDetails;
			} else if (extensionSummary) {
				summaryText = extensionSummary.summary;
				summaryDetails = extensionSummary.details;
				summaryUsage = extensionSummary.usage;
			}

			// Determine the new leaf position based on target type
			let newLeafId: string | null;
			let editorText: string | undefined;

			if (targetEntry.type === "message" && targetEntry.message.role === "user") {
				// User message: leaf = parent (null if root), text goes to editor
				newLeafId = targetEntry.parentId;
				editorText = contentText(targetEntry.message.content, "");
			} else if (targetEntry.type === "custom_message") {
				// Custom message: leaf = parent (null if root), text goes to editor
				newLeafId = targetEntry.parentId;
				editorText = contentText(targetEntry.content, "");
			} else {
				// Non-user message: leaf = selected node
				newLeafId = targetId;
			}
			createSessionBranchBoundary(this.sessionManager, oldLeafId, newLeafId, options.label);

			// Switch leaf (with or without summary)
			// Summary is attached at the navigation target position (newLeafId), not the old branch
			let summaryEntry: BranchSummaryEntry | undefined;
			if (summaryText) {
				// Create summary at target position (can be null for root)
				const summaryId = this.sessionManager.branchWithSummary(
					newLeafId,
					summaryText,
					summaryDetails,
					fromExtension,
					summaryUsage,
				);
				summaryEntry = this.sessionManager.getEntry(summaryId) as BranchSummaryEntry;

				// Attach label to the summary entry
				if (label) {
					this.sessionManager.appendLabelChange(summaryId, label);
				}
			} else if (newLeafId === null) {
				// No summary, navigating to root - reset leaf
				this.sessionManager.resetLeaf();
			} else {
				// No summary, navigating to non-root
				this.sessionManager.branch(newLeafId);
			}

			// Attach label to target entry when not summarizing (no summary entry to label)
			if (label && !summaryText) {
				this.sessionManager.appendLabelChange(targetId, label);
			}
			// Update agent state
			const sessionContext = this.sessionManager.buildSessionContext();
			this.agent.state.messages = sessionContext.messages;

			// Emit session_tree event
			await this._extensionRunner.emit({
				type: "session_tree",
				newLeafId: this.sessionManager.getLeafId(),
				oldLeafId,
				summaryEntry,
				fromExtension: summaryText ? fromExtension : undefined,
			});

			// Emit to custom tools

			return { editorText, cancelled: false, summaryEntry };
		} finally {
			this._branchSummaryAbortController = undefined;
		}
	}

	/**
	 * Get all user messages from session for fork selector.
	 */
	getUserMessagesForForking(): Array<{ entryId: string; text: string }> {
		const entries = this.sessionManager.getEntries();
		const result: Array<{ entryId: string; text: string }> = [];

		for (const entry of entries) {
			if (entry.type !== "message") continue;
			if (entry.message.role !== "user") continue;

			const text = contentText(entry.message.content, "");
			if (text) {
				result.push({ entryId: entry.id, text });
			}
		}

		return result;
	}

	/**
	 * Get session statistics. Aggregates over ALL session entries (including
	 * history that was compacted away), so token/cost totals reflect what was
	 * actually billed across the session.
	 */
	getSessionStats(): SessionStats {
		let userMessages = 0;
		let assistantMessages = 0;
		let toolResults = 0;
		let totalMessages = 0;
		let toolCalls = 0;
		const usageTotals = createUsageTotals();

		for (const entry of this.sessionManager.getEntries()) {
			if ((entry.type === "branch_summary" || entry.type === "compaction") && entry.usage) {
				addUsageToTotals(usageTotals, entry.usage);
			}
			if (entry.type !== "message") continue;
			totalMessages++;
			const message = entry.message;
			if (message.role === "user") {
				userMessages++;
			} else if (message.role === "toolResult") {
				toolResults++;
				if (message.usage) {
					addUsageToTotals(usageTotals, message.usage);
				}
			} else if (message.role === "assistant") {
				assistantMessages++;
				const assistantMsg = message as AssistantMessage;
				if (Array.isArray(assistantMsg.content)) {
					toolCalls += assistantMsg.content.filter((c) => c.type === "toolCall").length;
				}
				addUsageToTotals(usageTotals, assistantMsg.usage);
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
			cost: usageTotals.cost,
			contextUsage: this.getContextUsage(),
		};
	}

	getContextUsage(): ContextUsage | undefined {
		const model = this.model;
		if (!model) return undefined;

		const contextWindow = model.contextWindow ?? 0;
		if (contextWindow <= 0) return undefined;

		// After compaction, the last assistant usage reflects pre-compaction context size.
		// We can only trust usage from an assistant that responded after the latest compaction.
		// If no such assistant exists, context token count is unknown until the next LLM response.
		const branchEntries = this.sessionManager.getBranch();
		const latestCompaction = getLatestCompactionEntry(branchEntries);

		if (latestCompaction) {
			// Check if there's a valid assistant usage after the compaction boundary
			const compactionIndex = branchEntries.lastIndexOf(latestCompaction);
			let hasPostCompactionUsage = false;
			for (let i = branchEntries.length - 1; i > compactionIndex; i--) {
				const entry = branchEntries[i];
				if (entry.type === "message" && entry.message.role === "assistant") {
					const assistant = entry.message;
					if (assistant.stopReason !== "aborted" && assistant.stopReason !== "error") {
						const contextTokens = calculateContextTokens(assistant.usage);
						if (contextTokens > 0) {
							hasPostCompactionUsage = true;
							break;
						}
					}
				}
			}

			if (!hasPostCompactionUsage) {
				return { tokens: null, contextWindow, percent: null };
			}
		}

		const estimate = estimateContextTokens(this.messages);
		const percent = (estimate.tokens / contextWindow) * 100;

		return {
			tokens: estimate.tokens,
			contextWindow,
			percent,
		};
	}

	/**
	 * Export session to HTML.
	 * @param outputPath Optional output path (defaults to session directory)
	 * @returns Path to exported file
	 */
	async exportToHtml(outputPath?: string): Promise<string> {
		const configuredThemeName = this.settingsManager.getTheme();
		const themeName = configuredThemeName && getThemeByName(configuredThemeName) ? configuredThemeName : undefined;

		// Create tool renderer if we have an extension runner (for custom tool HTML rendering)
		const toolRenderer: ToolHtmlRenderer = createToolHtmlRenderer({
			getToolDefinition: (name) => this.getToolDefinition(name),
			theme,
			cwd: this.sessionManager.getCwd(),
		});

		return await exportSessionToHtml(this.sessionManager, this.state, {
			outputPath,
			themeName,
			toolRenderer,
		});
	}

	/**
	 * Export the current session branch to a JSONL file.
	 * Writes the session header followed by all entries on the current branch path.
	 * @param outputPath Target file path. If omitted, generates a timestamped file in cwd.
	 * @returns The resolved output file path.
	 */
	exportToJsonl(outputPath?: string): string {
		const filePath = resolvePath(
			outputPath ?? `session-${new Date().toISOString().replace(/[:.]/g, "-")}.jsonl`,
			process.cwd(),
		);
		const dir = dirname(filePath);
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}

		const header: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: this.sessionManager.getSessionId(),
			timestamp: new Date().toISOString(),
			cwd: this.sessionManager.getCwd(),
		};

		const branchEntries = this.sessionManager.getBranch();
		const lines = [JSON.stringify(header)];

		// Re-chain parentIds to form a linear sequence
		let prevId: string | null = null;
		for (const entry of branchEntries) {
			const linear = { ...entry, parentId: prevId };
			lines.push(JSON.stringify(linear));
			prevId = entry.id;
		}

		writeFileSync(filePath, `${lines.join("\n")}\n`);
		return filePath;
	}

	// =========================================================================
	// Utilities
	// =========================================================================

	/**
	 * Get text content of last assistant message.
	 * Useful for /copy command.
	 * @returns Text content, or undefined if no assistant message exists
	 */
	getLastAssistantText(): string | undefined {
		const lastAssistant = this.messages
			.slice()
			.reverse()
			.find((m) => {
				if (m.role !== "assistant") return false;
				const msg = m as AssistantMessage;
				// Skip aborted messages with no content
				if (msg.stopReason === "aborted" && msg.content.length === 0) return false;
				return true;
			});

		if (!lastAssistant) return undefined;

		let text = "";
		for (const content of (lastAssistant as AssistantMessage).content) {
			if (content.type === "text") {
				text += content.text;
			}
		}

		return text.trim() || undefined;
	}

	// =========================================================================
	// Extension System
	// =========================================================================

	createReplacedSessionContext(): ReplacedSessionContext {
		const context = Object.defineProperties(
			{},
			Object.getOwnPropertyDescriptors(this._extensionRunner.createCommandContext()),
		) as ReplacedSessionContext;
		context.sendMessage = (message, options) => this.sendCustomMessage(message, options);
		context.sendUserMessage = (content, options) => this.sendUserMessage(content, options);
		return context;
	}

	/**
	 * Check if extensions have handlers for a specific event type.
	 */
	hasExtensionHandlers(eventType: string): boolean {
		return this._extensionRunner.hasHandlers(eventType);
	}

	/**
	 * Get the extension runner (for setting UI context and error handlers).
	 */
	get extensionRunner(): ExtensionRunner {
		return this._extensionRunner;
	}
}

/**
 * Merges a new listing page into the existing catalog, deduplicated by the
 * item identity key (uri / uriTemplate / name). A later page never drops items
 * listed by an earlier page, so cursor pagination accumulates the full
 * catalog instead of replacing it page by page; the newest view of a repeated
 * item wins.
 */
function mergeMcpCatalogItems<T>(
	existing: ReadonlyArray<T>,
	page: ReadonlyArray<T>,
	keyOf: (item: T) => string,
): T[] {
	const byKey = new Map<string, T>();
	for (const item of existing) {
		byKey.set(keyOf(item), item);
	}
	for (const item of page) {
		byKey.set(keyOf(item), item);
	}
	return [...byKey.values()];
}

/** Fixed fail-closed message for content validation failures; never embeds values. */
/** Secret-free digest of staged attachment content; the only content-derived audit field. */
function mcpContentDigest(content: string): string {
	return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function mcpContentFailureMessage(kind: "content_invalid" | "content_limit_exceeded", serverId: string): string {
	return kind === "content_invalid"
		? `MCP server "${serverId}" returned or accepted invalid content`
		: `MCP server "${serverId}" content exceeded the configured limits`;
}

/**
 * Joins normalized text blocks into attachable context text. Image and other
 * non-text blocks are not representable as context source text and are dropped
 * here; the read itself is already normalized and bounded by the content
 * limits, so attachments never carry unbounded remote content.
 */
function mcpAttachmentText(blocks: ReadonlyArray<MCPNormalizedContentBlock>): string {
	return blocks
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("\n\n");
}
