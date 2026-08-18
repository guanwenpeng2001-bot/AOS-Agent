import { newFoundationId, type FoundationJsonValue } from "../foundation/index.ts";
import {
	SessionArtifactStore,
	type ArtifactBlobStore,
	type ArtifactPutOptions,
	type ArtifactReference,
} from "../artifacts.ts";
import {
	SessionMemoryStore,
	type MemoryEntry,
	type MemoryPolicy,
	type MemoryQuery,
	type NewMemoryEntry,
} from "../memory/memory.ts";
import type { Session } from "../session/session.ts";
import { SessionLedgerWriter, T5_LEDGER_OBJECT_TYPES, type SessionLedgerWriterOptions } from "../session/t5.ts";
import {
	contextSnapshotFromJSON,
	createContextSnapshot,
	type ContextSnapshot,
	type ContextSnapshotOptions,
	type ContextSnapshotV1,
} from "./snapshot.ts";
import {
	createCheckpoint,
	digestCheckpointTranscript,
	planCheckpointRewind,
	validateCheckpointImpactPlan,
	type CheckpointImpactPlanV1,
	type CheckpointPlanOptions,
	type CheckpointV1,
	type WorkspaceCheckpointState,
} from "./checkpoint.ts";
import {
	resolveInstructionSources,
	type InstructionLockV1,
	type InstructionResolution,
	type InstructionSourceInput,
	type InstructionSourceV1,
} from "./instruction.ts";
import { compactContext, type CompactionRecordV1, type T5CompactionReason } from "./compaction.ts";

export interface SessionT5LedgerOptions extends SessionLedgerWriterOptions {
	readonly artifacts?: SessionArtifactStore;
	readonly artifactBlobStore?: ArtifactBlobStore;
	readonly memoryPolicy?: MemoryPolicy;
	readonly now?: () => number;
}

export interface PromptCacheRecordV1 {
	readonly schemaVersion: 1;
	readonly cacheEntryId: string;
	readonly cacheKey: string;
	readonly snapshotId: string;
	readonly modelId: string;
	readonly policyDigest: string;
	readonly bindingEpochId: string;
	readonly cacheEpoch: number;
	readonly valueRef?: ArtifactReference;
	readonly valueDigest?: string;
	readonly inputTokens?: number;
	readonly outputTokens?: number;
	readonly cost?: number;
	readonly status: "valid" | "invalidated";
	readonly createdAt: number;
	readonly expiresAt?: number;
}

export interface PromptCacheWriteOptions {
	readonly cacheEntryId?: string;
	readonly cacheKey: string;
	readonly snapshotId: string;
	readonly modelId: string;
	readonly policyDigest: string;
	readonly bindingEpochId: string;
	readonly cacheEpoch: number;
	readonly value?: Uint8Array;
	readonly valueRef?: ArtifactReference;
	readonly valueDigest?: string;
	readonly inputTokens?: number;
	readonly outputTokens?: number;
	readonly cost?: number;
	readonly expiresAt?: number;
	readonly clientRequestId?: string;
}

export interface PromptCacheLookup {
	readonly record: PromptCacheRecordV1;
	readonly value?: Uint8Array;
}

export interface SessionRewindPlanV1 extends CheckpointImpactPlanV1 {
	readonly planId: string;
	readonly lane: string;
}

export interface RewindExecutionV1 {
	readonly schemaVersion: 1;
	readonly planId: string;
	readonly lane: string;
	readonly targetEntryId: string | null;
	readonly status: "applying" | "applied" | "failed";
	readonly startedAt: number;
	readonly appliedAt?: number;
	readonly error?: string;
}

export interface RewindPlanOptions extends Omit<CheckpointPlanOptions, "checkpointId"> {
	readonly snapshotId: string;
	readonly planId?: string;
	readonly lane: string;
	readonly checkpointId: string;
}

export interface CompactionWriteOptions {
	readonly compactionId?: string;
	readonly snapshotId: string;
	readonly retainEntries?: number;
	readonly reason?: T5CompactionReason;
	readonly summary?: string;
	readonly artifact?: ArtifactPutOptions;
	readonly clientRequestId?: string;
}

export interface InstructionLockOptions {
	readonly locked?: boolean;
	readonly managed?: boolean;
	readonly reason: string;
	readonly lockedBy: string;
	readonly clientRequestId?: string;
}

function asFoundationJson<T>(value: T): FoundationJsonValue {
	return value as unknown as FoundationJsonValue;
}

function requireRecord<T>(value: T | undefined, message: string): T {
	if (value === undefined) throw new Error(message);
	return value;
}

function latestFacts<T extends { readonly objectId: string; readonly seq: number }>(facts: readonly T[]): T[] {
	const latest = new Map<string, T>();
	for (const fact of facts) {
		const previous = latest.get(fact.objectId);
		if (previous === undefined || fact.seq > previous.seq) latest.set(fact.objectId, fact);
	}
	return [...latest.values()].sort((left, right) => left.seq - right.seq);
}

/**
 * Complete T5 facade. Every durable read/write routes through one Session
 * foundation ledger; artifact blobs and transient cache data are projections.
 */
export class SessionT5Ledger {
	readonly session: Session;
	readonly writer: SessionLedgerWriter;
	readonly artifacts: SessionArtifactStore;
	readonly memory: SessionMemoryStore;
	private readonly now: () => number;

	constructor(session: Session, options: SessionT5LedgerOptions = {}) {
		this.session = session;
		this.writer = new SessionLedgerWriter(session, options);
		this.artifacts = options.artifacts ?? new SessionArtifactStore(session, { ...options, writer: this.writer, blobStore: options.artifactBlobStore });
		this.memory = new SessionMemoryStore(session, this.artifacts, { ...options, policy: options.memoryPolicy, writer: this.writer });
		this.now = options.now ?? Date.now;
	}

	async saveContextSnapshot(snapshot: ContextSnapshot): Promise<ContextSnapshot> {
		await this.writer.writeFact({
			objectType: T5_LEDGER_OBJECT_TYPES.contextSnapshot,
			objectId: snapshot.snapshotId,
			clientRequestId: `context-snapshot:${snapshot.snapshotId}`,
			payload: asFoundationJson(snapshot.toJSON()),
		});
		return snapshot;
	}

	async captureContextSnapshot(lane = "main", options: ContextSnapshotOptions = {}): Promise<ContextSnapshot> {
		const view = this.session.view(lane);
		const leafId = await view.getLeafId();
		const entries = leafId === null ? [] : await view.findEntriesOnBranch({ start: leafId, order: "oldestFirst" });
		return this.saveContextSnapshot(createContextSnapshot(entries, options));
	}

	async getContextSnapshot(snapshotId: string): Promise<ContextSnapshotV1 | undefined> {
		const fact = await this.writer.readFact<FoundationJsonValue>(T5_LEDGER_OBJECT_TYPES.contextSnapshot, snapshotId);
		return fact === undefined ? undefined : (fact.payload as unknown as ContextSnapshotV1);
	}

	async loadContextSnapshot(snapshotId: string): Promise<ContextSnapshot> {
		const record = requireRecord(await this.getContextSnapshot(snapshotId), `Context snapshot not found: ${snapshotId}`);
		const entries = [];
		for (const entryId of record.entryIds) {
			const entry = await this.session.getEntry(entryId);
			if (entry === undefined) throw new Error(`Context snapshot ${snapshotId} references missing entry ${entryId}`);
			entries.push(entry);
		}
		return contextSnapshotFromJSON(record, entries);
	}

	async forkContextSnapshot(snapshotId: string, options: Parameters<ContextSnapshot["fork"]>[0] = {}): Promise<ContextSnapshot> {
		const parent = await this.loadContextSnapshot(snapshotId);
		const child = parent.fork(options);
		return this.saveContextSnapshot(child);
	}

	async putInstructionSource(input: InstructionSourceInput): Promise<InstructionSourceV1> {
		const sourceId = input.sourceId ?? newFoundationId("instruction");
		let contentRef = input.contentRef;
		let contentDigest = input.contentDigest;
		if (input.content !== undefined) {
			contentRef = await this.artifacts.putStructuredResult(new TextEncoder().encode(input.content), { mediaType: "text/plain", producer: "t5-instruction" });
			contentDigest = contentRef.digest;
		}
		if (contentDigest === undefined) throw new Error(`Instruction source ${sourceId} requires contentDigest or contentRef`);
		const source: InstructionSourceV1 = {
			schemaVersion: 1,
			sourceId,
			scope: input.scope,
			trust: input.trust,
			contentDigest,
			...(contentRef === undefined ? {} : { contentRef }),
			enabled: input.enabled ?? true,
			priority: input.priority ?? 0,
			createdAt: input.createdAt ?? this.now(),
		};
		await this.writer.writeFact({ objectType: T5_LEDGER_OBJECT_TYPES.instructionSource, objectId: sourceId, clientRequestId: `instruction-source:${sourceId}`, payload: asFoundationJson(source) });
		return source;
	}

	async lockInstruction(sourceId: string, options: InstructionLockOptions): Promise<InstructionLockV1> {
		const source = requireRecord(await this.writer.readFact<FoundationJsonValue>(T5_LEDGER_OBJECT_TYPES.instructionSource, sourceId), `Instruction source not found: ${sourceId}`);
		const sourceRecord = source.payload as unknown as InstructionSourceV1;
		const lock: InstructionLockV1 = {
			schemaVersion: 1,
			sourceId,
			locked: options.locked ?? true,
			managed: options.managed ?? true,
			reason: options.reason,
			sourceDigest: sourceRecord.contentDigest,
			lockedBy: options.lockedBy,
			createdAt: this.now(),
		};
		await this.writer.writeFact({ objectType: T5_LEDGER_OBJECT_TYPES.instructionLock, objectId: sourceId, clientRequestId: options.clientRequestId, payload: asFoundationJson(lock) });
		return lock;
	}

	async resolveInstructions(): Promise<InstructionResolution> {
		const sourceFacts = latestFacts(await this.writer.listFacts({ objectType: T5_LEDGER_OBJECT_TYPES.instructionSource }));
		const lockFacts = latestFacts(await this.writer.listFacts({ objectType: T5_LEDGER_OBJECT_TYPES.instructionLock }));
		return resolveInstructionSources(
			sourceFacts.map((fact) => fact.payload as unknown as InstructionSourceV1),
			lockFacts.map((fact) => fact.payload as unknown as InstructionLockV1),
		);
	}

	putMemory(entry: NewMemoryEntry): Promise<MemoryEntry> {
		return this.memory.put(entry);
	}
	getMemory(id: string, principal?: string): Promise<MemoryEntry | undefined> {
		return this.memory.get(id, principal);
	}
	listMemory(query?: MemoryQuery, principal?: string): Promise<MemoryEntry[]> {
		return this.memory.list(query, principal);
	}
	deleteMemory(id: string, principal?: string): Promise<boolean> {
		return this.memory.delete(id, principal);
	}

	async recordCompaction(options: CompactionWriteOptions): Promise<CompactionRecordV1> {
		const snapshot = await this.loadContextSnapshot(options.snapshotId);
		const proposal = compactContext(snapshot.entries(), { retainEntries: options.retainEntries });
		const summary = options.summary ?? proposal.summary;
		const summaryRef = await this.artifacts.putStructuredResult(new TextEncoder().encode(summary), { ...options.artifact, mediaType: options.artifact?.mediaType ?? "text/plain", producer: options.artifact?.producer ?? "t5-compaction" });
		const record: CompactionRecordV1 = {
			schemaVersion: 1,
			compactionId: options.compactionId ?? newFoundationId("compaction"),
			snapshotId: snapshot.snapshotId,
			sourceEntryIds: proposal.sourceEntryIds,
			retainedEntryIds: proposal.retainedEntryIds,
			summaryRef,
			summaryDigest: summaryRef.digest,
			tokensBefore: proposal.tokensBefore,
			tokensAfter: proposal.tokensAfter,
			reason: options.reason ?? "manual",
			createdAt: this.now(),
		};
		await this.writer.writeFact({ objectType: T5_LEDGER_OBJECT_TYPES.compaction, objectId: record.compactionId, clientRequestId: options.clientRequestId, payload: asFoundationJson(record) });
		return record;
	}

	async getCompaction(compactionId: string): Promise<CompactionRecordV1 | undefined> {
		const fact = await this.writer.readFact<FoundationJsonValue>(T5_LEDGER_OBJECT_TYPES.compaction, compactionId);
		return fact === undefined ? undefined : fact.payload as unknown as CompactionRecordV1;
	}

	async recordPromptCache(options: PromptCacheWriteOptions): Promise<PromptCacheRecordV1> {
		if (!Number.isInteger(options.cacheEpoch) || options.cacheEpoch < 0) throw new RangeError("cacheEpoch must be a non-negative integer");
		let valueRef = options.valueRef;
		if (options.value !== undefined) valueRef = await this.artifacts.putStructuredResult(options.value, { mediaType: "application/octet-stream", producer: "t5-prompt-cache" });
		const record: PromptCacheRecordV1 = {
			schemaVersion: 1,
			cacheEntryId: options.cacheEntryId ?? newFoundationId("prompt-cache"),
			cacheKey: options.cacheKey,
			snapshotId: options.snapshotId,
			modelId: options.modelId,
			policyDigest: options.policyDigest,
			bindingEpochId: options.bindingEpochId,
			cacheEpoch: options.cacheEpoch,
			...(valueRef === undefined ? {} : { valueRef }),
			...(options.valueDigest === undefined && valueRef === undefined ? {} : { valueDigest: options.valueDigest ?? valueRef?.digest }),
			...(options.inputTokens === undefined ? {} : { inputTokens: options.inputTokens }),
			...(options.outputTokens === undefined ? {} : { outputTokens: options.outputTokens }),
			...(options.cost === undefined ? {} : { cost: options.cost }),
			status: "valid",
			createdAt: this.now(),
			...(options.expiresAt === undefined ? {} : { expiresAt: options.expiresAt }),
		};
		await this.writer.writeFact({ objectType: T5_LEDGER_OBJECT_TYPES.promptCache, objectId: record.cacheEntryId, clientRequestId: options.clientRequestId, payload: asFoundationJson(record) });
		return record;
	}

	async lookupPromptCache(cacheKey: string): Promise<PromptCacheLookup | undefined> {
		const facts = await this.writer.listFacts({ objectType: T5_LEDGER_OBJECT_TYPES.promptCache });
		const candidates = latestFacts(facts)
			.map((fact) => fact.payload as unknown as PromptCacheRecordV1)
			.filter((record) => record.cacheKey === cacheKey && record.status === "valid" && (record.expiresAt === undefined || record.expiresAt > this.now()))
			.sort((left, right) => right.createdAt - left.createdAt);
		const record = candidates[0];
		if (record === undefined) return undefined;
		const value = record.valueRef === undefined ? undefined : (await this.artifacts.get(record.valueRef.artifactId)).content;
		return { record, ...(value === undefined ? {} : { value }) };
	}

	async invalidatePromptCache(cacheKey: string): Promise<number> {
		const facts = latestFacts(await this.writer.listFacts({ objectType: T5_LEDGER_OBJECT_TYPES.promptCache }));
		let count = 0;
		for (const fact of facts) {
			const record = fact.payload as unknown as PromptCacheRecordV1;
			if (record.cacheKey !== cacheKey || record.status !== "valid") continue;
			await this.writer.writeFact({ objectType: T5_LEDGER_OBJECT_TYPES.promptCache, objectId: record.cacheEntryId, payload: asFoundationJson({ ...record, status: "invalidated" as const }) });
			count += 1;
		}
		return count;
	}

	async createCheckpoint(snapshotId: string, lane: string, checkpointId = newFoundationId("checkpoint"), workspace?: WorkspaceCheckpointState): Promise<CheckpointV1> {
		const snapshot = await this.loadContextSnapshot(snapshotId);
		const checkpoint = createCheckpoint(snapshot, lane, checkpointId, workspace, this.now);
		await this.writer.writeFact({ objectType: T5_LEDGER_OBJECT_TYPES.checkpoint, objectId: checkpointId, clientRequestId: `checkpoint:${checkpointId}`, payload: asFoundationJson(checkpoint) });
		return checkpoint;
	}

	async planRewind(options: RewindPlanOptions): Promise<SessionRewindPlanV1> {
		const snapshot = await this.loadContextSnapshot(options.snapshotId);
		const plan = planCheckpointRewind(snapshot, options);
		const record: SessionRewindPlanV1 = { ...plan, planId: options.planId ?? newFoundationId("rewind-plan"), lane: options.lane };
		await this.writer.writeFact({ objectType: T5_LEDGER_OBJECT_TYPES.rewindPlan, objectId: record.planId, clientRequestId: `rewind-plan:${record.planId}`, payload: asFoundationJson(record) });
		return record;
	}

	async getRewindPlan(planId: string): Promise<SessionRewindPlanV1 | undefined> {
		const fact = await this.writer.readFact<FoundationJsonValue>(T5_LEDGER_OBJECT_TYPES.rewindPlan, planId);
		return fact === undefined ? undefined : fact.payload as unknown as SessionRewindPlanV1;
	}

	/** Apply only a previously persisted approved plan; the plan fact is always first. */
	async applyRewind(planId: string, workspace: WorkspaceCheckpointState): Promise<RewindExecutionV1> {
		const plan = requireRecord(await this.getRewindPlan(planId), `Rewind plan not found: ${planId}`);
		if (plan.status !== "approved" || !validateCheckpointImpactPlan(plan, await this.loadContextSnapshot(plan.sourceSnapshotId), workspace)) throw new Error(`Rewind plan ${planId} is not safe to apply`);
		const current = await this.writer.readFact<FoundationJsonValue>(T5_LEDGER_OBJECT_TYPES.rewindExecution, planId);
		const currentExecution = current?.payload as unknown as RewindExecutionV1 | undefined;
		if (currentExecution?.status === "applied") return currentExecution;
		const applying: RewindExecutionV1 = { schemaVersion: 1, planId, lane: plan.lane, targetEntryId: plan.targetEntryId, status: "applying", startedAt: this.now() };
		await this.writer.writeFact({ objectType: T5_LEDGER_OBJECT_TYPES.rewindExecution, objectId: planId, payload: asFoundationJson(applying) });
		try {
			await this.session.moveLane(plan.lane, plan.targetEntryId);
		} catch (error) {
			const failed: RewindExecutionV1 = { ...applying, status: "failed", error: error instanceof Error ? error.message : String(error) };
			await this.writer.writeFact({ objectType: T5_LEDGER_OBJECT_TYPES.rewindExecution, objectId: planId, payload: asFoundationJson(failed) });
			throw error;
		}
		const applied: RewindExecutionV1 = { ...applying, status: "applied", appliedAt: this.now() };
		await this.writer.writeFact({ objectType: T5_LEDGER_OBJECT_TYPES.rewindExecution, objectId: planId, payload: asFoundationJson(applied) });
		return applied;
	}

	async recoverRewind(planId: string, workspace: WorkspaceCheckpointState): Promise<RewindExecutionV1> {
		return this.applyRewind(planId, workspace);
	}

	async verifyContextSnapshot(snapshotId: string): Promise<boolean> {
		const snapshot = await this.loadContextSnapshot(snapshotId);
		return snapshot.digest.length > 0 && snapshot.digest === (await this.getContextSnapshot(snapshotId))?.digest;
	}

	async transcriptDigest(snapshotId: string): Promise<string> {
		const snapshot = await this.loadContextSnapshot(snapshotId);
		return digestCheckpointTranscript(snapshot.entries());
	}
}

/** Naming alias used by callers that treat this as the context ledger. */
export class ContextSnapshotLedger extends SessionT5Ledger {}
