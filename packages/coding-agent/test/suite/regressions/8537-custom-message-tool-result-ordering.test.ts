import type { AgentMessage, AgentTool } from "@aos-agent/agent-core";
import { fakeAssistantMessage, fakeToolCall } from "@aos-agent/ai";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { convertToLlm } from "../../../src/core/messages.ts";
import { createHarness, type Harness } from "../harness.ts";

describe("issue #8537 custom messages during tool execution", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	it("records the custom message after the current tool result", async () => {
		let notify: (() => Promise<void>) | undefined;
		const tool: AgentTool & { sideEffectState: "none" } = {
			name: "wait",
			label: "Wait",
			description: "Wait for an external notification",
			parameters: Type.Object({}),
			sideEffectState: "none",
			execute: async () => {
				await notify?.();
				return { content: [{ type: "text", text: "tool done" }], details: {} };
			},
		};
		const harness = await createHarness({ tools: [tool] });
		harnesses.push(harness);
		notify = () => harness.session.sendCustomMessage(
			{ customType: "subagent-reply", content: "subagent replied", display: true },
			{ triggerTurn: false },
		);
		harness.setResponses([
			fakeAssistantMessage(fakeToolCall("wait", {}), { stopReason: "toolUse" }),
			fakeAssistantMessage("done"),
		]);

		await harness.session.prompt("hi");

		expect(harness.session.messages.map((message) => message.role)).toEqual([
			"user",
			"assistant",
			"toolResult",
			"custom",
			"assistant",
		]);
		const llmMessages = convertToLlm(harness.session.messages as AgentMessage[]);
		const callIndex = llmMessages.findIndex((message) => message.role === "assistant" && message.content.some((block) => block.type === "toolCall"));
		expect(llmMessages[callIndex + 1]?.role).toBe("toolResult");
	});
});
