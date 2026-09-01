import { createHash } from "node:crypto";
import { canonicalFoundationJson } from "@aos-agent/agent-core";
import type { SessionEntry } from "./manager.ts";

export const AUDIT_INTEGRITY_SCHEMA_VERSION = 1 as const;
export const AUDIT_INTEGRITY_ALGORITHM = "sha256" as const;

export interface SessionAuditSeal {
	readonly schemaVersion: 1;
	readonly algorithm: "sha256";
	readonly previousDigest: string | null;
	readonly digest: string;
}

export type AuditIntegrityStatus = "verified" | "legacy" | "invalid";

export interface AuditIntegrityFailure {
	readonly sourceEntryId: string;
	readonly index: number;
	readonly reason: "invalid_seal" | "previous_digest_mismatch" | "digest_mismatch";
}

export interface AuditIntegrityProof {
	readonly schemaVersion: 1;
	readonly algorithm: "sha256";
	readonly sessionId: string;
	readonly status: AuditIntegrityStatus;
	readonly entryCount: number;
	readonly chainedEntryCount: number;
	readonly legacyEntryCount: number;
	readonly segmentCount: number;
	readonly prunedEntryCount: number;
	readonly headDigest?: string;
	readonly failure?: AuditIntegrityFailure;
}

const DIGEST_PATTERN = /^[a-f0-9]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSeal(value: unknown): value is SessionAuditSeal {
	return (
		isRecord(value) &&
		value.schemaVersion === AUDIT_INTEGRITY_SCHEMA_VERSION &&
		value.algorithm === AUDIT_INTEGRITY_ALGORITHM &&
		(value.previousDigest === null ||
			(typeof value.previousDigest === "string" && DIGEST_PATTERN.test(value.previousDigest))) &&
		typeof value.digest === "string" &&
		DIGEST_PATTERN.test(value.digest)
	);
}

function entryWithoutSeal(entry: SessionEntry): Record<string, unknown> {
	const value = structuredClone(entry) as SessionEntry & { auditIntegrity?: SessionAuditSeal };
	delete value.auditIntegrity;
	return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

export function computeSessionAuditDigest(
	sessionId: string,
	entry: SessionEntry,
	previousDigest: string | null,
): string {
	return createHash("sha256")
		.update(
			canonicalFoundationJson({
				schemaVersion: AUDIT_INTEGRITY_SCHEMA_VERSION,
				sessionId,
				previousDigest,
				entry: entryWithoutSeal(entry),
			}),
			"utf8",
		)
		.digest("hex");
}

export function sealSessionAuditEntry(
	sessionId: string,
	entry: SessionEntry,
	previousDigest: string | null,
): SessionEntry {
	const sealed = structuredClone(entry) as SessionEntry & { auditIntegrity?: SessionAuditSeal };
	sealed.auditIntegrity = {
		schemaVersion: AUDIT_INTEGRITY_SCHEMA_VERSION,
		algorithm: AUDIT_INTEGRITY_ALGORITHM,
		previousDigest,
		digest: computeSessionAuditDigest(sessionId, sealed, previousDigest),
	};
	return sealed;
}

export function latestSessionAuditDigest(entries: readonly SessionEntry[]): string | null {
	const latest = entries.at(-1)?.auditIntegrity;
	return isSeal(latest) ? latest.digest : null;
}

/** Re-seal a complete physical ledger after a trusted structural rewrite. */
export function rechainSessionAuditEntries(sessionId: string, entries: readonly SessionEntry[]): SessionEntry[] {
	let previousDigest: string | null = null;
	return entries.map((entry) => {
		const sealed = sealSessionAuditEntry(sessionId, entry, previousDigest);
		previousDigest = sealed.auditIntegrity!.digest;
		return sealed;
	});
}

/** Verify persisted seals without exposing entry payloads or digest inputs. */
export function verifySessionAuditIntegrity(
	sessionId: string,
	entries: readonly SessionEntry[],
): AuditIntegrityProof {
	let previousDigest: string | undefined;
	let chainedEntryCount = 0;
	let legacyEntryCount = 0;
	let segmentCount = 0;
	let prunedEntryCount = 0;
	let headDigest: string | undefined;
	for (let index = 0; index < entries.length; index += 1) {
		const entry = entries[index]!;
		if (
			entry.type === "custom" &&
			entry.data !== null &&
			typeof entry.data === "object" &&
			"retentionPruned" in entry.data &&
			entry.data.retentionPruned === true
		) {
			prunedEntryCount += 1;
		}
		const seal = entry.auditIntegrity;
		if (seal === undefined) {
			legacyEntryCount += 1;
			previousDigest = undefined;
			continue;
		}
		if (!isSeal(seal)) {
			return {
				schemaVersion: 1,
				algorithm: AUDIT_INTEGRITY_ALGORITHM,
				sessionId,
				status: "invalid",
				entryCount: entries.length,
				chainedEntryCount,
				legacyEntryCount,
				segmentCount,
				prunedEntryCount,
				failure: { sourceEntryId: entry.id, index, reason: "invalid_seal" },
			};
		}
		if (previousDigest === undefined) {
			segmentCount += 1;
			if (seal.previousDigest !== null) {
				return {
					schemaVersion: 1,
					algorithm: AUDIT_INTEGRITY_ALGORITHM,
					sessionId,
					status: "invalid",
					entryCount: entries.length,
					chainedEntryCount,
					legacyEntryCount,
					segmentCount,
					prunedEntryCount,
					failure: { sourceEntryId: entry.id, index, reason: "previous_digest_mismatch" },
				};
			}
		} else if (seal.previousDigest !== previousDigest) {
			return {
				schemaVersion: 1,
				algorithm: AUDIT_INTEGRITY_ALGORITHM,
				sessionId,
				status: "invalid",
				entryCount: entries.length,
				chainedEntryCount,
				legacyEntryCount,
				segmentCount,
				prunedEntryCount,
				failure: { sourceEntryId: entry.id, index, reason: "previous_digest_mismatch" },
			};
		}
		if (computeSessionAuditDigest(sessionId, entry, seal.previousDigest) !== seal.digest) {
			return {
				schemaVersion: 1,
				algorithm: AUDIT_INTEGRITY_ALGORITHM,
				sessionId,
				status: "invalid",
				entryCount: entries.length,
				chainedEntryCount,
				legacyEntryCount,
				segmentCount,
				prunedEntryCount,
				failure: { sourceEntryId: entry.id, index, reason: "digest_mismatch" },
			};
		}
		chainedEntryCount += 1;
		previousDigest = seal.digest;
		headDigest = seal.digest;
	}
	return {
		schemaVersion: 1,
		algorithm: AUDIT_INTEGRITY_ALGORITHM,
		sessionId,
		status: legacyEntryCount > 0 ? "legacy" : "verified",
		entryCount: entries.length,
		chainedEntryCount,
		legacyEntryCount,
		segmentCount,
		prunedEntryCount,
		...(headDigest === undefined ? {} : { headDigest }),
	};
}
