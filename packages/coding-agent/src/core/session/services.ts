import { join } from "node:path";
import type { ThinkingLevel } from "@aos-agent/agent-core";
import type { Model } from "@aos-agent/ai";
import { getAgentDir } from "../../config.ts";
import { resolvePath } from "../../utils/paths.ts";
import {
	type AgentRuntimeCompositionFactory,
	createAgentRuntimeCompositionFactory,
} from "../runtime/composition-factory.ts";
import { CapabilityPublicIdentity } from "../policy/capability-public-identity.ts";
import { CapabilityRegistry } from "../policy/capability-registry.ts";
import type { SessionStartEvent, ToolDefinition } from "../extensions/index.ts";
import { createDefaultMCPAuthManagerOptions, type MCPAuthManagerOptions } from "../policy/mcp-auth-manager.ts";
import type { MCPAuthProviderResolver, MCPTransportFactory } from "../runtime/mcp-types.ts";
import type { ModelBroker } from "../runtime/model-broker.ts";
import { createModelBroker, ModelRuntime } from "../runtime/model-runtime.ts";
import { createPackagedExternalConnectorRegistryFactory } from "../connector/packaged-runtime.ts";
import {
	DefaultResourceLoader,
	type DefaultResourceLoaderOptions,
	type ResourceLoader,
	type ResourceLoaderReloadOptions,
} from "../runtime/resource-loader.ts";
import type { SandboxProvider } from "../policy/sandbox.ts";
import { type CreateAgentSessionOptions, type CreateAgentSessionResult, createAgentSession } from "../runtime/sdk.ts";
import type { SessionManager } from "./manager.ts";
import { SettingsManager } from "../runtime/settings-manager.ts";

/**
 * Non-fatal issues collected while creating services or sessions.
 *
 * Runtime creation returns diagnostics to the caller instead of printing or
 * exiting. The app layer decides whether warnings should be shown and whether
 * errors should abort startup.
 */
export interface AgentSessionRuntimeDiagnostic {
	type: "info" | "warning" | "error";
	message: string;
}

/**
 * Inputs for creating cwd-bound runtime services.
 *
 * These services are recreated whenever the effective session cwd changes.
 * CLI-provided resource paths should be resolved to absolute paths before they
 * reach this function, so later cwd switches do not reinterpret them.
 */
export interface CreateAgentSessionServicesOptions {
	cwd: string;
	agentDir?: string;
	settingsManager?: SettingsManager;
	modelRuntime?: ModelRuntime;
	modelBroker?: ModelBroker;
	/** One trusted factory reused for every Session derived from these services. */
	runtimeComposition?: AgentRuntimeCompositionFactory;
	modelRuntimeSignal?: AbortSignal;
	extensionFlagValues?: Map<string, boolean | string>;
	resourceLoaderOptions?: Omit<DefaultResourceLoaderOptions, "cwd" | "agentDir" | "settingsManager">;
	resourceLoaderReloadOptions?: ResourceLoaderReloadOptions;
	/** Capability Registry facade shared by the session and inspection surfaces. */
	capabilityRegistry?: CapabilityRegistry;
	/** MCP transport factory override (tests inject in-memory transports). */
	mcpTransportFactory?: MCPTransportFactory;
	/**
	 * Per-session OAuth client provider for streamable-http servers (B/C
	 * contract). One provider instance never crosses sessions. stdio servers
	 * never receive it.
	 */
	mcpAuthProvider?: MCPAuthProviderResolver;
	/** Session-scoped MCP OAuth manager options; see {@link MCPAuthManagerOptions}. */
	mcpAuthManagerOptions?: MCPAuthManagerOptions;
	/** Registered sandbox providers available to execution policy. */
	sandboxProviders?: ReadonlyMap<string, SandboxProvider> | ReadonlyArray<SandboxProvider>;
}

/**
 * Inputs for creating an AgentSession from already-created services.
 *
 * Use this after services exist and any cwd-bound model/tool/session options
 * have been resolved against those services.
 */
export interface CreateAgentSessionFromServicesOptions {
	services: AgentSessionServices;
	sessionManager: SessionManager;
	sessionStartEvent?: SessionStartEvent;
	model?: Model<any>;
	modelRoute?: CreateAgentSessionOptions["modelRoute"];
	modelRole?: CreateAgentSessionOptions["modelRole"];
	policyProfile?: CreateAgentSessionOptions["policyProfile"];
	thinkingLevel?: ThinkingLevel;
	scopedModels?: Array<{ model: Model<any>; thinkingLevel?: ThinkingLevel }>;
	tools?: string[];
	excludeTools?: CreateAgentSessionOptions["excludeTools"];
	noTools?: CreateAgentSessionOptions["noTools"];
	customTools?: ToolDefinition[];
	sandboxProviders?: CreateAgentSessionOptions["sandboxProviders"];
}

/**
 * Coherent cwd-bound runtime services for one effective session cwd.
 *
 * This is infrastructure only. The AgentSession itself is created separately so
 * session options can be resolved against these services first.
 */
export interface AgentSessionServices {
	cwd: string;
	agentDir: string;
	modelRuntime: ModelRuntime;
	modelBroker: ModelBroker;
	modelBrokerConfigRevision: string;
	/** Immutable trusted factory reused for initial and replacement runtime candidates. */
	runtimeComposition: AgentRuntimeCompositionFactory;
	settingsManager: SettingsManager;
	resourceLoader: ResourceLoader;
	capabilityRegistry: CapabilityRegistry;
	mcpTransportFactory?: MCPTransportFactory;
	/**
	 * Per-session OAuth client provider for streamable-http servers (B/C
	 * contract). One provider instance never crosses sessions. stdio servers
	 * never receive it.
	 */
	mcpAuthProvider?: MCPAuthProviderResolver;
	/**
	 * Session-scoped MCP OAuth manager options. Defaults to the shared agent
	 * auth namespace (`agentDir/auth.json` {@link AuthStorage}) with the
	 * agentDir's per-install namespace identity when the caller did not
	 * supply explicit options.
	 */
	mcpAuthManagerOptions?: MCPAuthManagerOptions;
	sandboxProviders?: ReadonlyMap<string, SandboxProvider> | ReadonlyArray<SandboxProvider>;
	diagnostics: AgentSessionRuntimeDiagnostic[];
}

function applyExtensionFlagValues(
	resourceLoader: ResourceLoader,
	extensionFlagValues: Map<string, boolean | string> | undefined,
): AgentSessionRuntimeDiagnostic[] {
	if (!extensionFlagValues) {
		return [];
	}

	const diagnostics: AgentSessionRuntimeDiagnostic[] = [];
	const extensionsResult = resourceLoader.getExtensions();
	const registeredFlags = new Map<string, { type: "boolean" | "string" }>();
	for (const extension of extensionsResult.extensions) {
		for (const [name, flag] of extension.flags) {
			registeredFlags.set(name, { type: flag.type });
		}
	}

	const unknownFlags: string[] = [];
	for (const [name, value] of extensionFlagValues) {
		const flag = registeredFlags.get(name);
		if (!flag) {
			unknownFlags.push(name);
			continue;
		}
		if (flag.type === "boolean") {
			extensionsResult.runtime.flagValues.set(name, true);
			continue;
		}
		if (typeof value === "string") {
			extensionsResult.runtime.flagValues.set(name, value);
			continue;
		}
		diagnostics.push({
			type: "error",
			message: `Extension flag "--${name}" requires a value`,
		});
	}

	if (unknownFlags.length > 0) {
		diagnostics.push({
			type: "error",
			message: `Unknown option${unknownFlags.length === 1 ? "" : "s"}: ${unknownFlags.map((name) => `--${name}`).join(", ")}`,
		});
	}

	return diagnostics;
}

/**
 * Create cwd-bound runtime services.
 *
 * Returns services plus diagnostics. It does not create an AgentSession.
 */
export async function createAgentSessionServices(
	options: CreateAgentSessionServicesOptions,
): Promise<AgentSessionServices> {
	const cwd = resolvePath(options.cwd);
	const agentDir = options.agentDir ? resolvePath(options.agentDir) : getAgentDir();
	const modelRuntime =
		options.modelRuntime ??
		(await ModelRuntime.create({
			authPath: join(agentDir, "auth.json"),
			modelsPath: join(agentDir, "models.json"),
			signal: options.modelRuntimeSignal,
		}));
	const settingsManager = options.settingsManager ?? SettingsManager.create(cwd, agentDir);
	const resourceLoader = new DefaultResourceLoader({
		...(options.resourceLoaderOptions ?? {}),
		cwd,
		agentDir,
		settingsManager,
	});
	await resourceLoader.reload(options.resourceLoaderReloadOptions);

	const diagnostics: AgentSessionRuntimeDiagnostic[] = [];
	const extensionsResult = resourceLoader.getExtensions();
	for (const { name, config, extensionPath } of extensionsResult.runtime.pendingProviderRegistrations) {
		try {
			modelRuntime.registerProvider(name, config);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			diagnostics.push({
				type: "error",
				message: `Extension "${extensionPath}" error: ${message}`,
			});
		}
	}
	for (const { provider, extensionPath } of extensionsResult.runtime.pendingNativeProviderRegistrations) {
		try {
			modelRuntime.registerNativeProvider(provider);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			diagnostics.push({
				type: "error",
				message: `Extension "${extensionPath}" error: ${message}`,
			});
		}
	}
	await modelRuntime.refresh({ allowNetwork: false });
	diagnostics.push(...applyExtensionFlagValues(resourceLoader, options.extensionFlagValues));

	// Build the Broker only after extension provider registrations and the local
	// runtime refresh have completed. Route availability must reflect the same
	// catalog that can serve the first request, including extension models.
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

	const mcpAuthManagerOptions = options.mcpAuthManagerOptions ?? createDefaultMCPAuthManagerOptions(agentDir);
	let runtimeComposition = options.runtimeComposition;
	if (runtimeComposition === undefined) {
		const externalConnectorTargetConfig = settingsManager.getExternalConnectorTargetSettings();
		const externalConnectorRegistry =
			externalConnectorTargetConfig?.selectedTarget === undefined
				? undefined
				: await createPackagedExternalConnectorRegistryFactory({
						target: externalConnectorTargetConfig.selectedTarget,
						agentDir,
					});
		// The settings-derived composition is a complete fallback. An explicit Host
		// composition above wins as a whole; authority fields are never merged.
		runtimeComposition =
			externalConnectorTargetConfig === undefined
				? createAgentRuntimeCompositionFactory()
				: createAgentRuntimeCompositionFactory({
						...(externalConnectorTargetConfig.selectedTarget?.driver === undefined
							? {}
							: {
								toolGatewayCatalog: () => {
									const target = externalConnectorTargetConfig.selectedTarget;
									if (target === undefined) throw new TypeError("Settings vendor target is unavailable");
									return {
										gatewayId: `settings-vendor:${target.targetId}`,
										builtinLocalProviders: [],
										mcpProviders: [],
										sandboxProviders: [],
									};
								},
							}),
						externalConnectorTargetConfig,
						...(externalConnectorRegistry === undefined ? {} : { externalConnectorRegistry }),
					});
	}

	return {
		cwd,
		agentDir,
		modelRuntime,
		modelBroker,
		modelBrokerConfigRevision: modelBrokerSettings.configRevision,
		runtimeComposition,
		settingsManager,
		resourceLoader,
		capabilityRegistry:
			options.capabilityRegistry ?? new CapabilityRegistry(await CapabilityPublicIdentity.load(agentDir)),
		mcpTransportFactory: options.mcpTransportFactory,
		mcpAuthProvider: options.mcpAuthProvider,
		mcpAuthManagerOptions,
		sandboxProviders: options.sandboxProviders,
		diagnostics,
	};
}

/**
 * Create an AgentSession from previously created services.
 *
 * This keeps session creation separate from service creation so callers can
 * resolve model, thinking, tools, and other session inputs against the target
 * cwd before constructing the session.
 */
export async function createAgentSessionFromServices(
	options: CreateAgentSessionFromServicesOptions,
): Promise<CreateAgentSessionResult> {
	return createAgentSession({
		cwd: options.services.cwd,
		agentDir: options.services.agentDir,
		modelRuntime: options.services.modelRuntime,
		modelBroker: options.services.modelBroker,
		modelBrokerConfigRevision: options.services.modelBrokerConfigRevision,
		runtimeComposition: options.services.runtimeComposition,
		settingsManager: options.services.settingsManager,
		resourceLoader: options.services.resourceLoader,
		capabilityRegistry: options.services.capabilityRegistry,
		mcpTransportFactory: options.services.mcpTransportFactory,
		mcpAuthProvider: options.services.mcpAuthProvider,
		mcpAuthManagerOptions: options.services.mcpAuthManagerOptions,
		sandboxProviders: options.sandboxProviders ?? options.services.sandboxProviders,
		sessionManager: options.sessionManager,
		model: options.model,
		modelRoute: options.modelRoute,
		modelRole: options.modelRole,
		policyProfile: options.policyProfile,
		thinkingLevel: options.thinkingLevel,
		scopedModels: options.scopedModels,
		tools: options.tools,
		excludeTools: options.excludeTools,
		noTools: options.noTools,
		customTools: options.customTools,
		sessionStartEvent: options.sessionStartEvent,
	});
}
