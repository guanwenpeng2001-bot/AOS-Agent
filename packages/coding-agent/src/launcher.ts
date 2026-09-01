#!/usr/bin/env node

import { createRequire } from "node:module";
import { normalizeLauncherWorkingDirectory } from "./launcher-paths.ts";

function launch(): void {
	const currentWorkingDirectory = process.cwd();
	const launcherWorkingDirectory = normalizeLauncherWorkingDirectory(currentWorkingDirectory);
	if (launcherWorkingDirectory !== currentWorkingDirectory) {
		try {
			process.chdir(launcherWorkingDirectory);
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			console.error(`Unable to start from the long Windows working directory: ${reason}`);
			process.exitCode = 1;
			return;
		}
	}

	const require = createRequire(import.meta.url);
	require("./cli.js");
}

launch();
