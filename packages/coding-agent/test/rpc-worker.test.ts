import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, FoundationError, Result } from "@aos-agent/agent-core";
import type { Model } from "@aos-agent/ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { createExtensionRuntime } from "../src/core/extensions/loader.ts";
import type { ModelRuntime } from "../src/core/model-runtime.ts";
import type { ResourceLoader } from "../src/core/resource-loader.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import type { WorkerLifecycleStatusV1, WorkerRecordV1 } from "../src/core/worker.ts";
import { RpcHostController, type RpcWorkerRegistry } from "../src/modes/rpc/rpc-host.ts";
import type { RpcCommand, RpcWorkerRecord, RpcWorkerResponse } from "../src/modes/rpc/rpc-types.ts";

vi.mock("@aos-agent/ai/compat", () => ({
	clampThinkingLevel: (level: unknown) => level,
	cleanupSessionResources: () => {},
	getSupportedThinkingLevels: () => ["off"],
	isContextOverflow: () => false,
	isRecoverableLength: () => false,
	isRetryableAssistantError: () => false,
	modelsAreEqual: () => false,
	resetApiProviders: () => {},
	streamSimple: async () => {
		throw new Error("streamSimple is not exercised by the Worker RPC harness");
	},
}));

vi.mock("@aos-agent/ai/providers/all", () => ({}));

const TEST_MODEL: Model<"anthropic-messages"> = {
	id: "claude-sonnet-4-5",
	name: "Claude Sonnet 4.5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: false,
	input: [],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200000,
	maxTokens: 64000,
};

function testResourceLoader(): ResourceLoader {
	return {
		getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getContextSources: () => ({ contextSources: [] }),
		toContextSourceInputs: () => [],
		getSystemPrompt: () => undefined,
		getSystemPromptSource: () => undefined,
		getAppendSystemPrompt: () => [],
		getAppendSystemPromptSources: () => [],
		extendResources: () => {},
		reload: async () => {},
	};
}

async function createHarness(workerRegistry?: (session: AgentSession) => RpcWorkerRegistry | undefined): Promise<{
	controller: RpcHostController;
	runtimeHost: AgentSessionRuntime;
	cleanup: () => Promise<void>;
}> {
	const tempDir = join(tmpdir(), `aos-rpc-worker-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tempDir, { recursive: true });
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model: TEST_MODEL, systemPrompt: "Test", tools: [] },
		streamFn: () => {
			throw new Error("The Worker RPC harness does not start model requests");
		},
	});
	const modelRuntime = {
		hasConfiguredAuth: () => true,
		checkAuth: async () => ({ type: "api_key", key: "test-key" }),
		isUsingOAuth: () => false,
		getAuth: async () => ({ type: "api_key", key: "test-key" }),
	} as unknown as ModelRuntime;
	const session = new AgentSession({
		agent,
		sessionManager: SessionManager.create(tempDir),
		settingsManager: SettingsManager.create(tempDir, tempDir),
		cwd: tempDir,
		modelRuntime,
		resourceLoader: testResourceLoader(),
	});
	const runtimeHost = {
		session,
		newSession: vi.fn(async () => ({ cancelled: true })),
		switchSession: vi.fn(async () => ({ cancelled: true })),
		fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
		dispose: vi.fn(async () => {}),
		setRebindSession: vi.fn(),
	} as unknown as AgentSessionRuntime;
	const controller = new RpcHostController(runtimeHost, {
		...(workerRegistry === undefined ? {} : { workerRegistry }),
	});
	await controller.start();
	return {
		controller,
		runtimeHost,
		cleanup: async () => {
			await controller.shutdown();
			await session.dispose();
			if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
		},
	};
}

function workerRecord(input: {
	workerId: string;
	sessionId: string;
	status?: WorkerLifecycleStatusV1;
	runId?: string;
	createdAt?: string;
}): WorkerRecordV1 {
	const status = input.status ?? "lost";
	const createdAt = input.createdAt ?? "2026-08-21T00:00:00.000Z";
	const readyAt = "2026-08-21T00:00:01.000Z";
	const endedAt = "2026-08-21T00:00:02.000Z";
	const common = {
		schemaVersion: 1 as const,
		workerId: input.workerId,
		providerId: "sandbox-worker",
		sessionId: input.sessionId,
		laneId: "main",
		...(input.runId === undefined ? {} : { runId: input.runId }),
		profileId: "local-worker",
		createdAt,
	};
	switch (status) {
		case "new":
			return { ...common, status, revision: 0 };
		case "starting":
			return { ...common, status, revision: 1 };
		case "ready":
			return { ...common, status, revision: 2, readyAt };
		case "running":
			return { ...common, status, revision: 3, readyAt, activeOperationId: `operation-${input.workerId}` };
		case "cancelling":
			return { ...common, status, revision: 4, readyAt };
		case "completed":
			return { ...common, status, revision: 4, readyAt, endedAt, receiptId: `receipt-${input.workerId}` };
		case "cancelled":
			return { ...common, status, revision: 5, readyAt, endedAt, receiptId: `receipt-${input.workerId}` };
		case "failed":
			return { ...common, status, revision: 4, endedAt };
		case "lost":
			return { ...common, status, revision: 4, endedAt };
		case "reclaiming":
			return { ...common, status, revision: 5, endedAt };
		case "reclaimed":
			return { ...common, status, revision: 6, endedAt };
		case "reclaim_unknown":
			return { ...common, status, revision: 6, endedAt };
	}
}

function asWorkerResponse(response: unknown): RpcWorkerResponse {
	return response as RpcWorkerResponse;
}

function successfulWorker(response: RpcWorkerResponse): RpcWorkerRecord {
	if (!response.success || response.command === "worker.list")
		throw new Error("Expected a successful Worker record response");
	return response.data.worker;
}

function expectSafeWorker(worker: RpcWorkerRecord): void {
	const serialized = JSON.stringify(worker);
	for (const forbidden of [
		"receipt",
		"pid",
		"executable",
		"argv",
		"cwd",
		"path",
		"env",
		"stdout",
		"stderr",
		"prompt",
		"secret",
		"token",
		"header",
		"raw",
		"frame",
		"vm",
	]) {
		expect(serialized.toLowerCase()).not.toContain(forbidden);
	}
}

describe("RpcHostController Worker management", () => {
	afterEach(() => vi.restoreAllMocks());

	it("advertises additive commands and defaults to no Worker authority", async () => {
		const harness = await createHarness();
		try {
			expect(await harness.controller.dispatch({ type: "worker.list" })).toMatchObject({
				command: "worker.list",
				success: false,
				error: { code: "host_not_initialized" },
			});
			const initialized = await harness.controller.dispatch({ type: "initialize", protocolVersion: 1 });
			expect(initialized).toMatchObject({
				command: "initialize",
				success: true,
				data: { workerCommands: ["worker.get", "worker.list", "worker.reclaim"] },
			});
			expect(await harness.controller.dispatch({ type: "worker.list" })).toEqual({
				id: undefined,
				type: "response",
				command: "worker.list",
				success: true,
				data: { workers: [], truncated: false },
			});
			expect(await harness.controller.dispatch({ type: "worker.get", workerId: "missing" })).toMatchObject({
				success: false,
				error: { code: "worker_not_found" },
			});
			expect(await harness.controller.dispatch({ type: "worker.reclaim", workerId: "missing" })).toMatchObject({
				success: false,
				error: { code: "worker_unavailable" },
			});
		} finally {
			await harness.cleanup();
		}
	});

	it("enforces current-Session ownership and projects only safe exact fields", async () => {
		let currentSessionId = "";
		const records = new Map<string, WorkerRecordV1>();
		const registry: RpcWorkerRegistry = {
			getWorkerRecord: (workerId) => records.get(workerId),
			listWorkerRecords: () => [...records.values()],
			reclaimWorker: async (workerId) => Result.ok(records.get(workerId) as WorkerRecordV1),
		};
		const resolver = vi.fn((session: AgentSession) => {
			currentSessionId = session.sessionId;
			return registry;
		});
		const harness = await createHarness(resolver);
		try {
			currentSessionId = harness.runtimeHost.session.sessionId;
			records.set("owned", workerRecord({ workerId: "owned", sessionId: currentSessionId, status: "completed" }));
			records.set("foreign", workerRecord({ workerId: "foreign", sessionId: "other-session" }));
			await harness.controller.dispatch({ type: "initialize", protocolVersion: 1 });
			const listed = asWorkerResponse(await harness.controller.dispatch({ type: "worker.list" }));
			expect(listed).toMatchObject({ success: true, data: { workers: [{ workerId: "owned" }] } });
			if (!listed.success || listed.command !== "worker.list") throw new Error("Expected Worker list success");
			expect(listed.data.workers).toHaveLength(1);
			expectSafeWorker(listed.data.workers[0] as RpcWorkerRecord);

			const got = asWorkerResponse(await harness.controller.dispatch({ type: "worker.get", workerId: "owned" }));
			const worker = successfulWorker(got);
			expect(Object.keys(worker).sort()).toEqual(
				[
					"createdAt",
					"endedAt",
					"laneId",
					"profileId",
					"providerId",
					"readyAt",
					"revision",
					"schemaVersion",
					"sessionId",
					"status",
					"workerId",
				].sort(),
			);
			expectSafeWorker(worker);
			expect(await harness.controller.dispatch({ type: "worker.get", workerId: "foreign" })).toMatchObject({
				success: false,
				error: { code: "worker_not_found" },
			});
			expect(resolver).toHaveBeenCalledWith(harness.runtimeHost.session);
		} finally {
			await harness.cleanup();
		}
	});

	it("applies stable ordering, filtering, limits, and cursor pagination", async () => {
		const records: WorkerRecordV1[] = [];
		const registry: RpcWorkerRegistry = {
			getWorkerRecord: (workerId) => records.find((record) => record.workerId === workerId),
			listWorkerRecords: () => records,
			reclaimWorker: async (workerId) =>
				Result.ok(records.find((record) => record.workerId === workerId) as WorkerRecordV1),
		};
		const harness = await createHarness(() => registry);
		try {
			const sessionId = harness.runtimeHost.session.sessionId;
			records.push(
				workerRecord({
					workerId: "worker-b",
					sessionId,
					status: "completed",
					runId: "run-1",
					createdAt: "2026-08-21T00:00:01.000Z",
				}),
				workerRecord({
					workerId: "worker-a",
					sessionId,
					status: "lost",
					runId: "run-1",
					createdAt: "2026-08-21T00:00:00.000Z",
				}),
				workerRecord({
					workerId: "worker-c",
					sessionId,
					status: "lost",
					runId: "run-2",
					createdAt: "2026-08-21T00:00:02.000Z",
				}),
			);
			await harness.controller.dispatch({ type: "initialize", protocolVersion: 1 });
			const first = asWorkerResponse(await harness.controller.dispatch({ type: "worker.list", limit: 1 }));
			expect(first).toMatchObject({
				success: true,
				data: { workers: [{ workerId: "worker-a" }], truncated: true, nextCursor: "worker-a" },
			});
			const second = asWorkerResponse(
				await harness.controller.dispatch({ type: "worker.list", limit: 1, cursor: "worker-a" }),
			);
			expect(second).toMatchObject({
				success: true,
				data: { workers: [{ workerId: "worker-b" }], truncated: true, nextCursor: "worker-b" },
			});
			expect(
				await harness.controller.dispatch({ type: "worker.list", runId: "run-1", status: "lost" }),
			).toMatchObject({
				success: true,
				data: { workers: [{ workerId: "worker-a" }], truncated: false },
			});
			for (const command of [
				{ type: "worker.list", limit: 0 },
				{ type: "worker.list", limit: 101 },
				{ type: "worker.list", cursor: "unknown" },
				{ type: "worker.list", status: "unknown" },
				{ type: "worker.list", extra: true },
			]) {
				expect(await harness.controller.dispatch(command as unknown as RpcCommand)).toMatchObject({
					success: false,
					error: { code: "worker_invalid" },
				});
			}
		} finally {
			await harness.cleanup();
		}
	});

	it("reclaims only owned terminal Workers and keeps repeated reclaim idempotent", async () => {
		const records = new Map<string, WorkerRecordV1>();
		const reclaimWorker = vi.fn(async (workerId: string) => {
			const existing = records.get(workerId);
			if (existing === undefined) return Result.err(new FoundationError("worker_not_found", "raw secret not found"));
			if (existing.status === "reclaimed" || existing.status === "reclaim_unknown") return Result.ok(existing);
			const reclaimed = { ...existing, status: "reclaimed" as const, revision: existing.revision + 1 };
			records.set(workerId, reclaimed);
			return Result.ok(reclaimed);
		});
		const registry: RpcWorkerRegistry = {
			getWorkerRecord: (workerId) => records.get(workerId),
			listWorkerRecords: () => [...records.values()],
			reclaimWorker,
		};
		const harness = await createHarness(() => registry);
		try {
			const sessionId = harness.runtimeHost.session.sessionId;
			records.set("terminal", workerRecord({ workerId: "terminal", sessionId, status: "lost" }));
			records.set("running", workerRecord({ workerId: "running", sessionId, status: "running" }));
			records.set("foreign", workerRecord({ workerId: "foreign", sessionId: "other-session", status: "lost" }));
			records.set("unknown", workerRecord({ workerId: "unknown", sessionId, status: "reclaim_unknown" }));
			await harness.controller.dispatch({ type: "initialize", protocolVersion: 1 });

			expect(await harness.controller.dispatch({ type: "worker.reclaim", workerId: "running" })).toMatchObject({
				success: false,
				error: { code: "worker_conflict" },
			});
			expect(reclaimWorker).not.toHaveBeenCalled();
			expect(await harness.controller.dispatch({ type: "worker.reclaim", workerId: "foreign" })).toMatchObject({
				success: false,
				error: { code: "worker_not_found" },
			});
			expect(await harness.controller.dispatch({ type: "worker.reclaim", workerId: "missing" })).toMatchObject({
				success: false,
				error: { code: "worker_not_found" },
			});

			const first = asWorkerResponse(
				await harness.controller.dispatch({ type: "worker.reclaim", workerId: "terminal" }),
			);
			expect(first).toMatchObject({ success: true, data: { idempotent: false, worker: { status: "reclaimed" } } });
			const repeated = asWorkerResponse(
				await harness.controller.dispatch({ type: "worker.reclaim", workerId: "terminal" }),
			);
			expect(repeated).toMatchObject({ success: true, data: { idempotent: true, worker: { status: "reclaimed" } } });
			expect(reclaimWorker).toHaveBeenCalledTimes(2);
			expectSafeWorker(successfulWorker(repeated));
			expect(await harness.controller.dispatch({ type: "worker.reclaim", workerId: "unknown" })).toMatchObject({
				success: true,
				data: { idempotent: true, worker: { status: "reclaim_unknown" } },
			});

			await harness.controller.detachTransport();
			expect(reclaimWorker).toHaveBeenCalledTimes(3);
		} finally {
			await harness.cleanup();
		}
		expect(reclaimWorker).toHaveBeenCalledTimes(3);
	});

	it("fails closed on unsafe registry data, stable reclaim errors, and unknown commands", async () => {
		let unsafe: WorkerRecordV1 | undefined;
		const registry: RpcWorkerRegistry = {
			getWorkerRecord: () => unsafe,
			listWorkerRecords: () => (unsafe === undefined ? [] : [unsafe]),
			reclaimWorker: async () =>
				Result.err(new FoundationError("worker_reclaim_failed", "secret=provider-token C:\\private\\worker.ts")),
		};
		const harness = await createHarness(() => registry);
		try {
			const sessionId = harness.runtimeHost.session.sessionId;
			unsafe = {
				...workerRecord({ workerId: "unsafe", sessionId, status: "lost" }),
				providerRawError: "secret=provider-token C:\\private\\worker.ts",
			} as WorkerRecordV1;
			await harness.controller.dispatch({ type: "initialize", protocolVersion: 1 });
			for (const command of [
				{ type: "worker.get", workerId: "unsafe" },
				{ type: "worker.list" },
				{ type: "worker.reclaim", workerId: "unsafe" },
			]) {
				const response = await harness.controller.dispatch(command as RpcCommand);
				expect(response).toMatchObject({ success: false, error: { code: "worker_invalid" } });
				expect(JSON.stringify(response)).not.toContain("provider-token");
			}

			unsafe = workerRecord({ workerId: "safe", sessionId, status: "lost" });
			const failed = await harness.controller.dispatch({ type: "worker.reclaim", workerId: "safe" });
			expect(failed).toMatchObject({
				success: false,
				error: { code: "worker_reclaim_failed", message: "The Worker reclaim outcome is unknown." },
			});
			expect(JSON.stringify(failed)).not.toContain("provider-token");

			for (const type of ["worker.start", "worker.cancel", "worker.unknown"]) {
				expect(await harness.controller.dispatch({ type } as unknown as RpcCommand)).toEqual({
					id: undefined,
					type: "response",
					command: type,
					success: false,
					error: `Unknown command: ${type}`,
				});
			}
		} finally {
			await harness.cleanup();
		}
	});
});
