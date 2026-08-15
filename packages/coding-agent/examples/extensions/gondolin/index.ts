/**
 * Gondolin sandbox provider example.
 *
 * The extension entry point is intentionally inert. SandboxProvider registration
 * is host composition, so loading this example must not start a VM or change
 * the legacy host execution path. Import the provider factory and pass the
 * resulting provider through createAgentSession({ sandboxProviders }).
 */

import type { ExtensionAPI } from "aos-agent";

export {
	GUEST_WORKSPACE,
	GondolinPathMapper,
	createGondolinPathMapper,
} from "./path-mapper.ts";
export {
	createGondolinSandboxProvider,
	GONDOLIN_SANDBOX_CAPABILITIES,
	GONDOLIN_SANDBOX_PROVIDER_ID,
} from "./provider.ts";
export type { GondolinSandboxProviderOptions } from "./provider.ts";

/**
 * Keep the extension loader entry point side-effect free. The AgentSession
 * owns provider preparation, handle disposal, and operation routing.
 */
export default function gondolinExtension(_agent: ExtensionAPI): void {}
