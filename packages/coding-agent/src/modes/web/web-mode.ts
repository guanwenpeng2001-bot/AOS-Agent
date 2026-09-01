import { fileURLToPath } from "node:url";
import { RpcClient } from "../rpc/rpc-client.ts";
import { startWebSurfaceServer } from "./server.ts";

export interface WebModeOptions {
	readonly cwd: string;
	readonly cliArgs?: readonly string[];
	readonly port?: number;
}

/** Start a child Automation Host and expose its bounded Web surface over loopback HTTP. */
export async function runWebMode(options: WebModeOptions): Promise<void> {
	const client = new RpcClient({
		cliPath: fileURLToPath(new URL("../../cli.js", import.meta.url)),
		cwd: options.cwd,
		args: withoutWebMode(options.cliArgs ?? []),
	});
	await client.start();
	try {
		await client.initializeAutomationHost();
		const surface = await startWebSurfaceServer(client, { port: options.port });
		console.error(`AOS Agent web surface listening on ${surface.url}`);
		console.error("Loopback only. Web writes require confirmation and are restricted to Gate/Run control and Role Studio.");
		console.error(`Role Studio: ${surface.url}role-studio`);
		await waitForShutdown();
		await surface.close();
	} finally {
		await client.stop();
	}
}

function withoutWebMode(args: readonly string[]): string[] {
	const forwarded: string[] = [];
	for (let index = 0; index < args.length; index++) {
		if (args[index] === "--mode" && args[index + 1] === "web") {
			index++;
			continue;
		}
		forwarded.push(args[index]!);
	}
	return forwarded;
}

function waitForShutdown(): Promise<void> {
	return new Promise((resolve) => {
		const finish = (): void => {
			process.off("SIGINT", finish);
			process.off("SIGTERM", finish);
			resolve();
		};
		process.once("SIGINT", finish);
		process.once("SIGTERM", finish);
	});
}
