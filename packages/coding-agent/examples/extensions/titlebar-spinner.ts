/**
 * Titlebar Spinner Extension
 *
 * Shows a braille spinner animation in the terminal title while the agent is working.
 * Uses `ctx.ui.setTitle()` to update the terminal title via the extension API.
 *
 * Usage:
 *   aos --extension examples/extensions/titlebar-spinner.ts
 */

import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "aos-agent";

const BRAILLE_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function getBaseTitle(agent: ExtensionAPI): string {
	const cwd = path.basename(process.cwd());
	const session = agent.getSessionName();
	return session ? `π - ${session} - ${cwd}` : `π - ${cwd}`;
}

export default function (agent: ExtensionAPI) {
	let timer: ReturnType<typeof setInterval> | null = null;
	let frameIndex = 0;

	function stopAnimation(ctx: ExtensionContext) {
		if (timer) {
			clearInterval(timer);
			timer = null;
		}
		frameIndex = 0;
		ctx.ui.setTitle(getBaseTitle(agent));
	}

	function startAnimation(ctx: ExtensionContext) {
		stopAnimation(ctx);
		timer = setInterval(() => {
			const frame = BRAILLE_FRAMES[frameIndex % BRAILLE_FRAMES.length];
			const cwd = path.basename(process.cwd());
			const session = agent.getSessionName();
			const title = session ? `${frame} π - ${session} - ${cwd}` : `${frame} π - ${cwd}`;
			ctx.ui.setTitle(title);
			frameIndex++;
		}, 80);
	}

	agent.on("agent_start", async (_event, ctx) => {
		startAnimation(ctx);
	});

	agent.on("agent_end", async (_event, ctx) => {
		stopAnimation(ctx);
	});

	agent.on("session_shutdown", async (_event, ctx) => {
		stopAnimation(ctx);
	});
}
