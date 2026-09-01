import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";

const bedrockMock = vi.hoisted(() => ({
	constructorCalls: [] as Array<Record<string, unknown>>,
	streamEvents: undefined as unknown[] | undefined,
}));

vi.mock("@aws-sdk/client-bedrock-runtime", () => {
	class BedrockRuntimeServiceException extends Error {}

	class BedrockRuntimeClient {
		constructor(config: Record<string, unknown>) {
			bedrockMock.constructorCalls.push(config);
		}

		send(): Promise<unknown> {
			if (bedrockMock.streamEvents) {
				const events = bedrockMock.streamEvents;
				return Promise.resolve({
					$metadata: { httpStatusCode: 200 },
					stream: (async function* () {
						yield* events;
					})(),
				});
			}
			return Promise.reject(new Error("mock send"));
		}
	}

	class ConverseStreamCommand {
		readonly input: unknown;

		constructor(input: unknown) {
			this.input = input;
		}
	}

	return {
		BedrockRuntimeClient,
		BedrockRuntimeServiceException,
		ConverseStreamCommand,
		StopReason: {
			END_TURN: "end_turn",
			STOP_SEQUENCE: "stop_sequence",
			MAX_TOKENS: "max_tokens",
			MODEL_CONTEXT_WINDOW_EXCEEDED: "model_context_window_exceeded",
			TOOL_USE: "tool_use",
		},
		CachePointType: { DEFAULT: "default" },
		CacheTTL: { ONE_HOUR: "ONE_HOUR" },
		ConversationRole: { ASSISTANT: "assistant", USER: "user" },
		ImageFormat: { JPEG: "jpeg", PNG: "png", GIF: "gif", WEBP: "webp" },
		ToolResultStatus: { ERROR: "error", SUCCESS: "success" },
	};
});

import { stream as streamBedrock } from "../src/api/bedrock-converse-stream.ts";
import { getModel } from "../src/compat.ts";
import type { Context, Message } from "../src/types.ts";

const baseModel = getModel("amazon-bedrock", "us.anthropic.claude-sonnet-4-5-20250929-v1:0");

async function capturePayload(context: Context, model = baseModel): Promise<unknown> {
	let capturedPayload: unknown;
	const s = streamBedrock(model, context, {
		cacheRetention: "none",
		signal: AbortSignal.abort(),
		onPayload: (payload) => {
			capturedPayload = payload;
			return payload;
		},
	});
	for await (const event of s) {
		if (event.type === "error") break;
	}
	return capturedPayload;
}

describe("Bedrock constrained sampling", () => {
	it("gates native strict tool use by model capability", async () => {
		const context: Context = {
			messages: [{ role: "user", content: "Use the tool", timestamp: Date.now() }],
			tools: [
				{
					name: "lookup",
					description: "Look up a value",
					parameters: Type.Object({ value: Type.String() }),
					constrainedSampling: { type: "json_schema", strict: "require" },
				},
			],
		};
		const payload = await capturePayload(context);
		const toolConfig = (payload as { toolConfig: { tools: Array<{ toolSpec: { strict?: boolean } }> } }).toolConfig;
		expect(toolConfig.tools[0].toolSpec.strict).toBe(true);

		context.tools![0].constrainedSampling = { type: "json_schema", strict: "prefer" };
		const novaPayload = await capturePayload(context, getModel("amazon-bedrock", "amazon.nova-lite-v1:0"));
		const novaToolConfig = (
			novaPayload as {
				toolConfig: { tools: Array<{ toolSpec: { strict?: boolean } }> };
			}
		).toolConfig;
		expect(novaToolConfig.tools[0].toolSpec.strict).toBeUndefined();
	});
});

describe("Bedrock redacted reasoning", () => {
	it("persists streamed bytes and replays them as redactedContent", async () => {
		const encrypted = new Uint8Array([1, 2, 3, 4]);
		bedrockMock.streamEvents = [
			{ messageStart: { role: "assistant" } },
			{
				contentBlockDelta: {
					contentBlockIndex: 0,
					delta: { reasoningContent: { redactedContent: encrypted } },
				},
			},
			{ contentBlockStop: { contentBlockIndex: 0 } },
			{ messageStop: { stopReason: "end_turn" } },
		];
		try {
			const message = await streamBedrock(
				baseModel,
				{ messages: [{ role: "user", content: "think", timestamp: Date.now() }] },
				{ cacheRetention: "none" },
			).result();
			const thinking = message.content.find((block) => block.type === "thinking");
			expect(thinking).toMatchObject({
				type: "thinking",
				thinking: "[Reasoning redacted]",
				thinkingSignature: "AQIDBA==",
				redacted: true,
			});

			const payload = await capturePayload({ messages: [message, { role: "user", content: "continue", timestamp: Date.now() }] });
			const replay = (payload as {
				messages: Array<{ content: Array<{ reasoningContent?: { redactedContent?: Uint8Array } }> }>;
			}).messages[0].content[0].reasoningContent?.redactedContent;
			expect(replay).toEqual(encrypted);
		} finally {
			bedrockMock.streamEvents = undefined;
		}
	});
});

describe("bedrock convertMessages skips unknown content types", () => {
	it("skips unknown user content blocks instead of throwing", async () => {
		const messages: Message[] = [
			{
				role: "user",
				content: [
					{ type: "text", text: "hello" },
					{ type: "unknown", data: "foo" },
				] as any,
				timestamp: Date.now(),
			},
		];
		const payload = await capturePayload({ messages });
		expect(payload).toBeDefined();
		const p = payload as { messages: Array<{ role: string; content: unknown[] }> };
		expect(p.messages).toHaveLength(1);
		expect(p.messages[0].content).toHaveLength(1);
		expect(p.messages[0].content[0]).toEqual({ text: "hello" });
	});

	it("skips unknown assistant content blocks instead of throwing", async () => {
		const messages: Message[] = [
			{
				role: "assistant",
				content: [
					{ type: "text", text: "hello" },
					{ type: "unknown", data: "foo" },
				] as any,
				api: "bedrock-converse-stream",
				provider: "amazon-bedrock",
				model: baseModel.id,
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
			},
		];
		const payload = await capturePayload({ messages });
		expect(payload).toBeDefined();
		const p = payload as { messages: Array<{ role: string; content: unknown[] }> };
		expect(p.messages).toHaveLength(1);
		expect(p.messages[0].content).toHaveLength(1);
		expect(p.messages[0].content[0]).toEqual({ text: "hello" });
	});

	it("replaces user messages with only unknown content blocks with a placeholder", async () => {
		const messages: Message[] = [
			{
				role: "user",
				content: [{ type: "unknown", data: "foo" }] as any,
				timestamp: Date.now(),
			},
		];
		const payload = await capturePayload({ messages });
		expect(payload).toBeDefined();
		const p = payload as { messages: Array<{ role: string; content: unknown[] }> };
		expect(p.messages).toHaveLength(1);
		expect(p.messages[0].content).toEqual([{ text: "<empty>" }]);
	});

	it("replaces blank user string content with a placeholder", async () => {
		const payload = await capturePayload({
			messages: [{ role: "user", content: "   ", timestamp: Date.now() }],
		});
		expect(payload).toBeDefined();
		const p = payload as { messages: Array<{ role: string; content: unknown[] }> };
		expect(p.messages).toHaveLength(1);
		expect(p.messages[0].content).toEqual([{ text: "<empty>" }]);
	});

	it("filters blank user text blocks when other content remains", async () => {
		const payload = await capturePayload({
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "" },
						{ type: "text", text: "hello" },
					],
					timestamp: Date.now(),
				},
			],
		});
		expect(payload).toBeDefined();
		const p = payload as { messages: Array<{ role: string; content: unknown[] }> };
		expect(p.messages).toHaveLength(1);
		expect(p.messages[0].content).toEqual([{ text: "hello" }]);
	});

	it("replaces user content emptied by surrogate sanitization with a placeholder", async () => {
		const payload = await capturePayload({
			messages: [{ role: "user", content: String.fromCharCode(0xd83d), timestamp: Date.now() }],
		});
		expect(payload).toBeDefined();
		const p = payload as { messages: Array<{ role: string; content: unknown[] }> };
		expect(p.messages).toHaveLength(1);
		expect(p.messages[0].content).toEqual([{ text: "<empty>" }]);
	});

	it("skips assistant text blocks emptied by surrogate sanitization", async () => {
		const messages: Message[] = [
			{
				role: "assistant",
				content: [{ type: "text", text: String.fromCharCode(0xd83d) }],
				api: "bedrock-converse-stream",
				provider: "amazon-bedrock",
				model: baseModel.id,
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
			},
		];
		const payload = await capturePayload({ messages });
		expect(payload).toBeDefined();
		const p = payload as { messages: Array<{ role: string; content: unknown[] }> };
		expect(p.messages).toHaveLength(0);
	});

	it("replaces blank tool result content with a placeholder", async () => {
		const messages: Message[] = [
			{
				role: "toolResult",
				toolCallId: "tool-1",
				toolName: "tool",
				content: [{ type: "text", text: "" }],
				isError: false,
				timestamp: Date.now(),
			},
		];
		const payload = await capturePayload({ messages });
		expect(payload).toBeDefined();
		const p = payload as {
			messages: Array<{ role: string; content: Array<{ toolResult: { content: unknown[] } }> }>;
		};
		expect(p.messages).toHaveLength(1);
		expect(p.messages[0].content[0].toolResult.content).toEqual([{ text: "<empty>" }]);
	});

	it("skips assistant messages with only unknown content blocks", async () => {
		const messages: Message[] = [
			{
				role: "assistant",
				content: [{ type: "unknown", data: "foo" }] as any,
				api: "bedrock-converse-stream",
				provider: "amazon-bedrock",
				model: baseModel.id,
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
			},
		];
		const payload = await capturePayload({ messages });
		expect(payload).toBeDefined();
		const p = payload as { messages: Array<{ role: string; content: unknown[] }> };
		expect(p.messages).toHaveLength(0);
	});

	it("removes empty keys from replayed tool arguments without mutating history", async () => {
		const argumentsWithEmptyKey = {
			path: "/workspace/file.js",
			edits: [{ oldText: "before", newText: "after", "": "" }],
		};
		const messages: Message[] = [
			{
				role: "assistant",
				content: [{ type: "toolCall", id: "tool-1", name: "edit", arguments: argumentsWithEmptyKey }],
				api: "bedrock-converse-stream",
				provider: "amazon-bedrock",
				model: baseModel.id,
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: Date.now(),
			},
			{
				role: "toolResult",
				toolCallId: "tool-1",
				toolName: "edit",
				content: [{ type: "text", text: "done" }],
				isError: false,
				timestamp: Date.now(),
			},
		];

		const payload = await capturePayload({ messages });
		const input = (payload as {
			messages: Array<{ content: Array<{ toolUse?: { input: unknown } }> }>;
		}).messages[0].content[0].toolUse?.input;
		expect(input).toEqual({ path: "/workspace/file.js", edits: [{ oldText: "before", newText: "after" }] });
		expect(argumentsWithEmptyKey.edits[0]).toEqual({ oldText: "before", newText: "after", "": "" });
	});
});
