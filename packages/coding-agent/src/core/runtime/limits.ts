/** Canonical finite runtime limits for one External Connector Attempt. */

import { fingerprintFoundationValue, type Fingerprint } from "@aos-agent/agent-core";
import { isExternalConnectorMappingIdentifier } from "../connector/session-mapping.ts";
import type {
	ExternalConnectorSegmentDeadline,
	ExternalConnectorSupervisorDeadlineOverrides,
	ExternalConnectorSupervisorLimits,
} from "../connector/supervisor.ts";

export const RUNTIME_LIMIT_NAMES = [
	"startupHardMs",
	"startupIdleMs",
	"readinessHardMs",
	"readinessIdleMs",
	"attemptWallMs",
	"attemptIdleMs",
	"cancelGraceMs",
	"cancelIdleMs",
	"shutdownHardMs",
	"shutdownIdleMs",
	"maxFrameBytes",
	"maxPendingWriteBytes",
	"maxStderrBytes",
	"maxEvents",
	"maxEventsPerWindow",
	"eventRateWindowMs",
	"maxEventBytes",
	"maxOutputBytes",
	"maxArtifactRefs",
	"maxConcurrency",
	"maxRetries",
	"retryBudgetMs",
	"maxBacklog",
] as const;

export type RuntimeLimitName = (typeof RUNTIME_LIMIT_NAMES)[number];

export interface RuntimeLimitValues {
	readonly startupHardMs: number;
	readonly startupIdleMs: number;
	readonly readinessHardMs: number;
	readonly readinessIdleMs: number;
	readonly attemptWallMs: number;
	readonly attemptIdleMs: number;
	readonly cancelGraceMs: number;
	readonly cancelIdleMs: number;
	readonly shutdownHardMs: number;
	readonly shutdownIdleMs: number;
	readonly maxFrameBytes: number;
	readonly maxPendingWriteBytes: number;
	readonly maxStderrBytes: number;
	readonly maxEvents: number;
	readonly maxEventsPerWindow: number;
	readonly eventRateWindowMs: number;
	readonly maxEventBytes: number;
	readonly maxOutputBytes: number;
	readonly maxArtifactRefs: number;
	readonly maxConcurrency: number;
	readonly maxRetries: number;
	readonly retryBudgetMs: number;
	readonly maxBacklog: number;
}

export type RuntimeLimitOverrides = Partial<RuntimeLimitValues>;

export interface RuntimeLimitsResolutionInput {
	/** Trusted global selection; it may differ from the default but cannot exceed the product ceiling. */
	readonly global?: RuntimeLimitOverrides;
	/** Managed, project, and Role layers can only tighten the preceding layer. */
	readonly managed?: RuntimeLimitOverrides;
	readonly project?: RuntimeLimitOverrides;
	readonly role?: RuntimeLimitOverrides;
}

export interface RuntimeLimitsSnapshot {
	readonly schemaVersion: 1;
	readonly values: RuntimeLimitValues;
	readonly digest: Fingerprint;
}

export type RuntimeLimitsSourceValue = RuntimeLimitsResolutionInput | RuntimeLimitsSnapshot;
export type RuntimeLimitsSource = RuntimeLimitsSourceValue | (() => RuntimeLimitsSourceValue);

export const DEFAULT_RUNTIME_LIMIT_VALUES: Readonly<RuntimeLimitValues> = Object.freeze({
	startupHardMs: 30_000,
	startupIdleMs: 10_000,
	readinessHardMs: 30_000,
	readinessIdleMs: 10_000,
	attemptWallMs: 60 * 60_000,
	attemptIdleMs: 30_000,
	cancelGraceMs: 5_000,
	cancelIdleMs: 2_000,
	shutdownHardMs: 5_000,
	shutdownIdleMs: 2_000,
	maxFrameBytes: 1024 * 1024,
	maxPendingWriteBytes: 4 * 1024 * 1024,
	maxStderrBytes: 1024 * 1024,
	maxEvents: 256,
	maxEventsPerWindow: 64,
	eventRateWindowMs: 1_000,
	maxEventBytes: 256 * 1024,
	maxOutputBytes: 4 * 1024 * 1024,
	maxArtifactRefs: 64,
	maxConcurrency: 8,
	maxRetries: 3,
	retryBudgetMs: 5 * 60_000,
	maxBacklog: 1_024,
});

export const RUNTIME_LIMIT_CEILINGS: Readonly<RuntimeLimitValues> = Object.freeze({
	startupHardMs: 5 * 60_000,
	startupIdleMs: 60_000,
	readinessHardMs: 5 * 60_000,
	readinessIdleMs: 60_000,
	attemptWallMs: 24 * 60 * 60_000,
	attemptIdleMs: 60 * 60_000,
	cancelGraceMs: 60_000,
	cancelIdleMs: 60_000,
	shutdownHardMs: 2 * 60_000,
	shutdownIdleMs: 60_000,
	maxFrameBytes: 16 * 1024 * 1024,
	maxPendingWriteBytes: 64 * 1024 * 1024,
	maxStderrBytes: 16 * 1024 * 1024,
	maxEvents: 100_000,
	maxEventsPerWindow: 10_000,
	eventRateWindowMs: 60_000,
	maxEventBytes: 4 * 1024 * 1024,
	maxOutputBytes: 256 * 1024 * 1024,
	maxArtifactRefs: 10_000,
	maxConcurrency: 256,
	maxRetries: 32,
	retryBudgetMs: 24 * 60 * 60_000,
	maxBacklog: 100_000,
});

const RUNTIME_LIMIT_RESOLUTION_KEYS = new Set(["global", "managed", "project", "role"]);
const RUNTIME_LIMIT_KEYS: ReadonlySet<string> = new Set(RUNTIME_LIMIT_NAMES);
const RUNTIME_LIMIT_SNAPSHOT_KEYS = new Set(["schemaVersion", "values", "digest"]);
const RUNTIME_LIMIT_DIGEST_KEYS = new Set(["algorithm", "value"]);
const RUNTIME_LIMIT_DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const RUNTIME_LIMIT_TOKEN_PREFIX = "rl1";
const RUNTIME_LIMIT_TOKEN_VALUE_PATTERN = /^[0-9a-z]+$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: ReadonlySet<string>): boolean {
	return Reflect.ownKeys(value).every((key) => typeof key === "string" && keys.has(key));
}

function isPositiveSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function cloneRuntimeLimitValues(value: RuntimeLimitValues): RuntimeLimitValues {
	return Object.freeze({
		startupHardMs: value.startupHardMs,
		startupIdleMs: value.startupIdleMs,
		readinessHardMs: value.readinessHardMs,
		readinessIdleMs: value.readinessIdleMs,
		attemptWallMs: value.attemptWallMs,
		attemptIdleMs: value.attemptIdleMs,
		cancelGraceMs: value.cancelGraceMs,
		cancelIdleMs: value.cancelIdleMs,
		shutdownHardMs: value.shutdownHardMs,
		shutdownIdleMs: value.shutdownIdleMs,
		maxFrameBytes: value.maxFrameBytes,
		maxPendingWriteBytes: value.maxPendingWriteBytes,
		maxStderrBytes: value.maxStderrBytes,
		maxEvents: value.maxEvents,
		maxEventsPerWindow: value.maxEventsPerWindow,
		eventRateWindowMs: value.eventRateWindowMs,
		maxEventBytes: value.maxEventBytes,
		maxOutputBytes: value.maxOutputBytes,
		maxArtifactRefs: value.maxArtifactRefs,
		maxConcurrency: value.maxConcurrency,
		maxRetries: value.maxRetries,
		retryBudgetMs: value.retryBudgetMs,
		maxBacklog: value.maxBacklog,
	});
}

function applyRuntimeLimitLayer(
	current: RuntimeLimitValues,
	value: unknown,
	layer: "global" | "managed" | "project" | "role",
): RuntimeLimitValues {
	if (!isRecord(value) || !hasOnlyKeys(value, RUNTIME_LIMIT_KEYS)) {
		throw new TypeError(`RuntimeLimits ${layer} override is invalid`);
	}
	const next: Record<RuntimeLimitName, number> = { ...current };
	for (const name of RUNTIME_LIMIT_NAMES) {
		const candidate = value[name];
		if (candidate === undefined) continue;
		if (!isPositiveSafeInteger(candidate) || candidate > RUNTIME_LIMIT_CEILINGS[name]) {
			throw new RangeError(`RuntimeLimits ${name} must be a positive safe integer within its ceiling`);
		}
		if (layer !== "global" && candidate > current[name]) {
			throw new RangeError(`RuntimeLimits ${layer} override cannot widen ${name}`);
		}
		next[name] = candidate;
	}
	return cloneRuntimeLimitValues(next);
}

function createRuntimeLimitsSnapshot(sourceValues: RuntimeLimitValues): RuntimeLimitsSnapshot {
	const values = cloneRuntimeLimitValues(sourceValues);
	const digest = fingerprintFoundationValue({ schemaVersion: 1, values });
	return Object.freeze({
		schemaVersion: 1,
		values,
		digest: Object.freeze({ ...digest }),
	});
}

/** Resolve trusted/global limits and the managed/project/Role no-widen chain. */
export function resolveRuntimeLimits(input: RuntimeLimitsResolutionInput = {}): RuntimeLimitsSnapshot {
	if (!isRecord(input) || !hasOnlyKeys(input, RUNTIME_LIMIT_RESOLUTION_KEYS)) {
		throw new TypeError("RuntimeLimits resolution input is invalid");
	}
	let values = cloneRuntimeLimitValues(DEFAULT_RUNTIME_LIMIT_VALUES);
	if (input.global !== undefined) values = applyRuntimeLimitLayer(values, input.global, "global");
	if (input.managed !== undefined) values = applyRuntimeLimitLayer(values, input.managed, "managed");
	if (input.project !== undefined) values = applyRuntimeLimitLayer(values, input.project, "project");
	if (input.role !== undefined) values = applyRuntimeLimitLayer(values, input.role, "role");
	return createRuntimeLimitsSnapshot(values);
}

/** Validate a durable snapshot, including its exact shape, finite values, ceilings, and digest. */
export function validateRuntimeLimitsSnapshot(value: unknown): RuntimeLimitsSnapshot | undefined {
	if (
		!isRecord(value) ||
		!hasOnlyKeys(value, RUNTIME_LIMIT_SNAPSHOT_KEYS) ||
		value.schemaVersion !== 1 ||
		!isRecord(value.values) ||
		!hasOnlyKeys(value.values, RUNTIME_LIMIT_KEYS) ||
		!isRecord(value.digest) ||
		!hasOnlyKeys(value.digest, RUNTIME_LIMIT_DIGEST_KEYS) ||
		value.digest.algorithm !== "sha256" ||
		typeof value.digest.value !== "string" ||
		!RUNTIME_LIMIT_DIGEST_PATTERN.test(value.digest.value)
	) {
		return undefined;
	}
	const overrides: Record<RuntimeLimitName, number> = { ...DEFAULT_RUNTIME_LIMIT_VALUES };
	for (const name of RUNTIME_LIMIT_NAMES) {
		const candidate = value.values[name];
		if (!isPositiveSafeInteger(candidate) || candidate > RUNTIME_LIMIT_CEILINGS[name]) return undefined;
		overrides[name] = candidate;
	}
	const canonical = createRuntimeLimitsSnapshot(overrides);
	return canonical.digest.value === value.digest.value ? canonical : undefined;
}

export const DEFAULT_RUNTIME_LIMITS: RuntimeLimitsSnapshot = resolveRuntimeLimits();

/** Read a reloadable trusted source once and return one immutable snapshot. */
export function resolveRuntimeLimitsSource(source?: RuntimeLimitsSource): RuntimeLimitsSnapshot {
	const value = typeof source === "function" ? source() : source;
	if (value === undefined) return DEFAULT_RUNTIME_LIMITS;
	const snapshot = validateRuntimeLimitsSnapshot(value);
	return snapshot ?? resolveRuntimeLimits(value as RuntimeLimitsResolutionInput);
}

/** Convert the existing trusted supervisor inputs into the centralized schema. */
export function runtimeLimitsFromSupervisorOptions(
	deadlines?: ExternalConnectorSupervisorDeadlineOverrides,
	limits?: Partial<ExternalConnectorSupervisorLimits>,
): RuntimeLimitsResolutionInput {
	const attemptHardCandidates = [deadlines?.event?.hardMs, deadlines?.receipt?.hardMs].filter(
		(value): value is number => value !== undefined,
	);
	const attemptIdleCandidates = [deadlines?.event?.idleMs, deadlines?.receipt?.idleMs].filter(
		(value): value is number => value !== undefined,
	);
	const global: RuntimeLimitOverrides = {
		...(deadlines?.start?.hardMs === undefined ? {} : { startupHardMs: deadlines.start.hardMs }),
		...(deadlines?.start?.idleMs === undefined ? {} : { startupIdleMs: deadlines.start.idleMs }),
		...(deadlines?.start?.hardMs === undefined ? {} : { readinessHardMs: deadlines.start.hardMs }),
		...(deadlines?.start?.idleMs === undefined ? {} : { readinessIdleMs: deadlines.start.idleMs }),
		...(attemptHardCandidates.length === 0 ? {} : { attemptWallMs: Math.min(...attemptHardCandidates) }),
		...(attemptIdleCandidates.length === 0 ? {} : { attemptIdleMs: Math.min(...attemptIdleCandidates) }),
		...(deadlines?.cancel?.hardMs === undefined ? {} : { cancelGraceMs: deadlines.cancel.hardMs }),
		...(deadlines?.cancel?.idleMs === undefined ? {} : { cancelIdleMs: deadlines.cancel.idleMs }),
		...(deadlines?.dispose?.hardMs === undefined ? {} : { shutdownHardMs: deadlines.dispose.hardMs }),
		...(deadlines?.dispose?.idleMs === undefined ? {} : { shutdownIdleMs: deadlines.dispose.idleMs }),
		...(limits?.maxEvents === undefined ? {} : { maxEvents: limits.maxEvents }),
		...(limits?.maxEventsPerWindow === undefined ? {} : { maxEventsPerWindow: limits.maxEventsPerWindow }),
		...(limits?.eventRateWindowMs === undefined ? {} : { eventRateWindowMs: limits.eventRateWindowMs }),
		...(limits?.maxItemBytes === undefined ? {} : { maxFrameBytes: limits.maxItemBytes }),
		...(limits?.maxItemBytes === undefined ? {} : { maxEventBytes: limits.maxItemBytes }),
		...(limits?.maxTotalBytes === undefined ? {} : { maxOutputBytes: limits.maxTotalBytes }),
		...(limits?.maxArtifactRefs === undefined ? {} : { maxArtifactRefs: limits.maxArtifactRefs }),
	};
	return Object.freeze({ global: Object.freeze(global) });
}

export function runtimeLimitsSupervisorDeadlines(
	snapshot: RuntimeLimitsSnapshot,
): ExternalConnectorSupervisorDeadlineOverrides {
	const checked = validateRuntimeLimitsSnapshot(snapshot);
	if (checked === undefined) throw new TypeError("RuntimeLimits snapshot is invalid");
	return Object.freeze({
		start: Object.freeze({ hardMs: checked.values.startupHardMs, idleMs: checked.values.startupIdleMs }),
		event: Object.freeze({ hardMs: checked.values.attemptWallMs, idleMs: checked.values.attemptIdleMs }),
		receipt: Object.freeze({ hardMs: checked.values.attemptWallMs, idleMs: checked.values.attemptIdleMs }),
		cancel: Object.freeze({ hardMs: checked.values.cancelGraceMs, idleMs: checked.values.cancelIdleMs }),
		dispose: Object.freeze({ hardMs: checked.values.shutdownHardMs, idleMs: checked.values.shutdownIdleMs }),
	});
}

export function runtimeLimitsSupervisorLimits(snapshot: RuntimeLimitsSnapshot): ExternalConnectorSupervisorLimits {
	const checked = validateRuntimeLimitsSnapshot(snapshot);
	if (checked === undefined) throw new TypeError("RuntimeLimits snapshot is invalid");
	return Object.freeze({
		maxEvents: checked.values.maxEvents,
		maxEventsPerWindow: checked.values.maxEventsPerWindow,
		eventRateWindowMs: checked.values.eventRateWindowMs,
		maxItemBytes: Math.min(checked.values.maxFrameBytes, checked.values.maxEventBytes),
		maxTotalBytes: checked.values.maxOutputBytes,
		maxArtifactRefs: checked.values.maxArtifactRefs,
	});
}

export function runtimeLimitsReadinessDeadline(snapshot: RuntimeLimitsSnapshot): ExternalConnectorSegmentDeadline {
	const checked = validateRuntimeLimitsSnapshot(snapshot);
	if (checked === undefined) throw new TypeError("RuntimeLimits snapshot is invalid");
	return Object.freeze({
		hardMs: checked.values.readinessHardMs,
		idleMs: checked.values.readinessIdleMs,
	});
}

export function runtimeLimitsShutdownDeadline(snapshot: RuntimeLimitsSnapshot): ExternalConnectorSegmentDeadline {
	const checked = validateRuntimeLimitsSnapshot(snapshot);
	if (checked === undefined) throw new TypeError("RuntimeLimits snapshot is invalid");
	return Object.freeze({
		hardMs: checked.values.shutdownHardMs,
		idleMs: checked.values.shutdownIdleMs,
	});
}

export interface RuntimeLimitsOperationNonce {
	readonly snapshot: RuntimeLimitsSnapshot;
	readonly processNonce: string;
}

/** Embed the frozen values in the existing opaque durable operation nonce. */
export function encodeRuntimeLimitsOperationNonce(snapshot: RuntimeLimitsSnapshot, processNonce: string): string {
	const checked = validateRuntimeLimitsSnapshot(snapshot);
	if (checked === undefined || !isExternalConnectorMappingIdentifier(processNonce)) {
		throw new TypeError("RuntimeLimits operation nonce is invalid");
	}
	const payload = RUNTIME_LIMIT_NAMES.map((name) => checked.values[name].toString(36)).join(".");
	let boundedProcessNonce = processNonce;
	let encoded = `${RUNTIME_LIMIT_TOKEN_PREFIX}.${checked.digest.value}.${payload}.${boundedProcessNonce}`;
	if (!isExternalConnectorMappingIdentifier(encoded)) {
		boundedProcessNonce = `runtime_nonce_${fingerprintFoundationValue({ processNonce }).value.slice(0, 32)}`;
		encoded = `${RUNTIME_LIMIT_TOKEN_PREFIX}.${checked.digest.value}.${payload}.${boundedProcessNonce}`;
	}
	if (!isExternalConnectorMappingIdentifier(encoded)) {
		throw new RangeError("RuntimeLimits operation nonce exceeds the durable identifier boundary");
	}
	return encoded;
}

/** Decode and validate the durable per-Attempt limits envelope. */
export function decodeRuntimeLimitsOperationNonce(value: unknown): RuntimeLimitsOperationNonce | undefined {
	if (!isExternalConnectorMappingIdentifier(value)) return undefined;
	const parts = value.split(".");
	const digest = parts[1];
	if (
		parts[0] !== RUNTIME_LIMIT_TOKEN_PREFIX ||
		parts.length < RUNTIME_LIMIT_NAMES.length + 3 ||
		digest === undefined ||
		!RUNTIME_LIMIT_DIGEST_PATTERN.test(digest)
	)
		return undefined;
	const encodedValues = parts.slice(2, RUNTIME_LIMIT_NAMES.length + 2);
	const processNonce = parts.slice(RUNTIME_LIMIT_NAMES.length + 2).join(".");
	if (!isExternalConnectorMappingIdentifier(processNonce)) return undefined;
	const global: Record<RuntimeLimitName, number> = { ...DEFAULT_RUNTIME_LIMIT_VALUES };
	for (const [index, name] of RUNTIME_LIMIT_NAMES.entries()) {
		const encoded = encodedValues[index];
		if (encoded === undefined || !RUNTIME_LIMIT_TOKEN_VALUE_PATTERN.test(encoded)) return undefined;
		const decoded = Number.parseInt(encoded, 36);
		if (!isPositiveSafeInteger(decoded) || decoded.toString(36) !== encoded) return undefined;
		global[name] = decoded;
	}
	try {
		const snapshot = resolveRuntimeLimits({ global });
		return snapshot.digest.value === digest ? Object.freeze({ snapshot, processNonce }) : undefined;
	} catch {
		return undefined;
	}
}
