import type { Session } from "../session/session.ts";
import type { ExecutionCorrelation } from "./identity.ts";
import type { FoundationJsonValue } from "./event-catalog.ts";
import { canonicalFoundationJson, newFoundationId } from "./identity.ts";
import { FoundationError, toFoundationError } from "./errors.ts";
import { DurableLedgerError } from "../session/durable/errors.ts";
import type {
	FoundationFactRecord,
	FoundationIntentRecord,
	FoundationObjectResult,
	FoundationRecordQuery,
	FoundationRecord,
	LedgerWriterLease,
	ProvisionedFoundationRecord,
} from "../session/durable/types.ts";
import { assertSessionLedgerWriterSession, type SessionLedgerWriter } from "../session/t5.ts";

/** The only state retained by a Foundation facade is a lease token; objects live in Session. */
export interface SessionLedgerOptions {
	readonly ownerId?: string;
	readonly laneId?: string;
	readonly leaseTtlMs?: number;
	readonly writer?: SessionLedgerWriter;
}

export interface AppendFoundationFactOptions {
	readonly clientRequestId: string;
	readonly expectedRevision?: number;
	readonly correlation: Omit<ExecutionCorrelation, "sessionId" | "laneId" | "revision"> & { revision?: number };
}

export interface SessionLedgerFactResult<TPayload> {
	readonly record: FoundationFactRecord;
	readonly payload: TPayload;
	readonly replayed: boolean;
}

export interface SessionLedgerIntentResult {
	readonly record: FoundationIntentRecord;
	readonly replayed: boolean;
}

/**
 * Small Session facade shared by role/profile and execution stores. It deliberately
 * does not cache objects: every read comes from the Session reducer and every write
 * uses object CAS plus the durable writer fencing token.
 */
export class SessionLedger {
	private readonly session: Session;
	private readonly ownerId: string;
	private readonly laneId: string;
	private readonly leaseTtlMs: number;
	private readonly writer: SessionLedgerWriter | undefined;
	private lease: LedgerWriterLease | undefined;

	constructor(session: Session, options: SessionLedgerOptions = {}) {
		this.session = session;
		this.writer = options.writer;
		if (this.writer !== undefined) assertSessionLedgerWriterSession(session, this.writer, "SessionLedgerV1");
		this.ownerId = options.ownerId ?? newFoundationId("foundation-writer");
		this.laneId = options.laneId ?? this.writer?.lane ?? "main";
		this.leaseTtlMs = options.leaseTtlMs ?? 15 * 60 * 1000;
	}

	async get(objectType: string, objectId: string): Promise<FoundationObjectResult | undefined> {
		return this.session.getFoundationObject(objectType, objectId);
	}

	async getFact<TPayload>(objectType: string, objectId: string): Promise<SessionLedgerFactResult<TPayload> | undefined> {
		const record = await this.session.getFoundationObject(objectType, objectId);
		if (record === undefined || record.kind !== "fact") return undefined;
		return { record, payload: record.payload as TPayload, replayed: false };
	}

	async find(query: FoundationRecordQuery = {}): Promise<readonly FoundationRecord[]> {
		return this.session.findFoundationRecords(query);
	}

	async revision(objectType: string, objectId: string): Promise<number> {
		return this.session.getFoundationRevision(objectType, objectId);
	}

	async appendFact<TPayload>(objectType: string, objectId: string, payload: TPayload, options: AppendFoundationFactOptions): Promise<SessionLedgerFactResult<TPayload>> {
		const current = await this.session.getFoundationObject(objectType, objectId);
		const actualRevision = await this.session.getFoundationRevision(objectType, objectId);
		if (options.expectedRevision !== undefined && options.expectedRevision !== actualRevision) throw new FoundationError("session_writer_stale_revision", "Foundation object revision does not match the compare-and-set expectation", { details: { objectType, objectId, expectedRevision: options.expectedRevision, actualRevision } });
		if (current?.kind === "fact" && canonicalFoundationJson(current.payload) === canonicalFoundationJson(payload)) {
			return { record: current, payload: current.payload as TPayload, replayed: true };
		}
		if (this.writer !== undefined) {
			const appended = await this.writer.writeFact({
				objectType,
				objectId,
				payload: payload as FoundationJsonValue,
				clientRequestId: options.clientRequestId,
				expectedRevision: options.expectedRevision,
				correlation: options.correlation,
			});
			return { record: appended.record, payload: appended.payload as TPayload, replayed: appended.replayed };
		}
		const lease = await this.ensureLease();
		const expectedRevision = options.expectedRevision ?? actualRevision;
		const metadata = await this.session.getMetadata();
		const correlation = {
			...Object.fromEntries(Object.entries(options.correlation).filter(([, value]) => value !== undefined)),
			sessionId: metadata.id,
			laneId: this.laneId,
			revision: 0,
		};
		const input: ProvisionedFoundationRecord = {
			schemaVersion: 1,
			kind: "fact",
			id: `${objectType}:${objectId}:${options.clientRequestId}`,
			lane: this.laneId,
			objectType,
			objectId,
			clientRequestId: options.clientRequestId,
			expectedRevision,
			fencingToken: lease.fencingToken,
			correlation,
			payload: payload as FoundationJsonValue,
		};
		try {
			const appended = await this.session.appendFoundationRecord(input);
			return { record: appended.record as FoundationFactRecord, payload: appended.record.kind === "fact" ? appended.record.payload as TPayload : payload, replayed: appended.replayed };
		} catch (error) {
			if (error instanceof DurableLedgerError) throw error;
			throw toFoundationError(error, "session_writer_stale_revision");
		}
	}

	/**
	 * Persist a side-effect-free intent before invoking an external provider.
	 * The client request id is the durable idempotency key; replaying the same
	 * intent returns the original record without advancing the ledger.
	 */
	async appendIntent(objectType: string, objectId: string, options: AppendFoundationFactOptions & { readonly intent: "create" | "update" | "delete"; readonly payload?: FoundationJsonValue }): Promise<SessionLedgerIntentResult> {
		const existing = await this.session.findFoundationRecords({ kind: "intent", objectType, objectId, includePruned: true, order: "oldestFirst" });
		const replay = existing.find((record) => record.kind === "intent" && record.clientRequestId === options.clientRequestId);
		if (replay !== undefined && replay.kind === "intent") return { record: replay, replayed: true };
		const actualRevision = await this.session.getFoundationRevision(objectType, objectId);
		if (options.expectedRevision !== undefined && options.expectedRevision !== actualRevision) throw new FoundationError("session_writer_stale_revision", "Foundation object revision does not match the compare-and-set expectation", { details: { objectType, objectId, expectedRevision: options.expectedRevision, actualRevision } });
		const lease = await this.ensureLease();
		const metadata = await this.session.getMetadata();
		const correlation = {
			...Object.fromEntries(Object.entries(options.correlation).filter(([, value]) => value !== undefined)),
			sessionId: metadata.id,
			laneId: this.laneId,
			revision: 0,
		};
		const input: ProvisionedFoundationRecord = {
			schemaVersion: 1,
			kind: "intent",
			id: `${objectType}:${objectId}:${options.clientRequestId}`,
			lane: this.laneId,
			objectType,
			objectId,
			clientRequestId: options.clientRequestId,
			intent: options.intent,
			...(options.expectedRevision === undefined ? {} : { expectedRevision: options.expectedRevision }),
			...(options.payload === undefined ? {} : { payload: options.payload }),
			fencingToken: lease.fencingToken,
			correlation,
		};
		try {
			const appended = this.writer === undefined
				? await this.session.appendFoundationRecord(input)
				: await this.writer.appendFoundationRecord(input);
			return { record: appended.record as FoundationIntentRecord, replayed: appended.replayed };
		} catch (error) {
			if (error instanceof DurableLedgerError) throw error;
			throw toFoundationError(error, "session_writer_stale_revision");
		}
	}

	async release(): Promise<void> {
		if (this.writer !== undefined) return;
		if (this.lease === undefined) return;
		try {
			await this.session.releaseWriterLease({ fencingToken: this.lease.fencingToken });
		} finally {
			this.lease = undefined;
		}
	}

	private async ensureLease(): Promise<LedgerWriterLease> {
		try {
			if (this.writer !== undefined) return this.writer.ensureLease();
			if (this.lease !== undefined && this.lease.expiresAt > Date.now() + 1000) {
				this.lease = await this.session.renewWriterLease({ fencingToken: this.lease.fencingToken, ttlMs: this.leaseTtlMs });
				return this.lease;
			}
			this.lease = await this.session.acquireWriterLease({ ownerId: this.ownerId, ttlMs: this.leaseTtlMs });
			return this.lease;
		} catch (error) {
			if (error instanceof DurableLedgerError || error instanceof FoundationError) throw error;
			throw toFoundationError(error, "session_writer_lease_lost");
		}
	}
}

export const FoundationSessionLedger = SessionLedger;
