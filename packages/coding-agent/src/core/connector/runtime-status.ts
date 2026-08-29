/** Passive, immutable, secret-free External Connector runtime status. */

import {
	cloneDeepFrozen,
	fingerprintFoundationValue,
	type Fingerprint,
} from "@aos-agent/agent-core";
import type {
	ConnectorCircuitFact,
	ConnectorCircuitState,
} from "./retry-circuit.ts";
import {
	validateExternalConnectorActivationSource,
	type ExternalConnectorReadinessReasonCode,
	type ExternalConnectorReadinessSnapshot,
} from "./readiness.ts";
import {
	validateRuntimeLimitsSnapshot,
	type RuntimeLimitsSnapshot,
} from "../runtime-limits.ts";

export const CONNECTOR_RUNTIME_STATUS_MAX_COUNT = 2_147_483_647;
export const CONNECTOR_RUNTIME_STATUS_MAX_TIME_MS = Number.MAX_SAFE_INTEGER;
export const CONNECTOR_RUNTIME_LATENCY_BUCKET_BOUNDS_MS = Object.freeze([
	10,
	50,
	100,
	250,
	500,
	1_000,
	2_500,
	5_000,
	10_000,
	30_000,
	60_000,
	120_000,
] as const);

export interface ConnectorRuntimeActivitySnapshot {
	readonly active: number;
	readonly queued: number;
	readonly reconcile: number;
}

export interface ConnectorRuntimeCounterSnapshot {
	readonly startTotal: number;
	readonly resumeTotal: number;
	readonly cancelTotal: number;
	readonly forcedKillTotal: number;
	readonly limitRejectTotal: number;
	readonly frameRejectTotal: number;
	readonly eventDropTotal: number;
}

export interface ConnectorRuntimeLatencyHistogram {
	readonly boundsMs: readonly number[];
	/** Cumulative counts for the corresponding finite upper bounds. */
	readonly counts: readonly number[];
	/** Samples greater than the last finite bound. */
	readonly overflowCount: number;
}

export interface ConnectorRuntimeLatencySnapshot {
	readonly cancelMs: ConnectorRuntimeLatencyHistogram;
	readonly shutdownMs: ConnectorRuntimeLatencyHistogram;
}

/**
 * Trusted aggregate captured by execution owners. It contains no errors, commands,
 * paths, environment values, endpoints, credentials, or vendor payloads.
 */
export interface ConnectorRuntimeAggregateSnapshot {
	readonly schemaVersion: 1;
	readonly providerId: string;
	readonly targetId: string;
	readonly observedAt: string;
	readonly expiresAt: string;
	readonly ttlMs: number;
	readonly circuit: ConnectorCircuitFact | null;
	readonly limits: RuntimeLimitsSnapshot;
	readonly activity: ConnectorRuntimeActivitySnapshot;
	readonly counters: ConnectorRuntimeCounterSnapshot;
	readonly latency: ConnectorRuntimeLatencySnapshot;
	readonly snapshotDigest: Fingerprint;
}

export interface ConnectorRuntimeAggregateSnapshotInput {
	readonly providerId: string;
	readonly targetId: string;
	readonly observedAtMs: number;
	readonly ttlMs: number;
	readonly circuit: ConnectorCircuitFact | null;
	readonly limits: RuntimeLimitsSnapshot;
	readonly activity: ConnectorRuntimeActivitySnapshot;
	readonly counters: ConnectorRuntimeCounterSnapshot;
	readonly latency: {
		readonly cancelMs: {
			readonly counts: readonly number[];
			readonly overflowCount: number;
		};
		readonly shutdownMs: {
			readonly counts: readonly number[];
			readonly overflowCount: number;
		};
	};
}

export type ConnectorRuntimeReadinessState = "ready" | "stale" | "not_ready" | "quarantined";
export type ConnectorRuntimeReadinessReasonCode =
	| ExternalConnectorReadinessReasonCode
	| "status_snapshot_malformed";

export interface ConnectorRuntimeReadinessStatus {
	readonly state: ConnectorRuntimeReadinessState;
	readonly reasonCode: ConnectorRuntimeReadinessReasonCode;
	readonly observedAgeMs?: number;
	readonly expiresInMs?: number;
}

export interface ConnectorRuntimeCircuitStatus {
	readonly state: ConnectorCircuitState;
	readonly nextTransition: "none" | "half_open" | "open";
	readonly transitionInMs?: number;
}

export type ConnectorRuntimeStatusUnavailableReason =
	| "status_source_missing"
	| "status_snapshot_malformed"
	| "status_snapshot_stale"
	| "status_identity_mismatch"
	| "status_clock_invalid";

interface ConnectorRuntimeStatusBase {
	readonly schemaVersion: 1;
	readonly providerId: string;
	readonly readiness: ConnectorRuntimeReadinessStatus;
}

export interface ConnectorRuntimeStatusAvailable extends ConnectorRuntimeStatusBase {
	readonly availability: "available";
	readonly targetId: string;
	readonly observation: {
		readonly observedAgeMs: number;
		readonly expiresInMs: number;
	};
	readonly circuit: ConnectorRuntimeCircuitStatus;
	readonly activity: ConnectorRuntimeActivitySnapshot;
	readonly counters: ConnectorRuntimeCounterSnapshot;
	readonly latency: ConnectorRuntimeLatencySnapshot;
	readonly limits: RuntimeLimitsSnapshot;
}

export interface ConnectorRuntimeStatusUnavailable extends ConnectorRuntimeStatusBase {
	readonly availability: "unavailable";
	readonly reasonCode: ConnectorRuntimeStatusUnavailableReason;
	/** Present only when a complete trusted snapshot established the exact target. */
	readonly targetId?: string;
}

export type ConnectorRuntimeStatus =
	| ConnectorRuntimeStatusAvailable
	| ConnectorRuntimeStatusUnavailable;

/** A trusted source must only return an already-captured in-memory snapshot. */
export interface ConnectorRuntimeStatusSource {
	read(providerId: string): unknown;
}

export interface ConnectorRuntimeStatusProjectionInput {
	readonly providerId: string;
	readonly readinessSnapshot: unknown;
	readonly runtimeSnapshot: unknown;
	readonly nowMs: number;
}

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u;
const SAFE_CODE_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const FINGERPRINT_KEYS = new Set(["algorithm", "value"]);
const AGGREGATE_KEYS = new Set([
	"schemaVersion",
	"providerId",
	"targetId",
	"observedAt",
	"expiresAt",
	"ttlMs",
	"circuit",
	"limits",
	"activity",
	"counters",
	"latency",
	"snapshotDigest",
]);
const ACTIVITY_KEYS = new Set(["active", "queued", "reconcile"]);
const COUNTER_KEYS = new Set([
	"startTotal",
	"resumeTotal",
	"cancelTotal",
	"forcedKillTotal",
	"limitRejectTotal",
	"frameRejectTotal",
	"eventDropTotal",
]);
const LATENCY_KEYS = new Set(["cancelMs", "shutdownMs"]);
const HISTOGRAM_KEYS = new Set(["boundsMs", "counts", "overflowCount"]);
const READINESS_KEYS = new Set([
	"schemaVersion",
	"providerId",
	"trust",
	"status",
	"reasonCode",
	"state",
	"configuration",
	"capability",
	"identity",
	"observedAt",
	"expiresAt",
	"ttlMs",
	"snapshotDigest",
]);
const CIRCUIT_KEYS = new Set([
	"schemaVersion",
	"targetId",
	"state",
	"failureCount",
	"updatedAt",
	"transition",
	"policy",
	"nextProbeAt",
	"probeOperationId",
	"probeExpiresAt",
	"lastFailureCode",
	"lastFailureOperationId",
	"lastFailureAttemptCount",
	"lastResetId",
]);
const CIRCUIT_POLICY_KEYS = new Set([
	"maxAttempts",
	"baseDelayMs",
	"maxDelayMs",
	"totalRetryTimeMs",
	"jitterPermille",
	"failureThreshold",
	"openDurationMs",
	"halfOpenProbeTimeoutMs",
]);
const CIRCUIT_STATES = new Set(["closed", "open", "half_open"]);
const CIRCUIT_TRANSITIONS = new Set([
	"none",
	"failure_recorded",
	"closed_to_open",
	"open_to_half_open",
	"half_open_expired",
	"half_open_to_open",
	"half_open_to_closed",
	"success_recorded",
	"operator_reset",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: ReadonlySet<string>): boolean {
	const ownKeys = Reflect.ownKeys(value);
	return ownKeys.length === keys.size && ownKeys.every((key) => typeof key === "string" && keys.has(key));
}

function hasOnlyKeys(value: Record<string, unknown>, keys: ReadonlySet<string>): boolean {
	return Reflect.ownKeys(value).every((key) => typeof key === "string" && keys.has(key));
}

function isIdentifier(value: unknown): value is string {
	return typeof value === "string" && IDENTIFIER_PATTERN.test(value);
}

function isBoundedCount(value: unknown): value is number {
	return (
		typeof value === "number" &&
		Number.isSafeInteger(value) &&
		value >= 0 &&
		value <= CONNECTOR_RUNTIME_STATUS_MAX_COUNT
	);
}

function isBoundedTime(value: unknown): value is number {
	return (
		typeof value === "number" &&
		Number.isSafeInteger(value) &&
		value >= 0 &&
		value <= CONNECTOR_RUNTIME_STATUS_MAX_TIME_MS
	);
}

function parseIsoTime(value: unknown): number | undefined {
	if (typeof value !== "string") return undefined;
	const parsed = Date.parse(value);
	return isBoundedTime(parsed) && new Date(parsed).toISOString() === value ? parsed : undefined;
}

function isFingerprint(value: unknown): value is Fingerprint {
	return (
		isRecord(value) &&
		hasExactKeys(value, FINGERPRINT_KEYS) &&
		value.algorithm === "sha256" &&
		typeof value.value === "string" &&
		SHA256_PATTERN.test(value.value)
	);
}

function sameFingerprint(left: Fingerprint, right: Fingerprint): boolean {
	return left.algorithm === right.algorithm && left.value === right.value;
}

function validObservation(
	observedAt: unknown,
	expiresAt: unknown,
	ttlMs: unknown,
): { readonly observedAtMs: number; readonly expiresAtMs: number; readonly ttlMs: number } | undefined {
	const observedAtMs = parseIsoTime(observedAt);
	const expiresAtMs = parseIsoTime(expiresAt);
	if (
		observedAtMs === undefined ||
		expiresAtMs === undefined ||
		!isBoundedTime(ttlMs) ||
		ttlMs === 0 ||
		expiresAtMs < observedAtMs ||
		expiresAtMs - observedAtMs !== ttlMs
	) {
		return undefined;
	}
	return { observedAtMs, expiresAtMs, ttlMs };
}

function parseActivity(value: unknown): ConnectorRuntimeActivitySnapshot | undefined {
	if (!isRecord(value) || !hasExactKeys(value, ACTIVITY_KEYS)) return undefined;
	if (!isBoundedCount(value.active) || !isBoundedCount(value.queued) || !isBoundedCount(value.reconcile)) {
		return undefined;
	}
	return Object.freeze({ active: value.active, queued: value.queued, reconcile: value.reconcile });
}

function parseCounters(value: unknown): ConnectorRuntimeCounterSnapshot | undefined {
	if (!isRecord(value) || !hasExactKeys(value, COUNTER_KEYS)) return undefined;
	for (const key of COUNTER_KEYS) {
		if (!isBoundedCount(value[key])) return undefined;
	}
	return Object.freeze({
		startTotal: value.startTotal as number,
		resumeTotal: value.resumeTotal as number,
		cancelTotal: value.cancelTotal as number,
		forcedKillTotal: value.forcedKillTotal as number,
		limitRejectTotal: value.limitRejectTotal as number,
		frameRejectTotal: value.frameRejectTotal as number,
		eventDropTotal: value.eventDropTotal as number,
	});
}

function parseHistogram(value: unknown): ConnectorRuntimeLatencyHistogram | undefined {
	if (!isRecord(value) || !hasExactKeys(value, HISTOGRAM_KEYS)) return undefined;
	if (
		!Array.isArray(value.boundsMs) ||
		value.boundsMs.length !== CONNECTOR_RUNTIME_LATENCY_BUCKET_BOUNDS_MS.length ||
		!value.boundsMs.every((bound, index) => bound === CONNECTOR_RUNTIME_LATENCY_BUCKET_BOUNDS_MS[index]) ||
		!Array.isArray(value.counts) ||
		value.counts.length !== CONNECTOR_RUNTIME_LATENCY_BUCKET_BOUNDS_MS.length ||
		!value.counts.every(isBoundedCount) ||
		!isBoundedCount(value.overflowCount)
	) {
		return undefined;
	}
	for (let index = 1; index < value.counts.length; index += 1) {
		if ((value.counts[index] as number) < (value.counts[index - 1] as number)) return undefined;
	}
	return Object.freeze({
		boundsMs: CONNECTOR_RUNTIME_LATENCY_BUCKET_BOUNDS_MS,
		counts: Object.freeze([...value.counts] as number[]),
		overflowCount: value.overflowCount,
	});
}

function parseLatency(value: unknown): ConnectorRuntimeLatencySnapshot | undefined {
	if (!isRecord(value) || !hasExactKeys(value, LATENCY_KEYS)) return undefined;
	const cancelMs = parseHistogram(value.cancelMs);
	const shutdownMs = parseHistogram(value.shutdownMs);
	return cancelMs === undefined || shutdownMs === undefined
		? undefined
		: Object.freeze({ cancelMs, shutdownMs });
}

function isCircuitPolicy(value: unknown): boolean {
	if (!isRecord(value) || !hasExactKeys(value, CIRCUIT_POLICY_KEYS)) return false;
	const boundedPositive = (candidate: unknown, maximum = CONNECTOR_RUNTIME_STATUS_MAX_TIME_MS): candidate is number =>
		typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate > 0 && candidate <= maximum;
	return (
		boundedPositive(value.maxAttempts, 100) &&
		boundedPositive(value.baseDelayMs) &&
		boundedPositive(value.maxDelayMs) &&
		(value.baseDelayMs as number) <= (value.maxDelayMs as number) &&
		boundedPositive(value.totalRetryTimeMs) &&
		(value.maxDelayMs as number) <= (value.totalRetryTimeMs as number) &&
		isBoundedCount(value.jitterPermille) &&
		(value.jitterPermille as number) <= 1_000 &&
		boundedPositive(value.failureThreshold, 100) &&
		boundedPositive(value.openDurationMs) &&
		(value.openDurationMs as number) <= (value.maxDelayMs as number) &&
		boundedPositive(value.halfOpenProbeTimeoutMs) &&
		(value.halfOpenProbeTimeoutMs as number) <= (value.maxDelayMs as number)
	);
}

function validOptionalIdentity(value: unknown): boolean {
	return value === undefined || (typeof value === "string" && value.length > 0 && value.length <= 256);
}

function parseCircuit(value: unknown, targetId: string): ConnectorCircuitFact | null | undefined {
	if (value === null) return null;
	if (
		!isRecord(value) ||
		!hasOnlyKeys(value, CIRCUIT_KEYS) ||
		value.schemaVersion !== 1 ||
		value.targetId !== targetId ||
		typeof value.state !== "string" ||
		!CIRCUIT_STATES.has(value.state) ||
		!isBoundedCount(value.failureCount) ||
		parseIsoTime(value.updatedAt) === undefined ||
		typeof value.transition !== "string" ||
		!CIRCUIT_TRANSITIONS.has(value.transition) ||
		!isCircuitPolicy(value.policy) ||
		(value.lastFailureCode !== undefined &&
			(typeof value.lastFailureCode !== "string" || !SAFE_CODE_PATTERN.test(value.lastFailureCode))) ||
		!validOptionalIdentity(value.lastFailureOperationId) ||
		(value.lastFailureAttemptCount !== undefined && !isBoundedCount(value.lastFailureAttemptCount)) ||
		!validOptionalIdentity(value.lastResetId)
	) {
		return undefined;
	}
	if (
		(value.state === "closed" &&
			(value.nextProbeAt !== undefined || value.probeOperationId !== undefined || value.probeExpiresAt !== undefined)) ||
		(value.state === "open" &&
			(parseIsoTime(value.nextProbeAt) === undefined ||
				value.probeOperationId !== undefined ||
				value.probeExpiresAt !== undefined)) ||
		(value.state === "half_open" &&
			(value.nextProbeAt !== undefined ||
				!validOptionalIdentity(value.probeOperationId) ||
				value.probeOperationId === undefined ||
				parseIsoTime(value.probeExpiresAt) === undefined))
	) {
		return undefined;
	}
	return cloneDeepFrozen(value) as unknown as ConnectorCircuitFact;
}

function parseReadiness(
	value: unknown,
	providerId: string,
): { readonly snapshot: ExternalConnectorReadinessSnapshot; readonly observedAtMs: number; readonly expiresAtMs: number } | undefined {
	if (
		!isRecord(value) ||
		!hasExactKeys(value, READINESS_KEYS) ||
		value.schemaVersion !== 1 ||
		value.providerId !== providerId ||
		value.trust !== "host_configured" ||
		!isFingerprint(value.snapshotDigest)
	) {
		return undefined;
	}
	const source = validateExternalConnectorActivationSource({
		schemaVersion: 1,
		providerId: value.providerId,
		configuration: value.configuration,
		capability: value.capability,
		identity: value.identity,
	});
	const observation = validObservation(value.observedAt, value.expiresAt, value.ttlMs);
	const validState =
		(value.status === "ready" && value.state === "current" && value.reasonCode === "ready") ||
		(value.status === "not_ready" && value.state === "current" && value.reasonCode === "probe_failed") ||
		(value.status === "quarantined" &&
			value.state === "quarantined" &&
			(value.reasonCode === "cleanup_unconfirmed" || value.reasonCode === "source_changed"));
	if (source === undefined || observation === undefined || !validState) return undefined;
	const { snapshotDigest: _snapshotDigest, ...digestPayload } = value;
	const expectedDigest = fingerprintFoundationValue(digestPayload);
	if (!sameFingerprint(value.snapshotDigest, expectedDigest)) return undefined;
	return {
		snapshot: cloneDeepFrozen(value) as unknown as ExternalConnectorReadinessSnapshot,
		observedAtMs: observation.observedAtMs,
		expiresAtMs: observation.expiresAtMs,
	};
}

function parseAggregate(value: unknown): {
	readonly snapshot: ConnectorRuntimeAggregateSnapshot;
	readonly observedAtMs: number;
	readonly expiresAtMs: number;
} | undefined {
	if (
		!isRecord(value) ||
		!hasExactKeys(value, AGGREGATE_KEYS) ||
		value.schemaVersion !== 1 ||
		!isIdentifier(value.providerId) ||
		!isIdentifier(value.targetId) ||
		!isFingerprint(value.snapshotDigest)
	) {
		return undefined;
	}
	const observation = validObservation(value.observedAt, value.expiresAt, value.ttlMs);
	const circuit = parseCircuit(value.circuit, value.targetId);
	const limits = validateRuntimeLimitsSnapshot(value.limits);
	const activity = parseActivity(value.activity);
	const counters = parseCounters(value.counters);
	const latency = parseLatency(value.latency);
	if (
		observation === undefined ||
		circuit === undefined ||
		limits === undefined ||
		activity === undefined ||
		counters === undefined ||
		latency === undefined
	) {
		return undefined;
	}
	const canonical = {
		schemaVersion: 1 as const,
		providerId: value.providerId,
		targetId: value.targetId,
		observedAt: value.observedAt as string,
		expiresAt: value.expiresAt as string,
		ttlMs: value.ttlMs as number,
		circuit,
		limits,
		activity,
		counters,
		latency,
	};
	const expectedDigest = fingerprintFoundationValue(canonical);
	if (!sameFingerprint(value.snapshotDigest, expectedDigest)) return undefined;
	return {
		snapshot: cloneDeepFrozen({ ...canonical, snapshotDigest: expectedDigest }),
		observedAtMs: observation.observedAtMs,
		expiresAtMs: observation.expiresAtMs,
	};
}

function safeReadiness(): ConnectorRuntimeReadinessStatus {
	return Object.freeze({ state: "not_ready", reasonCode: "status_snapshot_malformed" });
}

function projectReadiness(
	parsed: NonNullable<ReturnType<typeof parseReadiness>>,
	nowMs: number,
): ConnectorRuntimeReadinessStatus | undefined {
	if (nowMs < parsed.observedAtMs) return undefined;
	const stale = parsed.snapshot.status === "ready" && parsed.expiresAtMs <= nowMs;
	return Object.freeze({
		state: stale ? "stale" : parsed.snapshot.status,
		reasonCode: stale ? "snapshot_stale" : parsed.snapshot.reasonCode,
		observedAgeMs: nowMs - parsed.observedAtMs,
		expiresInMs: Math.max(0, parsed.expiresAtMs - nowMs),
	});
}

function unavailableStatus(
	providerId: string,
	reasonCode: ConnectorRuntimeStatusUnavailableReason,
	readiness: ConnectorRuntimeReadinessStatus,
	targetId?: string,
): ConnectorRuntimeStatusUnavailable {
	return cloneDeepFrozen({
		schemaVersion: 1 as const,
		providerId,
		availability: "unavailable" as const,
		reasonCode,
		readiness,
		...(targetId === undefined ? {} : { targetId }),
	});
}

function projectCircuit(
	fact: ConnectorCircuitFact | null,
	nowMs: number,
): ConnectorRuntimeCircuitStatus | undefined {
	if (fact === null || fact.state === "closed") {
		return Object.freeze({ state: "closed", nextTransition: "none" });
	}
	const transitionAt = parseIsoTime(fact.state === "open" ? fact.nextProbeAt : fact.probeExpiresAt);
	if (transitionAt === undefined) return undefined;
	return Object.freeze({
		state: fact.state,
		nextTransition: fact.state === "open" ? "half_open" : "open",
		transitionInMs: Math.max(0, transitionAt - nowMs),
	});
}

/** Create a canonical trusted aggregate for later passive projection. */
export function createConnectorRuntimeAggregateSnapshot(
	input: ConnectorRuntimeAggregateSnapshotInput,
): ConnectorRuntimeAggregateSnapshot {
	if (
		!isIdentifier(input.providerId) ||
		!isIdentifier(input.targetId) ||
		!isBoundedTime(input.observedAtMs) ||
		!isBoundedTime(input.ttlMs) ||
		input.ttlMs === 0 ||
		!isBoundedTime(input.observedAtMs + input.ttlMs)
	) {
		throw new TypeError("Connector runtime aggregate identity or observation is invalid");
	}
	const observedAt = new Date(input.observedAtMs);
	const expiresAt = new Date(input.observedAtMs + input.ttlMs);
	if (!Number.isFinite(observedAt.getTime()) || !Number.isFinite(expiresAt.getTime())) {
		throw new TypeError("Connector runtime aggregate identity or observation is invalid");
	}
	const candidate = {
		schemaVersion: 1 as const,
		providerId: input.providerId,
		targetId: input.targetId,
		observedAt: observedAt.toISOString(),
		expiresAt: expiresAt.toISOString(),
		ttlMs: input.ttlMs,
		circuit: input.circuit,
		limits: input.limits,
		activity: input.activity,
		counters: input.counters,
		latency: {
			cancelMs: {
				boundsMs: CONNECTOR_RUNTIME_LATENCY_BUCKET_BOUNDS_MS,
				counts: input.latency.cancelMs.counts,
				overflowCount: input.latency.cancelMs.overflowCount,
			},
			shutdownMs: {
				boundsMs: CONNECTOR_RUNTIME_LATENCY_BUCKET_BOUNDS_MS,
				counts: input.latency.shutdownMs.counts,
				overflowCount: input.latency.shutdownMs.overflowCount,
			},
		},
	};
	let snapshotDigest: Fingerprint;
	try {
		snapshotDigest = fingerprintFoundationValue(candidate);
	} catch {
		throw new TypeError("Connector runtime aggregate snapshot is invalid");
	}
	const parsed = parseAggregate({
		...candidate,
		snapshotDigest,
	});
	if (parsed === undefined) throw new TypeError("Connector runtime aggregate snapshot is invalid");
	return parsed.snapshot;
}

/**
 * Project status from already-captured trusted snapshots. This function is synchronous
 * and performs no probe, credential, process, scheduler, filesystem, or network action.
 */
function projectConnectorRuntimeStatusUnchecked(
	input: ConnectorRuntimeStatusProjectionInput,
): ConnectorRuntimeStatus {
	const providerId = isIdentifier(input.providerId) ? input.providerId : "unknown";
	if (!isIdentifier(input.providerId) || !isBoundedTime(input.nowMs)) {
		return unavailableStatus(providerId, "status_clock_invalid", safeReadiness());
	}
	const readinessSnapshot = parseReadiness(input.readinessSnapshot, providerId);
	if (readinessSnapshot === undefined) {
		return unavailableStatus(providerId, "status_snapshot_malformed", safeReadiness());
	}
	const readiness = projectReadiness(readinessSnapshot, input.nowMs);
	if (readiness === undefined) {
		return unavailableStatus(providerId, "status_snapshot_malformed", safeReadiness());
	}
	if (input.runtimeSnapshot === undefined) {
		return unavailableStatus(providerId, "status_source_missing", readiness);
	}
	const runtimeSnapshot = parseAggregate(input.runtimeSnapshot);
	if (runtimeSnapshot === undefined) {
		return unavailableStatus(providerId, "status_snapshot_malformed", readiness);
	}
	if (runtimeSnapshot.snapshot.providerId !== providerId) {
		return unavailableStatus(providerId, "status_identity_mismatch", readiness);
	}
	if (input.nowMs < runtimeSnapshot.observedAtMs) {
		return unavailableStatus(providerId, "status_snapshot_malformed", readiness);
	}
	if (runtimeSnapshot.expiresAtMs <= input.nowMs) {
		return unavailableStatus(
			providerId,
			"status_snapshot_stale",
			readiness,
			runtimeSnapshot.snapshot.targetId,
		);
	}
	const circuit = projectCircuit(runtimeSnapshot.snapshot.circuit, input.nowMs);
	if (circuit === undefined) {
		return unavailableStatus(providerId, "status_snapshot_malformed", readiness);
	}
	return cloneDeepFrozen({
		schemaVersion: 1 as const,
		providerId,
		targetId: runtimeSnapshot.snapshot.targetId,
		availability: "available" as const,
		readiness,
		observation: {
			observedAgeMs: input.nowMs - runtimeSnapshot.observedAtMs,
			expiresInMs: runtimeSnapshot.expiresAtMs - input.nowMs,
		},
		circuit,
		activity: runtimeSnapshot.snapshot.activity,
		counters: runtimeSnapshot.snapshot.counters,
		latency: runtimeSnapshot.snapshot.latency,
		limits: runtimeSnapshot.snapshot.limits,
	});
}

export function projectConnectorRuntimeStatus(
	input: ConnectorRuntimeStatusProjectionInput,
): ConnectorRuntimeStatus {
	const providerId = isIdentifier(input.providerId) ? input.providerId : "unknown";
	try {
		return projectConnectorRuntimeStatusUnchecked(input);
	} catch {
		return unavailableStatus(providerId, "status_snapshot_malformed", safeReadiness());
	}
}
