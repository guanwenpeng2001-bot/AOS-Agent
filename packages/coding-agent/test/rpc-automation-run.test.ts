import { existsSync, mkdirSync, rmSync } from "node:fs";
import { once } from "node:events";
import { createConnection, createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Writable } from "node:stream";
import { Agent } from "@aos-agent/agent-core";
import { type AssistantMessage, type AssistantMessageEvent, EventStream, type Model } from "@aos-agent/ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Type } from "typebox";
import { AgentSession } from "../src/core/agent-session.ts";
import {
	getAgentCanonicalSession,
	getAgentSessionLedger,
	type AgentSessionLedgerProjection,
} from "../src/core/agent-session-facade.ts";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { createBindingHandle } from "../src/core/binding-handles.ts";
import { CapabilityError, type CapabilityBinding } from "../src/core/capability-registry.ts";
import { createExtensionRuntime } from "../src/core/extensions/loader.ts";
import type { Extension, ExtensionContext, ToolDefinition } from "../src/core/extensions/index.ts";
import type { ModelRuntime } from "../src/core/model-runtime.ts";
import type { ResourceLoader } from "../src/core/resource-loader.ts";
import { RUN_LEDGER_CUSTOM_TYPE } from "../src/core/run-lifecycle.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { RpcClient, type RpcRunStreamEvent } from "../src/modes/rpc/rpc-client.ts";
import { RpcHostController, type RpcHostOutputRecord, type RpcHostOutputSink } from "../src/modes/rpc/rpc-host.ts";
import { runRpcMode } from "../src/modes/rpc/rpc-mode.ts";
import {
	createRpcTransport,
	type RpcTransportConnection,
	type RpcTransport,
} from "../src/modes/rpc/rpc-transport.ts";
import { attachJsonlLineReader } from "../src/modes/rpc/jsonl.ts";
import type { RpcCommand, RpcExtensionUIResponse } from "../src/modes/rpc/rpc-types.ts";
import type { TcpRpcAddress } from "../src/modes/rpc/rpc-transport-address.ts";
import type { Skill } from "../src/core/skills.ts";
import { createSyntheticSourceInfo } from "../src/core/source-info.ts";
import { writeCanonicalRunResult } from "./support/canonical-run-terminal.ts";

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

// agent-session.ts statically imports values from @aos-agent/ai/compat, whose
// entrypoint pulls in a gitignored generated catalog that is absent under
// `npm ci --ignore-scripts`. Mock only the symbols the exercised paths touch;
// compaction-only helpers are stubs.
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
// for bundling; an empty mock avoids loading its generated catalog.
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

/** Provider errors are surfaced as a final assistant message with stopReason "error" and errorMessage. */
function createErrorMessage(text: string): AssistantMessage {
	return { ...createAssistantMessage(""), stopReason: "error", errorMessage: text };
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

const OPAQUE_SOURCE_ID = `source:${"s".repeat(43)}`;
const OPAQUE_BINDING_ID = `binding:${"b".repeat(43)}`;
const OPAQUE_APPROVAL_BINDING_ID = `binding:${"a".repeat(43)}`;
const OPAQUE_REVISION_ID = `rev:${"r".repeat(43)}`;

/** Metadata-only opaque binding injected via getActiveCapabilityBinding spies. */
const BINDING: CapabilityBinding = {
	id: OPAQUE_BINDING_ID,
	profile: "default",
	createdAt: "2026-08-11T00:00:00.000Z",
	descriptors: [
		{ id: `builtin_tool:${OPAQUE_SOURCE_ID}:read`, revision: OPAQUE_REVISION_ID, exposedToolName: "Read" },
	],
	decisionSummary: { allowed: 1, awaitingApproval: 0, denied: 0 },
	toolAllowlist: ["Read"],
};

/** A binding whose profile leaves an ask capability unapproved (headless must fail). */
const APPROVAL_BINDING: CapabilityBinding = {
	...BINDING,
	id: OPAQUE_APPROVAL_BINDING_ID,
	decisionSummary: { allowed: 1, awaitingApproval: 1, denied: 0 },
};

const PENDING_EDITOR_EXTENSION: Extension = {
	path: "<test:pending-editor>",
	resolvedPath: "<test:pending-editor>",
	sourceInfo: createSyntheticSourceInfo("<test:pending-editor>", { source: "test" }),
	handlers: new Map([
		[
			"agent_start",
			[
				async (...args: unknown[]): Promise<void> => {
					const context = args[1] as ExtensionContext;
					await context.ui.editor("Unanswered editor request");
				},
			],
		],
	]),
	tools: new Map(),
	messageRenderers: new Map(),
	commands: new Map(),
	flags: new Map(),
	shortcuts: new Map(),
};

/** Minimal ResourceLoader with no compat/generated-catalog imports. */
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

interface ConsoleErrorSpy {
	readonly mock: { readonly calls: readonly unknown[][] };
	mockRestore(): void;
}

function parseOutputLines(outputLines: string[]): ParsedOutputLine[] {
	return outputLines
		.flatMap((line) => line.split("\n"))
		.filter((line) => line.trim().length > 0)
		.map((line) => JSON.parse(line) as ParsedOutputLine);
}

function currentLines(): ParsedOutputLine[] {
	return parseOutputLines(rpcIo.outputLines);
}

function responsesFor(outputLines: string[], id: string): ParsedOutputLine[] {
	return parseOutputLines(outputLines).filter((record) => record.id === id && record.type === "response");
}

function runEventsOfType(lines: ParsedOutputLine[], type: string): ParsedOutputLine[] {
	return lines.filter((record) => record.type === type);
}

function terminalEvents(lines: ParsedOutputLine[]): ParsedOutputLine[] {
	return lines.filter(
		(record) => record.type === "run.completed" || record.type === "run.failed" || record.type === "run.cancelled",
	);
}

interface BusinessTerminal {
	readonly status: string;
	readonly usage?: { readonly input: number; readonly output: number; readonly total: number };
	readonly terminalError?: { readonly code: string; readonly retryable?: boolean };
}

function businessTerminalView(terminal: BusinessTerminal) {
	return {
		status: terminal.status,
		usage: terminal.usage,
		terminalError:
			terminal.terminalError === undefined
				? undefined
				: { code: terminal.terminalError.code, retryable: terminal.terminalError.retryable },
	};
}

function sessionLedger(session: AgentSession): AgentSessionLedgerProjection {
	return getAgentSessionLedger(session);
}

function transportRunRecord(sessionManager: AgentSessionLedgerProjection, runId: string): Record<string, unknown> | undefined {
	for (const entry of sessionManager.getEntries()) {
		if (entry.type !== "custom" || entry.customType !== RUN_LEDGER_CUSTOM_TYPE) continue;
		const data = entry.data as { kind?: string; record?: Record<string, unknown> };
		if (data.kind === "accepted" && data.record?.id === runId) return data.record;
	}
	return undefined;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function createRuntimeHost(options: {
	withAuth: boolean;
	responseDelayMs: number;
	model?: Model<"anthropic-messages">;
	streamErrorMessage?: string;
	customTools?: ToolDefinition[];
	resourceLoader?: ResourceLoader;
}): Promise<{ runtimeHost: AgentSessionRuntime; cleanup: () => Promise<void> }> {
	const tempDir = join(tmpdir(), `aos-rpc-automation-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tempDir, { recursive: true });

	const model = options.model ?? DEFAULT_MODEL;

	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: {
			model,
			systemPrompt: "Test",
			tools: [],
		},
		streamFn: (_model, _context, _options) => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				stream.push({ type: "start", partial: createAssistantMessage("") });
				setTimeout(() => {
					if (options.streamErrorMessage !== undefined) {
						stream.push({
							type: "error",
							reason: "error",
							error: createErrorMessage(options.streamErrorMessage),
						});
					} else {
						stream.push({ type: "done", reason: "stop", message: createAssistantMessage("done") });
					}
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
	const resourceLoader = options.resourceLoader ?? testResourceLoader();

	const openSession = (sessionManager: SessionManager): AgentSession => {
		return new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRuntime,
			resourceLoader,
			customTools: options.customTools,
		});
	};

	let currentSession = openSession(SessionManager.create(tempDir));
	let rebindCallback: (() => Promise<void>) | undefined;

	const runtimeHost = {
		get session(): AgentSession {
			return currentSession;
		},
		set session(next: AgentSession) {
			currentSession = next;
		},
		setRebindSession: vi.fn((cb?: (() => Promise<void>) | undefined) => {
			rebindCallback = cb;
		}),
		switchSession: vi.fn(async (sessionPath: string) => {
			// Simulate a real session switch: open the persisted ledger, rebuild the
			// session, and re-run the registered rebind so rpc-mode restores/rebuilds
			// its coordinator against the restored session's ledger.
			currentSession = openSession(SessionManager.open(sessionPath));
			if (rebindCallback !== undefined) {
				await rebindCallback();
			}
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
				if (currentSession.isStreaming) {
					await currentSession.abort();
				}
			} catch {
				// ignore test cleanup failures
			}
			currentSession.dispose();
			if (existsSync(tempDir)) {
				rmSync(tempDir, { recursive: true, force: true });
			}
		},
	};
}

async function startRpcMode(options: {
	withAuth: boolean;
	responseDelayMs: number;
	model?: Model<"anthropic-messages">;
	streamErrorMessage?: string;
	customTools?: ToolDefinition[];
	resourceLoader?: ResourceLoader;
}): Promise<{
	lineHandler: (line: string) => void;
	cleanup: () => Promise<void>;
	runtimeHost: AgentSessionRuntime;
}> {
	rpcIo.outputLines = [];
	rpcIo.lineHandler = undefined;

	// runRpcMode is intentionally process-long-lived. Capture only the listeners
	// this local harness adds so each case can clean them without disturbing the
	// Vitest worker or unrelated test suites.
	const signalNames: NodeJS.Signals[] = process.platform === "win32" ? ["SIGTERM"] : ["SIGTERM", "SIGHUP"];
	const signalListenersBefore = new Map(signalNames.map((signal) => [signal, new Set(process.listeners(signal))]));
	const stdinEndListenersBefore = new Set(process.stdin.listeners("end"));
	const { runtimeHost, cleanup } = await createRuntimeHost(options);
	void runRpcMode(runtimeHost);
	await vi.waitFor(() => expect(rpcIo.lineHandler).toBeDefined());

	return {
		lineHandler: rpcIo.lineHandler!,
		cleanup: async () => {
			await cleanup();
			for (const [signal, listenersBefore] of signalListenersBefore) {
				for (const listener of process.listeners(signal)) {
					if (!listenersBefore.has(listener)) process.off(signal, listener as (...args: unknown[]) => void);
				}
			}
			for (const listener of process.stdin.listeners("end")) {
				if (!stdinEndListenersBefore.has(listener)) process.stdin.off("end", listener as (...args: unknown[]) => void);
			}
		},
		runtimeHost,
	};
}

async function startInMemoryController(options: {
	withAuth: boolean;
	responseDelayMs: number;
	model?: Model<"anthropic-messages">;
	streamErrorMessage?: string;
	customTools?: ToolDefinition[];
	resourceLoader?: ResourceLoader;
}, outputSink?: RpcHostOutputSink): Promise<{
	controller: RpcHostController;
	runtimeHost: AgentSessionRuntime;
	records: RpcHostOutputRecord[];
	cleanup: () => Promise<void>;
}> {
	const { runtimeHost, cleanup } = await createRuntimeHost(options);
	const records: RpcHostOutputRecord[] = [];
	const controller = new RpcHostController(runtimeHost, {
		output: outputSink ?? { publish: (record) => records.push(record) },
	});
	await controller.start();
	return { controller, runtimeHost, records, cleanup };
}

async function startTcpRpcMode(options: {
	withAuth: boolean;
	responseDelayMs: number;
	model?: Model<"anthropic-messages">;
	resourceLoader?: ResourceLoader;
}): Promise<{ port: number; diagnostics: ConsoleErrorSpy; cleanup: () => Promise<void> }> {
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

	return {
		port,
		diagnostics,
		cleanup: async () => {
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

type TcpRpcTestCommand = RpcCommand | RpcExtensionUIResponse;

interface TcpPeer {
	readonly socket: Socket;
	readonly records: ParsedOutputLine[];
	readonly nextRecord: () => Promise<ParsedOutputLine>;
}

async function connectTcpPeer(address: TcpRpcAddress): Promise<TcpPeer> {
	const socket = createConnection({ host: address.host, port: address.port });
	await once(socket, "connect");
	const records: ParsedOutputLine[] = [];
	const waiters: Array<(record: ParsedOutputLine) => void> = [];
	attachJsonlLineReader(socket, (line) => {
		const record = JSON.parse(line) as ParsedOutputLine;
		const waiter = waiters.shift();
		if (waiter === undefined) records.push(record);
		else waiter(record);
	});
	return {
		socket,
		records,
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

async function startTcpController(options: {
	withAuth: boolean;
	responseDelayMs: number;
	model?: Model<"anthropic-messages">;
	resourceLoader?: ResourceLoader;
}): Promise<{
	controller: RpcHostController;
	runtimeHost: AgentSessionRuntime;
	transport: RpcTransport<TcpRpcTestCommand, RpcHostOutputRecord>;
	address: TcpRpcAddress;
	cleanup: () => Promise<void>;
}> {
	let activeConnection: RpcTransportConnection<TcpRpcTestCommand, RpcHostOutputRecord> | undefined;
	let detachPromise = Promise.resolve();
	const pendingWrites = new Set<Promise<void>>();
	const output = {
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
	const transport = createRpcTransport<TcpRpcTestCommand, RpcHostOutputRecord>({
		address: { transport: "tcp", host: "127.0.0.1", port },
		parseCommand: (value) => {
			if (typeof value !== "object" || value === null || typeof (value as { type?: unknown }).type !== "string") {
				throw new TypeError("RPC command must include a string type");
			}
			return value as TcpRpcTestCommand;
		},
		dispatch: async (command) => {
			await detachPromise;
			if (command.type === "extension_ui_response") {
				controller.handleExtensionUIResponse(command);
				return;
			}
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

/**
 * Automation Host v1 run lifecycle over RPC mode.
 *
 * Hydration note: this suite imports only the core `@aos-agent/ai` entrypoint and
 * a minimal local ResourceLoader, so it runs under `npm ci --ignore-scripts`
 * without generated model catalogs. run.resume is exercised through a mock
 * runtimeHost whose switchSession opens the persisted session and re-runs the
 * registered rebind callback, exercising rpc-mode's actual restore/rebuild path.
 */
describe("RPC Automation Host run lifecycle", () => {
	afterEach(() => {
		rpcIo.outputLines = [];
		rpcIo.lineHandler = undefined;
	});

	it("rejects an unsupported initialize protocol version", async () => {
		const { lineHandler, cleanup } = await startRpcMode({ withAuth: true, responseDelayMs: 0 });

		try {
			lineHandler(JSON.stringify({ id: "i0", type: "initialize", protocolVersion: 2 }));

			await vi.waitFor(() => expect(responsesFor(rpcIo.outputLines, "i0")).toHaveLength(1));
			const res = responsesFor(rpcIo.outputLines, "i0")[0];
			expect(res).toMatchObject({ id: "i0", type: "response", command: "initialize", success: false });
			expect((res.error as { code: string }).code).toBe("unsupported_protocol_version");
		} finally {
			await cleanup();
		}
	});

	it("dispatches commands and run records through an in-memory output sink", async () => {
		const { controller, records, cleanup } = await startInMemoryController({ withAuth: true, responseDelayMs: 0 });

		try {
			await controller.handleCommand({ id: "i-memory", type: "initialize", protocolVersion: 1 });
			const initialize = records.find((record) => record.type === "response" && record.id === "i-memory");
			expect(initialize).toMatchObject({ command: "initialize", success: true });

			await controller.handleCommand({ id: "r-memory", type: "run.start", message: "Hello" });
			await vi.waitFor(() => expect(records.some((record) => record.type === "run.completed")).toBe(true));
			expect(records.some((record) => record.type === "run.started")).toBe(true);
			expect(records.some((record) => record.type === "run.event")).toBe(true);
			expect(records.every((record) => typeof record === "object")).toBe(true);
		} finally {
			await controller.shutdown();
			await cleanup();
		}
	});

	it("delivers one continuous production run stream through RpcClient replay recovery", async () => {
		const harness = await startTcpController({ withAuth: true, responseDelayMs: 0 });
		const client = new RpcClient({ tcp: { host: harness.address.host, port: harness.address.port } });
		const events: RpcRunStreamEvent[] = [];
		client.onRunEvent((event) => events.push(event));

		try {
			await client.start();
			await client.initializeAutomationHost();
			const accepted = await client.startRun("Hello");
			await vi.waitFor(() => expect(events.some((event) => event.type === "run.completed")).toBe(true));
			const recovery = client.createRunReplayRecovery(accepted.runId, { sessionId: accepted.sessionId });
			const consumed = events.map((event) => recovery.consumeRunEvent(event));

			expect(events[0]?.type).toBe("run.started");
			expect(events.at(-1)?.type).toBe("run.completed");
			expect(events.map((event) => event.sequence)).toEqual(events.map((_, index) => index + 1));
			expect(consumed.every((result) => result.disposition === "accepted")).toBe(true);
			expect(recovery.getState()).toMatchObject({
				lastEventSequence: events.length,
				terminal: { status: "completed", source: "run.event", sequence: events.length },
			});
			expect(recovery.getState().gap).toBeUndefined();
		} finally {
			await client.stop();
			await harness.cleanup();
		}
	});

	it("advertises the v1 host contract on initialize", async () => {
		const { lineHandler, cleanup } = await startRpcMode({ withAuth: true, responseDelayMs: 0 });

		try {
			lineHandler(JSON.stringify({ id: "i1", type: "initialize", protocolVersion: 1 }));

			await vi.waitFor(() => expect(responsesFor(rpcIo.outputLines, "i1")).toHaveLength(1));
			const res = responsesFor(rpcIo.outputLines, "i1")[0];
			expect(res).toMatchObject({
				id: "i1",
				type: "response",
				command: "initialize",
				success: true,
			});
			const data = res.data as {
				host: string;
				protocolVersion: number;
				sessionId: string;
				runCommands: string[];
			};
			expect(data.host).toBe("automation-host");
			expect(data.protocolVersion).toBe(1);
			expect(data.sessionId).toBeTruthy();
			expect(data.runCommands).toEqual(["run.start", "run.get", "run.cancel", "run.resume"]);
		} finally {
			await cleanup();
		}
	});

	it("keeps TCP RPC records off stdout and listener diagnostics on stderr", async () => {
		rpcIo.outputLines = [];
		const { port, diagnostics, cleanup } = await startTcpRpcMode({ withAuth: true, responseDelayMs: 0 });

		try {
			expect(rpcIo.outputLines).toEqual([]);
			expect(diagnostics.mock.calls.flat().join("\n")).toContain(`RPC TCP listening on tcp://127.0.0.1:${port}`);
			expect(diagnostics.mock.calls.flat().join("\n")).not.toContain('"type":"response"');
		} finally {
			await cleanup();
		}
	});

	it("serves automation commands over TCP and reconnects without replaying live events", async () => {
		const harness = await startTcpController({ withAuth: true, responseDelayMs: 100 });
		let first: TcpPeer | undefined;
		let second: TcpPeer | undefined;
		try {
			first = await connectTcpPeer(harness.address);
			await writeTcpRecord(first.socket, { id: "tcp-init", type: "initialize", protocolVersion: 1 });
			const initialize = await first.nextRecord();
			expect(initialize).toMatchObject({ id: "tcp-init", command: "initialize", success: true });
			const sessionId = (initialize.data as { sessionId: string }).sessionId;

			const external = { namespace: "ci", externalSessionId: "tcp-job", externalRunId: "tcp-attempt" };
			await writeTcpRecord(first.socket, { id: "tcp-run", type: "run.start", message: "Hello", external });
			const accepted = await first.nextRecord();
			expect(accepted).toMatchObject({ id: "tcp-run", command: "run.start", success: true });
			const runId = (accepted.data as { runId: string }).runId;

			first.socket.destroy();
			await vi.waitFor(() => expect(harness.transport.activeConnection).toBeUndefined());

			second = await connectTcpPeer(harness.address);
			expect(second.records).toEqual([]);
			await writeTcpRecord(second.socket, { id: "tcp-reinit", type: "initialize", protocolVersion: 1 });
			expect(await second.nextRecord()).toMatchObject({ id: "tcp-reinit", command: "initialize", success: true });

			await writeTcpRecord(second.socket, { id: "tcp-get", type: "run.get", runId });
			const runGet = await second.nextRecord();
			expect(runGet).toMatchObject({ id: "tcp-get", command: "run.get", success: true });
			expect((runGet.data as { run: { status: string } }).run.status).toBe("cancelled");

			await writeTcpRecord(second.socket, {
				id: "tcp-audit",
				type: "audit.query",
				scope: "current-session",
				types: ["run.cancelled"],
			});
			const audit = await second.nextRecord();
			expect(audit).toMatchObject({ id: "tcp-audit", command: "audit.query", success: true });
			expect((audit.data as { events: Array<{ type: string }> }).events).toEqual(
				expect.arrayContaining([expect.objectContaining({ type: "run.cancelled" })]),
			);

			await writeTcpRecord(second.socket, {
				id: "tcp-replay",
				type: "audit.replay",
				runId,
				scope: "current-session",
			});
			const replay = await second.nextRecord();
			expect(replay.data).toMatchObject({ status: "complete" });

			await writeTcpRecord(second.socket, {
				id: "tcp-map",
				type: "external.map",
				external,
				aosSessionId: sessionId,
				aosRunId: runId,
			});
			expect(await second.nextRecord()).toMatchObject({ id: "tcp-map", command: "external.map", success: true });
		} finally {
			first?.socket.destroy();
			second?.socket.destroy();
			await harness.cleanup();
		}
	});

	it("settles a pending editor before TCP detach and preserves one authoritative terminal", async () => {
		const resourceLoader: ResourceLoader = {
			...testResourceLoader(),
			getExtensions: () => ({
				extensions: [PENDING_EDITOR_EXTENSION],
				errors: [],
				runtime: createExtensionRuntime(),
			}),
		};
		const harness = await startTcpController({ withAuth: true, responseDelayMs: 100, resourceLoader });
		let first: TcpPeer | undefined;
		let second: TcpPeer | undefined;
		try {
			first = await connectTcpPeer(harness.address);
			await writeTcpRecord(first.socket, { id: "pending-editor-init", type: "initialize", protocolVersion: 1 });
			expect(await first.nextRecord()).toMatchObject({ id: "pending-editor-init", success: true });

			await writeTcpRecord(first.socket, { id: "pending-editor-run", type: "run.start", message: "Hello" });
			const accepted = await first.nextRecord();
			expect(accepted).toMatchObject({ id: "pending-editor-run", command: "run.start", success: true });
			const runId = (accepted.data as { runId: string }).runId;
			expect(await first.nextRecord()).toMatchObject({ type: "run.started", runId });
			const editorRequest = await first.nextRecord();
			expect(editorRequest).toMatchObject({ type: "extension_ui_request", method: "editor" });

			first.socket.destroy();
			await vi.waitFor(() => expect(harness.transport.activeConnection).toBeUndefined());

			second = await connectTcpPeer(harness.address);
			await writeTcpRecord(second.socket, { id: "pending-editor-reinit", type: "initialize", protocolVersion: 1 });
			expect(await second.nextRecord()).toMatchObject({ id: "pending-editor-reinit", success: true });

			await writeTcpRecord(second.socket, { id: "pending-editor-get", type: "run.get", runId });
			const runGet = await second.nextRecord();
			expect(runGet).toMatchObject({
				id: "pending-editor-get",
				command: "run.get",
				success: true,
				data: { run: { id: runId, status: "cancelled" }, receipt: { runId, status: "cancelled" } },
			});

			const ledgerEntries = sessionLedger(harness.runtimeHost.session)
				.getEntries()
				.filter((entry) => entry.type === "custom" && entry.customType === RUN_LEDGER_CUSTOM_TYPE);
			expect(ledgerEntries).toHaveLength(2);
			expect(
				ledgerEntries.some((entry) => entry.type === "custom" && (entry.data as { kind?: string }).kind === "terminal"),
			).toBe(false);
		} finally {
			first?.socket.destroy();
			second?.socket.destroy();
			await harness.cleanup();
		}
	});

	it("does not accept a resume after TCP disconnect during session switching", async () => {
		const harness = await startTcpController({ withAuth: true, responseDelayMs: 0 });
		let first: TcpPeer | undefined;
		let second: TcpPeer | undefined;
		let releaseSwitch = (): void => {};
		let restoreSwitch: (() => void) | undefined;
		try {
			first = await connectTcpPeer(harness.address);
			await writeTcpRecord(first.socket, { id: "resume-race-init", type: "initialize", protocolVersion: 1 });
			expect(await first.nextRecord()).toMatchObject({ id: "resume-race-init", success: true });

			await writeTcpRecord(first.socket, { id: "resume-race-seed", type: "run.start", message: "Seed" });
			const seedAccepted = await first.nextRecord();
			const sourceRunId = (seedAccepted.data as { runId: string }).runId;
			await vi.waitFor(() =>
				expect(
					first!.records.some(
						(record) =>
							record.type === "run.completed" ||
							record.type === "run.failed" ||
							record.type === "run.cancelled",
					),
				).toBe(true),
			);
			const seedRunLedgerCount = sessionLedger(harness.runtimeHost.session)
				.getEntries()
				.filter((entry) => entry.type === "custom" && entry.customType === RUN_LEDGER_CUSTOM_TYPE).length;

			const sessionPath = harness.runtimeHost.session.sessionFile;
			expect(sessionPath).toBeTruthy();
			let resolveSwitchStarted!: () => void;
			const switchStarted = new Promise<void>((resolve) => {
				resolveSwitchStarted = resolve;
			});
			let resolveSwitchFinished!: () => void;
			const switchFinished = new Promise<void>((resolve) => {
				resolveSwitchFinished = resolve;
			});
			const switchGate = new Promise<void>((resolve) => {
				releaseSwitch = resolve;
			});
			const originalSwitchSession = vi.mocked(harness.runtimeHost.switchSession).getMockImplementation();
			expect(originalSwitchSession).toBeDefined();
			const switchSpy = vi.spyOn(harness.runtimeHost, "switchSession").mockImplementation(async (path, options) => {
				resolveSwitchStarted();
				await switchGate;
				try {
					return await originalSwitchSession!(path, options);
				} finally {
					resolveSwitchFinished();
				}
			});
			restoreSwitch = () => switchSpy.mockRestore();

			await writeTcpRecord(first.socket, {
				id: "resume-race",
				type: "run.resume",
				sessionPath: sessionPath!,
				sourceRunId,
				message: "Continue",
			});
			await switchStarted;

			first.socket.destroy();
			await vi.waitFor(() => expect(harness.transport.activeConnection).toBeUndefined());
			releaseSwitch();
			await switchFinished;

			const runLedgerEntries = sessionLedger(harness.runtimeHost.session)
				.getEntries()
				.filter((entry) => entry.type === "custom" && entry.customType === RUN_LEDGER_CUSTOM_TYPE);
			expect(runLedgerEntries).toHaveLength(seedRunLedgerCount);

			second = await connectTcpPeer(harness.address);
			await writeTcpRecord(second.socket, { id: "resume-race-reinit", type: "initialize", protocolVersion: 1 });
			expect(await second.nextRecord()).toMatchObject({ id: "resume-race-reinit", success: true });
			await writeTcpRecord(second.socket, { id: "resume-race-get", type: "run.get", runId: sourceRunId });
			expect(await second.nextRecord()).toMatchObject({ id: "resume-race-get", success: true });
		} finally {
			releaseSwitch();
			restoreSwitch?.();
			first?.socket.destroy();
			second?.socket.destroy();
			await harness.cleanup();
		}
	});

	it("serves redacted audit query/replay and external mapping without execution side effects", async () => {
		const { lineHandler, cleanup, runtimeHost } = await startRpcMode({ withAuth: true, responseDelayMs: 0 });

		try {
			lineHandler(JSON.stringify({ id: "i-audit", type: "initialize", protocolVersion: 1 }));
			await vi.waitFor(() => expect(responsesFor(rpcIo.outputLines, "i-audit")).toHaveLength(1));
			expect(
				(responsesFor(rpcIo.outputLines, "i-audit")[0].data as { auditCommands: string[] }).auditCommands,
			).toEqual(["audit.query", "audit.replay", "external.map"]);

			const external = { namespace: "ci", externalSessionId: "job-1", externalRunId: "attempt-1" };
			lineHandler(JSON.stringify({ id: "run-audit", type: "run.start", message: "Hello", external }));
			let runId: string;
			await vi.waitFor(() => {
				const response = responsesFor(rpcIo.outputLines, "run-audit")[0];
				expect(response?.success).toBe(true);
				runId = (response.data as { runId: string }).runId;
				expect((response.data as { external?: typeof external }).external).toEqual(external);
			});
			await vi.waitFor(() => expect(terminalEvents(currentLines())).toHaveLength(1));

			// Unknown custom data is deliberately present in the Session, but the audit
			// response must expose only its stable warning code.
			sessionLedger(runtimeHost.session).appendCustomEntry("unknown.source", { raw: "sensitive-payload" });
			const promptSpy = vi.spyOn(runtimeHost.session, "prompt");
			const appendSpy = vi.spyOn(sessionLedger(runtimeHost.session), "appendCustomEntry");

			lineHandler(
				JSON.stringify({
					id: "audit-query",
					type: "audit.query",
					scope: "current-session",
					types: ["run.completed"],
					limit: 10,
				}),
			);
			await vi.waitFor(() => expect(responsesFor(rpcIo.outputLines, "audit-query")).toHaveLength(1));
			const queryResponse = responsesFor(rpcIo.outputLines, "audit-query")[0];
			expect(queryResponse.success).toBe(true);
			expect(JSON.stringify(queryResponse)).not.toContain("sensitive-payload");
			expect(
				(queryResponse.data as { events: Array<{ type: string }>; warnings: Array<{ code: string }> }).events,
			).toEqual(expect.arrayContaining([expect.objectContaining({ type: "run.completed" })]));
			expect((queryResponse.data as { warnings: Array<{ code: string }> }).warnings).toEqual(
				expect.arrayContaining([expect.objectContaining({ code: "unknown_source" })]),
			);

			lineHandler(
				JSON.stringify({ id: "audit-replay", type: "audit.replay", runId: runId!, scope: "current-session" }),
			);
			await vi.waitFor(() => expect(responsesFor(rpcIo.outputLines, "audit-replay")).toHaveLength(1));
			const replayResponse = responsesFor(rpcIo.outputLines, "audit-replay")[0];
			expect(replayResponse.success).toBe(true);
			expect((replayResponse.data as { status: string }).status).toBe("complete");

			lineHandler(JSON.stringify({ id: "audit-invalid", type: "audit.query", scope: "invalid-scope" }));
			await vi.waitFor(() => expect(responsesFor(rpcIo.outputLines, "audit-invalid")).toHaveLength(1));
			expect((responsesFor(rpcIo.outputLines, "audit-invalid")[0].error as { code: string }).code).toBe(
				"audit_query_invalid",
			);

			lineHandler(
				JSON.stringify({ id: "audit-cursor", type: "audit.query", scope: "current-session", cursor: "bad" }),
			);
			await vi.waitFor(() => expect(responsesFor(rpcIo.outputLines, "audit-cursor")).toHaveLength(1));
			expect((responsesFor(rpcIo.outputLines, "audit-cursor")[0].error as { code: string }).code).toBe(
				"audit_cursor_invalid",
			);

			lineHandler(JSON.stringify({ id: "audit-missing", type: "audit.replay", runId: "missing-run" }));
			await vi.waitFor(() => expect(responsesFor(rpcIo.outputLines, "audit-missing")).toHaveLength(1));
			expect((responsesFor(rpcIo.outputLines, "audit-missing")[0].error as { code: string }).code).toBe(
				"audit_run_not_found",
			);

			lineHandler(
				JSON.stringify({
					id: "map-idempotent",
					type: "external.map",
					external,
					aosSessionId: runtimeHost.session.sessionId,
					aosRunId: runId!,
				}),
			);
			await vi.waitFor(() => expect(responsesFor(rpcIo.outputLines, "map-idempotent")).toHaveLength(1));
			const idempotentResponse = responsesFor(rpcIo.outputLines, "map-idempotent")[0];
			expect(idempotentResponse).toMatchObject({ success: true, data: { idempotent: true } });

			lineHandler(
				JSON.stringify({
					id: "map-conflict",
					type: "external.map",
					external: { namespace: "ci", externalSessionId: "job-2", externalRunId: "attempt-2" },
					aosSessionId: runtimeHost.session.sessionId,
					aosRunId: runId!,
				}),
			);
			await vi.waitFor(() => expect(responsesFor(rpcIo.outputLines, "map-conflict")).toHaveLength(1));
			const conflict = responsesFor(rpcIo.outputLines, "map-conflict")[0];
			expect(conflict.success).toBe(false);
			expect((conflict.error as { code: string }).code).toBe("external_mapping_conflict");
			expect(JSON.stringify(conflict)).not.toContain("job-2");
			expect(promptSpy).not.toHaveBeenCalled();
			expect(appendSpy).not.toHaveBeenCalled();
		} finally {
			await cleanup();
		}
	});

	it("returns a redacted ModelBroker route catalog", async () => {
		const { lineHandler, cleanup } = await startRpcMode({ withAuth: true, responseDelayMs: 0 });

		try {
			lineHandler(JSON.stringify({ id: "routes", type: "get_model_routes" }));

			await vi.waitFor(() => expect(responsesFor(rpcIo.outputLines, "routes")).toHaveLength(1));
			const response = responsesFor(rpcIo.outputLines, "routes")[0];
			expect(response).toMatchObject({ id: "routes", type: "response", command: "get_model_routes", success: true });
			expect(response.data).toEqual({
				schemaVersion: 1,
				models: [],
				routes: [],
				roles: [],
				roleRoutes: [],
				bindings: [],
			});
			expect(JSON.stringify(response)).not.toContain("apiKey");
		} finally {
			await cleanup();
		}
	});

	it("rejects a run request that combines modelRoute and modelRole", async () => {
		const { lineHandler, cleanup } = await startRpcMode({ withAuth: true, responseDelayMs: 0 });

		try {
			lineHandler(JSON.stringify({ id: "i2", type: "initialize", protocolVersion: 1 }));
			await vi.waitFor(() => expect(responsesFor(rpcIo.outputLines, "i2")).toHaveLength(1));

			lineHandler(
				JSON.stringify({
					id: "both",
					type: "run.start",
					message: "Hello",
					modelRoute: "balanced",
					modelRole: "worker",
				}),
			);
			await vi.waitFor(() => expect(responsesFor(rpcIo.outputLines, "both")).toHaveLength(1));
			const response = responsesFor(rpcIo.outputLines, "both")[0];
			expect(response).toMatchObject({ id: "both", type: "response", command: "run.start", success: false });
			expect((response.error as { code: string }).code).toBe("model_route_invalid");
		} finally {
			await cleanup();
		}
	});

	it("is idempotent when initialize repeats and does not lose an active run", async () => {
		const { lineHandler, cleanup } = await startRpcMode({ withAuth: true, responseDelayMs: 100 });

		try {
			lineHandler(JSON.stringify({ id: "i1", type: "initialize", protocolVersion: 1 }));
			await vi.waitFor(() => expect(responsesFor(rpcIo.outputLines, "i1")).toHaveLength(1));

			lineHandler(JSON.stringify({ id: "r1", type: "run.start", message: "Hello" }));
			await vi.waitFor(() => {
				const res = responsesFor(rpcIo.outputLines, "r1");
				expect(res).toHaveLength(1);
				expect(res[0].success).toBe(true);
			});

			// A repeat initialize mid-run must not reset the coordinator or drop the
			// active run: the run still completes with exactly one terminal.
			lineHandler(JSON.stringify({ id: "i2", type: "initialize", protocolVersion: 1 }));
			await vi.waitFor(() => expect(responsesFor(rpcIo.outputLines, "i2")).toHaveLength(1));
			expect(responsesFor(rpcIo.outputLines, "i2")[0].success).toBe(true);

			await vi.waitFor(() => expect(terminalEvents(currentLines())).toHaveLength(1));
			expect(terminalEvents(currentLines())[0].type).toBe("run.completed");
		} finally {
			await cleanup();
		}
	});

	it("rejects every run command with host_not_initialized before initialize", async () => {
		const { lineHandler, cleanup } = await startRpcMode({ withAuth: true, responseDelayMs: 0 });

		try {
			lineHandler(JSON.stringify({ id: "u1", type: "run.start", message: "Hello" }));
			lineHandler(JSON.stringify({ id: "u2", type: "run.get", runId: "x" }));
			lineHandler(JSON.stringify({ id: "u3", type: "run.cancel", runId: "x" }));
			lineHandler(
				JSON.stringify({
					id: "u4",
					type: "run.resume",
					sessionPath: "/tmp/x.jsonl",
					sourceRunId: "y",
					message: "hi",
				}),
			);

			for (const id of ["u1", "u2", "u3", "u4"]) {
				await vi.waitFor(() => expect(responsesFor(rpcIo.outputLines, id)).toHaveLength(1));
				const res = responsesFor(rpcIo.outputLines, id)[0];
				expect(res.success).toBe(false);
				expect((res.error as { code: string }).code).toBe("host_not_initialized");
			}
		} finally {
			await cleanup();
		}
	});

	it("emits accepted response before run.started, then run.event* and exactly one terminal", async () => {
		const { lineHandler, cleanup } = await startRpcMode({ withAuth: true, responseDelayMs: 0 });

		try {
			lineHandler(JSON.stringify({ id: "i1", type: "initialize", protocolVersion: 1 }));
			await vi.waitFor(() => expect(responsesFor(rpcIo.outputLines, "i1")).toHaveLength(1));

			lineHandler(JSON.stringify({ id: "r2", type: "run.start", message: "Hello" }));

			await vi.waitFor(() => expect(terminalEvents(currentLines())).toHaveLength(1));

			const lines = currentLines();
			const accepted = lines.findIndex(
				(record) => record.id === "r2" && record.type === "response" && record.command === "run.start",
			);
			const firstRun = lines.findIndex(
				(record) => typeof record.type === "string" && record.type.startsWith("run."),
			);
			expect(accepted).toBeGreaterThanOrEqual(0);
			expect(firstRun).toBeGreaterThanOrEqual(0);
			// contract order: accepted response -> run.started -> run.event* -> terminal
			expect(accepted).toBeLessThan(firstRun);

			const acceptedData = lines[accepted].data as { runId: string; status: string; attempt: number };
			expect(acceptedData.status).toBe("accepted");
			expect(acceptedData.attempt).toBe(1);
			expect(acceptedData.runId).toBeTruthy();

			const started = runEventsOfType(lines, "run.started");
			const events = runEventsOfType(lines, "run.event");
			const terminals = terminalEvents(lines);
			expect(started).toHaveLength(1);
			expect(events.length).toBeGreaterThanOrEqual(1);
			expect(terminals).toHaveLength(1);

			const ordered = [...started, ...events, ...terminals];
			expect(ordered[0].type).toBe("run.started");
			expect(ordered[ordered.length - 1].type).toBe("run.completed");
			const sequences = ordered.map((record) => record.sequence as number);
			expect(sequences[0]).toBe(1);
			expect(new Set(sequences).size).toBe(sequences.length);
			for (let i = 1; i < sequences.length; i++) {
				expect(sequences[i]).toBeGreaterThan(sequences[i - 1]);
			}

			expect(typeof (events[0].event as { type?: string }).type).toBe("string");

			const terminal = terminals[0];
			const receipt = terminal.receipt as Record<string, unknown> & { status: string };
			expect(receipt.status).toBe("completed");
			expect("finalText" in receipt).toBe(false);
			expect(events.some((event) => JSON.stringify(event).includes("done"))).toBe(true);

			lineHandler(JSON.stringify({ id: "r2-get", type: "run.get", runId: acceptedData.runId }));
			lineHandler(
				JSON.stringify({
					id: "r2-audit",
					type: "audit.replay",
					runId: acceptedData.runId,
					scope: "current-session",
				}),
			);
			await vi.waitFor(() => {
				expect(responsesFor(rpcIo.outputLines, "r2-get")).toHaveLength(1);
				expect(responsesFor(rpcIo.outputLines, "r2-audit")).toHaveLength(1);
			});
			const getResponse = responsesFor(rpcIo.outputLines, "r2-get")[0];
			const auditResponse = responsesFor(rpcIo.outputLines, "r2-audit")[0];
			expect(getResponse.success).toBe(true);
			expect(auditResponse.success).toBe(true);
			const getReceipt = (getResponse.data as { receipt: BusinessTerminal }).receipt;
			const auditRun = (auditResponse.data as { run: BusinessTerminal }).run;
			const terminalView = businessTerminalView(receipt as unknown as BusinessTerminal);
			expect(businessTerminalView(getReceipt)).toEqual(terminalView);
			expect(businessTerminalView(auditRun)).toEqual(terminalView);
		} finally {
			await cleanup();
		}
	});

	it("replays duplicate run.start from the durable request relation without a second Run", async () => {
		const { lineHandler, cleanup, runtimeHost } = await startRpcMode({ withAuth: true, responseDelayMs: 0 });

		try {
			lineHandler(JSON.stringify({ id: "i1", type: "initialize", protocolVersion: 1 }));
			await vi.waitFor(() => expect(responsesFor(rpcIo.outputLines, "i1")).toHaveLength(1));

			const request = {
				type: "run.start",
				clientRequestId: "start-idempotency-1",
				message: "prompt with secret=never-persisted",
			};
			lineHandler(JSON.stringify({ id: "first", ...request }));
			await vi.waitFor(() => expect(responsesFor(rpcIo.outputLines, "first")[0]?.success).toBe(true));
			await vi.waitFor(() => expect(terminalEvents(currentLines())).toHaveLength(1));

			const firstData = responsesFor(rpcIo.outputLines, "first")[0].data as {
				runId: string;
				status: string;
			};
			const ledgerEntries = () =>
				sessionLedger(runtimeHost.session)
					.getEntries()
					.filter((entry) => entry.type === "custom" && entry.customType === RUN_LEDGER_CUSTOM_TYPE);
			const ledgerCount = ledgerEntries().length;
			const promptSpy = vi.spyOn(runtimeHost.session, "prompt");

			lineHandler(JSON.stringify({ id: "duplicate", ...request }));
			await vi.waitFor(() => expect(responsesFor(rpcIo.outputLines, "duplicate")).toHaveLength(1));
			const duplicate = responsesFor(rpcIo.outputLines, "duplicate")[0];
			expect(duplicate.success).toBe(true);
			expect(duplicate.data).toMatchObject({
				runId: firstData.runId,
				status: "completed",
				idempotent: true,
				receipt: { runId: firstData.runId, status: "completed" },
			});
			expect(promptSpy).not.toHaveBeenCalled();
			expect(terminalEvents(currentLines())).toHaveLength(1);
			expect(ledgerEntries()).toHaveLength(ledgerCount);
			expect(JSON.stringify(ledgerEntries())).not.toContain("secret=never-persisted");
		} finally {
			await cleanup();
		}
	});

	it("returns a stable conflict for same-key run.start with a different fingerprint", async () => {
		const { lineHandler, cleanup, runtimeHost } = await startRpcMode({ withAuth: true, responseDelayMs: 0 });

		try {
			lineHandler(JSON.stringify({ id: "i1", type: "initialize", protocolVersion: 1 }));
			await vi.waitFor(() => expect(responsesFor(rpcIo.outputLines, "i1")).toHaveLength(1));
			lineHandler(
				JSON.stringify({
					id: "first",
					type: "run.start",
					clientRequestId: "start-conflict-1",
					message: "first request",
				}),
			);
			await vi.waitFor(() => expect(responsesFor(rpcIo.outputLines, "first")[0]?.success).toBe(true));
			await vi.waitFor(() => expect(terminalEvents(currentLines())).toHaveLength(1));
			const ledgerCount = sessionLedger(runtimeHost.session)
				.getEntries()
				.filter((entry) => entry.type === "custom" && entry.customType === RUN_LEDGER_CUSTOM_TYPE).length;
			const promptSpy = vi.spyOn(runtimeHost.session, "prompt");

			lineHandler(
				JSON.stringify({
					id: "conflict",
					type: "run.start",
					clientRequestId: "start-conflict-1",
					message: "second request secret=not-public",
				}),
			);
			await vi.waitFor(() => expect(responsesFor(rpcIo.outputLines, "conflict")).toHaveLength(1));
			const conflict = responsesFor(rpcIo.outputLines, "conflict")[0];
			expect(conflict.success).toBe(false);
			expect(conflict.error).toMatchObject({
				code: "client_request_conflict",
				message: "Automation request failed.",
			});
			expect(JSON.stringify(conflict)).not.toContain("not-public");
			expect(promptSpy).not.toHaveBeenCalled();
			expect(terminalEvents(currentLines())).toHaveLength(1);
			expect(
				sessionLedger(runtimeHost.session)
					.getEntries()
					.filter((entry) => entry.type === "custom" && entry.customType === RUN_LEDGER_CUSTOM_TYPE),
			).toHaveLength(ledgerCount);
		} finally {
			await cleanup();
		}
	});

	it("rejects run.start with start_rejected when preflight fails, without a run id or ledger entry", async () => {
		const { lineHandler, cleanup, runtimeHost } = await startRpcMode({ withAuth: false, responseDelayMs: 0 });

		try {
			lineHandler(JSON.stringify({ id: "i1", type: "initialize", protocolVersion: 1 }));
			await vi.waitFor(() => expect(responsesFor(rpcIo.outputLines, "i1")).toHaveLength(1));

			lineHandler(JSON.stringify({ id: "f1", type: "run.start", message: "Hello" }));

			await vi.waitFor(() => expect(responsesFor(rpcIo.outputLines, "f1")).toHaveLength(1));
			const res = responsesFor(rpcIo.outputLines, "f1")[0];
			expect(res.success).toBe(false);
			expect((res.error as { code: string }).code).toBe("start_rejected");
			// no run id, no run.* stream events, and nothing persisted to the ledger
			expect("data" in res).toBe(false);
			expect(
				currentLines().some((record) => typeof record.type === "string" && record.type.startsWith("run.")),
			).toBe(false);
			const ledgerEntries = sessionLedger(runtimeHost.session)
				.getEntries()
				.filter((entry) => entry.type === "custom" && entry.customType === RUN_LEDGER_CUSTOM_TYPE);
			expect(ledgerEntries).toHaveLength(0);
		} finally {
			await cleanup();
		}
	});

	it("rejects slash-command run input before reservation, ledger writes, or Agent execution", async () => {
		const { lineHandler, cleanup, runtimeHost } = await startRpcMode({ withAuth: true, responseDelayMs: 0 });

		try {
			lineHandler(JSON.stringify({ id: "i1", type: "initialize", protocolVersion: 1 }));
			await vi.waitFor(() => expect(responsesFor(rpcIo.outputLines, "i1")).toHaveLength(1));

			lineHandler(JSON.stringify({ id: "slash", type: "run.start", message: "/extension-command" }));
			await vi.waitFor(() => expect(responsesFor(rpcIo.outputLines, "slash")).toHaveLength(1));
			const rejection = responsesFor(rpcIo.outputLines, "slash")[0];
			expect(rejection.success).toBe(false);
			expect((rejection.error as { code: string }).code).toBe("start_rejected");
			expect(
				currentLines().some((record) => typeof record.type === "string" && record.type.startsWith("run.")),
			).toBe(false);
			expect(runEventsOfType(currentLines(), "message_start")).toHaveLength(0);
			expect(
				sessionLedger(runtimeHost.session)
					.getEntries()
					.filter((entry) => entry.type === "custom" && entry.customType === RUN_LEDGER_CUSTOM_TYPE),
			).toHaveLength(0);

			// The early rejection releases no Session ownership and a valid request can
			// start immediately afterwards.
			lineHandler(JSON.stringify({ id: "ordinary", type: "run.start", message: "Hello" }));
			await vi.waitFor(() => expect(responsesFor(rpcIo.outputLines, "ordinary")[0]?.success).toBe(true));
			await vi.waitFor(() => expect(terminalEvents(currentLines())).toHaveLength(1));
		} finally {
			await cleanup();
		}
	});

	it("does not enter the Agent loop when accepted-ledger persistence fails", async () => {
		const { lineHandler, cleanup, runtimeHost } = await startRpcMode({ withAuth: true, responseDelayMs: 0 });

		try {
			lineHandler(JSON.stringify({ id: "i1", type: "initialize", protocolVersion: 1 }));
			await vi.waitFor(() => expect(responsesFor(rpcIo.outputLines, "i1")).toHaveLength(1));

			const sessionManager = sessionLedger(runtimeHost.session);
			const appendCustomEntry = sessionManager.appendCustomEntry.bind(sessionManager);
			const appendSpy = vi.spyOn(sessionManager, "appendCustomEntry").mockImplementation((customType, data) => {
				if (
					customType === RUN_LEDGER_CUSTOM_TYPE &&
					typeof data === "object" &&
					data !== null &&
					"kind" in data &&
					data.kind === "accepted"
				) {
					throw new Error("accepted ledger unavailable");
				}
				return appendCustomEntry(customType, data);
			});

			lineHandler(JSON.stringify({ id: "persist-accepted", type: "run.start", message: "Hello" }));
			await vi.waitFor(() => expect(responsesFor(rpcIo.outputLines, "persist-accepted")).toHaveLength(1));
			const rejection = responsesFor(rpcIo.outputLines, "persist-accepted")[0];
			expect(rejection.success).toBe(false);
			expect((rejection.error as { code: string }).code).toBe("ledger_persistence_failed");
			await sleep(20);
			expect(
				currentLines().some((record) => typeof record.type === "string" && record.type.startsWith("run.")),
			).toBe(false);
			expect(runEventsOfType(currentLines(), "message_start")).toHaveLength(0);

			appendSpy.mockRestore();
			lineHandler(JSON.stringify({ id: "retry", type: "run.start", message: "Hello" }));
			await vi.waitFor(() => expect(responsesFor(rpcIo.outputLines, "retry")[0]?.success).toBe(true));
			await vi.waitFor(() => expect(terminalEvents(currentLines())).toHaveLength(1));
		} finally {
			await cleanup();
		}
	});

	it("does not publish accepted or leak Session ownership when started-ledger persistence fails", async () => {
		const { lineHandler, cleanup, runtimeHost } = await startRpcMode({ withAuth: true, responseDelayMs: 0 });

		try {
			lineHandler(JSON.stringify({ id: "i1", type: "initialize", protocolVersion: 1 }));
			await vi.waitFor(() => expect(responsesFor(rpcIo.outputLines, "i1")).toHaveLength(1));

			const sessionManager = sessionLedger(runtimeHost.session);
			const appendCustomEntry = sessionManager.appendCustomEntry.bind(sessionManager);
			const appendSpy = vi.spyOn(sessionManager, "appendCustomEntry").mockImplementation((customType, data) => {
				if (
					customType === RUN_LEDGER_CUSTOM_TYPE &&
					typeof data === "object" &&
					data !== null &&
					"kind" in data &&
					data.kind === "started"
				) {
					throw new Error("started ledger unavailable");
				}
				return appendCustomEntry(customType, data);
			});

			lineHandler(
				JSON.stringify({
					id: "persist-started",
					type: "run.start",
					clientRequestId: "started-boundary-1",
					message: "Hello",
				}),
			);
			await vi.waitFor(() => expect(responsesFor(rpcIo.outputLines, "persist-started")).toHaveLength(1));
			const rejection = responsesFor(rpcIo.outputLines, "persist-started")[0];
			expect(rejection.success).toBe(false);
			expect((rejection.error as { code: string }).code).toBe("ledger_persistence_failed");
			expect("data" in rejection).toBe(false);
			await sleep(20);
			expect(
				currentLines().some((record) => typeof record.type === "string" && record.type.startsWith("run.")),
			).toBe(false);
			expect(runEventsOfType(currentLines(), "message_start")).toHaveLength(0);

			appendSpy.mockRestore();
			lineHandler(
				JSON.stringify({
					id: "retry",
					type: "run.start",
					clientRequestId: "started-boundary-1",
					message: "Hello",
				}),
			);
			await vi.waitFor(() => expect(responsesFor(rpcIo.outputLines, "retry")[0]?.success).toBe(true));
			const retryData = responsesFor(rpcIo.outputLines, "retry")[0].data as {
				status: string;
				idempotent?: boolean;
			};
			expect(retryData.status).toBe("accepted");
			expect(retryData.idempotent).toBe(true);
			expect(terminalEvents(currentLines())).toHaveLength(0);
		} finally {
			await cleanup();
		}
	});

	it("settles a failed run with a model_error terminal when the stream fails after preflight", async () => {
		const { lineHandler, cleanup } = await startRpcMode({
			withAuth: true,
			responseDelayMs: 0,
			streamErrorMessage: "simulated stream failure",
		});

		try {
			lineHandler(JSON.stringify({ id: "i1", type: "initialize", protocolVersion: 1 }));
			await vi.waitFor(() => expect(responsesFor(rpcIo.outputLines, "i1")).toHaveLength(1));

			lineHandler(JSON.stringify({ id: "f2", type: "run.start", message: "Hello" }));

			await vi.waitFor(() => {
				const res = responsesFor(rpcIo.outputLines, "f2");
				expect(res).toHaveLength(1);
				expect(res[0].success).toBe(true);
			});

			await vi.waitFor(() => expect(terminalEvents(currentLines())).toHaveLength(1));

			const lines = currentLines();
			expect(runEventsOfType(lines, "run.completed")).toHaveLength(0);
			const terminal = terminalEvents(lines)[0];
			expect(terminal.type).toBe("run.failed");
			const receipt = terminal.receipt as { status: string; terminalError?: { code: string } };
			expect(receipt.status).toBe("failed");
			expect(receipt.terminalError?.code).toBe("side_effect_unknown");
		} finally {
			await cleanup();
		}
	});

	it("cancels an active run and treats a duplicate cancel as idempotent", async () => {
		const { lineHandler, cleanup } = await startRpcMode({ withAuth: true, responseDelayMs: 100 });

		try {
			lineHandler(JSON.stringify({ id: "i1", type: "initialize", protocolVersion: 1 }));
			await vi.waitFor(() => expect(responsesFor(rpcIo.outputLines, "i1")).toHaveLength(1));

			lineHandler(JSON.stringify({ id: "r2", type: "run.start", message: "Hello" }));

			let runId: string;
			await vi.waitFor(() => {
				const res = responsesFor(rpcIo.outputLines, "r2");
				expect(res).toHaveLength(1);
				expect(res[0].success).toBe(true);
				runId = (res[0].data as { runId: string }).runId;
			});
			expect(runId!).toBeTruthy();

			lineHandler(JSON.stringify({ id: "c1", type: "run.cancel", runId: runId! }));

			await vi.waitFor(() => expect(responsesFor(rpcIo.outputLines, "c1")).toHaveLength(1));
			const c1 = responsesFor(rpcIo.outputLines, "c1")[0];
			expect(c1.success).toBe(true);
			expect((c1.data as { status: string }).status).toBe("running");
			const cancelResponseIndex = currentLines().findIndex(
				(record) => record.id === "c1" && record.type === "response",
			);

			await vi.waitFor(() => expect(terminalEvents(currentLines())).toHaveLength(1));
			expect(terminalEvents(currentLines())[0].type).toBe("run.cancelled");
			const terminalIndex = currentLines().findIndex((record) => record.type === "run.cancelled");
			expect(cancelResponseIndex).toBeGreaterThanOrEqual(0);
			expect(cancelResponseIndex).toBeLessThan(terminalIndex);

			lineHandler(JSON.stringify({ id: "c2", type: "run.cancel", runId: runId! }));
			await vi.waitFor(() => expect(responsesFor(rpcIo.outputLines, "c2")).toHaveLength(1));
			const c2 = responsesFor(rpcIo.outputLines, "c2")[0];
			expect(c2.success).toBe(true);
			expect((c2.data as { status: string }).status).toBe("cancelled");
			expect(terminalEvents(currentLines())).toHaveLength(1);

			await sleep(150);
		} finally {
			await cleanup();
		}
	});

	it("rejects a non-canonical deadline during preflight without creating a Run", async () => {
		const { lineHandler, cleanup, runtimeHost } = await startRpcMode({ withAuth: true, responseDelayMs: 0 });

		try {
			lineHandler(JSON.stringify({ id: "i1", type: "initialize", protocolVersion: 1 }));
			await vi.waitFor(() => expect(responsesFor(rpcIo.outputLines, "i1")).toHaveLength(1));

			const invalidDeadlines = [
				"2026-08-15T12:00:10Z",
				"2026-08-15T12:00:10.000+00:00",
				"2026-13-40T12:00:10.000Z",
			];
			for (const [index, deadlineAt] of invalidDeadlines.entries()) {
				const id = `deadline-invalid-${index}`;
				lineHandler(JSON.stringify({ id, type: "run.start", message: "Hello", deadlineAt }));
				await vi.waitFor(() => expect(responsesFor(rpcIo.outputLines, id)).toHaveLength(1));
				const response = responsesFor(rpcIo.outputLines, id)[0];
				expect(response).toMatchObject({
					success: false,
					error: { code: "run_deadline_invalid", retryable: false },
				});
				expect("data" in response).toBe(false);
			}
			expect(terminalEvents(currentLines())).toHaveLength(0);
			expect(runEventsOfType(currentLines(), "run.started")).toHaveLength(0);
			expect(
				sessionLedger(runtimeHost.session)
					.getEntries()
					.filter((entry) => entry.type === "custom" && entry.customType === RUN_LEDGER_CUSTOM_TYPE),
			).toHaveLength(0);
		} finally {
			await cleanup();
		}
	});

	it("rejects an expired deadline during preflight without creating a Run", async () => {
		const { lineHandler, cleanup, runtimeHost } = await startRpcMode({ withAuth: true, responseDelayMs: 0 });

		try {
			lineHandler(JSON.stringify({ id: "i1", type: "initialize", protocolVersion: 1 }));
			await vi.waitFor(() => expect(responsesFor(rpcIo.outputLines, "i1")).toHaveLength(1));

			const deadlineAt = new Date(Date.now() - 1).toISOString();
			lineHandler(JSON.stringify({ id: "expired", type: "run.start", message: "Hello", deadlineAt }));
			await vi.waitFor(() => expect(responsesFor(rpcIo.outputLines, "expired")).toHaveLength(1));
			const response = responsesFor(rpcIo.outputLines, "expired")[0];
			expect(response).toMatchObject({
				success: false,
				error: { code: "run_deadline_exceeded", retryable: false },
			});
			expect("data" in response).toBe(false);
			expect(terminalEvents(currentLines())).toHaveLength(0);
			expect(runEventsOfType(currentLines(), "run.started")).toHaveLength(0);
			expect(
				sessionLedger(runtimeHost.session)
					.getEntries()
					.filter((entry) => entry.type === "custom" && entry.customType === RUN_LEDGER_CUSTOM_TYPE),
			).toHaveLength(0);
		} finally {
			await cleanup();
		}
	});

	it("rejects when the Run deadline expires before prompt preflight acceptance", async () => {
		const { lineHandler, cleanup, runtimeHost } = await startRpcMode({ withAuth: true, responseDelayMs: 0 });
		const originalWhenCapabilitiesReady = runtimeHost.session.whenCapabilitiesReady.bind(runtimeHost.session);
		let preflightSignal: AbortSignal | undefined;
		const readinessSpy = vi
			.spyOn(runtimeHost.session, "whenCapabilitiesReady")
			.mockImplementation(async (runId, signal) => {
				await originalWhenCapabilitiesReady(runId, signal);
				if (signal !== undefined) {
					preflightSignal = signal;
					await sleep(120);
				}
			});
		const abortSpy = vi.spyOn(runtimeHost.session, "abort");

		try {
			lineHandler(JSON.stringify({ id: "i1", type: "initialize", protocolVersion: 1 }));
			await vi.waitFor(() => expect(responsesFor(rpcIo.outputLines, "i1")).toHaveLength(1));

			const deadlineAt = new Date(Date.now() + 40).toISOString();
			const request = {
				type: "run.start",
				clientRequestId: "deadline-preflight-boundary-1",
				message: "Hello",
				deadlineAt,
			};
			lineHandler(JSON.stringify({ id: "expired-1", ...request }));
			lineHandler(JSON.stringify({ id: "expired-2", ...request }));

			await vi.waitFor(() => {
				expect(responsesFor(rpcIo.outputLines, "expired-1")).toHaveLength(1);
				expect(responsesFor(rpcIo.outputLines, "expired-2")).toHaveLength(1);
			});
			for (const id of ["expired-1", "expired-2"]) {
				const response = responsesFor(rpcIo.outputLines, id)[0];
				expect(response).toMatchObject({
					success: false,
					error: { code: "run_deadline_exceeded", retryable: false },
				});
				expect("data" in response).toBe(false);
			}
			expect(preflightSignal?.aborted).toBe(true);
			expect(abortSpy).not.toHaveBeenCalled();
			expect(
				currentLines().some((record) => typeof record.type === "string" && record.type.startsWith("run.")),
			).toBe(false);
			expect(
				sessionLedger(runtimeHost.session)
					.getEntries()
					.filter((entry) => entry.type === "custom" && entry.customType === RUN_LEDGER_CUSTOM_TYPE),
			).toHaveLength(0);

			lineHandler(JSON.stringify({ id: "retry", type: "run.start", message: "Retry" }));
			await vi.waitFor(() => expect(responsesFor(rpcIo.outputLines, "retry")[0]?.success).toBe(true));
			await vi.waitFor(() => expect(terminalEvents(currentLines())).toHaveLength(1));
			expect(terminalEvents(currentLines())[0].type).toBe("run.completed");
		} finally {
			readinessSpy.mockRestore();
			abortSpy.mockRestore();
			await cleanup();
		}
	});

	it("cancels an active run before its deadline and treats duplicate cancel as idempotent", async () => {
		const { lineHandler, cleanup } = await startRpcMode({ withAuth: true, responseDelayMs: 100 });

		try {
			lineHandler(JSON.stringify({ id: "i1", type: "initialize", protocolVersion: 1 }));
			await vi.waitFor(() => expect(responsesFor(rpcIo.outputLines, "i1")).toHaveLength(1));

			const deadlineAt = new Date(Date.now() + 300).toISOString();
			lineHandler(JSON.stringify({ id: "r2", type: "run.start", message: "Hello", deadlineAt }));

			let runId: string;
			await vi.waitFor(() => {
				const res = responsesFor(rpcIo.outputLines, "r2");
				expect(res).toHaveLength(1);
				expect(res[0].success).toBe(true);
				runId = (res[0].data as { runId: string }).runId;
			});
			expect(runId!).toBeTruthy();

			lineHandler(JSON.stringify({ id: "c1", type: "run.cancel", runId: runId! }));

			await vi.waitFor(() => expect(responsesFor(rpcIo.outputLines, "c1")).toHaveLength(1));
			const c1 = responsesFor(rpcIo.outputLines, "c1")[0];
			expect(c1.success).toBe(true);
			expect((c1.data as { status: string }).status).toBe("running");
			const cancelResponseIndex = currentLines().findIndex(
				(record) => record.id === "c1" && record.type === "response",
			);

			await vi.waitFor(() => expect(terminalEvents(currentLines())).toHaveLength(1));
			expect(terminalEvents(currentLines())[0].type).toBe("run.cancelled");
			const terminalIndex = currentLines().findIndex((record) => record.type === "run.cancelled");
			expect(cancelResponseIndex).toBeGreaterThanOrEqual(0);
			expect(cancelResponseIndex).toBeLessThan(terminalIndex);

			lineHandler(JSON.stringify({ id: "c2", type: "run.cancel", runId: runId! }));
			await vi.waitFor(() => expect(responsesFor(rpcIo.outputLines, "c2")).toHaveLength(1));
			const c2 = responsesFor(rpcIo.outputLines, "c2")[0];
			expect(c2.success).toBe(true);
			expect((c2.data as { status: string }).status).toBe("cancelled");
			expect(terminalEvents(currentLines())).toHaveLength(1);

			await sleep(350);
			expect(terminalEvents(currentLines())).toHaveLength(1);
			expect(runEventsOfType(currentLines(), "run.failed")).toHaveLength(0);
		} finally {
			await cleanup();
		}
	});

	it("propagates the Run deadline, aborts the prompt, and keeps receipt metadata minimal", async () => {
		const { lineHandler, cleanup, runtimeHost } = await startRpcMode({ withAuth: true, responseDelayMs: 1500 });
		const modelHandle = createBindingHandle({
			domain: "model",
			bindingId: "model-binding-rpc",
			revision: "rev-rpc",
			relation: "run.model",
		});
		vi.spyOn(runtimeHost.session, "getActiveBindingHandles").mockReturnValue([modelHandle]);
		const abortSpy = vi.spyOn(runtimeHost.session, "abort");

		try {
			lineHandler(JSON.stringify({ id: "i1", type: "initialize", protocolVersion: 1 }));
			await vi.waitFor(() => expect(responsesFor(rpcIo.outputLines, "i1")).toHaveLength(1));

			const deadlineAt = new Date(Date.now() + 1000).toISOString();
			lineHandler(JSON.stringify({ id: "deadline-run", type: "run.start", message: "Hello", deadlineAt }));

			let acceptedData: {
				runId: string;
				deadlineAt?: string;
				bindingAssociation?: { bindings: Array<{ bindingId: string }> };
			};
			await vi.waitFor(() => {
				const responses = responsesFor(rpcIo.outputLines, "deadline-run");
				expect(responses).toHaveLength(1);
				expect(responses[0].success).toBe(true);
				acceptedData = responses[0].data as typeof acceptedData;
			});
			expect(acceptedData!.deadlineAt).toBe(deadlineAt);
			expect(acceptedData!.bindingAssociation?.bindings).toEqual([
				expect.objectContaining({ bindingId: "model-binding-rpc" }),
			]);

			await vi.waitFor(() => expect(terminalEvents(currentLines())).toHaveLength(1), { timeout: 3000 });
			const terminal = terminalEvents(currentLines())[0];
			expect(terminal.type).toBe("run.failed");
			expect(terminal.receipt).toMatchObject({
				status: "failed",
				terminalError: { code: "run_deadline_exceeded", message: "Run failed.", retryable: false },
			});
			expect("deadlineAt" in (terminal.receipt as Record<string, unknown>)).toBe(false);
			expect("bindingAssociation" in (terminal.receipt as Record<string, unknown>)).toBe(false);
			expect(abortSpy).toHaveBeenCalledTimes(1);
			expect(runEventsOfType(currentLines(), "run.cancelled")).toHaveLength(0);

			lineHandler(JSON.stringify({ id: "deadline-get", type: "run.get", runId: acceptedData!.runId }));
			await vi.waitFor(() => expect(responsesFor(rpcIo.outputLines, "deadline-get")).toHaveLength(1));
			expect(responsesFor(rpcIo.outputLines, "deadline-get")[0]).toMatchObject({
				success: true,
				data: {
					run: { id: acceptedData!.runId, status: "failed", deadlineAt },
					receipt: {
						status: "failed",
						terminalError: { code: "run_deadline_exceeded", retryable: false },
					},
				},
			});

			lineHandler(
				JSON.stringify({
					id: "deadline-audit-query",
					type: "audit.query",
					scope: "current-session",
					runId: acceptedData!.runId,
					types: ["run.failed"],
				}),
			);
			await vi.waitFor(() => expect(responsesFor(rpcIo.outputLines, "deadline-audit-query")).toHaveLength(1));
			const auditQuery = responsesFor(rpcIo.outputLines, "deadline-audit-query")[0];
			expect(auditQuery).toMatchObject({ success: true });
			expect((auditQuery.data as { events: Array<Record<string, unknown>> }).events).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						type: "run.failed",
						runId: acceptedData!.runId,
						summary: expect.objectContaining({
							status: "failed",
							terminalError: expect.objectContaining({
								code: "run_deadline_exceeded",
								retryable: false,
							}),
						}),
					}),
				]),
			);
			const auditFailure = (auditQuery.data as { events: Array<{ summary: Record<string, unknown> }> }).events[0];
			expect("deadlineAt" in auditFailure.summary).toBe(false);

			lineHandler(
				JSON.stringify({
					id: "deadline-audit-replay",
					type: "audit.replay",
					runId: acceptedData!.runId,
					scope: "current-session",
					types: ["run.failed"],
				}),
			);
			await vi.waitFor(() => expect(responsesFor(rpcIo.outputLines, "deadline-audit-replay")).toHaveLength(1));
			expect(responsesFor(rpcIo.outputLines, "deadline-audit-replay")[0]).toMatchObject({
				success: true,
				data: {
					status: "complete",
					run: {
						status: "failed",
						terminalError: { code: "run_deadline_exceeded", retryable: false },
					},
				},
			});
			const auditReplay = responsesFor(rpcIo.outputLines, "deadline-audit-replay")[0].data as {
				run: Record<string, unknown>;
			};
			expect("deadlineAt" in auditReplay.run).toBe(false);
			expect(terminalEvents(currentLines())).toHaveLength(1);
		} finally {
			await cleanup();
		}
	});

	it("keeps deadline failure when cancel arrives after the deadline intent", async () => {
		const { lineHandler, cleanup, runtimeHost } = await startRpcMode({ withAuth: true, responseDelayMs: 3000 });
		const originalAbort = runtimeHost.session.abort.bind(runtimeHost.session);
		let releaseAbort: () => void = () => {};
		let markAbortStarted: () => void = () => {};
		const abortStarted = new Promise<void>((resolve) => {
			markAbortStarted = resolve;
		});
		const abortGate = new Promise<void>((resolve) => {
			releaseAbort = resolve;
		});
		vi.spyOn(runtimeHost.session, "abort").mockImplementation(async () => {
			markAbortStarted();
			await abortGate;
			await originalAbort();
		});

		try {
			lineHandler(JSON.stringify({ id: "i1", type: "initialize", protocolVersion: 1 }));
			await vi.waitFor(() => expect(responsesFor(rpcIo.outputLines, "i1")).toHaveLength(1));

			const deadlineAt = new Date(Date.now() + 500).toISOString();
			lineHandler(JSON.stringify({ id: "deadline-race", type: "run.start", message: "Hello", deadlineAt }));
			let runId: string;
			await vi.waitFor(() => {
				const response = responsesFor(rpcIo.outputLines, "deadline-race")[0];
				expect(response?.success).toBe(true);
				runId = (response.data as { runId: string }).runId;
			});

			await abortStarted;
			lineHandler(JSON.stringify({ id: "late-cancel", type: "run.cancel", runId: runId! }));
			await vi.waitFor(() => expect(responsesFor(rpcIo.outputLines, "late-cancel")).toHaveLength(1));
			expect(responsesFor(rpcIo.outputLines, "late-cancel")[0]).toMatchObject({
				success: true,
				data: { runId: runId!, status: "running" },
			});

			releaseAbort();
			await vi.waitFor(() => expect(terminalEvents(currentLines())).toHaveLength(1));
			expect(terminalEvents(currentLines())[0]).toMatchObject({
				type: "run.failed",
				runId: runId!,
				receipt: {
					status: "failed",
					terminalError: { code: "run_deadline_exceeded", retryable: false },
				},
			});
			const terminalReceipt = terminalEvents(currentLines())[0].receipt as Record<string, unknown>;
			expect("deadlineAt" in terminalReceipt).toBe(false);
			lineHandler(JSON.stringify({ id: "deadline-race-get", type: "run.get", runId: runId! }));
			await vi.waitFor(() => expect(responsesFor(rpcIo.outputLines, "deadline-race-get")).toHaveLength(1));
			expect(responsesFor(rpcIo.outputLines, "deadline-race-get")[0]).toMatchObject({
				success: true,
				data: {
					run: { id: runId!, status: "failed", deadlineAt },
					receipt: {
						status: "failed",
						terminalError: { code: "run_deadline_exceeded", retryable: false },
					},
				},
			});
			expect(runEventsOfType(currentLines(), "run.cancelled")).toHaveLength(0);
		} finally {
			releaseAbort();
			await cleanup();
		}
	});

	it("clears the deadline timer after normal completion", async () => {
		const { lineHandler, cleanup } = await startRpcMode({ withAuth: true, responseDelayMs: 0 });
		const originalSetTimeout = globalThis.setTimeout;
		let deadlineTimerHandle: ReturnType<typeof setTimeout> | undefined;
		const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout").mockImplementation((handler, timeout, ...args) => {
			const timer = originalSetTimeout(handler, timeout, ...args);
			if (typeof timeout === "number" && timeout > 800 && timeout < 2000) deadlineTimerHandle = timer;
			return timer;
		});
		const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");

		try {
			lineHandler(JSON.stringify({ id: "i-deadline-cleanup", type: "initialize", protocolVersion: 1 }));
			await vi.waitFor(() => expect(responsesFor(rpcIo.outputLines, "i-deadline-cleanup")).toHaveLength(1));

			const deadlineAt = new Date(Date.now() + 1000).toISOString();
			lineHandler(JSON.stringify({ id: "deadline-cleanup-run", type: "run.start", message: "Hello", deadlineAt }));
			await vi.waitFor(() => {
				const response = responsesFor(rpcIo.outputLines, "deadline-cleanup-run")[0];
				expect(response?.success).toBe(true);
			});
			const deadlineTimerCall = setTimeoutSpy.mock.calls.find(
				([, delay]) => typeof delay === "number" && delay > 800 && delay < 2000,
			);
			expect(deadlineTimerCall).toBeDefined();
			expect(deadlineTimerHandle).toBeDefined();
			await vi.waitFor(() => expect(terminalEvents(currentLines())).toHaveLength(1));
			expect(terminalEvents(currentLines())[0].type).toBe("run.completed");
			await vi.waitFor(
				() => expect(clearTimeoutSpy.mock.calls.some(([timer]) => timer === deadlineTimerHandle)).toBe(true),
				{ timeout: 500 },
			);

			await sleep(1100);
			expect(terminalEvents(currentLines())).toHaveLength(1);
			expect(runEventsOfType(currentLines(), "run.failed")).toHaveLength(0);
		} finally {
			setTimeoutSpy.mockRestore();
			clearTimeoutSpy.mockRestore();
			await cleanup();
		}
	});

	it("settles a deadline through Foundation without a transport terminal append and releases the session", async () => {
		const { lineHandler, cleanup, runtimeHost } = await startRpcMode({ withAuth: true, responseDelayMs: 1500 });
		const sessionManager = sessionLedger(runtimeHost.session);
		const appendCustomEntry = sessionManager.appendCustomEntry.bind(sessionManager);
		const appendSpy = vi
			.spyOn(sessionManager, "appendCustomEntry")
			.mockImplementation((customType, data) => appendCustomEntry(customType, data));

		try {
			lineHandler(JSON.stringify({ id: "i-deadline-persist", type: "initialize", protocolVersion: 1 }));
			await vi.waitFor(() => expect(responsesFor(rpcIo.outputLines, "i-deadline-persist")).toHaveLength(1));

			lineHandler(
				JSON.stringify({
					id: "deadline-persist-run",
					type: "run.start",
					message: "Hello",
					deadlineAt: new Date(Date.now() + 80).toISOString(),
				}),
			);
			let runId: string | undefined;
			await vi.waitFor(() => {
				const response = responsesFor(rpcIo.outputLines, "deadline-persist-run")[0];
				expect(response?.success).toBe(true);
				runId = (response.data as { runId: string }).runId;
			});
			await vi.waitFor(() => expect(terminalEvents(currentLines())).toHaveLength(1), { timeout: 3000 });
			expect(terminalEvents(currentLines())[0].type).toBe("run.failed");
			expect(
				appendSpy.mock.calls.some(
					([customType, data]) =>
						customType === RUN_LEDGER_CUSTOM_TYPE &&
						typeof data === "object" &&
						data !== null &&
						"kind" in data &&
						data.kind === "terminal",
				),
			).toBe(false);

			lineHandler(JSON.stringify({ id: "deadline-persist-get", type: "run.get", runId: runId! }));
			await vi.waitFor(() => expect(responsesFor(rpcIo.outputLines, "deadline-persist-get")).toHaveLength(1));
			expect(responsesFor(rpcIo.outputLines, "deadline-persist-get")[0]).toMatchObject({
				success: true,
				data: { run: { id: runId!, status: "failed" }, receipt: { runId: runId!, status: "failed" } },
			});

			lineHandler(JSON.stringify({ id: "deadline-persist-retry", type: "run.start", message: "Retry" }));
			await vi.waitFor(() => expect(responsesFor(rpcIo.outputLines, "deadline-persist-retry")[0]?.success).toBe(true));
			await vi.waitFor(() => expect(terminalEvents(currentLines())).toHaveLength(2), { timeout: 3000 });
			expect(terminalEvents(currentLines())[1].type).toBe("run.completed");
		} finally {
			appendSpy.mockRestore();
			await cleanup();
		}
	});

	it("keeps a single terminal when completion wins a late timer and cancel", async () => {
		const { lineHandler, cleanup } = await startRpcMode({ withAuth: true, responseDelayMs: 0 });

		try {
			lineHandler(JSON.stringify({ id: "i1", type: "initialize", protocolVersion: 1 }));
			await vi.waitFor(() => expect(responsesFor(rpcIo.outputLines, "i1")).toHaveLength(1));

			// Leave enough time for the complete Foundation receipt chain to settle;
			// this deadline is intentionally late and tests post-terminal timer safety.
			const deadlineAt = new Date(Date.now() + 1000).toISOString();
			lineHandler(JSON.stringify({ id: "r1", type: "run.start", message: "Hello", deadlineAt }));
			let runId: string;
			await vi.waitFor(() => {
				const res = responsesFor(rpcIo.outputLines, "r1");
				expect(res).toHaveLength(1);
				runId = (res[0].data as { runId: string }).runId;
			});
			await vi.waitFor(() => expect(terminalEvents(currentLines())).toHaveLength(1));
			expect(terminalEvents(currentLines())[0].type).toBe("run.completed");
			await sleep(1100);

			lineHandler(JSON.stringify({ id: "c1", type: "run.cancel", runId: runId! }));
			await vi.waitFor(() => expect(responsesFor(rpcIo.outputLines, "c1")).toHaveLength(1));
			const c1 = responsesFor(rpcIo.outputLines, "c1")[0];
			expect(c1.success).toBe(true);
			expect((c1.data as { status: string }).status).toBe("completed");
			expect(terminalEvents(currentLines())).toHaveLength(1);
			expect(runEventsOfType(currentLines(), "run.failed")).toHaveLength(0);
		} finally {
			await cleanup();
		}
	});

	it("rejects a second run while one is active, then accepts again after the terminal", async () => {
		const { lineHandler, cleanup } = await startRpcMode({ withAuth: true, responseDelayMs: 100 });

		try {
			lineHandler(JSON.stringify({ id: "i1", type: "initialize", protocolVersion: 1 }));
			await vi.waitFor(() => expect(responsesFor(rpcIo.outputLines, "i1")).toHaveLength(1));

			// second start lands in the same tick, while the first is still in preflight
			lineHandler(JSON.stringify({ id: "b1", type: "run.start", message: "First" }));
			lineHandler(JSON.stringify({ id: "b2", type: "run.start", message: "Second" }));

			await vi.waitFor(() => expect(responsesFor(rpcIo.outputLines, "b2")).toHaveLength(1));
			const busy = responsesFor(rpcIo.outputLines, "b2")[0];
			expect(busy.success).toBe(false);
			expect((busy.error as { code: string; retryable: boolean }).code).toBe("session_busy");
			expect((busy.error as { retryable: boolean }).retryable).toBe(true);

			await vi.waitFor(() => expect(terminalEvents(currentLines())).toHaveLength(1));
			expect(terminalEvents(currentLines())[0].type).toBe("run.completed");

			// the session is free again after the terminal
			lineHandler(JSON.stringify({ id: "b3", type: "run.start", message: "Third" }));
			await vi.waitFor(() => {
				const res = responsesFor(rpcIo.outputLines, "b3");
				expect(res).toHaveLength(1);
				expect(res[0].success).toBe(true);
			});
			await vi.waitFor(() => expect(terminalEvents(currentLines())).toHaveLength(2));

			await sleep(150);
		} finally {
			await cleanup();
		}
	});

	it("rejects legacy mutating commands after initialize but keeps read-only commands", async () => {
		const { lineHandler, cleanup } = await startRpcMode({ withAuth: true, responseDelayMs: 0 });

		try {
			lineHandler(JSON.stringify({ id: "i1", type: "initialize", protocolVersion: 1 }));
			await vi.waitFor(() => expect(responsesFor(rpcIo.outputLines, "i1")).toHaveLength(1));

			lineHandler(JSON.stringify({ id: "m1", type: "prompt", message: "hi" }));
			await vi.waitFor(() => expect(responsesFor(rpcIo.outputLines, "m1")).toHaveLength(1));
			const prompt = responsesFor(rpcIo.outputLines, "m1")[0];
			expect(prompt.success).toBe(false);
			expect(typeof prompt.error).toBe("string");
			expect(prompt.error as string).toContain("not available while the Automation Host is initialized");

			lineHandler(JSON.stringify({ id: "m2", type: "switch_session", sessionPath: "/tmp/x.jsonl" }));
			await vi.waitFor(() => expect(responsesFor(rpcIo.outputLines, "m2")).toHaveLength(1));
			expect(responsesFor(rpcIo.outputLines, "m2")[0].success).toBe(false);

			lineHandler(JSON.stringify({ id: "m3", type: "get_state" }));
			await vi.waitFor(() => expect(responsesFor(rpcIo.outputLines, "m3")).toHaveLength(1));
			expect(responsesFor(rpcIo.outputLines, "m3")[0].success).toBe(true);
		} finally {
			await cleanup();
		}
	});

	it("returns ledger records from run.get after a run completes", async () => {
		const { lineHandler, cleanup } = await startRpcMode({ withAuth: true, responseDelayMs: 0 });

		try {
			lineHandler(JSON.stringify({ id: "i1", type: "initialize", protocolVersion: 1 }));
			await vi.waitFor(() => expect(responsesFor(rpcIo.outputLines, "i1")).toHaveLength(1));

			lineHandler(JSON.stringify({ id: "r1", type: "run.start", message: "Hello" }));
			let runId: string;
			await vi.waitFor(() => {
				const res = responsesFor(rpcIo.outputLines, "r1");
				expect(res).toHaveLength(1);
				runId = (res[0].data as { runId: string }).runId;
			});
			expect(runId!).toBeTruthy();
			await vi.waitFor(() => expect(terminalEvents(currentLines())).toHaveLength(1));

			lineHandler(JSON.stringify({ id: "g1", type: "run.get", runId: runId! }));
			await vi.waitFor(() => {
				const res = responsesFor(rpcIo.outputLines, "g1");
				expect(res).toHaveLength(1);
				expect(res[0].success).toBe(true);
				const data = res[0].data as {
					run: { id: string; status: string; attempt: number };
					receipt: { status: string };
				};
				expect(data.run.id).toBe(runId);
				expect(data.run.status).toBe("completed");
				expect(data.run.attempt).toBe(1);
				expect(data.receipt.status).toBe("completed");
			});

			lineHandler(JSON.stringify({ id: "g2", type: "run.get", runId: "nonexistent" }));
			await vi.waitFor(() => expect(responsesFor(rpcIo.outputLines, "g2")).toHaveLength(1));
			const missing = responsesFor(rpcIo.outputLines, "g2")[0];
			expect(missing.success).toBe(false);
			expect((missing.error as { code: string }).code).toBe("run_not_found");
		} finally {
			await cleanup();
		}
	});

	it("resumes a completed run at attempt+1 after switching to the persisted session", async () => {
		const { lineHandler, cleanup, runtimeHost } = await startRpcMode({ withAuth: true, responseDelayMs: 0 });

		try {
			lineHandler(JSON.stringify({ id: "i1", type: "initialize", protocolVersion: 1 }));
			await vi.waitFor(() => expect(responsesFor(rpcIo.outputLines, "i1")).toHaveLength(1));

			lineHandler(JSON.stringify({ id: "r1", type: "run.start", message: "First" }));
			let runId: string;
			await vi.waitFor(() => {
				const res = responsesFor(rpcIo.outputLines, "r1");
				expect(res).toHaveLength(1);
				runId = (res[0].data as { runId: string }).runId;
			});
			await vi.waitFor(() => expect(terminalEvents(currentLines())).toHaveLength(1));

			const sessionFile = runtimeHost.session.sessionFile;
			expect(sessionFile).toBeTruthy();

			lineHandler(
				JSON.stringify({
					id: "rs1",
					type: "run.resume",
					sessionPath: sessionFile!,
					sourceRunId: runId!,
					message: "Continue",
				}),
			);

			await vi.waitFor(() => {
				const res = responsesFor(rpcIo.outputLines, "rs1");
				expect(res).toHaveLength(1);
				expect(res[0].success).toBe(true);
				const data = res[0].data as { runId: string; attempt: number; status: string };
				expect(data.attempt).toBe(2);
				expect(data.status).toBe("accepted");
				expect(data.runId).not.toBe(runId);
			});

			await vi.waitFor(() => expect(terminalEvents(currentLines())).toHaveLength(2));

			// the source run remains visible in the rebuilt ledger after the switch
			lineHandler(JSON.stringify({ id: "g1", type: "run.get", runId: runId! }));
			await vi.waitFor(() => {
				const res = responsesFor(rpcIo.outputLines, "g1");
				expect(res).toHaveLength(1);
				expect(res[0].success).toBe(true);
				const data = res[0].data as { run: { status: string } };
				expect(data.run.status).toBe("completed");
			});
		} finally {
			await cleanup();
		}
	});

	it("replays duplicate run.resume before switching sessions or prompting again", async () => {
		const { lineHandler, cleanup, runtimeHost } = await startRpcMode({ withAuth: true, responseDelayMs: 0 });

		try {
			lineHandler(JSON.stringify({ id: "i1", type: "initialize", protocolVersion: 1 }));
			await vi.waitFor(() => expect(responsesFor(rpcIo.outputLines, "i1")).toHaveLength(1));
			lineHandler(JSON.stringify({ id: "seed", type: "run.start", message: "seed" }));
			let sourceRunId: string;
			await vi.waitFor(() => {
				const response = responsesFor(rpcIo.outputLines, "seed")[0];
				expect(response?.success).toBe(true);
				sourceRunId = (response.data as { runId: string }).runId;
			});
			await vi.waitFor(() => expect(terminalEvents(currentLines())).toHaveLength(1));
			const sessionPath = runtimeHost.session.sessionFile;
			expect(sessionPath).toBeTruthy();
			const switchSpy = vi.mocked(runtimeHost.switchSession);
			const switchCount = switchSpy.mock.calls.length;

			const request = {
				type: "run.resume",
				sessionPath: sessionPath!,
				sourceRunId: sourceRunId!,
				clientRequestId: "resume-idempotency-1",
				message: "continue",
			};
			lineHandler(JSON.stringify({ id: "resume-first", ...request }));
			await vi.waitFor(() => expect(responsesFor(rpcIo.outputLines, "resume-first")[0]?.success).toBe(true));
			await vi.waitFor(() => expect(terminalEvents(currentLines())).toHaveLength(2));
			const firstData = responsesFor(rpcIo.outputLines, "resume-first")[0].data as { runId: string };
			const ledgerCount = sessionLedger(runtimeHost.session)
				.getEntries()
				.filter((entry) => entry.type === "custom" && entry.customType === RUN_LEDGER_CUSTOM_TYPE).length;
			const promptSpy = vi.spyOn(runtimeHost.session, "prompt");

			lineHandler(JSON.stringify({ id: "resume-duplicate", ...request }));
			await vi.waitFor(() => expect(responsesFor(rpcIo.outputLines, "resume-duplicate")).toHaveLength(1));
			const duplicate = responsesFor(rpcIo.outputLines, "resume-duplicate")[0];
			expect(duplicate.success).toBe(true);
			expect(duplicate.data).toMatchObject({
				runId: firstData.runId,
				status: "completed",
				idempotent: true,
				receipt: { runId: firstData.runId, status: "completed" },
			});
			expect(switchSpy.mock.calls).toHaveLength(switchCount + 1);
			expect(promptSpy).not.toHaveBeenCalled();
			expect(terminalEvents(currentLines())).toHaveLength(2);
			expect(
				sessionLedger(runtimeHost.session)
					.getEntries()
					.filter((entry) => entry.type === "custom" && entry.customType === RUN_LEDGER_CUSTOM_TYPE),
			).toHaveLength(ledgerCount);
		} finally {
			await cleanup();
		}
	});

	it("recovers an interrupted accepted run at attempt+1 when resuming", async () => {
		const { lineHandler, cleanup, runtimeHost } = await startRpcMode({ withAuth: true, responseDelayMs: 0 });

		try {
			lineHandler(JSON.stringify({ id: "i1", type: "initialize", protocolVersion: 1 }));
			await vi.waitFor(() => expect(responsesFor(rpcIo.outputLines, "i1")).toHaveLength(1));

			// seed a run so the session is persisted, then append an accepted-only
			// ledger entry that has no terminal fact (an interrupted run).
			lineHandler(JSON.stringify({ id: "r0", type: "run.start", message: "Seed" }));
			await vi.waitFor(() => expect(responsesFor(rpcIo.outputLines, "r0")).toHaveLength(1));
			await vi.waitFor(() => expect(terminalEvents(currentLines())).toHaveLength(1));

			const sessionFile = runtimeHost.session.sessionFile;
			expect(sessionFile).toBeTruthy();
			sessionLedger(runtimeHost.session).appendCustomEntry(RUN_LEDGER_CUSTOM_TYPE, {
				schemaVersion: 1,
				kind: "accepted",
				record: {
					id: "interrupted-run",
					sessionId: runtimeHost.session.sessionId,
					attempt: 1,
					status: "accepted",
					model: { provider: "anthropic", id: "claude-sonnet-4-5", thinkingLevel: "off" },
				},
			});

			// the appended accepted-only entry is replayed by the current coordinator
			// as an interrupted run with no receipt, proving persisted recovery state
			lineHandler(JSON.stringify({ id: "g0", type: "run.get", runId: "interrupted-run" }));
			await vi.waitFor(() => {
				const res = responsesFor(rpcIo.outputLines, "g0");
				expect(res).toHaveLength(1);
				expect(res[0].success).toBe(true);
				const data = res[0].data as {
					run: { id: string; status: string; attempt: number };
					receipt?: unknown;
					recovery?: string;
				};
				expect(data.run.id).toBe("interrupted-run");
				expect(data.run.status).toBe("accepted");
				expect(data.run.attempt).toBe(1);
				expect(data.receipt).toBeUndefined();
				expect(data.recovery).toBe("interrupted");
			});

			lineHandler(
				JSON.stringify({
					id: "rs2",
					type: "run.resume",
					sessionPath: sessionFile!,
					sourceRunId: "interrupted-run",
					message: "Continue",
				}),
			);

			await vi.waitFor(() => {
				const res = responsesFor(rpcIo.outputLines, "rs2");
				expect(res).toHaveLength(1);
				expect(res[0].success).toBe(true);
				const data = res[0].data as { attempt: number; status: string };
				expect(data.attempt).toBe(2);
				expect(data.status).toBe("accepted");
			});

			await vi.waitFor(() => expect(terminalEvents(currentLines())).toHaveLength(2));
		} finally {
			await cleanup();
		}
	});

	it("emits strict JSONL with bare legacy events before initialize", async () => {
		const { lineHandler, cleanup } = await startRpcMode({ withAuth: true, responseDelayMs: 0 });

		try {
			lineHandler(JSON.stringify({ id: "p1", type: "prompt", message: "Hello" }));
			await vi.waitFor(() => expect(responsesFor(rpcIo.outputLines, "p1")).toHaveLength(1));
			expect(responsesFor(rpcIo.outputLines, "p1")[0].success).toBe(true);

			await vi.waitFor(() => expect(runEventsOfType(currentLines(), "agent_settled")).toHaveLength(1));

			// every stdout line is strict JSONL
			for (const line of rpcIo.outputLines) {
				const parts = line.split("\n").filter((part) => part.trim().length > 0);
				for (const part of parts) {
					expect(() => JSON.parse(part)).not.toThrow();
				}
			}

			// legacy mode emits bare session events and no run.* wrapping
			const lines = currentLines();
			expect(lines.some((record) => typeof record.type === "string" && record.type.startsWith("run."))).toBe(false);
			expect(runEventsOfType(lines, "message_start").length).toBeGreaterThanOrEqual(1);
			expect("runId" in runEventsOfType(lines, "agent_settled")[0]).toBe(false);
		} finally {
			await cleanup();
		}
	});

	it("rejects run.start with capability_profile_not_found for an unknown profile", async () => {
		const { lineHandler, cleanup, runtimeHost } = await startRpcMode({ withAuth: true, responseDelayMs: 0 });

		try {
			lineHandler(JSON.stringify({ id: "i1", type: "initialize", protocolVersion: 1 }));
			await vi.waitFor(() => expect(responsesFor(rpcIo.outputLines, "i1")).toHaveLength(1));

			lineHandler(
				JSON.stringify({ id: "u1", type: "run.start", message: "Hello", capabilityProfile: "does-not-exist" }),
			);
			await vi.waitFor(() => expect(responsesFor(rpcIo.outputLines, "u1")).toHaveLength(1));
			const res = responsesFor(rpcIo.outputLines, "u1")[0];
			expect(res.success).toBe(false);
			expect((res.error as { code: string }).code).toBe("capability_profile_not_found");
			expect("data" in res).toBe(false);
			// no run id, no run.* stream events, and nothing persisted to the ledger
			expect(
				currentLines().some((record) => typeof record.type === "string" && record.type.startsWith("run.")),
			).toBe(false);
			const ledgerEntries = sessionLedger(runtimeHost.session)
				.getEntries()
				.filter((entry) => entry.type === "custom" && entry.customType === RUN_LEDGER_CUSTOM_TYPE);
			expect(ledgerEntries).toHaveLength(0);
		} finally {
			await cleanup();
		}
	});

	it("fails run.start with capability_approval_required when the profile needs ask approval", async () => {
		const { lineHandler, cleanup, runtimeHost } = await startRpcMode({ withAuth: true, responseDelayMs: 0 });

		try {
			vi.spyOn(runtimeHost.session, "getActiveCapabilityBinding").mockReturnValue(APPROVAL_BINDING);
			lineHandler(JSON.stringify({ id: "i1", type: "initialize", protocolVersion: 1 }));
			await vi.waitFor(() => expect(responsesFor(rpcIo.outputLines, "i1")).toHaveLength(1));

			lineHandler(JSON.stringify({ id: "a1", type: "run.start", message: "Hello" }));
			await vi.waitFor(() => expect(responsesFor(rpcIo.outputLines, "a1")).toHaveLength(1));
			const res = responsesFor(rpcIo.outputLines, "a1")[0];
			expect(res.success).toBe(false);
			expect((res.error as { code: string }).code).toBe("capability_approval_required");
			expect(terminalEvents(currentLines())).toHaveLength(0);
		} finally {
			await cleanup();
		}
	});

	it("maps a capability discovery failure into a structured capability error", async () => {
		const { lineHandler, cleanup, runtimeHost } = await startRpcMode({ withAuth: true, responseDelayMs: 0 });

		try {
			vi.spyOn(runtimeHost.session, "whenCapabilitiesReady").mockRejectedValue(
				new CapabilityError("capability_name_conflict", "Multiple capabilities expose the same tool name"),
			);
			lineHandler(JSON.stringify({ id: "i1", type: "initialize", protocolVersion: 1 }));
			await vi.waitFor(() => expect(responsesFor(rpcIo.outputLines, "i1")).toHaveLength(1));

			lineHandler(JSON.stringify({ id: "c1", type: "run.start", message: "Hello" }));
			await vi.waitFor(() => expect(responsesFor(rpcIo.outputLines, "c1")).toHaveLength(1));
			const res = responsesFor(rpcIo.outputLines, "c1")[0];
			expect(res.success).toBe(false);
			expect((res.error as { code: string }).code).toBe("capability_name_conflict");
			expect(terminalEvents(currentLines())).toHaveLength(0);
		} finally {
			await cleanup();
		}
	});

	it("redacts secrets from structured Automation error messages on the wire", async () => {
		const { lineHandler, cleanup, runtimeHost } = await startRpcMode({ withAuth: true, responseDelayMs: 0 });

		try {
			vi.spyOn(runtimeHost.session, "whenCapabilitiesReady").mockRejectedValue(
				new CapabilityError(
					"capability_mcp_connect_failed",
					"MCP connect failed: https://user:secret@mcp.example.invalid token=abc123",
				),
			);
			lineHandler(JSON.stringify({ id: "i1", type: "initialize", protocolVersion: 1 }));
			await vi.waitFor(() => expect(responsesFor(rpcIo.outputLines, "i1")).toHaveLength(1));

			lineHandler(JSON.stringify({ id: "r1", type: "run.start", message: "Hello" }));
			await vi.waitFor(() => expect(responsesFor(rpcIo.outputLines, "r1")).toHaveLength(1));
			const res = responsesFor(rpcIo.outputLines, "r1")[0];
			expect(res.success).toBe(false);
			const message = (res.error as { message: string }).message;
			expect(message).not.toContain("secret");
			expect(message).not.toContain("abc123");
			expect(message).toBe("Automation request failed.");
			expect(JSON.stringify(res)).not.toMatch(/secret|abc123|user:pass/);
		} finally {
			await cleanup();
		}
	});

	it("records capabilityBindingId on the RunRecord and omits it from the minimal receipt", async () => {
		const { lineHandler, cleanup, runtimeHost } = await startRpcMode({ withAuth: true, responseDelayMs: 0 });

		try {
			vi.spyOn(runtimeHost.session, "getActiveCapabilityBinding").mockReturnValue(BINDING);
			lineHandler(JSON.stringify({ id: "i1", type: "initialize", protocolVersion: 1 }));
			await vi.waitFor(() => expect(responsesFor(rpcIo.outputLines, "i1")).toHaveLength(1));

			lineHandler(JSON.stringify({ id: "r1", type: "run.start", message: "Hello" }));
			await vi.waitFor(() => expect(responsesFor(rpcIo.outputLines, "r1")).toHaveLength(1));
			await vi.waitFor(() => expect(terminalEvents(currentLines())).toHaveLength(1));

			const terminal = terminalEvents(currentLines())[0];
			expect(terminal.type).toBe("run.completed");
			const runId = (responsesFor(rpcIo.outputLines, "r1")[0].data as { runId: string }).runId;
			expect(transportRunRecord(sessionLedger(runtimeHost.session), runId)?.capabilityBindingId).toBe(BINDING.id);
			expect("capabilityBindingId" in (terminal.receipt as Record<string, unknown>)).toBe(false);
		} finally {
			await cleanup();
		}
	});

	it("exposes get_capabilities as an ordinary redacted command before initialize", async () => {
		const { lineHandler, cleanup, runtimeHost } = await startRpcMode({ withAuth: true, responseDelayMs: 0 });

		try {
			lineHandler(JSON.stringify({ id: "gc1", type: "get_capabilities" }));
			await vi.waitFor(() => expect(responsesFor(rpcIo.outputLines, "gc1")).toHaveLength(1));
			const res = responsesFor(rpcIo.outputLines, "gc1")[0];
			expect(res.success).toBe(true);
			const data = res.data as { binding: { id: string } | null; bindings: unknown[] };
			// the session's frozen binding is inspectable without any run, and no
			// ledger binding history exists yet
			expect(data.binding?.id).toBe(runtimeHost.session.getCapabilityBindingId());
			expect(Array.isArray(data.bindings)).toBe(true);
			expect(data.bindings).toHaveLength(0);
		} finally {
			await cleanup();
		}
	});

	it("returns the redacted current binding and ledger history from get_capabilities", async () => {
		const { lineHandler, cleanup, runtimeHost } = await startRpcMode({ withAuth: true, responseDelayMs: 0 });

		try {
			vi.spyOn(runtimeHost.session, "getActiveCapabilityBinding").mockReturnValue(BINDING);
			lineHandler(JSON.stringify({ id: "i1", type: "initialize", protocolVersion: 1 }));
			await vi.waitFor(() => expect(responsesFor(rpcIo.outputLines, "i1")).toHaveLength(1));

			lineHandler(JSON.stringify({ id: "r1", type: "run.start", message: "Hello" }));
			await vi.waitFor(() => expect(responsesFor(rpcIo.outputLines, "r1")).toHaveLength(1));
			await vi.waitFor(() => expect(terminalEvents(currentLines())).toHaveLength(1));

			lineHandler(JSON.stringify({ id: "gc1", type: "get_capabilities" }));
			await vi.waitFor(() => expect(responsesFor(rpcIo.outputLines, "gc1")).toHaveLength(1));
			const res = responsesFor(rpcIo.outputLines, "gc1")[0];
			expect(res.success).toBe(true);
			const data = res.data as {
				binding: {
					id: string;
					profile: string;
					descriptors: unknown[];
					decisionSummary: unknown;
					toolAllowlist: string[];
				};
				bindings: { id: string }[];
			};
			expect(data.binding?.id).toBe(BINDING.id);
			expect(data.binding?.profile).toBe("default");
			expect(data.binding?.toolAllowlist).toEqual(["Read"]);
			expect(data.bindings.map((binding) => binding.id)).toContain(BINDING.id);
			// redacted: the serialized record must never carry secret-shaped keys or values
			const json = JSON.stringify(res);
			expect(json).not.toMatch(/secret|token|authorization|api[_-]?key|password/i);
		} finally {
			await cleanup();
		}
	});

	it("rejects get_capabilities with a plain string error for an unknown binding id", async () => {
		const { lineHandler, cleanup } = await startRpcMode({ withAuth: true, responseDelayMs: 0 });

		try {
			lineHandler(JSON.stringify({ id: "gc1", type: "get_capabilities", bindingId: "binding:ghost:nope" }));
			await vi.waitFor(() => expect(responsesFor(rpcIo.outputLines, "gc1")).toHaveLength(1));
			const res = responsesFor(rpcIo.outputLines, "gc1")[0];
			expect(res.success).toBe(false);
			expect(typeof res.error).toBe("string");
			expect(res.error as string).toContain("Capability binding not found");
		} finally {
			await cleanup();
		}
	});

	it("returns a redacted catalog that includes sdk tool descriptors from get_capabilities", async () => {
		const customTool: ToolDefinition = {
			name: "cat_tool",
			label: "cat_tool",
			description: "a custom catalog tool",
			parameters: Type.Object({ query: Type.String() }),
			execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
		};
		const { lineHandler, cleanup } = await startRpcMode({
			withAuth: true,
			responseDelayMs: 0,
			customTools: [customTool],
		});

		try {
			lineHandler(JSON.stringify({ id: "i1", type: "initialize", protocolVersion: 1 }));
			await vi.waitFor(() => expect(responsesFor(rpcIo.outputLines, "i1")).toHaveLength(1));

			lineHandler(JSON.stringify({ id: "r1", type: "run.start", message: "Hello" }));
			await vi.waitFor(() => expect(responsesFor(rpcIo.outputLines, "r1")).toHaveLength(1));
			await vi.waitFor(() => expect(terminalEvents(currentLines())).toHaveLength(1));

			lineHandler(JSON.stringify({ id: "gc1", type: "get_capabilities" }));
			await vi.waitFor(() => expect(responsesFor(rpcIo.outputLines, "gc1")).toHaveLength(1));
			const res = responsesFor(rpcIo.outputLines, "gc1")[0];
			expect(res.success).toBe(true);
			const data = res.data as { catalog: { version: number; descriptors: Array<Record<string, unknown>> } };
			expect(data.catalog.version).toBe(1);
			expect(Array.isArray(data.catalog.descriptors)).toBe(true);
			expect(data.catalog.descriptors.length).toBeGreaterThan(0);
			const toolDescriptor = data.catalog.descriptors.find(
				(descriptor) => descriptor.kind === "sdk_tool" && descriptor.name === "cat_tool",
			);
			expect(toolDescriptor).toBeDefined();
			expect(toolDescriptor!.source).toMatchObject({ scope: "temporary", origin: "top-level" });
			expect((toolDescriptor!.source as { source?: unknown }).source).toMatch(/^source:[A-Za-z0-9_-]{43}$/);

			// Redaction contract: every descriptor's source is exactly the public
			// { source, scope, origin } triple and no descriptor carries path, config,
			// env, url, token, or instructions payloads.
			for (const descriptor of data.catalog.descriptors) {
				expect(Object.keys(descriptor.source as Record<string, unknown>)).toEqual(["source", "scope", "origin"]);
				for (const stripped of ["path", "config", "env", "url", "token", "instructions"]) {
					expect(descriptor).not.toHaveProperty(stripped);
				}
			}
			expect(JSON.stringify(res)).not.toMatch(/secret|token|authorization|api[_-]?key|password/i);
		} finally {
			await cleanup();
		}
	});

	it("never leaks project resource paths into the capability catalog", async () => {
		const realTempPath = join(tmpdir(), `aos-rpc-skill-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const skillName = "project_skill";
		const skills: Skill[] = [
			{
				name: skillName,
				description: "a project-scoped skill with a real file path",
				filePath: realTempPath,
				baseDir: realTempPath,
				sourceInfo: createSyntheticSourceInfo(realTempPath, { source: "local", scope: "project" }),
				disableModelInvocation: false,
			},
		];
		const projectResourceLoader: ResourceLoader = {
			...testResourceLoader(),
			getSkills: () => ({ skills, diagnostics: [] }),
		};
		const { lineHandler, cleanup } = await startRpcMode({
			withAuth: true,
			responseDelayMs: 0,
			resourceLoader: projectResourceLoader,
		});

		try {
			lineHandler(JSON.stringify({ id: "i1", type: "initialize", protocolVersion: 1 }));
			await vi.waitFor(() => expect(responsesFor(rpcIo.outputLines, "i1")).toHaveLength(1));

			lineHandler(JSON.stringify({ id: "r1", type: "run.start", message: "Hello" }));
			await vi.waitFor(() => expect(responsesFor(rpcIo.outputLines, "r1")).toHaveLength(1));
			await vi.waitFor(() => expect(terminalEvents(currentLines())).toHaveLength(1));

			lineHandler(JSON.stringify({ id: "gc1", type: "get_capabilities" }));
			await vi.waitFor(() => expect(responsesFor(rpcIo.outputLines, "gc1")).toHaveLength(1));
			const res = responsesFor(rpcIo.outputLines, "gc1")[0];
			expect(res.success).toBe(true);
			const data = res.data as { catalog: { descriptors: Array<Record<string, unknown>> } };
			const skillDescriptor = data.catalog.descriptors.find(
				(descriptor) => descriptor.kind === "skill" && descriptor.name === skillName,
			);
			expect(skillDescriptor).toBeDefined();
			expect(skillDescriptor!.source).toMatchObject({ scope: "project", origin: "top-level" });
			expect((skillDescriptor!.source as { source?: unknown }).source).toMatch(/^source:[A-Za-z0-9_-]{43}$/);
			// the raw file path is stripped from every serialized capability record
			expect(JSON.stringify(res)).not.toContain(realTempPath);
			for (const descriptor of data.catalog.descriptors) {
				expect(descriptor).not.toHaveProperty("path");
			}
		} finally {
			await cleanup();
		}
	});

	it("recovers the original binding for an interrupted source run on resume", async () => {
		const { lineHandler, cleanup, runtimeHost } = await startRpcMode({ withAuth: true, responseDelayMs: 0 });

		try {
			lineHandler(JSON.stringify({ id: "i1", type: "initialize", protocolVersion: 1 }));
			await vi.waitFor(() => expect(responsesFor(rpcIo.outputLines, "i1")).toHaveLength(1));

			// Seed a real run so the capability binding is resolved and persisted,
			// then read the real binding id from its accepted RunRecord.
			lineHandler(JSON.stringify({ id: "r0", type: "run.start", message: "Seed" }));
			await vi.waitFor(() => expect(responsesFor(rpcIo.outputLines, "r0")).toHaveLength(1));
			await vi.waitFor(() => expect(terminalEvents(currentLines())).toHaveLength(1));
			const sourceRunId = (responsesFor(rpcIo.outputLines, "r0")[0].data as { runId: string }).runId;
			const sourceBindingId = transportRunRecord(
				sessionLedger(runtimeHost.session),
				sourceRunId,
			)?.capabilityBindingId as string | undefined;
			expect(sourceBindingId).toBeTruthy();

			const sessionFile = runtimeHost.session.sessionFile;
			expect(sessionFile).toBeTruthy();

			// An interrupted run: the accepted fact recorded the original binding
			// (its capability.binding ledger entry exists from the seed run's accept)
			// but the run never reached a terminal receipt.
			const interruptedRunId = "interrupted-with-binding";
			sessionLedger(runtimeHost.session).appendCustomEntry(RUN_LEDGER_CUSTOM_TYPE, {
				schemaVersion: 1,
				kind: "accepted",
				record: {
					id: interruptedRunId,
					sessionId: runtimeHost.session.sessionId,
					attempt: 1,
					status: "accepted",
					model: { provider: "anthropic", id: "claude-sonnet-4-5", thinkingLevel: "off" },
					capabilityBindingId: sourceBindingId,
				},
			});

			// The record fallback (receipt ?? record.capabilityBindingId) recovers the
			// original binding, so the drift guard passes and the resume succeeds.
			lineHandler(
				JSON.stringify({
					id: "rs1",
					type: "run.resume",
					sessionPath: sessionFile!,
					sourceRunId: interruptedRunId,
					message: "Continue",
				}),
			);
			let resumedRunId: string;
			await vi.waitFor(() => {
				const res = responsesFor(rpcIo.outputLines, "rs1");
				expect(res).toHaveLength(1);
				expect(res[0].success).toBe(true);
				resumedRunId = (res[0].data as { runId: string }).runId;
			});
			await vi.waitFor(() => expect(terminalEvents(currentLines())).toHaveLength(2));

			lineHandler(JSON.stringify({ id: "g1", type: "run.get", runId: resumedRunId! }));
			await vi.waitFor(() => {
				const res = responsesFor(rpcIo.outputLines, "g1");
				expect(res).toHaveLength(1);
				expect(res[0].success).toBe(true);
				const data = res[0].data as { run: { attempt: number; previousBindingId?: string } };
				expect(data.run.attempt).toBe(2);
				expect(data.run.previousBindingId).toBe(sourceBindingId);
			});
		} finally {
			await cleanup();
		}
	});

	it("keeps resume backward compatible when the historical ledger carries no binding", async () => {
		const { lineHandler, cleanup, runtimeHost } = await startRpcMode({ withAuth: true, responseDelayMs: 0 });

		try {
			lineHandler(JSON.stringify({ id: "i1", type: "initialize", protocolVersion: 1 }));
			await vi.waitFor(() => expect(responsesFor(rpcIo.outputLines, "i1")).toHaveLength(1));

			// seed a run so the session is persisted
			lineHandler(JSON.stringify({ id: "r0", type: "run.start", message: "Seed" }));
			await vi.waitFor(() => expect(responsesFor(rpcIo.outputLines, "r0")).toHaveLength(1));
			await vi.waitFor(() => expect(terminalEvents(currentLines())).toHaveLength(1));

			const sessionFile = runtimeHost.session.sessionFile;
			expect(sessionFile).toBeTruthy();

			// a legacy run carrying no capabilityBindingId anywhere (pre-capability
			// ledger); the canonical receipt remains the minimal Foundation projection
			const legacyRunId = "legacy-no-binding";
			const sessionId = runtimeHost.session.sessionId;
			sessionLedger(runtimeHost.session).appendCustomEntry(RUN_LEDGER_CUSTOM_TYPE, {
				schemaVersion: 1,
				kind: "accepted",
				record: {
					id: legacyRunId,
					sessionId,
					attempt: 1,
					status: "accepted",
					model: { provider: "anthropic", id: "claude-sonnet-4-5", thinkingLevel: "off" },
				},
			});
			sessionLedger(runtimeHost.session).appendCustomEntry(RUN_LEDGER_CUSTOM_TYPE, {
				schemaVersion: 1,
				kind: "started",
				runId: legacyRunId,
				startedAt: "2026-08-11T00:00:00.000Z",
			});
			await writeCanonicalRunResult(getAgentCanonicalSession(runtimeHost.session), legacyRunId, { outcome: "completed" });

			// previousBindingId is undefined, so no drift guard runs and the resume
			// succeeds without requiring any binding in the ledger.
			lineHandler(
				JSON.stringify({
					id: "rs1",
					type: "run.resume",
					sessionPath: sessionFile!,
					sourceRunId: legacyRunId,
					message: "Continue",
				}),
			);
			let resumedRunId: string;
			await vi.waitFor(() => {
				const res = responsesFor(rpcIo.outputLines, "rs1");
				expect(res).toHaveLength(1);
				expect(res[0].success).toBe(true);
				resumedRunId = (res[0].data as { runId: string }).runId;
			});
			await vi.waitFor(() => expect(terminalEvents(currentLines())).toHaveLength(2));

			lineHandler(JSON.stringify({ id: "g1", type: "run.get", runId: resumedRunId! }));
			await vi.waitFor(() => {
				const res = responsesFor(rpcIo.outputLines, "g1");
				expect(res).toHaveLength(1);
				expect(res[0].success).toBe(true);
				const data = res[0].data as { run: { attempt: number; previousBindingId?: string } };
				expect(data.run.attempt).toBe(2);
				expect(data.run.previousBindingId).toBeUndefined();
			});
		} finally {
			await cleanup();
		}
	});

	it("resumes with a successor attempt linking previousBindingId and capabilityBindingId", async () => {
		const { lineHandler, cleanup, runtimeHost } = await startRpcMode({ withAuth: true, responseDelayMs: 0 });

		try {
			lineHandler(JSON.stringify({ id: "i1", type: "initialize", protocolVersion: 1 }));
			await vi.waitFor(() => expect(responsesFor(rpcIo.outputLines, "i1")).toHaveLength(1));

			lineHandler(JSON.stringify({ id: "r1", type: "run.start", message: "First" }));
			let runId: string;
			await vi.waitFor(() => {
				const res = responsesFor(rpcIo.outputLines, "r1");
				expect(res).toHaveLength(1);
				runId = (res[0].data as { runId: string }).runId;
			});
			await vi.waitFor(() => expect(terminalEvents(currentLines())).toHaveLength(1));
			// the frozen (real) binding is recorded on the source RunRecord
			const sourceBindingId = transportRunRecord(
				sessionLedger(runtimeHost.session),
				runId!,
			)?.capabilityBindingId as string | undefined;
			expect(sourceBindingId).toBeTruthy();
			expect(sourceBindingId).toBe(runtimeHost.session.getCapabilityBindingId());

			const sessionFile = runtimeHost.session.sessionFile;
			expect(sessionFile).toBeTruthy();

			lineHandler(
				JSON.stringify({
					id: "rs1",
					type: "run.resume",
					sessionPath: sessionFile!,
					sourceRunId: runId!,
					message: "Continue",
				}),
			);
			let resumedRunId: string;
			await vi.waitFor(() => {
				const res = responsesFor(rpcIo.outputLines, "rs1");
				expect(res).toHaveLength(1);
				expect(res[0].success).toBe(true);
				resumedRunId = (res[0].data as { runId: string }).runId;
			});
			await vi.waitFor(() => expect(terminalEvents(currentLines())).toHaveLength(2));

			lineHandler(JSON.stringify({ id: "g1", type: "run.get", runId: resumedRunId! }));
			await vi.waitFor(() => {
				const res = responsesFor(rpcIo.outputLines, "g1");
				expect(res).toHaveLength(1);
				expect(res[0].success).toBe(true);
				const data = res[0].data as {
					run: { attempt: number; sourceRunId?: string; previousBindingId?: string };
				};
				expect(data.run.attempt).toBe(2);
				expect(data.run.sourceRunId).toBe(runId);
				expect(data.run.previousBindingId).toBe(sourceBindingId);
			});
		} finally {
			await cleanup();
		}
	});

	it("rejects resume with capability_binding_unavailable when the settled binding drifted from the recorded one", async () => {
		const { lineHandler, cleanup, runtimeHost } = await startRpcMode({ withAuth: true, responseDelayMs: 0 });

		try {
			// Record a fake old binding on the first run. After switch the restored
			// session resolves its real (different) binding, i.e. version drift.
			vi.spyOn(runtimeHost.session, "getActiveCapabilityBinding").mockReturnValue(BINDING);
			lineHandler(JSON.stringify({ id: "i1", type: "initialize", protocolVersion: 1 }));
			await vi.waitFor(() => expect(responsesFor(rpcIo.outputLines, "i1")).toHaveLength(1));

			lineHandler(JSON.stringify({ id: "r1", type: "run.start", message: "First" }));
			let runId: string;
			await vi.waitFor(() => {
				const res = responsesFor(rpcIo.outputLines, "r1");
				expect(res).toHaveLength(1);
				runId = (res[0].data as { runId: string }).runId;
			});
			await vi.waitFor(() => expect(terminalEvents(currentLines())).toHaveLength(1));
			expect(transportRunRecord(sessionLedger(runtimeHost.session), runId!)?.capabilityBindingId).toBe(BINDING.id);

			const sessionFile = runtimeHost.session.sessionFile;
			expect(sessionFile).toBeTruthy();

			lineHandler(
				JSON.stringify({
					id: "rs1",
					type: "run.resume",
					sessionPath: sessionFile!,
					sourceRunId: runId!,
					message: "Continue",
				}),
			);
			await vi.waitFor(() => expect(responsesFor(rpcIo.outputLines, "rs1")).toHaveLength(1));
			const rejection = responsesFor(rpcIo.outputLines, "rs1")[0];
			expect(rejection.success).toBe(false);
			expect((rejection.error as { code: string }).code).toBe("capability_binding_unavailable");
			// rejected before any accepted/terminal ledger write for a successor run
			expect(terminalEvents(currentLines())).toHaveLength(1);
			expect(
				sessionLedger(runtimeHost.session)
					.getEntries()
					.filter((entry) => entry.type === "custom" && entry.customType === RUN_LEDGER_CUSTOM_TYPE),
			).toHaveLength(2); // accepted + started transport facts of the first run only
		} finally {
			await cleanup();
		}
	});

	it("rejects resume after a reloaded static tool schema changes its capability binding", async () => {
		const customTool: ToolDefinition = {
			name: "reloadable_tool",
			label: "reloadable_tool",
			description: "version one",
			parameters: Type.Object({ query: Type.String() }),
			execute: async () => ({ content: [{ type: "text", text: "ok" }], details: {} }),
		};
		const { lineHandler, cleanup, runtimeHost } = await startRpcMode({
			withAuth: true,
			responseDelayMs: 0,
			customTools: [customTool],
		});

		try {
			lineHandler(JSON.stringify({ id: "i1", type: "initialize", protocolVersion: 1 }));
			await vi.waitFor(() => expect(responsesFor(rpcIo.outputLines, "i1")).toHaveLength(1));

			lineHandler(JSON.stringify({ id: "r1", type: "run.start", message: "First" }));
			let runId: string;
			await vi.waitFor(() => {
				const res = responsesFor(rpcIo.outputLines, "r1");
				expect(res).toHaveLength(1);
				runId = (res[0].data as { runId: string }).runId;
			});
			await vi.waitFor(() => expect(terminalEvents(currentLines())).toHaveLength(1));

			const sessionFile = runtimeHost.session.sessionFile;
			expect(sessionFile).toBeTruthy();
			const originalBindingId = runtimeHost.session.getCapabilityBindingId();
			expect(originalBindingId).toMatch(/^binding:/);

			// The active session is reconstructed from the current public tool
			// definition on reload. Change the schema and description before that
			// reload; the resulting binding must not be accepted as the old one.
			customTool.description = "version two";
			customTool.parameters = Type.Object({ query: Type.String(), limit: Type.Number() });
			await runtimeHost.session.reload();
			expect(runtimeHost.session.getCapabilityBindingId()).not.toBe(originalBindingId);

			lineHandler(
				JSON.stringify({
					id: "rs1",
					type: "run.resume",
					sessionPath: sessionFile!,
					sourceRunId: runId!,
					message: "Continue",
				}),
			);

			await vi.waitFor(() => expect(responsesFor(rpcIo.outputLines, "rs1")).toHaveLength(1));
			const rejection = responsesFor(rpcIo.outputLines, "rs1")[0];
			expect(rejection.success).toBe(false);
			expect((rejection.error as { code: string }).code).toBe("capability_binding_unavailable");
			// No successor run is accepted after the binding drift is detected:
			// neither a new terminal nor any new run ledger entry is written.
			expect(terminalEvents(currentLines())).toHaveLength(1);
			expect(
				sessionLedger(runtimeHost.session)
					.getEntries()
					.filter((entry) => entry.type === "custom" && entry.customType === RUN_LEDGER_CUSTOM_TYPE),
			).toHaveLength(2); // accepted + started transport facts of the first run only
		} finally {
			await cleanup();
		}
	});

	it("awaits capability readiness before the resume drift comparison", async () => {
		const { lineHandler, cleanup, runtimeHost } = await startRpcMode({ withAuth: true, responseDelayMs: 0 });

		try {
			lineHandler(JSON.stringify({ id: "i1", type: "initialize", protocolVersion: 1 }));
			await vi.waitFor(() => expect(responsesFor(rpcIo.outputLines, "i1")).toHaveLength(1));

			// seed a persisted run whose receipt records the real binding
			lineHandler(JSON.stringify({ id: "r0", type: "run.start", message: "Seed" }));
			let seedRunId: string;
			await vi.waitFor(() => {
				const res = responsesFor(rpcIo.outputLines, "r0");
				expect(res).toHaveLength(1);
				seedRunId = (res[0].data as { runId: string }).runId;
			});
			await vi.waitFor(() => expect(terminalEvents(currentLines())).toHaveLength(1));
			const sessionFile = runtimeHost.session.sessionFile;
			expect(sessionFile).toBeTruthy();

			// From here on, capability discovery fails for every session (including the
			// restored one). The discovery error must surface instead of a premature
			// drift rejection, proving readiness is awaited before the drift check.
			const readinessSpy = vi
				.spyOn(AgentSession.prototype, "whenCapabilitiesReady")
				.mockRejectedValue(new CapabilityError("capability_mcp_connect_failed", "MCP discovery failed"));

			lineHandler(
				JSON.stringify({
					id: "rs1",
					type: "run.resume",
					sessionPath: sessionFile!,
					sourceRunId: seedRunId!,
					message: "Continue",
				}),
			);
			await vi.waitFor(() => expect(responsesFor(rpcIo.outputLines, "rs1")).toHaveLength(1));
			const res = responsesFor(rpcIo.outputLines, "rs1")[0];
			expect(res.success).toBe(false);
			expect((res.error as { code: string }).code).toBe("capability_mcp_connect_failed");
			expect((res.error as { message: string }).message).toBe("Automation request failed.");
			readinessSpy.mockRestore();
		} finally {
			await cleanup();
		}
	});

	it("fails resume with capability_binding_unavailable when the source binding is not in the ledger", async () => {
		const { lineHandler, cleanup, runtimeHost } = await startRpcMode({ withAuth: true, responseDelayMs: 0 });

		try {
			lineHandler(JSON.stringify({ id: "i1", type: "initialize", protocolVersion: 1 }));
			await vi.waitFor(() => expect(responsesFor(rpcIo.outputLines, "i1")).toHaveLength(1));

			// seed so the session is persisted
			lineHandler(JSON.stringify({ id: "r0", type: "run.start", message: "Seed" }));
			await vi.waitFor(() => expect(responsesFor(rpcIo.outputLines, "r0")).toHaveLength(1));
			await vi.waitFor(() => expect(terminalEvents(currentLines())).toHaveLength(1));

			const sessionFile = runtimeHost.session.sessionFile;
			expect(sessionFile).toBeTruthy();
			// a source RunRecord demands a binding that was never recorded
			sessionLedger(runtimeHost.session).appendCustomEntry(RUN_LEDGER_CUSTOM_TYPE, {
				schemaVersion: 1,
				kind: "accepted",
				record: {
					id: "ghost-cap",
					sessionId: runtimeHost.session.sessionId,
					attempt: 1,
					status: "accepted",
					model: { provider: "anthropic", id: "claude-sonnet-4-5", thinkingLevel: "off" },
					capabilityBindingId: "binding:ghost:nope",
				},
			});
			await writeCanonicalRunResult(getAgentCanonicalSession(runtimeHost.session), "ghost-cap", { outcome: "completed" });

			lineHandler(
				JSON.stringify({
					id: "rs1",
					type: "run.resume",
					sessionPath: sessionFile!,
					sourceRunId: "ghost-cap",
					message: "Continue",
				}),
			);
			await vi.waitFor(() => expect(responsesFor(rpcIo.outputLines, "rs1")).toHaveLength(1));
			const rejection = responsesFor(rpcIo.outputLines, "rs1")[0];
			expect(rejection.success).toBe(false);
			expect((rejection.error as { code: string }).code).toBe("capability_binding_unavailable");
			// no successor run was accepted
			expect(terminalEvents(currentLines())).toHaveLength(1);
		} finally {
			await cleanup();
		}
	});

	it("materializes an existing non-default profile via setCapabilityProfile preflight", async () => {
		const { lineHandler, cleanup, runtimeHost } = await startRpcMode({ withAuth: true, responseDelayMs: 0 });

		try {
			// Add an existing-but-non-default profile. Requesting it materializes the
			// profile into the frozen binding before the run instead of rejecting it.
			vi.spyOn(runtimeHost.session.settingsManager, "getCapabilitySettings").mockReturnValue({
				defaultProfile: "default",
				profiles: {
					default: { rules: [] },
					strict: { rules: [] },
				},
				mcpServers: [],
			});
			lineHandler(JSON.stringify({ id: "i1", type: "initialize", protocolVersion: 1 }));
			await vi.waitFor(() => expect(responsesFor(rpcIo.outputLines, "i1")).toHaveLength(1));

			lineHandler(JSON.stringify({ id: "u1", type: "run.start", message: "Hello", capabilityProfile: "strict" }));
			await vi.waitFor(() => {
				const res = responsesFor(rpcIo.outputLines, "u1");
				expect(res).toHaveLength(1);
				expect(res[0].success).toBe(true);
			});
			// the requested profile was materialized into the frozen binding
			expect(runtimeHost.session.getActiveCapabilityProfile()).toBe("strict");
			expect(runtimeHost.session.getActiveCapabilityBinding()?.profile).toBe("strict");

			await vi.waitFor(() => expect(terminalEvents(currentLines())).toHaveLength(1));
			const terminal = terminalEvents(currentLines())[0];
			expect(terminal.type).toBe("run.completed");
			// binding provenance belongs to the accepted RunRecord, not the receipt
			const strictRunId = (responsesFor(rpcIo.outputLines, "u1")[0].data as { runId: string }).runId;
			expect(transportRunRecord(sessionLedger(runtimeHost.session), strictRunId)?.capabilityBindingId).toBe(
				runtimeHost.session.getActiveCapabilityBinding()?.id,
			);
			expect("capabilityBindingId" in (terminal.receipt as Record<string, unknown>)).toBe(false);
		} finally {
			await cleanup();
		}
	});

	it("converts a setCapabilityProfile preflight failure into a structured capability error before any ledger write", async () => {
		const { lineHandler, cleanup, runtimeHost } = await startRpcMode({ withAuth: true, responseDelayMs: 0 });

		try {
			lineHandler(JSON.stringify({ id: "i1", type: "initialize", protocolVersion: 1 }));
			await vi.waitFor(() => expect(responsesFor(rpcIo.outputLines, "i1")).toHaveLength(1));

			// A profile materialization failure surfaces as a structured capability
			// error before reserve/prompt, so no run id, no run.* stream events, and
			// no ledger write occur, and the session is not left busy.
			const setProfileSpy = vi
				.spyOn(runtimeHost.session, "setCapabilityProfile")
				.mockRejectedValue(new CapabilityError("capability_mcp_connect_failed", "MCP connect failed for profile"));

			lineHandler(JSON.stringify({ id: "u1", type: "run.start", message: "Hello", capabilityProfile: "strict" }));
			await vi.waitFor(() => expect(responsesFor(rpcIo.outputLines, "u1")).toHaveLength(1));
			const res = responsesFor(rpcIo.outputLines, "u1")[0];
			expect(res.success).toBe(false);
			expect((res.error as { code: string }).code).toBe("capability_mcp_connect_failed");
			expect("data" in res).toBe(false);
			expect(
				currentLines().some((record) => typeof record.type === "string" && record.type.startsWith("run.")),
			).toBe(false);
			expect(
				sessionLedger(runtimeHost.session)
					.getEntries()
					.filter((entry) => entry.type === "custom" && entry.customType === RUN_LEDGER_CUSTOM_TYPE),
			).toHaveLength(0);

			// the failed preflight reserved nothing, so a valid run starts immediately
			setProfileSpy.mockRestore();
			lineHandler(JSON.stringify({ id: "u2", type: "run.start", message: "Hello" }));
			await vi.waitFor(() => {
				const res = responsesFor(rpcIo.outputLines, "u2");
				expect(res).toHaveLength(1);
				expect(res[0].success).toBe(true);
			});
			await vi.waitFor(() => expect(terminalEvents(currentLines())).toHaveLength(1));
		} finally {
			await cleanup();
		}
	});

	it("omits capabilityProfile to fall back to the configured default after another profile was active", async () => {
		const { lineHandler, cleanup, runtimeHost } = await startRpcMode({ withAuth: true, responseDelayMs: 0 });

		try {
			vi.spyOn(runtimeHost.session.settingsManager, "getCapabilitySettings").mockReturnValue({
				defaultProfile: "default",
				profiles: {
					default: { rules: [] },
					strict: { rules: [] },
				},
				mcpServers: [],
			});
			lineHandler(JSON.stringify({ id: "i1", type: "initialize", protocolVersion: 1 }));
			await vi.waitFor(() => expect(responsesFor(rpcIo.outputLines, "i1")).toHaveLength(1));

			// an explicit non-default profile is materialized first
			lineHandler(JSON.stringify({ id: "s1", type: "run.start", message: "Strict", capabilityProfile: "strict" }));
			await vi.waitFor(() => {
				const res = responsesFor(rpcIo.outputLines, "s1");
				expect(res).toHaveLength(1);
				expect(res[0].success).toBe(true);
			});
			expect(runtimeHost.session.getActiveCapabilityProfile()).toBe("strict");
			await vi.waitFor(() => expect(terminalEvents(currentLines())).toHaveLength(1));

			// an omitted profile is forwarded as undefined so the Session API
			// materializes the configured default; the binding reverts to default
			const setProfileSpy = vi.spyOn(runtimeHost.session, "setCapabilityProfile");
			lineHandler(JSON.stringify({ id: "d1", type: "run.start", message: "Default" }));
			await vi.waitFor(() => {
				const res = responsesFor(rpcIo.outputLines, "d1");
				expect(res).toHaveLength(1);
				expect(res[0].success).toBe(true);
			});
			expect(setProfileSpy).toHaveBeenCalledWith(undefined, { runId: expect.any(String) });
			expect(runtimeHost.session.getActiveCapabilityProfile()).toBe("default");
			expect(runtimeHost.session.getActiveCapabilityBinding()?.profile).toBe("default");
			await vi.waitFor(() => expect(terminalEvents(currentLines())).toHaveLength(2));
		} finally {
			await cleanup();
		}
	});

	it("redacts a model-error terminal on the wire and never persists a transport terminal", async () => {
		const { lineHandler, cleanup, runtimeHost } = await startRpcMode({
			withAuth: true,
			responseDelayMs: 0,
			streamErrorMessage: "connect to https://user:secret@mcp.example.invalid token=abc123",
		});

		try {
			lineHandler(JSON.stringify({ id: "i1", type: "initialize", protocolVersion: 1 }));
			await vi.waitFor(() => expect(responsesFor(rpcIo.outputLines, "i1")).toHaveLength(1));

			lineHandler(JSON.stringify({ id: "r1", type: "run.start", message: "Hello" }));
			await vi.waitFor(() => expect(responsesFor(rpcIo.outputLines, "r1")).toHaveLength(1));
			await vi.waitFor(() => expect(terminalEvents(currentLines())).toHaveLength(1));

			const terminal = terminalEvents(currentLines())[0];
			expect(terminal.type).toBe("run.failed");
			const wireMessage =
				(terminal.receipt as { terminalError?: { message: string } }).terminalError?.message ?? "";
			expect(wireMessage).not.toContain("secret");
			expect(wireMessage).not.toContain("abc123");
			expect(wireMessage).toBe("Run failed.");
			expect(JSON.stringify(terminal)).not.toMatch(/secret|abc123/);

			// The Automation transport ledger contains only accepted and started facts.
			const ledger = sessionLedger(runtimeHost.session)
				.getEntries()
				.filter((entry) => entry.type === "custom" && entry.customType === RUN_LEDGER_CUSTOM_TYPE);
			expect(ledger).toHaveLength(2);
			expect(
				ledger.some(
					(entry) => entry.type === "custom" && (entry.data as { kind?: string }).kind === "terminal",
				),
			).toBe(false);
			expect(JSON.stringify(sessionLedger(runtimeHost.session).getEntries())).not.toMatch(/secret|abc123/);
		} finally {
			await cleanup();
		}
	});

	it("keeps a single terminal when cancel races a fast completion", async () => {
		const { lineHandler, cleanup } = await startRpcMode({ withAuth: true, responseDelayMs: 0 });

		try {
			lineHandler(JSON.stringify({ id: "i1", type: "initialize", protocolVersion: 1 }));
			await vi.waitFor(() => expect(responsesFor(rpcIo.outputLines, "i1")).toHaveLength(1));

			lineHandler(JSON.stringify({ id: "r1", type: "run.start", message: "Hello" }));
			let runId: string;
			await vi.waitFor(() => {
				const res = responsesFor(rpcIo.outputLines, "r1");
				expect(res).toHaveLength(1);
				runId = (res[0].data as { runId: string }).runId;
			});
			await vi.waitFor(() => expect(terminalEvents(currentLines())).toHaveLength(1));

			// cancel after completion is idempotent and never adds a second terminal
			lineHandler(JSON.stringify({ id: "c1", type: "run.cancel", runId: runId! }));
			await vi.waitFor(() => expect(responsesFor(rpcIo.outputLines, "c1")).toHaveLength(1));
			const c1 = responsesFor(rpcIo.outputLines, "c1")[0];
			expect(c1.success).toBe(true);
			expect((c1.data as { status: string }).status).toBe("completed");
			expect(terminalEvents(currentLines())).toHaveLength(1);
		} finally {
			await cleanup();
		}
	});
});
