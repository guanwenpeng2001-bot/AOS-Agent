import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../src/core/session-manager.ts";
import type { TaskCredentialDeliveryReceipt, TaskCredentialScope } from "../src/core/task-credential-lease.ts";
import {
	createTaskCredentialTestProvider,
	type TaskCredentialProviderReceipt,
	type TaskCredentialTargetCapabilities,
	type TaskCredentialTargetCapabilitiesRequest,
	type TaskCredentialTargetRenewRequest,
	type TaskCredentialTargetRevokeRequest,
	type TaskCredentialTestProvider,
} from "../src/core/task-credential-provider.ts";
import {
	TaskCredentialService,
	type TaskCredentialPreflightResolver,
	type TaskCredentialRunIssueContext,
	type TaskCredentialWorkerTarget,
} from "../src/core/task-credential-service.ts";
import type { TaskCredentialSession } from "../src/core/task-credential-store.ts";
import type { SafeLeaseProjectionV1, SafeLeaseReferenceV1 } from "../src/core/worker-protocol.ts";

const NOW = "2026-08-21T00:00:00.000Z";
const SECRET = "worker-secret-must-never-cross-boundary";
const SCOPES: ReadonlyArray<TaskCredentialScope> = [{
	credentialName: "registry",
	purpose: "read",
	operations: ["read"],
	targetKinds: ["operation_worker"],
}];

class FakeSession implements TaskCredentialSession {
	readonly entries: SessionEntry[] = [];
	readonly sessionId: string;

	constructor(sessionId = "session_worker") {
		this.sessionId = sessionId;
	}

	getSessionId(): string {
		return this.sessionId;
	}

	getEntries(): ReadonlyArray<SessionEntry> {
		return this.entries;
	}

	appendCustomEntry(customType: string, data?: unknown): string {
		const entry = { id: `entry_${this.entries.length + 1}`, type: "custom", customType, data } as SessionEntry;
		this.entries.push(entry);
		return entry.id;
	}
}

class MaterialTarget {
	readonly materials: string[] = [];

	getCapabilities(request: TaskCredentialTargetCapabilitiesRequest): TaskCredentialTargetCapabilities {
		return {
			schemaVersion: 1,
			targetId: request.targetId,
			targetKind: request.targetKind,
			bindingId: request.bindingId,
			canReceiveShortLivedCredential: true,
			canRenewCredential: true,
			canRevokeCredential: true,
			supportsPerBindingIsolation: true,
			supportsDeliveryReceipt: true,
		};
	}

	project(request: {
		readonly schemaVersion: 1;
		readonly leaseId: string;
		readonly grantId: string;
		readonly bindingId: string;
		readonly targetId?: string;
		readonly scopes: ReadonlyArray<TaskCredentialScope>;
		readonly material: Readonly<Record<string, string>>;
		readonly projectedAt: string;
	}): TaskCredentialDeliveryReceipt {
		this.materials.push(...Object.values(request.material));
		return {
			schemaVersion: 1,
			leaseId: request.leaseId,
			grantId: request.grantId,
			bindingId: request.bindingId,
			status: "succeeded",
			recordedAt: NOW,
		};
	}

	renew(request: TaskCredentialTargetRenewRequest): TaskCredentialProviderReceipt {
		return { schemaVersion: 1, leaseId: request.leaseId, grantId: request.grantId, bindingId: request.bindingId, status: "renewed", recordedAt: NOW };
	}

	revoke(request: TaskCredentialTargetRevokeRequest): TaskCredentialProviderReceipt {
		return { schemaVersion: 1, leaseId: request.leaseId, grantId: request.grantId, bindingId: request.bindingId, status: "revoked", recordedAt: NOW };
	}
}

class WorkerTarget implements TaskCredentialWorkerTarget {
	readonly projections: SafeLeaseProjectionV1[] = [];
	readonly renewals: SafeLeaseProjectionV1[] = [];
	readonly revocations: SafeLeaseReferenceV1[] = [];
	projectResult = true;
	renewResult = true;
	revokeResult = true;

	project(lease: SafeLeaseProjectionV1): { readonly ok: boolean } {
		if (!this.projectResult) return { ok: false };
		this.projections.push(lease);
		return { ok: true };
	}

	renew(lease: SafeLeaseProjectionV1): { readonly ok: boolean } {
		if (!this.renewResult) return { ok: false };
		this.renewals.push(lease);
		return { ok: true };
	}

	revoke(lease: SafeLeaseReferenceV1): { readonly ok: boolean } {
		if (!this.revokeResult) return { ok: false };
		this.revocations.push(lease);
		return { ok: true };
	}
}

function provider(target = new MaterialTarget()): { readonly provider: TaskCredentialTestProvider; readonly target: MaterialTarget } {
	return {
		provider: createTaskCredentialTestProvider({ materials: { registry: SECRET }, target, now: () => NOW }),
		target,
	};
}

function preflight(): TaskCredentialPreflightResolver {
	return { resolve: (input) => ({ allowed: true, boundedTtlMs: input.requestedTtlMs }) };
}

function issueContext(workerTarget?: TaskCredentialWorkerTarget): TaskCredentialRunIssueContext {
	return {
		taskId: "task_worker",
		graphRevision: 1,
		nodeId: "node_worker",
		stageId: "stage_worker",
		stageRevision: 1,
		runId: "run_worker",
		capabilityBindingId: "cap_worker",
		policyBindingId: "policy_worker",
		sandboxBindingId: "sandbox_worker",
		targetId: "worker_target",
		targetKind: "operation_worker",
		workerId: "worker_1",
		scopes: SCOPES,
		requestedTtlMs: 60_000,
		clientRequestId: "issue_worker",
		gate: { status: "approved", stageRevision: 1 },
		nodeAttached: true,
		...(workerTarget === undefined ? {} : { workerTarget }),
	};
}

function makeService(
	worker: WorkerTarget,
	options: { readonly session?: FakeSession; readonly workerTargets?: ReadonlyMap<string, TaskCredentialWorkerTarget> } = {},
): { readonly service: TaskCredentialService; readonly session: FakeSession; readonly providerTarget: MaterialTarget; readonly clock: { nowMs: number } } {
	const session = options.session ?? new FakeSession();
	const material = provider();
	const clock = { nowMs: Date.parse(NOW) };
	const service = new TaskCredentialService({
		session,
		provider: material.provider,
		preflight: preflight(),
		policyMaxTtlMs: 300_000,
		now: () => new Date(clock.nowMs).toISOString(),
		...(options.workerTargets === undefined ? {} : { workerTargets: options.workerTargets }),
	});
	return { service, session, providerTarget: material.target, clock };
}

describe("Task Credential Worker target wiring", () => {
	it("projects only safe refs and never sends material to the Worker", () => {
		const worker = new WorkerTarget();
		const { service, providerTarget } = makeService(worker);
		const result = service.issueForTaskRun(issueContext(worker));
		expect(result.ok).toBe(true);
		expect(providerTarget.materials).toEqual([SECRET]);
		expect(worker.projections).toHaveLength(1);
		expect(Object.keys(worker.projections[0]).sort()).toEqual(["bindingId", "clientRequestId", "expiresAt", "grantId", "leaseId", "schemaVersion", "scopeDigest"]);
		expect(JSON.stringify(worker.projections[0])).not.toContain(SECRET);
	});

	it("renews with the next lease sequence and revokes idempotently", () => {
		const worker = new WorkerTarget();
		const harness = makeService(worker);
		const { service } = harness;
		const issued = service.issueForTaskRun(issueContext(worker));
		expect(issued.ok).toBe(true);
		if (!issued.ok) return;
		harness.clock.nowMs += 10_000;
		const renewed = service.renew({ leaseId: issued.leaseId, grantId: issued.grant.grantId, bindingId: issued.bindingId, heartbeatSequence: 1, requestedTtlMs: 60_000, clientRequestId: "renew_worker", gate: { status: "approved", stageRevision: 1 }, nodeAttached: true });
		expect(renewed.ok).toBe(true);
		if (!renewed.ok) return;
		expect(renewed.grant.heartbeatSequence).toBe(1);
		expect(worker.renewals).toHaveLength(1);
		const revokeInput = { leaseId: issued.leaseId, clientRequestId: "revoke_worker", gate: { status: "approved" as const, stageRevision: 1 }, nodeAttached: true };
		const revoked = service.revoke(revokeInput);
		const replay = service.revoke(revokeInput);
		expect(revoked.ok).toBe(true);
		expect(replay.ok).toBe(true);
		expect(worker.revocations).toHaveLength(1);
		expect(service.get(issued.leaseId)?.status).toBe("revoked");
	});

	it("detaches by Worker identity, revokes and settles once", () => {
		const worker = new WorkerTarget();
		const { service } = makeService(worker);
		const issued = service.issueForTaskRun(issueContext(worker));
		expect(issued.ok).toBe(true);
		if (!issued.ok) return;
		const first = service.onWorkerDetach({ workerId: "worker_1" });
		const second = service.onWorkerDetach({ workerId: "worker_1" });
		expect(first).toHaveLength(1);
		expect(second).toHaveLength(1);
		expect(worker.revocations).toHaveLength(1);
		expect(service.get(issued.leaseId)?.status).toBe("settled");
	});

	it("fails closed and quarantines a missing or rejecting Worker target", () => {
		const unconfigured = makeService(new WorkerTarget());
		expect(unconfigured.service.issueForTaskRun(issueContext())).toEqual({ ok: false, code: "task_credential_target_unavailable" });

		const missingWorker = new WorkerTarget();
		const missing = makeService(missingWorker, { workerTargets: new Map([["worker_other", missingWorker]]) });
		const unavailable = missing.service.issueForTaskRun(issueContext());
		expect(unavailable).toEqual({ ok: false, code: "task_credential_target_unavailable" });

		const rejectingWorker = new WorkerTarget();
		rejectingWorker.projectResult = false;
		const rejecting = makeService(rejectingWorker);
		const failed = rejecting.service.issueForTaskRun(issueContext(rejectingWorker));
		expect(failed).toEqual({ ok: false, code: "task_credential_target_unavailable" });
		expect(rejecting.service.isTargetQuarantined("worker_1")).toBe(true);
		expect(rejecting.service.issueForTaskRun(issueContext(new WorkerTarget()))).toEqual({ ok: false, code: "task_credential_target_unavailable" });
	});

	it("continues authoritative revoke and settlement after Worker revoke failure", () => {
		const worker = new WorkerTarget();
		worker.revokeResult = false;
		const harness = makeService(worker);
		const issued = harness.service.issueForTaskRun(issueContext(worker));
		expect(issued.ok).toBe(true);
		if (!issued.ok) return;

		const command = harness.service.revoke({ leaseId: issued.leaseId, clientRequestId: "revoke_command", gate: { status: "approved", stageRevision: 1 }, nodeAttached: true });
		expect(command.ok).toBe(true);
		expect(harness.service.isTargetQuarantined("worker_1")).toBe(true);
		const settled = harness.service.settle({ leaseId: issued.leaseId, clientRequestId: "settle_command" });
		expect(settled.ok).toBe(true);
		expect(harness.service.get(issued.leaseId)?.status).toBe("settled");

		const lifecycleWorker = new WorkerTarget();
		lifecycleWorker.revokeResult = false;
		const lifecycle = makeService(lifecycleWorker);
		const lifecycleIssued = lifecycle.service.issueForTaskRun(issueContext(lifecycleWorker));
		expect(lifecycleIssued.ok).toBe(true);
		if (!lifecycleIssued.ok) return;
		const lifecycleOutcome = lifecycle.service.onRunTerminal({ runId: "run_worker", status: "completed" });
		expect(lifecycleOutcome[0]).toMatchObject({ action: "revoked", settled: true });

		const cancelWorker = new WorkerTarget();
		cancelWorker.revokeResult = false;
		const cancel = makeService(cancelWorker);
		const cancelIssued = cancel.service.issueForTaskRun(issueContext(cancelWorker));
		expect(cancelIssued.ok).toBe(true);
		if (!cancelIssued.ok) return;
		const cancelOutcome = cancel.service.onRunCancelRequested("run_worker");
		expect(cancelOutcome[0]).toMatchObject({ action: "revoked", settled: false });
		expect(cancel.service.onRunTerminal({ runId: "run_worker", status: "cancelled" })[0]).toMatchObject({ settled: true });
	});

	it("cleans up provider state after project and renew Worker failures", () => {
		const projectWorker = new WorkerTarget();
		projectWorker.projectResult = false;
		const project = makeService(projectWorker);
		expect(project.service.issueForTaskRun(issueContext(projectWorker))).toEqual({ ok: false, code: "task_credential_target_unavailable" });
		expect(project.service.getByRunId("run_worker")[0]?.status).toBe("revoked");

		const renewWorker = new WorkerTarget();
		const renew = makeService(renewWorker);
		const issued = renew.service.issueForTaskRun(issueContext(renewWorker));
		expect(issued.ok).toBe(true);
		if (!issued.ok) return;
		renewWorker.renewResult = false;
		renew.clock.nowMs += 10_000;
		const result = renew.service.renew({ leaseId: issued.leaseId, grantId: issued.grant.grantId, bindingId: issued.bindingId, heartbeatSequence: 1, requestedTtlMs: 60_000, clientRequestId: "renew_worker", gate: { status: "approved", stageRevision: 1 }, nodeAttached: true });
		expect(result).toEqual({ ok: false, code: "task_credential_target_unavailable" });
		expect(renew.service.get(issued.leaseId)?.status).toBe("settled");
	});

	it("does not revive an old Worker target after reload", () => {
		const oldWorker = new WorkerTarget();
		const session = new FakeSession();
		const first = makeService(oldWorker, { session });
		const issued = first.service.issueForTaskRun(issueContext(oldWorker));
		expect(issued.ok).toBe(true);
		const reloaded = makeService(new WorkerTarget(), { session, workerTargets: new Map() });
		const replay = reloaded.service.issueForTaskRun(issueContext());
		expect(replay).toEqual({ ok: false, code: "task_credential_target_unavailable" });
		expect(oldWorker.projections).toHaveLength(1);
	});

	it("rejects malformed Worker target results without accepting material-bearing input", () => {
		const malformedSuccess = (): { readonly ok: true; readonly extra: true } => ({ ok: true, extra: true });
		const worker: TaskCredentialWorkerTarget = {
			project: malformedSuccess,
			renew: malformedSuccess,
			revoke: malformedSuccess,
		};
		const { service } = makeService(new WorkerTarget());
		const failed = service.issueForTaskRun(issueContext(worker));
		expect(failed.ok).toBe(false);
		if (!failed.ok) expect(failed.code).toBe("task_credential_target_unavailable");
		const entries = service.snapshot();
		expect(JSON.stringify(entries)).not.toContain(SECRET);
	});
});
