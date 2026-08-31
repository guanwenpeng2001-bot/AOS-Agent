import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@aos-agent/agent-core";
import { type AssistantMessage, type AssistantMessageEvent, EventStream, type Model } from "@aos-agent/ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../../src/core/session/agent-session.ts";
import { getAgentCanonicalSession, getAgentSessionLedger } from "../../src/core/session/facade.ts";
import type { AgentSessionRuntime } from "../../src/core/session/runtime.ts";
import { createExtensionRuntime } from "../../src/core/extensions/loader.ts";
import { ExecutionAuditQuery } from "../../src/core/session/execution-audit-query.ts";
import type { ModelRuntime } from "../../src/core/runtime/model-runtime.ts";
import type { ResourceLoader } from "../../src/core/runtime/resource-loader.ts";
import { SessionManager } from "../../src/core/session/manager.ts";
import { SettingsManager } from "../../src/core/runtime/settings-manager.ts";
import {
	RpcHostController,
	type RpcHostOutputRecord,
	type RpcOutputSink,
	type RpcWireRecord,
} from "../../src/modes/rpc/rpc-host.ts";

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

function createTestResourceLoader(): ResourceLoader {
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
	const tempDir = join(tmpdir(), `aos-rpc-host-attach-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(tempDir, { recursive: true });

	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model: TEST_MODEL, systemPrompt: "Test", tools: [] },
		streamFn: () => {
			const stream = new MockAssistantStream();
			queueMicrotask(() => {
				stream.push({ type: "start", partial: createAssistantMessage("") });
				setTimeout(() => {
					stream.push({ type: "done", reason: "stop", message: createAssistantMessage("done") });
				}, 5000);
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
	const session = new AgentSession({
		agent,
		sessionManager: SessionManager.create(tempDir),
		settingsManager,
		cwd: tempDir,
		modelRuntime,
		resourceLoader: createTestResourceLoader(),
	});

	const runtimeHost = {
		session,
		newSession: vi.fn(async () => ({ cancelled: true })),
		switchSession: vi.fn(async () => ({ cancelled: true })),
		fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
		dispose: vi.fn(async () => {}),
		setPrepareSessionRebind: vi.fn(),
	} as unknown as AgentSessionRuntime;

	return {
		runtimeHost,
		cleanup: async () => {
			try {
				if (session.isStreaming) await session.abort();
			} catch {
				// The controller owns the normal detach settlement path.
			}
			session.dispose();
			if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
		},
	};
}

function createSink(): RpcOutputSink & { records: RpcWireRecord[] } {
	const records: RpcWireRecord[] = [];
	return {
		records,
		send: async (record) => {
			records.push(record);
		},
		close: async () => {},
	};
}

function hasRecord(records: RpcHostOutputRecord[], type: string): boolean {
	return records.some((record) => record.type === type);
}

describe("RpcHostController dispatch and attach", () => {
	afterEach(() => vi.restoreAllMocks());

	it("returns dispatch responses and settles a detached run without replaying it", async () => {
		const { runtimeHost, cleanup } = await createRuntimeHost();
		const controller = new RpcHostController(runtimeHost);
		await controller.start();
		const first = createSink();
		const detachFirst = controller.attach(first);
		const abort = vi.spyOn(runtimeHost.session, "abort");

		try {
			const initializeResponse = await controller.dispatch({
				id: "initialize",
				type: "initialize",
				protocolVersion: 1,
			});
			expect(initializeResponse).toMatchObject({
				id: "initialize",
				command: "initialize",
				success: true,
			});

			await controller.dispatch({ id: "start", type: "run.start", message: "long-running" });
			await vi.waitFor(() => expect(hasRecord(first.records, "run.started")).toBe(true));
			const started = first.records.find((record) => record.type === "run.started");
			if (started?.type !== "run.started") throw new Error("run.started was not published");
			const runId = started.runId;

			detachFirst();
			await vi.waitFor(async () => {
				expect(abort).toHaveBeenCalled();
				const runReceiptFact = (
					await getAgentCanonicalSession(runtimeHost.session).findFoundationRecords({
						kind: "fact",
						objectType: "run_receipt",
						order: "oldestFirst",
					})
				).at(-1);
				expect(runReceiptFact).toMatchObject({
					objectType: "run_receipt",
					payload: { runId, terminalStatus: "cancelled" },
				});
				const replay = new ExecutionAuditQuery(getAgentSessionLedger(runtimeHost.session)).replay(runId);
				expect(replay).toMatchObject({
					run: { status: "cancelled" },
					events: expect.arrayContaining([expect.objectContaining({ type: "run.cancelled" })]),
				});
			});

			const second = createSink();
			const detachSecond = controller.attach(second);
			expect(second.records).toEqual([]);
			await controller.dispatch({ id: "get", type: "run.get", runId: "missing" });
			expect(second.records).toHaveLength(1);
			expect(second.records[0]).toMatchObject({ id: "get", command: "run.get" });
			detachSecond();
			await controller.detachTransport();
		} finally {
			await controller.shutdown();
			await cleanup();
		}
	});
});
