import { uuidv7 } from "@aos-agent/ai";
import { type SessionMutation, SessionState } from "../state.ts";
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
} from "../durable/types.ts";
import { DurableLedgerError } from "../durable/errors.ts";
import { encodeFoundationMutation, isFoundationMutationLine, parseFoundationMutation } from "../durable/codec.ts";
import { FoundationLedgerState, prepareForkFoundationRecords } from "../durable/state.ts";
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
	SessionError,
	type SessionStats,
	type SessionStorage,
} from "../types.ts";
import { encodeHeader, encodeMutation, metadataFromHeader, parseSessionHeader, parseMutation } from "./codec.ts";
import { fileResult, invalidFile, isTruncatedJsonLine, JsonlDecodeError } from "./errors.ts";
import { migrateSessionFile, planSessionMigration, type DurableJsonlFileSystem } from "./migration.ts";
import type { JsonlSessionMetadata, JsonlV4Header } from "./types.ts";

const WRITER_LOCK_TTL_MS = 30_000;

interface WriterLockRecord {
	ownerId: string;
	token: string;
	expiresAt: number;
}

/**
 * Build a complete sibling temporary file, then atomically rename it over the destination.
 * The populate callback must create or overwrite `tempPath` with the complete file. The
 * destination is untouched until the rename commits, so a process crash while populating
 * can leave only the ignored `.tmp` file behind.
 *
 * Rejects when population or rename fails. On rejection, temporary-file removal is
 * best-effort and the original error is preserved. Callers must serialize publications to
 * the same destination because they share its deterministic `.tmp` path.
 */
async function publishFileAtomically(
	fs: DurableJsonlFileSystem,
	destinationPath: string,
	populate: (tempPath: string) => Promise<void>,
): Promise<void> {
	const tempPath = `${destinationPath}.tmp`;
	try {
		await populate(tempPath);
		fileResult(await fs.renameFile(tempPath, destinationPath), `Failed to publish staged file ${destinationPath}`);
		if (fs.syncDirectory !== undefined) {
			const parent = destinationPath.replace(/[\\/][^\\/]*$/, "") || ".";
			const result = await fs.syncDirectory(parent);
			if (result !== undefined) fileResult(result, `Failed to sync parent directory ${parent}`);
		}
	} catch (error) {
		await fs.remove(tempPath, { force: true });
		throw error;
	}
}

function classifyPersistedDurableError(path: string, line: number, error: unknown): DurableLedgerError {
	if (error instanceof DurableLedgerError) {
		if (error.code === "session_ledger_unknown_format" || error.code === "session_ledger_corrupt") return error;
		return new DurableLedgerError("session_ledger_corrupt", `Invalid durable ledger ${path}: line ${line} ${error.message}`, {
			cause: error,
		});
	}
	return new DurableLedgerError("session_ledger_corrupt", `Invalid durable ledger ${path}: line ${line}`, {
		cause: error instanceof Error ? error : undefined,
	});
}

export class JsonlSessionStorage implements SessionStorage<JsonlSessionMetadata>, DurableLedgerApi {
	private readonly fs: DurableJsonlFileSystem;
	private metadata: JsonlSessionMetadata;
	private state = new SessionState();
	private durableState: FoundationLedgerState;
	private tail: Promise<void> = Promise.resolve();
	private durableReady = false;
	private static readonly durableTails = new Map<string, Promise<void>>();
	private readonly writerLockPath: string;

	constructor(fs: DurableJsonlFileSystem, metadata: JsonlSessionMetadata) {
		this.fs = fs;
		this.metadata = structuredClone(metadata);
		this.durableState = new FoundationLedgerState({ sessionId: metadata.id });
		this.writerLockPath = `${metadata.path}.lease-lock`;
	}

	static async create(
		fs: DurableJsonlFileSystem,
		path: string,
		header: JsonlV4Header,
	): Promise<JsonlSessionStorage> {
		if (fs.createExclusive === undefined) {
			throw new DurableLedgerError("session_writer_busy", `Session writer lock capability is unavailable: ${path}`);
		}
		fileResult(await fs.writeFile(path, encodeHeader(header)), `Failed to initialize session ${path}`);
		if (fs.syncFile !== undefined) {
			const result = await fs.syncFile(path);
			if (result !== undefined) fileResult(result, `Failed to sync session header ${path}`);
		}
		if (fs.syncDirectory !== undefined) {
			const parent = path.replace(/[\\/][^\\/]*$/, "") || ".";
			const result = await fs.syncDirectory(parent);
			if (result !== undefined) fileResult(result, `Failed to sync session directory ${parent}`);
		}
		const fileInfo = fileResult(await fs.fileInfo(path), `Failed to read session metadata ${path}`);
		return new JsonlSessionStorage(fs, metadataFromHeader(header, path, fileInfo.mtimeMs));
	}

	static async load(fs: DurableJsonlFileSystem, path: string): Promise<JsonlSessionStorage> {
		const content = fileResult(await fs.readTextFile(path), `Failed to read session ${path}`);
		const physicalLines = content.split("\n");
		if (physicalLines.at(-1) === "") physicalLines.pop();
		if (physicalLines.length === 0 || !physicalLines[0]) {
			throw invalidFile(path, 1, new JsonlDecodeError("schema", "is missing a header"));
		}
		const headerResult = parseSessionHeader(physicalLines[0]);
		if (!headerResult.ok) {
			if (headerResult.error.message.includes("unsupported durable schema")) {
				throw new DurableLedgerError("session_ledger_unknown_format", `Unsupported durable session schema in ${path}`);
			}
			throw invalidFile(path, 1, headerResult.error);
		}
		const fileInfo = fileResult(await fs.fileInfo(path), `Failed to read session metadata ${path}`);
		const storage = new JsonlSessionStorage(fs, metadataFromHeader(headerResult.value, path, fileInfo.mtimeMs));
		for (let index = 1; index < physicalLines.length; index++) {
			const line = physicalLines[index]!;
			if (isFoundationMutationLine(line)) {
				const foundationResult = parseFoundationMutation(line);
				if (!foundationResult.ok) {
					const code = foundationResult.error.message.includes("unsupported durable schema")
						? "session_ledger_unknown_format"
						: "session_ledger_corrupt";
					throw new DurableLedgerError(code, `Invalid durable ledger ${path}: line ${index + 1} ${foundationResult.error.message}`);
				}
				try {
					storage.durableState.applyPersistedRecord(foundationResult.value);
					storage.state.observeExternalSequence(foundationResult.value.seq, foundationResult.value.id, foundationResult.value);
				} catch (error) {
					throw classifyPersistedDurableError(path, index + 1, error);
				}
				continue;
			}
			const mutationResult = parseMutation(line);
			if (!mutationResult.ok) {
				const isTornTail =
					index === physicalLines.length - 1 &&
					mutationResult.error.kind === "syntax" &&
					isTruncatedJsonLine(line);
				if (isTornTail) {
					if (fs.createExclusive === undefined) {
						throw new DurableLedgerError("session_writer_busy", `Session writer lock capability is unavailable: ${path}`);
					}
					// Repair only after acquiring the same writer lease used by normal appends.
					// Re-read while locked so a writer that committed after this load began is
					// never discarded by publishing a stale prefix.
					await storage.withWriterLock(async (lockToken) => {
						await storage.assertWriterLockOwned(lockToken);
						const current = fileResult(await fs.readTextFile(path), `Failed to read session ${path}`);
						const currentLines = current.split("\n");
						if (currentLines.at(-1) === "") currentLines.pop();
						const currentTail = currentLines.at(-1);
						if (currentTail !== undefined) {
							const currentMutation = isFoundationMutationLine(currentTail)
								? parseFoundationMutation(currentTail)
								: parseMutation(currentTail);
							if (!currentMutation.ok && currentMutation.error.kind === "syntax" && isTruncatedJsonLine(currentTail)) {
								const validPrefix = `${currentLines.slice(0, -1).join("\n")}\n`;
								await publishFileAtomically(fs, path, async (tempPath) => {
									fileResult(await fs.writeFile(tempPath, validPrefix), `Failed to stage torn-tail repair ${path}`);
								});
							}
						}
						await storage.assertWriterLockOwned(lockToken);
					});
					return JsonlSessionStorage.load(fs, path);
				}
				if (headerResult.value.version === 5) {
					throw new DurableLedgerError("session_ledger_corrupt", `Invalid durable ledger ${path}: line ${index + 1} ${mutationResult.error.message}`);
				}
				throw invalidFile(path, index + 1, mutationResult.error);
			}
			try {
				storage.applyMutation(mutationResult.value);
			} catch (error) {
				if (error instanceof SessionError && error.code === "invalid_entry") {
					throw invalidFile(path, index + 1, error);
				}
				throw error;
			}
		}
		if (!content.endsWith("\n")) {
			if (fs.createExclusive === undefined) {
				throw new DurableLedgerError("session_writer_busy", `Session writer lock capability is unavailable: ${path}`);
			}
			await storage.withWriterLock(async (lockToken) => {
				await storage.assertWriterLockOwned(lockToken);
				const current = fileResult(await fs.readTextFile(path), `Failed to read session ${path}`);
				if (!current.endsWith("\n")) {
					fileResult(await fs.appendFile(path, "\n"), `Failed to repair unterminated session tail ${path}`);
					await storage.syncPublishedFile(path, `session tail ${path}`);
				}
				await storage.assertWriterLockOwned(lockToken);
			});
		}
		return storage;
	}

	async fork(path: string, header: JsonlV4Header, options: ForkOptions): Promise<JsonlSessionStorage> {
		const mutations = this.state.createForkMutations(options);
		const lanes = options.scope === "tree" ? new Set(this.state.getLanes().map((pointer) => pointer.lane)) : new Set(["main"]);
		const foundationRecords = prepareForkFoundationRecords(this.durableState.getRecords(), {
			targetSessionId: header.id,
			laneIds: lanes,
			firstSequence: mutations.length,
		});
		await publishFileAtomically(this.fs, path, async (tempPath) => {
			const targetStorage = await JsonlSessionStorage.create(this.fs, tempPath, header);
			for (const mutation of mutations) {
				await targetStorage.appendMutation(() => mutation);
			}
			for (const record of foundationRecords) {
				fileResult(await this.fs.appendFile(tempPath, encodeFoundationMutation(record)), `Failed to append fork durable ledger ${tempPath}`);
			}
			if (foundationRecords.length > 0) await targetStorage.syncPublishedFile(tempPath, `fork durable ledger ${tempPath}`);
		});
		return JsonlSessionStorage.load(this.fs, path);
	}

	async drain(): Promise<void> {
		await this.tail;
	}

	async getMetadata(): Promise<JsonlSessionMetadata> {
		return structuredClone(this.metadata);
	}

	async getLanes(): Promise<LanePointer[]> {
		return this.state.getLanes();
	}

	createLane(lane: string, at: string | null): Promise<void> {
		return this.enqueue(async () => {
			await this.appendMutation(() => {
				this.state.validateNewLane(lane);
				this.state.validateTarget(at);
				return { kind: "lane", seq: this.state.nextSequence, lane, leafId: at };
			});
		});
	}

	moveLane(lane: string, to: string | null): Promise<void> {
		return this.enqueue(async () => {
			await this.appendMutation(() => {
				this.state.requireLane(lane);
				this.state.validateTarget(to);
				return { kind: "lane", seq: this.state.nextSequence, lane, leafId: to };
			});
		});
	}

	appendEntry<TEntry extends Entry>(newEntry: ProvisionedEntry<TEntry>, lane: string): Promise<TEntry> {
		return this.enqueue(async () => {
			const mutation = await this.appendMutation(() => {
				const parentId = this.state.requireLane(lane);
				this.state.validateUnusedId(newEntry.id);
				const entry = {
					...structuredClone(newEntry),
					parentId,
					seq: this.state.nextSequence,
					timestamp: Date.now(),
				} as unknown as TEntry;
				return { kind: "entry", lane, entry };
			});
			return structuredClone(mutation.entry as TEntry);
		});
	}

	appendRecord<TRecord extends LaneRecord>(newRecord: NewRecord<TRecord>): Promise<TRecord> {
		return this.enqueue(async () => {
			const mutation = await this.appendMutation(() => {
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
				return { kind: "record", record };
			});
			return structuredClone(mutation.record as TRecord);
		});
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

	setName(name: string | undefined): Promise<void> {
		return this.enqueue(async () => {
			await this.appendMutation(() => ({ kind: "fact", seq: this.state.nextSequence, fact: "name", name }));
		});
	}

	async getLabel(id: string): Promise<string | undefined> {
		return this.state.getLabel(id);
	}

	setLabel(id: string, label: string | undefined): Promise<void> {
		return this.enqueue(async () => {
			await this.appendMutation(() => {
				this.state.validateTarget(id);
				return {
					kind: "fact",
					seq: this.state.nextSequence,
					fact: "label",
					targetId: id,
					label,
				};
			});
		});
	}

	async getStats(): Promise<SessionStats> {
		return structuredClone(this.state.getStats());
	}

	acquireWriterLease(options: AcquireWriterLeaseOptionsV1): Promise<LedgerWriterLeaseV1> {
		return this.enqueueDurable(() => this.withWriterLock(async (lockToken) => {
			await this.ensureDurableReady(lockToken);
			await this.refreshDurableState();
			await this.loadLeaseSidecar();
			await this.assertWriterLockOwned(lockToken);
			const previous = this.durableState.getStoredWriterLease();
			const previousRevision = this.durableState.getLeaseRevision();
			try {
				const lease = this.durableState.acquireWriterLease(options);
				await this.assertWriterLockOwned(lockToken);
				await this.saveLeaseSidecar(lease);
				return lease;
			} catch (error) {
				this.durableState.restoreLease(previous, previousRevision);
				throw error;
			}
		}));
	}

	renewWriterLease(options: RenewWriterLeaseOptionsV1): Promise<LedgerWriterLeaseV1> {
		return this.enqueueDurable(() => this.withWriterLock(async (lockToken) => {
			await this.ensureDurableReady(lockToken);
			await this.refreshDurableState();
			await this.loadLeaseSidecar();
			await this.assertWriterLockOwned(lockToken);
			const previous = this.durableState.getStoredWriterLease();
			try {
				const lease = this.durableState.renewWriterLease(options);
				await this.assertWriterLockOwned(lockToken);
				await this.saveLeaseSidecar(lease);
				return lease;
			} catch (error) {
				this.durableState.restoreLease(previous);
				throw error;
			}
		}));
	}

	releaseWriterLease(options: ReleaseWriterLeaseOptionsV1): Promise<void> {
		return this.enqueueDurable(() => this.withWriterLock(async (lockToken) => {
			await this.ensureDurableReady(lockToken);
			await this.refreshDurableState();
			await this.loadLeaseSidecar();
			await this.assertWriterLockOwned(lockToken);
			const previous = this.durableState.getStoredWriterLease();
			try {
				this.durableState.releaseWriterLease(options);
				await this.assertWriterLockOwned(lockToken);
				await this.saveLeaseSidecar(this.durableState.getStoredWriterLease());
			} catch (error) {
				this.durableState.restoreLease(previous);
				throw error;
			}
		}));
	}

	getWriterLease(): Promise<LedgerWriterLeaseV1 | null> {
		return this.enqueueDurable(async () => {
			await this.ensureDurableReady();
			await this.refreshDurableState();
			await this.loadLeaseSidecar();
			return this.durableState.getWriterLease();
		});
	}

	getLedgerRevision(): Promise<number> {
		return this.enqueueDurable(async () => {
			await this.ensureDurableReady();
			await this.refreshSessionState();
			await this.refreshDurableState();
			return this.state.nextSequence - 1;
		});
	}

	appendFoundationRecord(record: ProvisionedFoundationRecordV1): Promise<AppendFoundationRecordResultV1> {
		return this.enqueueDurable(() => this.withWriterLock(async (lockToken) => {
			await this.ensureDurableReady(lockToken);
			await this.refreshSessionState();
			await this.refreshDurableState();
			this.alignDurableCursor();
			await this.loadLeaseSidecar();
			await this.assertWriterLockOwned(lockToken);
			const prepared = this.durableState.prepareAppend(record);
			if ("replayed" in prepared) return prepared;
			this.state.validateUnusedId(prepared.record.id);
			await this.loadLeaseSidecar();
			this.durableState.assertActiveFence(prepared.record.fencingToken ?? "");
			await this.appendFoundationMutation(prepared.record, lockToken);
			this.durableState.assertActiveFence(prepared.record.fencingToken ?? "");
			const accepted = this.durableState.commitPrepared(prepared);
			this.state.observeExternalSequence(accepted.seq, accepted.id, accepted);
			return { record: accepted, replayed: false };
		}));
	}

	setRetentionPolicy(policy: FoundationRetentionPolicyV1, options: SetRetentionPolicyOptionsV1): Promise<AppendFoundationRecordResultV1> {
		return this.enqueueDurable(() => this.withWriterLock(async (lockToken) => {
			await this.ensureDurableReady(lockToken);
			await this.refreshSessionState();
			await this.refreshDurableState();
			this.alignDurableCursor();
			await this.loadLeaseSidecar();
			await this.assertWriterLockOwned(lockToken);
			const prepared = this.durableState.prepareAppend({
				schemaVersion: 1,
				kind: "retention",
				id: `retention:${options.clientRequestId}`,
				lane: "main",
				retentionRevision: this.durableState.getRetentionRevision() + 1,
				policy,
				clientRequestId: options.clientRequestId,
				...(options.expectedRevision === undefined ? {} : { expectedRevision: options.expectedRevision }),
				...(options.fencingToken === undefined ? {} : { fencingToken: options.fencingToken }),
				correlation: options.correlation,
			});
			if ("replayed" in prepared) return prepared;
			this.state.validateUnusedId(prepared.record.id);
			await this.loadLeaseSidecar();
			this.durableState.assertActiveFence(prepared.record.fencingToken ?? "");
			await this.appendFoundationMutation(prepared.record, lockToken);
			this.durableState.assertActiveFence(prepared.record.fencingToken ?? "");
			const accepted = this.durableState.commitPrepared(prepared);
			this.state.observeExternalSequence(accepted.seq, accepted.id, accepted);
			return { record: accepted, replayed: false };
		}));
	}

	findFoundationRecords(query?: FoundationRecordQueryV1): Promise<FoundationRecordV1[]> {
		return this.enqueueDurable(async () => {
			await this.ensureDurableReady();
			await this.refreshDurableState();
			return this.durableState.findFoundationRecords(query);
		});
	}

	getFoundationObject(objectType: string, objectId: string): Promise<FoundationObjectResultV1 | undefined> {
		return this.enqueueDurable(async () => {
			await this.ensureDurableReady();
			await this.refreshDurableState();
			return this.durableState.getFoundationObject(objectType, objectId);
		});
	}

	getFoundationRevision(objectType: string, objectId: string): Promise<number> {
		return this.enqueueDurable(async () => {
			await this.ensureDurableReady();
			await this.refreshDurableState();
			return this.durableState.getFoundationRevision(objectType, objectId);
		});
	}

	isObjectTombstoned(objectType: string, objectId: string): Promise<boolean> {
		return this.enqueueDurable(async () => {
			await this.ensureDurableReady();
			await this.refreshDurableState();
			return this.durableState.isObjectTombstoned(objectType, objectId);
		});
	}

	getRetentionPolicy(): Promise<FoundationRetentionPolicyV1 | undefined> {
		return this.enqueueDurable(async () => {
			await this.ensureDurableReady();
			await this.refreshDurableState();
			return this.durableState.getRetentionPolicy();
		});
	}

	prunableFoundationRecords(): Promise<readonly FoundationRecordV1[]> {
		return this.enqueueDurable(async () => {
			await this.ensureDurableReady();
			await this.refreshDurableState();
			return this.durableState.prunableFoundationRecords();
		});
	}

	private enqueueDurable<T>(operation: () => Promise<T>): Promise<T> {
		const previous = JsonlSessionStorage.durableTails.get(this.metadata.path) ?? Promise.resolve();
		const result = previous.then(() => this.enqueue(operation));
		JsonlSessionStorage.durableTails.set(
			this.metadata.path,
			result.then(
				() => undefined,
				() => undefined,
			),
		);
		return result;
	}

	private async ensureDurableReady(lockToken?: string): Promise<void> {
		if (this.durableReady) return;
		if (lockToken === undefined) {
			await this.withWriterLock((ownedToken) => this.ensureDurableReadyWhileLocked(ownedToken));
			return;
		}
		await this.ensureDurableReadyWhileLocked(lockToken);
	}

	private async ensureDurableReadyWhileLocked(lockToken: string): Promise<void> {
		if (this.durableReady) return;
		await this.assertWriterLockOwned(lockToken);
		const content = fileResult(await this.fs.readTextFile(this.metadata.path), `Failed to read session ${this.metadata.path}`);
		const lines = content.split("\n");
		if (lines.at(-1) === "") lines.pop();
		const firstLine = lines[0];
		if (firstLine === undefined) throw new DurableLedgerError("session_ledger_corrupt", "Session is missing a header");
		const headerResult = parseSessionHeader(firstLine);
		if (!headerResult.ok) throw new DurableLedgerError("session_ledger_unknown_format", headerResult.error.message);
		if (headerResult.value.version === 4) {
			const plan = planSessionMigration(this.metadata.path, headerResult.value, lines.slice(1));
			await migrateSessionFile(this.fs, plan);
			await this.assertWriterLockOwned(lockToken);
			const info = fileResult(await this.fs.fileInfo(this.metadata.path), `Failed to read session metadata ${this.metadata.path}`);
			this.metadata = metadataFromHeader(plan.targetHeader, this.metadata.path, info.mtimeMs);
		} else {
			const info = fileResult(await this.fs.fileInfo(this.metadata.path), `Failed to read session metadata ${this.metadata.path}`);
			this.metadata = metadataFromHeader(headerResult.value, this.metadata.path, info.mtimeMs);
		}
		this.durableReady = true;
		await this.assertWriterLockOwned(lockToken);
	}

	/**
	 * Rebuild the Session reducer from the physical JSONL while the caller owns
	 * the writer transaction. A storage instance may have been opened before a
	 * different instance appended, so local state cannot be used to allocate a
	 * sequence or validate the shared id namespace.
	 */
	private async refreshSessionState(): Promise<void> {
		const content = fileResult(await this.fs.readTextFile(this.metadata.path), `Failed to read session ${this.metadata.path}`);
		const lines = content.split("\n");
		if (lines.at(-1) === "") lines.pop();
		if (lines.length === 0) throw new DurableLedgerError("session_ledger_corrupt", `Session is missing a header: ${this.metadata.path}`);
		const refreshed = new SessionState();
		for (let index = 1; index < lines.length; index++) {
			const line = lines[index]!;
			if (isFoundationMutationLine(line)) {
				const result = parseFoundationMutation(line);
				if (!result.ok) {
					throw new DurableLedgerError(
						result.error.message.includes("unsupported durable schema") ? "session_ledger_unknown_format" : "session_ledger_corrupt",
						`Invalid durable ledger ${this.metadata.path}: line ${index + 1} ${result.error.message}`,
					);
				}
				try {
					refreshed.observeExternalSequence(result.value.seq, result.value.id, result.value);
				} catch (error) {
					throw new DurableLedgerError("session_ledger_corrupt", `Invalid shared Session namespace ${this.metadata.path}: line ${index + 1}`, {
						cause: error instanceof Error ? error : undefined,
					});
				}
				continue;
			}
			const result = parseMutation(line);
			if (!result.ok) {
				throw new DurableLedgerError("session_ledger_corrupt", `Invalid session mutation ${this.metadata.path}: line ${index + 1} ${result.error.message}`);
			}
			try {
				refreshed.applyMutation(result.value);
			} catch (error) {
				throw new DurableLedgerError("session_ledger_corrupt", `Invalid Session reducer state ${this.metadata.path}: line ${index + 1}`, {
					cause: error instanceof Error ? error : undefined,
				});
			}
		}
		this.state = refreshed;
	}

	private async refreshDurableState(): Promise<void> {
		const content = fileResult(await this.fs.readTextFile(this.metadata.path), `Failed to read session ${this.metadata.path}`);
		const lines = content.split("\n");
		if (lines.at(-1) === "") lines.pop();
		const refreshed = new FoundationLedgerState({ sessionId: this.metadata.id });
		for (let index = 1; index < lines.length; index++) {
			const line = lines[index]!;
			if (!isFoundationMutationLine(line)) {
				const mutation = parseMutation(line);
				if (!mutation.ok) throw new DurableLedgerError("session_ledger_corrupt", `Invalid session mutation ${this.metadata.path}: line ${index + 1}`);
				refreshed.observeExternalSequence(mutation.value.kind === "entry" ? mutation.value.entry.seq : mutation.value.kind === "record" ? mutation.value.record.seq : mutation.value.seq);
				continue;
			}
			const result = parseFoundationMutation(line);
			if (!result.ok) {
				throw new DurableLedgerError(
					result.error.message.includes("unsupported durable schema") ? "session_ledger_unknown_format" : "session_ledger_corrupt",
					`Invalid durable ledger ${this.metadata.path}: line ${index + 1} ${result.error.message}`,
				);
			}
			try {
				refreshed.applyPersistedRecord(result.value);
			} catch (error) {
				throw classifyPersistedDurableError(this.metadata.path, index + 1, error);
			}
		}
		this.durableState = refreshed;
	}

	private leasePath(): string {
		return `${this.metadata.path}.lease`;
	}

	private async loadLeaseSidecar(): Promise<void> {
		const path = this.leasePath();
		if (!fileResult(await this.fs.exists(path), `Failed to check writer lease ${path}`)) {
			this.durableState.restoreLease(null);
			return;
		}
		const text = fileResult(await this.fs.readTextFile(path), `Failed to read writer lease ${path}`);
		let value: unknown;
		try {
			value = JSON.parse(text);
		} catch (error) {
			throw new DurableLedgerError("session_ledger_corrupt", `Writer lease ${path} is not valid JSON`, {
				cause: error instanceof Error ? error : undefined,
			});
		}
		if (typeof value !== "object" || value === null || Array.isArray(value)) throw new DurableLedgerError("session_ledger_corrupt", `Writer lease ${path} is not an object`);
		const lease = value as Record<string, unknown>;
		const allowed = new Set(["schemaVersion", "ownerId", "leaseRevision", "fencingToken", "acquiredAt", "expiresAt"]);
		if (Object.keys(lease).some((key) => !allowed.has(key)) || lease.schemaVersion !== 1) throw new DurableLedgerError("session_ledger_unknown_format", `Writer lease ${path} has an unsupported schema`);
		if (typeof lease.ownerId !== "string" || typeof lease.fencingToken !== "string" || !Number.isSafeInteger(lease.leaseRevision) || !Number.isSafeInteger(lease.acquiredAt) || !Number.isSafeInteger(lease.expiresAt)) {
			throw new DurableLedgerError("session_ledger_corrupt", `Writer lease ${path} has invalid fields`);
		}
		this.durableState.restoreLease(lease as unknown as LedgerWriterLeaseV1, lease.leaseRevision as number);
	}

	private async saveLeaseSidecar(lease: LedgerWriterLeaseV1 | null): Promise<void> {
		const path = this.leasePath();
		if (lease === null) {
			fileResult(await this.fs.remove(path, { force: true }), `Failed to remove writer lease ${path}`);
			return;
		}
		await publishFileAtomically(this.fs, path, async (temporaryPath) => {
			fileResult(await this.fs.writeFile(temporaryPath, `${JSON.stringify(lease)}\n`), `Failed to stage writer lease ${path}`);
			if (this.fs.syncFile !== undefined) {
				const result = await this.fs.syncFile(temporaryPath);
				if (result !== undefined) fileResult(result, `Failed to sync writer lease ${path}`);
			}
			if (this.fs.closeFile !== undefined) {
				const result = await this.fs.closeFile(temporaryPath);
				if (result !== undefined) fileResult(result, `Failed to close writer lease ${path}`);
			}
		});
	}

	private async appendFoundationMutation(record: FoundationRecordV1, lockToken: string): Promise<void> {
		await this.assertWriterLockOwned(lockToken);
		await this.assertDiskSequence(record.seq - 1);
		await this.assertWriterLockOwned(lockToken);
		fileResult(
			await this.fs.appendFile(this.metadata.path, encodeFoundationMutation(record)),
			`Failed to append durable ledger ${this.metadata.path}`,
		);
		await this.syncPublishedFile(this.metadata.path, `durable ledger ${this.metadata.path}`);
		await this.assertWriterLockOwned(lockToken);
	}

	private enqueue<T>(operation: () => Promise<T>): Promise<T> {
		const result = this.tail.then(operation);
		this.tail = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	}

	private async appendMutation<TMutation extends SessionMutation>(prepare: () => TMutation): Promise<TMutation> {
		return this.withWriterLock(async (lockToken) => {
			await this.ensureDurableReady(lockToken);
			await this.refreshSessionState();
			await this.refreshDurableState();
			const mutation = prepare();
			const sequence = mutation.kind === "entry" ? mutation.entry.seq : mutation.kind === "record" ? mutation.record.seq : mutation.seq;
			await this.assertWriterLockOwned(lockToken);
			await this.assertDiskSequence(sequence - 1);
			await this.assertWriterLockOwned(lockToken);
			fileResult(
				await this.fs.appendFile(this.metadata.path, encodeMutation(mutation)),
				`Failed to append session ${this.metadata.path}`,
			);
			await this.syncPublishedFile(this.metadata.path, `session ${this.metadata.path}`);
			await this.assertWriterLockOwned(lockToken);
			this.applyMutation(mutation);
			return mutation;
		});
	}

	private applyMutation(mutation: SessionMutation): void {
		this.state.applyMutation(mutation);
		const sequence = mutation.kind === "entry" ? mutation.entry.seq : mutation.kind === "record" ? mutation.record.seq : mutation.seq;
		this.durableState.observeExternalSequence(sequence);
	}

	private async withWriterLock<T>(operation: (lockToken: string) => Promise<T>): Promise<T> {
		if (this.fs.createExclusive === undefined) {
			throw new DurableLedgerError("session_writer_busy", `Session writer lock capability is unavailable: ${this.metadata.path}`);
		}
		const ownerId = `session:${this.metadata.id}`;
		const token = uuidv7();
		const lock = JSON.stringify({ ownerId, token, expiresAt: Date.now() + WRITER_LOCK_TTL_MS });
		// A failed exclusive create is fail-closed. Reading an expired lock and
		// removing it is not compare-and-delete: another contender can replace it
		// between those operations, allowing the stale remover to delete the live
		// contender's token. Recovery must leave the lock for an explicit owner or
		// an OS-level CAS-capable implementation.
		const result = await this.fs.createExclusive(this.writerLockPath, lock);
		if (!result.ok) throw new DurableLedgerError("session_writer_busy", `Session writer lock is busy: ${this.metadata.path}`);
		try {
			await this.assertWriterLockOwned(token);
			const value = await operation(token);
			await this.assertWriterLockOwned(token);
			return value;
		} finally {
			await this.releaseWriterLock(token);
		}
	}

	private async readWriterLock(): Promise<WriterLockRecord | null> {
		const exists = await this.fs.exists(this.writerLockPath);
		if (!exists.ok || !exists.value) return null;
		const text = await this.fs.readTextFile(this.writerLockPath);
		if (!text.ok) return null;
		try {
			const value: unknown = JSON.parse(text.value);
			if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
			const record = value as Record<string, unknown>;
			if (typeof record.ownerId !== "string" || typeof record.token !== "string" || typeof record.expiresAt !== "number" || !Number.isFinite(record.expiresAt)) return null;
			return { ownerId: record.ownerId, token: record.token, expiresAt: record.expiresAt };
		} catch {
			return null;
		}
	}

	private async assertWriterLockOwned(token: string): Promise<void> {
		if (this.fs.createExclusive === undefined) return;
		const record = await this.readWriterLock();
		if (record === null || record.token !== token) throw new DurableLedgerError("session_writer_lease_lost", `Session writer lock is no longer owned: ${this.metadata.path}`);
	}

	private async releaseWriterLock(token: string): Promise<void> {
		const record = await this.readWriterLock();
		if (record === null || record.token !== token) return;
		await this.fs.remove(this.writerLockPath, { force: true });
	}

	private async assertDiskSequence(expected: number): Promise<void> {
		const content = fileResult(await this.fs.readTextFile(this.metadata.path), `Failed to read session ${this.metadata.path}`);
		const lines = content.split("\n").filter((line) => line.length > 0);
		let sequence = 0;
		for (const line of lines.slice(1)) {
			if (isFoundationMutationLine(line)) {
				const foundation = parseFoundationMutation(line);
				if (!foundation.ok) throw new DurableLedgerError("session_ledger_corrupt", `Invalid durable ledger ${this.metadata.path}`);
				sequence = foundation.value.seq;
			} else {
				const mutation = parseMutation(line);
				if (!mutation.ok) throw new DurableLedgerError("session_ledger_corrupt", `Invalid session mutation ${this.metadata.path}`);
				sequence = mutation.value.kind === "entry" ? mutation.value.entry.seq : mutation.value.kind === "record" ? mutation.value.record.seq : mutation.value.seq;
			}
		}
		if (sequence !== expected) {
			throw new DurableLedgerError("session_writer_stale_revision", `Session writer cursor is stale: expected ${expected}, found ${sequence}`, {
				expectedRevision: expected,
				actualRevision: sequence,
			});
		}
	}

	private async syncPublishedFile(path: string, description: string): Promise<void> {
		if (this.fs.syncFile !== undefined) {
			const result = await this.fs.syncFile(path);
			if (result !== undefined) fileResult(result, `Failed to sync ${description}`);
		}
		if (this.fs.closeFile !== undefined) {
			const result = await this.fs.closeFile(path);
			if (result !== undefined) fileResult(result, `Failed to close ${description}`);
		}
	}

	private alignDurableCursor(): void {
		const sharedSequence = this.state.nextSequence - 1;
		const durableSequence = this.durableState.getLedgerRevision();
		if (durableSequence > sharedSequence) {
			throw new DurableLedgerError("session_writer_stale_revision", "Foundation reducer is ahead of the Session cursor", {
				actualRevision: durableSequence,
			});
		}
		while (this.durableState.getLedgerRevision() < sharedSequence) {
			this.durableState.observeExternalSequence(this.durableState.getLedgerRevision() + 1);
		}
	}
}
