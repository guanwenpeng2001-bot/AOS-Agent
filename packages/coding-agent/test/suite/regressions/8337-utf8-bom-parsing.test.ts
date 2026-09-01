import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SettingsManager } from "../../../src/core/runtime/settings-manager.ts";
import { splitBom, stripBom } from "../../../src/utils/text.ts";

describe("issue #8337 UTF-8 BOM parsing", () => {
	const roots: string[] = [];

	afterEach(() => {
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	it("loads BOM-prefixed settings and preserves split metadata", () => {
		const root = join(tmpdir(), `aos-bom-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const agentDir = join(root, "agent");
		const projectDir = join(root, "project");
		roots.push(root);
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(projectDir, { recursive: true });
		writeFileSync(join(agentDir, "settings.json"), '\uFEFF{"theme":"dark"}');

		const manager = SettingsManager.create(projectDir, agentDir);

		expect(manager.getTheme()).toBe("dark");
		expect(stripBom("\uFEFFvalue")).toBe("value");
		expect(splitBom("\uFEFFvalue")).toEqual({ bom: "\uFEFF", text: "value" });
	});
});
