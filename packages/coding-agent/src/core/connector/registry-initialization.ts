import type { ExternalConnectorRegistry } from "./registry.ts";

interface ExternalConnectorRegistryInitialization {
	readonly start: () => Promise<void>;
	promise?: Promise<void>;
}

const EXTERNAL_CONNECTOR_REGISTRY_INITIALIZATIONS = new WeakMap<
	ExternalConnectorRegistry,
	ExternalConnectorRegistryInitialization
>();

/** Bind one startup barrier before a settings registry can publish readiness. */
export function bindExternalConnectorRegistryInitialization(
	registry: ExternalConnectorRegistry,
	start: () => Promise<void>,
): void {
	if (EXTERNAL_CONNECTOR_REGISTRY_INITIALIZATIONS.has(registry)) {
		throw new TypeError("External Connector registry initialization is already bound");
	}
	const initialization: ExternalConnectorRegistryInitialization = { start };
	initialization.promise = Promise.resolve().then(start);
	void initialization.promise.catch(() => undefined);
	EXTERNAL_CONNECTOR_REGISTRY_INITIALIZATIONS.set(registry, initialization);
}

/** Await the settings registry's durable recovery and registration exactly once. */
export function waitForExternalConnectorRegistryInitialization(
	registry: ExternalConnectorRegistry | undefined,
): Promise<void> {
	if (registry === undefined) return Promise.resolve();
	const initialization = EXTERNAL_CONNECTOR_REGISTRY_INITIALIZATIONS.get(registry);
	if (initialization === undefined) return Promise.resolve();
	initialization.promise ??= Promise.resolve().then(initialization.start);
	return initialization.promise;
}
