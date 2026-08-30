import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import {
	canonicalFoundationJson,
	createConnectorCapabilitySnapshot,
	fingerprintFoundationValue,
	FoundationError,
	validateAgentBinding,
	validateBindingEpoch,
	validateDurableEvent,
	type AgentBinding,
	type AgentHarness,
	type FoundationEventEnvelope,
	type HarnessTool,
	type McpToolRoute,
	type Session,
	type SessionLedgerWriter,
	type TaskEnvelope,
	type ToolGatewayRequest,
	type ToolGatewayRoute,
} from "@aos-agent/agent-core";
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
} from "../policy/capability-registry.ts";
import {
	createMcpServerCapabilityCandidate,
	contentSummaryId,
	createMcpContentCapabilityCandidate,
	type CapabilitySettings,
	type McpContentCapabilityKind,
	type McpContentSummary,
} from "../policy/capability-settings.ts";
import {
	type CapabilityBindingInput,
	type ExecutionPolicyProfile,
	PolicyError,
	type PolicyApprovalRequest,
	type PolicyApprovalSource,
	type PolicyBinding,
	type PolicyDecision,
	type PolicyOperationRequest,
	type PolicyOperationSource,
	type PolicyReviewDecision,
	type PolicyReviewEvidence,
	type PolicyReviewerIdentity,
	type PublicPolicySummary,
	resolveTaskCredentialPreflight,
	taskCredentialPolicyResource,
	type TaskCredentialPreflightResult,
	type TaskCredentialSandboxPreflight,
	authorizePolicyOperation,
	createPolicyReviewEvidence,
	createWorkspaceIdentity,
	resolvePolicyReviewEvidence,
	resolveExecutionPolicyProfile,
	toPolicyBindingHandle,
	toPublicPolicySummary,
} from "../policy/execution.ts";
import {
	createExecutionPolicyLedger,
	POLICY_DECISION_CUSTOM_TYPE,
	type PolicyDecisionLedgerRecord,
} from "../policy/execution-ledger.ts";
import { classifyExternalToolPolicyOperation } from "../connector/tool-policy.ts";
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
} from "../policy/mcp-auth-manager.ts";
import type { MCPAuthManager, MCPAuthStartOptions, MCPAuthStartResult } from "../policy/mcp-auth-manager.ts";
import { MCPAuthError } from "../policy/mcp-auth.ts";
import type { MCPCredentialStatus } from "../policy/mcp-auth-storage.ts";
import {
	MCPContentError,
	mcpPromptId,
	mcpResourceId,
	type MCPGetPromptResult,
	type MCPReadResourceResult,
} from "./mcp-content.ts";
import { canonicalizeMCPServerUrl } from "../policy/mcp-auth-storage.ts";
import type { McpAttachmentBindingRefs } from "./mcp-attachment.ts";
import { mapMCPToolsToDefinitions, type MCPToolDefinitionResult } from "./mcp-tool-adapter.ts";
import type { ModelRuntime } from "./model-runtime.ts";
import type { ResourceLoader } from "./resource-loader.ts";
import type { SessionEntry, SessionManager } from "../session/manager.ts";
import type { SettingsManager } from "./settings-manager.ts";
import type {
	ExternalConnectorRegistry,
} from "../connector/registry.ts";
import type { SandboxHandle, SandboxProvider, SandboxSession } from "../policy/sandbox.ts";
import { SandboxSession as ConcreteSandboxSession } from "../policy/sandbox.ts";
import type { ToolDefinition, ExtensionRunner } from "../extensions/index.ts";
import { wrapToolDefinitions } from "../tools/tool-definition-wrapper.ts";
import type { BashOperations } from "../tools/bash.ts";
import { executeBashWithOperations, type BashResult } from "./bash-executor.ts";
import { createLocalBashOperations } from "../tools/bash.ts";
import { execCommand, type ExecOptions, type ExecResult } from "./exec.ts";
import type { BindingHandle } from "../binding-handles.ts";
import { createSyntheticSourceInfo, type SourceInfo } from "../source-info.ts";
import {
	parseTaskCredentialTargetCapabilities,
	type TaskCredentialProvider,
	type TaskCredentialProviderAvailability,
	type TaskCredentialTargetCapabilities,
} from "../policy/task-credential-provider.ts";
import {
	TASK_CREDENTIAL_MIN_TTL_MS,
	TASK_CREDENTIAL_SCHEMA_VERSION,
	TaskCredentialError,
	isTaskCredentialIsoTimestamp,
	isTaskExecutionBinding,
} from "../policy/task-credential-lease.ts";
import { TaskCredentialService, type TaskCredentialPreflightFactsInput } from "../policy/task-credential-service.ts";
import {
	registerRunSubagentLifecycleHooks,
	registerRunWorkerLifecycleHooks,
	type RunWorkerLifecycleHooks,
	createRunLifecycleCoordinator,
	registerRunSchedulerLifecycleHooks,
	type RunLifecycleCoordinator,
	type RunSchedulerLifecycleHooks,
} from "../session/run-lifecycle.ts";
import {
	runtimeClockFor,
	withRuntimeClock,
	type RuntimeClock,
	type RuntimeTimerHandle,
} from "./clock.ts";
import { SchedulerDeadlockController } from "../scheduler/deadlock.ts";
import {
	SCHEDULER_IN_PROCESS_CAPABILITY_ID,
	createSchedulerExecutorRuntimeSnapshot,
	schedulerBindingRequirementDigest,
	type SchedulerExecutorRegistry,
} from "../scheduler/executors.ts";
import type { SchedulerSelectionReservationStore } from "../scheduler/selection-reservations.ts";
import type { SchedulerFanInController } from "../scheduler/fan-in.ts";
import type { SchedulerHandoffController } from "../scheduler/handoff.ts";
import type { SchedulerMessageOrchestrator } from "../scheduler/messages.ts";
import {
	SchedulerWorkflowController,
	type SchedulerWorkflowConnectorRetryOptions,
} from "../scheduler/workflow.ts";
import {
	SCHEDULER_HOST_DEFAULT_POLL_INTERVAL_MS,
	SCHEDULER_HOST_MAX_POLL_INTERVAL_MS,
	SCHEDULER_HOST_MIN_POLL_INTERVAL_MS,
	SchedulerHost,
	type SchedulerHostEventSource,
	type SchedulerHostOptions,
} from "../scheduler/host.ts";
import {
	TaskGraphStore,
	type TaskGraphGateLookup,
} from "../scheduler/task-graph.ts";
import {
	createSubagentComposition,
	type SchedulerNativeAgentPlanner,
	type SubagentCompositionOptions,
	type SubagentComposition,
} from "../subagent/composition.ts";
import {
	parseWorkerRecord,
	workerTransitionAllowed,
	type WorkerRecord,
	type WorkerTransitionReceipt,
} from "../worker/lifecycle.ts";
import type {
	WorkerSandboxFact,
	WorkerSandboxProvider,
	WorkerSandboxRecovery,
} from "../worker/sandbox-provider.ts";

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
	/** Canonical Session used to resolve durable AgentBinding and PolicyBinding facts. */
	canonicalSession?: Session;
	sessionManager: SessionManager;
	sessionLedger?: {
		getSessionId(): string;
		getEntries(): ReadonlyArray<SessionEntry>;
		appendCustomEntry(customType: string, data?: unknown): string;
	};
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
	/** Explicit Operation Worker profile/provider. Omission preserves the inline/Host path. */
	workerSandboxProvider?: WorkerSandboxProvider;
	/** Explicit trusted Host opt-in. Project/model/RPC configuration cannot populate this option. */
	subagents?: SubagentCompositionOptions;
	/** Explicit trusted Host-only Scheduler opt-in. Omission preserves the original runtime path. */
	scheduler?: SchedulerCompositionOptions;
	/** Testable optimization bound; Session eventId lookup remains authoritative. */
	workerFactCacheLimit?: number;
	policyProfile?: string;
	externalConnectorRegistry?: ExternalConnectorRegistry;
	taskCredentialProvider?: TaskCredentialProvider;
	taskCredentialPolicyMaxTtlMs?: number;
	taskCredentialProviderAvailability?: TaskCredentialProviderAvailability;
	noTools?: "all" | "builtin";
	allowedToolNames?: ReadonlyArray<string>;
	excludedToolNames?: ReadonlyArray<string>;
}

/** Host-owned Scheduler inputs bound to canonical Session authorities. */
export interface SchedulerCompositionOptions {
	readonly schemaVersion: 1;
	readonly enabled: true;
	readonly sourceSession: Session;
	readonly targetSession: Session;
	readonly targetSessionId: string;
	readonly targetGraph: TaskGraphStore;
	readonly runLifecycleSession: SessionManager;
	readonly ownerId: string;
	/** Canonical source-Session authority supplied by the trusted Subagent composition. */
	readonly writer?: SessionLedgerWriter;
	readonly registry: SchedulerExecutorRegistry;
	/** Canonical Session-backed owner shared with the exact-selection registry. */
	readonly selectionReservationStore?: SchedulerSelectionReservationStore;
	/** Per-Session trusted factory planner; prompt, RPC, and project configuration cannot supply it. */
	readonly nativeAgentPlanner?: SchedulerNativeAgentPlanner;
	/** Trusted product initialization that must complete before the Scheduler can start. */
	readonly initializeBeforeStart?: () => Promise<void>;
	/** Exact External Connector target and frozen retry policy for this composition generation. */
	readonly connectorRetry?: SchedulerWorkflowConnectorRetryOptions;
	readonly task: TaskEnvelope;
	readonly binding: AgentBinding;
	readonly gateLookup: TaskGraphGateLookup;
	readonly resolveRunAssociation: SchedulerHostOptions["resolveRunAssociation"];
	readonly settlementEvidence?: SchedulerHostOptions["settlementEvidence"];
	readonly settleRunAtHost: SchedulerHostOptions["settleRunAtHost"];
	readonly eventSource?: SchedulerHostEventSource;
	readonly pollIntervalMs?: number;
	readonly now?: () => string;
}

const NATIVE_SCHEDULER_RUNTIME_EXPIRES_AT = "9999-12-31T23:59:59.999Z";

function nativeSchedulerRuntimeSnapshot(
	providerId: string,
	binding: AgentBinding,
	revision: number,
	now: string,
) {
	const bindingRequirementDigest = schedulerBindingRequirementDigest(binding);
	if (!bindingRequirementDigest.ok) throw bindingRequirementDigest.error;
	const policyRevisionDigest = binding.policyRevision.fingerprint;
	if (policyRevisionDigest === undefined) {
		throw new FoundationError(
			"binding_required_fact",
			"Native Scheduler executor registration requires a fingerprinted policy revision",
		);
	}
	const snapshot = createSchedulerExecutorRuntimeSnapshot({
		schemaVersion: 1,
		capabilitySnapshot: createConnectorCapabilitySnapshot({
			schemaVersion: 1,
			providerId,
			revision,
			protocol: { name: "aos-native-subagent", version: "1" },
			modelAccess: "aos_gateway",
			resume: true,
			toolGateway: true,
			artifacts: false,
			images: false,
		}),
		configRevision: fingerprintFoundationValue({
			schemaVersion: 1,
			providerId,
			revision,
			providerKind: "in_process",
		}),
		bindingRequirementDigests: [bindingRequirementDigest.value],
		toolSelectionDigests: [binding.mcpSelection.digest],
		policyRevisionDigests: [policyRevisionDigest],
		reviewRevisionDigests: [],
		credentialTargetRefs: [],
		sandboxTargetRefs: [],
		observedAt: now,
		expiresAt: NATIVE_SCHEDULER_RUNTIME_EXPIRES_AT,
	});
	if (!snapshot.ok) throw snapshot.error;
	return snapshot.value;
}

async function registerNativeSchedulerProviders(
	options: SchedulerCompositionOptions,
	subagents: SubagentComposition,
	now: string,
): Promise<void> {
	const descriptors = new Map(
		subagents.providerDescriptors().map((descriptor) => [descriptor.descriptor.providerId, descriptor]),
	);
	for (const provider of subagents.schedulerAgentProviders()) {
		const descriptor = descriptors.get(provider.providerId);
		if (descriptor === undefined || descriptor.descriptor.providerClass !== provider.providerClass) {
			throw new FoundationError(
				"subagent_provider_unavailable",
				"Native Scheduler provider has no matching trusted Subagent descriptor",
			);
		}
		if (descriptor.providerKind !== "in_process" || descriptor.capabilities.resumeSupported !== true) continue;
		const existing = options.registry.get(provider.providerId);
		if (existing !== undefined) {
			throw new FoundationError(
				"scheduler_queue_conflict",
				"Native Scheduler provider identity conflicts with an existing executor registration",
			);
		}
		const capabilities = await provider.capabilities();
		const schedulerCapabilities = [
			...capabilities.filter((capability) => capability.id !== SCHEDULER_IN_PROCESS_CAPABILITY_ID),
			{ schemaVersion: 1 as const, id: SCHEDULER_IN_PROCESS_CAPABILITY_ID, version: 1 },
		];
		const registered = await options.registry.register({
			entry: {
				schemaVersion: 1,
				descriptor: descriptor.descriptor,
				capabilities: schedulerCapabilities,
				costClass: "local",
				registeredAt: now,
			},
			provider,
			trusted: true,
			latencyMs: 0,
			maxConcurrency: 1,
			runtimeSnapshot: nativeSchedulerRuntimeSnapshot(
				provider.providerId,
				options.binding,
				descriptor.revision,
				now,
			),
		});
		if (!registered.ok) throw registered.error;
	}
}

export interface SchedulerSafeStatus {
	readonly schemaVersion: 1;
	readonly source: "scheduler";
	readonly sessionId: string;
	readonly enabled: boolean;
	readonly started: boolean;
	readonly tickInFlight: boolean;
	readonly components: readonly ["messages", "handoff", "workflow", "deadlock", "host", "fan_in"];
	readonly ticksCompleted: number;
	readonly tickFailures: number;
	readonly lastTick?: {
		readonly workflow: {
			readonly enabled: boolean;
			readonly workflows: number;
			readonly scheduled: number;
			readonly completed: number;
			readonly stopped: number;
			readonly wakesFired: number;
			readonly errorCount: number;
		};
		readonly host: {
			readonly enabled: boolean;
			readonly scannedGraphs: number;
			readonly scannedNodes: number;
			readonly enqueued: number;
			readonly claimed: number;
			readonly dispatched: number;
			readonly settled: number;
			readonly rejected: number;
			readonly errorCount: number;
		};
		readonly deadlock: {
			readonly enabled: boolean;
			readonly scannedGraphs: number;
			readonly scannedNodes: number;
			readonly scannedEdges: number;
			readonly cycles: number;
			readonly failed: number;
			readonly facts: number;
			readonly signals: number;
			readonly retained: number;
			readonly ready: number;
			readonly timedOut: boolean;
			readonly errorCount: number;
		};
	};
}

/**
 * Trusted production Scheduler composition. One coalescing driver owns every
 * tick; component-local drivers remain stopped. Run hooks are registered
 * before the Run coordinator is created so the observation contract cannot
 * be bypassed by construction order.
 */
export class SchedulerComposition {
	readonly runLifecycle: RunLifecycleCoordinator;
	readonly graph: TaskGraphStore;
	readonly workflow: SchedulerWorkflowController;
	readonly messages: SchedulerMessageOrchestrator;
	readonly handoff: SchedulerHandoffController;
	readonly fanIn: SchedulerFanInController;
	readonly deadlock: SchedulerDeadlockController;
	private readonly host: SchedulerHost;
	private readonly sessionId: string;
	private readonly pollIntervalMs: number;
	private readonly eventSource: SchedulerHostEventSource | undefined;
	private readonly clock: RuntimeClock;
	private readonly unregisterRunHooks: () => void;
	private readonly sourceSession: Session;
	private readonly targetSession: Session;
	private readonly targetSessionId: string;
	private readonly selectionReservationStore: SchedulerSelectionReservationStore | undefined;
	private identityProof: Promise<void> | undefined;
	private unsubscribe: (() => void) | undefined;
	private timer: RuntimeTimerHandle | undefined;
	private currentTick: Promise<void> | undefined;
	private initialization: Promise<void> = Promise.resolve();
	private initializationFailure: { readonly error: unknown } | undefined;
	private initializationComplete = false;
	private disposed = false;
	private wakeQueued = false;
	private started = false;
	private ticksCompleted = 0;
	private tickFailures = 0;
	private lastTick: SchedulerSafeStatus["lastTick"];

	constructor(options: SchedulerCompositionOptions, subagents?: SubagentComposition) {
		if (options.schemaVersion !== 1 || options.enabled !== true) {
			throw new FoundationError("scheduler_queue_invalid", "Scheduler requires an explicit trusted Host opt-in");
		}
		if (
			options.selectionReservationStore !== undefined &&
			options.selectionReservationStore.ownerId !== options.ownerId
		) {
			throw new FoundationError(
				"scheduler_queue_conflict",
				"Scheduler selection and queue persistence must use the same canonical owner",
			);
		}
		if (
			options.writer !== undefined &&
			(options.writer.session !== options.sourceSession ||
				options.writer.ownerId !== options.ownerId ||
				options.writer.lane !== "main")
		) {
			throw new FoundationError(
				"scheduler_queue_conflict",
				"Scheduler writer must match the canonical source Session, owner, and lane",
			);
		}
		if (options.nativeAgentPlanner !== undefined && subagents === undefined) {
			throw new FoundationError(
				"subagent_provider_unavailable",
				"Native Scheduler execution requires the standard trusted Subagent composition",
			);
		}
		if (
			options.nativeAgentPlanner !== undefined &&
			(options.writer === undefined || subagents?.usesCanonicalWriter(options.writer) !== true)
		) {
			throw new FoundationError(
				"subagent_provider_unavailable",
				"Native Scheduler execution requires the canonical Subagent writer",
			);
		}
		if (options.pollIntervalMs !== undefined && !Number.isFinite(options.pollIntervalMs)) {
			throw new FoundationError("scheduler_queue_invalid", "Scheduler poll interval must be finite");
		}
		this.clock = runtimeClockFor(options);
		const now = options.now ?? (() => new Date(this.clock.wallNow()).toISOString());
		const nativeAgentBridge = options.nativeAgentPlanner === undefined
			? undefined
			: subagents?.schedulerNativeAgentBridge(options.nativeAgentPlanner);
		const initializeBeforeStart = nativeAgentBridge === undefined
			? options.initializeBeforeStart
			: async (): Promise<void> => {
					if (subagents === undefined) return;
					await registerNativeSchedulerProviders(options, subagents, now());
					await options.initializeBeforeStart?.();
				};
		this.sessionId = options.runLifecycleSession.getSessionId();
		this.pollIntervalMs = Math.min(
			SCHEDULER_HOST_MAX_POLL_INTERVAL_MS,
			Math.max(SCHEDULER_HOST_MIN_POLL_INTERVAL_MS, options.pollIntervalMs ?? SCHEDULER_HOST_DEFAULT_POLL_INTERVAL_MS),
		);
		this.eventSource = options.eventSource;
		this.sourceSession = options.sourceSession;
		this.targetSession = options.targetSession;
		this.targetSessionId = options.targetSessionId;
		this.selectionReservationStore = options.selectionReservationStore;
		const wake = (): void => this.wake();
		let unregisterRunHooks: (() => void) | undefined;
		let dispatchLifecycleHooks: RunSchedulerLifecycleHooks | undefined;
		let workflow: SchedulerWorkflowController | undefined;
		let host: SchedulerHost | undefined;
		try {
			unregisterRunHooks = registerRunSchedulerLifecycleHooks(options.runLifecycleSession, {
				onRunCancelRequested: (runId) => {
					wake();
					dispatchLifecycleHooks?.onRunCancelRequested?.(runId);
				},
				onRunDeadlineExceeded: (runId) => {
					wake();
					dispatchLifecycleHooks?.onRunDeadlineExceeded?.(runId);
				},
				onRunTerminal: (runId, receipt) => {
					wake();
					dispatchLifecycleHooks?.onRunTerminal?.(runId, receipt);
				},
			});
			this.unregisterRunHooks = unregisterRunHooks;
			this.runLifecycle = createRunLifecycleCoordinator(options.runLifecycleSession);
			this.graph = new TaskGraphStore(
				options.runLifecycleSession,
				{
					get: (runId) => {
						const run = this.runLifecycle.getRun(runId);
						return run === undefined ? undefined : {
							sessionId: run.record.sessionId,
							runId: run.record.id,
							status: run.record.status,
							...(run.receipt === undefined ? {} : { receiptStatus: run.receipt.status }),
						};
					},
				},
				options.gateLookup,
				{ now, onNodeTerminal: wake },
			);
			workflow = new SchedulerWorkflowController(
				withRuntimeClock(
					{
						enabled: true,
						sourceSession: options.sourceSession,
						targetSession: options.targetSession,
						sourceSessionId: this.sessionId,
						targetSessionId: options.targetSessionId,
						sourceGraph: this.graph,
						targetGraph: options.targetGraph,
						ownerId: options.ownerId,
						...(options.writer === undefined ? {} : { writer: options.writer }),
						registry: options.registry,
						task: options.task,
						binding: options.binding,
						runLifecycleSession: options.runLifecycleSession,
						runLifecycleHookOwnership: "host" as const,
						...(nativeAgentBridge === undefined ? {} : { nativeAgentBridge }),
						...(options.connectorRetry === undefined ? {} : { connectorRetry: options.connectorRetry }),
						now,
					},
					this.clock,
				),
			);
			this.workflow = workflow;
			dispatchLifecycleHooks = this.workflow.dispatch.runLifecycleHooks();
			this.messages = this.workflow.messages;
			this.handoff = this.workflow.handoff;
			this.fanIn = this.workflow.fanIn;
			host = new SchedulerHost(
				withRuntimeClock(
					{
						enabled: true,
						sessionId: this.sessionId,
						ownerId: options.ownerId,
						graph: this.graph,
						queue: this.workflow.queue,
						dispatch: this.workflow.dispatch,
						fanIn: this.fanIn,
						resolveRunAssociation: options.resolveRunAssociation,
						...(options.settlementEvidence === undefined
							? {}
							: { settlementEvidence: options.settlementEvidence }),
						settleRunAtHost: options.settleRunAtHost,
						now,
					},
					this.clock,
				),
			);
			this.host = host;
			this.deadlock = new SchedulerDeadlockController(
				withRuntimeClock(
					{
						enabled: true,
						sessionId: this.sessionId,
						ownerId: options.ownerId,
						ledger: options.sourceSession,
						graph: this.graph,
						queue: this.workflow.queue,
						handoff: this.handoff,
						now,
					},
					this.clock,
				),
			);
			const durableSelectionsEnabled = options.registry.durableSelectionsEnabled();
			if (initializeBeforeStart === undefined && !durableSelectionsEnabled) {
				this.initializationComplete = true;
				this.start();
			} else {
				const initialization = Promise.resolve()
					.then(async () => {
						await initializeBeforeStart?.();
						if (!durableSelectionsEnabled) return;
						// Providers must be re-registered before recovery because cancelAttempt may rebuild a
						// durable attempt. Recovery and reservation reconciliation must finish before start()
						// schedules the first tick, so new dispatch cannot race leaked capacity or quota.
						const recovered = await this.workflow.queue.recoverExpired();
						if (!recovered.ok) throw recovered.error;
						const snapshot = await this.workflow.queue.snapshot();
						if (!snapshot.ok) throw snapshot.error;
						const activeQueueEntryIds = snapshot.value.entries
							.filter((entry) => entry.state === "claimed" || entry.state === "dispatched")
							.map((entry) => entry.queueEntryId);
						const reconciled = await options.registry.reconcileReservations(activeQueueEntryIds);
						if (!reconciled.ok) throw reconciled.error;
					})
					.then(() => {
						this.initializationComplete = true;
						if (!this.disposed) this.start();
					});
				this.initialization = initialization.then(
					() => undefined,
					(error: unknown) => {
						this.initializationFailure = { error };
					},
				);
			}
		} catch (error) {
			this.started = false;
			this.wakeQueued = false;
			try {
				this.unsubscribe?.();
			} catch {
				// Continue releasing every construction-owned resource.
			}
			this.unsubscribe = undefined;
			host?.stop();
			if (workflow !== undefined) void workflow.dispose().catch(() => undefined);
			unregisterRunHooks?.();
			throw error;
		}
	}

	private async verifySessionIdentity(): Promise<void> {
		this.identityProof ??= Promise.all([
			this.sourceSession.getMetadata(),
			this.targetSession.getMetadata(),
		]).then(([source, target]) => {
			if (source.id !== this.sessionId) {
				throw new FoundationError("scheduler_queue_invalid", "Scheduler source Session identity is inconsistent");
			}
			if (target.id !== this.targetSessionId) {
				throw new FoundationError("scheduler_queue_invalid", "Scheduler target Session identity is inconsistent");
			}
		});
		await this.identityProof;
	}

	private start(): void {
		if (this.started || this.disposed || !this.initializationComplete) return;
		this.started = true;
		this.unsubscribe = this.eventSource?.subscribe(() => this.wake());
		this.wake();
	}

	wake(): void {
		if (!this.started || this.wakeQueued) return;
		this.wakeQueued = true;
		this.clock.queueMicrotask(() => {
			if (!this.started || !this.wakeQueued) return;
			this.wakeQueued = false;
			void this.tick().catch(() => { this.tickFailures += 1; });
		});
	}

	async tick(): Promise<void> {
		if (!this.initializationComplete) {
			throw new FoundationError(
				"scheduler_executor_unavailable",
				"Scheduler cannot tick before trusted product initialization completes",
			);
		}
		if (this.currentTick !== undefined) return this.currentTick;
		this.currentTick = (async () => {
			await this.verifySessionIdentity();
			const workflow = await this.workflow.tick();
			const host = await this.host.tick();
			const deadlock = await this.deadlock.tick();
			this.lastTick = {
				workflow: {
					enabled: workflow.enabled,
					workflows: workflow.workflows,
					scheduled: workflow.scheduled,
					completed: workflow.completed,
					stopped: workflow.stopped,
					wakesFired: workflow.wakesFired,
					errorCount: workflow.errors.length,
				},
				host: {
					enabled: host.enabled,
					scannedGraphs: host.scannedGraphs,
					scannedNodes: host.scannedNodes,
					enqueued: host.enqueued,
					claimed: host.claimed,
					dispatched: host.dispatched,
					settled: host.settled,
					rejected: host.rejected,
					errorCount: host.errors.length,
				},
				deadlock: {
					enabled: deadlock.enabled,
					scannedGraphs: deadlock.scannedGraphs,
					scannedNodes: deadlock.scannedNodes,
					scannedEdges: deadlock.scannedEdges,
					cycles: deadlock.cycles,
					failed: deadlock.failedTaskIds.length,
					facts: deadlock.facts.length,
					signals: deadlock.signals.length,
					retained: deadlock.retained.length,
					ready: deadlock.readyOrder.length,
					timedOut: deadlock.timedOut,
					errorCount: deadlock.errors.length,
				},
			};
			this.ticksCompleted += 1;
		})().finally(() => {
			this.currentTick = undefined;
			if (this.started) this.schedulePoll();
		});
		return this.currentTick;
	}

	private schedulePoll(): void {
		if (this.timer !== undefined) return;
		this.timer = this.clock.setTimeout(() => {
			this.timer = undefined;
			this.wake();
		}, this.pollIntervalMs);
		this.clock.unrefTimeout(this.timer);
	}

	status(): SchedulerSafeStatus {
		return {
			schemaVersion: 1,
			source: "scheduler",
			sessionId: this.sessionId,
			enabled: true,
			started: this.started,
			tickInFlight: this.currentTick !== undefined,
			components: ["messages", "handoff", "workflow", "deadlock", "host", "fan_in"],
			ticksCompleted: this.ticksCompleted,
			tickFailures: this.tickFailures,
			...(this.lastTick === undefined ? {} : {
				lastTick: {
					workflow: { ...this.lastTick.workflow },
					host: { ...this.lastTick.host },
					deadlock: { ...this.lastTick.deadlock },
				},
			}),
		};
	}

	async whenInitialized(): Promise<void> {
		await this.initialization;
		if (this.initializationFailure !== undefined) throw this.initializationFailure.error;
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;
		this.started = false;
		this.wakeQueued = false;
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		if (this.timer !== undefined) this.clock.clearTimeout(this.timer);
		this.timer = undefined;
		let failure: unknown;
		try {
			await this.initialization;
		} catch (error) {
			failure = error;
		}
		try {
			await this.currentTick;
		} catch (error) {
			failure ??= error;
		}
		this.host.stop();
		try {
			await this.workflow.dispose();
		} catch (error) {
			failure ??= error;
		}
		try {
			await this.selectionReservationStore?.release();
		} catch (error) {
			failure ??= error;
		}
		this.unregisterRunHooks();
		if (failure !== undefined) throw failure;
	}
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

function hasExactKeys(value: object, required: readonly string[], optional: readonly string[] = []): boolean {
	const allowed = new Set([...required, ...optional]);
	return required.every((key) => Object.hasOwn(value, key)) &&
		Object.keys(value).every((key) => allowed.has(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isStringArray(value: unknown): value is ReadonlyArray<string> {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isPolicyBindingPayload(value: unknown): value is PolicyBinding {
	if (!isRecord(value)) return false;
	if (
		value.schemaVersion !== 1 ||
		typeof value.id !== "string" ||
		typeof value.profileId !== "string" ||
		typeof value.profileRevision !== "string" ||
		(value.projectTrust !== "trusted" && value.projectTrust !== "untrusted") ||
		(value.enforcement !== "legacy" && value.enforcement !== "host" && value.enforcement !== "sandbox") ||
		typeof value.runId !== "string" ||
		typeof value.createdAt !== "string" ||
		typeof value.workspaceIdentity !== "string" ||
		typeof value.bindingHash !== "string" ||
		(value.capabilityBindingId !== undefined && typeof value.capabilityBindingId !== "string") ||
		(value.sandboxProviderId !== undefined && typeof value.sandboxProviderId !== "string")
	) return false;
	const sandboxCapabilities = value.sandboxCapabilities;
	if (!isRecord(sandboxCapabilities) || Object.values(sandboxCapabilities).some((item) => typeof item !== "boolean")) return false;
	if (
		value.sandboxStatus !== "not_required" &&
		value.sandboxStatus !== "unavailable" &&
		value.sandboxStatus !== "preparing" &&
		value.sandboxStatus !== "ready" &&
		value.sandboxStatus !== "failed" &&
		value.sandboxStatus !== "disposed"
	) return false;
	const constraints = value.constraints;
	if (!isRecord(constraints)) return false;
	const workspace = constraints.workspace;
	const process = constraints.process;
	const network = constraints.network;
	const credentials = constraints.credentials;
	if (
		!isRecord(workspace) || !isStringArray(workspace.read) || !isStringArray(workspace.write) || !isStringArray(workspace.deny) ||
		!isRecord(process) || (process.action !== "allow" && process.action !== "ask" && process.action !== "deny") || typeof process.inheritEnvironment !== "boolean" || typeof process.allowedEnvironmentCount !== "number" ||
		(process.cwdScopes !== undefined && !isStringArray(process.cwdScopes)) ||
		!isRecord(network) || (network.action !== "allow" && network.action !== "ask" && network.action !== "deny") || typeof network.allowedDestinationCount !== "number" ||
		!isRecord(credentials) || (credentials.action !== "allow" && credentials.action !== "ask" && credentials.action !== "deny") || typeof credentials.allowedNameCount !== "number"
	) return false;
	return true;
}

function externalToolGatewayDenied(message = "External connector Tool Gateway policy denied the request"): FoundationError {
	return new FoundationError("external_tool_route_denied", message);
}

function externalToolRouteNames(route: ToolGatewayRoute): readonly string[] {
	const workspaceLeaf = route.namespace === "workspace"
		? route.toolName.startsWith("workspace.")
			? route.toolName.slice("workspace.".length)
			: route.toolName
		: undefined;
	return [
		route.toolName,
		...(route.namespace === undefined ? [] : [`${route.namespace}.${route.toolName}`]),
		...(workspaceLeaf === undefined ? [] : [workspaceLeaf]),
	];
}

function isCanonicalWorkerTimestamp(value: string): boolean {
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) && new Date(timestamp).toISOString() === value;
}

const RAW_COMMAND_EFFECTS = Object.freeze([
	"write",
	"create",
	"delete",
	"move",
	"command",
	"network",
	"commit",
	"push",
	"merge",
] as const);

function rawCommandPolicyOperation(input: {
	readonly source: "extension" | "user_bash";
	readonly id: string;
	readonly command: string;
	readonly args?: ReadonlyArray<string>;
	readonly cwd: string;
	readonly environmentNames: ReadonlyArray<string>;
	readonly requiresSandbox: boolean;
	readonly sandboxed: boolean;
	readonly sandboxProviderId?: string;
}): PolicyOperationRequest {
	return {
		resource: "process.spawn",
		source: input.source,
		id: input.id,
		command: input.command,
		...(input.args === undefined ? {} : { args: input.args }),
		cwd: input.cwd,
		scope: "workspace",
		effects: RAW_COMMAND_EFFECTS,
		canonicalPath: ".",
		requiresSandbox: input.requiresSandbox,
		sandboxed: input.sandboxed,
		...(input.sandboxProviderId === undefined ? {} : { sandboxProviderId: input.sandboxProviderId }),
		environmentNames: input.environmentNames,
	};
}

export class FoundationControlPlane {
	private readonly harness: AgentHarness;
	private readonly canonicalSession: Session | undefined;
	private readonly sessionManager: SessionManager;
	private readonly sessionLedger: NonNullable<FoundationControlPlaneOptions["sessionLedger"]>;
	private readonly settingsManager: SettingsManager;
	private readonly resourceLoader: ResourceLoader;
	private readonly modelRuntime: ModelRuntime;
	private readonly extensionRunner: ExtensionRunner;
	private readonly cwd: string;
	private readonly agentDir: string;
	private readonly customTools: ToolDefinition[];
	private readonly capabilityRegistry: CapabilityRegistry;
	private readonly mcpTransportFactory: MCPTransportFactory | undefined;
	private readonly externalConnectorRegistry: ExternalConnectorRegistry | undefined;
	private readonly taskCredentialProvider: TaskCredentialProvider | undefined;
	private readonly taskCredentialPolicyMaxTtlMs: number | undefined;
	private readonly taskCredentialProviderAvailability: TaskCredentialProviderAvailability | undefined;
	private readonly sandboxProviders: ReadonlyMap<string, SandboxProvider>;
	private readonly workerSandboxProvider: WorkerSandboxProvider | undefined;
	private readonly scheduler: SchedulerComposition | undefined;
	private readonly workerLifecycleHooks: RunWorkerLifecycleHooks | undefined;
	private readonly unregisterWorkerLifecycleHooks: (() => void) | undefined;
	private readonly releaseWorkerDurableSink: (() => void) | undefined;
	private readonly releaseWorkerCredentialDetachSink: (() => void) | undefined;
	private readonly subagents: SubagentComposition | undefined;
	private readonly unregisterSubagentLifecycleHooks: (() => void) | undefined;
	private readonly persistedWorkerFacts = new Map<string, {
		readonly customType: string;
		readonly canonicalEnvelope: string;
		readonly entryCount: number;
	}>();
	private readonly workerFactCacheLimit: number;
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
		this.canonicalSession = options.canonicalSession;
		this.sessionManager = options.sessionManager;
		this.sessionLedger = options.sessionLedger ?? {
			getSessionId: () => this.sessionManager.getSessionId(),
			getEntries: () => this.sessionManager.getEntries(),
			appendCustomEntry: (customType, data) => this.harness.recordCustomEntry(customType, data),
		};
		this.settingsManager = options.settingsManager;
		this.resourceLoader = options.resourceLoader;
		this.modelRuntime = options.modelRuntime;
		this.extensionRunner = options.extensionRunner;
		this.cwd = options.cwd;
		this.agentDir = options.agentDir;
		this.customTools = [...(options.customTools ?? [])];
		this.capabilityRegistry = options.capabilityRegistry ?? new CapabilityRegistry();
		this.mcpTransportFactory = options.mcpTransportFactory;
		this.externalConnectorRegistry = options.externalConnectorRegistry;
		this.taskCredentialProvider = options.taskCredentialProvider;
		this.taskCredentialPolicyMaxTtlMs = options.taskCredentialPolicyMaxTtlMs;
		this.taskCredentialProviderAvailability = options.taskCredentialProviderAvailability;
		this.noTools = options.noTools;
		this.allowedToolNames = options.allowedToolNames === undefined ? undefined : new Set(options.allowedToolNames);
		this.excludedToolNames = new Set(options.excludedToolNames ?? []);
		this.policyProfileSelection = options.policyProfile;
		this.sandboxProviders = normalizeSandboxProviders(options.sandboxProviders);
		this.workerSandboxProvider = options.workerSandboxProvider;
		if (options.subagents !== undefined && options.subagents.sessionId !== this.sessionManager.getSessionId()) {
			throw new FoundationError("subagent_spawn_invalid", "Trusted subagent composition must use the control-plane Session");
		}
		this.subagents = createSubagentComposition(options.subagents);
		this.workerFactCacheLimit = options.workerFactCacheLimit ?? 4_096;
		if (!Number.isSafeInteger(this.workerFactCacheLimit) || this.workerFactCacheLimit < 1) {
			throw new RangeError("workerFactCacheLimit must be a positive safe integer");
		}
		this.workerLifecycleHooks = this.workerSandboxProvider === undefined
			? undefined
			: {
				onRunCancelRequested: (runId) => { void this.workerSandboxProvider?.notifyRun(runId, "cancel").catch(() => undefined); },
				onRunDeadlineExceeded: (runId) => { void this.workerSandboxProvider?.notifyRun(runId, "deadline").catch(() => undefined); },
				onRunTerminal: (runId) => { void this.workerSandboxProvider?.notifyRun(runId, "terminal").catch(() => undefined); },
				onRunInterrupted: (runId) => { void this.workerSandboxProvider?.notifyRun(runId, "detach").catch(() => undefined); },
			};
		this.policyLedger = createExecutionPolicyLedger(this.sessionLedger);
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
		let releaseWorkerDurableSink: (() => void) | undefined;
		let releaseWorkerCredentialDetachSink: (() => void) | undefined;
		let unregisterWorkerLifecycleHooks: (() => void) | undefined;
		let unregisterSubagentLifecycleHooks: (() => void) | undefined;
		let scheduler: SchedulerComposition | undefined;
		try {
			if (this.subagents !== undefined) {
				unregisterSubagentLifecycleHooks = registerRunSubagentLifecycleHooks(
					this.sessionManager,
					this.subagents.lifecycleHooks(),
				);
			}
			if (this.workerSandboxProvider !== undefined) {
				if (this.workerLifecycleHooks !== undefined) {
					unregisterWorkerLifecycleHooks = registerRunWorkerLifecycleHooks(
						this.sessionManager,
						this.workerLifecycleHooks,
					);
				}
				if (this.workerSandboxProvider.hasDurableFactOwner()) {
					throw new FoundationError("service_conflict", "Operation Worker durable fact owner is already bound");
				}
				const history = this.readPersistedWorkerRecovery();
				const validated = this.workerSandboxProvider.validateWorkerFactsForRestore(history.recovery);
				if (!validated.ok) throw validated.error;
				releaseWorkerDurableSink = this.workerSandboxProvider.bindDurableFactSink(
					this.sessionManager.getSessionId(),
					(fact) => this.persistWorkerFact(fact),
				);
				releaseWorkerCredentialDetachSink = this.workerSandboxProvider.bindCredentialDetachSink(
					this.sessionManager.getSessionId(),
					(detach) => {
						this.getTaskCredentialService()?.onWorkerDetach({
							workerId: detach.workerId,
							...(detach.runId === undefined ? {} : { runId: detach.runId }),
						});
					},
				);
				for (const fact of history.convergenceFacts) this.persistWorkerFact(fact);
				const restored = this.workerSandboxProvider.restoreWorkerFacts(history.recovery);
				if (!restored.ok) throw restored.error;
			}
			if (options.scheduler !== undefined) {
				if (options.scheduler.runLifecycleSession !== this.sessionManager) {
					throw new FoundationError("scheduler_queue_invalid", "Scheduler must use the control-plane Session");
				}
				scheduler = new SchedulerComposition(options.scheduler, this.subagents);
			}
		} catch (error) {
			unregisterSubagentLifecycleHooks?.();
			unregisterWorkerLifecycleHooks?.();
			releaseWorkerCredentialDetachSink?.();
			releaseWorkerDurableSink?.();
			throw error;
		}
		this.releaseWorkerDurableSink = releaseWorkerDurableSink;
		this.releaseWorkerCredentialDetachSink = releaseWorkerCredentialDetachSink;
		this.unregisterWorkerLifecycleHooks = unregisterWorkerLifecycleHooks;
		this.unregisterSubagentLifecycleHooks = unregisterSubagentLifecycleHooks;
		this.scheduler = scheduler;
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

	private authorizeRawCommandOperation(operation: PolicyOperationRequest): void {
		const profile = this.policyProfile;
		const binding = this.policyBinding;
		if (profile === undefined || binding === undefined) throw new PolicyError("policy_binding_failed");
		const initialDecision = authorizePolicyOperation({
			profile,
			binding,
			operation,
			capabilityBinding: this.policyCapabilityBinding(),
		});
		const decision =
			(initialDecision.reviewRequirement === "reviewer" || initialDecision.reviewRequirement === "team_enforced") &&
			initialDecision.requestId !== undefined &&
			initialDecision.scopeDigest !== undefined
				? authorizePolicyOperation({
					profile,
					binding,
					operation,
					reviewEvidence: this.policyLedger.reviewEvidence({
						requestId: initialDecision.requestId,
						bindingId: binding.id,
						scopeDigest: initialDecision.scopeDigest,
					}),
					capabilityBinding: this.policyCapabilityBinding(),
				})
				: initialDecision;
		this.recordDecision(decision);
		this.assertDecisionAllowed(decision);
	}

	/**
	 * Authorize an External Connector Tool Gateway request against the durable
	 * AgentBinding and PolicyBinding selected by the canonical Session. The
	 * authority is intentionally here, at the composition boundary, so a
	 * registry callback cannot bypass binding, policy, approval, or MCP
	 * selection before the underlying provider is invoked.
	 */
	async authorizeExternalToolGatewayRequest(
		request: ToolGatewayRequest,
		route: ToolGatewayRoute,
	): Promise<void> {
		try {
			if (
				this.canonicalSession === undefined ||
				request.context.attemptId === undefined ||
				request.context.operationId === undefined
			) {
				throw externalToolGatewayDenied();
			}
			await this.ensurePolicyReady(request.context.operationId, undefined, false);
			const bindingRecord = await this.canonicalSession.getFoundationObject("agent_binding", request.context.bindingId);
			if (bindingRecord === undefined || bindingRecord.kind !== "fact") throw externalToolGatewayDenied();
			const checkedBinding = validateAgentBinding(bindingRecord.payload);
			if (
				!checkedBinding.ok ||
				checkedBinding.value.bindingId !== request.context.bindingId ||
				checkedBinding.value.taskId !== request.context.taskId ||
				checkedBinding.value.capabilitySelector.policy === "none"
			) {
				throw externalToolGatewayDenied();
			}
			const binding = checkedBinding.value;
			const epochRecord = await this.canonicalSession.getFoundationObject("binding_epoch", request.context.bindingEpochId);
			if (epochRecord === undefined || epochRecord.kind !== "fact") throw externalToolGatewayDenied();
			const checkedEpoch = validateBindingEpoch(epochRecord.payload);
			if (
				!checkedEpoch.ok ||
				checkedEpoch.value.taskId !== binding.taskId ||
				checkedEpoch.value.bindingId !== binding.bindingId ||
				checkedEpoch.value.attemptId !== request.context.attemptId
			) {
				throw externalToolGatewayDenied();
			}
			const policyReference = binding.policyRevision;
			if (
				policyReference.type !== "policy_binding" ||
				policyReference.fingerprint === undefined
			) {
				throw externalToolGatewayDenied();
			}
			const policyRecord = await this.canonicalSession.getFoundationObject("policy_binding", policyReference.id);
			if (policyRecord === undefined || policyRecord.kind !== "fact") throw externalToolGatewayDenied();
			if (fingerprintFoundationValue(policyRecord.payload).value !== policyReference.fingerprint.value) {
				throw externalToolGatewayDenied();
			}
			if (!isPolicyBindingPayload(policyRecord.payload)) throw externalToolGatewayDenied();
			const policy = policyRecord.payload;
			if (
				policy.id !== policyReference.id ||
				policy.runId !== request.context.operationId ||
				this.policyProfile === undefined ||
				this.policyBinding === undefined ||
				policy.profileId !== this.policyProfile.id ||
				policy.profileRevision !== this.policyBinding.profileRevision ||
				policy.workspaceIdentity !== this.policyBinding.workspaceIdentity ||
				policy.enforcement !== this.policyBinding.enforcement ||
				policy.sandboxProviderId !== this.policyBinding.sandboxProviderId ||
				(policy.capabilityBindingId !== undefined &&
					policy.capabilityBindingId !== this.capabilityBinding?.id)
			) {
				throw externalToolGatewayDenied();
			}

			const routeNames = externalToolRouteNames(route);
			const selector = binding.capabilitySelector;
			if (
				(selector.policy === "named" && !(selector.named ?? []).some((name) => routeNames.includes(name))) ||
				(selector.policy === "except" && (selector.named ?? []).some((name) => routeNames.includes(name)))
			) {
				throw externalToolGatewayDenied();
			}

			const catalog = this.capabilityCatalog;
			const selectedCapabilities = this.capabilityBinding;
			const matchingDescriptors = (catalog?.descriptors ?? []).filter((descriptor) => {
				if (route.kind === "mcp") {
					return (
						descriptor.kind === "mcp_tool" &&
						descriptor.mcpServerId === route.namespace &&
						(descriptor.name === route.toolName || descriptor.exposedToolName === route.toolName)
					);
				}
				return descriptor.exposedToolName !== undefined && routeNames.includes(descriptor.exposedToolName);
			});
			if (route.kind === "mcp" && matchingDescriptors.length !== 1) throw externalToolGatewayDenied();
			if (matchingDescriptors.length > 1) throw externalToolGatewayDenied();
			const descriptor = matchingDescriptors[0];
			if (descriptor !== undefined) {
				const selected = selectedCapabilities?.descriptors.find((ref) => ref.id === descriptor.id);
				if (
					selected === undefined ||
					selected.revision !== descriptor.revision ||
					(selected.exposedToolName !== undefined && descriptor.exposedToolName !== selected.exposedToolName) ||
					(route.kind === "mcp" && !selectedCapabilities?.toolAllowlist.includes(descriptor.exposedToolName ?? descriptor.name))
				) {
					throw externalToolGatewayDenied();
				}
			}

			const operation = await classifyExternalToolPolicyOperation({
				request,
				route,
				cwd: this.cwd,
				roots: { workspace: this.cwd, agentInternal: [this.agentDir] },
				...(descriptor?.id === undefined ? {} : { capabilityId: descriptor.id }),
			});
			const initialDecision = authorizePolicyOperation({
				profile: this.policyProfile,
				binding: policy,
				operation,
				capabilityBinding: this.policyCapabilityBinding(),
			});
			const decision =
				(initialDecision.reviewRequirement === "reviewer" || initialDecision.reviewRequirement === "team_enforced") &&
				initialDecision.requestId !== undefined &&
				initialDecision.scopeDigest !== undefined
					? authorizePolicyOperation({
						profile: this.policyProfile,
						binding: policy,
						operation,
						capabilityBinding: this.policyCapabilityBinding(),
						reviewEvidence: this.policyLedger.reviewEvidence({
							requestId: initialDecision.requestId,
							bindingId: policy.id,
							scopeDigest: initialDecision.scopeDigest,
						}),
					})
					: initialDecision;
			this.recordDecision(decision);
			this.assertDecisionAllowed(decision);
		} catch (error) {
			if (error instanceof FoundationError && error.code === "external_tool_route_denied") throw error;
			throw externalToolGatewayDenied();
		}
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
			await this.scheduler?.whenInitialized();
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
	getMcpToolRoutes(): readonly McpToolRoute[] {
		return Object.freeze(this.mcpTools.map(({ mapping }) => Object.freeze({
			kind: "mcp" as const,
			namespace: mapping.serverId,
			toolName: mapping.toolName,
			providerId: mapping.sourceIdentity,
			revision: 1,
		})));
	}
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
	resolveExecutionPolicyReview(
		requestId: string,
		reviewer: PolicyReviewerIdentity,
		decision: PolicyReviewDecision,
		resolvedAt: string,
		source: PolicyApprovalSource = "system",
	): PolicyReviewEvidence {
		const approval = this.policyApprovals.get(requestId);
		const profile = this.policyProfile;
		if (
			approval === undefined ||
			(approval.reviewRequirement !== "reviewer" && approval.reviewRequirement !== "team_enforced") ||
			approval.scopeDigest === undefined ||
			profile?.protectedPaths === undefined
		) {
			throw new PolicyError("policy_review_evidence_invalid");
		}

		let reviewDecision: PolicyDecisionLedgerRecord | undefined;
		for (const event of this.policyLedger.query({
			customType: POLICY_DECISION_CUSTOM_TYPE,
			bindingId: approval.bindingId,
		})) {
			if (event.customType !== POLICY_DECISION_CUSTOM_TYPE) continue;
			if (
				event.record.requestId === requestId &&
				event.record.scopeDigest === approval.scopeDigest &&
				event.record.reviewRequirement === approval.reviewRequirement &&
				event.record.reasonCode === "policy_review_required"
			) {
				reviewDecision = event.record;
			}
		}
		if (
			reviewDecision?.effects === undefined ||
			reviewDecision.protectedPathCount === undefined ||
			reviewDecision.matchedProtectedRuleIds === undefined ||
			reviewDecision.profileId !== profile.id ||
			reviewDecision.profileRevision !== this.policyBinding?.profileRevision
		) {
			throw new PolicyError("policy_review_evidence_invalid");
		}

		let evidence: PolicyReviewEvidence;
		try {
			evidence = createPolicyReviewEvidence({
				requestId,
				bindingId: approval.bindingId,
				requirement: approval.reviewRequirement,
				reviewer,
				decision,
				resolvedAt,
				scopeDigest: approval.scopeDigest,
			});
		} catch {
			throw new PolicyError("policy_review_evidence_invalid");
		}
		const existing = this.policyLedger.reviewEvidence({
			requestId,
			bindingId: approval.bindingId,
			scopeDigest: approval.scopeDigest,
		});
		if (existing.some((item) => item.reviewer.kind === reviewer.kind && item.reviewer.id === reviewer.id)) {
			throw new PolicyError("policy_review_evidence_invalid");
		}
		const resolution = resolvePolicyReviewEvidence({
			policy: profile.protectedPaths,
			classification: {
				protected: true,
				reasonCode: "protected_path_match",
				effects: reviewDecision.effects,
				pathCount: reviewDecision.protectedPathCount,
				matchedRuleIds: reviewDecision.matchedProtectedRuleIds,
				requirement: approval.reviewRequirement,
				scopeDigest: approval.scopeDigest,
			},
			bindingId: approval.bindingId,
			requestId,
			requestCreatedAt: approval.createdAt,
			evidence: [...existing, evidence],
		});
		if (resolution.status === "invalid") throw new PolicyError("policy_review_evidence_invalid");
		this.policyLedger.appendReviewOutcome(approval, evidence, source);
		if (resolution.status !== "missing") this.policyApprovals.delete(requestId);
		return evidence;
	}
	private resolvePolicyApproval(requestId: string, outcome: "approved" | "rejected", source: PolicyApprovalSource): void {
		const approval = this.policyApprovals.get(requestId);
		if (approval === undefined) throw new PolicyError("policy_denied");
		if (approval.reviewRequirement === "reviewer" || approval.reviewRequirement === "team_enforced") {
			throw new PolicyError("policy_review_evidence_invalid");
		}
		this.policyLedger.appendApprovalOutcome(approval, { outcome, source });
		if (outcome === "approved") this.approvedPolicyRequests = [...this.approvedPolicyRequests, requestId];
		else this.rejectedPolicyRequests = [...this.rejectedPolicyRequests, requestId];
		this.policyApprovals.delete(requestId);
	}
	async setExecutionPolicyProfile(profileName?: string): Promise<void> {
		await this.workerSandboxProvider?.terminateAll("detach");
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
	getExternalConnectorRegistry(): ExternalConnectorRegistry | undefined { return this.externalConnectorRegistry; }

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
				session: this.sessionLedger,
				provider: this.taskCredentialProvider,
				policyMaxTtlMs: this.taskCredentialPolicyMaxTtlMs,
				preflight: { resolve: (input) => this.resolveTaskCredentialPreflight(input) },
				...(this.workerSandboxProvider === undefined
					? {}
					: { workerTargets: this.workerSandboxProvider.getCredentialWorkerTargets() }),
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
		this.authorizeRawCommandOperation(rawCommandPolicyOperation({
			source: "extension",
			id: "extension-exec",
			command,
			args,
			cwd,
			environmentNames,
			requiresSandbox: profile.enforcement !== "legacy",
			sandboxed: this.sandboxHandle !== undefined,
			...(this.sandboxHandle === undefined ? {} : { sandboxProviderId: binding.sandboxProviderId }),
		}));
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
			this.authorizeRawCommandOperation(rawCommandPolicyOperation({
				source: "user_bash",
				id: options?.id ?? "user-bash",
				command,
				cwd: this.cwd,
				environmentNames,
				requiresSandbox: profile.enforcement !== "legacy",
				sandboxed: this.sandboxHandle !== undefined,
				...(this.sandboxHandle === undefined ? {} : { sandboxProviderId: binding.sandboxProviderId }),
			}));
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
		this.authorizeRawCommandOperation(rawCommandPolicyOperation({
			source: "user_bash",
			id: requestId ?? "user-bash",
			command,
			cwd: this.cwd,
			environmentNames,
			requiresSandbox: profile.enforcement !== "legacy",
			sandboxed: this.sandboxHandle !== undefined,
			...(this.sandboxHandle === undefined ? {} : { sandboxProviderId: binding.sandboxProviderId }),
		}));
		return this.sandboxHandle === undefined;
	}
	get isBashRunning(): boolean { return this.bashControllers.size > 0; }
	abortBash(): void {
		for (const controller of this.bashControllers) controller.abort(new DOMException("Bash execution cancelled", "AbortError"));
	}
	getSandboxHandle(): SandboxHandle | undefined { return this.sandboxHandle; }
	getWorkerSandboxProvider(): WorkerSandboxProvider | undefined { return this.workerSandboxProvider; }
	getWorkerRecord(workerId: string) { return this.workerSandboxProvider?.getWorkerRecord(workerId); }
	listWorkerRecords() { return this.workerSandboxProvider?.listWorkerRecords() ?? []; }
	getWorkerReceipt(workerReceiptId: string) { return this.workerSandboxProvider?.getWorkerReceipt(workerReceiptId); }
	listWorkerReceipts() { return this.workerSandboxProvider?.listWorkerReceipts() ?? []; }
	reclaimWorker(workerId: string) { return this.workerSandboxProvider?.reclaimWorker(workerId); }
	async cancelWorkerOperations(): Promise<void> { await this.workerSandboxProvider?.cancelAll("cancel"); }
	getWorkerRunLifecycleHooks(): RunWorkerLifecycleHooks | undefined { return this.workerLifecycleHooks; }
	getSubagentComposition(): SubagentComposition | undefined { return this.subagents; }
	getSchedulerStatus(): SchedulerSafeStatus | undefined { return this.scheduler?.status(); }
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
		await this.workerSandboxProvider?.terminateAll("detach");
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
		let failure: unknown;
		try {
			this.taskCredentialService?.onSessionShutdown();
		} catch {
			// Credential shutdown is best effort and never blocks session close.
		}
		await this.mcpLifecycle.closeAll().catch(() => undefined);
		try {
			await this.scheduler?.dispose();
		} catch (error) {
			failure = error;
		}
		try {
			await this.externalConnectorRegistry?.dispose();
		} catch (error) {
			failure ??= error;
		}
		try {
			await this.workerSandboxProvider?.dispose();
		} catch (error) {
			failure ??= error;
		} finally {
			this.unregisterWorkerLifecycleHooks?.();
			this.releaseWorkerCredentialDetachSink?.();
			this.releaseWorkerDurableSink?.();
		}
		try {
			await this.subagents?.dispose();
		} catch (error) {
			failure ??= error;
		} finally {
			this.unregisterSubagentLifecycleHooks?.();
		}
		try {
			await this.disposeSandbox();
		} catch (error) {
			failure ??= error;
		}
		try {
			await this.mcpAuthManager?.dispose();
		} catch (error) {
			failure ??= error;
		}
		if (failure !== undefined) throw failure;
	}

	private readPersistedWorkerRecovery(): {
		readonly recovery: WorkerSandboxRecovery;
		readonly convergenceFacts: readonly WorkerSandboxFact[];
	} {
		const sessionId = this.sessionManager.getSessionId();
		const seen = new Map<string, { readonly customType: string; readonly canonicalEnvelope: string }>();
		const operationIds = new Set<string>();
		const workerIds = new Set<string>();
		const terminalLifecycle = new Map<string, { readonly operationId: string; readonly receiptId?: string }>();
		const lifecycleRevisions = new Map<string, WorkerRecord>();
		const operationEvents: Array<{
			readonly workerId: string;
			readonly providerId: string;
			readonly sessionId: string;
			readonly laneId: string;
			readonly operationId: string;
			readonly revision: number;
			readonly phase: "claimed" | "started" | "terminal";
			readonly sideEffectState?: "none" | "unknown" | "side_effect_unknown";
			readonly receiptId?: string;
			readonly correlationReceiptId?: string;
		}> = [];
		const receiptEvents: Array<{
			readonly sessionId: string;
			readonly taskId?: string;
			readonly operationId: string;
			readonly receiptId: string;
			readonly terminalRecordRevision: number;
			readonly streamId: string;
		}> = [];
		const lifecycle = new Map<string, {
			record: WorkerRecord;
			lastTimestamp: string;
			activeOperationId?: string;
			receiptId?: string;
			lastHeartbeatAt?: string;
		}>();
		for (const entry of this.sessionManager.getPhysicalEntries()) {
			if (entry.type !== "custom" || entry.data === null || typeof entry.data !== "object" || Array.isArray(entry.data)) continue;
			if (
				entry.customType !== "worker.lifecycle_transitioned" &&
				entry.customType !== "worker.operation_recorded" &&
				entry.customType !== "worker_receipt.written"
			) continue;
			const eventId = "eventId" in entry.data && typeof entry.data.eventId === "string" ? entry.data.eventId : undefined;
			if (eventId === undefined) {
				throw new FoundationError("worker_persistence_failed", "Historical Operation Worker event identity is invalid");
			}
			const event = validateDurableEvent(entry.data);
			if (!event.ok || entry.customType !== event.value.category) {
				throw new FoundationError("worker_persistence_failed", "Historical Operation Worker event is invalid");
			}
			if (!isCanonicalWorkerTimestamp(event.value.timestamp)) {
				throw new FoundationError("worker_persistence_failed", "Historical Operation Worker event timestamp is invalid");
			}
			const canonicalEnvelope = canonicalFoundationJson(event.value);
			const eventPayload = event.value.payload;
			if (
				event.value.correlation.sessionId !== sessionId ||
				eventPayload !== null && typeof eventPayload === "object" && !Array.isArray(eventPayload) &&
					typeof eventPayload.sessionId === "string" && eventPayload.sessionId !== sessionId
			) {
				throw new FoundationError("worker_persistence_failed", "Historical Operation Worker Session identity is invalid");
			}
			const seenPrevious = seen.get(eventId);
			if (seenPrevious !== undefined) {
				if (seenPrevious.customType !== entry.customType || seenPrevious.canonicalEnvelope !== canonicalEnvelope) {
					throw new FoundationError("worker_persistence_failed", "Historical Operation Worker event identity conflicts");
				}
				continue;
			}
			seen.set(eventId, { customType: entry.customType, canonicalEnvelope });
			if (event.value.category === "worker.operation_recorded") {
				const correlation = event.value.correlation;
				const payload = event.value.payload;
				if (
					payload === null || typeof payload !== "object" || Array.isArray(payload) ||
					!hasExactKeys(payload, [
						"schemaVersion", "workerId", "providerId", "sessionId", "laneId", "operationId",
						"phase", "revision", "recordedAt",
					], ["sideEffectState", "receiptId"]) ||
					!hasExactKeys(correlation, ["sessionId", "laneId", "workerId", "operationId"], ["receiptId"]) ||
					payload.schemaVersion !== 1 ||
					typeof payload.workerId !== "string" || typeof payload.operationId !== "string" ||
					typeof payload.providerId !== "string" || typeof payload.sessionId !== "string" ||
					typeof payload.laneId !== "string" || typeof payload.recordedAt !== "string" ||
					(payload.phase !== "claimed" && payload.phase !== "started" && payload.phase !== "terminal") ||
					payload.revision !== event.value.sequence ||
					payload.recordedAt !== event.value.timestamp ||
					(payload.sideEffectState !== undefined &&
						(typeof payload.sideEffectState !== "string" || !["none", "unknown", "side_effect_unknown"].includes(payload.sideEffectState))) ||
					(payload.receiptId !== undefined && typeof payload.receiptId !== "string") ||
					(correlation.receiptId !== undefined && typeof correlation.receiptId !== "string") ||
					eventId !== `worker-operation:${payload.workerId}:${String(payload.revision)}` ||
					event.value.streamId !== `worker-operation:${payload.workerId}:${payload.operationId}` ||
					correlation.workerId !== payload.workerId || correlation.operationId !== payload.operationId ||
					correlation.sessionId !== payload.sessionId || correlation.laneId !== payload.laneId
				) {
					throw new FoundationError("worker_persistence_failed", "Historical Operation Worker operation event is invalid");
				}
				operationIds.add(payload.operationId);
				operationEvents.push({
					workerId: payload.workerId,
					providerId: payload.providerId,
					sessionId: payload.sessionId,
					laneId: payload.laneId,
					operationId: payload.operationId,
					revision: payload.revision as number,
					phase: payload.phase,
					...(typeof payload.sideEffectState === "string" && ["none", "unknown", "side_effect_unknown"].includes(payload.sideEffectState)
						? { sideEffectState: payload.sideEffectState as "none" | "unknown" | "side_effect_unknown" }
						: {}),
					...(typeof payload.receiptId === "string" ? { receiptId: payload.receiptId } : {}),
					...(typeof correlation.receiptId === "string" ? { correlationReceiptId: correlation.receiptId } : {}),
				});
				continue;
			}
			if (event.value.category === "worker_receipt.written") {
				const correlation = event.value.correlation;
				const payload = event.value.payload;
				if (
					payload === null || typeof payload !== "object" || Array.isArray(payload) ||
					!hasExactKeys(payload, ["schemaVersion", "workerReceiptId", "operationId"], ["taskId"]) ||
					!hasExactKeys(correlation, ["sessionId", "operationId", "workerReceiptId"], ["taskId"]) ||
					payload.schemaVersion !== 1 ||
					typeof payload.workerReceiptId !== "string" || typeof payload.operationId !== "string" ||
					(payload.taskId !== undefined && typeof payload.taskId !== "string") ||
					typeof correlation.sessionId !== "string" ||
					(correlation.taskId !== undefined && typeof correlation.taskId !== "string") ||
					eventId !== `worker-receipt:${payload.workerReceiptId}` ||
					correlation.workerReceiptId !== payload.workerReceiptId ||
					correlation.operationId !== payload.operationId || correlation.taskId !== payload.taskId
				) {
					throw new FoundationError("worker_persistence_failed", "Historical Operation Worker receipt event is invalid");
				}
				operationIds.add(payload.operationId);
				receiptEvents.push({
					sessionId: correlation.sessionId,
					...(correlation.taskId === undefined ? {} : { taskId: correlation.taskId }),
					operationId: payload.operationId,
					receiptId: payload.workerReceiptId,
					terminalRecordRevision: event.value.sequence,
					streamId: event.value.streamId,
				});
				continue;
			}
			if (event.value.category !== "worker.lifecycle_transitioned") {
				throw new FoundationError("worker_persistence_failed", "Historical Operation Worker event category is invalid");
			}
			const payload = event.value.payload;
			if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
				throw new FoundationError("worker_persistence_failed", "Historical Operation Worker lifecycle payload is invalid");
			}
			if ("operationId" in payload && typeof payload.operationId !== "string") {
				throw new FoundationError("worker_persistence_failed", "Historical Operation Worker lifecycle operation identity is invalid");
			}
			if (!hasExactKeys(event.value.correlation, ["sessionId", "laneId", "workerId"], [
				"runId", "bindingId", "bindingEpochId", "attemptId", "operationId", "receiptId",
			])) {
				throw new FoundationError("worker_persistence_failed", "Historical Operation Worker lifecycle correlation is invalid");
			}
			const recordValue = Object.fromEntries(Object.entries(payload).filter(([key]) => key !== "operationId"));
			const parsed = parseWorkerRecord(canonicalFoundationJson(recordValue));
			if (!parsed.ok) {
				throw new FoundationError("worker_persistence_failed", "Historical Operation Worker record is invalid");
			}
			const record = parsed.value;
			workerIds.add(record.workerId);
			const previous = lifecycle.get(record.workerId);
			const operationId = typeof payload.operationId === "string" ? payload.operationId : undefined;
			if (
				operationId !== undefined &&
				["running", "cancelling", "completed", "failed", "cancelled", "lost"].includes(record.status)
			) operationIds.add(operationId);
			const correlation = event.value.correlation;
			const executionTerminal = ["completed", "failed", "cancelled", "lost"].includes(record.status);
			const expectedReadyAt = previous?.record.readyAt ?? (record.status === "ready" ? event.value.timestamp : undefined);
			const expectedEndedAt = previous?.record.endedAt ?? (executionTerminal ? event.value.timestamp : undefined);
			const expectedActiveOperationId = record.status === "running"
				? operationId
				: record.status === "cancelling"
					? previous?.activeOperationId
					: undefined;
			const transitionReceiptId = typeof correlation.receiptId === "string" ? correlation.receiptId : undefined;
			const expectedReceiptId = transitionReceiptId ?? previous?.receiptId;
			const expectedHeartbeat = expectedEndedAt === undefined
				? undefined
				: previous?.lastHeartbeatAt ?? record.lastHeartbeatAt;
			const identityMatches = previous === undefined || (
				previous.record.providerId === record.providerId &&
				previous.record.sessionId === record.sessionId &&
				previous.record.laneId === record.laneId &&
				previous.record.runId === record.runId &&
				previous.record.bindingId === record.bindingId &&
				previous.record.bindingEpochId === record.bindingEpochId &&
				previous.record.attemptId === record.attemptId &&
				previous.record.profileId === record.profileId &&
				previous.record.createdAt === record.createdAt
			);
			const transitionOperationValid = record.status === "running"
				? operationId !== undefined
				: record.status === "cancelling" || executionTerminal
					? operationId === previous?.activeOperationId
					: operationId === undefined;
			const transitionReceiptValid = record.status === "completed" || record.status === "cancelled"
				? transitionReceiptId !== undefined
				: record.status === "lost" || !executionTerminal
					? transitionReceiptId === undefined
					: true;
			if (
				eventId !== `worker-lifecycle:${record.workerId}:${record.revision}` ||
				event.value.streamId !== `worker-lifecycle:${record.workerId}` ||
				event.value.sequence !== record.revision ||
				correlation.sessionId !== record.sessionId || correlation.laneId !== record.laneId ||
				correlation.workerId !== record.workerId || correlation.runId !== record.runId ||
				correlation.bindingId !== record.bindingId || correlation.bindingEpochId !== record.bindingEpochId ||
				correlation.attemptId !== record.attemptId || correlation.operationId !== operationId ||
				!identityMatches ||
				(previous === undefined
					? record.revision !== 1 || record.status !== "starting" || event.value.timestamp < record.createdAt
					: record.revision !== previous.record.revision + 1 ||
						event.value.timestamp < previous.lastTimestamp ||
						!workerTransitionAllowed(previous.record.status, record.status)) ||
				!transitionOperationValid || !transitionReceiptValid ||
				record.readyAt !== expectedReadyAt || record.endedAt !== expectedEndedAt ||
				record.activeOperationId !== expectedActiveOperationId || record.receiptId !== expectedReceiptId ||
				record.lastHeartbeatAt !== expectedHeartbeat
			) {
				throw new FoundationError("worker_persistence_failed", "Historical Operation Worker lifecycle stream is invalid");
			}
			lifecycle.set(record.workerId, {
				record,
				lastTimestamp: event.value.timestamp,
				...(expectedActiveOperationId === undefined ? {} : { activeOperationId: expectedActiveOperationId }),
				...(expectedReceiptId === undefined ? {} : { receiptId: expectedReceiptId }),
				...(expectedHeartbeat === undefined ? {} : { lastHeartbeatAt: expectedHeartbeat }),
			});
			lifecycleRevisions.set(`${record.workerId}:${record.revision}`, record);
			if (executionTerminal && operationId !== undefined) {
				terminalLifecycle.set(`${record.workerId}:${record.revision}`, {
					operationId,
					...(transitionReceiptId === undefined ? {} : { receiptId: transitionReceiptId }),
				});
			}
		}
		const claimedOperations = new Map<string, string>();
		const operationWorkers = new Map<string, string>();
		const operationPhases = new Map<string, {
			readonly claimedRevision: number;
			readonly startedRevision?: number;
			readonly terminalRevision?: number;
		}>();
		for (const operationEvent of operationEvents) {
			const lifecycleRecord = lifecycleRevisions.get(`${operationEvent.workerId}:${operationEvent.revision}`);
			const expectedStatus = operationEvent.phase === "claimed"
				? "ready"
				: operationEvent.phase === "started"
					? "running"
					: undefined;
			const terminal = terminalLifecycle.get(`${operationEvent.workerId}:${operationEvent.revision}`);
			const terminalSemanticsValid = operationEvent.phase !== "terminal" || lifecycleRecord === undefined
				? operationEvent.sideEffectState === undefined && operationEvent.receiptId === undefined && operationEvent.correlationReceiptId === undefined
				: lifecycleRecord.status === "completed" || lifecycleRecord.status === "cancelled"
					? operationEvent.sideEffectState === "none" && operationEvent.receiptId === terminal?.receiptId && operationEvent.correlationReceiptId === terminal?.receiptId
					: lifecycleRecord.status === "lost"
						? operationEvent.sideEffectState === "side_effect_unknown" && operationEvent.receiptId === undefined && operationEvent.correlationReceiptId === undefined
						: lifecycleRecord.status === "failed" && operationEvent.sideEffectState !== undefined &&
							operationEvent.receiptId === terminal?.receiptId && operationEvent.correlationReceiptId === terminal?.receiptId;
			const priorWorker = operationWorkers.get(operationEvent.operationId);
			const priorOperation = claimedOperations.get(operationEvent.workerId);
			const phaseKey = canonicalFoundationJson([operationEvent.workerId, operationEvent.operationId]);
			const priorPhases = operationPhases.get(phaseKey);
			const phaseOrderValid = operationEvent.phase === "claimed"
				? priorPhases === undefined
				: operationEvent.phase === "started"
					? priorPhases !== undefined && priorPhases.startedRevision === undefined && priorPhases.terminalRevision === undefined
					: priorPhases?.startedRevision !== undefined && priorPhases.terminalRevision === undefined;
			if (
				lifecycleRecord === undefined ||
				operationEvent.providerId !== lifecycleRecord.providerId ||
				operationEvent.providerId !== this.workerSandboxProvider?.providerId ||
				operationEvent.sessionId !== lifecycleRecord.sessionId ||
				operationEvent.laneId !== lifecycleRecord.laneId ||
				expectedStatus !== undefined && lifecycleRecord.status !== expectedStatus ||
				operationEvent.phase === "terminal" && !["completed", "failed", "cancelled", "lost"].includes(lifecycleRecord.status) ||
				operationEvent.phase !== "claimed" && terminal?.operationId !== operationEvent.operationId &&
					lifecycleRecord.activeOperationId !== operationEvent.operationId ||
				!terminalSemanticsValid ||
				priorWorker !== undefined && priorWorker !== operationEvent.workerId ||
				priorOperation !== undefined && priorOperation !== operationEvent.operationId ||
				operationEvent.phase !== "claimed" && priorOperation === undefined ||
				!phaseOrderValid
			) {
				throw new FoundationError("worker_persistence_failed", "Historical Operation Worker operation revision is invalid");
			}
			operationWorkers.set(operationEvent.operationId, operationEvent.workerId);
			if (operationEvent.phase === "claimed") {
				claimedOperations.set(operationEvent.workerId, operationEvent.operationId);
				operationPhases.set(phaseKey, { claimedRevision: operationEvent.revision });
			} else if (operationEvent.phase === "started" && priorPhases !== undefined) {
				operationPhases.set(phaseKey, { ...priorPhases, startedRevision: operationEvent.revision });
			} else if (priorPhases !== undefined) {
				operationPhases.set(phaseKey, { ...priorPhases, terminalRevision: operationEvent.revision });
			}
		}
		for (const [key, lifecycleRecord] of lifecycleRevisions) {
			const lifecycleOperationId = lifecycleRecord.activeOperationId ?? terminalLifecycle.get(key)?.operationId;
			if (lifecycleOperationId === undefined) continue;
			if (
				claimedOperations.get(lifecycleRecord.workerId) !== lifecycleOperationId ||
				operationWorkers.get(lifecycleOperationId) !== lifecycleRecord.workerId
			) {
				throw new FoundationError("worker_persistence_failed", "Historical Operation Worker lifecycle has no claimed operation fence");
			}
		}
		for (const receiptEvent of receiptEvents) {
			const workerId = operationWorkers.get(receiptEvent.operationId);
			const lifecycleRecord = workerId === undefined
				? undefined
				: lifecycleRevisions.get(`${workerId}:${receiptEvent.terminalRecordRevision}`);
			const terminal = workerId === undefined
				? undefined
				: terminalLifecycle.get(`${workerId}:${receiptEvent.terminalRecordRevision}`);
			const phases = workerId === undefined
				? undefined
				: operationPhases.get(canonicalFoundationJson([workerId, receiptEvent.operationId]));
			if (
				workerId === undefined || receiptEvent.streamId !== `worker-receipts:${workerId}` ||
				lifecycleRecord === undefined || lifecycleRecord.sessionId !== receiptEvent.sessionId ||
				terminal === undefined || terminal.operationId !== receiptEvent.operationId ||
				terminal.receiptId !== receiptEvent.receiptId ||
				phases?.terminalRevision !== receiptEvent.terminalRecordRevision
			) {
				throw new FoundationError("worker_persistence_failed", "Historical Operation Worker receipt revision is invalid");
			}
		}
		for (const [eventId, value] of seen) {
			this.markWorkerFactPersisted(eventId, value.customType, value.canonicalEnvelope);
		}
		const convergenceFacts: WorkerSandboxFact[] = [];
		const records = [...lifecycle.values()].map(({ record, activeOperationId, lastTimestamp }) => {
			if (record.status === "reclaimed" || record.status === "reclaim_unknown") return record;
			const convergence = this.createWorkerRecoveryConvergenceFact(record, activeOperationId, lastTimestamp);
			convergenceFacts.push(convergence);
			return convergence.record;
		});
		return {
			recovery: {
				records,
				operationIds: [...operationIds],
				workerIds: [...workerIds],
			},
			convergenceFacts,
		};
	}

	private createWorkerRecoveryConvergenceFact(
		record: WorkerRecord,
		activeOperationId: string | undefined,
		at: string,
	): Extract<WorkerSandboxFact, { readonly type: "record" }> {
		const transitions: WorkerTransitionReceipt[] = [];
		const transitionRecords: WorkerRecord[] = [];
		let current = record;
		const append = (
			to: WorkerRecord["status"],
			next: WorkerRecord,
			operationId?: string,
			sideEffectState?: "side_effect_unknown",
		): void => {
			const revision = current.revision + 1;
			transitions.push(Object.freeze({
				schemaVersion: 1,
				clientRequestId: `recovery:${record.workerId}:${revision}`,
				requestFingerprint: `sha256:${createHash("sha256").update(`${record.workerId}:${revision}`).digest("hex")}`,
				from: current.status,
				to,
				previousRevision: current.revision,
				revision,
				at,
				...(operationId === undefined ? {} : { operationId }),
				...(sideEffectState === undefined ? {} : { sideEffectState }),
			}));
			current = Object.freeze(next);
			transitionRecords.push(current);
		};
		if (["starting", "ready", "running", "cancelling"].includes(current.status)) {
			const operationId = current.status === "running" || current.status === "cancelling" ? activeOperationId : undefined;
			const lostRecord = { ...current };
			delete lostRecord.activeOperationId;
			delete lostRecord.receiptId;
			append("lost", {
				...lostRecord,
				status: "lost",
				revision: current.revision + 1,
				endedAt: at,
			}, operationId, "side_effect_unknown");
		}
		if (["completed", "failed", "cancelled", "lost"].includes(current.status)) {
			append("reclaiming", {
				...current,
				status: "reclaiming",
				revision: current.revision + 1,
			});
		}
		if (current.status === "reclaiming") {
			append("reclaim_unknown", {
				...current,
				status: "reclaim_unknown",
				revision: current.revision + 1,
			});
		}
		if (transitions.length === 0 || current.status !== "reclaim_unknown") {
			throw new FoundationError("worker_persistence_failed", "Historical Operation Worker cannot converge safely");
		}
		return Object.freeze({
			type: "record",
			record: current,
			transitions: Object.freeze(transitions),
			transitionRecords: Object.freeze(transitionRecords),
		});
	}

	private persistWorkerFact(fact: WorkerSandboxFact): void {
		const sessionId = this.sessionManager.getSessionId();
		if (fact.type === "operation") {
			if (fact.sessionId !== sessionId) {
				throw new FoundationError("worker_persistence_failed", "Operation Worker fence session identity is invalid");
			}
			const event = validateDurableEvent({
				schemaVersion: 1,
				class: "durable",
				category: "worker.operation_recorded",
				eventId: `worker-operation:${fact.workerId}:${fact.revision}`,
				streamId: `worker-operation:${fact.workerId}:${fact.operationId}`,
				sequence: fact.revision,
				timestamp: fact.recordedAt,
				correlation: {
					sessionId: fact.sessionId,
					laneId: fact.laneId,
					workerId: fact.workerId,
					operationId: fact.operationId,
				},
				payload: {
					schemaVersion: 1,
					workerId: fact.workerId,
					providerId: fact.providerId,
					sessionId: fact.sessionId,
					laneId: fact.laneId,
					operationId: fact.operationId,
					phase: "claimed",
					revision: fact.revision,
					recordedAt: fact.recordedAt,
				},
			});
			if (!event.ok) throw event.error;
			this.appendWorkerEvent("worker.operation_recorded", event.value);
			return;
		}
		if (fact.type === "receipt") {
			const eventId = `worker-receipt:${fact.receipt.workerReceiptId}`;
			const payload = {
				schemaVersion: 1,
				workerReceiptId: fact.receipt.workerReceiptId,
				operationId: fact.receipt.operationId,
				...(fact.receipt.taskId === undefined ? {} : { taskId: fact.receipt.taskId }),
			};
			const correlation = fact.receipt.provenance.correlation;
			if (correlation === undefined || correlation.sessionId !== sessionId) {
				throw new FoundationError("worker_persistence_failed", "Operation Worker receipt session identity is invalid");
			}
			const event = validateDurableEvent({
				schemaVersion: 1,
				class: "durable",
				category: "worker_receipt.written",
				eventId,
				streamId: `worker-receipts:${fact.workerId}`,
				sequence: fact.terminalRecordRevision,
				timestamp: fact.receipt.completedAt,
				correlation: {
					sessionId: correlation.sessionId,
					operationId: fact.receipt.operationId,
					workerReceiptId: fact.receipt.workerReceiptId,
					...(fact.receipt.taskId === undefined ? {} : { taskId: fact.receipt.taskId }),
				},
				payload,
			});
			if (!event.ok) throw event.error;
			this.appendWorkerEvent("worker_receipt.written", event.value);
			return;
		}
		const record = fact.record;
		if (record.sessionId !== sessionId) {
			throw new FoundationError("worker_persistence_failed", "Operation Worker record session identity is invalid");
		}
		let readyAt: string | undefined;
		let endedAt: string | undefined;
		let receiptId: string | undefined;
		for (const transition of fact.transitions) {
			const suppliedRecord = fact.transitionRecords?.find((candidate) => candidate.revision === transition.revision);
			let transitionRecord: WorkerRecord;
			if (suppliedRecord !== undefined) {
				const parsed = parseWorkerRecord(canonicalFoundationJson(suppliedRecord));
				if (
					!parsed.ok || parsed.value.workerId !== record.workerId || parsed.value.providerId !== record.providerId ||
					parsed.value.sessionId !== record.sessionId || parsed.value.laneId !== record.laneId ||
					parsed.value.runId !== record.runId || parsed.value.bindingId !== record.bindingId ||
					parsed.value.bindingEpochId !== record.bindingEpochId || parsed.value.attemptId !== record.attemptId ||
					parsed.value.profileId !== record.profileId || parsed.value.createdAt !== record.createdAt ||
					parsed.value.status !== transition.to || parsed.value.revision !== transition.revision
				) {
					throw new FoundationError("worker_persistence_failed", "Operation Worker transition snapshot is invalid");
				}
				transitionRecord = parsed.value;
				readyAt = transitionRecord.readyAt;
				endedAt = transitionRecord.endedAt;
				receiptId = transitionRecord.receiptId;
			} else {
				if (readyAt === undefined && transition.to === "ready") readyAt = transition.at;
				if (endedAt === undefined && ["completed", "failed", "cancelled", "lost"].includes(transition.to)) endedAt = transition.at;
				receiptId = transition.receiptId ?? receiptId;
				transitionRecord = {
					schemaVersion: 1,
					workerId: record.workerId,
					providerId: record.providerId,
					sessionId: record.sessionId,
					laneId: record.laneId,
					...(record.runId === undefined ? {} : { runId: record.runId }),
					...(record.bindingId === undefined ? {} : { bindingId: record.bindingId }),
					...(record.bindingEpochId === undefined ? {} : { bindingEpochId: record.bindingEpochId }),
					...(record.attemptId === undefined ? {} : { attemptId: record.attemptId }),
					profileId: record.profileId,
					status: transition.to,
					revision: transition.revision,
					createdAt: record.createdAt,
					...(readyAt === undefined ? {} : { readyAt }),
					...(endedAt === undefined ? {} : { endedAt }),
					...(endedAt === undefined || record.lastHeartbeatAt === undefined ? {} : { lastHeartbeatAt: record.lastHeartbeatAt }),
					...((transition.to === "running" || transition.to === "cancelling") && transition.operationId !== undefined
						? { activeOperationId: transition.operationId }
						: {}),
					...(receiptId === undefined ? {} : { receiptId }),
				};
			}
			const lifecycleEventId = `worker-lifecycle:${record.workerId}:${transition.revision}`;
			const lifecyclePayload = {
				schemaVersion: 1,
				workerId: transitionRecord.workerId,
				providerId: transitionRecord.providerId,
				sessionId: transitionRecord.sessionId,
				laneId: transitionRecord.laneId,
				status: transitionRecord.status,
				revision: transitionRecord.revision,
				profileId: transitionRecord.profileId,
				createdAt: transitionRecord.createdAt,
				...(transitionRecord.runId === undefined ? {} : { runId: transitionRecord.runId }),
				...(transitionRecord.bindingId === undefined ? {} : { bindingId: transitionRecord.bindingId }),
				...(transitionRecord.bindingEpochId === undefined ? {} : { bindingEpochId: transitionRecord.bindingEpochId }),
				...(transitionRecord.attemptId === undefined ? {} : { attemptId: transitionRecord.attemptId }),
				...(transitionRecord.readyAt === undefined ? {} : { readyAt: transitionRecord.readyAt }),
				...(transitionRecord.endedAt === undefined ? {} : { endedAt: transitionRecord.endedAt }),
				...(transitionRecord.lastHeartbeatAt === undefined ? {} : { lastHeartbeatAt: transitionRecord.lastHeartbeatAt }),
				...(transitionRecord.activeOperationId === undefined ? {} : { activeOperationId: transitionRecord.activeOperationId }),
				...(transition.operationId === undefined ? {} : { operationId: transition.operationId }),
				...(transitionRecord.receiptId === undefined ? {} : { receiptId: transitionRecord.receiptId }),
			};
			const event = validateDurableEvent({
				schemaVersion: 1,
				class: "durable",
				category: "worker.lifecycle_transitioned",
					eventId: lifecycleEventId,
				streamId: `worker-lifecycle:${record.workerId}`,
				sequence: transition.revision,
				timestamp: transition.at,
				correlation: {
					sessionId: record.sessionId,
					laneId: record.laneId,
					workerId: record.workerId,
					...(record.runId === undefined ? {} : { runId: record.runId }),
					...(record.bindingId === undefined ? {} : { bindingId: record.bindingId }),
					...(record.bindingEpochId === undefined ? {} : { bindingEpochId: record.bindingEpochId }),
					...(record.attemptId === undefined ? {} : { attemptId: record.attemptId }),
					...(transition.operationId === undefined ? {} : { operationId: transition.operationId }),
					...(transition.receiptId === undefined ? {} : { receiptId: transition.receiptId }),
				},
				payload: lifecyclePayload,
			});
			if (!event.ok) throw event.error;
			this.appendWorkerEvent("worker.lifecycle_transitioned", event.value);

			if (
				transition.operationId === undefined ||
				(transition.to !== "running" && !["completed", "failed", "cancelled", "lost"].includes(transition.to))
			) continue;
			const operationEventId = `worker-operation:${record.workerId}:${transition.revision}`;
			const operationPayload = {
				schemaVersion: 1,
				workerId: record.workerId,
				providerId: record.providerId,
				sessionId: record.sessionId,
				laneId: record.laneId,
				operationId: transition.operationId,
				phase: transition.to === "running" ? "started" : "terminal",
				revision: transition.revision,
				recordedAt: transition.at,
				...(transition.sideEffectState === undefined ? {} : { sideEffectState: transition.sideEffectState }),
				...(transition.receiptId === undefined ? {} : { receiptId: transition.receiptId }),
			};
			const operationEvent = validateDurableEvent({
				schemaVersion: 1,
				class: "durable",
				category: "worker.operation_recorded",
				eventId: operationEventId,
				streamId: `worker-operation:${record.workerId}:${transition.operationId}`,
				sequence: transition.revision,
				timestamp: transition.at,
				correlation: {
					sessionId: record.sessionId,
					laneId: record.laneId,
					workerId: record.workerId,
					operationId: transition.operationId,
					...(transition.receiptId === undefined ? {} : { receiptId: transition.receiptId }),
				},
				payload: operationPayload,
			});
			if (!operationEvent.ok) throw operationEvent.error;
			this.appendWorkerEvent("worker.operation_recorded", operationEvent.value);
		}
	}

	private appendWorkerEvent(customType: string, event: FoundationEventEnvelope): void {
		if (this.hasPersistedWorkerFact(customType, event)) return;
		this.harness.recordCustomEntry(customType, event);
		this.markWorkerFactPersisted(event.eventId, customType, canonicalFoundationJson(event));
	}

	private markWorkerFactPersisted(eventId: string, customType: string, canonicalEnvelope: string): void {
		this.persistedWorkerFacts.delete(eventId);
		this.persistedWorkerFacts.set(eventId, {
			customType,
			canonicalEnvelope,
			entryCount: this.sessionManager.getPhysicalEntries().length,
		});
		while (this.persistedWorkerFacts.size > this.workerFactCacheLimit) {
			const oldest = this.persistedWorkerFacts.keys().next().value;
			if (oldest === undefined) break;
			this.persistedWorkerFacts.delete(oldest);
		}
	}

	private hasPersistedWorkerFact(customType: string, event: FoundationEventEnvelope): boolean {
		const entries = this.sessionManager.getPhysicalEntries();
		const canonicalEnvelope = canonicalFoundationJson(event);
		const cached = this.persistedWorkerFacts.get(event.eventId);
		if (
			cached !== undefined &&
			cached.entryCount === entries.length &&
			cached.customType === customType &&
			cached.canonicalEnvelope === canonicalEnvelope
		) {
			return true;
		}
		let persisted = false;
		for (const entry of entries) {
			if (entry.type !== "custom" || entry.data === null || typeof entry.data !== "object" || Array.isArray(entry.data)) continue;
			if (!("eventId" in entry.data) || entry.data.eventId !== event.eventId) continue;
			let candidateCanonical: string;
			try {
				candidateCanonical = canonicalFoundationJson(entry.data);
			} catch {
				throw new FoundationError("worker_persistence_failed", "Operation Worker event identity conflicts");
			}
			if (
				entry.customType !== customType ||
				entry.customType !== event.category ||
				candidateCanonical !== canonicalEnvelope
			) {
				throw new FoundationError("worker_persistence_failed", "Operation Worker event identity conflicts");
			}
			persisted = true;
		}
		if (persisted) this.markWorkerFactPersisted(event.eventId, customType, canonicalEnvelope);
		return persisted;
	}

}

function normalizeSandboxProviders(input: ReadonlyMap<string, SandboxProvider> | ReadonlyArray<SandboxProvider> | undefined): ReadonlyMap<string, SandboxProvider> {
	if (input === undefined) return new Map();
	if (typeof (input as ReadonlyMap<string, SandboxProvider>).get === "function") return input as ReadonlyMap<string, SandboxProvider>;
	return new Map((input as ReadonlyArray<SandboxProvider>).map((provider) => [provider.id, provider]));
}
