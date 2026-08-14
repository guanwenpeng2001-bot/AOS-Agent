import type { AssistantMessage, RetryCallbacks, RetryPolicy } from "@aos-agent/ai";
import { AgentDeadlineExceeded } from "./operation-signal.ts";

/** Stable error categories shared by the production loop and remote operations. */
export const AGENT_LOOP_ERROR_CATEGORIES = Object.freeze([
	"transient_provider",
	"permission_or_parameter",
	"side_effect_unknown",
	"cancelled",
	"deadline",
] as const);

export type AgentLoopErrorCategory = (typeof AGENT_LOOP_ERROR_CATEGORIES)[number] | "unknown";

export const AGENT_LOOP_ERROR_CODES = Object.freeze([
	"provider_unavailable",
	"permission_denied",
	"invalid_request",
	"side_effect_unknown",
	"cancelled",
	"deadline_exceeded",
	"lease_expired",
] as const);

export type AgentLoopErrorCode = (typeof AGENT_LOOP_ERROR_CODES)[number] | "unknown";
export type AgentLoopErrorSideEffect = "none" | "unknown";
export type AgentLoopProviderKind = "model" | "tool" | "mcp" | "sandbox";
export type AgentLoopProviderPhase = "before_request" | "request" | "after_request";

/** Context used to classify an error without assuming that a replay is safe. */
export interface AgentLoopErrorOptions {
	operation?: AgentLoopProviderKind;
	phase?: AgentLoopProviderPhase;
	sideEffect?: AgentLoopErrorSideEffect;
	signal?: AbortSignal;
	deadlineAt?: number;
}

/** Safe, metadata-only classification of a production loop failure. */
export interface AgentLoopErrorClassification {
	category: AgentLoopErrorCategory;
	code?: AgentLoopErrorCode;
	message: string;
	operation: AgentLoopProviderKind;
	phase: AgentLoopProviderPhase;
	sideEffect: AgentLoopErrorSideEffect;
	status?: number;
	/** True only when a retry cannot duplicate an unknown side effect. */
	safeToRetry: boolean;
	/** False for provider errors that carry an explicit non-retryable decision. */
	retryable: boolean;
}

export type AgentLoopRetryDecisionReason =
	| "retry"
	| "disabled"
	| "exhausted"
	| "cancelled"
	| "deadline"
	| "permission_or_parameter"
	| "side_effect_unknown"
	| "unsafe_side_effect"
	| "not_transient";

export interface AgentLoopRetryDecision {
	retry: boolean;
	reason: AgentLoopRetryDecisionReason;
	classification: AgentLoopErrorClassification;
}

export interface AgentLoopRetryOptions extends AgentLoopErrorOptions {
	policy?: RetryPolicy;
	retriesUsed: number;
	replay?: "never" | "safe";
}

const SAFE_CODES = new Set<string>(AGENT_LOOP_ERROR_CODES);
const SAFE_CATEGORIES = new Set<string>(AGENT_LOOP_ERROR_CATEGORIES);

const ERROR_MESSAGES: Record<AgentLoopErrorCategory, string> = {
	transient_provider: "The provider failed transiently.",
	permission_or_parameter: "The operation was rejected by permission or parameter validation.",
	side_effect_unknown: "The operation outcome is unknown after a possible side effect.",
	cancelled: "The operation was cancelled.",
	deadline: "The operation exceeded its deadline.",
	unknown: "The provider request failed.",
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function stringProperty(value: unknown, key: string): string | undefined {
	const property = asRecord(value)?.[key];
	return typeof property === "string" && property.length > 0 ? property : undefined;
}

function numberProperty(value: unknown, key: string): number | undefined {
	const property = asRecord(value)?.[key];
	return typeof property === "number" && Number.isFinite(property) ? property : undefined;
}

function booleanProperty(value: unknown, key: string): boolean | undefined {
	const property = asRecord(value)?.[key];
	return typeof property === "boolean" ? property : undefined;
}

function errorStatus(error: unknown): number | undefined {
	const direct = numberProperty(error, "status") ?? numberProperty(error, "statusCode");
	if (direct !== undefined) return direct;
	const record = asRecord(error);
	const nested = record?.error;
	const response = record?.response;
	const metadata = record?.$metadata;
	return (
		numberProperty(response, "status") ??
		numberProperty(response, "statusCode") ??
		numberProperty(metadata, "httpStatusCode") ??
		numberProperty(nested, "status") ??
		numberProperty(nested, "statusCode")
	);
}

function errorCode(error: unknown): string | undefined {
	const record = asRecord(error);
	const nested = record?.error;
	return (
		stringProperty(error, "code") ??
		stringProperty(error, "type") ??
		stringProperty(error, "name") ??
		stringProperty(nested, "code") ??
		stringProperty(nested, "type")
	);
}

function errorMessage(error: unknown): string {
	if (error instanceof Error && error.message) return error.message;
	return (
		stringProperty(error, "message") ??
		stringProperty(error, "errorMessage") ??
		stringProperty(asRecord(error)?.error, "message") ??
		stringProperty(asRecord(error)?.error, "errorMessage") ??
		(typeof error === "string" ? error : String(error))
	);
}

function diagnosticText(error: unknown): string {
	const parts: string[] = [];
	let current: unknown = error;
	const seen = new Set<unknown>();
	for (let depth = 0; depth < 4 && current !== undefined && !seen.has(current); depth++) {
		seen.add(current);
		const message = errorMessage(current);
		const code = errorCode(current);
		if (message) parts.push(message);
		if (code && code !== message) parts.push(code);
		const record = asRecord(current);
		current = record?.cause ?? record?.error;
	}
	const status = errorStatus(error);
	if (status !== undefined) parts.push(String(status));
	return parts.join(" ").toLowerCase();
}

function structuredCategory(error: unknown): AgentLoopErrorCategory | undefined {
	const record = asRecord(error);
	const category = stringProperty(error, "category") ?? stringProperty(record?.error, "category");
	if (category === "transient" || category === "transient_provider") return "transient_provider";
	if (category === "permission" || category === "parameter" || category === "permission_or_parameter") {
		return "permission_or_parameter";
	}
	if (category === "side_effect_unknown" || category === "side-effect-unknown") return "side_effect_unknown";
	if (category === "cancelled" || category === "canceled") return "cancelled";
	if (category === "deadline") return "deadline";
	return SAFE_CATEGORIES.has(category ?? "") ? (category as AgentLoopErrorCategory) : undefined;
}

function structuredSideEffect(error: unknown): AgentLoopErrorSideEffect | undefined {
	const record = asRecord(error);
	const sideEffect =
		stringProperty(error, "sideEffect") ??
		stringProperty(error, "sideEffects") ??
		stringProperty(record?.error, "sideEffect") ??
		stringProperty(record?.error, "sideEffects");
	return sideEffect === "unknown" ? "unknown" : sideEffect === "none" ? "none" : undefined;
}

function isDeadlineError(error: unknown, options: AgentLoopErrorOptions, text: string): boolean {
	if (error instanceof AgentDeadlineExceeded) return true;
	if (structuredCategory(error) === "deadline") return true;
	const code = errorCode(error)?.toLowerCase();
	const name = error instanceof Error ? error.name.toLowerCase() : code;
	if (code === "deadline_exceeded" || code === "lease_expired" || name === "agentdeadlineexceeded" || name === "harnessdeadlineexceeded") {
		return true;
	}
	const record = asRecord(error);
	if (record?.stopReason === "aborted" && /deadline|lease.?expir/.test(text)) return true;
	if (options.signal?.reason !== undefined && options.signal.reason !== error) {
		const reasonOptions = { ...options, signal: undefined };
		if (isDeadlineError(options.signal.reason, reasonOptions, diagnosticText(options.signal.reason))) return true;
	}
	return options.signal?.aborted === true && options.deadlineAt !== undefined && Date.now() >= options.deadlineAt;
}

function isCancelledError(error: unknown, options: AgentLoopErrorOptions, text: string): boolean {
	if (options.signal?.aborted) return true;
	if (structuredCategory(error) === "cancelled") return true;
	const record = asRecord(error);
	const stopReason = record?.stopReason;
	const code = errorCode(error)?.toLowerCase();
	return (
		stopReason === "aborted" ||
		code === "aborterror" ||
		code === "cancelled" ||
		code === "canceled" ||
		/\babort(?:ed|ing)?\b|cancelled|canceled/.test(text)
	);
}

function isPermissionError(text: string, status: number | undefined): boolean {
	return (
		status === 401 ||
		status === 403 ||
		/\b401\b|\b403\b|permission|forbidden|unauthori[sz]ed|access denied|not allowed|policy denied|capability denied|eacces|eperm/.test(
			text,
		)
	);
}

function isParameterError(text: string, status: number | undefined): boolean {
	return (
		status === 400 ||
		status === 422 ||
		/\b400\b|\b422\b|invalid[\s_-]*(?:argument|parameter|request|tool|schema)|malformed|validation failed|unsupported parameter|bad request|tool argument/.test(
			text,
		)
	);
}

function isTransientError(text: string, status: number | undefined): boolean {
	return (
		(status !== undefined && (status === 408 || status === 409 || status === 429 || status >= 500)) ||
		/\b(?:408|409|429|5\d\d)\b|provider failed transiently|overloaded|rate.?limit|too many requests|provider.?returned.?error|provider.?unavailable|service.?unavailable|server.?error|internal.?error|network.?error|connection.?(?:error|refused|lost)|fetch failed|getaddrinfo|eai_again|enotfound|upstream.?connect|reset before headers|timed? out|timeout|socket hang up|websocket.?closed|stream ended|try your request again|please retry|resourceexhausted/.test(
			text,
		)
	);
}

function safeCode(error: unknown, fallback: AgentLoopErrorCode | undefined): AgentLoopErrorCode | undefined {
	const code = errorCode(error);
	return code && SAFE_CODES.has(code) ? (code as AgentLoopErrorCode) : fallback;
}

/** Return a stable, redacted message for a classified error. */
export function getAgentLoopErrorMessage(classification: AgentLoopErrorClassification): string {
	return ERROR_MESSAGES[classification.category];
}

/**
 * Remove common credentials, URLs, and absolute paths from an unclassified local
 * error while retaining a useful message for programming errors.
 */
export function redactAgentLoopErrorMessage(message: string): string {
	return message
		.replace(/\b(bearer|basic)\s+[^\s,;]+/gi, "$1 [redacted]")
		.replace(/\b(?:api[_-]?key|token|password|secret|authorization)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, (match) => {
			const separator = match.includes("=") ? "=" : ":";
			const key = match.slice(0, match.indexOf(separator)).trim();
			return `${key}${separator}[redacted]`;
		})
		.replace(/https?:\/\/[^\s"'`]+/gi, "[redacted-url]")
		.replace(/(?:[A-Za-z]:[\\/]|\/(?:Users|home|tmp|var|private|workspace|workspaces)\/)[^\s"'`]+/g, "[redacted-path]");
}

/** Classify a provider or operation failure using only safe metadata in the result. */
export function classifyAgentLoopError(
	error: unknown,
	options: AgentLoopErrorOptions = {},
): AgentLoopErrorClassification {
	const operation = options.operation ?? "model";
	const phase = options.phase ?? "request";
	const status = errorStatus(error);
	const text = diagnosticText(error);
	const explicitCategory = structuredCategory(error);
	const explicitSideEffect = structuredSideEffect(error);
	const code = errorCode(error)?.toLowerCase();
	const messageIndicatesUnknownSideEffect = /unknown after a possible side effect|side[_-]effect[_-]unknown/.test(text);
	const sideEffect =
		options.sideEffect ??
		explicitSideEffect ??
		(explicitCategory === "side_effect_unknown" || code === "side_effect_unknown" || messageIndicatesUnknownSideEffect
			? "unknown"
			: operation === "model"
				? "none"
				: undefined);
	const possibleSideEffect =
		sideEffect === "unknown" || (operation !== "model" && phase === "after_request" && sideEffect === undefined);
	let category: AgentLoopErrorCategory;
	let fallbackCode: AgentLoopErrorCode | undefined;
	if (possibleSideEffect) {
		category = "side_effect_unknown";
		fallbackCode = "side_effect_unknown";
	} else if (isDeadlineError(error, options, text)) {
		category = "deadline";
		fallbackCode = "deadline_exceeded";
	} else if (isCancelledError(error, options, text)) {
		category = "cancelled";
		fallbackCode = "cancelled";
	} else if (explicitCategory !== undefined) {
		category = explicitCategory;
	} else if (isPermissionError(text, status) || isParameterError(text, status)) {
		category = "permission_or_parameter";
		fallbackCode = isPermissionError(text, status) ? "permission_denied" : "invalid_request";
	} else if (isTransientError(text, status)) {
		category = "transient_provider";
		fallbackCode = "provider_unavailable";
	} else {
		category = "unknown";
	}
	const safeToRetry = category === "transient_provider" && sideEffect !== "unknown";
	const explicitRetryable = booleanProperty(error, "retryable") ?? booleanProperty(asRecord(error)?.error, "retryable");
	const retryable = safeToRetry && explicitRetryable !== false;
	return {
		category,
		...(safeCode(error, fallbackCode) === undefined ? {} : { code: safeCode(error, fallbackCode) }),
		message: ERROR_MESSAGES[category],
		operation,
		phase,
		sideEffect: sideEffect === "unknown" ? "unknown" : "none",
		...(status === undefined ? {} : { status }),
		safeToRetry,
		retryable,
	};
}

/** Decide whether a classified failure may consume another bounded retry. */
export function decideAgentLoopRetry(
	error: unknown | AgentLoopErrorClassification,
	options: AgentLoopRetryOptions,
): AgentLoopRetryDecision {
	const classification =
		isAgentLoopErrorClassification(error) ? error : classifyAgentLoopError(error, options);
	if (classification.category === "deadline") {
		return { retry: false, reason: "deadline", classification };
	}
	if (options.signal?.aborted || classification.category === "cancelled") {
		return { retry: false, reason: "cancelled", classification };
	}
	if (!options.policy?.enabled) return { retry: false, reason: "disabled", classification };
	if (options.retriesUsed >= options.policy.maxRetries) {
		return { retry: false, reason: "exhausted", classification };
	}
	switch (classification.category) {
		case "permission_or_parameter":
			return { retry: false, reason: "permission_or_parameter", classification };
		case "side_effect_unknown":
			return { retry: false, reason: "side_effect_unknown", classification };
		case "transient_provider":
			if (
				classification.retryable &&
				(classification.operation === "model" || options.replay === "safe") &&
				classification.sideEffect === "none"
			) {
				return { retry: true, reason: "retry", classification };
			}
			return { retry: false, reason: "unsafe_side_effect", classification };
		default:
			return { retry: false, reason: "not_transient", classification };
	}
}

function isAgentLoopErrorClassification(value: unknown): value is AgentLoopErrorClassification {
	const record = asRecord(value);
	return record !== undefined && typeof record.category === "string" && typeof record.message === "string";
}

/** Retry callback type re-exported next to the production loop configuration. */
export type AgentLoopRetryCallbacks = RetryCallbacks;

/** Build a safe message from a thrown value for the low-level loop fallback path. */
export function redactedThrownAgentError(error: unknown): string {
	return redactAgentLoopErrorMessage(errorMessage(error));
}

/** Keep the assistant-message shape while allowing classifier tests to use the same input path. */
export function classifyAssistantMessageError(
	message: AssistantMessage,
	options: AgentLoopErrorOptions = {},
): AgentLoopErrorClassification {
	return classifyAgentLoopError(message, options);
}
