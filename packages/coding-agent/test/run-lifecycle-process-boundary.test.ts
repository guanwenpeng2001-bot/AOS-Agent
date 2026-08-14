import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { createRunLifecycleCoordinator } from "../src/core/run-lifecycle.ts";
import { SessionManager } from "../src/core/session-manager.ts";

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const workerPath = fileURLToPath(new URL("./fixtures/run-lifecycle-process-worker.ts", import.meta.url));
const tempDirs: string[] = [];
const phases = ["accepted", "started", "terminal"] as const;

type Phase = (typeof phases)[number];

function createPersistedSession(): { readonly directory: string; readonly sessionFile: string } {
	const directory = mkdtempSync(join(tmpdir(), "aos-run-boundary-"));
	tempDirs.push(directory);
	const session = SessionManager.create(directory, directory);
	session.appendMessage({ role: "user", content: "seed", timestamp: 1 });
	session.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "seed reply" }],
		api: "anthropic-messages",
		provider: "test",
		model: "test-model",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 2,
	});
	const sessionFile = session.getSessionFile();
	if (sessionFile === undefined) throw new Error("Expected a persisted session file");
	return { directory, sessionFile };
}

function killAfterReady(sessionFile: string, phase: Phase): Promise<void> {
	return new Promise((resolvePromise, reject) => {
		const child = spawn(process.execPath, ["--import", "tsx", workerPath, sessionFile, phase], {
			cwd: repoRoot,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let ready = false;
		let settled = false;
		let output = "";
		const timeout = setTimeout(() => {
			if (!settled) {
				settled = true;
				child.kill();
				reject(new Error(`Timed out waiting for ${phase} process boundary: ${output}`));
			}
		}, 15_000);

		child.stdout.on("data", (chunk: Buffer) => {
			output += chunk.toString();
			if (!ready && output.includes("ready\n")) {
				ready = true;
				child.kill();
			}
		});
		child.stderr.on("data", (chunk: Buffer) => {
			output += chunk.toString();
		});
		child.once("error", (error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			reject(error);
		});
		child.once("close", (code, signal) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			if (!ready) {
				reject(new Error(`Process exited before ${phase} boundary: code=${code} signal=${signal} output=${output}`));
				return;
			}
			resolvePromise();
		});
	});
}

function readRun(sessionFile: string, phase: Phase) {
	const session = SessionManager.open(sessionFile, dirname(sessionFile));
	const coordinator = createRunLifecycleCoordinator(session);
	return coordinator.getRun(`run-${phase}`);
}

afterEach(() => {
	for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("Run ledger process boundaries", () => {
	it.each(phases)("preserves the durable contract after kill-after-%s", async (phase) => {
		const { sessionFile } = createPersistedSession();
		await killAfterReady(sessionFile, phase);
		const result = readRun(sessionFile, phase);

		expect(result).toBeDefined();
		if (phase === "accepted" || phase === "started") {
			expect(result?.record.status).toBe(phase === "accepted" ? "accepted" : "running");
			expect(result?.receipt).toBeUndefined();
			expect(result?.recovery).toBe("interrupted");
		} else {
			expect(result?.record.status).toBe("completed");
			expect(result?.receipt?.status).toBe("completed");
			expect(result?.recovery).toBeUndefined();
		}
	});
});
