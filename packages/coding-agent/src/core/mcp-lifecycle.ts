import { Client } from "@modelcontextprotocol/sdk/client";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import {
	getDefaultEnvironment,
	StdioClientTransport,
	type StdioServerParameters,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport";
import { McpError, type Tool } from "@modelcontextprotocol/sdk/types.js";
import {
	createMCPServerConfigView,
	DEFAULT_MCP_CONTENT_LIMITS,
	type MCPAuthProviderResolver,
	type MCPCallResult,
	type MCPConnectionState,
	type MCPConnectionStatus,
	type MCPContentLimits,
	type MCPEnvResolver,
	type MCPError,
	type MCPErrorKind,
	type MCPErrorView,
	MCPError as MCPLifecycleError,
	type MCPPromptListResult,
	type MCPResourceListResult,
	type MCPResourceTemplateListResult,
	type MCPServerConfig,
	type MCPServerConfigView,
	type MCPStdioServerConfig,
	type MCPStreamableHttpServerConfig,
	type MCPToolContentBlock,
	type MCPTransportFactory,
	mcpStateToAvailability,
	validateMCPServerConfig,
} from "./mcp-types.ts";
import {
	MCPContentError,
	type MCPGetPromptResult,
	type MCPReadResourceResult,
	mcpResourceId,
	normalizeMCPPromptGet,
	normalizeMCPPromptSummaries,
	normalizeMCPResourceRead,
	normalizeMCPResourceSummaries,
	normalizeMCPResourceTemplateSummaries,
	validateMCPPromptArguments,
	validateMCPPromptName,
	validateMCPResourceUri,
} from "./mcp-content.ts";

const MCP_CLIENT_NAME = "aos-agent-mcp-client";
const MCP_CLIENT_VERSION = "1.0.0";
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

function abortError(signal: AbortSignal): DOMException {
	return new DOMException(
		signal.reason instanceof Error ? signal.reason.message : "MCP operation aborted",
		"AbortError",
	);
}

async function raceWithAbort<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (signal === undefined) return operation;
	if (signal.aborted) throw abortError(signal);
	let onAbort: (() => void) | undefined;
	const aborted = new Promise<never>((_, reject) => {
		onAbort = () => reject(abortError(signal));
		signal.addEventListener("abort", onAbort, { once: true });
	});
	try {
		return await Promise.race([operation, aborted]);
	} finally {
		if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
	}
}

/**
 * True when the SDK classified the failure as a JSON-RPC method-not-found
 * (the server advertises a top-level capability but does not implement the
 * concrete method, e.g. resources without resources/templates/list). This is
 * a server capability fact, not a transport failure: the caller surfaces the
 * fixed unavailable code and the server must NOT be marked degraded.
 */
function isMCPMethodNotSupported(error: unknown): boolean {
	return error instanceof McpError && error.code === -32601;
}

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
export function createMCPStdioTransport(config: MCPStdioServerConfig, env: MCPEnvResolver): StdioClientTransport {
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
	authProvider?: MCPAuthProviderResolver,
): StreamableHTTPClientTransport {
	const headers: Record<string, string> = {};
	for (const ref of config.headersFromEnv ?? []) {
		const value = env(ref.valueFromEnv);
		if (value !== undefined) {
			headers[ref.name] = value;
		}
	}
	const resolvedProvider =
		authProvider === undefined
			? undefined
			: typeof authProvider === "function"
				? authProvider(config)
				: authProvider;
	return new StreamableHTTPClientTransport(new URL(config.url), {
		...(Object.keys(headers).length > 0 ? { requestInit: { headers } } : {}),
		...(resolvedProvider !== undefined ? { authProvider: resolvedProvider } : {}),
	});
}

/** Default transport factory used in production. Tests inject an in-memory factory. */
export function createMCPDefaultTransportFactory(): MCPTransportFactory {
	return (config: MCPServerConfig, env: MCPEnvResolver, authProvider?: MCPAuthProviderResolver): Transport => {
		switch (config.transport) {
			case "stdio":
				return createMCPStdioTransport(config, env);
			case "streamable-http":
				return createMCPHttpTransport(config, env, authProvider);
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
	/**
	 * Per-session OAuth client provider for streamable-http servers. One
	 * provider instance never crosses sessions: every session builds its own
	 * lifecycle with its own provider. stdio servers never receive it.
	 */
	authProvider?: MCPAuthProviderResolver;
	/** Content safety limits for resources/prompts; defaults to {@link DEFAULT_MCP_CONTENT_LIMITS}. */
	contentLimits?: MCPContentLimits;
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
	private readonly authProvider: MCPAuthProviderResolver | undefined;
	private readonly contentLimits: MCPContentLimits;
	private client: Client | undefined;
	/** Client created for a connect that has not settled; close must not orphan it. */
	private pendingClient: Client | undefined;
	/** The transport backing the current connection; a stale closed transport is ignored. */
	private transport: Transport | undefined;
	private connectionState: MCPConnectionState;
	private connectPromise: Promise<void> | undefined;
	private readonly inflightCalls = new Set<AbortController>();
	/** In-flight list/read/get operations; close() and forceClose() abort them. */
	private readonly inflightOps = new Set<AbortController>();
	private connectedAt: string | undefined;
	private lastError: MCPErrorView | undefined;
	private toolCount: number | undefined;
	/** Set by resources/prompts list-changed notifications; cleared on a successful list. */
	private catalogStale = false;
	/** In-memory resourceId -> raw URI map. URIs never leave this lifecycle. */
	private readonly resourceUris = new Map<string, string>();
	/** In-memory promptId -> sanitized prompt name map. */
	private readonly promptNames = new Map<string, string>();
	/** One 401 refresh/reconnect attempt per connect; reset on a successful ready state. */
	private connectAuthRetried = false;

	constructor(config: MCPServerConfig, options: MCPServerLifecycleOptions = {}) {
		this.config = config;
		this.env = options.env ?? DEFAULT_ENV_RESOLVER;
		this.transportFactory = options.transportFactory ?? createMCPDefaultTransportFactory();
		this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
		this.authProvider = options.authProvider;
		this.contentLimits = options.contentLimits ?? DEFAULT_MCP_CONTENT_LIMITS;
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
			...(this.catalogStale ? { catalogStale: true } : {}),
		};
	}

	/**
	 * Connects and initializes the server. Idempotent once `ready`. A server that
	 * previously reached terminal `closed` — for example after a profile
	 * deselection closed it — reconnects here with a fresh transport, so it can be
	 * selected and used again later. Throws a redacted {@link MCPError} on failure
	 * and transitions to `unavailable` (or records the auth-required
	 * classification).
	 */
	async connect(signal?: AbortSignal): Promise<void> {
		if (signal?.aborted) throw abortError(signal);
		if (this.state === "ready") {
			return;
		}
		if (this.state === "closing") {
			throw this.failure("unavailable");
		}
		if (this.connectPromise !== undefined) {
			return raceWithAbort(this.connectPromise, signal);
		}
		const connectPromise = this.doConnect(signal);
		this.connectPromise = connectPromise;
		void connectPromise.then(
			() => {
				if (this.connectPromise === connectPromise) this.connectPromise = undefined;
			},
			() => {
				if (this.connectPromise === connectPromise) this.connectPromise = undefined;
			},
		);
		await raceWithAbort(connectPromise, signal);
	}

	private async doConnect(signal?: AbortSignal): Promise<void> {
		if (signal?.aborted) throw abortError(signal);
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
			const transport = await this.transportFactory(
				this.config,
				this.env,
				this.resolveAuthProvider(),
			);
			if (signal?.aborted) {
				await transport.close?.().catch(() => undefined);
				throw abortError(signal);
			}
			if (this.isClosingOrClosed()) {
				await transport.close?.().catch(() => undefined);
				throw this.failure("unavailable");
			}
			pendingClient = new Client(
				{ name: MCP_CLIENT_NAME, version: MCP_CLIENT_VERSION },
				{
					// List-changed notifications only set the stale flag; they never
					// auto-refresh a catalog or mutate a frozen binding. Handlers are
					// installed by the SDK only when the server advertises the
					// corresponding listChanged capability.
					listChanged: {
						resources: {
							autoRefresh: false,
							onChanged: () => {
								this.catalogStale = true;
							},
						},
						prompts: {
							autoRefresh: false,
							onChanged: () => {
								this.catalogStale = true;
							},
						},
					},
				},
			);
			this.pendingClient = pendingClient;
			await pendingClient.connect(transport, { timeout: this.requestTimeoutMs, signal });
			if (signal?.aborted) {
				await pendingClient.close().catch(() => undefined);
				throw abortError(signal);
			}
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
			this.connectAuthRetried = false;
		} catch (error) {
			if (pendingClient !== undefined && this.pendingClient === pendingClient) {
				this.pendingClient = undefined;
				await pendingClient.close().catch(() => undefined);
			}
			if (this.isClosingOrClosed()) {
				throw this.failure("unavailable");
			}
			if (signal?.aborted) {
				this.setState("unavailable");
				throw abortError(signal);
			}
			if (
				error instanceof UnauthorizedError &&
				!this.connectAuthRetried &&
				this.resolveAuthProvider() !== undefined
			) {
				// One 401 refresh/reconnect only. A second 401 becomes auth_required.
				this.connectAuthRetried = true;
				this.client = undefined;
				this.transport = undefined;
				return this.doConnect(signal);
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
	async listTools(signal?: AbortSignal): Promise<Tool[]> {
		const client = this.requireReady();
		try {
			const result = await raceWithAbort(client.listTools({}, { timeout: this.requestTimeoutMs, signal }), signal);
			if (signal?.aborted) throw abortError(signal);
			this.toolCount = result.tools.length;
			this.lastError = undefined;
			return result.tools;
		} catch (error) {
			if (signal?.aborted) {
				throw error instanceof DOMException && error.name === "AbortError" ? error : abortError(signal);
			}
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
	async callTool(toolName: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<MCPCallResult> {
		const client = this.requireReady();
		if (signal?.aborted) throw abortError(signal);
		const controller = new AbortController();
		this.inflightCalls.add(controller);
		const onAbort = (): void => {
			controller.abort(signal?.reason);
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		try {
			const result = await client.callTool({ name: toolName, arguments: args }, undefined, {
				signal: controller.signal,
				timeout: this.requestTimeoutMs,
			});
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

	/**
	 * Lists one page of the resources catalog. Cursor pagination is explicit:
	 * pass the previous page's `nextCursor` to fetch the next page. The raw URI
	 * never enters status or errors; summaries carry digest ids only.
	 *
	 * A server without the `resources` capability throws a fixed
	 * `mcp_resource_unavailable` error without calling an undeclared SDK API.
	 * Transport/content failures mark the server degraded. Cancellation rejects
	 * with an AbortError without degrading. Never starts a model.
	 */
	async listResources(
		params?: { cursor?: string },
		signal?: AbortSignal,
	): Promise<MCPResourceListResult> {
		const client = this.requireReady();
		if (client.getServerCapabilities()?.resources === undefined) {
			throw new MCPContentError("mcp_resource_unavailable", this.config.id);
		}
		return this.runCatalogOp(async (controller) => {
			const result = await client.listResources(params, {
				timeout: this.requestTimeoutMs,
				signal: controller.signal,
			});
			const resources = normalizeMCPResourceSummaries(
				this.config.id,
				result.resources as unknown as ReadonlyArray<unknown>,
				this.contentLimits,
			);
			for (const entry of result.resources as unknown as ReadonlyArray<{ uri?: unknown }>) {
				if (typeof entry.uri === "string") {
					this.resourceUris.set(mcpResourceId(this.config.id, entry.uri), entry.uri);
				}
			}
			this.catalogStale = false;
			return { serverId: this.config.id, resources, ...(result.nextCursor !== undefined ? { nextCursor: result.nextCursor } : {}) };
		}, signal, "mcp_resource_unavailable");
	}

	/**
	 * Lists one page of the resource templates catalog. Follows the same
	 * contract as {@link listResources}. Never starts a model.
	 */
	async listResourceTemplates(
		params?: { cursor?: string },
		signal?: AbortSignal,
	): Promise<MCPResourceTemplateListResult> {
		const client = this.requireReady();
		if (client.getServerCapabilities()?.resources === undefined) {
			throw new MCPContentError("mcp_resource_unavailable", this.config.id);
		}
		return this.runCatalogOp(async (controller) => {
			const result = await client.listResourceTemplates(params, {
				timeout: this.requestTimeoutMs,
				signal: controller.signal,
			});
			const resourceTemplates = normalizeMCPResourceTemplateSummaries(
				this.config.id,
				result.resourceTemplates as unknown as ReadonlyArray<unknown>,
				this.contentLimits,
			);
			this.catalogStale = false;
			return {
				serverId: this.config.id,
				resourceTemplates,
				...(result.nextCursor !== undefined ? { nextCursor: result.nextCursor } : {}),
			};
		}, signal, "mcp_resource_unavailable");
	}

	/**
	 * Resolves a listed catalog resourceId to the raw URI held only in this
	 * lifecycle. Undefined when the id was never listed in this connection.
	 */
	getResourceUri(resourceId: string): string | undefined {
		return this.resourceUris.get(resourceId);
	}

	/**
	 * Resolves a listed catalog promptId to the sanitized prompt name.
	 * Undefined when the id was never listed in this connection.
	 */
	getPromptName(promptId: string): string | undefined {
		return this.promptNames.get(promptId);
	}

	/**
	 * Reads one resource by its URI. The URI is validated, used once for the
	 * request, and never retained: the result carries a digest resourceId and
	 * untrusted provenance only. Never starts a model.
	 */
	async readResource(uri: string, signal?: AbortSignal): Promise<MCPReadResourceResult> {
		const client = this.requireReady();
		const resolvedUri = this.resourceUris.get(uri) ?? uri;
		const safeUri = validateMCPResourceUri(resolvedUri, this.config.id);
		if (client.getServerCapabilities()?.resources === undefined) {
			throw new MCPContentError("mcp_resource_unavailable", this.config.id);
		}
		return this.runCatalogOp(async (controller) => {
			const result = await client.readResource(
				{ uri: safeUri },
				{ timeout: this.requestTimeoutMs, signal: controller.signal },
			);
			return normalizeMCPResourceRead(
				this.config.id,
				safeUri,
				result.contents as unknown as ReadonlyArray<unknown>,
				this.contentLimits,
			);
		}, signal, "mcp_resource_unavailable");
	}

	/**
	 * Lists one page of the prompts catalog. Follows the same contract as
	 * {@link listResources}. Never starts a model.
	 */
	async listPrompts(
		params?: { cursor?: string },
		signal?: AbortSignal,
	): Promise<MCPPromptListResult> {
		const client = this.requireReady();
		if (client.getServerCapabilities()?.prompts === undefined) {
			throw new MCPContentError("mcp_prompt_unavailable", this.config.id);
		}
		return this.runCatalogOp(async (controller) => {
			const result = await client.listPrompts(params, {
				timeout: this.requestTimeoutMs,
				signal: controller.signal,
			});
			const prompts = normalizeMCPPromptSummaries(
				this.config.id,
				result.prompts as unknown as ReadonlyArray<unknown>,
				this.contentLimits,
			);
			for (const prompt of prompts) {
				this.promptNames.set(prompt.promptId, prompt.name);
			}
			this.catalogStale = false;
			return { serverId: this.config.id, prompts, ...(result.nextCursor !== undefined ? { nextCursor: result.nextCursor } : {}) };
		}, signal, "mcp_prompt_unavailable");
	}

	/**
	 * Gets one prompt with its argument values. The name and argument values
	 * are validated, used once for the request, and never retained; the result
	 * carries a digest promptId and untrusted provenance. Never starts a model.
	 */
	async getPrompt(
		name: string,
		args?: Record<string, string>,
		signal?: AbortSignal,
	): Promise<MCPGetPromptResult> {
		const client = this.requireReady();
		const resolvedName = this.promptNames.get(name) ?? name;
		const safeName = validateMCPPromptName(resolvedName, this.config.id);
		const safeArgs = validateMCPPromptArguments(args, this.contentLimits, this.config.id);
		if (client.getServerCapabilities()?.prompts === undefined) {
			throw new MCPContentError("mcp_prompt_unavailable", this.config.id);
		}
		return this.runCatalogOp(async (controller) => {
			const result = await client.getPrompt(
				{ name: safeName, arguments: safeArgs },
				{ timeout: this.requestTimeoutMs, signal: controller.signal },
			);
			return normalizeMCPPromptGet(
				this.config.id,
				safeName,
				result.messages as unknown as ReadonlyArray<unknown>,
				this.contentLimits,
			);
		}, signal, "mcp_prompt_unavailable");
	}

	/**
	 * Runs a catalog operation (list/read/get) under abort and timeout control.
	 * Caller cancellation rejects with AbortError without degrading; a server
	 * that advertises the top-level capability but does not implement the method
	 * surfaces the fixed unavailable code without degrading (other resources and
	 * prompts keep working); any other failure (transport or content) marks the
	 * server degraded and throws the fixed error or capability_mcp_unavailable.
	 */
	private async runCatalogOp<T>(
		operation: (controller: AbortController) => Promise<T>,
		signal: AbortSignal | undefined,
		unsupportedCode: "mcp_resource_unavailable" | "mcp_prompt_unavailable",
	): Promise<T> {
		if (signal?.aborted) throw abortError(signal);
		const controller = new AbortController();
		this.inflightOps.add(controller);
		const onAbort = (): void => {
			controller.abort(signal?.reason);
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		try {
			const result = await raceWithAbort(operation(controller), signal);
			if (signal?.aborted) throw abortError(signal);
			return result;
		} catch (error) {
			if (signal?.aborted) {
				throw error instanceof DOMException && error.name === "AbortError" ? error : abortError(signal);
			}
			if (this.state === "closing" || this.state === "closed") {
				throw this.failure("unavailable");
			}
			if (error instanceof MCPContentError) {
				this.markDegraded();
				throw error;
			}
			if (isMCPMethodNotSupported(error)) {
				// Method-not-found is a capability fact: the fixed unavailable code
				// is returned and the server is NOT degraded, so its supported
				// resources/prompts remain usable.
				throw new MCPContentError(unsupportedCode, this.config.id);
			}
			this.markDegraded();
			throw this.failure("unavailable");
		} finally {
			signal?.removeEventListener("abort", onAbort);
			this.inflightOps.delete(controller);
		}
	}

	/** Gracefully closes the connection and releases the child process / transport. */
	async close(): Promise<void> {
		if (this.state === "closing" || this.state === "closed") {
			return;
		}
		this.setState("closing");
		// Pending catalog operations are cancelled so close never waits on a
		// remote list/read/get; the close proceeds immediately.
		for (const controller of this.inflightOps) {
			controller.abort(new Error("MCP server connection closing"));
		}
		this.inflightOps.clear();
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
		// Drop the transport reference so a late close notification from the just-
		// closed transport cannot revive into a subsequent reconnected connection.
		this.transport = undefined;
		this.resourceUris.clear();
		this.promptNames.clear();
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
		for (const controller of this.inflightOps) {
			controller.abort(new Error("MCP server connection force-closed"));
		}
		this.inflightOps.clear();
		await this.close();
	}

	private resolveAuthProvider(): OAuthClientProvider | undefined {
		if (this.authProvider === undefined) {
			return undefined;
		}
		return typeof this.authProvider === "function" ? this.authProvider(this.config) : this.authProvider;
	}

	private requireReady(): Client {
		if (this.state === "ready" && this.client !== undefined) {
			return this.client;
		}
		throw this.failure("unavailable");
	}

	private chainTransportHandlers(transport: Transport): void {
		this.transport = transport;
		const originalOnError = transport.onerror;
		const originalOnClose = transport.onclose;
		// Only the transport backing the current connection may move the state
		// machine; a closed transport's late events must not revive into a fresh
		// reconnected lifecycle.
		transport.onerror = (error: Error): void => {
			if (this.transport !== transport) {
				return;
			}
			originalOnError?.(error);
			this.markDegraded();
		};
		transport.onclose = (): void => {
			if (this.transport !== transport) {
				return;
			}
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
	/** Per-server deselection closes, coalesced so overlapping updates await one teardown. */
	private readonly deselectionCloses = new Map<string, Promise<void>>();

	constructor(options: MCPLifecycleManagerOptions = {}) {
		this.options = options;
		// Copy the set so later mutation of the caller's Set cannot change selection.
		this.selectedServerIds = options.selectedServerIds === undefined ? new Set() : new Set(options.selectedServerIds);
	}

	/** Registers configured servers. Duplicate ids are rejected; nothing connects. */
	registerServers(configs: ReadonlyArray<MCPServerConfig>): void {
		for (const config of configs) {
			if (this.lifecycles.has(config.id)) {
				throw new MCPLifecycleError("invalid_config", config.id, `Duplicate MCP server id: "${config.id}"`);
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

	/**
	 * Replaces the selected server ids with a copy (mutating the caller Set is
	 * inert) and closes every registered server the new selection removes.
	 *
	 * The gate updates synchronously, so the most recent call wins immediately
	 * even while earlier closes are still in flight, and the returned promise
	 * never blocks a newer selection from taking effect. Removed servers are
	 * closed asynchronously and the promise settles only after each removed
	 * server's transport is released.
	 *
	 * Race contract: overlapping calls coalesce per-server close work, so two
	 * calls deselecting the same server await one teardown and the transport is
	 * released exactly once. A server re-selected by a newer call before its
	 * close is invoked is not closed — its live connection is preserved. Once a
	 * close has been invoked it completes and the server stays `closed`; the
	 * manager never silently reopens a deselected or closed lifecycle.
	 */
	async setSelectedServerIds(ids: ReadonlySet<string> | ReadonlyArray<string>): Promise<void> {
		const newSelection = new Set(ids);
		const removed = [...this.selectedServerIds].filter(
			(serverId) => !newSelection.has(serverId) && this.lifecycles.has(serverId),
		);
		this.selectedServerIds = newSelection;
		await Promise.all(removed.map((serverId) => this.closeDeselected(serverId)));
	}

	/**
	 * Closes a deselected server, coalescing concurrent closes of the same
	 * server onto one teardown and superseding a close that a newer selection
	 * update cancelled by re-selecting the server.
	 */
	private closeDeselected(serverId: string): Promise<void> {
		const pending = this.deselectionCloses.get(serverId);
		if (pending !== undefined) {
			return pending;
		}
		const close = Promise.resolve().then(async () => {
			// Re-check the latest selection: a newer update may have re-selected
			// this server before its close was invoked, superseding the close so
			// the live connection is preserved instead of being torn down.
			if (this.isSelected(serverId)) {
				return;
			}
			const lifecycle = this.lifecycles.get(serverId);
			if (lifecycle === undefined) {
				return;
			}
			await lifecycle.close().catch(() => undefined);
		});
		const settled = close.finally(() => {
			this.deselectionCloses.delete(serverId);
		});
		this.deselectionCloses.set(serverId, settled);
		return settled;
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
	async connect(serverId: string, signal?: AbortSignal): Promise<void> {
		const lifecycle = this.requireServer(serverId);
		this.assertSelected(serverId);
		await lifecycle.connect(signal);
	}

	/** Lists tools of a connected, selected server. */
	async listTools(serverId: string, signal?: AbortSignal): Promise<Tool[]> {
		const lifecycle = this.requireServer(serverId);
		this.assertSelected(serverId);
		return lifecycle.listTools(signal);
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

	/** Lists one page of the resources catalog of a selected server. */
	async listResources(
		serverId: string,
		params?: { cursor?: string },
		signal?: AbortSignal,
	): Promise<MCPResourceListResult> {
		const lifecycle = this.requireServer(serverId);
		this.assertSelected(serverId);
		return lifecycle.listResources(params, signal);
	}

	/** Lists one page of the resource templates catalog of a selected server. */
	async listResourceTemplates(
		serverId: string,
		params?: { cursor?: string },
		signal?: AbortSignal,
	): Promise<MCPResourceTemplateListResult> {
		const lifecycle = this.requireServer(serverId);
		this.assertSelected(serverId);
		return lifecycle.listResourceTemplates(params, signal);
	}

	/**
	 * Resolves a listed catalog resourceId to the raw URI held only in the
	 * selected server's lifecycle. Undefined when the id was never listed.
	 */
	getResourceUri(serverId: string, resourceId: string): string | undefined {
		return this.lifecycles.get(serverId)?.getResourceUri(resourceId);
	}

	/**
	 * Resolves a listed catalog promptId to the sanitized prompt name.
	 * Undefined when the id was never listed.
	 */
	getPromptName(serverId: string, promptId: string): string | undefined {
		return this.lifecycles.get(serverId)?.getPromptName(promptId);
	}

	/** Reads one resource of a selected server; the URI is never retained. */
	async readResource(serverId: string, uri: string, signal?: AbortSignal): Promise<MCPReadResourceResult> {
		const lifecycle = this.requireServer(serverId);
		this.assertSelected(serverId);
		return lifecycle.readResource(uri, signal);
	}

	/** Lists one page of the prompts catalog of a selected server. */
	async listPrompts(
		serverId: string,
		params?: { cursor?: string },
		signal?: AbortSignal,
	): Promise<MCPPromptListResult> {
		const lifecycle = this.requireServer(serverId);
		this.assertSelected(serverId);
		return lifecycle.listPrompts(params, signal);
	}

	/** Gets one prompt of a selected server; name and argument values are never retained. */
	async getPrompt(
		serverId: string,
		name: string,
		args?: Record<string, string>,
		signal?: AbortSignal,
	): Promise<MCPGetPromptResult> {
		const lifecycle = this.requireServer(serverId);
		this.assertSelected(serverId);
		return lifecycle.getPrompt(name, args, signal);
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
