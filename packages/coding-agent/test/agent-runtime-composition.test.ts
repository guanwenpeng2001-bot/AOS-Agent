import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	FoundationError,
	InMemorySessionStorage,
	Result,
	Session,
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
	createRpcHostController,
	createTrustedWorkerSandboxComposition,
	type AgentRuntimeCompositionFactory,
	type CreateAgentSessionRuntimeFactory,
	type TaskCredentialProvider,
	type TrustedSchedulerCompositionOptions,
} from "../src/index.ts";
import { materializeAgentRuntimeComposition } from "../src/core/agent-runtime-composition.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import type { TrustedSubagentCompositionOptionsV1 } from "../src/core/subagent-composition.ts";
import { createCodingAgentHarness } from "../src/server/create-harness.ts";

interface RuntimeFixture {
	readonly cwd: string;
	readonly services: Awaited<ReturnType<typeof createAgentSessionServices>>;
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

describe("AgentRuntimeComposition", () => {
	afterEach(() => {
		for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
	});

	it("materializes one immutable graph containing every trusted authority", async () => {
		const fixture = await createRuntimeFixture();
		const sessionManager = SessionManager.inMemory(fixture.cwd, { id: "composition-context" });
		const base = await createAgentSession({
			cwd: fixture.cwd,
			agentDir: fixture.cwd,
			modelRuntime: fixture.services.modelRuntime,
			modelBroker: fixture.services.modelBroker,
			settingsManager: fixture.services.settingsManager,
			resourceLoader: fixture.services.resourceLoader,
			capabilityRegistry: fixture.services.capabilityRegistry,
			sessionManager,
			noTools: "all",
		});
		const gateway: ToolGateway = {
			schemaVersion: 1,
			providerId: "composition-gateway",
			providerClass: "gateway",
			capabilities: async () => [],
			dispose: async () => {},
			execute: async () => Result.err(new FoundationError("tool_guard_denied", "not exercised")),
		};
		const worker = createTrustedWorkerSandboxComposition({
			providerId: "composition-worker",
			profile: {
				profileId: "composition-worker-profile",
				profileRevision: 1,
				trusted: true,
				supervisor: {
					executable: process.execPath,
					entrypoint: "not-started-by-composition-test",
					profileId: "composition-worker-profile",
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
		const externalAgentRegistry = createExternalAgentAdapterRegistry();
		const taskCredentialProvider = Object.freeze({}) as TaskCredentialProvider;
		const subagents = {
			session: base.runtimeComposition.session,
			toolGateway: gateway,
		} as unknown as TrustedSubagentCompositionOptionsV1;
		const scheduler = {
			sourceSession: base.runtimeComposition.session,
			targetSession: base.runtimeComposition.session,
			runLifecycleSession: sessionManager,
		} as unknown as TrustedSchedulerCompositionOptions;
		let gatewayCalls = 0;
		let subagentCalls = 0;
		let schedulerCalls = 0;
		const factory = createAgentRuntimeCompositionFactory({
			toolGateway: () => {
				gatewayCalls += 1;
				return gateway;
			},
			trustedWorkerSandbox: worker,
			subagents: () => {
				subagentCalls += 1;
				return subagents;
			},
			scheduler: () => {
				schedulerCalls += 1;
				return scheduler;
			},
			externalAgentRegistry,
			taskCredentialProvider,
			taskCredentialPolicyMaxTtlMs: 60_000,
		});
		const composition = materializeAgentRuntimeComposition(factory, {
			session: base.runtimeComposition.session,
			harness: base.runtimeComposition.harness,
			sessionManager,
			models: fixture.services.modelRuntime,
			modelBroker: fixture.services.modelBroker,
			capabilityRegistry: fixture.services.capabilityRegistry,
		});

		expect(Object.isFrozen(factory)).toBe(true);
		expect(Object.isFrozen(composition)).toBe(true);
		expect(composition).toMatchObject({
			factory,
			toolGateway: gateway,
			workerSandboxProvider: worker.provider,
			subagents,
			scheduler,
			externalAgentRegistry,
			taskCredentialProvider,
			taskCredentialPolicyMaxTtlMs: 60_000,
		});
		expect({ gatewayCalls, subagentCalls, schedulerCalls }).toEqual({
			gatewayCalls: 1,
			subagentCalls: 1,
			schedulerCalls: 1,
		});

		await worker.provider.dispose();
		await base.session.dispose();
		await base.session.waitForDispose();
	});

	it("reuses the services factory for initial and replacement runtime candidates", async () => {
		const externalAgentRegistry = createExternalAgentAdapterRegistry();
		const factory = createAgentRuntimeCompositionFactory({ externalAgentRegistry });
		const fixture = await createRuntimeFixture(factory);
		const runtime = await createAgentSessionRuntime(runtimeFactory(fixture), {
			cwd: fixture.cwd,
			agentDir: fixture.cwd,
			session: { mode: "memory", id: "composition-initial" },
		});
		const initial = runtime.runtimeComposition;

		expect(fixture.services.runtimeComposition).toBe(factory);
		expect(initial.factory).toBe(factory);
		expect(initial.externalAgentRegistry).toBe(externalAgentRegistry);
		expect(initial).toBe(runtime.session.agentRuntimeComposition);

		await runtime.newSession();
		const replacement = runtime.runtimeComposition;
		expect(replacement).not.toBe(initial);
		expect(replacement.factory).toBe(factory);
		expect(replacement.externalAgentRegistry).toBe(externalAgentRegistry);
		expect(replacement.session).not.toBe(initial.session);
		expect(replacement.harness).not.toBe(initial.harness);
		await runtime.dispose();
	});

	it("carries the same composition through the server Harness root", async () => {
		const fixture = await createRuntimeFixture();
		const models = createModels();
		models.setProvider(googleProvider());
		const session = new Session(new InMemorySessionStorage({ id: "server-composition", createdAt: 1 }));
		const env = new NodeExecutionEnv({ cwd: fixture.cwd });
		const gateway: ToolGateway = {
			schemaVersion: 1,
			providerId: "server-composition-gateway",
			providerClass: "gateway",
			capabilities: async () => [],
			dispose: async () => {},
			execute: async () => Result.err(new FoundationError("tool_guard_denied", "not exercised")),
		};
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
		} finally {
			await controller.shutdown();
		}
	});
});
