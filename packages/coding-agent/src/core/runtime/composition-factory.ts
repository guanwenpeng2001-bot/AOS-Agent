import type { AgentHarness, Session, ToolGateway, ToolGatewayProvider } from "@aos-agent/agent-core";
import { createFoundationToolGateway, FoundationError, fingerprintFoundationValue, Result } from "@aos-agent/agent-core";
import type { Models } from "@aos-agent/ai";
import type { CapabilityRegistry } from "../policy/capability-registry.ts";
import { type ConnectorRetryPolicy, DEFAULT_CONNECTOR_RETRY_POLICY } from "../connector/retry-circuit.ts";
import type { ExternalConnectorRegistry } from "../connector/registry.ts";
import { waitForExternalConnectorRegistryInitialization } from "../connector/registry-initialization.ts";
import {
	bindExternalConnectorCredentialRegistry,
	createExternalConnectorCredentialBinding,
	type ExternalConnectorCredentialIssueContextResolver,
} from "../connector/credential-binding.ts";
import type { ExternalConnectorCredentialRuntime } from "../connector/durable-connector.ts";
import type { ExternalConnectorModelGateway } from "../connector/model-gateway.ts";
import { PROVIDER_CLASS } from "../connector/provider-class.ts";
import {
	assertExternalConnectorCapabilityWithinTarget,
	type ExternalConnectorResolvedTarget,
	type ExternalConnectorTargetConfig,
	isTrustedExternalConnectorTargetConfig,
} from "../connector/target-config.ts";
import type { ExternalToolGatewayPolicyAuthority } from "../connector/tool-gateway.ts";
import {
	bindCanonicalExternalToolGatewayPolicy,
	createCanonicalExternalToolGateway,
} from "../connector/tool-gateway.ts";
import type { SchedulerCompositionOptions } from "./foundation-control-plane.ts";
import type { MCPAuthManagerOptions } from "../policy/mcp-auth-manager.ts";
import type { MCPAuthProviderResolver, MCPTransportFactory } from "./mcp-types.ts";
import type { ModelBroker } from "./model-broker.ts";
import {
	DEFAULT_RUNTIME_LIMITS,
	type RuntimeLimitsSnapshot,
	type RuntimeLimitsSource,
	resolveRuntimeLimitsSource,
} from "./limits.ts";
import type { SandboxProvider } from "../policy/sandbox.ts";
import { bindSchedulerInProcessTaskExecutor } from "../scheduler/dispatch.ts";
import {
	createSchedulerExecutorRuntimeSnapshot,
	SCHEDULER_IN_PROCESS_PROVIDER_ID,
	schedulerBindingRequirementDigest,
} from "../scheduler/executors.ts";
import { SchedulerSelectionReservationStore } from "../scheduler/selection-reservations.ts";
import type { SessionManager } from "../session/manager.ts";
import type { SubagentCompositionOptions } from "../subagent/composition.ts";
import type { TaskCredentialProvider } from "../policy/task-credential-provider.ts";
import {
	type WorkerSandboxProfile,
	type WorkerSandboxProviderOptions,
	WorkerSandboxProvider,
} from "../worker/sandbox-provider.ts";

/** Host-only inputs for constructing a branded Worker sandbox composition. */
export type WorkerSandboxCompositionOptions = Omit<WorkerSandboxProviderOptions, "profile"> & {
	readonly profile: WorkerSandboxProfile;
};

const trustedWorkerSandboxBrand: unique symbol = Symbol("trustedWorkerSandbox");

/** Branded Worker sandbox authority created only by trusted programmatic composition. */
export interface WorkerSandboxComposition {
	readonly provider: WorkerSandboxProvider;
	readonly [trustedWorkerSandboxBrand]: true;
}

/** Trusted Host factory for a fresh Worker sandbox authority in each Session. */
export type WorkerSandboxFactory = (context: AgentRuntimeCompositionContext) => WorkerSandboxComposition;

/** Construct a Worker provider only from trusted programmatic composition. */
export function createWorkerSandboxComposition(
	options: WorkerSandboxCompositionOptions,
): WorkerSandboxComposition {
	return Object.freeze({
		provider: new WorkerSandboxProvider(options),
		[trustedWorkerSandboxBrand]: true as const,
	});
}

function requireTrustedWorkerSandboxProvider(composition: WorkerSandboxComposition): WorkerSandboxProvider {
	if (composition[trustedWorkerSandboxBrand] !== true || !(composition.provider instanceof WorkerSandboxProvider)) {
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

/** Trusted Host factory for the canonical Session Tool Gateway. */
export type ToolGatewayFactory = (context: AgentRuntimeCompositionContext) => ToolGateway;
/** Provider catalog supplied only by trusted Host composition. */
export interface ToolGatewayCatalog {
	readonly gatewayId: string;
	readonly builtinLocalProviders: readonly ToolGatewayProvider[];
	readonly mcpProviders: readonly ToolGatewayProvider[];
	readonly sandboxProviders: readonly ToolGatewayProvider[];
}
/** Trusted Host factory for a fresh Tool Gateway provider catalog. */
export type ToolGatewayCatalogFactory = (context: AgentRuntimeCompositionContext) => ToolGatewayCatalog;
/** Trusted Host factory for canonical Subagent composition inputs. */
export type SubagentCompositionFactory = (
	context: AgentRuntimeCompositionContext,
) => SubagentCompositionOptions;
/** Trusted Host factory for canonical Scheduler composition inputs. */
export type SchedulerCompositionFactory = (
	context: AgentRuntimeCompositionContext,
	/** Canonical Session-backed exact-selection and capacity authority. */
	selectionReservations: SchedulerSelectionReservationStore,
) => SchedulerRuntimeOptions;
/** Scheduler inputs retained inside the trusted runtime composition boundary. */
export type SchedulerRuntimeOptions = Omit<SchedulerCompositionOptions, "runLifecycleSession">;
/** Trusted Host authority shared by External Connector readiness and execution. */
export interface ExternalConnectorProductAuthority {
	/** Reloadable trusted source sampled once for each new Connector Attempt. */
	readonly runtimeLimitsSource: RuntimeLimitsSource;
	/** Frozen source identity used by this composition generation. */
	readonly runtimeLimits: RuntimeLimitsSnapshot;
}
/** Trusted Host factory for the Session-scoped External Connector registry. */
export type ExternalConnectorRegistryFactory = (
	context: AgentRuntimeCompositionContext,
	/** The same canonical Foundation Tool Gateway exposed to every executor in this Session. */
	toolGateway: ToolGateway | undefined,
	/** Explicit target resolved from trusted global/managed definitions plus project/Role narrowing. */
	target: ExternalConnectorResolvedTarget | undefined,
	/** Centralized limits shared by readiness, Scheduler retry, and Connector execution. */
	authority: ExternalConnectorProductAuthority,
	/** Deferred Session credential authority. Readiness and probes cannot issue through it. */
	credential: ExternalConnectorCredentialRuntime | undefined,
) => ExternalConnectorRegistry;
/** Trusted Host factory for the Session-scoped Task Credential provider. */
export type TaskCredentialProviderFactory = (context: AgentRuntimeCompositionContext) => TaskCredentialProvider;
/** Trusted Session-specific resolver for canonical external credential scope and lifecycle facts. */
export type ExternalConnectorCredentialIssueContextFactory = (
	context: AgentRuntimeCompositionContext,
	target: ExternalConnectorResolvedTarget,
) => ExternalConnectorCredentialIssueContextResolver | undefined;
export type ExternalConnectorModelGatewayFactory = (
	context: AgentRuntimeCompositionContext,
	target: ExternalConnectorResolvedTarget,
) => ExternalConnectorModelGateway | undefined;

/** Trusted optional providers accepted by the public composition root. */
export interface AgentRuntimeCompositionOptions {
	readonly toolGateway?: ToolGatewayFactory;
	/** Composition-owned provider catalog validated before runtime readiness. */
	readonly toolGatewayCatalog?: ToolGatewayCatalogFactory;
	readonly trustedWorkerSandboxFactory?: WorkerSandboxFactory;
	readonly subagents?: SubagentCompositionFactory;
	readonly scheduler?: SchedulerCompositionFactory;
	/** Immutable target catalog. A catalog without explicit selection remains off. */
	readonly externalConnectorTargetConfig?: ExternalConnectorTargetConfig;
	readonly externalConnectorRegistry?: ExternalConnectorRegistryFactory;
	/** Trusted canonical scope/context resolver; accountReference alone never creates scopes. */
	readonly externalConnectorCredentialIssueContext?: ExternalConnectorCredentialIssueContextFactory;
	readonly externalConnectorModelGateway?: ExternalConnectorModelGatewayFactory;
	/** Centralized reloadable limits; omission uses the finite product defaults. */
	readonly runtimeLimits?: RuntimeLimitsSource;
	readonly taskCredentialProvider?: TaskCredentialProviderFactory;
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
	readonly workerSandboxProvider?: WorkerSandboxProvider;
	readonly subagents?: SubagentCompositionOptions;
	readonly scheduler?: SchedulerRuntimeOptions;
	readonly externalConnectorTargetConfig?: ExternalConnectorTargetConfig;
	readonly externalConnectorTarget?: ExternalConnectorResolvedTarget;
	readonly externalConnectorRegistry?: ExternalConnectorRegistry;
	readonly runtimeLimits: RuntimeLimitsSnapshot;
	readonly schedulerSelectionReservations?: SchedulerSelectionReservationStore;
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
	readonly workerSandboxProvider?: WorkerSandboxProvider;
	readonly subagentOptions?: SubagentCompositionOptions;
	readonly schedulerOptions?: SchedulerCompositionOptions;
	readonly externalConnectorRegistryInstance?: ExternalConnectorRegistry;
	readonly taskCredentialProviderInstance?: TaskCredentialProvider;
}

function assertCanonicalProviders(
	context: AgentRuntimeCompositionContext,
	toolGateway: ToolGateway | undefined,
	subagents: SubagentCompositionOptions | undefined,
	scheduler: SchedulerRuntimeOptions | undefined,
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
	options: SchedulerCompositionOptions | SchedulerRuntimeOptions,
): SchedulerRuntimeOptions {
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

function connectorRetryPolicy(runtimeLimits: RuntimeLimitsSnapshot): ConnectorRetryPolicy {
	const totalRetryTimeMs = runtimeLimits.values.retryBudgetMs;
	const maxDelayMs = Math.min(DEFAULT_CONNECTOR_RETRY_POLICY.maxDelayMs, totalRetryTimeMs);
	return Object.freeze({
		maxAttempts: runtimeLimits.values.maxRetries + 1,
		baseDelayMs: Math.min(DEFAULT_CONNECTOR_RETRY_POLICY.baseDelayMs, maxDelayMs),
		maxDelayMs,
		totalRetryTimeMs,
		jitterPermille: DEFAULT_CONNECTOR_RETRY_POLICY.jitterPermille,
		failureThreshold: Math.min(DEFAULT_CONNECTOR_RETRY_POLICY.failureThreshold, runtimeLimits.values.maxRetries + 1),
		openDurationMs: Math.min(DEFAULT_CONNECTOR_RETRY_POLICY.openDurationMs, maxDelayMs),
		halfOpenProbeTimeoutMs: Math.min(DEFAULT_CONNECTOR_RETRY_POLICY.halfOpenProbeTimeoutMs, maxDelayMs),
	});
}

async function registerSelectedExternalConnector(options: {
	readonly registry: ExternalConnectorRegistry;
	readonly scheduler: SchedulerRuntimeOptions;
	readonly targetConfig: ExternalConnectorTargetConfig;
	readonly target: ExternalConnectorResolvedTarget;
	readonly runtimeLimits: RuntimeLimitsSnapshot;
}): Promise<void> {
	const descriptors = options.registry.list().filter(({ providerId }) => providerId === options.target.providerId);
	const readinessSnapshots = options.registry
		.readinessSnapshots()
		.filter(({ providerId }) => providerId === options.target.providerId);
	if (descriptors.length !== 1 || readinessSnapshots.length !== 1) {
		throw new FoundationError(
			"scheduler_executor_unavailable",
			"Selected External Connector must have one exact descriptor and readiness snapshot",
		);
	}
	const descriptor = descriptors[0]!;
	const readiness = readinessSnapshots[0]!;
	// wire/ledger field name; local alias below
	const readinessStatus = readiness.status;
	const snapshotState = readiness.state;
	if (
		descriptor.providerClass !== PROVIDER_CLASS.externalConnector ||
		readinessStatus !== "ready" ||
		snapshotState !== "current" ||
		readiness.capability.revision !== descriptor.revision ||
		readiness.capability.digest.value !== descriptor.capabilitySnapshotDigest.value
	) {
		throw new FoundationError(
			"scheduler_executor_unavailable",
			"Selected External Connector descriptor and readiness identity are inconsistent",
		);
	}
	// wire/ledger field name; local alias below
	const capabilityDigest = descriptor.capabilitySnapshotDigest;
	const selection = {
		providerId: descriptor.providerId,
		revision: descriptor.revision,
		capabilitySnapshotDigest: capabilityDigest,
	};
	const selected = await options.registry.select(selection);
	if (!selected.ok) throw selected.error;
	assertExternalConnectorCapabilityWithinTarget(options.target, selected.value.capabilitySnapshot);
	if (
		selected.value.connector.providerId !== options.target.providerId ||
		selected.value.connector.providerClass !== PROVIDER_CLASS.externalConnector ||
		selected.value.capabilitySnapshot.digest.value !== readiness.capability.digest.value
	) {
		throw new FoundationError(
			"scheduler_executor_unavailable",
			"Selected External Connector execution identity drifted before Scheduler registration",
		);
	}
	const bindingRequirementDigest = schedulerBindingRequirementDigest(options.scheduler.binding);
	if (!bindingRequirementDigest.ok) throw bindingRequirementDigest.error;
	const policyRevisionFingerprint = options.scheduler.binding.policyRevision.fingerprint;
	if (policyRevisionFingerprint === undefined) {
		throw new FoundationError(
			"binding_required_fact",
			"Selected External Connector registration requires a fingerprinted policy revision",
		);
	}
	const runtimeSnapshot = createSchedulerExecutorRuntimeSnapshot({
		schemaVersion: 1,
		capabilitySnapshot: selected.value.capabilitySnapshot,
		configRevision: fingerprintFoundationValue({
			targetConfigRevision: options.targetConfig.configRevision,
			targetSelectionRevision: options.target.selectionRevision,
			targetId: options.target.targetId,
			providerId: options.target.providerId,
			readinessSnapshotDigest: readiness.snapshotDigest,
			readinessConfiguration: readiness.configuration,
			readinessIdentity: readiness.identity,
			runtimeLimitsDigest: options.runtimeLimits.digest,
		}),
		bindingRequirementDigests: [bindingRequirementDigest.value],
		toolSelectionDigests: [options.scheduler.binding.mcpSelection.digest],
		policyRevisionDigests: [policyRevisionFingerprint],
		reviewRevisionDigests: [],
		credentialTargetRefs: options.target.accountReference === undefined ? [] : [options.target.targetId],
		sandboxTargetRefs: [],
		observedAt: readiness.observedAt,
		expiresAt: readiness.expiresAt,
	});
	if (!runtimeSnapshot.ok) throw runtimeSnapshot.error;
	const capabilities = await selected.value.connector.capabilities();
	const registered = await options.scheduler.registry.register({
		entry: {
			schemaVersion: 1,
			descriptor: {
				schemaVersion: 1,
				providerId: options.target.providerId,
				providerClass: PROVIDER_CLASS.externalConnector,
			},
			capabilities,
			costClass: "remote_paid",
			registeredAt: readiness.observedAt,
		},
		provider: selected.value.connector,
		trusted: true,
		latencyMs: 0,
		maxConcurrency: options.runtimeLimits.values.maxConcurrency,
		runtimeSnapshot: runtimeSnapshot.value,
	});
	if (!registered.ok) throw registered.error;
	const readinessAfterRegistration = options.registry
		.readinessSnapshots()
		.filter(({ providerId }) => providerId === options.target.providerId);
	const reselected = await options.registry.select(selection);
	if (
		readinessAfterRegistration.length !== 1 ||
		readinessAfterRegistration[0]!.snapshotDigest.value !== readiness.snapshotDigest.value ||
		!reselected.ok ||
		reselected.value.capabilitySnapshot.digest.value !== selected.value.capabilitySnapshot.digest.value
	) {
		throw new FoundationError(
			"scheduler_executor_unavailable",
			"Selected External Connector identity drifted during Scheduler registration",
		);
	}
}

function createFactory(options: InternalAgentRuntimeCompositionOptions): AgentRuntimeCompositionFactory {
	if (options.toolGateway !== undefined && options.toolGatewayCatalog !== undefined) {
		throw new TypeError("Trusted Tool Gateway must have one composition source");
	}
	if (options.workerSandboxProvider !== undefined && options.trustedWorkerSandboxFactory !== undefined) {
		throw new TypeError("Trusted Worker providers must have one composition source");
	}
	if (
		options.externalConnectorTargetConfig !== undefined &&
		!isTrustedExternalConnectorTargetConfig(options.externalConnectorTargetConfig)
	) {
		throw new TypeError("External Connector target config must be resolved by the trusted Host");
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
			const runtimeLimitsSource = snapshot.runtimeLimits ?? DEFAULT_RUNTIME_LIMITS;
			const runtimeLimits = resolveRuntimeLimitsSource(runtimeLimitsSource);
			const workerComposition = snapshot.trustedWorkerSandboxFactory?.(publicContext);
			const workerSandboxProvider = requireFresh(
				snapshot.workerSandboxProvider ??
					(workerComposition === undefined ? undefined : requireTrustedWorkerSandboxProvider(workerComposition)),
				"Trusted Worker provider",
			);
			const composedCatalog = snapshot.toolGatewayCatalog?.(publicContext);
			let explicitToolGateway = snapshot.toolGateway?.(publicContext);
			if (composedCatalog !== undefined) {
				if (
					composedCatalog.gatewayId.length === 0 ||
					composedCatalog.builtinLocalProviders.some((provider) => provider.kind !== "local") ||
					composedCatalog.mcpProviders.some((provider) => provider.kind !== "mcp") ||
					composedCatalog.sandboxProviders.some((provider) => provider.kind !== "sandbox")
				) {
					throw new TypeError("Trusted Tool Gateway provider catalog is invalid");
				}
				const providers = [
					...composedCatalog.builtinLocalProviders,
					...composedCatalog.mcpProviders,
					...composedCatalog.sandboxProviders,
				];
				for (const provider of providers) {
					requireFresh(provider, "Trusted Tool Gateway provider");
				}
				explicitToolGateway = createFoundationToolGateway({
					gatewayId: composedCatalog.gatewayId,
					providers,
				});
			}
			const subagents = requireFresh(
				snapshot.subagents?.(publicContext) ?? snapshot.subagentOptions,
				"Trusted Subagent composition",
			);
			const schedulerWriter = subagents?.writer;
			if (schedulerWriter !== undefined && schedulerWriter.session !== publicContext.session) {
				throw new TypeError("Trusted Subagent writer must belong to the canonical Session");
			}
			const ownerId = schedulerWriter?.ownerId ?? `scheduler:${publicContext.sessionId}`;
			const schedulerSelectionReservations =
				snapshot.scheduler === undefined
					? undefined
					: new SchedulerSelectionReservationStore(publicContext.session, {
							ownerId,
							...(schedulerWriter === undefined ? {} : { writer: schedulerWriter }),
							maxBacklog: runtimeLimits.values.maxBacklog,
						});
			const schedulerSource = requireFresh(
				(snapshot.scheduler === undefined || schedulerSelectionReservations === undefined
					? undefined
					: snapshot.scheduler(publicContext, schedulerSelectionReservations)) ?? snapshot.schedulerOptions,
				"Trusted Scheduler composition",
			);
			let scheduler = schedulerSource === undefined ? undefined : withoutPhysicalScheduler(schedulerSource);
			if (scheduler?.nativeAgentPlanner !== undefined && schedulerWriter === undefined) {
				throw new TypeError("Trusted Scheduler Native Agent planning requires a canonical Subagent writer");
			}
			if (scheduler !== undefined && schedulerSelectionReservations !== undefined) {
				if (scheduler.ownerId !== schedulerSelectionReservations.ownerId) {
					throw new TypeError("Trusted Scheduler composition must use the canonical Scheduler owner");
				}
				if (
					scheduler.selectionReservationStore !== undefined &&
					scheduler.selectionReservationStore !== schedulerSelectionReservations
				) {
					throw new TypeError("Trusted Scheduler composition must use the canonical selection reservation store");
				}
				if (scheduler.writer !== undefined && scheduler.writer !== schedulerWriter) {
					throw new TypeError("Trusted Scheduler composition must use the canonical Subagent writer");
				}
				scheduler = Object.freeze({
					...scheduler,
					selectionReservationStore: schedulerSelectionReservations,
					...(schedulerWriter === undefined ? {} : { writer: schedulerWriter }),
				});
			}
			if (
				snapshot.scheduler !== undefined &&
				scheduler !== undefined &&
				!scheduler.registry.durableSelectionsEnabled()
			) {
				throw new TypeError("Trusted Scheduler composition must use the canonical selection reservation store");
			}
			if (scheduler !== undefined) {
				const schedulerForInitialization = scheduler;
				scheduler = Object.freeze({
					...schedulerForInitialization,
					initializeBeforeStart: async () => {
						await schedulerForInitialization.initializeBeforeStart?.();
						if (schedulerForInitialization.registry.get(SCHEDULER_IN_PROCESS_PROVIDER_ID) !== undefined) return;
						const registered = await bindSchedulerInProcessTaskExecutor(schedulerForInitialization.registry, {
							sessionId: publicContext.sessionId,
							allowFailClosedRegistration: true,
							hostAttemptRunner: async () =>
								Result.err(
									new FoundationError(
										"scheduler_executor_unavailable",
										"The in-process Scheduler requires a trusted Host attempt runner.",
									),
								),
							...(schedulerForInitialization.now === undefined ? {} : { now: schedulerForInitialization.now }),
						});
						if (!registered.ok) throw registered.error;
					},
				});
			}
			const underlyingToolGateway = explicitToolGateway ?? subagents?.toolGateway;
			requireFresh(underlyingToolGateway, "Trusted Tool Gateway");
			const toolGateway =
				underlyingToolGateway === undefined ? undefined : createCanonicalExternalToolGateway(underlyingToolGateway);
			const composedSubagents =
				subagents === undefined || toolGateway === undefined || subagents.toolGateway !== underlyingToolGateway
					? subagents
					: Object.freeze({ ...subagents, toolGateway });
			const externalConnectorTargetConfig = snapshot.externalConnectorTargetConfig;
			const externalConnectorTarget = externalConnectorTargetConfig?.selectedTarget;
			const credentialIssueContext =
				externalConnectorTarget === undefined
					? undefined
					: snapshot.externalConnectorCredentialIssueContext?.(publicContext, externalConnectorTarget);
			const externalConnectorModelGateway = externalConnectorTarget === undefined
				? undefined
				: snapshot.externalConnectorModelGateway?.(publicContext, externalConnectorTarget);
			const externalConnectorCredentialBinding =
				externalConnectorTarget === undefined || credentialIssueContext === undefined
					? undefined
					: createExternalConnectorCredentialBinding({
							target: externalConnectorTarget,
							resolveIssueContext: credentialIssueContext,
							...(externalConnectorModelGateway === undefined
								? {}
								: { modelGateway: externalConnectorModelGateway }),
						});
			if (scheduler !== undefined && externalConnectorTarget !== undefined) {
				scheduler = Object.freeze({
					...scheduler,
					connectorRetry: Object.freeze({
						providerId: externalConnectorTarget.providerId,
						targetId: externalConnectorTarget.targetId,
						policy: connectorRetryPolicy(runtimeLimits),
					}),
				});
			}
			const externalConnectorRegistry =
				externalConnectorTargetConfig !== undefined && externalConnectorTarget === undefined
					? undefined
					: requireFresh(
							snapshot.externalConnectorRegistry?.(
								publicContext,
								toolGateway,
								externalConnectorTarget,
								Object.freeze({ runtimeLimitsSource, runtimeLimits }),
								externalConnectorCredentialBinding?.runtime,
							) ?? snapshot.externalConnectorRegistryInstance,
							"Trusted External Connector registry",
						);
			if (externalConnectorRegistry !== undefined && externalConnectorCredentialBinding !== undefined) {
				bindExternalConnectorCredentialRegistry(externalConnectorRegistry, externalConnectorCredentialBinding);
			}
			if (scheduler !== undefined && externalConnectorTarget !== undefined) {
				if (externalConnectorRegistry === undefined || externalConnectorTargetConfig === undefined) {
					throw new FoundationError(
						"scheduler_executor_unavailable",
						"Selected External Connector requires its trusted registry before Scheduler start",
					);
				}
				const schedulerForInitialization = scheduler;
				scheduler = Object.freeze({
					...schedulerForInitialization,
					initializeBeforeStart: async () => {
						await schedulerForInitialization.initializeBeforeStart?.();
						await waitForExternalConnectorRegistryInitialization(externalConnectorRegistry);
						await registerSelectedExternalConnector({
							registry: externalConnectorRegistry,
							scheduler: schedulerForInitialization,
							targetConfig: externalConnectorTargetConfig,
							target: externalConnectorTarget,
							runtimeLimits,
						});
					},
				});
			}
			const taskCredentialProvider = requireFresh(
				snapshot.taskCredentialProvider?.(publicContext) ?? snapshot.taskCredentialProviderInstance,
				"Trusted Task Credential provider",
			);
			assertCanonicalProviders(publicContext, toolGateway, composedSubagents, scheduler);
			return Object.freeze({
				...publicContext,
				factory,
				...(toolGateway === undefined ? {} : { toolGateway }),
				...(workerSandboxProvider === undefined ? {} : { workerSandboxProvider }),
				...(composedSubagents === undefined ? {} : { subagents: composedSubagents }),
				...(scheduler === undefined ? {} : { scheduler }),
				...(externalConnectorTargetConfig === undefined ? {} : { externalConnectorTargetConfig }),
				...(externalConnectorTarget === undefined ? {} : { externalConnectorTarget }),
				...(externalConnectorRegistry === undefined ? {} : { externalConnectorRegistry }),
				runtimeLimits,
				...(schedulerSelectionReservations === undefined ? {} : { schedulerSelectionReservations }),
				...(taskCredentialProvider === undefined ? {} : { taskCredentialProvider }),
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
		options.toolGatewayCatalog === undefined &&
		options.trustedWorkerSandboxFactory === undefined &&
		options.subagents === undefined &&
		options.scheduler === undefined &&
		options.externalConnectorTargetConfig === undefined &&
		options.externalConnectorRegistry === undefined &&
		options.externalConnectorCredentialIssueContext === undefined &&
		options.externalConnectorModelGateway === undefined &&
		options.runtimeLimits === undefined &&
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
): SchedulerCompositionOptions | undefined {
	if (composition.scheduler === undefined) return undefined;
	return Object.freeze({
		...composition.scheduler,
		runLifecycleSession,
	});
}

/** @internal Bind the canonical policy authority after AgentSession creates its control plane. */
export function bindAgentRuntimeToolGatewayPolicy(
	composition: AgentRuntimeComposition,
	policy: ExternalToolGatewayPolicyAuthority,
): void {
	bindCanonicalExternalToolGatewayPolicy(composition.toolGateway, policy);
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
