/**
 * MCP OAuth core: Streamable-HTTP-only OAuth 2.0 authorization for MCP
 * servers, built on the pinned SDK 1.30.0 OAuth client.
 *
 * Scope (pinned to the installed `@modelcontextprotocol/sdk` 1.30.0 client types):
 * - RFC 9728 protected resource metadata and RFC 8414 authorization server
 *   metadata discovery, with fail-closed canonical resource/issuer and
 *   endpoint-origin validation. Discovery never runs for stdio configs; the
 *   caller passes a validated streamable-http endpoint.
 * - Authorization Code + PKCE (S256) via the SDK `auth()` orchestrator, with
 *   the app-side `OAuthClientProvider` adapter (`MCPServerOAuthProvider`).
 * - A fixed callback: either a loopback URL (`http://127.0.0.1:<port>/callback`,
 *   local listener, one request only) or a caller-supplied HTTPS URL with the
 *   authorization code pasted back through an `AuthInteraction` manual-code
 *   prompt. No other redirect URI shape is ever produced.
 * - `AuthInteraction` confirm/cancel before any redirect, `auth_url` event
 *   after confirmation, `AbortSignal` and timeouts at every await point, and a
 *   one-shot flow: `authorize()` runs at most one interactive authorization
 *   and at most one code exchange. Refresh/401 failures are retried at most
 *   once by the SDK orchestration and then mapped to classified errors.
 *
 * Redaction contract (unchanged from `mcp-types.ts`): errors carry only fixed
 * templates; tokens, URLs, raw URIs, and remote error text are never logged,
 * stored on errors, or echoed back. Token storage is per-flow in memory;
 * CredentialStore/Session/RPC/stdio semantics are untouched.
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { AuthInteraction } from "@aos-agent/ai";
import {
	auth,
	discoverOAuthServerInfo,
	UnauthorizedError,
	type OAuthClientProvider,
	type OAuthDiscoveryState,
	type OAuthServerInfo,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
	AuthorizationServerMetadata,
	OAuthClientInformationMixed,
	OAuthClientMetadata,
	OAuthProtectedResourceMetadata,
	OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { FetchLike } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
	mcpErrorKindToCapabilityCode,
	type MCPErrorKind,
	type MCPErrorView,
	validateMCPServerConfig,
} from "./mcp-types.ts";

/** Overall interactive flow deadline in milliseconds. */
export const MCP_OAUTH_DEFAULT_TIMEOUT_MS = 180_000;
/** Per-HTTP-request deadline in milliseconds (discovery, registration, tokens). */
export const MCP_OAUTH_DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
/** Fixed path of the loopback callback; only the loopback port varies per flow. */
export const MCP_OAUTH_LOOPBACK_CALLBACK_PATH = "/callback";
/** Default client name sent in dynamic client registration. */
export const MCP_OAUTH_CLIENT_NAME = "aos-agent";

/**
 * Fixed callback shapes. `loopback` runs a local listener on 127.0.0.1 and is
 * the default; `https` uses a caller-supplied fixed HTTPS redirect URI and
 * collects the authorization code through a manual-code prompt.
 */
export type MCPAuthCallbackMode = "loopback" | "https";

/**
 * Classified OAuth flow failures. Messages are fail-closed fixed templates
 * that never contain tokens, URLs, raw URIs, or remote error text.
 */
export type MCPAuthErrorKind =
	| "invalid_server_url"
	| "insecure_endpoint"
	| "invalid_callback_url"
	| "discovery_failed"
	| "resource_mismatch"
	| "issuer_mismatch"
	| "unsupported"
	| "user_cancelled"
	| "state_mismatch"
	| "callback_timeout"
	| "auth_failed"
	| "flow_used";

const MCP_AUTH_ERROR_MESSAGES: Record<MCPAuthErrorKind, string> = {
	invalid_server_url: 'MCP server "%s" has an invalid endpoint URL for OAuth',
	insecure_endpoint: 'MCP server "%s" requires an HTTPS endpoint for OAuth',
	invalid_callback_url: 'MCP server "%s" has an invalid OAuth callback URL',
	discovery_failed: 'MCP server "%s" OAuth discovery failed',
	resource_mismatch: 'MCP server "%s" OAuth resource does not match the server endpoint',
	issuer_mismatch: 'MCP server "%s" OAuth issuer does not match the authorization server',
	unsupported: 'MCP server "%s" does not support OAuth authorization code flow',
	user_cancelled: 'MCP server "%s" authorization was cancelled',
	state_mismatch: 'MCP server "%s" authorization callback state did not match',
	callback_timeout: 'MCP server "%s" authorization callback timed out',
	auth_failed: 'MCP server "%s" OAuth authorization failed',
	flow_used: 'MCP server "%s" OAuth flow was already used',
};

function mcpAuthErrorMessage(kind: MCPAuthErrorKind, serverId: string): string {
	return MCP_AUTH_ERROR_MESSAGES[kind].replace("%s", serverId);
}

function mcpAuthErrorKindToMCPErrorKind(kind: MCPAuthErrorKind): MCPErrorKind {
	switch (kind) {
		case "invalid_server_url":
		case "insecure_endpoint":
		case "invalid_callback_url":
			return "invalid_config";
		case "discovery_failed":
		case "resource_mismatch":
		case "issuer_mismatch":
		case "unsupported":
			return "connect_failed";
		case "user_cancelled":
		case "state_mismatch":
		case "callback_timeout":
		case "auth_failed":
		case "flow_used":
			return "auth_required";
	}
}

/**
 * Classified OAuth flow failure with a fail-closed message.
 *
 * The message always comes from a fixed template; tokens, URLs, raw URIs, and
 * remote error text never appear on the error object, so they cannot surface
 * through serialization or inspection.
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

	/** Lifecycle classification this failure maps to. */
	get mcpKind(): MCPErrorKind {
		return mcpAuthErrorKindToMCPErrorKind(this.kind);
	}

	/** Serializes to the redacted view shape used by the MCP lifecycle. */
	toView(): MCPErrorView {
		return {
			kind: this.mcpKind,
			serverId: this.serverId,
			message: this.message,
			code: mcpErrorKindToCapabilityCode(this.mcpKind),
		};
	}
}

/** Result of a successful one-shot authorization. */
export type MCPAuthResult = { status: "authorized" } | { status: "not_required" };

/** Options for {@link MCPAuthFlow}. */
export interface MCPAuthOptions {
	/** Server id used in fail-closed messages; validated as an MCP namespace segment. */
	serverId: string;
	/** The MCP streamable-http endpoint. http is allowed only for loopback hosts. */
	serverUrl: string | URL;
	/** App interaction surface: confirm/cancel, auth_url notification, manual code. */
	interaction?: AuthInteraction;
	/** Fixed callback shape; defaults to `loopback`. */
	callbackMode?: MCPAuthCallbackMode;
	/** Fixed HTTPS redirect URI; required when `callbackMode` is `https`. */
	httpsCallbackUrl?: string | URL;
	/** Client name sent in dynamic client registration; defaults to {@link MCP_OAUTH_CLIENT_NAME}. */
	clientName?: string;
	/** Deadline for the interactive callback capture; defaults to {@link MCP_OAUTH_DEFAULT_TIMEOUT_MS}. */
	timeoutMs?: number;
	/** Per-HTTP-request deadline; defaults to {@link MCP_OAUTH_DEFAULT_REQUEST_TIMEOUT_MS}. */
	requestTimeoutMs?: number;
	/** Aborts discovery, token calls, and the callback capture with an AbortError. */
	signal?: AbortSignal;
	/** Injectable fetch (tests). Defaults to the global fetch. */
	fetch?: FetchLike;
}

/**
 * Result of the module's validated discovery, or `undefined` when the server
 * advertises no OAuth at all (callers then connect unauthenticated).
 */
export interface MCPOAuthDiscovery {
	/** Canonical authorization server URL (validated, no userinfo/query/fragment). */
	authorizationServerUrl: string;
	/** Validated authorization server metadata; `undefined` is a failure, not "no OAuth". */
	authorizationServerMetadata?: AuthorizationServerMetadata;
	/** RFC 9728 protected resource metadata, when the server advertises it. */
	resourceMetadata?: OAuthProtectedResourceMetadata;
}

function isLoopbackHost(hostname: string): boolean {
	return hostname === "localhost" || hostname === "::1" || hostname === "[::1]" || hostname.startsWith("127.");
}

/**
 * Validates a settings or caller-supplied OAuth redirect URL.
 * Accepts https (no userinfo/query/fragment) or http loopback.
 * Returns a problem string, or undefined when the URL is allowed.
 */
export function mcpRedirectUrlProblem(url: string): string | undefined {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return "must be an absolute URL";
	}
	if (parsed.username !== "" || parsed.password !== "") {
		return "must not contain userinfo";
	}
	if (parsed.search !== "" || parsed.hash !== "") {
		return "must not contain a query or fragment";
	}
	if (parsed.protocol === "https:") {
		return undefined;
	}
	if (parsed.protocol === "http:" && isLoopbackHost(parsed.hostname)) {
		return undefined;
	}
	return "must be https or an http loopback address";
}

function stripTrailingSlashes(pathname: string): string {
	return pathname.replace(/\/+$/, "");
}

/**
 * Canonical form of an MCP server URL used as the OAuth resource identifier:
 * scheme, host, port, and path; query and fragment are stripped (RFC 8707
 * forbids fragments in resource indicators).
 */
export function canonicalMCPResourceUrl(url: string | URL): URL {
	const parsed = typeof url === "string" ? new URL(url) : new URL(url.href);
	parsed.search = "";
	parsed.hash = "";
	return parsed;
}

/**
 * Canonical resource match (RFC 9728): same origin, declared resource path is
 * a path prefix of the canonical server URL, and no userinfo. Mirrors the
 * SDK's own prefix rule so both layers agree.
 */
export function isCanonicalMCPResourceMatch(canonical: URL, declared: string): boolean {
	let configured: URL;
	try {
		configured = new URL(declared);
	} catch {
		return false;
	}
	if (configured.origin !== canonical.origin) {
		return false;
	}
	if (configured.username !== "" || configured.password !== "") {
		return false;
	}
	configured.hash = "";
	const requestedPath = `${stripTrailingSlashes(canonical.pathname)}/`;
	const configuredPath = `${stripTrailingSlashes(configured.pathname)}/`;
	if (requestedPath.length < configuredPath.length) {
		return false;
	}
	return requestedPath.startsWith(configuredPath);
}

/** Validates the MCP endpoint: http(s), https unless loopback, no userinfo, no credential query. */
function validateServerUrl(url: string | URL, serverId: string): URL {
	let raw: string;
	try {
		raw = typeof url === "string" ? url : url.toString();
	} catch {
		throw new MCPAuthError("invalid_server_url", serverId);
	}
	const problems = validateMCPServerConfig({ id: serverId, transport: "streamable-http", url: raw });
	if (problems.length > 0) {
		throw new MCPAuthError("invalid_server_url", serverId);
	}
	const parsed = new URL(raw);
	if (parsed.protocol === "http:" && !isLoopbackHost(parsed.hostname)) {
		throw new MCPAuthError("insecure_endpoint", serverId);
	}
	return parsed;
}

/** Validates the fixed HTTPS callback URL: https, no userinfo, no query, no fragment. */
function validateHttpsCallbackUrl(url: string | URL | undefined, serverId: string): string {
	if (url === undefined) {
		throw new MCPAuthError("invalid_callback_url", serverId);
	}
	let parsed: URL;
	try {
		parsed = typeof url === "string" ? new URL(url) : url;
	} catch {
		throw new MCPAuthError("invalid_callback_url", serverId);
	}
	if (parsed.protocol !== "https:") {
		throw new MCPAuthError("invalid_callback_url", serverId);
	}
	if (parsed.username !== "" || parsed.password !== "") {
		throw new MCPAuthError("invalid_callback_url", serverId);
	}
	if (parsed.search !== "" || parsed.hash !== "") {
		throw new MCPAuthError("invalid_callback_url", serverId);
	}
	return parsed.toString();
}

/** Validates an authorization server URL from protected resource metadata. */
function validateAuthorizationServerUrl(url: string, serverId: string): URL {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new MCPAuthError("discovery_failed", serverId);
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new MCPAuthError("discovery_failed", serverId);
	}
	if (parsed.protocol === "http:" && !isLoopbackHost(parsed.hostname)) {
		throw new MCPAuthError("discovery_failed", serverId);
	}
	if (parsed.username !== "" || parsed.password !== "") {
		throw new MCPAuthError("discovery_failed", serverId);
	}
	if (parsed.search !== "" || parsed.hash !== "") {
		throw new MCPAuthError("discovery_failed", serverId);
	}
	return parsed;
}

function canonicalIssuerUrl(value: string): URL | undefined {
	try {
		const parsed = new URL(value);
		parsed.search = "";
		parsed.hash = "";
		return parsed;
	} catch {
		return undefined;
	}
}

/**
 * Canonical issuer validation (RFC 8414 section 2: the issuer value must
 * match the URL used to fetch the metadata) plus fail-closed endpoint checks:
 * authorization and token endpoints must live on the issuer origin, use
 * https (http only on loopback), and carry no userinfo. Only the
 * authorization-code + PKCE (S256) grant is accepted.
 */
function validateAuthorizationServerMetadata(
	metadata: AuthorizationServerMetadata,
	authorizationServerUrl: URL,
	serverId: string,
): void {
	const issuer = canonicalIssuerUrl(metadata.issuer);
	if (
		issuer === undefined ||
		issuer.origin !== authorizationServerUrl.origin ||
		stripTrailingSlashes(issuer.pathname) !== stripTrailingSlashes(authorizationServerUrl.pathname)
	) {
		throw new MCPAuthError("issuer_mismatch", serverId);
	}
	for (const endpoint of [metadata.authorization_endpoint, metadata.token_endpoint]) {
		let parsed: URL;
		try {
			parsed = new URL(endpoint);
		} catch {
			throw new MCPAuthError("issuer_mismatch", serverId);
		}
		if (parsed.origin !== authorizationServerUrl.origin) {
			throw new MCPAuthError("issuer_mismatch", serverId);
		}
		if (parsed.username !== "" || parsed.password !== "") {
			throw new MCPAuthError("issuer_mismatch", serverId);
		}
		if (parsed.protocol === "http:" && !isLoopbackHost(parsed.hostname)) {
			throw new MCPAuthError("issuer_mismatch", serverId);
		}
	}
	if (!metadata.response_types_supported.includes("code")) {
		throw new MCPAuthError("unsupported", serverId);
	}
	if (
		metadata.code_challenge_methods_supported !== undefined &&
		!metadata.code_challenge_methods_supported.includes("S256")
	) {
		throw new MCPAuthError("unsupported", serverId);
	}
}

/**
 * Secure discovery for a streamable-http MCP endpoint.
 *
 * Follows RFC 9728 (protected resource metadata) with the RFC 8414 / OIDC
 * authorization server metadata fallback chain, then validates:
 * - the canonical resource claim against the MCP endpoint (same origin, path
 *   prefix) when the server advertises one;
 * - the authorization server URL (https unless loopback, no
 *   userinfo/query/fragment);
 * - the canonical issuer of the authorization server metadata and the
 *   origin/transport of its endpoints;
 * - authorization-code + PKCE S256 support.
 *
 * Returns `undefined` only when the server advertises no OAuth at all (no
 * protected resource metadata and no authorization server metadata). Any
 * advertised-but-invalid shape throws a classified {@link MCPAuthError}.
 */
export async function discoverMCPOAuth(
	serverUrl: string | URL,
	options: { serverId: string; fetchFn?: FetchLike },
): Promise<MCPOAuthDiscovery | undefined> {
	const server = validateServerUrl(serverUrl, options.serverId);
	let info: OAuthServerInfo;
	try {
		info = await discoverOAuthServerInfo(server, { fetchFn: options.fetchFn });
	} catch (error) {
		throw classifyMCPAuthError(error, options.serverId, "discovery");
	}
	if (info.resourceMetadata === undefined && info.authorizationServerMetadata === undefined) {
		return undefined;
	}
	const authorizationServerUrl = validateAuthorizationServerUrl(info.authorizationServerUrl, options.serverId);
	if (info.resourceMetadata !== undefined) {
		const declared = info.resourceMetadata.resource;
		if (declared !== undefined && !isCanonicalMCPResourceMatch(canonicalMCPResourceUrl(server), declared)) {
			throw new MCPAuthError("resource_mismatch", options.serverId);
		}
	}
	if (info.authorizationServerMetadata === undefined) {
		// OAuth is advertised (protected resource metadata) but the authorization
		// server metadata cannot be discovered: fail closed rather than guessing.
		throw new MCPAuthError("discovery_failed", options.serverId);
	}
	validateAuthorizationServerMetadata(info.authorizationServerMetadata, authorizationServerUrl, options.serverId);
	return {
		authorizationServerUrl: authorizationServerUrl.toString(),
		authorizationServerMetadata: info.authorizationServerMetadata,
		resourceMetadata: info.resourceMetadata,
	};
}

function abortError(signal: AbortSignal): DOMException {
	return new DOMException(
		signal.reason instanceof Error ? signal.reason.message : "MCP OAuth flow aborted",
		"AbortError",
	);
}

async function raceWithAbort<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (signal === undefined) {
		return operation;
	}
	if (signal.aborted) {
		throw abortError(signal);
	}
	let onAbort: (() => void) | undefined;
	const aborted = new Promise<never>((_resolve, reject) => {
		onAbort = () => reject(abortError(signal));
		signal.addEventListener("abort", onAbort, { once: true });
	});
	try {
		return await Promise.race([operation, aborted]);
	} finally {
		if (onAbort !== undefined) {
			signal.removeEventListener("abort", onAbort);
		}
	}
}

async function raceWithTimeout<T>(operation: Promise<T>, timeoutMs: number, onTimeout: () => Error): Promise<T> {
	if (timeoutMs <= 0) {
		throw onTimeout();
	}
	let timer: NodeJS.Timeout | undefined;
	const timedOut = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => reject(onTimeout()), timeoutMs);
	});
	try {
		return await Promise.race([operation, timedOut]);
	} finally {
		if (timer !== undefined) {
			clearTimeout(timer);
		}
	}
}

/** Reads the OAuth error code off SDK-parsed error instances without importing server paths. */
function oauthErrorCode(error: unknown): string | undefined {
	if (error instanceof Error) {
		const code = (error as Error & { errorCode?: unknown }).errorCode;
		if (typeof code === "string") {
			return code;
		}
	}
	return undefined;
}

function isTimeoutError(error: unknown): boolean {
	return error instanceof Error && error.name === "TimeoutError";
}

/**
 * Maps an SDK/transport error to a classified, fail-closed error.
 *
 * `UnauthorizedError` and OAuth error responses become `auth_failed` (except
 * `access_denied`, which the user declined and maps to `user_cancelled`); a
 * request timeout or any other failure maps to the phase kind. `MCPAuthError`
 * and AbortErrors pass through unchanged. The returned error never carries
 * tokens, URLs, raw URIs, or remote error text.
 */
export function classifyMCPAuthError(error: unknown, serverId: string, phase: "discovery" | "auth"): Error {
	if (error instanceof MCPAuthError) {
		return error;
	}
	if (error instanceof UnauthorizedError) {
		return new MCPAuthError("auth_failed", serverId);
	}
	if (error instanceof DOMException && error.name === "AbortError") {
		return error;
	}
	const code = oauthErrorCode(error);
	if (code === "access_denied") {
		return new MCPAuthError("user_cancelled", serverId);
	}
	if (isTimeoutError(error) || code !== undefined || error instanceof Error) {
		return new MCPAuthError(phase === "discovery" ? "discovery_failed" : "auth_failed", serverId);
	}
	return new MCPAuthError(phase === "discovery" ? "discovery_failed" : "auth_failed", serverId);
}

const CALLBACK_SUCCESS_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8" /><title>Authorization complete</title></head>
<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0b0b0f;color:#f4f4f5;font-family:ui-sans-serif,system-ui,sans-serif">
<p style="font-size:18px">Authorization complete. You can close this window and return to AOS Agent.</p>
</body>
</html>`;

const CALLBACK_ERROR_HTML = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8" /><title>Authorization failed</title></head>
<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0b0b0f;color:#f4f4f5;font-family:ui-sans-serif,system-ui,sans-serif">
<p style="font-size:18px">Authorization failed. You can close this window and return to AOS Agent.</p>
</body>
</html>`;

function respond(res: ServerResponse, status: number, body: string): void {
	res.writeHead(status, {
		"Content-Type": "text/html; charset=utf-8",
		"Content-Length": Buffer.byteLength(body),
		Connection: "close",
	});
	res.end(body);
}

/**
 * One-shot interactive OAuth authorization for a single MCP server.
 *
 * `authorize()` performs validated discovery, runs the SDK authorization
 * orchestration through the {@link MCPServerOAuthProvider} adapter, drives the
 * `AuthInteraction` confirm/cancel + `auth_url` steps, captures the callback
 * (loopback listener or manual code), and exchanges the code. It can be
 * called at most once; refresh/401-class failures are retried at most once by
 * the SDK and then mapped to classified {@link MCPAuthError}s.
 */
export class MCPAuthFlow {
	readonly provider: MCPServerOAuthProvider;
	/** Server id used in fail-closed messages. */
	readonly serverId: string;
	/** Client name sent in dynamic client registration. */
	readonly clientName: string;
	private readonly serverUrl: URL;
	private interaction: AuthInteraction | undefined;
	private readonly callbackMode: MCPAuthCallbackMode;
	private readonly httpsCallbackUrl: string | undefined;
	private readonly timeoutMs: number;
	private readonly requestTimeoutMs: number;
	private readonly signal: AbortSignal | undefined;
	private readonly fetchImpl: FetchLike | undefined;
	private callbackServer: Server | undefined;
	private callbackUrl: string | undefined;
	private capture: Promise<string> | undefined;
	private captureSettler: { resolve(code: string): void; reject(error: unknown): void } | undefined;
	private currentState: string | undefined;
	private used = false;

	constructor(options: MCPAuthOptions) {
		this.serverId = options.serverId;
		this.serverUrl = validateServerUrl(options.serverUrl, this.serverId);
		this.interaction = options.interaction;
		this.callbackMode = options.callbackMode ?? "loopback";
		this.timeoutMs = options.timeoutMs ?? MCP_OAUTH_DEFAULT_TIMEOUT_MS;
		this.requestTimeoutMs = options.requestTimeoutMs ?? MCP_OAUTH_DEFAULT_REQUEST_TIMEOUT_MS;
		this.signal = options.signal;
		this.fetchImpl = options.fetch;
		this.clientName = options.clientName ?? MCP_OAUTH_CLIENT_NAME;
		this.httpsCallbackUrl =
			this.callbackMode === "https" ? validateHttpsCallbackUrl(options.httpsCallbackUrl, this.serverId) : undefined;
		this.provider = new MCPServerOAuthProvider(this);
	}

	/**
	 * Supplies the app interaction surface after construction. Required before
	 * any interactive authorization; a flow without an interaction fails closed
	 * instead of prompting. A provider-only flow (no interaction) can still
	 * serve already-granted tokens for refresh/401 handling.
	 */
	setInteraction(interaction: AuthInteraction): void {
		this.interaction = interaction;
	}

	/** One-shot guard: a second `authorize()` call always rejects. */
	async authorize(): Promise<MCPAuthResult> {
		if (this.used) {
			throw new MCPAuthError("flow_used", this.serverId);
		}
		this.used = true;
		if (this.signal?.aborted) {
			throw abortError(this.signal);
		}
		try {
			return await this.doAuthorize();
		} finally {
			await this.closeCallbackServer();
		}
	}

	private async doAuthorize(): Promise<MCPAuthResult> {
		const fetchFn = this.wrappedFetch();
		const discovery = await discoverMCPOAuth(this.serverUrl, { serverId: this.serverId, fetchFn });
		if (discovery === undefined) {
			return { status: "not_required" };
		}
		await this.ensureCallback();
		await this.provider.saveDiscoveryState({
			authorizationServerUrl: discovery.authorizationServerUrl,
			authorizationServerMetadata: discovery.authorizationServerMetadata,
			resourceMetadata: discovery.resourceMetadata,
		});
		const first = await raceWithAbort(
			auth(this.provider, { serverUrl: this.serverUrl, fetchFn }).catch((error) => {
				throw classifyMCPAuthError(error, this.serverId, "auth");
			}),
			this.signal,
		);
		if (first !== "AUTHORIZED") {
			// `redirectToAuthorization` already ran the confirm/cancel prompt and
			// started the capture; collect the code (or its classified failure).
			const code = await this.captureCode();
			const second = await raceWithAbort(
				auth(this.provider, { serverUrl: this.serverUrl, authorizationCode: code, fetchFn }).catch((error) => {
					throw classifyMCPAuthError(error, this.serverId, "auth");
				}),
				this.signal,
			);
			if (second !== "AUTHORIZED") {
				throw new MCPAuthError("auth_failed", this.serverId);
			}
		}
		return { status: "authorized" };
	}

	/** Starts the loopback listener (https mode needs no listener). */
	private async ensureCallback(): Promise<void> {
		if (this.callbackMode === "https") {
			return;
		}
		if (this.callbackServer !== undefined) {
			return;
		}
		const server = createServer((req, res) => this.handleCallbackRequest(req, res));
		try {
			await new Promise<void>((resolve, reject) => {
				server.once("error", reject);
				server.listen(0, "127.0.0.1", () => {
					server.off("error", reject);
					resolve();
				});
			});
		} catch {
			throw new MCPAuthError("discovery_failed", this.serverId);
		}
		this.callbackServer = server;
		const address = server.address() as AddressInfo;
		this.callbackUrl = `http://127.0.0.1:${address.port}${MCP_OAUTH_LOOPBACK_CALLBACK_PATH}`;
	}

	private async closeCallbackServer(): Promise<void> {
		const server = this.callbackServer;
		this.callbackServer = undefined;
		if (server === undefined || !server.listening) {
			return;
		}
		await new Promise<void>((resolve) => {
			const timer = setTimeout(() => {
				server.closeAllConnections?.();
				resolve();
			}, 500);
			server.close(() => {
				clearTimeout(timer);
				resolve();
			});
		});
	}

	/** Resolves the fixed callback URL; used by the provider adapter. */
	callbackUrlOrThrow(): string {
		if (this.callbackUrl !== undefined) {
			return this.callbackUrl;
		}
		if (this.httpsCallbackUrl !== undefined) {
			return this.httpsCallbackUrl;
		}
		// Unreachable in the flow's own sequencing; defensive for direct adapter use.
		throw new MCPAuthError("auth_failed", this.serverId);
	}

	/** Generates and remembers the OAuth2 state parameter for callback validation. */
	async generateState(): Promise<string> {
		this.currentState = randomBytes(24).toString("base64url");
		return this.currentState;
	}

	private isValidState(received: string | null): boolean {
		const expected = this.currentState;
		if (received === null || expected === undefined) {
			return false;
		}
		const a = Buffer.from(received);
		const b = Buffer.from(expected);
		return a.length === b.length && timingSafeEqual(a, b);
	}

	/**
	 * Runs the interaction steps for an authorization redirect: confirm/cancel
	 * prompt, `auth_url` notification, and capture start (loopback listener
	 * wait or manual-code prompt). Called by the SDK through
	 * `redirectToAuthorization`.
	 */
	async beginAuthorization(authorizationUrl: URL): Promise<void> {
		if (this.interaction === undefined) {
			// Fail closed: without an interaction surface, authorization can never
			// be confirmed by a user, so the flow must not prompt or redirect.
			throw new MCPAuthError("auth_failed", this.serverId);
		}
		let choice: string;
		try {
			choice = await this.interaction.prompt({
				type: "select",
				message: `Allow ${this.clientName} to sign in to MCP server "${this.serverId}" using OAuth?`,
				options: [
					{ id: "allow", label: "Allow" },
					{ id: "cancel", label: "Cancel" },
				],
			});
		} catch {
			throw new MCPAuthError("user_cancelled", this.serverId);
		}
		if (choice !== "allow") {
			throw new MCPAuthError("user_cancelled", this.serverId);
		}
		// Arm the capture before notifying: the user-agent may hit the callback
		// as soon as the auth_url event is delivered, so the promise must exist
		// first to avoid a lost callback.
		if (this.callbackMode === "https") {
			this.capture = this.interaction
				.prompt({ type: "manual_code", message: "Paste the authorization code shown by your browser" })
				.then(
					(code) => {
						this.captureSettler = undefined;
						return code;
					},
					() => {
						this.captureSettler = undefined;
						throw new MCPAuthError("user_cancelled", this.serverId);
					},
				);
		} else {
			// The callback may reject before the flow awaits the capture (the SDK
			// returns REDIRECT after `redirectToAuthorization` resolves), so a no-op
			// handler is attached at creation to keep the rejection handled.
			const capture = new Promise<string>((resolve, reject) => {
				this.captureSettler = { resolve, reject };
			});
			capture.catch(() => undefined);
			this.capture = capture;
		}
		this.interaction.notify({
			type: "auth_url",
			url: authorizationUrl.toString(),
			instructions: "Open this URL in your browser and authorize access, then return here.",
		});
	}

	/** Awaits the captured authorization code; bounded by the signal and the flow deadline. */
	private async captureCode(): Promise<string> {
		const capture = this.capture;
		if (capture === undefined) {
			throw new MCPAuthError("auth_failed", this.serverId);
		}
		try {
			return await raceWithAbort(
				raceWithTimeout(capture, this.timeoutMs, () => new MCPAuthError("callback_timeout", this.serverId)),
				this.signal,
			);
		} finally {
			this.currentState = undefined;
		}
	}

	private handleCallbackRequest(req: IncomingMessage, res: ServerResponse): void {
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		if (req.method !== "GET" || url.pathname !== MCP_OAUTH_LOOPBACK_CALLBACK_PATH) {
			respond(res, 404, CALLBACK_ERROR_HTML);
			return;
		}
		const errorParam = url.searchParams.get("error");
		if (errorParam !== null) {
			this.failCapture(
				new MCPAuthError(errorParam === "access_denied" ? "user_cancelled" : "auth_failed", this.serverId),
			);
			respond(res, 400, CALLBACK_ERROR_HTML);
			return;
		}
		const code = url.searchParams.get("code");
		if (code === null || !this.isValidState(url.searchParams.get("state"))) {
			this.failCapture(new MCPAuthError("state_mismatch", this.serverId));
			respond(res, 400, CALLBACK_ERROR_HTML);
			return;
		}
		const settler = this.captureSettler;
		this.captureSettler = undefined;
		settler?.resolve(code);
		respond(res, 200, CALLBACK_SUCCESS_HTML);
	}

	private failCapture(error: MCPAuthError): void {
		const settler = this.captureSettler;
		this.captureSettler = undefined;
		settler?.reject(error);
	}

	/** Builds the fetch used for discovery and token calls: signal + per-request timeout. */
	private wrappedFetch(): FetchLike {
		const base = this.fetchImpl ?? fetch;
		const signal = this.signal;
		const requestTimeoutMs = this.requestTimeoutMs;
		return (url, init) => {
			const timeoutSignal = AbortSignal.timeout(requestTimeoutMs);
			const combined = signal !== undefined ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
			return base(url, { ...init, signal: combined });
		};
	}
}

/**
 * SDK 1.30.0 `OAuthClientProvider` adapter for a single MCP server session.
 *
 * Holds per-session state in memory: tokens, dynamic client registration,
 * PKCE code verifier, the OAuth2 state parameter, and the flow's validated
 * discovery state. Tokens are never persisted and never logged; the adapter
 * is created by {@link MCPAuthFlow} and driven by the SDK `auth()`
 * orchestrator.
 */
export class MCPServerOAuthProvider implements OAuthClientProvider {
	private readonly flow: MCPAuthFlow;
	private tokensValue: OAuthTokens | undefined;
	private clientInformationValue: OAuthClientInformationMixed | undefined;
	private codeVerifierValue: string | undefined;
	private discoveryStateValue: OAuthDiscoveryState | undefined;

	constructor(flow: MCPAuthFlow) {
		this.flow = flow;
	}

	get redirectUrl(): string | undefined {
		return this.flow.callbackUrlOrThrow();
	}

	get clientMetadata(): OAuthClientMetadata {
		return {
			redirect_uris: [this.flow.callbackUrlOrThrow()],
			token_endpoint_auth_method: "none",
			grant_types: ["authorization_code"],
			response_types: ["code"],
			client_name: this.flow.clientName,
		};
	}

	state(): string | Promise<string> {
		return this.flow.generateState();
	}

	clientInformation(): OAuthClientInformationMixed | undefined {
		return this.clientInformationValue;
	}

	saveClientInformation(clientInformation: OAuthClientInformationMixed): void {
		this.clientInformationValue = clientInformation;
	}

	tokens(): OAuthTokens | undefined {
		return this.tokensValue;
	}

	saveTokens(tokens: OAuthTokens): void {
		this.tokensValue = tokens;
	}

	redirectToAuthorization(authorizationUrl: URL): Promise<void> {
		return this.flow.beginAuthorization(authorizationUrl);
	}

	saveCodeVerifier(codeVerifier: string): void {
		this.codeVerifierValue = codeVerifier;
	}

	codeVerifier(): string {
		if (this.codeVerifierValue === undefined) {
			throw new Error("No PKCE code verifier saved");
		}
		return this.codeVerifierValue;
	}

	/** Canonical resource validation: the declared resource must cover the server URL. */
	async validateResourceURL(serverUrl: string | URL, resource?: string): Promise<URL | undefined> {
		if (resource === undefined) {
			return undefined;
		}
		if (!isCanonicalMCPResourceMatch(canonicalMCPResourceUrl(serverUrl), resource)) {
			throw new MCPAuthError("resource_mismatch", this.flow.serverId);
		}
		return new URL(resource);
	}

	/**
	 * Clears per-scope session state. Discovery state is intentionally
	 * retained: a retry after credential invalidation must reuse the flow's
	 * validated discovery instead of re-discovering through the SDK's
	 * unvalidated path; a stale authorization server fails closed.
	 */
	invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
		if (scope === "tokens" || scope === "all") {
			this.tokensValue = undefined;
		}
		if (scope === "client" || scope === "all") {
			this.clientInformationValue = undefined;
		}
		if (scope === "verifier" || scope === "all") {
			this.codeVerifierValue = undefined;
		}
	}

	saveDiscoveryState(state: OAuthDiscoveryState): void {
		this.discoveryStateValue = state;
	}

	discoveryState(): OAuthDiscoveryState | undefined {
		return this.discoveryStateValue;
	}
}
