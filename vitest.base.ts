import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export const workspaceSourcePaths = {
	telemetryIndex: fileURLToPath(new URL("./packages/telemetry/src/index.ts", import.meta.url)),
	telemetryTesting: fileURLToPath(new URL("./packages/telemetry/src/testing/index.ts", import.meta.url)),
	aiIndex: fileURLToPath(new URL("./packages/ai/src/index.ts", import.meta.url)),
	aiCompat: fileURLToPath(new URL("./packages/ai/src/compat.ts", import.meta.url)),
	aiOAuth: fileURLToPath(new URL("./packages/ai/src/oauth.ts", import.meta.url)),
	aiProviders: fileURLToPath(new URL("./packages/ai/src/providers", import.meta.url)),
	agentIndex: fileURLToPath(new URL("./packages/agent/src/index.ts", import.meta.url)),
	agentNode: fileURLToPath(new URL("./packages/agent/src/node.ts", import.meta.url)),
	agentSessionTesting: fileURLToPath(
		new URL("./packages/agent/src/harness/session/testing/index.ts", import.meta.url),
	),
	codingAgentIndex: fileURLToPath(new URL("./packages/coding-agent/src/index.ts", import.meta.url)),
	tuiIndex: fileURLToPath(new URL("./packages/tui/src/index.ts", import.meta.url)),
} as const;

export default defineConfig({
	resolve: {
		alias: [
			{ find: /^@aos-agent\/telemetry$/, replacement: workspaceSourcePaths.telemetryIndex },
			{ find: /^@aos-agent\/telemetry\/testing$/, replacement: workspaceSourcePaths.telemetryTesting },
			{ find: /^@aos-agent\/ai$/, replacement: workspaceSourcePaths.aiIndex },
			{ find: /^@aos-agent\/ai\/compat$/, replacement: workspaceSourcePaths.aiCompat },
			{ find: /^@aos-agent\/ai\/oauth$/, replacement: workspaceSourcePaths.aiOAuth },
			{
				find: /^@aos-agent\/ai\/providers\/(.+)$/,
				replacement: `${workspaceSourcePaths.aiProviders}/$1.ts`,
			},
			{ find: /^@aos-agent\/agent-core$/, replacement: workspaceSourcePaths.agentIndex },
			{ find: /^@aos-agent\/agent-core\/node$/, replacement: workspaceSourcePaths.agentNode },
			{
				find: /^@aos-agent\/agent-core\/session\/testing$/,
				replacement: workspaceSourcePaths.agentSessionTesting,
			},
			{ find: /^@aos-agent\/tui$/, replacement: workspaceSourcePaths.tuiIndex },
			{ find: /^aos-agent$/, replacement: workspaceSourcePaths.codingAgentIndex },
		],
	},
});
