import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../../src/config.ts";
import { SessionFileCorruptionError, SessionManager } from "../../src/core/session/manager.ts";
import { sourceProcessArgs, sourceProcessEnv } from "../cli-process.ts";

const cliPath = resolve(__dirname, "../../src/cli.ts");
const CLI_PROCESS_TIMEOUT_MS = 120_000;
const CLI_TEST_TIMEOUT_MS = 130_000;
const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function createTempDir(): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "aos-session-file-invalid-")));
	tempDirs.push(dir);
	return dir;
}

async function runCli(args: string[], cwd: string, agentDir: string): Promise<{ code: number | null; stderr: string }> {
	let stderr = "";
	const code = await new Promise<number | null>((resolvePromise, reject) => {
		const child = spawn(process.execPath, sourceProcessArgs(cliPath, args), {
			cwd,
			env: { ...sourceProcessEnv(), [ENV_AGENT_DIR]: agentDir, AOS_AGENT_OFFLINE: "1" },
			stdio: ["ignore", "ignore", "pipe"],
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		let timedOut = false;
		const timeout = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, CLI_PROCESS_TIMEOUT_MS);
		child.on("error", (error) => {
			clearTimeout(timeout);
			reject(error);
		});
		child.on("close", (exitCode) => {
			clearTimeout(timeout);
			if (timedOut) {
				reject(new Error(`CLI did not exit within ${CLI_PROCESS_TIMEOUT_MS}ms`));
				return;
			}
			resolvePromise(exitCode);
		});
	});

	return { code, stderr };
}

describe("--session invalid file handling", () => {
	it("prints a friendly error and preserves non-session file content", { timeout: CLI_TEST_TIMEOUT_MS }, async () => {
		const tempRoot = createTempDir();
		const agentDir = join(tempRoot, "agent");
		const projectDir = join(tempRoot, "project");
		const sessionFile = join(tempRoot, "not-a-session.log");
		const originalContent = '{"type":"event","data":"not a session"}\n';
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(projectDir, { recursive: true });
		writeFileSync(sessionFile, originalContent);

		const result = await runCli(["--session", sessionFile, "-p", "hi"], projectDir, agentDir);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain(`Error: Session file is not a valid AOS Agent session: ${sessionFile}`);
		expect(result.stderr).not.toContain("SessionManager.open");
		expect(result.stderr).not.toContain("at ");
		expect(readFileSync(sessionFile, "utf8")).toBe(originalContent);
	});

	it("reports repaired corruption through stderr and a non-zero exit without leaking content", { timeout: CLI_TEST_TIMEOUT_MS }, async () => {
		const tempRoot = createTempDir();
		const agentDir = join(tempRoot, "agent");
		const projectDir = join(tempRoot, "project");
		const sessionFile = join(tempRoot, "corrupt.jsonl");
		const header = '{"type":"session","version":3,"id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n';
		const entry = '{"type":"message","id":"1","parentId":null,"timestamp":"2025-01-01T00:00:01Z","message":{"role":"user","content":"hi","timestamp":1}}\n';
		const privateCorruptContent = '{"private":"DO_NOT_LEAK_7391"';
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(projectDir, { recursive: true });
		writeFileSync(sessionFile, header + entry + privateCorruptContent);

		const result = await runCli(["--session", sessionFile, "-p", "hi"], projectDir, agentDir);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("Session file corruption detected at line 3");
		expect(result.stderr).toContain("valid prefix was preserved");
		expect(result.stderr).toContain("corrupt remainder was quarantined");
		expect(result.stderr).not.toContain(privateCorruptContent);
		expect(result.stderr).not.toContain("DO_NOT_LEAK_7391");
	});
});

describe("corrupt session quarantine", () => {
	it.each([
		["trailing illegal line", "{illegal-json\n", ""],
		["mid-file illegal line", "{illegal-json\n", '{"type":"custom","id":"2","parentId":"1","timestamp":"2025-01-01T00:00:02Z","customType":"later"}\n'],
		["truncated final line", '{"type":"message","id":"truncated"', ""],
	])("isolates a %s and keeps only the verified prefix", (_description, corruptLine, suffix) => {
		const tempRoot = createTempDir();
		const sessionFile = join(tempRoot, "session.jsonl");
		const header = '{"type":"session","version":3,"id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n';
		const entry = '{"type":"message","id":"1","parentId":null,"timestamp":"2025-01-01T00:00:01Z","message":{"role":"user","content":"hi","timestamp":1}}\n';
		writeFileSync(sessionFile, header + entry + corruptLine + suffix);

		expect(() => SessionManager.open(sessionFile, tempRoot)).toThrow(SessionFileCorruptionError);
		expect(readFileSync(sessionFile, "utf8")).toBe(header + entry);

		const quarantineFiles = readdirSync(tempRoot).filter((name) => name.startsWith(".session.jsonl.corrupt."));
		expect(quarantineFiles).toHaveLength(1);
		expect(readFileSync(join(tempRoot, quarantineFiles[0]!), "utf8")).toBe(corruptLine + suffix);
	});

	it("opens a legal session without changing it or creating quarantine", () => {
		const tempRoot = createTempDir();
		const sessionFile = join(tempRoot, "session.jsonl");
		const content =
			'{"type":"session","version":3,"id":"abc","timestamp":"2025-01-01T00:00:00Z","cwd":"/tmp"}\n' +
			'{"type":"message","id":"1","parentId":null,"timestamp":"2025-01-01T00:00:01Z","message":{"role":"user","content":"hi","timestamp":1}}\n';
		writeFileSync(sessionFile, content);

		const session = SessionManager.open(sessionFile, tempRoot);

		expect(session.getSessionId()).toBe("abc");
		expect(readFileSync(sessionFile, "utf8")).toBe(content);
		expect(readdirSync(tempRoot).filter((name) => name.includes(".corrupt."))).toEqual([]);
	});
});
