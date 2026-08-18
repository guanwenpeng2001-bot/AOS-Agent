import {
	createExecutionCorrelation,
	newFoundationId,
	type FoundationJsonValue,
} from "../foundation/index.ts";
import type {
	FoundationCorrelationInputV1,
	FoundationObjectResultV1,
	FoundationRecordQueryV1,
	FoundationRecordV1,
	LedgerWriterLeaseV1,
	AppendFoundationRecordResultV1,
	ProvisionedFoundationRecordV1,
} from "./durable/types.ts";
import { DurableLedgerError } from "./durable/errors.ts";
import type { Session } from "./session.ts";

/** Object names reserved by the Session-backed T5 projection. */
export const T5_LEDGER_OBJECT_TYPES = Object.freeze({
	contextSnapshot: "t5.context_snapshot",
	instructionSource: "t5.instruction_source",
	instructionLock: "t5.instruction_lock",
	instructionResolution: "t5.instruction_resolution",
	memory: "t5.memory",
	compaction: "t5.compaction",
	promptCache: "t5.prompt_cache",
	checkpoint: "t5.checkpoint",
	rewindPlan: "t5.rewind_plan",
	rewindExecution: "t5.rewind_execution",
	artifactManifest: "t5.artifact_manifest",
	artifactReference: "t5.artifact_reference",
	toolResult: "t5.tool_result",
	contextBuild: "t5.context_build",
	taskContextPackage: "t5.task_context_package",
} as const);

export type T5LedgerObjectType = (typeof T5_LEDGER_OBJECT_TYPES)[keyof typeof T5_LEDGER_OBJECT_TYPES];

export interface SessionLedgerWriterOptions {
	readonly lane?: string;
	readonly ownerId?: string;
	readonly leaseTtlMs?: number;
	readonly now?: () => number;
}

/** Raised when one T5 projection is accidentally wired to another Session. */
export class SessionLedgerBindingError extends Error {
	readonly code = "session_binding_mismatch" as const;

	constructor(message: string) {
		super(message);
		this.name = "SessionLedgerBindingError";
	}
}

/** Keep all projections on the exact Session authority supplied by the caller. */
export function assertSessionLedgerWriterSession(session: Session, writer: SessionLedgerWriter, role: string): void {
	if (writer.session !== session) {
		throw new SessionLedgerBindingError(`${role} must use the supplied SessionLedgerWriter's Session`);
	}
}

export interface T5FactWriteOptions {
	readonly objectType: string;
	readonly objectId: string;
	readonly payload: FoundationJsonValue;
	readonly clientRequestId?: string;
	readonly expectedRevision?: number;
	readonly correlation?: Partial<FoundationCorrelationInputV1>;
}

/**
 * The only T5 state adapter. It deliberately has no local state projection:
 * reads always come from Session's durable foundation ledger and writes are
 * idempotent foundation facts guarded by the Session writer lease.
 */
export class SessionLedgerWriter {
	readonly session: Session;
	readonly lane: string;
	private readonly ownerId: string;
	private readonly leaseTtlMs: number;
	private readonly now: () => number;
	private lease: LedgerWriterLeaseV1 | undefined;

	constructor(session: Session, options: SessionLedgerWriterOptions = {}) {
		this.session = session;
		this.lane = options.lane ?? "main";
		this.ownerId = options.ownerId ?? `t5-writer-${session.idGenerator.next()}`;
		this.leaseTtlMs = options.leaseTtlMs ?? 15 * 60 * 1000;
		this.now = options.now ?? Date.now;
	}

	/** Fail closed when a caller tries to compose two Session authorities. */
	assertSession(session: Session, role = "T5 projection"): void {
		if (this.session !== session) {
			throw new SessionLedgerBindingError(`${role} is bound to a different Session`);
		}
	}

	async ensureLease(refresh = false): Promise<LedgerWriterLeaseV1> {
		const current = await this.session.getWriterLease();
		if (
			!refresh &&
			this.lease !== undefined &&
			current?.fencingToken === this.lease.fencingToken &&
			current.expiresAt > this.now() + Math.min(1000, Math.floor(this.leaseTtlMs / 4))
		) {
			return this.lease;
		}
		if (current?.ownerId === this.ownerId && current.expiresAt > this.now()) {
			try {
				this.lease = await this.session.renewWriterLease({
					fencingToken: current.fencingToken,
					ttlMs: this.leaseTtlMs,
				});
				return this.lease;
			} catch (error) {
				if (
					!(error instanceof DurableLedgerError) ||
					(error.code !== "session_writer_lease_expired" &&
						error.code !== "session_writer_fencing_token" &&
						error.code !== "session_writer_lease_lost")
				) throw error;
				this.lease = undefined;
			}
		}
		this.lease = await this.session.acquireWriterLease({ ownerId: this.ownerId, ttlMs: this.leaseTtlMs });
		return this.lease;
	}

	async releaseLease(): Promise<void> {
		if (this.lease === undefined) return;
		await this.session.releaseWriterLease({ fencingToken: this.lease.fencingToken });
		this.lease = undefined;
	}

	/** Append a Foundation record under this writer's lease authority. */
	async appendFoundationRecord(record: ProvisionedFoundationRecordV1): Promise<AppendFoundationRecordResultV1> {
		const lease = await this.ensureLease(true);
		return this.session.appendFoundationRecord({
			...record,
			fencingToken: lease.fencingToken,
			correlation: { ...record.correlation, fencingToken: lease.fencingToken },
		});
	}

	async writeFact<TPayload extends FoundationJsonValue>(
		options: Omit<T5FactWriteOptions, "payload"> & { payload: TPayload },
	): Promise<{ record: Extract<FoundationRecordV1, { kind: "fact" }>; replayed: boolean; payload: TPayload }> {
		const lease = await this.ensureLease();
		const metadata = await this.session.getMetadata();
		const currentRevision = await this.session.getFoundationRevision(options.objectType, options.objectId);
		const clientRequestId = options.clientRequestId ?? newFoundationId("t5-request");
		const correlation = createExecutionCorrelation(metadata.id, this.lane, {
			...options.correlation,
			revision: options.correlation?.revision ?? 0,
		});
		const record: ProvisionedFoundationRecordV1 = {
			schemaVersion: 1,
			kind: "fact",
			id: `t5_fact_${options.objectType.replace(/[^a-zA-Z0-9_-]/g, "_")}_${options.objectId}_${clientRequestId}`,
			lane: this.lane,
			objectType: options.objectType,
			objectId: options.objectId,
			clientRequestId,
			expectedRevision: options.expectedRevision ?? currentRevision,
			payload: options.payload,
			correlation,
			fencingToken: lease.fencingToken,
		};
		const accepted = await this.session.appendFoundationRecord(record);
		if (accepted.record.kind !== "fact") {
			throw new Error(`T5 ledger returned a non-fact record for ${options.objectType}/${options.objectId}`);
		}
		return { record: accepted.record, replayed: accepted.replayed, payload: accepted.record.payload as TPayload };
	}

	async readFact<TPayload extends FoundationJsonValue>(objectType: string, objectId: string): Promise<{
		record: Extract<FoundationObjectResultV1, { kind: "fact" }>;
		payload: TPayload;
	} | undefined> {
		const result = await this.session.getFoundationObject(objectType, objectId);
		if (result === undefined || result.kind !== "fact") return undefined;
		return { record: result, payload: result.payload as TPayload };
	}

	async listFacts(query: Omit<FoundationRecordQueryV1, "kind"> = {}): Promise<Extract<FoundationRecordV1, { kind: "fact" }>[]> {
		const records = await this.session.findFoundationRecords({ ...query, kind: "fact", order: query.order ?? "oldestFirst" });
		return records.filter((record): record is Extract<FoundationRecordV1, { kind: "fact" }> => record.kind === "fact");
	}

	async tombstone(options: {
		readonly objectType: string;
		readonly objectId: string;
		readonly clientRequestId?: string;
		readonly reason?: string;
		readonly correlation?: Partial<FoundationCorrelationInputV1>;
	}): Promise<Extract<FoundationRecordV1, { kind: "tombstone" }>> {
		const lease = await this.ensureLease();
		const metadata = await this.session.getMetadata();
		const revision = await this.session.getFoundationRevision(options.objectType, options.objectId);
		const clientRequestId = options.clientRequestId ?? newFoundationId("t5-delete");
		const correlation = createExecutionCorrelation(metadata.id, this.lane, {
			...options.correlation,
			revision: options.correlation?.revision ?? 0,
		});
		const accepted = await this.session.appendFoundationRecord({
			schemaVersion: 1,
			kind: "tombstone",
			id: `t5_tombstone_${options.objectType.replace(/[^a-zA-Z0-9_-]/g, "_")}_${options.objectId}_${clientRequestId}`,
			lane: this.lane,
			objectType: options.objectType,
			objectId: options.objectId,
			clientRequestId,
			expectedRevision: revision,
			reason: options.reason,
			correlation,
			fencingToken: lease.fencingToken,
		});
		if (accepted.record.kind !== "tombstone") {
			throw new Error(`T5 ledger returned a non-tombstone record for ${options.objectType}/${options.objectId}`);
		}
		return accepted.record;
	}
}
