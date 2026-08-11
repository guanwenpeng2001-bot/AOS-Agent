import { Client } from "@modelcontextprotocol/sdk/client";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import {
	getDefaultEnvironment,
	StdioClientTransport,
	type StdioServerParameters,
} from "@modelcontextprotocol/sdk/client/stdio";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport";
import type { Tool } from "@modelcontextprotocol/sdk/types";
import {
	createMCPServerConfigView,
	type MCPCallResult,
	type MCPConnectionState,
	type MCPConnectionStatus,
	type MCPServerConfig,
	type MCPServerConfigView,
	type MCPEnvResolver,
	type MCPError,
	type MCPErrorKind,
	type MCPErrorView,
	type MCPStdioServerConfig,
	type MCPStreamableHttpServerConfig,
	type MCPToolContentBlock,
	type MCPTransportFactory,
	MCPError as MCPLifecycleError,
	mcpStateToAvailability,
	validateMCPServerConfig,
} from "./mcp-types.ts";

const MCP_CLIENT_NAME = "aos-agent-mcp-client";
const MCP_CLIENT_VERSION = "1.0.0";
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

/** Fail-closed message templates; never embed remote error text or secrets. */
function mcpFailureMessage(kind: MCPErrorKind, serverId: string): string {
	switch (kind) {
		case "not_selected":
			return `MCP server "${serverId}" is not selected for this binding`;
		case "invalid_config":
			return `MCP server "${serverId}" has an invalid configuration`;
		case "connect_failed":
			return `Failed to connect to MCP server "${serverId}"`;
		case "auth_required":
			return `MCP server "${serverId}" requires authentication`;
		case "unavailable":
			return `MCP server "${serverId}" is unavailable`;
		case "call_failed":
			return `MCP server "${serverId}" failed to execute a tool call`;
	}
}

/**
 * Builds the stdio SDK transport. The pinned SDK merges its curated defaults
 * into every transport environment, so every default key is explicitly
 * neutralized and only values from the configured allowlist survive.
 */
export function createMCPStdioTransport(
	config: MCPStdioServerConfig,
	env: MCPEnvResolver,
): StdioClientTransport {
	const serverParams: StdioServerParameters = {
		command: config.command,
		...(config.args !== undefined ? { args: [...config.args] } : {}),
		...(config.cwd !== undefined ? { cwd: config.cwd } : {}),
		...(config.maxBufferSize !== undefined ? { maxBufferSize: config.maxBufferSize } : {}),
	};
	const resolvedEnv: Record<string, string> = {};
	for (const name of Object.keys(getDefaultEnvironment())) {
		resolvedEnv[name] = "";
	}
	for (const name of config.env ?? []) {
		const value = env(name);
		if (value !== undefined) {
			resolvedEnv[name] = value;
		}
	}
	serverParams.env = resolvedEnv;
	return new StdioClientTransport(serverParams);
}

/** Builds the Streamable HTTP SDK transport, resolving header values from env names only. */
export function createMCPHttpTransport(
	config: MCPStreamableHttpServerConfig,
	env: MCPEnvResolver,
): StreamableHTTPClientTransport {
	const headers: Record<string, string> = {};
	for (const ref of config.headersFromEnv ?? []) {
		const value = env(ref.valueFromEnv);
		if (value !== undefined) {
			headers[ref.name] = value;
		}
	}
	return new StreamableHTTPClientTransport(new URL(config.url), {
		...(Object.keys(headers).length > 0 ? { requestInit: { headers } } : {}),
	});
}

/** Default transport factory used in production. Tests inject an in-memory factory. */
export function createMCPDefaultTransportFactory(): MCPTransportFactory {
	return (config: MCPServerConfig, env: MCPEnvResolver): Transport => {
		switch (config.transport) {
			case "stdio":
				return createMCPStdioTransport(config, env);
			case "streamable-http":
				return createMCPHttpTransport(config, env);
		}
	};
}

/** Per-request timeout default applied to connect and listTools. */
export interface MCPServerLifecycleOptions {
	/** Environment resolver; defaults to process.env lookups. */
	env?: MCPEnvResolver;
	/** Transport factory; defaults to {@link createMCPDefaultTransportFactory}. */
	transportFactory?: MCPTransportFactory;
	/** Timeout in milliseconds for connect/listTools; defaults to 60s. */
	requestTimeoutMs?: number;
}

const DEFAULT_ENV_RESOLVER: MCPEnvResolver = (name) => process.env[name];

/**
 * Lifecycle controller for a single MCP server connection.
 *
 * Enforces the state machine and records redacted errors. It does not decide
 * whether a server is selected; selection gating happens in
 * {@link MCPLifecycleManager}.
 */
export class MCPServerLifecycle {
	private readonly config: MCPServerConfig;
	private readonly env: MCPEnvResolver;
	private readonly transportFactory: MCPTransportFactory;
	private readonly requestTimeoutMs: number;
	private client: Client | undefined;
	/** Client created for a connect that has not settled; close must not orphan it. */
	private pendingClient: Client | undefined;
	private connectionState: MCPConnectionState;
	private connectPromise: Promise<void> | undefined;
	private readonly inflightCalls = new Set<AbortController>();
	private connectedAt: string | undefined;
	private lastError: MCPErrorView | undefined;
	private toolCount: number | undefined;

	constructor(config: MCPServerConfig, options: MCPServerLifecycleOptions = {}) {
		this.config = config;
		this.env = options.env ?? DEFAULT_ENV_RESOLVER;
		this.transportFactory = options.transportFactory ?? createMCPDefaultTransportFactory();
		this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
		this.connectionState = "configured";
	}

	get serverId(): string {
		return this.config.id;
	}

	get state(): MCPConnectionState {
		return this.connectionState;
	}

	getConfigView(): MCPServerConfigView {
		return createMCPServerConfigView(this.config);
	}

	getStatus(): MCPConnectionStatus {
		return {
			serverId: this.config.id,
			state: this.state,
			availability: mcpStateToAvailability(this.state),
			...(this.connectedAt !== undefined ? { connectedAt: this.connectedAt } : {}),
			...(this.lastError !== undefined ? { lastError: this.lastError } : {}),
			...(this.toolCount !== undefined ? { toolCount: this.toolCount } : {}),
		};
	}

	/**
	 * Connects and initializes the server. Idempotent once `ready`. Throws a
	 * redacted {@link MCPError} on failure and transitions to `unavailable` (or
	 * records the auth-required classification).
	 */
	async connect(): Promise<void> {
		if (this.state === "ready") {
			return;
		}
		if (this.state === "closing" || this.state === "closed") {
			throw this.failure("unavailable");
		}
		if (this.connectPromise !== undefined) {
			return this.connectPromise;
		}
		this.connectPromise = this.doConnect();
		try {
			await this.connectPromise;
		} finally {
			this.connectPromise = undefined;
		}
	}

	private async doConnect(): Promise<void> {
		const problems = validateMCPServerConfig(this.config);
		if (problems.length > 0) {
			this.setState("unavailable");
			this.recordError("invalid_config");
			throw new MCPLifecycleError(
				"invalid_config",
				this.config.id,
				`Invalid MCP server config for "${this.config.id}": ${problems.join("; ")}`,
			);
		}
		if (this.client !== undefined) {
			try {
				await this.client.close();
			} catch {
				// best-effort close of a stale connection before reconnecting
			}
		}
		this.setState("connecting");
		let pendingClient: Client | undefined;
		try {
			const transport = await this.transportFactory(this.config, this.env);
			if (this.isClosingOrClosed()) {
				await transport.close?.().catch(() => undefined);
				throw this.failure("unavailable");
			}
			pendingClient = new Client({ name: MCP_CLIENT_NAME, version: MCP_CLIENT_VERSION });
			this.pendingClient = pendingClient;
			await pendingClient.connect(transport, { timeout: this.requestTimeoutMs });
			if (this.isClosingOrClosed()) {
				await pendingClient.close().catch(() => undefined);
				throw this.failure("unavailable");
			}
			this.client = pendingClient;
			this.chainTransportHandlers(transport);
			this.setState("ready");
			this.connectedAt = new Date().toISOString();
			this.lastError = undefined;
			this.toolCount = undefined;
		} catch (error) {
			if (pendingClient !== undefined && this.pendingClient === pendingClient) {
				this.pendingClient = undefined;
				await pendingClient.close().catch(() => undefined);
			}
			if (this.isClosingOrClosed()) {
				throw this.failure("unavailable");
			}
			const kind: MCPErrorKind = error instanceof UnauthorizedError ? "auth_required" : "connect_failed";
			this.setState("unavailable");
			this.recordError(kind);
			throw this.failure(kind);
		} finally {
			if (pendingClient !== undefined && this.pendingClient === pendingClient) {
				this.pendingClient = undefined;
			}
		}
	}

	/**
	 * Lists the tools of an already-connected server. Any failure marks the
	 * server degraded and maps to capability unavailable, so callers never see a
	 * fake tool list. A degraded or unconnected server throws instead of
	 * auto-reconnecting.
	 */
	async listTools(): Promise<Tool[]> {
		const client = this.requireReady();
		try {
			const result = await client.listTools({}, { timeout: this.requestTimeoutMs });
			this.toolCount = result.tools.length;
			this.lastError = undefined;
			return result.tools;
		} catch {
			this.markDegraded();
			throw this.failure("unavailable");
		}
	}

	/**
	 * Calls a discovered tool. A server-reported `isError` result is returned as
	 * an error-flagged {@link MCPCallResult}; transport-level failures mark the
	 * server degraded and throw capability_mcp_unavailable. Cancelling the caller
	 * signal rejects with an AbortError without degrading the server.
	 */
	async callTool(
		toolName: string,
		args: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<MCPCallResult> {
		const client = this.requireReady();
		const controller = new AbortController();
		this.inflightCalls.add(controller);
		const onAbort = (): void => {
			controller.abort(signal?.reason);
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		try {
			const result = await client.callTool(
				{ name: toolName, arguments: args },
				undefined,
				{ signal: controller.signal, timeout: this.requestTimeoutMs },
			);
			return {
				serverId: this.config.id,
				toolName,
				content: (result.content ?? []) as unknown as MCPToolContentBlock[],
				isError: result.isError === true,
				...(result.structuredContent !== undefined
					? { structuredContent: result.structuredContent as Record<string, unknown> }
					: {}),
			};
		} catch {
			if (signal?.aborted) {
				throw new DOMException(`MCP tool call "${toolName}" was aborted`, "AbortError");
			}
			if (this.state === "closing" || this.state === "closed") {
				throw this.failure("unavailable");
			}
			this.markDegraded();
			throw this.failure("unavailable");
		} finally {
			signal?.removeEventListener("abort", onAbort);
			this.inflightCalls.delete(controller);
		}
	}

	/** Gracefully closes the connection and releases the child process / transport. */
	async close(): Promise<void> {
		if (this.state === "closing" || this.state === "closed") {
			return;
		}
		this.setState("closing");
		const clients = [this.client, this.pendingClient].filter(
			(client, index, all): client is Client => client !== undefined && all.indexOf(client) === index,
		);
		this.client = undefined;
		this.pendingClient = undefined;
		for (const client of clients) {
			try {
				await client.close();
			} catch {
				// best-effort close; the state is still finalized below
			}
		}
		this.setState("closed");
	}

	/**
	 * Tears down the connection even when calls are in flight, aborting them and
	 * closing the transport / child process.
	 */
	async forceClose(): Promise<void> {
		for (const controller of this.inflightCalls) {
			controller.abort(new Error("MCP server connection force-closed"));
		}
		this.inflightCalls.clear();
		await this.close();
	}

	private requireReady(): Client {
		if (this.state === "ready" && this.client !== undefined) {
			return this.client;
		}
		throw this.failure("unavailable");
	}

	private chainTransportHandlers(transport: Transport): void {
		const originalOnError = transport.onerror;
		const originalOnClose = transport.onclose;
		transport.onerror = (error: Error): void => {
			originalOnError?.(error);
			this.markDegraded();
		};
		transport.onclose = (): void => {
			originalOnClose?.();
			this.handleTransportClose();
		};
	}

	private handleTransportClose(): void {
		if (this.state === "ready") {
			this.setState("degraded");
			this.recordError("unavailable");
		} else if (this.state === "connecting") {
			this.setState("unavailable");
			this.recordError("connect_failed");
		}
	}

	private markDegraded(): void {
		if (this.state === "ready" || this.state === "degraded") {
			this.setState("degraded");
			this.recordError("unavailable");
		}
	}

	private recordError(kind: MCPErrorKind): void {
		this.lastError = this.failure(kind).toJSON();
	}

	private failure(kind: MCPErrorKind): MCPError {
		return new MCPLifecycleError(kind, this.config.id, mcpFailureMessage(kind, this.config.id));
	}

	private setState(state: MCPConnectionState): void {
		this.connectionState = state;
	}

	private isClosingOrClosed(): boolean {
		return this.connectionState === "closing" || this.connectionState === "closed";
	}
}

export interface MCPLifecycleManagerOptions extends MCPServerLifecycleOptions {
	/** Server ids the current binding selected. Only these may connect. */
	selectedServerIds?: ReadonlySet<string>;
}

/**
 * Owns all configured MCP servers and enforces the selected-binding gate:
 * only servers the current binding selected may connect, list tools, or be
 * called. Registration never auto-connects.
 */
export class MCPLifecycleManager {
	private readonly options: MCPServerLifecycleOptions;
	private readonly lifecycles = new Map<string, MCPServerLifecycle>();
	private selectedServerIds: ReadonlySet<string>;

	constructor(options: MCPLifecycleManagerOptions = {}) {
		this.options = options;
		// Copy the set so later mutation of the caller's Set cannot change selection.
		this.selectedServerIds =
			options.selectedServerIds === undefined ? new Set() : new Set(options.selectedServerIds);
	}

	/** Registers configured servers. Duplicate ids are rejected; nothing connects. */
	registerServers(configs: ReadonlyArray<MCPServerConfig>): void {
		for (const config of configs) {
			if (this.lifecycles.has(config.id)) {
				throw new MCPLifecycleError(
					"invalid_config",
					config.id,
					`Duplicate MCP server id: "${config.id}"`,
				);
			}
			this.lifecycles.set(config.id, new MCPServerLifecycle(config, this.options));
		}
	}

	getServerIds(): ReadonlyArray<string> {
		return [...this.lifecycles.keys()];
	}

	/** Returns a snapshot copy; mutating the returned Set cannot change selection. */
	getSelectedServerIds(): ReadonlySet<string> {
		return new Set(this.selectedServerIds);
	}

	/** Replaces the selected server ids with a copy; mutating the caller Set is inert. */
	setSelectedServerIds(ids: ReadonlySet<string> | ReadonlyArray<string>): void {
		this.selectedServerIds = new Set(ids);
	}

	isSelected(serverId: string): boolean {
		return this.selectedServerIds.has(serverId);
	}

	getConfigView(serverId: string): MCPServerConfigView | undefined {
		return this.lifecycles.get(serverId)?.getConfigView();
	}

	getStatus(serverId: string): MCPConnectionStatus | undefined {
		return this.lifecycles.get(serverId)?.getStatus();
	}

	/** Connects a server only when it is registered and selected by the binding. */
	async connect(serverId: string): Promise<void> {
		const lifecycle = this.requireServer(serverId);
		this.assertSelected(serverId);
		await lifecycle.connect();
	}

	/** Lists tools of a connected, selected server. */
	async listTools(serverId: string): Promise<Tool[]> {
		const lifecycle = this.requireServer(serverId);
		this.assertSelected(serverId);
		return lifecycle.listTools();
	}

	/** Calls a tool on a selected server. */
	async callTool(
		serverId: string,
		toolName: string,
		args: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<MCPCallResult> {
		const lifecycle = this.requireServer(serverId);
		this.assertSelected(serverId);
		return lifecycle.callTool(toolName, args, signal);
	}

	async close(serverId: string): Promise<void> {
		const lifecycle = this.lifecycles.get(serverId);
		if (lifecycle !== undefined) {
			await lifecycle.close();
		}
	}

	/** Closes every registered server, forcing in-flight calls to abort. */
	async closeAll(): Promise<void> {
		await Promise.all([...this.lifecycles.values()].map((lifecycle) => lifecycle.forceClose()));
	}

	private requireServer(serverId: string): MCPServerLifecycle {
		const lifecycle = this.lifecycles.get(serverId);
		if (lifecycle === undefined) {
			throw new MCPLifecycleError(
				"invalid_config",
				serverId,
				`No configuration registered for MCP server "${serverId}"`,
			);
		}
		return lifecycle;
	}

	private assertSelected(serverId: string): void {
		if (!this.selectedServerIds.has(serverId)) {
			throw new MCPLifecycleError(
				"not_selected",
				serverId,
				`MCP server "${serverId}" is not selected for this binding`,
			);
		}
	}
}
