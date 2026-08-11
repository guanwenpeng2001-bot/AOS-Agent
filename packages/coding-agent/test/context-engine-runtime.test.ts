import { describe, expect, it } from "vitest";
import {
	CONTEXT_SNAPSHOT_CUSTOM_TYPE,
	assertSnapshotMetadataOnly,
	freezeContext,
	resolveContext,
	type ContextSnapshot,
} from "../src/core/context-engine.ts";
import { createRunLifecycleCoordinator } from "../src/core/run-lifecycle.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createHarness, createHarnessWithExtensions } from "./test-harness.ts";
import { assistantMsg, createTestResourceLoader, userMsg } from "./utilities.ts";

function freezeSampleSnapshot(sessionId: string, id: string): ContextSnapshot {
	const planResult = resolveContext({
		purpose: "agent_turn",
		sessionId,
		runId: "run-1",
		contextWindow: 100_000,
		reserveTokens: 1_000,
		sources: [
			{
				sourceId: "sys",
				kind: "system",
				scope: "global",
				trust: "builtin",
				content: "You are a coding assistant.",
				required: true,
			},
			{
				sourceId: "instr.project",
				kind: "instruction",
				scope: "project",
				trust: "trusted_project",
				path: "/proj/AGENTS.md",
				content: "project rules body must not appear in snapshot",
				required: true,
			},
		],
		sessionMessages: [],
		turnMessages: [{ role: "user", content: "hello", timestamp: Date.now() }],
	});
	expect(planResult.ok).toBe(true);
	if (!planResult.ok) {
		throw new Error(planResult.error.message);
	}
	return freezeContext(planResult.plan, {
		id,
		createdAt: new Date().toISOString(),
	});
}

describe("context-engine runtime persistence", () => {
	it("plans the exact provider request at the stream boundary and binds its snapshot to the run", async () => {
		const resourceLoader = createTestResourceLoader();
		resourceLoader.toContextSourceInputs = () => [
			{
				sourceId: "instruction:trusted",
				kind: "instruction",
				scope: "project",
				trust: "trusted_project",
				content: "TRUSTED_PROJECT_RULE",
				required: true,
			},
			{
				sourceId: "instruction:untrusted",
				kind: "instruction",
				scope: "project",
				trust: "untrusted_project",
				content: "UNTRUSTED_PROJECT_RULE",
				required: false,
				preDisposition: { disposition: "excluded", reason: "untrusted" },
			},
		];
		const harness = await createHarness({ resourceLoader, responses: ["done"] });

		try {
			await harness.session.prompt("hello", { runId: "run-boundary" });

			expect(harness.faux.callCount).toBe(1);
			expect(harness.faux.contexts[0]?.systemPrompt).toContain("TRUSTED_PROJECT_RULE");
			expect(harness.faux.contexts[0]?.systemPrompt).not.toContain("UNTRUSTED_PROJECT_RULE");

			const snapshots = harness.sessionManager.getContextSnapshots();
			expect(snapshots).toHaveLength(1);
			expect(snapshots[0]?.purpose).toBe("agent_turn");
			expect(snapshots[0]?.runId).toBe("run-boundary");
			expect(harness.session.getContextSnapshotIdForRun("run-boundary")).toBe(snapshots[0]?.id);
			expect(snapshots[0]?.sources).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ sourceId: "instruction:trusted", disposition: "included" }),
				expect.objectContaining({
					sourceId: "instruction:untrusted",
					disposition: "excluded",
					reason: "untrusted",
				}),
			]),
		);
			expect(snapshots[0]?.sources).toEqual(
				expect.arrayContaining([expect.objectContaining({ sourceId: expect.stringMatching(/^capability:tool:/) })]),
			);
			expect(JSON.stringify(snapshots)).not.toContain("TRUSTED_PROJECT_RULE");
			expect(JSON.stringify(snapshots)).not.toContain("UNTRUSTED_PROJECT_RULE");
		} finally {
			harness.cleanup();
		}
	});

	it("uses a formal before_agent_start contribution in model input", async () => {
		const harness = await createHarnessWithExtensions({
			responses: ["first", "second"],
			extensionFactories: [
				(agent) => {
					agent.on("before_agent_start", () => ({
						contribution: {
							sourceId: "extension:runtime-contribution",
							label: "Runtime contribution",
							visibility: "model_and_snapshot",
							messages: [{ role: "user", content: "EXTENSION_MESSAGE", timestamp: 0 }],
							systemPromptAppend: "EXTENSION_PROMPT",
						},
					}));
				},
			],
		});

		try {
			await harness.session.prompt("hello");

			expect(harness.faux.contexts[0]?.systemPrompt).toContain("EXTENSION_PROMPT");
			expect(JSON.stringify(harness.faux.contexts[0]?.messages)).toContain("EXTENSION_MESSAGE");
			const snapshot = harness.sessionManager.getContextSnapshots().at(-1);
			expect(snapshot?.sources).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						sourceId: "extension:runtime-contribution",
						label: "Runtime contribution",
						visibility: "model_and_snapshot",
						disposition: "included",
					}),
				]),
			);
			expect(JSON.stringify(snapshot)).not.toContain("EXTENSION_MESSAGE");
			expect(JSON.stringify(snapshot)).not.toContain("EXTENSION_PROMPT");
		} finally {
			harness.cleanup();
		}
	});

	it("rejects provider-payload rewrite hooks before a Context Engine model call", async () => {
		const harness = await createHarnessWithExtensions({
			extensionFactories: [
				(agent) => {
					agent.on("before_provider_request", () => ({}));
				},
			],
		});

		try {
			await expect(harness.session.prompt("hello")).rejects.toMatchObject({
				contextError: { code: "context_extension_source_missing" },
			});
			expect(harness.faux.callCount).toBe(0);
			expect(harness.sessionManager.getContextSnapshots()).toEqual([]);
		} finally {
			harness.cleanup();
		}
	});

	it("rejects provider-payload hooks before a Context Engine compaction call", async () => {
		const harness = await createHarnessWithExtensions({
			responses: ["summary"],
			settings: { compaction: { keepRecentTokens: 1 } },
			extensionFactories: [
				(agent) => {
					agent.on("before_provider_request", () => ({}));
				},
			],
		});

		try {
			harness.sessionManager.appendMessage(userMsg("old context"));
			harness.sessionManager.appendMessage(assistantMsg("old response"));

			await expect(harness.session.compact()).rejects.toMatchObject({
				contextError: { code: "context_extension_source_missing" },
			});
			expect(harness.faux.callCount).toBe(0);
			expect(harness.sessionManager.getContextSnapshots()).toEqual([]);
		} finally {
			harness.cleanup();
		}
	});

	it("revokes explicit memory by id without requiring callers to repeat its scope", async () => {
		const harness = await createHarness({
			settings: { memory: { sessionEnabled: true } },
		});

		try {
			const memory = await harness.session.addContextMemory({
				scope: "session",
				text: "remember only by explicit action",
			});
			expect((await harness.session.listContextMemory()).map((entry) => entry.id)).toContain(memory.id);

			await harness.session.revokeContextMemory({ id: memory.id });
			expect((await harness.session.listContextMemory()).map((entry) => entry.id)).not.toContain(memory.id);
		} finally {
			harness.cleanup();
		}
	});

	it("fails before provider invocation when a required source exceeds the context budget", async () => {
		const harness = await createHarness({
			contextWindow: 100,
			settings: { context: { reserveTokens: 99 } },
		});

		try {
			await expect(harness.session.prompt("hello")).rejects.toMatchObject({
				contextError: { code: "context_budget_exceeded" },
			});
			expect(harness.faux.callCount).toBe(0);
			expect(harness.sessionManager.getContextSnapshots()).toEqual([]);
		} finally {
			harness.cleanup();
		}
	});

	it("retains legacy prompt assembly only when Context Engine is explicitly disabled", async () => {
		const resourceLoader = createTestResourceLoader();
		resourceLoader.getContextSources = () => ({
			contextSources: [
				{
					sourceId: "instruction:legacy",
					path: "/project/AGENTS.md",
					content: "LEGACY_RULE_WHEN_DISABLED",
					scope: "project",
					trust: "trusted_project",
					injectable: true,
				},
			],
		});
		const harness = await createHarness({
			resourceLoader,
			responses: ["done"],
			settings: { context: { enabled: false } },
		});

		try {
			await harness.session.prompt("hello");
			expect(harness.faux.contexts[0]?.systemPrompt).toContain("LEGACY_RULE_WHEN_DISABLED");
			expect(harness.sessionManager.getContextSnapshots()).toEqual([]);
		} finally {
			harness.cleanup();
		}
	});

	it("stores metadata-only context.snapshot custom entries and excludes them from LLM context", () => {
		const session = SessionManager.inMemory();
		const snapshot = freezeSampleSnapshot(session.getSessionId(), "snap-1");
		assertSnapshotMetadataOnly(snapshot);

		session.appendCustomEntry(CONTEXT_SNAPSHOT_CUSTOM_TYPE, snapshot);
		session.appendMessage({
			role: "user",
			content: "hello",
			timestamp: Date.now(),
		});

		const listed = session.getContextSnapshots();
		expect(listed).toHaveLength(1);
		expect(listed[0]!.id).toBe("snap-1");
		expect(session.getContextSnapshot("snap-1")?.purpose).toBe("agent_turn");
		expect(session.getLatestContextSnapshotId()).toBe("snap-1");

		const json = JSON.stringify(listed[0]);
		expect(json).not.toContain("project rules body must not appear in snapshot");
		expect(json).not.toContain("You are a coding assistant.");

		const ctx = session.buildSessionContext();
		expect(ctx.messages.some((message) => message.role === "user")).toBe(true);
		// Custom snapshot entries never become model messages.
		expect(JSON.stringify(ctx.messages)).not.toContain(CONTEXT_SNAPSHOT_CUSTOM_TYPE);
		expect(JSON.stringify(ctx.messages)).not.toContain("snap-1");
	});

	it("strips unexpected raw fields from persisted snapshot payloads before inspection", () => {
		const session = SessionManager.inMemory();
		session.appendCustomEntry(CONTEXT_SNAPSHOT_CUSTOM_TYPE, {
			schemaVersion: 1,
			id: "snap-sanitized",
			purpose: "agent_turn",
			sessionId: session.getSessionId(),
			createdAt: new Date().toISOString(),
			systemPrompt: "DO_NOT_EXPOSE_SYSTEM_PROMPT",
			messages: [{ role: "user", content: "DO_NOT_EXPOSE_MESSAGE" }],
			sources: [
				{
					sourceId: "instruction:one",
					kind: "instruction",
					scope: "project",
					trust: "trusted_project",
					contentDigest: "a".repeat(64),
					estimatedTokens: 1,
					disposition: "included",
					content: "DO_NOT_EXPOSE_SOURCE",
				},
			],
			budget: { contextWindow: 100, reserveTokens: 10, inputLimit: 90, estimatedInputTokens: 1 },
		});

		const snapshot = session.getContextSnapshot("snap-sanitized");
		expect(snapshot).toBeDefined();
		expect(JSON.stringify(snapshot)).not.toContain("DO_NOT_EXPOSE_");
		expect(snapshot?.sources[0]).not.toHaveProperty("content");
	});

	it("freezes a compaction snapshot at the actual summarization request", async () => {
		const harness = await createHarness({
			responses: ["first answer", "summary answer"],
			settings: { compaction: { keepRecentTokens: 1, reserveTokens: 100 }, context: { reserveTokens: 100 } },
		});

		try {
			await harness.session.prompt("message to compact");
			await harness.session.compact();

			const compactionSnapshots = harness.sessionManager
				.getContextSnapshots()
				.filter((entry) => entry.purpose === "compaction");
			const snapshot = compactionSnapshots[compactionSnapshots.length - 1];
			expect(snapshot).toBeDefined();
			expect(harness.faux.contexts.at(-1)?.systemPrompt).toContain("context summarization assistant");
			expect(snapshot?.sources).toEqual(
				expect.arrayContaining([expect.objectContaining({ sourceId: "system:compaction:runtime" })]),
			);
			const compaction = harness.sessionManager.getEntries().find((entry) => entry.type === "compaction");
			if (!compaction || compaction.type !== "compaction") {
				throw new Error("Expected a persisted compaction entry");
			}
			expect(compaction.details).toMatchObject({ contextSnapshotId: snapshot?.id });
		} finally {
			harness.cleanup();
		}
	});

	it("freezes a branch-summary snapshot at the actual summarization request", async () => {
		const harness = await createHarness({ responses: ["branch summary"] });

		try {
			const rootId = harness.sessionManager.appendMessage(userMsg("root"));
			const oldLeafId = harness.sessionManager.appendMessage(assistantMsg("old branch context"));
			harness.sessionManager.branch(rootId);
			const targetId = harness.sessionManager.appendMessage(userMsg("target"));
			harness.sessionManager.branch(oldLeafId);

			const result = await harness.session.navigateTree(targetId, { summarize: true });
			const snapshot = harness.sessionManager
				.getContextSnapshots()
				.find((entry) => entry.purpose === "branch_summary");

			expect(harness.faux.callCount).toBe(1);
			expect(harness.faux.contexts[0]?.systemPrompt).toContain("context summarization assistant");
			expect(snapshot).toBeDefined();
			expect(result.summaryEntry?.details).toMatchObject({ contextSnapshotId: snapshot?.id });
		} finally {
			harness.cleanup();
		}
	});

	it("binds only an explicit contextSnapshotId on Automation Host terminal receipts", () => {
		const session = SessionManager.inMemory();
		const snapshot = freezeSampleSnapshot(session.getSessionId(), "snap-receipt");
		session.appendCustomEntry(CONTEXT_SNAPSHOT_CUSTOM_TYPE, snapshot);

		const coordinator = createRunLifecycleCoordinator(session);
		const handle = coordinator.reserve().accept({
			attempt: 1,
			model: { provider: "faux", id: "m1", thinkingLevel: "off" },
		});
		handle.start();
		const terminal = handle.settle({ outcome: "completed", finalText: "done" });
		expect(terminal?.type).toBe("run.completed");
		expect(handle.receipt()?.contextSnapshotId).toBeUndefined();

		// A run is never linked to a concurrent/latest snapshot by inference.
		const handle2 = coordinator.reserve().accept({
			attempt: 1,
			model: { provider: "faux", id: "m1", thinkingLevel: "off" },
			runId: "run-explicit",
		});
		handle2.start();
		handle2.settle({
			outcome: "failed",
			finalText: "x",
			contextSnapshotId: "snap-receipt",
		});
		expect(handle2.receipt()?.contextSnapshotId).toBe("snap-receipt");
	});

	it("records compaction and branch_summary purposes as distinct snapshots", () => {
		const session = SessionManager.inMemory();
		const base = freezeSampleSnapshot(session.getSessionId(), "snap-turn");
		session.appendCustomEntry(CONTEXT_SNAPSHOT_CUSTOM_TYPE, base);

		const compactionPlan = resolveContext({
			purpose: "compaction",
			sessionId: session.getSessionId(),
			contextWindow: 100_000,
			reserveTokens: 1_000,
			sources: [
				{
					sourceId: "sys",
					kind: "system",
					scope: "global",
					trust: "builtin",
					content: "compact",
					required: true,
				},
			],
			sessionMessages: [],
			turnMessages: [],
		});
		expect(compactionPlan.ok).toBe(true);
		if (!compactionPlan.ok) {
			return;
		}
		const compactionSnap = freezeContext(compactionPlan.plan, {
			id: "snap-compact",
			createdAt: new Date().toISOString(),
			parentSnapshotId: "snap-turn",
		});
		session.appendCustomEntry(CONTEXT_SNAPSHOT_CUSTOM_TYPE, compactionSnap);

		const all = session.getContextSnapshots();
		expect(all.map((s) => s.purpose)).toEqual(["agent_turn", "compaction"]);
		expect(all[1]!.parentSnapshotId).toBe("snap-turn");
		expect(session.getLatestContextSnapshotId()).toBe("snap-compact");
	});
});
