/**
 * Append-only mapping between an external execution and an AOS Session/Run.
 *
 * Mapping entries are ordinary Session custom entries. Custom entries do not
 * participate in Session context construction, so this module never puts an
 * external payload in the model context. The module owns validation and the
 * two key indexes; callers only receive the small, safe identifier summary.
 *
 * The module also owns the adapter identity vocabulary that associates an
 * external execution with the trusted adapter, protocol, binding, and
 * operation that produced it: exact-shape guards for adapterId/targetId/
 * protocol/binding/operation/external refs, an identity-drift check, and a
 * stable association key. Adapter identity is optional mapping metadata; it
 * is never a path, URL, command, header, prompt, or credential.
 */

import type { Fingerprint } from "@aos-agent/agent-core";
import type { SessionEntry } from "./session-manager.ts";

export const EXTERNAL_MAPPING_SCHEMA_VERSION = 1 as const;
export const EXTERNAL_MAPPING_CUSTOM_TYPE = "external.mapping" as const;

/** Canonical durable mapping used by the Foundation ExternalAgentConnector runtime. */
export const EXTERNAL_CONNECTOR_MAPPING_SCHEMA_VERSION = 1 as const;

export interface CanonicalExternalConnectorMapping {
	readonly schemaVersion: typeof EXTERNAL_CONNECTOR_MAPPING_SCHEMA_VERSION;
	readonly providerId: string;
	readonly attemptId: string;
	readonly externalSessionId: string;
	readonly externalTurnId?: string;
	readonly binding: {
		readonly digest: Fingerprint;
		readonly revision: number;
	};
	readonly capability: {
		readonly digest: Fingerprint;
		readonly revision: number;
	};
	/** Opaque supervisor identity only. Process ids and local process metadata are private. */
	readonly supervisor: {
		readonly ref: string;
		readonly nonce: string;
	};
	readonly createdAt: string;
}

const CANONICAL_CONNECTOR_MAPPING_KEYS = new Set([
	"schemaVersion",
	"providerId",
	"attemptId",
	"externalSessionId",
	"externalTurnId",
	"binding",
	"capability",
	"supervisor",
	"createdAt",
]);
const CANONICAL_CONNECTOR_BINDING_KEYS = new Set(["digest", "revision"]);
const CANONICAL_CONNECTOR_CAPABILITY_KEYS = new Set(["digest", "revision"]);
const CANONICAL_CONNECTOR_SUPERVISOR_KEYS = new Set(["ref", "nonce"]);
const CANONICAL_CONNECTOR_FINGERPRINT_KEYS = new Set(["algorithm", "value"]);
const CANONICAL_CONNECTOR_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const CANONICAL_CONNECTOR_DIGEST = /^[a-f0-9]{64}$/;

function canonicalConnectorRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonicalConnectorExactKeys(value: Record<string, unknown>, keys: ReadonlySet<string>): boolean {
	return Object.keys(value).every((key) => keys.has(key));
}

function canonicalConnectorIdentifier(value: unknown): value is string {
	return typeof value === "string" && CANONICAL_CONNECTOR_IDENTIFIER.test(value);
}

function canonicalConnectorFingerprint(value: unknown): value is Fingerprint {
	if (!canonicalConnectorRecord(value) || !canonicalConnectorExactKeys(value, CANONICAL_CONNECTOR_FINGERPRINT_KEYS)) {
		return false;
	}
	return value.algorithm === "sha256" && typeof value.value === "string" && CANONICAL_CONNECTOR_DIGEST.test(value.value);
}

function canonicalConnectorRevision(value: unknown): value is number {
	return Number.isSafeInteger(value) && (value as number) >= 1;
}

/**
 * Exact, secret-free mapping guard. Identifier syntax rejects URLs and paths;
 * exact keys prevent raw config, prompts, transcripts, credentials, or local
 * process details from becoming durable mapping fields.
 */
export function isCanonicalExternalConnectorMapping(value: unknown): value is CanonicalExternalConnectorMapping {
	if (!canonicalConnectorRecord(value) || !canonicalConnectorExactKeys(value, CANONICAL_CONNECTOR_MAPPING_KEYS)) {
		return false;
	}
	if (
		value.schemaVersion !== EXTERNAL_CONNECTOR_MAPPING_SCHEMA_VERSION ||
		!canonicalConnectorIdentifier(value.providerId) ||
		!canonicalConnectorIdentifier(value.attemptId) ||
		!canonicalConnectorIdentifier(value.externalSessionId) ||
		(value.externalTurnId !== undefined && !canonicalConnectorIdentifier(value.externalTurnId)) ||
		typeof value.createdAt !== "string" ||
		Number.isNaN(Date.parse(value.createdAt))
	) {
		return false;
	}
	if (
		!canonicalConnectorRecord(value.binding) ||
		!canonicalConnectorExactKeys(value.binding, CANONICAL_CONNECTOR_BINDING_KEYS) ||
		!canonicalConnectorFingerprint(value.binding.digest) ||
		!canonicalConnectorRevision(value.binding.revision)
	) {
		return false;
	}
	if (
		!canonicalConnectorRecord(value.capability) ||
		!canonicalConnectorExactKeys(value.capability, CANONICAL_CONNECTOR_CAPABILITY_KEYS) ||
		!canonicalConnectorFingerprint(value.capability.digest) ||
		!canonicalConnectorRevision(value.capability.revision)
	) {
		return false;
	}
	return (
		canonicalConnectorRecord(value.supervisor) &&
		canonicalConnectorExactKeys(value.supervisor, CANONICAL_CONNECTOR_SUPERVISOR_KEYS) &&
		canonicalConnectorIdentifier(value.supervisor.ref) &&
		canonicalConnectorIdentifier(value.supervisor.nonce)
	);
}

export function cloneCanonicalExternalConnectorMapping(value: unknown): CanonicalExternalConnectorMapping {
	if (!isCanonicalExternalConnectorMapping(value)) {
		throw new ExternalMappingError("external_mapping_invalid", "Canonical external connector mapping is invalid.");
	}
	return Object.freeze({
		...value,
		binding: Object.freeze({ ...value.binding, digest: Object.freeze({ ...value.binding.digest }) }),
		capability: Object.freeze({ ...value.capability, digest: Object.freeze({ ...value.capability.digest }) }),
		supervisor: Object.freeze({ ...value.supervisor }),
	});
}

export type ExternalMappingErrorCode =
	| "external_mapping_invalid"
	| "external_mapping_conflict"
	| "audit_persistence_failed";

export interface ExternalExecutionRef {
	readonly namespace: string;
	readonly externalSessionId: string;
	readonly externalRunId?: string;
}

/** Verified adapter protocol reference; no endpoint, header, or payload data. */
export interface ExternalAdapterProtocolRef {
	readonly name: string;
	readonly version: string;
}

/** Explicit selection of a trusted adapter for one target. */
export interface ExternalAdapterSelectionRef {
	readonly adapterId: string;
	readonly targetId: string;
}

/**
 * Immutable adapter identity for one external execution: selection plus the
 * verified protocol name and version. Identity fields never carry paths,
 * URLs, commands, headers, prompts, or credentials.
 */
export interface ExternalAdapterIdentity extends ExternalAdapterSelectionRef {
	readonly protocol: ExternalAdapterProtocolRef;
}

/**
 * Association ref binding the adapter identity to a prepared binding, an
 * operation, and one external execution. Used to associate terminal receipts
 * and bounded events with the exact adapter execution that produced them.
 */
export interface ExternalAdapterExecutionRef extends ExternalAdapterIdentity {
	readonly bindingFingerprint?: string;
	readonly operationId?: string;
	readonly external: ExternalExecutionRef;
}

export interface ExternalExecutionMapping extends ExternalExecutionRef {
	readonly aosSessionId: string;
	readonly aosRunId?: string;
	readonly createdAt: string;
	readonly source?: string;
	readonly correlationId?: string;
	/** Optional adapter identity that created this mapping; validated exactly. */
	readonly adapter?: ExternalAdapterIdentity;
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
	readonly adapter?: ExternalAdapterIdentity;
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
const EXTERNAL_ADAPTER_PROTOCOL_KEYS = new Set(["name", "version"]);
const EXTERNAL_ADAPTER_SELECTION_KEYS = new Set(["adapterId", "targetId"]);
const EXTERNAL_ADAPTER_IDENTITY_KEYS = new Set(["adapterId", "targetId", "protocol"]);
const EXTERNAL_ADAPTER_EXECUTION_KEYS = new Set([
	"adapterId",
	"targetId",
	"protocol",
	"bindingFingerprint",
	"operationId",
	"external",
]);
const EXTERNAL_MAPPING_KEYS = new Set([
	"namespace",
	"externalSessionId",
	"externalRunId",
	"aosSessionId",
	"aosRunId",
	"createdAt",
	"source",
	"correlationId",
	"adapter",
]);
const EXTERNAL_MAPPING_REQUEST_KEYS = new Set([
	"external",
	"aosSessionId",
	"aosRunId",
	"source",
	"correlationId",
	"adapter",
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
	if (request.adapter !== undefined && !isExternalAdapterIdentity(request.adapter)) {
		throw new ExternalMappingError("external_mapping_invalid", "External mapping adapter identity is invalid.");
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

/** Exact-shape guard for a verified protocol ref; raw protocol objects are rejected. */
export function isExternalAdapterProtocolRef(value: unknown): value is ExternalAdapterProtocolRef {
	if (!isRecord(value) || !hasOnlyKeys(value, EXTERNAL_ADAPTER_PROTOCOL_KEYS)) return false;
	return isExternalMappingIdentifier(value.name) && isExternalMappingIdentifier(value.version);
}

/** Exact-shape guard for an adapter selection; no endpoint or descriptor data. */
export function isExternalAdapterSelectionRef(value: unknown): value is ExternalAdapterSelectionRef {
	if (!isRecord(value) || !hasOnlyKeys(value, EXTERNAL_ADAPTER_SELECTION_KEYS)) return false;
	return isExternalMappingIdentifier(value.adapterId) && isExternalMappingIdentifier(value.targetId);
}

/** Exact-shape guard for the immutable adapter identity; raw adapter self-reports are rejected. */
export function isExternalAdapterIdentity(value: unknown): value is ExternalAdapterIdentity {
	if (!isRecord(value) || !hasOnlyKeys(value, EXTERNAL_ADAPTER_IDENTITY_KEYS)) return false;
	return (
		isExternalMappingIdentifier(value.adapterId) &&
		isExternalMappingIdentifier(value.targetId) &&
		isExternalAdapterProtocolRef(value.protocol)
	);
}

/**
 * Exact-shape guard for the adapter execution association ref: identity plus
 * an optional binding fingerprint, operation id, and external execution ref.
 */
export function isExternalAdapterExecutionRef(value: unknown): value is ExternalAdapterExecutionRef {
	if (!isRecord(value) || !hasOnlyKeys(value, EXTERNAL_ADAPTER_EXECUTION_KEYS)) return false;
	return (
		isExternalMappingIdentifier(value.adapterId) &&
		isExternalMappingIdentifier(value.targetId) &&
		isExternalAdapterProtocolRef(value.protocol) &&
		isOptionalIdentifier(value.bindingFingerprint) &&
		isOptionalIdentifier(value.operationId) &&
		isExternalExecutionRef(value.external)
	);
}

/** Safe clone of an adapter identity; returns undefined for unsafe input. */
export function serializeExternalAdapterIdentity(
	value: ExternalAdapterIdentity,
): ExternalAdapterIdentity | undefined {
	if (!isExternalAdapterIdentity(value)) return undefined;
	return {
		adapterId: value.adapterId,
		targetId: value.targetId,
		protocol: { name: value.protocol.name, version: value.protocol.version },
	};
}

/** Safe clone of an adapter execution association ref; returns undefined for unsafe input. */
export function serializeExternalAdapterExecutionRef(
	value: ExternalAdapterExecutionRef,
): ExternalAdapterExecutionRef | undefined {
	if (!isExternalAdapterExecutionRef(value)) return undefined;
	const ref: ExternalAdapterExecutionRef = {
		adapterId: value.adapterId,
		targetId: value.targetId,
		protocol: { name: value.protocol.name, version: value.protocol.version },
		external: {
			namespace: value.external.namespace,
			externalSessionId: value.external.externalSessionId,
			...(value.external.externalRunId === undefined ? {} : { externalRunId: value.external.externalRunId }),
		},
	};
	if (value.bindingFingerprint !== undefined) (ref as { bindingFingerprint?: string }).bindingFingerprint = value.bindingFingerprint;
	if (value.operationId !== undefined) (ref as { operationId?: string }).operationId = value.operationId;
	return ref;
}

/** Identity drift check: selection and protocol must all match. */
export function sameExternalAdapterIdentity(left: ExternalAdapterIdentity, right: ExternalAdapterIdentity): boolean {
	return (
		left.adapterId === right.adapterId &&
		left.targetId === right.targetId &&
		left.protocol.name === right.protocol.name &&
		left.protocol.version === right.protocol.version
	);
}

/** Full association check: identity, binding fingerprint, operation, and external ref must all match. */
export function sameExternalAdapterExecutionRef(
	left: ExternalAdapterExecutionRef,
	right: ExternalAdapterExecutionRef,
): boolean {
	return (
		sameExternalAdapterIdentity(left, right) &&
		(left.bindingFingerprint ?? undefined) === (right.bindingFingerprint ?? undefined) &&
		(left.operationId ?? undefined) === (right.operationId ?? undefined) &&
		left.external.namespace === right.external.namespace &&
		left.external.externalSessionId === right.external.externalSessionId &&
		(left.external.externalRunId ?? undefined) === (right.external.externalRunId ?? undefined)
	);
}

/** Stable association key binding the adapter identity to one external execution. */
export function externalAdapterExecutionKey(value: ExternalAdapterExecutionRef): string {
	return [
		value.adapterId,
		value.targetId,
		value.protocol.name,
		value.protocol.version,
		value.external.namespace,
		value.external.externalSessionId,
		value.external.externalRunId ?? "<absent>",
	].join("\u0000");
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
		isOptionalIdentifier(value.correlationId) &&
		(value.adapter === undefined || isExternalAdapterIdentity(value.adapter))
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
	if (value.adapter !== undefined) (mapping as { adapter?: ExternalAdapterIdentity }).adapter = value.adapter;
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
	if (value.adapter !== undefined) {
		(mapping as { adapter?: ExternalAdapterIdentity }).adapter =
			serializeExternalAdapterIdentity(value.adapter) as ExternalAdapterIdentity;
	}
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
		const adapterDrift =
			existingExternal !== undefined &&
			existingExternal.adapter !== undefined &&
			mapping.adapter !== undefined &&
			!sameExternalAdapterIdentity(existingExternal.adapter, mapping.adapter);
		const aosConflict = existingAos !== undefined && !sameExternal(existingAos, mapping);
		if (externalConflict || adapterDrift || aosConflict || conflictedExternal.has(leftKey) || conflictedAos.has(rightKey)) {
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
		if (
			existingExternal !== undefined &&
			existingExternal.adapter !== undefined &&
			request.adapter !== undefined &&
			!sameExternalAdapterIdentity(existingExternal.adapter, request.adapter)
		) {
			throw new ExternalMappingError(
				"external_mapping_conflict",
				"External mapping adapter identity drifted from append-only mapping history.",
			);
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
		if (request.adapter !== undefined) {
			(proposed as { adapter?: ExternalAdapterIdentity }).adapter =
				serializeExternalAdapterIdentity(request.adapter) as ExternalAdapterIdentity;
		}
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
		if (
			existingExternal !== undefined &&
			existingExternal.adapter !== undefined &&
			proposed.adapter !== undefined &&
			!sameExternalAdapterIdentity(existingExternal.adapter, proposed.adapter)
		) {
			throw new ExternalMappingError(
				"external_mapping_conflict",
				"External mapping adapter identity drifted from append-only mapping history.",
			);
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
