import { newFoundationId, sha256HexValue, type FoundationJsonValue } from "../foundation/index.ts";
import type { ArtifactReference, SessionArtifactStore } from "../artifacts.ts";
import type { Session } from "../session/session.ts";
import { SessionLedgerBindingError, type SessionLedgerWriter, LEDGER_OBJECT_TYPES, assertSessionLedgerWriterSession, type SessionLedgerWriterOptions } from "../session/ledger-writer.ts";

export const MEMORY_SCHEMA_VERSION = 1 as const;
export type MemoryScopeKind = "session" | "project" | "goal" | "child";
export const MEMORY_SCOPES: readonly MemoryScopeKind[] = ["session", "project", "goal", "child"];
export type MemoryKind = "fact" | "note" | "decision" | "requirement" | "error";
export const MEMORY_KINDS: readonly MemoryKind[] = ["fact", "note", "decision", "requirement", "error"];
export type MemoryTrust = "builtin" | "user_owned" | "trusted_project" | "untrusted_project" | "user" | "tool" | "model" | "external" | "untrusted";

export interface MemoryRetentionPolicy {
	readonly policy: "session" | "goal" | "project" | "indefinite";
	readonly expiresAt?: number | string;
	readonly purgeOnScopeClose: boolean;
}
export type MemoryRetentionInput = Omit<MemoryRetentionPolicy, "purgeOnScopeClose"> & { readonly purgeOnScopeClose?: boolean };
export const DEFAULT_MEMORY_RETENTION: MemoryRetentionPolicy = { policy: "session", purgeOnScopeClose: true };

export interface MemoryProvenance {
	readonly source: string;
	readonly sourceDigest?: string;
	readonly sourceId?: string;
	readonly snapshotId?: string;
	readonly runId?: string;
	readonly ownerId?: string;
	readonly parentId?: string;
	readonly scopeId?: string;
	readonly createdBy?: "explicit" | "import" | "system";
}

/** Identity boundary for one independent memory scope. */
export interface MemoryScopeDescriptor {
	readonly kind: MemoryScopeKind;
	readonly scopeId: string;
	readonly ownerId: string;
	readonly parentId?: string;
}

/** Stable public scope identity used by the memory contract. */
export interface MemoryScope {
	readonly kind: MemoryScopeKind;
	readonly ownerId: string;
	readonly parentScopeId?: string;
	readonly scopeId: string;
}

export type MemoryProvenanceBoundary = Partial<Pick<MemoryProvenance, "sourceDigest" | "sourceId" | "snapshotId" | "runId" | "ownerId" | "parentId" | "scopeId" | "createdBy">>;

export interface MemoryPolicy {
	readonly allowedTrust?: readonly MemoryTrust[];
	readonly allowedScopes?: readonly MemoryScopeKind[];
	readonly kinds?: readonly MemoryKind[];
	readonly maxEntries?: number;
	readonly maxTokens?: number;
	readonly retention?: MemoryRetentionInput | MemoryRetentionPolicy["policy"];
}

/** Durable memory record. Content is only an artifact reference. */
export interface MemoryRecord {
	readonly schemaVersion: 1;
	readonly id: string;
	readonly kind: MemoryKind;
	readonly trust: MemoryTrust;
	readonly source: string;
	readonly scope: MemoryScopeKind;
	readonly scopeId: string;
	readonly ownerId: string;
	readonly parentId?: string;
	readonly provenance: MemoryProvenance;
	readonly retention: MemoryRetentionPolicy;
	readonly contentRef: ArtifactReference;
	readonly contentDigest: string;
	readonly contentBytes: number;
	readonly redacted: boolean;
	readonly createdAt: number;
}

/** Hydrated projection; this body is never included in the ledger fact. */
export interface MemoryEntry extends MemoryRecord {
	readonly content: string;
}

export type NewMemoryEntry = {
	readonly id?: string;
	readonly kind: MemoryKind;
	readonly trust: MemoryTrust;
	readonly content: string;
	readonly source: string;
	readonly scope?: MemoryScopeKind;
	readonly scopeId?: string;
	readonly ownerId?: string;
	readonly parentId?: string;
	readonly provenance?: Partial<MemoryProvenance>;
	readonly retention?: MemoryRetentionInput | MemoryRetentionPolicy["policy"];
	readonly principal?: string;
	readonly clientRequestId?: string;
};

export interface MemoryQuery {
	readonly kind?: MemoryKind;
	readonly trust?: MemoryTrust;
	readonly scope?: MemoryScopeKind;
	readonly scopeId?: string;
	readonly ownerId?: string;
	readonly parentId?: string;
	readonly provenance?: MemoryProvenanceBoundary;
	readonly sourceId?: string;
	readonly activeAt?: number;
	readonly includeExpired?: boolean;
	readonly limit?: number;
}

export interface MemoryReference {
	readonly type: "memory";
	readonly id: string;
	readonly digest: string;
	readonly scope: MemoryScopeKind;
	readonly scopeId: string;
	readonly ownerId: string;
	readonly parentId?: string;
	readonly kind: MemoryKind;
	readonly trust: MemoryTrust;
	readonly redacted: true;
}

export interface MemoryStore {
	put(entry: NewMemoryEntry): Promise<MemoryEntry>;
	get(id: string, principal?: string): Promise<MemoryEntry | undefined>;
	list(query?: MemoryQuery, principal?: string): Promise<MemoryEntry[]>;
	delete(id: string, principal?: string): Promise<boolean>;
	count(query?: MemoryQuery, principal?: string): Promise<number>;
	purgeExpired(now?: number): Promise<number>;
}

export interface MemoryStoreScopeOptions {
	readonly scope?: MemoryScopeKind;
	readonly scopeId?: string;
	readonly ownerId?: string;
	readonly parentId?: string;
	readonly provenance?: MemoryProvenanceBoundary;
}

export type MemoryChildScopeOptions = MemoryStoreScopeOptions;

export type MemoryErrorCode = "invalid_entry" | "invalid_query" | "policy_denied" | "limit_reached" | "storage";
export class MemoryError extends Error {
	readonly code: MemoryErrorCode;
	constructor(code: MemoryErrorCode, message: string, cause?: Error) {
		super(message, cause === undefined ? undefined : { cause });
		this.name = "MemoryError";
		this.code = code;
	}
}

function redact(text: string): { text: string; changed: boolean } {
	const patterns = [
		/((?:api[_-]?key|token|password|secret)\s*[:=]\s*)([^\s,;]+)/gi,
		/\b(sk-[A-Za-z0-9_-]{16,})\b/g,
		/\b(gh[pousr]_[A-Za-z0-9_]{16,})\b/g,
	];
	let result = text;
	for (const pattern of patterns) result = result.replace(pattern, (_match, prefix?: string) => `${prefix ?? ""}[REDACTED]`);
	return { text: result, changed: result !== text };
}

const MEMORY_RETENTION_POLICIES: readonly MemoryRetentionPolicy["policy"][] = ["session", "goal", "project", "indefinite"];

export function defaultMemoryRetention(scope: MemoryScopeKind): MemoryRetentionPolicy {
	if (scope === "session" || scope === "child") return { policy: "session", purgeOnScopeClose: true };
	if (scope === "goal") return { policy: "goal", purgeOnScopeClose: true };
	return { policy: "project", purgeOnScopeClose: false };
}

function retentionExpiry(retention: Pick<MemoryRetentionPolicy, "expiresAt">): number | undefined {
	if (retention.expiresAt === undefined) return undefined;
	return typeof retention.expiresAt === "number" ? retention.expiresAt : Date.parse(retention.expiresAt);
}

function retentionExpired(retention: Pick<MemoryRetentionPolicy, "expiresAt">, at: number): boolean {
	const expiry = retentionExpiry(retention);
	return expiry !== undefined && Number.isFinite(expiry) && expiry <= at;
}

function normalizeRetention(value: NewMemoryEntry["retention"], fallback: MemoryRetentionInput, scope: MemoryScopeKind): MemoryRetentionPolicy {
	const retention = typeof value === "string" ? { policy: value } : value ?? fallback;
	if (!MEMORY_RETENTION_POLICIES.includes(retention.policy)) throw new MemoryError("invalid_entry", "Invalid memory retention policy");
	if (retention.expiresAt !== undefined) {
		const expiry = retentionExpiry(retention);
		if (expiry === undefined || !Number.isFinite(expiry) || expiry < 0 || (typeof retention.expiresAt === "string" && retention.expiresAt.trim().length === 0)) {
			throw new MemoryError("invalid_entry", "Invalid memory expiry");
		}
	}
	const defaultPolicy = defaultMemoryRetention(scope);
	return {
		policy: retention.policy,
		...(retention.expiresAt === undefined ? {} : { expiresAt: retention.expiresAt }),
		purgeOnScopeClose: retention.purgeOnScopeClose ?? defaultPolicy.purgeOnScopeClose,
	};
}

function hasValidRetention(retention: unknown): retention is MemoryRetentionPolicy {
	if (retention === null || typeof retention !== "object") return false;
	const value = retention as Partial<MemoryRetentionPolicy>;
	if (!MEMORY_RETENTION_POLICIES.includes(value.policy as MemoryRetentionPolicy["policy"]) || typeof value.purgeOnScopeClose !== "boolean") return false;
	if (value.expiresAt === undefined) return true;
	const expiry = retentionExpiry(value);
	return expiry !== undefined && Number.isFinite(expiry) && expiry >= 0 && (typeof value.expiresAt !== "string" || value.expiresAt.trim().length > 0);
}

function allowed(policy: MemoryPolicy | undefined, value: Pick<MemoryRecord, "kind" | "trust" | "scope">): boolean {
	if (policy?.allowedTrust !== undefined && !policy.allowedTrust.includes(value.trust)) return false;
	if (policy?.allowedScopes !== undefined && !policy.allowedScopes.includes(value.scope)) return false;
	if (policy?.kinds !== undefined && !policy.kinds.includes(value.kind)) return false;
	return true;
}

function cloneEntry(entry: MemoryEntry): MemoryEntry {
	return structuredClone(entry);
}

function requireIdentity(value: string | undefined, field: string): string {
	if (value === undefined || value.length === 0) throw new MemoryError("invalid_entry", `Memory ${field} must be non-empty`);
	return value;
}

function identityMatches(left: string | undefined, right: string | undefined): boolean {
	return left === undefined || right === undefined || left === right;
}

function provenanceMatchesBoundary(provenance: Partial<MemoryProvenance>, boundary: MemoryProvenanceBoundary): boolean {
	for (const key of ["sourceDigest", "sourceId", "snapshotId", "runId", "ownerId", "parentId", "scopeId", "createdBy"] as const) {
		if (boundary[key] !== undefined && provenance[key] !== undefined && provenance[key] !== boundary[key]) return false;
	}
	return true;
}

function provenanceMatchesQuery(provenance: MemoryProvenance, query: MemoryProvenanceBoundary | undefined): boolean {
	if (query === undefined) return true;
	for (const key of ["sourceDigest", "sourceId", "snapshotId", "runId", "ownerId", "parentId", "scopeId", "createdBy"] as const) {
		if (query[key] !== undefined && provenance[key] !== query[key]) return false;
	}
	return true;
}

function scopeMatchesQuery(record: Pick<MemoryRecord, "scope" | "scopeId" | "ownerId" | "parentId">, query: MemoryQuery): boolean {
	return (
		(query.scope === undefined || record.scope === query.scope) &&
		(query.scopeId === undefined || record.scopeId === query.scopeId) &&
		(query.ownerId === undefined || record.ownerId === query.ownerId) &&
		(query.parentId === undefined || record.parentId === query.parentId)
	);
}

function scopeMatchesBoundary(record: Pick<MemoryRecord, "scopeId" | "ownerId" | "parentId">, boundary: MemoryScopeDescriptor): boolean {
	return record.scopeId === boundary.scopeId && record.ownerId === boundary.ownerId && record.parentId === boundary.parentId;
}

function hasValidRecordProvenance(record: MemoryRecord): boolean {
	return (
		record.provenance.source === record.source &&
		record.provenance.sourceDigest === `sha256:${sha256HexValue(new TextEncoder().encode(record.source))}` &&
		record.provenance.ownerId === record.ownerId &&
		record.provenance.scopeId === record.scopeId &&
		record.provenance.parentId === record.parentId
	);
}

function hasValidRecordSchema(record: MemoryRecord): boolean {
	return record.schemaVersion === MEMORY_SCHEMA_VERSION && MEMORY_SCOPES.includes(record.scope) && hasValidRetention(record.retention);
}

/** A durable memory view. It never keeps a second in-memory authority. */
export class SessionMemoryStore implements MemoryStore {
	readonly session: Session;
	readonly writer: SessionLedgerWriter;
	readonly artifacts: SessionArtifactStore;
	private readonly policy?: MemoryPolicy;
	private readonly now: () => number;
	readonly scope: MemoryScopeDescriptor;
	private readonly provenanceBoundary: MemoryProvenanceBoundary;
	private readonly enforcedScope?: MemoryScopeKind;

	constructor(
		session: Session,
		artifacts: SessionArtifactStore,
		options: SessionLedgerWriterOptions & {
			readonly policy?: MemoryPolicy;
			readonly now?: () => number;
			readonly writer?: SessionLedgerWriter;
			readonly memoryScopeId?: string;
			readonly memoryOwnerId?: string;
			readonly memoryParentId?: string;
			readonly memoryProvenance?: MemoryProvenanceBoundary;
			readonly memoryScope?: MemoryScopeKind;
			readonly enforceMemoryScope?: boolean;
			readonly scopeId?: string;
			readonly parentId?: string;
		} = {},
	) {
		this.session = session;
		this.writer = options.writer ?? artifacts.writer;
		assertSessionLedgerWriterSession(session, this.writer, "MemoryStore");
		if (artifacts.session !== session) throw new SessionLedgerBindingError("MemoryStore and ArtifactStore must use the same Session");
		if (artifacts.writer !== this.writer) throw new SessionLedgerBindingError("MemoryStore and ArtifactStore must share one SessionLedgerWriter");
		this.artifacts = artifacts;
		this.policy = options.policy;
		this.now = options.now ?? Date.now;
		// The Session ledger writer owner is a lease identity, not a memory subject.
		// Keep the memory subject stable when a reopened Session acquires a new lease.
		const scopeId = options.memoryScopeId ?? options.scopeId ?? "session";
		const ownerId = options.memoryOwnerId ?? "session";
		const parentId = options.memoryParentId ?? options.parentId;
		const kind = options.memoryScope ?? "session";
		this.scope = {
			kind,
			scopeId: requireIdentity(scopeId, "scopeId"),
			ownerId: requireIdentity(ownerId, "ownerId"),
			...(parentId === undefined ? {} : { parentId: requireIdentity(parentId, "parentId") }),
		};
		if (this.scope.parentId === this.scope.scopeId) throw new MemoryError("invalid_entry", "Memory scope cannot parent itself");
		this.enforcedScope = options.enforceMemoryScope === true ? kind : undefined;
		if (
			!identityMatches(options.memoryProvenance?.ownerId, this.scope.ownerId) ||
			!identityMatches(options.memoryProvenance?.scopeId, this.scope.scopeId) ||
			!identityMatches(options.memoryProvenance?.parentId, this.scope.parentId)
		) throw new MemoryError("policy_denied", "Memory provenance does not match its scope");
		this.provenanceBoundary = {
			...(options.memoryProvenance ?? {}),
			ownerId: options.memoryProvenance?.ownerId ?? this.scope.ownerId,
			scopeId: options.memoryProvenance?.scopeId ?? this.scope.scopeId,
			...(this.scope.parentId === undefined
				? {}
				: { parentId: options.memoryProvenance?.parentId ?? this.scope.parentId }),
		};
	}

	/** Create an independently addressable child scope on the same durable authority. */
	fork(options: MemoryChildScopeOptions = {}): SessionMemoryStore {
		if (options.parentId !== undefined && options.parentId !== this.scope.scopeId) {
			throw new MemoryError("policy_denied", "Memory child parent does not match the current scope");
		}
		const scopeId = requireIdentity(options.scopeId ?? `${this.scope.scopeId}/child`, "scopeId");
		const ownerId = requireIdentity(options.ownerId ?? `${this.scope.ownerId}/child`, "ownerId");
		const scope = options.scope ?? "child";
		if (scopeId === this.scope.scopeId) throw new MemoryError("invalid_entry", "Memory child scope must be independent");
		if (
			!identityMatches(options.provenance?.ownerId, ownerId) ||
			!identityMatches(options.provenance?.scopeId, scopeId) ||
			!identityMatches(options.provenance?.parentId, this.scope.scopeId)
		) throw new MemoryError("policy_denied", "Memory child provenance does not match its scope");
		return new SessionMemoryStore(this.session, this.artifacts, {
			writer: this.writer,
			policy: this.policy,
			now: this.now,
			memoryScope: scope,
			enforceMemoryScope: true,
			memoryScopeId: scopeId,
			memoryOwnerId: ownerId,
			memoryParentId: this.scope.scopeId,
			memoryProvenance: {
				...this.provenanceBoundary,
				...(options.provenance ?? {}),
				ownerId,
				scopeId,
				parentId: this.scope.scopeId,
				...(options.provenance?.createdBy === undefined ? {} : { createdBy: options.provenance.createdBy }),
			},
		});
	}

	async put(entry: NewMemoryEntry): Promise<MemoryEntry> {
		if (entry.content.length === 0 || entry.source.trim().length === 0 || !MEMORY_KINDS.includes(entry.kind) || !MEMORY_SCOPES.includes(entry.scope ?? "session")) throw new MemoryError("invalid_entry", "Invalid memory entry");
		const scope = entry.scope ?? this.enforcedScope ?? "session";
		if (this.enforcedScope !== undefined && scope !== this.enforcedScope) throw new MemoryError("policy_denied", "Memory entry crosses its scoped memory kind");
		if (!identityMatches(entry.scopeId, this.scope.scopeId) || !identityMatches(entry.ownerId, this.scope.ownerId) || !identityMatches(entry.parentId, this.scope.parentId)) {
			throw new MemoryError("policy_denied", "Memory entry crosses its owner or parent scope");
		}
		const candidate = { kind: entry.kind, trust: entry.trust, scope };
		if (!allowed(this.policy, candidate)) throw new MemoryError("policy_denied", "Memory policy rejected this entry");
		const redacted = redact(entry.content);
		const source = redact(entry.source).text;
		const sourceDigest = `sha256:${sha256HexValue(new TextEncoder().encode(source))}`;
		const requestedProvenance = entry.provenance ?? {};
		if (!provenanceMatchesBoundary({ ...requestedProvenance, sourceDigest }, this.provenanceBoundary)) throw new MemoryError("policy_denied", "Memory provenance is outside its authorized boundary");
		if (requestedProvenance.source !== undefined && requestedProvenance.source !== source && requestedProvenance.source !== sourceDigest) throw new MemoryError("policy_denied", "Memory provenance source does not match the entry source");
		if (requestedProvenance.sourceDigest !== undefined && requestedProvenance.sourceDigest !== sourceDigest) throw new MemoryError("policy_denied", "Memory provenance digest does not match the entry source");
		const createdBy = requestedProvenance.createdBy ?? this.provenanceBoundary.createdBy ?? "explicit";
		if (createdBy !== "explicit" && entry.principal !== "system") throw new MemoryError("policy_denied", "Only the system principal may assert imported or system provenance");
		const id = entry.id ?? newFoundationId("memory");
		const existingFact = await this.writer.readFact<FoundationJsonValue>(LEDGER_OBJECT_TYPES.memory, id);
		if (existingFact !== undefined) {
			const existing = existingFact.payload as unknown as MemoryRecord;
			const contentDigest = `sha256:${sha256HexValue(new TextEncoder().encode(redacted.text))}`;
			if (
				existing.contentDigest !== contentDigest ||
				existing.kind !== entry.kind ||
				existing.scope !== scope ||
				!identityMatches(existing.scopeId, this.scope.scopeId) ||
				!identityMatches(existing.ownerId, this.scope.ownerId) ||
				!identityMatches(existing.parentId, this.scope.parentId)
			) throw new MemoryError("invalid_entry", `Memory ${id} is immutable or belongs to another scope`);
			if (!provenanceMatchesBoundary(existing.provenance, requestedProvenance) || !provenanceMatchesBoundary(requestedProvenance, existing.provenance)) {
				throw new MemoryError("invalid_entry", `Memory ${id} provenance is immutable`);
			}
			const replayed = await this.get(id, entry.principal ?? "system");
			if (replayed === undefined) throw new MemoryError("storage", `Memory ${id} is unavailable for replay`);
			return replayed;
		}
		const existing = await this.list({ scope });
		if (this.policy?.maxEntries !== undefined && existing.length >= this.policy.maxEntries) throw new MemoryError("limit_reached", "Memory entry limit reached");
		const retentionValue = typeof this.policy?.retention === "string" ? { policy: this.policy.retention } : this.policy?.retention;
		const retention = normalizeRetention(entry.retention, retentionValue ?? defaultMemoryRetention(scope), scope);
		const contentRef = await this.artifacts.putStructuredResult(new TextEncoder().encode(redacted.text), {
			mediaType: "text/plain",
			principal: entry.principal ?? "system",
			permissions: [entry.principal ?? "system"],
			retention,
			producer: "t5-memory",
			clientRequestId: `memory-content:${id}`,
		});
		await this.artifacts.retainReference({
			artifactId: contentRef.artifactId,
			referenceId: `memory:${id}`,
			consumerType: LEDGER_OBJECT_TYPES.memory,
			consumerId: id,
			...(retentionExpiry(retention) === undefined ? {} : { expiresAt: retentionExpiry(retention) }),
		});
		const record: MemoryRecord = {
			schemaVersion: 1,
			id,
			kind: entry.kind,
			trust: entry.trust,
			source,
			scope,
			scopeId: this.scope.scopeId,
			ownerId: this.scope.ownerId,
			...(this.scope.parentId === undefined ? {} : { parentId: this.scope.parentId }),
			provenance: {
				...this.provenanceBoundary,
				source,
				sourceDigest,
				ownerId: this.scope.ownerId,
				scopeId: this.scope.scopeId,
				...(this.scope.parentId === undefined ? {} : { parentId: this.scope.parentId }),
				...(entry.provenance?.sourceId === undefined ? {} : { sourceId: entry.provenance.sourceId }),
				...(entry.provenance?.snapshotId === undefined ? {} : { snapshotId: entry.provenance.snapshotId }),
				...(entry.provenance?.runId === undefined ? {} : { runId: entry.provenance.runId }),
				createdBy: entry.provenance?.createdBy ?? this.provenanceBoundary.createdBy ?? "explicit",
			},
			retention,
			contentRef,
			contentDigest: `sha256:${sha256HexValue(new TextEncoder().encode(redacted.text))}`,
			contentBytes: new TextEncoder().encode(redacted.text).byteLength,
			redacted: redacted.changed,
			createdAt: this.now(),
		};
		const accepted = await this.writer.writeFact({
			objectType: LEDGER_OBJECT_TYPES.memory,
			objectId: id,
			clientRequestId: entry.clientRequestId ?? `memory:${id}`,
			payload: record as unknown as FoundationJsonValue,
		});
		const stored = accepted.payload as unknown as MemoryRecord;
		return { ...stored, content: redacted.text };
	}

	async get(id: string, principal = "system"): Promise<MemoryEntry | undefined> {
		const fact = await this.writer.readFact<FoundationJsonValue>(LEDGER_OBJECT_TYPES.memory, id);
		if (fact === undefined) return undefined;
		const record = fact.payload as unknown as MemoryRecord;
		const contentRef = record?.contentRef;
		if (
			record === null ||
			typeof record !== "object" ||
			typeof record.contentDigest !== "string" ||
			typeof record.provenance !== "object" ||
			contentRef === undefined ||
			contentRef.artifactId !== contentRef.id ||
			contentRef.digest !== record.contentDigest
		) {
			throw new MemoryError("storage", `Memory ${id} has an invalid content reference`);
		}
		if (!hasValidRecordSchema(record)) throw new MemoryError("storage", `Memory ${id} has an invalid scope or retention policy`);
		if (!hasValidRecordProvenance(record)) throw new MemoryError("storage", `Memory ${id} has invalid provenance`);
		if (
			!scopeMatchesBoundary(record, this.scope) ||
			(this.enforcedScope !== undefined && record.scope !== this.enforcedScope) ||
			!provenanceMatchesBoundary(record.provenance, this.provenanceBoundary)
		) return undefined;
		if (!allowed(this.policy, record) || retentionExpired(record.retention, this.now())) return undefined;
		try {
			const artifact = await this.artifacts.get(record.contentRef.artifactId, principal);
			const content = new TextDecoder().decode(artifact.content);
			if (`sha256:${sha256HexValue(new TextEncoder().encode(content))}` !== record.contentDigest) {
				throw new MemoryError("storage", `Memory ${id} content digest does not match its ledger record`);
			}
			return cloneEntry({ ...record, content });
		} catch (error) {
			if (error instanceof Error && "code" in error && (error as { code?: string }).code === "forbidden") return undefined;
			throw error;
		}
	}

	async list(query: MemoryQuery = {}, principal = "system"): Promise<MemoryEntry[]> {
		if (query.limit !== undefined && (!Number.isInteger(query.limit) || query.limit <= 0)) throw new MemoryError("invalid_query", "Memory limit must be a positive integer");
		const records = await this.writer.listFacts({ objectType: LEDGER_OBJECT_TYPES.memory });
		const result: MemoryEntry[] = [];
		for (const fact of records) {
			const record = fact.payload as unknown as MemoryRecord;
			if (!hasValidRecordSchema(record)) throw new MemoryError("storage", `Memory ${record.id} has an invalid scope or retention policy`);
			if (query.kind !== undefined && record.kind !== query.kind) continue;
			if (query.trust !== undefined && record.trust !== query.trust) continue;
			if (!scopeMatchesQuery(record, query) || !scopeMatchesBoundary(record, this.scope)) continue;
			if (this.enforcedScope !== undefined && record.scope !== this.enforcedScope) continue;
			if (!provenanceMatchesQuery(record.provenance, query.provenance)) continue;
			if (query.sourceId !== undefined && record.provenance.sourceId !== query.sourceId) continue;
			if (query.activeAt !== undefined && retentionExpired(record.retention, query.activeAt)) continue;
			if (!query.includeExpired && retentionExpired(record.retention, this.now())) continue;
			if (!allowed(this.policy, record)) continue;
			const entry = await this.get(record.id, principal);
			if (entry !== undefined) result.push(entry);
		}
		result.sort((left, right) => right.createdAt - left.createdAt || left.id.localeCompare(right.id));
		return query.limit === undefined ? result : result.slice(0, query.limit);
	}

	async delete(id: string, principal = "system"): Promise<boolean> {
		const entry = await this.get(id, principal);
		if (entry === undefined) return false;
		await this.writer.tombstone({ objectType: LEDGER_OBJECT_TYPES.memory, objectId: id, reason: "memory_deleted" });
		await this.artifacts.releaseReference(`memory:${id}`);
		return true;
	}

	async count(query: MemoryQuery = {}, principal = "system"): Promise<number> {
		return (await this.list(query, principal)).length;
	}

	async purgeExpired(now = this.now()): Promise<number> {
		const records = await this.writer.listFacts({ objectType: LEDGER_OBJECT_TYPES.memory });
		let removed = 0;
		for (const fact of records) {
			const record = fact.payload as unknown as MemoryRecord;
			if (!hasValidRecordSchema(record)) throw new MemoryError("storage", `Memory ${record.id} has an invalid scope or retention policy`);
			if (
				scopeMatchesBoundary(record, this.scope) &&
				(this.enforcedScope === undefined || record.scope === this.enforcedScope) &&
				retentionExpired(record.retention, now)
			) {
				await this.writer.tombstone({ objectType: LEDGER_OBJECT_TYPES.memory, objectId: record.id, reason: "memory_expired" });
				await this.artifacts.releaseReference(`memory:${record.id}`);
				removed += 1;
			}
		}
		return removed;
	}
}

export class ScopedMemoryStore implements MemoryStore {
	private readonly delegate: MemoryStore;
	private readonly scope: MemoryScopeKind;
	readonly scopeId: string;
	readonly ownerId: string;
	readonly parentId?: string;
	private readonly provenance: MemoryProvenanceBoundary;

	constructor(delegate: MemoryStore, scope: MemoryScopeKind, provenance: MemoryProvenanceBoundary = {}, boundary: MemoryStoreScopeOptions = {}) {
		this.scope = scope;
		const sessionDelegate = delegate instanceof SessionMemoryStore ? delegate : undefined;
		this.scopeId = boundary.scopeId ?? provenance.scopeId ?? `${scope}:${boundary.ownerId ?? provenance.ownerId ?? "default"}`;
		this.ownerId = boundary.ownerId ?? provenance.ownerId ?? (sessionDelegate === undefined ? this.scopeId : `${sessionDelegate.scope.ownerId}/${this.scopeId}`);
		this.parentId = boundary.parentId ?? provenance.parentId ?? (sessionDelegate === undefined || this.scopeId === sessionDelegate.scope.scopeId ? undefined : sessionDelegate.scope.scopeId);
		if (
			!identityMatches(boundary.provenance?.ownerId, this.ownerId) ||
			!identityMatches(boundary.provenance?.scopeId, this.scopeId) ||
			!identityMatches(boundary.provenance?.parentId, this.parentId)
		) throw new MemoryError("policy_denied", "Memory scoped provenance does not match its scope");
		if (sessionDelegate !== undefined && this.scopeId !== sessionDelegate.scope.scopeId && this.parentId !== sessionDelegate.scope.scopeId) {
			throw new MemoryError("policy_denied", "Memory child parent does not match the delegate scope");
		}
		this.provenance = {
			...provenance,
			...(boundary.provenance ?? {}),
			ownerId: this.ownerId,
			scopeId: this.scopeId,
			...(this.parentId === undefined ? {} : { parentId: this.parentId }),
		};
		this.delegate = sessionDelegate !== undefined && this.scopeId !== sessionDelegate.scope.scopeId
			? sessionDelegate.fork({
					scope,
					scopeId: this.scopeId,
					ownerId: this.ownerId,
					parentId: this.parentId,
					provenance: this.provenance,
				})
			: delegate;
	}
	put(entry: NewMemoryEntry): Promise<MemoryEntry> {
		if (!identityMatches(entry.scopeId, this.scopeId) || !identityMatches(entry.ownerId, this.ownerId) || !identityMatches(entry.parentId, this.parentId)) {
			return Promise.reject(new MemoryError("policy_denied", "Memory entry crosses its scoped owner or parent"));
		}
		if (!provenanceMatchesBoundary(entry.provenance ?? {}, this.provenance)) return Promise.reject(new MemoryError("policy_denied", "Memory provenance is outside its scoped boundary"));
		return this.delegate.put({
			...entry,
			scope: this.scope,
			scopeId: this.scopeId,
			ownerId: this.ownerId,
			...(this.parentId === undefined ? {} : { parentId: this.parentId }),
			provenance: { ...this.provenance, ...(entry.provenance ?? {}) },
		});
	}
	get(id: string, principal?: string): Promise<MemoryEntry | undefined> {
		return this.delegate.get(id, principal).then((entry) => (entry?.scope === this.scope && entry.scopeId === this.scopeId && entry.ownerId === this.ownerId && entry.parentId === this.parentId ? entry : undefined));
	}
	list(query: MemoryQuery = {}, principal?: string): Promise<MemoryEntry[]> {
		return this.delegate.list({ ...query, scope: this.scope, scopeId: this.scopeId, ownerId: this.ownerId, ...(this.parentId === undefined ? {} : { parentId: this.parentId }) }, principal)
			.then((entries) => entries.filter((entry) => entry.scope === this.scope && entry.scopeId === this.scopeId && entry.ownerId === this.ownerId && entry.parentId === this.parentId));
	}
	delete(id: string, principal?: string): Promise<boolean> {
		return this.get(id, principal).then((entry) => (entry === undefined ? false : this.delegate.delete(id, principal)));
	}
	count(query: MemoryQuery = {}, principal?: string): Promise<number> {
		return this.list(query, principal).then((entries) => entries.length);
	}
	async purgeExpired(now = Date.now()): Promise<number> {
		if (this.delegate instanceof SessionMemoryStore) return this.delegate.purgeExpired(now);
		const entries = await this.delegate.list({
			scope: this.scope,
			scopeId: this.scopeId,
			ownerId: this.ownerId,
			...(this.parentId === undefined ? {} : { parentId: this.parentId }),
			includeExpired: true,
		});
		let removed = 0;
		for (const entry of entries) {
			if (retentionExpired(entry.retention, now) && await this.delegate.delete(entry.id, "system")) removed += 1;
		}
		return removed;
	}

	/** Create a child scope that cannot read or write the parent scope implicitly. */
	fork(options: MemoryChildScopeOptions = {}): ScopedMemoryStore {
		const scopeId = options.scopeId ?? `${this.scopeId}/child`;
		const ownerId = options.ownerId ?? `${this.ownerId}/child`;
		return new ScopedMemoryStore(this.delegate, options.scope ?? "child", {
			...this.provenance,
			...(options.provenance ?? {}),
			ownerId,
			parentId: this.scopeId,
			scopeId,
		}, { scopeId, ownerId, parentId: this.scopeId });
	}
}

export function createScopedMemoryStore(
	store: MemoryStore,
	scope: MemoryScopeKind,
	provenance: MemoryProvenanceBoundary = {},
	boundary: MemoryStoreScopeOptions = {},
): ScopedMemoryStore {
	return new ScopedMemoryStore(store, scope, provenance, boundary);
}

export interface WorkingMemoryOptions {
	readonly maxTokens: number;
	readonly scope?: MemoryScopeKind;
	readonly trust?: readonly MemoryTrust[];
}
export interface WorkingMemory {
	readonly messages: Array<{ readonly role: "user"; readonly content: Array<{ readonly type: "text"; readonly text: string }>; readonly timestamp: number }>;
	readonly entries: readonly MemoryEntry[];
	readonly excluded: readonly MemoryEntry[];
	readonly tokens: number;
	readonly references: readonly MemoryReference[];
}

/** Build a bounded transient projection; only references belong in snapshots. */
export async function buildWorkingMemory(store: MemoryStore, options: WorkingMemoryOptions): Promise<WorkingMemory> {
	if (!Number.isFinite(options.maxTokens) || options.maxTokens < 0) throw new MemoryError("invalid_query", "maxTokens must be non-negative");
	const listed = await store.list(options.scope === undefined ? {} : { scope: options.scope });
	const candidates = listed.filter((entry) => options.trust === undefined || options.trust.includes(entry.trust));
	const excluded = listed.filter((entry) => !candidates.includes(entry));
	let tokens = 0;
	const entries: MemoryEntry[] = [];
	const messages: Array<{ readonly role: "user"; readonly content: Array<{ readonly type: "text"; readonly text: string }>; readonly timestamp: number }> = [];
	const references: MemoryReference[] = [];
	for (const entry of candidates) {
		const text = `[memory id=${entry.id} scope=${entry.scope} kind=${entry.kind} trust=${entry.trust}]\n${entry.content}`;
		const cost = Math.ceil(text.length / 4);
		if (tokens + cost > options.maxTokens) {
			excluded.push(entry);
			continue;
		}
		tokens += cost;
		entries.push(entry);
		messages.push({ role: "user", content: [{ type: "text", text }], timestamp: 0 });
		references.push({
			type: "memory",
			id: entry.id,
			digest: entry.contentDigest,
			scope: entry.scope,
			scopeId: entry.scopeId,
			ownerId: entry.ownerId,
			...(entry.parentId === undefined ? {} : { parentId: entry.parentId }),
			kind: entry.kind,
			trust: entry.trust,
			redacted: true,
		});
	}
	return { messages, entries, excluded, tokens, references };
}
