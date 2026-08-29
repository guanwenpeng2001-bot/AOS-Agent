import { describe, expect, it } from "vitest";
import {
	WORKER_FORBIDDEN_KEYS,
	WORKER_LIFECYCLE_STATUSES,
	applyWorkerHeartbeat,
	applyWorkerTransition,
	createWorkerLifecycle,
	parseWorkerRecord,
	serializeWorkerBinding,
	serializeWorkerRecord,
	validateWorkerBinding,
	validateWorkerLifecycleState,
	validateWorkerRecord,
	workerTransitionAllowed,
	type WorkerBinding,
	type WorkerLifecycleState,
	type WorkerLifecycleStatus,
	type WorkerTransition,
} from "../src/core/worker.ts";

const BASE_TIME_MS = Date.parse("2026-08-21T00:00:00.000Z");

const binding: WorkerBinding = {
	schemaVersion: 1,
	workerId: "worker-1",
	providerId: "sandbox-worker",
	sessionId: "session-1",
	laneId: "main",
	runId: "run-1",
	bindingId: "binding-1",
	bindingEpochId: "epoch-1",
	attemptId: "attempt-1",
	profileId: "local-worker",
	profileRevision: 1,
	capabilitySummary: ["filesystem.read", "process.spawn"],
	deadlineAt: BASE_TIME_MS + 60_000,
	credentialTargetRefs: ["target-1"],
	requestFingerprint: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
};

function at(index: number): string {
	return new Date(BASE_TIME_MS + index * 1_000).toISOString();
}

function mustCreate(): WorkerLifecycleState {
	const result = createWorkerLifecycle(binding, at(0));
	if (!result.ok) throw result.error;
	return result.value;
}

function command(
	state: WorkerLifecycleState,
	to: WorkerLifecycleStatus,
	index: number,
	overrides: Partial<WorkerTransition> = {},
): WorkerTransition {
	const terminal = to === "completed" || to === "failed" || to === "cancelled" || to === "lost";
	return {
		schemaVersion: 1,
		clientRequestId: `request-${index}-${to}`,
		expectedRevision: state.record.revision,
		binding,
		to,
		at: at(index),
		...(to === "running" ? { activeOperationId: "operation-1" } : {}),
		...((to === "cancelling" || terminal) && state.record.activeOperationId !== undefined
			? { activeOperationId: state.record.activeOperationId }
			: {}),
		...(to === "completed" || to === "cancelled" ? { receiptId: `receipt-${to}` } : {}),
		...(terminal
			? {
				sideEffectState:
					to === "lost" ? ("side_effect_unknown" as const) : ("none" as const),
			}
			: {}),
		...overrides,
	};
}

function mustApply(
	state: WorkerLifecycleState,
	to: WorkerLifecycleStatus,
	index: number,
	overrides: Partial<WorkerTransition> = {},
): WorkerLifecycleState {
	const result = applyWorkerTransition(state, command(state, to, index, overrides));
	if (!result.ok) throw result.error;
	return result.value.state;
}

const PATHS: Readonly<Record<WorkerLifecycleStatus, readonly WorkerLifecycleStatus[]>> = {
	new: [],
	starting: ["starting"],
	ready: ["starting", "ready"],
	running: ["starting", "ready", "running"],
	cancelling: ["starting", "ready", "cancelling"],
	completed: ["starting", "ready", "running", "completed"],
	failed: ["starting", "failed"],
	cancelled: ["starting", "ready", "cancelling", "cancelled"],
	lost: ["starting", "lost"],
	reclaiming: ["starting", "lost", "reclaiming"],
	reclaimed: ["starting", "lost", "reclaiming", "reclaimed"],
	reclaim_unknown: ["starting", "lost", "reclaiming", "reclaim_unknown"],
};

function stateAt(status: WorkerLifecycleStatus): WorkerLifecycleState {
	let state = mustCreate();
	let index = 1;
	for (const next of PATHS[status]) {
		state = mustApply(state, next, index++);
	}
	return state;
}

const LEGAL_EDGES = new Set([
	"new->starting",
	"starting->ready",
	"starting->failed",
	"starting->lost",
	"ready->running",
	"ready->cancelling",
	"ready->lost",
	"running->cancelling",
	"running->completed",
	"running->failed",
	"running->lost",
	"cancelling->cancelled",
	"cancelling->failed",
	"cancelling->lost",
	"completed->reclaiming",
	"failed->reclaiming",
	"cancelled->reclaiming",
	"lost->reclaiming",
	"reclaiming->reclaimed",
	"reclaiming->reclaim_unknown",
]);

describe("Operation Worker core contract", () => {
	it("accepts every legal lifecycle edge and rejects every other edge", () => {
		for (const from of WORKER_LIFECYCLE_STATUSES) {
			for (const to of WORKER_LIFECYCLE_STATUSES) {
				const state = stateAt(from);
				const result = applyWorkerTransition(
					state,
					command(state, to, state.transitions.length + 20, {
						clientRequestId: `edge-${from}-${to}`,
					}),
				);
				const expected = LEGAL_EDGES.has(`${from}->${to}`);
				expect(workerTransitionAllowed(from, to), `${from}->${to}`).toBe(expected);
				expect(result.ok, `${from}->${to}`).toBe(expected);
				if (result.ok) {
					expect(result.value.record.status).toBe(to);
					expect(result.value.record.revision).toBe(state.record.revision + 1);
				} else {
					expect(result.error.code).toBe("worker_conflict");
				}
			}
		}
	});

	it("enforces revision continuity and immutable Worker identity", () => {
		const state = stateAt("ready");
		const gap = applyWorkerTransition(state, command(state, "running", 10, { expectedRevision: 99 }));
		expect(gap).toMatchObject({ ok: false, error: { code: "worker_conflict" } });

		for (const drift of [
			{ sessionId: "session-2" },
			{ bindingId: "binding-2" },
			{ providerId: "sandbox-worker-2" },
			{
				requestFingerprint:
					"sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
			},
		] satisfies ReadonlyArray<Partial<WorkerBinding>>) {
			const identityDrift = applyWorkerTransition(
				state,
				command(state, "running", 10, { binding: { ...binding, ...drift } }),
			);
			expect(identityDrift).toMatchObject({
				ok: false,
				error: { code: "worker_binding_invalid" },
			});
		}
	});

	it("deduplicates an identical terminal once and rejects conflicting terminals", () => {
		const running = stateAt("running");
		const terminal = command(running, "completed", 10, { clientRequestId: "terminal-once" });
		const first = applyWorkerTransition(running, terminal);
		expect(first).toMatchObject({ ok: true, value: { idempotent: false } });
		if (!first.ok) return;

		const duplicate = applyWorkerTransition(first.value.state, terminal);
		expect(duplicate).toMatchObject({
			ok: true,
			value: { idempotent: true, record: { status: "completed", revision: 4 } },
		});
		const reusedKey = applyWorkerTransition(
			first.value.state,
			{ ...terminal, receiptId: "receipt-other" },
		);
		expect(reusedKey).toMatchObject({ ok: false, error: { code: "worker_conflict" } });
		const secondTerminal = applyWorkerTransition(
			first.value.state,
			command(first.value.state, "failed", 11, { clientRequestId: "terminal-twice" }),
		);
		expect(secondTerminal).toMatchObject({ ok: false, error: { code: "worker_conflict" } });
	});

	it("requires terminal facts to correlate the active operation", () => {
		const running = stateAt("running");
		expect(
			applyWorkerTransition(
				running,
				command(running, "completed", 10, { activeOperationId: undefined }),
			),
		).toMatchObject({ ok: false, error: { code: "worker_operation_invalid" } });
		expect(
			applyWorkerTransition(
				running,
				command(running, "completed", 10, { activeOperationId: "operation-other" }),
			),
		).toMatchObject({ ok: false, error: { code: "worker_operation_invalid" } });

		const completed = applyWorkerTransition(running, command(running, "completed", 10));
		expect(completed).toMatchObject({
			ok: true,
			value: {
				record: { status: "completed" },
				state: { transitions: expect.arrayContaining([expect.objectContaining({ operationId: "operation-1" })]) },
			},
		});
		if (!completed.ok) return;
		expect("activeOperationId" in completed.value.record).toBe(false);
		expect(completed.value.state.transitions.at(-1)?.requestFingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
	});

	it("folds monotonic heartbeats without changing lifecycle revision or leases", () => {
		const starting = stateAt("starting");
		const heartbeat = {
			schemaVersion: 1 as const,
			binding,
			sequence: 7,
			at: at(5),
		};
		const first = applyWorkerHeartbeat(starting, heartbeat);
		expect(first).toMatchObject({
			ok: true,
			value: {
				idempotent: false,
				record: { revision: starting.record.revision, lastHeartbeatAt: at(5) },
				state: { heartbeatSequence: 7 },
			},
		});
		if (!first.ok) return;
		expect(first.value.state.binding.deadlineAt).toBe(binding.deadlineAt);
		expect(applyWorkerHeartbeat(first.value.state, heartbeat)).toMatchObject({
			ok: true,
			value: { idempotent: true },
		});
		expect(
			applyWorkerHeartbeat(first.value.state, { ...heartbeat, sequence: 6, at: at(6) }),
		).toMatchObject({ ok: false, error: { code: "worker_conflict" } });
		expect(
			applyWorkerHeartbeat(first.value.state, { ...heartbeat, at: at(6) }),
		).toMatchObject({ ok: false, error: { code: "worker_conflict" } });

		const ready = mustApply(first.value.state, "ready", 7);
		expect(ready.record.lastHeartbeatAt).toBe(at(5));
		const lost = mustApply(ready, "lost", 8);
		expect(
			applyWorkerHeartbeat(lost, { ...heartbeat, sequence: 8, at: at(9) }),
		).toMatchObject({ ok: false, error: { code: "worker_conflict" } });
	});

	it("validates the complete lifecycle record against its transition log", () => {
		const completed = stateAt("completed");
		expect(validateWorkerLifecycleState(completed)).toBe(true);

		const last = completed.transitions.at(-1);
		if (last === undefined) throw new Error("expected terminal transition");
		const alteredFingerprint = {
			...completed,
			transitions: [
				...completed.transitions.slice(0, -1),
				{ ...last, requestFingerprint: "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff" },
			],
		};
		expect(validateWorkerLifecycleState(alteredFingerprint)).toBe(false);
		expect(
			applyWorkerTransition(
				alteredFingerprint as WorkerLifecycleState,
				command(completed, "reclaiming", 20),
			),
		).toMatchObject({ ok: false, error: { code: "worker_persistence_failed" } });
		expect(
			validateWorkerLifecycleState({
				...completed,
				transitions: completed.transitions.slice(0, -1),
			}),
		).toBe(false);
		expect(
			validateWorkerLifecycleState({
				...completed,
				record: { ...completed.record, revision: completed.record.revision + 1 },
			}),
		).toBe(false);
	});

	it("makes reclaim and its cleanup outcome idempotent without rewriting execution terminal", () => {
		const lost = stateAt("lost");
		const reclaim = command(lost, "reclaiming", 10, { clientRequestId: "reclaim-once" });
		const reclaiming = applyWorkerTransition(lost, reclaim);
		expect(reclaiming).toMatchObject({ ok: true, value: { record: { status: "reclaiming" } } });
		if (!reclaiming.ok) return;
		const duplicate = applyWorkerTransition(reclaiming.value.state, reclaim);
		expect(duplicate).toMatchObject({ ok: true, value: { idempotent: true } });

		const finish = command(reclaiming.value.state, "reclaimed", 11, {
			clientRequestId: "reclaim-finish-once",
		});
		const reclaimed = applyWorkerTransition(reclaiming.value.state, finish);
		expect(reclaimed).toMatchObject({ ok: true, value: { record: { status: "reclaimed" } } });
		if (!reclaimed.ok) return;
		expect(applyWorkerTransition(reclaimed.value.state, finish)).toMatchObject({
			ok: true,
			value: { idempotent: true },
		});
		expect(reclaimed.value.record.endedAt).toBe(lost.record.endedAt);
	});

	it("requires safe side-effect evidence for every execution terminal", () => {
		const running = stateAt("running");
		expect(
			applyWorkerTransition(
				running,
				command(running, "completed", 10, { sideEffectState: "unknown" }),
			),
		).toMatchObject({ ok: false, error: { code: "worker_operation_invalid" } });
		expect(
			applyWorkerTransition(
				running,
				command(running, "lost", 10, { sideEffectState: "none" }),
			),
		).toMatchObject({ ok: false, error: { code: "worker_operation_invalid" } });
	});

	it("serializes only safe exact records and rejects every forbidden field", () => {
		const completed = stateAt("completed").record;
		const serialized = serializeWorkerRecord(completed);
		expect(parseWorkerRecord(serialized)).toMatchObject({ ok: true, value: completed });
		expect(JSON.parse(serialized)).toEqual(completed);
		expect(serializeWorkerBinding(binding)).not.toContain("agentInstanceId");
		expect(validateWorkerBinding(binding)).toBe(true);
		expect(validateWorkerRecord(completed)).toBe(true);

		for (const key of WORKER_FORBIDDEN_KEYS) {
			const unsafe = { ...completed, [key]: "must-not-persist" };
			expect(validateWorkerRecord(unsafe), key).toBe(false);
			expect(() => serializeWorkerRecord(unsafe), key).toThrowError(
				expect.objectContaining({ code: "worker_invalid" }),
			);
		}
		for (const key of [
			"command",
			"args",
			"providerRawError",
			"agentInstanceId",
			"attemptReceiptId",
			"runReceiptId",
		]) {
			expect(validateWorkerRecord({ ...completed, [key]: "forbidden" }), key).toBe(false);
		}
	});

	it("freezes the binding and never exposes TaskExecutor or AgentInstance authority", () => {
		const state = mustCreate();
		expect(Object.isFrozen(state.binding)).toBe(true);
		expect(Object.isFrozen(state.binding.capabilitySummary)).toBe(true);
		expect("agentInstanceId" in state.binding).toBe(false);
		expect("createAttempt" in state).toBe(false);
		expect("runAttempt" in state).toBe(false);
		expect("attemptReceipt" in state.record).toBe(false);
		expect("runReceipt" in state.record).toBe(false);
	});
});
