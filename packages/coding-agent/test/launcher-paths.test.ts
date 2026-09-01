import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { normalizeLauncherWorkingDirectory, toWindowsExtendedPath } from "../src/launcher-paths.ts";

describe("Windows launcher paths", () => {
	it("adds the extended prefix to local and UNC paths", () => {
		expect(toWindowsExtendedPath("C:\\workspace\\project")).toBe("\\\\?\\C:\\workspace\\project");
		expect(toWindowsExtendedPath("\\\\server\\share\\project")).toBe("\\\\?\\UNC\\server\\share\\project");
		expect(toWindowsExtendedPath("\\\\?\\C:\\workspace\\project")).toBe("\\\\?\\C:\\workspace\\project");
	});

	it("only normalizes long paths on Windows", () => {
		const longPath = `C:\\${"x".repeat(260)}`;
		expect(normalizeLauncherWorkingDirectory(longPath, "linux")).toBe(longPath);
		expect(normalizeLauncherWorkingDirectory(`C:\\${"x".repeat(259)}`, "win32")).toMatch(/^\\\\\?\\/u);
	});

	it.runIf(process.platform === "win32")("starts a JavaScript entrypoint from a long working directory", () => {
		const root = mkdtempSync(join(tmpdir(), "aos-long-launcher-test-"));
		try {
			const longCwd = join(root, ...Array.from({ length: 6 }, () => `segment-${"x".repeat(40)}`));
			mkdirSync(longCwd, { recursive: true });
			expect(longCwd.length).toBeGreaterThan(260);

			const probe = join(root, "probe.mjs");
			writeFileSync(probe, 'console.log("AOS_LONG_PATH_LAUNCH_OK");\n', { encoding: "utf8", mode: 0o755 });
			const result = spawnSync(process.execPath, [probe], {
				cwd: normalizeLauncherWorkingDirectory(longCwd),
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
			});

			expect(result.error).toBeUndefined();
			expect(result.status).toBe(0);
			expect(result.stdout).toContain("AOS_LONG_PATH_LAUNCH_OK");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
