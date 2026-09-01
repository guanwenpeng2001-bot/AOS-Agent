import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSessionManagerForOptions } from "../../src/core/session/creation.ts";
import { SessionManager, type SessionHeader } from "../../src/core/session/manager.ts";
import { createSessionManagerStorage } from "../../src/core/session/manager-storage.ts";

const roots: string[] = [];

function createRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "aos-session-from-pr-"));
	roots.push(root);
	return root;
}

function readHeader(path: string): SessionHeader {
	return JSON.parse(readFileSync(path, "utf8").split("\n")[0]!) as SessionHeader;
}

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("session from-PR metadata", () => {
	it("persists and lists a normalized pull request association", async () => {
		const root = createRoot();
		const sessionDir = join(root, "sessions");
		const manager = SessionManager.create(root, sessionDir, {
			id: "from-pr-session",
			fromPr: "  https://github.com/example/repo/pull/42  ",
		});
		manager.flushPendingSession();

		const sessionFile = manager.getSessionFile()!;
		expect(readHeader(sessionFile).fromPr).toBe("https://github.com/example/repo/pull/42");
		expect(SessionManager.open(sessionFile).getFromPr()).toBe("https://github.com/example/repo/pull/42");
		await expect(createSessionManagerStorage(manager).getMetadata()).resolves.toMatchObject({
			id: "from-pr-session",
			fromPr: "https://github.com/example/repo/pull/42",
		});
		await expect(SessionManager.list(root, sessionDir)).resolves.toMatchObject([
			{ id: "from-pr-session", fromPr: "https://github.com/example/repo/pull/42" },
		]);
	});

	it("rejects an empty pull request association before persistence", () => {
		const root = createRoot();
		expect(() => SessionManager.create(root, join(root, "sessions"), { fromPr: "   " })).toThrow(
			"Session from-PR reference must be non-empty",
		);
	});

	it("preserves the association across branch and fork entry points", () => {
		const root = createRoot();
		const sessionDir = join(root, "sessions");
		const source = SessionManager.create(root, sessionDir, { id: "source", fromPr: "42" });
		source.appendSessionInfo("source");
		source.flushPendingSession();
		const sourceFile = source.getSessionFile()!;

		const fork = SessionManager.forkFrom(sourceFile, root, sessionDir, { id: "fork" });
		expect(fork.getFromPr()).toBe("42");

		const leafId = source.getLeafId();
		if (leafId === null) throw new Error("Expected source session entry");
		source.createBranchedSession(leafId);
		expect(source.getFromPr()).toBe("42");
	});

	it("accepts from-PR metadata through SDK session creation options", () => {
		const root = createRoot();
		const agentDir = join(root, "agent");
		const memory = createSessionManagerForOptions({
			cwd: root,
			agentDir,
			session: { mode: "memory", id: "memory", fromPr: "101" },
		});
		expect(memory.sessionManager.getFromPr()).toBe("101");

		const persisted = createSessionManagerForOptions({
			cwd: root,
			agentDir,
			session: { mode: "new", directory: join(root, "sdk-sessions"), id: "persisted", fromPr: "102" },
		});
		expect(persisted.sessionManager.getFromPr()).toBe("102");
	});
});
