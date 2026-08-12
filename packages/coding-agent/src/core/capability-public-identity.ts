import { createHmac, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import { resolvePath } from "../utils/paths.ts";

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
/** Bump when the HMAC derivation scheme changes; old public IDs then change. */
const DERIVATION_VERSION = 1;
/** Single byte between the domain and the input in the HMAC message. */
const DERIVATION_DOMAIN_SEPARATOR = 0;
const STATE_FILE_WRITE_OPTIONS = { encoding: "utf-8", mode: 0o600 } as const;
const LOCK_RETRIES = { retries: 20, factor: 1.2, minTimeout: 10, maxTimeout: 100 };

interface CapabilityPublicIdentityStateFile {
	version: number;
	secret: string;
}

export function getCapabilityPublicIdentityPath(agentDir: string): string {
	return join(resolvePath(agentDir), STATE_FILE_NAME);
}

function readStateFile(statePath: string): CapabilityPublicIdentityStateFile {
	let raw: string;
	try {
		raw = readFileSync(statePath, "utf-8");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to read capability identity state ${statePath}: ${message}`);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Invalid capability identity state ${statePath}: ${message}`);
	}

	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(`Invalid capability identity state ${statePath}: expected an object`);
	}
	const version = (parsed as Record<string, unknown>).version;
	if (version !== STATE_FILE_VERSION) {
		throw new Error(`Unsupported capability identity state version ${JSON.stringify(version)} at ${statePath}`);
	}
	const secret = (parsed as Record<string, unknown>).secret;
	if (typeof secret !== "string") {
		throw new Error(`Invalid capability identity state ${statePath}: secret must be a string`);
	}
	// Do not echo the stored secret value here; length is the only safe signal.
	if (Buffer.from(secret, "base64url").length !== SECRET_BYTE_LENGTH) {
		throw new Error(
			`Invalid capability identity state ${statePath}: secret must decode to ${SECRET_BYTE_LENGTH} bytes`,
		);
	}
	return { version: STATE_FILE_VERSION, secret };
}

function writeStateFile(statePath: string, secret: Buffer): void {
	mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 });
	const data = `${JSON.stringify({ version: STATE_FILE_VERSION, secret: secret.toString("base64url") }, null, 2)}\n`;
	writeFileSync(statePath, data, STATE_FILE_WRITE_OPTIONS);
	chmodSync(statePath, 0o600);
}

async function acquireStateLock(statePath: string): Promise<() => Promise<void>> {
	mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 });
	try {
		return await lockfile.lock(statePath, { realpath: false, retries: LOCK_RETRIES });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to lock capability identity state ${statePath}: ${message}`);
	}
}

export class CapabilityPublicIdentity {
	readonly agentDir: string;
	private readonly secret: Buffer;

	private constructor(agentDir: string, secret: Buffer) {
		this.agentDir = agentDir;
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
			if (existsSync(statePath)) {
				const state = readStateFile(statePath);
				return new CapabilityPublicIdentity(resolvePath(agentDir), Buffer.from(state.secret, "base64url"));
			}
			const secret = randomBytes(SECRET_BYTE_LENGTH);
			writeStateFile(statePath, secret);
			return new CapabilityPublicIdentity(resolvePath(agentDir), secret);
		} finally {
			await release();
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
