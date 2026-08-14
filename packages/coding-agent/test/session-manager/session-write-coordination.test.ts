import { mkdirSync, readFileSync, rmSync, utimesSync } from "node:fs";
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
