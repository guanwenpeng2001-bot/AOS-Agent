import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	ContextCache,
	FileSystemArtifactBlobStore,
	type InMemoryArtifactBlobStore,
	InMemoryArtifactStore,
	JsonlSessionRepo,
	Session,
	SessionT5Ledger,
	createContextCacheKey,
	type ArtifactStoreError,
	type JsonlSessionMetadata,
} from "../../src/index.ts";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { InMemorySessionStorage } from "../../src/harness/session/memory.ts";
import { createTempDir } from "./session-test-utils.ts";

const environments: NodeExecutionEnv[] = [];

afterEach(async () => {
	while (environments.length > 0) await environments.pop()!.cleanup();
});

async function createSession(root: string, id: string): Promise<{ session: Session<JsonlSessionMetadata>; env: NodeExecutionEnv; repo: JsonlSessionRepo }> {
	const env = new NodeExecutionEnv({ cwd: root });
	environments.push(env);
	const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: root });
	const session = await repo.create({ id, cwd: root });
	return { session, env, repo };
}

function expectArtifactError(error: unknown, code: ArtifactStoreError["code"]): void {
	expect(error).toMatchObject({ code });
}

describe("T5 Session ledger recovery", () => {
	it("recovers Context, Memory, Compaction, Checkpoint, Artifact, instruction lock, and cache after reopen", async () => {
		const root = createTempDir();
		const { session, env, repo } = await createSession(root, "t5-recovery");
		const firstEntryId = await session.appendMessage({ role: "user", content: [{ type: "text", text: "first" }], timestamp: 1 });
		await session.appendMessage({ role: "user", content: [{ type: "text", text: "second" }], timestamp: 2 });
		const metadata = await session.getMetadata();
		const artifactRoot = join(root, "artifact-store");
		const ledger = new SessionT5Ledger(session, { artifactBlobStore: new FileSystemArtifactBlobStore(env, artifactRoot), ownerId: "t5-ledger" });
		const artifacts = ledger.artifacts;
		const snapshot = await ledger.captureContextSnapshot("main", { id: "snapshot-recovery", bindingEpochId: "binding-epoch-recovery" });
		const memory = await ledger.putMemory({ id: "memory-recovery", kind: "fact", trust: "user_owned", content: "durable memory", source: "test", scope: "task", principal: "alice" });
		const instruction = await ledger.putInstructionSource({ sourceId: "instruction-recovery", scope: "managed", trust: "builtin", content: "Do not widen scope", priority: 10 });
		const lock = await ledger.lockInstruction(instruction.sourceId, { reason: "managed policy", lockedBy: "test" });
		const compaction = await ledger.recordCompaction({ snapshotId: snapshot.snapshotId, retainEntries: 1 });
		const checkpoint = await ledger.createCheckpoint(snapshot.snapshotId, "main", "checkpoint-recovery", { known: true, digest: "workspace-1" });
		const cacheKey = createContextCacheKey({ prefixDigest: snapshot.digest, modelId: "model-a", policyDigest: "policy-a", bindingEpochId: "binding-a", cacheEpoch: 2 });
		const cacheRecord = await ledger.recordPromptCache({ cacheKey: cacheKey.key, snapshotId: snapshot.snapshotId, modelId: cacheKey.modelId, policyDigest: cacheKey.policyDigest, bindingEpochId: cacheKey.bindingEpochId, cacheEpoch: cacheKey.cacheEpoch, value: new TextEncoder().encode("cached") });
		const artifact = await artifacts.putAttachment(new TextEncoder().encode("attachment"), { principal: "alice", permissions: ["alice"] });
		const targetEntry = await session.getEntry(firstEntryId);
		expect(targetEntry).toBeDefined();
		const plan = await ledger.planRewind({ planId: "rewind-recovery", lane: "main", checkpointId: checkpoint.checkpointId, snapshotId: snapshot.snapshotId, targetEntryId: firstEntryId, workspace: { known: true, digest: "workspace-1" } });
		await ledger.writer.releaseLease();

		const reopened = await repo.open(metadata);
		const recovered = new SessionT5Ledger(reopened, { artifactBlobStore: new FileSystemArtifactBlobStore(env, artifactRoot), ownerId: "t5-ledger-reopen" });
		expect(await recovered.getContextSnapshot(snapshot.snapshotId)).toMatchObject({ snapshotId: snapshot.snapshotId, digest: snapshot.digest });
		expect((await recovered.loadContextSnapshot(snapshot.snapshotId)).entries()).toHaveLength(2);
		expect(await recovered.getMemory(memory.id, "alice")).toMatchObject({ id: memory.id, content: "durable memory", scope: "task" });
		expect(await recovered.getCompaction(compaction.compactionId)).toMatchObject({ summaryRef: { type: "artifact" } });
		expect(await recovered.resolveInstructions()).toMatchObject({ locks: [expect.objectContaining({ sourceId: instruction.sourceId, locked: true })] });
		expect(lock.locked).toBe(true);
		expect(await reopened.getFoundationObject("t5.checkpoint", checkpoint.checkpointId)).toBeDefined();
		expect(await recovered.lookupPromptCache(cacheRecord.cacheKey)).toMatchObject({ record: { cacheEntryId: cacheRecord.cacheEntryId } });
		expect(await recovered.invalidatePromptCache(cacheRecord.cacheKey)).toBe(1);
		expect(await recovered.lookupPromptCache(cacheRecord.cacheKey)).toBeUndefined();
		const recoveredArtifact = await recovered.artifacts.get(artifact.artifactId, "alice");
		expect(recoveredArtifact.content).toBeInstanceOf(Uint8Array);
		const durableFacts = await reopened.findFoundationRecords({ order: "oldestFirst" });
		const durableText = JSON.stringify(durableFacts);
		expect(durableText).not.toContain("durable memory");
		expect(durableText).not.toContain("attachment");
		expect((await recovered.getRewindPlan(plan.planId))?.planId).toBe(plan.planId);

		await recovered.applyRewind(plan.planId, { known: true, digest: "workspace-1" });
		const planAndExecution = await reopened.findFoundationRecords({ order: "oldestFirst" });
		const planFact = planAndExecution.find((record) => record.kind === "fact" && record.objectType === "t5.rewind_plan");
		const executionFact = planAndExecution.find((record) => record.kind === "fact" && record.objectType === "t5.rewind_execution");
		expect(planFact).toBeDefined();
		expect(executionFact).toBeDefined();
		expect((planFact?.seq ?? 0) < (executionFact?.seq ?? 0)).toBe(true);
		expect((await recovered.session.getLanes()).find((lane) => lane.lane === "main")?.leafId).toBe(firstEntryId);
	});
});

describe("T5 content addressed artifacts", () => {
	it("detects ACL denial, retention expiry, missing blobs, corruption, and digest mismatch", async () => {
		const session = new Session(new InMemorySessionStorage({ id: "artifact-cas", createdAt: 1 }));
		const artifacts = new InMemoryArtifactStore(session, { ownerId: "artifact-cas" });
		const content = new TextEncoder().encode("cas-content");
		const metadata = await artifacts.put(content, { principal: "alice", permissions: ["alice"] });
		expect(await artifacts.verify(metadata.id)).toBe("verified");
		await expect(artifacts.get(metadata.id, "bob")).rejects.toSatisfy((error: unknown) => {
			expectArtifactError(error, "forbidden");
			return true;
		});
		const inMemoryBlobs = artifacts.blobs as InMemoryArtifactBlobStore;
		inMemoryBlobs.corrupt(metadata.id, new TextEncoder().encode("wrong"));
		expect(await artifacts.verify(metadata.id)).toBe("corrupt");
		await expect(artifacts.get(metadata.id, "alice")).rejects.toSatisfy((error: unknown) => {
			expectArtifactError(error, "corrupt");
			return true;
		});
		await inMemoryBlobs.remove(metadata.id);
		expect(await artifacts.verify(metadata.id)).toBe("missing");
		await expect(artifacts.get(metadata.id, "alice")).rejects.toSatisfy((error: unknown) => {
			expectArtifactError(error, "missing");
			return true;
		});
		const expired = await artifacts.put(new TextEncoder().encode("expired"), { principal: "alice", permissions: ["alice"], retention: { policy: "session", expiresAt: 1 } });
		await expect(artifacts.get(expired.id, "alice")).rejects.toSatisfy((error: unknown) => {
			expectArtifactError(error, "expired");
			return true;
		});
	});
});

describe("T5 cache key and invalidation", () => {
	it("includes model, policy, binding epoch, and cache epoch", async () => {
		const base = { prefixDigest: "prefix", modelId: "model", policyDigest: "policy", bindingEpochId: "binding", cacheEpoch: 1 } as const;
		const key = createContextCacheKey(base);
		expect(createContextCacheKey({ ...base, modelId: "other-model" }).key).not.toBe(key.key);
		expect(createContextCacheKey({ ...base, policyDigest: "other-policy" }).key).not.toBe(key.key);
		expect(createContextCacheKey({ ...base, bindingEpochId: "other-binding" }).key).not.toBe(key.key);
		expect(createContextCacheKey({ ...base, cacheEpoch: 2 }).key).not.toBe(key.key);
		const cache = new ContextCache<string>({ maxEntries: 2 });
		cache.set(key, "value", { snapshotId: "snapshot" });
		expect(cache.get(key)).toBe("value");
		expect(cache.invalidate({ snapshotId: "snapshot" })).toBe(1);
		expect(cache.get(key)).toBeUndefined();
	});
});
