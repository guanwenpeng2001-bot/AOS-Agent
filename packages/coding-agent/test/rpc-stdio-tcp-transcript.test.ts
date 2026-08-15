import { existsSync, mkdirSync, rmSync } from "node:fs";
import { once } from "node:events";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Writable } from "node:stream";
import { Agent } from "@aos-agent/agent-core";
import { type AssistantMessage, type AssistantMessageEvent, EventStream, type Model } from "@aos-agent/ai";
import { describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { createExtensionRuntime } from "../src/core/extensions/loader.ts";
import type { ModelRuntime } from "../src/core/model-runtime.ts";
import type { ResourceLoader } from "../src/core/resource-loader.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { runRpcMode } from "../src/modes/rpc/rpc-mode.ts";
import { attachJsonlLineReader } from "../src/modes/rpc/jsonl.ts";
import type { TcpRpcAddress } from "../src/modes/rpc/rpc-transport-address.ts";

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

interface TestJsonlWriter {
	write(value: unknown): Promise<void>;
	close(): Promise<void>;
	detach(): void;
}

function attachTestJsonlLineReader(
	stream: NodeJS.ReadableStream,
	onLine: (line: string) => void,
): () => void {
	if (stream === process.stdin) {
		rpcIo.lineHandler = onLine;
		return () => {};
	}
	let buffer = "";
	let detached = false;
	const onData = (chunk: string | Buffer): void => {
		if (detached) return;
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
	return () => {
		if (detached) return;
		detached = true;
		stream.off("data", onData);
	};
}

function createTestJsonlLineWriter(stream: NodeJS.ReadableStream): TestJsonlWriter {
	const writable = stream as unknown as Writable;
	let ending = false;
	return {
		write(value: unknown): Promise<void> {
			if (ending || writable.destroyed) return Promise.reject(new Error("JSONL writer is closed"));
			return new Promise<void>((resolve, reject) => {
				writable.write(`${JSON.stringify(value)}\n`, "utf8", (error?: Error | null) => {
					if (error) reject(error);
					else resolve();
				});
			});
		},
		close(): Promise<void> {
			if (ending || writable.destroyed) return Promise.resolve();
			ending = true;
			return new Promise<void>((resolve) => writable.end(resolve));
		},
		detach(): void {},
	};
}

vi.mock("../src/core/output-guard.js", () => ({
	flushRawStdout: vi.fn(async () => {}),
	takeOverStdout: vi.fn(),
	waitForRawStdoutBackpressure: vi.fn(async () => {}),
	writeRawStdout: (line: string) => {
		rpcIo.outputLines.push(line);
	},
}));

vi.mock("../src/modes/interactive/theme/theme.js", () => ({ theme: {} }));

vi.mock("../src/modes/rpc/jsonl.js", () => ({
	attachJsonlLineReader: vi.fn(attachTestJsonlLineReader),
	createJsonlLineWriter: createTestJsonlLineWriter,
	DEFAULT_MAX_JSONL_FRAME_BYTES: 1024 * 1024,
	JsonlFrameError: TestJsonlFrameError,
	serializeJsonLine: (value: unknown) => `${JSON.stringify(value)}\n`,
}));

// Keep this test runnable after `npm ci --ignore-scripts`, where the generated
// AI model catalog is intentionally absent from the checkout.
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

async function createRuntimeHost(): Promise<{ runtimeHost: AgentSessionRuntime; cleanup: () => Promise<void> }> {
	const tempDir = join(tmpdir(), `aos-rpc-transcript-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
				}, 0);
			});
			return stream;
		},
	});

	const settingsManager = SettingsManager.create(tempDir, tempDir);
	const modelRuntime = {
		hasConfiguredAuth: () => true,
		checkAuth: async () => ({ type: "api_key", key: "test-key" }),
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
	let rebindCallback: (() => Promise<void>) | undefined;
	const runtimeHost = {
		get session(): AgentSession {
			return currentSession;
		},
		set session(next: AgentSession) {
			currentSession = next;
		},
		setRebindSession: vi.fn((callback?: (() => Promise<void>) | undefined) => {
			rebindCallback = callback;
		}),
		switchSession: vi.fn(async (sessionPath: string) => {
			currentSession = openSession(SessionManager.open(sessionPath));
			if (rebindCallback !== undefined) await rebindCallback();
			return { cancelled: false };
		}),
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
				// Ignore test cleanup failures.
			}
			currentSession.dispose();
			if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
		},
	};
}

type ParsedRecord = Record<string, unknown>;

function parseOutputLines(outputLines: string[]): ParsedRecord[] {
	return outputLines
		.flatMap((line) => line.split("\n"))
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as ParsedRecord);
}

function terminalEvents(records: ParsedRecord[]): ParsedRecord[] {
	return records.filter(
		(record) => record.type === "run.completed" || record.type === "run.failed" || record.type === "run.cancelled",
	);
}

interface TranscriptAdapter {
	records(): ParsedRecord[];
	send(command: Record<string, unknown>): Promise<void>;
	cleanup(): Promise<void>;
}

async function startStdioRpcMode(): Promise<TranscriptAdapter> {
	rpcIo.outputLines = [];
	rpcIo.lineHandler = undefined;
	const signalNames: NodeJS.Signals[] = process.platform === "win32" ? ["SIGTERM"] : ["SIGTERM", "SIGHUP"];
	const signalListenersBefore = new Map(signalNames.map((signal) => [signal, new Set(process.listeners(signal))]));
	const stdinEndListenersBefore = new Set(process.stdin.listeners("end"));
	const { runtimeHost, cleanup: cleanupRuntime } = await createRuntimeHost();
	void runRpcMode(runtimeHost);
	await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());

	return {
		records: () => parseOutputLines(rpcIo.outputLines),
		send: async (command) => {
			rpcIo.lineHandler!(JSON.stringify(command));
		},
		cleanup: async () => {
			await cleanupRuntime();
			for (const [signal, listenersBefore] of signalListenersBefore) {
				for (const listener of process.listeners(signal)) {
					if (!listenersBefore.has(listener)) process.off(signal, listener as (...args: unknown[]) => void);
				}
			}
			for (const listener of process.stdin.listeners("end")) {
				if (!stdinEndListenersBefore.has(listener)) process.stdin.off("end", listener as (...args: unknown[]) => void);
			}
		},
	};
}

interface TcpPeer {
	readonly socket: Socket;
	readonly records: ParsedRecord[];
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

async function connectTcpPeer(address: TcpRpcAddress): Promise<TcpPeer> {
	const socket = createConnection({ host: address.host, port: address.port });
	await once(socket, "connect");
	const records: ParsedRecord[] = [];
	attachJsonlLineReader(socket, (line) => records.push(JSON.parse(line) as ParsedRecord));
	return { socket, records };
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

async function startTcpRpcMode(): Promise<TranscriptAdapter> {
	rpcIo.outputLines = [];
	const signalNames: NodeJS.Signals[] = process.platform === "win32" ? ["SIGTERM"] : ["SIGTERM", "SIGHUP"];
	const signalListenersBefore = new Map(signalNames.map((signal) => [signal, new Set(process.listeners(signal))]));
	const { runtimeHost, cleanup: cleanupRuntime } = await createRuntimeHost();
	const port = await getAvailablePort();
	const diagnostics = vi.spyOn(console, "error").mockImplementation(() => {});
	let exitCode: number | undefined;
	const exit = vi.spyOn(process, "exit").mockImplementation(((code?: string | number | null) => {
		exitCode = typeof code === "number" ? code : 0;
		return undefined as never;
	}) as typeof process.exit);

	void runRpcMode(runtimeHost, { listen: { transport: "tcp", host: "127.0.0.1", port } });
	await vi.waitFor(() => {
		expect(diagnostics.mock.calls.flat().join("\n")).toContain(`RPC TCP listening on tcp://127.0.0.1:${port}`);
	});
	const peer = await connectTcpPeer({ transport: "tcp", host: "127.0.0.1", port });
	await vi.waitFor(() => {
		expect(diagnostics.mock.calls.flat().join("\n")).toContain("connection");
	});

	return {
		records: () => [...peer.records],
		send: (command) => writeTcpRecord(peer.socket, command),
		cleanup: async () => {
			peer.socket.destroy();
			process.emit("SIGTERM");
			await vi.waitFor(() => expect(exitCode).toBeDefined());
			exit.mockRestore();
			diagnostics.mockRestore();
			for (const [signal, listenersBefore] of signalListenersBefore) {
				for (const listener of process.listeners(signal)) {
					if (!listenersBefore.has(listener)) process.off(signal, listener as (...args: unknown[]) => void);
				}
			}
			await cleanupRuntime();
		},
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function waitForRecord(adapter: TranscriptAdapter, predicate: (record: ParsedRecord) => boolean): Promise<ParsedRecord> {
	let match: ParsedRecord | undefined;
	await vi.waitFor(() => {
		match = adapter.records().find(predicate);
		expect(match).toBeDefined();
	});
	return match!;
}

async function collectTranscript(adapter: TranscriptAdapter): Promise<ParsedRecord[]> {
	await adapter.send({ id: "initialize", type: "initialize", protocolVersion: 1 });
	await waitForRecord(adapter, (record) => record.type === "response" && record.id === "initialize");

	await adapter.send({ id: "run-start", type: "run.start", message: "hi" });
	const accepted = await waitForRecord(
		adapter,
		(record) => record.type === "response" && record.id === "run-start",
	);
	if (!isRecord(accepted.data) || typeof accepted.data.runId !== "string") {
		throw new Error("run.start response did not include a runId");
	}
	const runId = accepted.data.runId;
	await waitForRecord(adapter, (record) =>
		record.type === "run.completed" || record.type === "run.failed" || record.type === "run.cancelled",
	);

	await adapter.send({ id: "run-get", type: "run.get", runId });
	await waitForRecord(adapter, (record) => record.type === "response" && record.id === "run-get");
	await adapter.send({
		id: "audit-query",
		type: "audit.query",
		scope: "current-session",
		types: ["run.completed"],
		limit: 200,
	});
	await waitForRecord(adapter, (record) => record.type === "response" && record.id === "audit-query");
	await adapter.send({
		id: "audit-replay",
		type: "audit.replay",
		runId,
		scope: "current-session",
		types: ["run.completed"],
		limit: 200,
	});
	await waitForRecord(adapter, (record) => record.type === "response" && record.id === "audit-replay");

	return adapter.records();
}

function publicRecordTypes(records: ParsedRecord[]): string[] {
	return records.map((record) => {
		if (record.type === "response") return `response:${String(record.command)}`;
		return String(record.type);
	});
}

function assertAutomationResponseShape(records: ParsedRecord[]): void {
	for (const record of records.filter((candidate) => candidate.type === "response")) {
		expect(typeof record.command).toBe("string");
		expect(typeof record.success).toBe("boolean");
		if (record.success !== false) continue;
		expect(record.error).toMatchObject({
			code: expect.any(String),
			message: expect.any(String),
			retryable: expect.any(Boolean),
		});
	}
}

function automationResponseSignatures(records: ParsedRecord[]): unknown[] {
	return records
		.filter((record) => record.type === "response")
		.map((record) => {
			const error = isRecord(record.error) ? record.error : undefined;
			return {
				command: record.command,
				success: record.success,
				errorCode: error?.code,
				errorKeys: error === undefined ? undefined : Object.keys(error).sort(),
			};
		});
}

const DYNAMIC_ID_KEYS = new Set([
	"attemptId",
	"bindingId",
	"capabilityBindingId",
	"contextSnapshotId",
	"eventId",
	"modelBindingId",
	"policyBindingId",
	"previousBindingId",
	"previousModelBindingId",
	"previousPolicyBindingId",
	"runId",
	"sessionId",
	"sourceEntryId",
	"sourceRunId",
]);

function isTimestampKey(key: string): boolean {
	return key === "timestamp" || key.endsWith("At") || key.endsWith("Timestamp");
}

interface NormalizationState {
	readonly ids: Map<string, string>;
	nextId: number;
}

function normalizePublicTranscript(records: ParsedRecord[]): unknown[] {
	const state: NormalizationState = { ids: new Map(), nextId: 1 };
	return records.map((record) => normalizePublicValue(record, [], undefined, state));
}

function isDynamicIdentityKey(key: string, value: string): boolean {
	return (
		DYNAMIC_ID_KEYS.has(key) ||
		((key === "revision" || key === "profileRevision") && (value.startsWith("rev:") || value.startsWith("digest:")))
	);
}

function normalizePublicValue(
	value: unknown,
	path: string[],
	key: string | undefined,
	state: NormalizationState,
): unknown {
	if (typeof value === "string" && key !== undefined && isDynamicIdentityKey(key, value)) {
		const existing = state.ids.get(value);
		if (existing !== undefined) return existing;
		const replacement = `<opaque-${state.nextId++}>`;
		state.ids.set(value, replacement);
		return replacement;
	}
	if (Array.isArray(value)) return value.map((item, index) => normalizePublicValue(item, [...path, String(index)], undefined, state));
	if (!isRecord(value)) return value;

	const normalized: Record<string, unknown> = {};
	for (const [childKey, childValue] of Object.entries(value)) {
		if (isTimestampKey(childKey)) continue;
		const isRunRecordId =
			childKey === "id" &&
			(path[path.length - 1] === "run" || path.includes("bindingAssociation") || path.includes("contextSnapshot"));
		if (isRunRecordId && typeof childValue === "string") {
			const existing = state.ids.get(childValue);
			if (existing !== undefined) {
				normalized[childKey] = existing;
				continue;
			}
			const replacement = `<opaque-${state.nextId++}>`;
			state.ids.set(childValue, replacement);
			normalized[childKey] = replacement;
			continue;
		}
		normalized[childKey] = normalizePublicValue(childValue, [...path, childKey], childKey, state);
	}
	return normalized;
}

describe("RPC stdio/TCP public transcript parity", () => {
	it("emits the same Automation Host records for the same faux-provider sequence", async () => {
		const stdio = await startStdioRpcMode();
		let stdioTranscript: ParsedRecord[];
		try {
			stdioTranscript = await collectTranscript(stdio);
		} finally {
			await stdio.cleanup();
		}

		const tcp = await startTcpRpcMode();
		let tcpTranscript: ParsedRecord[];
		try {
			tcpTranscript = await collectTranscript(tcp);
			// TCP diagnostics belong on stderr; no RPC JSONL record may reach stdout.
			expect(rpcIo.outputLines).toEqual([]);
		} finally {
			await tcp.cleanup();
		}

		for (const transcript of [stdioTranscript!, tcpTranscript!]) assertAutomationResponseShape(transcript);
		expect(publicRecordTypes(stdioTranscript!)).toEqual(publicRecordTypes(tcpTranscript!));
		expect(automationResponseSignatures(stdioTranscript!)).toEqual(automationResponseSignatures(tcpTranscript!));
		expect(normalizePublicTranscript(stdioTranscript!)).toEqual(normalizePublicTranscript(tcpTranscript!));
		expect(
			stdioTranscript!.filter((record) => record.type === "response").map((record) => record.command),
		).toEqual(["initialize", "run.start", "run.get", "audit.query", "audit.replay"]);

		for (const transcript of [stdioTranscript!, tcpTranscript!]) {
			const terminals = terminalEvents(transcript);
			expect(terminals).toHaveLength(1);
			expect(["run.completed", "run.failed", "run.cancelled"]).toContain(terminals[0].type);
			expect(transcript.filter((record) => record.type === "run.started")).toHaveLength(1);
			expect(transcript.filter((record) => record.type === "run.event").length).toBeGreaterThanOrEqual(1);
		}
		expect(terminalEvents(stdioTranscript!)[0].type).toBe(terminalEvents(tcpTranscript!)[0].type);
	});
});
