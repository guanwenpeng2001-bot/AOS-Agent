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
}

export type FilesystemAccessKind = "read" | "write";

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

async function realpathIfExists(value: string): Promise<string | undefined> {
	try {
		return await realpath(value);
	} catch {
		return undefined;
	}
}

async function nearestExistingParent(absolutePath: string): Promise<string> {
	let current = path.dirname(absolutePath);
	for (;;) {
		const resolved = await realpathIfExists(current);
		if (resolved !== undefined) return resolved;
		const parent = path.dirname(current);
		if (parent === current) throw new PolicyError("workspace_boundary_violation", "No existing parent directory.");
		current = parent;
	}
}

async function hasLinkSegment(absolutePath: string, stopAtRealParent: string): Promise<boolean> {
	let current = path.resolve(absolutePath);
	const stopKey = pathKey(stopAtRealParent);
	for (;;) {
		const currentKey = pathKey(current);
		if (currentKey === stopKey) return false;
		try {
			const currentLstat = await lstat(current);
			if (currentLstat.isSymbolicLink()) return true;
		} catch {}
		const parent = path.dirname(current);
		if (parent === current) return false;
		current = parent;
	}
}

async function realRoots(roots: HostFilesystemRoots): Promise<ReadonlyArray<{ scope: WorkspaceScope; path: string }>> {
	const entries: Array<{ scope: WorkspaceScope; path: string }> = [];
	const append = async (scope: WorkspaceScope, values: ReadonlyArray<string>): Promise<void> => {
		for (const value of values) {
			const resolved = await realpathIfExists(value);
			if (resolved !== undefined) entries.push({ scope, path: resolved });
		}
	};
	await append("workspace", [roots.workspace]);
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

export async function resolveHostPathForPolicy(input: {
	readonly cwd: string;
	readonly targetPath: string;
	readonly roots: HostFilesystemRoots;
	readonly access: FilesystemAccessKind;
}): Promise<HostPathResolution> {
	const absolutePath = path.resolve(input.cwd, input.targetPath);
	const parentRealPath = await nearestExistingParent(absolutePath);
	const targetRealPath = await realpathIfExists(absolutePath);
	const existingPath = targetRealPath !== undefined;
	const realPath = targetRealPath ?? path.join(parentRealPath, path.basename(absolutePath));
	const roots = await realRoots(input.roots);
	const scope = scopeFor(existingPath ? realPath : parentRealPath, roots);
	if (scope === undefined) {
		throw new PolicyError("workspace_boundary_violation");
	}
	if (await hasLinkSegment(absolutePath, existingPath ? realPath : parentRealPath)) {
		const finalScope = scopeFor(realPath, roots);
		if (finalScope === undefined || finalScope !== scope) {
			throw new PolicyError("workspace_boundary_violation");
		}
	}
	if (input.access === "write") {
		const targetStats = existingPath ? await stat(realPath).catch(() => undefined) : undefined;
		if (targetStats?.isDirectory()) throw new PolicyError("workspace_boundary_violation", "Cannot write directory.");
	}
	return {
		requestedPath: input.targetPath,
		absolutePath,
		existingPath,
		realPath,
		realParentPath: parentRealPath,
		scope,
	};
}

export function assertPathInsideWorkspace(pathResolution: HostPathResolution): void {
	if (pathResolution.scope === undefined) throw new PolicyError("workspace_boundary_violation");
}
