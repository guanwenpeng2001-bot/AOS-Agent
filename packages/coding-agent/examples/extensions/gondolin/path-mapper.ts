import { lstat as fsLstat, realpath as fsRealpath } from "node:fs/promises";
import path from "node:path";

export const GUEST_WORKSPACE = "/workspace";

export type GondolinAdapterErrorCode =
	| "workspace_boundary_violation"
	| "sandbox_unavailable"
	| "policy_violation";

const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
const DRIVE_PATH_PATTERN = /^[A-Za-z]:/;
const UNC_PATH_PATTERN = /^(?:\\\\|\/\/|\\\\\?\\|\\\\\.\\)/;

export class GondolinAdapterError extends Error {
	readonly code: GondolinAdapterErrorCode;
	readonly retryable = false as const;

	constructor(code: GondolinAdapterErrorCode, message: string) {
		super(message);
		this.name = "GondolinAdapterError";
		this.code = code;
	}
}

export interface HostPathStat {
	isDirectory(): boolean;
	isSymbolicLink(): boolean;
}

/**
 * The only host-side filesystem seam used by path validation. Actual guest
 * reads and writes never use this interface.
 */
export interface HostPathOperations {
	lstat(pathName: string): Promise<HostPathStat>;
	realpath(pathName: string): Promise<string>;
}

export const defaultHostPathOperations: HostPathOperations = {
	lstat: fsLstat,
	realpath: fsRealpath,
};

export interface GuestPathOptions {
	/** Allow a missing leaf when its nearest existing parent is safe. */
	readonly allowMissing?: boolean;
}

export interface GondolinPathMapperOptions {
	readonly workspaceRoot: string;
	readonly guestWorkspace?: string;
	readonly hostOperations?: HostPathOperations;
}

function safeBoundaryError(): GondolinAdapterError {
	return new GondolinAdapterError(
		"workspace_boundary_violation",
		"The path cannot be mapped inside the guest workspace.",
	);
}

function safePathInputError(): GondolinAdapterError {
	return new GondolinAdapterError("workspace_boundary_violation", "The path is not valid for the guest workspace.");
}

function isMissingPathError(error: unknown): boolean {
	if (typeof error !== "object" || error === null || !("code" in error)) return false;
	const code = (error as { readonly code?: unknown }).code;
	return code === "ENOENT" || code === "ENOTDIR";
}

function normalizedForComparison(value: string): string {
	const normalized = path.normalize(value);
	return path.sep === "\\" ? normalized.toLowerCase() : normalized;
}

function isInside(root: string, value: string): boolean {
	const relativePath = path.relative(normalizedForComparison(root), normalizedForComparison(value));
	return relativePath === "" || (!relativePath.startsWith(`..${path.sep}`) && relativePath !== ".." && !path.isAbsolute(relativePath));
}

function normalizeGuestWorkspace(value: string): string {
	if (CONTROL_CHARACTER_PATTERN.test(value) || !value.startsWith("/") || value.startsWith("//")) {
		throw safePathInputError();
	}
	const rawSegments = value.split("/");
	if (rawSegments.some((segment) => segment === "..")) throw safePathInputError();
	const normalized = path.posix.normalize(value);
	if (normalized === "/" || normalized === "." || normalized === ".." || normalized.startsWith("/../")) {
		throw safePathInputError();
	}
	return normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

function stripAtPrefix(value: string): string {
	const trimmed = value.trim();
	return trimmed.startsWith("@") ? trimmed.slice(1).trim() : trimmed;
}

function ensureSafeHostInput(value: string): void {
	if (!value || CONTROL_CHARACTER_PATTERN.test(value) || UNC_PATH_PATTERN.test(value)) {
		throw safePathInputError();
	}
	if (value.replace(/\\/g, "/").split("/").some((segment) => segment === "..")) throw safePathInputError();
	if (DRIVE_PATH_PATTERN.test(value) && !path.win32.isAbsolute(value)) throw safePathInputError();
}

function guestPathFromRelative(guestWorkspace: string, relativePath: string): string {
	const normalizedRelative = relativePath.split(path.sep).join(path.posix.sep);
	if (!normalizedRelative || normalizedRelative === ".") return guestWorkspace;
	if (normalizedRelative === ".." || normalizedRelative.startsWith("../") || normalizedRelative.startsWith("/")) {
		throw safeBoundaryError();
	}
	return path.posix.join(guestWorkspace, normalizedRelative);
}

/**
 * Maps host paths into a single guest mount. The lexical check prevents
 * traversal and foreign roots; the realpath check validates existing links
 * and the nearest existing parent for new paths.
 */
export class GondolinPathMapper {
	readonly workspaceRoot: string;
	readonly guestWorkspace: string;
	private readonly hostOperations: HostPathOperations;
	private realWorkspaceRootPromise: Promise<string> | undefined;

	constructor(options: string | GondolinPathMapperOptions, hostOperations?: HostPathOperations) {
		const resolvedOptions = typeof options === "string" ? { workspaceRoot: options, hostOperations } : options;
		if (typeof resolvedOptions.workspaceRoot !== "string" || !resolvedOptions.workspaceRoot.trim()) {
			throw safePathInputError();
		}
		this.workspaceRoot = path.resolve(resolvedOptions.workspaceRoot);
		this.guestWorkspace = normalizeGuestWorkspace(resolvedOptions.guestWorkspace ?? GUEST_WORKSPACE);
		this.hostOperations = resolvedOptions.hostOperations ?? hostOperations ?? defaultHostPathOperations;
	}

	/** Resolve a relative or absolute host input lexically without touching it. */
	resolveHostPath(inputPath: string): string {
		const resolved = this.resolveHostPathUnchecked(inputPath);
		if (!isInside(this.workspaceRoot, resolved)) throw safeBoundaryError();
		return resolved;
	}

	private resolveHostPathUnchecked(inputPath: string): string {
		if (typeof inputPath !== "string") throw safePathInputError();
		const trimmed = stripAtPrefix(inputPath);
		if (!trimmed) return this.workspaceRoot;
		ensureSafeHostInput(trimmed);
		const windowsAbsolute = path.win32.isAbsolute(trimmed);
		const absolute = path.isAbsolute(trimmed) || windowsAbsolute || path.posix.isAbsolute(trimmed);
		const resolved = windowsAbsolute
			? path.win32.normalize(path.win32.resolve(trimmed))
			: absolute
				? path.normalize(path.resolve(trimmed))
				: path.resolve(this.workspaceRoot, trimmed);
		return resolved;
	}

	/** A lexical-only form useful for displaying or constructing a request. */
	toGuestPathSync(inputPath: string): string {
		return guestPathFromRelative(this.guestWorkspace, path.relative(this.workspaceRoot, this.resolveHostPath(inputPath)));
	}

	private async realWorkspaceRoot(): Promise<string> {
		if (this.realWorkspaceRootPromise !== undefined) return this.realWorkspaceRootPromise;
		this.realWorkspaceRootPromise = (async () => {
			let realRoot: string;
			try {
				realRoot = await this.hostOperations.realpath(this.workspaceRoot);
				const stat = await this.hostOperations.lstat(realRoot);
				if (!stat.isDirectory()) throw safeBoundaryError();
			} catch (error) {
				if (error instanceof GondolinAdapterError) throw error;
				throw safeBoundaryError();
			}
			return path.normalize(realRoot);
		})();
		try {
			return await this.realWorkspaceRootPromise;
		} catch (error) {
			this.realWorkspaceRootPromise = undefined;
			throw error;
		}
	}

	private async validateNearestExistingPath(
		lexicalPath: string,
		realRoot: string,
		allowMissing: boolean,
	): Promise<string> {
		let current = lexicalPath;
		while (true) {
			let stat: HostPathStat;
			try {
				stat = await this.hostOperations.lstat(current);
			} catch (error) {
				if (!isMissingPathError(error)) throw safeBoundaryError();
				const parent = path.dirname(current);
				if (parent === current) throw safeBoundaryError();
				current = parent;
				continue;
			}

			let realPath: string;
			try {
				realPath = await this.hostOperations.realpath(current);
			} catch {
				// A present symlink whose target cannot be resolved is not a safe
				// missing leaf: following it could escape on a later write.
				throw safeBoundaryError();
			}
			if (!isInside(realRoot, realPath)) throw safeBoundaryError();

			if (current !== lexicalPath) {
				const resolvedStat = stat.isSymbolicLink()
					? await this.hostOperations.lstat(realPath).catch(() => {
						throw safeBoundaryError();
					})
					: stat;
				if (!resolvedStat.isDirectory()) throw safeBoundaryError();
			}
			if (current !== lexicalPath && !allowMissing) throw safeBoundaryError();
			const suffix = current === lexicalPath ? "" : path.relative(current, lexicalPath);
			return suffix === "" ? path.normalize(realPath) : path.resolve(realPath, suffix);
		}
	}

	async toSafeHostPath(inputPath: string, options: GuestPathOptions = {}): Promise<string> {
		let lexicalPath: string;
		try {
			lexicalPath = this.resolveHostPath(inputPath);
		} catch (error) {
			const trimmed = stripAtPrefix(inputPath);
			if (!DRIVE_PATH_PATTERN.test(trimmed) || !path.win32.isAbsolute(trimmed)) throw error;
			lexicalPath = this.resolveHostPathUnchecked(inputPath);
		}
		const realRoot = await this.realWorkspaceRoot();
		return this.validateNearestExistingPath(lexicalPath, realRoot, options.allowMissing ?? true);
	}

	async toGuestPath(inputPath: string, options: GuestPathOptions = {}): Promise<string> {
		const safePath = await this.toSafeHostPath(inputPath, options);
		const realRoot = await this.realWorkspaceRoot();
		return guestPathFromRelative(this.guestWorkspace, path.relative(realRoot, safePath));
	}

	async mapHostPath(inputPath: string, options: GuestPathOptions = {}): Promise<string> {
		return this.toGuestPath(inputPath, options);
	}
}

export function createGondolinPathMapper(
	options: string | GondolinPathMapperOptions,
	hostOperations?: HostPathOperations,
): GondolinPathMapper {
	return new GondolinPathMapper(options, hostOperations);
}

export async function mapHostPathToGuest(
	mapperOrWorkspace: GondolinPathMapper | string | GondolinPathMapperOptions,
	inputPath: string,
	options?: GuestPathOptions,
): Promise<string> {
	const mapper = mapperOrWorkspace instanceof GondolinPathMapper
		? mapperOrWorkspace
		: new GondolinPathMapper(mapperOrWorkspace);
	return mapper.toGuestPath(inputPath, options);
}
