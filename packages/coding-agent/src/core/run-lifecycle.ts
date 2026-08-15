/**
 * Automation Host v1 run lifecycle: per-session run reservation, the frozen
 * accepted/running/completed/failed/cancelled state machine, sequenced stream
 * events, final-text capture, usage deltas, terminal receipts, and a ledger
 * folded from the SessionManager's `automation.run` custom entries.
 *
 * The coordinator owns a {@link RunLedgerSession} binding (a structural subset
 * of `SessionManager`) and persists only schemaVersion 1 facts via
 * `appendCustomEntry("automation.run", entry)`. Recovery replays custom entries
 * in order; an accepted/running run with no terminal fact is returned with the
 * read-only `recovery: "interrupted"` flag and is never given a fabricated
 * terminal. Diagnostics go to stderr.
 *
 * Erasable TypeScript only (no enums, namespaces, or parameter properties).
 */

import { createHash, randomUUID } from "node:crypto";
import type { AgentMessage, ThinkingLevel } from "@aos-agent/agent-core";
import type { AssistantMessage, AssistantMessageEvent } from "@aos-agent/ai";
import type { AgentSessionEvent } from "./agent-session.ts";
import {
	createRunBindingAssociation,
	parseRunBindingAssociation,
	serializePublicRunBindingAssociation,
	type BindingHandle,
	type RunBindingAssociation,
} from "./binding-handles.ts";
import type { ContextSnapshot, ContextSourceDrift, ContextSourceReceipt } from "./context-engine.ts";
import type { ModelRoleSelection, ModelRouteSelection } from "./model-broker.ts";
import {
	MODEL_ATTEMPT_CUSTOM_TYPE,
	MODEL_BINDING_CUSTOM_TYPE,
	serializePublicModelBrokerLedgerEntry,
	type PublicModelAttemptLedgerRecord,
	type PublicModelBindingLedgerRecord,
} from "./model-broker-ledger.ts";
import {
	createExecutionPolicyLedger,
	POLICY_APPROVAL_CUSTOM_TYPE,
	POLICY_DECISION_CUSTOM_TYPE,
	POLICY_VIOLATION_CUSTOM_TYPE,
	SANDBOX_LIFECYCLE_CUSTOM_TYPE,
	type PolicyApprovalLedgerRecord,
	type PolicyBindingLedgerRecord as ExecutionPolicyBindingLedgerRecord,
	type PolicyDecisionLedgerRecord,
	type PolicyLedgerRecord,
	type PolicyViolationLedgerRecord,
	type SandboxLifecycleLedgerRecord,
} from "./execution-policy-ledger.ts";
import {
	POLICY_BINDING_CUSTOM_TYPE,
	toPublicPolicySummary,
	type PolicyApprovalRequest,
	type PolicyApprovalOutcome,
	type PolicyApprovalSource,
	type PolicyBinding,
	type PolicyDecision,
	type PolicyDecisionOutcome,
	type PolicyEnforcement,
	type PolicyErrorCode,
	type PolicyResource,
	type PolicyAction,
	type PolicyTrust,
	type PublicPolicySummary,
	type SandboxCapabilities,
	type SandboxStatus,
} from "./execution-policy.ts";
import {
	ExternalMappingError,
	ExternalSessionMappingStore,
	isExternalExecutionRef,
	serializeExternalExecutionRef,
	type ExternalExecutionMapping,
	type ExternalExecutionRef,
	type ExternalMappingPersistenceResult,
	type ExternalMappingRequest,
	type ExternalMappingWarning,
} from "./external-session-mapping.ts";
import type { SessionEntry, SessionTreeNode } from "./session-manager.ts";

export type SessionId = string;
export type RunId = string;

/** A client request key is scoped to one persisted Session and Run operation. */
export type RunRequestScope = "start" | "resume";
export type RunRequestCommand = "run.start" | "run.resume";

const RUN_CLIENT_REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const RUN_REQUEST_FINGERPRINT_PATTERN = /^[a-f0-9]{64}$/;

/** A stable, secret-free relation persisted on the accepted Run record. */
export interface RunRequestRelation {
	readonly scope: RunRequestScope;
	readonly clientRequestId: string;
	readonly fingerprint: string;
}

/** Public request identity used by the lifecycle coordinator and integrations. */
export interface RunRequestIdentity {
	readonly scope: RunRequestScope;
	readonly clientRequestId: string;
	readonly requestFingerprint: string;
}

/**
 * Input to the request fingerprint. Prompts and images are hashed as opaque
 * values; they are never included in the canonical representation or ledger.
 * `sessionId` is the Session that owns the request relation. For a resume this
 * is the restored target Session, not the source Session currently in memory.
 */
export interface RunRequestFingerprintInput {
	readonly command: RunRequestCommand;
	readonly scope?: RunRequestScope;
	readonly sessionId: SessionId;
	readonly targetSessionId?: SessionId;
	readonly sourceRunId?: RunId;
	readonly message: string;
	readonly images?: unknown;
	readonly capabilityProfile?: string;
	readonly policyProfile?: string;
	readonly modelRoute?: ModelRouteSelection;
	readonly modelRole?: ModelRoleSelection;
	readonly external?: ExternalExecutionRef;
	readonly deadlineAt?: string;
}

/** Canonical request material used to derive a persisted fingerprint. */
export interface CanonicalRunRequest {
	readonly schemaVersion: 1;
	readonly scope: RunRequestScope;
	readonly command: RunRequestCommand;
	readonly sessionId: SessionId;
	readonly targetSessionId?: SessionId;
	readonly sourceRunId?: RunId;
	readonly messageDigest: string;
	readonly imagesDigest?: string;
	readonly capabilityProfileDigest?: string;
	readonly policyProfileDigest?: string;
	readonly modelRouteDigest?: string;
	readonly modelRoleDigest?: string;
	readonly external?: ExternalExecutionRef;
	readonly deadlineAt?: string;
}

/** Validate the public request-key contract without echoing the key. */
export function isRunClientRequestId(value: unknown): value is string {
	return typeof value === "string" && RUN_CLIENT_REQUEST_ID_PATTERN.test(value);
}

/** Compatibility aliases for callers that use the generic identifier names. */
export const isClientRequestId = isRunClientRequestId;
export const isRunRequestIdentifier = isRunClientRequestId;

export function isRunRequestScope(value: unknown): value is RunRequestScope {
	return value === "start" || value === "resume";
}

/** Validate a persisted SHA-256 request fingerprint. */
export function isRunRequestFingerprint(value: unknown): value is string {
	return typeof value === "string" && RUN_REQUEST_FINGERPRINT_PATTERN.test(value);
}

const RUN_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Validate the canonical UTC timestamp used by Run deadlines and receipts. */
export function isRunTimestamp(value: unknown): value is string {
	if (typeof value !== "string" || !RUN_TIMESTAMP_PATTERN.test(value)) return false;
	const parsed = new Date(value);
	return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

export function isRunRequestIdentity(value: unknown): value is RunRequestIdentity {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const candidate = value as Record<string, unknown>;
	return (
		isRunRequestScope(candidate.scope) &&
		isRunClientRequestId(candidate.clientRequestId) &&
		isRunRequestFingerprint(candidate.requestFingerprint)
	);
}

export function createRunRequestKey(identity: RunRequestIdentity): string {
	if (!isRunRequestIdentity(identity)) throw new TypeError("Invalid Run request identity.");
	return `${identity.scope}\u0000${identity.clientRequestId}`;
}

function digestRequestValue(value: unknown): string {
	return createHash("sha256").update(stableRequestSerialization(value), "utf8").digest("hex");
}

/**
 * Serialize request values deterministically for hashing. Raw values are only
 * held while deriving the digest; the canonical value persisted with a Run
 * contains digests, never this serialization.
 */
function stableRequestSerialization(value: unknown): string {
	if (value === null) return "null";
	if (typeof value === "string") return JSON.stringify(value);
	if (typeof value === "number") return Number.isFinite(value) ? String(value) : "null";
	if (typeof value === "boolean") return value ? "true" : "false";
	if (typeof value !== "object") return "null";
	if (Array.isArray(value)) return `[${value.map((item) => stableRequestSerialization(item)).join(",")}]`;
	const object = value as Record<string, unknown>;
	const fields: string[] = [];
	for (const key of Object.keys(object).sort((left, right) => left.localeCompare(right))) {
		const candidate = object[key];
		if (candidate === undefined) continue;
		fields.push(`${JSON.stringify(key)}:${stableRequestSerialization(candidate)}`);
	}
	return `{${fields.join(",")}}`;
}

/**
 * Build the safe canonical request. Only digests of free-form input are kept;
 * changing a prompt/image/selector still changes the fingerprint without
 * persisting the raw value.
 */
export function canonicalizeRunRequest(input: RunRequestFingerprintInput): CanonicalRunRequest {
	const external = input.external === undefined ? undefined : serializeExternalExecutionRef(input.external);
	const scope = input.scope ?? (input.command === "run.start" ? "start" : "resume");
	return {
		schemaVersion: 1,
		scope,
		command: input.command,
		sessionId: input.sessionId,
		...(input.targetSessionId === undefined ? {} : { targetSessionId: input.targetSessionId }),
		...(input.sourceRunId === undefined ? {} : { sourceRunId: input.sourceRunId }),
		messageDigest: digestRequestValue(input.message),
		...(input.images === undefined ? {} : { imagesDigest: digestRequestValue(input.images) }),
		...(input.capabilityProfile === undefined
			? {}
			: { capabilityProfileDigest: digestRequestValue(input.capabilityProfile) }),
		...(input.policyProfile === undefined ? {} : { policyProfileDigest: digestRequestValue(input.policyProfile) }),
		...(input.modelRoute === undefined ? {} : { modelRouteDigest: digestRequestValue(input.modelRoute) }),
		...(input.modelRole === undefined ? {} : { modelRoleDigest: digestRequestValue(input.modelRole) }),
		...(external === undefined ? {} : { external }),
		...(input.deadlineAt === undefined ? {} : { deadlineAt: input.deadlineAt }),
	};
}

/** Derive the stable SHA-256 identity used for request-to-run idempotence. */
export function createRunRequestFingerprint(input: unknown): string {
	if (
		typeof input === "object" &&
		input !== null &&
		!Array.isArray(input) &&
		typeof (input as { command?: unknown }).command === "string" &&
		typeof (input as { sessionId?: unknown }).sessionId === "string" &&
		typeof (input as { message?: unknown }).message === "string"
	) {
		return digestRequestValue(canonicalizeRunRequest(input as RunRequestFingerprintInput));
	}
	return digestRequestValue(input);
}

// ---- Status ----------------------------------------------------------------

export type RunStatus = "accepted" | "running" | "completed" | "failed" | "cancelled";
export type RunTerminalStatus = "completed" | "failed" | "cancelled";
export type RunRecoveryState = "interrupted";

type RunTerminationIntent = "cancel" | "deadline";

export function isTerminalStatus(status: RunStatus): status is RunTerminalStatus {
	return status === "completed" || status === "failed" || status === "cancelled";
}

// ---- Ledger -----------------------------------------------------------------

export const RUN_LEDGER_SCHEMA_VERSION = 1;
export const RUN_LEDGER_CUSTOM_TYPE = "automation.run";

/**
 * Session custom entry type for the frozen capability binding of a run. Written
 * once per accepted run that carries a binding; folded back into a redacted
 * binding history so a restarted host can audit which capability binding each
 * attempt used and can verify a resume's successor binding.
 */
export const CAPABILITY_BINDING_SCHEMA_VERSION = 1;
export const CAPABILITY_BINDING_CUSTOM_TYPE = "capability.binding";

export interface RunModelReference {
	provider: string;
	id: string;
	thinkingLevel: ThinkingLevel;
}

/** Safe model identity used for the final selected candidate in a Run receipt. */
export interface RunFinalModelReference {
	provider: string;
	id?: string;
	modelId?: string;
	thinkingLevel?: ThinkingLevel;
}

export type RunModelAttemptStatus = "started" | "completed" | "failed" | "cancelled";

export interface RunModelUsageSummary {
	input?: number;
	output?: number;
	total?: number;
	inputTokens?: number;
	outputTokens?: number;
	totalTokens?: number;
	costUsd?: number;
	cost?: number;
}

/** Metadata-only summary of one ModelBroker candidate dispatch. */
export interface RunModelAttemptSummary {
	attemptId: string;
	bindingId: string;
	candidate: RunFinalModelReference;
	order: number;
	status: RunModelAttemptStatus;
	startedAt: string;
	endedAt?: string;
	failureCategory?: string;
	usage?: RunModelUsageSummary;
	visibleOutput?: boolean;
	contextSnapshotId?: string;
	summary?: string;
}

/** Cumulative, safe budget usage/limit summary for a Run. */
export interface RunModelBudgetSummary {
	modelCalls?: number;
	inputTokens?: number;
	outputTokens?: number;
	totalTokens?: number;
	costUsd?: number;
	maxModelCalls?: number;
	maxInputTokens?: number;
	maxOutputTokens?: number;
	maxTotalTokens?: number;
	maxCostUsd?: number;
	exceeded?: boolean;
}

/** Short aliases for callers that use the Broker vocabulary. */
export type ModelAttemptSummary = RunModelAttemptSummary;
export type ModelBudgetSummary = RunModelBudgetSummary;

export interface RunRecord {
	id: RunId;
	sessionId: SessionId;
	/** Scope-explicit client request relation; absent for legacy calls. */
	requestScope?: RunRequestScope;
	clientRequestId?: string;
	requestFingerprint?: string;
	/** Safe external execution reference persisted separately in external.mapping. */
	external?: ExternalExecutionRef;
	/** Inclusive UTC deadline propagated to the model/tool/MCP/Sandbox operation. */
	deadlineAt?: string;
	sourceRunId?: RunId;
	/**
	 * Binding id of the source run this attempt resumes from. Set on run.resume
	 * when the source run's receipt carried a capabilityBindingId.
	 */
	previousBindingId?: string;
	/**
	 * Id of the frozen capability binding this run used. Set at accept time so an
	 * interrupted (never-terminal) run still carries it. Additive; older ledgers
	 * omit it. Metadata-only — never carries credentials, headers, or MCP config.
	 */
	capabilityBindingId?: string;
	/** Id of the immutable ModelBroker binding used by this Run. */
	modelBindingId?: string;
	/** Id of the source Run's ModelBroker binding when this is a resume. */
	previousModelBindingId?: string;
	/** Id of the frozen Execution Policy binding used by this Run. */
	policyBindingId?: string;
	/** Id of the source Run's Execution Policy binding when this is a resume. */
	previousPolicyBindingId?: string;
	attempt: number;
	status: RunStatus;
	model: RunModelReference;
	/** Final candidate and safe attempt/budget summaries are additive metadata. */
	finalModel?: RunFinalModelReference;
	modelAttempts?: ReadonlyArray<RunModelAttemptSummary>;
	modelBudget?: RunModelBudgetSummary;
	/** Public-safe Execution Policy summary for the accepted binding/decision. */
	policySummary?: PublicPolicySummary;
	/** Stable public-safe handles associated with this Run. */
	bindingAssociation?: RunBindingAssociation;
	startedAt?: string;
	endedAt?: string;
	terminalError?: AutomationError;
}

export interface RunUsage {
	input: number;
	output: number;
	total: number;
}

export interface RunUsageSnapshot {
	input: number;
	output: number;
	total: number;
}

export function createRunUsage(): RunUsage {
	return { input: 0, output: 0, total: 0 };
}

export interface RunReceipt {
	runId: RunId;
	sessionId: SessionId;
	/** Safe external execution reference persisted separately in external.mapping. */
	external?: ExternalExecutionRef;
	/** Inclusive UTC deadline propagated to the model/tool/MCP/Sandbox operation. */
	deadlineAt?: string;
	status: RunTerminalStatus;
	finalText?: string;
	usage: RunUsage;
	sessionFile?: string;
	terminalError?: AutomationError;
	/**
	 * Context Engine snapshot id bound to this run's model call(s).
	 * Additive; older ledgers omit it. Metadata-only — never carries raw context bodies.
	 */
	contextSnapshotId?: string;
	/**
	 * Id of the frozen CapabilityBinding this run used. Additive; older ledgers
	 * omit it. Metadata-only — never carries credentials, headers, or MCP config.
	 */
	capabilityBindingId?: string;
	/** Id of the immutable ModelBroker binding used by this Run. */
	modelBindingId?: string;
	/** Id of the source Run's ModelBroker binding when this is a resume. */
	previousModelBindingId?: string;
	/** Id of the frozen Execution Policy binding used by this Run. */
	policyBindingId?: string;
	/** Id of the source Run's Execution Policy binding when this is a resume. */
	previousPolicyBindingId?: string;
	/** Final candidate and safe attempt/budget summaries are additive metadata. */
	finalModel?: RunFinalModelReference;
	modelAttempts?: ReadonlyArray<RunModelAttemptSummary>;
	modelBudget?: RunModelBudgetSummary;
	/** Public-safe Execution Policy summary for the accepted binding/decision. */
	policySummary?: PublicPolicySummary;
	/** Stable public-safe handles associated with this Run. */
	bindingAssociation?: RunBindingAssociation;
}

export type RunStreamEvent =
	| { type: "run.started"; runId: RunId; sessionId: SessionId; sequence: number; timestamp: string }
	| {
			type: "run.event";
			runId: RunId;
			sessionId: SessionId;
			sequence: number;
			timestamp: string;
			event: AgentSessionEvent;
	  }
	| {
			type: "run.completed";
			runId: RunId;
			sessionId: SessionId;
			sequence: number;
			timestamp: string;
			receipt: RunReceipt;
	  }
	| {
			type: "run.failed";
			runId: RunId;
			sessionId: SessionId;
			sequence: number;
			timestamp: string;
			receipt: RunReceipt;
	  }
	| {
			type: "run.cancelled";
			runId: RunId;
			sessionId: SessionId;
			sequence: number;
			timestamp: string;
			receipt: RunReceipt;
	  };

export type PersistedRunLedgerEntry =
	| { schemaVersion: 1; kind: "accepted"; record: RunRecord }
	| { schemaVersion: 1; kind: "started"; runId: RunId; startedAt: string }
	| { schemaVersion: 1; kind: "terminal"; receipt: RunReceipt; endedAt: string };

/**
 * Metadata-only capability binding snapshot persisted as a Session custom entry.
 * Mirrors the shape of the Registry's redacted binding view; it deliberately
 * carries no environment values, header values, tokens, MCP config, server
 * instructions, or tool call payloads.
 */
export interface CapabilityBindingLedgerRecord {
	id: string;
	profile: string;
	createdAt: string;
	descriptors: ReadonlyArray<{ id: string; revision: string; exposedToolName?: string }>;
	decisionSummary: { allowed: number; awaitingApproval: number; denied: number };
	toolAllowlist: ReadonlyArray<string>;
}

export interface PersistedCapabilityBindingEntry {
	schemaVersion: 1;
	binding: CapabilityBindingLedgerRecord;
}

// ---- Errors ----------------------------------------------------------------

export type AutomationErrorCode =
	| "unsupported_protocol_version"
	| "host_not_initialized"
	| "session_busy"
	| "run_request_invalid"
	| "run_request_conflict"
	| "client_request_id_invalid"
	| "client_request_conflict"
	| "start_rejected"
	| "run_not_found"
	| "run_not_cancellable"
	| "run_deadline_invalid"
	| "run_deadline_exceeded"
	| "session_not_persistent"
	| "source_run_not_found"
	| "source_run_not_resumable"
	| "session_switch_cancelled"
	| "ledger_persistence_failed"
	| "audit_query_invalid"
	| "audit_cursor_invalid"
	| "audit_scope_unavailable"
	| "audit_run_not_found"
	| "audit_replay_incomplete"
	| "external_mapping_invalid"
	| "external_mapping_conflict"
	| "audit_persistence_failed"
	// Capability preflight / resume failures. These keep profile, connection,
	// authorization and binding problems in the structured Automation Host error
	// contract instead of degrading them into generic model failures.
	| "capability_profile_not_found"
	| "capability_denied"
	| "capability_approval_required"
	| "capability_name_conflict"
	| "capability_mcp_connect_failed"
	| "capability_mcp_auth_required"
	| "capability_mcp_unavailable"
	| "capability_binding_unavailable"
	// ModelBroker preflight, budget and fallback failures.
	| "model_route_not_found"
	| "model_role_not_found"
	| "model_route_invalid"
	| "model_route_unavailable"
	| "model_binding_unavailable"
	| "model_budget_exceeded"
	| "model_fallback_exhausted"
	// Execution Policy preflight / ledger failures.
	| "policy_settings_invalid"
	| "policy_profile_not_found"
	| "policy_profile_untrusted"
	| "policy_binding_failed"
	| "policy_approval_required"
	| "policy_denied"
	| "policy_violation"
	| "workspace_boundary_violation"
	| "network_policy_violation"
	| "credential_policy_violation"
	| "sandbox_required"
	| "sandbox_unavailable"
	| "sandbox_start_failed"
	| "sandbox_capability_insufficient"
	| "policy_ledger_persistence_failed"
	// Terminal run.failed receipt code; not a command-level error.
	| "model_error"
	// Task-level Human Gate control-plane errors.
	| "task_gate_invalid"
	| "task_gate_not_found"
	| "task_gate_conflict"
	| "task_gate_idempotency_conflict"
	| "task_gate_not_pending"
	| "task_gate_stage_revision_mismatch"
	| "task_gate_persistence_failed"
	// Task Graph v1 control-plane errors. Keep in sync with
	// TASK_GRAPH_ERROR_CODES in core/task-graph.ts.
	| "task_graph_invalid"
	| "task_graph_dependency_cycle"
	| "task_graph_not_found"
	| "task_graph_conflict"
	| "task_graph_idempotency_conflict"
	| "task_graph_node_not_found"
	| "task_graph_node_not_eligible"
	| "task_graph_node_conflict"
	| "task_graph_run_not_found"
	| "task_graph_run_not_terminal"
	| "task_graph_run_state_mismatch"
	| "task_graph_persistence_failed";

export interface AutomationError {
	code: AutomationErrorCode;
	message: string;
	retryable: boolean;
}

export function createAutomationError(code: AutomationErrorCode, message: string, retryable: boolean): AutomationError {
	return { code, message, retryable };
}

export function isAutomationErrorCode(value: unknown): value is AutomationErrorCode {
	return (
		value === "unsupported_protocol_version" ||
		value === "host_not_initialized" ||
		value === "session_busy" ||
		value === "run_request_invalid" ||
		value === "run_request_conflict" ||
		value === "client_request_id_invalid" ||
		value === "client_request_conflict" ||
		value === "start_rejected" ||
		value === "run_not_found" ||
		value === "run_not_cancellable" ||
		value === "run_deadline_invalid" ||
		value === "run_deadline_exceeded" ||
		value === "session_not_persistent" ||
		value === "source_run_not_found" ||
		value === "source_run_not_resumable" ||
		value === "session_switch_cancelled" ||
		value === "ledger_persistence_failed" ||
		value === "audit_query_invalid" ||
		value === "audit_cursor_invalid" ||
		value === "audit_scope_unavailable" ||
		value === "audit_run_not_found" ||
		value === "audit_replay_incomplete" ||
		value === "external_mapping_invalid" ||
		value === "external_mapping_conflict" ||
		value === "audit_persistence_failed" ||
		value === "capability_profile_not_found" ||
		value === "capability_denied" ||
		value === "capability_approval_required" ||
		value === "capability_name_conflict" ||
		value === "capability_mcp_connect_failed" ||
		value === "capability_mcp_auth_required" ||
		value === "capability_mcp_unavailable" ||
		value === "capability_binding_unavailable" ||
		value === "model_route_not_found" ||
		value === "model_role_not_found" ||
		value === "model_route_invalid" ||
		value === "model_route_unavailable" ||
		value === "model_binding_unavailable" ||
		value === "model_budget_exceeded" ||
		value === "model_fallback_exhausted" ||
		value === "policy_settings_invalid" ||
		value === "policy_profile_not_found" ||
		value === "policy_profile_untrusted" ||
		value === "policy_binding_failed" ||
		value === "policy_approval_required" ||
		value === "policy_denied" ||
		value === "policy_violation" ||
		value === "workspace_boundary_violation" ||
		value === "network_policy_violation" ||
		value === "credential_policy_violation" ||
		value === "sandbox_required" ||
		value === "sandbox_unavailable" ||
		value === "sandbox_start_failed" ||
		value === "sandbox_capability_insufficient" ||
		value === "policy_ledger_persistence_failed" ||
		value === "model_error" ||
		value === "task_gate_invalid" ||
		value === "task_gate_not_found" ||
		value === "task_gate_conflict" ||
		value === "task_gate_idempotency_conflict" ||
		value === "task_gate_not_pending" ||
		value === "task_gate_stage_revision_mismatch" ||
		value === "task_gate_persistence_failed" ||
		value === "task_graph_invalid" ||
		value === "task_graph_dependency_cycle" ||
		value === "task_graph_not_found" ||
		value === "task_graph_conflict" ||
		value === "task_graph_idempotency_conflict" ||
		value === "task_graph_node_not_found" ||
		value === "task_graph_node_not_eligible" ||
		value === "task_graph_node_conflict" ||
		value === "task_graph_run_not_found" ||
		value === "task_graph_run_not_terminal" ||
		value === "task_graph_run_state_mismatch" ||
		value === "task_graph_persistence_failed"
	);
}

// ---- Secret redaction ---------------------------------------------------------

/** Scheme with optional URL userinfo (user:pass@) — group 1 is kept, group 2 is the host/path. */
const URL_USERINFO_PATTERN = /([a-z][a-z0-9+.-]*:\/\/)(?:[^/@\s]+@)?([^\s?#]*)/gi;
/** Well-known secret assignments such as `token=...` / `authorization: Bearer <jwt>` / `api_key=...`. */
const SECRET_ASSIGNMENT_PATTERN = /\b(bearer|token|api[_-]?key|secret|password|authorization)\b\s*[:=]\s*(?:bearer\s+)?[^\s"'`,;]+/gi;
/** A bare `Bearer <token>` not preceded by a secret key assignment. */
const BEARER_TOKEN_PATTERN = /\bbearer\s+[^\s"'`,;]+/gi;

/**
 * Scrub obvious secrets from free text so error messages serialized to stdout
 * never echo credentials, header values, URL userinfo, or Bearer tokens. The
 * entire secret value is removed or replaced — it is never left partially
 * visible. Conservative: only well-known secret shapes are masked; ordinary
 * messages pass through unchanged.
 */
export function redactErrorText(text: string): string {
	const urlRedacted = text.replace(URL_USERINFO_PATTERN, "$1$2");
	const assignmentsRedacted = urlRedacted.replace(
		SECRET_ASSIGNMENT_PATTERN,
		(_match, key: string) => `${key}=[redacted]`,
	);
	return assignmentsRedacted.replace(BEARER_TOKEN_PATTERN, "[redacted]");
}

/** Clone an AutomationError with a secret-free message. */
export function redactAutomationError(error: AutomationError): AutomationError {
	const message = redactErrorText(error.message);
	return message === error.message ? error : createAutomationError(error.code, message, error.retryable);
}

// ---- Diagnostics ------------------------------------------------------------

export type LedgerDiagnostic =
	| { kind: "malformed"; entryId: string; detail: string }
	| { kind: "unknown-schema-version"; entryId: string; version: number }
	| { kind: "unknown-ledger-kind"; entryId: string; ledgerKind: string }
	| { kind: "orphan-fact"; entryId: string; runId: RunId; fact: "started" | "terminal" }
	| { kind: "duplicate-terminal"; runId: RunId }
	| { kind: "malformed-binding"; entryId: string; detail: string }
	| { kind: "mapping-conflict"; entryId: string }
	| { kind: "malformed-mapping"; entryId: string };

export function formatDiagnostic(diag: LedgerDiagnostic): string {
	switch (diag.kind) {
		case "malformed":
			return `automation.run ledger: custom entry ${diag.entryId} is malformed (${diag.detail}); skipped`;
		case "unknown-schema-version":
			return `automation.run ledger: custom entry ${diag.entryId} uses schemaVersion ${diag.version}; skipped`;
		case "unknown-ledger-kind":
			return `automation.run ledger: custom entry ${diag.entryId} has unknown kind ${diag.ledgerKind}; skipped`;
		case "orphan-fact":
			return `automation.run ledger: ${diag.fact} fact for unknown run ${diag.runId} (entry ${diag.entryId}); skipped`;
		case "duplicate-terminal":
			return `automation.run: run ${diag.runId} is already terminal; second terminal ignored`;
		case "malformed-binding":
			return `capability.binding ledger: custom entry ${diag.entryId} is malformed (${diag.detail}); skipped`;
		case "mapping-conflict":
			return `external.mapping ledger: custom entry ${diag.entryId} contradicts an existing mapping; skipped`;
		case "malformed-mapping":
			return `external.mapping ledger: custom entry ${diag.entryId} is malformed; skipped`;
	}
}

// ---- Coordinator contract ----------------------------------------------------

/** Structural subset of `SessionManager` used to persist and fold the run ledger. */
export interface RunLedgerSession {
	getSessionId(): string;
	getSessionFile(): string | undefined;
	appendCustomEntry(customType: string, data?: unknown): string;
	getEntries(): SessionEntry[];
}

export interface RunResult {
	record: RunRecord;
	receipt?: RunReceipt;
	recovery?: RunRecoveryState;
	policySummary?: PublicPolicySummary;
}

/** Persisted request relation and the current reconstructed Run result. */
export interface RunRequestLookup {
	readonly clientRequestId: string;
	readonly scope: RunRequestScope;
	readonly fingerprint: string;
	readonly result: RunResult;
}

export type RunRequestReservation =
	| { kind: "new"; reservation: RunReservation }
	| { kind: "duplicate"; result: RunResult };

export interface AcceptOptions {
	runId?: RunId;
	/** Scope-explicit request identity. All three fields are required together. */
	requestScope?: RunRequestScope;
	clientRequestId?: string;
	requestFingerprint?: string;
	/** Optional validated external execution reference for this Run. */
	external?: ExternalExecutionRef;
	/** Inclusive UTC deadline for this Run's model/tool/MCP/Sandbox operation. */
	deadlineAt?: string;
	sourceRunId?: RunId;
	/** Binding id of the source run this attempt resumes from. */
	previousBindingId?: string;
	/** ModelBroker binding metadata; additive and optional for legacy callers. */
	modelBindingId?: string;
	previousModelBindingId?: string;
	/** Expected source Execution Policy binding id for a resume successor. */
	previousPolicyBindingId?: string;
	attempt: number;
	model: RunModelReference;
	finalModel?: RunFinalModelReference;
	modelAttempts?: ReadonlyArray<RunModelAttemptSummary>;
	modelBudget?: RunModelBudgetSummary;
	/**
	 * Metadata-only binding snapshot to persist as a capability.binding custom
	 * entry. Its id becomes the run receipt's capabilityBindingId.
	 */
	capabilityBinding?: CapabilityBindingLedgerRecord;
	/** Frozen Execution Policy binding resolved for this Run. */
	policyBinding?: PolicyBinding;
	/** Optional safe policy facts to persist with the accepted run. */
	policyDecision?: PolicyDecision;
	policyApproval?: PolicyApprovalRequest;
	sandboxLifecycle?: SandboxLifecycleLedgerRecord;
	policyViolation?: PolicyViolationLedgerRecord;
	/** Public-safe Execution Policy summary. Derived from policyBinding when omitted. */
	policySummary?: PublicPolicySummary;
	/** Public-safe binding handles frozen for this Run. */
	bindingHandles?: ReadonlyArray<BindingHandle>;
}

export interface RunReservation {
	readonly sessionId: SessionId;
	/** Buffer a session event observed during preflight; flushed by start(). */
	captureSessionEvent(event: AgentSessionEvent): void;
	/** Persist the accepted fact and create the run. Throws if already accepted/released. */
	accept(options: AcceptOptions): RunHandle;
	/** Discard the reservation without persisting anything. */
	release(): void;
}

export interface SettleInput {
	outcome: "completed" | "failed";
	terminalError?: AutomationError;
	finalText?: string;
	currentUsage?: RunUsageSnapshot;
	/** Snapshot id explicitly bound to this run's model call(s). */
	contextSnapshotId?: string;
	/** Additive ModelBroker receipt metadata. */
	modelBindingId?: string;
	previousModelBindingId?: string;
	policyDecision?: PolicyDecision;
	policyApproval?: PolicyApprovalRequest;
	sandboxLifecycle?: SandboxLifecycleLedgerRecord;
	policyViolation?: PolicyViolationLedgerRecord;
	policySummary?: PublicPolicySummary;
	finalModel?: RunFinalModelReference;
	modelAttempts?: ReadonlyArray<RunModelAttemptSummary>;
	modelBudget?: RunModelBudgetSummary;
}

export interface RunHandle {
	readonly runId: RunId;
	readonly sessionId: SessionId;
	readonly record: RunRecord;
	/** Highest sequence emitted so far (0 before start()). */
	readonly sequence: number;
	readonly cancelled: boolean;
	readonly emitted: readonly RunStreamEvent[];
	readonly terminal: RunStreamEvent | undefined;
	/** Persist the started fact and flush the buffered session events. */
	start(): RunStreamEvent[];
	/**
	 * Buffer a session event before start, or wrap it as a run.event while running.
	 * Returns the emitted event when running; undefined when buffered or terminal.
	 */
	captureSessionEvent(event: AgentSessionEvent): RunStreamEvent | undefined;
	/** Record the first cancellation intent only; the terminal event is produced by settle(). */
	requestCancel(): void;
	/** Record the first deadline intent only; settle() produces the failed terminal event. */
	requestDeadlineExceeded(): void;
	setUsageBaseline(baseline: RunUsageSnapshot): void;
	computeUsageDelta(current: RunUsageSnapshot): RunUsage;
	finalText(): string;
	/** Persist the unique terminal fact and emit the unique terminal event. */
	settle(input: SettleInput): RunStreamEvent | undefined;
	receipt(): RunReceipt | undefined;
	result(): RunResult;
}

export interface RunLifecycleCoordinatorOptions {
	/** ISO timestamp source. Defaults to Date.now().toISOString(). */
	now?: () => string;
	/** Run id generator for auto-assigned ids. Defaults to a fresh randomUUID per coordinator. */
	runId?: () => RunId;
	/** Diagnostics sink; defaults to stderr. */
	diagnostics?: (message: string) => void;
}

export interface RunLifecycleCoordinator {
	readonly sessionId: SessionId;
	readonly activeRun: RunResult | undefined;
	/** Synchronously lock the session; throws session_busy when a run is active. */
	reserve(): RunReservation;
	/** Resolve a retry key before taking the Session reservation. */
	reserveForRequest(request: RunRequestIdentity): RunRequestReservation;
	/** Return the original Run for a matching retry key, or throw on conflict. */
	getRunForRequest(request: RunRequestIdentity): RunResult | undefined;
	getRun(runId: RunId): RunResult | undefined;
	/** Find the durable request relation without creating another Run. */
	getRunByClientRequestId(clientRequestId: string, scope?: RunRequestScope): RunRequestLookup | undefined;
	getActiveRun(): RunResult | undefined;
	rebuildIndex(): ReadonlyMap<RunId, RunResult>;
	/** Fold the Session's capability.binding custom entries into a redacted history. */
	getCapabilityBindings(): ReadonlyMap<string, CapabilityBindingLedgerRecord>;
	/** Append a schemaVersion 1 capability.binding custom entry. */
	persistCapabilityBinding(binding: CapabilityBindingLedgerRecord): void;
	/** Persist a validated external mapping without touching Run or model state. */
	persistExternalMapping(request: ExternalMappingRequest): ExternalMappingPersistenceResult;
	/** Validate an external mapping without appending a Session entry. */
	validateExternalMapping(request: ExternalMappingRequest): void;
	/** Folded external mappings recovered from Session custom entries. */
	getExternalMappings(): ReadonlyArray<ExternalExecutionMapping>;
	getExternalMappingWarnings(): readonly ExternalMappingWarning[];
	diagnostics(): readonly LedgerDiagnostic[];
}

// ---- Ledger parsing ----------------------------------------------------------

type ParsedLedgerEntry =
	| { ok: true; entry: PersistedRunLedgerEntry }
	| { ok: false; reason: "malformed"; detail: string }
	| { ok: false; reason: "unknown-schema-version"; version: number }
	| { ok: false; reason: "unknown-ledger-kind"; kind: string };

function isThinkingLevel(value: unknown): value is ThinkingLevel {
	return (
		value === "off" ||
		value === "minimal" ||
		value === "low" ||
		value === "medium" ||
		value === "high" ||
		value === "xhigh" ||
		value === "max"
	);
}

function isRunStatus(value: unknown): value is RunStatus {
	return (
		value === "accepted" ||
		value === "running" ||
		value === "completed" ||
		value === "failed" ||
		value === "cancelled"
	);
}

function isRunTerminalStatus(value: unknown): value is RunTerminalStatus {
	return value === "completed" || value === "failed" || value === "cancelled";
}

function isAutomationError(value: unknown): value is AutomationError {
	if (typeof value !== "object" || value === null) return false;
	const obj = value as Record<string, unknown>;
	return isAutomationErrorCode(obj.code) && typeof obj.message === "string" && typeof obj.retryable === "boolean";
}

function isRunModelReference(value: unknown): value is RunModelReference {
	if (typeof value !== "object" || value === null) return false;
	const obj = value as Record<string, unknown>;
	return typeof obj.provider === "string" && typeof obj.id === "string" && isThinkingLevel(obj.thinkingLevel);
}

function isRunUsage(value: unknown): value is RunUsage {
	if (typeof value !== "object" || value === null) return false;
	const obj = value as Record<string, unknown>;
	return (
		typeof obj.input === "number" &&
		typeof obj.output === "number" &&
		typeof obj.total === "number" &&
		Number.isFinite(obj.input) &&
		Number.isFinite(obj.output) &&
		Number.isFinite(obj.total) &&
		obj.input >= 0 &&
		obj.output >= 0 &&
		obj.total >= 0
	);
}

const RUN_METADATA_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const RUN_METADATA_TEXT_PATTERN = /^[^\u0000-\u001f\u007f\r\n]{1,512}$/;

function isRunMetadataId(value: unknown): value is string {
	return typeof value === "string" && RUN_METADATA_ID_PATTERN.test(value);
}

function isRunMetadataText(value: unknown): value is string {
	return (
		typeof value === "string" &&
		RUN_METADATA_TEXT_PATTERN.test(value) &&
		!value.includes("://") &&
		!value.includes("@")
	);
}

function isRunFinalModelReference(value: unknown): value is RunFinalModelReference {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const obj = value as Record<string, unknown>;
	if (!isRunMetadataText(obj.provider)) return false;
	if (obj.id === undefined && obj.modelId === undefined) return false;
	if (obj.id !== undefined && !isRunMetadataText(obj.id)) return false;
	if (obj.modelId !== undefined && !isRunMetadataText(obj.modelId)) return false;
	return obj.thinkingLevel === undefined || isThinkingLevel(obj.thinkingLevel);
}

function isRunModelUsageSummary(value: unknown): value is RunModelUsageSummary {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const obj = value as Record<string, unknown>;
	const fields: (keyof RunModelUsageSummary)[] = [
		"input",
		"output",
		"total",
		"inputTokens",
		"outputTokens",
		"totalTokens",
		"costUsd",
		"cost",
	];
	return fields.every((field) => {
		const candidate = obj[field];
		return candidate === undefined || (typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0);
	});
}

function isRunModelAttemptSummary(value: unknown): value is RunModelAttemptSummary {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const obj = value as Record<string, unknown>;
	if (
		!isRunMetadataId(obj.attemptId) ||
		!isRunMetadataId(obj.bindingId) ||
		!isRunFinalModelReference(obj.candidate) ||
		!Number.isInteger(obj.order) ||
		(obj.order as number) < 0 ||
		(obj.status !== "started" &&
			obj.status !== "completed" &&
			obj.status !== "failed" &&
			obj.status !== "cancelled") ||
		!isRunMetadataText(obj.startedAt)
	) {
		return false;
	}
	if (obj.endedAt !== undefined && !isRunMetadataText(obj.endedAt)) return false;
	if (obj.failureCategory !== undefined && !isRunMetadataId(obj.failureCategory)) return false;
	if (obj.usage !== undefined && !isRunModelUsageSummary(obj.usage)) return false;
	if (obj.visibleOutput !== undefined && typeof obj.visibleOutput !== "boolean") return false;
	if (obj.contextSnapshotId !== undefined && !isRunMetadataId(obj.contextSnapshotId)) return false;
	if (obj.summary !== undefined && !isRunMetadataText(obj.summary)) return false;
	return true;
}

function isRunModelBudgetSummary(value: unknown): value is RunModelBudgetSummary {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const obj = value as Record<string, unknown>;
	const fields: (keyof RunModelBudgetSummary)[] = [
		"modelCalls",
		"inputTokens",
		"outputTokens",
		"totalTokens",
		"costUsd",
		"maxModelCalls",
		"maxInputTokens",
		"maxOutputTokens",
		"maxTotalTokens",
		"maxCostUsd",
		"exceeded",
	];
	return fields.every((field) => {
		const candidate = obj[field];
		return field === "exceeded"
			? candidate === undefined || typeof candidate === "boolean"
			: candidate === undefined || (typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0);
	});
}

function isRunRequestRelation(value: unknown): value is RunRequestRelation {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const obj = value as Record<string, unknown>;
	return (
		isRunRequestScope(obj.scope) &&
		isRunClientRequestId(obj.clientRequestId) &&
		isRunRequestFingerprint(obj.fingerprint)
	);
}

function requestRelationFromRecord(record: RunRecord): RunRequestRelation | undefined {
	const hasRelation =
		record.requestScope !== undefined || record.clientRequestId !== undefined || record.requestFingerprint !== undefined;
	if (!hasRelation) return undefined;
	const relation = {
		scope: record.requestScope,
		clientRequestId: record.clientRequestId,
		fingerprint: record.requestFingerprint,
	};
	return isRunRequestRelation(relation) ? relation : undefined;
}

function validateRequestRelationOptions(options: {
	requestScope?: RunRequestScope;
	clientRequestId?: string;
	requestFingerprint?: string;
}): void {
	const hasRelation =
		options.requestScope !== undefined || options.clientRequestId !== undefined || options.requestFingerprint !== undefined;
	if (!hasRelation) return;
	if (
		!isRunRequestScope(options.requestScope) ||
		!isRunClientRequestId(options.clientRequestId) ||
		!isRunRequestFingerprint(options.requestFingerprint)
	) {
		throw createAutomationError("client_request_id_invalid", "The client request identity is invalid.", false);
	}
}

function requestIdentityFromOptions(options: {
	requestScope?: unknown;
	clientRequestId?: unknown;
	requestFingerprint?: unknown;
}): RunRequestIdentity | undefined {
	const hasIdentity =
		options.requestScope !== undefined || options.clientRequestId !== undefined || options.requestFingerprint !== undefined;
	if (!hasIdentity) return undefined;
	const identity = {
		scope: options.requestScope,
		clientRequestId: options.clientRequestId,
		requestFingerprint: options.requestFingerprint,
	};
	if (!isRunRequestIdentity(identity)) {
		throw createAutomationError(
			"run_request_invalid",
			"Run request idempotency metadata must include a valid scope, clientRequestId, and requestFingerprint.",
			false,
		);
	}
	return identity;
}

function runRequestConflictError(): AutomationError {
	return createAutomationError(
		"run_request_conflict",
		"clientRequestId is already associated with a different Run request.",
		false,
	);
}

function requestIdentityFromRecord(record: RunRecord): RunRequestIdentity | undefined {
	if (record.requestScope === undefined && record.clientRequestId === undefined && record.requestFingerprint === undefined) {
		return undefined;
	}
	const identity = {
		scope: record.requestScope,
		clientRequestId: record.clientRequestId,
		requestFingerprint: record.requestFingerprint,
	};
	return isRunRequestIdentity(identity) ? identity : undefined;
}

function isPolicyTrust(value: unknown): value is PolicyTrust {
	return value === "trusted" || value === "untrusted";
}

function isPolicyEnforcement(value: unknown): value is PolicyEnforcement {
	return value === "legacy" || value === "host" || value === "sandbox";
}

function isPolicyResource(value: unknown): value is PolicyResource {
	return (
		value === "capability.invoke" ||
		value === "filesystem.read" ||
		value === "filesystem.find" ||
		value === "filesystem.grep" ||
		value === "filesystem.write" ||
		value === "process.spawn" ||
		value === "network.connect" ||
		value === "credential.expose" ||
		value === "sandbox.prepare"
	);
}

function isPolicyAction(value: unknown): value is PolicyAction {
	return value === "allow" || value === "ask" || value === "deny";
}

function isPolicyDecisionOutcome(value: unknown): value is PolicyDecisionOutcome {
	return value === "allow" || value === "ask" || value === "deny" || value === "sandbox_required";
}

function isPolicyApprovalOutcome(value: unknown): value is PolicyApprovalOutcome {
	return value === "approved" || value === "rejected";
}

function isPolicyApprovalSource(value: unknown): value is PolicyApprovalSource {
	return value === "interactive" || value === "rpc" || value === "sdk" || value === "system";
}

function isSandboxStatus(value: unknown): value is SandboxStatus {
	return (
		value === "not_required" ||
		value === "unavailable" ||
		value === "preparing" ||
		value === "ready" ||
		value === "failed" ||
		value === "disposed"
	);
}

function isPolicyErrorCode(value: unknown): value is PolicyErrorCode {
	return (
		value === "policy_settings_invalid" ||
		value === "policy_profile_not_found" ||
		value === "policy_profile_untrusted" ||
		value === "policy_binding_failed" ||
		value === "policy_approval_required" ||
		value === "policy_denied" ||
		value === "policy_violation" ||
		value === "workspace_boundary_violation" ||
		value === "network_policy_violation" ||
		value === "credential_policy_violation" ||
		value === "sandbox_required" ||
		value === "sandbox_unavailable" ||
		value === "sandbox_start_failed" ||
		value === "sandbox_capability_insufficient" ||
		value === "policy_ledger_persistence_failed"
	);
}

function isSandboxCapabilities(value: unknown): value is SandboxCapabilities {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const obj = value as Record<string, unknown>;
	return (
		typeof obj.filesystem === "boolean" &&
		typeof obj.process === "boolean" &&
		typeof obj.network === "boolean" &&
		typeof obj.credentialIsolation === "boolean"
	);
}

function cloneSandboxCapabilities(value: SandboxCapabilities): SandboxCapabilities {
	return {
		filesystem: value.filesystem,
		process: value.process,
		network: value.network,
		credentialIsolation: value.credentialIsolation,
	};
}

function isPublicPolicySummary(value: unknown): value is PublicPolicySummary {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const obj = value as Record<string, unknown>;
	if (
		!isRunMetadataId(obj.bindingId) ||
		!isRunMetadataId(obj.profileId) ||
		!isRunMetadataId(obj.profileRevision) ||
		!isPolicyTrust(obj.projectTrust) ||
		!isPolicyEnforcement(obj.enforcement) ||
		!isSandboxStatus(obj.sandboxStatus) ||
		!isSandboxCapabilities(obj.sandboxCapabilities)
	) {
		return false;
	}
	if (obj.sandboxProviderId !== undefined && !isRunMetadataId(obj.sandboxProviderId)) return false;
	if (obj.resource !== undefined && !isPolicyResource(obj.resource)) return false;
	if (obj.action !== undefined && !isPolicyAction(obj.action)) return false;
	if (obj.outcome !== undefined && !isPolicyDecisionOutcome(obj.outcome)) return false;
	if (obj.reasonCode !== undefined && !isPolicyErrorCode(obj.reasonCode)) return false;
	if (obj.requestId !== undefined && !isRunMetadataId(obj.requestId)) return false;
	if (obj.timestamp !== undefined && !isRunMetadataText(obj.timestamp)) return false;
	return true;
}

function clonePublicPolicySummary(value: PublicPolicySummary): PublicPolicySummary | undefined {
	if (!isPublicPolicySummary(value)) return undefined;
	return {
		bindingId: value.bindingId,
		profileId: value.profileId,
		profileRevision: value.profileRevision,
		projectTrust: value.projectTrust,
		enforcement: value.enforcement,
		...(value.sandboxProviderId === undefined ? {} : { sandboxProviderId: value.sandboxProviderId }),
		sandboxStatus: value.sandboxStatus,
		sandboxCapabilities: cloneSandboxCapabilities(value.sandboxCapabilities),
		...(value.resource === undefined ? {} : { resource: value.resource }),
		...(value.action === undefined ? {} : { action: value.action }),
		...(value.outcome === undefined ? {} : { outcome: value.outcome }),
		...(value.reasonCode === undefined ? {} : { reasonCode: value.reasonCode }),
		...(value.requestId === undefined ? {} : { requestId: value.requestId }),
		...(value.timestamp === undefined ? {} : { timestamp: value.timestamp }),
	};
}

function publicPolicySummaryFrom(
	binding: PolicyBinding,
	summary?: PublicPolicySummary,
): PublicPolicySummary | undefined {
	if (summary !== undefined) return clonePublicPolicySummary(summary);
	return clonePublicPolicySummary(toPublicPolicySummary(binding));
}

function cloneRunFinalModel(value: RunFinalModelReference): RunFinalModelReference | undefined {
	if (!isRunFinalModelReference(value)) return undefined;
	const copy: RunFinalModelReference = { provider: value.provider };
	if (value.id !== undefined) copy.id = value.id;
	if (value.modelId !== undefined) copy.modelId = value.modelId;
	if (value.thinkingLevel !== undefined) copy.thinkingLevel = value.thinkingLevel;
	return copy;
}

function cloneRunModelAttempt(value: RunModelAttemptSummary): RunModelAttemptSummary | undefined {
	if (!isRunModelAttemptSummary(value)) return undefined;
	const candidate = cloneRunFinalModel(value.candidate);
	if (candidate === undefined) return undefined;
	const copy: RunModelAttemptSummary = {
		attemptId: value.attemptId,
		bindingId: value.bindingId,
		candidate,
		order: value.order,
		status: value.status,
		startedAt: value.startedAt,
	};
	if (value.endedAt !== undefined) copy.endedAt = value.endedAt;
	if (value.failureCategory !== undefined) copy.failureCategory = value.failureCategory;
	if (value.usage !== undefined) copy.usage = { ...value.usage };
	if (value.visibleOutput !== undefined) copy.visibleOutput = value.visibleOutput;
	if (value.contextSnapshotId !== undefined) copy.contextSnapshotId = value.contextSnapshotId;
	if (value.summary !== undefined) {
		const summary = redactErrorText(value.summary);
		if (!summary.includes("://") && !summary.includes("/") && !summary.includes("\\")) copy.summary = summary;
	}
	return copy;
}

function cloneRunModelAttempts(value: ReadonlyArray<RunModelAttemptSummary>): RunModelAttemptSummary[] {
	return value.map((attempt) => cloneRunModelAttempt(attempt)).filter((attempt): attempt is RunModelAttemptSummary => attempt !== undefined);
}

function cloneRunModelBudget(value: RunModelBudgetSummary): RunModelBudgetSummary | undefined {
	if (!isRunModelBudgetSummary(value)) return undefined;
	return {
		...(value.modelCalls === undefined ? {} : { modelCalls: value.modelCalls }),
		...(value.inputTokens === undefined ? {} : { inputTokens: value.inputTokens }),
		...(value.outputTokens === undefined ? {} : { outputTokens: value.outputTokens }),
		...(value.totalTokens === undefined ? {} : { totalTokens: value.totalTokens }),
		...(value.costUsd === undefined ? {} : { costUsd: value.costUsd }),
		...(value.maxModelCalls === undefined ? {} : { maxModelCalls: value.maxModelCalls }),
		...(value.maxInputTokens === undefined ? {} : { maxInputTokens: value.maxInputTokens }),
		...(value.maxOutputTokens === undefined ? {} : { maxOutputTokens: value.maxOutputTokens }),
		...(value.maxTotalTokens === undefined ? {} : { maxTotalTokens: value.maxTotalTokens }),
		...(value.maxCostUsd === undefined ? {} : { maxCostUsd: value.maxCostUsd }),
		...(value.exceeded === undefined ? {} : { exceeded: value.exceeded }),
	};
}

function isRunRecord(value: unknown): value is RunRecord {
	if (typeof value !== "object" || value === null) return false;
	const obj = value as Record<string, unknown>;
	if (typeof obj.id !== "string" || typeof obj.sessionId !== "string") return false;
	const hasRequestRelation =
		obj.requestScope !== undefined || obj.clientRequestId !== undefined || obj.requestFingerprint !== undefined;
	if (
		hasRequestRelation &&
		!isRunRequestRelation({
			scope: obj.requestScope,
			clientRequestId: obj.clientRequestId,
			fingerprint: obj.requestFingerprint,
		})
	)
		return false;
	if (obj.external !== undefined && !isExternalExecutionRef(obj.external)) return false;
	if (obj.deadlineAt !== undefined && !isRunTimestamp(obj.deadlineAt)) return false;
	if (
		obj.bindingAssociation !== undefined &&
		(parseRunBindingAssociation(obj.bindingAssociation) === undefined ||
			parseRunBindingAssociation(obj.bindingAssociation)?.runId !== obj.id)
	)
		return false;
	if (typeof obj.attempt !== "number") return false;
	if (!isRunStatus(obj.status)) return false;
	if (!isRunModelReference(obj.model)) return false;
	if (obj.sourceRunId !== undefined && typeof obj.sourceRunId !== "string") return false;
	if (obj.previousBindingId !== undefined && typeof obj.previousBindingId !== "string") return false;
	if (obj.capabilityBindingId !== undefined && typeof obj.capabilityBindingId !== "string") return false;
	if (obj.modelBindingId !== undefined && !isRunMetadataId(obj.modelBindingId)) return false;
	if (obj.previousModelBindingId !== undefined && !isRunMetadataId(obj.previousModelBindingId)) return false;
	if (obj.policyBindingId !== undefined && !isRunMetadataId(obj.policyBindingId)) return false;
	if (obj.previousPolicyBindingId !== undefined && !isRunMetadataId(obj.previousPolicyBindingId)) return false;
	if (obj.finalModel !== undefined && !isRunFinalModelReference(obj.finalModel)) return false;
	if (obj.modelAttempts !== undefined && (!Array.isArray(obj.modelAttempts) || obj.modelAttempts.some((attempt) => !isRunModelAttemptSummary(attempt)))) {
		return false;
	}
	if (obj.modelBudget !== undefined && !isRunModelBudgetSummary(obj.modelBudget)) return false;
	if (obj.policySummary !== undefined && !isPublicPolicySummary(obj.policySummary)) return false;
	if (obj.startedAt !== undefined && typeof obj.startedAt !== "string") return false;
	if (obj.endedAt !== undefined && typeof obj.endedAt !== "string") return false;
	if (obj.terminalError !== undefined && !isAutomationError(obj.terminalError)) return false;
	return true;
}

function isRunReceipt(value: unknown): value is RunReceipt {
	if (typeof value !== "object" || value === null) return false;
	const obj = value as Record<string, unknown>;
	if (typeof obj.runId !== "string" || typeof obj.sessionId !== "string") return false;
	if (obj.external !== undefined && !isExternalExecutionRef(obj.external)) return false;
	if (obj.deadlineAt !== undefined && !isRunTimestamp(obj.deadlineAt)) return false;
	if (
		obj.bindingAssociation !== undefined &&
		(parseRunBindingAssociation(obj.bindingAssociation) === undefined ||
			parseRunBindingAssociation(obj.bindingAssociation)?.runId !== obj.runId)
	)
		return false;
	if (!isRunTerminalStatus(obj.status)) return false;
	if (!isRunUsage(obj.usage)) return false;
	if (obj.finalText !== undefined && typeof obj.finalText !== "string") return false;
	if (obj.sessionFile !== undefined && typeof obj.sessionFile !== "string") return false;
	if (obj.terminalError !== undefined && !isAutomationError(obj.terminalError)) return false;
	if (obj.contextSnapshotId !== undefined && typeof obj.contextSnapshotId !== "string") return false;
	if (obj.capabilityBindingId !== undefined && typeof obj.capabilityBindingId !== "string") return false;
	if (obj.modelBindingId !== undefined && !isRunMetadataId(obj.modelBindingId)) return false;
	if (obj.previousModelBindingId !== undefined && !isRunMetadataId(obj.previousModelBindingId)) return false;
	if (obj.policyBindingId !== undefined && !isRunMetadataId(obj.policyBindingId)) return false;
	if (obj.previousPolicyBindingId !== undefined && !isRunMetadataId(obj.previousPolicyBindingId)) return false;
	if (obj.finalModel !== undefined && !isRunFinalModelReference(obj.finalModel)) return false;
	if (obj.modelAttempts !== undefined && (!Array.isArray(obj.modelAttempts) || obj.modelAttempts.some((attempt) => !isRunModelAttemptSummary(attempt)))) {
		return false;
	}
	if (obj.modelBudget !== undefined && !isRunModelBudgetSummary(obj.modelBudget)) return false;
	if (obj.policySummary !== undefined && !isPublicPolicySummary(obj.policySummary)) return false;
	return true;
}

function parseLedgerEntry(value: unknown): ParsedLedgerEntry {
	if (typeof value !== "object" || value === null) {
		return { ok: false, reason: "malformed", detail: "data is not an object" };
	}
	const obj = value as Record<string, unknown>;
	const schemaVersion = obj.schemaVersion;
	if (typeof schemaVersion !== "number") {
		return { ok: false, reason: "malformed", detail: "schemaVersion is not a number" };
	}
	if (schemaVersion !== RUN_LEDGER_SCHEMA_VERSION) {
		return { ok: false, reason: "unknown-schema-version", version: schemaVersion };
	}
	const kind = obj.kind;
	if (typeof kind !== "string") {
		return { ok: false, reason: "malformed", detail: "kind is missing" };
	}
	if (kind === "accepted") {
		if (!isRunRecord(obj.record)) {
			return { ok: false, reason: "malformed", detail: "accepted entry has an invalid record" };
		}
		return { ok: true, entry: { schemaVersion: 1, kind: "accepted", record: obj.record } };
	}
	if (kind === "started") {
		if (typeof obj.runId !== "string" || typeof obj.startedAt !== "string") {
			return { ok: false, reason: "malformed", detail: "started entry lacks runId/startedAt" };
		}
		return { ok: true, entry: { schemaVersion: 1, kind: "started", runId: obj.runId, startedAt: obj.startedAt } };
	}
	if (kind === "terminal") {
		if (typeof obj.endedAt !== "string" || !isRunReceipt(obj.receipt)) {
			return { ok: false, reason: "malformed", detail: "terminal entry has an invalid receipt/endedAt" };
		}
		return { ok: true, entry: { schemaVersion: 1, kind: "terminal", receipt: obj.receipt, endedAt: obj.endedAt } };
	}
	return { ok: false, reason: "unknown-ledger-kind", kind };
}

function toDiagnostic(parsed: Extract<ParsedLedgerEntry, { ok: false }>, entryId: string): LedgerDiagnostic {
	if (parsed.reason === "malformed") {
		return { kind: "malformed", entryId, detail: parsed.detail };
	}
	if (parsed.reason === "unknown-schema-version") {
		return { kind: "unknown-schema-version", entryId, version: parsed.version };
	}
	return { kind: "unknown-ledger-kind", entryId, ledgerKind: parsed.kind };
}

// ---- Capability binding ledger parsing -----------------------------------------

function isCapabilityBindingLedgerRecord(value: unknown): value is CapabilityBindingLedgerRecord {
	if (typeof value !== "object" || value === null) return false;
	const obj = value as Record<string, unknown>;
	if (typeof obj.id !== "string" || typeof obj.profile !== "string" || typeof obj.createdAt !== "string") return false;
	if (!Array.isArray(obj.descriptors)) return false;
	for (const descriptor of obj.descriptors) {
		if (typeof descriptor !== "object" || descriptor === null) return false;
		const ref = descriptor as Record<string, unknown>;
		if (typeof ref.id !== "string" || typeof ref.revision !== "string") return false;
		if (ref.exposedToolName !== undefined && typeof ref.exposedToolName !== "string") return false;
	}
	const summary = obj.decisionSummary;
	if (typeof summary !== "object" || summary === null) return false;
	const decisionSummary = summary as Record<string, unknown>;
	if (
		typeof decisionSummary.allowed !== "number" ||
		typeof decisionSummary.awaitingApproval !== "number" ||
		typeof decisionSummary.denied !== "number"
	) {
		return false;
	}
	if (!Array.isArray(obj.toolAllowlist) || obj.toolAllowlist.some((name) => typeof name !== "string")) return false;
	return true;
}

function parseCapabilityBindingEntry(
	value: unknown,
	entryId: string,
):
	| { ok: true; entry: PersistedCapabilityBindingEntry }
	| { ok: false; diag: { kind: "malformed-binding"; entryId: string; detail: string } } {
	if (typeof value !== "object" || value === null) {
		return { ok: false, diag: { kind: "malformed-binding", entryId, detail: "data is not an object" } };
	}
	const obj = value as Record<string, unknown>;
	if (obj.schemaVersion !== CAPABILITY_BINDING_SCHEMA_VERSION) {
		return {
			ok: false,
			diag: {
				kind: "malformed-binding",
				entryId,
				detail: `schemaVersion is not ${CAPABILITY_BINDING_SCHEMA_VERSION}`,
			},
		};
	}
	if (!isCapabilityBindingLedgerRecord(obj.binding)) {
		return { ok: false, diag: { kind: "malformed-binding", entryId, detail: "binding is invalid" } };
	}
	return { ok: true, entry: { schemaVersion: 1, binding: obj.binding } };
}

/**
 * Fold the Session's `capability.binding` custom entries into a redacted binding
 * history keyed by binding id (later records for the same id win). Malformed
 * entries are skipped and reported through the optional diagnostics sink.
 */
export function foldCapabilityBindingEntries(
	entries: ReadonlyArray<SessionEntry>,
	diagnostics?: (diag: LedgerDiagnostic) => void,
): ReadonlyMap<string, CapabilityBindingLedgerRecord> {
	const bindings = new Map<string, CapabilityBindingLedgerRecord>();
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== CAPABILITY_BINDING_CUSTOM_TYPE) continue;
		const parsed = parseCapabilityBindingEntry(entry.data, entry.id);
		if (!parsed.ok) {
			diagnostics?.(parsed.diag);
			continue;
		}
		bindings.set(parsed.entry.binding.id, parsed.entry.binding);
	}
	return bindings;
}

// ---- Public-safe serialization --------------------------------------------------

/**
 * Current-format opaque capability values are fixed-width base64url HMAC tokens
 * under a `source:`/`rev:`/`binding:` prefix, derived by the installation
 * identity. Legacy or malformed ids — raw source text, paths, URL credentials,
 * keyless digests — never match these patterns, so the public-safe serializers
 * below omit them instead of ever echoing source-derived text. The internal
 * replay path is untouched: raw legacy ids stay available so run.resume can
 * still fail closed against a recorded binding.
 */
const OPAQUE_BINDING_ID_PATTERN = /^binding:[A-Za-z0-9_-]{43}$/;
const OPAQUE_REVISION_PATTERN = /^rev:[A-Za-z0-9_-]{43}$/;
const OPAQUE_DESCRIPTOR_ID_PATTERN = /^([a-z_]+):source:[A-Za-z0-9_-]{43}:(.+)$/;

const OPAQUE_CAPABILITY_KINDS = new Set([
	"builtin_tool",
	"extension_tool",
	"sdk_tool",
	"skill",
	"extension",
	"mcp_server",
	"mcp_tool",
]);

/** True when {@link value} is a current-format opaque capability binding id. */
export function isOpaqueCapabilityBindingId(value: unknown): value is string {
	return typeof value === "string" && OPAQUE_BINDING_ID_PATTERN.test(value);
}

/** True when {@link value} is a current-format opaque capability revision. */
export function isOpaqueCapabilityRevision(value: unknown): value is string {
	return typeof value === "string" && OPAQUE_REVISION_PATTERN.test(value);
}

/** True when {@link value} is a current-format opaque capability descriptor id. */
export function isOpaqueCapabilityDescriptorId(value: unknown): value is string {
	if (typeof value !== "string") return false;
	const match = OPAQUE_DESCRIPTOR_ID_PATTERN.exec(value);
	return match !== null && OPAQUE_CAPABILITY_KINDS.has(match[1]);
}

export interface PublicCapabilityBindingDescriptorRef {
	id: string;
	revision: string;
	exposedToolName?: string;
}

export interface PublicCapabilityBindingLedgerRecord {
	id: string;
	profile: string;
	createdAt: string;
	descriptors: ReadonlyArray<PublicCapabilityBindingDescriptorRef>;
	decisionSummary: { allowed: number; awaitingApproval: number; denied: number };
	toolAllowlist: ReadonlyArray<string>;
}

export interface PublicRunRecord {
	id: RunId;
	sessionId: SessionId;
	requestScope?: RunRequestScope;
	clientRequestId?: string;
	requestFingerprint?: string;
	external?: ExternalExecutionRef;
	deadlineAt?: string;
	sourceRunId?: RunId;
	/** Only present when the source binding id is a current-format opaque value. */
	previousBindingId?: string;
	/** Only present when the accepted binding id is a current-format opaque value. */
	capabilityBindingId?: string;
	modelBindingId?: string;
	previousModelBindingId?: string;
	policyBindingId?: string;
	previousPolicyBindingId?: string;
	attempt: number;
	status: RunStatus;
	model: RunModelReference;
	finalModel?: RunFinalModelReference;
	modelAttempts?: ReadonlyArray<RunModelAttemptSummary>;
	modelBudget?: RunModelBudgetSummary;
	policySummary?: PublicPolicySummary;
	bindingAssociation?: RunBindingAssociation;
	startedAt?: string;
	endedAt?: string;
	terminalError?: AutomationError;
}

export interface PublicRunReceipt {
	runId: RunId;
	sessionId: SessionId;
	external?: ExternalExecutionRef;
	deadlineAt?: string;
	status: RunTerminalStatus;
	finalText?: string;
	usage: RunUsage;
	terminalError?: AutomationError;
	contextSnapshotId?: string;
	/** Only present when the binding id is a current-format opaque value. */
	capabilityBindingId?: string;
	modelBindingId?: string;
	previousModelBindingId?: string;
	policyBindingId?: string;
	previousPolicyBindingId?: string;
	finalModel?: RunFinalModelReference;
	modelAttempts?: ReadonlyArray<RunModelAttemptSummary>;
	modelBudget?: RunModelBudgetSummary;
	policySummary?: PublicPolicySummary;
	bindingAssociation?: RunBindingAssociation;
}

/**
 * Public Context receipt. Source ids, paths, labels and reference ids stay
 * internal because each can contain an extension or configured-package source
 * identity. Capability provenance remains available through opaque ids.
 */
export type PublicContextSourceReceipt = Omit<
	ContextSourceReceipt,
	"path" | "sourceId" | "label" | "refId" | "capabilityId" | "capabilityRevision" | "capabilityBindingId"
> & {
	capabilityId?: string;
	capabilityRevision?: string;
	capabilityBindingId?: string;
};

/** Public Context snapshot. It never contains a raw resource source identity. */
export type PublicContextSnapshot = Omit<ContextSnapshot, "sources"> & {
	sources: PublicContextSourceReceipt[];
};

/** Public Context drift record. The internal source id and path are omitted. */
export type PublicContextSourceDrift = Omit<ContextSourceDrift, "path" | "sourceId">;

/** The only custom ledger payloads that can cross the public Session boundary. */
export type PublicSessionCustomData =
	| { schemaVersion: 1; binding: PublicCapabilityBindingLedgerRecord }
	| { schemaVersion: 1; binding: PublicModelBindingLedgerRecord }
	| { schemaVersion: 1; attempt: PublicModelAttemptLedgerRecord }
	| { schemaVersion: 1; sequence: number; summary: PublicPolicySummary }
	| { schemaVersion: 1; sequence: number; approval: PolicyApprovalLedgerRecord }
	| { schemaVersion: 1; sequence: number; sandboxLifecycle: SandboxLifecycleLedgerRecord }
	| { schemaVersion: 1; sequence: number; violation: PolicyViolationLedgerRecord }
	| { schemaVersion: 1; kind: "accepted"; record: PublicRunRecord }
	| { schemaVersion: 1; kind: "started"; runId: RunId; startedAt: string }
	| { schemaVersion: 1; kind: "terminal"; receipt: PublicRunReceipt; endedAt: string };

/** Public custom entry. Arbitrary extension metadata is deliberately absent. */
export type PublicSessionCustomEntry = Omit<Extract<SessionEntry, { type: "custom" }>, "data"> & {
	data?: PublicSessionCustomData;
};

type PublicSessionMessageEntry = Omit<Extract<SessionEntry, { type: "message" }>, "message"> & {
	message: AgentMessage;
};

/**
 * Public, capability-safe Session entry. Custom entry data is limited to the
 * serializer's known safe ledger schema; extension details are omitted.
 */
export type PublicSessionEntry =
	| PublicSessionMessageEntry
	| Extract<SessionEntry, { type: "thinking_level_change" | "model_change" | "label" | "session_info" }>
	| Omit<Extract<SessionEntry, { type: "compaction" }>, "details">
	| Omit<Extract<SessionEntry, { type: "branch_summary" }>, "details">
	| Omit<Extract<SessionEntry, { type: "custom_message" }>, "details">
	| PublicSessionCustomEntry;

/** Public, capability-safe recursive session tree view for RPC and client consumers. */
export interface PublicSessionTreeNode {
	entry: PublicSessionEntry;
	children: PublicSessionTreeNode[];
	label?: string;
	labelTimestamp?: string;
}

type RunTerminalStreamEvent = Extract<RunStreamEvent, { receipt: RunReceipt }>;
type RunEventStreamEvent = Extract<RunStreamEvent, { type: "run.event" }>;

/** Public Session event with Session entries passed through the shared serializer. */
export type PublicAgentSessionEvent =
	| Exclude<AgentSessionEvent, { type: "entry_appended" }>
	| (Omit<Extract<AgentSessionEvent, { type: "entry_appended" }>, "entry"> & { entry: PublicSessionEntry });

/** Run stream event whose receipt and nested Session event are safe for public output. */
export type PublicRunStreamEvent =
	| (Omit<RunEventStreamEvent, "event"> & { event: PublicAgentSessionEvent })
	| (Omit<RunTerminalStreamEvent, "receipt"> & { receipt: PublicRunReceipt })
	| Exclude<RunStreamEvent, RunTerminalStreamEvent | RunEventStreamEvent>;

function isPublicDescriptorRef(
	ref: CapabilityBindingLedgerRecord["descriptors"][number],
): ref is PublicCapabilityBindingDescriptorRef {
	return isOpaqueCapabilityDescriptorId(ref.id) && isOpaqueCapabilityRevision(ref.revision);
}

function serializePublicRunFinalModel(value: RunFinalModelReference): RunFinalModelReference | undefined {
	if (!isRunFinalModelReference(value)) return undefined;
	const copy: RunFinalModelReference = { provider: value.provider };
	if (value.id !== undefined) copy.id = value.id;
	if (value.modelId !== undefined) copy.modelId = value.modelId;
	if (value.thinkingLevel !== undefined) copy.thinkingLevel = value.thinkingLevel;
	return copy;
}

function serializePublicRunModelUsage(value: RunModelUsageSummary): RunModelUsageSummary {
	const copy: RunModelUsageSummary = {};
	const fields: (keyof RunModelUsageSummary)[] = [
		"input",
		"output",
		"total",
		"inputTokens",
		"outputTokens",
		"totalTokens",
		"costUsd",
		"cost",
	];
	for (const field of fields) {
		if (value[field] !== undefined) copy[field] = value[field];
	}
	return copy;
}

function serializePublicRunModelAttempt(value: RunModelAttemptSummary): RunModelAttemptSummary | undefined {
	if (!isRunModelAttemptSummary(value)) return undefined;
	const candidate = serializePublicRunFinalModel(value.candidate);
	if (candidate === undefined) return undefined;
	const copy: RunModelAttemptSummary = {
		attemptId: value.attemptId,
		bindingId: value.bindingId,
		candidate,
		order: value.order,
		status: value.status,
		startedAt: value.startedAt,
	};
	if (value.endedAt !== undefined) copy.endedAt = value.endedAt;
	if (value.failureCategory !== undefined) copy.failureCategory = value.failureCategory;
	if (value.usage !== undefined) copy.usage = serializePublicRunModelUsage(value.usage);
	if (value.visibleOutput !== undefined) copy.visibleOutput = value.visibleOutput;
	if (value.contextSnapshotId !== undefined) copy.contextSnapshotId = value.contextSnapshotId;
	if (value.summary !== undefined) {
		const redacted = redactErrorText(value.summary);
		// A summary is optional. Omit one that still looks like a path or URL so
		// a provider diagnostic cannot become a public source identity.
		if (!redacted.includes("/") && !redacted.includes("\\") && !redacted.includes("://")) copy.summary = redacted;
	}
	return copy;
}

function serializePublicRunModelBudget(value: RunModelBudgetSummary): RunModelBudgetSummary {
	return {
		...(value.modelCalls === undefined ? {} : { modelCalls: value.modelCalls }),
		...(value.inputTokens === undefined ? {} : { inputTokens: value.inputTokens }),
		...(value.outputTokens === undefined ? {} : { outputTokens: value.outputTokens }),
		...(value.totalTokens === undefined ? {} : { totalTokens: value.totalTokens }),
		...(value.costUsd === undefined ? {} : { costUsd: value.costUsd }),
		...(value.maxModelCalls === undefined ? {} : { maxModelCalls: value.maxModelCalls }),
		...(value.maxInputTokens === undefined ? {} : { maxInputTokens: value.maxInputTokens }),
		...(value.maxOutputTokens === undefined ? {} : { maxOutputTokens: value.maxOutputTokens }),
		...(value.maxTotalTokens === undefined ? {} : { maxTotalTokens: value.maxTotalTokens }),
		...(value.maxCostUsd === undefined ? {} : { maxCostUsd: value.maxCostUsd }),
		...(value.exceeded === undefined ? {} : { exceeded: value.exceeded }),
	};
}

/**
 * Public-safe view of a capability binding ledger record. Returns undefined when
 * the binding identity is a legacy or malformed raw id (the binding is
 * unavailable); otherwise it omits descriptor refs whose id or revision is not a
 * current-format opaque value. Never emits source/path/URL-derived text.
 */
export function serializePublicCapabilityBinding(
	binding: CapabilityBindingLedgerRecord,
): PublicCapabilityBindingLedgerRecord | undefined {
	if (!isOpaqueCapabilityBindingId(binding.id)) return undefined;
	return {
		id: binding.id,
		profile: binding.profile,
		createdAt: binding.createdAt,
		descriptors: binding.descriptors.filter(isPublicDescriptorRef),
		decisionSummary: {
			allowed: binding.decisionSummary.allowed,
			awaitingApproval: binding.decisionSummary.awaitingApproval,
			denied: binding.decisionSummary.denied,
		},
		toolAllowlist: [...binding.toolAllowlist],
	};
}

/**
 * Public-safe view of a run record. The previous binding id is only emitted when
 * it is a current-format opaque value; legacy/malformed ids are omitted and the
 * terminal error message is always redacted.
 */
export function serializePublicRunRecord(record: RunRecord): PublicRunRecord {
	const copy: PublicRunRecord = {
		id: record.id,
		sessionId: record.sessionId,
		attempt: record.attempt,
		status: record.status,
		model: { ...record.model },
	};
	const requestRelation = requestRelationFromRecord(record);
	if (requestRelation !== undefined) {
		copy.requestScope = requestRelation.scope;
		copy.clientRequestId = requestRelation.clientRequestId;
		copy.requestFingerprint = requestRelation.fingerprint;
	}
	if (record.external !== undefined) {
		const external = serializeExternalExecutionRef(record.external);
		if (external !== undefined) copy.external = external;
	}
	if (record.deadlineAt !== undefined && isRunTimestamp(record.deadlineAt)) copy.deadlineAt = record.deadlineAt;
	if (record.sourceRunId !== undefined) copy.sourceRunId = record.sourceRunId;
	if (record.previousBindingId !== undefined && isOpaqueCapabilityBindingId(record.previousBindingId)) {
		copy.previousBindingId = record.previousBindingId;
	}
	if (record.capabilityBindingId !== undefined && isOpaqueCapabilityBindingId(record.capabilityBindingId)) {
		copy.capabilityBindingId = record.capabilityBindingId;
	}
	if (record.modelBindingId !== undefined && isRunMetadataId(record.modelBindingId)) {
		copy.modelBindingId = record.modelBindingId;
	}
	if (record.previousModelBindingId !== undefined && isRunMetadataId(record.previousModelBindingId)) {
		copy.previousModelBindingId = record.previousModelBindingId;
	}
	if (record.policyBindingId !== undefined && isRunMetadataId(record.policyBindingId)) {
		copy.policyBindingId = record.policyBindingId;
	}
	if (record.previousPolicyBindingId !== undefined && isRunMetadataId(record.previousPolicyBindingId)) {
		copy.previousPolicyBindingId = record.previousPolicyBindingId;
	}
	if (record.finalModel !== undefined) {
		const finalModel = serializePublicRunFinalModel(record.finalModel);
		if (finalModel !== undefined) copy.finalModel = finalModel;
	}
	if (record.modelAttempts !== undefined) {
		copy.modelAttempts = record.modelAttempts
			.map((attempt) => serializePublicRunModelAttempt(attempt))
			.filter((attempt): attempt is RunModelAttemptSummary => attempt !== undefined);
	}
	if (record.modelBudget !== undefined) copy.modelBudget = serializePublicRunModelBudget(record.modelBudget);
	if (record.policySummary !== undefined) {
		const policySummary = clonePublicPolicySummary(record.policySummary);
		if (policySummary !== undefined) copy.policySummary = policySummary;
	}
	if (record.bindingAssociation !== undefined) {
		const bindingAssociation = serializePublicRunBindingAssociation(record.bindingAssociation);
		if (bindingAssociation !== undefined) copy.bindingAssociation = bindingAssociation;
	}
	if (record.startedAt !== undefined) copy.startedAt = record.startedAt;
	if (record.endedAt !== undefined) copy.endedAt = record.endedAt;
	if (record.terminalError !== undefined) copy.terminalError = serializePublicAutomationError(record.terminalError);
	return copy;
}

/**
 * Public-safe view of a run receipt. The capability binding id is only emitted
 * when it is a current-format opaque value; legacy/malformed ids are omitted and
 * the terminal error message is always redacted.
 */
export function serializePublicRunReceipt(receipt: RunReceipt): PublicRunReceipt {
	const copy: PublicRunReceipt = {
		runId: receipt.runId,
		sessionId: receipt.sessionId,
		status: receipt.status,
		usage: { input: receipt.usage.input, output: receipt.usage.output, total: receipt.usage.total },
	};
	if (receipt.external !== undefined) {
		const external = serializeExternalExecutionRef(receipt.external);
		if (external !== undefined) copy.external = external;
	}
	if (receipt.deadlineAt !== undefined && isRunTimestamp(receipt.deadlineAt)) copy.deadlineAt = receipt.deadlineAt;
	if (receipt.finalText !== undefined) copy.finalText = receipt.finalText;
	if (receipt.terminalError !== undefined) copy.terminalError = serializePublicAutomationError(receipt.terminalError);
	if (receipt.contextSnapshotId !== undefined) copy.contextSnapshotId = receipt.contextSnapshotId;
	if (receipt.capabilityBindingId !== undefined && isOpaqueCapabilityBindingId(receipt.capabilityBindingId)) {
		copy.capabilityBindingId = receipt.capabilityBindingId;
	}
	if (receipt.modelBindingId !== undefined && isRunMetadataId(receipt.modelBindingId)) {
		copy.modelBindingId = receipt.modelBindingId;
	}
	if (receipt.previousModelBindingId !== undefined && isRunMetadataId(receipt.previousModelBindingId)) {
		copy.previousModelBindingId = receipt.previousModelBindingId;
	}
	if (receipt.policyBindingId !== undefined && isRunMetadataId(receipt.policyBindingId)) {
		copy.policyBindingId = receipt.policyBindingId;
	}
	if (receipt.previousPolicyBindingId !== undefined && isRunMetadataId(receipt.previousPolicyBindingId)) {
		copy.previousPolicyBindingId = receipt.previousPolicyBindingId;
	}
	if (receipt.finalModel !== undefined) {
		const finalModel = serializePublicRunFinalModel(receipt.finalModel);
		if (finalModel !== undefined) copy.finalModel = finalModel;
	}
	if (receipt.modelAttempts !== undefined) {
		copy.modelAttempts = receipt.modelAttempts
			.map((attempt) => serializePublicRunModelAttempt(attempt))
			.filter((attempt): attempt is RunModelAttemptSummary => attempt !== undefined);
	}
	if (receipt.modelBudget !== undefined) copy.modelBudget = serializePublicRunModelBudget(receipt.modelBudget);
	if (receipt.policySummary !== undefined) {
		const policySummary = clonePublicPolicySummary(receipt.policySummary);
		if (policySummary !== undefined) copy.policySummary = policySummary;
	}
	if (receipt.bindingAssociation !== undefined) {
		const bindingAssociation = serializePublicRunBindingAssociation(receipt.bindingAssociation);
		if (bindingAssociation !== undefined) copy.bindingAssociation = bindingAssociation;
	}
	return copy;
}

/** Serialize Context metadata without source paths or source identities. */
export function serializePublicContextSource(source: ContextSourceReceipt): PublicContextSourceReceipt {
	const {
		path: _path,
		sourceId: _sourceId,
		label: _label,
		refId: _refId,
		capabilityId,
		capabilityRevision,
		capabilityBindingId,
		...publicSource
	} = source;
	const copy: PublicContextSourceReceipt = { ...publicSource };
	if (capabilityId !== undefined && isOpaqueCapabilityDescriptorId(capabilityId)) {
		copy.capabilityId = capabilityId;
	}
	if (capabilityRevision !== undefined && isOpaqueCapabilityRevision(capabilityRevision)) {
		copy.capabilityRevision = capabilityRevision;
	}
	if (capabilityBindingId !== undefined && isOpaqueCapabilityBindingId(capabilityBindingId)) {
		copy.capabilityBindingId = capabilityBindingId;
	}
	return copy;
}

/** Serialize a Context snapshot through the common public capability boundary. */
export function serializePublicContextSnapshot(snapshot: ContextSnapshot): PublicContextSnapshot {
	return {
		...snapshot,
		sources: snapshot.sources.map((source) => serializePublicContextSource(source)),
	};
}

/** Serialize Context drift without a raw source id or path. */
export function serializePublicContextDrift(drift: ContextSourceDrift): PublicContextSourceDrift {
	const { path: _path, sourceId: _sourceId, ...publicDrift } = drift;
	return publicDrift;
}

/**
 * Public terminal errors retain their stable programmatic code and retryability,
 * but never reuse internal free text. The existing internal redactor removes
 * credential-shaped values but deliberately preserves ordinary text, including
 * file paths, so it cannot serve as this public serialization boundary.
 */
export function serializePublicAutomationError(error: AutomationError, message = "Run failed."): AutomationError {
	return createAutomationError(error.code, message, error.retryable);
}

/** Return a public Session event through the common capability-safe boundary. */
export function serializePublicSessionEvent(event: AgentSessionEvent): PublicAgentSessionEvent {
	switch (event.type) {
		case "entry_appended":
			return { ...event, entry: serializePublicSessionEntry(event.entry) };
		case "message_start":
		case "message_end":
			return { ...event, message: serializePublicAgentMessage(event.message) };
		case "message_update":
			return {
				...event,
				message: serializePublicAgentMessage(event.message),
				assistantMessageEvent: serializePublicAssistantMessageEvent(event.assistantMessageEvent),
			};
		case "turn_end":
			return {
				...event,
				message: serializePublicAgentMessage(event.message),
				toolResults: event.toolResults.map((message) => serializePublicToolResult(message)),
			};
		case "tool_execution_start":
			return { ...event, args: {} };
		case "tool_execution_update":
			return { ...event, args: {}, partialResult: {} };
		case "tool_execution_end":
			return { ...event, result: {} };
		case "agent_end":
			return {
				...event,
				messages: event.messages.map((message) => {
					const publicMessage = serializePublicAgentMessage(message);
					return publicMessage.role === "assistant" &&
						(publicMessage.stopReason === "error" || publicMessage.stopReason === "aborted")
						? { ...publicMessage, errorMessage: "Agent run failed." }
						: publicMessage;
				}),
			};
		case "compaction_end":
			return event.errorMessage === undefined ? event : { ...event, errorMessage: "Operation failed." };
		case "auto_retry_start":
			return { ...event, errorMessage: "Operation failed." };
		case "auto_retry_end":
			return event.finalError === undefined ? event : { ...event, finalError: "Operation failed." };
		case "summarization_retry_scheduled":
			return { ...event, errorMessage: "Operation failed." };
		case "bash_execution_update":
			return { ...event, delta: event.delta.length === 0 ? "" : "[redacted]" };
		default:
			return event;
	}
}

/** Return a public run event with its receipt and nested Session event serialized. */
export function serializePublicRunStreamEvent(event: RunStreamEvent): PublicRunStreamEvent {
	if (event.type === "run.event") {
		return { ...event, event: serializePublicSessionEvent(event.event) };
	}
	if ("receipt" in event) {
		return { ...event, receipt: serializePublicRunReceipt(event.receipt) };
	}
	return { ...event };
}

/**
 * Return a public-safe copy of a Session entry. Capability and run ledgers are
 * decoded before output so historic raw identities remain internally replayable
 * but cannot escape. Other extension-owned custom metadata is omitted because
 * it has no stable public contract; structured execution message payloads are
 * redacted before they cross the public boundary.
 */
export function serializePublicSessionEntry(entry: SessionEntry): PublicSessionEntry {
	switch (entry.type) {
		case "message":
			return {
				...entry,
				message: serializePublicAgentMessage(entry.message),
			};
		case "custom":
			return serializePublicCustomEntry(entry);
		case "custom_message": {
			const { details: _details, ...publicEntry } = entry;
			return publicEntry;
		}
		case "compaction":
		case "branch_summary": {
			const { details: _details, ...publicEntry } = entry;
			return publicEntry;
		}
		default:
			return { ...entry };
	}
}

function serializePublicAgentMessage(message: AgentMessage): AgentMessage {
	if (message.role === "bashExecution") {
		const { fullOutputPath: _fullOutputPath, ...publicMessage } = message;
		return {
			...publicMessage,
			command: "[redacted]",
			output: message.output.length === 0 ? "" : "[redacted]",
		};
	}
	if (message.role === "assistant") {
		return serializePublicAssistantMessage(message);
	}
	if (message.role === "toolResult") {
		return serializePublicToolResult(message);
	}
	return message;
}

function serializePublicToolResult(
	message: Extract<AgentMessage, { role: "toolResult" }>,
): Extract<AgentMessage, { role: "toolResult" }> {
	const { details: _details, usage: _usage, ...publicMessage } = message;
	return {
		...publicMessage,
		content: message.content.length === 0 ? [] : [{ type: "text", text: "[redacted]" }],
	};
}

function serializePublicAssistantMessage(message: AssistantMessage): AssistantMessage {
	return {
		...message,
		content: message.content.map((block) =>
			block.type === "toolCall" ? { ...block, arguments: {}, thoughtSignature: undefined } : block,
		),
	};
}

function serializePublicAssistantMessageEvent(event: AssistantMessageEvent): AssistantMessageEvent {
	switch (event.type) {
		case "done":
			return { ...event, message: serializePublicAssistantMessage(event.message) };
		case "error":
			return { ...event, error: serializePublicAssistantMessage(event.error) };
		case "toolcall_end":
			return {
				...event,
				toolCall: { ...event.toolCall, arguments: {}, thoughtSignature: undefined },
				partial: serializePublicAssistantMessage(event.partial),
			};
		case "toolcall_delta":
			return { ...event, delta: "", partial: serializePublicAssistantMessage(event.partial) };
		default:
			return { ...event, partial: serializePublicAssistantMessage(event.partial) };
	}
}

/** Recursively serialize a Session tree without exposing custom ledger metadata. */
export function serializePublicSessionTreeNode(node: SessionTreeNode): PublicSessionTreeNode {
	const copy: PublicSessionTreeNode = {
		entry: serializePublicSessionEntry(node.entry),
		children: node.children.map((child) => serializePublicSessionTreeNode(child)),
	};
	if (node.label !== undefined) copy.label = node.label;
	if (node.labelTimestamp !== undefined) copy.labelTimestamp = node.labelTimestamp;
	return copy;
}

function isPolicyLedgerRecord(value: unknown): value is PolicyLedgerRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPersistedPolicyLedgerEntry(
	value: unknown,
): value is { schemaVersion: 1; sequence: number; record: PolicyLedgerRecord } {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const obj = value as Record<string, unknown>;
	return (
		obj.schemaVersion === 1 &&
		Number.isSafeInteger(obj.sequence) &&
		typeof obj.sequence === "number" &&
		isPolicyLedgerRecord(obj.record)
	);
}

function isExecutionPolicyBindingLedgerRecord(value: unknown): value is ExecutionPolicyBindingLedgerRecord {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const obj = value as Record<string, unknown>;
	return (
		isRunMetadataId(obj.id) &&
		isRunMetadataId(obj.profileId) &&
		isRunMetadataId(obj.profileRevision) &&
		isPolicyTrust(obj.projectTrust) &&
		isPolicyEnforcement(obj.enforcement) &&
		(obj.sandboxProviderId === undefined || isRunMetadataId(obj.sandboxProviderId)) &&
		isSandboxCapabilities(obj.sandboxCapabilities) &&
		isSandboxStatus(obj.sandboxStatus)
	);
}

function isPolicyDecisionLedgerRecord(value: unknown): value is PolicyDecisionLedgerRecord {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const obj = value as Record<string, unknown>;
	return (
		isRunMetadataId(obj.bindingId) &&
		isRunMetadataId(obj.profileId) &&
		isRunMetadataId(obj.profileRevision) &&
		isPolicyTrust(obj.projectTrust) &&
		isPolicyEnforcement(obj.enforcement) &&
		isPolicyResource(obj.resource) &&
		isPolicyAction(obj.action) &&
		isPolicyDecisionOutcome(obj.outcome) &&
		(obj.reasonCode === undefined || isPolicyErrorCode(obj.reasonCode)) &&
		(obj.requestId === undefined || isRunMetadataId(obj.requestId)) &&
		isRunMetadataText(obj.timestamp)
	);
}

function publicPolicySummaryFromBindingRecord(
	record: ExecutionPolicyBindingLedgerRecord,
): PublicPolicySummary | undefined {
	return clonePublicPolicySummary({
		bindingId: record.id,
		profileId: record.profileId,
		profileRevision: record.profileRevision,
		projectTrust: record.projectTrust,
		enforcement: record.enforcement,
		...(record.sandboxProviderId === undefined ? {} : { sandboxProviderId: record.sandboxProviderId }),
		sandboxStatus: record.sandboxStatus,
		sandboxCapabilities: cloneSandboxCapabilities(record.sandboxCapabilities),
	});
}

function publicPolicySummaryFromDecisionRecord(record: PolicyDecisionLedgerRecord): PublicPolicySummary | undefined {
	return clonePublicPolicySummary({
		bindingId: record.bindingId,
		profileId: record.profileId,
		profileRevision: record.profileRevision,
		projectTrust: record.projectTrust,
		enforcement: record.enforcement,
		sandboxStatus: "not_required",
		sandboxCapabilities: { filesystem: false, process: false, network: false, credentialIsolation: false },
		resource: record.resource,
		action: record.action,
		outcome: record.outcome,
		...(record.reasonCode === undefined ? {} : { reasonCode: record.reasonCode }),
		...(record.requestId === undefined ? {} : { requestId: record.requestId }),
		timestamp: record.timestamp,
	});
}

function clonePublicPolicyApproval(record: PolicyApprovalLedgerRecord): PolicyApprovalLedgerRecord | undefined {
	if (!isRunMetadataId(record.id) || !isRunMetadataId(record.bindingId) || !isPolicyResource(record.resource)) return undefined;
	if (record.requestId !== undefined && !isRunMetadataId(record.requestId)) return undefined;
	if (record.outcome !== undefined && !isPolicyApprovalOutcome(record.outcome)) return undefined;
	if (record.source !== undefined && !isPolicyApprovalSource(record.source)) return undefined;
	if ((record.outcome === undefined) !== (record.source === undefined)) return undefined;
	if (record.reasonCode !== "policy_approval_required" || !isRunMetadataText(record.createdAt)) return undefined;
	if (typeof record.scope !== "object" || record.scope === null || Array.isArray(record.scope)) return undefined;
	if (!isPolicyResource(record.scope.resource)) return undefined;
	return {
		id: record.id,
		...(record.requestId === undefined ? {} : { requestId: record.requestId }),
		bindingId: record.bindingId,
		resource: record.resource,
		reasonCode: record.reasonCode,
		createdAt: record.createdAt,
		...(record.outcome === undefined ? {} : { outcome: record.outcome }),
		...(record.source === undefined ? {} : { source: record.source }),
		scope: {
			resource: record.scope.resource,
			...(record.scope.workspaceScopes === undefined ? {} : { workspaceScopes: [...record.scope.workspaceScopes] }),
			...(record.scope.environmentCount === undefined ? {} : { environmentCount: record.scope.environmentCount }),
			...(record.scope.destinationCount === undefined ? {} : { destinationCount: record.scope.destinationCount }),
			...(record.scope.credentialCount === undefined ? {} : { credentialCount: record.scope.credentialCount }),
		},
	};
}

function clonePublicSandboxLifecycle(record: SandboxLifecycleLedgerRecord): SandboxLifecycleLedgerRecord | undefined {
	if (!isRunMetadataId(record.bindingId) || !isSandboxStatus(record.status) || !isRunMetadataText(record.timestamp)) return undefined;
	if (record.providerId !== undefined && !isRunMetadataId(record.providerId)) return undefined;
	if (record.capabilities !== undefined && !isSandboxCapabilities(record.capabilities)) return undefined;
	if (record.reasonCode !== undefined && !isPolicyErrorCode(record.reasonCode)) return undefined;
	return {
		bindingId: record.bindingId,
		status: record.status,
		timestamp: record.timestamp,
		...(record.providerId === undefined ? {} : { providerId: record.providerId }),
		...(record.capabilities === undefined ? {} : { capabilities: cloneSandboxCapabilities(record.capabilities) }),
		...(record.reasonCode === undefined ? {} : { reasonCode: record.reasonCode }),
	};
}

function clonePublicPolicyViolation(record: PolicyViolationLedgerRecord): PolicyViolationLedgerRecord | undefined {
	if (!isRunMetadataId(record.bindingId) || !isRunMetadataText(record.timestamp) || !isPolicyErrorCode(record.reasonCode)) return undefined;
	if (record.resource !== undefined && !isPolicyResource(record.resource)) return undefined;
	if (record.requestId !== undefined && !isRunMetadataId(record.requestId)) return undefined;
	return {
		bindingId: record.bindingId,
		timestamp: record.timestamp,
		reasonCode: record.reasonCode,
		...(record.resource === undefined ? {} : { resource: record.resource }),
		...(record.requestId === undefined ? {} : { requestId: record.requestId }),
	};
}

function serializePublicCustomEntry(entry: Extract<SessionEntry, { type: "custom" }>): PublicSessionCustomEntry {
	const { data: _data, ...publicEntry } = entry;
	if (entry.customType === POLICY_BINDING_CUSTOM_TYPE || entry.customType === POLICY_DECISION_CUSTOM_TYPE) {
		const parsed = isPersistedPolicyLedgerEntry(entry.data) ? entry.data : undefined;
		if (parsed === undefined) return publicEntry;
		const summary =
			entry.customType === POLICY_BINDING_CUSTOM_TYPE
				? isExecutionPolicyBindingLedgerRecord(parsed.record)
					? publicPolicySummaryFromBindingRecord(parsed.record)
					: undefined
				: isPolicyDecisionLedgerRecord(parsed.record)
					? publicPolicySummaryFromDecisionRecord(parsed.record)
					: undefined;
		return summary === undefined
			? publicEntry
			: { ...publicEntry, data: { schemaVersion: 1, sequence: parsed.sequence, summary } };
	}
	if (entry.customType === POLICY_APPROVAL_CUSTOM_TYPE) {
		const parsed = isPersistedPolicyLedgerEntry(entry.data) ? entry.data : undefined;
		if (parsed === undefined) return publicEntry;
		const approval = clonePublicPolicyApproval(parsed.record as PolicyApprovalLedgerRecord);
		return approval === undefined
			? publicEntry
			: { ...publicEntry, data: { schemaVersion: 1, sequence: parsed.sequence, approval } };
	}
	if (entry.customType === SANDBOX_LIFECYCLE_CUSTOM_TYPE) {
		const parsed = isPersistedPolicyLedgerEntry(entry.data) ? entry.data : undefined;
		if (parsed === undefined) return publicEntry;
		const sandboxLifecycle = clonePublicSandboxLifecycle(parsed.record as SandboxLifecycleLedgerRecord);
		return sandboxLifecycle === undefined
			? publicEntry
			: { ...publicEntry, data: { schemaVersion: 1, sequence: parsed.sequence, sandboxLifecycle } };
	}
	if (entry.customType === POLICY_VIOLATION_CUSTOM_TYPE) {
		const parsed = isPersistedPolicyLedgerEntry(entry.data) ? entry.data : undefined;
		if (parsed === undefined) return publicEntry;
		const violation = clonePublicPolicyViolation(parsed.record as PolicyViolationLedgerRecord);
		return violation === undefined
			? publicEntry
			: { ...publicEntry, data: { schemaVersion: 1, sequence: parsed.sequence, violation } };
	}
	if (entry.customType === MODEL_BINDING_CUSTOM_TYPE || entry.customType === MODEL_ATTEMPT_CUSTOM_TYPE) {
		const serialized = serializePublicModelBrokerLedgerEntry(entry);
		if (serialized.data === undefined) return publicEntry;
		return { ...publicEntry, data: serialized.data as PublicSessionCustomData };
	}
	if (entry.customType === CAPABILITY_BINDING_CUSTOM_TYPE) {
		const parsed = parseCapabilityBindingEntry(entry.data, entry.id);
		if (!parsed.ok) return publicEntry;
		const binding = serializePublicCapabilityBinding(parsed.entry.binding);
		return binding === undefined
			? publicEntry
			: { ...publicEntry, data: { schemaVersion: CAPABILITY_BINDING_SCHEMA_VERSION, binding } };
	}
	if (entry.customType !== RUN_LEDGER_CUSTOM_TYPE) return publicEntry;

	const parsed = parseLedgerEntry(entry.data);
	if (!parsed.ok) return publicEntry;
	switch (parsed.entry.kind) {
		case "accepted":
			return {
				...publicEntry,
				data: { schemaVersion: 1, kind: "accepted", record: serializePublicRunRecord(parsed.entry.record) },
			};
		case "started":
			return { ...publicEntry, data: { ...parsed.entry } };
		case "terminal":
			return {
				...publicEntry,
				data: {
					schemaVersion: 1,
					kind: "terminal",
					receipt: serializePublicRunReceipt(parsed.entry.receipt),
					endedAt: parsed.entry.endedAt,
				},
			};
	}
}

// ---- Text and usage helpers --------------------------------------------------

function extractTextContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	let text = "";
	for (const block of content) {
		if (typeof block !== "object" || block === null) continue;
		const candidate = block as { type?: unknown; text?: unknown };
		if (candidate.type === "text" && typeof candidate.text === "string") text += candidate.text;
	}
	return text;
}

function extractAssistantText(message: AgentMessage): string {
	if (message.role !== "assistant") return "";
	return extractTextContent(message.content);
}

function nonNegative(value: number): number {
	return value > 0 ? value : 0;
}

function cloneAutomationError(error: AutomationError): AutomationError {
	// Always produce a fresh, secret-free object so replay never re-exposes a raw
	// terminalError that may have been persisted by an older version.
	return redactAutomationError({ code: error.code, message: error.message, retryable: error.retryable });
}

function cloneRunRecord(record: RunRecord): RunRecord {
	const copy: RunRecord = {
		id: record.id,
		sessionId: record.sessionId,
		attempt: record.attempt,
		status: record.status,
		model: { ...record.model },
	};
	const requestRelation = requestRelationFromRecord(record);
	if (requestRelation !== undefined) {
		copy.requestScope = requestRelation.scope;
		copy.clientRequestId = requestRelation.clientRequestId;
		copy.requestFingerprint = requestRelation.fingerprint;
	}
	if (record.external !== undefined) {
		const external = serializeExternalExecutionRef(record.external);
		if (external !== undefined) copy.external = external;
	}
	if (record.deadlineAt !== undefined && isRunTimestamp(record.deadlineAt)) copy.deadlineAt = record.deadlineAt;
	if (record.sourceRunId !== undefined) copy.sourceRunId = record.sourceRunId;
	if (record.previousBindingId !== undefined) copy.previousBindingId = record.previousBindingId;
	if (record.capabilityBindingId !== undefined) copy.capabilityBindingId = record.capabilityBindingId;
	if (record.modelBindingId !== undefined) copy.modelBindingId = record.modelBindingId;
	if (record.previousModelBindingId !== undefined) copy.previousModelBindingId = record.previousModelBindingId;
	if (record.policyBindingId !== undefined) copy.policyBindingId = record.policyBindingId;
	if (record.previousPolicyBindingId !== undefined) copy.previousPolicyBindingId = record.previousPolicyBindingId;
	if (record.finalModel !== undefined) copy.finalModel = { ...record.finalModel };
	if (record.modelAttempts !== undefined) {
		copy.modelAttempts = record.modelAttempts.map((attempt) => ({
			...attempt,
			candidate: { ...attempt.candidate },
			...(attempt.usage === undefined ? {} : { usage: { ...attempt.usage } }),
		}));
	}
	if (record.modelBudget !== undefined) copy.modelBudget = { ...record.modelBudget };
	if (record.policySummary !== undefined) {
		const policySummary = clonePublicPolicySummary(record.policySummary);
		if (policySummary !== undefined) copy.policySummary = policySummary;
	}
	if (record.bindingAssociation !== undefined) {
		const bindingAssociation = serializePublicRunBindingAssociation(record.bindingAssociation);
		if (bindingAssociation !== undefined) copy.bindingAssociation = bindingAssociation;
	}
	if (record.startedAt !== undefined) copy.startedAt = record.startedAt;
	if (record.endedAt !== undefined) copy.endedAt = record.endedAt;
	if (record.terminalError !== undefined) copy.terminalError = cloneAutomationError(record.terminalError);
	return copy;
}

function cloneRunReceipt(receipt: RunReceipt): RunReceipt {
	const copy: RunReceipt = {
		runId: receipt.runId,
		sessionId: receipt.sessionId,
		status: receipt.status,
		usage: { input: receipt.usage.input, output: receipt.usage.output, total: receipt.usage.total },
	};
	if (receipt.external !== undefined) {
		const external = serializeExternalExecutionRef(receipt.external);
		if (external !== undefined) copy.external = external;
	}
	if (receipt.deadlineAt !== undefined && isRunTimestamp(receipt.deadlineAt)) copy.deadlineAt = receipt.deadlineAt;
	if (receipt.finalText !== undefined) copy.finalText = receipt.finalText;
	if (receipt.sessionFile !== undefined) copy.sessionFile = receipt.sessionFile;
	if (receipt.terminalError !== undefined) copy.terminalError = cloneAutomationError(receipt.terminalError);
	if (receipt.contextSnapshotId !== undefined) copy.contextSnapshotId = receipt.contextSnapshotId;
	if (receipt.capabilityBindingId !== undefined) copy.capabilityBindingId = receipt.capabilityBindingId;
	if (receipt.modelBindingId !== undefined) copy.modelBindingId = receipt.modelBindingId;
	if (receipt.previousModelBindingId !== undefined) copy.previousModelBindingId = receipt.previousModelBindingId;
	if (receipt.policyBindingId !== undefined) copy.policyBindingId = receipt.policyBindingId;
	if (receipt.previousPolicyBindingId !== undefined) copy.previousPolicyBindingId = receipt.previousPolicyBindingId;
	if (receipt.finalModel !== undefined) copy.finalModel = { ...receipt.finalModel };
	if (receipt.modelAttempts !== undefined) {
		copy.modelAttempts = receipt.modelAttempts.map((attempt) => ({
			...attempt,
			candidate: { ...attempt.candidate },
			...(attempt.usage === undefined ? {} : { usage: { ...attempt.usage } }),
		}));
	}
	if (receipt.modelBudget !== undefined) copy.modelBudget = { ...receipt.modelBudget };
	if (receipt.policySummary !== undefined) {
		const policySummary = clonePublicPolicySummary(receipt.policySummary);
		if (policySummary !== undefined) copy.policySummary = policySummary;
	}
	if (receipt.bindingAssociation !== undefined) {
		const bindingAssociation = serializePublicRunBindingAssociation(receipt.bindingAssociation);
		if (bindingAssociation !== undefined) copy.bindingAssociation = bindingAssociation;
	}
	return copy;
}

function externalRefFromMapping(mapping: ExternalExecutionMapping): ExternalExecutionRef | undefined {
	const ref: ExternalExecutionRef = {
		namespace: mapping.namespace,
		externalSessionId: mapping.externalSessionId,
		...(mapping.externalRunId === undefined ? {} : { externalRunId: mapping.externalRunId }),
	};
	return serializeExternalExecutionRef(ref);
}

// ---- Run handle --------------------------------------------------------------

class RunHandleImpl implements RunHandle {
	readonly runId: RunId;
	readonly sessionId: SessionId;

	private readonly coordinator: RunLifecycleCoordinatorImpl;
	private readonly _record: RunRecord;
	private readonly _capabilityBindingId: string | undefined;
	private readonly _policyBindingId: string | undefined;
	private readonly _previousPolicyBindingId: string | undefined;
	private readonly _bindingAssociation: RunBindingAssociation | undefined;
	private _policySummary: PublicPolicySummary | undefined;
	private _sequence = 0;
	private _terminationIntent: RunTerminationIntent | undefined;
	private _finalText = "";
	private _usageBaseline: RunUsageSnapshot | undefined;
	private readonly _buffered: AgentSessionEvent[] = [];
	private readonly _emitted: RunStreamEvent[] = [];
	private _receipt: RunReceipt | undefined;

	constructor(
		coordinator: RunLifecycleCoordinatorImpl,
		sessionId: SessionId,
		options: AcceptOptions,
		requestIdentity = requestIdentityFromOptions(options),
	) {
		this.coordinator = coordinator;
		this.sessionId = sessionId;
		this.runId = options.runId ?? coordinator.nextRunId();
		validateRequestRelationOptions(options);
		if (options.deadlineAt !== undefined && !isRunTimestamp(options.deadlineAt)) {
			throw createAutomationError("run_deadline_invalid", "Run deadline must be a canonical UTC timestamp.", false);
		}
		this._capabilityBindingId = options.capabilityBinding?.id;
		this._policyBindingId = options.policyBinding?.id;
		this._previousPolicyBindingId = options.policyBinding?.previousPolicyBindingId ?? options.previousPolicyBindingId;
		this._bindingAssociation =
			options.bindingHandles === undefined || options.bindingHandles.length === 0
				? undefined
				: createRunBindingAssociation(this.runId, options.bindingHandles);
		this._policySummary =
			options.policyBinding === undefined
				? options.policySummary === undefined
					? undefined
					: clonePublicPolicySummary(options.policySummary)
				: publicPolicySummaryFrom(options.policyBinding, options.policySummary);
		this._record = {
			id: this.runId,
			sessionId,
			attempt: options.attempt,
			status: "accepted",
			model: options.model,
		};
		if (requestIdentity !== undefined) {
			this._record.requestScope = requestIdentity.scope;
			this._record.clientRequestId = requestIdentity.clientRequestId;
			this._record.requestFingerprint = requestIdentity.requestFingerprint;
		}
		if (options.external !== undefined) {
			const external = serializeExternalExecutionRef(options.external);
			if (external !== undefined) this._record.external = external;
		}
		if (options.deadlineAt !== undefined) this._record.deadlineAt = options.deadlineAt;
		if (options.sourceRunId !== undefined) {
			this._record.sourceRunId = options.sourceRunId;
		}
		if (options.previousBindingId !== undefined) {
			this._record.previousBindingId = options.previousBindingId;
		}
		if (options.capabilityBinding !== undefined) {
			this._record.capabilityBindingId = options.capabilityBinding.id;
		}
		if (options.modelBindingId !== undefined && isRunMetadataId(options.modelBindingId)) {
			this._record.modelBindingId = options.modelBindingId;
		}
		if (options.previousModelBindingId !== undefined && isRunMetadataId(options.previousModelBindingId)) {
			this._record.previousModelBindingId = options.previousModelBindingId;
		}
		if (this._policyBindingId !== undefined) {
			this._record.policyBindingId = this._policyBindingId;
		}
		if (this._previousPolicyBindingId !== undefined) {
			this._record.previousPolicyBindingId = this._previousPolicyBindingId;
		}
		if (options.finalModel !== undefined) {
			const finalModel = cloneRunFinalModel(options.finalModel);
			if (finalModel !== undefined) this._record.finalModel = finalModel;
		}
		if (options.modelAttempts !== undefined)
			this._record.modelAttempts = cloneRunModelAttempts(options.modelAttempts);
		if (options.modelBudget !== undefined) {
			const modelBudget = cloneRunModelBudget(options.modelBudget);
			if (modelBudget !== undefined) this._record.modelBudget = modelBudget;
		}
		if (this._policySummary !== undefined) this._record.policySummary = this._policySummary;
		if (this._bindingAssociation !== undefined) this._record.bindingAssociation = this._bindingAssociation;
	}

	get record(): RunRecord {
		return cloneRunRecord(this._record);
	}

	get sequence(): number {
		return this._sequence;
	}

	get cancelled(): boolean {
		return this._terminationIntent === "cancel";
	}

	get emitted(): readonly RunStreamEvent[] {
		return this._emitted;
	}

	get terminal(): RunStreamEvent | undefined {
		for (let i = this._emitted.length - 1; i >= 0; i -= 1) {
			const event = this._emitted[i];
			if (
				event.type === "run.completed" ||
				event.type === "run.failed" ||
				event.type === "run.cancelled"
			) {
				return event;
			}
		}
		return undefined;
	}

	start(): RunStreamEvent[] {
		if (this._record.status !== "accepted") return [];
		const startedAt = this.coordinator.now();
		// The append is the state transition boundary: in-memory status remains
		// accepted until the durable started fact succeeds.
		this.coordinator.persist({ schemaVersion: 1, kind: "started", runId: this.runId, startedAt });
		this._record.status = "running";
		this._record.startedAt = startedAt;
		const events: RunStreamEvent[] = [this.emitStream("run.started")];
		for (const event of this._buffered.splice(0)) {
			events.push(this.emitRunEvent(event));
		}
		return events;
	}

	captureSessionEvent(event: AgentSessionEvent): RunStreamEvent | undefined {
		this.captureFinalText(event);
		if (isTerminalStatus(this._record.status)) return undefined;
		if (this._record.status === "running") {
			return this.emitRunEvent(event);
		}
		this._buffered.push(event);
		return undefined;
	}

	requestCancel(): void {
		this.recordTerminationIntent("cancel");
	}

	requestDeadlineExceeded(): void {
		this.recordTerminationIntent("deadline");
	}

	setUsageBaseline(baseline: RunUsageSnapshot): void {
		this._usageBaseline = { input: baseline.input, output: baseline.output, total: baseline.total };
	}

	computeUsageDelta(current: RunUsageSnapshot): RunUsage {
		const baseline = this._usageBaseline;
		return {
			input: nonNegative(current.input - (baseline?.input ?? 0)),
			output: nonNegative(current.output - (baseline?.output ?? 0)),
			total: nonNegative(current.total - (baseline?.total ?? 0)),
		};
	}

	finalText(): string {
		return this._finalText;
	}

	settle(input: SettleInput): RunStreamEvent | undefined {
		if (this._receipt !== undefined) {
			this.coordinator.recordDiagnostic({ kind: "duplicate-terminal", runId: this.runId });
			return undefined;
		}
		if (this._record.status !== "running") {
			throw createAutomationError("start_rejected", "Run must be started before terminal persistence.", false);
		}
		// Store only a fixed public-safe terminal error. Run ledgers can be read
		// after process restart, so retaining free text here could preserve local
		// paths or source identities even when every live RPC serializer is safe.
		const status: RunTerminalStatus =
			this._terminationIntent === "deadline"
				? "failed"
				: this._terminationIntent === "cancel"
					? "cancelled"
					: input.outcome;
		const terminalError =
			this._terminationIntent === "deadline"
				? serializePublicAutomationError(createAutomationError("run_deadline_exceeded", "Run failed.", false))
				: this._terminationIntent === "cancel" && input.terminalError?.code === "run_deadline_exceeded"
					? undefined
					: input.terminalError !== undefined
						? serializePublicAutomationError(input.terminalError)
						: undefined;
		const endedAt = this.coordinator.now();
		const receipt: RunReceipt = {
			runId: this.runId,
			sessionId: this.sessionId,
			status,
			usage: this.computeUsageDelta(input.currentUsage ?? { input: 0, output: 0, total: 0 }),
		};
		if (this._record.external !== undefined) {
			const external = serializeExternalExecutionRef(this._record.external);
			if (external !== undefined) receipt.external = external;
		}
		if (this._record.deadlineAt !== undefined) receipt.deadlineAt = this._record.deadlineAt;
		if (this._bindingAssociation !== undefined) receipt.bindingAssociation = this._bindingAssociation;
		const finalText = input.finalText ?? this._finalText;
		if (finalText !== "") receipt.finalText = finalText;
		const sessionFile = this.coordinator.session.getSessionFile();
		if (sessionFile !== undefined) receipt.sessionFile = sessionFile;
		if (terminalError !== undefined) receipt.terminalError = terminalError;
		const contextSnapshotId = input.contextSnapshotId;
		if (contextSnapshotId !== undefined) receipt.contextSnapshotId = contextSnapshotId;
		const capabilityBindingId = this._capabilityBindingId;
		if (capabilityBindingId !== undefined) receipt.capabilityBindingId = capabilityBindingId;
		const requestedModelBindingId = input.modelBindingId ?? this._record.modelBindingId;
		const modelBindingId = requestedModelBindingId !== undefined && isRunMetadataId(requestedModelBindingId)
			? requestedModelBindingId
			: undefined;
		const requestedPreviousModelBindingId = input.previousModelBindingId ?? this._record.previousModelBindingId;
		const previousModelBindingId =
			requestedPreviousModelBindingId !== undefined && isRunMetadataId(requestedPreviousModelBindingId)
				? requestedPreviousModelBindingId
				: undefined;
		const finalModel = input.finalModel === undefined ? this._record.finalModel : cloneRunFinalModel(input.finalModel);
		const modelAttempts = input.modelAttempts === undefined ? this._record.modelAttempts : cloneRunModelAttempts(input.modelAttempts);
		const modelBudget = input.modelBudget === undefined ? this._record.modelBudget : cloneRunModelBudget(input.modelBudget);
		if (modelBindingId !== undefined) receipt.modelBindingId = modelBindingId;
		if (previousModelBindingId !== undefined) receipt.previousModelBindingId = previousModelBindingId;
		if (this._policyBindingId !== undefined) receipt.policyBindingId = this._policyBindingId;
		if (this._previousPolicyBindingId !== undefined) receipt.previousPolicyBindingId = this._previousPolicyBindingId;
		if (input.policySummary !== undefined) {
			const policySummary = clonePublicPolicySummary(input.policySummary);
			if (policySummary !== undefined) this._policySummary = policySummary;
		}
		this.coordinator.persistPolicyFacts({
			policyBindingId: this._policyBindingId,
			policyDecision: input.policyDecision,
			policyApproval: input.policyApproval,
			sandboxLifecycle: input.sandboxLifecycle,
			policyViolation: input.policyViolation,
		});
		if (this._policySummary !== undefined) receipt.policySummary = this._policySummary;
		if (finalModel !== undefined) receipt.finalModel = { ...finalModel };
		if (modelAttempts !== undefined) {
			receipt.modelAttempts = modelAttempts.map((attempt) => ({
				...attempt,
				candidate: { ...attempt.candidate },
				...(attempt.usage === undefined ? {} : { usage: { ...attempt.usage } }),
			}));
		}
		if (modelBudget !== undefined) receipt.modelBudget = { ...modelBudget };
		// Persist terminal before publishing the receipt/event or mutating the
		// in-memory status. A failed append therefore remains visibly running and
		// can be recovered as interrupted after restart.
		this.coordinator.persist({ schemaVersion: 1, kind: "terminal", receipt, endedAt });
		this._receipt = receipt;
		this._record.status = status;
		this._record.endedAt = endedAt;
		if (terminalError !== undefined) this._record.terminalError = terminalError;
		if (modelBindingId !== undefined) this._record.modelBindingId = modelBindingId;
		if (previousModelBindingId !== undefined) this._record.previousModelBindingId = previousModelBindingId;
		if (this._policyBindingId !== undefined) this._record.policyBindingId = this._policyBindingId;
		if (this._previousPolicyBindingId !== undefined) this._record.previousPolicyBindingId = this._previousPolicyBindingId;
		if (this._policySummary !== undefined) this._record.policySummary = this._policySummary;
		if (finalModel !== undefined) this._record.finalModel = { ...finalModel };
		if (modelAttempts !== undefined) {
			this._record.modelAttempts = modelAttempts.map((attempt) => ({
				...attempt,
				candidate: { ...attempt.candidate },
				...(attempt.usage === undefined ? {} : { usage: { ...attempt.usage } }),
			}));
		}
		if (modelBudget !== undefined) this._record.modelBudget = { ...modelBudget };
		const event = this.emitTerminal(status, receipt);
		this.coordinator.onTerminal(this);
		return event;
	}

	receipt(): RunReceipt | undefined {
		return this._receipt === undefined ? undefined : cloneRunReceipt(this._receipt);
	}

	result(): RunResult {
		const result: RunResult = { record: this.record };
		if (this._receipt !== undefined) result.receipt = cloneRunReceipt(this._receipt);
		// Live handles are not recovered. The replay fold adds `interrupted` only
		// when accepted/started facts are reconstructed from persisted history.
		if (this._policySummary !== undefined) {
			const policySummary = clonePublicPolicySummary(this._policySummary);
			if (policySummary !== undefined) result.policySummary = policySummary;
		}
		return result;
	}

	setExternalMapping(external: ExternalExecutionRef): void {
		const safe = serializeExternalExecutionRef(external);
		if (safe === undefined) return;
		this._record.external = safe;
		if (this._receipt !== undefined) this._receipt.external = safe;
	}

	private emitStream(type: "run.started"): RunStreamEvent {
		this._sequence += 1;
		const event: RunStreamEvent = {
			type,
			runId: this.runId,
			sessionId: this.sessionId,
			sequence: this._sequence,
			timestamp: this.coordinator.now(),
		};
		this._emitted.push(event);
		return event;
	}

	private emitRunEvent(event: AgentSessionEvent): RunStreamEvent {
		this._sequence += 1;
		const wrapped: RunStreamEvent = {
			type: "run.event",
			runId: this.runId,
			sessionId: this.sessionId,
			sequence: this._sequence,
			timestamp: this.coordinator.now(),
			event,
		};
		this._emitted.push(wrapped);
		return wrapped;
	}

	private emitTerminal(status: RunTerminalStatus, receipt: RunReceipt): RunStreamEvent {
		this._sequence += 1;
		const event: RunStreamEvent = {
			type: status === "completed" ? "run.completed" : status === "failed" ? "run.failed" : "run.cancelled",
			runId: this.runId,
			sessionId: this.sessionId,
			sequence: this._sequence,
			timestamp: this.coordinator.now(),
			receipt,
		};
		this._emitted.push(event);
		return event;
	}

	private captureFinalText(event: AgentSessionEvent): void {
		if (event.type === "message_end") {
			const text = extractAssistantText(event.message);
			if (text !== "") this._finalText = text;
		} else if (event.type === "agent_end") {
			for (let i = event.messages.length - 1; i >= 0; i -= 1) {
				const text = extractAssistantText(event.messages[i]);
				if (text !== "") {
					this._finalText = text;
					break;
				}
			}
		}
	}

	private recordTerminationIntent(intent: RunTerminationIntent): void {
		if (this._receipt !== undefined || isTerminalStatus(this._record.status)) return;
		if (this._terminationIntent !== undefined) return;
		this._terminationIntent = intent;
	}
}

/** Read-only handle returned when a retry key resolves to an existing Run. */
class ReplayedRunHandleImpl implements RunHandle {
	readonly runId: RunId;
	readonly sessionId: SessionId;
	private readonly coordinator: RunLifecycleCoordinatorImpl;
	private readonly _record: RunRecord;
	private readonly _receipt: RunReceipt | undefined;
	private readonly _recovery: RunRecoveryState | undefined;
	private readonly _policySummary: PublicPolicySummary | undefined;
	private _usageBaseline: RunUsageSnapshot | undefined;

	constructor(coordinator: RunLifecycleCoordinatorImpl, result: RunResult) {
		this.coordinator = coordinator;
		this._record = cloneRunRecord(result.record);
		this._receipt = result.receipt === undefined ? undefined : cloneRunReceipt(result.receipt);
		this._recovery = result.recovery;
		this._policySummary = result.policySummary === undefined ? undefined : clonePublicPolicySummary(result.policySummary);
		this.runId = this._record.id;
		this.sessionId = this._record.sessionId;
	}

	get record(): RunRecord {
		return cloneRunRecord(this._record);
	}

	get sequence(): number {
		return 0;
	}

	get cancelled(): boolean {
		return this._record.status === "cancelled";
	}

	get emitted(): readonly RunStreamEvent[] {
		return [];
	}

	get terminal(): RunStreamEvent | undefined {
		return undefined;
	}

	start(): RunStreamEvent[] {
		return [];
	}

	captureSessionEvent(_event: AgentSessionEvent): RunStreamEvent | undefined {
		return undefined;
	}

	requestCancel(): void {
		// A retry must not mutate a recovered Run or append a second terminal fact.
	}

	requestDeadlineExceeded(): void {
		// A retry must not mutate a recovered Run or append a second terminal fact.
	}

	setUsageBaseline(baseline: RunUsageSnapshot): void {
		this._usageBaseline = { input: baseline.input, output: baseline.output, total: baseline.total };
	}

	computeUsageDelta(current: RunUsageSnapshot): RunUsage {
		const baseline = this._usageBaseline;
		return {
			input: nonNegative(current.input - (baseline?.input ?? 0)),
			output: nonNegative(current.output - (baseline?.output ?? 0)),
			total: nonNegative(current.total - (baseline?.total ?? 0)),
		};
	}

	finalText(): string {
		return this._receipt?.finalText ?? "";
	}

	settle(_input: SettleInput): RunStreamEvent | undefined {
		this.coordinator.recordDiagnostic({ kind: "duplicate-terminal", runId: this.runId });
		return undefined;
	}

	receipt(): RunReceipt | undefined {
		return this._receipt === undefined ? undefined : cloneRunReceipt(this._receipt);
	}

	result(): RunResult {
		const result: RunResult = { record: this.record };
		if (this._receipt !== undefined) result.receipt = cloneRunReceipt(this._receipt);
		if (this._recovery !== undefined) result.recovery = this._recovery;
		if (this._policySummary !== undefined) result.policySummary = clonePublicPolicySummary(this._policySummary);
		return result;
	}
}

// ---- Reservation --------------------------------------------------------------

class RunReservationImpl implements RunReservation {
	readonly sessionId: SessionId;

	private readonly coordinator: RunLifecycleCoordinatorImpl;
	private readonly requestIdentity: RunRequestIdentity | undefined;
	private readonly _buffered: AgentSessionEvent[] = [];
	private consumed = false;

	constructor(coordinator: RunLifecycleCoordinatorImpl, requestIdentity?: RunRequestIdentity) {
		this.coordinator = coordinator;
		this.sessionId = coordinator.sessionId;
		this.requestIdentity = requestIdentity;
	}

	captureSessionEvent(event: AgentSessionEvent): void {
		if (!this.consumed) this._buffered.push(event);
	}

	accept(options: AcceptOptions): RunHandle {
		if (this.consumed) {
			throw createAutomationError("start_rejected", "reservation has already been accepted or released", false);
		}
		let run: RunHandleImpl;
		try {
			const optionIdentity = requestIdentityFromOptions(options);
			if (
				this.requestIdentity !== undefined &&
				optionIdentity !== undefined &&
				(this.requestIdentity.scope !== optionIdentity.scope ||
					this.requestIdentity.clientRequestId !== optionIdentity.clientRequestId ||
					this.requestIdentity.requestFingerprint !== optionIdentity.requestFingerprint)
			) {
				throw runRequestConflictError();
			}
			const requestIdentity = this.requestIdentity ?? optionIdentity;
			if (requestIdentity !== undefined) {
				const duplicate = this.coordinator.getRunForRequest(requestIdentity);
				if (duplicate !== undefined) {
					this.consumed = true;
					this.coordinator.confirmRelease(this);
					return this.coordinator.replayedHandle(duplicate);
				}
			}
			const acceptedOptions =
				requestIdentity === undefined
					? options
					: {
							...options,
							requestScope: requestIdentity.scope,
							clientRequestId: requestIdentity.clientRequestId,
							requestFingerprint: requestIdentity.requestFingerprint,
						};
			run = new RunHandleImpl(this.coordinator, this.sessionId, acceptedOptions, requestIdentity);
			this.coordinator.validateAcceptedPolicyFacts(run.runId, acceptedOptions);
			if (acceptedOptions.external !== undefined) {
				this.coordinator.validateExternalMapping({
					external: acceptedOptions.external,
					aosSessionId: this.sessionId,
					aosRunId: run.runId,
				});
			}
			this.coordinator.persist({ schemaVersion: 1, kind: "accepted", record: run.record });
			this.coordinator.indexAcceptedRun(run.record);
			if (acceptedOptions.external !== undefined) {
				this.coordinator.persistExternalMapping({
					external: acceptedOptions.external,
					aosSessionId: this.sessionId,
					aosRunId: run.runId,
				});
			}
			if (acceptedOptions.capabilityBinding !== undefined) {
				this.coordinator.persistCapabilityBinding(acceptedOptions.capabilityBinding);
			}
			this.coordinator.persistAcceptedPolicyFacts(run.runId, acceptedOptions);
		} catch (error) {
			// Consume and release the held reservation so the session is free for the next reserve.
			this.consumed = true;
			this.coordinator.confirmRelease(this);
			throw error;
		}
		this.consumed = true;
		this.coordinator.confirmAccept(run);
		for (const event of this._buffered.splice(0)) {
			run.captureSessionEvent(event);
		}
		return run;
	}

	release(): void {
		if (this.consumed) return;
		this.consumed = true;
		this.coordinator.confirmRelease(this);
	}
}

// ---- Coordinator --------------------------------------------------------------

class RunLifecycleCoordinatorImpl implements RunLifecycleCoordinator {
	readonly sessionId: SessionId;
	readonly session: RunLedgerSession;

	private readonly nowFn: () => string;
	private readonly runIdFn: () => RunId;
	private readonly diagnosticsSink: (message: string) => void;
	private readonly policyLedger: ReturnType<typeof createExecutionPolicyLedger>;
	private readonly externalMappings: ExternalSessionMappingStore;
	private readonly runs = new Map<RunId, RunHandleImpl>();
	private readonly diagnosedEntries = new Set<string>();
	private readonly _diagnostics: LedgerDiagnostic[] = [];
	private _capabilityBindings = new Map<string, CapabilityBindingLedgerRecord>();
	private readonly _requestIndex = new Map<string, { runId: RunId; requestFingerprint: string }>();
	private readonly _requestConflicts = new Set<string>();
	private _active: RunHandleImpl | undefined;
	private _reserved: RunReservationImpl | undefined;

	constructor(session: RunLedgerSession, options: RunLifecycleCoordinatorOptions = {}) {
		this.session = session;
		this.sessionId = session.getSessionId();
		this.nowFn = options.now ?? (() => new Date().toISOString());
		this.runIdFn = options.runId ?? (() => randomUUID());
		this.diagnosticsSink = options.diagnostics ?? ((message) => console.error(message));
		try {
			this.externalMappings = new ExternalSessionMappingStore(session, {
				now: () => this.now(),
				diagnostics: (warning) => this.recordExternalMappingWarning(warning),
			});
		} catch (error) {
			if (error instanceof ExternalMappingError) {
				throw createAutomationError(error.code, error.message, false);
			}
			throw createAutomationError(
				"audit_persistence_failed",
				"External mapping state could not be loaded safely.",
				false,
			);
		}
		this.policyLedger = createExecutionPolicyLedger(session);
	}

	get activeRun(): RunResult | undefined {
		return this._active?.result();
	}

	now(): string {
		return this.nowFn();
	}

	nextRunId(): RunId {
		return this.runIdFn();
	}

	reserve(): RunReservation {
		return this.reserveWithRequest();
	}

	getActiveRun(): RunResult | undefined {
		return this.activeRun;
	}

	getRun(runId: RunId): RunResult | undefined {
		const live = this.runs.get(runId);
		if (live !== undefined) return live.result();
		return this.rebuildIndex().get(runId);
	}

	reserveForRequest(request: RunRequestIdentity): RunRequestReservation {
		const duplicate = this.getRunForRequest(request);
		if (duplicate !== undefined) return { kind: "duplicate", result: duplicate };
		return { kind: "new", reservation: this.reserveWithRequest(request) };
	}

	getRunForRequest(request: RunRequestIdentity): RunResult | undefined {
		if (!isRunRequestIdentity(request)) {
			throw createAutomationError(
				"run_request_invalid",
				"Run request idempotency metadata must include a valid scope, clientRequestId, and requestFingerprint.",
				false,
			);
		}
		const key = createRunRequestKey(request);
		if (this._requestConflicts.has(key)) throw runRequestConflictError();
		const indexed = this._requestIndex.get(key);
		if (indexed !== undefined) {
			if (indexed.requestFingerprint !== request.requestFingerprint) throw runRequestConflictError();
			const live = this.runs.get(indexed.runId);
			if (live !== undefined) return live.result();
			const rebuilt = this.rebuildIndex();
			if (this._requestConflicts.has(key)) throw runRequestConflictError();
			const result = rebuilt.get(indexed.runId);
			if (result === undefined) return undefined;
			const identity = requestIdentityFromRecord(result.record);
			if (identity === undefined || identity.requestFingerprint !== request.requestFingerprint) {
				this._requestConflicts.add(key);
				throw runRequestConflictError();
			}
			return result;
		}
		const rebuilt = this.rebuildIndex();
		if (this._requestConflicts.has(key)) throw runRequestConflictError();
		const result = [...rebuilt.values()].find((candidate) => {
			const identity = requestIdentityFromRecord(candidate.record);
			return identity !== undefined && createRunRequestKey(identity) === key;
		});
		if (result === undefined) return undefined;
		const identity = requestIdentityFromRecord(result.record);
		if (identity === undefined) return undefined;
		if (identity.requestFingerprint !== request.requestFingerprint) {
			this._requestConflicts.add(key);
			throw runRequestConflictError();
		}
		this._requestIndex.set(key, { runId: result.record.id, requestFingerprint: identity.requestFingerprint });
		return result;
	}

	getRunByClientRequestId(clientRequestId: string, scope?: RunRequestScope): RunRequestLookup | undefined {
		for (const run of this.runs.values()) {
			const relation = requestRelationFromRecord(run.record);
			if (relation === undefined || relation.clientRequestId !== clientRequestId) continue;
			if (scope !== undefined && relation.scope !== scope) continue;
			return { clientRequestId, scope: relation.scope, fingerprint: relation.fingerprint, result: run.result() };
		}
		const results = this.rebuildIndex();
		const scopes: RunRequestScope[] = scope === undefined ? ["start", "resume"] : [scope];
		for (const candidateScope of scopes) {
			const indexed = this._requestIndex.get(`${candidateScope}\u0000${clientRequestId}`);
			if (indexed === undefined) continue;
			const result = results.get(indexed.runId);
			if (result === undefined) continue;
			return {
				clientRequestId,
				scope: candidateScope,
				fingerprint: indexed.requestFingerprint,
				result,
			};
		}
		return undefined;
	}

	rebuildIndex(): ReadonlyMap<RunId, RunResult> {
		this.externalMappings.refresh();
		const results = new Map<RunId, RunResult>();
		const bindings = new Map<string, CapabilityBindingLedgerRecord>();
		this._requestIndex.clear();
		this._requestConflicts.clear();
		for (const entry of this.session.getEntries()) {
			if (entry.type !== "custom") continue;
			if (entry.customType === CAPABILITY_BINDING_CUSTOM_TYPE) {
				const parsed = parseCapabilityBindingEntry(entry.data, entry.id);
				if (!parsed.ok) {
					this.emitIfNew(entry.id, parsed.diag);
					continue;
				}
				bindings.set(parsed.entry.binding.id, parsed.entry.binding);
				continue;
			}
			if (entry.customType !== RUN_LEDGER_CUSTOM_TYPE) continue;
			const parsed = parseLedgerEntry(entry.data);
			if (!parsed.ok) {
				this.emitIfNew(entry.id, toDiagnostic(parsed, entry.id));
				continue;
			}
			const fact = parsed.entry;
			if (fact.kind === "accepted") {
				const existing = results.get(fact.record.id);
				// Clone before applying later facts so the persisted entry.data is never mutated.
				const record = cloneRunRecord(fact.record);
				if (existing === undefined) {
					results.set(fact.record.id, { record });
				} else {
					existing.record = record;
				}
				if (existing === undefined) this.indexAcceptedRun(record);
			} else if (fact.kind === "started") {
				const result = results.get(fact.runId);
				if (result === undefined) {
					this.emitIfNew(entry.id, { kind: "orphan-fact", entryId: entry.id, runId: fact.runId, fact: "started" });
					continue;
				}
				result.record.startedAt = fact.startedAt;
				result.record.status = "running";
			} else {
				const result = results.get(fact.receipt.runId);
				if (result === undefined) {
					this.emitIfNew(entry.id, {
						kind: "orphan-fact",
						entryId: entry.id,
						runId: fact.receipt.runId,
						fact: "terminal",
					});
					continue;
				}
				if (result.receipt !== undefined) {
					// Already terminal; first receipt wins and the duplicate is a diagnostic.
					this.emitIfNew(entry.id, { kind: "duplicate-terminal", runId: fact.receipt.runId });
					continue;
				}
				result.receipt = cloneRunReceipt(fact.receipt);
				result.record.status = fact.receipt.status;
				result.record.endedAt = fact.endedAt;
				if (fact.receipt.terminalError !== undefined) {
					result.record.terminalError = cloneAutomationError(fact.receipt.terminalError);
				}
				if (fact.receipt.deadlineAt !== undefined) result.record.deadlineAt = fact.receipt.deadlineAt;
				if (fact.receipt.bindingAssociation !== undefined) {
					const bindingAssociation = serializePublicRunBindingAssociation(fact.receipt.bindingAssociation);
					if (bindingAssociation !== undefined) result.record.bindingAssociation = bindingAssociation;
				}
				if (fact.receipt.modelBindingId !== undefined) result.record.modelBindingId = fact.receipt.modelBindingId;
				if (fact.receipt.previousModelBindingId !== undefined) {
					result.record.previousModelBindingId = fact.receipt.previousModelBindingId;
				}
				if (fact.receipt.policyBindingId !== undefined)
					result.record.policyBindingId = fact.receipt.policyBindingId;
				if (fact.receipt.previousPolicyBindingId !== undefined) {
					result.record.previousPolicyBindingId = fact.receipt.previousPolicyBindingId;
				}
				if (fact.receipt.policySummary !== undefined) {
					const policySummary = clonePublicPolicySummary(fact.receipt.policySummary);
					if (policySummary !== undefined) result.record.policySummary = policySummary;
				}
				if (fact.receipt.finalModel !== undefined) result.record.finalModel = { ...fact.receipt.finalModel };
				if (fact.receipt.modelAttempts !== undefined) {
					result.record.modelAttempts = fact.receipt.modelAttempts.map((attempt) => ({
						...attempt,
						candidate: { ...attempt.candidate },
						...(attempt.usage === undefined ? {} : { usage: { ...attempt.usage } }),
					}));
				}
				if (fact.receipt.modelBudget !== undefined) result.record.modelBudget = { ...fact.receipt.modelBudget };
			}
		}
		for (const result of results.values()) {
			for (const mapping of this.externalMappings.getMappings()) {
				if (mapping.aosSessionId !== this.sessionId || mapping.aosRunId !== result.record.id) continue;
				const mappingExternal = externalRefFromMapping(mapping);
				if (mappingExternal === undefined) continue;
				const usable = this.externalMappings.getByExternal(mappingExternal);
				if (usable === undefined) continue;
				const external = externalRefFromMapping(usable);
				if (external === undefined) continue;
				if (result.record.external === undefined) result.record.external = external;
				if (result.receipt !== undefined && result.receipt.external === undefined) result.receipt.external = external;
			}
			if (result.receipt === undefined) result.recovery = "interrupted";
			const policySummary = result.receipt?.policySummary ?? result.record.policySummary;
			if (policySummary !== undefined) {
				const cloned = clonePublicPolicySummary(policySummary);
				if (cloned !== undefined) result.policySummary = cloned;
			}
		}
		this._capabilityBindings = bindings;
		return results;
	}

	diagnostics(): readonly LedgerDiagnostic[] {
		return this._diagnostics;
	}

	persist(entry: PersistedRunLedgerEntry): void {
		try {
			this.session.appendCustomEntry(RUN_LEDGER_CUSTOM_TYPE, entry);
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			throw createAutomationError(
				"ledger_persistence_failed",
				`failed to persist run ledger entry: ${detail}`,
				false,
			);
		}
	}

	getCapabilityBindings(): ReadonlyMap<string, CapabilityBindingLedgerRecord> {
		// Re-fold from the session ledger so persisted bindings written by an
		// earlier coordinator (or a previous process) are visible.
		this.rebuildIndex();
		return this._capabilityBindings;
	}

	persistExternalMapping(request: ExternalMappingRequest): ExternalMappingPersistenceResult {
		if (request.aosSessionId !== this.sessionId) {
			throw createAutomationError(
				"external_mapping_invalid",
				"External mapping AOS session does not match the current session.",
				false,
			);
		}
		try {
			const result = this.externalMappings.persistMapping(request);
			if (request.aosRunId !== undefined) {
				const live = this.runs.get(request.aosRunId);
				const external = externalRefFromMapping(result.mapping);
				if (live !== undefined && external !== undefined) live.setExternalMapping(external);
			}
			return result;
		} catch (error) {
			if (error instanceof ExternalMappingError) {
				throw createAutomationError(error.code, error.message, false);
			}
			throw createAutomationError("audit_persistence_failed", "External mapping could not be persisted.", false);
		}
	}

	validateExternalMapping(request: ExternalMappingRequest): void {
		if (request.aosSessionId !== this.sessionId) {
			throw createAutomationError(
				"external_mapping_invalid",
				"External mapping AOS session does not match the current session.",
				false,
			);
		}
		try {
			this.externalMappings.validateMapping(request);
		} catch (error) {
			if (error instanceof ExternalMappingError) {
				throw createAutomationError(error.code, error.message, false);
			}
			throw createAutomationError(
				"audit_persistence_failed",
				"External mapping state could not be validated safely.",
				false,
			);
		}
	}

	getExternalMappings(): ReadonlyArray<ExternalExecutionMapping> {
		this.externalMappings.refresh();
		return this.externalMappings.getMappings().filter((mapping) => mapping.aosSessionId === this.sessionId);
	}

	getExternalMappingWarnings(): readonly ExternalMappingWarning[] {
		this.externalMappings.refresh();
		return this.externalMappings.getWarnings();
	}

	persistCapabilityBinding(binding: CapabilityBindingLedgerRecord): void {
		try {
			this.session.appendCustomEntry(CAPABILITY_BINDING_CUSTOM_TYPE, {
				schemaVersion: CAPABILITY_BINDING_SCHEMA_VERSION,
				binding,
			});
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			throw createAutomationError(
				"ledger_persistence_failed",
				`failed to persist capability binding entry: ${detail}`,
				false,
			);
		}
	}

	persistAcceptedPolicyFacts(runId: RunId, options: AcceptOptions): void {
		this.validateAcceptedPolicyFacts(runId, options);
		const binding = options.policyBinding;
		if (binding === undefined) return;
		this.persistPolicyFacts({
			policyBindingId: binding.id,
			policyBinding: binding,
			policyDecision: options.policyDecision,
			policyApproval: options.policyApproval,
			sandboxLifecycle: options.sandboxLifecycle,
			policyViolation: options.policyViolation,
		});
	}

	validateAcceptedPolicyFacts(runId: RunId, options: AcceptOptions): void {
		const binding = options.policyBinding;
		if (binding === undefined) return;
		if (binding.runId !== runId) {
			throw createAutomationError(
				"policy_binding_failed",
				"Execution Policy binding runId does not match the accepted run.",
				false,
			);
		}
		if (binding.previousPolicyBindingId !== undefined && binding.previousPolicyBindingId === binding.id) {
			throw createAutomationError(
				"policy_binding_failed",
				"Execution Policy resume binding must be a successor binding.",
				false,
			);
		}
		if (
			options.previousPolicyBindingId !== undefined &&
			binding.previousPolicyBindingId !== options.previousPolicyBindingId
		) {
			throw createAutomationError(
				"policy_binding_failed",
				"Execution Policy resume binding does not match the source binding.",
				false,
			);
		}
		if (options.policyDecision !== undefined)
			this.assertPolicyFactBinding(binding.id, options.policyDecision.bindingId);
		if (options.policyApproval !== undefined)
			this.assertPolicyFactBinding(binding.id, options.policyApproval.bindingId);
		if (options.sandboxLifecycle !== undefined)
			this.assertPolicyFactBinding(binding.id, options.sandboxLifecycle.bindingId);
		if (options.policyViolation !== undefined)
			this.assertPolicyFactBinding(binding.id, options.policyViolation.bindingId);
	}

	persistPolicyFacts(input: {
		policyBindingId?: string;
		policyBinding?: PolicyBinding;
		policyDecision?: PolicyDecision;
		policyApproval?: PolicyApprovalRequest;
		sandboxLifecycle?: SandboxLifecycleLedgerRecord;
		policyViolation?: PolicyViolationLedgerRecord;
	}): void {
		try {
			const bindingId = input.policyBinding?.id ?? input.policyBindingId;
			if (bindingId === undefined) {
				if (
					input.policyDecision !== undefined ||
					input.policyApproval !== undefined ||
					input.sandboxLifecycle !== undefined ||
					input.policyViolation !== undefined
				) {
					throw createAutomationError(
						"policy_binding_failed",
						"Execution Policy facts require a policy binding.",
						false,
					);
				}
				return;
			}
			if (input.policyBinding !== undefined) this.policyLedger.appendBinding(input.policyBinding);
			if (input.policyDecision !== undefined) {
				this.assertPolicyFactBinding(bindingId, input.policyDecision.bindingId);
				this.policyLedger.appendDecision(input.policyDecision);
			}
			if (input.policyApproval !== undefined) {
				this.assertPolicyFactBinding(bindingId, input.policyApproval.bindingId);
				this.policyLedger.appendApproval(input.policyApproval);
			}
			if (input.sandboxLifecycle !== undefined) {
				this.assertPolicyFactBinding(bindingId, input.sandboxLifecycle.bindingId);
				this.policyLedger.appendSandboxLifecycle(input.sandboxLifecycle);
			}
			if (input.policyViolation !== undefined) {
				this.assertPolicyFactBinding(bindingId, input.policyViolation.bindingId);
				this.policyLedger.appendViolation(input.policyViolation);
			}
		} catch (error) {
			if (isAutomationError(error)) throw error;
			const code = typeof error === "object" && error !== null && isPolicyErrorCode((error as { code?: unknown }).code)
				? (error as { code: PolicyErrorCode }).code
				: "policy_ledger_persistence_failed";
			throw createAutomationError(
				code === "policy_binding_failed" ? "policy_binding_failed" : "policy_ledger_persistence_failed",
				code === "policy_binding_failed" ? "Execution Policy binding could not be created." : "Execution Policy facts could not be recorded safely.",
				false,
			);
		}
	}

	recordDiagnostic(diag: LedgerDiagnostic): void {
		this._diagnostics.push(diag);
		this.diagnosticsSink(formatDiagnostic(diag));
	}

	private recordExternalMappingWarning(warning: ExternalMappingWarning): void {
		if (warning.code === "mapping_conflict") {
			this.recordDiagnostic({ kind: "mapping-conflict", entryId: warning.entryId });
		} else {
			this.recordDiagnostic({ kind: "malformed-mapping", entryId: warning.entryId });
		}
	}

	confirmAccept(run: RunHandleImpl): void {
		this._reserved = undefined;
		this.registerRun(run);
	}

	confirmRelease(reservation: RunReservationImpl): void {
		if (this._reserved === reservation) this._reserved = undefined;
	}

	registerRun(run: RunHandleImpl): void {
		this.runs.set(run.runId, run);
		this.indexAcceptedRun(run.record);
		this._active = run;
	}

	replayedHandle(result: RunResult): RunHandle {
		return new ReplayedRunHandleImpl(this, result);
	}

	private reserveWithRequest(requestIdentity?: RunRequestIdentity): RunReservation {
		if (this._active !== undefined) {
			throw createAutomationError(
				"session_busy",
				`Session ${this.sessionId} already has an active run (${this._active.runId})`,
				true,
			);
		}
		if (this._reserved !== undefined) {
			throw createAutomationError(
				"session_busy",
				`Session ${this.sessionId} already has a pending reservation`,
				true,
			);
		}
		const reservation = new RunReservationImpl(this, requestIdentity);
		this._reserved = reservation;
		return reservation;
	}

	indexAcceptedRun(record: RunRecord): void {
		const identity = requestIdentityFromRecord(record);
		if (identity === undefined) return;
		const key = createRunRequestKey(identity);
		const existing = this._requestIndex.get(key);
		if (existing !== undefined && (existing.runId !== record.id || existing.requestFingerprint !== identity.requestFingerprint)) {
			this._requestConflicts.add(key);
			return;
		}
		this._requestIndex.set(key, { runId: record.id, requestFingerprint: identity.requestFingerprint });
	}

	onTerminal(run: RunHandleImpl): void {
		if (this._active === run) this._active = undefined;
	}

	private emitIfNew(entryId: string, diag: LedgerDiagnostic): void {
		if (this.diagnosedEntries.has(entryId)) return;
		this.diagnosedEntries.add(entryId);
		this.recordDiagnostic(diag);
	}

	private assertPolicyFactBinding(policyBindingId: string, factBindingId: string): void {
		if (factBindingId === policyBindingId) return;
		throw createAutomationError(
			"policy_binding_failed",
			"Execution Policy fact does not match the run binding.",
			false,
		);
	}
}

export function createRunLifecycleCoordinator(
	session: RunLedgerSession,
	options?: RunLifecycleCoordinatorOptions,
): RunLifecycleCoordinator {
	return new RunLifecycleCoordinatorImpl(session, options);
}
