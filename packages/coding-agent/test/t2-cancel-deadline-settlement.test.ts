import {
	AgentHarness,
	AgentOperationError,
	InMemorySessionStorage,
	LayeredResultSettlement,
	Session,
	type FoundationJsonValue,
	type StreamFn,
} from "@aos-agent/agent-core";
import {
	createAssistantMessageEventStream,
	createModels,
	type AssistantMessage,
} from "@aos-agent/ai";
import { getModel } from "@aos-agent/ai/compat";
import { describe, expect, it } from "vitest";
import { ProductPromptIngressV1 } from "../src/core/product-prompt-ingress.ts";

const NOW = "2026-08-26T00:00:00.000Z";
const MODEL = getModel("openai", "gpt-4o-mini");

function assistant(stopReason: "stop" | "error", errorMessage?: string): AssistantMessage {
	if (MODEL === undefined) throw new Error("Test model is unavailable");
	return {
		role: "assistant",
		content: stopReason === "stop" ? [{ type: "text", text: "late provider output" }] : [],
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
		stopReason,
		...(errorMessage === undefined ? {} : { errorMessage }),
		timestamp: Date.parse(NOW),
	};
}

async function createFixture(mode: "pending" | "error") {
	if (MODEL === undefined) throw new Error("Test model is unavailable");
	const storage = new InMemorySessionStorage({ id: `t2-${mode}`, createdAt: 1 });
	const session = new Session(storage);
	const baseModels = createModels();
	const models = Object.create(baseModels) as typeof baseModels;
	const originalGetModel = baseModels.getModel.bind(baseModels);
	models.getModel = (provider, id) => provider === MODEL.provider && id === MODEL.id
		? MODEL
		: originalGetModel(provider, id);
	let markStarted: () => void = () => {};
	const started = new Promise<void>((resolve) => {
		markStarted = resolve;
	});
	const streamFunction: StreamFn = () => {
		const stream = createAssistantMessageEventStream();
		queueMicrotask(() => {
			markStarted();
			if (mode === "error") {
				stream.push({ type: "error", reason: "error", error: assistant("error", "provider outcome is uncertain") });
				return;
			}
			const message = assistant("stop");
			stream.push({ type: "start", partial: message });
			setTimeout(() => stream.push({ type: "done", reason: "stop", message }), 100);
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
		now: () => NOW,
	});
	return { session, harness: created.harness, ingress, started };
}

async function expectOneCanonicalTerminal(session: Session, runId: string) {
	const receipts = await session.findFoundationRecords({ kind: "fact", objectType: "run_receipt", order: "oldestFirst" });
	expect(receipts).toHaveLength(1);
	const settlement = new LayeredResultSettlement(session);
	try {
		const canonical = await settlement.lookupCanonicalRun(runId);
		if (!canonical.ok) throw canonical.error;
		expect(canonical.value).toBeDefined();
		const written = await settlement.getRunReceiptWrittenEvent(runId);
		expect(written).toMatchObject({
			category: "run_receipt.written",
			correlation: {
				runId,
				runReceiptId: canonical.value?.runReceipt.runReceiptId,
			},
		});
		return canonical.value;
	} finally {
		await settlement.release();
	}
}

describe("T2 canonical abort settlement", () => {
	it("settles active cancellation once and replays the same canonical receipt", async () => {
		const fixture = await createFixture("pending");
		const runId = "t2-active-cancel";
		const controller = new AbortController();
		try {
			const pending = fixture.ingress.execute({ prompt: "cancel this run", surface: "rpc", runId, signal: controller.signal });
			await fixture.started;
			controller.abort(new AgentOperationError("cancelled"));
			const execution = await pending;
			expect(execution.attemptReceipt).toMatchObject({ status: "cancelled", sideEffectState: "none" });
			expect(execution.taskResult.status).toBe("cancelled");
			expect(execution.runReceipt).toMatchObject({ terminalStatus: "cancelled", terminalErrorCode: "user_aborted" });

			const replay = await fixture.ingress.execute({ prompt: "cancel this run", surface: "rpc", runId });
			expect(replay.runReceipt).toEqual(execution.runReceipt);
			expect((await expectOneCanonicalTerminal(fixture.session, runId))?.runReceipt).toEqual(execution.runReceipt);
		} finally {
			await fixture.harness.close();
		}
	});

	it("settles a deadline as failed with the canonical deadline error", async () => {
		const fixture = await createFixture("pending");
		const runId = "t2-active-deadline";
		const controller = new AbortController();
		try {
			const pending = fixture.ingress.execute({ prompt: "deadline this run", surface: "rpc", runId, signal: controller.signal });
			await fixture.started;
			controller.abort(new AgentOperationError("deadline_exceeded"));
			const execution = await pending;
			expect(execution.attemptReceipt).toMatchObject({
				status: "failed",
				sideEffectState: "none",
				error: { code: "run_deadline_exceeded", category: "deadline", retryable: false },
			});
			expect(execution.taskResult.status).toBe("failed");
			expect(execution.runReceipt).toMatchObject({
				terminalStatus: "failed",
				terminalErrorCode: "run_deadline_exceeded",
				terminalError: { code: "run_deadline_exceeded", category: "deadline", retryable: false },
			});
			const replay = await fixture.ingress.execute({ prompt: "deadline this run", surface: "rpc", runId });
			expect(replay.runReceipt).toEqual(execution.runReceipt);
			expect((await expectOneCanonicalTerminal(fixture.session, runId))?.runReceipt).toEqual(execution.runReceipt);
		} finally {
			await fixture.harness.close();
		}
	});

	it("fails closed when the provider outcome remains uncertain", async () => {
		const fixture = await createFixture("error");
		const runId = "t2-side-effect-unknown";
		try {
			const execution = await fixture.ingress.execute({ prompt: "uncertain provider run", surface: "rpc", runId });
			expect(execution.attemptReceipt).toMatchObject({
				status: "failed",
				sideEffectState: "side_effect_unknown",
				error: { code: "side_effect_unknown", category: "side_effect_unknown", retryable: false },
			});
			expect(execution.runReceipt).toMatchObject({
				terminalStatus: "failed",
				terminalErrorCode: "side_effect_unknown",
				terminalError: { code: "side_effect_unknown", category: "side_effect_unknown", retryable: false },
			});
			expect((await expectOneCanonicalTerminal(fixture.session, runId))?.runReceipt).toEqual(execution.runReceipt);
		} finally {
			await fixture.harness.close();
		}
	});
});
