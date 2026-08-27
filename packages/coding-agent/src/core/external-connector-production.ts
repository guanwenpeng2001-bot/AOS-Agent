/** Trusted production composition for the current External Connector runtime. */

import {
	FoundationError,
	validateConnectorCapabilitySnapshotForProvider,
	type ExternalAgentConnector,
} from "@aos-agent/agent-core";
import {
	createDurableExternalAgentConnector,
	type ExternalAgentConnectorRuntimeOptions,
	type ExternalConnectorStartupRecoveryResult,
} from "./external-agent-connector.ts";
import {
	ProductionExternalConnectorProcessController,
	type ProductionExternalConnectorProcess,
} from "./external-connector-process-controller.ts";
import {
	FileExternalConnectorSupervisorPrivateStateStore,
	runExternalConnectorHostDispose,
	runExternalConnectorHostOperation,
	externalConnectorProcessContainment,
	type ExternalConnectorSupervisorDeadlineOverrides,
	type ExternalConnectorSupervisorLimits,
} from "./external-connector-supervisor.ts";
import type { RuntimeClock } from "./runtime-clock.ts";

export interface ProductionExternalConnectorSupervisionOptions {
	readonly privateStatePath: string;
	readonly process: ProductionExternalConnectorProcess;
	readonly deadlines?: ExternalConnectorSupervisorDeadlineOverrides;
	readonly limits?: Partial<ExternalConnectorSupervisorLimits>;
	readonly clock?: RuntimeClock;
}

export type ProductionExternalAgentConnectorRuntimeOptions = Omit<
	ExternalAgentConnectorRuntimeOptions,
	"supervision"
> & ProductionExternalConnectorSupervisionOptions;

export interface ProductionExternalConnectorStartupStatus {
	readonly schemaVersion: 1;
	readonly trust: "host_configured";
	readonly readiness: "ready" | "quarantined";
	readonly recovery: readonly ExternalConnectorStartupRecoveryResult[];
}

const PRODUCTION_STARTUP_STATUS = new WeakMap<ExternalAgentConnector, ProductionExternalConnectorStartupStatus>();

/** Safe startup projection retained by the trusted Host; it is never supplied by the Connector. */
export function getProductionExternalConnectorStartupStatus(
	connector: ExternalAgentConnector,
): ProductionExternalConnectorStartupStatus | undefined {
	return PRODUCTION_STARTUP_STATUS.get(connector);
}

/** Compose the production controller and restricted crash-safe private-state file. */
export function createProductionExternalConnectorSupervision(
	options: ProductionExternalConnectorSupervisionOptions,
): ExternalAgentConnectorRuntimeOptions["supervision"] {
	return Object.freeze({
		containment: externalConnectorProcessContainment(),
		processController: new ProductionExternalConnectorProcessController({
			process: options.process,
			...(options.clock === undefined ? {} : { clock: options.clock }),
		}),
		privateStateStore: new FileExternalConnectorSupervisorPrivateStateStore(options.privateStatePath),
		...(options.deadlines === undefined ? {} : { deadlines: options.deadlines }),
		...(options.limits === undefined ? {} : { limits: options.limits }),
		...(options.clock === undefined ? {} : { clock: options.clock }),
	});
}

/** Production-only connector creation; tests may continue to inject explicit supervision. */
export async function createProductionExternalAgentConnector(
	options: ProductionExternalAgentConnectorRuntimeOptions,
): Promise<ExternalAgentConnector> {
	if (typeof options.capabilityProbe !== "function") {
		throw new TypeError("Production External Connector requires an explicit capability probe.");
	}
	const connector = createDurableExternalAgentConnector({
		providerId: options.providerId,
		capability: options.capability,
		capabilityProbe: options.capabilityProbe,
		store: options.store,
		driver: options.driver,
		supervision: createProductionExternalConnectorSupervision(options),
		...(options.now === undefined ? {} : { now: options.now }),
		...(options.operationNonce === undefined ? {} : { operationNonce: options.operationNonce }),
	});
	try {
		const probed = await runExternalConnectorHostOperation(
			"start",
			(signal) => connector.probeCapabilities({ signal }),
			{
				...(options.deadlines?.start === undefined ? {} : { deadline: options.deadlines.start }),
				...(options.clock === undefined ? {} : { clock: options.clock }),
			},
		);
		if (!probed.ok) {
			throw new FoundationError("external_connector_not_ready", "Production External Connector capability probe failed.");
		}
		const checked = validateConnectorCapabilitySnapshotForProvider(probed.value, {
			providerId: options.providerId,
			providerClass: "external_connector",
		});
		if (
			!checked.ok ||
			checked.value.revision !== options.capability.revision ||
			checked.value.digest.algorithm !== options.capability.digest.algorithm ||
			checked.value.digest.value !== options.capability.digest.value
		) {
			throw new FoundationError(
				"external_capability_mismatch",
				"Production External Connector capability probe does not match its declared snapshot.",
			);
		}
		const recovery = Object.freeze([...(await connector.recoverPrivateSupervisorState())]);
		PRODUCTION_STARTUP_STATUS.set(connector, Object.freeze({
			schemaVersion: 1,
			trust: "host_configured",
			readiness: recovery.some((result) => result.status === "quarantined") ? "quarantined" : "ready",
			recovery,
		}));
		return connector;
	} catch (error) {
		try {
			await runExternalConnectorHostDispose(() => connector.dispose(), {
				...(options.deadlines?.dispose === undefined ? {} : { deadline: options.deadlines.dispose }),
				...(options.clock === undefined ? {} : { clock: options.clock }),
			});
		} catch {
			// Startup remains failed; bounded cleanup failure is represented by the original fail-closed error.
		}
		throw error;
	}
}
