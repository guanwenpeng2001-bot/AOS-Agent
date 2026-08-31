import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	ContextMemoryStore,
	getProjectMemoryFilePath,
	memoryReceiptMeta,
	memoryToContextSourceInputs,
} from "../../src/core/session/context-memory-store.ts";
import { SettingsManager } from "../../src/core/runtime/settings-manager.ts";

describe("context-memory-store", () => {
	const dirs: string[] = [];

	afterEach(() => {
		for (const dir of dirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	function tempDir(prefix: string): string {
		const dir = mkdtempSync(join(tmpdir(), prefix));
		dirs.push(dir);
		return dir;
	}

	it("defaults to no memory settings enabled", () => {
		const agentDir = tempDir("mem-settings-");
		const cwd = tempDir("mem-cwd-");
		const settings = SettingsManager.create(cwd, agentDir);
		expect(settings.getMemorySettings()).toEqual({
			sessionEnabled: false,
			projectEnabled: false,
		});
		expect(settings.getContextSettings().enabled).toBe(true);
	});

	it("supports explicit session add, list, and revoke without automatic writes", async () => {
		const store = new ContextMemoryStore();
		const sessionEntries: Array<{ customType: string; data?: unknown }> = [];

		const listedEmpty = await store.list({
			scope: "session",
			sessionCustomEntries: sessionEntries,
		});
		expect(listedEmpty).toEqual([]);

		const added = await store.add({
			scope: "session",
			text: "prefer tabs",
			sourceEntryIds: ["entry-1"],
			appendSessionEntry: (customType, data) => {
				sessionEntries.push({ customType, data });
				return "custom-1";
			},
			createId: () => "mem-session-1",
			now: () => new Date("2026-01-01T00:00:00.000Z"),
		});
		expect(added.id).toBe("mem-session-1");
		expect(added.status).toBe("active");
		expect(sessionEntries).toHaveLength(1);

		const listed = await store.list({
			scope: "session",
			sessionCustomEntries: sessionEntries,
		});
		expect(listed.map((m) => m.id)).toEqual(["mem-session-1"]);
		expect(listed[0]?.text).toBe("prefer tabs");

		await store.revoke({
			id: "mem-session-1",
			scope: "session",
			appendSessionEntry: (customType, data) => {
				sessionEntries.push({ customType, data });
				return "custom-2";
			},
		});

		const activeOnly = await store.list({
			scope: "session",
			sessionCustomEntries: sessionEntries,
		});
		expect(activeOnly).toEqual([]);

		const withRevoked = await store.list({
			scope: "session",
			sessionCustomEntries: sessionEntries,
			includeRevoked: true,
		});
		expect(withRevoked[0]?.status).toBe("revoked");
		expect(withRevoked[0]?.text).toBe("prefer tabs");

		const inputs = memoryToContextSourceInputs(withRevoked);
		expect(inputs[0]?.preDisposition?.reason).toBe("revoked");
		expect(inputs[0]?.refId).toBe("mem-session-1");

		const receipt = memoryReceiptMeta(added);
		expect(receipt.refId).toBe("mem-session-1");
		expect(receipt.contentDigest).toMatch(/^[a-f0-9]{64}$/);
		expect(JSON.stringify(receipt)).not.toContain("prefer tabs");
	});

	it("isolates project memory by canonical root and never writes into the project tree", async () => {
		const agentDir = tempDir("mem-agent-");
		const projectA = tempDir("mem-proj-a-");
		const projectB = tempDir("mem-proj-b-");
		const store = new ContextMemoryStore({ agentDir });

		await store.add({
			scope: "project",
			projectRoot: projectA,
			text: "project-a-only",
			createId: () => "mem-a",
			now: () => new Date("2026-02-01T00:00:00.000Z"),
		});
		await store.add({
			scope: "project",
			projectRoot: projectB,
			text: "project-b-only",
			createId: () => "mem-b",
			now: () => new Date("2026-02-01T00:00:01.000Z"),
		});

		const listA = await store.list({ scope: "project", projectRoot: projectA, agentDir });
		const listB = await store.list({ scope: "project", projectRoot: projectB, agentDir });
		expect(listA.map((m) => m.text)).toEqual(["project-a-only"]);
		expect(listB.map((m) => m.text)).toEqual(["project-b-only"]);

		const storeFile = getProjectMemoryFilePath(projectA, agentDir);
		expect(storeFile.startsWith(agentDir)).toBe(true);
		expect(storeFile.includes(projectA)).toBe(false);
		// Project tree itself has no memory files.
		expect(() => readFileSync(join(projectA, "memory.jsonl"), "utf8")).toThrow();

		const disabledInputs = memoryToContextSourceInputs(listA, { enabled: false });
		expect(disabledInputs[0]?.preDisposition?.reason).toBe("disabled");
	});

	it("rejects a project-memory store configured under the project tree", async () => {
		const projectRoot = tempDir("mem-project-root-");
		const store = new ContextMemoryStore({ agentDir: join(projectRoot, ".private-agent") });

		await expect(
			store.add({
				scope: "project",
				projectRoot,
				text: "must remain outside the worktree",
			}),
		).rejects.toThrow("project memory store must not write into the project working directory");
	});

	it("does not provide automatic extraction helpers on the store API", () => {
		const store = new ContextMemoryStore();
		const proto = Object.getOwnPropertyNames(Object.getPrototypeOf(store));
		expect(proto).not.toContain("extractFromMessages");
		expect(proto).not.toContain("rememberToolResult");
		expect(proto).not.toContain("autoCapture");
		expect(typeof store.add).toBe("function");
		expect(typeof store.list).toBe("function");
		expect(typeof store.revoke).toBe("function");
	});
});
