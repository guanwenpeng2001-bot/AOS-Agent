import type { JsonValue } from "../session/types.ts";

/** Foundation-owned errors. Durable-ledger codes are appended below from the same catalog source. */
const FOUNDATION_CORE_ERROR_CODES = [
	"foundation_schema_unsupported_version",
	"foundation_schema_invalid_shape",
	"foundation_schema_unknown_record",
	"invalid_identifier",
	"invalid_timestamp",
	"invalid_correlation",
	"unsupported_schema_version",
	"invalid_shape",
	"protocol_incompatible",
	"unsupported_feature",
	"serialization_failed",
	"event_cursor_gap",
	"event_cursor_expired",
	"event_cursor_invalid_sequence",
	"goal_not_found",
	"goal_conflict",
	"goal_invalid_transition",
	"ask_not_found",
	"ask_conflict",
	"ask_invalid_transition",
	"ask_timeout_not_reached",
	"ask_escalation_not_reached",
	"workflow_not_found",
	"workflow_conflict",
	"workflow_invalid_transition",
	"structure_schema_invalid",
	"structure_retry_exhausted",
	"budget_exhausted",
	"quota_exceeded",
	"quota_attribution_error",
	"tool_guard_denied",
	"tool_pre_hook_denied",
	"tool_post_validation_failed",
	"external_event_invalid",
	"external_resource_limit_exceeded",
	"side_effect_unknown",
	"role_not_found",
	"role_slug_conflict",
	"role_revision_immutable",
	"model_profile_not_found",
	"role_resolver_task_required",
	"role_resolver_order_invalid",
	"role_resolver_scope_widened",
	"role_resolver_conflict",
	"binding_required_fact",
	"binding_task_before_binding",
	"binding_epoch_invalid_ordinal",
	"binding_epoch_missing_previous",
	"binding_epoch_mismatch",
	"agent_instance_not_agent_provider",
	"agent_instance_required_for_agent_provider",
	"agent_instance_forbidden_for_provider",
	"agent_spawn_recovery_required",
	"model_invocation_recovery_required",
	"task_executor_invalid_provider_class",
	"provider_spawn_failed",
	"role_registry_persistence_invalid",
	"role_registry_persistence_failed",
	"model_profile_persistence_invalid",
	"model_profile_persistence_failed",
	"task_result_no_source_receipts",
	"task_result_receipt_task_mismatch",
	"task_result_acceptance_unverified",
	"task_result_validation_failed",
	"task_result_terminal_requires_task_result",
	"run_terminal_authority_required",
	"run_terminal_authority_invalid",
	"worker_receipt_invalid_producer",
	"worker_invalid",
	"worker_profile_untrusted",
	"worker_unavailable",
	"worker_start_failed",
	"worker_binding_invalid",
	"worker_operation_invalid",
	"worker_cancel_failed",
	"worker_deadline_exceeded",
	"worker_lost",
	"worker_receipt_invalid",
	"worker_reclaim_failed",
	"worker_not_found",
	"worker_conflict",
	"worker_persistence_failed",
	"profile_conflict",
	"service_conflict",
	"service_cycle",
	"plugin_rollback_failed",
	"tool_execution_failed",
	"transport_not_authorized",
	"protocol_unsupported_version",
	"protocol_invalid_envelope",
	"observer_cursor_gap",
	"sandbox_capability_insufficient",
	"task_credential_target_unavailable",
	"scheduler_queue_invalid",
	"scheduler_queue_conflict",
	"scheduler_claim_conflict",
	"scheduler_claim_expired",
	"scheduler_lease_lost",
	"scheduler_no_executor",
	"scheduler_executor_unavailable",
	"scheduler_budget_exhausted_wait",
	"scheduler_dispatch_invalid",
	"scheduler_attempt_recovery_failed",
	"scheduler_fanin_invalid",
	"scheduler_settlement_rejected",
	"scheduler_handoff_invalid",
	"scheduler_handoff_timeout",
	"scheduler_handoff_target_unavailable",
	"scheduler_message_invalid",
	"scheduler_message_timeout",
	"scheduler_wake_invalid",
	"scheduler_deadlock_detected",
	"scheduler_backpressure",
	"scheduler_not_found",
	"scheduler_persistence_failed",
] as const;

/** Canonical line-12A Child Agent error catalog. Keep this tuple as the only source for its union. */
export const SUBAGENT_ERROR_CODES = Object.freeze([
	"subagent_spawn_invalid",
	"subagent_provider_unavailable",
	"subagent_capability_unsupported",
	"subagent_binding_projection_invalid",
	"subagent_context_fork_invalid",
	"subagent_depth_exceeded",
	"subagent_concurrency_exceeded",
	"subagent_max_turns_exceeded",
	"subagent_not_found",
	"subagent_mailbox_invalid",
	"subagent_wait_timeout",
	"subagent_cancel_failed",
	"subagent_lost",
	"subagent_resume_failed",
	"subagent_result_untrusted",
	"subagent_worktree_conflict",
	"subagent_close_unknown",
	"subagent_conflict",
	"subagent_persistence_failed",
] as const);

/** Canonical durable-ledger error catalog. Keep this tuple as the only source for its union. */
export const DURABLE_LEDGER_ERROR_CODES = Object.freeze([
	"session_writer_lease_lost",
	"session_writer_fencing_token",
	"session_writer_stale_revision",
	"session_writer_duplicate_request",
	"session_writer_busy",
	"session_writer_lease_expired",
	"session_ledger_tombstoned",
	"session_ledger_conflict",
	"session_ledger_missing_intent",
	"session_ledger_unknown_format",
	"session_ledger_corrupt",
	"session_ledger_truncated",
	"session_ledger_invalid_record",
	"session_ledger_invalid_query",
	"session_ledger_migrating",
	"session_ledger_storage",
] as const);

/** Exhaustive Foundation and durable-ledger error catalog. */
export const FOUNDATION_ERROR_CODES = Object.freeze([
	...FOUNDATION_CORE_ERROR_CODES,
	...SUBAGENT_ERROR_CODES,
	...DURABLE_LEDGER_ERROR_CODES,
] as const);
export type FoundationErrorCode = (typeof FOUNDATION_ERROR_CODES)[number];
export type DurableLedgerErrorCode = (typeof DURABLE_LEDGER_ERROR_CODES)[number];
export type SubagentErrorCode = (typeof SUBAGENT_ERROR_CODES)[number];

export interface StableErrorRecord { _tag: string; code: string; message: string; category?: string; retryable?: boolean; }

export type FoundationErrorCategory = "schema" | "concurrency" | "not_found" | "conflict" | "validation" | "budget" | "permission" | "provider" | "unknown";

export function foundationErrorCategory(code: FoundationErrorCode): FoundationErrorCategory {
	if (code.startsWith("foundation_schema") || code.startsWith("structure") || code === "invalid_shape" || code === "unsupported_schema_version") return "schema";
	if (code.includes("cursor") || code.startsWith("session_writer") || code.startsWith("binding_epoch")) return "concurrency";
	if (code.endsWith("_not_found")) return "not_found";
	if (code.endsWith("_conflict")) return "conflict";
	if (code.includes("budget") || code.includes("quota") || code.includes("not_authorized")) return "permission";
	if (code.startsWith("external_") || code.includes("provider") || code.includes("side_effect") || code.includes("service_") || code.includes("plugin_")) return "provider";
	if (code === "scheduler_lease_lost" || code === "scheduler_claim_expired") return "concurrency";
	if (code === "scheduler_no_executor" || code === "scheduler_executor_unavailable") return "provider";
	return "validation";
}
export const REDACTED = "[redacted]";
export const REDACTED_URL = "[redacted-url]";
export const REDACTED_PATH = "[redacted-path]";
export const FOUNDATION_FORBIDDEN_KEYS = Object.freeze([
	"data",
	"raw",
	"message",
	"messages",
	"finalText",
	"command",
	"args",
	"body",
	"content",
	"stack",
	"cause",
	"authorization",
	"cookie",
	"credential",
	"password",
	"secret",
	"token",
	"apiKey",
	"signature",
	"textSignature",
	"headers",
	"prompt",
	"workspace",
	"path",
	"url",
]);

function forbiddenKey(key: string): boolean {
	const normalized = key.toLowerCase();
	return FOUNDATION_FORBIDDEN_KEYS.some((candidate) => normalized.includes(candidate.toLowerCase()));
}

export function redactText(text: string): string {
	return text
		.replace(/(prompt|transcript|payload|originalArguments|translatedConfig|input)\s*[:=]\s*[^\n]+/gi, `$1=${REDACTED}`)
		.replace(/\bsk-[A-Za-z0-9_-]{16,}/g, REDACTED)
		.replace(/bearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACTED}`)
		.replace(/(password|credential|secret|token|api[-_]?key)\s*[:=]\s*[^\s,;]+/gi, `$1=${REDACTED}`)
		.replace(/https?:\/\/[^\s]+/gi, REDACTED_URL)
		.replace(/(?:[A-Za-z]:[\\/]|\/(?:Users|home|tmp|var|workspace|mnt|private)\/)[^\s,;]+/g, REDACTED_PATH);
}

export function redactProjection(value: unknown): unknown {
	if (typeof value === "string") return redactText(value);
	if (Array.isArray(value)) return value.map((item) => redactProjection(item));
	if (value !== null && typeof value === "object") {
		const result: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value)) result[key] = forbiddenKey(key) ? REDACTED : redactProjection(item);
		return result;
	}
	return value;
}

export interface FoundationPublicError {
	code: FoundationErrorCode | string;
	category: FoundationErrorCategory;
	message: string;
}

export type PublicExecutionErrorCategory = "permission" | "parameter" | "transient" | "deadline" | "cancelled" | "side_effect_unknown" | "unknown";
export interface PublicExecutionError {
	code: string;
	message: string;
	category?: PublicExecutionErrorCategory;
	retryable: boolean;
}

export class FoundationError extends Error {
	readonly _tag = "FoundationError" as const;
	readonly code: FoundationErrorCode;
	readonly category: FoundationErrorCategory;
	readonly details?: JsonValue;
	readonly retryable: boolean;

	constructor(code: FoundationErrorCode, message: string, options: { details?: JsonValue; retryable?: boolean; cause?: unknown } = {}) {
		super(redactText(message));
		this.name = "FoundationError";
		this.code = code;
		this.category = foundationErrorCategory(code);
		this.retryable = options.retryable ?? false;
		this.details = options.details === undefined ? undefined : (redactProjection(options.details) as JsonValue);
		if (options.cause !== undefined) this.cause = options.cause;
	}

	static is(value: unknown): value is FoundationError {
		return value instanceof FoundationError || (typeof value === "object" && value !== null && (value as { _tag?: unknown })._tag === "FoundationError");
	}

	redact(): FoundationPublicError {
		return { code: this.code, category: this.category, message: this.message };
	}

	toPublicExecutionError(): PublicExecutionError {
		return { code: this.code, message: this.message, retryable: this.retryable };
	}

	toJSON(): FoundationPublicError & { _tag: "FoundationError" } {
		return { _tag: "FoundationError", ...this.redact() };
	}
}

export function toFoundationError(error: unknown, fallbackCode: FoundationErrorCode = "foundation_schema_unknown_record"): FoundationError {
	if (error instanceof FoundationError) return error;
	return new FoundationError(fallbackCode, error instanceof Error ? error.message : String(error), { cause: error });
}

export function publicExecutionError(code: FoundationErrorCode | string, message: string, options: { retryable?: boolean; category?: PublicExecutionErrorCategory } = {}): PublicExecutionError {
	return { code, message: redactText(message), ...(options.category === undefined ? {} : { category: options.category }), retryable: options.retryable ?? false };
}

export function redactFoundationError(error: FoundationError): FoundationPublicError {
	return error.redact();
}
