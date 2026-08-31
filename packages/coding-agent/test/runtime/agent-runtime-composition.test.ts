import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	createModelProfileRevision,
	createConnectorCapabilitySnapshot,
	createAgentInstance,
	createRoleRevision,
	createScopedMemoryStore,
	createTaskEnvelope,
	fingerprintFoundationValue,
	FoundationError,
	InMemoryArtifactBlobStore,
	InMemorySessionStorage,
	resolveAgentBinding,
	Result,
	Session,
	SessionLedger,
	ContextLedger,
	type AgentBinding,
	type AgentHarness,
	type AgentInstance,
	type Attempt,
	type ArtifactStoreProvider,
	type ChildSpawnRequest,
	type ModelProfile,
	type QuotaProvider,
	type RevisionReference,
	type RoleRevision,
	type ScopedModelGateway,
	type TaskEnvelope,
	type ToolGateway,
	type ToolGatewayProvider,
	type ToolGatewayRoute,
} from "../../../agent/src/internal.ts";
import { Agent } from "@aos-agent/agent-core";
import type { Model } from "@aos-agent/ai";
import { PROVIDER_CLASS } from "../../src/core/connector/provider-class.ts";
import { NodeExecutionEnv } from "@aos-agent/agent-core/node";
import { createModels } from "@aos-agent/ai";
import { getModel } from "@aos-agent/ai/compat";
import { googleProvider } from "@aos-agent/ai/providers/google";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createAgentRuntimeCompositionFactory,
	createAgentSession,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	InteractiveMode,
	runPrintMode,
	type CreateAgentSessionRuntimeFactory,
} from "../../src/index.ts";
import { createRpcHostController } from "../../src/modes/rpc/rpc-host.ts";
import {
	buildExternalConnectorTargetConfig,
	ExternalConnectorTargetConfigError,
	type ExternalConnectorResolvedTarget,
	type ExternalConnectorTargetConfigErrorReason,
	type ExternalConnectorTargetDefinition,
} from "../../src/external-connector.ts";
import {
	createWorkerSandboxComposition,
	materializeAgentRuntimeComposition,
	type AgentRuntimeComposition,
	type AgentRuntimeCompositionContext,
	type AgentRuntimeCompositionFactory,
	type AgentRuntimeCompositionOptions,
	type SchedulerRuntimeOptions,
} from "../../src/core/runtime/composition.ts";
import {
	createExternalConnectorRegistry,
	type ExternalConnectorRegistry,
} from "../../src/core/connector/registry.ts";
import { bindExternalConnectorVendorBehaviorManifest } from "../../src/core/connector/tool-gateway-binding.ts";
import { bindCanonicalExternalToolGatewayPolicy } from "../../src/core/connector/tool-gateway.ts";
import type { TaskCredentialProvider } from "../../src/core/policy/task-credential-provider.ts";
import { SchedulerExecutorRegistry } from "../../src/core/scheduler/executors.ts";
import { AuthStorage } from "../../src/core/policy/auth-storage.ts";
import { AgentSession } from "../../src/core/session/agent-session.ts";
import { getAgentCanonicalSession } from "../../src/core/session/facade.ts";
import { ModelRuntime } from "../../src/core/runtime/model-runtime.ts";
import { createRunLifecycleCoordinator, type RunHandle } from "../../src/core/session/run-lifecycle.ts";
import type { SchedulerNativeAgentResolveInput } from "../../src/core/scheduler/dispatch.ts";
import { SessionManager } from "../../src/core/session/manager.ts";
import { createSessionManagerStorage } from "../../src/core/session/manager-storage.ts";
import type { SchedulerSelectionReservationStore } from "../../src/core/scheduler/selection-reservations.ts";
import { SettingsManager } from "../../src/core/runtime/settings-manager.ts";
import type {
	SubagentCompositionOptions,
} from "../../src/core/subagent/composition.ts";
import type { SubagentProviderDescriptor } from "../../src/core/subagent/registry.ts";
import type { PlanSubagentSpawnInput } from "../../src/core/subagent/supervisor.ts";
import { createTaskCredentialTestProvider } from "../../src/core/policy/task-credential-provider.ts";
import { TaskGraphStore } from "../../src/core/scheduler/task-graph.ts";
import { createCodingAgentHarness } from "../../src/server/create-harness.ts";
import { sourceProcessArgs, sourceProcessEnv } from "../cli-process.ts";
import { createExternalConnectorTestRuntime } from "../connector/external-connector-test-supervision.ts";
import { observeCanonicalTerminal } from "../support/canonical-run-terminal.ts";
import {
	createRecordingCredentialProvider,
	createExternalConnectorRegistryFactory,
	createExternalConnectorSyntheticCompositionContext,
	createCrossLayerToolGateway,
	EXTERNAL_CREDENTIAL_CANARY,
	EXTERNAL_CONNECTOR_CREDENTIAL_SCOPE,
	externalCredentialPolicySettings,
	crossLayerTargetConfig,
	executeCrossLayerProductRun,
	type ExternalConnectorRegistryCapture,
} from "../connector/fixtures/cross-layer.ts";

const NOW = "2026-08-26T00:00:00.000Z";
const CHILD_ENTRY = fileURLToPath(new URL("../fixtures/fake-worker-child.ts", import.meta.url));
const MAIN_RPC_ENTRY = fileURLToPath(new URL("../fixtures/main-rpc-runtime-composition.ts", import.meta.url));
// Full-suite source-loader contention is outside the RPC initialize budget.
const MAIN_RPC_READY_MARKER = "--- Startup Timings: main ---";

interface RuntimeFixture {
	readonly cwd: string;
	readonly services: Awaited<ReturnType<typeof createAgentSessionServices>>;
}

interface CompositionCaptures {
	readonly contexts: AgentRuntimeCompositionContext[];
	readonly gateways: ToolGateway[];
	readonly composedGateways: ToolGateway[];
	readonly workers: ReturnType<typeof createWorkerSandboxComposition>[];
	readonly subagents: SubagentCompositionOptions[];
	readonly schedulers: SchedulerRuntimeOptions[];
	readonly externalRegistries: ExternalConnectorRegistry[];
	readonly credentialProviders: TaskCredentialProvider[];
}

const directories: string[] = [];

async function createRuntimeFixture(runtimeComposition?: AgentRuntimeCompositionFactory): Promise<RuntimeFixture> {
	const cwd = mkdtempSync(join(tmpdir(), "aos-runtime-composition-"));
	directories.push(cwd);
	return {
		cwd,
		services: await createAgentSessionServices({
			cwd,
			agentDir: cwd,
			modelRuntime: await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null }),
			settingsManager: SettingsManager.inMemory(),
			...(runtimeComposition === undefined ? {} : { runtimeComposition }),
			resourceLoaderOptions: {
				noExtensions: true,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
			},
		}),
	};
}

function runtimeFactory(fixture: RuntimeFixture): CreateAgentSessionRuntimeFactory {
	return async (options) => {
		const created = await createAgentSessionFromServices({
			services: fixture.services,
			sessionManager: options.sessionManager,
			sessionStartEvent: options.sessionStartEvent,
			noTools: "all",
		});
		options.registerCandidateSession(created.session);
		return {
			...created,
			services: fixture.services,
			diagnostics: fixture.services.diagnostics,
		};
	};
}

async function createExternalConnectorSurfaceRuntime(sessionId: string) {
	const fixture = await createRuntimeFixture(createAgentRuntimeCompositionFactory({
		externalConnectorRegistry: (context) => createTestExternalConnectorRegistry(context.sessionId),
	}));
	return await createAgentSessionRuntime(runtimeFactory(fixture), {
		cwd: fixture.cwd,
		agentDir: fixture.cwd,
		session: { mode: "memory", id: sessionId },
	});
}

function createGateway(sessionId: string): ToolGateway {
	return {
		schemaVersion: 1,
		providerId: `composition-gateway-${sessionId}`,
		providerClass: "gateway",
		capabilities: async () => [],
		dispose: async () => {},
		execute: async () => Result.err(new FoundationError("tool_guard_denied", "not exercised")),
	};
}

function externalTargetDefinition(
	cwd: string,
	targetId: string,
	providerId = `provider-${targetId}`,
	capabilityOverrides: Partial<ExternalConnectorTargetDefinition["capabilityCeiling"]> = {},
): ExternalConnectorTargetDefinition {
	return {
		schemaVersion: 1,
		targetId,
		providerId,
		executablePath: process.execPath,
		modulePath: process.execPath,
		cwd,
		version: "1.0.0",
		executableIdentity: `sha256:${"a".repeat(64)}`,
		moduleIdentity: `sha256:${"b".repeat(64)}`,
		endpoint: "https://connector.invalid/rpc",
		accountReference: { schemaVersion: 1, namespace: "test", accountId: `account-${targetId}` },
		capabilityCeiling: {
			modelAccess: ["none", "agent_owned"],
			resume: true,
			toolGateway: true,
			artifacts: true,
			images: true,
			...capabilityOverrides,
		},
	};
}

function expectTargetConfigError(
	action: () => unknown,
	reason: ExternalConnectorTargetConfigErrorReason,
): void {
	expect(action).toThrow(ExternalConnectorTargetConfigError);
	try {
		action();
	} catch (error) {
		expect(error).toMatchObject({ code: "external_connector_config_invalid", reason });
	}
}

function catalogProvider(
	kind: ToolGatewayProvider["kind"],
	providerId: string,
	revision: number,
	namespace: string,
	toolName: string,
	operation: ToolGatewayRoute["operation"],
	routeRevision = revision,
): ToolGatewayProvider {
	return {
		kind,
		providerId,
		revision,
		routes: [{ kind, providerId, revision: routeRevision, namespace, toolName, operation }],
		capabilities: async () => [],
		execute: async () => Result.err(new FoundationError("tool_guard_denied", "not exercised")),
		dispose: async () => {},
	};
}

function schedulerTask(sessionId: string): TaskEnvelope {
	const created = createTaskEnvelope({
		schemaVersion: 1,
		taskId: `task-${sessionId}`,
		goalId: `goal-${sessionId}`,
		goal: "Exercise the trusted runtime composition",
		workspace: "workspace-composition",
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

function roleRevision(sessionId: string) {
	return createRoleRevision({
		definition: {
			schemaVersion: 1,
			roleId: `role-${sessionId}`,
			scope: "project",
			slug: `runtime-${sessionId}`,
			name: "Runtime composition",
			description: "Runtime composition test role",
			revision: 1,
			persona: "Exercise trusted construction.",
			modelProfileRef: { schemaVersion: 1, type: "model_profile", id: `profile-${sessionId}`, revision: 1 },
			capabilitySelector: { policy: "none" },
			skillSelector: { policy: "none" },
			mcpSelector: { policy: "none" },
		},
		now: () => NOW,
	});
}

function modelProfile(sessionId: string): ModelProfile {
	return createModelProfileRevision({
		schemaVersion: 1,
		modelProfileId: `profile-${sessionId}`,
		provider: "fake",
		model: "model-1",
		budget: { tokens: 100, concurrency: 1 },
		revision: 1,
		createdAt: NOW,
	});
}

function immutableFact(type: string, id: string): RevisionReference {
	const value = { schemaVersion: 1 as const, type, id, revision: 1 };
	return { ...value, fingerprint: fingerprintFoundationValue(value) };
}

function schedulerBinding(currentTask: TaskEnvelope, sessionId: string): AgentBinding {
	const resolved = resolveAgentBinding({
		task: currentTask,
		roleRevision: roleRevision(sessionId),
		modelProfile: modelProfile(sessionId),
		contextRevision: immutableFact("external_agent_binding", `context-${sessionId}`),
		capabilityRevision: immutableFact("capability_binding", `capability-${sessionId}`),
		modelBrokerBindingRevision: immutableFact("model_broker_binding", `broker-${sessionId}`),
		policyRevision: immutableFact("policy_binding", `policy-${sessionId}`),
		newBindingId: `binding-${sessionId}`,
		now: () => NOW,
	});
	if (!resolved.ok) throw resolved.error;
	return resolved.value;
}

function createSubagents(
	context: AgentRuntimeCompositionContext,
	toolGateway: ToolGateway,
	createHarness: NonNullable<SubagentCompositionOptions["createHarness"]> = async () => context.harness,
): SubagentCompositionOptions {
	const memoryLedger = new ContextLedger(context.session, {
		writer: context.harness.ledger.writer,
		memoryScopeId: `composition-memory-scope-${context.sessionId}`,
		memoryOwnerId: `composition-parent-${context.sessionId}`,
		artifactBlobStore: new InMemoryArtifactBlobStore(),
	});
	const parentMemory = createScopedMemoryStore(
		memoryLedger.memory,
		"session",
		{
			ownerId: `composition-parent-${context.sessionId}`,
			scopeId: `composition-memory-scope-${context.sessionId}`,
			createdBy: "system",
		},
		{
			ownerId: `composition-parent-${context.sessionId}`,
			scopeId: `composition-memory-scope-${context.sessionId}`,
		},
	);
	const quota: QuotaProvider = {
		schemaVersion: 1,
		providerId: `composition-quota-${context.sessionId}`,
		providerClass: "quota",
		capabilities: async () => [],
		reserve: async (attribution, budget) => Result.ok({
			schemaVersion: 1,
			reservationId: `reservation-${context.sessionId}`,
			attribution,
			budget,
			grantedAt: NOW,
		}),
		settle: async (_reservation, usage) => Result.ok(usage),
		dispose: async () => {},
	};
	const modelGateway: ScopedModelGateway = {
		schemaVersion: 1,
		providerId: `composition-model-gateway-${context.sessionId}`,
		providerClass: "gateway",
		capabilities: async () => [],
		stream: async () => Result.err(new FoundationError("tool_guard_denied", "not exercised")),
		dispose: async () => {},
	};
	const artifactStore: ArtifactStoreProvider = {
		schemaVersion: 1,
		providerId: `composition-artifact-store-${context.sessionId}`,
		providerClass: "store",
		capabilities: async () => [],
		put: async () => Result.err(new FoundationError("tool_guard_denied", "not exercised")),
		get: async () => Result.err(new FoundationError("tool_guard_denied", "not exercised")),
		verify: async () => Result.ok({ schemaVersion: 1, digestValid: true }),
		delete: async () => Result.ok(undefined),
		dispose: async () => {},
	};
	const ledgerForLane = (laneId: string) => new SessionLedger(context.session, {
		writer: context.harness.ledger.writer,
		laneId,
	});
	return {
		schemaVersion: 1,
		enabled: true,
		session: context.session,
		writer: context.harness.ledger.writer,
		ledger: ledgerForLane("main"),
		ledgerForLane,
		sessionId: context.sessionId,
		parentLaneId: "main",
		quota,
		modelGateway,
		toolGateway,
		artifactStore,
		createHarness,
		loadParentContext: async () => Result.err(new FoundationError("subagent_context_fork_invalid", "not exercised")),
		parentMemory: {
			store: parentMemory,
			parentAgentInstanceId: `composition-parent-${context.sessionId}`,
		},
		fork: { executable: process.execPath, entrypoint: CHILD_ENTRY },
		limits: {
			maxDepth: 2,
			maxConcurrent: 1,
			maxTurns: 2,
			queueCapacity: 1,
			maximumQueueWaitMs: 100,
		},
		now: () => NOW,
	};
}

interface NativeSchedulerPlanProof {
	readonly childRole: RoleRevision;
	readonly childModel: ModelProfile;
	readonly parentTask: TaskEnvelope;
	readonly parent: AgentInstance;
	readonly parentAttemptId: string;
	readonly parentSpawnId: string;
}

function createNativeSchedulerPlanProof(sessionId: string): NativeSchedulerPlanProof {
	const childRole = roleRevision(sessionId);
	const childModel = modelProfile(sessionId);
	const parentTask = schedulerTask(`parent-${sessionId}`);
	const createdParent = createAgentInstance({
		agentInstanceId: `composition-parent-${sessionId}`,
		providerId: "composition-parent-provider",
		providerDeclaredAgent: true,
		roleRevision: childRole,
		taskId: parentTask.taskId,
		now: () => NOW,
	});
	if (!createdParent.ok) throw createdParent.error;
	return {
		childRole,
		childModel,
		parentTask,
		parent: createdParent.value,
		parentAttemptId: `parent-attempt-${sessionId}`,
		parentSpawnId: `parent-spawn-${sessionId}`,
	};
}

function nativeSchedulerPlan(
	input: SchedulerNativeAgentResolveInput,
	descriptor: SubagentProviderDescriptor,
	currentTask: TaskEnvelope,
	currentBinding: AgentBinding,
	proof: NativeSchedulerPlanProof,
): ReturnType<typeof Result.ok<PlanSubagentSpawnInput>> {
	const request: ChildSpawnRequest = {
		schemaVersion: 1,
		spawnId: input.spawnId,
		parentSpawn: {
			schemaVersion: 1,
			type: "agent.spawn",
			spawnId: proof.parentSpawnId,
			parentTaskId: proof.parent.taskId,
			newTaskEnvelopeRef: { schemaVersion: 1, type: "task_envelope", id: currentTask.taskId, revision: 1 },
			providerId: descriptor.descriptor.providerId,
			createdAt: NOW,
		},
		taskEnvelope: currentTask,
		roleRevision: proof.childRole,
		modelProfile: proof.childModel,
		parentAttemptId: proof.parentAttemptId,
		parentAgentInstanceId: proof.parent.agentInstanceId,
		forkScope: "none",
	};
	return Result.ok({
		schemaVersion: 1,
		request,
		originParentAgentInstance: proof.parent,
		originParentAttemptId: proof.parentAttemptId,
		lineageParentAgentInstance: proof.parent,
		childLaneId: input.laneId,
		childBinding: input.binding,
		providerDescriptor: descriptor,
		childAgentInstanceId: input.agentInstanceId,
		dispatchId: input.dispatchId,
		attemptId: input.attemptId,
		bindingEpochId: input.bindingEpochId,
		activatedByCommandId: input.activatedByCommandId,
		queue: { mode: "fail" },
	});
}

const schedulerAdmissionGate = Object.freeze({ getByBusinessKey: () => undefined });
const settleRunAtHost = async () => {
	throw new Error("No graph work is present");
};

function createScheduler(
	context: AgentRuntimeCompositionContext,
	cwd: string,
	selectionReservations: SchedulerSelectionReservationStore,
	options: {
		readonly registry?: SchedulerExecutorRegistry;
		readonly onStart?: () => void;
	} = {},
): SchedulerRuntimeOptions {
	const targetSessionId = `scheduler-target-${context.sessionId}`;
	const targetManager = SessionManager.inMemory(cwd, { id: targetSessionId });
	const targetSession = new Session(createSessionManagerStorage(targetManager));
	const currentTask = schedulerTask(context.sessionId);
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
			{ now: () => NOW },
		),
		ownerId: selectionReservations.ownerId,
		registry: options.registry ?? new SchedulerExecutorRegistry({ reservationStore: selectionReservations }),
		task: currentTask,
		binding: schedulerBinding(currentTask, context.sessionId),
		gateLookup: schedulerAdmissionGate,
		resolveRunAssociation: async () => {
			throw new Error("No graph work is present");
		},
		settleRunAtHost,
		...(options.onStart === undefined ? {} : {
			eventSource: {
				subscribe: () => {
					options.onStart?.();
					return () => {};
				},
			},
		}),
		pollIntervalMs: 60_000,
		now: () => NOW,
	};
}

function createTestExternalConnectorRegistry(
	sessionId: string,
	toolGateway?: ToolGateway,
	providerId = `external-connector-${sessionId}`,
): ExternalConnectorRegistry {
	const snapshot = createConnectorCapabilitySnapshot({
		schemaVersion: 1,
		providerId,
		revision: 1,
		protocol: { name: "composition-test", version: "1" },
		modelAccess: "none",
		resume: false,
		toolGateway: toolGateway !== undefined,
		artifacts: false,
		images: false,
	});
	const registry = createExternalConnectorRegistry({
		...(toolGateway === undefined ? {} : { toolGateway }),
	});
	const connector = createExternalConnectorTestRuntime(snapshot);
	if (snapshot.toolGateway) {
		bindExternalConnectorVendorBehaviorManifest(connector, () => ({
			schemaVersion: 1,
			revision: snapshot.revision,
			events: ["tool_gateway_request"],
			writes: ["tool_gateway_result"],
		}));
	}
	const registered = registry.registerPrepared({
		descriptor: {
			schemaVersion: 1,
			providerId: snapshot.providerId,
		providerClass: PROVIDER_CLASS.externalConnector,
			revision: snapshot.revision,
			capabilitySnapshotDigest: snapshot.digest,
		},
		connector,
	}, snapshot);
	if (!registered.ok) throw registered.error;
	return registry;
}

function createCompositionFactory(cwd: string, captures: CompositionCaptures): AgentRuntimeCompositionFactory {
	const options: AgentRuntimeCompositionOptions = {
		toolGateway: (context) => {
			captures.contexts.push(context);
			const gateway = createGateway(context.sessionId);
			captures.gateways.push(gateway);
			return gateway;
		},
		trustedWorkerSandboxFactory: (context) => {
			captures.contexts.push(context);
			const worker = createWorkerSandboxComposition({
				providerId: `composition-worker-${context.sessionId}`,
				profile: {
					profileId: `composition-worker-profile-${context.sessionId}`,
					profileRevision: 1,
					trusted: true,
					supervisor: {
						executable: process.execPath,
						entrypoint: CHILD_ENTRY,
						profileId: `composition-worker-profile-${context.sessionId}`,
						profileRevision: 1,
						capabilities: ["filesystem.read"],
						readyTimeoutMs: 1_000,
						heartbeatTimeoutMs: 1_000,
						cancelTimeoutMs: 100,
						terminateTimeoutMs: 100,
					},
				},
				resolvePreflight: () => {
					throw new Error("Worker execution is not part of composition construction");
				},
			});
			captures.workers.push(worker);
			return worker;
		},
		subagents: (context) => {
			captures.contexts.push(context);
			const gateway = captures.gateways.at(-1);
			if (gateway === undefined) throw new Error("Tool Gateway must be composed before Subagents");
			const subagents = createSubagents(context, gateway);
			captures.subagents.push(subagents);
			return subagents;
		},
		scheduler: (context, selectionReservations) => {
			captures.contexts.push(context);
			const scheduler = createScheduler(context, cwd, selectionReservations);
			captures.schedulers.push(scheduler);
			return scheduler;
		},
		externalConnectorRegistry: (context, toolGateway, _target, _authority, _credential) => {
			captures.contexts.push(context);
			if (toolGateway === undefined) throw new Error("External registry requires the canonical composition Tool Gateway");
			void _target;
			void _authority;
			void _credential;
			captures.composedGateways.push(toolGateway);
			const registry = createTestExternalConnectorRegistry(context.sessionId, toolGateway);
			captures.externalRegistries.push(registry);
			return registry;
		},
		taskCredentialProvider: (context) => {
			captures.contexts.push(context);
			const provider = createTaskCredentialTestProvider({
				materials: { fixture: `credential-${context.sessionId}` },
				now: () => NOW,
			});
			captures.credentialProviders.push(provider);
			return provider;
		},
		taskCredentialPolicyMaxTtlMs: 60_000,
	};
	return createAgentRuntimeCompositionFactory(options);
}

function emptyCaptures(): CompositionCaptures {
	return {
		contexts: [],
		gateways: [],
		composedGateways: [],
		workers: [],
		subagents: [],
		schedulers: [],
		externalRegistries: [],
		credentialProviders: [],
	};
}

function expectFreshComposition(initial: AgentRuntimeComposition, replacement: AgentRuntimeComposition): void {
	expect(replacement).not.toBe(initial);
	expect(replacement.session).not.toBe(initial.session);
	expect(replacement.harness).not.toBe(initial.harness);
	expect(replacement.toolGateway).not.toBe(initial.toolGateway);
	expect(replacement.workerSandboxProvider).not.toBe(initial.workerSandboxProvider);
	expect(replacement.subagents).not.toBe(initial.subagents);
	expect(replacement.subagents?.ledger).not.toBe(initial.subagents?.ledger);
	expect(replacement.subagents?.modelGateway).not.toBe(initial.subagents?.modelGateway);
	expect(replacement.subagents?.quota).not.toBe(initial.subagents?.quota);
	expect(replacement.subagents?.artifactStore).not.toBe(initial.subagents?.artifactStore);
	expect(replacement.scheduler).not.toBe(initial.scheduler);
	expect(replacement.scheduler?.targetGraph).not.toBe(initial.scheduler?.targetGraph);
	expect(replacement.scheduler?.registry).not.toBe(initial.scheduler?.registry);
	expect(replacement.externalConnectorRegistry).not.toBe(initial.externalConnectorRegistry);
	expect(replacement.taskCredentialProvider).not.toBe(initial.taskCredentialProvider);
}

async function runMainRpcInitialize(cwd: string): Promise<{
	readonly code: number | null;
	readonly stderr: string;
	readonly response: unknown;
}> {
	return await new Promise((resolvePromise, reject) => {
		const agentDir = join(cwd, "agent");
		const child = spawn(process.execPath, sourceProcessArgs(MAIN_RPC_ENTRY), {
			cwd,
			env: {
				...sourceProcessEnv(),
				AOS_AGENT_DIR: agentDir,
				AOS_AGENT_SESSION_DIR: join(agentDir, "sessions"),
				AOS_AGENT_OFFLINE: "1",
				AOS_AGENT_SKIP_VERSION_CHECK: "1",
				AOS_AGENT_TIMING: "1",
			},
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let response: unknown;
		let timeoutError: Error | undefined;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let initializeSent = false;
		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
			for (const line of stdout.split(/\r?\n/u)) {
				if (line.trim().length === 0) continue;
				try {
					const record: unknown = JSON.parse(line);
					if (
						typeof record === "object" && record !== null && "id" in record &&
						record.id === "main-rpc-initialize"
					) {
						response = record;
						if (timer !== undefined) clearTimeout(timer);
						timer = undefined;
						child.stdin.end();
					}
				} catch {
					// The assertion below reports complete stdout if RPC emitted non-JSON output.
				}
			}
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
			if (initializeSent || !stderr.includes(MAIN_RPC_READY_MARKER)) return;
			initializeSent = true;
			timer = setTimeout(() => {
				timeoutError = new Error(`main -> RPC initialize timed out after startup: ${stderr}`);
				child.kill();
			}, 60_000);
			child.stdin.write(`${JSON.stringify({ id: "main-rpc-initialize", type: "initialize", protocolVersion: 1 })}\n`);
		});
		child.on("error", (error) => {
			if (timer !== undefined) clearTimeout(timer);
			reject(error);
		});
		child.on("close", (code) => {
			if (timer !== undefined) clearTimeout(timer);
			if (timeoutError !== undefined) {
				reject(timeoutError);
				return;
			}
			if (response === undefined) {
				reject(new Error(`main -> RPC initialize produced no response. stdout=${stdout} stderr=${stderr}`));
				return;
			}
			resolvePromise({ code, stderr, response });
		});
	});
}

interface MainRpcPeer {
	readonly child: ChildProcessWithoutNullStreams;
	readonly stderr: () => string;
	readonly send: (record: object) => void;
	readonly waitFor: (predicate: (record: unknown) => boolean) => Promise<unknown>;
	readonly waitForClose: () => Promise<number | null>;
}

function startMainRpcPeer(
	cwd: string,
	options: {
		readonly phase: "crash" | "resume";
		readonly sessionId: string;
		readonly durableStatePath: string;
		readonly durableMarkerPath: string;
	},
): MainRpcPeer {
	const agentDir = join(cwd, "agent");
	const child = spawn(process.execPath, sourceProcessArgs(MAIN_RPC_ENTRY), {
		cwd,
		env: {
			...sourceProcessEnv(),
			AOS_AGENT_DIR: agentDir,
			AOS_AGENT_SESSION_DIR: join(agentDir, "sessions"),
			AOS_AGENT_OFFLINE: "1",
			AOS_AGENT_SKIP_VERSION_CHECK: "1",
			AOS_MAIN_RPC_PHASE: options.phase,
			AOS_MAIN_RPC_SESSION_ID: options.sessionId,
			AOS_MAIN_RPC_DURABLE_STATE: options.durableStatePath,
			AOS_MAIN_RPC_DURABLE_MARKER: options.durableMarkerPath,
		},
		stdio: ["pipe", "pipe", "pipe"],
	});
	const records: unknown[] = [];
	const waiters: Array<{
		readonly predicate: (record: unknown) => boolean;
		readonly resolve: (record: unknown) => void;
		readonly reject: (error: Error) => void;
		readonly timer: ReturnType<typeof setTimeout>;
	}> = [];
	let stdout = "";
	let stderr = "";
	child.stdout.on("data", (chunk) => {
		stdout += chunk.toString();
		for (;;) {
			const newline = stdout.indexOf("\n");
			if (newline < 0) break;
			const line = stdout.slice(0, newline).trim();
			stdout = stdout.slice(newline + 1);
			if (line.length === 0) continue;
			let record: unknown;
			try {
				record = JSON.parse(line);
			} catch {
				continue;
			}
			records.push(record);
			for (let index = waiters.length - 1; index >= 0; index -= 1) {
				const waiter = waiters[index]!;
				if (!waiter.predicate(record)) continue;
				waiters.splice(index, 1);
				clearTimeout(waiter.timer);
				waiter.resolve(record);
			}
		}
	});
	child.stderr.on("data", (chunk) => {
		stderr += chunk.toString();
	});
	child.on("close", () => {
		for (const waiter of waiters.splice(0)) {
			clearTimeout(waiter.timer);
			waiter.reject(new Error(`main -> RPC closed before the expected record. stderr=${stderr}`));
		}
	});
	return {
		child,
		stderr: () => stderr,
		send: (record) => child.stdin.write(`${JSON.stringify(record)}\n`),
		waitFor: async (predicate) => {
			const existing = records.find(predicate);
			if (existing !== undefined) return existing;
			return await new Promise<unknown>((resolve, reject) => {
				const timer = setTimeout(() => {
					const index = waiters.findIndex((waiter) => waiter.timer === timer);
					if (index >= 0) waiters.splice(index, 1);
					reject(new Error(`main -> RPC record timed out. stderr=${stderr}`));
				}, 60_000);
				waiters.push({ predicate, resolve, reject, timer });
			});
		},
		waitForClose: async () =>
			await new Promise<number | null>((resolve) => {
				if (child.exitCode !== null) {
					resolve(child.exitCode);
					return;
				}
				child.once("close", resolve);
			}),
	};
}

function isRpcRecord(record: unknown, expected: { readonly id?: string; readonly type?: string }): boolean {
	if (typeof record !== "object" || record === null) return false;
	if (expected.id !== undefined && (!("id" in record) || record.id !== expected.id)) return false;
	return expected.type === undefined || ("type" in record && record.type === expected.type);
}

describe("AgentRuntimeComposition", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		for (const directory of directories.splice(0)) {
			rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
		}
	});

	it("constructs every trusted authority from one canonical public root", async () => {
		const fixture = await createRuntimeFixture();
		const captures = emptyCaptures();
		const factory = createCompositionFactory(fixture.cwd, captures);
		const created = await createAgentSession({
			cwd: fixture.cwd,
			agentDir: fixture.cwd,
			modelRuntime: fixture.services.modelRuntime,
			modelBroker: fixture.services.modelBroker,
			settingsManager: fixture.services.settingsManager,
			resourceLoader: fixture.services.resourceLoader,
			capabilityRegistry: fixture.services.capabilityRegistry,
			sessionManager: SessionManager.inMemory(fixture.cwd, { id: "composition-root" }),
			runtimeComposition: factory,
			noTools: "all",
		});
		const composition = created.runtimeComposition;
		try {
			expect(Object.isFrozen(factory)).toBe(true);
			expect(Object.isFrozen(composition)).toBe(true);
			expect(composition).toBe(created.session.agentRuntimeComposition);
			expect(composition.session).toBe(getAgentCanonicalSession(created.session));
			expect(composition.sessionId).toBe("composition-root");
			expect(composition.toolGateway).toBe(captures.composedGateways[0]);
			expect(composition.toolGateway).not.toBe(captures.gateways[0]);
			expect(composition.workerSandboxProvider).toBe(captures.workers[0]?.provider);
			expect(composition.subagents).not.toBe(captures.subagents[0]);
			expect(composition.scheduler).toMatchObject(captures.schedulers[0] ?? {});
			expect(composition.scheduler).not.toHaveProperty("runLifecycleSession");
			expect(composition.externalConnectorRegistry).toBe(captures.externalRegistries[0]);
			expect(composition.taskCredentialProvider).toBe(captures.credentialProviders[0]);
			expect(created.session.getExternalConnectorRegistry()).toBe(composition.externalConnectorRegistry);
			expect(created.session.getWorkerRegistry()?.listWorkerRecords()).toEqual([]);
			expect(created.session.getSubagentRegistry()).toBeDefined();
			expect(created.session.getSchedulerStatus()).toBeDefined();
			expect(captures.externalRegistries[0]?.list()).toHaveLength(1);
			expect(composition.subagents?.session).toBe(composition.session);
			expect(composition.subagents?.toolGateway).toBe(composition.toolGateway);
			expect(composition.subagents?.writer).toBe(composition.harness.ledger.writer);
			expect(composition.scheduler?.sourceSession).toBe(composition.session);
			expect(composition.scheduler?.gateLookup).toBe(schedulerAdmissionGate);
			expect(composition.scheduler?.settleRunAtHost).toBe(settleRunAtHost);
			expect(captures.contexts).toHaveLength(6);
			expect(captures.contexts.every((context) => context === captures.contexts[0])).toBe(true);
			expect(captures.contexts[0]).toMatchObject({
				session: composition.session,
				harness: composition.harness,
				sessionId: composition.sessionId,
				models: composition.models,
			});
			expect(captures.contexts[0]).not.toHaveProperty("sessionManager");
		} finally {
			await created.session.dispose();
			await created.session.waitForDispose();
		}
	});

	it("runs a Graph agent node through the standard Session Scheduler and Native Subagent composition", async () => {
		const fixture = await createRuntimeFixture();
		const sessionManager = SessionManager.inMemory(fixture.cwd, { id: "native-scheduler-product" });
		const coordinator = createRunLifecycleCoordinator(sessionManager, { diagnostics: () => {} });
		const runs = new Map<string, RunHandle>();
		const productTask = schedulerTask(sessionManager.getSessionId());
		const productBinding = schedulerBinding(productTask, sessionManager.getSessionId());
		const graph = new TaskGraphStore(
			sessionManager,
			{
				get(runId) {
					const run = coordinator.getRun(runId);
					return run === undefined ? undefined : {
						sessionId: sessionManager.getSessionId(),
						runId,
						status: run.record.status,
						...(run.receipt === undefined ? {} : { receiptStatus: run.receipt.status }),
					};
				},
			},
			schedulerAdmissionGate,
			{ now: () => NOW },
		);
		graph.create({
			taskId: productTask.taskId,
			graphRevision: 1,
			nodes: [{ nodeId: "native", dependsOn: [] }],
			clientRequestId: "native-scheduler-product-graph",
		});
		const seedSession = new Session(createSessionManagerStorage(sessionManager));
		const seedLedger = new SessionLedger(seedSession, { ownerId: "native-scheduler-product-seed" });
		const productRole = roleRevision(sessionManager.getSessionId());
		const productModel = modelProfile(sessionManager.getSessionId());
		const planProof = createNativeSchedulerPlanProof(sessionManager.getSessionId());
		await seedLedger.appendFact("task", productTask.taskId, productTask, {
			clientRequestId: "native-scheduler-product-seed:task",
			expectedRevision: 0,
			correlation: { taskId: productTask.taskId },
		});
		await seedLedger.appendFact("role_revision", productBinding.roleRevision.id, productRole, {
			clientRequestId: "native-scheduler-product-seed:role",
			expectedRevision: 0,
			correlation: { taskId: productTask.taskId, bindingId: productBinding.bindingId },
		});
		await seedLedger.appendFact("model_profile_revision", productBinding.modelProfileRevision.id, productModel, {
			clientRequestId: "native-scheduler-product-seed:model",
			expectedRevision: 0,
			correlation: { taskId: productTask.taskId, bindingId: productBinding.bindingId },
		});
		for (const [objectType, reference] of [
			["external_agent_binding", productBinding.contextRevision],
			["capability_binding", productBinding.capabilityRevision],
			["model_broker_binding", productBinding.modelBrokerBindingRevision],
			["policy_binding", productBinding.policyRevision],
		] as const) {
			await seedLedger.appendFact(objectType, reference.id, {
				schemaVersion: 1,
				type: reference.type,
				id: reference.id,
				revision: reference.revision,
			}, {
				clientRequestId: `native-scheduler-product-seed:${objectType}`,
				expectedRevision: 0,
				correlation: { taskId: productTask.taskId, bindingId: productBinding.bindingId },
			});
		}
		await seedLedger.appendFact("agent_binding", productBinding.bindingId, productBinding, {
			clientRequestId: "native-scheduler-product-seed:binding",
			expectedRevision: 0,
			correlation: { taskId: productTask.taskId, bindingId: productBinding.bindingId },
		});
		await seedLedger.appendFact("task", planProof.parentTask.taskId, planProof.parentTask, {
			clientRequestId: "native-scheduler-product-seed:parent-task",
			expectedRevision: 0,
			correlation: { taskId: planProof.parentTask.taskId },
		});
		await seedLedger.appendFact("agent_instance", planProof.parent.agentInstanceId, planProof.parent, {
			clientRequestId: "native-scheduler-product-seed:parent-agent",
			expectedRevision: 0,
			correlation: {
				taskId: planProof.parent.taskId,
				agentInstanceId: planProof.parent.agentInstanceId,
			},
		});
		await seedLedger.appendFact("attempt", planProof.parentAttemptId, {
			schemaVersion: 1,
			attemptId: planProof.parentAttemptId,
			dispatchId: `parent-dispatch-${sessionManager.getSessionId()}`,
			taskId: planProof.parent.taskId,
			providerId: planProof.parent.providerId,
			agentInstanceId: planProof.parent.agentInstanceId,
			bindingId: `parent-binding-${sessionManager.getSessionId()}`,
			bindingEpochIds: [`parent-epoch-${sessionManager.getSessionId()}`],
			status: "running",
			startedAt: NOW,
		}, {
			clientRequestId: "native-scheduler-product-seed:parent-attempt",
			expectedRevision: 0,
			correlation: {
				taskId: planProof.parent.taskId,
				dispatchId: `parent-dispatch-${sessionManager.getSessionId()}`,
				attemptId: planProof.parentAttemptId,
				bindingId: `parent-binding-${sessionManager.getSessionId()}`,
				bindingEpochId: `parent-epoch-${sessionManager.getSessionId()}`,
				agentInstanceId: planProof.parent.agentInstanceId,
			},
		});
		await seedLedger.appendFact("context", `context_${planProof.parentSpawnId}`, {
			schemaVersion: 1,
			contextId: `context_${planProof.parentSpawnId}`,
			taskId: planProof.parent.taskId,
			spawnId: planProof.parentSpawnId,
			forkScope: "none",
			lineage: {
				schemaVersion: 1,
				entityType: "context",
				entityId: `context_${planProof.parentSpawnId}`,
				depth: 0,
			},
			createdAt: NOW,
		}, {
			clientRequestId: "native-scheduler-product-seed:parent-context",
			expectedRevision: 0,
			correlation: { taskId: planProof.parent.taskId },
		});
		await seedLedger.release();
		let schedulerWake: (() => void) | undefined;
		let schedulerRegistry: SchedulerExecutorRegistry | undefined;
		let compositionGateway: ToolGateway | undefined;
		let writer: AgentHarness["ledger"]["writer"] | undefined;
		const factory = createAgentRuntimeCompositionFactory({
			toolGateway: (context) => {
				compositionGateway = createGateway(context.sessionId);
				return compositionGateway;
			},
			subagents: (context) => {
				const gateway = compositionGateway;
				if (gateway === undefined) throw new Error("Native Scheduler Tool Gateway is missing");
				writer = context.harness.ledger.writer;
				return createSubagents(context, gateway, async (input) => ({
					promptOnLane: async () => Result.ok({
						runId: `native-run-${input.agentInstance.agentInstanceId}`,
						kind: "completed" as const,
						leafId: "native-leaf",
						finalEntryId: "native-entry",
						finalMessage: {
							role: "assistant" as const,
							content: [{ type: "text" as const, text: "native scheduler complete" }],
						},
					}),
					resumeOnLane: async () => Result.err({ message: "not exercised" }),
					createLane: async () => Result.ok({ name: input.laneId }),
					abort: async () => Result.ok({ runId: "native-run", steer: [], followUp: [] }),
					close: async () => undefined,
				}) as unknown as AgentHarness);
			},
			scheduler: (context, selectionReservations) => {
				const task = productTask;
				const binding = productBinding;
				const targetSessionId = `native-scheduler-target-${context.sessionId}`;
				const targetManager = SessionManager.inMemory(fixture.cwd, { id: targetSessionId });
				const registry = new SchedulerExecutorRegistry({ reservationStore: selectionReservations });
				schedulerRegistry = registry;
				return {
					schemaVersion: 1,
					enabled: true,
					sourceSession: context.session,
					targetSession: new Session(createSessionManagerStorage(targetManager)),
					targetSessionId,
					targetGraph: new TaskGraphStore(
						targetManager,
						{ get: () => undefined },
						schedulerAdmissionGate,
						{ now: () => NOW },
					),
					ownerId: selectionReservations.ownerId,
					registry,
					task,
					binding,
					gateLookup: schedulerAdmissionGate,
					nativeAgentPlanner: {
						schemaVersion: 1,
						plan: async (input, descriptor) => nativeSchedulerPlan(input, descriptor, task, binding, planProof),
					},
					resolveRunAssociation: async (_graph, node) => {
						const runId = `native-run-${node.nodeId}`;
						if (!runs.has(runId)) {
							const run = coordinator.reserve().accept({
								runId,
								attempt: 1,
								model: { provider: "fake", id: "model-1", thinkingLevel: "off" },
							});
							run.start();
							runs.set(runId, run);
						}
						return Result.ok({
							runId,
							task,
							binding,
							executorRequirements: { requireResume: true, modelAccess: "aos_gateway" },
						});
					},
					settleRunAtHost: async (input) => {
						const run = runs.get(input.runId);
						if (run === undefined) {
							return Result.err(new FoundationError("scheduler_not_found", "Native Scheduler Run is missing"));
						}
						if (writer === undefined) {
							return Result.err(new FoundationError("scheduler_executor_unavailable", "Canonical Scheduler writer is missing"));
						}
						const terminal = await observeCanonicalTerminal(sessionManager, run, {
							outcome: input.taskResult === undefined ? "failed" : "completed",
							writer,
						});
						if (terminal.event === undefined) {
							return Result.err(new FoundationError("run_terminal_authority_invalid", "Canonical Run terminal was not projected"));
						}
						return Result.ok(undefined);
					},
					eventSource: {
						subscribe(wake) {
							schedulerWake = wake;
							return () => { schedulerWake = undefined; };
						},
					},
					pollIntervalMs: 60_000,
					now: () => NOW,
				};
			},
		});
		const created = await createAgentSession({
			cwd: fixture.cwd,
			agentDir: fixture.cwd,
			modelRuntime: fixture.services.modelRuntime,
			modelBroker: fixture.services.modelBroker,
			settingsManager: fixture.services.settingsManager,
			resourceLoader: fixture.services.resourceLoader,
			capabilityRegistry: fixture.services.capabilityRegistry,
			sessionManager,
			runtimeComposition: factory,
			noTools: "all",
		});
		try {
			await created.session.whenCapabilitiesReady();
			if (schedulerWake === undefined) {
				throw new Error("Native Scheduler product composition did not initialize");
			}
			expect(schedulerRegistry?.get("native.in_process")?.maxConcurrency).toBe(1);
			expect(schedulerRegistry?.get("native.fork")).toBeUndefined();
			schedulerWake();
			await vi.waitFor(async () => {
				const durable = await created.runtimeComposition.session.findFoundationRecords({
					objectType: "scheduler.queue_entry",
					includePruned: true,
				});
				expect(durable.some((record) =>
					record.kind === "fact" &&
					(record.payload as { readonly state?: unknown }).state === "settled"
				)).toBe(true);
			}, { timeout: 5_000 });
			const reopenedGraph = new TaskGraphStore(
				sessionManager,
				{
					get(runId) {
						const run = coordinator.getRun(runId);
						return run === undefined ? undefined : {
							sessionId: sessionManager.getSessionId(),
							runId,
							status: run.record.status,
							...(run.receipt === undefined ? {} : { receiptStatus: run.receipt.status }),
						};
					},
				},
				schedulerAdmissionGate,
				{ now: () => NOW },
			);
			expect(reopenedGraph.get(productTask.taskId, 1)?.nodes[0]?.status).toBe("succeeded");
			const records = (await created.runtimeComposition.session.findFoundationRecords({ includePruned: true }))
				.flatMap((record) => record.kind === "fact" ? [record] : []);
			const queueEntry = records.find((record) =>
				record.objectType === "scheduler.queue_entry" &&
				(record.payload as { readonly state?: unknown }).state === "settled"
			);
			const receipt = records.find((record) =>
				record.objectType === "attempt_receipt" &&
				(record.payload as { readonly providerId?: unknown }).providerId === "native.in_process"
			);
			const receiptIdentity = receipt?.payload as {
				readonly attemptId?: string;
				readonly bindingEpochIds?: readonly string[];
				readonly dispatchId?: string;
			} | undefined;
			const dispatch = records.find((record) =>
				record.objectType === "dispatch" && record.objectId === receiptIdentity?.dispatchId
			);
			const epoch = records.find((record) =>
				record.objectType === "binding_epoch" && record.objectId === receiptIdentity?.bindingEpochIds?.[0]
			);
			const attempt = records.find((record) =>
				record.objectType === "attempt" && record.objectId === receiptIdentity?.attemptId
			);
			const agentInstanceId = attempt?.correlation.agentInstanceId;
			expect(agentInstanceId).toBeDefined();
			expect(dispatch?.correlation.agentInstanceId).toBe(agentInstanceId);
			expect(epoch?.correlation.agentInstanceId).toBe(agentInstanceId);
			expect(receipt?.correlation.agentInstanceId).toBe(agentInstanceId);
			expect(receipt?.payload).toMatchObject({
				agentInstanceId,
				provenance: { correlation: { agentInstanceId } },
			});
			expect(queueEntry?.payload).toMatchObject({ state: "settled" });
			const reservations = await created.runtimeComposition.schedulerSelectionReservations?.list();
			if (reservations === undefined || !reservations.ok) {
				throw reservations?.error ?? new Error("Canonical Scheduler selection store is missing");
			}
			expect(reservations.value).toMatchObject([{
				status: "settled",
				fact: {
					chosenProviderId: "native.in_process",
					bindingId: productBinding.bindingId,
					agentInstanceId,
				},
			}]);
			expect(created.session.getSchedulerStatus()?.tickFailures).toBe(0);
			const foreignLedger = new SessionLedger(created.runtimeComposition.session, {
				ownerId: "native-scheduler-foreign-owner",
			});
			await expect(foreignLedger.appendFact("scheduler_owner_probe", "foreign", { blocked: true }, {
				clientRequestId: "native-scheduler-foreign-owner",
				expectedRevision: 0,
				correlation: { taskId: productTask.taskId },
			})).rejects.toMatchObject({ code: "session_writer_busy" });
			expect(productBinding).toBe(created.runtimeComposition.scheduler?.binding);
		} finally {
			await created.session.dispose();
			await created.session.waitForDispose();
		}
		const releasedLedger = new SessionLedger(created.runtimeComposition.session, {
			ownerId: "native-scheduler-after-dispose",
		});
		await releasedLedger.appendFact("scheduler_owner_probe", "released", { released: true }, {
			clientRequestId: "native-scheduler-after-dispose",
			expectedRevision: 0,
			correlation: { taskId: productTask.taskId },
		});
		await releasedLedger.release();
	});

	it("resolves a stable explicit target from trusted catalogs and project/Role narrowing", () => {
		const cwd = mkdtempSync(join(tmpdir(), "aos-runtime-target-config-"));
		directories.push(cwd);
		const firstTarget = externalTargetDefinition(cwd, "target-a");
		const secondTarget = externalTargetDefinition(cwd, "target-b");
		const options = {
			global: { schemaVersion: 1, targets: [secondTarget, firstTarget] },
			project: {
				schemaVersion: 1,
				targetId: firstTarget.targetId,
				capabilityCeiling: { modelAccess: ["none"], resume: false },
			},
			projectTrusted: true,
			role: {
				schemaVersion: 1,
				targetId: firstTarget.targetId,
				capabilityCeiling: { images: false },
			},
			roleTrusted: true,
			explicitTargetId: firstTarget.targetId,
		} as const;
		const resolved = buildExternalConnectorTargetConfig(options);
		const reordered = buildExternalConnectorTargetConfig({
			...options,
			global: { schemaVersion: 1, targets: [firstTarget, secondTarget] },
		});

		expect(resolved.targets.map((target) => target.targetId)).toEqual(["target-a", "target-b"]);
		expect(resolved.selectedTarget).toMatchObject({
			targetId: "target-a",
			providerId: "provider-target-a",
			source: "global",
			endpoint: "https://connector.invalid/rpc",
			accountReference: { namespace: "test", accountId: "account-target-a" },
			capabilityCeiling: {
				modelAccess: ["none"],
				resume: false,
				toolGateway: true,
				artifacts: true,
				images: false,
			},
			selectionSources: ["explicit", "project", "role"],
		});
		expect(Object.isFrozen(resolved)).toBe(true);
		expect(Object.isFrozen(resolved.selectedTarget?.capabilityCeiling)).toBe(true);
		expect(reordered.configRevision).toBe(resolved.configRevision);
		expect(reordered.selectedTarget?.selectionRevision).toBe(resolved.selectedTarget?.selectionRevision);
	});

	it("rejects project or Role capability widening and secret-bearing target fields", () => {
		const cwd = mkdtempSync(join(tmpdir(), "aos-runtime-target-no-widen-"));
		directories.push(cwd);
		const target = externalTargetDefinition(cwd, "locked", "locked-provider", {
			modelAccess: ["none"],
			resume: false,
			toolGateway: false,
		});
		expectTargetConfigError(
			() => buildExternalConnectorTargetConfig({
				managed: { schemaVersion: 1, targets: [target] },
				project: { schemaVersion: 1, targetId: target.targetId, capabilityCeiling: { resume: true } },
				projectTrusted: true,
			}),
			"capability_widened",
		);
		expectTargetConfigError(
			() => buildExternalConnectorTargetConfig({
				managed: { schemaVersion: 1, targets: [target] },
				project: { schemaVersion: 1, targetId: target.targetId, capabilityCeiling: { resume: false } },
				projectTrusted: true,
				role: { schemaVersion: 1, capabilityCeiling: { resume: true } },
				roleTrusted: true,
			}),
			"capability_widened",
		);
		expectTargetConfigError(
			() => buildExternalConnectorTargetConfig({
				global: {
					schemaVersion: 1,
					targets: [{ ...target, apiKey: "raw-secret" }],
				},
			}),
			"invalid_shape",
		);
		expectTargetConfigError(
			() => buildExternalConnectorTargetConfig({
				managed: { schemaVersion: 1, targets: [target] },
				project: {
					schemaVersion: 1,
					targetId: target.targetId,
					executablePath: process.execPath,
					endpoint: "https://project.invalid/override",
					accountReference: { schemaVersion: 1, namespace: "project", accountId: "raw-account" },
				},
				projectTrusted: true,
			}),
			"invalid_shape",
		);
	});

	it("fails closed for ambiguous target selectors and untrusted project sources", () => {
		const cwd = mkdtempSync(join(tmpdir(), "aos-runtime-target-source-"));
		directories.push(cwd);
		const firstTarget = externalTargetDefinition(cwd, "target-a");
		const secondTarget = externalTargetDefinition(cwd, "target-b");
		expectTargetConfigError(
			() => buildExternalConnectorTargetConfig({
				global: { schemaVersion: 1, targets: [firstTarget, secondTarget] },
				project: { schemaVersion: 1, targetId: firstTarget.targetId },
				projectTrusted: true,
				role: { schemaVersion: 1, targetId: secondTarget.targetId },
				roleTrusted: true,
			}),
			"ambiguous_selection",
		);
		expectTargetConfigError(
			() => buildExternalConnectorTargetConfig({
				global: { schemaVersion: 1, targets: [firstTarget] },
				project: { schemaVersion: 1, targetId: firstTarget.targetId },
				projectTrusted: false,
			}),
			"untrusted_source",
		);
		expectTargetConfigError(
			() => buildExternalConnectorTargetConfig({
				managed: { schemaVersion: 1, targets: [firstTarget] },
				global: { schemaVersion: 1, targets: [firstTarget] },
				explicitTargetId: firstTarget.targetId,
			}),
			"ambiguous_target",
		);
	});

	it("keeps an unselected target catalog off and passes an explicit target only to registry composition", () => {
		const cwd = mkdtempSync(join(tmpdir(), "aos-runtime-target-default-off-"));
		directories.push(cwd);
		const target = externalTargetDefinition(cwd, "explicit-target");
		const catalog = { schemaVersion: 1, targets: [target] } as const;
		const defaultOffConfig = buildExternalConnectorTargetConfig({ global: catalog });
		const offRegistryFactory = vi.fn(() => createExternalConnectorRegistry());
		const context = {
			session: Object.freeze({}),
			harness: Object.freeze({}),
			sessionId: "target-default-off",
			models: Object.freeze({}),
		} as unknown as AgentRuntimeCompositionContext;
		const defaultOff = createAgentRuntimeCompositionFactory({
			externalConnectorTargetConfig: defaultOffConfig,
			externalConnectorRegistry: offRegistryFactory,
		}).create(context);

		expect(defaultOff.externalConnectorTargetConfig).toBe(defaultOffConfig);
		expect(defaultOff.externalConnectorTarget).toBeUndefined();
		expect(defaultOff.externalConnectorRegistry).toBeUndefined();
		expect(offRegistryFactory).not.toHaveBeenCalled();

		const selectedConfig = buildExternalConnectorTargetConfig({
			global: catalog,
			explicitTargetId: target.targetId,
		});
		let composedTarget: ExternalConnectorResolvedTarget | undefined;
		const selectedRegistry = createAgentRuntimeCompositionFactory({
			externalConnectorTargetConfig: selectedConfig,
			externalConnectorRegistry: (_compositionContext, _toolGateway, selectedTarget) => {
				composedTarget = selectedTarget;
				return createExternalConnectorRegistry();
			},
		}).create({ ...context, sessionId: "target-explicit-selection" });
		expect(composedTarget).toBe(selectedConfig.selectedTarget);
		expect(selectedRegistry.externalConnectorTarget).toBe(selectedConfig.selectedTarget);
		expect(selectedRegistry.externalConnectorRegistry).toBeDefined();
	});

	it("projects trimmed Tool Gateway routes and completes request, execute, and result through composition", async () => {
		const synthetic = createExternalConnectorSyntheticCompositionContext("connector-composition-tool-gateway");
		const captures: ExternalConnectorRegistryCapture[] = [];
		let providerExecutions = 0;
		const targetConfig = crossLayerTargetConfig(process.cwd(), {
			targetId: "connector-tool-gateway-target",
			providerId: "connector.tool-gateway",
			toolGateway: true,
		});
		const gateway = createCrossLayerToolGateway(() => {
			providerExecutions += 1;
		});
		const factory = createAgentRuntimeCompositionFactory({
			toolGateway: () => gateway,
			externalConnectorTargetConfig: targetConfig,
			externalConnectorRegistry: createExternalConnectorRegistryFactory({ mode: "tool_gateway", captures }),
		});
		const composition = materializeAgentRuntimeComposition(factory, synthetic.context);
		bindCanonicalExternalToolGatewayPolicy(composition.toolGateway, {
			authorizeExternalToolGatewayRequest: async () => {},
		});
		try {
			const capture = captures[0];
			if (capture === undefined) throw new Error("cross-layer connector Tool Gateway connector was not composed");
			expect(capture.target).toBe(targetConfig.selectedTarget);
			expect(capture.toolGateway).toBe(composition.toolGateway);
			expect(capture.authority.runtimeLimits).toBe(composition.runtimeLimits);

			const execution = await executeCrossLayerProductRun(synthetic.context, capture, "connector-tool-gateway-run");
			expect(execution.runReceipt.terminalStatus).toBe("completed");
			expect(providerExecutions).toBe(1);
			expect(capture.driver.spawnRequests).toHaveLength(1);
			expect(capture.driver.spawnRequests[0]?.toolGatewayRoutes).toEqual([
				{
					kind: "local",
					namespace: "workspace",
					toolName: "workspace.read",
					providerId: "connector-builtin-tools",
					revision: 1,
					operation: { resource: "filesystem.read", effects: ["read"] },
				},
			]);
			expect(capture.driver.writes).toHaveLength(1);
			expect(capture.driver.writes[0]).toMatchObject({
				schemaVersion: 1,
				kind: "tool_gateway_result",
				operationNonce: expect.any(String),
			});
			expect(capture.driver.writes[0]?.result).toEqual(execution.toolGatewayExchanges?.[0]?.result);
			expect(execution.toolGatewayExchanges).toMatchObject([{
				request: { toolName: "workspace.read" },
				result: { ok: true, toolName: "workspace.read", sideEffectState: "none" },
			}]);
		} finally {
			await composition.externalConnectorRegistry?.dispose();
			await composition.toolGateway?.dispose();
		}
	});

	it("rejects unknown or unauthorized routes and orphan or nonce events before provider effects", async () => {
		for (const mode of ["unknown", "unauthorized", "orphan", "nonce"] as const) {
			const synthetic = createExternalConnectorSyntheticCompositionContext(`connector-rejection-${mode}`);
			const captures: ExternalConnectorRegistryCapture[] = [];
			const targetConfig = crossLayerTargetConfig(process.cwd(), {
				targetId: `connector-rejection-target-${mode}`,
				providerId: `connector.rejection.${mode}`,
				toolGateway: true,
			});
			let providerExecutions = 0;
			const gateway = createCrossLayerToolGateway(() => {
				providerExecutions += 1;
			});
			const factory = createAgentRuntimeCompositionFactory({
				toolGateway: () => gateway,
				externalConnectorTargetConfig: targetConfig,
				externalConnectorRegistry: createExternalConnectorRegistryFactory({ mode, captures }),
			});
			const composition = materializeAgentRuntimeComposition(factory, synthetic.context);
			bindCanonicalExternalToolGatewayPolicy(composition.toolGateway, {
				authorizeExternalToolGatewayRequest: async () => {},
			});
			try {
				const capture = captures[0];
				if (capture === undefined) throw new Error(`cross-layer connector ${mode} connector was not composed`);
				const execution = await executeCrossLayerProductRun(
					synthetic.context,
					capture,
					`connector-rejection-run-${mode}`,
				);
				expect(execution.runReceipt.terminalStatus).toBe("failed");
				expect(execution.attemptReceipt.status).toBe("failed");
				expect(execution.attemptReceipt.error?.code).toBe(
					mode === "unknown" || mode === "unauthorized"
						? "external_tool_route_denied"
						: "external_event_invalid",
				);
				expect(providerExecutions).toBe(0);
				expect(capture.driver.writes).toHaveLength(0);
			} finally {
				await composition.externalConnectorRegistry?.dispose();
				await composition.toolGateway?.dispose();
			}
		}
	});

	it("fails closed during composition when a true Tool Gateway capability lacks vendor behavior", () => {
		const synthetic = createExternalConnectorSyntheticCompositionContext("connector-capability-missing-behavior");
		const targetConfig = crossLayerTargetConfig(process.cwd(), {
			targetId: "connector-capability-missing-behavior-target",
			providerId: "connector.capability-missing-behavior",
			toolGateway: true,
		});
		const gateway = createCrossLayerToolGateway();
		const factory = createAgentRuntimeCompositionFactory({
			toolGateway: () => gateway,
			externalConnectorTargetConfig: targetConfig,
			externalConnectorRegistry: createExternalConnectorRegistryFactory({
				mode: "tool_gateway",
				bindBehaviorManifest: false,
			}),
		});

		expect(() => materializeAgentRuntimeComposition(factory, synthetic.context)).toThrow(
			"External connector Tool Gateway adapter behavior is not ready",
		);
	});

	it("passes external credential authority through the five-argument composition and rejects it after revoke", async () => {
		const fixture = await createRuntimeFixture();
		const targetConfig = crossLayerTargetConfig(fixture.cwd, {
			targetId: "connector-credential-composition-target",
			providerId: "connector.credential-composition",
			accountReference: { schemaVersion: 1, namespace: "test", accountId: "opaque-account" },
		});
		const credential = createRecordingCredentialProvider();
		const captures: ExternalConnectorRegistryCapture[] = [];
		const factory = createAgentRuntimeCompositionFactory({
			externalConnectorTargetConfig: targetConfig,
			externalConnectorCredentialIssueContext: () => (attempt, binding) => ({
				taskId: attempt.taskId,
				graphRevision: 1,
				nodeId: "connector-credential-node",
				runId: "connector-credential-run",
				capabilityBindingId: binding.capabilityRevision.id,
				policyBindingId: binding.policyRevision.id,
				scopes: [EXTERNAL_CONNECTOR_CREDENTIAL_SCOPE],
				requestedTtlMs: 60_000,
				clientRequestId: "connector-credential-resolver",
				nodeAttached: true,
			}),
			externalConnectorRegistry: createExternalConnectorRegistryFactory({ mode: "complete", captures }),
			taskCredentialProvider: () => credential.provider,
			taskCredentialPolicyMaxTtlMs: 300_000,
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model: {
					id: "connector-credential-model",
					name: "cross-layer connector Credential Model",
					api: "anthropic-messages",
					provider: "test",
					baseUrl: "https://test.invalid",
					reasoning: false,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 1_000,
					maxTokens: 100,
				} satisfies Model<"anthropic-messages">,
				systemPrompt: "cross-layer connector credential composition",
				tools: [],
			},
			streamFn: () => {
				throw new Error("cross-layer connector credential test does not stream a model");
			},
		});
		const sessionManager = SessionManager.inMemory(fixture.cwd, { id: "connector-credential-composition-session" });
		const session = new AgentSession({
			agent,
			sessionManager,
			settingsManager: SettingsManager.inMemory({ executionPolicy: externalCredentialPolicySettings() }),
			cwd: fixture.cwd,
			modelRuntime: fixture.services.modelRuntime,
			resourceLoader: fixture.services.resourceLoader,
			runtimeComposition: factory,
			taskCredentialProviderAvailability: { available: true, declaresDelivery: true },
			noTools: "all",
		});
		try {
			await session.runExternalAgentPreflight("connector-credential-run");
			const capture = captures[0];
			if (capture === undefined || capture.credential === undefined) {
				throw new Error("cross-layer connector credential authority was not composed");
			}
			expect(capture.target).toBe(targetConfig.selectedTarget);
			expect(capture.credential).toBeDefined();
			expect(session.getTaskCredentialService()).toBeDefined();
			const capabilityBindingId = session.getCapabilityBindingId();
			const policyBinding = session.getActiveExecutionPolicyBinding();
			if (capabilityBindingId === undefined || policyBinding === undefined) {
				throw new Error("cross-layer connector credential policy boundary was not materialized");
			}
			const attempt = { taskId: "connector-credential-task" } as unknown as Attempt;
			const binding = {
				capabilityRevision: { id: capabilityBindingId },
				policyRevision: { id: policyBinding.id },
			} as unknown as AgentBinding;
			const issueContext = capture.credential.resolveIssueContext(attempt, binding);
			if (issueContext === undefined) throw new Error("cross-layer connector credential issue context is missing");
			const service = session.getTaskCredentialService();
			if (service === undefined) throw new Error("cross-layer connector credential service is missing");
			const issued = service.issueForTaskRun(issueContext);
			expect(issued).toMatchObject({ ok: true, delivery: { status: "succeeded" } });
			if (!issued.ok) return;
			expect(credential.target.projectedMaterials).toEqual([EXTERNAL_CREDENTIAL_CANARY]);
			expect(Object.keys(issued.grant).sort()).not.toContain("material");
			const projection = {
				schemaVersion: 1 as const,
				leaseId: issued.leaseId,
				grantId: issued.grant.grantId,
				bindingId: issued.bindingId,
				scopeDigest: issued.grant.scopeDigest,
				expiresAt: issued.grant.expiresAt,
				clientRequestId: "connector-safe-projection",
			};
			expect(capture.credential.service.lookupDeliveredLease({
				projection,
				targetId: targetConfig.selectedTarget?.targetId ?? "missing-target",
			})).toMatchObject({ ok: true, projection });
			expect(JSON.stringify({ issued, projection, entries: sessionManager.getEntries() })).not.toContain(
				EXTERNAL_CREDENTIAL_CANARY,
			);

			const renewed = service.renew({
				leaseId: issued.leaseId,
				grantId: issued.grant.grantId,
				bindingId: issued.bindingId,
				heartbeatSequence: 1,
				requestedTtlMs: 120_000,
				clientRequestId: "connector-credential-renew",
				nodeAttached: true,
			});
			expect(renewed).toMatchObject({ ok: true, grant: { heartbeatSequence: 1 } });
			expect(credential.target.renewals).toHaveLength(1);
			const revoked = service.revoke({
				leaseId: issued.leaseId,
				reasonCode: "run_cancelled",
				clientRequestId: "connector-credential-revoke",
				nodeAttached: true,
			});
			expect(revoked).toMatchObject({ ok: true, grant: { status: "revoked" } });
			expect(credential.target.revocations).toHaveLength(1);
			expect(service.lookupDeliveredLease({
				projection,
				targetId: targetConfig.selectedTarget?.targetId ?? "missing-target",
			})).toMatchObject({ ok: false });
			expect(service.renew({
				leaseId: issued.leaseId,
				grantId: issued.grant.grantId,
				bindingId: issued.bindingId,
				heartbeatSequence: 2,
				requestedTtlMs: 60_000,
				clientRequestId: "connector-credential-renew-after-revoke",
				nodeAttached: true,
			}).ok).toBe(false);
		} finally {
			session.dispose();
			await session.waitForDispose();
		}
	});

	it("binds one selected Connector target to frozen limits, durable Scheduler selection, and retry", async () => {
		const fixture = await createRuntimeFixture();
		const target = externalTargetDefinition(fixture.cwd, "product-target", "product-connector");
		const targetConfig = buildExternalConnectorTargetConfig({
			global: { schemaVersion: 1, targets: [target] },
			explicitTargetId: target.targetId,
		});
		let capturedLimits: Parameters<NonNullable<AgentRuntimeCompositionOptions["externalConnectorRegistry"]>>[3] | undefined;
		let schedulerRegistry: SchedulerExecutorRegistry | undefined;
		const factory = createAgentRuntimeCompositionFactory({
			externalConnectorTargetConfig: targetConfig,
			runtimeLimits: {
				global: { maxRetries: 1, retryBudgetMs: 4_000, maxBacklog: 2, maxConcurrency: 1 },
			},
			scheduler: (context, selectionReservations) => {
				const scheduler = createScheduler(context, fixture.cwd, selectionReservations);
				schedulerRegistry = scheduler.registry;
				return scheduler;
			},
			externalConnectorRegistry: (context, toolGateway, selectedTarget, authority) => {
				capturedLimits = authority;
				if (selectedTarget === undefined) throw new Error("Expected exact selected target");
				return createTestExternalConnectorRegistry(
					context.sessionId,
					toolGateway,
					selectedTarget.providerId,
				);
			},
		});
		const created = await createAgentSession({
			cwd: fixture.cwd,
			agentDir: fixture.cwd,
			modelRuntime: fixture.services.modelRuntime,
			modelBroker: fixture.services.modelBroker,
			settingsManager: fixture.services.settingsManager,
			resourceLoader: fixture.services.resourceLoader,
			capabilityRegistry: fixture.services.capabilityRegistry,
			sessionManager: SessionManager.inMemory(fixture.cwd, { id: "connector-product-composition" }),
			runtimeComposition: factory,
			noTools: "all",
		});
		try {
			await created.session.whenCapabilitiesReady();
			const composition = created.runtimeComposition;
			expect(capturedLimits?.runtimeLimits).toBe(composition.runtimeLimits);
			expect(composition.runtimeLimits.values).toMatchObject({
				maxRetries: 1,
				retryBudgetMs: 4_000,
				maxBacklog: 2,
				maxConcurrency: 1,
			});
			expect(composition.scheduler?.registry.durableSelectionsEnabled()).toBe(true);
			expect(composition.scheduler?.selectionReservationStore).toBe(
				composition.schedulerSelectionReservations,
			);
			expect(composition.scheduler?.connectorRetry).toMatchObject({
				providerId: target.providerId,
				targetId: target.targetId,
				policy: { maxAttempts: 2, totalRetryTimeMs: 4_000 },
			});
			expect(created.session.getExternalConnectorRegistry()?.list()).toMatchObject([
				{ providerId: target.providerId, providerClass: PROVIDER_CLASS.externalConnector },
			]);
			const registered = schedulerRegistry?.get(target.providerId);
			expect(target.providerId).not.toBe(target.targetId);
			expect(registered?.entry.descriptor).toEqual({
				schemaVersion: 1,
				providerId: target.providerId,
				providerClass: PROVIDER_CLASS.externalConnector,
			});
			expect(registered?.runtimeSnapshot).toMatchObject({
				capabilitySnapshot: { providerId: target.providerId },
				credentialTargetRefs: [target.targetId],
			});
			expect(created.session.getSchedulerStatus()?.started).toBe(true);
		} finally {
			await created.session.dispose();
			await created.session.waitForDispose();
		}
	});

	it("does not start Scheduler before exact External Connector registration completes", async () => {
		const fixture = await createRuntimeFixture();
		const target = externalTargetDefinition(fixture.cwd, "barrier-target", "barrier-provider");
		const targetConfig = buildExternalConnectorTargetConfig({
			global: { schemaVersion: 1, targets: [target] },
			explicitTargetId: target.targetId,
		});
		let releaseRegistration: (() => void) | undefined;
		const registrationGate = new Promise<void>((resolve) => { releaseRegistration = resolve; });
		const registrationStarted = vi.fn();
		const schedulerStarted = vi.fn();
		const factory = createAgentRuntimeCompositionFactory({
			externalConnectorTargetConfig: targetConfig,
			scheduler: (context, selectionReservations) => {
				const registry = new SchedulerExecutorRegistry({ reservationStore: selectionReservations });
				const register = registry.register.bind(registry);
				vi.spyOn(registry, "register").mockImplementation(async (registration) => {
					registrationStarted();
					await registrationGate;
					return register(registration);
				});
				return createScheduler(context, fixture.cwd, selectionReservations, {
					registry,
					onStart: schedulerStarted,
				});
			},
			externalConnectorRegistry: (context, toolGateway, selectedTarget) => {
				if (selectedTarget === undefined) throw new Error("Expected exact selected target");
				return createTestExternalConnectorRegistry(context.sessionId, toolGateway, selectedTarget.providerId);
			},
		});
		const created = await createAgentSession({
			cwd: fixture.cwd,
			agentDir: fixture.cwd,
			modelRuntime: fixture.services.modelRuntime,
			modelBroker: fixture.services.modelBroker,
			settingsManager: fixture.services.settingsManager,
			resourceLoader: fixture.services.resourceLoader,
			capabilityRegistry: fixture.services.capabilityRegistry,
			sessionManager: SessionManager.inMemory(fixture.cwd, { id: "connector-registration-barrier" }),
			runtimeComposition: factory,
			noTools: "all",
		});
		const readiness = created.session.whenCapabilitiesReady();
		await vi.waitFor(() => expect(registrationStarted).toHaveBeenCalledOnce());
		expect(schedulerStarted).not.toHaveBeenCalled();
		releaseRegistration?.();
		try {
			await readiness;
			expect(schedulerStarted).toHaveBeenCalledOnce();
			expect(created.session.getSchedulerStatus()?.started).toBe(true);
		} finally {
			await created.session.dispose();
			await created.session.waitForDispose();
		}
	});

	it("fences Scheduler start and keeps its registry alive while disposal awaits initialization", async () => {
		const fixture = await createRuntimeFixture();
		const target = externalTargetDefinition(fixture.cwd, "dispose-target", "dispose-provider");
		const targetConfig = buildExternalConnectorTargetConfig({
			global: { schemaVersion: 1, targets: [target] },
			explicitTargetId: target.targetId,
		});
		let releaseRegistration: (() => void) | undefined;
		const registrationGate = new Promise<void>((resolve) => { releaseRegistration = resolve; });
		const registrationStarted = vi.fn();
		const schedulerStarted = vi.fn();
		const registryDisposed = vi.fn();
		const factory = createAgentRuntimeCompositionFactory({
			externalConnectorTargetConfig: targetConfig,
			scheduler: (context, selectionReservations) => {
				const registry = new SchedulerExecutorRegistry({ reservationStore: selectionReservations });
				const register = registry.register.bind(registry);
				vi.spyOn(registry, "register").mockImplementation(async (registration) => {
					registrationStarted();
					await registrationGate;
					return register(registration);
				});
				return createScheduler(context, fixture.cwd, selectionReservations, {
					registry,
					onStart: schedulerStarted,
				});
			},
			externalConnectorRegistry: (context, toolGateway, selectedTarget) => {
				if (selectedTarget === undefined) throw new Error("Expected exact selected target");
				const registry = createTestExternalConnectorRegistry(
					context.sessionId,
					toolGateway,
					selectedTarget.providerId,
				);
				const dispose = registry.dispose.bind(registry);
				vi.spyOn(registry, "dispose").mockImplementation(async () => {
					registryDisposed();
					await dispose();
				});
				return registry;
			},
		});
		const created = await createAgentSession({
			cwd: fixture.cwd,
			agentDir: fixture.cwd,
			modelRuntime: fixture.services.modelRuntime,
			modelBroker: fixture.services.modelBroker,
			settingsManager: fixture.services.settingsManager,
			resourceLoader: fixture.services.resourceLoader,
			capabilityRegistry: fixture.services.capabilityRegistry,
			sessionManager: SessionManager.inMemory(fixture.cwd, { id: "connector-dispose-barrier" }),
			runtimeComposition: factory,
			noTools: "all",
		});
		await vi.waitFor(() => expect(registrationStarted).toHaveBeenCalledOnce());
		let disposalComplete = false;
		const disposal = created.session.dispose().then(() => { disposalComplete = true; });
		try {
			await Promise.resolve();
			expect(disposalComplete).toBe(false);
			expect(schedulerStarted).not.toHaveBeenCalled();
			expect(registryDisposed).not.toHaveBeenCalled();
		} finally {
			releaseRegistration?.();
			await disposal;
		}
		expect(schedulerStarted).not.toHaveBeenCalled();
		expect(registryDisposed).toHaveBeenCalledOnce();
		await created.session.waitForDispose();
	});

	it("prevents Scheduler start when exact External Connector registration fails", async () => {
		const fixture = await createRuntimeFixture();
		const target = externalTargetDefinition(fixture.cwd, "failed-target", "failed-provider");
		const targetConfig = buildExternalConnectorTargetConfig({
			global: { schemaVersion: 1, targets: [target] },
			explicitTargetId: target.targetId,
		});
		const schedulerStarted = vi.fn();
		const factory = createAgentRuntimeCompositionFactory({
			externalConnectorTargetConfig: targetConfig,
			scheduler: (context, selectionReservations) => {
				const registry = new SchedulerExecutorRegistry({ reservationStore: selectionReservations });
				vi.spyOn(registry, "register").mockImplementation(async () => Result.err(
					new FoundationError("scheduler_executor_unavailable", "Exact connector registration rejected"),
				));
				return createScheduler(context, fixture.cwd, selectionReservations, {
					registry,
					onStart: schedulerStarted,
				});
			},
			externalConnectorRegistry: (context, toolGateway, selectedTarget) => {
				if (selectedTarget === undefined) throw new Error("Expected exact selected target");
				return createTestExternalConnectorRegistry(context.sessionId, toolGateway, selectedTarget.providerId);
			},
		});
		const created = await createAgentSession({
			cwd: fixture.cwd,
			agentDir: fixture.cwd,
			modelRuntime: fixture.services.modelRuntime,
			modelBroker: fixture.services.modelBroker,
			settingsManager: fixture.services.settingsManager,
			resourceLoader: fixture.services.resourceLoader,
			capabilityRegistry: fixture.services.capabilityRegistry,
			sessionManager: SessionManager.inMemory(fixture.cwd, { id: "connector-registration-failure" }),
			runtimeComposition: factory,
			noTools: "all",
		});
		try {
			await Promise.resolve();
			await expect(created.session.whenCapabilitiesReady()).rejects.toThrow("Exact connector registration rejected");
			await expect(created.session.whenCapabilitiesReady()).rejects.toThrow("Exact connector registration rejected");
			expect(schedulerStarted).not.toHaveBeenCalled();
			expect(created.session.getSchedulerStatus()?.started).toBe(false);
		} finally {
			await created.session.dispose();
			await created.session.waitForDispose();
		}
	});

	it("publishes one immutable local, MCP, and sandbox catalog and keeps it on invalid replacement", async () => {
		let generation = 0;
		const factory = createAgentRuntimeCompositionFactory({
			toolGatewayCatalog: () => {
				generation += 1;
				return {
					gatewayId: "composition-product-gateway",
					builtinLocalProviders: [catalogProvider("local", "builtin-product", 1, "workspace", "workspace.read", {
						resource: "filesystem.read",
						effects: ["read"],
					})],
					mcpProviders: [catalogProvider(
						"mcp",
						"mcp-product",
						2,
						"docs",
						"list",
						{ resource: "filesystem.read", effects: ["read"] },
						generation === 1 ? 2 : 1,
					)],
					sandboxProviders: [catalogProvider("sandbox", "sandbox-product", 3, "workspace", "workspace.bash", {
						resource: "process.spawn",
						effects: ["write", "create", "delete", "move", "command", "network", "commit", "push", "merge"],
						requiresSandbox: true,
					})],
				};
			},
		});
		const fixture = await createRuntimeFixture(factory);
		const runtime = await createAgentSessionRuntime(runtimeFactory(fixture), {
			cwd: fixture.cwd,
			agentDir: fixture.cwd,
			session: { mode: "memory", id: "composition-product-catalog" },
		});
		try {
			const initial = runtime.runtimeComposition;
			const catalogGateway = initial.toolGateway as ToolGateway & {
				readonly getRouteCatalog: () => readonly ToolGatewayRoute[];
			};
			const routes = catalogGateway.getRouteCatalog();
			expect(Object.isFrozen(routes)).toBe(true);
			expect(routes).toEqual([
				{ kind: "local", providerId: "builtin-product", revision: 1, namespace: "workspace", toolName: "workspace.read", operation: { resource: "filesystem.read", effects: ["read"] } },
				{ kind: "mcp", providerId: "mcp-product", revision: 2, namespace: "docs", toolName: "list", operation: { resource: "filesystem.read", effects: ["read"] } },
				{ kind: "sandbox", providerId: "sandbox-product", revision: 3, namespace: "workspace", toolName: "workspace.bash", operation: { resource: "process.spawn", effects: ["write", "create", "delete", "move", "command", "network", "commit", "push", "merge"], requiresSandbox: true } },
			]);

			await expect(runtime.newSession()).rejects.toMatchObject({ code: "tool_gateway_catalog_invalid" });
			expect(runtime.runtimeComposition).toBe(initial);
			expect(catalogGateway.getRouteCatalog()).toEqual(routes);
		} finally {
			await runtime.dispose();
		}
	});

	it("keeps direct SDK and services composition surfaces in parity from package-root exports", async () => {
		const captures = emptyCaptures();
		const cwd = mkdtempSync(join(tmpdir(), "aos-runtime-parity-"));
		directories.push(cwd);
		const factory = createCompositionFactory(cwd, captures);
		const fixture = await createRuntimeFixture(factory);
		const direct = await createAgentSession({
			cwd,
			agentDir: cwd,
			modelRuntime: fixture.services.modelRuntime,
			modelBroker: fixture.services.modelBroker,
			settingsManager: fixture.services.settingsManager,
			resourceLoader: fixture.services.resourceLoader,
			capabilityRegistry: fixture.services.capabilityRegistry,
			sessionManager: SessionManager.inMemory(cwd, { id: "composition-direct-parity" }),
			runtimeComposition: factory,
			noTools: "all",
		});
		const fromServices = await createAgentSessionFromServices({
			services: fixture.services,
			sessionManager: SessionManager.inMemory(cwd, { id: "composition-services-parity" }),
			noTools: "all",
		});
		try {
			for (const composition of [direct.runtimeComposition, fromServices.runtimeComposition]) {
				expect(composition.factory).toBe(factory);
				expect(composition.session).toBeDefined();
				expect(composition.harness).toBeDefined();
				expect(composition.toolGateway).toBeDefined();
				expect(composition.workerSandboxProvider).toBeDefined();
				expect(composition.subagents).toBeDefined();
				expect(composition.scheduler).toBeDefined();
				expect(composition.externalConnectorRegistry).toBeDefined();
				expect(composition.taskCredentialProvider).toBeDefined();
				expect(composition.subagents?.session).toBe(composition.session);
				expect(composition.subagents?.writer).toBe(composition.harness.ledger.writer);
				expect(composition.scheduler?.sourceSession).toBe(composition.session);
			}
		} finally {
			await direct.session.dispose();
			await fromServices.session.dispose();
		}
	});

	it("carries the composed External Connector registry through the TUI Session", async () => {
		const runtime = await createExternalConnectorSurfaceRuntime("composition-tui-surface");
		const registry = runtime.runtimeComposition.externalConnectorRegistry;
		const interactiveMode = new InteractiveMode(runtime, { tuiMode: "regular" });
		try {
			expect(runtime.runtimeComposition).toBe(runtime.session.agentRuntimeComposition);
			expect(runtime.session.getExternalConnectorRegistry()).toBe(registry);
			expect(registry?.list()).toHaveLength(1);
		} finally {
			interactiveMode.stop("transcript");
			await runtime.dispose();
		}
	});

	it("carries the composed External Connector registry through the print Session", async () => {
		const runtime = await createExternalConnectorSurfaceRuntime("composition-print-surface");
		const registry = runtime.runtimeComposition.externalConnectorRegistry;
		expect(runtime.runtimeComposition).toBe(runtime.session.agentRuntimeComposition);
		expect(runtime.session.getExternalConnectorRegistry()).toBe(registry);
		expect(registry?.list()).toHaveLength(1);
		expect(await runPrintMode(runtime, { mode: "text" })).toBe(0);
	});

	it("disposes the allocated Session when initial runtime composition validation fails", async () => {
		const hostFactory = createAgentRuntimeCompositionFactory({});
		const candidateFactory = createAgentRuntimeCompositionFactory({
			externalConnectorRegistry: () => createExternalConnectorRegistry(),
		});
		const hostFixture = await createRuntimeFixture(hostFactory);
		const candidateFixture = await createRuntimeFixture(candidateFactory);
		let candidateSession: Awaited<ReturnType<typeof createAgentSessionFromServices>>["session"] | undefined;
		const mismatchedFactory: CreateAgentSessionRuntimeFactory = async (options) => {
			const created = await createAgentSessionFromServices({
				services: candidateFixture.services,
				sessionManager: options.sessionManager,
				sessionStartEvent: options.sessionStartEvent,
				noTools: "all",
			});
			candidateSession = created.session;
			vi.spyOn(created.session, "dispose");
			options.registerCandidateSession(created.session);
			return {
				...created,
				services: hostFixture.services,
				diagnostics: hostFixture.services.diagnostics,
			};
		};

		await expect(createAgentSessionRuntime(mismatchedFactory, {
			cwd: candidateFixture.cwd,
			agentDir: candidateFixture.cwd,
			session: { mode: "memory", id: "invalid-initial-composition" },
		})).rejects.toThrow("Initial runtime must derive from the services runtime composition");

		expect(candidateSession).toBeDefined();
		expect(candidateSession?.dispose).toHaveBeenCalledTimes(1);
		await candidateSession?.waitForDispose();
	});

	it("rejects and disposes a factory result that was not registered", async () => {
		const fixture = await createRuntimeFixture();
		let candidateSession: Awaited<ReturnType<typeof createAgentSessionFromServices>>["session"] | undefined;
		const missingRegistration: CreateAgentSessionRuntimeFactory = async (options) => {
			const created = await createAgentSessionFromServices({
				services: fixture.services,
				sessionManager: options.sessionManager,
				sessionStartEvent: options.sessionStartEvent,
				noTools: "all",
			});
			candidateSession = created.session;
			vi.spyOn(created.session, "dispose");
			return {
				...created,
				services: fixture.services,
				diagnostics: fixture.services.diagnostics,
			};
		};

		await expect(createAgentSessionRuntime(missingRegistration, {
			cwd: fixture.cwd,
			agentDir: fixture.cwd,
			session: { mode: "memory", id: "missing-registration" },
		})).rejects.toThrow("must register its candidate Session before returning");

		expect(candidateSession?.dispose).toHaveBeenCalledTimes(1);
		await candidateSession?.waitForDispose();
	});

	it("rejects and disposes both registered and returned Sessions when they differ", async () => {
		const fixture = await createRuntimeFixture();
		const candidates: Array<Awaited<ReturnType<typeof createAgentSessionFromServices>>["session"]> = [];
		const mismatchedRegistration: CreateAgentSessionRuntimeFactory = async (options) => {
			const registered = await createAgentSessionFromServices({
				services: fixture.services,
				sessionManager: options.sessionManager,
				sessionStartEvent: options.sessionStartEvent,
				noTools: "all",
			});
			const returned = await createAgentSessionFromServices({
				services: fixture.services,
				sessionManager: SessionManager.inMemory(fixture.cwd, { id: "mismatched-return" }),
				noTools: "all",
			});
			for (const candidate of [registered.session, returned.session]) {
				candidates.push(candidate);
				vi.spyOn(candidate, "dispose");
			}
			options.registerCandidateSession(registered.session);
			return {
				...returned,
				services: fixture.services,
				diagnostics: fixture.services.diagnostics,
			};
		};

		await expect(createAgentSessionRuntime(mismatchedRegistration, {
			cwd: fixture.cwd,
			agentDir: fixture.cwd,
			session: { mode: "memory", id: "mismatched-registration" },
		})).rejects.toThrow("returned a different Session than its registered candidate");

		expect(candidates).toHaveLength(2);
		for (const candidate of candidates) {
			expect(candidate.dispose).toHaveBeenCalledTimes(1);
			await candidate.waitForDispose();
		}
	});

	it("disposes a Session when model route selection fails after allocation", async () => {
		const fixture = await createRuntimeFixture();
		const disposeSpy = vi.spyOn(AgentSession.prototype, "dispose");

		await expect(createAgentSession({
			cwd: fixture.cwd,
			agentDir: fixture.cwd,
			modelRuntime: fixture.services.modelRuntime,
			modelBroker: fixture.services.modelBroker,
			settingsManager: fixture.services.settingsManager,
			resourceLoader: fixture.services.resourceLoader,
			capabilityRegistry: fixture.services.capabilityRegistry,
			sessionManager: SessionManager.inMemory(fixture.cwd, { id: "post-allocation-model-route-fault" }),
			modelRoute: "missing-route",
			noTools: "all",
		})).rejects.toMatchObject({ code: "model_route_not_found" });

		expect(disposeSpy).toHaveBeenCalledTimes(1);
	});

	it("recomposes fresh session-scoped authorities for replacement Sessions", async () => {
		const captures = emptyCaptures();
		const cwd = mkdtempSync(join(tmpdir(), "aos-runtime-replacement-"));
		directories.push(cwd);
		const factory = createCompositionFactory(cwd, captures);
		const fixture = await createRuntimeFixture(factory);
		const runtime = await createAgentSessionRuntime(runtimeFactory(fixture), {
			cwd: fixture.cwd,
			agentDir: fixture.cwd,
			session: { mode: "memory", id: "composition-initial" },
		});
		const initial = runtime.runtimeComposition;

		expect(fixture.services.runtimeComposition).toBe(factory);
		expect(initial.factory).toBe(factory);
		await runtime.newSession();
		const replacement = runtime.runtimeComposition;
		expect(replacement.factory).toBe(factory);
		expectFreshComposition(initial, replacement);
		await runtime.newSession();
		const secondReplacement = runtime.runtimeComposition;
		expectFreshComposition(replacement, secondReplacement);
		expect(captures.workers).toHaveLength(3);
		expect(captures.externalRegistries).toHaveLength(3);
		expect(captures.credentialProviders).toHaveLength(3);
		for (const registry of captures.externalRegistries.slice(0, -1)) expect(registry.list()).toHaveLength(0);
		expect(captures.externalRegistries.at(-1)?.list()).toHaveLength(1);
		expect(secondReplacement.subagents?.writer).toBe(secondReplacement.harness.ledger.writer);
		expect(secondReplacement.subagents?.session).toBe(secondReplacement.session);
		expect(secondReplacement.subagents?.toolGateway).toBe(secondReplacement.toolGateway);
		expect(secondReplacement.scheduler?.sourceSession).toBe(secondReplacement.session);
		expect(secondReplacement.externalConnectorRegistry?.list()).toHaveLength(1);
		expect(secondReplacement.taskCredentialProvider).toBeDefined();
		expect(runtime.session.getWorkerRegistry()?.listWorkerRecords()).toEqual([]);
		await runtime.dispose();
	});

	it("rejects reused mutable Worker, registry, and credential authorities", async () => {
		const fixture = await createRuntimeFixture();
		const worker = createWorkerSandboxComposition({
			providerId: "reused-worker",
			profile: {
				profileId: "reused-worker-profile",
				profileRevision: 1,
				trusted: true,
				supervisor: {
					executable: process.execPath,
					entrypoint: CHILD_ENTRY,
					profileId: "reused-worker-profile",
					profileRevision: 1,
					capabilities: [],
					readyTimeoutMs: 1_000,
					heartbeatTimeoutMs: 1_000,
					cancelTimeoutMs: 100,
					terminateTimeoutMs: 100,
				},
			},
			resolvePreflight: () => {
				throw new Error("not exercised");
			},
		});
		const registry = createTestExternalConnectorRegistry("reused");
		const credential = createTaskCredentialTestProvider({ materials: { fixture: "reused" }, now: () => NOW });
		const factory = createAgentRuntimeCompositionFactory({
			trustedWorkerSandboxFactory: () => worker,
			externalConnectorRegistry: () => registry,
			taskCredentialProvider: () => credential,
			taskCredentialPolicyMaxTtlMs: 60_000,
		});
		const common = {
			cwd: fixture.cwd,
			agentDir: fixture.cwd,
			modelRuntime: fixture.services.modelRuntime,
			modelBroker: fixture.services.modelBroker,
			settingsManager: fixture.services.settingsManager,
			resourceLoader: fixture.services.resourceLoader,
			capabilityRegistry: fixture.services.capabilityRegistry,
			runtimeComposition: factory,
			noTools: "all" as const,
		};
		const first = await createAgentSession({
			...common,
			sessionManager: SessionManager.inMemory(fixture.cwd, { id: "reused-first" }),
		});
		await first.session.dispose();
		await first.session.waitForDispose();
		await expect(createAgentSession({
			...common,
			sessionManager: SessionManager.inMemory(fixture.cwd, { id: "reused-second" }),
		})).rejects.toThrow("must be created fresh for each Session");
	});

	it("carries the same composition through the server Harness root", async () => {
		const fixture = await createRuntimeFixture();
		const models = createModels();
		models.setProvider(googleProvider());
		const session = new Session(new InMemorySessionStorage({ id: "server-composition", createdAt: 1 }));
		const env = new NodeExecutionEnv({ cwd: fixture.cwd });
		const gateway = createGateway("server-composition");
		const factory = createAgentRuntimeCompositionFactory({ toolGateway: () => gateway });
		const created = await createCodingAgentHarness({
			session,
			models,
			model: getModel("google", "gemini-2.5-flash"),
			env,
			runtimeComposition: factory,
		});
		try {
			expect(created.runtimeComposition.factory).toBe(factory);
			expect(created.runtimeComposition.session).toBe(session);
			expect(created.runtimeComposition.harness).toBe(created.harness);
			expect(created.runtimeComposition.toolGateway).not.toBe(gateway);
			if (!("operationToolGateway" in created)) throw new Error("Expected composition Tool Gateway");
			expect(created.operationToolGateway).toBe(created.runtimeComposition.toolGateway);
		} finally {
			await created.harness.close();
			await env.cleanup();
		}
	});

	// The helper waits for standard main's startup event, then bounds only RPC initialize.
	it("passes an explicit trusted root through standard main into RPC initialize", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "aos-main-rpc-composition-"));
		directories.push(cwd);
		const result = await runMainRpcInitialize(cwd);
		expect(result.code).toBe(0);
			expect(result.response).toMatchObject({
			id: "main-rpc-initialize",
			type: "response",
			command: "initialize",
			success: true,
			data: {
				workerCommands: ["worker.get", "worker.list", "worker.reclaim"],
				subagentCommands: ["subagent.get", "subagent.list", "subagent.cancel"],
				schedulerCommands: ["scheduler.status"],
				taskCredentialCommands: [
					"task.credential.issue",
					"task.credential.get",
					"task.credential.list",
					"task.credential.heartbeat",
					"task.credential.revoke",
					"task.credential.settle",
				],
				externalConnectors: [
					{
						providerId: "main-rpc-trusted-connector",
						providerClass: PROVIDER_CLASS.externalConnector,
						revision: 1,
					},
				],
			},
		});
		expect(result.stderr).not.toContain("Error:");
	}, 0);

	it("runs and resumes an External Connector through package-root main after a crash", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "aos-main-rpc-external-resume-"));
		directories.push(cwd);
		const sessionId = "main-rpc-external-resume";
		const durableStatePath = join(cwd, "external-supervisor.json");
		const durableMarkerPath = join(cwd, "external-durable.marker");
		const selectionSnapshot = createConnectorCapabilitySnapshot({
			schemaVersion: 1,
			providerId: "main-rpc-trusted-connector",
			revision: 1,
			protocol: { name: "main-rpc-test", version: "1" },
			modelAccess: "none",
			resume: true,
			toolGateway: false,
			artifacts: false,
			images: false,
		});
		const externalConnector = {
			providerId: selectionSnapshot.providerId,
			revision: selectionSnapshot.revision,
			capabilitySnapshotDigest: selectionSnapshot.digest,
		};
		const first = startMainRpcPeer(cwd, {
			phase: "crash",
			sessionId,
			durableStatePath,
			durableMarkerPath,
		});
		first.send({ id: "external-init", type: "initialize", protocolVersion: 1 });
		await first.waitFor((record) => isRpcRecord(record, { id: "external-init", type: "response" }));
		first.send({
			id: "external-start",
			type: "run.start",
			message: "durable package-root external run",
			clientRequestId: "main-rpc-external-request",
			externalConnector,
		});
		const started = await first.waitFor((record) =>
			isRpcRecord(record, { id: "external-start", type: "response" }),
		);
		expect(started).toMatchObject({ success: true, data: { status: "accepted", attempt: 1 } });
		if (typeof started !== "object" || started === null || !("data" in started)) {
			throw new Error("External run.start response is missing durable run data");
		}
		const data = started.data;
		if (typeof data !== "object" || data === null || !("runId" in data) || typeof data.runId !== "string") {
			throw new Error("External run.start response is missing runId");
		}
		await vi.waitFor(() => expect(existsSync(durableMarkerPath)).toBe(true));
		first.child.kill();
		await first.waitForClose();

		const sessionDir = join(cwd, "agent", "sessions");
		const sessions = await SessionManager.list(cwd, sessionDir);
		const sessionPath = sessions.find((session) => session.id === sessionId)?.path;
		expect(sessionPath).toBeDefined();

		const second = startMainRpcPeer(cwd, {
			phase: "resume",
			sessionId: `${sessionId}-reopen`,
			durableStatePath,
			durableMarkerPath,
		});
		try {
			second.send({ id: "external-reopen-init", type: "initialize", protocolVersion: 1 });
			await second.waitFor((record) => isRpcRecord(record, { id: "external-reopen-init", type: "response" }));
			second.send({
				id: "external-resume",
				type: "run.resume",
				sessionPath,
				sourceRunId: data.runId,
				message: "durable package-root external run",
				externalConnector,
			});
			const resumed = await second.waitFor((record) =>
				isRpcRecord(record, { id: "external-resume", type: "response" }),
			);
			if (typeof resumed === "object" && resumed !== null && "success" in resumed && resumed.success === false) {
				throw new Error(`External run.resume failed: ${JSON.stringify(resumed)} stderr=${second.stderr()}`);
			}
			expect(resumed).toMatchObject({ success: true, data: { runId: data.runId } });
			await vi.waitFor(() => expect(readFileSync(durableMarkerPath, "utf8")).toBe("terminal\n"));
			second.send({ id: "external-get", type: "run.get", runId: data.runId });
			const completed = await second.waitFor((record) =>
				isRpcRecord(record, { id: "external-get", type: "response" }),
			);
			expect(completed).toMatchObject({ success: true, data: { receipt: { status: "completed" } } });
			second.child.stdin.end();
			await second.waitForClose();
			expect(second.stderr()).not.toContain("Error:");
		} finally {
			if (second.child.exitCode === null) second.child.kill();
		}
	}, 130_000);

	it("keeps optional providers off across SDK and RPC when Host composition omits them", async () => {
		const fixture = await createRuntimeFixture();
		const runtime = await createAgentSessionRuntime(runtimeFactory(fixture), {
			cwd: fixture.cwd,
			agentDir: fixture.cwd,
			session: { mode: "memory", id: "composition-default-off" },
		});
		const composition = runtime.runtimeComposition;

		expect(composition.toolGateway).toBeUndefined();
		expect(composition.workerSandboxProvider).toBeUndefined();
		expect(composition.subagents).toBeUndefined();
		expect(composition.scheduler).toBeUndefined();
		expect(composition.externalConnectorRegistry).toBeUndefined();
		expect(composition.taskCredentialProvider).toBeUndefined();

		const controller = createRpcHostController(runtime);
		await controller.start();
		try {
			const initialized = await controller.dispatch({ type: "initialize", protocolVersion: 1 });
			expect(initialized).toMatchObject({ success: true });
			if (initialized === undefined || initialized.command !== "initialize" || !initialized.success) {
				throw new Error("Expected initialize response");
			}
			expect(initialized.data).not.toHaveProperty("externalConnectors");
			expect(initialized.data).not.toHaveProperty("workerCommands");
			expect(initialized.data).not.toHaveProperty("subagentCommands");
			expect(initialized.data).not.toHaveProperty("schedulerCommands");
			expect(initialized.data).not.toHaveProperty("taskCredentialCommands");
		} finally {
			await controller.shutdown();
		}
	});
});
