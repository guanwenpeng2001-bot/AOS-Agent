/**
 * Bash Spawn Hook Example
 *
 * Adjusts command, cwd, and env before execution.
 *
 * Usage:
 *   aos -e ./bash-spawn-hook.ts
 */

import type { ExtensionAPI } from "aos-agent";
import { createBashTool } from "aos-agent";

export default function (agent: ExtensionAPI) {
	const cwd = process.cwd();

	const bashTool = createBashTool(cwd, {
		spawnHook: ({ command, cwd, env }) => ({
			command: `source ~/.profile\n${command}`,
			cwd,
			env: { ...env, AOS_AGENT_SPAWN_HOOK: "1" },
		}),
	});

	agent.registerTool({
		...bashTool,
		execute: async (id, params, signal, onUpdate, _ctx) => {
			return bashTool.execute(id, params, signal, onUpdate);
		},
	});
}
