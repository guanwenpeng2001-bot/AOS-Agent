import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	createModelProfileRevision,
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
	SessionT5Ledger,
	type AgentBinding,
	type ArtifactStoreProvider,
	type ModelProfile,
	type QuotaProvider,
	type RevisionReference,
	type ScopedModelGateway,
	type TaskEnvelope,
	type ToolGateway,
} from "@aos-agent/agent-core";
import { NodeExecutionEnv } from "@aos-agent/agent-core/node";
import { createModels } from "@aos-agent/ai";
import { getModel } from "@aos-agent/ai/compat";
import { googleProvider } from "@aos-agent/ai/providers/google";
import { afterEach, describe, expect, it } from "vitest";
import {
	createAgentRuntimeCompositionFactory,
	createAgentSession,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	createExternalAgentAdapterRegistry,
	createExternalAgentPreparedBinding,
	createRpcHostController,
	createTrustedWorkerSandboxComposition,
	SchedulerExecutorRegistry,
	type AgentRuntimeComposition,
	type AgentRuntimeCompositionContext,
	type AgentRuntimeCompositionFactory,
	type AgentRuntimeCompositionOptions,
	type CreateAgentSessionRuntimeFactory,
	type ExternalAgentAdapter,
	type ExternalAgentAdapterRegistry,
	type TaskCredentialProvider,
	type TrustedSchedulerRuntimeOptions,
} from "../src/index.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { getAgentCanonicalSession } from "../src/core/agent-session-facade.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createSessionManagerStorage } from "../src/core/session-manager-storage.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import type { TrustedSubagentCompositionOptionsV1 } from "../src/core/subagent-composition.ts";
import { createTaskCredentialTestProvider } from "../src/core/task-credential-provider.ts";
import { TaskGraphStore } from "../src/core/task-graph.ts";
import { createCodingAgentHarness } from "../src/server/create-harness.ts";
import { sourceProcessArgs, sourceProcessEnv } from "./cli-process.ts";

const NOW = "2026-08-26T00:00:00.000Z";
const LATER = "2026-08-26T00:01:00.000Z";
const CHILD_ENTRY = fileURLToPath(new URL("./fixtures/fake-worker-child.ts", import.meta.url));
const MAIN_RPC_ENTRY = fileURLToPath(new URL("./fixtures/main-rpc-runtime-composition.ts", import.meta.url));

interface RuntimeFixture {
	readonly cwd: string;
	readonly services: Awaited<ReturnType<typeof createAgentSessionServices>>;
}

interface CompositionCaptures {
	readonly contexts: AgentRuntimeCompositionContext[];
	readonly gateways: ToolGateway[];
	readonly workers: ReturnType<typeof createTrustedWorkerSandboxComposition>[];
	readonly subagents: TrustedSubagentCompositionOptionsV1[];
	readonly schedulers: TrustedSchedulerRuntimeOptions[];
	readonly externalRegistries: ExternalAgentAdapterRegistry[];
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
	return async (options) => ({
		...(await createAgentSessionFromServices({
			services: fixture.services,
			sessionManager: options.sessionManager,
			sessionStartEvent: options.sessionStartEvent,
			noTools: "all",
		})),
		services: fixture.services,
		diagnostics: fixture.services.diagnostics,
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

function createSubagents(context: AgentRuntimeCompositionContext, toolGateway: ToolGateway): TrustedSubagentCompositionOptionsV1 {
	const memoryLedger = new SessionT5Ledger(context.session, {
		ownerId: `composition-memory-${context.sessionId}`,
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
		ownerId: `composition-ledger-${context.sessionId}`,
		laneId,
	});
	return {
		schemaVersion: 1,
		enabled: true,
		session: context.session,
		writer: context.harness.t5.writer,
		ledger: ledgerForLane("main"),
		ledgerForLane,
		sessionId: context.sessionId,
		parentLaneId: "main",
		quota,
		modelGateway,
		toolGateway,
		artifactStore,
		createHarness: async () => context.harness,
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

const schedulerAdmissionGate = Object.freeze({ getByBusinessKey: () => undefined });
const settleRunAtHost = async () => {
	throw new Error("No graph work is present");
};

function createScheduler(context: AgentRuntimeCompositionContext, cwd: string): TrustedSchedulerRuntimeOptions {
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
		ownerId: `composition-scheduler-${context.sessionId}`,
		registry: new SchedulerExecutorRegistry(),
		task: currentTask,
		binding: schedulerBinding(currentTask, context.sessionId),
		gateLookup: schedulerAdmissionGate,
		resolveRunAssociation: async () => {
			throw new Error("No graph work is present");
		},
		settleRunAtHost,
		pollIntervalMs: 60_000,
		now: () => NOW,
	};
}

function createFakeExternalAdapter(sessionId: string): ExternalAgentAdapter {
	const external = { namespace: "composition", externalSessionId: `external-${sessionId}` } as const;
	return {
		id: `external-adapter-${sessionId}`,
		probe: async (target) => ({
			schemaVersion: 1,
			adapterId: `external-adapter-${sessionId}`,
			targetId: target.targetId,
			protocol: { name: "composition-test", version: "1" },
			status: "ready",
			capabilities: {
				start: true,
				events: "none",
				cancel: "strong",
				receipt: "terminal",
				resume: false,
				artifacts: false,
				toolGateway: false,
			},
			observedAt: NOW,
		}),
		prepare: async (request, snapshot) => createExternalAgentPreparedBinding(request, snapshot),
		start: async () => ({
			external,
			events: {
				async *[Symbol.asyncIterator]() {},
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
			heartbeat: async () => ({ leaseId: `lease-${sessionId}`, expiresAt: LATER }),
		}),
	};
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
			const worker = createTrustedWorkerSandboxComposition({
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
		scheduler: (context) => {
			captures.contexts.push(context);
			const scheduler = createScheduler(context, cwd);
			captures.schedulers.push(scheduler);
			return scheduler;
		},
		externalAgentRegistry: (context) => {
			captures.contexts.push(context);
			const registry = createExternalAgentAdapterRegistry();
			registry.register(createFakeExternalAdapter(context.sessionId), { targets: [`target-${context.sessionId}`] });
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
	expect(replacement.externalAgentRegistry).not.toBe(initial.externalAgentRegistry);
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
				AOS_AGENT_CODING_AGENT_DIR: agentDir,
				AOS_AGENT_CODING_AGENT_SESSION_DIR: join(agentDir, "sessions"),
				AOS_AGENT_OFFLINE: "1",
				AOS_AGENT_SKIP_VERSION_CHECK: "1",
			},
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		let response: unknown;
		const timer = setTimeout(() => {
			child.kill();
			reject(new Error(`main -> RPC initialize timed out: ${stderr}`));
		}, 30_000);
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
						child.stdin.end();
					}
				} catch {
					// The assertion below reports complete stdout if RPC emitted non-JSON output.
				}
			}
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		child.on("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			if (response === undefined) {
				reject(new Error(`main -> RPC initialize produced no response. stdout=${stdout} stderr=${stderr}`));
				return;
			}
			resolvePromise({ code, stderr, response });
		});
		child.stdin.write(`${JSON.stringify({ id: "main-rpc-initialize", type: "initialize", protocolVersion: 1 })}\n`);
	});
}

describe("AgentRuntimeComposition", () => {
	afterEach(() => {
		for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
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
			expect(composition.toolGateway).toBe(captures.gateways[0]);
			expect(composition.workerSandboxProvider).toBe(captures.workers[0]?.provider);
			expect(composition.subagents).toBe(captures.subagents[0]);
			expect(composition.scheduler).toMatchObject(captures.schedulers[0] ?? {});
			expect(composition.scheduler).not.toHaveProperty("runLifecycleSession");
			expect(composition.externalAgentRegistry).toBe(captures.externalRegistries[0]);
			expect(composition.taskCredentialProvider).toBe(captures.credentialProviders[0]);
			expect(created.session.getExternalAgentRegistry()).toBe(composition.externalAgentRegistry);
			expect(created.session.getWorkerRegistry()?.listWorkerRecords()).toEqual([]);
			expect(created.session.getSubagentRegistry()).toBeDefined();
			expect(created.session.getSchedulerStatus()).toBeDefined();
			expect(() => captures.externalRegistries[0]?.register(createFakeExternalAdapter("late"))).toThrowError(
				expect.objectContaining({ code: "external_agent_adapter_invalid" }),
			);
			expect(composition.subagents?.session).toBe(composition.session);
			expect(composition.subagents?.toolGateway).toBe(composition.toolGateway);
			expect(composition.subagents?.writer).toBe(composition.harness.t5.writer);
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
		for (const [index, registry] of captures.externalRegistries.entries()) {
			expect(() => registry.register(createFakeExternalAdapter(`late-${index}`))).toThrowError(
				expect.objectContaining({ code: "external_agent_adapter_invalid" }),
			);
		}
		expect(secondReplacement.subagents?.writer).toBe(secondReplacement.harness.t5.writer);
		expect(secondReplacement.subagents?.session).toBe(secondReplacement.session);
		expect(secondReplacement.subagents?.toolGateway).toBe(secondReplacement.toolGateway);
		expect(secondReplacement.scheduler?.sourceSession).toBe(secondReplacement.session);
		expect(secondReplacement.externalAgentRegistry?.list()).toHaveLength(1);
		expect(secondReplacement.taskCredentialProvider).toBeDefined();
		expect(runtime.session.getWorkerRegistry()?.listWorkerRecords()).toEqual([]);
		await runtime.dispose();
	});

	it("rejects reused mutable Worker, registry, and credential authorities", async () => {
		const fixture = await createRuntimeFixture();
		const worker = createTrustedWorkerSandboxComposition({
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
		const registry = createExternalAgentAdapterRegistry();
		registry.register(createFakeExternalAdapter("reused"), { targets: ["target-reused"] });
		const credential = createTaskCredentialTestProvider({ materials: { fixture: "reused" }, now: () => NOW });
		const factory = createAgentRuntimeCompositionFactory({
			trustedWorkerSandboxFactory: () => worker,
			externalAgentRegistry: () => registry,
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
			expect(created.runtimeComposition.toolGateway).toBe(gateway);
			if (!("operationToolGateway" in created)) throw new Error("Expected composition Tool Gateway");
			expect(created.operationToolGateway).toBe(gateway);
		} finally {
			await created.harness.close();
			await env.cleanup();
		}
	});

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
				externalAgentAdapters: [
					{
						adapterId: "main-rpc-trusted-adapter",
						displayName: "Main RPC trusted adapter",
						version: "1",
					},
				],
			},
		});
		expect(result.stderr).not.toContain("Error:");
	});

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
		expect(composition.externalAgentRegistry).toBeUndefined();
		expect(composition.taskCredentialProvider).toBeUndefined();

		const controller = createRpcHostController(runtime);
		await controller.start();
		try {
			const initialized = await controller.dispatch({ type: "initialize", protocolVersion: 1 });
			expect(initialized).toMatchObject({ success: true });
			if (initialized === undefined || initialized.command !== "initialize" || !initialized.success) {
				throw new Error("Expected initialize response");
			}
			expect(initialized.data).not.toHaveProperty("externalAgentAdapters");
			expect(initialized.data).not.toHaveProperty("workerCommands");
			expect(initialized.data).not.toHaveProperty("subagentCommands");
			expect(initialized.data).not.toHaveProperty("schedulerCommands");
			expect(initialized.data).not.toHaveProperty("taskCredentialCommands");
		} finally {
			await controller.shutdown();
		}
	});
});
