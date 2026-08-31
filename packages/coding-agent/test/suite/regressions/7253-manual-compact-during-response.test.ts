import type { AgentTool } from "@aos-agent/agent-core";
import { fakeAssistantMessage, fakeToolCall } from "@aos-agent/ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../harness.ts";

function createNoopTool(): AgentTool {
	return {
		name: "noop",
		label: "No-op",
		description: "Return immediately",
		parameters: Type.Object({}),
		execute: async () => ({ content: [{ type: "text", text: "done" }], details: {} }),
	};
}

describe("issue #7253: manual compaction during an active response", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("runs only the requested manual compaction when the previous turn crossed the threshold", async () => {
		let markSecondResponseStarted = () => {};
		const secondResponseStarted = new Promise<void>((resolve) => {
			markSecondResponseStarted = resolve;
		});
		let releaseSecondResponse = () => {};
		const secondResponseReleased = new Promise<void>((resolve) => {
			releaseSecondResponse = resolve;
		});

		const harness = await createHarness({
			models: [{ id: "fake-1", contextWindow: 1000, maxTokens: 100 }],
			settings: {
				// Keep the legacy compaction threshold at 999 while giving Context
				// Engine the model's actual 100-token output reserve.
				compaction: { enabled: true, reserveTokens: 999, keepRecentTokens: 2 },
				context: { reserveTokens: 100 },
			},
			tools: [createNoopTool()],
			extensionFactories: [
				(agent) => {
					agent.on("session_before_compact", async (event) => ({
						compaction: {
							summary: `${event.reason} summary`,
							firstKeptEntryId: event.preparation.firstKeptEntryId,
							tokensBefore: event.preparation.tokensBefore,
							details: {},
						},
					}));
				},
			],
		});
		harnesses.push(harness);
		// Static prompt text is unrelated to this control-flow regression.
		harness.session.resourceLoader.getSystemPrompt = () => "test";
		harness.session.setActiveToolsByName(harness.session.getActiveToolNames());
		harness.setResponses([
			fakeAssistantMessage(fakeToolCall("noop", {}), { stopReason: "toolUse" }),
			async () => {
				markSecondResponseStarted();
				await secondResponseReleased;
				return fakeAssistantMessage("second response");
			},
		]);

		const promptPromise = harness.session.prompt("Run the tool, then continue responding.");
		await secondResponseStarted;

		const compactPromise = harness.session.compact();
		const compactExpectation = expect(compactPromise).resolves.toMatchObject({ summary: "manual summary" });
		releaseSecondResponse();
		await Promise.all([promptPromise, compactExpectation]);

		expect(harness.eventsOfType("compaction_start").map((event) => event.reason)).toEqual(["manual"]);
		expect(harness.eventsOfType("compaction_end").map((event) => event.reason)).toEqual(["manual"]);
		expect(harness.sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
	});
});
