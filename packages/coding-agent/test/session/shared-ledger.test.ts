import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Session } from "@aos-agent/agent-core";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session/manager.ts";
import { SessionManagerStorage } from "../../src/core/session/manager-storage.ts";
import { SqliteSharedSessionLedger } from "../../src/sqlite-session.ts";

const roots: string[] = [];

function temporaryRoot(): string {
	const root = join(tmpdir(), `aos-shared-ledger-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(root, { recursive: true });
	roots.push(root);
	return root;
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("coding-agent SQLite shared ledger", () => {
	it("requires explicit cross-Host take-over and exposes its audit record", async () => {
		const root = temporaryRoot();
		const databasePath = join(root, "shared.sqlite");
		await using firstHost = new SqliteSharedSessionLedger({ databasePath, cwd: root, hostId: "host-a" });
		await using secondHost = new SqliteSharedSessionLedger({ databasePath, cwd: root, hostId: "host-b" });
		const firstWriter = await firstHost.create({ cwd: root, id: "shared-session" });

		await expect(secondHost.open("shared-session")).rejects.toThrow("already has an active writer");
		const secondWriter = await secondHost.open("shared-session", { takeOver: true });
		await expect(firstWriter.appendCustomEntry("stale-host.write")).rejects.toThrow("writer lease was lost");
		await secondWriter.appendCustomEntry("replacement-host.write");
		expect(await secondHost.getWriterTakeoverAudit("shared-session")).toEqual([
			{
				sessionId: "shared-session",
				fence: 2,
				previousOwnerId: "host-a",
				ownerId: "host-b",
				previousFence: 1,
				previousExpiresAtMs: expect.any(Number),
				takenOverAtMs: expect.any(Number),
				reason: "forced",
			},
		]);
	});

	it("round-trips a branched JSONL session through SQLite", async () => {
		const root = temporaryRoot();
		const sourceManager = SessionManager.create(root, join(root, "source"), { id: "shared-session" });
		const source = new Session(new SessionManagerStorage(sourceManager));
		const first = await source.appendMessage({ role: "user", content: "first", timestamp: 1 });
		const second = await source.appendCustomEntry("fixture.branch", { value: 2 });
		await source.moveLane("main", first);
		const branch = await source.appendCustomEntry("fixture.branch", { value: 3 });
		await source.createLane("saved-tail", second);
		await source.setName("shared ledger fixture");
		await source.setLabel(branch, "branch tip");
		const sourceLease = await source.acquireWriterLease({ ownerId: "migration-source" });
		await source.appendFoundationRecord({
			schemaVersion: 1,
			kind: "fact",
			id: "fixture-fact-1",
			lane: "main",
			objectType: "fixture",
			objectId: "shared",
			clientRequestId: "fixture-request-1",
			fencingToken: sourceLease.fencingToken,
			correlation: { sessionId: "shared-session", laneId: "main", revision: 0 },
			payload: { value: "durable" },
		});
		await source.releaseWriterLease({ fencingToken: sourceLease.fencingToken });
		await source.drain();
		sourceManager.flushPendingSession();
		const sourcePath = sourceManager.getSessionFile();
		if (sourcePath === undefined) throw new Error("Expected persisted source session");

		const databasePath = join(root, "shared.sqlite");
		await using importer = new SqliteSharedSessionLedger({ databasePath, cwd: root });
		await importer.importJsonl(sourcePath);
		await importer.close();

		const exportedPath = join(root, "roundtrip", "session.jsonl");
		await using exporter = new SqliteSharedSessionLedger({ databasePath, cwd: root });
		const follower = await exporter.open("shared-session", { access: "follower" });
		await expect(follower.appendCustomEntry("fixture.write")).rejects.toThrow("read-only projection");
		await exporter.exportJsonl("shared-session", exportedPath);

		expect(existsSync(exportedPath)).toBe(true);
		const roundTrip = new Session(new SessionManagerStorage(SessionManager.open(exportedPath)));
		const entries = await roundTrip.findEntries({ order: "oldestFirst" });
		expect(entries.map((entry) => ({ id: entry.id, parentId: entry.parentId, type: entry.type }))).toEqual([
			{ id: first, parentId: null, type: "message" },
			{ id: second, parentId: first, type: "custom" },
			{ id: branch, parentId: first, type: "custom" },
		]);
		expect(await roundTrip.getLanes()).toEqual(expect.arrayContaining([
			{ lane: "main", leafId: branch },
			{ lane: "saved-tail", leafId: second },
		]));
		expect(await roundTrip.getName()).toBe("shared ledger fixture");
		expect(await roundTrip.getLabel(branch)).toBe("branch tip");
		expect(await roundTrip.getFoundationObject("fixture", "shared")).toMatchObject({
			kind: "fact",
			payload: { value: "durable" },
		});
	});
});
