import { canonicalFoundationJson, newFoundationId, sha256HexValue, type FoundationJsonValue } from "../foundation/index.ts";
import {
	SessionArtifactStore,
	redactArtifactReference,
	type ArtifactValidationState,
	type ArtifactBlobStore,
	type ArtifactPutOptions,
	type ArtifactReference,
} from "../artifacts.ts";
import type { ToolResultMessage, Usage } from "@aos-agent/ai";
import {
	SessionMemoryStore,
	type MemoryEntry,
	type MemoryPolicy,
	type MemoryProvenanceBoundary,
	type MemoryQuery,
	type NewMemoryEntry,
} from "../memory/memory.ts";
import type { Session } from "../session/session.ts";
import type { FileSystem } from "../types.ts";
import { SessionLedgerBindingError, SessionLedgerWriter, T5_LEDGER_OBJECT_TYPES, assertSessionLedgerWriterSession, type SessionLedgerWriterOptions } from "../session/t5.ts";
import type { FoundationCorrelationInputV1 } from "../session/durable/types.ts";
import {
	contextSnapshotFromJSON,
	createContextSnapshot,
	type ContextBuildFactV1,
	type ContextSnapshot,
	type ContextSnapshotOptions,
	type ContextSnapshotV1,
	type PersistedTaskContextPackageV1,
	type TaskContextPackageV1,
} from "./snapshot.ts";
import {
	createCheckpoint,
	digestCheckpointTranscript,
	planCheckpointRewind,
	validateCheckpointImpactPlan,
	type CheckpointImpactPlanV1,
	type CheckpointPlanOptions,
	type CheckpointRewindAuthority,
	type CheckpointV1,
	type WorkspaceCheckpointState,
} from "./checkpoint.ts";
import {
	resolveInstructionSources,
	type InstructionLockV1,
	type InstructionResolution,
	type InstructionResolutionRecordV1,
	type InstructionSourceInput,
	type InstructionSourceV1,
} from "./instruction.ts";
import { compactContext, type CompactionRecordV1, type CompactionRetentionV1, type CompactionResumeBoundaryV1, type T5CompactionReason } from "./compaction.ts";

export interface SessionT5LedgerOptions extends SessionLedgerWriterOptions {
	readonly artifacts?: SessionArtifactStore;
	readonly artifactBlobStore?: ArtifactBlobStore;
	readonly memoryPolicy?: MemoryPolicy;
	readonly now?: () => number;
	readonly writer?: SessionLedgerWriter;
	readonly allowInMemory?: boolean;
	readonly fs?: FileSystem;
	readonly artifactRoot?: string;
	readonly bindingEpochId?: string;
	readonly memoryScopeId?: string;
	readonly memoryOwnerId?: string;
	readonly memoryParentId?: string;
	readonly memoryProvenance?: MemoryProvenanceBoundary;
}

export interface ToolResultArtifactContentV1 {
	readonly index: number;
	readonly kind: "text" | "image";
	readonly reference: ArtifactReference;
}

export interface ToolResultFactV1 {
	readonly schemaVersion: 1;
	readonly resultEntryId: string;
	readonly toolCallId: string;
	readonly toolName: string;
	readonly content: readonly ToolResultArtifactContentV1[];
	readonly detailsRef?: ArtifactReference;
	readonly usage?: Usage;
	readonly addedToolNames?: readonly string[];
	readonly isError: boolean;
	readonly timestamp: number;
	readonly validation: {
		readonly state: ArtifactValidationState;
		readonly validator: string;
		readonly validatedAt: number;
		readonly artifactIds: readonly string[];
	};
	readonly provenance: {
		readonly producer: "agent-harness";
		readonly sessionId: string;
		readonly laneId: string;
		readonly runId: string;
		readonly resultEntryId: string;
		readonly toolCallId: string;
		readonly toolName: string;
	};
}

export interface ToolResultPersistenceOptions {
	readonly lane: string;
	readonly runId: string;
	readonly resultEntryId: string;
	readonly correlation?: Partial<FoundationCorrelationInputV1>;
}

export interface PersistedToolResultV1 {
	readonly fact: ToolResultFactV1;
	readonly message: ToolResultMessage<ArtifactReference>;
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
	readonly invalidationReason?: PromptCacheInvalidationReason;
	readonly invalidationCost?: number;
	readonly invalidatedAt?: number;
}

export type PromptCacheInvalidationReason = "explicit" | "context_changed" | "binding_changed" | "policy_changed" | "expired" | "evicted";

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

export interface PromptCacheInvalidationOptions {
	readonly reason?: PromptCacheInvalidationReason;
	readonly cost?: number;
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
	readonly retention?: CompactionRetentionV1;
	readonly resumeBoundary?: Partial<CompactionResumeBoundaryV1>;
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

function sameImmutableRecord(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
	return canonicalFoundationJson({ ...left, createdAt: 0 }) === canonicalFoundationJson({ ...right, createdAt: 0 });
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

function decodeImageData(data: string): Uint8Array {
	const encoded = data.startsWith("data:") ? data.slice(data.indexOf(",") + 1) : data;
	const binary = atob(encoded);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
	return bytes;
}

function serializeToolResultDetails(details: unknown): { serialized: string; validationState: ArtifactValidationState } {
	try {
		return { serialized: JSON.stringify(details) ?? "null", validationState: "verified" };
	} catch {
		return { serialized: "[unserializable tool details]", validationState: "unknown" };
	}
}

function toolResultBytes(block: ToolResultMessage["content"][number]): Uint8Array {
	return block.type === "image" ? decodeImageData(block.data) : new TextEncoder().encode(block.text);
}

function assertToolResultReplay(fact: ToolResultFactV1, message: ToolResultMessage, options: ToolResultPersistenceOptions, sessionId: string): void {
	const immutableIdentityMatches =
		fact.schemaVersion === 1 &&
		fact.resultEntryId === options.resultEntryId &&
		fact.toolCallId === message.toolCallId &&
		fact.toolName === message.toolName &&
		fact.isError === message.isError &&
		fact.timestamp === message.timestamp &&
		fact.provenance.producer === "agent-harness" &&
		fact.provenance.sessionId === sessionId &&
		fact.provenance.laneId === options.lane &&
		fact.provenance.runId === options.runId &&
		fact.provenance.resultEntryId === options.resultEntryId &&
		fact.provenance.toolCallId === message.toolCallId &&
		fact.provenance.toolName === message.toolName;
	if (!immutableIdentityMatches || fact.content.length !== message.content.length) {
		throw new SessionLedgerBindingError(`Tool result ${options.resultEntryId} conflicts with its durable identity`);
	}
	for (const [index, block] of message.content.entries()) {
		const stored = fact.content[index];
		const bytes = toolResultBytes(block);
		const mediaType = block.type === "image" ? block.mimeType : "text/plain";
		if (
			stored === undefined ||
			stored.index !== index ||
			stored.kind !== block.type ||
			stored.reference.digest !== `sha256:${sha256HexValue(bytes)}` ||
			stored.reference.mediaType !== mediaType ||
			stored.reference.sizeBytes !== bytes.byteLength
		) throw new SessionLedgerBindingError(`Tool result ${options.resultEntryId} conflicts with its durable content`);
	}
	const details = message.details === undefined ? undefined : serializeToolResultDetails(message.details);
	if (
		(details === undefined) !== (fact.detailsRef === undefined) ||
		(details !== undefined && fact.detailsRef !== undefined && (
			fact.detailsRef.digest !== `sha256:${sha256HexValue(new TextEncoder().encode(details.serialized))}` ||
			fact.detailsRef.mediaType !== "application/json" ||
			fact.detailsRef.sizeBytes !== new TextEncoder().encode(details.serialized).byteLength ||
			fact.validation.state !== details.validationState
		)) ||
		canonicalFoundationJson(fact.usage ?? null) !== canonicalFoundationJson(message.usage ?? null) ||
		canonicalFoundationJson(fact.addedToolNames ?? null) !== canonicalFoundationJson(message.addedToolNames ?? null)
	) throw new SessionLedgerBindingError(`Tool result ${options.resultEntryId} conflicts with its durable metadata`);
	const expectedArtifactIds = [...fact.content.map((item) => item.reference.artifactId), ...(fact.detailsRef === undefined ? [] : [fact.detailsRef.artifactId])];
	if (canonicalFoundationJson(fact.validation.artifactIds) !== canonicalFoundationJson(expectedArtifactIds)) {
		throw new SessionLedgerBindingError(`Tool result ${options.resultEntryId} has conflicting durable artifact references`);
	}
}

function toolResultPlaceholder(reference: ArtifactReference): string {
	return `[tool-result-artifact ${reference.digest} media=${reference.mediaType} bytes=${reference.sizeBytes}]`;
}

function encodeToolResultImage(value: Uint8Array): string {
	let binary = "";
	for (const byte of value) binary += String.fromCharCode(byte);
	return btoa(binary);
}

function projectToolResult(fact: ToolResultFactV1): ToolResultMessage<ArtifactReference> {
	return {
		role: "toolResult",
		toolCallId: fact.toolCallId,
		toolName: fact.toolName,
		content: fact.content.map(({ kind, reference }) => ({ type: "text" as const, text: `${kind}:${toolResultPlaceholder(reference)}` })),
		...(fact.detailsRef === undefined ? {} : { details: structuredClone(fact.detailsRef) }),
		...(fact.usage === undefined ? {} : { usage: structuredClone(fact.usage) }),
		...(fact.addedToolNames === undefined ? {} : { addedToolNames: [...fact.addedToolNames] }),
		isError: fact.isError,
		timestamp: fact.timestamp,
	};
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
	private readonly defaultBindingEpochId?: string;

	constructor(session: Session, options: SessionT5LedgerOptions = {}) {
		this.session = session;
		this.writer = options.writer ?? new SessionLedgerWriter(session, options);
		assertSessionLedgerWriterSession(session, this.writer, "SessionT5Ledger");
		if (options.artifacts !== undefined) {
			if (options.artifacts.session !== session) throw new SessionLedgerBindingError("SessionT5Ledger and ArtifactStore must use the same Session");
			if (options.artifacts.writer !== this.writer) throw new SessionLedgerBindingError("SessionT5Ledger and ArtifactStore must share one SessionLedgerWriter");
		}
		this.artifacts = options.artifacts ?? new SessionArtifactStore(session, { ...options, writer: this.writer, blobStore: options.artifactBlobStore });
		this.memory = new SessionMemoryStore(session, this.artifacts, {
			policy: options.memoryPolicy,
			now: options.now,
			writer: this.writer,
			memoryScopeId: options.memoryScopeId,
			memoryOwnerId: options.memoryOwnerId,
			memoryParentId: options.memoryParentId,
			memoryProvenance: options.memoryProvenance,
		});
		this.now = options.now ?? Date.now;
		this.defaultBindingEpochId = options.bindingEpochId;
	}

	/**
	 * Persist a tool result as artifact references and a validation fact. The
	 * Session transcript receives only a redacted projection, so image bytes,
	 * attachments, and structured details never become JSONL payloads.
	 */
	async persistToolResult(message: ToolResultMessage, options: ToolResultPersistenceOptions): Promise<PersistedToolResultV1> {
		const metadata = await this.session.getMetadata();
		const existing = await this.writer.readFact<FoundationJsonValue>(T5_LEDGER_OBJECT_TYPES.toolResult, options.resultEntryId);
		if (existing !== undefined) {
			const fact = existing.payload as unknown as ToolResultFactV1;
			assertToolResultReplay(fact, message, options, metadata.id);
			return { fact: structuredClone(fact), message: projectToolResult(fact) };
		}

		const content: ToolResultArtifactContentV1[] = [];
		const artifactIds: string[] = [];
		for (const [index, block] of message.content.entries()) {
			const isImage = block.type === "image";
			const bytes = toolResultBytes(block);
			const reference = isImage
				? await this.artifacts.putAttachment(bytes, {
						mediaType: block.mimeType,
						producer: "t5-tool-result",
						validation: { state: "verified", validator: "t5.tool_result", validatedAt: this.now() },
					})
				: await this.artifacts.putStructuredResult(bytes, {
						mediaType: "text/plain",
						producer: "t5-tool-result",
						validation: { state: "verified", validator: "t5.tool_result", validatedAt: this.now() },
					});
			artifactIds.push(reference.artifactId);
			await this.artifacts.retainReference({
				artifactId: reference.artifactId,
				referenceId: `tool-result:${options.resultEntryId}:${index}`,
				consumerType: T5_LEDGER_OBJECT_TYPES.toolResult,
				consumerId: options.resultEntryId,
			});
			content.push({ index, kind: isImage ? "image" : "text", reference });
		}

		let detailsRef: ArtifactReference | undefined;
		let validationState: ArtifactValidationState = "verified";
		if (message.details !== undefined) {
			const details = serializeToolResultDetails(message.details);
			const serialized = details.serialized;
			validationState = details.validationState;
			const storedDetails = await this.artifacts.putStructuredResult(new TextEncoder().encode(serialized), {
				mediaType: "application/json",
				producer: "t5-tool-result",
				validation: { state: validationState, validator: "t5.tool_result", validatedAt: this.now() },
			});
			detailsRef = storedDetails;
			artifactIds.push(storedDetails.artifactId);
			await this.artifacts.retainReference({
				artifactId: storedDetails.artifactId,
				referenceId: `tool-result:${options.resultEntryId}:details`,
				consumerType: T5_LEDGER_OBJECT_TYPES.toolResult,
				consumerId: options.resultEntryId,
			});
		}

		const fact: ToolResultFactV1 = {
			schemaVersion: 1,
			resultEntryId: options.resultEntryId,
			toolCallId: message.toolCallId,
			toolName: message.toolName,
			content,
			...(detailsRef === undefined ? {} : { detailsRef }),
			...(message.usage === undefined ? {} : { usage: structuredClone(message.usage) }),
			...(message.addedToolNames === undefined ? {} : { addedToolNames: [...message.addedToolNames] }),
			isError: message.isError,
			timestamp: message.timestamp,
			validation: { state: validationState, validator: "t5.tool_result", validatedAt: this.now(), artifactIds },
			provenance: {
				producer: "agent-harness",
				sessionId: metadata.id,
				laneId: options.lane,
				runId: options.runId,
				resultEntryId: options.resultEntryId,
				toolCallId: message.toolCallId,
				toolName: message.toolName,
			},
		};
		const accepted = await this.writer.writeFact({
			objectType: T5_LEDGER_OBJECT_TYPES.toolResult,
			objectId: options.resultEntryId,
			clientRequestId: `tool-result:${options.resultEntryId}`,
			payload: asFoundationJson(fact),
			correlation: {
				...(options.correlation ?? {}),
				laneId: options.lane,
				runId: options.runId,
			},
		});
		const stored = accepted.payload as unknown as ToolResultFactV1;
		return { fact: structuredClone(stored), message: projectToolResult(stored) };
	}

	/**
	 * Rebuild the transient tool result consumed by the agent loop from the
	 * canonical fact and its verified artifacts. The JSONL transcript remains a
	 * reference-only projection; this method never creates another state owner.
	 */
	async materializeToolResult(resultEntryId: string): Promise<ToolResultMessage<unknown> | undefined> {
		const stored = await this.writer.readFact<FoundationJsonValue>(T5_LEDGER_OBJECT_TYPES.toolResult, resultEntryId);
		if (stored === undefined) return undefined;
		const fact = stored.payload as unknown as ToolResultFactV1;
		if (
			fact.schemaVersion !== 1 ||
			fact.resultEntryId !== resultEntryId ||
			typeof fact.toolCallId !== "string" ||
			typeof fact.toolName !== "string" ||
			!Array.isArray(fact.content) ||
			fact.validation?.state !== "verified" ||
			!Array.isArray(fact.validation.artifactIds)
		) {
			throw new SessionLedgerBindingError(`Tool result ${resultEntryId} cannot be materialized from an invalid durable fact`);
		}

		const content: ToolResultMessage<unknown>["content"] = [];
		const artifactIds: string[] = [];
		for (const [index, item] of fact.content.entries()) {
			if (item.index !== index || (item.kind !== "text" && item.kind !== "image")) {
				throw new SessionLedgerBindingError(`Tool result ${resultEntryId} has an invalid durable content index`);
			}
			const reference = redactArtifactReference(item.reference);
			const artifact = await this.artifacts.get(reference.artifactId);
			if (
				artifact.metadata.digest !== reference.digest ||
				artifact.metadata.mediaType !== reference.mediaType ||
				artifact.metadata.sizeBytes !== reference.sizeBytes
			) {
				throw new SessionLedgerBindingError(`Tool result ${resultEntryId} artifact metadata conflicts with its durable fact`);
			}
			artifactIds.push(reference.artifactId);
			if (item.kind === "text") {
				if (reference.mediaType !== "text/plain") {
					throw new SessionLedgerBindingError(`Tool result ${resultEntryId} text artifact has an invalid media type`);
				}
				content.push({ type: "text", text: new TextDecoder().decode(artifact.content) });
			} else {
				if (!reference.mediaType.startsWith("image/")) {
					throw new SessionLedgerBindingError(`Tool result ${resultEntryId} image artifact has an invalid media type`);
				}
				content.push({ type: "image", data: encodeToolResultImage(artifact.content), mimeType: reference.mediaType });
			}
		}

		let details: unknown;
		if (fact.detailsRef !== undefined) {
			const reference = redactArtifactReference(fact.detailsRef);
			const artifact = await this.artifacts.get(reference.artifactId);
			if (
				reference.mediaType !== "application/json" ||
				artifact.metadata.digest !== reference.digest ||
				artifact.metadata.mediaType !== reference.mediaType ||
				artifact.metadata.sizeBytes !== reference.sizeBytes
			) {
				throw new SessionLedgerBindingError(`Tool result ${resultEntryId} details artifact conflicts with its durable fact`);
			}
			artifactIds.push(reference.artifactId);
			try {
				details = JSON.parse(new TextDecoder().decode(artifact.content)) as unknown;
			} catch (_error) {
				throw new SessionLedgerBindingError(`Tool result ${resultEntryId} details artifact is not valid JSON`);
			}
		}
		if (canonicalFoundationJson(artifactIds) !== canonicalFoundationJson(fact.validation.artifactIds)) {
			throw new SessionLedgerBindingError(`Tool result ${resultEntryId} artifact set conflicts with its durable fact`);
		}

		return {
			role: "toolResult",
			toolCallId: fact.toolCallId,
			toolName: fact.toolName,
			content,
			...(fact.detailsRef === undefined ? {} : { details }),
			...(fact.usage === undefined ? {} : { usage: structuredClone(fact.usage) }),
			...(fact.addedToolNames === undefined ? {} : { addedToolNames: [...fact.addedToolNames] }),
			isError: fact.isError,
			timestamp: fact.timestamp,
		};
	}

	async saveContextSnapshot(snapshot: ContextSnapshot): Promise<ContextSnapshot> {
		if (snapshot.bindingEpochId.length === 0) throw new Error("Context snapshot must bind to a BindingEpoch");
		if (this.defaultBindingEpochId !== undefined && snapshot.bindingEpochId !== this.defaultBindingEpochId) {
			throw new Error("Context snapshot BindingEpoch does not match the ledger authority");
		}
		if (snapshot.buildFact !== undefined && snapshot.buildFact.bindingEpochId !== snapshot.bindingEpochId) throw new Error("Context build fact BindingEpoch does not match the snapshot");
		if (snapshot.taskPackage !== undefined && snapshot.taskPackage.bindingEpochId !== undefined && snapshot.taskPackage.bindingEpochId !== snapshot.bindingEpochId) throw new Error("Task context package BindingEpoch does not match the snapshot");
		const bindingEpoch = await this.writer.readFact<FoundationJsonValue>("binding_epoch", snapshot.bindingEpochId);
		if (bindingEpoch !== undefined) {
			const value = bindingEpoch.payload as { readonly bindingEpochId?: string };
			if (value.bindingEpochId !== snapshot.bindingEpochId) throw new Error("Context snapshot BindingEpoch fact does not match its object id");
		}
		let record = snapshot.toJSON();
		const summary = snapshot.summary();
		if (summary !== undefined && record.summaryRef === undefined) {
			const summaryRef = await this.artifacts.putStructuredResult(new TextEncoder().encode(summary), {
				mediaType: "text/plain",
				producer: "t5-context-summary",
				principal: "system",
				permissions: ["system"],
				clientRequestId: `context-summary:${snapshot.snapshotId}`,
			});
			await this.artifacts.retainReference({
				artifactId: summaryRef.artifactId,
				referenceId: `context-summary:${snapshot.snapshotId}`,
				consumerType: T5_LEDGER_OBJECT_TYPES.contextSnapshot,
				consumerId: snapshot.snapshotId,
			});
			record = { ...record, summaryRef, summaryDigest: summaryRef.digest };
		}
		if (record.buildFact !== undefined) {
			await this.saveContextBuildFact(record.buildFact);
		}
		if (record.taskPackage !== undefined) {
			await this.saveTaskContextPackage(record.taskPackage);
		}
		await this.writer.writeFact({
			objectType: T5_LEDGER_OBJECT_TYPES.contextSnapshot,
			objectId: snapshot.snapshotId,
			clientRequestId: `context-snapshot:${snapshot.snapshotId}`,
			payload: asFoundationJson(record),
		});
		return contextSnapshotFromJSON(record, snapshot.entries());
	}

	async saveContextBuildFact(fact: ContextBuildFactV1): Promise<ContextBuildFactV1> {
		const existing = await this.writer.readFact<FoundationJsonValue>(T5_LEDGER_OBJECT_TYPES.contextBuild, fact.buildId);
		if (existing !== undefined) {
			const stored = existing.payload as unknown as ContextBuildFactV1;
			if (!sameImmutableRecord(stored as unknown as Record<string, unknown>, fact as unknown as Record<string, unknown>)) throw new Error(`Context build fact ${fact.buildId} is immutable`);
			return stored;
		}
		const accepted = await this.writer.writeFact({
			objectType: T5_LEDGER_OBJECT_TYPES.contextBuild,
			objectId: fact.buildId,
			clientRequestId: `context-build:${fact.buildId}`,
			payload: asFoundationJson(fact),
		});
		return accepted.payload as unknown as ContextBuildFactV1;
	}

	async getContextBuildFact(buildId: string): Promise<ContextBuildFactV1 | undefined> {
		const fact = await this.writer.readFact<FoundationJsonValue>(T5_LEDGER_OBJECT_TYPES.contextBuild, buildId);
		return fact === undefined ? undefined : (fact.payload as unknown as ContextBuildFactV1);
	}

	async saveTaskContextPackage(taskPackage: TaskContextPackageV1): Promise<PersistedTaskContextPackageV1> {
		const { entries: _entries, goal: _goal, ...metadata } = taskPackage;
		const packageId = taskPackage.packageId ?? `task-package:${taskPackage.taskId}`;
		const value: PersistedTaskContextPackageV1 = {
			...metadata,
			packageId,
			schemaVersion: 1,
			createdAt: taskPackage.createdAt ?? this.now(),
			...(taskPackage.goal === undefined && taskPackage.goalDigest === undefined ? {} : { goalDigest: taskPackage.goalDigest ?? `sha256:${sha256HexValue(new TextEncoder().encode(taskPackage.goal ?? ""))}` }),
		};
		const existing = await this.writer.readFact<FoundationJsonValue>(T5_LEDGER_OBJECT_TYPES.taskContextPackage, packageId);
		if (existing !== undefined) {
			const stored = existing.payload as unknown as PersistedTaskContextPackageV1;
			if (!sameImmutableRecord(stored as unknown as Record<string, unknown>, value as unknown as Record<string, unknown>)) throw new Error(`Task context package ${packageId} is immutable`);
			return stored;
		}
		const accepted = await this.writer.writeFact({
			objectType: T5_LEDGER_OBJECT_TYPES.taskContextPackage,
			objectId: packageId,
			clientRequestId: `task-package:${packageId}`,
			payload: asFoundationJson(value),
		});
		return accepted.payload as unknown as PersistedTaskContextPackageV1;
	}

	async getTaskContextPackage(packageId: string): Promise<PersistedTaskContextPackageV1 | undefined> {
		const fact = await this.writer.readFact<FoundationJsonValue>(T5_LEDGER_OBJECT_TYPES.taskContextPackage, packageId);
		return fact === undefined ? undefined : (fact.payload as unknown as PersistedTaskContextPackageV1);
	}

	async captureContextSnapshot(lane = "main", options: ContextSnapshotOptions = {}): Promise<ContextSnapshot> {
		const view = this.session.view(lane);
		const leafId = await view.getLeafId();
		const entries = leafId === null ? [] : await view.findEntriesOnBranch({ start: leafId, order: "oldestFirst" });
		return this.saveContextSnapshot(createContextSnapshot(entries, { ...options, bindingEpochId: options.bindingEpochId ?? this.defaultBindingEpochId }));
	}

	async getContextSnapshot(snapshotId: string): Promise<ContextSnapshotV1 | undefined> {
		const fact = await this.writer.readFact<FoundationJsonValue>(T5_LEDGER_OBJECT_TYPES.contextSnapshot, snapshotId);
		return fact === undefined ? undefined : (fact.payload as unknown as ContextSnapshotV1);
	}

	async loadContextSnapshot(snapshotId: string): Promise<ContextSnapshot> {
		const record = requireRecord(await this.getContextSnapshot(snapshotId), `Context snapshot not found: ${snapshotId}`);
		if (record.buildFact !== undefined && (await this.getContextBuildFact(record.buildFact.buildId)) === undefined) throw new Error(`Context snapshot ${snapshotId} references missing build fact ${record.buildFact.buildId}`);
		if (record.taskPackage !== undefined && record.taskPackage.packageId !== undefined && (await this.getTaskContextPackage(record.taskPackage.packageId)) === undefined) throw new Error(`Context snapshot ${snapshotId} references missing task package ${record.taskPackage.packageId}`);
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
		let contentRef = input.contentRef === undefined ? undefined : redactArtifactReference(input.contentRef);
		let contentDigest = input.contentDigest;
		if (input.content !== undefined) {
			contentRef = await this.artifacts.putStructuredResult(new TextEncoder().encode(input.content), { mediaType: "text/plain", producer: "t5-instruction" });
			contentDigest = contentRef.digest;
		}
		if (contentDigest === undefined) throw new Error(`Instruction source ${sourceId} requires contentDigest or contentRef`);
		if (!/^sha256:[0-9a-f]{64}$/.test(contentDigest)) throw new Error(`Instruction source ${sourceId} requires a SHA-256 content digest`);
		const source: InstructionSourceV1 = {
			schemaVersion: 1,
			sourceId,
			scope: input.scope,
			trust: input.trust,
			contentDigest,
			...(contentRef === undefined ? {} : { contentRef }),
			...(input.path === undefined ? {} : { path: input.path }),
			...(input.parentSourceId === undefined ? {} : { parentSourceId: input.parentSourceId }),
			inherited: input.inherited ?? input.parentSourceId !== undefined,
			enabled: input.enabled ?? true,
			priority: input.priority ?? 0,
			createdAt: input.createdAt ?? this.now(),
		};
		const existing = await this.writer.readFact<FoundationJsonValue>(T5_LEDGER_OBJECT_TYPES.instructionSource, sourceId);
		if (existing !== undefined) {
			const stored = existing.payload as unknown as InstructionSourceV1;
			if (!sameImmutableRecord(stored as unknown as Record<string, unknown>, source as unknown as Record<string, unknown>)) throw new Error(`Instruction source ${sourceId} is immutable`);
			return stored;
		}
		if (contentRef !== undefined) {
			await this.artifacts.retainReference({ artifactId: contentRef.artifactId, referenceId: `instruction:${sourceId}`, consumerType: T5_LEDGER_OBJECT_TYPES.instructionSource, consumerId: sourceId });
		}
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
			...(sourceRecord.path === undefined ? {} : { path: sourceRecord.path }),
			createdAt: this.now(),
		};
		const existing = await this.writer.readFact<FoundationJsonValue>(T5_LEDGER_OBJECT_TYPES.instructionLock, sourceId);
		if (existing !== undefined) {
			const stored = existing.payload as unknown as InstructionLockV1;
			if (!sameImmutableRecord(stored as unknown as Record<string, unknown>, lock as unknown as Record<string, unknown>)) throw new Error(`Instruction lock ${sourceId} is immutable`);
			return stored;
		}
		await this.writer.writeFact({ objectType: T5_LEDGER_OBJECT_TYPES.instructionLock, objectId: sourceId, clientRequestId: options.clientRequestId ?? `instruction-lock:${sourceId}`, payload: asFoundationJson(lock) });
		return lock;
	}

	async resolveInstructions(options: { readonly path?: string } = {}): Promise<InstructionResolution> {
		const sourceFacts = latestFacts(await this.writer.listFacts({ objectType: T5_LEDGER_OBJECT_TYPES.instructionSource }));
		const lockFacts = latestFacts(await this.writer.listFacts({ objectType: T5_LEDGER_OBJECT_TYPES.instructionLock }));
		const resolution = resolveInstructionSources(
			sourceFacts.map((fact) => fact.payload as unknown as InstructionSourceV1),
			lockFacts.map((fact) => fact.payload as unknown as InstructionLockV1),
			options,
		);
		const resolutionId = `instruction-resolution:${resolution.digest.replace(/[^a-zA-Z0-9:_-]/g, "_")}`;
		const record: InstructionResolutionRecordV1 = {
			schemaVersion: 1,
			resolutionId,
			...(resolution.path === undefined ? {} : { path: resolution.path }),
			sourceIds: sourceFacts.map((fact) => fact.objectId).sort((left, right) => left.localeCompare(right)),
			selectedSourceIds: resolution.sources.map((source) => source.sourceId),
			decisions: resolution.decisions,
			locks: resolution.locks,
			digest: resolution.digest,
			createdAt: this.now(),
		};
		const existing = await this.writer.readFact<FoundationJsonValue>(T5_LEDGER_OBJECT_TYPES.instructionResolution, resolutionId);
		if (existing !== undefined) {
			const stored = existing.payload as unknown as InstructionResolutionRecordV1;
			if (!sameImmutableRecord(stored as unknown as Record<string, unknown>, record as unknown as Record<string, unknown>)) {
				throw new Error(`Instruction resolution ${resolutionId} is immutable`);
			}
			return { ...resolution, resolutionId };
		}
		await this.writer.writeFact({
			objectType: T5_LEDGER_OBJECT_TYPES.instructionResolution,
			objectId: resolutionId,
			clientRequestId: `instruction-resolution:${resolutionId}`,
			payload: asFoundationJson(record),
		});
		return { ...resolution, resolutionId };
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
		if (options.retention?.expiresAt !== undefined && (!Number.isFinite(options.retention.expiresAt) || options.retention.expiresAt < 0)) throw new RangeError("Compaction retention expiry must be finite and non-negative");
		const proposal = compactContext(snapshot.entries(), { retainEntries: options.retainEntries, retention: options.retention });
		const summary = options.summary ?? proposal.summary;
		const summaryRef = await this.artifacts.putStructuredResult(new TextEncoder().encode(summary), { ...options.artifact, mediaType: options.artifact?.mediaType ?? "text/plain", producer: options.artifact?.producer ?? "t5-compaction" });
		const record: CompactionRecordV1 = {
			schemaVersion: 1,
			compactionId: options.compactionId ?? newFoundationId("compaction"),
			snapshotId: snapshot.snapshotId,
			sourceLeafId: proposal.sourceLeafId,
			sourceEntryIds: proposal.sourceEntryIds,
			retainedEntryIds: proposal.retainedEntryIds,
			summaryRef,
			summaryDigest: summaryRef.digest,
			tokensBefore: proposal.tokensBefore,
			tokensAfter: proposal.tokensAfter,
			reason: options.reason ?? "manual",
			createdAt: this.now(),
			retention: options.retention ?? { policy: "session" },
			resumeBoundary: {
				snapshotId: snapshot.snapshotId,
				entryId: options.resumeBoundary?.entryId ?? proposal.retainedEntryIds.at(-1) ?? null,
				transcriptDigest: options.resumeBoundary?.transcriptDigest ?? digestCheckpointTranscript(snapshot.entries()),
				retainedEntryIds: options.resumeBoundary?.retainedEntryIds ?? proposal.retainedEntryIds,
			},
		};
		const existing = await this.writer.readFact<FoundationJsonValue>(T5_LEDGER_OBJECT_TYPES.compaction, record.compactionId);
		if (existing !== undefined) {
			const stored = existing.payload as unknown as CompactionRecordV1;
			if (!sameImmutableRecord(stored as unknown as Record<string, unknown>, record as unknown as Record<string, unknown>)) throw new Error(`Compaction ${record.compactionId} is immutable`);
			return stored;
		}
		await this.artifacts.retainReference({ artifactId: summaryRef.artifactId, referenceId: `compaction:${record.compactionId}`, consumerType: T5_LEDGER_OBJECT_TYPES.compaction, consumerId: record.compactionId, ...(record.retention.expiresAt === undefined ? {} : { expiresAt: record.retention.expiresAt }) });
		await this.writer.writeFact({ objectType: T5_LEDGER_OBJECT_TYPES.compaction, objectId: record.compactionId, clientRequestId: options.clientRequestId ?? `compaction:${record.compactionId}`, payload: asFoundationJson(record) });
		return record;
	}

	async getCompaction(compactionId: string): Promise<CompactionRecordV1 | undefined> {
		const fact = await this.writer.readFact<FoundationJsonValue>(T5_LEDGER_OBJECT_TYPES.compaction, compactionId);
		return fact === undefined ? undefined : fact.payload as unknown as CompactionRecordV1;
	}

	async recordPromptCache(options: PromptCacheWriteOptions): Promise<PromptCacheRecordV1> {
		if (!Number.isInteger(options.cacheEpoch) || options.cacheEpoch < 0) throw new RangeError("cacheEpoch must be a non-negative integer");
		let valueRef = options.valueRef === undefined ? undefined : redactArtifactReference(options.valueRef);
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
		const existing = await this.writer.readFact<FoundationJsonValue>(T5_LEDGER_OBJECT_TYPES.promptCache, record.cacheEntryId);
		if (existing !== undefined) {
			const stored = existing.payload as unknown as PromptCacheRecordV1;
			if (!sameImmutableRecord(stored as unknown as Record<string, unknown>, record as unknown as Record<string, unknown>)) throw new Error(`Prompt cache entry ${record.cacheEntryId} is immutable`);
			return stored;
		}
		if (valueRef !== undefined) {
			await this.artifacts.retainReference({ artifactId: valueRef.artifactId, referenceId: `prompt-cache:${record.cacheEntryId}`, consumerType: T5_LEDGER_OBJECT_TYPES.promptCache, consumerId: record.cacheEntryId, ...(record.expiresAt === undefined ? {} : { expiresAt: record.expiresAt }) });
		}
		await this.writer.writeFact({ objectType: T5_LEDGER_OBJECT_TYPES.promptCache, objectId: record.cacheEntryId, clientRequestId: options.clientRequestId ?? `prompt-cache:${record.cacheEntryId}`, payload: asFoundationJson(record) });
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

	async invalidatePromptCache(cacheKey: string, options: PromptCacheInvalidationOptions = {}): Promise<number> {
		const facts = latestFacts(await this.writer.listFacts({ objectType: T5_LEDGER_OBJECT_TYPES.promptCache }));
		let count = 0;
		for (const fact of facts) {
			const record = fact.payload as unknown as PromptCacheRecordV1;
			if (record.cacheKey !== cacheKey || record.status !== "valid") continue;
			const reason = options.reason ?? "explicit";
			if (options.cost !== undefined && (!Number.isFinite(options.cost) || options.cost < 0)) throw new RangeError("cache invalidation cost must be finite and non-negative");
			await this.writer.writeFact({
				objectType: T5_LEDGER_OBJECT_TYPES.promptCache,
				objectId: record.cacheEntryId,
				clientRequestId: `${options.clientRequestId ?? "prompt-cache-invalidate"}:${record.cacheEntryId}:${reason}`,
				payload: asFoundationJson({ ...record, status: "invalidated" as const, invalidationReason: reason, ...(options.cost === undefined ? {} : { invalidationCost: options.cost }), invalidatedAt: this.now() }),
			});
			count += 1;
		}
		return count;
	}

	async createCheckpoint(snapshotId: string, lane: string, checkpointId = newFoundationId("checkpoint"), workspace?: WorkspaceCheckpointState): Promise<CheckpointV1> {
		const snapshot = await this.loadContextSnapshot(snapshotId);
		const checkpoint = createCheckpoint(snapshot, lane, checkpointId, workspace, this.now);
		const existing = await this.writer.readFact<FoundationJsonValue>(T5_LEDGER_OBJECT_TYPES.checkpoint, checkpointId);
		if (existing !== undefined) {
			const stored = existing.payload as unknown as CheckpointV1;
			if (!sameImmutableRecord(stored as unknown as Record<string, unknown>, checkpoint as unknown as Record<string, unknown>)) throw new Error(`Checkpoint ${checkpointId} is immutable`);
			return stored;
		}
		await this.writer.writeFact({ objectType: T5_LEDGER_OBJECT_TYPES.checkpoint, objectId: checkpointId, clientRequestId: `checkpoint:${checkpointId}`, payload: asFoundationJson(checkpoint) });
		return checkpoint;
	}

	async getCheckpoint(checkpointId: string): Promise<CheckpointV1 | undefined> {
		const fact = await this.writer.readFact<FoundationJsonValue>(T5_LEDGER_OBJECT_TYPES.checkpoint, checkpointId);
		return fact === undefined ? undefined : (fact.payload as unknown as CheckpointV1);
	}

	async planRewind(options: RewindPlanOptions): Promise<SessionRewindPlanV1> {
		const snapshot = await this.loadContextSnapshot(options.snapshotId);
		const checkpoint = requireRecord(await this.getCheckpoint(options.checkpointId), `Checkpoint not found: ${options.checkpointId}`);
		if (checkpoint.snapshotId !== options.snapshotId || checkpoint.lane !== options.lane) {
			throw new Error(`Checkpoint ${options.checkpointId} does not belong to snapshot ${options.snapshotId} and lane ${options.lane}`);
		}
		const currentLaneLeafId = (await this.session.getLanes()).find((lane) => lane.lane === options.lane)?.leafId;
		if (currentLaneLeafId === undefined) throw new Error(`Lane not found: ${options.lane}`);
		const plan = planCheckpointRewind(snapshot, {
			...options,
			targetEntryId: options.targetEntryId ?? checkpoint.entryId,
			checkpointTranscriptDigest: checkpoint.transcriptDigest,
			checkpointWorkspaceDigest: checkpoint.workspaceDigest,
			currentLaneLeafId,
			expectedLaneLeafId: snapshot.headEntryId,
		});
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
		const snapshot = await this.loadContextSnapshot(plan.sourceSnapshotId);
		const checkpoint = requireRecord(await this.getCheckpoint(plan.checkpointId), `Checkpoint not found: ${plan.checkpointId}`);
		if (checkpoint.snapshotId !== snapshot.snapshotId || checkpoint.lane !== plan.lane) throw new Error(`Rewind plan ${planId} checkpoint authority changed`);
		const currentLaneLeafId = (await this.session.getLanes()).find((lane) => lane.lane === plan.lane)?.leafId;
		const authority: CheckpointRewindAuthority = { checkpoint, targetEntryId: plan.targetEntryId, workspace, planId, lane: plan.lane };
		if (currentLaneLeafId === undefined || !validateCheckpointImpactPlan(plan, snapshot, authority)) throw new Error(`Rewind plan ${planId} is not safe to apply`);
		if (plan.currentLaneLeafId !== undefined && currentLaneLeafId !== plan.currentLaneLeafId && currentLaneLeafId !== plan.targetEntryId) {
			throw new Error(`Rewind plan ${planId} lane changed before execution`);
		}
		const current = await this.writer.readFact<FoundationJsonValue>(T5_LEDGER_OBJECT_TYPES.rewindExecution, planId);
		const currentExecution = current?.payload as unknown as RewindExecutionV1 | undefined;
		if (currentExecution?.status === "applied") return currentExecution;
		if ((currentExecution?.status === "applying" || currentExecution?.status === "failed") && currentLaneLeafId === plan.targetEntryId) {
			const recovered: RewindExecutionV1 = { schemaVersion: 1, planId, lane: plan.lane, targetEntryId: plan.targetEntryId, status: "applied", startedAt: currentExecution.startedAt, appliedAt: this.now() };
			await this.writer.writeFact({ objectType: T5_LEDGER_OBJECT_TYPES.rewindExecution, objectId: planId, clientRequestId: `rewind-execution:${planId}:applied`, payload: asFoundationJson(recovered) });
			return recovered;
		}
		const applying: RewindExecutionV1 =
			currentExecution?.status === "applying" || currentExecution?.status === "failed"
				? { schemaVersion: 1, planId, lane: plan.lane, targetEntryId: plan.targetEntryId, status: "applying", startedAt: currentExecution.startedAt }
				: { schemaVersion: 1, planId, lane: plan.lane, targetEntryId: plan.targetEntryId, status: "applying", startedAt: this.now() };
		await this.writer.writeFact({ objectType: T5_LEDGER_OBJECT_TYPES.rewindExecution, objectId: planId, clientRequestId: `rewind-execution:${planId}:applying`, payload: asFoundationJson(applying) });
		try {
			await this.session.moveLane(plan.lane, plan.targetEntryId);
		} catch (error) {
			const failed: RewindExecutionV1 = { ...applying, status: "failed", error: error instanceof Error ? error.message : String(error) };
			await this.writer.writeFact({ objectType: T5_LEDGER_OBJECT_TYPES.rewindExecution, objectId: planId, clientRequestId: `rewind-execution:${planId}:failed`, payload: asFoundationJson(failed) });
			throw error;
		}
		const applied: RewindExecutionV1 = { ...applying, status: "applied", appliedAt: this.now() };
		await this.writer.writeFact({ objectType: T5_LEDGER_OBJECT_TYPES.rewindExecution, objectId: planId, clientRequestId: `rewind-execution:${planId}:applied`, payload: asFoundationJson(applied) });
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

/** Type-only compatibility alias; SessionT5Ledger remains the sole runtime authority. */
export type ContextSnapshotLedger = SessionT5Ledger;
