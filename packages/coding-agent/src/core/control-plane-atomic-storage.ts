import { randomBytes } from "node:crypto";
import {
	chmodSync,
	closeSync,
	constants,
	existsSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	readdirSync,
	renameSync,
	rmSync,
	writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

export type ControlPlaneStorageErrorCode = "control_state_corrupt" | "control_state_write_failed";
export type ControlPlaneStorageOperation = "write" | "fsync" | "rename" | "permission";
export type ControlPlaneStorageTarget = "current" | "last-known-good" | "repair";

export interface ControlPlaneStorageFaultContext {
	operation: ControlPlaneStorageOperation;
	target: ControlPlaneStorageTarget;
	targetPath: string;
	tempPath: string;
}

export interface ControlPlaneStorageOptions {
	validate: (content: string) => void;
	mode?: number;
	directoryMode?: number;
	faultInjector?: (context: ControlPlaneStorageFaultContext) => void;
}

export class ControlPlaneStorageError extends Error {
	readonly code: ControlPlaneStorageErrorCode;

	constructor(code: ControlPlaneStorageErrorCode, cause?: unknown) {
		super(code === "control_state_corrupt" ? "Control-plane state is corrupt" : "Failed to write control-plane state", {
			cause,
		});
		this.name = "ControlPlaneStorageError";
		this.code = code;
	}
}

export function getControlPlaneLastKnownGoodPath(path: string): string {
	return `${path}.lkg`;
}

function quarantinePrefix(path: string): string {
	return `.${basename(path)}.corrupt.`;
}

function hasQuarantine(path: string): boolean {
	const dir = dirname(path);
	try {
		const prefixes = [quarantinePrefix(path), quarantinePrefix(getControlPlaneLastKnownGoodPath(path))];
		return readdirSync(dir).some((entry) => prefixes.some((prefix) => entry.startsWith(prefix)));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

export function hasControlPlaneStateArtifacts(path: string): boolean {
	return existsSync(path) || existsSync(getControlPlaneLastKnownGoodPath(path)) || hasQuarantine(path);
}

function syncDirectoryBestEffort(path: string): void {
	let descriptor: number | undefined;
	try {
		descriptor = openSync(path, constants.O_RDONLY);
		fsyncSync(descriptor);
	} catch {
		// Directory fsync is unavailable on some supported filesystems and platforms.
	} finally {
		if (descriptor !== undefined) {
			try {
				closeSync(descriptor);
			} catch {
				// Best effort only.
			}
		}
	}
}

function verifyFile(path: string, content: string, options: ControlPlaneStorageOptions): void {
	const stat = lstatSync(path);
	if (!stat.isFile() || stat.isSymbolicLink()) {
		throw new Error("Control-plane state must be a regular file");
	}
	options.validate(content);
	if (options.mode !== undefined && process.platform !== "win32" && (stat.mode & 0o777) !== options.mode) {
		throw new Error("Control-plane state permissions are invalid");
	}
}

function readAndVerify(path: string, options: ControlPlaneStorageOptions): string | undefined {
	try {
		const stat = lstatSync(path);
		if (!stat.isFile() || stat.isSymbolicLink()) {
			throw new Error("Control-plane state must be a regular file");
		}
		const content = readFileSync(path, "utf-8");
		options.validate(content);
		if (options.mode !== undefined && process.platform !== "win32" && (stat.mode & 0o777) !== options.mode) {
			chmodSync(path, options.mode);
			if ((lstatSync(path).mode & 0o777) !== options.mode) {
				throw new Error("Control-plane state permissions are invalid");
			}
		}
		return content;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

function regularFileMode(path: string): number | undefined {
	if (process.platform === "win32") return undefined;
	try {
		const stat = lstatSync(path);
		return stat.isFile() && !stat.isSymbolicLink() ? stat.mode & 0o777 : undefined;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}

function inheritMode(options: ControlPlaneStorageOptions, sourcePath: string): ControlPlaneStorageOptions {
	if (options.mode !== undefined) return options;
	const mode = regularFileMode(sourcePath);
	return mode === undefined ? options : { ...options, mode };
}

function publishSingle(
	path: string,
	content: string,
	options: ControlPlaneStorageOptions,
	target: ControlPlaneStorageTarget,
): void {
	const dir = dirname(path);
	mkdirSync(dir, { recursive: true, ...(options.directoryMode === undefined ? {} : { mode: options.directoryMode }) });
	const tempPath = join(dir, `.${basename(path)}.${randomBytes(16).toString("hex")}.tmp`);
	const inheritedMode = options.mode === undefined ? regularFileMode(path) : undefined;
	const publishMode = options.mode ?? inheritedMode;
	const verificationOptions = publishMode === undefined ? options : { ...options, mode: publishMode };
	let descriptor: number | undefined;
	try {
		descriptor = openSync(tempPath, "wx", publishMode ?? 0o666);
		const context = { target, targetPath: path, tempPath };
		options.faultInjector?.({ ...context, operation: "write" });
		const bytes = Buffer.from(content, "utf-8");
		let offset = 0;
		while (offset < bytes.length) {
			const written = writeSync(descriptor, bytes, offset, bytes.length - offset);
			if (written === 0) throw new Error("Control-plane state write made no progress");
			offset += written;
		}
		options.faultInjector?.({ ...context, operation: "permission" });
		if (publishMode !== undefined) chmodSync(tempPath, publishMode);
		options.faultInjector?.({ ...context, operation: "fsync" });
		fsyncSync(descriptor);
		closeSync(descriptor);
		descriptor = undefined;
		verifyFile(tempPath, readFileSync(tempPath, "utf-8"), verificationOptions);
		options.faultInjector?.({ ...context, operation: "rename" });
		renameSync(tempPath, path);
		syncDirectoryBestEffort(dir);
		verifyFile(path, readFileSync(path, "utf-8"), verificationOptions);
	} finally {
		if (descriptor !== undefined) {
			try {
				closeSync(descriptor);
			} catch {
				// Preserve the original write failure.
			}
		}
		rmSync(tempPath, { force: true });
	}
}

function publishOrThrow(
	path: string,
	content: string,
	options: ControlPlaneStorageOptions,
	target: ControlPlaneStorageTarget,
): void {
	try {
		publishSingle(path, content, options, target);
	} catch (error) {
		if (error instanceof ControlPlaneStorageError) throw error;
		throw new ControlPlaneStorageError("control_state_write_failed", error);
	}
}

function quarantine(path: string, options: ControlPlaneStorageOptions): void {
	const quarantinePath = join(dirname(path), `${quarantinePrefix(path)}${randomBytes(16).toString("hex")}`);
	renameSync(path, quarantinePath);
	const stat = lstatSync(quarantinePath);
	if (options.mode !== undefined && stat.isFile() && !stat.isSymbolicLink()) {
		chmodSync(quarantinePath, options.mode);
	}
	syncDirectoryBestEffort(dirname(path));
}

export function readControlPlaneState(path: string, options: ControlPlaneStorageOptions): string | undefined {
	let current: string | undefined;
	let currentInvalid = false;
	try {
		current = readAndVerify(path, options);
	} catch {
		currentInvalid = true;
		try {
			quarantine(path, options);
		} catch (error) {
			throw new ControlPlaneStorageError("control_state_corrupt", error);
		}
	}

	const lastKnownGoodPath = getControlPlaneLastKnownGoodPath(path);
	if (current !== undefined) {
		let lastKnownGood: string | undefined;
		try {
			lastKnownGood = readAndVerify(lastKnownGoodPath, options);
		} catch {
			try {
				quarantine(lastKnownGoodPath, options);
			} catch (error) {
				throw new ControlPlaneStorageError("control_state_corrupt", error);
			}
		}
		if (lastKnownGood !== current) {
			publishOrThrow(lastKnownGoodPath, current, inheritMode(options, path), "last-known-good");
		}
		return current;
	}

	let lastKnownGood: string | undefined;
	try {
		lastKnownGood = readAndVerify(lastKnownGoodPath, options);
	} catch {
		try {
			quarantine(lastKnownGoodPath, options);
		} catch (error) {
			throw new ControlPlaneStorageError("control_state_corrupt", error);
		}
		throw new ControlPlaneStorageError("control_state_corrupt");
	}

	if (lastKnownGood !== undefined) {
		publishOrThrow(path, lastKnownGood, inheritMode(options, lastKnownGoodPath), "repair");
		return lastKnownGood;
	}
	if (currentInvalid || hasQuarantine(path)) {
		throw new ControlPlaneStorageError("control_state_corrupt");
	}
	return undefined;
}

export function writeControlPlaneState(path: string, content: string, options: ControlPlaneStorageOptions): void {
	try {
		options.validate(content);
	} catch (error) {
		throw new ControlPlaneStorageError("control_state_write_failed", error);
	}
	publishOrThrow(path, content, options, "current");
	publishOrThrow(
		getControlPlaneLastKnownGoodPath(path),
		content,
		inheritMode(options, path),
		"last-known-good",
	);
}
