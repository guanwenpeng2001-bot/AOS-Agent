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
	resolveProductionExternalConnectorDriverProvenance,
	type ProductionExternalConnectorDriverProvenance,
	type ProductionExternalConnectorProcessWithProvenance,
} from "./external-connector-process-controller.ts";
import {
	assertExternalConnectorCapabilityWithinTarget,
	externalConnectorProcessForTarget,
	type ExternalConnectorResolvedTarget,
} from "./external-connector-target-config.ts";
import {
	FileExternalConnectorSupervisorPrivateStateStore,
	runExternalConnectorHostDispose,
	runExternalConnectorHostOperation,
	externalConnectorProcessContainment,
	type ExternalConnectorSupervisorDeadlineOverrides,
	type ExternalConnectorSupervisorLimits,
} from "./external-connector-supervisor.ts";
import type { RuntimeClock } from "./runtime-clock.ts";
import {
	resolveRuntimeLimitsSource,
	runtimeLimitsFromSupervisorOptions,
	runtimeLimitsReadinessDeadline,
	runtimeLimitsShutdownDeadline,
	runtimeLimitsSupervisorDeadlines,
	runtimeLimitsSupervisorLimits,
	type RuntimeLimitsSource,
} from "./runtime-limits.ts";
import type { ExternalConnectorVendorDriver } from "./vendor-drivers/types.ts";

export interface ProductionExternalConnectorSupervisionOptions {
	readonly privateStatePath: string;
	readonly process: ProductionExternalConnectorProcessWithProvenance;
	readonly deadlines?: ExternalConnectorSupervisorDeadlineOverrides;
	readonly limits?: Partial<ExternalConnectorSupervisorLimits>;
	readonly runtimeLimits?: RuntimeLimitsSource;
	readonly clock?: RuntimeClock;
}

export type ProductionExternalAgentConnectorRuntimeOptions = Omit<
	ExternalAgentConnectorRuntimeOptions,
	"runtimeLimits" | "supervision"
> &
	Omit<ProductionExternalConnectorSupervisionOptions, "process"> &
	(
		| {
				readonly target: ExternalConnectorResolvedTarget;
				readonly process?: never;
		  }
		| {
				readonly target?: never;
				readonly process: ProductionExternalConnectorProcessWithProvenance;
		  }
	);

export interface ProductionExternalConnectorStartupStatus {
	readonly schemaVersion: 1;
	readonly trust: "host_configured";
	readonly readiness: "ready" | "quarantined";
	readonly recovery: readonly ExternalConnectorStartupRecoveryResult[];
}

const PRODUCTION_STARTUP_STATUS = new WeakMap<ExternalAgentConnector, ProductionExternalConnectorStartupStatus>();
const PRODUCTION_DRIVER_PROVENANCE = new WeakMap<ExternalAgentConnector, ProductionExternalConnectorDriverProvenance>();
const PRODUCTION_VENDOR_DRIVER = new WeakMap<ExternalAgentConnector, ExternalConnectorVendorDriver>();
const PRODUCTION_TARGET = new WeakMap<ExternalAgentConnector, ExternalConnectorResolvedTarget>();

class BoundProductionExternalConnectorVendorDriver implements ExternalConnectorVendorDriver {
	readonly process: ProductionExternalConnectorProcessWithProvenance;
	readonly provenance: ProductionExternalConnectorDriverProvenance;
	readonly #source: ExternalConnectorVendorDriver;

	constructor(
		source: ExternalConnectorVendorDriver,
		process: ProductionExternalConnectorProcessWithProvenance,
		provenance: ProductionExternalConnectorDriverProvenance,
	) {
		this.#source = source;
		this.process = process;
		this.provenance = provenance;
	}

	get modelSupportMatrix(): ExternalConnectorVendorDriver["modelSupportMatrix"] {
		return this.#source.modelSupportMatrix;
	}

	spawn(...args: Parameters<ExternalConnectorVendorDriver["spawn"]>): ReturnType<ExternalConnectorVendorDriver["spawn"]> {
		return this.#source.spawn(...args);
	}

	events(...args: Parameters<ExternalConnectorVendorDriver["events"]>): ReturnType<ExternalConnectorVendorDriver["events"]> {
		return this.#source.events(...args);
	}

	connect(...args: Parameters<ExternalConnectorVendorDriver["connect"]>): ReturnType<ExternalConnectorVendorDriver["connect"]> {
		return this.#source.connect(...args);
	}

	lookup(...args: Parameters<ExternalConnectorVendorDriver["lookup"]>): ReturnType<ExternalConnectorVendorDriver["lookup"]> {
		return this.#source.lookup(...args);
	}

	read(...args: Parameters<ExternalConnectorVendorDriver["read"]>): ReturnType<ExternalConnectorVendorDriver["read"]> {
		return this.#source.read(...args);
	}

	write(...args: Parameters<ExternalConnectorVendorDriver["write"]>): ReturnType<ExternalConnectorVendorDriver["write"]> {
		return this.#source.write(...args);
	}

	heartbeat(...args: Parameters<ExternalConnectorVendorDriver["heartbeat"]>): ReturnType<ExternalConnectorVendorDriver["heartbeat"]> {
		return this.#source.heartbeat(...args);
	}

	cancel(...args: Parameters<ExternalConnectorVendorDriver["cancel"]>): ReturnType<ExternalConnectorVendorDriver["cancel"]> {
		return this.#source.cancel(...args);
	}

	dispose(...args: Parameters<ExternalConnectorVendorDriver["dispose"]>): ReturnType<ExternalConnectorVendorDriver["dispose"]> {
		return this.#source.dispose(...args);
	}
}

const PRODUCTION_VENDOR_DRIVER_BINDING = new WeakMap<
	ExternalConnectorVendorDriver,
	BoundProductionExternalConnectorVendorDriver
>();

/** Safe startup projection retained by the trusted Host; it is never supplied by the Connector. */
export function getProductionExternalConnectorStartupStatus(
	connector: ExternalAgentConnector,
): ProductionExternalConnectorStartupStatus | undefined {
	return PRODUCTION_STARTUP_STATUS.get(connector);
}

/** Private Host evidence; intentionally omitted from the package-root public API. */
export function getProductionExternalConnectorDriverProvenance(
	connector: ExternalAgentConnector,
): ProductionExternalConnectorDriverProvenance | undefined {
	return PRODUCTION_DRIVER_PROVENANCE.get(connector);
}

/** Private Host evidence that identifies the exact driver used by the connector. */
export function getProductionExternalConnectorVendorDriver(
	connector: ExternalAgentConnector,
): ExternalConnectorVendorDriver | undefined {
	return PRODUCTION_VENDOR_DRIVER.get(connector);
}

/** Private Host evidence binding a production connector to its selected trusted target. */
export function getProductionExternalConnectorTarget(
	connector: ExternalAgentConnector,
): ExternalConnectorResolvedTarget | undefined {
	return PRODUCTION_TARGET.get(connector);
}

/** Private Host evidence bound directly to the driver instance used for execution. */
export function getProductionExternalConnectorVendorDriverProvenance(
	driver: ExternalConnectorVendorDriver,
): ProductionExternalConnectorDriverProvenance | undefined {
	return PRODUCTION_VENDOR_DRIVER_BINDING.get(driver)?.provenance;
}

/** Private Host evidence binding the execution driver to its exact process target. */
export function getProductionExternalConnectorVendorDriverProcess(
	driver: ExternalConnectorVendorDriver,
): ProductionExternalConnectorProcessWithProvenance | undefined {
	return PRODUCTION_VENDOR_DRIVER_BINDING.get(driver)?.process;
}

function canonicalProductionDriverProcess(
	value: ProductionExternalConnectorProcessWithProvenance,
	provenance: ProductionExternalConnectorDriverProvenance,
): ProductionExternalConnectorProcessWithProvenance {
	if (value.arguments !== undefined && !Array.isArray(value.arguments)) {
		throw new TypeError("External Connector companion process arguments are invalid");
	}
	return Object.freeze({
		executablePath: provenance.executablePath,
		...(value.arguments === undefined ? {} : { arguments: Object.freeze([...value.arguments]) }),
		trustedProvenance: Object.freeze({
			modulePath: provenance.modulePath,
			cwd: provenance.cwd,
			version: provenance.version,
			executableIdentity: provenance.executableIdentity,
			moduleIdentity: provenance.moduleIdentity,
		}),
	});
}

function sameProductionDriverProcess(
	left: ProductionExternalConnectorProcessWithProvenance,
	right: ProductionExternalConnectorProcessWithProvenance,
): boolean {
	const leftArguments = left.arguments ?? [];
	const rightArguments = right.arguments ?? [];
	return (
		left.executablePath === right.executablePath &&
		leftArguments.length === rightArguments.length &&
		leftArguments.every((argument, index) => argument === rightArguments[index]) &&
		left.trustedProvenance.modulePath === right.trustedProvenance.modulePath &&
		left.trustedProvenance.cwd === right.trustedProvenance.cwd &&
		left.trustedProvenance.version === right.trustedProvenance.version &&
		left.trustedProvenance.executableIdentity === right.trustedProvenance.executableIdentity &&
		left.trustedProvenance.moduleIdentity === right.trustedProvenance.moduleIdentity
	);
}

function bindProductionVendorDriver(
	driver: ExternalConnectorVendorDriver,
	process: ProductionExternalConnectorProcessWithProvenance,
): BoundProductionExternalConnectorVendorDriver {
	const provenance = resolveProductionExternalConnectorDriverProvenance(process);
	if (provenance === undefined) {
		throw new TypeError("Production External Connector requires trusted driver provenance");
	}
	const canonicalProcess = canonicalProductionDriverProcess(process, provenance);
	const existing = PRODUCTION_VENDOR_DRIVER_BINDING.get(driver);
	if (existing !== undefined) {
		if (!sameProductionDriverProcess(existing.process, canonicalProcess)) {
			throw new TypeError("External Connector vendor driver is already bound to another trusted process target");
		}
		return existing;
	}
	const binding = new BoundProductionExternalConnectorVendorDriver(driver, canonicalProcess, provenance);
	PRODUCTION_VENDOR_DRIVER_BINDING.set(driver, binding);
	PRODUCTION_VENDOR_DRIVER_BINDING.set(binding, binding);
	return binding;
}

/** Compose the production controller and restricted crash-safe private-state file. */
export function createProductionExternalConnectorSupervision(
	options: ProductionExternalConnectorSupervisionOptions,
): ExternalAgentConnectorRuntimeOptions["supervision"] {
	const runtimeLimits = resolveRuntimeLimitsSource(
		options.runtimeLimits ?? runtimeLimitsFromSupervisorOptions(options.deadlines, options.limits),
	);
	return Object.freeze({
		containment: externalConnectorProcessContainment(),
		processController: new ProductionExternalConnectorProcessController({
			process: options.process,
			...(options.clock === undefined ? {} : { clock: options.clock }),
		}),
		privateStateStore: new FileExternalConnectorSupervisorPrivateStateStore(options.privateStatePath),
		deadlines: runtimeLimitsSupervisorDeadlines(runtimeLimits),
		limits: runtimeLimitsSupervisorLimits(runtimeLimits),
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
	if (options.target !== undefined) {
		assertExternalConnectorCapabilityWithinTarget(options.target, options.capability);
		if (options.target.providerId !== options.providerId) {
			throw new TypeError("Production External Connector target provider does not match the runtime provider");
		}
	}
	const process = options.target === undefined ? options.process : externalConnectorProcessForTarget(options.target);
	const runtimeLimitsSource =
		options.runtimeLimits ?? runtimeLimitsFromSupervisorOptions(options.deadlines, options.limits);
	const startupRuntimeLimits = resolveRuntimeLimitsSource(runtimeLimitsSource);
	const driverBinding = bindProductionVendorDriver(options.driver, process);
	const connector = createDurableExternalAgentConnector({
		providerId: options.providerId,
		capability: options.capability,
		capabilityProbe: options.capabilityProbe,
		store: options.store,
		driver: driverBinding,
		supervision: createProductionExternalConnectorSupervision({
			privateStatePath: options.privateStatePath,
			process: driverBinding.process,
			runtimeLimits: startupRuntimeLimits,
			...(options.clock === undefined ? {} : { clock: options.clock }),
		}),
		runtimeLimits: runtimeLimitsSource,
		...(options.now === undefined ? {} : { now: options.now }),
		...(options.operationNonce === undefined ? {} : { operationNonce: options.operationNonce }),
	});
	try {
		const probed = await runExternalConnectorHostOperation(
			"start",
			(signal) => connector.probeCapabilities({ signal }),
			{
				deadline: runtimeLimitsReadinessDeadline(startupRuntimeLimits),
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
		PRODUCTION_VENDOR_DRIVER.set(connector, driverBinding);
		PRODUCTION_DRIVER_PROVENANCE.set(connector, driverBinding.provenance);
		if (options.target !== undefined) PRODUCTION_TARGET.set(connector, options.target);
		return connector;
	} catch (error) {
		try {
			await runExternalConnectorHostDispose(() => connector.dispose(), {
				deadline: runtimeLimitsShutdownDeadline(startupRuntimeLimits),
				...(options.clock === undefined ? {} : { clock: options.clock }),
			});
		} catch {
			// Startup remains failed; bounded cleanup failure is represented by the original fail-closed error.
		}
		throw error;
	}
}
