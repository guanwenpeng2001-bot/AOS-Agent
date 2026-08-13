import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it } from "vitest";

import {
	AUDIT_MAX_SESSION_CANDIDATES,
	ExecutionAuditQuery,
	createExecutionAuditQuery,
} from "../src/core/execution-audit-query.ts";
import { ExecutionAuditError, type AuditSession, type AuditEvent } from "../src/core/execution-audit.ts";
import type { FileEntry, SessionEntry } from "../src/core/session-manager.ts";

const CURRENT_SESSION_ID = "session-query-current";
const RUN_ID = "run-query-1";
const ACCEPTED_AT = "2026-08-13T00:00:00.000Z";
const TERMINAL_AT = "2026-08-13T00:00:01.000Z";

function customEntry(id: string, timestamp: string, customType: string, data: unknown): SessionEntry {
	return { type: "custom", id, parentId: null, timestamp, customType, data };
}

function acceptedEntry(sessionId = CURRENT_SESSION_ID, entryId = "accepted"): SessionEntry {
	return customEntry(entryId, ACCEPTED_AT, "automation.run", {
		schemaVersion: 1,
		kind: "accepted",
		record: {
			id: RUN_ID,
			sessionId,
			attempt: 1,
			status: "accepted",
			model: { provider: "provider", id: "model", thinkingLevel: "high" },
		},
	});
}

function terminalEntry(entryId = "terminal"): SessionEntry {
	return customEntry(entryId, TERMINAL_AT, "automation.run", {
		schemaVersion: 1,
		kind: "terminal",
		endedAt: TERMINAL_AT,
		receipt: {
			runId: RUN_ID,
			sessionId: CURRENT_SESSION_ID,
			status: "completed",
			usage: { input: 1, output: 1, total: 2 },
		},
	});
}

function source(sessionId: string, entries: ReadonlyArray<SessionEntry>, sessionDir: string): AuditSession & { getSessionDir(): string } {
	return {
		getSessionId: () => sessionId,
		getEntries: () => entries,
		getSessionDir: () => sessionDir,
	};
}

function writeSession(dir: string, sessionId: string, entries: ReadonlyArray<SessionEntry>, fileName = sessionId): string {
	const path = join(dir, `${fileName}.jsonl`);
	const header: FileEntry = {
		type: "session",
		version: 3,
		id: sessionId,
		timestamp: ACCEPTED_AT,
		cwd: dir,
	};
	writeFileSync(path, `${JSON.stringify(header)}\n${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
	return path;
}

describe("cross-session execution audit query", () => {
	it("merges directory sessions deterministically and deduplicates source identity", () => {
		const dir = mkdtempSync(join(tmpdir(), "aos-audit-query-"));
		try {
			writeSession(dir, "session-a", [acceptedEntry("session-a", "same-source")]);
			writeSession(dir, "session-a", [acceptedEntry("session-a", "same-source")], "session-a-copy");
			writeSession(dir, "session-b", [acceptedEntry("session-b", "other-source")]);
			const query = createExecutionAuditQuery(source(CURRENT_SESSION_ID, [], dir));

			const result = query.query({ scope: "session-directory", types: ["run.accepted"], limit: 200 });
			expect(result.events.map((event) => `${event.sessionId}:${event.sourceEntryId}`)).toEqual([
				"session-a:same-source",
				"session-b:other-source",
			]);
			expect(result.events).toHaveLength(2);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("binds cursors to the directory query, including scope and limit", () => {
		const dir = mkdtempSync(join(tmpdir(), "aos-audit-query-"));
		try {
			writeSession(dir, "session-a", [acceptedEntry("session-a", "a")]);
			writeSession(dir, "session-b", [acceptedEntry("session-b", "b")]);
			const query = new ExecutionAuditQuery(source(CURRENT_SESSION_ID, [], dir), { cursorSecret: "query-secret" });
			const first = query.query({ scope: "session-directory", limit: 1 });
			expect(first.nextCursor).toBeDefined();
			expect(query.query({ scope: "session-directory", limit: 1, cursor: first.nextCursor }).events).toHaveLength(1);
			expect(() => query.query({ scope: "session-directory", limit: 2, cursor: first.nextCursor })).toThrowError(
				new ExecutionAuditError("audit_cursor_invalid"),
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps directory paths server-resolved and rejects symlink candidates safely", () => {
		const dir = mkdtempSync(join(tmpdir(), "aos-audit-query-"));
		const outside = mkdtempSync(join(tmpdir(), "aos-audit-outside-"));
		try {
			writeSession(outside, "outside", [acceptedEntry("outside")]);
			try {
				symlinkSync(join(outside, "outside.jsonl"), join(dir, "outside.jsonl"));
			} catch {
				return;
			}
			const result = new ExecutionAuditQuery(source(CURRENT_SESSION_ID, [], dir)).query({
				scope: "session-directory",
				limit: 200,
			});
			expect(result.events).toEqual([]);
			expect(result.warnings.some((warning) => warning.code === "source_unavailable")).toBe(true);
			expect(JSON.stringify(result)).not.toContain(outside);
		} finally {
			rmSync(dir, { recursive: true, force: true });
			rmSync(outside, { recursive: true, force: true });
		}
	});

	it("returns complete and interrupted replay without invoking execution", () => {
		const completeEntries = [acceptedEntry(CURRENT_SESSION_ID), terminalEntry()];
		const complete = new ExecutionAuditQuery(source(CURRENT_SESSION_ID, completeEntries, ""));
		expect(complete.replay(RUN_ID).status).toBe("complete");

		const interrupted = new ExecutionAuditQuery(source(CURRENT_SESSION_ID, [acceptedEntry()], ""));
		const replay = interrupted.replay(RUN_ID);
		expect(replay.status).toBe("interrupted");
		expect(replay.events.some((event: AuditEvent) => event.type === "run.interrupted")).toBe(true);

		const incomplete = new ExecutionAuditQuery(
			source(CURRENT_SESSION_ID, [acceptedEntry(), customEntry("unknown", TERMINAL_AT, "unknown.source", { raw: "secret" })], ""),
		);
		const incompleteReplay = incomplete.replay(RUN_ID);
		expect(incompleteReplay.status).toBe("incomplete");
		expect(incompleteReplay.warnings.map((warning) => warning.code)).toContain("unknown_source");
		expect(JSON.stringify(incompleteReplay)).not.toContain("secret");
	});

	it("enforces the candidate limit before reading unbounded files", () => {
		const dir = mkdtempSync(join(tmpdir(), "aos-audit-query-"));
		try {
			writeSession(dir, "session-a", [acceptedEntry("session-a")]);
			writeSession(dir, "session-b", [acceptedEntry("session-b")]);
			const query = new ExecutionAuditQuery(source(CURRENT_SESSION_ID, [], dir), { maxCandidates: 1 });
			expect(() => query.query({ scope: "session-directory" })).toThrowError(new ExecutionAuditError("audit_scope_unavailable"));
			expect(AUDIT_MAX_SESSION_CANDIDATES).toBeGreaterThan(1);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
