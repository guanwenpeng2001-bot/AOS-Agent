import {
	canonicalFoundationJson,
	fingerprintFoundationValue,
	type Fingerprint,
	type FoundationRecord,
	type SessionLedger,
} from "@aos-agent/agent-core";
import type { FileEntry, SessionEntry } from "../session-manager.ts";

const CURRENT_HISTORICAL_SESSION_VERSION = 3 as const;
const MIGRATION_MARKER_OBJECT_TYPE = "migration.applied";
const FOUNDATION_CUSTOM_PREFIX = "__aos.foundation.";

const FOUNDATION_COMPATIBILITY_TYPES = new Map<string, string>([
	["__aos.foundation.entry.v1", "entry"],
	["__aos.foundation.record.v1", "record"],
	["__aos.foundation.lane.v1", "lane"],
	["__aos.foundation.fact.v1", "fact"],
	["__aos.foundation.durable.v1", "durable"],
]);

export interface MigrationAppliedMarkerV1 {
	readonly schemaVersion: 1;
	readonly migrationId: string;
	readonly sourceKind: string;
	readonly sourceSchemaVersion: number;
	readonly targetSchemaVersion: number;
	readonly sourceFingerprint: Fingerprint;
	readonly resultFingerprint: Fingerprint;
	readonly status: "applied";
}

export interface PrivateMigrationPlanV1<TResult> extends MigrationAppliedMarkerV1 {
	readonly source: unknown;
	readonly result: TResult;
}

export interface PrivateMigrationRunResultV1<TResult> {
	readonly status: "applied" | "replayed";
	readonly marker: MigrationAppliedMarkerV1;
	readonly result: TResult;
}

export interface LegacySessionCompatibilityViewV1 {
	readonly entryId: string;
	readonly kind: "entry" | "record" | "lane" | "name" | "label" | "durable";
	readonly value: unknown;
}

export interface LegacySessionEntryMigrationResultV1 {
	readonly schemaVersion: 1;
	readonly sessionVersion: 3;
	readonly entries: readonly FileEntry[];
	readonly compatibilityViews: readonly LegacySessionCompatibilityViewV1[];
}

export interface LegacyUnavailableProviderDescriptorViewV1 {
	readonly schemaVersion: 1;
	readonly providerKind: "acp" | "sdk";
	readonly providerId: string;
	readonly revision: number;
	readonly status: "unavailable";
}

export class PrivateMigrationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "PrivateMigrationError";
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
	const keys = new Set(allowed);
	return Object.keys(value).every((key) => keys.has(key));
}

function hasExactRequiredKeys(
	value: Record<string, unknown>,
	required: readonly string[],
	optional: readonly string[] = [],
): boolean {
	return required.every((key) => Object.hasOwn(value, key)) && hasOnlyKeys(value, [...required, ...optional]);
}

function cloneCanonical<TValue>(value: TValue, label: string): TValue {
	try {
		return JSON.parse(canonicalFoundationJson(value)) as TValue;
	} catch {
		throw new PrivateMigrationError(`${label} is not canonical JSON`);
	}
}

function isPositiveSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isFingerprint(value: unknown): value is Fingerprint {
	return (
		isRecord(value) &&
		hasExactRequiredKeys(value, ["algorithm", "value"]) &&
		value.algorithm === "sha256" &&
		typeof value.value === "string" &&
		/^[a-f0-9]{64}$/u.test(value.value)
	);
}

function markerFromPlan<TResult>(plan: PrivateMigrationPlanV1<TResult>): MigrationAppliedMarkerV1 {
	return {
		schemaVersion: 1,
		migrationId: plan.migrationId,
		sourceKind: plan.sourceKind,
		sourceSchemaVersion: plan.sourceSchemaVersion,
		targetSchemaVersion: plan.targetSchemaVersion,
		sourceFingerprint: plan.sourceFingerprint,
		resultFingerprint: plan.resultFingerprint,
		status: "applied",
	};
}

function decodeMigrationMarker(value: unknown): MigrationAppliedMarkerV1 {
	if (
		!isRecord(value) ||
		!hasExactRequiredKeys(value, [
			"schemaVersion",
			"migrationId",
			"sourceKind",
			"sourceSchemaVersion",
			"targetSchemaVersion",
			"sourceFingerprint",
			"resultFingerprint",
			"status",
		]) ||
		value.schemaVersion !== 1 ||
		typeof value.migrationId !== "string" ||
		value.migrationId.length === 0 ||
		typeof value.sourceKind !== "string" ||
		value.sourceKind.length === 0 ||
		!isNonNegativeSafeInteger(value.sourceSchemaVersion) ||
		!isNonNegativeSafeInteger(value.targetSchemaVersion) ||
		!isFingerprint(value.sourceFingerprint) ||
		!isFingerprint(value.resultFingerprint) ||
		value.status !== "applied"
	) {
		throw new PrivateMigrationError("Persisted migration.applied marker has an invalid exact shape");
	}
	return value as unknown as MigrationAppliedMarkerV1;
}

function markersEqual(left: MigrationAppliedMarkerV1, right: MigrationAppliedMarkerV1): boolean {
	return canonicalFoundationJson(left) === canonicalFoundationJson(right);
}

export function createPrivateMigrationIdV1(migrationName: string, sourceIdentity: unknown): string {
	if (!/^[a-z][a-z0-9.-]{0,63}$/u.test(migrationName)) {
		throw new PrivateMigrationError("Migration name is invalid");
	}
	return `migration:${migrationName}:${fingerprintFoundationValue(sourceIdentity).value}`;
}

export function createPrivateMigrationPlanV1<TResult>(input: {
	readonly migrationName: string;
	readonly sourceIdentity: unknown;
	readonly sourceKind: string;
	readonly sourceSchemaVersion: number;
	readonly targetSchemaVersion: number;
	readonly source: unknown;
	readonly result: TResult;
}): PrivateMigrationPlanV1<TResult> {
	if (
		input.sourceKind.length === 0 ||
		!isNonNegativeSafeInteger(input.sourceSchemaVersion) ||
		!isNonNegativeSafeInteger(input.targetSchemaVersion)
	) {
		throw new PrivateMigrationError("Migration plan versions or source kind are invalid");
	}
	const source = cloneCanonical(input.source, "Migration source");
	const result = cloneCanonical(input.result, "Migration result");
	return {
		schemaVersion: 1,
		migrationId: createPrivateMigrationIdV1(input.migrationName, input.sourceIdentity),
		sourceKind: input.sourceKind,
		sourceSchemaVersion: input.sourceSchemaVersion,
		targetSchemaVersion: input.targetSchemaVersion,
		sourceFingerprint: fingerprintFoundationValue(source),
		resultFingerprint: fingerprintFoundationValue(result),
		status: "applied",
		source,
		result,
	};
}

/**
 * Persist one deterministic marker after pre-reading its object. The explicit
 * expectedRevision is required because SessionLedger checks CAS before its own
 * equivalent-payload replay shortcut.
 */
export async function runPrivateMigrationV1<TResult>(
	ledger: SessionLedger,
	plan: PrivateMigrationPlanV1<TResult>,
): Promise<PrivateMigrationRunResultV1<TResult>> {
	const expectedMarker = markerFromPlan(plan);
	if (
		!isFingerprint(plan.sourceFingerprint) ||
		!isFingerprint(plan.resultFingerprint) ||
		fingerprintFoundationValue(plan.source).value !== plan.sourceFingerprint.value ||
		fingerprintFoundationValue(plan.result).value !== plan.resultFingerprint.value
	) {
		throw new PrivateMigrationError("Migration plan fingerprints do not match its source or result");
	}

	const existing = await ledger.get(MIGRATION_MARKER_OBJECT_TYPE, plan.migrationId);
	if (existing !== undefined) {
		if (existing.kind !== "fact") {
			throw new PrivateMigrationError("migration.applied identity is occupied by a non-fact record");
		}
		const marker = decodeMigrationMarker(existing.payload);
		if (!markersEqual(marker, expectedMarker)) {
			throw new PrivateMigrationError("migration.applied marker conflicts with the requested migration");
		}
		return { status: "replayed", marker, result: cloneCanonical(plan.result, "Migration result") };
	}

	const expectedRevision = await ledger.revision(MIGRATION_MARKER_OBJECT_TYPE, plan.migrationId);
	try {
		const appended = await ledger.appendFact(MIGRATION_MARKER_OBJECT_TYPE, plan.migrationId, expectedMarker, {
			clientRequestId: `migration:${plan.migrationId}`,
			expectedRevision,
			correlation: {},
		});
		const marker = decodeMigrationMarker(appended.payload);
		if (!markersEqual(marker, expectedMarker)) {
			throw new PrivateMigrationError("migration.applied append replayed a conflicting marker");
		}
		return {
			status: appended.replayed ? "replayed" : "applied",
			marker,
			result: cloneCanonical(plan.result, "Migration result"),
		};
	} catch (error) {
		const raced = await ledger.getFact<unknown>(MIGRATION_MARKER_OBJECT_TYPE, plan.migrationId);
		if (raced !== undefined) {
			const marker = decodeMigrationMarker(raced.payload);
			if (markersEqual(marker, expectedMarker)) {
				return { status: "replayed", marker, result: cloneCanonical(plan.result, "Migration result") };
			}
		}
		throw error;
	}
}

const SESSION_HEADER_REQUIRED = ["type", "id", "timestamp", "cwd"] as const;
const SESSION_HEADER_OPTIONAL = ["version", "parentSession"] as const;

function decodeHeader(value: unknown): { readonly version: 1 | 2 | 3; readonly header: Record<string, unknown> } {
	if (
		!isRecord(value) ||
		!hasExactRequiredKeys(value, SESSION_HEADER_REQUIRED, SESSION_HEADER_OPTIONAL) ||
		value.type !== "session" ||
		typeof value.id !== "string" ||
		value.id.length === 0 ||
		typeof value.timestamp !== "string" ||
		typeof value.cwd !== "string" ||
		(value.parentSession !== undefined && typeof value.parentSession !== "string")
	) {
		throw new PrivateMigrationError("Historical Session header has an invalid exact shape");
	}
	const version = value.version ?? 1;
	if (version !== 1 && version !== 2 && version !== 3) {
		throw new PrivateMigrationError("Historical Session header has an unsupported version");
	}
	if (version === 1 && Object.hasOwn(value, "version")) {
		throw new PrivateMigrationError("Historical Session v1 header must omit version");
	}
	return { version, header: cloneCanonical(value, "Historical Session header") };
}

const ENTRY_KEYS = new Map<string, { readonly required: readonly string[]; readonly optional: readonly string[] }>([
	["message", { required: ["type", "timestamp", "message"], optional: [] }],
	["thinking_level_change", { required: ["type", "timestamp", "thinkingLevel"], optional: [] }],
	["model_change", { required: ["type", "timestamp", "provider", "modelId"], optional: [] }],
	[
		"compaction",
		{
			required: ["type", "timestamp", "summary", "tokensBefore"],
			optional: ["firstKeptEntryIndex", "firstKeptEntryId", "details", "usage", "fromHook"],
		},
	],
	[
		"branch_summary",
		{ required: ["type", "timestamp", "fromId", "summary"], optional: ["details", "usage", "fromHook"] },
	],
	["custom", { required: ["type", "timestamp", "customType"], optional: ["data"] }],
	[
		"custom_message",
		{ required: ["type", "timestamp", "customType", "content", "display"], optional: ["details"] },
	],
	["label", { required: ["type", "timestamp", "targetId"], optional: ["label"] }],
	["session_info", { required: ["type", "timestamp"], optional: ["name"] }],
]);

function decodeEntry(value: unknown, version: 1 | 2 | 3): Record<string, unknown> {
	if (!isRecord(value) || typeof value.type !== "string") {
		throw new PrivateMigrationError("Historical Session entry is not an object with a type");
	}
	const keys = ENTRY_KEYS.get(value.type);
	if (keys === undefined) throw new PrivateMigrationError(`Historical Session entry type ${value.type} is unsupported`);
	const structuralRequired = version === 1 ? [] : ["id", "parentId"];
	if (!hasExactRequiredKeys(value, [...keys.required, ...structuralRequired], keys.optional)) {
		throw new PrivateMigrationError(`Historical Session ${value.type} entry has an invalid exact shape`);
	}
	if (
		typeof value.timestamp !== "string" ||
		(version !== 1 &&
			(typeof value.id !== "string" || value.id.length === 0 || (value.parentId !== null && typeof value.parentId !== "string")))
	) {
		throw new PrivateMigrationError(`Historical Session ${value.type} entry has invalid identity fields`);
	}
	if (value.type === "thinking_level_change" && typeof value.thinkingLevel !== "string") {
		throw new PrivateMigrationError("Historical thinking-level entry is invalid");
	}
	if (value.type === "model_change" && (typeof value.provider !== "string" || typeof value.modelId !== "string")) {
		throw new PrivateMigrationError("Historical model-change entry is invalid");
	}
	if (
		(value.type === "compaction" || value.type === "branch_summary") &&
		(typeof value.summary !== "string" ||
			(value.type === "compaction" && !isNonNegativeSafeInteger(value.tokensBefore)))
	) {
		throw new PrivateMigrationError(`Historical Session ${value.type} entry is invalid`);
	}
	if (value.type === "compaction") {
		if (version === 1 && !isNonNegativeSafeInteger(value.firstKeptEntryIndex)) {
			throw new PrivateMigrationError("Historical Session v1 compaction requires firstKeptEntryIndex");
		}
		if (version !== 1 && typeof value.firstKeptEntryId !== "string") {
			throw new PrivateMigrationError("Historical Session v2/v3 compaction requires firstKeptEntryId");
		}
		if (version === 1 && Object.hasOwn(value, "firstKeptEntryId")) {
			throw new PrivateMigrationError("Historical Session v1 compaction cannot contain firstKeptEntryId");
		}
		if (version !== 1 && Object.hasOwn(value, "firstKeptEntryIndex")) {
			throw new PrivateMigrationError("Historical Session v2/v3 compaction cannot contain firstKeptEntryIndex");
		}
	}
	if (value.type === "custom" && typeof value.customType !== "string") {
		throw new PrivateMigrationError("Historical custom Session entry is invalid");
	}
	if (value.type === "custom_message" && (typeof value.customType !== "string" || typeof value.display !== "boolean")) {
		throw new PrivateMigrationError("Historical custom-message Session entry is invalid");
	}
	if (value.type === "label" && (typeof value.targetId !== "string" || (value.label !== undefined && typeof value.label !== "string"))) {
		throw new PrivateMigrationError("Historical label Session entry is invalid");
	}
	if (value.type === "session_info" && value.name !== undefined && typeof value.name !== "string") {
		throw new PrivateMigrationError("Historical session-info entry is invalid");
	}
	return cloneCanonical(value, `Historical Session ${value.type} entry`);
}

function deterministicLegacyEntryId(sessionId: string, index: number, entry: unknown, used: Set<string>): string {
	const digest = fingerprintFoundationValue({ schemaVersion: 1, sessionId, index, entry }).value;
	for (let offset = 0; offset <= digest.length - 8; offset += 8) {
		const candidate = digest.slice(offset, offset + 8);
		if (!used.has(candidate)) return candidate;
	}
	throw new PrivateMigrationError("Historical Session entry id digest collision");
}

function compatibilityView(entry: Record<string, unknown>): LegacySessionCompatibilityViewV1 | undefined {
	if (entry.type !== "custom" || typeof entry.customType !== "string") return undefined;
	if (!entry.customType.startsWith(FOUNDATION_CUSTOM_PREFIX)) return undefined;
	const expectedKind = FOUNDATION_COMPATIBILITY_TYPES.get(entry.customType);
	if (expectedKind === undefined) {
		throw new PrivateMigrationError(`Unknown historical Foundation compatibility type ${entry.customType}`);
	}
	if (!isRecord(entry.data) || entry.data.schemaVersion !== 1 || typeof entry.data.kind !== "string") {
		throw new PrivateMigrationError(`Historical Foundation compatibility wrapper ${entry.customType} is invalid`);
	}
	const data = entry.data;
	let kind: LegacySessionCompatibilityViewV1["kind"];
	if (expectedKind === "entry") {
		if (!hasExactRequiredKeys(data, ["schemaVersion", "kind", "entry"]) || data.kind !== "entry") {
			throw new PrivateMigrationError("Historical Foundation entry wrapper has an invalid exact shape");
		}
		kind = "entry";
	} else if (expectedKind === "record") {
		if (!hasExactRequiredKeys(data, ["schemaVersion", "kind", "record"]) || data.kind !== "record") {
			throw new PrivateMigrationError("Historical Foundation record wrapper has an invalid exact shape");
		}
		kind = "record";
	} else if (expectedKind === "lane") {
		if (
			!hasExactRequiredKeys(data, ["schemaVersion", "kind", "lane", "leafId"]) ||
			data.kind !== "lane" ||
			typeof data.lane !== "string" ||
			(data.leafId !== null && typeof data.leafId !== "string")
		) {
			throw new PrivateMigrationError("Historical Foundation lane wrapper has an invalid exact shape");
		}
		kind = "lane";
	} else if (expectedKind === "fact") {
		if (data.kind === "name") {
			if (!hasExactRequiredKeys(data, ["schemaVersion", "kind"], ["name"]) || (data.name !== undefined && typeof data.name !== "string")) {
				throw new PrivateMigrationError("Historical Foundation name wrapper has an invalid exact shape");
			}
			kind = "name";
		} else {
			if (
				!hasExactRequiredKeys(data, ["schemaVersion", "kind", "targetId"], ["label"]) ||
				data.kind !== "label" ||
				typeof data.targetId !== "string" ||
				(data.label !== undefined && typeof data.label !== "string")
			) {
				throw new PrivateMigrationError("Historical Foundation label wrapper has an invalid exact shape");
			}
			kind = "label";
		}
	} else {
		if (!hasExactRequiredKeys(data, ["schemaVersion", "kind", "record"]) || data.kind !== "durable") {
			throw new PrivateMigrationError("Historical Foundation durable wrapper has an invalid exact shape");
		}
		kind = "durable";
	}
	return {
		entryId: entry.id as string,
		kind,
		value: cloneCanonical(data, "Historical Foundation compatibility wrapper"),
	};
}

/** Decode and deterministically apply the existing Session v1 -> v2 -> v3 rules. */
export function migrateLegacySessionEntriesV1(source: readonly unknown[]): LegacySessionEntryMigrationResultV1 {
	if (source.length === 0) throw new PrivateMigrationError("Historical Session is empty");
	const decodedHeader = decodeHeader(source[0]);
	const sessionId = decodedHeader.header.id as string;
	const decodedEntries = source.slice(1).map((entry) => decodeEntry(entry, decodedHeader.version));
	const used = new Set<string>();
	const ids = decodedEntries.map((entry, index) => {
		const id = decodedHeader.version === 1
			? deterministicLegacyEntryId(sessionId, index + 1, entry, used)
			: entry.id as string;
		if (used.has(id)) throw new PrivateMigrationError(`Historical Session repeats entry id ${id}`);
		used.add(id);
		return id;
	});

	const migratedEntries = decodedEntries.map((entry, index) => {
		const migrated: Record<string, unknown> = cloneCanonical(entry, "Historical Session entry");
		if (decodedHeader.version === 1) {
			migrated.id = ids[index];
			migrated.parentId = index === 0 ? null : ids[index - 1];
			if (migrated.type === "compaction") {
				const targetIndex = migrated.firstKeptEntryIndex as number;
				if (targetIndex < 1 || targetIndex > decodedEntries.length) {
					throw new PrivateMigrationError("Historical Session compaction firstKeptEntryIndex is out of range");
				}
				migrated.firstKeptEntryId = ids[targetIndex - 1];
				delete migrated.firstKeptEntryIndex;
			}
		}
		if (decodedHeader.version < 3 && migrated.type === "message" && isRecord(migrated.message) && migrated.message.role === "hookMessage") {
			migrated.message = { ...migrated.message, role: "custom" };
		}
		return migrated;
	});

	const header = { ...decodedHeader.header, version: CURRENT_HISTORICAL_SESSION_VERSION };
	const compatibilityViews = migratedEntries
		.map(compatibilityView)
		.filter((view): view is LegacySessionCompatibilityViewV1 => view !== undefined);
	return {
		schemaVersion: 1,
		sessionVersion: CURRENT_HISTORICAL_SESSION_VERSION,
		entries: cloneCanonical([header, ...migratedEntries], "Migrated Session entries") as FileEntry[],
		compatibilityViews,
	};
}

/** Create a marker-ready plan for one physical Session file identity. */
export function planLegacySessionEntryMigrationV1(source: readonly unknown[]): PrivateMigrationPlanV1<LegacySessionEntryMigrationResultV1> {
	const result = migrateLegacySessionEntriesV1(source);
	const header = result.entries[0];
	if (header === undefined || header.type !== "session") throw new PrivateMigrationError("Migrated Session header is missing");
	return createPrivateMigrationPlanV1({
		migrationName: "session-entry-v1-v3",
		sourceIdentity: { sessionId: header.id },
		sourceKind: "session.entry",
		sourceSchemaVersion: decodeHeader(source[0]).version,
		targetSchemaVersion: CURRENT_HISTORICAL_SESSION_VERSION,
		source,
		result,
	});
}

const DESCRIPTOR_KEYS = [
	"schemaVersion",
	"providerKind",
	"descriptor",
	"revision",
	"capabilities",
	"implementedInThisLine",
] as const;

/**
 * Consume historical ACP/SDK Native descriptors only as unavailable metadata.
 * Records carrying execution or lifecycle claims necessarily fail exact-shape
 * decoding and are never converted into an Attempt or AgentInstance.
 */
export function decodeLegacyUnavailableProviderDescriptorV1(value: unknown): LegacyUnavailableProviderDescriptorViewV1 {
	if (!isRecord(value)) {
		throw new PrivateMigrationError("Historical unavailable provider descriptor must use acp or sdk");
	}
	const providerKind = value.providerKind;
	if (providerKind !== "acp" && providerKind !== "sdk") {
		throw new PrivateMigrationError("Historical unavailable provider descriptor must use acp or sdk");
	}
	if (!hasExactRequiredKeys(value, DESCRIPTOR_KEYS)) {
		throw new PrivateMigrationError("Historical ACP/SDK record contains an execution or lifecycle claim");
	}
	if (
		value.schemaVersion !== 1 ||
		!isPositiveSafeInteger(value.revision) ||
		value.implementedInThisLine !== false ||
		!isRecord(value.descriptor) ||
		!hasExactRequiredKeys(value.descriptor, ["schemaVersion", "providerId", "providerClass"]) ||
		value.descriptor.schemaVersion !== 1 ||
		typeof value.descriptor.providerId !== "string" ||
		value.descriptor.providerId.length === 0 ||
		value.descriptor.providerClass !== "agent" ||
		!isRecord(value.capabilities) ||
		!hasExactRequiredKeys(value.capabilities, [
			"resumeSupported",
			"mailboxSupported",
			"backgroundSupported",
			"worktreeSupported",
			"maxDepth",
		]) ||
		typeof value.capabilities.resumeSupported !== "boolean" ||
		typeof value.capabilities.mailboxSupported !== "boolean" ||
		typeof value.capabilities.backgroundSupported !== "boolean" ||
		typeof value.capabilities.worktreeSupported !== "boolean" ||
		!isPositiveSafeInteger(value.capabilities.maxDepth)
	) {
		throw new PrivateMigrationError("Historical ACP/SDK descriptor has an invalid exact shape");
	}
	return {
		schemaVersion: 1,
		providerKind,
		providerId: value.descriptor.providerId,
		revision: value.revision,
		status: "unavailable",
	};
}

/** Type-only guard to keep FoundationRecord's historical wire version in this private module. */
export type HistoricalFoundationRecordV1 = FoundationRecord;
/** Type-only guard to document that compatibility wrappers remain Session views. */
export type HistoricalSessionEntryV1 = SessionEntry;
