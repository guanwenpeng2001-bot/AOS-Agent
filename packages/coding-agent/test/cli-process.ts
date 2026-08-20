import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const workspaceRoot = resolve(__dirname, "../../..");
const sourceTsconfigPath = resolve(workspaceRoot, "tsconfig.json");
const tsxLoaderUrl = pathToFileURL(require.resolve("tsx")).href;

/**
 * Launch source-mode TypeScript children from temporary working directories.
 * Windows does not inherit Vitest's source loader, and package exports point at
 * dist files, so tsx must receive the workspace path mappings explicitly.
 */
export function sourceProcessArgs(entryPath: string, args: readonly string[] = []): string[] {
	return process.platform === "win32" ? ["--import", tsxLoaderUrl, entryPath, ...args] : [entryPath, ...args];
}

export function sourceProcessEnv(): NodeJS.ProcessEnv {
	return { ...process.env, TSX_TSCONFIG_PATH: sourceTsconfigPath };
}
