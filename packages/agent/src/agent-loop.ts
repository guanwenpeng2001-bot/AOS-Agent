/**
 * Agent loop that works with AgentMessage throughout.
 * Transforms to Message[] only at the LLM call boundary.
 */

import {
	type AssistantMessage,
	type Context,
	EventStream,
	type ToolResultMessage,
	validateToolArguments,
} from "@aos-agent/ai";
import { getDefaultStreamFn } from "./stream-fn.ts";
import {
	createAgentLoopConvergenceGuard,
	fingerprintAgentTurn,
} from "./loop-convergence.ts";
import {
	classifyAgentLoopError,
	decideAgentLoopRetry,
	getAgentLoopErrorMessage,
	redactedThrownAgentError,
	type AgentLoopErrorClassification,
} from "./agent-errors.ts";
import { raceWithAbortSignal } from "./operation-signal.ts";
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentMessage,
	AgentTool,
	AgentToolCall,
	AgentToolResult,
	StreamFn,
} from "./types.ts";

export type AgentEventSink = (event: AgentEvent) => Promise<void> | void;

/**
 * Start an agent loop with a new prompt message.
 * The prompt is added to the context and events are emitted for it.
 */
export function agentLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	streamFn: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
	const stream = createAgentStream();

	void runAgentLoop(
		prompts,
		context,
		config,
		async (event) => {
			stream.push(event);
		},
		signal,
		streamFn,
	).then(
		(messages) => stream.end(messages),
		(error: unknown) => {
			const failure = createFailureMessage(config, error, signal);
			stream.push({ type: "message_start", message: failure });
			stream.push({ type: "message_end", message: failure });
			stream.push({ type: "turn_end", message: failure, toolResults: [] });
			stream.push({ type: "agent_end", messages: [...prompts, failure] });
			stream.end([...prompts, failure]);
		},
	);

	return stream;
}

/**
 * Continue an agent loop from the current context without adding a new message.
 * Used for retries - context already has user message or tool results.
 *
 * **Important:** The last message in context must convert to a `user` or `toolResult` message
 * via `convertToLlm`. If it doesn't, the LLM provider will reject the request.
 * This cannot be validated here since `convertToLlm` is only called once per turn.
 */
export function agentLoopContinue(
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	streamFn: StreamFn,
): EventStream<AgentEvent, AgentMessage[]> {
	if (context.messages.length === 0) {
		throw new Error("Cannot continue: no messages in context");
	}

	if (context.messages[context.messages.length - 1].role === "assistant") {
		throw new Error("Cannot continue from message role: assistant");
	}

	const stream = createAgentStream();

	void runAgentLoopContinue(
		context,
		config,
		async (event) => {
			stream.push(event);
		},
		signal,
		streamFn,
	).then(
		(messages) => stream.end(messages),
		(error: unknown) => {
			const failure = createFailureMessage(config, error, signal);
			stream.push({ type: "message_start", message: failure });
			stream.push({ type: "message_end", message: failure });
			stream.push({ type: "turn_end", message: failure, toolResults: [] });
			stream.push({ type: "agent_end", messages: [failure] });
			stream.end([failure]);
		},
	);

	return stream;
}

export async function runAgentLoop(
	prompts: AgentMessage[],
	context: AgentContext,
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal: AbortSignal | undefined,
	streamFn: StreamFn,
): Promise<AgentMessage[]> {
	const newMessages: AgentMessage[] = [...prompts];
	const currentContext: AgentContext = {
		...context,
		messages: [...context.messages, ...prompts],
	};

	await emit({ type: "agent_start" });
	await emit({ type: "turn_start" });
	for (const prompt of prompts) {
		await emit({ type: "message_start", message: prompt });
		await emit({ type: "message_end", message: prompt });
	}

	await runLoop(currentContext, newMessages, config, signal, emit, streamFn ?? getDefaultStreamFn());
	return newMessages;
}

export async function runAgentLoopContinue(
	context: AgentContext,
	config: AgentLoopConfig,
	emit: AgentEventSink,
	signal: AbortSignal | undefined,
	streamFn: StreamFn,
): Promise<AgentMessage[]> {
	if (context.messages.length === 0) {
		throw new Error("Cannot continue: no messages in context");
	}

	if (context.messages[context.messages.length - 1].role === "assistant") {
		throw new Error("Cannot continue from message role: assistant");
	}

	const newMessages: AgentMessage[] = [];
	const currentContext: AgentContext = { ...context };

	await emit({ type: "agent_start" });
	await emit({ type: "turn_start" });

	await runLoop(currentContext, newMessages, config, signal, emit, streamFn ?? getDefaultStreamFn());
	return newMessages;
}

function createAgentStream(): EventStream<AgentEvent, AgentMessage[]> {
	return new EventStream<AgentEvent, AgentMessage[]>(
		(event: AgentEvent) => event.type === "agent_end",
		(event: AgentEvent) => (event.type === "agent_end" ? event.messages : []),
	);
}

function createFailureMessage(
	config: AgentLoopConfig,
	error: unknown,
	signal: AbortSignal | undefined,
): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "" }],
		api: config.model.api,
		provider: config.model.provider,
		model: config.model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: signal?.aborted ? "aborted" : "error",
		errorMessage: redactedThrownAgentError(error),
		timestamp: Date.now(),
	};
}

function createClassifiedFailureMessage(
	config: AgentLoopConfig,
	classification: AgentLoopErrorClassification,
): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "" }],
		api: config.model.api,
		provider: config.model.provider,
		model: config.model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: classification.category === "cancelled" || classification.category === "deadline" ? "aborted" : "error",
		errorMessage: getAgentLoopErrorMessage(classification),
		timestamp: Date.now(),
	};
}

/**
 * Main loop logic shared by agentLoop and agentLoopContinue.
 */
async function runLoop(
	initialContext: AgentContext,
	newMessages: AgentMessage[],
	initialConfig: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	streamFunction: StreamFn,
): Promise<void> {
	let currentContext = initialContext;
	let config = initialConfig;
	const convergence = createAgentLoopConvergenceGuard(initialConfig.loopConvergence);
	let firstTurn = true;
	// Check for steering messages at start (user may have typed while waiting)
	let pendingMessages: AgentMessage[] = (await config.getSteeringMessages?.()) || [];

	// Outer loop: continues when queued follow-up messages arrive after agent would stop
	while (true) {
		let hasMoreToolCalls = true;

		// Inner loop: process tool calls and steering messages
		while (hasMoreToolCalls || pendingMessages.length > 0) {
			const turnDecision = convergence.beforeTurn();
			if (turnDecision.stop) {
				await emit({ type: "agent_end", messages: newMessages, terminationReason: turnDecision.reason });
				return;
			}
			if (!firstTurn) {
				await emit({ type: "turn_start" });
			} else {
				firstTurn = false;
			}

			// Process pending messages (inject before next assistant response)
			if (pendingMessages.length > 0) {
				for (const message of pendingMessages) {
					await emit({ type: "message_start", message });
					await emit({ type: "message_end", message });
					currentContext.messages.push(message);
					newMessages.push(message);
				}
				pendingMessages = [];
			}

			// Stream assistant response
			const message = await streamAssistantResponse(currentContext, config, signal, emit, streamFunction);
			newMessages.push(message);

			if (message.stopReason === "error" || message.stopReason === "aborted") {
				await emit({ type: "turn_end", message, toolResults: [] });
				await emit({ type: "agent_end", messages: newMessages });
				return;
			}

			// Check for tool calls
			const toolCalls = message.content.filter((c) => c.type === "toolCall");

			const toolResults: ToolResultMessage[] = [];
			hasMoreToolCalls = false;
			if (toolCalls.length > 0) {
				// A "length" stop means the output was cut off by the token limit, so
				// every tool call in the message may carry truncated arguments. Fail
				// them all instead of executing potentially borked calls.
				const executedToolBatch =
					message.stopReason === "length"
						? await failToolCallsFromTruncatedMessage(toolCalls, emit)
						: await executeToolCalls(currentContext, message, config, signal, emit);
				toolResults.push(...executedToolBatch.messages);
				hasMoreToolCalls = !executedToolBatch.terminate;

				for (const result of toolResults) {
					currentContext.messages.push(result);
					newMessages.push(result);
				}
			}

			await emit({ type: "turn_end", message, toolResults });

			const convergenceDecision = convergence.observe({
				toolCalls: toolCalls.map((toolCall) => ({ name: toolCall.name, arguments: toolCall.arguments })),
				progressToken: fingerprintAgentTurn(message, toolResults),
				madeProgress: toolCalls.length === 0 || toolResults.some((result) => result.isError !== true),
			});
			if (convergenceDecision.stop) {
				await emit({
					type: "agent_end",
					messages: newMessages,
					terminationReason: convergenceDecision.reason,
				});
				return;
			}

			const nextTurnContext = {
				message,
				toolResults,
				context: currentContext,
				newMessages,
			};
			const nextTurnSnapshot = await raceWithAbortSignal(
				Promise.resolve(config.prepareNextTurn?.(nextTurnContext)),
				signal,
			);
			if (nextTurnSnapshot) {
				currentContext = nextTurnSnapshot.context ?? currentContext;
				config = {
					...config,
					model: nextTurnSnapshot.model ?? config.model,
					reasoning:
						nextTurnSnapshot.thinkingLevel === undefined
							? config.reasoning
							: nextTurnSnapshot.thinkingLevel === "off"
								? undefined
								: nextTurnSnapshot.thinkingLevel,
				};
			}

			if (
				await raceWithAbortSignal(
					Promise.resolve(
						config.shouldStopAfterTurn?.({
					message,
					toolResults,
					context: currentContext,
					newMessages,
						}),
					),
					signal,
				)
			) {
				await emit({ type: "agent_end", messages: newMessages });
				return;
			}

			pendingMessages =
				(await raceWithAbortSignal(Promise.resolve(config.getSteeringMessages?.()), signal)) || [];
		}

		// Agent would stop here. Check for follow-up messages.
		const followUpMessages = (await raceWithAbortSignal(Promise.resolve(config.getFollowUpMessages?.()), signal)) || [];
		if (followUpMessages.length > 0) {
			// Set as pending so inner loop processes them
			pendingMessages = followUpMessages;
			continue;
		}

		// No more messages, exit
		break;
	}

	await emit({ type: "agent_end", messages: newMessages });
}

class AttemptEventBuffer {
	private readonly emit: AgentEventSink;
	private pending: AgentEvent[] = [];
	private assistantStarted = false;
	public hasVisibleOutput = false;

	constructor(emit: AgentEventSink) {
		this.emit = emit;
	}

	async push(event: AgentEvent): Promise<void> {
		if (event.type === "message_start" && event.message.role === "assistant") {
			this.assistantStarted = true;
		}
		if (this.hasVisibleOutput) {
			await this.emit(event);
			return;
		}
		this.pending.push(event);
		if (eventHasVisibleOutput(event)) {
			this.hasVisibleOutput = true;
			await this.flush();
		}
	}

	async finishFailure(message: AssistantMessage): Promise<void> {
		if (this.hasVisibleOutput || this.assistantStarted) {
			await this.push({ type: "message_end", message });
			return;
		}
		await this.push({ type: "message_start", message });
		await this.push({ type: "message_end", message });
	}

	async flush(): Promise<void> {
		const pending = this.pending;
		this.pending = [];
		for (const event of pending) await this.emit(event);
	}

	discard(): void {
		this.pending = [];
	}
}

function eventHasVisibleOutput(event: AgentEvent): boolean {
	if (event.type !== "message_start" && event.type !== "message_end" && event.type !== "message_update") return false;
	if (event.message.role !== "assistant") return false;
	return event.message.content.some((content) => {
		if (content.type === "text") return content.text.length > 0;
		if (content.type === "thinking") return content.thinking.length > 0;
		return true;
	});
}

function isWrappedTransportCancellation(message: AssistantMessage): boolean {
	return /pending stream has been cancell?ed.*(?:getaddrinfo|enotfound)/i.test(message.errorMessage ?? "");
}

type StreamAssistantAttempt = {
	message: AssistantMessage;
	classification?: AgentLoopErrorClassification;
	visibleOutput: boolean;
};

/**
 * Stream an assistant response from the LLM, retrying only before any output
 * or other observable attempt side effect has been emitted.
 */
async function streamAssistantResponse(
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
	streamFunction: StreamFn,
): Promise<AssistantMessage> {
	const policy = config.retry;
	let retriesUsed = 0;

	for (;;) {
		const attemptEvents = new AttemptEventBuffer(emit);
		let attempt: StreamAssistantAttempt;
		try {
			attempt = await streamAssistantResponseAttempt(context, config, signal, streamFunction, attemptEvents);
		} catch (error) {
			const classification = classifyAgentLoopError(error, {
				operation: "model",
				phase: "request",
				signal,
				sideEffect: attemptEvents.hasVisibleOutput ? "unknown" : "none",
			});
			const message =
				classification.category === "unknown"
					? createFailureMessage(config, error, signal)
					: createClassifiedFailureMessage(config, classification);
			await attemptEvents.finishFailure(message);
			attempt = { message, classification, visibleOutput: attemptEvents.hasVisibleOutput };
		}

		if (attempt.message.stopReason !== "error" && attempt.message.stopReason !== "aborted") {
			await attemptEvents.flush();
			if (retriesUsed > 0) await config.retryCallbacks?.onRetryFinished?.(true, retriesUsed);
			context.messages.push(attempt.message);
			return attempt.message;
		}

		const classification =
			attempt.classification ??
			classifyAgentLoopError(attempt.message, {
				operation: "model",
				phase: "request",
				signal,
				sideEffect: attempt.visibleOutput ? "unknown" : "none",
			});
		const decision = decideAgentLoopRetry(classification, {
			policy,
			retriesUsed,
			signal,
			sideEffect: attempt.visibleOutput ? "unknown" : "none",
		});
		if (!decision.retry) {
			await attemptEvents.flush();
			if (retriesUsed > 0) {
				await config.retryCallbacks?.onRetryFinished?.(false, retriesUsed, classification.message);
			}
			context.messages.push(attempt.message);
			return attempt.message;
		}

		retriesUsed += 1;
		const delayMs = retryDelayMs(policy, retriesUsed);
		await config.retryCallbacks?.onRetryScheduled?.(
			retriesUsed,
			policy?.maxRetries ?? retriesUsed,
			delayMs,
			classification.message,
		);
		attemptEvents.discard();
		try {
			await waitForRetry(delayMs, signal);
		} catch (error) {
			const abortedClassification = classifyAgentLoopError(error, { signal });
			const abortedMessage = createClassifiedFailureMessage(config, abortedClassification);
			const abortedEvents = new AttemptEventBuffer(emit);
			await abortedEvents.finishFailure(abortedMessage);
			await abortedEvents.flush();
			await config.retryCallbacks?.onRetryFinished?.(false, retriesUsed, abortedClassification.message);
			context.messages.push(abortedMessage);
			return abortedMessage;
		}
		await config.retryCallbacks?.onRetryAttemptStart?.();
	}
}

function retryDelayMs(policy: AgentLoopConfig["retry"], retryAttempt: number): number {
	if (!policy) return 0;
	const delay = policy.baseDelayMs * 2 ** (retryAttempt - 1);
	return Number.isFinite(delay) ? Math.max(0, delay) : 0;
}

function waitForRetry(delayMs: number, signal: AbortSignal | undefined): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		if (signal?.aborted) {
			reject(signal.reason ?? new Error("The Agent operation was aborted"));
			return;
		}
		let timer: ReturnType<typeof setTimeout> | undefined;
		const onAbort = () => {
			if (timer !== undefined) clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			reject(signal?.reason ?? new Error("The Agent operation was aborted"));
		};
		timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, delayMs);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

async function streamAssistantResponseAttempt(
	context: AgentContext,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	streamFunction: StreamFn,
	events: AttemptEventBuffer,
): Promise<StreamAssistantAttempt> {
	const preparedContext = config.prepareContext === undefined
		? context
		: await raceWithAbortSignal(Promise.resolve(config.prepareContext(context, config.model, signal)), signal);
	let messages = preparedContext.messages;
	if (config.transformContext) {
		messages = await raceWithAbortSignal(config.transformContext(messages, signal), signal);
	}
	const llmMessages = await raceWithAbortSignal(Promise.resolve(config.convertToLlm(messages)), signal);
	const llmContext: Context = {
		systemPrompt: preparedContext.systemPrompt,
		messages: llmMessages,
		tools: preparedContext.tools,
	};
	const resolvedApiKey =
		(config.getApiKey ? await raceWithAbortSignal(Promise.resolve(config.getApiKey(config.model.provider)), signal) : undefined) ||
		config.apiKey;
	const response = await raceWithAbortSignal(
		Promise.resolve(
			streamFunction(config.model, llmContext, {
				...config,
				apiKey: resolvedApiKey,
				signal,
			}),
		),
		signal,
	);

	let partialMessage: AssistantMessage | undefined;
	const finish = async (finalMessage: AssistantMessage): Promise<StreamAssistantAttempt> => {
		const failed = finalMessage.stopReason === "error" || finalMessage.stopReason === "aborted";
		if (!failed) {
			if (!partialMessage) await events.push({ type: "message_start", message: { ...finalMessage } });
			await events.push({ type: "message_end", message: finalMessage });
			return { message: finalMessage, visibleOutput: events.hasVisibleOutput };
		}
		const classification = classifyAgentLoopError(finalMessage, {
			operation: "model",
			phase: "request",
			signal,
			sideEffect: events.hasVisibleOutput ? "unknown" : "none",
		});
		const preserveLegacyRetryMessage =
			config.retry === undefined &&
			classification.category === "transient_provider" &&
			!events.hasVisibleOutput &&
			!isWrappedTransportCancellation(finalMessage);
		const safeSummaryClassification: AgentLoopErrorClassification = isWrappedTransportCancellation(finalMessage)
			? {
					...classification,
					category: "side_effect_unknown",
					code: "side_effect_unknown",
					sideEffect: "unknown",
					safeToRetry: false,
					retryable: false,
				}
			: classification;
		const safeMessage: AssistantMessage =
			classification.category === "unknown" && !events.hasVisibleOutput
				? {
						...finalMessage,
						errorMessage: redactedThrownAgentError(finalMessage),
					}
				: preserveLegacyRetryMessage
					? {
						...finalMessage,
						errorMessage: redactedThrownAgentError(finalMessage),
					}
					: createClassifiedFailureMessage(config, safeSummaryClassification);
		await events.finishFailure(safeMessage);
		return { message: safeMessage, classification, visibleOutput: events.hasVisibleOutput };
	};

	const iterator = response[Symbol.asyncIterator]();
	try {
		while (true) {
			const iteration = await raceWithAbortSignal(iterator.next(), signal);
			if (iteration.done) break;
			const event = iteration.value;
			switch (event.type) {
				case "start":
					partialMessage = event.partial;
					await events.push({ type: "message_start", message: { ...partialMessage } });
					break;
				case "text_start":
				case "text_delta":
				case "text_end":
				case "thinking_start":
				case "thinking_delta":
				case "thinking_end":
				case "toolcall_start":
				case "toolcall_delta":
				case "toolcall_end":
					if (partialMessage) {
						partialMessage = event.partial;
						await events.push({
							type: "message_update",
							assistantMessageEvent: event,
							message: { ...partialMessage },
						});
					}
					break;
				case "done":
				case "error":
					return await finish(await raceWithAbortSignal(response.result(), signal));
			}
		}
	} finally {
		if (signal?.aborted && iterator.return) {
			void Promise.resolve(iterator.return()).catch(() => undefined);
		}
	}
	return await finish(await raceWithAbortSignal(response.result(), signal));
}

/**
 * Fail all tool calls from an assistant message that was truncated by the
 * output token limit. Streamed tool-call arguments are finalized with a
 * best-effort JSON salvage parser, so a truncated message can yield tool calls
 * whose arguments parse and validate but are silently incomplete. None of them
 * are safe to execute; report each as an error so the model can re-issue them.
 */
async function failToolCallsFromTruncatedMessage(
	toolCalls: AgentToolCall[],
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const messages: ToolResultMessage[] = [];
	for (const toolCall of toolCalls) {
		await emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});
		const finalized: FinalizedToolCallOutcome = {
			toolCall,
			result: createErrorToolResult(
				`Tool call "${toolCall.name}" was not executed: the response hit the output token limit, so its arguments may be truncated. Re-issue the tool call with complete arguments.`,
			),
			isError: true,
		};
		await emitToolExecutionEnd(finalized, emit);
		const toolResultMessage = createToolResultMessage(finalized);
		await emitToolResultMessage(toolResultMessage, emit);
		messages.push(toolResultMessage);
	}
	return { messages, terminate: false };
}

/**
 * Execute tool calls from an assistant message.
 */
async function executeToolCalls(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const toolCalls = assistantMessage.content.filter((c) => c.type === "toolCall");
	const hasSequentialToolCall = toolCalls.some(
		(tc) => currentContext.tools?.find((t) => t.name === tc.name)?.executionMode === "sequential",
	);
	if (config.toolExecution === "sequential" || hasSequentialToolCall) {
		return executeToolCallsSequential(currentContext, assistantMessage, toolCalls, config, signal, emit);
	}
	return executeToolCallsParallel(currentContext, assistantMessage, toolCalls, config, signal, emit);
}

type ExecutedToolCallBatch = {
	messages: ToolResultMessage[];
	terminate: boolean;
};

async function executeToolCallsSequential(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCalls: AgentToolCall[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const finalizedCalls: FinalizedToolCallOutcome[] = [];
	const messages: ToolResultMessage[] = [];

	for (const toolCall of toolCalls) {
		await emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});

		const preparation = await prepareToolCall(currentContext, assistantMessage, toolCall, config, signal);
		let finalized: FinalizedToolCallOutcome;
		if (preparation.kind === "immediate") {
			finalized = {
				toolCall,
				result: preparation.result,
				isError: preparation.isError,
			};
		} else {
			const executed = await executePreparedToolCall(preparation, signal, emit);
			finalized = await finalizeExecutedToolCall(
				currentContext,
				assistantMessage,
				preparation,
				executed,
				config,
				signal,
			);
		}

		await emitToolExecutionEnd(finalized, emit);
		const toolResultMessage = createToolResultMessage(finalized);
		await emitToolResultMessage(toolResultMessage, emit);
		finalizedCalls.push(finalized);
		messages.push(toolResultMessage);

		if (signal?.aborted) {
			break;
		}
	}

	return {
		messages,
		terminate: shouldTerminateToolBatch(finalizedCalls),
	};
}

async function executeToolCallsParallel(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCalls: AgentToolCall[],
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallBatch> {
	const finalizedCalls: FinalizedToolCallEntry[] = [];

	for (const toolCall of toolCalls) {
		await emit({
			type: "tool_execution_start",
			toolCallId: toolCall.id,
			toolName: toolCall.name,
			args: toolCall.arguments,
		});

		const preparation = await prepareToolCall(currentContext, assistantMessage, toolCall, config, signal);
		if (preparation.kind === "immediate") {
			const finalized = {
				toolCall,
				result: preparation.result,
				isError: preparation.isError,
			} satisfies FinalizedToolCallOutcome;
			await emitToolExecutionEnd(finalized, emit);
			finalizedCalls.push(finalized);
			if (signal?.aborted) {
				break;
			}
			continue;
		}

		finalizedCalls.push(async () => {
			const executed = await executePreparedToolCall(preparation, signal, emit);
			const finalized = await finalizeExecutedToolCall(
				currentContext,
				assistantMessage,
				preparation,
				executed,
				config,
				signal,
			);
			await emitToolExecutionEnd(finalized, emit);
			return finalized;
		});
		if (signal?.aborted) {
			break;
		}
	}

	const orderedFinalizedCalls = await Promise.all(
		finalizedCalls.map((entry) => (typeof entry === "function" ? entry() : Promise.resolve(entry))),
	);
	const messages: ToolResultMessage[] = [];
	for (const finalized of orderedFinalizedCalls) {
		const toolResultMessage = createToolResultMessage(finalized);
		await emitToolResultMessage(toolResultMessage, emit);
		messages.push(toolResultMessage);
	}

	return {
		messages,
		terminate: shouldTerminateToolBatch(orderedFinalizedCalls),
	};
}

type PreparedToolCall = {
	kind: "prepared";
	toolCall: AgentToolCall;
	tool: AgentTool<any>;
	args: unknown;
};

type ImmediateToolCallOutcome = {
	kind: "immediate";
	result: AgentToolResult<any>;
	isError: boolean;
};

type ExecutedToolCallOutcome = {
	result: AgentToolResult<any>;
	isError: boolean;
};

type FinalizedToolCallOutcome = {
	toolCall: AgentToolCall;
	result: AgentToolResult<any>;
	isError: boolean;
};

type FinalizedToolCallEntry = FinalizedToolCallOutcome | (() => Promise<FinalizedToolCallOutcome>);

function shouldTerminateToolBatch(finalizedCalls: FinalizedToolCallOutcome[]): boolean {
	return finalizedCalls.length > 0 && finalizedCalls.every((finalized) => finalized.result.terminate === true);
}

function prepareToolCallArguments(tool: AgentTool<any>, toolCall: AgentToolCall): AgentToolCall {
	if (!tool.prepareArguments) {
		return toolCall;
	}
	const preparedArguments = tool.prepareArguments(toolCall.arguments);
	if (preparedArguments === toolCall.arguments) {
		return toolCall;
	}
	return {
		...toolCall,
		arguments: preparedArguments as Record<string, any>,
	};
}

async function prepareToolCall(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	toolCall: AgentToolCall,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
): Promise<PreparedToolCall | ImmediateToolCallOutcome> {
	const tool = currentContext.tools?.find((t) => t.name === toolCall.name);
	if (!tool) {
		return {
			kind: "immediate",
			result: createErrorToolResult(`Tool ${toolCall.name} not found`),
			isError: true,
		};
	}

	try {
		const preparedToolCall = prepareToolCallArguments(tool, toolCall);
		const validatedArgs = validateToolArguments(tool, preparedToolCall);
		if (config.beforeToolCall) {
			const beforeResult = await raceWithAbortSignal(
				config.beforeToolCall(
					{
						assistantMessage,
						toolCall,
						args: validatedArgs,
						context: currentContext,
					},
					signal,
				),
				signal,
			);
			if (signal?.aborted) {
				return {
					kind: "immediate",
					result: createErrorToolResult("Operation aborted"),
					isError: true,
				};
			}
			if (beforeResult?.block) {
				const result = createErrorToolResult(beforeResult.reason || "Tool execution was blocked");
				if (beforeResult.terminate === true) {
					result.terminate = true;
				}
				return {
					kind: "immediate",
					result,
					isError: true,
				};
			}
		}
		if (signal?.aborted) {
			return {
				kind: "immediate",
				result: createErrorToolResult("Operation aborted"),
				isError: true,
			};
		}
		return {
			kind: "prepared",
			toolCall,
			tool,
			args: validatedArgs,
		};
	} catch (error) {
		return {
			kind: "immediate",
			result: createClassifiedToolErrorResult(error, toolCall.name, "before_request", signal),
			isError: true,
		};
	}
}

async function executePreparedToolCall(
	prepared: PreparedToolCall,
	signal: AbortSignal | undefined,
	emit: AgentEventSink,
): Promise<ExecutedToolCallOutcome> {
	const updateEvents: Promise<void>[] = [];
	let acceptingUpdates = true;

	try {
		const result = await raceWithAbortSignal(
			prepared.tool.execute(
				prepared.toolCall.id,
				prepared.args as never,
				signal,
				(partialResult) => {
					if (!acceptingUpdates) return;
					updateEvents.push(
						Promise.resolve(
							emit({
								type: "tool_execution_update",
								toolCallId: prepared.toolCall.id,
								toolName: prepared.toolCall.name,
								args: prepared.toolCall.arguments,
								partialResult,
							}),
						),
					);
				},
			),
			signal,
		);
		acceptingUpdates = false;
		await Promise.all(updateEvents);
		return { result, isError: false };
	} catch (error) {
		acceptingUpdates = false;
		await Promise.all(updateEvents);
		return {
			result: createClassifiedToolErrorResult(error, prepared.toolCall.name, "after_request", signal),
			isError: true,
		};
	} finally {
		acceptingUpdates = false;
	}
}

async function finalizeExecutedToolCall(
	currentContext: AgentContext,
	assistantMessage: AssistantMessage,
	prepared: PreparedToolCall,
	executed: ExecutedToolCallOutcome,
	config: AgentLoopConfig,
	signal: AbortSignal | undefined,
): Promise<FinalizedToolCallOutcome> {
	let result = executed.result;
	let isError = executed.isError;

	if (config.afterToolCall) {
		try {
			const afterResult = await raceWithAbortSignal(
				config.afterToolCall(
					{
						assistantMessage,
						toolCall: prepared.toolCall,
						args: prepared.args,
						result,
						isError,
						context: currentContext,
					},
					signal,
				),
				signal,
			);
			if (afterResult) {
				result = {
					...result,
					content: afterResult.content ?? result.content,
					details: afterResult.details ?? result.details,
					usage: afterResult.usage ?? result.usage,
					terminate: afterResult.terminate ?? result.terminate,
				};
				isError = afterResult.isError ?? isError;
			}
		} catch (error) {
			result = createClassifiedToolErrorResult(error, prepared.toolCall.name, "after_request", signal);
			isError = true;
		}
	}

	return {
		toolCall: prepared.toolCall,
		result,
		isError,
	};
}

function createErrorToolResult(message: string): AgentToolResult<any> {
	return {
		content: [{ type: "text", text: message }],
		details: {},
	};
}

function createClassifiedToolErrorResult(
	error: unknown,
	toolName: string,
	phase: "before_request" | "after_request",
	signal: AbortSignal | undefined,
): AgentToolResult<any> {
	const operation = toolName.startsWith("mcp__") ? "mcp" : "tool";
	const classification = classifyAgentLoopError(error, { operation, phase, signal });
	return createErrorToolResult(getAgentLoopErrorMessage(classification));
}

async function emitToolExecutionEnd(finalized: FinalizedToolCallOutcome, emit: AgentEventSink): Promise<void> {
	await emit({
		type: "tool_execution_end",
		toolCallId: finalized.toolCall.id,
		toolName: finalized.toolCall.name,
		result: finalized.result,
		isError: finalized.isError,
	});
}

function createToolResultMessage(finalized: FinalizedToolCallOutcome): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: finalized.toolCall.id,
		toolName: finalized.toolCall.name,
		// Untyped tools (JS extensions) can return results without content; normalize
		// so the null never enters session history or provider payloads.
		content: finalized.result.content ?? [],
		details: finalized.result.details,
		...(finalized.result.usage === undefined ? {} : { usage: finalized.result.usage }),
		...(finalized.result.addedToolNames?.length ? { addedToolNames: finalized.result.addedToolNames } : {}),
		isError: finalized.isError,
		timestamp: Date.now(),
	};
}

async function emitToolResultMessage(toolResultMessage: ToolResultMessage, emit: AgentEventSink): Promise<void> {
	await emit({ type: "message_start", message: toolResultMessage });
	await emit({ type: "message_end", message: toolResultMessage });
}
