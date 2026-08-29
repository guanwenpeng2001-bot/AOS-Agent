import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	Result,
	createConnectorCapabilitySnapshot,
	type ExternalAgentConnector,
} from "@aos-agent/agent-core";
import { describe, expect, it } from "vitest";
import type { ExternalConnectorDurableStore } from "../../src/core/connector/operation.ts";
import {
	ProductionExternalConnectorProcessController,
	type ProductionExternalConnectorProcessWithProvenance,
} from "../../src/core/connector/process-controller.ts";
import {
	createProductionExternalAgentConnector,
	getProductionExternalConnectorStartupStatus,
} from "../../src/core/connector/production.ts";
import {
	FileExternalConnectorSupervisorPrivateStateStore,
	externalConnectorProcessContainment,
	type ExternalConnectorProcessHandle,
	type ExternalConnectorProcessLaunchRequest,
	type ExternalConnectorSupervisorPrivateState,
} from "../../src/core/connector/supervisor.ts";
import type { ExternalConnectorVendorDriver } from "../../src/core/connector/vendor/types.ts";

const SUPPORTED_PLATFORM = process.platform === "linux" || process.platform === "darwin" || process.platform === "win32";
const PROVIDER_ID = "product-process-supervision-connector";
const ATTEMPT_ID = "product-process-supervision-attempt";
const SUPERVISOR_REF = "product-process-supervision-ref";
const EXECUTABLE_DIGEST = `sha256:${createHash("sha256").update(readFileSync(process.execPath)).digest("hex")}`;
const CAPABILITY = createConnectorCapabilitySnapshot({
	schemaVersion: 1,
	providerId: PROVIDER_ID,
	revision: 1,
	protocol: { name: "product-process-supervision", version: "1" },
	modelAccess: "agent_owned",
	resume: true,
	toolGateway: false,
	artifacts: false,
	images: false,
});

function containedProcess(targetPidPath?: string): ProductionExternalConnectorProcessWithProvenance {
	return {
		executablePath: process.execPath,
		arguments:
			targetPidPath === undefined
				? ["-e", "setInterval(function(){},2147483647)"]
				: [
						"-e",
						"require('node:fs').writeFileSync(process.argv[1],String(process.pid));setInterval(function(){},2147483647)",
						targetPidPath,
					],
		trustedProvenance: {
			modulePath: process.execPath,
			cwd: process.cwd(),
			version: process.version,
			executableIdentity: EXECUTABLE_DIGEST,
			moduleIdentity: EXECUTABLE_DIGEST,
		},
	};
}

function launchRequest(operationNonce: string): ExternalConnectorProcessLaunchRequest {
	return {
		supervisorRef: SUPERVISOR_REF,
		operationNonce,
		detached: false,
		containment: externalConnectorProcessContainment(),
	};
}

function privateState(
	handle: ExternalConnectorProcessHandle,
	operationNonce: string,
): ExternalConnectorSupervisorPrivateState {
	return {
		schemaVersion: 1,
		reference: { schemaVersion: 1, supervisorRef: SUPERVISOR_REF, operationNonce },
		detached: false,
		containment: externalConnectorProcessContainment(),
		processIdentity: handle.identity,
	};
}

function startupStore(): ExternalConnectorDurableStore {
	return Object.freeze({
		readOperation: async () => undefined,
		readMapping: async () => undefined,
	}) as unknown as ExternalConnectorDurableStore;
}

function startupDriver(): ExternalConnectorVendorDriver {
	return Object.freeze({ dispose: async () => undefined }) as unknown as ExternalConnectorVendorDriver;
}

async function createRecoveryConnector(
	privateStatePath: string,
	processConfiguration: ProductionExternalConnectorProcessWithProvenance,
): Promise<ExternalAgentConnector> {
	return createProductionExternalAgentConnector({
		providerId: PROVIDER_ID,
		capability: CAPABILITY,
		capabilityProbe: async () => Result.ok(CAPABILITY),
		store: startupStore(),
		driver: startupDriver(),
		privateStatePath,
		process: processConfiguration,
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

async function waitForExit(exited: Promise<void>, description: string): Promise<void> {
	let timer: NodeJS.Timeout | undefined;
	try {
		await Promise.race([
			exited,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error(`${description} did not exit`)), 10_000);
				timer.unref();
			}),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

async function waitForChildExit(child: ChildProcess, description: string): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) return;
	let timer: NodeJS.Timeout | undefined;
	try {
		await new Promise<void>((resolve, reject) => {
			const onExit = (): void => {
				if (timer !== undefined) clearTimeout(timer);
				resolve();
			};
			timer = setTimeout(() => {
				child.off("exit", onExit);
				reject(new Error(`${description} did not exit`));
			}, 10_000);
			timer.unref();
			child.once("exit", onExit);
		});
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

async function terminateExactHandle(
	handle: ExternalConnectorProcessHandle,
	operationNonce: string,
): Promise<void> {
	handle.forceTerminate({ operationNonce, processIdentity: handle.identity });
	await waitForExit(handle.exited, "contained process").catch(() => undefined);
}

interface PersistedMismatchCase {
	readonly name: string;
	readonly mutate: (state: ExternalConnectorSupervisorPrivateState) => ExternalConnectorSupervisorPrivateState;
}

const PERSISTED_MISMATCH_CASES: readonly PersistedMismatchCase[] = [
	{
		name: "PID reuse start-token mismatch",
		mutate: (state) => ({
			...state,
			processIdentity: { ...state.processIdentity, startToken: `${state.processIdentity.startToken}-reused` },
		}),
	},
	{
		name: "executable identity mismatch",
		mutate: (state) => ({
			...state,
			processIdentity: { ...state.processIdentity, executableIdentity: "sha256:unrelated-executable" },
		}),
	},
	{
		name: "file identity mismatch",
		mutate: (state) => ({
			...state,
			processIdentity: { ...state.processIdentity, fileIdentity: "file:unrelated-process" },
		}),
	},
	{
		name: "operation nonce mismatch",
		mutate: (state) => ({
			...state,
			reference: {
				...state.reference,
				operationNonce: `${state.reference.operationNonce}-unrelated`,
			},
		}),
	},
	{
		name: "containment mismatch",
		mutate: (state) => ({
			...state,
			containment: state.containment === "process_group" ? "job_object" : "process_group",
		}),
	},
];

describe("product External Connector process supervision", () => {
	it.skipIf(!SUPPORTED_PLATFORM)(
		"exact-matches every persisted process identity field, reaps once, and leaves unrelated processes alive",
		async () => {
			const root = mkdtempSync(join(tmpdir(), "aos-external-product-process-exact-"));
			const privateStatePath = join(root, "private", "supervisors.json");
			const processConfiguration = containedProcess();
			const operationNonce = `product-exact-nonce-${process.pid}`;
			const controller = new ProductionExternalConnectorProcessController({ process: processConfiguration });
			const request = launchRequest(operationNonce);
			const handle = await controller.launch(request);
			let first: ExternalAgentConnector | undefined;
			let repeated: ExternalAgentConnector | undefined;
			let unrelated: ChildProcess | undefined;
			try {
				await handle.activate();
				unrelated = spawn(process.execPath, ["-e", "setInterval(function(){},2147483647)"], {
					shell: false,
					stdio: "ignore",
					windowsHide: true,
				});
				await new Promise<void>((resolve, reject) => {
					unrelated!.once("spawn", resolve);
					unrelated!.once("error", reject);
				});
				if (unrelated.pid === undefined) throw new Error("unrelated fixture process did not start");
				const state = privateState(handle, operationNonce);
				const privateStore = new FileExternalConnectorSupervisorPrivateStateStore(privateStatePath);
				await privateStore.write(ATTEMPT_ID, state);
				expect(await privateStore.read(ATTEMPT_ID)).toEqual(state);
				expect(state).toMatchObject({
					reference: { operationNonce },
					detached: false,
					containment: externalConnectorProcessContainment(),
					processIdentity: handle.identity,
				});

				first = await createRecoveryConnector(privateStatePath, processConfiguration);
				expect(getProductionExternalConnectorStartupStatus(first)).toEqual({
					schemaVersion: 1,
					trust: "host_configured",
					readiness: "ready",
					recovery: [{ attemptId: ATTEMPT_ID, status: "reaped" }],
				});
				await waitForExit(handle.exited, "exactly matched contained process");
				expect(processIsLive(handle.identity.pid)).toBe(false);
				expect(processIsLive(unrelated.pid)).toBe(true);
				expect(await privateStore.list()).toEqual([]);

				repeated = await createRecoveryConnector(privateStatePath, processConfiguration);
				expect(getProductionExternalConnectorStartupStatus(repeated)?.recovery).toEqual([]);
				expect(processIsLive(unrelated.pid)).toBe(true);
			} finally {
				await repeated?.dispose().catch(() => undefined);
				await first?.dispose().catch(() => undefined);
				await terminateExactHandle(handle, operationNonce);
				if (unrelated !== undefined) {
					if (unrelated.exitCode === null && unrelated.signalCode === null) unrelated.kill("SIGKILL");
					await waitForChildExit(unrelated, "unrelated fixture process").catch(() => undefined);
				}
				rmSync(root, { recursive: true, force: true });
			}
		},
		30_000,
	);

	it.skipIf(!SUPPORTED_PLATFORM).each(PERSISTED_MISMATCH_CASES)(
		"quarantines $name on every recovery without terminating the live process",
		async ({ name, mutate }) => {
			const root = mkdtempSync(join(tmpdir(), "aos-external-product-process-mismatch-"));
			const privateStatePath = join(root, "private", "supervisors.json");
			const processConfiguration = containedProcess();
			const operationNonce = `product-mismatch-${name.toLowerCase().replaceAll(/[^a-z]+/gu, "-")}-${process.pid}`;
			const controller = new ProductionExternalConnectorProcessController({ process: processConfiguration });
			const handle = await controller.launch(launchRequest(operationNonce));
			let first: ExternalAgentConnector | undefined;
			let repeated: ExternalAgentConnector | undefined;
			try {
				await handle.activate();
				const persisted = mutate(privateState(handle, operationNonce));
				const privateStore = new FileExternalConnectorSupervisorPrivateStateStore(privateStatePath);
				await privateStore.write(ATTEMPT_ID, persisted);

				first = await createRecoveryConnector(privateStatePath, processConfiguration);
				expect(getProductionExternalConnectorStartupStatus(first)).toMatchObject({
					readiness: "quarantined",
					recovery: [{ attemptId: ATTEMPT_ID, status: "quarantined" }],
				});
				expect(processIsLive(handle.identity.pid)).toBe(true);
				expect(await privateStore.read(ATTEMPT_ID)).toEqual(persisted);

				repeated = await createRecoveryConnector(privateStatePath, processConfiguration);
				expect(getProductionExternalConnectorStartupStatus(repeated)).toMatchObject({
					readiness: "quarantined",
					recovery: [{ attemptId: ATTEMPT_ID, status: "quarantined" }],
				});
				expect(processIsLive(handle.identity.pid)).toBe(true);
				expect(await privateStore.read(ATTEMPT_ID)).toEqual(persisted);
			} finally {
				await repeated?.dispose().catch(() => undefined);
				await first?.dispose().catch(() => undefined);
				await terminateExactHandle(handle, operationNonce);
				rmSync(root, { recursive: true, force: true });
			}
		},
		30_000,
	);

	// Windows test workers already run in a kill-on-close Job, so they cannot create the orphan this fixture targets.
	it.skipIf(process.platform === "win32" || !SUPPORTED_PLATFORM)(
		"reaps the exact orphan after a hard-crash Host and makes the next recovery a no-op",
		async () => {
			const root = mkdtempSync(join(tmpdir(), "aos-external-product-process-hard-crash-"));
			const privateStatePath = join(root, "private", "supervisors.json");
			const targetPidPath = join(root, "target.pid");
			const readyPath = join(root, "ready.json");
			const processConfiguration = containedProcess(targetPidPath);
			const fixturePath = join(import.meta.dirname, "fixtures", "external-connector-hard-crash-host.ts");
			const tsxPath = join(import.meta.dirname, "../../../node_modules/tsx/dist/cli.mjs");
			const host = spawn(process.execPath, [tsxPath, fixturePath, privateStatePath, targetPidPath, readyPath], {
				shell: false,
				stdio: "ignore",
				windowsHide: true,
			});
			let connector: ExternalAgentConnector | undefined;
			let repeated: ExternalAgentConnector | undefined;
			try {
				await expect.poll(() => existsSync(readyPath), { timeout: 20_000 }).toBe(true);
				await waitForChildExit(host, "hard-crash Host");
				const readyValue: unknown = JSON.parse(readFileSync(readyPath, "utf8"));
				if (
					typeof readyValue !== "object" ||
					readyValue === null ||
					!("guardianPid" in readyValue) ||
					!("targetPid" in readyValue) ||
					typeof readyValue.guardianPid !== "number" ||
					typeof readyValue.targetPid !== "number"
				) {
					throw new Error("hard-crash fixture identity is invalid");
				}
				const guardianPid = readyValue.guardianPid;
				const targetPid = readyValue.targetPid;
				expect(processIsLive(guardianPid)).toBe(true);
				expect(processIsLive(targetPid)).toBe(true);

				connector = await createRecoveryConnector(privateStatePath, processConfiguration);
				expect(getProductionExternalConnectorStartupStatus(connector)?.recovery).toEqual([
					{ attemptId: "hard-crash-attempt", status: "reaped" },
				]);
				await expect.poll(() => processIsLive(guardianPid), { timeout: 10_000 }).toBe(false);
				await expect.poll(() => processIsLive(targetPid), { timeout: 10_000 }).toBe(false);
				expect(await new FileExternalConnectorSupervisorPrivateStateStore(privateStatePath).list()).toEqual([]);

				repeated = await createRecoveryConnector(privateStatePath, processConfiguration);
				expect(getProductionExternalConnectorStartupStatus(repeated)?.recovery).toEqual([]);
			} finally {
				if (host.exitCode === null && host.signalCode === null) {
					host.kill("SIGKILL");
					await waitForChildExit(host, "hard-crash Host cleanup").catch(() => undefined);
				}
				await repeated?.dispose().catch(() => undefined);
				await connector?.dispose().catch(() => undefined);
				let cleanupConfirmed = !existsSync(privateStatePath);
				if (!cleanupConfirmed) {
					const cleanup = await createRecoveryConnector(privateStatePath, processConfiguration).catch(() => undefined);
					await cleanup?.dispose().catch(() => undefined);
					cleanupConfirmed = await new FileExternalConnectorSupervisorPrivateStateStore(privateStatePath)
						.list()
						.then(
							(entries) => entries.length === 0,
							() => false,
						);
				}
				if (cleanupConfirmed) rmSync(root, { recursive: true, force: true });
			}
		},
		45_000,
	);
});
