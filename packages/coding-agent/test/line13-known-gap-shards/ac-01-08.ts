import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	InMemorySessionStorage,
	LayeredResultSettlement,
	Result,
	Session,
	SessionLedger,
	SessionT5Ledger,
	createAttempt,
	createBindingEpoch,
	createConnectorCapabilitySnapshot,
	createFoundationToolGateway,
	createLocalToolGatewayProvider,
	createModelProfileRevision,
	createRoleRevision,
	fingerprintFoundationValue,
	resolveAgentBinding,
	type AgentBinding,
	type FoundationError,
	type FoundationJsonValue,
	type ModelProfile,
	type RevisionReference,
	type TaskEnvelope,
	type ToolExecutionResult,
	type ToolGateway,
	type ToolGatewayRequest,
} from "@aos-agent/agent-core";
import { fauxAssistantMessage, registerFauxProvider } from "@aos-agent/ai/compat";
import * as codingAgentEntry from "../../src/index.ts";
import {
	createAgentSession,
	createAgentSessionFromServices,
	createAgentSessionServices,
	createExternalConnectorRegistry,
	SchedulerExecutorRegistry,
	SchedulerInProcessTaskExecutorProvider,
	SchedulerQueueStore,
	type AgentSession,
	type CreateAgentSessionRuntimeFactory,
	type ExternalConnectorRegistry,
} from "../../src/index.ts";
import {
	createSchedulerExecutorRuntimeSnapshotV1,
	schedulerBindingRequirementDigestV1,
} from "../../src/core/scheduler-executors.ts";
import { SchedulerSelectionReservationStore } from "../../src/core/scheduler-selection-reservations.ts";
import { createDurableExternalAgentConnector } from "../../src/core/external-agent-connector.ts";
import type { ExecutionPolicyProfile } from "../../src/core/execution-policy.ts";
import {
	EXTERNAL_CONNECTOR_TOOL_GATEWAY_EXECUTION_OBJECT_TYPE,
	SessionExternalConnectorDurableStore,
	externalConnectorToolGatewayExchangeId,
} from "../../src/core/external-agent-operation.ts";
import {
	executeExternalConnectorProductRun,
	externalConnectorProductIdentity,
	recoverExternalConnectorProductRun,
} from "../../src/core/external-connector-product.ts";
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
import { RpcHostController, type RpcHostOutputRecord, type RpcHostOutputSink } from "../../src/modes/rpc/rpc-host.ts";
import {
	defineLine13KnownGapCaseShard,
	defineLine13ResolvedCase,
} from "../support/line13-known-gaps.ts";
import {
	createExternalConnectorTestRuntime,
	createExternalConnectorTestSupervision,
} from "../external-connector-test-supervision.ts";
import type {
	ExternalConnectorProcessHandle,
	ExternalConnectorProcessTerminationOptions,
	ExternalConnectorProcessTerminationRequest,
	ExternalConnectorProcessTerminationResult,
} from "../../src/core/external-connector-supervisor.ts";

const NOW = "2026-08-25T00:00:00.000Z";
const LATER = "2026-08-25T00:06:00.000Z";

const EXTERNAL_POLICY_PROFILE: ExecutionPolicyProfile = {
	id: "line13-external-policy",
	enforcement: "host",
	defaultAction: "deny",
	workspace: { read: ["workspace"], write: [], deny: ["credentials", "agent-internal"] },
	process: { action: "deny", inheritEnvironment: false, allowEnvironment: [] },
	network: { action: "deny", allowDestinations: [] },
	credentials: { action: "deny", allowNames: [] },
	approvals: { writeOutsideWorkspace: "deny", network: "deny", process: "deny" },
	rules: [{ resource: "filesystem.read", source: "rpc", scope: "workspace", action: "allow" }],
};

class Line13CurrentDriver implements ExternalConnectorVendorDriver {
	readonly writes: ExternalConnectorDriverWriteRequest[] = [];
	readCalls = 0;
	spawnCalls = 0;
	connectCalls = 0;
	readonly #emitToolGatewayRequest: boolean;
	readonly #canonicalToolGatewayRequests: readonly ToolGatewayRequest[] | undefined;
	readonly #readGate: Promise<void> | undefined;
	#releaseReadGate: (() => void) | undefined;
	#spawnedRequest: ExternalConnectorDriverSpawnRequest | undefined;

	constructor(
		emitToolGatewayRequest = false,
		options: {
			readonly canonicalToolGatewayRequests?: readonly ToolGatewayRequest[];
			readonly readHangs?: boolean;
		} = {},
	) {
		this.#emitToolGatewayRequest = emitToolGatewayRequest;
		this.#canonicalToolGatewayRequests = options.canonicalToolGatewayRequests;
		this.#readGate = options.readHangs
			? new Promise<void>((resolve) => {
					this.#releaseReadGate = resolve;
				})
			: undefined;
	}

	releaseRead(): void {
		this.#releaseReadGate?.();
		this.#releaseReadGate = undefined;
	}
	async spawn(request: ExternalConnectorDriverSpawnRequest): Promise<ExternalConnectorDriverHandle> {
		this.spawnCalls += 1;
		this.#spawnedRequest = request;
		return {
			externalSessionId: "line13-current-session",
			externalTurnId: "line13-current-turn",
			supervisorRef: request.supervisorRef,
			operationNonce: request.operationNonce,
		};
	}

	events(handle: ExternalConnectorDriverHandle): AsyncIterable<FoundationJsonValue> {
		const spawned = this.#spawnedRequest;
		const operationId = spawned?.correlation.operationId;
		const values: FoundationJsonValue[] =
			this.#canonicalToolGatewayRequests === undefined
				? !this.#emitToolGatewayRequest || spawned === undefined
					? []
					: operationId === undefined
						? (() => {
								throw new Error("Line 13 driver requires an operation correlation");
							})()
						: (() => {
								const gatewayRequest = (toolCallId: string, path: string): ToolGatewayRequest => ({
									schemaVersion: 1,
									toolCallId,
									toolName: "read",
									namespace: "workspace",
									originalArguments: { path, mode: "metadata" },
									idempotencyKey: `${toolCallId}-once`,
									context: {
										schemaVersion: 1,
										bindingId: spawned.attempt.bindingId,
										bindingEpochId: spawned.attempt.bindingEpochIds[0]!,
										taskId: spawned.attempt.taskId,
										dispatchId: spawned.attempt.dispatchId,
										providerId: spawned.capability.providerId,
										attemptId: spawned.attempt.attemptId,
										operationId,
									},
								});
								const first = gatewayRequest("line13-ac07-tool-call-1", "docs/evidence.txt");
								const second = gatewayRequest("line13-ac07-tool-call-2", "docs/second.txt");
								return [
									{
										schemaVersion: 1,
										type: "started",
										externalSessionId: handle.externalSessionId,
										...(handle.externalTurnId === undefined ? {} : { externalTurnId: handle.externalTurnId }),
										producedAt: NOW,
									},
									{
										schemaVersion: 1,
										type: "tool_gateway_request",
										externalSessionId: handle.externalSessionId,
										...(handle.externalTurnId === undefined ? {} : { externalTurnId: handle.externalTurnId }),
										operationNonce: handle.operationNonce,
										request: first as unknown as FoundationJsonValue,
										producedAt: NOW,
									},
									{
										schemaVersion: 1,
										type: "tool_gateway_request",
										externalSessionId: handle.externalSessionId,
										...(handle.externalTurnId === undefined ? {} : { externalTurnId: handle.externalTurnId }),
										operationNonce: handle.operationNonce,
										request: first as unknown as FoundationJsonValue,
										producedAt: NOW,
									},
									{
										schemaVersion: 1,
										type: "tool_gateway_request",
										externalSessionId: handle.externalSessionId,
										...(handle.externalTurnId === undefined ? {} : { externalTurnId: handle.externalTurnId }),
										operationNonce: handle.operationNonce,
										request: second as unknown as FoundationJsonValue,
										producedAt: NOW,
									},
								];
							})()
				: [
						{
							schemaVersion: 1,
							type: "started",
							externalSessionId: handle.externalSessionId,
							...(handle.externalTurnId === undefined ? {} : { externalTurnId: handle.externalTurnId }),
							producedAt: NOW,
						},
						...this.#canonicalToolGatewayRequests.map((request) => ({
							schemaVersion: 1 as const,
							type: "tool_gateway_request" as const,
							externalSessionId: handle.externalSessionId,
							...(handle.externalTurnId === undefined ? {} : { externalTurnId: handle.externalTurnId }),
							operationNonce: handle.operationNonce,
							request: request as unknown as FoundationJsonValue,
							producedAt: NOW,
						})),
					];
		let index = 0;
		return {
			[Symbol.asyncIterator]: () => ({
				next: async () => {
					const value = values[index++];
					return value === undefined ? { done: true, value: undefined } : { done: false, value };
				},
			}),
		};
	}

	async connect(
		mapping: Parameters<ExternalConnectorVendorDriver["connect"]>[0],
	): Promise<ExternalConnectorDriverHandle> {
		this.connectCalls += 1;
		return {
			externalSessionId: mapping.externalSessionId,
			...(mapping.externalTurnId === undefined ? {} : { externalTurnId: mapping.externalTurnId }),
			supervisorRef: mapping.supervisor.ref,
			operationNonce: mapping.supervisor.nonce,
		};
	}

	async lookup(): Promise<ExternalConnectorDriverLookup> {
		return { status: "missing" };
	}

	async read(handle: ExternalConnectorDriverHandle): Promise<ExternalConnectorTerminalEvidence> {
		this.readCalls += 1;
		await this.#readGate;
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

	async write(_handle: ExternalConnectorDriverHandle, request: ExternalConnectorDriverWriteRequest): Promise<void> {
		this.writes.push(request);
	}
	async heartbeat(): Promise<void> {}
	async cancel(): Promise<ExternalConnectorTerminalEvidence | undefined> {
		return undefined;
	}
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
				capabilityProbe: async () => Result.ok(currentSnapshot),
				store: new SessionExternalConnectorDurableStore(
					new SessionLedger(context.session, { writer: context.harness.t5.writer }),
				),
				driver: new Line13CurrentDriver(),
				supervision: createExternalConnectorTestSupervision().options,
				now: () => NOW,
				operationNonce: () => "line13-operation-nonce",
			});
			const registered = registry.registerPrepared(
				{
					descriptor: {
						schemaVersion: 1,
						providerId: currentSnapshot.providerId,
						providerClass: "external_connector",
						revision: currentSnapshot.revision,
						capabilitySnapshotDigest: currentSnapshot.digest,
					},
					connector,
				},
				currentSnapshot,
			);
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

function createCompositionConnectorRegistry(toolGateway?: ToolGateway): ExternalConnectorRegistry {
	const snapshot = createConnectorCapabilitySnapshot({
		schemaVersion: 1,
		providerId: "line13-connector",
		revision: 1,
		protocol: { name: "line13-composition", version: "1" },
		modelAccess: "none",
		resume: false,
		toolGateway: toolGateway !== undefined,
		artifacts: false,
		images: false,
	});
	const registry = createExternalConnectorRegistry({
		...(toolGateway === undefined ? {} : { toolGateway }),
	});
	const registered = registry.registerPrepared(
		{
			descriptor: {
				schemaVersion: 1,
				providerId: snapshot.providerId,
				providerClass: "external_connector",
				revision: snapshot.revision,
				capabilitySnapshotDigest: snapshot.digest,
			},
			connector: createExternalConnectorTestRuntime(snapshot),
		},
		snapshot,
	);
	if (!registered.ok) throw registered.error;
	return registry;
}

async function createProductCompositionFixture(): Promise<ProductCompositionFixture> {
	const cwd = mkdtempSync(join(tmpdir(), "aos-line13-services-"));
	const modelRuntime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null });
	const settingsManager = SettingsManager.inMemory();
	const registries: ExternalConnectorRegistry[] = [];
	const runtimeComposition = codingAgentEntry.createAgentRuntimeCompositionFactory({
		toolGateway: (context) =>
			createFoundationToolGateway({
				gatewayId: `line13-composition-gateway-${context.sessionId}`,
				providers: [],
			}),
		externalConnectorRegistry: (_context, toolGateway) => {
			const registry = createCompositionConnectorRegistry(toolGateway);
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
		printRuntime.runtimeComposition.externalConnectorRegistry ===
			printRuntime.session.getExternalConnectorRegistry() &&
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
				) ??
					false),
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

function schedulerModelProfile(): ModelProfile {
	return createModelProfileRevision({
		schemaVersion: 1,
		modelProfileId: "line13-scheduler-reopen-profile",
		provider: "host",
		model: "host",
		budget: { tokens: 100 },
		revision: 1,
		createdAt: NOW,
	});
}

function schedulerImmutableFact(type: string, id: string): RevisionReference {
	const value = { schemaVersion: 1 as const, type, id, revision: 1 };
	return { ...value, fingerprint: fingerprintFoundationValue(value) };
}

function schedulerRoleRevision() {
	return createRoleRevision({
		definition: {
			schemaVersion: 1,
			roleId: "line13-scheduler-reopen-role",
			scope: "project",
			slug: "line13-scheduler-reopen",
			name: "Line 13 Scheduler reopen",
			description: "Reconciles one expired Scheduler Attempt",
			revision: 1,
			persona: "Reconcile expired Scheduler work.",
			modelProfileRef: {
				schemaVersion: 1,
				type: "model_profile",
				id: "line13-scheduler-reopen-profile",
				revision: 1,
			},
			capabilitySelector: { policy: "all" },
			skillSelector: { policy: "none" },
			mcpSelector: { policy: "none" },
		},
		now: () => NOW,
	});
}

function schedulerBinding(): AgentBinding {
	const resolved = resolveAgentBinding({
		task: schedulerTask(),
		roleRevision: schedulerRoleRevision(),
		modelProfile: schedulerModelProfile(),
		contextRevision: schedulerImmutableFact("external_agent_binding", "line13-scheduler-reopen-context"),
		capabilityRevision: schedulerImmutableFact("capability_binding", "line13-scheduler-reopen-capability"),
		modelBrokerBindingRevision: schedulerImmutableFact("model_broker_binding", "line13-scheduler-reopen-broker"),
		policyRevision: schedulerImmutableFact("policy_binding", "line13-scheduler-reopen-policy"),
		newBindingId: "line13-scheduler-reopen-binding",
		now: () => NOW,
	});
	if (!resolved.ok) throw resolved.error;
	return resolved.value;
}

function schedulerRuntimeSnapshot(providerId: string, currentBinding: AgentBinding) {
	const bindingDigest = schedulerBindingRequirementDigestV1(currentBinding);
	if (!bindingDigest.ok) throw bindingDigest.error;
	const policyDigest = currentBinding.policyRevision.fingerprint;
	if (policyDigest === undefined) throw new Error("Line 13 Scheduler binding lacks a policy fingerprint");
	const runtimeSnapshot = createSchedulerExecutorRuntimeSnapshotV1({
		schemaVersion: 1,
		capabilitySnapshot: createConnectorCapabilitySnapshot({
			schemaVersion: 1,
			providerId,
			revision: 1,
			protocol: { name: "line13-scheduler-reopen", version: "1" },
			modelAccess: "aos_gateway",
			resume: true,
			toolGateway: false,
			artifacts: false,
			images: false,
		}),
		configRevision: fingerprintFoundationValue("line13-scheduler-reopen-config"),
		bindingRequirementDigests: [bindingDigest.value],
		toolSelectionDigests: [currentBinding.mcpSelection.digest],
		policyRevisionDigests: [policyDigest],
		reviewRevisionDigests: [],
		credentialTargetRefs: [],
		sandboxTargetRefs: [],
		observedAt: NOW,
		expiresAt: "2026-08-26T00:00:00.000Z",
	});
	if (!runtimeSnapshot.ok) throw runtimeSnapshot.error;
	return runtimeSnapshot.value;
}

interface SchedulerReopenFixture {
	readonly factoryCalls: number;
	readonly recoveredState: string | undefined;
	readonly recoveredAttempts: number | undefined;
	readonly cancelledAttemptIds: readonly string[];
	readonly cleanup: () => Promise<void>;
}

async function createSchedulerReopenFixture(): Promise<SchedulerReopenFixture> {
	const cwd = mkdtempSync(join(tmpdir(), "aos-line13-scheduler-"));
	const modelRuntime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null });
	const settingsManager = SettingsManager.inMemory();
	let clock = NOW;
	let factoryCalls = 0;
	let canonicalSchedulerOwnerId: string | undefined;
	const cancelledAttemptIds: string[] = [];
	const currentBinding = schedulerBinding();
	const runtimeComposition = codingAgentEntry.createAgentRuntimeCompositionFactory({
		scheduler: (context, selectionReservations) => {
			factoryCalls += 1;
			canonicalSchedulerOwnerId = selectionReservations.ownerId;
			const targetSessionId = `line13-target-${factoryCalls}`;
			const targetSession = new Session(new InMemorySessionStorage({ id: targetSessionId, createdAt: 1 }));
			const targetManager = SessionManager.inMemory(cwd, { id: targetSessionId });
			const registry = new SchedulerExecutorRegistry({ reservationStore: selectionReservations });
			const provider = new SchedulerInProcessTaskExecutorProvider({
				providerId: "line13.scheduler.reopen",
				now: () => clock,
			});
			const cancelAttempt = provider.cancelAttempt.bind(provider);
			provider.cancelAttempt = async (attemptId) => {
				cancelledAttemptIds.push(attemptId);
				return cancelAttempt(attemptId);
			};
			return {
				schemaVersion: 1,
				enabled: true,
				sourceSession: context.session,
				targetSession,
				targetSessionId,
				targetGraph: new TaskGraphStore(
					targetManager,
					{ get: () => undefined },
					{ getByBusinessKey: () => undefined },
					{ now: () => clock },
				),
				ownerId: selectionReservations.ownerId,
				registry,
				selectionReservationStore: selectionReservations,
				initializeBeforeStart: async () => {
					const registered = await registry.register({
						entry: {
							schemaVersion: 1,
							descriptor: {
								schemaVersion: 1,
								providerId: provider.providerId,
								providerClass: provider.providerClass,
							},
							capabilities: [],
							costClass: "local",
							registeredAt: clock,
						},
						provider,
						trusted: true,
						latencyMs: 0,
						maxConcurrency: 1,
						runtimeSnapshot: schedulerRuntimeSnapshot(provider.providerId, currentBinding),
					});
					if (!registered.ok) throw registered.error;
				},
				task: schedulerTask(),
				binding: currentBinding,
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
	const services = await createAgentSessionServices(servicesOptions);
	const sessionManager = SessionManager.inMemory(cwd, { id: "line13-scheduler-session" });
	const sessionOptions = (): Parameters<typeof createAgentSessionFromServices>[0] => ({
		services,
		sessionManager,
		noTools: "all",
	});
	const first = await createAgentSessionFromServices(sessionOptions());
	await first.session.whenCapabilitiesReady();
	await first.session.dispose();
	await first.session.waitForDispose();
	if (canonicalSchedulerOwnerId === undefined) throw new Error("Line 13 Scheduler owner was not composed");

	const durableSession = new Session(new SessionManagerStorage(sessionManager));
	const seedQueue = new SchedulerQueueStore({
		ledger: durableSession,
		sessionId: sessionManager.getSessionId(),
		ownerId: canonicalSchedulerOwnerId,
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
	const selectionStore = new SchedulerSelectionReservationStore(durableSession, {
		ownerId: canonicalSchedulerOwnerId,
		now: () => NOW,
	});
	const selectionRegistry = new SchedulerExecutorRegistry({ reservationStore: selectionStore });
	const selectionProvider = new SchedulerInProcessTaskExecutorProvider({
		providerId: "line13.scheduler.reopen",
		now: () => NOW,
	});
	const registeredSelectionProvider = await selectionRegistry.register({
		entry: {
			schemaVersion: 1,
			descriptor: {
				schemaVersion: 1,
				providerId: selectionProvider.providerId,
				providerClass: selectionProvider.providerClass,
			},
			capabilities: [],
			costClass: "local",
			registeredAt: NOW,
		},
		provider: selectionProvider,
		trusted: true,
		latencyMs: 0,
		maxConcurrency: 1,
		runtimeSnapshot: schedulerRuntimeSnapshot(selectionProvider.providerId, currentBinding),
	});
	if (!registeredSelectionProvider.ok) throw registeredSelectionProvider.error;
	const selected = await selectionRegistry.select({
		queueEntry: enqueued.value.entry,
		decidedAt: NOW,
		exactRequirements: {
			binding: currentBinding,
			attemptId: "attempt-line13-reopen",
			bindingEpochId: "epoch-line13-reopen",
			requireResume: true,
			modelAccess: "aos_gateway",
		},
	});
	if (!selected.ok) throw selected.error;
	const claimed = await seedQueue.claim({
		queueEntryId: "queue-line13-reopen",
		ownerId: "line13-stale-owner",
		claimId: "claim-line13-reopen",
		fencingToken: "fence-line13-reopen",
		ttlMs: 60_000,
	});
	if (!claimed.ok) throw claimed.error;
	const dispatched = await seedQueue.markDispatched({
		queueEntryId: "queue-line13-reopen",
		fencingToken: claimed.value.claim.fencingToken,
		dispatchId: "dispatch-line13-reopen",
		attemptId: "attempt-line13-reopen",
		providerId: "line13.scheduler.reopen",
		providerClass: "task_executor",
	});
	if (!dispatched.ok) throw dispatched.error;
	const epoch = createBindingEpoch({
		bindingEpochId: "epoch-line13-reopen",
		taskId: schedulerTask().taskId,
		attemptId: "attempt-line13-reopen",
		bindingId: currentBinding.bindingId,
		activationReason: "attempt_started",
		activatedByCommandId: "command-line13-reopen",
		now: () => NOW,
	});
	if (!epoch.ok) throw epoch.error;
	const dispatch = {
		schemaVersion: 1 as const,
		dispatchId: "dispatch-line13-reopen",
		taskId: schedulerTask().taskId,
		bindingId: currentBinding.bindingId,
		taskExecutorProviderId: "line13.scheduler.reopen",
		status: "pending" as const,
		createdAt: NOW,
	};
	const attempt = createAttempt({
		attemptId: "attempt-line13-reopen",
		dispatch,
		providerId: "line13.scheduler.reopen",
		initialBindingEpoch: epoch.value,
		providerClass: "task_executor",
		now: () => NOW,
	});
	if (!attempt.ok) throw attempt.error;
	const seedLedger = new SessionLedger(durableSession, { ownerId: canonicalSchedulerOwnerId });
	for (const [objectType, objectId, payload, correlation] of [
		["task", schedulerTask().taskId, schedulerTask(), { taskId: schedulerTask().taskId }],
		["role_revision", currentBinding.roleRevision.id, schedulerRoleRevision(), { taskId: schedulerTask().taskId, bindingId: currentBinding.bindingId }],
		["model_profile_revision", currentBinding.modelProfileRevision.id, schedulerModelProfile(), { taskId: schedulerTask().taskId, bindingId: currentBinding.bindingId }],
		["external_agent_binding", currentBinding.contextRevision.id, { schemaVersion: 1 as const, type: currentBinding.contextRevision.type, id: currentBinding.contextRevision.id, revision: currentBinding.contextRevision.revision }, { taskId: schedulerTask().taskId, bindingId: currentBinding.bindingId }],
		["capability_binding", currentBinding.capabilityRevision.id, { schemaVersion: 1 as const, type: currentBinding.capabilityRevision.type, id: currentBinding.capabilityRevision.id, revision: currentBinding.capabilityRevision.revision }, { taskId: schedulerTask().taskId, bindingId: currentBinding.bindingId }],
		["model_broker_binding", currentBinding.modelBrokerBindingRevision.id, { schemaVersion: 1 as const, type: currentBinding.modelBrokerBindingRevision.type, id: currentBinding.modelBrokerBindingRevision.id, revision: currentBinding.modelBrokerBindingRevision.revision }, { taskId: schedulerTask().taskId, bindingId: currentBinding.bindingId }],
		["policy_binding", currentBinding.policyRevision.id, { schemaVersion: 1 as const, type: currentBinding.policyRevision.type, id: currentBinding.policyRevision.id, revision: currentBinding.policyRevision.revision }, { taskId: schedulerTask().taskId, bindingId: currentBinding.bindingId }],
		["agent_binding", currentBinding.bindingId, currentBinding, { taskId: schedulerTask().taskId, bindingId: currentBinding.bindingId }],
		["dispatch", dispatch.dispatchId, dispatch, { taskId: schedulerTask().taskId, dispatchId: dispatch.dispatchId, bindingId: currentBinding.bindingId }],
		["binding_epoch", epoch.value.bindingEpochId, epoch.value, { taskId: schedulerTask().taskId, attemptId: attempt.value.attemptId, bindingId: currentBinding.bindingId, bindingEpochId: epoch.value.bindingEpochId }],
		["attempt", attempt.value.attemptId, attempt.value, { taskId: schedulerTask().taskId, dispatchId: dispatch.dispatchId, attemptId: attempt.value.attemptId, bindingId: currentBinding.bindingId, bindingEpochId: epoch.value.bindingEpochId }],
	] as const) {
		await seedLedger.appendFact(objectType, objectId, payload, {
			clientRequestId: `line13-scheduler-reopen:${objectType}`,
			expectedRevision: 0,
			correlation,
		});
	}
	clock = LATER;
	const reopened = await createAgentSessionFromServices(sessionOptions());
	await reopened.session.whenCapabilitiesReady();
	const reopenedQueue = new SchedulerQueueStore({
		ledger: durableSession,
		sessionId: sessionManager.getSessionId(),
		ownerId: canonicalSchedulerOwnerId,
		now: () => LATER,
	});
	let recovered = await reopenedQueue.getEntry("queue-line13-reopen");
	for (
		let attempt = 0;
		attempt < 100 && recovered.ok && recovered.value.state !== "queued";
		attempt += 1
	) {
		await new Promise<void>((resolve) => setImmediate(resolve));
		recovered = await reopenedQueue.getEntry("queue-line13-reopen");
	}
	if (!recovered.ok) throw recovered.error;
	return {
		factoryCalls,
		recoveredState: recovered.value.state,
		recoveredAttempts: recovered.value.attemptsUsed,
		cancelledAttemptIds,
		cleanup: async () => {
			await reopened.session.dispose();
			await reopened.session.waitForDispose();
			rmSync(cwd, { recursive: true, force: true });
		},
	};
}

async function createCurrentConnectorFixture(toolGateway = false, crashDuringRead = false) {
	const storage = new InMemorySessionStorage({ id: `line13-current-${toolGateway}`, createdAt: 1 });
	const session = new Session(storage);
	const t5 = new SessionT5Ledger(session, { ownerId: `line13-current-${toolGateway}` });
	const snapshot = createConnectorCapabilitySnapshot({
		schemaVersion: 1,
		providerId: "line13-current-connector",
		revision: 1,
		protocol: { name: "line13-fixture", version: "1" },
		modelAccess: "agent_owned",
		resume: toolGateway,
		toolGateway,
		artifacts: false,
		images: false,
	});
	const toolGatewayRequests: ToolGatewayRequest[] = [];
	const toolGatewayResults: ToolExecutionResult[] = [];
	const invokeToolGateway = async (
		request: ToolGatewayRequest,
	): Promise<Result<ToolExecutionResult, FoundationError>> => {
		toolGatewayRequests.push(request);
		const result: ToolExecutionResult = {
			schemaVersion: 1,
			toolCallId: request.toolCallId,
			toolName: request.toolName,
			ok: true,
			sideEffectState: "none",
			toolReceiptRef: `line13-receipt-${request.toolCallId}`,
		};
		toolGatewayResults.push(result);
		return Result.ok(result);
	};
	const createToolGatewayRuntime = () =>
		createFoundationToolGateway({
			gatewayId: "line13-ac07-tool-gateway",
			providers: [
				createLocalToolGatewayProvider({
					providerId: snapshot.providerId,
					revision: 1,
					routes: [
						{
							kind: "local",
							toolName: "read",
							namespace: "workspace",
							providerId: snapshot.providerId,
							revision: 1,
							operation: { resource: "filesystem.read", effects: ["read"] },
						},
					],
					invoke: invokeToolGateway,
				}),
			],
		});
	const toolGatewayRuntime = createToolGatewayRuntime();
	const store = new SessionExternalConnectorDurableStore(new SessionLedger(session, { writer: t5.writer }));
	const supervision = createExternalConnectorTestSupervision();
	const initialSupervision = crashDuringRead
		? {
				...supervision.options,
				deadlines: {
					...supervision.options.deadlines,
					receipt: { hardMs: 30_000, idleMs: 30_000 },
				},
			}
		: supervision.options;
	const descriptor = {
		schemaVersion: 1 as const,
		providerId: snapshot.providerId,
		providerClass: "external_connector" as const,
		revision: snapshot.revision,
		capabilitySnapshotDigest: snapshot.digest,
	};
	const createRegisteredRuntime = async (
		driver: Line13CurrentDriver,
		runtimeSupervision = supervision.options,
		runtimeSession = session,
		runtimeT5 = t5,
		runtimeToolGateway = toolGatewayRuntime,
	) => {
		const runtimeStore = new SessionExternalConnectorDurableStore(
			new SessionLedger(runtimeSession, { writer: runtimeT5.writer }),
		);
		const connector = createDurableExternalAgentConnector({
			providerId: snapshot.providerId,
			capability: snapshot,
			capabilityProbe: async () => Result.ok(snapshot),
			store: runtimeStore,
			driver,
			supervision: runtimeSupervision,
			now: () => NOW,
			operationNonce: () => `line13-current-operation-${toolGateway}`,
		});
		const registry = createExternalConnectorRegistry({
			...(toolGateway ? { toolGateway: runtimeToolGateway } : {}),
		});
		const registered = await registry.register({
			descriptor,
			connector,
		});
		if (!registered.ok) throw registered.error;
		return {
			connector,
			registry,
			session: runtimeSession,
			t5: runtimeT5,
			store: runtimeStore,
			toolGateway: runtimeToolGateway,
		};
	};
	const driver = new Line13CurrentDriver(toolGateway, { readHangs: crashDuringRead });
	const { connector, registry } = await createRegisteredRuntime(driver, initialSupervision);
	const selection = {
		providerId: descriptor.providerId,
		revision: descriptor.revision,
		capabilitySnapshotDigest: descriptor.capabilitySnapshotDigest,
	};
	return {
		session,
		t5,
		registry,
		connector,
		descriptor,
		selection,
		driver,
		store,
		toolGatewayRequests,
		toolGatewayResults,
		toolGatewayRuntime,
		recompose: async (canonicalToolGatewayRequests: readonly ToolGatewayRequest[]) => {
			const attemptId = canonicalToolGatewayRequests[0]?.context.attemptId;
			if (attemptId === undefined) throw new Error("Line 13 recovery requires a canonical Attempt identity");
			const privateState = await supervision.privateStateStore.read(attemptId);
			if (privateState === undefined) throw new Error("Line 13 recovery requires durable supervisor identity");
			const restoredSupervision = createExternalConnectorTestSupervision();
			await restoredSupervision.privateStateStore.write(attemptId, privateState);
			let releaseReloadedProcess: (() => void) | undefined;
			const reloadedProcessHandle: ExternalConnectorProcessHandle = {
				operationNonce: privateState.reference.operationNonce,
				detached: false,
				containment: privateState.containment,
				identity: privateState.processIdentity,
				exited: new Promise<void>((resolve) => {
					releaseReloadedProcess = resolve;
				}),
				activate: async () => undefined,
				forceTerminate: (_request: ExternalConnectorProcessTerminationRequest): ExternalConnectorProcessTerminationResult => {
					releaseReloadedProcess?.();
					releaseReloadedProcess = undefined;
					return "termination_requested";
				},
				forceTerminateBounded: async (
					_request: ExternalConnectorProcessTerminationRequest,
					options: ExternalConnectorProcessTerminationOptions,
				): Promise<ExternalConnectorProcessTerminationResult> => {
					if (options.signal?.aborted === true) return "ambiguous";
					releaseReloadedProcess?.();
					releaseReloadedProcess = undefined;
					return "termination_requested";
				},
			};
			restoredSupervision.processController.reattachResult = {
				status: "attached",
				handle: reloadedProcessHandle,
			};
			const restoredSession = new Session(storage);
			const restoredT5 = new SessionT5Ledger(restoredSession, { ownerId: `line13-current-${toolGateway}` });
			const restoredToolGateway = createToolGatewayRuntime();
			const restoredDriver = new Line13CurrentDriver(true, { canonicalToolGatewayRequests });
			return {
				...(await createRegisteredRuntime(
					restoredDriver,
					restoredSupervision.options,
					restoredSession,
					restoredT5,
					restoredToolGateway,
				)),
				driver: restoredDriver,
			};
		},
	};
}

interface CanonicalCurrentConnectorState {
	readonly driver: Line13CurrentDriver;
	readonly supervision: ReturnType<typeof createExternalConnectorTestSupervision>;
	readonly supervisionOptions: ReturnType<typeof createExternalConnectorTestSupervision>["options"];
	store?: SessionExternalConnectorDurableStore;
	connector?: ReturnType<typeof createDurableExternalAgentConnector>;
	registry?: ExternalConnectorRegistry;
}

/**
 * AC-07 uses the same composition root as product sessions. Its policy binding
 * is materialized by the canonical Session control plane and then supplied to
 * the product run, so the gateway authority cannot be replaced by a fixture
 * callback or an isolated registry.
 */
async function createCanonicalCurrentConnectorFixture(crashDuringRead = false) {
	const cwd = mkdtempSync(join(tmpdir(), "aos-line13-ac07-canonical-"));
	const settingsManager = SettingsManager.inMemory({
		executionPolicy: {
			defaultProfile: EXTERNAL_POLICY_PROFILE.id,
			profiles: { [EXTERNAL_POLICY_PROFILE.id]: EXTERNAL_POLICY_PROFILE },
		},
	});
	const modelRuntime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null });
	const sessionManager = SessionManager.inMemory(cwd, { id: "line13-ac07-session" });
	const snapshot = createConnectorCapabilitySnapshot({
		schemaVersion: 1,
		providerId: "line13-current-connector",
		revision: 1,
		protocol: { name: "line13-fixture", version: "1" },
		modelAccess: "agent_owned",
		resume: true,
		toolGateway: true,
		artifacts: false,
		images: false,
	});
	const descriptor = {
		schemaVersion: 1 as const,
		providerId: snapshot.providerId,
		providerClass: "external_connector" as const,
		revision: snapshot.revision,
		capabilitySnapshotDigest: snapshot.digest,
	};
	const toolGatewayRequests: ToolGatewayRequest[] = [];
	const toolGatewayResults: ToolExecutionResult[] = [];
	const createToolGatewayRuntime = () =>
		createFoundationToolGateway({
			gatewayId: "line13-ac07-tool-gateway",
			providers: [
				createLocalToolGatewayProvider({
					providerId: snapshot.providerId,
					revision: 1,
					routes: [
						{
							kind: "local",
							toolName: "read",
							namespace: "workspace",
							providerId: snapshot.providerId,
							revision: 1,
							operation: { resource: "filesystem.read", effects: ["read"] },
						},
					],
					invoke: async (request: ToolGatewayRequest): Promise<Result<ToolExecutionResult, FoundationError>> => {
						toolGatewayRequests.push(request);
						const result: ToolExecutionResult = {
							schemaVersion: 1,
							toolCallId: request.toolCallId,
							toolName: request.toolName,
							ok: true,
							sideEffectState: "none",
							toolReceiptRef: `line13-receipt-${request.toolCallId}`,
						};
						toolGatewayResults.push(result);
						return Result.ok(result);
					},
				}),
			],
		});
	const states = new Map<string, CanonicalCurrentConnectorState>();
	const runtimeComposition = codingAgentEntry.createAgentRuntimeCompositionFactory({
		toolGateway: (context) => {
			if (states.get(context.sessionId) === undefined) throw new Error("AC-07 canonical gateway state is missing");
			return createToolGatewayRuntime();
		},
		externalConnectorRegistry: (context, toolGateway) => {
			if (toolGateway === undefined) throw new Error("AC-07 canonical composition omitted the Tool Gateway");
			const state = states.get(context.sessionId);
			if (state === undefined) throw new Error("AC-07 canonical connector state is missing");
			const store = new SessionExternalConnectorDurableStore(
				new SessionLedger(context.session, { writer: context.harness.t5.writer }),
			);
			const connector = createDurableExternalAgentConnector({
				providerId: snapshot.providerId,
				capability: snapshot,
				capabilityProbe: async () => Result.ok(snapshot),
				store,
				driver: state.driver,
				supervision: state.supervisionOptions,
				now: () => NOW,
				operationNonce: () => "line13-current-operation-true",
			});
			const registry = createExternalConnectorRegistry({ toolGateway });
			const registered = registry.registerPrepared({ descriptor, connector }, snapshot);
			if (!registered.ok) throw registered.error;
			state.store = store;
			state.connector = connector;
			state.registry = registry;
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
	const sessions: AgentSession[] = [];
	const initialSupervision = createExternalConnectorTestSupervision();
	const initialSupervisionOptions = crashDuringRead
		? {
				...initialSupervision.options,
				deadlines: {
					...initialSupervision.options.deadlines,
					receipt: { hardMs: 30_000, idleMs: 30_000 },
				},
			}
		: initialSupervision.options;
	const initialDriver = new Line13CurrentDriver(true, { readHangs: crashDuringRead });
	const initialState: CanonicalCurrentConnectorState = {
		driver: initialDriver,
		supervision: initialSupervision,
		supervisionOptions: initialSupervisionOptions,
	};
	states.set(sessionManager.getSessionId(), initialState);
	const initial = await createAgentSessionFromServices({
		services,
		sessionManager,
		policyProfile: EXTERNAL_POLICY_PROFILE.id,
	});
	sessions.push(initial.session);
	const initialComposition = initial.runtimeComposition;
	const session = initialComposition.harness.t5.session;
	const t5 = initialComposition.harness.t5;
	const registry = initialState.registry;
	const connector = initialState.connector;
	const store = initialState.store;
	const toolGatewayRuntime = initialComposition.toolGateway;
	if (registry === undefined || connector === undefined || store === undefined || toolGatewayRuntime === undefined) {
		throw new Error("AC-07 canonical composition did not register its gateway connector");
	}
	return {
		session,
		t5,
		registry,
		connector,
		descriptor,
		selection: {
			providerId: descriptor.providerId,
			revision: descriptor.revision,
			capabilitySnapshotDigest: descriptor.capabilitySnapshotDigest,
		},
		driver: initialDriver,
		store,
		toolGatewayRequests,
		toolGatewayResults,
		toolGatewayRuntime,
		preparePolicy: async (runId: string) => {
			await initial.session.whenCapabilitiesReady(runId);
			const policyBinding = initial.session.getActiveExecutionPolicyBinding();
			if (policyBinding === undefined || policyBinding.runId !== runId) {
				throw new Error("AC-07 canonical Session did not materialize its Run policy binding");
			}
			return policyBinding;
		},
		getCapabilityBinding: () => initial.session.getActiveCapabilityBinding(),
		recompose: async (canonicalToolGatewayRequests: readonly ToolGatewayRequest[]) => {
			const attemptId = canonicalToolGatewayRequests[0]?.context.attemptId;
			if (attemptId === undefined) throw new Error("Line 13 recovery requires a canonical Attempt identity");
			const privateState = await initialSupervision.privateStateStore.read(attemptId);
			if (privateState === undefined) throw new Error("Line 13 recovery requires durable supervisor identity");
			const restoredSupervision = createExternalConnectorTestSupervision();
			await restoredSupervision.privateStateStore.write(attemptId, privateState);
			let releaseReloadedProcess: (() => void) | undefined;
			const reloadedProcessHandle: ExternalConnectorProcessHandle = {
				operationNonce: privateState.reference.operationNonce,
				detached: false,
				containment: privateState.containment,
				identity: privateState.processIdentity,
				exited: new Promise<void>((resolve) => {
					releaseReloadedProcess = resolve;
				}),
				activate: async () => undefined,
				forceTerminate: () => {
					releaseReloadedProcess?.();
					releaseReloadedProcess = undefined;
					return "termination_requested";
				},
				forceTerminateBounded: async (_request, _options) => {
					releaseReloadedProcess?.();
					releaseReloadedProcess = undefined;
					return "termination_requested";
				},
			};
			restoredSupervision.processController.reattachResult = {
				status: "attached",
				handle: reloadedProcessHandle,
			};
			const restoredDriver = new Line13CurrentDriver(true, { canonicalToolGatewayRequests });
			const restoredState: CanonicalCurrentConnectorState = {
				driver: restoredDriver,
				supervision: restoredSupervision,
				supervisionOptions: restoredSupervision.options,
			};
			states.set(sessionManager.getSessionId(), restoredState);
			const restored = await createAgentSessionFromServices({
				services,
				sessionManager,
				policyProfile: EXTERNAL_POLICY_PROFILE.id,
				noTools: "all",
			});
			sessions.push(restored.session);
			const restoredComposition = restored.runtimeComposition;
			const restoredSession = restoredComposition.harness.t5.session;
			const restoredT5 = restoredComposition.harness.t5;
			const restoredRegistry = restoredState.registry;
			const restoredConnector = restoredState.connector;
			const restoredStore = restoredState.store;
			const restoredToolGateway = restoredComposition.toolGateway;
			if (
				restoredRegistry === undefined ||
				restoredConnector === undefined ||
				restoredStore === undefined ||
				restoredToolGateway === undefined
			) {
				throw new Error("AC-07 recomposition did not register its gateway connector");
			}
			return {
				session: restoredSession,
				t5: restoredT5,
				registry: restoredRegistry,
				connector: restoredConnector,
				store: restoredStore,
				driver: restoredDriver,
				toolGateway: restoredToolGateway,
			};
		},
		cleanup: async () => {
			initialDriver.releaseRead();
			for (const current of sessions) {
				await current.dispose();
				await current.waitForDispose();
			}
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
					assert.notEqual(
						recoveredRun,
						undefined,
						"AC-01 Run lifecycle recovery must reconstruct the terminal Run",
					);
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
					if (fixture.registry.list().length !== 1)
						throw new Error("AC-02 current registry fixture did not register its Connector");
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
			fullTestName:
				"Line 13 current External Connector persists the complete Foundation terminal chain without AgentInstance",
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
						dispatched ?? (await waitForRpcResponse(fixture.records, "ac03-current-start")),
					);
					assert.equal(started.success, true);
					const runId = started.data?.runId;
					assert.equal(typeof runId, "string");
					if (runId === undefined) return;
					await waitForRpcTerminal(fixture.records, runId);
					const durableSession = new Session(new SessionManagerStorage(fixture.sessionManager));
					const records = await durableSession.findFoundationRecords({
						includePruned: true,
						order: "oldestFirst",
					});
					const objectTypes = records.flatMap((record) =>
						record.kind === "retention" ? [] : [record.objectType],
					);
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
					const response = automationResponseView(
						await fixture.controller.dispatch({
							id: "ac05-raw-image",
							type: "run.start",
							message: "Reject raw image bytes",
							images: [{ type: "image", data: "AA==", mimeType: "image/png" }],
							externalConnector: fixture.externalConnectorSelection,
						}),
					);
					assert.equal(response.success, false);
					assert.equal(response.error?.code, "external_binding_invalid");
					const durableSession = new Session(new SessionManagerStorage(fixture.sessionManager));
					const records = await durableSession.findFoundationRecords({ includePruned: true });
					const productWrites = records.filter(
						(record) =>
							record.kind !== "retention" && ["foundation.goal", "task", "attempt"].includes(record.objectType),
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
							dispatched ?? (await waitForRpcResponse(current.records, `ac06-start-${index}`)),
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
		defineLine13ResolvedCase({
			ac: "AC-07",
			fullTestName:
				"Line 13 advertised External Connector tool-gateway capability survives crash, reload, resume, and terminal product settlement",
			scenario: {
				fixture: () => createCanonicalCurrentConnectorFixture(true),
				assertion: async (fixture) => {
					const runId = "line13-ac07-tool-gateway";
					const canonicalInput = {
						schemaVersion: 1 as const,
						text: "Reach the bound tool gateway during real execution",
						artifacts: [],
					};
					const identity = externalConnectorProductIdentity(runId, fixture.descriptor.providerId);
					const expectedRequest = (toolCallId: string, path: string): ToolGatewayRequest => ({
						schemaVersion: 1,
						toolCallId,
						toolName: "read",
						namespace: "workspace",
						originalArguments: { path, mode: "metadata" },
						idempotencyKey: `${toolCallId}-once`,
						context: {
							schemaVersion: 1,
							bindingId: identity.bindingId,
							bindingEpochId: identity.bindingEpochId,
							taskId: identity.taskId,
							dispatchId: identity.dispatchId,
							providerId: fixture.descriptor.providerId,
							attemptId: identity.attemptId,
							operationId: runId,
						},
					});
					const expectedRequests = [
						expectedRequest("line13-ac07-tool-call-1", "docs/evidence.txt"),
						expectedRequest("line13-ac07-tool-call-2", "docs/second.txt"),
					];
					const abandonedExecution = executeExternalConnectorProductRun({
						session: fixture.session,
						writer: fixture.t5.writer,
						registry: fixture.registry,
						selection: fixture.selection,
						runId,
						message: canonicalInput.text,
						canonicalInput,
						inputAdmission: {
							inspectArtifact: () => {
								throw new Error("no artifacts");
							},
						},
						workspace: "workspace-ref",
						policyBinding: await fixture.preparePolicy(runId),
						capabilityBinding: fixture.getCapabilityBinding()!,
						now: () => NOW,
					});
					void abandonedExecution.catch(() => undefined);
					let operation = await fixture.store.readOperation(identity.attemptId);
					for (
						let attempt = 0;
						attempt < 100 &&
						(operation?.status !== "running" ||
							fixture.driver.readCalls !== 1 ||
							fixture.toolGatewayResults.length !== 2);
						attempt += 1
					) {
						await new Promise<void>((resolve) => setImmediate(resolve));
						operation = await fixture.store.readOperation(identity.attemptId);
					}
					assert.equal(operation?.status, "running", "AC-07 crash cut must follow durable running state");
					assert.equal(fixture.driver.spawnCalls, 1, "AC-07 crash cut must follow one actual vendor start");
					assert.equal(fixture.driver.readCalls, 1, "AC-07 must interrupt an actual started Connector read");
					assert.equal(fixture.toolGatewayResults.length, 2, "AC-07 start must persist both gateway results");

					const restored = await fixture.recompose(expectedRequests);
					const execution = await (async () => {
						try {
							return await recoverExternalConnectorProductRun({
								session: restored.session,
								writer: restored.t5.writer,
								registry: restored.registry,
								runId,
								providerId: fixture.descriptor.providerId,
								selection: fixture.selection,
								expectedCanonicalInput: canonicalInput,
							});
						} finally {
							fixture.driver.releaseRead();
							await abandonedExecution.catch(() => undefined);
						}
					})();
					const expectedResults: ToolExecutionResult[] = expectedRequests.map((request) => ({
						schemaVersion: 1,
						toolCallId: request.toolCallId,
						toolName: request.toolName,
						ok: true,
						sideEffectState: "none",
						toolReceiptRef: `line13-receipt-${request.toolCallId}`,
					}));
					const policyRecords = await restored.session.findFoundationRecords({
						kind: "fact",
						objectType: "policy_binding",
					});
					const gatewayRecords = await restored.session.findFoundationRecords({
						objectType: EXTERNAL_CONNECTOR_TOOL_GATEWAY_EXECUTION_OBJECT_TYPE,
						includePruned: true,
						order: "oldestFirst",
					});
					const gatewayObjectIds = [
						...new Set(
							gatewayRecords.flatMap((record) => (record.kind === "retention" ? [] : [record.objectId])),
						),
					].sort();
					assert.deepStrictEqual(
						{
							requests: fixture.toolGatewayRequests,
							results: fixture.toolGatewayResults,
							initialConsumerWrites: fixture.driver.writes,
							replayedConsumerWrites: restored.driver.writes,
							resumeConnects: restored.driver.connectCalls,
							reloadedSpawns: restored.driver.spawnCalls,
							reloadedSession: restored.session !== fixture.session,
							reloadedGateway: restored.toolGateway !== fixture.toolGatewayRuntime,
							recomposedConnector: restored.connector !== fixture.connector,
							exchanges: execution.toolGatewayExchanges,
							policyBindings: policyRecords.length,
							fabricatedPolicyAuthority: JSON.stringify(policyRecords).includes("trusted_connector"),
							gatewayObjectIds,
							attemptStatus: execution.attemptReceipt.status,
							runStatus: execution.runReceipt.terminalStatus,
						},
						{
							requests: expectedRequests,
							results: expectedResults,
							initialConsumerWrites: [
								{
									schemaVersion: 1,
									kind: "tool_gateway_result",
									operationNonce: "line13-current-operation-true",
									result: expectedResults[0],
								},
								{
									schemaVersion: 1,
									kind: "tool_gateway_result",
									operationNonce: "line13-current-operation-true",
									result: expectedResults[0],
								},
								{
									schemaVersion: 1,
									kind: "tool_gateway_result",
									operationNonce: "line13-current-operation-true",
									result: expectedResults[1],
								},
							],
							replayedConsumerWrites: [
								{
									schemaVersion: 1,
									kind: "tool_gateway_result",
									operationNonce: "line13-current-operation-true",
									result: expectedResults[0],
								},
								{
									schemaVersion: 1,
									kind: "tool_gateway_result",
									operationNonce: "line13-current-operation-true",
									result: expectedResults[1],
								},
							],
							resumeConnects: 1,
							reloadedSpawns: 0,
							reloadedSession: true,
							reloadedGateway: true,
							recomposedConnector: true,
							exchanges: [
								{ request: expectedRequests[0], result: expectedResults[0] },
								{ request: expectedRequests[1], result: expectedResults[1] },
							],
							policyBindings: 1,
							fabricatedPolicyAuthority: false,
							gatewayObjectIds: expectedRequests
								.map((request) =>
									externalConnectorToolGatewayExchangeId(identity.attemptId, request.toolCallId),
								)
								.sort(),
							attemptStatus: "succeeded",
							runStatus: "completed",
						},
						"advertised tool gateway must execute distinct canonical exchanges through the product policy binding and exact Tool Gateway",
					);
				},
			},
		}),
		defineLine13ResolvedCase({
			ac: "AC-08",
			fullTestName:
				"Line 13 reopened product sessions recompose Scheduler workflow recovery from durable expired work",
			scenario: {
				fixture: createSchedulerReopenFixture,
				assertion: (fixture) => {
					assert.deepStrictEqual(
						{
							factoryCalls: fixture.factoryCalls,
							recoveredState: fixture.recoveredState,
							recoveredAttempts: fixture.recoveredAttempts,
							cancelledAttemptIds: fixture.cancelledAttemptIds,
						},
						{
							factoryCalls: 2,
							recoveredState: "queued",
							recoveredAttempts: 1,
							cancelledAttemptIds: ["attempt-line13-reopen"],
						},
						"reopened product sessions must recompose Scheduler recovery from durable state",
					);
				},
				cleanup: (fixture) => fixture.cleanup(),
			},
		}),
	],
	cases: [],
});
