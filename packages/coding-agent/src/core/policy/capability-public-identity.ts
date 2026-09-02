import { createHmac, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import { resolvePath } from "../../utils/paths.ts";
import { readControlPlaneState, writeControlPlaneState } from "../control-plane-atomic-storage.ts";

/**
 * Installation-scoped public identity for capabilities.
 *
 * The capability registry must expose stable, opaque public IDs without
 * leaking the raw source identity (local paths, URL userinfo/query/fragment).
 * This primitive owns the per-install secret that such IDs are derived from:
 * a 32-byte random secret persisted only in a versioned private state file
 * under the caller-supplied agentDir. Only the secret is stored there; raw
 * source identities and mappings are never persisted, and the secret never
 * appears in derived output or in errors.
 */

const STATE_FILE_NAME = "capability-public-identity.json";
const STATE_FILE_VERSION = 1;
const SECRET_BYTE_LENGTH = 32;
const SECRET_BASE64URL_PATTERN = /^[A-Za-z0-9_-]{43}$/;
/** Bump when the HMAC derivation scheme changes; old public IDs then change. */
const DERIVATION_VERSION = 1;
/** Single byte between the domain and the input in the HMAC message. */
const DERIVATION_DOMAIN_SEPARATOR = 0;
const LOCK_RETRIES = { retries: 20, factor: 1.2, minTimeout: 10, maxTimeout: 100 };

interface CapabilityPublicIdentityStateFile {
	version: number;
	secret: string;
}

export function getCapabilityPublicIdentityPath(agentDir: string): string {
	return join(resolvePath(agentDir), STATE_FILE_NAME);
}

function decodeCanonicalSecret(secret: string): Buffer | undefined {
	if (!SECRET_BASE64URL_PATTERN.test(secret)) return undefined;
	const decoded = Buffer.from(secret, "base64url");
	if (decoded.length !== SECRET_BYTE_LENGTH || decoded.toString("base64url") !== secret) return undefined;
	return decoded;
}

function parseStateFile(raw: string): CapabilityPublicIdentityStateFile {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error("Invalid capability identity state");
	}

	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error("Invalid capability identity state");
	}
	const version = (parsed as Record<string, unknown>).version;
	if (version !== STATE_FILE_VERSION) {
		throw new Error("Unsupported capability identity state version");
	}
	const secret = (parsed as Record<string, unknown>).secret;
	if (typeof secret !== "string" || decodeCanonicalSecret(secret) === undefined) {
		throw new Error("Invalid capability identity state");
	}
	return { version: STATE_FILE_VERSION, secret };
}

const IDENTITY_STORAGE_OPTIONS = {
	validate: (content: string) => {
		parseStateFile(content);
	},
	mode: 0o600,
	directoryMode: 0o700,
} as const;

function readStateFile(statePath: string): CapabilityPublicIdentityStateFile | undefined {
	const raw = readControlPlaneState(statePath, IDENTITY_STORAGE_OPTIONS);
	return raw === undefined ? undefined : parseStateFile(raw);
}

function writeStateFile(statePath: string, secret: Buffer): void {
	mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 });
	const data = `${JSON.stringify({ version: STATE_FILE_VERSION, secret: secret.toString("base64url") }, null, 2)}\n`;
	writeControlPlaneState(statePath, data, IDENTITY_STORAGE_OPTIONS);
}

async function acquireStateLock(statePath: string): Promise<() => Promise<void>> {
	mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 });
	try {
		return await lockfile.lock(statePath, { realpath: false, retries: LOCK_RETRIES });
	} catch {
		throw new Error("Failed to lock capability identity state");
	}
}

function acquireStateLockSync(statePath: string): () => void {
	mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 });
	for (let attempt = 1; attempt <= 50; attempt++) {
		try {
			return lockfile.lockSync(statePath, { realpath: false, stale: 30_000 });
		} catch (error) {
			const code =
				typeof error === "object" && error !== null && "code" in error
					? String((error as { code?: unknown }).code)
					: undefined;
			if (code !== "ELOCKED" || attempt === 50) {
				throw new Error("Failed to lock capability identity state");
			}
			const waitUntil = Date.now() + Math.min(10 * attempt, 100);
			while (Date.now() < waitUntil) {
				// The synchronous Registry construction path cannot await the async lock.
			}
		}
	}
	throw new Error("Failed to lock capability identity state");
}

export class CapabilityPublicIdentity {
	private readonly secret: Buffer;

	private constructor(secret: Buffer) {
		this.secret = secret;
	}

	/**
	 * Load the installation identity for {@link agentDir}, creating and
	 * persisting a fresh random secret on first use. Locked so concurrent
	 * initializers converge on the same persisted secret instead of racing.
	 */
	static async load(agentDir: string): Promise<CapabilityPublicIdentity> {
		const statePath = getCapabilityPublicIdentityPath(agentDir);
		const release = await acquireStateLock(statePath);
		try {
			const state = readStateFile(statePath);
			if (state !== undefined) {
				return new CapabilityPublicIdentity(Buffer.from(state.secret, "base64url"));
			}
			const secret = randomBytes(SECRET_BYTE_LENGTH);
			writeStateFile(statePath, secret);
			return new CapabilityPublicIdentity(secret);
		} finally {
			await release();
		}
	}

	/**
	 * Synchronous counterpart for synchronous Registry construction paths.
	 * It uses the same state file and lock as {@link load}, so the identity is
	 * stable when synchronous and asynchronous callers share an agentDir.
	 */
	static loadSync(agentDir: string): CapabilityPublicIdentity {
		const statePath = getCapabilityPublicIdentityPath(agentDir);
		const release = acquireStateLockSync(statePath);
		try {
			const state = readStateFile(statePath);
			if (state !== undefined) {
				return new CapabilityPublicIdentity(Buffer.from(state.secret, "base64url"));
			}
			const secret = randomBytes(SECRET_BYTE_LENGTH);
			writeStateFile(statePath, secret);
			return new CapabilityPublicIdentity(secret);
		} finally {
			release();
		}
	}

	/**
	 * Derive a fixed-width (43-char base64url) opaque value for a
	 * caller-supplied {@link domain} and canonical string input. Distinct
	 * domains always produce distinct outputs for the same input. NUL bytes
	 * are rejected so the `domain\0input` message cannot alias across
	 * (domain, input) pairs.
	 */
	derive(domain: string, input: string): string {
		if (domain.includes("\0") || input.includes("\0")) {
			throw new Error("CapabilityPublicIdentity derive input must not contain NUL bytes");
		}
		const message = Buffer.concat([
			Buffer.from([DERIVATION_VERSION]),
			Buffer.from(domain, "utf-8"),
			Buffer.from([DERIVATION_DOMAIN_SEPARATOR]),
			Buffer.from(input, "utf-8"),
		]);
		return createHmac("sha256", this.secret).update(message).digest("base64url");
	}
}
