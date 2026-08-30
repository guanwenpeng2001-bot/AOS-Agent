import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import {
	type ConnectorCapabilitySnapshot,
	createConnectorCapabilitySnapshot,
	type FoundationJsonValue,
	Result,
	SessionLedger,
} from "../../../../agent/src/internal.ts";
import type {
	AgentRuntimeCompositionContext,
	ExternalConnectorRegistryFactory,
} from "../runtime/composition.ts";
import {
	type ExternalConnectorDurableStore,
	SessionExternalConnectorDurableStore,
} from "./operation.ts";
import { createExternalConnectorRegistry } from "./registry.ts";
import { createProductionExternalAgentConnector } from "./production.ts";
import type { ExternalConnectorResolvedTarget } from "./target-config.ts";
import {
	loadPackagedExternalAgentDriver,
	packagedExternalAgentDriverProcessModulePath,
} from "./packaged-driver.ts";
import type { ExternalConnectorVendorDriver } from "./vendor/types.ts";

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

/** Activate only the shipped fake driver; arbitrary configured targets remain fail-closed. */
export async function createPackagedExternalConnectorRegistryFactory(options: {
	readonly target: ExternalConnectorResolvedTarget;
	readonly agentDir: string;
}): Promise<ExternalConnectorRegistryFactory | undefined> {
	if (!matchesPackagedTarget(options.target)) return undefined;
	loadPackagedExternalAgentDriver("fake-connector");
	const store = new SessionBoundExternalConnectorStore();
	const capability = packagedCapability();
	const connector = await createProductionExternalAgentConnector({
		providerId: PACKAGED_PROVIDER_ID,
		capability,
		capabilityProbe: async () => Result.ok(capability),
		store,
		driver: new PackagedExternalConnectorVendorDriver(store),
		privateStatePath: join(
			options.agentDir,
			"external-connectors",
			`${createHash("sha256").update(options.target.targetId).digest("hex")}.json`,
		),
		target: options.target,
	});
	const registry = createExternalConnectorRegistry();
	const registered = registry.registerPrepared(
		{
			descriptor: {
				schemaVersion: 1,
				providerId: PACKAGED_PROVIDER_ID,
				providerClass: "external_connector",
				revision: capability.revision,
				capabilitySnapshotDigest: capability.digest,
			},
			connector,
		},
		capability,
	);
	if (!registered.ok) {
		await connector.dispose();
		throw registered.error;
	}
	return (context) => {
		store.bind(context);
		return registry;
	};
}
