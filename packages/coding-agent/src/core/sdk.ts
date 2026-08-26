import { join } from "node:path";
import { Agent, type AgentMessage, setDefaultStreamFn, type ThinkingLevel } from "@aos-agent/agent-core";
import { clampThinkingLevel, type Message, type Model, streamSimple } from "@aos-agent/ai/compat";
import { getAgentDir } from "../config.ts";
import { resolvePath } from "../utils/paths.ts";
import type { AgentSession } from "./agent-session.ts";
import {
	createAgentRuntimeCompositionFactory,
	createTrustedWorkerSandboxComposition,
	type AgentRuntimeComposition,
	type AgentRuntimeCompositionFactory,
	type TrustedWorkerSandboxComposition,
} from "./agent-runtime-composition.ts";
import {
	createAgentSessionWithRuntimeComposition,
	recordInitialAgentSessionConfiguration,
} from "./agent-session-facade.ts";
import { formatNoModelsAvailableMessage } from "./auth-guidance.ts";
import { CapabilityPublicIdentity } from "./capability-public-identity.ts";
import { CapabilityRegistry } from "./capability-registry.ts";
import { DEFAULT_THINKING_LEVEL } from "./defaults.ts";
import type { ExtensionRunner, LoadExtensionsResult, SessionStartEvent, ToolDefinition } from "./extensions/index.ts";
import type { MCPAuthProviderResolver, MCPTransportFactory } from "./mcp-types.ts";
import {
	createDefaultMCPAuthManagerOptions,
	type MCPAuthManagerOptions,
} from "./mcp-auth-manager.ts";
import { convertToLlm } from "./messages.ts";
import {
	type ModelBroker,
	ModelBrokerError,
	type ModelRoleSelection,
	type ModelRouteSelection,
} from "./model-broker.ts";
import { findInitialModel } from "./model-resolver.ts";
import { createModelBroker, ModelRuntime } from "./model-runtime.ts";
import { mergeProviderAttributionHeaders } from "./provider-attribution.ts";
import { DefaultResourceLoader, type ResourceLoader } from "./resource-loader.ts";
import type { SandboxProvider } from "./sandbox.ts";
import type { TaskCredentialProvider } from "./task-credential-provider.ts";
import { SessionManager } from "./session-manager.ts";
import { createSessionManagerForOptions, type SessionCreationOptions } from "./session-creation.ts";
import type { ExternalAgentAdapterRegistry } from "./external-agent-registry.ts";
import { SettingsManager } from "./settings-manager.ts";
import { buildSystemPrompt } from "./system-prompt.ts";
import { time } from "./timings.ts";
import {
	createBashTool,
	createAllTools,
	createCodingTools,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadOnlyTools,
	createReadTool,
	createWriteTool,
	type ToolName,
	withFileMutationQueue,
} from "./tools/index.ts";

// Preserve the pre-0.81 fallback for extensions that construct Agent instances
// or invoke low-level agent loops without supplying streamFn. Agent core remains
// provider-agnostic and does not import the AI compatibility entrypoint itself.
setDefaultStreamFn(streamSimple);

export type { SessionCreationOptions } from "./session-creation.ts";

export {
	createAgentRuntimeCompositionFactory,
	createTrustedWorkerSandboxComposition,
};
export type {
	AgentRuntimeComposition,
	AgentRuntimeCompositionContext,
	AgentRuntimeCompositionFactory,
	AgentRuntimeCompositionOptions,
	TrustedSchedulerCompositionFactory,
	TrustedSubagentCompositionFactory,
	TrustedToolGatewayFactory,
	TrustedWorkerSandboxComposition,
	TrustedWorkerSandboxFactory,
	TrustedWorkerSandboxProviderOptions,
} from "./agent-runtime-composition.ts";

export interface CreateAgentSessionOptions {
	/** Working directory for project-local discovery. Default: process.cwd() */
	cwd?: string;
	/** Global config directory. Default: ~/.aos-agent/agent */
	agentDir?: string;

	/** Canonical model/auth runtime. Defaults to a runtime using agentDir/auth.json and models.json. */
	modelRuntime?: ModelRuntime;
	/** Broker for declared route/role selection and safe model binding facts. */
	modelBroker?: ModelBroker;
	/** One immutable trusted composition factory for all optional runtime authorities. */
	runtimeComposition?: AgentRuntimeCompositionFactory;
	modelBrokerConfigRevision?: string;
	/** Optional explicit broker route for the initial session operation. */
	modelRoute?: ModelRouteSelection;
	/** Optional explicit broker role for the initial session operation. */
	modelRole?: ModelRoleSelection;
	/** Optional named Execution Policy profile selector for this session/run. */
	policyProfile?: string;

	/** Model to use. Default: from settings, else first available */
	model?: Model<any>;
	/** Thinking level. Default: from settings, else 'medium' (clamped to model capabilities) */
	thinkingLevel?: ThinkingLevel;
	/** Models available for cycling (Ctrl+P in interactive mode) */
	scopedModels?: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;

	/**
	 * Optional default tool suppression mode when no explicit allowlist is provided.
	 *
	 * - "all": start with no tools enabled
	 * - "builtin": disable the default built-in tools (read, bash, edit, write)
	 *   but keep extension/custom tools enabled
	 */
	noTools?: "all" | "builtin";
	/**
	 * Optional allowlist of tool names.
	 *
	 * When omitted, aos enables the default built-in tools (read, bash, edit, write)
	 * and leaves extension/custom tools enabled unless `noTools` changes that default.
	 * When provided, only the listed tool names are enabled.
	 */
	tools?: string[];
	/** Optional denylist of tool names to disable. Applies after `tools` when both are provided. */
	excludeTools?: string[];
	/** Custom tools to register (in addition to built-in tools). */
	customTools?: ToolDefinition[];

	/** Resource loader. When omitted, DefaultResourceLoader is used. */
	resourceLoader?: ResourceLoader;

	/** Session persistence and selection. Default: a new persisted session. */
	session?: SessionCreationOptions;

	/** @internal Physical store injection retained for coding-agent tests and hosts. */
	sessionManager?: SessionManager;

	/** Settings manager. Default: SettingsManager.create(cwd, agentDir) */
	settingsManager?: SettingsManager;
	/** Session start event metadata for extension runtime startup. */
	sessionStartEvent?: SessionStartEvent;
	/** Capability Registry facade used to freeze the session's capability binding. */
	capabilityRegistry?: CapabilityRegistry;
	/** MCP transport factory override; tests inject in-memory transports. */
	mcpTransportFactory?: MCPTransportFactory;
	/**
	 * Per-session OAuth client provider for streamable-http servers (B/C
	 * contract). stdio servers never receive it.
	 */
	mcpAuthProvider?: MCPAuthProviderResolver;
	/**
	 * Session-scoped MCP OAuth manager options (credential namespace store and
	 * installation). Defaults to the shared agent auth namespace
	 * (`agentDir/auth.json` {@link AuthStorage}) with the agentDir's
	 * per-install namespace identity, so sessions get a working manager out of
	 * the box. The session builds its own manager, wires it as the
	 * streamable-http auth provider resolver, and disposes it on teardown.
	 */
	mcpAuthManagerOptions?: MCPAuthManagerOptions;
	/** Registered sandbox providers available to execution policy. */
	sandboxProviders?: ReadonlyMap<string, SandboxProvider> | ReadonlyArray<SandboxProvider>;
	/** Branded trusted programmatic Operation Worker composition; never read from config or RPC. */
	trustedWorkerSandbox?: TrustedWorkerSandboxComposition;
	/** Trusted External Agent Adapter registry composed by the Host. */
	externalAgentRegistry?: ExternalAgentAdapterRegistry;
	/**
	 * Optional Task Credential provider composing the session-scoped Task
	 * Credential lifecycle service. Absent (or without a policy TTL ceiling)
	 * means the session has no credential service: every lifecycle signal
	 * fails closed and no lease is ever issued.
	 */
	taskCredentialProvider?: TaskCredentialProvider;
	/** Policy ceiling for Task Credential lease TTLs; required with the provider. */
	taskCredentialPolicyMaxTtlMs?: number;
}

/** Result from createAgentSession */
export interface CreateAgentSessionResult {
	/** The created session */
	session: AgentSession;
	/** The immutable authority graph used by the Session and every entry surface. */
	runtimeComposition: AgentRuntimeComposition;
	/** Extensions result (for UI context setup in interactive mode) */
	extensionsResult: LoadExtensionsResult;
	/** Warning if session was restored with a different model than saved */
	modelFallbackMessage?: string;
}

// Re-exports

export * from "./agent-session-runtime.ts";
export type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionFactory,
	InlineExtension,
	SlashCommandInfo,
	SlashCommandSource,
	ToolDefinition,
} from "./extensions/index.ts";
export type { PromptTemplate } from "./prompt-templates.ts";
export type { Skill } from "./skills.ts";
export type { Tool } from "./tools/index.ts";
// MCP OAuth types of the Session's explicit interactive auth methods (SDK
// contract surface; tokens, authorization URLs, and raw URIs are never part
// of these records).
export type { MCPAuthCallbackMode } from "./mcp-auth.ts";
export type { MCPAuthStartOptions, MCPAuthStartResult } from "./mcp-auth-manager.ts";

// MCP content types of the Session's resource/prompt methods (SDK wire
// contract surface; raw URIs, prompt args, and remote text are never retained
// by any of these records).
export type {
	McpAttachment,
	McpAttachmentKind,
} from "./mcp-attachment.ts";
export {
	MCPContentError,
} from "./mcp-content.ts";
export type {
	MCPContentErrorCode,
	MCPContentErrorView,
	MCPContentProvenance,
	MCPGetPromptResult,
	MCPNormalizedContentBlock,
	MCPNormalizedPromptMessage,
	MCPReadResourceResult,
} from "./mcp-content.ts";
export { MCPError } from "./mcp-types.ts";
export type {
	MCPConnectionStatus,
	MCPErrorKind,
	MCPErrorView,
	MCPPromptArgumentSummary,
	MCPPromptListResult,
	MCPPromptSummary,
	MCPResourceListResult,
	MCPResourceSummary,
	MCPResourceTemplateListResult,
	MCPResourceTemplateSummary,
} from "./mcp-types.ts";

export {
	withFileMutationQueue,
	// Tool factories (for custom cwd)
	createCodingTools,
	createReadOnlyTools,
	createReadTool,
	createBashTool,
	createEditTool,
	createWriteTool,
	createGrepTool,
	createFindTool,
	createLsTool,
};

// Helper Functions

function getDefaultAgentDir(): string {
	return getAgentDir();
}

/** List persisted sessions without exposing the physical SessionManager writer. */
export function listSessions(cwd: string = process.cwd(), sessionDirectory?: string) {
	return SessionManager.list(cwd, sessionDirectory);
}

/** List persisted sessions across project directories. */
export function listAllSessions(sessionDirectory?: string) {
	return sessionDirectory === undefined ? SessionManager.listAll() : SessionManager.listAll(sessionDirectory);
}

/**
 * Create an AgentSession with the specified options.
 *
 * @example
 * ```typescript
 * // Minimal - uses defaults
 * const { session } = await createAgentSession();
 *
 * // With explicit model
 * import { getModel } from '@aos-agent/ai';
 * const { session } = await createAgentSession({
 *   model: getModel('anthropic', 'claude-opus-4-5'),
 *   thinkingLevel: 'high',
 * });
 *
 * // Continue previous session
 * const { session, modelFallbackMessage } = await createAgentSession({
 *   session: { mode: "continue" },
 * });
 *
 * // Full control
 * const loader = new DefaultResourceLoader({
 *   cwd: process.cwd(),
 *   agentDir: getAgentDir(),
 *   settingsManager: SettingsManager.create(),
 * });
 * await loader.reload();
 * const { session } = await createAgentSession({
 *   model: myModel,
 *   tools: ["read", "bash"],
 *   resourceLoader: loader,
 *   session: { mode: "memory" },
 * });
 * ```
 */
export async function createAgentSession(options: CreateAgentSessionOptions = {}): Promise<CreateAgentSessionResult> {
	if (
		options.runtimeComposition !== undefined &&
		(options.trustedWorkerSandbox !== undefined ||
			options.externalAgentRegistry !== undefined ||
			options.taskCredentialProvider !== undefined ||
			options.taskCredentialPolicyMaxTtlMs !== undefined)
	) {
		throw new TypeError("AgentSession accepts optional providers through one runtime composition");
	}
	const runtimeComposition = options.runtimeComposition ?? createAgentRuntimeCompositionFactory({
		...(options.trustedWorkerSandbox === undefined
			? {}
			: { trustedWorkerSandbox: options.trustedWorkerSandbox }),
		...(options.externalAgentRegistry === undefined
			? {}
			: { externalAgentRegistry: options.externalAgentRegistry }),
		...(options.taskCredentialProvider === undefined
			? {}
			: { taskCredentialProvider: options.taskCredentialProvider }),
		...(options.taskCredentialPolicyMaxTtlMs === undefined
			? {}
			: { taskCredentialPolicyMaxTtlMs: options.taskCredentialPolicyMaxTtlMs }),
	});
	const agentDir = options.agentDir ? resolvePath(options.agentDir) : getDefaultAgentDir();
	const sessionManager = options.sessionManager ??
		createSessionManagerForOptions({ cwd: options.cwd, agentDir, session: options.session }).sessionManager;
	const cwd = resolvePath(options.cwd ?? sessionManager.getCwd());
	let resourceLoader = options.resourceLoader;

	const authPath = options.agentDir ? join(agentDir, "auth.json") : undefined;
	const modelsPath = options.agentDir ? join(agentDir, "models.json") : undefined;
	const modelRuntime = options.modelRuntime ?? (await ModelRuntime.create({ authPath, modelsPath }));

	const settingsManager = options.settingsManager ?? SettingsManager.create(cwd, agentDir);

	if (!resourceLoader) {
		resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
		await resourceLoader.reload();
		time("resourceLoader.reload");
	}

	// Extension providers are staged by ResourceLoader. Register them before
	// constructing the Broker so route validation sees the complete runtime
	// catalog used by the first request.
	const extensionsResult = resourceLoader.getExtensions();
	for (const { name, config } of extensionsResult.runtime.pendingProviderRegistrations) {
		modelRuntime.registerProvider(name, config);
	}
	for (const { provider } of extensionsResult.runtime.pendingNativeProviderRegistrations) {
		modelRuntime.registerNativeProvider(provider);
	}
	await modelRuntime.refresh({ allowNetwork: false });

	const availableModels = new Set(
		modelRuntime
			.getAvailableSnapshot()
			.map((availableModel) => `${availableModel.provider}\u0000${availableModel.id}`),
	);
	const modelBrokerSettings = settingsManager.getModelBrokerSettings({
		availableModels: modelRuntime.getModels().map((availableModel) => ({
			provider: availableModel.provider,
			modelId: availableModel.id,
			available: availableModels.has(`${availableModel.provider}\u0000${availableModel.id}`),
			cost: availableModel.cost,
			thinkingLevelMap: availableModel.thinkingLevelMap,
		})),
	});
	const modelBroker = options.modelBroker ?? createModelBroker(modelRuntime, modelBrokerSettings);
	const mcpAuthManagerOptions =
		options.mcpAuthManagerOptions ?? createDefaultMCPAuthManagerOptions(agentDir);

	// Check if session has existing data to restore
	const existingSession = sessionManager.buildSessionContext();
	const hasExistingSession = existingSession.messages.length > 0;
	const hasThinkingEntry = sessionManager.getBranch().some((entry) => entry.type === "thinking_level_change");

	const explicitModelSelection = options.model !== undefined;
	if (options.modelRoute !== undefined && options.modelRole !== undefined) {
		throw new ModelBrokerError("model_invalid_reference", "modelRoute and modelRole are mutually exclusive.");
	}
	let model = options.model;
	let modelFallbackMessage: string | undefined;

	// If session has data, try to restore model from it
	if (!model && hasExistingSession && existingSession.model) {
		const restoredModel = modelRuntime.getModel(existingSession.model.provider, existingSession.model.modelId);
		if (restoredModel && modelRuntime.hasConfiguredAuth(restoredModel.provider)) {
			model = restoredModel;
		}
		if (!model) {
			modelFallbackMessage = `Could not restore model ${existingSession.model.provider}/${existingSession.model.modelId}`;
		}
	}

	// If still no model, use findInitialModel (checks settings default, then provider defaults)
	if (!model) {
		const result = await findInitialModel({
			scopedModels: [],
			isContinuing: hasExistingSession,
			defaultProvider: settingsManager.getDefaultProvider(),
			defaultModelId: settingsManager.getDefaultModel(),
			defaultThinkingLevel: settingsManager.getDefaultThinkingLevel(),
			modelRuntime,
		});
		model = result.model;
		if (!model) {
			modelFallbackMessage = formatNoModelsAvailableMessage();
		} else if (modelFallbackMessage) {
			modelFallbackMessage += `. Using ${model.provider}/${model.id}`;
		}
	}

	let thinkingLevel = options.thinkingLevel;

	// If session has data, restore thinking level from it
	if (thinkingLevel === undefined && hasExistingSession) {
		thinkingLevel = hasThinkingEntry
			? (existingSession.thinkingLevel as ThinkingLevel)
			: (settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL);
	}

	// Fall back to settings default
	if (thinkingLevel === undefined) {
		thinkingLevel = settingsManager.getDefaultThinkingLevel() ?? DEFAULT_THINKING_LEVEL;
	}

	// Clamp to model capabilities
	if (!model) {
		thinkingLevel = "off";
	} else {
		thinkingLevel = clampThinkingLevel(model, thinkingLevel) as ThinkingLevel;
	}

	const defaultActiveToolNames: ToolName[] = ["read", "bash", "edit", "write"];
	const allowedToolNames = options.tools ?? (options.noTools === "all" ? [] : undefined);
	const excludedToolNames = options.excludeTools;
	const excludedToolNameSet = excludedToolNames ? new Set(excludedToolNames) : undefined;
	const initialActiveToolNames: string[] = (
		options.tools
			? [...options.tools]
			: options.noTools === "all"
				? []
				: [
					...(options.noTools === "builtin" ? [] : defaultActiveToolNames),
					...(options.customTools ?? []).map((tool) => tool.name),
				]
	).filter((name) => !excludedToolNameSet?.has(name));
	let sessionForToolEnvironment: AgentSession | undefined;
	const baseToolsOverride = createAllTools(cwd, {
		bash: {
			spawnHook: (context) => {
				const currentModel = sessionForToolEnvironment?.model ?? model;
				const currentThinkingLevel = sessionForToolEnvironment?.thinkingLevel ?? thinkingLevel;
				const sessionFile = sessionForToolEnvironment?.sessionFile ?? sessionManager.getSessionFile();
				return {
					...context,
					env: {
						...context.env,
						AOS_AGENT_SESSION_ID: sessionManager.getSessionId(),
						...(sessionFile === undefined ? {} : { AOS_AGENT_SESSION_FILE: sessionFile }),
						...(currentModel === undefined
							? {}
							: { AOS_AGENT_PROVIDER: currentModel.provider, AOS_AGENT_MODEL: currentModel.id }),
						AOS_AGENT_REASONING_LEVEL: currentThinkingLevel,
					},
				};
			},
		},
	});
	const initialToolSnippets: Record<string, string> = {};
	const initialPromptGuidelines: string[] = [];
	for (const tool of [...Object.values(baseToolsOverride), ...(options.customTools ?? [])]) {
		if (!initialActiveToolNames.includes(tool.name)) continue;
		const promptTool = tool as typeof tool & { promptSnippet?: unknown; promptGuidelines?: readonly unknown[] };
		if (typeof promptTool.promptSnippet === "string" && promptTool.promptSnippet.trim().length > 0) {
			initialToolSnippets[tool.name] = promptTool.promptSnippet;
		}
		for (const guideline of promptTool.promptGuidelines ?? []) {
			if (typeof guideline === "string") initialPromptGuidelines.push(guideline);
		}
	}
	const appendSystemPrompt = resourceLoader.getAppendSystemPrompt().join("\n\n");
	const contextEnabled = settingsManager.getContextSettings().enabled;
	const initialSystemPrompt = buildSystemPrompt({
		cwd,
		customPrompt: resourceLoader.getSystemPrompt(),
		...(appendSystemPrompt.length === 0 ? {} : { appendSystemPrompt }),
		selectedTools: initialActiveToolNames,
		toolSnippets: initialToolSnippets,
		promptGuidelines: initialPromptGuidelines,
		instructionBlocks: contextEnabled
			? []
			: resourceLoader.getContextSources().contextSources
				.filter((source) => source.injectable)
				.map((source) => ({
					sourceId: source.sourceId,
					path: source.path,
					content: source.content,
					scope: source.scope,
					trust: source.trust,
				})),
		skills: contextEnabled ? [] : resourceLoader.getSkills().skills,
	});

	let agent: Agent;

	// Create convertToLlm wrapper that filters images if blockImages is enabled (defense-in-depth)
	const convertToLlmWithBlockImages = (messages: AgentMessage[]): Message[] => {
		const converted = convertToLlm(messages);
		// Check setting dynamically so mid-session changes take effect
		if (!settingsManager.getBlockImages()) {
			return converted;
		}
		// Filter out ImageContent from all messages, replacing with text placeholder
		return converted.map((msg) => {
			if (msg.role === "user" || msg.role === "toolResult") {
				const content = msg.content;
				if (Array.isArray(content)) {
					const hasImages = content.some((c) => c.type === "image");
					if (hasImages) {
						const filteredContent = content
							.map((c) =>
								c.type === "image" ? { type: "text" as const, text: "Image reading is disabled." } : c,
							)
							.filter(
								(c, i, arr) =>
									// Dedupe consecutive "Image reading is disabled." texts
									!(
										c.type === "text" &&
										c.text === "Image reading is disabled." &&
										i > 0 &&
										arr[i - 1].type === "text" &&
										(arr[i - 1] as { type: "text"; text: string }).text === "Image reading is disabled."
									),
							);
						return { ...msg, content: filteredContent };
					}
				}
			}
			return msg;
		});
	};

	const extensionRunnerRef: { current?: ExtensionRunner } = {};

	agent = new Agent({
		initialState: {
			systemPrompt: initialSystemPrompt,
			model,
			thinkingLevel,
			tools: [],
		},
		convertToLlm: convertToLlmWithBlockImages,
		streamFn: async (model, context, options) => {
			const providerRetrySettings = settingsManager.getProviderRetrySettings();
			const httpIdleTimeoutMs = settingsManager.getHttpIdleTimeoutMs();
			// SDKs treat timeout=0 as 0ms (immediate timeout), not "no timeout".
			// Use max int32 to effectively disable the timeout.
			const effectiveTimeoutMs = httpIdleTimeoutMs === 0 ? 2147483647 : httpIdleTimeoutMs;
			const timeoutMs = options?.timeoutMs ?? providerRetrySettings.timeoutMs ?? effectiveTimeoutMs;
			const websocketConnectTimeoutMs =
				options?.websocketConnectTimeoutMs ?? settingsManager.getWebSocketConnectTimeoutMs();
			const headerRunner = extensionRunnerRef.current;
			return modelRuntime.streamSimple(model, context, {
				...options,
				timeoutMs,
				websocketConnectTimeoutMs,
				maxRetries: options?.maxRetries ?? providerRetrySettings.maxRetries,
				maxRetryDelayMs: options?.maxRetryDelayMs ?? providerRetrySettings.maxRetryDelayMs,
				transformHeaders: async (requestHeaders) => {
					const headers = mergeProviderAttributionHeaders(
						model,
						settingsManager,
						options?.sessionId,
						requestHeaders,
					);
					return headerRunner?.hasHandlers("before_provider_headers")
						? headerRunner.emitBeforeProviderHeaders(headers ?? {})
						: (headers ?? {});
				},
			});
		},
		onPayload: async (payload, _model) => {
			const runner = extensionRunnerRef.current;
			if (!runner?.hasHandlers("before_provider_request")) {
				return payload;
			}
			return runner.emitBeforeProviderRequest(payload);
		},
		onResponse: async (response, _model) => {
			const runner = extensionRunnerRef.current;
			if (!runner?.hasHandlers("after_provider_response")) {
				return;
			}
			await runner.emit({
				type: "after_provider_response",
				status: response.status,
				headers: response.headers,
			});
		},
		sessionId: sessionManager.getSessionId(),
		transformContext: async (messages) => {
			const runner = extensionRunnerRef.current;
			if (!runner) return messages;
			return runner.emitContext(messages);
		},
		steeringMode: settingsManager.getSteeringMode(),
		followUpMode: settingsManager.getFollowUpMode(),
		transport: settingsManager.getTransport(),
		thinkingBudgets: settingsManager.getThinkingBudgets(),
		maxRetryDelayMs: settingsManager.getProviderRetrySettings().maxRetryDelayMs,
	});

	// Restore messages if session has existing data. Bootstrap facts are
	// persisted after canonical Session composition below.
	if (hasExistingSession) {
		agent.state.messages = existingSession.messages;
	}

	const capabilityRegistry =
		options.capabilityRegistry ?? new CapabilityRegistry(await CapabilityPublicIdentity.load(agentDir));

	const session = createAgentSessionWithRuntimeComposition({
		agent,
		sessionManager,
		settingsManager,
		agentDir,
		cwd,
		scopedModels: options.scopedModels,
		resourceLoader,
		customTools: options.customTools,
		modelRuntime,
		modelBroker,
		modelBrokerConfigRevision: options.modelBrokerConfigRevision ?? modelBrokerSettings.configRevision,
		initialModelSelection: explicitModelSelection ? "manual" : "default",
		initialActiveToolNames,
		allowedToolNames,
		excludedToolNames,
		baseToolsOverride,
		extensionRunnerRef,
		sessionStartEvent: options.sessionStartEvent,
		capabilityRegistry,
		mcpTransportFactory: options.mcpTransportFactory,
		mcpAuthProvider: options.mcpAuthProvider,
		mcpAuthManagerOptions,
		sandboxProviders: options.sandboxProviders,
		policyProfile: options.policyProfile,
		noTools: options.noTools,
	}, runtimeComposition);
	sessionForToolEnvironment = session;
	if (!hasExistingSession || !hasThinkingEntry) {
		await recordInitialAgentSessionConfiguration(session, model, thinkingLevel, !hasExistingSession);
	}
	if (!explicitModelSelection && (options.modelRoute !== undefined || options.modelRole !== undefined)) {
		const selection = modelBroker.resolveResult({
			...(options.modelRoute === undefined ? {} : { modelRoute: options.modelRoute }),
			...(options.modelRole === undefined ? {} : { modelRole: options.modelRole }),
		});
		if (!selection.ok) throw new ModelBrokerError(selection.error);
		const selectedModel = modelRuntime.getModel(
			selection.resolution.reference.provider,
			selection.resolution.reference.id,
		);
		if (selectedModel === undefined) {
			throw new ModelBrokerError("model_binding_unavailable", "The selected model binding is unavailable", true);
		}
		await session.setModel(selectedModel);
		session.setModelBrokerResolution(selection.resolution);
		const routeThinkingLevel = selection.resolution.reference.thinkingLevel;
		if (
			routeThinkingLevel === "off" ||
			routeThinkingLevel === "minimal" ||
			routeThinkingLevel === "low" ||
			routeThinkingLevel === "medium" ||
			routeThinkingLevel === "high" ||
			routeThinkingLevel === "xhigh" ||
			routeThinkingLevel === "max"
		) {
			session.setThinkingLevel(routeThinkingLevel);
		}
	}
	return {
		session,
		runtimeComposition: session.agentRuntimeComposition,
		extensionsResult,
		modelFallbackMessage,
	};
}
