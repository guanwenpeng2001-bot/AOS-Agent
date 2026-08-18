import { newFoundationId, sha256HexValue, type FoundationJsonValue } from "../foundation/index.ts";
import type { ArtifactReference, SessionArtifactStore } from "../artifacts.ts";
import type { Session } from "../session/session.ts";
import { SessionLedgerBindingError, type SessionLedgerWriter, T5_LEDGER_OBJECT_TYPES, assertSessionLedgerWriterSession, type SessionLedgerWriterOptions } from "../session/t5.ts";

export type MemoryScope = "session" | "project" | "task" | "agent";
export const MEMORY_SCOPES: readonly MemoryScope[] = ["session", "project", "task", "agent"];
export type MemoryKind = "fact" | "note" | "decision" | "requirement" | "error";
export const MEMORY_KINDS: readonly MemoryKind[] = ["fact", "note", "decision", "requirement", "error"];
export type MemoryTrust = "builtin" | "user_owned" | "trusted_project" | "untrusted_project" | "user" | "tool" | "model" | "external" | "untrusted";

export interface MemoryRetentionPolicy {
	readonly policy: "session" | "task" | "project" | "indefinite";
	readonly expiresAt?: number;
}
export const DEFAULT_MEMORY_RETENTION: MemoryRetentionPolicy = { policy: "session" };

export interface MemoryProvenance {
	readonly source: string;
	readonly sourceDigest?: string;
	readonly sourceId?: string;
	readonly snapshotId?: string;
	readonly taskId?: string;
	readonly runId?: string;
	readonly createdBy?: "explicit" | "import" | "system";
}

export interface MemoryPolicy {
	readonly allowedTrust?: readonly MemoryTrust[];
	readonly allowedScopes?: readonly MemoryScope[];
	readonly kinds?: readonly MemoryKind[];
	readonly maxEntries?: number;
	readonly maxTokens?: number;
	readonly retention?: MemoryRetentionPolicy | MemoryRetentionPolicy["policy"];
}

/** Durable memory record. Content is only an artifact reference. */
export interface MemoryRecordV1 {
	readonly schemaVersion: 1;
	readonly id: string;
	readonly kind: MemoryKind;
	readonly trust: MemoryTrust;
	readonly source: string;
	readonly scope: MemoryScope;
	readonly provenance: MemoryProvenance;
	readonly retention: MemoryRetentionPolicy;
	readonly contentRef: ArtifactReference;
	readonly contentDigest: string;
	readonly contentBytes: number;
	readonly redacted: boolean;
	readonly createdAt: number;
}

/** Hydrated projection; this body is never included in the ledger fact. */
export interface MemoryEntry extends MemoryRecordV1 {
	readonly content: string;
}

export type NewMemoryEntry = {
	readonly id?: string;
	readonly kind: MemoryKind;
	readonly trust: MemoryTrust;
	readonly content: string;
	readonly source: string;
	readonly scope?: MemoryScope;
	readonly provenance?: Partial<MemoryProvenance>;
	readonly retention?: MemoryRetentionPolicy | MemoryRetentionPolicy["policy"];
	readonly principal?: string;
	readonly clientRequestId?: string;
};

export interface MemoryQuery {
	readonly kind?: MemoryKind;
	readonly trust?: MemoryTrust;
	readonly scope?: MemoryScope;
	readonly sourceId?: string;
	readonly activeAt?: number;
	readonly limit?: number;
}

export interface MemoryReference {
	readonly type: "memory";
	readonly id: string;
	readonly digest: string;
	readonly scope: MemoryScope;
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

function normalizeRetention(value: NewMemoryEntry["retention"], fallback: MemoryRetentionPolicy): MemoryRetentionPolicy {
	const retention = typeof value === "string" ? { policy: value } : value ?? fallback;
	if (!("session|task|project|indefinite" as const).split("|").includes(retention.policy)) throw new MemoryError("invalid_entry", "Invalid memory retention policy");
	if (retention.expiresAt !== undefined && (!Number.isFinite(retention.expiresAt) || retention.expiresAt < 0)) throw new MemoryError("invalid_entry", "Invalid memory expiry");
	return { policy: retention.policy, ...(retention.expiresAt === undefined ? {} : { expiresAt: retention.expiresAt }) };
}

function allowed(policy: MemoryPolicy | undefined, value: Pick<MemoryRecordV1, "kind" | "trust" | "scope">): boolean {
	if (policy?.allowedTrust !== undefined && !policy.allowedTrust.includes(value.trust)) return false;
	if (policy?.allowedScopes !== undefined && !policy.allowedScopes.includes(value.scope)) return false;
	if (policy?.kinds !== undefined && !policy.kinds.includes(value.kind)) return false;
	return true;
}

function cloneEntry(entry: MemoryEntry): MemoryEntry {
	return structuredClone(entry);
}

/** A durable memory view. It never keeps a second in-memory authority. */
export class SessionMemoryStore implements MemoryStore {
	readonly session: Session;
	readonly writer: SessionLedgerWriter;
	readonly artifacts: SessionArtifactStore;
	private readonly policy?: MemoryPolicy;
	private readonly now: () => number;

	constructor(session: Session, artifacts: SessionArtifactStore, options: SessionLedgerWriterOptions & { readonly policy?: MemoryPolicy; readonly now?: () => number; readonly writer?: SessionLedgerWriter } = {}) {
		this.session = session;
		this.writer = options.writer ?? artifacts.writer;
		assertSessionLedgerWriterSession(session, this.writer, "MemoryStore");
		if (artifacts.session !== session) throw new SessionLedgerBindingError("MemoryStore and ArtifactStore must use the same Session");
		if (artifacts.writer !== this.writer) throw new SessionLedgerBindingError("MemoryStore and ArtifactStore must share one SessionLedgerWriter");
		this.artifacts = artifacts;
		this.policy = options.policy;
		this.now = options.now ?? Date.now;
	}

	async put(entry: NewMemoryEntry): Promise<MemoryEntry> {
		if (entry.content.length === 0 || !MEMORY_KINDS.includes(entry.kind) || !MEMORY_SCOPES.includes(entry.scope ?? "session")) throw new MemoryError("invalid_entry", "Invalid memory entry");
		const scope = entry.scope ?? "session";
		const candidate = { kind: entry.kind, trust: entry.trust, scope };
		if (!allowed(this.policy, candidate)) throw new MemoryError("policy_denied", "Memory policy rejected this entry");
		const redacted = redact(entry.content);
		const source = redact(entry.source).text;
		const sourceDigest = `sha256:${sha256HexValue(new TextEncoder().encode(source))}`;
		const id = entry.id ?? newFoundationId("memory");
		const existingFact = await this.writer.readFact<FoundationJsonValue>(T5_LEDGER_OBJECT_TYPES.memory, id);
		if (existingFact !== undefined) {
			const existing = existingFact.payload as unknown as MemoryRecordV1;
			const contentDigest = `sha256:${sha256HexValue(new TextEncoder().encode(redacted.text))}`;
			if (existing.contentDigest !== contentDigest || existing.kind !== entry.kind || existing.scope !== scope) throw new MemoryError("invalid_entry", `Memory ${id} is immutable`);
			const replayed = await this.get(id, entry.principal ?? "system");
			if (replayed === undefined) throw new MemoryError("storage", `Memory ${id} is unavailable for replay`);
			return replayed;
		}
		const existing = await this.list({ scope });
		if (this.policy?.maxEntries !== undefined && existing.length >= this.policy.maxEntries) throw new MemoryError("limit_reached", "Memory entry limit reached");
		const retentionValue = typeof this.policy?.retention === "string" ? { policy: this.policy.retention } : this.policy?.retention;
		const retention = normalizeRetention(entry.retention, retentionValue ?? DEFAULT_MEMORY_RETENTION);
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
			consumerType: T5_LEDGER_OBJECT_TYPES.memory,
			consumerId: id,
			...(retention.expiresAt === undefined ? {} : { expiresAt: retention.expiresAt }),
		});
		const record: MemoryRecordV1 = {
			schemaVersion: 1,
			id,
			kind: entry.kind,
			trust: entry.trust,
			source: sourceDigest,
			scope,
			provenance: {
				source: sourceDigest,
				sourceDigest,
				...(entry.provenance?.sourceId === undefined ? {} : { sourceId: entry.provenance.sourceId }),
				...(entry.provenance?.snapshotId === undefined ? {} : { snapshotId: entry.provenance.snapshotId }),
				...(entry.provenance?.taskId === undefined ? {} : { taskId: entry.provenance.taskId }),
				...(entry.provenance?.runId === undefined ? {} : { runId: entry.provenance.runId }),
				createdBy: entry.provenance?.createdBy ?? "explicit",
			},
			retention,
			contentRef,
			contentDigest: `sha256:${sha256HexValue(new TextEncoder().encode(redacted.text))}`,
			contentBytes: new TextEncoder().encode(redacted.text).byteLength,
			redacted: redacted.changed,
			createdAt: this.now(),
		};
		const accepted = await this.writer.writeFact({
			objectType: T5_LEDGER_OBJECT_TYPES.memory,
			objectId: id,
			clientRequestId: entry.clientRequestId ?? `memory:${id}`,
			payload: record as unknown as FoundationJsonValue,
		});
		const stored = accepted.payload as unknown as MemoryRecordV1;
		return { ...stored, content: redacted.text };
	}

	async get(id: string, principal = "system"): Promise<MemoryEntry | undefined> {
		const fact = await this.writer.readFact<FoundationJsonValue>(T5_LEDGER_OBJECT_TYPES.memory, id);
		if (fact === undefined) return undefined;
		const record = fact.payload as unknown as MemoryRecordV1;
		const contentRef = record?.contentRef;
		if (
			record === null ||
			typeof record !== "object" ||
			typeof record.contentDigest !== "string" ||
			contentRef === undefined ||
			contentRef.artifactId !== contentRef.id ||
			contentRef.digest !== record.contentDigest
		) {
			throw new MemoryError("storage", `Memory ${id} has an invalid content reference`);
		}
		if (!allowed(this.policy, record) || (record.retention.expiresAt !== undefined && record.retention.expiresAt <= this.now())) return undefined;
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
		const records = await this.writer.listFacts({ objectType: T5_LEDGER_OBJECT_TYPES.memory });
		const result: MemoryEntry[] = [];
		for (const fact of records) {
			const record = fact.payload as unknown as MemoryRecordV1;
			if (query.kind !== undefined && record.kind !== query.kind) continue;
			if (query.trust !== undefined && record.trust !== query.trust) continue;
			if (query.scope !== undefined && record.scope !== query.scope) continue;
			if (query.sourceId !== undefined && record.provenance.sourceId !== query.sourceId) continue;
			if (query.activeAt !== undefined && record.retention.expiresAt !== undefined && record.retention.expiresAt <= query.activeAt) continue;
			if (record.retention.expiresAt !== undefined && record.retention.expiresAt <= this.now()) continue;
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
		await this.writer.tombstone({ objectType: T5_LEDGER_OBJECT_TYPES.memory, objectId: id, reason: "memory_deleted" });
		await this.artifacts.releaseReference(`memory:${id}`);
		return true;
	}

	async count(query: MemoryQuery = {}, principal = "system"): Promise<number> {
		return (await this.list(query, principal)).length;
	}

	async purgeExpired(now = this.now()): Promise<number> {
		const records = await this.writer.listFacts({ objectType: T5_LEDGER_OBJECT_TYPES.memory });
		let removed = 0;
		for (const fact of records) {
			const record = fact.payload as unknown as MemoryRecordV1;
			if (record.retention.expiresAt !== undefined && record.retention.expiresAt <= now) {
				await this.writer.tombstone({ objectType: T5_LEDGER_OBJECT_TYPES.memory, objectId: record.id, reason: "memory_expired" });
				await this.artifacts.releaseReference(`memory:${record.id}`);
				removed += 1;
			}
		}
		return removed;
	}
}

export class ScopedMemoryStore implements MemoryStore {
	private readonly delegate: MemoryStore;
	private readonly scope: MemoryScope;
	constructor(delegate: MemoryStore, scope: MemoryScope) {
		this.delegate = delegate;
		this.scope = scope;
	}
	put(entry: NewMemoryEntry): Promise<MemoryEntry> {
		return this.delegate.put({ ...entry, scope: this.scope });
	}
	get(id: string, principal?: string): Promise<MemoryEntry | undefined> {
		return this.delegate.get(id, principal).then((entry) => (entry?.scope === this.scope ? entry : undefined));
	}
	list(query: MemoryQuery = {}, principal?: string): Promise<MemoryEntry[]> {
		return this.delegate.list({ ...query, scope: this.scope }, principal);
	}
	delete(id: string, principal?: string): Promise<boolean> {
		return this.get(id, principal).then((entry) => (entry === undefined ? false : this.delegate.delete(id, principal)));
	}
	count(query: MemoryQuery = {}, principal?: string): Promise<number> {
		return this.delegate.count({ ...query, scope: this.scope }, principal);
	}
	purgeExpired(now?: number): Promise<number> {
		return this.delegate.purgeExpired(now);
	}
}

export interface WorkingMemoryOptions {
	readonly maxTokens: number;
	readonly scope?: MemoryScope;
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
		references.push({ type: "memory", id: entry.id, digest: entry.contentDigest, scope: entry.scope, kind: entry.kind, trust: entry.trust, redacted: true });
	}
	return { messages, entries, excluded, tokens, references };
}
