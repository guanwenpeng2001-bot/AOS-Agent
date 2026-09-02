import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildExternalConnectorTargetConfig } from "../../src/core/connector/target-config.ts";
import { ProductionClaudeProcessBridge } from "../../src/core/connector/vendor/claude-process-bridge.ts";
import type { ExternalConnectorProcessChannel, ExternalConnectorProcessController } from "../../src/core/connector/supervisor.ts";

const directories: string[] = [];
const identity = `sha256:${"0".repeat(64)}`;

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

class FakeChannel implements ExternalConnectorProcessChannel {
	readonly writes: string[] = [];
	readonly #reads: string[];

	constructor(reads: readonly unknown[]) {
		this.#reads = reads.map((value) => JSON.stringify(value));
	}

	writeLine(line: string): void {
		this.writes.push(line);
	}

	readLine(): Promise<string | undefined> {
		return Promise.resolve(this.#reads.shift());
	}
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
