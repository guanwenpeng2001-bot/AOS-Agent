import { randomUUID } from "node:crypto";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createExecutionCorrelation } from "../../../src/harness/foundation/index.ts";
import { NodeExecutionEnv } from "../../../src/harness/env/nodejs.ts";
import { InMemorySessionStorage, JsonlSessionRepo, Session } from "../../../src/harness/session/index.ts";

const tempDirs: string[] = [];

function tempRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "aos-agent-t2-t3-"));
	tempDirs.push(root);
	return root;
}

function correlation(sessionId: string, fields: Record<string, string> = {}) {
	return createExecutionCorrelation(sessionId, "main", fields);
}

function foundationFact(sessionId: string, id: string, objectId: string) {
	return {
		schemaVersion: 1 as const,
		kind: "fact" as const,
		id,
		lane: "main",
		objectType: "task",
		objectId,
		clientRequestId: `request:${id}`,
		payload: { schemaVersion: 1, taskId: objectId, status: "ready" },
		correlation: correlation(sessionId, { taskId: objectId }),
	};
}

afterEach(() => {
	while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("T2 single Session ledger", () => {
	it("uses one sequence for legacy entries and Foundation facts", async () => {
		const session = new Session(new InMemorySessionStorage({ id: "single", createdAt: 1 }));
		await session.appendCustomEntry("legacy.anchor", { value: 1 });
		const lease = await session.acquireWriterLease({ ownerId: "ledger-test" });
		const accepted = await session.appendFoundationRecord({ ...foundationFact("single", "task-fact", "task-1"), fencingToken: lease.fencingToken });
		expect(accepted.record.seq).toBe(2);
		expect(await session.getLedgerRevision()).toBe(2);
		expect((await session.getLog({})).map((item) => item.kind)).toEqual(["entry", "foundation"]);
		expect((await session.getLog({})).map((item) => item.seq)).toEqual([1, 2]);
		await session.releaseWriterLease({ fencingToken: lease.fencingToken });
	});

	it("replays a retention request idempotently without a second physical record", async () => {
		const root = tempRoot();
		const env = new NodeExecutionEnv({ cwd: root });
		const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: root });
		const session = await repo.create({ id: "retention-replay", cwd: root });
		const lease = await session.acquireWriterLease({ ownerId: "retention-replay-test" });
		const policy = { schemaVersion: 1 as const, cutSequence: 0, reason: "replay-test" };
		const options = {
			clientRequestId: "retention-request-1",
			correlation: correlation("retention-replay"),
			fencingToken: lease.fencingToken,
		};

		const first = await session.setRetentionPolicy(policy, options);
		const replay = await session.setRetentionPolicy(policy, options);
		expect(first.replayed).toBe(false);
		expect(replay.replayed).toBe(true);
		expect(replay.record).toEqual(first.record);
		expect(await session.findFoundationRecords({ kind: "retention", order: "oldestFirst" })).toHaveLength(1);
		expect(await session.getLedgerRevision()).toBe(1);
		await session.releaseWriterLease({ fencingToken: lease.fencingToken });
	});
});

describe("T2 JSONL recovery and writer fencing", () => {
	it("migrates v4, removes a torn tail, and rejects complete corruption", async () => {
		const root = tempRoot();
		const env = new NodeExecutionEnv({ cwd: root });
		const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: root });
		const session = await repo.create({ id: "recovery", cwd: root });
		await session.appendCustomEntry("anchor", { value: 1 });
		const metadata = await session.getMetadata();
		appendFileSync(metadata.path, '{"kind":"entry","seq":99');

		const reopened = await repo.open(metadata);
		expect(await reopened.getLedgerRevision()).toBe(1);
		expect(JSON.parse(readFileSync(metadata.path, "utf8").split("\n")[0]!).version).toBe(5);
		expect(readFileSync(metadata.path, "utf8")).not.toContain('"seq":99');

		const corruptPath = join(root, "corrupt.jsonl");
		writeFileSync(corruptPath, `${JSON.stringify({ kind: "header", version: 4, id: "corrupt", createdAt: 1, cwd: root })}\n42\n`);
		await expect(repo.open({ id: "corrupt", createdAt: 1, cwd: root, path: corruptPath, modifiedAt: 1, sourceFormat: 4 })).rejects.toMatchObject({ code: "invalid_entry" });
	});

	it("fails closed when recovery or migration does not own the writer lock", async () => {
		const root = tempRoot();
		const env = new NodeExecutionEnv({ cwd: root });
		const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: root });
		const tornPath = join(root, "recovery-busy.jsonl");
		writeFileSync(tornPath, `${JSON.stringify({ kind: "header", version: 4, id: "recovery-busy", createdAt: 1, cwd: root })}\n{"kind":"entry","seq":99`);
		const lockPath = `${tornPath}.lease-lock`;
		const lock = await env.createExclusive(lockPath, JSON.stringify({ ownerId: `process-${process.pid}`, token: randomUUID(), expiresAt: Date.now() + 60_000 }));
		expect(lock.ok).toBe(true);
		await expect(repo.open({ id: "recovery-busy", createdAt: 1, cwd: root, path: tornPath, modifiedAt: 1, sourceFormat: 4 })).rejects.toMatchObject({ code: "session_writer_busy" });
		await env.remove(lockPath, { force: true });

		const migrationPath = join(root, "migration-busy.jsonl");
		writeFileSync(migrationPath, `${JSON.stringify({ kind: "header", version: 4, id: "migration-busy", createdAt: 1, cwd: root })}\n`);
		const migrationSession = await repo.open({ id: "migration-busy", createdAt: 1, cwd: root, path: migrationPath, modifiedAt: 1, sourceFormat: 4 });
		const migrationLockPath = `${migrationPath}.lease-lock`;
		const migrationLock = await env.createExclusive(migrationLockPath, JSON.stringify({ ownerId: `process-${process.pid}`, token: randomUUID(), expiresAt: Date.now() + 60_000 }));
		expect(migrationLock.ok).toBe(true);
		await expect(migrationSession.getLedgerRevision()).rejects.toMatchObject({ code: "session_writer_busy" });
		await env.remove(migrationLockPath, { force: true });
	});

	it("rejects persisted records with missing or mismatched fencing correlation", async () => {
		const root = tempRoot();
		const env = new NodeExecutionEnv({ cwd: root });
		const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: root });
		const session = await repo.create({ id: "fencing-corruption", cwd: root });
		const lease = await session.acquireWriterLease({ ownerId: "fencing-test" });
		await session.appendFoundationRecord({ ...foundationFact("fencing-corruption", "fence-fact", "task-fence"), fencingToken: lease.fencingToken });
		const metadata = await session.getMetadata();
		const original = readFileSync(metadata.path, "utf8");
		const lines = original.trimEnd().split("\n");
		const mutation = JSON.parse(lines[1]!) as { record: Record<string, unknown> };
		delete mutation.record.fencingToken;
		writeFileSync(metadata.path, `${lines[0]}\n${JSON.stringify(mutation)}\n`);
		await expect(repo.open(metadata)).rejects.toMatchObject({ code: "session_ledger_corrupt" });

		const restoredMutation = JSON.parse(lines[1]!) as { record: Record<string, unknown> };
		const correlation = restoredMutation.record.correlation as Record<string, unknown>;
		correlation.fencingToken = "different-fence";
		writeFileSync(metadata.path, `${lines[0]}\n${JSON.stringify(restoredMutation)}\n`);
		await expect(repo.open(metadata)).rejects.toMatchObject({ code: "session_ledger_corrupt" });
	});

	it("serializes two session instances and fences a pre-existing lock", async () => {
		const root = tempRoot();
		const env = new NodeExecutionEnv({ cwd: root });
		const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: root });
		const first = await repo.create({ id: "race", cwd: root });
		const metadata = await first.getMetadata();
		const second = await repo.open(metadata);
		const writes = await Promise.allSettled([first.appendMessage({ role: "user", content: [{ type: "text", text: "a" }], timestamp: 1 }), second.appendMessage({ role: "user", content: [{ type: "text", text: "b" }], timestamp: 1 })]);
		expect(writes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		expect(writes.filter((result) => result.status === "rejected")).toHaveLength(1);
		const reopened = await repo.open(metadata);
		expect((await reopened.findEntries({ order: "oldestFirst" })).map((entry) => entry.seq)).toEqual([1]);

		const locked = await env.createExclusive(
			`${metadata.path}.lease-lock`,
			JSON.stringify({ ownerId: `process-${process.pid}`, token: randomUUID(), expiresAt: Date.now() + 60_000 }),
		);
		expect(locked.ok).toBe(true);
		await expect(reopened.appendMessage({ role: "user", content: [{ type: "text", text: "blocked" }], timestamp: 1 })).rejects.toMatchObject({ code: "session_writer_busy" });
		await env.remove(`${metadata.path}.lease-lock`, { force: true });
	});

	it("fails closed on an expired physical lock without deleting a contender token", async () => {
		const root = tempRoot();
		const env = new NodeExecutionEnv({ cwd: root });
		const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: root });
		const session = await repo.create({ id: "expired-lock", cwd: root });
		const metadata = await session.getMetadata();
		const lockPath = `${metadata.path}.lease-lock`;
		const staleToken = randomUUID();
		const staleLock = JSON.stringify({ ownerId: "process-999999999", token: staleToken, expiresAt: Date.now() - 1 });
		expect((await env.createExclusive(lockPath, staleLock)).ok).toBe(true);

		const results = await Promise.allSettled([
			session.appendCustomEntry("contender-a", { value: 1 }),
			session.appendCustomEntry("contender-b", { value: 2 }),
		]);
		expect(results.every((result) => result.status === "rejected" && result.reason.code === "session_writer_busy")).toBe(true);
		const currentLock = await env.readTextFile(lockPath);
		expect(currentLock.ok).toBe(true);
		if (currentLock.ok) expect(JSON.parse(currentLock.value).token).toBe(staleToken);
		await env.remove(lockPath, { force: true });
	});

	it("checks the shared id namespace and refreshes a cross-instance revision", async () => {
		const root = tempRoot();
		const env = new NodeExecutionEnv({ cwd: root });
		const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: root });
		const first = await repo.create({ id: "shared-namespace", cwd: root });
		const metadata = await first.getMetadata();
		const second = await repo.open(metadata);
		const legacyId = await first.appendCustomEntry("legacy", { value: 1 });
		expect(await second.getLedgerRevision()).toBe(1);

		const lease = await first.acquireWriterLease({ ownerId: "shared-namespace-test" });
		const before = readFileSync(metadata.path, "utf8");
		await expect(
			first.appendFoundationRecord({
				...foundationFact("shared-namespace", legacyId, "task-collision"),
				fencingToken: lease.fencingToken,
			}),
		).rejects.toMatchObject({ code: "already_exists" });
		expect(readFileSync(metadata.path, "utf8")).toBe(before);
		expect(await second.getLedgerRevision()).toBe(1);
		await first.releaseWriterLease({ fencingToken: lease.fencingToken });
	});

	it("does not release a replaced lock after ownership is lost", async () => {
		const root = tempRoot();
		const env = new NodeExecutionEnv({ cwd: root });
		const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: root });
		const session = await repo.create({ id: "replacement", cwd: root });
		const metadata = await session.getMetadata();
		const lockPath = `${metadata.path}.lease-lock`;
		let appendEntered!: () => void;
		const appendStarted = new Promise<void>((resolve) => {
			appendEntered = resolve;
		});
		let allowAppend!: () => void;
		const appendGate = new Promise<void>((resolve) => {
			allowAppend = resolve;
		});
		const appendFile = env.appendFile.bind(env);
		env.appendFile = async (path, content) => {
			if (path === metadata.path) {
				appendEntered();
				await appendGate;
			}
			return appendFile(path, content);
		};

		const write = session.appendCustomEntry("replacement", { value: 1 });
		await appendStarted;
		const replacementToken = randomUUID();
		await env.remove(lockPath, { force: true });
		const replacement = await env.createExclusive(
			lockPath,
			JSON.stringify({ ownerId: `process-${process.pid}`, token: replacementToken, expiresAt: Date.now() + 60_000 }),
		);
		expect(replacement.ok).toBe(true);
		allowAppend();
		await expect(write).rejects.toMatchObject({ code: "session_writer_lease_lost" });
		const currentLock = await env.readTextFile(lockPath);
		expect(currentLock.ok).toBe(true);
		if (currentLock.ok) expect(JSON.parse(currentLock.value).token).toBe(replacementToken);
		await env.remove(lockPath, { force: true });
	});

	it("does not steal an expired lock while its owning process is alive", async () => {
		const root = tempRoot();
		const env = new NodeExecutionEnv({ cwd: root });
		const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: root });
		const first = await repo.create({ id: "active-lock", cwd: root });
		const metadata = await first.getMetadata();
		const second = await repo.open(metadata);
		let appendEntered!: () => void;
		const appendStarted = new Promise<void>((resolve) => {
			appendEntered = resolve;
		});
		let allowAppend!: () => void;
		const appendGate = new Promise<void>((resolve) => {
			allowAppend = resolve;
		});
		const appendFile = env.appendFile.bind(env);
		env.appendFile = async (path, content) => {
			if (path === metadata.path) {
				appendEntered();
				await appendGate;
			}
			return appendFile(path, content);
		};

		const write = first.appendCustomEntry("active", { value: 1 });
		await appendStarted;
		const lockPath = `${metadata.path}.lease-lock`;
		const lock = await env.readTextFile(lockPath);
		expect(lock.ok).toBe(true);
		if (lock.ok) {
			const value = JSON.parse(lock.value) as { expiresAt: number; ownerId: string; token: string };
			await env.writeFile(lockPath, JSON.stringify({ ...value, expiresAt: Date.now() - 1 }));
		}
		await expect(second.appendCustomEntry("blocked", { value: 2 })).rejects.toMatchObject({ code: "session_writer_busy" });
		allowAppend();
		await write;
	});

	it("rejects a stale fencing token after another instance acquires the lease", async () => {
		const root = tempRoot();
		const env = new NodeExecutionEnv({ cwd: root });
		const repo = new JsonlSessionRepo({ fs: env, sessionsRoot: root });
		const first = await repo.create({ id: "fencing-race", cwd: root });
		const metadata = await first.getMetadata();
		const second = await repo.open(metadata);
		const oldLease = await first.acquireWriterLease({ ownerId: "writer-a", ttlMs: 1 });
		await new Promise((resolve) => setTimeout(resolve, 10));
		const replacement = await second.acquireWriterLease({ ownerId: "writer-b", ttlMs: 60_000 });
		expect(replacement.fencingToken).not.toBe(oldLease.fencingToken);
		await expect(first.appendFoundationRecord({ ...foundationFact("fencing-race", "stale-fact", "task-stale"), fencingToken: oldLease.fencingToken })).rejects.toMatchObject({ code: "session_writer_fencing_token" });
		expect(await first.findFoundationRecords({ order: "oldestFirst" })).toHaveLength(0);
		expect(await first.getLedgerRevision()).toBe(0);
		await second.releaseWriterLease({ fencingToken: replacement.fencingToken });
	});
});
