/**
 * Read-only Execution Audit adapter for one Session.
 *
 * The adapter deliberately consumes the structural Session custom-entry
 * contract instead of RPC response types. It folds the existing append-only
 * ledgers into a small, allowlisted audit view and never writes to the
 * Session, invokes a provider, or performs an execution operation.
 */

import { createHmac, timingSafeEqual } from "node:crypto";
import {
	canonicalFoundationJson,
	cloneDeepFrozen,
	createDurableEvent,
	fingerprintFoundationValue,
	FoundationLedgerState,
	parseFoundationMutation,
	validateAttempt,
	validateAttemptReceipt,
	validateDurableEvent,
	validateRunReceipt,
	validateTaskEnvelope,
	validateTaskResult,
	type Attempt,
	type CanonicalRunResult,
	type DurableEventEnvelope,
	type ExecutionCorrelation,
	type FoundationRecord,
	type FoundationEventEnvelope,
	type RunReceipt as CanonicalRunReceipt,
	type TaskEnvelope,
} from "@aos-agent/agent-core";
import type { ContextSnapshot, ContextSourceReceipt } from "./context-engine.ts";
import { serializePublicRunBindingAssociation, type RunBindingAssociation } from "./binding-handles.ts";
import {
	isOpaqueCapabilityBindingId,
	isOpaqueCapabilityDescriptorId,
	isOpaqueCapabilityRevision,
} from "./run-lifecycle.ts";
import type { CapabilityBindingLedgerRecord } from "./run-lifecycle.ts";
import type {
	ModelAttemptLedgerRecord,
	ModelBindingLedgerRecord,
	ModelBudgetLimit,
	ModelReference,
	ModelUsage,
} from "./model-broker-ledger.ts";
import type {
	PolicyApprovalLedgerRecord,
	PolicyBindingLedgerRecord,
	PolicyDecisionLedgerRecord,
	PolicyViolationLedgerRecord,
	SandboxLifecycleLedgerRecord,
} from "./execution-policy-ledger.ts";
import type {
	PolicyAction,
	PolicyApprovalOutcome,
	PolicyApprovalSource,
	PolicyDecisionOutcome,
	PolicyEnforcement,
	PolicyErrorCode,
	PolicyResource,
	PolicyTrust,
	SandboxCapabilities,
	SandboxStatus,
	WorkspaceScope,
} from "./execution-policy.ts";
import type { SessionEntry } from "./session-manager.ts";
import {
	FOUNDATION_DURABLE_CUSTOM_TYPE,
	FOUNDATION_ENTRY_CUSTOM_TYPE,
	FOUNDATION_FACT_CUSTOM_TYPE,
	FOUNDATION_LANE_CUSTOM_TYPE,
	FOUNDATION_RECORD_CUSTOM_TYPE,
} from "./session-manager-storage.ts";
import {
	AutomationRunProjectionError,
	projectAutomationRuns,
	type AutomationRunErrorProjection,
	type AutomationRunProjection,
	type AutomationRunUsageProjection,
	type CanonicalAutomationRunProjection,
} from "./automation-run-projection.ts";
import {
	decodeLegacyAutomationRunLedgerEntryV1,
	reconcileLegacyAutomationRunLedger,
	type LegacyAutomationRunFinalModelReference,
	type LegacyAutomationRunLedgerEntry,
	type LegacyAutomationRunLedgerSourceEntry,
	type LegacyAutomationRunModelAttemptSummary,
	type LegacyAutomationRunModelBudgetSummary,
	type LegacyAutomationRunModelReference,
	type LegacyAutomationRunReceipt,
	type LegacyAutomationRunRecord,
} from "./migrations/automation-run-ledger.ts";
import {
	isLegalTaskCredentialTransition,
	TASK_CREDENTIAL_SCHEMA_VERSION,
	type TaskCredentialGrant,
	type TaskCredentialStatus,
} from "./task-credential-lease.ts";
import {
	canonicalTaskCredentialIssuePayload,
	canonicalTaskCredentialProjectPayload,
	canonicalTaskCredentialRenewPayload,
	canonicalTaskCredentialRevokePayload,
	canonicalTaskCredentialSettlePayload,
	parseTaskCredentialTransition,
	TASK_CREDENTIAL_CUSTOM_TYPE,
	type TaskCredentialPersistedAction,
	type TaskCredentialTransition,
} from "./task-credential-store.ts";
import { isRemoteOperationReceipt, type RemoteOperationReceipt } from "./remote-operation.ts";
import {
	isTaskGateTransition,
	taskGateCommandType,
	taskGateSchemaVersion,
	TASK_GATE_CUSTOM_TYPE,
	TASK_GATE_SCHEMA_VERSION,
	type TaskGateAction,
	type TaskGateRecord,
	type TaskGateTransition,
} from "./task-gate.ts";
import {
	canonicalTaskGraphAttachPayload,
	canonicalTaskGraphCreatePayload,
	canonicalTaskGraphSettlePayload,
	isTaskGraphTransition,
	serializeTaskGraphNode,
	taskGraphCommandType,
	taskGraphSchemaVersion,
	TASK_GRAPH_CUSTOM_TYPE,
	TASK_GRAPH_SCHEMA_VERSION,
	type TaskGraphAction,
	type TaskGraphNodeRecord,
	type TaskGraphNodeStatus,
	type TaskGraphTransition,
} from "./scheduler/task-graph.ts";
import {
	WORKER_FORBIDDEN_KEYS,
	workerTransitionAllowed,
	validateWorkerRecord,
	type WorkerLifecycleStatus,
	type WorkerRecord,
} from "./worker.ts";
import type { SafeSubagentLifecycleProjection } from "./subagent-composition.ts";
import {
	CHILD_LIFECYCLE_STATUSES,
	SUBAGENT_PROVIDER_KINDS,
	type ChildLifecycleStatus,
	type SubagentProviderKind,
} from "./subagent.ts";
import {
	SCHEDULER_DURABLE_EVENT_CATEGORIES,
	SCHEDULER_FORBIDDEN_PAYLOAD_KEYS,
	type SchedulerDurableEventCategory,
} from "./scheduler/host.ts";

export const AUDIT_SCHEMA_VERSION = 1 as const;
export const AUDIT_DEFAULT_LIMIT = 50 as const;
export const AUDIT_MAX_LIMIT = 200 as const;
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
	"remote.operation",
	"task.gate",
	"task.graph",
	"task.credential",
	"worker.lifecycle_transitioned",
	"worker.operation_recorded",
	"worker_receipt.written",
	...SCHEDULER_DURABLE_EVENT_CATEGORIES,
] as const;
export type AuditSourceCustomType = (typeof AUDIT_SOURCE_CUSTOM_TYPES)[number];
/**
 * Custom entries that are deliberately not audit sources: `context.memory`
 * contains explicit user text and `mcp.content.audit` is the allowlist-only
 * per-operation MCP trail (serverId/operation/outcome/descriptor digest/
 * revision/digest/bytes/blocks/mime/binding ids/timestamp) folded by no
 * Run fact — its entries stay inspectable as Session custom entries and
 * never surface unknown-source warnings or raw data in the audit.
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
	"remote.operation",
	"task.gate",
	"task.graph",
	"task.credential",
	"worker.lifecycle",
	"worker.operation",
	"worker.receipt",
	"scheduler.event",
] as const;
export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number];

export const AUDIT_QUERY_SCOPES = ["current-session", "session-directory"] as const;
export type AuditQueryScope = (typeof AUDIT_QUERY_SCOPES)[number];

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

export const AUDIT_CURSOR_SORT_KEYS = ["recordedAt", "sessionId", "sourceEntryId", "eventId"] as const;
export type AuditCursorSortKeyName = (typeof AUDIT_CURSOR_SORT_KEYS)[number];

/**
 * Keys that must never appear in a `task.credential` entry, event, or
 * summary at any level the fold accepts. Material, environment values,
 * headers, authorization, prompts, commands, paths, diffs, content,
 * streams, provider responses, and OAuth codes are rejected before the
 * serializer shape guard runs, so they can never become credential facts.
 */
export const TASK_CREDENTIAL_AUDIT_FORBIDDEN_KEYS = Object.freeze([
	"token",
	"secret",
	"credential",
	"material",
	"env",
	"headers",
	"authorization",
	"prompt",
	"command",
	"args",
	"cwd",
	"path",
	"diff",
	"content",
	"stdout",
	"stderr",
	"raw",
	"providerResponse",
	"providerError",
	"oauthCode",
] as const);

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

export type AuditRunEventStatus = "accepted" | "running" | "completed" | "failed" | "cancelled" | "interrupted";

export interface AuditRunTerminalErrorSummary {
	readonly code: string;
	readonly category?: AutomationRunErrorProjection["category"];
	readonly retryable?: boolean;
}

export interface AuditRunAttachmentSummary {
	readonly sourceId: string;
	readonly kind: "resource" | "prompt";
	readonly descriptorId?: string;
	readonly revision?: string;
	readonly capabilityBindingId?: string;
	readonly policyBindingId?: string;
	readonly contentDigest: string;
	readonly byteCount: number;
	readonly blockCount: number;
	readonly mimeTypes?: ReadonlyArray<string>;
}

export interface AuditRunSummary {
	readonly status: AuditRunEventStatus;
	/** Present only for a migrated historical Run projection. */
	readonly attempt?: number;
	/** Present only for a migrated historical Run projection. */
	readonly model?: AuditRunModelReference;
	readonly deadlineAt?: string;
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
	readonly terminalError?: AuditRunTerminalErrorSummary;
	readonly usage?: AutomationRunUsageProjection;
	readonly finalModel?: AuditRunFinalModelReference;
	readonly modelBudget?: AuditModelBudgetSummary;
	readonly bindingAssociation?: RunBindingAssociation;
	readonly attachments?: ReadonlyArray<AuditRunAttachmentSummary>;
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
		readonly exposedToolName?: string;
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
	readonly resource?: PolicyResource;
	readonly action?: PolicyAction;
	readonly outcome?: PolicyDecisionOutcome;
	readonly reasonCode?: PolicyErrorCode;
	readonly requestId?: string;
	readonly timestamp?: string;
}

export interface AuditPolicyApprovalSummary {
	readonly id: string;
	readonly requestId?: string;
	readonly bindingId: string;
	readonly resource: PolicyResource;
	readonly reasonCode: "policy_approval_required";
	readonly createdAt: string;
	readonly outcome?: "approved" | "rejected";
	readonly source?: "interactive" | "rpc" | "sdk" | "system";
	readonly scope: {
		readonly resource: PolicyResource;
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
	readonly reasonCode?: PolicyErrorCode;
}

export interface AuditPolicyViolationSummary {
	readonly bindingId: string;
	readonly timestamp: string;
	readonly reasonCode: string;
	readonly resource?: PolicyResource;
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

/**
 * Safe summary of one `task.graph` transition. Only validated opaque IDs,
 * the stable action/status, and short outcome codes may appear; task text,
 * tool payloads, paths, environment, credentials, and raw custom data never
 * enter the audit view. `created` carries no node fields because the
 * definition may hold many nodes; `nodeId`/`status`/`nodeRevision`/
 * `dependsOn`/`gateRef`/`runId`/`outcomeCode` are node-transition fields
 * and are omitted when absent. `recordedAt` lives on the event base, so it
 * is not repeated here.
 */
export interface AuditTaskGraphSummary {
	readonly taskId: string;
	readonly graphRevision: number;
	readonly nodeId?: string;
	readonly action: TaskGraphAction;
	readonly status?: TaskGraphNodeStatus;
	readonly nodeRevision?: number;
	readonly dependsOn?: ReadonlyArray<string>;
	readonly gateRef?: { readonly stageId: string; readonly stageRevision: number };
	readonly runId?: string;
	readonly outcomeCode?: string;
}

export type AuditRemoteOperationSummary = RemoteOperationReceipt;

/**
 * Safe summary of one `task.credential` transition. Only validated opaque
 * IDs, the stable action/status, the scope digest (never scope values), the
 * transition's recorded timestamp, and short outcome codes may appear;
 * credential material, tokens, environment values, headers, authorization,
 * prompts, commands, paths, diffs, content, streams, provider text, and raw
 * custom data never enter the audit view. The summary is built from the
 * persisted transition entry through the store's serializer guard
 * (`parseTaskCredentialTransition`), so the audit view always matches what
 * the store folds. `runId` is the grant's run correlation and is also
 * projected onto the event base, so replay correlates by runId only and the
 * fold never calls the provider or changes a Run's terminal state.
 */
export interface AuditTaskCredentialSummary {
	readonly action: TaskCredentialPersistedAction;
	readonly grantId: string;
	readonly leaseId: string;
	readonly bindingId: string;
	readonly sessionId: string;
	readonly taskId: string;
	readonly graphRevision: number;
	readonly nodeId: string;
	readonly stageId?: string;
	readonly stageRevision?: number;
	readonly runId: string;
	readonly targetId?: string;
	readonly scopeDigest: string;
	readonly scopeCount: number;
	readonly status: TaskCredentialStatus;
	readonly recordedAt: string;
	readonly reasonCode?: string;
}

/** Safe projection of one persisted Operation Worker lifecycle record. */
export interface AuditWorkerLifecycleSummary {
	readonly workerId: string;
	readonly providerId: string;
	readonly sessionId: string;
	readonly laneId: string;
	readonly runId?: string;
	readonly bindingId?: string;
	readonly bindingEpochId?: string;
	readonly attemptId?: string;
	readonly profileId: string;
	readonly status: WorkerLifecycleStatus;
	readonly revision: number;
	readonly createdAt: string;
	readonly readyAt?: string;
	readonly endedAt?: string;
	readonly lastHeartbeatAt?: string;
	readonly activeOperationId?: string;
	readonly receiptId?: string;
	readonly operationId?: string;
}

/** Safe projection of an operation fence or terminal operation fact. */
export interface AuditWorkerOperationSummary {
	readonly workerId: string;
	readonly providerId: string;
	readonly sessionId: string;
	readonly laneId: string;
	readonly operationId: string;
	readonly phase: "claimed" | "started" | "terminal";
	readonly revision: number;
	readonly sideEffectState?: "none" | "unknown" | "side_effect_unknown";
	readonly receiptId?: string;
}

/** Safe projection of the receipt-written marker (the receipt body is never persisted here). */
export interface AuditWorkerReceiptSummary {
	readonly workerId: string;
	readonly workerReceiptId: string;
	readonly operationId: string;
	readonly taskId?: string;
	readonly terminalRecordRevision: number;
}

/** Public-safe metadata projection of one validated scheduler durable event. */
export interface AuditSchedulerSummary {
	readonly category: SchedulerDurableEventCategory;
	readonly eventId: string;
	readonly streamId: string;
	readonly sequence: number;
	readonly safeSummary: string;
	readonly payloadDigest: ReturnType<typeof fingerprintFoundationValue>;
	readonly correlation: Readonly<Record<string, string>>;
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
	| (AuditEventBase & {
			readonly type: "remote.operation";
			readonly runId?: string;
			readonly summary: AuditRemoteOperationSummary;
	  })
	| (AuditEventBase & {
			readonly type: "task.gate";
			readonly runId?: string;
			readonly summary: AuditTaskGateSummary;
	  })
	| (AuditEventBase & {
			readonly type: "task.graph";
			readonly runId?: string;
			readonly summary: AuditTaskGraphSummary;
	  })
	| (AuditEventBase & {
			readonly type: "task.credential";
			readonly runId?: string;
			readonly summary: AuditTaskCredentialSummary;
	  })
	| (AuditEventBase & {
			readonly type: "worker.lifecycle";
			readonly runId?: string;
			readonly summary: AuditWorkerLifecycleSummary;
	  })
	| (AuditEventBase & {
			readonly type: "worker.operation";
			readonly runId?: string;
			readonly summary: AuditWorkerOperationSummary;
	  })
	| (AuditEventBase & {
			readonly type: "worker.receipt";
			readonly runId?: string;
			readonly summary: AuditWorkerReceiptSummary;
	  })
	| (AuditEventBase & {
			readonly type: "scheduler.event";
			readonly runId?: string;
			readonly summary: AuditSchedulerSummary;
	  });

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
	readonly from?: string;
	readonly to?: string;
	readonly cursor?: string;
	readonly limit?: number;
}

export interface AuditReplayQuery {
	readonly runId: string;
	readonly sessionId?: string;
	readonly types?: ReadonlyArray<AuditEventType>;
	readonly from?: string;
	readonly to?: string;
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

export type AuditReplayStatus = "complete" | "interrupted" | "incomplete";

export interface AuditReplayResult {
	readonly schemaVersion: 1;
	readonly run: AuditRunSummary;
	readonly events: ReadonlyArray<AuditEvent>;
	readonly nextCursor?: string;
	readonly status: AuditReplayStatus;
	readonly warnings: ReadonlyArray<AuditWarning>;
}

export interface AuditSortKey {
	readonly recordedAt: string;
	readonly sessionId: string;
	readonly sourceEntryId: string;
	readonly eventId: string;
}

export interface AuditCursorPayload {
	readonly queryFingerprint: string;
	readonly last: AuditSortKey;
}

export type AuditCursorSecret = string | Uint8Array;

export interface AuditSession {
	getSessionId(): string;
	getEntries(): ReadonlyArray<SessionEntry>;
	/** Physical entries expose canonical Foundation records hidden by compatibility projections. */
	getPhysicalEntries?(): ReadonlyArray<SessionEntry>;
}

export interface AuditSessionInput {
	readonly sessionId: string;
	readonly entries: ReadonlyArray<SessionEntry>;
}

export interface AuditFoldResult {
	readonly events: ReadonlyArray<AuditEvent>;
	readonly warnings: ReadonlyArray<AuditWarning>;
	readonly runSummaries: ReadonlyMap<string, AuditRunSummary>;
}

export interface ExecutionAuditAdapterOptions {
	readonly cursorSecret?: AuditCursorSecret;
}

/** Error carrying one of the stable control-plane error codes. */
export class ExecutionAuditError extends Error {
	readonly code: AuditErrorCode;

	constructor(code: AuditErrorCode) {
		super(code);
		this.name = "ExecutionAuditError";
		this.code = code;
	}
}

const DEFAULT_CURSOR_SECRET = "aos-agent-execution-audit-v1";
type DeepMutable<T> = T extends object ? { -readonly [Key in keyof T]: DeepMutable<T[Key]> } : T;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SAFE_TEXT_PATTERN = /^[^\u0000-\u001f\u007f\r\n]{1,512}$/;
const SAFE_SUMMARY_PATTERN = /^[^/\\]{1,512}$/;
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const POLICY_RESOURCES = new Set<PolicyResource>([
	"capability.invoke",
	"filesystem.read",
	"filesystem.write",
	"filesystem.find",
	"filesystem.grep",
	"process.spawn",
	"network.connect",
	"credential.expose",
	"sandbox.prepare",
	"mcp.auth",
	"resource.list",
	"resource.read",
	"prompt.list",
	"prompt.get",
	"context.attach",
]);
const POLICY_ERROR_CODES = new Set<PolicyErrorCode>([
	"policy_settings_invalid",
	"policy_profile_not_found",
	"policy_profile_untrusted",
	"policy_binding_failed",
	"policy_approval_required",
	"policy_denied",
	"policy_violation",
	"workspace_boundary_violation",
	"network_policy_violation",
	"credential_policy_violation",
	"sandbox_required",
	"sandbox_unavailable",
	"sandbox_start_failed",
	"sandbox_capability_insufficient",
	"policy_ledger_persistence_failed",
]);
const WORKSPACE_SCOPES = new Set<WorkspaceScope>([
	"workspace",
	"declared-read-only",
	"temporary",
	"credentials",
	"agent-internal",
]);
const SANDBOX_STATUSES = new Set<SandboxStatus>([
	"not_required",
	"unavailable",
	"preparing",
	"ready",
	"failed",
	"disposed",
]);
const CONTEXT_PURPOSES = new Set(["agent_turn", "compaction", "branch_summary"]);
const CONTEXT_KINDS = new Set([
	"system",
	"instruction",
	"capability_index",
	"session_summary",
	"session_message",
	"memory",
	"extension",
	"attachment",
]);
const CONTEXT_SCOPES = new Set(["global", "project", "directory", "session", "turn"]);
const CONTEXT_TRUSTS = new Set([
	"builtin",
	"user_owned",
	"trusted_project",
	"untrusted_project",
	"untrusted_child_output",
]);
const CONTEXT_DISPOSITIONS = new Set(["included", "trimmed", "excluded"]);
const CONTEXT_REASONS = new Set([
	"within_budget",
	"budget_exhausted",
	"untrusted",
	"disabled",
	"revoked",
	"snapshot_only",
]);
const WORKER_LIFECYCLE_CUSTOM_TYPE = "worker.lifecycle_transitioned";
const WORKER_OPERATION_CUSTOM_TYPE = "worker.operation_recorded";
const WORKER_RECEIPT_CUSTOM_TYPE = "worker_receipt.written";
const WORKER_AUDIT_FORBIDDEN_KEYS = new Set<string>([
	...WORKER_FORBIDDEN_KEYS,
	"environment",
	"executablePath",
	"command",
	"args",
	"secret",
	"token",
	"header",
	"headers",
	"authorization",
	"prompt",
	"message",
	"content",
	"output",
	"raw",
	"stack",
	"error",
	"details",
]);
export const SUBAGENT_AUDIT_FORBIDDEN_KEYS = Object.freeze([
	"pid",
	"executable",
	"argv",
	"cwd",
	"env",
	"environment",
	"transcript",
	"prompt",
	"token",
	"secret",
	"header",
	"headers",
	"providerStack",
	"provider_stack",
	"rawFrame",
	"raw_frame",
	"body",
	"message",
	"content",
	"output",
	"stack",
]);
const SUBAGENT_AUDIT_KEYS = new Set([
	"schemaVersion",
	"source",
	"sessionId",
	"runId",
	"childAgentInstanceId",
	"parentAgentInstanceId",
	"taskId",
	"status",
	"providerKind",
	"safeSummary",
	"correlation",
	"digest",
]);
const SUBAGENT_AUDIT_CORRELATION_KEYS = new Set(["attemptId", "spawnId"]);
const SUBAGENT_AUDIT_DIGEST_KEYS = new Set(["algorithm", "value"]);
export const SCHEDULER_AUDIT_FORBIDDEN_KEYS = Object.freeze([
	...SCHEDULER_FORBIDDEN_PAYLOAD_KEYS,
	"environment",
	"executable",
	"argv",
	"cwd",
	"secret",
	"token",
	"authorization",
	"header",
	"headers",
	"prompt",
	"message",
	"content",
	"output",
	"raw",
	"stack",
	"error",
	"details",
]);
const SCHEDULER_AUDIT_FORBIDDEN_KEY_SET = new Set<string>(SCHEDULER_AUDIT_FORBIDDEN_KEYS);
const WORKER_ENVELOPE_KEYS = new Set([
	"schemaVersion",
	"class",
	"category",
	"eventId",
	"streamId",
	"sequence",
	"timestamp",
	"correlation",
	"payload",
]);
const WORKER_LIFECYCLE_PAYLOAD_KEYS = new Set([
	"schemaVersion",
	"workerId",
	"providerId",
	"sessionId",
	"laneId",
	"status",
	"revision",
	"runId",
	"bindingId",
	"bindingEpochId",
	"attemptId",
	"profileId",
	"createdAt",
	"readyAt",
	"endedAt",
	"lastHeartbeatAt",
	"activeOperationId",
	"operationId",
	"receiptId",
]);
const WORKER_OPERATION_PAYLOAD_KEYS = new Set([
	"schemaVersion",
	"workerId",
	"providerId",
	"sessionId",
	"laneId",
	"operationId",
	"phase",
	"revision",
	"sideEffectState",
	"receiptId",
	"recordedAt",
]);
const WORKER_RECEIPT_PAYLOAD_KEYS = new Set(["schemaVersion", "workerReceiptId", "operationId", "taskId"]);
const WORKER_LIFECYCLE_CORRELATION_KEYS = new Set([
	"sessionId",
	"laneId",
	"workerId",
	"runId",
	"bindingId",
	"bindingEpochId",
	"attemptId",
	"operationId",
	"receiptId",
]);
const WORKER_OPERATION_CORRELATION_KEYS = new Set(["sessionId", "laneId", "workerId", "operationId", "receiptId"]);
const WORKER_RECEIPT_CORRELATION_KEYS = new Set(["sessionId", "operationId", "workerReceiptId", "taskId"]);
const AUDIT_QUERY_KEYS = new Set(["scope", "sessionId", "runId", "types", "from", "to", "cursor", "limit"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
	return Object.keys(value).every((key) => allowed.has(key));
}

function hasForbiddenWorkerValue(value: unknown, seen = new WeakSet<object>()): boolean {
	if (value === null || typeof value !== "object") return false;
	if (seen.has(value)) return true;
	seen.add(value);
	if (Array.isArray(value)) return value.some((item) => hasForbiddenWorkerValue(item, seen));
	for (const [key, item] of Object.entries(value)) {
		if (WORKER_AUDIT_FORBIDDEN_KEYS.has(key) || hasForbiddenWorkerValue(item, seen)) return true;
	}
	return false;
}

export function projectSubagentAuditSource(value: unknown): SafeSubagentLifecycleProjection | undefined {
	if (
		!isRecord(value) ||
		!hasOnlyKeys(value, SUBAGENT_AUDIT_KEYS) ||
		Object.keys(value).length !== SUBAGENT_AUDIT_KEYS.size
	)
		return undefined;
	const forbidden = new Set<string>(SUBAGENT_AUDIT_FORBIDDEN_KEYS);
	const containsForbidden = (candidate: unknown): boolean => {
		if (candidate === null || typeof candidate !== "object") return false;
		if (Array.isArray(candidate)) return candidate.some(containsForbidden);
		return Object.entries(candidate).some(([key, child]) => forbidden.has(key) || containsForbidden(child));
	};
	if (
		containsForbidden(value) ||
		value.schemaVersion !== 1 ||
		value.source !== "subagent.lifecycle" ||
		!isSafeIdentifier(value.sessionId) ||
		!isSafeIdentifier(value.runId) ||
		!isSafeIdentifier(value.childAgentInstanceId) ||
		!isSafeIdentifier(value.parentAgentInstanceId) ||
		!isSafeIdentifier(value.taskId) ||
		!isSafeText(value.safeSummary) ||
		!CHILD_LIFECYCLE_STATUSES.includes(value.status as ChildLifecycleStatus) ||
		!SUBAGENT_PROVIDER_KINDS.includes(value.providerKind as SubagentProviderKind) ||
		!isRecord(value.correlation) ||
		!hasOnlyKeys(value.correlation, SUBAGENT_AUDIT_CORRELATION_KEYS) ||
		Object.keys(value.correlation).length !== SUBAGENT_AUDIT_CORRELATION_KEYS.size ||
		!isSafeIdentifier(value.correlation.attemptId) ||
		!isSafeIdentifier(value.correlation.spawnId) ||
		!isRecord(value.digest) ||
		!hasOnlyKeys(value.digest, SUBAGENT_AUDIT_DIGEST_KEYS) ||
		Object.keys(value.digest).length !== SUBAGENT_AUDIT_DIGEST_KEYS.size ||
		value.digest.algorithm !== "sha256" ||
		typeof value.digest.value !== "string" ||
		!/^[0-9a-f]{64}$/.test(value.digest.value)
	)
		return undefined;
	const { digest, ...base } = value;
	const expected = fingerprintFoundationValue(base);
	if (digest.algorithm !== expected.algorithm || digest.value !== expected.value) return undefined;
	return cloneDeepFrozen(value) as unknown as SafeSubagentLifecycleProjection;
}

/** Replay projection is deliberately read-only and has no spawn/cancel/resume surface. */
export function replaySubagentAuditSource(value: unknown): SafeSubagentLifecycleProjection | undefined {
	return projectSubagentAuditSource(value);
}

export function hasForbiddenSchedulerAuditValue(value: unknown, seen = new WeakSet<object>()): boolean {
	if (value === null || typeof value !== "object") return false;
	if (seen.has(value)) return true;
	seen.add(value);
	if (Array.isArray(value)) return value.some((item) => hasForbiddenSchedulerAuditValue(item, seen));
	return Object.entries(value).some(
		([key, item]) => SCHEDULER_AUDIT_FORBIDDEN_KEY_SET.has(key) || hasForbiddenSchedulerAuditValue(item, seen),
	);
}

function workerString(value: unknown): value is string {
	return isSafeIdentifier(value);
}

function isSafeIdentifier(value: unknown): value is string {
	return (
		typeof value === "string" &&
		SAFE_IDENTIFIER_PATTERN.test(value) &&
		!value.includes("/") &&
		!value.includes("\\") &&
		!value.includes("?") &&
		!value.includes("#") &&
		!value.includes("@") &&
		!value.includes("://")
	);
}

function isSafeText(value: unknown): value is string {
	return typeof value === "string" && SAFE_TEXT_PATTERN.test(value) && !value.includes("://") && !value.includes("@");
}

function isSafeModelText(value: unknown): value is string {
	return typeof value === "string" && SAFE_TEXT_PATTERN.test(value) && !value.includes("://") && !value.includes("@");
}

function isSafeSummary(value: unknown): value is string {
	return (
		typeof value === "string" &&
		SAFE_TEXT_PATTERN.test(value) &&
		SAFE_SUMMARY_PATTERN.test(value) &&
		!value.includes("://")
	);
}

function isCanonicalTimestamp(value: unknown): value is string {
	if (typeof value !== "string" || !TIMESTAMP_PATTERN.test(value)) return false;
	const date = new Date(value);
	return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

function isFiniteNonNegative(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isCount(value: unknown): value is number {
	return isFiniteNonNegative(value) && Number.isInteger(value);
}

function isThinkingLevel(value: unknown): value is string {
	return typeof value === "string" && THINKING_LEVELS.has(value);
}

function isPolicyAction(value: unknown): value is PolicyAction {
	return value === "allow" || value === "ask" || value === "deny";
}

function isPolicyEnforcement(value: unknown): value is PolicyEnforcement {
	return value === "legacy" || value === "host" || value === "sandbox";
}

function isPolicyTrust(value: unknown): value is PolicyTrust {
	return value === "trusted" || value === "untrusted";
}

function isPolicyResource(value: unknown): value is PolicyResource {
	return typeof value === "string" && POLICY_RESOURCES.has(value as PolicyResource);
}

function isPolicyOutcome(value: unknown): value is PolicyDecisionOutcome {
	return isPolicyAction(value) || value === "sandbox_required";
}

function isSandboxStatus(value: unknown): value is SandboxStatus {
	return typeof value === "string" && SANDBOX_STATUSES.has(value as SandboxStatus);
}

function isPolicyErrorCode(value: unknown): value is PolicyErrorCode {
	return typeof value === "string" && POLICY_ERROR_CODES.has(value as PolicyErrorCode);
}

function isWorkspaceScope(value: unknown): value is WorkspaceScope {
	return typeof value === "string" && WORKSPACE_SCOPES.has(value as WorkspaceScope);
}

function isSandboxCapabilities(value: unknown): value is SandboxCapabilities {
	if (!isRecord(value)) return false;
	return (
		typeof value.filesystem === "boolean" &&
		typeof value.process === "boolean" &&
		typeof value.network === "boolean" &&
		typeof value.credentialIsolation === "boolean"
	);
}

function isModelReference(value: unknown): value is ModelReference {
	if (!isRecord(value) || !isSafeModelText(value.provider) || !isSafeModelText(value.modelId)) return false;
	return value.thinkingLevel === undefined || isThinkingLevel(value.thinkingLevel);
}

function isModelCandidate(value: unknown): boolean {
	if (!isRecord(value) || !isCount(value.order)) return false;
	return isModelReference(value.model);
}

function isModelBudgetLimit(value: unknown): value is ModelBudgetLimit {
	if (!isRecord(value)) return false;
	for (const key of ["maxModelCalls", "maxInputTokens", "maxOutputTokens", "maxTotalTokens", "maxCostUsd"] as const) {
		if (value[key] !== undefined && !isFiniteNonNegative(value[key])) return false;
	}
	return true;
}

function isModelUsage(value: unknown): value is ModelUsage {
	if (!isRecord(value)) return false;
	let hasValue = false;
	for (const key of [
		"inputTokens",
		"outputTokens",
		"totalTokens",
		"costUsd",
		"input",
		"output",
		"total",
		"cost",
	] as const) {
		if (value[key] !== undefined) {
			if (!isFiniteNonNegative(value[key])) return false;
			hasValue = true;
		}
	}
	return hasValue;
}

function isModelBindingRecord(value: unknown): value is ModelBindingLedgerRecord {
	if (!isRecord(value) || !isSafeIdentifier(value.bindingId)) return false;
	if (value.mode !== "manual" && value.mode !== "route" && value.mode !== "direct") return false;
	if (value.routeId !== undefined && !isSafeIdentifier(value.routeId)) return false;
	if (value.role !== undefined && !isSafeIdentifier(value.role)) return false;
	if (
		!Array.isArray(value.candidates) ||
		value.candidates.length === 0 ||
		value.candidates.some((candidate) => !isModelCandidate(candidate))
	) {
		return false;
	}
	const orders = new Set<number>();
	for (const candidate of value.candidates) {
		if (!isRecord(candidate) || orders.has(candidate.order as number)) return false;
		orders.add(candidate.order as number);
	}
	if (value.mode !== "route" && value.candidates.length !== 1) return false;
	if (!isRecord(value.fallback) || !isCount(value.fallback.maxAttempts) || value.fallback.maxAttempts < 1)
		return false;
	if (
		!Array.isArray(value.fallback.on) ||
		value.fallback.on.some((item) => item !== "provider_unavailable" && item !== "transient_provider_error")
	) {
		return false;
	}
	if (
		!isModelBudgetLimit(value.budget) ||
		!isSafeIdentifier(value.configRevision) ||
		!isCanonicalTimestamp(value.createdAt)
	)
		return false;
	return value.previousModelBindingId === undefined || isSafeIdentifier(value.previousModelBindingId);
}

function isModelAttemptRecord(value: unknown): value is ModelAttemptLedgerRecord {
	if (!isRecord(value)) return false;
	if (!isSafeIdentifier(value.attemptId) || !isSafeIdentifier(value.bindingId) || !isCount(value.order)) return false;
	if (
		value.status !== "started" &&
		value.status !== "completed" &&
		value.status !== "failed" &&
		value.status !== "cancelled"
	)
		return false;
	if (!isModelReference(value.candidate) || !isCanonicalTimestamp(value.startedAt)) return false;
	if (value.endedAt !== undefined && !isCanonicalTimestamp(value.endedAt)) return false;
	if (value.failureCategory !== undefined && !isSafeIdentifier(value.failureCategory)) return false;
	if (value.usage !== undefined && !isModelUsage(value.usage)) return false;
	if (value.visibleOutput !== undefined && typeof value.visibleOutput !== "boolean") return false;
	if (value.contextSnapshotId !== undefined && !isSafeIdentifier(value.contextSnapshotId)) return false;
	return value.summary === undefined || isSafeText(value.summary);
}

function isContextSourceReceipt(value: unknown): value is ContextSourceReceipt {
	if (!isRecord(value)) return false;
	if (
		typeof value.sourceId !== "string" ||
		typeof value.kind !== "string" ||
		typeof value.scope !== "string" ||
		typeof value.trust !== "string" ||
		!CONTEXT_KINDS.has(value.kind) ||
		!CONTEXT_SCOPES.has(value.scope) ||
		!CONTEXT_TRUSTS.has(value.trust) ||
		!CONTEXT_DISPOSITIONS.has(value.disposition as string)
	)
		return false;
	if (value.label !== undefined && !isSafeText(value.label)) return false;
	if (
		value.visibility !== undefined &&
		value.visibility !== "snapshot_only" &&
		value.visibility !== "model_and_snapshot"
	)
		return false;
	if (!isSafeText(value.contentDigest) || !isCount(value.estimatedTokens)) return false;
	if (value.reason !== undefined && (typeof value.reason !== "string" || !CONTEXT_REASONS.has(value.reason)))
		return false;
	if (value.byteCount !== undefined && !isCount(value.byteCount)) return false;
	if (value.blockCount !== undefined && !isCount(value.blockCount)) return false;
	if (value.mimeTypes !== undefined) {
		if (!Array.isArray(value.mimeTypes) || value.mimeTypes.length > 16) return false;
		if (value.mimeTypes.some((mimeType) => !isSafeText(mimeType))) return false;
	}
	return true;
}

function isContextSnapshot(value: unknown): value is ContextSnapshot {
	if (!isRecord(value) || value.schemaVersion !== AUDIT_SCHEMA_VERSION) return false;
	if (
		!isSafeIdentifier(value.id) ||
		typeof value.purpose !== "string" ||
		!CONTEXT_PURPOSES.has(value.purpose) ||
		!isSafeIdentifier(value.sessionId) ||
		!isCanonicalTimestamp(value.createdAt)
	)
		return false;
	if (value.runId !== undefined && !isSafeIdentifier(value.runId)) return false;
	if (value.parentSnapshotId !== undefined && !isSafeIdentifier(value.parentSnapshotId)) return false;
	if (!Array.isArray(value.sources) || value.sources.some((source) => !isContextSourceReceipt(source))) return false;
	if (!isRecord(value.budget)) return false;
	return (
		isCount(value.budget.contextWindow) &&
		isCount(value.budget.reserveTokens) &&
		isCount(value.budget.inputLimit) &&
		isCount(value.budget.estimatedInputTokens)
	);
}

function isCapabilityBindingRecord(value: unknown): value is CapabilityBindingLedgerRecord {
	if (
		!isRecord(value) ||
		!isSafeText(value.id) ||
		!isSafeIdentifier(value.profile) ||
		!isCanonicalTimestamp(value.createdAt)
	)
		return false;
	if (!Array.isArray(value.descriptors)) return false;
	for (const descriptor of value.descriptors) {
		if (!isRecord(descriptor) || typeof descriptor.id !== "string" || typeof descriptor.revision !== "string")
			return false;
		if (descriptor.exposedToolName !== undefined && !isSafeIdentifier(descriptor.exposedToolName)) return false;
	}
	if (!isRecord(value.decisionSummary)) return false;
	if (
		!isCount(value.decisionSummary.allowed) ||
		!isCount(value.decisionSummary.awaitingApproval) ||
		!isCount(value.decisionSummary.denied)
	)
		return false;
	return Array.isArray(value.toolAllowlist) && value.toolAllowlist.every((tool) => isSafeIdentifier(tool));
}

function isPolicyBindingRecord(value: unknown): value is PolicyBindingLedgerRecord {
	if (!isRecord(value) || value.schemaVersion !== AUDIT_SCHEMA_VERSION) return false;
	if (
		!isSafeIdentifier(value.id) ||
		!isSafeIdentifier(value.profileId) ||
		!isSafeIdentifier(value.profileRevision) ||
		!isPolicyTrust(value.projectTrust) ||
		!isPolicyEnforcement(value.enforcement) ||
		!isSandboxStatus(value.sandboxStatus) ||
		!isSandboxCapabilities(value.sandboxCapabilities) ||
		!isSafeIdentifier(value.runId) ||
		!isCanonicalTimestamp(value.createdAt) ||
		typeof value.workspaceIdentity !== "string" ||
		!isRecord(value.constraints) ||
		typeof value.bindingHash !== "string"
	) {
		return false;
	}
	if (value.capabilityBindingId !== undefined && !isSafeIdentifier(value.capabilityBindingId)) return false;
	if (value.sandboxProviderId !== undefined && !isSafeIdentifier(value.sandboxProviderId)) return false;
	if (value.previousPolicyBindingId !== undefined && !isSafeIdentifier(value.previousPolicyBindingId)) return false;
	const constraints = value.constraints;
	if (
		!isRecord(constraints.workspace) ||
		!isRecord(constraints.process) ||
		!isRecord(constraints.network) ||
		!isRecord(constraints.credentials)
	)
		return false;
	for (const key of ["read", "write", "deny"] as const) {
		if (
			!Array.isArray(constraints.workspace[key]) ||
			constraints.workspace[key].some((scope) => !isWorkspaceScope(scope))
		)
			return false;
	}
	if (
		!isPolicyAction(constraints.process.action) ||
		typeof constraints.process.inheritEnvironment !== "boolean" ||
		!isCount(constraints.process.allowedEnvironmentCount)
	)
		return false;
	if (
		constraints.process.cwdScopes !== undefined &&
		(!Array.isArray(constraints.process.cwdScopes) ||
			constraints.process.cwdScopes.some((scope) => !isWorkspaceScope(scope)))
	)
		return false;
	if (!isPolicyAction(constraints.network.action) || !isCount(constraints.network.allowedDestinationCount))
		return false;
	if (!isPolicyAction(constraints.credentials.action) || !isCount(constraints.credentials.allowedNameCount))
		return false;
	return true;
}

function isPolicyDecisionRecord(value: unknown): value is PolicyDecisionLedgerRecord {
	if (!isRecord(value)) return false;
	return (
		isSafeIdentifier(value.bindingId) &&
		isSafeIdentifier(value.profileId) &&
		isSafeIdentifier(value.profileRevision) &&
		isPolicyTrust(value.projectTrust) &&
		isPolicyEnforcement(value.enforcement) &&
		isPolicyResource(value.resource) &&
		isPolicyAction(value.action) &&
		isPolicyOutcome(value.outcome) &&
		(value.reasonCode === undefined || isPolicyErrorCode(value.reasonCode)) &&
		(value.requestId === undefined || isSafeIdentifier(value.requestId)) &&
		isCanonicalTimestamp(value.timestamp)
	);
}

function isPolicyApprovalRecord(value: unknown): value is PolicyApprovalLedgerRecord {
	if (
		!isRecord(value) ||
		!isSafeIdentifier(value.id) ||
		!isSafeIdentifier(value.bindingId) ||
		!isPolicyResource(value.resource)
	)
		return false;
	if (value.requestId !== undefined && !isSafeIdentifier(value.requestId)) return false;
	if (value.reasonCode !== "policy_approval_required" || !isCanonicalTimestamp(value.createdAt)) return false;
	if (value.outcome !== undefined && value.outcome !== "approved" && value.outcome !== "rejected") return false;
	if (
		value.source !== undefined &&
		value.source !== "interactive" &&
		value.source !== "rpc" &&
		value.source !== "sdk" &&
		value.source !== "system"
	)
		return false;
	if (!isRecord(value.scope) || !isPolicyResource(value.scope.resource)) return false;
	if (
		value.scope.workspaceScopes !== undefined &&
		(!Array.isArray(value.scope.workspaceScopes) ||
			value.scope.workspaceScopes.some((scope) => !isWorkspaceScope(scope)))
	)
		return false;
	for (const key of ["environmentCount", "destinationCount", "credentialCount"] as const) {
		if (value.scope[key] !== undefined && !isCount(value.scope[key])) return false;
	}
	return true;
}

function isSandboxLifecycleRecord(value: unknown): value is SandboxLifecycleLedgerRecord {
	if (
		!isRecord(value) ||
		!isSafeIdentifier(value.bindingId) ||
		!isSandboxStatus(value.status) ||
		!isCanonicalTimestamp(value.timestamp)
	)
		return false;
	if (value.providerId !== undefined && !isSafeIdentifier(value.providerId)) return false;
	if (value.capabilities !== undefined && !isSandboxCapabilities(value.capabilities)) return false;
	return value.reasonCode === undefined || isPolicyErrorCode(value.reasonCode);
}

function isPolicyViolationRecord(value: unknown): value is PolicyViolationLedgerRecord {
	if (
		!isRecord(value) ||
		!isSafeIdentifier(value.bindingId) ||
		!isCanonicalTimestamp(value.timestamp) ||
		!isPolicyErrorCode(value.reasonCode)
	)
		return false;
	if (value.resource !== undefined && !isPolicyResource(value.resource)) return false;
	return value.requestId === undefined || isSafeIdentifier(value.requestId);
}

/** Explicit guard for a `model.binding` source record. */
export function isModelBindingAuditRecord(value: unknown): value is ModelBindingLedgerRecord {
	return isModelBindingRecord(value);
}

/** Explicit guard for a `model.attempt` source record. */
export function isModelAttemptAuditRecord(value: unknown): value is ModelAttemptLedgerRecord {
	return isModelAttemptRecord(value);
}

/** Explicit guard for a metadata-only `context.snapshot` source record. */
export function isContextSnapshotAuditRecord(value: unknown): value is ContextSnapshot {
	return isContextSnapshot(value);
}

/** Explicit guard for a `capability.binding` source record. */
export function isCapabilityBindingAuditRecord(value: unknown): value is CapabilityBindingLedgerRecord {
	return isCapabilityBindingRecord(value);
}

/** Explicit guards for the five execution-policy source records. */
export function isPolicyBindingAuditRecord(value: unknown): value is PolicyBindingLedgerRecord {
	return isPolicyBindingRecord(value);
}

export function isPolicyDecisionAuditRecord(value: unknown): value is PolicyDecisionLedgerRecord {
	return isPolicyDecisionRecord(value);
}

export function isPolicyApprovalAuditRecord(value: unknown): value is PolicyApprovalLedgerRecord {
	return isPolicyApprovalRecord(value);
}

export function isSandboxLifecycleAuditRecord(value: unknown): value is SandboxLifecycleLedgerRecord {
	return isSandboxLifecycleRecord(value);
}

export function isPolicyViolationAuditRecord(value: unknown): value is PolicyViolationLedgerRecord {
	return isPolicyViolationRecord(value);
}

function schemaVersion(value: unknown): number | undefined {
	return isRecord(value) && typeof value.schemaVersion === "number" ? value.schemaVersion : undefined;
}

function safeOptionalIdentifier(value: unknown): string | undefined {
	return isSafeIdentifier(value) ? value : undefined;
}

function safeOptionalOpaqueBindingId(value: unknown): string | undefined {
	return isOpaqueCapabilityBindingId(value) ? value : undefined;
}

function safeModelReference(value: ModelReference): AuditModelReference {
	const model = { provider: value.provider, modelId: value.modelId } as DeepMutable<AuditModelReference>;
	if (value.thinkingLevel !== undefined) model.thinkingLevel = value.thinkingLevel;
	return model;
}

function safeRunModelReference(value: LegacyAutomationRunModelReference): AuditRunModelReference {
	return { provider: value.provider, id: value.id, thinkingLevel: value.thinkingLevel };
}

function safeFinalModelReference(value: LegacyAutomationRunFinalModelReference): AuditRunFinalModelReference {
	const model = { provider: value.provider } as DeepMutable<AuditRunFinalModelReference>;
	if (value.id !== undefined) model.id = value.id;
	if (value.modelId !== undefined) model.modelId = value.modelId;
	if (value.thinkingLevel !== undefined) model.thinkingLevel = value.thinkingLevel;
	return model;
}

function safeUsage(value: ModelUsage | LegacyAutomationRunModelAttemptSummary["usage"]): AuditModelUsageSummary {
	const usage = {} as DeepMutable<AuditModelUsageSummary>;
	for (const key of [
		"inputTokens",
		"outputTokens",
		"totalTokens",
		"costUsd",
		"input",
		"output",
		"total",
		"cost",
	] as const) {
		const candidate = (value as unknown as Record<string, unknown>)[key];
		if (candidate !== undefined && isFiniteNonNegative(candidate)) usage[key] = candidate;
	}
	return usage;
}

function safeAttempt(
	value: ModelAttemptLedgerRecord | LegacyAutomationRunModelAttemptSummary,
): AuditModelAttemptSummary | undefined {
	const candidate = value.candidate;
	const model: AuditModelReference =
		"modelId" in candidate
			? safeModelReference(candidate as ModelReference)
			: { provider: candidate.provider, modelId: candidate.id ?? candidate.modelId ?? "" };
	if (model.modelId === "") return undefined;
	const attempt = {
		attemptId: value.attemptId,
		bindingId: value.bindingId,
		candidate: model,
		order: value.order,
		status: value.status,
		startedAt: value.startedAt,
	} as DeepMutable<AuditModelAttemptSummary>;
	if (value.endedAt !== undefined) attempt.endedAt = value.endedAt;
	if (value.failureCategory !== undefined) attempt.failureCategory = value.failureCategory;
	if (value.usage !== undefined) attempt.usage = safeUsage(value.usage);
	if (value.visibleOutput !== undefined) attempt.visibleOutput = value.visibleOutput;
	if (value.contextSnapshotId !== undefined) attempt.contextSnapshotId = value.contextSnapshotId;
	if (value.summary !== undefined && isSafeSummary(value.summary)) attempt.summary = value.summary;
	return attempt;
}

function safeBudget(value: ModelBudgetLimit | LegacyAutomationRunModelBudgetSummary): AuditModelBudgetSummary {
	const budget = {} as DeepMutable<AuditModelBudgetSummary>;
	for (const key of [
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
	] as const) {
		const candidate = (value as unknown as Record<string, unknown>)[key];
		if (candidate !== undefined) {
			if (key === "exceeded" && typeof candidate === "boolean") budget.exceeded = candidate;
			else if (key !== "exceeded" && isFiniteNonNegative(candidate)) budget[key] = candidate;
		}
	}
	return budget;
}

function safePolicyCapabilities(value: SandboxCapabilities): AuditPolicySummary["sandboxCapabilities"] {
	return {
		filesystem: value.filesystem,
		process: value.process,
		network: value.network,
		credentialIsolation: value.credentialIsolation,
	};
}

function safePolicySummary(
	value: PolicyBindingLedgerRecord | PolicyDecisionLedgerRecord | AuditPolicySummary,
): AuditPolicySummary {
	const summary = {
		bindingId: "id" in value ? value.id : value.bindingId,
		profileId: value.profileId,
		profileRevision: value.profileRevision,
		projectTrust: value.projectTrust,
		enforcement: value.enforcement,
		sandboxStatus: "sandboxStatus" in value ? value.sandboxStatus : "not_required",
		sandboxCapabilities: safePolicyCapabilities(
			"sandboxCapabilities" in value
				? value.sandboxCapabilities
				: { filesystem: false, process: false, network: false, credentialIsolation: false },
		),
	} as DeepMutable<AuditPolicySummary>;
	if ("sandboxProviderId" in value && value.sandboxProviderId !== undefined)
		summary.sandboxProviderId = value.sandboxProviderId;
	if ("resource" in value && value.resource !== undefined) summary.resource = value.resource;
	if ("action" in value && value.action !== undefined) summary.action = value.action;
	if ("outcome" in value && value.outcome !== undefined) summary.outcome = value.outcome;
	if ("reasonCode" in value && value.reasonCode !== undefined) summary.reasonCode = value.reasonCode;
	if ("requestId" in value && value.requestId !== undefined) summary.requestId = value.requestId;
	if ("timestamp" in value && value.timestamp !== undefined) summary.timestamp = value.timestamp;
	return summary;
}

function safeRunSummary(
	record: LegacyAutomationRunRecord,
	status: AuditRunEventStatus,
	receipt?: LegacyAutomationRunReceipt,
	endedAt?: string,
): AuditRunSummary {
	const summary = {
		status,
		attempt: record.attempt,
		model: safeRunModelReference(record.model),
	} as DeepMutable<AuditRunSummary>;
	const deadlineAt = receipt?.deadlineAt ?? record.deadlineAt;
	if (deadlineAt !== undefined && isCanonicalTimestamp(deadlineAt)) summary.deadlineAt = deadlineAt;
	if (record.sourceRunId !== undefined) summary.sourceRunId = record.sourceRunId;
	const previousBindingId = safeOptionalOpaqueBindingId(record.previousBindingId);
	const capabilityBindingId = safeOptionalOpaqueBindingId(receipt?.capabilityBindingId ?? record.capabilityBindingId);
	if (previousBindingId !== undefined) summary.previousBindingId = previousBindingId;
	if (capabilityBindingId !== undefined) summary.capabilityBindingId = capabilityBindingId;
	const modelBindingId = safeOptionalIdentifier(receipt?.modelBindingId ?? record.modelBindingId);
	const previousModelBindingId = safeOptionalIdentifier(
		receipt?.previousModelBindingId ?? record.previousModelBindingId,
	);
	const policyBindingId = safeOptionalIdentifier(receipt?.policyBindingId ?? record.policyBindingId);
	const previousPolicyBindingId = safeOptionalIdentifier(
		receipt?.previousPolicyBindingId ?? record.previousPolicyBindingId,
	);
	if (modelBindingId !== undefined) summary.modelBindingId = modelBindingId;
	if (previousModelBindingId !== undefined) summary.previousModelBindingId = previousModelBindingId;
	if (policyBindingId !== undefined) summary.policyBindingId = policyBindingId;
	if (previousPolicyBindingId !== undefined) summary.previousPolicyBindingId = previousPolicyBindingId;
	const contextSnapshotId = safeOptionalIdentifier(receipt?.contextSnapshotId);
	if (contextSnapshotId !== undefined) summary.contextSnapshotId = contextSnapshotId;
	if (receipt?.attachments !== undefined && receipt.attachments.length > 0) {
		const attachments = receipt.attachments.map((attachment) => {
			const copy: DeepMutable<AuditRunAttachmentSummary> = {
				sourceId: attachment.sourceId,
				kind: attachment.kind,
				contentDigest: attachment.contentDigest,
				byteCount: attachment.byteCount,
				blockCount: attachment.blockCount,
			};
			if (attachment.descriptorId !== undefined) copy.descriptorId = attachment.descriptorId;
			if (attachment.revision !== undefined) copy.revision = attachment.revision;
			if (attachment.capabilityBindingId !== undefined) copy.capabilityBindingId = attachment.capabilityBindingId;
			if (attachment.policyBindingId !== undefined) copy.policyBindingId = attachment.policyBindingId;
			if (attachment.mimeTypes !== undefined) copy.mimeTypes = [...attachment.mimeTypes];
			return copy;
		});
		summary.attachments = attachments;
	}
	if (record.startedAt !== undefined) summary.startedAt = record.startedAt;
	const terminalEndedAt = endedAt ?? record.endedAt;
	if (terminalEndedAt !== undefined) summary.endedAt = terminalEndedAt;
	const terminalError = receipt?.terminalError ?? record.terminalError;
	if (terminalError !== undefined && isSafeIdentifier(terminalError.code)) {
		summary.terminalError = { code: terminalError.code, retryable: terminalError.retryable };
	}
	const finalModel = receipt?.finalModel ?? record.finalModel;
	if (finalModel !== undefined) summary.finalModel = safeFinalModelReference(finalModel);
	const modelBudget = receipt?.modelBudget ?? record.modelBudget;
	if (modelBudget !== undefined) summary.modelBudget = safeBudget(modelBudget);
	const bindingAssociation = serializePublicRunBindingAssociation(
		receipt?.bindingAssociation ?? record.bindingAssociation,
	);
	if (bindingAssociation !== undefined)
		summary.bindingAssociation = { ...bindingAssociation, bindings: [...bindingAssociation.bindings] };
	return summary;
}

function safeContextSource(value: ContextSourceReceipt): AuditContextSourceSummary {
	const source = {
		kind: value.kind,
		scope: value.scope,
		trust: value.trust,
		contentDigest: value.contentDigest,
		estimatedTokens: value.estimatedTokens,
		disposition: value.disposition,
	} as DeepMutable<AuditContextSourceSummary>;
	if (value.visibility !== undefined) source.visibility = value.visibility;
	if (value.reason !== undefined) source.reason = value.reason;
	return source;
}

function safeContextSnapshot(value: ContextSnapshot): AuditContextSnapshotSummary {
	const snapshot = {
		schemaVersion: 1,
		id: value.id,
		purpose: value.purpose,
		sessionId: value.sessionId,
		createdAt: value.createdAt,
		sources: value.sources.map(safeContextSource),
		budget: {
			contextWindow: value.budget.contextWindow,
			reserveTokens: value.budget.reserveTokens,
			inputLimit: value.budget.inputLimit,
			estimatedInputTokens: value.budget.estimatedInputTokens,
		},
	} as DeepMutable<AuditContextSnapshotSummary>;
	if (value.runId !== undefined) snapshot.runId = value.runId;
	if (value.parentSnapshotId !== undefined) snapshot.parentSnapshotId = value.parentSnapshotId;
	return snapshot;
}

function safeCapabilityBinding(value: CapabilityBindingLedgerRecord): AuditCapabilityBindingSummary | undefined {
	if (!isOpaqueCapabilityBindingId(value.id)) return undefined;
	const descriptors = value.descriptors
		.filter(
			(descriptor) =>
				isOpaqueCapabilityDescriptorId(descriptor.id) && isOpaqueCapabilityRevision(descriptor.revision),
		)
		.map((descriptor) => {
			const safeDescriptor: { id: string; revision: string; exposedToolName?: string } = {
				id: descriptor.id,
				revision: descriptor.revision,
			};
			if (descriptor.exposedToolName !== undefined && isSafeIdentifier(descriptor.exposedToolName))
				safeDescriptor.exposedToolName = descriptor.exposedToolName;
			return safeDescriptor;
		});
	return {
		id: value.id,
		profile: value.profile,
		createdAt: value.createdAt,
		descriptors,
		decisionSummary: {
			allowed: value.decisionSummary.allowed,
			awaitingApproval: value.decisionSummary.awaitingApproval,
			denied: value.decisionSummary.denied,
		},
		toolAllowlist: value.toolAllowlist.filter((tool) => isSafeIdentifier(tool)),
	};
}

function safePolicyApproval(value: PolicyApprovalLedgerRecord): AuditPolicyApprovalSummary {
	const approval = {
		id: value.id,
		bindingId: value.bindingId,
		resource: value.resource,
		reasonCode: "policy_approval_required",
		createdAt: value.createdAt,
		scope: { resource: value.scope.resource },
	} as DeepMutable<AuditPolicyApprovalSummary>;
	if (value.requestId !== undefined) approval.requestId = value.requestId;
	if (value.outcome !== undefined) approval.outcome = value.outcome as PolicyApprovalOutcome;
	if (value.source !== undefined) approval.source = value.source as PolicyApprovalSource;
	if (value.scope.workspaceScopes !== undefined) approval.scope.workspaceScopes = [...value.scope.workspaceScopes];
	if (value.scope.environmentCount !== undefined) approval.scope.environmentCount = value.scope.environmentCount;
	if (value.scope.destinationCount !== undefined) approval.scope.destinationCount = value.scope.destinationCount;
	if (value.scope.credentialCount !== undefined) approval.scope.credentialCount = value.scope.credentialCount;
	return approval;
}

function safeSandboxLifecycle(value: SandboxLifecycleLedgerRecord): AuditSandboxLifecycleSummary {
	const lifecycle = {
		bindingId: value.bindingId,
		status: value.status,
		timestamp: value.timestamp,
	} as DeepMutable<AuditSandboxLifecycleSummary>;
	if (value.providerId !== undefined) lifecycle.providerId = value.providerId;
	if (value.capabilities !== undefined) lifecycle.capabilities = safePolicyCapabilities(value.capabilities);
	if (value.reasonCode !== undefined) lifecycle.reasonCode = value.reasonCode;
	return lifecycle;
}

function safePolicyViolation(value: PolicyViolationLedgerRecord): AuditPolicyViolationSummary {
	const violation = {
		bindingId: value.bindingId,
		timestamp: value.timestamp,
		reasonCode: value.reasonCode,
	} as DeepMutable<AuditPolicyViolationSummary>;
	if (value.resource !== undefined) violation.resource = value.resource;
	if (value.requestId !== undefined) violation.requestId = value.requestId;
	return violation;
}

function safeTaskGateSummary(value: TaskGateTransition): AuditTaskGateSummary {
	const gate = value.gate;
	const summary = {
		gateId: gate.gateId,
		taskId: gate.taskId,
		stageId: gate.stageId,
		stageRevision: gate.stageRevision,
		action: value.action,
		status: gate.status,
		revision: gate.revision,
		requestedAt: gate.requestedAt,
	} as DeepMutable<AuditTaskGateSummary>;
	if (gate.decidedAt !== undefined) summary.decidedAt = gate.decidedAt;
	if (gate.runId !== undefined) summary.runId = gate.runId;
	if (gate.actorId !== undefined) summary.actorId = gate.actorId;
	if (gate.reasonCode !== undefined) summary.reasonCode = gate.reasonCode;
	return summary;
}

/** Build the allowlisted summary of one `task.graph` transition. */
function safeTaskGraphSummary(value: TaskGraphTransition): AuditTaskGraphSummary {
	const summary = {
		taskId: value.taskId,
		graphRevision: value.graphRevision,
		action: value.action,
	} as DeepMutable<AuditTaskGraphSummary>;
	const node = value.node;
	if (node !== undefined) {
		summary.nodeId = node.nodeId;
		summary.status = node.status;
		summary.nodeRevision = node.nodeRevision;
		if (node.dependsOn.length > 0) summary.dependsOn = [...node.dependsOn];
		if (node.gateRef !== undefined) {
			summary.gateRef = { stageId: node.gateRef.stageId, stageRevision: node.gateRef.stageRevision };
		}
		if (node.runRef !== undefined) summary.runId = node.runRef.runId;
		if (node.outcomeCode !== undefined) summary.outcomeCode = node.outcomeCode;
	}
	return summary;
}

/** Build the allowlisted summary of one `task.credential` transition. */
function safeTaskCredentialSummary(value: TaskCredentialTransition): AuditTaskCredentialSummary {
	const grant = value.grant;
	const summary = {
		action: value.action,
		grantId: grant.grantId,
		leaseId: grant.leaseId,
		bindingId: grant.bindingId,
		sessionId: grant.sessionId,
		taskId: grant.taskId,
		graphRevision: grant.graphRevision,
		nodeId: grant.nodeId,
		runId: grant.runId,
		scopeDigest: grant.scopeDigest,
		scopeCount: grant.scopeCount,
		status: grant.status,
		recordedAt: value.recordedAt,
	} as DeepMutable<AuditTaskCredentialSummary>;
	if (grant.stageId !== undefined) summary.stageId = grant.stageId;
	if (grant.stageRevision !== undefined) summary.stageRevision = grant.stageRevision;
	if (grant.targetId !== undefined) summary.targetId = grant.targetId;
	const reasonCode = value.reasonCode ?? grant.reasonCode;
	if (reasonCode !== undefined) summary.reasonCode = reasonCode;
	return summary;
}

function safeWorkerLifecycleSummary(value: WorkerLifecycleAuditRecord): AuditWorkerLifecycleSummary {
	const record = value.record;
	const summary = {
		workerId: record.workerId,
		providerId: record.providerId,
		sessionId: record.sessionId,
		laneId: record.laneId,
		profileId: record.profileId,
		status: record.status,
		revision: record.revision,
		createdAt: record.createdAt,
	} as DeepMutable<AuditWorkerLifecycleSummary>;
	for (const key of [
		"runId",
		"bindingId",
		"bindingEpochId",
		"attemptId",
		"readyAt",
		"endedAt",
		"lastHeartbeatAt",
		"activeOperationId",
		"receiptId",
	] as const) {
		const item = record[key];
		if (item !== undefined) summary[key] = item;
	}
	if (value.operationId !== undefined) summary.operationId = value.operationId;
	return summary;
}

function safeWorkerOperationSummary(value: WorkerOperationAuditRecord): AuditWorkerOperationSummary {
	const summary = {
		workerId: value.workerId,
		providerId: value.providerId,
		sessionId: value.sessionId,
		laneId: value.laneId,
		operationId: value.operationId,
		phase: value.phase,
		revision: value.revision,
	} as DeepMutable<AuditWorkerOperationSummary>;
	if (value.sideEffectState !== undefined) summary.sideEffectState = value.sideEffectState;
	if (value.receiptId !== undefined) summary.receiptId = value.receiptId;
	return summary;
}

function safeWorkerReceiptSummary(value: WorkerReceiptAuditRecord): AuditWorkerReceiptSummary {
	const summary = {
		workerId: value.workerId,
		workerReceiptId: value.workerReceiptId,
		operationId: value.operationId,
		terminalRecordRevision: value.terminalRecordRevision,
	} as DeepMutable<AuditWorkerReceiptSummary>;
	if (value.taskId !== undefined) summary.taskId = value.taskId;
	return summary;
}

function safeSchedulerSummary(value: SchedulerAuditRecord): AuditSchedulerSummary {
	const event = value.envelope;
	const correlation: Record<string, string> = {};
	for (const [key, item] of Object.entries(event.correlation)) {
		if (typeof item === "string" && isSafeIdentifier(item)) correlation[key] = item;
	}
	return {
		category: event.category as SchedulerDurableEventCategory,
		eventId: event.eventId,
		streamId: event.streamId,
		sequence: event.sequence,
		safeSummary: `${event.category} revision ${event.sequence}`,
		payloadDigest: fingerprintFoundationValue(event.payload),
		correlation,
	};
}

function isCustomEntry(value: SessionEntry): value is Extract<SessionEntry, { type: "custom" }> {
	return value.type === "custom";
}

interface RunFactBase {
	readonly entry: Extract<SessionEntry, { type: "custom" }>;
	readonly recordedAt: string;
}

type RunFact =
	| (RunFactBase & { readonly kind: "accepted"; readonly record: LegacyAutomationRunRecord })
	| (RunFactBase & { readonly kind: "started"; readonly runId: string; readonly startedAt: string })
	| (RunFactBase & {
			readonly kind: "terminal";
			readonly receipt: LegacyAutomationRunReceipt;
			readonly endedAt: string;
	  });

interface RunState {
	readonly runId: string;
	projection?: AutomationRunProjection;
	canonicalSource?: CanonicalAuditRunSource;
	accepted: (RunFactBase & { readonly kind: "accepted"; readonly record: LegacyAutomationRunRecord }) | undefined;
	started:
		| (RunFactBase & { readonly kind: "started"; readonly runId: string; readonly startedAt: string })
		| undefined;
	terminal:
		| (RunFactBase & {
				readonly kind: "terminal";
				readonly receipt: LegacyAutomationRunReceipt;
				readonly endedAt: string;
		  })
		| undefined;
}

interface FoundationFactSource<TValue> {
	readonly entry: Extract<SessionEntry, { type: "custom" }>;
	readonly record: Extract<FoundationRecord, { kind: "fact" }>;
	readonly value: TValue;
}

interface CanonicalAuditRunSource {
	readonly terminal: FoundationFactSource<CanonicalRunReceipt>;
	readonly task: FoundationFactSource<TaskEnvelope>;
	readonly attempts: ReadonlyArray<FoundationFactSource<Attempt>>;
	readonly projection: CanonicalAutomationRunProjection;
}

interface RunSourceProjection {
	readonly canonicalByRunId: ReadonlyMap<string, CanonicalAuditRunSource>;
	readonly legacyEntries: ReadonlyArray<Extract<SessionEntry, { type: "custom" }>>;
	readonly projections: ReadonlyArray<AutomationRunProjection>;
}

const CANONICAL_RUN_OBJECT_TYPES = new Set(["task", "attempt", "attempt_receipt", "task_result", "run_receipt"]);
const FOUNDATION_RESERVED_CUSTOM_TYPE_PREFIX = "__aos.foundation.";
const FOUNDATION_RESERVED_CUSTOM_TYPES = new Set([
	FOUNDATION_ENTRY_CUSTOM_TYPE,
	FOUNDATION_RECORD_CUSTOM_TYPE,
	FOUNDATION_LANE_CUSTOM_TYPE,
	FOUNDATION_FACT_CUSTOM_TYPE,
	FOUNDATION_DURABLE_CUSTOM_TYPE,
]);

function canonicalEqual(left: unknown, right: unknown): boolean {
	return canonicalFoundationJson(left) === canonicalFoundationJson(right);
}

function failRunProjection(): never {
	throw new ExecutionAuditError("audit_replay_incomplete");
}

function parseFoundationRecordEntry(entry: Extract<SessionEntry, { type: "custom" }>): FoundationRecord {
	const data = entry.data;
	if (
		!isRecord(data) ||
		!hasOnlyKeys(data, new Set(["schemaVersion", "kind", "record"])) ||
		data.schemaVersion !== 1 ||
		data.kind !== "durable" ||
		!isRecord(data.record)
	) {
		return failRunProjection();
	}
	let encoded: string;
	try {
		encoded = canonicalFoundationJson({ kind: "foundation", schemaVersion: 1, record: data.record });
	} catch {
		return failRunProjection();
	}
	const decoded = parseFoundationMutation(encoded);
	if (!decoded.ok) return failRunProjection();
	return decoded.value;
}

function foundationTimestamp(record: FoundationRecord): string {
	const value = new Date(record.timestamp);
	if (!Number.isFinite(value.valueOf())) return failRunProjection();
	return value.toISOString();
}

function selectFoundationFacts(
	sessionId: string,
	entries: ReadonlyArray<SessionEntry>,
): Map<string, FoundationFactSource<unknown>> {
	const state = new FoundationLedgerState({ sessionId });
	const entriesByRecordId = new Map<string, Extract<SessionEntry, { type: "custom" }>>();
	for (let index = 0; index < entries.length; index += 1) {
		const candidate = entries[index]!;
		const physicalSequence = index + 1;
		if (
			isCustomEntry(candidate) &&
			candidate.customType.startsWith(FOUNDATION_RESERVED_CUSTOM_TYPE_PREFIX) &&
			!FOUNDATION_RESERVED_CUSTOM_TYPES.has(candidate.customType)
		) {
			return failRunProjection();
		}
		if (!isCustomEntry(candidate) || candidate.customType !== FOUNDATION_DURABLE_CUSTOM_TYPE) {
			state.observeExternalSequence(physicalSequence);
			continue;
		}
		const record = parseFoundationRecordEntry(candidate);
		state.applyPersistedRecord(record);
		entriesByRecordId.set(record.id, candidate);
	}

	const current = new Map<string, FoundationFactSource<unknown>>();
	for (const record of state.getRecords()) {
		if (record.kind === "retention") continue;
		if (!CANONICAL_RUN_OBJECT_TYPES.has(record.objectType)) continue;
		if (!isSafeIdentifier(record.id) || !isSafeIdentifier(record.objectType) || !isSafeIdentifier(record.objectId)) {
			return failRunProjection();
		}
		const key = `${record.objectType}\u0000${record.objectId}`;
		if (record.kind === "tombstone") {
			current.delete(key);
			continue;
		}
		if (record.kind === "intent") continue;
		const entry = entriesByRecordId.get(record.id);
		if (entry === undefined) return failRunProjection();
		current.set(key, { entry, record, value: record.payload });
	}
	return current;
}

function requireFoundationFact<TValue>(
	facts: ReadonlyMap<string, FoundationFactSource<unknown>>,
	objectType: string,
	objectId: string,
	validate: (value: unknown) => { readonly ok: boolean; readonly value?: TValue },
): FoundationFactSource<TValue> {
	const source = facts.get(`${objectType}\u0000${objectId}`);
	if (source === undefined || source.record.objectType !== objectType || source.record.objectId !== objectId) {
		return failRunProjection();
	}
	const checked = validate(source.value);
	if (!checked.ok || checked.value === undefined) return failRunProjection();
	return { entry: source.entry, record: source.record, value: checked.value };
}

function sourceMatchesProvenance(
	source: FoundationFactSource<unknown>,
	provenance: ExecutionCorrelation | undefined,
): boolean {
	if (provenance === undefined) return false;
	const sourceCorrelation = source.record.correlation as unknown as Record<string, unknown>;
	const provenanceCorrelation = provenance as unknown as Record<string, unknown>;
	for (const [field, value] of Object.entries(provenanceCorrelation)) {
		if (typeof value === "string" && sourceCorrelation[field] !== value) return false;
	}
	for (const [field, value] of Object.entries(sourceCorrelation)) {
		if (field !== "fencingToken" && typeof value === "string" && provenanceCorrelation[field] !== value) return false;
	}
	return true;
}

function sourceBelongsToRunLane(source: FoundationFactSource<unknown>, sessionId: string, laneId: string): boolean {
	return (
		source.record.lane === laneId &&
		source.record.correlation.sessionId === sessionId &&
		source.record.correlation.laneId === laneId
	);
}

function canonicalRunSources(
	sessionId: string,
	facts: ReadonlyMap<string, FoundationFactSource<unknown>>,
): {
	readonly results: ReadonlyArray<CanonicalRunResult>;
	readonly events: ReadonlyArray<DurableEventEnvelope>;
	readonly sourcesByRunId: ReadonlyMap<string, Omit<CanonicalAuditRunSource, "projection">>;
} {
	const results: CanonicalRunResult[] = [];
	const events: DurableEventEnvelope[] = [];
	const sourcesByRunId = new Map<string, Omit<CanonicalAuditRunSource, "projection">>();
	const runFacts = [...facts.values()]
		.filter((source) => source.record.objectType === "run_receipt")
		.sort((left, right) => left.record.seq - right.record.seq || left.record.id.localeCompare(right.record.id));
	for (const candidate of runFacts) {
		const checkedReceipt = validateRunReceipt(candidate.value);
		if (!checkedReceipt.ok) return failRunProjection();
		const receipt = checkedReceipt.value;
		const sourceLaneId = candidate.record.correlation.laneId;
		if (
			receipt.runId !== candidate.record.objectId ||
			sourcesByRunId.has(receipt.runId) ||
			typeof sourceLaneId !== "string" ||
			sourceLaneId.length === 0
		) {
			return failRunProjection();
		}
		const attemptReceipts = receipt.attemptReceiptIds.map((attemptReceiptId) => {
			const source = requireFoundationFact(facts, "attempt_receipt", attemptReceiptId, (value) =>
				validateAttemptReceipt(value),
			);
			const provenance = source.value.provenance.correlation;
			if (
				source.value.attemptReceiptId !== attemptReceiptId ||
				!sourceBelongsToRunLane(source, sessionId, sourceLaneId) ||
				provenance === undefined ||
				!sourceMatchesProvenance(source, provenance) ||
				provenance.taskId !== source.value.taskId ||
				provenance.dispatchId !== source.value.dispatchId ||
				provenance.attemptId !== source.value.attemptId ||
				provenance.bindingId !== source.value.bindingId ||
				provenance.bindingEpochId !== source.value.bindingEpochIds[0] ||
				provenance.agentInstanceId !== source.value.agentInstanceId ||
				(provenance.attemptReceiptId !== undefined && provenance.attemptReceiptId !== attemptReceiptId) ||
				(provenance.runId !== undefined && provenance.runId !== receipt.runId)
			) {
				return failRunProjection();
			}
			return source;
		});
		if (attemptReceipts.length === 0) return failRunProjection();
		const attempts = attemptReceipts.map(({ value: attemptReceipt }) => {
			const source = requireFoundationFact(facts, "attempt", attemptReceipt.attemptId, (value) =>
				validateAttempt(value),
			);
			if (
				source.value.attemptId !== attemptReceipt.attemptId ||
				source.value.taskId !== attemptReceipt.taskId ||
				source.value.dispatchId !== attemptReceipt.dispatchId ||
				source.value.providerId !== attemptReceipt.providerId ||
				source.value.bindingId !== attemptReceipt.bindingId ||
				source.value.agentInstanceId !== attemptReceipt.agentInstanceId ||
				!canonicalEqual(source.value.bindingEpochIds, attemptReceipt.bindingEpochIds) ||
				!sourceBelongsToRunLane(source, sessionId, sourceLaneId) ||
				source.record.correlation.taskId !== source.value.taskId ||
				source.record.correlation.dispatchId !== source.value.dispatchId ||
				source.record.correlation.attemptId !== source.value.attemptId ||
				source.record.correlation.bindingId !== source.value.bindingId ||
				!source.value.bindingEpochIds.includes(source.record.correlation.bindingEpochId ?? "") ||
				source.record.correlation.agentInstanceId !== source.value.agentInstanceId ||
				(source.record.correlation.runId !== undefined && source.record.correlation.runId !== receipt.runId)
			) {
				return failRunProjection();
			}
			return source;
		});
		const taskId = attemptReceipts[0]!.value.taskId;
		const task = requireFoundationFact(facts, "task", taskId, (value) => validateTaskEnvelope(value));
		if (
			task.value.taskId !== taskId ||
			attemptReceipts.some(({ value }) => value.taskId !== taskId) ||
			!sourceBelongsToRunLane(task, sessionId, sourceLaneId) ||
			task.record.correlation.taskId !== taskId ||
			(task.record.correlation.goalId !== undefined && task.record.correlation.goalId !== task.value.goalId) ||
			(task.record.correlation.runId !== undefined && task.record.correlation.runId !== receipt.runId)
		) {
			return failRunProjection();
		}
		const taskResult =
			receipt.taskResultId === undefined
				? undefined
				: requireFoundationFact(facts, "task_result", receipt.taskResultId, (value) => validateTaskResult(value));
		const taskResultCorrelation = taskResult?.value.provenance.correlation;
		if (
			taskResult !== undefined &&
			(taskResult.value.taskResultId !== receipt.taskResultId ||
				taskResult.value.taskId !== taskId ||
				taskResult.value.provenance.producerKind !== "host" ||
				!sourceBelongsToRunLane(taskResult, sessionId, sourceLaneId) ||
				taskResultCorrelation === undefined ||
				!sourceMatchesProvenance(taskResult, taskResultCorrelation) ||
				taskResultCorrelation.taskId !== taskId ||
				taskResultCorrelation.taskResultId !== receipt.taskResultId ||
				(taskResultCorrelation.runId !== undefined && taskResultCorrelation.runId !== receipt.runId) ||
				taskResult.value.sourceAttemptReceiptIds.length === 0 ||
				taskResult.value.sourceAttemptReceiptIds.some((id) => !receipt.attemptReceiptIds.includes(id)))
		) {
			return failRunProjection();
		}
		const firstAttemptReceipt = attemptReceipts[0]!.value;
		const sourceCorrelation = candidate.record.correlation;
		if (
			candidate.record.lane !== sourceLaneId ||
			sourceCorrelation.sessionId !== sessionId ||
			sourceCorrelation.laneId !== sourceLaneId ||
			sourceCorrelation.taskId !== taskId ||
			sourceCorrelation.runId !== receipt.runId ||
			sourceCorrelation.runReceiptId !== receipt.runReceiptId ||
			sourceCorrelation.taskResultId !== receipt.taskResultId ||
			sourceCorrelation.attemptId !== firstAttemptReceipt.attemptId ||
			sourceCorrelation.attemptReceiptId !== firstAttemptReceipt.attemptReceiptId
		) {
			return failRunProjection();
		}
		const writtenEvent = createDurableEvent({
			category: "run_receipt.written",
			eventId: candidate.record.id,
			streamId: sessionId,
			sequence: candidate.record.seq,
			timestamp: foundationTimestamp(candidate.record),
			correlation: {
				sessionId,
				laneId: sourceLaneId,
				taskId,
				runId: receipt.runId,
				runReceiptId: receipt.runReceiptId,
				...(receipt.taskResultId === undefined ? {} : { taskResultId: receipt.taskResultId }),
				attemptId: firstAttemptReceipt.attemptId,
				attemptReceiptId: firstAttemptReceipt.attemptReceiptId,
			},
			payload: { schemaVersion: 1, runReceiptId: receipt.runReceiptId, runId: receipt.runId },
		});
		for (const attempt of attempts) {
			events.push(
				createDurableEvent({
					category: "attempt.started",
					eventId: `${attempt.record.id}:run:${receipt.runId}`,
					streamId: sessionId,
					sequence: attempt.record.seq,
					timestamp: attempt.value.startedAt,
					correlation: {
						sessionId,
						...(attempt.record.correlation.laneId === undefined
							? {}
							: { laneId: attempt.record.correlation.laneId }),
						runId: receipt.runId,
						taskId: attempt.value.taskId,
						dispatchId: attempt.value.dispatchId,
						attemptId: attempt.value.attemptId,
					},
					payload: {
						schemaVersion: 1,
						taskId: attempt.value.taskId,
						dispatchId: attempt.value.dispatchId,
						attemptId: attempt.value.attemptId,
					},
				}),
			);
		}
		results.push({
			schemaVersion: 1,
			runReceipt: receipt,
			...(taskResult === undefined ? {} : { taskResult: taskResult.value }),
			attemptReceipts: attemptReceipts.map(({ value }) => value),
			writtenEvent,
		});
		sourcesByRunId.set(receipt.runId, {
			terminal: { entry: candidate.entry, record: candidate.record, value: receipt },
			task,
			attempts,
		});
	}
	return { results, events, sourcesByRunId };
}

function legacyRunEntries(
	entries: ReadonlyArray<SessionEntry>,
): ReadonlyArray<Extract<SessionEntry, { type: "custom" }>> {
	const byId = new Map<string, Extract<SessionEntry, { type: "custom" }>>();
	for (const entry of entries) {
		if (!isCustomEntry(entry) || entry.customType !== "automation.run") continue;
		const existing = byId.get(entry.id);
		if (existing !== undefined) {
			if (!canonicalEqual(existing, entry)) return failRunProjection();
			continue;
		}
		byId.set(entry.id, entry);
	}
	return [...byId.values()].sort((left, right) => {
		const leftRunId = legacyRunId(left.data);
		const rightRunId = legacyRunId(right.data);
		if (leftRunId !== undefined && rightRunId !== undefined) {
			const runOrder = leftRunId.localeCompare(rightRunId);
			if (runOrder !== 0) return runOrder;
			const leftKind = isRecord(left.data) ? left.data.kind : undefined;
			const rightKind = isRecord(right.data) ? right.data.kind : undefined;
			const leftOrder = leftKind === "accepted" ? 0 : leftKind === "started" ? 1 : leftKind === "terminal" ? 2 : 3;
			const rightOrder =
				rightKind === "accepted" ? 0 : rightKind === "started" ? 1 : rightKind === "terminal" ? 2 : 3;
			if (leftOrder !== rightOrder) return leftOrder - rightOrder;
			return left.timestamp.localeCompare(right.timestamp) || left.id.localeCompare(right.id);
		}
		if (leftRunId !== undefined || rightRunId !== undefined) return leftRunId === undefined ? 1 : -1;
		return left.timestamp.localeCompare(right.timestamp) || left.id.localeCompare(right.id);
	});
}

function legacyRunId(data: unknown): string | undefined {
	if (!isRecord(data)) return undefined;
	if (data.kind === "accepted" && isRecord(data.record) && typeof data.record.id === "string") return data.record.id;
	if (data.kind === "started" && typeof data.runId === "string") return data.runId;
	if (data.kind === "terminal" && isRecord(data.receipt) && typeof data.receipt.runId === "string") {
		return data.receipt.runId;
	}
	return undefined;
}

function legacyMigrationSource(
	entries: ReadonlyArray<Extract<SessionEntry, { type: "custom" }>>,
): ReadonlyArray<LegacyAutomationRunLedgerSourceEntry> {
	const decoded = entries.map((entry) => ({
		entry,
		fact: decodeLegacyAutomationRunLedgerEntryV1(entry.data),
	}));
	const startedRunIds = new Set(decoded.flatMap(({ fact }) => (fact.kind === "started" ? [fact.runId] : [])));
	return decoded
		.filter(({ fact }) => fact.kind !== "terminal" || startedRunIds.has(fact.receipt.runId))
		.map(({ entry, fact }, index) => ({ sequence: index + 1, entryId: entry.id, data: fact }));
}

function projectRunSources(sessionId: string, entries: ReadonlyArray<SessionEntry>): RunSourceProjection {
	try {
		const facts = selectFoundationFacts(sessionId, entries);
		const canonicalSources = canonicalRunSources(sessionId, facts);
		const canonical = projectAutomationRuns({
			canonicalRuns: canonicalSources.results,
			events: canonicalSources.events,
		});
		const legacyEntries = legacyRunEntries(entries);
		const reconciled = reconcileLegacyAutomationRunLedger(
			sessionId,
			legacyMigrationSource(legacyEntries),
			canonical,
		);
		const canonicalByRunId = new Map<string, CanonicalAuditRunSource>();
		for (const projection of canonical) {
			const source = canonicalSources.sourcesByRunId.get(projection.id);
			if (source === undefined) return failRunProjection();
			canonicalByRunId.set(projection.id, { ...source, projection });
		}
		return { canonicalByRunId, legacyEntries, projections: reconciled.runs };
	} catch (error) {
		if (error instanceof ExecutionAuditError) throw error;
		if (error instanceof AutomationRunProjectionError) throw new ExecutionAuditError("audit_replay_incomplete");
		throw new ExecutionAuditError("audit_replay_incomplete");
	}
}

/** Append-order fold state for `task.gate` custom entries. */
interface TaskGateAuditFold {
	/** Current accepted record per Gate, in append order of the first accepted transition. */
	readonly byGateId: Map<string, TaskGateRecord>;
	/** Business uniqueness key (`sessionId\0taskId\0stageId\0stageRevision`) to gateId. */
	readonly byBusinessKey: Map<string, string>;
	/** Idempotency key (`commandType\0clientRequestId`) to the canonical payload of the accepted transition. */
	readonly byIdempotency: Map<string, string>;
}

interface SourceCandidateBase {
	readonly eventType: Exclude<
		AuditEventType,
		"run.accepted" | "run.started" | "run.completed" | "run.failed" | "run.cancelled" | "run.interrupted"
	>;
	readonly entry: Extract<SessionEntry, { type: "custom" }>;
	readonly recordedAt: string;
	readonly relation?: Relation;
}

interface WorkerLifecycleAuditRecord {
	readonly record: WorkerRecord;
	readonly operationId?: string;
}

interface WorkerOperationAuditRecord {
	readonly workerId: string;
	readonly providerId: string;
	readonly sessionId: string;
	readonly laneId: string;
	readonly operationId: string;
	readonly phase: "claimed" | "started" | "terminal";
	readonly revision: number;
	readonly sideEffectState?: "none" | "unknown" | "side_effect_unknown";
	readonly receiptId?: string;
}

interface WorkerReceiptAuditRecord {
	readonly workerId: string;
	readonly workerReceiptId: string;
	readonly operationId: string;
	readonly taskId?: string;
	readonly terminalRecordRevision: number;
}

interface SchedulerAuditRecord {
	readonly envelope: Extract<FoundationEventEnvelope, { readonly class: "durable" }>;
}

type SourceCandidate =
	| (SourceCandidateBase & { readonly eventType: "model.binding"; readonly value: ModelBindingLedgerRecord })
	| (SourceCandidateBase & { readonly eventType: "model.attempt"; readonly value: ModelAttemptLedgerRecord })
	| (SourceCandidateBase & { readonly eventType: "context.snapshot"; readonly value: ContextSnapshot })
	| (SourceCandidateBase & { readonly eventType: "capability.binding"; readonly value: CapabilityBindingLedgerRecord })
	| (SourceCandidateBase & { readonly eventType: "policy.binding"; readonly value: PolicyBindingLedgerRecord })
	| (SourceCandidateBase & { readonly eventType: "policy.decision"; readonly value: PolicyDecisionLedgerRecord })
	| (SourceCandidateBase & { readonly eventType: "policy.approval"; readonly value: PolicyApprovalLedgerRecord })
	| (SourceCandidateBase & { readonly eventType: "sandbox.lifecycle"; readonly value: SandboxLifecycleLedgerRecord })
	| (SourceCandidateBase & { readonly eventType: "policy.violation"; readonly value: PolicyViolationLedgerRecord })
	| (SourceCandidateBase & { readonly eventType: "remote.operation"; readonly value: RemoteOperationReceipt })
	| (SourceCandidateBase & { readonly eventType: "task.gate"; readonly value: TaskGateTransition })
	| (SourceCandidateBase & { readonly eventType: "task.graph"; readonly value: TaskGraphTransition })
	| (SourceCandidateBase & { readonly eventType: "task.credential"; readonly value: TaskCredentialTransition })
	| (SourceCandidateBase & { readonly eventType: "worker.lifecycle"; readonly value: WorkerLifecycleAuditRecord })
	| (SourceCandidateBase & { readonly eventType: "worker.operation"; readonly value: WorkerOperationAuditRecord })
	| (SourceCandidateBase & { readonly eventType: "worker.receipt"; readonly value: WorkerReceiptAuditRecord })
	| (SourceCandidateBase & { readonly eventType: "scheduler.event"; readonly value: SchedulerAuditRecord });

type Relation =
	| { readonly kind: "model-binding"; readonly bindingId: string }
	| { readonly kind: "model-attempt"; readonly bindingId: string }
	| { readonly kind: "capability"; readonly bindingId: string }
	| { readonly kind: "policy-binding"; readonly bindingId: string; readonly runId: string }
	| { readonly kind: "policy"; readonly bindingId: string }
	| { readonly kind: "context"; readonly runId?: string }
	| { readonly kind: "remote-operation"; readonly runId?: string }
	| { readonly kind: "task-gate"; readonly runId?: string }
	| { readonly kind: "task-graph"; readonly runId?: string }
	| { readonly kind: "task-credential"; readonly runId?: string }
	| { readonly kind: "worker"; readonly workerId: string; readonly runId?: string }
	| { readonly kind: "scheduler"; readonly runId?: string };

interface InternalWarning {
	readonly warning: AuditWarning;
	readonly relatedRunIds?: ReadonlySet<string>;
	readonly uncertain: boolean;
}

interface InternalFoldResult extends AuditFoldResult {
	readonly internalWarnings: ReadonlyArray<InternalWarning>;
	readonly runIds: ReadonlySet<string>;
}

function warning(
	sessionId: string,
	code: AuditWarningCode,
	entry: Extract<SessionEntry, { type: "custom" }> | undefined,
	eventType?: AuditEventType,
	schema?: number,
	relatedRunIds?: ReadonlySet<string>,
	uncertain = false,
): InternalWarning {
	const result = { code } as DeepMutable<AuditWarning>;
	if (isSafeIdentifier(sessionId)) result.sessionId = sessionId;
	if (entry !== undefined && isSafeIdentifier(entry.id)) result.sourceEntryId = entry.id;
	if (eventType !== undefined) result.eventType = eventType;
	if (schema !== undefined && Number.isFinite(schema)) result.schemaVersion = schema;
	return { warning: result, relatedRunIds, uncertain };
}

function sortKey(event: AuditEvent): AuditSortKey {
	return {
		recordedAt: event.recordedAt,
		sessionId: event.sessionId,
		sourceEntryId: event.sourceEntryId,
		eventId: event.eventId,
	};
}

function compareSortKeys(left: AuditSortKey, right: AuditSortKey): number {
	for (const key of AUDIT_CURSOR_SORT_KEYS) {
		if (left[key] < right[key]) return -1;
		if (left[key] > right[key]) return 1;
	}
	return 0;
}

function compareEvents(left: AuditEvent, right: AuditEvent): number {
	return compareSortKeys(sortKey(left), sortKey(right));
}

function sourceEventType(customType: string): AuditEventType | undefined {
	if (customType === "model.binding") return "model.binding";
	if (customType === "model.attempt") return "model.attempt";
	if (customType === "context.snapshot") return "context.snapshot";
	if (customType === "capability.binding") return "capability.binding";
	if (customType === "policy.binding") return "policy.binding";
	if (customType === "policy.decision") return "policy.decision";
	if (customType === "policy.approval") return "policy.approval";
	if (customType === "sandbox.lifecycle") return "sandbox.lifecycle";
	if (customType === "policy.violation") return "policy.violation";
	if (customType === "remote.operation") return "remote.operation";
	if (customType === "task.gate") return "task.gate";
	if (customType === "task.graph") return "task.graph";
	if (customType === "task.credential") return "task.credential";
	if (customType === WORKER_LIFECYCLE_CUSTOM_TYPE) return "worker.lifecycle";
	if (customType === WORKER_OPERATION_CUSTOM_TYPE) return "worker.operation";
	if (customType === WORKER_RECEIPT_CUSTOM_TYPE) return "worker.receipt";
	if ((SCHEDULER_DURABLE_EVENT_CATEGORIES as readonly string[]).includes(customType)) return "scheduler.event";
	return undefined;
}

function addMapSet(map: Map<string, Set<string>>, key: string, value: string): void {
	const set = map.get(key) ?? new Set<string>();
	set.add(value);
	map.set(key, set);
}

function relationRunIds(relation: Relation | undefined, maps: AssociationMaps): ReadonlySet<string> | undefined {
	if (relation === undefined) return undefined;
	if (relation.kind === "policy-binding") return new Set([relation.runId]);
	if (
		relation.kind === "context" ||
		relation.kind === "remote-operation" ||
		relation.kind === "task-gate" ||
		relation.kind === "task-graph" ||
		relation.kind === "task-credential" ||
		relation.kind === "scheduler"
	) {
		return relation.runId === undefined ? undefined : new Set([relation.runId]);
	}
	if (relation.kind === "worker") {
		if (relation.runId !== undefined) return new Set([relation.runId]);
		return maps.workers.get(relation.workerId);
	}
	const map =
		relation.kind === "model-binding" || relation.kind === "model-attempt"
			? maps.modelBindings
			: relation.kind === "capability"
				? maps.capabilities
				: maps.policies;
	return map.get(relation.bindingId);
}

interface AssociationMaps {
	readonly modelBindings: Map<string, Set<string>>;
	readonly capabilities: Map<string, Set<string>>;
	readonly policies: Map<string, Set<string>>;
	readonly workers: Map<string, Set<string>>;
}

function buildAssociationMaps(
	states: Map<string, RunState>,
	candidates: ReadonlyArray<SourceCandidate>,
): AssociationMaps {
	const maps: AssociationMaps = {
		modelBindings: new Map(),
		capabilities: new Map(),
		policies: new Map(),
		workers: new Map(),
	};
	for (const state of states.values()) {
		if (state.canonicalSource !== undefined) continue;
		const record = state.accepted?.record;
		if (record === undefined) continue;
		const receipt = state.terminal?.receipt;
		for (const id of [
			record.modelBindingId,
			record.previousModelBindingId,
			receipt?.modelBindingId,
			receipt?.previousModelBindingId,
		]) {
			if (id !== undefined) addMapSet(maps.modelBindings, id, state.runId);
		}
		for (const id of [record.capabilityBindingId, receipt?.capabilityBindingId])
			if (id !== undefined) addMapSet(maps.capabilities, id, state.runId);
		for (const id of [
			record.policyBindingId,
			record.previousPolicyBindingId,
			receipt?.policyBindingId,
			receipt?.previousPolicyBindingId,
		]) {
			if (id !== undefined) addMapSet(maps.policies, id, state.runId);
		}
	}
	for (const candidate of candidates) {
		if (candidate.eventType === "policy.binding") addMapSet(maps.policies, candidate.value.id, candidate.value.runId);
		if (candidate.eventType === "worker.lifecycle" && candidate.value.record.runId !== undefined)
			addMapSet(maps.workers, candidate.value.record.workerId, candidate.value.record.runId);
	}
	return maps;
}

function createBase(
	sessionId: string,
	entry: Extract<SessionEntry, { type: "custom" }>,
	recordedAt = entry.timestamp,
): AuditEventBase {
	return {
		schemaVersion: 1,
		eventId: entry.id,
		recordedAt,
		sessionId,
		sourceEntryId: entry.id,
	};
}

function runSummaryAt(state: RunState, status: AuditRunEventStatus): AuditRunSummary | undefined {
	if (state.projection !== undefined) {
		const projection = state.projection;
		const usage = projection.terminal.usage;
		if (usage === undefined) return failRunProjection();
		const summary =
			projection.migration !== undefined && state.accepted !== undefined
				? {
						...safeRunSummary(
							state.accepted.record,
							projection.status,
							state.terminal?.receipt,
							projection.endedAt,
						),
					}
				: { status: projection.status };
		const mutable = summary as DeepMutable<AuditRunSummary>;
		mutable.status = projection.status;
		if (projection.startedAt !== undefined) mutable.startedAt = projection.startedAt;
		mutable.endedAt = projection.endedAt;
		mutable.usage = { input: usage.input, output: usage.output, total: usage.total };
		if (projection.terminalError !== undefined) {
			mutable.terminalError = {
				code: projection.terminalError.code,
				...(projection.terminalError.category === undefined ? {} : { category: projection.terminalError.category }),
				...(projection.terminalError.retryable === undefined
					? {}
					: { retryable: projection.terminalError.retryable }),
			};
		}
		return mutable;
	}
	const accepted = state.accepted;
	if (accepted === undefined) return undefined;
	const summary = {
		...safeRunSummary(accepted.record, status, state.terminal?.receipt, state.terminal?.endedAt),
	} as DeepMutable<AuditRunSummary>;
	if (summary.startedAt === undefined && state.started !== undefined) summary.startedAt = state.started.startedAt;
	return summary;
}

interface WorkerAuditOperationState {
	readonly workerId: string;
	readonly operationId: string;
	readonly claimedRevision: number;
	readonly startedRevision?: number;
	readonly terminalRevision?: number;
	readonly terminalReceiptId?: string;
}

interface WorkerAuditFold {
	readonly lifecycleByRevision: Map<string, WorkerLifecycleAuditRecord>;
	readonly currentByWorker: Map<string, WorkerRecord>;
	readonly lastLifecycleEnvelopeByWorker: Map<string, { readonly revision: number; readonly timestamp: string }>;
	readonly operations: Map<string, WorkerAuditOperationState>;
}

function workerCorrelationIsSafe(correlation: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
	if (!hasOnlyKeys(correlation, allowed)) return false;
	return Object.values(correlation).every((item) => workerString(item));
}

function workerEnvelope(
	entry: Extract<SessionEntry, { type: "custom" }>,
	customType: string,
	allowedPayload: ReadonlySet<string>,
	allowedCorrelation: ReadonlySet<string>,
):
	| {
			readonly eventId: string;
			readonly streamId: string;
			readonly payload: Record<string, unknown>;
			readonly correlation: Record<string, unknown>;
			readonly sequence: number;
			readonly timestamp: string;
	  }
	| undefined {
	const data = entry.data;
	if (
		!isRecord(data) ||
		hasForbiddenWorkerValue(data) ||
		!hasOnlyKeys(data, WORKER_ENVELOPE_KEYS) ||
		data.schemaVersion !== AUDIT_SCHEMA_VERSION ||
		data.class !== "durable" ||
		data.category !== customType ||
		!workerString(data.eventId) ||
		!workerString(data.streamId) ||
		!isCount(data.sequence) ||
		!isCanonicalTimestamp(data.timestamp) ||
		!isRecord(data.correlation) ||
		!isRecord(data.payload) ||
		!workerCorrelationIsSafe(data.correlation, allowedCorrelation) ||
		!hasOnlyKeys(data.payload, allowedPayload) ||
		data.payload.schemaVersion !== AUDIT_SCHEMA_VERSION
	)
		return undefined;
	if (data.correlation.sessionId === "") return undefined;
	return {
		eventId: data.eventId,
		streamId: data.streamId,
		payload: data.payload,
		correlation: data.correlation,
		sequence: data.sequence,
		timestamp: data.timestamp,
	};
}

function workerLifecyclePayloadRecord(payload: Record<string, unknown>): WorkerRecord | undefined {
	const recordValue = { ...payload };
	delete recordValue.operationId;
	return validateWorkerRecord(recordValue) ? recordValue : undefined;
}

function parseWorkerFact(
	sessionId: string,
	entry: Extract<SessionEntry, { type: "custom" }>,
	fold: WorkerAuditFold,
	internalWarnings: InternalWarning[],
	candidates: SourceCandidate[],
): void {
	const customType = entry.customType;
	const eventType =
		customType === WORKER_LIFECYCLE_CUSTOM_TYPE
			? "worker.lifecycle"
			: customType === WORKER_OPERATION_CUSTOM_TYPE
				? "worker.operation"
				: "worker.receipt";
	const version = schemaVersion(entry.data);
	if (version === undefined) {
		internalWarnings.push(warning(sessionId, "malformed_source", entry, eventType, undefined, undefined, true));
		return;
	}
	if (version !== AUDIT_SCHEMA_VERSION) {
		internalWarnings.push(warning(sessionId, "unsupported_schema", entry, eventType, version, undefined, true));
		return;
	}
	if (!isCanonicalTimestamp(entry.timestamp) || !isSafeIdentifier(entry.id)) {
		internalWarnings.push(warning(sessionId, "malformed_source", entry, eventType, version, undefined, true));
		return;
	}
	const envelope = workerEnvelope(
		entry,
		customType,
		eventType === "worker.lifecycle"
			? WORKER_LIFECYCLE_PAYLOAD_KEYS
			: eventType === "worker.operation"
				? WORKER_OPERATION_PAYLOAD_KEYS
				: WORKER_RECEIPT_PAYLOAD_KEYS,
		eventType === "worker.lifecycle"
			? WORKER_LIFECYCLE_CORRELATION_KEYS
			: eventType === "worker.operation"
				? WORKER_OPERATION_CORRELATION_KEYS
				: WORKER_RECEIPT_CORRELATION_KEYS,
	);
	if (envelope === undefined) {
		internalWarnings.push(warning(sessionId, "malformed_source", entry, eventType, version, undefined, true));
		return;
	}
	const { payload, correlation, sequence, timestamp } = envelope;
	if (eventType === "worker.lifecycle") {
		const record = workerLifecyclePayloadRecord(payload);
		const operationId = payload.operationId;
		const previousLifecycle = fold.lastLifecycleEnvelopeByWorker.get(record?.workerId ?? "");
		const isExecutionTerminal = ["completed", "failed", "cancelled", "lost"].includes(record?.status ?? "");
		const lifecycleTimeValid =
			record === undefined
				? false
				: record.status === "starting"
					? timestamp >= record.createdAt
					: record.status === "ready"
						? record.readyAt !== undefined && timestamp === record.readyAt
						: isExecutionTerminal
							? record.endedAt !== undefined && timestamp === record.endedAt
							: true;
		const previous = record === undefined ? undefined : fold.currentByWorker.get(record.workerId);
		const expectedReadyAt = previous?.readyAt ?? (record?.status === "ready" ? timestamp : undefined);
		const expectedEndedAt = previous?.endedAt ?? (isExecutionTerminal ? timestamp : undefined);
		const transitionReceiptId = workerString(correlation.receiptId) ? correlation.receiptId : undefined;
		const expectedReceiptId = transitionReceiptId ?? previous?.receiptId;
		const expectedActiveOperationId =
			record?.status === "running"
				? operationId
				: record?.status === "cancelling"
					? previous?.activeOperationId
					: undefined;
		const transitionOperationValid =
			record?.status === "running"
				? operationId !== undefined && operationId === record.activeOperationId
				: record?.status === "cancelling" || isExecutionTerminal
					? operationId === previous?.activeOperationId
					: operationId === undefined;
		const transitionReceiptValid =
			record?.status === "completed" || record?.status === "cancelled"
				? transitionReceiptId !== undefined
				: record?.status === "lost" || !isExecutionTerminal
					? transitionReceiptId === undefined
					: true;
		const heartbeatValid =
			record === undefined
				? false
				: previous === undefined
					? record.lastHeartbeatAt === undefined ||
						previousLifecycle === undefined ||
						record.lastHeartbeatAt >= previousLifecycle.timestamp
					: previous.lastHeartbeatAt === undefined
						? record.lastHeartbeatAt === undefined ||
							previousLifecycle === undefined ||
							record.lastHeartbeatAt >= previousLifecycle.timestamp
						: record.lastHeartbeatAt !== undefined &&
							record.lastHeartbeatAt >= previous.lastHeartbeatAt &&
							(record.lastHeartbeatAt === previous.lastHeartbeatAt ||
								previousLifecycle === undefined ||
								record.lastHeartbeatAt >= previousLifecycle.timestamp);
		if (
			record === undefined ||
			(operationId !== undefined && !workerString(operationId)) ||
			!workerString(correlation.sessionId) ||
			record.sessionId !== sessionId ||
			correlation.sessionId !== record.sessionId ||
			correlation.laneId !== record.laneId ||
			correlation.workerId !== record.workerId ||
			correlation.runId !== record.runId ||
			correlation.bindingId !== record.bindingId ||
			correlation.bindingEpochId !== record.bindingEpochId ||
			correlation.attemptId !== record.attemptId ||
			correlation.operationId !== operationId ||
			sequence !== record.revision ||
			envelope.eventId !== `worker-lifecycle:${record.workerId}:${record.revision}` ||
			envelope.streamId !== `worker-lifecycle:${record.workerId}` ||
			!workerString(record.profileId) ||
			!lifecycleTimeValid ||
			!transitionOperationValid ||
			!transitionReceiptValid ||
			record.readyAt !== expectedReadyAt ||
			record.endedAt !== expectedEndedAt ||
			record.activeOperationId !== expectedActiveOperationId ||
			record.receiptId !== expectedReceiptId ||
			!heartbeatValid ||
			(record.lastHeartbeatAt !== undefined && record.lastHeartbeatAt > timestamp) ||
			(previousLifecycle !== undefined &&
				(record.revision !== previousLifecycle.revision + 1 || timestamp < previousLifecycle.timestamp))
		) {
			internalWarnings.push(warning(sessionId, "malformed_source", entry, eventType, version, undefined, true));
			return;
		}
		if (
			(previous === undefined && (record.revision !== 1 || record.status !== "starting")) ||
			(previous !== undefined &&
				(record.revision !== previous.revision + 1 ||
					record.createdAt !== previous.createdAt ||
					record.providerId !== previous.providerId ||
					record.sessionId !== previous.sessionId ||
					record.laneId !== previous.laneId ||
					record.runId !== previous.runId ||
					record.bindingId !== previous.bindingId ||
					record.bindingEpochId !== previous.bindingEpochId ||
					record.attemptId !== previous.attemptId ||
					record.profileId !== previous.profileId ||
					!workerTransitionAllowed(previous.status, record.status)))
		) {
			internalWarnings.push(warning(sessionId, "malformed_source", entry, eventType, version, undefined, true));
			return;
		}
		const revisionKey = `${record.workerId}:${record.revision}`;
		if (fold.lifecycleByRevision.has(revisionKey)) {
			internalWarnings.push(warning(sessionId, "duplicate_source", entry, eventType, version, undefined, true));
			return;
		}
		fold.lifecycleByRevision.set(revisionKey, {
			record,
			...(operationId === undefined ? {} : { operationId }),
		});
		fold.currentByWorker.set(record.workerId, record);
		fold.lastLifecycleEnvelopeByWorker.set(record.workerId, { revision: record.revision, timestamp });
		candidates.push({
			eventType,
			entry,
			recordedAt: timestamp,
			value: { record, ...(operationId === undefined ? {} : { operationId }) },
			relation: { kind: "worker", workerId: record.workerId, runId: record.runId },
		});
		return;
	}
	if (eventType === "worker.operation") {
		const phase = payload.phase;
		const sideEffectState = payload.sideEffectState;
		const receiptId = payload.receiptId;
		const value: WorkerOperationAuditRecord = {
			workerId: String(payload.workerId),
			providerId: String(payload.providerId),
			sessionId: String(payload.sessionId),
			laneId: String(payload.laneId),
			operationId: String(payload.operationId),
			phase: phase as WorkerOperationAuditRecord["phase"],
			revision: sequence,
			...(sideEffectState === undefined
				? {}
				: { sideEffectState: sideEffectState as WorkerOperationAuditRecord["sideEffectState"] }),
			...(receiptId === undefined ? {} : { receiptId: String(receiptId) }),
		};
		const lifecycle = fold.lifecycleByRevision.get(`${value.workerId}:${value.revision}`);
		const record = lifecycle?.record;
		const operationState = fold.operations.get(`${value.workerId}:${value.operationId}`);
		const validPhase = phase === "claimed" || phase === "started" || phase === "terminal";
		const phaseValid =
			phase === "claimed"
				? record?.status === "ready" && lifecycle?.operationId === undefined && operationState === undefined
				: phase === "started"
					? record?.status === "running" &&
						lifecycle?.operationId === value.operationId &&
						record.activeOperationId === value.operationId &&
						operationState?.startedRevision === undefined &&
						operationState?.terminalRevision === undefined
					: record !== undefined &&
						["completed", "failed", "cancelled", "lost"].includes(record.status) &&
						lifecycle?.operationId === value.operationId &&
						record.activeOperationId === undefined &&
						operationState?.startedRevision !== undefined &&
						operationState.terminalRevision === undefined;
		const sideEffectStateValid =
			sideEffectState === undefined ||
			sideEffectState === "none" ||
			sideEffectState === "unknown" ||
			sideEffectState === "side_effect_unknown";
		const operationFactsValid =
			phase === "claimed" || phase === "started"
				? sideEffectState === undefined && receiptId === undefined && correlation.receiptId === undefined
				: record?.status === "completed" || record?.status === "cancelled"
					? sideEffectState === "none" &&
						receiptId === record.receiptId &&
						correlation.receiptId === record.receiptId
					: record?.status === "lost"
						? sideEffectState === "side_effect_unknown" &&
							receiptId === undefined &&
							correlation.receiptId === undefined
						: record?.status === "failed" &&
							sideEffectState !== undefined &&
							receiptId === record.receiptId &&
							correlation.receiptId === record.receiptId;
		if (
			!validPhase ||
			!phaseValid ||
			!workerString(value.workerId) ||
			!workerString(value.providerId) ||
			!workerString(value.sessionId) ||
			value.sessionId !== sessionId ||
			!workerString(value.laneId) ||
			!workerString(value.operationId) ||
			!isCount(value.revision) ||
			!sideEffectStateValid ||
			!operationFactsValid ||
			(payload.receiptId !== undefined && !workerString(payload.receiptId)) ||
			value.providerId !== record?.providerId ||
			value.sessionId !== record?.sessionId ||
			value.laneId !== record?.laneId ||
			correlation.sessionId !== value.sessionId ||
			correlation.laneId !== value.laneId ||
			correlation.workerId !== value.workerId ||
			correlation.operationId !== value.operationId ||
			envelope.eventId !== `worker-operation:${value.workerId}:${value.revision}` ||
			envelope.streamId !== `worker-operation:${value.workerId}:${value.operationId}` ||
			payload.revision !== sequence ||
			payload.recordedAt !== timestamp
		) {
			internalWarnings.push(warning(sessionId, "malformed_source", entry, eventType, version, undefined, true));
			return;
		}
		const key = `${value.workerId}:${value.operationId}`;
		fold.operations.set(
			key,
			phase === "claimed"
				? { workerId: value.workerId, operationId: value.operationId, claimedRevision: value.revision }
				: phase === "started"
					? { ...operationState!, startedRevision: value.revision }
					: {
							...operationState!,
							terminalRevision: value.revision,
							...(value.receiptId === undefined ? {} : { terminalReceiptId: value.receiptId }),
						},
		);
		candidates.push({
			eventType,
			entry,
			recordedAt: timestamp,
			value,
			relation: { kind: "worker", workerId: value.workerId },
		});
		return;
	}
	const streamId = isRecord(entry.data) && typeof entry.data.streamId === "string" ? entry.data.streamId : "";
	const workerId = streamId.startsWith("worker-receipts:") ? streamId.slice("worker-receipts:".length) : "";
	const value: WorkerReceiptAuditRecord = {
		workerId,
		workerReceiptId: String(payload.workerReceiptId),
		operationId: String(payload.operationId),
		...(payload.taskId === undefined ? {} : { taskId: String(payload.taskId) }),
		terminalRecordRevision: sequence,
	};
	const operationState = fold.operations.get(`${workerId}:${value.operationId}`);
	if (
		!workerString(workerId) ||
		!workerString(value.workerReceiptId) ||
		!workerString(value.operationId) ||
		(value.taskId !== undefined && !workerString(value.taskId)) ||
		operationState?.terminalRevision !== value.terminalRecordRevision ||
		operationState?.terminalReceiptId !== value.workerReceiptId ||
		envelope.eventId !== `worker-receipt:${value.workerReceiptId}` ||
		envelope.streamId !== `worker-receipts:${workerId}` ||
		correlation.sessionId !== sessionId ||
		correlation.operationId !== value.operationId ||
		correlation.workerReceiptId !== value.workerReceiptId ||
		correlation.taskId !== value.taskId
	) {
		internalWarnings.push(warning(sessionId, "malformed_source", entry, eventType, version, undefined, true));
		return;
	}
	candidates.push({ eventType, entry, recordedAt: timestamp, value, relation: { kind: "worker", workerId } });
}

function parseSchedulerFact(
	sessionId: string,
	entry: Extract<SessionEntry, { type: "custom" }>,
	internalWarnings: InternalWarning[],
	candidates: SourceCandidate[],
): void {
	const version = schemaVersion(entry.data);
	const malformed = (): void => {
		internalWarnings.push(warning(sessionId, "malformed_source", entry, "scheduler.event", version, undefined, true));
	};
	if (
		version !== AUDIT_SCHEMA_VERSION ||
		!isRecord(entry.data) ||
		hasForbiddenSchedulerAuditValue(entry.data.payload) ||
		!isCanonicalTimestamp(entry.timestamp) ||
		!isSafeIdentifier(entry.id)
	) {
		malformed();
		return;
	}
	const parsed = validateDurableEvent(entry.data);
	if (
		!parsed.ok ||
		parsed.value.class !== "durable" ||
		parsed.value.category !== entry.customType ||
		!(SCHEDULER_DURABLE_EVENT_CATEGORIES as readonly string[]).includes(parsed.value.category)
	) {
		malformed();
		return;
	}
	const event = parsed.value;
	if (
		event.correlation.sessionId !== sessionId ||
		event.timestamp !== entry.timestamp ||
		!isSafeIdentifier(event.eventId) ||
		!isSafeIdentifier(event.streamId) ||
		Object.values(event.correlation).some((item) => !isSafeIdentifier(item))
	) {
		malformed();
		return;
	}
	const runId = typeof event.correlation.runId === "string" ? event.correlation.runId : undefined;
	candidates.push({
		eventType: "scheduler.event",
		entry,
		recordedAt: event.timestamp,
		value: { envelope: event },
		relation: { kind: "scheduler", ...(runId === undefined ? {} : { runId }) },
	});
}

function parseSourceCandidate(
	sessionId: string,
	entry: Extract<SessionEntry, { type: "custom" }>,
	internalWarnings: InternalWarning[],
	candidates: SourceCandidate[],
): void {
	const customType = entry.customType;
	if ((AUDIT_EXCLUDED_CUSTOM_TYPES as readonly string[]).includes(customType)) return;
	if (customType === "automation.run") return;
	const eventType = sourceEventType(customType);
	if (eventType === undefined) {
		internalWarnings.push(
			warning(sessionId, "unknown_source", entry, undefined, schemaVersion(entry.data), undefined, true),
		);
		return;
	}
	if (!isCanonicalTimestamp(entry.timestamp) || !isSafeIdentifier(entry.id)) {
		internalWarnings.push(
			warning(sessionId, "malformed_source", entry, eventType, schemaVersion(entry.data), undefined, true),
		);
		return;
	}
	const version = schemaVersion(entry.data);
	if (version === undefined) {
		internalWarnings.push(warning(sessionId, "malformed_source", entry, eventType, undefined, undefined, true));
		return;
	}
	if (version !== AUDIT_SCHEMA_VERSION) {
		internalWarnings.push(warning(sessionId, "unsupported_schema", entry, eventType, version, undefined, true));
		return;
	}
	const data = entry.data;
	if (!isRecord(data)) {
		internalWarnings.push(warning(sessionId, "malformed_source", entry, eventType, version, undefined, true));
		return;
	}
	let candidate: SourceCandidate | undefined;
	if (eventType === "model.binding") {
		const value = data.binding ?? data.record;
		if (isModelBindingAuditRecord(value))
			candidate = {
				eventType,
				entry,
				recordedAt: entry.timestamp,
				value,
				relation: { kind: "model-binding", bindingId: value.bindingId },
			};
	} else if (eventType === "model.attempt") {
		const value = data.attempt ?? data.record;
		if (isModelAttemptAuditRecord(value))
			candidate = {
				eventType,
				entry,
				recordedAt: entry.timestamp,
				value,
				relation: { kind: "model-attempt", bindingId: value.bindingId },
			};
	} else if (eventType === "context.snapshot") {
		if (isContextSnapshotAuditRecord(data)) {
			if (data.sessionId !== sessionId) {
				internalWarnings.push(
					warning(
						sessionId,
						"orphan_source",
						entry,
						eventType,
						version,
						data.runId === undefined ? undefined : new Set([data.runId]),
						false,
					),
				);
				return;
			}
			candidate = {
				eventType,
				entry,
				recordedAt: entry.timestamp,
				value: data,
				relation: { kind: "context", runId: data.runId },
			};
		}
	} else if (eventType === "capability.binding") {
		const value = data.binding ?? data.record;
		if (isCapabilityBindingAuditRecord(value))
			candidate = {
				eventType,
				entry,
				recordedAt: entry.timestamp,
				value,
				relation: { kind: "capability", bindingId: value.id },
			};
	} else if (eventType === "policy.binding") {
		const value = data.record ?? data.binding ?? data.summary;
		if (isPolicyBindingAuditRecord(value))
			candidate = {
				eventType,
				entry,
				recordedAt: entry.timestamp,
				value,
				relation: { kind: "policy-binding", bindingId: value.id, runId: value.runId },
			};
	} else if (eventType === "policy.decision") {
		const value = data.record ?? data.decision ?? data.summary;
		if (isPolicyDecisionAuditRecord(value))
			candidate = {
				eventType,
				entry,
				recordedAt: entry.timestamp,
				value,
				relation: { kind: "policy", bindingId: value.bindingId },
			};
	} else if (eventType === "policy.approval") {
		const value = data.approval ?? data.record;
		if (isPolicyApprovalAuditRecord(value))
			candidate = {
				eventType,
				entry,
				recordedAt: entry.timestamp,
				value,
				relation: { kind: "policy", bindingId: value.bindingId },
			};
	} else if (eventType === "sandbox.lifecycle") {
		const value = data.sandboxLifecycle ?? data.record;
		if (isSandboxLifecycleAuditRecord(value))
			candidate = {
				eventType,
				entry,
				recordedAt: entry.timestamp,
				value,
				relation: { kind: "policy", bindingId: value.bindingId },
			};
	} else if (eventType === "policy.violation") {
		const value = data.violation ?? data.record;
		if (isPolicyViolationAuditRecord(value))
			candidate = {
				eventType,
				entry,
				recordedAt: entry.timestamp,
				value,
				relation: { kind: "policy", bindingId: value.bindingId },
			};
	} else if (eventType === "remote.operation") {
		const value = data.receipt ?? data.operation ?? data;
		if (isRemoteOperationReceipt(value)) {
			const relationRunId = value.runId;
			if (value.sessionId !== undefined && value.sessionId !== sessionId) {
				internalWarnings.push(
					warning(
						sessionId,
						"orphan_source",
						entry,
						eventType,
						version,
						relationRunId === undefined ? undefined : new Set([relationRunId]),
						false,
					),
				);
				return;
			}
			candidate = {
				eventType,
				entry,
				recordedAt: entry.timestamp,
				value,
				relation: { kind: "remote-operation", runId: relationRunId },
			};
		}
	}
	if (candidate === undefined) {
		internalWarnings.push(warning(sessionId, "malformed_source", entry, eventType, version, undefined, true));
		return;
	}
	candidates.push(candidate);
}

function taskGateBusinessKey(record: TaskGateRecord): string {
	return `${record.sessionId}\u0000${record.taskId}\u0000${record.stageId}\u0000${record.stageRevision}`;
}

function taskGateIdempotencyKey(action: TaskGateAction, clientRequestId: string): string {
	return `${taskGateCommandType(action)}\u0000${clientRequestId}`;
}

/** Canonical payload of a transition; mirrors the store's idempotency payload. */
function taskGateTransitionPayload(action: TaskGateAction, gate: TaskGateRecord): string {
	if (action === "requested") {
		return JSON.stringify({
			taskId: gate.taskId,
			stageId: gate.stageId,
			stageRevision: gate.stageRevision,
			runId: gate.runId ?? null,
		});
	}
	return JSON.stringify({
		gateId: gate.gateId,
		actorId: gate.actorId ?? null,
		reasonCode: gate.reasonCode ?? null,
	});
}

/** Two snapshots of the same Gate must agree on all immutable fields. */
function sameTaskGateIdentity(left: TaskGateRecord, right: TaskGateRecord): boolean {
	return (
		left.gateId === right.gateId &&
		left.sessionId === right.sessionId &&
		left.taskId === right.taskId &&
		left.stageId === right.stageId &&
		left.stageRevision === right.stageRevision &&
		left.requestedAt === right.requestedAt &&
		(left.runId ?? undefined) === (right.runId ?? undefined)
	);
}

/**
 * Fold one `task.gate` custom entry in append order into a safe audit event.
 * Entries that fail schema, identifier, session, revision, or transition
 * rules are skipped with the existing warning semantics and never surface
 * raw data. Gate warnings never carry a run association or uncertainty flag,
 * so they cannot change any Run's replay status or completeness.
 */
function parseTaskGateFact(
	sessionId: string,
	entry: Extract<SessionEntry, { type: "custom" }>,
	fold: TaskGateAuditFold,
	internalWarnings: InternalWarning[],
	candidates: SourceCandidate[],
): void {
	if (!isCanonicalTimestamp(entry.timestamp) || !isSafeIdentifier(entry.id)) {
		internalWarnings.push(
			warning(
				sessionId,
				"malformed_source",
				entry,
				"task.gate",
				taskGateSchemaVersion(entry.data),
				undefined,
				false,
			),
		);
		return;
	}
	const version = taskGateSchemaVersion(entry.data);
	if (version === undefined) {
		internalWarnings.push(warning(sessionId, "malformed_source", entry, "task.gate", undefined, undefined, false));
		return;
	}
	if (version !== TASK_GATE_SCHEMA_VERSION) {
		internalWarnings.push(warning(sessionId, "unsupported_schema", entry, "task.gate", version, undefined, false));
		return;
	}
	if (!isTaskGateTransition(entry.data)) {
		internalWarnings.push(warning(sessionId, "malformed_source", entry, "task.gate", version, undefined, false));
		return;
	}
	const transition = entry.data;
	const gate = transition.gate;
	if (gate.sessionId !== sessionId) {
		internalWarnings.push(warning(sessionId, "orphan_source", entry, "task.gate", version, undefined, false));
		return;
	}
	const key = taskGateIdempotencyKey(transition.action, transition.clientRequestId);
	const acceptedPayload = fold.byIdempotency.get(key);
	if (acceptedPayload !== undefined) {
		if (acceptedPayload !== taskGateTransitionPayload(transition.action, gate)) {
			internalWarnings.push(warning(sessionId, "duplicate_source", entry, "task.gate", version, undefined, false));
		}
		return;
	}
	const accept = (): void => {
		fold.byGateId.set(gate.gateId, gate);
		fold.byBusinessKey.set(taskGateBusinessKey(gate), gate.gateId);
		fold.byIdempotency.set(key, taskGateTransitionPayload(transition.action, gate));
		candidates.push({
			eventType: "task.gate",
			entry,
			recordedAt: entry.timestamp,
			value: transition,
			relation: { kind: "task-gate", runId: gate.runId },
		});
	};
	if (transition.action === "requested") {
		if (fold.byGateId.has(gate.gateId)) {
			internalWarnings.push(warning(sessionId, "duplicate_source", entry, "task.gate", version, undefined, false));
			return;
		}
		if (transition.previousRevision !== 0 || gate.revision !== 0 || gate.status !== "pending") {
			internalWarnings.push(warning(sessionId, "malformed_source", entry, "task.gate", version, undefined, false));
			return;
		}
		const businessKeyValue = taskGateBusinessKey(gate);
		const existingBusinessGateId = fold.byBusinessKey.get(businessKeyValue);
		if (existingBusinessGateId !== undefined && existingBusinessGateId !== gate.gateId) {
			internalWarnings.push(warning(sessionId, "duplicate_source", entry, "task.gate", version, undefined, false));
			return;
		}
		accept();
		return;
	}
	const current = fold.byGateId.get(gate.gateId);
	if (current === undefined) {
		internalWarnings.push(warning(sessionId, "malformed_source", entry, "task.gate", version, undefined, false));
		return;
	}
	if (current.status !== "pending") {
		internalWarnings.push(warning(sessionId, "duplicate_source", entry, "task.gate", version, undefined, false));
		return;
	}
	if (transition.previousRevision !== current.revision || gate.revision !== current.revision + 1) {
		internalWarnings.push(warning(sessionId, "malformed_source", entry, "task.gate", version, undefined, false));
		return;
	}
	if (!sameTaskGateIdentity(current, gate)) {
		internalWarnings.push(warning(sessionId, "duplicate_source", entry, "task.gate", version, undefined, false));
		return;
	}
	accept();
}

/** Append-order fold state for `task.graph` custom entries. */
interface TaskGraphAuditFold {
	/** Business key (`taskId\0graphRevision`) to the current node records of the accepted definition. */
	readonly graphs: Map<string, Map<string, TaskGraphNodeRecord>>;
	/** Idempotency key (`commandType\0clientRequestId`) to the canonical payload of the accepted transition. */
	readonly byIdempotency: Map<string, string>;
}

function taskGraphBusinessKey(taskId: string, graphRevision: number): string {
	return `${taskId}\u0000${graphRevision}`;
}

function taskGraphIdempotencyKey(action: TaskGraphAction, clientRequestId: string): string {
	return `${taskGraphCommandType(action)}\u0000${clientRequestId}`;
}

/** Canonical payload of a persisted transition; mirrors the store fold's idempotency fingerprint. */
function taskGraphTransitionPayload(transition: TaskGraphTransition): string {
	if (transition.action === "created") {
		const definition = transition.graph;
		if (definition === undefined) return "";
		return canonicalTaskGraphCreatePayload({
			taskId: transition.taskId,
			graphRevision: transition.graphRevision,
			nodes: definition.nodes,
			clientRequestId: transition.clientRequestId,
		});
	}
	const node = transition.node;
	if (node === undefined) return "";
	if (transition.action === "node.attached") {
		return canonicalTaskGraphAttachPayload({
			taskId: transition.taskId,
			graphRevision: transition.graphRevision,
			nodeId: node.nodeId,
			runId: node.runRef?.runId ?? "",
			clientRequestId: transition.clientRequestId,
		});
	}
	return canonicalTaskGraphSettlePayload({
		taskId: transition.taskId,
		graphRevision: transition.graphRevision,
		nodeId: node.nodeId,
		clientRequestId: transition.clientRequestId,
	});
}

/** Two snapshots of the same node must agree on all immutable definition fields. */
function sameTaskGraphNodeDefinition(left: TaskGraphNodeRecord, right: TaskGraphNodeRecord): boolean {
	if (left.dependsOn.length !== right.dependsOn.length) return false;
	for (let index = 0; index < left.dependsOn.length; index++) {
		if (left.dependsOn[index] !== right.dependsOn[index]) return false;
	}
	if (left.gateRef === undefined || right.gateRef === undefined) return left.gateRef === right.gateRef;
	return left.gateRef.stageId === right.gateRef.stageId && left.gateRef.stageRevision === right.gateRef.stageRevision;
}

/**
 * Fold one `task.graph` custom entry in append order into a safe audit event.
 * Entries that fail schema, identifier, session, revision, transition,
 * idempotency, business-key, or run-association rules are skipped with the
 * existing warning semantics and never surface raw data. Graph warnings never
 * carry a run association or uncertainty flag, so they cannot change any Run's
 * replay status or completeness, and graph events never participate in Run
 * terminal selection.
 */
function parseTaskGraphFact(
	sessionId: string,
	entry: Extract<SessionEntry, { type: "custom" }>,
	fold: TaskGraphAuditFold,
	internalWarnings: InternalWarning[],
	candidates: SourceCandidate[],
): void {
	if (!isCanonicalTimestamp(entry.timestamp) || !isSafeIdentifier(entry.id)) {
		internalWarnings.push(
			warning(
				sessionId,
				"malformed_source",
				entry,
				"task.graph",
				taskGraphSchemaVersion(entry.data),
				undefined,
				false,
			),
		);
		return;
	}
	const version = taskGraphSchemaVersion(entry.data);
	if (version === undefined) {
		internalWarnings.push(warning(sessionId, "malformed_source", entry, "task.graph", undefined, undefined, false));
		return;
	}
	if (version !== TASK_GRAPH_SCHEMA_VERSION) {
		internalWarnings.push(warning(sessionId, "unsupported_schema", entry, "task.graph", version, undefined, false));
		return;
	}
	if (!isTaskGraphTransition(entry.data)) {
		internalWarnings.push(warning(sessionId, "malformed_source", entry, "task.graph", version, undefined, false));
		return;
	}
	const transition = entry.data;
	const idempotencyKey = taskGraphIdempotencyKey(transition.action, transition.clientRequestId);
	const acceptedPayload = fold.byIdempotency.get(idempotencyKey);
	if (acceptedPayload !== undefined) {
		if (acceptedPayload !== taskGraphTransitionPayload(transition)) {
			internalWarnings.push(warning(sessionId, "duplicate_source", entry, "task.graph", version, undefined, false));
		}
		return;
	}
	const businessKey = taskGraphBusinessKey(transition.taskId, transition.graphRevision);
	if (transition.action === "created") {
		const definition = transition.graph;
		if (definition === undefined) {
			internalWarnings.push(warning(sessionId, "malformed_source", entry, "task.graph", version, undefined, false));
			return;
		}
		if (definition.sessionId !== sessionId) {
			internalWarnings.push(warning(sessionId, "orphan_source", entry, "task.graph", version, undefined, false));
			return;
		}
		if (fold.graphs.has(businessKey)) {
			internalWarnings.push(warning(sessionId, "duplicate_source", entry, "task.graph", version, undefined, false));
			return;
		}
		const nodes = new Map<string, TaskGraphNodeRecord>();
		for (const node of definition.nodes) nodes.set(node.nodeId, serializeTaskGraphNode(node));
		fold.graphs.set(businessKey, nodes);
		fold.byIdempotency.set(idempotencyKey, taskGraphTransitionPayload(transition));
		candidates.push({
			eventType: "task.graph",
			entry,
			recordedAt: entry.timestamp,
			value: transition,
			relation: { kind: "task-graph" },
		});
		return;
	}
	const node = transition.node;
	const nodes = fold.graphs.get(businessKey);
	if (node === undefined || nodes === undefined) {
		internalWarnings.push(warning(sessionId, "malformed_source", entry, "task.graph", version, undefined, false));
		return;
	}
	const current = nodes.get(node.nodeId);
	if (current === undefined) {
		internalWarnings.push(warning(sessionId, "malformed_source", entry, "task.graph", version, undefined, false));
		return;
	}
	if (node.runRef !== undefined && node.runRef.sessionId !== sessionId) {
		internalWarnings.push(warning(sessionId, "orphan_source", entry, "task.graph", version, undefined, false));
		return;
	}
	if (transition.action === "node.attached") {
		if (current.nodeRevision !== 0) {
			internalWarnings.push(warning(sessionId, "duplicate_source", entry, "task.graph", version, undefined, false));
			return;
		}
		if (
			transition.previousNodeRevision !== 0 ||
			node.nodeRevision !== 1 ||
			node.status !== "running" ||
			node.runRef === undefined
		) {
			internalWarnings.push(warning(sessionId, "malformed_source", entry, "task.graph", version, undefined, false));
			return;
		}
		if (!sameTaskGraphNodeDefinition(current, node)) {
			internalWarnings.push(warning(sessionId, "malformed_source", entry, "task.graph", version, undefined, false));
			return;
		}
		for (const other of nodes.values()) {
			if (other.runRef?.runId === node.runRef.runId) {
				internalWarnings.push(
					warning(sessionId, "duplicate_source", entry, "task.graph", version, undefined, false),
				);
				return;
			}
		}
	} else {
		const expectedStatus: TaskGraphNodeStatus =
			transition.action === "node.succeeded"
				? "succeeded"
				: transition.action === "node.failed"
					? "failed"
					: "cancelled";
		if (current.nodeRevision === 2) {
			internalWarnings.push(warning(sessionId, "duplicate_source", entry, "task.graph", version, undefined, false));
			return;
		}
		if (current.nodeRevision === 0) {
			internalWarnings.push(warning(sessionId, "malformed_source", entry, "task.graph", version, undefined, false));
			return;
		}
		if (
			transition.previousNodeRevision !== 1 ||
			node.nodeRevision !== 2 ||
			node.status !== expectedStatus ||
			node.runRef === undefined ||
			node.runRef.runId !== current.runRef?.runId
		) {
			internalWarnings.push(warning(sessionId, "malformed_source", entry, "task.graph", version, undefined, false));
			return;
		}
		if (!sameTaskGraphNodeDefinition(current, node)) {
			internalWarnings.push(warning(sessionId, "malformed_source", entry, "task.graph", version, undefined, false));
			return;
		}
	}
	nodes.set(node.nodeId, serializeTaskGraphNode(node));
	fold.byIdempotency.set(idempotencyKey, taskGraphTransitionPayload(transition));
	candidates.push({
		eventType: "task.graph",
		entry,
		recordedAt: entry.timestamp,
		value: transition,
		relation: { kind: "task-graph", runId: node.runRef?.runId },
	});
}

/** Append-order fold state for `task.credential` custom entries. */
interface TaskCredentialAuditFold {
	/** Current accepted grant snapshot per lease, in append order of the first accepted transition. */
	readonly byLeaseId: Map<string, TaskCredentialGrant>;
	/** Business uniqueness key (bindingId) to leaseId. */
	readonly byBindingId: Map<string, string>;
	/** Grant uniqueness key (grantId) to leaseId. */
	readonly byGrantId: Map<string, string>;
	/** Idempotency key (`operation\u0000clientRequestId`) to the canonical payload of the accepted transition. */
	readonly byIdempotency: Map<string, string>;
}

/** Idempotency operation per persisted action; mirrors the store fold's key derivation. */
function taskCredentialIdempotencyKey(action: TaskCredentialPersistedAction, clientRequestId: string): string {
	const operation =
		action === "issued"
			? "issue"
			: action === "renewed"
				? "renew"
				: action === "delivery_succeeded" || action === "delivery_failed"
					? "project"
					: action === "settled"
						? "settle"
						: "revoke";
	return `${operation}\u0000${clientRequestId}`;
}

/** Canonical payload of a persisted transition; mirrors the store fold's idempotency fingerprint. */
function taskCredentialTransitionPayload(transition: TaskCredentialTransition): string {
	switch (transition.action) {
		case "issued":
			return canonicalTaskCredentialIssuePayload(
				transition.binding!,
				transition.grant,
				transition.leaseId,
				transition.grantId,
			);
		case "renewed":
			return canonicalTaskCredentialRenewPayload(
				transition.leaseId,
				transition.grantId,
				transition.bindingId,
				transition.requestedTtlMs!,
				transition.grant.heartbeatSequence,
			);
		case "delivery_succeeded":
		case "delivery_failed":
			return canonicalTaskCredentialProjectPayload(
				transition.leaseId,
				transition.grantId,
				transition.bindingId,
				transition.grant.targetId,
			);
		case "revoked":
		case "revocation_unknown":
			return canonicalTaskCredentialRevokePayload(
				transition.leaseId,
				transition.grantId,
				transition.bindingId,
				transition.reasonCode,
			);
		case "settled":
			return canonicalTaskCredentialSettlePayload(
				transition.leaseId,
				transition.grantId,
				transition.bindingId,
				transition.reasonCode,
			);
	}
}

/** Expected resulting grant status of each persisted action; mirrors the store fold. */
const EXPECTED_TASK_CREDENTIAL_STATUS: Record<TaskCredentialPersistedAction, TaskCredentialStatus> = {
	issued: "active",
	renewed: "active",
	delivery_succeeded: "active",
	delivery_failed: "active",
	revoked: "revoked",
	revocation_unknown: "revocation_unknown",
	settled: "settled",
};

/** Two snapshots of the same lease must agree on all immutable fields. */
function sameTaskCredentialLeaseIdentity(left: TaskCredentialGrant, right: TaskCredentialGrant): boolean {
	return (
		left.grantId === right.grantId &&
		left.leaseId === right.leaseId &&
		left.bindingId === right.bindingId &&
		left.sessionId === right.sessionId &&
		left.taskId === right.taskId &&
		left.graphRevision === right.graphRevision &&
		left.nodeId === right.nodeId &&
		(left.stageId ?? undefined) === (right.stageId ?? undefined) &&
		(left.stageRevision ?? undefined) === (right.stageRevision ?? undefined) &&
		left.runId === right.runId &&
		left.scopeDigest === right.scopeDigest &&
		left.scopeCount === right.scopeCount &&
		(left.targetId ?? undefined) === (right.targetId ?? undefined) &&
		left.issuedAt === right.issuedAt
	);
}

const TASK_CREDENTIAL_AUDIT_FORBIDDEN_KEY_SET = new Set<string>(TASK_CREDENTIAL_AUDIT_FORBIDDEN_KEYS);

/** True when a record carries a forbidden material / environment / path / provider key. */
function hasForbiddenTaskCredentialKey(value: Record<string, unknown>): boolean {
	return Object.keys(value).some((key) => TASK_CREDENTIAL_AUDIT_FORBIDDEN_KEY_SET.has(key.toLowerCase()));
}

/**
 * Fold one `task.credential` custom entry in append order into a safe audit
 * event. Entries that fail schema, identifier, session, forbidden-key,
 * revision, identity, idempotency, business-key, or transition rules are
 * skipped with the existing warning semantics and never surface raw data.
 * The explicit forbidden-key guard runs before the serializer shape guard,
 * so material / environment / path / provider keys can never become
 * credential facts. Credential warnings never carry a run association or
 * uncertainty flag, so they cannot change any Run's replay status or
 * completeness; correlation is runId-only, from the grant, and the fold
 * never calls the provider or rewrites a Run terminal.
 */
function parseTaskCredentialFact(
	sessionId: string,
	entry: Extract<SessionEntry, { type: "custom" }>,
	fold: TaskCredentialAuditFold,
	internalWarnings: InternalWarning[],
	candidates: SourceCandidate[],
): void {
	if (!isCanonicalTimestamp(entry.timestamp) || !isSafeIdentifier(entry.id)) {
		internalWarnings.push(
			warning(sessionId, "malformed_source", entry, "task.credential", schemaVersion(entry.data), undefined, false),
		);
		return;
	}
	const version = schemaVersion(entry.data);
	if (version === undefined) {
		internalWarnings.push(
			warning(sessionId, "malformed_source", entry, "task.credential", undefined, undefined, false),
		);
		return;
	}
	if (version !== TASK_CREDENTIAL_SCHEMA_VERSION) {
		internalWarnings.push(
			warning(sessionId, "unsupported_schema", entry, "task.credential", version, undefined, false),
		);
		return;
	}
	// Explicit forbidden-key guard: material / environment / path / provider
	// keys are rejected before the exact-shape serializer guard runs, so they
	// can never surface in an event or warning either way.
	if (isRecord(entry.data) && hasForbiddenTaskCredentialKey(entry.data)) {
		internalWarnings.push(
			warning(sessionId, "malformed_source", entry, "task.credential", version, undefined, false),
		);
		return;
	}
	const transition = parseTaskCredentialTransition(entry.data);
	if (transition === undefined) {
		internalWarnings.push(
			warning(sessionId, "malformed_source", entry, "task.credential", version, undefined, false),
		);
		return;
	}
	const grant = transition.grant;
	if (grant.sessionId !== sessionId) {
		internalWarnings.push(warning(sessionId, "orphan_source", entry, "task.credential", version, undefined, false));
		return;
	}
	const key = taskCredentialIdempotencyKey(transition.action, transition.clientRequestId);
	const canonical = taskCredentialTransitionPayload(transition);
	const existing = fold.byIdempotency.get(key);
	if (existing !== undefined) {
		if (existing !== canonical) {
			internalWarnings.push(
				warning(sessionId, "duplicate_source", entry, "task.credential", version, undefined, false),
			);
		}
		return;
	}
	const current = fold.byLeaseId.get(transition.leaseId);
	if (transition.action === "issued") {
		if (current !== undefined) {
			internalWarnings.push(
				warning(sessionId, "duplicate_source", entry, "task.credential", version, undefined, false),
			);
			return;
		}
		const bindingOwner = fold.byBindingId.get(transition.bindingId);
		if (bindingOwner !== undefined && bindingOwner !== transition.leaseId) {
			internalWarnings.push(
				warning(sessionId, "duplicate_source", entry, "task.credential", version, undefined, false),
			);
			return;
		}
		const grantOwner = fold.byGrantId.get(transition.grantId);
		if (grantOwner !== undefined && grantOwner !== transition.leaseId) {
			internalWarnings.push(
				warning(sessionId, "duplicate_source", entry, "task.credential", version, undefined, false),
			);
			return;
		}
	} else {
		if (current === undefined) {
			internalWarnings.push(
				warning(sessionId, "malformed_source", entry, "task.credential", version, undefined, false),
			);
			return;
		}
		if (transition.previousRevision !== current.revision || transition.grant.revision !== current.revision + 1) {
			internalWarnings.push(
				warning(sessionId, "malformed_source", entry, "task.credential", version, undefined, false),
			);
			return;
		}
		if (!sameTaskCredentialLeaseIdentity(current, transition.grant)) {
			internalWarnings.push(
				warning(sessionId, "duplicate_source", entry, "task.credential", version, undefined, false),
			);
			return;
		}
		if (transition.action === "renewed") {
			if (transition.grant.heartbeatSequence !== current.heartbeatSequence + 1) {
				internalWarnings.push(
					warning(sessionId, "malformed_source", entry, "task.credential", version, undefined, false),
				);
				return;
			}
		} else if (transition.grant.heartbeatSequence !== current.heartbeatSequence) {
			internalWarnings.push(
				warning(sessionId, "malformed_source", entry, "task.credential", version, undefined, false),
			);
			return;
		}
		// A persisted `revoked` entry after `revocation_unknown` is trusted as
		// provider-confirmed: the store only writes it after a confirmed
		// provider revoke, and it converges to the safer status.
		if (!isLegalTaskCredentialTransition(current.status, transition.action)) {
			internalWarnings.push(
				warning(sessionId, "duplicate_source", entry, "task.credential", version, undefined, false),
			);
			return;
		}
		if (transition.grant.status !== EXPECTED_TASK_CREDENTIAL_STATUS[transition.action]) {
			internalWarnings.push(
				warning(sessionId, "duplicate_source", entry, "task.credential", version, undefined, false),
			);
			return;
		}
	}
	fold.byLeaseId.set(transition.leaseId, transition.grant);
	fold.byBindingId.set(transition.bindingId, transition.leaseId);
	fold.byGrantId.set(transition.grantId, transition.leaseId);
	fold.byIdempotency.set(key, canonical);
	candidates.push({
		eventType: "task.credential",
		entry,
		recordedAt: entry.timestamp,
		value: transition,
		relation: { kind: "task-credential", runId: grant.runId },
	});
}

function parseRunFact(
	sessionId: string,
	entry: Extract<SessionEntry, { type: "custom" }>,
	states: Map<string, RunState>,
	facts: RunFact[],
	internalWarnings: InternalWarning[],
): void {
	if (!isCanonicalTimestamp(entry.timestamp) || !isSafeIdentifier(entry.id)) {
		internalWarnings.push(
			warning(sessionId, "malformed_source", entry, undefined, schemaVersion(entry.data), undefined, true),
		);
		return;
	}
	const version = schemaVersion(entry.data);
	if (version === undefined) {
		internalWarnings.push(warning(sessionId, "malformed_source", entry, undefined, undefined, undefined, true));
		return;
	}
	if (version !== AUDIT_SCHEMA_VERSION) {
		internalWarnings.push(warning(sessionId, "unsupported_schema", entry, undefined, version, undefined, true));
		return;
	}
	let data: LegacyAutomationRunLedgerEntry;
	try {
		data = decodeLegacyAutomationRunLedgerEntryV1(entry.data);
	} catch {
		internalWarnings.push(warning(sessionId, "malformed_source", entry, undefined, version, undefined, true));
		return;
	}
	if (data.kind === "accepted") {
		if (data.record.sessionId !== sessionId) {
			internalWarnings.push(warning(sessionId, "orphan_source", entry, undefined, version, undefined, false));
			return;
		}
		const fact: RunFact = { kind: "accepted", entry, recordedAt: entry.timestamp, record: data.record };
		const existing = states.get(data.record.id);
		if (existing === undefined)
			states.set(data.record.id, { runId: data.record.id, accepted: fact, started: undefined, terminal: undefined });
		else if (existing.accepted !== undefined) {
			internalWarnings.push(
				warning(sessionId, "duplicate_source", entry, undefined, version, new Set([data.record.id]), false),
			);
			return;
		} else existing.accepted = fact;
		facts.push(fact);
		return;
	}
	if (data.kind === "started") {
		const state = states.get(data.runId);
		if (state === undefined || state.accepted === undefined) {
			internalWarnings.push(
				warning(sessionId, "orphan_source", entry, "run.started", version, new Set([data.runId]), false),
			);
			return;
		}
		const fact: RunFact = {
			kind: "started",
			entry,
			recordedAt: entry.timestamp,
			runId: data.runId,
			startedAt: data.startedAt,
		};
		if (state.started !== undefined) {
			internalWarnings.push(
				warning(sessionId, "duplicate_source", entry, "run.started", version, new Set([data.runId]), false),
			);
			return;
		}
		state.started = fact;
		facts.push(fact);
		return;
	}
	if (data.receipt.sessionId !== sessionId) {
		internalWarnings.push(
			warning(sessionId, "orphan_source", entry, undefined, version, new Set([data.receipt.runId]), false),
		);
		return;
	}
	const runId = data.receipt.runId;
	const state = states.get(runId);
	if (state === undefined || state.accepted === undefined || state.started === undefined) {
		internalWarnings.push(warning(sessionId, "orphan_source", entry, undefined, version, new Set([runId]), false));
		return;
	}
	const fact: RunFact = {
		kind: "terminal",
		entry,
		recordedAt: entry.timestamp,
		receipt: data.receipt,
		endedAt: data.endedAt,
	};
	if (state.terminal !== undefined) {
		internalWarnings.push(warning(sessionId, "duplicate_source", entry, undefined, version, new Set([runId]), false));
		return;
	}
	state.terminal = fact;
	facts.push(fact);
}

function runEventForFact(sessionId: string, fact: RunFact, state: RunState): AuditEvent | undefined {
	if (state.canonicalSource !== undefined) return undefined;
	if (fact.kind === "accepted") {
		const summary = safeRunSummary(fact.record, "accepted");
		return { ...createBase(sessionId, fact.entry), type: "run.accepted", runId: fact.record.id, summary };
	}
	if (state.accepted === undefined) return undefined;
	if (fact.kind === "started") {
		const summary = {
			...safeRunSummary(state.accepted.record, "running", undefined, undefined),
		} as DeepMutable<AuditRunSummary>;
		if (summary.startedAt === undefined) summary.startedAt = fact.startedAt;
		return { ...createBase(sessionId, fact.entry), type: "run.started", runId: fact.runId, summary };
	}
	const status = fact.receipt.status;
	const summary = {
		...safeRunSummary(state.accepted.record, status, fact.receipt, fact.endedAt),
	} as DeepMutable<AuditRunSummary>;
	if (summary.startedAt === undefined && state.started !== undefined) summary.startedAt = state.started.startedAt;
	const type = status === "completed" ? "run.completed" : status === "failed" ? "run.failed" : "run.cancelled";
	return { ...createBase(sessionId, fact.entry), type, runId: fact.receipt.runId, summary };
}

function interruptedEvent(sessionId: string, state: RunState): AuditEvent | undefined {
	if (state.accepted === undefined || state.terminal !== undefined || state.projection !== undefined) return undefined;
	const source = state.started ?? state.accepted;
	const summary = runSummaryAt(state, "interrupted");
	if (summary === undefined) return undefined;
	return {
		...createBase(sessionId, source.entry),
		eventId: `${source.entry.id}:interrupted`,
		type: "run.interrupted",
		runId: state.runId,
		summary,
	};
}

function canonicalRunEvents(sessionId: string, state: RunState): ReadonlyArray<AuditEvent> {
	const source = state.canonicalSource;
	if (source === undefined) return [];
	const accepted: AuditEvent = {
		...createBase(sessionId, source.task.entry, foundationTimestamp(source.task.record)),
		eventId: `${source.task.record.id}:run:${state.runId}`,
		sourceEntryId: source.task.record.id,
		type: "run.accepted",
		runId: state.runId,
		summary: { status: "accepted" },
	};
	const started = source.attempts.map(
		(attempt): AuditEvent => ({
			...createBase(sessionId, attempt.entry, attempt.value.startedAt),
			eventId: `${attempt.record.id}:run:${state.runId}`,
			sourceEntryId: attempt.record.id,
			type: "run.started",
			runId: state.runId,
			summary: {
				status: "running",
				startedAt: source.projection.startedAt ?? attempt.value.startedAt,
			},
		}),
	);
	const summary = runSummaryAt(state, source.projection.status);
	if (summary === undefined) return failRunProjection();
	const terminalType =
		source.projection.status === "completed"
			? "run.completed"
			: source.projection.status === "failed"
				? "run.failed"
				: "run.cancelled";
	const terminal: AuditEvent = {
		...createBase(sessionId, source.terminal.entry, foundationTimestamp(source.terminal.record)),
		eventId: source.terminal.record.id,
		sourceEntryId: source.terminal.record.id,
		type: terminalType,
		runId: state.runId,
		summary,
	};
	return [accepted, ...started, terminal];
}

function sourceEventForCandidate(
	sessionId: string,
	candidate: SourceCandidate,
	runId: string | undefined,
): AuditEvent | undefined {
	const base = createBase(sessionId, candidate.entry, candidate.recordedAt);
	if (candidate.eventType === "model.binding") {
		const summary = safeModelBinding(candidate.value);
		return summary === undefined
			? undefined
			: { ...base, type: candidate.eventType, ...(runId === undefined ? {} : { runId }), summary };
	}
	if (candidate.eventType === "model.attempt") {
		const summary = safeAttempt(candidate.value);
		return summary === undefined
			? undefined
			: { ...base, type: candidate.eventType, ...(runId === undefined ? {} : { runId }), summary };
	}
	if (candidate.eventType === "context.snapshot") {
		const summary = safeContextSnapshot(candidate.value);
		return { ...base, type: candidate.eventType, ...(runId === undefined ? {} : { runId }), summary };
	}
	if (candidate.eventType === "capability.binding") {
		const summary = safeCapabilityBinding(candidate.value);
		return summary === undefined
			? undefined
			: { ...base, type: candidate.eventType, ...(runId === undefined ? {} : { runId }), summary };
	}
	if (candidate.eventType === "policy.binding") {
		return {
			...base,
			type: candidate.eventType,
			...(runId === undefined ? {} : { runId }),
			summary: safePolicySummary(candidate.value),
		};
	}
	if (candidate.eventType === "policy.decision") {
		return {
			...base,
			type: candidate.eventType,
			...(runId === undefined ? {} : { runId }),
			summary: safePolicySummary(candidate.value),
		};
	}
	if (candidate.eventType === "policy.approval") {
		return {
			...base,
			type: candidate.eventType,
			...(runId === undefined ? {} : { runId }),
			summary: safePolicyApproval(candidate.value),
		};
	}
	if (candidate.eventType === "sandbox.lifecycle") {
		return {
			...base,
			type: candidate.eventType,
			...(runId === undefined ? {} : { runId }),
			summary: safeSandboxLifecycle(candidate.value),
		};
	}
	if (candidate.eventType === "policy.violation") {
		return {
			...base,
			type: candidate.eventType,
			...(runId === undefined ? {} : { runId }),
			summary: safePolicyViolation(candidate.value),
		};
	}
	if (candidate.eventType === "remote.operation") {
		return {
			...base,
			type: candidate.eventType,
			...(runId === undefined ? {} : { runId }),
			summary: candidate.value,
		};
	}
	if (candidate.eventType === "task.gate") {
		return {
			...base,
			type: candidate.eventType,
			...(runId === undefined ? {} : { runId }),
			summary: safeTaskGateSummary(candidate.value),
		};
	}
	if (candidate.eventType === "task.graph") {
		return {
			...base,
			type: candidate.eventType,
			...(runId === undefined ? {} : { runId }),
			summary: safeTaskGraphSummary(candidate.value),
		};
	}
	if (candidate.eventType === "task.credential") {
		return {
			...base,
			type: candidate.eventType,
			...(runId === undefined ? {} : { runId }),
			summary: safeTaskCredentialSummary(candidate.value),
		};
	}
	if (candidate.eventType === "worker.lifecycle") {
		return {
			...base,
			type: candidate.eventType,
			...(runId === undefined ? {} : { runId }),
			summary: safeWorkerLifecycleSummary(candidate.value),
		};
	}
	if (candidate.eventType === "worker.operation") {
		return {
			...base,
			type: candidate.eventType,
			...(runId === undefined ? {} : { runId }),
			summary: safeWorkerOperationSummary(candidate.value),
		};
	}
	if (candidate.eventType === "worker.receipt") {
		return {
			...base,
			type: candidate.eventType,
			...(runId === undefined ? {} : { runId }),
			summary: safeWorkerReceiptSummary(candidate.value),
		};
	}
	if (candidate.eventType === "scheduler.event") {
		return {
			...base,
			type: candidate.eventType,
			...(runId === undefined ? {} : { runId }),
			summary: safeSchedulerSummary(candidate.value),
		};
	}
	return undefined;
}

function safeModelBinding(value: ModelBindingLedgerRecord): AuditModelBindingSummary {
	const binding = {
		bindingId: value.bindingId,
		mode: value.mode,
		candidates: value.candidates.map((candidate) => ({
			order: candidate.order,
			model: safeModelReference(candidate.model),
		})),
		fallback: { maxAttempts: value.fallback.maxAttempts, on: [...value.fallback.on] },
		budget: safeBudget(value.budget),
		configRevision: value.configRevision,
		createdAt: value.createdAt,
	} as DeepMutable<AuditModelBindingSummary>;
	if (value.routeId !== undefined) binding.routeId = value.routeId;
	if (value.role !== undefined) binding.role = value.role;
	if (value.previousModelBindingId !== undefined) binding.previousModelBindingId = value.previousModelBindingId;
	return binding;
}

function sessionAndEntries(
	input: AuditSession | AuditSessionInput | ReadonlyArray<SessionEntry>,
	sessionId?: string,
): AuditSessionInput {
	if (Array.isArray(input)) {
		if (!isSafeIdentifier(sessionId)) throw new ExecutionAuditError("audit_scope_unavailable");
		return { sessionId, entries: input };
	}
	if ("getSessionId" in input && "getEntries" in input)
		return {
			sessionId: input.getSessionId(),
			entries: input.getPhysicalEntries?.() ?? input.getEntries(),
		};
	if ("sessionId" in input && "entries" in input) return { sessionId: input.sessionId, entries: input.entries };
	throw new ExecutionAuditError("audit_scope_unavailable");
}

function foldInternal(input: AuditSessionInput): InternalFoldResult {
	const sessionId = input.sessionId;
	if (!isSafeIdentifier(sessionId)) throw new ExecutionAuditError("audit_scope_unavailable");
	const runSources = projectRunSources(sessionId, input.entries);
	const internalWarnings: InternalWarning[] = [];
	const candidates: SourceCandidate[] = [];
	const states = new Map<string, RunState>();
	const facts: RunFact[] = [];
	const gateFold: TaskGateAuditFold = { byGateId: new Map(), byBusinessKey: new Map(), byIdempotency: new Map() };
	const graphFold: TaskGraphAuditFold = { graphs: new Map(), byIdempotency: new Map() };
	const credentialFold: TaskCredentialAuditFold = {
		byLeaseId: new Map(),
		byBindingId: new Map(),
		byGrantId: new Map(),
		byIdempotency: new Map(),
	};
	const workerFold: WorkerAuditFold = {
		lifecycleByRevision: new Map(),
		currentByWorker: new Map(),
		lastLifecycleEnvelopeByWorker: new Map(),
		operations: new Map(),
	};
	for (const entry of runSources.legacyEntries) parseRunFact(sessionId, entry, states, facts, internalWarnings);
	for (const projection of runSources.projections) {
		const state = states.get(projection.id) ?? {
			runId: projection.id,
			accepted: undefined,
			started: undefined,
			terminal: undefined,
		};
		state.projection = projection;
		state.canonicalSource = runSources.canonicalByRunId.get(projection.id);
		states.set(projection.id, state);
	}
	const seenEntryIds = new Set<string>();
	for (const entry of input.entries) {
		if (!isCustomEntry(entry)) continue;
		if (seenEntryIds.has(entry.id)) {
			internalWarnings.push(
				warning(
					sessionId,
					"duplicate_source",
					entry,
					sourceEventType(entry.customType),
					schemaVersion(entry.data),
					undefined,
					true,
				),
			);
			continue;
		}
		seenEntryIds.add(entry.id);
		if (entry.customType === "automation.run" || entry.customType.startsWith("__aos.foundation.")) continue;
		if (entry.customType === TASK_GATE_CUSTOM_TYPE)
			parseTaskGateFact(sessionId, entry, gateFold, internalWarnings, candidates);
		else if (entry.customType === TASK_GRAPH_CUSTOM_TYPE)
			parseTaskGraphFact(sessionId, entry, graphFold, internalWarnings, candidates);
		else if (entry.customType === TASK_CREDENTIAL_CUSTOM_TYPE)
			parseTaskCredentialFact(sessionId, entry, credentialFold, internalWarnings, candidates);
		else if (
			entry.customType === WORKER_LIFECYCLE_CUSTOM_TYPE ||
			entry.customType === WORKER_OPERATION_CUSTOM_TYPE ||
			entry.customType === WORKER_RECEIPT_CUSTOM_TYPE
		)
			parseWorkerFact(sessionId, entry, workerFold, internalWarnings, candidates);
		else if ((SCHEDULER_DURABLE_EVENT_CATEGORIES as readonly string[]).includes(entry.customType))
			parseSchedulerFact(sessionId, entry, internalWarnings, candidates);
		else parseSourceCandidate(sessionId, entry, internalWarnings, candidates);
	}
	const maps = buildAssociationMaps(states, candidates);
	const events: AuditEvent[] = [];
	for (const fact of facts) {
		const runId =
			fact.kind === "accepted" ? fact.record.id : fact.kind === "started" ? fact.runId : fact.receipt.runId;
		const state = states.get(runId);
		if (state === undefined) continue;
		const event = runEventForFact(sessionId, fact, state);
		if (event !== undefined) events.push(event);
	}
	for (const state of states.values()) {
		const event = interruptedEvent(sessionId, state);
		if (event !== undefined) events.push(event);
		events.push(...canonicalRunEvents(sessionId, state));
	}
	for (const candidate of candidates) {
		const runIds = relationRunIds(candidate.relation, maps);
		const ids = runIds === undefined ? undefined : new Set(runIds);
		const relationNeedsRun =
			candidate.relation?.kind === "model-binding" ||
			candidate.relation?.kind === "model-attempt" ||
			candidate.relation?.kind === "capability" ||
			candidate.relation?.kind === "policy";
		if (relationNeedsRun && (ids === undefined || ids.size === 0))
			internalWarnings.push(
				warning(
					sessionId,
					"orphan_source",
					candidate.entry,
					candidate.eventType,
					schemaVersion(candidate.entry.data),
					ids,
					false,
				),
			);
		if (ids !== undefined && ids.size > 1)
			internalWarnings.push(
				warning(
					sessionId,
					"ambiguous_run_association",
					candidate.entry,
					candidate.eventType,
					schemaVersion(candidate.entry.data),
					ids,
					false,
				),
			);
		const directRunId =
			candidate.relation?.kind === "policy-binding" ||
			candidate.relation?.kind === "context" ||
			candidate.relation?.kind === "remote-operation" ||
			candidate.relation?.kind === "worker" ||
			candidate.relation?.kind === "scheduler"
				? candidate.relation.runId
				: undefined;
		if (directRunId !== undefined && !states.has(directRunId)) {
			internalWarnings.push(
				warning(
					sessionId,
					"orphan_source",
					candidate.entry,
					candidate.eventType,
					schemaVersion(candidate.entry.data),
					new Set([directRunId]),
					false,
				),
			);
		}
		const runId =
			ids !== undefined && ids.size === 1
				? [...ids][0]
				: candidate.relation?.kind === "context" ||
						candidate.relation?.kind === "remote-operation" ||
						candidate.relation?.kind === "worker" ||
						candidate.relation?.kind === "task-gate" ||
						candidate.relation?.kind === "task-graph" ||
						candidate.relation?.kind === "task-credential" ||
						candidate.relation?.kind === "scheduler"
					? candidate.relation.runId
					: undefined;
		const event = sourceEventForCandidate(sessionId, candidate, runId);
		if (event === undefined) {
			internalWarnings.push(
				warning(
					sessionId,
					"source_unavailable",
					candidate.entry,
					candidate.eventType,
					schemaVersion(candidate.entry.data),
					ids,
					false,
				),
			);
			continue;
		}
		events.push(event);
	}
	const uniqueEvents = new Map<string, AuditEvent>();
	for (const event of events) {
		const key = `${event.sessionId}\u0000${event.sourceEntryId}\u0000${event.eventId}`;
		const existing = uniqueEvents.get(key);
		if (existing !== undefined && !canonicalEqual(existing, event)) return failRunProjection();
		uniqueEvents.set(key, event);
	}
	const sortedEvents = [...uniqueEvents.values()].sort(compareEvents);
	internalWarnings.sort((left, right) => {
		const leftKey = `${left.warning.sessionId ?? ""}\u0000${left.warning.sourceEntryId ?? ""}\u0000${left.warning.code}`;
		const rightKey = `${right.warning.sessionId ?? ""}\u0000${right.warning.sourceEntryId ?? ""}\u0000${right.warning.code}`;
		return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
	});
	const runSummaries = new Map<string, AuditRunSummary>();
	const runIds = new Set<string>();
	for (const state of states.values()) {
		const status: AuditRunEventStatus =
			state.projection?.status ??
			state.terminal?.receipt.status ??
			(state.started === undefined ? "accepted" : "running");
		const summary = runSummaryAt(state, status);
		if (summary !== undefined) {
			runSummaries.set(state.runId, summary);
			runIds.add(state.runId);
		}
	}
	return {
		events: sortedEvents,
		warnings: internalWarnings.map((item) => item.warning),
		runSummaries,
		internalWarnings,
		runIds,
	};
}

/** Fold one Session's custom entries into safe, deterministic audit events. */
export function foldSessionAudit(
	input: AuditSession | AuditSessionInput | ReadonlyArray<SessionEntry>,
	sessionId?: string,
): AuditFoldResult;
export function foldSessionAudit(sessionId: string, entries: ReadonlyArray<SessionEntry>): AuditFoldResult;
export function foldSessionAudit(
	input: AuditSession | AuditSessionInput | ReadonlyArray<SessionEntry> | string,
	sessionOrEntries?: string | ReadonlyArray<SessionEntry>,
): AuditFoldResult {
	if (typeof input === "string") {
		if (!Array.isArray(sessionOrEntries)) throw new ExecutionAuditError("audit_scope_unavailable");
		return foldInternal({ sessionId: input, entries: sessionOrEntries });
	}
	return foldInternal(sessionAndEntries(input, typeof sessionOrEntries === "string" ? sessionOrEntries : undefined));
}

function canonicalTypes(types: ReadonlyArray<AuditEventType> | undefined): ReadonlyArray<AuditEventType> | undefined {
	if (types === undefined) return undefined;
	const unique = new Set<AuditEventType>(types);
	return [...unique].sort((left, right) => left.localeCompare(right));
}

function isAuditEventType(value: unknown): value is AuditEventType {
	return typeof value === "string" && (AUDIT_EVENT_TYPES as readonly string[]).includes(value);
}

function normalizeQuery(query: AuditQuery, sessionId: string): AuditQuery {
	if (
		!isRecord(query) ||
		Object.keys(query).some((key) => !AUDIT_QUERY_KEYS.has(key)) ||
		query.scope !== "current-session"
	) {
		throw new ExecutionAuditError(
			query?.scope === "session-directory" ? "audit_scope_unavailable" : "audit_query_invalid",
		);
	}
	if (query.sessionId !== undefined && query.sessionId !== sessionId)
		throw new ExecutionAuditError("audit_query_invalid");
	if (query.runId !== undefined && !isSafeIdentifier(query.runId))
		throw new ExecutionAuditError("audit_query_invalid");
	if (
		query.types !== undefined &&
		(!Array.isArray(query.types) || query.types.some((type) => !isAuditEventType(type)))
	)
		throw new ExecutionAuditError("audit_query_invalid");
	if (query.from !== undefined && !isCanonicalTimestamp(query.from))
		throw new ExecutionAuditError("audit_query_invalid");
	if (query.to !== undefined && !isCanonicalTimestamp(query.to)) throw new ExecutionAuditError("audit_query_invalid");
	if (query.from !== undefined && query.to !== undefined && query.from > query.to)
		throw new ExecutionAuditError("audit_query_invalid");
	if (
		query.limit !== undefined &&
		(!Number.isInteger(query.limit) || query.limit < 1 || query.limit > AUDIT_MAX_LIMIT)
	)
		throw new ExecutionAuditError("audit_query_invalid");
	const normalized = {
		scope: "current-session",
		limit: query.limit ?? AUDIT_DEFAULT_LIMIT,
	} as DeepMutable<AuditQuery>;
	if (query.sessionId !== undefined) normalized.sessionId = query.sessionId;
	if (query.runId !== undefined) normalized.runId = query.runId;
	const types = canonicalTypes(query.types);
	if (types !== undefined) normalized.types = [...types];
	if (query.from !== undefined) normalized.from = query.from;
	if (query.to !== undefined) normalized.to = query.to;
	if (query.cursor !== undefined) normalized.cursor = query.cursor;
	return normalized;
}

function normalizeReplayQuery(query: AuditReplayQuery, sessionId: string): AuditQuery {
	if (!isRecord(query) || !isSafeIdentifier(query.runId)) throw new ExecutionAuditError("audit_query_invalid");
	return normalizeQuery({ ...query, scope: "current-session" }, sessionId);
}

function queryFingerprint(query: AuditQuery): string {
	return JSON.stringify({
		scope: query.scope,
		sessionId: query.sessionId,
		runId: query.runId,
		types: query.types,
		from: query.from,
		to: query.to,
		limit: query.limit,
	});
}

/** Exported for callers that need to inspect the cursor binding fingerprint. */
export const createAuditQueryFingerprint = queryFingerprint;

function cursorSecret(secret: AuditCursorSecret | undefined): Buffer {
	return typeof secret === "string" || secret === undefined
		? Buffer.from(secret ?? DEFAULT_CURSOR_SECRET)
		: Buffer.from(secret);
}

function encodeBase64(value: string): string {
	return Buffer.from(value, "utf8").toString("base64url");
}

function decodeBase64(value: string): string | undefined {
	try {
		return Buffer.from(value, "base64url").toString("utf8");
	} catch {
		return undefined;
	}
}

function normalizeCursorInput(
	value: AuditCursorPayload | { readonly fingerprint: string; readonly sortKey: AuditSortKey },
): AuditCursorPayload {
	if ("queryFingerprint" in value) return value;
	return { queryFingerprint: value.fingerprint, last: value.sortKey };
}

/** Encode an opaque, integrity-protected cursor. */
export function encodeAuditCursor(
	payload: AuditCursorPayload | { readonly fingerprint: string; readonly sortKey: AuditSortKey },
	secret?: AuditCursorSecret,
): string {
	const normalized = normalizeCursorInput(payload);
	if (typeof normalized.queryFingerprint !== "string" || !isAuditSortKey(normalized.last))
		throw new ExecutionAuditError("audit_cursor_invalid");
	const body = encodeBase64(
		JSON.stringify({
			version: AUDIT_SCHEMA_VERSION,
			fingerprint: normalized.queryFingerprint,
			last: normalized.last,
		}),
	);
	const mac = createHmac("sha256", cursorSecret(secret)).update(body).digest("base64url");
	return `aos-audit-v1.${body}.${mac}`;
}

function isAuditSortKey(value: unknown): value is AuditSortKey {
	if (!isRecord(value)) return false;
	return (
		isCanonicalTimestamp(value.recordedAt) &&
		isSafeIdentifier(value.sessionId) &&
		isSafeIdentifier(value.sourceEntryId) &&
		isSafeIdentifier(value.eventId)
	);
}

/** Decode and authenticate an opaque audit cursor; malformed values return undefined. */
export function decodeAuditCursor(token: string, secret?: AuditCursorSecret): AuditCursorPayload | undefined {
	if (typeof token !== "string") return undefined;
	const parts = token.split(".");
	if (parts.length !== 3 || parts[0] !== "aos-audit-v1") return undefined;
	const body = parts[1];
	const suppliedMac = parts[2];
	const expectedMac = createHmac("sha256", cursorSecret(secret)).update(body).digest("base64url");
	try {
		const left = Buffer.from(suppliedMac, "base64url");
		const right = Buffer.from(expectedMac, "base64url");
		if (left.length !== right.length || !timingSafeEqual(left, right)) return undefined;
	} catch {
		return undefined;
	}
	const decoded = decodeBase64(body);
	if (decoded === undefined) return undefined;
	try {
		const value: unknown = JSON.parse(decoded);
		if (
			!isRecord(value) ||
			value.version !== AUDIT_SCHEMA_VERSION ||
			typeof value.fingerprint !== "string" ||
			!isAuditSortKey(value.last)
		)
			return undefined;
		return { queryFingerprint: value.fingerprint, last: value.last };
	} catch {
		return undefined;
	}
}

function filterEvents(events: ReadonlyArray<AuditEvent>, query: AuditQuery): AuditEvent[] {
	return events.filter((event) => {
		if (query.runId !== undefined && event.runId !== query.runId) return false;
		if (query.types !== undefined && !query.types.includes(event.type)) return false;
		if (query.from !== undefined && event.recordedAt < query.from) return false;
		if (query.to !== undefined && event.recordedAt >= query.to) return false;
		return true;
	});
}

function paginate(
	events: ReadonlyArray<AuditEvent>,
	query: AuditQuery,
	secret: AuditCursorSecret | undefined,
): { events: ReadonlyArray<AuditEvent>; nextCursor?: string } {
	let filtered = [...events].sort(compareEvents);
	const fingerprint = queryFingerprint(query);
	if (query.cursor !== undefined) {
		const cursor = decodeAuditCursor(query.cursor, secret);
		if (cursor === undefined || cursor.queryFingerprint !== fingerprint)
			throw new ExecutionAuditError("audit_cursor_invalid");
		filtered = filtered.filter((event) => compareSortKeys(sortKey(event), cursor.last) > 0);
	}
	const limit = query.limit ?? AUDIT_DEFAULT_LIMIT;
	const page = filtered.slice(0, limit);
	if (filtered.length <= limit || page.length === 0) return { events: page };
	return {
		events: page,
		nextCursor: encodeAuditCursor({ queryFingerprint: fingerprint, last: sortKey(page[page.length - 1]) }, secret),
	};
}

function warningAffectsRun(item: InternalWarning, runId: string): boolean {
	if (item.relatedRunIds !== undefined) return item.relatedRunIds.has(runId);
	if (item.uncertain) return true;
	return false;
}

/** Read-only one-session adapter consumed by the later RPC layer. */
export class ExecutionAuditAdapter {
	private readonly session: AuditSession;
	private readonly secret: AuditCursorSecret | undefined;

	constructor(session: AuditSession, options: ExecutionAuditAdapterOptions = {}) {
		this.session = session;
		this.secret = options.cursorSecret;
	}

	get sessionId(): string {
		try {
			const sessionId = this.session.getSessionId();
			if (!isSafeIdentifier(sessionId)) throw new ExecutionAuditError("audit_scope_unavailable");
			return sessionId;
		} catch (error) {
			if (error instanceof ExecutionAuditError) throw error;
			throw new ExecutionAuditError("audit_scope_unavailable");
		}
	}

	fold(): AuditFoldResult {
		try {
			return foldInternal({
				sessionId: this.session.getSessionId(),
				entries: this.session.getPhysicalEntries?.() ?? this.session.getEntries(),
			});
		} catch (error) {
			if (error instanceof ExecutionAuditError) throw error;
			throw new ExecutionAuditError("audit_scope_unavailable");
		}
	}

	query(input: AuditQuery): AuditQueryResult {
		const query = normalizeQuery(input, this.sessionId);
		const folded = this.fold() as InternalFoldResult;
		const events = paginate(filterEvents(folded.events, query), query, this.secret);
		return {
			schemaVersion: 1,
			scope: query.scope,
			events: events.events,
			...(events.nextCursor === undefined ? {} : { nextCursor: events.nextCursor }),
			warnings: folded.warnings,
		};
	}

	auditQuery(input: AuditQuery): AuditQueryResult {
		return this.query(input);
	}

	replay(input: AuditReplayQuery | string, options: Omit<AuditReplayQuery, "runId"> = {}): AuditReplayResult {
		const replayQuery: AuditReplayQuery = typeof input === "string" ? { ...options, runId: input } : input;
		const query = normalizeReplayQuery(replayQuery, this.sessionId);
		const folded = this.fold() as InternalFoldResult;
		const runId = query.runId;
		if (runId === undefined) throw new ExecutionAuditError("audit_query_invalid");
		const run = folded.runSummaries.get(runId);
		if (run === undefined) throw new ExecutionAuditError("audit_run_not_found");
		const relevantEvents = filterEvents(folded.events, query).filter((event) => event.runId === runId);
		const page = paginate(relevantEvents, query, this.secret);
		const relevantWarnings = folded.internalWarnings
			.filter((item) => warningAffectsRun(item, runId))
			.map((item) => item.warning);
		const status: AuditReplayStatus =
			relevantWarnings.length > 0
				? "incomplete"
				: run.status === "completed" || run.status === "failed" || run.status === "cancelled"
					? "complete"
					: "interrupted";
		return {
			schemaVersion: 1,
			run,
			events: page.events,
			...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
			status,
			warnings: relevantWarnings,
		};
	}

	auditReplay(input: AuditReplayQuery | string, options: Omit<AuditReplayQuery, "runId"> = {}): AuditReplayResult {
		return this.replay(input, options);
	}
}

export const createExecutionAuditAdapter = (
	session: AuditSession,
	options?: ExecutionAuditAdapterOptions,
): ExecutionAuditAdapter => new ExecutionAuditAdapter(session, options);
