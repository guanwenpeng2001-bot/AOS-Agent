import {
	AgentHarness,
	InMemorySessionStorage,
	Session,
	type FoundationJsonValue,
	type StreamFn,
} from "@aos-agent/agent-core";
import {
	createAssistantMessageEventStream,
	createModels,
	type AssistantMessage,
	type Context,
} from "@aos-agent/ai";
import { getModel } from "@aos-agent/ai/compat";
import { describe, expect, it } from "vitest";
import { ProductPromptIngressV1 } from "../src/core/product-prompt-ingress.ts";

const MODEL = getModel("openai", "gpt-4o-mini");

function response(text: string): AssistantMessage {
	if (MODEL === undefined) throw new Error("Test model is unavailable");
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: MODEL.api,
		provider: MODEL.provider,
		model: MODEL.id,
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

describe("ProductPromptIngressV1", () => {
	it("uses one Harness and Goal while producing a replayable Task receipt chain per run", async () => {
		if (MODEL === undefined) throw new Error("Test model is unavailable");
		const session = new Session(new InMemorySessionStorage({ id: "product-prompt-ingress", createdAt: 1 }));
		const baseModels = createModels();
		const models = Object.create(baseModels) as typeof baseModels;
		const originalGetModel = baseModels.getModel.bind(baseModels);
		models.getModel = (provider, id) => provider === MODEL.provider && id === MODEL.id ? MODEL : originalGetModel(provider, id);
		const contexts: Context[] = [];
		let calls = 0;
		const streamFunction: StreamFn = (_model, context) => {
			contexts.push(structuredClone(context));
			calls += 1;
			const stream = createAssistantMessageEventStream();
			const message = response(`reply-${calls}`);
			queueMicrotask(() => {
				stream.push({ type: "start", partial: message });
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		};
		const created = await AgentHarness.create({ session, models, model: MODEL, drive: "automatic", streamFunction });
		const ingress = new ProductPromptIngressV1({
			session,
			harness: created.harness,
			models,
			cwd: "C:/workspace",
			currentModel: () => MODEL,
			currentThinkingLevel: () => "off",
			dependencySnapshot: (name, context): FoundationJsonValue => ({ name, runId: context.runId, state: "active" }),
			now: () => "2026-08-20T00:00:00.000Z",
		});

		try {
			const first = await ingress.execute({
				prompt: "first prompt",
				surface: "sdk",
				runId: "product-run-1",
				images: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }],
			});
			const second = await ingress.execute({ prompt: "second prompt", surface: "rpc", runId: "product-run-2" });
			const replay = await ingress.execute({
				prompt: "first prompt",
				surface: "sdk",
				runId: "product-run-1",
				images: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }],
			});
			expect(calls).toBe(2);
			expect(first.run.runId).toBe("product-run-1");
			expect(second.run.runId).toBe("product-run-2");
			expect(replay).toEqual(first);
			expect(contexts[0]?.messages[0]?.role).toBe("user");
			expect(contexts[0]?.messages[0]?.content).toEqual([
				{ type: "text", text: "first prompt" },
				{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
			]);

			const tasks = await session.findFoundationRecords({ kind: "fact", objectType: "task", order: "oldestFirst" });
			const attempts = await session.findFoundationRecords({ kind: "fact", objectType: "attempt", order: "oldestFirst" });
			const attemptReceipts = await session.findFoundationRecords({ kind: "fact", objectType: "attempt_receipt", order: "oldestFirst" });
			const taskResults = await session.findFoundationRecords({ kind: "fact", objectType: "task_result", order: "oldestFirst" });
			const runReceipts = await session.findFoundationRecords({ kind: "fact", objectType: "run_receipt", order: "oldestFirst" });
			expect(tasks).toHaveLength(2);
			expect(attempts).toHaveLength(2);
			expect(attemptReceipts).toHaveLength(2);
			expect(taskResults).toHaveLength(2);
			expect(runReceipts).toHaveLength(2);
			expect(new Set(tasks.map((record) => record.kind === "fact" && (record.payload as { goalId: string }).goalId))).toEqual(new Set([first.task.goalId]));
			await expect(ingress.execute({ prompt: "conflicting prompt", surface: "sdk", runId: "product-run-1" })).rejects.toMatchObject({ code: "session_ledger_conflict" });
			await expect(ingress.execute({ prompt: "first prompt", surface: "tui", runId: "product-run-1" })).rejects.toMatchObject({ code: "session_ledger_conflict" });
		} finally {
			await created.harness.close();
		}
	});
});
