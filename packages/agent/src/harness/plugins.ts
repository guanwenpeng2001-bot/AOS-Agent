/** Local-only Plugin v1 manifest, staging, activation, and rollback lifecycle. */
import type { ExtensionContractV1, LspExtensionContractV1, MonitorExtensionContractV1 } from "./foundation/profile.ts";
import { validateExtensionContractV1 } from "./foundation/profile.ts";
import { FoundationError, toFoundationError } from "./foundation/errors.ts";
import { FOUNDATION_SCHEMA_VERSION, canonicalFoundationJson, fingerprintFoundationValue, type FingerprintV1 } from "./foundation/identity.ts";
import type { FoundationJsonValue } from "./foundation/event-catalog.ts";
import type { PluginContractV1, PluginHookV1, PluginLifecycleOperationV1, PluginLifecycleResultV1 } from "./foundation/plugin.ts";
import type { ResourceSelectorV1 } from "./foundation/reference.ts";
import { EffectScope, orderRuntimeHooksV1, type EffectDisposerV1, type EffectResourceKindV1, type RuntimeHookSpecV1 } from "./runtime-services.ts";
import { validateMcpSelectorTighteningV1, validateSelectorV1 } from "./profile.ts";
import { Result, type Result as ResultValue } from "./result.ts";

export type PluginPackageSourceV1 = "local" | "remote" | "hosted";

export interface PluginSignatureMetadataV1 {
	algorithm: string;
	keyId: string;
	value: string;
	signedAt?: string;
	/** Signature input digest for the complete package contents, not only the manifest. */
	contentDigest?: FingerprintV1;
}

export interface PluginSkillRefV1 {
	skillId: string;
	/** The skill may only tighten the package's parent MCP scope. */
	mcpSelector?: ResourceSelectorV1;
}

export interface PluginMCPRefV1 {
	mcpServerId: string;
	selector?: ResourceSelectorV1;
}

export interface PluginAgentRefV1 {
	agentId: string;
	mcpSelector?: ResourceSelectorV1;
}

export interface PluginBinEntryV1 {
	name: string;
	command: string;
}

export interface PluginSettingsPatchV1 {
	values: Readonly<Record<string, string | number | boolean>>;
}

export interface PluginPackageContentsV1 {
	skills?: readonly PluginSkillRefV1[];
	extensions?: readonly ExtensionContractV1[];
	mcpServers?: readonly PluginMCPRefV1[];
	agents?: readonly PluginAgentRefV1[];
	lsp?: readonly LspExtensionContractV1[];
	monitors?: readonly MonitorExtensionContractV1[];
	bin?: readonly PluginBinEntryV1[];
	settings?: readonly PluginSettingsPatchV1[];
}

export interface LocalPluginPackageV1 {
	schemaVersion: typeof FOUNDATION_SCHEMA_VERSION;
	contract: PluginContractV1;
	contents: PluginPackageContentsV1;
	source: PluginPackageSourceV1;
	sourcePath?: string;
	signatureMetadata?: PluginSignatureMetadataV1;
	/** Parent MCP scope inherited by all child/executor declarations in this package. */
	mcpSelector?: ResourceSelectorV1;
}

export interface PluginRejectedSourceV1 {
	source: string;
	reason: string;
}

export interface PluginStageReportV1 {
	schemaVersion: typeof FOUNDATION_SCHEMA_VERSION;
	operation: PluginLifecycleOperationV1;
	pluginId: string;
	revision: number;
	staged: boolean;
	rejected: readonly PluginRejectedSourceV1[];
}

export interface PluginActivationRecordV1 {
	schemaVersion: typeof FOUNDATION_SCHEMA_VERSION;
	pluginId: string;
	revision: number;
	namespace: string;
	version: string;
	digest: FingerprintV1;
	contentDigest?: FingerprintV1;
	signature: string;
	signatureMetadata?: PluginSignatureMetadataV1;
	activatedAt: string;
}

export interface CreatePluginContractInputV1 {
	namespace: string;
	pluginId: string;
	version: string;
	manifest: PluginContractV1["manifest"];
	signature: string;
	hooks?: readonly PluginHookV1[];
	features?: readonly string[];
	serviceIds?: readonly string[];
	profileIds?: readonly string[];
	rollbackSupported?: boolean;
}

export interface PluginActivationContextV1 {
	scope: EffectScope;
	register(kind: EffectResourceKindV1, resourceId: string, dispose: EffectDisposerV1): ResultValue<string, FoundationError>;
}

export interface LocalPluginRegistryOptionsV1 {
	onStage?: (report: PluginStageReportV1) => void | Promise<void>;
	/** Hook for provider composition. This module never starts hosted services itself. */
	onActivate?: (pkg: LocalPluginPackageV1, context: PluginActivationContextV1) => void | Promise<void>;
	verifySignature?: (contract: PluginContractV1, metadata?: PluginSignatureMetadataV1, contentsDigest?: FingerprintV1) => ResultValue<void, FoundationError>;
	requireContentSignature?: boolean;
	now?: () => string;
	/** Durable local storage. Its atomicSwitch operation is the activation pointer commit. */
	storage?: LocalPluginRegistryStorageV1;
}

export interface PluginRegistryStoredActivationV1 {
	package: LocalPluginPackageV1;
	record: PluginActivationRecordV1;
}

export interface PluginRegistryStagedPackageV1 {
	stageId: string;
	operation: PluginLifecycleOperationV1;
	pluginId: string;
	revision: number;
	package: LocalPluginPackageV1;
	stagedAt: string;
}

export interface PluginRegistryActivationPointerV1 {
	pluginId: string;
	state: "active" | "uninstalled";
	stageId?: string;
	generation: number;
}

export interface LocalPluginRegistrySnapshotV1 {
	schemaVersion: typeof FOUNDATION_SCHEMA_VERSION;
	generation: number;
	active: readonly PluginRegistryStoredActivationV1[];
	previous: readonly PluginRegistryStoredActivationV1[];
	staged: readonly PluginRegistryStagedPackageV1[];
	pointers: readonly PluginRegistryActivationPointerV1[];
}

export interface PluginRegistryAtomicSwitchV1 {
	pluginId: string;
	active?: PluginRegistryStoredActivationV1;
	previous?: PluginRegistryStoredActivationV1;
	stageId?: string;
	state: "active" | "uninstalled";
}

/**
 * Storage deliberately exposes a single atomic pointer switch. A caller may
 * recover after a process restart by loading the last complete snapshot; an
 * orphaned staged package is safe to remove without touching the active one.
 */
export interface LocalPluginRegistryStorageV1 {
	load(): Promise<ResultValue<LocalPluginRegistrySnapshotV1 | undefined, FoundationError>>;
	stagePackage(record: PluginRegistryStagedPackageV1): Promise<ResultValue<void, FoundationError>>;
	atomicSwitch(change: PluginRegistryAtomicSwitchV1): Promise<ResultValue<void, FoundationError>>;
	removeStage(stageId: string): Promise<ResultValue<void, FoundationError>>;
}

function clonePluginPersistence<T>(value: T): T {
	return JSON.parse(canonicalFoundationJson(value)) as T;
}

/** In-memory durable adapter used by hosts and conformance tests. */
export class InMemoryLocalPluginRegistryStorageV1 implements LocalPluginRegistryStorageV1 {
	#snapshot: LocalPluginRegistrySnapshotV1 = { schemaVersion: FOUNDATION_SCHEMA_VERSION, generation: 0, active: [], previous: [], staged: [], pointers: [] };

	get snapshot(): LocalPluginRegistrySnapshotV1 { return clonePluginPersistence(this.#snapshot); }

	async load(): Promise<ResultValue<LocalPluginRegistrySnapshotV1, FoundationError>> {
		return Result.ok(clonePluginPersistence(this.#snapshot));
	}

	async stagePackage(record: PluginRegistryStagedPackageV1): Promise<ResultValue<void, FoundationError>> {
		const staged = [...this.#snapshot.staged.filter((item) => item.stageId !== record.stageId), clonePluginPersistence(record)];
		this.#snapshot = { ...this.#snapshot, generation: this.#snapshot.generation + 1, staged };
		return Result.ok(undefined);
	}

	async atomicSwitch(change: PluginRegistryAtomicSwitchV1): Promise<ResultValue<void, FoundationError>> {
		const active = this.#snapshot.active.filter((item) => item.record.pluginId !== change.pluginId);
		const previous = this.#snapshot.previous.filter((item) => item.record.pluginId !== change.pluginId);
		const nextGeneration = this.#snapshot.generation + 1;
		const pointers = this.#snapshot.pointers.filter((pointer) => pointer.pluginId !== change.pluginId);
		this.#snapshot = {
			...this.#snapshot,
			generation: nextGeneration,
			active: change.active === undefined ? active : [...active, clonePluginPersistence(change.active)],
			previous: change.previous === undefined ? previous : [...previous, clonePluginPersistence(change.previous)],
			staged: change.stageId === undefined ? this.#snapshot.staged : this.#snapshot.staged.filter((item) => item.stageId !== change.stageId),
			pointers: [...pointers, { pluginId: change.pluginId, state: change.state, ...(change.stageId === undefined ? {} : { stageId: change.stageId }), generation: nextGeneration }],
		};
		return Result.ok(undefined);
	}

	async removeStage(stageId: string): Promise<ResultValue<void, FoundationError>> {
		this.#snapshot = { ...this.#snapshot, generation: this.#snapshot.generation + 1, staged: this.#snapshot.staged.filter((item) => item.stageId !== stageId) };
		return Result.ok(undefined);
	}
}

const NAMESPACE_PATTERN = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;
const ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;

export function defaultPluginNamespace(contract: PluginContractV1): string {
	return contract.namespace;
}

/** Reject remote and hosted source references before any package is staged. */
export function validatePluginSourceV1(source: string): PluginRejectedSourceV1 | undefined {
	const normalized = source.trim().toLowerCase();
	if (normalized.startsWith("http://") || normalized.startsWith("https://") || normalized.startsWith("git+") || normalized.startsWith("npm:") || normalized.startsWith("ssh://")) {
		return { source, reason: "hosted or remote plugin sources are not supported; only local plugins install" };
	}
	return undefined;
}

/** Digest exactly the Foundation manifest document, not executable package contents. */
export function pluginManifestDigestV1(manifest: PluginContractV1["manifest"]): FingerprintV1 {
	return fingerprintFoundationValue(manifest);
}

/** Digest the complete local package payload, including executable declarations. */
export function pluginContentsDigestV1(contents: PluginPackageContentsV1): FingerprintV1 {
	return fingerprintFoundationValue(contents);
}

export const computePluginContentsDigestV1 = pluginContentsDigestV1;
export const pluginPackageContentsDigestV1 = pluginContentsDigestV1;

export const computePluginDigestV1 = pluginManifestDigestV1;

/** Construct a complete Plugin v1 contract with deterministic digest metadata. */
export function createPluginContractV1(input: CreatePluginContractInputV1): PluginContractV1 {
	return {
		schemaVersion: FOUNDATION_SCHEMA_VERSION,
		namespace: input.namespace,
		pluginId: input.pluginId,
		version: input.version,
		manifest: input.manifest,
		digest: pluginManifestDigestV1(input.manifest),
		signature: input.signature,
		hooks: [...(input.hooks ?? [])],
		features: [...(input.features ?? [])],
		...(input.serviceIds === undefined ? {} : { serviceIds: [...input.serviceIds] }),
		...(input.profileIds === undefined ? {} : { profileIds: [...input.profileIds] }),
		...(input.rollbackSupported === undefined ? {} : { rollbackSupported: input.rollbackSupported }),
	};
}

export const createLocalPluginContractV1 = createPluginContractV1;

function hookToSpec(hook: PluginHookV1): RuntimeHookSpecV1 {
	return { hookId: hook.hookId, phase: hook.phase, priority: hook.priority, before: hook.before, after: hook.after, conflict: hook.conflict, capabilities: hook.capabilities };
}

function pluginError(code: "invalid_identifier" | "foundation_schema_invalid_shape" | "plugin_rollback_failed" | "profile_conflict", message: string, details?: FoundationJsonValue): FoundationError {
	return new FoundationError(code, message, details === undefined ? {} : { details });
}

function validateSignatureMetadata(metadata: PluginSignatureMetadataV1 | undefined): FoundationError | undefined {
	if (metadata === undefined) return undefined;
	if (metadata.algorithm.trim().length === 0 || metadata.keyId.trim().length === 0 || metadata.value.trim().length === 0) return pluginError("foundation_schema_invalid_shape", "plugin signature metadata is incomplete");
	if (metadata.contentDigest !== undefined && (metadata.contentDigest.algorithm !== "sha256" || metadata.contentDigest.value.length === 0)) return pluginError("foundation_schema_invalid_shape", "plugin content signature digest is invalid");
	return undefined;
}

function validateUniqueIds(values: readonly string[], label: string): FoundationError | undefined {
	const seen = new Set<string>();
	for (const value of values) {
		if (value.trim().length === 0 || seen.has(value)) return pluginError("foundation_schema_invalid_shape", `${label} contains an empty or duplicate id`, { value });
		seen.add(value);
	}
	return undefined;
}

/** Validate a complete local package before staging. */
export function validateLocalPluginPackageV1(pkg: LocalPluginPackageV1, parentMcpSelector?: ResourceSelectorV1): ResultValue<void, FoundationError> {
	if (pkg.schemaVersion !== FOUNDATION_SCHEMA_VERSION || pkg.contract.schemaVersion !== FOUNDATION_SCHEMA_VERSION) return Result.err(pluginError("foundation_schema_invalid_shape", "plugin package schema version is unsupported"));
	if (pkg.source !== "local") return Result.err(pluginError("plugin_rollback_failed", "only local plugin packages are supported", { source: pkg.source }));
	if (pkg.sourcePath !== undefined) {
		const rejected = validatePluginSourceV1(pkg.sourcePath);
		if (rejected !== undefined) return Result.err(pluginError("plugin_rollback_failed", rejected.reason, { source: rejected.source }));
	}
	const { contract } = pkg;
	if (!NAMESPACE_PATTERN.test(contract.namespace)) return Result.err(pluginError("invalid_identifier", "plugin namespace is invalid", { namespace: contract.namespace }));
	if (!ID_PATTERN.test(contract.pluginId)) return Result.err(pluginError("invalid_identifier", "plugin id is invalid", { pluginId: contract.pluginId }));
	if (contract.version.trim().length === 0 || contract.manifest.version.trim().length === 0) return Result.err(pluginError("invalid_identifier", "plugin version must not be empty"));
	if (contract.manifest.version !== contract.version) return Result.err(pluginError("foundation_schema_invalid_shape", "plugin manifest and contract versions differ", { manifestVersion: contract.manifest.version, contractVersion: contract.version }));
	if (contract.manifest.name.trim().length === 0 || contract.manifest.entrypoint.trim().length === 0) return Result.err(pluginError("foundation_schema_invalid_shape", "plugin manifest name and entrypoint are required"));
	const expectedDigest = pluginManifestDigestV1(contract.manifest);
	if (expectedDigest.algorithm !== contract.digest.algorithm || expectedDigest.value !== contract.digest.value) return Result.err(pluginError("foundation_schema_invalid_shape", "plugin digest does not match its manifest", { pluginId: contract.pluginId }));
	if (contract.signature.trim().length === 0) return Result.err(pluginError("foundation_schema_invalid_shape", "plugin signature metadata is required"));
	const signatureMetadataError = validateSignatureMetadata(pkg.signatureMetadata);
	if (signatureMetadataError !== undefined) return Result.err(signatureMetadataError);
	const hookIds = validateUniqueIds(contract.hooks.map((hook) => hook.hookId), "plugin hooks");
	if (hookIds !== undefined) return Result.err(hookIds);
	const hookOrder = orderRuntimeHooksV1(contract.hooks.map(hookToSpec));
	if (!hookOrder.ok) return hookOrder;
	const serviceIds = validateUniqueIds(contract.serviceIds ?? [], "plugin services");
	if (serviceIds !== undefined) return Result.err(serviceIds);
	const profileIds = validateUniqueIds(contract.profileIds ?? [], "plugin profiles");
	if (profileIds !== undefined) return Result.err(profileIds);
	let packageSelector: ResourceSelectorV1 | undefined;
	if (parentMcpSelector !== undefined) {
		const parentResult = validateSelectorV1(parentMcpSelector);
		if (!parentResult.ok) return parentResult;
		packageSelector = parentResult.value;
	}
	if (pkg.mcpSelector !== undefined) {
		const packageResult = parentMcpSelector === undefined
			? validateSelectorV1(pkg.mcpSelector)
			: validateMcpSelectorTighteningV1(parentMcpSelector, pkg.mcpSelector);
		if (!packageResult.ok) return packageResult;
		packageSelector = packageResult.value;
	}
	const skillIds = (pkg.contents.skills ?? []).map((skill) => skill.skillId);
	const skillIdError = validateUniqueIds(skillIds, "plugin skills");
	if (skillIdError !== undefined) return Result.err(skillIdError);
	for (const skill of pkg.contents.skills ?? []) {
		if (skill.mcpSelector !== undefined) {
			const result = packageSelector === undefined ? validateSelectorV1(skill.mcpSelector) : validateMcpSelectorTighteningV1(packageSelector, skill.mcpSelector);
			if (!result.ok) return result;
		}
	}
	const mcpIds = (pkg.contents.mcpServers ?? []).map((server) => server.mcpServerId);
	const mcpIdError = validateUniqueIds(mcpIds, "plugin MCP servers");
	if (mcpIdError !== undefined) return Result.err(mcpIdError);
	for (const server of pkg.contents.mcpServers ?? []) {
		if (server.selector !== undefined) {
			const result = packageSelector === undefined ? validateSelectorV1(server.selector) : validateMcpSelectorTighteningV1(packageSelector, server.selector);
			if (!result.ok) return result;
		}
	}
	const agentIds = (pkg.contents.agents ?? []).map((agent) => agent.agentId);
	const agentIdError = validateUniqueIds(agentIds, "plugin agents");
	if (agentIdError !== undefined) return Result.err(agentIdError);
	for (const agent of pkg.contents.agents ?? []) {
		if (agent.mcpSelector !== undefined) {
			const result = packageSelector === undefined ? validateSelectorV1(agent.mcpSelector) : validateMcpSelectorTighteningV1(packageSelector, agent.mcpSelector);
			if (!result.ok) return result;
		}
	}
	for (const extension of pkg.contents.extensions ?? []) {
		const result = validateExtensionContractV1(extension);
		if (!result.ok) return result;
	}
	const lspIds = [...(pkg.contents.lsp ?? []).map((extension) => extension.extensionId), ...(pkg.contents.monitors ?? []).map((extension) => extension.extensionId)];
	const extensionIdError = validateUniqueIds(lspIds, "plugin extensions");
	if (extensionIdError !== undefined) return Result.err(extensionIdError);
	return Result.ok(undefined);
}

export const validatePluginPackageV1 = validateLocalPluginPackageV1;

/** Local Plugin v1 registry. No marketplace, hosted install, or implicit network behavior is exposed. */
export class LocalPluginRegistry {
	readonly #active = new Map<string, { package: LocalPluginPackageV1; record: PluginActivationRecordV1; scope: EffectScope }>();
	readonly #previous = new Map<string, { package: LocalPluginPackageV1; record: PluginActivationRecordV1 }>();
	readonly #stages: PluginStageReportV1[] = [];
	readonly #stageIds = new Map<string, string>();
	readonly #onStage: (report: PluginStageReportV1) => void | Promise<void>;
	readonly #onActivate: (pkg: LocalPluginPackageV1, context: PluginActivationContextV1) => void | Promise<void>;
	readonly #verifySignature: NonNullable<LocalPluginRegistryOptionsV1["verifySignature"]>;
	readonly #now: () => string;
	readonly #requireContentSignature: boolean;
	readonly #storage: LocalPluginRegistryStorageV1 | undefined;
	readonly #releaseReports = new Map<string, unknown>();

	constructor(options: LocalPluginRegistryOptionsV1 = {}) {
		this.#onStage = options.onStage ?? (() => undefined);
		this.#onActivate = options.onActivate ?? (() => undefined);
		this.#verifySignature = options.verifySignature ?? (() => Result.ok(undefined));
		this.#now = options.now ?? (() => new Date().toISOString());
		this.#requireContentSignature = options.requireContentSignature ?? true;
		this.#storage = options.storage;
	}

	static async open(options: LocalPluginRegistryOptionsV1 = {}): Promise<ResultValue<LocalPluginRegistry, FoundationError>> {
		const registry = new LocalPluginRegistry(options);
		const recovered = await registry.recover();
		return recovered.ok ? Result.ok(registry) : recovered;
	}

	/** Restore the last atomically committed activation pointer after restart. */
	async recover(): Promise<ResultValue<void, FoundationError>> {
		if (this.#storage === undefined) return Result.ok(undefined);
		let loaded: ResultValue<LocalPluginRegistrySnapshotV1 | undefined, FoundationError>;
		try {
			loaded = await this.#storage.load();
		} catch (error) {
			return Result.err(toFoundationError(error, "plugin_rollback_failed"));
		}
		if (!loaded.ok) return loaded;
		this.#active.clear();
		this.#previous.clear();
		this.#stageIds.clear();
		if (loaded.value === undefined) return Result.ok(undefined);
		const restored: Array<{ pluginId: string; value: { package: LocalPluginPackageV1; record: PluginActivationRecordV1; scope: EffectScope } }> = [];
		for (const entry of loaded.value.active) {
			const validation = this.validatePackageWithSignature(entry.package);
			if (!validation.ok) {
				for (const item of restored) await item.value.scope.rollback();
				return validation;
			}
			const activation = await this.createActivation(entry.package, entry.record.revision);
			if (!activation.ok) {
				for (const item of restored) await item.value.scope.rollback();
				return activation;
			}
			restored.push({ pluginId: entry.record.pluginId, value: { ...activation.value, record: clonePluginPersistence(entry.record) } });
		}
		for (const item of restored) this.#active.set(item.pluginId, item.value);
		for (const entry of loaded.value.previous) this.#previous.set(entry.record.pluginId, clonePluginPersistence(entry));
		for (const staged of loaded.value.staged) {
			const removed = await this.removeStageDurably(staged.stageId);
			if (!removed.ok) return removed;
		}
		return Result.ok(undefined);
	}

	/** Alias used by hosts that call restart handling restore rather than recover. */
	async restore(): Promise<ResultValue<void, FoundationError>> { return this.recover(); }

	has(pluginId: string): boolean { return this.#active.has(pluginId); }
	active(pluginId: string): PluginActivationRecordV1 | undefined { return this.#active.get(pluginId)?.record; }
	revision(pluginId: string): number { return this.#active.get(pluginId)?.record.revision ?? 0; }
	get stages(): readonly PluginStageReportV1[] { return [...this.#stages]; }
	get lastReleaseReports(): ReadonlyMap<string, unknown> { return new Map(this.#releaseReports); }
	activePackages(): readonly LocalPluginPackageV1[] {
		return [...this.#active.keys()].sort().map((pluginId) => this.#active.get(pluginId)!.package);
	}

	async stage(pkg: LocalPluginPackageV1, operation: PluginLifecycleOperationV1 = this.#active.has(pkg.contract.pluginId) ? "update" : "install", revision = this.revision(pkg.contract.pluginId) + 1): Promise<ResultValue<PluginStageReportV1, FoundationError>> {
		const validation = this.validatePackageWithSignature(pkg);
		if (!validation.ok) return validation;
		const report: PluginStageReportV1 = { schemaVersion: FOUNDATION_SCHEMA_VERSION, operation, pluginId: pkg.contract.pluginId, revision, staged: true, rejected: [] };
		try {
			await this.#onStage(report);
		} catch (error) {
			return Result.err(toFoundationError(error, "plugin_rollback_failed"));
		}
		const stageId = this.stageId(pkg, revision);
		const durable = await this.stageDurably({ stageId, operation, pluginId: pkg.contract.pluginId, revision, package: pkg, stagedAt: this.#now() });
		if (!durable.ok) return durable;
		this.#stages.push(report);
		this.#stageIds.set(this.stageKey(pkg.contract.pluginId, revision), stageId);
		return Result.ok(report);
	}

	async install(pkg: LocalPluginPackageV1): Promise<ResultValue<PluginLifecycleResultV1, FoundationError>> {
		const validation = this.validatePackageWithSignature(pkg);
		if (!validation.ok) return validation;
		if (this.#active.has(pkg.contract.pluginId)) return Result.err(pluginError("plugin_rollback_failed", "cannot install a plugin that is already installed", { pluginId: pkg.contract.pluginId }));
		return this.activateNew("install", pkg, 1);
	}

	async update(pkg: LocalPluginPackageV1): Promise<ResultValue<PluginLifecycleResultV1, FoundationError>> {
		const validation = this.validatePackageWithSignature(pkg);
		if (!validation.ok) return validation;
		const current = this.#active.get(pkg.contract.pluginId);
		if (current === undefined) return Result.err(pluginError("plugin_rollback_failed", "cannot update a plugin that is not installed", { pluginId: pkg.contract.pluginId }));
		return this.activateNew("update", pkg, current.record.revision + 1);
	}

	async uninstall(pluginId: string): Promise<ResultValue<PluginLifecycleResultV1, FoundationError>> {
		const current = this.#active.get(pluginId);
		if (current === undefined) return Result.err(pluginError("plugin_rollback_failed", "cannot uninstall a plugin that is not installed", { pluginId }));
		const stage = await this.stage(current.package, "uninstall", current.record.revision);
		if (!stage.ok) return stage;
		const oldPrevious = this.#previous.get(pluginId);
		const stageId = this.#stageIds.get(this.stageKey(pluginId, current.record.revision));
		const switched = await this.atomicSwitchDurably({ pluginId, previous: { package: current.package, record: current.record }, stageId, state: "uninstalled" });
		if (!switched.ok) {
			if (stageId !== undefined) await this.removeStageDurably(stageId);
			return switched;
		}
		this.#previous.set(pluginId, { package: current.package, record: current.record });
		this.#active.delete(pluginId);
		const release = await current.scope.dispose();
		this.#releaseReports.set(pluginId, release);
		if (release.failures.length > 0) {
			const restored = await this.createActivation(current.package, current.record.revision);
			if (restored.ok) {
				const restoredValue = { ...restored.value, record: current.record };
				const restoredDurably = await this.atomicSwitchDurably({ pluginId, active: { package: current.package, record: current.record }, ...(oldPrevious === undefined ? {} : { previous: oldPrevious }), state: "active" });
				if (restoredDurably.ok) this.#active.set(pluginId, restoredValue);
				else await restoredValue.scope.rollback();
			}
			if (oldPrevious === undefined) this.#previous.delete(pluginId);
			else this.#previous.set(pluginId, oldPrevious);
			return Result.err(pluginError("plugin_rollback_failed", "plugin uninstall cleanup failed", { pluginId }));
		}
		this.#stageIds.delete(this.stageKey(pluginId, current.record.revision));
		return Result.ok({ schemaVersion: FOUNDATION_SCHEMA_VERSION, operation: "uninstall", pluginId, revision: current.record.revision, applied: true });
	}

	async rollback(pluginId: string): Promise<ResultValue<PluginLifecycleResultV1, FoundationError>> {
		const previous = this.#previous.get(pluginId);
		if (previous === undefined) return Result.err(pluginError("plugin_rollback_failed", "no previous plugin revision is available", { pluginId }));
		const current = this.#active.get(pluginId);
		const nextRevision = (current?.record.revision ?? previous.record.revision) + 1;
		const validation = this.validatePackageWithSignature(previous.package);
		if (!validation.ok) return validation;
		const stage = await this.stage(previous.package, "rollback", nextRevision);
		if (!stage.ok) return stage;
		const activated = await this.createActivation(previous.package, nextRevision);
		const stageId = this.#stageIds.get(this.stageKey(pluginId, nextRevision));
		if (!activated.ok) {
			if (stageId !== undefined) await this.removeStageDurably(stageId);
			return activated;
		}
		const switched = await this.atomicSwitchDurably({ pluginId, active: { package: previous.package, record: activated.value.record }, stageId, state: "active" });
		if (!switched.ok) {
			await activated.value.scope.rollback();
			if (stageId !== undefined) await this.removeStageDurably(stageId);
			return switched;
		}
		this.#active.set(pluginId, activated.value);
		if (current !== undefined) {
			const release = await current.scope.dispose();
			this.#releaseReports.set(pluginId, release);
			if (release.failures.length > 0) {
				const failedActivationRelease = await activated.value.scope.dispose();
				this.#releaseReports.set(pluginId, failedActivationRelease);
				const restored = await this.createActivation(current.package, current.record.revision);
				if (restored.ok) {
					const restoredDurably = await this.atomicSwitchDurably({ pluginId, active: { package: current.package, record: current.record }, state: "active" });
					if (restoredDurably.ok) this.#active.set(pluginId, { ...restored.value, record: current.record });
					else await restored.value.scope.rollback();
				} else this.#active.delete(pluginId);
				return Result.err(pluginError("plugin_rollback_failed", "plugin rollback cleanup failed", { pluginId }));
			}
		}
		this.#previous.delete(pluginId);
		this.#stageIds.delete(this.stageKey(pluginId, nextRevision));
		return Result.ok({ schemaVersion: FOUNDATION_SCHEMA_VERSION, operation: "rollback", pluginId, revision: nextRevision, applied: true });
	}

	private validatePackageWithSignature(pkg: LocalPluginPackageV1): ResultValue<void, FoundationError> {
		const packageResult = validateLocalPluginPackageV1(pkg);
		if (!packageResult.ok) return packageResult;
		const contentsDigest = pluginContentsDigestV1(pkg.contents);
		if (this.#requireContentSignature && pkg.signatureMetadata?.contentDigest === undefined) return Result.err(pluginError("plugin_rollback_failed", "plugin content signature is required"));
		if (pkg.signatureMetadata?.contentDigest !== undefined && (pkg.signatureMetadata.contentDigest.algorithm !== contentsDigest.algorithm || pkg.signatureMetadata.contentDigest.value !== contentsDigest.value)) return Result.err(pluginError("plugin_rollback_failed", "plugin contents do not match the signed digest"));
		const signature = this.#verifySignature(pkg.contract, pkg.signatureMetadata, contentsDigest);
		return signature.ok ? Result.ok(undefined) : signature;
	}

	private async activateNew(operation: "install" | "update", pkg: LocalPluginPackageV1, revision: number): Promise<ResultValue<PluginLifecycleResultV1, FoundationError>> {
		const stage = await this.stage(pkg, operation, revision);
		if (!stage.ok) return stage;
		const activated = await this.createActivation(pkg, revision);
		const current = this.#active.get(pkg.contract.pluginId);
		const oldPrevious = this.#previous.get(pkg.contract.pluginId);
		const stageId = this.#stageIds.get(this.stageKey(pkg.contract.pluginId, revision));
		if (!activated.ok) {
			if (stageId !== undefined) await this.removeStageDurably(stageId);
			return activated;
		}
		const switched = await this.atomicSwitchDurably({
			pluginId: pkg.contract.pluginId,
			active: { package: pkg, record: activated.value.record },
			...(current === undefined ? {} : { previous: { package: current.package, record: current.record } }),
			stageId,
			state: "active",
		});
		if (!switched.ok) {
			await activated.value.scope.rollback();
			if (stageId !== undefined) await this.removeStageDurably(stageId);
			return switched;
		}
		if (current !== undefined) this.#previous.set(pkg.contract.pluginId, { package: current.package, record: current.record });
		this.#active.set(pkg.contract.pluginId, activated.value);
		if (current !== undefined) {
			const release = await current.scope.dispose();
			this.#releaseReports.set(pkg.contract.pluginId, release);
			if (release.failures.length > 0) {
				const failedActivationRelease = await activated.value.scope.dispose();
				this.#releaseReports.set(pkg.contract.pluginId, failedActivationRelease);
				const restored = await this.createActivation(current.package, current.record.revision);
				if (restored.ok) {
					const restoredDurably = await this.atomicSwitchDurably({
						pluginId: pkg.contract.pluginId,
						active: { package: current.package, record: current.record },
						...(oldPrevious === undefined ? {} : { previous: oldPrevious }),
						state: "active",
					});
					if (restoredDurably.ok) this.#active.set(pkg.contract.pluginId, { ...restored.value, record: current.record });
					else await restored.value.scope.rollback();
				} else this.#active.delete(pkg.contract.pluginId);
				if (oldPrevious === undefined) this.#previous.delete(pkg.contract.pluginId);
				else this.#previous.set(pkg.contract.pluginId, oldPrevious);
				return Result.err(pluginError("plugin_rollback_failed", "plugin update cleanup failed", { pluginId: pkg.contract.pluginId }));
			}
		}
		this.#stageIds.delete(this.stageKey(pkg.contract.pluginId, revision));
		return Result.ok({ schemaVersion: FOUNDATION_SCHEMA_VERSION, operation, pluginId: pkg.contract.pluginId, revision, applied: true });
	}

	private stageKey(pluginId: string, revision: number): string { return `${pluginId}:${revision}`; }

	private stageId(pkg: LocalPluginPackageV1, revision: number): string {
		return `${pkg.contract.pluginId}:${revision}:${pluginContentsDigestV1(pkg.contents).value}`;
	}

	private async stageDurably(record: PluginRegistryStagedPackageV1): Promise<ResultValue<void, FoundationError>> {
		if (this.#storage === undefined) return Result.ok(undefined);
		try {
			const result = await this.#storage.stagePackage(record);
			return result.ok ? Result.ok(undefined) : result;
		} catch (error) {
			return Result.err(toFoundationError(error, "plugin_rollback_failed"));
		}
	}

	private async atomicSwitchDurably(change: PluginRegistryAtomicSwitchV1): Promise<ResultValue<void, FoundationError>> {
		if (this.#storage === undefined) return Result.ok(undefined);
		try {
			const result = await this.#storage.atomicSwitch(change);
			return result.ok ? Result.ok(undefined) : result;
		} catch (error) {
			return Result.err(toFoundationError(error, "plugin_rollback_failed"));
		}
	}

	private async removeStageDurably(stageId: string): Promise<ResultValue<void, FoundationError>> {
		if (this.#storage === undefined) return Result.ok(undefined);
		try {
			const result = await this.#storage.removeStage(stageId);
			return result.ok ? Result.ok(undefined) : result;
		} catch (error) {
			return Result.err(toFoundationError(error, "plugin_rollback_failed"));
		}
	}

	private async createActivation(pkg: LocalPluginPackageV1, revision: number): Promise<ResultValue<{ package: LocalPluginPackageV1; record: PluginActivationRecordV1; scope: EffectScope }, FoundationError>> {
		const scope = new EffectScope();
		const context: PluginActivationContextV1 = { scope, register: (kind, resourceId, dispose) => scope.register(kind, resourceId, dispose) };
		const registrations = registerDeclaredPluginResources(pkg, scope);
		if (!registrations.ok) {
			await scope.rollback();
			return registrations;
		}
		try {
			await this.#onActivate(pkg, context);
		} catch (error) {
			await scope.rollback();
			return Result.err(toFoundationError(error, "plugin_rollback_failed"));
		}
		return Result.ok({
			package: pkg,
			record: {
				schemaVersion: FOUNDATION_SCHEMA_VERSION,
				pluginId: pkg.contract.pluginId,
				revision,
				namespace: pkg.contract.namespace,
				version: pkg.contract.version,
				digest: pkg.contract.digest,
				contentDigest: pluginContentsDigestV1(pkg.contents),
				signature: pkg.contract.signature,
				...(pkg.signatureMetadata === undefined ? {} : { signatureMetadata: pkg.signatureMetadata }),
				activatedAt: this.#now(),
			},
			scope,
		});
	}
}

function registerDeclaredPluginResources(pkg: LocalPluginPackageV1, scope: EffectScope): ResultValue<void, FoundationError> {
	for (const hook of pkg.contract.hooks) {
		const result = scope.register("hook", `hook:${pkg.contract.pluginId}:${hook.hookId}`, () => undefined);
		if (!result.ok) return result;
	}
	for (const server of pkg.contents.mcpServers ?? []) {
		const result = scope.register("mcp", `mcp:${pkg.contract.pluginId}:${server.mcpServerId}`, () => undefined);
		if (!result.ok) return result;
	}
	for (const extension of pkg.contents.lsp ?? []) {
		const result = scope.register("lsp", `lsp:${pkg.contract.pluginId}:${extension.extensionId}`, () => undefined);
		if (!result.ok) return result;
	}
	for (const extension of pkg.contents.monitors ?? []) {
		const result = scope.register("monitor", `monitor:${pkg.contract.pluginId}:${extension.extensionId}`, () => undefined);
		if (!result.ok) return result;
	}
	for (const bin of pkg.contents.bin ?? []) {
		const result = scope.register("bin", `bin:${pkg.contract.pluginId}:${bin.name}`, () => undefined);
		if (!result.ok) return result;
	}
	for (const [index] of (pkg.contents.settings ?? []).entries()) {
		const result = scope.register("settings", `settings:${pkg.contract.pluginId}:${index}`, () => undefined);
		if (!result.ok) return result;
	}
	for (const agent of pkg.contents.agents ?? []) {
		const result = scope.register("process", `agent:${pkg.contract.pluginId}:${agent.agentId}`, () => undefined);
		if (!result.ok) return result;
	}
	return Result.ok(undefined);
}

/** Deterministic canonical manifest serialization for signatures and tests. */
export function canonicalPluginManifestV1(contract: PluginContractV1): string {
	return canonicalFoundationJson(contract.manifest);
}

export function isLocalPluginPackageV1(pkg: LocalPluginPackageV1): boolean {
	return pkg.source === "local" && validateLocalPluginPackageV1(pkg).ok;
}
