import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ExternalConnectorTargetDefinition } from "../../src/core/connector/target-config.ts";
import type { PrivateExternalConnectorVendorDriver } from "../../src/core/connector/vendor/identity.ts";
import { InMemorySettingsStorage, SettingsManager } from "../../src/core/runtime/settings-manager.ts";

const directories: string[] = [];
const identity = `sha256:${"0".repeat(64)}`;

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function target(cwd: string, targetId: string, providerId: string): ExternalConnectorTargetDefinition {
	return {
		schemaVersion: 1,
		targetId,
		providerId,
		executablePath: process.execPath,
		modulePath: process.execPath,
		cwd,
		version: "1.0.0",
		executableIdentity: identity,
		moduleIdentity: identity,
		capabilityCeiling: {
			modelAccess: ["none", "agent_owned"],
			resume: true,
			toolGateway: true,
			artifacts: false,
			images: false,
		},
	};
}

function vendorTarget(
	cwd: string,
	driver: PrivateExternalConnectorVendorDriver,
): ExternalConnectorTargetDefinition {
	return {
		...target(cwd, driver, `external.${driver}`),
		driver,
		version: driver === "claude" ? "0.3.246" : driver === "codex" ? "0.149.0" : "1.4.0",
		capabilityCeiling: {
			...target(cwd, driver, `external.${driver}`).capabilityCeiling,
			resume: driver !== "claude",
		},
	};
}

function writeSettings(storage: InMemorySettingsStorage, scope: "global" | "project", value: unknown): void {
	storage.withLock(scope, () => JSON.stringify(value));
}

describe("External Connector settings", () => {
	it("parses an explicit vendor driver and preserves generic-target compatibility", () => {
		const cwd = mkdtempSync(join(tmpdir(), "aos-connector-driver-"));
		directories.push(cwd);
		const vendor = { ...target(cwd, "claude", "external.claude"), driver: "claude", version: "0.3.246" };
		vendor.capabilityCeiling = { ...vendor.capabilityCeiling, resume: false };
		const storage = new InMemorySettingsStorage();
		writeSettings(storage, "global", {
			externalConnectors: { schemaVersion: 1, targets: [vendor], targetId: "claude" },
		});
		expect(SettingsManager.fromStorage(storage).getExternalConnectorTargetSettings()?.selectedTarget).toMatchObject({
			driver: "claude",
			version: "0.3.246",
		});

		writeSettings(storage, "global", {
			externalConnectors: {
				schemaVersion: 1,
				targets: [target(cwd, "generic", "external.generic")],
				targetId: "generic",
			},
		});
		expect(SettingsManager.fromStorage(storage).getExternalConnectorTargetSettings()?.selectedTarget).not.toHaveProperty("driver");
	});

	it.each(["claude", "codex"] as const)("accepts %s aos_gateway while model routing stays separate", (driver) => {
		const cwd = mkdtempSync(join(tmpdir(), `aos-connector-${driver}-gateway-`));
		directories.push(cwd);
		const storage = new InMemorySettingsStorage();
		const vendor = {
			...target(cwd, driver, `external.${driver}`),
			driver,
			version: driver === "claude" ? "0.3.246" : "0.149.0",
			accountReference: { schemaVersion: 1, namespace: "aos", accountId: "model-runtime" },
			capabilityCeiling: {
				...target(cwd, driver, `external.${driver}`).capabilityCeiling,
				modelAccess: ["aos_gateway"],
				resume: driver !== "claude",
			},
		};
		writeSettings(storage, "global", {
			externalConnectors: { schemaVersion: 1, targets: [vendor], targetId: driver },
		});
		expect(SettingsManager.fromStorage(storage).getExternalConnectorTargetSettings()?.selectedTarget).toMatchObject({
			driver,
			capabilityCeiling: { modelAccess: ["aos_gateway"] },
		});
	});

	it("rejects a remote endpoint for a vendor aos_gateway target", () => {
		const cwd = mkdtempSync(join(tmpdir(), "aos-connector-gateway-endpoint-"));
		directories.push(cwd);
		const storage = new InMemorySettingsStorage();
		const vendor = {
			...target(cwd, "codex-gateway", "external.codex"),
			driver: "codex",
			version: "0.149.0",
			endpoint: "https://gateway.example.test/",
			accountReference: { schemaVersion: 1, namespace: "aos", accountId: "model-runtime" },
			capabilityCeiling: {
				...target(cwd, "codex-gateway", "external.codex").capabilityCeiling,
				modelAccess: ["aos_gateway"],
			},
		};
		writeSettings(storage, "global", {
			externalConnectors: { schemaVersion: 1, targets: [vendor], targetId: vendor.targetId },
		});
		expect(() => SettingsManager.fromStorage(storage).getExternalConnectorTargetSettings()).toThrow(
			expect.objectContaining({ reason: "capability_widened", path: "$.global.targets[0].endpoint" }),
		);
	});

	it.each([
		{
			name: "unknown driver",
			mutate: (value: Record<string, unknown>) => ({ ...value, driver: "generic" }),
			reason: "invalid_shape",
			path: "$.global.targets[0].driver",
		},
		{
			name: "missing executable identity",
			mutate: (value: Record<string, unknown>) => {
				const { executableIdentity: _executableIdentity, ...rest } = value;
				return rest;
			},
			reason: "invalid_shape",
			path: "$.global.targets[0].executableIdentity",
		},
		{
			name: "wrong pinned version",
			mutate: (value: Record<string, unknown>) => ({ ...value, version: "0.3.245" }),
			reason: "driver_mismatch",
			path: "$.global.targets[0].version",
		},
		{
			name: "Claude resume widening",
			mutate: (value: Record<string, unknown>) => ({
				...value,
				capabilityCeiling: { ...(value.capabilityCeiling as Record<string, unknown>), resume: true },
			}),
			reason: "capability_widened",
			path: "$.global.targets[0].capabilityCeiling",
		},
	])("rejects vendor $name", ({ mutate, reason, path }) => {
		const cwd = mkdtempSync(join(tmpdir(), "aos-connector-driver-invalid-"));
		directories.push(cwd);
		const base = {
			...target(cwd, "claude", "external.claude"),
			driver: "claude",
			version: "0.3.246",
			capabilityCeiling: {
				...target(cwd, "claude", "external.claude").capabilityCeiling,
				resume: false,
			},
		};
		const storage = new InMemorySettingsStorage();
		writeSettings(storage, "global", {
			externalConnectors: { schemaVersion: 1, targets: [mutate(base)], targetId: "claude" },
		});
		expect(() => SettingsManager.fromStorage(storage).getExternalConnectorTargetSettings()).toThrow(
			expect.objectContaining({ reason, path }),
		);
	});

	it("resolves a global catalog through trusted project and Role narrowing", () => {
		const cwd = mkdtempSync(join(tmpdir(), "aos-connector-settings-"));
		directories.push(cwd);
		const storage = new InMemorySettingsStorage();
		writeSettings(storage, "global", {
			externalConnectors: {
				schemaVersion: 1,
				targets: [target(cwd, "local-agent", "external.local")],
				targetId: "local-agent",
			},
		});
		writeSettings(storage, "project", {
			externalConnectors: {
				schemaVersion: 1,
				targetId: "local-agent",
				capabilityCeiling: { toolGateway: false },
				role: {
					schemaVersion: 1,
					targetId: "local-agent",
					capabilityCeiling: { modelAccess: ["none"] },
				},
			},
		});

		const settings = SettingsManager.fromStorage(storage, {
			projectTrusted: true,
		}).getExternalConnectorTargetSettings();

		expect(settings?.selectedTarget).toMatchObject({
			targetId: "local-agent",
			providerId: "external.local",
			selectionSources: ["explicit", "project", "role"],
			capabilityCeiling: { modelAccess: ["none"], toolGateway: false },
		});
	});

	it.each([
		{ driver: "claude", source: "project", capability: "toolGateway" },
		{ driver: "claude", source: "role", capability: "toolGateway" },
		{ driver: "codex", source: "project", capability: "resume" },
		{ driver: "codex", source: "role", capability: "resume" },
		{ driver: "codex", source: "project", capability: "toolGateway" },
		{ driver: "codex", source: "role", capability: "toolGateway" },
		{ driver: "acp", source: "project", capability: "resume" },
		{ driver: "acp", source: "role", capability: "resume" },
		{ driver: "acp", source: "project", capability: "toolGateway" },
		{ driver: "acp", source: "role", capability: "toolGateway" },
	] as const)(
		"rejects $source $driver narrowing of protocol-required $capability at its settings path",
		({ driver, source, capability }) => {
			const cwd = mkdtempSync(join(tmpdir(), `aos-connector-${driver}-${source}-${capability}-`));
			directories.push(cwd);
			const selected = vendorTarget(cwd, driver);
			const storage = new InMemorySettingsStorage();
			writeSettings(storage, "global", {
				externalConnectors: { schemaVersion: 1, targets: [selected], targetId: selected.targetId },
			});
			writeSettings(storage, "project", {
				externalConnectors: {
					schemaVersion: 1,
					targetId: selected.targetId,
					...(source === "project"
						? { capabilityCeiling: { [capability]: false } }
						: {
							role: {
								schemaVersion: 1,
								targetId: selected.targetId,
								capabilityCeiling: { [capability]: false },
							},
						}),
				},
			});

			expect(() =>
				SettingsManager.fromStorage(storage, { projectTrusted: true }).getExternalConnectorTargetSettings(),
			).toThrow(expect.objectContaining({
				reason: "capability_widened",
				path: `$.${source}.capabilityCeiling.${capability}`,
			}));
		},
	);

	it("rejects aos_gateway in an unselected generic catalog target", () => {
		const cwd = mkdtempSync(join(tmpdir(), "aos-connector-unselected-gateway-"));
		directories.push(cwd);
		const unsafe = target(cwd, "unsafe", "external.unsafe");
		const storage = new InMemorySettingsStorage();
		writeSettings(storage, "global", {
			externalConnectors: {
				schemaVersion: 1,
				targets: [
					target(cwd, "selected-safe", "external.safe"),
					{
						...unsafe,
						capabilityCeiling: { ...unsafe.capabilityCeiling, modelAccess: ["aos_gateway"] },
					},
				],
				targetId: "selected-safe",
			},
		});

		expect(() => SettingsManager.fromStorage(storage).getExternalConnectorTargetSettings()).toThrow(
			expect.objectContaining({
				reason: "capability_widened",
				path: "$.global.targets[1].capabilityCeiling.modelAccess",
			}),
		);
	});

	it("rejects aos_gateway before trusted project or Role narrowing", () => {
		const cwd = mkdtempSync(join(tmpdir(), "aos-connector-narrowed-gateway-"));
		directories.push(cwd);
		const unsafe = target(cwd, "narrowed", "external.narrowed");
		const storage = new InMemorySettingsStorage();
		writeSettings(storage, "global", {
			externalConnectors: {
				schemaVersion: 1,
				targets: [{
					...unsafe,
					capabilityCeiling: {
						...unsafe.capabilityCeiling,
						modelAccess: ["none", "aos_gateway"],
					},
				}],
				targetId: "narrowed",
			},
		});
		writeSettings(storage, "project", {
			externalConnectors: {
				schemaVersion: 1,
				targetId: "narrowed",
				capabilityCeiling: { modelAccess: ["none"] },
				role: {
					schemaVersion: 1,
					targetId: "narrowed",
					capabilityCeiling: { modelAccess: ["none"] },
				},
			},
		});

		expect(() =>
			SettingsManager.fromStorage(storage, { projectTrusted: true }).getExternalConnectorTargetSettings(),
		).toThrow(expect.objectContaining({
			reason: "capability_widened",
			path: "$.global.targets[0].capabilityCeiling.modelAccess",
		}));
	});

	it("rejects project selection when the existing project trust decision is false", () => {
		const cwd = mkdtempSync(join(tmpdir(), "aos-connector-project-trust-"));
		directories.push(cwd);
		const storage = new InMemorySettingsStorage();
		writeSettings(storage, "global", {
			externalConnectors: {
				schemaVersion: 1,
				targets: [target(cwd, "local-agent", "external.local")],
			},
		});
		writeSettings(storage, "project", {
			externalConnectors: { schemaVersion: 1, targetId: "local-agent" },
		});

		const manager = SettingsManager.fromStorage(storage, { projectTrusted: false });
		expect(() => manager.getExternalConnectorTargetSettings()).toThrow(
			expect.objectContaining({ reason: "untrusted_source", path: "$.project" }),
		);
		manager.setProjectTrusted(true);
		expect(manager.getExternalConnectorTargetSettings()?.selectedTarget?.targetId).toBe("local-agent");
	});

	it("rejects Role narrowing when the existing project trust decision is false", () => {
		const cwd = mkdtempSync(join(tmpdir(), "aos-connector-role-trust-"));
		directories.push(cwd);
		const storage = new InMemorySettingsStorage();
		writeSettings(storage, "global", {
			externalConnectors: {
				schemaVersion: 1,
				targets: [target(cwd, "local-agent", "external.local")],
			},
		});
		writeSettings(storage, "project", {
			externalConnectors: {
				schemaVersion: 1,
				role: { schemaVersion: 1, targetId: "local-agent" },
			},
		});

		expect(() =>
			SettingsManager.fromStorage(storage, { projectTrusted: false }).getExternalConnectorTargetSettings(),
		).toThrow(expect.objectContaining({ reason: "untrusted_source", path: "$.role" }));
	});

	it("reloads the selected target from storage", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "aos-connector-reload-"));
		directories.push(cwd);
		const storage = new InMemorySettingsStorage();
		const targets = [target(cwd, "first", "external.first"), target(cwd, "second", "external.second")];
		writeSettings(storage, "global", {
			externalConnectors: { schemaVersion: 1, targets, targetId: "first" },
		});
		const manager = SettingsManager.fromStorage(storage);
		expect(manager.getExternalConnectorTargetSettings()?.selectedTarget?.targetId).toBe("first");

		writeSettings(storage, "global", {
			externalConnectors: { schemaVersion: 1, targets, targetId: "second" },
		});
		await manager.reload();

		expect(manager.getExternalConnectorTargetSettings()?.selectedTarget?.targetId).toBe("second");
	});

	it("keeps the target configuration absent when settings omit it", () => {
		expect(SettingsManager.inMemory().getExternalConnectorTargetSettings()).toBeUndefined();
	});

	it("rejects unsupported settings schema versions before selection", () => {
		const storage = new InMemorySettingsStorage();
		writeSettings(storage, "project", { externalConnectors: { schemaVersion: 2 } });
		expect(() =>
			SettingsManager.fromStorage(storage, { projectTrusted: true }).getExternalConnectorTargetSettings(),
		).toThrow("$.project.externalConnectors.schemaVersion must be 1");
	});
});
