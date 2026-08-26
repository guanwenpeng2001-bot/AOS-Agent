import type {
	AgentHarness,
	Session,
	ToolGateway,
} from "@aos-agent/agent-core";
import type { Models } from "@aos-agent/ai";
import type { CapabilityRegistry } from "./capability-registry.ts";
import type {
	ExternalAgentAdapterRegistry,
	ExternalAgentAdapterRegistryView,
} from "./external-agent-registry.ts";
import type { TrustedSchedulerCompositionOptions } from "./foundation-control-plane.ts";
import type { MCPAuthManagerOptions } from "./mcp-auth-manager.ts";
import type { MCPAuthProviderResolver, MCPTransportFactory } from "./mcp-types.ts";
import type { ModelBroker } from "./model-broker.ts";
import type { SandboxProvider } from "./sandbox.ts";
import type { SessionManager } from "./session-manager.ts";
import type { TrustedSubagentCompositionOptionsV1 } from "./subagent-composition.ts";
import type { TaskCredentialProvider } from "./task-credential-provider.ts";
import {
	WorkerSandboxProviderV1,
	type WorkerSandboxProfileV1,
	type WorkerSandboxProviderOptionsV1,
} from "./worker-sandbox-provider.ts";

export type TrustedWorkerSandboxProviderOptions = Omit<WorkerSandboxProviderOptionsV1, "profile"> & {
	readonly profile: WorkerSandboxProfileV1;
};

const trustedWorkerSandboxBrand: unique symbol = Symbol("trustedWorkerSandbox");

export interface TrustedWorkerSandboxComposition {
	readonly provider: WorkerSandboxProviderV1;
	readonly [trustedWorkerSandboxBrand]: true;
}

export type TrustedWorkerSandboxFactory = (
	context: AgentRuntimeCompositionContext,
) => TrustedWorkerSandboxComposition;

/** Construct a Worker provider only from trusted programmatic composition. */
export function createTrustedWorkerSandboxComposition(
	options: TrustedWorkerSandboxProviderOptions,
): TrustedWorkerSandboxComposition {
	return Object.freeze({
		provider: new WorkerSandboxProviderV1(options),
		[trustedWorkerSandboxBrand]: true as const,
	});
}

function requireTrustedWorkerSandboxProvider(
	composition: TrustedWorkerSandboxComposition,
): WorkerSandboxProviderV1 {
	if (composition[trustedWorkerSandboxBrand] !== true || !(composition.provider instanceof WorkerSandboxProviderV1)) {
		throw new TypeError("Trusted Worker composition is invalid");
	}
	return composition.provider;
}

/** Canonical, session-scoped inputs available only while trusted Host composition runs. */
export interface AgentRuntimeCompositionContext {
	readonly session: Session;
	readonly harness: AgentHarness;
	readonly sessionId: string;
	readonly models: Models;
	readonly modelBroker?: ModelBroker;
	readonly capabilityRegistry?: CapabilityRegistry;
	readonly mcpTransportFactory?: MCPTransportFactory;
	readonly mcpAuthProvider?: MCPAuthProviderResolver;
	readonly mcpAuthManagerOptions?: MCPAuthManagerOptions;
	readonly sandboxProviders?: ReadonlyMap<string, SandboxProvider> | ReadonlyArray<SandboxProvider>;
}

export type TrustedToolGatewayFactory = (context: AgentRuntimeCompositionContext) => ToolGateway;
export type TrustedSubagentCompositionFactory = (
	context: AgentRuntimeCompositionContext,
) => TrustedSubagentCompositionOptionsV1;
export type TrustedSchedulerCompositionFactory = (
	context: AgentRuntimeCompositionContext,
) => TrustedSchedulerRuntimeOptions;
export type TrustedSchedulerRuntimeOptions = Omit<TrustedSchedulerCompositionOptions, "runLifecycleSession">;
export type TrustedExternalAgentRegistryFactory = (
	context: AgentRuntimeCompositionContext,
) => ExternalAgentAdapterRegistry;
export type TrustedTaskCredentialProviderFactory = (
	context: AgentRuntimeCompositionContext,
) => TaskCredentialProvider;

/** Trusted optional providers accepted by the public composition root. */
export interface AgentRuntimeCompositionOptions {
	readonly toolGateway?: TrustedToolGatewayFactory;
	readonly trustedWorkerSandboxFactory?: TrustedWorkerSandboxFactory;
	readonly subagents?: TrustedSubagentCompositionFactory;
	readonly scheduler?: TrustedSchedulerCompositionFactory;
	readonly externalAgentRegistry?: TrustedExternalAgentRegistryFactory;
	readonly taskCredentialProvider?: TrustedTaskCredentialProviderFactory;
	readonly taskCredentialPolicyMaxTtlMs?: number;
}

/**
 * Immutable authority graph for one canonical Session/Harness pair.
 *
 * Optional authorities are absent unless trusted Host code supplied them to
 * the factory. Config, prompts, and RPC have no path to mutate this object.
 */
export interface AgentRuntimeComposition extends AgentRuntimeCompositionContext {
	readonly factory: AgentRuntimeCompositionFactory;
	readonly toolGateway?: ToolGateway;
	readonly workerSandboxProvider?: WorkerSandboxProviderV1;
	readonly subagents?: TrustedSubagentCompositionOptionsV1;
	readonly scheduler?: TrustedSchedulerRuntimeOptions;
	readonly externalAgentRegistry?: ExternalAgentAdapterRegistryView;
	readonly taskCredentialProvider?: TaskCredentialProvider;
	readonly taskCredentialPolicyMaxTtlMs?: number;
}

const agentRuntimeCompositionFactoryBrand: unique symbol = Symbol("agentRuntimeCompositionFactory");

/** Immutable trusted factory reused to derive every runtime candidate. */
export interface AgentRuntimeCompositionFactory {
	readonly [agentRuntimeCompositionFactoryBrand]: true;
	create(context: AgentRuntimeCompositionContext): AgentRuntimeComposition;
}

interface InternalAgentRuntimeCompositionOptions extends AgentRuntimeCompositionOptions {
	readonly workerSandboxProvider?: WorkerSandboxProviderV1;
	readonly subagentOptions?: TrustedSubagentCompositionOptionsV1;
	readonly schedulerOptions?: TrustedSchedulerCompositionOptions;
	readonly externalAgentRegistryInstance?: ExternalAgentAdapterRegistry;
	readonly taskCredentialProviderInstance?: TaskCredentialProvider;
}

function assertCanonicalProviders(
	context: AgentRuntimeCompositionContext,
	toolGateway: ToolGateway | undefined,
	subagents: TrustedSubagentCompositionOptionsV1 | undefined,
	scheduler: TrustedSchedulerRuntimeOptions | undefined,
): void {
	if (subagents !== undefined) {
		if (subagents.session !== context.session) {
			throw new TypeError("Trusted Subagent composition must use the canonical Session");
		}
		if (toolGateway !== undefined && subagents.toolGateway !== toolGateway) {
			throw new TypeError("Trusted Subagent composition must use the canonical Tool Gateway");
		}
	}
	if (scheduler !== undefined) {
		if (scheduler.sourceSession !== context.session) {
			throw new TypeError("Trusted Scheduler composition must use the canonical source Session");
		}
	}
}

function withoutPhysicalScheduler(
	options: TrustedSchedulerCompositionOptions | TrustedSchedulerRuntimeOptions,
): TrustedSchedulerRuntimeOptions {
	if (!("runLifecycleSession" in options)) return Object.freeze({ ...options });
	const { runLifecycleSession: _runLifecycleSession, ...runtimeOptions } = options;
	return Object.freeze(runtimeOptions);
}

function createPublicContext(context: AgentRuntimeCompositionContext): AgentRuntimeCompositionContext {
	return Object.freeze({
		session: context.session,
		harness: context.harness,
		sessionId: context.sessionId,
		models: context.models,
		...(context.modelBroker === undefined ? {} : { modelBroker: context.modelBroker }),
		...(context.capabilityRegistry === undefined ? {} : { capabilityRegistry: context.capabilityRegistry }),
		...(context.mcpTransportFactory === undefined ? {} : { mcpTransportFactory: context.mcpTransportFactory }),
		...(context.mcpAuthProvider === undefined ? {} : { mcpAuthProvider: context.mcpAuthProvider }),
		...(context.mcpAuthManagerOptions === undefined ? {} : { mcpAuthManagerOptions: context.mcpAuthManagerOptions }),
		...(context.sandboxProviders === undefined ? {} : { sandboxProviders: context.sandboxProviders }),
	});
}

function createFactory(options: InternalAgentRuntimeCompositionOptions): AgentRuntimeCompositionFactory {
	if (options.workerSandboxProvider !== undefined && options.trustedWorkerSandboxFactory !== undefined) {
		throw new TypeError("Trusted Worker providers must have one composition source");
	}
	const snapshot = Object.freeze({ ...options });
	const materializedAuthorities = new WeakSet<object>();
	const requireFresh = <T extends object>(authority: T | undefined, name: string): T | undefined => {
		if (authority === undefined) return undefined;
		if (materializedAuthorities.has(authority)) {
			throw new TypeError(`${name} must be created fresh for each Session`);
		}
		materializedAuthorities.add(authority);
		return authority;
	};
	let factory: AgentRuntimeCompositionFactory;
	factory = Object.freeze({
		[agentRuntimeCompositionFactoryBrand]: true as const,
		create(context: AgentRuntimeCompositionContext): AgentRuntimeComposition {
			const publicContext = createPublicContext(context);
			const workerComposition = snapshot.trustedWorkerSandboxFactory?.(publicContext);
			const workerSandboxProvider = requireFresh(
				snapshot.workerSandboxProvider ?? (
					workerComposition === undefined
						? undefined
						: requireTrustedWorkerSandboxProvider(workerComposition)
				),
				"Trusted Worker provider",
			);
			const explicitToolGateway = snapshot.toolGateway?.(publicContext);
			const subagents = requireFresh(
				snapshot.subagents?.(publicContext) ?? snapshot.subagentOptions,
				"Trusted Subagent composition",
			);
			const schedulerSource = requireFresh(
				snapshot.scheduler?.(publicContext) ?? snapshot.schedulerOptions,
				"Trusted Scheduler composition",
			);
			const scheduler = schedulerSource === undefined ? undefined : withoutPhysicalScheduler(schedulerSource);
			const toolGateway = explicitToolGateway ?? subagents?.toolGateway;
			requireFresh(toolGateway, "Trusted Tool Gateway");
			const mutableExternalAgentRegistry = requireFresh(
				snapshot.externalAgentRegistry?.(publicContext) ?? snapshot.externalAgentRegistryInstance,
				"Trusted External Agent registry",
			);
			const externalAgentRegistry = mutableExternalAgentRegistry?.seal();
			const taskCredentialProvider = requireFresh(
				snapshot.taskCredentialProvider?.(publicContext) ?? snapshot.taskCredentialProviderInstance,
				"Trusted Task Credential provider",
			);
			assertCanonicalProviders(publicContext, toolGateway, subagents, scheduler);
			return Object.freeze({
				...publicContext,
				factory,
				...(toolGateway === undefined ? {} : { toolGateway }),
				...(workerSandboxProvider === undefined ? {} : { workerSandboxProvider }),
				...(subagents === undefined ? {} : { subagents }),
				...(scheduler === undefined ? {} : { scheduler }),
				...(externalAgentRegistry === undefined
					? {}
					: { externalAgentRegistry }),
				...(taskCredentialProvider === undefined
					? {}
					: { taskCredentialProvider }),
				...(snapshot.taskCredentialPolicyMaxTtlMs === undefined
					? {}
					: { taskCredentialPolicyMaxTtlMs: snapshot.taskCredentialPolicyMaxTtlMs }),
			});
		},
	});
	return factory;
}

const defaultAgentRuntimeCompositionFactory = createFactory({});

/** Build an immutable trusted factory. Every optional provider is default-off. */
export function createAgentRuntimeCompositionFactory(
	options: AgentRuntimeCompositionOptions = {},
): AgentRuntimeCompositionFactory {
	if (
		options.toolGateway === undefined &&
		options.trustedWorkerSandboxFactory === undefined &&
		options.subagents === undefined &&
		options.scheduler === undefined &&
		options.externalAgentRegistry === undefined &&
		options.taskCredentialProvider === undefined &&
		options.taskCredentialPolicyMaxTtlMs === undefined
	) {
		return defaultAgentRuntimeCompositionFactory;
	}
	return createFactory(options);
}

/** @internal Bind the physical Session store only at the package-private control-plane boundary. */
export function bindAgentRuntimeSchedulerComposition(
	composition: AgentRuntimeComposition,
	runLifecycleSession: SessionManager,
): TrustedSchedulerCompositionOptions | undefined {
	if (composition.scheduler === undefined) return undefined;
	return Object.freeze({
		...composition.scheduler,
		runLifecycleSession,
	});
}

/** @internal Compatibility adapter; production roots use the branded public options. */
export function createAgentRuntimeCompositionFactoryFromTrustedProviders(
	options: InternalAgentRuntimeCompositionOptions,
): AgentRuntimeCompositionFactory {
	return createFactory(options);
}

/** Materialize one immutable composition for an already-created canonical Harness. */
export function materializeAgentRuntimeComposition(
	factory: AgentRuntimeCompositionFactory,
	context: AgentRuntimeCompositionContext,
): AgentRuntimeComposition {
	if (factory[agentRuntimeCompositionFactoryBrand] !== true || typeof factory.create !== "function") {
		throw new TypeError("Agent runtime composition factory is invalid");
	}
	const composition = factory.create(context);
	if (
		!Object.isFrozen(composition) ||
		composition.session !== context.session ||
		composition.harness !== context.harness ||
		composition.sessionId !== context.sessionId ||
		composition.models !== context.models ||
		composition.factory !== factory
	) {
		throw new TypeError("Agent runtime composition is invalid");
	}
	return composition;
}
