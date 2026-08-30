import { uuidv7 } from "@aos-agent/ai";
import {
	assertJsonSerializable,
	type AgentMessage,
	type BranchBounds,
	type AcquireWriterLeaseOptions,
	type AppendFoundationRecordResult,
	type DurableLedgerApi,
	type Entry,
	type EntryQuery,
	type EntryOrder,
	type LanePointer,
	type LedgerWriterLease,
	type LaneRecord,
	type LogItem,
	type LogOptions,
	type NewRecord,
	type OperationStartedRecord,
	type ProvisionedEntry,
	type ProvisionedFoundationRecord,
	type RecordQuery,
	type ReleaseWriterLeaseOptions,
	type RenewWriterLeaseOptions,
	SessionError,
	type Session,
	type SessionMetadata,
	type SessionStats,
	type SessionStorage,
	FoundationLedgerState,
	FOUNDATION_TOOL_RESULT_CUSTOM_TYPE,
	type FoundationObjectResult,
	type FoundationRecordQuery,
	type FoundationRecord,
	type FoundationRetentionPolicy,
	type SetRetentionPolicyOptions,
	validateFoundationToolResultEntry,
} from "@aos-agent/agent-core";
import type {
	CustomMessageEntry,
	LabelEntry,
	SessionEntry,
	SessionHeader,
	SessionInfoEntry,
} from "./manager.ts";
import { registerSessionReadProjectionInitializer, type SessionManager } from "./manager.ts";
import { createCustomMessage } from "../messages.ts";

/** Reserved custom-entry types used to store canonical Harness state in the existing JSONL file. */
export const FOUNDATION_ENTRY_CUSTOM_TYPE = "__aos.foundation.entry.v1";
export const FOUNDATION_RECORD_CUSTOM_TYPE = "__aos.foundation.record.v1";
export const FOUNDATION_LANE_CUSTOM_TYPE = "__aos.foundation.lane.v1";
export const FOUNDATION_FACT_CUSTOM_TYPE = "__aos.foundation.fact.v1";
export const FOUNDATION_DURABLE_CUSTOM_TYPE = "__aos.foundation.durable.v1";

export interface HarnessCompatibilityWriter {
	recordMessage(message: AgentMessage): void | Promise<void>;
	recordCustomEntry(customType: string, data?: unknown): string;
	setSessionName(name: string | undefined): void;
	setSessionLabel(targetId: string, label: string | undefined): void;
}

const FOUNDATION_CUSTOM_PREFIX = "__aos.foundation.";
const FOUNDATION_SCHEMA_VERSION = 1;

/** Normalize the legacy session title before it enters the canonical ledger. */
export function normalizeSessionName(name: string | undefined): string | undefined {
	if (name === undefined) return undefined;
	const normalized = name.replace(/[\r\n]+/g, " ").trim();
	return normalized.length === 0 ? undefined : normalized;
}

export interface CodingAgentSessionMetadata extends SessionMetadata {
	cwd: string;
	path?: string;
	legacyVersion: 3;
}

interface FoundationEntryEnvelope {
	schemaVersion: 1;
	kind: "entry";
	entry: Entry;
}

interface FoundationRecordEnvelope {
	schemaVersion: 1;
	kind: "record";
	record: LaneRecord;
}

interface FoundationLaneEnvelope {
	schemaVersion: 1;
	kind: "lane";
	lane: string;
	leafId: string | null;
}

interface FoundationNameFactEnvelope {
	schemaVersion: 1;
	kind: "name";
	name: string | undefined;
}

interface FoundationLabelFactEnvelope {
	schemaVersion: 1;
	kind: "label";
	targetId: string;
	label: string | undefined;
}

interface FoundationDurableEnvelope {
	schemaVersion: 1;
	kind: "durable";
	record: FoundationRecord;
}

type FoundationEnvelope =
	| FoundationEntryEnvelope
	| FoundationRecordEnvelope
	| FoundationLaneEnvelope
	| FoundationNameFactEnvelope
	| FoundationLabelFactEnvelope
	| FoundationDurableEnvelope;

interface Snapshot {
	entries: Entry[];
	records: LaneRecord[];
	lanes: LanePointer[];
	log: LogItem[];
	name: string | undefined;
	labels: Map<string, string>;
	stats: SessionStats;
	nextSeq: number;
	ids: Set<string>;
}

interface ParsedFoundationEntry {
	kind: "entry";
	physical: SessionEntry;
	entry: Entry;
}

interface ParsedFoundationRecord {
	kind: "record";
	physical: SessionEntry;
	record: LaneRecord;
}

interface ParsedFoundationLane {
	kind: "lane";
	physical: SessionEntry;
	lane: LanePointer;
}

interface ParsedFoundationFact {
	kind: "name" | "label";
	physical: SessionEntry;
	fact: FoundationNameFactEnvelope | FoundationLabelFactEnvelope;
}

interface ParsedFoundationDurable {
	kind: "durable";
	physical: SessionEntry;
	record: FoundationRecord;
}

type ParsedFoundation =
	| ParsedFoundationEntry
	| ParsedFoundationRecord
	| ParsedFoundationLane
	| ParsedFoundationFact
	| ParsedFoundationDurable;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
	return typeof value === "string";
}

function isNullableString(value: unknown): value is string | null {
	return value === null || typeof value === "string";
}

function isInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value);
}

function isEntryType(value: unknown): value is Entry["type"] {
	return (
		value === "message" ||
		value === "model_change" ||
		value === "thinking_level_change" ||
		value === "active_tools_change" ||
		value === "compaction" ||
		value === "branch_summary" ||
		value === "custom"
	);
}

function isRecordType(value: unknown): value is LaneRecord["type"] {
	return (
		value === "operation_started" ||
		value === "abort_requested" ||
		value === "operation_finished" ||
		value === "step_attempt" ||
		value === "tool_started" ||
		value === "queue_enqueued" ||
		value === "queue_cancelled" ||
		value === "write_deferred" ||
		value === "usage"
	);
}

function toTimestamp(value: string | undefined, fallback: number): number {
	if (value === undefined) return fallback;
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) ? timestamp : fallback;
}

function clone<TValue>(value: TValue): TValue {
	return structuredClone(value);
}

function normalizeLegacyMessage(message: AgentMessage): AgentMessage {
	const visit = (value: unknown): unknown => {
		if (Array.isArray(value)) {
			if (value.some((item) => item === undefined)) failClosed("legacy message contains undefined in an array");
			return value.map(visit);
		}
		if (value === null || typeof value !== "object") return value;
		if (Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length > 0) {
			failClosed("legacy message contains a non-standard object");
		}
		const normalized: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value)) {
			if (item !== undefined) normalized[key] = visit(item);
		}
		return normalized;
	};
	const normalized = visit(message);
	assertJsonSerializable(normalized);
	return normalized as AgentMessage;
}

function failClosed(message: string): never {
	throw new SessionError("invalid_entry", `Foundation session recovery rejected the durable log: ${message}`);
}

function assertProvisionedEntry(entry: Entry): void {
	if (!isEntryType(entry.type) || !isString(entry.id) || !isInteger(entry.seq) || !isInteger(entry.timestamp)) {
		failClosed("invalid canonical entry envelope");
	}
	if (!isNullableString(entry.parentId)) failClosed(`entry ${entry.id} has an invalid parentId`);
	try {
		assertJsonSerializable(entry);
	} catch (error) {
		failClosed(error instanceof Error ? error.message : String(error));
	}
}

function assertDurableRecord(record: LaneRecord): void {
	if (!isRecordType(record.type) || !isString(record.id) || !isString(record.lane) || !isInteger(record.seq) || !isInteger(record.timestamp)) {
		failClosed("invalid canonical record envelope");
	}
	try {
		assertJsonSerializable(record);
	} catch (error) {
		failClosed(error instanceof Error ? error.message : String(error));
	}
}

function parseFoundationEnvelope(physical: SessionEntry): ParsedFoundation | undefined {
	if (physical.type !== "custom" || !physical.customType.startsWith(FOUNDATION_CUSTOM_PREFIX)) return undefined;
	if (
		physical.customType !== FOUNDATION_ENTRY_CUSTOM_TYPE &&
		physical.customType !== FOUNDATION_RECORD_CUSTOM_TYPE &&
		physical.customType !== FOUNDATION_LANE_CUSTOM_TYPE &&
		physical.customType !== FOUNDATION_FACT_CUSTOM_TYPE &&
		physical.customType !== FOUNDATION_DURABLE_CUSTOM_TYPE
	) {
		failClosed(`unknown durable custom type ${physical.customType}`);
	}
	if (!isRecord(physical.data) || physical.data.schemaVersion !== FOUNDATION_SCHEMA_VERSION || !isString(physical.data.kind)) {
		failClosed(`invalid payload for ${physical.customType}`);
	}
	const data = physical.data;
	if (physical.customType === FOUNDATION_ENTRY_CUSTOM_TYPE) {
		if (data.kind !== "entry" || !isRecord(data.entry)) failClosed("invalid canonical entry payload");
		const entry = data.entry as unknown as Entry;
		assertProvisionedEntry(entry);
		return { kind: "entry", physical, entry: clone(entry) };
	}
	if (physical.customType === FOUNDATION_RECORD_CUSTOM_TYPE) {
		if (data.kind !== "record" || !isRecord(data.record)) failClosed("invalid canonical record payload");
		const record = data.record as unknown as LaneRecord;
		assertDurableRecord(record);
		return { kind: "record", physical, record: clone(record) };
	}
	if (physical.customType === FOUNDATION_LANE_CUSTOM_TYPE) {
		if (data.kind !== "lane" || !isString(data.lane) || !isNullableString(data.leafId)) {
			failClosed("invalid canonical lane payload");
		}
		return { kind: "lane", physical, lane: { lane: data.lane, leafId: data.leafId } };
	}
	if (physical.customType === FOUNDATION_DURABLE_CUSTOM_TYPE) {
		if (data.kind !== "durable" || !isRecord(data.record)) failClosed("invalid Foundation durable record payload");
		try {
			assertJsonSerializable(data.record);
		} catch (error) {
			failClosed(error instanceof Error ? error.message : String(error));
		}
		return { kind: "durable", physical, record: clone(data.record) as unknown as FoundationRecord };
	}
	if (
		(data.kind !== "name" && data.kind !== "label") ||
		(data.kind === "label" && !isString(data.targetId)) ||
		(data.kind === "name" && data.name !== undefined && !isString(data.name)) ||
		(data.kind === "label" && data.label !== undefined && !isString(data.label))
	) {
		failClosed("invalid canonical fact payload");
	}
	return {
		kind: data.kind,
		physical,
		fact: data.kind === "name"
			? { schemaVersion: 1, kind: "name", name: data.name as string | undefined }
			: {
					schemaVersion: 1,
					kind: "label",
					targetId: data.targetId as string,
					label: data.label as string | undefined,
				},
	};
}

function legacyEntryType(value: SessionEntry): value is Exclude<SessionEntry, SessionHeader | LabelEntry | SessionInfoEntry | CustomMessageEntry> {
	return (
		value.type === "message" ||
		value.type === "thinking_level_change" ||
		value.type === "model_change" ||
		value.type === "compaction" ||
		value.type === "branch_summary" ||
		value.type === "custom"
	);
}

function legacyCustomMessageToCanonical(value: CustomMessageEntry, seq: number, parentId: string | null): Entry {
	return {
		type: "message",
		id: value.id,
		seq,
		parentId,
		timestamp: toTimestamp(value.timestamp, seq),
		message: createCustomMessage(value.customType, value.content, value.display, value.details, value.timestamp),
	};
}

function legacyEntryToCanonical(value: SessionEntry, seq: number, parentId: string | null): Entry | undefined {
	if (!legacyEntryType(value)) return undefined;
	const timestamp = toTimestamp(value.timestamp, seq);
	if (value.type === "message") {
		const entry: Entry = {
			type: "message",
			id: value.id,
			seq,
			parentId,
			timestamp,
			message: normalizeLegacyMessage(value.message),
		};
		return entry;
	}
	if (value.type === "thinking_level_change") {
		return { type: "thinking_level_change", id: value.id, seq, parentId, timestamp, thinkingLevel: value.thinkingLevel };
	}
	if (value.type === "model_change") {
		return { type: "model_change", id: value.id, seq, parentId, timestamp, provider: value.provider, modelId: value.modelId };
	}
	if (value.type === "compaction") {
		const retainedTail = isRecord(value.details) && Array.isArray(value.details.foundationRetainedTail)
			? clone(value.details.foundationRetainedTail) as AgentMessage[]
			: [];
		return {
			type: "compaction",
			id: value.id,
			seq,
			parentId,
			timestamp,
			summary: value.summary,
			retainedTail: retainedTail,
			tokensBefore: value.tokensBefore,
			...(value.firstKeptEntryId === undefined ? {} : { firstKeptEntryId: value.firstKeptEntryId }),
			...(value.details === undefined ? {} : { details: value.details }),
			...(value.usage === undefined ? {} : { usage: value.usage }),
		};
	}
	if (value.type === "branch_summary") {
		return {
			type: "branch_summary",
			id: value.id,
			seq,
			parentId,
			timestamp,
			fromId: value.fromId,
			summary: value.summary,
			...(value.details === undefined ? {} : { details: clone(value.details) }),
			...(value.usage === undefined ? {} : { usage: clone(value.usage) }),
			...(value.fromHook === true ? { fromExtension: true } : {}),
		};
	}
	return {
		type: "custom",
		id: value.id,
		seq,
		parentId,
		timestamp,
		customType: value.customType,
		data: value.data,
	};
}

function compareSeq(left: { seq: number }, right: { seq: number }): number {
	return left.seq - right.seq;
}

function ordered<T extends { seq: number }>(items: readonly T[], order: EntryOrder | undefined): T[] {
	const sorted = [...items].sort(compareSeq);
	return order === "oldestFirst" ? sorted : sorted.reverse();
}

function validLimit(limit: number | undefined): void {
	if (limit !== undefined && (!Number.isSafeInteger(limit) || limit <= 0)) {
		throw new SessionError("invalid_query", "limit must be a positive integer");
	}
}

function validCursor(afterSeq: number | undefined): void {
	if (afterSeq !== undefined && (!Number.isSafeInteger(afterSeq) || afterSeq < 0)) {
		throw new SessionError("invalid_query", "cursor sequence must be a non-negative integer");
	}
}

function usageStats(records: readonly LaneRecord[]): SessionStats {
	const stats: SessionStats = {
		messageCount: 0,
		cachedTokens: 0,
		uncachedTokens: 0,
		totalTokens: 0,
		costTotal: 0,
	};
	for (const record of records) {
		if (record.type !== "usage") continue;
		stats.cachedTokens += record.usage.cacheRead;
		stats.uncachedTokens += record.usage.input + record.usage.cacheWrite;
		stats.totalTokens += record.usage.totalTokens;
		stats.costTotal += record.usage.cost.total;
	}
	return stats;
}

function makeMetadata(manager: SessionManager): CodingAgentSessionMetadata {
	const header = manager.getHeader();
	if (!header) failClosed("session header is missing");
	return {
		id: header.id,
		createdAt: toTimestamp(header.timestamp, 0),
		...(header.parentSession === undefined ? {} : { parentSessionId: header.parentSession }),
		cwd: header.cwd,
		...(manager.getSessionFile() === undefined ? {} : { path: manager.getSessionFile() }),
		legacyVersion: 3,
	};
}

/**
 * A typed SessionStorage facade over the coding-agent JSONL writer.
 *
 * Foundation entries and records are stored as reserved custom entries in the
 * existing file. This keeps one physical ledger and one writer lock while the
 * canonical Harness owns the logical tree, queues, operations, and recovery.
 */
export class SessionManagerStorage implements SessionStorage<CodingAgentSessionMetadata>, DurableLedgerApi {
	private readonly manager: SessionManager;
	private readonly metadata: CodingAgentSessionMetadata;
	private readonly tail: { promise: Promise<void> } = { promise: Promise.resolve() };
	private ledgerLease: LedgerWriterLease | null = null;
	private ledgerLeaseRevision = 0;

	constructor(manager: SessionManager) {
		this.manager = manager;
		this.metadata = makeMetadata(manager);
		this.snapshot();
		this.manager.setEntriesReadProjection(
			() => this.legacyEntriesSnapshot(),
			() => this.legacyLeafIdSnapshot(),
			() => this.snapshot().lanes.find((lane) => lane.lane === "main")?.leafId ?? null,
			() => new Map(this.snapshot().lanes.map((lane) => [lane.lane, lane.leafId])),
		);
	}

	/**
	 * Synchronous read projections for UI compatibility code. These recompute
	 * from the physical JSONL entries on every call; they are not a second
	 * transcript cache or a mutable runtime authority.
	 */
	getEntriesSnapshot(): Entry[] {
		return clone(this.snapshot().entries);
	}

	getRecordsSnapshot(): LaneRecord[] {
		return clone(this.snapshot().records);
	}

	getLanesSnapshot(): LanePointer[] {
		return clone(this.snapshot().lanes);
	}

	/** Internal physical audit source; never exposed through AgentSession.sessionRead. */
	getAuditEntriesSnapshot(): SessionEntry[] {
		return clone(this.physicalEntries());
	}

	/** Wait until every write accepted by this storage instance has settled. */
	drain(): Promise<void> {
		return this.tail.promise;
	}

	private enqueue<TValue>(operation: () => TValue | Promise<TValue>): Promise<TValue> {
		const result = this.tail.promise.then(operation);
		this.tail.promise = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	private physicalEntries(): SessionEntry[] {
		return this.manager.getPhysicalEntries();
	}

	/**
	 * Derived view for mature coding-agent readers. The durable source remains
	 * the Foundation wrapper log; this projection only restores the legacy
	 * message/entry shape for callers that still inspect SessionManager.
	 */
	private legacyEntriesSnapshot(): SessionEntry[] {
		const physical = this.physicalEntries();
		const byPhysicalId = new Map(physical.map((entry) => [entry.id, entry]));
		const visibleByPhysicalId = new Map<string, Entry>();
		const canonicalById = new Map<string, Entry>();
		const visibleCanonicalIds = new Set<string>();
		const projected: SessionEntry[] = [];
		for (let index = 0; index < physical.length; index += 1) {
			const physicalEntry = physical[index]!;
			const foundation = parseFoundationEnvelope(physicalEntry);
			if (foundation?.kind === "durable") continue;
			if (foundation?.kind === "entry") {
				const parentId = this.resolveVisibleCanonicalParent(
					foundation.entry.parentId,
					canonicalById,
					visibleCanonicalIds,
				);
				const entry = foundation.entry.parentId === parentId
					? foundation.entry
					: { ...foundation.entry, parentId };
				canonicalById.set(entry.id, entry);
				if (foundation.entry.type === "active_tools_change") continue;
				visibleByPhysicalId.set(physicalEntry.id, entry);
				visibleCanonicalIds.add(entry.id);
				const timestamp = new Date(entry.timestamp).toISOString();
				switch (entry.type) {
					case "message":
						projected.push({ type: "message", id: entry.id, parentId: entry.parentId, timestamp, message: clone(entry.message) });
						break;
					case "model_change":
						projected.push({ type: "model_change", id: entry.id, parentId: entry.parentId, timestamp, provider: entry.provider, modelId: entry.modelId });
						break;
					case "thinking_level_change":
						projected.push({ type: "thinking_level_change", id: entry.id, parentId: entry.parentId, timestamp, thinkingLevel: entry.thinkingLevel });
						break;
					case "compaction":
						projected.push({
							type: "compaction",
							id: entry.id,
							parentId: entry.parentId,
							timestamp,
							summary: entry.summary,
							firstKeptEntryId: entry.firstKeptEntryId ?? entry.id,
							tokensBefore: entry.tokensBefore,
							...(entry.details === undefined ? {} : { details: clone(entry.details) }),
							...(entry.usage === undefined ? {} : { usage: clone(entry.usage) }),
							...(entry.fromExtension === true ? { fromHook: true } : {}),
						});
						break;
					case "branch_summary":
						projected.push({
							type: "branch_summary",
							id: entry.id,
							parentId: entry.parentId,
							timestamp,
							fromId: entry.fromId,
							summary: entry.summary,
							...(entry.details === undefined ? {} : { details: clone(entry.details) }),
							...(entry.usage === undefined ? {} : { usage: clone(entry.usage) }),
							...(entry.fromExtension === true ? { fromHook: true } : {}),
						});
						break;
					case "custom": {
						if (entry.customType === FOUNDATION_TOOL_RESULT_CUSTOM_TYPE) {
							const checked = validateFoundationToolResultEntry(entry.data);
							if (checked.ok && checked.value.result.content.every((content) => content.type === "text")) {
								projected.push({
									type: "message",
									id: entry.id,
									parentId: entry.parentId,
									timestamp,
									message: {
										role: "toolResult",
										toolCallId: checked.value.toolCallId,
										toolName: checked.value.toolName,
										content: checked.value.result.content.map((content) => ({ type: "text" as const, text: content.text })),
										...(checked.value.result.details === undefined ? {} : { details: clone(checked.value.result.details) }),
										...(checked.value.result.usage === undefined ? {} : { usage: clone(checked.value.result.usage) }),
										isError: checked.value.isError,
										timestamp: entry.timestamp,
									},
								});
								break;
							}
						}
						projected.push({ type: "custom", id: entry.id, parentId: entry.parentId, timestamp, customType: entry.customType, data: clone(entry.data) });
						break;
					}
				}
				continue;
			}
			if (foundation?.kind === "name" && foundation.fact.kind === "name") {
				projected.push({
					type: "session_info",
					id: physicalEntry.id,
					parentId: this.resolveVisibleParent(physicalEntry.parentId ?? null, byPhysicalId, visibleByPhysicalId),
					timestamp: physicalEntry.timestamp,
					name: foundation.fact.name,
				});
				continue;
			}
			if (foundation !== undefined) continue;
			const parentId = this.resolveVisibleParent(physicalEntry.parentId ?? null, byPhysicalId, visibleByPhysicalId);
			if (physicalEntry.type === "custom_message") {
				const customMessage = clone(physicalEntry);
				customMessage.parentId = parentId;
				projected.push(customMessage);
				const canonical = legacyCustomMessageToCanonical(physicalEntry, index + 1, parentId);
				visibleByPhysicalId.set(physicalEntry.id, canonical);
				canonicalById.set(canonical.id, canonical);
				visibleCanonicalIds.add(canonical.id);
				continue;
			}
			const entry = legacyEntryToCanonical(physicalEntry, index + 1, parentId);
			if (entry !== undefined) {
				visibleByPhysicalId.set(physicalEntry.id, entry);
				canonicalById.set(entry.id, entry);
				visibleCanonicalIds.add(entry.id);
				const timestamp = new Date(entry.timestamp).toISOString();
				if (entry.type === "message") projected.push({ type: "message", id: entry.id, parentId: entry.parentId, timestamp, message: clone(entry.message) });
				else if (entry.type === "custom") projected.push({ type: "custom", id: entry.id, parentId: entry.parentId, timestamp, customType: entry.customType, data: clone(entry.data) });
				else if (entry.type === "model_change") projected.push({ type: "model_change", id: entry.id, parentId: entry.parentId, timestamp, provider: entry.provider, modelId: entry.modelId });
				else if (entry.type === "thinking_level_change") projected.push({ type: "thinking_level_change", id: entry.id, parentId: entry.parentId, timestamp, thinkingLevel: entry.thinkingLevel });
				else if (entry.type === "compaction") projected.push({ type: "compaction", id: entry.id, parentId: entry.parentId, timestamp, summary: entry.summary, firstKeptEntryId: entry.firstKeptEntryId ?? entry.id, tokensBefore: entry.tokensBefore, ...(entry.details === undefined ? {} : { details: clone(entry.details) }), ...(entry.usage === undefined ? {} : { usage: clone(entry.usage) }), ...(entry.fromExtension === true ? { fromHook: true } : {}) });
				else if (entry.type === "branch_summary") projected.push({ type: "branch_summary", id: entry.id, parentId: entry.parentId, timestamp, fromId: entry.fromId, summary: entry.summary, ...(entry.details === undefined ? {} : { details: clone(entry.details) }), ...(entry.usage === undefined ? {} : { usage: clone(entry.usage) }) });
				continue;
			}
			if (physicalEntry.type === "label" || physicalEntry.type === "session_info") {
				projected.push({ ...clone(physicalEntry), parentId } as SessionEntry);
			}
		}
		return projected;
	}

	private legacyLeafIdSnapshot(): string | null {
		const snapshot = this.snapshot();
		let leafId = snapshot.lanes.find((lane) => lane.lane === "main")?.leafId ?? null;
		if (leafId === null) return null;
		const projectedIds = new Set(this.legacyEntriesSnapshot()
			.filter((entry) => entry.type !== "custom" || !entry.customType.startsWith("harness.config."))
			.map((entry) => entry.id));
		const byId = new Map(snapshot.entries.map((entry) => [entry.id, entry]));
		const visited = new Set<string>();
		while (leafId !== null && !projectedIds.has(leafId)) {
			if (visited.has(leafId)) failClosed(`canonical main lane contains a cycle at ${leafId}`);
			visited.add(leafId);
			leafId = byId.get(leafId)?.parentId ?? null;
		}
		return leafId;
	}

	private snapshot(): Snapshot {
		const physical = this.physicalEntries();
		const byPhysicalId = new Map(physical.map((entry) => [entry.id, entry]));
		const visibleByPhysicalId = new Map<string, Entry>();
		const entries: Entry[] = [];
		const records: LaneRecord[] = [];
		const laneFacts: ParsedFoundationLane[] = [];
		const facts: ParsedFoundationFact[] = [];
		const log: LogItem[] = [];
		const ids = new Set<string>();

		for (let index = 0; index < physical.length; index += 1) {
			const physicalEntry = physical[index]!;
			const seq = index + 1;
			ids.add(physicalEntry.id);
			const foundation = parseFoundationEnvelope(physicalEntry);
			if (foundation && foundation.kind === "entry") {
				ids.add(foundation.entry.id);
				if (foundation.entry.seq !== seq) failClosed(`entry ${foundation.entry.id} has a non-consecutive sequence`);
				visibleByPhysicalId.set(physicalEntry.id, foundation.entry);
				entries.push(clone(foundation.entry));
				log.push({ kind: "entry", seq, entry: clone(foundation.entry) });
				continue;
			}
			if (foundation && foundation.kind === "record") {
				ids.add(foundation.record.id);
				if (foundation.record.seq !== seq) failClosed(`record ${foundation.record.id} has a non-consecutive sequence`);
				records.push(clone(foundation.record));
				log.push({ kind: "record", seq, record: clone(foundation.record) });
				continue;
			}
			if (foundation && foundation.kind === "lane") {
				laneFacts.push(foundation);
				log.push({ kind: "lane", seq, lane: foundation.lane.lane, leafId: foundation.lane.leafId });
				continue;
			}
			if (foundation && foundation.kind === "durable") {
				if (foundation.record.seq !== seq) failClosed(`Foundation record ${foundation.record.id} has a non-consecutive sequence`);
				ids.add(foundation.record.id);
				log.push({ kind: "foundation", seq, record: clone(foundation.record) });
				continue;
			}
			if (foundation && foundation.kind === "name" || foundation && foundation.kind === "label") {
				facts.push(foundation);
				if (foundation.fact.kind === "name") log.push({ kind: "fact", seq, fact: "name", name: foundation.fact.name });
				else log.push({ kind: "fact", seq, fact: "label", targetId: foundation.fact.targetId, label: foundation.fact.label });
				continue;
			}
			const legacyParentId = physicalEntry.parentId;
			const parentId = this.resolveVisibleParent(legacyParentId, byPhysicalId, visibleByPhysicalId);
			const entry = physicalEntry.type === "custom_message"
				? legacyCustomMessageToCanonical(physicalEntry, seq, parentId)
				: legacyEntryToCanonical(physicalEntry, seq, parentId);
			if (entry) {
				visibleByPhysicalId.set(physicalEntry.id, entry);
				entries.push(entry);
				log.push({ kind: "entry", seq, entry: clone(entry) });
				continue;
			}
			if (physicalEntry.type === "label") {
				const label = physicalEntry as LabelEntry;
				facts.push({
					kind: "label",
					physical: physicalEntry,
					fact: { schemaVersion: 1, kind: "label", targetId: label.targetId, label: label.label },
				});
				log.push({ kind: "fact", seq, fact: "label", targetId: label.targetId, label: label.label });
				continue;
			}
			if (physicalEntry.type === "session_info") {
				const info = physicalEntry as SessionInfoEntry;
				facts.push({
					kind: "name",
					physical: physicalEntry,
					fact: { schemaVersion: 1, kind: "name", name: info.name },
				});
				log.push({ kind: "fact", seq, fact: "name", name: info.name });
				continue;
			}
			failClosed(`unknown legacy durable entry type ${String(physicalEntry.type)}`);
		}

		const entryIds = new Set(entries.map((entry) => entry.id));
		for (const entry of entries) {
			if (entry.parentId !== null && !entryIds.has(entry.parentId)) {
				failClosed(`entry ${entry.id} references missing parent ${entry.parentId}`);
			}
		}
		const latestLanes = new Map<string, LanePointer>();
		const lastEntry = entries.at(-1);
		latestLanes.set("main", { lane: "main", leafId: lastEntry?.id ?? null });
		for (const laneFact of laneFacts) latestLanes.set(laneFact.lane.lane, clone(laneFact.lane));
		for (const record of records) {
			if (!latestLanes.has(record.lane)) failClosed(`record ${record.id} references missing lane ${record.lane}`);
		}
		for (const lane of latestLanes.values()) {
			if (lane.leafId !== null && !entryIds.has(lane.leafId)) failClosed(`lane ${lane.lane} references missing entry ${lane.leafId}`);
		}
		const labels = new Map<string, string>();
		let name: string | undefined;
		for (const fact of facts) {
			if (fact.fact.kind === "name") name = fact.fact.name;
			else if (fact.fact.label === undefined) labels.delete(fact.fact.targetId);
			else labels.set(fact.fact.targetId, fact.fact.label);
		}
		const stats = usageStats(records);
		stats.messageCount = entries.filter((entry) => entry.type === "message").length;
		return {
			entries: entries.sort(compareSeq),
			records: records.sort(compareSeq),
			lanes: [...latestLanes.values()],
			log: log.sort((left, right) => left.seq - right.seq),
			name,
			labels,
			stats,
			nextSeq: physical.length + 1,
			ids,
		};
	}

	private resolveVisibleParent(
		physicalParentId: string | null,
		byPhysicalId: ReadonlyMap<string, SessionEntry>,
		visibleByPhysicalId: ReadonlyMap<string, Entry>,
	): string | null {
		const visited = new Set<string>();
		let current = physicalParentId;
		while (current !== null) {
			if (visited.has(current)) failClosed(`legacy parent chain contains a cycle at ${current}`);
			visited.add(current);
			const visible = visibleByPhysicalId.get(current);
			if (visible) return visible.id;
			current = byPhysicalId.get(current)?.parentId ?? null;
		}
		return null;
	}

	private resolveVisibleCanonicalParent(
		parentId: string | null,
		byId: ReadonlyMap<string, Entry>,
		visibleIds: ReadonlySet<string>,
	): string | null {
		const visited = new Set<string>();
		let current = parentId;
		while (current !== null) {
			if (visited.has(current)) failClosed(`canonical parent chain contains a cycle at ${current}`);
			visited.add(current);
			if (visibleIds.has(current)) return current;
			current = byId.get(current)?.parentId ?? null;
		}
		return null;
	}

	private nextId(snapshot: Snapshot): string {
		let id = uuidv7();
		while (snapshot.ids.has(id)) id = uuidv7();
		return id;
	}

	private appendWrapper(
		snapshot: Snapshot,
		customType: string,
		data: FoundationEnvelope,
		id: string,
	): void {
		assertJsonSerializable(data);
		if (snapshot.ids.has(id)) throw new SessionError("already_exists", `Durable id already exists: ${id}`);
		this.manager.appendCustomEntry(customType, data);
		if (customType === FOUNDATION_DURABLE_CUSTOM_TYPE) this.manager.flushPendingSession();
	}

	private appendCanonicalEntry<TEntry extends Entry>(entry: ProvisionedEntry<TEntry>, lane: string): TEntry {
		const snapshot = this.snapshot();
		const pointer = snapshot.lanes.find((candidate) => candidate.lane === lane);
		if (!pointer) throw new SessionError("invalid_lane", `Lane not found: ${lane}`);
		if (snapshot.ids.has(entry.id)) throw new SessionError("already_exists", `Durable id already exists: ${entry.id}`);
		const assigned = {
			...clone(entry),
			parentId: pointer.leafId,
			seq: snapshot.nextSeq,
			timestamp: Date.now(),
		} as unknown as TEntry;
		this.appendWrapper(snapshot, FOUNDATION_ENTRY_CUSTOM_TYPE, { schemaVersion: 1, kind: "entry", entry: assigned }, assigned.id);
		const laneSnapshot = this.snapshot();
		this.appendWrapper(
			laneSnapshot,
			FOUNDATION_LANE_CUSTOM_TYPE,
			{ schemaVersion: 1, kind: "lane", lane, leafId: assigned.id },
			this.nextId(laneSnapshot),
		);
		if (assigned.type === "message" && assigned.message.role === "assistant") {
			this.manager.flushPendingSession();
		}
		return clone(assigned);
	}

	private async appendCanonicalRecord<TRecord extends LaneRecord>(record: NewRecord<TRecord>): Promise<TRecord> {
		const snapshot = this.snapshot();
		if (!snapshot.lanes.some((lane) => lane.lane === record.lane)) {
			throw new SessionError("invalid_lane", `Lane not found: ${record.lane}`);
		}
		if (snapshot.ids.has(record.id)) throw new SessionError("already_exists", `Durable id already exists: ${record.id}`);
		if (record.type === "operation_started" && snapshot.records.some((candidate) => candidate.lane === record.lane && candidate.type === "operation_started" && !snapshot.records.some((finish) => finish.type === "operation_finished" && finish.runId === candidate.id))) {
			throw new SessionError("storage", `Lane ${record.lane} already has an open operation`);
		}
		const assigned = { ...clone(record), seq: snapshot.nextSeq, timestamp: Date.now() } as unknown as TRecord;
		this.appendWrapper(snapshot, FOUNDATION_RECORD_CUSTOM_TYPE, { schemaVersion: 1, kind: "record", record: assigned }, assigned.id);
		return clone(assigned);
	}

	private foundationState(): FoundationLedgerState {
		const state = new FoundationLedgerState({ sessionId: this.metadata.id });
		const physical = this.physicalEntries();
		for (let index = 0; index < physical.length; index += 1) {
			const seq = index + 1;
			const parsed = parseFoundationEnvelope(physical[index]!);
			if (parsed?.kind === "durable") state.applyPersistedRecord(parsed.record);
			else state.observeExternalSequence(seq);
		}
		state.restoreLease(this.ledgerLease, this.ledgerLeaseRevision);
		return state;
	}

	acquireWriterLease(options: AcquireWriterLeaseOptions): Promise<LedgerWriterLease> {
		return this.enqueue(async () => {
			const lease = this.foundationState().acquireWriterLease(options);
			this.ledgerLease = lease;
			this.ledgerLeaseRevision = lease.leaseRevision;
			return clone(lease);
		});
	}

	renewWriterLease(options: RenewWriterLeaseOptions): Promise<LedgerWriterLease> {
		return this.enqueue(async () => {
			const lease = this.foundationState().renewWriterLease(options);
			this.ledgerLease = lease;
			this.ledgerLeaseRevision = lease.leaseRevision;
			return clone(lease);
		});
	}

	releaseWriterLease(options: ReleaseWriterLeaseOptions): Promise<void> {
		return this.enqueue(async () => {
			this.foundationState().releaseWriterLease(options);
			this.ledgerLease = null;
		});
	}

	getWriterLease(): Promise<LedgerWriterLease | null> {
		return Promise.resolve(this.foundationState().getWriterLease());
	}

	getLedgerRevision(): Promise<number> {
		return Promise.resolve(this.foundationState().getLedgerRevision());
	}

	appendFoundationRecord(record: ProvisionedFoundationRecord): Promise<AppendFoundationRecordResult> {
		return this.enqueue(async () => {
			const state = this.foundationState();
			const result = state.appendFoundationRecord(record);
			if (!result.replayed) {
				const snapshot = this.snapshot();
				this.appendWrapper(snapshot, FOUNDATION_DURABLE_CUSTOM_TYPE, {
					schemaVersion: 1,
					kind: "durable",
					record: result.record,
				}, result.record.id);
			}
			return clone(result);
		});
	}

	setRetentionPolicy(
		policy: FoundationRetentionPolicy,
		options: SetRetentionPolicyOptions,
	): Promise<AppendFoundationRecordResult> {
		return this.enqueue(async () => {
			const result = this.foundationState().setRetentionPolicy(policy, options);
			if (!result.replayed) {
				this.appendWrapper(this.snapshot(), FOUNDATION_DURABLE_CUSTOM_TYPE, {
					schemaVersion: 1,
					kind: "durable",
					record: result.record,
				}, result.record.id);
			}
			return clone(result);
		});
	}

	findFoundationRecords(query?: FoundationRecordQuery): Promise<FoundationRecord[]> {
		return Promise.resolve(this.foundationState().findFoundationRecords(query));
	}

	getFoundationObject(objectType: string, objectId: string): Promise<FoundationObjectResult | undefined> {
		return Promise.resolve(this.foundationState().getFoundationObject(objectType, objectId));
	}

	getFoundationRevision(objectType: string, objectId: string): Promise<number> {
		return Promise.resolve(this.foundationState().getFoundationRevision(objectType, objectId));
	}

	isObjectTombstoned(objectType: string, objectId: string): Promise<boolean> {
		return Promise.resolve(this.foundationState().isObjectTombstoned(objectType, objectId));
	}

	getRetentionPolicy(): Promise<FoundationRetentionPolicy | undefined> {
		return Promise.resolve(this.foundationState().getRetentionPolicy());
	}

	prunableFoundationRecords(): Promise<readonly FoundationRecord[]> {
		return Promise.resolve(this.foundationState().prunableFoundationRecords());
	}

	getMetadata(): Promise<CodingAgentSessionMetadata> {
		return Promise.resolve(clone(this.metadata));
	}

	getLanes(): Promise<LanePointer[]> {
		return Promise.resolve(clone(this.snapshot().lanes));
	}

	createLane(lane: string, at: string | null): Promise<void> {
		return this.enqueue(async () => {
			const snapshot = this.snapshot();
			if (snapshot.lanes.some((candidate) => candidate.lane === lane)) throw new SessionError("already_exists", `Lane already exists: ${lane}`);
			if (at !== null && !snapshot.entries.some((entry) => entry.id === at)) throw new SessionError("not_found", `Entry not found: ${at}`);
			this.appendWrapper(snapshot, FOUNDATION_LANE_CUSTOM_TYPE, { schemaVersion: 1, kind: "lane", lane, leafId: at }, this.nextId(snapshot));
		});
	}

	moveLane(lane: string, to: string | null): Promise<void> {
		return this.enqueue(async () => {
			const snapshot = this.snapshot();
			if (!snapshot.lanes.some((candidate) => candidate.lane === lane)) throw new SessionError("invalid_lane", `Lane not found: ${lane}`);
			if (to !== null && !snapshot.entries.some((entry) => entry.id === to)) throw new SessionError("not_found", `Entry not found: ${to}`);
			this.appendWrapper(snapshot, FOUNDATION_LANE_CUSTOM_TYPE, { schemaVersion: 1, kind: "lane", lane, leafId: to }, this.nextId(snapshot));
		});
	}

	appendEntry<TEntry extends Entry>(entry: ProvisionedEntry<TEntry>, lane: string): Promise<TEntry> {
		return this.enqueue(() => this.appendCanonicalEntry(entry, lane));
	}

	/** Synchronous physical commit for legacy callers whose logical writer is AgentHarness. */
	appendHarnessEntry<TEntry extends Entry>(entry: ProvisionedEntry<TEntry>, lane: string): TEntry {
		return this.appendCanonicalEntry(entry, lane);
	}

	/** Synchronous physical commit for AgentHarness session-name writes. */
	setHarnessName(name: string | undefined): void {
		const snapshot = this.snapshot();
		this.appendWrapper(snapshot, FOUNDATION_FACT_CUSTOM_TYPE, { schemaVersion: 1, kind: "name", name: normalizeSessionName(name) }, this.nextId(snapshot));
	}

	/** Synchronous physical commit for AgentHarness label writes. */
	setHarnessLabel(id: string, label: string | undefined): void {
		this.appendLabelFact(this.snapshot(), id, label);
	}

	appendRecord<TRecord extends LaneRecord>(record: NewRecord<TRecord>): Promise<TRecord> {
		return this.enqueue(() => this.appendCanonicalRecord(record));
	}

	getEntry(id: string): Promise<Entry | undefined> {
		const entry = this.snapshot().entries.find((candidate) => candidate.id === id);
		return Promise.resolve(entry === undefined ? undefined : clone(entry));
	}

	findEntries(query: EntryQuery = {}): Promise<Entry[]> {
		validLimit(query.limit);
		validCursor(query.cursor?.afterSeq);
		let entries = ordered(this.snapshot().entries, query.order);
		entries = entries.filter((entry) => {
			if (query.type !== undefined && entry.type !== query.type) return false;
			if (query.customType !== undefined && (entry.type !== "custom" || entry.customType !== query.customType)) return false;
			if (query.cursor !== undefined) {
				return query.order === "oldestFirst" ? entry.seq > query.cursor.afterSeq : entry.seq < query.cursor.afterSeq;
			}
			return true;
		});
		if (query.limit !== undefined) entries = entries.slice(0, query.limit);
		return Promise.resolve(clone(entries));
	}

	findEntriesOnBranch(query: EntryQuery & BranchBounds & { start: string }): Promise<Entry[]> {
		validLimit(query.limit);
		validCursor(query.cursor?.afterSeq);
		const snapshot = this.snapshot();
		const byId = new Map(snapshot.entries.map((entry) => [entry.id, entry]));
		const path: Entry[] = [];
		const visited = new Set<string>();
		let current = byId.get(query.start);
		if (!current) throw new SessionError("not_found", `Entry not found: ${query.start}`);
		while (current) {
			if (visited.has(current.id)) failClosed(`branch contains a cycle at ${current.id}`);
			visited.add(current.id);
			path.push(current);
			if (current.id === query.stopAtId || current.type === query.stopAtType || current.parentId === null) break;
			current = byId.get(current.parentId);
			if (!current) failClosed(`branch parent is missing for ${path.at(-1)?.id ?? query.start}`);
		}
		let entries = query.order === "oldestFirst" ? path.reverse() : path;
		entries = entries.filter((entry) => {
			if (query.type !== undefined && entry.type !== query.type) return false;
			if (query.customType !== undefined && (entry.type !== "custom" || entry.customType !== query.customType)) return false;
			if (query.cursor !== undefined) return query.order === "oldestFirst" ? entry.seq > query.cursor.afterSeq : entry.seq < query.cursor.afterSeq;
			return true;
		});
		if (query.limit !== undefined) entries = entries.slice(0, query.limit);
		return Promise.resolve(clone(entries));
	}

	findRecords<K extends LaneRecord["type"]>(query: RecordQuery & { type: K }): Promise<Extract<LaneRecord, { type: K }>[]>
	findRecords(query?: RecordQuery): Promise<LaneRecord[]>;
	findRecords(query: RecordQuery = {}): Promise<LaneRecord[]> {
		validLimit(query.limit);
		validCursor(query.afterSeq);
		let records = ordered(this.snapshot().records, query.order).filter((record) => {
			if (query.lane !== undefined && record.lane !== query.lane) return false;
			if (query.type !== undefined && record.type !== query.type) return false;
			if (query.runId !== undefined) {
				const runId = record.type === "operation_started" ? record.id : "runId" in record ? record.runId : undefined;
				if (runId !== query.runId) return false;
			}
			if (query.operationKind !== undefined && (record.type !== "operation_started" || record.intent.kind !== query.operationKind)) return false;
			if (query.afterSeq !== undefined && record.seq <= query.afterSeq) return false;
			return true;
		});
		if (query.limit !== undefined) records = records.slice(0, query.limit);
		return Promise.resolve(clone(records));
	}

	findOpenOperations(lane: string, options?: { limit?: number }): Promise<OperationStartedRecord[]> {
		validLimit(options?.limit);
		const open = new Map<string, OperationStartedRecord>();
		for (const record of this.snapshot().records) {
			if (record.lane !== lane) continue;
			if (record.type === "operation_started") open.set(record.id, record);
			else if (record.type === "operation_finished") open.delete(record.runId);
		}
		const result = [...open.values()].sort(compareSeq).reverse();
		return Promise.resolve(clone(options?.limit === undefined ? result : result.slice(0, options.limit)));
	}

	getLog(options: LogOptions = {}): Promise<LogItem[]> {
		validLimit(options.limit);
		validCursor(options.afterSeq);
		let log = this.snapshot().log.filter((item) => options.afterSeq === undefined || item.seq > options.afterSeq);
		if (options.limit !== undefined) log = log.slice(0, options.limit);
		return Promise.resolve(clone(log));
	}

	getName(): Promise<string | undefined> {
		return Promise.resolve(this.snapshot().name);
	}

	setName(name: string | undefined): Promise<void> {
		return this.enqueue(async () => {
			const snapshot = this.snapshot();
			this.appendWrapper(snapshot, FOUNDATION_FACT_CUSTOM_TYPE, { schemaVersion: 1, kind: "name", name: normalizeSessionName(name) }, this.nextId(snapshot));
		});
	}

	getLabel(id: string): Promise<string | undefined> {
		return Promise.resolve(this.snapshot().labels.get(id));
	}

	setLabel(id: string, label: string | undefined): Promise<void> {
		return this.enqueue(async () => {
			const snapshot = this.snapshot();
			this.appendLabelFact(snapshot, id, label);
		});
	}

	private appendLabelFact(snapshot: Snapshot, id: string, label: string | undefined): void {
		if (!snapshot.entries.some((entry) => entry.id === id)) throw new SessionError("not_found", `Entry not found: ${id}`);
		this.appendWrapper(snapshot, FOUNDATION_FACT_CUSTOM_TYPE, {
			schemaVersion: 1,
			kind: "label",
			targetId: id,
			label,
		}, this.nextId(snapshot));
	}

	getStats(): Promise<SessionStats> {
		return Promise.resolve(clone(this.snapshot().stats));
	}
}

/**
 * Bind void-compatible Harness callbacks to the canonical Session. The
 * compatibility surface never writes legacy physical entries back into the
 * SessionManager store.
 */
export function createHarnessCompatibilityWriter(
	session: Session,
	storage: SessionManagerStorage,
): HarnessCompatibilityWriter {
	return {
		recordMessage: (message) => {
			storage.appendHarnessEntry({ type: "message", id: session.idGenerator.next(), message }, "main");
		},
		recordCustomEntry: (customType, data) => {
			const id = session.idGenerator.next();
			storage.appendHarnessEntry(
				data === undefined ? { type: "custom", id, customType } : { type: "custom", id, customType, data },
				"main",
			);
			return id;
		},
		setSessionName: (name) => {
			storage.setHarnessName(name);
		},
		setSessionLabel: (targetId, label) => {
			storage.setHarnessLabel(targetId, label);
		},
	};
}

export function createSessionManagerStorage(manager: SessionManager): SessionManagerStorage {
	return new SessionManagerStorage(manager);
}

registerSessionReadProjectionInitializer((manager) => {
	new SessionManagerStorage(manager);
});
