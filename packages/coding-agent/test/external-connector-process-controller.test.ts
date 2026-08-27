import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { ProductionExternalConnectorProcessController } from "../src/core/external-connector-process-controller.ts";
import {
	externalConnectorProcessContainment,
	type ExternalConnectorProcessHandle,
	type ExternalConnectorProcessLaunchRequest,
} from "../src/core/external-connector-supervisor.ts";

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

			expect(handle.forceTerminate({
				operationNonce: launchRequest.operationNonce,
				processIdentity: { ...handle.identity, startToken: "reused-process" },
			})).toBe("identity_mismatch");
			const attached = controller.reattach(handle.identity, launchRequest);
			expect(attached.status).toBe("attached");
			if (attached.status !== "attached") throw new Error("production process did not reattach");
			expect(attached.handle.forceTerminate({
				operationNonce: launchRequest.operationNonce,
				processIdentity: handle.identity,
			})).toBe("termination_requested");
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

	it("reports the contained companion exiting without an explicit termination request", async () => {
		const controller = new ProductionExternalConnectorProcessController({
			process: fixtureProcess(["-e", "setTimeout(function(){process.exit(0)},50)"]),
		});
		const handle = await controller.launch(request("short-lived-nonce"));
		await handle.activate();
		await waitForExit(handle);
	}, 30_000);

	it("rejects reattach when the nonce or any full-identity field differs", async () => {
		const controller = new ProductionExternalConnectorProcessController({ process: fixtureProcess() });
		const launchRequest = request("reattach-nonce");
		const handle = await controller.launch(launchRequest);
		try {
			await handle.activate();
			expect(controller.reattach(
				{ ...handle.identity, fileIdentity: "different-file" },
				launchRequest,
			)).toEqual({ status: "identity_mismatch" });
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

	it("fails closed on hosts without a production containment implementation", () => {
		expect(() => new ProductionExternalConnectorProcessController({
			platform: "darwin",
			process: fixtureProcess(),
		})).toThrow(
			"unsupported",
		);
	});
});
