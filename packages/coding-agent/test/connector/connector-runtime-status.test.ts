import {
	FoundationError,
	Result,
	createConnectorCapabilitySnapshot,
	type ConnectorCapabilitySnapshot,
	type ExternalAgentConnector,
} from "../../../agent/src/internal.ts";
import { describe, expect, it } from "vitest";
import {
	CONNECTOR_RUNTIME_LATENCY_BUCKET_BOUNDS_MS,
	CONNECTOR_RUNTIME_STATUS_MAX_COUNT,
	createConnectorRuntimeAggregateSnapshot,
	projectConnectorRuntimeStatus,
	type ConnectorRuntimeAggregateSnapshot,
	type ConnectorRuntimeAggregateSnapshotInput,
} from "../../src/core/connector/runtime-status.ts";
import {
	DEFAULT_CONNECTOR_RETRY_POLICY,
	type ConnectorCircuitFact,
} from "../../src/core/connector/retry-circuit.ts";
import {
	createDescriptorExternalConnectorActivationSource,
	createExternalConnectorReadinessSnapshot,
} from "../../src/core/connector/readiness.ts";
import { createExternalConnectorRegistry } from "../../src/core/connector/registry.ts";
import { DEFAULT_RUNTIME_LIMITS } from "../../src/core/runtime/limits.ts";
import { DeterministicClock } from "../support/deterministic-clock.ts";

const NOW_MS = Date.parse("2026-08-28T00:00:00.000Z");
const PROVIDER_ID = "connector.provider-a";
const TARGET_ID = "connector.target-a";

function capability(providerId = PROVIDER_ID): ConnectorCapabilitySnapshot {
	return createConnectorCapabilitySnapshot({
		schemaVersion: 1,
		providerId,
		revision: 4,
		protocol: { name: "fixture", version: "1" },
		modelAccess: "agent_owned",
		resume: true,
		toolGateway: false,
		artifacts: false,
		images: false,
	});
}

function readiness(
	status: "ready" | "not_ready" | "quarantined" = "ready",
	options: { readonly observedAtMs?: number; readonly ttlMs?: number; readonly providerId?: string } = {},
) {
	const snapshot = capability(options.providerId);
	const source = createDescriptorExternalConnectorActivationSource({
		providerId: snapshot.providerId,
		revision: snapshot.revision,
		capabilityDigest: snapshot.digest,
	});
	return createExternalConnectorReadinessSnapshot({
		source,
		status,
		reasonCode:
			status === "ready" ? "ready" : status === "quarantined" ? "source_changed" : "probe_failed",
		state: status === "quarantined" ? "quarantined" : "current",
		observedAtMs: options.observedAtMs ?? NOW_MS,
		ttlMs: options.ttlMs ?? 60_000,
	});
}

function circuit(
	state: "closed" | "open" | "half_open",
	targetId = TARGET_ID,
): ConnectorCircuitFact {
	const common = {
		schemaVersion: 1 as const,
		targetId,
		state,
		failureCount: state === "closed" ? 0 : 3,
		updatedAt: new Date(NOW_MS).toISOString(),
		transition:
			state === "closed" ? "success_recorded" as const : state === "open" ? "closed_to_open" as const : "open_to_half_open" as const,
		policy: DEFAULT_CONNECTOR_RETRY_POLICY,
		lastFailureCode: "external_connector_unavailable",
		lastFailureOperationId: "operation-high-cardinality-not-public",
		lastFailureAttemptCount: 3,
	};
	if (state === "open") {
		return { ...common, nextProbeAt: new Date(NOW_MS + 30_000).toISOString() };
	}
	if (state === "half_open") {
		return {
			...common,
			probeOperationId: "bounded-probe-operation",
			probeExpiresAt: new Date(NOW_MS + 15_000).toISOString(),
		};
	}
	return common;
}

function cumulativeCounts(finalCount: number): readonly number[] {
	return CONNECTOR_RUNTIME_LATENCY_BUCKET_BOUNDS_MS.map((_, index) =>
		Math.min(finalCount, index),
	);
}

function aggregateInput(
	overrides: Partial<ConnectorRuntimeAggregateSnapshotInput> = {},
): ConnectorRuntimeAggregateSnapshotInput {
	return {
		providerId: PROVIDER_ID,
		targetId: TARGET_ID,
		observedAtMs: NOW_MS,
		ttlMs: 120_000,
		circuit: circuit("closed"),
		limits: DEFAULT_RUNTIME_LIMITS,
		activity: { active: 3, queued: 5, reconcile: 2 },
		counters: {
			startTotal: 101,
			resumeTotal: 23,
			cancelTotal: 17,
			forcedKillTotal: 4,
			limitRejectTotal: 11,
			frameRejectTotal: 7,
			eventDropTotal: 13,
		},
		latency: {
			cancelMs: { counts: cumulativeCounts(8), overflowCount: 1 },
			shutdownMs: { counts: cumulativeCounts(6), overflowCount: 2 },
		},
		...overrides,
	};
}

function aggregate(
	overrides: Partial<ConnectorRuntimeAggregateSnapshotInput> = {},
): ConnectorRuntimeAggregateSnapshot {
	return createConnectorRuntimeAggregateSnapshot(aggregateInput(overrides));
}

function project(options: {
	readonly readinessSnapshot?: unknown;
	readonly runtimeSnapshot?: unknown;
	readonly nowMs?: number;
	readonly providerId?: string;
} = {}) {
	return projectConnectorRuntimeStatus({
		providerId: options.providerId ?? PROVIDER_ID,
		readinessSnapshot: Object.hasOwn(options, "readinessSnapshot")
			? options.readinessSnapshot
			: readiness(),
		runtimeSnapshot: Object.hasOwn(options, "runtimeSnapshot")
			? options.runtimeSnapshot
			: aggregate(),
		nowMs: options.nowMs ?? NOW_MS,
	});
}

class PassiveConnector implements ExternalAgentConnector {
	readonly schemaVersion = 1 as const;
	readonly providerClass = "external_connector" as const;
	readonly providerId: string;
	readonly snapshot: ConnectorCapabilitySnapshot;
	probeCalls = 0;
	createCalls = 0;
	runCalls = 0;
	cancelCalls = 0;
	resumeCalls = 0;
	reconcileCalls = 0;
	disposeCalls = 0;

	constructor(providerId = PROVIDER_ID) {
		this.providerId = providerId;
		this.snapshot = capability(providerId);
	}

	async capabilities() {
		return [];
	}
	async probeCapabilities() {
		this.probeCalls += 1;
		return Result.ok(this.snapshot);
	}
	async createAttempt() {
		this.createCalls += 1;
		return Result.err(new FoundationError("unsupported_feature", "not used"));
	}
	async runAttempt() {
		this.runCalls += 1;
		return Result.err(new FoundationError("unsupported_feature", "not used"));
	}
	async cancelAttempt() {
		this.cancelCalls += 1;
		return Result.err(new FoundationError("unsupported_feature", "not used"));
	}
	async resumeAttempt() {
		this.resumeCalls += 1;
		return Result.err(new FoundationError("unsupported_feature", "not used"));
	}
	async reconcileAttempt() {
		this.reconcileCalls += 1;
		return Result.err(new FoundationError("unsupported_feature", "not used"));
	}
	async dispose() {
		this.disposeCalls += 1;
	}
}

describe("ConnectorRuntimeStatus", () => {
	it.each([
		{ readinessStatus: "ready", expectedState: "ready", expectedReason: "ready" },
		{ readinessStatus: "quarantined", expectedState: "quarantined", expectedReason: "source_changed" },
	] as const)(
		"projects $readinessStatus readiness without changing the trusted state",
		({ readinessStatus, expectedState, expectedReason }) => {
			const status = project({ readinessSnapshot: readiness(readinessStatus) });
			expect(status).toMatchObject({
				availability: "available",
				providerId: PROVIDER_ID,
				targetId: TARGET_ID,
				readiness: {
					state: expectedState,
					reasonCode: expectedReason,
					observedAgeMs: 0,
					expiresInMs: 60_000,
				},
			});
		},
	);

	it("fails expired ready readiness closed to a stable stale reason", () => {
		const status = project({
			readinessSnapshot: readiness("ready", { ttlMs: 1_000 }),
			nowMs: NOW_MS + 1_001,
		});
		expect(status).toMatchObject({
			availability: "available",
			readiness: {
				state: "stale",
				reasonCode: "snapshot_stale",
				observedAgeMs: 1_001,
				expiresInMs: 0,
			},
		});
	});

	it.each([
		{ state: "closed", nextTransition: "none", transitionInMs: undefined },
		{ state: "open", nextTransition: "half_open", transitionInMs: 30_000 },
		{ state: "half_open", nextTransition: "open", transitionInMs: 15_000 },
	] as const)("projects the $state circuit and its next transition", (expected) => {
		const status = project({ runtimeSnapshot: aggregate({ circuit: circuit(expected.state) }) });
		expect(status.availability).toBe("available");
		if (status.availability !== "available") return;
		expect(status.circuit).toEqual({
			state: expected.state,
			nextTransition: expected.nextTransition,
			...(expected.transitionInMs === undefined ? {} : { transitionInMs: expected.transitionInMs }),
		});
	});

	it("projects exact activity, bounded counters, RuntimeLimits, and fixed finite latency buckets", () => {
		const status = project();
		expect(status.availability).toBe("available");
		if (status.availability !== "available") return;
		expect(status.activity).toEqual({ active: 3, queued: 5, reconcile: 2 });
		expect(status.counters).toEqual({
			startTotal: 101,
			resumeTotal: 23,
			cancelTotal: 17,
			forcedKillTotal: 4,
			limitRejectTotal: 11,
			frameRejectTotal: 7,
			eventDropTotal: 13,
		});
		expect(status.limits).toEqual(DEFAULT_RUNTIME_LIMITS);
		for (const histogram of [status.latency.cancelMs, status.latency.shutdownMs]) {
			expect(histogram.boundsMs).toEqual(CONNECTOR_RUNTIME_LATENCY_BUCKET_BOUNDS_MS);
			expect(histogram.counts).toHaveLength(CONNECTOR_RUNTIME_LATENCY_BUCKET_BOUNDS_MS.length);
			expect(histogram.boundsMs.every(Number.isFinite)).toBe(true);
			expect(histogram.counts.every(Number.isFinite)).toBe(true);
			expect(Number.isFinite(histogram.overflowCount)).toBe(true);
		}
	});

	it("rejects malformed and overflow aggregates without fabricating zero metrics", () => {
		expect(() =>
			aggregate({ activity: { active: CONNECTOR_RUNTIME_STATUS_MAX_COUNT + 1, queued: 0, reconcile: 0 } }),
		).toThrow("Connector runtime aggregate snapshot is invalid");
		expect(() =>
			aggregate({
				latency: {
					cancelMs: { counts: [Number.NaN], overflowCount: 0 },
					shutdownMs: { counts: cumulativeCounts(1), overflowCount: 0 },
				},
			}),
		).toThrow("Connector runtime aggregate snapshot is invalid");

		const malformed = { ...aggregate(), rawError: "raw-runtime-error-canary" };
		const status = project({ runtimeSnapshot: malformed });
		expect(status).toMatchObject({
			availability: "unavailable",
			reasonCode: "status_snapshot_malformed",
		});
		expect("activity" in status).toBe(false);
		expect("counters" in status).toBe(false);
		expect("latency" in status).toBe(false);
		expect(JSON.stringify(status)).not.toContain("raw-runtime-error-canary");

		const hostile = new Proxy({}, {
			ownKeys() {
				throw new Error("hostile-runtime-source-canary");
			},
		});
		const hostileStatus = project({ runtimeSnapshot: hostile });
		expect(hostileStatus).toMatchObject({
			availability: "unavailable",
			reasonCode: "status_snapshot_malformed",
		});
		expect(JSON.stringify(hostileStatus)).not.toContain("hostile-runtime-source-canary");
	});

	it("fails missing, stale, mismatched, and malformed sources to safe codes", () => {
		const cases = [
			{
				status: project({ runtimeSnapshot: undefined }),
				reasonCode: "status_source_missing",
			},
			{
				status: project({
					runtimeSnapshot: aggregate({ ttlMs: 1 }),
					nowMs: NOW_MS + 1,
				}),
				reasonCode: "status_snapshot_stale",
			},
			{
				status: project({
					runtimeSnapshot: aggregate({ providerId: "connector.provider-b" }),
				}),
				reasonCode: "status_identity_mismatch",
			},
			{
				status: project({ readinessSnapshot: { rawError: "readiness-canary" } }),
				reasonCode: "status_snapshot_malformed",
			},
			{
				status: project({ nowMs: Number.POSITIVE_INFINITY }),
				reasonCode: "status_clock_invalid",
			},
		] as const;
		for (const testCase of cases) {
			expect(testCase.status).toMatchObject({
				availability: "unavailable",
				reasonCode: testCase.reasonCode,
			});
			expect("counters" in testCase.status).toBe(false);
		}
	});

	it("replays the same immutable projection after serialized restart", () => {
		const readinessSnapshot = readiness();
		const runtimeSnapshot = aggregate({ circuit: circuit("open") });
		const first = project({ readinessSnapshot, runtimeSnapshot, nowMs: NOW_MS + 500 });
		const replay = project({
			readinessSnapshot: JSON.parse(JSON.stringify(readinessSnapshot)) as unknown,
			runtimeSnapshot: JSON.parse(JSON.stringify(runtimeSnapshot)) as unknown,
			nowMs: NOW_MS + 500,
		});
		expect(replay).toEqual(first);
		expect(Object.isFrozen(first)).toBe(true);
		expect(Object.isFrozen(first.readiness)).toBe(true);
		if (first.availability !== "available") throw new Error("fixture status unavailable");
		expect(Object.isFrozen(first.activity)).toBe(true);
		expect(Object.isFrozen(first.counters)).toBe(true);
		expect(Object.isFrozen(first.latency.cancelMs.counts)).toBe(true);
		expect(Object.isFrozen(first.limits.values)).toBe(true);
		expect(Reflect.set(first.activity, "active", 999)).toBe(false);
	});

	it("does not expose raw errors, commands, paths, environment, endpoints, credentials, or vendor data", () => {
		const forbidden = [
			"vendor-error-canary",
			"run --credential secret-canary",
			"C:\\private\\connector\\config.json",
			"TOKEN=secret-canary",
			"https://user:password@vendor.invalid/api",
			"sk-secret-canary",
			"vendor-payload-canary",
		];
		const poisoned = {
			...aggregate(),
			rawError: forbidden[0],
			command: forbidden[1],
			path: forbidden[2],
			environment: forbidden[3],
			endpoint: forbidden[4],
			token: forbidden[5],
			vendorPayload: forbidden[6],
		};
		const serialized = JSON.stringify(project({ runtimeSnapshot: poisoned }));
		for (const value of forbidden) expect(serialized).not.toContain(value);
	});

	it("keeps registry reads passive and reports an absent aggregate without zero metrics", async () => {
		const clock = new DeterministicClock({ wallTimeMs: NOW_MS });
		const connector = new PassiveConnector();
		const runtimeSnapshot = aggregate();
		let sourceReads = 0;
		let sourceThrows = false;
		const registry = createExternalConnectorRegistry({
			clock,
			runtimeStatusSource: {
				read(providerId) {
					sourceReads += 1;
					if (sourceThrows) throw new Error("runtime-source-secret-canary");
					return providerId === PROVIDER_ID ? runtimeSnapshot : undefined;
				},
			},
		});
		expect(
			registry.registerPrepared(
				{
					descriptor: {
						schemaVersion: 1,
						providerId: connector.providerId,
						providerClass: "external_connector",
						revision: connector.snapshot.revision,
						capabilitySnapshotDigest: connector.snapshot.digest,
					},
					connector,
				},
				connector.snapshot,
			),
		).toMatchObject({ ok: true });

		expect(registry.runtimeStatus()).toMatchObject([{ availability: "available" }]);
		expect(registry.runtimeStatus()).toMatchObject([{ availability: "available" }]);
		sourceThrows = true;
		const failedSourceStatus = registry.runtimeStatus();
		expect(failedSourceStatus).toMatchObject([{
			availability: "unavailable",
			reasonCode: "status_snapshot_malformed",
		}]);
		expect(JSON.stringify(failedSourceStatus)).not.toContain("runtime-source-secret-canary");
		expect(sourceReads).toBe(3);
		expect(clock.pendingCount()).toBe(0);
		expect([
			connector.probeCalls,
			connector.createCalls,
			connector.runCalls,
			connector.cancelCalls,
			connector.resumeCalls,
			connector.reconcileCalls,
		]).toEqual([0, 0, 0, 0, 0, 0]);

		const missingRegistry = createExternalConnectorRegistry({ clock });
		const missingConnector = new PassiveConnector("connector.provider-missing");
		expect(
			missingRegistry.registerPrepared(
				{
					descriptor: {
						schemaVersion: 1,
						providerId: missingConnector.providerId,
						providerClass: "external_connector",
						revision: missingConnector.snapshot.revision,
						capabilitySnapshotDigest: missingConnector.snapshot.digest,
					},
					connector: missingConnector,
				},
				missingConnector.snapshot,
			),
		).toMatchObject({ ok: true });
		const [missing] = missingRegistry.runtimeStatus();
		expect(missing).toMatchObject({ availability: "unavailable", reasonCode: "status_source_missing" });
		expect(missing === undefined || "counters" in missing).toBe(false);

		await registry.dispose();
		await missingRegistry.dispose();
	});

	it("holds a deterministic repeated-read plateau without timers or label growth", () => {
		const readinessSnapshot = readiness();
		const runtimeSnapshot = aggregate({ circuit: circuit("half_open") });
		const serialized = new Set<string>();
		for (let index = 0; index < 2_000; index += 1) {
			serialized.add(JSON.stringify(project({ readinessSnapshot, runtimeSnapshot, nowMs: NOW_MS + 100 })));
		}
		expect(serialized.size).toBe(1);
		expect(runtimeSnapshot.activity).toEqual({ active: 3, queued: 5, reconcile: 2 });
		expect(runtimeSnapshot.counters.startTotal).toBe(101);
	});
});
