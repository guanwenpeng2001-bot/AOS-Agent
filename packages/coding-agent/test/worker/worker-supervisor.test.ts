import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { SandboxOperationRequest } from "../../../agent/src/internal.ts";
import {
	OperationWorkerSupervisor,
	type WorkerSupervisorConfig,
} from "../../src/core/worker/supervisor.ts";
import {
	WORKER_SCHEMA_VERSION,
	applyWorkerTransition,
	createWorkerLifecycle,
	type WorkerBinding,
	type WorkerLifecycleState,
	type WorkerLifecycleStatus,
} from "../../src/core/worker/lifecycle.ts";

const CHILD_ENTRY = fileURLToPath(new URL("../fixtures/fake-worker-child.ts", import.meta.url));
const supervisors: OperationWorkerSupervisor[] = [];

function binding(
	profileId: string,
	overrides: Partial<WorkerBinding> = {},
): WorkerBinding {
	return {
		schemaVersion: 1,
		workerId: `worker-${profileId}`,
		providerId: "sandbox-worker",
		sessionId: "session-1",
		laneId: "main",
		runId: "run-1",
		bindingId: "binding-1",
		bindingEpochId: "epoch-1",
		attemptId: "attempt-1",
		profileId,
		profileRevision: 1,
		capabilitySummary: ["filesystem.read", "process.spawn"],
		deadlineAt: Date.now() + 10_000,
		credentialTargetRefs: [],
		requestFingerprint: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		...overrides,
	};
}

function config(
	profileId: string,
	overrides: Partial<WorkerSupervisorConfig> = {},
): WorkerSupervisorConfig {
	return {
		executable: process.execPath,
		entrypoint: CHILD_ENTRY,
		profileId,
		profileRevision: 1,
		capabilities: ["filesystem.read", "process.spawn"],
		environment: { AOS_SAFE_TEST_MARKER: "1" },
		// Process startup can be delayed by the full suite's parallel child-process tests.
		// The dedicated ready_timeout profile below keeps the readiness deadline assertion strict.
		readyTimeoutMs: 10_000,
		heartbeatTimeoutMs: 250,
		cancelTimeoutMs: 100,
		terminateTimeoutMs: 500,
		...overrides,
	};
}

function create(
	profileId: string,
	options: {
		readonly binding?: Partial<WorkerBinding>;
		readonly config?: Partial<WorkerSupervisorConfig>;
	} = {},
): { readonly supervisor: OperationWorkerSupervisor; readonly workerBinding: WorkerBinding } {
	const supervisor = new OperationWorkerSupervisor(config(profileId, options.config));
	supervisors.push(supervisor);
	return { supervisor, workerBinding: binding(profileId, options.binding) };
}

async function activate(
	supervisor: OperationWorkerSupervisor,
	workerBinding: WorkerBinding,
): Promise<void> {
	const preflight = supervisor.preflight({ binding: workerBinding, runAccepted: true });
	if (!preflight.ok) throw preflight.error;
	const activated = await supervisor.activate(preflight.value);
	if (!activated.ok) throw activated.error;
}

function request(workerBinding: WorkerBinding, operationId = "operation-1"): SandboxOperationRequest {
	return {
		schemaVersion: 1,
		operationId,
		providerId: workerBinding.providerId,
		bindingId: workerBinding.bindingId,
		bindingEpochId: workerBinding.bindingEpochId,
		attemptId: workerBinding.attemptId,
		taskId: "task-1",
		dispatchId: "dispatch-1",
		payload: { action: "read" },
	};
}

async function waitForStatus(
	supervisor: OperationWorkerSupervisor,
	status: WorkerLifecycleStatus,
	timeoutMs = 1_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (supervisor.snapshot.record?.status === status) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error(`Timed out waiting for ${status}`);
}

async function waitForNoLiveProcess(
	supervisor: OperationWorkerSupervisor,
	timeoutMs = 1_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!supervisor.snapshot.hasLiveProcess) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error("Timed out waiting for the worker process to stop");
}

function recoveredReadyState(workerBinding: WorkerBinding): WorkerLifecycleState {
	const created = createWorkerLifecycle(workerBinding, "2026-08-21T00:00:00.000Z");
	if (!created.ok) throw created.error;
	const starting = applyWorkerTransition(created.value, {
		schemaVersion: WORKER_SCHEMA_VERSION,
		clientRequestId: "restore-starting",
		expectedRevision: 0,
		binding: workerBinding,
		to: "starting",
		at: "2026-08-21T00:00:01.000Z",
	});
	if (!starting.ok) throw starting.error;
	const ready = applyWorkerTransition(starting.value.state, {
		schemaVersion: WORKER_SCHEMA_VERSION,
		clientRequestId: "restore-ready",
		expectedRevision: 1,
		binding: workerBinding,
		to: "ready",
		at: "2026-08-21T00:00:02.000Z",
	});
	if (!ready.ok) throw ready.error;
	return ready.value.state;
}

afterEach(async () => {
	delete process.env.AOS_AGENT_WORKER_SECRET_SENTINEL;
	for (const supervisor of supervisors.splice(0)) await supervisor.dispose();
});

describe("Operation Worker supervisor", () => {
	it("keeps preflight effect-free and activates only a trusted fixed launcher with an explicit environment", async () => {
		process.env.AOS_AGENT_WORKER_SECRET_SENTINEL = "must-not-cross";
		const { supervisor, workerBinding } = create("environment_probe");
		const preflight = supervisor.preflight({ binding: workerBinding, runAccepted: true });
		expect(preflight.ok).toBe(true);
		expect(supervisor.snapshot).toEqual({ hasLiveProcess: false, quarantined: false });
		if (!preflight.ok) return;
		expect(await supervisor.activate(preflight.value)).toMatchObject({
			ok: true,
			value: { status: "ready" },
		});
		expect(supervisor.snapshot.hasLiveProcess).toBe(true);

		const rejected = create("success", { config: { executable: "node" } });
		expect(rejected.supervisor.preflight({ binding: rejected.workerBinding, runAccepted: true })).toMatchObject({
			ok: false,
			error: { code: "worker_profile_untrusted" },
		});
		expect(rejected.supervisor.snapshot.hasLiveProcess).toBe(false);

		const notAccepted = create("success");
		expect(notAccepted.supervisor.preflight({ binding: notAccepted.workerBinding, runAccepted: false })).toMatchObject({
			ok: false,
			error: { code: "worker_unavailable" },
		});
		expect(notAccepted.supervisor.snapshot.hasLiveProcess).toBe(false);
	});

	it("handles slow readiness and bounds the ready timeout", async () => {
		const slow = create("ready_slow");
		await activate(slow.supervisor, slow.workerBinding);
		expect(slow.supervisor.snapshot.record?.status).toBe("ready");

		const timedOut = create("ready_timeout", { config: { readyTimeoutMs: 40 } });
		const preflight = timedOut.supervisor.preflight({ binding: timedOut.workerBinding, runAccepted: true });
		if (!preflight.ok) throw preflight.error;
		expect(await timedOut.supervisor.activate(preflight.value)).toMatchObject({
			ok: false,
			error: { code: "worker_start_failed" },
		});
		expect(timedOut.supervisor.snapshot.record?.status).toBe("failed");
		expect(timedOut.supervisor.snapshot.hasLiveProcess).toBe(false);
	});

	it("stops and cleans the child before returning an initialize backpressure failure", async () => {
		const current = create("success", { config: { maxPendingWriteBytes: 1 } });
		const preflight = current.supervisor.preflight({ binding: current.workerBinding, runAccepted: true });
		if (!preflight.ok) throw preflight.error;
		expect(await current.supervisor.activate(preflight.value)).toMatchObject({
			ok: false,
			error: { code: "worker_operation_invalid" },
		});
		expect(current.supervisor.snapshot).toMatchObject({
			hasLiveProcess: false,
			record: { status: "lost" },
		});
	});

	it("handles an asynchronous spawn error without exposing an unhandled child error", async () => {
		const directory = await mkdtemp(join(tmpdir(), "aos-worker-supervisor-"));
		const nonExecutable = join(directory, "ordinary-file.txt");
		await writeFile(nonExecutable, "not an executable", { mode: 0o600 });
		try {
			const current = create("success", { config: { executable: nonExecutable } });
			const preflight = current.supervisor.preflight({ binding: current.workerBinding, runAccepted: true });
			if (!preflight.ok) throw preflight.error;
			expect(await current.supervisor.activate(preflight.value)).toMatchObject({
				ok: false,
				error: { code: "worker_start_failed" },
			});
			expect(current.supervisor.snapshot).toMatchObject({
				hasLiveProcess: false,
				record: { status: "failed" },
			});
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});

	it("returns valid success and failure receipts and reclaims exactly once", async () => {
		for (const profile of ["success", "failure"] as const) {
			const current = create(profile);
			await activate(current.supervisor, current.workerBinding);
			const outcome = await current.supervisor.execute(request(current.workerBinding));
			expect(outcome).toMatchObject({
				ok: true,
				value: {
					status: profile === "success" ? "succeeded" : "failed",
					sideEffectState: "none",
				},
			});
			expect(current.supervisor.snapshot.record?.status).toBe(
				profile === "success" ? "completed" : "failed",
			);
			expect(await current.supervisor.cancel()).toEqual({ ok: true, value: undefined });
			const first = await current.supervisor.reclaim();
			expect(first).toMatchObject({ ok: true, value: { status: "reclaimed" } });
			const second = await current.supervisor.reclaim();
			expect(second).toEqual(first);
			expect(current.supervisor.snapshot.hasLiveProcess).toBe(false);
		}
	});

	it("fails closed on malformed, oversized, and sequence-drift frames without restarting", async () => {
		for (const profile of ["malformed", "oversize", "sequence_drift"] as const) {
			const current = create(profile);
			const preflight = current.supervisor.preflight({ binding: current.workerBinding, runAccepted: true });
			if (!preflight.ok) throw preflight.error;
			const activated = await current.supervisor.activate(preflight.value);
			expect(activated.ok).toBe(false);
			expect(current.supervisor.snapshot.record?.status).toBe("lost");
			expect(current.supervisor.preflight({ binding: current.workerBinding, runAccepted: true })).toMatchObject({
				ok: false,
				error: { code: "worker_conflict" },
			});
		}
	});

	it("rejects a duplicate terminal in one output batch before exposing receipt success", async () => {
		const current = create("duplicate_terminal");
		await activate(current.supervisor, current.workerBinding);
		expect(await current.supervisor.execute(request(current.workerBinding))).toMatchObject({
			ok: false,
			error: { code: "worker_operation_invalid" },
		});
		expect(current.supervisor.snapshot.record?.status).toBe("lost");
		expect(current.supervisor.lifecycleState?.transitions.map((item) => item.to)).toContain("lost");
		expect(current.supervisor.lifecycleState?.transitions.some((item) => item.to === "completed")).toBe(false);
		await waitForNoLiveProcess(current.supervisor);
		const cancelled = await current.supervisor.cancel();
		expect(cancelled).toMatchObject({
			ok: false,
			error: { code: "worker_lost" },
		});
		expect(await current.supervisor.cancel()).toEqual(cancelled);
		expect(current.supervisor.snapshot.record?.status).toBe("lost");
	});

	it("stops and cleans the child before returning an execute backpressure failure", async () => {
		const current = create("success", { config: { maxPendingWriteBytes: 2_000 } });
		await activate(current.supervisor, current.workerBinding);
		const backpressuredRequest: SandboxOperationRequest = {
			...request(current.workerBinding),
			payload: { value: "x".repeat(4_000) },
		};
		expect(await current.supervisor.execute(backpressuredRequest)).toMatchObject({
			ok: false,
			error: { code: "worker_operation_invalid" },
		});
		expect(current.supervisor.snapshot).toMatchObject({
			hasLiveProcess: false,
			record: { status: "lost" },
		});
		expect(current.supervisor.lifecycleState?.transitions.some((item) => item.to === "completed")).toBe(false);
		expect(current.supervisor.preflight({ binding: current.workerBinding, runAccepted: true })).toMatchObject({
			ok: false,
			error: { code: "worker_conflict" },
		});
	});

	it("maps child disconnect and invalid receipt correlation to lost", async () => {
		for (const profile of ["disconnect", "receipt_invalid"] as const) {
			const current = create(profile);
			await activate(current.supervisor, current.workerBinding);
			const outcome = await current.supervisor.execute(request(current.workerBinding));
			expect(outcome).toMatchObject({ ok: false });
			expect(current.supervisor.snapshot.record?.status).toBe("lost");
			expect(current.supervisor.lifecycleState?.transitions.some((item) => item.to === "completed")).toBe(false);
		}
	});

	it("distinguishes a confirmed cancellation from cancel acknowledgement timeout", async () => {
		const confirmed = create("cancel_success");
		await activate(confirmed.supervisor, confirmed.workerBinding);
		const confirmedExecution = confirmed.supervisor.execute(request(confirmed.workerBinding));
		await waitForStatus(confirmed.supervisor, "running");
		expect(await confirmed.supervisor.cancel("cancel", "operation-1")).toEqual({ ok: true, value: undefined });
		const confirmedOutcome = await confirmedExecution;
		if (!confirmedOutcome.ok) throw confirmedOutcome.error;
		expect(confirmedOutcome).toMatchObject({ ok: true, value: { status: "cancelled" } });
		expect(confirmed.supervisor.snapshot.record?.status).toBe("cancelled");
		expect(await confirmed.supervisor.cancel()).toEqual({ ok: true, value: undefined });

		const timedOut = create("cancel_timeout", { config: { cancelTimeoutMs: 40 } });
		await activate(timedOut.supervisor, timedOut.workerBinding);
		const timedOutExecution = timedOut.supervisor.execute(request(timedOut.workerBinding));
		await waitForStatus(timedOut.supervisor, "running");
		expect(await timedOut.supervisor.cancel("cancel", "operation-1")).toMatchObject({
			ok: false,
			error: { code: "worker_cancel_failed" },
		});
		expect(await timedOutExecution).toMatchObject({ ok: false });
		expect(timedOut.supervisor.snapshot.record?.status).toBe("reclaimed");
	});

	it("rejects a late deadline receipt and never rewrites the terminal outcome", async () => {
		const activationDeadlineAt = Date.now() + 10_000;
		const heartbeatTimeoutMs = 500;
		let clockOffsetMs = 0;
		const current = create("deadline_late", {
			binding: { deadlineAt: activationDeadlineAt },
			config: {
				heartbeatTimeoutMs,
				now: () => new Date(Date.now() + clockOffsetMs),
			},
		});
		await activate(current.supervisor, current.workerBinding);
		// Place now inside the heartbeat window but still before the deadline so a
		// stale heartbeat timer can fire first. That expiry must stay a deadline
		// failure, and the child's later success receipt must not write completed.
		clockOffsetMs = activationDeadlineAt - Date.now() - (heartbeatTimeoutMs - 50);
		const outcome = await current.supervisor.execute(request(current.workerBinding));
		expect(outcome).toMatchObject({ ok: false, error: { code: "worker_deadline_exceeded" } });
		expect(current.supervisor.snapshot.record?.status).toBe("lost");
		expect(current.supervisor.lifecycleState?.transitions.some((item) => item.to === "completed")).toBe(false);
	});

	it("keeps a jumped clock inside the heartbeat window from reporting worker_lost", async () => {
		const activationDeadlineAt = Date.now() + 8_000;
		const heartbeatTimeoutMs = 400;
		let clockOffsetMs = 0;
		const current = create("deadline_late", {
			binding: { deadlineAt: activationDeadlineAt },
			config: {
				heartbeatTimeoutMs,
				now: () => new Date(Date.now() + clockOffsetMs),
			},
		});
		await activate(current.supervisor, current.workerBinding);
		clockOffsetMs = activationDeadlineAt - Date.now() - 80;
		const pending = current.supervisor.execute(request(current.workerBinding));
		await waitForStatus(current.supervisor, "lost", 2_000);
		const outcome = await pending;
		expect(outcome).toMatchObject({ ok: false, error: { code: "worker_deadline_exceeded" } });
		expect(current.supervisor.lifecycleState?.transitions.some((item) => item.to === "completed")).toBe(false);
	});

	it("marks reclaim failure unknown, quarantines the target, and keeps reclaim idempotent", async () => {
		const current = create("reclaim_unknown", { config: { terminateTimeoutMs: 100 } });
		await activate(current.supervisor, current.workerBinding);
		expect(await current.supervisor.execute(request(current.workerBinding))).toMatchObject({ ok: true });
		const first = await current.supervisor.reclaim();
		expect(first).toMatchObject({ ok: true, value: { status: "reclaim_unknown" } });
		expect(current.supervisor.snapshot).toMatchObject({ hasLiveProcess: false, quarantined: true });
		expect(await current.supervisor.reclaim()).toEqual(first);
	});

	it("uses heartbeat only for liveness and loses a stalled child without changing its deadline", async () => {
		const current = create("heartbeat_stall", { config: { heartbeatTimeoutMs: 60 } });
		await activate(current.supervisor, current.workerBinding);
		expect(current.supervisor.lifecycleState?.heartbeatSequence).toBe(1);
		const deadlineAt = current.supervisor.lifecycleState?.binding.deadlineAt;
		await waitForStatus(current.supervisor, "lost");
		expect(current.supervisor.lifecycleState?.binding.deadlineAt).toBe(deadlineAt);
		expect(current.supervisor.lifecycleState?.heartbeatSequence).toBe(1);
	});

	it("restores safe facts without resurrecting a process and quarantines unknown orphan cleanup", async () => {
		const current = create("success");
		const restored = recoveredReadyState(current.workerBinding);
		const recovered = current.supervisor.recover(restored);
		if (!recovered.ok) throw recovered.error;
		expect(recovered).toMatchObject({ ok: true, value: { status: "lost" } });
		expect(current.supervisor.snapshot.hasLiveProcess).toBe(false);
		expect(current.supervisor.preflight({ binding: current.workerBinding, runAccepted: true })).toMatchObject({
			ok: false,
			error: { code: "worker_conflict" },
		});
		expect(await current.supervisor.reclaim()).toMatchObject({
			ok: true,
			value: { status: "reclaim_unknown" },
		});
		expect(current.supervisor.snapshot.quarantined).toBe(true);
	});

	it("rejects recovered state that does not exactly match the configured profile", () => {
		const mismatches = [
			binding("other-profile"),
			binding("success", { profileRevision: 2 }),
			binding("success", { capabilitySummary: ["filesystem.read"] }),
		];
		for (const recoveredBinding of mismatches) {
			const current = create("success");
			expect(current.supervisor.recover(recoveredReadyState(recoveredBinding))).toMatchObject({
				ok: false,
				error: { code: "worker_persistence_failed" },
			});
			expect(current.supervisor.snapshot).toEqual({ hasLiveProcess: false, quarantined: false });
			expect(current.supervisor.preflight({ binding: current.workerBinding, runAccepted: true })).toMatchObject({
				ok: true,
			});
		}
	});

	it("never projects process or protocol internals into safe records", async () => {
		const current = create("success");
		await activate(current.supervisor, current.workerBinding);
		await current.supervisor.execute(request(current.workerBinding));
		const serialized = JSON.stringify({
			snapshot: current.supervisor.snapshot,
			lifecycle: current.supervisor.lifecycleState,
		});
		for (const forbidden of [
			"pid",
			"executable",
			"argv",
			"cwd",
			"environment",
			"stdout",
			"stderr",
			"rawFrame",
			"providerException",
		]) {
			expect(serialized).not.toContain(`"${forbidden}"`);
		}
	});
});
