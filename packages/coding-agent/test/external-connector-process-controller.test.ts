import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import {
	externalConnectorGuardianLaunchStrategy,
	externalConnectorMinimalEnvironment,
	ProductionExternalConnectorProcessController,
	resolveProductionExternalConnectorDriverProvenance,
} from "../src/core/connector/process-controller.ts";
import {
	ExternalConnectorBoundedSupervisor,
	externalConnectorProcessContainment,
	type ExternalConnectorProcessHandle,
	type ExternalConnectorProcessLaunchRequest,
} from "../src/core/connector/supervisor.ts";
import { SYSTEM_RUNTIME_CLOCK, type RuntimeClock } from "../src/core/runtime/clock.ts";

function request(operationNonce = "production-nonce"): ExternalConnectorProcessLaunchRequest {
	return {
		supervisorRef: "production-supervisor",
		operationNonce,
		detached: false,
		containment: externalConnectorProcessContainment(),
	};
}

function fixtureProcess(argumentsValue: readonly string[] = ["-e", "setInterval(function(){},2147483647)"]) {
	return { executablePath: process.execPath, arguments: argumentsValue };
}

function productionSupervisor(
	controller: ProductionExternalConnectorProcessController,
	operationNonce: string,
): ExternalConnectorBoundedSupervisor {
	return new ExternalConnectorBoundedSupervisor({
		reference: { schemaVersion: 1, supervisorRef: "production-supervisor", operationNonce },
		containment: externalConnectorProcessContainment(),
		processController: controller,
		artifactsAllowed: false,
		deadlines: { dispose: { hardMs: 10_000, idleMs: 10_000 } },
	});
}

function processIsLive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitForExit(handle: ExternalConnectorProcessHandle): Promise<void> {
	await Promise.race([
		handle.exited,
		new Promise<never>((_, reject) => {
			const timer = setTimeout(() => reject(new Error("contained process did not exit")), 10_000);
			timer.unref();
		}),
	]);
}

describe("production External Connector process controller", () => {
	it("launches non-detached containment and kills only after exact live identity verification", async () => {
		const root = mkdtempSync(join(tmpdir(), "aos-external-process-controller-"));
		const targetPidPath = join(root, "target.pid");
		const controller = new ProductionExternalConnectorProcessController({
			process: fixtureProcess([
				"-e",
				"require('node:fs').writeFileSync(process.argv[1],String(process.pid));setInterval(function(){},2147483647)",
				targetPidPath,
			]),
		});
		const launchRequest = request();
		const handle = await controller.launch(launchRequest);
		try {
			expect(handle.detached).toBe(false);
			expect(handle.containment).toBe(externalConnectorProcessContainment());
			await delay(100);
			expect(existsSync(targetPidPath)).toBe(false);
			await handle.activate();
			await expect.poll(() => existsSync(targetPidPath)).toBe(true);
			const targetPid = Number(readFileSync(targetPidPath, "utf8"));
			expect(processIsLive(targetPid)).toBe(true);

			expect(
				handle.forceTerminate({
					operationNonce: launchRequest.operationNonce,
					processIdentity: { ...handle.identity, startToken: "reused-process" },
				}),
			).toBe("identity_mismatch");
			const attached = controller.reattach(handle.identity, launchRequest);
			expect(attached.status).toBe("attached");
			if (attached.status !== "attached") throw new Error("production process did not reattach");
			expect(
				attached.handle.forceTerminate({
					operationNonce: launchRequest.operationNonce,
					processIdentity: handle.identity,
				}),
			).toBe("termination_requested");
			await waitForExit(handle);
			await expect.poll(() => processIsLive(targetPid)).toBe(false);
		} finally {
			handle.forceTerminate({
				operationNonce: launchRequest.operationNonce,
				processIdentity: handle.identity,
			});
			rmSync(root, { recursive: true, force: true });
		}
	}, 30_000);

	it("fails closed when identity inspection consumes the bounded termination deadline", async () => {
		let monotonicCalls = 0;
		const overrunClock: RuntimeClock = {
			wallNow: () => SYSTEM_RUNTIME_CLOCK.wallNow(),
			monotonicNow: () => (monotonicCalls++ < 3 ? 0 : 6),
			setTimeout: (callback, delayMs) => SYSTEM_RUNTIME_CLOCK.setTimeout(callback, delayMs),
			clearTimeout: (handle) => SYSTEM_RUNTIME_CLOCK.clearTimeout(handle),
			unrefTimeout: (handle) => SYSTEM_RUNTIME_CLOCK.unrefTimeout(handle),
			queueMicrotask: (callback) => SYSTEM_RUNTIME_CLOCK.queueMicrotask(callback),
		};
		const controller = new ProductionExternalConnectorProcessController({
			process: fixtureProcess(),
			clock: overrunClock,
		});
		const launchRequest = request("bounded-helper-overrun-nonce");
		const handle = await controller.launch(launchRequest);
		try {
			await handle.activate();
			await expect(
				handle.forceTerminateBounded({
					operationNonce: launchRequest.operationNonce,
					processIdentity: handle.identity,
				}, { deadlineMs: 5 }),
			).resolves.toBe("ambiguous");
			expect(processIsLive(handle.identity.pid)).toBe(true);
		} finally {
			handle.forceTerminate({
				operationNonce: launchRequest.operationNonce,
				processIdentity: handle.identity,
			});
			await waitForExit(handle);
		}
	}, 30_000);

	it("reattaches and reaps an exact persisted tree without launching a replacement", async () => {
		const root = mkdtempSync(join(tmpdir(), "aos-external-process-recovery-"));
		const targetPidPath = join(root, "target.pid");
		const operationNonce = "production-recovery-nonce";
		const controller = new ProductionExternalConnectorProcessController({
			process: fixtureProcess([
				"-e",
				"require('node:fs').writeFileSync(process.argv[1],String(process.pid));setInterval(function(){},2147483647)",
				targetPidPath,
			]),
		});
		const first = productionSupervisor(controller, operationNonce);
		try {
			const privateState = await first.launch(() => Promise.resolve());
			await expect.poll(() => existsSync(targetPidPath)).toBe(true);
			const targetPid = Number(readFileSync(targetPidPath, "utf8"));
			expect(processIsLive(targetPid)).toBe(true);

			const restarted = productionSupervisor(controller, operationNonce);
			await restarted.recoverAndReap(privateState);

			expect(restarted.snapshot).toMatchObject({ cleaned: true, quarantined: false, phase: "terminal" });
			await expect.poll(() => processIsLive(targetPid)).toBe(false);
		} finally {
			await first.dispose().catch(() => undefined);
			rmSync(root, { recursive: true, force: true });
		}
	}, 30_000);

	it("reports the contained companion exiting without an explicit termination request", async () => {
		const controller = new ProductionExternalConnectorProcessController({
			process: fixtureProcess(["-e", "setTimeout(function(){process.exit(0)},50)"]),
		});
		const handle = await controller.launch(request("short-lived-nonce"));
		await handle.activate();
		await waitForExit(handle);
	}, 30_000);

	it.skipIf(process.platform === "win32")(
		"does not report cleanup until descendants are gone after the direct companion exits",
		async () => {
			const root = mkdtempSync(join(tmpdir(), "aos-external-process-descendant-exit-"));
			const descendantPidPath = join(root, "descendant.pid");
			const controller = new ProductionExternalConnectorProcessController({
				process: fixtureProcess([
					"-e",
					"const{spawn}=require('node:child_process'),{writeFileSync}=require('node:fs');const child=spawn(process.execPath,['-e','setInterval(function(){},2147483647)'],{stdio:'ignore'});writeFileSync(process.argv[1],String(child.pid));setTimeout(function(){process.exit(0)},50)",
					descendantPidPath,
				]),
			});
			const launchRequest = request("descendant-exit-nonce");
			const handle = await controller.launch(launchRequest);
			try {
				await handle.activate();
				await expect.poll(() => existsSync(descendantPidPath)).toBe(true);
				const descendantPid = Number(readFileSync(descendantPidPath, "utf8"));
				await waitForExit(handle);
				await expect.poll(() => processIsLive(descendantPid), { timeout: 10_000 }).toBe(false);
			} finally {
				handle.forceTerminate({
					operationNonce: launchRequest.operationNonce,
					processIdentity: handle.identity,
				});
				rmSync(root, { recursive: true, force: true });
			}
		},
		30_000,
	);

	it.skipIf(process.platform === "win32")(
		"quarantines a live process group after its guardian PID exits because live identity cannot be proven",
		async () => {
			const root = mkdtempSync(join(tmpdir(), "aos-external-process-dead-guardian-"));
			const companionPidPath = join(root, "companion.pid");
			const descendantPidPath = join(root, "descendant.pid");
			const controller = new ProductionExternalConnectorProcessController({
				process: fixtureProcess([
					"-e",
					"const{spawn}=require('node:child_process'),{writeFileSync}=require('node:fs');writeFileSync(process.argv[1],String(process.pid));const child=spawn(process.execPath,['-e','setInterval(function(){},2147483647)'],{stdio:'ignore'});writeFileSync(process.argv[2],String(child.pid));setInterval(function(){},2147483647)",
					companionPidPath,
					descendantPidPath,
				]),
			});
			const launchRequest = request("dead-guardian-nonce");
			const handle = await controller.launch(launchRequest);
			try {
				await handle.activate();
				await expect.poll(() => existsSync(descendantPidPath)).toBe(true);
				const companionPid = Number(readFileSync(companionPidPath, "utf8"));
				const descendantPid = Number(readFileSync(descendantPidPath, "utf8"));
				process.kill(handle.identity.pid, "SIGKILL");
				await expect.poll(() => processIsLive(handle.identity.pid)).toBe(false);

				const reattached = controller.reattach(handle.identity, launchRequest);
				expect(reattached.status).toBe("ambiguous");
				expect(handle.forceTerminate({
					operationNonce: launchRequest.operationNonce,
					processIdentity: handle.identity,
				})).toBe("ambiguous");
				expect(processIsLive(companionPid)).toBe(true);
				expect(processIsLive(descendantPid)).toBe(true);
				process.kill(-handle.identity.pid, "SIGKILL");
				await waitForExit(handle);
				await expect.poll(() => processIsLive(companionPid), { timeout: 10_000 }).toBe(false);
				await expect.poll(() => processIsLive(descendantPid), { timeout: 10_000 }).toBe(false);
			} finally {
				handle.forceTerminate({
					operationNonce: launchRequest.operationNonce,
					processIdentity: handle.identity,
				});
				rmSync(root, { recursive: true, force: true });
			}
		},
		30_000,
	);

	it("launches guardians and companions without ambient secrets", async () => {
		const root = mkdtempSync(join(tmpdir(), "aos-external-process-environment-"));
		const environmentPath = join(root, "environment.json");
		const key = "AOS_EXTERNAL_CONNECTOR_TEST_SECRET";
		const previous = process.env[key];
		let controller: ProductionExternalConnectorProcessController;
		try {
			process.env[key] = "must-not-leak";
			controller = new ProductionExternalConnectorProcessController({
				process: fixtureProcess([
					"-e",
					"require('node:fs').writeFileSync(process.argv[1],JSON.stringify(process.env));setInterval(function(){},2147483647)",
					environmentPath,
				]),
			});
		} finally {
			if (previous === undefined) delete process.env[key];
			else process.env[key] = previous;
		}
		const launchRequest = request("environment-nonce");
		const handle = await controller.launch(launchRequest);
		try {
			await handle.activate();
			await expect.poll(() => existsSync(environmentPath)).toBe(true);
			const environment: unknown = JSON.parse(readFileSync(environmentPath, "utf8"));
			expect(environment).toMatchObject(externalConnectorMinimalEnvironment(process.platform));
			expect(environment).not.toHaveProperty(key);
			expect(environment).not.toHaveProperty("OPENAI_API_KEY");
			expect(environment).not.toHaveProperty("ANTHROPIC_API_KEY");
			expect(environment).not.toHaveProperty("AWS_SECRET_ACCESS_KEY");
		} finally {
			handle.forceTerminate({
				operationNonce: launchRequest.operationNonce,
				processIdentity: handle.identity,
			});
			await waitForExit(handle);
			rmSync(root, { recursive: true, force: true });
		}
	}, 30_000);

	it("keeps only platform-required environment variables", () => {
		expect(
			externalConnectorMinimalEnvironment("linux", {
				PATH: "/untrusted",
				OPENAI_API_KEY: "secret",
			}),
		).toEqual({});
		expect(
			externalConnectorMinimalEnvironment("darwin", {
				TMPDIR: "/private/tmp",
				PATH: "/untrusted",
				ANTHROPIC_API_KEY: "secret",
			}),
		).toEqual({ TMPDIR: "/private/tmp" });
		expect(
			externalConnectorMinimalEnvironment("win32", {
				SYSTEMROOT: "C:\\Windows",
				TEMP: "C:\\Temp",
				PATH: "C:\\untrusted",
				OPENAI_API_KEY: "secret",
			}),
		).toEqual({ SystemRoot: "C:\\Windows", TEMP: "C:\\Temp" });
	});

	it("rejects trusted driver provenance with a mismatched module identity or empty version", () => {
		const executableIdentity = `sha256:${createHash("sha256").update(readFileSync(process.execPath)).digest("hex")}`;
		const trustedProvenance = {
			modulePath: process.execPath,
			cwd: process.cwd(),
			version: process.version,
			executableIdentity,
			moduleIdentity: executableIdentity,
		} as const;

		expect(() =>
			resolveProductionExternalConnectorDriverProvenance({
				executablePath: process.execPath,
				trustedProvenance: { ...trustedProvenance, moduleIdentity: "sha256:wrong" },
			}),
		).toThrow("trusted driver file identity does not match");
		expect(() =>
			resolveProductionExternalConnectorDriverProvenance({
				executablePath: process.execPath,
				trustedProvenance: { ...trustedProvenance, version: "" },
			}),
		).toThrow("trusted driver provenance is invalid");
	});

	it("rejects reattach when the nonce or any full-identity field differs", async () => {
		const controller = new ProductionExternalConnectorProcessController({ process: fixtureProcess() });
		const launchRequest = request("reattach-nonce");
		const handle = await controller.launch(launchRequest);
		try {
			await handle.activate();
			expect(controller.reattach({ ...handle.identity, fileIdentity: "different-file" }, launchRequest)).toEqual({
				status: "identity_mismatch",
			});
			expect(controller.reattach(handle.identity, request("different-nonce"))).toEqual({
				status: "identity_mismatch",
			});
		} finally {
			handle.forceTerminate({
				operationNonce: launchRequest.operationNonce,
				processIdentity: handle.identity,
			});
			await waitForExit(handle);
		}
	}, 30_000);

	it("selects a detached macOS guardian whose companion remains in its process group", () => {
		expect(externalConnectorGuardianLaunchStrategy("darwin")).toEqual({
			kind: "direct_process_group",
			guardianDetached: true,
			companionDetached: false,
		});
		expect(
			() =>
				new ProductionExternalConnectorProcessController({
					platform: "darwin",
					process: fixtureProcess(),
				}),
		).not.toThrow();
		expect(() => externalConnectorGuardianLaunchStrategy("freebsd")).toThrow("unsupported");
	});
});
