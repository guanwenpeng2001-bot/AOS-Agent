import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { buildExternalConnectorTargetConfig } from "../../src/core/connector/target-config.ts";
import { ProductionClaudeProcessBridge } from "../../src/core/connector/vendor/claude-process-bridge.ts";
import type { ExternalConnectorProcessChannel, ExternalConnectorProcessController } from "../../src/core/connector/supervisor.ts";

const directories: string[] = [];
const identity = `sha256:${"0".repeat(64)}`;
const processBridgeModule = new URL("../../src/core/connector/assets/claude-process-bridge.mjs", import.meta.url);

afterEach(() => {
	for (const directory of directories.splice(0)) {
		rmSync(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
	}
});

type RawRead = string | undefined | Promise<string | undefined>;

class RawFakeChannel implements ExternalConnectorProcessChannel {
	readonly writes: string[] = [];
	readCount = 0;
	readonly #reads: RawRead[];

	constructor(reads: readonly RawRead[]) {
		this.#reads = [...reads];
	}

	writeLine(line: string): void {
		this.writes.push(line);
	}

	readLine(): Promise<string | undefined> {
		this.readCount += 1;
		return Promise.resolve(this.#reads.shift());
	}
}

class FakeChannel extends RawFakeChannel {
	constructor(reads: readonly unknown[]) {
		super(reads.map((value) => JSON.stringify(value)));
	}
}

function createDeferredRead(): {
	readonly promise: Promise<string | undefined>;
	readonly resolve: (value: string | undefined) => void;
} {
	let resolve = (_value: string | undefined): void => {
		throw new Error("deferred read resolved before initialization");
	};
	const promise = new Promise<string | undefined>((settle) => {
		resolve = settle;
	});
	return { promise, resolve };
}

function nextTurn(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

function waitForExit(
	spawned: ReturnType<ProductionClaudeProcessBridge["spawn"]>,
): Promise<readonly [number | null, NodeJS.Signals | null]> {
	return new Promise((resolve, reject) => {
		const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
			spawned.off("error", onError);
			resolve([code, signal]);
		};
		const onError = (error: Error): void => {
			spawned.off("exit", onExit);
			reject(error);
		};
		spawned.once("exit", onExit);
		spawned.once("error", onError);
	});
}

function waitForError(spawned: ReturnType<ProductionClaudeProcessBridge["spawn"]>): Promise<Error> {
	return new Promise((resolve) => spawned.once("error", resolve));
}

function target(cwd: string) {
	const config = buildExternalConnectorTargetConfig({
		global: {
			schemaVersion: 1,
			targets: [{
				schemaVersion: 1,
				targetId: "claude-bridge",
				providerId: "claude-bridge",
				driver: "claude",
				executablePath: process.execPath,
				modulePath: process.execPath,
				cwd,
				version: "0.3.246",
				executableIdentity: identity,
				moduleIdentity: identity,
				capabilityCeiling: {
					modelAccess: ["agent_owned"],
					resume: false,
					toolGateway: true,
					artifacts: false,
					images: false,
				},
			}],
		},
		explicitTargetId: "claude-bridge",
	});
	if (config.selectedTarget === undefined) throw new Error("Claude bridge target is not selected");
	return config.selectedTarget;
}

function bridge(cwd: string, channel: ExternalConnectorProcessChannel | undefined) {
	const controller: ExternalConnectorProcessController = {
		launch: () => Promise.reject(new Error("unused")),
		channelFor: () => channel,
	};
	return new ProductionClaudeProcessBridge(controller, target(cwd));
}

describe("Claude supervised process bridge", () => {
	it("relays bounded bytes and lifecycle through the exact supervisor channel", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "aos-claude-bridge-"));
		directories.push(cwd);
		const channel = new FakeChannel([
			{ type: "stdout", data: Buffer.from("ready\n").toString("base64") },
			{ type: "exit", code: 0, signal: null },
		]);
		const spawned = bridge(cwd, channel).spawn(
			{ supervisorRef: "supervisor", operationNonce: "nonce" },
			{ command: process.execPath, args: ["--version"], cwd, env: { SAFE_FLAG: "1" }, signal: new AbortController().signal },
		);
		let output = "";
		spawned.stdout.on("data", (chunk) => { output += String(chunk); });
		await new Promise<void>((resolve, reject) => {
			spawned.once("exit", (code) => code === 0 ? resolve() : reject(new Error("unexpected exit")));
			spawned.once("error", reject);
		});
		expect(output).toBe("ready\n");
		expect(JSON.parse(channel.writes[0]!)).toMatchObject({
			type: "launch",
			command: process.execPath,
			args: ["--version"],
			env: { SAFE_FLAG: "1" },
		});
		expect(channel.writes.map((line) => JSON.parse(line).type)).toEqual(["launch", "stdout_ack"]);
	});

	it("stops reading while stdout is backpressured, then resumes after drain", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "aos-claude-bridge-backpressure-"));
		directories.push(cwd);
		const channel = new FakeChannel([
			{ type: "stdout", data: Buffer.alloc(64 * 1024, 1).toString("base64") },
			{ type: "exit", code: 0, signal: null },
		]);
		const spawned = bridge(cwd, channel).spawn(
			{ supervisorRef: "supervisor", operationNonce: "nonce" },
			{ command: process.execPath, args: [], cwd, env: {}, signal: new AbortController().signal },
		);
		await nextTurn();

		expect(channel.readCount).toBe(1);
		expect(channel.writes.map((line) => JSON.parse(line).type)).toEqual(["launch"]);

		spawned.stdout.resume();
		await waitForExit(spawned);
		expect(channel.readCount).toBe(2);
		expect(channel.writes.map((line) => JSON.parse(line).type)).toEqual(["launch", "stdout_ack"]);
	});

	it("discards backpressured output on abort and removes lifecycle listeners after exit", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "aos-claude-bridge-abort-"));
		directories.push(cwd);
		const channel = new FakeChannel([
			{ type: "stdout", data: Buffer.alloc(64 * 1024, 1).toString("base64") },
			{ type: "exit", code: null, signal: "SIGTERM" },
		]);
		const abortController = new AbortController();
		const spawned = bridge(cwd, channel).spawn(
			{ supervisorRef: "supervisor", operationNonce: "nonce" },
			{ command: process.execPath, args: [], cwd, env: {}, signal: abortController.signal },
		);
		await nextTurn();
		abortController.abort();
		const [code, signal] = await waitForExit(spawned);

		expect([code, signal]).toEqual([null, "SIGTERM"]);
		expect(channel.writes.map((line) => JSON.parse(line).type)).toEqual([
			"launch",
			"kill",
			"stdout_ack",
		]);
		expect(spawned.kill("SIGTERM")).toBe(false);
	});

	it("terminates a noisy supervised stdout stream with a stable bounded error", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "aos-claude-bridge-limit-"));
		directories.push(cwd);
		const channel = new FakeChannel(Array.from({ length: 65 }, () => ({
			type: "stdout",
			data: Buffer.alloc(64 * 1024, 1).toString("base64"),
		})));
		const spawned = bridge(cwd, channel).spawn(
			{ supervisorRef: "supervisor", operationNonce: "nonce" },
			{ command: process.execPath, args: [], cwd, env: {}, signal: new AbortController().signal },
		);
		spawned.stdout.resume();
		const error = await waitForError(spawned);

		expect(error).toEqual(new Error("Claude Code supervised process bridge stdout limit exceeded"));
		expect(channel.writes.map((line) => JSON.parse(line))).toContainEqual({ type: "kill", signal: "SIGKILL" });
		expect(spawned.killed).toBe(true);
	});

	it("rejects EOF, malformed frames, non-canonical base64, and oversized single chunks", async () => {
		const invalidReads: readonly RawRead[] = [
			undefined,
			"{not-json",
			JSON.stringify({ type: "stdout", data: 7 }),
			JSON.stringify({ type: "stdout", data: "YQ" }),
			JSON.stringify({ type: "stdout", data: Buffer.alloc(64 * 1024 + 1, 1).toString("base64") }),
		];

		for (const read of invalidReads) {
			const cwd = mkdtempSync(join(tmpdir(), "aos-claude-bridge-invalid-frame-"));
			directories.push(cwd);
			const channel = new RawFakeChannel([read]);
			const spawned = bridge(cwd, channel).spawn(
				{ supervisorRef: "supervisor", operationNonce: "nonce" },
				{ command: process.execPath, args: [], cwd, env: {}, signal: new AbortController().signal },
			);
			const error = await waitForError(spawned);

			expect(error).toEqual(new Error("Claude Code supervised process bridge failed"));
			expect(channel.writes.map((line) => JSON.parse(line))).toContainEqual({ type: "kill", signal: "SIGKILL" });
			expect(spawned.killed).toBe(true);
			expect(spawned.kill("SIGTERM")).toBe(false);
		}
	});

	it("settles a delayed read through timeout abort without exposing late stdout", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "aos-claude-bridge-delayed-abort-"));
		directories.push(cwd);
		const delayed = createDeferredRead();
		const channel = new RawFakeChannel([
			delayed.promise,
			JSON.stringify({ type: "exit", code: null, signal: "SIGTERM" }),
		]);
		const abortController = new AbortController();
		const spawned = bridge(cwd, channel).spawn(
			{ supervisorRef: "supervisor", operationNonce: "nonce" },
			{ command: process.execPath, args: [], cwd, env: {}, signal: abortController.signal },
		);
		let output = "";
		spawned.stdout.on("data", (chunk) => { output += String(chunk); });
		const exit = waitForExit(spawned);
		await nextTurn();

		abortController.abort();
		await nextTurn();
		expect(channel.writes.map((line) => JSON.parse(line))).toEqual([
			expect.objectContaining({ type: "launch" }),
			{ type: "kill", signal: "SIGTERM" },
		]);

		delayed.resolve(JSON.stringify({ type: "stdout", data: Buffer.from("late").toString("base64") }));
		expect(await exit).toEqual([null, "SIGTERM"]);
		expect(output).toBe("");
		expect(channel.writes.map((line) => JSON.parse(line).type)).toEqual(["launch", "kill", "stdout_ack"]);
		expect(spawned.kill("SIGTERM")).toBe(false);
	});

	it("cleans up a failed spawn so a later spawn can recover on the same bridge", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "aos-claude-bridge-recovery-"));
		directories.push(cwd);
		const channel = new RawFakeChannel([
			"{not-json",
			JSON.stringify({ type: "exit", code: 0, signal: null }),
		]);
		const processBridge = bridge(cwd, channel);
		const firstAbort = new AbortController();
		const failed = processBridge.spawn(
			{ supervisorRef: "supervisor", operationNonce: "first" },
			{ command: process.execPath, args: [], cwd, env: {}, signal: firstAbort.signal },
		);
		expect(await waitForError(failed)).toEqual(new Error("Claude Code supervised process bridge failed"));
		const writesAfterFailure = channel.writes.length;

		firstAbort.abort();
		await nextTurn();
		expect(channel.writes).toHaveLength(writesAfterFailure);

		const recovered = processBridge.spawn(
			{ supervisorRef: "supervisor", operationNonce: "second" },
			{ command: process.execPath, args: [], cwd, env: {}, signal: new AbortController().signal },
		);
		expect(await waitForExit(recovered)).toEqual([0, null]);
		expect(channel.writes.map((line) => JSON.parse(line).type)).toEqual(["launch", "kill", "launch"]);
	});

	it("bounds raw stdout from a high-speed child inside the packaged bridge", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "aos-claude-raw-stdout-limit-"));
		directories.push(cwd);
		const helper = spawn(process.execPath, [fileURLToPath(processBridgeModule)], {
			cwd,
			stdio: ["pipe", "pipe", "pipe"],
			windowsHide: true,
		});
		helper.stderr.resume();
		const lines = createInterface({ input: helper.stdout, crlfDelay: Infinity });
		helper.stdin.write(`${JSON.stringify({
			type: "launch",
			command: process.execPath,
			args: ["-e", "process.stdout.write(Buffer.alloc(5 * 1024 * 1024, 1))"],
			cwd,
			env: {},
		})}\n`);
		let rawBytes = 0;
		let terminal: unknown;
		try {
			for await (const line of lines) {
				const message: unknown = JSON.parse(line);
				if (typeof message !== "object" || message === null || !("type" in message)) continue;
				if (message.type === "stdout" && "data" in message && typeof message.data === "string") {
					rawBytes += Buffer.from(message.data, "base64").byteLength;
					helper.stdin.write(`${JSON.stringify({ type: "stdout_ack" })}\n`);
					continue;
				}
				terminal = message;
				break;
			}
		} finally {
			lines.close();
			helper.kill("SIGKILL");
			await once(helper, "close");
		}

		expect(rawBytes).toBeLessThanOrEqual(4 * 1024 * 1024);
		expect(terminal).toEqual({ type: "error", code: "stdout_limit_exceeded" });
	});

	it("rejects missing channels, command drift, sensitive environment, and oversized argv", () => {
		const cwd = mkdtempSync(join(tmpdir(), "aos-claude-bridge-invalid-"));
		directories.push(cwd);
		const reference = { supervisorRef: "supervisor", operationNonce: "nonce" };
		const valid = { command: process.execPath, args: [] as string[], cwd, env: {}, signal: new AbortController().signal };
		expect(() => bridge(cwd, undefined).spawn(reference, valid)).toThrow("channel is unavailable");
		expect(() => bridge(cwd, new FakeChannel([])).spawn(reference, { ...valid, command: join(cwd, "missing") })).toThrow();
		expect(() => bridge(cwd, new FakeChannel([])).spawn(reference, {
			...valid,
			env: { ANTHROPIC_API_KEY: "secret" },
		})).toThrow("safe bounded projection");
		expect(() => bridge(cwd, new FakeChannel([])).spawn(reference, {
			...valid,
			args: Array.from({ length: 257 }, () => "x"),
		})).toThrow("trusted target");
	});
});
