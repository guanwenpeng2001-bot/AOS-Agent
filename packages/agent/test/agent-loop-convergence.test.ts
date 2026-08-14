import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	type Message,
	type Model,
	type UserMessage,
} from "@aos-agent/ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { Agent, agentLoop, createAgentLoopConvergenceGuard } from "../src/index.ts";
import type { AgentContext, AgentLoopConfig, AgentMessage, AgentTool } from "../src/types.ts";

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

function createModel(): Model<"openai-responses"> {
	return {
		id: "convergence-test",
		name: "convergence-test",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	};
}

function createAssistantMessage(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "convergence-test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	};
}

function createUserMessage(text: string): UserMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter(
		(message) => message.role === "user" || message.role === "assistant" || message.role === "toolResult",
	) as Message[];
}

function toolConfig(loopConvergence: AgentLoopConfig["loopConvergence"]): {
	context: AgentContext;
	config: AgentLoopConfig;
} {
	const schema = Type.Object({ value: Type.String() });
	const tool: AgentTool<typeof schema, { value: string }> = {
		name: "echo",
		label: "Echo",
		description: "Echo a value",
		parameters: schema,
		async execute(_toolCallId, params) {
			return {
				content: [{ type: "text", text: params.value }],
				details: params,
			};
		},
	};
	return {
		context: { systemPrompt: "", messages: [], tools: [tool] },
		config: { model: createModel(), convertToLlm: identityConverter, loopConvergence },
	};
}

describe("production agent loop convergence", () => {
	it("stops repeated tool calls before starting a third provider turn", async () => {
		const { context, config } = toolConfig({
			maxIterations: 10,
			maxDuplicateToolCalls: 2,
			maxNoProgressIterations: 10,
		});
		let providerCalls = 0;
		const stream = agentLoop([createUserMessage("repeat")], context, config, undefined, () => {
			providerCalls += 1;
			const response = new MockAssistantStream();
			queueMicrotask(() => {
				response.push({
					type: "done",
					reason: "toolUse",
					message: createAssistantMessage(
						[{ type: "toolCall", id: `call-${providerCalls}`, name: "echo", arguments: { value: "same" } }],
						"toolUse",
					),
				});
			});
			return response;
		});
		const events = [] as Array<{ type: string; terminationReason?: string }>;
		for await (const event of stream) events.push(event);

		expect(providerCalls).toBe(2);
		expect(events.at(-1)).toMatchObject({ type: "agent_end", terminationReason: "duplicate_tool_call" });
	});

	it("stops changing tool calls at the configured maximum iteration", async () => {
		const { context, config } = toolConfig({
			maxIterations: 2,
			maxDuplicateToolCalls: 10,
			maxNoProgressIterations: 10,
		});
		let providerCalls = 0;
		const stream = agentLoop([createUserMessage("bounded")], context, config, undefined, () => {
			providerCalls += 1;
			const response = new MockAssistantStream();
			queueMicrotask(() => {
				response.push({
					type: "done",
					reason: "toolUse",
					message: createAssistantMessage(
						[
							{
								type: "toolCall",
								id: `call-${providerCalls}`,
								name: "echo",
								arguments: { value: String(providerCalls) },
							},
						],
						"toolUse",
					),
				});
			});
			return response;
		});
		const events = [] as Array<{ type: string; terminationReason?: string }>;
		for await (const event of stream) events.push(event);

		expect(providerCalls).toBe(2);
		expect(events.at(-1)).toMatchObject({ type: "agent_end", terminationReason: "max_iterations" });
	});

	it("detects a dead loop when progress remains unchanged", () => {
		const guard = createAgentLoopConvergenceGuard({ maxIterations: 10, maxNoProgressIterations: 2 });
		guard.beforeTurn();
		expect(guard.observe({ progressToken: "same", madeProgress: false }).stop).toBe(false);
		guard.beforeTurn();
		expect(guard.observe({ progressToken: "same", madeProgress: false })).toMatchObject({
			stop: true,
			reason: "dead_loop",
		});
	});
});

describe("Agent operation deadline", () => {
	it("aborts a stalled provider stream and forwards the same signal", async () => {
		let providerSignal: AbortSignal | undefined;
		const agent = new Agent({
			deadlineMs: 10,
			streamFn: (_model, _context, options) => {
				providerSignal = options?.signal;
				return new MockAssistantStream();
			},
		});

		await agent.prompt("deadline");

		expect(providerSignal?.aborted).toBe(true);
		expect(agent.state.errorMessage).toContain("deadline");
		const lastMessage = agent.state.messages.at(-1);
		expect(lastMessage?.role).toBe("assistant");
		if (lastMessage?.role === "assistant") expect(lastMessage.stopReason).toBe("aborted");
	});
});
