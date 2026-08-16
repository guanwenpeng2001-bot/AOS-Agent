/**
 * MCP credential namespace.
 *
 * Standalone OAuth token storage for MCP servers. It reuses the shared
 * {@link CredentialStore} (AuthStorage) for its serialized, cross-process
 * read-modify-write semantics and stores each server's tokens under a
 * namespaced providerId key:
 *
 *   mcp__<installationId>__<serverIdentity>
 *
 * The installation identity is a per-install opaque value (derived from
 * {@link CapabilityPublicIdentity}); the server identity is a deterministic,
 * non-reversible derivation of the canonical server URL. Binding metadata
 * (issuer, RFC 8707 resource, canonical server URL, granted scope) is stored
 * with the tokens and re-validated on every save/read/refresh, so tokens
 * granted by one authorization server for one MCP server can never be
 * attached to another server or installation.
 *
 * Tokens are persisted in the shared OAuthCredential shape (`type: "oauth"`
 * with `access`/`refresh`/`expires`) so the existing auth.json validation
 * passes them through untouched; the namespace key and the bound metadata are
 * what isolate them per server. `refresh` is an empty string when the server
 * issued no refresh token, `expires` is 0 when the server did not report an
 * expiry.
 *
 * Scope: this module is intentionally standalone. It must not be wired into
 * ModelRuntime, sessions, runs, audit, RPC, context, or error handling; it is
 * a storage primitive consumed by MCP OAuth flows only.
 */

import { createHash } from "node:crypto";
import type { AuthOperationOptions, Credential, CredentialStore, OAuthCredential } from "@aos-agent/ai";
import { CapabilityPublicIdentity } from "./capability-public-identity.ts";
import { mcpNamespaceSegmentError } from "./mcp-types.ts";

export const MCP_AUTH_NAMESPACE = "mcp";
const MCP_AUTH_NAMESPACE_SEPARATOR = "__";
const MCP_AUTH_INSTALLATION_DOMAIN = "mcp-auth-storage";
const MCP_AUTH_INSTALLATION_INPUT = "installation";
/** RFC 6749 scope-token: printable ASCII excluding space and DEL. */
const MCP_SCOPE_TOKEN_PATTERN = /^[\x21\x23-\x5B\x5D-\x7E]+$/;

export type MCPAuthStorageErrorCode =
	| "invalid_server_url"
	| "invalid_tokens"
	| "invalid_scope"
	| "binding_mismatch"
	| "namespace_collision";

/** Fail-closed error for MCP credential namespace validation failures. */
export class MCPAuthStorageError extends Error {
	readonly code: MCPAuthStorageErrorCode;

	constructor(code: MCPAuthStorageErrorCode, message: string) {
		super(message);
		this.name = "MCPAuthStorageError";
		this.code = code;
	}
}

/** Raw OAuth token response from an MCP authorization server (SDK OAuthTokens shape). */
export interface MCPTokenResponse {
	access_token: string;
	token_type: string;
	expires_in?: number;
	scope?: string;
	refresh_token?: string;
	id_token?: string;
}

/**
 * Stored MCP credential. Extends the shared OAuthCredential shape with the
 * binding metadata that anchors the tokens to one authorization server and
 * one MCP server.
 */
export interface MCPStoredTokens extends OAuthCredential {
	type: "oauth";
	access: string;
	/** Empty string when the server issued no refresh token. */
	refresh: string;
	/** Epoch milliseconds; 0 when the server did not report an expiry. */
	expires: number;
	tokenType: string;
	scope?: string;
	idToken?: string;
	/** Authorization server issuer (RFC 8414) the tokens were granted by. */
	issuer: string;
	/** RFC 8707 resource indicator the tokens are bound to. */
	resource?: string;
	/** Canonical server URL the tokens were granted for. */
	serverUrl: string;
}

/**
 * Expected binding for a fresh token grant. `issuer` is required for the
 * first save; `resource` and `requestedScope` come from discovery and the
 * authorization request.
 */
export interface MCPTokenBinding {
	issuer?: string;
	resource?: string;
	requestedScope?: string;
}

/** Public MCP OAuth status. Never includes tokens, URLs, issuer, or resource. */
export type MCPAuthPublicStatus = "authenticated" | "expired" | "required";

/**
 * Masked, non-secret status of one server's stored MCP credential.
 * Token values, authorization URLs, and full issuer/resource/server URLs
 * are never included.
 */
export interface MCPCredentialStatus {
	/** Opaque server identity (one-way derivation of the canonical server URL). */
	serverIdentity: string;
	status: MCPAuthPublicStatus;
}

function isValidHttpUrl(value: string): boolean {
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		return false;
	}
	return (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.hostname.length > 0;
}

function sameOrigin(a: string, b: string): boolean {
	return new URL(a).origin === new URL(b).origin;
}

function normalizeScope(scope: string): string {
	const tokens = scope.split(/\s+/).filter((token) => token.length > 0);
	for (const token of tokens) {
		if (!MCP_SCOPE_TOKEN_PATTERN.test(token)) {
			throw new MCPAuthStorageError("invalid_scope", "scope contains invalid characters");
		}
	}
	return tokens.join(" ");
}

/**
 * True when every space-separated scope token of `granted` is also present in
 * `allowed`. An undefined side imposes no constraint.
 */
export function isScopeSubset(granted: string | undefined, allowed: string | undefined): boolean {
	if (granted === undefined || allowed === undefined) return true;
	const grantedTokens = new Set(granted.split(/\s+/).filter((token) => token.length > 0));
	const allowedTokens = new Set(allowed.split(/\s+/).filter((token) => token.length > 0));
	for (const token of grantedTokens) {
		if (!allowedTokens.has(token)) return false;
	}
	return true;
}

/**
 * Canonical form of an MCP server URL used for server identity and key
 * derivation: http(s) only, host lowercased, userinfo/query/fragment and a
 * trailing slash stripped. Throws {@link MCPAuthStorageError} on invalid
 * input.
 */
export function canonicalizeMCPServerUrl(serverUrl: string): string {
	let parsed: URL;
	try {
		parsed = new URL(serverUrl);
	} catch {
		throw new MCPAuthStorageError("invalid_server_url", "MCP server URL is not a valid URL");
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new MCPAuthStorageError("invalid_server_url", "MCP server URL must use http or https");
	}
	if (parsed.hostname.length === 0) {
		throw new MCPAuthStorageError("invalid_server_url", "MCP server URL must have a host");
	}
	parsed.username = "";
	parsed.password = "";
	parsed.search = "";
	parsed.hash = "";
	const pathname = parsed.pathname.replace(/\/+$/, "");
	if (pathname.length > 0) {
		parsed.pathname = pathname;
	}
	return parsed.toString();
}

/**
 * Deterministic, non-reversible server identity for a canonical server URL
 * within one installation. Two spellings of the same URL (trailing slash,
 * host case) converge on the same identity.
 */
export function deriveMCPServerIdentity(installationId: string, serverUrl: string): string {
	const canonical = canonicalizeMCPServerUrl(serverUrl);
	return createHash("sha256")
		.update(`${MCP_AUTH_INSTALLATION_DOMAIN}\0${installationId}\0${canonical}`)
		.digest("hex");
}

/** Namespaced CredentialStore providerId for one MCP server. */
export function mcpCredentialKey(installationId: string, serverIdentity: string): string {
	return `${MCP_AUTH_NAMESPACE}${MCP_AUTH_NAMESPACE_SEPARATOR}${installationId}${MCP_AUTH_NAMESPACE_SEPARATOR}${serverIdentity}`;
}

/**
 * Per-install identity for the MCP credential namespace, derived from the
 * installation-scoped {@link CapabilityPublicIdentity} of `agentDir`. Stable
 * across processes sharing an agentDir; distinct across agentDirs.
 */
export function getMCPAuthInstallationId(agentDir: string): string {
	const identity = CapabilityPublicIdentity.loadSync(agentDir);
	return Buffer.from(identity.derive(MCP_AUTH_INSTALLATION_DOMAIN, MCP_AUTH_INSTALLATION_INPUT), "base64url").toString(
		"hex",
	);
}

/**
 * Type guard for stored MCP credentials: an OAuthCredential carrying the MCP
 * namespace metadata (tokenType/issuer/serverUrl).
 */
export function isMCPCredential(value: Credential | undefined): value is MCPStoredTokens {
	if (value?.type !== "oauth") return false;
	const record = value as Record<string, unknown>;
	return (
		typeof record.tokenType === "string" &&
		typeof record.issuer === "string" &&
		typeof record.serverUrl === "string"
	);
}

function isWellFormedStoredTokens(credential: MCPStoredTokens): boolean {
	if (typeof credential.access !== "string" || credential.access.length === 0) return false;
	if (typeof credential.refresh !== "string") return false;
	if (typeof credential.expires !== "number" || !Number.isFinite(credential.expires)) return false;
	if (typeof credential.tokenType !== "string" || credential.tokenType.length === 0) return false;
	if (typeof credential.serverUrl !== "string" || !isValidHttpUrl(credential.serverUrl)) return false;
	if (typeof credential.issuer !== "string" || !isValidHttpUrl(credential.issuer)) return false;
	if (credential.resource !== undefined) {
		if (typeof credential.resource !== "string" || !isValidHttpUrl(credential.resource)) return false;
		if (!sameOrigin(credential.resource, credential.serverUrl)) return false;
	}
	if (credential.scope !== undefined) {
		if (typeof credential.scope !== "string") return false;
		try {
			if (normalizeScope(credential.scope) !== credential.scope) return false;
		} catch {
			return false;
		}
	}
	return true;
}

export interface MCPAuthStorageOptions {
	store: CredentialStore;
	/** Opaque per-install namespace segment (see {@link getMCPAuthInstallationId}). */
	installationId: string;
	/** MCP server URL; tokens are bound to its canonical form. */
	serverUrl: string;
}

/**
 * Credential namespace for a single MCP server. All writes go through
 * `CredentialStore.modify`, so every save and refresh is a serialized
 * read-modify-write (cross-process where the backing store supports it) and
 * concurrent refreshes cannot double-rotate a refresh token.
 */
export class MCPAuthStorage {
	private readonly store: CredentialStore;
	private readonly installationId: string;
	private readonly serverUrl: string;
	private readonly key: string;

	constructor(options: MCPAuthStorageOptions) {
		const installationError = mcpNamespaceSegmentError(options.installationId);
		if (installationError !== undefined) {
			throw new MCPAuthStorageError(
				"namespace_collision",
				`MCP credential namespace installation identity ${installationError}`,
			);
		}
		this.store = options.store;
		this.installationId = options.installationId;
		this.serverUrl = canonicalizeMCPServerUrl(options.serverUrl);
		this.key = mcpCredentialKey(this.installationId, deriveMCPServerIdentity(this.installationId, this.serverUrl));
	}

	/** The namespaced providerId used in the backing CredentialStore. */
	get providerId(): string {
		return this.key;
	}

	/**
	 * Read the stored tokens. Resolves undefined when nothing is stored, when
	 * the stored record is not a well-formed MCP credential, or when the
	 * record is bound to a different server URL (fail closed).
	 */
	async readTokens(options?: AuthOperationOptions): Promise<MCPStoredTokens | undefined> {
		const credential = await this.store.read(this.key, options);
		if (!isMCPCredential(credential)) return undefined;
		if (credential.serverUrl !== this.serverUrl) return undefined;
		if (!isWellFormedStoredTokens(credential)) return undefined;
		return credential;
	}

	/**
	 * Store a freshly granted token response. Validates the response shape and
	 * the binding (issuer presence/consistency, RFC 8707 resource vs. server
	 * identity, granted scope vs. requested and previously granted scope)
	 * inside the store lock, so a mismatched grant is never persisted.
	 * Rejects on validation failure and on namespace collisions.
	 */
	async saveTokens(
		tokens: MCPTokenResponse,
		binding: MCPTokenBinding = {},
		options?: AuthOperationOptions,
	): Promise<MCPStoredTokens> {
		const result = await this.store.modify(
			this.key,
			async (current) => {
				if (current !== undefined && !isMCPCredential(current)) {
					throw new MCPAuthStorageError(
						"namespace_collision",
						`MCP credential namespace key "${this.key}" holds a non-MCP credential`,
					);
				}
				const existing =
					current !== undefined && isWellFormedStoredTokens(current) ? current : undefined;
				return this.bindTokens(tokens, binding, existing);
			},
			options,
		);
		return result as MCPStoredTokens;
	}

	/**
	 * Serialized refresh with token rotation. Runs inside the store lock: the
	 * refresher sees the latest stored tokens and a rotated refresh token is
	 * written atomically, so concurrent refreshes cannot race. A refresh token
	 * returned by the server replaces the stored one; when the response omits
	 * it, the current one is preserved. Resolves with the rotated credential,
	 * or undefined when there was nothing to refresh (no stored credential,
	 * no refresh token, or a record bound to another server URL).
	 */
	async refreshTokens(
		refresh: (current: MCPStoredTokens, signal: AbortSignal | undefined) => Promise<MCPTokenResponse>,
		options?: AuthOperationOptions,
	): Promise<MCPStoredTokens | undefined> {
		let refreshed = false;
		const result = await this.store.modify(
			this.key,
			async (current) => {
				if (!isMCPCredential(current)) return undefined;
				if (current.serverUrl !== this.serverUrl || !isWellFormedStoredTokens(current)) return undefined;
				if (current.refresh.length === 0) return undefined;
				const response = await refresh(current, options?.signal);
				refreshed = true;
				return this.bindTokens(response, {}, current);
			},
			options,
		);
		return refreshed ? (result as MCPStoredTokens) : undefined;
	}

	/** Delete the local credential for this server. */
	async deleteTokens(options?: AuthOperationOptions): Promise<void> {
		await this.store.delete(this.key, options);
	}

	/**
	 * Logout: best-effort revocation, then local deletion. A revocation
	 * failure never blocks deleting the local credential; a storage failure
	 * on deletion propagates.
	 */
	async logout(
		revoke: ((tokens: MCPStoredTokens) => Promise<void>) | undefined,
		options?: AuthOperationOptions,
	): Promise<void> {
		const current = await this.readTokens(options);
		if (current !== undefined && revoke !== undefined) {
			try {
				await revoke(current);
			} catch {
				// Best effort: revocation failure never blocks local deletion.
			}
		}
		await this.store.delete(this.key, options);
	}

	private bindTokens(
		tokens: MCPTokenResponse,
		binding: MCPTokenBinding,
		current: MCPStoredTokens | undefined,
	): MCPStoredTokens {
		if (typeof tokens.access_token !== "string" || tokens.access_token.length === 0) {
			throw new MCPAuthStorageError("invalid_tokens", "access_token must be a non-empty string");
		}
		if (typeof tokens.token_type !== "string" || tokens.token_type.length === 0) {
			throw new MCPAuthStorageError("invalid_tokens", "token_type must be a non-empty string");
		}
		let expires = 0;
		if (tokens.expires_in !== undefined) {
			if (typeof tokens.expires_in !== "number" || !Number.isFinite(tokens.expires_in) || tokens.expires_in <= 0) {
				throw new MCPAuthStorageError("invalid_tokens", "expires_in must be a positive number");
			}
			expires = Date.now() + Math.round(tokens.expires_in * 1000);
		}
		if (tokens.scope !== undefined && typeof tokens.scope !== "string") {
			throw new MCPAuthStorageError("invalid_tokens", "scope must be a string");
		}
		if (tokens.refresh_token !== undefined && typeof tokens.refresh_token !== "string") {
			throw new MCPAuthStorageError("invalid_tokens", "refresh_token must be a string");
		}
		if (tokens.id_token !== undefined && typeof tokens.id_token !== "string") {
			throw new MCPAuthStorageError("invalid_tokens", "id_token must be a string");
		}

		const issuer = binding.issuer ?? current?.issuer;
		if (issuer === undefined) {
			throw new MCPAuthStorageError(
				"binding_mismatch",
				"an issuer (authorization server) is required to store MCP tokens",
			);
		}
		if (!isValidHttpUrl(issuer)) {
			throw new MCPAuthStorageError("binding_mismatch", "issuer is not a valid http(s) URL");
		}
		if (current !== undefined && current.issuer !== issuer) {
			throw new MCPAuthStorageError("binding_mismatch", "issuer does not match the stored credential's issuer");
		}

		const resource = binding.resource ?? current?.resource;
		if (resource !== undefined) {
			if (!isValidHttpUrl(resource)) {
				throw new MCPAuthStorageError("binding_mismatch", "resource is not a valid http(s) URL");
			}
			if (!sameOrigin(resource, this.serverUrl)) {
				throw new MCPAuthStorageError("binding_mismatch", "resource does not match the server identity");
			}
			if (current?.resource !== undefined && current.resource !== resource) {
				throw new MCPAuthStorageError("binding_mismatch", "resource does not match the stored credential's resource");
			}
		}

		let scope: string | undefined;
		if (tokens.scope !== undefined) {
			scope = normalizeScope(tokens.scope);
		} else if (binding.requestedScope !== undefined) {
			scope = normalizeScope(binding.requestedScope);
		} else {
			scope = current?.scope;
		}
		if (binding.requestedScope !== undefined && scope !== undefined) {
			if (!isScopeSubset(scope, normalizeScope(binding.requestedScope))) {
				throw new MCPAuthStorageError("invalid_scope", "granted scope exceeds the requested scope");
			}
		}
		if (current?.scope !== undefined && scope !== undefined && !isScopeSubset(scope, current.scope)) {
			throw new MCPAuthStorageError("invalid_scope", "granted scope exceeds the previously granted scope");
		}

		const refreshToken = tokens.refresh_token !== undefined ? tokens.refresh_token : (current?.refresh ?? "");

		return {
			type: "oauth",
			access: tokens.access_token,
			refresh: refreshToken,
			expires,
			tokenType: tokens.token_type,
			...(scope !== undefined ? { scope } : {}),
			...(tokens.id_token !== undefined ? { idToken: tokens.id_token } : {}),
			issuer,
			...(resource !== undefined ? { resource } : {}),
			serverUrl: this.serverUrl,
		};
	}
}

/**
 * List masked status for every MCP credential under `installationId` in the
 * backing store. Only non-secret metadata is surfaced; token values are never
 * read out of the namespace. Entries outside the namespace prefix and
 * ill-formed records are skipped.
 */
export async function listMCPCredentialStatuses(
	store: CredentialStore,
	installationId: string,
	options?: AuthOperationOptions,
): Promise<readonly MCPCredentialStatus[]> {
	const installationError = mcpNamespaceSegmentError(installationId);
	if (installationError !== undefined) {
		throw new MCPAuthStorageError(
			"namespace_collision",
			`MCP credential namespace installation identity ${installationError}`,
		);
	}
	const prefix = mcpCredentialKey(installationId, "");
	const statuses: MCPCredentialStatus[] = [];
	for (const { providerId } of await store.list(options)) {
		if (!providerId.startsWith(prefix)) continue;
		const credential = await store.read(providerId, options);
		if (!isMCPCredential(credential)) continue;
		if (!isWellFormedStoredTokens(credential)) continue;
		const expired = credential.expires > 0 && credential.expires <= Date.now();
		statuses.push({
			serverIdentity: providerId.slice(prefix.length),
			status: expired ? "expired" : "authenticated",
		});
	}
	return statuses;
}
