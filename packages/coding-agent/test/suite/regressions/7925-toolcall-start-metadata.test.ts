import { fakeAssistantMessage, fakeToolCall } from "@aos-agent/ai";
import { afterEach, describe, expect, it } from "vitest";
import { toJsonEvent } from "../../../src/modes/json-event.ts";
import { createHarness, type Harness } from "../harness.ts";

describe("issue #7925 tool-call start metadata", () => {
	let harness: Harness | undefined;

	afterEach(() => harness?.cleanup());

	it("includes id and name without the cumulative snapshot", async () => {
		harness = await createHarness();
		harness.setResponses([
			fakeAssistantMessage(fakeToolCall("write", { path: "output.txt", content: "x" }, { id: "call_7925" }), {
				stopReason: "toolUse",
			}),
			fakeAssistantMessage("done"),
		]);

		await harness.session.prompt("write a file");

		const update = harness.eventsOfType("message_update").find(
			(event) => event.assistantMessageEvent.type === "toolcall_start",
		);
		if (!update || update.message.role !== "assistant") throw new Error("Expected toolcall_start update");
		expect(toJsonEvent(update)).toEqual({
			type: "message_update",
			usage: update.message.usage,
			assistantMessageEvent: {
				type: "toolcall_start",
				contentIndex: 0,
				id: "call_7925",
				toolName: "write",
			},
		});
	});
});
