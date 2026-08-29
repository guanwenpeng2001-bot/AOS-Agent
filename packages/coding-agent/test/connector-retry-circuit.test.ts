import {
	InMemorySessionStorage,
	type PublicExecutionError,
	Session,
	SessionLedger,
} from "@aos-agent/agent-core";
import { describe, expect, it } from "vitest";
import {
	ConnectorRetryCircuit,
	DEFAULT_CONNECTOR_RETRY_POLICY,
	type ConnectorRetryFailureInput,
	type ConnectorRetryPolicy,
} from "../src/core/connector-retry-circuit.ts";
import { withRuntimeClock } from "../src/core/runtime-clock.ts";
import { DeterministicClock } from "./support/deterministic-clock.ts";

const START_MS = Date.parse("2026-08-28T00:00:00.000Z");

function policy(overrides: Partial<ConnectorRetryPolicy> = {}): ConnectorRetryPolicy {
	return { ...DEFAULT_CONNECTOR_RETRY_POLICY, ...overrides };
}

function retryableError(
	code = "external_connector_unavailable",
	category: PublicExecutionError["category"] = "transient",
): PublicExecutionError {
	return { code, message: "Injected safe connector failure", category, retryable: true };
}

function retryInput(
	operationId: string,
	overrides: Partial<ConnectorRetryFailureInput> = {},
): ConnectorRetryFailureInput {
	return {
		operationId,
		targetId: "connector_target_a",
		attemptCount: 1,
		guarantee: "idempotent",
		sideEffectState: "none",
		error: retryableError(),
		...overrides,
	};
}

function createHarness(retryPolicy: ConnectorRetryPolicy = policy()) {
	const clock = new DeterministicClock({ wallTimeMs: START_MS, monotonicTimeMs: 0 });
	const session = new Session(new InMemorySessionStorage({ id: "session_connector_retry", createdAt: 1 }));
	const ledger = new SessionLedger(session, { ownerId: "connector_retry_owner" });
	const circuit = new ConnectorRetryCircuit(
		withRuntimeClock(
			{ ledger, taskId: "task_connector_retry", policy: retryPolicy },
			clock,
		),
	);
	return { circuit, clock, ledger, session };
}

describe("durable connector retry eligibility", () => {
	it("fails closed for every non-eligible operation and outcome", async () => {
		const harness = createHarness();
		const cases: readonly {
			readonly operationId: string;
			readonly overrides: Partial<ConnectorRetryFailureInput>;
			readonly reason: string;
		}[] = [
			{
				operationId: "missing-guarantee",
				overrides: { guarantee: undefined },
				reason: "missing_operation_eligibility",
			},
			{
				operationId: "unknown-side-effect",
				overrides: { sideEffectState: "side_effect_unknown" },
				reason: "side_effect_unknown",
			},
			{
				operationId: "exact-policy-rejection",
				overrides: { error: retryableError("external_review_rejected", "permission") },
				reason: "ineligible_error",
			},
			{
				operationId: "credential-denial",
				overrides: { error: retryableError("external_credential_unavailable") },
				reason: "ineligible_error",
			},
			{
				operationId: "stale-binding",
				overrides: { error: retryableError("external_binding_invalid") },
				reason: "ineligible_error",
			},
			{
				operationId: "stale-selection",
				overrides: { error: retryableError("scheduler_dispatch_invalid") },
				reason: "ineligible_error",
			},
			{
				operationId: "cancellation",
				overrides: { error: retryableError("cancelled", "cancelled") },
				reason: "ineligible_error",
			},
			{
				operationId: "user-abort",
				overrides: { error: retryableError("user_abort") },
				reason: "ineligible_error",
			},
			{
				operationId: "error-not-retryable",
				overrides: { error: { ...retryableError(), retryable: false } },
				reason: "missing_error_eligibility",
			},
		];

		for (const testCase of cases) {
			const result = await harness.circuit.recordFailure(retryInput(testCase.operationId, testCase.overrides));
			expect(result.ok, testCase.operationId).toBe(true);
			if (!result.ok) throw result.error;
			expect(result.value.decision, testCase.operationId).toBe("stop");
			expect(result.value.reasonCode, testCase.operationId).toBe(testCase.reason);
		}

		const untouched = await harness.circuit.snapshot("connector_target_a");
		expect(untouched.ok).toBe(true);
		if (!untouched.ok) throw untouched.error;
		expect(untouched.value).toBeUndefined();
		await harness.ledger.release();
	});

	it("admits explicitly idempotent and resumable retryable failures", async () => {
		const harness = createHarness(policy({ failureThreshold: 4 }));
		for (const guarantee of ["idempotent", "resumable"] as const) {
			const result = await harness.circuit.recordFailure(
				retryInput(`eligible-${guarantee}`, { guarantee }),
			);
			expect(result.ok).toBe(true);
			if (!result.ok) throw result.error;
			expect(result.value).toMatchObject({
				decision: "retry",
				reasonCode: "eligible",
				guarantee,
				attemptCount: 1,
				targetId: "connector_target_a",
			});
		}
		await harness.ledger.release();
	});
});

describe("bounded durable connector retry timing", () => {
	it("persists deterministic bounded exponential backoff and replays it without widening", async () => {
		const retryPolicy = policy({
			maxAttempts: 4,
			baseDelayMs: 100,
			maxDelayMs: 400,
			totalRetryTimeMs: 2_000,
			jitterPermille: 250,
			failureThreshold: 4,
			openDurationMs: 400,
			halfOpenProbeTimeoutMs: 200,
		});
		const harness = createHarness(retryPolicy);
		const first = await harness.circuit.recordFailure(retryInput("durable-backoff"));
		expect(first.ok).toBe(true);
		if (!first.ok) throw first.error;
		expect(first.value.decision).toBe("retry");
		expect(first.value.exponentialDelayMs).toBe(100);
		expect(first.value.delayMs).toBeGreaterThanOrEqual(75);
		expect(first.value.delayMs).toBeLessThanOrEqual(125);
		expect(first.value.jitterSeed).toEqual(expect.any(String));
		expect(first.value.jitterMs).toBeDefined();
		expect(first.value.nextEligibleAt).toEqual(expect.any(String));

		const reopened = new ConnectorRetryCircuit(
			withRuntimeClock(
				{
					ledger: harness.ledger,
					taskId: "task_connector_retry",
					policy: policy({
						maxAttempts: 8,
						baseDelayMs: 10,
						maxDelayMs: 5_000,
						totalRetryTimeMs: 20_000,
						failureThreshold: 8,
						openDurationMs: 5_000,
						halfOpenProbeTimeoutMs: 5_000,
					}),
				},
				harness.clock,
			),
		);
		const replayed = await reopened.recordFailure(retryInput("durable-backoff"));
		expect(replayed.ok).toBe(true);
		if (!replayed.ok) throw replayed.error;
		expect(replayed.value).toEqual(first.value);
		expect(replayed.value.policy).toEqual(retryPolicy);

		harness.clock.advanceBy(first.value.delayMs ?? 0);
		const second = await reopened.recordFailure(retryInput("durable-backoff", { attemptCount: 2 }));
		expect(second.ok).toBe(true);
		if (!second.ok) throw second.error;
		expect(second.value.exponentialDelayMs).toBe(200);
		expect(second.value.delayMs).toBeLessThanOrEqual(retryPolicy.maxDelayMs);
		expect(second.value.retryStartedAt).toBe(first.value.retryStartedAt);
		expect(second.value.retryDeadlineAt).toBe(first.value.retryDeadlineAt);
		await harness.ledger.release();
	});

	it("honors the exact time boundary and then exhausts the total retry budget", async () => {
		const harness = createHarness(
			policy({
				maxAttempts: 3,
				baseDelayMs: 800,
				maxDelayMs: 800,
				totalRetryTimeMs: 1_000,
				jitterPermille: 0,
				failureThreshold: 3,
				openDurationMs: 800,
				halfOpenProbeTimeoutMs: 800,
			}),
		);
		const boundary = await harness.circuit.recordFailure(retryInput("budget-boundary"));
		expect(boundary.ok).toBe(true);
		if (!boundary.ok) throw boundary.error;
		expect(boundary.value).toMatchObject({ decision: "retry", delayMs: 800, remainingRetryTimeMs: 200 });

		harness.clock.advanceBy(800);
		const exhausted = await harness.circuit.recordFailure(
			retryInput("budget-boundary", { attemptCount: 2 }),
		);
		expect(exhausted.ok).toBe(true);
		if (!exhausted.ok) throw exhausted.error;
		expect(exhausted.value).toMatchObject({
			decision: "stop",
			reasonCode: "retry_time_budget_exhausted",
			remainingRetryTimeMs: 200,
		});
		await harness.ledger.release();
	});

	it("stops at the finite maximum attempt count", async () => {
		const harness = createHarness(
			policy({ maxAttempts: 2, failureThreshold: 2, jitterPermille: 0 }),
		);
		const first = await harness.circuit.recordFailure(retryInput("max-attempts"));
		expect(first.ok).toBe(true);
		if (!first.ok) throw first.error;
		harness.clock.advanceBy(first.value.delayMs ?? 0);
		const terminal = await harness.circuit.recordFailure(retryInput("max-attempts", { attemptCount: 2 }));
		expect(terminal.ok).toBe(true);
		if (!terminal.ok) throw terminal.error;
		expect(terminal.value).toMatchObject({ decision: "stop", reasonCode: "max_attempts_exhausted" });
		await harness.ledger.release();
	});
});

describe("durable per-target connector circuit", () => {
	const circuitPolicy = policy({
		maxAttempts: 3,
		baseDelayMs: 10,
		maxDelayMs: 100,
		totalRetryTimeMs: 1_000,
		jitterPermille: 0,
		failureThreshold: 1,
		openDurationMs: 100,
		halfOpenProbeTimeoutMs: 50,
	});

	it("serializes one bounded half-open probe across concurrent callers and restart", async () => {
		const harness = createHarness(circuitPolicy);
		const opened = await harness.circuit.recordFailure(retryInput("open-circuit"));
		expect(opened.ok).toBe(true);
		if (!opened.ok) throw opened.error;
		expect(opened.value).toMatchObject({ circuitState: "open", circuitTransition: "closed_to_open" });

		const early = await harness.circuit.admit("connector_target_a", "early-probe");
		expect(early.ok).toBe(false);
		if (early.ok) throw new Error("Open circuit admitted an early probe");
		expect(early.error.code).toBe("external_connector_circuit_open");
		const otherTarget = await harness.circuit.admit("connector_target_b", "unrelated-target-operation");
		expect(otherTarget.ok).toBe(true);

		harness.clock.advanceBy(100);
		const restarted = new ConnectorRetryCircuit(
			withRuntimeClock(
				{ ledger: harness.ledger, taskId: "task_connector_retry", policy: circuitPolicy },
				harness.clock,
			),
		);
		const contenders = await Promise.all([
			harness.circuit.admit("connector_target_a", "probe-a"),
			restarted.admit("connector_target_a", "probe-b"),
		]);
		expect(contenders.filter((result) => result.ok)).toHaveLength(1);
		expect(contenders.filter((result) => !result.ok)).toHaveLength(1);
		const winner = contenders[0]?.ok ? "probe-a" : "probe-b";
		const replayedProbe = await restarted.admit("connector_target_a", winner);
		expect(replayedProbe.ok).toBe(true);
		if (!replayedProbe.ok) throw replayedProbe.error;
		expect(replayedProbe.value).toMatchObject({ state: "half_open", probe: true });

		const probeFailure = await restarted.recordFailure(
			retryInput(winner, { attemptCount: 2 }),
		);
		expect(probeFailure.ok).toBe(true);
		if (!probeFailure.ok) throw probeFailure.error;
		expect(probeFailure.value).toMatchObject({ circuitState: "open", circuitTransition: "half_open_to_open" });

		harness.clock.advanceBy(100);
		const nextProbe = await restarted.admit("connector_target_a", "successful-probe");
		expect(nextProbe.ok).toBe(true);
		const closed = await restarted.recordSuccess("connector_target_a", "successful-probe");
		expect(closed.ok).toBe(true);
		if (!closed.ok) throw closed.error;
		expect(closed.value).toMatchObject({ state: "closed", failureCount: 0, transition: "half_open_to_closed" });
		await harness.ledger.release();
	});

	it("expires an abandoned half-open probe within its persisted bound", async () => {
		const harness = createHarness(circuitPolicy);
		const opened = await harness.circuit.recordFailure(retryInput("abandoned-seed"));
		if (!opened.ok) throw opened.error;
		harness.clock.advanceBy(100);
		const probe = await harness.circuit.admit("connector_target_a", "abandoned-probe");
		expect(probe.ok).toBe(true);
		harness.clock.advanceBy(50);
		const lateSuccess = await harness.circuit.recordSuccess("connector_target_a", "abandoned-probe");
		expect(lateSuccess.ok).toBe(true);
		if (!lateSuccess.ok) throw lateSuccess.error;
		expect(lateSuccess.value).toMatchObject({ state: "open", transition: "half_open_expired" });
		const rejected = await harness.circuit.admit("connector_target_a", "replacement-probe");
		expect(rejected.ok).toBe(false);
		const snapshot = await harness.circuit.snapshot("connector_target_a");
		expect(snapshot.ok).toBe(true);
		if (!snapshot.ok) throw snapshot.error;
		expect(snapshot.value).toMatchObject({ state: "open", transition: "half_open_expired" });
		await harness.ledger.release();
	});

	it("persists an idempotent audited operator reset", async () => {
		const harness = createHarness(circuitPolicy);
		const opened = await harness.circuit.recordFailure(retryInput("reset-seed"));
		if (!opened.ok) throw opened.error;
		const request = {
			resetId: "reset-001",
			targetId: "connector_target_a",
			operatorId: "operator-local",
			reasonCode: "operator_confirmed_recovery",
		} as const;
		const first = await harness.circuit.reset(request);
		const replay = await harness.circuit.reset(request);
		expect(first.ok).toBe(true);
		expect(replay.ok).toBe(true);
		if (!first.ok) throw first.error;
		if (!replay.ok) throw replay.error;
		expect(replay.value).toEqual(first.value);
		expect(first.value).toMatchObject({ state: "closed", transition: "operator_reset", lastResetId: "reset-001" });
		const audit = await harness.circuit.resetAudit("reset-001");
		expect(audit.ok).toBe(true);
		if (!audit.ok) throw audit.error;
		expect(audit.value).toMatchObject({
			resetId: "reset-001",
			targetId: "connector_target_a",
			operatorId: "operator-local",
			observedState: "open",
		});
		await harness.ledger.release();
	});
});
