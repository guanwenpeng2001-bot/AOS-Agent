/**
 * Transport-neutral RPC and Automation Host controller.
 *
 * Used for embedding the agent in other applications. A transport supplies
 * commands and receives typed records through the output sink.
 *
 * Protocol:
 * - Commands: JSON objects with `type` field, optional `id` for correlation
 * - Responses: JSON objects with `type: "response"`, `command`, `success`, and optional `data`/`error`
 * - Events: AgentSessionEvent objects streamed as they occur
 * - Extension UI: Extension UI requests are emitted, client responds with extension_ui_response
 */

import * as crypto from "node:crypto";
import {
	AgentOperationError,
	type CanonicalRunResult,
	type FoundationError,
	fingerprintFoundationValue,
	LayeredResultSettlement,
	type Result as ResultValue,
	type ThinkingLevel,
} from "@aos-agent/agent-core";
import type { AuthInteraction, ImageContent } from "@aos-agent/ai";
import type { AgentSession, AgentSessionEvent, ExtensionBindings, SessionStats } from "../../core/agent-session.ts";
import { getAgentCanonicalSession, getAgentSessionLedger } from "../../core/agent-session-facade.ts";
import type { AgentSessionRuntime } from "../../core/agent-session-runtime.ts";
import { CapabilityError } from "../../core/capability-registry.ts";
import type { PreparedSessionScopeRebind } from "../../core/current-session-scope.ts";
import { ExecutionAuditError, projectSubagentAuditSource } from "../../core/execution-audit.ts";
import { ExecutionAuditQuery } from "../../core/execution-audit-query.ts";
import type { TaskCredentialGatePreflight } from "../../core/execution-policy.ts";
import { PolicyError } from "../../core/execution-policy.ts";
import type {
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionWidgetOptions,
	WorkingIndicatorOptions,
} from "../../core/extensions/index.ts";
import {
	type CanonicalExternalAgentArtifactReference,
	type CanonicalExternalAgentInput,
	type ExternalAgentArtifactInspection,
	gateCanonicalExternalAgentInputBeforeAcceptance,
} from "../../core/external-agent-input.ts";
import {
	type ExternalConnectorResolvedSelection,
	type ExternalConnectorSelection,
	isExternalConnectorSelection,
	serializeExternalConnectorSelection,
} from "../../core/external-agent-registry.ts";
import {
	type ExternalConnectorProductAdmission,
	executePreparedExternalConnectorProductRun,
	externalConnectorProductIdentity,
	persistExternalConnectorProductAdmissionBeforeAcceptance,
	persistExternalConnectorProductRunAfterAcceptance,
	preflightExternalConnectorProductRecovery,
	prepareExternalConnectorProductRun,
	recoverExternalConnectorProductRun,
} from "../../core/external-connector-product.ts";
import type { ExternalModelFallbackDecision } from "../../core/external-model-projection.ts";
import type { McpAttachment } from "../../core/mcp-attachment.ts";
import { MCP_OAUTH_DEFAULT_TIMEOUT_MS, MCPAuthError } from "../../core/mcp-auth.ts";
import { MCPAuthStorageError, type MCPCredentialStatus } from "../../core/mcp-auth-storage.ts";
import type { MCPGetPromptResult, MCPNormalizedContentBlock, MCPReadResourceResult } from "../../core/mcp-content.ts";
import { MCPContentError } from "../../core/mcp-content.ts";
import { mcpAuthErrorPublicCode, mcpContentErrorPublicCode } from "../../core/mcp-error-codes.ts";
import { MCPError, type MCPServerConfigView } from "../../core/mcp-types.ts";
import type {
	ModelResolution as BrokerModelResolution,
	ModelRoleSelection,
	ModelRouteSelection,
} from "../../core/model-broker.ts";
import { foldModelBrokerLedger, type ModelBindingLedgerRecord } from "../../core/model-broker-ledger.ts";
import type {
	AutomationError,
	PublicRunStreamEvent,
	RunFinalModelReference,
	RunHandle,
	RunId,
	RunLedgerSession,
	RunLifecycleCoordinator,
	RunModelReference,
	RunRequestLookup,
	RunReservation,
	RunResult,
	RunStreamEvent,
	RunUsageSnapshot,
} from "../../core/run-lifecycle.ts";
import {
	createAutomationError,
	createRunLifecycleCoordinator,
	createRunRequestFingerprint,
	foldCapabilityBindingEntries,
	isAutomationErrorCode,
	isRunClientRequestId,
	isRunTimestamp,
	isTerminalStatus,
	RUN_LEDGER_CUSTOM_TYPE,
	redactAutomationError,
	redactErrorText,
	serializePublicAutomationError,
	serializePublicCapabilityBinding,
	serializePublicContextDrift,
	serializePublicContextSnapshot,
	serializePublicRunReceipt,
	serializePublicRunRecord,
	serializePublicRunStreamEvent,
	serializePublicSessionEntry,
	serializePublicSessionEvent,
	serializePublicSessionTreeNode,
} from "../../core/run-lifecycle.ts";
import { loadEntriesFromFile, type SessionEntry } from "../../core/session-manager.ts";
import type { SourceInfo } from "../../core/source-info.ts";
import { CHILD_LIFECYCLE_STATUSES, type ChildLifecycleStatus } from "../../core/subagent.ts";
import type { SafeSubagentLifecycleProjection } from "../../core/subagent-composition.ts";
import {
	isTaskCredentialScope,
	serializeTaskCredentialDeliveryReceipt,
	serializeTaskCredentialGrant,
	TASK_CREDENTIAL_MAX_SCOPES,
	TASK_CREDENTIAL_MAX_TTL_MS,
	TASK_CREDENTIAL_MIN_TTL_MS,
	TASK_CREDENTIAL_STATUS,
	TaskCredentialError,
	type TaskCredentialScope,
	type TaskCredentialStatus,
} from "../../core/task-credential-lease.ts";
import type { TaskCredentialService } from "../../core/task-credential-service.ts";
import { createTaskGateStore, TaskGateError, type TaskGateStore } from "../../core/task-gate.ts";
import {
	createTaskGraphStore,
	TaskGraphError,
	type TaskGraphErrorCode,
	type TaskGraphNodeView,
	type TaskGraphRecord,
	type TaskGraphStore,
} from "../../core/task-graph.ts";
import {
	validateWorkerRecord,
	WORKER_LIFECYCLE_STATUSES,
	type WorkerLifecycleStatus,
	type WorkerRecord,
} from "../../core/worker.ts";
import { raceWithAbortSignal } from "../../utils/abort.ts";
import { type Theme, theme } from "../interactive/theme/theme.ts";
import { type JsonAgentSessionEvent, toJsonEvent } from "../json-event.ts";
import type {
	AuditQuery,
	AuditQueryData,
	AuditReplayData,
	AuditReplayQuery,
	GetCapabilitiesData,
	GetExecutionPolicyData,
	GetModelRoutesData,
	InitializeData,
	RpcAutomationCommandType,
	RpcAutomationResponse,
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcMcpAttachmentReceipt,
	RpcMcpAuthCommandType,
	RpcMcpAuthErrorCode,
	RpcMcpAuthListData,
	RpcMcpAuthResponse,
	RpcMcpAuthStartData,
	RpcMcpAuthStatusData,
	RpcMcpContentBlockSummary,
	RpcMcpContentCommandType,
	RpcMcpContentErrorCode,
	RpcMcpContentResponse,
	RpcMcpGetPromptReceipt,
	RpcMcpMaskedCredential,
	RpcMcpReadResourceReceipt,
	RpcResponse,
	RpcSchedulerResponse,
	RpcSessionState,
	RpcSessionStats,
	RpcSlashCommand,
	RpcSourceInfo,
	RpcSubagentCommandType,
	RpcSubagentErrorCode,
	RpcSubagentResponse,
	RpcTaskCredentialCommandType,
	RpcTaskGateCommandType,
	RpcTaskGraphCommandType,
	RpcWorkerCommandType,
	RpcWorkerErrorCode,
	RpcWorkerRecord,
	RpcWorkerResponse,
	RunAcceptedData,
	RunGetData,
	SchedulerStatusData,
	SubagentCancelData,
	SubagentGetData,
	SubagentListData,
	TaskCredentialGetData,
	TaskCredentialHeartbeatData,
	TaskCredentialIssueData,
	TaskCredentialListData,
	TaskCredentialRevokeData,
	TaskCredentialSettleData,
	TaskGraphGetData,
	TaskGraphListData,
	TaskGraphMutationData,
	WorkerGetData,
	WorkerListData,
	WorkerReclaimData,
} from "./rpc-types.ts";

/** Public records emitted by the transport-neutral RPC controller. */
export type RpcWireRecord =
	| RpcResponse
	| RpcAutomationResponse
	| RpcMcpAuthResponse
	| RpcMcpContentResponse
	| RpcWorkerResponse
	| RpcSubagentResponse
	| RpcSchedulerResponse
	| RpcExtensionUIRequest
	| JsonAgentSessionEvent
	| RpcHostRunStreamEvent
	| Exclude<PublicRunStreamEvent, { type: "run.event" }>
	| { type: "extension_error"; event: string; error: "Extension failed." };

/** Public run event with the same partial-message removal as the JSONL wire. */
export type RpcHostRunStreamEvent = Omit<Extract<PublicRunStreamEvent, { type: "run.event" }>, "event"> & {
	event: JsonAgentSessionEvent;
};

/** Compatibility name for the controller's wire record union. */
export type RpcHostOutputRecord = RpcWireRecord;

/** Output sink used by new transport adapters. */
export interface RpcOutputSink {
	send(record: RpcWireRecord): Promise<void>;
	close(): Promise<void>;
}

/** Legacy sink shape retained for existing stdio and in-memory callers. */
export interface RpcHostOutputSink {
	publish(record: RpcHostOutputRecord): void;
	waitForBackpressure?: () => Promise<void>;
}

export interface RpcHostControllerOptions {
	/** Legacy constructor sink; new callers should use attach(). */
	output?: RpcHostOutputSink | RpcOutputSink;
	/** Called after the runtime has been disposed by an internal shutdown request. */
	onShutdown?: () => void;
	/** Trusted Host-only authority for dereferencing canonical External Connector artifacts. */
	externalArtifactAuthority?: {
		readonly workspaceId: string;
		inspectArtifact(
			reference: CanonicalExternalAgentArtifactReference,
		): ExternalAgentArtifactInspection | Promise<ExternalAgentArtifactInspection>;
	};
}

/** Minimal authoritative Worker registry seam supplied by Host composition. */
export interface RpcWorkerRegistry {
	getWorkerRecord(workerId: string): WorkerRecord | undefined;
	listWorkerRecords(): readonly WorkerRecord[];
	reclaimWorker(workerId: string): Promise<ResultValue<WorkerRecord, FoundationError>>;
}

export interface RpcSubagentRegistry {
	get(
		runId: string,
		childAgentInstanceId: string,
	): Promise<ResultValue<SafeSubagentLifecycleProjection | undefined, FoundationError>>;
	list(
		runId: string,
		filter: {
			readonly parentAgentInstanceId?: string;
			readonly status?: ChildLifecycleStatus;
			readonly limit: number;
		},
	): Promise<ResultValue<readonly SafeSubagentLifecycleProjection[], FoundationError>>;
	cancel(
		runId: string,
		childAgentInstanceId: string,
	): Promise<ResultValue<SafeSubagentLifecycleProjection | undefined, FoundationError>>;
}

type RpcOutputSinkLike = RpcHostOutputSink | RpcOutputSink;

/**
 * Adapt the current publish/backpressure sink to the new promise-based output
 * contract. The adapter keeps send calls ordered by the transport's own writer
 * and makes dispatch wait for all records queued by a command.
 */
function adaptOutputSink(sink: RpcOutputSinkLike): RpcHostOutputSink {
	if ("send" in sink) {
		const pending = new Set<Promise<void>>();
		return {
			publish(record: RpcHostOutputRecord): void {
				let write: Promise<void>;
				try {
					write = sink.send(record);
				} catch (error: unknown) {
					write = Promise.reject(error);
				}
				pending.add(write);
				void write.then(
					() => pending.delete(write),
					() => pending.delete(write),
				);
			},
			async waitForBackpressure(): Promise<void> {
				await Promise.all([...pending]);
			},
		};
	}
	return sink;
}

// Re-export types for consumers
export type {
	AuditEvent,
	AuditEventType,
	AuditQuery,
	AuditQueryData,
	AuditQueryResult,
	AuditReplayData,
	AuditReplayQuery,
	AuditReplayResult,
	AuditWarning,
	AutomationError,
	AutomationErrorCode,
	CapabilityBindingView,
	GetCapabilitiesData,
	GetExecutionPolicyData,
	GetModelRoutesData,
	InitializeData,
	RpcAuditCommandType,
	RpcAuditQueryCommand,
	RpcAuditReplayCommand,
	RpcAutomationCommandType,
	RpcAutomationResponse,
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcMcpAttachmentReceipt,
	RpcMcpAuthCommandType,
	RpcMcpAuthError,
	RpcMcpAuthErrorCode,
	RpcMcpAuthListData,
	RpcMcpAuthResponse,
	RpcMcpAuthStartStatus,
	RpcMcpAuthStatusData,
	RpcMcpAuthStatusValue,
	RpcMcpContentBlockSummary,
	RpcMcpGetPromptReceipt,
	RpcMcpMaskedCredential,
	RpcMcpReadResourceReceipt,
	RpcResponse,
	RpcRunCommandType,
	RpcSchedulerCommandType,
	RpcSchedulerResponse,
	RpcSessionState,
	RpcTaskCredentialCommandType,
	RpcTaskGateCommandType,
	RpcTaskGraphCommandType,
	RpcWorkerCommandType,
	RpcWorkerError,
	RpcWorkerErrorCode,
	RpcWorkerRecord,
	RpcWorkerResponse,
	RunAcceptedData,
	RunCancelData,
	RunGetData,
	RunReceipt,
	RunRecord,
	RunRecoveryState,
	RunStatus,
	RunStreamEvent,
	RunTerminalStatus,
	SchedulerStatusData,
	SubagentCancelData,
	SubagentGetData,
	SubagentListData,
	TaskCredentialGetData,
	TaskCredentialHeartbeatData,
	TaskCredentialIssueData,
	TaskCredentialListData,
	TaskCredentialRevokeData,
	TaskCredentialSettleData,
	TaskGraphGetData,
	TaskGraphListData,
	TaskGraphMutationData,
	WorkerGetData,
	WorkerListData,
	WorkerReclaimData,
} from "./rpc-types.ts";

function serializePublicSessionStats(stats: SessionStats): RpcSessionStats {
	const { sessionFile: _sessionFile, ...publicStats } = stats;
	return publicStats;
}

function serializePublicSourceInfo(sourceInfo: SourceInfo): RpcSourceInfo {
	return { scope: sourceInfo.scope, origin: sourceInfo.origin };
}

const RPC_WORKER_DEFAULT_LIMIT = 50;
const RPC_WORKER_MAX_LIMIT = 100;
const RPC_WORKER_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const RPC_WORKER_RECLAIMABLE_STATUSES: ReadonlySet<WorkerLifecycleStatus> = new Set([
	"completed",
	"failed",
	"cancelled",
	"lost",
	"reclaiming",
	"reclaimed",
	"reclaim_unknown",
]);
const RPC_WORKER_RECLAIM_TERMINAL_STATUSES: ReadonlySet<WorkerLifecycleStatus> = new Set([
	"reclaimed",
	"reclaim_unknown",
]);
const RPC_WORKER_COMMAND_KEYS: Readonly<Record<RpcWorkerCommandType, ReadonlySet<string>>> = {
	"worker.get": new Set(["id", "type", "workerId"]),
	"worker.list": new Set(["id", "type", "runId", "status", "limit", "cursor"]),
	"worker.reclaim": new Set(["id", "type", "workerId"]),
};
const RPC_WORKER_ERROR_MESSAGES: Readonly<Record<RpcWorkerErrorCode, string>> = {
	host_not_initialized: "Automation Host is not initialized. Send initialize with protocolVersion 1 first.",
	worker_invalid: "The Worker request is invalid.",
	worker_not_found: "The Worker was not found in the current Session.",
	worker_unavailable: "The Worker registry is unavailable in the current Session.",
	worker_conflict: "The Worker cannot be reclaimed in its current state.",
	worker_reclaim_failed: "The Worker reclaim outcome is unknown.",
};
const RPC_SUBAGENT_DEFAULT_LIMIT = 50;
const RPC_SUBAGENT_MAX_LIMIT = 100;
const RPC_SUBAGENT_COMMAND_KEYS: Readonly<Record<RpcSubagentCommandType, ReadonlySet<string>>> = {
	"subagent.get": new Set(["id", "type", "runId", "childAgentInstanceId"]),
	"subagent.list": new Set(["id", "type", "runId", "parentAgentInstanceId", "status", "limit"]),
	"subagent.cancel": new Set(["id", "type", "runId", "childAgentInstanceId"]),
};
const RPC_SUBAGENT_ERROR_MESSAGES: Readonly<Record<RpcSubagentErrorCode, string>> = {
	host_not_initialized: "Automation Host is not initialized. Send initialize with protocolVersion 1 first.",
	subagent_invalid: "The Subagent request is invalid.",
	subagent_not_found: "The Subagent was not found in the requested active Run and current Session.",
	subagent_unavailable: "The Subagent authority is unavailable in the current Session.",
	subagent_cancel_failed: "The Subagent cancellation was not confirmed by the Run Supervisor.",
};

function rpcSubagentError(
	id: string | undefined,
	command: RpcSubagentCommandType,
	code: RpcSubagentErrorCode,
): RpcSubagentResponse {
	return {
		id,
		type: "response",
		command,
		success: false,
		error: {
			code,
			message: RPC_SUBAGENT_ERROR_MESSAGES[code],
			retryable: code === "subagent_unavailable" || code === "subagent_cancel_failed",
		},
	};
}

function isRpcSubagentCommandShapeValid(command: RpcCommand): boolean {
	const allowed = RPC_SUBAGENT_COMMAND_KEYS[command.type as RpcSubagentCommandType];
	return (
		allowed !== undefined &&
		(command.id === undefined || typeof command.id === "string") &&
		Object.keys(command).every((key) => allowed.has(key))
	);
}

function isRpcSubagentStatus(value: unknown): value is ChildLifecycleStatus {
	return typeof value === "string" && (CHILD_LIFECYCLE_STATUSES as readonly string[]).includes(value);
}

function rpcSchedulerError(
	id: string | undefined,
	code: "host_not_initialized" | "scheduler_unavailable",
): RpcSchedulerResponse {
	return {
		id,
		type: "response",
		command: "scheduler.status",
		success: false,
		error: {
			code,
			message:
				code === "host_not_initialized"
					? "Automation Host is not initialized. Send initialize with protocolVersion 1 first."
					: "The trusted Scheduler is unavailable in the current Session.",
			retryable: false,
		},
	};
}

function isRpcWorkerIdentifier(value: unknown): value is string {
	return typeof value === "string" && RPC_WORKER_IDENTIFIER_PATTERN.test(value);
}

function isRpcWorkerCommandShapeValid(command: RpcCommand): boolean {
	const allowed = RPC_WORKER_COMMAND_KEYS[command.type as RpcWorkerCommandType];
	return (
		allowed !== undefined &&
		(command.id === undefined || typeof command.id === "string") &&
		Object.keys(command).every((key) => allowed.has(key))
	);
}

function isRpcWorkerStatus(value: unknown): value is WorkerLifecycleStatus {
	return typeof value === "string" && (WORKER_LIFECYCLE_STATUSES as readonly string[]).includes(value);
}

function isRpcWorkerRecord(value: unknown): value is WorkerRecord {
	try {
		return validateWorkerRecord(value);
	} catch {
		return false;
	}
}

function isRpcWorkerRecordList(value: unknown): value is readonly WorkerRecord[] {
	return Array.isArray(value) && value.every(isRpcWorkerRecord);
}

function toRpcWorkerRecord(record: WorkerRecord): RpcWorkerRecord {
	return {
		schemaVersion: record.schemaVersion,
		workerId: record.workerId,
		providerId: record.providerId,
		sessionId: record.sessionId,
		laneId: record.laneId,
		...(record.runId === undefined ? {} : { runId: record.runId }),
		...(record.bindingId === undefined ? {} : { bindingId: record.bindingId }),
		...(record.bindingEpochId === undefined ? {} : { bindingEpochId: record.bindingEpochId }),
		...(record.attemptId === undefined ? {} : { attemptId: record.attemptId }),
		profileId: record.profileId,
		status: record.status,
		revision: record.revision,
		createdAt: record.createdAt,
		...(record.readyAt === undefined ? {} : { readyAt: record.readyAt }),
		...(record.endedAt === undefined ? {} : { endedAt: record.endedAt }),
		...(record.lastHeartbeatAt === undefined ? {} : { lastHeartbeatAt: record.lastHeartbeatAt }),
		...(record.activeOperationId === undefined ? {} : { activeOperationId: record.activeOperationId }),
	};
}

function rpcWorkerError(
	id: string | undefined,
	command: RpcWorkerCommandType,
	code: RpcWorkerErrorCode,
): RpcWorkerResponse {
	return {
		id,
		type: "response",
		command,
		success: false,
		error: { code, message: RPC_WORKER_ERROR_MESSAGES[code], retryable: false },
	};
}

function isRpcResult(value: unknown): value is ResultValue<unknown, unknown> {
	return typeof value === "object" && value !== null && "ok" in value && typeof value.ok === "boolean";
}

/** Redacted block summary: text and image payloads never cross the RPC wire. */
function toRpcMcpContentBlockSummary(block: MCPNormalizedContentBlock): RpcMcpContentBlockSummary {
	switch (block.kind) {
		case "text":
			return { kind: "text", bytes: block.bytes, digest: block.digest };
		case "image":
			return { kind: "image", bytes: block.bytes, digest: block.digest, mimeType: block.mimeType };
		case "unattached":
			return {
				kind: "unattached",
				bytes: block.bytes,
				digest: block.digest,
				reason: block.reason,
				...(block.mimeType !== undefined ? { mimeType: block.mimeType } : {}),
				...(block.size !== undefined ? { size: block.size } : {}),
			};
	}
}

/** Redacted read receipt; the raw URI and remote text are never echoed. */
function toRpcMcpReadResourceReceipt(result: MCPReadResourceResult): RpcMcpReadResourceReceipt {
	return {
		serverId: result.serverId,
		resourceId: result.resourceId,
		blocks: result.contents.map((block) => toRpcMcpContentBlockSummary(block)),
		provenance: result.provenance,
	};
}

/** Redacted get receipt; the prompt name, args, and remote text are never echoed. */
function toRpcMcpGetPromptReceipt(result: MCPGetPromptResult): RpcMcpGetPromptReceipt {
	return {
		serverId: result.serverId,
		promptId: result.promptId,
		messages: result.messages.map((message) => ({
			role: message.role,
			blocks: message.blocks.map((block) => toRpcMcpContentBlockSummary(block)),
			digest: message.digest,
		})),
		provenance: result.provenance,
	};
}

/** Redacted attachment receipt; the remote text never crosses the wire. */
function toRpcMcpAttachmentReceipt(attachment: McpAttachment): RpcMcpAttachmentReceipt {
	return {
		id: attachment.id,
		kind: attachment.kind,
		serverId: attachment.serverId,
		sourceId: attachment.sourceId,
		provenance: attachment.provenance,
		contentDigest: attachment.contentDigest,
		byteCount: attachment.byteCount,
		blockCount: attachment.blockCount,
		attachableBlockCount: attachment.attachableBlocks.length,
		capabilityBindingId: attachment.capabilityBindingId,
		policyBindingId: attachment.policyBindingId,
		createdAt: attachment.createdAt,
	};
}

/**
 * Read a target Session's existing automation ledger without opening it through
 * SessionManager. Resume idempotency must inspect durable state before
 * switchSession() runs any recovery side effects.
 */
function loadReadOnlyRunCoordinator(sessionPath: string):
	| {
			sessionId: string;
			coordinator: RunLifecycleCoordinator;
			getRunByClientRequestId(clientRequestId: string, scope: "start" | "resume"): RunRequestLookup | undefined;
	  }
	| undefined {
	let fileEntries: ReturnType<typeof loadEntriesFromFile>;
	try {
		fileEntries = loadEntriesFromFile(sessionPath);
	} catch {
		// The ordinary resume path remains authoritative for malformed/unavailable
		// targets. This helper is only a pre-switch idempotency lookup.
		return undefined;
	}
	const header = fileEntries[0];
	if (header === undefined || header.type !== "session" || typeof header.id !== "string") return undefined;
	const sessionEntries: SessionEntry[] = [];
	for (const entry of fileEntries) {
		if (entry.type !== "session") sessionEntries.push(entry);
	}
	const readOnlySession: RunLedgerSession = {
		getSessionId: () => header.id,
		getSessionFile: () => sessionPath,
		appendCustomEntry: () => {
			throw new Error("read-only run ledger");
		},
		getEntries: () => sessionEntries,
	};
	const coordinator = createRunLifecycleCoordinator(readOnlySession, { diagnostics: () => {} });
	// Force the complete canonical/legacy fold before returning a coordinator.
	// Conflicts propagate to run.resume instead of degrading to path idempotency.
	coordinator.rebuildIndex();
	return {
		sessionId: header.id,
		coordinator,
		getRunByClientRequestId: (clientRequestId, scope) => {
			for (const entry of sessionEntries) {
				if (
					entry.type !== "custom" ||
					entry.customType !== "__aos.foundation.entry.v1" ||
					typeof entry.data !== "object" ||
					entry.data === null ||
					!("entry" in entry.data) ||
					typeof entry.data.entry !== "object" ||
					entry.data.entry === null
				)
					continue;
				const projected = entry.data.entry as Record<string, unknown>;
				if (
					projected.type !== "custom" ||
					projected.customType !== RUN_LEDGER_CUSTOM_TYPE ||
					typeof projected.data !== "object" ||
					projected.data === null
				)
					continue;
				const envelope = projected.data as Record<string, unknown>;
				if (envelope.kind !== "accepted" || typeof envelope.record !== "object" || envelope.record === null)
					continue;
				const record = envelope.record as Record<string, unknown>;
				if (
					record.clientRequestId !== clientRequestId ||
					record.requestScope !== scope ||
					typeof record.requestFingerprint !== "string" ||
					typeof record.id !== "string"
				)
					continue;
				const result = coordinator.getRun(record.id);
				if (result === undefined) continue;
				return {
					clientRequestId,
					scope,
					fingerprint: record.requestFingerprint,
					result,
				};
			}
			return undefined;
		},
	};
}

function hashResumeTargetPath(sessionPath: string): string {
	return `path:${crypto.createHash("sha256").update(sessionPath, "utf8").digest("hex")}`;
}

/**
 * Owns the RPC and Automation Host command/lifecycle state independently of
 * the transport used to deliver commands or records.
 */
export class RpcHostController {
	private readonly runtimeHost: AgentSessionRuntime;
	private outputSink: RpcHostOutputSink | undefined;
	private readonly onShutdown?: () => void;
	private readonly externalArtifactAuthority?: NonNullable<RpcHostControllerOptions["externalArtifactAuthority"]>;
	private commandHandler?: (
		command: RpcCommand,
	) => Promise<
		| RpcResponse
		| RpcAutomationResponse
		| RpcMcpAuthResponse
		| RpcMcpContentResponse
		| RpcWorkerResponse
		| RpcSubagentResponse
		| RpcSchedulerResponse
		| undefined
	>;
	private extensionResponseHandler?: (response: RpcExtensionUIResponse) => void;
	private shutdownHandler?: () => Promise<void>;
	private detachTransportHandler?: () => Promise<void>;
	private transportDetachPromise?: Promise<void>;
	private outputAttachment?: { readonly id: number; readonly sink: RpcHostOutputSink };
	private nextOutputAttachmentId = 0;
	private shuttingDown = false;

	constructor(runtimeHost: AgentSessionRuntime, options: RpcHostControllerOptions = {}) {
		this.runtimeHost = runtimeHost;
		this.outputSink = options.output === undefined ? undefined : adaptOutputSink(options.output);
		this.onShutdown = options.onShutdown;
		this.externalArtifactAuthority = options.externalArtifactAuthority;
	}

	private inspectExternalArtifact(
		reference: CanonicalExternalAgentArtifactReference,
	): ExternalAgentArtifactInspection | Promise<ExternalAgentArtifactInspection> {
		const authority = this.externalArtifactAuthority;
		if (authority === undefined) throw new Error("RPC has no trusted artifact reference authority");
		if (
			reference.readHandle.kind === "workspace_relative" &&
			reference.readHandle.workspaceId !== authority.workspaceId
		) {
			return {
				artifactId: reference.artifactId,
				ref: reference.readHandle.ref,
				digest: reference.digest,
				mediaType: reference.mediaType,
				sizeBytes: reference.sizeBytes,
				trusted: true,
				workspaceContained: false,
			};
		}
		return authority.inspectArtifact(reference);
	}

	/**
	 * Attach a live output sink. Records emitted after a previous attachment is
	 * detached are dropped until the new attachment is active; no live records
	 * are replayed to the new sink.
	 */
	attach(sink: RpcOutputSink): () => void;
	attach(sink: RpcHostOutputSink): () => void;
	attach(sink: RpcOutputSinkLike): () => void {
		return this.attachSink(sink);
	}

	private attachSink(sink: RpcOutputSinkLike): () => void {
		const attachment = { id: ++this.nextOutputAttachmentId, sink: adaptOutputSink(sink) };
		this.outputAttachment = attachment;
		const detachInProgress = this.transportDetachPromise;
		if (detachInProgress === undefined) {
			this.outputSink = attachment.sink;
		} else {
			this.outputSink = undefined;
			const activate = (): void => {
				if (this.outputAttachment === attachment) this.outputSink = attachment.sink;
			};
			void detachInProgress.then(activate, activate);
		}

		let detached = false;
		return (): void => {
			if (detached) return;
			detached = true;
			if (this.outputAttachment !== attachment) return;
			this.outputAttachment = undefined;
			this.outputSink = undefined;
			void this.detachTransport().catch(() => {
				// The transport owns reporting detach failures; the unbind callback is synchronous.
			});
		};
	}

	/** Bind the current session and make the controller ready for commands. */
	async start(): Promise<void> {
		const hostController = this;
		const runtimeHost = this.runtimeHost;
		let hostInitialized = false;
		type RunRequestIdentity = {
			scopeSessionId: string;
			clientRequestId: string;
			fingerprint: string;
			key: string;
			claimToken?: object;
		};
		type PendingRunRequest = {
			fingerprint: string;
			claimToken: object;
			waiters: Array<{ id: string | undefined; command: "run.start" | "run.resume" }>;
		};
		type RunRequestGate =
			| { kind: "none" }
			| { kind: "new"; identity: RunRequestIdentity }
			| { kind: "pending" }
			| { kind: "response"; response: RpcAutomationResponse };
		interface ExternalPendingStartControl {
			runId?: RunId;
			requestClaim?: RunRequestIdentity;
			deadlineController?: AbortController;
			lifecycleController?: AbortController;
			accepted?: boolean;
		}
		interface RpcSessionBinding {
			session: AgentSession;
			coordinator?: RunLifecycleCoordinator;
			taskGateStore?: TaskGateStore;
			taskGraphStore?: TaskGraphStore;
			taskCredentialService?: TaskCredentialService;
			activeHandle?: RunHandle;
			activeReservation?: RunReservation;
			runPromptPromises: Map<RunId, Promise<void>>;
			terminalEventRunIds: Set<RunId>;
			runDeadlineTimers: Map<RunId, ReturnType<typeof setTimeout>>;
			externalRuns: Map<RunId, { cancel: () => Promise<void> }>;
			externalRunSettlements: Map<RunId, Promise<void>>;
			runAbortControllers: Map<RunId, AbortController>;
			externalPendingControllers: Map<RunId, AbortController>;
			pendingExternalStarts: Map<RunId, Promise<RpcAutomationResponse | undefined>>;
			unsubscribe?: () => void;
			unsubscribeBackpressure?: () => void;
		}
		const createSessionBinding = (session: AgentSession): RpcSessionBinding => ({
			session,
			runPromptPromises: new Map(),
			terminalEventRunIds: new Set(),
			runDeadlineTimers: new Map(),
			externalRuns: new Map(),
			externalRunSettlements: new Map(),
			runAbortControllers: new Map(),
			externalPendingControllers: new Map(),
			pendingExternalStarts: new Map(),
		});
		const sessionBindings = new Map<AgentSession, RpcSessionBinding>();
		const initialBinding = createSessionBinding(runtimeHost.session);
		sessionBindings.set(runtimeHost.session, initialBinding);
		const captureCurrentBinding = (): RpcSessionBinding => {
			const session = runtimeHost.session;
			const binding = sessionBindings.get(session);
			if (binding === undefined) throw new Error("RPC host has no binding for the current runtime scope");
			return binding;
		};
		const pendingRunRequests = new Map<string, PendingRunRequest>();

		// Automation Host state
		const pendingStartPromises = new Set<Promise<RpcAutomationResponse | undefined>>();
		/**
		 * Active external agent executions keyed by runId. Cancel is forwarded to
		 * the current Connector's same-Attempt cancel path.
		 */
		/** Host deadline controllers keyed by runId; ordinary lifecycle cancellation never aborts them. */
		/** Lifecycle-only controllers registered before current Connector admission begins. */
		/**
		 * Pending external start promises keyed by runId. Lifecycle transitions
		 * must never await them: a driver or preflight that ignores the abort
		 * signal would block detach/rebind forever. They are aborted best-effort
		 * and their continuation fails closed on the generation/epoch guards.
		 */
		let transportEpoch = 0;
		/**
		 * Host-side signal bound to the lifetime of the current transport
		 * attachment. MCP content commands pass it into the session operations so
		 * a detach/shutdown aborts the in-flight server/session MCP operation
		 * (the lifecycle signal contract rejects on abort without degrading the
		 * server). Cancellation is bounded: aborting is synchronous and in-flight
		 * commands are never awaited; each fails closed on its own abort path.
		 */
		let mcpOperationController = new AbortController();
		const abortMcpOperations = (): void => {
			mcpOperationController.abort();
			mcpOperationController = new AbortController();
		};
		let detachTransportPromise: Promise<void> | undefined;

		const waitForOutput = async (): Promise<void> => {
			await this.outputSink?.waitForBackpressure?.();
		};
		const output = (record: RpcHostOutputRecord): void => {
			this.outputSink?.publish(record);
		};

		const success = <T extends RpcCommand["type"]>(
			id: string | undefined,
			command: T,
			data?: object | null,
		): RpcResponse => {
			if (data === undefined) {
				return { id, type: "response", command, success: true } as RpcResponse;
			}
			return { id, type: "response", command, success: true, data } as RpcResponse;
		};

		const error = (id: string | undefined, command: string, message: string): RpcResponse => {
			return { id, type: "response", command, success: false, error: redactErrorText(message) };
		};

		// ---------------------------------------------------------------------
		// MCP OAuth (mcp.auth.*) helpers
		// ---------------------------------------------------------------------

		/** Fixed, fail-closed message templates; never raw error text, tokens, or URLs. */
		const MCP_AUTH_ERROR_MESSAGES: Record<RpcMcpAuthErrorCode, string> = {
			mcp_auth_interaction_required:
				"MCP OAuth authorization requires an explicit interaction; this call is headless.",
			mcp_auth_not_configured: "MCP OAuth is not configured for this session.",
			mcp_auth_stdio_not_applicable: 'MCP server "%s" uses stdio and does not support OAuth.',
			mcp_auth_invalid_request: "The MCP OAuth request is invalid.",
			mcp_auth_metadata_invalid: 'MCP server "%s" OAuth metadata could not be validated.',
			mcp_auth_resource_mismatch: 'MCP server "%s" OAuth resource does not match the server endpoint.',
			mcp_auth_state_mismatch: 'MCP server "%s" authorization callback state did not match.',
			mcp_auth_invalid: 'MCP server "%s" OAuth credentials are invalid.',
			mcp_auth_cancelled: 'MCP server "%s" authorization was cancelled.',
			mcp_auth_storage_invalid_server_url: 'MCP server "%s" OAuth credential URL is invalid.',
			mcp_auth_storage_invalid_tokens: 'MCP server "%s" OAuth tokens are invalid.',
			mcp_auth_storage_invalid_scope: 'MCP server "%s" OAuth scope is invalid.',
			mcp_auth_storage_binding_mismatch: 'MCP server "%s" OAuth credential binding does not match.',
			mcp_auth_storage_namespace_collision: "MCP OAuth credential namespace is unavailable.",
			mcp_auth_capability_denied: 'MCP server "%s" is not authorized by the capability binding.',
			mcp_auth_not_selected: 'MCP server "%s" is not selected for this binding.',
			mcp_auth_invalid_config: 'MCP server "%s" has no valid configuration.',
			mcp_auth_policy_denied: 'MCP server "%s" authorization is denied by the execution policy.',
			mcp_auth_aborted: "The MCP OAuth request was aborted.",
		};

		const mcpAuthErrorResponse = (
			id: string | undefined,
			command: RpcMcpAuthCommandType,
			code: RpcMcpAuthErrorCode,
			serverId: string,
		): RpcMcpAuthResponse => ({
			id,
			type: "response",
			command,
			success: false,
			error: { code, message: MCP_AUTH_ERROR_MESSAGES[code].replace("%s", serverId) },
		});

		const isAbortError = (candidate: unknown): candidate is DOMException =>
			candidate instanceof DOMException && candidate.name === "AbortError";

		/**
		 * Map any MCP OAuth failure to a stable wire code. Only code-derived
		 * fixed messages are ever used; raw error text never crosses the wire.
		 */
		const mcpAuthFailureCode = (err: unknown): RpcMcpAuthErrorCode => {
			if (err instanceof MCPAuthError) {
				return mcpAuthErrorPublicCode(err.kind);
			}
			if (err instanceof MCPAuthStorageError) {
				switch (err.code) {
					case "invalid_server_url":
						return "mcp_auth_storage_invalid_server_url";
					case "invalid_tokens":
						return "mcp_auth_storage_invalid_tokens";
					case "invalid_scope":
						return "mcp_auth_storage_invalid_scope";
					case "binding_mismatch":
						return "mcp_auth_storage_binding_mismatch";
					case "namespace_collision":
						return "mcp_auth_storage_namespace_collision";
				}
			}
			if (err instanceof MCPError) {
				switch (err.kind) {
					case "invalid_config":
						return "mcp_auth_invalid_config";
					case "not_selected":
						return "mcp_auth_not_selected";
					default:
						return "mcp_auth_invalid";
				}
			}
			if (err instanceof CapabilityError) {
				return "mcp_auth_capability_denied";
			}
			if (err instanceof PolicyError) {
				return "mcp_auth_policy_denied";
			}
			if (isAbortError(err)) {
				return "mcp_auth_aborted";
			}
			return "mcp_auth_invalid";
		};

		const mcpAuthFailure = (
			id: string | undefined,
			command: RpcMcpAuthCommandType,
			err: unknown,
			serverId: string,
		): RpcMcpAuthResponse => mcpAuthErrorResponse(id, command, mcpAuthFailureCode(err), serverId);

		/**
		 * Fixed reject for stdio servers: OAuth never applies to a stdio
		 * config. Unknown server ids pass through (the credential namespace is
		 * bound to the canonical URL, not to registration).
		 */
		const mcpAuthStdioError = (
			binding: RpcSessionBinding,
			id: string | undefined,
			command: RpcMcpAuthCommandType,
			serverId: string,
		): RpcMcpAuthResponse | undefined => {
			const view: MCPServerConfigView | undefined = binding.session.getMcpServerConfigView(serverId);
			if (view !== undefined && view.transport === "stdio") {
				return mcpAuthErrorResponse(id, command, "mcp_auth_stdio_not_applicable", serverId);
			}
			return undefined;
		};

		/** Redacted credential status: token values, URL, issuer/resource never cross the wire. */
		const toRpcMcpMaskedCredential = (credential: MCPCredentialStatus): RpcMcpMaskedCredential => ({
			serverIdentity: credential.serverIdentity,
			status: credential.status === "expired" ? "expired" : "authenticated",
		});

		// ---------------------------------------------------------------------
		// MCP content (mcp.resource.* / mcp.prompt.*) error helpers
		// ---------------------------------------------------------------------

		/** Fixed, fail-closed message templates; never raw error text, URIs, or prompt args. */
		const MCP_CONTENT_ERROR_MESSAGES: Record<RpcMcpContentErrorCode, string> = {
			mcp_content_malformed: 'MCP server "%s" returned malformed content',
			mcp_content_oversize: 'MCP server "%s" returned content over the safety limits',
			mcp_content_unsupported: 'MCP server "%s" returned unsupported content',
			mcp_content_encoding: 'MCP server "%s" returned content with an invalid encoding',
			mcp_content_mime: 'MCP server "%s" returned content with an invalid MIME type',
			mcp_content_invalid: 'MCP server "%s" returned content that does not match the MCP contract',
			mcp_content_limit_exceeded: 'MCP server "%s" returned content over the safety limits',
			mcp_resource_unavailable: 'MCP server "%s" does not support resources',
			mcp_prompt_unavailable: 'MCP server "%s" does not support prompts',
			mcp_resource_denied: 'MCP server "%s" resource access is denied',
			mcp_prompt_denied: 'MCP server "%s" prompt access is denied',
			mcp_not_selected: 'MCP server "%s" is not selected for this binding',
			mcp_invalid_config: 'MCP server "%s" has an invalid configuration',
			mcp_connect_failed: 'Failed to connect to MCP server "%s"',
			mcp_auth_required: 'MCP server "%s" requires authentication',
			mcp_unavailable: 'MCP server "%s" is unavailable',
			mcp_capability_denied: 'MCP server "%s" is not authorized by the capability binding',
			mcp_policy_denied: 'MCP server "%s" is denied by the execution policy',
			mcp_aborted: "The MCP content request was aborted",
		};

		const mcpContentErrorResponse = (
			id: string | undefined,
			command: RpcMcpContentCommandType,
			code: RpcMcpContentErrorCode,
			serverId: string,
		): RpcMcpContentResponse => ({
			id,
			type: "response",
			command,
			success: false,
			error: { code, message: MCP_CONTENT_ERROR_MESSAGES[code].replace("%s", serverId) },
		});

		/**
		 * Map any MCP content failure to a stable wire code. Content-safety
		 * failures surface the PR contract codes (`mcp_content_invalid`,
		 * `mcp_content_limit_exceeded`) mapped from the fine-grained core code;
		 * capability denials surface the operation-specific denial code. Only
		 * code-derived fixed messages are ever used; raw remote text never
		 * crosses the wire.
		 */
		const mcpContentFailureCode = (err: unknown, command: RpcMcpContentCommandType): RpcMcpContentErrorCode => {
			if (err instanceof MCPContentError) {
				return mcpContentErrorPublicCode(err.code);
			}
			if (err instanceof MCPError) {
				switch (err.kind) {
					case "not_selected":
						return "mcp_not_selected";
					case "invalid_config":
						return "mcp_invalid_config";
					case "connect_failed":
						return "mcp_connect_failed";
					case "auth_required":
						return "mcp_auth_required";
					case "call_failed":
					case "unavailable":
						return "mcp_unavailable";
				}
			}
			if (err instanceof CapabilityError) {
				// PR contract: a denied resource/prompt descriptor or operation
				// surfaces the operation-specific denial code.
				return command.startsWith("mcp.prompt.") ? "mcp_prompt_denied" : "mcp_resource_denied";
			}
			if (err instanceof PolicyError) {
				return "mcp_policy_denied";
			}
			if (isAbortError(err)) {
				return "mcp_aborted";
			}
			return "mcp_unavailable";
		};

		const mcpContentFailure = (
			id: string | undefined,
			command: RpcMcpContentCommandType,
			err: unknown,
			serverId: string,
		): RpcMcpContentResponse => mcpContentErrorResponse(id, command, mcpContentFailureCode(err, command), serverId);

		// Pending extension UI requests waiting for response
		const pendingExtensionRequests = new Map<
			string,
			{ resolve: (value: RpcExtensionUIResponse) => void; reject: (error: Error) => void }
		>();

		const rejectPendingExtensionRequests = (): void => {
			if (pendingExtensionRequests.size === 0) return;
			const pending = [...pendingExtensionRequests.values()];
			pendingExtensionRequests.clear();
			const error = new Error("The RPC connection closed before the extension UI response was received.");
			for (const request of pending) request.reject(error);
		};

		// Shutdown request flag
		let shutdownRequested = false;
		let shuttingDown = false;

		// ---------------------------------------------------------------------
		// Automation Host helpers
		// ---------------------------------------------------------------------

		/** Legacy commands that mutate session/model/run state; rejected once the host is initialized. */
		const HOST_MUTATING_COMMANDS = new Set<string>([
			"prompt",
			"steer",
			"follow_up",
			"abort",
			"new_session",
			"switch_session",
			"set_model",
			"cycle_model",
			"set_thinking_level",
			"cycle_thinking_level",
			"set_steering_mode",
			"set_follow_up_mode",
			"compact",
			"set_auto_compaction",
			"set_auto_retry",
			"abort_retry",
			"bash",
			"abort_bash",
			"export_html",
			"fork",
			"clone",
			"set_session_name",
			"mcp.resource.attach",
			"mcp.prompt.attach",
		]);

		const automationError = (
			id: string | undefined,
			command: RpcAutomationCommandType,
			err: AutomationError,
		): RpcAutomationResponse => ({
			id,
			type: "response",
			command,
			success: false,
			error: serializePublicAutomationError(redactAutomationError(err), "Automation request failed."),
		});

		type AuditAutomationCode =
			| "audit_query_invalid"
			| "audit_cursor_invalid"
			| "audit_scope_unavailable"
			| "audit_run_not_found"
			| "audit_replay_incomplete";

		const isAuditAutomationCode = (value: unknown): value is AuditAutomationCode =>
			value === "audit_query_invalid" ||
			value === "audit_cursor_invalid" ||
			value === "audit_scope_unavailable" ||
			value === "audit_run_not_found" ||
			value === "audit_replay_incomplete";
		const AUDIT_QUERY_COMMAND_KEYS = new Set([
			"id",
			"type",
			"scope",
			"sessionId",
			"runId",
			"types",
			"from",
			"to",
			"cursor",
			"limit",
		]);
		const AUDIT_REPLAY_COMMAND_KEYS = new Set([
			"id",
			"type",
			"runId",
			"scope",
			"sessionId",
			"types",
			"from",
			"to",
			"cursor",
			"limit",
		]);

		const auditErrorMessage = (code: AuditAutomationCode): string => {
			switch (code) {
				case "audit_query_invalid":
					return "The audit query is invalid.";
				case "audit_cursor_invalid":
					return "The audit cursor is invalid.";
				case "audit_scope_unavailable":
					return "The requested audit scope is unavailable.";
				case "audit_run_not_found":
					return "The requested run was not found in the audit scope.";
				case "audit_replay_incomplete":
					return "The audit replay could not be constructed safely.";
			}
		};

		const auditCommandError = (err: unknown, fallback: AuditAutomationCode): AutomationError => {
			const candidate =
				err instanceof ExecutionAuditError
					? err.code
					: typeof err === "object" && err !== null && "code" in err
						? (err as { code?: unknown }).code
						: undefined;
			const code = isAuditAutomationCode(candidate) ? candidate : fallback;
			return createAutomationError(code, auditErrorMessage(code), false);
		};

		const hostNotInitializedError = (): AutomationError =>
			createAutomationError(
				"host_not_initialized",
				"Automation Host is not initialized. Send initialize with protocolVersion 1 first.",
				false,
			);

		const taskGateErrorMessage = (code: TaskGateError["code"]): string => {
			switch (code) {
				case "task_gate_invalid":
					return "The task gate request is invalid.";
				case "task_gate_not_found":
					return "The task gate was not found in the current session.";
				case "task_gate_conflict":
					return "The task gate business key is already decided or in use.";
				case "task_gate_idempotency_conflict":
					return "The task gate clientRequestId was already used with a different payload.";
				case "task_gate_not_pending":
					return "The task gate is not pending.";
				case "task_gate_stage_revision_mismatch":
					return "The task gate stage revision is stale.";
				case "task_gate_persistence_failed":
					return "The task gate transition could not be persisted.";
			}
		};

		/** Map a TaskGateError to a stable, public-safe Automation Error. */
		const taskGateCommandError = (err: unknown, fallback: TaskGateError["code"]): AutomationError =>
			createAutomationError(
				err instanceof TaskGateError ? err.code : fallback,
				taskGateErrorMessage(err instanceof TaskGateError ? err.code : fallback),
				false,
			);

		const taskGraphErrorMessage = (code: TaskGraphErrorCode): string => {
			switch (code) {
				case "task_graph_invalid":
					return "The task graph request is invalid.";
				case "task_graph_dependency_cycle":
					return "The task graph definition contains a dependency cycle.";
				case "task_graph_not_found":
					return "The task graph was not found in the current session.";
				case "task_graph_conflict":
					return "The task graph business key is already in use.";
				case "task_graph_idempotency_conflict":
					return "The task graph clientRequestId was already used with a different payload.";
				case "task_graph_node_not_found":
					return "The task graph node was not found in this graph.";
				case "task_graph_node_not_eligible":
					return "The task graph node is not pending and ready.";
				case "task_graph_node_conflict":
					return "The task graph node already has a run association or is terminal.";
				case "task_graph_run_not_found":
					return "The task graph run was not found in the current session.";
				case "task_graph_run_not_terminal":
					return "The task graph run is not terminal yet.";
				case "task_graph_run_state_mismatch":
					return "The task graph run record and receipt facts are inconsistent.";
				case "task_graph_persistence_failed":
					return "The task graph transition could not be persisted.";
			}
		};

		/**
		 * Map a TaskGraphError to a stable, public-safe Automation Error. The code
		 * stays on the wire unchanged; only the code-derived message is used. The
		 * shared AutomationErrorCode union includes every TaskGraphErrorCode, so
		 * no cast is needed and a graph code can never be hidden as a generic
		 * fallback.
		 */
		const taskGraphCommandError = (err: unknown, fallback: TaskGraphErrorCode): AutomationError =>
			createAutomationError(
				err instanceof TaskGraphError ? err.code : fallback,
				taskGraphErrorMessage(err instanceof TaskGraphError ? err.code : fallback),
				false,
			);

		type TaskCredentialCommandErrorCode = TaskCredentialError["code"] | "task_credential_unavailable";

		const taskCredentialErrorMessage = (code: TaskCredentialCommandErrorCode): string => {
			switch (code) {
				case "task_credential_invalid":
					return "The task credential request is invalid.";
				case "task_credential_binding_invalid":
					return "The task credential binding is invalid or does not match the current execution context.";
				case "task_credential_gate_required":
					return "The task credential requires an approved task gate for this stage revision.";
				case "task_credential_policy_denied":
					return "The task credential policy denied the requested scope, target, or action.";
				case "task_credential_approval_required":
					return "The task credential policy approval is required but not granted.";
				case "task_credential_scope_denied":
					return "The task credential requested scope exceeds the allowlist.";
				case "task_credential_ttl_invalid":
					return "The task credential TTL is outside the allowed bounds or deadlines.";
				case "task_credential_provider_unavailable":
					return "The task credential issuer is temporarily unavailable.";
				case "task_credential_issue_failed":
					return "The task credential issuer did not return a manageable grant.";
				case "task_credential_not_found":
					return "The task credential grant or lease was not found in the current session.";
				case "task_credential_conflict":
					return "The task credential state conflict: binding, scope, target, or revision does not match.";
				case "task_lease_expired":
					return "The task credential lease is expired and cannot be extended.";
				case "task_lease_heartbeat_invalid":
					return "The task credential heartbeat sequence is not strictly increasing.";
				case "task_credential_target_unavailable":
					return "The task credential target does not declare the required isolation or revocation capability.";
				case "task_credential_delivery_failed":
					return "The task credential delivery failed.";
				case "task_credential_revocation_unknown":
					return "The task credential revocation outcome is unknown.";
				case "task_credential_persistence_failed":
					return "The task credential transition could not be persisted.";
				case "task_credential_unavailable":
					return "The task credential service is not available in this host.";
			}
		};

		/**
		 * Map a TaskCredentialError to a stable, public-safe Automation Error. The
		 * code stays on the wire unchanged; only the code-derived message is used.
		 * The shared AutomationErrorCode union includes every
		 * TaskCredentialErrorCode, so a credential code can never be hidden as a
		 * generic fallback.
		 */
		const taskCredentialCommandError = (err: unknown, fallback: TaskCredentialError["code"]): AutomationError =>
			createAutomationError(
				err instanceof TaskCredentialError ? err.code : fallback,
				taskCredentialErrorMessage(err instanceof TaskCredentialError ? err.code : fallback),
				false,
			);

		/**
		 * Only the documented keys may appear in a task.credential command. Free
		 * text, tool payloads, paths, and credentials are rejected before they
		 * reach the service.
		 */
		const TASK_CREDENTIAL_COMMAND_KEYS: Readonly<Record<RpcTaskCredentialCommandType, ReadonlySet<string>>> = {
			"task.credential.issue": new Set([
				"id",
				"type",
				"taskId",
				"graphRevision",
				"nodeId",
				"stageId",
				"stageRevision",
				"runId",
				"capabilityBindingId",
				"policyBindingId",
				"sandboxBindingId",
				"targetId",
				"targetKind",
				"workerId",
				"scopes",
				"requestedTtlMs",
				"clientRequestId",
			]),
			"task.credential.get": new Set(["id", "type", "leaseId"]),
			"task.credential.list": new Set(["id", "type", "taskId", "nodeId", "runId", "status", "limit"]),
			"task.credential.heartbeat": new Set([
				"id",
				"type",
				"leaseId",
				"grantId",
				"bindingId",
				"heartbeatSequence",
				"requestedTtlMs",
				"clientRequestId",
			]),
			"task.credential.revoke": new Set(["id", "type", "leaseId", "reasonCode", "clientRequestId"]),
			"task.credential.settle": new Set(["id", "type", "leaseId", "reasonCode", "clientRequestId"]),
		};

		const isTaskCredentialCommandShapeValid = (command: RpcCommand): boolean => {
			const allowed = TASK_CREDENTIAL_COMMAND_KEYS[command.type as RpcTaskCredentialCommandType];
			if (allowed === undefined) return false;
			return Object.keys(command).every((key) => allowed.has(key));
		};

		/**
		 * Host-resolvable Task Credential issue preflight (T3 contract). The
		 * control plane enforces the read-only preflight facts it can resolve
		 * from its own stores before the service is touched: the stage pair
		 * must appear together or not at all, a binding with a stage pair
		 * requires an approved Gate at the exact stage revision, the graph node
		 * must be attached to the Run, the requested TTL must fit the frozen
		 * lease bounds, and the scope list must be non-empty, bounded, and
		 * structurally valid. The Session-side facts (the `credential.task.*`
		 * policy decision, the capability target snapshot, the per-binding
		 * sandbox facts, and the provider scope) are resolved by the Session's
		 * read-only preflight resolver inside the service; the control plane
		 * never fabricates them. Returns the stable failure code or undefined
		 * when the preflight passes.
		 */
		const taskCredentialIssuePreflight = (
			binding: RpcSessionBinding,
			input: {
				readonly taskId: string;
				readonly graphRevision: number;
				readonly nodeId: string;
				readonly stageId?: string;
				readonly stageRevision?: number;
				readonly runId: string;
				readonly scopes: ReadonlyArray<TaskCredentialScope>;
				readonly requestedTtlMs: number;
			},
		): TaskCredentialError["code"] | undefined => {
			// The stage pair must appear together or not at all.
			if ((input.stageId === undefined) !== (input.stageRevision === undefined)) {
				return "task_credential_invalid";
			}
			// Gate (preflight step 3): an approved Gate at the exact stage
			// revision; pending, rejected, cancelled, missing, or stale gates
			// never pass.
			if (input.stageId !== undefined && input.stageRevision !== undefined) {
				const gate = resolveGateFact(binding, input.taskId, input.stageId, input.stageRevision);
				if (gate === undefined || gate.status !== "approved" || gate.stageRevision !== input.stageRevision) {
					return "task_credential_gate_required";
				}
			}
			// Node attach (preflight step 4): the graph node must be attached to
			// the Run.
			if (!resolveNodeAttached(binding, input.taskId, input.graphRevision, input.nodeId, input.runId)) {
				return "task_credential_binding_invalid";
			}
			// TTL bounds (preflight step 5 floor/ceiling): the frozen lease
			// bounds always apply; the policy ceiling is enforced by the
			// service's TTL bounds.
			if (input.requestedTtlMs < TASK_CREDENTIAL_MIN_TTL_MS || input.requestedTtlMs > TASK_CREDENTIAL_MAX_TTL_MS) {
				return "task_credential_ttl_invalid";
			}
			// Scope facts (preflight step 1): non-empty, bounded, structurally
			// valid; normalization and digest correlation run in the service.
			if (
				!Array.isArray(input.scopes) ||
				input.scopes.length === 0 ||
				input.scopes.length > TASK_CREDENTIAL_MAX_SCOPES ||
				!input.scopes.every((scope) => isTaskCredentialScope(scope))
			) {
				return "task_credential_invalid";
			}
			return undefined;
		};

		/**
		 * Resolve the T3 Gate fact of one stage pair from the live Task Gate
		 * store. Read-only; never appends. `undefined` means the Gate cannot be
		 * resolved (the frozen preflight denies with `task_credential_gate_required`).
		 */
		const resolveGateFact = (
			binding: RpcSessionBinding,
			taskId: string,
			stageId: string,
			stageRevision: number,
		): TaskCredentialGatePreflight | undefined => {
			const gate = binding.taskGateStore?.getByBusinessKey(taskId, stageId, stageRevision);
			if (gate === undefined) return undefined;
			return { status: gate.status, stageRevision: gate.stageRevision };
		};

		/**
		 * Resolve the T3 node-attach fact of one graph node from the live Task
		 * Graph store. Read-only; never appends. A missing graph, missing node,
		 * or a node not attached to the Run is `false` (the frozen preflight
		 * denies with `task_credential_binding_invalid`).
		 */
		const resolveNodeAttached = (
			binding: RpcSessionBinding,
			taskId: string,
			graphRevision: number,
			nodeId: string,
			runId: string,
		): boolean => {
			const graph = binding.taskGraphStore?.get(taskId, graphRevision);
			const node = graph?.nodes.find((candidate) => candidate.nodeId === nodeId);
			return node !== undefined && node.runRef?.runId === runId;
		};

		/** True when the value is a positive safe integer; used for list limits. */
		const isPositiveInteger = (value: unknown): value is number =>
			typeof value === "number" && Number.isSafeInteger(value) && value > 0;

		/** True when the value is one of the stable lease statuses. */
		const isTaskCredentialStatusValue = (value: unknown): value is TaskCredentialStatus =>
			typeof value === "string" && (TASK_CREDENTIAL_STATUS as readonly string[]).includes(value);

		/**
		 * Rebuild the Automation Host state stores for the current Session. The Run
		 * lookup and Task Gate lookup are read-only adapters over the live
		 * coordinator/gate store, so attach only sees current-Session accepted or
		 * running Runs and terminal lookup sees only canonical receipt projections; the Task
		 * Graph store never starts, cancels, or rewrites a Run and never creates,
		 * approves, rejects, or cancels a Gate. The Task Credential service is
		 * session-owned and lazily created by the Session from its configured
		 * provider; without a provider every credential command fails closed with
		 * task_credential_unavailable.
		 */
		const prepareAutomationStores = (binding: RpcSessionBinding): void => {
			binding.taskCredentialService = binding.session.getTaskCredentialService?.();
			binding.coordinator = createRunLifecycleCoordinator(getAgentSessionLedger(binding.session), {
				credentialHooks: {
					onRunTerminal: (runId, receipt) => {
						binding.taskCredentialService?.onRunTerminal({
							runId,
							status: receipt.status,
							...(receipt.terminalError === undefined ? {} : { terminalErrorCode: receipt.terminalError.code }),
						});
					},
					onRunInterrupted: (runId) => {
						binding.taskCredentialService?.onRunInterrupted(runId);
					},
					onRunCancelRequested: (runId) => {
						// The first cancel request revokes the run's live leases
						// before the terminal transition; the terminal event settles.
						binding.taskCredentialService?.onRunCancelRequested(runId);
					},
				},
			});
			binding.taskGateStore = createTaskGateStore(getAgentSessionLedger(binding.session), {
				onGateInvalidated: (gate) => {
					binding.taskCredentialService?.onGateInvalidated({
						taskId: gate.taskId,
						stageId: gate.stageId,
						stageRevision: gate.stageRevision,
						status: gate.status === "rejected" ? "rejected" : "cancelled",
					});
				},
			});
			binding.taskGraphStore = createTaskGraphStore(
				getAgentSessionLedger(binding.session),
				{
					get: (runId) => {
						const result = binding.coordinator?.getRun(runId);
						if (result === undefined) return undefined;
						return {
							sessionId: result.record.sessionId,
							runId: result.record.id,
							status: result.record.status,
							...(result.receipt === undefined ? {} : { receiptStatus: result.receipt.status }),
						};
					},
				},
				{
					getByBusinessKey: (taskId, stageId, stageRevision) =>
						binding.taskGateStore?.getByBusinessKey(taskId, stageId, stageRevision),
				},
				{
					onNodeTerminal: (node, taskId, runId) => {
						binding.taskCredentialService?.onGraphNodeTerminal({
							taskId,
							nodeId: node.nodeId,
							runId,
							status:
								node.status === "succeeded" ? "succeeded" : node.status === "failed" ? "failed" : "cancelled",
						});
					},
				},
			);
		};

		/**
		 * Only the documented keys may appear in a task.graph command. Free text,
		 * tool payloads, paths, and credentials are rejected before they reach
		 * the store.
		 */
		const TASK_GRAPH_COMMAND_KEYS: Readonly<Record<RpcTaskGraphCommandType, ReadonlySet<string>>> = {
			"task.graph.create": new Set(["id", "type", "taskId", "graphRevision", "nodes", "clientRequestId"]),
			"task.graph.get": new Set(["id", "type", "taskId", "graphRevision"]),
			"task.graph.list": new Set(["id", "type", "taskId", "graphRevision", "status", "limit"]),
			"task.graph.node.attach": new Set([
				"id",
				"type",
				"taskId",
				"graphRevision",
				"nodeId",
				"runId",
				"clientRequestId",
			]),
			"task.graph.node.settle": new Set(["id", "type", "taskId", "graphRevision", "nodeId", "clientRequestId"]),
		};

		const isTaskGraphCommandShapeValid = (command: RpcCommand): boolean => {
			const allowed = TASK_GRAPH_COMMAND_KEYS[command.type as RpcTaskGraphCommandType];
			if (allowed === undefined) return false;
			return Object.keys(command).every((key) => allowed.has(key));
		};

		const taskGraphMutationResponse = (
			id: string | undefined,
			command: "task.graph.create" | "task.graph.node.attach" | "task.graph.node.settle",
			result: { graph: TaskGraphRecord; node?: TaskGraphNodeView; idempotent: boolean },
		): RpcAutomationResponse => ({
			id,
			type: "response",
			command,
			success: true,
			data: {
				graph: result.graph,
				...(result.node === undefined ? {} : { node: result.node }),
				idempotent: result.idempotent,
			} satisfies TaskGraphMutationData,
		});

		/**
		 * Only the documented keys may appear in a task.gate command. Free text,
		 * tool payloads, paths, and credentials are rejected before they reach
		 * the store.
		 */
		const TASK_GATE_COMMAND_KEYS: Readonly<Record<RpcTaskGateCommandType, ReadonlySet<string>>> = {
			"task.gate.request": new Set(["id", "type", "taskId", "stageId", "stageRevision", "runId", "clientRequestId"]),
			"task.gate.get": new Set(["id", "type", "gateId"]),
			"task.gate.list": new Set(["id", "type", "taskId", "stageId", "status", "limit"]),
			"task.gate.approve": new Set(["id", "type", "gateId", "actorId", "clientRequestId"]),
			"task.gate.reject": new Set(["id", "type", "gateId", "actorId", "reasonCode", "clientRequestId"]),
			"task.gate.cancel": new Set(["id", "type", "gateId", "actorId", "clientRequestId"]),
		};

		const isTaskGateCommandShapeValid = (command: RpcCommand): boolean => {
			const allowed = TASK_GATE_COMMAND_KEYS[command.type as RpcTaskGateCommandType];
			if (allowed === undefined) return false;
			return Object.keys(command).every((key) => allowed.has(key));
		};

		const EXTERNAL_RUN_START_KEYS = new Set([
			"id",
			"type",
			"message",
			"clientRequestId",
			"deadlineAt",
			"images",
			"externalConnector",
			"artifacts",
			"capabilityProfile",
			"policyProfile",
			"modelRoute",
			"modelRole",
		]);
		const EXTERNAL_RUN_RESUME_KEYS = new Set([...EXTERNAL_RUN_START_KEYS, "sessionPath", "sourceRunId"]);

		const slashRunInputError = (
			id: string | undefined,
			command: "run.start" | "run.resume",
			message: string,
		): RpcAutomationResponse | undefined => {
			if (!message.startsWith("/")) return undefined;
			return automationError(
				id,
				command,
				createAutomationError(
					"start_rejected",
					"Automation Host v1 does not accept slash-command input for a run.",
					false,
				),
			);
		};

		const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

		const asAutomationError = (err: unknown): AutomationError => {
			if (typeof err === "object" && err !== null && "code" in err && "message" in err && "retryable" in err) {
				const candidate = err as AutomationError;
				if (!isAutomationErrorCode(candidate.code)) {
					return createAutomationError("start_rejected", errorMessage(err), false);
				}
				if (isAuditAutomationCode(candidate.code)) {
					return createAutomationError(candidate.code, auditErrorMessage(candidate.code), false);
				}
				return createAutomationError(candidate.code, candidate.message, candidate.retryable);
			}
			return createAutomationError("start_rejected", errorMessage(err), false);
		};

		/**
		 * Map a capability discovery/preflight failure into the structured Automation
		 * Host error contract so profile, connection, authorization and binding
		 * problems are never degraded into generic model failures.
		 */
		const capabilityError = (err: unknown): AutomationError => {
			if (typeof err === "object" && err !== null && "code" in err) {
				const code = (err as { code?: unknown }).code;
				if (isAutomationErrorCode(code)) {
					return createAutomationError(code, errorMessage(err), false);
				}
			}
			return createAutomationError("start_rejected", errorMessage(err), false);
		};

		const currentRunModel = (binding: RpcSessionBinding): RunModelReference => {
			const model = binding.session.model;
			return {
				provider: model?.provider ?? "unknown",
				id: model?.id ?? "unknown",
				thinkingLevel: binding.session.thinkingLevel,
			};
		};

		const isThinkingLevel = (value: string): value is ThinkingLevel =>
			value === "off" ||
			value === "minimal" ||
			value === "low" ||
			value === "medium" ||
			value === "high" ||
			value === "xhigh" ||
			value === "max";

		const finalModelForResolution = (resolution: BrokerModelResolution): RunFinalModelReference => ({
			provider: resolution.reference.provider,
			modelId: resolution.reference.id,
			...(resolution.reference.thinkingLevel !== undefined && isThinkingLevel(resolution.reference.thinkingLevel)
				? { thinkingLevel: resolution.reference.thinkingLevel }
				: {}),
		});

		/**
		 * Project the Broker's ordered selection into the Connector fallback
		 * contract. The Broker excludes disabled candidates, so every enabled
		 * candidate before the selection was skipped because it was unavailable.
		 * The selected position is derived from the immutable ordered candidates
		 * instead of `candidateIndex`, which refers to the caller's pre-priority
		 * input order. Duplicate selected references are ambiguous and fail closed.
		 */
		const externalFallbackDecisionForResolution = (
			resolution: BrokerModelResolution,
		): ExternalModelFallbackDecision | undefined => {
			if (!resolution.fallbackAllowed) return { kind: "disabled", reason: "fallback_disabled" };
			const selectedPositions = resolution.candidatesConsidered.flatMap((candidate, index) =>
				candidate.provider === resolution.reference.provider &&
				candidate.id === resolution.reference.id &&
				candidate.api === resolution.reference.api &&
				candidate.thinkingLevel === resolution.reference.thinkingLevel &&
				candidate.serviceTier === resolution.reference.serviceTier
					? [index]
					: [],
			);
			if (selectedPositions.length !== 1) return undefined;
			const selectedPosition = selectedPositions[0]!;
			return selectedPosition === 0
				? { kind: "primary", reason: "fallback_not_used" }
				: { kind: "fallback", reason: "provider_unavailable", candidateIndex: selectedPosition };
		};

		const modelSelectionError = (err: unknown, fallback: "route" | "role" = "route"): AutomationError => {
			const candidate =
				typeof err === "object" && err !== null
					? (err as { code?: unknown; message?: unknown; retryable?: unknown })
					: undefined;
			const code = candidate?.code;
			if (code === "model_route_not_found") {
				return createAutomationError("model_route_not_found", "Model route was not found.", false);
			}
			if (code === "model_role_not_found") {
				return createAutomationError("model_role_not_found", "Model role was not found.", false);
			}
			if (code === "model_route_unavailable" || code === "model_no_candidate" || code === "model_provider_failure") {
				return createAutomationError("model_route_unavailable", "The selected model route is unavailable.", true);
			}
			if (code === "model_budget_exceeded") {
				return createAutomationError("model_budget_exceeded", "The model budget is exceeded.", false);
			}
			if (code === "model_binding_unavailable") {
				return createAutomationError(
					"model_binding_unavailable",
					"The previous model binding is unavailable.",
					false,
				);
			}
			if (
				code === "model_binding_invalid" ||
				code === "model_binding_conflict" ||
				code === "model_invalid_reference"
			) {
				return createAutomationError("model_route_invalid", "The model route selection is invalid.", false);
			}
			if (candidate?.message !== undefined && typeof candidate.message === "string") {
				return createAutomationError(
					fallback === "role" ? "model_role_not_found" : "model_route_invalid",
					redactErrorText(candidate.message),
					candidate.retryable === true,
				);
			}
			return createAutomationError(
				fallback === "role" ? "model_role_not_found" : "model_route_invalid",
				fallback === "role" ? "Model role selection failed." : "Model route selection failed.",
				false,
			);
		};

		const unavailableModelError = (): AutomationError =>
			createAutomationError("model_route_unavailable", "The selected model route is unavailable.", true);

		const resolveRequestedModel = async (
			binding: RpcSessionBinding,
			modelRoute: ModelRouteSelection | undefined,
			modelRole: ModelRoleSelection | undefined,
			inheritedBinding?: ModelBindingLedgerRecord,
			commitResolution = true,
		): Promise<{ resolution?: BrokerModelResolution; error?: AutomationError }> => {
			if (modelRoute !== undefined && modelRole !== undefined) {
				return {
					error: createAutomationError(
						"model_route_invalid",
						"modelRoute and modelRole are mutually exclusive.",
						false,
					),
				};
			}
			let requestedRoute = modelRoute;
			let requestedRole = modelRole;
			let inheritedDirect: { provider: string; id: string; thinkingLevel?: ThinkingLevel } | undefined;
			if (requestedRoute === undefined && requestedRole === undefined && inheritedBinding !== undefined) {
				if (inheritedBinding.role !== undefined) {
					requestedRole = inheritedBinding.role;
				} else if (inheritedBinding.mode === "route" && inheritedBinding.routeId !== undefined) {
					requestedRoute = inheritedBinding.routeId;
				} else if (inheritedBinding.mode === "route") {
					return { error: modelSelectionError({ code: "model_binding_unavailable" }) };
				} else {
					const inheritedModel = inheritedBinding.candidates[0]?.model;
					if (inheritedModel === undefined) {
						return { error: modelSelectionError({ code: "model_binding_unavailable" }) };
					}
					inheritedDirect = {
						provider: inheritedModel.provider,
						id: inheritedModel.modelId,
						...(inheritedModel.thinkingLevel === undefined
							? {}
							: { thinkingLevel: inheritedModel.thinkingLevel }),
					};
				}
			}
			if (requestedRoute === undefined && requestedRole === undefined) {
				const currentModel = binding.session.model;
				if (currentModel === undefined) return { error: unavailableModelError() };
				const result =
					inheritedDirect !== undefined
						? binding.session.modelBroker.resolveResult({ direct: inheritedDirect })
						: binding.session.modelBroker.hasDefaultSelection()
							? binding.session.modelBroker.resolveResult({})
							: binding.session.modelBroker.resolveResult({
									direct: {
										provider: currentModel.provider,
										id: currentModel.id,
										thinkingLevel: binding.session.thinkingLevel,
									},
								});
				if (!result.ok) return { error: modelSelectionError(result.error) };
				let model = currentModel;
				if (
					result.resolution.reference.provider !== currentModel.provider ||
					result.resolution.reference.id !== currentModel.id
				) {
					try {
						model =
							binding.session.modelRuntime.getModel(
								result.resolution.reference.provider,
								result.resolution.reference.id,
							) ?? model;
					} catch {
						return { error: unavailableModelError() };
					}
					if (
						model.provider !== result.resolution.reference.provider ||
						model.id !== result.resolution.reference.id
					) {
						return { error: unavailableModelError() };
					}
					if (commitResolution) {
						try {
							await binding.session.setModel(model);
						} catch {
							return { error: unavailableModelError() };
						}
					}
				}
				if (commitResolution) {
					try {
						binding.session.setModelBrokerResolution(result.resolution, inheritedBinding?.bindingId);
					} catch {
						return { error: unavailableModelError() };
					}
				}
				return { resolution: result.resolution };
			}

			const result = binding.session.modelBroker.resolveResult({
				...(requestedRoute === undefined ? {} : { modelRoute: requestedRoute }),
				...(requestedRole === undefined ? {} : { modelRole: requestedRole }),
			});
			if (!result.ok) {
				return { error: modelSelectionError(result.error, requestedRole === undefined ? "route" : "role") };
			}

			let model: ReturnType<typeof binding.session.modelRuntime.getModel>;
			try {
				model = binding.session.modelRuntime.getModel(
					result.resolution.reference.provider,
					result.resolution.reference.id,
				);
			} catch {
				return { error: unavailableModelError() };
			}
			if (model === undefined) return { error: unavailableModelError() };
			if (commitResolution) {
				try {
					await binding.session.setModel(model);
					binding.session.setModelBrokerResolution(result.resolution, inheritedBinding?.bindingId);
					if (
						result.resolution.reference.thinkingLevel !== undefined &&
						isThinkingLevel(result.resolution.reference.thinkingLevel)
					) {
						binding.session.setThinkingLevel(result.resolution.reference.thinkingLevel);
					}
				} catch {
					return { error: unavailableModelError() };
				}
			}
			return { resolution: result.resolution };
		};

		const usageSnapshot = (binding: RpcSessionBinding): RunUsageSnapshot => {
			const stats = binding.session.getSessionStats();
			return {
				input: stats.tokens.input,
				output: stats.tokens.output,
				total: stats.tokens.total,
			};
		};

		/** Serialize a run stream event, applying JSON-safe event conversion to wrapped session events. */
		const outputRunEvent = (event: RunStreamEvent): void => {
			const publicEvent = serializePublicRunStreamEvent(event);
			if (publicEvent.type === "run.event") {
				output({
					...publicEvent,
					event: toJsonEvent(publicEvent.event as AgentSessionEvent),
				} as RpcHostRunStreamEvent);
			} else {
				output(publicEvent);
			}
		};

		const requestIdentity = (
			clientRequestId: string | undefined,
			command: "run.start" | "run.resume",
			sessionId: string,
			input: {
				message: string;
				images?: ImageContent[];
				targetSessionId?: string;
				sourceRunId?: string;
				capabilityProfile?: string;
				policyProfile?: string;
				modelRoute?: ModelRouteSelection;
				modelRole?: ModelRoleSelection;
				externalConnector?: ExternalConnectorSelection;
				artifacts?: readonly CanonicalExternalAgentArtifactReference[];
				deadlineAt?: string;
			},
		): RunRequestIdentity | undefined => {
			if (clientRequestId === undefined) return undefined;
			const identityScope = input.targetSessionId ?? sessionId;
			const baseFingerprint = createRunRequestFingerprint({
				command,
				sessionId: identityScope,
				targetSessionId: input.targetSessionId,
				sourceRunId: input.sourceRunId,
				message: input.message,
				images: input.images,
				capabilityProfile: input.capabilityProfile,
				policyProfile: input.policyProfile,
				modelRoute: input.modelRoute,
				modelRole: input.modelRole,
				externalConnector: input.externalConnector,
				deadlineAt: input.deadlineAt,
			});
			return {
				scopeSessionId: identityScope,
				clientRequestId,
				fingerprint:
					input.externalConnector === undefined
						? baseFingerprint
						: fingerprintFoundationValue({
								baseFingerprint,
								artifacts: input.artifacts ?? [],
							}).value,
				key: `${identityScope}\u0000${clientRequestId}`,
			};
		};

		const acceptedDataFromResult = (
			result: RunResult,
			idempotent: boolean,
			statusOverride?: "accepted",
		): RunAcceptedData => {
			const publicRecord = serializePublicRunRecord(result.record);
			const data: RunAcceptedData = {
				runId: publicRecord.id,
				sessionId: publicRecord.sessionId,
				attempt: publicRecord.attempt,
				status: statusOverride ?? publicRecord.status,
			};
			if (publicRecord.requestScope !== undefined) data.requestScope = publicRecord.requestScope;
			if (publicRecord.clientRequestId !== undefined) data.clientRequestId = publicRecord.clientRequestId;
			if (publicRecord.requestFingerprint !== undefined) data.requestFingerprint = publicRecord.requestFingerprint;
			if (idempotent) data.idempotent = true;
			if (publicRecord.deadlineAt !== undefined) data.deadlineAt = publicRecord.deadlineAt;
			if (publicRecord.bindingAssociation !== undefined) data.bindingAssociation = publicRecord.bindingAssociation;
			if (publicRecord.modelBindingId !== undefined) data.modelBindingId = publicRecord.modelBindingId;
			if (publicRecord.previousModelBindingId !== undefined)
				data.previousModelBindingId = publicRecord.previousModelBindingId;
			if (publicRecord.finalModel !== undefined) data.finalModel = publicRecord.finalModel;
			if (publicRecord.modelAttempts !== undefined) data.modelAttempts = publicRecord.modelAttempts;
			if (publicRecord.modelBudget !== undefined) data.modelBudget = publicRecord.modelBudget;
			if (publicRecord.policyBindingId !== undefined) data.policyBindingId = publicRecord.policyBindingId;
			if (publicRecord.previousPolicyBindingId !== undefined)
				data.previousPolicyBindingId = publicRecord.previousPolicyBindingId;
			if (publicRecord.policySummary !== undefined) data.policySummary = publicRecord.policySummary;
			if (statusOverride === undefined) {
				if (result.receipt !== undefined) data.receipt = serializePublicRunReceipt(result.receipt);
				if (result.recovery !== undefined) data.recovery = result.recovery;
			}
			return data;
		};

		const acceptedResponseFromResult = (
			id: string | undefined,
			command: "run.start" | "run.resume",
			result: RunResult,
			idempotent: boolean,
		): RpcAutomationResponse => ({
			id,
			type: "response",
			command,
			success: true,
			data: acceptedDataFromResult(result, idempotent),
		});

		const beginRunRequest = (
			id: string | undefined,
			command: "run.start" | "run.resume",
			identity: RunRequestIdentity | undefined,
			lookup: () => RunRequestLookup | undefined,
		): RunRequestGate => {
			if (identity === undefined) return { kind: "none" };
			const existing = lookup();
			if (existing !== undefined) {
				if (existing.fingerprint !== identity.fingerprint) {
					return {
						kind: "response",
						response: automationError(
							id,
							command,
							createAutomationError(
								"client_request_conflict",
								"The client request id was already used with a different request.",
								false,
							),
						),
					};
				}
				return {
					kind: "response",
					response: acceptedResponseFromResult(id, command, existing.result, true),
				};
			}
			const pending = pendingRunRequests.get(identity.key);
			if (pending !== undefined) {
				if (pending.fingerprint !== identity.fingerprint) {
					return {
						kind: "response",
						response: automationError(
							id,
							command,
							createAutomationError(
								"client_request_conflict",
								"The client request id was already used with a different request.",
								false,
							),
						),
					};
				}
				pending.waiters.push({ id, command });
				return { kind: "pending" };
			}
			const claimedIdentity = { ...identity, claimToken: {} };
			pendingRunRequests.set(identity.key, {
				fingerprint: identity.fingerprint,
				claimToken: claimedIdentity.claimToken,
				waiters: [],
			});
			return { kind: "new", identity: claimedIdentity };
		};

		const finishRunRequest = (identity: RunRequestIdentity | undefined, response: RpcAutomationResponse): void => {
			if (identity === undefined) return;
			const pending = pendingRunRequests.get(identity.key);
			if (
				pending === undefined ||
				pending.fingerprint !== identity.fingerprint ||
				identity.claimToken === undefined ||
				pending.claimToken !== identity.claimToken
			)
				return;
			pendingRunRequests.delete(identity.key);
			for (const waiter of pending.waiters) {
				output({ ...response, id: waiter.id, command: waiter.command } as RpcAutomationResponse);
			}
		};

		const clearRunDeadline = (binding: RpcSessionBinding, runId: RunId): void => {
			const timer = binding.runDeadlineTimers.get(runId);
			if (timer !== undefined) clearTimeout(timer);
			binding.runDeadlineTimers.delete(runId);
			binding.runAbortControllers.delete(runId);
			binding.externalPendingControllers.delete(runId);
		};

		const discardRunRequest = (identity: RunRequestIdentity | undefined): void => {
			if (identity === undefined) return;
			const pending = pendingRunRequests.get(identity.key);
			if (
				pending === undefined ||
				pending.fingerprint !== identity.fingerprint ||
				identity.claimToken === undefined ||
				pending.claimToken !== identity.claimToken
			)
				return;
			pendingRunRequests.delete(identity.key);
		};

		const readCanonicalRun = async (
			binding: RpcSessionBinding,
			runId: RunId,
		): Promise<CanonicalRunResult | undefined> => {
			const settlement = new LayeredResultSettlement(getAgentCanonicalSession(binding.session));
			try {
				const lookup = await settlement.lookupCanonicalRun(runId);
				if (!lookup.ok) throw lookup.error;
				return lookup.value;
			} finally {
				await settlement.release();
			}
		};

		const observeRunCompletion = async (binding: RpcSessionBinding, handle: RunHandle): Promise<void> => {
			if (binding.activeHandle !== handle || binding.terminalEventRunIds.has(handle.runId)) return;
			let canonical: CanonicalRunResult | undefined;
			try {
				canonical = await readCanonicalRun(binding, handle.runId);
			} catch {
				// A read or validation conflict is distinct from an absent receipt. Keep
				// the active Run lock so another Run cannot proceed on ambiguous truth.
				return;
			}
			if (canonical === undefined) {
				// Prompt promises, Connector evidence, process state, and agent events are
				// observations only. Without the durable RunReceipt chain the Run stays
				// non-terminal and recovery reports it interrupted.
				if (binding.activeHandle === handle) {
					binding.activeHandle = undefined;
					binding.coordinator = createRunLifecycleCoordinator(getAgentSessionLedger(binding.session));
				}
				clearRunDeadline(binding, handle.runId);
				binding.runPromptPromises.delete(handle.runId);
				return;
			}
			binding.terminalEventRunIds.add(handle.runId);
			let terminal: RunStreamEvent | undefined;
			try {
				terminal = handle.observeCanonicalResult(canonical);
			} catch {
				// A malformed or mismatched projection remains locked and non-terminal.
				binding.terminalEventRunIds.delete(handle.runId);
				return;
			}
			if (terminal !== undefined) outputRunEvent(terminal);
			clearRunDeadline(binding, handle.runId);
			binding.activeHandle = undefined;
			binding.runPromptPromises.delete(handle.runId);
			await waitForOutput();
		};

		const observeActiveRunCompletion = async (binding: RpcSessionBinding, handle: RunHandle): Promise<void> => {
			if (binding.activeHandle !== handle || binding.terminalEventRunIds.has(handle.runId)) return;
			// Await the tracked prompt, then look up the canonical Foundation result.
			await binding.runPromptPromises.get(handle.runId);
			await observeRunCompletion(binding, handle);
		};

		/** Track a started prompt as an observation before canonical result lookup. */
		const trackRunPrompt = (binding: RpcSessionBinding, handle: RunHandle, prompt: Promise<unknown>): void => {
			const tracked = (async () => {
				try {
					await prompt;
					await observeRunCompletion(binding, handle);
				} catch {
					await observeRunCompletion(binding, handle);
				}
			})();
			binding.runPromptPromises.set(handle.runId, tracked);
		};
		/** Forward lifecycle cancellation through the Connector before observing settlement. */
		const forwardExternalRunLifecycleCancel = async (binding: RpcSessionBinding, runId: RunId): Promise<boolean> => {
			const externalRun = binding.externalRuns.get(runId);
			if (externalRun === undefined) return false;
			try {
				await externalRun.cancel();
			} catch {
				// Connector cancellation owns its bounded reconciliation result.
			}
			return true;
		};

		const trackPendingStart = (
			pending: Promise<RpcAutomationResponse | undefined>,
			binding?: RpcSessionBinding,
			control?: ExternalPendingStartControl,
			id?: string,
			command: "run.start" | "run.resume" = "run.start",
		): Promise<RpcAutomationResponse | undefined> => {
			const tracked =
				control?.runId === undefined ||
				control.lifecycleController === undefined ||
				control.deadlineController === undefined
					? pending
					: raceWithAbortSignal(
							raceWithAbortSignal(pending, control.lifecycleController.signal),
							control.deadlineController.signal,
						).catch((error: unknown) => {
							if (control.deadlineController?.signal.aborted === true) {
								const response = automationError(
									id,
									command,
									createAutomationError(
										"run_deadline_exceeded",
										"The Run deadline was exceeded before acceptance.",
										false,
									),
								);
								finishRunRequest(control.requestClaim, response);
								return response;
							}
							if (control.lifecycleController?.signal.aborted === true) {
								discardRunRequest(control.requestClaim);
								return undefined;
							}
							discardRunRequest(control.requestClaim);
							throw error;
						});
			pendingStartPromises.add(tracked);
			if (binding !== undefined && control?.runId !== undefined) {
				binding.pendingExternalStarts.set(control.runId, tracked);
			}
			void tracked.then(
				() => {
					pendingStartPromises.delete(tracked);
					if (binding !== undefined && control?.runId !== undefined) {
						if (binding.pendingExternalStarts.get(control.runId) === tracked) {
							binding.pendingExternalStarts.delete(control.runId);
						}
						if (!control.accepted) clearRunDeadline(binding, control.runId);
					}
				},
				() => {
					pendingStartPromises.delete(tracked);
					if (binding !== undefined && control?.runId !== undefined) {
						if (binding.pendingExternalStarts.get(control.runId) === tracked) {
							binding.pendingExternalStarts.delete(control.runId);
						}
						if (!control.accepted) clearRunDeadline(binding, control.runId);
					}
				},
			);
			return tracked;
		};

		const startRun = async (
			commandBinding: RpcSessionBinding,
			id: string | undefined,
			commandType: "run.start" | "run.resume",
			message: string,
			images: ImageContent[] | undefined,
			artifacts: readonly CanonicalExternalAgentArtifactReference[] | undefined,
			attempt: number,
			sourceRunId: string | undefined,
			capabilityProfile: string | undefined,
			policyProfile: string | undefined,
			previousBindingId: string | undefined,
			previousPolicyBindingId: string | undefined,
			previousModelBindingId: string | undefined,
			inheritedModelBinding: ModelBindingLedgerRecord | undefined,
			modelRoute: ModelRouteSelection | undefined,
			modelRole: ModelRoleSelection | undefined,
			externalConnector: ExternalConnectorSelection | undefined,
			deadlineAt: string | undefined,
			clientRequestId: string | undefined,
			precomputedRequestIdentity: RunRequestIdentity | undefined,
			requestAlreadyClaimed: boolean,
			expectedTransportEpoch?: number,
			externalStartControl?: ExternalPendingStartControl,
		): Promise<RpcAutomationResponse | undefined> => {
			const runBinding = commandBinding;
			const requestEpoch = expectedTransportEpoch ?? transportEpoch;
			const inputError = slashRunInputError(id, commandType, message);
			if (inputError !== undefined) {
				discardRunRequest(precomputedRequestIdentity);
				return inputError;
			}
			if (externalConnector !== undefined && !isExternalConnectorSelection(externalConnector)) {
				discardRunRequest(precomputedRequestIdentity);
				return automationError(
					id,
					commandType,
					createAutomationError("external_binding_invalid", "The External Connector selection is invalid.", false),
				);
			}
			if (deadlineAt !== undefined && !isRunTimestamp(deadlineAt)) {
				discardRunRequest(precomputedRequestIdentity);
				return automationError(
					id,
					commandType,
					createAutomationError(
						"run_deadline_invalid",
						"The Run deadline must be a canonical UTC timestamp.",
						false,
					),
				);
			}
			if (deadlineAt !== undefined && Date.parse(deadlineAt) <= Date.now()) {
				discardRunRequest(precomputedRequestIdentity);
				return automationError(
					id,
					commandType,
					createAutomationError("run_deadline_exceeded", "The Run deadline has already expired.", false),
				);
			}
			if (clientRequestId !== undefined && !isRunClientRequestId(clientRequestId)) {
				discardRunRequest(precomputedRequestIdentity);
				return automationError(
					id,
					commandType,
					createAutomationError("client_request_id_invalid", "The client request id is invalid.", false),
				);
			}
			if (shuttingDown) {
				discardRunRequest(precomputedRequestIdentity);
				return automationError(
					id,
					commandType,
					createAutomationError(
						"start_rejected",
						"Automation Host is shutting down; no new runs are accepted.",
						false,
					),
				);
			}
			if (!hostInitialized || runBinding.coordinator === undefined) {
				discardRunRequest(precomputedRequestIdentity);
				return automationError(id, commandType, hostNotInitializedError());
			}
			const identity =
				precomputedRequestIdentity ??
				requestIdentity(clientRequestId, commandType, runBinding.session.sessionId, {
					message,
					images,
					sourceRunId,
					capabilityProfile,
					policyProfile,
					modelRoute,
					modelRole,
					externalConnector,
					artifacts,
					deadlineAt,
				});
			let requestClaim: RunRequestIdentity | undefined;
			let proposedRunId: RunId | undefined;
			const startFailure = (response: RpcAutomationResponse): RpcAutomationResponse => {
				if (proposedRunId !== undefined && externalStartControl === undefined) {
					clearRunDeadline(runBinding, proposedRunId);
				}
				finishRunRequest(requestClaim, response);
				return response;
			};
			if (requestAlreadyClaimed) {
				if (identity === undefined) {
					discardRunRequest(precomputedRequestIdentity);
					return startFailure(
						automationError(
							id,
							commandType,
							createAutomationError("client_request_id_invalid", "The client request id is invalid.", false),
						),
					);
				}
				requestClaim = identity;
			} else {
				const gate = beginRunRequest(id, commandType, identity, () =>
					runBinding.coordinator!.getRunByClientRequestId(
						identity!.clientRequestId,
						commandType === "run.start" ? "start" : "resume",
					),
				);
				if (gate.kind === "response") return gate.response;
				if (gate.kind === "pending") return undefined;
				if (gate.kind === "new") requestClaim = gate.identity;
			}
			if (externalStartControl !== undefined) externalStartControl.requestClaim = requestClaim;
			if (requestEpoch !== transportEpoch) {
				return startFailure(
					automationError(
						id,
						commandType,
						createAutomationError(
							"start_rejected",
							"The RPC connection closed before the Run was accepted.",
							true,
						),
					),
				);
			}
			if (runBinding.coordinator.activeRun !== undefined || runBinding.activeReservation !== undefined) {
				return startFailure(
					automationError(
						id,
						commandType,
						createAutomationError(
							"session_busy",
							"A run is already active in this session. Wait for its terminal event before starting another.",
							true,
						),
					),
				);
			}
			proposedRunId = crypto.randomUUID();
			const deadlineController = new AbortController();
			runBinding.runAbortControllers.set(proposedRunId, deadlineController);
			if (externalStartControl !== undefined) {
				const lifecycleController = new AbortController();
				externalStartControl.runId = proposedRunId;
				externalStartControl.deadlineController = deadlineController;
				externalStartControl.lifecycleController = lifecycleController;
				runBinding.externalPendingControllers.set(proposedRunId, lifecycleController);
			}
			if (deadlineAt !== undefined) {
				const deadlineTimer = setTimeout(
					() => {
						deadlineController.abort(new AgentOperationError("deadline_exceeded"));
						if (runBinding.activeHandle?.runId === proposedRunId) {
							runBinding.activeHandle.requestDeadlineExceeded();
							if (externalConnector === undefined) {
								void runBinding.session.abort().catch(() => {
									// Foundation remains the only terminal authority.
								});
							}
						}
					},
					Math.max(0, Date.parse(deadlineAt) - Date.now()),
				);
				if (
					typeof deadlineTimer === "object" &&
					"unref" in deadlineTimer &&
					typeof deadlineTimer.unref === "function"
				) {
					deadlineTimer.unref();
				}
				runBinding.runDeadlineTimers.set(proposedRunId, deadlineTimer);
			}
			const externalStartWasTornDown = (): boolean =>
				externalStartControl !== undefined &&
				(shuttingDown ||
					runBinding !== captureCurrentBinding() ||
					requestEpoch !== transportEpoch ||
					externalStartControl.deadlineController?.signal.aborted === true ||
					externalStartControl.lifecycleController?.signal.aborted === true);
			const abandonExternalStart = (): undefined => {
				if (proposedRunId !== undefined) clearRunDeadline(runBinding, proposedRunId);
				discardRunRequest(requestClaim);
				return undefined;
			};
			let externalConnectorResolved: ExternalConnectorResolvedSelection | undefined;
			let externalCanonicalInput: CanonicalExternalAgentInput | undefined;
			if (externalConnector !== undefined) {
				if (images !== undefined && images.length > 0) {
					return startFailure(
						automationError(
							id,
							commandType,
							createAutomationError(
								"external_binding_invalid",
								"External Connector input rejects raw image payloads; use canonical trusted artifact references.",
								false,
							),
						),
					);
				}
				const registry = runBinding.session.getExternalConnectorRegistry?.();
				const safeSelection = serializeExternalConnectorSelection(externalConnector);
				if (safeSelection === undefined) {
					return startFailure(
						automationError(
							id,
							commandType,
							createAutomationError(
								"external_binding_invalid",
								"The External Connector selection is invalid.",
								false,
							),
						),
					);
				}
				if (registry === undefined) {
					return startFailure(
						automationError(
							id,
							commandType,
							createAutomationError(
								"external_connector_unavailable",
								"No trusted External Connector registry is composed into this Host.",
								false,
							),
						),
					);
				}
				const selected = await registry.select(safeSelection);
				if (externalStartWasTornDown()) return abandonExternalStart();
				if (!selected.ok) {
					const providerExists = registry
						.list()
						.some((descriptor) => descriptor.providerId === safeSelection.providerId);
					return startFailure(
						automationError(
							id,
							commandType,
							createAutomationError(
								providerExists ? "external_capability_mismatch" : "external_connector_unavailable",
								providerExists
									? "External Connector capability snapshot is unavailable or drifted."
									: "The selected External Connector is not registered in this Host.",
								false,
							),
						),
					);
				}
				const canonicalInput: CanonicalExternalAgentInput = {
					schemaVersion: 1,
					text: message,
					artifacts: artifacts ?? [],
				};
				const admitted = await gateCanonicalExternalAgentInputBeforeAcceptance(canonicalInput, {
					capabilities: {
						artifacts: selected.value.capabilitySnapshot.artifacts,
						images: selected.value.capabilitySnapshot.images,
					},
					inspectArtifact: (reference) => hostController.inspectExternalArtifact(reference),
				});
				if (externalStartWasTornDown()) return abandonExternalStart();
				if (!admitted.ok) {
					return startFailure(
						automationError(
							id,
							commandType,
							createAutomationError(admitted.error.code, admitted.error.message, false),
						),
					);
				}
				externalConnectorResolved = selected.value;
				externalCanonicalInput = admitted.input;
			}
			// Capability profile preflight: materialize the requested capability profile
			// into the frozen binding before any reservation or prompt. The public API
			// owns the undefined => configured default semantics and waits for capability
			// discovery to settle. Any profile or discovery failure is converted into a
			// structured capability error before any ledger write; an unapprovable ask
			// still fails the run below.
			try {
				// Policy selection and the Run ID must be established before capability
				// discovery. MCP startup is a policy operation and its binding must be
				// the same binding that reservation.accept validates below.
				await runBinding.session.setExecutionPolicyProfile(policyProfile);
				if (externalStartWasTornDown()) return abandonExternalStart();
				runBinding.session.setPreviousExecutionPolicyBindingIdForNextRun(previousPolicyBindingId);
				await runBinding.session.setCapabilityProfile(capabilityProfile, { runId: proposedRunId });
				if (externalStartWasTornDown()) return abandonExternalStart();
			} catch (err) {
				if (externalStartWasTornDown()) return abandonExternalStart();
				return startFailure(automationError(id, commandType, capabilityError(err)));
			}
			// The materialized profile (requested, or the configured default when omitted)
			// names the effective profile for the approval-required message below.
			const effectiveProfile = runBinding.session.getActiveCapabilityProfile();
			let reservation: RunReservation;
			try {
				reservation = runBinding.coordinator.reserve();
			} catch (err) {
				return startFailure(automationError(id, commandType, asAutomationError(err)));
			}
			runBinding.activeReservation = reservation;
			const releaseOwnReservation = (): void => {
				if (runBinding.activeReservation === reservation) runBinding.activeReservation = undefined;
				try {
					reservation.release();
				} catch {
					// Reservation may already be consumed or released by lifecycle teardown.
				}
			};
			try {
				await runBinding.session.whenCapabilitiesReady(proposedRunId);
			} catch (err) {
				releaseOwnReservation();
				if (externalStartWasTornDown()) return abandonExternalStart();
				return startFailure(automationError(id, commandType, capabilityError(err)));
			}
			if (externalStartWasTornDown()) {
				releaseOwnReservation();
				return abandonExternalStart();
			}
			if (requestEpoch !== transportEpoch) {
				releaseOwnReservation();
				return startFailure(
					automationError(
						id,
						commandType,
						createAutomationError(
							"start_rejected",
							"The RPC connection closed before the Run was accepted.",
							true,
						),
					),
				);
			}
			const preflightBinding = runBinding.session.getActiveCapabilityBinding();
			if (previousBindingId !== undefined) {
				// Resume binding-drift guard. This runs only after capability discovery has
				// settled (whenCapabilitiesReady above) so a restored MCP binding that
				// initially differs until discovery completes cannot false-fail. The binding
				// id is derived from descriptor id + revision + profile, so id equality is
				// the drift check. Rejection happens before the Session accepts a prompt, so no
				// accepted/terminal ledger write occurs.
				const knownBindings = foldCapabilityBindingEntries(runBinding.session.sessionRead.getEntries());
				if (knownBindings.get(previousBindingId) === undefined) {
					releaseOwnReservation();
					return startFailure(
						automationError(
							id,
							commandType,
							createAutomationError(
								"capability_binding_unavailable",
								`Source run ${sourceRunId} requires capability binding ${previousBindingId} which is not recorded in this session`,
								false,
							),
						),
					);
				}
				if (preflightBinding === undefined || preflightBinding.id !== previousBindingId) {
					releaseOwnReservation();
					return startFailure(
						automationError(
							id,
							commandType,
							createAutomationError(
								"capability_binding_unavailable",
								`Source run ${sourceRunId} used capability binding ${previousBindingId} but the settled binding for this session no longer matches it; the original capability set cannot be safely restored`,
								false,
							),
						),
					);
				}
			}
			// The requested profile is already materialized into the frozen binding by
			// setCapabilityProfile above, so no profile-mismatch rejection applies.
			if (preflightBinding !== undefined && preflightBinding.decisionSummary.awaitingApproval > 0) {
				releaseOwnReservation();
				return startFailure(
					automationError(
						id,
						commandType,
						createAutomationError(
							"capability_approval_required",
							`Capability profile "${effectiveProfile}" has ${preflightBinding.decisionSummary.awaitingApproval} capability(-ies) awaiting approval; the Automation Host cannot auto-approve ask.`,
							false,
						),
					),
				);
			}
			// none/agent_owned connectors own model choice and must not touch the
			// local ModelBroker. aos_gateway alone uses the exact local projection.
			const modelSelection =
				externalConnectorResolved !== undefined &&
				externalConnectorResolved.capabilitySnapshot.modelAccess !== "aos_gateway"
					? { resolution: undefined, error: undefined }
					: await resolveRequestedModel(
							runBinding,
							modelRoute,
							modelRole,
							inheritedModelBinding,
							externalConnectorResolved?.capabilitySnapshot.modelAccess !== "aos_gateway",
						);
			if (externalStartWasTornDown()) {
				releaseOwnReservation();
				return abandonExternalStart();
			}
			if (runBinding !== captureCurrentBinding()) {
				releaseOwnReservation();
				return startFailure(
					automationError(
						id,
						commandType,
						createAutomationError(
							"start_rejected",
							"The Host switched sessions before the Run was accepted.",
							true,
						),
					),
				);
			}
			if (requestEpoch !== transportEpoch) {
				releaseOwnReservation();
				return startFailure(
					automationError(
						id,
						commandType,
						createAutomationError(
							"start_rejected",
							"The RPC connection closed before the Run was accepted.",
							true,
						),
					),
				);
			}
			if (modelSelection.error !== undefined) {
				releaseOwnReservation();
				return startFailure(automationError(id, commandType, modelSelection.error));
			}
			let externalProductAdmission: ExternalConnectorProductAdmission | undefined;
			if (
				externalConnectorResolved !== undefined &&
				externalConnector !== undefined &&
				externalCanonicalInput !== undefined
			) {
				const policyBinding = runBinding.session.getActiveExecutionPolicyBinding();
				if (policyBinding === undefined || policyBinding.runId !== proposedRunId) {
					releaseOwnReservation();
					return startFailure(
						automationError(
							id,
							commandType,
							createAutomationError(
								"external_binding_invalid",
								"The canonical Execution Policy binding is unavailable for this External Connector Run.",
								false,
							),
						),
					);
				}
				let gatewayModelRoute: ExternalConnectorProductAdmission["input"]["gatewayModelRoute"];
				if (externalConnectorResolved.capabilitySnapshot.modelAccess === "aos_gateway") {
					const resolution = modelSelection.resolution;
					const effort = resolution?.reference.thinkingLevel;
					const serviceTier = resolution?.reference.serviceTier;
					const fallbackDecision =
						resolution === undefined ? undefined : externalFallbackDecisionForResolution(resolution);
					if (
						resolution === undefined ||
						effort === undefined ||
						serviceTier === undefined ||
						fallbackDecision === undefined
					) {
						releaseOwnReservation();
						return startFailure(
							automationError(
								id,
								commandType,
								createAutomationError(
									"external_binding_invalid",
									"The resolved AOS gateway model lacks an exact translatable route.",
									false,
								),
							),
						);
					}
					gatewayModelRoute = {
						provider: resolution.reference.provider,
						model: resolution.reference.id,
						effort,
						serviceTier,
						fallbackDecision,
						bindingDigest: fingerprintFoundationValue(resolution.binding),
					};
				}
				try {
					// The first selection chooses the model-access branch. This late selection
					// intentionally re-probes the pinned capability after intervening awaits so
					// capability drift cannot cross the acceptance boundary.
					externalProductAdmission = await prepareExternalConnectorProductRun({
						session: getAgentCanonicalSession(runBinding.session),
						writer: runBinding.session.agentRuntimeComposition.harness.ledger.writer,
						registry: runBinding.session.getExternalConnectorRegistry()!,
						selection: externalConnector,
						runId: proposedRunId,
						message,
						canonicalInput: externalCanonicalInput,
						inputAdmission: {
							inspectArtifact: (reference) => hostController.inspectExternalArtifact(reference),
						},
						workspace: runBinding.session.cwd,
						policyBinding,
						...(preflightBinding === undefined ? {} : { capabilityBinding: preflightBinding }),
						...(gatewayModelRoute === undefined ? {} : { gatewayModelRoute }),
					});
				} catch (err) {
					releaseOwnReservation();
					if (externalStartWasTornDown()) return abandonExternalStart();
					return startFailure(automationError(id, commandType, asAutomationError(err)));
				}
				if (externalStartWasTornDown()) {
					releaseOwnReservation();
					return abandonExternalStart();
				}
			}
			if (deadlineAt !== undefined && Date.parse(deadlineAt) <= Date.now()) {
				releaseOwnReservation();
				return startFailure(
					automationError(
						id,
						commandType,
						createAutomationError("run_deadline_exceeded", "The Run deadline expired during preflight.", false),
					),
				);
			}
			let promptPromise: Promise<unknown>;
			let startSettled = false;
			const rejectStart = (err: unknown): void => {
				if (startSettled) return;
				const bindingReplaced = runBinding !== captureCurrentBinding();
				if (runBinding.activeReservation !== reservation && !bindingReplaced) return;
				startSettled = true;
				if (runBinding.activeReservation === reservation) runBinding.activeReservation = undefined;
				clearRunDeadline(runBinding, proposedRunId);
				if (runBinding.activeReservation === undefined) {
					try {
						reservation.release();
					} catch {
						// reservation may already be consumed or released by old-binding cleanup
					}
				}
				const startError = bindingReplaced
					? createAutomationError(
							"start_rejected",
							"The Host switched sessions before the Run was accepted.",
							true,
						)
					: deadlineController.signal.aborted
						? createAutomationError(
								"run_deadline_exceeded",
								"The Run deadline was exceeded before acceptance.",
								false,
							)
						: modelSelection.resolution === undefined || (modelRoute === undefined && modelRole === undefined)
							? createAutomationError("start_rejected", errorMessage(err), false)
							: unavailableModelError();
				const response = automationError(id, commandType, startError);
				output(response);
				finishRunRequest(requestClaim, response);
			};
			if (
				externalConnectorResolved !== undefined &&
				externalConnector !== undefined &&
				externalCanonicalInput !== undefined &&
				externalProductAdmission !== undefined
			) {
				const authoritativeSelection = externalProductAdmission.selected;
				if (
					authoritativeSelection.connector !== externalConnectorResolved.connector ||
					authoritativeSelection.descriptor.schemaVersion !== externalConnectorResolved.descriptor.schemaVersion ||
					authoritativeSelection.descriptor.providerId !== externalConnectorResolved.descriptor.providerId ||
					authoritativeSelection.descriptor.providerClass !== externalConnectorResolved.descriptor.providerClass ||
					authoritativeSelection.descriptor.revision !== externalConnectorResolved.descriptor.revision ||
					authoritativeSelection.descriptor.capabilitySnapshotDigest.algorithm !==
						externalConnectorResolved.descriptor.capabilitySnapshotDigest.algorithm ||
					authoritativeSelection.descriptor.capabilitySnapshotDigest.value !==
						externalConnectorResolved.descriptor.capabilitySnapshotDigest.value
				) {
					releaseOwnReservation();
					clearRunDeadline(runBinding, proposedRunId);
					return startFailure(
						automationError(
							id,
							commandType,
							createAutomationError(
								"external_capability_mismatch",
								"External Connector authority changed during preflight.",
								false,
							),
						),
					);
				}
				if (externalStartWasTornDown() || runBinding.activeReservation !== reservation) {
					if (runBinding.activeReservation === reservation) runBinding.activeReservation = undefined;
					try {
						reservation.release();
					} catch {
						// Lifecycle teardown may already have released this reservation.
					}
					clearRunDeadline(runBinding, proposedRunId);
					discardRunRequest(requestClaim);
					return undefined;
				}
				if (
					deadlineController.signal.aborted ||
					(deadlineAt !== undefined && Date.parse(deadlineAt) <= Date.now())
				) {
					runBinding.activeReservation = undefined;
					try {
						reservation.release();
					} catch {
						// Deadline teardown may already have released this reservation.
					}
					return startFailure(
						automationError(
							id,
							commandType,
							createAutomationError(
								"run_deadline_exceeded",
								"The Run deadline was exceeded before acceptance.",
								false,
							),
						),
					);
				}
				try {
					await persistExternalConnectorProductAdmissionBeforeAcceptance(externalProductAdmission);
				} catch (err) {
					releaseOwnReservation();
					clearRunDeadline(runBinding, proposedRunId);
					return startFailure(automationError(id, commandType, asAutomationError(err)));
				}
				if (externalStartWasTornDown() || runBinding.activeReservation !== reservation) {
					if (runBinding.activeReservation === reservation) runBinding.activeReservation = undefined;
					try {
						reservation.release();
					} catch {
						// Lifecycle teardown may already have released this reservation.
					}
					clearRunDeadline(runBinding, proposedRunId);
					discardRunRequest(requestClaim);
					return undefined;
				}
				if (
					deadlineController.signal.aborted ||
					(deadlineAt !== undefined && Date.parse(deadlineAt) <= Date.now())
				) {
					runBinding.activeReservation = undefined;
					try {
						reservation.release();
					} catch {
						// Deadline teardown may already have released this reservation.
					}
					return startFailure(
						automationError(
							id,
							commandType,
							createAutomationError(
								"run_deadline_exceeded",
								"The Run deadline was exceeded before acceptance.",
								false,
							),
						),
					);
				}
				let handle: RunHandle;
				try {
					handle = reservation.accept({
						runId: proposedRunId,
						requestScope:
							clientRequestId === undefined ? undefined : commandType === "run.start" ? "start" : "resume",
						clientRequestId,
						requestFingerprint: requestClaim?.fingerprint,
						attempt,
						sourceRunId,
						deadlineAt,
						previousBindingId,
						previousPolicyBindingId,
						previousModelBindingId,
						model: {
							provider: "external_connector",
							id: authoritativeSelection.descriptor.providerId,
							thinkingLevel: "off",
						},
						capabilityBinding: runBinding.session.getActiveCapabilityBinding(),
						policyBinding: runBinding.session.getActiveExecutionPolicyBinding(),
						policySummary: runBinding.session.getActiveExecutionPolicySummary(),
					});
					handle.setUsageBaseline(usageSnapshot(runBinding));
				} catch (err) {
					releaseOwnReservation();
					clearRunDeadline(runBinding, proposedRunId);
					return startFailure(automationError(id, commandType, asAutomationError(err)));
				}
				runBinding.activeReservation = undefined;
				runBinding.activeHandle = handle;
				if (externalStartControl !== undefined) externalStartControl.accepted = true;
				runBinding.externalPendingControllers.delete(proposedRunId);
				startSettled = true;
				const startEvents = handle.start();
				const acceptedResponse: RpcAutomationResponse = {
					id,
					type: "response",
					command: commandType,
					success: true,
					data: acceptedDataFromResult(handle.result(), false, "accepted"),
				};
				output(acceptedResponse);
				finishRunRequest(requestClaim, acceptedResponse);
				for (const event of startEvents) outputRunEvent(event);
				const productIdentity = externalConnectorProductIdentity(
					proposedRunId,
					authoritativeSelection.descriptor.providerId,
				);
				runBinding.externalRuns.set(proposedRunId, {
					cancel: async () => {
						const cancelled = await authoritativeSelection.connector.cancelAttempt(productIdentity.attemptId);
						if (!cancelled.ok) throw cancelled.error;
					},
				});
				const execution = persistExternalConnectorProductRunAfterAcceptance({
					...externalProductAdmission,
					input: { ...externalProductAdmission.input, signal: deadlineController.signal },
				}).then(executePreparedExternalConnectorProductRun);
				const settlement = execution.then(() => undefined);
				runBinding.externalRunSettlements.set(proposedRunId, settlement);
				void settlement.then(
					() => {
						runBinding.externalRuns.delete(proposedRunId);
						if (runBinding.externalRunSettlements.get(proposedRunId) === settlement) {
							runBinding.externalRunSettlements.delete(proposedRunId);
						}
					},
					() => {
						runBinding.externalRuns.delete(proposedRunId);
						if (runBinding.externalRunSettlements.get(proposedRunId) === settlement) {
							runBinding.externalRunSettlements.delete(proposedRunId);
						}
					},
				);
				trackRunPrompt(runBinding, handle, execution);
				return undefined;
			}
			try {
				promptPromise = runBinding.session.prompt(message, {
					images,
					source: "rpc",
					surface: "automation_host",
					runId: proposedRunId,
					signal: deadlineController.signal,
					preflightResult: (didSucceed) => {
						if (runBinding !== captureCurrentBinding()) {
							const replacedError = new Error("The Host switched sessions before the Run was accepted.");
							rejectStart(replacedError);
							throw replacedError;
						}
						if (requestEpoch !== transportEpoch) {
							rejectStart(new Error("RPC connection closed before the Run was accepted"));
							throw new Error("RPC connection closed before the Run was accepted");
						}
						if (!didSucceed) {
							rejectStart(new Error("Preflight rejected the run input"));
							return;
						}
						if (
							deadlineController.signal.aborted ||
							(deadlineAt !== undefined && Date.parse(deadlineAt) <= Date.now())
						) {
							const deadlineError = new AgentOperationError("deadline_exceeded");
							if (!deadlineController.signal.aborted) deadlineController.abort(deadlineError);
							rejectStart(deadlineError);
							throw deadlineError;
						}
						if (runBinding.activeReservation !== reservation) return;
						let handle: RunHandle | undefined;
						let startEvents: RunStreamEvent[];
						try {
							handle = reservation.accept({
								runId: proposedRunId,
								requestScope:
									clientRequestId === undefined ? undefined : commandType === "run.start" ? "start" : "resume",
								clientRequestId,
								requestFingerprint: requestClaim?.fingerprint,
								attempt,
								sourceRunId,
								deadlineAt,
								previousBindingId,
								previousPolicyBindingId,
								previousModelBindingId,
								model: currentRunModel(runBinding),
								...(modelSelection.resolution === undefined
									? {}
									: {
											modelBindingId: modelSelection.resolution.bindingId,
											finalModel: finalModelForResolution(modelSelection.resolution),
										}),
								// Persist the frozen binding on the accepted transport record.
								capabilityBinding: runBinding.session.getActiveCapabilityBinding(),
								policyBinding: runBinding.session.getActiveExecutionPolicyBinding(),
								policySummary: runBinding.session.getActiveExecutionPolicySummary(),
							});
							handle.setUsageBaseline(usageSnapshot(runBinding));
							// Persist the started fact before publishing accepted. The returned events
							// remain buffered locally so the external contract is still accepted ->
							// run.started -> run.event* -> terminal.
							startEvents = handle.start();
						} catch (err) {
							runBinding.activeReservation = undefined;
							clearRunDeadline(runBinding, proposedRunId);
							if (handle === undefined) {
								try {
									reservation.release();
								} catch {
									// reservation may already be consumed
								}
							} else {
								// The accepted fact was durable but the started fact was not. Discard
								// the live runBinding.coordinator so this failed start cannot retain Session
								// ownership; its ledger record is replayed as interrupted if recovered.
								runBinding.coordinator = createRunLifecycleCoordinator(
									getAgentSessionLedger(runBinding.session),
								);
							}
							const response = automationError(id, commandType, asAutomationError(err));
							startSettled = true;
							output(response);
							finishRunRequest(requestClaim, response);
							// preflightResult has no rejection return value. Throwing prevents
							// AgentSession.prompt() from proceeding into the Agent loop after an
							// accepted/start ledger failure; promptPromise.catch() sees the same
							// failure but does not output a duplicate because the reservation cleared.
							throw err;
						}
						runBinding.activeReservation = undefined;
						runBinding.activeHandle = handle;
						startSettled = true;
						// Emit the accepted response before run.started and the buffered events so
						// records appear in the contract order: response -> run.started -> run.event* -> terminal.
						const acceptedResponse: RpcAutomationResponse = {
							id,
							type: "response",
							command: commandType,
							success: true,
							data: acceptedDataFromResult(handle.result(), false, "accepted"),
						};
						output(acceptedResponse);
						finishRunRequest(requestClaim, acceptedResponse);
						for (const event of startEvents) {
							outputRunEvent(event);
						}
						trackRunPrompt(runBinding, handle, promptPromise);
					},
				});
			} catch (err) {
				rejectStart(err);
				return undefined;
			}
			promptPromise.catch((err) => {
				// When preflight rejects the promise no run was started, so release and
				// report start_rejected. Otherwise the tracked prompt settled the run.
				rejectStart(err);
			});
			return undefined;
		};

		/** Helper for dialog methods with signal/timeout support */
		function createDialogPromise<T>(
			opts: ExtensionUIDialogOptions | undefined,
			defaultValue: T,
			request: Record<string, unknown>,
			parseResponse: (response: RpcExtensionUIResponse) => T,
		): Promise<T> {
			if (opts?.signal?.aborted) return Promise.resolve(defaultValue);

			const id = crypto.randomUUID();
			return new Promise((resolve, reject) => {
				let timeoutId: ReturnType<typeof setTimeout> | undefined;

				const cleanup = () => {
					if (timeoutId) clearTimeout(timeoutId);
					opts?.signal?.removeEventListener("abort", onAbort);
					pendingExtensionRequests.delete(id);
				};

				const onAbort = () => {
					cleanup();
					resolve(defaultValue);
				};
				opts?.signal?.addEventListener("abort", onAbort, { once: true });

				if (opts?.timeout) {
					timeoutId = setTimeout(() => {
						cleanup();
						resolve(defaultValue);
					}, opts.timeout);
				}

				pendingExtensionRequests.set(id, {
					resolve: (response: RpcExtensionUIResponse) => {
						cleanup();
						resolve(parseResponse(response));
					},
					reject: (error: Error) => {
						cleanup();
						reject(error);
					},
				});
				output({ type: "extension_ui_request", id, ...request } as RpcExtensionUIRequest);
			});
		}

		/**
		 * Build the `AuthInteraction` that bridges an interactive
		 * `mcp.auth.start` into the extension-UI dialog protocol.
		 *
		 * Contract (PR: MCP OAuth interaction bridge):
		 * - The MCP OAuth flow's allow/cancel consent select maps to a
		 *   `confirm` dialog; cancel/timeout/abort resolves false and the flow
		 *   classifies it as user cancellation.
		 * - The manual-code prompt (https callback mode) maps to an `input`
		 *   dialog; cancel/timeout/abort rejects the prompt so the flow fails
		 *   closed with `mcp_auth_cancelled`.
		 * - The authorization URL is delivered exactly once through the
		 *   dedicated fire-and-forget `auth_url` `extension_ui_request` record;
		 *   it never enters command responses, session events, catalogs,
		 *   status/list output, receipts, audit entries, errors, or logs, and
		 *   no token or raw URI is ever carried.
		 * - Every dialog is bounded by the flow deadline and aborts with the
		 *   host transport signal, so detach/shutdown settles pending dialogs
		 *   instead of waiting indefinitely.
		 * - Unsupported prompt shapes fail closed with a classified error
		 *   instead of echoing input.
		 */
		const createMcpAuthInteraction = (serverId: string, flowTimeoutMs: number): AuthInteraction => {
			const dialogOptions: ExtensionUIDialogOptions = {
				signal: mcpOperationController.signal,
				timeout: flowTimeoutMs,
			};
			return {
				signal: mcpOperationController.signal,
				prompt: async (prompt) => {
					if (prompt.type === "select") {
						// The MCP OAuth flow issues exactly the allow/cancel consent
						// select; any other select shape fails closed.
						if (
							prompt.options.length === 2 &&
							prompt.options[0].id === "allow" &&
							prompt.options[1].id === "cancel"
						) {
							const confirmed = await createDialogPromise(
								dialogOptions,
								false,
								{ method: "confirm", title: prompt.message, message: prompt.message, timeout: flowTimeoutMs },
								(r) => ("cancelled" in r && r.cancelled ? false : "confirmed" in r ? r.confirmed : false),
							);
							// A declined consent, a dialog cancel, a bounded-timeout
							// expiry, or an abort all resolve false and classify as
							// user cancellation.
							return confirmed ? "allow" : "cancel";
						}
						throw new MCPAuthError("auth_failed", serverId);
					}
					if (prompt.type === "manual_code" || prompt.type === "text") {
						const code = await createDialogPromise(
							dialogOptions,
							undefined,
							{
								method: "input",
								title: prompt.message,
								placeholder: prompt.placeholder,
								timeout: flowTimeoutMs,
							},
							(r) => ("cancelled" in r && r.cancelled ? undefined : "value" in r ? r.value : undefined),
						);
						if (code === undefined) {
							// Cancel, timeout, or abort of the manual-code dialog is a
							// user cancellation, never a generic failure.
							throw new MCPAuthError("user_cancelled", serverId);
						}
						return code;
					}
					// `secret` prompts must never be echoed over the wire; the MCP
					// flow never issues one, so fail closed.
					throw new MCPAuthError("auth_failed", serverId);
				},
				notify: (event) => {
					if (event.type === "auth_url") {
						// One-shot, dedicated delivery of the authorization URL. The
						// flow emits it at most once per authorize() call; the record
						// is fire-and-forget and never persisted.
						output({
							type: "extension_ui_request",
							id: crypto.randomUUID(),
							method: "auth_url",
							url: event.url,
							instructions: event.instructions,
						} as RpcExtensionUIRequest);
						return;
					}
					if (event.type === "info") {
						output({
							type: "extension_ui_request",
							id: crypto.randomUUID(),
							method: "notify",
							message: event.message,
							notifyType: "info",
						} as RpcExtensionUIRequest);
					}
					// device_code / progress events are never produced by the MCP
					// OAuth flow; ignore them rather than leaking anything.
				},
			};
		};

		/**
		 * Create an extension UI context that uses the RPC protocol.
		 */
		const createExtensionUIContext = (): ExtensionUIContext => ({
			select: (title, options, opts) =>
				createDialogPromise(opts, undefined, { method: "select", title, options, timeout: opts?.timeout }, (r) =>
					"cancelled" in r && r.cancelled ? undefined : "value" in r ? r.value : undefined,
				),

			confirm: (title, message, opts) =>
				createDialogPromise(opts, false, { method: "confirm", title, message, timeout: opts?.timeout }, (r) =>
					"cancelled" in r && r.cancelled ? false : "confirmed" in r ? r.confirmed : false,
				),

			input: (title, placeholder, opts) =>
				createDialogPromise(
					opts,
					undefined,
					{ method: "input", title, placeholder, timeout: opts?.timeout },
					(r) => ("cancelled" in r && r.cancelled ? undefined : "value" in r ? r.value : undefined),
				),

			notify(message: string, type?: "info" | "warning" | "error"): void {
				// Fire and forget - no response needed
				output({
					type: "extension_ui_request",
					id: crypto.randomUUID(),
					method: "notify",
					message,
					notifyType: type,
				} as RpcExtensionUIRequest);
			},

			onTerminalInput(): () => void {
				// Raw terminal input not supported in RPC mode
				return () => {};
			},

			setStatus(key: string, text: string | undefined): void {
				// Fire and forget - no response needed
				output({
					type: "extension_ui_request",
					id: crypto.randomUUID(),
					method: "setStatus",
					statusKey: key,
					statusText: text,
				} as RpcExtensionUIRequest);
			},

			setWorkingMessage(_message?: string): void {
				// Working message not supported in RPC mode - requires TUI loader access
			},

			setWorkingVisible(_visible: boolean): void {
				// Working visibility not supported in RPC mode - requires TUI loader access
			},

			setWorkingIndicator(_options?: WorkingIndicatorOptions): void {
				// Working indicator customization not supported in RPC mode - requires TUI loader access
			},

			setHiddenThinkingLabel(_label?: string): void {
				// Hidden thinking label not supported in RPC mode - requires TUI message rendering access
			},

			setWidget(key: string, content: unknown, options?: ExtensionWidgetOptions): void {
				// Only support string arrays in RPC mode - factory functions are ignored
				if (content === undefined || Array.isArray(content)) {
					output({
						type: "extension_ui_request",
						id: crypto.randomUUID(),
						method: "setWidget",
						widgetKey: key,
						widgetLines: content as string[] | undefined,
						widgetPlacement: options?.placement,
					} as RpcExtensionUIRequest);
				}
				// Component factories are not supported in RPC mode - would need TUI access
			},

			setFooter(_factory: unknown): void {
				// Custom footer not supported in RPC mode - requires TUI access
			},

			setHeader(_factory: unknown): void {
				// Custom header not supported in RPC mode - requires TUI access
			},

			setTitle(title: string): void {
				// Fire and forget - host can implement terminal title control
				output({
					type: "extension_ui_request",
					id: crypto.randomUUID(),
					method: "setTitle",
					title,
				} as RpcExtensionUIRequest);
			},

			async custom() {
				// Custom UI not supported in RPC mode
				return undefined as never;
			},

			pasteToEditor(text: string): void {
				// Paste handling not supported in RPC mode - falls back to setEditorText
				this.setEditorText(text);
			},

			setEditorText(text: string): void {
				// Fire and forget - host can implement editor control
				output({
					type: "extension_ui_request",
					id: crypto.randomUUID(),
					method: "set_editor_text",
					text,
				} as RpcExtensionUIRequest);
			},

			getEditorText(): string {
				// Synchronous method can't wait for RPC response
				// Host should track editor state locally if needed
				return "";
			},

			async editor(title: string, prefill?: string): Promise<string | undefined> {
				const id = crypto.randomUUID();
				return new Promise((resolve, reject) => {
					const cleanup = (): void => {
						pendingExtensionRequests.delete(id);
					};
					pendingExtensionRequests.set(id, {
						resolve: (response: RpcExtensionUIResponse) => {
							if ("cancelled" in response && response.cancelled) {
								resolve(undefined);
							} else if ("value" in response) {
								resolve(response.value);
							} else {
								resolve(undefined);
							}
						},
						reject: (error: Error) => {
							cleanup();
							reject(error);
						},
					});
					output({ type: "extension_ui_request", id, method: "editor", title, prefill } as RpcExtensionUIRequest);
				});
			},

			addAutocompleteProvider(): void {
				// Autocomplete provider composition is not supported in RPC mode
			},

			setEditorComponent(): void {
				// Custom editor components not supported in RPC mode
			},

			getEditorComponent() {
				// Custom editor components not supported in RPC mode
				return undefined;
			},

			get theme() {
				return theme;
			},

			getAllThemes() {
				return [];
			},

			getTheme(_name: string) {
				return undefined;
			},

			setTheme(_theme: string | Theme) {
				// Theme switching not supported in RPC mode
				return { success: false, error: "Theme switching not supported in RPC mode" };
			},

			getToolsExpanded() {
				// Tool expansion not supported in RPC mode - no TUI
				return false;
			},

			setToolsExpanded(_expanded: boolean) {
				// Tool expansion not supported in RPC mode - no TUI
			},
		});

		const extensionBindings = (binding: RpcSessionBinding): ExtensionBindings => ({
			uiContext: createExtensionUIContext(),
			mode: "rpc" as const,
			commandContextActions: {
				waitForIdle: () => binding.session.waitForIdle(),
				newSession: async (options) => runtimeHost.newSession(options),
				fork: async (entryId, forkOptions) => {
					const result = await runtimeHost.fork(entryId, forkOptions);
					return { cancelled: result.cancelled };
				},
				navigateTree: async (targetId, options) => {
					const result = await binding.session.navigateTree(targetId, {
						summarize: options?.summarize,
						customInstructions: options?.customInstructions,
						replaceInstructions: options?.replaceInstructions,
						label: options?.label,
					});
					return { cancelled: result.cancelled };
				},
				switchSession: async (sessionPath, options) => {
					return runtimeHost.switchSession(sessionPath, options);
				},
				reload: async () => {
					await runtimeHost.reload();
				},
			},
			shutdownHandler: () => {
				shutdownRequested = true;
			},
			onError: (err) => {
				output({ type: "extension_error", event: err.event, error: "Extension failed." });
			},
		});

		const subscribeBinding = (binding: RpcSessionBinding): void => {
			binding.unsubscribe = binding.session.subscribe((event) => {
				if (captureCurrentBinding() !== binding) return;
				if (binding.activeHandle !== undefined) {
					const emitted = binding.activeHandle.captureSessionEvent(event);
					if (emitted !== undefined) outputRunEvent(emitted);
				} else if (binding.activeReservation !== undefined) {
					// Buffer session events observed during preflight; start() flushes them.
					binding.activeReservation.captureSessionEvent(event);
				} else {
					output(toJsonEvent(serializePublicSessionEvent(event)));
				}
				if (event.type === "agent_settled") {
					if (binding.activeHandle !== undefined) {
						void observeActiveRunCompletion(binding, binding.activeHandle);
					}
					void checkShutdownRequested();
				}
			});
			binding.unsubscribeBackpressure = binding.session.agent.subscribe(async () => {
				if (captureCurrentBinding() !== binding) return;
				await waitForOutput();
			});
		};

		const disposeBinding = async (binding: RpcSessionBinding, signal?: AbortSignal): Promise<void> => {
			const cleanupFailures: unknown[] = [];
			const attempt = (cleanup: () => void): void => {
				try {
					cleanup();
				} catch (error) {
					cleanupFailures.push(error);
				}
			};
			attempt(() => binding.unsubscribe?.());
			attempt(() => binding.unsubscribeBackpressure?.());
			attempt(() => binding.activeReservation?.release());
			binding.activeReservation = undefined;
			attempt(() => binding.activeHandle?.requestCancel());
			for (const timer of binding.runDeadlineTimers.values()) clearTimeout(timer);
			for (const [runId, controller] of binding.runAbortControllers) {
				if (!binding.externalRuns.has(runId) && !binding.externalPendingControllers.has(runId)) {
					controller.abort();
				}
			}
			for (const controller of binding.externalPendingControllers.values()) controller.abort();
			const settleWithinDeadline = async (work: Promise<unknown>[]): Promise<void> => {
				const settledWork = Promise.allSettled(work);
				const settled =
					signal === undefined
						? await settledWork
						: await new Promise<Awaited<typeof settledWork> | undefined>((resolve) => {
								if (signal.aborted) {
									resolve(undefined);
									return;
								}
								const onAbort = (): void => resolve(undefined);
								signal.addEventListener("abort", onAbort, { once: true });
								void settledWork.then((results) => {
									signal.removeEventListener("abort", onAbort);
									resolve(results);
								});
							});
				for (const result of settled ?? []) {
					if (result.status === "rejected") cleanupFailures.push(result.reason);
				}
			};
			await settleWithinDeadline(
				Array.from(binding.externalRuns.values(), (externalRun) =>
					Promise.resolve().then(() => externalRun.cancel()),
				),
			);
			await settleWithinDeadline([Promise.resolve().then(() => binding.session.abort())]);
			await settleWithinDeadline([
				...binding.runPromptPromises.values(),
				...binding.externalRunSettlements.values(),
			]);
			attempt(() => binding.taskCredentialService?.onSessionShutdown());
			if (cleanupFailures.length === 1) throw cleanupFailures[0];
			if (cleanupFailures.length > 1) {
				throw new AggregateError(cleanupFailures, "RPC session binding cleanup failed");
			}
		};

		const prepareRebindSession = async (
			nextSession: AgentSession,
			previousSession: AgentSession,
		): Promise<PreparedSessionScopeRebind> => {
			if (runtimeHost.session !== previousSession || captureCurrentBinding().session !== previousSession) {
				throw new Error("RPC host session binding does not match the current runtime scope");
			}
			const previousBinding = captureCurrentBinding();
			const candidateBinding = createSessionBinding(nextSession);
			try {
				await nextSession.prepareExtensionBindings(extensionBindings(candidateBinding));
				if (hostInitialized) prepareAutomationStores(candidateBinding);
				sessionBindings.set(nextSession, candidateBinding);
				subscribeBinding(candidateBinding);
			} catch (error) {
				candidateBinding.unsubscribe?.();
				candidateBinding.unsubscribeBackpressure?.();
				sessionBindings.delete(nextSession);
				throw error;
			}
			return {
				commit: () => undefined,
				activate: () => nextSession.activateExtensionBindings(),
				disposeCandidate: () => {
					candidateBinding.unsubscribe?.();
					candidateBinding.unsubscribeBackpressure?.();
					sessionBindings.delete(nextSession);
				},
				disposePrevious: async (signal) => {
					try {
						await disposeBinding(previousBinding, signal);
					} finally {
						sessionBindings.delete(previousSession);
					}
				},
			};
		};

		runtimeHost.setPrepareSessionRebind(prepareRebindSession);
		await initialBinding.session.bindExtensions(extensionBindings(initialBinding));
		subscribeBinding(initialBinding);

		// Handle a single command
		const handleCommand = async (
			command: RpcCommand,
			// Capture one binding before the first await. Session-transition cases
			// explicitly replace this local reference after their committed switch.
			currentBinding: RpcSessionBinding = captureCurrentBinding(),
		): Promise<
			| RpcResponse
			| RpcAutomationResponse
			| RpcMcpAuthResponse
			| RpcMcpContentResponse
			| RpcWorkerResponse
			| RpcSubagentResponse
			| RpcSchedulerResponse
			| undefined
		> => {
			const id = typeof command.id === "string" ? command.id : undefined;

			// Once the Automation Host is initialized, legacy commands that would mutate
			// session/model/run state are rejected so a run and a legacy command cannot
			// compete for session ownership. Read-only queries and run.cancel/run.resume
			// remain available.
			if (hostInitialized && HOST_MUTATING_COMMANDS.has(command.type)) {
				return error(
					id,
					command.type,
					`Command "${command.type}" is not available while the Automation Host is initialized. Only read-only commands and run.cancel/run.resume are allowed.`,
				);
			}

			switch (command.type) {
				// =================================================================
				// Automation Host (protocolVersion 1)
				// =================================================================

				case "initialize": {
					if (command.protocolVersion !== 1) {
						return automationError(
							id,
							"initialize",
							createAutomationError(
								"unsupported_protocol_version",
								`Unsupported protocol version: ${command.protocolVersion}. This host supports protocolVersion 1 only.`,
								false,
							),
						);
					}
					// Idempotent: a repeat initialize re-advertises the contract without
					// recreating the coordinator or resetting run state, so an in-flight
					// reservation/run is never lost.
					if (!hostInitialized) {
						hostInitialized = true;
						prepareAutomationStores(currentBinding);
					}
					const workerRegistry = (() => {
						try {
							return currentBinding.session.getWorkerRegistry();
						} catch {
							return undefined;
						}
					})();
					const subagentRegistry = (() => {
						try {
							return currentBinding.session.getSubagentRegistry();
						} catch {
							return undefined;
						}
					})();
					const schedulerStatus = currentBinding.session.getSchedulerStatus?.();
					const taskCredentialsEnabled =
						currentBinding.session.agentRuntimeComposition.taskCredentialProvider !== undefined &&
						(currentBinding.session.agentRuntimeComposition.taskCredentialPolicyMaxTtlMs ?? 0) > 0;
					const initializeData: InitializeData = {
						host: "automation-host",
						protocolVersion: 1,
						sessionId: currentBinding.session.sessionId,
						runCommands: ["run.start", "run.get", "run.cancel", "run.resume"],
						auditCommands: ["audit.query", "audit.replay"],
						taskGateCommands: [
							"task.gate.request",
							"task.gate.get",
							"task.gate.list",
							"task.gate.approve",
							"task.gate.reject",
							"task.gate.cancel",
						],
						taskGraphCommands: [
							"task.graph.create",
							"task.graph.get",
							"task.graph.list",
							"task.graph.node.attach",
							"task.graph.node.settle",
						],
						...(taskCredentialsEnabled
							? {
									taskCredentialCommands: [
										"task.credential.issue",
										"task.credential.get",
										"task.credential.list",
										"task.credential.heartbeat",
										"task.credential.revoke",
										"task.credential.settle",
									],
								}
							: {}),
						...(workerRegistry === undefined
							? {}
							: { workerCommands: ["worker.get", "worker.list", "worker.reclaim"] }),
						...(subagentRegistry === undefined
							? {}
							: { subagentCommands: ["subagent.get", "subagent.list", "subagent.cancel"] }),
						...(schedulerStatus === undefined ? {} : { schedulerCommands: ["scheduler.status"] }),
					};
					const externalConnectorRegistry = currentBinding.session.getExternalConnectorRegistry?.();
					if (externalConnectorRegistry !== undefined) {
						initializeData.externalConnectors = externalConnectorRegistry.list();
						initializeData.externalConnectorReadiness = externalConnectorRegistry.readiness();
						initializeData.externalConnectorRuntimeStatus = externalConnectorRegistry.runtimeStatus();
					}
					const initializeResponse: RpcAutomationResponse = {
						id,
						type: "response",
						command: "initialize",
						success: true,
						data: initializeData,
					};
					return initializeResponse;
				}

				case "subagent.get": {
					if (!hostInitialized) return rpcSubagentError(id, "subagent.get", "host_not_initialized");
					if (
						!isRpcSubagentCommandShapeValid(command) ||
						!isRpcWorkerIdentifier(command.runId) ||
						!isRpcWorkerIdentifier(command.childAgentInstanceId)
					) {
						return rpcSubagentError(id, "subagent.get", "subagent_invalid");
					}
					const registry = currentBinding.session.getSubagentRegistry();
					if (registry === undefined) return rpcSubagentError(id, "subagent.get", "subagent_unavailable");
					const result = await registry.get(command.runId, command.childAgentInstanceId).catch(() => undefined);
					if (result === undefined || !result.ok)
						return rpcSubagentError(id, "subagent.get", "subagent_unavailable");
					const subagent = projectSubagentAuditSource(result.value);
					if (
						subagent === undefined ||
						subagent.sessionId !== currentBinding.session.sessionId ||
						subagent.runId !== command.runId ||
						subagent.childAgentInstanceId !== command.childAgentInstanceId
					) {
						return rpcSubagentError(id, "subagent.get", "subagent_not_found");
					}
					return {
						id,
						type: "response",
						command: "subagent.get",
						success: true,
						data: { subagent } satisfies SubagentGetData,
					};
				}

				case "subagent.list": {
					if (!hostInitialized) return rpcSubagentError(id, "subagent.list", "host_not_initialized");
					const limit = command.limit ?? RPC_SUBAGENT_DEFAULT_LIMIT;
					if (
						!isRpcSubagentCommandShapeValid(command) ||
						!isRpcWorkerIdentifier(command.runId) ||
						(command.parentAgentInstanceId !== undefined &&
							!isRpcWorkerIdentifier(command.parentAgentInstanceId)) ||
						(command.status !== undefined && !isRpcSubagentStatus(command.status)) ||
						!Number.isSafeInteger(limit) ||
						limit < 1 ||
						limit > RPC_SUBAGENT_MAX_LIMIT
					)
						return rpcSubagentError(id, "subagent.list", "subagent_invalid");
					const registry = currentBinding.session.getSubagentRegistry();
					if (registry === undefined) return rpcSubagentError(id, "subagent.list", "subagent_unavailable");
					const result = await registry
						.list(command.runId, {
							...(command.parentAgentInstanceId === undefined
								? {}
								: { parentAgentInstanceId: command.parentAgentInstanceId }),
							...(command.status === undefined ? {} : { status: command.status }),
							limit,
						})
						.catch(() => undefined);
					if (result === undefined || !result.ok)
						return rpcSubagentError(id, "subagent.list", "subagent_unavailable");
					const subagents = result.value.map(projectSubagentAuditSource);
					if (
						subagents.some(
							(entry) =>
								entry === undefined ||
								entry.sessionId !== currentBinding.session.sessionId ||
								entry.runId !== command.runId,
						)
					) {
						return rpcSubagentError(id, "subagent.list", "subagent_invalid");
					}
					return {
						id,
						type: "response",
						command: "subagent.list",
						success: true,
						data: {
							subagents: subagents as SafeSubagentLifecycleProjection[],
							truncated: result.value.length === limit,
						} satisfies SubagentListData,
					};
				}

				case "subagent.cancel": {
					if (!hostInitialized) return rpcSubagentError(id, "subagent.cancel", "host_not_initialized");
					if (
						!isRpcSubagentCommandShapeValid(command) ||
						!isRpcWorkerIdentifier(command.runId) ||
						!isRpcWorkerIdentifier(command.childAgentInstanceId)
					) {
						return rpcSubagentError(id, "subagent.cancel", "subagent_invalid");
					}
					const registry = currentBinding.session.getSubagentRegistry();
					if (registry === undefined) return rpcSubagentError(id, "subagent.cancel", "subagent_unavailable");
					const before = await registry.get(command.runId, command.childAgentInstanceId).catch(() => undefined);
					if (before === undefined || !before.ok || before.value === undefined)
						return rpcSubagentError(id, "subagent.cancel", "subagent_not_found");
					const previous = projectSubagentAuditSource(before.value);
					if (
						previous === undefined ||
						previous.sessionId !== currentBinding.session.sessionId ||
						previous.runId !== command.runId
					)
						return rpcSubagentError(id, "subagent.cancel", "subagent_not_found");
					const idempotent =
						previous.status === "cancelling" ||
						["succeeded", "failed", "cancelled", "lost", "closed"].includes(previous.status);
					const result = await registry.cancel(command.runId, command.childAgentInstanceId).catch(() => undefined);
					if (result === undefined || !result.ok || result.value === undefined)
						return rpcSubagentError(id, "subagent.cancel", "subagent_cancel_failed");
					const subagent = projectSubagentAuditSource(result.value);
					if (
						subagent === undefined ||
						subagent.sessionId !== currentBinding.session.sessionId ||
						subagent.runId !== command.runId ||
						subagent.childAgentInstanceId !== command.childAgentInstanceId
					) {
						return rpcSubagentError(id, "subagent.cancel", "subagent_cancel_failed");
					}
					return {
						id,
						type: "response",
						command: "subagent.cancel",
						success: true,
						data: { subagent, idempotent } satisfies SubagentCancelData,
					};
				}

				case "scheduler.status": {
					if (!hostInitialized) return rpcSchedulerError(id, "host_not_initialized");
					if (Object.keys(command).some((key) => key !== "id" && key !== "type")) {
						return rpcSchedulerError(id, "scheduler_unavailable");
					}
					const scheduler = currentBinding.session.getSchedulerStatus?.();
					if (scheduler === undefined) return rpcSchedulerError(id, "scheduler_unavailable");
					return {
						id,
						type: "response",
						command: "scheduler.status",
						success: true,
						data: { scheduler } satisfies SchedulerStatusData,
					};
				}

				case "worker.get": {
					if (!hostInitialized) return rpcWorkerError(id, "worker.get", "host_not_initialized");
					if (!isRpcWorkerCommandShapeValid(command) || !isRpcWorkerIdentifier(command.workerId)) {
						return rpcWorkerError(id, "worker.get", "worker_invalid");
					}
					let registry: RpcWorkerRegistry | undefined;
					try {
						registry = currentBinding.session.getWorkerRegistry();
					} catch {
						return rpcWorkerError(id, "worker.get", "worker_unavailable");
					}
					if (registry === undefined) return rpcWorkerError(id, "worker.get", "worker_unavailable");
					let record: WorkerRecord | undefined;
					try {
						record = registry.getWorkerRecord(command.workerId);
					} catch {
						return rpcWorkerError(id, "worker.get", "worker_unavailable");
					}
					if (record === undefined) {
						return rpcWorkerError(id, "worker.get", "worker_not_found");
					}
					if (!isRpcWorkerRecord(record)) return rpcWorkerError(id, "worker.get", "worker_invalid");
					if (record.sessionId !== currentBinding.session.sessionId) {
						return rpcWorkerError(id, "worker.get", "worker_not_found");
					}
					if (record.workerId !== command.workerId) return rpcWorkerError(id, "worker.get", "worker_invalid");
					return {
						id,
						type: "response",
						command: "worker.get",
						success: true,
						data: { worker: toRpcWorkerRecord(record) } satisfies WorkerGetData,
					};
				}

				case "worker.list": {
					if (!hostInitialized) return rpcWorkerError(id, "worker.list", "host_not_initialized");
					const limit = command.limit ?? RPC_WORKER_DEFAULT_LIMIT;
					if (
						!isRpcWorkerCommandShapeValid(command) ||
						(command.runId !== undefined && !isRpcWorkerIdentifier(command.runId)) ||
						(command.status !== undefined && !isRpcWorkerStatus(command.status)) ||
						!Number.isInteger(limit) ||
						limit < 1 ||
						limit > RPC_WORKER_MAX_LIMIT ||
						(command.cursor !== undefined && !isRpcWorkerIdentifier(command.cursor))
					) {
						return rpcWorkerError(id, "worker.list", "worker_invalid");
					}
					let registry: RpcWorkerRegistry | undefined;
					try {
						registry = currentBinding.session.getWorkerRegistry();
					} catch {
						return rpcWorkerError(id, "worker.list", "worker_unavailable");
					}
					if (registry === undefined) {
						return rpcWorkerError(id, "worker.list", "worker_unavailable");
					}
					let records: readonly WorkerRecord[];
					try {
						records = registry.listWorkerRecords();
					} catch {
						return rpcWorkerError(id, "worker.list", "worker_unavailable");
					}
					if (!isRpcWorkerRecordList(records)) {
						return rpcWorkerError(id, "worker.list", "worker_invalid");
					}
					const currentSessionRecords = records.filter(
						(record) => record.sessionId === currentBinding.session.sessionId,
					);
					const workerIds = new Set(currentSessionRecords.map((record) => record.workerId));
					if (workerIds.size !== currentSessionRecords.length) {
						return rpcWorkerError(id, "worker.list", "worker_invalid");
					}
					const filtered = currentSessionRecords
						.filter((record) => command.runId === undefined || record.runId === command.runId)
						.filter((record) => command.status === undefined || record.status === command.status);
					filtered.sort(
						(left, right) =>
							left.createdAt.localeCompare(right.createdAt) || left.workerId.localeCompare(right.workerId),
					);
					let offset = 0;
					if (command.cursor !== undefined) {
						const cursorIndex = filtered.findIndex((record) => record.workerId === command.cursor);
						if (cursorIndex < 0) return rpcWorkerError(id, "worker.list", "worker_invalid");
						offset = cursorIndex + 1;
					}
					const page = filtered.slice(offset, offset + limit);
					const truncated = offset + page.length < filtered.length;
					return {
						id,
						type: "response",
						command: "worker.list",
						success: true,
						data: {
							workers: page.map(toRpcWorkerRecord),
							truncated,
							...(truncated && page.length > 0 ? { nextCursor: page[page.length - 1]?.workerId } : {}),
						} satisfies WorkerListData,
					};
				}

				case "worker.reclaim": {
					if (!hostInitialized) return rpcWorkerError(id, "worker.reclaim", "host_not_initialized");
					if (!isRpcWorkerCommandShapeValid(command) || !isRpcWorkerIdentifier(command.workerId)) {
						return rpcWorkerError(id, "worker.reclaim", "worker_invalid");
					}
					let registry: RpcWorkerRegistry | undefined;
					try {
						registry = currentBinding.session.getWorkerRegistry();
					} catch {
						return rpcWorkerError(id, "worker.reclaim", "worker_unavailable");
					}
					if (registry === undefined) return rpcWorkerError(id, "worker.reclaim", "worker_unavailable");
					let existing: WorkerRecord | undefined;
					try {
						existing = registry.getWorkerRecord(command.workerId);
					} catch {
						return rpcWorkerError(id, "worker.reclaim", "worker_unavailable");
					}
					if (existing === undefined) {
						return rpcWorkerError(id, "worker.reclaim", "worker_not_found");
					}
					if (!isRpcWorkerRecord(existing)) return rpcWorkerError(id, "worker.reclaim", "worker_invalid");
					if (existing.sessionId !== currentBinding.session.sessionId) {
						return rpcWorkerError(id, "worker.reclaim", "worker_not_found");
					}
					if (existing.workerId !== command.workerId)
						return rpcWorkerError(id, "worker.reclaim", "worker_invalid");
					if (!RPC_WORKER_RECLAIMABLE_STATUSES.has(existing.status)) {
						return rpcWorkerError(id, "worker.reclaim", "worker_conflict");
					}
					const idempotent = existing.status === "reclaimed" || existing.status === "reclaim_unknown";
					let result: unknown;
					try {
						result = await registry.reclaimWorker(command.workerId);
					} catch {
						return rpcWorkerError(id, "worker.reclaim", "worker_reclaim_failed");
					}
					if (!isRpcResult(result) || !result.ok) {
						return rpcWorkerError(id, "worker.reclaim", "worker_reclaim_failed");
					}
					if (
						!isRpcWorkerRecord(result.value) ||
						result.value.workerId !== command.workerId ||
						result.value.sessionId !== currentBinding.session.sessionId ||
						!RPC_WORKER_RECLAIM_TERMINAL_STATUSES.has(result.value.status)
					) {
						return rpcWorkerError(id, "worker.reclaim", "worker_reclaim_failed");
					}
					return {
						id,
						type: "response",
						command: "worker.reclaim",
						success: true,
						data: { worker: toRpcWorkerRecord(result.value), idempotent } satisfies WorkerReclaimData,
					};
				}

				case "audit.query": {
					if (!hostInitialized || currentBinding.coordinator === undefined) {
						return automationError(id, "audit.query", hostNotInitializedError());
					}
					if (Object.keys(command).some((key) => !AUDIT_QUERY_COMMAND_KEYS.has(key))) {
						return automationError(id, "audit.query", auditCommandError(undefined, "audit_query_invalid"));
					}
					const query: AuditQuery = {
						scope: command.scope,
						...(command.sessionId === undefined ? {} : { sessionId: command.sessionId }),
						...(command.runId === undefined ? {} : { runId: command.runId }),
						...(command.types === undefined ? {} : { types: command.types }),
						...(command.from === undefined ? {} : { from: command.from }),
						...(command.to === undefined ? {} : { to: command.to }),
						...(command.cursor === undefined ? {} : { cursor: command.cursor }),
						...(command.limit === undefined ? {} : { limit: command.limit }),
					};
					try {
						const data = new ExecutionAuditQuery(getAgentSessionLedger(currentBinding.session)).query(
							query,
						) satisfies AuditQueryData;
						return { id, type: "response", command: "audit.query", success: true, data };
					} catch (err) {
						return automationError(id, "audit.query", auditCommandError(err, "audit_query_invalid"));
					}
				}

				case "audit.replay": {
					if (!hostInitialized || currentBinding.coordinator === undefined) {
						return automationError(id, "audit.replay", hostNotInitializedError());
					}
					if (Object.keys(command).some((key) => !AUDIT_REPLAY_COMMAND_KEYS.has(key))) {
						return automationError(id, "audit.replay", auditCommandError(undefined, "audit_query_invalid"));
					}
					const query: AuditReplayQuery = {
						runId: command.runId,
						...(command.scope === undefined ? {} : { scope: command.scope }),
						...(command.sessionId === undefined ? {} : { sessionId: command.sessionId }),
						...(command.types === undefined ? {} : { types: command.types }),
						...(command.from === undefined ? {} : { from: command.from }),
						...(command.to === undefined ? {} : { to: command.to }),
						...(command.cursor === undefined ? {} : { cursor: command.cursor }),
						...(command.limit === undefined ? {} : { limit: command.limit }),
					};
					try {
						const data = new ExecutionAuditQuery(getAgentSessionLedger(currentBinding.session)).replay(
							query,
						) satisfies AuditReplayData;
						return { id, type: "response", command: "audit.replay", success: true, data };
					} catch (err) {
						return automationError(id, "audit.replay", auditCommandError(err, "audit_replay_incomplete"));
					}
				}

				case "task.gate.request": {
					if (!hostInitialized || currentBinding.taskGateStore === undefined) {
						return automationError(id, "task.gate.request", hostNotInitializedError());
					}
					if (!isTaskGateCommandShapeValid(command)) {
						return automationError(id, "task.gate.request", taskGateCommandError(undefined, "task_gate_invalid"));
					}
					try {
						const result = currentBinding.taskGateStore.request({
							taskId: command.taskId,
							stageId: command.stageId,
							stageRevision: command.stageRevision,
							clientRequestId: command.clientRequestId,
							...(command.runId === undefined ? {} : { runId: command.runId }),
						});
						return {
							id,
							type: "response",
							command: "task.gate.request",
							success: true,
							data: { gate: result.gate, idempotent: result.idempotent },
						};
					} catch (err) {
						return automationError(id, "task.gate.request", taskGateCommandError(err, "task_gate_invalid"));
					}
				}

				case "task.gate.get": {
					if (!hostInitialized || currentBinding.taskGateStore === undefined) {
						return automationError(id, "task.gate.get", hostNotInitializedError());
					}
					if (!isTaskGateCommandShapeValid(command)) {
						return automationError(id, "task.gate.get", taskGateCommandError(undefined, "task_gate_invalid"));
					}
					try {
						const gate = currentBinding.taskGateStore.get(command.gateId);
						if (gate === undefined) {
							return automationError(
								id,
								"task.gate.get",
								taskGateCommandError(undefined, "task_gate_not_found"),
							);
						}
						return { id, type: "response", command: "task.gate.get", success: true, data: { gate } };
					} catch (err) {
						return automationError(id, "task.gate.get", taskGateCommandError(err, "task_gate_invalid"));
					}
				}

				case "task.gate.list": {
					if (!hostInitialized || currentBinding.taskGateStore === undefined) {
						return automationError(id, "task.gate.list", hostNotInitializedError());
					}
					if (!isTaskGateCommandShapeValid(command)) {
						return automationError(id, "task.gate.list", taskGateCommandError(undefined, "task_gate_invalid"));
					}
					try {
						const result = currentBinding.taskGateStore.list({
							...(command.taskId === undefined ? {} : { taskId: command.taskId }),
							...(command.stageId === undefined ? {} : { stageId: command.stageId }),
							...(command.status === undefined ? {} : { status: command.status }),
							...(command.limit === undefined ? {} : { limit: command.limit }),
						});
						return {
							id,
							type: "response",
							command: "task.gate.list",
							success: true,
							data: { gates: [...result.gates], truncated: result.truncated },
						};
					} catch (err) {
						return automationError(id, "task.gate.list", taskGateCommandError(err, "task_gate_invalid"));
					}
				}

				case "task.gate.approve":
				case "task.gate.reject":
				case "task.gate.cancel": {
					if (!hostInitialized || currentBinding.taskGateStore === undefined) {
						return automationError(id, command.type, hostNotInitializedError());
					}
					if (!isTaskGateCommandShapeValid(command)) {
						return automationError(id, command.type, taskGateCommandError(undefined, "task_gate_invalid"));
					}
					try {
						const decision: {
							gateId: string;
							clientRequestId: string;
							actorId?: string;
							reasonCode?: string;
						} = {
							gateId: command.gateId,
							clientRequestId: command.clientRequestId,
							...(command.actorId === undefined ? {} : { actorId: command.actorId }),
							...(command.type === "task.gate.reject" && command.reasonCode !== undefined
								? { reasonCode: command.reasonCode }
								: {}),
						};
						const result =
							command.type === "task.gate.approve"
								? currentBinding.taskGateStore.approve(decision)
								: command.type === "task.gate.reject"
									? currentBinding.taskGateStore.reject(decision)
									: currentBinding.taskGateStore.cancel(decision);
						return {
							id,
							type: "response",
							command: command.type,
							success: true,
							data: { gate: result.gate, idempotent: result.idempotent },
						};
					} catch (err) {
						return automationError(id, command.type, taskGateCommandError(err, "task_gate_invalid"));
					}
				}

				case "task.graph.create": {
					if (!hostInitialized || currentBinding.taskGraphStore === undefined) {
						return automationError(id, "task.graph.create", hostNotInitializedError());
					}
					if (!isTaskGraphCommandShapeValid(command)) {
						return automationError(
							id,
							"task.graph.create",
							taskGraphCommandError(undefined, "task_graph_invalid"),
						);
					}
					try {
						const result = currentBinding.taskGraphStore.create({
							taskId: command.taskId,
							graphRevision: command.graphRevision,
							nodes: command.nodes,
							clientRequestId: command.clientRequestId,
						});
						return taskGraphMutationResponse(id, "task.graph.create", result);
					} catch (err) {
						return automationError(id, "task.graph.create", taskGraphCommandError(err, "task_graph_invalid"));
					}
				}

				case "task.graph.get": {
					if (!hostInitialized || currentBinding.taskGraphStore === undefined) {
						return automationError(id, "task.graph.get", hostNotInitializedError());
					}
					if (!isTaskGraphCommandShapeValid(command)) {
						return automationError(id, "task.graph.get", taskGraphCommandError(undefined, "task_graph_invalid"));
					}
					try {
						const graph = currentBinding.taskGraphStore.get(command.taskId, command.graphRevision);
						if (graph === undefined) {
							return automationError(
								id,
								"task.graph.get",
								taskGraphCommandError(undefined, "task_graph_not_found"),
							);
						}
						return {
							id,
							type: "response",
							command: "task.graph.get",
							success: true,
							data: { graph } satisfies TaskGraphGetData,
						};
					} catch (err) {
						return automationError(id, "task.graph.get", taskGraphCommandError(err, "task_graph_invalid"));
					}
				}

				case "task.graph.list": {
					if (!hostInitialized || currentBinding.taskGraphStore === undefined) {
						return automationError(id, "task.graph.list", hostNotInitializedError());
					}
					if (!isTaskGraphCommandShapeValid(command)) {
						return automationError(id, "task.graph.list", taskGraphCommandError(undefined, "task_graph_invalid"));
					}
					try {
						const result = currentBinding.taskGraphStore.list({
							...(command.taskId === undefined ? {} : { taskId: command.taskId }),
							...(command.graphRevision === undefined ? {} : { graphRevision: command.graphRevision }),
							...(command.status === undefined ? {} : { status: command.status }),
							...(command.limit === undefined ? {} : { limit: command.limit }),
						});
						return {
							id,
							type: "response",
							command: "task.graph.list",
							success: true,
							data: { graphs: [...result.graphs], truncated: result.truncated } satisfies TaskGraphListData,
						};
					} catch (err) {
						return automationError(id, "task.graph.list", taskGraphCommandError(err, "task_graph_invalid"));
					}
				}

				case "task.graph.node.attach": {
					if (!hostInitialized || currentBinding.taskGraphStore === undefined) {
						return automationError(id, "task.graph.node.attach", hostNotInitializedError());
					}
					if (!isTaskGraphCommandShapeValid(command)) {
						return automationError(
							id,
							"task.graph.node.attach",
							taskGraphCommandError(undefined, "task_graph_invalid"),
						);
					}
					try {
						const result = currentBinding.taskGraphStore.attach({
							taskId: command.taskId,
							graphRevision: command.graphRevision,
							nodeId: command.nodeId,
							runId: command.runId,
							clientRequestId: command.clientRequestId,
						});
						return taskGraphMutationResponse(id, "task.graph.node.attach", result);
					} catch (err) {
						return automationError(
							id,
							"task.graph.node.attach",
							taskGraphCommandError(err, "task_graph_invalid"),
						);
					}
				}

				case "task.graph.node.settle": {
					if (!hostInitialized || currentBinding.taskGraphStore === undefined) {
						return automationError(id, "task.graph.node.settle", hostNotInitializedError());
					}
					if (!isTaskGraphCommandShapeValid(command)) {
						return automationError(
							id,
							"task.graph.node.settle",
							taskGraphCommandError(undefined, "task_graph_invalid"),
						);
					}
					try {
						const result = currentBinding.taskGraphStore.settle({
							taskId: command.taskId,
							graphRevision: command.graphRevision,
							nodeId: command.nodeId,
							clientRequestId: command.clientRequestId,
						});
						return taskGraphMutationResponse(id, "task.graph.node.settle", result);
					} catch (err) {
						return automationError(
							id,
							"task.graph.node.settle",
							taskGraphCommandError(err, "task_graph_invalid"),
						);
					}
				}

				case "task.credential.issue": {
					if (!hostInitialized || currentBinding.coordinator === undefined) {
						return automationError(id, "task.credential.issue", hostNotInitializedError());
					}
					if (currentBinding.taskCredentialService === undefined) {
						return automationError(
							id,
							"task.credential.issue",
							createAutomationError(
								"task_credential_unavailable",
								taskCredentialErrorMessage("task_credential_unavailable"),
								false,
							),
						);
					}
					if (!isTaskCredentialCommandShapeValid(command)) {
						return automationError(
							id,
							"task.credential.issue",
							taskCredentialCommandError(undefined, "task_credential_invalid"),
						);
					}
					try {
						// Current-Session ownership: the grant is bound to a Run of this
						// Session's ledger, so a lease can never be issued for another
						// Session or a phantom Run. The service itself is session-scoped.
						const boundRun = currentBinding.coordinator.getRun(command.runId);
						if (boundRun === undefined || boundRun.record.sessionId !== currentBinding.session.sessionId) {
							return automationError(
								id,
								"task.credential.issue",
								taskCredentialCommandError(undefined, "task_credential_binding_invalid"),
							);
						}
						// T3 preflight: the host-resolvable read-only facts (gate
						// approval, node attach, TTL bounds, scope structure) must pass
						// before the service is touched.
						const preflightDenied = taskCredentialIssuePreflight(currentBinding, {
							taskId: command.taskId,
							graphRevision: command.graphRevision,
							nodeId: command.nodeId,
							...(command.stageId === undefined ? {} : { stageId: command.stageId }),
							...(command.stageRevision === undefined ? {} : { stageRevision: command.stageRevision }),
							runId: command.runId,
							scopes: command.scopes,
							requestedTtlMs: command.requestedTtlMs,
						});
						if (preflightDenied !== undefined) {
							return automationError(
								id,
								"task.credential.issue",
								taskCredentialCommandError(undefined, preflightDenied),
							);
						}
						const result = currentBinding.taskCredentialService.issueForTaskRun({
							taskId: command.taskId,
							graphRevision: command.graphRevision,
							nodeId: command.nodeId,
							...(command.stageId === undefined ? {} : { stageId: command.stageId }),
							...(command.stageRevision === undefined ? {} : { stageRevision: command.stageRevision }),
							runId: command.runId,
							capabilityBindingId: command.capabilityBindingId,
							policyBindingId: command.policyBindingId,
							...(command.sandboxBindingId === undefined ? {} : { sandboxBindingId: command.sandboxBindingId }),
							...(command.targetId === undefined ? {} : { targetId: command.targetId }),
							...(command.targetKind === undefined ? {} : { targetKind: command.targetKind }),
							...(command.workerId === undefined ? {} : { workerId: command.workerId }),
							scopes: command.scopes,
							requestedTtlMs: command.requestedTtlMs,
							clientRequestId: command.clientRequestId,
							...(command.stageId === undefined || command.stageRevision === undefined
								? {}
								: {
										gate: resolveGateFact(
											currentBinding,
											command.taskId,
											command.stageId,
											command.stageRevision,
										),
									}),
							nodeAttached: resolveNodeAttached(
								currentBinding,
								command.taskId,
								command.graphRevision,
								command.nodeId,
								command.runId,
							),
						});
						if (!result.ok) {
							return automationError(
								id,
								"task.credential.issue",
								taskCredentialCommandError(undefined, result.code),
							);
						}
						return {
							id,
							type: "response",
							command: "task.credential.issue",
							success: true,
							data: {
								grant: serializeTaskCredentialGrant(result.grant),
								leaseId: result.leaseId,
								bindingId: result.bindingId,
								...(result.delivery === undefined
									? {}
									: { delivery: serializeTaskCredentialDeliveryReceipt(result.delivery) }),
								idempotent: result.idempotent,
							} satisfies TaskCredentialIssueData,
						};
					} catch (err) {
						return automationError(
							id,
							"task.credential.issue",
							taskCredentialCommandError(err, "task_credential_invalid"),
						);
					}
				}

				case "task.credential.get": {
					if (!hostInitialized) {
						return automationError(id, "task.credential.get", hostNotInitializedError());
					}
					if (currentBinding.taskCredentialService === undefined) {
						return automationError(
							id,
							"task.credential.get",
							createAutomationError(
								"task_credential_unavailable",
								taskCredentialErrorMessage("task_credential_unavailable"),
								false,
							),
						);
					}
					if (!isTaskCredentialCommandShapeValid(command)) {
						return automationError(
							id,
							"task.credential.get",
							taskCredentialCommandError(undefined, "task_credential_invalid"),
						);
					}
					try {
						const grant = currentBinding.taskCredentialService.get(command.leaseId);
						if (grant === undefined) {
							return automationError(
								id,
								"task.credential.get",
								taskCredentialCommandError(undefined, "task_credential_not_found"),
							);
						}
						return {
							id,
							type: "response",
							command: "task.credential.get",
							success: true,
							data: { grant: serializeTaskCredentialGrant(grant) } satisfies TaskCredentialGetData,
						};
					} catch (err) {
						return automationError(
							id,
							"task.credential.get",
							taskCredentialCommandError(err, "task_credential_invalid"),
						);
					}
				}

				case "task.credential.list": {
					if (!hostInitialized) {
						return automationError(id, "task.credential.list", hostNotInitializedError());
					}
					if (currentBinding.taskCredentialService === undefined) {
						return automationError(
							id,
							"task.credential.list",
							createAutomationError(
								"task_credential_unavailable",
								taskCredentialErrorMessage("task_credential_unavailable"),
								false,
							),
						);
					}
					if (!isTaskCredentialCommandShapeValid(command)) {
						return automationError(
							id,
							"task.credential.list",
							taskCredentialCommandError(undefined, "task_credential_invalid"),
						);
					}
					const status =
						command.status === undefined || isTaskCredentialStatusValue(command.status)
							? command.status
							: undefined;
					if (status === undefined && command.status !== undefined) {
						return automationError(
							id,
							"task.credential.list",
							taskCredentialCommandError(undefined, "task_credential_invalid"),
						);
					}
					if (command.limit !== undefined && !isPositiveInteger(command.limit)) {
						return automationError(
							id,
							"task.credential.list",
							taskCredentialCommandError(undefined, "task_credential_invalid"),
						);
					}
					try {
						const grants = currentBinding.taskCredentialService.list({
							...(command.taskId === undefined ? {} : { taskId: command.taskId }),
							...(command.nodeId === undefined ? {} : { nodeId: command.nodeId }),
							...(command.runId === undefined ? {} : { runId: command.runId }),
							...(status === undefined ? {} : { status }),
						});
						const limit = command.limit;
						const page = limit === undefined ? grants : grants.slice(0, limit);
						return {
							id,
							type: "response",
							command: "task.credential.list",
							success: true,
							data: {
								grants: [...page].map((grant) => serializeTaskCredentialGrant(grant)),
								truncated: limit !== undefined && grants.length > limit,
							} satisfies TaskCredentialListData,
						};
					} catch (err) {
						return automationError(
							id,
							"task.credential.list",
							taskCredentialCommandError(err, "task_credential_invalid"),
						);
					}
				}

				case "task.credential.heartbeat": {
					if (!hostInitialized) {
						return automationError(id, "task.credential.heartbeat", hostNotInitializedError());
					}
					if (currentBinding.taskCredentialService === undefined) {
						return automationError(
							id,
							"task.credential.heartbeat",
							createAutomationError(
								"task_credential_unavailable",
								taskCredentialErrorMessage("task_credential_unavailable"),
								false,
							),
						);
					}
					if (!isTaskCredentialCommandShapeValid(command)) {
						return automationError(
							id,
							"task.credential.heartbeat",
							taskCredentialCommandError(undefined, "task_credential_invalid"),
						);
					}
					try {
						// The renew preflight facts are host-resolvable from the
						// lease's own grant and stores: the stage pair's Gate and the
						// graph node attach of the lease's run context.
						const grant = currentBinding.taskCredentialService.get(command.leaseId);
						let gate: TaskCredentialGatePreflight | undefined;
						let nodeAttached = false;
						if (grant !== undefined) {
							if (grant.stageId !== undefined && grant.stageRevision !== undefined) {
								gate = resolveGateFact(currentBinding, grant.taskId, grant.stageId, grant.stageRevision);
							}
							nodeAttached = resolveNodeAttached(
								currentBinding,
								grant.taskId,
								grant.graphRevision,
								grant.nodeId,
								grant.runId,
							);
						}
						const result = currentBinding.taskCredentialService.renew({
							leaseId: command.leaseId,
							grantId: command.grantId,
							bindingId: command.bindingId,
							heartbeatSequence: command.heartbeatSequence,
							requestedTtlMs: command.requestedTtlMs,
							clientRequestId: command.clientRequestId,
							...(gate === undefined ? {} : { gate }),
							nodeAttached,
						});
						if (!result.ok) {
							return automationError(
								id,
								"task.credential.heartbeat",
								taskCredentialCommandError(undefined, result.code),
							);
						}
						return {
							id,
							type: "response",
							command: "task.credential.heartbeat",
							success: true,
							data: {
								grant: serializeTaskCredentialGrant(result.grant),
								leaseId: result.leaseId,
								bindingId: result.bindingId,
								idempotent: result.idempotent,
							} satisfies TaskCredentialHeartbeatData,
						};
					} catch (err) {
						return automationError(
							id,
							"task.credential.heartbeat",
							taskCredentialCommandError(err, "task_credential_invalid"),
						);
					}
				}

				case "task.credential.revoke": {
					if (!hostInitialized) {
						return automationError(id, "task.credential.revoke", hostNotInitializedError());
					}
					if (currentBinding.taskCredentialService === undefined) {
						return automationError(
							id,
							"task.credential.revoke",
							createAutomationError(
								"task_credential_unavailable",
								taskCredentialErrorMessage("task_credential_unavailable"),
								false,
							),
						);
					}
					if (!isTaskCredentialCommandShapeValid(command)) {
						return automationError(
							id,
							"task.credential.revoke",
							taskCredentialCommandError(undefined, "task_credential_invalid"),
						);
					}
					try {
						// The revoke preflight facts are host-resolvable from the
						// lease's own grant and stores (same resolution as renew).
						const grant = currentBinding.taskCredentialService.get(command.leaseId);
						let gate: TaskCredentialGatePreflight | undefined;
						let nodeAttached = false;
						if (grant !== undefined) {
							if (grant.stageId !== undefined && grant.stageRevision !== undefined) {
								gate = resolveGateFact(currentBinding, grant.taskId, grant.stageId, grant.stageRevision);
							}
							nodeAttached = resolveNodeAttached(
								currentBinding,
								grant.taskId,
								grant.graphRevision,
								grant.nodeId,
								grant.runId,
							);
						}
						const result = currentBinding.taskCredentialService.revoke({
							leaseId: command.leaseId,
							...(command.reasonCode === undefined ? {} : { reasonCode: command.reasonCode }),
							clientRequestId: command.clientRequestId,
							...(gate === undefined ? {} : { gate }),
							nodeAttached,
						});
						if (!result.ok) {
							return automationError(
								id,
								"task.credential.revoke",
								taskCredentialCommandError(undefined, result.code),
							);
						}
						return {
							id,
							type: "response",
							command: "task.credential.revoke",
							success: true,
							data: {
								grant: serializeTaskCredentialGrant(result.grant),
								idempotent: result.idempotent,
							} satisfies TaskCredentialRevokeData,
						};
					} catch (err) {
						return automationError(
							id,
							"task.credential.revoke",
							taskCredentialCommandError(err, "task_credential_invalid"),
						);
					}
				}

				case "task.credential.settle": {
					if (!hostInitialized) {
						return automationError(id, "task.credential.settle", hostNotInitializedError());
					}
					if (currentBinding.taskCredentialService === undefined) {
						return automationError(
							id,
							"task.credential.settle",
							createAutomationError(
								"task_credential_unavailable",
								taskCredentialErrorMessage("task_credential_unavailable"),
								false,
							),
						);
					}
					if (!isTaskCredentialCommandShapeValid(command)) {
						return automationError(
							id,
							"task.credential.settle",
							taskCredentialCommandError(undefined, "task_credential_invalid"),
						);
					}
					try {
						const result = currentBinding.taskCredentialService.settle({
							leaseId: command.leaseId,
							...(command.reasonCode === undefined ? {} : { reasonCode: command.reasonCode }),
							clientRequestId: command.clientRequestId,
						});
						if (!result.ok) {
							return automationError(
								id,
								"task.credential.settle",
								taskCredentialCommandError(undefined, result.code),
							);
						}
						return {
							id,
							type: "response",
							command: "task.credential.settle",
							success: true,
							data: {
								grant: serializeTaskCredentialGrant(result.grant),
								idempotent: result.idempotent,
							} satisfies TaskCredentialSettleData,
						};
					} catch (err) {
						return automationError(
							id,
							"task.credential.settle",
							taskCredentialCommandError(err, "task_credential_invalid"),
						);
					}
				}

				case "run.start": {
					if (command.externalConnector === undefined && command.artifacts !== undefined) {
						return automationError(
							id,
							"run.start",
							createAutomationError(
								"external_binding_invalid",
								"Canonical external resources require an External Connector selection.",
								false,
							),
						);
					}
					if (
						command.externalConnector !== undefined &&
						!Object.keys(command).every((key) => EXTERNAL_RUN_START_KEYS.has(key))
					) {
						return automationError(
							id,
							"run.start",
							createAutomationError(
								"external_binding_invalid",
								"RPC External Connector input contains an unsupported field.",
								false,
							),
						);
					}
					const externalStartControl =
						command.externalConnector === undefined ? undefined : ({} satisfies ExternalPendingStartControl);
					return trackPendingStart(
						startRun(
							currentBinding,
							id,
							"run.start",
							command.message,
							command.images,
							command.artifacts,
							1,
							undefined,
							command.capabilityProfile,
							command.policyProfile,
							undefined,
							undefined,
							undefined,
							undefined,
							command.modelRoute,
							command.modelRole,
							command.externalConnector,
							command.deadlineAt,
							command.clientRequestId,
							undefined,
							false,
							undefined,
							externalStartControl,
						),
						currentBinding,
						externalStartControl,
						id,
						"run.start",
					);
				}

				case "run.get": {
					if (!hostInitialized || currentBinding.coordinator === undefined) {
						return automationError(id, "run.get", hostNotInitializedError());
					}
					const result = currentBinding.coordinator.getRun(command.runId);
					if (result === undefined) {
						return automationError(
							id,
							"run.get",
							createAutomationError("run_not_found", `Run not found: ${command.runId}`, false),
						);
					}
					const getData: RunGetData = { run: serializePublicRunRecord(result.record) };
					if (result.receipt !== undefined) getData.receipt = serializePublicRunReceipt(result.receipt);
					if (result.recovery !== undefined) getData.recovery = result.recovery;
					const getResponse: RpcAutomationResponse = {
						id,
						type: "response",
						command: "run.get",
						success: true,
						data: getData,
					};
					return getResponse;
				}

				case "run.cancel": {
					if (!hostInitialized || currentBinding.coordinator === undefined) {
						return automationError(id, "run.cancel", hostNotInitializedError());
					}
					const result = currentBinding.coordinator.getRun(command.runId);
					if (result === undefined) {
						return automationError(
							id,
							"run.cancel",
							createAutomationError("run_not_found", `Run not found: ${command.runId}`, false),
						);
					}
					if (isTerminalStatus(result.record.status)) {
						const cancelResponse: RpcAutomationResponse = {
							id,
							type: "response",
							command: "run.cancel",
							success: true,
							data: { runId: command.runId, status: result.record.status },
						};
						return cancelResponse;
					}
					const recoveringExternalRun = currentBinding.externalRuns.get(command.runId);
					if (
						(currentBinding.activeHandle === undefined || currentBinding.activeHandle.runId !== command.runId) &&
						recoveringExternalRun === undefined
					) {
						return automationError(
							id,
							"run.cancel",
							createAutomationError(
								"run_not_cancellable",
								`Run ${command.runId} is not in a cancellable state`,
								false,
							),
						);
					}
					currentBinding.activeHandle?.requestCancel();
					// Cancellation is a request, not the terminal transition. An external
					// agent run forwards one same-Attempt Connector cancel without
					// aborting the deadline signal; a local run
					// triggers the existing abort path without waiting for its idle
					// promise so the command response describes the current running
					// state. A terminal event is emitted only after canonical lookup.
					const externalRun = recoveringExternalRun;
					if (externalRun !== undefined) {
						void externalRun.cancel().catch(() => {
							// The tracked product execution owns canonical terminal or reconciliation output.
						});
					} else {
						void currentBinding.session.abort().catch(() => {
							// Foundation remains the only terminal authority.
						});
					}
					const cancelResponse: RpcAutomationResponse = {
						id,
						type: "response",
						command: "run.cancel",
						success: true,
						data: { runId: command.runId, status: result.record.status },
					};
					return cancelResponse;
				}

				case "run.resume": {
					return trackPendingStart(
						(async (): Promise<RpcAutomationResponse | undefined> => {
							const requestEpoch = transportEpoch;
							const inputError = slashRunInputError(id, "run.resume", command.message);
							if (inputError !== undefined) return inputError;
							if (command.externalConnector === undefined && command.artifacts !== undefined) {
								return automationError(
									id,
									"run.resume",
									createAutomationError(
										"external_binding_invalid",
										"Canonical external resources require an External Connector selection.",
										false,
									),
								);
							}
							if (
								command.externalConnector !== undefined &&
								!Object.keys(command).every((key) => EXTERNAL_RUN_RESUME_KEYS.has(key))
							) {
								return automationError(
									id,
									"run.resume",
									createAutomationError(
										"external_binding_invalid",
										"RPC External Connector input contains an unsupported field.",
										false,
									),
								);
							}
							if (
								command.externalConnector !== undefined &&
								!isExternalConnectorSelection(command.externalConnector)
							) {
								return automationError(
									id,
									"run.resume",
									createAutomationError(
										"external_binding_invalid",
										"The External Connector selection is invalid.",
										false,
									),
								);
							}
							if (command.externalConnector !== undefined) {
								const registry = currentBinding.session.getExternalConnectorRegistry?.();
								if (registry === undefined) {
									return automationError(
										id,
										"run.resume",
										createAutomationError(
											"external_connector_unavailable",
											"No trusted External Connector registry is composed into this Host.",
											false,
										),
									);
								}
								const descriptor = registry
									.list()
									.find((candidate) => candidate.providerId === command.externalConnector?.providerId);
								if (
									descriptor === undefined ||
									descriptor.revision !== command.externalConnector.revision ||
									descriptor.capabilitySnapshotDigest.algorithm !==
										command.externalConnector.capabilitySnapshotDigest.algorithm ||
									descriptor.capabilitySnapshotDigest.value !==
										command.externalConnector.capabilitySnapshotDigest.value
								) {
									return automationError(
										id,
										"run.resume",
										createAutomationError(
											descriptor === undefined
												? "external_connector_unavailable"
												: "external_capability_mismatch",
											descriptor !== undefined
												? "External Connector capability snapshot is unavailable or drifted."
												: "The selected External Connector is not registered in this Host.",
											false,
										),
									);
								}
							}
							if (command.clientRequestId !== undefined && !isRunClientRequestId(command.clientRequestId)) {
								return automationError(
									id,
									"run.resume",
									createAutomationError(
										"client_request_id_invalid",
										"The client request id is invalid.",
										false,
									),
								);
							}
							if (command.deadlineAt !== undefined && !isRunTimestamp(command.deadlineAt)) {
								return automationError(
									id,
									"run.resume",
									createAutomationError(
										"run_deadline_invalid",
										"The Run deadline must be a canonical UTC timestamp.",
										false,
									),
								);
							}
							if (command.deadlineAt !== undefined && Date.parse(command.deadlineAt) <= Date.now()) {
								return automationError(
									id,
									"run.resume",
									createAutomationError(
										"run_deadline_exceeded",
										"The Run deadline has already expired.",
										false,
									),
								);
							}
							if (shuttingDown) {
								return automationError(
									id,
									"run.resume",
									createAutomationError(
										"start_rejected",
										"Automation Host is shutting down; no new runs are accepted.",
										false,
									),
								);
							}
							if (!hostInitialized || currentBinding.coordinator === undefined) {
								return automationError(id, "run.resume", hostNotInitializedError());
							}
							let targetLedger: ReturnType<typeof loadReadOnlyRunCoordinator>;
							try {
								targetLedger =
									command.clientRequestId === undefined
										? undefined
										: loadReadOnlyRunCoordinator(command.sessionPath);
							} catch {
								return automationError(
									id,
									"run.resume",
									createAutomationError(
										"source_run_not_resumable",
										"The source Session contains conflicting Run terminal evidence.",
										false,
									),
								);
							}
							const targetSessionId = targetLedger?.sessionId ?? hashResumeTargetPath(command.sessionPath);
							const resumeIdentity = requestIdentity(command.clientRequestId, "run.resume", targetSessionId, {
								message: command.message,
								images: command.images,
								artifacts: command.artifacts,
								targetSessionId,
								sourceRunId: command.sourceRunId,
								capabilityProfile: command.capabilityProfile,
								policyProfile: command.policyProfile,
								modelRoute: command.modelRoute,
								modelRole: command.modelRole,
								externalConnector: command.externalConnector,
								deadlineAt: command.deadlineAt,
							});
							let resumeClaim: RunRequestIdentity | undefined;
							if (resumeIdentity !== undefined) {
								const gate = beginRunRequest(id, "run.resume", resumeIdentity, () =>
									targetSessionId === currentBinding.session.sessionId
										? (currentBinding.coordinator?.getRunByClientRequestId(
												resumeIdentity.clientRequestId,
												"resume",
											) ?? targetLedger?.getRunByClientRequestId(resumeIdentity.clientRequestId, "resume"))
										: targetLedger?.getRunByClientRequestId(resumeIdentity.clientRequestId, "resume"),
								);
								if (gate.kind === "response") return gate.response;
								if (gate.kind === "pending") return undefined;
								if (gate.kind === "new") resumeClaim = gate.identity;
							}
							const resumeFailure = (response: RpcAutomationResponse): RpcAutomationResponse => {
								finishRunRequest(resumeClaim, response);
								return response;
							};
							const connectionClosedResponse = (): RpcAutomationResponse =>
								automationError(
									id,
									"run.resume",
									createAutomationError(
										"start_rejected",
										"The RPC connection closed before the Run was accepted.",
										true,
									),
								);
							if (requestEpoch !== transportEpoch) return resumeFailure(connectionClosedResponse());
							if (
								currentBinding.coordinator.activeRun !== undefined ||
								currentBinding.activeReservation !== undefined
							) {
								return resumeFailure(
									automationError(
										id,
										"run.resume",
										createAutomationError(
											"session_busy",
											"A run is already active in this session. Wait for its terminal event before starting another.",
											true,
										),
									),
								);
							}
							if (currentBinding.session.sessionFile === undefined) {
								return resumeFailure(
									automationError(
										id,
										"run.resume",
										createAutomationError(
											"session_not_persistent",
											"The current session has no sessionFile and cannot be resumed.",
											false,
										),
									),
								);
							}
							let switchResult: Awaited<ReturnType<typeof runtimeHost.switchSession>>;
							try {
								switchResult = await runtimeHost.switchSession(command.sessionPath);
							} catch (err) {
								return resumeFailure(automationError(id, "run.resume", asAutomationError(err)));
							}
							if (switchResult.cancelled) {
								return resumeFailure(
									automationError(
										id,
										"run.resume",
										createAutomationError(
											"session_switch_cancelled",
											"A session-switch extension cancelled the switch.",
											false,
										),
									),
								);
							}
							if (requestEpoch !== transportEpoch) return resumeFailure(connectionClosedResponse());
							currentBinding = captureCurrentBinding();
							if (currentBinding.coordinator === undefined) {
								return resumeFailure(automationError(id, "run.resume", hostNotInitializedError()));
							}
							// The prepared binding already owns the restored session's coordinator.
							const sourceRun = currentBinding.coordinator.getRun(command.sourceRunId);
							if (sourceRun === undefined) {
								return resumeFailure(
									automationError(
										id,
										"run.resume",
										createAutomationError(
											"source_run_not_found",
											`Source run not found in restored session: ${command.sourceRunId}`,
											false,
										),
									),
								);
							}
							if (!isTerminalStatus(sourceRun.record.status) && sourceRun.recovery !== "interrupted") {
								return resumeFailure(
									automationError(
										id,
										"run.resume",
										createAutomationError(
											"source_run_not_resumable",
											`Source run ${command.sourceRunId} cannot be the basis for a new attempt`,
											false,
										),
									),
								);
							}
							const sourceIsExternal = sourceRun.record.model.provider === "external_connector";
							if (sourceIsExternal) {
								if (command.images !== undefined && command.images.length > 0) {
									return resumeFailure(
										automationError(
											id,
											"run.resume",
											createAutomationError(
												"external_binding_invalid",
												"External Connector input rejects raw image payloads; use canonical trusted artifact references.",
												false,
											),
										),
									);
								}
								const registry = currentBinding.session.getExternalConnectorRegistry?.();
								if (registry === undefined) {
									return resumeFailure(
										automationError(
											id,
											"run.resume",
											createAutomationError(
												"external_connector_unavailable",
												"No trusted External Connector registry is composed into the restored Host.",
												false,
											),
										),
									);
								}
								const providerId = sourceRun.record.model.id;
								if (
									command.externalConnector !== undefined &&
									command.externalConnector.providerId !== providerId
								) {
									return resumeFailure(
										automationError(
											id,
											"run.resume",
											createAutomationError(
												"external_binding_invalid",
												"The requested External Connector does not match the persisted Attempt.",
												false,
											),
										),
									);
								}
								let recoveryReservation: RunReservation;
								try {
									recoveryReservation = currentBinding.coordinator.reserve();
								} catch (err) {
									return resumeFailure(automationError(id, "run.resume", asAutomationError(err)));
								}
								currentBinding.activeReservation = recoveryReservation;
								const recoveryBinding = currentBinding;
								const recoveryController = new AbortController();
								recoveryBinding.runAbortControllers.set(command.sourceRunId, recoveryController);
								if (command.deadlineAt !== undefined) {
									const timer = setTimeout(
										() => recoveryController.abort(new AgentOperationError("deadline_exceeded")),
										Math.max(0, Date.parse(command.deadlineAt) - Date.now()),
									);
									if (typeof timer === "object" && "unref" in timer && typeof timer.unref === "function")
										timer.unref();
									recoveryBinding.runDeadlineTimers.set(command.sourceRunId, timer);
								}
								const productIdentity = externalConnectorProductIdentity(command.sourceRunId, providerId);
								const selectedDescriptor = registry
									.list()
									.find((candidate) => candidate.providerId === providerId);
								if (selectedDescriptor === undefined) {
									recoveryBinding.activeReservation = undefined;
									recoveryReservation.release();
									clearRunDeadline(recoveryBinding, command.sourceRunId);
									return resumeFailure(
										automationError(
											id,
											"run.resume",
											createAutomationError(
												"external_connector_unavailable",
												"The persisted External Connector is not registered in the restored Host.",
												false,
											),
										),
									);
								}
								const selection = command.externalConnector ?? {
									providerId: selectedDescriptor.providerId,
									revision: selectedDescriptor.revision,
									capabilitySnapshotDigest: selectedDescriptor.capabilitySnapshotDigest,
								};
								const selected = await registry.select(selection);
								if (!selected.ok) {
									recoveryBinding.activeReservation = undefined;
									recoveryReservation.release();
									clearRunDeadline(recoveryBinding, command.sourceRunId);
									return resumeFailure(
										automationError(
											id,
											"run.resume",
											createAutomationError(
												"external_capability_mismatch",
												"External Connector capability snapshot is unavailable or drifted.",
												false,
											),
										),
									);
								}
								let expectedGatewayModelRoute: ExternalConnectorProductAdmission["input"]["gatewayModelRoute"];
								if (
									selected.value.capabilitySnapshot.modelAccess === "aos_gateway" &&
									(command.modelRoute !== undefined || command.modelRole !== undefined)
								) {
									const modelSelection = await resolveRequestedModel(
										recoveryBinding,
										command.modelRoute,
										command.modelRole,
										undefined,
										false,
									);
									const resolution = modelSelection.resolution;
									const effort = resolution?.reference.thinkingLevel;
									const serviceTier = resolution?.reference.serviceTier;
									const fallbackDecision =
										resolution === undefined ? undefined : externalFallbackDecisionForResolution(resolution);
									if (
										modelSelection.error !== undefined ||
										resolution === undefined ||
										effort === undefined ||
										serviceTier === undefined ||
										fallbackDecision === undefined
									) {
										recoveryBinding.activeReservation = undefined;
										recoveryReservation.release();
										clearRunDeadline(recoveryBinding, command.sourceRunId);
										return resumeFailure(
											automationError(
												id,
												"run.resume",
												modelSelection.error ??
													createAutomationError(
														"external_binding_invalid",
														"The resolved AOS gateway model lacks an exact translatable route.",
														false,
													),
											),
										);
									}
									expectedGatewayModelRoute = {
										provider: resolution.reference.provider,
										model: resolution.reference.id,
										effort,
										serviceTier,
										fallbackDecision,
										bindingDigest: fingerprintFoundationValue(resolution.binding),
									};
								}
								const expectedCanonicalInput: CanonicalExternalAgentInput = {
									schemaVersion: 1,
									text: command.message,
									artifacts: command.artifacts ?? [],
								};
								try {
									await recoveryBinding.session.whenCapabilitiesReady(
										command.sourceRunId,
										recoveryController.signal,
									);
								} catch (err) {
									recoveryBinding.activeReservation = undefined;
									recoveryReservation.release();
									clearRunDeadline(recoveryBinding, command.sourceRunId);
									return resumeFailure(automationError(id, "run.resume", asAutomationError(err)));
								}
								const recoveryPolicyBinding = recoveryBinding.session.getActiveExecutionPolicyBinding();
								const recoveryCapabilityBinding = recoveryBinding.session.getActiveCapabilityBinding();
								if (
									recoveryPolicyBinding === undefined ||
									recoveryPolicyBinding.runId !== command.sourceRunId
								) {
									recoveryBinding.activeReservation = undefined;
									recoveryReservation.release();
									clearRunDeadline(recoveryBinding, command.sourceRunId);
									return resumeFailure(
										automationError(
											id,
											"run.resume",
											createAutomationError(
												"external_binding_invalid",
												"The canonical Execution Policy binding is unavailable for External Connector recovery.",
												false,
											),
										),
									);
								}
								const recoveryInput = {
									session: getAgentCanonicalSession(recoveryBinding.session),
									writer: recoveryBinding.session.agentRuntimeComposition.harness.ledger.writer,
									registry,
									runId: command.sourceRunId,
									providerId,
									selection,
									expectedCanonicalInput,
									...(expectedGatewayModelRoute === undefined ? {} : { expectedGatewayModelRoute }),
									signal: recoveryController.signal,
									reconstruction: {
										inputAdmission: {
											inspectArtifact: (reference: CanonicalExternalAgentArtifactReference) =>
												hostController.inspectExternalArtifact(reference),
										},
										workspace: recoveryBinding.session.cwd,
										policyBinding: recoveryPolicyBinding,
										...(recoveryCapabilityBinding === undefined
											? {}
											: { capabilityBinding: recoveryCapabilityBinding }),
										...(sourceRun.record.startedAt === undefined
											? {}
											: { acceptedAt: sourceRun.record.startedAt }),
									},
								};
								try {
									await preflightExternalConnectorProductRecovery(recoveryInput);
								} catch (err) {
									recoveryBinding.activeReservation = undefined;
									recoveryReservation.release();
									clearRunDeadline(recoveryBinding, command.sourceRunId);
									return resumeFailure(automationError(id, "run.resume", asAutomationError(err)));
								}
								if (sourceRun.receipt !== undefined) {
									recoveryBinding.activeReservation = undefined;
									recoveryReservation.release();
									clearRunDeadline(recoveryBinding, command.sourceRunId);
									return resumeFailure(acceptedResponseFromResult(id, "run.resume", sourceRun, true));
								}
								recoveryBinding.externalRuns.set(command.sourceRunId, {
									cancel: async () => {
										const cancelled = await selected.value.connector.cancelAttempt(productIdentity.attemptId);
										if (!cancelled.ok) throw cancelled.error;
									},
								});
								const recovery = recoverExternalConnectorProductRun(recoveryInput);
								const settlement = recovery.then(() => undefined);
								recoveryBinding.externalRunSettlements.set(command.sourceRunId, settlement);
								void settlement
									.finally(() => {
										recoveryBinding.externalRuns.delete(command.sourceRunId);
										recoveryBinding.externalRunSettlements.delete(command.sourceRunId);
										clearRunDeadline(recoveryBinding, command.sourceRunId);
										if (recoveryBinding.activeReservation === recoveryReservation) {
											recoveryBinding.activeReservation = undefined;
											recoveryReservation.release();
										}
										recoveryBinding.coordinator = createRunLifecycleCoordinator(
											getAgentSessionLedger(recoveryBinding.session),
										);
									})
									.catch(() => undefined);
								return resumeFailure({
									id,
									type: "response",
									command: "run.resume",
									success: true,
									data: acceptedDataFromResult(sourceRun, false, "accepted"),
								});
							}
							// An interrupted run may have an accepted record but no terminal
							// receipt. Preserve #6's binding-drift guard for that recovery path.
							const previousBindingId = sourceRun.record.capabilityBindingId;
							const previousPolicyBindingId = sourceRun.record.policyBindingId;
							const previousModelBindingId = sourceRun.record.modelBindingId;
							const inheritedModelBinding =
								previousModelBindingId === undefined
									? undefined
									: foldModelBrokerLedger(currentBinding.session.sessionRead.getEntries()).bindings.get(
											previousModelBindingId,
										);
							if (currentBinding !== captureCurrentBinding()) {
								return resumeFailure(
									automationError(
										id,
										"run.resume",
										createAutomationError(
											"start_rejected",
											"The Host switched sessions again before the resumed Run was accepted.",
											true,
										),
									),
								);
							}
							return startRun(
								currentBinding,
								id,
								"run.resume",
								command.message,
								command.images,
								command.artifacts,
								sourceRun.record.attempt + 1,
								command.sourceRunId,
								command.capabilityProfile,
								command.policyProfile,
								previousBindingId,
								previousPolicyBindingId,
								previousModelBindingId,
								inheritedModelBinding,
								command.modelRoute,
								command.modelRole,
								command.externalConnector,
								command.deadlineAt,
								command.clientRequestId,
								resumeIdentity,
								resumeClaim !== undefined,
								requestEpoch,
							);
						})(),
					);
				}

				// =================================================================
				// Prompting
				// =================================================================

				case "prompt": {
					// Start prompt handling immediately, but emit the authoritative response only after
					// prompt preflight succeeds. Queued and immediately handled prompts also count as success.
					let preflightSucceeded = false;
					void currentBinding.session
						.prompt(command.message, {
							images: command.images,
							streamingBehavior: command.streamingBehavior,
							source: "rpc",
							surface: "rpc",
							preflightResult: (didSucceed) => {
								if (didSucceed) {
									preflightSucceeded = true;
									output(success(id, "prompt"));
								}
							},
						})
						.catch((e) => {
							if (!preflightSucceeded) {
								output(error(id, "prompt", e.message));
							}
						});
					return undefined;
				}

				case "steer": {
					await currentBinding.session.steer(command.message, command.images);
					return success(id, "steer");
				}

				case "follow_up": {
					await currentBinding.session.followUp(command.message, command.images);
					return success(id, "follow_up");
				}

				case "abort": {
					await currentBinding.session.abort();
					return success(id, "abort");
				}

				case "new_session": {
					const options = command.parentSession ? { parentSession: command.parentSession } : undefined;
					const result = await runtimeHost.newSession(options);
					return success(id, "new_session", result);
				}

				// =================================================================
				// State
				// =================================================================

				case "get_state": {
					const state: RpcSessionState = {
						model: currentBinding.session.model,
						thinkingLevel: currentBinding.session.thinkingLevel,
						isStreaming: currentBinding.session.isStreaming,
						isCompacting: currentBinding.session.isCompacting,
						steeringMode: currentBinding.session.steeringMode,
						followUpMode: currentBinding.session.followUpMode,
						sessionId: currentBinding.session.sessionId,
						sessionName: currentBinding.session.sessionName,
						autoCompactionEnabled: currentBinding.session.autoCompactionEnabled,
						messageCount: currentBinding.session.messages.length,
						pendingMessageCount: currentBinding.session.pendingMessageCount,
					};
					return success(id, "get_state", state);
				}

				// =================================================================
				// Model
				// =================================================================

				case "set_model": {
					const models = currentBinding.session.modelRuntime.getAvailableSnapshot();
					const model = models.find((m) => m.provider === command.provider && m.id === command.modelId);
					if (!model) {
						return error(id, "set_model", `Model not found: ${command.provider}/${command.modelId}`);
					}
					await currentBinding.session.setModel(model);
					return success(id, "set_model", model);
				}

				case "cycle_model": {
					const result = await currentBinding.session.cycleModel();
					if (!result) {
						return success(id, "cycle_model", null);
					}
					return success(id, "cycle_model", result);
				}

				case "get_available_models": {
					const models = currentBinding.session.modelRuntime.getAvailableSnapshot();
					return success(id, "get_available_models", { models });
				}

				// =================================================================
				// Thinking
				// =================================================================

				case "set_thinking_level": {
					currentBinding.session.setThinkingLevel(command.level);
					return success(id, "set_thinking_level");
				}

				case "cycle_thinking_level": {
					const level = currentBinding.session.cycleThinkingLevel();
					if (!level) {
						return success(id, "cycle_thinking_level", null);
					}
					return success(id, "cycle_thinking_level", { level });
				}

				case "get_available_thinking_levels": {
					const levels = currentBinding.session.getAvailableThinkingLevels();
					return success(id, "get_available_thinking_levels", { levels });
				}

				// =================================================================
				// Queue Modes
				// =================================================================

				case "set_steering_mode": {
					currentBinding.session.setSteeringMode(command.mode);
					return success(id, "set_steering_mode");
				}

				case "set_follow_up_mode": {
					currentBinding.session.setFollowUpMode(command.mode);
					return success(id, "set_follow_up_mode");
				}

				// =================================================================
				// Compaction
				// =================================================================

				case "compact": {
					const result = await currentBinding.session.compact(command.customInstructions);
					return success(id, "compact", result);
				}

				case "set_auto_compaction": {
					currentBinding.session.setAutoCompactionEnabled(command.enabled);
					return success(id, "set_auto_compaction");
				}

				// =================================================================
				// Retry
				// =================================================================

				case "set_auto_retry": {
					currentBinding.session.setAutoRetryEnabled(command.enabled);
					return success(id, "set_auto_retry");
				}

				case "abort_retry": {
					currentBinding.session.abortRetry();
					return success(id, "abort_retry");
				}

				// =================================================================
				// Bash
				// =================================================================

				case "bash": {
					const allowExtensionBash = await currentBinding.session.authorizeUserBashExtension(command.command, {
						id,
					});
					const eventResult = allowExtensionBash
						? await currentBinding.session.extensionRunner.emitUserBash({
								type: "user_bash",
								command: command.command,
								excludeFromContext: command.excludeFromContext ?? false,
								cwd: currentBinding.session.sessionRead.getCwd(),
							})
						: undefined;

					if (eventResult?.result) {
						currentBinding.session.recordBashResult(command.command, eventResult.result, {
							excludeFromContext: command.excludeFromContext,
						});
						return success(id, "bash", eventResult.result);
					}

					const result = await currentBinding.session.executeBash(command.command, undefined, {
						excludeFromContext: command.excludeFromContext,
						id,
						operations: eventResult?.operations,
					});
					return success(id, "bash", result);
				}

				case "abort_bash": {
					currentBinding.session.abortBash();
					return success(id, "abort_bash");
				}

				// =================================================================
				// Session
				// =================================================================

				case "get_session_stats": {
					const stats = currentBinding.session.getSessionStats();
					return success(id, "get_session_stats", serializePublicSessionStats(stats));
				}

				case "get_context": {
					const inspection = await currentBinding.session.inspectContext({
						snapshotId: command.snapshotId,
					});
					return success(id, "get_context", {
						snapshot: serializePublicContextSnapshot(inspection.snapshot),
						drift: inspection.drift.map((item) => serializePublicContextDrift(item)),
						preview: inspection.preview,
					});
				}

				case "get_capabilities": {
					// Ordinary read-only inspection: no Automation Host initialize is
					// required, and only public-safe metadata is ever returned.
					const history = foldCapabilityBindingEntries(currentBinding.session.sessionRead.getEntries());
					const current = currentBinding.session.getActiveCapabilityBinding();
					if (command.bindingId !== undefined) {
						const found = history.get(command.bindingId);
						if (found === undefined) {
							return error(id, "get_capabilities", "Capability binding not found.");
						}
						const binding = serializePublicCapabilityBinding(found);
						return success(id, "get_capabilities", {
							catalog: currentBinding.session.inspectCapabilityCatalog(),
							binding: binding ?? null,
							bindings: [],
						} satisfies GetCapabilitiesData);
					}
					return success(id, "get_capabilities", {
						catalog: currentBinding.session.inspectCapabilityCatalog(),
						binding: current === undefined ? null : (serializePublicCapabilityBinding(current) ?? null),
						bindings: [...history.values()]
							.map((binding) => serializePublicCapabilityBinding(binding))
							.filter((binding): binding is NonNullable<typeof binding> => binding !== undefined),
					} satisfies GetCapabilitiesData);
				}

				case "get_execution_policy": {
					return success(id, "get_execution_policy", {
						summary: currentBinding.session.getActiveExecutionPolicySummary(),
						pendingApprovals: currentBinding.session.getPendingExecutionPolicyApprovals(),
					} satisfies GetExecutionPolicyData);
				}

				case "policy.approve": {
					currentBinding.session.approveExecutionPolicyRequest(command.requestId, "rpc");
					return success(id, "policy.approve");
				}

				case "policy.reject": {
					currentBinding.session.rejectExecutionPolicyRequest(command.requestId, "rpc");
					return success(id, "policy.reject");
				}

				case "get_model_routes": {
					// Route and role catalogs contain only declared model identities and
					// availability metadata. ModelRuntime credentials are intentionally not
					// part of the Broker summary.
					return success(
						id,
						"get_model_routes",
						currentBinding.session.modelBroker.publicSummary(
							currentBinding.session.modelBrokerBindingId,
						) satisfies GetModelRoutesData,
					);
				}

				// =================================================================
				// MCP content (resource/prompt): explicit, governed remote reads.
				// Raw URIs and prompt args live only in the request; responses,
				// audit records, and errors never echo them or remote text.
				// =================================================================

				case "mcp.resource.list": {
					// Available without Automation Host initialize: read-only, never
					// starts a Run or a model. The host signal cancels the in-flight
					// server/session operation on detach/shutdown (bounded).
					try {
						const data = await currentBinding.session.listMcpResources(
							command.serverId,
							command.cursor === undefined ? undefined : { cursor: command.cursor },
							mcpOperationController.signal,
						);
						return success(id, "mcp.resource.list", data);
					} catch (err) {
						return mcpContentFailure(id, "mcp.resource.list", err, command.serverId);
					}
				}

				case "mcp.resource.templates.list": {
					// Same read-only contract as mcp.resource.list; the response
					// carries digest ids and a sanitized display pattern only, never
					// the raw URI template.
					try {
						const data = await currentBinding.session.listMcpResourceTemplates(
							command.serverId,
							command.cursor === undefined ? undefined : { cursor: command.cursor },
							mcpOperationController.signal,
						);
						return success(id, "mcp.resource.templates.list", data);
					} catch (err) {
						return mcpContentFailure(id, "mcp.resource.templates.list", err, command.serverId);
					}
				}

				case "mcp.resource.read": {
					try {
						const result = await currentBinding.session.readMcpResource(
							command.serverId,
							command.uri,
							mcpOperationController.signal,
						);
						return success(id, "mcp.resource.read", toRpcMcpReadResourceReceipt(result));
					} catch (err) {
						return mcpContentFailure(id, "mcp.resource.read", err, command.serverId);
					}
				}

				case "mcp.resource.attach": {
					// Explicit attach: reads the resource and registers the normalized
					// result as a session attachment. Rejected while the Automation
					// Host is initialized (mutates session state).
					try {
						const attachment = await currentBinding.session.attachMcpResource({
							serverId: command.serverId,
							uri: command.uri,
							signal: mcpOperationController.signal,
						});
						return success(id, "mcp.resource.attach", toRpcMcpAttachmentReceipt(attachment));
					} catch (err) {
						return mcpContentFailure(id, "mcp.resource.attach", err, command.serverId);
					}
				}

				case "mcp.prompt.list": {
					try {
						const data = await currentBinding.session.listMcpPrompts(
							command.serverId,
							command.cursor === undefined ? undefined : { cursor: command.cursor },
							mcpOperationController.signal,
						);
						return success(id, "mcp.prompt.list", data);
					} catch (err) {
						return mcpContentFailure(id, "mcp.prompt.list", err, command.serverId);
					}
				}

				case "mcp.prompt.get": {
					try {
						const result = await currentBinding.session.getMcpPrompt(
							command.serverId,
							command.name,
							command.args,
							mcpOperationController.signal,
						);
						return success(id, "mcp.prompt.get", toRpcMcpGetPromptReceipt(result));
					} catch (err) {
						return mcpContentFailure(id, "mcp.prompt.get", err, command.serverId);
					}
				}

				case "mcp.prompt.attach": {
					try {
						const attachment = await currentBinding.session.attachMcpPrompt({
							serverId: command.serverId,
							name: command.name,
							args: command.args,
							signal: mcpOperationController.signal,
						});
						return success(id, "mcp.prompt.attach", toRpcMcpAttachmentReceipt(attachment));
					} catch (err) {
						return mcpContentFailure(id, "mcp.prompt.attach", err, command.serverId);
					}
				}

				// =================================================================
				// MCP OAuth (mcp.auth.*): credential status/lifecycle. Headless
				// start (no `interactive` declaration) fails closed immediately
				// with the fixed `mcp_auth_interaction_required` error — no
				// browser, no flow creation, no unbounded wait. Declaring
				// `interactive: true` routes the flow through the extension-UI
				// bridge (confirm / manual-code dialogs, one-shot `auth_url`
				// delivery) bounded by the flow deadline and the host transport
				// signal. All responses are masked: no tokens, URLs,
				// issuer/resource, or raw URIs, and every failure maps to a
				// stable code with a fixed message.
				// =================================================================

				case "mcp.auth.start": {
					// Default headless: without an explicitly declared interaction
					// bridge the call must fail closed instead of opening a browser
					// or waiting for input that will never come.
					if (command.interactive !== true) {
						return mcpAuthErrorResponse(id, "mcp.auth.start", "mcp_auth_interaction_required", command.serverId);
					}
					// An interactive start needs a live output sink to deliver the
					// dialogs and the one-shot authorization URL; without one the
					// call fails closed immediately instead of creating dialogs
					// that could only time out.
					if (this.outputSink === undefined) {
						return mcpAuthErrorResponse(id, "mcp.auth.start", "mcp_auth_interaction_required", command.serverId);
					}
					const stdioError = mcpAuthStdioError(currentBinding, id, "mcp.auth.start", command.serverId);
					if (stdioError !== undefined) return stdioError;
					if (currentBinding.session.getMcpAuthManager() === undefined) {
						return mcpAuthErrorResponse(id, "mcp.auth.start", "mcp_auth_not_configured", command.serverId);
					}
					const interaction = createMcpAuthInteraction(
						command.serverId,
						command.timeoutMs ?? MCP_OAUTH_DEFAULT_TIMEOUT_MS,
					);
					try {
						const result = await currentBinding.session.startMcpAuth(command.serverId, command.serverUrl, {
							interaction,
							callbackMode: command.callbackMode,
							httpsCallbackUrl: command.httpsCallbackUrl,
							timeoutMs: command.timeoutMs,
							requestTimeoutMs: command.requestTimeoutMs,
						});
						return {
							id,
							type: "response",
							command: "mcp.auth.start",
							success: true,
							data: { status: result.status } satisfies RpcMcpAuthStartData,
						};
					} catch (err) {
						return mcpAuthFailure(id, "mcp.auth.start", err, command.serverId);
					}
				}

				case "mcp.auth.status": {
					const stdioError = mcpAuthStdioError(currentBinding, id, "mcp.auth.status", command.serverId);
					if (stdioError !== undefined) return stdioError;
					if (currentBinding.session.getMcpAuthManager() === undefined) {
						return mcpAuthErrorResponse(id, "mcp.auth.status", "mcp_auth_not_configured", command.serverId);
					}
					try {
						const credential = await currentBinding.session.getMcpAuthStatus(command.serverId, command.serverUrl);
						if (credential === undefined) {
							return {
								id,
								type: "response",
								command: "mcp.auth.status",
								success: true,
								data: { status: "required" } satisfies RpcMcpAuthStatusData,
							};
						}
						return {
							id,
							type: "response",
							command: "mcp.auth.status",
							success: true,
							data: {
								status: credential.status === "expired" ? "expired" : "authenticated",
								credential: toRpcMcpMaskedCredential(credential),
							} satisfies RpcMcpAuthStatusData,
						};
					} catch (err) {
						return mcpAuthFailure(id, "mcp.auth.status", err, command.serverId);
					}
				}

				case "mcp.auth.list": {
					if (currentBinding.session.getMcpAuthManager() === undefined) {
						return mcpAuthErrorResponse(id, "mcp.auth.list", "mcp_auth_not_configured", "");
					}
					try {
						const credentials = await currentBinding.session.listMcpCredentialStatuses();
						return {
							id,
							type: "response",
							command: "mcp.auth.list",
							success: true,
							data: {
								credentials: credentials.map((credential) => toRpcMcpMaskedCredential(credential)),
							} satisfies RpcMcpAuthListData,
						};
					} catch (err) {
						return mcpAuthFailure(id, "mcp.auth.list", err, "");
					}
				}

				case "mcp.auth.logout": {
					const stdioError = mcpAuthStdioError(currentBinding, id, "mcp.auth.logout", command.serverId);
					if (stdioError !== undefined) return stdioError;
					if (currentBinding.session.getMcpAuthManager() === undefined) {
						return mcpAuthErrorResponse(id, "mcp.auth.logout", "mcp_auth_not_configured", command.serverId);
					}
					try {
						await currentBinding.session.logoutMcpAuth(command.serverId, command.serverUrl);
						return { id, type: "response", command: "mcp.auth.logout", success: true };
					} catch (err) {
						return mcpAuthFailure(id, "mcp.auth.logout", err, command.serverId);
					}
				}

				case "export_html": {
					const path = await currentBinding.session.exportToHtml(command.outputPath);
					return success(id, "export_html", { path });
				}

				case "switch_session": {
					const result = await runtimeHost.switchSession(command.sessionPath);
					return success(id, "switch_session", result);
				}

				case "fork": {
					const result = await runtimeHost.fork(command.entryId);
					return success(id, "fork", { text: result.selectedText, cancelled: result.cancelled });
				}

				case "clone": {
					const leafId = currentBinding.session.sessionRead.getLeafId();
					if (!leafId) {
						return error(id, "clone", "Cannot clone session: no current entry selected");
					}
					const result = await runtimeHost.fork(leafId, { position: "at" });
					return success(id, "clone", { cancelled: result.cancelled });
				}

				case "get_fork_messages": {
					const messages = currentBinding.session.getUserMessagesForForking();
					return success(id, "get_fork_messages", { messages });
				}

				case "get_entries": {
					const sessionRead = currentBinding.session.sessionRead;
					let entries = sessionRead.getEntries();
					if (command.since !== undefined) {
						const sinceIndex = entries.findIndex((e) => e.id === command.since);
						if (sinceIndex === -1) {
							return error(id, "get_entries", `Entry not found: ${command.since}`);
						}
						entries = entries.slice(sinceIndex + 1);
					}
					return success(id, "get_entries", {
						entries: entries.map((entry) => serializePublicSessionEntry(entry)),
						leafId: sessionRead.getLeafId(),
					});
				}

				case "get_tree": {
					const sessionRead = currentBinding.session.sessionRead;
					return success(id, "get_tree", {
						tree: sessionRead.getTree().map((node) => serializePublicSessionTreeNode(node)),
						leafId: sessionRead.getLeafId(),
					});
				}

				case "get_last_assistant_text": {
					const text = currentBinding.session.getLastAssistantText();
					return success(id, "get_last_assistant_text", { text });
				}

				case "set_session_name": {
					const name = command.name.trim();
					if (!name) {
						return error(id, "set_session_name", "Session name cannot be empty");
					}
					currentBinding.session.setSessionName(name);
					return success(id, "set_session_name");
				}

				// =================================================================
				// Messages
				// =================================================================

				case "get_messages": {
					return success(id, "get_messages", { messages: currentBinding.session.messages });
				}

				// =================================================================
				// Commands (available for invocation via prompt)
				// =================================================================

				case "get_commands": {
					const commands: RpcSlashCommand[] = [];

					for (const command of currentBinding.session.extensionRunner.getRegisteredCommands()) {
						commands.push({
							name: command.invocationName,
							description: command.description,
							source: "extension",
							sourceInfo: serializePublicSourceInfo(command.sourceInfo),
						});
					}

					for (const template of currentBinding.session.promptTemplates) {
						commands.push({
							name: template.name,
							description: template.description,
							source: "prompt",
							sourceInfo: serializePublicSourceInfo(template.sourceInfo),
						});
					}

					for (const skill of currentBinding.session.resourceLoader.getSkills().skills) {
						commands.push({
							name: `skill:${skill.name}`,
							description: skill.description,
							source: "skill",
							sourceInfo: serializePublicSourceInfo(skill.sourceInfo),
						});
					}

					return success(id, "get_commands", { commands });
				}

				default: {
					const unknownCommand = command as { type: string };
					return error(id, unknownCommand.type, `Unknown command: ${unknownCommand.type}`);
				}
			}
		};

		/**
		 * Check if shutdown was requested and perform shutdown if so.
		 * Called after handling each command when waiting for the next command.
		 */
		let shutdownPromise: Promise<void> | undefined;

		async function shutdown(): Promise<void> {
			if (shutdownPromise !== undefined) {
				await shutdownPromise;
				return;
			}
			shuttingDown = true;
			hostController.shuttingDown = true;
			const bindingAtShutdown = captureCurrentBinding();
			shutdownPromise = (async () => {
				// Stop accepting new runs and abort the active run. Session completion is
				// only an observation; the last canonical Foundation state is authoritative.
				if (bindingAtShutdown.activeReservation !== undefined) {
					try {
						bindingAtShutdown.activeReservation.release();
					} catch {
						// reservation may already be consumed
					}
					bindingAtShutdown.activeReservation = undefined;
				}
				if (bindingAtShutdown.activeHandle !== undefined) {
					bindingAtShutdown.activeHandle.requestCancel();
					const forwarded = await forwardExternalRunLifecycleCancel(
						bindingAtShutdown,
						bindingAtShutdown.activeHandle.runId,
					);
					if (!forwarded) {
						try {
							await bindingAtShutdown.session.abort();
						} catch {
							// Canonical lookup proceeds independently of abort errors.
						}
					}
				}
				// Abort every pending external start, including phases before the
				// external-runs registration (preflight), so none of them accepts or
				// starts after the host is gone; each fails closed on the
				// shuttingDown guard.
				for (const controller of bindingAtShutdown.externalPendingControllers.values()) {
					controller.abort();
				}
				// Abort in-flight MCP content operations bound to this host; each
				// rejects on the lifecycle signal contract and fails closed without
				// blocking the shutdown (bounded cancellation).
				abortMcpOperations();
				rejectPendingExtensionRequests();
				bindingAtShutdown.unsubscribe?.();
				bindingAtShutdown.unsubscribeBackpressure?.();
				await runtimeHost.dispose();
				hostController.onShutdown?.();
			})();
			await shutdownPromise;
		}

		async function detachTransport(): Promise<void> {
			transportEpoch += 1;
			if (detachTransportPromise !== undefined) {
				await detachTransportPromise;
				return;
			}
			const bindingAtDetach = captureCurrentBinding();
			const handleAtDetach = bindingAtDetach.activeHandle;
			const pendingStartsAtDetach = [...pendingStartPromises];
			detachTransportPromise = (async () => {
				rejectPendingExtensionRequests();
				if (bindingAtDetach.activeReservation !== undefined) {
					try {
						bindingAtDetach.activeReservation.release();
					} catch {
						// reservation may already be consumed
					}
					bindingAtDetach.activeReservation = undefined;
				}
				if (handleAtDetach !== undefined) {
					// The Run cancellation intent is forwarded to the Connector's
					// idempotent same-Attempt cancel path for external executions: the Session
					// agent loop does not drive them, so Session abort alone would
					// leave the external execution running. Local runs keep the existing
					// abort plus tracked-prompt observation.
					handleAtDetach.requestCancel();
					const forwarded = await forwardExternalRunLifecycleCancel(bindingAtDetach, handleAtDetach.runId);
					if (!forwarded) {
						try {
							await bindingAtDetach.session.abort();
						} catch {
							// Canonical lookup remains independent of the abort observation.
						}
						await bindingAtDetach.runPromptPromises.get(handleAtDetach.runId);
					}
				}
				// Abort every pending external start controller (including phases
				// before external-runs registration) so the preflight or
				// readiness race resolves where the signal is honored; each fails
				// closed on the epoch guard. Pending external starts are never
				// awaited: a driver start or preflight that ignores the abort
				// signal must not block the detach.
				for (const controller of bindingAtDetach.externalPendingControllers.values()) {
					controller.abort();
				}
				// Abort in-flight MCP content operations bound to the detaching
				// transport. Bounded: the abort is synchronous and the in-flight
				// commands are never awaited; each fails closed on its own abort
				// path, and a fresh controller serves the next attachment.
				abortMcpOperations();
				const externalPendingAtDetach = new Set(bindingAtDetach.pendingExternalStarts.values());
				await Promise.all([...pendingStartsAtDetach].filter((pending) => !externalPendingAtDetach.has(pending)));
				// Worker detach: the Host connection (worker) that drove the active
				// Run detached from this Session. Revoke + settle every lease bound
				// to the run (and its worker) before the transport is unbound;
				// best-effort and idempotent with the run's own terminal signal.
				bindingAtDetach.taskCredentialService?.onWorkerDetach({ runId: handleAtDetach?.runId });
			})().finally(() => {
				detachTransportPromise = undefined;
			});
			await detachTransportPromise;
		}

		async function checkShutdownRequested(): Promise<void> {
			if (!shutdownRequested) return;
			await shutdown();
		}

		this.commandHandler = async (
			command: RpcCommand,
		): Promise<
			| RpcResponse
			| RpcAutomationResponse
			| RpcMcpAuthResponse
			| RpcMcpContentResponse
			| RpcWorkerResponse
			| RpcSubagentResponse
			| RpcSchedulerResponse
			| undefined
		> => {
			if (detachTransportPromise !== undefined) await detachTransportPromise;
			try {
				const response = await handleCommand(command);
				if (response) {
					output(response);
					await waitForOutput();
				}
				await checkShutdownRequested();
				return response;
			} catch (commandError: unknown) {
				if (RPC_SUBAGENT_COMMAND_KEYS[command.type as RpcSubagentCommandType] !== undefined) {
					const subagentCommand = command.type as RpcSubagentCommandType;
					const response = rpcSubagentError(
						typeof command.id === "string" ? command.id : undefined,
						subagentCommand,
						subagentCommand === "subagent.cancel" ? "subagent_cancel_failed" : "subagent_unavailable",
					);
					output(response);
					await waitForOutput();
					return response;
				}
				if (RPC_WORKER_COMMAND_KEYS[command.type as RpcWorkerCommandType] !== undefined) {
					const workerCommand = command.type as RpcWorkerCommandType;
					const response = rpcWorkerError(
						typeof command.id === "string" ? command.id : undefined,
						workerCommand,
						workerCommand === "worker.reclaim" ? "worker_reclaim_failed" : "worker_unavailable",
					);
					output(response);
					await waitForOutput();
					return response;
				}
				const response = error(
					command.id,
					command.type,
					commandError instanceof Error ? commandError.message : String(commandError),
				);
				output(response);
				await waitForOutput();
				return response;
			}
		};

		this.extensionResponseHandler = (response: RpcExtensionUIResponse): void => {
			const pending = pendingExtensionRequests.get(response.id);
			if (pending !== undefined) {
				pendingExtensionRequests.delete(response.id);
				pending.resolve(response);
			}
		};
		this.shutdownHandler = shutdown;
		this.detachTransportHandler = detachTransport;
	}

	/** Dispatch a typed command, publish its response or error record, and return it. */
	async dispatch(command: Extract<RpcCommand, { type: RpcWorkerCommandType }>): Promise<RpcWorkerResponse>;
	async dispatch(command: Extract<RpcCommand, { type: RpcSubagentCommandType }>): Promise<RpcSubagentResponse>;
	async dispatch(command: Extract<RpcCommand, { type: "scheduler.status" }>): Promise<RpcSchedulerResponse>;
	async dispatch(
		command: RpcCommand,
	): Promise<RpcResponse | RpcAutomationResponse | RpcMcpAuthResponse | RpcMcpContentResponse | undefined>;
	async dispatch(
		command: RpcCommand,
	): Promise<
		| RpcResponse
		| RpcAutomationResponse
		| RpcMcpAuthResponse
		| RpcMcpContentResponse
		| RpcWorkerResponse
		| RpcSubagentResponse
		| RpcSchedulerResponse
		| undefined
	> {
		if (this.commandHandler === undefined) {
			throw new Error("RPC host controller has not been started.");
		}
		return this.commandHandler(command);
	}

	/** Compatibility wrapper for callers that only need published output. */
	async handleCommand(command: RpcCommand): Promise<void> {
		await this.dispatch(command);
	}

	/** Resolve a pending extension UI request using a transport response. */
	handleExtensionUIResponse(response: RpcExtensionUIResponse): void {
		this.extensionResponseHandler?.(response);
	}

	/** Stop accepting work, cancel active observation, and dispose the runtime. */
	async shutdown(): Promise<void> {
		if (this.shutdownHandler === undefined) return;
		await this.shutdownHandler();
	}

	/**
	 * Detach a disconnected transport while keeping the host and runtime alive
	 * for a later connection. Any active run is cancelled; only a canonical
	 * RunReceipt may produce its terminal event.
	 */
	async detachTransport(): Promise<void> {
		if (this.detachTransportHandler === undefined) return;
		if (this.transportDetachPromise !== undefined) {
			await this.transportDetachPromise;
			return;
		}
		const detachPromise = this.detachTransportHandler();
		this.transportDetachPromise = detachPromise;
		void detachPromise.then(
			() => {
				if (this.transportDetachPromise === detachPromise) this.transportDetachPromise = undefined;
			},
			() => {
				if (this.transportDetachPromise === detachPromise) this.transportDetachPromise = undefined;
			},
		);
		await detachPromise;
	}

	get isShuttingDown(): boolean {
		return this.shuttingDown;
	}
}

/** Construct a transport-neutral RPC host controller. */
export function createRpcHostController(
	runtimeHost: AgentSessionRuntime,
	options: RpcHostControllerOptions = {},
): RpcHostController {
	return new RpcHostController(runtimeHost, options);
}
