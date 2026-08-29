import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, fingerprintFoundationValue, FoundationError, Result } from "@aos-agent/agent-core";
import type { Model } from "@aos-agent/ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSession } from "../src/core/agent-session.ts";
import type { AgentSessionRuntime } from "../src/core/agent-session-runtime.ts";
import { createExtensionRuntime } from "../src/core/extensions/loader.ts";
import type { ModelRuntime } from "../src/core/model-runtime.ts";
import type { ResourceLoader } from "../src/core/resource-loader.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import type { SafeSubagentLifecycleProjection } from "../src/core/subagent-composition.ts";
import { RpcHostController, type RpcSubagentRegistry } from "../src/modes/rpc/rpc-host.ts";

vi.mock("@aos-agent/ai/compat", () => ({
	clampThinkingLevel: (level: unknown) => level,
	cleanupSessionResources: () => {},
	getSupportedThinkingLevels: () => ["off"],
	isContextOverflow: () => false,
	isRecoverableLength: () => false,
	isRetryableAssistantError: () => false,
	modelsAreEqual: () => false,
	resetApiProviders: () => {},
	streamSimple: async () => { throw new Error("not used"); },
}));
vi.mock("@aos-agent/ai/providers/all", () => ({}));

const TEST_MODEL: Model<"anthropic-messages"> = {
	id: "faux-model",
	name: "Faux",
	api: "anthropic-messages",
	provider: "faux",
	baseUrl: "https://invalid.test",
	reasoning: false,
	input: [],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 10_000,
	maxTokens: 1_000,
};

function resources(): ResourceLoader {
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

function safe(sessionId: string, runId = "run-1", status: SafeSubagentLifecycleProjection["status"] = "running"): SafeSubagentLifecycleProjection {
	const base = {
		schemaVersion: 1 as const,
		source: "subagent.lifecycle" as const,
		sessionId,
		runId,
		childAgentInstanceId: "child-1",
		parentAgentInstanceId: "parent-1",
		taskId: "task-1",
		status,
		providerKind: "in_process" as const,
		safeSummary: `Child child-1 is ${status}`,
		correlation: { attemptId: "attempt-1", spawnId: "spawn-1" },
	};
	return { ...base, digest: fingerprintFoundationValue(base) };
}

function forgedSafe(
	value: SafeSubagentLifecycleProjection,
	override: { readonly status?: string; readonly providerKind?: string },
): SafeSubagentLifecycleProjection {
	const { digest: _digest, ...base } = value;
	const forged = { ...base, ...override };
	return { ...forged, digest: fingerprintFoundationValue(forged) } as unknown as SafeSubagentLifecycleProjection;
}

const cleanupTasks: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanupTasks.splice(0)) await cleanup();
});

async function harness(registryFactory: (sessionId: string) => RpcSubagentRegistry) {
	const directory = join(tmpdir(), `aos-rpc-subagent-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(directory, { recursive: true });
	const agent = new Agent({
		getApiKey: () => "faux",
		initialState: { model: TEST_MODEL, systemPrompt: "Test", tools: [] },
		streamFn: () => { throw new Error("not used"); },
	});
	const modelRuntime = {
		hasConfiguredAuth: () => true,
		checkAuth: async () => ({ type: "api_key", key: "faux" }),
		isUsingOAuth: () => false,
		getAuth: async () => ({ type: "api_key", key: "faux" }),
	} as unknown as ModelRuntime;
	const session = new AgentSession({
		agent,
		sessionManager: SessionManager.create(directory),
		settingsManager: SettingsManager.create(directory, directory),
		cwd: directory,
		modelRuntime,
		resourceLoader: resources(),
	});
	const runtime = {
		session,
		newSession: vi.fn(async () => ({ cancelled: true })),
		switchSession: vi.fn(async () => ({ cancelled: true })),
		fork: vi.fn(async () => ({ cancelled: true, selectedText: "" })),
		dispose: vi.fn(async () => {}),
		setPrepareSessionRebind: vi.fn(),
	} as unknown as AgentSessionRuntime;
	vi.spyOn(session, "getSubagentRegistry").mockReturnValue(registryFactory(session.sessionId));
	const controller = new RpcHostController(runtime);
	await controller.start();
	cleanupTasks.push(async () => {
		await controller.shutdown();
		await session.dispose();
		if (existsSync(directory)) rmSync(directory, { recursive: true, force: true });
	});
	return { controller, sessionId: session.sessionId };
}

describe("RPC Subagent surface", () => {
	it("advertises the exact commands and enforces Run ownership with bounded safe projections", async () => {
		const cancelCalls: string[] = [];
		const value = await harness((sessionId) => ({
			get: async (runId, childId) => Result.ok(runId === "run-1" && childId === "child-1" ? safe(sessionId) : undefined),
			list: async (runId, filter) => Result.ok(runId === "run-1" && filter.limit <= 100 ? [safe(sessionId)] : []),
			cancel: async (runId, childId) => {
				cancelCalls.push(`${runId}:${childId}`);
				return Result.ok(runId === "run-1" && childId === "child-1" ? safe(sessionId, runId, "cancelling") : undefined);
			},
		}));
		const initialized = await value.controller.dispatch({ type: "initialize", protocolVersion: 1 });
		expect(initialized).toMatchObject({ success: true, data: { subagentCommands: ["subagent.get", "subagent.list", "subagent.cancel"] } });
		const get = await value.controller.dispatch({ type: "subagent.get", runId: "run-1", childAgentInstanceId: "child-1" });
		expect(get).toMatchObject({ success: true, data: { subagent: { sessionId: value.sessionId, runId: "run-1" } } });
		expect(JSON.stringify(get)).not.toMatch(/pid|executable|argv|cwd|env|transcript|prompt|token|secret|header|providerStack|rawFrame/u);
		expect(await value.controller.dispatch({ type: "subagent.get", runId: "foreign-run", childAgentInstanceId: "child-1" })).toMatchObject({ success: false, error: { code: "subagent_not_found" } });
		expect(await value.controller.dispatch({ type: "subagent.list", runId: "run-1", limit: 101 })).toMatchObject({ success: false, error: { code: "subagent_invalid" } });
		expect(await value.controller.dispatch({ type: "subagent.cancel", runId: "run-1", childAgentInstanceId: "child-1" })).toMatchObject({ success: true, data: { idempotent: false } });
		expect(cancelCalls).toEqual(["run-1:child-1"]);
	});

	it("fails closed when a registry tries to return forbidden or digest-invalid fields", async () => {
		const value = await harness((sessionId) => ({
			get: async () => Result.ok({ ...safe(sessionId), prompt: "raw child prompt" } as unknown as SafeSubagentLifecycleProjection),
			list: async () => Result.ok([]),
			cancel: async () => Result.err(new FoundationError("subagent_cancel_failed", "faux")),
		}));
		await value.controller.dispatch({ type: "initialize", protocolVersion: 1 });
		expect(await value.controller.dispatch({ type: "subagent.get", runId: "run-1", childAgentInstanceId: "child-1" })).toMatchObject({ success: false, error: { code: "subagent_not_found" } });
	});

	it("fails closed on digest-valid forged lifecycle and provider enums", async () => {
		const value = await harness((sessionId) => ({
			get: async () => Result.ok(forgedSafe(safe(sessionId), { status: "forged_status" })),
			list: async () => Result.ok([forgedSafe(safe(sessionId), { providerKind: "forged_provider" })]),
			cancel: async () => Result.ok(undefined),
		}));
		await value.controller.dispatch({ type: "initialize", protocolVersion: 1 });
		expect(await value.controller.dispatch({ type: "subagent.get", runId: "run-1", childAgentInstanceId: "child-1" })).toMatchObject({ success: false, error: { code: "subagent_not_found" } });
		expect(await value.controller.dispatch({ type: "subagent.list", runId: "run-1", limit: 10 })).toMatchObject({ success: false, error: { code: "subagent_invalid" } });
	});
});
