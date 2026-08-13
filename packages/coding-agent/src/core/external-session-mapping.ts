/**
 * Append-only mapping between an external execution and an AOS Session/Run.
 *
 * Mapping entries are ordinary Session custom entries. Custom entries do not
 * participate in Session context construction, so this module never puts an
 * external payload in the model context. The module owns validation and the
 * two key indexes; callers only receive the small, safe identifier summary.
 */

import type { SessionEntry } from "./session-manager.ts";

export const EXTERNAL_MAPPING_SCHEMA_VERSION = 1 as const;
export const EXTERNAL_MAPPING_CUSTOM_TYPE = "external.mapping" as const;

export type ExternalMappingErrorCode =
	| "external_mapping_invalid"
	| "external_mapping_conflict"
	| "audit_persistence_failed";

export interface ExternalExecutionRef {
	readonly namespace: string;
	readonly externalSessionId: string;
	readonly externalRunId?: string;
}

export interface ExternalExecutionMapping extends ExternalExecutionRef {
	readonly aosSessionId: string;
	readonly aosRunId?: string;
	readonly createdAt: string;
	readonly source?: string;
	readonly correlationId?: string;
}

/** Safe public alias for mapping summaries returned by the Automation Host. */
export type ExternalMappingSummary = ExternalExecutionMapping;

export interface PersistedExternalMappingEntry {
	readonly schemaVersion: typeof EXTERNAL_MAPPING_SCHEMA_VERSION;
	readonly mapping: ExternalExecutionMapping;
}

export interface ExternalMappingRequest {
	readonly external: ExternalExecutionRef;
	readonly aosSessionId: string;
	readonly aosRunId?: string;
	readonly source?: string;
	readonly correlationId?: string;
}

export interface ExternalMappingSession {
	getEntries(): ReadonlyArray<SessionEntry>;
	appendCustomEntry(customType: string, data?: unknown): string;
}

export interface ExternalMappingWarning {
	readonly code: "mapping_conflict" | "malformed_mapping";
	/** Alias used by diagnostics consumers that classify warnings by kind. */
	readonly kind: "mapping_conflict" | "malformed_mapping";
	readonly entryId: string;
	readonly namespace?: string;
	readonly externalSessionId?: string;
	readonly externalRunId?: string;
	readonly aosSessionId?: string;
	readonly aosRunId?: string;
}

export interface ExternalMappingFoldResult {
	readonly mappings: ReadonlyArray<ExternalExecutionMapping>;
	readonly byExternal: ReadonlyMap<string, ExternalExecutionMapping>;
	readonly byAos: ReadonlyMap<string, ExternalExecutionMapping>;
	readonly conflictedExternalKeys: ReadonlySet<string>;
	readonly conflictedAosKeys: ReadonlySet<string>;
	readonly warnings: ReadonlyArray<ExternalMappingWarning>;
}

export interface ExternalMappingPersistenceResult {
	readonly mapping: ExternalExecutionMapping;
	readonly appended: boolean;
	readonly idempotent: boolean;
	readonly entryId?: string;
}

export interface ExternalSessionMappingOptions {
	/** Server timestamp source. It must return a canonical ISO timestamp. */
	readonly now?: () => string;
	readonly diagnostics?: (warning: ExternalMappingWarning) => void;
}

export class ExternalMappingError extends Error {
	readonly code: ExternalMappingErrorCode;

	constructor(code: ExternalMappingErrorCode, message: string) {
		super(message);
		this.name = "ExternalMappingError";
		this.code = code;
	}
}

/** Compatibility name for callers that refer to the store's error directly. */
export { ExternalMappingError as ExternalSessionMappingError };

const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const CANONICAL_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const EXTERNAL_REF_KEYS = new Set(["namespace", "externalSessionId", "externalRunId"]);
const EXTERNAL_MAPPING_KEYS = new Set([
	"namespace",
	"externalSessionId",
	"externalRunId",
	"aosSessionId",
	"aosRunId",
	"createdAt",
	"source",
	"correlationId",
]);
const EXTERNAL_MAPPING_REQUEST_KEYS = new Set([
	"external",
	"aosSessionId",
	"aosRunId",
	"source",
	"correlationId",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
	return Object.keys(value).every((key) => allowed.has(key));
}

/** Safe identifiers reject paths, URLs, userinfo, query text, and controls. */
export function isExternalMappingIdentifier(value: unknown): value is string {
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

export function isCanonicalExternalMappingTimestamp(value: unknown): value is string {
	if (typeof value !== "string" || !CANONICAL_TIMESTAMP_PATTERN.test(value)) return false;
	const timestamp = new Date(value);
	return Number.isFinite(timestamp.getTime()) && timestamp.toISOString() === value;
}

function isOptionalIdentifier(value: unknown): value is string | undefined {
	return value === undefined || isExternalMappingIdentifier(value);
}

function safeEntryId(value: unknown): string | undefined {
	return isExternalMappingIdentifier(value) ? value : undefined;
}

function validateMappingRequest(request: ExternalMappingRequest): void {
	if (
		!isRecord(request) ||
		!Object.keys(request).every((key) => EXTERNAL_MAPPING_REQUEST_KEYS.has(key)) ||
		!isExternalExecutionRef(request.external) ||
		!isExternalMappingIdentifier(request.aosSessionId) ||
		!isOptionalIdentifier(request.aosRunId)
	) {
		throw new ExternalMappingError("external_mapping_invalid", "External mapping identifiers are invalid.");
	}
	if (!isOptionalIdentifier(request.source) || !isOptionalIdentifier(request.correlationId)) {
		throw new ExternalMappingError("external_mapping_invalid", "External mapping metadata is invalid.");
	}
}

/** Validate a ref and reject unknown keys so payloads cannot be smuggled in. */
export function isExternalExecutionRef(value: unknown): value is ExternalExecutionRef {
	if (!isRecord(value) || !hasOnlyKeys(value, EXTERNAL_REF_KEYS)) return false;
	return (
		isExternalMappingIdentifier(value.namespace) &&
		isExternalMappingIdentifier(value.externalSessionId) &&
		isOptionalIdentifier(value.externalRunId)
	);
}

export function isExternalExecutionMapping(value: unknown): value is ExternalExecutionMapping {
	if (!isRecord(value) || !hasOnlyKeys(value, EXTERNAL_MAPPING_KEYS)) return false;
	return (
		isExternalMappingIdentifier(value.namespace) &&
		isExternalMappingIdentifier(value.externalSessionId) &&
		isOptionalIdentifier(value.externalRunId) &&
		isExternalMappingIdentifier(value.aosSessionId) &&
		isOptionalIdentifier(value.aosRunId) &&
		isCanonicalExternalMappingTimestamp(value.createdAt) &&
		isOptionalIdentifier(value.source) &&
		isOptionalIdentifier(value.correlationId)
	);
}

export function isPersistedExternalMappingEntry(value: unknown): value is PersistedExternalMappingEntry {
	if (!isRecord(value) || Object.keys(value).some((key) => key !== "schemaVersion" && key !== "mapping")) return false;
	return value.schemaVersion === EXTERNAL_MAPPING_SCHEMA_VERSION && isExternalExecutionMapping(value.mapping);
}

/** Parse only the exact schema-versioned mapping payload. */
export function parseExternalMappingEntry(value: unknown): ExternalExecutionMapping | undefined {
	return isPersistedExternalMappingEntry(value) ? cloneMapping(value.mapping) : undefined;
}

export function serializeExternalExecutionRef(value: ExternalExecutionRef): ExternalExecutionRef | undefined {
	if (!isExternalExecutionRef(value)) return undefined;
	return {
		namespace: value.namespace,
		externalSessionId: value.externalSessionId,
		...(value.externalRunId === undefined ? {} : { externalRunId: value.externalRunId }),
	};
}

export function serializeExternalExecutionMapping(value: ExternalExecutionMapping): ExternalExecutionMapping | undefined {
	if (!isExternalExecutionMapping(value)) return undefined;
	const mapping: ExternalExecutionMapping = {
		namespace: value.namespace,
		externalSessionId: value.externalSessionId,
		aosSessionId: value.aosSessionId,
		createdAt: value.createdAt,
	};
	if (value.externalRunId !== undefined) (mapping as { externalRunId?: string }).externalRunId = value.externalRunId;
	if (value.aosRunId !== undefined) (mapping as { aosRunId?: string }).aosRunId = value.aosRunId;
	if (value.source !== undefined) (mapping as { source?: string }).source = value.source;
	if (value.correlationId !== undefined) (mapping as { correlationId?: string }).correlationId = value.correlationId;
	return mapping;
}

function cloneMapping(value: ExternalExecutionMapping): ExternalExecutionMapping {
	const mapping: ExternalExecutionMapping = {
		namespace: value.namespace,
		externalSessionId: value.externalSessionId,
		aosSessionId: value.aosSessionId,
		createdAt: value.createdAt,
	};
	if (value.externalRunId !== undefined) (mapping as { externalRunId?: string }).externalRunId = value.externalRunId;
	if (value.aosRunId !== undefined) (mapping as { aosRunId?: string }).aosRunId = value.aosRunId;
	if (value.source !== undefined) (mapping as { source?: string }).source = value.source;
	if (value.correlationId !== undefined) (mapping as { correlationId?: string }).correlationId = value.correlationId;
	return mapping;
}

function externalKey(value: Pick<ExternalExecutionMapping, "namespace" | "externalSessionId" | "externalRunId">): string {
	return `${value.namespace}\u0000${value.externalSessionId}\u0000${value.externalRunId ?? "<absent>"}`;
}

function aosKey(value: Pick<ExternalExecutionMapping, "namespace" | "aosSessionId" | "aosRunId">): string {
	return `${value.namespace}\u0000${value.aosSessionId}\u0000${value.aosRunId ?? "<absent>"}`;
}

function sameTarget(left: ExternalExecutionMapping, right: ExternalExecutionMapping): boolean {
	return aosKey(left) === aosKey(right);
}

function sameExternal(left: ExternalExecutionMapping, right: ExternalExecutionMapping): boolean {
	return externalKey(left) === externalKey(right);
}

function warningForConflict(entryId: string, mapping: ExternalExecutionMapping): ExternalMappingWarning {
	return {
		code: "mapping_conflict",
		kind: "mapping_conflict",
		entryId: safeEntryId(entryId) ?? "unknown",
		namespace: mapping.namespace,
		externalSessionId: mapping.externalSessionId,
		...(mapping.externalRunId === undefined ? {} : { externalRunId: mapping.externalRunId }),
		aosSessionId: mapping.aosSessionId,
		...(mapping.aosRunId === undefined ? {} : { aosRunId: mapping.aosRunId }),
	};
}

function warningForMalformed(entryId: string): ExternalMappingWarning {
	return { code: "malformed_mapping", kind: "malformed_mapping", entryId: safeEntryId(entryId) ?? "unknown" };
}

function customEntry(value: SessionEntry): value is Extract<SessionEntry, { type: "custom" }> {
	return value.type === "custom";
}

/**
 * Fold mapping entries in append order. Contradictions are retained as
 * warnings and marked unusable in both indexes; no later entry overwrites an
 * earlier mapping and a conflicted key is never returned as a lookup result.
 */
export function foldExternalMappingEntries(
	entries: ReadonlyArray<SessionEntry>,
	diagnostics?: (warning: ExternalMappingWarning) => void,
): ExternalMappingFoldResult {
	const mappings: ExternalExecutionMapping[] = [];
	const byExternal = new Map<string, ExternalExecutionMapping>();
	const byAos = new Map<string, ExternalExecutionMapping>();
	const conflictedExternal = new Set<string>();
	const conflictedAos = new Set<string>();
	const warnings: ExternalMappingWarning[] = [];
	for (const entry of entries) {
		if (!customEntry(entry) || entry.customType !== EXTERNAL_MAPPING_CUSTOM_TYPE) continue;
		const mapping = parseExternalMappingEntry(entry.data);
		if (mapping === undefined) {
			const warning = warningForMalformed(entry.id);
			warnings.push(warning);
			diagnostics?.(warning);
			continue;
		}
		mappings.push(mapping);
		const leftKey = externalKey(mapping);
		const rightKey = aosKey(mapping);
		const existingExternal = byExternal.get(leftKey);
		const existingAos = byAos.get(rightKey);
		const externalConflict = existingExternal !== undefined && !sameTarget(existingExternal, mapping);
		const aosConflict = existingAos !== undefined && !sameExternal(existingAos, mapping);
		if (externalConflict || aosConflict || conflictedExternal.has(leftKey) || conflictedAos.has(rightKey)) {
			conflictedExternal.add(leftKey);
			conflictedAos.add(rightKey);
			if (existingExternal !== undefined) {
				conflictedAos.add(aosKey(existingExternal));
				conflictedExternal.add(externalKey(existingExternal));
			}
			if (existingAos !== undefined) {
				conflictedAos.add(aosKey(existingAos));
				conflictedExternal.add(externalKey(existingAos));
			}
			const warning = warningForConflict(entry.id, mapping);
			warnings.push(warning);
			diagnostics?.(warning);
			continue;
		}
		if (existingExternal === undefined && existingAos === undefined) {
			byExternal.set(leftKey, mapping);
			byAos.set(rightKey, mapping);
		}
	}
	for (const key of conflictedExternal) byExternal.delete(key);
	for (const key of conflictedAos) byAos.delete(key);
	return {
		mappings,
		byExternal,
		byAos,
		conflictedExternalKeys: conflictedExternal,
		conflictedAosKeys: conflictedAos,
		warnings,
	};
}

function cloneResult(mapping: ExternalExecutionMapping, appended: boolean, idempotent: boolean, entryId?: string): ExternalMappingPersistenceResult {
	const safeId = safeEntryId(entryId);
	return {
		mapping: cloneMapping(mapping),
		appended,
		idempotent,
		...(safeId === undefined ? {} : { entryId: safeId }),
	};
}

/**
 * Session-backed mapping registry. A new instance folds the existing Session
 * entries, which makes lookups and conflict checks restart-safe.
 */
export class ExternalSessionMappingStore {
	private readonly session: ExternalMappingSession;
	private readonly nowFn: () => string;
	private readonly diagnosticsSink: ((warning: ExternalMappingWarning) => void) | undefined;
	private diagnosedEntryIds = new Set<string>();
	private fold: ExternalMappingFoldResult = {
		mappings: [],
		byExternal: new Map(),
		byAos: new Map(),
		conflictedExternalKeys: new Set(),
		conflictedAosKeys: new Set(),
		warnings: [],
	};

	constructor(session: ExternalMappingSession, options: ExternalSessionMappingOptions = {}) {
		this.session = session;
		this.nowFn = options.now ?? (() => new Date().toISOString());
		this.diagnosticsSink = options.diagnostics;
		this.refresh();
	}

	/** Re-read append-only entries and return the current diagnostics snapshot. */
	refresh(): ReadonlyArray<ExternalMappingWarning> {
		const warnings: ExternalMappingWarning[] = [];
		let entries: ReadonlyArray<SessionEntry>;
		try {
			entries = this.session.getEntries();
		} catch {
			throw new ExternalMappingError("audit_persistence_failed", "External mapping state could not be read safely.");
		}
		const fold = foldExternalMappingEntries(entries, (warning) => {
			warnings.push(warning);
			if (!this.diagnosedEntryIds.has(warning.entryId)) {
				this.diagnosedEntryIds.add(warning.entryId);
				this.diagnosticsSink?.(warning);
			}
		});
		this.fold = fold;
		return fold.warnings;
	}

	rebuildIndex(): ReadonlyMap<string, ExternalExecutionMapping> {
		this.refresh();
		return this.fold.byExternal;
	}

	warnings(): readonly ExternalMappingWarning[] {
		return this.fold.warnings;
	}

	getWarnings(): readonly ExternalMappingWarning[] {
		return this.warnings();
	}

	mappings(): readonly ExternalExecutionMapping[] {
		return this.fold.mappings.map((mapping) => cloneMapping(mapping));
	}

	getMappings(): readonly ExternalExecutionMapping[] {
		return this.mappings();
	}

	getByExternal(ref: ExternalExecutionRef): ExternalExecutionMapping | undefined {
		if (!isExternalExecutionRef(ref)) return undefined;
		this.refresh();
		const mapping = this.fold.byExternal.get(externalKey(ref));
		return mapping === undefined ? undefined : cloneMapping(mapping);
	}

	lookupExternal(ref: ExternalExecutionRef): ExternalExecutionMapping | undefined {
		return this.getByExternal(ref);
	}

	getByAos(namespace: string, aosSessionId: string, aosRunId?: string): ExternalExecutionMapping | undefined {
		if (!isExternalMappingIdentifier(namespace) || !isExternalMappingIdentifier(aosSessionId) || !isOptionalIdentifier(aosRunId)) {
			return undefined;
		}
		this.refresh();
		const mapping = this.fold.byAos.get(`${namespace}\u0000${aosSessionId}\u0000${aosRunId ?? "<absent>"}`);
		return mapping === undefined ? undefined : cloneMapping(mapping);
	}

	lookupAos(namespace: string, aosSessionId: string, aosRunId?: string): ExternalExecutionMapping | undefined {
		return this.getByAos(namespace, aosSessionId, aosRunId);
	}

	/** Validate identifiers and current bidirectional uniqueness without appending. */
	validateMapping(request: ExternalMappingRequest): void {
		validateMappingRequest(request);
		this.refresh();
		const externalKeyValue = externalKey(request.external);
		const aosKeyValue = aosKey({
			namespace: request.external.namespace,
			aosSessionId: request.aosSessionId,
			aosRunId: request.aosRunId,
		});
		if (this.fold.conflictedExternalKeys.has(externalKeyValue) || this.fold.conflictedAosKeys.has(aosKeyValue)) {
			throw new ExternalMappingError("external_mapping_conflict", "External mapping contradicts append-only mapping history.");
		}
		const existingExternal = this.fold.byExternal.get(externalKeyValue);
		if (existingExternal !== undefined && !sameTarget(existingExternal, {
			...request.external,
			aosSessionId: request.aosSessionId,
			...(request.aosRunId === undefined ? {} : { aosRunId: request.aosRunId }),
			createdAt: "1970-01-01T00:00:00.000Z",
		})) {
			throw new ExternalMappingError("external_mapping_conflict", "External execution already maps to a different AOS target.");
		}
		const existingAos = this.fold.byAos.get(aosKeyValue);
		if (existingAos !== undefined && !sameExternal(existingAos, {
			...request.external,
			aosSessionId: request.aosSessionId,
			...(request.aosRunId === undefined ? {} : { aosRunId: request.aosRunId }),
			createdAt: "1970-01-01T00:00:00.000Z",
		})) {
			throw new ExternalMappingError("external_mapping_conflict", "AOS execution already maps to a different external target.");
		}
	}

	persistMapping(request: ExternalMappingRequest): ExternalMappingPersistenceResult {
		validateMappingRequest(request);
		this.refresh();
		let createdAt: string;
		try {
			createdAt = this.nowFn();
		} catch {
			throw new ExternalMappingError("audit_persistence_failed", "External mapping timestamp could not be generated safely.");
		}
		const proposed: ExternalExecutionMapping = {
			namespace: request.external.namespace,
			externalSessionId: request.external.externalSessionId,
			aosSessionId: request.aosSessionId,
			createdAt,
		};
		if (request.external.externalRunId !== undefined) {
			(proposed as { externalRunId?: string }).externalRunId = request.external.externalRunId;
		}
		if (request.aosRunId !== undefined) (proposed as { aosRunId?: string }).aosRunId = request.aosRunId;
		if (request.source !== undefined) (proposed as { source?: string }).source = request.source;
		if (request.correlationId !== undefined) (proposed as { correlationId?: string }).correlationId = request.correlationId;
		if (!isExternalExecutionMapping(proposed)) {
			throw new ExternalMappingError("external_mapping_invalid", "External mapping data is invalid.");
		}

		const existingExternal = this.fold.byExternal.get(externalKey(proposed));
		const existingAos = this.fold.byAos.get(aosKey(proposed));
		if (
			this.fold.conflictedExternalKeys.has(externalKey(proposed)) ||
			this.fold.conflictedAosKeys.has(aosKey(proposed))
		) {
			throw new ExternalMappingError("external_mapping_conflict", "External mapping contradicts append-only mapping history.");
		}
		if (existingExternal !== undefined && !sameTarget(existingExternal, proposed)) {
			throw new ExternalMappingError("external_mapping_conflict", "External execution already maps to a different AOS target.");
		}
		if (existingAos !== undefined && !sameExternal(existingAos, proposed)) {
			throw new ExternalMappingError("external_mapping_conflict", "AOS execution already maps to a different external target.");
		}
		if (existingExternal !== undefined || existingAos !== undefined) {
			const existing = existingExternal ?? existingAos;
			if (existing === undefined) throw new ExternalMappingError("external_mapping_conflict", "External mapping is conflicted.");
			return cloneResult(existing, false, true);
		}
		try {
			const entryId = this.session.appendCustomEntry(EXTERNAL_MAPPING_CUSTOM_TYPE, {
				schemaVersion: EXTERNAL_MAPPING_SCHEMA_VERSION,
				mapping: cloneMapping(proposed),
			} satisfies PersistedExternalMappingEntry);
			this.refresh();
			if (
				this.fold.byExternal.get(externalKey(proposed)) === undefined ||
				this.fold.byAos.get(aosKey(proposed)) === undefined
			) {
				throw new ExternalMappingError("audit_persistence_failed", "External mapping was not durably persisted.");
			}
			return cloneResult(proposed, true, false, entryId);
		} catch (error) {
			if (error instanceof ExternalMappingError) throw error;
			throw new ExternalMappingError("audit_persistence_failed", "External mapping could not be persisted.");
		}
	}

	ensureMapping(request: ExternalMappingRequest): ExternalMappingPersistenceResult {
		return this.persistMapping(request);
	}

	persistExternalMapping(request: ExternalMappingRequest): ExternalMappingPersistenceResult {
		return this.persistMapping(request);
	}
}

export function createExternalSessionMappingStore(
	session: ExternalMappingSession,
	options?: ExternalSessionMappingOptions,
): ExternalSessionMappingStore {
	return new ExternalSessionMappingStore(session, options);
}

export const createExternalSessionMapping = createExternalSessionMappingStore;

export function persistExternalMapping(
	session: ExternalMappingSession,
	request: ExternalMappingRequest,
	options?: ExternalSessionMappingOptions,
): ExternalMappingPersistenceResult {
	return new ExternalSessionMappingStore(session, options).persistMapping(request);
}
