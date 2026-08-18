import type { ExecutionCorrelationV1, FoundationJsonValue } from "../../foundation/index.ts";
import type { DurableLedgerErrorCode } from "../../foundation/errors.ts";

/** Version carried by every durable ledger fact/intent/tombstone/retention record. */
export const FOUNDATION_LEDGER_SCHEMA_VERSION = 1 as const;
export type FoundationLedgerSchemaVersion = typeof FOUNDATION_LEDGER_SCHEMA_VERSION;

/** JSONL session format version that can physically store durable ledger records. */
export const FOUNDATION_LEDGER_FORMAT_VERSION = 5 as const;
export type FoundationLedgerFormatVersion = typeof FOUNDATION_LEDGER_FORMAT_VERSION;

export type FoundationRecordKindV1 = "fact" | "intent" | "tombstone" | "retention";
export type FoundationIntentKindV1 = "create" | "update" | "delete";
export type FoundationRecordOrderV1 = "newestFirst" | "oldestFirst";

/** Default lease time-to-live when the caller does not request one. */
export const DEFAULT_WRITER_LEASE_TTL_MS = 15 * 60 * 1000;
/** Default lane used by the {@link FoundationLedger} facade. */
export const DEFAULT_LEDGER_LANE = "main";

/**
 * Correlation supplied by a caller. The ledger assigns `revision` (and fills
 * session/lane defaults on the facade) so callers cannot forge a revision.
 */
export type FoundationCorrelationInputV1 = Omit<ExecutionCorrelationV1, "revision"> & { revision?: number };

export interface FoundationRecordBaseV1 {
	schemaVersion: 1;
	kind: FoundationRecordKindV1;
	/** Ledger record id. */
	id: string;
	/** Shared ledger sequence, storage-assigned. */
	seq: number;
	/** Logical lane that owns the record. */
	lane: string;
	/** Unix milliseconds, storage-assigned. */
	timestamp: number;
	/** Foundation object kind, e.g. "role_revision", "task", "goal". */
	objectType: string;
	/** Foundation object id. */
	objectId: string;
	/** Monotonic per-object revision, storage-assigned starting at 1. */
	revision: number;
	/** Client-generated idempotency key; unique per accepted record. */
	clientRequestId: string;
	/** Optimistic-concurrency expectation: the object revision the caller believes is current. */
	expectedRevision?: number;
	/** Writer fencing token of the accepted lease. */
	fencingToken: string;
	correlation: ExecutionCorrelationV1 & { fencingToken: string };
}

/** A durable fact: the persisted value of one Foundation identity/entity. */
export interface FoundationFactRecordV1 extends FoundationRecordBaseV1 {
	kind: "fact";
	/** The identity document as canonical Foundation JSON. */
	payload: FoundationJsonValue;
}

/** A durable intent: a side-effect-free command targeted at a Foundation object. */
export interface FoundationIntentRecordV1 extends FoundationRecordBaseV1 {
	kind: "intent";
	intent: FoundationIntentKindV1;
	/** Command arguments as canonical Foundation JSON. */
	payload?: FoundationJsonValue;
}

/** A durable tombstone: the terminal fact replacing a deleted object. */
export interface FoundationTombstoneRecordV1 extends FoundationRecordBaseV1 {
	kind: "tombstone";
	/** Delete intent id that produced this tombstone, when one was written. */
	deleteIntentId?: string;
	reason?: string;
}

/** A durable retention policy change for the whole ledger. */
export interface FoundationRetentionRecordV1 {
	schemaVersion: 1;
	kind: "retention";
	id: string;
	seq: number;
	lane: string;
	timestamp: number;
	/** Monotonic policy revision. */
	retentionRevision: number;
	policy: FoundationRetentionPolicyV1;
	clientRequestId: string;
	expectedRevision?: number;
	fencingToken: string;
	correlation: ExecutionCorrelationV1 & { fencingToken: string };
}

/** Retention policy: records at or below `cutSequence` are logically prunable. */
export interface FoundationRetentionPolicyV1 {
	schemaVersion: 1;
	cutSequence: number;
	reason?: string;
}

export type FoundationRecordV1 =
	| FoundationFactRecordV1
	| FoundationIntentRecordV1
	| FoundationTombstoneRecordV1
	| FoundationRetentionRecordV1;

/** Record the caller submits; the ledger assigns `seq`, `timestamp`, `revision` and correlation revision. */
export type ProvisionedFoundationRecordV1 =
	| (Omit<FoundationFactRecordV1, "seq" | "timestamp" | "revision" | "correlation" | "fencingToken"> & {
			fencingToken?: string;
			correlation: FoundationCorrelationInputV1;
		})
	| (Omit<FoundationIntentRecordV1, "seq" | "timestamp" | "revision" | "correlation" | "fencingToken"> & {
			fencingToken?: string;
			correlation: FoundationCorrelationInputV1;
		})
	| (Omit<FoundationTombstoneRecordV1, "seq" | "timestamp" | "revision" | "correlation" | "fencingToken"> & {
			fencingToken?: string;
			correlation: FoundationCorrelationInputV1;
		})
	| (Omit<FoundationRetentionRecordV1, "seq" | "timestamp" | "correlation" | "fencingToken"> & {
			fencingToken?: string;
			correlation: FoundationCorrelationInputV1;
		});

export type FoundationObjectResultV1 = FoundationFactRecordV1 | FoundationTombstoneRecordV1;

export type { FoundationCorrelationInputV1 as FoundationCorrelationInput };

/** Single-writer lease. Durable: the latest lease fact wins after rebuild. */
export interface LedgerWriterLeaseV1 {
	schemaVersion: 1;
	ownerId: string;
	leaseRevision: number;
	fencingToken: string;
	acquiredAt: number;
	/** A released lease has `expiresAt` 0, which is always considered expired. */
	expiresAt: number;
}

export interface AcquireWriterLeaseOptionsV1 {
	ownerId: string;
	ttlMs?: number;
}

export interface RenewWriterLeaseOptionsV1 {
	fencingToken: string;
	ttlMs?: number;
}

export interface ReleaseWriterLeaseOptionsV1 {
	fencingToken: string;
}

export interface AppendFoundationRecordResultV1 {
	record: FoundationRecordV1;
	/** True when `clientRequestId` was already accepted and the stored record is returned. */
	replayed: boolean;
}

export interface SetRetentionPolicyOptionsV1 {
	clientRequestId: string;
	correlation: FoundationCorrelationInputV1;
	expectedRevision?: number;
	fencingToken?: string;
	objectType?: string;
	objectId?: string;
}

export interface FoundationRecordQueryV1 {
	kind?: FoundationRecordKindV1;
	objectType?: string;
	objectId?: string;
	/** Exact correlation fields used to keep records from different operations separate. */
	correlation?: Partial<ExecutionCorrelationV1>;
	afterSeq?: number;
	beforeSeq?: number;
	limit?: number;
	order?: FoundationRecordOrderV1;
	/** Include records logically pruned by the retention policy. Default false. */
	includePruned?: boolean;
}

/** Compatibility aliases for the canonical durable-ledger catalog. */
export { DURABLE_LEDGER_ERROR_CODES as FOUNDATION_LEDGER_ERROR_CODES } from "../../foundation/errors.ts";
export type FoundationLedgerErrorCode = DurableLedgerErrorCode;

/**
 * Durable-ledger capability implemented by both session backends. Kept as a
 * separate interface so the legacy v1 {@link SessionStorage} surface stays
 * untouched.
 */
export interface DurableLedgerApi {
	acquireWriterLease(options: AcquireWriterLeaseOptionsV1): Promise<LedgerWriterLeaseV1>;
	renewWriterLease(options: RenewWriterLeaseOptionsV1): Promise<LedgerWriterLeaseV1>;
	releaseWriterLease(options: ReleaseWriterLeaseOptionsV1): Promise<void>;
	getWriterLease(): Promise<LedgerWriterLeaseV1 | null>;
	/** Total number of accepted durable mutations (the ledger revision). */
	getLedgerRevision(): Promise<number>;
	appendFoundationRecord(record: ProvisionedFoundationRecordV1): Promise<AppendFoundationRecordResultV1>;
	setRetentionPolicy(
		policy: FoundationRetentionPolicyV1,
		options: SetRetentionPolicyOptionsV1,
	): Promise<AppendFoundationRecordResultV1>;
	findFoundationRecords(query?: FoundationRecordQueryV1): Promise<FoundationRecordV1[]>;
	getFoundationObject(objectType: string, objectId: string): Promise<FoundationObjectResultV1 | undefined>;
	getFoundationRevision(objectType: string, objectId: string): Promise<number>;
	isObjectTombstoned(objectType: string, objectId: string): Promise<boolean>;
	getRetentionPolicy(): Promise<FoundationRetentionPolicyV1 | undefined>;
	prunableFoundationRecords(): Promise<readonly FoundationRecordV1[]>;
}

export function isDurableLedgerStorage(
	storage: unknown,
): storage is SessionStorageLike & DurableLedgerApi {
	return (
		typeof storage === "object" &&
		storage !== null &&
		typeof (storage as { appendFoundationRecord?: unknown }).appendFoundationRecord === "function" &&
		typeof (storage as { findFoundationRecords?: unknown }).findFoundationRecords === "function"
	);
}

/** Minimal structural shape needed by {@link isDurableLedgerStorage} checks. */
type SessionStorageLike = object;

/** Stable per-object ledger key used by the durable state. */
export function foundationObjectKey(objectType: string, objectId: string): string {
	return `${objectType}\u0000${objectId}`;
}

/** Stable idempotency key: kind plus the client request id. */
export function foundationIdempotencyKey(kind: FoundationRecordKindV1, clientRequestId: string): string {
	return `${kind}\u0000${clientRequestId}`;
}
