import {
	chmodSync,
	linkSync,
	mkdtempSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import {
	ControlPlaneStorageError,
	getControlPlaneLastKnownGoodPath,
	readControlPlaneState,
	type ControlPlaneStorageOperation,
	type ControlPlaneStorageOptions,
	writeControlPlaneState,
} from "../src/core/control-plane-atomic-storage.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { ProjectTrustStore } from "../src/core/trust-manager.ts";

function validateObject(content: string): void {
	const parsed: unknown = JSON.parse(content);
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("expected an object");
	}
}

const STORAGE_OPTIONS = { validate: validateObject } as const;

describe("control-plane atomic storage", () => {
	let tempDir: string;
	let statePath: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "aos-control-storage-"));
		statePath = join(tempDir, "state.json");
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("publishes through unpredictable exclusive same-directory temporary files", () => {
		const tempPaths: string[] = [];
		const options: ControlPlaneStorageOptions = {
			...STORAGE_OPTIONS,
			faultInjector: (context) => {
				if (context.operation === "write") tempPaths.push(context.tempPath);
			},
		};

		writeControlPlaneState(statePath, '{"generation":1}', options);
		writeControlPlaneState(statePath, '{"generation":2}', options);

		expect(new Set(tempPaths).size).toBe(tempPaths.length);
		expect(tempPaths).toHaveLength(4);
		expect(tempPaths.every((path) => dirname(path) === tempDir)).toBe(true);
		expect(readdirSync(tempDir).some((entry) => entry.endsWith(".tmp"))).toBe(false);
		expect(readFileSync(statePath, "utf-8")).toBe('{"generation":2}');
		expect(readFileSync(getControlPlaneLastKnownGoodPath(statePath), "utf-8")).toBe('{"generation":2}');
	});

	it.each<ControlPlaneStorageOperation>(["write", "fsync", "rename", "permission"])(
		"preserves the committed state when %s fails",
		(operation) => {
			writeControlPlaneState(statePath, '{"generation":"old"}', STORAGE_OPTIONS);
			const options: ControlPlaneStorageOptions = {
				...STORAGE_OPTIONS,
				mode: 0o600,
				faultInjector: (context) => {
					if (context.target === "current" && context.operation === operation) {
						throw new Error(`injected ${operation} failure`);
					}
				},
			};

			expect(() => writeControlPlaneState(statePath, '{"generation":"new"}', options)).toThrowError(
				expect.objectContaining({ code: "control_state_write_failed" }),
			);
			expect(readFileSync(statePath, "utf-8")).toBe('{"generation":"old"}');
			expect(readFileSync(getControlPlaneLastKnownGoodPath(statePath), "utf-8")).toBe(
				'{"generation":"old"}',
			);
			expect(readdirSync(tempDir).some((entry) => entry.endsWith(".tmp"))).toBe(false);

			expect(readControlPlaneState(statePath, STORAGE_OPTIONS)).toBe('{"generation":"old"}');
			writeControlPlaneState(statePath, '{"generation":"new"}', STORAGE_OPTIONS);
			expect(readControlPlaneState(statePath, STORAGE_OPTIONS)).toBe('{"generation":"new"}');
		},
	);

	it("validates schema and owner-only permissions before publishing", () => {
		writeControlPlaneState(statePath, '{"valid":true}', { ...STORAGE_OPTIONS, mode: 0o600 });
		expect(() => writeControlPlaneState(statePath, "[]", { ...STORAGE_OPTIONS, mode: 0o600 })).toThrowError(
			expect.objectContaining({ code: "control_state_write_failed" }),
		);
		expect(readFileSync(statePath, "utf-8")).toBe('{"valid":true}');
		if (process.platform !== "win32") {
			expect(statSync(statePath).mode & 0o777).toBe(0o600);
			chmodSync(statePath, 0o644);
			expect(readControlPlaneState(statePath, { ...STORAGE_OPTIONS, mode: 0o600 })).toBe('{"valid":true}');
			expect(statSync(statePath).mode & 0o777).toBe(0o600);

			chmodSync(statePath, 0o640);
			writeControlPlaneState(statePath, '{"valid":"updated"}', STORAGE_OPTIONS);
			expect(statSync(statePath).mode & 0o777).toBe(0o640);
			expect(statSync(getControlPlaneLastKnownGoodPath(statePath)).mode & 0o777).toBe(0o640);
		}
	});

	it("quarantines corrupt current state and repairs it from a valid last-known-good copy", () => {
		writeControlPlaneState(statePath, '{"generation":"known-good"}', STORAGE_OPTIONS);
		writeFileSync(statePath, "{corrupt", "utf-8");

		expect(readControlPlaneState(statePath, STORAGE_OPTIONS)).toBe('{"generation":"known-good"}');
		expect(readFileSync(statePath, "utf-8")).toBe('{"generation":"known-good"}');
		expect(readdirSync(tempDir).filter((entry) => entry.startsWith(".state.json.corrupt."))).toHaveLength(1);
	});

	it("quarantines an invalid last-known-good copy and recreates it from valid current state", () => {
		writeControlPlaneState(statePath, '{"generation":"current"}', STORAGE_OPTIONS);
		writeFileSync(getControlPlaneLastKnownGoodPath(statePath), "[]", "utf-8");

		expect(readControlPlaneState(statePath, STORAGE_OPTIONS)).toBe('{"generation":"current"}');
		expect(readFileSync(getControlPlaneLastKnownGoodPath(statePath), "utf-8")).toBe('{"generation":"current"}');
		expect(readdirSync(tempDir).filter((entry) => entry.startsWith(".state.json.lkg.corrupt."))).toHaveLength(1);
	});

	it("fails closed when current and last-known-good copies are invalid", () => {
		writeFileSync(statePath, "{corrupt", "utf-8");
		writeFileSync(getControlPlaneLastKnownGoodPath(statePath), "[]", "utf-8");

		expect(() => readControlPlaneState(statePath, STORAGE_OPTIONS)).toThrowError(
			expect.objectContaining({ code: "control_state_corrupt" }),
		);
		expect(readdirSync(tempDir).filter((entry) => entry.includes(".corrupt."))).toHaveLength(2);
		expect(() => readControlPlaneState(statePath, STORAGE_OPTIONS)).toThrow(ControlPlaneStorageError);
	});

	it("retries a failed repair without discarding the valid last-known-good copy", () => {
		writeControlPlaneState(statePath, '{"generation":"known-good"}', STORAGE_OPTIONS);
		writeFileSync(statePath, "{corrupt", "utf-8");
		const repairRename = vi.fn();
		const failingRepair: ControlPlaneStorageOptions = {
			...STORAGE_OPTIONS,
			faultInjector: (context) => {
				if (context.target === "repair" && context.operation === "rename") {
					repairRename();
					throw new Error("injected repair failure");
				}
			},
		};

		expect(() => readControlPlaneState(statePath, failingRepair)).toThrowError(
			expect.objectContaining({ code: "control_state_write_failed" }),
		);
		expect(repairRename).toHaveBeenCalledTimes(1);
		expect(readFileSync(getControlPlaneLastKnownGoodPath(statePath), "utf-8")).toBe('{"generation":"known-good"}');
		expect(readControlPlaneState(statePath, STORAGE_OPTIONS)).toBe('{"generation":"known-good"}');
	});

	it("serializes concurrent auth writers without dropping either update", async () => {
		const authPath = join(tempDir, "auth.json");
		const first = AuthStorage.create(authPath);
		const second = AuthStorage.create(authPath);
		let markStarted: (() => void) | undefined;
		let finish: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const blocked = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const firstWrite = first.modify("first", async () => {
			markStarted?.();
			await blocked;
			return { type: "api_key", key: "first-key" };
		});
		await started;
		const secondMutation = vi.fn(async () => ({ type: "api_key" as const, key: "second-key" }));
		const secondWrite = second.modify("second", secondMutation);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(secondMutation).not.toHaveBeenCalled();

		finish?.();
		await Promise.all([firstWrite, secondWrite]);
		expect(JSON.parse(readFileSync(authPath, "utf-8"))).toEqual({
			first: { type: "api_key", key: "first-key" },
			second: { type: "api_key", key: "second-key" },
		});
	});

	it("replaces settings, auth, and trust hardlinks without mutating committed content", async () => {
		const agentDir = join(tempDir, "agent");
		const projectDir = join(tempDir, "project");
		const sentinelsDir = join(tempDir, "sentinels");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(projectDir, { recursive: true });
		mkdirSync(sentinelsDir, { recursive: true });

		const committedContents = {
			settings: `${JSON.stringify({ defaultProvider: "old-provider" })}\n`,
			auth: "{}\n",
			trust: "{}\n",
		} as const;
		const controlPaths = {
			settings: join(agentDir, "settings.json"),
			auth: join(agentDir, "auth.json"),
			trust: join(agentDir, "trust.json"),
		} as const;
		const sentinelPaths = {
			settings: join(sentinelsDir, "settings-committed.json"),
			auth: join(sentinelsDir, "auth-committed.json"),
			trust: join(sentinelsDir, "trust-committed.json"),
		} as const;
		for (const name of ["settings", "auth", "trust"] as const) {
			writeFileSync(sentinelPaths[name], committedContents[name], "utf-8");
			linkSync(sentinelPaths[name], controlPaths[name]);
		}

		const settings = SettingsManager.create(projectDir, agentDir);
		settings.setDefaultProvider("new-provider");
		await settings.flush();
		await AuthStorage.create(controlPaths.auth).modify("new-provider", async () => ({
			type: "api_key",
			key: "new-key",
		}));
		const trust = new ProjectTrustStore(agentDir);
		trust.set(projectDir, true);

		expect(JSON.parse(readFileSync(controlPaths.settings, "utf-8")).defaultProvider).toBe(
			"new-provider",
		);
		expect(JSON.parse(readFileSync(controlPaths.auth, "utf-8"))["new-provider"]?.key).toBe(
			"new-key",
		);
		expect(trust.get(projectDir)).toBe(true);
		for (const name of ["settings", "auth", "trust"] as const) {
			expect(readFileSync(sentinelPaths[name], "utf-8")).toBe(committedContents[name]);
		}
	});
});
