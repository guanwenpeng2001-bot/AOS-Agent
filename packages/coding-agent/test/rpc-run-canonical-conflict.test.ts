import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, FoundationError, LayeredResultSettlement } from "@aos-agent/agent-core";
import { type AssistantMessage, type AssistantMessageEvent, EventStream, type Model } from "@aos-agent/ai";
import { describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { createExtensionRuntime } from "../src/core/extensions/loader.ts";
import type { ModelRuntime } from "../src/core/model-runtime.ts";
import type { ResourceLoader } from "../src/core/resource-loader.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { RpcHostController, type RpcHostOutputRecord } from "../src/modes/rpc/rpc-host.ts";

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
		throw new Error("streamSimple is not exercised by the focused RPC harness");
	},
}));

vi.mock("@aos-agent/ai/providers/all", () => ({}));

class ControlledAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected assistant event");
			},
		);
	}
}

function assistantMessage(text: string): AssistantMessage {
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

const MODEL: Model<"anthropic-messages"> = {
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

function resourceLoader(): ResourceLoader {
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

interface RpcConflictHarness {
	readonly controller: RpcHostController;
	readonly runtimeHost: AgentSessionRuntime;
	readonly records: RpcHostOutputRecord[];
	readonly completePrompt: () => void;
	readonly tempDir: string;
	readonly cleanup: () => Promise<void>;
}

async function createHarness(): Promise<RpcConflictHarness> {
	const tempDir = mkdtempSync(join(tmpdir(), "aos-t2c-rpc-"));
	let stream: ControlledAssistantStream | undefined;
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model: MODEL, systemPrompt: "Test", tools: [] },
		streamFn: () => {
			stream = new ControlledAssistantStream();
			queueMicrotask(() => stream?.push({ type: "start", partial: assistantMessage("") }));
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
	const openSession = (manager: SessionManager): AgentSession =>
		new AgentSession({
			agent,
			sessionManager: manager,
			settingsManager,
			cwd: tempDir,
			modelRuntime,
			resourceLoader: resourceLoader(),
		});
	let currentSession = openSession(SessionManager.create(tempDir, tempDir));
	let rebind: (() => Promise<void>) | undefined;
	const runtimeHost = {
		get session(): AgentSession {
			return currentSession;
		},
		set session(next: AgentSession) {
			currentSession = next;
		},
		setRebindSession: vi.fn((callback?: () => Promise<void>) => {
			rebind = callback;
		}),
		switchSession: vi.fn(async (sessionPath: string) => {
			currentSession = openSession(SessionManager.open(sessionPath));
			await rebind?.();
			return { cancelled: false };
		}),
		newSession: vi.fn(async () => ({ cancelled: true })),
		fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
		dispose: vi.fn(async () => {}),
	} as unknown as AgentSessionRuntime;
	const records: RpcHostOutputRecord[] = [];
	const controller = new RpcHostController(runtimeHost, { output: { publish: (record) => records.push(record) } });
	await controller.start();
	await controller.dispatch({ id: "initialize", type: "initialize", protocolVersion: 1 });
	return {
		controller,
		runtimeHost,
		records,
		completePrompt: () => {
			if (stream === undefined) throw new Error("The controlled prompt has not started");
			stream.push({ type: "done", reason: "stop", message: assistantMessage("done") });
		},
		tempDir,
		cleanup: async () => {
			try {
				if (currentSession.isStreaming) await currentSession.abort();
			} catch {
				// Test cleanup must remain best-effort after a deliberately corrupt ledger.
			}
			await currentSession.dispose();
			if (existsSync(tempDir)) rmSync(tempDir, { recursive: true, force: true });
		},
	};
}

function response(records: readonly RpcHostOutputRecord[], id: string): RpcHostOutputRecord | undefined {
	return records.find((record) => record.type === "response" && record.id === id);
}

describe("RPC canonical conflict boundaries", () => {
	it("reads a production-written Foundation receipt through the exact lifecycle fold", async () => {
		const harness = await createHarness();
		try {
			const started = harness.controller.dispatch({ id: "canonical", type: "run.start", message: "Canonical" });
			await vi.waitFor(() => expect(response(harness.records, "canonical")).toMatchObject({ success: true }));
			const accepted = response(harness.records, "canonical");
			const runId = (accepted as { readonly data: { readonly runId: string } }).data.runId;
			harness.completePrompt();
			await started;
			await vi.waitFor(() =>
				expect(harness.records.some((record) => record.type === "run.completed" && record.runId === runId)).toBe(
					true,
				),
			);

			const result = await harness.controller.dispatch({ id: "get", type: "run.get", runId });
			expect(result).toMatchObject({ success: true, data: { receipt: { runId, status: "completed" } } });
		} finally {
			await harness.cleanup();
		}
	});

	it.each(["read", "projection"] as const)(
		"keeps the active lock when canonical completion %s fails",
		async (boundary) => {
			const harness = await createHarness();
			let lookup: ReturnType<typeof vi.spyOn> | undefined;
			try {
				const firstDispatch = harness.controller.dispatch({
					id: `first-${boundary}`,
					type: "run.start",
					message: "First",
				});
				await vi.waitFor(() =>
					expect(response(harness.records, `first-${boundary}`)).toMatchObject({ success: true }),
				);
				if (boundary === "read") {
					lookup = vi.spyOn(LayeredResultSettlement.prototype, "lookupCanonicalRun").mockResolvedValue({
						ok: false,
						error: new FoundationError(
							"run_terminal_authority_invalid",
							"Conflicting canonical RunReceipt facts",
						),
					});
				} else {
					const original = LayeredResultSettlement.prototype.lookupCanonicalRun;
					lookup = vi
						.spyOn(LayeredResultSettlement.prototype, "lookupCanonicalRun")
						.mockImplementation(async function (this: LayeredResultSettlement, runId) {
							const result = await original.call(this, runId);
							if (!result.ok || result.value === undefined) return result;
							return {
								ok: true,
								value: {
									...result.value,
									// The canonical read succeeds, then projection rejects this invalid durable sequence.
									writtenEvent: { ...result.value.writtenEvent, sequence: -1 },
								},
							};
						});
				}
				harness.completePrompt();
				await vi.waitFor(() => expect(harness.runtimeHost.session.isStreaming).toBe(false));
				await vi.waitFor(() => expect(lookup).toHaveBeenCalled());
				await firstDispatch;

				const blocked = await harness.controller.dispatch({
					id: `second-${boundary}`,
					type: "run.start",
					message: "Second",
				});
				expect(blocked).toMatchObject({ success: false, error: { code: "session_busy" } });
				expect(response(harness.records, `second-${boundary}`)).toMatchObject({
					success: false,
					error: { code: "session_busy" },
				});
				expect(harness.records.some((record) => record.type === "run.completed")).toBe(false);
			} finally {
				lookup?.mockRestore();
				await harness.cleanup();
			}
		},
	);

	it("maps a read-only resume fold conflict to source_run_not_resumable", async () => {
		const harness = await createHarness();
		try {
			const target = SessionManager.create(harness.tempDir, harness.tempDir);
			const runId = "legacy-conflict";
			target.appendCustomEntry("automation.run", {
				schemaVersion: 1,
				kind: "accepted",
				record: {
					id: runId,
					sessionId: target.getSessionId(),
					attempt: 1,
					status: "accepted",
					model: { provider: "anthropic", id: MODEL.id, thinkingLevel: "off" },
				},
			});
			target.appendCustomEntry("automation.run", {
				schemaVersion: 1,
				kind: "terminal",
				endedAt: "2026-08-26T00:00:01.000Z",
				receipt: {
					runId,
					sessionId: target.getSessionId(),
					status: "completed",
					usage: { input: 0, output: 0, total: 0 },
				},
			});
			target.flushPendingSession();
			const sessionPath = target.getSessionFile();
			expect(sessionPath).toBeDefined();

			const result = await harness.controller.dispatch({
				id: "resume",
				type: "run.resume",
				sessionPath: sessionPath!,
				sourceRunId: runId,
				message: "Continue",
				clientRequestId: "resume-conflict-request",
			});
			expect(result).toMatchObject({ success: false, error: { code: "source_run_not_resumable" } });
			expect(harness.runtimeHost.switchSession).not.toHaveBeenCalled();
		} finally {
			await harness.cleanup();
		}
	});
});
