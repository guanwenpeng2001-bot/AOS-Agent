import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	type Message,
	type Model,
} from "@aos-agent/ai";
import { describe, expect, it } from "vitest";
import {
	AgentDeadlineExceeded,
	AGENT_LOOP_ERROR_CATEGORIES,
	agentLoop,
	classifyAgentLoopError,
	decideAgentLoopRetry,
} from "../src/index.ts";
import type { AgentContext, AgentEvent, AgentLoopConfig, AgentTool } from "../src/types.ts";
import { Type } from "typebox";

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected assistant event");
			},
		);
	}
}

function createModel(): Model<"openai-responses"> {
	return {
		id: "error-test",
		name: "error-test",
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
	errorMessage?: string,
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "error-test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		...(errorMessage === undefined ? {} : { errorMessage }),
		timestamp: Date.now(),
	};
}

function identityConverter(messages: Parameters<AgentLoopConfig["convertToLlm"]>[0]): Message[] {
	return messages.filter(
		(message) => message.role === "user" || message.role === "assistant" || message.role === "toolResult",
	) as Message[];
}

function errorStream(message: AssistantMessage): MockAssistantStream {
	const stream = new MockAssistantStream();
	queueMicrotask(() => stream.push({ type: "error", reason: message.stopReason === "aborted" ? "aborted" : "error", error: message }));
	return stream;
}

describe("production agent-loop error classification", () => {
	it("matches the remote operation categories and keeps retry metadata safe", () => {
		expect(AGENT_LOOP_ERROR_CATEGORIES).toEqual([
			"transient_provider",
			"permission_or_parameter",
			"side_effect_unknown",
			"cancelled",
			"deadline",
		]);

		const policy = { enabled: true, maxRetries: 2, baseDelayMs: 1 };
		const transient = classifyAgentLoopError(Object.assign(new Error("service unavailable"), { status: 503 }));
		expect(transient).toMatchObject({ category: "transient_provider", retryable: true, safeToRetry: true });
		expect(decideAgentLoopRetry(transient, { policy, retriesUsed: 0 })).toMatchObject({ retry: true });

		const permission = classifyAgentLoopError(Object.assign(new Error("permission denied"), { status: 403 }));
		expect(decideAgentLoopRetry(permission, { policy, retriesUsed: 0 })).toMatchObject({
			retry: false,
			reason: "permission_or_parameter",
		});

		const parameter = classifyAgentLoopError(Object.assign(new Error("invalid parameter"), { status: 400 }));
		expect(decideAgentLoopRetry(parameter, { policy, retriesUsed: 0 })).toMatchObject({
			retry: false,
			reason: "permission_or_parameter",
		});

		const sideEffectUnknown = classifyAgentLoopError(
			Object.assign(new Error("timeout after dispatch"), {
				category: "transient_provider",
				sideEffect: "unknown",
			}),
		);
		expect(decideAgentLoopRetry(sideEffectUnknown, { policy, retriesUsed: 0 })).toMatchObject({
			retry: false,
			reason: "side_effect_unknown",
		});
		const structuredSideEffectUnknown = classifyAgentLoopError({ category: "side_effect_unknown", code: "side_effect_unknown" });
		expect(structuredSideEffectUnknown).toMatchObject({ category: "side_effect_unknown", sideEffect: "unknown", retryable: false });

		const cancellationController = new AbortController();
		cancellationController.abort(new Error("caller cancelled"));
		const cancelled = classifyAgentLoopError(new Error("request stopped"), { signal: cancellationController.signal });
		expect(cancelled).toMatchObject({ category: "cancelled", retryable: false });
		const transientCancelled = classifyAgentLoopError(Object.assign(new Error("service unavailable"), { category: "transient_provider" }), {
			signal: cancellationController.signal,
		});
		expect(transientCancelled.category).toBe("cancelled");
		expect(decideAgentLoopRetry(cancelled, { policy, retriesUsed: 0, signal: cancellationController.signal })).toMatchObject({
			retry: false,
			reason: "cancelled",
		});

		const deadline = classifyAgentLoopError(new AgentDeadlineExceeded(100));
		expect(deadline).toMatchObject({ category: "deadline", retryable: false });
		expect(JSON.stringify(classifyAgentLoopError(new Error("token=secret /tmp/private")))).not.toContain("secret");
	});

	it("retries a pre-output transient failure without exposing or duplicating the failed attempt", async () => {
		let providerCalls = 0;
		const retryEvents: string[] = [];
		const config: AgentLoopConfig = {
			model: createModel(),
			convertToLlm: identityConverter,
			retry: { enabled: true, maxRetries: 1, baseDelayMs: 0 },
			retryCallbacks: {
				onRetryScheduled: (_attempt, _max, _delay, message) => {
					retryEvents.push(`scheduled:${message}`);
				},
				onRetryAttemptStart: () => {
					retryEvents.push("start");
				},
				onRetryFinished: (success) => {
					retryEvents.push(`finished:${success}`);
				},
			},
		};
		const stream = agentLoop(
			[{ role: "user", content: "retry", timestamp: Date.now() }],
			{ systemPrompt: "", messages: [], tools: [] } satisfies AgentContext,
			config,
			undefined,
			() => {
				providerCalls += 1;
				if (providerCalls === 1) return errorStream(createAssistantMessage([], "error", "service unavailable"));
				const response = new MockAssistantStream();
				queueMicrotask(() => response.push({ type: "done", reason: "stop", message: createAssistantMessage([{ type: "text", text: "recovered" }]) }));
				return response;
			},
		);
		const events: AgentEvent[] = [];
		for await (const event of stream) events.push(event);

		expect(providerCalls).toBe(2);
		expect(retryEvents).toEqual(["scheduled:The provider failed transiently.", "start", "finished:true"]);
		expect((await stream.result()).map((message) => message.role)).toEqual(["user", "assistant"]);
		expect(events.filter((event) => event.type === "message_end").map((event) => event.message)).toHaveLength(2);
		expect(JSON.stringify(events)).not.toContain("service unavailable");
	});

	it("terminates permission and parameter failures without retrying", async () => {
		for (const failure of [
			{ status: 403, text: "permission denied" },
			{ status: 400, text: "invalid parameter" },
		]) {
			let providerCalls = 0;
			const stream = agentLoop(
				[{ role: "user", content: "reject", timestamp: Date.now() }],
				{ systemPrompt: "", messages: [], tools: [] } satisfies AgentContext,
				{ model: createModel(), convertToLlm: identityConverter, retry: { enabled: true, maxRetries: 2, baseDelayMs: 0 } },
				undefined,
				() => {
					providerCalls += 1;
					return errorStream(createAssistantMessage([], "error", `${failure.status} ${failure.text}`));
				},
			);
			for await (const _event of stream) {
				// consume
			}
			expect(providerCalls).toBe(1);
			expect((await stream.result()).at(-1)).toMatchObject({
				stopReason: "error",
				errorMessage: "The operation was rejected by permission or parameter validation.",
			});
		}
	});

	it("does not retry after visible output, preventing duplicate output and side effects", async () => {
		let providerCalls = 0;
		const stream = agentLoop(
			[{ role: "user", content: "visible", timestamp: Date.now() }],
			{ systemPrompt: "", messages: [], tools: [] } satisfies AgentContext,
			{
				model: createModel(),
				convertToLlm: identityConverter,
				retry: { enabled: true, maxRetries: 2, baseDelayMs: 0 },
			},
			undefined,
			() => {
				providerCalls += 1;
				const response = new MockAssistantStream();
				const partial = createAssistantMessage([{ type: "text", text: "partial" }], "stop");
				queueMicrotask(() => {
					response.push({ type: "start", partial: createAssistantMessage([], "toolUse") });
					response.push({ type: "text_delta", contentIndex: 0, delta: "partial", partial });
					response.push({
						type: "error",
						reason: "error",
						error: createAssistantMessage([], "error", "timeout after dispatch"),
					});
				});
				return response;
			},
		);
		const events: AgentEvent[] = [];
		for await (const event of stream) events.push(event);

		expect(providerCalls).toBe(1);
		const updates = events.filter((event) => event.type === "message_update");
		expect(updates).toHaveLength(1);
		expect(JSON.stringify(events)).toContain("partial");
		expect(JSON.stringify(events)).not.toContain("timeout after dispatch");
		expect((await stream.result()).at(-1)).toMatchObject({ stopReason: "error", errorMessage: "The operation outcome is unknown after a possible side effect." });
	});

	it("treats cancellation and deadline as terminal before invoking a provider", async () => {
		for (const [reason, message] of [
			[new Error("cancelled"), "The operation was cancelled."],
			[new AgentDeadlineExceeded(100), "The operation exceeded its deadline."],
		] as const) {
			const controller = new AbortController();
			controller.abort(reason);
			let calls = 0;
			const stream = agentLoop(
				[{ role: "user", content: "stop", timestamp: Date.now() }],
				{ systemPrompt: "", messages: [], tools: [] } satisfies AgentContext,
				{ model: createModel(), convertToLlm: identityConverter, retry: { enabled: true, maxRetries: 2, baseDelayMs: 0 } },
				controller.signal,
				() => {
					calls += 1;
					return errorStream(createAssistantMessage([], "error", "unexpected provider call"));
				},
			);
			for await (const _event of stream) {
				// consume
			}
			const finalMessage = (await stream.result()).at(-1);
			expect(calls).toBe(0);
			expect(finalMessage?.role).toBe("assistant");
			if (finalMessage?.role === "assistant") {
				expect(finalMessage).toMatchObject({ stopReason: "aborted", errorMessage: message });
			}
		}
	});

	it("redacts unknown thrown provider details in terminal output", async () => {
		const stream = agentLoop(
			[{ role: "user", content: "redact", timestamp: Date.now() }],
			{ systemPrompt: "", messages: [], tools: [] } satisfies AgentContext,
			{ model: createModel(), convertToLlm: identityConverter },
			undefined,
			() => {
				throw new Error("provider exploded token=secret https://secret.invalid/path");
			},
		);
		for await (const _event of stream) {
			// consume
		}
		const finalMessage = (await stream.result()).at(-1);
		expect(finalMessage).toMatchObject({ stopReason: "error" });
		if (finalMessage?.role === "assistant") {
			expect(finalMessage.errorMessage).toContain("provider exploded");
			expect(finalMessage.errorMessage).not.toContain("secret");
		}
	});

	it("classifies and redacts thrown tool boundary failures", async () => {
		const toolSchema = Type.Object({ value: Type.String() });
		let providerCalls = 0;
		let toolCalls = 0;
		const tool: AgentTool<typeof toolSchema> = {
			name: "mcp__docs__fetch",
			label: "Fetch documentation",
			description: "Fetch documentation",
			parameters: toolSchema,
			execute: async () => {
				toolCalls += 1;
				throw new Error("tool exploded token=secret https://secret.invalid/path /tmp/private");
			},
		};
		const stream = agentLoop(
			[{ role: "user", content: "fetch docs", timestamp: Date.now() }],
			{ systemPrompt: "", messages: [], tools: [tool] } satisfies AgentContext,
			{ model: createModel(), convertToLlm: identityConverter },
			undefined,
			() => {
				providerCalls += 1;
				const response = new MockAssistantStream();
				queueMicrotask(() => {
					const message =
						providerCalls === 1
							? createAssistantMessage(
									[{ type: "toolCall", id: "tool-1", name: tool.name, arguments: { value: "guide" } }],
									"toolUse",
								)
							: createAssistantMessage([{ type: "text", text: "done" }]);
					response.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message });
				});
				return response;
			},
		);
		const events: AgentEvent[] = [];
		for await (const event of stream) events.push(event);

		const toolResult = (await stream.result()).find((message) => message.role === "toolResult");
		expect(providerCalls).toBe(2);
		expect(toolCalls).toBe(1);
		expect(toolResult?.role === "toolResult" ? toolResult.isError : false).toBe(true);
		expect(toolResult?.role === "toolResult" ? toolResult.content : []).toContainEqual({
			type: "text",
			text: "The operation outcome is unknown after a possible side effect.",
		});
		expect(JSON.stringify(events)).not.toContain("secret");
		expect(JSON.stringify(events)).not.toContain("secret.invalid");
		expect(JSON.stringify(events)).not.toContain("/tmp/private");
	});
});
