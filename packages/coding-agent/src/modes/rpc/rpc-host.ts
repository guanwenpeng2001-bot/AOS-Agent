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
import { AgentOperationError, type ThinkingLevel } from "@aos-agent/agent-core";
import type { ImageContent } from "@aos-agent/ai";
import type { AgentSessionEvent, SessionStats } from "../../core/agent-session.ts";
import type { AgentSessionRuntime } from "../../core/agent-session-runtime.ts";
import type {
	ExtensionUIContext,
	ExtensionUIDialogOptions,
	ExtensionWidgetOptions,
	WorkingIndicatorOptions,
} from "../../core/extensions/index.ts";
import type {
	ModelResolution as BrokerModelResolution,
	ModelRoleSelection,
	ModelRouteSelection,
} from "../../core/model-broker.ts";
import {
	foldModelBrokerLedger,
	type ModelBindingLedgerRecord,
	serializePublicModelAttempt,
} from "../../core/model-broker-ledger.ts";
import { ExecutionAuditQuery } from "../../core/execution-audit-query.ts";
import { ExecutionAuditError } from "../../core/execution-audit.ts";
import {
	externalAgentCapabilityError,
	EXTERNAL_AGENT_CAPABILITY_SUMMARY_ITEM_MAX_LENGTH,
	EXTERNAL_AGENT_ERROR_CODES,
	EXTERNAL_AGENT_MAX_CAPABILITY_SUMMARY,
	ExternalAgentError,
	isExternalAgentCapabilitySnapshot,
	isExternalAgentPreparedBinding,
	isExternalAgentSelection,
	runExternalAgentAdapter,
	serializeExternalAgentSelection,
	toExternalAgentError,
	verifyExternalAgentPreparedBinding,
	type ExternalAgentAdapter,
	type ExternalAgentCapabilitySnapshot,
	type ExternalAgentPreparedBinding,
	type ExternalAgentPrepareRequest,
	type ExternalAgentReceipt,
	type ExternalAgentRunHandle,
	type ExternalAgentSelection,
	type ExternalAgentStartRequest,
} from "../../core/external-agent-adapter.ts";
import type { ExternalAgentResolvedSelection as ExternalAgentResolved } from "../../core/external-agent-registry.ts";
import {
	createSessionRemoteOperationLedger,
	RemoteOperationError,
	startRemoteOperation,
	type RemoteOperationHeartbeat,
	type RemoteOperationInvoker,
	type RemoteOperationLease,
	type RemoteOperationRequest,
	type RemoteOperationResult,
	type RemoteOperationSideEffectState,
} from "../../core/remote-operation.ts";
import { createRunBindingAssociation } from "../../core/binding-handles.ts";
import { isExternalExecutionRef, serializeExternalExecutionRef, type ExternalAdapterIdentity } from "../../core/external-session-mapping.ts";
import { CapabilityError } from "../../core/capability-registry.ts";
import { PolicyError } from "../../core/execution-policy.ts";
import { MCPAuthError } from "../../core/mcp-auth.ts";
import { MCPError, mcpErrorKindToCapabilityCode } from "../../core/mcp-types.ts";
import { createTaskGateStore, TaskGateError, type TaskGateStore } from "../../core/task-gate.ts";
import {
	createTaskGraphStore,
	TaskGraphError,
	type TaskGraphErrorCode,
	type TaskGraphNodeView,
	type TaskGraphRecord,
	type TaskGraphStore,
} from "../../core/task-graph.ts";
import { loadEntriesFromFile, type SessionEntry } from "../../core/session-manager.ts";
import type {
	AutomationError,
	AutomationErrorCode,
	RunFinalModelReference,
	RunHandle,
	RunId,
	RunLifecycleCoordinator,
	RunModelAttemptSummary,
	RunModelBudgetSummary,
	RunModelReference,
	RunRequestLookup,
	RunResult,
	RunReservation,
	RunLedgerSession,
	RunStreamEvent,
	RunUsageSnapshot,
	PublicRunStreamEvent,
} from "../../core/run-lifecycle.ts";
import {
	createAutomationError,
	createRunRequestFingerprint,
	createRunLifecycleCoordinator,
	foldCapabilityBindingEntries,
	isAutomationErrorCode,
	isRunClientRequestId,
	isRunTimestamp,
	isTerminalStatus,
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
import type { SourceInfo } from "../../core/source-info.ts";
import { type Theme, theme } from "../interactive/theme/theme.ts";
import { toJsonEvent, type JsonAgentSessionEvent } from "../json-event.ts";
import type {
	GetCapabilitiesData,
	GetExecutionPolicyData,
	GetModelRoutesData,
	AuditQuery,
	AuditQueryData,
	AuditReplayQuery,
	AuditReplayData,
	ExternalMapData,
	ExternalExecutionRef,
	ExternalMappingRequest,
	InitializeData,
	McpAuthStartData,
	RpcAutomationCommandType,
	RpcAutomationResponse,
	RpcCommand,
	RpcMcpAuthUrlEvent,
	RpcTaskGateCommandType,
	RpcTaskGraphCommandType,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcResponse,
	RpcSessionState,
	RpcSessionStats,
	RpcSlashCommand,
	RpcSourceInfo,
	RunAcceptedData,
	RunGetData,
	TaskGraphGetData,
	TaskGraphListData,
	TaskGraphMutationData,
} from "./rpc-types.ts";

/** Public records emitted by the transport-neutral RPC controller. */
export type RpcWireRecord =
	| RpcResponse
	| RpcAutomationResponse
	| RpcExtensionUIRequest
	| JsonAgentSessionEvent
	| RpcHostRunStreamEvent
	| Exclude<PublicRunStreamEvent, { type: "run.event" }>
	| { type: "extension_error"; event: string; error: "Extension failed." }
	| RpcMcpAuthUrlEvent;

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
	ExternalExecutionMapping,
	ExternalExecutionRef,
	ExternalMappingSummary,
	ExternalMappingPersistenceResult,
	ExternalMappingRequest,
	GetCapabilitiesData,
	GetExecutionPolicyData,
	GetModelRoutesData,
	InitializeData,
	McpAuthStartData,
	RpcAutomationCommandType,
	RpcAutomationResponse,
	RpcAuditCommandType,
	RpcAuditQueryCommand,
	RpcAuditReplayCommand,
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcMcpAttachmentReceipt,
	RpcMcpAuthStatus,
	RpcMcpAuthUrlEvent,
	RpcMcpCommandType,
	RpcResponse,
	RpcExternalMapCommand,
	RpcRunCommandType,
	RpcSessionState,
	RpcTaskGateCommandType,
	RpcTaskGraphCommandType,
	RunAcceptedData,
	RunCancelData,
	RunGetData,
	RunReceipt,
	RunRecord,
	RunRecoveryState,
	RunStatus,
	RunStreamEvent,
	RunTerminalStatus,
	TaskGraphGetData,
	TaskGraphListData,
	TaskGraphMutationData,
} from "./rpc-types.ts";

function serializePublicSessionStats(stats: SessionStats): RpcSessionStats {
	const { sessionFile: _sessionFile, ...publicStats } = stats;
	return publicStats;
}

function serializePublicSourceInfo(sourceInfo: SourceInfo): RpcSourceInfo {
	return { scope: sourceInfo.scope, origin: sourceInfo.origin };
}

/**
 * Read a target Session's existing automation ledger without opening it through
 * SessionManager. Resume idempotency must inspect durable state before
 * switchSession() runs any recovery side effects.
 */
function loadReadOnlyRunCoordinator(
	sessionPath: string,
): { sessionId: string; coordinator?: RunLifecycleCoordinator } | undefined {
	try {
		const fileEntries = loadEntriesFromFile(sessionPath);
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
		try {
			return {
				sessionId: header.id,
				coordinator: createRunLifecycleCoordinator(readOnlySession, { diagnostics: () => {} }),
			};
		} catch {
			// The header still provides a stable scope even when unrelated persisted
			// history cannot be folded safely.
			return { sessionId: header.id };
		}
	} catch {
		// The ordinary resume path remains authoritative for malformed/unavailable
		// targets. This helper is only a pre-switch idempotency lookup.
		return undefined;
	}
}

function hashResumeTargetPath(sessionPath: string): string {
	return `path:${crypto.createHash("sha256").update(sessionPath, "utf8").digest("hex")}`;
}

/** Bounded probe deadline for an External Agent Adapter target before any start. */
const EXTERNAL_AGENT_PROBE_DEADLINE_MS = 10_000;

/**
 * Fixed host-authored `start_rejected` messages that may pass through the
 * external start error mapping verbatim. These are the only lifecycle
 * rejection texts this host creates for the external path (session switch,
 * shutdown, connection close, and the consumed-reservation invariant); any
 * other message carried by a `{code: "start_rejected", message}` payload is
 * caller data and is never forwarded.
 */
const EXTERNAL_AGENT_START_REJECTED_MESSAGES: ReadonlySet<string> = new Set([
	"The Host switched sessions before the external agent started.",
	"Automation Host is shutting down; no new runs are accepted.",
	"The RPC connection closed before the Run was accepted.",
	"reservation has already been accepted or released",
]);

/**
 * Wrap a validated External Agent Adapter run handle in the existing Remote
 * Operation invoker contract, so an external execution settles through
 * `startRemoteOperation` and its Session ledger instead of a second loop or
 * ledger. `execute` awaits the driver terminal receipt and maps only bounded
 * artifacts and the side-effect vocabulary; `cancel` and `heartbeat` delegate
 * to the driver handle, which is idempotent. Without a lease in the adapter
 * start request, heartbeat fails closed (the driver and the operation both
 * reject). The stable external error code is preserved by the caller from the
 * adapter receipt for the Run terminal; the Remote Operation receipt keeps
 * only the small error-category vocabulary.
 */
export function createExternalAgentRemoteInvoker(adapterRun: ExternalAgentRunHandle): RemoteOperationInvoker {
	return {
		async execute(): Promise<RemoteOperationResult> {
			const receipt = await adapterRun.receipt;
			if (receipt.status === "completed") {
				return {
					...(receipt.artifactRefs.length === 0 ? {} : { artifactRefs: receipt.artifactRefs }),
					...(receipt.sideEffects === "none" ? {} : { sideEffects: receipt.sideEffects }),
				};
			}
			// The driver already rewrote cancelled receipts that report associated
			// or unknown side effects into failed side-effect-unknown, so a
			// `cancelled` status here is side-effect-free and maps to the
			// operation's cancelled category.
			throw new RemoteOperationError(receipt.status === "cancelled" ? "cancelled" : "invalid", {
				retryable: false,
				sideEffects: receipt.sideEffects,
			});
		},
		async cancel(): Promise<void> {
			await adapterRun.cancel();
		},
		async heartbeat(_heartbeat: RemoteOperationHeartbeat): Promise<RemoteOperationLease> {
			return adapterRun.heartbeat();
		},
	};
}

/**
 * Owns the RPC and Automation Host command/lifecycle state independently of
 * the transport used to deliver commands or records.
 */
export class RpcHostController {
	private readonly runtimeHost: AgentSessionRuntime;
	private outputSink: RpcHostOutputSink | undefined;
	private readonly onShutdown?: () => void;
	private commandHandler?: (command: RpcCommand) => Promise<RpcResponse | RpcAutomationResponse | undefined>;
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
		let session = runtimeHost.session;
		let unsubscribe: (() => void) | undefined;
		let unsubscribeBackpressure: (() => void) | undefined;

		// Automation Host v1 state
		let hostInitialized = false;
		let coordinator: RunLifecycleCoordinator | undefined;
		let taskGateStore: TaskGateStore | undefined;
		let taskGraphStore: TaskGraphStore | undefined;
		let activeHandle: RunHandle | undefined;
		/** Reservation held while the run's preflight is in flight; cleared on accept or release. */
		let activeReservation: RunReservation | undefined;
		const runPromptPromises = new Map<RunId, Promise<void>>();
		const settledRunIds = new Set<RunId>();
		/** Terminal error detected from agent_end (stopReason "error"); used to settle failed/model_error. */
		const terminalErrorByRun = new Map<RunId, AutomationError>();
		const runDeadlineTimers = new Map<RunId, ReturnType<typeof setTimeout>>();
		const pendingStartPromises = new Set<Promise<RpcAutomationResponse | undefined>>();
		/**
		 * Active external agent executions keyed by runId. Cancel is forwarded to
		 * the adapter handle, which the driver makes idempotent; the terminal
		 * settlement path owns the Run terminal record.
		 */
		const externalRuns = new Map<RunId, { cancel: () => Promise<void> }>();
		/** Tracked external settlement promises keyed by runId (set by trackExternalRun). */
		const externalRunSettlements = new Map<RunId, Promise<void>>();
		/**
		 * Host deadline controllers keyed by runId. Lifecycle transitions abort
		 * them for external runs only, so a pending start readiness race or a
		 * started settlement race resolves even when the adapter never returns.
		 */
		const runAbortControllers = new Map<RunId, AbortController>();
		/**
		 * Deadline controllers of pending external starts, registered when the
		 * external path commits (before preflight and before the externalRuns
		 * entry exists) so lifecycle transitions abort preflight-phase starts
		 * too; preflight is signal-aware and fails closed on the abort.
		 */
		const externalPendingControllers = new Map<RunId, AbortController>();
		/**
		 * Pending external start promises keyed by runId. Lifecycle transitions
		 * must never await them: an adapter or preflight that ignores the abort
		 * signal would block detach/rebind forever. They are aborted best-effort
		 * and their continuation fails closed on the generation/epoch guards.
		 */
		const pendingExternalStarts = new Map<RunId, Promise<RpcAutomationResponse | undefined>>();
		/**
		 * Bumped whenever the Host replaces the Session. A pending external start
		 * captures it at startRun entry and fails closed (start_rejected) if it
		 * changed, so an in-flight start can never resume against the incoming
		 * Session or write a mapping or ledger entry into it.
		 */
		let sessionGeneration = 0;
		let transportEpoch = 0;
		let detachTransportPromise: Promise<void> | undefined;

		type RunRequestIdentity = {
			scopeSessionId: string;
			clientRequestId: string;
			fingerprint: string;
			key: string;
		};
		type PendingRunRequest = {
			fingerprint: string;
			waiters: Array<{ id: string | undefined; command: "run.start" | "run.resume" }>;
		};
		type RunRequestGate =
			| { kind: "none" }
			| { kind: "new"; identity: RunRequestIdentity }
			| { kind: "pending" }
			| { kind: "response"; response: RpcAutomationResponse };
		const pendingRunRequests = new Map<string, PendingRunRequest>();
		/**
		 * Abort controllers of in-flight mcp.auth.start commands keyed by
		 * serverId. Aborted on session rebind, transport detach, and shutdown so
		 * a command in its discovery window settles fail-closed instead of
		 * reporting after the host is gone; the Session's own flow remains
		 * bounded by its authorization timeout and session-scoped abort
		 * controller.
		 */
		const mcpAuthControllers = new Map<string, AbortController>();

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
		// Automation Host v1 helpers
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
			// Attach mutates the session attachment registry; gated while the
			// Automation Host is initialized. List/read/get/auth stay available.
			"mcp.attach_resource",
			"mcp.attach_prompt",
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
			| "audit_replay_incomplete"
			| "external_mapping_invalid"
			| "external_mapping_conflict"
			| "audit_persistence_failed";

		const isAuditAutomationCode = (value: unknown): value is AuditAutomationCode =>
			value === "audit_query_invalid" ||
			value === "audit_cursor_invalid" ||
			value === "audit_scope_unavailable" ||
			value === "audit_run_not_found" ||
			value === "audit_replay_incomplete" ||
			value === "external_mapping_invalid" ||
			value === "external_mapping_conflict" ||
			value === "audit_persistence_failed";

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
				case "external_mapping_invalid":
					return "The external mapping is invalid.";
				case "external_mapping_conflict":
					return "The external mapping conflicts with append-only mapping history.";
				case "audit_persistence_failed":
					return "The external mapping could not be persisted.";
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

		const mcpFallbackMessage = (code: AutomationErrorCode): string => {
			switch (code) {
				case "capability_denied":
					return "The MCP operation was denied by the capability binding.";
				case "capability_approval_required":
					return "The MCP operation requires an approval that is not granted in headless mode.";
				case "capability_mcp_connect_failed":
					return "The MCP server could not be reached.";
				case "capability_mcp_auth_required":
					return "MCP server authentication is required and could not be completed.";
				case "capability_mcp_unavailable":
					return "The MCP operation could not be completed.";
				default:
					return "The MCP operation failed.";
			}
		};

		/**
		 * Fixed wire message for a capability/policy failure code surfacing
		 * through an MCP command. Never derived from the error payload: a
		 * caller-supplied message, raw URI, capability id, policy source, token,
		 * or remote text cannot reach the wire.
		 */
		const mcpCommandWireMessage = (code: AutomationErrorCode, fallback: AutomationErrorCode): string => {
			switch (code) {
				case "capability_denied":
				case "capability_approval_required":
				case "capability_mcp_connect_failed":
				case "capability_mcp_auth_required":
				case "capability_mcp_unavailable":
					return mcpFallbackMessage(code);
				case "capability_profile_not_found":
					return "The capability profile is not available.";
				case "capability_name_conflict":
					return "Multiple selected capabilities expose the same name.";
				case "capability_binding_unavailable":
					return "The capability binding is unavailable.";
				case "policy_approval_required":
					return "The operation requires an approval that is not granted in headless mode.";
				case "policy_denied":
				case "policy_violation":
					return "The operation was denied by the execution policy.";
				case "workspace_boundary_violation":
				case "network_policy_violation":
				case "credential_policy_violation":
					return "The operation violates the execution policy.";
				case "sandbox_required":
				case "sandbox_unavailable":
				case "sandbox_start_failed":
				case "sandbox_capability_insufficient":
					return "The operation requires a sandbox provider that is not available.";
				default:
					return mcpFallbackMessage(fallback);
			}
		};

		/**
		 * Map an MCP content/auth failure to a stable, public-safe Automation
		 * Error. Only the classified code survives; the wire message is always a
		 * fixed template derived from the code, so MCPError / MCPAuthError /
		 * CapabilityError / PolicyError can never pass their message, a raw URI,
		 * a capability id, or a policy source onto the wire. Anything unclassified
		 * degrades to the fallback code and a fixed message, so remote error text
		 * can never reach the wire either.
		 */
		const mcpCommandError = (err: unknown, fallback: AutomationErrorCode): AutomationError => {
			if (err instanceof MCPError) {
				const code = mcpErrorKindToCapabilityCode(err.kind);
				return createAutomationError(code, mcpFallbackMessage(code), false);
			}
			if (err instanceof MCPAuthError) {
				// A server that does not support OAuth degrades to capability_denied;
				// every other auth failure is auth_required (fixed template messages
				// only; the raw cause is never retained by MCPAuthError).
				const code =
					err.kind === "mcp_auth_unsupported" ? "capability_denied" : "capability_mcp_auth_required";
				return createAutomationError(code, mcpFallbackMessage(code), false);
			}
			if (err instanceof CapabilityError) {
				return createAutomationError(err.code, mcpCommandWireMessage(err.code, fallback), false);
			}
			if (err instanceof PolicyError) {
				return createAutomationError(err.code, mcpCommandWireMessage(err.code, fallback), false);
			}
			return createAutomationError(fallback, mcpFallbackMessage(fallback), false);
		};

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

		/**
		 * Rebuild the Automation Host state stores for the current Session. The Run
		 * lookup and Task Gate lookup are read-only adapters over the live
		 * coordinator/gate store, so attach only sees current-Session accepted or
		 * running Runs and settle only sees the current terminal receipt; the Task
		 * Graph store never starts, cancels, or rewrites a Run and never creates,
		 * approves, rejects, or cancels a Gate.
		 */
		const rebuildAutomationStores = (): void => {
			coordinator = createRunLifecycleCoordinator(session.sessionManager);
			taskGateStore = createTaskGateStore(session.sessionManager);
			taskGraphStore = createTaskGraphStore(
				session.sessionManager,
				{
					get: (runId) => {
						const result = coordinator?.getRun(runId);
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
						taskGateStore?.getByBusinessKey(taskId, stageId, stageRevision),
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

		/** Stable code-derived External Agent Adapter error text; raw detail never escapes. */
		const externalAgentMessage = (code: ExternalAgentError["code"]): string => new ExternalAgentError(code).message;

		/** Map an External Agent Adapter failure to the stable Automation Host contract. */
		const externalAgentAutomationError = (
			err: unknown,
			fallback: ExternalAgentError["code"],
		): AutomationError => {
			const agentError = err instanceof ExternalAgentError ? err : toExternalAgentError(err, fallback);
			return createAutomationError(agentError.code, agentError.message, agentError.retryable);
		};

		/**
		 * Merge the receipt-side-effect vocabulary the way the Remote Operation
		 * contract does: unknown wins, then associated, then none. Associated or
		 * unknown side effects fail the run closed; they are never cancelled.
		 */
		const mergeExternalAgentSideEffects = (receipt: ExternalAgentReceipt): RemoteOperationSideEffectState => {
			if (receipt.sideEffects === "unknown" || receipt.error?.sideEffects === "unknown") return "unknown";
			if (receipt.sideEffects === "associated" || receipt.error?.sideEffects === "associated") return "associated";
			return "none";
		};

		const asAutomationError = (err: unknown): AutomationError => {
			if (typeof err === "object" && err !== null && "code" in err && "message" in err && "retryable" in err) {
				const candidate = err as AutomationError;
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

		const currentRunModel = (): RunModelReference => {
			const model = session.model;
			return {
				provider: model?.provider ?? "unknown",
				id: model?.id ?? "unknown",
				thinkingLevel: session.thinkingLevel,
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
			modelRoute: ModelRouteSelection | undefined,
			modelRole: ModelRoleSelection | undefined,
			inheritedBinding?: ModelBindingLedgerRecord,
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
				const currentModel = session.model;
				if (currentModel === undefined) return { error: unavailableModelError() };
				const result =
					inheritedDirect !== undefined
						? session.modelBroker.resolveResult({ direct: inheritedDirect })
						: session.modelBroker.hasDefaultSelection()
							? session.modelBroker.resolveResult({})
							: session.modelBroker.resolveResult({
									direct: {
										provider: currentModel.provider,
										id: currentModel.id,
										thinkingLevel: session.thinkingLevel,
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
							session.modelRuntime.getModel(
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
					try {
						await session.setModel(model);
					} catch {
						return { error: unavailableModelError() };
					}
				}
				try {
					session.setModelBrokerResolution(result.resolution, inheritedBinding?.bindingId);
				} catch {
					return { error: unavailableModelError() };
				}
				return { resolution: result.resolution };
			}

			const result = session.modelBroker.resolveResult({
				...(requestedRoute === undefined ? {} : { modelRoute: requestedRoute }),
				...(requestedRole === undefined ? {} : { modelRole: requestedRole }),
			});
			if (!result.ok) {
				return { error: modelSelectionError(result.error, requestedRole === undefined ? "route" : "role") };
			}

			let model: ReturnType<typeof session.modelRuntime.getModel>;
			try {
				model = session.modelRuntime.getModel(result.resolution.reference.provider, result.resolution.reference.id);
			} catch {
				return { error: unavailableModelError() };
			}
			if (model === undefined) return { error: unavailableModelError() };
			try {
				await session.setModel(model);
				session.setModelBrokerResolution(result.resolution, inheritedBinding?.bindingId);
				if (
					result.resolution.reference.thinkingLevel !== undefined &&
					isThinkingLevel(result.resolution.reference.thinkingLevel)
				) {
					session.setThinkingLevel(result.resolution.reference.thinkingLevel);
				}
			} catch {
				return { error: unavailableModelError() };
			}
			return { resolution: result.resolution };
		};

		const usageSnapshot = (): RunUsageSnapshot => {
			const stats = session.getSessionStats();
			return {
				input: stats.tokens.input,
				output: stats.tokens.output,
				total: stats.tokens.total,
			};
		};

		const serializeRunModelAttempt = (value: unknown): RunModelAttemptSummary | undefined => {
			const attempt = serializePublicModelAttempt(value);
			if (attempt === undefined) return undefined;
			return {
				attemptId: attempt.attemptId,
				bindingId: attempt.bindingId,
				candidate: {
					provider: attempt.candidate.provider,
					modelId: attempt.candidate.modelId,
					...(attempt.candidate.thinkingLevel === undefined
						? {}
						: { thinkingLevel: attempt.candidate.thinkingLevel }),
				},
				order: attempt.order,
				status: attempt.status,
				startedAt: attempt.startedAt,
				...(attempt.endedAt === undefined ? {} : { endedAt: attempt.endedAt }),
				...(attempt.failureCategory === undefined ? {} : { failureCategory: attempt.failureCategory }),
				...(attempt.usage === undefined ? {} : { usage: { ...attempt.usage } }),
				...(attempt.visibleOutput === undefined ? {} : { visibleOutput: attempt.visibleOutput }),
				...(attempt.contextSnapshotId === undefined ? {} : { contextSnapshotId: attempt.contextSnapshotId }),
				...(attempt.summary === undefined ? {} : { summary: attempt.summary }),
			};
		};

		const modelAttemptsForBinding = (
			bindingId: string | undefined,
		): ReadonlyArray<RunModelAttemptSummary> | undefined => {
			if (bindingId === undefined) return undefined;
			const replay = foldModelBrokerLedger(session.sessionManager.getEntries());
			const attempts = [...replay.attempts.values()]
				.filter((attempt) => attempt.bindingId === bindingId)
				.map((attempt) => serializeRunModelAttempt(attempt))
				.filter((attempt): attempt is RunModelAttemptSummary => attempt !== undefined)
				.sort((a, b) => a.order - b.order || a.startedAt.localeCompare(b.startedAt));
			return attempts.length === 0 ? undefined : attempts;
		};

		const runModelMetadata = (
			handle: RunHandle,
		): {
			modelBindingId?: string;
			previousModelBindingId?: string;
			finalModel?: RunFinalModelReference;
			modelAttempts?: ReadonlyArray<RunModelAttemptSummary>;
			modelBudget?: RunModelBudgetSummary;
		} => {
			const record = handle.record;
			const modelAttempts = modelAttemptsForBinding(record.modelBindingId);
			const bindingBudget =
				record.modelBindingId === undefined
					? undefined
					: session.modelBroker.getBindingBudgetSummary(record.modelBindingId);
			const finalModel =
				modelAttempts === undefined
					? record.finalModel
					: (modelAttempts[modelAttempts.length - 1]?.candidate ?? record.finalModel);
			return {
				...(record.modelBindingId === undefined ? {} : { modelBindingId: record.modelBindingId }),
				...(record.previousModelBindingId === undefined
					? {}
					: { previousModelBindingId: record.previousModelBindingId }),
				...(finalModel === undefined ? {} : { finalModel }),
				...(modelAttempts === undefined ? {} : { modelAttempts }),
				...(bindingBudget === undefined
					? {}
					: {
							modelBudget: {
								...(bindingBudget.committed.modelCalls === undefined
									? {}
									: { modelCalls: bindingBudget.committed.modelCalls }),
								inputTokens: bindingBudget.committed.inputTokens,
								outputTokens: bindingBudget.committed.outputTokens,
								totalTokens: bindingBudget.committed.totalTokens,
								costUsd: bindingBudget.committed.cost,
								...(bindingBudget.budget.maxModelCalls === undefined
									? {}
									: { maxModelCalls: bindingBudget.budget.maxModelCalls }),
								...(bindingBudget.budget.maxInputTokens === undefined
									? {}
									: { maxInputTokens: bindingBudget.budget.maxInputTokens }),
								...(bindingBudget.budget.maxOutputTokens === undefined
									? {}
									: { maxOutputTokens: bindingBudget.budget.maxOutputTokens }),
								...(bindingBudget.budget.maxTotalTokens === undefined
									? {}
									: { maxTotalTokens: bindingBudget.budget.maxTotalTokens }),
								...(bindingBudget.budget.maxCostUsd === undefined
									? {}
									: { maxCostUsd: bindingBudget.budget.maxCostUsd }),
								exceeded: bindingBudget.exceeded,
							},
						}),
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
				external?: ExternalExecutionRef;
				externalAgent?: ExternalAgentSelection;
				deadlineAt?: string;
			},
		): RunRequestIdentity | undefined => {
			if (clientRequestId === undefined) return undefined;
			const identityScope = input.targetSessionId ?? sessionId;
			return {
				scopeSessionId: identityScope,
				clientRequestId,
				fingerprint: createRunRequestFingerprint({
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
					external: input.external,
					externalAgent: input.externalAgent,
					deadlineAt: input.deadlineAt,
				}),
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
			if (publicRecord.external !== undefined) data.external = publicRecord.external;
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
			pendingRunRequests.set(identity.key, { fingerprint: identity.fingerprint, waiters: [] });
			return { kind: "new", identity };
		};

		const finishRunRequest = (identity: RunRequestIdentity | undefined, response: RpcAutomationResponse): void => {
			if (identity === undefined) return;
			const pending = pendingRunRequests.get(identity.key);
			if (pending === undefined || pending.fingerprint !== identity.fingerprint) return;
			pendingRunRequests.delete(identity.key);
			for (const waiter of pending.waiters) {
				output({ ...response, id: waiter.id, command: waiter.command } as RpcAutomationResponse);
			}
		};

		const clearRunDeadline = (runId: RunId): void => {
			const timer = runDeadlineTimers.get(runId);
			if (timer !== undefined) clearTimeout(timer);
			runDeadlineTimers.delete(runId);
			runAbortControllers.delete(runId);
			externalPendingControllers.delete(runId);
		};

		const discardRunRequest = (identity: RunRequestIdentity | undefined): void => {
			if (identity === undefined) return;
			const pending = pendingRunRequests.get(identity.key);
			if (pending === undefined || pending.fingerprint !== identity.fingerprint) return;
			pendingRunRequests.delete(identity.key);
		};

		const finalizeRun = async (
			handle: RunHandle,
			outcome: "completed" | "failed",
			terminalError?: AutomationError,
		): Promise<void> => {
			if (activeHandle !== handle || settledRunIds.has(handle.runId)) return;
			settledRunIds.add(handle.runId);
			let terminal: RunStreamEvent | undefined;
			try {
				terminal = handle.settle({
					outcome,
					terminalError,
					currentUsage: usageSnapshot(),
					contextSnapshotId: session.getContextSnapshotIdForRun(handle.runId),
					...runModelMetadata(handle),
				});
			} catch {
				// The terminal append is the durable transition. Rebuild the coordinator
				// from accepted/started facts so a failed append leaves the run visible as
				// interrupted and does not leave a phantom in-memory session lock.
				settledRunIds.delete(handle.runId);
				if (activeHandle === handle) {
					activeHandle = undefined;
					coordinator = createRunLifecycleCoordinator(session.sessionManager);
				}
				clearRunDeadline(handle.runId);
				runPromptPromises.delete(handle.runId);
				terminalErrorByRun.delete(handle.runId);
				return;
			}
			if (terminal !== undefined) outputRunEvent(terminal);
			clearRunDeadline(handle.runId);
			activeHandle = undefined;
			runPromptPromises.delete(handle.runId);
			terminalErrorByRun.delete(handle.runId);
			await waitForOutput();
		};

		const settleActiveRun = async (handle: RunHandle): Promise<void> => {
			if (activeHandle !== handle || settledRunIds.has(handle.runId)) return;
			// Await the tracked prompt so a post-preflight failure settles the run as
			// failed first; the settledRunIds guard makes this later settle a no-op.
			await runPromptPromises.get(handle.runId);
			const terminalError = terminalErrorByRun.get(handle.runId);
			await finalizeRun(handle, terminalError === undefined ? "completed" : "failed", terminalError);
		};

		/**
		 * Track a started prompt so settleActiveRun can await it and post-preflight
		 * failures surface as a run.failed terminal carrying a model_error.
		 */
		const trackRunPrompt = (handle: RunHandle, prompt: Promise<unknown>): void => {
			const tracked = (async () => {
				try {
					await prompt;
					// Settle directly on completion so a run started by a preflight that
					// never emits agent_settled (e.g. an extension-handled prompt) cannot
					// leak an active run. A terminal error detected from agent_end marks
					// the run failed/model_error; otherwise it completed.
					const terminalError = terminalErrorByRun.get(handle.runId);
					await finalizeRun(handle, terminalError !== undefined ? "failed" : "completed", terminalError);
				} catch {
					const terminalError = terminalErrorByRun.get(handle.runId);
					await finalizeRun(
						handle,
						"failed",
						terminalError ?? createAutomationError("model_error", "Run failed.", false),
					);
				}
			})();
			runPromptPromises.set(handle.runId, tracked);
		};

		/**
		 * Race a terminal promise against the Run deadline signal. The deadline is
		 * a hard bound: an unresponsive adapter must not keep the Run open past
		 * its deadline. Resolves undefined when the deadline fires first.
		 */
		const raceWithDeadlineSignal = <T>(signal: AbortSignal, terminal: Promise<T>): Promise<T | undefined> => {
			if (signal.aborted) return Promise.resolve(undefined);
			return new Promise((resolve) => {
				const onAbort = (): void => resolve(undefined);
				signal.addEventListener("abort", onAbort, { once: true });
				void terminal.then(
					(value) => {
						signal.removeEventListener("abort", onAbort);
					resolve(value);
				},
				() => {
					signal.removeEventListener("abort", onAbort);
					resolve(undefined);
				},
			);
		});
		};

		/**
		 * Track an external agent execution: settle through the existing Remote
		 * Operation machinery (invoker wrapping the same adapter run handle,
		 * `startRemoteOperation`, Session ledger record) and the Run terminal
		 * gate. The adapter receipt is preserved separately for the stable
		 * external error code and the bounded event forwarding. Side effects
		 * associated or unknown settle the run failed
		 * external_agent_side_effect_unknown, never cancelled or retried; the
		 * Remote Operation receipt fail-closes the same way.
		 */
		const trackExternalRun = (
			handle: RunHandle,
			adapterRun: ExternalAgentRunHandle,
			operationId: string,
			deadlineSignal: AbortSignal | undefined,
			adapter?: ExternalAdapterIdentity,
		): void => {
			const remoteRequest: RemoteOperationRequest = {
				operationId,
				runId: handle.runId,
				sessionId: session.sessionId,
				...(handle.record.capabilityBindingId === undefined
					? {}
					: { capabilityBindingId: handle.record.capabilityBindingId }),
				...(handle.record.modelBindingId === undefined ? {} : { modelBindingId: handle.record.modelBindingId }),
				...(handle.record.policyBindingId === undefined
					? {}
					: { policyBindingId: handle.record.policyBindingId }),
				...(handle.record.bindingAssociation === undefined
					? {}
					: { bindingAssociation: handle.record.bindingAssociation }),
				...(handle.record.deadlineAt === undefined ? {} : { deadlineAt: handle.record.deadlineAt }),
				...(adapter === undefined ? {} : { adapter }),
			};
			// A remote.operation ledger append failure must never let the Run report
			// completed or cancelled on an unrecorded external outcome: the observer
			// flag below fails the Run closed with external_agent_persistence_failed.
			let operationLedgerFailed = false;
			const remoteHandle = startRemoteOperation(createExternalAgentRemoteInvoker(adapterRun), remoteRequest, {
				signal: deadlineSignal,
				ledger: createSessionRemoteOperationLedger(session.sessionManager),
				now: () => new Date().toISOString(),
				onLedgerError: () => {
					operationLedgerFailed = true;
				},
			});
			externalRuns.set(handle.runId, {
				cancel: async () => {
					// The operation cancels the provider and the driver cancel is
					// idempotent; both paths reach the adapter handle exactly once.
					await remoteHandle.cancel();
					await adapterRun.cancel();
				},
			});
			const tracked = (async (): Promise<void> => {
				// The Remote Operation receipt is the remote terminal and is durably
				// recorded in the Session ledger by startRemoteOperation. The Run
				// deadline remains a hard bound: if it fires first, settle the Run
				// failed run_deadline_exceeded without waiting for an unresponsive
				// adapter.
				const remoteReceipt = await raceWithDeadlineSignal(deadlineSignal ?? new AbortController().signal, remoteHandle.receipt);
				if (remoteReceipt === undefined) {
					await finalizeRun(
						handle,
						"failed",
						terminalErrorByRun.get(handle.runId) ??
							createAutomationError("run_deadline_exceeded", "The Run deadline was exceeded.", false),
					);
					return;
				}
				// The Remote Operation maps the same Run deadline into its own
				// request.deadlineAt timer. When that timer fires before the host
				// deadlineController, the operation receipt settles cancelled with
				// error.category "deadline": the accepted Run's deadline intent still
				// wins over any target cancelled receipt (PR section 7.4), so settle
				// failed + run_deadline_exceeded and never requestCancel. The host
				// hard-bound race above still covers unresponsive adapters.
				if (remoteReceipt.error?.category === "deadline") {
					handle.requestDeadlineExceeded();
					await finalizeRun(
						handle,
						"failed",
						terminalErrorByRun.get(handle.runId) ??
							createAutomationError("run_deadline_exceeded", "The Run deadline was exceeded.", false),
					);
					return;
				}
				// A failed remote.operation ledger append means the external terminal
				// was not durably recorded: fail closed with
				// external_agent_persistence_failed instead of completing or
				// cancelling the Run on an unrecorded outcome.
				if (operationLedgerFailed) {
					await finalizeRun(
						handle,
						"failed",
						createAutomationError(
							"external_agent_persistence_failed",
							externalAgentMessage("external_agent_persistence_failed"),
							false,
						),
					);
					return;
				}
				// Map bounded events only: validated started/progress/artifact
				// observations become run.event records; transcripts, prompts, and
				// raw protocol data never cross the driver boundary.
				for (const event of adapterRun.eventsList) {
					const emitted = handle.captureSessionEvent({ type: "external_agent_event", event });
					if (emitted !== undefined) outputRunEvent(emitted);
				}
				// Run terminal gate: the adapter receipt preserves the stable
				// external error code; side effects associated or unknown settle
				// failed external_agent_side_effect_unknown, never cancelled or
				// retried. A cancelled adapter receipt is side-effect-free by the
				// driver's fail-closed rewrite.
				const adapterReceipt = await adapterRun.receipt;
				let outcome: "completed" | "failed";
				let terminalError: AutomationError | undefined;
				if (adapterReceipt.status === "completed") {
					outcome = "completed";
				} else if (adapterReceipt.status === "cancelled") {
					handle.requestCancel();
					outcome = "completed";
				} else {
					outcome = "failed";
					const sideEffects = mergeExternalAgentSideEffects(adapterReceipt);
					const code =
						sideEffects === "none" &&
						adapterReceipt.error !== undefined &&
						isAutomationErrorCode(adapterReceipt.error.code)
							? adapterReceipt.error.code
							: "external_agent_side_effect_unknown";
					terminalError = createAutomationError(code, externalAgentMessage(code), false);
				}
				await finalizeRun(handle, outcome, terminalError);
			})();
			externalRunSettlements.set(handle.runId, tracked);
			void tracked.then(
				() => {
					externalRuns.delete(handle.runId);
					externalRunSettlements.delete(handle.runId);
				},
				() => {
					externalRuns.delete(handle.runId);
					externalRunSettlements.delete(handle.runId);
				},
			);
		};

		/**
		 * Forward the existing Run cancellation intent to the adapter's idempotent
		 * cancel path during a host lifecycle transition (transport detach, host
		 * shutdown, session switch). The run's deadline controller is aborted
		 * first so a pending start readiness race or a started settlement race
		 * resolves even when the adapter never returns: the driver cancel alone
		 * awaits startGate and cannot unblock a start that never resolves. Started
		 * settlements are awaited so the terminal is durably recorded through the
		 * existing Run and Remote Operation gates; a pending start fails closed
		 * through its own continuation, which forwards the same idempotent cancel.
		 * Local runs are untouched and keep the session.abort() path. Returns true
		 * when the run was an external execution.
		 */
		const forwardExternalRunLifecycleCancel = async (runId: RunId): Promise<boolean> => {
			const externalRun = externalRuns.get(runId);
			if (externalRun === undefined) return false;
			runAbortControllers.get(runId)?.abort();
			const settlement = externalRunSettlements.get(runId);
			if (settlement !== undefined) {
				await settlement;
			}
			void externalRun.cancel().catch(() => {
				// The driver retries idempotently; the tracked settlement owns the terminal.
			});
			return true;
		};

		const trackPendingStart = (
			pending: Promise<RpcAutomationResponse | undefined>,
		): Promise<RpcAutomationResponse | undefined> => {
			pendingStartPromises.add(pending);
			void pending.then(
				() => pendingStartPromises.delete(pending),
				() => pendingStartPromises.delete(pending),
			);
			return pending;
		};

		const startRun = async (
			id: string | undefined,
			commandType: "run.start" | "run.resume",
			message: string,
			images: ImageContent[] | undefined,
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
			external: ExternalExecutionRef | undefined,
			externalAgent: ExternalAgentSelection | undefined,
			deadlineAt: string | undefined,
			clientRequestId: string | undefined,
			precomputedRequestIdentity: RunRequestIdentity | undefined,
			requestAlreadyClaimed: boolean,
			expectedTransportEpoch?: number,
		): Promise<RpcAutomationResponse | undefined> => {
			const requestEpoch = expectedTransportEpoch ?? transportEpoch;
			const startGeneration = sessionGeneration;
			const inputError = slashRunInputError(id, commandType, message);
			if (inputError !== undefined) {
				discardRunRequest(precomputedRequestIdentity);
				return inputError;
			}
			if (external !== undefined && !isExternalExecutionRef(external)) {
				discardRunRequest(precomputedRequestIdentity);
				return automationError(id, commandType, auditCommandError(undefined, "external_mapping_invalid"));
			}
			if (externalAgent !== undefined && !isExternalAgentSelection(externalAgent)) {
				discardRunRequest(precomputedRequestIdentity);
				return automationError(
					id,
					commandType,
					createAutomationError(
						"external_agent_adapter_invalid",
						"The External Agent Adapter selection is invalid.",
						false,
					),
				);
			}
			// The v1 adapter contract has start() only; there is no same-ref resume
			// API, so an external run.resume can never be honored. Reject it instead
			// of silently starting a fresh execution with a new operation id.
			if (commandType === "run.resume" && externalAgent !== undefined) {
				discardRunRequest(precomputedRequestIdentity);
				return automationError(
					id,
					commandType,
					createAutomationError(
						"external_agent_resume_unsupported",
						externalAgentMessage("external_agent_resume_unsupported"),
						false,
					),
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
			if (!hostInitialized || coordinator === undefined) {
				discardRunRequest(precomputedRequestIdentity);
				return automationError(id, commandType, hostNotInitializedError());
			}
			const identity =
				precomputedRequestIdentity ??
				requestIdentity(clientRequestId, commandType, session.sessionId, {
					message,
					images,
					sourceRunId,
					capabilityProfile,
					policyProfile,
					modelRoute,
					modelRole,
					external,
					externalAgent,
					deadlineAt,
				});
			let requestClaim: RunRequestIdentity | undefined;
			const startFailure = (response: RpcAutomationResponse): RpcAutomationResponse => {
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
					coordinator!.getRunByClientRequestId(
						identity!.clientRequestId,
						commandType === "run.start" ? "start" : "resume",
					),
				);
				if (gate.kind === "response") return gate.response;
				if (gate.kind === "pending") return undefined;
				if (gate.kind === "new") requestClaim = gate.identity;
			}
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
			if (coordinator.activeRun !== undefined || activeReservation !== undefined) {
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
			// Explicit External Agent Adapter selection: resolve the trusted
			// adapter/target and probe it with a bounded deadline BEFORE any
			// preflight or ledger write. The probe carries no business input; only a
			// target that confirms a known protocol/version and the minimum
			// capability gate (start, terminal receipt, cooperative or strong cancel)
			// may enter the existing Model/Capability/Policy/Sandbox preflight below.
			let externalProbe:
				| {
						readonly adapter: ExternalAgentAdapter;
						readonly selection: ExternalAgentSelection;
						readonly snapshot: ExternalAgentCapabilitySnapshot;
				  }
				| undefined;
			if (externalAgent !== undefined) {
				const registry = session.getExternalAgentRegistry?.();
				if (registry === undefined) {
					return startFailure(
						automationError(
							id,
							commandType,
							createAutomationError(
								"external_agent_adapter_invalid",
								"No trusted External Agent Adapter registry is composed into this Host.",
								false,
							),
						),
					);
				}
				const safeSelection = serializeExternalAgentSelection(externalAgent);
				if (safeSelection === undefined) {
					return startFailure(
						automationError(
							id,
							commandType,
							createAutomationError(
								"external_agent_adapter_invalid",
								"The External Agent Adapter selection is invalid.",
								false,
							),
						),
					);
				}
				let resolved: ExternalAgentResolved;
				try {
					resolved = registry.resolve(safeSelection);
				} catch (err) {
					return startFailure(
						automationError(id, commandType, externalAgentAutomationError(err, "external_agent_adapter_invalid")),
					);
				}
				const probeController = new AbortController();
				// The probe is bounded by both the fixed probe deadline and the
				// requested Run deadline when one is earlier: a run with a 1s deadline
				// must not spend 10s in probe. The Run deadline winning maps to
				// run_deadline_exceeded; the probe deadline winning maps to
				// external_agent_probe_failed.
				const runDeadlineMs =
					deadlineAt === undefined ? undefined : Date.parse(deadlineAt) - Date.now();
				const probeDeadlineMs = Math.min(
					EXTERNAL_AGENT_PROBE_DEADLINE_MS,
					runDeadlineMs === undefined ? EXTERNAL_AGENT_PROBE_DEADLINE_MS : runDeadlineMs,
				);
				const probeDeadline = new Date(Date.now() + probeDeadlineMs).toISOString();
				const probeTimer = setTimeout(() => probeController.abort(), Math.max(0, probeDeadlineMs));
				if (
					typeof probeTimer === "object" &&
					"unref" in probeTimer &&
					typeof probeTimer.unref === "function"
				) {
					probeTimer.unref();
				}
				let snapshot: ExternalAgentCapabilitySnapshot | undefined;
				try {
					// The probe AbortSignal also bounds the Host await itself: an
					// adapter that ignores the signal and never settles must not hang
					// run.start past the probe bound. A synchronous throw or a rejected
					// probe settles the race the same way: probe failed.
					snapshot = await raceWithDeadlineSignal(
						probeController.signal,
						resolved.adapter.probe(resolved.target, {
							signal: probeController.signal,
							deadlineAt: probeDeadline,
						}),
					);
				} catch {
					snapshot = undefined;
				} finally {
					clearTimeout(probeTimer);
				}
				if (snapshot === undefined) {
					// The requested Run deadline expiring during probe is a deadline
					// failure, not a probe failure: the run never entered preflight or
					// acceptance, and the deadline intent wins.
					const probeError =
						deadlineAt !== undefined && Date.parse(deadlineAt) <= Date.now()
							? createAutomationError(
									"run_deadline_exceeded",
									"The Run deadline was exceeded before acceptance.",
									false,
								)
							: createAutomationError(
									"external_agent_probe_failed",
									externalAgentMessage("external_agent_probe_failed"),
									false,
								);
					return startFailure(automationError(id, commandType, probeError));
				}
				// Exact-shape guard: a target self-report that is not a bounded snapshot
				// with a known protocol/version and capability vocabulary is a probe
				// failure, never a protocol we recognize.
				if (!isExternalAgentCapabilitySnapshot(snapshot)) {
					return startFailure(
						automationError(
							id,
							commandType,
							createAutomationError(
								"external_agent_probe_failed",
								externalAgentMessage("external_agent_probe_failed"),
								false,
							),
						),
					);
				}
				// Identity guard: the snapshot must self-identify exactly as the
				// resolved explicit selection. A probe that reports a different
				// adapter or target fails closed before any preflight or acceptance.
				if (
					snapshot.adapterId !== resolved.selection.adapterId ||
					snapshot.targetId !== resolved.selection.targetId
				) {
					return startFailure(
						automationError(
							id,
							commandType,
							createAutomationError(
								"external_agent_probe_failed",
								externalAgentMessage("external_agent_probe_failed"),
								false,
							),
						),
					);
				}
				const capabilityGateError = externalAgentCapabilityError(snapshot);
				if (capabilityGateError !== undefined) {
					return startFailure(
						automationError(
							id,
							commandType,
							createAutomationError(capabilityGateError, externalAgentMessage(capabilityGateError), false),
						),
					);
				}
				externalProbe = { adapter: resolved.adapter, selection: safeSelection, snapshot };
			}
			const proposedRunId = crypto.randomUUID();
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
				await session.setExecutionPolicyProfile(policyProfile);
				session.setPreviousExecutionPolicyBindingIdForNextRun(previousPolicyBindingId);
				await session.setCapabilityProfile(capabilityProfile, { runId: proposedRunId });
			} catch (err) {
				return startFailure(automationError(id, commandType, capabilityError(err)));
			}
			// The materialized profile (requested, or the configured default when omitted)
			// names the effective profile for the approval-required message below.
			const effectiveProfile = session.getActiveCapabilityProfile();
			let reservation: RunReservation;
			try {
				reservation = coordinator.reserve();
			} catch (err) {
				return startFailure(automationError(id, commandType, asAutomationError(err)));
			}
			activeReservation = reservation;
			try {
				await session.whenCapabilitiesReady(proposedRunId);
			} catch (err) {
				activeReservation = undefined;
				try {
					reservation.release();
				} catch {
					// reservation may already be consumed
				}
				return startFailure(automationError(id, commandType, capabilityError(err)));
			}
			if (requestEpoch !== transportEpoch) {
				activeReservation = undefined;
				try {
					reservation.release();
				} catch {
					// reservation may already be consumed
				}
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
			const preflightBinding = session.getActiveCapabilityBinding();
			if (previousBindingId !== undefined) {
				// Resume binding-drift guard. This runs only after capability discovery has
				// settled (whenCapabilitiesReady above) so a restored MCP binding that
				// initially differs until discovery completes cannot false-fail. The binding
				// id is derived from descriptor id + revision + profile, so id equality is
				// the drift check. Rejection happens before session.prompt/accept, so no
				// accepted/terminal ledger write occurs.
				const knownBindings = foldCapabilityBindingEntries(session.sessionManager.getEntries());
				if (knownBindings.get(previousBindingId) === undefined) {
					activeReservation = undefined;
					try {
						reservation.release();
					} catch {
						// reservation may already be consumed
					}
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
					activeReservation = undefined;
					try {
						reservation.release();
					} catch {
						// reservation may already be consumed
					}
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
				activeReservation = undefined;
				try {
					reservation.release();
				} catch {
					// reservation may already be consumed
				}
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
			const modelSelection = await resolveRequestedModel(modelRoute, modelRole, inheritedModelBinding);
			if (requestEpoch !== transportEpoch) {
				activeReservation = undefined;
				try {
					reservation.release();
				} catch {
					// reservation may already be consumed
				}
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
				activeReservation = undefined;
				try {
					reservation.release();
				} catch {
					// reservation may already be consumed
				}
				return startFailure(automationError(id, commandType, modelSelection.error));
			}
			if (deadlineAt !== undefined && Date.parse(deadlineAt) <= Date.now()) {
				activeReservation = undefined;
				try {
					reservation.release();
				} catch {
					// reservation may already be consumed
				}
				return startFailure(
					automationError(
						id,
						commandType,
						createAutomationError("run_deadline_exceeded", "The Run deadline expired during preflight.", false),
					),
				);
			}
			// Reserve before the prompt's preflight so the session is busy while the run
			// is pending. Only a preflight that succeeds persists the accepted fact and
			// starts the run; otherwise the reservation is released and the caller gets
			// start_rejected with no run id and no ledger entry.
			const deadlineController = new AbortController();
			runAbortControllers.set(proposedRunId, deadlineController);
			if (deadlineAt !== undefined) {
				const deadlineTimer = setTimeout(
					() => {
						const deadlineError = createAutomationError(
							"run_deadline_exceeded",
							"The Run deadline was exceeded.",
							false,
						);
						terminalErrorByRun.set(proposedRunId, deadlineError);
						deadlineController.abort(new AgentOperationError("deadline_exceeded"));
						if (activeHandle?.runId === proposedRunId) {
							activeHandle.requestDeadlineExceeded();
							void session.abort().catch(() => {
								// The normal Run settlement path owns the terminal transition.
							});
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
				runDeadlineTimers.set(proposedRunId, deadlineTimer);
			}
			let promptPromise: Promise<unknown>;
			const rejectStart = (err: unknown): void => {
				if (activeReservation !== reservation) return;
				activeReservation = undefined;
				clearRunDeadline(proposedRunId);
				terminalErrorByRun.delete(proposedRunId);
				try {
					reservation.release();
				} catch {
					// reservation may already be consumed
				}
				const startError = deadlineController.signal.aborted
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
			// ---- External Agent Adapter run path -------------------------------
			// The existing Model/Capability/Policy/Sandbox preflight ran above; the
			// prompt-preflight policy/sandbox preparation runs without the model
			// loop, the adapter executes with the bounded in-memory input, and the
			// run settles through the existing Remote Operation and Run terminal
			// gates. Every external failure maps to a stable external_agent_* code.
			let externalAccepted = false;
			let externalAdapterRun: ExternalAgentRunHandle | undefined;
			const failExternalStart = (
				err: unknown,
				fallback: ExternalAgentError["code"] = "external_agent_start_failed",
			): RpcAutomationResponse | undefined => {
				if (externalAccepted) {
					// The accepted fact is durable but the run never started: discard
					// the live coordinator so this failed start cannot retain Session
					// ownership; its ledger record is replayed as interrupted if
					// recovered. No external.mapping was persisted and no started
					// event carries a placeholder external ref.
					activeReservation = undefined;
					activeHandle = undefined;
					coordinator = createRunLifecycleCoordinator(session.sessionManager);
					externalRuns.delete(proposedRunId);
					void externalAdapterRun?.cancel().catch(() => {
						// The driver retries idempotently; the receipt settles the run.
					});
				} else if (activeReservation === reservation) {
					activeReservation = undefined;
					try {
						reservation.release();
					} catch {
						// reservation may already be consumed
					}
				}
				clearRunDeadline(proposedRunId);
				terminalErrorByRun.delete(proposedRunId);
				const startError = mapExternalStartError(err, fallback);
				const response = automationError(id, commandType, startError);
				output(response);
				finishRunRequest(requestClaim, response);
				return undefined;
			};

			/**
			 * Map an external start-phase failure to a stable Automation Host error
			 * without leaking raw provider detail. ExternalAgentError keeps its
			 * stable code; known mapping/ledger store codes fold into the adapter
			 * vocabulary (external_agent_mapping_invalid / _conflict /
			 * _persistence_failed); every other raw exception becomes the phase
			 * fallback code (prepare -> external_agent_binding_unsupported, start
			 * -> external_agent_start_failed, mapping ->
			 * external_agent_persistence_failed) with the code-derived message, so
			 * caller payloads, paths, commands, and credentials never escape
			 * through Error.message.
			 */
			const mapExternalStartError = (err: unknown, fallback: ExternalAgentError["code"]): AutomationError => {
				if (err instanceof ExternalAgentError) return externalAgentAutomationError(err, fallback);
				// A lifecycle rejection (transport detach, host shutdown, session
				// switch, consumed reservation) is pre-encoded as start_rejected and
				// must keep its code, fixed message, and retryable flag even when the
				// transition aborted the deadline controller: the rejection is the
				// cause, not the deadline. Only the host's own fixed messages pass
				// through; a spoofed `{code: "start_rejected", message: "..."}`
				// payload falls through to the phase fallback below so caller text
				// can never ride a known code out of the host.
				if (
					typeof err === "object" &&
					err !== null &&
					"code" in err &&
					(err as { code?: unknown }).code === "start_rejected"
				) {
					const rejected = err as AutomationError;
					if (EXTERNAL_AGENT_START_REJECTED_MESSAGES.has(rejected.message)) {
						return createAutomationError("start_rejected", rejected.message, rejected.retryable === true);
					}
				}
				if (deadlineController.signal.aborted) {
					return createAutomationError(
						"run_deadline_exceeded",
						"The Run deadline was exceeded before acceptance.",
						false,
					);
				}
				const code =
					typeof err === "object" && err !== null && "code" in err
						? (err as { code?: unknown }).code
						: undefined;
				if (typeof code === "string" && isAutomationErrorCode(code)) {
					if (code === "external_mapping_invalid") {
						return createAutomationError(
							"external_agent_mapping_invalid",
							externalAgentMessage("external_agent_mapping_invalid"),
							false,
						);
					}
					if (code === "external_mapping_conflict") {
						return createAutomationError(
							"external_agent_mapping_conflict",
							externalAgentMessage("external_agent_mapping_conflict"),
							false,
						);
					}
					if (code === "audit_persistence_failed" || code === "ledger_persistence_failed") {
						return createAutomationError(
							"external_agent_persistence_failed",
							externalAgentMessage("external_agent_persistence_failed"),
							false,
						);
					}
					// A known stable code keeps its code only when it is part of the
					// External Agent vocabulary, and it is always paired with the
					// code-derived allowlisted message, never with the raw
					// Error.message. Any other known code (for example session_busy
					// from the reservation layer) is not an adapter outcome and falls
					// back to the phase fallback, so a payload that borrows a known
					// code cannot smuggle caller text into the public error.
					if (EXTERNAL_AGENT_ERROR_CODES.includes(code as ExternalAgentError["code"])) {
						return createAutomationError(code, externalAgentMessage(code as ExternalAgentError["code"]), false);
					}
					return createAutomationError(fallback, externalAgentMessage(fallback), false);
				}
				return createAutomationError(fallback, externalAgentMessage(fallback), false);
			};
			const runExternalStart = async (): Promise<RpcAutomationResponse | undefined> => {
				const probe = externalProbe;
				if (probe === undefined) {
					return failExternalStart(new ExternalAgentError("external_agent_adapter_invalid"));
				}
				// Session replacement guard: the Run was accepted for the session that
				// prepared it. If the Host switched sessions while the start was
				// pending, the run must fail closed instead of continuing against the
				// incoming Session; its accepted record replays as interrupted in the
				// outgoing session. The client can retry on the new session.
				const sessionSwitchedStartError = (): AutomationError =>
					createAutomationError(
						"start_rejected",
						"The Host switched sessions before the external agent started.",
						true,
					);
				if (startGeneration !== sessionGeneration) {
					return failExternalStart(sessionSwitchedStartError());
				}
				if (shuttingDown) {
					return failExternalStart(
						createAutomationError(
							"start_rejected",
							"Automation Host is shutting down; no new runs are accepted.",
							false,
						),
					);
				}
				try {
					await session.runExternalAgentPreflight(proposedRunId, deadlineController.signal);
				} catch (err) {
					// The abort of a lifecycle transition (detach, shutdown, session
					// switch) surfaces through the signal-aware preflight; report the
					// actual cause instead of a provider or deadline failure.
					if (startGeneration !== sessionGeneration) {
						return failExternalStart(sessionSwitchedStartError());
					}
					if (requestEpoch !== transportEpoch) {
						return failExternalStart(
							createAutomationError(
								"start_rejected",
								"The RPC connection closed before the Run was accepted.",
								true,
							),
						);
					}
					if (shuttingDown) {
						return failExternalStart(
							createAutomationError(
								"start_rejected",
								"Automation Host is shutting down; no new runs are accepted.",
								false,
							),
						);
					}
					return failExternalStart(err);
				}
				if (startGeneration !== sessionGeneration) {
					return failExternalStart(sessionSwitchedStartError());
				}
				if (requestEpoch !== transportEpoch) {
					return failExternalStart(
						createAutomationError(
							"start_rejected",
							"The RPC connection closed before the Run was accepted.",
							true,
						),
					);
				}
				if (shuttingDown) {
					return failExternalStart(
						createAutomationError(
							"start_rejected",
							"Automation Host is shutting down; no new runs are accepted.",
							false,
						),
					);
				}
				if (
					deadlineController.signal.aborted ||
					(deadlineAt !== undefined && Date.parse(deadlineAt) <= Date.now())
				) {
					return failExternalStart(
						createAutomationError(
							"run_deadline_exceeded",
							"The Run deadline expired during preflight.",
							false,
						),
					);
				}
				// Prepare the immutable Binding from the frozen preflight facts. The
				// binding is reference-only unless the probed target proves the
				// tool-gateway capability; the prepared binding is verified against
				// the prepare request and the probe before any start.
				const capabilityBinding = session.getActiveCapabilityBinding();
				const policyBinding = session.getActiveExecutionPolicyBinding();
				const bindingHandles = session.getActiveBindingHandles();
				const capabilitySummary: string[] = [];
				if (capabilityBinding !== undefined) {
					for (const descriptor of capabilityBinding.descriptors) {
						const name = descriptor.exposedToolName;
						if (name !== undefined && name.length >= 1 && name.length <= EXTERNAL_AGENT_CAPABILITY_SUMMARY_ITEM_MAX_LENGTH) {
							capabilitySummary.push(name);
						}
						if (capabilitySummary.length >= EXTERNAL_AGENT_MAX_CAPABILITY_SUMMARY) break;
					}
				}
				const bindingAssociation =
					bindingHandles.length === 0 ? undefined : createRunBindingAssociation(proposedRunId, bindingHandles);
				const prepareRequest: ExternalAgentPrepareRequest = {
					runId: proposedRunId,
					sessionId: session.sessionId,
					selection: probe.selection,
					...(modelSelection.resolution === undefined
						? {}
						: { modelBindingId: modelSelection.resolution.bindingId }),
					...(capabilityBinding === undefined ? {} : { capabilityBindingId: capabilityBinding.id }),
					...(policyBinding === undefined ? {} : { policyBindingId: policyBinding.id }),
					...(bindingAssociation === undefined ? {} : { bindingAssociation }),
					capabilitySummary,
					policyProfile: session.getActiveExecutionPolicyProfile(),
					...(policyBinding?.sandboxProviderId === undefined
						? {}
						: { sandboxProfile: policyBinding.sandboxProviderId }),
					deadlineAt,
				};
				let prepared: ExternalAgentPreparedBinding;
				try {
					// The trusted adapter owns protocol/version-specific Binding
					// translation: the host invokes adapter.prepare and never uses a
					// default translator, so an unknown protocol/version fails closed
					// in the adapter before any Run acceptance. The result must be a
					// shape-valid prepared binding verified against the prepare request
					// and the probed snapshot.
					prepared = await probe.adapter.prepare(prepareRequest, probe.snapshot);
					if (!isExternalAgentPreparedBinding(prepared)) {
						throw new ExternalAgentError("external_agent_binding_unsupported");
					}
					if (!verifyExternalAgentPreparedBinding(prepared, prepareRequest, probe.snapshot)) {
						throw new ExternalAgentError("external_agent_binding_unsupported");
					}
					// v1 has no independent tool-call/Policy/cancel/result gateway
					// contract and the selection carries no explicit gateway opt-in:
					// a target self-reporting toolGateway=true must never expand the
					// AOS boundary or claim AOS tools, so a gateway-mode prepared
					// binding is rejected until a separate contract exists.
					if (prepared.bindingMode === "tool-gateway") {
						throw new ExternalAgentError("external_agent_binding_unsupported");
					}
				} catch (err) {
					return failExternalStart(err, "external_agent_binding_unsupported");
				}
				let handle: RunHandle;
				// Lifecycle guards before the durable accepted write: a pending
				// external start whose preflight or prepare ignored the abort
				// signal must still fail closed here instead of accepting after a
				// detach, shutdown, or session switch.
				if (startGeneration !== sessionGeneration) {
					return failExternalStart(sessionSwitchedStartError());
				}
				if (requestEpoch !== transportEpoch) {
					return failExternalStart(
						createAutomationError(
							"start_rejected",
							"The RPC connection closed before the Run was accepted.",
							true,
						),
					);
				}
				if (shuttingDown) {
					return failExternalStart(
						createAutomationError(
							"start_rejected",
							"Automation Host is shutting down; no new runs are accepted.",
							false,
						),
					);
				}
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
						model: currentRunModel(),
						...(modelSelection.resolution === undefined
							? {}
							: {
									modelBindingId: modelSelection.resolution.bindingId,
									finalModel: finalModelForResolution(modelSelection.resolution),
								}),
						capabilityBinding: session.getActiveCapabilityBinding(),
						policyBinding: session.getActiveExecutionPolicyBinding(),
						policySummary: session.getActiveExecutionPolicySummary(),
						bindingHandles: session.getActiveBindingHandles(),
					});
					handle.setUsageBaseline(usageSnapshot());
				} catch (err) {
					return failExternalStart(asAutomationError(err));
				}
				activeReservation = undefined;
				activeHandle = handle;
				externalAccepted = true;
				// Start with the bounded in-memory input. Images are never forwarded:
				// the adapter contract carries image references only, never bytes.
				const startRequest: ExternalAgentStartRequest = {
					preparedBinding: prepared,
					input: { message },
					operationId: proposedRunId,
					deadlineAt,
				};
				try {
					externalAdapterRun = runExternalAgentAdapter(probe.adapter, startRequest, {
						signal: deadlineController.signal,
						now: () => new Date().toISOString(),
					});
				} catch (err) {
					return failExternalStart(err);
				}
				// Register the idempotent adapter cancel immediately so run.cancel
				// reaches the adapter even while start readiness is pending.
				externalRuns.set(proposedRunId, {
					cancel: async () => {
						try {
							await externalAdapterRun!.cancel();
						} catch {
							// The driver retries idempotently; the receipt settles the run.
						}
					},
				});
				// Readiness gate: await the driver's explicit start confirmation and
				// persist ONLY the real, validated external ref before the started
				// event. The driver's fallback getter is never persisted. The Run
				// deadline bounds the readiness wait so a hanging adapter.start cannot
				// keep the run pending past its deadline.
				const externalRef = await raceWithDeadlineSignal(deadlineController.signal, externalAdapterRun.externalReady);
				if (externalRef === undefined) {
					// The readiness race resolves undefined when a lifecycle transition
					// aborted the deadline controller (detach, shutdown, session switch)
					// or when the run deadline fired. Report the actual cause: a replaced
					// session or a disconnected transport is a retryable start_rejection,
					// never a deadline that never existed.
					if (startGeneration !== sessionGeneration) {
						return failExternalStart(sessionSwitchedStartError());
					}
					if (requestEpoch !== transportEpoch) {
						return failExternalStart(
							createAutomationError(
								"start_rejected",
								"The RPC connection closed before the Run was accepted.",
								true,
							),
						);
					}
					if (shuttingDown) {
						return failExternalStart(
							createAutomationError(
								"start_rejected",
								"Automation Host is shutting down; no new runs are accepted.",
								false,
							),
						);
					}
					if (deadlineController.signal.aborted) {
						return failExternalStart(
							createAutomationError(
								"run_deadline_exceeded",
								"The Run deadline was exceeded before the external agent started.",
								false,
							),
						);
					}
					return failExternalStart(new ExternalAgentError("external_agent_start_failed"));
				}
				if (startGeneration !== sessionGeneration) {
					return failExternalStart(sessionSwitchedStartError());
				}
				if (requestEpoch !== transportEpoch) {
					return failExternalStart(
						createAutomationError(
							"start_rejected",
							"The RPC connection closed before the Run was accepted.",
							true,
						),
					);
				}
				const safeExternal = serializeExternalExecutionRef(externalRef);
				if (safeExternal === undefined) {
					return failExternalStart(new ExternalAgentError("external_agent_mapping_invalid"));
				}
				// A caller-provided external ref must be compatible with the identity
				// the adapter returned: a mismatch fails closed before any mapping
				// append or started event (PR section 6 field rules), and a matching
				// ref is persisted as-is.
				if (
					external !== undefined &&
					(external.namespace !== safeExternal.namespace ||
						external.externalSessionId !== safeExternal.externalSessionId ||
					(external.externalRunId ?? undefined) !== (safeExternal.externalRunId ?? undefined))
				) {
					return failExternalStart(new ExternalAgentError("external_agent_mapping_invalid"));
				}
				// The probed selection plus the verified protocol snapshot is the one
				// safe adapter identity for this external execution; it is attached to
				// the mapping and the Remote Operation request so the persisted
				// receipt and Audit stay filterable by adapter without exposing any
				// raw protocol or target data.
				const probedAdapterIdentity: ExternalAdapterIdentity = {
					adapterId: probe.selection.adapterId,
					targetId: probe.selection.targetId,
					protocol: probe.snapshot.protocol,
				};
				try {
					coordinator!.persistExternalMapping({
						external: safeExternal,
						aosSessionId: session.sessionId,
						aosRunId: handle.runId,
						source: "external-agent",
						adapter: probedAdapterIdentity,
					});
				} catch (err) {
					return failExternalStart(err, "external_agent_persistence_failed");
				}
				let startEvents: RunStreamEvent[];
				try {
					startEvents = handle.start();
				} catch (err) {
					return failExternalStart(asAutomationError(err));
				}
				// Emit the accepted response before run.started so records appear in
				// the contract order: response -> run.started -> run.event* -> terminal.
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
				trackExternalRun(handle, externalAdapterRun, startRequest.operationId, deadlineController.signal, probedAdapterIdentity);
				return undefined;
			};
			if (externalProbe !== undefined) {
				// Register the deadline controller and promise of the pending
				// external start BEFORE preflight so a lifecycle transition (detach,
				// shutdown, session switch) can abort it even though externalRuns
				// does not exist yet, and so it is never awaited by the transition.
				externalPendingControllers.set(proposedRunId, deadlineController);
				const pendingExternal = runExternalStart();
				pendingExternalStarts.set(proposedRunId, pendingExternal);
				void pendingExternal.then(
					() => pendingExternalStarts.delete(proposedRunId),
					() => pendingExternalStarts.delete(proposedRunId),
				);
				return trackPendingStart(pendingExternal);
			}
			try {
				promptPromise = session.prompt(message, {
					images,
					source: "rpc",
					runId: proposedRunId,
					signal: deadlineController.signal,
					preflightResult: (didSucceed) => {
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
						if (activeReservation !== reservation) return;
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
								external,
								deadlineAt,
								previousBindingId,
								previousPolicyBindingId,
								previousModelBindingId,
								model: currentRunModel(),
								...(modelSelection.resolution === undefined
									? {}
									: {
											modelBindingId: modelSelection.resolution.bindingId,
											finalModel: finalModelForResolution(modelSelection.resolution),
										}),
								// Persist the frozen binding as the run's capability binding;
								// its id is recorded on the terminal receipt.
								capabilityBinding: session.getActiveCapabilityBinding(),
								policyBinding: session.getActiveExecutionPolicyBinding(),
								policySummary: session.getActiveExecutionPolicySummary(),
								bindingHandles: session.getActiveBindingHandles(),
							});
							handle.setUsageBaseline(usageSnapshot());
							// Persist the started fact before publishing accepted. The returned events
							// remain buffered locally so the external contract is still accepted ->
							// run.started -> run.event* -> terminal.
							startEvents = handle.start();
						} catch (err) {
							activeReservation = undefined;
							clearRunDeadline(proposedRunId);
							terminalErrorByRun.delete(proposedRunId);
							if (handle === undefined) {
								try {
									reservation.release();
								} catch {
									// reservation may already be consumed
								}
							} else {
								// The accepted fact was durable but the started fact was not. Discard
								// the live coordinator so this failed start cannot retain Session
								// ownership; its ledger record is replayed as interrupted if recovered.
								coordinator = createRunLifecycleCoordinator(session.sessionManager);
							}
							const response = automationError(id, commandType, asAutomationError(err));
							output(response);
							finishRunRequest(requestClaim, response);
							// preflightResult has no rejection return value. Throwing prevents
							// AgentSession.prompt() from proceeding into the Agent loop after an
							// accepted/start ledger failure; promptPromise.catch() sees the same
							// failure but does not output a duplicate because the reservation cleared.
							throw err;
						}
						activeReservation = undefined;
						activeHandle = handle;
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
						trackRunPrompt(handle, promptPromise);
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

		runtimeHost.setRebindSession(async () => {
			await rebindSession();
		});

		const rebindSession = async (): Promise<void> => {
			// A session replacement invalidates every run of the outgoing session.
			// The Run cancellation intent of every tracked external execution is
			// forwarded to the adapter's idempotent cancel path; started
			// settlements are awaited so their terminal is recorded in the
			// OUTGOING session's ledger, and every pending start is awaited so its
			// session-generation guard fails it closed (start_rejected) BEFORE the
			// incoming session is assigned and its stores are rebuilt. An in-flight
			// external start can therefore never resume against the incoming
			// Session or write a mapping or ledger entry into it.
			if (hostInitialized) {
				sessionGeneration += 1;
				for (const runId of [...externalRuns.keys()]) {
					const externalRun = externalRuns.get(runId);
					if (externalRun === undefined) continue;
					if (activeHandle?.runId === runId) {
						activeHandle.requestCancel();
					}
					runAbortControllers.get(runId)?.abort();
					const settlement = externalRunSettlements.get(runId);
					if (settlement !== undefined) {
						await settlement;
					}
					void externalRun.cancel().catch(() => {
						// The driver retries idempotently; the tracked settlement owns the terminal.
					});
				}
				// Abort every pending external start controller, including phases
				// before the externalRuns registration (preflight), so the
				// generation guard fails each one closed before the incoming
				// session is assigned. Pending external starts are never awaited: a
				// preflight or adapter start that ignores the abort signal must not
				// block the switch (a run.resume in flight is itself a pending
				// start blocked on this switch and would deadlock), and their
				// continuation fails closed on the generation guard and can never
				// accept or write into the incoming session.
				for (const controller of externalPendingControllers.values()) {
					controller.abort();
				}
				// Abort every in-flight MCP auth flow: the flow belongs to the outgoing
				// Session and must not report against the incoming one. The command
				// fails closed via its post-start aborted check after the rebind
				// completes, and the pending Session flow itself is cancelled so it
				// can never complete later and persist tokens.
				for (const [serverId] of mcpAuthControllers) {
					session.cancelMcpAuth(serverId);
				}
				for (const controller of mcpAuthControllers.values()) {
					controller.abort();
				}
				mcpAuthControllers.clear();
			}
			if (activeReservation !== undefined) {
				try {
					activeReservation.release();
				} catch {
					// reservation may already be consumed
				}
				activeReservation = undefined;
			}
			session = runtimeHost.session;
			// Rebuild the run coordinator for the current session's ledger. When the
			// host is initialized, a fresh coordinator folds the new session's
			// automation.run custom entries so run.get and run.resume work after a switch.
			if (hostInitialized) {
				rebuildAutomationStores();
				activeHandle = undefined;
				settledRunIds.clear();
				runPromptPromises.clear();
				externalRuns.clear();
				externalRunSettlements.clear();
				runAbortControllers.clear();
				externalPendingControllers.clear();
			}
			await session.bindExtensions({
				uiContext: createExtensionUIContext(),
				mode: "rpc",
				commandContextActions: {
					waitForIdle: () => session.waitForIdle(),
					newSession: async (options) => runtimeHost.newSession(options),
					fork: async (entryId, forkOptions) => {
						const result = await runtimeHost.fork(entryId, forkOptions);
						return { cancelled: result.cancelled };
					},
					navigateTree: async (targetId, options) => {
						const result = await session.navigateTree(targetId, {
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
						await session.reload();
					},
				},
				shutdownHandler: () => {
					shutdownRequested = true;
				},
				onError: (err) => {
					output({ type: "extension_error", event: err.event, error: "Extension failed." });
				},
			});

			unsubscribe?.();
			unsubscribeBackpressure?.();
			unsubscribe = session.subscribe((event) => {
				if (activeHandle !== undefined) {
					const emitted = activeHandle.captureSessionEvent(event);
					if (emitted !== undefined) outputRunEvent(emitted);
					// Provider errors surface as a final assistant message with stopReason
					// "error" on agent_end; record it so the run settles failed/model_error.
					if (event.type === "agent_end" && event.willRetry !== true) {
						let errorText: string | undefined;
						for (const message of event.messages) {
							if (message.role === "assistant" && message.stopReason === "error") {
								errorText = message.errorMessage ?? "Agent run failed";
							}
						}
						if (errorText !== undefined) {
							const terminalCode =
								errorText === "Model budget exceeded."
									? "model_budget_exceeded"
									: errorText === "Model fallback exhausted."
										? "model_fallback_exhausted"
										: "model_error";
							terminalErrorByRun.set(activeHandle.runId, createAutomationError(terminalCode, errorText, false));
						} else if (terminalErrorByRun.get(activeHandle.runId)?.code !== "run_deadline_exceeded") {
							terminalErrorByRun.delete(activeHandle.runId);
						}
					}
				} else if (activeReservation !== undefined) {
					// Buffer session events observed during preflight; start() flushes them.
					activeReservation.captureSessionEvent(event);
				} else {
					output(toJsonEvent(serializePublicSessionEvent(event)));
				}
				if (event.type === "agent_settled") {
					if (activeHandle !== undefined) {
						void settleActiveRun(activeHandle);
					}
					void checkShutdownRequested();
				}
			});
			unsubscribeBackpressure = session.agent.subscribe(async () => {
				await waitForOutput();
			});
		};

		await rebindSession();

		// Handle a single command
		const handleCommand = async (command: RpcCommand): Promise<RpcResponse | RpcAutomationResponse | undefined> => {
			const id = command.id;

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
						rebuildAutomationStores();
					}
					const initializeData: InitializeData = {
						host: "automation-host",
						protocolVersion: 1,
						sessionId: session.sessionId,
						runCommands: ["run.start", "run.get", "run.cancel", "run.resume"],
						auditCommands: ["audit.query", "audit.replay", "external.map"],
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
						mcpCommands: [
							"mcp.list_resources",
							"mcp.list_resource_templates",
							"mcp.read_resource",
							"mcp.attach_resource",
							"mcp.list_prompts",
							"mcp.get_prompt",
							"mcp.attach_prompt",
							"mcp.auth.start",
							"mcp.auth.logout",
						],
					};
					// Safe adapter summary: descriptors only (adapterId/displayName/version).
					// Endpoints, commands, credentials, protocol names, and raw probe data
					// are never advertised by initialize.
					const externalAgentRegistry = session.getExternalAgentRegistry?.();
					if (externalAgentRegistry !== undefined) {
						initializeData.externalAgentAdapters = externalAgentRegistry.list();
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

				// =================================================================
				// MCP public surface (resources/prompts/auth)
				//
				// Commands forward to the Session's governed MCP methods: list/read/get
				// never start a Run or a model, and attach is the only explicit path
				// that registers remote content into the session (policy/approval/
				// headless contract enforced by the Session). Responses carry
				// normalized, capped content for read/get, catalog pages for lists,
				// metadata/digest receipts for attach, and sanitized status for auth.
				// The one-shot authorization URL of an in-flight mcp.auth.start flow is
				// published exactly once as an explicit interactive `mcp.auth.url`
				// event and never appears in status, receipts, or other events.
				// =================================================================

				case "mcp.list_resources": {
					try {
						const data = await session.listMcpResources(
							command.serverId,
							command.cursor === undefined ? undefined : command.cursor,
						);
						return success(id, "mcp.list_resources", data);
					} catch (err) {
						return automationError(id, "mcp.list_resources", mcpCommandError(err, "capability_mcp_unavailable"));
					}
				}

				case "mcp.list_resource_templates": {
					try {
						const data = await session.listMcpResourceTemplates(
							command.serverId,
							command.cursor === undefined ? undefined : command.cursor,
						);
						return success(id, "mcp.list_resource_templates", data);
					} catch (err) {
						return automationError(
							id,
							"mcp.list_resource_templates",
							mcpCommandError(err, "capability_mcp_unavailable"),
						);
					}
				}

				case "mcp.read_resource": {
					try {
						const data = await session.readMcpResource(command.serverId, command.resourceId);
						return success(id, "mcp.read_resource", data);
					} catch (err) {
						return automationError(id, "mcp.read_resource", mcpCommandError(err, "capability_mcp_unavailable"));
					}
				}

				case "mcp.attach_resource": {
					try {
						const data = await session.attachMcpResource(command.serverId, command.resourceId);
						return success(id, "mcp.attach_resource", data);
					} catch (err) {
						return automationError(id, "mcp.attach_resource", mcpCommandError(err, "capability_mcp_unavailable"));
					}
				}

				case "mcp.list_prompts": {
					try {
						const data = await session.listMcpPrompts(
							command.serverId,
							command.cursor === undefined ? undefined : command.cursor,
						);
						return success(id, "mcp.list_prompts", data);
					} catch (err) {
						return automationError(id, "mcp.list_prompts", mcpCommandError(err, "capability_mcp_unavailable"));
					}
				}

				case "mcp.get_prompt": {
					try {
						const data = await session.getMcpPrompt(command.serverId, command.promptId, command.args);
						return success(id, "mcp.get_prompt", data);
					} catch (err) {
						return automationError(id, "mcp.get_prompt", mcpCommandError(err, "capability_mcp_unavailable"));
					}
				}

				case "mcp.attach_prompt": {
					try {
						const data = await session.attachMcpPrompt(command.serverId, command.promptId, command.args);
						return success(id, "mcp.attach_prompt", data);
					} catch (err) {
						return automationError(id, "mcp.attach_prompt", mcpCommandError(err, "capability_mcp_unavailable"));
					}
				}

				case "mcp.auth.start": {
					const controller = new AbortController();
					mcpAuthControllers.set(command.serverId, controller);
					try {
						// Start the flow headlessly. startInteractive without an
						// interaction returns immediately with the one-shot outcome:
						// `interaction_required` plus the authorization URL, or
						// `authorized` when the server is already authenticated. The
						// URL is delivered exactly once as an explicit interactive
						// `mcp.auth.url` event; it never appears in status, receipts,
						// or other events. The flow itself stays pending in the
						// Session (bounded by its authorization timeout and the
						// session-scoped abort controller); this command does not wait
						// for a callback that headless transports cannot deliver.
						const started = await session.startMcpAuth(command.serverId);
						if (controller.signal.aborted) {
							// Cancelled (detach/shutdown/rebind) while the flow started;
							// fail closed with the stable auth code.
							return automationError(
								id,
								"mcp.auth.start",
								createAutomationError(
									"capability_mcp_auth_required",
									mcpFallbackMessage("capability_mcp_auth_required"),
									false,
								),
							);
						}
						if (started.authorizationUrl !== undefined) {
							const event: RpcMcpAuthUrlEvent = {
								type: "mcp.auth.url",
								serverId: command.serverId,
								url: started.authorizationUrl,
							};
							output(event);
						}
						const status = await session.getMcpAuthStatus(command.serverId);
						return success(
							id,
							"mcp.auth.start",
							{
								serverId: command.serverId,
								outcome: started.outcome,
								status,
							} satisfies McpAuthStartData,
						);
					} catch (err) {
						return automationError(id, "mcp.auth.start", mcpCommandError(err, "capability_mcp_auth_required"));
					} finally {
						mcpAuthControllers.delete(command.serverId);
					}
				}

				case "mcp.auth.logout": {
					try {
						await session.logoutMcpAuth(command.serverId);
						return success(id, "mcp.auth.logout");
					} catch (err) {
						return automationError(id, "mcp.auth.logout", mcpCommandError(err, "capability_mcp_auth_required"));
					}
				}

				case "audit.query": {
					if (!hostInitialized || coordinator === undefined) {
						return automationError(id, "audit.query", hostNotInitializedError());
					}
					const query: AuditQuery = {
						scope: command.scope,
						...(command.sessionId === undefined ? {} : { sessionId: command.sessionId }),
						...(command.runId === undefined ? {} : { runId: command.runId }),
						...(command.external === undefined ? {} : { external: command.external }),
						...(command.types === undefined ? {} : { types: command.types }),
						...(command.from === undefined ? {} : { from: command.from }),
						...(command.to === undefined ? {} : { to: command.to }),
						...(command.cursor === undefined ? {} : { cursor: command.cursor }),
						...(command.limit === undefined ? {} : { limit: command.limit }),
					};
					try {
						const data = new ExecutionAuditQuery(session.sessionManager).query(query) satisfies AuditQueryData;
						return { id, type: "response", command: "audit.query", success: true, data };
					} catch (err) {
						return automationError(id, "audit.query", auditCommandError(err, "audit_query_invalid"));
					}
				}

				case "audit.replay": {
					if (!hostInitialized || coordinator === undefined) {
						return automationError(id, "audit.replay", hostNotInitializedError());
					}
					const query: AuditReplayQuery = {
						runId: command.runId,
						...(command.scope === undefined ? {} : { scope: command.scope }),
						...(command.sessionId === undefined ? {} : { sessionId: command.sessionId }),
						...(command.external === undefined ? {} : { external: command.external }),
						...(command.types === undefined ? {} : { types: command.types }),
						...(command.from === undefined ? {} : { from: command.from }),
						...(command.to === undefined ? {} : { to: command.to }),
						...(command.cursor === undefined ? {} : { cursor: command.cursor }),
						...(command.limit === undefined ? {} : { limit: command.limit }),
					};
					try {
						const data = new ExecutionAuditQuery(session.sessionManager).replay(query) satisfies AuditReplayData;
						return { id, type: "response", command: "audit.replay", success: true, data };
					} catch (err) {
						return automationError(id, "audit.replay", auditCommandError(err, "audit_replay_incomplete"));
					}
				}

				case "external.map": {
					if (!hostInitialized || coordinator === undefined) {
						return automationError(id, "external.map", hostNotInitializedError());
					}
					if (command.aosSessionId !== session.sessionId || !isExternalExecutionRef(command.external)) {
						return automationError(id, "external.map", auditCommandError(undefined, "external_mapping_invalid"));
					}
					const request: ExternalMappingRequest = {
						external: command.external,
						aosSessionId: command.aosSessionId,
						...(command.aosRunId === undefined ? {} : { aosRunId: command.aosRunId }),
						...(command.source === undefined ? {} : { source: command.source }),
						...(command.correlationId === undefined ? {} : { correlationId: command.correlationId }),
					};
					try {
						const data = coordinator.persistExternalMapping(request) satisfies ExternalMapData;
						return { id, type: "response", command: "external.map", success: true, data };
					} catch (err) {
						return automationError(id, "external.map", auditCommandError(err, "audit_persistence_failed"));
					}
				}

				case "task.gate.request": {
					if (!hostInitialized || taskGateStore === undefined) {
						return automationError(id, "task.gate.request", hostNotInitializedError());
					}
					if (!isTaskGateCommandShapeValid(command)) {
						return automationError(id, "task.gate.request", taskGateCommandError(undefined, "task_gate_invalid"));
					}
					try {
						const result = taskGateStore.request({
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
					if (!hostInitialized || taskGateStore === undefined) {
						return automationError(id, "task.gate.get", hostNotInitializedError());
					}
					if (!isTaskGateCommandShapeValid(command)) {
						return automationError(id, "task.gate.get", taskGateCommandError(undefined, "task_gate_invalid"));
					}
					try {
						const gate = taskGateStore.get(command.gateId);
						if (gate === undefined) {
							return automationError(id, "task.gate.get", taskGateCommandError(undefined, "task_gate_not_found"));
						}
						return { id, type: "response", command: "task.gate.get", success: true, data: { gate } };
					} catch (err) {
						return automationError(id, "task.gate.get", taskGateCommandError(err, "task_gate_invalid"));
					}
				}

				case "task.gate.list": {
					if (!hostInitialized || taskGateStore === undefined) {
						return automationError(id, "task.gate.list", hostNotInitializedError());
					}
					if (!isTaskGateCommandShapeValid(command)) {
						return automationError(id, "task.gate.list", taskGateCommandError(undefined, "task_gate_invalid"));
					}
					try {
						const result = taskGateStore.list({
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
					if (!hostInitialized || taskGateStore === undefined) {
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
								? taskGateStore.approve(decision)
								: command.type === "task.gate.reject"
									? taskGateStore.reject(decision)
									: taskGateStore.cancel(decision);
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
					if (!hostInitialized || taskGraphStore === undefined) {
						return automationError(id, "task.graph.create", hostNotInitializedError());
					}
					if (!isTaskGraphCommandShapeValid(command)) {
						return automationError(id, "task.graph.create", taskGraphCommandError(undefined, "task_graph_invalid"));
					}
					try {
						const result = taskGraphStore.create({
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
					if (!hostInitialized || taskGraphStore === undefined) {
						return automationError(id, "task.graph.get", hostNotInitializedError());
					}
					if (!isTaskGraphCommandShapeValid(command)) {
						return automationError(id, "task.graph.get", taskGraphCommandError(undefined, "task_graph_invalid"));
					}
					try {
						const graph = taskGraphStore.get(command.taskId, command.graphRevision);
						if (graph === undefined) {
							return automationError(id, "task.graph.get", taskGraphCommandError(undefined, "task_graph_not_found"));
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
					if (!hostInitialized || taskGraphStore === undefined) {
						return automationError(id, "task.graph.list", hostNotInitializedError());
					}
					if (!isTaskGraphCommandShapeValid(command)) {
						return automationError(id, "task.graph.list", taskGraphCommandError(undefined, "task_graph_invalid"));
					}
					try {
						const result = taskGraphStore.list({
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
					if (!hostInitialized || taskGraphStore === undefined) {
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
						const result = taskGraphStore.attach({
							taskId: command.taskId,
							graphRevision: command.graphRevision,
							nodeId: command.nodeId,
							runId: command.runId,
							clientRequestId: command.clientRequestId,
						});
						return taskGraphMutationResponse(id, "task.graph.node.attach", result);
					} catch (err) {
						return automationError(id, "task.graph.node.attach", taskGraphCommandError(err, "task_graph_invalid"));
					}
				}

				case "task.graph.node.settle": {
					if (!hostInitialized || taskGraphStore === undefined) {
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
						const result = taskGraphStore.settle({
							taskId: command.taskId,
							graphRevision: command.graphRevision,
							nodeId: command.nodeId,
							clientRequestId: command.clientRequestId,
						});
						return taskGraphMutationResponse(id, "task.graph.node.settle", result);
					} catch (err) {
						return automationError(id, "task.graph.node.settle", taskGraphCommandError(err, "task_graph_invalid"));
					}
				}

				case "run.start": {
					return trackPendingStart(
						startRun(
							id,
							"run.start",
							command.message,
							command.images,
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
							command.external,
							command.externalAgent,
							command.deadlineAt,
							command.clientRequestId,
							undefined,
							false,
						),
					);
				}

				case "run.get": {
					if (!hostInitialized || coordinator === undefined) {
						return automationError(id, "run.get", hostNotInitializedError());
					}
					const result = coordinator.getRun(command.runId);
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
					if (!hostInitialized || coordinator === undefined) {
						return automationError(id, "run.cancel", hostNotInitializedError());
					}
					const result = coordinator.getRun(command.runId);
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
					if (activeHandle === undefined || activeHandle.runId !== command.runId) {
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
					activeHandle.requestCancel();
					// Cancellation is a request, not the terminal transition. An external
					// agent run forwards to the idempotent adapter cancel (the deadline
					// signal reaches the adapter through the same driver); a local run
					// triggers the existing abort path without waiting for its idle
					// promise so the command response describes the current running
					// state. The subscriber emits the unique run.cancelled event only
					// after Session settlement.
					const externalRun = externalRuns.get(command.runId);
					if (externalRun !== undefined) {
						void externalRun.cancel();
					} else {
						void session.abort().catch(() => {
							// The run remains governed by its normal settle/recovery path.
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
							if (command.external !== undefined && !isExternalExecutionRef(command.external)) {
								return automationError(
									id,
									"run.resume",
									auditCommandError(undefined, "external_mapping_invalid"),
								);
							}
							if (command.externalAgent !== undefined && !isExternalAgentSelection(command.externalAgent)) {
								return automationError(
									id,
									"run.resume",
									createAutomationError(
										"external_agent_adapter_invalid",
										"The External Agent Adapter selection is invalid.",
										false,
									),
								);
							}
							// The v1 adapter contract has start() only; there is no same-ref
							// resume API, so an external run.resume can never be honored.
							// Reject it instead of silently starting a fresh execution.
							if (command.externalAgent !== undefined) {
								return automationError(
									id,
									"run.resume",
									createAutomationError(
										"external_agent_resume_unsupported",
										externalAgentMessage("external_agent_resume_unsupported"),
										false,
									),
								);
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
							if (!hostInitialized || coordinator === undefined) {
								return automationError(id, "run.resume", hostNotInitializedError());
							}
							const targetLedger =
								command.clientRequestId === undefined
									? undefined
									: loadReadOnlyRunCoordinator(command.sessionPath);
							const targetSessionId = targetLedger?.sessionId ?? hashResumeTargetPath(command.sessionPath);
							const resumeIdentity = requestIdentity(command.clientRequestId, "run.resume", targetSessionId, {
								message: command.message,
								images: command.images,
								targetSessionId,
								sourceRunId: command.sourceRunId,
								capabilityProfile: command.capabilityProfile,
								policyProfile: command.policyProfile,
								modelRoute: command.modelRoute,
								modelRole: command.modelRole,
								external: command.external,
								externalAgent: command.externalAgent,
								deadlineAt: command.deadlineAt,
							});
							let resumeClaim: RunRequestIdentity | undefined;
							if (resumeIdentity !== undefined) {
								const gate = beginRunRequest(id, "run.resume", resumeIdentity, () =>
									targetLedger?.coordinator?.getRunByClientRequestId(resumeIdentity.clientRequestId, "resume"),
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
							if (coordinator.activeRun !== undefined || activeReservation !== undefined) {
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
							if (session.sessionFile === undefined) {
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
							// switchSession() re-runs rebindSession(), which rebuilt `coordinator`
							// for the restored session's ledger.
							const sourceRun = coordinator!.getRun(command.sourceRunId);
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
							// Resume execution-kind consistency: an external source run can only
							// be resumed through an External Agent Adapter, which v1 cannot
							// honor; rejecting here avoids silently resuming a different
							// execution kind locally.
							const sourceIsExternal =
								sourceRun.record.external !== undefined || sourceRun.receipt?.external !== undefined;
							if (sourceIsExternal) {
								return resumeFailure(
									automationError(
										id,
										"run.resume",
										createAutomationError(
											"external_agent_resume_unsupported",
											externalAgentMessage("external_agent_resume_unsupported"),
											false,
										),
									),
								);
							}
							// An interrupted run may have an accepted record but no terminal
							// receipt. Preserve #6's binding-drift guard for that recovery path.
							const previousBindingId =
								sourceRun.receipt?.capabilityBindingId ?? sourceRun.record.capabilityBindingId;
							const previousPolicyBindingId =
								sourceRun.receipt?.policyBindingId ?? sourceRun.record.policyBindingId;
							const previousModelBindingId =
								sourceRun.receipt?.modelBindingId ?? sourceRun.record.modelBindingId;
							const inheritedModelBinding =
								previousModelBindingId === undefined
									? undefined
									: foldModelBrokerLedger(session.sessionManager.getEntries()).bindings.get(
											previousModelBindingId,
										);
							return startRun(
								id,
								"run.resume",
								command.message,
								command.images,
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
								command.external,
								command.externalAgent,
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
					void session
						.prompt(command.message, {
							images: command.images,
							streamingBehavior: command.streamingBehavior,
							source: "rpc",
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
					await session.steer(command.message, command.images);
					return success(id, "steer");
				}

				case "follow_up": {
					await session.followUp(command.message, command.images);
					return success(id, "follow_up");
				}

				case "abort": {
					await session.abort();
					return success(id, "abort");
				}

				case "new_session": {
					const options = command.parentSession ? { parentSession: command.parentSession } : undefined;
					const result = await runtimeHost.newSession(options);
					if (!result.cancelled) {
						await rebindSession();
					}
					return success(id, "new_session", result);
				}

				// =================================================================
				// State
				// =================================================================

				case "get_state": {
					const state: RpcSessionState = {
						model: session.model,
						thinkingLevel: session.thinkingLevel,
						isStreaming: session.isStreaming,
						isCompacting: session.isCompacting,
						steeringMode: session.steeringMode,
						followUpMode: session.followUpMode,
						sessionId: session.sessionId,
						sessionName: session.sessionName,
						autoCompactionEnabled: session.autoCompactionEnabled,
						messageCount: session.messages.length,
						pendingMessageCount: session.pendingMessageCount,
					};
					return success(id, "get_state", state);
				}

				// =================================================================
				// Model
				// =================================================================

				case "set_model": {
					const models = session.modelRuntime.getAvailableSnapshot();
					const model = models.find((m) => m.provider === command.provider && m.id === command.modelId);
					if (!model) {
						return error(id, "set_model", `Model not found: ${command.provider}/${command.modelId}`);
					}
					await session.setModel(model);
					return success(id, "set_model", model);
				}

				case "cycle_model": {
					const result = await session.cycleModel();
					if (!result) {
						return success(id, "cycle_model", null);
					}
					return success(id, "cycle_model", result);
				}

				case "get_available_models": {
					const models = session.modelRuntime.getAvailableSnapshot();
					return success(id, "get_available_models", { models });
				}

				// =================================================================
				// Thinking
				// =================================================================

				case "set_thinking_level": {
					session.setThinkingLevel(command.level);
					return success(id, "set_thinking_level");
				}

				case "cycle_thinking_level": {
					const level = session.cycleThinkingLevel();
					if (!level) {
						return success(id, "cycle_thinking_level", null);
					}
					return success(id, "cycle_thinking_level", { level });
				}

				case "get_available_thinking_levels": {
					const levels = session.getAvailableThinkingLevels();
					return success(id, "get_available_thinking_levels", { levels });
				}

				// =================================================================
				// Queue Modes
				// =================================================================

				case "set_steering_mode": {
					session.setSteeringMode(command.mode);
					return success(id, "set_steering_mode");
				}

				case "set_follow_up_mode": {
					session.setFollowUpMode(command.mode);
					return success(id, "set_follow_up_mode");
				}

				// =================================================================
				// Compaction
				// =================================================================

				case "compact": {
					const result = await session.compact(command.customInstructions);
					return success(id, "compact", result);
				}

				case "set_auto_compaction": {
					session.setAutoCompactionEnabled(command.enabled);
					return success(id, "set_auto_compaction");
				}

				// =================================================================
				// Retry
				// =================================================================

				case "set_auto_retry": {
					session.setAutoRetryEnabled(command.enabled);
					return success(id, "set_auto_retry");
				}

				case "abort_retry": {
					session.abortRetry();
					return success(id, "abort_retry");
				}

				// =================================================================
				// Bash
				// =================================================================

				case "bash": {
					const allowExtensionBash = await session.authorizeUserBashExtension(command.command, { id });
					const eventResult = allowExtensionBash
						? await session.extensionRunner.emitUserBash({
								type: "user_bash",
								command: command.command,
								excludeFromContext: command.excludeFromContext ?? false,
								cwd: session.sessionManager.getCwd(),
							})
						: undefined;

					if (eventResult?.result) {
						session.recordBashResult(command.command, eventResult.result, {
							excludeFromContext: command.excludeFromContext,
						});
						return success(id, "bash", eventResult.result);
					}

					const result = await session.executeBash(command.command, undefined, {
						excludeFromContext: command.excludeFromContext,
						id,
						operations: eventResult?.operations,
					});
					return success(id, "bash", result);
				}

				case "abort_bash": {
					session.abortBash();
					return success(id, "abort_bash");
				}

				// =================================================================
				// Session
				// =================================================================

				case "get_session_stats": {
					const stats = session.getSessionStats();
					return success(id, "get_session_stats", serializePublicSessionStats(stats));
				}

				case "get_context": {
					const inspection = await session.inspectContext({
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
					const history = foldCapabilityBindingEntries(session.sessionManager.getEntries());
					const current = session.getActiveCapabilityBinding();
					if (command.bindingId !== undefined) {
						const found = history.get(command.bindingId);
						if (found === undefined) {
							return error(id, "get_capabilities", "Capability binding not found.");
						}
						const binding = serializePublicCapabilityBinding(found);
						return success(id, "get_capabilities", {
							catalog: session.inspectCapabilityCatalog(),
							binding: binding ?? null,
							bindings: [],
						} satisfies GetCapabilitiesData);
					}
					return success(id, "get_capabilities", {
						catalog: session.inspectCapabilityCatalog(),
						binding: current === undefined ? null : (serializePublicCapabilityBinding(current) ?? null),
						bindings: [...history.values()]
							.map((binding) => serializePublicCapabilityBinding(binding))
							.filter((binding): binding is NonNullable<typeof binding> => binding !== undefined),
					} satisfies GetCapabilitiesData);
				}

				case "get_execution_policy": {
					return success(id, "get_execution_policy", {
						summary: session.getActiveExecutionPolicySummary(),
						pendingApprovals: session.getPendingExecutionPolicyApprovals(),
					} satisfies GetExecutionPolicyData);
				}

				case "policy.approve": {
					session.approveExecutionPolicyRequest(command.requestId, "rpc");
					return success(id, "policy.approve");
				}

				case "policy.reject": {
					session.rejectExecutionPolicyRequest(command.requestId, "rpc");
					return success(id, "policy.reject");
				}

				case "get_model_routes": {
					// Route and role catalogs contain only declared model identities and
					// availability metadata. ModelRuntime credentials are intentionally not
					// part of the Broker summary.
					return success(
						id,
						"get_model_routes",
						session.modelBroker.publicSummary(session.modelBrokerBindingId) satisfies GetModelRoutesData,
					);
				}

				case "export_html": {
					const path = await session.exportToHtml(command.outputPath);
					return success(id, "export_html", { path });
				}

				case "switch_session": {
					const result = await runtimeHost.switchSession(command.sessionPath);
					if (!result.cancelled) {
						await rebindSession();
					}
					return success(id, "switch_session", result);
				}

				case "fork": {
					const result = await runtimeHost.fork(command.entryId);
					if (!result.cancelled) {
						await rebindSession();
					}
					return success(id, "fork", { text: result.selectedText, cancelled: result.cancelled });
				}

				case "clone": {
					const leafId = session.sessionManager.getLeafId();
					if (!leafId) {
						return error(id, "clone", "Cannot clone session: no current entry selected");
					}
					const result = await runtimeHost.fork(leafId, { position: "at" });
					if (!result.cancelled) {
						await rebindSession();
					}
					return success(id, "clone", { cancelled: result.cancelled });
				}

				case "get_fork_messages": {
					const messages = session.getUserMessagesForForking();
					return success(id, "get_fork_messages", { messages });
				}

				case "get_entries": {
					const sessionManager = session.sessionManager;
					let entries = sessionManager.getEntries();
					if (command.since !== undefined) {
						const sinceIndex = entries.findIndex((e) => e.id === command.since);
						if (sinceIndex === -1) {
							return error(id, "get_entries", `Entry not found: ${command.since}`);
						}
						entries = entries.slice(sinceIndex + 1);
					}
					return success(id, "get_entries", {
						entries: entries.map((entry) => serializePublicSessionEntry(entry)),
						leafId: sessionManager.getLeafId(),
					});
				}

				case "get_tree": {
					const sessionManager = session.sessionManager;
					return success(id, "get_tree", {
						tree: sessionManager.getTree().map((node) => serializePublicSessionTreeNode(node)),
						leafId: sessionManager.getLeafId(),
					});
				}

				case "get_last_assistant_text": {
					const text = session.getLastAssistantText();
					return success(id, "get_last_assistant_text", { text });
				}

				case "set_session_name": {
					const name = command.name.trim();
					if (!name) {
						return error(id, "set_session_name", "Session name cannot be empty");
					}
					session.setSessionName(name);
					return success(id, "set_session_name");
				}

				// =================================================================
				// Messages
				// =================================================================

				case "get_messages": {
					return success(id, "get_messages", { messages: session.messages });
				}

				// =================================================================
				// Commands (available for invocation via prompt)
				// =================================================================

				case "get_commands": {
					const commands: RpcSlashCommand[] = [];

					for (const command of session.extensionRunner.getRegisteredCommands()) {
						commands.push({
							name: command.invocationName,
							description: command.description,
							source: "extension",
							sourceInfo: serializePublicSourceInfo(command.sourceInfo),
						});
					}

					for (const template of session.promptTemplates) {
						commands.push({
							name: template.name,
							description: template.description,
							source: "prompt",
							sourceInfo: serializePublicSourceInfo(template.sourceInfo),
						});
					}

					for (const skill of session.resourceLoader.getSkills().skills) {
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
			shutdownPromise = (async () => {
				// Stop accepting new runs and abort the active run. session.abort() waits for
				// the session to settle, letting the subscriber emit the run's terminal event
				// before we tear down. If the process is force-killed or exceeds the graceful
				// window, the last persisted ledger state is authoritative.
				if (activeReservation !== undefined) {
					try {
						activeReservation.release();
					} catch {
						// reservation may already be consumed
					}
					activeReservation = undefined;
				}
				if (activeHandle !== undefined) {
					activeHandle.requestCancel();
					const forwarded = await forwardExternalRunLifecycleCancel(activeHandle.runId);
					if (!forwarded) {
						try {
							await session.abort();
						} catch {
							// settle proceeds regardless of abort errors
						}
					}
				}
				// Abort every pending external start, including phases before the
				// externalRuns registration (preflight), so none of them accepts or
				// starts after the host is gone; each fails closed on the
				// shuttingDown guard.
				for (const controller of externalPendingControllers.values()) {
					controller.abort();
				}
				// Abort every in-flight MCP auth command so a pending discovery can
				// never report after the host is gone; each fails closed via its
				// post-start aborted check, and the pending Session flow is cancelled
				// so it cannot complete later and persist tokens.
				for (const [serverId] of mcpAuthControllers) {
					session.cancelMcpAuth(serverId);
				}
				for (const controller of mcpAuthControllers.values()) {
					controller.abort();
				}
				mcpAuthControllers.clear();
				unsubscribe?.();
				unsubscribeBackpressure?.();
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
			const handleAtDetach = activeHandle;
			const pendingStartsAtDetach = [...pendingStartPromises];
			detachTransportPromise = (async () => {
				rejectPendingExtensionRequests();
				if (activeReservation !== undefined) {
					try {
						activeReservation.release();
					} catch {
						// reservation may already be consumed
					}
					activeReservation = undefined;
				}
				if (handleAtDetach !== undefined) {
					// The Run cancellation intent is forwarded to the adapter's
					// idempotent cancel path for external executions: the Session
					// agent loop does not drive them, so session.abort() alone would
					// leave the external execution running and un-settled. Local runs
					// keep the existing abort + tracked-prompt settlement.
					handleAtDetach.requestCancel();
					const forwarded = await forwardExternalRunLifecycleCancel(handleAtDetach.runId);
					if (!forwarded) {
						try {
							await session.abort();
						} catch {
							// The terminal transition is attempted below even when abort reports an error.
						}
						await runPromptPromises.get(handleAtDetach.runId);
					}
				}
				// Abort every pending external start controller (including phases
				// before the externalRuns registration) so the preflight or
				// readiness race resolves where the signal is honored; each fails
				// closed on the epoch guard. Pending external starts are never
				// awaited: an adapter start or preflight that ignores the abort
				// signal must not block the detach.
				for (const controller of externalPendingControllers.values()) {
					controller.abort();
				}
				// Abort every in-flight MCP auth command; the command settles
				// fail-closed via its post-start aborted check after the detach
				// completes, and the pending Session flow is cancelled so it cannot
				// complete later and persist tokens.
				for (const [serverId] of mcpAuthControllers) {
					session.cancelMcpAuth(serverId);
				}
				for (const controller of mcpAuthControllers.values()) {
					controller.abort();
				}
				mcpAuthControllers.clear();
				const externalPendingAtDetach = new Set(pendingExternalStarts.values());
				await Promise.all(
					[...pendingStartsAtDetach].filter((pending) => !externalPendingAtDetach.has(pending)),
				);
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
		): Promise<RpcResponse | RpcAutomationResponse | undefined> => {
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
	async dispatch(command: RpcCommand): Promise<RpcResponse | RpcAutomationResponse | undefined> {
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

	/** Stop accepting work, settle the active run, and dispose the runtime. */
	async shutdown(): Promise<void> {
		if (this.shutdownHandler === undefined) return;
		await this.shutdownHandler();
	}

	/**
	 * Detach a disconnected transport while keeping the host and runtime alive
	 * for a later connection. Any active run is cancelled and durably settled.
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
