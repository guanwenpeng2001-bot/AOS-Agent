import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerFauxProvider } from "@aos-agent/ai/compat";
import {
	createAgentSession,
	createAgentSessionFromServices,
	createAgentSessionServices,
	createAgentRuntimeCompositionFactory,
	createTrustedWorkerSandboxComposition,
	type AgentRuntimeCompositionFactory,
} from "../src/index.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { RpcHostController } from "../src/modes/rpc/rpc-host.ts";

const CHILD_ENTRY = fileURLToPath(new URL("./fixtures/fake-worker-child.ts", import.meta.url));

type SessionCleanup = () => Promise<void>;

async function createSdkSession(
	runtimeComposition?: AgentRuntimeCompositionFactory,
): Promise<{ session: Awaited<ReturnType<typeof createAgentSession>>["session"]; cleanup: SessionCleanup }> {
	const cwd = mkdtempSync(join(tmpdir(), "aos-sdk-worker-composition-"));
	const faux = registerFauxProvider();
	const model = faux.getModel();
	const authStorage = AuthStorage.inMemory();
	await authStorage.modify(model.provider, async () => ({ type: "api_key", key: "faux-key" }));
	const modelRuntime = await ModelRuntime.create({ credentials: authStorage, modelsPath: null });
	modelRuntime.registerProvider(model.provider, {
		baseUrl: model.baseUrl,
		api: model.api,
		models: [model],
	});
	const settingsManager = SettingsManager.inMemory();
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir: cwd,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});
	await resourceLoader.reload();
	const created = await createAgentSession({
		cwd,
		agentDir: cwd,
		model,
		modelRuntime,
		resourceLoader,
		settingsManager,
		sessionManager: SessionManager.inMemory(cwd),
		noTools: "all",
		...(runtimeComposition === undefined ? {} : { runtimeComposition }),
	});
	return {
		session: created.session,
		cleanup: async () => {
			created.session.dispose();
			await created.session.waitForDispose();
			faux.unregister();
			rmSync(cwd, { recursive: true, force: true });
		},
	};
}

function createRpcController(session: Awaited<ReturnType<typeof createAgentSession>>["session"]): RpcHostController {
	const runtimeHost = {
		session,
		newSession: async () => ({ cancelled: true }),
		switchSession: async () => ({ cancelled: true }),
		fork: async () => ({ cancelled: true, selectedText: "" }),
		dispose: async () => {},
		setRebindSession: () => {},
	} as unknown as AgentSessionRuntime;
	return new RpcHostController(runtimeHost);
}

function createTestWorkerSandboxComposition() {
	return createTrustedWorkerSandboxComposition({
		providerId: "sandbox-worker",
		profile: {
			profileId: "sdk-production-worker",
			profileRevision: 1,
			trusted: true,
			supervisor: {
				executable: process.execPath,
				entrypoint: CHILD_ENTRY,
				profileId: "sdk-production-worker",
				profileRevision: 1,
				capabilities: ["filesystem.read", "process.spawn"],
				environment: { AOS_SAFE_TEST_MARKER: "1" },
				readyTimeoutMs: 2_000,
				heartbeatTimeoutMs: 2_000,
				cancelTimeoutMs: 120,
				terminateTimeoutMs: 500,
			},
		},
		resolvePreflight: () => {
			throw new Error("Worker execution is not exercised by this composition test");
		},
	});
}

describe("SDK Worker composition", () => {
	const cleanups: SessionCleanup[] = [];

	afterEach(async () => {
		await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
	});

	it("keeps the omitted production state free of Worker authority and RPC commands", async () => {
		const created = await createSdkSession();
		cleanups.push(created.cleanup);
		expect(created.session.getWorkerRegistry()).toBeUndefined();
		const controller = createRpcController(created.session);
		await controller.start();
		try {
			const initialized = await controller.dispatch({ type: "initialize", protocolVersion: 1 });
			expect(initialized).toMatchObject({ success: true });
			if (initialized === undefined || initialized.command !== "initialize" || !initialized.success) {
				throw new Error("Expected initialize response");
			}
			expect(initialized.data).not.toHaveProperty("workerCommands");
			for (const command of [
				{ type: "worker.get" as const, workerId: "missing" },
				{ type: "worker.list" as const },
				{ type: "worker.reclaim" as const, workerId: "missing" },
			]) {
				expect(await controller.dispatch(command)).toMatchObject({ success: false, error: { code: "worker_unavailable" } });
			}
		} finally {
			await controller.shutdown();
		}
	});

	it("rejects an unbranded Worker composition before session setup", async () => {
		const trusted = createTestWorkerSandboxComposition();
		const runtimeComposition = createAgentRuntimeCompositionFactory({
			trustedWorkerSandboxFactory: () => ({ provider: trusted.provider }) as ReturnType<typeof createTestWorkerSandboxComposition>,
		});
		await expect(createAgentSession({ runtimeComposition })).rejects.toThrow("Trusted Worker composition is invalid");
	});

	it("injects the factory provider into the real SDK session and exposes it through RPC", async () => {
		const trusted = createTestWorkerSandboxComposition();
		const created = await createSdkSession(createAgentRuntimeCompositionFactory({
			trustedWorkerSandboxFactory: () => trusted,
		}));
		cleanups.push(created.cleanup);
		const registry = created.session.getWorkerRegistry();
		expect(registry).toBeDefined();
		expect(registry?.listWorkerRecords()).toEqual([]);
		const listWorkerRecords = vi.spyOn(trusted.provider, "listWorkerRecords");
		const controller = createRpcController(created.session);
		await controller.start();
		try {
			const initialized = await controller.dispatch({ type: "initialize", protocolVersion: 1 });
			expect(initialized).toMatchObject({
				success: true,
				data: { workerCommands: ["worker.get", "worker.list", "worker.reclaim"] },
			});
			expect(await controller.dispatch({ type: "worker.list" })).toMatchObject({
				success: true,
				command: "worker.list",
				data: { workers: [], truncated: false },
			});
			expect(listWorkerRecords).toHaveBeenCalledTimes(1);
		} finally {
			await controller.shutdown();
		}
	});

	it("creates isolated providers when two sessions share one services factory", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "aos-sdk-worker-services-"));
		const faux = registerFauxProvider();
		const sessions: Array<Awaited<ReturnType<typeof createAgentSession>>["session"]> = [];
		try {
			const model = faux.getModel();
			const authStorage = AuthStorage.inMemory();
			await authStorage.modify(model.provider, async () => ({ type: "api_key", key: "faux-key" }));
			const modelRuntime = await ModelRuntime.create({ credentials: authStorage, modelsPath: null });
			modelRuntime.registerProvider(model.provider, {
				baseUrl: model.baseUrl,
				api: model.api,
				models: [model],
			});
			const settingsManager = SettingsManager.inMemory();
			const compositions: Array<ReturnType<typeof createTestWorkerSandboxComposition>> = [];
			let factoryCalls = 0;
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
				runtimeComposition: createAgentRuntimeCompositionFactory({
					trustedWorkerSandboxFactory: () => {
						factoryCalls += 1;
						const composition = createTestWorkerSandboxComposition();
						compositions.push(composition);
						return composition;
					},
				}),
			});
			const first = await createAgentSessionFromServices({
				services,
				sessionManager: SessionManager.inMemory(cwd),
				model,
				noTools: "all",
			});
			sessions.push(first.session);
			const second = await createAgentSessionFromServices({
				services,
				sessionManager: SessionManager.inMemory(cwd),
				model,
				noTools: "all",
			});
			sessions.push(second.session);
			expect(factoryCalls).toBe(2);
			expect(compositions[0]?.provider).not.toBe(compositions[1]?.provider);
			const firstRegistry = first.session.getWorkerRegistry();
			const secondRegistry = second.session.getWorkerRegistry();
			expect(firstRegistry).toBeDefined();
			expect(secondRegistry).toBeDefined();
			expect(firstRegistry).not.toBe(secondRegistry);
			const secondList = vi.spyOn(compositions[1]!.provider, "listWorkerRecords");
			first.session.dispose();
			await first.session.waitForDispose();
			expect(secondRegistry?.listWorkerRecords()).toEqual([]);
			expect(secondList).toHaveBeenCalledTimes(1);
		} finally {
			for (const session of sessions) {
				session.dispose();
				await session.waitForDispose();
			}
			faux.unregister();
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
