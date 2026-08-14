/** Typed classification shared by provider fallback and AgentSession retry. */

import type { AssistantMessage } from "@aos-agent/ai/compat";
import type { ModelFallbackReason, ProviderFailureCategory } from "./model-broker.ts";

export type ExecutionErrorKind =
	| "cancelled"
	| "deadline_exceeded"
	| "transient_provider"
	| "side_effect_unknown"
	| "permanent_provider"
	| "context"
	| "tool"
	| "policy"
	| "unknown";

export interface ExecutionErrorClassification {
	readonly kind: ExecutionErrorKind;
	readonly category: ProviderFailureCategory | string;
	readonly fallbackReason?: ModelFallbackReason;
	readonly sideEffectStatus: "none" | "visible" | "unknown";
	readonly retryable: boolean;
}

export interface ProviderFailureClassificationOptions {
	/** True once the provider transport has been invoked and may have accepted work. */
	dispatched?: boolean;
	/** True when the stream exposed output or a tool call before failing. */
	visibleOutput?: boolean;
}

function isErrorWithCode(value: unknown): value is { code: string } {
	return typeof value === "object" && value !== null && "code" in value && typeof value.code === "string";
}

function messageText(value: unknown): string {
	if (typeof value === "string") return value;
	if (value instanceof Error) return value.message;
	if (typeof value === "object" && value !== null && "errorMessage" in value) {
		const errorMessage = (value as { errorMessage?: unknown }).errorMessage;
		return typeof errorMessage === "string" ? errorMessage : "";
	}
	return "";
}

function hasVisibleAssistantContent(message: AssistantMessage): boolean {
	return message.content.some((part) => {
		if (part.type === "toolCall") return true;
		if (part.type === "text") return part.text.length > 0;
		return part.thinking.length > 0;
	});
}

function classifyCategory(message: string): {
	category: ProviderFailureCategory | string;
	fallbackReason?: ModelFallbackReason;
} {
	const normalized = message.toLowerCase();
	if (/(deadline|deadline exceeded|timed out|timeout|etimedout)/.test(normalized)) {
		return { category: "timeout", fallbackReason: "transient_provider_error" };
	}
	if (/(rate limit|429|overloaded|too many requests)/.test(normalized)) {
		return { category: "rate_limit", fallbackReason: "transient_provider_error" };
	}
	if (
		/(unavailable|temporar|transient|network|fetch failed|econn|getaddrinfo|eai_again|enotfound|502|503|504|5xx|gateway|server.?error|internal.?error|provider.?returned.?error|connection|socket|stream ended|ended without|terminated|try your request again|you can retry|resourceexhausted)/.test(
			normalized,
		)
	) {
		return { category: "network", fallbackReason: "provider_unavailable" };
	}
	if (
		/(401|403|auth|api[_-]?key|credential|unauthorized|forbidden|permission|quota|billing|insufficient_quota)/.test(
			normalized,
		)
	) {
		return { category: normalized.includes("quota") || normalized.includes("billing") ? "billing" : "auth" };
	}
	if (/(context|too many tokens|token limit|maximum input|prompt too long)/.test(normalized)) {
		return { category: "context_overflow" };
	}
	if (/(tool|invalid request|bad request|unsupported|schema)/.test(normalized)) {
		return { category: "configuration_error" };
	}
	return { category: "unknown" };
}

/** Classify a provider failure before retry/fallback decisions are made. */
export function classifyProviderFailure(
	value: unknown,
	options: ProviderFailureClassificationOptions = {},
): ExecutionErrorClassification {
	if (isErrorWithCode(value) && value.code === "deadline_exceeded") {
		return { kind: "deadline_exceeded", category: "deadline_exceeded", sideEffectStatus: "none", retryable: false };
	}
	const message = messageText(value);
	const normalized = message.toLowerCase();
	const classified = classifyCategory(message);
	if (options.visibleOutput) {
		return {
			kind: "permanent_provider",
			category: "partial_output",
			sideEffectStatus: "visible",
			retryable: false,
		};
	}
	if (classified.fallbackReason !== undefined) {
		return {
			kind: "transient_provider",
			...classified,
			sideEffectStatus: "none",
			retryable: true,
		};
	}
	if (/(abort|cancel|cancelled|canceled)/.test(normalized)) {
		return { kind: "cancelled", category: "cancelled", sideEffectStatus: "none", retryable: false };
	}
	if (options.dispatched) {
		return {
			kind: "side_effect_unknown",
			category: "side_effect_unknown",
			sideEffectStatus: "unknown",
			retryable: false,
		};
	}
	const kind: ExecutionErrorKind =
		classified.category === "context_overflow"
			? "context"
			: classified.category === "configuration_error" || classified.category === "tool_error"
				? "tool"
				: classified.category === "auth" || classified.category === "permission"
					? "permanent_provider"
					: "unknown";
	return { kind, ...classified, sideEffectStatus: "none", retryable: false };
}

/** Classify an assistant error without allowing text heuristics to retry unknown failures. */
export function classifyAssistantFailure(message: AssistantMessage): ExecutionErrorClassification {
	if (message.stopReason === "aborted") {
		return { kind: "cancelled", category: "cancelled", sideEffectStatus: "none", retryable: false };
	}
	return classifyProviderFailure(message, { visibleOutput: hasVisibleAssistantContent(message) });
}
