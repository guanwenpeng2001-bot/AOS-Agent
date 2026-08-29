/**
 * RPC Client for programmatic access to the coding agent.
 *
 * Spawns the agent in RPC mode and provides a typed API for all operations.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { createConnection, type Socket } from "node:net";
import type { Writable } from "node:stream";
import type { AgentMessage, ThinkingLevel } from "@aos-agent/agent-core";
import type { ImageContent } from "@aos-agent/ai";
import type { BashResult } from "../../core/bash-executor.ts";
import type { CompactionResult } from "../../core/compaction/index.ts";
import type { CanonicalExternalAgentArtifactReference } from "../../core/connector/input.ts";
import type { MCPPromptListResult, MCPResourceListResult, MCPResourceTemplateListResult } from "../../core/mcp-types.ts";
import { MCP_OAUTH_DEFAULT_TIMEOUT_MS } from "../../core/mcp-auth.ts";
import type { ModelRoleSelection, ModelRouteSelection } from "../../core/model-broker.ts";
import type { PublicSessionEntry, PublicSessionTreeNode } from "../../core/run-lifecycle.ts";
import type { JsonAgentSessionEvent } from "../json-event.ts";
import {
	attachJsonlLineReader,
	createJsonlLineWriter,
	DEFAULT_MAX_JSONL_FRAME_BYTES,
	JsonlFrameError,
	serializeJsonLine,
	type JsonlLineWriter,
} from "./jsonl.ts";
import {
	RPC_TRANSPORT_LOOPBACK_HOST,
	validateRpcTransportAddress,
	RpcTransportAddressError,
} from "./rpc-transport-address.ts";
import { RpcTransportError, type RpcTransportErrorCode, type RpcTransportErrorRecord } from "./rpc-transport.ts";

export { RpcTransportError };
export type { RpcTransportErrorCode, RpcTransportErrorRecord };
import type {
	AuditQuery,
	AuditQueryResult,
	AuditReplayQuery,
	AuditReplayResult,
	AutomationError,
	AutomationErrorCode,
	ExternalConnectorSelection,
	GetCapabilitiesData,
	GetContextData,
	GetExecutionPolicyData,
	GetModelRoutesData,
	InitializeData,
	RpcAutomationResponse,
	RpcMcpAttachmentReceipt,
	RpcMcpAuthError,
	RpcMcpAuthErrorCode,
	RpcMcpContentError,
	RpcMcpContentErrorCode,
	RpcMcpAuthListData,
	RpcMcpAuthStartData,
	RpcMcpAuthStatusData,
	RpcMcpGetPromptReceipt,
	RpcMcpMaskedCredential,
	RpcMcpReadResourceReceipt,
	RpcCommand,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
	RpcResponse,
	RpcSessionState,
	RpcSessionStats,
	RpcSlashCommand,
	RunAcceptedData,
	RunCancelData,
	RunGetData,
} from "./rpc-types.ts";
import {
	type RpcRunStreamEvent,
	type RunReplayReconnectResult,
	RunReplayRecovery,
	type RunReplayRecoveryOptions,
} from "./run-replay-recovery.ts";

// ============================================================================
// Types
// ============================================================================

/** Distributive Omit that works with union types */
type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;

/** RpcCommand without the id field (for internal send) */
type RpcCommandBody = DistributiveOmit<RpcCommand, "id">;

const DEFAULT_RPC_CLIENT_CONNECT_TIMEOUT_MS = 10_000;
const MAX_RPC_CLIENT_CONNECT_TIMEOUT_MS = 2_147_483_647;

/** Explicit TCP connection settings for an RpcClient. */
export interface RpcClientTcpOptions {
	/** Optional discriminator. When present, it must be `tcp`. */
	type?: "tcp";
	/** Address discriminator used by the transport address parser. */
	transport?: "tcp";
	/** Alternate discriminator accepted for transport-oriented callers. */
	kind?: "tcp";
	/** The only host accepted by the RPC client. Defaults to 127.0.0.1. */
	host?: string;
	/** TCP port of the Automation Host listener. */
	port: number;
	/** Maximum time to wait for the TCP connection to open. */
	connectTimeoutMs?: number;
}

/** RpcClient transport selection. Stdio remains the default when omitted. */
export type RpcClientTransportOptions = "stdio" | "tcp" | RpcClientTcpOptions;

export interface RpcClientOptions {
	/** Path to the CLI entry point (default: searches for dist/cli.js) */
	cliPath?: string;
	/** Working directory for the agent */
	cwd?: string;
	/** Environment variables */
	env?: Record<string, string>;
	/** Provider to use */
	provider?: string;
	/** Model ID to use */
	model?: string;
	/** Additional CLI arguments */
	args?: string[];
	/**
	 * Transport selection. An object selects TCP and may include its connection
	 * timeout; omitted or `stdio` keeps the existing child-process transport.
	 */
	transport?: RpcClientTransportOptions;
	/** Convenience form for `transport: "tcp"`. */
	tcp?: RpcClientTcpOptions;
}

export interface ModelInfo {
	provider: string;
	id: string;
	contextWindow: number;
	reasoning: boolean;
}

export type RpcEventListener = (event: JsonAgentSessionEvent) => void;

export type { RpcRunStreamEvent } from "./run-replay-recovery.ts";
export {
	createRunReplayRecovery,
	type RunReplayEventDisposition,
	type RunReplayEventResult,
	type RunReplayGap,
	type RunReplayPageResult,
	type RunReplayReconnectResult,
	RunReplayRecovery,
	type RunReplayRecoveryOptions,
	type RunReplayRecoverySource,
	type RunReplayRecoveryState,
	type RunReplayRunSnapshotResult,
	type RunReplayTerminalConfirmation,
	type RunReplayTerminalConflict,
	type RunReplayTerminalStatus,
} from "./run-replay-recovery.ts";

export type RpcRunEventListener = (event: RpcRunStreamEvent) => void;

function isRpcRunStreamEvent(value: unknown): value is RpcRunStreamEvent {
	if (typeof value !== "object" || value === null) return false;
	const type = (value as { type?: unknown }).type;
	return (
		type === "run.started" ||
		type === "run.event" ||
		type === "run.completed" ||
		type === "run.failed" ||
		type === "run.cancelled"
	);
}

function isRpcTransportErrorCode(value: unknown): value is RpcTransportErrorCode {
	return (
		value === "rpc_transport_address_invalid" ||
		value === "rpc_transport_not_loopback" ||
		value === "rpc_transport_bind_failed" ||
		value === "rpc_transport_connection_busy" ||
		value === "rpc_transport_frame_too_large" ||
		value === "rpc_transport_closed" ||
		value === "rpc_transport_write_failed" ||
		value === "rpc_transport_invalid_json" ||
		value === "rpc_transport_invalid_command" ||
		value === "rpc_transport_dispatch_failed" ||
		value === "rpc_transport_connection_failed" ||
		value === "rpc_transport_listener_failed" ||
		value === "rpc_transport_close_failed"
	);
}

function isRpcTransportErrorRecord(value: unknown): value is RpcTransportErrorRecord {
	if (typeof value !== "object" || value === null) return false;
	const record = value as { type?: unknown; error?: unknown };
	if (record.type !== "error" || typeof record.error !== "object" || record.error === null) return false;
	const error = record.error as { code?: unknown; message?: unknown };
	return isRpcTransportErrorCode(error.code) && typeof error.message === "string";
}

/** Structured error thrown when an Automation Host command fails. */
export class AutomationRpcError extends Error {
	readonly code: AutomationErrorCode;
	readonly retryable: boolean;

	constructor(error: AutomationError) {
		super(error.message);
		this.name = "AutomationRpcError";
		this.code = error.code;
		this.retryable = error.retryable;
	}
}

/** Structured error thrown when an `mcp.auth.*` command fails. */
export class McpAuthRpcError extends Error {
	readonly code: RpcMcpAuthErrorCode;

	constructor(error: RpcMcpAuthError) {
		super(error.message);
		this.name = "McpAuthRpcError";
		this.code = error.code;
	}
}

/**
 * Callbacks that drive the one-shot interactive `mcp.auth.start` bridge.
 *
 * The host delivers the consent dialog, the manual-code dialog, and the
 * authorization URL through `extension_ui_request` records; the
 * {@link RpcClient.startMcpAuthInteractive} driver translates them into these
 * callbacks and answers the dialogs automatically. Every URL is delivered at
 * most once and never appears in any response, session event, receipt,
 * audit, error, or log, and never carries a token or raw URI.
 */
export interface RpcMcpAuthInteraction {
	/**
	 * One-shot authorization URL delivery; invoked at most once per start.
	 * The URL is the dedicated interactive result for this authorized client
	 * only.
	 */
	onAuthUrl?(url: string, instructions?: string): void;
	/** OAuth consent confirmation; resolve `false` to cancel the flow. */
	confirm?(message: string): boolean | Promise<boolean>;
	/**
	 * Manual authorization-code entry (https callback mode); resolve
	 * `undefined` to cancel.
	 */
	inputCode?(message: string, placeholder?: string): string | undefined | Promise<string | undefined>;
}

/** Options for {@link RpcClient.startMcpAuthInteractive}. */
export interface RpcMcpAuthInteractiveOptions {
	/** Fixed callback shape; defaults to `loopback`. */
	callbackMode?: "loopback" | "https";
	/** Fixed HTTPS redirect URI; required when `callbackMode` is `https`. */
	httpsCallbackUrl?: string;
	/** Bounded deadline for the interactive callback capture (ms). */
	timeoutMs?: number;
	/** Per-HTTP-request deadline for discovery/token calls (ms). */
	requestTimeoutMs?: number;
	/** Aborts the interactive start; pending dialogs resolve as cancelled. */
	signal?: AbortSignal;
}

/** Structured error thrown when an `mcp.resource.*` / `mcp.prompt.*` command fails. */
export class McpContentRpcError extends Error {
	readonly code: RpcMcpContentErrorCode;

	constructor(error: RpcMcpContentError) {
		super(error.message);
		this.name = "McpContentRpcError";
		this.code = error.code;
	}
}

// ============================================================================
// RPC Client
// ============================================================================

export class RpcClient {
	private process: ChildProcess | null = null;
	private socket: Socket | null = null;
	private inputStream: Writable | null = null;
	private tcpWriter: JsonlLineWriter | null = null;
	private stopReadingStdout: (() => void) | null = null;
	private tcpSocketEvents: {
		socket: Socket;
		onError: (error: Error) => void;
		onClose: () => void;
	} | null = null;
	private eventListeners: RpcEventListener[] = [];
	private runEventListeners: RpcRunEventListener[] = [];
	private extensionUIListeners: Array<(request: RpcExtensionUIRequest) => void> = [];
	private pendingRequests: Map<string, { resolve: (response: RpcResponse) => void; reject: (error: Error) => void }> =
		new Map();
	private requestId = 0;
	private stderr = "";
	private exitError: Error | null = null;
	private options: RpcClientOptions;

	constructor(options: RpcClientOptions = {}) {
		this.options = options;
	}

	/** Start the configured RPC transport. */
	async start(): Promise<void> {
		if (this.process || this.socket) {
			throw new Error("Client already started");
		}

		this.exitError = null;
		const tcpOptions = this.resolveTcpOptions();
		if (tcpOptions) {
			await this.startTcp(tcpOptions);
			return;
		}
		await this.startStdio();
	}

	private async startStdio(): Promise<void> {
		const cliPath = this.options.cliPath ?? "dist/cli.js";
		const args = ["--mode", "rpc"];

		if (this.options.provider) {
			args.push("--provider", this.options.provider);
		}
		if (this.options.model) {
			args.push("--model", this.options.model);
		}
		if (this.options.args) {
			args.push(...this.options.args);
		}

		const childProcess = spawn("node", [cliPath, ...args], {
			cwd: this.options.cwd,
			env: { ...process.env, ...this.options.env },
			stdio: ["pipe", "pipe", "pipe"],
		});
		this.process = childProcess;
		this.inputStream = childProcess.stdin;

		// Collect stderr for debugging
		childProcess.stderr?.on("data", (data) => {
			this.stderr += data.toString();
			process.stderr.write(data);
		});

		childProcess.once("exit", (code, signal) => {
			if (this.process !== childProcess) return;
			const error = this.createProcessExitError(code, signal);
			this.exitError = error;
			this.rejectPendingRequests(error);
		});
		childProcess.once("error", (error) => {
			if (this.process !== childProcess) return;
			const processError = new Error(`Agent process error: ${error.message}. Stderr: ${this.stderr}`);
			this.exitError = processError;
			this.rejectPendingRequests(processError);
		});
		childProcess.stdin?.on("error", (error) => {
			if (this.process !== childProcess) return;
			const stdinError =
				this.exitError ?? new Error(`Agent process stdin error: ${error.message}. Stderr: ${this.stderr}`);
			this.exitError = stdinError;
			this.rejectPendingRequests(stdinError);
		});

		// Set up strict JSONL reader for stdout.
		this.stopReadingStdout = attachJsonlLineReader(childProcess.stdout!, (line) => {
			this.handleLine(line);
		});

		// Wait a moment for process to initialize
		await new Promise((resolve) => setTimeout(resolve, 100));

		if (this.process.exitCode !== null) {
			const error = this.exitError ?? this.createProcessExitError(this.process.exitCode, this.process.signalCode);
			this.exitError = error;
			throw error;
		}
	}

	private async startTcp(options: NormalizedRpcClientTcpOptions): Promise<void> {
		const socket = createConnection({ host: options.host, port: options.port });
		this.socket = socket;
		this.inputStream = socket;
		this.tcpWriter = createJsonlLineWriter(socket, {
			maxFrameBytes: DEFAULT_MAX_JSONL_FRAME_BYTES,
			onError: (error) =>
				this.handleTcpSocketError(socket, toRpcTransportError(error, "rpc_transport_write_failed")),
		});
		this.attachTcpSocketEvents(socket);
		this.stopReadingStdout = attachJsonlLineReader(
			socket,
			(line) => {
				this.handleLine(line);
			},
			{
				maxFrameBytes: DEFAULT_MAX_JSONL_FRAME_BYTES,
				onError: (error) =>
					this.handleTcpSocketError(socket, toRpcTransportError(error, "rpc_transport_connection_failed")),
			},
		);

		try {
			await this.waitForTcpConnection(socket, options.connectTimeoutMs);
		} catch (error: unknown) {
			const connectionError = this.exitError ?? toRpcTransportError(error, "rpc_transport_connection_failed");
			this.exitError = connectionError;
			this.rejectPendingRequests(connectionError);
			this.stopReadingStdout?.();
			this.stopReadingStdout = null;
			await this.destroyTcpSocket(socket);
			if (this.socket === socket) {
				this.detachTcpSocketEvents(socket);
				this.socket = null;
				this.inputStream = null;
				this.tcpWriter?.detach();
				this.tcpWriter = null;
			}
			throw connectionError;
		}
	}

	/** Stop and close the configured RPC transport. */
	async stop(): Promise<void> {
		if (this.socket) {
			await this.stopTcp(this.socket);
			return;
		}
		if (!this.process) return;

		this.rejectPendingRequests(new Error("RPC client stopped"));
		this.stopReadingStdout?.();
		this.stopReadingStdout = null;
		this.inputStream = null;
		this.process.kill("SIGTERM");

		// Wait for process to exit
		await new Promise<void>((resolve) => {
			const timeout = setTimeout(() => {
				this.process?.kill("SIGKILL");
				resolve();
			}, 1000);

			this.process?.on("exit", () => {
				clearTimeout(timeout);
				resolve();
			});
		});

		this.process = null;
	}

	/** Close the active RPC transport. This is an alias for stop(). */
	async close(): Promise<void> {
		await this.stop();
	}

	/**
	 * Subscribe to agent events.
	 */
	onEvent(listener: RpcEventListener): () => void {
		this.eventListeners.push(listener);
		return () => {
			const index = this.eventListeners.indexOf(listener);
			if (index !== -1) {
				this.eventListeners.splice(index, 1);
			}
		};
	}

	/**
	 * Subscribe to Automation Host run stream events.
	 * Receives only run.started / run.event / run.completed / run.failed / run.cancelled records.
	 */
	onRunEvent(listener: RpcRunEventListener): () => void {
		this.runEventListeners.push(listener);
		return () => {
			const index = this.runEventListeners.indexOf(listener);
			if (index !== -1) {
				this.runEventListeners.splice(index, 1);
			}
		};
	}

	/**
	 * Subscribe to extension UI request records (dialogs, notifications, and
	 * the one-shot MCP OAuth `auth_url` delivery). While subscribers exist,
	 * `extension_ui_request` records are routed here instead of the generic
	 * session event listeners; answer dialog requests with
	 * {@link sendExtensionUIResponse}.
	 */
	onExtensionUIRequest(listener: (request: RpcExtensionUIRequest) => void): () => void {
		this.extensionUIListeners.push(listener);
		return () => {
			const index = this.extensionUIListeners.indexOf(listener);
			if (index !== -1) {
				this.extensionUIListeners.splice(index, 1);
			}
		};
	}

	/**
	 * Send an `extension_ui_response` for a pending extension UI dialog
	 * request. Fire-and-forget from the client's perspective: the record is
	 * written to the transport and the promise resolves once the write
	 * completes; the host correlates it by `id`.
	 */
	async sendExtensionUIResponse(response: RpcExtensionUIResponse): Promise<void> {
		await this.writeRecord(response);
	}

	/**
	 * Get collected stderr output (useful for debugging).
	 */
	getStderr(): string {
		return this.stderr;
	}

	// =========================================================================
	// Command Methods
	// =========================================================================

	/**
	 * Send a prompt to the agent.
	 * Returns immediately after sending; use onEvent() to receive streaming events.
	 * Use waitForIdle() to wait for completion.
	 */
	async prompt(message: string, images?: ImageContent[]): Promise<void> {
		await this.send({ type: "prompt", message, images });
	}

	/**
	 * Queue a steering message to interrupt the agent mid-run.
	 */
	async steer(message: string, images?: ImageContent[]): Promise<void> {
		await this.send({ type: "steer", message, images });
	}

	/**
	 * Queue a follow-up message to be processed after the agent finishes.
	 */
	async followUp(message: string, images?: ImageContent[]): Promise<void> {
		await this.send({ type: "follow_up", message, images });
	}

	/**
	 * Abort current operation.
	 */
	async abort(): Promise<void> {
		await this.send({ type: "abort" });
	}

	/**
	 * Start a new session, optionally with parent tracking.
	 * @param parentSession - Optional parent session path for lineage tracking
	 * @returns Object with `cancelled: true` if an extension cancelled the new session
	 */
	async newSession(parentSession?: string): Promise<{ cancelled: boolean }> {
		const response = await this.send({ type: "new_session", parentSession });
		return this.getData(response);
	}

	/**
	 * Get current session state.
	 */
	async getState(): Promise<RpcSessionState> {
		const response = await this.send({ type: "get_state" });
		return this.getData(response);
	}

	/**
	 * Set model by provider and ID.
	 */
	async setModel(provider: string, modelId: string): Promise<{ provider: string; id: string }> {
		const response = await this.send({ type: "set_model", provider, modelId });
		return this.getData(response);
	}

	/**
	 * Cycle to next model.
	 */
	async cycleModel(): Promise<{
		model: { provider: string; id: string };
		thinkingLevel: ThinkingLevel;
		isScoped: boolean;
	} | null> {
		const response = await this.send({ type: "cycle_model" });
		return this.getData(response);
	}

	/**
	 * Get list of available models.
	 */
	async getAvailableModels(): Promise<ModelInfo[]> {
		const response = await this.send({ type: "get_available_models" });
		return this.getData<{ models: ModelInfo[] }>(response).models;
	}

	/**
	 * Set thinking level.
	 */
	async setThinkingLevel(level: ThinkingLevel): Promise<void> {
		await this.send({ type: "set_thinking_level", level });
	}

	/**
	 * Cycle thinking level.
	 */
	async cycleThinkingLevel(): Promise<{ level: ThinkingLevel } | null> {
		const response = await this.send({ type: "cycle_thinking_level" });
		return this.getData(response);
	}

	/**
	 * Get list of available thinking levels for the current model.
	 */
	async getAvailableThinkingLevels(): Promise<ThinkingLevel[]> {
		const response = await this.send({ type: "get_available_thinking_levels" });
		return this.getData<{ levels: ThinkingLevel[] }>(response).levels;
	}

	/**
	 * Set steering mode.
	 */
	async setSteeringMode(mode: "all" | "one-at-a-time"): Promise<void> {
		await this.send({ type: "set_steering_mode", mode });
	}

	/**
	 * Set follow-up mode.
	 */
	async setFollowUpMode(mode: "all" | "one-at-a-time"): Promise<void> {
		await this.send({ type: "set_follow_up_mode", mode });
	}

	/**
	 * Compact session context.
	 */
	async compact(customInstructions?: string): Promise<CompactionResult> {
		const response = await this.send({ type: "compact", customInstructions });
		return this.getData(response);
	}

	/**
	 * Set auto-compaction enabled/disabled.
	 */
	async setAutoCompaction(enabled: boolean): Promise<void> {
		await this.send({ type: "set_auto_compaction", enabled });
	}

	/**
	 * Set auto-retry enabled/disabled.
	 */
	async setAutoRetry(enabled: boolean): Promise<void> {
		await this.send({ type: "set_auto_retry", enabled });
	}

	/**
	 * Abort in-progress retry.
	 */
	async abortRetry(): Promise<void> {
		await this.send({ type: "abort_retry" });
	}

	/**
	 * Execute a bash command.
	 */
	async bash(command: string): Promise<BashResult> {
		const response = await this.send({ type: "bash", command });
		return this.getData(response);
	}

	/**
	 * Abort running bash command.
	 */
	async abortBash(): Promise<void> {
		await this.send({ type: "abort_bash" });
	}

	/**
	 * Get session statistics.
	 */
	async getSessionStats(): Promise<RpcSessionStats> {
		const response = await this.send({ type: "get_session_stats" });
		return this.getData(response);
	}

	/**
	 * Export session to HTML.
	 */
	async exportHtml(outputPath?: string): Promise<{ path: string }> {
		const response = await this.send({ type: "export_html", outputPath });
		return this.getData(response);
	}

	/**
	 * Switch to a different session file.
	 * @returns Object with `cancelled: true` if an extension cancelled the switch
	 */
	async switchSession(sessionPath: string): Promise<{ cancelled: boolean }> {
		const response = await this.send({ type: "switch_session", sessionPath });
		return this.getData(response);
	}

	/**
	 * Fork from a specific message.
	 * @returns Object with `text` (the message text) and `cancelled` (if extension cancelled)
	 */
	async fork(entryId: string): Promise<{ text: string; cancelled: boolean }> {
		const response = await this.send({ type: "fork", entryId });
		return this.getData(response);
	}

	/**
	 * Clone the current active branch into a new session.
	 * @returns Object with `cancelled: true` if an extension cancelled the clone
	 */
	async clone(): Promise<{ cancelled: boolean }> {
		const response = await this.send({ type: "clone" });
		return this.getData(response);
	}

	/**
	 * Get messages available for forking.
	 */
	async getForkMessages(): Promise<Array<{ entryId: string; text: string }>> {
		const response = await this.send({ type: "get_fork_messages" });
		return this.getData<{ messages: Array<{ entryId: string; text: string }> }>(response).messages;
	}

	/**
	 * Get session entries in append order, optionally only those after the `since` entry id.
	 */
	async getEntries(since?: string): Promise<{ entries: PublicSessionEntry[]; leafId: string | null }> {
		const response = await this.send({ type: "get_entries", since });
		return this.getData<{ entries: PublicSessionEntry[]; leafId: string | null }>(response);
	}

	/**
	 * Get the session entry tree.
	 */
	async getTree(): Promise<{ tree: PublicSessionTreeNode[]; leafId: string | null }> {
		const response = await this.send({ type: "get_tree" });
		return this.getData<{ tree: PublicSessionTreeNode[]; leafId: string | null }>(response);
	}

	/**
	 * Get text of last assistant message.
	 */
	async getLastAssistantText(): Promise<string | null> {
		const response = await this.send({ type: "get_last_assistant_text" });
		return this.getData<{ text: string | null }>(response).text;
	}

	/**
	 * Set the session display name.
	 */
	async setSessionName(name: string): Promise<void> {
		await this.send({ type: "set_session_name", name });
	}

	/**
	 * Get all messages in the session.
	 */
	async getMessages(): Promise<AgentMessage[]> {
		const response = await this.send({ type: "get_messages" });
		return this.getData<{ messages: AgentMessage[] }>(response).messages;
	}

	/**
	 * Get available commands (extension commands, prompt templates, skills).
	 */
	async getCommands(): Promise<RpcSlashCommand[]> {
		const response = await this.send({ type: "get_commands" });
		return this.getData<{ commands: RpcSlashCommand[] }>(response).commands;
	}

	/**
	 * Read-only Context Engine inspection. Returns metadata-only snapshot data
	 * (no project rules, session text, memory bodies, tool output, or credentials).
	 * Available without Automation Host initialize.
	 */
	async getContext(snapshotId?: string): Promise<GetContextData> {
		const response = await this.send({ type: "get_context", snapshotId });
		return this.getData(response);
	}

	// =========================================================================
	// Automation Host (protocolVersion 1)
	// =========================================================================

	/**
	 * Initialize the Automation Host protocol (protocolVersion 1). Must be called
	 * before startRun()/getRun()/cancelRun()/resumeRun(). Resolves with the
	 * advertised host contract.
	 */
	async initializeAutomationHost(): Promise<InitializeData> {
		const response = await this.sendAutomation({ type: "initialize", protocolVersion: 1 });
		return this.getAutomationData<InitializeData>(response);
	}

	/**
	 * Start a new automation run. Emits run.started/run.event/terminal records on
	 * the run event stream (see onRunEvent()).
	 * @param capabilityProfile - Optional named capability profile; defaults to the
	 * session's configured default profile. The Automation Host fails the run when
	 * the profile is unknown or would require an ask approval.
	 * @param policyProfile - Optional named Execution Policy profile selector.
	 * @param externalConnector - Optional explicit trusted External Connector
	 * selection. When present the Run is executed by the connector instead of
	 * the local model loop. Safe immutable identity only; no URL/command/header/credential
	 * data ever crosses the RPC boundary.
	 * @param artifacts - Optional canonical artifact references for Connector input.
	 */
	async startRun(
		message: string,
		images?: ImageContent[],
		capabilityProfile?: string,
		modelRoute?: ModelRouteSelection,
		modelRole?: ModelRoleSelection,
		policyProfile?: string,
		clientRequestId?: string,
		deadlineAt?: string,
		externalConnector?: ExternalConnectorSelection,
		artifacts?: readonly CanonicalExternalAgentArtifactReference[],
	): Promise<RunAcceptedData> {
		const response = await this.sendAutomation({
			type: "run.start",
			message,
			images,
			...(capabilityProfile !== undefined ? { capabilityProfile } : {}),
			...(policyProfile !== undefined ? { policyProfile } : {}),
			...(modelRoute !== undefined ? { modelRoute } : {}),
			...(modelRole !== undefined ? { modelRole } : {}),
			...(externalConnector !== undefined ? { externalConnector } : {}),
			...(artifacts !== undefined ? { artifacts } : {}),
			...(clientRequestId !== undefined ? { clientRequestId } : {}),
			...(deadlineAt !== undefined ? { deadlineAt } : {}),
		});
		return this.getAutomationData<RunAcceptedData>(response);
	}

	/**
	 * Get the current ledger state of a run.
	 */
	async getRun(runId: string): Promise<RunGetData> {
		const response = await this.sendAutomation({ type: "run.get", runId });
		return this.getAutomationData<RunGetData>(response);
	}

	/**
	 * Cancel an active run. Resolves with the run id and the immediate status
	 * (normally "running"); the terminal run.cancelled record arrives later on the
	 * run event stream.
	 */
	async cancelRun(runId: string): Promise<RunCancelData> {
		const response = await this.sendAutomation({ type: "run.cancel", runId });
		return this.getAutomationData<RunCancelData>(response);
	}

	/**
	 * Resume a source run in the restored session as a new attempt.
	 * @param capabilityProfile - Optional named capability profile for the new
	 * attempt's successor binding; defaults to the session's default profile.
	 * @param policyProfile - Optional named Execution Policy profile selector for
	 * the new attempt's successor binding.
	 * @param externalConnector - Optional explicit trusted External Connector
	 * selection. Resume is executed only when the selected connector advertised
	 * and implements the canonical resume capability.
	 * @param artifacts - Optional canonical artifact references for Connector input.
	 */
	async resumeRun(
		sessionPath: string,
		sourceRunId: string,
		message: string,
		images?: ImageContent[],
		capabilityProfile?: string,
		modelRoute?: ModelRouteSelection,
		modelRole?: ModelRoleSelection,
		policyProfile?: string,
		clientRequestId?: string,
		deadlineAt?: string,
		externalConnector?: ExternalConnectorSelection,
		artifacts?: readonly CanonicalExternalAgentArtifactReference[],
	): Promise<RunAcceptedData> {
		const response = await this.sendAutomation({
			type: "run.resume",
			sessionPath,
			sourceRunId,
			message,
			images,
			...(capabilityProfile !== undefined ? { capabilityProfile } : {}),
			...(policyProfile !== undefined ? { policyProfile } : {}),
			...(modelRoute !== undefined ? { modelRoute } : {}),
			...(modelRole !== undefined ? { modelRole } : {}),
			...(externalConnector !== undefined ? { externalConnector } : {}),
			...(artifacts !== undefined ? { artifacts } : {}),
			...(clientRequestId !== undefined ? { clientRequestId } : {}),
			...(deadlineAt !== undefined ? { deadlineAt } : {}),
		});
		return this.getAutomationData<RunAcceptedData>(response);
	}

	/**
	 * Read-only capability inspection. Returns redacted metadata only: the redacted
	 * catalog of discovered capability descriptors, the current frozen binding
	 * (when one is resolved), and the binding history folded from the Session
	 * ledger. The catalog carries only each descriptor's id, kind, name, redacted
	 * source (`{ source, scope, origin }`), revision, availability, decision,
	 * trusted, and the public exposed tool name / parent id / mcp server id. Never
	 * file paths, raw MCP server config, env or header values, URL credentials or
	 * query, tokens, server instructions/resources/prompts, or tool call payloads.
	 * Available without Automation Host initialize.
	 * @param bindingId - Optional binding id; when given, only that binding's view
	 * is returned and an unknown id rejects with a plain Error.
	 */
	async getCapabilities(bindingId?: string): Promise<GetCapabilitiesData> {
		const response = await this.send({
			type: "get_capabilities",
			...(bindingId !== undefined ? { bindingId } : {}),
		});
		return this.getData(response);
	}

	/** Read-only Execution Policy inspection. Returns safe metadata only. */
	async getExecutionPolicy(): Promise<GetExecutionPolicyData> {
		const response = await this.send({ type: "get_execution_policy" });
		return this.getData(response);
	}

	/** Approve a pending Execution Policy request for this session only. */
	async approvePolicy(requestId: string): Promise<void> {
		await this.send({ type: "policy.approve", requestId });
	}

	/** Reject a pending Execution Policy request for this session only. */
	async rejectPolicy(requestId: string): Promise<void> {
		await this.send({ type: "policy.reject", requestId });
	}

	/** Read the redacted ModelBroker route/role catalog. */
	async getModelRoutes(): Promise<GetModelRoutesData> {
		const response = await this.send({ type: "get_model_routes" });
		return this.getData(response);
	}

	// =========================================================================
	// MCP content (resource/prompt)
	// =========================================================================

	/**
	 * List one page of the resources catalog of a selected, trusted server.
	 * Never starts a Run or a model. Pass the previous page's `nextCursor` as
	 * `cursor` to fetch the next page. Responses carry digest metadata only:
	 * the raw URI never leaves the request.
	 * @param signal - Optional caller cancellation; the pending request rejects
	 * when the signal aborts.
	 */
	async listMcpResources(
		serverId: string,
		params?: { cursor?: string },
		signal?: AbortSignal,
	): Promise<MCPResourceListResult> {
		const response = await this.send(
			{
				type: "mcp.resource.list",
				serverId,
				...(params?.cursor === undefined ? {} : { cursor: params.cursor }),
			},
			signal,
		);
		return this.getMcpContentData<MCPResourceListResult>(response);
	}

	/**
	 * List one page of the resource templates catalog of a selected, trusted
	 * server. Never starts a Run or a model. Responses carry digest ids and a
	 * sanitized display pattern only; the raw URI template never leaves the
	 * request.
	 * @param signal - Optional caller cancellation; the pending request rejects
	 * when the signal aborts.
	 */
	async listMcpResourceTemplates(
		serverId: string,
		params?: { cursor?: string },
		signal?: AbortSignal,
	): Promise<MCPResourceTemplateListResult> {
		const response = await this.send(
			{
				type: "mcp.resource.templates.list",
				serverId,
				...(params?.cursor === undefined ? {} : { cursor: params.cursor }),
			},
			signal,
		);
		return this.getMcpContentData<MCPResourceTemplateListResult>(response);
	}

	/**
	 * Read one resource of a selected, trusted server. The raw URI is used
	 * once and never echoed: the response is a redacted receipt with digest
	 * and metadata only (no remote text). Never starts a Run or a model.
	 */
	async readMcpResource(serverId: string, uri: string, signal?: AbortSignal): Promise<RpcMcpReadResourceReceipt> {
		const response = await this.send({ type: "mcp.resource.read", serverId, uri }, signal);
		return this.getMcpContentData<RpcMcpReadResourceReceipt>(response);
	}

	/**
	 * Explicitly read a resource and register the normalized result as a
	 * structured external attachment in the Session. The response is a
	 * redacted receipt (metadata and digests only); the raw URI and remote
	 * text never cross the wire. Re-attaching the same content is idempotent
	 * (same digest id). Never starts a Run or a model.
	 */
	async attachMcpResource(serverId: string, uri: string, signal?: AbortSignal): Promise<RpcMcpAttachmentReceipt> {
		const response = await this.send({ type: "mcp.resource.attach", serverId, uri }, signal);
		return this.getMcpContentData<RpcMcpAttachmentReceipt>(response);
	}

	/**
	 * List one page of the prompts catalog of a selected, trusted server.
	 * Never starts a Run or a model. Responses carry digest metadata only.
	 */
	async listMcpPrompts(
		serverId: string,
		params?: { cursor?: string },
		signal?: AbortSignal,
	): Promise<MCPPromptListResult> {
		const response = await this.send(
			{
				type: "mcp.prompt.list",
				serverId,
				...(params?.cursor === undefined ? {} : { cursor: params.cursor }),
			},
			signal,
		);
		return this.getMcpContentData<MCPPromptListResult>(response);
	}

	/**
	 * Get one prompt of a selected, trusted server. The name and argument
	 * values are used once and never echoed: the response is a redacted
	 * receipt with digest and metadata only (no remote text). Never starts a
	 * Run or a model.
	 */
	async getMcpPrompt(
		serverId: string,
		name: string,
		args?: Record<string, string>,
		signal?: AbortSignal,
	): Promise<RpcMcpGetPromptReceipt> {
		const response = await this.send({ type: "mcp.prompt.get", serverId, name, args }, signal);
		return this.getMcpContentData<RpcMcpGetPromptReceipt>(response);
	}

	/**
	 * Explicitly get a prompt and register the normalized result as a
	 * structured external attachment in the Session. The response is a
	 * redacted receipt; the prompt name, argument values, and remote text
	 * never cross the wire. Re-attaching the same content is idempotent.
	 * Never starts a Run or a model.
	 */
	async attachMcpPrompt(
		serverId: string,
		name: string,
		args?: Record<string, string>,
		signal?: AbortSignal,
	): Promise<RpcMcpAttachmentReceipt> {
		const response = await this.send({ type: "mcp.prompt.attach", serverId, name, args }, signal);
		return this.getMcpContentData<RpcMcpAttachmentReceipt>(response);
	}

	// =========================================================================
	// MCP OAuth (mcp.auth.*)
	// =========================================================================

	/**
	 * Start MCP OAuth authorization for one streamable-http server in
	 * headless mode. Without a declared interaction bridge the host fails
	 * closed immediately with the fixed `mcp_auth_interaction_required`
	 * error: no browser is opened and nothing waits for input. Use
	 * {@link startMcpAuthInteractive} to drive the flow through the
	 * extension-UI bridge. Never starts a Run or a model.
	 */
	async startMcpAuth(serverId: string, serverUrl: string, signal?: AbortSignal): Promise<RpcMcpAuthStartData> {
		const response = await this.send({ type: "mcp.auth.start", serverId, serverUrl }, signal);
		return this.getMcpAuthData<RpcMcpAuthStartData>(response);
	}

	/** PR/SDK alias of {@link startMcpAuth}. */
	async startMcpOAuth(serverId: string, serverUrl: string, signal?: AbortSignal): Promise<RpcMcpAuthStartData> {
		return this.startMcpAuth(serverId, serverUrl, signal);
	}

	/**
	 * Start MCP OAuth authorization for one streamable-http server through
	 * the interactive extension-UI bridge.
	 *
	 * The caller declares `interactive` by using this method; without it the
	 * host fails closed with `mcp_auth_interaction_required`. The driver:
	 * - answers the host's consent `confirm` dialog through
	 *   {@link RpcMcpAuthInteraction.confirm} (false cancels);
	 * - answers the `input` dialog for manual authorization codes (https
	 *   callback mode) through {@link RpcMcpAuthInteraction.inputCode}
	 *   (undefined cancels);
	 * - delivers the one-shot authorization URL at most once through
	 *   {@link RpcMcpAuthInteraction.onAuthUrl}; the URL never appears in the
	 *   returned data, session events, receipts, audit, errors, or logs, and
	 *   never carries a token or raw URI;
	 * - cancels any unknown dialog fail-closed instead of echoing input.
	 *
	 * Resolves with the terminal status only. Rejects with
	 * {@link McpAuthRpcError} on failure (cancel, timeout, abort, or host
	 * detach/shutdown), using the stable PR error codes.
	 */
	async startMcpAuthInteractive(
		serverId: string,
		serverUrl: string,
		interaction: RpcMcpAuthInteraction = {},
		options: RpcMcpAuthInteractiveOptions = {},
	): Promise<RpcMcpAuthStartData> {
		const flowTimeoutMs = options.timeoutMs ?? MCP_OAUTH_DEFAULT_TIMEOUT_MS;
		// The host bounds the whole flow by `flowTimeoutMs`; the response wait
		// must outlast it so a flow that completes right at its deadline is not
		// cut off by the client's own response timeout.
		const sendTimeoutMs = flowTimeoutMs + 10_000;
		let deliveredAuthUrl = false;
		let settled = false;
		// Dialog request ids still waiting for an answer. On abort every one of
		// them is answered `cancelled` so the host flow fails closed promptly
		// instead of hanging until its own timeout.
		const pendingDialogIds = new Set<string>();
		const cancelPendingDialogs = (): void => {
			for (const id of pendingDialogIds) {
				void this.sendExtensionUIResponse({ type: "extension_ui_response", id, cancelled: true }).catch(
					() => undefined,
				);
			}
			pendingDialogIds.clear();
		};
		const onAbort = (): void => {
			cancelPendingDialogs();
		};
		options.signal?.addEventListener("abort", onAbort, { once: true });
		const unsubscribe = this.onExtensionUIRequest((request) => {
			// After the start settled (response, failure, or abort) no further
			// dialog answers or URL deliveries happen.
			if (settled) return;
			if (request.method === "auth_url") {
				if (!deliveredAuthUrl) {
					deliveredAuthUrl = true;
					try {
						interaction.onAuthUrl?.(request.url, request.instructions);
					} catch {
						// A failing consumer callback never breaks or leaks the
						// flow: the start continues and settles on its own.
					}
				}
				return;
			}
			if (request.method === "confirm") {
				pendingDialogIds.add(request.id);
				void this.answerConfirmDialog(request, interaction, pendingDialogIds).catch(() => undefined);
				return;
			}
			if (request.method === "input") {
				pendingDialogIds.add(request.id);
				void this.answerInputDialog(request, interaction, pendingDialogIds).catch(() => undefined);
				return;
			}
			// Unknown dialog methods fail closed: cancel instead of echoing
			// input or blocking the host.
			void this.sendExtensionUIResponse({ type: "extension_ui_response", id: request.id, cancelled: true }).catch(
				() => undefined,
			);
		});
		try {
			const response = await this.send(
				{
					type: "mcp.auth.start",
					serverId,
					serverUrl,
					interactive: true,
					...(options.callbackMode !== undefined ? { callbackMode: options.callbackMode } : {}),
					...(options.httpsCallbackUrl !== undefined ? { httpsCallbackUrl: options.httpsCallbackUrl } : {}),
					...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
					...(options.requestTimeoutMs !== undefined ? { requestTimeoutMs: options.requestTimeoutMs } : {}),
				},
				options.signal,
				sendTimeoutMs,
			);
			return this.getMcpAuthData<RpcMcpAuthStartData>(response);
		} finally {
			settled = true;
			options.signal?.removeEventListener("abort", onAbort);
			cancelPendingDialogs();
			unsubscribe();
		}
	}

	private async answerConfirmDialog(
		request: Extract<RpcExtensionUIRequest, { method: "confirm" }>,
		interaction: RpcMcpAuthInteraction,
		pendingDialogIds: Set<string>,
	): Promise<void> {
		// Fail closed: without a confirm callback (or when the callback
		// rejects) the consent is never granted.
		let answer: boolean;
		try {
			answer = (await interaction.confirm?.(request.message ?? request.title)) ?? false;
		} catch {
			answer = false;
		}
		pendingDialogIds.delete(request.id);
		await this.sendExtensionUIResponse({ type: "extension_ui_response", id: request.id, confirmed: answer });
	}

	private async answerInputDialog(
		request: Extract<RpcExtensionUIRequest, { method: "input" }>,
		interaction: RpcMcpAuthInteraction,
		pendingDialogIds: Set<string>,
	): Promise<void> {
		// Fail closed: without an inputCode callback (or when the callback
		// rejects) the manual-code dialog is cancelled.
		let code: string | undefined;
		try {
			code = await interaction.inputCode?.(request.title, request.placeholder);
		} catch {
			code = undefined;
		}
		pendingDialogIds.delete(request.id);
		if (code === undefined) {
			await this.sendExtensionUIResponse({ type: "extension_ui_response", id: request.id, cancelled: true });
			return;
		}
		await this.sendExtensionUIResponse({ type: "extension_ui_response", id: request.id, value: code });
	}

	/**
	 * Masked MCP OAuth status for one streamable-http server. Resolves
	 * `{ status: "required" }` when no credential is stored and
	 * `{ status: "authorized", credential }` with masked metadata otherwise.
	 * The response never contains tokens, the server URL, issuer/resource, or
	 * raw URIs.
	 */
	async getMcpAuthStatus(serverId: string, serverUrl: string, signal?: AbortSignal): Promise<RpcMcpAuthStatusData> {
		const response = await this.send({ type: "mcp.auth.status", serverId, serverUrl }, signal);
		return this.getMcpAuthData<RpcMcpAuthStatusData>(response);
	}

	/** Masked status of every stored MCP credential in this session's namespace. */
	async listMcpAuthCredentials(signal?: AbortSignal): Promise<readonly RpcMcpMaskedCredential[]> {
		const response = await this.send({ type: "mcp.auth.list" }, signal);
		return this.getMcpAuthData<RpcMcpAuthListData>(response).credentials;
	}

	/**
	 * Logout one MCP server: best-effort revocation and local deletion of the
	 * namespaced credential. `serverUrl` (the canonical streamable-http URL)
	 * lets a fresh session delete a previously stored credential without
	 * having resolved a provider for the server.
	 */
	async logoutMcpAuth(serverId: string, serverUrl?: string, signal?: AbortSignal): Promise<void> {
		const response = await this.send(
			{ type: "mcp.auth.logout", serverId, ...(serverUrl !== undefined ? { serverUrl } : {}) },
			signal,
		);
		this.getMcpAuthData<void>(response);
	}

	/** PR/SDK alias of {@link logoutMcpAuth}. */
	async logoutMcp(serverId: string, serverUrl?: string, signal?: AbortSignal): Promise<void> {
		return this.logoutMcpAuth(serverId, serverUrl, signal);
	}

	/** Read a safe, filtered execution-audit page. */
	async auditQuery(query: AuditQuery): Promise<AuditQueryResult> {
		const response = await this.sendAutomation({ type: "audit.query", ...query });
		return this.getAutomationData<AuditQueryResult>(response);
	}

	/** Alias for auditQuery for callers that prefer verb-first naming. */
	async queryAudit(query: AuditQuery): Promise<AuditQueryResult> {
		return this.auditQuery(query);
	}

	/** Replay one run from the safe audit ledger, optionally with query filters. */
	async auditReplay(
		query: AuditReplayQuery | string,
		options: Omit<AuditReplayQuery, "runId"> = {},
	): Promise<AuditReplayResult> {
		const request: AuditReplayQuery = typeof query === "string" ? { ...options, runId: query } : query;
		const response = await this.sendAutomation({ type: "audit.replay", ...request });
		return this.getAutomationData<AuditReplayResult>(response);
	}

	/** Alias for auditReplay for callers that prefer verb-first naming. */
	async replayAudit(
		query: AuditReplayQuery | string,
		options: Omit<AuditReplayQuery, "runId"> = {},
	): Promise<AuditReplayResult> {
		return this.auditReplay(query, options);
	}

	/**
	 * Create a read-only run reconnect/replay consumer. Its live sequence
	 * watermark and audit cursor are independent checkpoints; use
	 * consumeRunEvent() for stream records and reconnect() for durable replay.
	 */
	createRunReplayRecovery(
		runId: string,
		options: Omit<RunReplayRecoveryOptions, "runId" | "source"> = {},
	): RunReplayRecovery {
		return new RunReplayRecovery({
			...options,
			runId,
			source: {
				getRun: (id) => this.getRun(id),
				auditReplay: (query) => this.auditReplay(query),
			},
		});
	}

	/** Reconcile one run and consume its read-only audit replay pages. */
	async reconnectRun(
		runId: string,
		options: Omit<RunReplayRecoveryOptions, "runId" | "source"> = {},
	): Promise<RunReplayReconnectResult> {
		return this.createRunReplayRecovery(runId, options).reconnect();
	}

	// =========================================================================
	// Helpers
	// =========================================================================

	/**
	 * Wait for agent to become idle (no streaming).
	 * Resolves when agent_settled event is received.
	 */
	waitForIdle(timeout = 60000): Promise<void> {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				unsubscribe();
				reject(new Error(`Timeout waiting for agent to become idle. Stderr: ${this.stderr}`));
			}, timeout);

			const unsubscribe = this.onEvent((event) => {
				if (event.type === "agent_settled") {
					clearTimeout(timer);
					unsubscribe();
					resolve();
				}
			});
		});
	}

	/**
	 * Collect events until agent becomes idle.
	 */
	collectEvents(timeout = 60000): Promise<JsonAgentSessionEvent[]> {
		return new Promise((resolve, reject) => {
			const events: JsonAgentSessionEvent[] = [];
			const timer = setTimeout(() => {
				unsubscribe();
				reject(new Error(`Timeout collecting events. Stderr: ${this.stderr}`));
			}, timeout);

			const unsubscribe = this.onEvent((event) => {
				events.push(event);
				if (event.type === "agent_settled") {
					clearTimeout(timer);
					unsubscribe();
					resolve(events);
				}
			});
		});
	}

	/**
	 * Send prompt and wait for completion, returning all events.
	 */
	async promptAndWait(message: string, images?: ImageContent[], timeout = 60000): Promise<JsonAgentSessionEvent[]> {
		const eventsPromise = this.collectEvents(timeout);
		await this.prompt(message, images);
		return eventsPromise;
	}

	// =========================================================================
	// Internal
	// =========================================================================

	private handleLine(line: string): void {
		try {
			const data: unknown = JSON.parse(line);
			const record =
				typeof data === "object" && data !== null ? (data as { type?: unknown; id?: unknown }) : undefined;

			// Transport errors are connection-level failures, not legacy session
			// events. Reject every request waiting on this connection and stop here so
			// the record cannot be delivered to either event listener collection.
			if (isRpcTransportErrorRecord(data)) {
				const transportError = new RpcTransportError(data.error.code, data.error.message);
				if (this.socket !== null) this.handleTcpSocketError(this.socket, transportError);
				else this.rejectPendingRequests(transportError);
				return;
			}
			if (typeof data === "object" && data !== null && (data as { type?: unknown }).type === "error") {
				const transportError = new RpcTransportError(
					"rpc_transport_connection_failed",
					"RPC transport returned an invalid error record",
				);
				if (this.socket !== null) this.handleTcpSocketError(this.socket, transportError);
				else this.rejectPendingRequests(transportError);
				return;
			}

			// Check if it's a response to a pending request
			if (record?.type === "response" && typeof record.id === "string" && this.pendingRequests.has(record.id)) {
				const pending = this.pendingRequests.get(record.id)!;
				this.pendingRequests.delete(record.id);
				pending.resolve(data as RpcResponse);
				return;
			}

			// Route Automation Host run stream records to run listeners and legacy
			// Session JSON events to event listeners, so onEvent never sees run.*
			// records and onRunEvent never sees session events.
			if (isRpcRunStreamEvent(data)) {
				for (const listener of this.runEventListeners) {
					listener(data as RpcRunStreamEvent);
				}
				return;
			}

			// Extension UI request records go to the dedicated listeners while
			// any are subscribed (dialog drivers); otherwise they fall through to
			// the generic session event listeners for backward compatibility.
			if (record?.type === "extension_ui_request") {
				if (this.extensionUIListeners.length > 0) {
					for (const listener of this.extensionUIListeners) {
						listener(record as RpcExtensionUIRequest);
					}
					return;
				}
			}

			// Otherwise it's a legacy session event
			for (const listener of this.eventListeners) {
				listener(data as JsonAgentSessionEvent);
			}
		} catch (error: unknown) {
			// Preserve stdio's historical tolerance for incidental non-JSON output.
			if (this.socket !== null) {
				this.handleTcpSocketError(this.socket, toRpcTransportError(error, "rpc_transport_connection_failed"));
			}
		}
	}

	private createProcessExitError(code: number | null, signal: NodeJS.Signals | null): Error {
		return new Error(`Agent process exited (code=${code} signal=${signal}). Stderr: ${this.stderr}`);
	}

	private resolveTcpOptions(): NormalizedRpcClientTcpOptions | null {
		const configuredTransport = this.options.transport;
		if (configuredTransport === undefined) {
			if (this.options.tcp === undefined) return null;
			return normalizeTcpOptions(this.options.tcp);
		}
		if (configuredTransport === "stdio") return null;

		if (configuredTransport === "tcp") {
			if (this.options.tcp === undefined) {
				throw new RpcTransportAddressError(
					"rpc_transport_address_invalid",
					'TCP transport requires a "tcp" option object with a port',
				);
			}
			return normalizeTcpOptions(this.options.tcp);
		}

		return normalizeTcpOptions(configuredTransport);
	}

	private attachTcpSocketEvents(socket: Socket): void {
		const onError = (error: Error): void => {
			this.handleTcpSocketError(socket, error);
		};
		const onClose = (): void => {
			this.handleTcpSocketClose(socket);
		};
		this.tcpSocketEvents = { socket, onError, onClose };
		socket.on("error", onError);
		socket.once("close", onClose);
	}

	private detachTcpSocketEvents(socket: Socket): void {
		const events = this.tcpSocketEvents;
		if (!events || events.socket !== socket) return;
		socket.off("error", events.onError);
		socket.off("close", events.onClose);
		this.tcpSocketEvents = null;
	}

	private handleTcpSocketError(socket: Socket, error: Error): void {
		if (this.socket !== socket) return;
		const transportError = toRpcTransportError(error, "rpc_transport_connection_failed");
		this.exitError ??= transportError;
		this.rejectPendingRequests(this.exitError);
		this.stopReadingStdout?.();
		this.stopReadingStdout = null;
		if (!socket.destroyed) socket.destroy();
	}

	private handleTcpSocketClose(socket: Socket): void {
		if (this.socket !== socket) return;
		this.exitError ??= new RpcTransportError("rpc_transport_closed", "RPC transport connection is closed");
		this.rejectPendingRequests(this.exitError);
		this.stopReadingStdout?.();
		this.stopReadingStdout = null;
		this.detachTcpSocketEvents(socket);
		this.tcpWriter?.detach();
		this.tcpWriter = null;
		this.socket = null;
		this.inputStream = null;
	}

	private async stopTcp(socket: Socket): Promise<void> {
		this.rejectPendingRequests(new Error("RPC client stopped"));
		this.stopReadingStdout?.();
		this.stopReadingStdout = null;
		this.tcpWriter?.detach();
		this.tcpWriter = null;
		await this.destroyTcpSocket(socket);
		if (this.socket === socket) {
			this.detachTcpSocketEvents(socket);
			this.socket = null;
			this.inputStream = null;
		}
	}

	private async destroyTcpSocket(socket: Socket): Promise<void> {
		if (socket.destroyed) {
			this.detachTcpSocketEvents(socket);
			return;
		}
		await new Promise<void>((resolve) => {
			let settled = false;
			let timeout: NodeJS.Timeout;
			const finish = (): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				this.detachTcpSocketEvents(socket);
				resolve();
			};
			timeout = setTimeout(finish, 1000);
			socket.once("close", finish);
			socket.destroy();
			if (socket.destroyed) finish();
		});
	}

	private waitForTcpConnection(socket: Socket, timeoutMs: number): Promise<void> {
		return new Promise((resolve, reject) => {
			let settled = false;
			const finish = (error?: Error): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timeout);
				socket.off("connect", onConnect);
				socket.off("error", onError);
				socket.off("close", onClose);
				if (error) reject(error);
				else resolve();
			};
			const onConnect = (): void => finish();
			const onError = (error: Error): void => finish(error);
			const onClose = (): void =>
				finish(new RpcTransportError("rpc_transport_closed", "RPC transport connection is closed"));
			const timeout = setTimeout(
				() =>
					finish(
						new RpcTransportError(
							"rpc_transport_connection_failed",
							`Timed out connecting to RPC TCP transport after ${timeoutMs}ms`,
						),
					),
				timeoutMs,
			);
			socket.once("connect", onConnect);
			socket.once("error", onError);
			socket.once("close", onClose);
		});
	}

	private rejectPendingRequests(error: Error): void {
		for (const pending of this.pendingRequests.values()) {
			pending.reject(error);
		}
		this.pendingRequests.clear();
	}

	/**
	 * Write one record to the active transport (stdio stdin or TCP). Rejects
	 * when the transport is unavailable or the write fails.
	 */
	private async writeRecord(record: unknown): Promise<void> {
		const childProcess = this.process;
		if (this.exitError) {
			throw this.exitError;
		}
		const socket = this.socket;
		const stdin = this.inputStream;
		if ((!childProcess && !socket) || !stdin) {
			throw new Error("Client not started");
		}
		if (childProcess && childProcess.exitCode !== null) {
			const error = this.createProcessExitError(childProcess.exitCode, childProcess.signalCode);
			this.exitError = error;
			throw error;
		}
		if (socket && (socket.destroyed || !socket.writable)) {
			const error = new RpcTransportError(
				socket.destroyed ? "rpc_transport_closed" : "rpc_transport_write_failed",
				socket.destroyed ? "RPC transport connection is closed" : "RPC transport write failed",
			);
			this.handleTcpSocketError(socket, error);
			throw error;
		}
		if (childProcess && (stdin.destroyed || !stdin.writable)) {
			const error = new Error(`Agent process stdin is not writable. Stderr: ${this.stderr}`);
			this.exitError = error;
			throw error;
		}
		const writePromise = socket
			? this.tcpWriter?.write(record)
			: writeStdioLine(stdin, serializeJsonLine(record));
		if (writePromise === undefined) {
			const writeError = new RpcTransportError("rpc_transport_write_failed", "RPC transport write failed");
			throw writeError;
		}
		try {
			await writePromise;
		} catch (error: unknown) {
			const writeError = socket
				? toRpcTransportError(
						error,
						error instanceof JsonlFrameError ? "rpc_transport_frame_too_large" : "rpc_transport_write_failed",
					)
				: error instanceof Error
					? error
					: new Error(String(error));
			if (socket) this.handleTcpSocketError(socket, writeError);
			throw writeError;
		}
	}

	private async send(command: RpcCommandBody, signal?: AbortSignal, timeoutMs = 30000): Promise<RpcResponse> {
		const childProcess = this.process;
		if (this.exitError) {
			throw this.exitError;
		}
		const socket = this.socket;
		const stdin = this.inputStream;
		if ((!childProcess && !socket) || !stdin) {
			throw new Error("Client not started");
		}
		if (childProcess && childProcess.exitCode !== null) {
			const error = this.createProcessExitError(childProcess.exitCode, childProcess.signalCode);
			this.exitError = error;
			throw error;
		}
		if (socket && (socket.destroyed || !socket.writable)) {
			const error = new RpcTransportError(
				socket.destroyed ? "rpc_transport_closed" : "rpc_transport_write_failed",
				socket.destroyed ? "RPC transport connection is closed" : "RPC transport write failed",
			);
			this.handleTcpSocketError(socket, error);
			throw error;
		}
		if (childProcess && (stdin.destroyed || !stdin.writable)) {
			const error = new Error(`Agent process stdin is not writable. Stderr: ${this.stderr}`);
			this.exitError = error;
			throw error;
		}

		const id = `req_${++this.requestId}`;
		const fullCommand = { ...command, id } as RpcCommand;

		return new Promise((resolve, reject) => {
			const onAbort = (): void => {
				if (!this.pendingRequests.has(id)) return;
				this.pendingRequests.delete(id);
				const reason = signal?.reason;
				reject(reason instanceof Error ? reason : new Error("Request aborted"));
			};
			signal?.addEventListener("abort", onAbort, { once: true });

			const timeout = setTimeout(() => {
				this.pendingRequests.delete(id);
				signal?.removeEventListener("abort", onAbort);
				reject(new Error(`Timeout waiting for response to ${command.type}. Stderr: ${this.stderr}`));
			}, timeoutMs);

			this.pendingRequests.set(id, {
				resolve: (response) => {
					clearTimeout(timeout);
					signal?.removeEventListener("abort", onAbort);
					resolve(response);
				},
				reject: (error) => {
					clearTimeout(timeout);
					signal?.removeEventListener("abort", onAbort);
					reject(error);
				},
			});

			void this.writeRecord(fullCommand).catch((writeError: unknown) => {
				const pending = this.pendingRequests.get(id);
				this.pendingRequests.delete(id);
				pending?.reject(writeError instanceof Error ? writeError : new Error(String(writeError)));
			});
		});
	}

	private getData<T>(response: RpcResponse): T {
		if (!response.success) {
			const errorResponse = response as Extract<RpcResponse, { success: false }>;
			throw new Error(errorResponse.error);
		}
		// Type assertion: we trust response.data matches T based on the command sent.
		// This is safe because each public method specifies the correct T for its command.
		const successResponse = response as Extract<RpcResponse, { success: true; data: unknown }>;
		return successResponse.data as T;
	}

	/**
	 * Unwrap an MCP content (`mcp.resource.*` / `mcp.prompt.*`) response.
	 * Failures carry a structured {@link RpcMcpContentError}; the stable code
	 * is preserved on the thrown {@link McpContentRpcError}.
	 */
	private getMcpContentData<T>(response: RpcResponse): T {
		if (!response.success) {
			const error = (response as { error: unknown }).error;
			if (typeof error === "object" && error !== null && "code" in error && "message" in error) {
				throw new McpContentRpcError(error as RpcMcpContentError);
			}
			throw new Error(typeof error === "string" ? error : String(error));
		}
		const successResponse = response as Extract<RpcResponse, { success: true; data: unknown }>;
		return successResponse.data as T;
	}

	/**
	 * Unwrap an `mcp.auth.*` response. Failures carry a structured
	 * {@link RpcMcpAuthError}; the stable code is preserved on the thrown
	 * {@link McpAuthRpcError}.
	 */
	private getMcpAuthData<T>(response: RpcResponse): T {
		if (!response.success) {
			const error = (response as { error: unknown }).error;
			if (typeof error === "object" && error !== null && "code" in error && "message" in error) {
				throw new McpAuthRpcError(error as RpcMcpAuthError);
			}
			throw new Error(typeof error === "string" ? error : String(error));
		}
		const successResponse = response as Extract<RpcResponse, { success: true; data: unknown }>;
		return successResponse.data as T;
	}

	private async sendAutomation(command: RpcCommandBody): Promise<RpcAutomationResponse> {
		const response = await this.send(command);
		return response as unknown as RpcAutomationResponse;
	}

	private getAutomationData<T>(response: RpcAutomationResponse): T {
		if (!response.success) {
			const error = response.error;
			throw typeof error === "string" ? new Error(error) : new AutomationRpcError(error);
		}
		const successResponse = response as Extract<RpcAutomationResponse, { success: true; data: unknown }>;
		return successResponse.data as T;
	}
}

interface NormalizedRpcClientTcpOptions {
	host: typeof RPC_TRANSPORT_LOOPBACK_HOST;
	port: number;
	connectTimeoutMs: number;
}

function normalizeTcpOptions(options: RpcClientTcpOptions): NormalizedRpcClientTcpOptions {
	for (const discriminator of [options.type, options.kind, options.transport]) {
		if (discriminator !== undefined && discriminator !== "tcp") {
			throw new RpcTransportAddressError(
				"rpc_transport_address_invalid",
				'TCP transport must use the "tcp" discriminator',
			);
		}
	}
	const address = validateRpcTransportAddress({
		transport: "tcp",
		host: options.host ?? RPC_TRANSPORT_LOOPBACK_HOST,
		port: options.port,
	});
	const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_RPC_CLIENT_CONNECT_TIMEOUT_MS;
	if (
		!Number.isSafeInteger(connectTimeoutMs) ||
		connectTimeoutMs <= 0 ||
		connectTimeoutMs > MAX_RPC_CLIENT_CONNECT_TIMEOUT_MS
	) {
		throw new Error(
			`RpcClient TCP connectTimeoutMs must be an integer between 1 and ${MAX_RPC_CLIENT_CONNECT_TIMEOUT_MS}`,
		);
	}
	return { host: address.host, port: address.port, connectTimeoutMs };
}

function writeStdioLine(stream: Writable, line: string): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		try {
			stream.write(line, "utf8", (error?: Error | null) => (error ? reject(error) : resolve()));
		} catch (error: unknown) {
			reject(error instanceof Error ? error : new Error(String(error)));
		}
	});
}

function toRpcTransportError(error: unknown, fallbackCode: RpcTransportErrorCode): RpcTransportError {
	if (error instanceof RpcTransportError) return error;
	if (error instanceof JsonlFrameError) {
		return new RpcTransportError("rpc_transport_frame_too_large", error.message, error);
	}
	return new RpcTransportError(fallbackCode, "RPC transport operation failed", error);
}
