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
import type {
	AutomationError,
	PublicCapabilityBindingLedgerRecord,
	PublicContextSnapshot,
	PublicContextSourceDrift,
	PublicRunReceipt,
	PublicRunRecord,
	PublicSessionEntry,
	PublicSessionTreeNode,
	RunRecoveryState,
	RunStatus,
} from "../../core/run-lifecycle.ts";
import type { SourceOrigin, SourceScope } from "../../core/source-info.ts";

// ============================================================================
// RPC Commands (stdin)
// ============================================================================

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

	// Capability inspection (ordinary, read-only; redacted output only)
	| { id?: string; type: "get_capabilities"; bindingId?: string }

	// Automation Host (protocolVersion 1)
	| { id?: string; type: "initialize"; protocolVersion: number }
	| { id?: string; type: "run.start"; message: string; images?: ImageContent[]; capabilityProfile?: string }
	| { id?: string; type: "run.get"; runId: string }
	| { id?: string; type: "run.cancel"; runId: string }
	| {
			id?: string;
			type: "run.resume";
			sessionPath: string;
			sourceRunId: string;
			message: string;
			images?: ImageContent[];
			capabilityProfile?: string;
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

	// Capability inspection
	| {
			id?: string;
			type: "response";
			command: "get_capabilities";
			success: true;
			data: GetCapabilitiesData;
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

/** The full Automation Host v1 command set (initialize + run commands). */
export type RpcAutomationCommandType = "initialize" | RpcRunCommandType;

/** Data returned by a successful `initialize` (advertises the host contract). */
export interface InitializeData {
	host: "automation-host";
	protocolVersion: 1;
	sessionId: string;
	runCommands: RpcRunCommandType[];
}

/** Data returned by a successful `run.start` / `run.resume`. */
export interface RunAcceptedData {
	runId: string;
	sessionId: string;
	attempt: number;
	status: "accepted";
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
	| {
			id?: string;
			type: "response";
			command: RpcAutomationCommandType;
			success: false;
			error: AutomationError;
	  };

// Re-export the core Automation Host types for consumers.
export type {
	AutomationError,
	AutomationErrorCode,
	PublicRunReceipt as RunReceipt,
	PublicRunRecord as RunRecord,
	RunRecoveryState,
	RunStatus,
	PublicRunStreamEvent as RunStreamEvent,
	RunTerminalStatus,
} from "../../core/run-lifecycle.ts";

export type {
	PublicContextSnapshot,
	PublicContextSourceDrift,
	PublicContextSourceReceipt,
} from "../../core/run-lifecycle.ts";

// Re-export the redacted capability binding view consumed by get_capabilities.
export type { CapabilityBindingView } from "../../core/capability-registry.ts";
