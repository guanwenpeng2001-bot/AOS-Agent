import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@aos-agent/agent-core";
import { type AssistantMessage, type AssistantMessageEvent, EventStream, type Model } from "@aos-agent/ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Type } from "typebox";
import { AgentSession } from "../src/core/agent-session.ts";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { CapabilityError, type CapabilityBinding } from "../src/core/capability-registry.ts";
import { createExtensionRuntime } from "../src/core/extensions/loader.ts";
import type { ToolDefinition } from "../src/core/extensions/index.ts";
import type { ModelRuntime } from "../src/core/model-runtime.ts";
import type { ResourceLoader } from "../src/core/resource-loader.ts";
import { SessionManager, type SessionEntry } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { runRpcMode } from "../src/modes/rpc/rpc-mode.ts";
import type { Skill } from "../src/core/skills.ts";
import { createSyntheticSourceInfo } from "../src/core/source-info.ts";

const rpcIo = vi.hoisted(() => ({
	outputLines: [] as string[],
	lineHandler: undefined as ((line: string) => void) | undefined,
}));

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
	attachJsonlLineReader: vi.fn((_stream: NodeJS.ReadableStream, onLine: (line: string) => void) => {
		rpcIo.lineHandler = onLine;
		return () => {};
	}),
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

/** Metadata-only redacted binding injected via getActiveCapabilityBinding spies. */
const BINDING: CapabilityBinding = {
	id: "binding:default:abc123",
	profile: "default",
	createdAt: "2026-08-11T00:00:00.000Z",
	descriptors: [{ id: "builtin_tool:core:read", revision: "rev:1", exposedToolName: "Read" }],
	decisionSummary: { allowed: 1, awaitingApproval: 0, denied: 0 },
	toolAllowlist: ["Read"],
};

/** A binding whose profile leaves an ask capability unapproved (headless must fail). */
const APPROVAL_BINDING: CapabilityBinding = {
	...BINDING,
	id: "binding:default:approval",
	decisionSummary: { allowed: 1, awaitingApproval: 1, denied: 0 },
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
	const tempDir = join(tmpdir(), `pi-rpc-automation-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
			const receipt = terminal.receipt as { status: string; finalText?: string };
			expect(receipt.status).toBe("completed");
			expect(receipt.finalText).toBe("done");
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
			const ledgerEntries = runtimeHost.session.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "custom" && entry.customType === "automation.run");
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
			expect(currentLines().some((record) => typeof record.type === "string" && record.type.startsWith("run."))).toBe(
			false,
		);
			expect(runEventsOfType(currentLines(), "message_start")).toHaveLength(0);
			expect(
			runtimeHost.session.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "custom" && entry.customType === "automation.run"),
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

			const sessionManager = runtimeHost.session.sessionManager;
			const appendCustomEntry = sessionManager.appendCustomEntry.bind(sessionManager);
			const appendSpy = vi.spyOn(sessionManager, "appendCustomEntry").mockImplementation((customType, data) => {
				if (
					customType === "automation.run" &&
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
			expect(currentLines().some((record) => typeof record.type === "string" && record.type.startsWith("run."))).toBe(
			false,
		);
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

			const sessionManager = runtimeHost.session.sessionManager;
			const appendCustomEntry = sessionManager.appendCustomEntry.bind(sessionManager);
			const appendSpy = vi.spyOn(sessionManager, "appendCustomEntry").mockImplementation((customType, data) => {
				if (
					customType === "automation.run" &&
					typeof data === "object" &&
					data !== null &&
					"kind" in data &&
					data.kind === "started"
				) {
					throw new Error("started ledger unavailable");
				}
				return appendCustomEntry(customType, data);
			});

			lineHandler(JSON.stringify({ id: "persist-started", type: "run.start", message: "Hello" }));
			await vi.waitFor(() => expect(responsesFor(rpcIo.outputLines, "persist-started")).toHaveLength(1));
			const rejection = responsesFor(rpcIo.outputLines, "persist-started")[0];
			expect(rejection.success).toBe(false);
			expect((rejection.error as { code: string }).code).toBe("ledger_persistence_failed");
			expect("data" in rejection).toBe(false);
			await sleep(20);
			expect(currentLines().some((record) => typeof record.type === "string" && record.type.startsWith("run."))).toBe(
			false,
		);
			expect(runEventsOfType(currentLines(), "message_start")).toHaveLength(0);

			appendSpy.mockRestore();
			lineHandler(JSON.stringify({ id: "retry", type: "run.start", message: "Hello" }));
			await vi.waitFor(() => expect(responsesFor(rpcIo.outputLines, "retry")[0]?.success).toBe(true));
			await vi.waitFor(() => expect(terminalEvents(currentLines())).toHaveLength(1));
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
			expect(receipt.terminalError?.code).toBe("model_error");
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
			const cancelResponseIndex = currentLines().findIndex((record) => record.id === "c1" && record.type === "response");

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
			runtimeHost.session.sessionManager.appendCustomEntry("automation.run", {
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
			const ledgerEntries = runtimeHost.session.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "custom" && entry.customType === "automation.run");
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
			expect(message).toContain("[redacted]");
			expect(JSON.stringify(res)).not.toMatch(/secret|abc123|user:pass/);
		} finally {
			await cleanup();
		}
	});

	it("records capabilityBindingId on the terminal receipt when a binding is frozen", async () => {
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
			expect((terminal.receipt as { capabilityBindingId?: string }).capabilityBindingId).toBe(BINDING.id);
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
				binding: { id: string; profile: string; descriptors: unknown[]; decisionSummary: unknown; toolAllowlist: string[] };
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
			expect(toolDescriptor!.source).toEqual({ source: "sdk", scope: "temporary", origin: "top-level" });

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
		const realTempPath = join(tmpdir(), `pi-rpc-skill-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
			expect(skillDescriptor!.source).toEqual({ source: "local", scope: "project", origin: "top-level" });
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
			// then read the real binding id from its terminal receipt.
			lineHandler(JSON.stringify({ id: "r0", type: "run.start", message: "Seed" }));
			await vi.waitFor(() => expect(responsesFor(rpcIo.outputLines, "r0")).toHaveLength(1));
			await vi.waitFor(() => expect(terminalEvents(currentLines())).toHaveLength(1));
			const sourceBindingId = (terminalEvents(currentLines())[0].receipt as { capabilityBindingId?: string })
				.capabilityBindingId;
			expect(sourceBindingId).toBeTruthy();

			const sessionFile = runtimeHost.session.sessionFile;
			expect(sessionFile).toBeTruthy();

			// An interrupted run: the accepted fact recorded the original binding
			// (its capability.binding ledger entry exists from the seed run's accept)
			// but the run never reached a terminal receipt.
			const interruptedRunId = "interrupted-with-binding";
			runtimeHost.session.sessionManager.appendCustomEntry("automation.run", {
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
			// ledger); valid RunRecord / RunReceipt shapes only
			const legacyRunId = "legacy-no-binding";
			const sessionId = runtimeHost.session.sessionId;
			runtimeHost.session.sessionManager.appendCustomEntry("automation.run", {
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
			runtimeHost.session.sessionManager.appendCustomEntry("automation.run", {
				schemaVersion: 1,
				kind: "started",
				runId: legacyRunId,
				startedAt: "2026-08-11T00:00:00.000Z",
			});
			runtimeHost.session.sessionManager.appendCustomEntry("automation.run", {
				schemaVersion: 1,
				kind: "terminal",
				endedAt: "2026-08-11T00:00:01.000Z",
				receipt: {
					runId: legacyRunId,
					sessionId,
					status: "completed",
					usage: { input: 0, output: 0, total: 0 },
				},
			});

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
			// the frozen (real) binding is recorded on the source run's receipt
			const sourceBindingId = (terminalEvents(currentLines())[0].receipt as { capabilityBindingId?: string })
				.capabilityBindingId;
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
			expect((terminalEvents(currentLines())[0].receipt as { capabilityBindingId?: string }).capabilityBindingId).toBe(
				BINDING.id,
			);

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
				runtimeHost.session.sessionManager
					.getEntries()
					.filter((entry) => entry.type === "custom" && entry.customType === "automation.run"),
			).toHaveLength(3); // accepted + started + terminal of the first run only
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
				runtimeHost.session.sessionManager
					.getEntries()
					.filter((entry) => entry.type === "custom" && entry.customType === "automation.run"),
			).toHaveLength(3); // accepted + started + terminal of the first run only
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
			expect((res.error as { message: string }).message).toContain("MCP discovery failed");
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
			// a source run whose receipt demands a binding that was never recorded
			runtimeHost.session.sessionManager.appendCustomEntry("automation.run", {
				schemaVersion: 1,
				kind: "accepted",
				record: {
					id: "ghost-cap",
					sessionId: runtimeHost.session.sessionId,
					attempt: 1,
					status: "accepted",
					model: { provider: "anthropic", id: "claude-sonnet-4-5", thinkingLevel: "off" },
				},
			});
			runtimeHost.session.sessionManager.appendCustomEntry("automation.run", {
				schemaVersion: 1,
				kind: "terminal",
				endedAt: "2026-08-11T00:00:00.000Z",
				receipt: {
					runId: "ghost-cap",
					sessionId: runtimeHost.session.sessionId,
					status: "completed",
					usage: { input: 0, output: 0, total: 0 },
					capabilityBindingId: "binding:ghost:nope",
				},
			});

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

			lineHandler(
				JSON.stringify({ id: "u1", type: "run.start", message: "Hello", capabilityProfile: "strict" }),
			);
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
			// the terminal receipt records the materialized strict binding
			expect((terminal.receipt as { capabilityBindingId?: string }).capabilityBindingId).toBe(
				runtimeHost.session.getActiveCapabilityBinding()?.id,
			);
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

			lineHandler(
				JSON.stringify({ id: "u1", type: "run.start", message: "Hello", capabilityProfile: "strict" }),
			);
			await vi.waitFor(() => expect(responsesFor(rpcIo.outputLines, "u1")).toHaveLength(1));
			const res = responsesFor(rpcIo.outputLines, "u1")[0];
			expect(res.success).toBe(false);
			expect((res.error as { code: string }).code).toBe("capability_mcp_connect_failed");
			expect("data" in res).toBe(false);
			expect(
				currentLines().some((record) => typeof record.type === "string" && record.type.startsWith("run.")),
			).toBe(false);
			expect(
				runtimeHost.session.sessionManager
					.getEntries()
					.filter((entry) => entry.type === "custom" && entry.customType === "automation.run"),
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
			expect(setProfileSpy).toHaveBeenCalledWith(undefined);
			expect(runtimeHost.session.getActiveCapabilityProfile()).toBe("default");
			expect(runtimeHost.session.getActiveCapabilityBinding()?.profile).toBe("default");
			await vi.waitFor(() => expect(terminalEvents(currentLines())).toHaveLength(2));
		} finally {
			await cleanup();
		}
	});

	it("redacts a model-error terminal on the wire and in the ledger", async () => {
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
			expect(wireMessage).toContain("[redacted]");
			expect(JSON.stringify(terminal)).not.toMatch(/secret|abc123/);

			// the persisted terminal ledger entry is redacted too
			const ledger = runtimeHost.session.sessionManager
				.getEntries()
				.filter((entry) => entry.type === "custom" && entry.customType === "automation.run");
			const terminalEntry = ledger.find(
				(entry): entry is Extract<SessionEntry, { type: "custom" }> =>
					entry.type === "custom" &&
					entry.customType === "automation.run" &&
					(entry.data as { kind?: string }).kind === "terminal",
			);
			const persistedError = (terminalEntry?.data as { receipt?: { terminalError?: { message: string } } }).receipt
				?.terminalError;
			expect(persistedError?.message).toBeDefined();
			expect(persistedError?.message).not.toContain("secret");
			expect(persistedError?.message).not.toContain("abc123");
			expect(JSON.stringify(terminalEntry?.data)).not.toMatch(/secret|abc123/);
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
