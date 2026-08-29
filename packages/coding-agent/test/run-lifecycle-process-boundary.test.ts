import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { createRunLifecycleCoordinator } from "../src/core/session/run-lifecycle.ts";
import { SessionManager } from "../src/core/session/manager.ts";

const repoRoot = resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const workerPath = fileURLToPath(new URL("./fixtures/run-lifecycle-process-worker.ts", import.meta.url));
const tempDirs: string[] = [];
const phases = ["accepted", "started", "terminal"] as const;
// Windows full-suite contention can delay the test-only tsx loader beyond 15s.
// Once the fixture is loaded, keep the production persistence and process-close
// budgets narrow so those regressions cannot hide inside loader headroom.
const startupTimeoutMs = 45_000;
const boundaryTimeoutMs = 5_000;
const closeTimeoutMs = 5_000;
const testTimeoutMs = startupTimeoutMs + boundaryTimeoutMs + closeTimeoutMs;

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
		const spawnedAt = Date.now();
		const child = spawn(process.execPath, ["--import", "tsx", workerPath, sessionFile, phase], {
			cwd: repoRoot,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let startupReadyAt: number | undefined;
		let boundaryReadyAt: number | undefined;
		let settled = false;
		let output = "";
		let timeout = setTimeout(() => {
			if (!settled) {
				settled = true;
				child.kill();
				reject(
					new Error(
						`Timed out waiting for worker startup readiness after ${Date.now() - spawnedAt}ms: ${output}`,
					),
				);
			}
		}, startupTimeoutMs);

		child.stdout.on("data", (chunk: Buffer) => {
			output += chunk.toString();
			if (startupReadyAt === undefined && output.includes("startup-ready\n")) {
				const readyAt = Date.now();
				startupReadyAt = readyAt;
				clearTimeout(timeout);
				timeout = setTimeout(() => {
					if (settled) return;
					settled = true;
					child.kill();
					reject(
						new Error(
							`Timed out waiting for durable ${phase} boundary after ${Date.now() - readyAt}ms: ${output}`,
						),
					);
				}, boundaryTimeoutMs);
			}
			if (boundaryReadyAt === undefined && output.includes("boundary-ready\n")) {
				const readyAt = Date.now();
				boundaryReadyAt = readyAt;
				clearTimeout(timeout);
				child.kill();
				timeout = setTimeout(() => {
					if (settled) return;
					settled = true;
					reject(
						new Error(
							`Timed out waiting for process close after durable ${phase} boundary after ${Date.now() - readyAt}ms: ${output}`,
						),
					);
				}, closeTimeoutMs);
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
			if (boundaryReadyAt === undefined) {
				const stage = startupReadyAt === undefined ? "startup readiness" : `durable ${phase} boundary`;
				reject(new Error(`Process exited before ${stage}: code=${code} signal=${signal} output=${output}`));
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
	}, testTimeoutMs);
});
