import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../../src/config.ts";
import { FOUNDATION_FACT_CUSTOM_TYPE } from "../../src/core/session/manager-storage.ts";
import { sourceProcessArgs, sourceProcessEnv } from "../cli-process.ts";

const cliPath = resolve(__dirname, "../../src/cli.ts");
const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function createTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "aos-startup-session-name-"));
	tempDirs.push(dir);
	return dir;
}

interface CliDirs {
	agentDir: string;
	projectDir: string;
	sessionFile: string;
}

interface CliResult {
	code: number | null;
	signal: NodeJS.Signals | null;
	stderr: string;
}

function createSessionFile(projectDir: string, sessionFile: string): void {
	const timestamp = new Date().toISOString();
	writeFileSync(
		sessionFile,
		`${JSON.stringify({ type: "session", version: 3, id: "existing-session", timestamp, cwd: projectDir })}\n${JSON.stringify(
			{
				type: "message",
				id: "assistant-1",
				parentId: null,
				timestamp,
				message: {
					role: "assistant",
					content: [{ type: "text", text: "hello" }],
					provider: "anthropic",
					model: "claude-sonnet-4-5",
					timestamp: Date.now(),
				},
			},
		)}\n`,
	);
}

function readSessionNameFacts(sessionFile: string): string[] {
	return readFileSync(sessionFile, "utf8")
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line) as {
			type?: string;
			customType?: string;
			data?: { kind?: string; name?: string };
		})
		.filter(
			(entry) =>
				entry.type === "custom" &&
				entry.customType === FOUNDATION_FACT_CUSTOM_TYPE &&
				entry.data?.kind === "name",
		)
		.map((entry) => entry.data?.name ?? "");
}

async function runCli(args: string[], dirs: CliDirs, timeoutMs = 40_000): Promise<CliResult> {
	let stderr = "";
	const child = spawn(process.execPath, sourceProcessArgs(cliPath, args), {
		cwd: dirs.projectDir,
		env: { ...sourceProcessEnv(), [ENV_AGENT_DIR]: dirs.agentDir, AOS_AGENT_OFFLINE: "1" },
		stdio: ["ignore", "ignore", "pipe"],
	});
	child.stderr.on("data", (chunk) => {
		stderr += chunk.toString();
	});

	return new Promise((resolvePromise, reject) => {
		const timeout = setTimeout(() => {
			child.kill("SIGKILL");
		}, timeoutMs);
		child.on("error", (error) => {
			clearTimeout(timeout);
			reject(error);
		});
		child.on("close", (code, signal) => {
			clearTimeout(timeout);
			resolvePromise({ code, signal, stderr });
		});
	});
}

function setup(): CliDirs {
	const tempRoot = createTempDir();
	const dirs = {
		agentDir: join(tempRoot, "agent"),
		projectDir: join(tempRoot, "project"),
		sessionFile: join(tempRoot, "session.jsonl"),
	};
	mkdirSync(dirs.agentDir, { recursive: true });
	mkdirSync(dirs.projectDir, { recursive: true });
	createSessionFile(dirs.projectDir, dirs.sessionFile);
	return dirs;
}

describe("startup session name", () => {
	it("sets --name on the selected session before runtime model validation", { timeout: 80_000 }, async () => {
		const dirs = setup();
		const result = await runCli(
			["--session", dirs.sessionFile, "--name", "  CLI Named Session  ", "--model", "missing-model", "-p", "hi"],
			dirs,
			70_000,
		);

		expect(result.code).toBe(1);
		expect(result.signal).toBeNull();
		expect(readSessionNameFacts(dirs.sessionFile)).toEqual(["CLI Named Session"]);
	});

	it("notifies extensions after startup succeeds without writing --name twice", { timeout: 80_000 }, async () => {
		const dirs = setup();
		const notificationFile = join(dirs.projectDir, "session-name-notification.txt");
		const extensionFile = join(dirs.projectDir, "session-name-extension.ts");
		writeFileSync(
			extensionFile,
			`import { appendFileSync } from "node:fs";
			export default function (agent) {
				agent.on("session_info_changed", (event) => {
					appendFileSync(${JSON.stringify(notificationFile)}, String(event.name) + "\\n");
				});
			}
			`,
		);

		const result = await runCli(
			[
				"--session",
				dirs.sessionFile,
				"--name",
				"CLI Named Session",
				"--extension",
				extensionFile,
				"--approve",
				"--model",
				"missing-model",
				"-p",
				"hi",
			],
			dirs,
			70_000,
		);

		expect(result.code).toBe(1);
		expect(result.signal).toBeNull();
		expect(readSessionNameFacts(dirs.sessionFile)).toEqual(["CLI Named Session"]);
		expect(existsSync(notificationFile)).toBe(true);
		expect(readFileSync(notificationFile, "utf8").trim().split("\n")).toEqual(["CLI Named Session"]);
	});

	it("rejects empty --name values without appending session metadata", { timeout: 50_000 }, async () => {
		const dirs = setup();
		const result = await runCli(
			["--session", dirs.sessionFile, "--name", "   ", "--model", "missing-model", "-p", "hi"],
			dirs,
		);

		expect(result.code).toBe(1);
		expect(result.signal).toBeNull();
		expect(result.stderr).toContain("--name requires a non-empty value");
		expect(readSessionNameFacts(dirs.sessionFile)).toEqual([]);
	});
});
