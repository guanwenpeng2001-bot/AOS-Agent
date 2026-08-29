import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
	createAttempt,
	createConnectorCapabilitySnapshot,
	createHostTerminalGateAuthority,
	createModelProfileRevision,
	createRoleRevision,
	createScopedMemoryStore,
	createTaskEnvelope,
	fingerprintFoundationValue,
	FoundationError,
	InMemoryArtifactBlobStore,
	LayeredResultSettlement,
	resolveAgentBinding,
	Result,
	Session,
	SessionLedger,
	SessionT5Ledger,
	validateAttempt,
	validateAttemptReceiptForProvider,
	validateRunReceipt,
	validateTaskResult,
	type AgentBinding,
	type ArtifactStoreProvider,
	type Attempt,
	type AttemptReceipt,
	type ConnectorCapabilitySnapshot,
	type Dispatch,
	type ExternalAgentConnector,
	type FoundationProviderCapability,
	type FoundationProviderExecutionOptions,
	type ModelProfile,
	type QuotaProvider,
	type Result as ResultValue,
	type RevisionReference,
	type ScopedModelGateway,
	type SessionLedgerWriter,
	type TaskEnvelope,
	type TaskExecutorAttemptContext,
	type ToolGateway,
} from "@aos-agent/agent-core";
import { fauxAssistantMessage, registerFauxProvider } from "@aos-agent/ai/compat";
import {
	createAgentRuntimeCompositionFactory,
	type AgentRuntimeCompositionContext,
	type TrustedSchedulerRuntimeOptions,
} from "./agent-runtime-composition.ts";
import type { AgentSession } from "./agent-session.ts";
import {
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	type CreateAgentSessionRuntimeFactory,
} from "./agent-session-runtime.ts";
import type { AgentSessionRuntime } from "./agent-session-runtime.ts";
import { AuthStorage } from "./auth-storage.ts";
import { createExternalConnectorRegistry, type ExternalConnectorRegistry } from "./external-agent-registry.ts";
import { buildExternalConnectorTargetConfig } from "./external-connector-target-config.ts";
import type { ExtensionAPI } from "./extensions/types.ts";
import { createRunLifecycleCoordinator, type RunHandle } from "./run-lifecycle.ts";
import {
	SCHEDULER_IN_PROCESS_CAPABILITY_ID,
	SchedulerExecutorRegistry,
	type SchedulerExecutorSelectionInputV1,
	type SchedulerExecutorSelectionResultV1,
} from "./scheduler-executors.ts";
import type { SchedulerSelectionReservationStore } from "./scheduler-selection-reservations.ts";
import { SessionManager } from "./session-manager.ts";
import { createSessionManagerStorage } from "./session-manager-storage.ts";
import { TaskGraphStore } from "./task-graph.ts";
import type { TrustedSubagentCompositionOptionsV1 } from "./subagent-composition.ts";

const NOW = "2026-08-29T00:00:00.000Z";
const CONNECTOR_PROVIDER_ID = "aos.line13.external-connector";
const TASK_ID = "line13-product-trace-task";
const RUN_ID = "line13-product-trace-run";
const GRAPH_REVISION = 1;

export const LINE13_PRODUCT_TRACE_OPERATIONS = Object.freeze([
	"run",
	"switch",
	"fork",
	"import",
	"reload",
	"cancel",
	"restart",
] as const);

type TraceOperation = (typeof LINE13_PRODUCT_TRACE_OPERATIONS)[number];

export interface Line13ProductTraceOptions {
	readonly workDirectory: string;
	readonly iterations?: number;
}

export interface Line13CanonicalClosureSnapshot {
	readonly activeRuns: number;
	readonly backlog: number;
	readonly status: number;
	readonly credentials: number;
	readonly reservations: number;
	readonly processes: number;
	readonly timers: number;
	readonly files: number;
	readonly pendingWrites: number;
}

export interface Line13CanonicalRecordSnapshot {
	readonly operation: TraceOperation;
	readonly attempts: 1;
	readonly attemptReceipts: 1;
	readonly taskResults: 1;
	readonly runReceipts: 1;
	readonly attemptId: string;
	readonly attemptReceiptId: string;
	readonly taskResultId: string;
	readonly runReceiptId: string;
	readonly runId: typeof RUN_ID;
	readonly providerId: typeof CONNECTOR_PROVIDER_ID;
}

export interface Line13ProductTraceResult {
	readonly schemaVersion: 1;
	readonly entrypoint: "aos-agent/external-connector";
	readonly adapter: "standard_product_composition";
	readonly iterations: number;
	readonly operations: Readonly<Record<TraceOperation, number>>;
	readonly canonicalOwners: readonly [
		"agent_harness",
		"external_connector_registry",
		"task_credential_service",
		"scheduler_selection_reservations",
		"worker_registry",
		"scheduler_status",
		"session_manager",
	];
	readonly samples: readonly Line13CanonicalClosureSnapshot[];
	readonly canonicalRecords: readonly Line13CanonicalRecordSnapshot[];
	readonly final: Line13CanonicalClosureSnapshot;
	readonly connector: {
		readonly providerId: typeof CONNECTOR_PROVIDER_ID;
		readonly currentRegistrySize: 1;
		readonly attemptExecutions: number;
	};
	readonly provider: { readonly kind: "faux"; readonly pendingResponses: number };
}

type FauxModel = NonNullable<ReturnType<ReturnType<typeof registerFauxProvider>["getModel"]>>;

interface Deferred<T> {
	readonly promise: Promise<T>;
	readonly resolve: (value: T) => void;
}

interface SchedulerFixture {
	readonly sourceSession: Session;
	readonly sourceGraph: TaskGraphStore;
	readonly writer: SessionLedgerWriter;
	readonly task: TaskEnvelope;
	readonly binding: AgentBinding;
	readonly registry: ExternalConnectorRegistry;
	readonly scheduler: TrustedSchedulerRuntimeOptions;
	readonly completion: Deferred<void>;
	readonly failure: Deferred<FoundationError>;
	wake: (() => void) | undefined;
}

interface TraceRuntime {
	runtime: AgentSessionRuntime;
	readonly fixtureFor: (session: AgentSession) => SchedulerFixture;
}

function createDeferred<T>(): Deferred<T> {
	let pendingResolve: ((value: T) => void) | undefined;
	const promise = new Promise<T>((resolve) => { pendingResolve = resolve; });
	return {
		promise,
		resolve(value) {
			const resolve = pendingResolve;
			pendingResolve = undefined;
			resolve?.(value);
		},
	};
}

function immutableFact(type: string, id: string): RevisionReference {
	const value = { schemaVersion: 1 as const, type, id, revision: 1 };
	return { ...value, fingerprint: fingerprintFoundationValue(value) };
}

function traceTask(): TaskEnvelope {
	const created = createTaskEnvelope({
		schemaVersion: 1,
		taskId: TASK_ID,
		goalId: "line13-product-trace-goal",
		goal: "Execute the packaged external Connector product trace",
		workspace: "line13-product-trace-workspace",
		capabilityRefs: [],
		inputs: [],
		expectedOutputs: [],
		budget: { tokens: 100, concurrency: 1 },
		acceptanceCriteria: [],
		status: "ready",
		createdAt: NOW,
		updatedAt: NOW,
	});
	if (!created.ok) throw created.error;
	return created.value;
}

function traceRoleRevision() {
	return createRoleRevision({
		definition: {
			schemaVersion: 1,
			roleId: "line13-product-trace-role",
			scope: "project",
			slug: "line13-product-trace",
			name: "Line 13 product trace",
			description: "Execute the packaged external Connector product trace",
			revision: 1,
			persona: "Execute one deterministic Connector task.",
			modelProfileRef: { schemaVersion: 1, type: "model_profile", id: "line13-product-trace-profile", revision: 1 },
			capabilitySelector: { policy: "all" },
			skillSelector: { policy: "none" },
			mcpSelector: { policy: "none" },
		},
		now: () => NOW,
	});
}

function traceModelProfile(): ModelProfile {
	return createModelProfileRevision({
		schemaVersion: 1,
		modelProfileId: "line13-product-trace-profile",
		provider: "line13-host",
		model: "line13-host",
		budget: { tokens: 100, concurrency: 1 },
		revision: 1,
		createdAt: NOW,
	});
}

function traceBinding(task: TaskEnvelope): AgentBinding {
	const resolved = resolveAgentBinding({
		task,
		roleRevision: traceRoleRevision(),
		modelProfile: traceModelProfile(),
		contextRevision: immutableFact("external_agent_binding", "line13-product-trace-context"),
		capabilityRevision: immutableFact("capability_binding", "line13-product-trace-capability"),
		modelBrokerBindingRevision: immutableFact("model_broker_binding", "line13-product-trace-broker"),
		policyRevision: immutableFact("policy_binding", "line13-product-trace-policy"),
		newBindingId: "line13-product-trace-binding",
		now: () => NOW,
	});
	if (!resolved.ok) throw resolved.error;
	return resolved.value;
}

class TraceExternalConnector implements ExternalAgentConnector {
	readonly schemaVersion = 1 as const;
	readonly providerId = CONNECTOR_PROVIDER_ID;
	readonly providerClass = "external_connector" as const;
	readonly #snapshot: ConnectorCapabilitySnapshot;
	readonly #receipts = new Map<string, AttemptReceipt>();
	readonly #onRun: () => void;

	constructor(snapshot: ConnectorCapabilitySnapshot, onRun: () => void) {
		this.#snapshot = snapshot;
		this.#onRun = onRun;
	}

	async capabilities(): Promise<readonly FoundationProviderCapability[]> {
		return [{ schemaVersion: 1, id: SCHEDULER_IN_PROCESS_CAPABILITY_ID, version: 1 }];
	}

	async probeCapabilities(): Promise<ResultValue<ConnectorCapabilitySnapshot, FoundationError>> {
		return Result.ok(this.#snapshot);
	}

	async createAttempt(
		dispatch: Dispatch,
		_binding: AgentBinding,
		context?: TaskExecutorAttemptContext,
	): Promise<ResultValue<Attempt, FoundationError>> {
		if (context === undefined) return Result.err(new FoundationError("binding_epoch_mismatch", "Connector requires a binding epoch"));
		return createAttempt({
			attemptId: context.initialBindingEpoch.attemptId,
			dispatch,
			providerId: this.providerId,
			initialBindingEpoch: context.initialBindingEpoch,
			providerClass: this.providerClass,
			now: () => NOW,
		});
	}

	async runAttempt(attempt: Attempt, options?: FoundationProviderExecutionOptions): Promise<ResultValue<AttemptReceipt, FoundationError>> {
		if (options?.correlation === undefined) return Result.err(new FoundationError("invalid_correlation", "Connector requires Scheduler correlation"));
		this.#onRun();
		const attemptReceiptId = `attempt-receipt-${attempt.attemptId}`;
		const checked = validateAttemptReceiptForProvider({
			schemaVersion: 1,
			attemptReceiptId,
			taskId: attempt.taskId,
			dispatchId: attempt.dispatchId,
			attemptId: attempt.attemptId,
			providerId: this.providerId,
			bindingId: attempt.bindingId,
			bindingEpochIds: [...attempt.bindingEpochIds],
			status: "succeeded",
			workerReceiptRefs: [],
			artifacts: [],
			provenance: {
				producerKind: "external_connector",
				providerId: this.providerId,
				producedAt: NOW,
				correlation: { ...options.correlation, attemptReceiptId },
			},
			sideEffectState: "none",
		}, { providerId: this.providerId, providerClass: this.providerClass });
		if (checked.ok) this.#receipts.set(attempt.attemptId, checked.value);
		return checked;
	}

	async resumeAttempt(attempt: Attempt, options?: FoundationProviderExecutionOptions): Promise<ResultValue<AttemptReceipt, FoundationError>> {
		const receipt = this.#receipts.get(attempt.attemptId);
		return receipt === undefined ? this.runAttempt(attempt, options) : Result.ok(receipt);
	}

	async reconcileAttempt(attempt: Attempt, options?: FoundationProviderExecutionOptions): Promise<ResultValue<AttemptReceipt, FoundationError>> {
		return this.resumeAttempt(attempt, options);
	}

	async cancelAttempt(): Promise<ResultValue<void, FoundationError>> {
		return Result.ok(undefined);
	}

	async dispose(): Promise<void> {}
}

class ObservedSchedulerRegistry extends SchedulerExecutorRegistry {
	readonly #failure: Deferred<FoundationError>;

	constructor(reservations: SchedulerSelectionReservationStore, failure: Deferred<FoundationError>) {
		super({ reservationStore: reservations });
		this.#failure = failure;
	}

	override async select(input: SchedulerExecutorSelectionInputV1): Promise<ResultValue<SchedulerExecutorSelectionResultV1, FoundationError>> {
		const selected = await super.select(input);
		if (!selected.ok) this.#failure.resolve(selected.error);
		return selected;
	}
}

function createTraceSubagents(context: AgentRuntimeCompositionContext): TrustedSubagentCompositionOptionsV1 {
	const writer = context.harness.t5.writer;
	const memoryLedger = new SessionT5Ledger(context.session, {
		writer,
		memoryScopeId: `line13-memory-${context.sessionId}`,
		memoryOwnerId: `line13-parent-${context.sessionId}`,
		artifactBlobStore: new InMemoryArtifactBlobStore(),
	});
	const parentMemory = createScopedMemoryStore(memoryLedger.memory, "session", {
		ownerId: `line13-parent-${context.sessionId}`,
		scopeId: `line13-memory-${context.sessionId}`,
		createdBy: "system",
	}, {
		ownerId: `line13-parent-${context.sessionId}`,
		scopeId: `line13-memory-${context.sessionId}`,
	});
	const toolGateway: ToolGateway = {
		schemaVersion: 1,
		providerId: `line13-tool-gateway-${context.sessionId}`,
		providerClass: "gateway",
		capabilities: async () => [],
		execute: async () => Result.err(new FoundationError("tool_guard_denied", "Line 13 trace does not execute tools")),
		dispose: async () => {},
	};
	const quota: QuotaProvider = {
		schemaVersion: 1,
		providerId: `line13-quota-${context.sessionId}`,
		providerClass: "quota",
		capabilities: async () => [],
		reserve: async (attribution, budget) => Result.ok({ schemaVersion: 1, reservationId: `line13-quota-${context.sessionId}`, attribution, budget, grantedAt: NOW }),
		settle: async (_reservation, usage) => Result.ok(usage),
		dispose: async () => {},
	};
	const modelGateway: ScopedModelGateway = {
		schemaVersion: 1,
		providerId: `line13-model-gateway-${context.sessionId}`,
		providerClass: "gateway",
		capabilities: async () => [],
		stream: async () => Result.err(new FoundationError("tool_guard_denied", "Line 13 trace does not execute child models")),
		dispose: async () => {},
	};
	const artifactStore: ArtifactStoreProvider = {
		schemaVersion: 1,
		providerId: `line13-artifact-store-${context.sessionId}`,
		providerClass: "store",
		capabilities: async () => [],
		put: async () => Result.err(new FoundationError("tool_guard_denied", "Line 13 trace does not write child artifacts")),
		get: async () => Result.err(new FoundationError("tool_guard_denied", "Line 13 trace does not read child artifacts")),
		verify: async () => Result.ok({ schemaVersion: 1, digestValid: true }),
		delete: async () => Result.ok(undefined),
		dispose: async () => {},
	};
	const ledgerForLane = (laneId: string) => new SessionLedger(context.session, { writer, laneId });
	return {
		schemaVersion: 1,
		enabled: true,
		session: context.session,
		writer,
		ledger: ledgerForLane("main"),
		ledgerForLane,
		sessionId: context.sessionId,
		parentLaneId: "main",
		quota,
		modelGateway,
		toolGateway,
		artifactStore,
		createHarness: async () => context.harness,
		loadParentContext: async () => Result.err(new FoundationError("subagent_context_fork_invalid", "Line 13 trace does not spawn children")),
		parentMemory: { store: parentMemory, parentAgentInstanceId: `line13-parent-${context.sessionId}` },
		fork: { executable: process.execPath, entrypoint: process.execPath },
		limits: { maxDepth: 1, maxConcurrent: 1, maxTurns: 1, queueCapacity: 1, maximumQueueWaitMs: 100 },
		now: () => NOW,
	};
}

async function seedBindingFacts(session: Session, writer: SessionLedgerWriter, task: TaskEnvelope, binding: AgentBinding): Promise<void> {
	const ledger = new SessionLedger(session, { writer });
	try {
		await ledger.appendFact("task", task.taskId, task, { clientRequestId: "line13:task", expectedRevision: 0, correlation: { taskId: task.taskId, goalId: task.goalId } });
		await ledger.appendFact("role_revision", binding.roleRevision.id, traceRoleRevision(), { clientRequestId: "line13:role", expectedRevision: 0, correlation: { taskId: task.taskId, bindingId: binding.bindingId } });
		await ledger.appendFact("model_profile_revision", binding.modelProfileRevision.id, traceModelProfile(), { clientRequestId: "line13:model", expectedRevision: 0, correlation: { taskId: task.taskId, bindingId: binding.bindingId } });
		for (const [objectType, reference] of [
			["external_agent_binding", binding.contextRevision],
			["capability_binding", binding.capabilityRevision],
			["model_broker_binding", binding.modelBrokerBindingRevision],
			["policy_binding", binding.policyRevision],
		] as const) {
			await ledger.appendFact(objectType, reference.id, { schemaVersion: 1, type: reference.type, id: reference.id, revision: reference.revision }, {
				clientRequestId: `line13:${objectType}`,
				expectedRevision: 0,
				correlation: { taskId: task.taskId, bindingId: binding.bindingId },
			});
		}
	} finally {
		await ledger.release();
	}
}

function createRegistry(onRun: () => void): ExternalConnectorRegistry {
	const snapshot = createConnectorCapabilitySnapshot({
		schemaVersion: 1,
		providerId: CONNECTOR_PROVIDER_ID,
		revision: 1,
		protocol: { name: "line13-product-trace", version: "1" },
		modelAccess: "none",
		resume: true,
		toolGateway: false,
		artifacts: false,
		images: false,
	});
	const registry = createExternalConnectorRegistry();
	const registered = registry.registerPrepared({
		descriptor: { schemaVersion: 1, providerId: snapshot.providerId, providerClass: "external_connector", revision: snapshot.revision, capabilitySnapshotDigest: snapshot.digest },
		connector: new TraceExternalConnector(snapshot, onRun),
	}, snapshot);
	if (!registered.ok) throw registered.error;
	return registry;
}

function createSchedulerFixture(
	context: AgentRuntimeCompositionContext,
	sourceManager: SessionManager,
	reservations: SchedulerSelectionReservationStore,
	onRun: () => void,
): SchedulerFixture {
	const completion = createDeferred<void>();
	const failure = createDeferred<FoundationError>();
	const task = traceTask();
	const binding = traceBinding(task);
	const registry = createRegistry(onRun);
	const runLifecycle = createRunLifecycleCoordinator(sourceManager, { now: () => NOW });
	const runs = new Map<string, RunHandle>();
	const writer = context.harness.t5.writer;
	const hostSettlement = new LayeredResultSettlement(context.session, { writer });
	const targetManager = SessionManager.inMemory(context.sessionId, { id: `line13-target-${context.sessionId}` });
	const targetSession = new Session(createSessionManagerStorage(targetManager));
	const emptyRunLookup = { get: () => undefined };
	const emptyGateLookup = { getByBusinessKey: () => undefined };
	const fixture = {
		sourceSession: context.session,
		sourceGraph: new TaskGraphStore(sourceManager, emptyRunLookup, emptyGateLookup, { now: () => NOW }),
		writer,
		task,
		binding,
		registry,
		completion,
		failure,
		wake: undefined,
	} as SchedulerFixture;
	const scheduler: TrustedSchedulerRuntimeOptions = {
		schemaVersion: 1,
		enabled: true,
		sourceSession: context.session,
		targetSession,
		targetSessionId: targetManager.getSessionId(),
		targetGraph: new TaskGraphStore(targetManager, emptyRunLookup, emptyGateLookup, { now: () => NOW }),
		ownerId: reservations.ownerId,
		writer,
		registry: new ObservedSchedulerRegistry(reservations, failure),
		task,
		binding,
		gateLookup: emptyGateLookup,
		resolveRunAssociation: async () => {
			let run = runs.get(RUN_ID);
			if (run === undefined) {
				run = runLifecycle.reserve().accept({ runId: RUN_ID, attempt: 1, model: { provider: "line13-host", id: "line13-host", thinkingLevel: "off" } });
				run.start();
				runs.set(RUN_ID, run);
			}
			return Result.ok({
				runId: RUN_ID,
				task,
				binding,
				executorRequirements: {
					requireResume: true,
					modelAccess: "none",
					credentialTargetRefs: [],
					sandboxTargetRefs: [],
				},
			});
		},
		settleRunAtHost: async (input) => {
			const run = runs.get(input.runId);
			if (run === undefined || input.taskResult === undefined) return Result.err(new FoundationError("scheduler_not_found", "Canonical Scheduler terminal input is unavailable"));
			const finalized = await hostSettlement.finalize({
					runReceiptId: "line13-product-trace-run-receipt",
					runId: input.runId,
					terminalStatus: "completed",
					authority: createHostTerminalGateAuthority("line13-product-trace-host"),
					attemptReceiptIds: input.taskResult.sourceAttemptReceiptIds,
					taskResultId: input.taskResult.taskResultId,
					usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
					completedAt: NOW,
			});
			if (!finalized.ok) return finalized;
			const canonical = await hostSettlement.lookupCanonicalRun(input.runId);
			if (!canonical.ok) return canonical;
			if (canonical.value === undefined) return Result.err(new FoundationError("scheduler_not_found", "Canonical Run result is unavailable"));
			run.observeCanonicalResult(canonical.value);
			completion.resolve(undefined);
			return Result.ok(undefined);
		},
		eventSource: {
			subscribe(wake) {
				fixture.wake = wake;
				return () => { fixture.wake = undefined; };
			},
		},
		pollIntervalMs: 60_000,
		now: () => NOW,
	};
	Object.defineProperty(fixture, "scheduler", { value: scheduler, enumerable: true });
	return fixture;
}

async function createTraceRuntime(
	workDirectory: string,
	authStorage: AuthStorage,
	model: FauxModel,
	onRun: () => void,
	withScheduler: boolean,
): Promise<TraceRuntime> {
	const pendingManagers: Array<{ readonly manager: SessionManager; fixture?: SchedulerFixture }> = [];
	const byFoundationSession = new WeakMap<Session, SchedulerFixture>();
	const byAgentSession = new WeakMap<AgentSession, SchedulerFixture>();
	const targetConfig = buildExternalConnectorTargetConfig({
		managed: { schemaVersion: 1, targets: [{
			schemaVersion: 1,
			targetId: "line13-product-trace-target",
			providerId: CONNECTOR_PROVIDER_ID,
			executablePath: process.execPath,
			modulePath: process.execPath,
			cwd: workDirectory,
			version: "1.0.0",
			executableIdentity: `sha256:${"a".repeat(64)}`,
			moduleIdentity: `sha256:${"b".repeat(64)}`,
			capabilityCeiling: { modelAccess: ["none"], resume: true, toolGateway: false, artifacts: false, images: false },
		}] },
		explicitTargetId: "line13-product-trace-target",
	});
	const runtimeComposition = createAgentRuntimeCompositionFactory({
		externalConnectorTargetConfig: targetConfig,
		...(withScheduler ? { subagents: createTraceSubagents } : {}),
		...(withScheduler ? { scheduler: (context: AgentRuntimeCompositionContext, reservations: SchedulerSelectionReservationStore) => {
			const pending = pendingManagers[0];
			if (pending === undefined) throw new Error("Scheduler SessionManager is unavailable");
			const fixture = createSchedulerFixture(context, pending.manager, reservations, onRun);
			pending.fixture = fixture;
			byFoundationSession.set(context.session, fixture);
			return fixture.scheduler;
		} } : {}),
		externalConnectorRegistry: (context) => {
			if (!withScheduler) return createRegistry(onRun);
			const fixture = byFoundationSession.get(context.session);
			if (fixture === undefined) throw new Error("Connector registry is unavailable");
			return fixture.registry;
		},
	});
	const runtimeOptions = {
		agentDir: workDirectory,
		authStorage,
		model,
		runtimeComposition,
		resourceLoaderOptions: {
			extensionFactories: [(agent: ExtensionAPI) => {
				agent.registerProvider(model.provider, {
					baseUrl: model.baseUrl,
					apiKey: "line13-faux-key",
					api: model.api,
					models: [{ id: model.id, name: model.name, api: model.api, reasoning: model.reasoning, input: model.input, cost: model.cost, contextWindow: model.contextWindow, maxTokens: model.maxTokens }],
				});
			}],
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
		},
	};
	const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent, registerCandidateSession }) => {
		const pending: { readonly manager: SessionManager; fixture?: SchedulerFixture } = { manager: sessionManager };
		pendingManagers.push(pending);
		try {
			const services = await createAgentSessionServices({ ...runtimeOptions, cwd });
			const created = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model });
			if (withScheduler && pending.fixture === undefined) throw new Error("Scheduler fixture was not materialized");
			if (pending.fixture !== undefined) byAgentSession.set(created.session, pending.fixture);
			registerCandidateSession(created.session);
			return { ...created, services, diagnostics: services.diagnostics };
		} finally {
			const index = pendingManagers.indexOf(pending);
			if (index >= 0) pendingManagers.splice(index, 1);
		}
	};
	const runtime = await createAgentSessionRuntime(createRuntime, { cwd: workDirectory, agentDir: workDirectory, session: { mode: "new" } });
	await runtime.session.bindExtensions({});
	return {
		runtime,
		fixtureFor(session) {
			const fixture = byAgentSession.get(session);
			if (fixture === undefined) throw new Error("Current Scheduler fixture is unavailable");
			return fixture;
		},
	};
}

async function executeConnectorTrace(runtime: AgentSessionRuntime, fixture: SchedulerFixture): Promise<void> {
	await seedBindingFacts(fixture.sourceSession, fixture.writer, fixture.task, fixture.binding);
	fixture.sourceGraph.create({ taskId: fixture.task.taskId, graphRevision: GRAPH_REVISION, nodes: [{ nodeId: "connector", dependsOn: [] }], clientRequestId: "line13:create-graph" });
	if (fixture.wake === undefined) throw new Error("Scheduler Host wake source is unavailable");
	fixture.wake();
	await Promise.race([fixture.completion.promise, fixture.failure.promise.then((error) => { throw error; })]);
	while (runtime.session.getSchedulerStatus()?.tickInFlight === true) await new Promise<void>((resolve) => setTimeout(resolve, 0));
	await runtime.session.waitForIdle();
	if (fixture.sourceGraph.get(TASK_ID, GRAPH_REVISION)?.nodes[0]?.status !== "succeeded") throw new Error("Scheduler graph did not settle");
}

async function readCanonicalClosure(runtime: AgentSessionRuntime): Promise<Line13CanonicalClosureSnapshot> {
	const composition = runtime.runtimeComposition;
	const harness = composition.harness;
	const statuses = runtime.session.getExternalConnectorRegistry()?.runtimeStatus() ?? [];
	const activeConnectorWork = statuses.reduce((count, status) => status.availability === "available" ? count + status.activity.active + status.activity.queued + status.activity.reconcile : count, 0);
	const credentials = runtime.session.getTaskCredentialService()?.snapshot() ?? [];
	const reservations = await composition.schedulerSelectionReservations?.list();
	if (reservations !== undefined && !reservations.ok) throw reservations.error;
	return Object.freeze({
		activeRuns: (harness.isRunning ? 1 : 0) + activeConnectorWork,
		backlog: harness.pendingMessageCount + harness.durablePendingMessageCount,
		status: statuses.filter((status) => status.readiness.state === "ready").length,
		credentials: credentials.filter((credential) => credential.status === "active").length,
		reservations: reservations?.value.filter((reservation) => reservation.status === "reserved").length ?? 0,
		processes: runtime.session.getWorkerRegistry()?.listWorkerRecords().filter((worker) => worker.status === "running").length ?? 0,
		timers: runtime.session.getSchedulerStatus()?.tickInFlight === true ? 1 : 0,
		files: runtime.session.sessionFile !== undefined && existsSync(runtime.session.sessionFile) ? 1 : 0,
		pendingWrites: harness.hasPendingExternalMessages ? 1 : 0,
	});
}

function recordField(value: unknown, field: string): unknown {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)[field]
		: undefined;
}

async function readCanonicalRecords(runtime: AgentSessionRuntime, operation: TraceOperation): Promise<Line13CanonicalRecordSnapshot> {
	const session = runtime.runtimeComposition.session;
	const [allAttempts, allReceipts, allTaskResults, allRunReceipts] = await Promise.all([
		session.findFoundationRecords({ kind: "fact", objectType: "attempt" }),
		session.findFoundationRecords({ kind: "fact", objectType: "attempt_receipt" }),
		session.findFoundationRecords({ kind: "fact", objectType: "task_result" }),
		session.findFoundationRecords({ kind: "fact", objectType: "run_receipt" }),
	]);
	const attempts = allAttempts.filter((record) => record.kind === "fact" && recordField(record.payload, "providerId") === CONNECTOR_PROVIDER_ID);
	const receipts = allReceipts.filter((record) => record.kind === "fact" && recordField(record.payload, "providerId") === CONNECTOR_PROVIDER_ID);
	const taskResults = allTaskResults.filter((record) => record.kind === "fact" && recordField(record.payload, "taskId") === TASK_ID);
	const runReceipts = allRunReceipts.filter((record) => record.kind === "fact" && recordField(record.payload, "runId") === RUN_ID);
	if (attempts.length !== 1 || receipts.length !== 1 || taskResults.length !== 1 || runReceipts.length !== 1) throw new Error(`Canonical result chain did not persist across ${operation}: ${attempts.length}/${receipts.length}/${taskResults.length}/${runReceipts.length}`);
	const attempt = validateAttempt(attempts[0]?.kind === "fact" ? attempts[0].payload : undefined);
	const receipt = validateAttemptReceiptForProvider(receipts[0]?.kind === "fact" ? receipts[0].payload : undefined, { providerId: CONNECTOR_PROVIDER_ID, providerClass: "external_connector" });
	const taskResult = validateTaskResult(taskResults[0]?.kind === "fact" ? taskResults[0].payload : undefined);
	const runReceipt = validateRunReceipt(runReceipts[0]?.kind === "fact" ? runReceipts[0].payload : undefined);
	if (!attempt.ok) throw attempt.error;
	if (!receipt.ok) throw receipt.error;
	if (!taskResult.ok) throw taskResult.error;
	if (!runReceipt.ok) throw runReceipt.error;
	if (
		attempt.value.providerId !== CONNECTOR_PROVIDER_ID ||
		receipt.value.attemptId !== attempt.value.attemptId ||
		receipt.value.status !== "succeeded" ||
		taskResult.value.taskId !== attempt.value.taskId ||
		taskResult.value.status !== "succeeded" ||
		taskResult.value.provenance.producerKind !== "host" ||
		taskResult.value.sourceAttemptReceiptIds.length !== 1 ||
		taskResult.value.sourceAttemptReceiptIds[0] !== receipt.value.attemptReceiptId ||
		runReceipt.value.runId !== RUN_ID ||
		runReceipt.value.terminalStatus !== "completed" ||
		runReceipt.value.taskResultId !== taskResult.value.taskResultId ||
		runReceipt.value.attemptReceiptIds.length !== 1 ||
		runReceipt.value.attemptReceiptIds[0] !== receipt.value.attemptReceiptId
	) throw new Error(`Canonical result correlation did not persist across ${operation}`);
	return Object.freeze({ operation, attempts: 1, attemptReceipts: 1, taskResults: 1, runReceipts: 1, attemptId: attempt.value.attemptId, attemptReceiptId: receipt.value.attemptReceiptId, taskResultId: taskResult.value.taskResultId, runReceiptId: runReceipt.value.runReceiptId, runId: RUN_ID, providerId: CONNECTOR_PROVIDER_ID });
}

function assertClosed(snapshot: Line13CanonicalClosureSnapshot): void {
	for (const [owner, count] of Object.entries(snapshot)) {
		if (owner === "files") {
			if (count > 1) throw new Error(`Canonical ${owner} owner retained ${count} resources`);
		} else if (owner === "status") {
			if (count !== 1) throw new Error(`Canonical ${owner} owner retained ${count} resources`);
		} else if (count !== 0) throw new Error(`Canonical ${owner} owner retained ${count} resources`);
	}
}

/** Drive the packaged product composition and read only its canonical owners. */
export async function runPackagedLine13ProductTrace(options: Line13ProductTraceOptions): Promise<Line13ProductTraceResult> {
	const iterations = options.iterations ?? 28;
	if (!Number.isSafeInteger(iterations) || iterations < LINE13_PRODUCT_TRACE_OPERATIONS.length) throw new RangeError(`iterations must be at least ${LINE13_PRODUCT_TRACE_OPERATIONS.length}`);
	mkdirSync(options.workDirectory, { recursive: true });
	const faux = registerFauxProvider();
	const restartCount = Array.from({ length: iterations }, (_, index) => LINE13_PRODUCT_TRACE_OPERATIONS[index % LINE13_PRODUCT_TRACE_OPERATIONS.length]).filter((operation) => operation === "restart").length;
	faux.setResponses(Array.from({ length: iterations - restartCount }, (_, index) => fauxAssistantMessage(`trace-${index}`)));
	const authStorage = AuthStorage.inMemory();
	const model = faux.getModel();
	await authStorage.modify(model.provider, async () => ({ type: "api_key", key: "line13-faux-key" }));
	let attemptExecutions = 0;
	const onRun = () => { attemptExecutions += 1; };
	let controller = await createTraceRuntime(options.workDirectory, authStorage, model, onRun, true);
	let runtime = controller.runtime;
	const operations = Object.fromEntries(LINE13_PRODUCT_TRACE_OPERATIONS.map((operation) => [operation, 0])) as Record<TraceOperation, number>;
	const samples: Line13CanonicalClosureSnapshot[] = [];
	const canonicalRecords: Line13CanonicalRecordSnapshot[] = [];
	let initialTraceExecuted = false;
	try {
		for (let iteration = 0; iteration < iterations; iteration += 1) {
			const operation = LINE13_PRODUCT_TRACE_OPERATIONS[iteration % LINE13_PRODUCT_TRACE_OPERATIONS.length];
			operations[operation] += 1;
			if (operation === "run") {
				if (!initialTraceExecuted) {
					await executeConnectorTrace(runtime, controller.fixtureFor(runtime.session));
					const sessionFile = runtime.session.sessionFile;
					if (sessionFile === undefined) throw new Error("Connector trace did not publish a canonical Session file");
					await runtime.dispose();
					controller = await createTraceRuntime(options.workDirectory, authStorage, model, onRun, false);
					runtime = controller.runtime;
					await runtime.switchSession(sessionFile);
					initialTraceExecuted = true;
				}
				await runtime.session.prompt(`line13 product run ${iteration}`);
			} else if (operation === "cancel") {
				const prompt = runtime.session.prompt(`line13 product cancel ${iteration}`);
				await runtime.session.abort();
				await prompt.catch(() => undefined);
			} else if (operation === "restart") {
				const sessionFile = runtime.session.sessionFile;
				await runtime.dispose();
				controller = await createTraceRuntime(options.workDirectory, authStorage, model, onRun, false);
				runtime = controller.runtime;
				if (sessionFile !== undefined) await runtime.switchSession(sessionFile);
			} else {
				await runtime.session.prompt(`line13 product ${operation} ${iteration}`);
				const sessionFile = runtime.session.sessionFile;
				if (sessionFile === undefined) throw new Error(`${operation} did not publish a canonical Session file`);
				if (operation === "switch") {
					const target = join(options.workDirectory, `switch-${iteration}.jsonl`);
					copyFileSync(sessionFile, target);
					await runtime.switchSession(target);
				} else if (operation === "fork") {
					const entryId = runtime.session.getUserMessagesForForking().at(-1)?.entryId;
					if (entryId === undefined) throw new Error("Product fork source is unavailable");
					await runtime.fork(entryId);
					const forkFile = runtime.session.sessionFile;
					if (forkFile === undefined) throw new Error("Product fork did not publish a canonical Session file");
					await runtime.dispose();
					controller = await createTraceRuntime(options.workDirectory, authStorage, model, onRun, true);
					runtime = controller.runtime;
					await runtime.switchSession(forkFile);
					await executeConnectorTrace(runtime, controller.fixtureFor(runtime.session));
					const tracedForkFile = runtime.session.sessionFile;
					if (tracedForkFile === undefined) throw new Error("Fork replacement trace did not publish a canonical Session file");
					await runtime.dispose();
					controller = await createTraceRuntime(options.workDirectory, authStorage, model, onRun, false);
					runtime = controller.runtime;
					await runtime.switchSession(tracedForkFile);
				} else if (operation === "import") {
					const target = join(options.workDirectory, `import-${iteration}.jsonl`);
					copyFileSync(sessionFile, target);
					await runtime.importFromJsonl(target);
				} else await runtime.reload();
			}
			await runtime.session.waitForIdle();
			const sample = await readCanonicalClosure(runtime);
			assertClosed(sample);
			samples.push(sample);
			canonicalRecords.push(await readCanonicalRecords(runtime, operation));
		}
		const final = await readCanonicalClosure(runtime);
		assertClosed(final);
		const currentRegistrySize = runtime.session.getExternalConnectorRegistry()?.list().length;
		if (currentRegistrySize !== 1 || attemptExecutions !== 1 + operations.fork) throw new Error("Connector execution did not match the Scheduler and fork replacement traces");
		return Object.freeze({
			schemaVersion: 1,
			entrypoint: "aos-agent/external-connector",
			adapter: "standard_product_composition",
			iterations,
			operations: Object.freeze({ ...operations }),
			canonicalOwners: Object.freeze(["agent_harness", "external_connector_registry", "task_credential_service", "scheduler_selection_reservations", "worker_registry", "scheduler_status", "session_manager"] as const),
			samples: Object.freeze(samples),
			canonicalRecords: Object.freeze(canonicalRecords),
			final,
			connector: Object.freeze({ providerId: CONNECTOR_PROVIDER_ID, currentRegistrySize, attemptExecutions }),
			provider: Object.freeze({ kind: "faux", pendingResponses: faux.getPendingResponseCount() }),
		});
	} finally {
		await runtime.dispose();
		faux.unregister();
		for (const name of ["switch", "import"]) for (let index = 0; index < iterations; index += 1) {
			const path = join(options.workDirectory, `${name}-${index}.jsonl`);
			if (existsSync(path)) rmSync(path, { force: true });
		}
	}
}
