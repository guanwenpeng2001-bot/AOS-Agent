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
	T5_LEDGER_OBJECT_TYPES,
} from "../../src/index.ts";
import { resolveInstructionSources, type InstructionLockV1 } from "../../src/harness/context/instruction.ts";
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

	it("resolves inherited instructions executablely and records every decision", async () => {
		const session = new Session(new InMemorySessionStorage({ id: "t5-instruction-inheritance", createdAt: 1 }));
		const ledger = new SessionT5Ledger(session, { ownerId: "instruction-inheritance", artifactBlobStore: new InMemoryArtifactBlobStore() });
		const parent = await ledger.putInstructionSource({ sourceId: "parent", scope: "project", trust: "user", path: "/repo/AGENTS.md", content: "parent", priority: 1 });
		const child = await ledger.putInstructionSource({ sourceId: "child", scope: "task", trust: "user", parentSourceId: parent.sourceId, inherited: true, content: "child", priority: 10 });
		const managed = await ledger.putInstructionSource({ sourceId: "managed-disabled", scope: "managed", trust: "builtin", path: "/repo/locked.md", enabled: false, content: "managed", priority: 0 });
		await ledger.lockInstruction(managed.sourceId, { reason: "organization policy", lockedBy: "policy" });
		const excludedParent = await ledger.putInstructionSource({ sourceId: "disabled-parent", scope: "project", trust: "user", enabled: false, content: "disabled parent" });
		const excludedChild = await ledger.putInstructionSource({ sourceId: "disabled-child", scope: "task", trust: "user", parentSourceId: excludedParent.sourceId, inherited: true, content: "disabled child" });

		const resolution = await ledger.resolveInstructions({ path: "/repo/project/file.ts" });
		expect(resolution.sources.map((source) => source.sourceId)).toEqual([managed.sourceId, parent.sourceId, child.sourceId]);
		expect(resolution.decisions.find((decision) => decision.sourceId === child.sourceId)).toMatchObject({
			selected: true,
			parentSourceId: parent.sourceId,
			parentSelected: true,
			reason: "inherited_source",
		});
		expect(resolution.decisions.find((decision) => decision.sourceId === managed.sourceId)).toMatchObject({
			selected: true,
			managedLock: true,
			reason: "managed_lock_preserved",
		});
		expect(resolution.decisions.find((decision) => decision.sourceId === excludedChild.sourceId)).toMatchObject({
			selected: false,
			parentSelected: false,
			reason: "parent_excluded",
		});
		expect(resolution.decisions.every((decision, index) => decision.precedence === index)).toBe(true);

		const reversed = resolveInstructionSources(
			[child, parent, managed, excludedChild, excludedParent],
			(await session.findFoundationRecords({ kind: "fact", objectType: T5_LEDGER_OBJECT_TYPES.instructionLock })).filter((record): record is Extract<typeof record, { kind: "fact" }> => record.kind === "fact").map((record) => record.payload as unknown as InstructionLockV1),
			{ path: "/repo/project/file.ts" },
		);
		expect(reversed.digest).toBe(resolution.digest);

		const records = await session.findFoundationRecords({ kind: "fact", objectType: T5_LEDGER_OBJECT_TYPES.instructionResolution });
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({ objectType: T5_LEDGER_OBJECT_TYPES.instructionResolution, payload: { selectedSourceIds: [managed.sourceId, parent.sourceId, child.sourceId] } });
	});

	it("keeps memory child scopes independent across owners, parents, and provenance", async () => {
		const session = new Session(new InMemorySessionStorage({ id: "t5-memory-scope", createdAt: 1 }));
		const ledger = new SessionT5Ledger(session, {
			ownerId: "memory-scope",
			memoryScopeId: "root-scope",
			memoryOwnerId: "root-owner",
			artifactBlobStore: new InMemoryArtifactBlobStore(),
		});
		const root = await ledger.putMemory({ id: "root-memory", kind: "fact", trust: "user_owned", content: "root", source: "root-source", provenance: { taskId: "root-task" }, principal: "system" });
		const child = ledger.memory.fork({ scope: "agent", scopeId: "child-scope", ownerId: "child-owner", provenance: { taskId: "child-task" } });
		const childEntry = await child.put({ id: "child-memory", kind: "fact", trust: "user_owned", content: "child", source: "child-source", provenance: { taskId: "child-task" }, principal: "system" });

		expect(await ledger.memory.get(childEntry.id, "system")).toBeUndefined();
		expect(await child.get(root.id, "system")).toBeUndefined();
		const otherOwner = new SessionMemoryStore(session, ledger.artifacts, { writer: ledger.writer, memoryScopeId: "child-scope", memoryOwnerId: "other-owner", memoryParentId: "root-scope" });
		const otherParent = new SessionMemoryStore(session, ledger.artifacts, { writer: ledger.writer, memoryScopeId: "child-scope", memoryOwnerId: "child-owner", memoryParentId: "other-parent" });
		expect(await otherOwner.get(childEntry.id, "system")).toBeUndefined();
		expect(await otherParent.get(childEntry.id, "system")).toBeUndefined();
		expect(await child.list({ ownerId: "other-owner" }, "system")).toEqual([]);
		await expect(child.put({ id: "unauthorized-owner", kind: "fact", trust: "user_owned", content: "bad", source: "bad", ownerId: "other-owner", principal: "system" })).rejects.toMatchObject({ code: "policy_denied" });
		await expect(child.put({ id: "unauthorized-provenance", kind: "fact", trust: "user_owned", content: "bad", source: "bad", provenance: { taskId: "other-task" }, principal: "system" })).rejects.toMatchObject({ code: "policy_denied" });
		await expect(child.put({ id: "unauthorized-principal", kind: "fact", trust: "user_owned", content: "bad", source: "bad", provenance: { createdBy: "system" }, principal: "alice" })).rejects.toMatchObject({ code: "policy_denied" });
		await expect(child.put({ id: "invalid-child-parent", kind: "fact", trust: "user_owned", content: "bad", source: "bad", parentId: "other-parent", principal: "system" })).rejects.toMatchObject({ code: "policy_denied" });
	});
});

describe("T5 durable reopen and recovery regressions", () => {
	it("reopens memory with a new lease writer while preserving child boundaries", async () => {
		const session = new Session(new InMemorySessionStorage({ id: "t5-memory-reopen", createdAt: 1 }));
		const blobStore = new InMemoryArtifactBlobStore();
		const first = new SessionT5Ledger(session, { ownerId: "lease-first", artifactBlobStore: blobStore });
		const root = await first.putMemory({ id: "root-reopen", kind: "fact", trust: "user_owned", content: "root", source: "root-source", principal: "system" });
		const childStore = first.memory.fork({ scope: "agent", scopeId: "agent-reopen", ownerId: "agent-owner", provenance: { taskId: "task-reopen" } });
		const child = await childStore.put({ id: "child-reopen", kind: "fact", trust: "user_owned", content: "child", source: "child-source", provenance: { taskId: "task-reopen" }, principal: "system" });
		await first.writer.releaseLease();

		const reopened = new SessionT5Ledger(session, { ownerId: "lease-second", artifactBlobStore: blobStore });
		expect(await reopened.getMemory(root.id, "system")).toMatchObject({ id: root.id, content: "root" });
		expect(await reopened.memory.get(child.id, "system")).toBeUndefined();
		const reopenedChild = reopened.memory.fork({ scope: "agent", scopeId: "agent-reopen", ownerId: "agent-owner", provenance: { taskId: "task-reopen" } });
		expect(await reopenedChild.get(root.id, "system")).toBeUndefined();
		expect(await reopenedChild.get(child.id, "system")).toMatchObject({ id: child.id, content: "child" });
	});

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
