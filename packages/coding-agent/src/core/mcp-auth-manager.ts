/**
 * Session-scoped MCP OAuth manager.
 *
 * Owns the MCP OAuth wiring for exactly ONE AgentSession: one
 * {@link MCPAuthFlow} per MCP server id, token persistence through
 * {@link MCPAuthStorage} in the MCP credential namespace
 * (`mcp__<installationId>__<serverIdentity>`), and the session's
 * streamable-http auth provider seam. The manager is never shared across
 * sessions; each session builds its own instance and disposes it on teardown.
 *
 * Contract:
 * - stdio configs never receive an OAuth provider; only streamable-http
 *   configs resolve one (`getProvider`).
 * - Interactive authorization always runs through the caller-supplied
 *   `AuthInteraction` confirm/cancel + `auth_url` steps inside the flow;
 *   nothing opens a browser or approves automatically. `start()` is the only
 *   entry point that authorizes.
 * - The transport-facing provider (`MCPAuthManagerProvider`) reads tokens from
 *   and writes them to the MCP credential namespace only. Tokens never enter
 *   session state, runs, audit, context, errors, or logs.
 * - Every failure is a classified {@link MCPAuthError} or a fixed-message
 *   error; raw tokens, URLs, and remote error text never surface.
 */

import { join } from "node:path";
import type { AuthInteraction, CredentialStore } from "@aos-agent/ai";
import type { OAuthClientProvider, OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import { AuthStorage } from "./auth-storage.ts";
import { MCPAuthError, MCPAuthFlow, type MCPAuthCallbackMode, type MCPAuthResult } from "./mcp-auth.ts";
import {
	canonicalizeMCPServerUrl,
	deriveMCPServerIdentity,
	getMCPAuthInstallationId,
	listMCPCredentialStatuses,
	MCPAuthStorage,
	type MCPCredentialStatus,
	type MCPStoredTokens,
	type MCPTokenResponse,
} from "./mcp-auth-storage.ts";
import type { MCPServerConfig } from "./mcp-types.ts";

export interface MCPAuthManagerOptions {
	/** CredentialStore backing the MCP credential namespace (AuthStorage). */
	store: CredentialStore;
	/** Opaque per-install namespace segment; see {@link getMCPAuthInstallationId}. */
	installationId: string;
	/** Injectable fetch for discovery/token/revocation calls (tests). */
	fetch?: FetchLike;
	/** Aborts in-flight authorization flows. */
	signal?: AbortSignal;
}

/** Options for an explicit interactive authorization (`start`). */
/**
 * Default session wiring for `createAgentSession` and
 * `createAgentSessionServices`: a session-scoped {@link MCPAuthManager}
 * backed by the shared agent auth namespace (the `auth.json`
 * {@link AuthStorage} credential store) and this agentDir's per-install
 * namespace identity. Callers override this per session by supplying an
 * explicit {@link MCPAuthManagerOptions}.
 */
export function createDefaultMCPAuthManagerOptions(agentDir: string): MCPAuthManagerOptions {
	return {
		store: AuthStorage.create(join(agentDir, "auth.json")),
		installationId: getMCPAuthInstallationId(agentDir),
	};
}

export interface MCPAuthStartOptions {
	/** App interaction surface: confirm/cancel, auth_url notification, manual code. */
	interaction: AuthInteraction;
	/** Fixed callback shape; defaults to loopback. */
	callbackMode?: MCPAuthCallbackMode;
	/** Fixed HTTPS redirect URI; required when `callbackMode` is `https`. */
	httpsCallbackUrl?: string | URL;
	/** Deadline for the interactive callback capture. */
	timeoutMs?: number;
	/** Per-HTTP-request deadline. */
	requestTimeoutMs?: number;
}

export type MCPAuthStartResult =
	| { status: "authorized" }
	| { status: "already_authorized" }
	| { status: "not_required" };

/** Flow creation options of an explicit interactive start. */
interface MCPAuthFlowStartOptions {
	callbackMode?: MCPAuthCallbackMode;
	httpsCallbackUrl?: string | URL;
	timeoutMs?: number;
	requestTimeoutMs?: number;
}

/** True when two flow option sets create equivalent flows. */
function sameFlowStartOptions(
	a: MCPAuthFlowStartOptions | undefined,
	b: MCPAuthFlowStartOptions,
): boolean {
	if (a === undefined) {
		return (
			b.callbackMode === undefined &&
			b.httpsCallbackUrl === undefined &&
			b.timeoutMs === undefined &&
			b.requestTimeoutMs === undefined
		);
	}
	return (
		a.callbackMode === b.callbackMode &&
		String(a.httpsCallbackUrl ?? "") === String(b.httpsCallbackUrl ?? "") &&
		a.timeoutMs === b.timeoutMs &&
		a.requestTimeoutMs === b.requestTimeoutMs
	);
}

interface MCPAuthManagerServer {
	/** Canonical server URL; the credential namespace is bound to it. */
	serverUrl: string;
	storage: MCPAuthStorage;
	/** One-shot flow; replaced when consumed (failed start, logout). */
	flow: MCPAuthFlow | undefined;
	provider: MCPAuthManagerProvider | undefined;
	/** Options the current flow was created with; undefined when the provider seam created it. */
	flowOptions: MCPAuthFlowStartOptions | undefined;
}

/** Maps SDK OAuthTokens (seconds-based expiry) to the storage token response shape. */
function toMCPTokenResponse(tokens: OAuthTokens): MCPTokenResponse {
	return {
		access_token: tokens.access_token,
		token_type: tokens.token_type,
		...(tokens.expires_in !== undefined ? { expires_in: tokens.expires_in } : {}),
		...(tokens.scope !== undefined ? { scope: tokens.scope } : {}),
		...(tokens.refresh_token !== undefined ? { refresh_token: tokens.refresh_token } : {}),
		...(tokens.id_token !== undefined ? { id_token: tokens.id_token } : {}),
	};
}

/** Maps stored namespace credentials to the SDK OAuthTokens shape. */
function toOAuthTokens(stored: MCPStoredTokens): OAuthTokens {
	return {
		access_token: stored.access,
		token_type: stored.tokenType,
		...(stored.refresh.length > 0 ? { refresh_token: stored.refresh } : {}),
		...(stored.scope !== undefined ? { scope: stored.scope } : {}),
		...(stored.idToken !== undefined ? { id_token: stored.idToken } : {}),
		...(stored.expires > 0
			? { expires_in: Math.max(1, Math.round((stored.expires - Date.now()) / 1000)) }
			: {}),
	};
}

/**
 * Transport-facing OAuthClientProvider for one MCP server in one session.
 *
 * Token reads and writes go through the MCP credential namespace only:
 * `tokens()` loads the stored credential (so a fresh session serves
 * previously granted tokens) and `saveTokens()` persists every grant and
 * refresh rotation. Interactive steps (state, code verifier, redirect,
 * discovery state) delegate to the session's one-shot {@link MCPAuthFlow},
 * whose `beginAuthorization` always requires the `AuthInteraction`
 * confirm/cancel step — nothing redirects without user confirmation.
 */
export class MCPAuthManagerProvider implements OAuthClientProvider {
	private readonly flow: MCPAuthFlow;
	private readonly storage: MCPAuthStorage;

	constructor(flow: MCPAuthFlow, storage: MCPAuthStorage) {
		this.flow = flow;
		this.storage = storage;
	}

	/**
	 * The flow's callback URL once the interactive flow armed it, undefined
	 * otherwise. A provider that never ran an interactive authorization cannot
	 * start one here; the caller must use the manager's explicit `start()`.
	 */
	get redirectUrl(): string | undefined {
		try {
			return this.flow.callbackUrlOrThrow();
		} catch {
			return undefined;
		}
	}

	get clientMetadata(): OAuthClientMetadata {
		return this.flow.provider.clientMetadata;
	}

	state(): string | Promise<string> {
		return this.flow.provider.state();
	}

	clientInformation(): OAuthClientInformationMixed | undefined {
		return this.flow.provider.clientInformation();
	}

	saveClientInformation(clientInformation: OAuthClientInformationMixed): void {
		this.flow.provider.saveClientInformation(clientInformation);
	}

	/** Loads the stored namespace credential, or undefined when none is bound. */
	async tokens(): Promise<OAuthTokens | undefined> {
		const stored = await this.storage.readTokens();
		return stored === undefined ? undefined : toOAuthTokens(stored);
	}

	/**
	 * Persists granted or refreshed tokens into the namespace. The binding
	 * (issuer/resource) comes from the flow's validated discovery state when
	 * available; otherwise the storage re-binds against the existing
	 * credential, so a refresh on a fresh session cannot move tokens to a
	 * different authorization server.
	 */
	async saveTokens(tokens: OAuthTokens): Promise<void> {
		const discovery = this.flow.provider.discoveryState();
		await this.storage.saveTokens(toMCPTokenResponse(tokens), {
			issuer: discovery?.authorizationServerUrl,
			resource: discovery?.resourceMetadata?.resource,
		});
	}

	redirectToAuthorization(authorizationUrl: URL): Promise<void> {
		return this.flow.beginAuthorization(authorizationUrl);
	}

	saveCodeVerifier(codeVerifier: string): void {
		this.flow.provider.saveCodeVerifier(codeVerifier);
	}

	codeVerifier(): string {
		return this.flow.provider.codeVerifier();
	}

	validateResourceURL(serverUrl: string | URL, resource?: string): Promise<URL | undefined> {
		return this.flow.provider.validateResourceURL(serverUrl, resource);
	}

	/** Clears in-memory session state; stored namespace credentials are untouched. */
	invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
		this.flow.provider.invalidateCredentials(scope);
	}

	saveDiscoveryState(state: OAuthDiscoveryState): void {
		this.flow.provider.saveDiscoveryState(state);
	}

	discoveryState(): OAuthDiscoveryState | undefined {
		return this.flow.provider.discoveryState();
	}
}

/**
 * Session-scoped MCP OAuth manager. See the module doc for the contract.
 */
export class MCPAuthManager {
	private readonly store: CredentialStore;
	private readonly installationId: string;
	private readonly fetchImpl: FetchLike | undefined;
	private readonly signal: AbortSignal | undefined;
	private readonly servers = new Map<string, MCPAuthManagerServer>();

	constructor(options: MCPAuthManagerOptions) {
		this.store = options.store;
		this.installationId = options.installationId;
		this.fetchImpl = options.fetch;
		this.signal = options.signal;
	}

	/**
	 * Resolves the session's OAuth client provider for a server config, or
	 * undefined when the server must never run OAuth (stdio). For
	 * streamable-http configs the provider is the storage-backed
	 * {@link MCPAuthManagerProvider} of the config's per-session flow. One
	 * provider instance never crosses sessions.
	 */
	getProvider(config: MCPServerConfig): OAuthClientProvider | undefined {
		if (config.transport !== "streamable-http") {
			return undefined;
		}
		return this.ensureProvider(config.id, config.url);
	}

	/**
	 * Explicit interactive authorization for one MCP server. Runs the one-shot
	 * {@link MCPAuthFlow}: validated discovery, `AuthInteraction`
	 * confirm/cancel, callback capture, code exchange; then persists the
	 * granted tokens into the MCP credential namespace bound to the canonical
	 * server identity. Never starts a model, run, or browser: authorization
	 * only proceeds after the interaction confirms.
	 *
	 * Resolves `already_authorized` without any interaction when the namespace
	 * already holds a credential for this server. A consumed flow (failed
	 * attempt) is replaced, so a later `start()` can retry.
	 */
	async start(serverId: string, serverUrl: string | URL, options: MCPAuthStartOptions): Promise<MCPAuthStartResult> {
		const server = this.ensureServer(serverId, serverUrl);
		if ((await server.storage.readTokens()) !== undefined) {
			return { status: "already_authorized" };
		}
		const flowOptions: MCPAuthFlowStartOptions = {
			callbackMode: options.callbackMode,
			httpsCallbackUrl: options.httpsCallbackUrl,
			timeoutMs: options.timeoutMs,
			requestTimeoutMs: options.requestTimeoutMs,
		};
		if (server.flow !== undefined && !sameFlowStartOptions(server.flowOptions, flowOptions)) {
			// A flow created by the transport provider seam (default loopback
			// options) or by an earlier start with different options cannot
			// serve this start; replace it together with its provider. A flow
			// that never ran authorize() is recreatable with the new options.
			server.flow = undefined;
			server.provider = undefined;
		}
		server.flowOptions = flowOptions;
		const flow = this.ensureFlow(server, serverId);
		flow.setInteraction(options.interaction);
		let result: MCPAuthResult;
		try {
			result = await flow.authorize();
		} catch (error) {
			server.flow = undefined;
			server.provider = undefined;
			throw error;
		}
		if (result.status === "not_required") {
			return { status: "not_required" };
		}
		const tokens = flow.provider.tokens();
		if (tokens === undefined) {
			server.flow = undefined;
			server.provider = undefined;
			throw new MCPAuthError("auth_failed", serverId);
		}
		const discovery = flow.provider.discoveryState();
		try {
			await server.storage.saveTokens(toMCPTokenResponse(tokens), {
				issuer: discovery?.authorizationServerUrl,
				resource: discovery?.resourceMetadata?.resource,
			});
		} catch (error) {
			server.flow = undefined;
			server.provider = undefined;
			throw error;
		}
		return { status: "authorized" };
	}

	/**
	 * Masked credential status for one canonical server identity, or undefined
	 * when nothing is stored. Works for any streamable-http URL even when this
	 * session never touched the server. Token values are never surfaced.
	 */
	async getStatus(serverUrl: string | URL): Promise<MCPCredentialStatus | undefined> {
		const identity = deriveMCPServerIdentity(this.installationId, String(serverUrl));
		const statuses = await listMCPCredentialStatuses(this.store, this.installationId);
		return statuses.find((status) => status.serverIdentity === identity);
	}

	/** Masked status for every stored MCP credential in this installation's namespace. */
	async listStatuses(): Promise<readonly MCPCredentialStatus[]> {
		return listMCPCredentialStatuses(this.store, this.installationId);
	}

	/**
	 * Logout for one server: best-effort RFC 7009 revocation when the
	 * authorization server advertises a revocation endpoint, then local
	 * deletion of the namespaced credential, then invalidation of the
	 * session's in-memory flow state. A revocation failure never blocks
	 * deletion. `serverUrl` (the canonical streamable-http URL) lets a fresh
	 * session that never resolved a provider or ran a flow for this server
	 * still delete a previously stored credential; without a known URL the
	 * call is a no-op for a server this session never touched. Binding the
	 * URL never creates an OAuth flow or provider, so stdio servers stay
	 * provider-free and a no-flow logout skips revocation (best effort).
	 */
	async logout(serverId: string, serverUrl?: string | URL): Promise<void> {
		let server = this.servers.get(serverId);
		if (server === undefined) {
			if (serverUrl === undefined) {
				return;
			}
			server = this.ensureServer(serverId, serverUrl);
		}
		const revoke = this.createRevoker(server);
		server.flow?.provider.invalidateCredentials("all");
		server.flow = undefined;
		server.provider = undefined;
		server.flowOptions = undefined;
		await server.storage.logout(revoke);
	}

	/** Releases all per-server flow state. Does not delete stored credentials. */
	dispose(): void {
		this.servers.clear();
	}

	private ensureServer(serverId: string, serverUrl: string | URL): MCPAuthManagerServer {
		const existing = this.servers.get(serverId);
		if (existing !== undefined) {
			return existing;
		}
		const canonical = canonicalizeMCPServerUrl(String(serverUrl));
		const server: MCPAuthManagerServer = {
			serverUrl: canonical,
			storage: new MCPAuthStorage({ store: this.store, installationId: this.installationId, serverUrl: canonical }),
			flow: undefined,
			provider: undefined,
			flowOptions: undefined,
		};
		this.servers.set(serverId, server);
		return server;
	}

	private ensureProvider(serverId: string, serverUrl: string | URL): MCPAuthManagerProvider {
		const server = this.ensureServer(serverId, serverUrl);
		if (server.provider !== undefined) {
			return server.provider;
		}
		const flow = this.ensureFlow(server, serverId);
		const provider = new MCPAuthManagerProvider(flow, server.storage);
		server.provider = provider;
		return provider;
	}

	private ensureFlow(server: MCPAuthManagerServer, serverId: string): MCPAuthFlow {
		if (server.flow !== undefined) {
			return server.flow;
		}
		const flow = new MCPAuthFlow({
			serverId,
			serverUrl: server.serverUrl,
			...server.flowOptions,
			fetch: this.fetchImpl,
			signal: this.signal,
		});
		server.flow = flow;
		return flow;
	}

	private createRevoker(
		server: MCPAuthManagerServer,
	): ((tokens: MCPStoredTokens) => Promise<void>) | undefined {
		const metadata = server.flow?.provider.discoveryState()?.authorizationServerMetadata as
			| { revocation_endpoint?: string }
			| undefined;
		const endpoint = metadata?.revocation_endpoint;
		if (endpoint === undefined) {
			return undefined;
		}
		const fetchImpl = this.fetchImpl ?? fetch;
		return async (tokens) => {
			const body = new URLSearchParams();
			body.set("token", tokens.access);
			body.set("token_type_hint", "access_token");
			const response = await fetchImpl(endpoint, {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: body.toString(),
			});
			if (!response.ok) {
				// Fixed message; the storage logout swallows revocation failures.
				throw new Error("revocation request failed");
			}
		};
	}
}
