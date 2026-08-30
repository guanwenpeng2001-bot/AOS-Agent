import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "@aos-agent/ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getAgentCanonicalSession } from "../../src/core/session/facade.ts";
import { AuthStorage } from "../../src/core/policy/auth-storage.ts";
import { packagedExternalAgentDriverProcessModulePath } from "../../src/core/connector/packaged-driver.ts";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentRuntimeCompositionFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	ModelRuntime,
	SettingsManager,
} from "../../src/index.ts";
import type { ExternalConnectorTargetDefinition } from "../../src/external-connector.ts";
import { createRpcHostController } from "../../src/modes/rpc/rpc-host.ts";
import type { RpcHostOutputRecord } from "../../src/modes/rpc/rpc-host.ts";
import { pr11TargetDefinition } from "./fixtures/pr-11-cross-layer.ts";

const directories: string[] = [];
const DEFAULT_MODEL: Model<"anthropic-messages"> = {
	id: "product-entry-model",
	name: "Product Entry Model",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: false,
	input: [],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 64_000,
};

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function identity(path: string): string {
	return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}

function packagedSettings(cwd: string): SettingsManager {
	const modulePath = packagedExternalAgentDriverProcessModulePath("fake-connector");
	return SettingsManager.inMemory({
		externalConnectors: {
			schemaVersion: 1,
			targetId: "packaged-fake",
			targets: [
				{
					schemaVersion: 1,
					targetId: "packaged-fake",
					providerId: "aos.fake-connector",
					executablePath: process.execPath,
					modulePath,
					cwd,
					version: "1",
					executableIdentity: identity(process.execPath),
					moduleIdentity: identity(modulePath),
					capabilityCeiling: {
						modelAccess: ["none"],
						resume: true,
						toolGateway: false,
						artifacts: false,
						images: false,
					},
				},
			],
		},
	});
}

function genericSettings(
	cwd: string,
	overrides: Partial<ExternalConnectorTargetDefinition> = {},
): SettingsManager {
	const target = {
		...pr11TargetDefinition(cwd, {
			targetId: "settings-generic-jsonl",
			providerId: "fixture.external-jsonl",
		}),
		...overrides,
	};
	return SettingsManager.inMemory({
		externalConnectors: {
			schemaVersion: 1,
			targetId: target.targetId,
			targets: [target],
		},
	});
}

async function createServices(
	cwd: string,
	settingsManager: SettingsManager,
	runtimeComposition?: ReturnType<typeof createAgentRuntimeCompositionFactory>,
) {
	return createAgentSessionServices({
		cwd,
		agentDir: cwd,
		settingsManager,
		modelRuntime: await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null }),
		...(runtimeComposition === undefined ? {} : { runtimeComposition }),
		resourceLoaderOptions: {
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		},
	});
}

async function createRuntime(cwd: string, settingsManager: SettingsManager) {
	const services = await createServices(cwd, settingsManager);
	const factory: CreateAgentSessionRuntimeFactory = async (options) => {
		const created = await createAgentSessionFromServices({
			services,
			sessionManager: options.sessionManager,
			sessionStartEvent: options.sessionStartEvent,
			model: DEFAULT_MODEL,
		});
		options.registerCandidateSession(created.session);
		return { ...created, services, diagnostics: services.diagnostics };
	};
	return createAgentSessionRuntime(factory, {
		cwd,
		agentDir: cwd,
		session: { mode: "memory", id: `product-entry-${directories.length}` },
	});
}

describe("External Connector product entry composition", () => {
	it("uses a Host-explicit composition as a whole instead of merging settings", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "aos-product-entry-host-"));
		directories.push(cwd);
		const hostComposition = createAgentRuntimeCompositionFactory();
		const services = await createServices(cwd, packagedSettings(cwd), hostComposition);

		expect(services.runtimeComposition).toBe(hostComposition);
	});

	it("derives an executable packaged registry through the standard RPC session entry", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "aos-product-entry-settings-"));
		directories.push(cwd);
		const runtime = await createRuntime(cwd, packagedSettings(cwd));
		const records: RpcHostOutputRecord[] = [];
		const controller = createRpcHostController(runtime, { output: { publish: (record) => records.push(record) } });
		await controller.start();
		try {
			const initialized = await controller.dispatch({ id: "entry-init", type: "initialize", protocolVersion: 1 });
			if (initialized === undefined || initialized.command !== "initialize" || !initialized.success) {
				throw new Error("Standard RPC entry did not initialize");
			}
			expect(initialized.data.externalConnectors).toHaveLength(1);
			const descriptor = initialized.data.externalConnectors?.[0];
			if (descriptor === undefined) throw new Error("Settings-derived Connector descriptor is missing");
			// wire/ledger field name; local alias below
			const capabilityDigest = descriptor.capabilitySnapshotDigest;
			const selection = {
				providerId: descriptor.providerId,
				revision: descriptor.revision,
				capabilitySnapshotDigest: capabilityDigest,
			};

			await controller.handleCommand({
				id: "entry-start",
				type: "run.start",
				message: "execute the packaged settings connector",
				externalConnector: selection,
			});
			await vi.waitFor(() =>
				expect(records).toContainEqual(
					expect.objectContaining({
						id: "entry-start",
						type: "response",
						command: "run.start",
						success: true,
					}),
				),
			);
			const started = records.find((record) => record.type === "response" && record.id === "entry-start");
			if (started?.type !== "response") throw new Error("Run did not return a response");
			if (started.command !== "run.start" || !started.success) throw new Error("Run was not accepted");

			const session = getAgentCanonicalSession(runtime.session);
			try {
				await vi.waitFor(
					() =>
						expect(
							records.some(
								(record) =>
									record.type === "run.completed" ||
									record.type === "run.failed" ||
									record.type === "run.cancelled",
							),
						).toBe(true),
					{ timeout: 60_000 },
				);
			} catch {
				throw new Error(`Packaged run did not settle: ${JSON.stringify(records)}`);
			}
			const terminal = records.find(
				(record) =>
					record.type === "run.completed" || record.type === "run.failed" || record.type === "run.cancelled",
			);
			if (terminal?.type !== "run.completed") throw new Error(`Packaged run failed: ${JSON.stringify(terminal)}`);
			const attemptReceipts = await session.findFoundationRecords({ objectType: "attempt_receipt" });
			const taskResults = await session.findFoundationRecords({ objectType: "task_result" });
			const runReceipts = await session.findFoundationRecords({ objectType: "run_receipt" });
			expect(attemptReceipts).toHaveLength(1);
			expect(attemptReceipts[0]).toMatchObject({
				payload: { providerId: "aos.fake-connector", status: "succeeded" },
			});
			expect(taskResults).toHaveLength(1);
			expect(runReceipts[0]).toMatchObject({ payload: { runId: started.data.runId, terminalStatus: "completed" } });
			expect(attemptReceipts[0]?.seq).toBeLessThan(taskResults[0]?.seq ?? 0);
			expect(taskResults[0]?.seq).toBeLessThan(runReceipts[0]?.seq ?? 0);
		} finally {
			await controller.shutdown();
		}
	}, 90_000);

	it("runs a non-packaged module target through settings, events, terminal, and receipt", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "aos-product-entry-generic-"));
		directories.push(cwd);
		const runtime = await createRuntime(cwd, genericSettings(cwd));
		const records: RpcHostOutputRecord[] = [];
		const controller = createRpcHostController(runtime, { output: { publish: (record) => records.push(record) } });
		await controller.start();
		try {
			const initialized = await controller.dispatch({ id: "generic-init", type: "initialize", protocolVersion: 1 });
			if (initialized === undefined || initialized.command !== "initialize" || !initialized.success) {
				throw new Error("Generic settings entry did not initialize");
			}
			expect(initialized.data.externalConnectors).toHaveLength(1);
			const descriptor = initialized.data.externalConnectors?.[0];
			if (descriptor === undefined) throw new Error("Generic settings connector descriptor is missing");
			const selection = {
				providerId: descriptor.providerId,
				revision: descriptor.revision,
				capabilitySnapshotDigest: descriptor.capabilitySnapshotDigest,
			};

			await controller.handleCommand({
				id: "generic-start",
				type: "run.start",
				message: "execute the generic settings connector",
				externalConnector: selection,
			});
			await vi.waitFor(() =>
				expect(records).toContainEqual(
					expect.objectContaining({
						id: "generic-start",
						type: "response",
						command: "run.start",
						success: true,
					}),
				),
			);
			const started = records.find((record) => record.type === "response" && record.id === "generic-start");
			if (started?.type !== "response" || started.command !== "run.start" || !started.success) {
				throw new Error("Generic run was not accepted");
			}

			await vi.waitFor(
				() =>
					expect(
						records.some(
							(record) =>
								record.type === "run.completed" ||
								record.type === "run.failed" ||
								record.type === "run.cancelled",
						),
					).toBe(true),
				{ timeout: 60_000 },
			);
			const terminal = records.find(
				(record) =>
					record.type === "run.completed" || record.type === "run.failed" || record.type === "run.cancelled",
			);
			expect(records.some((record) => record.type === "run.started")).toBe(true);
			expect(terminal?.type).toBe("run.completed");
			const session = getAgentCanonicalSession(runtime.session);
			const attemptReceipts = await session.findFoundationRecords({ objectType: "attempt_receipt" });
			const taskResults = await session.findFoundationRecords({ objectType: "task_result" });
			const runReceipts = await session.findFoundationRecords({ objectType: "run_receipt" });
			expect(attemptReceipts).toHaveLength(1);
			expect(attemptReceipts[0]).toMatchObject({
				payload: { providerId: "fixture.external-jsonl", status: "succeeded" },
			});
			expect(taskResults).toHaveLength(1);
			expect(runReceipts[0]).toMatchObject({
				payload: { runId: started.data.runId, terminalStatus: "completed" },
			});
			expect(attemptReceipts[0]?.seq).toBeLessThan(taskResults[0]?.seq ?? 0);
			expect(taskResults[0]?.seq).toBeLessThan(runReceipts[0]?.seq ?? 0);
		} finally {
			await controller.shutdown();
		}
	}, 90_000);

	it.each([
		{
			name: "wrong digest",
			overrides: { moduleIdentity: `sha256:${"0".repeat(64)}` },
			message: "trusted driver file identity does not match",
		},
		{
			name: "relative module path",
			overrides: { modulePath: "relative-driver.mjs" },
			message: "absolute path",
		},
		{
			name: "missing version",
			overrides: { version: undefined },
			message: "version is invalid",
		},
	])("rejects $name from settings before launch", async ({ overrides, message }) => {
		const cwd = mkdtempSync(join(tmpdir(), "aos-product-entry-provenance-"));
		directories.push(cwd);
		await expect(createServices(cwd, genericSettings(cwd, overrides))).rejects.toThrow(message);
	});

	it("keeps the empty fallback and unavailable error when settings omit connectors", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "aos-product-entry-empty-"));
		directories.push(cwd);
		const runtime = await createRuntime(cwd, SettingsManager.inMemory());
		expect(runtime.runtimeComposition.externalConnectorRegistry).toBeUndefined();
		const controller = createRpcHostController(runtime);
		await controller.start();
		try {
			await controller.dispatch({ id: "empty-init", type: "initialize", protocolVersion: 1 });
			const response = await controller.dispatch({
				id: "empty-start",
				type: "run.start",
				message: "connector remains default-off",
				externalConnector: {
					providerId: "missing.connector",
					revision: 1,
					capabilitySnapshotDigest: { algorithm: "sha256", value: "0".repeat(64) },
				},
			});
			expect(response).toMatchObject({ success: false, error: { code: "external_connector_unavailable" } });
		} finally {
			await controller.shutdown();
		}
	});
});
