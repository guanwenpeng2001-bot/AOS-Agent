/** Trusted production composition for the current External Connector runtime. */

import {
	DurableExternalAgentConnector,
	type ExternalAgentConnectorRuntimeOptions,
} from "./external-agent-connector.ts";
import {
	ProductionExternalConnectorProcessController,
	type ProductionExternalConnectorProcess,
} from "./external-connector-process-controller.ts";
import {
	FileExternalConnectorSupervisorPrivateStateStore,
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

/** Compose the production controller and restricted crash-safe private-state file. */
export function createProductionExternalConnectorSupervision(
	options: ProductionExternalConnectorSupervisionOptions,
): ExternalAgentConnectorRuntimeOptions["supervision"] {
	return Object.freeze({
		containment: externalConnectorProcessContainment(),
		processController: new ProductionExternalConnectorProcessController({ process: options.process }),
		privateStateStore: new FileExternalConnectorSupervisorPrivateStateStore(options.privateStatePath),
		...(options.deadlines === undefined ? {} : { deadlines: options.deadlines }),
		...(options.limits === undefined ? {} : { limits: options.limits }),
		...(options.clock === undefined ? {} : { clock: options.clock }),
	});
}

/** Production-only connector creation; tests may continue to inject explicit supervision. */
export function createProductionExternalAgentConnector(
	options: ProductionExternalAgentConnectorRuntimeOptions,
): DurableExternalAgentConnector {
	return new DurableExternalAgentConnector({
		providerId: options.providerId,
		capability: options.capability,
		store: options.store,
		driver: options.driver,
		supervision: createProductionExternalConnectorSupervision(options),
		...(options.now === undefined ? {} : { now: options.now }),
		...(options.operationNonce === undefined ? {} : { operationNonce: options.operationNonce }),
	});
}
