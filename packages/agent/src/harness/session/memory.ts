import { uuidv7 } from "@aos-agent/ai";
import { Session } from "./session.ts";
import { SessionState } from "./state.ts";
import { FoundationLedgerState } from "./durable/state.ts";
import type {
	AcquireWriterLeaseOptionsV1,
	AppendFoundationRecordResultV1,
	DurableLedgerApi,
	FoundationRecordQueryV1,
	FoundationRecordV1,
	FoundationObjectResultV1,
	FoundationRetentionPolicyV1,
	LedgerWriterLeaseV1,
	ProvisionedFoundationRecordV1,
	ReleaseWriterLeaseOptionsV1,
	RenewWriterLeaseOptionsV1,
	SetRetentionPolicyOptionsV1,
} from "./durable/types.ts";
import {
	type BranchBounds,
	type Entry,
	type EntryQuery,
	type ForkOptions,
	type LanePointer,
	type LaneRecord,
	type LogItem,
	type LogOptions,
	type NewRecord,
	type OperationStartedRecord,
	type ProvisionedEntry,
	type RecordQuery,
	type SessionCreateOptions,
	SessionError,
	type SessionMetadata,
	type SessionRepo,
	type SessionStats,
	type SessionStorage,
} from "./types.ts";

export class InMemorySessionStorage implements SessionStorage, DurableLedgerApi {
	private readonly metadata: SessionMetadata;
	private readonly state = new SessionState();
	private readonly durableState: FoundationLedgerState;

	constructor(metadata: SessionMetadata) {
		this.metadata = structuredClone(metadata);
		this.durableState = new FoundationLedgerState({ sessionId: metadata.id });
	}

	fork(metadata: SessionMetadata, options: ForkOptions & SessionCreateOptions): InMemorySessionStorage {
		const storage = new InMemorySessionStorage(metadata);
		for (const mutation of this.state.createForkMutations(options)) {
			storage.state.applyMutation(mutation);
			const sequence = mutation.kind === "entry" ? mutation.entry.seq : mutation.kind === "record" ? mutation.record.seq : mutation.seq;
			storage.durableState.observeExternalSequence(sequence);
		}
		return storage;
	}

	async getMetadata(): Promise<SessionMetadata> {
		return structuredClone(this.metadata);
	}

	async getLanes(): Promise<LanePointer[]> {
		return this.state.getLanes();
	}

	async createLane(lane: string, at: string | null): Promise<void> {
		this.state.validateNewLane(lane);
		this.state.validateTarget(at);
		const mutation = { kind: "lane" as const, seq: this.state.nextSequence, lane, leafId: at };
		this.state.applyMutation(mutation);
		this.durableState.observeExternalSequence(mutation.seq);
	}

	async moveLane(lane: string, to: string | null): Promise<void> {
		this.state.requireLane(lane);
		this.state.validateTarget(to);
		const mutation = { kind: "lane" as const, seq: this.state.nextSequence, lane, leafId: to };
		this.state.applyMutation(mutation);
		this.durableState.observeExternalSequence(mutation.seq);
	}

	async appendEntry<TEntry extends Entry>(newEntry: ProvisionedEntry<TEntry>, lane: string): Promise<TEntry> {
		const parentId = this.state.requireLane(lane);
		this.state.validateUnusedId(newEntry.id);
		const entry = {
			...structuredClone(newEntry),
			parentId,
			seq: this.state.nextSequence,
			timestamp: Date.now(),
		} as unknown as TEntry;
		this.state.applyMutation({ kind: "entry", lane, entry });
		this.durableState.observeExternalSequence(entry.seq);
		return structuredClone(entry);
	}

	async appendRecord<TRecord extends LaneRecord>(newRecord: NewRecord<TRecord>): Promise<TRecord> {
		this.state.requireLane(newRecord.lane);
		this.state.validateUnusedId(newRecord.id);
		const currentOpenOperationId = this.state.findOpenOperations(newRecord.lane, { limit: 1 })[0]?.id;
		if (newRecord.type === "operation_started" && currentOpenOperationId !== undefined) {
			throw new SessionError(
				"storage",
				`Lane ${newRecord.lane} already has an open operation ${currentOpenOperationId}`,
			);
		}
		const record = {
			...structuredClone(newRecord),
			seq: this.state.nextSequence,
			timestamp: Date.now(),
		} as unknown as TRecord;
		this.state.applyMutation({ kind: "record", record });
		this.durableState.observeExternalSequence(record.seq);
		return structuredClone(record);
	}

	async getEntry(id: string): Promise<Entry | undefined> {
		const entry = this.state.getEntry(id);
		return entry === undefined ? undefined : structuredClone(entry);
	}

	async findEntries(query: EntryQuery = {}): Promise<Entry[]> {
		return structuredClone(this.state.findEntries(query));
	}

	async findEntriesOnBranch(query: EntryQuery & BranchBounds & { start: string }): Promise<Entry[]> {
		return structuredClone(this.state.findEntriesOnBranch(query));
	}

	async findRecords<K extends LaneRecord["type"]>(
		query: RecordQuery & { type: K },
	): Promise<Extract<LaneRecord, { type: K }>[]>;
	async findRecords(query?: RecordQuery): Promise<LaneRecord[]>;
	async findRecords(query: RecordQuery = {}): Promise<LaneRecord[]> {
		return structuredClone(this.state.findRecords(query));
	}

	async findOpenOperations(lane: string, options?: { limit?: number }): Promise<OperationStartedRecord[]> {
		return structuredClone(this.state.findOpenOperations(lane, options));
	}

	async getLog(options: LogOptions = {}): Promise<LogItem[]> {
		return structuredClone(this.state.getLog(options));
	}

	async getName(): Promise<string | undefined> {
		return this.state.getName();
	}

	async setName(name: string | undefined): Promise<void> {
		const mutation = { kind: "fact" as const, seq: this.state.nextSequence, fact: "name" as const, name };
		this.state.applyMutation(mutation);
		this.durableState.observeExternalSequence(mutation.seq);
	}

	async getLabel(id: string): Promise<string | undefined> {
		return this.state.getLabel(id);
	}

	async setLabel(id: string, label: string | undefined): Promise<void> {
		this.state.validateTarget(id);
		const mutation = {
			kind: "fact",
			seq: this.state.nextSequence,
			fact: "label",
			targetId: id,
			label,
		} as const;
		this.state.applyMutation(mutation);
		this.durableState.observeExternalSequence(mutation.seq);
	}

	async getStats(): Promise<SessionStats> {
		return structuredClone(this.state.getStats());
	}

	async acquireWriterLease(options: AcquireWriterLeaseOptionsV1): Promise<LedgerWriterLeaseV1> {
		return this.durableState.acquireWriterLease(options);
	}

	async renewWriterLease(options: RenewWriterLeaseOptionsV1): Promise<LedgerWriterLeaseV1> {
		return this.durableState.renewWriterLease(options);
	}

	async releaseWriterLease(options: ReleaseWriterLeaseOptionsV1): Promise<void> {
		this.durableState.releaseWriterLease(options);
	}

	async getWriterLease(): Promise<LedgerWriterLeaseV1 | null> {
		return this.durableState.getWriterLease();
	}

	async getLedgerRevision(): Promise<number> {
		return this.durableState.getLedgerRevision();
	}

	async appendFoundationRecord(record: ProvisionedFoundationRecordV1): Promise<AppendFoundationRecordResultV1> {
		this.alignDurableCursor();
		const result = this.durableState.appendFoundationRecord(record);
		if (!result.replayed) this.state.observeExternalSequence(result.record.seq, result.record.id, result.record);
		return result;
	}

	async setRetentionPolicy(policy: FoundationRetentionPolicyV1, options: SetRetentionPolicyOptionsV1): Promise<AppendFoundationRecordResultV1> {
		this.alignDurableCursor();
		const result = this.durableState.setRetentionPolicy(policy, options);
		if (!result.replayed) this.state.observeExternalSequence(result.record.seq, result.record.id, result.record);
		return result;
	}

	async findFoundationRecords(query?: FoundationRecordQueryV1): Promise<FoundationRecordV1[]> {
		return this.durableState.findFoundationRecords(query);
	}

	async getFoundationObject(objectType: string, objectId: string): Promise<FoundationObjectResultV1 | undefined> {
		return this.durableState.getFoundationObject(objectType, objectId);
	}

	async getFoundationRevision(objectType: string, objectId: string): Promise<number> {
		return this.durableState.getFoundationRevision(objectType, objectId);
	}

	async isObjectTombstoned(objectType: string, objectId: string): Promise<boolean> {
		return this.durableState.isObjectTombstoned(objectType, objectId);
	}

	async getRetentionPolicy(): Promise<FoundationRetentionPolicyV1 | undefined> {
		return this.durableState.getRetentionPolicy();
	}

	async prunableFoundationRecords(): Promise<readonly FoundationRecordV1[]> {
		return this.durableState.prunableFoundationRecords();
	}

	private alignDurableCursor(): void {
		const sharedSequence = this.state.nextSequence - 1;
		const durableSequence = this.durableState.getLedgerRevision();
		if (durableSequence > sharedSequence) {
			throw new SessionError("storage", "Foundation reducer is ahead of the Session ledger");
		}
		while (this.durableState.getLedgerRevision() < sharedSequence) {
			this.durableState.observeExternalSequence(this.durableState.getLedgerRevision() + 1);
		}
	}
}

export class InMemorySessionRepo implements SessionRepo {
	private readonly sessions = new Map<string, InMemorySessionStorage>();

	async create(options: SessionCreateOptions = {}): Promise<Session> {
		const id = options.id ?? uuidv7();
		if (this.sessions.has(id)) throw new SessionError("already_exists", `Session already exists: ${id}`);
		const storage = new InMemorySessionStorage({
			id,
			createdAt: Date.now(),
			parentSessionId: options.parentSessionId,
		});
		this.sessions.set(id, storage);
		return new Session(storage);
	}

	async open(metadata: SessionMetadata): Promise<Session> {
		return new Session(this.requireStorage(metadata.id));
	}

	async list(): Promise<SessionMetadata[]> {
		return Promise.all([...this.sessions.values()].map((storage) => storage.getMetadata()));
	}

	async delete(metadata: SessionMetadata): Promise<void> {
		this.sessions.delete(metadata.id);
	}

	async fork(source: SessionMetadata, options: ForkOptions & SessionCreateOptions = {}): Promise<Session> {
		const sourceStorage = this.requireStorage(source.id);
		const id = options.id ?? uuidv7();
		if (this.sessions.has(id)) throw new SessionError("already_exists", `Session already exists: ${id}`);
		const storage = sourceStorage.fork(
			{ id, createdAt: Date.now(), parentSessionId: options.parentSessionId ?? source.id },
			options,
		);
		this.sessions.set(id, storage);
		return new Session(storage);
	}

	private requireStorage(id: string): InMemorySessionStorage {
		const storage = this.sessions.get(id);
		if (!storage) throw new SessionError("not_found", `Session not found: ${id}`);
		return storage;
	}
}
