/** Trusted, instance-only External Connector registry. */

import {
	FoundationError,
	Result,
	cloneDeepFrozen,
	validateToolExecutionResult,
	validateToolGatewayRequest,
	validateConnectorCapabilitySnapshotForProvider,
	type ConnectorCapabilitySnapshot,
	type ExternalAgentConnector,
	type Fingerprint,
	type Result as ResultValue,
	type ToolExecutionResult,
	type ToolGatewayRequest,
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
	getHostSupervisedExternalAgentConnectorImplementation,
	type HostSupervisedExternalAgentConnectorImplementation,
} from "./external-agent-connector.ts";

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
	/** @internal Bind this Host selection as the consumer authority for one durable Attempt. */
	bindToolGatewayConsumer(attemptId: string): () => void;
}

export interface ExternalConnectorRegistry {
	register(
		registration: ExternalConnectorRegistration,
	): Promise<ResultValue<ExternalConnectorDescriptor, FoundationError>>;
	/** Trusted composition bootstrap when the exact probed snapshot is already pinned. */
	registerPrepared(
		registration: ExternalConnectorRegistration,
		capabilitySnapshot: ConnectorCapabilitySnapshot,
	): ResultValue<ExternalConnectorDescriptor, FoundationError>;
	select(
		selection: ExternalConnectorSelection,
	): Promise<ResultValue<ExternalConnectorResolvedSelection, FoundationError>>;
	list(): readonly ExternalConnectorDescriptor[];
	dispose(): Promise<void>;
}

interface RegisteredConnector {
	readonly descriptor: ExternalConnectorDescriptor;
	readonly connector: ExternalAgentConnector;
	readonly implementation: HostSupervisedExternalAgentConnectorImplementation;
	readonly selectedConnector: ExternalAgentConnector;
	readonly capabilitySnapshot: ConnectorCapabilitySnapshot;
	readonly capabilityTruth: ExternalCapabilityTruthSnapshot;
	readonly capabilityHandlers: Readonly<
		Partial<Record<ExternalCapabilityBehavior, ExternalCapabilityHandlerEvidence["invoke"]>>
	>;
	readonly capabilityEvidence?: ExternalCapabilityEvidenceInput;
}

interface PendingConnector {
	readonly connector: ExternalAgentConnector;
	readonly implementation: HostSupervisedExternalAgentConnectorImplementation;
}

const EXTERNAL_CONNECTOR_DESCRIPTOR_KEYS = new Set([
	"schemaVersion",
	"providerId",
	"providerClass",
	"revision",
	"capabilitySnapshotDigest",
]);
const EXTERNAL_CONNECTOR_REGISTRATION_KEYS = new Set(["descriptor", "connector", "trusted", "capabilityEvidence"]);
const EXTERNAL_CONNECTOR_SELECTION_KEYS = new Set(["providerId", "revision", "capabilitySnapshotDigest"]);
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
	const implementation = getHostSupervisedExternalAgentConnectorImplementation(value);
	if (implementation === undefined || !isConnectorRecord(value)) return false;
	return (
		implementation.schemaVersion === 1 &&
		isExternalConnectorIdentifier(implementation.providerId) &&
		implementation.providerClass === "external_connector" &&
		typeof implementation.capabilities === "function" &&
		typeof implementation.dispose === "function" &&
		typeof implementation.createAttempt === "function" &&
		typeof implementation.runAttempt === "function" &&
		typeof implementation.cancelAttempt === "function" &&
		typeof implementation.probeCapabilities === "function" &&
		typeof implementation.resumeAttempt === "function" &&
		typeof implementation.reconcileAttempt === "function"
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

function cloneCapabilityEvidence(
	value: ExternalCapabilityEvidenceInput | undefined,
): ExternalCapabilityEvidenceInput | undefined {
	if (value === undefined) return undefined;
	const cloned: Partial<
		Record<ExternalCapabilityBehavior, NonNullable<ExternalCapabilityEvidenceInput[ExternalCapabilityBehavior]>>
	> = {};
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

function lifecycleCapabilityError(): FoundationError {
	return new FoundationError(
		"scheduler_attempt_recovery_failed",
		"External connector capability truth could not be rechecked",
	);
}

function createCapabilityPinnedConnector(
	connector: ExternalAgentConnector,
	implementation: HostSupervisedExternalAgentConnectorImplementation,
	recheck: () => Promise<FoundationError | undefined>,
): ExternalAgentConnector {
	const reconcileAttempt: ExternalAgentConnector["reconcileAttempt"] = async (attempt, options) => {
		await recheck();
		return Reflect.apply(implementation.reconcileAttempt, connector, [attempt, options]);
	};
	const runAttempt: ExternalAgentConnector["runAttempt"] = async (attempt, options) => {
		const drift = await recheck();
		if (drift !== undefined) {
			return Reflect.apply(implementation.reconcileAttempt, connector, [attempt, options]);
		}
		return Reflect.apply(implementation.runAttempt, connector, [attempt, options]);
	};
	const resumeAttempt: ExternalAgentConnector["resumeAttempt"] = async (attempt, options) => {
		const drift = await recheck();
		return drift === undefined
			? Reflect.apply(implementation.resumeAttempt, connector, [attempt, options])
			: Reflect.apply(implementation.reconcileAttempt, connector, [attempt, options]);
	};
	const cancelAttempt: ExternalAgentConnector["cancelAttempt"] = async (attemptId) => {
		const drift = await recheck();
		return drift === undefined
			? Reflect.apply(implementation.cancelAttempt, connector, [attemptId])
			: Result.err(drift);
	};
	const capabilities: ExternalAgentConnector["capabilities"] = () =>
		Reflect.apply(implementation.capabilities, connector, []);
	const dispose: ExternalAgentConnector["dispose"] = () => Reflect.apply(implementation.dispose, connector, []);
	const probeCapabilities: ExternalAgentConnector["probeCapabilities"] = () =>
		Reflect.apply(implementation.probeCapabilities, connector, []);
	const createAttempt: ExternalAgentConnector["createAttempt"] = (dispatch, binding, context) =>
		Reflect.apply(implementation.createAttempt, connector, [dispatch, binding, context]);
	const preflightModelProjection: HostSupervisedExternalAgentConnectorImplementation["preflightModelProjection"] = (
		projection,
	) => Reflect.apply(implementation.preflightModelProjection, connector, [projection]);
	return Object.freeze({
		schemaVersion: implementation.schemaVersion,
		providerId: implementation.providerId,
		providerClass: implementation.providerClass,
		preflightModelProjection,
		capabilities,
		dispose,
		probeCapabilities,
		createAttempt,
		runAttempt,
		cancelAttempt,
		resumeAttempt,
		reconcileAttempt,
	});
}

function capabilityTruth(
	connectorId: string,
	snapshot: ConnectorCapabilitySnapshot,
	evidence: ExternalCapabilityEvidenceInput | undefined,
): ResultValue<ExternalCapabilityTruthSnapshot, FoundationError> {
	const result = createExternalCapabilityTruthSnapshot({
		connectorId,
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
		: Result.err(
				connectorRegistryError(`External connector capability evidence failed closed: ${result.error.reasonCode}.`),
			);
}

async function probeConnector(
	connector: ExternalAgentConnector,
	implementation: HostSupervisedExternalAgentConnectorImplementation,
): Promise<ResultValue<ConnectorCapabilitySnapshot, FoundationError>> {
	try {
		const probed: unknown = await Reflect.apply(implementation.probeCapabilities, connector, []);
		if (getHostSupervisedExternalAgentConnectorImplementation(connector) !== implementation) {
			return Result.err(
				connectorRegistryError("External connector constructed implementation changed while probing capabilities."),
			);
		}
		if (!isConnectorRecord(probed) || typeof probed.ok !== "boolean") {
			return Result.err(connectorRegistryError("External connector returned a malformed capability probe result."));
		}
		if (probed.ok) {
			if (!hasExactConnectorKeys(probed, RESULT_OK_KEYS)) {
				return Result.err(
					connectorRegistryError("External connector returned a malformed capability probe result."),
				);
			}
			return validateConnectorCapabilitySnapshotForProvider(probed.value, implementation);
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
	readonly #pendingRegistrations = new Map<string, PendingConnector>();
	readonly #disposedConnectors = new Set<ExternalAgentConnector>();
	#disposed = false;

	async #disposeConnectorOnce(
		connector: ExternalAgentConnector,
		implementation: HostSupervisedExternalAgentConnectorImplementation,
	): Promise<void> {
		if (this.#disposedConnectors.has(connector)) return;
		this.#disposedConnectors.add(connector);
		await Reflect.apply(implementation.dispose, connector, []);
	}

	async #verifyRegisteredConnector(registered: RegisteredConnector): Promise<
		ResultValue<
			{
				readonly snapshot: ConnectorCapabilitySnapshot;
				readonly truth: ExternalCapabilityTruthSnapshot;
			},
			FoundationError
		>
	> {
		if (
			this.#disposed ||
			this.#connectors.get(registered.descriptor.providerId) !== registered ||
			getHostSupervisedExternalAgentConnectorImplementation(registered.connector) !== registered.implementation ||
			registered.implementation.providerClass !== "external_connector" ||
			registered.implementation.providerId !== registered.descriptor.providerId
		) {
			return Result.err(connectorRegistryError("External connector registry or constructed instance changed."));
		}
		const snapshotResult = await probeConnector(registered.connector, registered.implementation);
		if (!snapshotResult.ok) return snapshotResult;
		if (this.#disposed || this.#connectors.get(registered.descriptor.providerId) !== registered) {
			return Result.err(
				connectorRegistryError("External connector registry changed while resolving the selection."),
			);
		}
		const snapshot = snapshotResult.value;
		if (
			snapshot.revision !== registered.descriptor.revision ||
			!sameFingerprint(snapshot.digest, registered.capabilitySnapshot.digest) ||
			!sameFingerprint(snapshot.digest, registered.descriptor.capabilitySnapshotDigest)
		) {
			return Result.err(
				connectorRegistryError("External connector capability snapshot drifted after registration."),
			);
		}
		const truthResult = capabilityTruth(
			registered.implementation.providerId,
			snapshot,
			registered.capabilityEvidence,
		);
		if (!truthResult.ok) return truthResult;
		if (!sameFingerprint(truthResult.value.snapshotDigest, registered.capabilityTruth.snapshotDigest)) {
			return Result.err(
				connectorRegistryError("External connector capability evidence drifted after registration."),
			);
		}
		return Result.ok({ snapshot, truth: truthResult.value });
	}

	async register(
		registration: ExternalConnectorRegistration,
	): Promise<ResultValue<ExternalConnectorDescriptor, FoundationError>> {
		if (this.#disposed) return Result.err(connectorRegistryError("External connector registry is disposed."));
		if (!isExternalConnectorRegistration(registration)) {
			return Result.err(
				connectorRegistryError(
					"External connector registration must contain one trusted constructed instance and an exact descriptor.",
				),
			);
		}
		const descriptor = registration.descriptor;
		const connector = registration.connector;
		const implementation = getHostSupervisedExternalAgentConnectorImplementation(connector);
		if (implementation === undefined) {
			return Result.err(
				connectorRegistryError("External connector constructed implementation changed before registration."),
			);
		}
		if (this.#connectors.has(descriptor.providerId) || this.#pendingRegistrations.has(descriptor.providerId)) {
			return Result.err(connectorRegistryError("External connector provider identity is already registered."));
		}
		if (
			descriptor.providerId !== implementation.providerId ||
			descriptor.providerClass !== implementation.providerClass
		) {
			return Result.err(
				connectorRegistryError("External connector descriptor identity does not match its constructed instance."),
			);
		}
		if (this.#disposed) return Result.err(connectorRegistryError("External connector registry is disposed."));

		const pending = Object.freeze({ connector, implementation });
		this.#pendingRegistrations.set(descriptor.providerId, pending);
		try {
			const snapshotResult = await probeConnector(connector, implementation);
			if (!snapshotResult.ok) return snapshotResult;
			if (this.#disposed) {
				await Promise.resolve().then(() => this.#disposeConnectorOnce(connector, implementation));
				return Result.err(connectorRegistryError("External connector registry is disposed."));
			}
			return this.#registerPrepared(registration, snapshotResult.value);
		} finally {
			if (this.#pendingRegistrations.get(descriptor.providerId) === pending) {
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
			return Result.err(
				connectorRegistryError(
					"External connector registration must contain one trusted constructed instance and an exact descriptor.",
				),
			);
		}
		const descriptor = registration.descriptor;
		const connector = registration.connector;
		const implementation = getHostSupervisedExternalAgentConnectorImplementation(connector);
		if (implementation === undefined) {
			return Result.err(
				connectorRegistryError("External connector constructed implementation changed before registration."),
			);
		}
		if (this.#connectors.has(descriptor.providerId) || this.#pendingRegistrations.has(descriptor.providerId)) {
			return Result.err(connectorRegistryError("External connector provider identity is already registered."));
		}
		if (this.#disposed) return Result.err(connectorRegistryError("External connector registry is disposed."));
		const pending = Object.freeze({ connector, implementation });
		this.#pendingRegistrations.set(descriptor.providerId, pending);
		try {
			return this.#registerPrepared(registration, capabilitySnapshot);
		} finally {
			if (this.#pendingRegistrations.get(descriptor.providerId) === pending) {
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
			return Result.err(
				connectorRegistryError(
					"External connector registration must contain one trusted constructed instance and an exact descriptor.",
				),
			);
		}
		const descriptor = registration.descriptor;
		const connector = registration.connector;
		const implementation = getHostSupervisedExternalAgentConnectorImplementation(connector);
		const pending = this.#pendingRegistrations.get(descriptor.providerId);
		if (
			implementation === undefined ||
			this.#connectors.has(descriptor.providerId) ||
			pending?.connector !== connector ||
			pending.implementation !== implementation ||
			descriptor.providerId !== implementation.providerId ||
			descriptor.providerClass !== implementation.providerClass
		) {
			return Result.err(
				connectorRegistryError(
					"External connector provider identity is already registered or does not match its constructed instance.",
				),
			);
		}
		const checkedSnapshot = validateConnectorCapabilitySnapshotForProvider(capabilitySnapshot, implementation);
		if (!checkedSnapshot.ok) return checkedSnapshot;
		const snapshot = checkedSnapshot.value;
		if (
			descriptor.revision !== snapshot.revision ||
			!sameFingerprint(descriptor.capabilitySnapshotDigest, snapshot.digest)
		) {
			return Result.err(
				connectorRegistryError(
					"External connector descriptor revision or capability snapshot digest does not match its probe.",
				),
			);
		}
		const truthResult = capabilityTruth(implementation.providerId, snapshot, registration.capabilityEvidence);
		if (!truthResult.ok) return truthResult;
		const evidence = cloneCapabilityEvidence(registration.capabilityEvidence);
		const handlers = capabilityHandlers(evidence);
		const storedDescriptor = cloneConnectorDescriptor(descriptor);
		if (this.#disposed || this.#pendingRegistrations.get(descriptor.providerId) !== pending) {
			return Result.err(connectorRegistryError("External connector registry is disposed."));
		}
		let stored: RegisteredConnector | undefined;
		const selectedConnector = createCapabilityPinnedConnector(connector, implementation, async () => {
			if (stored === undefined) return lifecycleCapabilityError();
			const verified = await this.#verifyRegisteredConnector(stored);
			return verified.ok ? undefined : lifecycleCapabilityError();
		});
		stored = {
			descriptor: storedDescriptor,
			connector,
			implementation,
			selectedConnector,
			capabilitySnapshot: snapshot,
			capabilityTruth: truthResult.value,
			capabilityHandlers: handlers,
			...(evidence === undefined ? {} : { capabilityEvidence: evidence }),
		};
		this.#connectors.set(descriptor.providerId, stored);
		return Result.ok(storedDescriptor);
	}

	async select(
		selection: ExternalConnectorSelection,
	): Promise<ResultValue<ExternalConnectorResolvedSelection, FoundationError>> {
		if (this.#disposed) return Result.err(connectorRegistryError("External connector registry is disposed."));
		if (!isExternalConnectorSelection(selection)) {
			return Result.err(
				connectorRegistryError(
					"External connector selection must pin an exact provider id, revision, and capability snapshot digest.",
				),
			);
		}
		const registered = this.#connectors.get(selection.providerId);
		if (
			registered === undefined ||
			selection.revision !== registered.descriptor.revision ||
			!sameFingerprint(selection.capabilitySnapshotDigest, registered.descriptor.capabilitySnapshotDigest)
		) {
			return Result.err(
				connectorRegistryError("External connector selection is unknown or does not match its pinned descriptor."),
			);
		}
		const verified = await this.#verifyRegisteredConnector(registered);
		if (!verified.ok) return verified;
		const executeToolGateway = async (
			request: ToolGatewayRequest,
			options?: { readonly signal?: AbortSignal },
		): Promise<ResultValue<ToolExecutionResult, FoundationError>> => {
			const current = await this.#verifyRegisteredConnector(registered);
			if (!current.ok) return Result.err(lifecycleCapabilityError());
			if (!current.value.truth.capabilities.toolGateway) {
				return Result.err(connectorRegistryError("External connector does not support the Tool Gateway bridge."));
			}
			const checkedRequest = validateToolGatewayRequest(request);
			if (!checkedRequest.ok) return checkedRequest;
			const canonicalRequest = cloneDeepFrozen(checkedRequest.value);
			const handler = registered.capabilityHandlers.toolGateway;
			if (handler === undefined) {
				return Result.err(connectorRegistryError("External connector Tool Gateway handler is unavailable."));
			}
			if (options?.signal?.aborted === true) {
				return Result.err(
					new FoundationError("provider_spawn_failed", "External connector Tool Gateway request was aborted."),
				);
			}
			let result: unknown;
			try {
				result = await Reflect.apply(handler, undefined, [canonicalRequest, options ?? {}]);
			} catch {
				return Result.err(
					new FoundationError("provider_spawn_failed", "External connector Tool Gateway handler failed."),
				);
			}
			if (!isConnectorRecord(result) || typeof result.ok !== "boolean") {
				return Result.err(
					connectorRegistryError("External connector Tool Gateway handler returned a malformed result."),
				);
			}
			if (!result.ok) {
				return hasExactConnectorKeys(result, RESULT_ERROR_KEYS) && FoundationError.is(result.error)
					? Result.err(result.error)
					: Result.err(
							connectorRegistryError("External connector Tool Gateway handler returned a malformed failure."),
						);
			}
			if (!hasExactConnectorKeys(result, RESULT_OK_KEYS)) {
				return Result.err(
					connectorRegistryError("External connector Tool Gateway handler returned a malformed result."),
				);
			}
			const checkedResult = validateToolExecutionResult(result.value);
			if (!checkedResult.ok) return checkedResult;
			if (
				checkedResult.value.toolCallId !== canonicalRequest.toolCallId ||
				checkedResult.value.toolName !== canonicalRequest.toolName
			) {
				return Result.err(
					connectorRegistryError("External connector Tool Gateway result does not match its request."),
				);
			}
			return Result.ok(cloneDeepFrozen(checkedResult.value));
		};
		const bindToolGatewayConsumer: ExternalConnectorResolvedSelection["bindToolGatewayConsumer"] = (attemptId) =>
			Reflect.apply(registered.implementation.bindToolGatewayConsumer, registered.connector, [
				attemptId,
				executeToolGateway,
			]);
		return Result.ok(
			Object.freeze({
				descriptor: registered.descriptor,
				connector: registered.selectedConnector,
				capabilitySnapshot: verified.value.snapshot,
				capabilityTruth: verified.value.truth,
				bindToolGatewayConsumer,
			}),
		);
	}

	list(): readonly ExternalConnectorDescriptor[] {
		return Object.freeze([...this.#connectors.values()].map(({ descriptor }) => descriptor));
	}

	async dispose(): Promise<void> {
		if (this.#disposed) return;
		this.#disposed = true;
		const connectors: readonly PendingConnector[] = [
			...Array.from(this.#connectors.values(), ({ connector, implementation }) => ({ connector, implementation })),
			...this.#pendingRegistrations.values(),
		];
		this.#connectors.clear();
		this.#pendingRegistrations.clear();
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				Promise.allSettled(
					connectors.map(({ connector, implementation }) =>
						Promise.resolve().then(() => this.#disposeConnectorOnce(connector, implementation)),
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
