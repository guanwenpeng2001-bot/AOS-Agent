import { existsSync, lstatSync, realpathSync, statSync } from "node:fs";
import lockfile from "proper-lockfile";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { resolvePath } from "../utils/paths.ts";

/** The lock is intentionally short-lived: one complete JSONL mutation. */
export const DEFAULT_SESSION_WRITE_LOCK_TIMEOUT_MS = 2_000;
/** proper-lockfile requires a stale threshold of at least two seconds. */
export const DEFAULT_SESSION_WRITE_LOCK_STALE_MS = 30_000;
export const DEFAULT_SESSION_WRITE_LOCK_RETRY_DELAY_MS = 20;

const MIN_STALE_LOCK_MS = 2_000;
const MAX_LOCK_TIMEOUT_MS = 60_000;
const MAX_RETRY_DELAY_MS = 1_000;

export type SessionWriteCoordinationErrorCode =
	| "session_write_path_invalid"
	| "session_write_lock_timeout"
	| "session_write_lock_failed"
	| "session_write_lock_compromised"
	| "session_write_lock_release_failed";

/** A stable failure category for a refused or unsafe persisted session write. */
export class SessionWriteCoordinationError extends Error {
	readonly code: SessionWriteCoordinationErrorCode;
	readonly sessionFile: string;

	constructor(code: SessionWriteCoordinationErrorCode, sessionFile: string, message: string) {
		super(message);
		this.name = "SessionWriteCoordinationError";
		this.code = code;
		this.sessionFile = sessionFile;
	}
}

export interface SessionWriteCoordinatorOptions {
	lockTimeoutMs?: number;
	staleLockMs?: number;
	retryDelayMs?: number;
}

function isPathWithinRoot(root: string, target: string): boolean {
	const relation = relative(root, target);
	return relation === "" || (!isAbsolute(relation) && relation !== ".." && !relation.startsWith(`..${sep}`));
}

function isLockHeld(error: unknown): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"code" in error &&
		String((error as { code?: unknown }).code) === "ELOCKED"
	);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function boundedDuration(value: number | undefined, fallback: number, max: number): number {
	if (value === undefined) return fallback;
	if (!Number.isFinite(value) || value < 0) {
		throw new Error("Session write lock durations must be finite and non-negative");
	}
	return Math.min(Math.floor(value), max);
}

function canonicalRoot(sessionRoot: string, sessionFile: string): string {
	const resolvedRoot = resolvePath(sessionRoot);
	try {
		const rootStat = statSync(resolvedRoot);
		if (!rootStat.isDirectory()) throw new Error("root is not a directory");
		return realpathSync(resolvedRoot);
	} catch (error) {
		throw new SessionWriteCoordinationError(
			"session_write_path_invalid",
			sessionFile,
			`Session write root is unavailable: ${errorMessage(error)}`,
		);
	}
}

function validateSessionPath(sessionFile: string, sessionRoot: string): { file: string; lockFile: string } {
	const file = resolvePath(sessionFile);
	const root = canonicalRoot(sessionRoot, file);
	const parent = dirname(file);
	let realParent: string;
	try {
		realParent = realpathSync(parent);
	} catch (error) {
		throw new SessionWriteCoordinationError(
			"session_write_path_invalid",
			file,
			`Session write parent is unavailable: ${errorMessage(error)}`,
		);
	}

	if (!isPathWithinRoot(root, realParent)) {
		throw new SessionWriteCoordinationError(
			"session_write_path_invalid",
			file,
			"Session write path is outside the configured session root",
		);
	}

	let canonicalFile = resolve(realParent, basename(file));
	let fileExists = false;
	try {
		const fileStat = lstatSync(file);
		fileExists = true;
		if (fileStat.isSymbolicLink()) {
			canonicalFile = realpathSync(file);
		} else if (!fileStat.isFile()) {
			throw new Error("session path is not a regular file");
		}
	} catch (error) {
		if (fileExists || existsSync(file)) {
			throw new SessionWriteCoordinationError(
				"session_write_path_invalid",
				file,
				`Session write target is unsafe: ${errorMessage(error)}`,
			);
		}
	}

	if (!isPathWithinRoot(root, canonicalFile)) {
		throw new SessionWriteCoordinationError(
			"session_write_path_invalid",
			file,
			"Session write target is outside the configured session root",
		);
	}

	const lockFile = `${canonicalFile}.lock`;
	let lockExists = false;
	try {
		const lockStat = lstatSync(lockFile);
		lockExists = true;
		if (lockStat.isSymbolicLink()) {
			throw new Error("lock path is a symbolic link");
		}
	} catch (error) {
		if (lockExists || existsSync(lockFile)) {
			throw new SessionWriteCoordinationError(
				"session_write_path_invalid",
				file,
				`Session write lock path is unsafe: ${errorMessage(error)}`,
			);
		}
	}

	return { file, lockFile };
}

interface SessionWriteLease {
	release: () => void;
	compromised: () => Error | undefined;
}

/**
 * Coordinates synchronous SessionManager mutations across processes.
 *
 * The lock is acquired only around a persisted mutation. Reads, SessionManager
 * construction, and audit/replay therefore never require or take this lock.
 */
export class SessionWriteCoordinator {
	private readonly file: string;
	private readonly lockFile: string;
	private readonly lockTimeoutMs: number;
	private readonly staleLockMs: number;
	private readonly retryDelayMs: number;

	constructor(sessionFile: string, sessionRoot: string, options: SessionWriteCoordinatorOptions = {}) {
		const paths = validateSessionPath(sessionFile, sessionRoot);
		this.file = paths.file;
		this.lockFile = paths.lockFile;
		this.lockTimeoutMs = boundedDuration(
			options.lockTimeoutMs,
			DEFAULT_SESSION_WRITE_LOCK_TIMEOUT_MS,
			MAX_LOCK_TIMEOUT_MS,
		);
		this.staleLockMs = Math.max(
			MIN_STALE_LOCK_MS,
			boundedDuration(options.staleLockMs, DEFAULT_SESSION_WRITE_LOCK_STALE_MS, MAX_LOCK_TIMEOUT_MS),
		);
		this.retryDelayMs = Math.max(
			1,
			boundedDuration(options.retryDelayMs, DEFAULT_SESSION_WRITE_LOCK_RETRY_DELAY_MS, MAX_RETRY_DELAY_MS),
		);
	}

	getSessionFile(): string {
		return this.file;
	}

	getLockFile(): string {
		return this.lockFile;
	}

	private acquire(): SessionWriteLease {
		const deadline = Date.now() + this.lockTimeoutMs;
		while (true) {
			let compromisedError: Error | undefined;
			try {
				const release = lockfile.lockSync(this.file, {
					lockfilePath: this.lockFile,
					realpath: false,
					retries: 0,
					stale: this.staleLockMs,
					onCompromised: (error) => {
						compromisedError = error;
					},
				});
				return { release, compromised: () => compromisedError };
			} catch (error) {
				if (!isLockHeld(error)) {
					throw new SessionWriteCoordinationError(
						"session_write_lock_failed",
						this.file,
						`Session write lock failed: ${errorMessage(error)}`,
					);
				}
				if (Date.now() >= deadline) {
					throw new SessionWriteCoordinationError(
						"session_write_lock_timeout",
						this.file,
						"Timed out waiting for the session write lock",
					);
				}
				const waitMs = Math.min(this.retryDelayMs, Math.max(1, deadline - Date.now()));
				const waitUntil = Date.now() + waitMs;
				while (Date.now() < waitUntil) {
					// Synchronous SessionManager APIs cannot await without changing their contract.
				}
			}
		}
	}

	/** Run one complete persisted mutation while holding the cross-process lock. */
	withWriteLock<T>(operation: () => T): T {
		const lease = this.acquire();
		let result!: T;
		let operationError: { value: unknown } | undefined;
		try {
			const compromisedBeforeWrite = lease.compromised();
			if (compromisedBeforeWrite) {
				throw new SessionWriteCoordinationError(
					"session_write_lock_compromised",
					this.file,
					`Session write lock was compromised: ${errorMessage(compromisedBeforeWrite)}`,
				);
			}
			result = operation();
			const compromisedError = lease.compromised();
			if (compromisedError) {
				throw new SessionWriteCoordinationError(
					"session_write_lock_compromised",
					this.file,
					`Session write lock was compromised: ${errorMessage(compromisedError)}`,
				);
			}
		} catch (error) {
			operationError = { value: error };
		}

		let releaseError: unknown;
		try {
			lease.release();
		} catch (error) {
			releaseError = error;
		}

		if (operationError) {
			throw operationError.value;
		}
		if (releaseError !== undefined) {
			throw new SessionWriteCoordinationError(
				"session_write_lock_release_failed",
				this.file,
				`Session write lock release failed: ${errorMessage(releaseError)}`,
			);
		}
		return result;
	}
}
