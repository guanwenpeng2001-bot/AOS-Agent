/**
 * RPC protocol types for headless operation.
 *
 * Commands are sent as JSON lines on stdin.
 * Responses and events are emitted as JSON lines on stdout.
 */

import type { AgentMessage, ThinkingLevel } from "@aos-agent/agent-core";
import type { ImageContent, Model } from "@aos-agent/ai";
import type { McpAttachmentResult, McpAuthStatusView, SessionStats } from "../../core/agent-session.ts";
import type {
	MCPGetPromptResult,
	MCPPageResult,
	MCPPromptView,
	MCPReadResourceResult,
	MCPResourceView,
} from "../../core/mcp-content-types.ts";
import type { MCPAuthOutcome } from "../../core/mcp-auth.ts";
import type { BashResult } from "../../core/bash-executor.ts";
import type { CapabilityCatalogView } from "../../core/capability-registry.ts";
import type { CompactionResult } from "../../core/compaction/index.ts";
import type { RunBindingAssociation } from "../../core/binding-handles.ts";
import type {
	AuditQuery,
	AuditQueryResult,
	AuditReplayQuery,
	AuditReplayResult,
} from "../../core/execution-audit-query.ts";
import type { ExternalAgentAdapterDescriptor } from "../../core/external-agent-registry.ts";
import type { ExternalAgentSelection } from "../../core/external-agent-adapter.ts";
import type {
	ExternalExecutionRef,
	ExternalMappingPersistenceResult,
	ExternalMappingRequest,
} from "../../core/external-session-mapping.ts";
import type { ModelRoleSelection, ModelRouteSelection, PublicModelSummary } from "../../core/model-broker.ts";
import type { PolicyApprovalRequest, PublicPolicySummary } from "../../core/execution-policy.ts";
import type { TaskGateRecord, TaskGateStatus } from "../../core/task-gate.ts";
import type {
	TaskGraphNodeDefinition,
	TaskGraphNodeView,
	TaskGraphRecord,
	TaskGraphStatus,
} from "../../core/task-graph.ts";
import type {
	AutomationError,
	PublicCapabilityBindingLedgerRecord,
	PublicContextSnapshot,
	PublicContextSourceDrift,
	PublicRunReceipt,
	PublicRunRecord,
	PublicSessionEntry,
	PublicSessionTreeNode,
	RunFinalModelReference,
	RunModelAttemptSummary,
	RunModelBudgetSummary,
	RunRecoveryState,
	RunStatus,
} from "../../core/run-lifecycle.ts";
import type { SourceOrigin, SourceScope } from "../../core/source-info.ts";

// ============================================================================
// RPC Commands (stdin)
// ============================================================================

/** Flattened Automation Host request for a cross-session audit query. */
export type RpcAuditQueryCommand = { id?: string; type: "audit.query" } & AuditQuery;

/** Flattened Automation Host request for a single-run audit replay. */
export type RpcAuditReplayCommand = { id?: string; type: "audit.replay" } & AuditReplayQuery;

/** Flattened Automation Host request for an append-only external mapping. */
export type RpcExternalMapCommand = { id?: string; type: "external.map" } & ExternalMappingRequest;

export type RpcCommand =
	// Prompting
	| { id?: string; type: "prompt"; message: string; images?: ImageContent[]; streamingBehavior?: "steer" | "followUp" }
	| { id?: string; type: "steer"; message: string; images?: ImageContent[] }
	| { id?: string; type: "follow_up"; message: string; images?: ImageContent[] }
	| { id?: string; type: "abort" }
	| { id?: string; type: "new_session"; parentSession?: string }

	// State
	| { id?: string; type: "get_state" }

	// Model
	| { id?: string; type: "set_model"; provider: string; modelId: string }
	| { id?: string; type: "cycle_model" }
	| { id?: string; type: "get_available_models" }

	// Thinking
	| { id?: string; type: "set_thinking_level"; level: ThinkingLevel }
	| { id?: string; type: "cycle_thinking_level" }
	| { id?: string; type: "get_available_thinking_levels" }

	// Queue modes
	| { id?: string; type: "set_steering_mode"; mode: "all" | "one-at-a-time" }
	| { id?: string; type: "set_follow_up_mode"; mode: "all" | "one-at-a-time" }

	// Compaction
	| { id?: string; type: "compact"; customInstructions?: string }
	| { id?: string; type: "set_auto_compaction"; enabled: boolean }

	// Retry
	| { id?: string; type: "set_auto_retry"; enabled: boolean }
	| { id?: string; type: "abort_retry" }

	// Bash
	| { id?: string; type: "bash"; command: string; excludeFromContext?: boolean }
	| { id?: string; type: "abort_bash" }

	// Session
	| { id?: string; type: "get_session_stats" }
	| { id?: string; type: "export_html"; outputPath?: string }
	| { id?: string; type: "switch_session"; sessionPath: string }
	| { id?: string; type: "fork"; entryId: string }
	| { id?: string; type: "clone" }
	| { id?: string; type: "get_fork_messages" }
	| { id?: string; type: "get_entries"; since?: string }
	| { id?: string; type: "get_tree" }
	| { id?: string; type: "get_last_assistant_text" }
	| { id?: string; type: "set_session_name"; name: string }

	// Messages
	| { id?: string; type: "get_messages" }

	// Commands (available for invocation via prompt)
	| { id?: string; type: "get_commands" }

	// Context Engine (read-only inspection; never returns raw source bodies)
	| { id?: string; type: "get_context"; snapshotId?: string }

	// MCP public surface (resources/prompts/auth). Raw URIs, prompt names, and
	// prompt argument values live only in the request; responses, events,
	// receipts, and errors never echo them, remote text, or tokens.
	| { id?: string; type: "mcp.list_resources"; serverId: string; cursor?: string }
	| { id?: string; type: "mcp.read_resource"; serverId: string; uri: string }
	| { id?: string; type: "mcp.attach_resource"; serverId: string; uri: string }
	| { id?: string; type: "mcp.list_prompts"; serverId: string; cursor?: string }
	| { id?: string; type: "mcp.get_prompt"; serverId: string; name: string; args?: Record<string, string> }
	| { id?: string; type: "mcp.attach_prompt"; serverId: string; name: string; args?: Record<string, string> }
	| { id?: string; type: "mcp.auth.start"; serverId: string }
	| { id?: string; type: "mcp.auth.logout"; serverId: string }

	// Capability inspection (ordinary, read-only; redacted output only)
	| { id?: string; type: "get_capabilities"; bindingId?: string }
	| { id?: string; type: "get_execution_policy" }
	| { id?: string; type: "policy.approve"; requestId: string }
	| { id?: string; type: "policy.reject"; requestId: string }

	// Model route inspection (ordinary, read-only; redacted output only)
	| { id?: string; type: "get_model_routes" }

	// Automation Host (protocolVersion 1)
	| { id?: string; type: "initialize"; protocolVersion: number }
	| {
			id?: string;
			type: "run.start";
			message: string;
			/** Optional caller-chosen idempotency key, scoped to this Session. */
			clientRequestId?: string;
			/** Optional inclusive canonical UTC deadline for the Run. */
			deadlineAt?: string;
			images?: ImageContent[];
			external?: ExternalExecutionRef;
			/** Explicit trusted External Agent Adapter selection for this Run. */
			externalAgent?: ExternalAgentSelection;
			capabilityProfile?: string;
			policyProfile?: string;
			modelRoute?: ModelRouteSelection;
			modelRole?: ModelRoleSelection;
	  }
	| { id?: string; type: "run.get"; runId: string }
	| { id?: string; type: "run.cancel"; runId: string }
	| {
			id?: string;
			type: "run.resume";
			sessionPath: string;
			sourceRunId: string;
			message: string;
			/** Optional caller-chosen idempotency key, scoped to the target Session. */
			clientRequestId?: string;
			/** Optional inclusive canonical UTC deadline for the resumed Run. */
			deadlineAt?: string;
			images?: ImageContent[];
			external?: ExternalExecutionRef;
			/** Explicit trusted External Agent Adapter selection for the resumed Run. */
			externalAgent?: ExternalAgentSelection;
			capabilityProfile?: string;
			policyProfile?: string;
			modelRoute?: ModelRouteSelection;
			modelRole?: ModelRoleSelection;
	  }
	| RpcAuditQueryCommand
	| RpcAuditReplayCommand
	| RpcExternalMapCommand
	// Task Gate control-plane commands (write commands require clientRequestId)
	| {
			id?: string;
			type: "task.gate.request";
			taskId: string;
			stageId: string;
			stageRevision: number;
			runId?: string;
			clientRequestId: string;
	  }
	| { id?: string; type: "task.gate.get"; gateId: string }
	| {
			id?: string;
			type: "task.gate.list";
			taskId?: string;
			stageId?: string;
			status?: TaskGateStatus;
			limit?: number;
	  }
	| {
			id?: string;
			type: "task.gate.approve";
			gateId: string;
			/** Unauthenticated operator label supplied by the trusted Host. */
			actorId?: string;
			clientRequestId: string;
	  }
	| {
			id?: string;
			type: "task.gate.reject";
			gateId: string;
			actorId?: string;
			/** Reject-only stable short code; never free text, path, or payload. */
			reasonCode?: string;
			clientRequestId: string;
	  }
	| {
			id?: string;
			type: "task.gate.cancel";
			gateId: string;
			actorId?: string;
			clientRequestId: string;
	  }
	// Task Graph control-plane commands (write commands require clientRequestId)
	| {
			id?: string;
			type: "task.graph.create";
			taskId: string;
			graphRevision: number;
			nodes: TaskGraphNodeDefinition[];
			clientRequestId: string;
	  }
	| { id?: string; type: "task.graph.get"; taskId: string; graphRevision: number }
	| {
			id?: string;
			type: "task.graph.list";
			taskId?: string;
			graphRevision?: number;
			status?: TaskGraphStatus;
			limit?: number;
	  }
	| {
			id?: string;
			type: "task.graph.node.attach";
			taskId: string;
			graphRevision: number;
			nodeId: string;
			runId: string;
			clientRequestId: string;
	  }
	| {
			id?: string;
			type: "task.graph.node.settle";
			taskId: string;
			graphRevision: number;
			nodeId: string;
			clientRequestId: string;
	  };

// ============================================================================
// RPC Slash Command (for get_commands response)
// ============================================================================

/** Public source metadata for a command owner. Raw source paths and identities are omitted. */
export interface RpcSourceInfo {
	scope: SourceScope;
	origin: SourceOrigin;
}

/** A command available for invocation via prompt */
export interface RpcSlashCommand {
	/** Command name (without leading slash) */
	name: string;
	/** Human-readable description */
	description?: string;
	/** What kind of command this is */
	source: "extension" | "prompt" | "skill";
	/** Public metadata for the owning resource; never contains path/baseDir/source identity. */
	sourceInfo: RpcSourceInfo;
}

// ============================================================================
// RPC State
// ============================================================================

export interface RpcSessionState {
	model?: Model<any>;
	thinkingLevel: ThinkingLevel;
	isStreaming: boolean;
	isCompacting: boolean;
	steeringMode: "all" | "one-at-a-time";
	followUpMode: "all" | "one-at-a-time";
	sessionId: string;
	sessionName?: string;
	autoCompactionEnabled: boolean;
	messageCount: number;
	pendingMessageCount: number;
}

/** Session statistics safe for public RPC output. Internal sessionFile is omitted. */
export type RpcSessionStats = Omit<SessionStats, "sessionFile">;

// ============================================================================
// RPC Responses (stdout)
// ============================================================================

// Success responses with data
export type RpcResponse =
	// Prompting (async - events follow)
	| { id?: string; type: "response"; command: "prompt"; success: true }
	| { id?: string; type: "response"; command: "steer"; success: true }
	| { id?: string; type: "response"; command: "follow_up"; success: true }
	| { id?: string; type: "response"; command: "abort"; success: true }
	| { id?: string; type: "response"; command: "new_session"; success: true; data: { cancelled: boolean } }

	// State
	| { id?: string; type: "response"; command: "get_state"; success: true; data: RpcSessionState }

	// Model
	| {
			id?: string;
			type: "response";
			command: "set_model";
			success: true;
			data: Model<any>;
	  }
	| {
			id?: string;
			type: "response";
			command: "get_execution_policy";
			success: true;
			data: GetExecutionPolicyData;
	  }
	| { id?: string; type: "response"; command: "policy.approve"; success: true }
	| { id?: string; type: "response"; command: "policy.reject"; success: true }
	| {
			id?: string;
			type: "response";
			command: "cycle_model";
			success: true;
			data: { model: Model<any>; thinkingLevel: ThinkingLevel; isScoped: boolean } | null;
	  }
	| {
			id?: string;
			type: "response";
			command: "get_available_models";
			success: true;
			data: { models: Model<any>[] };
	  }

	// Thinking
	| { id?: string; type: "response"; command: "set_thinking_level"; success: true }
	| {
			id?: string;
			type: "response";
			command: "cycle_thinking_level";
			success: true;
			data: { level: ThinkingLevel } | null;
	  }
	| {
			id?: string;
			type: "response";
			command: "get_available_thinking_levels";
			success: true;
			data: { levels: ThinkingLevel[] };
	  }

	// Queue modes
	| { id?: string; type: "response"; command: "set_steering_mode"; success: true }
	| { id?: string; type: "response"; command: "set_follow_up_mode"; success: true }

	// Compaction
	| { id?: string; type: "response"; command: "compact"; success: true; data: CompactionResult }
	| { id?: string; type: "response"; command: "set_auto_compaction"; success: true }

	// Retry
	| { id?: string; type: "response"; command: "set_auto_retry"; success: true }
	| { id?: string; type: "response"; command: "abort_retry"; success: true }

	// Bash
	| { id?: string; type: "response"; command: "bash"; success: true; data: BashResult }
	| { id?: string; type: "response"; command: "abort_bash"; success: true }

	// Session
	| { id?: string; type: "response"; command: "get_session_stats"; success: true; data: RpcSessionStats }
	| { id?: string; type: "response"; command: "export_html"; success: true; data: { path: string } }
	| { id?: string; type: "response"; command: "switch_session"; success: true; data: { cancelled: boolean } }
	| { id?: string; type: "response"; command: "fork"; success: true; data: { text: string; cancelled: boolean } }
	| { id?: string; type: "response"; command: "clone"; success: true; data: { cancelled: boolean } }
	| {
			id?: string;
			type: "response";
			command: "get_fork_messages";
			success: true;
			data: { messages: Array<{ entryId: string; text: string }> };
	  }
	| {
			id?: string;
			type: "response";
			command: "get_entries";
			success: true;
			data: { entries: PublicSessionEntry[]; leafId: string | null };
	  }
	| {
			id?: string;
			type: "response";
			command: "get_tree";
			success: true;
			data: { tree: PublicSessionTreeNode[]; leafId: string | null };
	  }
	| {
			id?: string;
			type: "response";
			command: "get_last_assistant_text";
			success: true;
			data: { text: string | null };
	  }
	| { id?: string; type: "response"; command: "set_session_name"; success: true }

	// Messages
	| { id?: string; type: "response"; command: "get_messages"; success: true; data: { messages: AgentMessage[] } }

	// Commands
	| {
			id?: string;
			type: "response";
			command: "get_commands";
			success: true;
			data: { commands: RpcSlashCommand[] };
	  }

	// Context Engine
	| {
			id?: string;
			type: "response";
			command: "get_context";
			success: true;
			data: GetContextData;
	  }

	// MCP public surface. Lists carry the normalized catalog page, read/get
	// carry normalized bounded content, attach carries a metadata/digest receipt
	// only, and auth carries the sanitized status. The one-shot authorization
	// URL is never part of any response: it is delivered at most once per
	// `mcp.auth.start` as an explicit interactive `mcp.auth.url` event.
	| {
			id?: string;
			type: "response";
			command: "mcp.list_resources";
			success: true;
			data: MCPPageResult<MCPResourceView>;
	  }
	| {
			id?: string;
			type: "response";
			command: "mcp.read_resource";
			success: true;
			data: MCPReadResourceResult;
	  }
	| {
			id?: string;
			type: "response";
			command: "mcp.attach_resource";
			success: true;
			data: RpcMcpAttachmentReceipt;
	  }
	| {
			id?: string;
			type: "response";
			command: "mcp.list_prompts";
			success: true;
			data: MCPPageResult<MCPPromptView>;
	  }
	| {
			id?: string;
			type: "response";
			command: "mcp.get_prompt";
			success: true;
			data: MCPGetPromptResult;
	  }
	| {
			id?: string;
			type: "response";
			command: "mcp.attach_prompt";
			success: true;
			data: RpcMcpAttachmentReceipt;
	  }
	| { id?: string; type: "response"; command: "mcp.auth.start"; success: true; data: McpAuthStartData }
	| { id?: string; type: "response"; command: "mcp.auth.logout"; success: true }

	// Capability inspection
	| {
			id?: string;
			type: "response";
			command: "get_capabilities";
			success: true;
			data: GetCapabilitiesData;
	  }
	| {
			id?: string;
			type: "response";
			command: "get_model_routes";
			success: true;
			data: PublicModelSummary;
	  }

	// Error response (any command can fail)
	| { id?: string; type: "response"; command: string; success: false; error: string };

/** Redacted Context Engine inspection payload (metadata only). */
export interface GetContextData {
	snapshot: PublicContextSnapshot;
	drift: PublicContextSourceDrift[];
	/** True when snapshotId was omitted and the payload is a non-persisted preview. */
	preview: boolean;
}

/**
 * Redacted capability inspection payload. All identities are opaque and no
 * raw source path, URL, config, environment value, header, token, or server
 * instruction is returned.
 */
export interface GetCapabilitiesData {
	/** Public catalog of the descriptors discovered for the current session. */
	catalog: CapabilityCatalogView;
	/** Redacted view of the current frozen binding, or null when none is resolved. */
	binding: PublicCapabilityBindingLedgerRecord | null;
	/** Redacted binding history folded from the Session's capability.binding ledger. */
	bindings: PublicCapabilityBindingLedgerRecord[];
}

/** Redacted execution policy inspection payload. */
export interface GetExecutionPolicyData {
	summary: PublicPolicySummary;
	pendingApprovals: ReadonlyArray<PolicyApprovalRequest>;
}

/** Public, metadata-only model route catalog returned by get_model_routes. */
export type GetModelRoutesData = PublicModelSummary;

// ============================================================================
// MCP public wire views (metadata/digest only)
// ============================================================================

/**
 * Redacted receipt of a successful `mcp.attach_resource` / `mcp.attach_prompt`.
 * The attachment is registered in the Session (the only way remote content
 * enters the session); the wire carries the receipt fields only, never the raw
 * URI, prompt name, argument values, or remote text.
 */
export type RpcMcpAttachmentReceipt = McpAttachmentResult;

/**
 * Sanitized OAuth + credential status view of one MCP server. Never includes
 * token material, raw OAuth metadata, or the authorization URL (delivered at
 * most once per `mcp.auth.start` as an explicit interactive `mcp.auth.url`
 * event, never through status).
 */
export type RpcMcpAuthStatus = McpAuthStatusView;

/** Data returned by a successful `mcp.auth.start`. */
export interface McpAuthStartData {
	serverId: string;
	/**
	 * One-shot outcome of the headless flow start. `interaction_required`
	 * means the authorization URL was delivered once as the interactive
	 * `mcp.auth.url` event and the flow is pending; `authorized` means the
	 * server is already authenticated. Never carries the auth URL.
	 */
	outcome: MCPAuthOutcome;
	/** Sanitized status: never carries the auth URL or any token material. */
	status: RpcMcpAuthStatus;
}

/**
 * Explicit, one-time interactive response of an in-flight `mcp.auth.start`:
 * the authorization URL is published exactly once per flow and never appears
 * in status, receipts, or any other event.
 */
export type RpcMcpAuthUrlEvent = {
	type: "mcp.auth.url";
	serverId: string;
	url: string;
};

// ============================================================================
// Extension UI Events (stdout)
// ============================================================================

/** Emitted when an extension needs user input */
export type RpcExtensionUIRequest =
	| { type: "extension_ui_request"; id: string; method: "select"; title: string; options: string[]; timeout?: number }
	| { type: "extension_ui_request"; id: string; method: "confirm"; title: string; message: string; timeout?: number }
	| {
			type: "extension_ui_request";
			id: string;
			method: "input";
			title: string;
			placeholder?: string;
			timeout?: number;
	  }
	| { type: "extension_ui_request"; id: string; method: "editor"; title: string; prefill?: string }
	| {
			type: "extension_ui_request";
			id: string;
			method: "notify";
			message: string;
			notifyType?: "info" | "warning" | "error";
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "setStatus";
			statusKey: string;
			statusText: string | undefined;
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "setWidget";
			widgetKey: string;
			widgetLines: string[] | undefined;
			widgetPlacement?: "aboveEditor" | "belowEditor";
	  }
	| { type: "extension_ui_request"; id: string; method: "setTitle"; title: string }
	| { type: "extension_ui_request"; id: string; method: "set_editor_text"; text: string };

// ============================================================================
// Extension UI Commands (stdin)
// ============================================================================

/** Response to an extension UI request */
export type RpcExtensionUIResponse =
	| { type: "extension_ui_response"; id: string; value: string }
	| { type: "extension_ui_response"; id: string; confirmed: boolean }
	| { type: "extension_ui_response"; id: string; cancelled: true };

// ============================================================================
// Helper type for extracting command types
// ============================================================================

export type RpcCommandType = RpcCommand["type"];

// ============================================================================
// Automation Host (protocolVersion 1)
// ============================================================================

/** Commands introduced by the Automation Host v1 protocol. */
export type RpcRunCommandType = "run.start" | "run.get" | "run.cancel" | "run.resume";

/** MCP public surface commands (resources/prompts/auth). */
export type RpcMcpCommandType =
	| "mcp.list_resources"
	| "mcp.read_resource"
	| "mcp.attach_resource"
	| "mcp.list_prompts"
	| "mcp.get_prompt"
	| "mcp.attach_prompt"
	| "mcp.auth.start"
	| "mcp.auth.logout";

/** Automation Host v1 audit and external mapping commands. */
export type RpcAuditCommandType = "audit.query" | "audit.replay" | "external.map";

/** Task Gate v1 control-plane commands. Write commands require `clientRequestId`. */
export type RpcTaskGateCommandType =
	| "task.gate.request"
	| "task.gate.get"
	| "task.gate.list"
	| "task.gate.approve"
	| "task.gate.reject"
	| "task.gate.cancel";

/** Task Graph v1 control-plane commands. Write commands require `clientRequestId`. */
export type RpcTaskGraphCommandType =
	| "task.graph.create"
	| "task.graph.get"
	| "task.graph.list"
	| "task.graph.node.attach"
	| "task.graph.node.settle";

/** The full Automation Host v1 command set (initialize + run commands). */
export type RpcAutomationCommandType =
	| "initialize"
	| RpcRunCommandType
	| RpcAuditCommandType
	| RpcTaskGateCommandType
	| RpcTaskGraphCommandType
	| RpcMcpCommandType;

/** Data returned by a successful `initialize` (advertises the host contract). */
export interface InitializeData {
	host: "automation-host";
	protocolVersion: 1;
	sessionId: string;
	runCommands: RpcRunCommandType[];
	/** Additive audit and external mapping command list. */
	auditCommands?: RpcAuditCommandType[];
	/** Additive Task Gate control-plane command list. */
	taskGateCommands?: RpcTaskGateCommandType[];
	/** Additive Task Graph control-plane command list. */
	taskGraphCommands?: RpcTaskGraphCommandType[];
	/** Additive MCP public surface command list. */
	mcpCommands?: RpcMcpCommandType[];
	/** Safe External Agent Adapter descriptors registered by the trusted Host. */
	externalAgentAdapters?: ReadonlyArray<ExternalAgentAdapterDescriptor>;
}

/** Data returned by a successful `run.start` / `run.resume`. */
export interface RunAcceptedData {
	runId: string;
	sessionId: string;
	attempt: number;
	status: RunStatus;
	requestScope?: "start" | "resume";
	clientRequestId?: string;
	requestFingerprint?: string;
	deadlineAt?: string;
	/** True when this response replays an already durable request-to-Run relation. */
	idempotent?: boolean;
	receipt?: PublicRunReceipt;
	recovery?: RunRecoveryState;
	external?: ExternalExecutionRef;
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

/** Data returned by a successful `run.get`. */
export interface RunGetData {
	run: PublicRunRecord;
	receipt?: PublicRunReceipt;
	recovery?: RunRecoveryState;
}

/** Data returned by a successful `run.cancel`. */
export interface RunCancelData {
	runId: string;
	status: RunStatus;
}

/** Data returned by a successful `audit.query`. */
export type AuditQueryData = AuditQueryResult;

/** Data returned by a successful `audit.replay`. */
export type AuditReplayData = AuditReplayResult;

/** Data returned by a successful `external.map`. */
export type ExternalMapData = ExternalMappingPersistenceResult;

/** Data returned by a successful `task.gate.request` / approve / reject / cancel. */
export interface TaskGateMutationData {
	gate: TaskGateRecord;
	/** True when this response replays an already durable transition. */
	idempotent: boolean;
}

/** Data returned by a successful `task.gate.get`. */
export interface TaskGateGetData {
	gate: TaskGateRecord;
}

/** Data returned by a successful `task.gate.list`. */
export interface TaskGateListData {
	gates: TaskGateRecord[];
	truncated: boolean;
}

/** Data returned by a successful `task.graph.create` / `task.graph.node.attach` / `task.graph.node.settle`. */
export interface TaskGraphMutationData {
	graph: TaskGraphRecord;
	/** The affected node view for node transitions; absent for create. */
	node?: TaskGraphNodeView;
	/** True when this response replays an already durable transition. */
	idempotent: boolean;
}

/** Data returned by a successful `task.graph.get`. */
export interface TaskGraphGetData {
	graph: TaskGraphRecord;
}

/** Data returned by a successful `task.graph.list`. */
export interface TaskGraphListData {
	graphs: TaskGraphRecord[];
	truncated: boolean;
}

/**
 * Automation Host v1 responses.
 *
 * Success responses mirror the corresponding commands. Every failure carries a
 * structured {@link AutomationError} instead of the legacy string `error`, so
 * automation callers can branch on a stable `code`.
 */
export type RpcAutomationResponse =
	| { id?: string; type: "response"; command: "initialize"; success: true; data: InitializeData }
	| { id?: string; type: "response"; command: "run.start"; success: true; data: RunAcceptedData }
	| { id?: string; type: "response"; command: "run.resume"; success: true; data: RunAcceptedData }
	| { id?: string; type: "response"; command: "run.get"; success: true; data: RunGetData }
	| { id?: string; type: "response"; command: "run.cancel"; success: true; data: RunCancelData }
	| { id?: string; type: "response"; command: "audit.query"; success: true; data: AuditQueryData }
	| { id?: string; type: "response"; command: "audit.replay"; success: true; data: AuditReplayData }
	| { id?: string; type: "response"; command: "external.map"; success: true; data: ExternalMapData }
	| { id?: string; type: "response"; command: "task.gate.request"; success: true; data: TaskGateMutationData }
	| { id?: string; type: "response"; command: "task.gate.get"; success: true; data: TaskGateGetData }
	| { id?: string; type: "response"; command: "task.gate.list"; success: true; data: TaskGateListData }
	| { id?: string; type: "response"; command: "task.gate.approve"; success: true; data: TaskGateMutationData }
	| { id?: string; type: "response"; command: "task.gate.reject"; success: true; data: TaskGateMutationData }
	| { id?: string; type: "response"; command: "task.gate.cancel"; success: true; data: TaskGateMutationData }
	| { id?: string; type: "response"; command: "task.graph.create"; success: true; data: TaskGraphMutationData }
	| { id?: string; type: "response"; command: "task.graph.get"; success: true; data: TaskGraphGetData }
	| { id?: string; type: "response"; command: "task.graph.list"; success: true; data: TaskGraphListData }
	| { id?: string; type: "response"; command: "task.graph.node.attach"; success: true; data: TaskGraphMutationData }
	| { id?: string; type: "response"; command: "task.graph.node.settle"; success: true; data: TaskGraphMutationData }
	| { id?: string; type: "response"; command: "mcp.list_resources"; success: true; data: MCPPageResult<MCPResourceView> }
	| { id?: string; type: "response"; command: "mcp.read_resource"; success: true; data: MCPReadResourceResult }
	| { id?: string; type: "response"; command: "mcp.attach_resource"; success: true; data: RpcMcpAttachmentReceipt }
	| { id?: string; type: "response"; command: "mcp.list_prompts"; success: true; data: MCPPageResult<MCPPromptView> }
	| { id?: string; type: "response"; command: "mcp.get_prompt"; success: true; data: MCPGetPromptResult }
	| { id?: string; type: "response"; command: "mcp.attach_prompt"; success: true; data: RpcMcpAttachmentReceipt }
	| { id?: string; type: "response"; command: "mcp.auth.start"; success: true; data: McpAuthStartData }
	| { id?: string; type: "response"; command: "mcp.auth.logout"; success: true }
	| {
			id?: string;
			type: "response";
			command: RpcAutomationCommandType;
			success: false;
			error: AutomationError;
	  };

// Re-export the redacted capability binding view consumed by get_capabilities.
export type { CapabilityBindingView } from "../../core/capability-registry.ts";
// Re-export the normalized MCP content results consumed by the wire surface.
export type {
	MCPContentLimits,
	MCPGetPromptResult,
	MCPNormalizedContent,
	MCPNormalizedContentBlock,
	MCPPageResult,
	MCPPromptMessageView,
	MCPPromptView,
	MCPReadResourceResult,
	MCPResourceTemplateView,
	MCPResourceView,
} from "../../core/mcp-content-types.ts";
// Re-export the secret-free MCP auth/status views consumed by the wire surface.
export type { McpAuthStatusView, McpAttachmentResult } from "../../core/agent-session.ts";
export type { MCPAuthOutcome, MCPAuthStatus } from "../../core/mcp-auth.ts";
// Re-export public audit query/replay types.
export type {
	AuditEvent,
	AuditEventType,
	AuditQuery,
	AuditQueryResult,
	AuditReplayQuery,
	AuditReplayResult,
	AuditWarning,
} from "../../core/execution-audit-query.ts";
// Re-export public external mapping types.
export type {
	ExternalExecutionMapping,
	ExternalExecutionRef,
	ExternalMappingSummary,
	ExternalMappingPersistenceResult,
	ExternalMappingRequest,
} from "../../core/external-session-mapping.ts";
// Re-export the public External Agent Adapter selection surface (safe identifiers only).
export type { ExternalAgentSelection } from "../../core/external-agent-adapter.ts";
export type { ExternalAgentAdapterDescriptor } from "../../core/external-agent-registry.ts";
// Re-export public Task Gate types.
export type {
	TaskGateErrorCode,
	TaskGateRecord,
	TaskGateStatus,
} from "../../core/task-gate.ts";
// Re-export public Task Graph types.
export type {
	TaskGraphErrorCode,
	TaskGraphGateRef,
	TaskGraphNodeAvailability,
	TaskGraphNodeDefinition,
	TaskGraphNodeStatus,
	TaskGraphNodeView,
	TaskGraphRecord,
	TaskGraphRunRef,
	TaskGraphStatus,
	TaskGraphSummary,
} from "../../core/task-graph.ts";
// Re-export the core Automation Host types for consumers.
export type {
	AutomationError,
	AutomationErrorCode,
	PublicContextSnapshot,
	PublicContextSourceDrift,
	PublicContextSourceReceipt,
	PublicRunReceipt as RunReceipt,
	PublicRunRecord as RunRecord,
	PublicRunStreamEvent as RunStreamEvent,
	RunRecoveryState,
	RunStatus,
	RunTerminalStatus,
} from "../../core/run-lifecycle.ts";
