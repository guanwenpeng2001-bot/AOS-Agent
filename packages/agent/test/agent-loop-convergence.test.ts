import { type AssistantMessage, type AssistantMessageEvent, EventStream } from "@aos-agent/ai";
import { describe, expect, it } from "vitest";
import { runAgentLoop } from "../src/agent-loop.ts";
import { AgentLoopError } from "../src/loop-convergence.ts";
import type { AgentContext, AgentEvent, AgentLoopConfig, AgentMessage, StreamFn } from "../src/types.ts";

const model = {
	id: "test-model",
	name: "test-model",
	api: "test",
	provider: "test",
	baseUrl: "",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1000,
	maxTokens: 100,
} as AgentLoopConfig["model"];

function assistant(toolCallId?: string): AgentMessage {
	return {
		role: "assistant",
		content:
			toolCallId === undefined
				? [{ type: "text", text: "done" }]
				: [{ type: "toolCall", id: toolCallId, name: "repeat", arguments: { value: "same" } }],
		api: "test",
		provider: "test",
		model: "test-model",
		usage: {
			input: 0,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 1,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: toolCallId === undefined ? "stop" : "toolUse",
		timestamp: Date.now(),
	};
}

function streamFor(messages: AgentMessage[]): StreamFn {
	return () => {
		const stream = new EventStream<AssistantMessageEvent, AssistantMessage>(
			() => true,
			() => messages[0]! as AssistantMessage,
		);
		queueMicrotask(() => {
			const message = messages.shift();
			if (message === undefined) return;
			stream.push({
				type: "done",
				reason:
					message.role === "assistant" && message.content.some((part) => part.type === "toolCall")
						? "toolUse"
						: "stop",
				message,
			} as AssistantMessageEvent);
		});
		return stream;
	};
}

function config(overrides: Partial<AgentLoopConfig> = {}): AgentLoopConfig {
	return {
		model,
		convertToLlm: (messages) => messages as never,
		...overrides,
	};
}

describe("agent loop convergence", () => {
	it("stops repeated identical tool calls at the configured bound", async () => {
		const context: AgentContext = {
			systemPrompt: "",
			messages: [],
			tools: [
				{
					name: "repeat",
					label: "repeat",
					description: "repeat",
					parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
					execute: async () => ({ content: [{ type: "text", text: "again" }], details: {} }),
				},
			],
		};
		const events: AgentEvent[] = [];
		const pending = [assistant("1"), assistant("2"), assistant("3"), assistant("4"), assistant("5")];
		await expect(
			runAgentLoop(
				[{ role: "user", content: [{ type: "text", text: "go" }], timestamp: Date.now() }],
				context,
				config({ loopLimits: { maxRepeatedToolCalls: 2 }, toolExecution: "sequential" }),
				async (event) => {
					events.push(event);
				},
				new AbortController().signal,
				streamFor(pending),
			),
		).rejects.toBeInstanceOf(AgentLoopError);
		expect(events.some((event) => event.type === "tool_execution_start")).toBe(true);
	});

	it("rejects a deadline before starting the provider", async () => {
		const controller = new AbortController();
		controller.abort();
		let calls = 0;
		await expect(
			runAgentLoop(
				[{ role: "user", content: [{ type: "text", text: "go" }], timestamp: Date.now() }],
				{ systemPrompt: "", messages: [], tools: [] },
				config(),
				() => undefined,
				controller.signal,
				() => {
					calls += 1;
					throw new Error("provider called");
				},
			),
		).rejects.toThrow("Operation cancelled");
		expect(calls).toBe(0);
	});
});
