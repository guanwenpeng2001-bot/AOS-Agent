import { createAssistantMessageEventStream, type Api, type AssistantMessageEventStream, type Context, type Model, type SimpleStreamOptions } from "@aos-agent/ai";
import type { StreamFn } from "../../types.ts";
import { FoundationError } from "./errors.ts";
import type { Budget } from "./budget.ts";
import type { FoundationProviderCapability } from "./providers.ts";
import type { ModelRoute } from "./role.ts";

/** The draft host adapter is deliberately smaller than the future model gateway. */
export const FOUNDATION_HOST_MODEL_CALL_CAPABILITY: FoundationProviderCapability = Object.freeze({
	schemaVersion: 1,
	id: "foundation.host.model_call",
	version: 1,
});

export interface FoundationHostModelCallRequest {
	readonly route: ModelRoute;
	readonly model: Model<Api>;
	readonly context: Context;
	readonly options?: SimpleStreamOptions;
	readonly budget?: Budget;
}

export interface FoundationHostModelCallAdapter {
	capabilities(): readonly FoundationProviderCapability[];
	validate(request: FoundationHostModelCallRequest): FoundationError | undefined;
	stream(request: FoundationHostModelCallRequest): AssistantMessageEventStream | Promise<AssistantMessageEventStream>;
}

export interface FoundationHostModelCallAdapterOptions {
	/** The host does not infer service-tier support from provider names. */
	readonly supportedServiceTiers?: readonly string[];
}

const FOUNDATION_THINKING_LEVELS = new Set(["minimal", "low", "medium", "high", "xhigh", "max"]);

function validateHostModelCallRequest(request: FoundationHostModelCallRequest, supportedServiceTiers: ReadonlySet<string>): FoundationError | undefined {
	if (request.model.provider !== request.route.provider || request.model.id !== request.route.model) {
		return new FoundationError("binding_task_before_binding", "Host model call does not use the immutable Binding route", { details: { provider: request.route.provider, model: request.route.model } });
	}
	if (request.route.serviceTier !== undefined && !supportedServiceTiers.has(request.route.serviceTier)) {
		return new FoundationError("unsupported_feature", "Host model call service tier is not declared by the adapter", { details: { serviceTier: request.route.serviceTier } });
	}
	if (request.route.effort !== undefined && !FOUNDATION_THINKING_LEVELS.has(request.route.effort)) {
		return new FoundationError("unsupported_feature", "Host model call effort is not declared by the adapter", { details: { effort: request.route.effort } });
	}
	return undefined;
}

/**
 * Adapts the existing host Models collection to the model route boundary. The
 * fallback list is recorded in the route but is intentionally never executed.
 */
export function createFoundationHostModelCallAdapter(
	models: { readonly streamSimple: StreamFn },
	options: FoundationHostModelCallAdapterOptions = {},
): FoundationHostModelCallAdapter {
	const supportedServiceTiers = new Set(options.supportedServiceTiers ?? []);
	return {
		capabilities: () => [FOUNDATION_HOST_MODEL_CALL_CAPABILITY],
		validate: (request) => validateHostModelCallRequest(request, supportedServiceTiers),
		stream: (request) => {
			const validationError = validateHostModelCallRequest(request, supportedServiceTiers);
			if (validationError !== undefined) throw validationError;
			const providerOptions = {
				...(request.options ?? {}),
				...(request.route.effort === undefined ? {} : { reasoning: request.route.effort as NonNullable<SimpleStreamOptions["reasoning"]> }),
				...(request.route.serviceTier === undefined ? {} : { serviceTier: request.route.serviceTier }),
			};
			return models.streamSimple(request.model, request.context, providerOptions);
		},
	};
}

/** Stable fail-closed stream for consumers that need a stream-shaped error. */
export function foundationModelCallErrorStream(error: FoundationError, model: Model<Api>): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	stream.push({
		type: "error",
		reason: "error",
		error: {
			role: "assistant",
			content: [{ type: "text", text: "" }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "error",
			errorMessage: error.message,
			timestamp: Date.now(),
			// The durable model_invocation fact remains the authority for terminal
			// operation codes; this typed diagnostic only carries pre-intent failures.
			// It avoids encoding a Foundation code in provider-visible message text.
			diagnostics: [{ type: "foundation_model_call", timestamp: Date.now(), error: { name: error.name, message: error.message, code: error.code } }],
		},
	});
	return stream;
}
