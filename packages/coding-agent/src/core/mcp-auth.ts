/**
 * Host-side MCP OAuth core (Streamable HTTP only).
 *
 * Implements the OAuth 2.1 Authorization Code + PKCE client flow for MCP
 * Streamable HTTP servers on top of the pinned `@modelcontextprotocol/sdk`
 * 1.30.0 types and helpers (`OAuthClientProvider`, `auth`,
 * `discoverOAuthServerInfo`, `refreshAuthorization`). stdio servers never
 * enter this module; model provider OAuth is untouched.
 *
 * Ownership boundaries (Task B of the MCP OAuth plan):
 * - This file only: OAuth metadata validation, canonical resource / issuer
 *   binding, HTTPS / loopback redirect policy, one state+PKCE flow per
 *   session+server, cancellation / timeout, headless interaction behavior,
 *   fixed redacted errors, refresh with at most one attempt per 401, and the
 *   `OAuthClientProvider` adapter that a later task supplies as
 *   `StreamableHTTPClientTransport.authProvider`.
 * - Secrets (access/refresh tokens, code verifier, authorization code, client
 *   secret) live in memory only for the duration of the session. Persistence
 *   is injected through the {@link MCPAuthStore} interface; this file does not
 *   implement a second store. A record is only read back when its binding
 *   (server identity, issuer, canonical resource) matches the session.
 * - Every failure is a {@link MCPAuthError} with a fixed, redacted message.
 *   Raw remote text, tokens, authorization URLs, metadata URLs, issuer and
 *   resource values never enter errors, status views, or logs.
 */

import { randomBytes } from "node:crypto";
import type { AuthInteraction } from "@aos-agent/ai";
import {
	auth,
	discoverOAuthServerInfo,
	refreshAuthorization,
	type OAuthClientProvider,
	type OAuthDiscoveryState,
	type OAuthServerInfo,
} from "@modelcontextprotocol/sdk/client/auth.js";
import {
	InvalidClientError,
	InvalidGrantError,
	OAuthError,
	ServerError,
	TemporarilyUnavailableError,
} from "@modelcontextprotocol/sdk/server/auth/errors.js";
import type {
	AuthorizationServerMetadata,
	OAuthClientInformationMixed,
	OAuthClientMetadata,
	OAuthProtectedResourceMetadata,
	OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport";

/** Default bound for every OAuth HTTP request (discovery, registration, token). */
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
/** Default bound for the interactive authorization callback wait. */
const DEFAULT_AUTHORIZATION_TIMEOUT_MS = 300_000;
/** Clock skew tolerated before an access token counts as expired. */
const TOKEN_EXPIRY_SKEW_MS = 30_000;
/** PKCE challenge method this host supports. */
const PKCE_CHALLENGE_METHOD = "S256";
/** Fixed instruction text shown next to the one-time authorization URL. */
const MCP_AUTH_INSTRUCTIONS =
	"Authorize this MCP server in your browser, then return to the application.";

/** Loopback host names accepted for http redirect URIs and endpoints. */
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/**
 * Per-session OAuth context. One flow per (sessionId, serverId) is enforced by
 * {@link MCPAuthSession}; concurrent flows for the same key join the active one.
 */
export interface MCPAuthContext {
	/** MCP server id from the server configuration. */
	serverId: string;
	/** Installation-scoped source identity the credential record binds to. */
	serverIdentity: string;
	/**
	 * Explicit canonical RFC 8707 resource. When omitted, the canonical
	 * resource is the protected resource metadata `resource`, falling back to
	 * the server URL. A metadata resource that conflicts with an explicit
	 * canonical resource fails closed.
	 */
	canonicalResource?: string;
	/** Session id; flows and in-memory secrets never cross sessions. */
	sessionId: string;
	/** Cancellation for the whole session flow. */
	signal?: AbortSignal;
}

/** Host-provided OAuth options for one MCP server. */
export interface MCPAuthOptions {
	/** MCP server endpoint (the OAuth protected resource). */
	serverUrl: string | URL;
	/**
	 * Redirect URI for the authorization callback. Must be https or an http
	 * loopback URL; anything else fails closed at session creation.
	 */
	redirectUrl: string | URL;
	/**
	 * Explicit canonical resource override. Defaults to the protected resource
	 * metadata `resource`, then to the server URL.
	 */
	canonicalResource?: string | URL;
	/**
	 * Static public client id. When absent, the flow uses dynamic client
	 * registration (RFC 7591) through the SDK helper; a server that supports
	 * neither registration nor a static client fails closed.
	 */
	clientId?: string;
	/** Optional scope requested on authorization and token requests. */
	scope?: string;
	/** Client name used for dynamic registration metadata. */
	clientName?: string;
	/** Injectable fetch for tests; defaults to the global fetch. */
	fetchFn?: FetchLike;
	/** Bound for each OAuth HTTP request; defaults to 15s. */
	requestTimeoutMs?: number;
	/** Bound for the interactive callback wait; defaults to 5 minutes. */
	authorizationTimeoutMs?: number;
}

/** OAuth flow states of one session+server (plan §3.1 state machine). */
export type MCPAuthState =
	| "unauthenticated"
	| "discovering"
	| "interaction_required"
	| "authorizing"
	| "exchanging"
	| "refreshing"
	| "authenticated"
	| "expired"
	| "invalid"
	| "unavailable";

/** Non-secret status view. Never carries tokens, URLs, issuer or resource values. */
export interface MCPAuthStatus {
	serverId: string;
	state: MCPAuthState;
	/** ISO time when the access token expires; present while a known expiry exists. */
	expiresAt?: string;
}

/** Terminal outcomes of a user-facing authorization call. */
export type MCPAuthOutcome = "authorized" | "interaction_required" | "cancelled" | "timeout";

/** Result of an authorization / refresh call. */
export interface MCPAuthResult {
	outcome: MCPAuthOutcome;
	status: MCPAuthStatus;
	/**
	 * One-time authorization URL, present only with outcome
	 * `interaction_required`. Intended for a single interactive display; it is
	 * never persisted into status, logs, receipts, or errors.
	 */
	authorizationUrl?: string;
}

/**
 * Stable MCP OAuth error taxonomy. Messages are fixed templates; remote error
 * text, tokens, URLs, issuer and resource values are never retained.
 */
export type MCPAuthErrorKind =
	| "mcp_auth_required"
	| "mcp_auth_interaction_required"
	| "mcp_auth_metadata_invalid"
	| "mcp_auth_state_mismatch"
	| "mcp_auth_resource_mismatch"
	| "mcp_auth_invalid"
	| "mcp_auth_cancelled"
	| "mcp_auth_timeout"
	| "mcp_auth_unavailable"
	| "mcp_auth_invalid_redirect"
	| "mcp_auth_unsupported";

/** Redacted, serializable view of an MCP OAuth failure. */
export interface MCPAuthErrorView {
	kind: MCPAuthErrorKind;
	serverId: string;
	message: string;
}

function mcpAuthErrorMessage(kind: MCPAuthErrorKind, serverId: string): string {
	switch (kind) {
		case "mcp_auth_required":
			return `MCP server "${serverId}" requires authentication`;
		case "mcp_auth_interaction_required":
			return `MCP server "${serverId}" requires user interaction to authorize`;
		case "mcp_auth_metadata_invalid":
			return `MCP server "${serverId}" exposed invalid OAuth metadata`;
		case "mcp_auth_state_mismatch":
			return `MCP server "${serverId}" OAuth callback does not match the current flow`;
		case "mcp_auth_resource_mismatch":
			return `MCP server "${serverId}" OAuth resource or issuer does not match the configured binding`;
		case "mcp_auth_invalid":
			return `MCP server "${serverId}" OAuth credentials are invalid or expired`;
		case "mcp_auth_cancelled":
			return `MCP server "${serverId}" OAuth authorization was cancelled`;
		case "mcp_auth_timeout":
			return `MCP server "${serverId}" OAuth authorization timed out`;
		case "mcp_auth_unavailable":
			return `MCP server "${serverId}" OAuth authorization server is unavailable`;
		case "mcp_auth_invalid_redirect":
			return `MCP server "${serverId}" OAuth redirect URL must use https or an http loopback address`;
		case "mcp_auth_unsupported":
			return `MCP server "${serverId}" does not support OAuth on this transport`;
	}
}

/**
 * OAuth failure with a fixed, redacted message. The raw cause is never stored,
 * so it cannot leak through JSON serialization or error inspection.
 */
export class MCPAuthError extends Error {
	readonly kind: MCPAuthErrorKind;
	readonly serverId: string;

	constructor(kind: MCPAuthErrorKind, serverId: string) {
		super(mcpAuthErrorMessage(kind, serverId));
		this.name = "MCPAuthError";
		this.kind = kind;
		this.serverId = serverId;
	}

	toJSON(): MCPAuthErrorView {
		return { kind: this.kind, serverId: this.serverId, message: this.message };
	}
}

/** Type guard for {@link MCPAuthError}. */
export function isMCPAuthError(error: unknown): error is MCPAuthError {
	return error instanceof MCPAuthError;
}

/**
 * Non-secret binding of a stored credential record. The record is only usable
 * when every field matches the current session's binding.
 */
export interface MCPAuthRecordBinding {
	serverIdentity: string;
	serverId: string;
	/** Canonical RFC 8707 resource the tokens were issued for. */
	canonicalResource: string;
	/** Authorization server URL the tokens were issued by. */
	issuer: string;
	/** Static client id, when the host configuration pins one. */
	clientId?: string;
	/** Requested OAuth scope, when the host configuration pins one. */
	scope?: string;
}

/**
 * OAuth credential record persisted through {@link MCPAuthStore}.
 *
 * This file only defines the contract; the CredentialStore-backed namespace
 * adapter is a later task. Records written here always carry the full binding
 * and are rejected on read when the binding changed.
 */
export interface MCPStoredOAuthRecord extends MCPAuthRecordBinding {
	clientId?: string;
	scope?: string;
	tokenType: string;
	accessToken: string;
	refreshToken?: string;
	/** Epoch milliseconds when the access token expires. */
	expiresAt?: number;
	/** Epoch milliseconds of the last write. */
	updatedAt: number;
}

/**
 * Storage injection point for MCP credentials. Task B keeps secrets in memory;
 * the interface exists so a later task can back it with the CredentialStore
 * namespace adapter without changing this module. Implementations may be
 * best-effort: read/write failures are tolerated by the session.
 */
export interface MCPAuthStore {
	read(binding: MCPAuthRecordBinding): Promise<MCPStoredOAuthRecord | undefined>;
	save(record: MCPStoredOAuthRecord): Promise<void>;
	delete(binding: MCPAuthRecordBinding): Promise<void>;
}

/**
 * Validates a redirect URI for the authorization callback. Returns a fixed
 * reason when the URL is not acceptable, or undefined when it is.
 *
 * Policy: only https, or http on the loopback interface (localhost, 127.0.0.1,
 * [::1]). Userinfo is rejected. Custom schemes (e.g. app deep links) are not
 * spec-compliant for MCP OAuth and fail closed.
 */
export function validateMCPRedirectUrl(url: string | URL): string | undefined {
	let parsed: URL;
	try {
		parsed = typeof url === "string" ? new URL(url) : url;
	} catch {
		return "must be a valid URL";
	}
	if (parsed.username !== "" || parsed.password !== "") {
		return "must not contain userinfo";
	}
	if (parsed.protocol === "https:") {
		return undefined;
	}
	if (parsed.protocol === "http:" && LOOPBACK_HOSTNAMES.has(parsed.hostname)) {
		return undefined;
	}
	return "must use https or an http loopback address";
}

/** True when the URL is https or http on the loopback interface. */
function isSecureOAuthEndpoint(url: URL): boolean {
	if (url.protocol === "https:") {
		return true;
	}
	return url.protocol === "http:" && LOOPBACK_HOSTNAMES.has(url.hostname);
}

/**
 * Parses an endpoint field from SDK metadata (string | URL | null depending on
 * the metadata variant) and requires https or http loopback. Fail-closed: any
 * unparseable or insecure value throws a fixed error.
 */
function requireSecureOAuthUrl(value: unknown, serverId: string, kind: MCPAuthErrorKind): URL {
	let url: URL;
	try {
		url = value instanceof URL ? value : new URL(String(value));
	} catch {
		throw new MCPAuthError(kind, serverId);
	}
	if (!isSecureOAuthEndpoint(url)) {
		throw new MCPAuthError(kind, serverId);
	}
	return url;
}

/**
 * Normalizes a URL for binding comparisons: trailing slash removed from the
 * path, query and fragment stripped.
 */
function canonicalUrlString(url: string | URL): string {
	const parsed = new URL(String(url));
	let pathname = parsed.pathname;
	if (pathname.length > 1 && pathname.endsWith("/")) {
		pathname = pathname.slice(0, -1);
	}
	parsed.pathname = pathname;
	parsed.search = "";
	parsed.hash = "";
	return parsed.toString();
}

function normalizeOAuthScope(scope: string | undefined): string {
	return (scope ?? "")
		.split(/\s+/u)
		.filter((value) => value.length > 0)
		.sort()
		.join(" ");
}

/** Internal error signaling that a request exceeded its time bound. */
class MCPAuthTimeoutError extends Error {
	constructor() {
		super("MCP OAuth request timed out");
		this.name = "MCPAuthTimeoutError";
	}
}

interface Deferred<T> {
	promise: Promise<T>;
	resolve(value: T): void;
	reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

/** Rejects with the abort reason when `signal` fires first. */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
	if (signal === undefined) {
		return promise;
	}
	if (signal.aborted) {
		return Promise.reject(abortReason(signal));
	}
	return new Promise<T>((resolve, reject) => {
		const onAbort = (): void => reject(abortReason(signal));
		signal.addEventListener("abort", onAbort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

function abortReason(signal: AbortSignal): unknown {
	return signal.reason ?? new DOMException("Aborted", "AbortError");
}

/** Rejects with `onTimeout()` when the promise does not settle in time. */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, onTimeout: () => Error): Promise<T> {
	if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
		return promise;
	}
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(onTimeout()), timeoutMs);
		if (typeof timer.unref === "function") {
			timer.unref();
		}
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

/** Attaches a one-time abort listener; returns the removal function. */
function onAbortOnce(signal: AbortSignal | undefined, fn: () => void): () => void {
	if (signal === undefined) {
		return () => {};
	}
	signal.addEventListener("abort", fn, { once: true });
	return () => {
		signal.removeEventListener("abort", fn);
	};
}

function isAbortLike(error: unknown): boolean {
	return (
		(typeof error === "object" && error !== null && "name" in error && (error as { name?: unknown }).name === "AbortError") ||
		(error instanceof DOMException && error.name === "AbortError")
	);
}

function isZodError(error: unknown): boolean {
	return typeof error === "object" && error !== null && "name" in error && (error as { name?: unknown }).name === "ZodError";
}

/** Validates discovered OAuth metadata; throws fixed {@link MCPAuthError}s. */
function validateDiscoveredState(
	state: OAuthDiscoveryState,
	explicitCanonical: string | undefined,
	serverId: string,
): void {
	const metadataInvalid = (): never => {
		throw new MCPAuthError("mcp_auth_metadata_invalid", serverId);
	};
	const resourceMismatch = (): never => {
		throw new MCPAuthError("mcp_auth_resource_mismatch", serverId);
	};

	const resourceMetadata = state.resourceMetadata;
	if (resourceMetadata !== undefined) {
		validateProtectedResourceMetadata(resourceMetadata, explicitCanonical, serverId, resourceMismatch);
	}

	requireSecureOAuthUrl(state.authorizationServerUrl, serverId, "mcp_auth_metadata_invalid");

	const metadata = state.authorizationServerMetadata;
	if (metadata !== undefined) {
		validateAuthorizationServerMetadata(metadata, state.authorizationServerUrl, serverId, metadataInvalid, resourceMismatch);
	}
}

function validateProtectedResourceMetadata(
	metadata: OAuthProtectedResourceMetadata,
	explicitCanonical: string | undefined,
	serverId: string,
	resourceMismatch: () => never,
): void {
	requireSecureOAuthUrl(metadata.resource, serverId, "mcp_auth_metadata_invalid");
	if (
		explicitCanonical !== undefined &&
		canonicalUrlString(metadata.resource) !== canonicalUrlString(explicitCanonical)
	) {
		resourceMismatch();
	}
	for (const authorizationServer of metadata.authorization_servers ?? []) {
		requireSecureOAuthUrl(authorizationServer, serverId, "mcp_auth_metadata_invalid");
	}
	if (metadata.jwks_uri !== undefined) {
		requireSecureOAuthUrl(metadata.jwks_uri, serverId, "mcp_auth_metadata_invalid");
	}
}

function validateAuthorizationServerMetadata(
	metadata: AuthorizationServerMetadata,
	authorizationServerUrl: string,
	serverId: string,
	metadataInvalid: () => never,
	resourceMismatch: () => never,
): void {
	if (canonicalUrlString(metadata.issuer) !== canonicalUrlString(authorizationServerUrl)) {
		resourceMismatch();
	}
	requireSecureOAuthUrl(metadata.authorization_endpoint, serverId, "mcp_auth_metadata_invalid");
	requireSecureOAuthUrl(metadata.token_endpoint, serverId, "mcp_auth_metadata_invalid");
	if (metadata.registration_endpoint !== undefined) {
		requireSecureOAuthUrl(metadata.registration_endpoint, serverId, "mcp_auth_metadata_invalid");
	}
	if ("revocation_endpoint" in metadata && metadata.revocation_endpoint !== undefined) {
		requireSecureOAuthUrl(metadata.revocation_endpoint, serverId, "mcp_auth_metadata_invalid");
	}
	if (
		metadata.code_challenge_methods_supported !== undefined &&
		!metadata.code_challenge_methods_supported.includes(PKCE_CHALLENGE_METHOD)
	) {
		metadataInvalid();
	}
	if (!metadata.response_types_supported.includes("code")) {
		metadataInvalid();
	}
	if (
		metadata.grant_types_supported !== undefined &&
		!metadata.grant_types_supported.includes("authorization_code")
	) {
		metadataInvalid();
	}
	if ("jwks_uri" in metadata && metadata.jwks_uri !== undefined) {
		requireSecureOAuthUrl(metadata.jwks_uri, serverId, "mcp_auth_metadata_invalid");
	}
}

/**
 * Host-side OAuth provider owning one {@link MCPAuthSession} per
 * (sessionId, serverId). Later tasks pass the session's SDK adapter as
 * `StreamableHTTPClientTransport.authProvider` and drive interactive flows
 * through {@link MCPAuthSession.startInteractive}.
 */
export class MCPAuthProvider {
	private readonly store: MCPAuthStore | undefined;
	private readonly sessions = new Map<string, MCPAuthSession>();

	constructor(options: { store?: MCPAuthStore } = {}) {
		this.store = options.store;
	}

	private sessionKey(context: MCPAuthContext): string {
		return `${context.sessionId}\u0000${context.serverId}\u0000${context.serverIdentity}`;
	}

	/** Returns the session for the context, creating it on first use. */
	session(context: MCPAuthContext, options: MCPAuthOptions): MCPAuthSession {
		const key = this.sessionKey(context);
		let session = this.sessions.get(key);
		if (session === undefined) {
			session = new MCPAuthSession(context, options, this.store);
			this.sessions.set(key, session);
		}
		return session;
	}

	async getStatus(context: MCPAuthContext, options: MCPAuthOptions): Promise<MCPAuthStatus> {
		return this.session(context, options).getStatus();
	}

	async getAccessToken(
		context: MCPAuthContext,
		options: MCPAuthOptions,
		signal?: AbortSignal,
	): Promise<string | undefined> {
		return this.session(context, options).getAccessToken(signal);
	}

	async startInteractive(
		context: MCPAuthContext,
		options: MCPAuthOptions,
		interaction?: AuthInteraction,
	): Promise<MCPAuthResult> {
		return this.session(context, options).startInteractive(interaction);
	}

	/** Validates and delivers the authorization callback code. */
	async completeAuthorization(
		context: MCPAuthContext,
		options: MCPAuthOptions,
		code: string,
		params: { state?: string; redirectUri?: string },
	): Promise<void> {
		return this.session(context, options).completeAuthorization(code, params);
	}

	/** Awaits the outcome of a flow started headlessly; cancelling `signal` aborts the flow. */
	async waitForAuthorization(
		context: MCPAuthContext,
		options: MCPAuthOptions,
		signal?: AbortSignal,
	): Promise<MCPAuthResult> {
		return this.session(context, options).waitForAuthorization(signal);
	}

	async refresh(context: MCPAuthContext, options: MCPAuthOptions, signal?: AbortSignal): Promise<MCPAuthResult> {
		return this.session(context, options).refresh(signal);
	}

	/** Cancels a pending flow for the context without releasing the session. */
	cancel(context: MCPAuthContext, options: MCPAuthOptions): void {
		this.session(context, options).cancel();
	}

	async logout(context: MCPAuthContext, options: MCPAuthOptions): Promise<void> {
		return this.session(context, options).logout();
	}

	/** Cancels pending flows and releases the session for the context. */
	async close(context: MCPAuthContext, options: MCPAuthOptions): Promise<void> {
		const session = this.sessions.get(this.sessionKey(context));
		if (session !== undefined) {
			this.sessions.delete(this.sessionKey(context));
			await session.close();
		}
	}

	/** Cancels pending flows and releases every session held by this provider. */
	async closeAll(): Promise<void> {
		const sessions = [...this.sessions.values()];
		this.sessions.clear();
		await Promise.all(sessions.map((session) => session.close().catch(() => undefined)));
	}
}

/** Callback delivery to an armed one-shot waiter. */
type CallbackDelivery = { kind: "code"; code: string } | { kind: "timeout" } | { kind: "cancelled" };

/**
 * Per-(sessionId, serverId) OAuth flow manager. Enforces one active flow per
 * session+server, keeps secrets in memory, and validates every metadata,
 * binding, redirect, callback, and error boundary before anything reaches the
 * SDK.
 */
export class MCPAuthSession {
	readonly serverId: string;
	readonly serverIdentity: string;
	readonly sessionId: string;

	private readonly options: Required<
		Pick<MCPAuthOptions, "requestTimeoutMs" | "authorizationTimeoutMs">
	> &
		MCPAuthOptions;
	private readonly store: MCPAuthStore | undefined;
	private readonly baseFetch: FetchLike;
	private readonly contextSignal: AbortSignal | undefined;

	private state: MCPAuthState = "unauthenticated";
	private tokens: OAuthTokens | undefined;
	private expiresAt: number | undefined;
	private clientInfo: OAuthClientInformationMixed | undefined;
	private codeVerifier: string | undefined;
	private discovery: OAuthDiscoveryState | undefined;
	private canonicalResource: string | undefined;
	private flowState: string | undefined;
	private interaction: AuthInteraction | undefined;
	private redirectWaiter: Deferred<URL> | undefined;
	private callbackWaiter: Deferred<CallbackDelivery> | undefined;
	/** Last callback delivery, kept so a delivery that raced ahead of the flow's waiter read is not lost. */
	private callbackDelivery: CallbackDelivery | undefined;
	private callbackTimer: ReturnType<typeof setTimeout> | undefined;
	private callbackCleanups: Array<() => void> = [];
	private activeFlow: Promise<MCPAuthResult> | undefined;
	private refreshPromise: Promise<MCPAuthResult> | undefined;
	/**
	 * Cancellation for the current flow. Aborted by logout/close/cancel and by
	 * headless waiters that give up; a new flow replaces it with a fresh
	 * controller, so a superseded flow can never write late tokens.
	 */
	private flowAbort: AbortController | undefined;
	/**
	 * Session tombstone set by logout/close/cancel and cleared when a new flow
	 * starts. Blocks `saveTokens` from persisting tokens delivered by an SDK
	 * exchange that was still in flight when the session was closed.
	 */
	private closed = false;

	constructor(context: MCPAuthContext, options: MCPAuthOptions, store: MCPAuthStore | undefined) {
		const redirectProblem = validateMCPRedirectUrl(options.redirectUrl);
		if (redirectProblem !== undefined) {
			throw new MCPAuthError("mcp_auth_invalid_redirect", context.serverId);
		}
		this.serverId = context.serverId;
		this.serverIdentity = context.serverIdentity;
		this.sessionId = context.sessionId;
		this.options = {
			...options,
			requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
			authorizationTimeoutMs: options.authorizationTimeoutMs ?? DEFAULT_AUTHORIZATION_TIMEOUT_MS,
		};
		this.store = store;
		this.baseFetch = options.fetchFn ?? ((url, init) => fetch(url, init));
		this.contextSignal = context.signal;
	}

	/** Replaces the interaction used to surface authorization URLs and cancellation. */
	setInteraction(interaction: AuthInteraction | undefined): void {
		this.interaction = interaction;
	}

	/** Non-secret status of this session's flow. */
	getStatus(): MCPAuthStatus {
		let state = this.state;
		let expiresAt: string | undefined;
		if (state === "authenticated" && this.tokens !== undefined && this.expiresAt !== undefined) {
			expiresAt = new Date(this.expiresAt).toISOString();
			if (this.expiresAt <= Date.now()) {
				state = "expired";
			}
		}
		return {
			serverId: this.serverId,
			state,
			...(expiresAt !== undefined ? { expiresAt } : {}),
		};
	}

	/**
	 * Returns the in-memory access token when present and not expired. Expired
	 * tokens resolve to undefined so callers trigger a refresh; the store is
	 * only hydrated when the full binding (server identity, issuer, canonical
	 * resource) is known and matches.
	 */
	async getAccessToken(signal?: AbortSignal): Promise<string | undefined> {
		const tokens = await raceAbort(this.hydrateTokens(), signal);
		if (tokens === undefined) {
			return undefined;
		}
		if (this.expiresAt !== undefined && this.expiresAt <= Date.now()) {
			this.state = "expired";
			return undefined;
		}
		return tokens.access_token;
	}

	/**
	 * Runs the interactive authorization flow: validated discovery, PKCE state
	 * creation, authorization URL capture, and — when an interaction is
	 * supplied — callback wait and token exchange.
	 *
	 * Headless callers (no interaction) receive `interaction_required` with the
	 * one-time authorization URL immediately and continue with
	 * {@link completeAuthorization} + {@link waitForAuthorization}. Concurrent
	 * calls on the same session join the active flow.
	 */
	async startInteractive(interaction?: AuthInteraction): Promise<MCPAuthResult> {
		if (this.activeFlow !== undefined) {
			return this.activeFlow;
		}
		if (interaction !== undefined) {
			this.interaction = interaction;
		}
		const flow = this.runInteractiveFlow();
		this.activeFlow = flow;
		// Clear the join slot when the flow settles (not when this method returns:
		// a headless caller returns early while the flow is still pending).
		void flow.then(
			() => {
				if (this.activeFlow === flow) {
					this.activeFlow = undefined;
				}
			},
			() => {
				if (this.activeFlow === flow) {
					this.activeFlow = undefined;
				}
			},
		);
		try {
			const authorizationUrl = await this.waitForRedirect();
			if (interaction === undefined) {
				this.state = "interaction_required";
				return {
					outcome: "interaction_required",
					status: this.getStatus(),
					authorizationUrl: authorizationUrl.toString(),
				};
			}
			// The URL was already surfaced through the interaction by
			// {@link onRedirectToAuthorization}; wait for the callback now.
			return await flow;
		} catch (error) {
			throw this.classify(error, "discovery");
		}
	}

	/**
	 * Awaits the outcome of a flow started headlessly (or joined). Returns
	 * `interaction_required` when no flow is pending. Cancelling `signal`
	 * aborts the pending flow itself — not just the wait — so a headless
	 * caller that gives up can never let the flow complete later and persist
	 * tokens.
	 */
	async waitForAuthorization(signal?: AbortSignal): Promise<MCPAuthResult> {
		if (this.activeFlow === undefined) {
			return { outcome: "interaction_required", status: this.getStatus() };
		}
		if (signal !== undefined) {
			const flow = this.flowAbort;
			const cancelFlow = (): void => {
				this.closed = true;
				flow?.abort(signal.reason ?? new DOMException("Aborted", "AbortError"));
				this.settleCallback({ kind: "cancelled" });
			};
			if (signal.aborted) {
				cancelFlow();
			} else {
				signal.addEventListener("abort", cancelFlow, { once: true });
				void this.activeFlow
					.finally(() => {
						signal.removeEventListener("abort", cancelFlow);
					})
					.catch(() => undefined);
			}
		}
		return this.activeFlow;
	}

	/**
	 * Validates the authorization callback and delivers the code to the pending
	 * flow. A state or redirect mismatch is discarded with
	 * `mcp_auth_state_mismatch` and does not cancel the flow. After the flow
	 * completed or was superseded, further callbacks fail closed.
	 */
	async completeAuthorization(
		code: string,
		params: { state?: string; redirectUri?: string },
	): Promise<void> {
		const expectedState = this.flowState;
		if (expectedState === undefined || this.callbackWaiter === undefined) {
			throw new MCPAuthError("mcp_auth_state_mismatch", this.serverId);
		}
		if (params.state !== expectedState) {
			throw new MCPAuthError("mcp_auth_state_mismatch", this.serverId);
		}
		if (code.trim().length === 0) {
			throw new MCPAuthError("mcp_auth_invalid", this.serverId);
		}
		if (
			params.redirectUri !== undefined &&
			!this.redirectMatches(params.redirectUri)
		) {
			throw new MCPAuthError("mcp_auth_state_mismatch", this.serverId);
		}
		this.settleCallback({ kind: "code", code });
	}

	/**
	 * Refreshes the access token. Concurrent refreshes on the same session join
	 * a single request, so rotated tokens cannot be overwritten by a stale
	 * response. An `invalid_grant` clears the tokens and reports
	 * `interaction_required` (the single re-auth path); other failures throw a
	 * fixed `mcp_auth_invalid` / `mcp_auth_unavailable` error. Callers (the
	 * transport / lifecycle) retry the original request exactly once after a
	 * successful refresh.
	 */
	async refresh(signal?: AbortSignal): Promise<MCPAuthResult> {
		if (this.refreshPromise !== undefined) {
			return this.refreshPromise;
		}
		// A refresh after logout must not resurrect a flow controller; the
		// session tombstone keeps late saves blocked until a new flow starts.
		if (!this.closed && this.flowAbort === undefined) {
			this.flowAbort = new AbortController();
		}
		const refresh = this.doRefresh(signal);
		this.refreshPromise = refresh;
		try {
			return await refresh;
		} finally {
			if (this.refreshPromise === refresh) {
				this.refreshPromise = undefined;
			}
		}
	}

	/**
	 * Best-effort RFC 7009 token revocation, then local cleanup.
	 *
	 * A fresh session (no in-memory tokens or discovery yet) still owns the
	 * persisted credential, so the binding and tokens are hydrated first —
	 * best-effort and bounded — before the stored record is deleted and the
	 * refresh token is revoked. Hydration or revocation failures never block
	 * local cleanup.
	 */
	async logout(): Promise<void> {
		// Memory-first cleanup: snapshot the binding and tokens, then clear all
		// in-memory secrets and delete the stored record before any network
		// work, so an abort or a revoke failure can never leave a credential
		// behind. Revocation runs after, best-effort and bounded.
		if (this.tokens === undefined && !this.closed) {
			// A fresh session has no issuer/resource binding until discovery
			// runs; without it the storage key cannot be derived and the
			// persisted record would survive the logout. Hydration is best
			// effort: a metadata failure keeps the cleanup local-only.
			await this.hydrateTokens().catch(() => undefined);
		}
		this.closed = true;
		this.flowAbort?.abort(new DOMException("Aborted", "AbortError"));
		this.settleCallback({ kind: "cancelled" });
		this.settleRedirect(new DOMException("Aborted", "AbortError"));
		const binding = this.binding();
		const refreshToken = this.tokens?.refresh_token;
		const metadata = this.discovery?.authorizationServerMetadata;
		const revocationEndpoint =
			metadata !== undefined && typeof metadata === "object" && "revocation_endpoint" in metadata
				? (metadata as { revocation_endpoint?: URL }).revocation_endpoint
				: undefined;
		this.tokens = undefined;
		this.expiresAt = undefined;
		this.clientInfo = undefined;
		this.codeVerifier = undefined;
		this.discovery = undefined;
		this.canonicalResource = undefined;
		this.flowState = undefined;
		this.state = "unauthenticated";
		if (binding !== undefined) {
			await this.store?.delete(binding).catch(() => undefined);
		}
		if (refreshToken !== undefined && revocationEndpoint !== undefined) {
			// Best-effort RFC 7009 revocation, bounded by the request timeout and
			// never blocking local cleanup.
			await this.revokeToken(revocationEndpoint, refreshToken).catch(() => undefined);
		}
	}

	/** Cancels the pending flow; the flow settles cancelled and cannot write late tokens. */
	cancel(): void {
		if (this.flowAbort === undefined) {
			// No flow is pending, so there is nothing to settle — and the session
			// tombstone must not be set: a stray cancel (for example a transport
			// detach racing a flow that already settled by timeout) would otherwise
			// block the next refresh from persisting rotated tokens.
			return;
		}
		this.closed = true;
		this.flowAbort.abort(new DOMException("Aborted", "AbortError"));
		this.settleCallback({ kind: "cancelled" });
	}

	/**
	 * Best-effort RFC 7009 revocation request. Never throws: every failure
	 * (network, timeout, abort, non-2xx) is swallowed so logout always proceeds
	 * with local cleanup.
	 */
	private async revokeToken(endpoint: URL, refreshToken: string): Promise<void> {
		const body = new URLSearchParams({ token: refreshToken, token_type_hint: "refresh_token" });
		const response = await this.boundedFetch()(endpoint, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body,
		});
		if (!response.ok) {
			const stream = response.body;
			if (stream !== undefined && stream !== null) {
				await stream.cancel().catch(() => undefined);
			}
		}
	}

	/** Cancels pending flows and releases waiters; credentials stay in memory. */
	async close(): Promise<void> {
		this.closed = true;
		this.flowAbort?.abort(new DOMException("Aborted", "AbortError"));
		this.settleCallback({ kind: "cancelled" });
		this.settleRedirect(abortReason(new AbortController().signal));
	}

	/**
	 * Builds the SDK `OAuthClientProvider` adapter bound to this session. A
	 * later task supplies this as `StreamableHTTPClientTransport.authProvider`;
	 * every flow it drives shares this session's state, binding, and
	 * one-flow-per-session enforcement.
	 */
	createOAuthClientProvider(): OAuthClientProvider {
		const session = this;
		// The flow this adapter belongs to. Late SDK callbacks (token saves)
		// carry this identity so a superseded or aborted flow can never write.
		const flow = this.flowAbort;
		return {
			get redirectUrl(): string | URL {
				return session.options.redirectUrl;
			},
			get clientMetadata(): OAuthClientMetadata {
				return {
					redirect_uris: [session.options.redirectUrl.toString()],
					token_endpoint_auth_method: "none",
					grant_types: ["authorization_code"],
					response_types: ["code"],
					...(session.options.clientName !== undefined ? { client_name: session.options.clientName } : {}),
				};
			},
			state: (): string => {
				session.flowState = randomBytes(32).toString("hex");
				return session.flowState;
			},
			clientInformation: () => session.getClientInformation(),
			saveClientInformation: (clientInformation) => session.setClientInformation(clientInformation),
			tokens: () => session.hydrateTokens(),
			saveTokens: (tokens) => session.saveTokens(tokens, flow),
			redirectToAuthorization: (authorizationUrl) => session.onRedirectToAuthorization(authorizationUrl),
			saveCodeVerifier: (codeVerifier) => {
				session.codeVerifier = codeVerifier;
			},
			codeVerifier: () => session.codeVerifier ?? "",
			validateResourceURL: (serverUrl, resource) => session.validateResourceURL(serverUrl, resource),
			invalidateCredentials: (scope) => session.invalidateCredentials(scope),
			saveDiscoveryState: (state) => session.saveDiscoveryState(state),
			discoveryState: () => session.discovery,
		};
	}

	private async runInteractiveFlow(): Promise<MCPAuthResult> {
		// A new flow replaces the cancellation controller and clears the session
		// tombstone: logout/close/cancel from a previous flow must not poison a
		// fresh authorization, while the superseded flow's late callbacks stay
		// blocked by the controller identity captured in its provider adapter.
		this.closed = false;
		const flow = new AbortController();
		this.flowAbort = flow;
		const signal = this.combinedSignal();
		try {
			await this.ensureDiscovery();
			this.state = "authorizing";
			const initial = await raceAbort(
				withTimeout(
					auth(this.createOAuthClientProvider(), {
						serverUrl: this.options.serverUrl,
						scope: this.options.scope,
						fetchFn: this.boundedFetch(),
					}),
					this.options.requestTimeoutMs,
					() => new MCPAuthError("mcp_auth_timeout", this.serverId),
				),
				signal,
			);
			if (initial === "AUTHORIZED") {
				this.state = "authenticated";
				return { outcome: "authorized", status: this.getStatus() };
			}
			const delivery = await this.waitForAuthorizationCode();
			if (delivery.kind !== "code") {
				this.state = "unauthenticated";
				return { outcome: delivery.kind, status: this.getStatus() };
			}
			this.state = "exchanging";
			const exchanged = await raceAbort(
				withTimeout(
					auth(this.createOAuthClientProvider(), {
						serverUrl: this.options.serverUrl,
						authorizationCode: delivery.code,
						scope: this.options.scope,
						fetchFn: this.boundedFetch(),
					}),
					this.options.requestTimeoutMs,
					() => new MCPAuthError("mcp_auth_timeout", this.serverId),
				),
				signal,
			);
			if (exchanged !== "AUTHORIZED") {
				throw new MCPAuthError("mcp_auth_invalid", this.serverId);
			}
			this.state = "authenticated";
			return { outcome: "authorized", status: this.getStatus() };
		} catch (error) {
			this.settleCallback({ kind: "cancelled" });
			this.settleRedirect(error);
			if (isAbortLike(error)) {
				this.state = "unauthenticated";
				throw new MCPAuthError("mcp_auth_cancelled", this.serverId);
			}
			throw this.classify(error, "discovery");
		} finally {
			// Release the flow controller once the flow settles: a cancelled or
			// completed flow must not keep poisoning discovery/refresh calls, while
			// late token callbacks stay blocked by the identity check in
			// `saveTokens` (`this.flowAbort !== flow`).
			if (this.flowAbort === flow) {
				this.flowAbort = undefined;
			}
		}
	}

	private async doRefresh(signal?: AbortSignal): Promise<MCPAuthResult> {
		// The flow identity of this refresh; a logout/close/cancel that aborts or
		// supersedes it blocks the token save below.
		const flow = this.flowAbort;
		const tokens = await raceAbort(this.hydrateTokens(), signal);
		if (tokens?.refresh_token === undefined) {
			return { outcome: "interaction_required", status: this.getStatus() };
		}
		const clientInfo = await this.hydrateClientInformation();
		if (clientInfo === undefined) {
			return { outcome: "interaction_required", status: this.getStatus() };
		}
		this.state = "refreshing";
		try {
			const discovery = await this.ensureDiscovery();
			const resource = this.resolveCanonicalResource();
			const refreshed = await raceAbort(
				withTimeout(
					refreshAuthorization(discovery.authorizationServerUrl, {
						metadata: discovery.authorizationServerMetadata,
						clientInformation: clientInfo,
						refreshToken: tokens.refresh_token,
						resource: new URL(resource),
						fetchFn: this.boundedFetch(),
					}),
					this.options.requestTimeoutMs,
					() => new MCPAuthError("mcp_auth_timeout", this.serverId),
				),
				signal,
			);
			await this.saveTokens(refreshed, flow, true);
			this.state = "authenticated";
			return { outcome: "authorized", status: this.getStatus() };
		} catch (error) {
			if (error instanceof InvalidGrantError) {
				this.tokens = undefined;
				this.expiresAt = undefined;
				this.state = "unauthenticated";
				const binding = this.binding();
				if (binding !== undefined) {
					await this.store?.delete(binding).catch(() => undefined);
				}
				return { outcome: "interaction_required", status: this.getStatus() };
			}
			if (isAbortLike(error)) {
				this.state = "unauthenticated";
				throw new MCPAuthError("mcp_auth_cancelled", this.serverId);
			}
			if (error instanceof MCPAuthError) {
				throw error;
			}
			if (error instanceof ServerError || error instanceof TemporarilyUnavailableError) {
				throw new MCPAuthError("mcp_auth_unavailable", this.serverId);
			}
			if (error instanceof OAuthError) {
				throw new MCPAuthError("mcp_auth_invalid", this.serverId);
			}
			throw new MCPAuthError("mcp_auth_unavailable", this.serverId);
		}
	}

	/** Runs validated RFC 9728 + RFC 8414 discovery once per session. */
	private async ensureDiscovery(): Promise<OAuthDiscoveryState> {
		if (this.discovery !== undefined) {
			return this.discovery;
		}
		this.state = "discovering";
		try {
			const info = await raceAbort(
				withTimeout(
					discoverOAuthServerInfo(this.options.serverUrl, { fetchFn: this.boundedFetch() }),
					this.options.requestTimeoutMs,
					() => new MCPAuthError("mcp_auth_timeout", this.serverId),
				),
				this.combinedSignal(),
			);
			return this.acceptDiscovery(info);
		} catch (error) {
			this.state = "unavailable";
			throw this.classify(error, "discovery");
		}
	}

	private acceptDiscovery(info: OAuthServerInfo): OAuthDiscoveryState {
		const state: OAuthDiscoveryState = {
			authorizationServerUrl: info.authorizationServerUrl,
			...(info.authorizationServerMetadata !== undefined
				? { authorizationServerMetadata: info.authorizationServerMetadata }
				: {}),
			...(info.resourceMetadata !== undefined ? { resourceMetadata: info.resourceMetadata } : {}),
		};
		validateDiscoveredState(state, this.options.canonicalResource?.toString(), this.serverId);
		this.discovery = state;
		this.state = "unauthenticated";
		return state;
	}

	/**
	 * Canonical RFC 8707 resource for this session: explicit override, else the
	 * protected resource metadata `resource`, else the server URL. The value is
	 * validated (https or http loopback) and pinned for the session lifetime.
	 */
	private resolveCanonicalResource(): string {
		if (this.canonicalResource !== undefined) {
			return this.canonicalResource;
		}
		const explicit = this.options.canonicalResource?.toString();
		const metadataResource = this.discovery?.resourceMetadata?.resource;
		const canonical = explicit ?? metadataResource ?? resourceFromServerUrl(this.options.serverUrl);
		let parsed: URL;
		try {
			parsed = new URL(canonical);
		} catch {
			throw new MCPAuthError("mcp_auth_resource_mismatch", this.serverId);
		}
		if (!isSecureOAuthEndpoint(parsed)) {
			throw new MCPAuthError("mcp_auth_resource_mismatch", this.serverId);
		}
		this.canonicalResource = canonical;
		return canonical;
	}

	/** SDK `validateResourceURL` override: the resource must equal the canonical one. */
	async validateResourceURL(_serverUrl: string | URL, resource?: string): Promise<URL | undefined> {
		const canonical = this.resolveCanonicalResource();
		if (resource !== undefined && canonicalUrlString(resource) !== canonicalUrlString(canonical)) {
			throw new MCPAuthError("mcp_auth_resource_mismatch", this.serverId);
		}
		return new URL(canonical);
	}

	/** SDK `saveDiscoveryState`: validated before caching, so invalid metadata fails closed. */
	async saveDiscoveryState(state: OAuthDiscoveryState): Promise<void> {
		validateDiscoveredState(state, this.options.canonicalResource?.toString(), this.serverId);
		this.discovery = state;
	}

	private async getClientInformation(): Promise<OAuthClientInformationMixed | undefined> {
		return this.hydrateClientInformation();
	}

	private async hydrateClientInformation(): Promise<OAuthClientInformationMixed | undefined> {
		if (this.clientInfo !== undefined) {
			return this.clientInfo;
		}
		if (this.options.clientId !== undefined) {
			this.clientInfo = { client_id: this.options.clientId };
			return this.clientInfo;
		}
		// Reuse a registered client id from the stored record so a new session
		// does not re-register against the authorization server.
		const binding = this.binding();
		if (binding !== undefined && this.store !== undefined) {
			const record = await this.store.read(binding).catch(() => undefined);
			if (record !== undefined && this.bindingMatches(record) && record.clientId !== undefined) {
				this.clientInfo = { client_id: record.clientId };
				return this.clientInfo;
			}
		}
		return undefined;
	}

	private setClientInformation(clientInformation: OAuthClientInformationMixed): void {
		this.clientInfo = clientInformation;
	}

	private async hydrateTokens(): Promise<OAuthTokens | undefined> {
		if (this.tokens !== undefined) {
			return this.tokens;
		}
		// A fresh session has no issuer/resource binding until protected-resource
		// discovery has completed. Hydrate only after establishing that binding;
		// otherwise a direct getAccessToken/refresh call silently misses the
		// persisted record.
		if (this.discovery === undefined) {
			await this.ensureDiscovery();
		}
		this.resolveCanonicalResource();
		const binding = this.binding();
		if (binding === undefined || this.store === undefined) {
			return undefined;
		}
		const record = await this.store.read(binding).catch(() => undefined);
		if (record === undefined) {
			return undefined;
		}
		if (!this.bindingMatches(record)) {
			await this.store.delete(binding).catch(() => undefined);
			return undefined;
		}
		this.tokens = {
			access_token: record.accessToken,
			token_type: record.tokenType,
			...(record.refreshToken !== undefined ? { refresh_token: record.refreshToken } : {}),
			...(record.scope !== undefined ? { scope: record.scope } : {}),
		};
		if (record.clientId !== undefined) {
			this.clientInfo = { client_id: record.clientId };
		}
		this.expiresAt = record.expiresAt;
		return this.tokens;
	}

	private async saveTokens(tokens: OAuthTokens, flow?: AbortController, refresh = false): Promise<void> {
		// A flow that was cancelled, closed, or superseded must never persist:
		// the SDK keeps running the network exchange after cancellation, and a
		// late callback would otherwise resurrect credentials that logout/close
		// already cleared. Refresh saves belong to the session, not to a flow
		// generation, so they only check cancellation, never identity.
		if (this.closed || flow?.signal.aborted === true) {
			return;
		}
		if (!refresh && flow !== undefined && this.flowAbort !== flow) {
			return;
		}
		this.tokens = tokens;
		this.state = "authenticated";
		this.expiresAt =
			tokens.expires_in !== undefined ? Date.now() + tokens.expires_in * 1000 - TOKEN_EXPIRY_SKEW_MS : undefined;
		const binding = this.binding();
		if (binding === undefined || this.store === undefined) {
			return;
		}
		const record: MCPStoredOAuthRecord = {
			...binding,
			...(this.clientInfo?.client_id !== undefined ? { clientId: this.clientInfo.client_id } : {}),
			...(tokens.scope !== undefined ? { scope: tokens.scope } : {}),
			tokenType: tokens.token_type,
			accessToken: tokens.access_token,
			...(tokens.refresh_token !== undefined ? { refreshToken: tokens.refresh_token } : {}),
			...(this.expiresAt !== undefined ? { expiresAt: this.expiresAt } : {}),
			updatedAt: Date.now(),
		};
		// Persistence is best-effort: the in-memory credential remains authoritative.
		await this.store.save(record).catch(() => undefined);
	}

	/** SDK `invalidateCredentials`: clears the requested scope, memory first. */
	async invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): Promise<void> {
		const binding = scope === "all" || scope === "tokens" ? this.binding() : undefined;
		switch (scope) {
			case "all":
				this.tokens = undefined;
				this.expiresAt = undefined;
				this.clientInfo = undefined;
				this.codeVerifier = undefined;
				this.discovery = undefined;
				this.state = "unauthenticated";
				break;
			case "client":
				this.clientInfo = undefined;
				break;
			case "tokens":
				this.tokens = undefined;
				this.expiresAt = undefined;
				this.state = "unauthenticated";
				break;
			case "verifier":
				this.codeVerifier = undefined;
				break;
			case "discovery":
				this.discovery = undefined;
				break;
		}
		if (scope === "all" || scope === "tokens") {
			if (binding !== undefined) {
				await this.store?.delete(binding).catch(() => undefined);
			}
		}
	}

	private redirectMatches(redirectUri: string): boolean {
		try {
			return canonicalUrlString(redirectUri) === canonicalUrlString(this.options.redirectUrl);
		} catch {
			return false;
		}
	}

	private async onRedirectToAuthorization(authorizationUrl: URL): Promise<void> {
		this.state = "authorizing";
		// Arm the one-shot waiter before surfacing the URL so a callback can never
		// arrive between notification and waiter installation.
		this.armCallbackWaiter();
		this.interaction?.notify({
			type: "auth_url",
			url: authorizationUrl.toString(),
			instructions: MCP_AUTH_INSTRUCTIONS,
		});
		this.settleRedirect(authorizationUrl);
	}

	private waitForRedirect(): Promise<URL> {
		if (this.redirectWaiter !== undefined) {
			return this.redirectWaiter.promise;
		}
		const waiter = deferred<URL>();
		this.redirectWaiter = waiter;
		return waiter.promise;
	}

	private settleRedirect(value: URL | unknown): void {
		const waiter = this.redirectWaiter;
		this.redirectWaiter = undefined;
		if (waiter === undefined) {
			return;
		}
		if (value instanceof URL) {
			waiter.resolve(value);
		} else {
			waiter.reject(value);
		}
	}

	/** Arms the one-shot callback waiter with timeout and cancellation. */
	private armCallbackWaiter(): void {
		this.settleCallback({ kind: "cancelled" });
		const waiter = deferred<CallbackDelivery>();
		this.callbackWaiter = waiter;
		const cleanups: Array<() => void> = [];
		this.callbackTimer = setTimeout(() => this.settleCallback({ kind: "timeout" }), this.options.authorizationTimeoutMs);
		if (typeof this.callbackTimer.unref === "function") {
			this.callbackTimer.unref();
		}
		const onCancel = (): void => this.settleCallback({ kind: "cancelled" });
		cleanups.push(onAbortOnce(this.contextSignal, onCancel));
		cleanups.push(onAbortOnce(this.interaction?.signal, onCancel));
		this.callbackCleanups = cleanups;
	}

	private settleCallback(delivery: CallbackDelivery): void {
		if (this.callbackTimer !== undefined) {
			clearTimeout(this.callbackTimer);
			this.callbackTimer = undefined;
		}
		for (const cleanup of this.callbackCleanups) {
			cleanup();
		}
		this.callbackCleanups = [];
		const waiter = this.callbackWaiter;
		this.callbackWaiter = undefined;
		// Keep the delivery around: the flow may not have reached its waiter
		// read yet (the callback can race ahead of the flow continuation).
		this.callbackDelivery = delivery;
		if (waiter !== undefined) {
			waiter.resolve(delivery);
		}
	}

	private async waitForAuthorizationCode(): Promise<CallbackDelivery> {
		const waiter = this.callbackWaiter;
		if (waiter !== undefined) {
			const delivery = await waiter.promise;
			this.callbackDelivery = undefined;
			return delivery;
		}
		const delivery = this.callbackDelivery;
		this.callbackDelivery = undefined;
		return delivery ?? { kind: "cancelled" };
	}

	/** Storage binding; only available once the canonical resource and issuer are known. */
	private binding(): MCPAuthRecordBinding | undefined {
		const canonical = this.canonicalResource;
		const issuer = this.discovery?.authorizationServerUrl;
		if (canonical === undefined || issuer === undefined) {
			return undefined;
		}
		return {
			serverIdentity: this.serverIdentity,
			serverId: this.serverId,
			canonicalResource: canonical,
			issuer,
			...(this.options.clientId === undefined ? {} : { clientId: this.options.clientId }),
			...(this.options.scope === undefined || this.options.scope.trim() === ""
				? {}
				: { scope: this.options.scope }),
		};
	}

	private bindingMatches(record: MCPStoredOAuthRecord): boolean {
		const binding = this.binding();
		if (binding === undefined) {
			return false;
		}
		return (
			record.serverIdentity === binding.serverIdentity &&
			record.serverId === binding.serverId &&
			canonicalUrlString(record.canonicalResource) === canonicalUrlString(binding.canonicalResource) &&
			canonicalUrlString(record.issuer) === canonicalUrlString(binding.issuer) &&
			(binding.clientId === undefined || record.clientId === binding.clientId) &&
			(binding.scope === undefined || normalizeOAuthScope(record.scope) === normalizeOAuthScope(binding.scope))
		);
	}

	/** Bounds every OAuth HTTP request with a timeout and session cancellation. */
	private boundedFetch(): FetchLike {
		const base = this.baseFetch;
		const requestTimeoutMs = this.options.requestTimeoutMs;
		const contextSignal = this.contextSignal;
		return (url, init) => {
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(new MCPAuthTimeoutError()), requestTimeoutMs);
			if (typeof timer.unref === "function") {
				timer.unref();
			}
			const cleanups: Array<() => void> = [];
			const outerSignal = init?.signal ?? undefined;
			if (outerSignal !== undefined && !outerSignal.aborted) {
				const onOuter = (): void =>
					controller.abort(outerSignal.reason ?? new DOMException("Aborted", "AbortError"));
				outerSignal.addEventListener("abort", onOuter, { once: true });
				cleanups.push(() => outerSignal.removeEventListener("abort", onOuter));
			}
			const onContext = (): void => controller.abort(new DOMException("Aborted", "AbortError"));
			cleanups.push(onAbortOnce(contextSignal, onContext));
			return Promise.resolve(base(url, { ...init, signal: controller.signal })).finally(() => {
				clearTimeout(timer);
				for (const cleanup of cleanups) {
					cleanup();
				}
			});
		};
	}

	private combinedSignal(): AbortSignal | undefined {
		const signals = [this.contextSignal, this.interaction?.signal, this.flowAbort?.signal].filter(
			(signal): signal is AbortSignal => signal !== undefined,
		);
		if (signals.length === 0) {
			return undefined;
		}
		if (signals.length === 1) {
			return signals[0];
		}
		const controller = new AbortController();
		for (const signal of signals) {
			if (signal.aborted) {
				controller.abort(signal.reason ?? new DOMException("Aborted", "AbortError"));
				break;
			}
			signal.addEventListener(
				"abort",
				() => controller.abort(signal.reason ?? new DOMException("Aborted", "AbortError")),
				{ once: true },
			);
		}
		return controller.signal;
	}

	/**
	 * Maps SDK / network failures to fixed {@link MCPAuthError}s. Only the
	 * classification survives; remote text is never retained.
	 */
	private classify(error: unknown, _phase: "discovery" | "exchange" | "refresh"): MCPAuthError {
		if (error instanceof MCPAuthError) {
			return error;
		}
		if (error instanceof MCPAuthTimeoutError) {
			return new MCPAuthError("mcp_auth_timeout", this.serverId);
		}
		if (isAbortLike(error)) {
			return new MCPAuthError("mcp_auth_cancelled", this.serverId);
		}
		if (isZodError(error)) {
			return new MCPAuthError("mcp_auth_metadata_invalid", this.serverId);
		}
		if (error instanceof InvalidGrantError || error instanceof InvalidClientError) {
			return new MCPAuthError("mcp_auth_invalid", this.serverId);
		}
		if (error instanceof ServerError || error instanceof TemporarilyUnavailableError) {
			return new MCPAuthError("mcp_auth_unavailable", this.serverId);
		}
		if (error instanceof OAuthError) {
			return new MCPAuthError("mcp_auth_invalid", this.serverId);
		}
		if (error instanceof Error) {
			const message = error.message;
			if (message.includes("Incompatible auth server") || message.includes("does not support")) {
				return new MCPAuthError("mcp_auth_metadata_invalid", this.serverId);
			}
			if (message.includes("trying to load well-known") || message.includes("does not implement OAuth")) {
				return new MCPAuthError("mcp_auth_unavailable", this.serverId);
			}
			if (message.includes("does not match expected")) {
				return new MCPAuthError("mcp_auth_resource_mismatch", this.serverId);
			}
		}
		return new MCPAuthError("mcp_auth_unavailable", this.serverId);
	}
}

/** Resource identifier fallback matching the SDK default: the server URL without hash. */
function resourceFromServerUrl(serverUrl: string | URL): string {
	const url = typeof serverUrl === "string" ? new URL(serverUrl) : new URL(serverUrl.href);
	url.hash = "";
	return url.toString();
}
