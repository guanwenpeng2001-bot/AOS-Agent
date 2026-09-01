import type { SpanAttributes, TelemetryContext, TelemetrySpan } from "@aos-agent/telemetry";
import type {
	Api,
	AssistantImages,
	AssistantMessage,
	AssistantMessageEvent,
	ImagesApi,
	ImagesModel,
	Model,
	ProviderRequestOptions,
	StopReason,
} from "./types.ts";
import { AssistantMessageEventStream } from "./utils/event-stream.ts";

type AiOperation = "stream" | "fetch_deferred" | "cancel_deferred" | "generate_images";

function startAttributes(
	model: Model<Api> | ImagesModel<ImagesApi>,
	operation: AiOperation,
	streaming: boolean,
	deferred?: boolean,
): SpanAttributes {
	return {
		"aos.ai.operation": operation,
		"aos.ai.provider": model.provider,
		"aos.ai.model": model.id,
		"aos.ai.api": model.api,
		"aos.ai.streaming": streaming,
		...(deferred === undefined ? {} : { "aos.ai.deferred": deferred }),
	};
}

function normalizedStopReason(reason: StopReason): string | undefined {
	if (reason === "pending") return undefined;
	return reason === "toolUse" ? "tool_use" : reason;
}

function completionAttributes(message: AssistantMessage): SpanAttributes {
	return {
		"aos.ai.response.model": message.responseModel ?? message.model,
		"aos.ai.response.id": message.responseId,
		"aos.ai.response.stop_reason": normalizedStopReason(message.stopReason),
		"aos.ai.usage.input_tokens": message.usage.input,
		"aos.ai.usage.output_tokens": message.usage.output,
		"aos.ai.usage.cache_read_tokens": message.usage.cacheRead,
		"aos.ai.usage.cache_write_tokens": message.usage.cacheWrite,
		"aos.ai.usage.reasoning_tokens": message.usage.reasoning,
		"aos.ai.usage.total_tokens": message.usage.totalTokens,
		"aos.ai.usage.cost": message.usage.cost.total,
	};
}

function imageCompletionAttributes(message: AssistantImages): SpanAttributes {
	return {
		"aos.ai.response.model": message.model,
		"aos.ai.response.id": message.responseId,
		"aos.ai.response.stop_reason": message.stopReason,
		"aos.ai.usage.input_tokens": message.usage?.input,
		"aos.ai.usage.output_tokens": message.usage?.output,
		"aos.ai.usage.cache_read_tokens": message.usage?.cacheRead,
		"aos.ai.usage.cache_write_tokens": message.usage?.cacheWrite,
		"aos.ai.usage.reasoning_tokens": message.usage?.reasoning,
		"aos.ai.usage.total_tokens": message.usage?.totalTokens,
		"aos.ai.usage.cost": message.usage?.cost.total,
	};
}

function errorAttributes(error: unknown): SpanAttributes {
	return { "aos.ai.error.type": error instanceof Error ? error.name : "Error" };
}

function setMessageStatus(span: TelemetrySpan, message: AssistantMessage | AssistantImages): void {
	if (message.stopReason === "error" || message.stopReason === "aborted") {
		span.setStatus({
			status: "error",
			error: { name: message.stopReason === "aborted" ? "AbortError" : "ProviderError", message: message.errorMessage ?? message.stopReason },
		});
		span.setAttributes({ "aos.ai.error.type": message.stopReason === "aborted" ? "AbortError" : "ProviderError" });
	}
}

function setupErrorMessage(model: Model<Api>, error: unknown): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error",
		errorMessage: error instanceof Error ? error.message : String(error),
		timestamp: Date.now(),
	};
}

export function traceAiStream<TOptions extends ProviderRequestOptions>(
	model: Model<Api>,
	operation: Extract<AiOperation, "stream" | "fetch_deferred">,
	options: TOptions | undefined,
	create: (options: TOptions | undefined) => AssistantMessageEventStream,
): AssistantMessageEventStream {
	const telemetryContext = options?.telemetryContext;
	if (telemetryContext === undefined) return create(options);

	const output = new AssistantMessageEventStream();
	const deferred = options === undefined
		? undefined
		: "deferred" in options
			? Boolean((options as ProviderRequestOptions & { deferred?: unknown }).deferred)
			: undefined;
	void telemetryContext.startSpan(
		{
			name: "aos.ai.request",
			attributes: startAttributes(
				model,
				operation,
				true,
				operation === "fetch_deferred" ? true : deferred,
			),
		},
		async (span) => {
			const startedAt = Date.now();
			let chunkCount = 0;
			let firstChunkAt: number | undefined;
			try {
				const onResponse = options?.onResponse;
				const tracedOptions = {
					...options,
					telemetryContext: span,
					onResponse: async (...args: Parameters<NonNullable<ProviderRequestOptions["onResponse"]>>) => {
						span.setAttributes({ "aos.ai.http.status_code": args[0].status });
						await onResponse?.(...args);
					},
				} as unknown as TOptions;
				const source = create(tracedOptions);
				for await (const event of source) {
					if (event.type !== "done" && event.type !== "error") {
						chunkCount += 1;
						firstChunkAt ??= Date.now();
					}
					output.push(event);
				}
				const message = await source.result();
				span.setAttributes({
					...completionAttributes(message),
					"aos.ai.stream.chunk_count": chunkCount,
					"aos.ai.stream.time_to_first_chunk_ms": firstChunkAt === undefined ? undefined : firstChunkAt - startedAt,
				});
				setMessageStatus(span, message);
				output.end(message);
			} catch (error) {
				span.setAttributes(errorAttributes(error));
				span.setStatus({ status: "error", error: { name: error instanceof Error ? error.name : "Error", message: error instanceof Error ? error.message : String(error) } });
				throw error;
			}
		},
	).catch((error: unknown) => {
		const message = setupErrorMessage(model, error);
		const event: AssistantMessageEvent = { type: "error", reason: "error", error: message };
		output.push(event);
		output.end(message);
	});
	return output;
}

export async function traceAiOperation<Result>(
	telemetryContext: TelemetryContext | undefined,
	model: Model<Api> | ImagesModel<ImagesApi>,
	operation: Extract<AiOperation, "cancel_deferred" | "generate_images">,
	run: (telemetryContext: TelemetryContext | undefined) => Promise<Result>,
): Promise<Result> {
	if (telemetryContext === undefined) return run(undefined);
	return telemetryContext.startSpan(
		{ name: "aos.ai.request", attributes: startAttributes(model, operation, false, operation === "cancel_deferred" ? true : undefined) },
		async (span) => {
			try {
				const result = await run(span);
				if (operation === "generate_images") {
					const message = result as AssistantImages;
					span.setAttributes(imageCompletionAttributes(message));
					setMessageStatus(span, message);
				}
				return result;
			} catch (error) {
				span.setAttributes(errorAttributes(error));
				span.setStatus({ status: "error", error: { name: error instanceof Error ? error.name : "Error", message: error instanceof Error ? error.message : String(error) } });
				throw error;
			}
		},
	);
}
