import { createHmac, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CapabilityPublicIdentity, getCapabilityPublicIdentityPath } from "../src/core/capability-public-identity.ts";

const PATH_MARKER_WIN = "C:\\audit-private\\capability-source";
const PATH_MARKER_POSIX = "/audit-private/capability-source";
const URL_MARKER = "https://audit-user:audit-secret@host.invalid/pkg?token=audit-query-secret#audit-fragment";

/** White-box derivation scheme the primitive is expected to implement. */
function expectedDerivation(secret: Buffer, domain: string, input: string): string {
	const message = Buffer.concat([
		Buffer.from([1]),
		Buffer.from(domain, "utf-8"),
		Buffer.from([0]),
		Buffer.from(input, "utf-8"),
	]);
	return createHmac("sha256", secret).update(message).digest("base64url");
}

async function loadError(agentDir: string): Promise<Error> {
	try {
		await CapabilityPublicIdentity.load(agentDir);
	} catch (error) {
		return error instanceof Error ? error : new Error(String(error));
	}
	throw new Error("expected CapabilityPublicIdentity.load to reject");
}

describe("CapabilityPublicIdentity", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `capability-public-identity-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	it("derives identical values across two loads of the same agentDir", async () => {
		const agentDir = join(tempDir, "agent");
		const identity = await CapabilityPublicIdentity.load(agentDir);
		const again = await CapabilityPublicIdentity.load(agentDir);

		expect(identity.derive("publicSourceId", PATH_MARKER_WIN)).toBe(again.derive("publicSourceId", PATH_MARKER_WIN));
		expect(identity.derive("revision", URL_MARKER)).toBe(again.derive("revision", URL_MARKER));
		expect(existsSync(getCapabilityPublicIdentityPath(agentDir))).toBe(true);
	});

	it("derives distinct values across independent agentDirs", async () => {
		const first = await CapabilityPublicIdentity.load(join(tempDir, "agent-a"));
		const second = await CapabilityPublicIdentity.load(join(tempDir, "agent-b"));

		expect(first.derive("publicSourceId", PATH_MARKER_POSIX)).not.toBe(
			second.derive("publicSourceId", PATH_MARKER_POSIX),
		);
	});

	it("shares the persisted identity with synchronous Registry construction paths", async () => {
		const agentDir = join(tempDir, "agent");
		const asynchronous = await CapabilityPublicIdentity.load(agentDir);
		const synchronous = CapabilityPublicIdentity.loadSync(agentDir);

		expect(synchronous.derive("publicSourceId", PATH_MARKER_WIN)).toBe(
			asynchronous.derive("publicSourceId", PATH_MARKER_WIN),
		);
	});

	it("keeps domains separated and produces fixed-width opaque values", async () => {
		const identity = await CapabilityPublicIdentity.load(join(tempDir, "agent"));
		const input = PATH_MARKER_WIN;

		const publicSourceId = identity.derive("publicSourceId", input);
		const revision = identity.derive("revision", input);
		expect(revision).not.toBe(publicSourceId);
		expect(identity.derive("publicSourceId", input)).toBe(publicSourceId);
		expect(identity.derive("publicSourceId", `${input}-other`)).not.toBe(publicSourceId);

		for (const value of [publicSourceId, revision]) {
			expect(value).toMatch(/^[A-Za-z0-9_-]{43}$/);
		}
	});

	it("rejects NUL bytes so domain and input cannot alias", async () => {
		const identity = await CapabilityPublicIdentity.load(join(tempDir, "agent"));
		expect(() => identity.derive("publicSourceId", "a\0b")).toThrow(/NUL/);
		expect(() => identity.derive("a\0b", "input")).toThrow(/NUL/);
	});

	it("never writes raw source identities into the state file", async () => {
		const agentDir = join(tempDir, "agent");
		const identity = await CapabilityPublicIdentity.load(agentDir);

		for (const marker of [PATH_MARKER_WIN, PATH_MARKER_POSIX, URL_MARKER]) {
			identity.derive("publicSourceId", marker);
			identity.derive("revision", marker);
		}

		const content = readFileSync(getCapabilityPublicIdentityPath(agentDir), "utf-8");
		for (const marker of [PATH_MARKER_WIN, PATH_MARKER_POSIX, URL_MARKER]) {
			expect(content).not.toContain(marker);
		}
		for (const fragment of [
			"audit-user",
			"audit-secret",
			"audit-query-secret",
			"audit-fragment",
			"capability-source",
		]) {
			expect(content).not.toContain(fragment);
		}

		const parsed = JSON.parse(content) as { version?: unknown; secret?: unknown };
		expect(parsed.version).toBe(1);
		expect(typeof parsed.secret).toBe("string");
		expect(Buffer.from(parsed.secret as string, "base64url")).toHaveLength(32);
	});

	it("honors an existing valid state file instead of regenerating the secret", async () => {
		const agentDir = join(tempDir, "agent");
		const statePath = getCapabilityPublicIdentityPath(agentDir);
		const secret = randomBytes(32);
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(statePath, JSON.stringify({ version: 1, secret: secret.toString("base64url") }), "utf8");

		const identity = await CapabilityPublicIdentity.load(agentDir);
		expect(identity.derive("publicSourceId", PATH_MARKER_WIN)).toBe(
			expectedDerivation(secret, "publicSourceId", PATH_MARKER_WIN),
		);

		const again = await CapabilityPublicIdentity.load(agentDir);
		expect(again.derive("publicSourceId", PATH_MARKER_WIN)).toBe(
			expectedDerivation(secret, "publicSourceId", PATH_MARKER_WIN),
		);
	});

	it("quarantines malformed or noncanonical state without minting a new identity or leaking private file details", async () => {
		const privatePathMarker = "capability-identity-private-path";
		const agentDir = join(tempDir, privatePathMarker, "agent");
		const statePath = getCapabilityPublicIdentityPath(agentDir);
		mkdirSync(agentDir, { recursive: true });

		writeFileSync(statePath, "{invalid-json", "utf8");
		const malformedJsonError = await loadError(agentDir);
		expect(malformedJsonError).toMatchObject({ code: "control_state_corrupt" });
		expect(malformedJsonError.message).not.toContain(privatePathMarker);
		expect(malformedJsonError.message).not.toContain(statePath);
		expect(existsSync(statePath)).toBe(false);

		const shortSecret = "c2hvcnQ";
		writeFileSync(statePath, JSON.stringify({ version: 1, secret: shortSecret }), "utf8");
		const shortError = await loadError(agentDir);
		expect(shortError).toMatchObject({ code: "control_state_corrupt" });
		expect(shortError.message).not.toContain(shortSecret);
		expect(shortError.message).not.toContain(privatePathMarker);
		expect(shortError.message).not.toContain(statePath);
		expect(existsSync(statePath)).toBe(false);

		const canonicalSecret = randomBytes(32).toString("base64url");
		writeFileSync(statePath, JSON.stringify({ version: 1, secret: `${canonicalSecret}=` }), "utf8");
		const nonCanonicalError = await loadError(agentDir);
		expect(nonCanonicalError).toMatchObject({ code: "control_state_corrupt" });
		expect(nonCanonicalError.message).not.toContain(canonicalSecret);
		expect(existsSync(statePath)).toBe(false);

		writeFileSync(statePath, JSON.stringify({ version: 2, secret: canonicalSecret }), "utf8");
		const versionError = await loadError(agentDir);
		expect(versionError).toMatchObject({ code: "control_state_corrupt" });
		expect(versionError.message).not.toContain(privatePathMarker);
		expect(versionError.message).not.toContain(statePath);
		expect(existsSync(statePath)).toBe(false);
		expect(readdirSync(agentDir).filter((entry) => entry.includes(".corrupt."))).toHaveLength(4);
	});

	it("serializes concurrent initialization onto a single secret", async () => {
		const agentDir = join(tempDir, "agent");
		const identities = await Promise.all(Array.from({ length: 8 }, () => CapabilityPublicIdentity.load(agentDir)));

		const outputs = identities.map((identity) => identity.derive("publicSourceId", PATH_MARKER_POSIX));
		expect(new Set(outputs).size).toBe(1);

		const parsed = JSON.parse(readFileSync(getCapabilityPublicIdentityPath(agentDir), "utf-8")) as {
			secret?: unknown;
		};
		expect(Buffer.from(parsed.secret as string, "base64url")).toHaveLength(32);
		expect(outputs[0]).toBe(
			expectedDerivation(Buffer.from(parsed.secret as string, "base64url"), "publicSourceId", PATH_MARKER_POSIX),
		);
	});

	it("writes the state file with owner-only permissions where supported", async () => {
		const agentDir = join(tempDir, "agent");
		await CapabilityPublicIdentity.load(agentDir);
		const statePath = getCapabilityPublicIdentityPath(agentDir);
		expect(existsSync(statePath)).toBe(true);
		if (process.platform !== "win32") {
			expect(statSync(statePath).mode & 0o777).toBe(0o600);
		}
	});
});
