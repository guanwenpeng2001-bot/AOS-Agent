import type { AssistantMessage } from "@aos-agent/ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

type CompactionInternals = {
	_checkCompaction(message: AssistantMessage): Promise<boolean>;
	_runAutoCompaction(reason: "overflow" | "threshold", willRetry: boolean): Promise<boolean>;
};

describe("issue #8328 zero-usage auto-compaction", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("uses estimated message size when the provider reports no usage", async () => {
		const harness = await createHarness({
			models: [{ id: "fake-1", contextWindow: 100, maxTokens: 20 }],
			settings: { compaction: { enabled: true, reserveTokens: 10 } },
		});
		harnesses.push(harness);
		const model = harness.getModel();
		const assistant: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "response" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
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
		harness.session.agent.state.messages = [
			{ role: "user", content: [{ type: "text", text: "x".repeat(400) }], timestamp: Date.now() - 1 },
			assistant,
		];
		const internals = harness.session as unknown as CompactionInternals;
		const compact = vi.spyOn(internals, "_runAutoCompaction").mockResolvedValue(false);

		await internals._checkCompaction(assistant);

		expect(compact).toHaveBeenCalledWith("threshold", false);
	});
});
