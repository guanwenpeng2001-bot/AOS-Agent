import {
	cloneDeepFrozen,
	fingerprintFoundationValue,
	type Fingerprint,
} from "@aos-agent/agent-core";

export const DEFAULT_EXTERNAL_CONNECTOR_READINESS_TTL_MS = 5 * 60_000;

export interface ExternalConnectorRevisionDigest {
	readonly revision: number | string;
	readonly digest: Fingerprint;
}

export interface ExternalConnectorSafeIdentity {
	readonly kind: "connector" | "file";
	readonly digest: Fingerprint;
}

/** Trusted activation facts captured before a Connector candidate is built. */
export interface ExternalConnectorActivationSource {
	readonly schemaVersion: 1;
	readonly providerId: string;
	readonly configuration: ExternalConnectorRevisionDigest;
	readonly capability: ExternalConnectorRevisionDigest;
	readonly identity: ExternalConnectorSafeIdentity;
}

export type ExternalConnectorReadinessReasonCode =
	| "ready"
	| "probe_failed"
	| "cleanup_unconfirmed"
	| "source_changed"
	| "snapshot_stale";

export interface ExternalConnectorReadinessSnapshot {
	readonly schemaVersion: 1;
	readonly providerId: string;
	readonly trust: "host_configured";
	/** Wire field for probe availability. */
	readonly status: "ready" | "not_ready" | "quarantined";
	readonly reasonCode: ExternalConnectorReadinessReasonCode;
	/** Wire field for snapshot currency or quarantine, distinct from probe availability. */
	readonly state: "current" | "quarantined";
	readonly configuration: ExternalConnectorRevisionDigest;
	readonly capability: ExternalConnectorRevisionDigest;
	readonly identity: ExternalConnectorSafeIdentity;
	readonly observedAt: string;
	readonly expiresAt: string;
	readonly ttlMs: number;
	readonly snapshotDigest: Fingerprint;
}

const ACTIVATION_SOURCE_KEYS = new Set([
	"schemaVersion",
	"providerId",
	"configuration",
	"capability",
	"identity",
]);
const REVISION_DIGEST_KEYS = new Set(["revision", "digest"]);
const IDENTITY_KEYS = new Set(["kind", "digest"]);
const FINGERPRINT_KEYS = new Set(["algorithm", "value"]);
const PROVIDER_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function readinessRecord(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function hasExactReadinessKeys(value: Record<string, unknown>, expected: ReadonlySet<string>): boolean {
	const keys = Object.keys(value);
	return keys.length === expected.size && keys.every((key) => expected.has(key));
}

function isReadinessFingerprint(value: unknown): value is Fingerprint {
	const record = readinessRecord(value);
	return (
		record !== undefined &&
		hasExactReadinessKeys(record, FINGERPRINT_KEYS) &&
		record.algorithm === "sha256" &&
		typeof record.value === "string" &&
		SHA256_PATTERN.test(record.value)
	);
}

function isRevisionDigest(value: unknown): value is ExternalConnectorRevisionDigest {
	const record = readinessRecord(value);
	const revision = record?.revision;
	return (
		record !== undefined &&
		hasExactReadinessKeys(record, REVISION_DIGEST_KEYS) &&
		((Number.isSafeInteger(revision) && (revision as number) > 0) ||
			(typeof revision === "string" && PROVIDER_ID_PATTERN.test(revision))) &&
		isReadinessFingerprint(record.digest)
	);
}

function isSafeIdentity(value: unknown): value is ExternalConnectorSafeIdentity {
	const record = readinessRecord(value);
	return (
		record !== undefined &&
		hasExactReadinessKeys(record, IDENTITY_KEYS) &&
		(record.kind === "connector" || record.kind === "file") &&
		isReadinessFingerprint(record.digest)
	);
}

export function validateExternalConnectorActivationSource(
	value: unknown,
): ExternalConnectorActivationSource | undefined {
	const record = readinessRecord(value);
	if (
		record === undefined ||
		!hasExactReadinessKeys(record, ACTIVATION_SOURCE_KEYS) ||
		record.schemaVersion !== 1 ||
		typeof record.providerId !== "string" ||
		!PROVIDER_ID_PATTERN.test(record.providerId) ||
		!isRevisionDigest(record.configuration) ||
		!isRevisionDigest(record.capability) ||
		!isSafeIdentity(record.identity)
	) {
		return undefined;
	}
	return cloneDeepFrozen({
		schemaVersion: 1,
		providerId: record.providerId,
		configuration: record.configuration,
		capability: record.capability,
		identity: record.identity,
	});
}

export function createDescriptorExternalConnectorActivationSource(input: {
	readonly providerId: string;
	readonly revision: number;
	readonly capabilityDigest: Fingerprint;
}): ExternalConnectorActivationSource {
	return cloneDeepFrozen({
		schemaVersion: 1,
		providerId: input.providerId,
		configuration: {
			revision: input.revision,
			digest: fingerprintFoundationValue({
				providerId: input.providerId,
				revision: input.revision,
				capabilityDigest: input.capabilityDigest,
			}),
		},
		capability: { revision: input.revision, digest: input.capabilityDigest },
		identity: {
			kind: "connector",
			digest: fingerprintFoundationValue({ providerId: input.providerId }),
		},
	});
}

function sameReadinessFingerprint(left: Fingerprint, right: Fingerprint): boolean {
	return left.algorithm === right.algorithm && left.value === right.value;
}

function sameRevisionDigest(
	left: ExternalConnectorRevisionDigest,
	right: ExternalConnectorRevisionDigest,
): boolean {
	return left.revision === right.revision && sameReadinessFingerprint(left.digest, right.digest);
}

export function sameExternalConnectorActivationSource(
	left: ExternalConnectorActivationSource,
	right: ExternalConnectorActivationSource,
): boolean {
	return (
		left.providerId === right.providerId &&
		sameRevisionDigest(left.configuration, right.configuration) &&
		sameRevisionDigest(left.capability, right.capability) &&
		left.identity.kind === right.identity.kind &&
		sameReadinessFingerprint(left.identity.digest, right.identity.digest)
	);
}

export function externalConnectorActivationSourceMatchesCapability(
	source: ExternalConnectorActivationSource,
	capability: {
		readonly providerId: string;
		readonly revision: number;
		readonly digest: Fingerprint;
	},
): boolean {
	return (
		source.providerId === capability.providerId &&
		source.capability.revision === capability.revision &&
		sameReadinessFingerprint(source.capability.digest, capability.digest)
	);
}

export function createExternalConnectorReadinessSnapshot(input: {
	readonly source: ExternalConnectorActivationSource;
	readonly status: ExternalConnectorReadinessSnapshot["status"];
	readonly reasonCode: ExternalConnectorReadinessReasonCode;
	readonly state: ExternalConnectorReadinessSnapshot["state"];
	readonly observedAtMs: number;
	readonly ttlMs: number;
}): ExternalConnectorReadinessSnapshot {
	if (!Number.isFinite(input.observedAtMs)) {
		throw new RangeError("External Connector readiness observation time must be finite");
	}
	if (!Number.isSafeInteger(input.ttlMs) || input.ttlMs <= 0) {
		throw new RangeError("External Connector readiness TTL must be a positive safe integer");
	}
	const snapshot = {
		schemaVersion: 1 as const,
		providerId: input.source.providerId,
		trust: "host_configured" as const,
		status: input.status,
		reasonCode: input.reasonCode,
		state: input.state,
		configuration: input.source.configuration,
		capability: input.source.capability,
		identity: input.source.identity,
		observedAt: new Date(input.observedAtMs).toISOString(),
		expiresAt: new Date(input.observedAtMs + input.ttlMs).toISOString(),
		ttlMs: input.ttlMs,
	};
	return cloneDeepFrozen({ ...snapshot, snapshotDigest: fingerprintFoundationValue(snapshot) });
}

export function externalConnectorReadinessSnapshotMatchesSource(
	snapshot: ExternalConnectorReadinessSnapshot,
	source: ExternalConnectorActivationSource,
): boolean {
	return sameExternalConnectorActivationSource(
		{
			schemaVersion: 1,
			providerId: snapshot.providerId,
			configuration: snapshot.configuration,
			capability: snapshot.capability,
			identity: snapshot.identity,
		},
		source,
	);
}

export function externalConnectorReadinessSnapshotIsCurrent(
	snapshot: ExternalConnectorReadinessSnapshot,
	nowMs: number,
): boolean {
	return (
		snapshot.state === "current" &&
		snapshot.status === "ready" &&
		Date.parse(snapshot.expiresAt) > nowMs
	);
}
