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

interface RuntimeHostOptions {
	readonly streamDelayMs?: number;
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

async function createRuntimeHost(
	options: RuntimeHostOptions = {},
): Promise<{ runtimeHost: AgentSessionRuntime; cleanup: () => Promise<void> }> {
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
				}, options.streamDelayMs ?? 0);
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

async function startStdioRpcMode(options: RuntimeHostOptions = {}): Promise<TranscriptAdapter> {
	rpcIo.outputLines = [];
	rpcIo.lineHandler = undefined;
	const signalNames: NodeJS.Signals[] = process.platform === "win32" ? ["SIGTERM"] : ["SIGTERM", "SIGHUP"];
	const signalListenersBefore = new Map(signalNames.map((signal) => [signal, new Set(process.listeners(signal))]));
	const stdinEndListenersBefore = new Set(process.stdin.listeners("end"));
	const { runtimeHost, cleanup: cleanupRuntime } = await createRuntimeHost(options);
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

async function startTcpRpcMode(options: RuntimeHostOptions = {}): Promise<TranscriptAdapter> {
	rpcIo.outputLines = [];
	const signalNames: NodeJS.Signals[] = process.platform === "win32" ? ["SIGTERM"] : ["SIGTERM", "SIGHUP"];
	const signalListenersBefore = new Map(signalNames.map((signal) => [signal, new Set(process.listeners(signal))]));
	const { runtimeHost, cleanup: cleanupRuntime } = await createRuntimeHost(options);
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

async function waitForRecord(
	adapter: TranscriptAdapter,
	predicate: (record: ParsedRecord) => boolean,
	timeout = 1000,
): Promise<ParsedRecord> {
	let match: ParsedRecord | undefined;
	await vi.waitFor(
		() => {
			match = adapter.records().find(predicate);
			expect(match).toBeDefined();
		},
		{ timeout },
	);
	return match!;
}

type TerminalEventType = "run.completed" | "run.failed" | "run.cancelled";

interface TranscriptRunOptions {
	readonly deadlineAt?: string;
	readonly terminalType?: TerminalEventType;
}

async function collectTranscript(
	adapter: TranscriptAdapter,
	options: TranscriptRunOptions = {},
): Promise<ParsedRecord[]> {
	await adapter.send({ id: "initialize", type: "initialize", protocolVersion: 1 });
	await waitForRecord(adapter, (record) => record.type === "response" && record.id === "initialize");

	await adapter.send({
		id: "run-start",
		type: "run.start",
		message: "hi",
		...(options.deadlineAt === undefined ? {} : { deadlineAt: options.deadlineAt }),
	});
	const accepted = await waitForRecord(
		adapter,
		(record) => record.type === "response" && record.id === "run-start",
	);
	if (!isRecord(accepted.data) || typeof accepted.data.runId !== "string") {
		throw new Error("run.start response did not include a runId");
	}
	const runId = accepted.data.runId;
	const terminalType = options.terminalType ?? "run.completed";
	await waitForRecord(
		adapter,
		(record) => record.type === terminalType,
		options.deadlineAt === undefined ? 1000 : 3000,
	);
	await vi.waitFor(() => expect(terminalEvents(adapter.records())).toHaveLength(1), {
		timeout: options.deadlineAt === undefined ? 1000 : 3000,
	});

	await adapter.send({ id: "run-get", type: "run.get", runId });
	await waitForRecord(adapter, (record) => record.type === "response" && record.id === "run-get");
	await adapter.send({
		id: "audit-query",
		type: "audit.query",
		scope: "current-session",
		types: [terminalType],
		limit: 200,
	});
	await waitForRecord(adapter, (record) => record.type === "response" && record.id === "audit-query");
	await adapter.send({
		id: "audit-replay",
		type: "audit.replay",
		runId,
		scope: "current-session",
		types: [terminalType],
		limit: 200,
	});
	await waitForRecord(adapter, (record) => record.type === "response" && record.id === "audit-replay");

	return adapter.records();
}

async function sendAutomationCommand(
	adapter: TranscriptAdapter,
	command: Record<string, unknown>,
): Promise<ParsedRecord> {
	await adapter.send(command);
	return waitForRecord(adapter, (record) => record.type === "response" && record.id === command.id);
}

function responseById(records: ParsedRecord[], id: string): ParsedRecord {
	const record = records.find((candidate) => candidate.id === id);
	if (record === undefined) throw new Error(`missing response ${id}`);
	return record;
}

function gateRecordOf(record: ParsedRecord): Record<string, unknown> {
	if (!isRecord(record.data) || !isRecord(record.data.gate)) {
		throw new Error("response did not include a gate");
	}
	return record.data.gate;
}

function gateIdOf(record: ParsedRecord): string {
	const gate = gateRecordOf(record);
	if (typeof gate.gateId !== "string") throw new Error("gate record did not include gateId");
	return gate.gateId;
}

function listGateIds(record: ParsedRecord): string[] {
	const data = isRecord(record.data) ? record.data : {};
	if (!Array.isArray(data.gates)) throw new Error("list response did not include a gates array");
	const gates = data.gates as unknown as ParsedRecord[];
	return gates.map((gate) => {
		if (typeof gate.gateId !== "string") throw new Error("list gate is malformed");
		return gate.gateId;
	});
}

/**
 * Deterministic Task-level Human Gate control-plane sequence over one
 * transport. Every command carries a fixed id, the write commands use fixed
 * `clientRequestId` idempotency keys, and nothing starts a Run, so the two
 * transports must produce identical public transcripts.
 */
async function collectTaskGateTranscript(adapter: TranscriptAdapter): Promise<ParsedRecord[]> {
	const send = (command: Record<string, unknown>): Promise<ParsedRecord> => sendAutomationCommand(adapter, command);
	// Audit orders Gate events by their millisecond entry timestamp; pacing the
	// appending write commands keeps that ordering deterministic across runs.
	const transitionPause = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 10));

	await send({ id: "initialize", type: "initialize", protocolVersion: 1 });

	// Gate A: request with an optional run correlation, read-back, idempotent
	// retry, then approve and the terminal-conflict error surface.
	await transitionPause();
	const gateARequest = await send({
		id: "gate-a-request",
		type: "task.gate.request",
		taskId: "task_42",
		stageId: "stage_review",
		stageRevision: 3,
		runId: "run_correlate",
		clientRequestId: "gate-a-request-001",
	});
	const gateA = gateIdOf(gateARequest);
	await send({ id: "gate-a-get", type: "task.gate.get", gateId: gateA });
	await send({ id: "gate-a-list-pending", type: "task.gate.list", status: "pending" });
	await send({
		id: "gate-a-request-retry",
		type: "task.gate.request",
		taskId: "task_42",
		stageId: "stage_review",
		stageRevision: 3,
		runId: "run_correlate",
		clientRequestId: "gate-a-request-001",
	});
	await transitionPause();
	await send({
		id: "gate-a-approve",
		type: "task.gate.approve",
		gateId: gateA,
		actorId: "operator_7",
		clientRequestId: "gate-a-approve-001",
	});
	await send({
		id: "gate-a-approve-retry",
		type: "task.gate.approve",
		gateId: gateA,
		actorId: "operator_7",
		clientRequestId: "gate-a-approve-001",
	});
	// Late opposite decision, repeated decision, idempotency key reuse with a
	// different payload, and duplicate business key are all stable errors.
	await send({
		id: "gate-a-reject-late",
		type: "task.gate.reject",
		gateId: gateA,
		actorId: "operator_7",
		reasonCode: "quality_check_failed",
		clientRequestId: "gate-a-reject-001",
	});
	await send({
		id: "gate-a-approve-again",
		type: "task.gate.approve",
		gateId: gateA,
		clientRequestId: "gate-a-approve-002",
	});
	await send({
		id: "gate-a-idem-conflict",
		type: "task.gate.approve",
		gateId: "gate_unknown",
		actorId: "operator_9",
		clientRequestId: "gate-a-approve-001",
	});
	await send({
		id: "gate-a-dup-request",
		type: "task.gate.request",
		taskId: "task_42",
		stageId: "stage_review",
		stageRevision: 3,
		clientRequestId: "gate-a-request-002",
	});
	await send({
		id: "gate-invalid-revision",
		type: "task.gate.request",
		taskId: "task_42",
		stageId: "stage_bad",
		stageRevision: 0,
		clientRequestId: "gate-invalid-revision-001",
	});
	await send({ id: "gate-a-get-unknown", type: "task.gate.get", gateId: "gate_missing" });
	await send({ id: "gate-a-list-bad-limit", type: "task.gate.list", limit: 0 });

	// Gate B: reject with a stable reasonCode.
	await transitionPause();
	const gateBRequest = await send({
		id: "gate-b-request",
		type: "task.gate.request",
		taskId: "task_43",
		stageId: "stage_build",
		stageRevision: 1,
		clientRequestId: "gate-b-request-001",
	});
	const gateB = gateIdOf(gateBRequest);
	await transitionPause();
	await send({
		id: "gate-b-reject",
		type: "task.gate.reject",
		gateId: gateB,
		actorId: "operator_7",
		reasonCode: "quality_check_failed",
		clientRequestId: "gate-b-reject-001",
	});

	// Gate C: cancel.
	await transitionPause();
	const gateCRequest = await send({
		id: "gate-c-request",
		type: "task.gate.request",
		taskId: "task_44",
		stageId: "stage_test",
		stageRevision: 2,
		clientRequestId: "gate-c-request-001",
	});
	const gateC = gateIdOf(gateCRequest);
	await transitionPause();
	await send({
		id: "gate-c-cancel",
		type: "task.gate.cancel",
		gateId: gateC,
		actorId: "operator_7",
		clientRequestId: "gate-c-cancel-001",
	});

	// Read-only listing with server-side status and task filters.
	await send({ id: "gate-list-all", type: "task.gate.list" });
	await send({ id: "gate-list-approved", type: "task.gate.list", status: "approved" });
	await send({ id: "gate-list-rejected", type: "task.gate.list", status: "rejected" });
	await send({ id: "gate-list-pending", type: "task.gate.list", status: "pending" });
	await send({ id: "gate-list-task42", type: "task.gate.list", taskId: "task_42" });

	// Audit exposes the Gate transitions as allowlisted summaries.
	await send({
		id: "audit-gates",
		type: "audit.query",
		scope: "current-session",
		types: ["task.gate"],
		limit: 200,
	});

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

function assertStrictJsonlLines(lines: string[]): void {
	expect(lines.length).toBeGreaterThan(0);
	for (const line of lines) {
		expect(line.endsWith("\n")).toBe(true);
		const payload = line.slice(0, -1);
		expect(payload).not.toContain("\n");
		expect(payload).not.toContain("\r");
		expect(() => JSON.parse(payload)).not.toThrow();
	}
}

function assertDeadlineTranscript(records: ParsedRecord[], deadlineAt: string): void {
	const terminals = terminalEvents(records);
	expect(terminals).toHaveLength(1);
	expect(terminals[0]).toMatchObject({
		type: "run.failed",
		receipt: {
			status: "failed",
			deadlineAt,
			terminalError: { code: "run_deadline_exceeded", message: "Run failed.", retryable: false },
		},
	});
	expect(records.some((record) => record.type === "run.cancelled")).toBe(false);

	const startResponseIndex = records.findIndex(
		(record) => record.type === "response" && record.command === "run.start" && record.success === true,
	);
	const startedIndex = records.findIndex((record) => record.type === "run.started");
	const terminalIndex = records.findIndex((record) => record.type === "run.failed");
	expect(startResponseIndex).toBeGreaterThanOrEqual(0);
	expect(startedIndex).toBeGreaterThan(startResponseIndex);
	expect(terminalIndex).toBeGreaterThan(startedIndex);
	for (const [index, record] of records.entries()) {
		if (record.type === "run.event") {
			expect(index).toBeGreaterThan(startedIndex);
			expect(index).toBeLessThan(terminalIndex);
		}
	}

	const runGet = records.find((record) => record.type === "response" && record.command === "run.get");
	expect(runGet).toMatchObject({
		success: true,
		data: {
			run: { status: "failed", deadlineAt },
			receipt: {
				status: "failed",
				deadlineAt,
				terminalError: { code: "run_deadline_exceeded" },
			},
		},
	});

	const auditQuery = records.find((record) => record.type === "response" && record.command === "audit.query");
	expect(auditQuery).toMatchObject({
		success: true,
		data: { events: expect.arrayContaining([expect.objectContaining({ type: "run.failed" })]) },
	});
	const auditReplay = records.find((record) => record.type === "response" && record.command === "audit.replay");
	expect(auditReplay).toMatchObject({
		success: true,
		data: {
			run: { status: "failed", deadlineAt },
			events: expect.arrayContaining([expect.objectContaining({ type: "run.failed" })]),
		},
	});
	const replayData = isRecord(auditReplay?.data) ? auditReplay.data : {};
	expect(["complete", "incomplete"]).toContain(replayData.status);
}

function assertTaskGateTranscript(records: ParsedRecord[]): void {
	// Gate operations are control-plane facts: the transcript contains only
	// response records, no Run lifecycle events and no model-visible messages.
	for (const record of records) expect(record.type).toBe("response");
	expect(records.map((record) => record.command)).toEqual([
		"initialize",
		"task.gate.request",
		"task.gate.get",
		"task.gate.list",
		"task.gate.request",
		"task.gate.approve",
		"task.gate.approve",
		"task.gate.reject",
		"task.gate.approve",
		"task.gate.approve",
		"task.gate.request",
		"task.gate.request",
		"task.gate.get",
		"task.gate.list",
		"task.gate.request",
		"task.gate.reject",
		"task.gate.request",
		"task.gate.cancel",
		"task.gate.list",
		"task.gate.list",
		"task.gate.list",
		"task.gate.list",
		"task.gate.list",
		"audit.query",
	]);

	// initialize advertises the six additive Task Gate commands over protocolVersion 1.
	expect(responseById(records, "initialize")).toMatchObject({
		type: "response",
		command: "initialize",
		success: true,
		data: {
			host: "automation-host",
			protocolVersion: 1,
			runCommands: ["run.start", "run.get", "run.cancel", "run.resume"],
			auditCommands: ["audit.query", "audit.replay", "external.map"],
			taskGateCommands: [
				"task.gate.request",
				"task.gate.get",
				"task.gate.list",
				"task.gate.approve",
				"task.gate.reject",
				"task.gate.cancel",
			],
		},
	});

	// request creates one pending Gate for the task stage revision.
	const gateARequest = responseById(records, "gate-a-request");
	expect(gateARequest).toMatchObject({
		type: "response",
		command: "task.gate.request",
		success: true,
		data: { idempotent: false },
	});
	const gateA = gateRecordOf(gateARequest);
	expect(gateA).toMatchObject({
		schemaVersion: 1,
		taskId: "task_42",
		stageId: "stage_review",
		stageRevision: 3,
		status: "pending",
		revision: 0,
		runId: "run_correlate",
	});
	expect(gateA.decidedAt).toBeUndefined();
	const gateAId = gateIdOf(gateARequest);

	// get and list are read-only views of the same snapshot.
	expect(gateRecordOf(responseById(records, "gate-a-get"))).toMatchObject({
		gateId: gateAId,
		taskId: "task_42",
		stageId: "stage_review",
		status: "pending",
		revision: 0,
	});
	expect(responseById(records, "gate-a-list-pending")).toMatchObject({
		success: true,
		data: { gates: [expect.objectContaining({ gateId: gateAId, status: "pending" })], truncated: false },
	});

	// The identical idempotent request replays the durable result without a new transition.
	expect(responseById(records, "gate-a-request-retry")).toMatchObject({ success: true, data: { idempotent: true } });
	expect(gateRecordOf(responseById(records, "gate-a-request-retry"))).toMatchObject({
		gateId: gateAId,
		status: "pending",
		revision: 0,
	});

	// approve is terminal: revision 1, decidedAt, actor label.
	expect(responseById(records, "gate-a-approve")).toMatchObject({ success: true, data: { idempotent: false } });
	expect(gateRecordOf(responseById(records, "gate-a-approve"))).toMatchObject({
		gateId: gateAId,
		status: "approved",
		revision: 1,
		actorId: "operator_7",
	});
	expect(typeof gateRecordOf(responseById(records, "gate-a-approve")).decidedAt).toBe("string");

	// The approve replay with the same clientRequestId returns the terminal snapshot.
	expect(responseById(records, "gate-a-approve-retry")).toMatchObject({ success: true, data: { idempotent: true } });
	expect(gateRecordOf(responseById(records, "gate-a-approve-retry"))).toMatchObject({
		gateId: gateAId,
		status: "approved",
		revision: 1,
	});

	// Late opposite decisions, repeats, and payload changes fail with stable codes.
	expect(responseById(records, "gate-a-reject-late")).toMatchObject({
		success: false,
		error: { code: "task_gate_conflict", retryable: false },
	});
	expect(responseById(records, "gate-a-approve-again")).toMatchObject({
		success: false,
		error: { code: "task_gate_not_pending", retryable: false },
	});
	expect(responseById(records, "gate-a-idem-conflict")).toMatchObject({
		success: false,
		error: { code: "task_gate_idempotency_conflict", retryable: false },
	});
	expect(responseById(records, "gate-a-dup-request")).toMatchObject({
		success: false,
		error: { code: "task_gate_conflict", retryable: false },
	});
	expect(responseById(records, "gate-invalid-revision")).toMatchObject({
		success: false,
		error: { code: "task_gate_invalid", retryable: false },
	});
	expect(responseById(records, "gate-a-get-unknown")).toMatchObject({
		success: false,
		error: { code: "task_gate_not_found", retryable: false },
	});
	expect(responseById(records, "gate-a-list-bad-limit")).toMatchObject({
		success: false,
		error: { code: "task_gate_invalid", retryable: false },
	});

	// reject and cancel are independent terminal decisions with their own Gates.
	const gateB = gateIdOf(responseById(records, "gate-b-request"));
	expect(gateRecordOf(responseById(records, "gate-b-reject"))).toMatchObject({
		gateId: gateB,
		status: "rejected",
		revision: 1,
		actorId: "operator_7",
		reasonCode: "quality_check_failed",
	});
	const gateC = gateIdOf(responseById(records, "gate-c-request"));
	expect(gateRecordOf(responseById(records, "gate-c-cancel"))).toMatchObject({
		gateId: gateC,
		status: "cancelled",
		revision: 1,
		actorId: "operator_7",
	});

	// Listing is deterministic in append order and honors status/task filters.
	expect(listGateIds(responseById(records, "gate-list-all"))).toEqual([gateAId, gateB, gateC]);
	expect(listGateIds(responseById(records, "gate-list-approved"))).toEqual([gateAId]);
	expect(listGateIds(responseById(records, "gate-list-rejected"))).toEqual([gateB]);
	expect(listGateIds(responseById(records, "gate-list-pending"))).toEqual([]);
	expect(listGateIds(responseById(records, "gate-list-task42"))).toEqual([gateAId]);
	for (const id of [
		"gate-list-all",
		"gate-list-approved",
		"gate-list-rejected",
		"gate-list-pending",
		"gate-list-task42",
	]) {
		expect(responseById(records, id)).toMatchObject({ success: true, data: { truncated: false } });
	}

	// Audit exposes only allowlisted Gate summaries; no Run event was created.
	const auditGates = responseById(records, "audit-gates");
	expect(auditGates).toMatchObject({ success: true, command: "audit.query" });
	const auditData = isRecord(auditGates.data) ? auditGates.data : {};
	if (!Array.isArray(auditData.events)) throw new Error("audit.query response did not include events");
	const gateEvents = auditData.events as unknown as ParsedRecord[];
	expect(gateEvents).toHaveLength(6);
	expect(gateEvents.map((event) => isRecord(event.summary) ? event.summary.action : undefined)).toEqual([
		"requested",
		"approved",
		"requested",
		"rejected",
		"requested",
		"cancelled",
	]);
	for (const event of gateEvents) {
		expect(event.type).toBe("task.gate");
		const summary = isRecord(event.summary) ? event.summary : {};
		for (const key of Object.keys(summary)) expect(ALLOWED_GATE_SUMMARY_KEYS).toContain(key);
		expect(summary).toMatchObject({
			gateId: expect.any(String),
			taskId: expect.any(String),
			stageId: expect.any(String),
			stageRevision: expect.any(Number),
			status: expect.any(String),
			revision: expect.any(Number),
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
	"gateId",
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

/** Fields the Audit is allowed to expose for a `task.gate` event. */
const ALLOWED_GATE_SUMMARY_KEYS = new Set([
	"gateId",
	"taskId",
	"stageId",
	"stageRevision",
	"action",
	"status",
	"revision",
	"requestedAt",
	"decidedAt",
	"runId",
	"actorId",
	"reasonCode",
]);

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

	it("emits the same failed deadline transcript over stdio and TCP", async () => {
		const runtimeOptions: RuntimeHostOptions = { streamDelayMs: 2000 };
		const stdio = await startStdioRpcMode(runtimeOptions);
		const stdioDeadlineAt = new Date(Date.now() + 1000).toISOString();
		let stdioTranscript: ParsedRecord[];
		try {
			stdioTranscript = await collectTranscript(stdio, { deadlineAt: stdioDeadlineAt, terminalType: "run.failed" });
			assertStrictJsonlLines(rpcIo.outputLines);
			assertDeadlineTranscript(stdioTranscript, stdioDeadlineAt);
		} finally {
			await stdio.cleanup();
		}

		const tcp = await startTcpRpcMode(runtimeOptions);
		const tcpDeadlineAt = new Date(Date.now() + 1000).toISOString();
		let tcpTranscript: ParsedRecord[];
		try {
			tcpTranscript = await collectTranscript(tcp, { deadlineAt: tcpDeadlineAt, terminalType: "run.failed" });
			// TCP diagnostics belong on stderr; no RPC JSONL record may reach stdout.
			expect(rpcIo.outputLines).toEqual([]);
			assertDeadlineTranscript(tcpTranscript, tcpDeadlineAt);
		} finally {
			await tcp.cleanup();
		}

		expect(publicRecordTypes(stdioTranscript!)).toEqual(publicRecordTypes(tcpTranscript!));
		expect(automationResponseSignatures(stdioTranscript!)).toEqual(automationResponseSignatures(tcpTranscript!));
		expect(normalizePublicTranscript(stdioTranscript!)).toEqual(normalizePublicTranscript(tcpTranscript!));
	});

	it("emits the same Task Gate control-plane transcript over stdio and TCP", async () => {
		const stdio = await startStdioRpcMode();
		let stdioTranscript: ParsedRecord[];
		try {
			stdioTranscript = await collectTaskGateTranscript(stdio);
			assertStrictJsonlLines(rpcIo.outputLines);
		} finally {
			await stdio.cleanup();
		}

		const tcp = await startTcpRpcMode();
		let tcpTranscript: ParsedRecord[];
		try {
			tcpTranscript = await collectTaskGateTranscript(tcp);
			// TCP diagnostics belong on stderr; no RPC JSONL record may reach stdout.
			expect(rpcIo.outputLines).toEqual([]);
		} finally {
			await tcp.cleanup();
		}

		for (const transcript of [stdioTranscript!, tcpTranscript!]) {
			assertAutomationResponseShape(transcript);
			assertTaskGateTranscript(transcript);
		}
		expect(publicRecordTypes(stdioTranscript!)).toEqual(publicRecordTypes(tcpTranscript!));
		expect(automationResponseSignatures(stdioTranscript!)).toEqual(automationResponseSignatures(tcpTranscript!));
		expect(normalizePublicTranscript(stdioTranscript!)).toEqual(normalizePublicTranscript(tcpTranscript!));
	});
});
