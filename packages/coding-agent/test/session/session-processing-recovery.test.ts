import { existsSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, Session, type AgentMessage } from "@aos-agent/agent-core";
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	getModel,
} from "@aos-agent/ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../../src/core/policy/auth-storage.ts";
import { getAgentCanonicalSession } from "../../src/core/session/facade.ts";
import { AgentSession } from "../../src/core/session/agent-session.ts";
import { SessionManager } from "../../src/core/session/manager.ts";
import { createSessionManagerStorage } from "../../src/core/session/manager-storage.ts";
import {
	acquireSessionProcessingLease,
	sessionProcessingLeasePath,
} from "../../src/core/session/processing-lease.ts";
import { SettingsManager } from "../../src/core/runtime/settings-manager.ts";
import { createModelRegistry, getModelRuntime } from "../runtime/model-runtime-test-utils.ts";
import { createTestResourceLoader } from "../utilities.ts";

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

function assistantMessage(text: string, stopReason: "stop" | "aborted" = "stop"): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	};
}

function completingStream(): MockAssistantStream {
	const stream = new MockAssistantStream();
	queueMicrotask(() => {
		stream.push({ type: "start", partial: assistantMessage("") });
		stream.push({ type: "done", reason: "stop", message: assistantMessage("completed") });
	});
	return stream;
}

function abortableStream(signal: AbortSignal | undefined): MockAssistantStream {
	if (signal === undefined) throw new Error("Fixture stream requires an abort signal");
	const stream = new MockAssistantStream();
	let settled = false;
	const abort = (): void => {
		if (settled) return;
		settled = true;
		stream.push({ type: "error", reason: "aborted", error: assistantMessage("aborted", "aborted") });
	};
	queueMicrotask(() => {
		stream.push({ type: "start", partial: assistantMessage("") });
		if (signal.aborted) abort();
		else signal.addEventListener("abort", abort, { once: true });
	});
	return stream;
}

async function waitForStreaming(session: AgentSession, prompt: Promise<void>): Promise<void> {
	await Promise.race([
		expect.poll(() => session.isStreaming, { timeout: 5000 }).toBe(true),
		prompt.then(() => {
			throw new Error("Prompt completed before streaming started");
		}),
	]);
}

describe("session processing lease", () => {
	let root: string;
	let sessionFile: string;

	beforeEach(() => {
		root = join(tmpdir(), `aos-session-processing-lease-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(root, { recursive: true });
		sessionFile = join(root, "session.jsonl");
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
	});

	it("rejects a live holder and reclaims a missing holder", () => {
		const first = acquireSessionProcessingLease(sessionFile, { pid: 101, probeProcess: () => "live" });
		expect(() => acquireSessionProcessingLease(sessionFile, { pid: 202, probeProcess: () => "live" })).toThrow(
			"Agent is already processing",
		);
		const replacement = acquireSessionProcessingLease(sessionFile, {
			pid: 202,
			probeProcess: (pid) => pid === 101 ? "missing" : "live",
		});
		first.release();
		expect(existsSync(sessionProcessingLeasePath(sessionFile))).toBe(true);
		replacement.release();
		expect(existsSync(sessionProcessingLeasePath(sessionFile))).toBe(false);
	});

	it.each([
		["missing", undefined],
		["malformed", "not-json"],
		["oversized", "x".repeat(5000)],
	])("bounds and eventually reclaims a %s owner fixture", (_name, ownerText) => {
		const first = acquireSessionProcessingLease(sessionFile, { pid: 101, probeProcess: () => "live" });
		const ownerPath = join(sessionProcessingLeasePath(sessionFile), "owner.json");
		if (ownerText === undefined) unlinkSync(ownerPath);
		else writeFileSync(ownerPath, ownerText, "utf8");
		const replacement = acquireSessionProcessingLease(sessionFile, {
			pid: 202,
			probeProcess: () => "ambiguous",
			invalidOwnerStaleMs: 0,
			now: () => Date.now() + 1000,
		});
		first.release();
		replacement.release();
		expect(existsSync(sessionProcessingLeasePath(sessionFile))).toBe(false);
	});
});

describe("AgentSession stale processing recovery", () => {
	let root: string;
	let sessions: AgentSession[];

	beforeEach(() => {
		root = join(tmpdir(), `aos-session-processing-recovery-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(root, { recursive: true });
		sessions = [];
	});

	afterEach(async () => {
		for (const session of sessions) {
			await session.abort().catch(() => undefined);
			await session.dispose().catch(() => undefined);
		}
		rmSync(root, { recursive: true, force: true });
	});

	async function createSession(
		sessionManager: SessionManager,
		stream: (signal: AbortSignal | undefined) => MockAssistantStream,
	): Promise<AgentSession> {
		const model = getModel("anthropic", "claude-sonnet-4-5");
		if (model === undefined) throw new Error("Fixture model is unavailable");
		const authStorage = AuthStorage.create(join(root, `auth-${sessions.length}.json`));
		await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));
		const modelRegistry = await createModelRegistry(authStorage, root);
		const session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model, systemPrompt: "Test", tools: [] },
				streamFn: (_model, _context, options) => stream(options?.signal),
			}),
			sessionManager,
			settingsManager: SettingsManager.create(root, root),
			cwd: root,
			modelRuntime: getModelRuntime(modelRegistry),
			resourceLoader: createTestResourceLoader(),
		});
		sessions.push(session);
		return session;
	}

	it("finishes an unfinished turn with no live holder before accepting the next prompt", async () => {
		const manager = SessionManager.create(root, join(root, "sessions"), { id: "stale-processing" });
		const canonical = new Session(createSessionManagerStorage(manager));
		const unfinishedMessage: AgentMessage = { role: "user", content: "unfinished", timestamp: 1 };
		await canonical.appendRecord({
			type: "operation_started",
			id: "stale-run",
			lane: "main",
			sourceLeafId: null,
			intent: {
				kind: "run",
				originalPrompt: [unfinishedMessage],
				initialMessages: [{ type: "message", id: "stale-user", message: unfinishedMessage }],
			},
		});
		manager.flushPendingSession();
		const sessionFile = manager.getSessionFile();
		if (sessionFile === undefined) throw new Error("Expected a persisted fixture session");
		const session = await createSession(SessionManager.open(sessionFile), () => completingStream());

		await expect(session.prompt("after restart")).resolves.toBeUndefined();

		const records = await getAgentCanonicalSession(session).findRecords({ type: "operation_finished" });
		expect(records).toEqual(expect.arrayContaining([
			expect.objectContaining({ runId: "stale-run", outcome: "aborted" }),
		]));
		expect(session.messages.some((message) =>
			message.role === "user" && (
				typeof message.content === "string"
					? message.content === "after restart"
					: message.content.some((content) => content.type === "text" && content.text === "after restart")
			)
		)).toBe(true);
		expect(existsSync(sessionProcessingLeasePath(sessionFile))).toBe(false);
	});

	it("refuses a second live holder of the same persisted session", async () => {
		const manager = SessionManager.create(root, join(root, "sessions"), { id: "live-processing" });
		manager.flushPendingSession();
		const sessionFile = manager.getSessionFile();
		if (sessionFile === undefined) throw new Error("Expected a persisted fixture session");
		const first = await createSession(manager, abortableStream);
		const second = await createSession(SessionManager.open(sessionFile), () => completingStream());
		const firstPrompt = first.prompt("first holder");
		await waitForStreaming(first, firstPrompt);

		await expect(second.prompt("second holder")).rejects.toThrow("Agent is already processing");
		expect(existsSync(sessionProcessingLeasePath(sessionFile))).toBe(true);

		await first.abort();
		await firstPrompt.catch(() => undefined);
		expect(existsSync(sessionProcessingLeasePath(sessionFile))).toBe(false);
	});
});
