/** Local-only Plugin v1 manifest, staging, activation, and rollback lifecycle. */
import { Type, type TSchema } from "typebox";
import { ExtensionContractSchema, validateExtensionContract, type ExtensionContract, type LspExtensionContract, type MonitorExtensionContract } from "./foundation/profile.ts";
import { FoundationError, toFoundationError } from "./foundation/errors.ts";
import { FOUNDATION_SCHEMA_VERSION, canonicalFoundationJson, fingerprintFoundationValue, type Fingerprint } from "./foundation/identity.ts";
import type { FoundationJsonValue } from "./foundation/event-catalog.ts";
import { PluginContractSchema, type PluginContract, type PluginHook, type PluginLifecycleOperation, type PluginLifecycleResult } from "./foundation/plugin.ts";
import { ResourceSelectorSchema, type ResourceSelector } from "./foundation/reference.ts";
import { FingerprintSchema, validateExactShape } from "./foundation/schema.ts";
import { EffectScope, orderRuntimeHooks, type EffectDisposer, type EffectResourceKind, type RuntimeHookSpec } from "./runtime-services.ts";
import { validateMcpSelectorTightening, validateSelector } from "./profile.ts";
import { Result, type Result as ResultValue } from "./result.ts";
import type { FileError, FileSystem } from "./types.ts";

export type PluginPackageSource = "local" | "remote" | "hosted";

export interface PluginSignatureMetadata {
	algorithm: string;
	keyId: string;
	value: string;
	signedAt?: string;
	/** Signature input digest for the complete package contents, not only the manifest. */
	contentDigest?: Fingerprint;
}

export interface PluginSkillRef {
	skillId: string;
	/** The skill may only tighten the package's parent MCP scope. */
	mcpSelector?: ResourceSelector;
}

export interface PluginMCPRef {
	mcpServerId: string;
	selector?: ResourceSelector;
}

export interface PluginAgentRef {
	agentId: string;
	mcpSelector?: ResourceSelector;
}

export interface PluginBinEntry {
	name: string;
	command: string;
}

export interface PluginSettingsPatch {
	values: Readonly<Record<string, string | number | boolean>>;
}

export interface PluginPackageContents {
	skills?: readonly PluginSkillRef[];
	extensions?: readonly ExtensionContract[];
	mcpServers?: readonly PluginMCPRef[];
	agents?: readonly PluginAgentRef[];
	lsp?: readonly LspExtensionContract[];
	monitors?: readonly MonitorExtensionContract[];
	bin?: readonly PluginBinEntry[];
	settings?: readonly PluginSettingsPatch[];
}

export interface LocalPluginPackage {
	schemaVersion: typeof FOUNDATION_SCHEMA_VERSION;
	contract: PluginContract;
	contents: PluginPackageContents;
	source: PluginPackageSource;
	sourcePath?: string;
	signatureMetadata?: PluginSignatureMetadata;
	/** Parent MCP scope inherited by all child/executor declarations in this package. */
	mcpSelector?: ResourceSelector;
}

export interface PluginRejectedSource {
	source: string;
	reason: string;
}

export interface PluginStageReport {
	schemaVersion: typeof FOUNDATION_SCHEMA_VERSION;
	operation: PluginLifecycleOperation;
	pluginId: string;
	revision: number;
	staged: boolean;
	rejected: readonly PluginRejectedSource[];
}

export interface PluginActivationRecord {
	schemaVersion: typeof FOUNDATION_SCHEMA_VERSION;
	pluginId: string;
	revision: number;
	namespace: string;
	version: string;
	digest: Fingerprint;
	contentDigest?: Fingerprint;
	signature: string;
	signatureMetadata?: PluginSignatureMetadata;
	activatedAt: string;
}

export interface CreatePluginContractInput {
	namespace: string;
	pluginId: string;
	version: string;
	manifest: PluginContract["manifest"];
	signature: string;
	hooks?: readonly PluginHook[];
	features?: readonly string[];
	serviceIds?: readonly string[];
	profileIds?: readonly string[];
	rollbackSupported?: boolean;
}

export interface PluginActivationContext {
	scope: EffectScope;
	register(kind: EffectResourceKind, resourceId: string, dispose: EffectDisposer): ResultValue<string, FoundationError>;
}

export interface LocalPluginRegistryOptions {
	onStage?: (report: PluginStageReport) => void | Promise<void>;
	/** Hook for provider composition. This module never starts hosted services itself. */
	onActivate?: (pkg: LocalPluginPackage, context: PluginActivationContext) => void | Promise<void>;
	verifySignature?: (contract: PluginContract, metadata?: PluginSignatureMetadata, contentsDigest?: Fingerprint) => ResultValue<void, FoundationError>;
	requireContentSignature?: boolean;
	now?: () => string;
	/** Durable local storage. Its atomicSwitch operation is the activation pointer commit. */
	storage?: LocalPluginRegistryStorage;
}

export interface PluginRegistryStoredActivation {
	package: LocalPluginPackage;
	record: PluginActivationRecord;
}

export interface PluginRegistryStagedPackage {
	stageId: string;
	operation: PluginLifecycleOperation;
	pluginId: string;
	revision: number;
	package: LocalPluginPackage;
	stagedAt: string;
}

export interface PluginRegistryActivationPointer {
	pluginId: string;
	state: "active" | "uninstalled";
	stageId?: string;
	generation: number;
}

export interface LocalPluginRegistrySnapshot {
	schemaVersion: typeof FOUNDATION_SCHEMA_VERSION;
	generation: number;
	active: readonly PluginRegistryStoredActivation[];
	previous: readonly PluginRegistryStoredActivation[];
	staged: readonly PluginRegistryStagedPackage[];
	pointers: readonly PluginRegistryActivationPointer[];
}

export interface PluginRegistryAtomicSwitch {
	pluginId: string;
	active?: PluginRegistryStoredActivation;
	previous?: PluginRegistryStoredActivation;
	stageId?: string;
	state: "active" | "uninstalled";
}

const pluginSignatureMetadataSchema = Type.Object({
	algorithm: Type.String({ minLength: 1 }),
	keyId: Type.String({ minLength: 1 }),
	value: Type.String({ minLength: 1 }),
	signedAt: Type.Optional(Type.String()),
	contentDigest: Type.Optional(FingerprintSchema),
}, { additionalProperties: false });
const pluginSkillRefSchema = Type.Object({ skillId: Type.String({ minLength: 1 }), mcpSelector: Type.Optional(ResourceSelectorSchema) }, { additionalProperties: false });
const pluginMcpRefSchema = Type.Object({ mcpServerId: Type.String({ minLength: 1 }), selector: Type.Optional(ResourceSelectorSchema) }, { additionalProperties: false });
const pluginAgentRefSchema = Type.Object({ agentId: Type.String({ minLength: 1 }), mcpSelector: Type.Optional(ResourceSelectorSchema) }, { additionalProperties: false });
const pluginBinEntrySchema = Type.Object({ name: Type.String({ minLength: 1 }), command: Type.String({ minLength: 1 }) }, { additionalProperties: false });
const pluginSettingsPatchSchema = Type.Object({ values: Type.Record(Type.String({ minLength: 1 }), Type.Union([Type.String(), Type.Number(), Type.Boolean()])) }, { additionalProperties: false });
const pluginLspExtensionSchema = Type.Object({
	schemaVersion: Type.Literal(FOUNDATION_SCHEMA_VERSION),
	extensionId: Type.String({ minLength: 1 }),
	kind: Type.Literal("lsp"),
	version: Type.String({ minLength: 1 }),
	languageIds: Type.Array(Type.String({ minLength: 1 })),
	serverCommand: Type.String({ minLength: 1 }),
	initializationOptionsRef: Type.Optional(Type.String({ minLength: 1 })),
}, { additionalProperties: false });
const pluginMonitorExtensionSchema = Type.Object({
	schemaVersion: Type.Literal(FOUNDATION_SCHEMA_VERSION),
	extensionId: Type.String({ minLength: 1 }),
	kind: Type.Literal("monitor"),
	version: Type.String({ minLength: 1 }),
	eventKinds: Type.Array(Type.String({ minLength: 1 })),
	intervalMs: Type.Integer({ minimum: 1 }),
	healthCheck: Type.String({ minLength: 1 }),
}, { additionalProperties: false });
const pluginPackageContentsSchema = Type.Object({
	skills: Type.Optional(Type.Array(pluginSkillRefSchema)),
	extensions: Type.Optional(Type.Array(ExtensionContractSchema)),
	mcpServers: Type.Optional(Type.Array(pluginMcpRefSchema)),
	agents: Type.Optional(Type.Array(pluginAgentRefSchema)),
	lsp: Type.Optional(Type.Array(pluginLspExtensionSchema)),
	monitors: Type.Optional(Type.Array(pluginMonitorExtensionSchema)),
	bin: Type.Optional(Type.Array(pluginBinEntrySchema)),
	settings: Type.Optional(Type.Array(pluginSettingsPatchSchema)),
}, { additionalProperties: false });
const localPluginPackageSchema = Type.Object({
	schemaVersion: Type.Literal(FOUNDATION_SCHEMA_VERSION),
	contract: PluginContractSchema,
	contents: pluginPackageContentsSchema,
	source: Type.Union([Type.Literal("local"), Type.Literal("remote"), Type.Literal("hosted")]),
	sourcePath: Type.Optional(Type.String()),
	signatureMetadata: Type.Optional(pluginSignatureMetadataSchema),
	mcpSelector: Type.Optional(ResourceSelectorSchema),
}, { additionalProperties: false });
const pluginActivationRecordSchema = Type.Object({
	schemaVersion: Type.Literal(FOUNDATION_SCHEMA_VERSION),
	pluginId: Type.String({ minLength: 1 }),
	revision: Type.Integer({ minimum: 1 }),
	namespace: Type.String({ minLength: 1 }),
	version: Type.String({ minLength: 1 }),
	digest: FingerprintSchema,
	contentDigest: Type.Optional(FingerprintSchema),
	signature: Type.String({ minLength: 1 }),
	signatureMetadata: Type.Optional(pluginSignatureMetadataSchema),
	activatedAt: Type.String({ minLength: 1 }),
}, { additionalProperties: false });
const pluginStoredActivationSchema = Type.Object({ package: localPluginPackageSchema, record: pluginActivationRecordSchema }, { additionalProperties: false });
const pluginLifecycleOperationSchema = Type.Union([Type.Literal("install"), Type.Literal("update"), Type.Literal("uninstall"), Type.Literal("rollback")]);
const pluginStagedPackageSchema = Type.Object({
	stageId: Type.String({ minLength: 1 }),
	operation: pluginLifecycleOperationSchema,
	pluginId: Type.String({ minLength: 1 }),
	revision: Type.Integer({ minimum: 1 }),
	package: localPluginPackageSchema,
	stagedAt: Type.String({ minLength: 1 }),
}, { additionalProperties: false });
const pluginActivationPointerSchema = Type.Object({
	pluginId: Type.String({ minLength: 1 }),
	state: Type.Union([Type.Literal("active"), Type.Literal("uninstalled")]),
	stageId: Type.Optional(Type.String({ minLength: 1 })),
	generation: Type.Integer({ minimum: 1 }),
}, { additionalProperties: false });
const pluginRegistrySnapshotSchema = Type.Object({
	schemaVersion: Type.Literal(FOUNDATION_SCHEMA_VERSION),
	generation: Type.Integer({ minimum: 0 }),
	active: Type.Array(pluginStoredActivationSchema),
	previous: Type.Array(pluginStoredActivationSchema),
	staged: Type.Array(pluginStagedPackageSchema),
	pointers: Type.Array(pluginActivationPointerSchema),
}, { additionalProperties: false });
const pluginRegistryDiskPointerSchema = Type.Object({
	schemaVersion: Type.Literal(FOUNDATION_SCHEMA_VERSION),
	generation: Type.Integer({ minimum: 1 }),
	snapshotFile: Type.String({ minLength: 1 }),
}, { additionalProperties: false });

/**
 * Storage deliberately exposes a single atomic pointer switch. A caller may
 * recover after a process restart by loading the last complete snapshot; an
 * orphaned staged package is safe to remove without touching the active one.
 */
export interface LocalPluginRegistryStorage {
	load(): Promise<ResultValue<LocalPluginRegistrySnapshot | undefined, FoundationError>>;
	stagePackage(record: PluginRegistryStagedPackage): Promise<ResultValue<void, FoundationError>>;
	atomicSwitch(change: PluginRegistryAtomicSwitch): Promise<ResultValue<void, FoundationError>>;
	removeStage(stageId: string): Promise<ResultValue<void, FoundationError>>;
}

function clonePluginPersistence<T>(value: T): T {
	return JSON.parse(canonicalFoundationJson(value)) as T;
}

/** In-memory durable adapter used by hosts and conformance tests. */
export class InMemoryLocalPluginRegistryStorage implements LocalPluginRegistryStorage {
	#snapshot: LocalPluginRegistrySnapshot = { schemaVersion: FOUNDATION_SCHEMA_VERSION, generation: 0, active: [], previous: [], staged: [], pointers: [] };

	get snapshot(): LocalPluginRegistrySnapshot { return clonePluginPersistence(this.#snapshot); }

	async load(): Promise<ResultValue<LocalPluginRegistrySnapshot, FoundationError>> {
		return Result.ok(clonePluginPersistence(this.#snapshot));
	}

	async stagePackage(record: PluginRegistryStagedPackage): Promise<ResultValue<void, FoundationError>> {
		const generation = this.#snapshot.generation + 1;
		const staged = [...this.#snapshot.staged.filter((item) => item.stageId !== record.stageId), clonePluginPersistence(record)];
		this.#snapshot = { ...this.#snapshot, generation, staged, pointers: this.#snapshot.pointers.map((pointer) => ({ ...pointer, generation })) };
		return Result.ok(undefined);
	}

	async atomicSwitch(change: PluginRegistryAtomicSwitch): Promise<ResultValue<void, FoundationError>> {
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
			pointers: [...pointers.map((pointer) => ({ ...pointer, generation: nextGeneration })), { pluginId: change.pluginId, state: change.state, ...(change.stageId === undefined ? {} : { stageId: change.stageId }), generation: nextGeneration }],
		};
		return Result.ok(undefined);
	}

	async removeStage(stageId: string): Promise<ResultValue<void, FoundationError>> {
		const generation = this.#snapshot.generation + 1;
		this.#snapshot = { ...this.#snapshot, generation, staged: this.#snapshot.staged.filter((item) => item.stageId !== stageId), pointers: this.#snapshot.pointers.map((pointer) => ({ ...pointer, generation })) };
		return Result.ok(undefined);
	}
}

interface PluginRegistryDiskPointerV1 {
	schemaVersion: typeof FOUNDATION_SCHEMA_VERSION;
	generation: number;
	snapshotFile: string;
}

const PLUGIN_REGISTRY_POINTER_FILE = "activation-pointer.json";
const PLUGIN_REGISTRY_SNAPSHOT_DIRECTORY = "snapshots";

/** Atomic local-file capabilities required by the durable Plugin v1 registry. */
export interface LocalPluginRegistryFileSystem extends Pick<FileSystem, "joinPath" | "readTextFile" | "renameFile" | "createDir" | "remove" | "exists"> {
	createExclusive(path: string, content: string): Promise<ResultValue<void, FileError>>;
	syncFile(path: string): Promise<ResultValue<void, FileError>>;
	syncDirectory(path: string): Promise<ResultValue<void, FileError>>;
}

function emptyPluginRegistrySnapshot(): LocalPluginRegistrySnapshot {
	return { schemaVersion: FOUNDATION_SCHEMA_VERSION, generation: 0, active: [], previous: [], staged: [], pointers: [] };
}

function fingerprintMatches(left: Fingerprint | undefined, right: Fingerprint): boolean {
	return left?.algorithm === right.algorithm && left.value === right.value;
}

function durableRegistryShape<T>(schema: TSchema, value: unknown, kind: string): ResultValue<T, FoundationError> {
	try {
		return validateExactShape<T>(schema, value, kind, "plugin_rollback_failed");
	} catch (error) {
		return Result.err(toFoundationError(error, "plugin_rollback_failed"));
	}
}

function validateDurablePluginPackage(value: unknown, kind: string): ResultValue<LocalPluginPackage, FoundationError> {
	const shape = durableRegistryShape<LocalPluginPackage>(localPluginPackageSchema, value, kind);
	if (!shape.ok) return shape;
	try {
		const packageResult = validateLocalPluginPackage(shape.value);
		if (!packageResult.ok) return packageResult;
		const contentsDigest = pluginContentsDigest(shape.value.contents);
		if (shape.value.signatureMetadata?.contentDigest !== undefined && !fingerprintMatches(shape.value.signatureMetadata.contentDigest, contentsDigest)) {
			return Result.err(pluginError("plugin_rollback_failed", "durable plugin content digest does not match its package"));
		}
		return Result.ok(clonePluginPersistence(shape.value));
	} catch (error) {
		return Result.err(toFoundationError(error, "plugin_rollback_failed"));
	}
}

function validateDurableStoredActivation(value: unknown, kind: string): ResultValue<PluginRegistryStoredActivation, FoundationError> {
	const shape = durableRegistryShape<PluginRegistryStoredActivation>(pluginStoredActivationSchema, value, kind);
	if (!shape.ok) return shape;
	const packageResult = validateDurablePluginPackage(shape.value.package, `${kind}.package`);
	if (!packageResult.ok) return packageResult;
	const record = shape.value.record;
	const pkg = packageResult.value;
	const expectedContentDigest = pluginContentsDigest(pkg.contents);
	if (
		!Number.isSafeInteger(record.revision)
		|| record.pluginId !== pkg.contract.pluginId
		|| record.namespace !== pkg.contract.namespace
		|| record.version !== pkg.contract.version
		|| !fingerprintMatches(record.digest, pkg.contract.digest)
		|| record.contentDigest === undefined
		|| !fingerprintMatches(record.contentDigest, expectedContentDigest)
		|| record.signature !== pkg.contract.signature
		|| canonicalFoundationJson(record.signatureMetadata ?? null) !== canonicalFoundationJson(pkg.signatureMetadata ?? null)
	) return Result.err(pluginError("plugin_rollback_failed", "durable plugin activation record does not match its package"));
	return Result.ok({ package: pkg, record: clonePluginPersistence(record) });
}

function validateDurableStagedPackage(value: unknown, kind: string): ResultValue<PluginRegistryStagedPackage, FoundationError> {
	const shape = durableRegistryShape<PluginRegistryStagedPackage>(pluginStagedPackageSchema, value, kind);
	if (!shape.ok) return shape;
	const packageResult = validateDurablePluginPackage(shape.value.package, `${kind}.package`);
	if (!packageResult.ok) return packageResult;
	const expectedStageId = `${packageResult.value.contract.pluginId}:${shape.value.revision}:${pluginContentsDigest(packageResult.value.contents).value}`;
	if (
		shape.value.pluginId !== packageResult.value.contract.pluginId
		|| !Number.isSafeInteger(shape.value.revision)
		|| shape.value.stageId !== expectedStageId
	) {
		return Result.err(pluginError("plugin_rollback_failed", "durable staged plugin identity does not match its package"));
	}
	return Result.ok({ ...shape.value, package: packageResult.value });
}

function validateDurableActivationPointer(value: unknown, kind: string): ResultValue<PluginRegistryActivationPointer, FoundationError> {
	const shape = durableRegistryShape<PluginRegistryActivationPointer>(pluginActivationPointerSchema, value, kind);
	if (!shape.ok) return shape;
	return Number.isSafeInteger(shape.value.generation) && shape.value.generation >= 1
		? Result.ok(shape.value)
		: Result.err(pluginError("plugin_rollback_failed", "durable plugin activation pointer generation is invalid"));
}

function validatePluginRegistrySnapshot(value: unknown, expectedGeneration?: number): ResultValue<LocalPluginRegistrySnapshot, FoundationError> {
	const shape = durableRegistryShape<LocalPluginRegistrySnapshot>(pluginRegistrySnapshotSchema, value, "plugin registry snapshot");
	if (!shape.ok) return shape;
	try {
		if (!Number.isSafeInteger(shape.value.generation) || shape.value.generation < 0 || (expectedGeneration !== undefined && shape.value.generation !== expectedGeneration)) {
			return Result.err(pluginError("plugin_rollback_failed", "plugin registry snapshot generation is invalid"));
		}
		const active: PluginRegistryStoredActivation[] = [];
		const previous: PluginRegistryStoredActivation[] = [];
		const staged: PluginRegistryStagedPackage[] = [];
		const activeIds = new Set<string>();
		const previousIds = new Set<string>();
		const stagedIds = new Set<string>();
		for (const [index, entry] of shape.value.active.entries()) {
			const validated = validateDurableStoredActivation(entry, `plugin registry snapshot active[${index}]`);
			if (!validated.ok) return validated;
			if (activeIds.has(validated.value.record.pluginId)) return Result.err(pluginError("plugin_rollback_failed", "plugin registry snapshot contains duplicate active plugin identities"));
			activeIds.add(validated.value.record.pluginId);
			active.push(validated.value);
		}
		for (const [index, entry] of shape.value.previous.entries()) {
			const validated = validateDurableStoredActivation(entry, `plugin registry snapshot previous[${index}]`);
			if (!validated.ok) return validated;
			if (previousIds.has(validated.value.record.pluginId)) return Result.err(pluginError("plugin_rollback_failed", "plugin registry snapshot contains duplicate previous plugin identities"));
			previousIds.add(validated.value.record.pluginId);
			previous.push(validated.value);
		}
		for (const [index, entry] of shape.value.staged.entries()) {
			const validated = validateDurableStagedPackage(entry, `plugin registry snapshot staged[${index}]`);
			if (!validated.ok) return validated;
			if (stagedIds.has(validated.value.stageId)) return Result.err(pluginError("plugin_rollback_failed", "plugin registry snapshot contains duplicate staged identities"));
			stagedIds.add(validated.value.stageId);
			staged.push(validated.value);
		}
		const pointers = new Map<string, PluginRegistryActivationPointer>();
		for (const [index, entry] of shape.value.pointers.entries()) {
			const validated = validateDurableActivationPointer(entry, `plugin registry snapshot pointers[${index}]`);
			if (!validated.ok) return validated;
			if (validated.value.generation > shape.value.generation || pointers.has(validated.value.pluginId)) return Result.err(pluginError("plugin_rollback_failed", "plugin registry snapshot contains an invalid activation pointer"));
			pointers.set(validated.value.pluginId, validated.value);
		}
		const stateIds = new Set<string>([...activeIds, ...previousIds]);
		if (stateIds.size !== pointers.size || [...stateIds].some((pluginId) => !pointers.has(pluginId))) return Result.err(pluginError("plugin_rollback_failed", "plugin registry snapshot pointers do not match plugin state"));
		for (const [pluginId, pointer] of pointers) {
			if (pointer.generation !== shape.value.generation) return Result.err(pluginError("plugin_rollback_failed", "plugin registry snapshot pointer generation does not match its snapshot"));
			const isActive = activeIds.has(pluginId);
			if ((pointer.state === "active" && !isActive) || (pointer.state === "uninstalled" && isActive) || (!isActive && !previousIds.has(pluginId))) return Result.err(pluginError("plugin_rollback_failed", "plugin registry snapshot pointer state is inconsistent"));
			const activeEntry = active.find((entry) => entry.record.pluginId === pluginId);
			const previousEntry = previous.find((entry) => entry.record.pluginId === pluginId);
			if (activeEntry !== undefined && previousEntry !== undefined && activeEntry.record.revision <= previousEntry.record.revision) return Result.err(pluginError("plugin_rollback_failed", "plugin registry snapshot active and previous revisions are out of order"));
			if (pointer.stageId !== undefined) {
				const pointerEntry = activeEntry ?? previousEntry;
				if (pointerEntry === undefined || pointer.stageId !== `${pluginId}:${pointerEntry.record.revision}:${pluginContentsDigest(pointerEntry.package.contents).value}`) return Result.err(pluginError("plugin_rollback_failed", "plugin registry snapshot pointer stage identity is inconsistent"));
			}
		}
		for (const stagedEntry of staged) {
			const activeEntry = active.find((entry) => entry.record.pluginId === stagedEntry.pluginId);
			const previousEntry = previous.find((entry) => entry.record.pluginId === stagedEntry.pluginId);
			if (stagedEntry.operation === "install" && (stagedEntry.revision !== 1 || activeEntry !== undefined)) return Result.err(pluginError("plugin_rollback_failed", "durable install stage does not match plugin state"));
			if (stagedEntry.operation === "update" && (activeEntry === undefined || stagedEntry.revision !== activeEntry.record.revision + 1)) return Result.err(pluginError("plugin_rollback_failed", "durable update stage does not match plugin revision"));
			if (stagedEntry.operation === "uninstall" && (activeEntry === undefined || stagedEntry.revision !== activeEntry.record.revision)) return Result.err(pluginError("plugin_rollback_failed", "durable uninstall stage does not match plugin revision"));
			if (stagedEntry.operation === "rollback" && (previousEntry === undefined || stagedEntry.revision !== (activeEntry?.record.revision ?? previousEntry.record.revision) + 1)) return Result.err(pluginError("plugin_rollback_failed", "durable rollback stage does not match plugin revision"));
		}
		return Result.ok(clonePluginPersistence({ ...shape.value, active, previous, staged, pointers: [...pointers.values()] }));
	} catch (error) {
		return Result.err(toFoundationError(error, "plugin_rollback_failed"));
	}
}

function parsePluginRegistrySnapshot(value: unknown, expectedGeneration: number): ResultValue<LocalPluginRegistrySnapshot, FoundationError> {
	return validatePluginRegistrySnapshot(value, expectedGeneration);
}

function parsePluginRegistryPointer(value: unknown): ResultValue<PluginRegistryDiskPointerV1, FoundationError> {
	const shape = durableRegistryShape<PluginRegistryDiskPointerV1>(pluginRegistryDiskPointerSchema, value, "plugin registry activation pointer");
	if (!shape.ok) return shape;
	if (!Number.isSafeInteger(shape.value.generation) || !new RegExp(`^snapshot-${shape.value.generation}-[0-9a-f-]+\\.json$`).test(shape.value.snapshotFile)) {
		return Result.err(pluginError("plugin_rollback_failed", "plugin registry activation pointer is invalid"));
	}
	return Result.ok(shape.value);
}

function unwrapPluginFileResult<T>(result: ResultValue<T, FileError>): T {
	if (!result.ok) throw result.error;
	return result.value;
}

/**
 * Durable local Plugin v1 storage. Every mutation publishes an immutable
 * snapshot, then atomically replaces the activation pointer as its commit.
 * A crash can leave an unreferenced snapshot, but never a partial active view.
 */
export class LocalFilePluginRegistryStorage implements LocalPluginRegistryStorage {
	readonly #fileSystem: LocalPluginRegistryFileSystem;
	readonly #directory: string;
	#tail: Promise<void> = Promise.resolve();
	#nonce = 0;

	constructor(fileSystem: LocalPluginRegistryFileSystem, directory: string) {
		this.#fileSystem = fileSystem;
		this.#directory = directory;
	}

	async load(): Promise<ResultValue<LocalPluginRegistrySnapshot | undefined, FoundationError>> {
		await this.#tail;
		return this.loadCommittedSnapshot();
	}

	async stagePackage(record: PluginRegistryStagedPackage): Promise<ResultValue<void, FoundationError>> {
		return this.mutate((snapshot) => ({
			...snapshot,
			generation: snapshot.generation + 1,
			staged: [...snapshot.staged.filter((item) => item.stageId !== record.stageId), clonePluginPersistence(record)],
			pointers: snapshot.pointers.map((pointer) => ({ ...pointer, generation: snapshot.generation + 1 })),
		}));
	}

	async atomicSwitch(change: PluginRegistryAtomicSwitch): Promise<ResultValue<void, FoundationError>> {
		return this.mutate((snapshot) => {
			const active = snapshot.active.filter((item) => item.record.pluginId !== change.pluginId);
			const previous = snapshot.previous.filter((item) => item.record.pluginId !== change.pluginId);
			const generation = snapshot.generation + 1;
			return {
				...snapshot,
				generation,
				active: change.active === undefined ? active : [...active, clonePluginPersistence(change.active)],
				previous: change.previous === undefined ? previous : [...previous, clonePluginPersistence(change.previous)],
				staged: change.stageId === undefined ? snapshot.staged : snapshot.staged.filter((item) => item.stageId !== change.stageId),
				pointers: [
					...snapshot.pointers.filter((pointer) => pointer.pluginId !== change.pluginId).map((pointer) => ({ ...pointer, generation })),
					{ pluginId: change.pluginId, state: change.state, ...(change.stageId === undefined ? {} : { stageId: change.stageId }), generation },
				],
			};
		});
	}

	async removeStage(stageId: string): Promise<ResultValue<void, FoundationError>> {
		return this.mutate((snapshot) => ({
			...snapshot,
			generation: snapshot.generation + 1,
			staged: snapshot.staged.filter((item) => item.stageId !== stageId),
			pointers: snapshot.pointers.map((pointer) => ({ ...pointer, generation: snapshot.generation + 1 })),
		}));
	}

	private async mutate(update: (snapshot: LocalPluginRegistrySnapshot) => LocalPluginRegistrySnapshot): Promise<ResultValue<void, FoundationError>> {
		let resolveTail: (() => void) | undefined;
		const previousTail = this.#tail;
		this.#tail = new Promise<void>((resolvePromise) => { resolveTail = resolvePromise; });
		await previousTail;
		try {
			const loaded = await this.loadCommittedSnapshot();
			if (!loaded.ok) return loaded;
			await this.publishSnapshot(update(loaded.value ?? emptyPluginRegistrySnapshot()));
			return Result.ok(undefined);
		} catch (error) {
			return Result.err(toFoundationError(error, "plugin_rollback_failed"));
		} finally {
			resolveTail?.();
		}
	}

	private async loadCommittedSnapshot(): Promise<ResultValue<LocalPluginRegistrySnapshot | undefined, FoundationError>> {
		try {
			const pointerPath = await this.path(PLUGIN_REGISTRY_POINTER_FILE);
			const pointerContents = await this.#fileSystem.readTextFile(pointerPath);
			if (!pointerContents.ok && pointerContents.error.code === "not_found") {
				const snapshotDirectory = await this.path(PLUGIN_REGISTRY_SNAPSHOT_DIRECTORY);
				const snapshotsExist = unwrapPluginFileResult(await this.#fileSystem.exists(snapshotDirectory));
				if (snapshotsExist) return Result.err(pluginError("plugin_rollback_failed", "committed plugin activation pointer is missing"));
				return Result.ok(undefined);
			}
			const pointer = parsePluginRegistryPointer(JSON.parse(unwrapPluginFileResult(pointerContents)) as unknown);
			if (!pointer.ok) return pointer;
			const snapshotPath = await this.path(PLUGIN_REGISTRY_SNAPSHOT_DIRECTORY, pointer.value.snapshotFile);
			const snapshotContents = unwrapPluginFileResult(await this.#fileSystem.readTextFile(snapshotPath));
			return parsePluginRegistrySnapshot(JSON.parse(snapshotContents) as unknown, pointer.value.generation);
		} catch (error) {
			return Result.err(toFoundationError(error, "plugin_rollback_failed"));
		}
	}

	private async publishSnapshot(snapshot: LocalPluginRegistrySnapshot): Promise<void> {
		const snapshotDirectory = await this.path(PLUGIN_REGISTRY_SNAPSHOT_DIRECTORY);
		unwrapPluginFileResult(await this.#fileSystem.createDir(snapshotDirectory, { recursive: true }));
		const nonce = `${Date.now().toString(16)}-${(this.#nonce++).toString(16)}-${Math.random().toString(16).slice(2)}`;
		const snapshotFile = `snapshot-${snapshot.generation}-${nonce}.json`;
		const snapshotPath = await this.path(PLUGIN_REGISTRY_SNAPSHOT_DIRECTORY, snapshotFile);
		const snapshotTemporaryPath = `${snapshotPath}.tmp`;
		const pointerPath = await this.path(PLUGIN_REGISTRY_POINTER_FILE);
		const pointerTemporaryPath = await this.path(`.${PLUGIN_REGISTRY_POINTER_FILE}.${nonce}.tmp`);
		const pointerRestoreTemporaryPath = `${pointerTemporaryPath}.restore.tmp`;
		const previousPointer = await this.#fileSystem.readTextFile(pointerPath);
		const previousPointerContents = previousPointer.ok ? previousPointer.value : undefined;
		if (!previousPointer.ok && previousPointer.error.code !== "not_found") unwrapPluginFileResult(previousPointer);
		const pointerPublication = { state: "before-rename" as "before-rename" | "after-rename" | "directory-sync-indeterminate" };
		try {
			unwrapPluginFileResult(await this.#fileSystem.createExclusive(snapshotTemporaryPath, canonicalFoundationJson(snapshot)));
			unwrapPluginFileResult(await this.#fileSystem.syncFile(snapshotTemporaryPath));
			unwrapPluginFileResult(await this.#fileSystem.renameFile(snapshotTemporaryPath, snapshotPath));
			unwrapPluginFileResult(await this.#fileSystem.syncDirectory(snapshotDirectory));
			const pointer: PluginRegistryDiskPointerV1 = { schemaVersion: FOUNDATION_SCHEMA_VERSION, generation: snapshot.generation, snapshotFile };
			unwrapPluginFileResult(await this.#fileSystem.createExclusive(pointerTemporaryPath, canonicalFoundationJson(pointer)));
			unwrapPluginFileResult(await this.#fileSystem.syncFile(pointerTemporaryPath));
			unwrapPluginFileResult(await this.#fileSystem.renameFile(pointerTemporaryPath, pointerPath));
			pointerPublication.state = "after-rename";
			try {
				unwrapPluginFileResult(await this.#fileSystem.syncDirectory(this.#directory));
			} catch (error) {
				pointerPublication.state = "directory-sync-indeterminate";
				throw error;
			}
		} catch (error) {
			await this.removeBestEffort(snapshotTemporaryPath);
			await this.removeBestEffort(pointerTemporaryPath);
			await this.removeBestEffort(pointerRestoreTemporaryPath);
			if (pointerPublication.state === "directory-sync-indeterminate") {
				let restorationError: unknown;
				if (previousPointerContents === undefined) {
					try {
						unwrapPluginFileResult(await this.#fileSystem.remove(pointerPath, { force: true }));
						unwrapPluginFileResult(await this.#fileSystem.syncDirectory(this.#directory));
					} catch (restoreError) {
						restorationError = restoreError;
					}
				} else {
					try {
						unwrapPluginFileResult(await this.#fileSystem.createExclusive(pointerRestoreTemporaryPath, previousPointerContents));
						unwrapPluginFileResult(await this.#fileSystem.syncFile(pointerRestoreTemporaryPath));
						unwrapPluginFileResult(await this.#fileSystem.renameFile(pointerRestoreTemporaryPath, pointerPath));
						unwrapPluginFileResult(await this.#fileSystem.syncDirectory(this.#directory));
					} catch (restoreError) {
						restorationError = restoreError;
					} finally {
						await this.removeBestEffort(pointerRestoreTemporaryPath);
					}
				}
				if (restorationError !== undefined) throw new FoundationError("plugin_rollback_failed", "activation pointer restoration failed", { cause: restorationError });
			}
			throw error;
		}
	}

	private async removeBestEffort(path: string): Promise<void> {
		try {
			await this.#fileSystem.remove(path, { force: true });
		} catch {
			// Cleanup must not mask the publication failure.
		}
	}

	private async path(...parts: string[]): Promise<string> {
		return unwrapPluginFileResult(await this.#fileSystem.joinPath([this.#directory, ...parts]));
	}
}

const NAMESPACE_PATTERN = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;
const ID_PATTERN = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/;

export function defaultPluginNamespace(contract: PluginContract): string {
	return contract.namespace;
}

/** Reject remote and hosted source references before any package is staged. */
export function validatePluginSource(source: string): PluginRejectedSource | undefined {
	const normalized = source.trim().toLowerCase();
	if (normalized.startsWith("http://") || normalized.startsWith("https://") || normalized.startsWith("git+") || normalized.startsWith("npm:") || normalized.startsWith("ssh://")) {
		return { source, reason: "hosted or remote plugin sources are not supported; only local plugins install" };
	}
	return undefined;
}

/** Digest exactly the Foundation manifest document, not executable package contents. */
export function pluginManifestDigest(manifest: PluginContract["manifest"]): Fingerprint {
	return fingerprintFoundationValue(manifest);
}

/** Digest the complete local package payload, including executable declarations. */
export function pluginContentsDigest(contents: PluginPackageContents): Fingerprint {
	return fingerprintFoundationValue(contents);
}

/** Construct a complete Plugin v1 contract with deterministic digest metadata. */
export function createPluginContract(input: CreatePluginContractInput): PluginContract {
	return {
		schemaVersion: FOUNDATION_SCHEMA_VERSION,
		namespace: input.namespace,
		pluginId: input.pluginId,
		version: input.version,
		manifest: input.manifest,
		digest: pluginManifestDigest(input.manifest),
		signature: input.signature,
		hooks: [...(input.hooks ?? [])],
		features: [...(input.features ?? [])],
		...(input.serviceIds === undefined ? {} : { serviceIds: [...input.serviceIds] }),
		...(input.profileIds === undefined ? {} : { profileIds: [...input.profileIds] }),
		...(input.rollbackSupported === undefined ? {} : { rollbackSupported: input.rollbackSupported }),
	};
}

function hookToSpec(hook: PluginHook): RuntimeHookSpec {
	return { hookId: hook.hookId, phase: hook.phase, priority: hook.priority, before: hook.before, after: hook.after, conflict: hook.conflict, capabilities: hook.capabilities };
}

function pluginError(code: "invalid_identifier" | "foundation_schema_invalid_shape" | "plugin_rollback_failed" | "profile_conflict", message: string, details?: FoundationJsonValue): FoundationError {
	return new FoundationError(code, message, details === undefined ? {} : { details });
}

function validateSignatureMetadata(metadata: PluginSignatureMetadata | undefined): FoundationError | undefined {
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
export function validateLocalPluginPackage(pkg: LocalPluginPackage, parentMcpSelector?: ResourceSelector): ResultValue<void, FoundationError> {
	if (pkg.schemaVersion !== FOUNDATION_SCHEMA_VERSION || pkg.contract.schemaVersion !== FOUNDATION_SCHEMA_VERSION) return Result.err(pluginError("foundation_schema_invalid_shape", "plugin package schema version is unsupported"));
	if (pkg.source !== "local") return Result.err(pluginError("plugin_rollback_failed", "only local plugin packages are supported", { source: pkg.source }));
	if (pkg.sourcePath !== undefined) {
		const rejected = validatePluginSource(pkg.sourcePath);
		if (rejected !== undefined) return Result.err(pluginError("plugin_rollback_failed", rejected.reason, { source: rejected.source }));
	}
	const { contract } = pkg;
	if (!NAMESPACE_PATTERN.test(contract.namespace)) return Result.err(pluginError("invalid_identifier", "plugin namespace is invalid", { namespace: contract.namespace }));
	if (!ID_PATTERN.test(contract.pluginId)) return Result.err(pluginError("invalid_identifier", "plugin id is invalid", { pluginId: contract.pluginId }));
	if (contract.version.trim().length === 0 || contract.manifest.version.trim().length === 0) return Result.err(pluginError("invalid_identifier", "plugin version must not be empty"));
	if (contract.manifest.version !== contract.version) return Result.err(pluginError("foundation_schema_invalid_shape", "plugin manifest and contract versions differ", { manifestVersion: contract.manifest.version, contractVersion: contract.version }));
	if (contract.manifest.name.trim().length === 0 || contract.manifest.entrypoint.trim().length === 0) return Result.err(pluginError("foundation_schema_invalid_shape", "plugin manifest name and entrypoint are required"));
	const expectedDigest = pluginManifestDigest(contract.manifest);
	if (expectedDigest.algorithm !== contract.digest.algorithm || expectedDigest.value !== contract.digest.value) return Result.err(pluginError("foundation_schema_invalid_shape", "plugin digest does not match its manifest", { pluginId: contract.pluginId }));
	if (contract.signature.trim().length === 0) return Result.err(pluginError("foundation_schema_invalid_shape", "plugin signature metadata is required"));
	const signatureMetadataError = validateSignatureMetadata(pkg.signatureMetadata);
	if (signatureMetadataError !== undefined) return Result.err(signatureMetadataError);
	const hookIds = validateUniqueIds(contract.hooks.map((hook) => hook.hookId), "plugin hooks");
	if (hookIds !== undefined) return Result.err(hookIds);
	const hookOrder = orderRuntimeHooks(contract.hooks.map(hookToSpec));
	if (!hookOrder.ok) return hookOrder;
	const serviceIds = validateUniqueIds(contract.serviceIds ?? [], "plugin services");
	if (serviceIds !== undefined) return Result.err(serviceIds);
	const profileIds = validateUniqueIds(contract.profileIds ?? [], "plugin profiles");
	if (profileIds !== undefined) return Result.err(profileIds);
	let packageSelector: ResourceSelector | undefined;
	if (parentMcpSelector !== undefined) {
		const parentResult = validateSelector(parentMcpSelector);
		if (!parentResult.ok) return parentResult;
		packageSelector = parentResult.value;
	}
	if (pkg.mcpSelector !== undefined) {
		const packageResult = parentMcpSelector === undefined
			? validateSelector(pkg.mcpSelector)
			: validateMcpSelectorTightening(parentMcpSelector, pkg.mcpSelector);
		if (!packageResult.ok) return packageResult;
		packageSelector = packageResult.value;
	}
	const skillIds = (pkg.contents.skills ?? []).map((skill) => skill.skillId);
	const skillIdError = validateUniqueIds(skillIds, "plugin skills");
	if (skillIdError !== undefined) return Result.err(skillIdError);
	for (const skill of pkg.contents.skills ?? []) {
		if (skill.mcpSelector !== undefined) {
			const result = packageSelector === undefined ? validateSelector(skill.mcpSelector) : validateMcpSelectorTightening(packageSelector, skill.mcpSelector);
			if (!result.ok) return result;
		}
	}
	const mcpIds = (pkg.contents.mcpServers ?? []).map((server) => server.mcpServerId);
	const mcpIdError = validateUniqueIds(mcpIds, "plugin MCP servers");
	if (mcpIdError !== undefined) return Result.err(mcpIdError);
	for (const server of pkg.contents.mcpServers ?? []) {
		if (server.selector !== undefined) {
			const result = packageSelector === undefined ? validateSelector(server.selector) : validateMcpSelectorTightening(packageSelector, server.selector);
			if (!result.ok) return result;
		}
	}
	const agentIds = (pkg.contents.agents ?? []).map((agent) => agent.agentId);
	const agentIdError = validateUniqueIds(agentIds, "plugin agents");
	if (agentIdError !== undefined) return Result.err(agentIdError);
	for (const agent of pkg.contents.agents ?? []) {
		if (agent.mcpSelector !== undefined) {
			const result = packageSelector === undefined ? validateSelector(agent.mcpSelector) : validateMcpSelectorTightening(packageSelector, agent.mcpSelector);
			if (!result.ok) return result;
		}
	}
	for (const extension of pkg.contents.extensions ?? []) {
		const result = validateExtensionContract(extension);
		if (!result.ok) return result;
	}
	const lspIds = [...(pkg.contents.lsp ?? []).map((extension) => extension.extensionId), ...(pkg.contents.monitors ?? []).map((extension) => extension.extensionId)];
	const extensionIdError = validateUniqueIds(lspIds, "plugin extensions");
	if (extensionIdError !== undefined) return Result.err(extensionIdError);
	return Result.ok(undefined);
}

/** Local Plugin v1 registry. No marketplace, hosted install, or implicit network behavior is exposed. */
export class LocalPluginRegistry {
	readonly #active = new Map<string, { package: LocalPluginPackage; record: PluginActivationRecord; scope: EffectScope }>();
	readonly #previous = new Map<string, { package: LocalPluginPackage; record: PluginActivationRecord }>();
	readonly #stages: PluginStageReport[] = [];
	readonly #stageIds = new Map<string, string>();
	readonly #onStage: (report: PluginStageReport) => void | Promise<void>;
	readonly #onActivate: (pkg: LocalPluginPackage, context: PluginActivationContext) => void | Promise<void>;
	readonly #verifySignature: NonNullable<LocalPluginRegistryOptions["verifySignature"]>;
	readonly #now: () => string;
	readonly #requireContentSignature: boolean;
	readonly #storage: LocalPluginRegistryStorage | undefined;
	readonly #releaseReports = new Map<string, unknown>();

	constructor(options: LocalPluginRegistryOptions = {}) {
		this.#onStage = options.onStage ?? (() => undefined);
		this.#onActivate = options.onActivate ?? (() => undefined);
		this.#verifySignature = options.verifySignature ?? (() => Result.ok(undefined));
		this.#now = options.now ?? (() => new Date().toISOString());
		this.#requireContentSignature = options.requireContentSignature ?? true;
		this.#storage = options.storage;
	}

	static async open(options: LocalPluginRegistryOptions = {}): Promise<ResultValue<LocalPluginRegistry, FoundationError>> {
		const registry = new LocalPluginRegistry(options);
		const recovered = await registry.recover();
		return recovered.ok ? Result.ok(registry) : recovered;
	}

	/** Restore the last atomically committed activation pointer after restart. */
	async recover(): Promise<ResultValue<void, FoundationError>> {
		if (this.#storage === undefined) return Result.ok(undefined);
		const previousActive = [...this.#active.values()];
		this.#active.clear();
		this.#previous.clear();
		this.#stageIds.clear();
		let loaded: ResultValue<LocalPluginRegistrySnapshot | undefined, FoundationError>;
		try {
			loaded = await this.#storage.load();
		} catch (error) {
			for (const item of [...previousActive].reverse()) await item.scope.rollback();
			return Result.err(toFoundationError(error, "plugin_rollback_failed"));
		}
		if (!loaded.ok) {
			for (const item of [...previousActive].reverse()) await item.scope.rollback();
			return loaded;
		}
		if (loaded.value === undefined) {
			for (const item of [...previousActive].reverse()) await item.scope.rollback();
			return Result.ok(undefined);
		}
		const snapshotValidation = validatePluginRegistrySnapshot(loaded.value);
		if (!snapshotValidation.ok) {
			for (const item of [...previousActive].reverse()) await item.scope.rollback();
			return snapshotValidation;
		}
		const snapshot = snapshotValidation.value;
		const restored: Array<{ pluginId: string; value: { package: LocalPluginPackage; record: PluginActivationRecord; scope: EffectScope } }> = [];
		for (const entry of snapshot.active) {
			const validation = this.validatePackageWithSignature(entry.package);
			if (!validation.ok) {
				for (const item of [...restored].reverse()) await item.value.scope.rollback();
				for (const item of [...previousActive].reverse()) await item.scope.rollback();
				return validation;
			}
			const activation = await this.createActivation(entry.package, entry.record.revision);
			if (!activation.ok) {
				for (const item of [...restored].reverse()) await item.value.scope.rollback();
				for (const item of [...previousActive].reverse()) await item.scope.rollback();
				return activation;
			}
			restored.push({ pluginId: entry.record.pluginId, value: { ...activation.value, record: clonePluginPersistence(entry.record) } });
		}
		for (const staged of snapshot.staged) {
			const removed = await this.removeStageDurably(staged.stageId);
			if (!removed.ok) {
				for (const item of [...restored].reverse()) await item.value.scope.rollback();
				for (const item of [...previousActive].reverse()) await item.scope.rollback();
				return removed;
			}
		}
		for (const item of [...previousActive].reverse()) await item.scope.rollback();
		for (const item of restored) this.#active.set(item.pluginId, item.value);
		for (const entry of snapshot.previous) this.#previous.set(entry.record.pluginId, clonePluginPersistence(entry));
		return Result.ok(undefined);
	}

	private async reconcileAfterDurableFailure(): Promise<ResultValue<void, FoundationError>> {
		if (this.#storage === undefined) return Result.ok(undefined);
		const recovered = await this.recover();
		if (!recovered.ok) {
			this.#active.clear();
			this.#previous.clear();
			this.#stageIds.clear();
		}
		return recovered;
	}

	/** Alias used by hosts that call restart handling restore rather than recover. */
	async restore(): Promise<ResultValue<void, FoundationError>> { return this.recover(); }

	has(pluginId: string): boolean { return this.#active.has(pluginId); }
	active(pluginId: string): PluginActivationRecord | undefined { return this.#active.get(pluginId)?.record; }
	revision(pluginId: string): number { return this.#active.get(pluginId)?.record.revision ?? 0; }
	get stages(): readonly PluginStageReport[] { return [...this.#stages]; }
	get lastReleaseReports(): ReadonlyMap<string, unknown> { return new Map(this.#releaseReports); }
	activePackages(): readonly LocalPluginPackage[] {
		return [...this.#active.keys()].sort().map((pluginId) => this.#active.get(pluginId)!.package);
	}

	async stage(pkg: LocalPluginPackage, operation: PluginLifecycleOperation = this.#active.has(pkg.contract.pluginId) ? "update" : "install", revision = this.revision(pkg.contract.pluginId) + 1): Promise<ResultValue<PluginStageReport, FoundationError>> {
		const validation = this.validatePackageWithSignature(pkg);
		if (!validation.ok) return validation;
		const report: PluginStageReport = { schemaVersion: FOUNDATION_SCHEMA_VERSION, operation, pluginId: pkg.contract.pluginId, revision, staged: true, rejected: [] };
		try {
			await this.#onStage(report);
		} catch (error) {
			return Result.err(toFoundationError(error, "plugin_rollback_failed"));
		}
		const stageId = this.stageId(pkg, revision);
		const durable = await this.stageDurably({ stageId, operation, pluginId: pkg.contract.pluginId, revision, package: pkg, stagedAt: this.#now() });
		if (!durable.ok) {
			await this.reconcileAfterDurableFailure();
			return durable;
		}
		this.#stages.push(report);
		this.#stageIds.set(this.stageKey(pkg.contract.pluginId, revision), stageId);
		return Result.ok(report);
	}

	async install(pkg: LocalPluginPackage): Promise<ResultValue<PluginLifecycleResult, FoundationError>> {
		const validation = this.validatePackageWithSignature(pkg);
		if (!validation.ok) return validation;
		if (this.#active.has(pkg.contract.pluginId)) return Result.err(pluginError("plugin_rollback_failed", "cannot install a plugin that is already installed", { pluginId: pkg.contract.pluginId }));
		return this.activateNew("install", pkg, 1);
	}

	async update(pkg: LocalPluginPackage): Promise<ResultValue<PluginLifecycleResult, FoundationError>> {
		const validation = this.validatePackageWithSignature(pkg);
		if (!validation.ok) return validation;
		const current = this.#active.get(pkg.contract.pluginId);
		if (current === undefined) return Result.err(pluginError("plugin_rollback_failed", "cannot update a plugin that is not installed", { pluginId: pkg.contract.pluginId }));
		return this.activateNew("update", pkg, current.record.revision + 1);
	}

	async uninstall(pluginId: string): Promise<ResultValue<PluginLifecycleResult, FoundationError>> {
		const current = this.#active.get(pluginId);
		if (current === undefined) return Result.err(pluginError("plugin_rollback_failed", "cannot uninstall a plugin that is not installed", { pluginId }));
		const stage = await this.stage(current.package, "uninstall", current.record.revision);
		if (!stage.ok) return stage;
		const oldPrevious = this.#previous.get(pluginId);
		const stageId = this.#stageIds.get(this.stageKey(pluginId, current.record.revision));
		const switched = await this.atomicSwitchDurably({ pluginId, previous: { package: current.package, record: current.record }, stageId, state: "uninstalled" });
		if (!switched.ok) {
			if (stageId !== undefined) await this.removeStageDurably(stageId);
			await this.reconcileAfterDurableFailure();
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
			await this.reconcileAfterDurableFailure();
			return Result.err(pluginError("plugin_rollback_failed", "plugin uninstall cleanup failed", { pluginId }));
		}
		this.#stageIds.delete(this.stageKey(pluginId, current.record.revision));
		return Result.ok({ schemaVersion: FOUNDATION_SCHEMA_VERSION, operation: "uninstall", pluginId, revision: current.record.revision, applied: true });
	}

	async rollback(pluginId: string): Promise<ResultValue<PluginLifecycleResult, FoundationError>> {
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
			if (stageId !== undefined) {
				const removed = await this.removeStageDurably(stageId);
				if (!removed.ok) await this.reconcileAfterDurableFailure();
			}
			return activated;
		}
		const switched = await this.atomicSwitchDurably({
			pluginId,
			active: { package: previous.package, record: activated.value.record },
			...(current === undefined ? {} : { previous: { package: current.package, record: current.record } }),
			stageId,
			state: "active",
		});
		if (!switched.ok) {
			await activated.value.scope.rollback();
			if (stageId !== undefined) await this.removeStageDurably(stageId);
			await this.reconcileAfterDurableFailure();
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
					const restoredDurably = await this.atomicSwitchDurably({
						pluginId,
						active: { package: current.package, record: current.record },
						previous,
						state: "active",
					});
					if (restoredDurably.ok) this.#active.set(pluginId, { ...restored.value, record: current.record });
					else await restored.value.scope.rollback();
				}
				await this.reconcileAfterDurableFailure();
				return Result.err(pluginError("plugin_rollback_failed", "plugin rollback cleanup failed", { pluginId }));
			}
		}
		const clearedRollbackPoint = await this.atomicSwitchDurably({ pluginId, active: { package: previous.package, record: activated.value.record }, state: "active" });
		if (!clearedRollbackPoint.ok) {
			await this.reconcileAfterDurableFailure();
			return clearedRollbackPoint;
		}
		this.#previous.delete(pluginId);
		this.#stageIds.delete(this.stageKey(pluginId, nextRevision));
		return Result.ok({ schemaVersion: FOUNDATION_SCHEMA_VERSION, operation: "rollback", pluginId, revision: nextRevision, applied: true });
	}

	private validatePackageWithSignature(pkg: LocalPluginPackage): ResultValue<void, FoundationError> {
		const packageResult = validateLocalPluginPackage(pkg);
		if (!packageResult.ok) return packageResult;
		const contentsDigest = pluginContentsDigest(pkg.contents);
		if (this.#requireContentSignature && pkg.signatureMetadata?.contentDigest === undefined) return Result.err(pluginError("plugin_rollback_failed", "plugin content signature is required"));
		if (pkg.signatureMetadata?.contentDigest !== undefined && (pkg.signatureMetadata.contentDigest.algorithm !== contentsDigest.algorithm || pkg.signatureMetadata.contentDigest.value !== contentsDigest.value)) return Result.err(pluginError("plugin_rollback_failed", "plugin contents do not match the signed digest"));
		const signature = this.#verifySignature(pkg.contract, pkg.signatureMetadata, contentsDigest);
		return signature.ok ? Result.ok(undefined) : signature;
	}

	private async activateNew(operation: "install" | "update", pkg: LocalPluginPackage, revision: number): Promise<ResultValue<PluginLifecycleResult, FoundationError>> {
		const stage = await this.stage(pkg, operation, revision);
		if (!stage.ok) return stage;
		const activated = await this.createActivation(pkg, revision);
		const current = this.#active.get(pkg.contract.pluginId);
		const oldPrevious = this.#previous.get(pkg.contract.pluginId);
		const stageId = this.#stageIds.get(this.stageKey(pkg.contract.pluginId, revision));
		if (!activated.ok) {
			if (stageId !== undefined) {
				const removed = await this.removeStageDurably(stageId);
				if (!removed.ok) await this.reconcileAfterDurableFailure();
			}
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
			await this.reconcileAfterDurableFailure();
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
				await this.reconcileAfterDurableFailure();
				return Result.err(pluginError("plugin_rollback_failed", "plugin update cleanup failed", { pluginId: pkg.contract.pluginId }));
			}
		}
		if (current === undefined && operation === "install") this.#previous.delete(pkg.contract.pluginId);
		this.#stageIds.delete(this.stageKey(pkg.contract.pluginId, revision));
		return Result.ok({ schemaVersion: FOUNDATION_SCHEMA_VERSION, operation, pluginId: pkg.contract.pluginId, revision, applied: true });
	}

	private stageKey(pluginId: string, revision: number): string { return `${pluginId}:${revision}`; }

	private stageId(pkg: LocalPluginPackage, revision: number): string {
		return `${pkg.contract.pluginId}:${revision}:${pluginContentsDigest(pkg.contents).value}`;
	}

	private async stageDurably(record: PluginRegistryStagedPackage): Promise<ResultValue<void, FoundationError>> {
		if (this.#storage === undefined) return Result.ok(undefined);
		try {
			const result = await this.#storage.stagePackage(record);
			return result.ok ? Result.ok(undefined) : result;
		} catch (error) {
			return Result.err(toFoundationError(error, "plugin_rollback_failed"));
		}
	}

	private async atomicSwitchDurably(change: PluginRegistryAtomicSwitch): Promise<ResultValue<void, FoundationError>> {
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

	private async createActivation(pkg: LocalPluginPackage, revision: number): Promise<ResultValue<{ package: LocalPluginPackage; record: PluginActivationRecord; scope: EffectScope }, FoundationError>> {
		const scope = new EffectScope();
		const context: PluginActivationContext = { scope, register: (kind, resourceId, dispose) => scope.register(kind, resourceId, dispose) };
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
				contentDigest: pluginContentsDigest(pkg.contents),
				signature: pkg.contract.signature,
				...(pkg.signatureMetadata === undefined ? {} : { signatureMetadata: pkg.signatureMetadata }),
				activatedAt: this.#now(),
			},
			scope,
		});
	}
}

function registerDeclaredPluginResources(pkg: LocalPluginPackage, scope: EffectScope): ResultValue<void, FoundationError> {
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
export function canonicalPluginManifest(contract: PluginContract): string {
	return canonicalFoundationJson(contract.manifest);
}

export function isLocalPluginPackage(pkg: LocalPluginPackage): boolean {
	return pkg.source === "local" && validateLocalPluginPackage(pkg).ok;
}
