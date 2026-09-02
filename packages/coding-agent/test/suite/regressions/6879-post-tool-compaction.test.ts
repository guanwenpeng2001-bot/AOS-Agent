import type { AgentTool } from "@aos-agent/agent-core";
import { fakeAssistantMessage, fakeToolCall } from "@aos-agent/ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

describe("issue #6879 post-tool compaction", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	function largeResultTool(terminate = false): AgentTool & { sideEffectState: "none" } {
		return {
			name: "large_result",
			label: "Large result",
			description: "Returns enough content to cross the compaction threshold",
			parameters: Type.Object({}),
			sideEffectState: "none",
			execute: async () => ({
				content: [{ type: "text", text: `large-tool-result:${"x".repeat(6800)}` }],
				details: {},
				...(terminate ? { terminate: true } : {}),
			}),
		};
	}

	async function createCompactionHarness(tool: AgentTool): Promise<Harness> {
		const harness = await createHarness({
			systemPrompt: "system",
			models: [{ id: "fake-1", contextWindow: 6000, maxTokens: 100 }],
			settings: { compaction: { enabled: true, reserveTokens: 1000, keepRecentTokens: 100 } },
			tools: [tool],
			extensionFactories: [
				(pi) => {
					pi.on("session_before_compact", (event) => ({
						compaction: {
							summary: "compacted history",
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		return harness;
	}

	it("compacts a large tool result before resuming the provider", async () => {
		const harness = await createCompactionHarness(largeResultTool());
		const order: string[] = [];
		let resumedRequest = "";
		harness.setResponses([
			fakeAssistantMessage(`old-history:${"a".repeat(7000)}`),
			fakeAssistantMessage(`recent-history:${"b".repeat(7000)}`),
			fakeAssistantMessage(fakeToolCall("large_result", {}), { stopReason: "toolUse" }),
			(context) => {
				order.push("provider");
				resumedRequest = JSON.stringify(context.messages);
				return fakeAssistantMessage("finished after compaction");
			},
		]);
		harness.session.subscribe((event) => {
			if (event.type === "compaction_end" && event.result) order.push("compaction");
		});

		await harness.session.prompt("seed old history");
		await harness.session.prompt("seed recent history");
		await harness.session.prompt("run the large tool");

		expect(order).toEqual(["compaction", "provider"]);
		expect(resumedRequest).toContain("compacted history");
		expect(resumedRequest).toContain("large-tool-result");
		expect(harness.session.getLastAssistantText()).toBe("finished after compaction");
	}, 60_000);

	it("does not compact or resume after a terminating tool result", async () => {
		const harness = await createCompactionHarness(largeResultTool(true));
		harness.setResponses([
			fakeAssistantMessage(`old-history:${"a".repeat(7000)}`),
			fakeAssistantMessage(`recent-history:${"b".repeat(7000)}`),
			fakeAssistantMessage(fakeToolCall("large_result", {}), { stopReason: "toolUse" }),
		]);

		await harness.session.prompt("seed old history");
		await harness.session.prompt("seed recent history");
		await harness.session.prompt("run the terminating tool");

		expect(harness.eventsOfType("compaction_start")).toEqual([]);
		expect(harness.getPendingResponseCount()).toBe(0);
	});
});
