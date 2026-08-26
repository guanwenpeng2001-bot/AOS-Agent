/** Trusted, instance-only External Connector registry. */

import {
	FoundationError,
	Result,
	validateConnectorCapabilitySnapshotForProvider,
	type ConnectorCapabilitySnapshot,
	type ExternalAgentConnector,
	type Fingerprint,
	type Result as ResultValue,
} from "@aos-agent/agent-core";
import {
	EXTERNAL_CAPABILITY_BEHAVIORS,
	createExternalCapabilityTruthSnapshot,
	type ExternalCapabilityBehavior,
	type ExternalCapabilityEvidenceInput,
	type ExternalCapabilityHandlerEvidence,
	type ExternalCapabilityTruthSnapshot,
} from "./external-model-projection.ts";

import {
	EXTERNAL_AGENT_ADAPTER_ID_MAX_LENGTH,
	EXTERNAL_AGENT_TARGET_ID_MAX_LENGTH,
	type ExternalAgentAdapter,
	ExternalAgentError,
	type ExternalAgentSelection,
	type ExternalAgentTarget,
	isExternalAgentIdentifier,
	serializeExternalAgentSelection,
} from "./external-agent-adapter.ts";

/** The only current provider class admitted by the open connector registry. */
export const EXTERNAL_CONNECTOR_PROVIDER_CLASSES = Object.freeze(["external_connector"] as const);
export type ExternalConnectorProviderClass = (typeof EXTERNAL_CONNECTOR_PROVIDER_CLASSES)[number];

/** Immutable identity and capability revision pinned at registration. */
export interface ExternalConnectorDescriptor {
	readonly schemaVersion: 1;
	readonly providerId: string;
	readonly providerClass: ExternalConnectorProviderClass;
	readonly revision: number;
	readonly capabilitySnapshotDigest: Fingerprint;
}

/** Host-only registration input. No module, command, endpoint, or vendor selector is accepted. */
export interface ExternalConnectorRegistration {
	readonly descriptor: ExternalConnectorDescriptor;
	readonly connector: ExternalAgentConnector;
	readonly trusted: true;
	readonly capabilityEvidence?: ExternalCapabilityEvidenceInput;
}

/** A selection must pin every mutable connector capability identity field. */
export interface ExternalConnectorSelection {
	readonly providerId: string;
	readonly revision: number;
	readonly capabilitySnapshotDigest: Fingerprint;
}

/** Selected constructed instance plus the verified immutable capability facts. */
export interface ExternalConnectorResolvedSelection {
	readonly descriptor: ExternalConnectorDescriptor;
	readonly connector: ExternalAgentConnector;
	readonly capabilitySnapshot: ConnectorCapabilitySnapshot;
	readonly capabilityTruth: ExternalCapabilityTruthSnapshot;
	readonly capabilityHandlers: Readonly<
		Partial<Record<ExternalCapabilityBehavior, ExternalCapabilityHandlerEvidence["invoke"]>>
	>;
}

export interface ExternalConnectorRegistry {
	register(registration: ExternalConnectorRegistration): Promise<ResultValue<ExternalConnectorDescriptor, FoundationError>>;
	/** Trusted composition bootstrap when the exact probed snapshot is already pinned. */
	registerPrepared(
		registration: ExternalConnectorRegistration,
		capabilitySnapshot: ConnectorCapabilitySnapshot,
	): ResultValue<ExternalConnectorDescriptor, FoundationError>;
	select(selection: ExternalConnectorSelection): Promise<ResultValue<ExternalConnectorResolvedSelection, FoundationError>>;
	list(): readonly ExternalConnectorDescriptor[];
	dispose(): Promise<void>;
}

interface RegisteredConnector {
	readonly descriptor: ExternalConnectorDescriptor;
	readonly connector: ExternalAgentConnector;
	readonly capabilitySnapshot: ConnectorCapabilitySnapshot;
	readonly capabilityTruth: ExternalCapabilityTruthSnapshot;
	readonly capabilityEvidence?: ExternalCapabilityEvidenceInput;
}

const EXTERNAL_CONNECTOR_DESCRIPTOR_KEYS = new Set([
	"schemaVersion",
	"providerId",
	"providerClass",
	"revision",
	"capabilitySnapshotDigest",
]);
const EXTERNAL_CONNECTOR_REGISTRATION_KEYS = new Set([
	"descriptor",
	"connector",
	"trusted",
	"capabilityEvidence",
]);
const EXTERNAL_CONNECTOR_SELECTION_KEYS = new Set([
	"providerId",
	"revision",
	"capabilitySnapshotDigest",
]);
const RESULT_OK_KEYS = new Set(["ok", "value"]);
const RESULT_ERROR_KEYS = new Set(["ok", "error"]);
const FINGERPRINT_KEYS = new Set(["algorithm", "value"]);
const EXTERNAL_CONNECTOR_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function connectorRegistryError(message: string): FoundationError {
	return new FoundationError("task_executor_invalid_provider_class", message);
}

function isConnectorRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactConnectorKeys(value: Record<string, unknown>, expected: ReadonlySet<string>): boolean {
	const keys = Object.keys(value);
	return keys.length === expected.size && keys.every((key) => expected.has(key));
}

function hasOnlyConnectorKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
	return Object.keys(value).every((key) => allowed.has(key));
}

function isExternalConnectorIdentifier(value: unknown): value is string {
	return typeof value === "string" && EXTERNAL_CONNECTOR_IDENTIFIER_PATTERN.test(value);
}

function isExternalConnectorFingerprint(value: unknown): value is Fingerprint {
	return (
		isConnectorRecord(value) &&
		hasExactConnectorKeys(value, FINGERPRINT_KEYS) &&
		value.algorithm === "sha256" &&
		typeof value.value === "string" &&
		SHA256_PATTERN.test(value.value)
	);
}

function sameFingerprint(left: Fingerprint, right: Fingerprint): boolean {
	return left.algorithm === right.algorithm && left.value === right.value;
}

function isExternalConnectorDescriptor(value: unknown): value is ExternalConnectorDescriptor {
	return (
		isConnectorRecord(value) &&
		hasExactConnectorKeys(value, EXTERNAL_CONNECTOR_DESCRIPTOR_KEYS) &&
		value.schemaVersion === 1 &&
		isExternalConnectorIdentifier(value.providerId) &&
		value.providerClass === "external_connector" &&
		Number.isSafeInteger(value.revision) &&
		(value.revision as number) > 0 &&
		isExternalConnectorFingerprint(value.capabilitySnapshotDigest)
	);
}

function isConstructedExternalConnector(value: unknown): value is ExternalAgentConnector {
	if (!isConnectorRecord(value)) return false;
	return (
		value.schemaVersion === 1 &&
		isExternalConnectorIdentifier(value.providerId) &&
		value.providerClass === "external_connector" &&
		typeof value.capabilities === "function" &&
		typeof value.dispose === "function" &&
		typeof value.createAttempt === "function" &&
		typeof value.runAttempt === "function" &&
		typeof value.cancelAttempt === "function" &&
		typeof value.probeCapabilities === "function" &&
		typeof value.resumeAttempt === "function" &&
		typeof value.reconcileAttempt === "function"
	);
}

function isExternalConnectorRegistration(value: unknown): value is ExternalConnectorRegistration {
	return (
		isConnectorRecord(value) &&
		hasOnlyConnectorKeys(value, EXTERNAL_CONNECTOR_REGISTRATION_KEYS) &&
		Object.hasOwn(value, "descriptor") &&
		Object.hasOwn(value, "connector") &&
		Object.hasOwn(value, "trusted") &&
		value.trusted === true &&
		isExternalConnectorDescriptor(value.descriptor) &&
		isConstructedExternalConnector(value.connector)
	);
}

export function isExternalConnectorSelection(value: unknown): value is ExternalConnectorSelection {
	return (
		isConnectorRecord(value) &&
		hasExactConnectorKeys(value, EXTERNAL_CONNECTOR_SELECTION_KEYS) &&
		isExternalConnectorIdentifier(value.providerId) &&
		Number.isSafeInteger(value.revision) &&
		(value.revision as number) > 0 &&
		isExternalConnectorFingerprint(value.capabilitySnapshotDigest)
	);
}

export function serializeExternalConnectorSelection(value: unknown): ExternalConnectorSelection | undefined {
	if (!isExternalConnectorSelection(value)) return undefined;
	return Object.freeze({
		providerId: value.providerId,
		revision: value.revision,
		capabilitySnapshotDigest: Object.freeze({ ...value.capabilitySnapshotDigest }),
	});
}

function cloneConnectorDescriptor(value: ExternalConnectorDescriptor): ExternalConnectorDescriptor {
	return Object.freeze({
		schemaVersion: 1,
		providerId: value.providerId,
		providerClass: "external_connector",
		revision: value.revision,
		capabilitySnapshotDigest: Object.freeze({ ...value.capabilitySnapshotDigest }),
	});
}

function cloneCapabilityEvidence(value: ExternalCapabilityEvidenceInput | undefined): ExternalCapabilityEvidenceInput | undefined {
	if (value === undefined) return undefined;
	const cloned: Partial<Record<ExternalCapabilityBehavior, NonNullable<ExternalCapabilityEvidenceInput[ExternalCapabilityBehavior]>>> = {};
	for (const behavior of EXTERNAL_CAPABILITY_BEHAVIORS) {
		const item = value[behavior];
		if (item === undefined) continue;
		cloned[behavior] = Object.freeze({
			declaration: Object.freeze({ ...item.declaration }),
			handler: Object.freeze({ id: item.handler.id, invoke: item.handler.invoke }),
		});
	}
	return Object.freeze(cloned);
}

function capabilityHandlers(
	value: ExternalCapabilityEvidenceInput | undefined,
): Readonly<Partial<Record<ExternalCapabilityBehavior, ExternalCapabilityHandlerEvidence["invoke"]>>> {
	const handlers: Partial<Record<ExternalCapabilityBehavior, ExternalCapabilityHandlerEvidence["invoke"]>> = {};
	for (const behavior of EXTERNAL_CAPABILITY_BEHAVIORS) {
		const item = value?.[behavior];
		if (item !== undefined) handlers[behavior] = item.handler.invoke;
	}
	return Object.freeze(handlers);
}

function capabilityTruth(
	connector: ExternalAgentConnector,
	snapshot: ConnectorCapabilitySnapshot,
	evidence: ExternalCapabilityEvidenceInput | undefined,
): ResultValue<ExternalCapabilityTruthSnapshot, FoundationError> {
	const result = createExternalCapabilityTruthSnapshot({
		connectorId: connector.providerId,
		protocol: `${snapshot.protocol.name}:${snapshot.protocol.version}`,
		capabilityVersion: snapshot.revision,
		capabilities: {
			resume: snapshot.resume,
			toolGateway: snapshot.toolGateway,
			artifacts: snapshot.artifacts,
			images: snapshot.images,
			modelAccess: snapshot.modelAccess,
		},
		...(evidence === undefined ? {} : { evidence }),
	});
	return result.ok
		? Result.ok(result.snapshot)
		: Result.err(connectorRegistryError(`External connector capability evidence failed closed: ${result.error.reasonCode}.`));
}

async function probeConnector(
	connector: ExternalAgentConnector,
): Promise<ResultValue<ConnectorCapabilitySnapshot, FoundationError>> {
	try {
		const probed: unknown = await connector.probeCapabilities();
		if (!isConnectorRecord(probed) || typeof probed.ok !== "boolean") {
			return Result.err(connectorRegistryError("External connector returned a malformed capability probe result."));
		}
		if (probed.ok) {
			if (!hasExactConnectorKeys(probed, RESULT_OK_KEYS)) {
				return Result.err(connectorRegistryError("External connector returned a malformed capability probe result."));
			}
			return validateConnectorCapabilitySnapshotForProvider(probed.value, connector);
		}
		if (!hasExactConnectorKeys(probed, RESULT_ERROR_KEYS) || !FoundationError.is(probed.error)) {
			return Result.err(connectorRegistryError("External connector returned a malformed capability probe failure."));
		}
		return Result.err(connectorRegistryError("External connector capability probe failed."));
	} catch {
		return Result.err(connectorRegistryError("External connector threw while probing capabilities."));
	}
}

/** Open, instance-only connector registry with pinned capability identity. */
class ExternalConnectorRegistryImpl implements ExternalConnectorRegistry {
	readonly #connectors = new Map<string, RegisteredConnector>();
	readonly #pendingProviderIds = new Set<string>();
	#disposed = false;

	async register(
		registration: ExternalConnectorRegistration,
	): Promise<ResultValue<ExternalConnectorDescriptor, FoundationError>> {
		if (this.#disposed) return Result.err(connectorRegistryError("External connector registry is disposed."));
		if (!isExternalConnectorRegistration(registration)) {
			return Result.err(connectorRegistryError("External connector registration must contain one trusted constructed instance and an exact descriptor."));
		}
		const descriptor = registration.descriptor;
		const connector = registration.connector;
		if (this.#connectors.has(descriptor.providerId) || this.#pendingProviderIds.has(descriptor.providerId)) {
			return Result.err(connectorRegistryError("External connector provider identity is already registered."));
		}
		if (descriptor.providerId !== connector.providerId || descriptor.providerClass !== connector.providerClass) {
			return Result.err(connectorRegistryError("External connector descriptor identity does not match its constructed instance."));
		}

		this.#pendingProviderIds.add(descriptor.providerId);
		try {
			const snapshotResult = await probeConnector(connector);
			if (!snapshotResult.ok) return snapshotResult;
			return this.#registerPrepared(registration, snapshotResult.value, true);
		} finally {
			this.#pendingProviderIds.delete(descriptor.providerId);
		}
	}

	registerPrepared(
		registration: ExternalConnectorRegistration,
		capabilitySnapshot: ConnectorCapabilitySnapshot,
	): ResultValue<ExternalConnectorDescriptor, FoundationError> {
		if (this.#disposed) return Result.err(connectorRegistryError("External connector registry is disposed."));
		return this.#registerPrepared(registration, capabilitySnapshot, false);
	}

	#registerPrepared(
		registration: ExternalConnectorRegistration,
		capabilitySnapshot: ConnectorCapabilitySnapshot,
		reserved: boolean,
	): ResultValue<ExternalConnectorDescriptor, FoundationError> {
		if (!isExternalConnectorRegistration(registration)) {
			return Result.err(connectorRegistryError("External connector registration must contain one trusted constructed instance and an exact descriptor."));
		}
		const descriptor = registration.descriptor;
		const connector = registration.connector;
		if ((!reserved && (this.#connectors.has(descriptor.providerId) || this.#pendingProviderIds.has(descriptor.providerId))) ||
			descriptor.providerId !== connector.providerId || descriptor.providerClass !== connector.providerClass) {
			return Result.err(connectorRegistryError("External connector provider identity is already registered or does not match its constructed instance."));
		}
		const checkedSnapshot = validateConnectorCapabilitySnapshotForProvider(capabilitySnapshot, connector);
		if (!checkedSnapshot.ok) return checkedSnapshot;
		const snapshot = checkedSnapshot.value;
		if (descriptor.revision !== snapshot.revision || !sameFingerprint(descriptor.capabilitySnapshotDigest, snapshot.digest)) {
			return Result.err(connectorRegistryError("External connector descriptor revision or capability snapshot digest does not match its probe."));
		}
		const truthResult = capabilityTruth(connector, snapshot, registration.capabilityEvidence);
		if (!truthResult.ok) return truthResult;
		const evidence = cloneCapabilityEvidence(registration.capabilityEvidence);
		const storedDescriptor = cloneConnectorDescriptor(descriptor);
		this.#connectors.set(descriptor.providerId, {
			descriptor: storedDescriptor,
			connector,
			capabilitySnapshot: snapshot,
			capabilityTruth: truthResult.value,
			...(evidence === undefined ? {} : { capabilityEvidence: evidence }),
		});
		return Result.ok(storedDescriptor);
	}

	async select(
		selection: ExternalConnectorSelection,
	): Promise<ResultValue<ExternalConnectorResolvedSelection, FoundationError>> {
		if (this.#disposed) return Result.err(connectorRegistryError("External connector registry is disposed."));
		if (!isExternalConnectorSelection(selection)) {
			return Result.err(connectorRegistryError("External connector selection must pin an exact provider id, revision, and capability snapshot digest."));
		}
		const registered = this.#connectors.get(selection.providerId);
		if (
			registered === undefined ||
			selection.revision !== registered.descriptor.revision ||
			!sameFingerprint(selection.capabilitySnapshotDigest, registered.descriptor.capabilitySnapshotDigest)
		) {
			return Result.err(connectorRegistryError("External connector selection is unknown or does not match its pinned descriptor."));
		}
		if (
			registered.connector.providerClass !== "external_connector" ||
			registered.connector.providerId !== registered.descriptor.providerId
		) {
			return Result.err(connectorRegistryError("External connector constructed instance identity changed after registration."));
		}

		const snapshotResult = await probeConnector(registered.connector);
		if (!snapshotResult.ok) return snapshotResult;
		const snapshot = snapshotResult.value;
		if (
			snapshot.revision !== registered.descriptor.revision ||
			!sameFingerprint(snapshot.digest, registered.capabilitySnapshot.digest) ||
			!sameFingerprint(snapshot.digest, registered.descriptor.capabilitySnapshotDigest)
		) {
			return Result.err(connectorRegistryError("External connector capability snapshot drifted after registration."));
		}
		const truthResult = capabilityTruth(registered.connector, snapshot, registered.capabilityEvidence);
		if (!truthResult.ok) return truthResult;
		if (!sameFingerprint(truthResult.value.snapshotDigest, registered.capabilityTruth.snapshotDigest)) {
			return Result.err(connectorRegistryError("External connector capability evidence drifted after registration."));
		}
		return Result.ok(Object.freeze({
			descriptor: registered.descriptor,
			connector: registered.connector,
			capabilitySnapshot: snapshot,
			capabilityTruth: truthResult.value,
			capabilityHandlers: capabilityHandlers(registered.capabilityEvidence),
		}));
	}

	list(): readonly ExternalConnectorDescriptor[] {
		return Object.freeze([...this.#connectors.values()].map(({ descriptor }) => descriptor));
	}

	async dispose(): Promise<void> {
		if (this.#disposed) return;
		this.#disposed = true;
		const connectors = [...this.#connectors.values()].map(({ connector }) => connector);
		this.#connectors.clear();
		this.#pendingProviderIds.clear();
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				Promise.allSettled(connectors.map((connector) => connector.dispose())),
				new Promise<void>((resolve) => {
					timer = setTimeout(resolve, 5_000);
				}),
			]);
		} finally {
			if (timer !== undefined) clearTimeout(timer);
		}
	}
}

/** Create the single open External Connector registry. */
export function createExternalConnectorRegistry(): ExternalConnectorRegistry {
	return new ExternalConnectorRegistryImpl();
}

/** Bounded display text; rejects control characters and secret shapes. */
export const EXTERNAL_AGENT_DISPLAY_NAME_MAX_LENGTH = 128 as const;
/** Bounded descriptor version string. */
export const EXTERNAL_AGENT_DESCRIPTOR_VERSION_MAX_LENGTH = 64 as const;

export interface ExternalAgentAdapterRegistrationOptions {
	/** Safe display name; defaults to the adapter id. */
	readonly displayName?: string;
	/** Safe descriptor version; defaults to "1". */
	readonly version?: string;
	/** Bounded target ids this adapter can reach; empty means none. */
	readonly targets?: ReadonlyArray<string>;
}

/** Safe public summary of a registered adapter; no target or connection data. */
export interface ExternalAgentAdapterDescriptor {
	readonly adapterId: string;
	readonly displayName: string;
	readonly version: string;
}

/** A selection resolved to the trusted adapter instance and its known target. */
export interface ExternalAgentResolvedSelection {
	readonly adapter: ExternalAgentAdapter;
	readonly target: ExternalAgentTarget;
	readonly selection: ExternalAgentSelection;
}

/**
 * Registry contract used by the trusted Host composition. Registration is
 * instance-only and fail-closed; lookups never expose endpoints, commands,
 * credentials, protocol names, or raw probe data.
 */
export interface ExternalAgentAdapterRegistryView {
	get(adapterId: string): ExternalAgentAdapter | undefined;
	has(adapterId: string): boolean;
	list(): ReadonlyArray<ExternalAgentAdapterDescriptor>;
	lookupTarget(adapterId: string, targetId: string): ExternalAgentTarget | undefined;
	resolve(selection: ExternalAgentSelection): ExternalAgentResolvedSelection;
}

/** Mutable Host construction surface. A materialized runtime publishes only its sealed view. */
export interface ExternalAgentAdapterRegistry extends ExternalAgentAdapterRegistryView {
	register(adapter: ExternalAgentAdapter, options?: ExternalAgentAdapterRegistrationOptions): void;
	seal(): ExternalAgentAdapterRegistryView;
}

interface RegisteredAdapter {
	readonly adapter: ExternalAgentAdapter;
	readonly descriptor: ExternalAgentAdapterDescriptor;
	readonly targets: ReadonlySet<string>;
}

const DEFAULT_ADAPTER_DESCRIPTOR_VERSION = "1" as const;
const SECRET_SHAPE_PATTERN = /^(sk-|ghp_|gho_|xox[baprs]-|AKIA|-----BEGIN|bearer\s)/i;
const REGISTRATION_OPTIONS_KEYS = new Set(["displayName", "version", "targets"]);

/** Bounded safe identifier: no URL, path, command, secret shape, or controls. */
function isBoundedSafeIdentifier(value: unknown, maxLength: number): value is string {
	return (
		typeof value === "string" &&
		value.length >= 1 &&
		value.length <= maxLength &&
		isExternalAgentIdentifier(value) &&
		!SECRET_SHAPE_PATTERN.test(value)
	);
}

/** Bounded display text; rejects control characters, newlines, and secret shapes. */
function isSafeDisplayName(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length >= 1 &&
		value.length <= EXTERNAL_AGENT_DISPLAY_NAME_MAX_LENGTH &&
		!/[\u0000-\u001f\u007f]/.test(value) &&
		!SECRET_SHAPE_PATTERN.test(value)
	);
}

/** A constructed adapter instance: safe id plus the three contract methods. */
function isAdapterInstance(value: unknown): value is ExternalAgentAdapter {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as {
		readonly id?: unknown;
		readonly probe?: unknown;
		readonly prepare?: unknown;
		readonly start?: unknown;
	};
	return (
		isBoundedSafeIdentifier(candidate.id, EXTERNAL_AGENT_ADAPTER_ID_MAX_LENGTH) &&
		typeof candidate.probe === "function" &&
		typeof candidate.prepare === "function" &&
		typeof candidate.start === "function"
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
	return Object.keys(value).every((key) => allowed.has(key));
}

/**
 * Exact runtime shape of the registration options: a plain object with only
 * the known keys, safe optional displayName/version, and an array targets
 * value. A non-object options value, unknown keys, or a non-array targets
 * (which would otherwise be silently iterated, e.g. a string registering its
 * characters) fails closed before any state is written.
 */
function isRegistrationOptions(value: unknown): value is ExternalAgentAdapterRegistrationOptions {
	if (!isRecord(value) || !hasOnlyKeys(value, REGISTRATION_OPTIONS_KEYS)) return false;
	if (value.displayName !== undefined && !isSafeDisplayName(value.displayName)) return false;
	if (
		value.version !== undefined &&
		!isBoundedSafeIdentifier(value.version, EXTERNAL_AGENT_DESCRIPTOR_VERSION_MAX_LENGTH)
	) {
		return false;
	}
	return value.targets === undefined || Array.isArray(value.targets);
}

function isSafeDescriptor(value: unknown): value is ExternalAgentAdapterDescriptor {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as {
		readonly adapterId?: unknown;
		readonly displayName?: unknown;
		readonly version?: unknown;
	};
	return (
		isBoundedSafeIdentifier(candidate.adapterId, EXTERNAL_AGENT_ADAPTER_ID_MAX_LENGTH) &&
		isSafeDisplayName(candidate.displayName) &&
		isBoundedSafeIdentifier(candidate.version, EXTERNAL_AGENT_DESCRIPTOR_VERSION_MAX_LENGTH)
	);
}

export class ExternalAgentAdapterRegistryImpl implements ExternalAgentAdapterRegistry {
	readonly #adapters = new Map<string, RegisteredAdapter>();
	#sealed = false;

	register(adapter: ExternalAgentAdapter, options: ExternalAgentAdapterRegistrationOptions = {}): void {
		if (this.#sealed) throw new ExternalAgentError("external_agent_adapter_invalid");
		if (!isAdapterInstance(adapter) || !isRegistrationOptions(options)) {
			throw new ExternalAgentError("external_agent_adapter_invalid");
		}
		const adapterId = adapter.id;
		if (this.#adapters.has(adapterId)) {
			throw new ExternalAgentError("external_agent_adapter_invalid");
		}
		const descriptor: ExternalAgentAdapterDescriptor = Object.freeze({
			adapterId,
			displayName: options.displayName ?? adapterId,
			version: options.version ?? DEFAULT_ADAPTER_DESCRIPTOR_VERSION,
		});
		if (!isSafeDescriptor(descriptor)) {
			throw new ExternalAgentError("external_agent_adapter_invalid");
		}
		const targets = new Set<string>();
		for (const targetId of options.targets ?? []) {
			if (!isBoundedSafeIdentifier(targetId, EXTERNAL_AGENT_TARGET_ID_MAX_LENGTH)) {
				throw new ExternalAgentError("external_agent_adapter_invalid");
			}
			targets.add(targetId);
		}
		this.#adapters.set(adapterId, { adapter, descriptor, targets });
	}

	seal(): ExternalAgentAdapterRegistryView {
		this.#sealed = true;
		return Object.freeze(this);
	}

	get(adapterId: string): ExternalAgentAdapter | undefined {
		if (!isBoundedSafeIdentifier(adapterId, EXTERNAL_AGENT_ADAPTER_ID_MAX_LENGTH)) return undefined;
		return this.#adapters.get(adapterId)?.adapter;
	}

	has(adapterId: string): boolean {
		return this.get(adapterId) !== undefined;
	}

	list(): ReadonlyArray<ExternalAgentAdapterDescriptor> {
		return [...this.#adapters.values()].map(({ descriptor }) => descriptor);
	}

	lookupTarget(adapterId: string, targetId: string): ExternalAgentTarget | undefined {
		if (
			!isBoundedSafeIdentifier(adapterId, EXTERNAL_AGENT_ADAPTER_ID_MAX_LENGTH) ||
			!isBoundedSafeIdentifier(targetId, EXTERNAL_AGENT_TARGET_ID_MAX_LENGTH)
		) {
			return undefined;
		}
		const registered = this.#adapters.get(adapterId);
		if (registered === undefined || !registered.targets.has(targetId)) return undefined;
		return Object.freeze({ targetId });
	}

	resolve(selection: ExternalAgentSelection): ExternalAgentResolvedSelection {
		const safeSelection = serializeExternalAgentSelection(selection);
		if (
			safeSelection === undefined ||
			!isBoundedSafeIdentifier(safeSelection.adapterId, EXTERNAL_AGENT_ADAPTER_ID_MAX_LENGTH) ||
			!isBoundedSafeIdentifier(safeSelection.targetId, EXTERNAL_AGENT_TARGET_ID_MAX_LENGTH)
		) {
			throw new ExternalAgentError("external_agent_adapter_invalid");
		}
		const registered = this.#adapters.get(safeSelection.adapterId);
		if (registered === undefined || !registered.targets.has(safeSelection.targetId)) {
			throw new ExternalAgentError("external_agent_target_not_found");
		}
		return Object.freeze({
			adapter: registered.adapter,
			target: Object.freeze({ targetId: safeSelection.targetId }),
			selection: safeSelection,
		});
	}
}

/** Create an empty trusted adapter registry. */
export function createExternalAgentAdapterRegistry(): ExternalAgentAdapterRegistry {
	return new ExternalAgentAdapterRegistryImpl();
}

/** Registry guard used by Host wiring and contract tests. */
export function isExternalAgentAdapterRegistry(value: unknown): value is ExternalAgentAdapterRegistry {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as Partial<ExternalAgentAdapterRegistry>;
	return (
		typeof candidate.register === "function" &&
		typeof candidate.seal === "function" &&
		typeof candidate.get === "function" &&
		typeof candidate.has === "function" &&
		typeof candidate.list === "function" &&
		typeof candidate.lookupTarget === "function" &&
		typeof candidate.resolve === "function"
	);
}
