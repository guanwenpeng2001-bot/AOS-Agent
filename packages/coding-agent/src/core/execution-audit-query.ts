/**
 * Cross-session, read-only execution audit query and replay.
 *
 * This module is deliberately a thin layer over ExecutionAuditAdapter. It
 * discovers only the configured SessionManager directory, folds each allowed
 * Session, and merges the resulting safe events. It never opens a SessionManager
 * for a discovered file, because opening can migrate and rewrite old sessions.
 */

import {
	lstatSync,
	readdirSync,
	realpathSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import {
	isExternalAdapterIdentity,
	sameExternalAdapterIdentity,
	type ExternalAdapterIdentity,
} from "./external-session-mapping.ts";
import {
	AUDIT_CURSOR_SORT_KEYS,
	AUDIT_DEFAULT_LIMIT,
	AUDIT_EVENT_TYPES,
	AUDIT_MAX_LIMIT,
	AUDIT_QUERY_SCOPES,
	AUDIT_SCHEMA_VERSION,
	decodeAuditCursor,
	encodeAuditCursor,
	ExecutionAuditAdapter,
	ExecutionAuditError,
	createAuditQueryFingerprint,
	type AuditCursorSecret,
	type AuditEvent,
	type AuditEventType,
	type AuditFoldResult,
	type AuditQuery,
	type AuditQueryResult,
	type AuditReplayQuery as BaseAuditReplayQuery,
	type AuditReplayResult,
	type AuditReplayStatus,
	type AuditSession,
	type AuditSortKey,
	type AuditWarning,
	type AuditQueryScope,
	type ExternalExecutionRef,
} from "./execution-audit.ts";
import { loadEntriesFromFile, type FileEntry, type SessionEntry } from "./session-manager.ts";

/** Maximum number of `.jsonl` candidates inspected in one directory query. */
export const AUDIT_MAX_SESSION_CANDIDATES = 256;
/** Maximum number of readable Sessions folded in one directory query. */
export const AUDIT_MAX_SESSIONS = 128;

/** Compatibility aliases for callers that name the limits by their role. */
export const AUDIT_MAX_CANDIDATES = AUDIT_MAX_SESSION_CANDIDATES;
export const AUDIT_MAX_SESSION_COUNT = AUDIT_MAX_SESSIONS;

export type {
	AuditCursorSecret,
	AuditEvent,
	AuditEventType,
	AuditQuery,
	AuditQueryResult,
	AuditReplayResult,
	AuditSortKey,
	AuditWarning,
	ExternalAdapterIdentity,
	ExternalExecutionRef,
} from "./execution-audit.ts";

export interface ExecutionAuditQueryOptions {
	readonly cursorSecret?: AuditCursorSecret;
	readonly maxSessionCandidates?: number;
	readonly maxSessions?: number;
	/** Alias for maxSessionCandidates. */
	readonly maxCandidates?: number;
	/** Alias for maxSessionCandidates. */
	readonly maxSessionFiles?: number;
	/** Alias for maxSessions. */
	readonly maxSessionCount?: number;
}

/** A SessionManager-like source. The directory is resolved from the server source. */
export type AuditQuerySession = AuditSession & { readonly getSessionDir?: () => string };

/** Replay accepts the T1 replay filters plus the cross-session scope. */
export interface AuditReplayQuery extends BaseAuditReplayQuery {
	readonly scope?: AuditQueryScope;
}

export type AuditReplayRequest = AuditReplayQuery;

interface NormalizedLimits {
	readonly maxSessionCandidates: number;
	readonly maxSessions: number;
}

interface FoldedSession {
	readonly sessionId: string;
	readonly adapter: ExecutionAuditAdapter;
	readonly fold: AuditFoldResult;
}

interface ReadSnapshot {
	readonly sessions: ReadonlyArray<FoldedSession>;
	readonly events: ReadonlyArray<AuditEvent>;
	readonly warnings: ReadonlyArray<AuditWarning>;
	readonly unavailable: boolean;
}

const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const AUDIT_QUERY_KEYS = new Set(["scope", "sessionId", "runId", "external", "types", "from", "to", "cursor", "limit", "adapter"]);
const EXTERNAL_REF_KEYS = new Set(["namespace", "externalSessionId", "externalRunId"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSafeIdentifier(value: unknown): value is string {
	return (
		typeof value === "string" &&
		SAFE_IDENTIFIER_PATTERN.test(value) &&
		!value.includes("/") &&
		!value.includes("\\") &&
		!value.includes("?") &&
		!value.includes("#") &&
		!value.includes("@") &&
		!value.includes("://")
	);
}

function isCanonicalTimestamp(value: unknown): value is string {
	if (typeof value !== "string" || !TIMESTAMP_PATTERN.test(value)) return false;
	const timestamp = new Date(value);
	return Number.isFinite(timestamp.getTime()) && timestamp.toISOString() === value;
}

function isAuditEventType(value: unknown): value is AuditEventType {
	return typeof value === "string" && (AUDIT_EVENT_TYPES as readonly string[]).includes(value);
}

function isExternalRef(value: unknown): value is ExternalExecutionRef {
	if (!isRecord(value) || Object.keys(value).some((key) => !EXTERNAL_REF_KEYS.has(key)) || !isSafeIdentifier(value.namespace) || !isSafeIdentifier(value.externalSessionId)) return false;
	return value.externalRunId === undefined || isSafeIdentifier(value.externalRunId);
}

function canonicalExternal(value: ExternalExecutionRef): ExternalExecutionRef {
	return {
		namespace: value.namespace,
		externalSessionId: value.externalSessionId,
		...(value.externalRunId === undefined ? {} : { externalRunId: value.externalRunId }),
	};
}

function canonicalAdapter(value: ExternalAdapterIdentity): ExternalAdapterIdentity {
	return {
		adapterId: value.adapterId,
		targetId: value.targetId,
		protocol: { name: value.protocol.name, version: value.protocol.version },
	};
}

function canonicalTypes(value: ReadonlyArray<AuditEventType> | undefined): ReadonlyArray<AuditEventType> | undefined {
	if (value === undefined) return undefined;
	return [...new Set(value)].sort((left, right) => left.localeCompare(right));
}

function normalizeLimit(value: unknown): number {
	if (value === undefined) return AUDIT_DEFAULT_LIMIT;
	if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > AUDIT_MAX_LIMIT) {
		throw new ExecutionAuditError("audit_query_invalid");
	}
	return value as number;
}

function normalizePositiveLimit(value: unknown, fallback: number): number {
	if (value === undefined) return fallback;
	if (!Number.isInteger(value) || (value as number) < 1) throw new ExecutionAuditError("audit_query_invalid");
	return value as number;
}

function normalizeQuery(input: unknown, currentSessionId: string): AuditQuery {
	if (!isRecord(input) || !AUDIT_QUERY_SCOPES.includes(input.scope as AuditQueryScope)) {
		throw new ExecutionAuditError("audit_query_invalid");
	}
	if (Object.keys(input).some((key) => !AUDIT_QUERY_KEYS.has(key))) throw new ExecutionAuditError("audit_query_invalid");
	const scope = input.scope as AuditQueryScope;
	if (input.sessionId !== undefined && !isSafeIdentifier(input.sessionId)) {
		throw new ExecutionAuditError("audit_query_invalid");
	}
	if (scope === "current-session" && input.sessionId !== undefined && input.sessionId !== currentSessionId) {
		throw new ExecutionAuditError("audit_query_invalid");
	}
	if (input.runId !== undefined && !isSafeIdentifier(input.runId)) throw new ExecutionAuditError("audit_query_invalid");
	if (input.external !== undefined && !isExternalRef(input.external)) throw new ExecutionAuditError("audit_query_invalid");
	if (input.adapter !== undefined && !isExternalAdapterIdentity(input.adapter))
		throw new ExecutionAuditError("audit_query_invalid");
	if (input.types !== undefined && (!Array.isArray(input.types) || input.types.some((type) => !isAuditEventType(type)))) {
		throw new ExecutionAuditError("audit_query_invalid");
	}
	if (input.from !== undefined && !isCanonicalTimestamp(input.from)) throw new ExecutionAuditError("audit_query_invalid");
	if (input.to !== undefined && !isCanonicalTimestamp(input.to)) throw new ExecutionAuditError("audit_query_invalid");
	if (input.from !== undefined && input.to !== undefined && input.from > input.to) {
		throw new ExecutionAuditError("audit_query_invalid");
	}
	if (input.cursor !== undefined && typeof input.cursor !== "string") {
		throw new ExecutionAuditError("audit_cursor_invalid");
	}
	const types = canonicalTypes(input.types as ReadonlyArray<AuditEventType> | undefined);
	return {
		scope,
		limit: normalizeLimit(input.limit),
		...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
		...(input.runId === undefined ? {} : { runId: input.runId }),
		...(input.external === undefined ? {} : { external: canonicalExternal(input.external) }),
		...(input.adapter === undefined ? {} : { adapter: canonicalAdapter(input.adapter) }),
		...(types === undefined ? {} : { types }),
		...(input.from === undefined ? {} : { from: input.from }),
		...(input.to === undefined ? {} : { to: input.to }),
		...(input.cursor === undefined ? {} : { cursor: input.cursor }),
	};
}

function normalizeReplay(input: unknown, options: unknown, currentSessionId: string): AuditQuery {
	const request = typeof input === "string" ? { ...(isRecord(options) ? options : {}), runId: input } : input;
	if (!isRecord(request) || !isSafeIdentifier(request.runId)) throw new ExecutionAuditError("audit_query_invalid");
	const scope = request.scope === undefined ? "current-session" : request.scope;
	if (!AUDIT_QUERY_SCOPES.includes(scope as AuditQueryScope)) throw new ExecutionAuditError("audit_query_invalid");
	return normalizeQuery({ ...request, scope }, currentSessionId);
}

function sortKey(event: AuditEvent): AuditSortKey {
	return {
		recordedAt: event.recordedAt,
		sessionId: event.sessionId,
		sourceEntryId: event.sourceEntryId,
		eventId: event.eventId,
	};
}

function compareSortKeys(left: AuditSortKey, right: AuditSortKey): number {
	for (const key of AUDIT_CURSOR_SORT_KEYS) {
		if (left[key] < right[key]) return -1;
		if (left[key] > right[key]) return 1;
	}
	return 0;
}

function compareEvents(left: AuditEvent, right: AuditEvent): number {
	return compareSortKeys(sortKey(left), sortKey(right));
}

function eventIdentity(event: AuditEvent): string {
	return `${event.sessionId}\u0000${event.sourceEntryId}\u0000${event.eventId}`;
}

function warningIdentity(value: AuditWarning): string {
	return [value.code, value.sessionId ?? "", value.sourceEntryId ?? "", value.eventType ?? "", value.schemaVersion ?? ""].join("\u0000");
}

function warningSortKey(value: AuditWarning): string {
	return [value.sessionId ?? "", value.sourceEntryId ?? "", value.eventType ?? "", value.code, value.schemaVersion ?? ""].join("\u0000");
}

function mergeWarnings(warnings: ReadonlyArray<AuditWarning>): AuditWarning[] {
	const unique = new Map<string, AuditWarning>();
	for (const item of warnings) unique.set(warningIdentity(item), item);
	return [...unique.values()].sort((left, right) => {
		const leftKey = warningSortKey(left);
		const rightKey = warningSortKey(right);
		return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
	});
}

function mergeEvents(events: ReadonlyArray<AuditEvent>): AuditEvent[] {
	const unique = new Map<string, AuditEvent>();
	for (const event of events) {
		const key = eventIdentity(event);
		const existing = unique.get(key);
		if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(event)) {
			throw new ExecutionAuditError("audit_replay_incomplete");
		}
		unique.set(key, event);
	}
	return [...unique.values()].sort(compareEvents);
}

function matchesExternal(event: AuditEvent, external: ExternalExecutionRef): boolean {
	return (
		event.external !== undefined &&
		event.external.namespace === external.namespace &&
		event.external.externalSessionId === external.externalSessionId &&
		(event.external.externalRunId ?? undefined) === (external.externalRunId ?? undefined)
	);
}

function matchesAdapter(event: AuditEvent, adapter: ExternalAdapterIdentity): boolean {
	return event.adapter !== undefined && sameExternalAdapterIdentity(event.adapter, adapter);
}

function filterEvents(events: ReadonlyArray<AuditEvent>, query: AuditQuery): AuditEvent[] {
	return events.filter((event) => {
		if (query.sessionId !== undefined && event.sessionId !== query.sessionId) return false;
		if (query.runId !== undefined && event.runId !== query.runId) return false;
		if (query.external !== undefined && !matchesExternal(event, query.external)) return false;
		if (query.adapter !== undefined && !matchesAdapter(event, query.adapter)) return false;
		if (query.types !== undefined && !query.types.includes(event.type)) return false;
		if (query.from !== undefined && event.recordedAt < query.from) return false;
		if (query.to !== undefined && event.recordedAt >= query.to) return false;
		return true;
	});
}

function paginate(
	events: ReadonlyArray<AuditEvent>,
	query: AuditQuery,
	secret: AuditCursorSecret | undefined,
): { readonly events: ReadonlyArray<AuditEvent>; readonly nextCursor?: string } {
	let filtered = [...events].sort(compareEvents);
	const fingerprint = createAuditQueryFingerprint(query);
	if (query.cursor !== undefined) {
		const cursor = decodeAuditCursor(query.cursor, secret);
		if (cursor === undefined || cursor.queryFingerprint !== fingerprint) throw new ExecutionAuditError("audit_cursor_invalid");
		filtered = filtered.filter((event) => compareSortKeys(sortKey(event), cursor.last) > 0);
	}
	const limit = query.limit ?? AUDIT_DEFAULT_LIMIT;
	const page = filtered.slice(0, limit);
	if (filtered.length <= limit || page.length === 0) return { events: page };
	return {
		events: page,
		nextCursor: encodeAuditCursor({ queryFingerprint: fingerprint, last: sortKey(page[page.length - 1]!) }, secret),
	};
}

function unavailableWarning(sessionId?: string): AuditWarning {
	return { code: "source_unavailable", ...(sessionId !== undefined && isSafeIdentifier(sessionId) ? { sessionId } : {}) };
}

function isPathWithinRoot(root: string, target: string): boolean {
	const pathRelation = relative(root, target);
	return pathRelation === "" || (!isAbsolute(pathRelation) && pathRelation !== ".." && !pathRelation.startsWith(`..${sep}`));
}

function resolveDirectoryRoot(source: AuditQuerySession): string {
	if (source.getSessionDir === undefined) throw new ExecutionAuditError("audit_scope_unavailable");
	let configuredRoot: unknown;
	try {
		configuredRoot = source.getSessionDir();
	} catch {
		throw new ExecutionAuditError("audit_scope_unavailable");
	}
	if (typeof configuredRoot !== "string" || configuredRoot.length === 0) throw new ExecutionAuditError("audit_scope_unavailable");
	const root = resolve(configuredRoot);
	try {
		const realRoot = realpathSync(root);
		if (!lstatSync(realRoot).isDirectory()) throw new ExecutionAuditError("audit_scope_unavailable");
		return realRoot;
	} catch (error) {
		if (error instanceof ExecutionAuditError) throw error;
		throw new ExecutionAuditError("audit_scope_unavailable");
	}
}

function resolveLimits(options: ExecutionAuditQueryOptions): NormalizedLimits {
	const maxSessionCandidates = normalizePositiveLimit(
		options.maxSessionCandidates ?? options.maxCandidates ?? options.maxSessionFiles,
		AUDIT_MAX_SESSION_CANDIDATES,
	);
	const maxSessions = normalizePositiveLimit(options.maxSessions ?? options.maxSessionCount, AUDIT_MAX_SESSIONS);
	return { maxSessionCandidates, maxSessions };
}

function entriesWithoutHeader(entries: ReadonlyArray<FileEntry>): ReadonlyArray<SessionEntry> {
	return entries.filter((entry): entry is SessionEntry => entry.type !== "session");
}

/** Read-only cross-session query and replay service. */
export class ExecutionAuditQuery {
	private readonly source: AuditQuerySession;
	private readonly secret: AuditCursorSecret | undefined;
	private readonly limits: NormalizedLimits;

	constructor(source: AuditQuerySession, options: ExecutionAuditQueryOptions = {}) {
		this.source = source;
		this.secret = options.cursorSecret;
		this.limits = resolveLimits(options);
	}

	private currentSessionId(): string {
		try {
			const sessionId = this.source.getSessionId();
			if (!isSafeIdentifier(sessionId)) throw new ExecutionAuditError("audit_scope_unavailable");
			return sessionId;
		} catch (error) {
			if (error instanceof ExecutionAuditError) throw error;
			throw new ExecutionAuditError("audit_scope_unavailable");
		}
	}

	private foldCurrentSession(sessionId: string): FoldedSession {
		try {
			const entries = [...(this.source.getPhysicalEntries?.() ?? this.source.getEntries())];
			const snapshot: AuditSession = {
				getSessionId: () => sessionId,
				getEntries: () => entries,
			};
			const adapter = new ExecutionAuditAdapter(snapshot);
			return { sessionId, adapter, fold: adapter.fold() };
		} catch (error) {
			if (error instanceof ExecutionAuditError) throw error;
			throw new ExecutionAuditError("audit_scope_unavailable");
		}
	}

	private foldDirectory(query: AuditQuery): ReadSnapshot {
		const root = resolveDirectoryRoot(this.source);
		let candidates: string[];
		try {
			candidates = readdirSync(root)
				.filter((name) => name.endsWith(".jsonl"))
				.sort((left, right) => left.localeCompare(right))
				.map((name) => join(root, name));
		} catch {
			throw new ExecutionAuditError("audit_scope_unavailable");
		}
		if (candidates.length > this.limits.maxSessionCandidates) throw new ExecutionAuditError("audit_scope_unavailable");

		const sessions: FoldedSession[] = [];
		const warnings: AuditWarning[] = [];
		let unavailable = false;
		for (const candidate of candidates) {
			let entries: FileEntry[];
			try {
				const candidateStat = lstatSync(candidate);
				if (!candidateStat.isFile() || candidateStat.isSymbolicLink()) {
					warnings.push(unavailableWarning());
					unavailable = true;
					continue;
				}
				const realCandidate = realpathSync(candidate);
				if (!isPathWithinRoot(root, realCandidate)) {
					warnings.push(unavailableWarning());
					unavailable = true;
					continue;
				}
				entries = loadEntriesFromFile(candidate);
				const afterRead = lstatSync(candidate);
				const afterReadPath = realpathSync(candidate);
				if (!afterRead.isFile() || afterRead.isSymbolicLink() || !isPathWithinRoot(root, afterReadPath)) {
					warnings.push(unavailableWarning());
					unavailable = true;
					continue;
				}
			} catch {
				warnings.push(unavailableWarning());
				unavailable = true;
				continue;
			}

			const header = entries[0];
			if (header?.type !== "session" || !isSafeIdentifier(header.id)) {
				warnings.push(unavailableWarning());
				unavailable = true;
				continue;
			}
			if (query.sessionId !== undefined && query.sessionId !== header.id) continue;
			if (sessions.length >= this.limits.maxSessions) throw new ExecutionAuditError("audit_scope_unavailable");
			const sessionId = header.id;
			const session: AuditSession = {
				getSessionId: () => sessionId,
				getEntries: () => entriesWithoutHeader(entries),
			};
			try {
				const adapter = new ExecutionAuditAdapter(session);
				sessions.push({ sessionId, adapter, fold: adapter.fold() });
			} catch (error) {
				if (error instanceof ExecutionAuditError && error.code === "audit_replay_incomplete") throw error;
				warnings.push(unavailableWarning(sessionId));
				unavailable = true;
			}
		}

		const events = mergeEvents(sessions.flatMap((session) => [...session.fold.events]));
		const mergedWarnings = mergeWarnings([
			...warnings,
			...sessions.flatMap((session) => [...session.fold.warnings]),
		]);
		return { sessions, events, warnings: mergedWarnings, unavailable };
	}

	private read(query: AuditQuery): ReadSnapshot {
		if (query.scope === "current-session") {
			const current = this.foldCurrentSession(this.currentSessionId());
			return {
				sessions: [current],
				events: mergeEvents(current.fold.events),
				warnings: mergeWarnings(current.fold.warnings),
				unavailable: false,
			};
		}
		return this.foldDirectory(query);
	}

	query(input: AuditQuery): AuditQueryResult {
		const query = normalizeQuery(input, this.currentSessionId());
		const snapshot = this.read(query);
		const page = paginate(filterEvents(snapshot.events, query), query, this.secret);
		return {
			schemaVersion: AUDIT_SCHEMA_VERSION,
			scope: query.scope,
			events: page.events,
			...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
			warnings: snapshot.warnings,
		};
	}

	auditQuery(input: AuditQuery): AuditQueryResult {
		return this.query(input);
	}

	replay(input: AuditReplayQuery | string, options: Omit<AuditReplayQuery, "runId"> = {}): AuditReplayResult {
		const query = normalizeReplay(input, options, this.currentSessionId());
		const snapshot = this.read(query);
		const runId = query.runId;
		if (runId === undefined) throw new ExecutionAuditError("audit_query_invalid");

		const runSessions = snapshot.sessions.filter((session) => session.fold.runSummaries.has(runId));
		if (runSessions.length === 0) throw new ExecutionAuditError("audit_run_not_found");
		const orderedRunSessions = [...runSessions].sort((left, right) => left.sessionId.localeCompare(right.sessionId));
		const run = orderedRunSessions[0]!.fold.runSummaries.get(runId)!;
		const replayWarnings: AuditWarning[] = [];
		let incomplete = snapshot.unavailable;
		for (const session of orderedRunSessions) {
			try {
				const local = session.adapter.replay(runId);
				replayWarnings.push(...local.warnings);
				if (local.status === "incomplete") incomplete = true;
			} catch (error) {
				if (error instanceof ExecutionAuditError && error.code === "audit_replay_incomplete") throw error;
				incomplete = true;
			}
		}
		if (orderedRunSessions.length > 1) incomplete = true;
		const relevantEvents = filterEvents(snapshot.events, query).filter((event) => event.runId === runId);
		const page = paginate(relevantEvents, query, this.secret);
		const warnings = mergeWarnings([
			...replayWarnings,
			...(snapshot.unavailable ? snapshot.warnings.filter((item) => item.code === "source_unavailable") : []),
			...(orderedRunSessions.length > 1 ? [{ code: "ambiguous_run_association" as const }] : []),
		]);
		const status: AuditReplayStatus = incomplete
			? "incomplete"
			: run.status === "completed" || run.status === "failed" || run.status === "cancelled"
				? "complete"
				: "interrupted";
		return {
			schemaVersion: AUDIT_SCHEMA_VERSION,
			run,
			events: page.events,
			...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
			status,
			warnings,
		};
	}

	auditReplay(input: AuditReplayQuery | string, options: Omit<AuditReplayQuery, "runId"> = {}): AuditReplayResult {
		return this.replay(input, options);
	}
}

export const createExecutionAuditQuery = (source: AuditQuerySession, options?: ExecutionAuditQueryOptions): ExecutionAuditQuery =>
	new ExecutionAuditQuery(source, options);

export { ExecutionAuditQuery as ExecutionAuditQueryService };

export function queryExecutionAudit(
	source: AuditQuerySession,
	query: AuditQuery,
	options?: ExecutionAuditQueryOptions,
): AuditQueryResult {
	return new ExecutionAuditQuery(source, options).query(query);
}

export function replayExecutionAudit(
	source: AuditQuerySession,
	input: AuditReplayQuery | string,
	options?: ExecutionAuditQueryOptions,
): AuditReplayResult {
	return new ExecutionAuditQuery(source, options).replay(input);
}
