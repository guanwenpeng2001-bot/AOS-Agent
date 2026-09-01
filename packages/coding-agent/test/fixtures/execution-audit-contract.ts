/**
 * -only Execution Audit / Replay contract fixture.
 *
 * This file intentionally does not import production code. It records the
 * values and public shapes that the implementation tasks must preserve. The
 * fixture contains no runtime wiring and is safe to reuse from contract and
 * regression tests.
 */

export const AUDIT_SCHEMA_VERSION = 1 as const;

export const AUDIT_SOURCE_CUSTOM_TYPES = [
	"model.binding",
	"model.attempt",
	"context.snapshot",
	"capability.binding",
	"policy.binding",
	"policy.decision",
	"policy.approval",
	"sandbox.lifecycle",
	"policy.violation",
	"task.gate",
] as const;
export type AuditSourceCustomType = (typeof AUDIT_SOURCE_CUSTOM_TYPES)[number];

/**
 * `context.memory` is intentionally not an audit source because it contains
 * user text; `mcp.content.audit` is the allowlist-only per-operation MCP
 * trail (no run facts) and stays inspectable as a Session custom entry.
 */
export const AUDIT_EXCLUDED_CUSTOM_TYPES = ["context.memory", "mcp.content.audit"] as const;

export const AUDIT_EVENT_TYPES = [
	"run.accepted",
	"run.started",
	"run.completed",
	"run.failed",
	"run.cancelled",
	"run.interrupted",
	"model.binding",
	"model.attempt",
	"context.snapshot",
	"capability.binding",
	"policy.binding",
	"policy.decision",
	"policy.approval",
	"sandbox.lifecycle",
	"policy.violation",
	"task.gate",
] as const;
export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number];

export const AUDIT_RUN_EVENT_STATUSES = [
	"accepted",
	"running",
	"completed",
	"failed",
	"cancelled",
	"interrupted",
] as const;
export type AuditRunEventStatus = (typeof AUDIT_RUN_EVENT_STATUSES)[number];

export const AUDIT_REPLAY_STATUSES = ["complete", "interrupted", "incomplete"] as const;
export type AuditReplayStatus = (typeof AUDIT_REPLAY_STATUSES)[number];

export const AUDIT_QUERY_SCOPES = ["current-session", "session-directory"] as const;
export type AuditQueryScope = (typeof AUDIT_QUERY_SCOPES)[number];

export const AUDIT_QUERY_COMMAND = "audit.query" as const;
export const AUDIT_REPLAY_COMMAND = "audit.replay" as const;
export const AUDIT_EXPORT_COMMAND = "audit.export" as const;

export const AUDIT_WARNING_CODES = [
	"unknown_source",
	"malformed_source",
	"unsupported_schema",
	"orphan_source",
	"duplicate_source",
	"source_unavailable",
	"ambiguous_run_association",
] as const;
export type AuditWarningCode = (typeof AUDIT_WARNING_CODES)[number];

export const AUDIT_ERROR_CODES = [
	"audit_query_invalid",
	"audit_cursor_invalid",
	"audit_scope_unavailable",
	"audit_run_not_found",
	"audit_replay_incomplete",
] as const;
export type AuditErrorCode = (typeof AUDIT_ERROR_CODES)[number];

export const AUDIT_DEFAULT_LIMIT = 50 as const;
export const AUDIT_MAX_LIMIT = 200 as const;

/** The complete stable sort key encoded by an opaque cursor. */
export const AUDIT_CURSOR_SORT_KEYS = ["recordedAt", "sessionId", "sourceEntryId", "eventId"] as const;

export interface AuditRunModelReference {
	readonly provider: string;
	readonly id: string;
	readonly thinkingLevel: string;
}

export interface AuditRunFinalModelReference {
	readonly provider: string;
	readonly id?: string;
	readonly modelId?: string;
	readonly thinkingLevel?: string;
}

export interface AuditModelReference {
	readonly provider: string;
	readonly modelId: string;
	readonly thinkingLevel?: string;
}

export interface AuditModelUsageSummary {
	readonly inputTokens?: number;
	readonly outputTokens?: number;
	readonly totalTokens?: number;
	readonly costUsd?: number;
	readonly input?: number;
	readonly output?: number;
	readonly total?: number;
	readonly cost?: number;
}

export interface AuditModelAttemptSummary {
	readonly attemptId: string;
	readonly bindingId: string;
	readonly candidate: AuditModelReference;
	readonly order: number;
	readonly status: "started" | "completed" | "failed" | "cancelled";
	readonly startedAt: string;
	readonly endedAt?: string;
	readonly failureCategory?: string;
	readonly usage?: AuditModelUsageSummary;
	readonly visibleOutput?: boolean;
	readonly contextSnapshotId?: string;
	readonly summary?: string;
}

export interface AuditModelBudgetSummary {
	readonly modelCalls?: number;
	readonly inputTokens?: number;
	readonly outputTokens?: number;
	readonly totalTokens?: number;
	readonly costUsd?: number;
	readonly maxModelCalls?: number;
	readonly maxInputTokens?: number;
	readonly maxOutputTokens?: number;
	readonly maxTotalTokens?: number;
	readonly maxCostUsd?: number;
	readonly exceeded?: boolean;
}

export interface AuditRunSummary {
	readonly status: AuditRunEventStatus;
	readonly attempt: number;
	readonly model: AuditRunModelReference;
	readonly sourceRunId?: string;
	readonly previousBindingId?: string;
	readonly capabilityBindingId?: string;
	readonly modelBindingId?: string;
	readonly previousModelBindingId?: string;
	readonly policyBindingId?: string;
	readonly previousPolicyBindingId?: string;
	readonly contextSnapshotId?: string;
	readonly startedAt?: string;
	readonly endedAt?: string;
	readonly terminalError?: { readonly code: string; readonly retryable: boolean };
	readonly finalModel?: AuditRunFinalModelReference;
	readonly modelBudget?: AuditModelBudgetSummary;
}

export interface AuditModelBudgetLimitSummary {
	readonly maxModelCalls?: number;
	readonly maxInputTokens?: number;
	readonly maxOutputTokens?: number;
	readonly maxTotalTokens?: number;
	readonly maxCostUsd?: number;
}

export interface AuditModelBindingSummary {
	readonly bindingId: string;
	readonly mode: "manual" | "route" | "direct";
	readonly routeId?: string;
	readonly role?: string;
	readonly candidates: ReadonlyArray<{ readonly order: number; readonly model: AuditModelReference }>;
	readonly fallback: { readonly maxAttempts: number; readonly on: ReadonlyArray<string> };
	readonly budget: AuditModelBudgetLimitSummary;
	readonly configRevision: string;
	readonly createdAt: string;
	readonly previousModelBindingId?: string;
}

export interface AuditContextSourceSummary {
	readonly kind: string;
	readonly scope: string;
	readonly trust: string;
	readonly visibility?: string;
	readonly contentDigest: string;
	readonly estimatedTokens: number;
	readonly disposition: string;
	readonly reason?: string;
}

export interface AuditContextSnapshotSummary {
	readonly schemaVersion: 1;
	readonly id: string;
	readonly purpose: string;
	readonly sessionId: string;
	readonly runId?: string;
	readonly createdAt: string;
	readonly parentSnapshotId?: string;
	readonly sources: ReadonlyArray<AuditContextSourceSummary>;
	readonly budget: {
		readonly contextWindow: number;
		readonly reserveTokens: number;
		readonly inputLimit: number;
		readonly estimatedInputTokens: number;
	};
}

export interface AuditCapabilityBindingSummary {
	readonly id: string;
	readonly profile: string;
	readonly createdAt: string;
	readonly descriptors: ReadonlyArray<{
		readonly id: string;
		readonly revision: string;
		exposedToolName?: string;
	}>;
	readonly decisionSummary: { readonly allowed: number; readonly awaitingApproval: number; readonly denied: number };
	readonly toolAllowlist: ReadonlyArray<string>;
}

export interface AuditPolicySummary {
	readonly bindingId: string;
	readonly profileId: string;
	readonly profileRevision: string;
	readonly projectTrust: "trusted" | "untrusted";
	readonly enforcement: "legacy" | "host" | "sandbox";
	readonly sandboxProviderId?: string;
	readonly sandboxStatus: "not_required" | "unavailable" | "preparing" | "ready" | "failed" | "disposed";
	readonly sandboxCapabilities: {
		readonly filesystem: boolean;
		readonly process: boolean;
		readonly network: boolean;
		readonly credentialIsolation: boolean;
	};
	readonly resource?: string;
	readonly action?: "allow" | "ask" | "deny";
	readonly outcome?: "allow" | "ask" | "deny" | "sandbox_required";
	readonly reasonCode?: string;
	readonly requestId?: string;
	readonly timestamp?: string;
}

export interface AuditPolicyApprovalSummary {
	readonly id: string;
	readonly requestId?: string;
	readonly bindingId: string;
	readonly resource: string;
	readonly reasonCode: "policy_approval_required";
	readonly createdAt: string;
	readonly outcome?: "approved" | "rejected";
	readonly source?: "interactive" | "rpc" | "sdk" | "system";
	readonly scope: {
		readonly resource: string;
		readonly workspaceScopes?: ReadonlyArray<string>;
		readonly environmentCount?: number;
		readonly destinationCount?: number;
		readonly credentialCount?: number;
	};
}

export interface AuditSandboxLifecycleSummary {
	readonly bindingId: string;
	readonly status: "not_required" | "unavailable" | "preparing" | "ready" | "failed" | "disposed";
	readonly timestamp: string;
	readonly providerId?: string;
	readonly capabilities?: AuditPolicySummary["sandboxCapabilities"];
	readonly reasonCode?: string;
}

export interface AuditPolicyViolationSummary {
	readonly bindingId: string;
	readonly timestamp: string;
	readonly reasonCode: string;
	readonly resource?: string;
	readonly requestId?: string;
}

export interface AuditTaskGateSummary {
	readonly gateId: string;
	readonly taskId: string;
	readonly stageId: string;
	readonly stageRevision: number;
	readonly action: "requested" | "approved" | "rejected" | "cancelled";
	readonly status: "pending" | "approved" | "rejected" | "cancelled";
	readonly revision: number;
	readonly requestedAt: string;
	readonly decidedAt?: string;
	readonly runId?: string;
	readonly actorId?: string;
	readonly reasonCode?: string;
}

export interface AuditEventBase {
	readonly schemaVersion: 1;
	readonly eventId: string;
	readonly recordedAt: string;
	readonly sessionId: string;
	readonly sourceEntryId: string;
}

export type AuditEvent =
	| (AuditEventBase & { readonly type: "run.accepted"; readonly runId: string; readonly summary: AuditRunSummary })
	| (AuditEventBase & { readonly type: "run.started"; readonly runId: string; readonly summary: AuditRunSummary })
	| (AuditEventBase & { readonly type: "run.completed"; readonly runId: string; readonly summary: AuditRunSummary })
	| (AuditEventBase & { readonly type: "run.failed"; readonly runId: string; readonly summary: AuditRunSummary })
	| (AuditEventBase & { readonly type: "run.cancelled"; readonly runId: string; readonly summary: AuditRunSummary })
	| (AuditEventBase & { readonly type: "run.interrupted"; readonly runId: string; readonly summary: AuditRunSummary })
	| (AuditEventBase & {
			readonly type: "model.binding";
			readonly runId?: string;
			readonly summary: AuditModelBindingSummary;
	  })
	| (AuditEventBase & {
			readonly type: "model.attempt";
			readonly runId?: string;
			readonly summary: AuditModelAttemptSummary;
	  })
	| (AuditEventBase & {
			readonly type: "context.snapshot";
			readonly runId?: string;
			readonly summary: AuditContextSnapshotSummary;
	  })
	| (AuditEventBase & {
			readonly type: "capability.binding";
			readonly runId?: string;
			readonly summary: AuditCapabilityBindingSummary;
	  })
	| (AuditEventBase & {
			readonly type: "policy.binding";
			readonly runId?: string;
			readonly summary: AuditPolicySummary;
	  })
	| (AuditEventBase & {
			readonly type: "policy.decision";
			readonly runId?: string;
			readonly summary: AuditPolicySummary;
	  })
	| (AuditEventBase & {
			readonly type: "policy.approval";
			readonly runId?: string;
			readonly summary: AuditPolicyApprovalSummary;
	  })
	| (AuditEventBase & {
			readonly type: "sandbox.lifecycle";
			readonly runId?: string;
			readonly summary: AuditSandboxLifecycleSummary;
	  })
	| (AuditEventBase & {
			readonly type: "policy.violation";
			readonly runId?: string;
			readonly summary: AuditPolicyViolationSummary;
	  })
	| (AuditEventBase & { readonly type: "task.gate"; readonly runId?: string; readonly summary: AuditTaskGateSummary });

export interface AuditWarning {
	readonly code: AuditWarningCode;
	readonly sessionId?: string;
	readonly sourceEntryId?: string;
	readonly eventType?: AuditEventType;
	readonly schemaVersion?: number;
}

export interface AuditQuery {
	readonly scope: AuditQueryScope;
	readonly sessionId?: string;
	readonly runId?: string;
	readonly types?: ReadonlyArray<AuditEventType>;
	/** Inclusive lower bound, in ISO-8601 form. */
	readonly from?: string;
	/** Exclusive upper bound, in ISO-8601 form. */
	readonly to?: string;
	/** Opaque server-issued cursor bound to the complete query fingerprint. */
	readonly cursor?: string;
	readonly limit?: number;
}

export interface AuditQueryResult {
	readonly schemaVersion: 1;
	readonly scope: AuditQueryScope;
	readonly events: ReadonlyArray<AuditEvent>;
	readonly nextCursor?: string;
	readonly warnings: ReadonlyArray<AuditWarning>;
}

export interface AuditReplayResult {
	readonly schemaVersion: 1;
	readonly run: AuditRunSummary;
	readonly events: ReadonlyArray<AuditEvent>;
	readonly nextCursor?: string;
	readonly status: AuditReplayStatus;
	readonly warnings: ReadonlyArray<AuditWarning>;
}

export const AUDIT_PUBLIC_SUMMARY_KEYS = {
	run: [
		"status",
		"attempt",
		"model",
		"sourceRunId",
		"previousBindingId",
		"capabilityBindingId",
		"modelBindingId",
		"previousModelBindingId",
		"policyBindingId",
		"previousPolicyBindingId",
		"contextSnapshotId",
		"startedAt",
		"endedAt",
		"terminalError",
		"finalModel",
		"modelBudget",
		"attachments",
	],
	modelBinding: [
		"bindingId",
		"mode",
		"routeId",
		"role",
		"candidates",
		"fallback",
		"budget",
		"configRevision",
		"createdAt",
		"previousModelBindingId",
	],
	modelAttempt: [
		"attemptId",
		"bindingId",
		"candidate",
		"order",
		"status",
		"startedAt",
		"endedAt",
		"failureCategory",
		"usage",
		"visibleOutput",
		"contextSnapshotId",
		"summary",
	],
	contextSnapshot: [
		"schemaVersion",
		"id",
		"purpose",
		"sessionId",
		"runId",
		"createdAt",
		"parentSnapshotId",
		"sources",
		"budget",
	],
	contextSource: ["kind", "scope", "trust", "visibility", "contentDigest", "estimatedTokens", "disposition", "reason"],
	capabilityBinding: ["id", "profile", "createdAt", "descriptors", "decisionSummary", "toolAllowlist"],
	capabilityDescriptor: ["id", "revision", "exposedToolName"],
	capabilityDecisionSummary: ["allowed", "awaitingApproval", "denied"],
	policySummary: [
		"bindingId",
		"profileId",
		"profileRevision",
		"projectTrust",
		"enforcement",
		"sandboxProviderId",
		"sandboxStatus",
		"sandboxCapabilities",
		"resource",
		"action",
		"outcome",
		"reasonCode",
		"requestId",
		"timestamp",
	],
	policyApproval: [
		"id",
		"requestId",
		"bindingId",
		"resource",
		"reasonCode",
		"createdAt",
		"outcome",
		"source",
		"scope",
	],
	policyApprovalScope: ["resource", "workspaceScopes", "environmentCount", "destinationCount", "credentialCount"],
	sandboxLifecycle: ["bindingId", "status", "timestamp", "providerId", "capabilities", "reasonCode"],
	policyViolation: ["bindingId", "timestamp", "reasonCode", "resource", "requestId"],
	taskGate: [
		"gateId",
		"taskId",
		"stageId",
		"stageRevision",
		"status",
		"action",
		"revision",
		"requestedAt",
		"decidedAt",
		"runId",
		"actorId",
		"reasonCode",
	],
} as const;

/** Keys that must never occur in an audit event or summary at any nesting level. */
export const AUDIT_FORBIDDEN_KEYS = [
	"data",
	"raw",
	"prompt",
	"message",
	"messages",
	"finalText",
	"command",
	"args",
	"cwd",
	"path",
	"targetPath",
	"content",
	"output",
	"url",
	"payload",
	"callback",
	"stdout",
	"stderr",
	"env",
	"environment",
	"headers",
	"token",
	"authorization",
	"credentials",
	"authorizationUrl",
	"providerPid",
	"tempPath",
	"sessionFile",
	"workspaceIdentity",
	"constraints",
	"bindingHash",
	"providerError",
	"stack",
	"instructions",
	"serverInstructions",
	"agentSelfReport",
	"details",
	"clientRequestId",
] as const;

export const AUDIT_NO_SIDE_EFFECT_OPERATIONS = [
	"run.start",
	"run.resume",
	"run.cancel",
	"AgentSession.prompt",
	"AgentSession.steer",
	"AgentSession.followUp",
	"tool execution",
	"Bash execution",
	"MCP connection or call",
	"Extension execution",
	"ModelBroker provider call or fallback",
	"Policy authorize/approve/reject",
	"SandboxProvider.prepare/execute/dispose",
	"SessionManager.appendCustomEntry",
	"Session switch or fork",
	"Context memory write",
	"TaskGateStore mutation (task.gate.request/approve/reject/cancel)",
] as const;

export interface AuditContractCase {
	readonly id: string;
	readonly expectedStatus?: AuditReplayStatus;
	readonly expectedWarning?: AuditWarningCode;
	readonly expectedError?: AuditErrorCode;
	readonly sideEffects: ReadonlyArray<never>;
}

export const AUDIT_CONTRACT_CASES = [
	{ id: "terminal-run-is-complete", expectedStatus: "complete", sideEffects: [] },
	{ id: "accepted-without-terminal-is-interrupted", expectedStatus: "interrupted", sideEffects: [] },
	{
		id: "malformed-source-is-incomplete",
		expectedStatus: "incomplete",
		expectedWarning: "malformed_source",
		sideEffects: [],
	},
	{ id: "unknown-source-is-warning-only-for-query", expectedWarning: "unknown_source", sideEffects: [] },
	{ id: "missing-run-is-an-error", expectedError: "audit_run_not_found", sideEffects: [] },
	{ id: "bad-cursor-is-an-error", expectedError: "audit_cursor_invalid", sideEffects: [] },
	{ id: "task-gate-events-are-safe-correlation-facts", sideEffects: [] },
	{ id: "task-gate-with-runid-is-non-terminal-correlation", sideEffects: [] },
	{ id: "task-gate-without-runid-is-not-guessed-into-a-run", sideEffects: [] },
	{ id: "malformed-task-gate-is-warning-only", expectedWarning: "malformed_source", sideEffects: [] },
	{ id: "session-mismatched-task-gate-is-orphan-warning", expectedWarning: "orphan_source", sideEffects: [] },
] as const satisfies ReadonlyArray<AuditContractCase>;
