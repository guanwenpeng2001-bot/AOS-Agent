/**
 * MCP credential namespace/storage adapter.
 *
 * MCP OAuth credentials are persisted through the existing app-owned
 * CredentialStore (auth.json, proper-lockfile, serialized modify) but never as
 * model provider credentials: every record lives under a `mcp:` storage key
 * that cannot collide with a `Provider.id`, so ModelRuntime provider
 * enumeration can never observe an MCP record.
 *
 * Isolation rules enforced here:
 * - The storage key is derived from an installation-scoped source id plus the
 *   MCP server id; both segments are namespace-validated so a custom server id
 *   cannot address another server's record.
 * - Every record carries its binding (server identity, issuer, canonical
 *   resource, scopes, optional client id). read/save/refresh/logout reject a
 *   record whose binding does not match the caller's scope + binding.
 * - Refresh token rotation runs inside `CredentialStore.modify`, which is
 *   serialized per key; the rotation also bumps a monotonic revision so a
 *   stale refresh can never write over a newer record.
 * - Logout always clears the local record; revocation is best-effort and a
 *   revoke failure never blocks deletion.
 * - Only the typed internal record carries secrets. Status/list views are
 *   secret-free, and errors are fixed templates that never embed raw tokens,
 *   URIs, parameters, or remote text.
 */

import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore, OAuthCredential } from "@aos-agent/ai";

/** Namespace-identity of one MCP server's credential slot. */
export interface MCPCredentialScope {
	/** Installation-scoped MCP source id (e.g. "global" or "project"). */
	sourceId: string;
	/** MCP server id from settings. User-controlled; namespace-validated. */
	serverId: string;
	/** Canonical identity of the server the credential was issued for. */
	serverIdentity: string;
}

/** OAuth binding metadata every MCP credential must match. */
export interface MCPCredentialBinding {
	/** OAuth issuer (authorization server issuer URL). */
	issuer: string;
	/** Canonical resource (RFC 8707 resource indicator). */
	resource: string;
	/** Scopes the credential was authorized for. */
	scopes: readonly string[];
	/** Optional OAuth client id bound to the credential. */
	clientId?: string;
}

/** Options for logout: optional best-effort revocation before local deletion. */
export interface MCPLogoutOptions extends AuthOperationOptions {
	/** Best-effort remote revocation; failures never block local deletion. */
	revoke?: (record: MCPCredentialRecord) => Promise<void>;
}

/** Non-secret token data produced by an OAuth flow or a refresh. */
export interface MCPTokenSet {
	/** Access token (secret). Must be non-empty. */
	access: string;
	/** Refresh token (secret); empty when the flow has none. */
	refresh?: string;
	/** Access token expiry epoch ms; 0 when unknown. */
	expires?: number;
}

/**
 * Secret-bearing internal MCP OAuth credential record.
 *
 * Stored through the CredentialStore contract as an `OAuthCredential` so the
 * existing serialized modify/lock behavior applies unchanged. Never surface
 * this record outside the adapter: `access`/`refresh` are secrets.
 */
export interface MCPCredentialRecord extends OAuthCredential {
	type: "oauth";
	/** Access token (secret). */
	access: string;
	/** Refresh token (secret); empty string when the flow has none. */
	refresh: string;
	/** Access token expiry epoch ms; 0 when unknown. */
	expires: number;
	/** Server identity binding. */
	serverIdentity: string;
	/** Issuer binding. */
	issuer: string;
	/** Canonical resource binding. */
	resource: string;
	/** Authorized scopes. */
	scopes: string[];
	/** Optional client id binding. */
	clientId?: string;
	/**
	 * Monotonic rotation revision. Every save/refresh writes
	 * `storedRevision + 1` inside the serialized modify, so a concurrent
	 * refresh can never overwrite a newer record.
	 */
	revision: number;
}

export type MCPCredentialStatus = "none" | "authenticated" | "expired";

/** Secret-free status of one MCP credential slot. */
export interface MCPCredentialStatusView {
	/** MCP server id (from the namespace scope). */
	serverId: string;
	/** Whether a credential record exists for this server. */
	hasCredential: boolean;
	/** Lifecycle status derived from the stored expiry. */
	status: MCPCredentialStatus;
	/** Access token expiry epoch ms; 0 when absent or unknown. */
	expiresAt: number;
	/** Authorized scopes (non-secret). */
	scopes: readonly string[];
	/** Bound OAuth client id (non-secret), when known. */
	clientId?: string;
	/** Credential revision (non-secret). */
	revision: number;
}

export type MCPAuthStorageErrorCode =
	| "mcp_auth_storage_invalid_scope"
	| "mcp_auth_storage_invalid_record"
	| "mcp_auth_binding_mismatch"
	| "mcp_auth_not_found";

/**
 * Fail-closed storage error. Messages are fixed templates; raw tokens, URIs,
 * parameters, and remote text never enter the message or `toJSON()` output.
 */
export class MCPAuthStorageError extends Error {
	readonly code: MCPAuthStorageErrorCode;
	readonly serverId: string;

	constructor(code: MCPAuthStorageErrorCode, serverId: string, message: string) {
		super(message);
		this.name = "MCPAuthStorageError";
		this.code = code;
		this.serverId = serverId;
	}

	toJSON(): { name: string; code: MCPAuthStorageErrorCode; serverId: string; message: string } {
		return { name: this.name, code: this.code, serverId: this.serverId, message: this.message };
	}
}

const MCP_STORAGE_KEY_PREFIX = "mcp:";
const MCP_STORAGE_SEGMENT_INVALID = /[\s:]/;

/** Validates one storage-key segment (same rules as MCP namespace segments). */
function storageSegmentError(segment: string): string | undefined {
	if (segment.length === 0) {
		return "must not be empty";
	}
	if (segment.includes("__")) {
		return "must not contain a double underscore";
	}
	if (MCP_STORAGE_SEGMENT_INVALID.test(segment)) {
		return "must not contain whitespace or ':'";
	}
	return undefined;
}

function requireStorageKeySegments(scope: MCPCredentialScope): void {
	const serverId = scope.serverId;
	const sourceError = storageSegmentError(scope.sourceId);
	if (sourceError !== undefined) {
		throw new MCPAuthStorageError(
			"mcp_auth_storage_invalid_scope",
			serverId,
			`MCP credential namespace source id ${sourceError}`,
		);
	}
	const serverError = storageSegmentError(scope.serverId);
	if (serverError !== undefined) {
		throw new MCPAuthStorageError(
			"mcp_auth_storage_invalid_scope",
			serverId,
			`MCP credential namespace server id ${serverError}`,
		);
	}
}

function requireNonEmpty(value: string, label: string): void {
	if (value.length === 0) {
		throw new Error(`${label} must not be empty`);
	}
}

function requireScopeBinding(scope: MCPCredentialScope, binding: MCPCredentialBinding): void {
	requireNonEmpty(scope.serverIdentity, "server identity");
	requireNonEmpty(binding.issuer, "issuer");
	requireNonEmpty(binding.resource, "resource");
}

function scopeSetsEqual(a: readonly string[], b: readonly string[]): boolean {
	if (a.length !== b.length) return false;
	const sortedA = [...a].sort();
	const sortedB = [...b].sort();
	return sortedA.every((scope, index) => scope === sortedB[index]);
}

function verifyBinding(record: MCPCredentialRecord, scope: MCPCredentialScope, binding: MCPCredentialBinding): void {
	if (record.serverIdentity !== scope.serverIdentity) {
		throw new MCPAuthStorageError(
			"mcp_auth_binding_mismatch",
			scope.serverId,
			"MCP credential server identity does not match the requested scope",
		);
	}
	if (record.issuer !== binding.issuer) {
		throw new MCPAuthStorageError(
			"mcp_auth_binding_mismatch",
			scope.serverId,
			"MCP credential issuer does not match the requested binding",
		);
	}
	if (record.resource !== binding.resource) {
		throw new MCPAuthStorageError(
			"mcp_auth_binding_mismatch",
			scope.serverId,
			"MCP credential resource does not match the requested binding",
		);
	}
	if (binding.clientId !== undefined && record.clientId !== binding.clientId) {
		throw new MCPAuthStorageError(
			"mcp_auth_binding_mismatch",
			scope.serverId,
			"MCP credential client id does not match the requested binding",
		);
	}
	if (binding.scopes.length > 0 && !scopeSetsEqual(record.scopes, binding.scopes)) {
		throw new MCPAuthStorageError(
			"mcp_auth_binding_mismatch",
			scope.serverId,
			"MCP credential scopes do not match the requested binding",
		);
	}
}

function invalidRecordError(serverId: string): MCPAuthStorageError {
	return new MCPAuthStorageError(
		"mcp_auth_storage_invalid_record",
		serverId,
		"Stored MCP credential record is malformed",
	);
}

/**
 * Parses a stored credential into an MCP record. Returns undefined when no
 * record is stored; throws `mcp_auth_storage_invalid_record` when the stored
 * value is not a well-formed MCP OAuth record (fail closed).
 */
function parseMCPCredentialRecord(
	credential: Credential | undefined,
	serverId: string,
): MCPCredentialRecord | undefined {
	if (credential === undefined) return undefined;
	if (credential.type !== "oauth") throw invalidRecordError(serverId);
	const record = credential as OAuthCredential;
	const access = record.access;
	const refresh = record.refresh;
	const expires = record.expires;
	const serverIdentity = record.serverIdentity;
	const issuer = record.issuer;
	const resource = record.resource;
	const scopes = record.scopes;
	const revision = record.revision;
	const clientId = record.clientId;
	if (typeof access !== "string" || access.length === 0) throw invalidRecordError(serverId);
	if (typeof refresh !== "string") throw invalidRecordError(serverId);
	if (typeof expires !== "number" || !Number.isFinite(expires)) throw invalidRecordError(serverId);
	if (typeof serverIdentity !== "string" || serverIdentity.length === 0) throw invalidRecordError(serverId);
	if (typeof issuer !== "string" || issuer.length === 0) throw invalidRecordError(serverId);
	if (typeof resource !== "string" || resource.length === 0) throw invalidRecordError(serverId);
	if (!Array.isArray(scopes) || !scopes.every((scope) => typeof scope === "string" && scope.length > 0)) {
		throw invalidRecordError(serverId);
	}
	if (typeof revision !== "number" || !Number.isFinite(revision)) throw invalidRecordError(serverId);
	if (clientId !== undefined && (typeof clientId !== "string" || clientId.length === 0)) {
		throw invalidRecordError(serverId);
	}
	return {
		type: "oauth",
		access,
		refresh,
		expires,
		serverIdentity,
		issuer,
		resource,
		scopes: [...scopes],
		...(clientId !== undefined ? { clientId } : {}),
		revision,
	} satisfies MCPCredentialRecord;
}

/**
 * MCP credential namespace adapter over any CredentialStore.
 *
 * The namespace is per installation-scoped source + server id; every record is
 * additionally bound to server identity, issuer, canonical resource, scopes,
 * and an optional client id, and every operation re-verifies that binding.
 */
export class MCPCredentialNamespace {
	private readonly store: CredentialStore;
	private readonly now: () => number;

	constructor(store: CredentialStore, now: () => number = Date.now) {
		this.store = store;
		this.now = now;
	}

	/** Storage key for a scope; throws `mcp_auth_storage_invalid_scope` for invalid segments. */
	storageKey(scope: MCPCredentialScope): string {
		requireStorageKeySegments(scope);
		return `${MCP_STORAGE_KEY_PREFIX}${scope.sourceId}:${scope.serverId}`;
	}

	/**
	 * Read the stored record for a scope. Resolves undefined when no record
	 * exists; rejects on binding mismatch or a malformed stored record.
	 */
	async read(
		scope: MCPCredentialScope,
		binding: MCPCredentialBinding,
		options?: AuthOperationOptions,
	): Promise<MCPCredentialRecord | undefined> {
		options?.signal?.throwIfAborted();
		requireScopeBinding(scope, binding);
		const key = this.storageKey(scope);
		const record = parseMCPCredentialRecord(await this.store.read(key, options), scope.serverId);
		options?.signal?.throwIfAborted();
		if (record !== undefined) verifyBinding(record, scope, binding);
		return record;
	}

	/**
	 * Persist a credential after login. Rejects when an existing record under
	 * the same key is bound to a different binding: the caller must logout
	 * first, otherwise a stale credential would shadow the new login.
	 */
	async save(
		scope: MCPCredentialScope,
		binding: MCPCredentialBinding,
		tokens: MCPTokenSet,
		options?: AuthOperationOptions,
	): Promise<MCPCredentialRecord> {
		options?.signal?.throwIfAborted();
		requireScopeBinding(scope, binding);
		requireNonEmpty(tokens.access, "access token");
		const key = this.storageKey(scope);
		const record = await this.store.modify(
			key,
			async (current) => {
				const existing = parseMCPCredentialRecord(current, scope.serverId);
				if (existing !== undefined) verifyBinding(existing, scope, binding);
				const next: MCPCredentialRecord = {
					type: "oauth",
					access: tokens.access,
					refresh: tokens.refresh ?? "",
					expires: tokens.expires ?? 0,
					serverIdentity: scope.serverIdentity,
					issuer: binding.issuer,
					resource: binding.resource,
					scopes: [...binding.scopes],
					...(binding.clientId !== undefined ? { clientId: binding.clientId } : {}),
					revision: (existing?.revision ?? 0) + 1,
				};
				return next;
			},
			options,
		);
		return record as MCPCredentialRecord;
	}

	/**
	 * Serialized refresh-token rotation. `refreshTokens` receives the current
	 * record inside the store's serialized modify, so concurrent refreshes see
	 * the latest rotation and a stale network result can never write over a
	 * newer record. Rejects with `mcp_auth_not_found` when no record exists.
	 */
	async refresh(
		scope: MCPCredentialScope,
		binding: MCPCredentialBinding,
		refreshTokens: (current: MCPCredentialRecord) => Promise<MCPTokenSet>,
		options?: AuthOperationOptions,
	): Promise<MCPCredentialRecord> {
		options?.signal?.throwIfAborted();
		requireScopeBinding(scope, binding);
		const key = this.storageKey(scope);
		const record = await this.store.modify(
			key,
			async (current) => {
				const stored = parseMCPCredentialRecord(current, scope.serverId);
				if (stored === undefined) {
					throw new MCPAuthStorageError(
						"mcp_auth_not_found",
						scope.serverId,
						"No stored MCP credential to refresh",
					);
				}
				verifyBinding(stored, scope, binding);
				const tokens = await refreshTokens(stored);
				requireNonEmpty(tokens.access, "refreshed access token");
				const next: MCPCredentialRecord = {
					...stored,
					access: tokens.access,
					refresh: tokens.refresh ?? stored.refresh,
					expires: tokens.expires ?? stored.expires,
					revision: stored.revision + 1,
				};
				return next;
			},
			options,
		);
		return record as MCPCredentialRecord;
	}

	/**
	 * Logout: revoke best-effort (when `options.revoke` is supplied) and always
	 * delete the local record. Rejects on binding mismatch; resolves false when
	 * no record existed. A revoke failure never blocks deletion.
	 */
	async logout(scope: MCPCredentialScope, binding: MCPCredentialBinding, options?: MCPLogoutOptions): Promise<boolean> {
		options?.signal?.throwIfAborted();
		requireScopeBinding(scope, binding);
		const record = await this.read(scope, binding, options);
		if (record === undefined) return false;
		if (options?.revoke !== undefined) {
			try {
				await options.revoke(record);
			} catch {
				// Best-effort revocation: never block local logout on remote failure.
			}
		}
		options?.signal?.throwIfAborted();
		await this.store.delete(this.storageKey(scope), options);
		return true;
	}

	/**
	 * Secret-free status of one credential slot. `binding` is optional; when
	 * supplied the stored binding is verified and a mismatch rejects.
	 */
	async status(
		scope: MCPCredentialScope,
		binding?: MCPCredentialBinding,
		options?: AuthOperationOptions,
	): Promise<MCPCredentialStatusView> {
		options?.signal?.throwIfAborted();
		const key = this.storageKey(scope);
		const record = parseMCPCredentialRecord(await this.store.read(key, options), scope.serverId);
		options?.signal?.throwIfAborted();
		if (record === undefined) {
			return { serverId: scope.serverId, hasCredential: false, status: "none", expiresAt: 0, scopes: [], revision: 0 };
		}
		if (binding !== undefined) verifyBinding(record, scope, binding);
		const expired = record.expires > 0 && record.expires <= this.now();
		return {
			serverId: scope.serverId,
			hasCredential: true,
			status: expired ? "expired" : "authenticated",
			expiresAt: record.expires,
			scopes: [...record.scopes],
			...(record.clientId !== undefined ? { clientId: record.clientId } : {}),
			revision: record.revision,
		};
	}

	/**
	 * Secret-free status of every MCP credential slot in the store. Non-MCP
	 * entries (model provider credentials) are ignored; a malformed record
	 * under an MCP key fails closed.
	 */
	async list(options?: AuthOperationOptions): Promise<readonly MCPCredentialStatusView[]> {
		options?.signal?.throwIfAborted();
		const entries = await this.store.list(options);
		options?.signal?.throwIfAborted();
		const views: MCPCredentialStatusView[] = [];
		for (const entry of entries) {
			const parsed = parseMCPStorageKey(entry.providerId);
			if (parsed === undefined) continue;
			const record = parseMCPCredentialRecord(await this.store.read(entry.providerId, options), parsed.serverId);
			options?.signal?.throwIfAborted();
			if (record === undefined) continue;
			const expired = record.expires > 0 && record.expires <= this.now();
			views.push({
				serverId: parsed.serverId,
				hasCredential: true,
				status: expired ? "expired" : "authenticated",
				expiresAt: record.expires,
				scopes: [...record.scopes],
				...(record.clientId !== undefined ? { clientId: record.clientId } : {}),
				revision: record.revision,
			});
		}
		return views;
	}
}

/** Parses an `mcp:<sourceId>:<serverId>` storage key; undefined when not an MCP key. */
export function parseMCPStorageKey(key: string): { sourceId: string; serverId: string } | undefined {
	if (!key.startsWith(MCP_STORAGE_KEY_PREFIX)) return undefined;
	const segments = key.slice(MCP_STORAGE_KEY_PREFIX.length).split(":");
	if (segments.length !== 2) return undefined;
	const [sourceId, serverId] = segments;
	if (sourceId.length === 0 || serverId.length === 0) return undefined;
	return { sourceId, serverId };
}

/** Lists only the MCP credential entries of an underlying store (secret-free metadata). */
export async function listMCPCredentialEntries(
	store: CredentialStore,
	options?: AuthOperationOptions,
): Promise<readonly CredentialInfo[]> {
	const entries = await store.list(options);
	options?.signal?.throwIfAborted();
	return entries.filter((entry) => parseMCPStorageKey(entry.providerId) !== undefined);
}
