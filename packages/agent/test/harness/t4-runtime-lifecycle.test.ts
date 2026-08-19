import { describe, expect, it } from "vitest";
import {
	EffectScope,
	LifecycleExtensionRegistrar,
	RuntimeToolRegistryV1,
	RuntimeServiceRegistry,
	orderRuntimeHooksV1,
	validateRuntimeServiceDAGV1,
} from "../../src/harness/runtime-services.ts";
import {
	LocalPluginRegistry,
	InMemoryLocalPluginRegistryStorageV1,
	createPluginContractV1,
	pluginContentsDigestV1,
	validateLocalPluginPackageV1,
} from "../../src/harness/plugins.ts";
import { applyProfilePatchV1, composeProfileBundleV1, resolveChildExecutorMcpSelectorsV1, selectResourcesV1 } from "../../src/harness/profile.ts";
import { Result } from "../../src/harness/result.ts";
import { Type } from "typebox";
import { validateProfileContractV1, type LspExtensionContractV1, type MonitorExtensionContractV1 } from "../../src/harness/foundation/profile.ts";
import type { ResourceSelectorV1 } from "../../src/harness/foundation/reference.ts";

const lsp: LspExtensionContractV1 = {
	schemaVersion: 1,
	extensionId: "typescript",
	kind: "lsp",
	version: "1.0.0",
	languageIds: ["typescript"],
	serverCommand: "tsserver",
};

const monitor: MonitorExtensionContractV1 = {
	schemaVersion: 1,
	extensionId: "health",
	kind: "monitor",
	version: "1.0.0",
	eventKinds: ["tool"],
	intervalMs: 1000,
	healthCheck: "local",
};

function pluginPackage(version = "1.0.0") {
	const manifest = { name: "local-plugin", version, entrypoint: "./index.js", declaredCapabilities: ["hooks"] };
	const contents = { lsp: [lsp], monitors: [monitor] };
	return {
		schemaVersion: 1 as const,
		contract: createPluginContractV1({
			namespace: "local",
			pluginId: "local-plugin",
			version,
			manifest,
			signature: "local-signature",
		}),
		contents,
		source: "local" as const,
		sourcePath: "C:/workspace/local-plugin",
		signatureMetadata: { algorithm: "test", keyId: "key", value: "signature", contentDigest: pluginContentsDigestV1(contents) },
	};
}

describe("T4 runtime service and extension lifecycle", () => {
	it("topologically orders the runtime service DAG and rejects missing/cyclic dependencies", () => {
		const valid = validateRuntimeServiceDAGV1([
			{ serviceId: "tool", version: "1", providerId: "host", dependencies: [{ serviceId: "sandbox", version: "2" }] },
			{ serviceId: "sandbox", version: "2", providerId: "host" },
		]);
		expect(valid).toMatchObject({ ok: true, value: { order: ["sandbox", "tool"] } });
		if (valid.ok) expect(valid.value.services[1]?.dependencies).toEqual([{ serviceId: "sandbox", version: "2" }]);
		expect(validateRuntimeServiceDAGV1([{ serviceId: "tool", version: "1", providerId: "host", dependencies: ["missing"] }])).toMatchObject({ ok: false });
		expect(validateRuntimeServiceDAGV1([
			{ serviceId: "a", version: "1", providerId: "host", dependencies: ["b"] },
			{ serviceId: "b", version: "1", providerId: "host", dependencies: ["a"] },
		])).toMatchObject({ ok: false });

		const registry = new RuntimeServiceRegistry();
		expect(registry.register({ serviceId: "tool", version: "1", providerId: "host" }).ok).toBe(true);
		expect(registry.register({ serviceId: "tool", version: "2", providerId: "host" })).toMatchObject({ ok: false });
	});

	it("orders hooks deterministically and disposes effect scopes in reverse order", async () => {
		const hooks = orderRuntimeHooksV1([
			{ hookId: "after", phase: "after", priority: -100, conflict: "error" },
			{ hookId: "before", phase: "before", priority: 20, conflict: "error" },
		]);
		expect(hooks).toMatchObject({ ok: true, value: { order: ["before", "after"] } });

		const disposed: string[] = [];
		const scope = new EffectScope();
		scope.register("hook", "first", () => { disposed.push("first"); });
		scope.register("tool", "second", () => { disposed.push("second"); });
		const report = await scope.dispose();
		expect(report.disposed).toEqual(["second", "first"]);
		expect(disposed).toEqual(["second", "first"]);
		expect(scope.register("hook", "late", () => undefined)).toMatchObject({ ok: false });

		const dynamic = new RuntimeToolRegistryV1();
		const definition = { name: "dynamic", toolRevision: { schemaVersion: 1 as const, type: "tool_revision" as const, id: "dynamic", revision: 1 }, capabilities: [], parameters: Type.Object({}, { additionalProperties: false }), execute: async () => ({ ok: true, sideEffectState: "none" as const }) };
		expect(dynamic.register({ tool: definition, providerId: "p1", version: "1", revision: 1 }).ok).toBe(true);
		expect(dynamic.register({ tool: { ...definition, toolRevision: { ...definition.toolRevision, revision: 2 } }, providerId: "p2", version: "2", revision: 2 })).toMatchObject({ ok: false });
		expect(dynamic.register({ tool: { ...definition, toolRevision: { ...definition.toolRevision, revision: 2 } }, providerId: "p2", version: "2", revision: 2, overrideOf: { providerId: "p1", version: "1", revision: 1 } }).ok).toBe(true);
	});

	it("runs local LSP and monitor lifecycle through an effect scope without starting a worker", async () => {
		const stopped: string[] = [];
		const scope = new EffectScope();
		const registrar = new LifecycleExtensionRegistrar(scope, {
			startLsp: async (contract) => Result.ok({ schemaVersion: 1, extensionId: contract.extensionId, state: "active", languageIds: [...contract.languageIds], startedAt: "now" }),
			stopLsp: async (extensionId) => { stopped.push(`lsp:${extensionId}`); return Result.ok({ schemaVersion: 1, extensionId, state: "inactive", languageIds: ["typescript"], startedAt: "now" }); },
			startMonitor: async (contract) => Result.ok({ schemaVersion: 1, extensionId: contract.extensionId, state: "running", eventKinds: [...contract.eventKinds], intervalMs: contract.intervalMs, startedAt: "now" }),
			stopMonitor: async (extensionId) => { stopped.push(`monitor:${extensionId}`); return Result.ok({ schemaVersion: 1, extensionId, state: "inactive", eventKinds: ["tool"], intervalMs: 1000, startedAt: "now" }); },
		});

		expect((await registrar.startLsp(lsp)).ok).toBe(true);
		expect((await registrar.startMonitor(monitor)).ok).toBe(true);
		expect(scope.size).toBe(2);
		await scope.dispose();
		expect(stopped).toEqual(["monitor:health", "lsp:typescript"]);

		const rollbackScope = new EffectScope();
		rollbackScope.register("lsp", "lsp:typescript", () => undefined);
		let rolledBackStart = 0;
		let rolledBackStop = 0;
		const duplicateRegistrar = new LifecycleExtensionRegistrar(rollbackScope, {
			startLsp: async (contract) => { rolledBackStart += 1; return Result.ok({ schemaVersion: 1, extensionId: contract.extensionId, state: "active", languageIds: [...contract.languageIds], startedAt: "now" }); },
			stopLsp: async (extensionId) => { rolledBackStop += 1; return Result.ok({ schemaVersion: 1, extensionId, state: "inactive", languageIds: ["typescript"], startedAt: "now" }); },
		});
		expect(await duplicateRegistrar.startLsp(lsp)).toMatchObject({ ok: false });
		expect({ rolledBackStart, rolledBackStop }).toEqual({ rolledBackStart: 1, rolledBackStop: 1 });
	});

	it("tightens MCP selectors and keeps plugin lifecycle local with rollback", async () => {
		expect(selectResourcesV1({ policy: "except", named: ["blocked"] }, ["allowed", "blocked"])).toEqual(["allowed"]);
		expect(resolveChildExecutorMcpSelectorsV1({ policy: "named", named: ["allowed"] }, { policy: "all" })).toMatchObject({ ok: false });
		const packageWithSelectors = (packageSelector: ResourceSelectorV1 | undefined, agentSelector: ResourceSelectorV1 | undefined) => {
			const base = pluginPackage();
			return {
				...base,
				...(packageSelector === undefined ? {} : { mcpSelector: packageSelector }),
				contents: { ...base.contents, agents: [{ agentId: "child-agent", ...(agentSelector === undefined ? {} : { mcpSelector: agentSelector }) }] },
			};
		};
		for (const parent of [{ policy: "none" }, { policy: "named", named: ["allowed"] }] as const) {
			expect(validateLocalPluginPackageV1(packageWithSelectors({ policy: "all" }, undefined), parent)).toMatchObject({ ok: false, error: { code: "role_resolver_scope_widened" } });
			expect(validateLocalPluginPackageV1(packageWithSelectors(undefined, { policy: "all" }), parent)).toMatchObject({ ok: false, error: { code: "role_resolver_scope_widened" } });
		}
		expect(validateLocalPluginPackageV1(packageWithSelectors({ policy: "named", named: ["allowed"] }, { policy: "named", named: ["allowed"] }), { policy: "all" })).toMatchObject({ ok: true });
		expect(validateLocalPluginPackageV1(packageWithSelectors({ policy: "named", named: ["allowed"] }, { policy: "none" }), { policy: "named", named: ["allowed", "other"] })).toMatchObject({ ok: true });

		let disposed = 0;
		const pkg = pluginPackage();
		const registry = new LocalPluginRegistry({
			now: () => "now",
			onActivate: async (_pkg, context) => {
				context.register("listener", "listener-1", () => { disposed += 1; });
			},
		});
		expect(await registry.install(pkg)).toMatchObject({ ok: true, value: { operation: "install", applied: true } });
		expect(registry.has("local-plugin")).toBe(true);
		expect(await registry.uninstall("local-plugin")).toMatchObject({ ok: true, value: { operation: "uninstall" } });
		expect(disposed).toBe(1);
		expect(await registry.rollback("local-plugin")).toMatchObject({ ok: true, value: { operation: "rollback" } });
		expect(registry.has("local-plugin")).toBe(true);

		let rolledBack = 0;
		const failing = new LocalPluginRegistry({
			onActivate: async (_pkg, context) => {
				context.register("listener", "listener-2", () => { rolledBack += 1; });
				throw new Error("activation failed");
			},
		});
		expect(await failing.install(pkg)).toMatchObject({ ok: false });
		expect(failing.has("local-plugin")).toBe(false);
		expect(rolledBack).toBe(1);

		const signed = pluginPackage();
		const signedPackage = { ...signed, signatureMetadata: { algorithm: "test", keyId: "key", value: "signature", contentDigest: pluginContentsDigestV1(signed.contents) } };
		const mutated = { ...signedPackage, contents: { ...signedPackage.contents, lsp: [] } };
		expect(await new LocalPluginRegistry().install({ ...signedPackage, signatureMetadata: undefined })).toMatchObject({ ok: false });
		const signedRegistry = new LocalPluginRegistry();
		expect(await signedRegistry.install(mutated)).toMatchObject({ ok: false });

		const cleanupRegistry = new LocalPluginRegistry({ onActivate: async (_pkg, context) => { context.register("listener", "cleanup-fails", () => { throw new Error("cleanup failed"); }); } });
		expect(await cleanupRegistry.install(pkg)).toMatchObject({ ok: true });
		expect(await cleanupRegistry.uninstall(pkg.contract.pluginId)).toMatchObject({ ok: false, error: { code: "plugin_rollback_failed" } });
		expect(cleanupRegistry.has(pkg.contract.pluginId)).toBe(true);

		let cleanupAttempts = 0;
		const recoverableCleanup = new LocalPluginRegistry({
			onActivate: async (_pkg, context) => {
				context.register("listener", "recoverable-cleanup", () => {
					cleanupAttempts += 1;
					if (cleanupAttempts === 1) throw new Error("cleanup failed once");
				});
			},
		});
		expect(await recoverableCleanup.install(pkg)).toMatchObject({ ok: true });
		expect(await recoverableCleanup.uninstall(pkg.contract.pluginId)).toMatchObject({ ok: false, error: { code: "plugin_rollback_failed" } });
		expect(recoverableCleanup.has(pkg.contract.pluginId)).toBe(true);
		expect(await recoverableCleanup.uninstall(pkg.contract.pluginId)).toMatchObject({ ok: true, value: { operation: "uninstall" } });
		expect(cleanupAttempts).toBe(2);

		let updateCleanupAttempts = 0;
		const updateRegistry = new LocalPluginRegistry({
			onActivate: async (_pkg, context) => {
				context.register("listener", "update-cleanup", () => {
					updateCleanupAttempts += 1;
					if (updateCleanupAttempts === 1) throw new Error("update cleanup failed once");
				});
			},
		});
		expect(await updateRegistry.install(pkg)).toMatchObject({ ok: true });
		expect(await updateRegistry.update(pluginPackage("2.0.0"))).toMatchObject({ ok: false, error: { code: "plugin_rollback_failed" } });
		expect(updateRegistry.has(pkg.contract.pluginId)).toBe(true);
		expect(updateRegistry.revision(pkg.contract.pluginId)).toBe(1);
		expect(await updateRegistry.uninstall(pkg.contract.pluginId)).toMatchObject({ ok: true, value: { operation: "uninstall" } });
		expect(updateCleanupAttempts).toBe(3);

		const profile = { schemaVersion: 1 as const, profileId: "profile", revision: 1, kind: "execution" as const, values: { mode: "safe", timeout: 10 }, managedKeys: ["mode"], createdAt: "now" };
		expect(validateProfileContractV1({ ...profile, managedKeys: [] }).ok).toBe(false);
		const emptyManagedKeysProfile = { ...profile, profileId: "empty-managed-profile", managedKeys: [] };
		expect(applyProfilePatchV1(emptyManagedKeysProfile, { schemaVersion: 1, patchId: "empty-managed-keys", targetProfileId: emptyManagedKeysProfile.profileId, revision: 2, source: "project", values: { timeout: 20 } })).toMatchObject({ ok: false, error: { code: "profile_conflict" } });
		expect(applyProfilePatchV1({ ...profile, profileId: "invalid-managed-profile", managedKeys: [""] }, { schemaVersion: 1, patchId: "invalid-managed-keys", targetProfileId: "invalid-managed-profile", revision: 2, source: "project", values: { timeout: 20 } })).toMatchObject({ ok: false, error: { code: "profile_conflict" } });
		const omittedManagedKeys = { schemaVersion: 1 as const, patchId: "managed-unset", targetProfileId: "profile", revision: 2, source: "project", unset: ["mode"] };
		expect(applyProfilePatchV1(profile, omittedManagedKeys)).toMatchObject({ ok: false, error: { code: "profile_conflict" } });
		expect(applyProfilePatchV1(profile, { ...omittedManagedKeys, patchId: "managed-replace", unset: undefined, values: { mode: "fast" } })).toMatchObject({ ok: false, error: { code: "profile_conflict" } });
		expect(applyProfilePatchV1(profile, { ...omittedManagedKeys, patchId: "forged-managed-keys", unset: undefined, values: { mode: "fast" }, managedKeys: [] } as never)).toMatchObject({ ok: false, error: { code: "profile_conflict" } });
		expect(applyProfilePatchV1(profile, { ...omittedManagedKeys, patchId: "forged-managed-key-name", unset: undefined, values: { mode: "fast" }, managedKeys: ["timeout"] } as never)).toMatchObject({ ok: false, error: { code: "profile_conflict" } });
		expect(composeProfileBundleV1({ schemaVersion: 1, bundleId: "managed-unset-bundle", revision: 1, source: "global", profiles: [profile], patches: [omittedManagedKeys] })).toMatchObject({ ok: true, value: { conflicts: [{ field: "mode", reason: "managed_lock" }], profiles: [{ values: { mode: "safe", timeout: 10 } }] } });
		expect(composeProfileBundleV1({ schemaVersion: 1, bundleId: "managed-replace-bundle", revision: 1, source: "global", profiles: [profile], patches: [{ ...omittedManagedKeys, patchId: "managed-replace", unset: undefined, values: { mode: "fast" } }] })).toMatchObject({ ok: true, value: { conflicts: [{ field: "mode", reason: "managed_lock" }], profiles: [{ values: { mode: "safe", timeout: 10 } }] } });
		expect(composeProfileBundleV1({ schemaVersion: 1, bundleId: "forged-managed-bundle", revision: 1, source: "global", profiles: [profile], patches: [{ ...omittedManagedKeys, patchId: "forged-managed", unset: undefined, values: { mode: "fast" }, managedKeys: [] } as never] })).toMatchObject({ ok: true, value: { conflicts: [{ field: "mode", reason: "managed_lock" }], profiles: [{ values: { mode: "safe", timeout: 10 } }] } });
		expect(composeProfileBundleV1({ schemaVersion: 1, bundleId: "bundle", revision: 1, source: "global", profiles: [profile], patches: [{ schemaVersion: 1, patchId: "patch", targetProfileId: "profile", revision: 2, source: "project", values: { timeout: 20 } }] })).toMatchObject({ ok: true, value: { profiles: [{ values: { mode: "safe", timeout: 20 }, managedKeys: ["mode"] }] } });
	});

	it("persists an atomic activation pointer, recovers after restart, and cleans failed staging", async () => {
		const storage = new InMemoryLocalPluginRegistryStorageV1();
		const pkg = pluginPackage();
		const registry = new LocalPluginRegistry({ storage, now: () => "now" });
		expect(await registry.install(pkg)).toMatchObject({ ok: true });
		expect(storage.snapshot.active).toHaveLength(1);
		expect(storage.snapshot.staged).toHaveLength(0);
		expect(storage.snapshot.pointers).toMatchObject([{ pluginId: "local-plugin", state: "active" }]);

		const restarted = await LocalPluginRegistry.open({ storage, now: () => "restart" });
		expect(restarted).toMatchObject({ ok: true });
		if (!restarted.ok) return;
		expect(restarted.value.active("local-plugin")).toMatchObject({ revision: 1, pluginId: "local-plugin" });
		expect(await restarted.value.uninstall("local-plugin")).toMatchObject({ ok: true });
		expect(storage.snapshot.active).toHaveLength(0);
		expect(storage.snapshot.previous).toHaveLength(1);
		expect(storage.snapshot.pointers).toMatchObject([{ pluginId: "local-plugin", state: "uninstalled" }]);

		const failingStorage = new InMemoryLocalPluginRegistryStorageV1();
		const failing = new LocalPluginRegistry({ storage: failingStorage, onActivate: async () => { throw new Error("activation failed"); } });
		expect(await failing.install(pkg)).toMatchObject({ ok: false, error: { code: "plugin_rollback_failed" } });
		expect(failingStorage.snapshot.active).toHaveLength(0);
		expect(failingStorage.snapshot.staged).toHaveLength(0);
	});
});
