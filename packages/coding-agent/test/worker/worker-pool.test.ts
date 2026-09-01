import {
	type AgentBinding,
	createConnectorCapabilitySnapshot,
	createRoleRevision,
	fingerprintFoundationValue,
	InMemorySessionStorage,
	type ModelProfile,
	resolveAgentBinding,
	Session,
	type TaskEnvelope,
} from "../../../agent/src/internal.ts";
import { describe, expect, it, vi } from "vitest";
import {
	createSchedulerExecutorRuntimeSnapshot,
	SCHEDULER_IN_PROCESS_CAPABILITY_ID,
	SchedulerExecutorRegistry,
	SchedulerInProcessTaskExecutorProvider,
	schedulerBindingRequirementDigest,
} from "../../src/core/scheduler/executors.ts";
import { SchedulerSelectionReservationStore } from "../../src/core/scheduler/selection-reservations.ts";
import { WorkerPoolRegistry, type WorkerPoolAssignmentInput } from "../../src/core/worker/pool.ts";

const NOW = "2026-08-21T12:00:00.000Z";
const READY_AT = "2026-08-21T12:00:01.000Z";
const TASK_CAPABILITY = {
	schemaVersion: 1 as const,
	id: SCHEDULER_IN_PROCESS_CAPABILITY_ID,
	version: 1,
};

function immutableBindingFact(type: string, id: string) {
	const payload = { schemaVersion: 1 as const, type, id, revision: 1 };
	return { ...payload, fingerprint: fingerprintFoundationValue(payload) };
}

function taskEnvelope(): TaskEnvelope {
	return {
		schemaVersion: 1,
		taskId: "task_pool",
		goalId: "goal_pool",
		goal: "Run one pool task",
		workspace: "workspace_pool",
		capabilityRefs: [],
		inputs: [],
		expectedOutputs: [],
		budget: {},
		acceptanceCriteria: [],
		status: "ready",
		createdAt: NOW,
		updatedAt: NOW,
	};
}

function binding(): AgentBinding {
	const role = createRoleRevision({
		definition: {
			schemaVersion: 1,
			roleId: "role_pool",
			scope: "project",
			slug: "pool-worker",
			name: "Pool Worker",
			description: "Runs pool work",
			revision: 1,
			persona: "Run the assigned task.",
			modelProfileRef: { schemaVersion: 1, type: "model_profile", id: "profile_pool", revision: 1 },
			capabilitySelector: { policy: "all" },
			skillSelector: { policy: "none" },
			mcpSelector: { policy: "none" },
		},
		now: () => NOW,
	});
	const profileBase = {
		schemaVersion: 1 as const,
		modelProfileId: "profile_pool",
		provider: "none",
		model: "none",
		budget: {},
		revision: 1,
		createdAt: NOW,
	};
	const modelProfile: ModelProfile = { ...profileBase, fingerprint: fingerprintFoundationValue(profileBase) };
	const resolved = resolveAgentBinding({
		task: taskEnvelope(),
		roleRevision: role,
		modelProfile,
		contextRevision: immutableBindingFact("external_agent_binding", "external_pool"),
		capabilityRevision: immutableBindingFact("capability_binding", "capability_pool"),
		modelBrokerBindingRevision: immutableBindingFact("model_broker_binding", "model_broker_pool"),
		policyRevision: immutableBindingFact("policy_binding", "policy_pool"),
		newBindingId: "binding_pool",
		now: () => NOW,
	});
	if (!resolved.ok) throw resolved.error;
	return resolved.value;
}

function poolHarness() {
	const session = new Session(new InMemorySessionStorage({ id: `pool-${Math.random()}`, createdAt: 1 }));
	const reservations = new SchedulerSelectionReservationStore(session, { ownerId: "pool-owner", now: () => NOW });
	const scheduler = new SchedulerExecutorRegistry({ reservationStore: reservations });
	return {
		pool: new WorkerPoolRegistry({ poolId: "self-hosted", scheduler }),
		reservations,
	};
}

function memberRegistration(
	workerId: string,
	providerId: string,
	locality: "local" | "remote",
	maxConcurrency: number,
) {
	const bindingValue = binding();
	const bindingDigest = schedulerBindingRequirementDigest(bindingValue);
	if (!bindingDigest.ok) throw bindingDigest.error;
	if (bindingValue.policyRevision.fingerprint === undefined) throw new Error("Policy fingerprint is missing");
	const runtime = createSchedulerExecutorRuntimeSnapshot({
		schemaVersion: 1,
		capabilitySnapshot: createConnectorCapabilitySnapshot({
			schemaVersion: 1,
			providerId,
			revision: 1,
			protocol: { name: "worker-pool-test", version: "1" },
			modelAccess: "aos_gateway",
			resume: true,
			toolGateway: true,
			artifacts: true,
			images: false,
		}),
		configRevision: fingerprintFoundationValue(`config:${providerId}`),
		bindingRequirementDigests: [bindingDigest.value],
		toolSelectionDigests: [bindingValue.mcpSelection.digest],
		policyRevisionDigests: [bindingValue.policyRevision.fingerprint],
		reviewRevisionDigests: [],
		credentialTargetRefs: [],
		sandboxTargetRefs: [],
		observedAt: NOW,
		expiresAt: "2026-08-21T14:00:00.000Z",
	});
	if (!runtime.ok) throw runtime.error;
	const provider = new SchedulerInProcessTaskExecutorProvider({ providerId, now: () => NOW });
	return {
		workerId,
		machineId: locality === "local" ? "machine-local" : `machine-${workerId}`,
		locality,
		maxConcurrency,
		heartbeatTimeoutMs: 10_000,
		registeredAt: NOW,
		scheduler: {
			entry: {
				schemaVersion: 1 as const,
				descriptor: { schemaVersion: 1 as const, providerId, providerClass: "task_executor" as const },
				capabilities: [TASK_CAPABILITY],
				costClass: locality === "local" ? ("local" as const) : ("remote_paid" as const),
				registeredAt: NOW,
			},
			provider,
			trusted: true,
			latencyMs: locality === "local" ? 0 : 25,
			maxConcurrency,
			runtimeSnapshot: runtime.value,
		},
	};
}

function assignmentInput(
	queueEntryId: string,
	attemptId: string,
	reconcile?: NonNullable<WorkerPoolAssignmentInput["reconcile"]>,
) {
	return {
		queueEntry: {
			schemaVersion: 1 as const,
			queueEntryId,
			sessionId: "session_pool",
			taskId: "task_pool",
			state: "queued" as const,
			priority: 10,
			attemptsUsed: 0,
			enqueuedAt: NOW,
			revision: 0,
		},
		requiredCapabilities: [TASK_CAPABILITY],
		decidedAt: READY_AT,
		exactRequirements: {
			binding: binding(),
			attemptId,
			bindingEpochId: `epoch_${attemptId}`,
			requireResume: true,
			modelAccess: "aos_gateway" as const,
		},
		...(reconcile === undefined ? {} : { reconcile }),
	};
}

describe("WorkerPoolRegistry", () => {
	it("moves a local member through register, heartbeat, running, ready, and release", async () => {
		const { pool, reservations } = poolHarness();
		try {
			const registered = pool.register(memberRegistration("local-1", "pool.local-1", "local", 1));
			expect(registered).toMatchObject({ ok: true, value: { status: "starting", activeClaims: 0 } });
			const ready = await pool.heartbeat({ workerId: "local-1", sequence: 1, at: READY_AT });
			expect(ready).toMatchObject({ ok: true, value: { status: "ready" } });
			expect(pool.binding("local-1")).toEqual({
				schemaVersion: 1,
				poolId: "self-hosted",
				workerId: "local-1",
				machineId: "machine-local",
				locality: "local",
				maxConcurrency: 1,
			});

			const assigned = await pool.assign(assignmentInput("queue-local-1", "attempt-local-1"));
			expect(assigned).toMatchObject({ ok: true, value: { workerId: "local-1" } });
			expect(pool.get("local-1")).toMatchObject({ status: "running", activeClaims: 1 });
			const blocked = await pool.assign(assignmentInput("queue-local-2", "attempt-local-2"));
			expect(blocked).toMatchObject({ ok: false, error: { code: "scheduler_backpressure" } });

			const settled = await pool.settle("queue-local-1");
			expect(settled).toMatchObject({ ok: true, value: { status: "ready", activeClaims: 0 } });
			const released = await pool.release("local-1");
			expect(released).toMatchObject({ ok: true, value: { status: "release" } });
		} finally {
			await reservations.release();
		}
	});

	it("honors the summed per-member capacity across local and remote machines", async () => {
		const { pool, reservations } = poolHarness();
		try {
			pool.register(memberRegistration("local-1", "pool.local-1", "local", 1));
			pool.register(memberRegistration("remote-1", "pool.remote-1", "remote", 2));
			await pool.heartbeat({ workerId: "local-1", sequence: 1, at: READY_AT });
			await pool.heartbeat({ workerId: "remote-1", sequence: 1, at: READY_AT });
			const results = await Promise.all([
				pool.assign(assignmentInput("queue-capacity-1", "attempt-capacity-1")),
				pool.assign(assignmentInput("queue-capacity-2", "attempt-capacity-2")),
				pool.assign(assignmentInput("queue-capacity-3", "attempt-capacity-3")),
				pool.assign(assignmentInput("queue-capacity-4", "attempt-capacity-4")),
			]);
			expect(results.filter((result) => result.ok)).toHaveLength(3);
			expect(results.filter((result) => !result.ok)).toMatchObject([
				{ error: { code: "scheduler_backpressure" } },
			]);
			const records = await reservations.list();
			expect(records).toMatchObject({ ok: true });
			if (records.ok) {
				expect(records.value.filter((record) => record.status === "reserved")).toHaveLength(3);
			}
		} finally {
			await reservations.release();
		}
	});

	it("reconciles in-flight claims through the existing path when heartbeat liveness is lost", async () => {
		const { pool, reservations } = poolHarness();
		try {
			pool.register(memberRegistration("remote-1", "pool.remote-1", "remote", 1));
			await pool.heartbeat({ workerId: "remote-1", sequence: 1, at: READY_AT });
			const reconcile = vi.fn(async () => ({ ok: true as const, value: undefined }));
			await pool.assign(assignmentInput("queue-lost-1", "attempt-lost-1", reconcile));

			const expired = await pool.reconcileExpired("2026-08-21T12:00:12.000Z");
			expect(expired).toMatchObject({
				ok: true,
				value: [{ workerId: "remote-1", status: "lost", activeClaims: 0 }],
			});
			expect(reconcile).toHaveBeenCalledTimes(1);
			const reservation = await reservations.get("queue-lost-1");
			expect(reservation).toMatchObject({
				ok: true,
				value: { status: "settled", settlementReason: "restart_reconciled" },
			});
			const unavailable = await pool.assign(assignmentInput("queue-after-lost", "attempt-after-lost"));
			expect(unavailable).toMatchObject({ ok: false, error: { code: "scheduler_no_executor" } });
		} finally {
			await reservations.release();
		}
	});
});
