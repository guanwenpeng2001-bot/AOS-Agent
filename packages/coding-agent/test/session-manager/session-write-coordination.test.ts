import { mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import lockfile from "proper-lockfile";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ExecutionAuditQuery } from "../../src/core/execution-audit-query.ts";
import {
	loadEntriesFromFile,
	SessionManager,
	type SessionEntry,
} from "../../src/core/session-manager.ts";
import {
	createSessionManagerStorage,
	FOUNDATION_ENTRY_CUSTOM_TYPE,
} from "../../src/core/session-manager-storage.ts";
import {
	SessionWriteCoordinationError,
	SessionWriteCoordinator,
} from "../../src/core/session-write-coordinator.ts";

const repoRoot = resolve(fileURLToPath(new URL("../../../..", import.meta.url)));
const workerPath = fileURLToPath(new URL("./session-write-worker.ts", import.meta.url));

function assistantMessage(text: string, timestamp: number) {
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: "anthropic-messages",
		provider: "test",
		model: "test-model",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		timestamp,
	};
}

function createPersistedSession(sessionDir: string): string {
	const session = SessionManager.create(sessionDir, sessionDir);
	session.appendMessage({ role: "user", content: "seed", timestamp: 1 });
	session.appendMessage(assistantMessage("seed reply", 2));
	const sessionFile = session.getSessionFile();
	if (!sessionFile) throw new Error("Expected a persisted session file");
	return sessionFile;
}

function runWorker(sessionFile: string, marker: string, count: number): Promise<{ code: number; stderr: string }> {
	return new Promise((resolveWorker, reject) => {
		const child = spawn(process.execPath, ["--import", "tsx", workerPath, sessionFile, marker, String(count)], {
			cwd: repoRoot,
			stdio: ["ignore", "ignore", "pipe"],
		});
		let stderr = "";
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});
		child.once("error", reject);
		child.once("close", (code) => resolveWorker({ code: code ?? -1, stderr }));
	});
}

describe("SessionWriteCoordinator", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `session-write-coordination-${Date.now()}-${Math.random().toString(16).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("serializes concurrent multi-process appends into complete ordered lines", async () => {
		const sessionFile = createPersistedSession(tempDir);
		const count = 12;
		const results = await Promise.all([
			runWorker(sessionFile, "writer-a", count),
			runWorker(sessionFile, "writer-b", count),
		]);

		expect(results).toEqual([
			{ code: 0, stderr: "" },
			{ code: 0, stderr: "" },
		]);

		const entries = loadEntriesFromFile(sessionFile);
		const workerEntries = entries.filter(
			(entry): entry is Extract<SessionEntry, { type: "custom" }> =>
				entry.type === "custom" && entry.customType === "session-write-worker",
		);
		expect(workerEntries).toHaveLength(count * 2);
		for (const marker of ["writer-a", "writer-b"]) {
			const indexes = workerEntries
				.filter((entry) => (entry.data as { marker?: unknown }).marker === marker)
				.map((entry) => (entry.data as { index?: unknown }).index);
			expect(indexes).toEqual([...Array(count).keys()]);
		}

		const lines = readFileSync(sessionFile, "utf8").trim().split("\n");
		expect(lines.every((line) => JSON.parse(line))).toBe(true);
	});

	it("recovers a stale lock and leaves the ledger append-only", () => {
		const sessionFile = createPersistedSession(tempDir);
		const lockPath = `${sessionFile}.lock`;
		mkdirSync(lockPath);
		const staleAt = new Date(Date.now() - 60_000);
		utimesSync(lockPath, staleAt, staleAt);

		const session = SessionManager.open(sessionFile, tempDir);
		const entryId = session.appendCustomEntry("stale-lock-recovery", { ok: true });
		const entries = loadEntriesFromFile(sessionFile);

		expect(entries.at(-1)).toMatchObject({ id: entryId, type: "custom", customType: "stale-lock-recovery" });
		expect(lockfile.checkSync(sessionFile, { realpath: false })).toBe(false);
	});

	it("times out a failed writer without mutating local or persisted entries", () => {
		const sessionFile = createPersistedSession(tempDir);
		const release = lockfile.lockSync(sessionFile, { realpath: false, stale: 30_000 });
		try {
			const session = SessionManager.open(sessionFile, tempDir);
			const coordinator = new SessionWriteCoordinator(sessionFile, tempDir, {
				lockTimeoutMs: 40,
				retryDelayMs: 5,
			});
			let callbackCalled = false;
			let thrown: unknown;
			try {
				coordinator.withWriteLock(() => {
					callbackCalled = true;
				});
			} catch (error) {
				thrown = error;
			}
			expect(thrown).toBeInstanceOf(SessionWriteCoordinationError);
			expect(thrown).toMatchObject({ code: "session_write_lock_timeout" });
			expect(callbackCalled).toBe(false);
			expect(() => session.appendCustomEntry("failed-writer", { shouldPersist: false })).toThrowError(
			SessionWriteCoordinationError,
		);
			expect(session.getEntries()).toHaveLength(2);
		} finally {
			release();
		}

		expect(loadEntriesFromFile(sessionFile)).toHaveLength(3);
	});

	it("locks candidate artifact rollback and leaves it retryable after lock contention", () => {
		const sessionFile = createPersistedSession(tempDir);
		const originalContents = readFileSync(sessionFile);
		const artifact = SessionManager.stageArtifactRollback(sessionFile);
		if (artifact === undefined) throw new Error("Expected a staged Session artifact");
		writeFileSync(sessionFile, "candidate mutation\n");

		const release = lockfile.lockSync(sessionFile, { realpath: false, stale: 30_000 });
		let failure: unknown;
		try {
			try {
				artifact.rollback();
			} catch (error) {
				failure = error;
			}
			expect(failure).toBeInstanceOf(SessionWriteCoordinationError);
			expect(failure).toMatchObject({ code: "session_write_lock_timeout" });
			expect(readFileSync(sessionFile, "utf8")).toBe("candidate mutation\n");
		} finally {
			release();
		}

		artifact.rollback();
		expect(readFileSync(sessionFile)).toEqual(originalContents);
	});

	it("commits a detached snapshot with no candidate delta after an accepted source write", () => {
		const source = SessionManager.create(tempDir, tempDir);
		const storage = createSessionManagerStorage(source);
		storage.appendHarnessEntry({
			type: "message",
			id: "detached-base",
			message: { role: "user", content: "base", timestamp: 1 },
		}, "main");
		source.flushPendingSession();
		const candidate = source.createDetachedSnapshot();

		storage.appendHarnessEntry({
			type: "message",
			id: "accepted-source",
			message: { role: "user", content: "accepted source", timestamp: 2 },
		}, "main");
		source.flushPendingSession();
		const sessionFile = source.getSessionFile();
		if (sessionFile === undefined) throw new Error("Expected a persisted detached Session");
		const contentsBeforeCommit = readFileSync(sessionFile);
		candidate.commitDetachedSnapshot(source);

		expect(candidate.getBranch().flatMap((entry) =>
			entry.type === "message" && entry.message.role === "user" ? [entry.message.content] : []
		)).toEqual(["base", "accepted source"]);
		expect(candidate.buildSessionContext().messages.flatMap((message) =>
			message.role === "user" ? [message.content] : []
		)).toEqual(["base", "accepted source"]);
		expect(readFileSync(sessionFile)).toEqual(contentsBeforeCommit);
		expect(candidate.getPhysicalEntries()).toEqual(loadEntriesFromFile(sessionFile).slice(1));
	});

	it("rejects a detached canonical payload id collision before changing storage", () => {
		const source = SessionManager.create(tempDir, tempDir);
		const storage = createSessionManagerStorage(source);
		const root = storage.appendHarnessEntry({
			type: "custom",
			id: "source-canonical-id",
			customType: "fixture.source",
		}, "main");
		source.flushPendingSession();
		const candidate = source.createDetachedSnapshot();
		candidate.appendCustomEntry(FOUNDATION_ENTRY_CUSTOM_TYPE, {
			schemaVersion: 1,
			kind: "entry",
			entry: {
				type: "custom",
				id: root.id,
				seq: candidate.getPhysicalEntries().length + 1,
				parentId: root.id,
				timestamp: 2,
				customType: "fixture.collision",
			},
		});
		const sessionFile = source.getSessionFile();
		if (sessionFile === undefined) throw new Error("Expected a persisted collision Session");
		const originalContents = readFileSync(sessionFile);

		expect(() => candidate.commitDetachedSnapshot(source)).toThrow(
			"Detached Session snapshot durable id collides with source entry source-canonical-id",
		);
		expect(readFileSync(sessionFile)).toEqual(originalContents);
	});

	it("preserves a candidate thread branch while merging a concurrent source-main write", async () => {
		const source = SessionManager.create(tempDir, tempDir);
		const sourceStorage = createSessionManagerStorage(source);
		const root = await sourceStorage.appendEntry({
			type: "custom",
			id: "lane-base",
			customType: "fixture.base",
		}, "main");
		await sourceStorage.createLane("thread", root.id);
		source.flushPendingSession();
		const candidate = source.createDetachedSnapshot();
		const candidateStorage = createSessionManagerStorage(candidate);
		const candidateThread = await candidateStorage.appendEntry({
			type: "custom",
			id: "candidate-thread",
			customType: "fixture.thread",
		}, "thread");
		const candidateMain = await candidateStorage.appendEntry({
			type: "custom",
			id: "candidate-main",
			customType: "fixture.candidate-main",
		}, "main");
		const sourceMain = await sourceStorage.appendEntry({
			type: "custom",
			id: "source-main",
			customType: "fixture.main",
		}, "main");

		candidate.commitDetachedSnapshot(source);

		expect(await candidateStorage.getEntry(candidateThread.id)).toMatchObject({ parentId: root.id });
		expect(await candidateStorage.getEntry(sourceMain.id)).toMatchObject({ parentId: root.id });
		expect(await candidateStorage.getEntry(candidateMain.id)).toMatchObject({ parentId: sourceMain.id });
		expect(await candidateStorage.getLanes()).toEqual(expect.arrayContaining([
			{ lane: "main", leafId: candidateMain.id },
			{ lane: "thread", leafId: candidateThread.id },
		]));
	});

	it("rebases the first candidate thread append after a concurrent source-thread append", async () => {
		const source = SessionManager.create(tempDir, tempDir);
		const sourceStorage = createSessionManagerStorage(source);
		const root = await sourceStorage.appendEntry({
			type: "custom",
			id: "same-thread-root",
			customType: "fixture.root",
		}, "main");
		await sourceStorage.createLane("thread", root.id);
		const threadBase = await sourceStorage.appendEntry({
			type: "custom",
			id: "same-thread-base",
			customType: "fixture.thread-base",
		}, "thread");
		source.flushPendingSession();
		const candidate = source.createDetachedSnapshot();
		const candidateStorage = createSessionManagerStorage(candidate);
		const candidateThread = await candidateStorage.appendEntry({
			type: "custom",
			id: "same-thread-candidate",
			customType: "fixture.candidate",
		}, "thread");
		const sourceThread = await sourceStorage.appendEntry({
			type: "custom",
			id: "same-thread-source",
			customType: "fixture.source",
		}, "thread");

		candidate.commitDetachedSnapshot(source);

		expect(await candidateStorage.getEntry(sourceThread.id)).toMatchObject({ parentId: threadBase.id });
		expect(await candidateStorage.getEntry(candidateThread.id)).toMatchObject({ parentId: sourceThread.id });
		expect(await candidateStorage.getLanes()).toEqual(expect.arrayContaining([
			{ lane: "thread", leafId: candidateThread.id },
		]));
		expect((await candidateStorage.findEntriesOnBranch({
			start: candidateThread.id,
			order: "oldestFirst",
		})).map((entry) => entry.id)).toEqual([
			root.id,
			threadBase.id,
			sourceThread.id,
			candidateThread.id,
		]);
	});

	it("preserves an explicit candidate thread move before its first append", async () => {
		const source = SessionManager.create(tempDir, tempDir);
		const sourceStorage = createSessionManagerStorage(source);
		const root = await sourceStorage.appendEntry({
			type: "custom",
			id: "moved-thread-root",
			customType: "fixture.root",
		}, "main");
		await sourceStorage.createLane("thread", root.id);
		await sourceStorage.appendEntry({
			type: "custom",
			id: "moved-thread-base",
			customType: "fixture.thread-base",
		}, "thread");
		const candidate = source.createDetachedSnapshot();
		const candidateStorage = createSessionManagerStorage(candidate);
		await candidateStorage.moveLane("thread", root.id);
		const candidateThread = await candidateStorage.appendEntry({
			type: "custom",
			id: "moved-thread-candidate",
			customType: "fixture.candidate",
		}, "thread");
		const sourceThread = await sourceStorage.appendEntry({
			type: "custom",
			id: "moved-thread-source",
			customType: "fixture.source",
		}, "thread");

		candidate.commitDetachedSnapshot(source);

		expect(await candidateStorage.getEntry(candidateThread.id)).toMatchObject({ parentId: root.id });
		expect(await candidateStorage.getEntry(sourceThread.id)).toBeDefined();
		expect((await candidateStorage.findEntriesOnBranch({
			start: candidateThread.id,
			order: "oldestFirst",
		})).map((entry) => entry.id)).toEqual([root.id, candidateThread.id]);
	});

	it("rebases a base-equal candidate thread move and its following append", async () => {
		const source = SessionManager.create(tempDir, tempDir);
		const sourceStorage = createSessionManagerStorage(source);
		const root = await sourceStorage.appendEntry({
			type: "custom",
			id: "noop-thread-root",
			customType: "fixture.root",
		}, "main");
		await sourceStorage.createLane("thread", root.id);
		const threadBase = await sourceStorage.appendEntry({
			type: "custom",
			id: "noop-thread-base",
			customType: "fixture.thread-base",
		}, "thread");
		const candidate = source.createDetachedSnapshot();
		const candidateStorage = createSessionManagerStorage(candidate);
		await candidateStorage.moveLane("thread", threadBase.id);
		const candidateThread = await candidateStorage.appendEntry({
			type: "custom",
			id: "noop-thread-candidate",
			customType: "fixture.candidate",
		}, "thread");
		const sourceThread = await sourceStorage.appendEntry({
			type: "custom",
			id: "noop-thread-source",
			customType: "fixture.source",
		}, "thread");

		candidate.commitDetachedSnapshot(source);

		expect(await candidateStorage.getEntry(candidateThread.id)).toMatchObject({ parentId: sourceThread.id });
		expect((await candidateStorage.findEntriesOnBranch({
			start: candidateThread.id,
			order: "oldestFirst",
		})).map((entry) => entry.id)).toEqual([
			root.id,
			threadBase.id,
			sourceThread.id,
			candidateThread.id,
		]);
	});

	it("rejects a session path outside its configured root", () => {
		const rootDir = join(tempDir, "root");
		mkdirSync(rootDir);
		const outsideDir = join(tempDir, "outside");
		mkdirSync(outsideDir);
		const outsideFile = join(outsideDir, "session.jsonl");
		expect(() => new SessionWriteCoordinator(outsideFile, rootDir)).toThrowError(
			new SessionWriteCoordinationError(
				"session_write_path_invalid",
				resolve(outsideFile),
				"Session write path is outside the configured session root",
			),
		);
	});

	it("lets read-only audit and replay inspect a locked session", () => {
		const sessionFile = createPersistedSession(tempDir);
		const release = lockfile.lockSync(sessionFile, { realpath: false, stale: 30_000 });
		try {
			const session = SessionManager.open(sessionFile, tempDir);
			const query = new ExecutionAuditQuery(session);
			expect(query.query({ scope: "current-session", limit: 1 }).warnings).toEqual([]);
			expect(query.query({ scope: "session-directory", limit: 1 }).warnings).toEqual([]);
			expect(() => query.replay("missing-run")).toThrow();
		} finally {
			release();
		}
	});
});
