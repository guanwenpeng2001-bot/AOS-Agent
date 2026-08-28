import { describe, expect, it } from "vitest";
import {
	DEFAULT_RUNTIME_LIMITS,
	RUNTIME_LIMIT_CEILINGS,
	RUNTIME_LIMIT_NAMES,
	decodeRuntimeLimitsOperationNonce,
	encodeRuntimeLimitsOperationNonce,
	resolveRuntimeLimits,
	resolveRuntimeLimitsSource,
	validateRuntimeLimitsSnapshot,
	type RuntimeLimitsResolutionInput,
	type RuntimeLimitsSource,
} from "../src/core/runtime-limits.ts";

describe("RuntimeLimits", () => {
	it("provides finite immutable safe-integer defaults under trusted ceilings", () => {
		expect(Object.isFrozen(DEFAULT_RUNTIME_LIMITS)).toBe(true);
		expect(Object.isFrozen(DEFAULT_RUNTIME_LIMITS.values)).toBe(true);
		expect(Object.isFrozen(DEFAULT_RUNTIME_LIMITS.digest)).toBe(true);
		for (const name of RUNTIME_LIMIT_NAMES) {
			const value = DEFAULT_RUNTIME_LIMITS.values[name];
			expect(Number.isFinite(value), name).toBe(true);
			expect(Number.isSafeInteger(value), name).toBe(true);
			expect(value, name).toBeGreaterThan(0);
			expect(value, name).toBeLessThanOrEqual(RUNTIME_LIMIT_CEILINGS[name]);
		}
	});

	it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
		"rejects invalid or unbounded global values (%s)",
		(value) => {
			expect(() => resolveRuntimeLimits({ global: { attemptWallMs: value } })).toThrow();
		},
	);

	it("enforces the global ceiling and managed/project/Role no-widen chain", () => {
		const ceiling = resolveRuntimeLimits({ global: { maxConcurrency: RUNTIME_LIMIT_CEILINGS.maxConcurrency } });
		expect(ceiling.values.maxConcurrency).toBe(RUNTIME_LIMIT_CEILINGS.maxConcurrency);
		expect(() =>
			resolveRuntimeLimits({ global: { maxConcurrency: RUNTIME_LIMIT_CEILINGS.maxConcurrency + 1 } }),
		).toThrow();

		const tightened = resolveRuntimeLimits({
			global: { maxConcurrency: 32, maxBacklog: 512 },
			managed: { maxConcurrency: 16, maxBacklog: 256 },
			project: { maxConcurrency: 8, maxBacklog: 128 },
			role: { maxConcurrency: 4, maxBacklog: 64 },
		});
		expect(tightened.values).toMatchObject({ maxConcurrency: 4, maxBacklog: 64 });
		expect(() =>
			resolveRuntimeLimits({ global: { maxConcurrency: 8 }, project: { maxConcurrency: 9 } }),
		).toThrow();
		expect(() =>
			resolveRuntimeLimits({ global: { maxBacklog: 8 }, role: { maxBacklog: 9 } }),
		).toThrow();
	});

	it("has a stable canonical digest independent of override key order", () => {
		const left = resolveRuntimeLimits({ global: { maxEvents: 100, attemptWallMs: 5_000 } });
		const right = resolveRuntimeLimits({ global: { attemptWallMs: 5_000, maxEvents: 100 } });
		const changed = resolveRuntimeLimits({ global: { attemptWallMs: 5_001, maxEvents: 100 } });

		expect(left.digest).toEqual(right.digest);
		expect(left.digest).not.toEqual(changed.digest);
		expect(validateRuntimeLimitsSnapshot(left)).toEqual(left);
		expect(validateRuntimeLimitsSnapshot({ ...left, digest: { ...left.digest, value: "0".repeat(64) } })).toBeUndefined();
		expect(() =>
			resolveRuntimeLimits({ unexpected: {} } as unknown as RuntimeLimitsResolutionInput),
		).toThrow();
	});

	it("round-trips the exact frozen snapshot and rejects a changed durable digest", () => {
		const snapshot = resolveRuntimeLimits({ global: { attemptIdleMs: 2_500, maxOutputBytes: 1_000_000 } });
		const encoded = encodeRuntimeLimitsOperationNonce(snapshot, "attempt-process-nonce");
		const decoded = decodeRuntimeLimitsOperationNonce(encoded);
		expect(decoded).toEqual({ snapshot, processNonce: "attempt-process-nonce" });
		expect(Object.isFrozen(decoded)).toBe(true);

		const parts = encoded.split(".");
		parts[1] = "0".repeat(64);
		expect(decodeRuntimeLimitsOperationNonce(parts.join("."))).toBeUndefined();

		const bounded = encodeRuntimeLimitsOperationNonce(
			resolveRuntimeLimits({ global: RUNTIME_LIMIT_CEILINGS }),
			"n".repeat(256),
		);
		expect(bounded.length).toBeLessThanOrEqual(256);
		expect(decodeRuntimeLimitsOperationNonce(bounded)?.processNonce).toMatch(/^runtime_nonce_[a-f0-9]{32}$/u);
	});

	it("samples concurrent reloads as complete old-or-new immutable snapshots", async () => {
		const oldInput = Object.freeze({ global: Object.freeze({ attemptWallMs: 10_000, maxEvents: 10 }) });
		const newInput = Object.freeze({ global: Object.freeze({ attemptWallMs: 20_000, maxEvents: 20 }) });
		let reads = 0;
		const source: RuntimeLimitsSource = () => {
			reads += 1;
			return reads <= 32 ? oldInput : newInput;
		};
		const snapshots = await Promise.all(
			Array.from({ length: 64 }, async () => resolveRuntimeLimitsSource(source)),
		);
		const oldDigest = resolveRuntimeLimits(oldInput).digest.value;
		const newDigest = resolveRuntimeLimits(newInput).digest.value;

		expect(snapshots.filter((snapshot) => snapshot.digest.value === oldDigest)).toHaveLength(32);
		expect(snapshots.filter((snapshot) => snapshot.digest.value === newDigest)).toHaveLength(32);
		expect(snapshots.every((snapshot) => Object.isFrozen(snapshot) && Object.isFrozen(snapshot.values))).toBe(true);
		expect(
			snapshots.every(
				(snapshot) =>
					(snapshot.values.attemptWallMs === 10_000 && snapshot.values.maxEvents === 10) ||
					(snapshot.values.attemptWallMs === 20_000 && snapshot.values.maxEvents === 20),
			),
		).toBe(true);
	});

	it("keeps deterministic resolution and durable codec state on a bounded plateau", () => {
		const inputs = [
			Object.freeze({ global: Object.freeze({ maxEvents: 7, maxBacklog: 3 }) }),
			Object.freeze({ global: Object.freeze({ maxEvents: 9, maxBacklog: 5 }) }),
		] as const;
		const digests = new Set<string>();
		const envelopes = new Set<string>();
		for (let index = 0; index < 2_000; index += 1) {
			const snapshot = resolveRuntimeLimits(inputs[index % inputs.length]);
			const envelope = encodeRuntimeLimitsOperationNonce(snapshot, "soak-process-nonce");
			const decoded = decodeRuntimeLimitsOperationNonce(envelope);
			expect(decoded?.snapshot.digest).toEqual(snapshot.digest);
			digests.add(snapshot.digest.value);
			envelopes.add(envelope);
			expect(digests.size).toBeLessThanOrEqual(inputs.length);
			expect(envelopes.size).toBeLessThanOrEqual(inputs.length);
		}
		expect(digests.size).toBe(inputs.length);
		expect(envelopes.size).toBe(inputs.length);
	});
});
