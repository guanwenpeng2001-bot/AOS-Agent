import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	InMemorySessionStorage,
	LayeredResultSettlement,
	FoundationError,
	Result,
	Session,
	SessionLedger,
	SessionT5Ledger,
	createAttempt,
	createConnectorCapabilitySnapshot,
	validateAttemptReceiptForProvider,
	type AgentBinding,
	type Attempt,
	type Dispatch,
	type ExternalAgentConnector,
	type FoundationProviderExecutionOptions,
	type TaskExecutorAttemptContext,
	type TaskEnvelope,
} from "@aos-agent/agent-core";
import { fauxAssistantMessage, registerFauxProvider } from "@aos-agent/ai/compat";
import * as codingAgentEntry from "../../src/index.ts";
import {
	createAgentSession,
	createAgentSessionFromServices,
	createAgentSessionServices,
	createExternalConnectorRegistry,
	executeExternalConnectorProductRun,
	SchedulerExecutorRegistry,
	SchedulerQueueStore,
	type CreateAgentSessionRuntimeFactory,
	type ExternalConnectorRegistry,
	type TrustedSchedulerRuntimeOptions,
} from "../../src/index.ts";
import { createDurableExternalAgentConnector } from "../../src/core/external-agent-connector.ts";
import { SessionExternalConnectorDurableStore } from "../../src/core/external-agent-operation.ts";
import type {
	ExternalConnectorDriverHandle,
	ExternalConnectorDriverLookup,
	ExternalConnectorDriverSpawnRequest,
	ExternalConnectorDriverWriteRequest,
	ExternalConnectorTerminalEvidence,
	ExternalConnectorVendorDriver,
} from "../../src/core/vendor-drivers/types.ts";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { createAgentSessionRuntimeFromManager } from "../../src/core/agent-session-runtime.ts";
import { ModelRuntime } from "../../src/core/model-runtime.ts";
import { createRunLifecycleCoordinator, type RunHandle, type RunResult } from "../../src/core/run-lifecycle.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { SessionManagerStorage } from "../../src/core/session-manager-storage.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import { SUBAGENT_PROVIDER_KINDS } from "../../src/core/subagent.ts";
import { TaskGraphStore } from "../../src/core/task-graph.ts";
import {
	RpcHostController,
	type RpcHostOutputRecord,
	type RpcHostOutputSink,
} from "../../src/modes/rpc/rpc-host.ts";
import {
	defineLine13KnownGapCase,
	defineLine13KnownGapCaseShard,
	defineLine13ResolvedCase,
	LINE13_T0_BASE_SHA,
} from "../support/line13-known-gaps.ts";
import { createExternalConnectorTestSupervision } from "../external-connector-test-supervision.ts";

const NOW = "2026-08-25T00:00:00.000Z";
const LATER = "2026-08-25T00:06:00.000Z";


class Line13CurrentDriver implements ExternalConnectorVendorDriver {
	async spawn(request: ExternalConnectorDriverSpawnRequest): Promise<ExternalConnectorDriverHandle> {
		return {
			externalSessionId: "line13-current-session",
			externalTurnId: "line13-current-turn",
			supervisorRef: request.supervisorRef,
			operationNonce: request.operationNonce,
		};
	}

	events(): AsyncIterable<never> {
		return {
			[Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: undefined }) }),
		};
	}

	async connect(): Promise<ExternalConnectorDriverHandle> {
		return {
			externalSessionId: "line13-current-session",
			externalTurnId: "line13-current-turn",
			supervisorRef: "line13-current-supervisor",
			operationNonce: "line13-operation-nonce",
		};
	}

	async lookup(): Promise<ExternalConnectorDriverLookup> { return { status: "missing" }; }

	async read(handle: ExternalConnectorDriverHandle): Promise<ExternalConnectorTerminalEvidence> {
		return {
			externalSessionId: handle.externalSessionId,
			externalTurnId: handle.externalTurnId,
			operationNonce: handle.operationNonce,
			status: "succeeded",
			artifacts: [],
			sideEffectState: "none",
			producedAt: NOW,
		};
	}

	async write(_handle: ExternalConnectorDriverHandle, _request: ExternalConnectorDriverWriteRequest): Promise<void> {}
	async heartbeat(): Promise<void> {}
	async cancel(): Promise<ExternalConnectorTerminalEvidence | undefined> { return undefined; }
	async dispose(): Promise<void> {}
}

interface RpcProductFixture {
	readonly controller: RpcHostController;
	readonly records: RpcHostOutputRecord[];
	readonly sessionManager: SessionManager;
	readonly externalConnectorSelection: {
		readonly providerId: string;
		readonly revision: number;
		readonly capabilitySnapshotDigest: { readonly algorithm: "sha256"; readonly value: string };
	};
	readonly reopen: () => Promise<RpcHostController>;
	readonly cleanup: () => Promise<void>;
}

async function createRpcProductFixture(options: {
	readonly withModel: boolean;
	readonly modelAccess?: "none" | "agent_owned";
}): Promise<RpcProductFixture> {
	const cwd = mkdtempSync(join(tmpdir(), "aos-line13-rpc-"));
	const faux = options.withModel ? registerFauxProvider() : undefined;
	const model = faux?.getModel();
	if (faux !== undefined) faux.setResponses([fauxAssistantMessage("line13-ok")]);
	const credentials = AuthStorage.inMemory();
	if (model !== undefined) {
		await credentials.modify(model.provider, async () => ({ type: "api_key", key: "line13-key" }));
	}
	const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: null });
	if (model !== undefined) {
		modelRuntime.registerProvider(model.provider, {
			baseUrl: model.baseUrl,
			api: model.api,
			models: [model],
		});
	}
	const settingsManager = SettingsManager.inMemory();
	const currentSnapshot = createConnectorCapabilitySnapshot({
		schemaVersion: 1,
		providerId: "line13-current-connector",
		revision: 1,
		protocol: { name: "line13-current", version: "1" },
		modelAccess: options.modelAccess ?? "agent_owned",
		resume: false,
		toolGateway: false,
		artifacts: false,
		images: false,
	});
	const runtimeComposition = codingAgentEntry.createAgentRuntimeCompositionFactory({
			externalConnectorRegistry: (context) => {
			const registry = createExternalConnectorRegistry();
			const connector = createDurableExternalAgentConnector({
				providerId: currentSnapshot.providerId,
				capability: currentSnapshot,
				store: new SessionExternalConnectorDurableStore(new SessionLedger(context.session, { writer: context.harness.t5.writer })),
				driver: new Line13CurrentDriver(),
				supervision: createExternalConnectorTestSupervision().options,
				now: () => NOW,
				operationNonce: () => "line13-operation-nonce",
			});
			const registered = registry.registerPrepared({
				descriptor: {
					schemaVersion: 1,
					providerId: currentSnapshot.providerId,
					providerClass: "external_connector",
					revision: currentSnapshot.revision,
					capabilitySnapshotDigest: currentSnapshot.digest,
				},
				connector,
				trusted: true,
			}, currentSnapshot);
			if (!registered.ok) throw registered.error;
			return registry;
		},
	});
	const services = await createAgentSessionServices({
		cwd,
		agentDir: cwd,
		modelRuntime,
		settingsManager,
		runtimeComposition,
		resourceLoaderOptions: {
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		},
	});
	const sessionManager = SessionManager.inMemory(cwd);
	const createRuntime: CreateAgentSessionRuntimeFactory = async (runtimeOptions) => {
		const created = await createAgentSession({
			cwd: runtimeOptions.cwd,
			agentDir: runtimeOptions.agentDir,
			model,
			modelRuntime: services.modelRuntime,
			modelBroker: services.modelBroker,
			modelBrokerConfigRevision: services.modelBrokerConfigRevision,
			settingsManager: services.settingsManager,
			resourceLoader: services.resourceLoader,
			capabilityRegistry: services.capabilityRegistry,
			sessionManager: runtimeOptions.sessionManager,
			runtimeComposition,
			noTools: "all",
		});
		runtimeOptions.registerCandidateSession(created.session);
		return { ...created, services, diagnostics: services.diagnostics };
	};
	const runtime = await createAgentSessionRuntimeFromManager(createRuntime, {
		cwd,
		agentDir: cwd,
		sessionManager,
	});
	const records: RpcHostOutputRecord[] = [];
	const controller = new RpcHostController(runtime, {
		output: { publish: (record) => records.push(record) } as RpcHostOutputSink,
	});
	await controller.start();
	let activeController = controller;
	return {
		controller,
		records,
		sessionManager,
		externalConnectorSelection: {
			providerId: currentSnapshot.providerId,
			revision: currentSnapshot.revision,
			capabilitySnapshotDigest: currentSnapshot.digest,
		},
		reopen: async () => {
			await activeController.shutdown();
			const reopenedRuntime = await createAgentSessionRuntimeFromManager(createRuntime, {
				cwd,
				agentDir: cwd,
				sessionManager,
			});
			activeController = new RpcHostController(reopenedRuntime, {
				output: { publish: (record) => records.push(record) } as RpcHostOutputSink,
			});
			await activeController.start();
			return activeController;
		},
		cleanup: async () => {
			try {
				await activeController.shutdown();
			} finally {
				faux?.unregister();
				rmSync(cwd, { recursive: true, force: true });
			}
		},
	};
}

async function initializeRpc(fixture: RpcProductFixture): Promise<void> {
	const response = await fixture.controller.dispatch({ type: "initialize", protocolVersion: 1 });
	if (response === undefined || !("success" in response) || response.success !== true) {
		throw new Error("Line 13 RPC fixture failed to initialize");
	}
}

interface AutomationResponseView {
	readonly success?: boolean;
	readonly data?: {
		readonly runId?: string;
		readonly status?: string;
		readonly receipt?: { readonly status?: string };
	};
	readonly error?: { readonly code?: string };
}

function automationResponseView(value: unknown): AutomationResponseView {
	if (typeof value !== "object" || value === null) return {};
	return value as AutomationResponseView;
}

async function waitForRpcTerminal(records: readonly RpcHostOutputRecord[], runId: string): Promise<void> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		const terminal = records.find((record) => {
			const view = record as unknown as { readonly type?: string; readonly runId?: string };
			return (
				view.runId === runId &&
				(view.type === "run.completed" || view.type === "run.failed" || view.type === "run.cancelled")
			);
		});
		if (terminal !== undefined) return;
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	throw new Error("Line 13 RPC fixture did not reach a terminal event");
}

async function waitForRpcResponse(records: readonly RpcHostOutputRecord[], id: string): Promise<RpcHostOutputRecord> {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		const response = records.find((record) => record.type === "response" && record.id === id);
		if (response !== undefined) return response;
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
	throw new Error(`Line 13 RPC fixture did not publish response ${id}`);
}

interface ProductCompositionEvidence {
	readonly sdk: boolean;
	readonly services: boolean;
	readonly main: boolean;
	readonly tui: boolean;
	readonly print: boolean;
	readonly rpc: boolean;
}

interface ProductCompositionFixture {
	readonly evidence: ProductCompositionEvidence;
	readonly registries: readonly ExternalConnectorRegistry[];
	readonly cleanup: () => Promise<void>;
}

function createCompositionConnectorRegistry(): ExternalConnectorRegistry {
	const snapshot = createConnectorCapabilitySnapshot({
		schemaVersion: 1,
		providerId: "line13-connector",
		revision: 1,
		protocol: { name: "line13-composition", version: "1" },
		modelAccess: "none",
		resume: false,
		toolGateway: false,
		artifacts: false,
		images: false,
	});
	const unsupported = new FoundationError("unsupported_feature", "composition fixture is discovery-only");
	const connector: ExternalAgentConnector = {
		schemaVersion: 1,
		providerId: snapshot.providerId,
		providerClass: "external_connector",
		capabilities: async () => [],
		dispose: async () => {},
		probeCapabilities: async () => Result.ok(snapshot),
		createAttempt: async () => Result.err(unsupported),
		runAttempt: async () => Result.err(unsupported),
		cancelAttempt: async () => Result.err(unsupported),
		resumeAttempt: async () => Result.err(unsupported),
		reconcileAttempt: async () => Result.err(unsupported),
	};
	const registry = createExternalConnectorRegistry();
	const registered = registry.registerPrepared({
		descriptor: {
			schemaVersion: 1,
			providerId: snapshot.providerId,
			providerClass: "external_connector",
			revision: snapshot.revision,
			capabilitySnapshotDigest: snapshot.digest,
		},
		connector,
		trusted: true,
	}, snapshot);
	if (!registered.ok) throw registered.error;
	return registry;
}

async function createProductCompositionFixture(): Promise<ProductCompositionFixture> {
	const cwd = mkdtempSync(join(tmpdir(), "aos-line13-services-"));
	const modelRuntime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null });
	const settingsManager = SettingsManager.inMemory();
	const registries: ExternalConnectorRegistry[] = [];
	const runtimeComposition = codingAgentEntry.createAgentRuntimeCompositionFactory({
		externalConnectorRegistry: () => {
			const registry = createCompositionConnectorRegistry();
			registries.push(registry);
			return registry;
		},
	});
	const servicesOptions: Parameters<typeof createAgentSessionServices>[0] = {
		cwd,
		agentDir: cwd,
		modelRuntime,
		settingsManager,
		runtimeComposition,
		resourceLoaderOptions: {
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		},
	};
	const services = await codingAgentEntry.createAgentSessionServices(servicesOptions);
	const sdk = await codingAgentEntry.createAgentSession({
		cwd,
		agentDir: cwd,
		modelRuntime: services.modelRuntime,
		modelBroker: services.modelBroker,
		modelBrokerConfigRevision: services.modelBrokerConfigRevision,
		settingsManager: services.settingsManager,
		resourceLoader: services.resourceLoader,
		capabilityRegistry: services.capabilityRegistry,
		sessionManager: SessionManager.inMemory(cwd, { id: "line13-sdk-surface" }),
		runtimeComposition,
		noTools: "all",
	});
	const sessionOptions: Parameters<typeof createAgentSessionFromServices>[0] = {
		services,
		sessionManager: SessionManager.inMemory(cwd, { id: "line13-services-surface" }),
		noTools: "all",
	};
	const servicesCreated = await codingAgentEntry.createAgentSessionFromServices(sessionOptions);
	const createRuntime: CreateAgentSessionRuntimeFactory = async (runtimeOptions) => {
		const runtimeSessionOptions: Parameters<typeof codingAgentEntry.createAgentSessionFromServices>[0] = {
			services,
			sessionManager: runtimeOptions.sessionManager,
			sessionStartEvent: runtimeOptions.sessionStartEvent,
			noTools: "all",
		};
		const created = await codingAgentEntry.createAgentSessionFromServices(runtimeSessionOptions);
		runtimeOptions.registerCandidateSession(created.session);
		return { ...created, services, diagnostics: services.diagnostics };
	};
	const createSurfaceRuntime = (id: string) =>
		codingAgentEntry.createAgentSessionRuntime(createRuntime, {
			cwd,
			agentDir: cwd,
			session: { mode: "memory", id },
		});

	const mainRuntime = await createSurfaceRuntime("line13-main-surface");
	const interactiveMode = new codingAgentEntry.InteractiveMode(mainRuntime, { tuiMode: "regular" });
	const mainHasRegistry =
		typeof codingAgentEntry.main === "function" &&
		services.runtimeComposition === runtimeComposition &&
		mainRuntime.runtimeComposition.externalConnectorRegistry === mainRuntime.session.getExternalConnectorRegistry() &&
		mainRuntime.runtimeComposition.externalConnectorRegistry?.list().length === 1;
	const tuiHasRegistry = mainRuntime.runtimeComposition === mainRuntime.session.agentRuntimeComposition;
	interactiveMode.stop("transcript");

	const rpcRuntime = await createSurfaceRuntime("line13-rpc-surface");
	const rpcController = codingAgentEntry.createRpcHostController(rpcRuntime);
	await rpcController.start();
	const rpcInitialize = (await rpcController.dispatch({
		id: "ac04-rpc-initialize",
		type: "initialize",
		protocolVersion: 1,
	})) as unknown as {
		readonly success?: boolean;
		readonly data?: {
			readonly externalConnectors?: ReadonlyArray<{ readonly providerId?: string }>;
		};
	};

	const printRuntime = await createSurfaceRuntime("line13-print-surface");
	const printHasRegistry =
		printRuntime.runtimeComposition.externalConnectorRegistry === printRuntime.session.getExternalConnectorRegistry() &&
		printRuntime.runtimeComposition.externalConnectorRegistry?.list().length === 1;
	const printExitCode = await codingAgentEntry.runPrintMode(printRuntime, { mode: "text" });
	return {
			evidence: {
			sdk:
				sdk.runtimeComposition === sdk.session.agentRuntimeComposition &&
				sdk.runtimeComposition.externalConnectorRegistry?.list().length === 1,
			services:
				servicesCreated.runtimeComposition === servicesCreated.session.agentRuntimeComposition &&
				servicesCreated.runtimeComposition.externalConnectorRegistry?.list().length === 1,
			main: mainHasRegistry,
			tui: tuiHasRegistry,
			print: printHasRegistry && printExitCode === 0,
			rpc:
				rpcInitialize.success === true &&
				(rpcInitialize.data?.externalConnectors?.some(
					(descriptor) => descriptor.providerId === "line13-connector",
				) ?? false),
		},
		registries,
		cleanup: async () => {
			try {
				await rpcController.shutdown();
				await mainRuntime.dispose();
				await servicesCreated.session.dispose();
				await servicesCreated.session.waitForDispose();
				await sdk.session.dispose();
				await sdk.session.waitForDispose();
			} finally {
				rmSync(cwd, { recursive: true, force: true });
			}
		},
	};
}

function schedulerTask(): TaskEnvelope {
	return {
		schemaVersion: 1,
		taskId: "task-line13-reopen",
		goalId: "goal-line13-reopen",
		goal: "Recover durable Scheduler work after reopening the product session",
		workspace: "workspace-line13",
		capabilityRefs: [],
		inputs: [],
		expectedOutputs: [],
		budget: { tokens: 100, concurrency: 1 },
		acceptanceCriteria: [],
		status: "ready",
		createdAt: NOW,
		updatedAt: NOW,
	};
}

type TrustedSchedulerFactory = (
	sourceSession: Session,
	sessionId: string,
) => TrustedSchedulerRuntimeOptions;

interface SchedulerReopenFixture {
	readonly factoryCalls: number;
	readonly recoveredState: string | undefined;
	readonly recoveredAttempts: number | undefined;
	readonly cleanup: () => Promise<void>;
}

async function createSchedulerReopenFixture(): Promise<SchedulerReopenFixture> {
	const cwd = mkdtempSync(join(tmpdir(), "aos-line13-scheduler-"));
	const modelRuntime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null });
	const settingsManager = SettingsManager.inMemory();
	let clock = NOW;
	let factoryCalls = 0;
	const trustedSchedulerFactory: TrustedSchedulerFactory = (sourceSession, _sessionId) => {
		factoryCalls += 1;
		const targetSessionId = `line13-target-${factoryCalls}`;
		const targetSession = new Session(new InMemorySessionStorage({ id: targetSessionId, createdAt: 1 }));
		const targetManager = SessionManager.inMemory(cwd, { id: targetSessionId });
		return {
			schemaVersion: 1,
			enabled: true,
			sourceSession,
			targetSession,
			targetSessionId,
			targetGraph: new TaskGraphStore(
				targetManager,
				{ get: () => undefined },
				{ getByBusinessKey: () => undefined },
				{ now: () => clock },
			),
			ownerId: "line13-scheduler-owner",
			registry: new SchedulerExecutorRegistry(),
			task: schedulerTask(),
			binding: { schemaVersion: 1 } as unknown as AgentBinding,
			gateLookup: { getByBusinessKey: () => undefined },
			resolveRunAssociation: async () => {
				throw new Error("Line 13 Scheduler fixture contains no graph work");
			},
			settleRunAtHost: async () => {
				throw new Error("Line 13 Scheduler fixture contains no graph work");
			},
			pollIntervalMs: 60_000,
			now: () => clock,
		};
	};
	const servicesOptions: Parameters<typeof createAgentSessionServices>[0] & {
		readonly trustedSchedulerFactory: TrustedSchedulerFactory;
	} = {
		cwd,
		agentDir: cwd,
		modelRuntime,
		settingsManager,
		trustedSchedulerFactory,
		resourceLoaderOptions: {
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		},
	};
	const services = await createAgentSessionServices(servicesOptions);
	const sessionManager = SessionManager.inMemory(cwd, { id: "line13-scheduler-session" });
	const sessionOptions = (): Parameters<typeof createAgentSessionFromServices>[0] & {
		readonly trustedSchedulerFactory: TrustedSchedulerFactory;
	} => ({
		services,
		sessionManager,
		trustedSchedulerFactory,
		noTools: "all",
	});
	const first = await createAgentSessionFromServices(sessionOptions());
	await first.session.dispose();
	await first.session.waitForDispose();

	const durableSession = new Session(new SessionManagerStorage(sessionManager));
	const seedQueue = new SchedulerQueueStore({
		ledger: durableSession,
		sessionId: sessionManager.getSessionId(),
		ownerId: "line13-scheduler-owner",
		now: () => NOW,
	});
	const enqueued = await seedQueue.enqueue({
		schemaVersion: 1,
		queueEntryId: "queue-line13-reopen",
		sessionId: sessionManager.getSessionId(),
		taskId: "task-line13-reopen",
		nodeRef: { taskId: "task-line13-reopen", graphRevision: 1, nodeId: "node-line13-reopen" },
		state: "queued",
		priority: 10,
		attemptsUsed: 0,
		enqueuedAt: NOW,
		revision: 0,
	});
	if (!enqueued.ok) throw enqueued.error;
	const claimed = await seedQueue.claim({
		queueEntryId: "queue-line13-reopen",
		ownerId: "line13-stale-owner",
		claimId: "claim-line13-reopen",
		fencingToken: "fence-line13-reopen",
		ttlMs: 60_000,
	});
	if (!claimed.ok) throw claimed.error;
	clock = LATER;
	const reopened = await createAgentSessionFromServices(sessionOptions());
	await new Promise<void>((resolve) => setImmediate(resolve));
	const recovered = await new SchedulerQueueStore({
		ledger: durableSession,
		sessionId: sessionManager.getSessionId(),
		ownerId: "line13-scheduler-owner",
		now: () => LATER,
	}).getEntry("queue-line13-reopen");
	if (!recovered.ok) throw recovered.error;
	return {
		factoryCalls,
		recoveredState: recovered.value.state,
		recoveredAttempts: recovered.value.attemptsUsed,
		cleanup: async () => {
			await reopened.session.dispose();
			await reopened.session.waitForDispose();
			rmSync(cwd, { recursive: true, force: true });
		},
	};
}

async function createCurrentConnectorFixture(toolGateway = false) {
	const session = new Session(new InMemorySessionStorage({ id: `line13-current-${toolGateway}`, createdAt: 1 }));
	const t5 = new SessionT5Ledger(session, { ownerId: `line13-current-${toolGateway}` });
	const snapshot = createConnectorCapabilitySnapshot({
		schemaVersion: 1,
		providerId: "line13-current-connector",
		revision: 1,
		protocol: { name: "line13-fixture", version: "1" },
		modelAccess: "agent_owned",
		resume: false,
		toolGateway,
		artifacts: false,
		images: false,
	});
	let toolGatewayCalls = 0;
	const invokeToolGateway = (): void => { toolGatewayCalls += 1; };
	const connector: ExternalAgentConnector = {
		schemaVersion: 1,
		providerId: snapshot.providerId,
		providerClass: "external_connector",
		capabilities: async () => [{ schemaVersion: 1, id: "line13.current", version: 1 }],
		dispose: async () => {},
		probeCapabilities: async () => Result.ok(snapshot),
		createAttempt: async (dispatch: Dispatch, _binding: AgentBinding, context?: TaskExecutorAttemptContext) => {
			if (context === undefined) return Result.err(new FoundationError("binding_epoch_mismatch", "fixture requires epoch"));
			return createAttempt({
				attemptId: context.initialBindingEpoch.attemptId,
				dispatch,
				providerId: snapshot.providerId,
				providerClass: "external_connector",
				initialBindingEpoch: context.initialBindingEpoch,
			});
		},
		runAttempt: async (attempt: Attempt, options?: FoundationProviderExecutionOptions) => {
			const correlation = options?.correlation;
			if (correlation === undefined) return Result.err(new FoundationError("invalid_correlation", "fixture requires correlation"));
			return validateAttemptReceiptForProvider({
				schemaVersion: 1,
				attemptReceiptId: `attempt_receipt_${attempt.attemptId}`,
				taskId: attempt.taskId,
				dispatchId: attempt.dispatchId,
				attemptId: attempt.attemptId,
				providerId: snapshot.providerId,
				bindingId: attempt.bindingId,
				bindingEpochIds: attempt.bindingEpochIds,
				status: "succeeded",
				workerReceiptRefs: [],
				artifacts: [],
				provenance: {
					producerKind: "external_connector",
					providerId: snapshot.providerId,
					producedAt: "2026-08-27T00:00:00.000Z",
					correlation: { ...correlation, attemptReceiptId: `attempt_receipt_${attempt.attemptId}` },
				},
				sideEffectState: "none",
			}, { providerId: snapshot.providerId, providerClass: "external_connector" });
		},
		cancelAttempt: async () => Result.ok(undefined),
		resumeAttempt: async () => Result.err(new FoundationError("unsupported_feature", "resume disabled")),
		reconcileAttempt: async (attempt, options) => connector.runAttempt(attempt, options),
	};
	const registry = createExternalConnectorRegistry();
	const descriptor = {
		schemaVersion: 1 as const,
		providerId: snapshot.providerId,
		providerClass: "external_connector" as const,
		revision: snapshot.revision,
		capabilitySnapshotDigest: snapshot.digest,
	};
	const registered = await registry.register({
		descriptor,
		connector,
		trusted: true,
		...(toolGateway ? {
			capabilityEvidence: {
				toolGateway: {
					declaration: { id: "line13.tool-gateway", revision: 1, reachable: true as const },
					handler: { id: "line13.tool-gateway.handler", invoke: invokeToolGateway },
				},
			},
		} : {}),
	});
	if (!registered.ok) throw registered.error;
	const selection = {
		providerId: descriptor.providerId,
		revision: descriptor.revision,
		capabilitySnapshotDigest: descriptor.capabilitySnapshotDigest,
	};
	return { session, t5, registry, descriptor, selection, invokeToolGateway, toolGatewayCalls: () => toolGatewayCalls };
}

export const line13KnownGapCasesAc01Ac08 = defineLine13KnownGapCaseShard({
	schemaVersion: 1,
	shardId: "ac-01-08",
	complete: true,
	resolvedCases: [
		defineLine13ResolvedCase({
			ac: "AC-01",
			fullTestName: "Line 13 canonical RunReceipt is the sole terminal authority for RPC completion and recovery",
			scenario: {
				fixture: () => createRpcProductFixture({ withModel: true }),
				setup: initializeRpc,
				assertion: async (fixture) => {
					const startDispatch = fixture.controller.dispatch({
						id: "ac01-start",
						type: "run.start",
						message: "Complete the canonical receipt authority regression",
					});
					const started = automationResponseView(await waitForRpcResponse(fixture.records, "ac01-start"));
					assert.equal(started.success, true, "AC-01 RPC run.start must reach terminal settlement");
					const runId = started.data?.runId;
					assert.equal(typeof runId, "string", "AC-01 RPC run.start must return a Run id");
					if (runId === undefined) return;
					await waitForRpcTerminal(fixture.records, runId);
					await startDispatch;

					const reopened = await fixture.reopen();
					const initialized = automationResponseView(
						await reopened.dispatch({ id: "ac01-reinitialize", type: "initialize", protocolVersion: 1 }),
					);
					assert.equal(initialized.success, true, "AC-01 reopened RPC Host must initialize");
					const rpcRecovered = automationResponseView(
						await reopened.dispatch({ id: "ac01-get", type: "run.get", runId }),
					);

					const durableSession = new Session(new SessionManagerStorage(fixture.sessionManager));
					const canonicalReceipts = await durableSession.findFoundationRecords({
						kind: "fact",
						objectType: "run_receipt",
						includePruned: true,
						order: "oldestFirst",
					});
					const competingTerminals = fixture.sessionManager.getEntries().filter((entry) => {
						if (entry.type !== "custom" || entry.customType !== "automation.run") return false;
						const data = entry.data;
						return typeof data === "object" && data !== null && "kind" in data && data.kind === "terminal";
					});
					const replayed = createRunLifecycleCoordinator(fixture.sessionManager);
					const recoveredRun = replayed.getRun(runId);
					assert.notEqual(recoveredRun, undefined, "AC-01 Run lifecycle recovery must reconstruct the terminal Run");
					if (recoveredRun === undefined) return;
					const terminalAuthority = replayed as unknown as {
						replayedHandle(result: RunResult): RunHandle;
					};
					const settlement = new LayeredResultSettlement(durableSession, { ownerId: "ac01-replay" });
					const canonical = await settlement.lookupCanonicalRun(runId);
					if (!canonical.ok) throw canonical.error;
					assert.notEqual(canonical.value, undefined, "AC-01 must recover the canonical Foundation result");
					const duplicateTerminal = terminalAuthority
						.replayedHandle(recoveredRun)
						.observeCanonicalResult(canonical.value!);
					await settlement.release();
					const canonicalReceiptsAfterDuplicate = await durableSession.findFoundationRecords({
						kind: "fact",
						objectType: "run_receipt",
						includePruned: true,
						order: "oldestFirst",
					});
					const duplicateRejected =
						duplicateTerminal === undefined &&
						replayed.diagnostics().some((diagnostic) => diagnostic.kind === "duplicate-terminal");
					const rpcTerminalCount = fixture.records.filter((record) => {
						const view = record as unknown as { readonly type?: string; readonly runId?: string };
						return (
							view.runId === runId &&
							(view.type === "run.completed" || view.type === "run.failed" || view.type === "run.cancelled")
						);
					}).length;

					assert.deepStrictEqual(
						{
							canonicalReceiptCountBeforeDuplicate: canonicalReceipts.length,
							canonicalReceiptCountAfterDuplicate: canonicalReceiptsAfterDuplicate.length,
							competingTerminalCount: competingTerminals.length,
							rpcStatus: rpcRecovered.data?.receipt?.status ?? rpcRecovered.data?.status,
							replayStatus: recoveredRun.receipt?.status,
							rpcTerminalCount,
							duplicateRejected,
						},
						{
							canonicalReceiptCountBeforeDuplicate: 1,
							canonicalReceiptCountAfterDuplicate: 1,
							competingTerminalCount: 0,
							rpcStatus: "completed",
							replayStatus: "completed",
							rpcTerminalCount: 1,
							duplicateRejected: true,
						},
						"canonical RunReceipt must be the sole RPC terminal authority after recovery",
					);
				},
				cleanup: (fixture) => fixture.cleanup(),
			},
		}),
		defineLine13ResolvedCase({
			ac: "AC-04",
			fullTestName:
				"Line 13 public services composition carries trusted External Connector authority into SDK, TUI, print, and RPC sessions",
			scenario: {
				fixture: createProductCompositionFixture,
				setup: (fixture) => {
					if (fixture.registries.length < 5 || fixture.registries.some((registry) => registry.list().length > 1)) {
						throw new Error("AC-04 product composition fixture did not create isolated registry descriptors");
					}
				},
				assertion: (fixture) => {
					assert.deepStrictEqual(
						fixture.evidence,
						{ sdk: true, services: true, main: true, tui: true, print: true, rpc: true },
						"public product construction must carry one trusted External Connector through SDK, services, main, TUI, print, and RPC",
					);
				},
				cleanup: (fixture) => fixture.cleanup(),
			},
		}),
		defineLine13ResolvedCase({
			ac: "AC-02",
			fullTestName:
				"Line 13 package root exposes one External Connector contract and excludes protocol placeholders from Native Agent taxonomy",
			scenario: {
				fixture: () => createCurrentConnectorFixture(),
				setup: (fixture) => {
					if (fixture.registry.list().length !== 1) throw new Error("AC-02 current registry fixture did not register its Connector");
				},
				assertion: () => {
					const publicEntry = codingAgentEntry as unknown as Readonly<Record<string, unknown>>;
					const providerClasses = publicEntry.EXTERNAL_CONNECTOR_PROVIDER_CLASSES;
					assert.deepStrictEqual(
						{
							connectorRegistryExported: typeof publicEntry.createExternalConnectorRegistry === "function",
							externalConnectorClassDeclared:
								Array.isArray(providerClasses) && providerClasses.includes("external_connector"),
							nativePlaceholders: (SUBAGENT_PROVIDER_KINDS as readonly string[]).filter(
								(kind) => kind === "acp" || kind === "sdk",
							),
						},
						{
							connectorRegistryExported: true,
							externalConnectorClassDeclared: true,
							nativePlaceholders: [],
						},
						"package root must expose one External Connector contract without native protocol placeholders",
					);
				},
			},
		}),
		defineLine13ResolvedCase({
			ac: "AC-03",
			fullTestName: "Line 13 current External Connector persists the complete Foundation terminal chain without AgentInstance",
			scenario: {
				fixture: () => createRpcProductFixture({ withModel: false }),
				setup: initializeRpc,
				assertion: async (fixture) => {
					const dispatched = await fixture.controller.dispatch({
						id: "ac03-current-start",
						type: "run.start",
						message: "Traverse the canonical Foundation chain",
						externalConnector: fixture.externalConnectorSelection,
					});
					const started = automationResponseView(
						dispatched ?? await waitForRpcResponse(fixture.records, "ac03-current-start"),
					);
					assert.equal(started.success, true);
					const runId = started.data?.runId;
					assert.equal(typeof runId, "string");
					if (runId === undefined) return;
					await waitForRpcTerminal(fixture.records, runId);
					const durableSession = new Session(new SessionManagerStorage(fixture.sessionManager));
					const records = await durableSession.findFoundationRecords({ includePruned: true, order: "oldestFirst" });
					const objectTypes = records.flatMap((record) => record.kind === "retention" ? [] : [record.objectType]);
					for (const objectType of ["task", "attempt", "attempt_receipt", "task_result", "run_receipt"]) {
						assert.equal(objectTypes.includes(objectType), true, `missing ${objectType}`);
					}
					assert.equal(objectTypes.includes("agent_instance"), false);
				},
				cleanup: (fixture) => fixture.cleanup(),
			},
		}),
		defineLine13ResolvedCase({
			ac: "AC-05",
			fullTestName: "Line 13 RPC rejects non-canonical External Connector resources before product persistence",
			scenario: {
				fixture: () => createRpcProductFixture({ withModel: false }),
				setup: initializeRpc,
				assertion: async (fixture) => {
					const response = automationResponseView(await fixture.controller.dispatch({
						id: "ac05-raw-image",
						type: "run.start",
						message: "Reject raw image bytes",
						images: [{ type: "image", data: "AA==", mimeType: "image/png" }],
						externalConnector: fixture.externalConnectorSelection,
					}));
					assert.equal(response.success, false);
					assert.equal(response.error?.code, "external_binding_invalid");
					const durableSession = new Session(new SessionManagerStorage(fixture.sessionManager));
					const records = await durableSession.findFoundationRecords({ includePruned: true });
					const productWrites = records.filter((record) =>
						record.kind !== "retention" && ["foundation.goal", "task", "attempt"].includes(record.objectType)
					);
					assert.equal(productWrites.length, 0);
				},
				cleanup: (fixture) => fixture.cleanup(),
			},
		}),
		defineLine13ResolvedCase({
			ac: "AC-06",
			fullTestName: "Line 13 RPC none and agent-owned External Connectors run without a local model",
			scenario: {
				fixture: async () => ({
					fixtures: await Promise.all([
						createRpcProductFixture({ withModel: false, modelAccess: "none" }),
						createRpcProductFixture({ withModel: false, modelAccess: "agent_owned" }),
					]),
				}),
				assertion: async (fixture) => {
					for (const [index, current] of fixture.fixtures.entries()) {
						await initializeRpc(current);
						const dispatched = await current.controller.dispatch({
							id: `ac06-start-${index}`,
							type: "run.start",
							message: "Run without a local model",
							externalConnector: current.externalConnectorSelection,
						});
						const response = automationResponseView(
							dispatched ?? await waitForRpcResponse(current.records, `ac06-start-${index}`),
						);
						assert.equal(response.success, true);
						const runId = response.data?.runId;
						assert.equal(typeof runId, "string");
						if (runId !== undefined) await waitForRpcTerminal(current.records, runId);
					}
				},
				cleanup: async (fixture) => {
					for (const current of fixture.fixtures) await current.cleanup();
				},
			},
		}),
	],
	cases: [
		defineLine13KnownGapCase({
			entry: {
				ac: "AC-07",
				fullTestName: "Line 13 advertised External Connector tool-gateway capability reaches real product execution",
				baseSha: LINE13_T0_BASE_SHA,
				ownerStage: "T5",
				mode: "fails",
				expectedFailure: {
					reason: "external-connector.tool-gateway-product",
					fingerprint: "sha256:aa26ba49c1d52a139c675bfaaa82280e5dfee58c1ae7269b4bc8acc06bca17f8",
				},
			},
			scenario: {
				fixture: () => createCurrentConnectorFixture(true),
				assertion: async (fixture) => {
					await executeExternalConnectorProductRun({
						session: fixture.session,
						writer: fixture.t5.writer,
						registry: fixture.registry,
						selection: fixture.selection,
						runId: "line13-ac07-tool-gateway",
						message: "Reach the bound tool gateway during real execution",
						canonicalInput: {
							schemaVersion: 1,
							text: "Reach the bound tool gateway during real execution",
							artifacts: [],
						},
						inputAdmission: { inspectArtifact: () => { throw new Error("no artifacts"); } },
						workspace: "workspace-ref",
						now: () => NOW,
					});
					assert.equal(
						fixture.toolGatewayCalls(),
						1,
						"advertised tool gateway must be invoked by real product execution",
					);
				},
			},
		}),
		defineLine13KnownGapCase({
			entry: {
				ac: "AC-08",
				fullTestName:
					"Line 13 reopened product sessions recompose Scheduler workflow recovery from durable expired work",
				baseSha: LINE13_T0_BASE_SHA,
				ownerStage: "T9b",
				mode: "fails",
				expectedFailure: {
					reason: "scheduler.product-reopen",
					fingerprint: "sha256:669853151a66f32f3d36662649c858acf92d2e68c6c23af1e4c01945be054653",
				},
			},
			scenario: {
				fixture: createSchedulerReopenFixture,
				assertion: (fixture) => {
					assert.deepStrictEqual(
						{
							factoryCalls: fixture.factoryCalls,
							recoveredState: fixture.recoveredState,
							recoveredAttempts: fixture.recoveredAttempts,
						},
						{ factoryCalls: 2, recoveredState: "queued", recoveredAttempts: 1 },
						"reopened product sessions must recompose Scheduler recovery from durable state",
					);
				},
				cleanup: (fixture) => fixture.cleanup(),
			},
		}),
	],
});
