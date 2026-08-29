import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { getControlPlaneLastKnownGoodPath } from "../src/core/control-plane-atomic-storage.ts";
import { runMigrations } from "../src/migrations.ts";

describe("startup migration atomic writes", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	function createAgentDir(): string {
		const agentDir = mkdtempSync(join(tmpdir(), "aos-migrations-atomic-write-"));
		tempDirs.push(agentDir);
		return agentDir;
	}

	function withAgentDir<T>(agentDir: string, fn: () => T): T {
		const previousAgentDir = process.env[ENV_AGENT_DIR];
		process.env[ENV_AGENT_DIR] = agentDir;
		try {
			return fn();
		} finally {
			if (previousAgentDir === undefined) delete process.env[ENV_AGENT_DIR];
			else process.env[ENV_AGENT_DIR] = previousAgentDir;
		}
	}

	it("preserves migration formats while publishing recoverable copies", () => {
		const agentDir = createAgentDir();
		const settingsPath = join(agentDir, "settings.json");
		const authPath = join(agentDir, "auth.json");
		const keybindingsPath = join(agentDir, "keybindings.json");
		writeFileSync(
			join(agentDir, "oauth.json"),
			JSON.stringify({ openai: { access: "access", refresh: "refresh", expires: 123 } }),
			"utf-8",
		);
		writeFileSync(
			settingsPath,
			JSON.stringify({ apiKeys: { openai: "ignored", anthropic: "key" }, theme: "dark" }),
			"utf-8",
		);
		writeFileSync(keybindingsPath, JSON.stringify({ expandTools: "ctrl+x" }), "utf-8");

		const result = withAgentDir(agentDir, () => runMigrations(agentDir));

		expect(result.migratedAuthProviders).toEqual(["openai", "anthropic"]);
		expect(JSON.parse(readFileSync(settingsPath, "utf-8"))).toEqual({ theme: "dark" });
		expect(JSON.parse(readFileSync(authPath, "utf-8"))).toEqual({
			openai: { type: "oauth", access: "access", refresh: "refresh", expires: 123 },
			anthropic: { type: "api_key", key: "key" },
		});
		expect(JSON.parse(readFileSync(keybindingsPath, "utf-8"))).toEqual({
			"app.tools.expand": "ctrl+x",
		});
		for (const path of [settingsPath, authPath, keybindingsPath]) {
			expect(readFileSync(getControlPlaneLastKnownGoodPath(path), "utf-8")).toBe(
				readFileSync(path, "utf-8"),
			);
		}
	});

	it("quarantines a half-written migration target and repairs it on the next start", () => {
		const agentDir = createAgentDir();
		const keybindingsPath = join(agentDir, "keybindings.json");
		writeFileSync(keybindingsPath, JSON.stringify({ expandTools: "ctrl+x" }), "utf-8");
		withAgentDir(agentDir, () => runMigrations(agentDir));

		writeFileSync(keybindingsPath, '{"app.tools.expand":', "utf-8");
		withAgentDir(agentDir, () => runMigrations(agentDir));

		expect(JSON.parse(readFileSync(keybindingsPath, "utf-8"))).toEqual({
			"app.tools.expand": "ctrl+x",
		});
		expect(readdirSync(agentDir).filter((entry) => entry.startsWith(".keybindings.json.corrupt."))).toHaveLength(1);
	});
});
