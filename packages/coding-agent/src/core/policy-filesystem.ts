import { lstat, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { PolicyError, type WorkspaceScope } from "./execution-policy.ts";

export interface HostFilesystemRoots {
	readonly workspace: string;
	readonly declaredReadOnly?: ReadonlyArray<string>;
	readonly temporary?: ReadonlyArray<string>;
	readonly credentials?: ReadonlyArray<string>;
	readonly agentInternal?: ReadonlyArray<string>;
}

export interface HostPathResolution {
	readonly requestedPath: string;
	readonly absolutePath: string;
	readonly existingPath: boolean;
	readonly realPath: string;
	readonly realParentPath: string;
	readonly scope?: WorkspaceScope;
	/** Canonical slash-separated path relative to the real workspace root. */
	readonly canonicalPath?: string;
	readonly workspaceRelativePath?: string;
}

export type FilesystemAccessKind = "read" | "write";

interface ExistingAncestorResolution {
	readonly absolutePath: string;
	readonly realPath: string;
	readonly suffix: ReadonlyArray<string>;
	readonly targetExists: boolean;
}

const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
const URI_SCHEME_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const WINDOWS_DRIVE_PATTERN = /^[A-Za-z]:[\\/]/;

function pathKey(value: string): string {
	const resolved = path.resolve(value);
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isSameOrChild(candidate: string, root: string): boolean {
	const candidateKey = pathKey(candidate);
	const rootKey = pathKey(root);
	if (candidateKey === rootKey) return true;
	const relative = path.relative(rootKey, candidateKey);
	return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function isMissingPathError(error: unknown): boolean {
	if (error === null || typeof error !== "object" || !("code" in error)) return false;
	return error.code === "ENOENT" || error.code === "ENOTDIR";
}

function parseWirePath(value: string): string {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		CONTROL_CHARACTER_PATTERN.test(value) ||
		(URI_SCHEME_PATTERN.test(value) && !WINDOWS_DRIVE_PATTERN.test(value))
	) {
		throw new PolicyError("protected_path_invalid");
	}
	return value;
}

async function requiredRealpath(value: string): Promise<string> {
	try {
		return await realpath(value);
	} catch {
		throw new PolicyError("workspace_boundary_violation");
	}
}

async function optionalRealpath(value: string): Promise<string | undefined> {
	try {
		return await realpath(value);
	} catch (error) {
		if (isMissingPathError(error)) return undefined;
		throw new PolicyError("workspace_boundary_violation");
	}
}

async function resolveExistingAncestor(absolutePath: string): Promise<ExistingAncestorResolution> {
	let current = path.resolve(absolutePath);
	const suffix: string[] = [];
	for (;;) {
		try {
			await lstat(current);
			const resolved = await requiredRealpath(current);
			if (suffix.length > 0) {
				const currentStats = await stat(resolved).catch(() => undefined);
				if (currentStats?.isDirectory() !== true) throw new PolicyError("workspace_boundary_violation");
			}
			return { absolutePath: current, realPath: resolved, suffix, targetExists: suffix.length === 0 };
		} catch (error) {
			if (error instanceof PolicyError) throw error;
			if (!isMissingPathError(error)) throw new PolicyError("workspace_boundary_violation");
			const parent = path.dirname(current);
			if (parent === current) throw new PolicyError("workspace_boundary_violation");
			suffix.unshift(path.basename(current));
			current = parent;
		}
	}
}

async function realRoots(
	roots: HostFilesystemRoots,
	workspaceRealPath: string,
): Promise<ReadonlyArray<{ scope: WorkspaceScope; path: string }>> {
	const entries: Array<{ scope: WorkspaceScope; path: string }> = [{ scope: "workspace", path: workspaceRealPath }];
	const append = async (scope: WorkspaceScope, values: ReadonlyArray<string>): Promise<void> => {
		for (const value of values) {
			const resolved = await optionalRealpath(value);
			if (resolved !== undefined) entries.push({ scope, path: resolved });
		}
	};
	await append("declared-read-only", roots.declaredReadOnly ?? []);
	await append("temporary", roots.temporary ?? []);
	await append("credentials", roots.credentials ?? []);
	await append("agent-internal", roots.agentInternal ?? []);
	return entries;
}

function scopeFor(realPathValue: string, roots: ReadonlyArray<{ scope: WorkspaceScope; path: string }>): WorkspaceScope | undefined {
	let best: { scope: WorkspaceScope; length: number } | undefined;
	for (const root of roots) {
		if (!isSameOrChild(realPathValue, root.path)) continue;
		const length = pathKey(root.path).length;
		if (best === undefined || length > best.length) best = { scope: root.scope, length };
	}
	return best?.scope;
}

function canonicalWorkspacePath(realPathValue: string, workspaceRealPath: string): string {
	const relative = path.relative(workspaceRealPath, realPathValue);
	if (relative === "") return ".";
	if (relative.startsWith("..") || path.isAbsolute(relative)) throw new PolicyError("workspace_boundary_violation");
	return relative.split(path.sep).join("/");
}

/**
 * Resolve an untrusted wire path into one canonical host classification.
 *
 * The order is security-sensitive: parse, lexical resolve, nearest existing
 * ancestor realpath, preserve every nonexistent suffix, prove real-root
 * containment, then emit a normalized workspace-relative path. Any missing
 * proof or filesystem error fails closed.
 */
export async function resolveHostPathForPolicy(input: {
	readonly cwd: string;
	readonly targetPath: string;
	readonly roots: HostFilesystemRoots;
	readonly access: FilesystemAccessKind;
}): Promise<HostPathResolution> {
	const targetPath = parseWirePath(input.targetPath);
	const workspaceRealPath = await requiredRealpath(path.resolve(input.roots.workspace));
	const cwdResolution = await resolveExistingAncestor(path.resolve(input.cwd));
	const canonicalCwd = path.resolve(cwdResolution.realPath, ...cwdResolution.suffix);
	if (!isSameOrChild(canonicalCwd, workspaceRealPath)) throw new PolicyError("workspace_boundary_violation");
	const absolutePath = path.resolve(canonicalCwd, targetPath);
	const ancestor = await resolveExistingAncestor(absolutePath);
	const realPath = path.resolve(ancestor.realPath, ...ancestor.suffix);
	const roots = await realRoots(input.roots, workspaceRealPath);
	const scope = scopeFor(realPath, roots);
	if (scope === undefined) throw new PolicyError("workspace_boundary_violation");

	// Re-read the existing ancestor after root classification. A changed link
	// or rename makes the proof stale and must not be accepted.
	if (pathKey(await requiredRealpath(ancestor.absolutePath)) !== pathKey(ancestor.realPath)) {
		throw new PolicyError("workspace_boundary_violation");
	}
	if (input.access === "write") {
		const targetStats = ancestor.targetExists ? await stat(realPath).catch(() => undefined) : undefined;
		if (targetStats?.isDirectory()) throw new PolicyError("workspace_boundary_violation");
	}
	const realParentPath = ancestor.targetExists
		? await requiredRealpath(path.dirname(absolutePath))
		: ancestor.realPath;
	const canonicalPath = scope === "workspace" ? canonicalWorkspacePath(realPath, workspaceRealPath) : undefined;
	return {
		requestedPath: input.targetPath,
		absolutePath,
		existingPath: ancestor.targetExists,
		realPath,
		realParentPath,
		scope,
		...(canonicalPath === undefined ? {} : { canonicalPath, workspaceRelativePath: canonicalPath }),
	};
}

export function assertPathInsideWorkspace(pathResolution: HostPathResolution): void {
	if (pathResolution.scope !== "workspace" || pathResolution.canonicalPath === undefined) {
		throw new PolicyError("workspace_boundary_violation");
	}
}
