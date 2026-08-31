/** Canonical, secret-free mapping owned by the ExternalAgentConnector runtime. */

import type { Fingerprint } from "@aos-agent/agent-core";

export const EXTERNAL_CONNECTOR_MAPPING_SCHEMA_VERSION = 1 as const;

export interface CanonicalExternalConnectorMapping {
	readonly schemaVersion: typeof EXTERNAL_CONNECTOR_MAPPING_SCHEMA_VERSION;
	readonly providerId: string;
	readonly attemptId: string;
	readonly externalSessionId: string;
	readonly externalTurnId?: string;
	readonly binding: {
		readonly digest: Fingerprint;
		readonly revision: number;
	};
	readonly capability: {
		readonly digest: Fingerprint;
		readonly revision: number;
	};
	/** Opaque supervisor identity only. Process ids and local process metadata are private. */
	readonly supervisor: {
		readonly ref: string;
		readonly nonce: string;
	};
	readonly createdAt: string;
}

const MAPPING_KEYS = new Set([
	"schemaVersion",
	"providerId",
	"attemptId",
	"externalSessionId",
	"externalTurnId",
	"binding",
	"capability",
	"supervisor",
	"createdAt",
]);
const REVISION_KEYS = new Set(["digest", "revision"]);
const SUPERVISOR_KEYS = new Set(["ref", "nonce"]);
const FINGERPRINT_KEYS = new Set(["algorithm", "value"]);
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: ReadonlySet<string>): boolean {
	return Object.keys(value).every((key) => keys.has(key));
}

export function isExternalConnectorMappingIdentifier(value: unknown): value is string {
	return (
		typeof value === "string" &&
		IDENTIFIER_PATTERN.test(value) &&
		!value.includes("/") &&
		!value.includes("\\") &&
		!value.includes("?") &&
		!value.includes("#") &&
		!value.includes("@") &&
		!value.includes("://")
	);
}

export function isCanonicalExternalConnectorMappingTimestamp(value: unknown): value is string {
	if (typeof value !== "string" || !TIMESTAMP_PATTERN.test(value)) return false;
	const timestamp = new Date(value);
	return Number.isFinite(timestamp.getTime()) && timestamp.toISOString() === value;
}

function isFingerprint(value: unknown): value is Fingerprint {
	return (
		isRecord(value) &&
		hasOnlyKeys(value, FINGERPRINT_KEYS) &&
		value.algorithm === "sha256" &&
		typeof value.value === "string" &&
		DIGEST_PATTERN.test(value.value)
	);
}

function isRevision(value: unknown): value is { readonly digest: Fingerprint; readonly revision: number } {
	return (
		isRecord(value) &&
		hasOnlyKeys(value, REVISION_KEYS) &&
		isFingerprint(value.digest) &&
		Number.isSafeInteger(value.revision) &&
		(value.revision as number) >= 1
	);
}

/** Exact guard for the only current External Connector mapping record. */
export function isCanonicalExternalConnectorMapping(value: unknown): value is CanonicalExternalConnectorMapping {
	return (
		isRecord(value) &&
		hasOnlyKeys(value, MAPPING_KEYS) &&
		value.schemaVersion === EXTERNAL_CONNECTOR_MAPPING_SCHEMA_VERSION &&
		isExternalConnectorMappingIdentifier(value.providerId) &&
		isExternalConnectorMappingIdentifier(value.attemptId) &&
		isExternalConnectorMappingIdentifier(value.externalSessionId) &&
		(value.externalTurnId === undefined || isExternalConnectorMappingIdentifier(value.externalTurnId)) &&
		isRevision(value.binding) &&
		isRevision(value.capability) &&
		isRecord(value.supervisor) &&
		hasOnlyKeys(value.supervisor, SUPERVISOR_KEYS) &&
		isExternalConnectorMappingIdentifier(value.supervisor.ref) &&
		isExternalConnectorMappingIdentifier(value.supervisor.nonce) &&
		isCanonicalExternalConnectorMappingTimestamp(value.createdAt)
	);
}

/** Validate, clone, and freeze a canonical connector mapping. */
export function cloneCanonicalExternalConnectorMapping(value: unknown): CanonicalExternalConnectorMapping {
	if (!isCanonicalExternalConnectorMapping(value)) {
		throw new TypeError("Canonical external connector mapping is invalid.");
	}
	return Object.freeze({
		...value,
		binding: Object.freeze({ ...value.binding, digest: Object.freeze({ ...value.binding.digest }) }),
		capability: Object.freeze({ ...value.capability, digest: Object.freeze({ ...value.capability.digest }) }),
		supervisor: Object.freeze({ ...value.supervisor }),
	});
}
