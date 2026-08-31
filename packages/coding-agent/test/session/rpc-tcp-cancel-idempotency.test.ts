import { existsSync, mkdirSync, rmSync } from "node:fs";
import { once } from "node:events";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@aos-agent/agent-core";
import { type AssistantMessage, type AssistantMessageEvent, EventStream, type Model } from "@aos-agent/ai";
import { describe, expect, it, vi } from "vitest";
import { AgentSession } from "../../src/core/session/agent-session.ts";
import { getAgentCanonicalSession } from "../../src/core/session/facade.ts";
import type { AgentSessionRuntime } from "../../src/core/session/runtime.ts";
import { createExtensionRuntime } from "../../src/core/extensions/loader.ts";
import type { ModelRuntime } from "../../src/core/runtime/model-runtime.ts";
import type { ResourceLoader } from "../../src/core/runtime/resource-loader.ts";
import { RUN_LEDGER_CUSTOM_TYPE } from "../../src/core/session/run-lifecycle.ts";
import { SessionManager, type SessionEntry } from "../../src/core/session/manager.ts";
import { SettingsManager } from "../../src/core/runtime/settings-manager.ts";
import { RpcHostController, type RpcHostOutputRecord, type RpcHostOutputSink } from "../../src/modes/rpc/rpc-host.ts";
import {
	createRpcTransport,
	type RpcTransport,
	type RpcTransportConnection,
} from "../../src/modes/rpc/rpc-transport.ts";
import { attachJsonlLineReader } from "../../src/modes/rpc/jsonl.ts";
import type { RpcCommand } from "../../src/modes/rpc/rpc-types.ts";
import type { TcpRpcAddress } from "../../src/modes/rpc/rpc-transport-address.ts";

vi.mock("../../src/modes/interactive/theme/theme.js", () => ({ theme: {} }));

// agent-session.ts statically imports values from @aos-agent/ai/compat, whose
// entrypoint pulls in a generated catalog that is not required by this harness.
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
		throw new Error("streamSimple is not exercised by the local mock-stream harness");
	},
}));

// loader.ts holds @aos-agent/ai/providers/all only as a virtual-module namespace
// for bundling; an empty mock avoids loading provider factories.
vi.mock("@aos-agent/ai/providers/all", () => ({}));

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

function createAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

const DEFAULT_MODEL: Model<"anthropic-messages"> = {
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

/** Minimal ResourceLoader with no extension or generated-catalog side effects. */
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

type ParsedOutputLine = Record<string, unknown>;

async function createRuntimeHost(options: {
	withAuth: boolean;
	responseDelayMs: number;
}): Promise<{ runtimeHost: AgentSessionRuntime; cleanup: () => Promise<void> }> {
	const tempDir = join(tmpdir(), `aos-rpc-tcp-idempotency-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tempDir, { recursive: true });

	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: {
			model: DEFAULT_MODEL,
			systemPrompt: "Test",
			tools: [],
		},
		streamFn: (_model, _context, _options) => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				stream.push({ type: "start", partial: createAssistantMessage("") });
				setTimeout(() => {
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("done") });
				}, options.responseDelayMs);
			});
			return stream;
		},
	});

	const settingsManager = SettingsManager.create(tempDir, tempDir);
	const modelRuntime = {
		hasConfiguredAuth: () => options.withAuth,
		checkAuth: async () => (options.withAuth ? { type: "api_key", key: "test-key" } : undefined),
		isUsingOAuth: () => false,
		getAuth: async () => ({ type: "api_key", key: "test-key" }),
	} as unknown as ModelRuntime;
	const resourceLoader = testResourceLoader();
	const openSession = (sessionManager: SessionManager): AgentSession =>
		new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRuntime,
			resourceLoader,
		});

	let currentSession = openSession(SessionManager.create(tempDir));
	const runtimeHost = {
		get session(): AgentSession {
			return currentSession;
		},
		set session(next: AgentSession) {
			currentSession = next;
		},
		setPrepareSessionRebind: vi.fn(),
		switchSession: vi.fn(async () => ({ cancelled: true })),
		newSession: vi.fn(async () => ({ cancelled: true })),
		fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
		dispose: vi.fn(async () => {}),
	} as unknown as AgentSessionRuntime;

	return {
		runtimeHost,
		cleanup: async () => {
			try {
				if (currentSession.isStreaming) await currentSession.abort();
			} catch {
				// ignore test cleanup failures
			}
			currentSession.dispose();
			if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
		},
	};
}

async function startInMemoryController(
	options: { withAuth: boolean; responseDelayMs: number },
	outputSink: RpcHostOutputSink,
): Promise<{ controller: RpcHostController; runtimeHost: AgentSessionRuntime; cleanup: () => Promise<void> }> {
	const { runtimeHost, cleanup } = await createRuntimeHost(options);
	const controller = new RpcHostController(runtimeHost, { output: outputSink });
	await controller.start();
	return { controller, runtimeHost, cleanup };
}

interface TcpPeer {
	readonly socket: Socket;
	readonly records: ParsedOutputLine[];
	readonly history: ParsedOutputLine[];
	readonly nextRecord: () => Promise<ParsedOutputLine>;
}

async function connectTcpPeer(address: TcpRpcAddress): Promise<TcpPeer> {
	const socket = createConnection({ host: address.host, port: address.port });
	await once(socket, "connect");
	const records: ParsedOutputLine[] = [];
	const history: ParsedOutputLine[] = [];
	const waiters: Array<(record: ParsedOutputLine) => void> = [];
	attachJsonlLineReader(socket, (line) => {
		const record = JSON.parse(line) as ParsedOutputLine;
		history.push(record);
		const waiter = waiters.shift();
		if (waiter === undefined) records.push(record);
		else waiter(record);
	});
	return {
		socket,
		records,
		history,
		nextRecord: () => {
			const record = records.shift();
			if (record !== undefined) return Promise.resolve(record);
			return new Promise((resolve) => waiters.push(resolve));
		},
	};
}

function writeTcpRecord(socket: Socket, value: unknown): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		try {
			socket.write(`${JSON.stringify(value)}\n`, (error) => (error ? reject(error) : resolve()));
		} catch (error) {
			reject(error instanceof Error ? error : new Error(String(error)));
		}
	});
}

async function nextResponse(peer: TcpPeer, id: string): Promise<ParsedOutputLine> {
	while (true) {
		const record = await peer.nextRecord();
		if (record.type === "response" && record.id === id) return record;
	}
}

function terminalEvents(records: readonly ParsedOutputLine[]): ParsedOutputLine[] {
	return records.filter(
		(record) => record.type === "run.completed" || record.type === "run.failed" || record.type === "run.cancelled",
	);
}

function recordsOfType(records: readonly ParsedOutputLine[], type: string): ParsedOutputLine[] {
	return records.filter((record) => record.type === type);
}

async function startTcpController(options: {
	withAuth: boolean;
	responseDelayMs: number;
}): Promise<{
	controller: RpcHostController;
	runtimeHost: AgentSessionRuntime;
	transport: RpcTransport<RpcCommand, RpcHostOutputRecord>;
	address: TcpRpcAddress;
	cleanup: () => Promise<void>;
}> {
	let activeConnection: RpcTransportConnection<RpcCommand, RpcHostOutputRecord> | undefined;
	let detachPromise = Promise.resolve();
	const pendingWrites = new Set<Promise<void>>();
	const output: RpcHostOutputSink = {
		publish(record: RpcHostOutputRecord): void {
			const connection = activeConnection;
			if (connection === undefined || connection.closed) return;
			const pending = connection.send(record).catch(() => {});
			pendingWrites.add(pending);
			void pending.finally(() => pendingWrites.delete(pending));
		},
		async waitForBackpressure(): Promise<void> {
			await Promise.all([...pendingWrites]);
		},
	};
	const { controller, runtimeHost, cleanup: cleanupRuntime } = await startInMemoryController(options, output);
	const port = await getAvailablePort();
	const transport = createRpcTransport<RpcCommand, RpcHostOutputRecord>({
		address: { transport: "tcp", host: "127.0.0.1", port },
		parseCommand: (value) => {
			if (typeof value !== "object" || value === null || typeof (value as { type?: unknown }).type !== "string") {
				throw new TypeError("RPC command must include a string type");
			}
			return value as RpcCommand;
		},
		dispatch: async (command) => {
			await detachPromise;
			await controller.handleCommand(command);
		},
		onConnection: (connection) => {
			void detachPromise.then(() => {
				if (!connection.closed) activeConnection = connection;
			});
		},
		onConnectionClose: (connection) => {
			if (activeConnection === connection) activeConnection = undefined;
			detachPromise = controller.detachTransport();
		},
	});
	await transport.start();
	return {
		controller,
		runtimeHost,
		transport,
		address: transport.address!,
		cleanup: async () => {
			await transport.close();
			await controller.detachTransport();
			await controller.shutdown();
			await cleanupRuntime();
		},
	};
}

async function getAvailablePort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen({ host: "127.0.0.1", port: 0 }, () => resolve());
	});
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("Test listener did not expose a TCP port");
	await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	return address.port;
}

describe("TCP Automation Host cancel and idempotency", () => {
	it("cancels an active run over TCP and keeps duplicate cancel terminal-free", async () => {
		const harness = await startTcpController({ withAuth: true, responseDelayMs: 500 });
		let peer: TcpPeer | undefined;
		try {
			peer = await connectTcpPeer(harness.address);
			await writeTcpRecord(peer.socket, { id: "tcp-init", type: "initialize", protocolVersion: 1 });
			expect(await nextResponse(peer, "tcp-init")).toMatchObject({
				command: "initialize",
				success: true,
			});

			await writeTcpRecord(peer.socket, { id: "tcp-start", type: "run.start", message: "Delayed run" });
			const accepted = await nextResponse(peer, "tcp-start");
			expect(accepted).toMatchObject({ command: "run.start", success: true });
			const runId = (accepted.data as { runId: string }).runId;
			expect(runId).toBeTruthy();
			await vi.waitFor(() => expect(recordsOfType(peer!.history, "run.started")).toHaveLength(1));

			await writeTcpRecord(peer.socket, { id: "tcp-cancel", type: "run.cancel", runId });
			const cancelResponse = await nextResponse(peer, "tcp-cancel");
			expect(cancelResponse).toMatchObject({ command: "run.cancel", success: true });
			expect((cancelResponse.data as { runId: string; status: string }).status).toBe("running");
			const cancelResponseIndex = peer.history.findIndex(
				(record) => record.type === "response" && record.id === "tcp-cancel",
			);

			await vi.waitFor(() => expect(terminalEvents(peer!.history)).toHaveLength(1));
			expect(terminalEvents(peer.history)[0]).toMatchObject({ type: "run.cancelled", runId });
			const terminalIndex = peer.history.findIndex((record) => record.type === "run.cancelled");
			expect(cancelResponseIndex).toBeGreaterThanOrEqual(0);
			expect(cancelResponseIndex).toBeLessThan(terminalIndex);

			await writeTcpRecord(peer.socket, { id: "tcp-cancel-duplicate", type: "run.cancel", runId });
			const duplicateCancel = await nextResponse(peer, "tcp-cancel-duplicate");
			expect(duplicateCancel).toMatchObject({ command: "run.cancel", success: true });
			expect((duplicateCancel.data as { runId: string; status: string }).status).toBe("cancelled");
			expect(terminalEvents(peer.history)).toHaveLength(1);

			await writeTcpRecord(peer.socket, { id: "tcp-get", type: "run.get", runId });
			const runGet = await nextResponse(peer, "tcp-get");
			expect(runGet).toMatchObject({ command: "run.get", success: true });
			expect((runGet.data as { run: { status: string }; receipt: { status: string } }).run.status).toBe("cancelled");
			expect((runGet.data as { run: { status: string }; receipt: { status: string } }).receipt.status).toBe("cancelled");

			expect(recordsOfType(peer.history, "run.started")).toHaveLength(1);
			expect(terminalEvents(peer.history)).toHaveLength(1);
			const ledgerEntries = harness.runtimeHost.session.sessionRead
				.getEntries()
				.filter(
					(entry): entry is Extract<SessionEntry, { type: "custom" }> =>
						entry.type === "custom" && entry.customType === RUN_LEDGER_CUSTOM_TYPE,
				);
			expect(ledgerEntries).toHaveLength(2);
			expect(ledgerEntries.map((entry) => (entry.data as { kind?: string }).kind)).toEqual([
				"accepted",
				"started",
			]);
			const runReceiptFact = (
				await getAgentCanonicalSession(harness.runtimeHost.session).findFoundationRecords({
					kind: "fact",
					objectType: "run_receipt",
					order: "oldestFirst",
				})
			).at(-1);
			expect(runReceiptFact).toMatchObject({
				payload: { runId, terminalStatus: "cancelled" },
			});
		} finally {
			peer?.socket.destroy();
			await harness.cleanup();
		}
	});

	it("retries clientRequestId on the real TCP Host without creating a second run", async () => {
		const harness = await startTcpController({ withAuth: true, responseDelayMs: 100 });
		let peer: TcpPeer | undefined;
		try {
			peer = await connectTcpPeer(harness.address);
			await writeTcpRecord(peer.socket, { id: "tcp-init", type: "initialize", protocolVersion: 1 });
			expect(await nextResponse(peer, "tcp-init")).toMatchObject({ command: "initialize", success: true });

			const request = { type: "run.start" as const, clientRequestId: "tcp-idem-1", message: "Idempotent TCP run" };
			await writeTcpRecord(peer.socket, { id: "tcp-start", ...request });
			const first = await nextResponse(peer, "tcp-start");
			expect(first).toMatchObject({ command: "run.start", success: true });
			const runId = (first.data as { runId: string }).runId;
			expect(runId).toBeTruthy();
			await vi.waitFor(() => expect(terminalEvents(peer!.history)).toHaveLength(1), { timeout: 10_000 });
			expect(recordsOfType(peer.history, "run.started")).toHaveLength(1);

			const ledgerCountAfterFirstRun = harness.runtimeHost.session.sessionRead
				.getEntries()
				.filter((entry) => entry.type === "custom" && entry.customType === RUN_LEDGER_CUSTOM_TYPE).length;
			await writeTcpRecord(peer.socket, { id: "tcp-duplicate", ...request });
			const duplicate = await nextResponse(peer, "tcp-duplicate");
			expect(duplicate).toMatchObject({ command: "run.start", success: true });
			expect(duplicate.data).toMatchObject({
				runId,
				idempotent: true,
				receipt: { runId, status: "completed" },
			});
			expect(recordsOfType(peer.history, "run.started")).toHaveLength(1);
			expect(terminalEvents(peer.history)).toHaveLength(1);
			expect(
				harness.runtimeHost.session.sessionRead
					.getEntries()
					.filter((entry) => entry.type === "custom" && entry.customType === RUN_LEDGER_CUSTOM_TYPE),
			).toHaveLength(ledgerCountAfterFirstRun);

			await writeTcpRecord(peer.socket, {
				id: "tcp-conflict",
				type: "run.start",
				clientRequestId: "tcp-idem-1",
				message: "Different TCP fingerprint",
			});
			const conflict = await nextResponse(peer, "tcp-conflict");
			expect(conflict).toMatchObject({
				command: "run.start",
				success: false,
				error: { code: "client_request_conflict" },
			});
			expect(recordsOfType(peer.history, "run.started")).toHaveLength(1);
			expect(terminalEvents(peer.history)).toHaveLength(1);
			expect(
				harness.runtimeHost.session.sessionRead
					.getEntries()
					.filter((entry) => entry.type === "custom" && entry.customType === RUN_LEDGER_CUSTOM_TYPE),
			).toHaveLength(ledgerCountAfterFirstRun);
		} finally {
			peer?.socket.destroy();
			await harness.cleanup();
		}
	});
});
