import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createConnectorCapabilitySnapshot } from "@aos-agent/agent-core";
import { describe, expect, it } from "vitest";
import { DurableExternalAgentConnector } from "../src/core/external-agent-connector.ts";
import type { ExternalConnectorDurableStore } from "../src/core/external-agent-operation.ts";
import { ProductionExternalConnectorProcessController } from "../src/core/external-connector-process-controller.ts";
import {
	createProductionExternalAgentConnector,
	createProductionExternalConnectorSupervision,
} from "../src/core/external-connector-production.ts";
import {
	FileExternalConnectorSupervisorPrivateStateStore,
	externalConnectorProcessContainment,
} from "../src/core/external-connector-supervisor.ts";
import type { ExternalConnectorVendorDriver } from "../src/core/vendor-drivers/types.ts";

const processOptions = {
	executablePath: process.execPath,
	arguments: ["-e", "setInterval(function(){},2147483647)"],
} as const;

function processIsLive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

describe("production External Connector composition", () => {
	it("wires the host controller and File private-state store instead of injectable test supervision", () => {
		const supervision = createProductionExternalConnectorSupervision({
			privateStatePath: join(tmpdir(), `aos-external-production-${process.pid}.json`),
			process: processOptions,
		});
		expect(supervision.containment).toBe(externalConnectorProcessContainment());
		expect(supervision.processController).toBeInstanceOf(ProductionExternalConnectorProcessController);
		expect(supervision.privateStateStore).toBeInstanceOf(FileExternalConnectorSupervisorPrivateStateStore);
	});

	it("creates the production connector only after its startup recovery sweep", async () => {
		const connector = await createProductionExternalAgentConnector({
			providerId: "production-connector",
			capability: createConnectorCapabilitySnapshot({
				schemaVersion: 1,
				providerId: "production-connector",
				revision: 1,
				protocol: { name: "production-protocol", version: "1" },
				modelAccess: "agent_owned",
				resume: true,
				toolGateway: false,
				artifacts: false,
				images: false,
			}),
			store: Object.freeze({}) as ExternalConnectorDurableStore,
			driver: Object.freeze({}) as ExternalConnectorVendorDriver,
			privateStatePath: join(tmpdir(), `aos-external-production-factory-${process.pid}.json`),
			process: processOptions,
		});
		expect(connector).toBeInstanceOf(DurableExternalAgentConnector);
	});

	// The Windows test worker is already in a kill-on-close Job, so it cannot leave a nested guardian orphan.
	it.skipIf(process.platform === "win32")(
		"exact-reaps an orphan after a real Host hard crash and separate production restart",
		async () => {
			const root = mkdtempSync(join(tmpdir(), "aos-external-production-hard-crash-"));
			const privateStatePath = join(root, "private", "supervisors.json");
			const targetPidPath = join(root, "target.pid");
			const readyPath = join(root, "ready.json");
			const fixturePath = join(import.meta.dirname, "fixtures", "external-connector-hard-crash-host.ts");
			const tsxPath = join(import.meta.dirname, "../../../node_modules/tsx/dist/cli.mjs");
			const recover = async (): Promise<void> => {
				await createProductionExternalAgentConnector({
					providerId: "production-hard-crash-connector",
					capability: createConnectorCapabilitySnapshot({
						schemaVersion: 1,
						providerId: "production-hard-crash-connector",
						revision: 1,
						protocol: { name: "production-protocol", version: "1" },
						modelAccess: "agent_owned",
						resume: true,
						toolGateway: false,
						artifacts: false,
						images: false,
					}),
					store: Object.freeze({}) as ExternalConnectorDurableStore,
					driver: Object.freeze({}) as ExternalConnectorVendorDriver,
					privateStatePath,
					process: {
						executablePath: process.execPath,
						arguments: [
							"-e",
							"require('node:fs').writeFileSync(process.argv[1],String(process.pid));setInterval(function(){},2147483647)",
							targetPidPath,
						],
					},
				});
			};
			const host = spawn(process.execPath, [tsxPath, fixturePath, privateStatePath, targetPidPath, readyPath], {
				shell: false,
				stdio: "ignore",
				windowsHide: true,
			});
			try {
				await expect.poll(() => existsSync(readyPath), { timeout: 20_000 }).toBe(true);
				await new Promise<void>((resolve, reject) => {
					if (host.exitCode !== null || host.signalCode !== null) return resolve();
					const timer = setTimeout(() => reject(new Error("hard-crash Host did not exit")), 10_000);
					timer.unref();
					host.once("exit", () => {
						clearTimeout(timer);
						resolve();
					});
				});
				const ready = JSON.parse(readFileSync(readyPath, "utf8")) as { guardianPid: number; targetPid: number };
				expect(processIsLive(ready.guardianPid)).toBe(true);
				expect(processIsLive(ready.targetPid)).toBe(true);

				await recover();

				await expect.poll(() => processIsLive(ready.guardianPid), { timeout: 10_000 }).toBe(false);
				await expect.poll(() => processIsLive(ready.targetPid), { timeout: 10_000 }).toBe(false);
				expect(await new FileExternalConnectorSupervisorPrivateStateStore(privateStatePath).list()).toEqual([]);
			} finally {
				if (host.exitCode === null && host.signalCode === null) {
					host.kill("SIGKILL");
					await new Promise<void>((resolve) => host.once("exit", () => resolve()));
				}
				let cleanupConfirmed = !existsSync(privateStatePath);
				if (!cleanupConfirmed) {
					await recover().catch(() => undefined);
					cleanupConfirmed = await new FileExternalConnectorSupervisorPrivateStateStore(privateStatePath)
						.list()
						.then((entries) => entries.length === 0, () => false);
				}
				if (cleanupConfirmed) rmSync(root, { recursive: true, force: true });
			}
		},
		45_000,
	);
});
