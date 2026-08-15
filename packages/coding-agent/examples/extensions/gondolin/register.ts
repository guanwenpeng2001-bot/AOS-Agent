import { createGondolinSandboxProvider as createGondolinSandboxProviderCore } from "./provider.ts";
import type { GondolinSandboxProviderOptions } from "./provider.ts";
import { createGondolinVmFactory } from "./vm-factory.ts";

export {
	GONDOLIN_SANDBOX_CAPABILITIES,
	GONDOLIN_SANDBOX_PROVIDER_ID,
} from "./provider.ts";
export type { GondolinSandboxProviderOptions } from "./provider.ts";

/**
 * Production entry for trusted host composition. Contract tests import the
 * core factory from provider.ts and inject a fake VM; this wrapper is the
 * only module that loads the optional Gondolin runtime.
 */
export function createGondolinSandboxProvider(options: GondolinSandboxProviderOptions) {
	return createGondolinSandboxProviderCore({
		...options,
		vmFactory: options.vmFactory ?? createGondolinVmFactory(),
	});
}
