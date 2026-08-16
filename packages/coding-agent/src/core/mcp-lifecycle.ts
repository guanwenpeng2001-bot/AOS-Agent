import { Client } from "@modelcontextprotocol/sdk/client";
import { UnauthorizedError, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import {
	getDefaultEnvironment,
	StdioClientTransport,
	type StdioServerParameters,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport";
import {
	PromptListChangedNotificationSchema,
	ResourceListChangedNotificationSchema,
	type Tool,
} from "@modelcontextprotocol/sdk/types";
import {
	applyPageLimit,
	DEFAULT_MCP_CONTENT_LIMITS,
	DEFAULT_MCP_PAGE_LIMITS,
	mapPromptToView,
	mapResourceTemplateToView,
	mapResourceToView,
	mcpContentProvenanceId,
	mcpContentRevision,
	mcpPromptId,
	mcpResourceId,
	normalizeContentBlocks,
	normalizeResourceContents,
	utf8ByteLength,
	type MCPContentLimits,
	type MCPGetPromptResult,
	type MCPPageLimits,
	type MCPPageResult,
	type MCPPromptView,
	type MCPReadResourceResult,
	type MCPResourceTemplateView,
	type MCPResourceView,
} from "./mcp-content-types.ts";
import type { MCPAuthOutcome } from "./mcp-auth.ts";
import {
	createMCPServerConfigView,
	type MCPCallResult,
	type MCPConnectionState,
	type MCPConnectionStatus,
	type MCPEnvResolver,
	type MCPError,
	type MCPErrorKind,
	type MCPErrorView,
	MCPError as MCPLifecycleError,
	type MCPServerConfig,
	type MCPServerConfigView,
	type MCPStdioServerConfig,
	type MCPStreamableHttpServerConfig,
	type MCPToolContentBlock,
	type MCPTransportFactory,
	type MCPTransportFactoryOptions,
	mcpNamespaceSegmentError,
	mcpStateToAvailability,
	validateMCPServerConfig,
} from "./mcp-types.ts";

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
		case "content_invalid":
			return `MCP server "${serverId}" returned or accepted invalid content`;
		case "content_limit_exceeded":
			return `MCP server "${serverId}" content exceeded the configured limits`;
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
	options?: MCPTransportFactoryOptions,
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
		...(options?.authProvider === undefined ? {} : { authProvider: options.authProvider }),
	});
}

/** Default transport factory used in production. Tests inject an in-memory factory. */
export function createMCPDefaultTransportFactory(): MCPTransportFactory {
	return (config: MCPServerConfig, env: MCPEnvResolver, options?: MCPTransportFactoryOptions): Transport => {
		switch (config.transport) {
			case "stdio":
				return createMCPStdioTransport(config, env);
			case "streamable-http":
				return createMCPHttpTransport(config, env, options);
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
	/** Normalization limits for resource/prompt content; defaults to {@link DEFAULT_MCP_CONTENT_LIMITS}. */
	contentLimits?: MCPContentLimits;
	/** Per-page item cap for paginated listings; defaults to {@link DEFAULT_MCP_PAGE_LIMITS}. */
	pageLimits?: MCPPageLimits;
	/**
	 * Session-scoped OAuth hooks for this server. Only Streamable HTTP
	 * transports ever receive the auth provider; stdio is untouched.
	 */
	auth?: MCPServerAuthHooks;
}

/**
 * Session-scoped OAuth integration for one MCP server.
 *
 * The provider is attached as `StreamableHTTPClientTransport.authProvider` so
 * the SDK performs exactly one token refresh and exactly one request retry per
 * 401 for connect/list/read/get/call. When an operation still surfaces
 * `UnauthorizedError` (no tokens, refresh failed, or interactive authorization
 * is pending), the lifecycle invokes `refresh` exactly once and retries the
 * operation exactly once before classifying the failure as `auth_required`.
 * `refresh` must be single-flight (concurrent callers join one attempt).
 */
export interface MCPServerAuthHooks {
	/** SDK OAuth client provider bound to the session+server flow. */
	authProvider?: OAuthClientProvider;
	/**
	 * Attempts one token refresh; resolves `authorized` when a usable token was
	 * produced, or the terminal outcome otherwise. Never throws for auth
	 * failures; lifecycle failures classify as `auth_required`.
	 */
	refresh?: () => Promise<MCPAuthOutcome>;
}

const DEFAULT_ENV_RESOLVER: MCPEnvResolver = (name) => process.env[name];

/** Snapshot of the listed catalog identities of one connection. */
export interface McpCatalogIdentitySnapshot {
	resourceUris: ReadonlyMap<string, string>;
	templatePatterns: ReadonlyMap<string, string>;
	promptNames: ReadonlyMap<string, string>;
	resourceMetadata: ReadonlyMap<string, { provenanceId: string; revision: string }>;
	promptMetadata: ReadonlyMap<string, { provenanceId: string; revision: string }>;
}

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
	private readonly contentLimits: MCPContentLimits;
	private readonly pageLimits: MCPPageLimits;
	private readonly auth: MCPServerAuthHooks | undefined;
	private client: Client | undefined;
	/** Client created for a connect that has not settled; close must not orphan it. */
	private pendingClient: Client | undefined;
	/** The transport backing the current connection; a stale closed transport is ignored. */
	private transport: Transport | undefined;
	private connectionState: MCPConnectionState;
	private connectPromise: Promise<void> | undefined;
	private readonly inflightCalls = new Set<AbortController>();
	private connectedAt: string | undefined;
	private lastError: MCPErrorView | undefined;
	private toolCount: number | undefined;
	private resourceCount: number | undefined;
	private promptCount: number | undefined;
	/** Opaque resource id -> raw URI of the last listed catalog page. Never surfaced. */
	private readonly resourceUris = new Map<string, string>();
	/** Opaque template id -> raw uri template of the last listed catalog page. Never surfaced. */
	private readonly templatePatterns = new Map<string, string>();
	/** Opaque prompt id -> server-facing prompt name of the last listed catalog page. */
	private readonly promptNames = new Map<string, string>();
	/** Opaque resource id -> provenance/revision of the last listed catalog page. */
	private readonly resourceMetadata = new Map<string, { provenanceId: string; revision: string }>();
	/** Opaque prompt id -> provenance/revision of the last listed catalog page. */
	private readonly promptMetadata = new Map<string, { provenanceId: string; revision: string }>();
	/** Incremented on every successful (re)connect; results from a superseded connection are stale. */
	private connectionEpoch = 0;
	/**
	 * Set by `notifications/resources/list_changed` and
	 * `notifications/prompts/list_changed`; cleared by the next explicit
	 * cursorless listing. Notifications never auto-refresh the catalog, never
	 * touch a frozen binding, and never attach anything.
	 */
	private catalogStale = false;

	constructor(config: MCPServerConfig, options: MCPServerLifecycleOptions = {}) {
		this.config = config;
		this.env = options.env ?? DEFAULT_ENV_RESOLVER;
		this.transportFactory = options.transportFactory ?? createMCPDefaultTransportFactory();
		this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
		this.contentLimits = options.contentLimits ?? DEFAULT_MCP_CONTENT_LIMITS;
		this.pageLimits = options.pageLimits ?? DEFAULT_MCP_PAGE_LIMITS;
		this.auth = options.auth;
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

	/** Opaque-id resolution for listed catalog items; the raw values never surface publicly. */
	resolveResourceUri(resourceId: string): string | undefined {
		return this.resourceUris.get(resourceId);
	}

	resolveResourceUriTemplate(templateId: string): string | undefined {
		return this.templatePatterns.get(templateId);
	}

	resolvePromptName(promptId: string): string | undefined {
		return this.promptNames.get(promptId);
	}

	getStatus(): MCPConnectionStatus {
		return {
			serverId: this.config.id,
			state: this.state,
			availability: mcpStateToAvailability(this.state),
			...(this.connectedAt !== undefined ? { connectedAt: this.connectedAt } : {}),
			...(this.lastError !== undefined ? { lastError: this.lastError } : {}),
			...(this.toolCount !== undefined ? { toolCount: this.toolCount } : {}),
			...(this.resourceCount !== undefined ? { resourceCount: this.resourceCount } : {}),
			...(this.promptCount !== undefined ? { promptCount: this.promptCount } : {}),
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
			let transport: Transport | undefined;
			let authRetried = false;
			while (true) {
				try {
					transport = await this.transportFactory(this.config, this.env, {
						authProvider: this.auth?.authProvider,
					});
					if (signal?.aborted) {
						const abortedTransport = transport;
						transport = undefined;
						await abortedTransport.close?.().catch(() => undefined);
						throw abortError(signal);
					}
					if (this.isClosingOrClosed()) {
						const closedTransport = transport;
						transport = undefined;
						await closedTransport.close?.().catch(() => undefined);
						throw this.failure("unavailable");
					}
					pendingClient = new Client({ name: MCP_CLIENT_NAME, version: MCP_CLIENT_VERSION });
					this.pendingClient = pendingClient;
					await pendingClient.connect(transport, { timeout: this.requestTimeoutMs, signal });
					break;
				} catch (error) {
					if (pendingClient !== undefined && this.pendingClient === pendingClient) {
						this.pendingClient = undefined;
						await pendingClient.close().catch(() => undefined);
					} else {
						await transport?.close?.().catch(() => undefined);
					}
					pendingClient = undefined;
					transport = undefined;
					if (error instanceof UnauthorizedError && !authRetried && this.auth?.refresh !== undefined) {
						authRetried = true;
						let outcome: MCPAuthOutcome;
						try {
							outcome = await this.auth.refresh();
						} catch {
							throw this.authFailure();
						}
						if (outcome === "authorized") continue;
						throw this.authFailure();
					}
					throw error;
				}
			}
			if (pendingClient === undefined || transport === undefined) {
				throw this.failure("connect_failed");
			}
			if (signal?.aborted) {
				const abortedClient = pendingClient;
				pendingClient = undefined;
				if (this.pendingClient === abortedClient) this.pendingClient = undefined;
				await abortedClient.close().catch(() => undefined);
				throw abortError(signal);
			}
			if (this.isClosingOrClosed()) {
				const closedClient = pendingClient;
				pendingClient = undefined;
				if (this.pendingClient === closedClient) this.pendingClient = undefined;
				await closedClient.close().catch(() => undefined);
				throw this.failure("unavailable");
			}
			this.client = pendingClient;
			this.chainTransportHandlers(transport);
			this.connectionEpoch += 1;
			// list_changed notifications only mark the catalog stale; the SDK
			// auto-refresh listChanged config is deliberately not used, so a
			// notification can never trigger a refresh, binding change, or attach.
			this.client.setNotificationHandler(ResourceListChangedNotificationSchema, () => {
				this.catalogStale = true;
			});
			this.client.setNotificationHandler(PromptListChangedNotificationSchema, () => {
				this.catalogStale = true;
			});
			// A new connection owns a fresh catalog generation: raw identities
			// and metadata of a superseded connection must never resolve.
			this.resourceUris.clear();
			this.templatePatterns.clear();
			this.promptNames.clear();
			this.resourceMetadata.clear();
			this.promptMetadata.clear();
			this.catalogStale = false;
			this.setState("ready");
			this.connectedAt = new Date().toISOString();
			this.lastError = undefined;
			this.toolCount = undefined;
			this.resourceCount = undefined;
			this.promptCount = undefined;
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
			const kind: MCPErrorKind =
				error instanceof MCPLifecycleError
					? error.kind
					: error instanceof UnauthorizedError
						? "auth_required"
						: "connect_failed";
			this.setState("unavailable");
			this.recordError(kind);
			throw error instanceof MCPLifecycleError ? error : this.failure(kind);
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
			const result = await this.runWithSingleAuthRetry(() =>
				raceWithAbort(client.listTools({}, { timeout: this.requestTimeoutMs, signal }), signal),
			);
			if (signal?.aborted) throw abortError(signal);
			this.toolCount = result.tools.length;
			this.lastError = undefined;
			return result.tools;
		} catch (error) {
			if (signal?.aborted) {
				throw error instanceof DOMException && error.name === "AbortError" ? error : abortError(signal);
			}
			if (error instanceof MCPLifecycleError) {
				throw error;
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
			const result = await this.runWithSingleAuthRetry(() =>
				client.callTool({ name: toolName, arguments: args }, undefined, {
					signal: controller.signal,
					timeout: this.requestTimeoutMs,
				}),
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
		} catch (error) {
			if (signal?.aborted) {
				throw new DOMException(`MCP tool call "${toolName}" was aborted`, "AbortError");
			}
			if (error instanceof MCPLifecycleError) {
				throw error;
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
	 * Lists one page of resources. `cursor` is the server-returned continuation
	 * cursor from a previous page; the result carries the next cursor when the
	 * server has more. Requires the server to advertise the `resources`
	 * capability; absence is a redacted failure that does not degrade the
	 * connection. A transport-level failure marks the server degraded.
	 */
	async listResources(cursor?: string, signal?: AbortSignal): Promise<MCPPageResult<MCPResourceView>> {
		return this.guardedRequest(
			async (client, innerSignal) => {
				this.assertAdvertisedCapability(client, "resources");
				const result = await client.listResources(
					{ ...(cursor !== undefined ? { cursor } : {}) },
					{ timeout: this.requestTimeoutMs, signal: innerSignal },
				);
				this.resourceCount = result.resources.length;
				if (cursor === undefined) {
					// A full listing refreshes the catalog generation.
					this.catalogStale = false;
				}
				const views: MCPResourceView[] = [];
				for (const resource of result.resources) {
					const view = mapResourceToView(resource, this.contentLimits, this.config.id);
					if (view !== undefined) {
						// Keep the raw URI only for the in-memory resolution of
						// later reads; it never leaves the lifecycle.
						this.resourceUris.set(view.resourceId, resource.uri);
						this.resourceMetadata.set(view.resourceId, {
							provenanceId: view.provenanceId,
							revision: view.revision,
						});
						views.push(view);
					}
				}
				return applyPageLimit(views, result.nextCursor, this.pageLimits);
			},
			"MCP resource listing was aborted",
			signal,
		);
	}

	/** Lists one page of resource templates with the same contract as listResources. */
	async listResourceTemplates(
		cursor?: string,
		signal?: AbortSignal,
	): Promise<MCPPageResult<MCPResourceTemplateView>> {
		return this.guardedRequest(
			async (client, innerSignal) => {
				this.assertAdvertisedCapability(client, "resources");
				const result = await client.listResourceTemplates(
					{ ...(cursor !== undefined ? { cursor } : {}) },
					{ timeout: this.requestTimeoutMs, signal: innerSignal },
				);
				const templateViews: MCPResourceTemplateView[] = [];
				if (cursor === undefined) {
					// A full listing refreshes the catalog generation.
					this.catalogStale = false;
				}
				for (const template of result.resourceTemplates) {
					const view = mapResourceTemplateToView(template, this.contentLimits, this.config.id);
					if (view !== undefined) {
						this.templatePatterns.set(view.templateId, template.uriTemplate);
						templateViews.push(view);
					}
				}
				return applyPageLimit(templateViews, result.nextCursor, this.pageLimits);
			},
			"MCP resource template listing was aborted",
			signal,
		);
	}

	/**
	 * Reads a resource and normalizes its contents under the configured limits.
	 * The URI must be non-empty, free of whitespace and control characters, and
	 * bounded in length; anything else fails closed without a server round trip.
	 * A transport-level failure marks the server degraded; cancelling the
	 * caller signal rejects with an AbortError without degrading the server.
	 */
	async readResource(uri: string, signal?: AbortSignal): Promise<MCPReadResourceResult> {
		if (uri.length === 0) {
			throw new MCPLifecycleError(
				"invalid_config",
				this.config.id,
				`MCP server "${this.config.id}" does not accept an empty resource uri`,
			);
		}
		if (uri.length > this.contentLimits.maxResourceUriLength || /[\u0000-\u001f\u007f\s]/u.test(uri)) {
			throw new MCPLifecycleError("content_invalid", this.config.id, mcpFailureMessage("content_invalid", this.config.id));
		}
		return this.guardedRequest(
			async (client, innerSignal) => {
				this.assertAdvertisedCapability(client, "resources");
				const result = await client.readResource({ uri }, { timeout: this.requestTimeoutMs, signal: innerSignal });
				const resourceId = mcpResourceId(this.config.id, uri);
				const metadata = this.resourceMetadata.get(resourceId);
				const content = normalizeResourceContents(result.contents, this.contentLimits);
				return {
					serverId: this.config.id,
					resourceId,
					content,
					byteCount: content.byteCount,
					truncated: content.truncated,
					provenanceId: metadata?.provenanceId ?? mcpContentProvenanceId(uri),
					revision: metadata?.revision ?? mcpContentRevision(this.config.id, uri),
				};
			},
			"MCP resource read was aborted",
			signal,
		);
	}

	/**
	 * Lists one page of prompts with the same contract as listResources, gated
	 * on the server advertising the `prompts` capability.
	 */
	async listPrompts(cursor?: string, signal?: AbortSignal): Promise<MCPPageResult<MCPPromptView>> {
		return this.guardedRequest(
			async (client, innerSignal) => {
				this.assertAdvertisedCapability(client, "prompts");
				const result = await client.listPrompts(
					{ ...(cursor !== undefined ? { cursor } : {}) },
					{ timeout: this.requestTimeoutMs, signal: innerSignal },
				);
				this.promptCount = result.prompts.length;
				if (cursor === undefined) {
					// A full listing refreshes the catalog generation.
					this.catalogStale = false;
				}
				const promptViews: MCPPromptView[] = [];
				for (const prompt of result.prompts) {
					const view = mapPromptToView(prompt, this.contentLimits, this.config.id);
					if (view !== undefined) {
						this.promptNames.set(view.promptId, prompt.name);
						this.promptMetadata.set(view.promptId, {
							provenanceId: view.provenanceId,
							revision: view.revision,
						});
						promptViews.push(view);
					}
				}
				return applyPageLimit(promptViews, result.nextCursor, this.pageLimits);
			},
			"MCP prompt listing was aborted",
			signal,
		);
	}

	/**
	 * Fetches a prompt and normalizes every message's content under the
	 * configured limits. The prompt name must be a valid, bounded namespace
	 * segment; argument values are bounded per value and in total and are
	 * otherwise passed through to the server only.
	 */
	async getPrompt(
		promptName: string,
		args?: Readonly<Record<string, string>>,
		signal?: AbortSignal,
	): Promise<MCPGetPromptResult> {
		const nameError = mcpNamespaceSegmentError(promptName);
		if (nameError !== undefined || promptName.length > this.contentLimits.maxFieldLength) {
			throw new MCPLifecycleError(
				"invalid_config",
				this.config.id,
				`MCP prompt name "${promptName}" ${nameError ?? "exceeds the maximum length"}`,
			);
		}
		if (args !== undefined) {
			let totalBytes = 0;
			for (const value of Object.values(args)) {
				const valueBytes = utf8ByteLength(value);
				if (valueBytes > this.contentLimits.maxPromptArgumentBytes) {
					throw new MCPLifecycleError(
						"content_limit_exceeded",
						this.config.id,
						mcpFailureMessage("content_limit_exceeded", this.config.id),
					);
				}
				totalBytes += valueBytes;
			}
			if (totalBytes > this.contentLimits.maxPromptArgumentsBytes) {
				throw new MCPLifecycleError(
					"content_limit_exceeded",
					this.config.id,
					mcpFailureMessage("content_limit_exceeded", this.config.id),
				);
			}
		}
		return this.guardedRequest(
			async (client, innerSignal) => {
				this.assertAdvertisedCapability(client, "prompts");
				const result = await client.getPrompt(
					{ name: promptName, ...(args !== undefined ? { arguments: { ...args } } : {}) },
					{ timeout: this.requestTimeoutMs, signal: innerSignal },
				);
				const promptId = mcpPromptId(this.config.id, promptName);
				const metadata = this.promptMetadata.get(promptId);
				return {
					serverId: this.config.id,
					promptId,
					...(result.description !== undefined
						? { description: result.description.slice(0, this.contentLimits.maxFieldLength) }
						: {}),
					messages: result.messages.map((message) => ({
						role: message.role,
						content: normalizeContentBlocks([message.content], this.contentLimits),
					})),
					provenanceId: metadata?.provenanceId ?? mcpContentProvenanceId(promptName),
					revision: metadata?.revision ?? mcpContentRevision(this.config.id, promptName),
				};
			},
			`MCP prompt "${promptName}" was aborted`,
			signal,
		);
	}

	/**
	 * Snapshots the listed catalog identities (raw URIs, template patterns,
	 * prompt names, item metadata) so a policy-boundary close+reconnect can
	 * restore them. A true {@link close} or a failed reconnect invalidates them,
	 * so stale catalog ids can never read through a fresh connection.
	 */
	snapshotCatalogIdentities(): McpCatalogIdentitySnapshot {
		return {
			resourceUris: new Map(this.resourceUris),
			templatePatterns: new Map(this.templatePatterns),
			promptNames: new Map(this.promptNames),
			resourceMetadata: new Map(this.resourceMetadata),
			promptMetadata: new Map(this.promptMetadata),
		};
	}

	/** Restores a previously snapshotted catalog identity set. */
	restoreCatalogIdentities(snapshot: McpCatalogIdentitySnapshot): void {
		this.resourceUris.clear();
		for (const [key, value] of snapshot.resourceUris) {
			this.resourceUris.set(key, value);
		}
		this.templatePatterns.clear();
		for (const [key, value] of snapshot.templatePatterns) {
			this.templatePatterns.set(key, value);
		}
		this.promptNames.clear();
		for (const [key, value] of snapshot.promptNames) {
			this.promptNames.set(key, value);
		}
		this.resourceMetadata.clear();
		for (const [key, value] of snapshot.resourceMetadata) {
			this.resourceMetadata.set(key, value);
		}
		this.promptMetadata.clear();
		for (const [key, value] of snapshot.promptMetadata) {
			this.promptMetadata.set(key, value);
		}
	}

	/**
	 * Reconnects the connection for a policy-binding change. Catalog identity
	 * preservation is the caller's job through {@link snapshotCatalogIdentities}
	 * / {@link restoreCatalogIdentities}; a plain close or failed reconnect
	 * invalidates them.
	 */
	async reconnect(signal?: AbortSignal): Promise<void> {
		await this.close();
		await this.connect(signal);
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
		// Drop the transport reference so a late close notification from the just-
		// closed transport cannot revive into a subsequent reconnected connection.
		this.transport = undefined;
		this.resourceUris.clear();
		this.templatePatterns.clear();
		this.promptNames.clear();
		this.resourceMetadata.clear();
		this.promptMetadata.clear();
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

	/**
	 * Rejects when the current client did not advertise the given capability.
	 * The failure is redacted and fail-closed: a server that never offered the
	 * capability is not degraded, only reported as not providing it.
	 */
	private assertAdvertisedCapability(client: Client, capability: "resources" | "prompts"): void {
		const serverCapabilities = client.getServerCapabilities();
		const advertised = capability === "resources" ? serverCapabilities?.resources : serverCapabilities?.prompts;
		if (advertised === undefined) {
			throw new MCPLifecycleError(
				"unavailable",
				this.config.id,
				`MCP server "${this.config.id}" does not advertise the "${capability}" capability`,
			);
		}
	}

	/**
	 * Runs one server request under the lifecycle's failure contract: redacted
	 * errors, caller-signal cancellation, in-flight teardown on forceClose, and
	 * stale-result rejection. A result settling after the connection was
	 * replaced belongs to a superseded connection and is discarded even when
	 * the request itself succeeded; a stale failure never degrades the fresh
	 * connection. Transport-level failures mark the server degraded.
	 */
	private async guardedRequest<T>(
		run: (client: Client, signal: AbortSignal) => Promise<T>,
		abortMessage: string,
		signal?: AbortSignal,
	): Promise<T> {
		if (signal?.aborted) throw abortError(signal);
		const client = this.requireReady();
		const epoch = this.connectionEpoch;
		const controller = new AbortController();
		this.inflightCalls.add(controller);
		const onAbort = (): void => {
			controller.abort(signal?.reason);
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		try {
			const result = await this.runWithSingleAuthRetry(() => raceWithAbort(run(client, controller.signal), signal));
			if (signal?.aborted) throw abortError(signal);
			if (epoch !== this.connectionEpoch || this.client !== client) {
				throw this.failure("unavailable");
			}
			this.lastError = undefined;
			return result;
		} catch (error) {
			if (epoch !== this.connectionEpoch || this.client !== client) {
				// The request failed on (or raced with) a superseded connection;
				// the fresh connection must not be degraded for it.
				throw this.failure("unavailable");
			}
			if (error instanceof MCPLifecycleError) {
				// Redacted, already-classified failure raised by the operation
				// itself (for example a missing advertised capability).
				throw error;
			}
			if (signal?.aborted) {
				throw new DOMException(abortMessage, "AbortError");
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
	 * Runs an operation under the exactly-one refresh/retry contract. When the
	 * operation fails with `UnauthorizedError`, `auth.refresh` is invoked
	 * exactly once (the session-level refresh is single-flight) and the
	 * operation is retried exactly once when the refresh produced a usable
	 * token. A second `UnauthorizedError` — or any refresh failure — classifies
	 * as `auth_required` with a fixed redacted message and never degrades the
	 * connection: the same transport remains usable once authorization
	 * completes.
	 */
	private async runWithSingleAuthRetry<T>(run: () => Promise<T>): Promise<T> {
		try {
			return await run();
		} catch (error) {
			if (!(error instanceof UnauthorizedError)) {
				throw error;
			}
			if (this.auth?.refresh === undefined) {
				throw this.authFailure();
			}
			let outcome: MCPAuthOutcome;
			try {
				outcome = await this.auth.refresh();
			} catch {
				// Refresh failures are never surfaced raw; without a usable token
				// the operation is not retried.
				throw this.authFailure();
			}
			if (outcome !== "authorized") {
				throw this.authFailure();
			}
			try {
				return await run();
			} catch (retryError) {
				if (retryError instanceof UnauthorizedError) {
					throw this.authFailure();
				}
				throw retryError;
			}
		}
	}

	private authFailure(): MCPError {
		this.recordError("auth_required");
		return this.failure("auth_required");
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
	/** Per-server OAuth hooks; only Streamable HTTP servers use them. */
	authFor?: (serverId: string) => MCPServerAuthHooks | undefined;
}

/**
 * Owns all configured MCP servers and enforces the selected-binding gate:
 * only servers the current binding selected may connect, list tools, or be
 * called. Registration never auto-connects.
 */
export class MCPLifecycleManager {
	private readonly options: MCPServerLifecycleOptions;
	private readonly authFor: ((serverId: string) => MCPServerAuthHooks | undefined) | undefined;
	private readonly lifecycles = new Map<string, MCPServerLifecycle>();
	private selectedServerIds: ReadonlySet<string>;
	/** Per-server deselection closes, coalesced so overlapping updates await one teardown. */
	private readonly deselectionCloses = new Map<string, Promise<void>>();

	constructor(options: MCPLifecycleManagerOptions = {}) {
		this.options = options;
		this.authFor = options.authFor;
		// Copy the set so later mutation of the caller's Set cannot change selection.
		this.selectedServerIds = options.selectedServerIds === undefined ? new Set() : new Set(options.selectedServerIds);
	}

	/** Registers configured servers. Duplicate ids are rejected; nothing connects. */
	registerServers(configs: ReadonlyArray<MCPServerConfig>): void {
		for (const config of configs) {
			if (this.lifecycles.has(config.id)) {
				throw new MCPLifecycleError("invalid_config", config.id, `Duplicate MCP server id: "${config.id}"`);
			}
			this.lifecycles.set(
				config.id,
				new MCPServerLifecycle(config, {
					...this.options,
					...(this.authFor === undefined ? {} : { auth: this.authFor(config.id) }),
				}),
			);
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

	/**
	 * Resolves the raw URI of a listed resource by its opaque id. Returns
	 * undefined when the id is unknown (never listed, or listed before the
	 * current connection). The URI is never exposed through public views.
	 */
	getResourceUri(serverId: string, resourceId: string): string | undefined {
		return this.lifecycles.get(serverId)?.resolveResourceUri(resourceId);
	}

	/** Resolves the raw uri template of a listed resource template by its opaque id. */
	getResourceUriTemplate(serverId: string, templateId: string): string | undefined {
		return this.lifecycles.get(serverId)?.resolveResourceUriTemplate(templateId);
	}

	/** Resolves the server-facing prompt name of a listed prompt by its opaque id. */
	getPromptName(serverId: string, promptId: string): string | undefined {
		return this.lifecycles.get(serverId)?.resolvePromptName(promptId);
	}

	/**
	 * Reconnects a selected server for a policy-binding change. Catalog identity
	 * preservation is the caller's job through {@link snapshotCatalogIdentities}
	 * / {@link restoreCatalogIdentities}; a plain close or failed reconnect
	 * invalidates them.
	 */
	async reconnect(serverId: string, signal?: AbortSignal): Promise<void> {
		const lifecycle = this.requireServer(serverId);
		this.assertSelected(serverId);
		await lifecycle.reconnect(signal);
	}

	/** Snapshots the listed catalog identities of one registered server. */
	snapshotCatalogIdentities(serverId: string): unknown {
		return this.lifecycles.get(serverId)?.snapshotCatalogIdentities();
	}

	/** Restores a previously snapshotted catalog identity set of one server. */
	restoreCatalogIdentities(serverId: string, snapshot: unknown): void {
		this.lifecycles
			.get(serverId)
			?.restoreCatalogIdentities(snapshot as Parameters<MCPServerLifecycle["restoreCatalogIdentities"]>[0]);
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

	/** Lists one page of resources on a connected, selected server. */
	async listResources(
		serverId: string,
		cursor?: string,
		signal?: AbortSignal,
	): Promise<MCPPageResult<MCPResourceView>> {
		const lifecycle = this.requireServer(serverId);
		this.assertSelected(serverId);
		return lifecycle.listResources(cursor, signal);
	}

	/** Lists one page of resource templates on a connected, selected server. */
	async listResourceTemplates(
		serverId: string,
		cursor?: string,
		signal?: AbortSignal,
	): Promise<MCPPageResult<MCPResourceTemplateView>> {
		const lifecycle = this.requireServer(serverId);
		this.assertSelected(serverId);
		return lifecycle.listResourceTemplates(cursor, signal);
	}

	/** Reads a resource on a connected, selected server. */
	async readResource(serverId: string, uri: string, signal?: AbortSignal): Promise<MCPReadResourceResult> {
		const lifecycle = this.requireServer(serverId);
		this.assertSelected(serverId);
		return lifecycle.readResource(uri, signal);
	}

	/** Lists one page of prompts on a connected, selected server. */
	async listPrompts(
		serverId: string,
		cursor?: string,
		signal?: AbortSignal,
	): Promise<MCPPageResult<MCPPromptView>> {
		const lifecycle = this.requireServer(serverId);
		this.assertSelected(serverId);
		return lifecycle.listPrompts(cursor, signal);
	}

	/** Fetches a prompt on a connected, selected server. */
	async getPrompt(
		serverId: string,
		promptName: string,
		args?: Readonly<Record<string, string>>,
		signal?: AbortSignal,
	): Promise<MCPGetPromptResult> {
		const lifecycle = this.requireServer(serverId);
		this.assertSelected(serverId);
		return lifecycle.getPrompt(promptName, args, signal);
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
