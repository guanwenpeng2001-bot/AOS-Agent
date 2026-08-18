import { uuidv7 } from "@aos-agent/ai";
import { canonicalFoundationJson, type ExecutionCorrelationV1, type FoundationJsonValue } from "../../foundation/index.ts";
import {
	DEFAULT_LEDGER_LANE,
	DEFAULT_WRITER_LEASE_TTL_MS,
	foundationIdempotencyKey,
	foundationObjectKey,
	type AcquireWriterLeaseOptionsV1,
	type AppendFoundationRecordResultV1,
	type FoundationFactRecordV1,
	type FoundationIntentRecordV1,
	type FoundationObjectResultV1,
	type FoundationRecordV1,
	type FoundationRecordQueryV1,
	type FoundationRetentionPolicyV1,
	type FoundationRetentionRecordV1,
	type FoundationTombstoneRecordV1,
	type LedgerWriterLeaseV1,
	type ProvisionedFoundationRecordV1,
	type RenewWriterLeaseOptionsV1,
	type ReleaseWriterLeaseOptionsV1,
	type SetRetentionPolicyOptionsV1,
} from "./types.ts";
import { DurableLedgerError, invalidDurableRecord } from "./errors.ts";

export interface FoundationLedgerStateOptions {
	sessionId: string;
	laneId?: string;
	clock?: () => number;
}

export interface FoundationForkRecordOptions {
	targetSessionId: string;
	laneIds: ReadonlySet<string>;
	/** Shared sequence already occupied by the copied legacy Session mutations. */
	firstSequence: number;
}

interface IdempotencyRecord {
	fingerprint: string;
	record: FoundationRecordV1;
}

interface PreparedAppend {
	record: FoundationRecordV1;
	fingerprint: string;
	key: string;
}

function clone<T>(value: T): T {
	return structuredClone(value);
}

/**
 * C022 fork semantics for durable records:
 * facts, intents, and tombstones from the selected lanes are copied in their
 * original order. Record/object ids, client request ids, lineage fields, and
 * JSON payloads (including Artifact references) remain stable; only the child
 * Session correlation and shared sequence are rebound. A writer lease and
 * retention policy are destination-local and are deliberately not inherited.
 */
export function prepareForkFoundationRecords(
	records: readonly FoundationRecordV1[],
	options: FoundationForkRecordOptions,
): FoundationRecordV1[] {
	const targetSessionId = requireNonEmptyString(options.targetSessionId, "targetSessionId");
	const firstSequence = requireNonNegativeInteger(options.firstSequence, "firstSequence");
	let sequence = firstSequence;
	const copied: FoundationRecordV1[] = [];
	for (const source of records) {
		if (source.kind === "retention" || !options.laneIds.has(source.lane)) continue;
		sequence += 1;
		copied.push({
			...clone(source),
			seq: sequence,
			correlation: {
				...clone(source.correlation),
				sessionId: targetSessionId,
				fencingToken: source.fencingToken,
			},
		} as FoundationRecordV1);
	}
	return copied;
}

function requireNonEmptyString(value: unknown, field: string): string {
	if (typeof value !== "string" || value.length === 0) throw invalidDurableRecord(`${field} must be a non-empty string`);
	return value;
}

function requireNonNegativeInteger(value: unknown, field: string): number {
	if (!Number.isSafeInteger(value) || (value as number) < 0) {
		throw invalidDurableRecord(`${field} must be a non-negative safe integer`);
	}
	return value as number;
}

function requirePositiveInteger(value: unknown, field: string): number {
	if (!Number.isSafeInteger(value) || (value as number) <= 0) {
		throw invalidDurableRecord(`${field} must be a positive safe integer`);
	}
	return value as number;
}

function foundationJson(value: unknown, field: string): FoundationJsonValue {
	try {
		canonicalFoundationJson(value);
		return value as FoundationJsonValue;
	} catch (error) {
		throw invalidDurableRecord(
			`${field} must be finite, acyclic Foundation JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

function normalizeCorrelation(correlation: Omit<ExecutionCorrelationV1, "revision"> & { revision?: number }, sessionId: string, laneId: string, revision: number, fencingToken: string): ExecutionCorrelationV1 & { fencingToken: string } {
	if (!correlation || typeof correlation !== "object") throw invalidDurableRecord("correlation must be an object");
	if (correlation.sessionId !== sessionId) throw invalidDurableRecord("correlation.sessionId does not match the session");
	if (correlation.laneId !== laneId) throw invalidDurableRecord("correlation.laneId does not match the record lane");
	if (correlation.revision !== undefined && correlation.revision !== 0) {
		throw invalidDurableRecord("correlation.revision is storage-assigned and must be zero or omitted");
	}
	if (correlation.fencingToken !== undefined && correlation.fencingToken !== fencingToken) {
		throw new DurableLedgerError("session_writer_fencing_token", "Correlation fencing token does not match the active lease");
	}
	return { ...clone(correlation), revision, fencingToken };
}

function matchesCorrelation(
	correlation: ExecutionCorrelationV1 & { fencingToken: string },
	query: Partial<ExecutionCorrelationV1>,
): boolean {
	for (const [key, expected] of Object.entries(query) as [keyof ExecutionCorrelationV1, ExecutionCorrelationV1[keyof ExecutionCorrelationV1]][]) {
		if (expected === undefined) continue;
		const actual = correlation[key];
		if (actual === undefined) return false;
		if (canonicalFoundationJson(actual) !== canonicalFoundationJson(expected)) return false;
	}
	return true;
}

function inputFingerprint(input: ProvisionedFoundationRecordV1, _fencingToken: string): string {
	const value = { ...input } as Record<string, unknown>;
	if (value.expectedRevision === undefined) delete value.expectedRevision;
	delete value.fencingToken;
	if (value.correlation !== undefined && typeof value.correlation === "object" && value.correlation !== null) {
		const correlation: Record<string, unknown> = { ...(value.correlation as Record<string, unknown>), revision: 0 };
		delete correlation.fencingToken;
		value.correlation = correlation;
	}
	if (value.kind === "retention") {
		// Retention records do not carry Foundation object coordinates.
		delete value.objectType;
		delete value.objectId;
		delete value.retentionRevision;
	}
	return canonicalFoundationJson(value);
}

function currentRevision(revisions: ReadonlyMap<string, number>, objectType: string, objectId: string): number {
	return revisions.get(foundationObjectKey(objectType, objectId)) ?? 0;
}

/** Deterministic reducer for durable Foundation records. */
export class FoundationLedgerState {
	private readonly sessionId: string;
	private readonly defaultLaneId: string;
	private readonly clock: () => number;
	private sequence = 0;
	private retentionRevision = 0;
	private retentionPolicy: FoundationRetentionPolicyV1 | undefined;
	private leaseRevision = 0;
	private lease: LedgerWriterLeaseV1 | null = null;
	private readonly records: FoundationRecordV1[] = [];
	private readonly recordIds = new Set<string>();
	private readonly revisions = new Map<string, number>();
	private readonly objects = new Map<string, FoundationObjectResultV1>();
	private readonly intents = new Map<string, FoundationIntentRecordV1>();
	private readonly tombstoneIntentIds = new Set<string>();
	private readonly idempotency = new Map<string, IdempotencyRecord>();

	constructor(options: FoundationLedgerStateOptions) {
		this.sessionId = requireNonEmptyString(options.sessionId, "sessionId");
		this.defaultLaneId = requireNonEmptyString(options.laneId ?? DEFAULT_LEDGER_LANE, "laneId");
		this.clock = options.clock ?? Date.now;
	}

	get nextSequence(): number {
		return this.sequence + 1;
	}

	getLedgerRevision(): number {
		return this.sequence;
	}

	/**
	 * FoundationLedgerState reduces Foundation objects, but the enclosing
	 * SessionState owns the physical append-only cursor. This method observes
	 * an Entry/LaneRecord sequence without creating a second ledger sequence.
	 */
	observeExternalSequence(seq: number): void {
		if (!Number.isSafeInteger(seq) || seq !== this.sequence + 1) {
			throw new DurableLedgerError("session_writer_stale_revision", `Shared session sequence ${seq} is not ${this.nextSequence}`, {
				actualRevision: this.sequence,
			});
		}
		this.sequence = seq;
	}

	getRecords(): readonly FoundationRecordV1[] {
		return clone(this.records);
	}

	getWriterLease(): LedgerWriterLeaseV1 | null {
		if (this.lease === null || this.lease.expiresAt <= this.clock()) return null;
		return clone(this.lease);
	}

	getStoredWriterLease(): LedgerWriterLeaseV1 | null {
		return this.lease === null ? null : clone(this.lease);
	}

	getLeaseRevision(): number {
		return this.leaseRevision;
	}

	restoreLease(lease: LedgerWriterLeaseV1 | null, leaseRevision = lease?.leaseRevision ?? this.leaseRevision): void {
		this.lease = lease === null ? null : clone(lease);
		this.leaseRevision = Math.max(this.leaseRevision, leaseRevision);
	}

	acquireWriterLease(options: AcquireWriterLeaseOptionsV1): LedgerWriterLeaseV1 {
		const ownerId = requireNonEmptyString(options.ownerId, "ownerId");
		const ttlMs = this.leaseTtl(options.ttlMs);
		const now = this.clock();
		if (this.lease !== null && this.lease.expiresAt > now) {
			if (this.lease.ownerId !== ownerId) {
				throw new DurableLedgerError("session_writer_busy", `Session writer lease is held by ${this.lease.ownerId}`);
			}
			return clone(this.lease);
		}
		this.leaseRevision += 1;
		this.lease = {
			schemaVersion: 1,
			ownerId,
			leaseRevision: this.leaseRevision,
			fencingToken: `${ownerId}:${this.leaseRevision}:${uuidv7()}`,
			acquiredAt: now,
			expiresAt: now + ttlMs,
		};
		return clone(this.lease);
	}

	renewWriterLease(options: RenewWriterLeaseOptionsV1): LedgerWriterLeaseV1 {
		const lease = this.requireLease(options.fencingToken);
		const ttlMs = this.leaseTtl(options.ttlMs);
		lease.expiresAt = this.clock() + ttlMs;
		return clone(lease);
	}

	releaseWriterLease(options: ReleaseWriterLeaseOptionsV1): void {
		const lease = this.requireLease(options.fencingToken, false);
		lease.expiresAt = 0;
		this.lease = lease;
	}

	assertActiveFence(fencingToken: string): LedgerWriterLeaseV1 {
		return this.requireLease(fencingToken);
	}

	prepareAppend(record: ProvisionedFoundationRecordV1): PreparedAppend | AppendFoundationRecordResultV1 {
		const lease = record.fencingToken === undefined ? this.requireLeaseForAppend() : this.assertActiveFence(record.fencingToken);
		const input = clone(record);
		const key = foundationIdempotencyKey(input.kind, requireNonEmptyString(input.clientRequestId, "clientRequestId"));
		let fingerprint: string;
		try {
			fingerprint = inputFingerprint(input, lease.fencingToken);
		} catch (error) {
			throw invalidDurableRecord(`record is not canonical Foundation JSON: ${error instanceof Error ? error.message : String(error)}`);
		}
		const previous = this.idempotency.get(key);
		if (previous !== undefined) {
			if (previous.fingerprint !== fingerprint) {
				throw new DurableLedgerError("session_writer_duplicate_request", `Client request ${input.clientRequestId} was already accepted with different content`);
			}
			return { record: clone(previous.record), replayed: true };
		}
		const prepared = this.buildRecord(input, lease.fencingToken, fingerprint, key);
		return prepared;
	}

	commitPrepared(prepared: PreparedAppend): FoundationRecordV1 {
		if (prepared.record.seq !== this.nextSequence) {
			throw new DurableLedgerError("session_writer_stale_revision", "Ledger changed before the durable record was committed", {
				actualRevision: this.sequence,
			});
		}
		this.applyRecord(prepared.record, prepared.fingerprint, prepared.key);
		return clone(prepared.record);
	}

	appendFoundationRecord(record: ProvisionedFoundationRecordV1): AppendFoundationRecordResultV1 {
		const prepared = this.prepareAppend(record);
		if ("replayed" in prepared) return prepared;
		return { record: this.commitPrepared(prepared), replayed: false };
	}

	setRetentionPolicy(policy: FoundationRetentionPolicyV1, options: SetRetentionPolicyOptionsV1): AppendFoundationRecordResultV1 {
		return this.appendFoundationRecord({
			schemaVersion: 1,
			kind: "retention",
			id: `retention:${options.clientRequestId}`,
			lane: this.defaultLaneId,
			retentionRevision: this.retentionRevision + 1,
			policy: clone(policy),
			clientRequestId: options.clientRequestId,
			...(options.expectedRevision === undefined ? {} : { expectedRevision: options.expectedRevision }),
			...(options.fencingToken === undefined ? {} : { fencingToken: options.fencingToken }),
			correlation: options.correlation,
		});
	}

	applyPersistedRecord(record: FoundationRecordV1): void {
		this.validatePersistedRecord(record);
		if (record.seq !== this.nextSequence) throw invalidDurableRecord(`record seq ${record.seq} is not ${this.nextSequence}`);
		this.validateRecordTransition(record);
		const fingerprint = inputFingerprint(this.provisionedFromRecord(record), record.fencingToken);
		const key = foundationIdempotencyKey(record.kind, record.clientRequestId);
		if (this.recordIds.has(record.id)) throw invalidDurableRecord(`duplicate durable record id ${record.id}`);
		if (this.idempotency.has(key)) throw invalidDurableRecord(`duplicate client request ${record.clientRequestId}`);
		this.applyRecord(record, fingerprint, key);
	}

	findFoundationRecords(query: FoundationRecordQueryV1 = {}): FoundationRecordV1[] {
		if (query.limit !== undefined && (!Number.isSafeInteger(query.limit) || query.limit <= 0)) {
			throw new DurableLedgerError("session_ledger_invalid_query", "limit must be a positive safe integer");
		}
		if (query.afterSeq !== undefined) requireNonNegativeInteger(query.afterSeq, "afterSeq");
		if (query.beforeSeq !== undefined) requireNonNegativeInteger(query.beforeSeq, "beforeSeq");
		const ordered = query.order === "oldestFirst" ? this.records : [...this.records].reverse();
		const results: FoundationRecordV1[] = [];
		for (const record of ordered) {
			if (query.kind !== undefined && record.kind !== query.kind) continue;
			if (query.objectType !== undefined && (record.kind === "retention" || record.objectType !== query.objectType)) continue;
			if (query.objectId !== undefined && (record.kind === "retention" || record.objectId !== query.objectId)) continue;
			if (query.correlation !== undefined && !matchesCorrelation(record.correlation, query.correlation)) continue;
			if (query.afterSeq !== undefined && record.seq <= query.afterSeq) continue;
			if (query.beforeSeq !== undefined && record.seq >= query.beforeSeq) continue;
			if (!query.includePruned && this.isPruned(record)) continue;
			results.push(clone(record));
			if (query.limit !== undefined && results.length === query.limit) break;
		}
		return results;
	}

	getFoundationObject(objectType: string, objectId: string): FoundationObjectResultV1 | undefined {
		return clone(this.objects.get(foundationObjectKey(requireNonEmptyString(objectType, "objectType"), requireNonEmptyString(objectId, "objectId"))));
	}

	getFoundationRevision(objectType: string, objectId: string): number {
		return currentRevision(this.revisions, requireNonEmptyString(objectType, "objectType"), requireNonEmptyString(objectId, "objectId"));
	}

	isObjectTombstoned(objectType: string, objectId: string): boolean {
		return this.objects.get(foundationObjectKey(objectType, objectId))?.kind === "tombstone";
	}
	getRetentionPolicy(): FoundationRetentionPolicyV1 | undefined {
		return this.retentionPolicy === undefined ? undefined : clone(this.retentionPolicy);
	}

	getRetentionRevision(): number {
		return this.retentionRevision;
	}

	prunableFoundationRecords(): readonly FoundationRecordV1[] {
		return this.records.filter((record) => {
			if (record.kind === "tombstone" || !this.isPruned(record)) return false;
			if (record.kind === "fact" && this.objects.get(foundationObjectKey(record.objectType, record.objectId))?.id === record.id) return false;
			if (record.kind === "retention" && record.retentionRevision === this.retentionRevision) return false;
			if (record.kind === "intent" && this.tombstoneIntentIds.has(record.id)) return false;
			return true;
		}).map(clone);
	}

	private buildRecord(input: ProvisionedFoundationRecordV1, fencingToken: string, fingerprint: string, key: string): PreparedAppend {
		if (input.schemaVersion !== 1) throw new DurableLedgerError("session_ledger_unknown_format", "Unsupported durable record schema version");
		const lane = requireNonEmptyString(input.lane, "lane");
		const id = requireNonEmptyString(input.id, "id");
		if (this.recordIds.has(id)) throw invalidDurableRecord(`duplicate durable record id ${id}`);
		const timestamp = this.clock();
		if (!Number.isSafeInteger(timestamp) || timestamp < 0) throw invalidDurableRecord("clock returned an invalid timestamp");
		const sequence = this.nextSequence;
		if (input.kind === "retention") {
			const retentionRevision = input.retentionRevision;
			if (retentionRevision !== this.retentionRevision + 1) {
				throw new DurableLedgerError("session_writer_stale_revision", "Retention revision is not monotonic", {
					expectedRevision: this.retentionRevision + 1,
					actualRevision: retentionRevision,
				});
			}
			const policy = this.validateRetentionPolicy(input.policy);
			if (input.expectedRevision !== undefined && input.expectedRevision !== this.retentionRevision) {
				throw new DurableLedgerError("session_writer_stale_revision", "Retention policy revision conflicts", {
					expectedRevision: input.expectedRevision,
					actualRevision: this.retentionRevision,
				});
			}
			return {
				key,
				fingerprint,
				record: {
					...clone(input),
					id,
					seq: sequence,
					timestamp,
					correlation: normalizeCorrelation(input.correlation, this.sessionId, lane, input.retentionRevision, fencingToken),
					fencingToken,
					policy,
				} as FoundationRetentionRecordV1,
			};
		}

		const objectType = requireNonEmptyString(input.objectType, "objectType");
		const objectId = requireNonEmptyString(input.objectId, "objectId");
		const keyForObject = foundationObjectKey(objectType, objectId);
		const revision = currentRevision(this.revisions, objectType, objectId);
		if (input.expectedRevision !== undefined && input.expectedRevision !== revision) {
			throw new DurableLedgerError("session_writer_stale_revision", `Expected object revision ${input.expectedRevision}, found ${revision}`, {
				expectedRevision: input.expectedRevision,
				actualRevision: revision,
			});
		}
		const current = this.objects.get(keyForObject);
		if (current?.kind === "tombstone") throw new DurableLedgerError("session_ledger_tombstoned", `Object ${objectType}/${objectId} is tombstoned`);
		if (input.kind === "intent") {
			if (input.intent === "create" && revision !== 0) throw new DurableLedgerError("session_ledger_conflict", `Cannot create existing object ${objectType}/${objectId}`);
			if ((input.intent === "update" || input.intent === "delete") && revision === 0) {
				throw new DurableLedgerError("session_ledger_conflict", `Cannot ${input.intent} missing object ${objectType}/${objectId}`);
			}
			if (input.payload !== undefined) foundationJson(input.payload, "payload");
			return {
				key,
				fingerprint,
				record: {
					...clone(input),
					id,
					seq: sequence,
					timestamp,
					revision: revision + 1,
					correlation: normalizeCorrelation(input.correlation, this.sessionId, lane, revision + 1, fencingToken),
					fencingToken,
				} as FoundationIntentRecordV1,
			};
		}
		if (input.kind === "fact") {
			foundationJson(input.payload, "payload");
			return {
				key,
				fingerprint,
				record: {
					...clone(input),
					id,
					seq: sequence,
					timestamp,
					revision: revision + 1,
					correlation: normalizeCorrelation(input.correlation, this.sessionId, lane, revision + 1, fencingToken),
					fencingToken,
				} as FoundationFactRecordV1,
			};
		}
		const deleteIntentId = input.deleteIntentId;
		if (deleteIntentId !== undefined) {
			const intent = this.intents.get(deleteIntentId);
			if (intent === undefined || intent.objectType !== objectType || intent.objectId !== objectId || intent.intent !== "delete") {
				throw new DurableLedgerError("session_ledger_missing_intent", `Delete intent ${deleteIntentId} is not present for ${objectType}/${objectId}`);
			}
		}
		if (input.reason !== undefined) requireNonEmptyString(input.reason, "reason");
		return {
			key,
			fingerprint,
			record: {
				...clone(input),
				id,
				seq: sequence,
				timestamp,
				revision: revision + 1,
				correlation: normalizeCorrelation(input.correlation, this.sessionId, lane, revision + 1, fencingToken),
				fencingToken,
			} as FoundationTombstoneRecordV1,
		};
	}

	private applyRecord(record: FoundationRecordV1, fingerprint: string, key: string): void {
		this.validatePersistedRecord(record);
		this.validateRecordTransition(record);
		this.sequence = record.seq;
		this.records.push(clone(record));
		this.recordIds.add(record.id);
		this.idempotency.set(key, { fingerprint, record: clone(record) });
		if (record.kind === "retention") {
			this.retentionRevision = record.retentionRevision;
			this.retentionPolicy = clone(record.policy);
			return;
		}
		const objectKey = foundationObjectKey(record.objectType, record.objectId);
		this.revisions.set(objectKey, record.revision);
		if (record.kind === "intent") {
			this.intents.set(record.id, clone(record));
			return;
		}
		this.objects.set(objectKey, clone(record));
		if (record.kind === "tombstone" && record.deleteIntentId !== undefined) this.tombstoneIntentIds.add(record.deleteIntentId);
	}

	private validatePersistedRecord(record: FoundationRecordV1): void {
		if (!record || typeof record !== "object") throw invalidDurableRecord("durable record must be an object");
		if (record.schemaVersion !== 1) throw new DurableLedgerError("session_ledger_unknown_format", "Unsupported durable record schema version");
		requireNonEmptyString(record.id, "id");
		requirePositiveInteger(record.seq, "seq");
		requireNonEmptyString(record.lane, "lane");
		if (!Number.isSafeInteger(record.timestamp) || record.timestamp < 0) throw invalidDurableRecord("timestamp must be valid");
		requireNonEmptyString(record.clientRequestId, "clientRequestId");
		const fencingToken = requireNonEmptyString(record.fencingToken, "fencingToken");
		if (record.correlation === undefined || typeof record.correlation !== "object") throw invalidDurableRecord("correlation must be an object");
		const correlationFencingToken = requireNonEmptyString(record.correlation.fencingToken, "correlation.fencingToken");
		if (fencingToken !== correlationFencingToken) throw new DurableLedgerError("session_writer_fencing_token", "Persisted fencingToken does not match correlation.fencingToken");
		if (record.kind !== "retention") {
			requireNonEmptyString(record.objectType, "objectType");
			requireNonEmptyString(record.objectId, "objectId");
			requirePositiveInteger(record.revision, "revision");
			if (record.correlation.revision !== record.revision) throw invalidDurableRecord("correlation revision does not match record revision");
			if (record.kind === "fact") foundationJson(record.payload, "payload");
			if (record.kind === "intent" && record.payload !== undefined) foundationJson(record.payload, "payload");
		} else {
			requirePositiveInteger(record.retentionRevision, "retentionRevision");
			this.validateRetentionPolicy(record.policy);
		}
		if (record.correlation.sessionId !== this.sessionId || record.correlation.laneId !== record.lane) {
			throw invalidDurableRecord("record correlation does not match session or lane");
		}
	}

	private validateRecordTransition(record: FoundationRecordV1): void {
		if (record.kind === "retention") {
			if (record.retentionRevision !== this.retentionRevision + 1) {
				throw invalidDurableRecord(`retention revision ${record.retentionRevision} is not ${this.retentionRevision + 1}`);
			}
			this.validateRetentionPolicy(record.policy);
			return;
		}
		const key = foundationObjectKey(record.objectType, record.objectId);
		const revision = currentRevision(this.revisions, record.objectType, record.objectId);
		if (record.revision !== revision + 1) throw invalidDurableRecord(`object revision ${record.revision} is not ${revision + 1}`);
		const current = this.objects.get(key);
		if (current?.kind === "tombstone") throw invalidDurableRecord(`object ${record.objectType}/${record.objectId} has a terminal tombstone`);
		if (record.kind === "intent") {
			if (record.intent === "create" && revision !== 0) throw invalidDurableRecord("create intent targets an existing object");
			if ((record.intent === "update" || record.intent === "delete") && revision === 0) throw invalidDurableRecord(`${record.intent} intent targets a missing object`);
		}
		if (record.kind === "tombstone" && record.deleteIntentId !== undefined) {
			const intent = this.intents.get(record.deleteIntentId);
			if (intent === undefined || intent.objectType !== record.objectType || intent.objectId !== record.objectId || intent.intent !== "delete") {
				throw invalidDurableRecord(`tombstone references missing delete intent ${record.deleteIntentId}`);
			}
		}
	}

	private validateRetentionPolicy(policy: FoundationRetentionPolicyV1): FoundationRetentionPolicyV1 {
		if (!policy || policy.schemaVersion !== 1) throw new DurableLedgerError("session_ledger_unknown_format", "Unsupported retention policy schema version");
		const cutSequence = requireNonNegativeInteger(policy.cutSequence, "cutSequence");
		if (this.retentionPolicy !== undefined && cutSequence < this.retentionPolicy.cutSequence) {
			throw new DurableLedgerError("session_ledger_conflict", "Retention cut sequence cannot move backwards");
		}
		if (policy.reason !== undefined) requireNonEmptyString(policy.reason, "retention reason");
		return { ...clone(policy), cutSequence };
	}

	private isPruned(record: FoundationRecordV1): boolean {
		return record.kind !== "tombstone" && this.retentionPolicy !== undefined && record.seq <= this.retentionPolicy.cutSequence;
	}

	private leaseTtl(ttlMs: number | undefined): number {
		const value = ttlMs ?? DEFAULT_WRITER_LEASE_TTL_MS;
		if (!Number.isSafeInteger(value) || value <= 0) throw invalidDurableRecord("ttlMs must be a positive safe integer");
		return value;
	}

	private requireLease(fencingToken: string, rejectExpired = true): LedgerWriterLeaseV1 {
		if (this.lease === null) throw new DurableLedgerError("session_writer_lease_lost", "No active session writer lease");
		if (this.lease.fencingToken !== fencingToken) throw new DurableLedgerError("session_writer_fencing_token", "Writer fencing token is stale");
		if (rejectExpired && this.lease.expiresAt <= this.clock()) {
			throw new DurableLedgerError("session_writer_lease_expired", "Session writer lease has expired");
		}
		return this.lease;
	}

	private requireLeaseForAppend(): LedgerWriterLeaseV1 {
		if (this.lease === null) throw new DurableLedgerError("session_writer_lease_lost", "No active session writer lease");
		if (this.lease.expiresAt <= this.clock()) throw new DurableLedgerError("session_writer_lease_expired", "Session writer lease has expired");
		return this.lease;
	}

	private provisionedFromRecord(record: FoundationRecordV1): ProvisionedFoundationRecordV1 {
		if (record.kind === "retention") {
			const { seq: _seq, timestamp: _timestamp, correlation, ...input } = record;
			return {
				...input,
				correlation: { ...correlation, revision: 0 },
			} as ProvisionedFoundationRecordV1;
		}
		const { seq: _seq, timestamp: _timestamp, revision: _revision, correlation, ...input } = record;
		return {
			...input,
			correlation: { ...correlation, revision: 0 },
		} as ProvisionedFoundationRecordV1;
	}
}
