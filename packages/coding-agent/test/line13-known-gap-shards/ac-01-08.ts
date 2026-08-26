import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	InMemorySessionStorage,
	LayeredResultSettlement,
	Session,
	type AgentBinding,
	type TaskEnvelope,
} from "@aos-agent/agent-core";
import { fauxAssistantMessage, registerFauxProvider } from "@aos-agent/ai/compat";
import * as codingAgentEntry from "../../src/index.ts";
import {
	createAgentSession,
	createAgentSessionFromServices,
	createAgentSessionServices,
	type createAgentSessionWithTrustedScheduler,
	createExternalAgentAdapterRegistry,
	createExternalAgentPreparedBinding,
	SchedulerExecutorRegistry,
	SchedulerQueueStore,
	serializeExternalAgentInput,
	type CreateAgentSessionRuntimeFactory,
	type ExternalAgentAdapter,
	type ExternalAgentAdapterRegistry,
	type ExternalAgentBindingMode,
	type ExternalAgentCapabilityFlags,
	type ExternalAgentCapabilitySnapshot,
	type ExternalAgentExecutionContext,
	type ExternalAgentHandle,
	type ExternalAgentInput,
	type ExternalAgentPrepareRequest,
	type ExternalAgentPreparedBinding,
	type ExternalAgentProbeContext,
	type ExternalAgentStartRequest,
	type ExternalAgentTarget,
} from "../../src/index.ts";
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

const NOW = "2026-08-25T00:00:00.000Z";
const LATER = "2026-08-25T00:06:00.000Z";

interface ExternalAdapterTrace {
	probeCalls: number;
	prepareCalls: number;
	startCalls: number;
	inputs: ExternalAgentInput[];
}

interface ExternalAdapterHarness {
	readonly adapter: ExternalAgentAdapter;
	readonly trace: ExternalAdapterTrace;
}

interface ExternalAdapterOptions {
	readonly resume?: boolean;
	readonly toolGateway?: boolean;
	readonly bindingMode?: ExternalAgentBindingMode;
}

function createExternalAdapterHarness(options: ExternalAdapterOptions = {}): ExternalAdapterHarness {
	const trace: ExternalAdapterTrace = { probeCalls: 0, prepareCalls: 0, startCalls: 0, inputs: [] };
	const capabilities: ExternalAgentCapabilityFlags = {
		start: true,
		events: "metadata",
		cancel: "strong",
		receipt: "terminal",
		resume: options.resume ?? false,
		artifacts: true,
		toolGateway: options.toolGateway ?? false,
	};
	const external = { namespace: "line13-connector", externalSessionId: "external-session-1" } as const;
	const adapter: ExternalAgentAdapter = {
		id: "line13-connector",
		async probe(
			target: ExternalAgentTarget,
			_context: ExternalAgentProbeContext,
		): Promise<ExternalAgentCapabilitySnapshot> {
			trace.probeCalls += 1;
			return {
				schemaVersion: 1,
				adapterId: "line13-connector",
				targetId: target.targetId,
				protocol: { name: "line13-test", version: "1" },
				status: "ready",
				capabilities,
				observedAt: NOW,
			};
		},
		async prepare(
			request: ExternalAgentPrepareRequest,
			snapshot: ExternalAgentCapabilitySnapshot,
		): Promise<ExternalAgentPreparedBinding> {
			trace.prepareCalls += 1;
			return createExternalAgentPreparedBinding(request, snapshot, {
				bindingMode: options.bindingMode ?? "reference-only",
			});
		},
		async start(
			request: ExternalAgentStartRequest,
			_context: ExternalAgentExecutionContext,
		): Promise<ExternalAgentHandle> {
			trace.startCalls += 1;
			trace.inputs.push(request.input);
			return {
				external,
				events: {
					[Symbol.asyncIterator](): AsyncIterator<never> {
						return {
							next: async () => ({ done: true, value: undefined }),
						};
					},
				},
				receipt: Promise.resolve({
					schemaVersion: 1,
					external,
					status: "completed",
					endedAt: NOW,
					artifactRefs: [],
					sideEffects: "none",
				}),
				cancel: async () => {},
				heartbeat: async () => ({ leaseId: "line13-lease", expiresAt: LATER }),
			};
		},
	};
	return { adapter, trace };
}

interface RpcProductFixture {
	readonly controller: RpcHostController;
	readonly records: RpcHostOutputRecord[];
	readonly sessionManager: SessionManager;
	readonly adapter: ExternalAdapterHarness;
	readonly reopen: () => Promise<RpcHostController>;
	readonly cleanup: () => Promise<void>;
}

async function createRpcProductFixture(options: {
	readonly withModel: boolean;
	readonly adapter?: ExternalAdapterOptions;
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
	const services = await createAgentSessionServices({
		cwd,
		agentDir: cwd,
		modelRuntime,
		settingsManager,
		resourceLoaderOptions: {
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		},
	});
	const adapter = createExternalAdapterHarness(options.adapter);
	const registry = createExternalAgentAdapterRegistry();
	registry.register(adapter.adapter, { targets: ["target-1"] });
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
			externalAgentRegistry: registry,
			noTools: "all",
		});
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
		adapter,
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
	readonly registry: ExternalAgentAdapterRegistry;
	readonly cleanup: () => Promise<void>;
}

function mainProductEntrypointUsesRuntimeComposition(): boolean {
	const mainSource = readFileSync(fileURLToPath(new URL("../../src/main.ts", import.meta.url)), "utf8");
	return ["createAgentSessionServices", "createAgentSessionFromServices", "createAgentSessionRuntime"].every(
		(symbol) => mainSource.includes(symbol),
	);
}

async function createProductCompositionFixture(): Promise<ProductCompositionFixture> {
	const cwd = mkdtempSync(join(tmpdir(), "aos-line13-services-"));
	const modelRuntime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null });
	const settingsManager = SettingsManager.inMemory();
	const registry = createExternalAgentAdapterRegistry();
	registry.register(createExternalAdapterHarness().adapter, { targets: ["target-1"] });
	const servicesOptions: Parameters<typeof createAgentSessionServices>[0] & {
		readonly externalAgentRegistry: ExternalAgentAdapterRegistry;
	} = {
		cwd,
		agentDir: cwd,
		modelRuntime,
		settingsManager,
		externalAgentRegistry: registry,
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
		externalAgentRegistry: registry,
		noTools: "all",
	});
	const sessionOptions: Parameters<typeof createAgentSessionFromServices>[0] & {
		readonly externalAgentRegistry: ExternalAgentAdapterRegistry;
	} = {
		services,
		sessionManager: SessionManager.inMemory(cwd, { id: "line13-services-surface" }),
		externalAgentRegistry: registry,
		noTools: "all",
	};
	const servicesCreated = await codingAgentEntry.createAgentSessionFromServices(sessionOptions);
	const createRuntime: CreateAgentSessionRuntimeFactory = async (runtimeOptions) => {
		const runtimeSessionOptions: Parameters<typeof codingAgentEntry.createAgentSessionFromServices>[0] & {
			readonly externalAgentRegistry: ExternalAgentAdapterRegistry;
		} = {
			services,
			sessionManager: runtimeOptions.sessionManager,
			sessionStartEvent: runtimeOptions.sessionStartEvent,
			externalAgentRegistry: registry,
			noTools: "all",
		};
		const created = await codingAgentEntry.createAgentSessionFromServices(runtimeSessionOptions);
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
		mainProductEntrypointUsesRuntimeComposition() &&
		mainRuntime.session.getExternalAgentRegistry() === registry;
	const tuiHasRegistry = mainRuntime.session.getExternalAgentRegistry() === registry;
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
			readonly externalAgentAdapters?: ReadonlyArray<{ readonly adapterId?: string }>;
		};
	};

	const printRuntime = await createSurfaceRuntime("line13-print-surface");
	const printHasRegistry = printRuntime.session.getExternalAgentRegistry() === registry;
	const printExitCode = await codingAgentEntry.runPrintMode(printRuntime, { mode: "text" });
	return {
		evidence: {
			sdk: sdk.session.getExternalAgentRegistry() === registry,
			services: servicesCreated.session.getExternalAgentRegistry() === registry,
			main: mainHasRegistry,
			tui: tuiHasRegistry,
			print: printHasRegistry && printExitCode === 0,
			rpc:
				rpcInitialize.success === true &&
				(rpcInitialize.data?.externalAgentAdapters?.some(
					(descriptor) => descriptor.adapterId === "line13-connector",
				) ?? false),
		},
		registry,
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

type TrustedSchedulerFactory = Parameters<typeof createAgentSessionWithTrustedScheduler>[1];

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
	const trustedSchedulerFactory: TrustedSchedulerFactory = (sourceSession, _sessionId, runLifecycleSession) => {
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
			runLifecycleSession,
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
	],
	cases: [
		defineLine13KnownGapCase({
			entry: {
				ac: "AC-02",
				fullTestName:
					"Line 13 package root exposes one External Connector contract and excludes protocol placeholders from Native Agent taxonomy",
				baseSha: LINE13_T0_BASE_SHA,
				ownerStage: "T4",
				mode: "fails",
				expectedFailure: {
					reason: "external-connector.public-taxonomy",
					fingerprint: "sha256:06d7f0584ba687bda557430c417519fe9c073caae3d3476ffe24d22b9d228738",
				},
			},
			scenario: {
				fixture: () => {
					const registry = createExternalAgentAdapterRegistry();
					registry.register(createExternalAdapterHarness().adapter, { targets: ["target-1"] });
					return registry;
				},
				setup: (registry) => {
					if (registry.list().length !== 1) throw new Error("AC-02 real registry fixture did not register its adapter");
				},
				assertion: () => {
					const publicEntry = codingAgentEntry as unknown as Readonly<Record<string, unknown>>;
					const providerClasses = publicEntry.EXTERNAL_CONNECTOR_PROVIDER_CLASSES;
					assert.deepStrictEqual(
						{
							connectorRegistryExported: typeof publicEntry.createExternalConnectorRegistry === "function",
							externalConnectorClassDeclared:
								Array.isArray(providerClasses) && providerClasses.includes("external_connector"),
							nativePlaceholders: SUBAGENT_PROVIDER_KINDS.filter((kind) => kind === "acp" || kind === "sdk"),
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
		defineLine13KnownGapCase({
			entry: {
				ac: "AC-03",
				fullTestName:
					"Line 13 External RPC work traverses Foundation Task, Attempt, Receipt, TaskResult, and RunReceipt settlement",
				baseSha: LINE13_T0_BASE_SHA,
				ownerStage: "T4",
				mode: "fails",
				expectedFailure: {
					reason: "external-connector.foundation-chain",
					fingerprint: "sha256:2d188bd534a63056d48b4e2a00827621277ff786e1f7507e9b036ad4d24f9f46",
				},
			},
			scenario: {
				fixture: () => createRpcProductFixture({ withModel: true }),
				setup: initializeRpc,
				assertion: async (fixture) => {
					const started = automationResponseView(
						await fixture.controller.dispatch({
							id: "ac03-start",
							type: "run.start",
							message: "Traverse the full Foundation settlement chain",
							externalAgent: { adapterId: "line13-connector", targetId: "target-1" },
						}),
					);
					assert.equal(started.success, true, "AC-03 External RPC run.start must be accepted");
					const runId = started.data?.runId;
					assert.equal(typeof runId, "string", "AC-03 External RPC run.start must return a Run id");
					if (runId === undefined) return;
					await waitForRpcTerminal(fixture.records, runId);
					const durableSession = new Session(new SessionManagerStorage(fixture.sessionManager));
					const objectTypes = new Set(
						(await durableSession.findFoundationRecords({ includePruned: true, order: "oldestFirst" })).flatMap(
							(record) => (record.kind === "retention" ? [] : [record.objectType]),
						),
					);
					assert.deepStrictEqual(
						{
							task: objectTypes.has("task"),
							attempt: objectTypes.has("attempt"),
							attemptReceipt: objectTypes.has("attempt_receipt"),
							taskResult: objectTypes.has("task_result"),
							runReceipt: objectTypes.has("run_receipt"),
						},
						{ task: true, attempt: true, attemptReceipt: true, taskResult: true, runReceipt: true },
						"external RPC work must persist the Foundation Task-to-RunReceipt chain",
					);
				},
				cleanup: (fixture) => fixture.cleanup(),
			},
		}),
		defineLine13KnownGapCase({
			entry: {
				ac: "AC-04",
				fullTestName:
					"Line 13 public services composition carries trusted External Connector authority into SDK, TUI, print, and RPC sessions",
				baseSha: LINE13_T0_BASE_SHA,
				ownerStage: "T3b",
				mode: "fails",
				expectedFailure: {
					reason: "product-composition.external-connector",
					fingerprint: "sha256:56d62102a7e9f856703685ace1b21fb867b290044f27abac526cdc72743e6eb6",
				},
			},
			scenario: {
				fixture: createProductCompositionFixture,
				setup: (fixture) => {
					if (fixture.registry.list().length !== 1) {
						throw new Error("AC-04 product composition fixture did not retain its registry descriptor");
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
		defineLine13KnownGapCase({
			entry: {
				ac: "AC-05",
				fullTestName:
					"Line 13 External Connector input preserves text plus exact image and file reference shapes",
				baseSha: LINE13_T0_BASE_SHA,
				ownerStage: "T4",
				mode: "fails",
				expectedFailure: {
					reason: "external-connector.input-shape",
					fingerprint: "sha256:94a80aadcb7efd92e9fc9eb6c1da93d060398c19a2a782987a2b98dced112ddc",
				},
			},
			scenario: {
				fixture: async () => ({
					product: await createRpcProductFixture({ withModel: true }),
					expectedInput: {
						message: "Preserve every safe input reference",
						images: [{ id: "image-line13", mimeType: "image/png", sizeBytes: 1 }],
						files: [
							{
								id: "file-line13",
								name: "evidence.txt",
								mimeType: "text/plain",
								sizeBytes: 512,
							},
						],
					},
				}),
				setup: ({ product }) => initializeRpc(product),
				assertion: async ({ product, expectedInput }) => {
					const started = automationResponseView(
						await product.controller.dispatch({
							id: "ac05-start",
							type: "run.start",
							message: expectedInput.message,
							images: [{ type: "image", data: "AA==", mimeType: "image/png" }],
							externalAgent: { adapterId: "line13-connector", targetId: "target-1" },
						}),
					);
					const forwarded = product.adapter.trace.inputs[0]?.images;
					const rejectedBeforeAcceptance = started.success === false && product.adapter.trace.startCalls === 0;
					const forwardedAsSafeReference =
						started.success === true &&
						product.adapter.trace.startCalls === 1 &&
						forwarded?.length === 1 &&
						typeof forwarded[0]?.id === "string" &&
						forwarded[0].id.length > 0 &&
						forwarded[0].mimeType === "image/png" &&
						forwarded[0].sizeBytes === 1;
					assert.equal(
						rejectedBeforeAcceptance || forwardedAsSafeReference,
						true,
						"external RPC input must reject image bytes before acceptance or forward only an exact safe reference",
					);
					assert.deepStrictEqual(
						serializeExternalAgentInput(expectedInput),
						expectedInput,
						"external input serialization must preserve text, image, and file reference shapes",
					);
				},
				cleanup: ({ product }) => product.cleanup(),
			},
		}),
		defineLine13KnownGapCase({
			entry: {
				ac: "AC-06",
				fullTestName:
					"Line 13 External-only RPC execution reaches the Connector without requiring a local model",
				baseSha: LINE13_T0_BASE_SHA,
				ownerStage: "T4",
				mode: "fails",
				expectedFailure: {
					reason: "external-connector.model-independent",
					fingerprint: "sha256:76ae152d1cf9184d89ecfad8af4b35df678e1045f313ce793a6cad66498d4f24",
				},
			},
			scenario: {
				fixture: () => createRpcProductFixture({ withModel: false }),
				setup: initializeRpc,
				assertion: async (fixture) => {
					const started = automationResponseView(
						await fixture.controller.dispatch({
							id: "ac06-start",
							type: "run.start",
							message: "Run without a local model",
							externalAgent: { adapterId: "line13-connector", targetId: "target-1" },
						}),
					);
					assert.deepStrictEqual(
						{ success: started.success, adapterStarts: fixture.adapter.trace.startCalls },
						{ success: true, adapterStarts: 1 },
						"external-only RPC execution must reach the Connector without a local model",
					);
				},
				cleanup: (fixture) => fixture.cleanup(),
			},
		}),
		defineLine13KnownGapCase({
			entry: {
				ac: "AC-07",
				fullTestName:
					"Line 13 advertised External Connector tool-gateway capability reaches execution instead of a fixed rejection",
				baseSha: LINE13_T0_BASE_SHA,
				ownerStage: "T4",
				mode: "fails",
				expectedFailure: {
					reason: "external-connector.capability-reachability",
					fingerprint: "sha256:babdac6c4531018bb7ea0dc7c15679692a6cc23a177ed1d6fdcfaccd5a37faff",
				},
			},
			scenario: {
				fixture: () =>
					createRpcProductFixture({
						withModel: true,
						adapter: { toolGateway: true, bindingMode: "tool-gateway" },
					}),
				setup: initializeRpc,
				assertion: async (fixture) => {
					const started = automationResponseView(
						await fixture.controller.dispatch({
							id: "ac07-start",
							type: "run.start",
							message: "Reach the advertised tool gateway",
							externalAgent: { adapterId: "line13-connector", targetId: "target-1" },
						}),
					);
					assert.deepStrictEqual(
						{ success: started.success, adapterStarts: fixture.adapter.trace.startCalls },
						{ success: true, adapterStarts: 1 },
						"advertised External Connector tool-gateway capability must reach execution",
					);
				},
				cleanup: (fixture) => fixture.cleanup(),
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
