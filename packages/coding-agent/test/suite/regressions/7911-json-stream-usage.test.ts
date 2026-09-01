import { fakeAssistantMessage } from "@aos-agent/ai";
import { afterEach, describe, expect, it } from "vitest";
import { toJsonEvent } from "../../../src/modes/json-event.ts";
import { createHarness, type Harness } from "../harness.ts";

describe("issue #7911 JSON stream usage", () => {
	let harness: Harness | undefined;

	afterEach(() => harness?.cleanup());

	it("retains cumulative usage without cumulative message snapshots", async () => {
		harness = await createHarness();
		harness.setResponses([fakeAssistantMessage("hello")]);

		await harness.session.prompt("respond");

		const update = harness.eventsOfType("message_update").find(
			(event) => event.message.role === "assistant" && event.message.usage.totalTokens > 0,
		);
		if (!update || update.message.role !== "assistant") throw new Error("Expected populated assistant usage");
		const wire = toJsonEvent(update);
		expect(wire.usage).toEqual(update.message.usage);
		expect(wire).not.toHaveProperty("message");
		expect(wire.assistantMessageEvent).not.toHaveProperty("partial");
	});
});
