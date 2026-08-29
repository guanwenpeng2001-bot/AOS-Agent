import { existsSync, mkdirSync, rmSync } from "node:fs";
import { once } from "node:events";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Writable } from "node:stream";
import { Agent, FoundationError, Result } from "@aos-agent/agent-core";
import { createModels, type Model, type Models } from "@aos-agent/ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../../src/core/session/agent-session.ts";
import type { AgentSessionRuntime } from "../../src/core/session/runtime.ts";
import { createExtensionRuntime } from "../../src/core/extensions/loader.ts";
import type { ModelRuntime } from "../../src/core/runtime/model-runtime.ts";
import type { ResourceLoader } from "../../src/core/runtime/resource-loader.ts";
import { SessionManager } from "../../src/core/session/manager.ts";
import { SettingsManager } from "../../src/core/runtime/settings-manager.ts";
import type { WorkerLifecycleStatus, WorkerRecord } from "../../src/core/worker/lifecycle.ts";
import {
	createAgentRuntimeCompositionFactory,
	createAgentSession,
	createWorkerSandboxComposition,
} from "../../src/index.ts";
import type { WorkerSandboxProvider } from "../../src/core/worker/sandbox-provider.ts";
import { attachJsonlLineReader } from "../../src/modes/rpc/jsonl.ts";
import { RpcHostController, type RpcWorkerRegistry } from "../../src/modes/rpc/rpc-host.ts";
import { runRpcMode } from "../../src/modes/rpc/rpc-mode.ts";
import type { TcpRpcAddress } from "../../src/modes/rpc/rpc-transport-address.ts";
import type { RpcCommand, RpcWorkerRecord, RpcWorkerResponse } from "../../src/modes/rpc/rpc-types.ts";

const CHILD_ENTRY = fileURLToPath(new URL("../fixtures/fake-worker-child.ts", import.meta.url));

const rpcIo = vi.hoisted(() => ({
	outputLines: [] as string[],
	lineHandler: undefined as ((line: string) => void) | undefined,
}));

const TestJsonlFrameError = vi.hoisted(() => {
	class HoistedTestJsonlFrameError extends Error {
		readonly frameBytes = 0;
		readonly maxFrameBytes = 0;
	}
	return HoistedTestJsonlFrameError;
});

function attachTestJsonlLineReader(stream: NodeJS.ReadableStream, onLine: (line: string) => void): () => void {
	if (stream === process.stdin) {
		rpcIo.lineHandler = onLine;
		return () => {};
	}
	let buffer = "";
	const onData = (chunk: string | Buffer): void => {
		buffer += chunk.toString();
		let newlineIndex = buffer.indexOf("\n");
		while (newlineIndex !== -1) {
			const line = buffer.slice(0, newlineIndex);
			buffer = buffer.slice(newlineIndex + 1);
			onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
			newlineIndex = buffer.indexOf("\n");
		}
	};
	stream.on("data", onData);
	return () => stream.off("data", onData);
}

function createTestJsonlLineWriter(stream: NodeJS.ReadableStream) {
	const writable = stream as unknown as Writable;
	return {
		write: (value: unknown): Promise<void> =>
			new Promise<void>((resolve, reject) => {
				writable.write(`${JSON.stringify(value)}\n`, "utf8", (error?: Error | null) => {
					if (error) reject(error);
					else resolve();
				});
			}),
		close: (): Promise<void> => new Promise<void>((resolve) => writable.end(resolve)),
		detach: (): void => {},
	};
}

vi.mock("../../src/core/runtime/output-guard.js", () => ({
	flushRawStdout: vi.fn(async () => {}),
	takeOverStdout: vi.fn(),
	waitForRawStdoutBackpressure: vi.fn(async () => {}),
	writeRawStdout: (line: string) => rpcIo.outputLines.push(line),
}));

vi.mock("../../src/modes/interactive/theme/theme.js", () => ({ theme: {} }));

vi.mock("../../src/modes/rpc/jsonl.js", () => ({
	attachJsonlLineReader: vi.fn(attachTestJsonlLineReader),
	createJsonlLineWriter: createTestJsonlLineWriter,
	DEFAULT_MAX_JSONL_FRAME_BYTES: 1024 * 1024,
	JsonlFrameError: TestJsonlFrameError,
	serializeJsonLine: (value: unknown) => `${JSON.stringify(value)}\n`,
}));

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

async function createHarness(
	workerRegistry?: (session: AgentSession) => RpcWorkerRegistry | undefined,
): Promise<{
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
		setPrepareSessionRebind: vi.fn(),
	} as unknown as AgentSessionRuntime;
	if (workerRegistry !== undefined) {
		vi.spyOn(session, "getWorkerRegistry").mockImplementation(() => workerRegistry(session));
	}
	const controller = new RpcHostController(runtimeHost);
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
	status?: WorkerLifecycleStatus;
	runId?: string;
	createdAt?: string;
}): WorkerRecord {
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

function testModels(): Models {
	const base = createModels();
	const models = Object.create(base) as Models;
	models.getModel = (provider, id) =>
		provider === TEST_MODEL.provider && id === TEST_MODEL.id ? TEST_MODEL : base.getModel(provider, id);
	return models;
}

async function createCanonicalWorkerSession(
	tempDir: string,
	workerId: string,
): Promise<{ session: AgentSession; provider: WorkerSandboxProvider }> {
	mkdirSync(tempDir, { recursive: true });
	const sessionManager = SessionManager.create(tempDir);
	const models = testModels();
	const modelRuntime = Object.assign(models, {
		getModels: () => [TEST_MODEL],
		getAvailableSnapshot: () => [TEST_MODEL],
		refresh: async () => ({}),
		hasConfiguredAuth: () => true,
		checkAuth: async () => ({ type: "api_key", key: "test-key" }),
		isUsingOAuth: () => false,
		getAuth: async () => ({ type: "api_key", key: "test-key" }),
	}) as unknown as ModelRuntime;
	const composition = createWorkerSandboxComposition({
		providerId: "sandbox-worker",
		profile: {
			profileId: "local-worker",
			profileRevision: 1,
			trusted: true,
			supervisor: {
				executable: process.execPath,
				entrypoint: CHILD_ENTRY,
				profileId: "local-worker",
				profileRevision: 1,
				capabilities: [],
				readyTimeoutMs: 2_000,
				heartbeatTimeoutMs: 2_000,
				cancelTimeoutMs: 120,
				terminateTimeoutMs: 500,
			},
		},
		resolvePreflight: () => {
			throw new Error("Worker execution is not exercised by this RPC test");
		},
	});
	const restored = composition.provider.restoreWorkerFacts({
		records: [workerRecord({ workerId, sessionId: sessionManager.getSessionId(), status: "lost" })],
	});
	if (!restored.ok) throw restored.error;
	const created = await createAgentSession({
		cwd: tempDir,
		agentDir: tempDir,
		model: TEST_MODEL,
		modelRuntime,
		sessionManager,
		settingsManager: SettingsManager.create(tempDir, tempDir),
		resourceLoader: testResourceLoader(),
		noTools: "all",
		runtimeComposition: createAgentRuntimeCompositionFactory({
			trustedWorkerSandboxFactory: () => composition,
		}),
	});
	return { session: created.session, provider: composition.provider };
}

async function createProductionRuntimeHarness(): Promise<{
	runtimeHost: AgentSessionRuntime;
	initial: Awaited<ReturnType<typeof createCanonicalWorkerSession>>;
	replacement: Awaited<ReturnType<typeof createCanonicalWorkerSession>>;
	cleanup: () => Promise<void>;
}> {
	const tempDir = join(tmpdir(), `aos-rpc-worker-production-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	const initial = await createCanonicalWorkerSession(join(tempDir, "initial"), "worker-initial");
	const replacement = await createCanonicalWorkerSession(join(tempDir, "replacement"), "worker-replacement");
	let currentSession = initial.session;
	let prepareRebindSession: Parameters<AgentSessionRuntime["setPrepareSessionRebind"]>[0];
	const replaceSession = async (): Promise<void> => {
		const previousSession = currentSession;
		const preparedRebind = await prepareRebindSession?.(replacement.session, previousSession);
		currentSession = replacement.session;
		preparedRebind?.commit();
		await preparedRebind?.disposePrevious?.(AbortSignal.timeout(5_000));
		await previousSession.dispose();
		await preparedRebind?.activate?.();
	};
	const runtimeHost = {
		get session(): AgentSession {
			return currentSession;
		},
		newSession: vi.fn(async () => {
			await replaceSession();
			return { cancelled: false };
		}),
		switchSession: vi.fn(async () => ({ cancelled: true })),
		fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
		dispose: vi.fn(async () => {}),
		setPrepareSessionRebind: vi.fn((callback) => {
			prepareRebindSession = callback;
		}),
	} as unknown as AgentSessionRuntime;
	return {
		runtimeHost,
		initial,
		replacement,
		cleanup: async () => {
			await Promise.all([initial.session.dispose(), replacement.session.dispose()]);
			if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
		},
	};
}

type ParsedRecord = Record<string, unknown>;

function parseOutputLines(): ParsedRecord[] {
	return rpcIo.outputLines
		.flatMap((line) => line.split("\n"))
		.filter((line) => line.length > 0)
		.map((line) => JSON.parse(line) as ParsedRecord);
}

async function getAvailablePort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen({ host: "127.0.0.1", port: 0 }, resolve);
	});
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("Test listener did not expose a TCP port");
	await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	return address.port;
}

async function connectTcpPeer(address: TcpRpcAddress): Promise<{ socket: Socket; records: ParsedRecord[] }> {
	const socket = createConnection({ host: address.host, port: address.port });
	await once(socket, "connect");
	const records: ParsedRecord[] = [];
	attachJsonlLineReader(socket, (line) => records.push(JSON.parse(line) as ParsedRecord));
	return { socket, records };
}

function writeTcpRecord(socket: Socket, value: unknown): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		socket.write(`${JSON.stringify(value)}\n`, (error) => (error ? reject(error) : resolve()));
	});
}

async function waitForResponse(records: ParsedRecord[], id: string): Promise<ParsedRecord> {
	let response: ParsedRecord | undefined;
	await vi.waitFor(() => {
		response = records.find((record) => record.type === "response" && record.id === id);
		expect(response).toBeDefined();
	});
	return response!;
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
	afterEach(() => {
		rpcIo.outputLines = [];
		rpcIo.lineHandler = undefined;
		vi.restoreAllMocks();
	});

	it("omits Worker capabilities when no registry is available", async () => {
		const harness = await createHarness();
		try {
			expect(harness.runtimeHost.session.getWorkerRegistry()).toBeUndefined();
			expect(await harness.controller.dispatch({ type: "worker.list" })).toMatchObject({
				command: "worker.list",
				success: false,
				error: { code: "host_not_initialized" },
			});
			const initialized = await harness.controller.dispatch({ type: "initialize", protocolVersion: 1 });
			expect(initialized).toMatchObject({
				command: "initialize",
				success: true,
			});
			if (initialized === undefined || initialized.command !== "initialize" || !initialized.success) {
				throw new Error("Expected initialize response");
			}
			expect(initialized.data).not.toHaveProperty("workerCommands");
			expect(await harness.controller.dispatch({ type: "worker.list" })).toMatchObject({
				success: false,
				error: { code: "worker_unavailable" },
			});
			expect(await harness.controller.dispatch({ type: "worker.get", workerId: "missing" })).toMatchObject({
				success: false,
				error: { code: "worker_unavailable" },
			});
			expect(await harness.controller.dispatch({ type: "worker.reclaim", workerId: "missing" })).toMatchObject({
				success: false,
				error: { code: "worker_unavailable" },
			});
		} finally {
			await harness.cleanup();
		}
	});

	it("wires the current Session control-plane registry through stdio RPC", async () => {
		const harness = await createProductionRuntimeHarness();
		const signalNames: NodeJS.Signals[] = process.platform === "win32" ? ["SIGTERM"] : ["SIGTERM", "SIGHUP"];
		const signalListenersBefore = new Map(signalNames.map((signal) => [signal, new Set(process.listeners(signal))]));
		const stdinEndListenersBefore = new Set(process.stdin.listeners("end"));
		try {
			expect(harness.runtimeHost.session.getWorkerRegistry()).toBeDefined();
			const listWorkerRecords = vi.spyOn(harness.initial.provider, "listWorkerRecords");
			void runRpcMode(harness.runtimeHost);
			await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());

			rpcIo.lineHandler!(JSON.stringify({ id: "initialize", type: "initialize", protocolVersion: 1 }));
			await vi.waitFor(() => expect(rpcIo.outputLines.join("\n")).toContain('"id":"initialize"'));
			for (const id of ["list-1", "list-2"]) {
				rpcIo.lineHandler!(JSON.stringify({ id, type: "worker.list" }));
				await vi.waitFor(() => expect(rpcIo.outputLines.join("\n")).toContain(`"id":"${id}"`));
			}

			expect(listWorkerRecords).toHaveBeenCalledTimes(2);
			for (const id of ["list-1", "list-2"]) {
				expect(parseOutputLines().find((record) => record.id === id)).toMatchObject({
					success: true,
					data: { workers: [{ workerId: "worker-initial" }] },
				});
			}
		} finally {
			for (const [signal, listenersBefore] of signalListenersBefore) {
				for (const listener of process.listeners(signal)) {
					if (!listenersBefore.has(listener)) process.off(signal, listener as (...args: unknown[]) => void);
				}
			}
			for (const listener of process.stdin.listeners("end")) {
				if (!stdinEndListenersBefore.has(listener)) process.stdin.off("end", listener as (...args: unknown[]) => void);
			}
			await harness.cleanup();
		}
	});

	it("uses only the replacement Session control-plane registry through TCP RPC", async () => {
		const harness = await createProductionRuntimeHarness();
		const signalNames: NodeJS.Signals[] = process.platform === "win32" ? ["SIGTERM"] : ["SIGTERM", "SIGHUP"];
		const signalListenersBefore = new Map(signalNames.map((signal) => [signal, new Set(process.listeners(signal))]));
		const initialList = vi.spyOn(harness.initial.provider, "listWorkerRecords");
		const initialGet = vi.spyOn(harness.initial.provider, "getWorkerRecord");
		const replacementList = vi.spyOn(harness.replacement.provider, "listWorkerRecords");
		const replacementGet = vi.spyOn(harness.replacement.provider, "getWorkerRecord");
		const port = await getAvailablePort();
		const diagnostics = vi.spyOn(console, "error").mockImplementation(() => {});
		let exitCode: number | undefined;
		const exit = vi.spyOn(process, "exit").mockImplementation(((code?: string | number | null) => {
			exitCode = typeof code === "number" ? code : 0;
			return undefined as never;
		}) as typeof process.exit);
		let peer: Awaited<ReturnType<typeof connectTcpPeer>> | undefined;
		try {
			expect(harness.initial.session.getWorkerRegistry()).toBeDefined();
			expect(harness.replacement.session.getWorkerRegistry()).toBeDefined();
			void runRpcMode(harness.runtimeHost, {
				listen: { transport: "tcp", host: "127.0.0.1", port },
			});
			await vi.waitFor(() => {
				expect(diagnostics.mock.calls.flat().join("\n")).toContain(`RPC TCP listening on tcp://127.0.0.1:${port}`);
			});
			peer = await connectTcpPeer({ transport: "tcp", host: "127.0.0.1", port });

			await writeTcpRecord(peer.socket, { id: "replace", type: "new_session" });
			expect(await waitForResponse(peer.records, "replace")).toMatchObject({ success: true });
			expect(harness.runtimeHost.session).toBe(harness.replacement.session);

			await writeTcpRecord(peer.socket, { id: "initialize", type: "initialize", protocolVersion: 1 });
			await waitForResponse(peer.records, "initialize");
			await writeTcpRecord(peer.socket, { id: "replacement-list", type: "worker.list" });
			expect(await waitForResponse(peer.records, "replacement-list")).toMatchObject({
				success: true,
				data: { workers: [{ workerId: "worker-replacement" }] },
			});
			await writeTcpRecord(peer.socket, {
				id: "replacement-worker",
				type: "worker.get",
				workerId: "worker-replacement",
			});
			expect(await waitForResponse(peer.records, "replacement-worker")).toMatchObject({
				success: true,
				data: { worker: { workerId: "worker-replacement" } },
			});
			await writeTcpRecord(peer.socket, { id: "old-worker", type: "worker.get", workerId: "worker-initial" });
			expect(await waitForResponse(peer.records, "old-worker")).toMatchObject({
				success: false,
				error: { code: "worker_not_found" },
			});

			expect(harness.runtimeHost.newSession).toHaveBeenCalledTimes(1);
			expect(initialList).not.toHaveBeenCalled();
			expect(initialGet).not.toHaveBeenCalled();
			expect(replacementList).toHaveBeenCalledTimes(1);
			expect(replacementGet).toHaveBeenCalledTimes(2);
			expect(rpcIo.outputLines).toEqual([]);
		} finally {
			peer?.socket.destroy();
			process.emit("SIGTERM");
			await vi.waitFor(() => expect(exitCode).toBeDefined());
			exit.mockRestore();
			diagnostics.mockRestore();
			for (const [signal, listenersBefore] of signalListenersBefore) {
				for (const listener of process.listeners(signal)) {
					if (!listenersBefore.has(listener)) process.off(signal, listener as (...args: unknown[]) => void);
				}
			}
			await harness.cleanup();
		}
	});

	it("enforces current-Session ownership and projects only safe exact fields", async () => {
		let currentSessionId = "";
		const records = new Map<string, WorkerRecord>();
		const registry: RpcWorkerRegistry = {
			getWorkerRecord: (workerId) => records.get(workerId),
			listWorkerRecords: () => [...records.values()],
			reclaimWorker: async (workerId) => Result.ok(records.get(workerId) as WorkerRecord),
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
		const records: WorkerRecord[] = [];
		const registry: RpcWorkerRegistry = {
			getWorkerRecord: (workerId) => records.find((record) => record.workerId === workerId),
			listWorkerRecords: () => records,
			reclaimWorker: async (workerId) =>
				Result.ok(records.find((record) => record.workerId === workerId) as WorkerRecord),
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
		const records = new Map<string, WorkerRecord>();
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
		let unsafe: WorkerRecord | undefined;
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
			} as WorkerRecord;
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

	it("fails closed on malformed IDs, registry records, and reclaim outcomes", async () => {
		const throwingHarness = await createHarness(() => {
			throw new Error("registry resolver failed");
		});
		try {
			await throwingHarness.controller.dispatch({ type: "initialize", protocolVersion: 1 });
			const malformedId = await throwingHarness.controller.dispatch({
				type: "worker.get",
				workerId: "worker",
				id: 7,
			} as unknown as RpcCommand);
			expect(malformedId).toMatchObject({
				id: undefined,
				success: false,
				error: { code: "worker_invalid" },
			});
			expect(JSON.stringify(malformedId)).not.toContain("7");
			expect(await throwingHarness.controller.dispatch({ type: "worker.list" })).toMatchObject({
				success: false,
				error: { code: "worker_unavailable" },
			});
		} finally {
			await throwingHarness.cleanup();
		}

		let getRecord: unknown = null;
		let listRecords: unknown = [null];
		const malformedListRegistry: RpcWorkerRegistry = {
			getWorkerRecord: () => getRecord as WorkerRecord | undefined,
			listWorkerRecords: () => listRecords as unknown as readonly WorkerRecord[],
			reclaimWorker: async () => Result.err(new FoundationError("worker_reclaim_failed", "reclaim failed")),
		};
		const listHarness = await createHarness(() => malformedListRegistry);
		try {
			await listHarness.controller.dispatch({ type: "initialize", protocolVersion: 1 });
			expect(await listHarness.controller.dispatch({ type: "worker.get", workerId: "malformed" })).toMatchObject({
				success: false,
				error: { code: "worker_invalid" },
			});
			getRecord = undefined;
			for (const malformed of [null, { records: [] }]) {
				listRecords = malformed;
				expect(await listHarness.controller.dispatch({ type: "worker.list" })).toMatchObject({
					success: false,
					error: { code: "worker_invalid" },
				});
			}
			for (const malformed of [null, { workerId: "malformed" }]) {
				listRecords = [malformed];
				expect(await listHarness.controller.dispatch({ type: "worker.list" })).toMatchObject({
					success: false,
					error: { code: "worker_invalid" },
				});
			}
		} finally {
			await listHarness.cleanup();
		}

		const sessionId = "session-for-reclaim-negatives";
		let currentRecord = workerRecord({ workerId: "owned", sessionId, status: "lost" });
		let reclaimResult: unknown;
		const reclaimRegistry: RpcWorkerRegistry = {
			getWorkerRecord: () => currentRecord,
			listWorkerRecords: () => [],
			reclaimWorker: async () =>
				reclaimResult as Awaited<ReturnType<RpcWorkerRegistry["reclaimWorker"]>>,
		};
		const reclaimHarness = await createHarness(() => reclaimRegistry);
		try {
			const ownedSessionId = reclaimHarness.runtimeHost.session.sessionId;
			await reclaimHarness.controller.dispatch({ type: "initialize", protocolVersion: 1 });
			currentRecord = workerRecord({ workerId: "owned", sessionId: ownedSessionId, status: "lost" });

			for (const malformed of [undefined, null, { ok: true }]) {
				reclaimResult = malformed;
				expect(await reclaimHarness.controller.dispatch({ type: "worker.reclaim", workerId: "owned" })).toMatchObject({
					success: false,
					error: { code: "worker_reclaim_failed" },
				});
			}

			reclaimResult = { ok: false, error: new FoundationError("worker_reclaim_failed", "reclaim failed") };
			expect(await reclaimHarness.controller.dispatch({ type: "worker.reclaim", workerId: "owned" })).toMatchObject({
				success: false,
				error: { code: "worker_reclaim_failed" },
			});

			for (const wrongRecord of [
				workerRecord({ workerId: "other", sessionId: ownedSessionId, status: "reclaimed" }),
				workerRecord({ workerId: "owned", sessionId: "other-session", status: "reclaimed" }),
			]) {
				reclaimResult = { ok: true, value: wrongRecord };
				expect(await reclaimHarness.controller.dispatch({ type: "worker.reclaim", workerId: "owned" })).toMatchObject({
					success: false,
					error: { code: "worker_reclaim_failed" },
				});
			}

			for (const status of ["lost", "completed"] as const) {
				currentRecord = workerRecord({ workerId: "owned", sessionId: ownedSessionId, status });
				reclaimResult = { ok: true, value: currentRecord };
				expect(await reclaimHarness.controller.dispatch({ type: "worker.reclaim", workerId: "owned" })).toMatchObject({
					success: false,
					error: { code: "worker_reclaim_failed" },
				});
			}
		} finally {
			await reclaimHarness.cleanup();
		}
	});
});
