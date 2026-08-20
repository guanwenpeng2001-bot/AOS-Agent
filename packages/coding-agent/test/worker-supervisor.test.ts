import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { SandboxOperationRequestV1 } from "@aos-agent/agent-core";
import {
	WorkerSupervisorV1,
	type WorkerSupervisorConfigV1,
} from "../src/core/worker-supervisor.ts";
import {
	WORKER_SCHEMA_VERSION,
	applyWorkerTransitionV1,
	createWorkerLifecycleV1,
	type WorkerBindingV1,
	type WorkerLifecycleStateV1,
	type WorkerLifecycleStatusV1,
} from "../src/core/worker.ts";

const CHILD_ENTRY = fileURLToPath(new URL("./fixtures/fake-worker-child.ts", import.meta.url));
const supervisors: WorkerSupervisorV1[] = [];

function binding(
	profileId: string,
	overrides: Partial<WorkerBindingV1> = {},
): WorkerBindingV1 {
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
		deadlineAt: Date.now() + 2_000,
		credentialTargetRefs: [],
		requestFingerprint: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		...overrides,
	};
}

function config(
	profileId: string,
	overrides: Partial<WorkerSupervisorConfigV1> = {},
): WorkerSupervisorConfigV1 {
	return {
		executable: process.execPath,
		entrypoint: CHILD_ENTRY,
		profileId,
		profileRevision: 1,
		capabilities: ["filesystem.read", "process.spawn"],
		environment: { AOS_SAFE_TEST_MARKER: "1" },
		readyTimeoutMs: 150,
		heartbeatTimeoutMs: 250,
		cancelTimeoutMs: 100,
		terminateTimeoutMs: 500,
		...overrides,
	};
}

function create(
	profileId: string,
	options: {
		readonly binding?: Partial<WorkerBindingV1>;
		readonly config?: Partial<WorkerSupervisorConfigV1>;
	} = {},
): { readonly supervisor: WorkerSupervisorV1; readonly workerBinding: WorkerBindingV1 } {
	const supervisor = new WorkerSupervisorV1(config(profileId, options.config));
	supervisors.push(supervisor);
	return { supervisor, workerBinding: binding(profileId, options.binding) };
}

async function activate(
	supervisor: WorkerSupervisorV1,
	workerBinding: WorkerBindingV1,
): Promise<void> {
	const preflight = supervisor.preflight({ binding: workerBinding, runAccepted: true });
	if (!preflight.ok) throw preflight.error;
	const activated = await supervisor.activate(preflight.value);
	if (!activated.ok) throw activated.error;
}

function request(workerBinding: WorkerBindingV1, operationId = "operation-1"): SandboxOperationRequestV1 {
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
	supervisor: WorkerSupervisorV1,
	status: WorkerLifecycleStatusV1,
	timeoutMs = 1_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (supervisor.snapshot.record?.status === status) return;
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
	throw new Error(`Timed out waiting for ${status}`);
}

function recoveredReadyState(workerBinding: WorkerBindingV1): WorkerLifecycleStateV1 {
	const created = createWorkerLifecycleV1(workerBinding, "2026-08-21T00:00:00.000Z");
	if (!created.ok) throw created.error;
	const starting = applyWorkerTransitionV1(created.value, {
		schemaVersion: WORKER_SCHEMA_VERSION,
		clientRequestId: "restore-starting",
		expectedRevision: 0,
		binding: workerBinding,
		to: "starting",
		at: "2026-08-21T00:00:01.000Z",
	});
	if (!starting.ok) throw starting.error;
	const ready = applyWorkerTransitionV1(starting.value.state, {
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
	delete process.env.AOS_WORKER_SECRET_SENTINEL;
	for (const supervisor of supervisors.splice(0)) await supervisor.dispose();
});

describe("Operation Worker supervisor", () => {
	it("keeps preflight effect-free and activates only a trusted fixed launcher with an explicit environment", async () => {
		process.env.AOS_WORKER_SECRET_SENTINEL = "must-not-cross";
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
			if (profile === "sequence_drift") {
				expect(activated.ok).toBe(true);
				await waitForStatus(current.supervisor, "lost");
			} else {
				expect(activated).toMatchObject({ ok: false });
				expect(current.supervisor.snapshot.record?.status).toBe("lost");
			}
			expect(current.supervisor.preflight({ binding: current.workerBinding, runAccepted: true })).toMatchObject({
				ok: false,
				error: { code: "worker_conflict" },
			});
		}
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
		const current = create("deadline_late", {
			binding: { deadlineAt: Date.now() + 300 },
			config: { heartbeatTimeoutMs: 500 },
		});
		await activate(current.supervisor, current.workerBinding);
		const outcome = await current.supervisor.execute(request(current.workerBinding));
		expect(outcome).toMatchObject({ ok: false, error: { code: "worker_deadline_exceeded" } });
		expect(current.supervisor.snapshot.record?.status).toBe("lost");
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
