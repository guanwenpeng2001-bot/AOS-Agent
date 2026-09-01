import { describe, expect, it } from "vitest";
import { createSessionManagerStorage } from "../../src/core/session/manager-storage.ts";
import { SessionManager, type SessionEntry } from "../../src/core/session/manager.ts";
import { ExecutionAuditQuery } from "../../src/core/session/execution-audit-query.ts";

const SESSION_ID = "audit-integrity-session";
const RUN_ID = "audit-integrity-run";

function acceptedRecord(sessionId = SESSION_ID): Record<string, unknown> {
	return {
		schemaVersion: 1,
		kind: "accepted",
		record: {
			id: RUN_ID,
			sessionId,
			attempt: 1,
			status: "accepted",
			model: { provider: "fixture", id: "fixture-model", thinkingLevel: "off" },
		},
	};
}

describe("execution audit integrity", () => {
	it("detects a modified physical audit source and accepts legacy entries", () => {
		const manager = SessionManager.inMemory("/workspace", { id: SESSION_ID });
		manager.appendCustomEntry("automation.run", acceptedRecord());
		const sealed = manager.getPhysicalEntries();
		const valid = new ExecutionAuditQuery(manager, { cursorSecret: "x".repeat(32) }).query({
			scope: "current-session",
		});
		expect(valid.integrity.status).toBe("verified");

		const tampered = structuredClone(sealed);
		const source = tampered[0] as SessionEntry & { data: Record<string, unknown> };
		(source.data.record as Record<string, unknown>).status = "failed";
		const damaged = new ExecutionAuditQuery({
			getSessionId: () => SESSION_ID,
			getEntries: () => tampered,
		}, { cursorSecret: "x".repeat(32) }).query({ scope: "current-session" });
		expect(damaged.integrity.status).toBe("invalid");
		expect(damaged.integrity.sessions[0]?.failure).toMatchObject({
			sourceEntryId: source.id,
			reason: "digest_mismatch",
		});

		const legacyEntry: SessionEntry = {
			type: "custom",
			id: "legacy-accepted",
			parentId: null,
			timestamp: "2026-09-01T00:00:00.000Z",
			customType: "automation.run",
			data: acceptedRecord(),
		};
		const legacy = new ExecutionAuditQuery({
			getSessionId: () => SESSION_ID,
			getEntries: () => [legacyEntry],
		}).query({ scope: "current-session" });
		expect(legacy.integrity.status).toBe("legacy");
		expect(legacy.integrity.cursorProtection).toBe("legacy-fallback");
	});

	it("exports replayable redacted events with a JSONL proof", () => {
		const manager = SessionManager.inMemory("/workspace", { id: SESSION_ID });
		manager.appendCustomEntry("automation.run", acceptedRecord());
		const exported = new ExecutionAuditQuery(manager, { cursorSecret: "x".repeat(32) }).export({
			scope: "current-session",
			runId: RUN_ID,
		});
		const lines = exported.jsonl.trimEnd().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
		expect(exported.mediaType).toBe("application/x-ndjson");
		expect(lines[0]).toMatchObject({ kind: "audit.export", schemaVersion: 1 });
		expect(lines.slice(1, -1).map((line) => line.kind)).toEqual(["audit.event", "audit.event"]);
		expect(lines.at(-1)).toMatchObject({
			kind: "audit.proof",
			eventCount: exported.eventCount,
			eventsDigest: exported.eventsDigest,
		});
		expect(exported.jsonl).not.toContain("clientRequestId");
	});

	it("physically prunes retained Foundation payloads idempotently", async () => {
		const manager = SessionManager.inMemory("/workspace", { id: SESSION_ID });
		const storage = createSessionManagerStorage(manager);
		const lease = await storage.acquireWriterLease({ ownerId: "retention-test" });
		const fact = await storage.appendFoundationRecord({
			schemaVersion: 1,
			kind: "fact",
			id: "retained-fact",
			lane: "main",
			objectType: "fixture",
			objectId: "fixture-1",
			clientRequestId: "fact-create",
			expectedRevision: 0,
			fencingToken: lease.fencingToken,
			correlation: { sessionId: SESSION_ID, laneId: "main", revision: 0 },
			payload: { privateValue: "removed" },
		});
		await storage.appendFoundationRecord({
			schemaVersion: 1,
			kind: "fact",
			id: "retained-fact-current",
			lane: "main",
			objectType: "fixture",
			objectId: "fixture-1",
			clientRequestId: "fact-update",
			expectedRevision: 1,
			fencingToken: lease.fencingToken,
			correlation: { sessionId: SESSION_ID, laneId: "main", revision: 0 },
			payload: { currentValue: "kept" },
		});
		const options = {
			clientRequestId: "retention-create",
			fencingToken: lease.fencingToken,
			correlation: { sessionId: SESSION_ID, laneId: "main", revision: 0 },
		};
		const first = await storage.setRetentionPolicy(
			{ schemaVersion: 1, cutSequence: fact.record.seq, reason: "fixture" },
			options,
		);
		expect(first.replayed).toBe(false);
		expect(JSON.stringify(manager.getPhysicalEntries())).not.toContain("privateValue");
		expect(manager.getPhysicalEntries().filter((entry) =>
			entry.type === "custom" &&
			typeof entry.data === "object" &&
			entry.data !== null &&
			"retentionPruned" in entry.data &&
			entry.data.retentionPruned === true
		)).toHaveLength(1);
		const count = manager.getPhysicalEntries().length;
		const replay = await storage.setRetentionPolicy(
			{ schemaVersion: 1, cutSequence: fact.record.seq, reason: "fixture" },
			options,
		);
		expect(replay.replayed).toBe(true);
		expect(manager.getPhysicalEntries()).toHaveLength(count);
	});
});
