import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	Agent,
	AgentHarness,
	InMemorySessionStorage,
	Session,
	type AgentEvent,
	type AgentMessage,
	type AgentTool,
	type HarnessTool,
	type StreamFn,
} from "../../../agent/src/internal.ts";
import {
	createAssistantMessageEventStream,
	createModels,
	type AssistantMessage,
	type AssistantMessageEventStream,
	type Context,
	type Models,
} from "@aos-agent/ai";
import { getModel } from "@aos-agent/ai/compat";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { AgentSession } from "../../src/core/session/agent-session.ts";
import { createExtensionRuntime } from "../../src/core/extensions/loader.ts";
import type { ModelRuntime } from "../../src/core/runtime/model-runtime.ts";
import type { ResourceLoader } from "../../src/core/runtime/resource-loader.ts";
import { SessionManager } from "../../src/core/session/manager.ts";
import { SettingsManager } from "../../src/core/runtime/settings-manager.ts";

const BASE_MODELS = createModels();
const MODEL = getModel("openai", "gpt-4o-mini");

interface TranscriptEntry {
	type: string;
	role?: string;
	content?: unknown;
}

interface LegacySessionOptions {
	streamFunction: StreamFn;
	tools?: AgentTool[];
	initialActiveToolNames?: string[];
}

function modelsFor(model: NonNullable<typeof MODEL>): Models {
	const models = Object.create(BASE_MODELS) as Models;
	const originalGetModel = BASE_MODELS.getModel.bind(BASE_MODELS);
	models.getModel = (provider, id) =>
		provider === model.provider && id === model.id ? model : originalGetModel(provider, id);
	return models;
}

function modelRuntimeFor(model: NonNullable<typeof MODEL>): ModelRuntime {
	return Object.assign(modelsFor(model), {
		getAvailableSnapshot: () => [model],
		hasConfiguredAuth: () => true,
		checkAuth: async () => undefined,
		getAuth: async () => undefined,
		isUsingOAuth: () => false,
	}) as unknown as ModelRuntime;
}

function usage(totalTokens = 1): AssistantMessage["usage"] {
	return {
		input: totalTokens,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function assistant(
	model: AssistantMessage["model"],
	text: string,
	stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model,
		usage: usage(),
		stopReason,
		timestamp: Date.now(),
	};
}

function streamFor(
	messageFactory: (model: AssistantMessage["model"], call: number, context: Context) => AssistantMessage,
): StreamFn {
	let calls = 0;
	return (model, context) => {
		const stream = createAssistantMessageEventStream();
		const message = messageFactory(model.id, calls, context);
		calls += 1;
		queueMicrotask(() => {
			stream.push({ type: "start", partial: message });
			stream.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message });
		});
		return stream;
	};
}

function createParityResourceLoader(): ResourceLoader {
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

async function createLegacySession(
	options: LegacySessionOptions,
): Promise<{ session: AgentSession; cleanup: () => Promise<void> }> {
	if (MODEL === undefined) throw new Error("Test model is unavailable");
	const cwd = mkdtempSync(join(tmpdir(), "aos-agent-session-parity-"));
	const sessionManager = SessionManager.create(cwd);
	const settingsManager = SettingsManager.create(cwd, cwd);
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model: MODEL, systemPrompt: "Test", tools: options.tools ?? [] },
		streamFn: options.streamFunction,
	});
	const session = new AgentSession({
		agent,
		sessionManager,
		settingsManager,
		cwd,
		modelRuntime: modelRuntimeFor(MODEL),
		resourceLoader: createParityResourceLoader(),
		baseToolsOverride:
			options.tools === undefined
				? undefined
				: Object.fromEntries(options.tools.map((tool) => [tool.name, tool])),
		initialActiveToolNames: options.initialActiveToolNames,
	});
	return {
		session,
		cleanup: async () => {
			try {
				await session.dispose();
			} finally {
				rmSync(cwd, { recursive: true, force: true });
			}
		},
	};
}

async function createHarness(options: {
	streamFunction: StreamFn;
	tools?: HarnessTool[];
	activeToolNames?: string[];
	storage?: InMemorySessionStorage;
}): Promise<{ harness: AgentHarness; session: Session }> {
	if (MODEL === undefined) throw new Error("Test model is unavailable");
	const storage =
		options.storage ??
		new InMemorySessionStorage({ id: `parity-${Date.now()}-${Math.random()}`, createdAt: Date.now() });
	const session = new Session(storage);
	const models = modelsFor(MODEL);
	models.streamSimple = (model, context, streamOptions): AssistantMessageEventStream => {
		const stream = options.streamFunction(model, context, streamOptions);
		if (stream instanceof Promise) throw new Error("Parity streams must start synchronously");
		return stream;
	};
	const created = await AgentHarness.create({
		session,
		models,
		model: MODEL,
		drive: "automatic",
		tools: options.tools,
		activeToolNames: options.activeToolNames,
	});
	return { harness: created.harness, session };
}

function transcriptMessage(message: AgentMessage): TranscriptEntry {
	return {
		type: "message",
		role: message.role,
		...("content" in message ? { content: message.content } : {}),
	};
}

function legacyTranscript(session: AgentSession): TranscriptEntry[] {
	return session.messages.map((message) => transcriptMessage(message));
}

async function harnessTranscript(harness: AgentHarness): Promise<TranscriptEntry[]> {
	return (await harness.getMessages()).map((message) => transcriptMessage(message));
}

async function waitFor(predicate: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 200; attempt += 1) {
		if (predicate()) return;
		await new Promise<void>((resolve) => setTimeout(resolve, 1));
	}
	throw new Error("Timed out waiting for parity state");
}

async function harnessPendingMessageCount(harness: AgentHarness): Promise<number> {
	const watch = await harness.watch();
	try {
		return watch.snapshot.queues.steer.length + watch.snapshot.queues.followUp.length + watch.snapshot.queues.nextRun.length;
	} finally {
		watch.unsubscribe();
	}
}

async function expectTranscriptParity(
	options: Omit<LegacySessionOptions, "streamFunction"> & { createStreamFunction: () => StreamFn },
	performLegacy: (session: AgentSession) => Promise<void>,
	performHarness: (harness: AgentHarness) => Promise<void>,
): Promise<void> {
	const legacy = await createLegacySession({
		...options,
		streamFunction: options.createStreamFunction(),
		tools: options.tools?.map((tool) => ({ ...tool })),
	});
	const canonical = await createHarness({
		streamFunction: options.createStreamFunction(),
		tools: options.tools?.map((tool) => ({ ...tool })) as HarnessTool[] | undefined,
		activeToolNames: options.initialActiveToolNames,
	});
	try {
		await performLegacy(legacy.session);
		await performHarness(canonical.harness);
		expect(legacyTranscript(legacy.session)).toEqual(await harnessTranscript(canonical.harness));
	} finally {
		await legacy.cleanup();
		await canonical.harness.close();
	}
}

describe("AgentSession / public AgentHarness parity baseline", () => {
	it("matches prompt streaming transcript and terminal semantics", async () => {
		const legacyEvents: Array<AgentEvent["type"] | "agent_settled"> = [];
		const terminals: string[] = [];
		const legacy = await createLegacySession({
			streamFunction: streamFor((model) => assistant(model, "parity-prompt")),
		});
		const canonical = await createHarness({
			streamFunction: streamFor((model) => assistant(model, "parity-prompt")),
		});
		const unsubscribeLegacy = legacy.session.subscribe((event) => {
			if (
				event.type === "agent_start" ||
				event.type === "message_update" ||
				event.type === "agent_end" ||
				event.type === "agent_settled"
			) {
				legacyEvents.push(event.type);
			}
		});
		const unsubscribeCanonical = canonical.harness.events.on("run_end", (event) => {
			terminals.push(event.outcome);
		});
		try {
			await legacy.session.prompt("prompt parity");
			await legacy.session.waitForIdle();
			const result = await canonical.harness.prompt("prompt parity");
			expect(result.ok).toBe(true);
			await canonical.harness.waitForIdle();
			expect(legacyTranscript(legacy.session)).toEqual(await harnessTranscript(canonical.harness));
			expect(legacyEvents).toEqual(expect.arrayContaining(["agent_start", "agent_end", "agent_settled"]));
			expect(terminals).toEqual(["completed"]);
		} finally {
			unsubscribeLegacy();
			unsubscribeCanonical();
			await legacy.cleanup();
			await canonical.harness.close();
		}
	});

	it("matches the tool loop transcript", async () => {
		const observedToolResults: string[] = [];
		const tool: AgentTool = {
			name: "inspect",
			label: "inspect",
			description: "Inspect a value",
			parameters: Type.Object({ value: Type.String() }),
			execute: async () => ({ content: [{ type: "text", text: "tool-parity" }], details: undefined }),
		};
		const createStream = (): StreamFn =>
			streamFor((model, call, context) => {
				if (call % 2 === 0) {
					return {
							...assistant(model, "", "toolUse"),
							content: [{ type: "toolCall", id: "call-parity", name: "inspect", arguments: { value: "x" } }],
						};
				}
				const toolResult = context.messages.find((message) => message.role === "toolResult");
				const text = toolResult?.content.find((content) => content.type === "text")?.text ?? "missing";
				observedToolResults.push(text);
				return assistant(model, `parity-tool:${text}`);
			});
		await expectTranscriptParity(
			{ createStreamFunction: createStream, tools: [tool], initialActiveToolNames: ["inspect"] },
			async (session) => {
				await session.prompt("tool parity");
				await session.waitForIdle();
			},
			async (harness) => {
				await harness.setTools([tool as HarnessTool], ["inspect"]);
				expect((await harness.getTools()).map((candidate) => candidate.name)).toEqual(["inspect"]);
				expect(await harness.getActiveTools()).toEqual(["inspect"]);
				await harness.prompt("tool parity");
				await harness.waitForIdle();
			},
		);
		expect(observedToolResults).toEqual(["tool-parity", "tool-parity"]);
	});

	it("matches steer and follow-up queue ordering", async () => {
		const createBlockingTool = (): { tool: AgentTool; release: () => void; started: () => boolean } => {
			let release: (() => void) | undefined;
			const blocked = new Promise<void>((resolve) => {
				release = resolve;
			});
			let hasStarted = false;
			return {
				tool: {
					name: "wait",
					label: "wait",
					description: "Wait until released",
					parameters: Type.Object({}),
					execute: async () => {
						hasStarted = true;
						await blocked;
						return { content: [{ type: "text", text: "wait released" }], details: undefined };
					},
				},
				release: () => release?.(),
				started: () => hasStarted,
			};
		};
		const createStream = (): StreamFn =>
			streamFor((model, call) =>
				call === 0
					? {
							...assistant(model, "", "toolUse"),
							content: [{ type: "toolCall", id: "call-wait", name: "wait", arguments: {} }],
						}
					: assistant(model, call === 1 ? "steered" : "followed"),
			);
		const legacyTool = createBlockingTool();
		const legacy = await createLegacySession({
			streamFunction: createStream(),
			tools: [legacyTool.tool],
			initialActiveToolNames: ["wait"],
		});
		const tool = createBlockingTool();
		const canonical = await createHarness({
			streamFunction: createStream(),
			tools: [tool.tool as HarnessTool],
			activeToolNames: ["wait"],
		});
		try {
			const legacyPrompt = legacy.session.prompt("queue parity");
			await waitFor(legacyTool.started);
			await legacy.session.steer("queue steering");
			await legacy.session.followUp("queue follow-up");
			expect(legacy.session.pendingMessageCount).toBe(2);
			legacyTool.release();
			await legacyPrompt;
			await legacy.session.waitForIdle();

			const prompt = canonical.harness.prompt("queue parity");
			await waitFor(tool.started);
			await canonical.harness.steer("queue steering");
			await canonical.harness.followUp("queue follow-up");
			expect(await harnessPendingMessageCount(canonical.harness)).toBe(2);
			tool.release();
			await prompt;
			await canonical.harness.waitForIdle();

			expect(legacyTranscript(legacy.session)).toEqual(await harnessTranscript(canonical.harness));
			expect(await harnessPendingMessageCount(canonical.harness)).toBe(0);
		} finally {
			legacyTool.release();
			tool.release();
			await legacy.cleanup();
			await canonical.harness.close();
		}
	});

	it("matches aborted transcript and canonical terminal outcome", async () => {
		const createAbortStream = (): { streamFunction: StreamFn; signal: () => AbortSignal | undefined } => {
			let currentSignal: AbortSignal | undefined;
			return {
				streamFunction: (model, _context, options) => {
					currentSignal = options?.signal;
					const stream = createAssistantMessageEventStream();
					const message = assistant(model.id, "", "aborted");
					queueMicrotask(() => stream.push({ type: "start", partial: message }));
					return stream;
				},
				signal: () => currentSignal,
			};
		};
		const legacyStream = createAbortStream();
		const legacy = await createLegacySession({ streamFunction: legacyStream.streamFunction });
		const stream = createAbortStream();
		const canonical = await createHarness({ streamFunction: stream.streamFunction });
		const outcomes: string[] = [];
		const unsubscribe = canonical.harness.events.on("run_end", (event) => {
			outcomes.push(event.outcome);
		});
		try {
			const legacyPrompt = legacy.session.prompt("cancel parity");
			await waitFor(() => legacyStream.signal() !== undefined);
			await legacy.session.abort();
			await legacyPrompt;

			const prompt = canonical.harness.prompt("cancel parity");
			await waitFor(() => stream.signal() !== undefined);
			await canonical.harness.abort();
			await prompt;

			expect(legacyTranscript(legacy.session)).toEqual(await harnessTranscript(canonical.harness));
			expect(outcomes).toEqual(["aborted"]);
		} finally {
			unsubscribe();
			await legacy.cleanup();
			await canonical.harness.close();
		}
	});

	it("matches manual compaction transcript", async () => {
		if (MODEL === undefined) throw new Error("Test model is unavailable");
		const legacy = await createLegacySession({
			streamFunction: streamFor((model) => assistant(model, "short summary")),
		});
		const canonical = await createHarness({
			streamFunction: streamFor((model) => assistant(model, "short summary")),
		});
		const now = Date.now();
		const user: AgentMessage = {
			role: "user",
			content: [{ type: "text", text: "message to compact" }],
			timestamp: now - 1000,
		};
		const response: AgentMessage = {
			...assistant(MODEL.id, "assistant response to compact"),
			usage: usage(100),
			timestamp: now - 500,
		};
		try {
			legacy.session.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1 } });
			legacy.session.agent.state.messages = [structuredClone(user), structuredClone(response)];
			await canonical.session.appendMessage(structuredClone(user));
			await canonical.session.appendMessage(structuredClone(response));
			await canonical.harness.setCompactionSettings({ enabled: true, reserveTokens: 10, keepRecentTokens: 1 });
			await legacy.session.compact("short");
			await canonical.harness.compact({ customInstructions: "short" });
			expect(legacyTranscript(legacy.session)).toEqual(await harnessTranscript(canonical.harness));
		} finally {
			await legacy.cleanup();
			await canonical.harness.close();
		}
	});

	it("restores a persisted canonical transcript before the next prompt", async () => {
		const storage = new InMemorySessionStorage({ id: "resume-parity", createdAt: 1 });
		const first = await createHarness({
			storage,
			streamFunction: streamFor((model) => assistant(model, "first reply")),
		});
		await first.harness.prompt("first question");
		await first.harness.close();

		const resumed = await createHarness({
			storage,
			streamFunction: streamFor((model) => assistant(model, "reply after resume")),
		});
		try {
			await resumed.harness.prompt("second question");
			await resumed.harness.waitForIdle();
			expect(await harnessTranscript(resumed.harness)).toEqual([
				{ type: "message", role: "user", content: [{ type: "text", text: "first question" }] },
				{
					type: "message",
					role: "assistant",
					content: [{ type: "text", text: "first reply" }],
				},
				{ type: "message", role: "user", content: [{ type: "text", text: "second question" }] },
				{
					type: "message",
					role: "assistant",
					content: [{ type: "text", text: "reply after resume" }],
				},
			]);
		} finally {
			await resumed.harness.close();
		}
	});
});
