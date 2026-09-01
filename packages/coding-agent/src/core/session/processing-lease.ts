import { randomUUID } from "node:crypto";
import {
	lstatSync,
	mkdirSync,
	readFileSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

const OWNER_FILE = "owner.json";
const MAX_OWNER_BYTES = 4096;
const INVALID_OWNER_STALE_MS = 30_000;
const MAX_ACQUIRE_ATTEMPTS = 8;
const PROCESSING_ERROR =
	"Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.";

type ProcessPresence = "live" | "missing" | "ambiguous";

interface ProcessingOwner {
	schemaVersion: 1;
	pid: number;
	token: string;
	acquiredAt: number;
}

interface OwnerSnapshot {
	owner?: ProcessingOwner;
	lockModifiedAt: number;
	unsafePath: boolean;
}

export interface SessionProcessingLeaseOptions {
	pid?: number;
	now?: () => number;
	probeProcess?: (pid: number) => ProcessPresence;
	invalidOwnerStaleMs?: number;
}

export class SessionProcessingBusyError extends Error {
	constructor() {
		super(PROCESSING_ERROR);
		this.name = "SessionProcessingBusyError";
	}
}

function errorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
		? error.code
		: undefined;
}

function defaultProcessProbe(pid: number): ProcessPresence {
	try {
		process.kill(pid, 0);
		return "live";
	} catch (error) {
		const code = errorCode(error);
		if (code === "ESRCH") return "missing";
		if (code === "EPERM") return "live";
		return "ambiguous";
	}
}

function parseOwner(text: string): ProcessingOwner | undefined {
	let value: unknown;
	try {
		value = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const owner = value as Record<string, unknown>;
	if (
		Object.keys(owner).some((key) => !["schemaVersion", "pid", "token", "acquiredAt"].includes(key)) ||
		owner.schemaVersion !== 1 ||
		typeof owner.pid !== "number" ||
		!Number.isSafeInteger(owner.pid) ||
		owner.pid <= 0 ||
		typeof owner.token !== "string" ||
		owner.token.length === 0 ||
		owner.token.length > 200 ||
		typeof owner.acquiredAt !== "number" ||
		!Number.isSafeInteger(owner.acquiredAt) ||
		owner.acquiredAt < 0
	) return undefined;
	return owner as unknown as ProcessingOwner;
}

function readOwnerSnapshot(lockPath: string): OwnerSnapshot | undefined {
	try {
		const lockStat = lstatSync(lockPath);
		if (lockStat.isSymbolicLink()) {
			return { lockModifiedAt: lockStat.mtimeMs, unsafePath: true };
		}
		if (!lockStat.isDirectory()) {
			return { lockModifiedAt: lockStat.mtimeMs, unsafePath: false };
		}
		const ownerPath = join(lockPath, OWNER_FILE);
		let ownerStat: ReturnType<typeof lstatSync>;
		try {
			ownerStat = lstatSync(ownerPath);
		} catch (error) {
			if (errorCode(error) === "ENOENT") {
				return { lockModifiedAt: lockStat.mtimeMs, unsafePath: false };
			}
			throw error;
		}
		if (ownerStat.isSymbolicLink() || !ownerStat.isFile() || ownerStat.size > MAX_OWNER_BYTES) {
			return { lockModifiedAt: lockStat.mtimeMs, unsafePath: ownerStat.isSymbolicLink() };
		}
		return {
			owner: parseOwner(readFileSync(ownerPath, "utf8")),
			lockModifiedAt: lockStat.mtimeMs,
			unsafePath: false,
		};
	} catch (error) {
		if (errorCode(error) === "ENOENT") return undefined;
		throw error;
	}
}

function moveAside(lockPath: string, token: string): boolean {
	const quarantinePath = `${lockPath}.stale-${token}`;
	try {
		renameSync(lockPath, quarantinePath);
	} catch (error) {
		if (errorCode(error) === "ENOENT") return false;
		throw error;
	}
	const parent = resolve(dirname(lockPath));
	const resolvedQuarantine = resolve(quarantinePath);
	if (dirname(resolvedQuarantine) !== parent) {
		throw new Error("Session processing lease cleanup escaped the session directory");
	}
	rmSync(resolvedQuarantine, { recursive: true, force: true });
	return true;
}

export function sessionProcessingLeasePath(sessionFile: string): string {
	return `${resolve(sessionFile)}.processing`;
}

export class SessionProcessingLease {
	private readonly lockPath: string;
	private readonly owner: ProcessingOwner;
	private released = false;

	constructor(lockPath: string, owner: ProcessingOwner) {
		this.lockPath = lockPath;
		this.owner = owner;
	}

	release(): void {
		if (this.released) return;
		this.released = true;
		const snapshot = readOwnerSnapshot(this.lockPath);
		if (snapshot?.owner?.token !== this.owner.token || snapshot.owner.pid !== this.owner.pid) return;
		moveAside(this.lockPath, `release-${this.owner.token}`);
	}
}

export function acquireSessionProcessingLease(
	sessionFile: string,
	options: SessionProcessingLeaseOptions = {},
): SessionProcessingLease {
	const lockPath = sessionProcessingLeasePath(sessionFile);
	const pid = options.pid ?? process.pid;
	const now = options.now ?? Date.now;
	const probeProcess = options.probeProcess ?? defaultProcessProbe;
	const invalidOwnerStaleMs = options.invalidOwnerStaleMs ?? INVALID_OWNER_STALE_MS;
	if (!Number.isSafeInteger(pid) || pid <= 0) throw new TypeError("Session processing lease PID must be a positive integer");
	if (!Number.isFinite(invalidOwnerStaleMs) || invalidOwnerStaleMs < 0) {
		throw new TypeError("Session processing invalid-owner timeout must be finite and non-negative");
	}
	mkdirSync(dirname(lockPath), { recursive: true });
	for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt += 1) {
		const owner: ProcessingOwner = {
			schemaVersion: 1,
			pid,
			token: randomUUID(),
			acquiredAt: now(),
		};
		try {
			mkdirSync(lockPath);
			try {
				writeFileSync(join(lockPath, OWNER_FILE), `${JSON.stringify(owner)}\n`, { encoding: "utf8", flag: "wx" });
			} catch (error) {
				rmSync(lockPath, { recursive: true, force: true });
				throw error;
			}
			return new SessionProcessingLease(lockPath, owner);
		} catch (error) {
			if (errorCode(error) !== "EEXIST") throw error;
		}

		const snapshot = readOwnerSnapshot(lockPath);
		if (snapshot === undefined) continue;
		const stale = snapshot.unsafePath
			? false
			: snapshot.owner === undefined
				? now() - snapshot.lockModifiedAt >= invalidOwnerStaleMs
				: probeProcess(snapshot.owner.pid) === "missing";
		if (!stale) throw new SessionProcessingBusyError();
		if (!moveAside(lockPath, owner.token)) continue;
	}
	throw new SessionProcessingBusyError();
}
