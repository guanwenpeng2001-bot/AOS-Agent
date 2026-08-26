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
	readonly #pendingRegistrations = new Map<string, ExternalAgentConnector>();
	readonly #disposedConnectors = new Set<ExternalAgentConnector>();
	#disposed = false;

	async #disposeConnectorOnce(connector: ExternalAgentConnector): Promise<void> {
		if (this.#disposedConnectors.has(connector)) return;
		this.#disposedConnectors.add(connector);
		await connector.dispose();
	}

	async register(
		registration: ExternalConnectorRegistration,
	): Promise<ResultValue<ExternalConnectorDescriptor, FoundationError>> {
		if (this.#disposed) return Result.err(connectorRegistryError("External connector registry is disposed."));
		if (!isExternalConnectorRegistration(registration)) {
			return Result.err(connectorRegistryError("External connector registration must contain one trusted constructed instance and an exact descriptor."));
		}
		const descriptor = registration.descriptor;
		const connector = registration.connector;
		if (this.#connectors.has(descriptor.providerId) || this.#pendingRegistrations.has(descriptor.providerId)) {
			return Result.err(connectorRegistryError("External connector provider identity is already registered."));
		}
		if (descriptor.providerId !== connector.providerId || descriptor.providerClass !== connector.providerClass) {
			return Result.err(connectorRegistryError("External connector descriptor identity does not match its constructed instance."));
		}
		if (this.#disposed) return Result.err(connectorRegistryError("External connector registry is disposed."));

		this.#pendingRegistrations.set(descriptor.providerId, connector);
		try {
			const snapshotResult = await probeConnector(connector);
			if (!snapshotResult.ok) return snapshotResult;
			if (this.#disposed) {
				await Promise.resolve().then(() => this.#disposeConnectorOnce(connector));
				return Result.err(connectorRegistryError("External connector registry is disposed."));
			}
			return this.#registerPrepared(registration, snapshotResult.value);
		} finally {
			if (this.#pendingRegistrations.get(descriptor.providerId) === connector) {
				this.#pendingRegistrations.delete(descriptor.providerId);
			}
		}
	}

	registerPrepared(
		registration: ExternalConnectorRegistration,
		capabilitySnapshot: ConnectorCapabilitySnapshot,
	): ResultValue<ExternalConnectorDescriptor, FoundationError> {
		if (this.#disposed) return Result.err(connectorRegistryError("External connector registry is disposed."));
		if (!isExternalConnectorRegistration(registration)) {
			return Result.err(connectorRegistryError("External connector registration must contain one trusted constructed instance and an exact descriptor."));
		}
		const descriptor = registration.descriptor;
		const connector = registration.connector;
		if (this.#connectors.has(descriptor.providerId) || this.#pendingRegistrations.has(descriptor.providerId)) {
			return Result.err(connectorRegistryError("External connector provider identity is already registered."));
		}
		if (this.#disposed) return Result.err(connectorRegistryError("External connector registry is disposed."));
		this.#pendingRegistrations.set(descriptor.providerId, connector);
		try {
			return this.#registerPrepared(registration, capabilitySnapshot);
		} finally {
			if (this.#pendingRegistrations.get(descriptor.providerId) === connector) {
				this.#pendingRegistrations.delete(descriptor.providerId);
			}
		}
	}

	#registerPrepared(
		registration: ExternalConnectorRegistration,
		capabilitySnapshot: ConnectorCapabilitySnapshot,
	): ResultValue<ExternalConnectorDescriptor, FoundationError> {
		if (this.#disposed) return Result.err(connectorRegistryError("External connector registry is disposed."));
		if (!isExternalConnectorRegistration(registration)) {
			return Result.err(connectorRegistryError("External connector registration must contain one trusted constructed instance and an exact descriptor."));
		}
		const descriptor = registration.descriptor;
		const connector = registration.connector;
		if (this.#connectors.has(descriptor.providerId) || this.#pendingRegistrations.get(descriptor.providerId) !== connector ||
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
		if (this.#disposed || this.#pendingRegistrations.get(descriptor.providerId) !== connector) {
			return Result.err(connectorRegistryError("External connector registry is disposed."));
		}
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
		if (this.#disposed || this.#connectors.get(selection.providerId) !== registered) {
			return Result.err(connectorRegistryError("External connector registry changed while resolving the selection."));
		}

		const snapshotResult = await probeConnector(registered.connector);
		if (!snapshotResult.ok) return snapshotResult;
		if (this.#disposed || this.#connectors.get(selection.providerId) !== registered) {
			return Result.err(connectorRegistryError("External connector registry changed while resolving the selection."));
		}
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
		if (this.#disposed || this.#connectors.get(selection.providerId) !== registered) {
			return Result.err(connectorRegistryError("External connector registry changed while resolving the selection."));
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
		const connectors = [
			...Array.from(this.#connectors.values(), ({ connector }) => connector),
			...this.#pendingRegistrations.values(),
		];
		this.#connectors.clear();
		this.#pendingRegistrations.clear();
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				Promise.allSettled(
					connectors.map((connector) =>
						Promise.resolve().then(() => this.#disposeConnectorOnce(connector)),
					),
				),
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
