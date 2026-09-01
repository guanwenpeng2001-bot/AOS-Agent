import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { handleSessionCommand } from "../../src/cli/session-command.ts";
import { SessionManager } from "../../src/core/session/manager.ts";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("session CLI command", () => {
	it("archives, lists with an explicit archive filter, and unarchives by id", async () => {
		const root = mkdtempSync(join(tmpdir(), "aos-session-command-"));
		roots.push(root);
		const sessionDir = join(root, "sessions");
		SessionManager.create(root, sessionDir, { id: "cli-session" }).flushPendingSession();
		const output: string[] = [];
		const options = { cwd: root, sessionDir, write: (line: string) => output.push(line) };

		await handleSessionCommand(["session", "archive", "cli-session"], options);
		expect(output.pop()).toBe("Archived session cli-session");

		await handleSessionCommand(["session", "list"], options);
		expect(output).toEqual([]);

		await handleSessionCommand(["session", "list", "--include-archived"], options);
		expect(output).toHaveLength(1);
		expect(output[0]).toContain("cli-session\tarchived");
		output.length = 0;

		await handleSessionCommand(["session", "unarchive", "cli-session"], options);
		expect(output.pop()).toBe("Unarchived session cli-session");
		await handleSessionCommand(["session", "list"], options);
		expect(output[0]).toContain("cli-session\tactive");
	});
});
