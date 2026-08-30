import {
	canonicalFoundationJson,
	fingerprintFoundationValue,
	type Fingerprint,
	type FoundationRecord,
	type SessionLedger,
} from "../../../../agent/src/internal.ts";
import type { FileEntry, SessionEntry } from "../session/manager.ts";
import {
	decodeCurrentSessionEntry,
	decodeReservedFoundationCompatibilityWrapper,
} from "./session-contracts.ts";

const CURRENT_HISTORICAL_SESSION_VERSION = 3 as const;
const MIGRATION_MARKER_OBJECT_TYPE = "migration.applied";
const FOUNDATION_CUSTOM_PREFIX = "__aos.foundation.";

export interface MigrationAppliedMarker {
	readonly schemaVersion: 1;
	readonly migrationId: string;
	readonly sourceKind: string;
	readonly sourceSchemaVersion: number;
	readonly targetSchemaVersion: number;
	readonly sourceFingerprint: Fingerprint;
	readonly resultFingerprint: Fingerprint;
	readonly status: "applied";
}

export interface PrivateMigrationPlan<TResult> extends MigrationAppliedMarker {
	readonly source: unknown;
	readonly result: TResult;
}

export interface PrivateMigrationRunResult<TResult> {
	readonly status: "applied" | "replayed";
	readonly marker: MigrationAppliedMarker;
	readonly result: TResult;
}

export interface LegacySessionCompatibilityView {
	readonly entryId: string;
	readonly kind: "entry" | "record" | "lane" | "name" | "label" | "durable";
	readonly value: unknown;
}

export interface LegacySessionEntryMigrationResult {
	readonly schemaVersion: 1;
	readonly sessionVersion: 3;
	readonly entries: readonly FileEntry[];
	readonly compatibilityViews: readonly LegacySessionCompatibilityView[];
}

export interface LegacyUnavailableProviderDescriptorView {
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

const PRIVATE_MIGRATION_PLAN_KEYS = [
	"schemaVersion",
	"migrationId",
	"sourceKind",
	"sourceSchemaVersion",
	"targetSchemaVersion",
	"sourceFingerprint",
	"resultFingerprint",
	"status",
	"source",
	"result",
] as const;

function validatePrivateMigrationPlan<TResult>(plan: PrivateMigrationPlan<TResult>): void {
	if (
		!isRecord(plan) ||
		!hasExactRequiredKeys(plan, PRIVATE_MIGRATION_PLAN_KEYS) ||
		plan.schemaVersion !== 1 ||
		typeof plan.migrationId !== "string" ||
		!/^migration:[a-z][a-z0-9.-]{0,63}:[a-f0-9]{64}$/u.test(plan.migrationId) ||
		typeof plan.sourceKind !== "string" ||
		plan.sourceKind.length === 0 ||
		!isNonNegativeSafeInteger(plan.sourceSchemaVersion) ||
		!isNonNegativeSafeInteger(plan.targetSchemaVersion) ||
		!isFingerprint(plan.sourceFingerprint) ||
		!isFingerprint(plan.resultFingerprint) ||
		plan.status !== "applied"
	) {
		throw new PrivateMigrationError("Migration plan has an invalid exact shape");
	}
	let sourceFingerprint: Fingerprint;
	let resultFingerprint: Fingerprint;
	try {
		sourceFingerprint = fingerprintFoundationValue(plan.source);
		resultFingerprint = fingerprintFoundationValue(plan.result);
	} catch {
		throw new PrivateMigrationError("Migration plan source or result is not canonical JSON");
	}
	if (
		sourceFingerprint.algorithm !== plan.sourceFingerprint.algorithm ||
		sourceFingerprint.value !== plan.sourceFingerprint.value ||
		resultFingerprint.algorithm !== plan.resultFingerprint.algorithm ||
		resultFingerprint.value !== plan.resultFingerprint.value
	) {
		throw new PrivateMigrationError("Migration plan fingerprints do not match its source or result");
	}
}

function markerFromPlan<TResult>(plan: PrivateMigrationPlan<TResult>): MigrationAppliedMarker {
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

function decodeMigrationMarker(value: unknown): MigrationAppliedMarker {
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
	return value as unknown as MigrationAppliedMarker;
}

function markersEqual(left: MigrationAppliedMarker, right: MigrationAppliedMarker): boolean {
	return canonicalFoundationJson(left) === canonicalFoundationJson(right);
}

export function createPrivateMigrationId(migrationName: string, sourceIdentity: unknown): string {
	if (!/^[a-z][a-z0-9.-]{0,63}$/u.test(migrationName)) {
		throw new PrivateMigrationError("Migration name is invalid");
	}
	return `migration:${migrationName}:${fingerprintFoundationValue(sourceIdentity).value}`;
}

export function createPrivateMigrationPlan<TResult>(input: {
	readonly migrationName: string;
	readonly sourceIdentity: unknown;
	readonly sourceKind: string;
	readonly sourceSchemaVersion: number;
	readonly targetSchemaVersion: number;
	readonly source: unknown;
	readonly result: TResult;
}): PrivateMigrationPlan<TResult> {
	if (
		typeof input.sourceKind !== "string" ||
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
		migrationId: createPrivateMigrationId(input.migrationName, input.sourceIdentity),
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
export async function runPrivateMigration<TResult>(
	ledger: SessionLedger,
	plan: PrivateMigrationPlan<TResult>,
): Promise<PrivateMigrationRunResult<TResult>> {
	validatePrivateMigrationPlan(plan);
	const expectedMarker = markerFromPlan(plan);
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

	try {
		const appended = await ledger.appendFact(MIGRATION_MARKER_OBJECT_TYPE, plan.migrationId, expectedMarker, {
			clientRequestId: `migration:${plan.migrationId}`,
			expectedRevision: 0,
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
		const raced = await ledger.get(MIGRATION_MARKER_OBJECT_TYPE, plan.migrationId);
		if (raced !== undefined) {
			if (raced.kind !== "fact") {
				throw new PrivateMigrationError("migration.applied identity is occupied by a non-fact record");
			}
			const marker = decodeMigrationMarker(raced.payload);
			if (!markersEqual(marker, expectedMarker)) {
				throw new PrivateMigrationError("migration.applied marker conflicts with the requested migration");
			}
			return { status: "replayed", marker, result: cloneCanonical(plan.result, "Migration result") };
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

function compatibilityView(entry: SessionEntry): LegacySessionCompatibilityView | undefined {
	if (entry.type !== "custom") return undefined;
	if (!entry.customType.startsWith(FOUNDATION_CUSTOM_PREFIX)) return undefined;
	const decoded = decodeReservedFoundationCompatibilityWrapper(entry.customType, entry.data);
	return {
		entryId: entry.id,
		kind: decoded.kind,
		value: decoded.value,
	};
}

/** Decode and deterministically apply the existing Session v1 -> v2 -> v3 rules. */
export function migrateLegacySessionEntries(source: readonly unknown[]): LegacySessionEntryMigrationResult {
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
	const validatedEntries = migratedEntries.map((entry) => decodeCurrentSessionEntry(entry));
	const compatibilityViews = validatedEntries
		.map(compatibilityView)
		.filter((view): view is LegacySessionCompatibilityView => view !== undefined);
	return {
		schemaVersion: 1,
		sessionVersion: CURRENT_HISTORICAL_SESSION_VERSION,
		entries: cloneCanonical([header, ...validatedEntries], "Migrated Session entries") as FileEntry[],
		compatibilityViews,
	};
}

/** Create a marker-ready plan for one physical Session file identity. */
export function planLegacySessionEntryMigrationV1(source: readonly unknown[]): PrivateMigrationPlan<LegacySessionEntryMigrationResult> {
	const result = migrateLegacySessionEntries(source);
	const header = result.entries[0];
	if (header === undefined || header.type !== "session") throw new PrivateMigrationError("Migrated Session header is missing");
	return createPrivateMigrationPlan({
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
export function decodeLegacyUnavailableProviderDescriptorV1(value: unknown): LegacyUnavailableProviderDescriptorView {
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
		value.revision !== 1 ||
		value.implementedInThisLine !== false ||
		!isRecord(value.descriptor) ||
		!hasExactRequiredKeys(value.descriptor, ["schemaVersion", "providerId", "providerClass"]) ||
		value.descriptor.schemaVersion !== 1 ||
		value.descriptor.providerId !== `connector.${providerKind}` ||
		value.descriptor.providerClass !== "agent" ||
		!isRecord(value.capabilities) ||
		!hasExactRequiredKeys(value.capabilities, [
			"resumeSupported",
			"mailboxSupported",
			"backgroundSupported",
			"worktreeSupported",
			"maxDepth",
		]) ||
		value.capabilities.resumeSupported !== false ||
		value.capabilities.mailboxSupported !== false ||
		value.capabilities.backgroundSupported !== false ||
		value.capabilities.worktreeSupported !== false ||
		value.capabilities.maxDepth !== 1
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
export type HistoricalFoundationRecord = FoundationRecord;
/** Type-only guard to document that compatibility wrappers remain Session views. */
export type HistoricalSessionEntry = SessionEntry;
