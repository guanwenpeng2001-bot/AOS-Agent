import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import type { AgentHarness, HarnessTool } from "@aos-agent/agent-core";
import {
	CapabilityError,
	CapabilityNameConflictError,
	CapabilityProfileNotFoundError,
	CapabilityRegistry,
	matchesCapabilityDescriptorId,
	resolveCapabilityBinding,
	type CapabilityBinding,
	type CapabilityCandidate,
	type CapabilityCatalog,
	type CapabilityCatalogView,
	toCapabilityBindingHandle,
} from "./capability-registry.ts";
import {
	createMcpServerCapabilityCandidate,
	contentSummaryId,
	createMcpContentCapabilityCandidate,
	type CapabilitySettings,
	type McpContentCapabilityKind,
	type McpContentSummary,
} from "./capability-settings.ts";
import {
	type CapabilityBindingInput,
	type ExecutionPolicyProfile,
	PolicyError,
	type PolicyApprovalRequest,
	type PolicyApprovalSource,
	type PolicyBinding,
	type PolicyDecision,
	type PolicyOperationSource,
	type PublicPolicySummary,
	resolveTaskCredentialPreflight,
	taskCredentialPolicyResource,
	type TaskCredentialPreflightResult,
	type TaskCredentialSandboxPreflight,
	authorizePolicyOperation,
	createWorkspaceIdentity,
	resolveExecutionPolicyProfile,
	toPolicyBindingHandle,
	toPublicPolicySummary,
} from "./execution-policy.ts";
import { createExecutionPolicyLedger } from "./execution-policy-ledger.ts";
import {
	createMCPDefaultTransportFactory,
	MCPLifecycleManager,
} from "./mcp-lifecycle.ts";
import type {
	MCPAuthProviderResolver,
	MCPConnectionStatus,
	MCPPromptListResult,
	MCPResourceListResult,
	MCPResourceTemplateListResult,
	MCPServerConfig,
	MCPServerConfigView,
	MCPTransportFactory,
} from "./mcp-types.ts";
import { MCPError } from "./mcp-types.ts";
import {
	MCPAuthManager as ConcreteMCPAuthManager,
	type MCPAuthManagerOptions,
} from "./mcp-auth-manager.ts";
import type { MCPAuthManager, MCPAuthStartOptions, MCPAuthStartResult } from "./mcp-auth-manager.ts";
import { MCPAuthError } from "./mcp-auth.ts";
import type { MCPCredentialStatus } from "./mcp-auth-storage.ts";
import {
	MCPContentError,
	mcpPromptId,
	mcpResourceId,
	type MCPGetPromptResult,
	type MCPReadResourceResult,
} from "./mcp-content.ts";
import { canonicalizeMCPServerUrl } from "./mcp-auth-storage.ts";
import type { McpAttachmentBindingRefs } from "./mcp-attachment.ts";
import { mapMCPToolsToDefinitions, type MCPToolDefinitionResult } from "./mcp-tool-adapter.ts";
import type { ModelRuntime } from "./model-runtime.ts";
import type { ResourceLoader } from "./resource-loader.ts";
import type { SessionManager } from "./session-manager.ts";
import type { SettingsManager } from "./settings-manager.ts";
import type { ExternalAgentAdapterRegistry } from "./external-agent-registry.ts";
import type { SandboxHandle, SandboxProvider, SandboxSession } from "./sandbox.ts";
import { SandboxSession as ConcreteSandboxSession } from "./sandbox.ts";
import type { ToolDefinition, ExtensionRunner } from "./extensions/index.ts";
import { wrapToolDefinitions } from "./tools/tool-definition-wrapper.ts";
import type { BashOperations } from "./tools/bash.ts";
import { executeBashWithOperations, type BashResult } from "./bash-executor.ts";
import { createLocalBashOperations } from "./tools/bash.ts";
import { execCommand, type ExecOptions, type ExecResult } from "./exec.ts";
import type { BindingHandle } from "./binding-handles.ts";
import { createSyntheticSourceInfo, type SourceInfo } from "./source-info.ts";
import {
	parseTaskCredentialTargetCapabilities,
	type TaskCredentialProvider,
	type TaskCredentialProviderAvailability,
	type TaskCredentialTargetCapabilities,
} from "./task-credential-provider.ts";
import {
	TASK_CREDENTIAL_MIN_TTL_MS,
	TASK_CREDENTIAL_SCHEMA_VERSION,
	TaskCredentialError,
	isTaskCredentialIsoTimestamp,
	isTaskExecutionBinding,
} from "./task-credential-lease.ts";
import { TaskCredentialService, type TaskCredentialPreflightFactsInput } from "./task-credential-service.ts";

/**
 * Service state shared by all coding-agent entry surfaces.
 *
 * This object deliberately owns only capability, policy, MCP, sandbox, and
 * host-service state. AgentHarness remains the sole owner of the operation
 * loop, durable queue, transcript reducer, cancellation signal, and resume
 * ledger. AgentSession is only a delegating facade over this object.
 */
export interface FoundationControlPlaneOptions {
	harness: AgentHarness;
	sessionManager: SessionManager;
	settingsManager: SettingsManager;
	resourceLoader: ResourceLoader;
	modelRuntime: ModelRuntime;
	extensionRunner: ExtensionRunner;
	cwd: string;
	agentDir: string;
	customTools?: ToolDefinition[];
	capabilityRegistry?: CapabilityRegistry;
	mcpTransportFactory?: MCPTransportFactory;
	mcpAuthProvider?: MCPAuthProviderResolver;
	mcpAuthManagerOptions?: MCPAuthManagerOptions;
	sandboxProviders?: ReadonlyMap<string, SandboxProvider> | ReadonlyArray<SandboxProvider>;
	policyProfile?: string;
	externalAgentRegistry?: ExternalAgentAdapterRegistry;
	taskCredentialProvider?: TaskCredentialProvider;
	taskCredentialPolicyMaxTtlMs?: number;
	taskCredentialProviderAvailability?: TaskCredentialProviderAvailability;
	noTools?: "all" | "builtin";
	allowedToolNames?: ReadonlyArray<string>;
	excludedToolNames?: ReadonlyArray<string>;
}

interface CapabilityToolSource {
	readonly kind: "builtin" | "extension" | "sdk" | "mcp";
	readonly source: string;
	readonly parentId?: string;
}

interface PolicySandboxPreview {
	providerConfigured: boolean;
	providerId?: string;
	providerStatus: "ready" | "unavailable";
	providerCapabilities: SandboxProvider["capabilities"];
}

function sourceIdentityForTool(toolName: string): string {
	if (["read", "bash", "edit", "write", "grep", "find", "ls"].includes(toolName)) return "builtin";
	return "harness";
}

function stableExtensionName(path: string): string {
	if (path.startsWith("<") && path.endsWith(">")) return path.slice(1, -1);
	return basename(path).replace(/\.(ts|js)$/, "");
}

function toolRevisionInput(definition: ToolDefinition): unknown {
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

function operationAbortError(signal?: AbortSignal): Error {
	return signal?.reason instanceof Error
		? signal.reason
		: new DOMException("Foundation control-plane operation aborted", "AbortError");
}

function isAbortError(value: unknown): boolean {
	return value instanceof Error && value.name === "AbortError";
}

export class FoundationControlPlane {
	private readonly harness: AgentHarness;
	private readonly sessionManager: SessionManager;
	private readonly settingsManager: SettingsManager;
	private readonly resourceLoader: ResourceLoader;
	private readonly modelRuntime: ModelRuntime;
	private readonly extensionRunner: ExtensionRunner;
	private readonly cwd: string;
	private readonly agentDir: string;
	private readonly customTools: ToolDefinition[];
	private readonly capabilityRegistry: CapabilityRegistry;
	private readonly mcpTransportFactory: MCPTransportFactory | undefined;
	private readonly externalAgentRegistry: ExternalAgentAdapterRegistry | undefined;
	private readonly taskCredentialProvider: TaskCredentialProvider | undefined;
	private readonly taskCredentialPolicyMaxTtlMs: number | undefined;
	private readonly taskCredentialProviderAvailability: TaskCredentialProviderAvailability | undefined;
	private readonly sandboxProviders: ReadonlyMap<string, SandboxProvider>;
	private readonly noTools: "all" | "builtin" | undefined;
	private readonly allowedToolNames: ReadonlySet<string> | undefined;
	private readonly excludedToolNames: ReadonlySet<string>;
	private readonly policyLedger: ReturnType<typeof createExecutionPolicyLedger>;
	private readonly mcpAuthManager: MCPAuthManager | undefined;
	private readonly mcpLifecycle: MCPLifecycleManager;
	private readonly mcpServerIds = new Set<string>();
	private readonly inflightMcpContentOps = new Set<AbortController>();
	private readonly bashControllers = new Set<AbortController>();
	private readonly toolSources = new Map<string, CapabilityToolSource>();
	private allHarnessTools: HarnessTool[] = [];
	private mcpTools: MCPToolDefinitionResult[] = [];
	private mcpToolCandidates: CapabilityCandidate[] = [];
	private mcpContentCandidates: CapabilityCandidate[] = [];
	private capabilityCatalog: CapabilityCatalog | undefined;
	private capabilityBinding: CapabilityBinding | undefined;
	private capabilityProfile: string | undefined;
	private capabilityError: Error | undefined;
	private discoveryStarted = false;
	private discoveryPromise: Promise<void> = Promise.resolve();
	private selectionSync: Promise<void> = Promise.resolve();
	private toolBindingSync: Promise<void> = Promise.resolve();
	private policyProfileSelection: string | undefined;
	private policyProfile: ExecutionPolicyProfile | undefined;
	private policyBinding: PolicyBinding | undefined;
	private policyBindingPersisted = new Set<string>();
	private policyPreparationTail: Promise<void> = Promise.resolve();
	private capabilityMutationTail: Promise<void> = Promise.resolve();
	private policyApprovals = new Map<string, PolicyApprovalRequest>();
	private approvedPolicyRequests: string[] = [];
	private rejectedPolicyRequests: string[] = [];
	private previousPolicyBindingIdForNextRun: string | undefined;
	private modelBrokerBindingId: string | undefined;
	private sandboxSession: SandboxSession | undefined;
	private sandboxHandle: SandboxHandle | undefined;
	private authorizedMcpValues = new Map<string, { environment: Record<string, string>; headers: Record<string, string> }>();
	private taskCredentialService: TaskCredentialService | undefined;
	private taskCredentialDisposed = false;
	private disposed = false;

	constructor(options: FoundationControlPlaneOptions) {
		this.harness = options.harness;
		this.sessionManager = options.sessionManager;
		this.settingsManager = options.settingsManager;
		this.resourceLoader = options.resourceLoader;
		this.modelRuntime = options.modelRuntime;
		this.extensionRunner = options.extensionRunner;
		this.cwd = options.cwd;
		this.agentDir = options.agentDir;
		this.customTools = [...(options.customTools ?? [])];
		this.capabilityRegistry = options.capabilityRegistry ?? new CapabilityRegistry();
		this.mcpTransportFactory = options.mcpTransportFactory;
		this.externalAgentRegistry = options.externalAgentRegistry;
		this.taskCredentialProvider = options.taskCredentialProvider;
		this.taskCredentialPolicyMaxTtlMs = options.taskCredentialPolicyMaxTtlMs;
		this.taskCredentialProviderAvailability = options.taskCredentialProviderAvailability;
		this.noTools = options.noTools;
		this.allowedToolNames = options.allowedToolNames === undefined ? undefined : new Set(options.allowedToolNames);
		this.excludedToolNames = new Set(options.excludedToolNames ?? []);
		this.policyProfileSelection = options.policyProfile;
		this.sandboxProviders = normalizeSandboxProviders(options.sandboxProviders);
		this.policyLedger = createExecutionPolicyLedger(this.sessionManager);
		this.mcpAuthManager = options.mcpAuthManagerOptions === undefined
			? undefined
			: new ConcreteMCPAuthManager(options.mcpAuthManagerOptions);
		const authProvider: MCPAuthProviderResolver | undefined = this.mcpAuthManager === undefined
			? options.mcpAuthProvider
			: (config: MCPServerConfig) => this.mcpAuthManager?.getProvider(config);
		this.mcpLifecycle = new MCPLifecycleManager({
			transportFactory: (config, env, provider) => this.createMcpTransport(config, env, provider),
			...(authProvider === undefined ? {} : { authProvider }),
		});
		this.captureHarnessTools();
		this.registerConfiguredServers();
	}

	private registerConfiguredServers(): void {
		for (const diagnostic of this.settingsManager.getCapabilitySettings().mcpServers) {
			if (this.mcpServerIds.has(diagnostic.id)) continue;
			this.mcpLifecycle.registerServers([{ id: diagnostic.id, ...diagnostic.server } as MCPServerConfig]);
			this.mcpServerIds.add(diagnostic.id);
		}
	}

	private captureHarnessTools(): void {
		this.allHarnessTools = this.harness.toolsSnapshot.filter((tool) => !tool.name.startsWith("mcp__"));
		const extensionToolNames = new Set(this.extensionRunner.getAllRegisteredTools().map((tool) => tool.definition.name));
		const customToolNames = new Set(this.customTools.map((tool) => tool.name));
		for (const tool of this.allHarnessTools) {
			if (sourceIdentityForTool(tool.name) === "builtin") this.toolSources.set(tool.name, { kind: "builtin", source: "builtin" });
			else if (!extensionToolNames.has(tool.name) && !customToolNames.has(tool.name)) this.toolSources.set(tool.name, { kind: "builtin", source: "harness" });
		}
	}

	/** Refresh the service view after extension or SDK tools are installed. */
	synchronizeTools(): void {
		// A fail-closed conflict intentionally clears the Harness-visible tool
		// set. Keep the original catalog inputs for repeat preflight attempts so
		// a retry cannot make the ambiguity disappear by observing the cleared
		// projection.
		if (this.capabilityError instanceof CapabilityNameConflictError) return;
		this.captureHarnessTools();
		this.refreshToolSources();
		this.capabilityBinding = undefined;
		this.discoveryStarted = false;
		this.capabilityError = undefined;
		try {
			this.resolveStaticBinding();
			this.applyToolBinding();
		} catch (error) {
			const errorCode = error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
			if (error instanceof CapabilityNameConflictError || errorCode === "capability_name_conflict") {
				this.capabilityError = error instanceof Error ? error : new Error(String(error));
				this.capabilityBinding = undefined;
				void this.mcpLifecycle.setSelectedServerIds(new Set()).catch(() => undefined);
				void this.harness.setTools([], []).catch(() => undefined);
			}
			throw error;
		}
	}

	private createMcpTransport(
		config: MCPServerConfig,
		env: (name: string) => string | undefined,
		provider: Parameters<MCPTransportFactory>[2],
	): ReturnType<MCPTransportFactory> {
		const values = this.authorizedMcpValues.get(config.id);
		const profile = this.policyProfile;
		if (profile?.enforcement === "sandbox") {
			const handle = this.sandboxHandle;
			if (handle?.createMcpTransport === undefined || this.policyBinding === undefined) {
				throw new PolicyError("sandbox_capability_insufficient");
			}
			return handle.createMcpTransport({
				bindingId: this.policyBinding.id,
				serverId: config.id,
				config,
				environment: values?.environment ?? {},
				headers: values?.headers ?? {},
			});
		}
		const factory = this.mcpTransportFactory ?? createMCPDefaultTransportFactory();
		if (config.transport === "stdio") {
			return factory(config, (name) => values?.environment[name] ?? (profile?.enforcement === "legacy" ? env(name) : undefined), provider);
		}
		return factory(config, (name) => {
			const header = config.headersFromEnv?.find((item) => item.valueFromEnv === name);
			if (header === undefined) return profile?.enforcement === "legacy" ? env(name) : undefined;
			return values?.headers[header.name] ?? (profile?.enforcement === "legacy" ? env(name) : undefined);
		}, provider);
	}

	private authorizedEnvironment(requested?: NodeJS.ProcessEnv): Record<string, string> {
		const profile = this.policyProfile;
		const source = requested ?? process.env;
		if (profile === undefined || profile.enforcement === "legacy" || profile.process.inheritEnvironment) {
			const values: Record<string, string> = {};
			for (const [name, value] of Object.entries(source)) {
				if (value !== undefined) values[name] = value;
			}
			return values;
		}
		const values: Record<string, string> = {};
		for (const [name, value] of Object.entries(source)) {
			if (value !== undefined && profile.process.allowEnvironment.includes(name)) values[name] = value;
		}
		return values;
	}

	private staticTrust(source: { scope: string }): boolean | undefined {
		return source.scope === "project" ? this.settingsManager.isProjectTrusted() : undefined;
	}

	private collectExtensionCandidates(): CapabilityCandidate[] {
		const candidates: CapabilityCandidate[] = [];
		for (const extension of this.resourceLoader.getExtensions().extensions) {
			const localName = stableExtensionName(extension.path);
			candidates.push({
				kind: "extension",
				name: localName,
				localName,
				sourceIdentity: extension.sourceInfo.source,
				source: extension.sourceInfo,
				trusted: this.staticTrust(extension.sourceInfo),
				revisionInput: { name: localName, source: extension.sourceInfo, toolNames: [...extension.tools.keys()].sort() },
			});
			for (const tool of extension.tools.values()) {
				candidates.push({
					kind: "extension_tool",
					name: tool.definition.name,
					localName: `${localName}:${tool.definition.name}`,
					sourceIdentity: extension.sourceInfo.source,
					source: tool.sourceInfo,
					parentId: this.capabilityRegistry.createCapabilityId("extension", extension.sourceInfo.source, localName),
					exposedToolName: tool.definition.name,
					trusted: this.staticTrust(tool.sourceInfo),
					revisionInput: toolRevisionInput(tool.definition),
				});
			}
		}
		return candidates;
	}

	private collectCandidates(settings: CapabilitySettings): CapabilityCandidate[] {
		const candidates = this.collectExtensionCandidates();
		const extensionToolNames = new Set(this.extensionRunner.getAllRegisteredTools().map((tool) => tool.definition.name));
		const customToolNames = new Set(this.customTools.map((tool) => tool.name));
		for (const tool of this.allHarnessTools) {
			const builtin = sourceIdentityForTool(tool.name) === "builtin";
			if (!builtin && (extensionToolNames.has(tool.name) || customToolNames.has(tool.name))) continue;
			const source = builtin ? createSyntheticSourceInfo(`<builtin:${tool.name}>`, { source: "builtin" }) : createSyntheticSourceInfo(`<harness:${tool.name}>`, { source: "harness" });
			candidates.push({
				kind: "builtin_tool",
				name: tool.name,
				localName: tool.name,
				sourceIdentity: source.source,
				source,
				exposedToolName: tool.name,
				revisionInput: { name: tool.name, description: tool.description, parameters: tool.parameters },
			});
		}
		for (const definition of this.customTools) {
			candidates.push({
				kind: "sdk_tool",
				name: definition.name,
				localName: definition.name,
				sourceIdentity: "sdk",
				source: createSyntheticSourceInfo(`<sdk:${definition.name}>`, { source: "sdk" }),
				exposedToolName: definition.name,
				revisionInput: toolRevisionInput(definition),
			});
		}
		for (const skill of this.resourceLoader.getSkills().skills) {
			let content: string | undefined;
			try {
				content = existsSync(skill.filePath) ? readFileSync(skill.filePath, "utf8") : undefined;
			} catch {
				content = undefined;
			}
			const source = skill.sourceInfo;
			candidates.push({
				kind: "skill",
				name: skill.name,
				localName: skill.name,
				sourceIdentity: source.source,
				source,
				trusted: this.staticTrust(source),
				revisionInput: { name: skill.name, description: skill.description, disableModelInvocation: skill.disableModelInvocation, source, content },
			});
		}
		candidates.push(...settings.mcpServers.map(createMcpServerCapabilityCandidate));
		candidates.push(...this.mcpToolCandidates, ...this.mcpContentCandidates);
		return candidates;
	}

	private resolveStaticBinding(): CapabilityBinding {
		const settings = this.settingsManager.getCapabilitySettings();
		this.registerConfiguredServers();
		const catalog = this.capabilityRegistry.buildCatalog({ candidates: this.collectCandidates(settings) });
		this.capabilityCatalog = catalog;
		const binding = this.capabilityRegistry.resolveBinding({
			catalog,
			profile: this.capabilityProfile ?? settings.defaultProfile,
			profiles: settings.profiles,
			approvedDescriptorIds: [],
			toolAllowlist: this.allowedToolNames === undefined ? undefined : [...this.allowedToolNames],
			excludeToolNames: [...this.excludedToolNames],
			noTools: this.noTools === "all",
		});
		this.capabilityBinding = binding;
		const selectedServers = new Set<string>();
		for (const ref of binding.descriptors) {
			const descriptor = catalog.descriptors.find((item) => item.id === ref.id);
			if (descriptor?.kind === "mcp_server" && descriptor.mcpServerId !== undefined) selectedServers.add(descriptor.mcpServerId);
		}
		this.selectionSync = this.mcpLifecycle.setSelectedServerIds(selectedServers);
		return binding;
	}

	private applyToolBinding(includeNewTools = false): void {
		if (this.disposed) return;
		const allTools = [...this.allHarnessTools, ...this.mcpTools.map((item) => wrapToolDefinitions([item.definition])[0])];
		const unique = new Map(allTools.map((tool) => [tool.name, tool]));
		const selected = new Set(this.capabilityBinding?.toolAllowlist ?? []);
		const currentActive = new Set(this.harness.activeToolNamesSnapshot);
		const activeNames = [...unique.keys()].filter((name) =>
			selected.has(name) &&
			!(this.noTools === "builtin" && this.isBuiltinTool(name)) &&
			(includeNewTools || currentActive.has(name) || name.startsWith("mcp__")),
		);
		const wrapped = [...unique.values()].map((tool) => this.wrapTool(tool));
		this.toolBindingSync = this.harness.setTools(wrapped, activeNames).then(
			() => this.harness.setActiveTools(activeNames),
		).catch((error: unknown) => {
			if (!this.disposed) throw error;
		});
	}

	private policyCapabilityBinding(): CapabilityBindingInput {
		const binding = this.capabilityBinding;
		return binding === undefined
			? {}
			: { id: binding.id, descriptors: binding.descriptors.map((descriptor) => ({ id: descriptor.id })), allowedCapabilityIds: binding.descriptors.map((descriptor) => descriptor.id) };
	}

	private sandboxPreview(profile: ExecutionPolicyProfile): PolicySandboxPreview | undefined {
		if (profile.enforcement !== "sandbox") return undefined;
		const providerId = profile.sandboxProvider;
		const provider = providerId === undefined ? undefined : this.sandboxProviders.get(providerId);
		return {
			providerConfigured: provider !== undefined,
			...(providerId === undefined ? {} : { providerId }),
			providerStatus: provider === undefined ? "unavailable" : "ready",
			providerCapabilities: provider?.capabilities ?? { filesystem: false, process: false, network: false, credentialIsolation: false },
		};
	}

	private ensurePolicyReadyInternal(runId?: string, signal?: AbortSignal, reconnectMcp = true): Promise<boolean> {
		return this.policyPreparationTail.catch(() => undefined).then(async () => {
			if (signal?.aborted) throw operationAbortError(signal);
			if (this.capabilityBinding === undefined) this.resolveStaticBinding();
			const requestedRunId = runId ?? this.policyBinding?.runId ?? "run:session";
			const previousPolicyBindingId = runId === undefined ? undefined : this.previousPolicyBindingIdForNextRun;
			const settings = this.settingsManager.getExecutionPolicySettings({
				policyProfile: this.policyProfileSelection,
				registeredProviderIds: ["legacy-host", "host-policy", ...this.sandboxProviders.keys()],
			});
			const result = resolveExecutionPolicyProfile({
				profiles: settings.profiles,
				defaultProfile: settings.selectedProfileId,
				policyProfile: settings.selectedProfileId,
				projectTrusted: this.settingsManager.isProjectTrusted(),
				capabilityBinding: this.policyCapabilityBinding(),
				sandbox: this.sandboxPreview(settings.selectedProfile),
				workspaceIdentity: settings.selectedProfile.enforcement === "sandbox" ? createWorkspaceIdentity(this.cwd) : "workspace:active",
				runId: requestedRunId,
				...(previousPolicyBindingId === undefined ? {} : { previousPolicyBindingId }),
				createdAt: this.policyBinding?.runId === requestedRunId ? this.policyBinding.createdAt : new Date().toISOString(),
			});
			if (!result.ok) throw result.error;
			const changed = this.policyBinding?.id !== result.binding.id;
			if (!changed) return false;
			if (this.policyBinding !== undefined) await this.mcpLifecycle.closeAll().catch(() => undefined);
			await this.disposeSandbox();
			this.policyProfile = result.profile;
			this.policyBinding = result.binding;
			if (!this.policyBindingPersisted.has(result.binding.id)) {
				this.policyLedger.appendBinding(result.binding);
				this.policyBindingPersisted.add(result.binding.id);
			}
			await this.prepareSandbox(result.profile, result.binding, signal);
			if (reconnectMcp) await this.reconnectSelectedMcpServersForPolicyBinding(signal);
			return true;
		});
	}

	private ensurePolicyReady(runId?: string, signal?: AbortSignal, reconnectMcp = true): Promise<boolean> {
		const next = this.ensurePolicyReadyInternal(runId, signal, reconnectMcp);
		this.policyPreparationTail = next.then(() => undefined, () => undefined);
		return next;
	}

	private async reconnectSelectedMcpServersForPolicyBinding(signal?: AbortSignal): Promise<void> {
		await this.selectionSync;
		const selected = this.mcpLifecycle.getSelectedServerIds();
		if (selected.size === 0) return;
		const diagnostics = new Map(this.settingsManager.getCapabilitySettings().mcpServers.map((item) => [item.id, item]));
		for (const serverId of selected) {
			const diagnostic = diagnostics.get(serverId);
			if (diagnostic === undefined) continue;
			await this.authorizeMcpStartup(diagnostic.server, serverId);
			await this.mcpLifecycle.connect(serverId, signal);
		}
	}

	private async prepareSandbox(profile: ExecutionPolicyProfile, binding: PolicyBinding, signal?: AbortSignal): Promise<void> {
		if (profile.enforcement !== "sandbox") return;
		const provider = binding.sandboxProviderId === undefined ? undefined : this.sandboxProviders.get(binding.sandboxProviderId);
		if (provider === undefined) throw new PolicyError("sandbox_unavailable");
		const session = new ConcreteSandboxSession(provider, binding);
		this.sandboxSession = session;
		this.policyLedger.appendSandboxLifecycle({
			bindingId: binding.id,
			status: "preparing",
			timestamp: new Date().toISOString(),
			providerId: provider.id,
			capabilities: provider.capabilities,
		});
		try {
			this.sandboxHandle = await session.prepare(signal);
			this.policyLedger.appendSandboxLifecycle({
				bindingId: binding.id,
				status: "ready",
				timestamp: new Date().toISOString(),
				providerId: provider.id,
				capabilities: provider.capabilities,
			});
		} catch (error) {
			this.sandboxSession = undefined;
			this.sandboxHandle = undefined;
			this.policyLedger.appendSandboxLifecycle({
				bindingId: binding.id,
				status: "failed",
				timestamp: new Date().toISOString(),
				providerId: provider.id,
				capabilities: provider.capabilities,
				reasonCode: error instanceof PolicyError ? error.code : "sandbox_start_failed",
			});
			throw error;
		}
	}

	private async disposeSandbox(): Promise<void> {
		const session = this.sandboxSession;
		this.sandboxSession = undefined;
		this.sandboxHandle = undefined;
		if (session === undefined) return;
		let reasonCode: PolicyError["code"] | undefined;
		await session.dispose().catch((error: unknown) => {
			reasonCode = error instanceof PolicyError ? error.code : "sandbox_unavailable";
		});
		this.policyLedger.appendSandboxLifecycle({
			bindingId: session.binding.id,
			status: "disposed",
			timestamp: new Date().toISOString(),
			providerId: session.provider.id,
			capabilities: session.provider.capabilities,
			...(reasonCode === undefined ? {} : { reasonCode }),
		});
	}

	private async discoverMcpTools(signal?: AbortSignal): Promise<void> {
		const binding = this.capabilityBinding;
		const catalog = this.capabilityCatalog;
		if (binding === undefined || catalog === undefined) return;
		const selected = this.mcpLifecycle.getSelectedServerIds();
		if (selected.size === 0) return;
		const diagnostics = new Map(this.settingsManager.getCapabilitySettings().mcpServers.map((item) => [item.id, item]));
		const discovered: MCPToolDefinitionResult[] = [];
		const candidates: CapabilityCandidate[] = [];
		const contentCandidates = [...this.mcpContentCandidates];
		for (const serverId of selected) {
			if (signal?.aborted) throw operationAbortError(signal);
			const diagnostic = diagnostics.get(serverId);
			if (diagnostic === undefined || !diagnostic.trusted) throw new CapabilityError("capability_denied", "MCP server is not trusted for this binding");
			const serverDescriptor = catalog.descriptors.find((item) => item.kind === "mcp_server" && item.mcpServerId === serverId);
			if (serverDescriptor === undefined) throw new CapabilityError("capability_binding_unavailable", "MCP server is missing from the capability catalog");
			await this.authorizeMcpStartup(diagnostic.server, serverId);
			await this.mcpLifecycle.connect(serverId, signal);
			const tools = await this.mcpLifecycle.listTools(serverId, signal);
			const results = mapMCPToolsToDefinitions(tools, {
				serverId,
				sourceIdentity: `${diagnostic.source.source}:${diagnostic.id}`,
				parentDescriptorId: serverDescriptor.id,
				registry: this.capabilityRegistry,
				callTool: (toolName, args, callSignal) => this.mcpLifecycle.callTool(serverId, toolName, args, callSignal),
			});
			for (const result of results) {
				discovered.push(result);
				candidates.push({
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
			const appendContentCandidates = async <T extends McpContentSummary>(
				kind: McpContentCapabilityKind,
				items: ReadonlyArray<T>,
			): Promise<void> => {
				for (const summary of items) {
					contentCandidates.push(createMcpContentCapabilityCandidate({ kind, server: diagnostic, summary }));
				}
			};
			try {
				this.authorizeMcpContentPolicy(serverId, "resource.list", "resource-list");
				await appendContentCandidates("mcp_resource", (await this.mcpLifecycle.listResources(serverId, undefined, signal)).resources);
			} catch (error) {
				if (!(error instanceof MCPContentError && error.code === "mcp_resource_unavailable")) throw error;
			}
			try {
				this.authorizeMcpContentPolicy(serverId, "resource.list", "resource-template-list");
				await appendContentCandidates("mcp_resource_template", (await this.mcpLifecycle.listResourceTemplates(serverId, undefined, signal)).resourceTemplates);
			} catch (error) {
				if (!(error instanceof MCPContentError && error.code === "mcp_resource_unavailable")) throw error;
			}
			try {
				this.authorizeMcpContentPolicy(serverId, "prompt.list", "prompt-list");
				await appendContentCandidates("mcp_prompt", (await this.mcpLifecycle.listPrompts(serverId, undefined, signal)).prompts);
			} catch (error) {
				if (!(error instanceof MCPContentError && error.code === "mcp_prompt_unavailable")) throw error;
			}
		}
		this.mcpTools = discovered;
		this.mcpToolCandidates = candidates;
		this.mcpContentCandidates = contentCandidates;
		this.refreshToolSources();
		this.resolveStaticBinding();
		this.applyToolBinding();
	}

	private async authorizeMcpStartup(server: CapabilitySettings["mcpServers"][number]["server"], serverId: string): Promise<void> {
		const profile = this.policyProfile;
		const binding = this.policyBinding;
		if (profile === undefined || binding === undefined) return;
		if (profile.enforcement === "sandbox" && (this.sandboxHandle === undefined || this.sandboxHandle.createMcpTransport === undefined)) {
			throw new PolicyError("sandbox_capability_insufficient");
		}
		if (server.transport === "stdio") {
			const environment: Record<string, string> = {};
			for (const name of server.env) {
				const value = process.env[name];
				if (value !== undefined) environment[name] = value;
			}
			const decision = authorizePolicyOperation({
				profile,
				binding,
				operation: {
					resource: "process.spawn",
					source: "mcp",
					id: `mcp-start:${serverId}`,
					command: server.command,
					cwd: this.cwd,
					scope: "workspace",
					environmentNames: server.env.filter((name) => profile.enforcement === "legacy" || profile.process.inheritEnvironment || profile.process.allowEnvironment.includes(name)),
				},
				capabilityBinding: this.policyCapabilityBinding(),
			});
			this.recordDecision(decision);
			this.assertDecisionAllowed(decision);
			this.authorizedMcpValues.set(serverId, { environment: this.authorizedEnvironment(environment), headers: {} });
			return;
		}
		const url = new URL(server.url);
		const decision = authorizePolicyOperation({
			profile,
			binding,
			operation: { resource: "network.connect", source: "mcp", id: `mcp-connect:${serverId}`, destination: url.origin, ...(url.port === "" ? {} : { port: Number(url.port) }) },
			capabilityBinding: this.policyCapabilityBinding(),
		});
		this.recordDecision(decision);
		this.assertDecisionAllowed(decision);
		const headers: Record<string, string> = {};
		for (const header of server.headersFromEnv) {
			const value = process.env[header.valueFromEnv];
			if (value !== undefined) headers[header.name] = value;
		}
		if (server.headersFromEnv.length > 0) {
			const credentialDecision = authorizePolicyOperation({
				profile,
				binding,
				operation: {
					resource: "credential.expose",
					source: "mcp",
					id: `mcp-credentials:${serverId}`,
					credentialNames: server.headersFromEnv.map((header) => header.valueFromEnv),
				},
				capabilityBinding: this.policyCapabilityBinding(),
			});
			this.recordDecision(credentialDecision);
			this.assertDecisionAllowed(credentialDecision);
		}
		this.authorizedMcpValues.set(serverId, { environment: {}, headers });
	}

	private recordDecision(decision: PolicyDecision): void {
		this.policyLedger.appendDecision(decision);
		if (decision.approval !== undefined && !this.policyApprovals.has(decision.approval.id)) {
			this.policyApprovals.set(decision.approval.id, decision.approval);
			this.policyLedger.appendApproval(decision.approval);
		}
		if (decision.outcome !== "allow" && !this.approvedPolicyRequests.includes(decision.requestId ?? "")) {
			this.policyLedger.appendViolation({ bindingId: decision.bindingId, timestamp: decision.timestamp, reasonCode: decision.reasonCode ?? "policy_denied", resource: decision.resource, ...(decision.requestId === undefined ? {} : { requestId: decision.requestId }) });
		}
	}

	private assertDecisionAllowed(decision: PolicyDecision): void {
		if (decision.outcome === "allow") return;
		if (decision.outcome === "ask" && decision.requestId !== undefined && this.approvedPolicyRequests.includes(decision.requestId)) return;
		throw new PolicyError(decision.reasonCode ?? "policy_denied");
	}

	private authorizeTool(toolName: string, source: PolicyOperationSource, requestId: string): void {
		if (this.policyProfile === undefined || this.policyBinding === undefined) throw new PolicyError("policy_binding_failed");
		const descriptor = this.capabilityBinding?.descriptors.find((ref) => ref.exposedToolName === toolName);
		const decision = authorizePolicyOperation({
			profile: this.policyProfile,
			binding: this.policyBinding,
			operation: { resource: "capability.invoke", source, id: requestId, ...(descriptor === undefined ? {} : { capabilityId: descriptor.id }) },
			capabilityBinding: this.policyCapabilityBinding(),
		});
		this.recordDecision(decision);
		this.assertDecisionAllowed(decision);
	}

	private wrapTool(tool: HarnessTool): HarnessTool {
		const source = this.toolSources.get(tool.name);
		const operationSource: PolicyOperationSource = source?.kind === "sdk" ? "sdk" : source?.kind === "mcp" ? "mcp" : source?.kind === "extension" ? "extension" : "builtin";
		const execute = tool.execute;
		return {
			...tool,
			execute: async (toolCallId, params, signal, onUpdate) => {
				await this.ensurePolicyReady();
				if (operationSource !== "builtin") this.authorizeTool(tool.name, operationSource, toolCallId);
				return execute(toolCallId, params, signal, onUpdate);
			},
		};
	}

	private refreshToolSources(): void {
		for (const registered of this.extensionRunner.getAllRegisteredTools()) {
			this.toolSources.set(registered.definition.name, { kind: "extension", source: registered.sourceInfo.source });
		}
		for (const definition of this.customTools) this.toolSources.set(definition.name, { kind: "sdk", source: "sdk" });
		for (const result of this.mcpTools) this.toolSources.set(result.definition.name, { kind: "mcp", source: result.mapping.sourceIdentity });
	}

	async whenCapabilitiesReady(runId?: string, signal?: AbortSignal): Promise<void> {
		if (this.disposed) throw new Error("Foundation control plane is disposed");
		this.refreshToolSources();
		try {
			if (this.capabilityBinding === undefined) {
				this.resolveStaticBinding();
				this.applyToolBinding();
				await this.selectionSync;
				await this.toolBindingSync;
			}
			await this.ensurePolicyReady(runId, signal);
			if (!this.discoveryStarted) {
				this.discoveryStarted = true;
				this.discoveryPromise = this.discoverMcpTools(signal).catch((error: unknown) => {
					if (isAbortError(error)) {
						this.discoveryStarted = false;
						throw error;
					}
					this.capabilityError = error instanceof Error ? error : new Error(String(error));
				});
			}
			await this.discoveryPromise;
			await this.ensurePolicyReady(runId, signal);
			await this.toolBindingSync;
			if (this.capabilityError !== undefined) throw this.capabilityError;
		} catch (error) {
			const errorCode = error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : undefined;
			if (error instanceof CapabilityNameConflictError || errorCode === "capability_name_conflict") {
				this.capabilityError = error instanceof Error ? error : new Error(String(error));
				this.capabilityBinding = undefined;
				this.selectionSync = this.mcpLifecycle.setSelectedServerIds(new Set());
				await this.selectionSync;
				this.toolBindingSync = this.harness.setTools([], []).catch((closeError: unknown) => {
					if (!this.disposed) throw closeError;
				});
				await this.toolBindingSync;
			}
			throw error;
		}
	}

	getActiveCapabilityBinding(): CapabilityBinding | undefined { return this.capabilityBinding; }
	getCapabilityBindingId(): string | undefined { return this.capabilityBinding?.id; }
	inspectCapabilityCatalog(): CapabilityCatalogView { return this.capabilityRegistry.inspectCatalog() ?? { version: 1, descriptors: [] }; }
	getCapabilityContextMetadata(): {
		bindingId?: string;
		tools: ReadonlyArray<{ name: string; id: string; revision: string; kind: string }>;
		hasSkills: boolean;
	} {
		const catalog = this.capabilityRegistry.inspectCatalog();
		const toolNames = new Set(this.getToolNames());
		const tools = (catalog?.descriptors ?? [])
			.filter((descriptor) => descriptor.exposedToolName !== undefined && toolNames.has(descriptor.exposedToolName))
			.map((descriptor) => ({
				name: descriptor.exposedToolName!,
				id: descriptor.id,
				revision: descriptor.revision,
				kind: descriptor.kind,
			}));
		return {
			...(this.capabilityBinding === undefined ? {} : { bindingId: this.capabilityBinding.id }),
			tools,
			hasSkills: this.resourceLoader.getSkills().skills.length > 0,
		};
	}
	getActiveCapabilityProfile(): string { return this.capabilityProfile ?? this.settingsManager.getCapabilitySettings().defaultProfile; }

	async setCapabilityProfile(profileName?: string): Promise<void> {
		const operation = this.capabilityMutationTail.then(async () => {
			const settings = this.settingsManager.getCapabilitySettings();
			const profile = profileName ?? settings.defaultProfile;
			if (settings.profiles[profile] === undefined) throw new CapabilityProfileNotFoundError(profile);
			this.capabilityProfile = profile;
			this.capabilityBinding = undefined;
			this.discoveryStarted = false;
			this.capabilityError = undefined;
			this.mcpTools = [];
			this.mcpToolCandidates = [];
			await this.whenCapabilitiesReady();
		});
		this.capabilityMutationTail = operation.then(() => undefined, () => undefined);
		await operation;
	}

	async approveCapability(descriptorId: string): Promise<void> {
		const operation = this.capabilityMutationTail.then(async () => {
			const catalog = this.capabilityCatalog;
			if (catalog === undefined) throw new CapabilityError("capability_denied", "Capability catalog is not ready");
			const descriptor = catalog.descriptors.find((candidate) => matchesCapabilityDescriptorId(candidate, descriptorId));
			if (descriptor === undefined) throw new CapabilityError("capability_denied", "Unknown capability");
			const binding = resolveCapabilityBinding({
				catalog,
				profile: this.getActiveCapabilityProfile(),
				profiles: this.settingsManager.getCapabilitySettings().profiles,
				approvedDescriptorIds: [descriptor.id],
			});
			if (!binding.descriptors.some((ref) => ref.id === descriptor.id)) throw new CapabilityError("capability_denied", "Capability cannot be approved");
			this.capabilityBinding = binding;
			this.applyToolBinding(true);
		});
		this.capabilityMutationTail = operation.then(() => undefined, () => undefined);
		await operation;
	}

	getMcpConnectionStatus(serverId: string): MCPConnectionStatus | undefined {
		this.registerConfiguredServers();
		return this.mcpLifecycle.getStatus(serverId);
	}
	getMcpServerConfigView(serverId: string): MCPServerConfigView | undefined { return this.mcpLifecycle.getConfigView(serverId); }
	getMcpAuthManager(): MCPAuthManager | undefined { return this.mcpAuthManager; }

	/**
	 * Auth is a host operation and must not wait for the model capability
	 * discovery pass. Establish the static capability/policy bindings only, then
	 * authorize the OAuth operation before creating a flow or contacting the
	 * authorization server.
	 */
	private async prepareMcpAuthStart(
		serverId: string,
		serverUrl: string | URL,
		signal?: AbortSignal,
	): Promise<void> {
		if (signal?.aborted) throw operationAbortError(signal);
		this.registerConfiguredServers();
		const diagnostic = this.settingsManager.getCapabilitySettings().mcpServers.find((server) => server.id === serverId);
		if (diagnostic === undefined) {
			throw new MCPError("invalid_config", serverId, "MCP server configuration is missing");
		}
		if (diagnostic.server.transport === "stdio") {
			throw new MCPError("invalid_config", serverId, "MCP server does not support OAuth");
		}
		if (!diagnostic.trusted) {
			throw new CapabilityError("capability_denied", "MCP server is not trusted for OAuth");
		}
		this.assertMcpAuthEndpoint(serverId, diagnostic.server.url, serverUrl);

		if (this.capabilityBinding === undefined) {
			this.refreshToolSources();
			this.resolveStaticBinding();
			this.applyToolBinding();
			await this.selectionSync;
			await this.toolBindingSync;
		}
		await this.ensurePolicyReady(undefined, signal, false);
		if (!this.mcpLifecycle.isSelected(serverId)) {
			throw new CapabilityError("capability_denied", "MCP server is not selected for OAuth");
		}
		const serverDescriptor = this.capabilityCatalog?.descriptors.find(
			(candidate) => candidate.kind === "mcp_server" && candidate.mcpServerId === serverId,
		);
		if (serverDescriptor === undefined || !this.capabilityBinding?.descriptors.some((ref) => ref.id === serverDescriptor.id)) {
			throw new CapabilityError("capability_denied", "MCP server is not selected for OAuth");
		}
		await this.authorizeMcpAuthOperation(serverId, signal);
	}

	private assertMcpAuthEndpoint(serverId: string, registeredUrl: string, requestedUrl: string | URL): void {
		let registered: string;
		let requested: string;
		try {
			registered = canonicalizeMCPServerUrl(registeredUrl);
			requested = canonicalizeMCPServerUrl(String(requestedUrl));
		} catch {
			throw new MCPAuthError("invalid_server_url", serverId);
		}
		if (registered !== requested) throw new MCPAuthError("resource_mismatch", serverId);
	}

	private async authorizeMcpAuthOperation(serverId: string, signal?: AbortSignal): Promise<void> {
		await this.ensurePolicyReady(undefined, signal, false);
		const profile = this.policyProfile;
		const binding = this.policyBinding;
		if (profile === undefined || binding === undefined) throw new PolicyError("policy_binding_failed");
		const decision = authorizePolicyOperation({
			profile,
			binding,
			operation: { resource: "mcp.auth", source: "rpc" },
			capabilityBinding: this.policyCapabilityBinding(),
		});
		this.recordDecision(decision);
		this.assertDecisionAllowed(decision);
	}

	private recordMcpAuthAudit(
		serverId: string,
		outcome: "success" | "failed",
		reasonCode?: string,
	): void {
		try {
			this.harness.recordCustomEntry("mcp.content.audit", {
				serverId,
				operation: "auth",
				outcome,
				...(reasonCode === undefined ? {} : { reasonCode }),
				...(this.capabilityBinding?.id === undefined ? {} : { capabilityBindingId: this.capabilityBinding.id }),
				...(this.policyBinding?.id === undefined ? {} : { policyBindingId: this.policyBinding.id }),
				timestamp: new Date().toISOString(),
			});
		} catch {
			// Audit persistence is best effort and cannot change the OAuth result.
		}
	}

	private mcpAuthFailureReason(error: unknown): string {
		if (error instanceof PolicyError) return "policy_denied";
		if (error instanceof CapabilityError) return "capability_denied";
		if (error instanceof MCPError) return error.kind === "not_selected" ? "capability_denied" : error.kind;
		if (error instanceof MCPAuthError) return error.kind;
		return "auth_failed";
	}

	async startMcpAuth(serverId: string, serverUrl: string | URL, options: MCPAuthStartOptions): Promise<MCPAuthStartResult> {
		if (this.mcpAuthManager === undefined) throw new Error("MCP OAuth is not configured for this session");
		try {
			await this.prepareMcpAuthStart(serverId, serverUrl, options.interaction.signal);
			const result = await this.mcpAuthManager.start(serverId, serverUrl, options);
			this.recordMcpAuthAudit(serverId, "success");
			return result;
		} catch (error) {
			this.recordMcpAuthAudit(serverId, "failed", this.mcpAuthFailureReason(error));
			throw error;
		}
	}
	async logoutMcpAuth(serverId: string, serverUrl?: string | URL): Promise<void> {
		if (this.mcpAuthManager === undefined) throw new Error("MCP OAuth is not configured for this session");
		try {
			const diagnostic = this.settingsManager.getCapabilitySettings().mcpServers.find((server) => server.id === serverId);
			if (diagnostic?.server.transport === "stdio") {
				throw new MCPError("invalid_config", serverId, "MCP server does not support OAuth");
			}
			if (diagnostic?.server.transport === "streamable-http" && serverUrl !== undefined) {
				this.assertMcpAuthEndpoint(serverId, diagnostic.server.url, serverUrl);
			}
			await this.authorizeMcpAuthOperation(serverId);
			await this.mcpAuthManager.logout(serverId, serverUrl);
			this.recordMcpAuthAudit(serverId, "success");
		} catch (error) {
			this.recordMcpAuthAudit(serverId, "failed", this.mcpAuthFailureReason(error));
			throw error;
		}
	}
	async getMcpAuthStatus(serverId: string, serverUrl: string | URL): Promise<MCPCredentialStatus | undefined> {
		return this.mcpAuthManager?.getStatus(serverUrl);
	}
	async listMcpCredentialStatuses(): Promise<readonly MCPCredentialStatus[]> { return this.mcpAuthManager?.listStatuses() ?? []; }

	private async assertMcpSelected(
		serverId: string,
		resource: "resource.list" | "resource.read" | "prompt.list" | "prompt.get",
		signal?: AbortSignal,
		contentKind?: McpContentCapabilityKind,
		descriptorLocalName?: string,
	): Promise<void> {
		if (signal?.aborted) throw operationAbortError(signal);
		await this.whenCapabilitiesReady(undefined, signal);
		if (!this.mcpServerIds.has(serverId)) throw new MCPError("invalid_config", serverId, "MCP server configuration is missing");
		if (!this.mcpLifecycle.isSelected(serverId)) throw new MCPError("not_selected", serverId, "MCP server is not selected");
		const diagnostic = this.settingsManager.getCapabilitySettings().mcpServers.find((server) => server.id === serverId);
		if (diagnostic === undefined || !diagnostic.trusted) throw new CapabilityError("capability_denied", "MCP server is not trusted");
		const serverDescriptor = this.capabilityCatalog?.descriptors.find((candidate) => candidate.kind === "mcp_server" && candidate.mcpServerId === serverId);
		if (serverDescriptor === undefined || !this.capabilityBinding?.descriptors.some((ref) => ref.id === serverDescriptor.id)) {
			throw new MCPError("not_selected", serverId, "MCP server is not selected");
		}
		if (contentKind !== undefined) this.assertMcpContentCapabilitySelected(serverId, contentKind, descriptorLocalName);
		this.authorizeMcpContentPolicy(serverId, resource, resource.replace(".", "-"));
	}

	private assertMcpContentCapabilitySelected(
		serverId: string,
		kind: McpContentCapabilityKind,
		descriptorLocalName?: string,
	): void {
		const children = this.capabilityCatalog?.descriptors.filter((candidate) => candidate.kind === kind && candidate.mcpServerId === serverId) ?? [];
		const binding = this.capabilityBinding;
		if (descriptorLocalName !== undefined) {
			const diagnostic = this.settingsManager.getCapabilitySettings().mcpServers.find((server) => server.id === serverId);
			const expectedId = diagnostic === undefined ? undefined : this.capabilityRegistry.createCapabilityId(kind, diagnostic.source.source, descriptorLocalName);
			const descriptor = children.find((candidate) => candidate.id === expectedId);
			if (descriptor === undefined) throw new CapabilityError("capability_denied", "MCP content is not in the capability catalog");
			const selected = binding?.descriptors.find((ref) => ref.id === descriptor.id);
			if (!descriptor.trusted || descriptor.availability !== "available" || selected === undefined || selected.revision !== descriptor.revision) {
				throw new CapabilityError("capability_denied", "MCP content is not selected by the capability binding");
			}
			return;
		}
		if (children.length > 0 && !(binding?.descriptors.some((ref) => children.some((child) => child.id === ref.id)))) {
			throw new CapabilityError("capability_denied", "MCP content is not selected by the capability binding");
		}
	}

	private authorizeMcpContentPolicy(
		serverId: string,
		resource: "resource.list" | "resource.read" | "prompt.list" | "prompt.get" | "context.attach",
		opName: string,
	): void {
		if (this.policyProfile === undefined || this.policyBinding === undefined) throw new PolicyError("policy_binding_failed");
		const decision = authorizePolicyOperation({
			profile: this.policyProfile,
			binding: this.policyBinding,
			operation: { resource, source: "mcp", id: `mcp-${opName}:${serverId}` },
			capabilityBinding: this.policyCapabilityBinding(),
		});
		this.recordDecision(decision);
		this.assertDecisionAllowed(decision);
	}

	private async mergeMcpContentCandidates(
		kind: McpContentCapabilityKind,
		serverId: string,
		summaries: ReadonlyArray<McpContentSummary>,
		signal?: AbortSignal,
	): Promise<void> {
		const diagnostic = this.settingsManager.getCapabilitySettings().mcpServers.find((server) => server.id === serverId);
		if (diagnostic === undefined || summaries.length === 0) return;
		const existing = new Set(this.mcpContentCandidates.map((candidate) => `${candidate.kind}\u0000${candidate.sourceIdentity}\u0000${candidate.localName ?? ""}`));
		let added = false;
		for (const summary of summaries) {
			const localName = contentSummaryId(kind, summary);
			const key = `${kind}\u0000${diagnostic.source.source}\u0000${localName}`;
			if (existing.has(key)) continue;
			this.mcpContentCandidates.push(createMcpContentCapabilityCandidate({ kind, server: diagnostic, summary }));
			existing.add(key);
			added = true;
		}
		if (!added) return;
		if (signal?.aborted) throw operationAbortError(signal);
		if (!this.harness.isRunning) {
			this.capabilityBinding = undefined;
			this.capabilityError = undefined;
			this.captureHarnessTools();
			this.refreshToolSources();
			// A new catalog page changes only the static binding. The existing MCP
			// connection and discovered tool/content candidates remain authoritative;
			// rerunning readiness here would fetch every catalog page again.
			this.resolveStaticBinding();
			this.applyToolBinding();
			await this.selectionSync;
			await this.toolBindingSync;
		}
	}

	private async runMcpContentOp<T>(operation: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
		if (signal?.aborted) throw operationAbortError(signal);
		const controller = new AbortController();
		this.inflightMcpContentOps.add(controller);
		const onAbort = (): void => controller.abort(signal?.reason);
		signal?.addEventListener("abort", onAbort, { once: true });
		try {
			return await operation(controller.signal);
		} finally {
			signal?.removeEventListener("abort", onAbort);
			this.inflightMcpContentOps.delete(controller);
		}
	}

	async listMcpResources(serverId: string, params?: { cursor?: string }, signal?: AbortSignal): Promise<MCPResourceListResult> {
		await this.assertMcpSelected(serverId, "resource.list", signal, "mcp_resource");
		return this.runMcpContentOp(async (operationSignal) => {
			const result = await this.mcpLifecycle.listResources(serverId, params, operationSignal);
			await this.mergeMcpContentCandidates("mcp_resource", serverId, result.resources, operationSignal);
			return result;
		}, signal);
	}
	async listMcpResourceTemplates(serverId: string, params?: { cursor?: string }, signal?: AbortSignal): Promise<MCPResourceTemplateListResult> {
		await this.assertMcpSelected(serverId, "resource.list", signal, "mcp_resource_template");
		return this.runMcpContentOp(async (operationSignal) => {
			const result = await this.mcpLifecycle.listResourceTemplates(serverId, params, operationSignal);
			await this.mergeMcpContentCandidates("mcp_resource_template", serverId, result.resourceTemplates, operationSignal);
			return result;
		}, signal);
	}
	async listMcpPrompts(serverId: string, params?: { cursor?: string }, signal?: AbortSignal): Promise<MCPPromptListResult> {
		await this.assertMcpSelected(serverId, "prompt.list", signal, "mcp_prompt");
		return this.runMcpContentOp(async (operationSignal) => {
			const result = await this.mcpLifecycle.listPrompts(serverId, params, operationSignal);
			await this.mergeMcpContentCandidates("mcp_prompt", serverId, result.prompts, operationSignal);
			return result;
		}, signal);
	}
	async readMcpResource(serverId: string, uri: string, signal?: AbortSignal): Promise<MCPReadResourceResult> {
		await this.assertMcpSelected(serverId, "resource.read", signal, "mcp_resource", mcpResourceId(serverId, uri));
		return this.runMcpContentOp((operationSignal) => this.mcpLifecycle.readResource(serverId, uri, operationSignal), signal);
	}
	async getMcpPrompt(serverId: string, name: string, args?: Record<string, string>, signal?: AbortSignal): Promise<MCPGetPromptResult> {
		await this.assertMcpSelected(serverId, "prompt.get", signal, "mcp_prompt", mcpPromptId(serverId, name));
		return this.runMcpContentOp((operationSignal) => this.mcpLifecycle.getPrompt(serverId, name, args, operationSignal), signal);
	}

	getMcpAttachmentBindingRefs(
		kind: "mcp_resource" | "mcp_prompt",
		serverId: string,
		sourceId: string,
	): McpAttachmentBindingRefs {
		const capabilityBindingId = this.capabilityBinding?.id;
		const policyBindingId = this.policyBinding?.id;
		if (capabilityBindingId === undefined || policyBindingId === undefined) {
			throw new CapabilityError("capability_binding_unavailable", "MCP attachment requires settled bindings");
		}
		const diagnostic = this.settingsManager.getCapabilitySettings().mcpServers.find((server) => server.id === serverId);
		const descriptorId = diagnostic === undefined
			? undefined
			: this.capabilityRegistry.createCapabilityId(kind, diagnostic.source.source, sourceId);
		const descriptor = descriptorId === undefined
			? undefined
			: this.capabilityCatalog?.descriptors.find((candidate) => candidate.id === descriptorId);
		return {
			capabilityBindingId,
			policyBindingId,
			...(descriptor === undefined ? {} : { descriptorId: descriptor.id, descriptorRevision: descriptor.revision }),
		};
	}

	authorizeMcpContentAttachment(serverId: string): void {
		this.authorizeMcpContentPolicy(serverId, "context.attach", "context-attach");
	}

	recordMcpContentAudit(entry: {
		serverId: string;
		outcome: "success" | "failed" | "cancelled";
		reasonCode?: string;
		descriptorId?: string;
		revision?: string;
		provenanceId?: string;
		capabilityBindingId?: string;
		policyBindingId?: string;
		contentDigest?: string;
		byteCount?: number;
		blockCount?: number;
		mimeTypes?: ReadonlyArray<string>;
	}): void {
		try {
			this.harness.recordCustomEntry("mcp.content.audit", {
				serverId: entry.serverId,
				operation: "context.attach",
				outcome: entry.outcome,
				...(entry.reasonCode === undefined ? {} : { reasonCode: entry.reasonCode }),
				...(entry.descriptorId === undefined ? {} : { descriptorId: entry.descriptorId }),
				...(entry.revision === undefined ? {} : { revision: entry.revision }),
				...(entry.provenanceId === undefined ? {} : { provenanceId: entry.provenanceId }),
				...(entry.capabilityBindingId === undefined ? {} : { capabilityBindingId: entry.capabilityBindingId }),
				...(entry.policyBindingId === undefined ? {} : { policyBindingId: entry.policyBindingId }),
				...(entry.contentDigest === undefined ? {} : { contentDigest: entry.contentDigest }),
				...(entry.byteCount === undefined ? {} : { byteCount: entry.byteCount }),
				...(entry.blockCount === undefined ? {} : { blockCount: entry.blockCount }),
				...(entry.mimeTypes === undefined || entry.mimeTypes.length === 0 ? {} : { mimeTypes: [...entry.mimeTypes] }),
				timestamp: new Date().toISOString(),
			});
		} catch {
			// Audit persistence is best effort and cannot turn an attachment into a success.
		}
	}

	cancelMcpContentOperations(): void {
		for (const controller of this.inflightMcpContentOps) controller.abort(new DOMException("MCP content operation cancelled", "AbortError"));
		this.inflightMcpContentOps.clear();
	}

	getActiveExecutionPolicyProfile(): string { return this.policyProfile?.id ?? this.policyProfileSelection ?? this.settingsManager.getExecutionPolicySettings().selectedProfileId; }
	getActiveExecutionPolicyBinding(): PolicyBinding | undefined { return this.policyBinding; }
	getActiveExecutionPolicySummary(): PublicPolicySummary {
		if (this.policyBinding !== undefined) return toPublicPolicySummary(this.policyBinding);
		const settings = this.settingsManager.getExecutionPolicySettings({ policyProfile: this.policyProfileSelection, registeredProviderIds: ["legacy-host", "host-policy", ...this.sandboxProviders.keys()] });
		const result = resolveExecutionPolicyProfile({ profiles: settings.profiles, defaultProfile: settings.selectedProfileId, policyProfile: settings.selectedProfileId, projectTrusted: this.settingsManager.isProjectTrusted(), capabilityBinding: this.policyCapabilityBinding(), sandbox: this.sandboxPreview(settings.selectedProfile), workspaceIdentity: "workspace:active", runId: "run:session", createdAt: new Date().toISOString() });
		if (!result.ok) throw result.error;
		return result.summary;
	}
	getPendingExecutionPolicyApprovals(): ReadonlyArray<PolicyApprovalRequest> { return [...this.policyApprovals.values()]; }
	/** Compatibility projection for legacy tests; the map remains owned here. */
	getPendingExecutionPolicyApprovalsMap(): Map<string, PolicyApprovalRequest> { return this.policyApprovals; }
	approveExecutionPolicyRequest(requestId: string, source: PolicyApprovalSource = "interactive"): void { this.resolvePolicyApproval(requestId, "approved", source); }
	rejectExecutionPolicyRequest(requestId: string, source: PolicyApprovalSource = "interactive"): void { this.resolvePolicyApproval(requestId, "rejected", source); }
	private resolvePolicyApproval(requestId: string, outcome: "approved" | "rejected", source: PolicyApprovalSource): void {
		const approval = this.policyApprovals.get(requestId);
		if (approval === undefined) throw new PolicyError("policy_denied");
		this.policyLedger.appendApprovalOutcome(approval, { outcome, source });
		if (outcome === "approved") this.approvedPolicyRequests = [...this.approvedPolicyRequests, requestId];
		else this.rejectedPolicyRequests = [...this.rejectedPolicyRequests, requestId];
		this.policyApprovals.delete(requestId);
	}
	async setExecutionPolicyProfile(profileName?: string): Promise<void> {
		await this.mcpLifecycle.closeAll().catch(() => undefined);
		await this.disposeSandbox();
		this.policyProfileSelection = profileName;
		this.policyProfile = undefined;
		this.policyBinding = undefined;
		await this.ensurePolicyReady();
	}
	getActiveBindingHandles(): ReadonlyArray<BindingHandle> {
		const handles: BindingHandle[] = [];
		if (this.capabilityBinding !== undefined) handles.push(toCapabilityBindingHandle(this.capabilityBinding));
		if (this.policyBinding !== undefined) handles.push(toPolicyBindingHandle(this.policyBinding));
		return handles;
	}
	setModelBrokerBindingId(bindingId: string | undefined): void {
		this.modelBrokerBindingId = bindingId;
	}
	getModelBrokerBindingId(): string | undefined { return this.modelBrokerBindingId; }
	setPreviousExecutionPolicyBindingIdForNextRun(bindingId?: string): void {
		this.previousPolicyBindingIdForNextRun = bindingId;
	}
	getExternalAgentRegistry(): ExternalAgentAdapterRegistry | undefined { return this.externalAgentRegistry; }

	resolveTaskCredentialPreflight(input: TaskCredentialPreflightFactsInput): TaskCredentialPreflightResult {
		if (!Array.isArray(input.scopes) || input.scopes.length === 0 || !isTaskExecutionBinding(input.binding)) {
			return { allowed: false, error: new TaskCredentialError("task_credential_invalid") };
		}
		const provider = this.taskCredentialProvider;
		if (provider === undefined) return { allowed: false, error: new TaskCredentialError("task_credential_provider_unavailable") };
		const policyMaxTtlMs = this.taskCredentialPolicyMaxTtlMs;
		if (policyMaxTtlMs === undefined || policyMaxTtlMs <= 0) return { allowed: false, error: new TaskCredentialError("task_credential_invalid") };
		const availability = this.taskCredentialProviderAvailability;
		if (availability === undefined || !availability.available) {
			return { allowed: false, error: new TaskCredentialError("task_credential_provider_unavailable") };
		}
		if (!isTaskCredentialIsoTimestamp(input.requestedAt)) return { allowed: false, error: new TaskCredentialError("task_credential_invalid") };
		const profile = this.policyProfile;
		const policyBinding = this.policyBinding;
		const capabilityBindingId = this.capabilityBinding?.id;
		if (profile === undefined || policyBinding === undefined) return { allowed: false, error: new TaskCredentialError("task_credential_policy_denied") };
		if (capabilityBindingId === undefined) return { allowed: false, error: new TaskCredentialError("task_credential_binding_invalid") };
		const credentialNames = [...new Set(input.scopes.map((scope) => scope.credentialName))].sort();
		let decision: PolicyDecision;
		try {
			decision = authorizePolicyOperation({
				profile,
				binding: policyBinding,
				operation: {
					resource: taskCredentialPolicyResource(input.operation),
					source: "rpc",
					...(input.binding.targetId === undefined ? {} : { targetId: input.binding.targetId }),
					credentialNames,
					ttlMs: input.requestedTtlMs,
				},
				capabilityBinding: this.policyCapabilityBinding(),
			});
		} catch {
			return { allowed: false, error: new TaskCredentialError("task_credential_policy_denied") };
		}
		const approvalGranted = decision.outcome === "ask" && decision.requestId !== undefined
			? this.approvedPolicyRequests.includes(decision.requestId)
			: false;
		if (decision.outcome === "deny") {
			if (decision.reasonCode === "credential_policy_violation") return { allowed: false, error: new TaskCredentialError("task_credential_scope_denied") };
			if (decision.reasonCode === "sandbox_unavailable" || decision.reasonCode === "sandbox_capability_insufficient") {
				return { allowed: false, error: new TaskCredentialError("task_credential_target_unavailable") };
			}
			return { allowed: false, error: new TaskCredentialError("task_credential_policy_denied") };
		}
		if (decision.outcome === "ask" && !approvalGranted) return { allowed: false, error: new TaskCredentialError("task_credential_approval_required") };
		if (decision.outcome === "sandbox_required") return { allowed: false, error: new TaskCredentialError("task_credential_target_unavailable") };
		if (decision.outcome !== "allow" && decision.outcome !== "ask") return { allowed: false, error: new TaskCredentialError("task_credential_policy_denied") };
		const targetId = input.binding.targetId;
		if (targetId === undefined) return { allowed: false, error: new TaskCredentialError("task_credential_target_unavailable") };
		let targetKind = input.targetKind;
		if (targetKind === undefined) {
			const declaredKinds = new Set(input.scopes.flatMap((scope) => scope.targetKinds));
			if (declaredKinds.size !== 1) return { allowed: false, error: new TaskCredentialError("task_credential_target_unavailable") };
			targetKind = [...declaredKinds][0]!;
		}
		const sandboxSession = this.sandboxSession;
		const sandboxHandle = sandboxSession?.currentHandle;
		let sandbox: TaskCredentialSandboxPreflight | undefined;
		if (sandboxSession !== undefined) {
			const status: TaskCredentialSandboxPreflight["status"] = sandboxSession.currentStatus === "ready"
				? "ready"
				: sandboxSession.currentStatus === "failed"
					? "failed"
					: sandboxSession.currentStatus === "disposed"
						? "disposed"
						: "preparing";
			sandbox = {
				bindingId: sandboxSession.binding.id,
				status,
				capabilities: {
					filesystem: sandboxSession.binding.sandboxCapabilities.filesystem,
					process: sandboxSession.binding.sandboxCapabilities.process,
					network: sandboxSession.binding.sandboxCapabilities.network,
					credentialIsolation: sandboxSession.binding.sandboxCapabilities.credentialIsolation,
					...(sandboxHandle?.capabilities.credentialDelivery === undefined ? {} : { credentialDelivery: sandboxHandle.capabilities.credentialDelivery }),
				},
				perBinding: true,
			};
		}
		if (input.binding.sandboxBindingId === undefined || sandbox === undefined || sandbox.bindingId !== input.binding.sandboxBindingId || sandbox.status !== "ready" || !sandbox.perBinding || !sandbox.capabilities.credentialIsolation) {
			return { allowed: false, error: new TaskCredentialError("task_credential_target_unavailable") };
		}
		if (input.operation !== "issue" && sandbox.capabilities.credentialDelivery !== true) {
			return { allowed: false, error: new TaskCredentialError("task_credential_target_unavailable") };
		}
		let target: TaskCredentialTargetCapabilities | undefined;
		try {
			target = parseTaskCredentialTargetCapabilities(provider.target.getCapabilities({
				schemaVersion: TASK_CREDENTIAL_SCHEMA_VERSION,
				targetId,
				targetKind: targetKind!,
				bindingId: input.binding.bindingId,
				requestedAt: input.requestedAt,
			}));
		} catch {
			target = undefined;
		}
		if (target === undefined) return { allowed: false, error: new TaskCredentialError("task_credential_target_unavailable") };
		return resolveTaskCredentialPreflight({
			operation: input.operation,
			binding: input.binding,
			sessionId: this.sessionManager.getSessionId(),
			runId: input.binding.runId,
			graphRevision: input.binding.graphRevision,
			policyBindingId: policyBinding.id,
			capabilityBindingId,
			...(input.gate === undefined ? {} : { gate: input.gate }),
			nodeAttached: input.nodeAttached,
			decision,
			approvalGranted,
			capabilityBinding: this.policyCapabilityBinding(),
			scopes: input.scopes,
			scopeDigest: input.scopeDigest,
			scopeCount: input.scopeCount,
			target,
			...(sandbox === undefined ? {} : { sandbox }),
			requestedTtlMs: input.requestedTtlMs,
			ttlBounds: { minTtlMs: TASK_CREDENTIAL_MIN_TTL_MS, maxTtlMs: policyMaxTtlMs },
			nowMs: Date.parse(input.requestedAt),
			provider: availability,
		});
	}

	getTaskCredentialService(): TaskCredentialService | undefined {
		if (this.taskCredentialService !== undefined) return this.taskCredentialService;
		if (this.taskCredentialDisposed || this.taskCredentialProvider === undefined || this.taskCredentialPolicyMaxTtlMs === undefined || this.taskCredentialPolicyMaxTtlMs <= 0) return undefined;
		try {
			this.taskCredentialService = new TaskCredentialService({
				session: this.sessionManager,
				provider: this.taskCredentialProvider,
				policyMaxTtlMs: this.taskCredentialPolicyMaxTtlMs,
				preflight: { resolve: (input) => this.resolveTaskCredentialPreflight(input) },
			});
		} catch {
			this.taskCredentialService = undefined;
		}
		return this.taskCredentialService;
	}
	getToolNames(): string[] {
		const names = this.capabilityBinding?.toolAllowlist === undefined
			? [...this.harness.activeToolNamesSnapshot]
			: [...this.capabilityBinding.toolAllowlist];
		return this.noTools === "builtin" ? names.filter((name) => !this.isBuiltinTool(name)) : names;
	}
	private isBuiltinTool(name: string): boolean {
		return ["read", "bash", "edit", "write", "grep", "find", "ls"].includes(name);
	}
	private isToolVisibleForInspection(name: string): boolean {
		if (this.noTools === "all") return false;
		const binding = this.capabilityBinding;
		if (binding === undefined) return true;
		if (binding.toolAllowlist.includes(name)) return true;
		return this.noTools === "builtin" && this.isBuiltinTool(name) && binding.descriptors.some((descriptor) => descriptor.exposedToolName === name);
	}
	getToolDefinitions(): ToolDefinition[] {
		const discoveredMcpTools = this.mcpTools.map((item) => wrapToolDefinitions([item.definition])[0]);
		return [...this.allHarnessTools, ...discoveredMcpTools]
			.map((tool) => tool as unknown as ToolDefinition)
			.filter((definition) => this.isToolVisibleForInspection(definition.name));
	}
	getToolSourceInfo(name: string): SourceInfo {
		const extensionTool = this.extensionRunner.getAllRegisteredTools().find((tool) => tool.definition.name === name);
		if (extensionTool !== undefined) return extensionTool.sourceInfo;
		if (this.customTools.some((tool) => tool.name === name)) {
			return createSyntheticSourceInfo(`<sdk:${name}>`, { source: "sdk" });
		}
		if (this.mcpTools.some((tool) => tool.definition.name === name)) {
			return createSyntheticSourceInfo(`<mcp:${name}>`, { source: "mcp" });
		}
		if (this.isBuiltinTool(name)) {
			return createSyntheticSourceInfo(`<builtin:${name}>`, { source: "builtin" });
		}
		const source = this.toolSources.get(name);
		return createSyntheticSourceInfo(`<${source?.source ?? "harness"}:${name}>`, { source: source?.source ?? "harness" });
	}
	getToolDefinition(name: string): ToolDefinition | undefined { return this.getToolDefinitions().find((definition) => definition.name === name); }
	async executeCommand(command: string, args: string[], options?: ExecOptions): Promise<ExecResult> {
		await this.ensurePolicyReady();
		const profile = this.policyProfile;
		const binding = this.policyBinding;
		const cwd = options?.cwd ?? this.cwd;
		if (profile === undefined || binding === undefined) throw new PolicyError("policy_binding_failed");
		const requestedEnv = options?.env ?? process.env;
		const environmentNames = profile.enforcement === "legacy" || profile.process.inheritEnvironment
			? Object.keys(requestedEnv)
			: Object.keys(requestedEnv).filter((name) => profile.process.allowEnvironment.includes(name));
		const decision = authorizePolicyOperation({
			profile,
			binding,
			operation: {
				resource: "process.spawn",
				source: "extension",
				id: "extension-exec",
				command,
				args,
				cwd,
				scope: "workspace",
				environmentNames,
			},
			capabilityBinding: this.policyCapabilityBinding(),
		});
		this.recordDecision(decision);
		this.assertDecisionAllowed(decision);
		if (this.sandboxHandle !== undefined) {
			const stdoutChunks: string[] = [];
			const result = await this.sandboxHandle.execute({
				bindingId: binding.id,
				resource: "process.spawn",
				command,
				args,
				cwd,
				env: this.authorizedEnvironment(requestedEnv),
				timeoutMs: options?.timeout,
				signal: options?.signal,
				onData: (data) => stdoutChunks.push(data.toString()),
			});
			const stdout = stdoutChunks.join("") || (result.stdout === undefined ? "" : Buffer.from(result.stdout).toString());
			const stderr = result.stderr === undefined ? "" : Buffer.from(result.stderr).toString();
			return { stdout, stderr, code: result.exitCode ?? 0, killed: result.killed ?? false };
		}
		const useHostDefaultEnv = options?.env === undefined && (profile.enforcement === "legacy" || profile.process.inheritEnvironment);
		return execCommand(command, args, cwd, {
			...options,
			...(useHostDefaultEnv ? {} : { env: this.authorizedEnvironment(requestedEnv) }),
		});
	}
	async executeBash(
		command: string,
		onChunk?: (chunk: string) => void,
		options?: { operations?: BashOperations; signal?: AbortSignal; deadlineMs?: number; id?: string },
	): Promise<BashResult> {
		if (options?.signal?.aborted) throw operationAbortError(options.signal);
		if (options?.deadlineMs !== undefined && (!Number.isFinite(options.deadlineMs) || options.deadlineMs < 0)) {
			throw new RangeError("deadlineMs must be non-negative");
		}
		const controller = new AbortController();
		const onAbort = (): void => controller.abort(options?.signal?.reason);
		options?.signal?.addEventListener("abort", onAbort, { once: true });
		this.bashControllers.add(controller);
		let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
		if (options?.deadlineMs !== undefined) {
			deadlineTimer = setTimeout(() => controller.abort(new DOMException("Bash execution deadline exceeded", "TimeoutError")), options.deadlineMs);
		}
		try {
			await this.ensurePolicyReady(undefined, controller.signal);
			const profile = this.policyProfile;
			const binding = this.policyBinding;
			if (profile === undefined || binding === undefined) throw new PolicyError("policy_binding_failed");
			const environmentNames = profile.enforcement === "legacy" || profile.process.inheritEnvironment
				? Object.keys(process.env)
				: profile.process.allowEnvironment.filter((name) => process.env[name] !== undefined);
			const decision = authorizePolicyOperation({
				profile,
				binding,
				operation: {
					resource: "process.spawn",
					source: "user_bash",
					id: options?.id ?? "user-bash",
					command,
					cwd: this.cwd,
					scope: "workspace",
					environmentNames,
				},
				capabilityBinding: this.policyCapabilityBinding(),
			});
			this.recordDecision(decision);
			this.assertDecisionAllowed(decision);
			return await executeBashWithOperations(command, this.cwd, options?.operations ?? createLocalBashOperations(), {
				onChunk,
				signal: controller.signal,
				env: this.authorizedEnvironment(process.env),
				...(this.sandboxHandle === undefined ? {} : { sandbox: this.sandboxHandle }),
				...(binding === undefined ? {} : { bindingId: binding.id }),
			});
		} finally {
			if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
			options?.signal?.removeEventListener("abort", onAbort);
			this.bashControllers.delete(controller);
		}
	}
	async authorizeUserBash(command: string, requestId?: string): Promise<boolean> {
		await this.ensurePolicyReady();
		const profile = this.policyProfile;
		const binding = this.policyBinding;
		if (profile === undefined || binding === undefined) throw new PolicyError("policy_binding_failed");
		const environmentNames = profile.enforcement === "legacy" || profile.process.inheritEnvironment
			? Object.keys(process.env)
			: profile.process.allowEnvironment.filter((name) => process.env[name] !== undefined);
		const decision = authorizePolicyOperation({
			profile,
			binding,
			operation: {
				resource: "process.spawn",
				source: "user_bash",
				id: requestId ?? "user-bash",
				command,
				cwd: this.cwd,
				scope: "workspace",
				environmentNames,
			},
			capabilityBinding: this.policyCapabilityBinding(),
		});
		this.recordDecision(decision);
		this.assertDecisionAllowed(decision);
		return this.sandboxHandle === undefined;
	}
	get isBashRunning(): boolean { return this.bashControllers.size > 0; }
	abortBash(): void {
		for (const controller of this.bashControllers) controller.abort(new DOMException("Bash execution cancelled", "AbortError"));
	}
	getSandboxHandle(): SandboxHandle | undefined { return this.sandboxHandle; }
	/**
	 * Narrow compatibility projection for RPC integrations that need to
	 * dispose the live sandbox before a credential preflight. The control plane
	 * remains the sole owner of this session; callers receive no replacement or
	 * mutable registry.
	 */
	getSandboxSessionForCompatibility(): { dispose(): Promise<void> } | undefined {
		return this.sandboxSession;
	}
	async reload(): Promise<void> {
		if (this.disposed) throw new Error("Foundation control plane is disposed");
		await this.mcpLifecycle.closeAll().catch(() => undefined);
		await this.disposeSandbox();
		this.mcpTools = [];
		this.mcpToolCandidates = [];
		this.mcpContentCandidates = [];
		this.capabilityCatalog = undefined;
		this.capabilityBinding = undefined;
		this.capabilityError = undefined;
		this.discoveryStarted = false;
		this.discoveryPromise = Promise.resolve();
		this.captureHarnessTools();
		this.refreshToolSources();
		this.registerConfiguredServers();
		await this.whenCapabilitiesReady();
	}
	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		this.taskCredentialDisposed = true;
		this.cancelMcpContentOperations();
		this.abortBash();
		try {
			this.taskCredentialService?.onSessionShutdown();
		} catch {
			// Credential shutdown is best effort and never blocks session close.
		}
		await this.mcpLifecycle.closeAll().catch(() => undefined);
		await this.disposeSandbox();
		await this.mcpAuthManager?.dispose();
	}
}

function normalizeSandboxProviders(input: ReadonlyMap<string, SandboxProvider> | ReadonlyArray<SandboxProvider> | undefined): ReadonlyMap<string, SandboxProvider> {
	if (input === undefined) return new Map();
	if (typeof (input as ReadonlyMap<string, SandboxProvider>).get === "function") return input as ReadonlyMap<string, SandboxProvider>;
	return new Map((input as ReadonlyArray<SandboxProvider>).map((provider) => [provider.id, provider]));
}
