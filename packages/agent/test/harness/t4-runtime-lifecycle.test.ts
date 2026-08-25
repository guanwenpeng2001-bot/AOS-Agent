import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	EffectScope,
	LifecycleExtensionRegistrar,
	RuntimeToolRegistry,
	RuntimeServiceRegistry,
	orderRuntimeHooks,
	validateRuntimeServiceDAG,
} from "../../src/harness/runtime-services.ts";
import {
	LocalPluginRegistry,
	LocalFilePluginRegistryStorage,
	InMemoryLocalPluginRegistryStorage,
	createPluginContract,
	pluginContentsDigest,
	type LocalPluginRegistryFileSystem,
	type LocalPluginRegistryStorage,
	type LocalPluginRegistrySnapshot,
	type LocalPluginPackage,
	type PluginActivationContext,
	validateLocalPluginPackage,
} from "../../src/harness/plugins.ts";
import { FoundationError } from "../../src/harness/foundation/errors.ts";
import { NodeExecutionEnv } from "../../src/harness/env/nodejs.ts";
import { applyProfilePatch, composeProfileBundle, resolveChildExecutorMcpSelectors, selectResources } from "../../src/harness/profile.ts";
import { Result, type Result as ResultValue } from "../../src/harness/result.ts";
import { FileError } from "../../src/harness/types.ts";
import { Type } from "typebox";
import { validateProfileContract, type LspExtensionContract, type MonitorExtensionContract } from "../../src/harness/foundation/profile.ts";
import type { ResourceSelector } from "../../src/harness/foundation/reference.ts";

const lsp: LspExtensionContract = {
	schemaVersion: 1,
	extensionId: "typescript",
	kind: "lsp",
	version: "1.0.0",
	languageIds: ["typescript"],
	serverCommand: "tsserver",
};

const monitor: MonitorExtensionContract = {
	schemaVersion: 1,
	extensionId: "health",
	kind: "monitor",
	version: "1.0.0",
	eventKinds: ["tool"],
	intervalMs: 1000,
	healthCheck: "local",
};

function pluginPackage(version = "1.0.0", pluginId = "local-plugin", namespace = "local") {
	const manifest = { name: pluginId, version, entrypoint: "./index.js", declaredCapabilities: ["hooks"] };
	const contents = { lsp: [lsp], monitors: [monitor] };
	return {
		schemaVersion: 1 as const,
		contract: createPluginContract({
			namespace,
			pluginId,
			version,
			manifest,
			signature: "local-signature",
		}),
		contents,
		source: "local" as const,
		sourcePath: "C:/workspace/local-plugin",
		signatureMetadata: { algorithm: "test", keyId: "key", value: "signature", contentDigest: pluginContentsDigest(contents) },
	};
}

type FaultOperation = "createExclusive" | "syncFile" | "renameFile" | "syncDirectory";
type FaultTarget = "snapshot" | "pointer";
interface FaultRule {
	operation: FaultOperation;
	target: FaultTarget;
	failureCalls?: readonly number[];
}

function faultInjectingFileSystem(base: NodeExecutionEnv, operation: FaultOperation | FaultRule | readonly FaultRule[], target?: FaultTarget, failureCalls: readonly number[] = [1]): LocalPluginRegistryFileSystem {
	const rules: readonly FaultRule[] = typeof operation === "string" ? [{ operation, target: target!, failureCalls }] : Array.isArray(operation) ? operation : [operation];
	const matchingCalls = new Map<string, number>();
	const matchesTarget = (path: string, faultTarget: FaultTarget, faultOperation: FaultOperation): boolean => {
		const normalized = path.replaceAll("\\", "/");
		const isSnapshotPath = normalized.includes("/snapshots") || normalized.endsWith("/snapshots");
		if (faultTarget === "snapshot") return isSnapshotPath;
		return faultOperation === "syncDirectory" ? !isSnapshotPath : normalized.includes("activation-pointer.json");
	};
	const shouldFail = (faultOperation: FaultOperation, path: string): boolean => {
		for (const rule of rules) {
			if (rule.operation !== faultOperation || !matchesTarget(path, rule.target, faultOperation)) continue;
			const key = `${rule.operation}:${rule.target}`;
			const call = (matchingCalls.get(key) ?? 0) + 1;
			matchingCalls.set(key, call);
			return (rule.failureCalls ?? [1]).includes(call);
		}
		return false;
	};
	const injectedError = (faultOperation: FaultOperation, path: string): ResultValue<never, FileError> => Result.err(new FileError("unknown", `injected ${faultOperation} failure`, path));
	return {
		joinPath: (parts) => base.joinPath(parts),
		readTextFile: (path) => base.readTextFile(path),
		renameFile: async (sourcePath, destinationPath) => shouldFail("renameFile", sourcePath) || shouldFail("renameFile", destinationPath) ? injectedError("renameFile", destinationPath) : base.renameFile(sourcePath, destinationPath),
		createDir: (path, options) => base.createDir(path, options),
		remove: (path, options) => base.remove(path, options),
		exists: (path) => base.exists(path),
		createExclusive: async (path, content) => shouldFail("createExclusive", path) ? injectedError("createExclusive", path) : base.createExclusive(path, content),
		syncFile: async (path) => shouldFail("syncFile", path) ? injectedError("syncFile", path) : base.syncFile(path),
		syncDirectory: async (path) => shouldFail("syncDirectory", path) ? injectedError("syncDirectory", path) : base.syncDirectory(path),
	};
}

describe("T4 runtime service and extension lifecycle", () => {
	it("topologically orders the runtime service DAG and rejects missing/cyclic dependencies", () => {
		const valid = validateRuntimeServiceDAG([
			{ serviceId: "tool", version: "1", providerId: "host", dependencies: [{ serviceId: "sandbox", version: "2" }] },
			{ serviceId: "sandbox", version: "2", providerId: "host" },
		]);
		expect(valid).toMatchObject({ ok: true, value: { order: ["sandbox", "tool"] } });
		if (valid.ok) expect(valid.value.services[1]?.dependencies).toEqual([{ serviceId: "sandbox", version: "2" }]);
		expect(validateRuntimeServiceDAG([{ serviceId: "tool", version: "1", providerId: "host", dependencies: ["missing"] }])).toMatchObject({ ok: false });
		expect(validateRuntimeServiceDAG([
			{ serviceId: "a", version: "1", providerId: "host", dependencies: ["b"] },
			{ serviceId: "b", version: "1", providerId: "host", dependencies: ["a"] },
		])).toMatchObject({ ok: false });

		const registry = new RuntimeServiceRegistry();
		expect(registry.register({ serviceId: "tool", version: "1", providerId: "host" }).ok).toBe(true);
		expect(registry.register({ serviceId: "tool", version: "2", providerId: "host" })).toMatchObject({ ok: false });
	});

	it("orders hooks deterministically and disposes effect scopes in reverse order", async () => {
		const hooks = orderRuntimeHooks([
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

		const dynamic = new RuntimeToolRegistry();
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
		expect(selectResources({ policy: "except", named: ["blocked"] }, ["allowed", "blocked"])).toEqual(["allowed"]);
		expect(resolveChildExecutorMcpSelectors({ policy: "named", named: ["allowed"] }, { policy: "all" })).toMatchObject({ ok: false });
		const packageWithSelectors = (packageSelector: ResourceSelector | undefined, agentSelector: ResourceSelector | undefined) => {
			const base = pluginPackage();
			return {
				...base,
				...(packageSelector === undefined ? {} : { mcpSelector: packageSelector }),
				contents: { ...base.contents, agents: [{ agentId: "child-agent", ...(agentSelector === undefined ? {} : { mcpSelector: agentSelector }) }] },
			};
		};
		for (const parent of [{ policy: "none" }, { policy: "named", named: ["allowed"] }] as const) {
			expect(validateLocalPluginPackage(packageWithSelectors({ policy: "all" }, undefined), parent)).toMatchObject({ ok: false, error: { code: "role_resolver_scope_widened" } });
			expect(validateLocalPluginPackage(packageWithSelectors(undefined, { policy: "all" }), parent)).toMatchObject({ ok: false, error: { code: "role_resolver_scope_widened" } });
		}
		expect(validateLocalPluginPackage(packageWithSelectors({ policy: "named", named: ["allowed"] }, { policy: "named", named: ["allowed"] }), { policy: "all" })).toMatchObject({ ok: true });
		expect(validateLocalPluginPackage(packageWithSelectors({ policy: "named", named: ["allowed"] }, { policy: "none" }), { policy: "named", named: ["allowed", "other"] })).toMatchObject({ ok: true });

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
		const signedPackage = { ...signed, signatureMetadata: { algorithm: "test", keyId: "key", value: "signature", contentDigest: pluginContentsDigest(signed.contents) } };
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
		expect(validateProfileContract({ ...profile, managedKeys: [] }).ok).toBe(false);
		const emptyManagedKeysProfile = { ...profile, profileId: "empty-managed-profile", managedKeys: [] };
		expect(applyProfilePatch(emptyManagedKeysProfile, { schemaVersion: 1, patchId: "empty-managed-keys", targetProfileId: emptyManagedKeysProfile.profileId, revision: 2, source: "project", values: { timeout: 20 } })).toMatchObject({ ok: false, error: { code: "profile_conflict" } });
		expect(applyProfilePatch({ ...profile, profileId: "invalid-managed-profile", managedKeys: [""] }, { schemaVersion: 1, patchId: "invalid-managed-keys", targetProfileId: "invalid-managed-profile", revision: 2, source: "project", values: { timeout: 20 } })).toMatchObject({ ok: false, error: { code: "profile_conflict" } });
		const omittedManagedKeys = { schemaVersion: 1 as const, patchId: "managed-unset", targetProfileId: "profile", revision: 2, source: "project", unset: ["mode"] };
		expect(applyProfilePatch(profile, omittedManagedKeys)).toMatchObject({ ok: false, error: { code: "profile_conflict" } });
		expect(applyProfilePatch(profile, { ...omittedManagedKeys, patchId: "managed-replace", unset: undefined, values: { mode: "fast" } })).toMatchObject({ ok: false, error: { code: "profile_conflict" } });
		expect(applyProfilePatch(profile, { ...omittedManagedKeys, patchId: "forged-managed-keys", unset: undefined, values: { mode: "fast" }, managedKeys: [] } as never)).toMatchObject({ ok: false, error: { code: "profile_conflict" } });
		expect(applyProfilePatch(profile, { ...omittedManagedKeys, patchId: "forged-managed-key-name", unset: undefined, values: { mode: "fast" }, managedKeys: ["timeout"] } as never)).toMatchObject({ ok: false, error: { code: "profile_conflict" } });
		expect(composeProfileBundle({ schemaVersion: 1, bundleId: "managed-unset-bundle", revision: 1, source: "global", profiles: [profile], patches: [omittedManagedKeys] })).toMatchObject({ ok: true, value: { conflicts: [{ field: "mode", reason: "managed_lock" }], profiles: [{ values: { mode: "safe", timeout: 10 } }] } });
		expect(composeProfileBundle({ schemaVersion: 1, bundleId: "managed-replace-bundle", revision: 1, source: "global", profiles: [profile], patches: [{ ...omittedManagedKeys, patchId: "managed-replace", unset: undefined, values: { mode: "fast" } }] })).toMatchObject({ ok: true, value: { conflicts: [{ field: "mode", reason: "managed_lock" }], profiles: [{ values: { mode: "safe", timeout: 10 } }] } });
		expect(composeProfileBundle({ schemaVersion: 1, bundleId: "forged-managed-bundle", revision: 1, source: "global", profiles: [profile], patches: [{ ...omittedManagedKeys, patchId: "forged-managed", unset: undefined, values: { mode: "fast" }, managedKeys: [] } as never] })).toMatchObject({ ok: true, value: { conflicts: [{ field: "mode", reason: "managed_lock" }], profiles: [{ values: { mode: "safe", timeout: 10 } }] } });
		expect(composeProfileBundle({ schemaVersion: 1, bundleId: "bundle", revision: 1, source: "global", profiles: [profile], patches: [{ schemaVersion: 1, patchId: "patch", targetProfileId: "profile", revision: 2, source: "project", values: { timeout: 20 } }] })).toMatchObject({ ok: true, value: { profiles: [{ values: { mode: "safe", timeout: 20 }, managedKeys: ["mode"] }] } });
	});

	it("persists an atomic activation pointer, recovers after restart, and cleans failed staging", async () => {
		const storage = new InMemoryLocalPluginRegistryStorage();
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

		const failingStorage = new InMemoryLocalPluginRegistryStorage();
		const failing = new LocalPluginRegistry({ storage: failingStorage, onActivate: async () => { throw new Error("activation failed"); } });
		expect(await failing.install(pkg)).toMatchObject({ ok: false, error: { code: "plugin_rollback_failed" } });
		expect(failingStorage.snapshot.active).toHaveLength(0);
		expect(failingStorage.snapshot.staged).toHaveLength(0);
	});

	it("reopens committed plugin activation from a fresh local filesystem storage instance", async () => {
		const directory = await mkdtemp(join(tmpdir(), "aos-agent-plugin-registry-"));
		try {
			const pkg = pluginPackage();
			const registryDirectory = "registry";
			const registry = new LocalPluginRegistry({
				storage: new LocalFilePluginRegistryStorage(new NodeExecutionEnv({ cwd: directory }), registryDirectory),
				now: () => "installed",
			});
			expect(await registry.install(pkg)).toMatchObject({ ok: true });

			const pointer = JSON.parse(await readFile(join(directory, registryDirectory, "activation-pointer.json"), "utf8")) as { generation: number; snapshotFile: string };
			expect(pointer.generation).toBeGreaterThan(0);
			expect(pointer.snapshotFile).toMatch(/^snapshot-\d+-[0-9a-f-]+\.json$/);

			const reopened = await LocalPluginRegistry.open({
				storage: new LocalFilePluginRegistryStorage(new NodeExecutionEnv({ cwd: directory }), registryDirectory),
				now: () => "reopened",
			});
			expect(reopened).toMatchObject({ ok: true });
			if (!reopened.ok) return;
			expect(reopened.value.active(pkg.contract.pluginId)).toMatchObject({ pluginId: pkg.contract.pluginId, revision: 1, activatedAt: "installed" });
			expect(await reopened.value.uninstall(pkg.contract.pluginId)).toMatchObject({ ok: true });
			expect(await reopened.value.install(pluginPackage("2.0.0"))).toMatchObject({ ok: true, value: { operation: "install", revision: 1 } });
			expect(await reopened.value.rollback(pkg.contract.pluginId)).toMatchObject({ ok: false, error: { code: "plugin_rollback_failed" } });

			const reinstalled = await LocalPluginRegistry.open({
				storage: new LocalFilePluginRegistryStorage(new NodeExecutionEnv({ cwd: directory }), registryDirectory),
				now: () => "reinstalled",
			});
			expect(reinstalled).toMatchObject({ ok: true });
			if (!reinstalled.ok) return;
			expect(reinstalled.value.active(pkg.contract.pluginId)).toMatchObject({ pluginId: pkg.contract.pluginId, version: "2.0.0", revision: 1 });
			expect(await reinstalled.value.rollback(pkg.contract.pluginId)).toMatchObject({ ok: false, error: { code: "plugin_rollback_failed" } });
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("fails closed for corrupt durable JSON, schema, and cross-record correlations", async () => {
		const directory = await mkdtemp(join(tmpdir(), "aos-agent-plugin-corrupt-"));
		try {
			const registryDirectory = "registry";
			const pkg = pluginPackage();
			const storage = new LocalFilePluginRegistryStorage(new NodeExecutionEnv({ cwd: directory }), registryDirectory);
			const registry = new LocalPluginRegistry({ storage, now: () => "installed" });
			expect(await registry.install(pkg)).toMatchObject({ ok: true });
			expect(await registry.update(pluginPackage("2.0.0"))).toMatchObject({ ok: true });

			const pointerPath = join(directory, registryDirectory, "activation-pointer.json");
			const pointerText = await readFile(pointerPath, "utf8");
			const pointer = JSON.parse(pointerText) as { generation: number; snapshotFile: string };
			const snapshotPath = join(directory, registryDirectory, "snapshots", pointer.snapshotFile);
			const snapshotText = await readFile(snapshotPath, "utf8");
			const expectCorrupt = async (message?: string): Promise<void> => {
				const reopened = await LocalPluginRegistry.open({ storage: new LocalFilePluginRegistryStorage(new NodeExecutionEnv({ cwd: directory }), registryDirectory) });
				expect(reopened).toMatchObject({ ok: false, error: { _tag: "FoundationError" } });
				if (!reopened.ok && message !== undefined) expect(reopened.error.message).toBe(message);
			};

			await writeFile(pointerPath, "{", "utf8");
			await expectCorrupt();
			await writeFile(pointerPath, JSON.stringify({ schemaVersion: 2, generation: pointer.generation, snapshotFile: pointer.snapshotFile }), "utf8");
			await expectCorrupt();
			await writeFile(pointerPath, pointerText, "utf8");

			const malformedSnapshot = JSON.parse(snapshotText) as { active: unknown[] };
			malformedSnapshot.active[0] = null;
			await writeFile(snapshotPath, JSON.stringify(malformedSnapshot), "utf8");
			await expectCorrupt();
			await writeFile(snapshotPath, snapshotText, "utf8");

			const schemaSnapshot = JSON.parse(snapshotText) as Record<string, unknown>;
			schemaSnapshot.schemaVersion = 2;
			await writeFile(snapshotPath, JSON.stringify(schemaSnapshot), "utf8");
			await expectCorrupt();
			await writeFile(snapshotPath, snapshotText, "utf8");

			const correlationMutations: Array<(snapshot: LocalPluginRegistrySnapshot) => void> = [
				(snapshot) => { snapshot.active[0]!.record.pluginId = "tampered-plugin"; },
				(snapshot) => { snapshot.active[0]!.record.namespace = "tampered-namespace"; },
				(snapshot) => { snapshot.active[0]!.record.version = "9.9.9"; },
				(snapshot) => { snapshot.active[0]!.record.digest = { algorithm: "sha256", value: "0".repeat(64) }; },
				(snapshot) => { snapshot.active[0]!.record.contentDigest = { algorithm: "sha256", value: "0".repeat(64) }; },
				(snapshot) => { snapshot.pointers[0]!.pluginId = "tampered-plugin"; },
				(snapshot) => { snapshot.previous[0]!.record.version = "9.9.9"; },
			];
			for (const mutate of correlationMutations) {
				const tampered = JSON.parse(snapshotText) as LocalPluginRegistrySnapshot;
				mutate(tampered);
				await writeFile(snapshotPath, JSON.stringify(tampered), "utf8");
				await expectCorrupt();
			}
			await writeFile(snapshotPath, snapshotText, "utf8");

			expect(await storage.stagePackage({
				stageId: `local-plugin:3:${pluginContentsDigest(pluginPackage("3.0.0").contents).value}`,
				operation: "update",
				pluginId: pkg.contract.pluginId,
				revision: 3,
				package: pluginPackage("3.0.0"),
				stagedAt: "before-crash",
			})).toMatchObject({ ok: true });
			const stagedPointer = JSON.parse(await readFile(pointerPath, "utf8")) as { snapshotFile: string };
			const stagedPath = join(directory, registryDirectory, "snapshots", stagedPointer.snapshotFile);
			const stagedSnapshotText = await readFile(stagedPath, "utf8");
			const stagedSnapshot = JSON.parse(stagedSnapshotText) as LocalPluginRegistrySnapshot;
			stagedSnapshot.staged[0]!.pluginId = "tampered-plugin";
			await writeFile(stagedPath, JSON.stringify(stagedSnapshot), "utf8");
			await expectCorrupt();

			const tamperCases: Array<{ message: string; mutate: (snapshot: LocalPluginRegistrySnapshot) => void }> = [
				{ message: "plugin registry snapshot generation is invalid", mutate: (snapshot) => { snapshot.generation += 1; } },
				{ message: "plugin registry snapshot pointer generation does not match its snapshot", mutate: (snapshot) => { snapshot.pointers[0]!.generation -= 1; } },
				{ message: "plugin registry snapshot active and previous revisions are out of order", mutate: (snapshot) => { snapshot.active[0]!.record.revision = snapshot.previous[0]!.record.revision; } },
				{ message: "durable install stage does not match plugin state", mutate: (snapshot) => { snapshot.staged[0]!.operation = "install"; } },
				{ message: "durable update stage does not match plugin revision", mutate: (snapshot) => {
					snapshot.staged[0]!.revision = 4;
					snapshot.staged[0]!.stageId = `local-plugin:4:${pluginContentsDigest(snapshot.staged[0]!.package.contents).value}`;
				} },
				{ message: "durable staged plugin identity does not match its package", mutate: (snapshot) => { snapshot.staged[0]!.stageId = "forged-stage"; } },
				{ message: "plugin registry snapshot pointer stage identity is inconsistent", mutate: (snapshot) => { snapshot.pointers[0]!.stageId = "forged-stage"; } },
			];
			for (const tamperCase of tamperCases) {
				const tampered = JSON.parse(stagedSnapshotText) as LocalPluginRegistrySnapshot;
				tamperCase.mutate(tampered);
				await writeFile(stagedPath, JSON.stringify(tampered), "utf8");
				await expectCorrupt(tamperCase.message);
			}
			await writeFile(stagedPath, stagedSnapshotText, "utf8");
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("fails closed when a committed pointer disappears but accepts a new registry", async () => {
		const directory = await mkdtemp(join(tmpdir(), "aos-agent-plugin-missing-pointer-"));
		try {
			const registryDirectory = "registry";
			const storage = new LocalFilePluginRegistryStorage(new NodeExecutionEnv({ cwd: directory }), registryDirectory);
			const registry = new LocalPluginRegistry({ storage });
			expect(await registry.install(pluginPackage())).toMatchObject({ ok: true });
			await rm(join(directory, registryDirectory, "activation-pointer.json"));
			expect(await LocalPluginRegistry.open({ storage: new LocalFilePluginRegistryStorage(new NodeExecutionEnv({ cwd: directory }), registryDirectory) })).toMatchObject({ ok: false, error: { _tag: "FoundationError" } });

			const emptyDirectory = await mkdtemp(join(tmpdir(), "aos-agent-plugin-empty-"));
			try {
				expect(await LocalPluginRegistry.open({ storage: new LocalFilePluginRegistryStorage(new NodeExecutionEnv({ cwd: emptyDirectory }), registryDirectory) })).toMatchObject({ ok: true });
			} finally {
				await rm(emptyDirectory, { recursive: true, force: true });
			}
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("keeps the last committed pointer and snapshot after publication failures", async () => {
		const failures: Array<{ operation: FaultOperation; target: FaultTarget }> = [
			{ operation: "createExclusive", target: "snapshot" },
			{ operation: "syncFile", target: "snapshot" },
			{ operation: "renameFile", target: "snapshot" },
			{ operation: "syncDirectory", target: "snapshot" },
			{ operation: "createExclusive", target: "pointer" },
			{ operation: "syncFile", target: "pointer" },
			{ operation: "renameFile", target: "pointer" },
			{ operation: "syncDirectory", target: "pointer" },
		];
		for (const failure of failures) {
			const directory = await mkdtemp(join(tmpdir(), "aos-agent-plugin-publication-"));
			try {
				const registryDirectory = "registry";
				const pkg = pluginPackage();
				const initialStorage = new LocalFilePluginRegistryStorage(new NodeExecutionEnv({ cwd: directory }), registryDirectory);
				const registry = new LocalPluginRegistry({ storage: initialStorage, now: () => "installed" });
				expect(await registry.install(pkg)).toMatchObject({ ok: true });
				const active = registry.active(pkg.contract.pluginId);
				expect(active).toBeDefined();
				if (active === undefined) return;
				const pointerPath = join(directory, registryDirectory, "activation-pointer.json");
				const pointerBefore = await readFile(pointerPath, "utf8");
				const pointer = JSON.parse(pointerBefore) as { snapshotFile: string };
				const snapshotPath = join(directory, registryDirectory, "snapshots", pointer.snapshotFile);
				const snapshotBefore = await readFile(snapshotPath, "utf8");

				const failingStorage = new LocalFilePluginRegistryStorage(
					faultInjectingFileSystem(new NodeExecutionEnv({ cwd: directory }), failure.operation, failure.target),
					registryDirectory,
				);
				const switched = await failingStorage.atomicSwitch({ pluginId: pkg.contract.pluginId, active: { package: pkg, record: active }, state: "active" });
				expect(switched).toMatchObject({ ok: false, error: { _tag: "FoundationError" } });
				expect(await readFile(pointerPath, "utf8")).toBe(pointerBefore);
				expect(await readFile(snapshotPath, "utf8")).toBe(snapshotBefore);
				const reopened = await LocalPluginRegistry.open({ storage: new LocalFilePluginRegistryStorage(new NodeExecutionEnv({ cwd: directory }), registryDirectory) });
				expect(reopened).toMatchObject({ ok: true });
				if (!reopened.ok) return;
				expect(reopened.value.active(pkg.contract.pluginId)).toMatchObject({ pluginId: pkg.contract.pluginId, revision: 1 });
				const registryEntries = await readdir(join(directory, registryDirectory));
				const snapshotEntries = await readdir(join(directory, registryDirectory, "snapshots"));
				expect([...registryEntries, ...snapshotEntries].filter((entry) => entry.includes(".tmp"))).toEqual([]);
			} finally {
				await rm(directory, { recursive: true, force: true });
			}
		}
	});

	it("reports indeterminate pointer publication when restoration also fails", async () => {
		const directory = await mkdtemp(join(tmpdir(), "aos-agent-plugin-pointer-restore-"));
		try {
			const registryDirectory = "registry";
			const pkg = pluginPackage();
			const base = new NodeExecutionEnv({ cwd: directory });
			const initialStorage = new LocalFilePluginRegistryStorage(base, registryDirectory);
			const registry = new LocalPluginRegistry({ storage: initialStorage });
			expect(await registry.install(pkg)).toMatchObject({ ok: true });
			const active = registry.active(pkg.contract.pluginId);
			expect(active).toBeDefined();
			if (active === undefined) return;
			const failingStorage = new LocalFilePluginRegistryStorage(
				faultInjectingFileSystem(new NodeExecutionEnv({ cwd: directory }), { operation: "syncDirectory", target: "pointer", failureCalls: [1, 2] }),
				registryDirectory,
			);
			const switched = await failingStorage.atomicSwitch({ pluginId: pkg.contract.pluginId, active: { package: pkg, record: active }, state: "active" });
			expect(switched).toMatchObject({ ok: false, error: { _tag: "FoundationError" } });
			if (switched.ok) return;
			expect(switched.error.message).toBe("activation pointer restoration failed");
			const registryEntries = await readdir(join(directory, registryDirectory));
			const snapshotEntries = await readdir(join(directory, registryDirectory, "snapshots"));
			expect([...registryEntries, ...snapshotEntries].filter((entry) => entry.includes(".tmp"))).toEqual([]);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("keeps registry bindings aligned with disk after repeated rollback publication failures", async () => {
		const directory = await mkdtemp(join(tmpdir(), "aos-agent-plugin-rollback-publication-"));
		try {
			const registryDirectory = "registry";
			const faultingFileSystem = faultInjectingFileSystem(new NodeExecutionEnv({ cwd: directory }), { operation: "syncDirectory", target: "pointer", failureCalls: [6, 9] });
			const storage = new LocalFilePluginRegistryStorage(faultingFileSystem, registryDirectory);
			const registry = new LocalPluginRegistry({ storage });
			expect(await registry.install(pluginPackage())).toMatchObject({ ok: true });
			expect(await registry.update(pluginPackage("2.0.0"))).toMatchObject({ ok: true });
			expect(await registry.rollback("local-plugin")).toMatchObject({ ok: false, error: { _tag: "FoundationError" } });
			expect(registry.active("local-plugin")).toMatchObject({ version: "2.0.0", revision: 2 });
			expect(await registry.rollback("local-plugin")).toMatchObject({ ok: false, error: { _tag: "FoundationError" } });
			expect(registry.active("local-plugin")).toMatchObject({ version: "2.0.0", revision: 2 });

			const reopened = await LocalPluginRegistry.open({ storage: new LocalFilePluginRegistryStorage(new NodeExecutionEnv({ cwd: directory }), registryDirectory) });
			expect(reopened).toMatchObject({ ok: true });
			if (!reopened.ok) return;
			expect(reopened.value.active("local-plugin")).toMatchObject({ version: "2.0.0", revision: 2 });
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("rolls back every recovered plugin scope in reverse order when orphan cleanup fails", async () => {
		const storage = new InMemoryLocalPluginRegistryStorage();
		const first = pluginPackage("1.0.0", "first-plugin", "first");
		const second = pluginPackage("1.0.0", "second-plugin", "second");
		const registry = new LocalPluginRegistry({ storage });
		expect(await registry.install(first)).toMatchObject({ ok: true });
		expect(await registry.install(second)).toMatchObject({ ok: true });
		expect(await storage.stagePackage({
			stageId: `first-plugin:2:${pluginContentsDigest(pluginPackage("2.0.0", first.contract.pluginId, first.contract.namespace).contents).value}`,
			operation: "update",
			pluginId: first.contract.pluginId,
			revision: 2,
			package: pluginPackage("2.0.0", first.contract.pluginId, first.contract.namespace),
			stagedAt: "before-crash",
		})).toMatchObject({ ok: true });
		expect(await storage.stagePackage({
			stageId: `second-plugin:2:${pluginContentsDigest(pluginPackage("2.0.0", second.contract.pluginId, second.contract.namespace).contents).value}`,
			operation: "update",
			pluginId: second.contract.pluginId,
			revision: 2,
			package: pluginPackage("2.0.0", second.contract.pluginId, second.contract.namespace),
			stagedAt: "before-crash",
		})).toMatchObject({ ok: true });

		const disposed: string[] = [];
		let failFirstDisposer = true;
		let failLaterRemoval = true;
		const storageAdapter: LocalPluginRegistryStorage = {
			load: () => storage.load(),
			stagePackage: (record) => storage.stagePackage(record),
			atomicSwitch: (change) => storage.atomicSwitch(change),
			removeStage: async (stageId) => {
				if (stageId.startsWith("first-plugin:")) return storage.removeStage(stageId);
				if (failLaterRemoval) {
					failLaterRemoval = false;
					return Result.err(new FoundationError("plugin_rollback_failed", "injected orphan cleanup failure"));
				}
				return storage.removeStage(stageId);
			},
		};
		const failed = await LocalPluginRegistry.open({
			storage: storageAdapter,
			onActivate: async (pkg, context) => {
				if (pkg.contract.pluginId === "first-plugin") {
					context.register("listener", "first-earlier", () => { disposed.push("first-earlier"); });
					context.register("listener", "first-failing", () => {
						disposed.push("first-failing");
						if (failFirstDisposer) {
							failFirstDisposer = false;
							throw new Error("injected disposer failure");
						}
					});
				} else context.register("listener", "second-listener", () => { disposed.push("second-plugin"); });
			},
		});
		expect(failed).toMatchObject({ ok: false, error: { code: "plugin_rollback_failed" } });
		expect(disposed).toEqual(["second-plugin", "first-failing", "first-earlier"]);
		const retried = await LocalPluginRegistry.open({ storage: storageAdapter, onActivate: async (pkg, context) => {
			if (pkg.contract.pluginId === "first-plugin") {
				context.register("listener", "first-earlier", () => { disposed.push("first-earlier"); });
				context.register("listener", "first-failing", () => { disposed.push("first-failing"); });
			} else context.register("listener", "second-listener", () => { disposed.push("second-plugin"); });
		} });
		expect(retried).toMatchObject({ ok: true });
		expect(disposed).toEqual(["second-plugin", "first-failing", "first-earlier"]);
		expect(storage.snapshot.staged).toEqual([]);
	});

	it("reconciles indeterminate staging and failed activation cleanup from durable state", async () => {
		const stagedStorage = new InMemoryLocalPluginRegistryStorage();
		const initial = new LocalPluginRegistry({ storage: stagedStorage });
		expect(await initial.install(pluginPackage())).toMatchObject({ ok: true });
		let reportStageFailure = true;
		const stagingAdapter: LocalPluginRegistryStorage = {
			load: () => stagedStorage.load(),
			stagePackage: async (record) => {
				const staged = await stagedStorage.stagePackage(record);
				if (!staged.ok) return staged;
				if (reportStageFailure) {
					reportStageFailure = false;
					return Result.err(new FoundationError("plugin_rollback_failed", "injected indeterminate staging failure"));
				}
				return staged;
			},
			atomicSwitch: (change) => stagedStorage.atomicSwitch(change),
			removeStage: (stageId) => stagedStorage.removeStage(stageId),
		};
		const stagingRegistry = await LocalPluginRegistry.open({ storage: stagingAdapter });
		expect(stagingRegistry).toMatchObject({ ok: true });
		if (!stagingRegistry.ok) return;
		expect(await stagingRegistry.value.update(pluginPackage("2.0.0"))).toMatchObject({ ok: false, error: { message: "injected indeterminate staging failure" } });
		expect(stagingRegistry.value.active("local-plugin")).toMatchObject({ version: "1.0.0", revision: 1 });
		expect(stagedStorage.snapshot.staged).toEqual([]);

		const cleanupStorage = new InMemoryLocalPluginRegistryStorage();
		let failFirstRemoval = true;
		const cleanupAdapter: LocalPluginRegistryStorage = {
			load: () => cleanupStorage.load(),
			stagePackage: (record) => cleanupStorage.stagePackage(record),
			atomicSwitch: (change) => cleanupStorage.atomicSwitch(change),
			removeStage: async (stageId) => {
				if (failFirstRemoval) {
					failFirstRemoval = false;
					return Result.err(new FoundationError("plugin_rollback_failed", "injected activation cleanup failure"));
				}
				return cleanupStorage.removeStage(stageId);
			},
		};
		const cleanupRegistry = new LocalPluginRegistry({
			storage: cleanupAdapter,
			onActivate: async (pkg) => {
				if (pkg.contract.version === "2.0.0") throw new Error("injected activation failure");
			},
		});
		expect(await cleanupRegistry.install(pluginPackage())).toMatchObject({ ok: true });
		expect(await cleanupRegistry.update(pluginPackage("2.0.0"))).toMatchObject({ ok: false, error: { message: "injected activation failure" } });
		expect(cleanupRegistry.active("local-plugin")).toMatchObject({ version: "1.0.0", revision: 1 });
		expect(cleanupStorage.snapshot.staged).toEqual([]);
	});

	it("preserves the rollback point on disk when rollback cleanup fails", async () => {
		const directory = await mkdtemp(join(tmpdir(), "aos-agent-plugin-rollback-"));
		let failVersionTwoCleanup = true;
		const onActivate = async (pkg: LocalPluginPackage, context: PluginActivationContext) => {
			context.register("listener", `version:${pkg.contract.version}`, () => {
				if (pkg.contract.version === "2.0.0" && failVersionTwoCleanup) {
					failVersionTwoCleanup = false;
					throw new Error("injected rollback cleanup failure");
				}
			});
		};
		try {
			const registryDirectory = "registry";
			const storage = new LocalFilePluginRegistryStorage(new NodeExecutionEnv({ cwd: directory }), registryDirectory);
			const registry = new LocalPluginRegistry({ storage, onActivate });
			expect(await registry.install(pluginPackage())).toMatchObject({ ok: true });
			expect(await registry.update(pluginPackage("2.0.0"))).toMatchObject({ ok: true });
			expect(await registry.rollback("local-plugin")).toMatchObject({ ok: false, error: { code: "plugin_rollback_failed" } });

			const reopened = await LocalPluginRegistry.open({
				storage: new LocalFilePluginRegistryStorage(new NodeExecutionEnv({ cwd: directory }), registryDirectory),
				onActivate,
			});
			expect(reopened).toMatchObject({ ok: true });
			if (!reopened.ok) return;
			expect(reopened.value.active("local-plugin")).toMatchObject({ version: "2.0.0", revision: 2 });
			expect(await reopened.value.rollback("local-plugin")).toMatchObject({ ok: true, value: { operation: "rollback" } });
			expect(reopened.value.active("local-plugin")).toMatchObject({ version: "1.0.0", revision: 3 });
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
