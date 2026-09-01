import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager, type SessionHeader } from "../../src/core/session/manager.ts";
import { createSessionManagerStorage } from "../../src/core/session/manager-storage.ts";

const roots: string[] = [];

function createRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "aos-session-archive-"));
	roots.push(root);
	return root;
}

function readHeader(path: string): SessionHeader {
	return JSON.parse(readFileSync(path, "utf8").split("\n")[0]!) as SessionHeader;
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("session archive", () => {
	it("persists archive metadata and keeps repeated archive calls idempotent", async () => {
		const root = createRoot();
		const sessionDir = join(root, "sessions");
		const manager = SessionManager.create(root, sessionDir, { id: "archive-target" });
		const archivedAt = new Date("2026-09-01T12:00:00.000Z");

		expect(manager.setArchived(true, archivedAt)).toEqual({
			archived: true,
			archivedAt: archivedAt.toISOString(),
		});
		expect(manager.setArchived(true, new Date("2026-09-02T12:00:00.000Z"))).toEqual({
			archived: true,
			archivedAt: archivedAt.toISOString(),
		});

		const sessionFile = manager.getSessionFile()!;
		expect(readHeader(sessionFile)).toMatchObject({
			archived: true,
			archivedAt: archivedAt.toISOString(),
		});
		expect(SessionManager.open(sessionFile).getArchiveState()).toEqual({
			archived: true,
			archivedAt: archivedAt.toISOString(),
		});

		const storage = createSessionManagerStorage(manager);
		expect(await storage.getMetadata()).toMatchObject({
			archived: true,
			archivedAt: archivedAt.getTime(),
		});
		expect(await storage.setArchived(false)).toMatchObject({ archived: false });
		expect(readHeader(sessionFile).archived).toBeUndefined();
		expect(readHeader(sessionFile).archivedAt).toBeUndefined();
	});

	it("filters archived sessions by default and excludes them from continue", async () => {
		const root = createRoot();
		const sessionDir = join(root, "sessions");
		const active = SessionManager.create(root, sessionDir, { id: "active-session" });
		active.flushPendingSession();
		const archived = SessionManager.create(root, sessionDir, { id: "archived-session" });
		archived.setArchived(true, new Date("2026-09-01T12:00:00.000Z"));

		await expect(SessionManager.list(root, sessionDir)).resolves.toMatchObject([
			{ id: "active-session", archived: false },
		]);
		const all = await SessionManager.list(root, sessionDir, { includeArchived: true });
		expect(all.map((session) => session.id).sort()).toEqual(["active-session", "archived-session"]);
		expect(all.find((session) => session.id === "archived-session")).toMatchObject({
			archived: true,
			archivedAt: new Date("2026-09-01T12:00:00.000Z"),
		});

		const continued = SessionManager.continueRecent(root, sessionDir);
		expect(continued.getSessionId()).toBe("active-session");
	});
});
