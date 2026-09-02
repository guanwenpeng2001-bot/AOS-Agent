import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import {
	type AgentBinding,
	type Attempt,
	type ConnectorCapabilitySnapshot,
	createConnectorCapabilitySnapshot,
	type FoundationJsonValue,
	FoundationError,
	Result,
	SessionLedger,
	type ExternalAgentConnector,
} from "@aos-agent/agent-core";
import { PROVIDER_CLASS } from "./provider-class.ts";
import type {
	AgentRuntimeCompositionContext,
	ExternalConnectorRegistryFactory,
} from "../runtime/composition-factory.ts";
import {
	type ExternalConnectorDurableStore,
	type ExternalConnectorOperation,
	SessionExternalConnectorDurableStore,
} from "./operation.ts";
import type { ExternalResolvedModelProjection } from "./model-projection.ts";
import type { ExternalModelGatewayCapability } from "./model-gateway.ts";
import type { SafeLeaseProjection } from "../worker/protocol.ts";
import type {
	ExternalConnectorCredentialRuntime,
	ExternalConnectorCredentialService,
} from "./durable-connector.ts";
import { createExternalConnectorRegistry } from "./registry.ts";
import { bindExternalConnectorRegistryInitialization } from "./registry-initialization.ts";
import { createProductionExternalAgentConnector } from "./production.ts";
import {
	ExternalConnectorTargetConfigError,
	type ExternalConnectorResolvedTarget,
} from "./target-config.ts";
import {
	loadPackagedExternalAgentDriver,
	packagedExternalAgentDriverProcessModulePath,
} from "./packaged-driver.ts";
import { JsonlProcessExternalConnectorDriver } from "./vendor/jsonl-process-driver.ts";
import type { ExternalConnectorVendorDriver } from "./vendor/types.ts";
import {
	createPrivateVendorExternalAgentConnector,
	type PrivateExternalConnectorVendorAdapterOverrides,
} from "./vendor/composition.ts";
import {
	bindExternalConnectorVendorBehaviorManifest,
	EXTERNAL_CONNECTOR_TOOL_GATEWAY_REQUEST_EVENT,
	EXTERNAL_CONNECTOR_TOOL_GATEWAY_RESULT_WRITE,
} from "./tool-gateway-binding.ts";

const PACKAGED_PROVIDER_ID = "aos.fake-connector" as const;

class SessionBoundExternalConnectorStore implements ExternalConnectorDurableStore {
	#delegate: SessionExternalConnectorDurableStore | undefined;
	#ledger: SessionLedger | undefined;

	bind(context: AgentRuntimeCompositionContext): void {
		if (this.#delegate !== undefined) throw new TypeError("Packaged External Connector store is already bound");
		this.#ledger = new SessionLedger(context.session, {
			ownerId: `settings-external-connector:${context.sessionId}`,
			writer: context.harness.ledger.writer,
		});
		this.#delegate = new SessionExternalConnectorDurableStore(this.#ledger);
	}

	async release(): Promise<void> {
		await this.#ledger?.release();
	}

	readAttempt(
		...args: Parameters<ExternalConnectorDurableStore["readAttempt"]>
	): ReturnType<ExternalConnectorDurableStore["readAttempt"]> {
		return this.#delegate?.readAttempt(...args) ?? Promise.resolve(undefined);
	}

	readBinding(
		...args: Parameters<ExternalConnectorDurableStore["readBinding"]>
	): ReturnType<ExternalConnectorDurableStore["readBinding"]> {
		return this.#delegate?.readBinding(...args) ?? Promise.resolve(undefined);
	}

	readExecutionInput(
		...args: Parameters<ExternalConnectorDurableStore["readExecutionInput"]>
	): ReturnType<ExternalConnectorDurableStore["readExecutionInput"]> {
		return this.#delegate?.readExecutionInput(...args) ?? Promise.resolve(undefined);
	}

	readOperation(
		...args: Parameters<ExternalConnectorDurableStore["readOperation"]>
	): ReturnType<ExternalConnectorDurableStore["readOperation"]> {
		return this.#delegate?.readOperation(...args) ?? Promise.resolve(undefined);
	}

	listOperations(): Promise<readonly ExternalConnectorOperation[]> {
		return this.#delegate?.listOperations() ?? Promise.resolve([]);
	}

	writeOperation(
		...args: Parameters<ExternalConnectorDurableStore["writeOperation"]>
	): ReturnType<ExternalConnectorDurableStore["writeOperation"]> {
		return this.#requireDelegate().writeOperation(...args);
	}

	readMapping(
		...args: Parameters<ExternalConnectorDurableStore["readMapping"]>
	): ReturnType<ExternalConnectorDurableStore["readMapping"]> {
		return this.#delegate?.readMapping(...args) ?? Promise.resolve(undefined);
	}

	writeMapping(
		...args: Parameters<ExternalConnectorDurableStore["writeMapping"]>
	): ReturnType<ExternalConnectorDurableStore["writeMapping"]> {
		return this.#requireDelegate().writeMapping(...args);
	}

	readReceipt(
		...args: Parameters<ExternalConnectorDurableStore["readReceipt"]>
	): ReturnType<ExternalConnectorDurableStore["readReceipt"]> {
		return this.#delegate?.readReceipt(...args) ?? Promise.resolve(undefined);
	}

	writeReceipt(
		...args: Parameters<ExternalConnectorDurableStore["writeReceipt"]>
	): ReturnType<ExternalConnectorDurableStore["writeReceipt"]> {
		return this.#requireDelegate().writeReceipt(...args);
	}

	readToolGatewayExecution(
		...args: Parameters<ExternalConnectorDurableStore["readToolGatewayExecution"]>
	): ReturnType<ExternalConnectorDurableStore["readToolGatewayExecution"]> {
		return this.#delegate?.readToolGatewayExecution(...args) ?? Promise.resolve(undefined);
	}

	listToolGatewayExecutions(
		...args: Parameters<ExternalConnectorDurableStore["listToolGatewayExecutions"]>
	): ReturnType<ExternalConnectorDurableStore["listToolGatewayExecutions"]> {
		return this.#delegate?.listToolGatewayExecutions(...args) ?? Promise.resolve([]);
	}

	writeToolGatewayIntent(
		...args: Parameters<ExternalConnectorDurableStore["writeToolGatewayIntent"]>
	): ReturnType<ExternalConnectorDurableStore["writeToolGatewayIntent"]> {
		return this.#requireDelegate().writeToolGatewayIntent(...args);
	}

	writeToolGatewayTerminal(
		...args: Parameters<ExternalConnectorDurableStore["writeToolGatewayTerminal"]>
	): ReturnType<ExternalConnectorDurableStore["writeToolGatewayTerminal"]> {
		return this.#requireDelegate().writeToolGatewayTerminal(...args);
	}

	#requireDelegate(): SessionExternalConnectorDurableStore {
		if (this.#delegate === undefined) throw new TypeError("Packaged External Connector store is not session-bound");
		return this.#delegate;
	}
}

class SessionBoundExternalConnectorCredentialRuntime implements ExternalConnectorCredentialRuntime {
	readonly service: ExternalConnectorCredentialService;
	#delegate: ExternalConnectorCredentialRuntime | undefined;
	#bound = false;

	constructor() {
		this.service = Object.freeze({
			issueForTaskRun: (...args: Parameters<ExternalConnectorCredentialService["issueForTaskRun"]>) =>
				this.#delegate?.service.issueForTaskRun(...args) ?? {
					ok: false as const,
					code: "task_credential_target_unavailable" as const,
				},
			lookupDeliveredLease: (...args: Parameters<ExternalConnectorCredentialService["lookupDeliveredLease"]>) =>
				this.#delegate?.service.lookupDeliveredLease(...args) ?? {
					ok: false as const,
					code: "task_credential_target_unavailable" as const,
				},
			releaseDeliveredLease: (...args: Parameters<ExternalConnectorCredentialService["releaseDeliveredLease"]>) =>
				this.#delegate?.service.releaseDeliveredLease(...args) ?? {
					ok: false as const,
					code: "task_credential_target_unavailable" as const,
				},
		});
	}

	bind(runtime: ExternalConnectorCredentialRuntime | undefined): void {
		if (this.#bound) throw new TypeError("Packaged External Connector credential runtime is already bound");
		this.#bound = true;
		this.#delegate = runtime;
	}

	openModelGateway(
		lease: SafeLeaseProjection,
		projection: ExternalResolvedModelProjection,
	): Promise<ExternalModelGatewayCapability | undefined> | undefined {
		return this.#delegate?.openModelGateway?.(lease, projection);
	}

	closeModelGateway(capability: ExternalModelGatewayCapability): boolean {
		return this.#delegate?.closeModelGateway?.(capability) ?? false;
	}

	modelGatewayEnvironment(capability: ExternalModelGatewayCapability): Readonly<Record<string, string>> {
		return this.#delegate?.modelGatewayEnvironment?.(capability) ?? Object.freeze({});
	}

	disposeModelGateway(): Promise<void> {
		return this.#delegate?.disposeModelGateway?.() ?? Promise.resolve();
	}

	resolveIssueContext(
		attempt: Attempt,
		binding: AgentBinding,
		correlation: Parameters<ExternalConnectorCredentialRuntime["resolveIssueContext"]>[2],
		modelProjection: Parameters<ExternalConnectorCredentialRuntime["resolveIssueContext"]>[3],
	) {
		return this.#delegate?.resolveIssueContext(attempt, binding, correlation, modelProjection);
	}
}

class PackagedExternalConnectorVendorDriver implements ExternalConnectorVendorDriver {
	readonly #store: SessionBoundExternalConnectorStore;

	constructor(store: SessionBoundExternalConnectorStore) {
		this.#store = store;
	}

	async spawn(request: Parameters<ExternalConnectorVendorDriver["spawn"]>[0]) {
		return {
			externalSessionId: `packaged_session_${request.attempt.attemptId}`,
			externalTurnId: `packaged_turn_${request.attempt.attemptId}`,
			supervisorRef: request.supervisorRef,
			operationNonce: request.operationNonce,
		};
	}

	async *events(handle: Parameters<ExternalConnectorVendorDriver["events"]>[0]): AsyncIterable<FoundationJsonValue> {
		yield {
			schemaVersion: 1,
			type: "started",
			externalSessionId: handle.externalSessionId,
			...(handle.externalTurnId === undefined ? {} : { externalTurnId: handle.externalTurnId }),
			producedAt: new Date().toISOString(),
		};
	}

	async connect(mapping: Parameters<ExternalConnectorVendorDriver["connect"]>[0]) {
		return {
			externalSessionId: mapping.externalSessionId,
			...(mapping.externalTurnId === undefined ? {} : { externalTurnId: mapping.externalTurnId }),
			supervisorRef: mapping.supervisor.ref,
			operationNonce: mapping.supervisor.nonce,
		};
	}

	async lookup(): ReturnType<ExternalConnectorVendorDriver["lookup"]> {
		return { status: "missing" };
	}

	async read(handle: Parameters<ExternalConnectorVendorDriver["read"]>[0]) {
		return {
			externalSessionId: handle.externalSessionId,
			...(handle.externalTurnId === undefined ? {} : { externalTurnId: handle.externalTurnId }),
			operationNonce: handle.operationNonce,
			status: "succeeded" as const,
			artifacts: [],
			sideEffectState: "none" as const,
			producedAt: new Date().toISOString(),
		};
	}

	async write(): Promise<void> {}
	async heartbeat(): Promise<void> {}

	async cancel(handle: Parameters<ExternalConnectorVendorDriver["cancel"]>[0]) {
		return {
			externalSessionId: handle.externalSessionId,
			...(handle.externalTurnId === undefined ? {} : { externalTurnId: handle.externalTurnId }),
			operationNonce: handle.operationNonce,
			status: "cancelled" as const,
			artifacts: [],
			sideEffectState: "none" as const,
			producedAt: new Date().toISOString(),
		};
	}

	async dispose(): Promise<void> {
		await this.#store.release();
	}
}

function sha256Identity(path: string): string {
	return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}

function matchesPackagedTarget(target: ExternalConnectorResolvedTarget): boolean {
	if (target.providerId !== PACKAGED_PROVIDER_ID || target.version !== "1") return false;
	const processModule = packagedExternalAgentDriverProcessModulePath("fake-connector");
	try {
		return (
			realpathSync(target.executablePath) === realpathSync(process.execPath) &&
			realpathSync(target.modulePath) === realpathSync(processModule) &&
			target.executableIdentity === sha256Identity(process.execPath) &&
			target.moduleIdentity === sha256Identity(processModule)
		);
	} catch {
		return false;
	}
}

function packagedCapability(): ConnectorCapabilitySnapshot {
	return createConnectorCapabilitySnapshot({
		schemaVersion: 1,
		providerId: PACKAGED_PROVIDER_ID,
		revision: 1,
		protocol: { name: "aos.fake-connector", version: "1" },
		modelAccess: "none",
		resume: true,
		toolGateway: false,
		artifacts: false,
		images: false,
	});
}

/** Derive the only runtime capability snapshot a trusted generic target may advertise. */
function genericTargetCapability(target: ExternalConnectorResolvedTarget): ConnectorCapabilitySnapshot {
	const modelAccess = target.capabilityCeiling.modelAccess[0];
	if (modelAccess === undefined) throw new TypeError("External Connector target capability ceiling is empty");
	if (target.capabilityCeiling.modelAccess.includes("aos_gateway")) {
		throw new ExternalConnectorTargetConfigError(
			"capability_widened",
			"$.selectedTarget.capabilityCeiling.modelAccess",
			"Generic External Connector targets cannot use aos_gateway model access.",
		);
	}
	return createConnectorCapabilitySnapshot({
		schemaVersion: 1,
		providerId: target.providerId,
		revision: 1,
		protocol: { name: target.providerId, version: target.version },
		modelAccess,
		resume: target.capabilityCeiling.resume,
		toolGateway: target.capabilityCeiling.toolGateway,
		artifacts: target.capabilityCeiling.artifacts,
		images: target.capabilityCeiling.images,
	});
}

function targetPrivateStatePath(target: ExternalConnectorResolvedTarget, agentDir: string): string {
	return join(
		agentDir,
		"external-connectors",
		`${createHash("sha256").update(target.targetId).digest("hex")}.json`,
	);
}

/** Activate the shipped fake or any trusted settings-selected JSONL target. */
export async function createPackagedExternalConnectorRegistryFactory(options: {
	readonly target: ExternalConnectorResolvedTarget;
	readonly agentDir: string;
	/** Host-private deterministic adapter seam. Stock settings omit this. */
	readonly vendorAdapters?: PrivateExternalConnectorVendorAdapterOverrides;
}): Promise<ExternalConnectorRegistryFactory | undefined> {
	const packaged = matchesPackagedTarget(options.target);
	if (packaged) loadPackagedExternalAgentDriver("fake-connector");
	const store = new SessionBoundExternalConnectorStore();
	const credentialRuntime = new SessionBoundExternalConnectorCredentialRuntime();
	const privateStatePath = targetPrivateStatePath(options.target, options.agentDir);
	const vendor = options.target.driver === undefined
		? undefined
		: await createPrivateVendorExternalAgentConnector({
				target: options.target,
				store,
				privateStatePath,
				credential: credentialRuntime,
				...(options.vendorAdapters === undefined ? {} : { adapters: options.vendorAdapters }),
			});
	const capability = vendor?.capability ?? (packaged ? packagedCapability() : genericTargetCapability(options.target));
	let jsonlDriver: JsonlProcessExternalConnectorDriver | undefined;
	let driver: ExternalConnectorVendorDriver | undefined;
	if (vendor !== undefined) {
		driver = undefined;
	} else if (packaged) {
		driver = new PackagedExternalConnectorVendorDriver(store);
	} else {
		jsonlDriver = new JsonlProcessExternalConnectorDriver({
			providerId: options.target.providerId,
			version: options.target.version,
			capability,
		});
		driver = jsonlDriver;
	}
	let connector: ExternalAgentConnector | undefined = vendor?.connector;
	if (connector === undefined) {
		if (driver === undefined) throw new TypeError("Packaged External Connector driver is unavailable");
		connector = await createProductionExternalAgentConnector({
			providerId: options.target.providerId,
			capability,
			capabilityProbe: async () => Result.ok(capability),
			store,
			driver,
			privateStatePath,
			target: options.target,
			credential: credentialRuntime,
		});
	}
	const preparedConnector = connector;
	return (context, toolGateway, target, authority, credential) => {
		if (target !== options.target) {
			throw new TypeError("Packaged External Connector factory target does not match its trusted target");
		}
		void authority;
		credentialRuntime.bind(credential);
		store.bind(context);
		const registry = createExternalConnectorRegistry({
			...(toolGateway === undefined ? {} : { toolGateway }),
		});
		if (jsonlDriver !== undefined) {
			const implementedOperations = jsonlDriver.jsonlImplementedOperations;
			bindExternalConnectorVendorBehaviorManifest(connector, () => ({
				schemaVersion: 1,
				revision: capability.revision,
				events: implementedOperations.includes(EXTERNAL_CONNECTOR_TOOL_GATEWAY_REQUEST_EVENT)
					? [EXTERNAL_CONNECTOR_TOOL_GATEWAY_REQUEST_EVENT]
					: [],
				writes: implementedOperations.includes(EXTERNAL_CONNECTOR_TOOL_GATEWAY_RESULT_WRITE)
					? [EXTERNAL_CONNECTOR_TOOL_GATEWAY_RESULT_WRITE]
					: [],
			}));
		}
		const registration = {
				descriptor: {
					schemaVersion: 1 as const,
					providerId: options.target.providerId,
					providerClass: PROVIDER_CLASS.externalConnector,
					revision: capability.revision,
					capabilitySnapshotDigest: capability.digest,
				},
				connector: preparedConnector,
			};
		const registerPrepared = (): void => {
			const registered = registry.registerPrepared(registration, capability);
			if (!registered.ok) throw registered.error;
		};
		if (vendor === undefined) {
			try {
				registerPrepared();
			} catch (error) {
				void preparedConnector.dispose();
				throw error;
			}
		} else {
			bindExternalConnectorRegistryInitialization(registry, async () => {
				try {
					const recovery = await vendor.connector.recoverPrivateSupervisorState();
					if (recovery.some((result) => result.status === "quarantined")) {
						throw new FoundationError(
							"external_connector_not_ready",
							"Settings External Connector startup recovery requires reconciliation",
						);
					}
					registerPrepared();
				} catch (error) {
					await preparedConnector.dispose().catch(() => undefined);
					throw error;
				}
			});
		}
		return registry;
	};
}
