import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { collectSettingsDiagnostics, deduplicateDiagnostics } from "../src/core/runtime/settings-diagnostics.ts";
import { SettingsManager } from "../src/core/runtime/settings-manager.ts";

describe("settings diagnostics", () => {
	it("includes the invalid settings path and deduplicates repeats", () => {
		const root = mkdtempSync(join(tmpdir(), "aos-settings-diagnostics-"));
		const agentDir = join(root, "agent");
		const settingsPath = join(agentDir, "settings.json");
		mkdirSync(agentDir);
		writeFileSync(settingsPath, "{");
		try {
			const diagnostics = collectSettingsDiagnostics(SettingsManager.create(root, agentDir));
			expect(diagnostics[0]?.message).toContain(`Invalid settings file ${settingsPath}:`);
			expect(deduplicateDiagnostics([...diagnostics, ...diagnostics])).toEqual(diagnostics);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
