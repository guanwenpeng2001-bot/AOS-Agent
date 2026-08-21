/**
 * RPC protocol types for headless operation.
 *
 * Commands are sent as JSON lines on stdin.
 * Responses and events are emitted as JSON lines on stdout.
 */

import type { AgentMessage, ThinkingLevel } from "@aos-agent/agent-core";
import type { ImageContent, Model } from "@aos-agent/ai";
import type { SessionStats } from "../../core/agent-session.ts";
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
import type { MCPContentErrorCode, MCPContentProvenance } from "../../core/mcp-content.ts";
import type { MCPContentPublicErrorCode } from "../../core/mcp-error-codes.ts";
import type {
	MCPPromptListResult,
	MCPResourceListResult,
	MCPResourceTemplateListResult,
} from "../../core/mcp-types.ts";
import type { TaskGateRecord, TaskGateStatus } from "../../core/task-gate.ts";
import type {
	TaskGraphNodeDefinition,
	TaskGraphNodeView,
	TaskGraphRecord,
	TaskGraphStatus,
} from "../../core/task-graph.ts";
import type {
	TaskCredentialDeliveryReceipt,
	TaskCredentialGrant,
	TaskCredentialScope,
	TaskCredentialStatus,
} from "../../core/task-credential-lease.ts";
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
import type { WorkerLifecycleStatusV1 } from "../../core/worker.ts";

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

	// MCP content (resource/prompt/template): raw URIs, template patterns, and
	// prompt args are used once and never echoed by responses, audit records,
	// or errors
	| { id?: string; type: "mcp.resource.list"; serverId: string; cursor?: string }
	| { id?: string; type: "mcp.resource.templates.list"; serverId: string; cursor?: string }
	| { id?: string; type: "mcp.resource.read"; serverId: string; uri: string }
	| { id?: string; type: "mcp.resource.attach"; serverId: string; uri: string }
	| { id?: string; type: "mcp.prompt.list"; serverId: string; cursor?: string }
	| { id?: string; type: "mcp.prompt.get"; serverId: string; name: string; args?: Record<string, string> }
	| { id?: string; type: "mcp.prompt.attach"; serverId: string; name: string; args?: Record<string, string> }

	// MCP OAuth (auth): credential status and lifecycle. `mcp.auth.start` is
	// headless by default and fails closed immediately with the fixed
	// `mcp_auth_interaction_required` error; declaring `interactive: true`
	// opts into the extension-UI interaction bridge, whose confirm / manual
	// code dialogs and one-shot `auth_url` delivery the client drives through
	// `extension_ui_request` / `extension_ui_response` records. `serverUrl`
	// lives only in the request and is never echoed; responses never carry
	// tokens, URLs, issuer/resource, or raw URIs.
	| {
			id?: string;
			type: "mcp.auth.start";
			serverId: string;
			serverUrl: string;
			/** Declares that the caller drives the extension-UI interaction bridge. */
			interactive?: boolean;
			/** Fixed callback shape; defaults to `loopback`. */
			callbackMode?: "loopback" | "https";
			/** Fixed HTTPS redirect URI; required when `callbackMode` is `https`. */
			httpsCallbackUrl?: string;
			/** Bounded deadline for the interactive callback capture. */
			timeoutMs?: number;
			/** Per-HTTP-request deadline for discovery/token calls. */
			requestTimeoutMs?: number;
	  }
	| { id?: string; type: "mcp.auth.status"; serverId: string; serverUrl: string }
	| { id?: string; type: "mcp.auth.list" }
	| { id?: string; type: "mcp.auth.logout"; serverId: string; serverUrl?: string }

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
	  }
	// Task Credential control-plane commands (write commands require clientRequestId)
	| {
			id?: string;
			type: "task.credential.issue";
			taskId: string;
			graphRevision: number;
			nodeId: string;
			stageId?: string;
			stageRevision?: number;
			runId: string;
			capabilityBindingId: string;
			policyBindingId: string;
			sandboxBindingId?: string;
			targetId?: string;
			/** Validated credential target kind; omitted kinds are derived from the scope facts when unambiguous. */
			targetKind?: string;
			workerId?: string;
			/** Structured allowlist scopes; never free text and never credential material. */
			scopes: ReadonlyArray<TaskCredentialScope>;
			requestedTtlMs: number;
			clientRequestId: string;
	  }
	| { id?: string; type: "task.credential.get"; leaseId: string }
	| {
			id?: string;
			type: "task.credential.list";
			taskId?: string;
			nodeId?: string;
			runId?: string;
			status?: TaskCredentialStatus;
			limit?: number;
	  }
	| {
			id?: string;
			type: "task.credential.heartbeat";
			leaseId: string;
			grantId: string;
			bindingId: string;
			/** Must equal the current grant's `heartbeatSequence + 1`; stale sequences fail closed. */
			heartbeatSequence: number;
			requestedTtlMs: number;
			clientRequestId: string;
	  }
	| {
			id?: string;
			type: "task.credential.revoke";
			leaseId: string;
			/** Reject-only stable short code; never free text, path, or payload. */
			reasonCode?: string;
			clientRequestId: string;
	  }
	| {
			id?: string;
			type: "task.credential.settle";
			leaseId: string;
			reasonCode?: string;
			clientRequestId: string;
	  }

	// Operation Worker management (safe current-Session projection only)
	| { id?: string; type: "worker.get"; workerId: string }
	| {
			id?: string;
			type: "worker.list";
			runId?: string;
			status?: WorkerLifecycleStatusV1;
			limit?: number;
			cursor?: string;
	  }
	| { id?: string; type: "worker.reclaim"; workerId: string };

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

	// MCP content (resource/prompt/template): metadata/digest receipts only;
	// remote text, raw URIs, template patterns, and prompt argument values
	// never cross the wire
	| { id?: string; type: "response"; command: "mcp.resource.list"; success: true; data: MCPResourceListResult }
	| {
			id?: string;
			type: "response";
			command: "mcp.resource.templates.list";
			success: true;
			data: MCPResourceTemplateListResult;
	  }
	| { id?: string; type: "response"; command: "mcp.resource.read"; success: true; data: RpcMcpReadResourceReceipt }
	| { id?: string; type: "response"; command: "mcp.resource.attach"; success: true; data: RpcMcpAttachmentReceipt }
	| { id?: string; type: "response"; command: "mcp.prompt.list"; success: true; data: MCPPromptListResult }
	| { id?: string; type: "response"; command: "mcp.prompt.get"; success: true; data: RpcMcpGetPromptReceipt }
	| { id?: string; type: "response"; command: "mcp.prompt.attach"; success: true; data: RpcMcpAttachmentReceipt }

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
// MCP content wire views (metadata/digest only)
// ============================================================================

/**
 * Redacted summary of one normalized content block. Text and image payloads
 * never cross the RPC wire; only digest, byte count, and bounded metadata are
 * returned, so remote original text is never echoed by a response.
 */
export interface RpcMcpContentBlockSummary {
	kind: "text" | "image" | "unattached";
	/** Normalized UTF-8 byte count of the block payload. */
	bytes: number;
	/** SHA-256 hex digest over the normalized block payload. */
	digest: string;
	/** Normalized MIME type; present for image and some unattached blocks. */
	mimeType?: string;
	/** Server-reported size in bytes; present for some unattached blocks. */
	size?: number;
	/** Unattached-block classification reason. */
	reason?: "blob" | "audio" | "resource_link" | "embedded_blob";
}

/** Redacted summary of one normalized prompt message; block payloads omitted. */
export interface RpcMcpPromptMessageSummary {
	role: "user" | "assistant";
	blocks: ReadonlyArray<RpcMcpContentBlockSummary>;
	/** SHA-256 hex digest over the message's normalized blocks. */
	digest: string;
}

/**
 * Redacted receipt of a successful `mcp.resource.read`. Carries only the
 * deterministic resource id, block digests/counts, and untrusted provenance;
 * the raw URI and remote text are never retained or echoed.
 */
export interface RpcMcpReadResourceReceipt {
	serverId: string;
	/** Deterministic digest id of the resource; never the raw URI. */
	resourceId: string;
	blocks: ReadonlyArray<RpcMcpContentBlockSummary>;
	provenance: MCPContentProvenance;
}

/**
 * Redacted receipt of a successful `mcp.prompt.get`. Carries only the
 * deterministic prompt id, per-message digests, and untrusted provenance;
 * the prompt name, argument values, and remote text are never echoed.
 */
export interface RpcMcpGetPromptReceipt {
	serverId: string;
	/** Deterministic digest id of the prompt; never the raw name. */
	promptId: string;
	messages: ReadonlyArray<RpcMcpPromptMessageSummary>;
	provenance: MCPContentProvenance;
}

/**
 * Redacted receipt of a successful `mcp.resource.attach` / `mcp.prompt.attach`.
 * The attachment is registered in the Session (the only way remote content
 * enters the session); the wire carries metadata, digests, and the opaque
 * binding ids only, never the raw URI, prompt name, argument values, or
 * remote text.
 */
export interface RpcMcpAttachmentReceipt {
	/** Deterministic digest id of the registered attachment. */
	id: string;
	kind: "resource" | "prompt";
	serverId: string;
	/** Digest id of the source resource or prompt; never the raw URI or name. */
	sourceId: string;
	provenance: MCPContentProvenance;
	/** SHA-256 hex digest over all normalized blocks of the read/get result. */
	contentDigest: string;
	/** Total normalized byte count of the read/get result. */
	byteCount: number;
	/** Total normalized block count of the read/get result. */
	blockCount: number;
	/** Count of allowlisted attachable text/image blocks. */
	attachableBlockCount: number;
	/** Opaque capability binding id that authorized the attach. */
	capabilityBindingId: string;
	/** Opaque execution policy binding id that authorized the attach. */
	policyBindingId: string;
	createdAt: string;
}

// ============================================================================
// MCP content wire errors (mcp.resource.* / mcp.prompt.*)
// ============================================================================

/** Commands of the MCP content surface. */
export type RpcMcpContentCommandType =
	| "mcp.resource.list"
	| "mcp.resource.templates.list"
	| "mcp.resource.read"
	| "mcp.resource.attach"
	| "mcp.prompt.list"
	| "mcp.prompt.get"
	| "mcp.prompt.attach";

/**
 * Stable, fixed-message error codes of the `mcp.resource.*` / `mcp.prompt.*`
 * commands. Content-safety failures surface the PR error-contract codes
 * (`mcp_content_invalid`, `mcp_content_limit_exceeded`) mapped by the host
 * from the fine-grained core {@link MCPContentErrorCode} (which stays
 * reachable for SDK consumers); capability denials surface the
 * operation-specific `mcp_resource_denied` / `mcp_prompt_denied`; lifecycle,
 * policy, and abort failures map to fixed codes below. Raw remote text,
 * URIs, template patterns, prompt arguments, auth URLs, issuer/resource, and
 * tokens never appear in messages.
 */
export type RpcMcpContentErrorCode =
	| MCPContentErrorCode
	| MCPContentPublicErrorCode
	| "mcp_resource_denied"
	| "mcp_prompt_denied"
	| "mcp_not_selected"
	| "mcp_invalid_config"
	| "mcp_connect_failed"
	| "mcp_auth_required"
	| "mcp_unavailable"
	| "mcp_capability_denied"
	| "mcp_policy_denied"
	| "mcp_aborted";

/** Structured, fixed-message error of the MCP content commands. */
export interface RpcMcpContentError {
	code: RpcMcpContentErrorCode;
	message: string;
}

/**
 * Responses of the MCP content commands.
 *
 * Every failure carries a structured {@link RpcMcpContentError} with a stable
 * `code` and a fixed template `message`; raw URIs, template patterns, prompt
 * arguments, remote text, tokens, and generic catch text never cross the wire.
 */
export type RpcMcpContentResponse =
	| Extract<RpcResponse, { command: RpcMcpContentCommandType }>
	| { id?: string; type: "response"; command: RpcMcpContentCommandType; success: false; error: RpcMcpContentError };

// ============================================================================
// MCP OAuth wire contract (mcp.auth.*)
// ============================================================================

/** Commands of the MCP OAuth credential surface. */
export type RpcMcpAuthCommandType = "mcp.auth.start" | "mcp.auth.status" | "mcp.auth.list" | "mcp.auth.logout";

/** Fixed status vocabulary of a successful `mcp.auth.start`. */
export type RpcMcpAuthStartStatus = "authorized" | "already_authorized" | "not_required";

/** Fixed status vocabulary of `mcp.auth.status`. */
export type RpcMcpAuthStatusValue = "authenticated" | "expired" | "required";

/**
 * Masked credential status of one MCP server. Token values, the server URL,
 * issuer/resource, and raw URIs never cross the wire; only the opaque server
 * identity and non-secret metadata are returned.
 */
export interface RpcMcpMaskedCredential {
	/** Opaque server identity (one-way derivation of the canonical server URL). */
	serverIdentity: string;
	/** authenticated when a usable token is stored; expired when the stored grant has elapsed. */
	status: "authenticated" | "expired";
}

/**
 * Data returned by a successful `mcp.auth.start`.
 *
 * Only the terminal status crosses the wire in the response. The one-shot
 * authorization URL is delivered exclusively through the dedicated
 * `extension_ui_request` `auth_url` record; it never appears in the
 * response, session events, catalog, status, receipt, audit, errors, or logs,
 * and no token or raw URI is ever carried.
 */
export interface RpcMcpAuthStartData {
	status: RpcMcpAuthStartStatus;
}

/** Data returned by a successful `mcp.auth.status`. */
export interface RpcMcpAuthStatusData {
	status: RpcMcpAuthStatusValue;
	credential?: RpcMcpMaskedCredential;
}

/** Data returned by a successful `mcp.auth.list`. */
export interface RpcMcpAuthListData {
	credentials: ReadonlyArray<RpcMcpMaskedCredential>;
}

/** Stable, fixed-message error codes of the `mcp.auth.*` commands (PR error contract section 8). */
export type RpcMcpAuthErrorCode =
	| "mcp_auth_interaction_required"
	| "mcp_auth_not_configured"
	| "mcp_auth_stdio_not_applicable"
	| "mcp_auth_invalid_request"
	| "mcp_auth_metadata_invalid"
	| "mcp_auth_resource_mismatch"
	| "mcp_auth_state_mismatch"
	| "mcp_auth_invalid"
	| "mcp_auth_cancelled"
	| "mcp_auth_storage_invalid_server_url"
	| "mcp_auth_storage_invalid_tokens"
	| "mcp_auth_storage_invalid_scope"
	| "mcp_auth_storage_binding_mismatch"
	| "mcp_auth_storage_namespace_collision"
	| "mcp_auth_capability_denied"
	| "mcp_auth_not_selected"
	| "mcp_auth_invalid_config"
	| "mcp_auth_policy_denied"
	| "mcp_auth_aborted";

/** Structured, fixed-message error of the `mcp.auth.*` commands. */
export interface RpcMcpAuthError {
	code: RpcMcpAuthErrorCode;
	message: string;
}

/**
 * Responses of the `mcp.auth.*` commands.
 *
 * Every failure carries a structured {@link RpcMcpAuthError} with a stable
 * `code` and a fixed template `message`; raw tokens, URLs, remote error text,
 * and generic catch text never cross the wire.
 */
export type RpcMcpAuthResponse =
	| { id?: string; type: "response"; command: "mcp.auth.start"; success: true; data: RpcMcpAuthStartData }
	| { id?: string; type: "response"; command: "mcp.auth.status"; success: true; data: RpcMcpAuthStatusData }
	| { id?: string; type: "response"; command: "mcp.auth.list"; success: true; data: RpcMcpAuthListData }
	| { id?: string; type: "response"; command: "mcp.auth.logout"; success: true }
	| { id?: string; type: "response"; command: RpcMcpAuthCommandType; success: false; error: RpcMcpAuthError };

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
	| { type: "extension_ui_request"; id: string; method: "set_editor_text"; text: string }
	// One-shot, dedicated delivery of the MCP OAuth authorization URL to the
	// interactive client that declared `interactive: true` on `mcp.auth.start`.
	// Fire-and-forget (no response); emitted at most once per flow. The URL is
	// never placed in command responses, session events, capability catalogs,
	// status/list/logout output, receipts, audit entries, errors, or logs, and
	// never carries a token or raw URI.
	| { type: "extension_ui_request"; id: string; method: "auth_url"; url: string; instructions?: string };

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

/** Task Credential v1 control-plane commands. Write commands require `clientRequestId`. */
export type RpcTaskCredentialCommandType =
	| "task.credential.issue"
	| "task.credential.get"
	| "task.credential.list"
	| "task.credential.heartbeat"
	| "task.credential.revoke"
	| "task.credential.settle";

/** Operation Worker management commands. No start or cancel authority is exposed. */
export type RpcWorkerCommandType = "worker.get" | "worker.list" | "worker.reclaim";

/** The full Automation Host v1 command set (initialize + run commands). */
export type RpcAutomationCommandType =
	| "initialize"
	| RpcRunCommandType
	| RpcAuditCommandType
	| RpcTaskGateCommandType
	| RpcTaskGraphCommandType
	| RpcTaskCredentialCommandType
	| RpcWorkerCommandType;

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
	/** Additive Task Credential control-plane command list. */
	taskCredentialCommands?: RpcTaskCredentialCommandType[];
	/** Additive current-Session Operation Worker management command list. */
	workerCommands?: RpcWorkerCommandType[];
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

/** Data returned by a successful `task.credential.issue`. */
export interface TaskCredentialIssueData {
	grant: TaskCredentialGrant;
	leaseId: string;
	bindingId: string;
	/** Safe delivery receipt of the target projection, when the provider reported one. */
	delivery?: TaskCredentialDeliveryReceipt;
	/** True when this response replays an already durable issue (same context + clientRequestId). */
	idempotent: boolean;
}

/** Data returned by a successful `task.credential.get`. */
export interface TaskCredentialGetData {
	grant: TaskCredentialGrant;
}

/** Data returned by a successful `task.credential.list`. */
export interface TaskCredentialListData {
	grants: TaskCredentialGrant[];
	truncated: boolean;
}

/** Data returned by a successful `task.credential.heartbeat`. */
export interface TaskCredentialHeartbeatData {
	grant: TaskCredentialGrant;
	leaseId: string;
	bindingId: string;
	/** True when this response replays an already durable renewal. */
	idempotent: boolean;
}

/** Data returned by a successful `task.credential.revoke`. */
export interface TaskCredentialRevokeData {
	grant: TaskCredentialGrant;
	/** True when this response replays an already durable revoke. */
	idempotent: boolean;
}

/** Data returned by a successful `task.credential.settle`. */
export interface TaskCredentialSettleData {
	grant: TaskCredentialGrant;
	idempotent: boolean;
}

// ============================================================================
// Operation Worker management wire contract
// ============================================================================

/** Public-safe Worker record. Receipt references and execution resources are omitted. */
export interface RpcWorkerRecord {
	schemaVersion: 1;
	workerId: string;
	providerId: string;
	sessionId: string;
	laneId: string;
	runId?: string;
	bindingId?: string;
	bindingEpochId?: string;
	attemptId?: string;
	profileId: string;
	status: WorkerLifecycleStatusV1;
	revision: number;
	createdAt: string;
	readyAt?: string;
	endedAt?: string;
	lastHeartbeatAt?: string;
	activeOperationId?: string;
}

/** Data returned by a successful `worker.get`. */
export interface WorkerGetData {
	worker: RpcWorkerRecord;
}

/** Bounded page returned by a successful `worker.list`. */
export interface WorkerListData {
	workers: RpcWorkerRecord[];
	truncated: boolean;
	nextCursor?: string;
}

/** Data returned by a successful idempotent `worker.reclaim`. */
export interface WorkerReclaimData {
	worker: RpcWorkerRecord;
	idempotent: boolean;
}

/** Stable error codes of the Worker management surface. */
export type RpcWorkerErrorCode =
	| "host_not_initialized"
	| "worker_invalid"
	| "worker_not_found"
	| "worker_unavailable"
	| "worker_conflict"
	| "worker_reclaim_failed";

export interface RpcWorkerError {
	code: RpcWorkerErrorCode;
	message: string;
	retryable: boolean;
}

export type RpcWorkerResponse =
	| { id?: string; type: "response"; command: "worker.get"; success: true; data: WorkerGetData }
	| { id?: string; type: "response"; command: "worker.list"; success: true; data: WorkerListData }
	| { id?: string; type: "response"; command: "worker.reclaim"; success: true; data: WorkerReclaimData }
	| {
			id?: string;
			type: "response";
			command: RpcWorkerCommandType;
			success: false;
			error: RpcWorkerError;
	  };

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
	| { id?: string; type: "response"; command: "task.credential.issue"; success: true; data: TaskCredentialIssueData }
	| { id?: string; type: "response"; command: "task.credential.get"; success: true; data: TaskCredentialGetData }
	| { id?: string; type: "response"; command: "task.credential.list"; success: true; data: TaskCredentialListData }
	| { id?: string; type: "response"; command: "task.credential.heartbeat"; success: true; data: TaskCredentialHeartbeatData }
	| { id?: string; type: "response"; command: "task.credential.revoke"; success: true; data: TaskCredentialRevokeData }
	| { id?: string; type: "response"; command: "task.credential.settle"; success: true; data: TaskCredentialSettleData }
	| {
			id?: string;
			type: "response";
			command: RpcAutomationCommandType;
			success: false;
			error: AutomationError;
	  };

// Re-export the redacted capability binding view consumed by get_capabilities.
export type { CapabilityBindingView } from "../../core/capability-registry.ts";
// Re-export the safe MCP content catalog/result types consumed by the wire.
export type {
	MCPContentProvenance,
	MCPNormalizedContentBlock,
	MCPNormalizedPromptMessage,
} from "../../core/mcp-content.ts";
export type {
	MCPPromptArgumentSummary,
	MCPPromptListResult,
	MCPPromptSummary,
	MCPResourceListResult,
	MCPResourceSummary,
} from "../../core/mcp-types.ts";
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
// Re-export public Task Credential types.
export type {
	TaskCredentialDeliveryReceipt,
	TaskCredentialGrant,
	TaskCredentialScope,
	TaskCredentialStatus,
} from "../../core/task-credential-lease.ts";
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
