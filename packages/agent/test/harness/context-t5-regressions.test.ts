import { afterEach, describe, expect, it } from "vitest";
import {
	InMemoryArtifactBlobStore,
	InMemoryArtifactStore,
	InMemorySessionStorage,
	Session,
	SessionArtifactStore,
	SessionLedgerBindingError,
	SessionLedgerWriter,
	SessionMemoryStore,
	SessionT5Ledger,
	JsonlSessionRepo,
} from "../../src/index.ts";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { createTempDir } from "./session-test-utils.ts";

const environments: NodeExecutionEnv[] = [];

afterEach(async () => {
	while (environments.length > 0) await environments.pop()!.cleanup();
});

describe("T5 authority and CAS regressions", () => {
	it("rejects cross-Session injection and keeps one writer across projections", () => {
		const first = new Session(new InMemorySessionStorage({ id: "t5-authority-a", createdAt: 1 }));
		const second = new Session(new InMemorySessionStorage({ id: "t5-authority-b", createdAt: 1 }));
		const writer = new SessionLedgerWriter(first, { ownerId: "authority" });
		const artifacts = new InMemoryArtifactStore(first, { writer });

		expect(() => new SessionArtifactStore(second, { writer })).toThrow(SessionLedgerBindingError);
		expect(() => new SessionMemoryStore(second, artifacts, { writer })).toThrow(SessionLedgerBindingError);
		expect(() => new SessionT5Ledger(second, { writer, artifacts })).toThrow(SessionLedgerBindingError);

		const ledger = new SessionT5Ledger(first, { writer, artifacts });
		expect(ledger.artifacts.writer).toBe(ledger.writer);
		expect(ledger.memory.writer).toBe(ledger.writer);
	});

	it("preserves shared CAS content until the final memory reference is released", async () => {
		const session = new Session(new InMemorySessionStorage({ id: "t5-shared-cas", createdAt: 1 }));
		const ledger = new SessionT5Ledger(session, {
			ownerId: "shared-cas",
			artifactBlobStore: new InMemoryArtifactBlobStore(),
		});
		const first = await ledger.putMemory({ id: "memory-a", kind: "fact", trust: "user_owned", content: "shared", source: "source-a", principal: "system" });
		const second = await ledger.putMemory({ id: "memory-b", kind: "fact", trust: "user_owned", content: "shared", source: "source-b", principal: "system" });

		expect(first.contentRef.artifactId).toBe(second.contentRef.artifactId);
		expect(await ledger.artifacts.listReferences(first.contentRef.artifactId)).toHaveLength(2);
		await expect(ledger.artifacts.remove(first.contentRef.artifactId)).rejects.toMatchObject({ code: "in_use" });
		expect(await ledger.deleteMemory(first.id, "system")).toBe(true);
		expect((await ledger.getMemory(second.id, "system"))?.content).toBe("shared");
		expect(await ledger.artifacts.blobs.has(first.contentRef.artifactId)).toBe(true);
		expect(await ledger.deleteMemory(second.id, "system")).toBe(true);
		expect(await ledger.artifacts.remove(first.contentRef.artifactId)).toBe(true);
	});

	it("replays immutable requests across legal revisions and fences stale writers", async () => {
		const session = new Session(new InMemorySessionStorage({ id: "t5-writer-fence", createdAt: 1 }));
		const first = new SessionLedgerWriter(session, { ownerId: "writer-a" });
		const second = new SessionLedgerWriter(session, { ownerId: "writer-b" });
		const fact = { objectType: "t5.immutable", objectId: "object", clientRequestId: "immutable-request", payload: { value: "fixed" } as const };
		const accepted = await first.writeFact(fact);
		await first.releaseLease();
		await second.writeFact({ objectType: "t5.other", objectId: "other", clientRequestId: "other-request", payload: { value: "legal" } });
		await second.releaseLease();
		const replay = await first.writeFact(fact);
		expect(accepted.replayed).toBe(false);
		expect(replay.replayed).toBe(true);
		expect(replay.record.revision).toBe(1);

		await first.releaseLease();
		await second.writeFact({ objectType: "t5.fenced", objectId: "fenced", clientRequestId: "fenced-request", payload: { value: "new" } });
		await expect(first.writeFact({ objectType: "t5.stale", objectId: "stale", clientRequestId: "stale-request", payload: { value: "old" } })).rejects.toMatchObject({ code: "session_writer_busy" });
	});

	it("replays immutable T5 projections when generated timestamps move", async () => {
		const session = new Session(new InMemorySessionStorage({ id: "t5-timestamp-replay", createdAt: 1 }));
		await session.appendMessage({ role: "user", content: [{ type: "text", text: "timestamp replay" }], timestamp: 1 });
		const ledger = new SessionT5Ledger(session, { ownerId: "timestamp-replay", artifactBlobStore: new InMemoryArtifactBlobStore() });
		const instruction = await ledger.putInstructionSource({ sourceId: "instruction-replay", scope: "session", trust: "user", content: "fixed instruction" });
		expect(await ledger.putInstructionSource({ sourceId: instruction.sourceId, scope: "session", trust: "user", content: "fixed instruction" })).toEqual(instruction);
		const lock = await ledger.lockInstruction(instruction.sourceId, { reason: "fixed", lockedBy: "test" });
		expect(await ledger.lockInstruction(instruction.sourceId, { reason: "fixed", lockedBy: "test" })).toEqual(lock);
		const snapshot = await ledger.captureContextSnapshot("main", { bindingEpochId: "epoch-replay" });
		const compaction = await ledger.recordCompaction({ compactionId: "compaction-replay", snapshotId: snapshot.snapshotId, retainEntries: 1 });
		expect(await ledger.recordCompaction({ compactionId: compaction.compactionId, snapshotId: snapshot.snapshotId, retainEntries: 1 })).toEqual(compaction);
		const checkpoint = await ledger.createCheckpoint(snapshot.snapshotId, "main", "checkpoint-replay", { known: true, digest: "workspace-replay" });
		expect(await ledger.createCheckpoint(snapshot.snapshotId, "main", checkpoint.checkpointId, { known: true, digest: "workspace-replay" })).toEqual(checkpoint);
		const cache = await ledger.recordPromptCache({ cacheEntryId: "cache-replay", cacheKey: "cache-replay", snapshotId: snapshot.snapshotId, modelId: "model", policyDigest: "policy", bindingEpochId: "epoch-replay", cacheEpoch: 1, value: new TextEncoder().encode("value") });
		expect(await ledger.recordPromptCache({ cacheEntryId: cache.cacheEntryId, cacheKey: cache.cacheKey, snapshotId: cache.snapshotId, modelId: cache.modelId, policyDigest: cache.policyDigest, bindingEpochId: cache.bindingEpochId, cacheEpoch: cache.cacheEpoch, value: new TextEncoder().encode("value") })).toEqual(cache);
	});
});

describe("T5 durable reopen and recovery regressions", () => {
	it("uses a persistent default blob root for a JSONL Session", async () => {
		const root = createTempDir();
		const env = new NodeExecutionEnv({ cwd: root });
		environments.push(env);
		const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: root });
		const session = await repo.create({ id: "t5-default-persistent", cwd: root });
		const ledger = new SessionT5Ledger(session, { ownerId: "persistent" });
		const reference = await ledger.artifacts.putAttachment(new TextEncoder().encode("persistent-content"));
		const metadata = await session.getMetadata();
		await ledger.writer.releaseLease();
		const reopened = await repo.open(metadata);
		const recovered = new SessionT5Ledger(reopened, { ownerId: "persistent-reopen" });
		expect(new TextDecoder().decode((await recovered.artifacts.get(reference.artifactId)).content)).toBe("persistent-content");
	});

	it("persists only redacted snapshot/build/package facts and recovers them", async () => {
		const session = new Session(new InMemorySessionStorage({ id: "t5-facts", createdAt: 1 }));
		const ledger = new SessionT5Ledger(session, { ownerId: "facts", artifactBlobStore: new InMemoryArtifactBlobStore() });
		await session.appendMessage({ role: "user", content: [{ type: "text", text: "secret transcript" }], timestamp: 1 });
		const snapshot = await ledger.captureContextSnapshot("main", {
			bindingEpochId: "epoch-facts",
			summary: "secret summary",
			buildFact: { schemaVersion: 1, buildId: "build-facts", bindingEpochId: "epoch-facts", entryIds: [], sourceIds: ["session"], contextDigest: "sha256:build", createdAt: 1 },
			taskPackage: { schemaVersion: 1, packageId: "package-facts", taskId: "task-facts", bindingEpochId: "epoch-facts", goal: "secret goal", entryIds: [], artifactRefs: [] },
		});
		const facts = JSON.stringify(await session.findFoundationRecords({ order: "oldestFirst" }));
		expect(facts).not.toContain("secret summary");
		expect(facts).not.toContain("secret goal");
		expect(await ledger.loadContextSnapshot(snapshot.snapshotId)).toMatchObject({ bindingEpochId: "epoch-facts", buildFact: { buildId: "build-facts" }, taskPackage: { packageId: "package-facts", goalDigest: expect.any(String) } });
	});

	it("recovers a rewind after a crash between lane movement and applied receipt", async () => {
		const session = new Session(new InMemorySessionStorage({ id: "t5-rewind-crash", createdAt: 1 }));
		const firstEntryId = await session.appendMessage({ role: "user", content: [{ type: "text", text: "first" }], timestamp: 1 });
		await session.appendMessage({ role: "user", content: [{ type: "text", text: "second" }], timestamp: 2 });
		const ledger = new SessionT5Ledger(session, { ownerId: "rewind-crash", artifactBlobStore: new InMemoryArtifactBlobStore() });
		const snapshot = await ledger.captureContextSnapshot("main", { bindingEpochId: "epoch-rewind" });
		const checkpoint = await ledger.createCheckpoint(snapshot.snapshotId, "main", "checkpoint-crash", { known: true, digest: "workspace-crash" });
		const plan = await ledger.planRewind({ planId: "plan-crash", lane: "main", checkpointId: checkpoint.checkpointId, snapshotId: snapshot.snapshotId, targetEntryId: firstEntryId, workspace: { known: true, digest: "workspace-crash" } });
		const moveLane = session.moveLane.bind(session);
		let injected = true;
		session.moveLane = async (lane: string, target: string | null): Promise<void> => {
			await moveLane(lane, target);
			if (injected) {
				injected = false;
				throw new Error("injected crash");
			}
		};
		await expect(ledger.applyRewind(plan.planId, { known: true, digest: "workspace-crash" })).rejects.toThrow("injected crash");
		expect(await ledger.recoverRewind(plan.planId, { known: true, digest: "workspace-crash" })).toMatchObject({ status: "applied" });
		expect((await session.getLanes()).find((lane) => lane.lane === "main")?.leafId).toBe(firstEntryId);
	});
});
