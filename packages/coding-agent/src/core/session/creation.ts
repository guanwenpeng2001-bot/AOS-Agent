import { getDefaultSessionDir, SessionManager } from "./manager.ts";
import { resolvePath } from "../../utils/paths.ts";

export type SessionCreationOptions =
	| { readonly mode: "memory"; readonly id?: string; readonly fromPr?: string }
	| { readonly mode: "new"; readonly directory?: string; readonly id?: string; readonly fromPr?: string }
	| { readonly mode: "continue"; readonly directory?: string }
	| { readonly mode: "open"; readonly path: string; readonly directory?: string };

export function createSessionManagerForOptions(options: {
	readonly cwd?: string;
	readonly agentDir: string;
	readonly session?: SessionCreationOptions;
}): { readonly cwd: string; readonly sessionManager: SessionManager } {
	const openedSessionManager = options.session?.mode === "open"
		? SessionManager.open(options.session.path, options.session.directory)
		: undefined;
	const cwd = resolvePath(options.cwd ?? openedSessionManager?.getCwd() ?? process.cwd());
	const sessionManager = openedSessionManager ?? (options.session?.mode === "memory"
		? SessionManager.inMemory(cwd, {
				...(options.session.id === undefined ? {} : { id: options.session.id }),
				...(options.session.fromPr === undefined ? {} : { fromPr: options.session.fromPr }),
			})
		: options.session?.mode === "continue"
			? SessionManager.continueRecent(cwd, options.session.directory ?? getDefaultSessionDir(cwd, options.agentDir))
			: SessionManager.create(
				cwd,
				options.session?.mode === "new"
					? options.session.directory ?? getDefaultSessionDir(cwd, options.agentDir)
					: getDefaultSessionDir(cwd, options.agentDir),
				options.session?.mode === "new"
					? {
							...(options.session.id === undefined ? {} : { id: options.session.id }),
							...(options.session.fromPr === undefined ? {} : { fromPr: options.session.fromPr }),
						}
					: undefined,
			));
	return { cwd, sessionManager };
}
