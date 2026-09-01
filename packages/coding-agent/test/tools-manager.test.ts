import type * as ChildProcess from "node:child_process";
import type * as Fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureTool, type ToolStatus } from "../src/utils/tools-manager.ts";

const originalOffline = process.env.AOS_AGENT_OFFLINE;

vi.mock("fs", async (importOriginal) => ({
	...(await importOriginal<typeof Fs>()),
	existsSync: vi.fn(() => false),
}));
vi.mock("child_process", async (importOriginal) => ({
	...(await importOriginal<typeof ChildProcess>()),
	spawnSync: vi.fn(() => ({ error: new Error("not found") })),
}));

afterEach(() => {
	if (originalOffline === undefined) delete process.env.AOS_AGENT_OFFLINE;
	else process.env.AOS_AGENT_OFFLINE = originalOffline;
});

describe("ensureTool", () => {
	it("reports offline status through the callback without console output", async () => {
		process.env.AOS_AGENT_OFFLINE = "1";
		const statuses: ToolStatus[] = [];
		const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {});

		expect(await ensureTool("fd", (status) => statuses.push(status))).toBeUndefined();
		expect(statuses).toEqual([{ type: "warning", message: "fd not found. Offline mode enabled, skipping download." }]);
		expect(consoleLog).not.toHaveBeenCalled();
	});
});
