import {
	createAgentRuntimeCompositionFactory,
	createExternalAgentAdapterRegistry,
	createExternalAgentPreparedBinding,
	main,
	type ExternalAgentAdapter,
} from "../../src/index.ts";

const NOW = "2026-08-26T00:00:00.000Z";
const external = { namespace: "main-rpc-test", externalSessionId: "main-rpc-external" } as const;

function createAdapter(): ExternalAgentAdapter {
	return {
		id: "main-rpc-trusted-adapter",
		probe: async (target) => ({
			schemaVersion: 1,
			adapterId: "main-rpc-trusted-adapter",
			targetId: target.targetId,
			protocol: { name: "main-rpc-test", version: "1" },
			status: "ready",
			capabilities: {
				start: true,
				events: "none",
				cancel: "strong",
				receipt: "terminal",
				resume: false,
				artifacts: false,
				toolGateway: false,
			},
			observedAt: NOW,
		}),
		prepare: async (request, snapshot) => createExternalAgentPreparedBinding(request, snapshot),
		start: async () => ({
			external,
			events: { async *[Symbol.asyncIterator]() {} },
			receipt: Promise.resolve({
				schemaVersion: 1,
				external,
				status: "completed",
				endedAt: NOW,
				artifactRefs: [],
				sideEffects: "none",
			}),
			cancel: async () => {},
			heartbeat: async () => ({ leaseId: "main-rpc-lease", expiresAt: NOW }),
		}),
	};
}

const runtimeComposition = createAgentRuntimeCompositionFactory({
	externalAgentRegistry: () => {
		const registry = createExternalAgentAdapterRegistry();
		registry.register(createAdapter(), {
			displayName: "Main RPC trusted adapter",
			targets: ["main-rpc-target"],
		});
		return registry;
	},
});

void main([
	"--mode",
	"rpc",
	"--offline",
	"--no-session",
	"--provider",
	"google",
	"--model",
	"gemini-2.5-flash",
	"--api-key",
	"main-rpc-test-key",
	"--no-extensions",
	"--no-skills",
	"--no-prompt-templates",
	"--no-themes",
	"--no-context-files",
], { runtimeComposition });
