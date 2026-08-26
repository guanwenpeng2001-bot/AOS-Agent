import type {
	Agent,
	AgentEvent,
	AgentMessage,
	AgentTool,
	ThinkingLevel,
} from "@aos-agent/agent-core";
import type { Api, ImageContent, Model } from "@aos-agent/ai";
import type { CompactionResult } from "./compaction/index.ts";
import type { AgentRuntimeCompositionFactory } from "./agent-runtime-composition.ts";
import type { ExternalAgentEvent } from "./external-agent-adapter.ts";
import type {
	ContextUsage,
	ExtensionCommandContextActions,
	ExtensionErrorListener,
	ExtensionMode,
	ExtensionRunner,
	ExtensionUIContext,
	InputSource,
	SessionStartEvent,
	ShutdownHandler,
	ToolDefinition,
} from "./extensions/index.ts";
import type { CapabilityRegistry } from "./capability-registry.ts";
import type { MCPAuthProviderResolver, MCPTransportFactory } from "./mcp-types.ts";
import type { MCPAuthManagerOptions } from "./mcp-auth-manager.ts";
import type { ModelBroker } from "./model-broker.ts";
import type { ModelRuntime } from "./model-runtime.ts";
import type { ResourceLoader } from "./resource-loader.ts";
import type { RuntimeSessionSurface } from "./runtime-session-surface.ts";
import type { SandboxProvider } from "./sandbox.ts";
import type { SessionEntry, SessionManager } from "./session-manager.ts";
import type { SettingsManager } from "./settings-manager.ts";
import type { TaskCredentialProviderAvailability } from "./task-credential-provider.ts";

/** Parsed skill block from a user message. */
export interface ParsedSkillBlock {
	name: string;
	location: string;
	content: string;
	userMessage: string | undefined;
}

/** Parse the serialized skill block accepted by all coding-agent entry modes. */
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

/** Session events projected from the canonical AgentHarness loop. */
export type AgentSessionEvent =
	| Exclude<AgentEvent, { type: "agent_end" }>
	| {
			type: "agent_end";
			messages: AgentMessage[];
			willRetry: boolean;
		}
	| { type: "agent_settled" }
	| { type: "queue_update"; steering: readonly string[]; followUp: readonly string[] }
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
	| { type: "bash_execution_update"; id?: string; delta: string }
	| { type: "external_agent_event"; event: ExternalAgentEvent };

export type AgentSessionEventListener = (event: AgentSessionEvent) => void;

/**
 * Construction shape retained for type compatibility only. It is not accepted
 * by the runtime facade; createAgentSession() is the only construction root.
 */
export interface AgentSessionConfig {
	agent: Agent;
	sessionManager: SessionManager;
	settingsManager: SettingsManager;
	agentDir?: string;
	cwd: string;
	scopedModels?: Array<{ model: Model<Api>; thinkingLevel?: ThinkingLevel }>;
	resourceLoader: ResourceLoader;
	customTools?: ToolDefinition[];
	modelRuntime: ModelRuntime;
	modelBroker?: ModelBroker;
	modelBrokerConfigRevision?: string;
	/** One trusted factory for every optional authority in this canonical Session/Harness. */
	runtimeComposition?: AgentRuntimeCompositionFactory;
	initialModelSelection?: "manual" | "default";
	initialActiveToolNames?: string[];
	allowedToolNames?: string[];
	excludedToolNames?: string[];
	baseToolsOverride?: Record<string, AgentTool>;
	extensionRunnerRef?: { current?: ExtensionRunner };
	sessionStartEvent?: SessionStartEvent;
	capabilityRegistry?: CapabilityRegistry;
	mcpTransportFactory?: MCPTransportFactory;
	mcpAuthProvider?: MCPAuthProviderResolver;
	mcpAuthManagerOptions?: MCPAuthManagerOptions;
	sandboxProviders?: ReadonlyMap<string, SandboxProvider> | ReadonlyArray<SandboxProvider>;
	policyProfile?: string;
	taskCredentialProviderAvailability?: TaskCredentialProviderAvailability;
	capabilityApprovedDescriptorIds?: ReadonlyArray<string>;
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

export interface PromptOptions {
	expandPromptTemplates?: boolean;
	images?: ImageContent[];
	streamingBehavior?: "steer" | "followUp";
	source?: InputSource;
	surface?: RuntimeSessionSurface;
	preflightResult?: (success: boolean) => void;
	runId?: string;
	signal?: AbortSignal;
	deadlineMs?: number;
}

export interface ModelCycleResult {
	model: Model<Api>;
	thinkingLevel: ThinkingLevel;
	isScoped: boolean;
}

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

export {
	AgentSession,
	createAgentSessionDelegate,
	createLegacyAgentSession,
	type CanonicalAgentSessionOptions,
	type CanonicalAgentSessionServices,
} from "./agent-session-facade.ts";
export type { AgentSessionReadProjection } from "./session-read-projection.ts";
