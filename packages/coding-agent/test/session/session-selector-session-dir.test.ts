import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setKeybindings } from "@aos-agent/tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../../src/core/runtime/keybindings.ts";
import { SessionManager } from "../../src/core/session/manager.ts";
import { SessionSelectorComponent } from "../../src/modes/interactive/components/session-selector.ts";
import { initTheme } from "../../src/modes/interactive/theme/theme.ts";

const FOUNDATION_ENTRY_CUSTOM_TYPE = "__aos.foundation.entry.v1";
const FOUNDATION_FACT_CUSTOM_TYPE = "__aos.foundation.fact.v1";

async function flushPromises(): Promise<void> {
	await new Promise<void>((resolve) => {
		setImmediate(resolve);
	});
}

function writeCanonicalSession(sessionDir: string, cwd: string, marker: string): string {
	const id = "canonical-selector-session";
	const sessionPath = join(sessionDir, `${id}.jsonl`);
	const timestamp = "2026-01-01T00:00:00.000Z";
	const messageTimestamp = Date.parse(timestamp);
	const entries = [
		{
			type: "session",
			version: 3,
			id,
			timestamp,
			cwd,
		},
		{
			type: "custom",
			id: "physical-message",
			parentId: null,
			timestamp,
			customType: FOUNDATION_ENTRY_CUSTOM_TYPE,
			data: {
				schemaVersion: 1,
				kind: "entry",
				entry: {
					type: "message",
					id: "canonical-message",
					seq: 2,
					parentId: null,
					timestamp: messageTimestamp,
					message: {
						role: "user",
						content: [{ type: "text", text: marker }],
						timestamp: messageTimestamp,
					},
				},
			},
		},
		{
			type: "custom",
			id: "physical-name",
			parentId: "physical-message",
			timestamp,
			customType: FOUNDATION_FACT_CUSTOM_TYPE,
			data: {
				schemaVersion: 1,
				kind: "name",
				name: "Canonical selector session",
			},
		},
	];
	writeFileSync(sessionPath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
	return sessionPath;
}

describe("session selector explicit session directory", () => {
	const temporaryDirectories: string[] = [];

	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	afterEach(() => {
		for (const directory of temporaryDirectories.splice(0)) {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	it("discovers canonical messages and searches them in an explicit session directory", async () => {
		const root = mkdtempSync(join(tmpdir(), "aos-session-selector-dir-"));
		const sessionDir = join(root, "sessions");
		const cwd = join(root, "workspace");
		mkdirSync(sessionDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
		temporaryDirectories.push(root);

		const marker = "U2_SWITCH_MARKER";
		const sessionPath = writeCanonicalSession(sessionDir, cwd, marker);
		const sessions = await SessionManager.list(cwd, sessionDir);

		expect(sessions).toHaveLength(1);
		expect(sessions[0]).toMatchObject({
			path: sessionPath,
			name: "Canonical selector session",
			firstMessage: marker,
			allMessagesText: marker,
			messageCount: 1,
		});

		const selector = new SessionSelectorComponent(
			async () => SessionManager.list(cwd, sessionDir),
			async () => SessionManager.listAll(sessionDir),
			() => {},
			() => {},
			() => {},
			() => {},
			{ keybindings: new KeybindingsManager() },
		);
		await flushPromises();
		await vi.waitFor(() => {
			expect(selector.getSessionList().getSelectedSessionPath()).toBe(sessionPath);
		});

		selector.getSessionList().handleInput(marker);
		expect(selector.getSessionList().getSelectedSessionPath()).toBe(sessionPath);
	});

	it("keeps explicit-directory current-folder filtering separate from all-session enumeration", async () => {
		const root = mkdtempSync(join(tmpdir(), "aos-session-selector-dir-"));
		const sessionDir = join(root, "sessions");
		const cwd = join(root, "workspace");
		const otherCwd = join(root, "other-workspace");
		mkdirSync(sessionDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
		mkdirSync(otherCwd, { recursive: true });
		temporaryDirectories.push(root);

		const currentPath = writeCanonicalSession(sessionDir, cwd, "current marker");
		const otherPath = join(sessionDir, "other-session.jsonl");
		writeFileSync(
			otherPath,
			`${JSON.stringify({
				type: "session",
				version: 3,
				id: "other-selector-session",
				timestamp: "2026-01-02T00:00:00.000Z",
				cwd: otherCwd,
			})}\n`,
		);

		const current = await SessionManager.list(cwd, sessionDir);
		const all = await SessionManager.listAll(sessionDir);
		expect(current.map((session) => session.path)).toEqual([currentPath]);
		expect(new Set(all.map((session) => session.path))).toEqual(new Set([currentPath, otherPath]));
	});
});
