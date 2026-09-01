import { existsSync } from "node:fs";
import { SessionManager, type SessionListOptions } from "../core/session/manager.ts";
import { resolvePath } from "../utils/paths.ts";

export interface SessionCommandOptions {
	cwd: string;
	sessionDir?: string;
	write?: (line: string) => void;
}

function sessionCommandUsage(): string {
	return [
		"Usage:",
		"  aos session list [--all] [--include-archived]",
		"  aos session archive <path|id>",
		"  aos session unarchive <path|id>",
		"",
		"Options:",
		"  --session-dir <dir>       Directory for session storage and lookup",
		"  --all                     List sessions across all project directories",
		"  --include-archived        Include archived sessions in list output",
	].join("\n");
}

function parseSessionCommandArgs(args: string[], defaultSessionDir: string | undefined): {
	command: string | undefined;
	target: string | undefined;
	sessionDir: string | undefined;
	all: boolean;
	includeArchived: boolean;
} {
	let sessionDir = defaultSessionDir;
	let all = false;
	let includeArchived = false;
	const positional: string[] = [];
	for (let index = 1; index < args.length; index += 1) {
		const arg = args[index]!;
		if (arg === "--session-dir") {
			const value = args[++index];
			if (value === undefined) throw new Error("--session-dir requires a value");
			sessionDir = resolvePath(value);
		} else if (arg === "--all") {
			all = true;
		} else if (arg === "--include-archived") {
			includeArchived = true;
		} else if (arg === "--help" || arg === "-h") {
			positional.push("help");
		} else if (arg.startsWith("-")) {
			throw new Error(`Unknown session option: ${arg}`);
		} else {
			positional.push(arg);
		}
	}
	return {
		command: positional[0],
		target: positional[1],
		sessionDir,
		all,
		includeArchived,
	};
}

async function resolveSessionTarget(
	target: string,
	cwd: string,
	sessionDir: string | undefined,
): Promise<{ path: string; id: string }> {
	if (target.includes("/") || target.includes("\\") || target.endsWith(".jsonl")) {
		const path = resolvePath(target, cwd);
		if (!existsSync(path)) throw new Error(`Session file not found: ${path}`);
		const manager = SessionManager.open(path);
		return { path, id: manager.getSessionId() };
	}

	const listOptions: SessionListOptions = { includeArchived: true };
	const local = await SessionManager.list(cwd, sessionDir, listOptions);
	const all = await SessionManager.listAll(sessionDir, listOptions);
	const candidates = [...local, ...all.filter((session) => !local.some((item) => item.path === session.path))];
	const exact = candidates.find((session) => session.id === target);
	if (exact) return exact;
	const prefixMatches = candidates.filter((session) => session.id.startsWith(target));
	if (prefixMatches.length === 1) return prefixMatches[0]!;
	if (prefixMatches.length > 1) throw new Error(`Session id prefix is ambiguous: ${target}`);
	throw new Error(`No session found matching '${target}'`);
}

export async function handleSessionCommand(args: string[], options: SessionCommandOptions): Promise<boolean> {
	if (args[0] !== "session") return false;
	const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
	const parsed = parseSessionCommandArgs(args, options.sessionDir);
	if (parsed.command === undefined || parsed.command === "help") {
		write(sessionCommandUsage());
		return true;
	}

	if (parsed.command === "list") {
		if (parsed.target !== undefined) throw new Error("session list does not accept a target");
		const listOptions = { includeArchived: parsed.includeArchived };
		const sessions = parsed.all
			? await SessionManager.listAll(parsed.sessionDir, listOptions)
			: await SessionManager.list(options.cwd, parsed.sessionDir, listOptions);
		for (const session of sessions) {
			write(
				[session.id, session.archived ? "archived" : "active", session.name ?? session.firstMessage, session.path].join(
					"\t",
				),
			);
		}
		return true;
	}

	if (parsed.command !== "archive" && parsed.command !== "unarchive") {
		throw new Error(`Unknown session command: ${parsed.command}`);
	}
	if (parsed.target === undefined) throw new Error(`session ${parsed.command} requires a path or session id`);
	const target = await resolveSessionTarget(parsed.target, options.cwd, parsed.sessionDir);
	const archived = parsed.command === "archive";
	SessionManager.setArchived(target.path, archived);
	write(`${archived ? "Archived" : "Unarchived"} session ${target.id}`);
	return true;
}
