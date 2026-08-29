import {
	type AgentBinding,
	type BudgetUsage,
	createConnectorCapabilitySnapshot,
	createRoleRevision,
	FoundationError,
	type FoundationProviderCapability,
	fingerprintFoundationValue,
	InMemorySessionStorage,
	type ModelProfile,
	type QuotaAttribution,
	type QuotaProvider,
	type QuotaReservation,
	Result,
	type RevisionReference,
	resolveAgentBinding,
	Session,
	type TaskEnvelope,
} from "@aos-agent/agent-core";
import { describe, expect, it } from "vitest";
import type { SchedulerExecutorEntry, SchedulerQueueEntry } from "../src/core/scheduler.ts";
import {
	createSchedulerExecutorRuntimeSnapshot,
	SCHEDULER_IN_PROCESS_CAPABILITY_ID,
	SchedulerExecutorRegistry,
	SchedulerInProcessTaskExecutorProvider,
	schedulerBindingRequirementDigest,
} from "../src/core/scheduler-executors.ts";
import {
	SchedulerSelectionReservationStore,
	type SchedulerSelectionSettlementReason,
} from "../src/core/scheduler-selection-reservations.ts";

const NOW = "2026-08-21T12:00:00.000Z";
const TASK_CAPABILITY: FoundationProviderCapability = {
	schemaVersion: 1,
	id: SCHEDULER_IN_PROCESS_CAPABILITY_ID,
	version: 1,
};

function immutableBindingFact(type: string, id: string): RevisionReference {
	const payload = { schemaVersion: 1 as const, type, id, revision: 1 };
	return { ...payload, fingerprint: fingerprintFoundationValue(payload) };
}

function taskEnvelope(): TaskEnvelope {
	return {
		schemaVersion: 1,
		taskId: "task_1",
		goalId: "goal_1",
		goal: "Reserve one scheduler executor",
		workspace: "workspace_scheduler_reservations",
		capabilityRefs: [],
		inputs: [],
		expectedOutputs: [],
		budget: { tokens: 10 },
		acceptanceCriteria: [],
		status: "ready",
		createdAt: NOW,
		updatedAt: NOW,
	};
}

function binding(): AgentBinding {
	const roleRevision = createRoleRevision({
		definition: {
			schemaVersion: 1,
			roleId: "role_1",
			scope: "project",
			slug: "worker",
			name: "Worker",
			description: "Runs a task",
			revision: 1,
			persona: "Run the task.",
			modelProfileRef: { schemaVersion: 1, type: "model_profile", id: "profile_1", revision: 1 },
			capabilitySelector: { policy: "all" },
			skillSelector: { policy: "none" },
			mcpSelector: { policy: "none" },
		},
		now: () => NOW,
	});
	const modelBase = {
		schemaVersion: 1 as const,
		modelProfileId: "profile_1",
		provider: "none",
		model: "none",
		budget: { tokens: 10 },
		revision: 1,
		createdAt: NOW,
	};
	const modelProfile: ModelProfile = { ...modelBase, fingerprint: fingerprintFoundationValue(modelBase) };
	const resolved = resolveAgentBinding({
		task: taskEnvelope(),
		roleRevision,
		modelProfile,
		contextRevision: immutableBindingFact("external_agent_binding", "external_1"),
		capabilityRevision: immutableBindingFact("capability_binding", "capability_1"),
		modelBrokerBindingRevision: immutableBindingFact("model_broker_binding", "model_broker_1"),
		policyRevision: immutableBindingFact("policy_binding", "policy_1"),
		newBindingId: "binding_1",
		now: () => NOW,
	});
	if (!resolved.ok) throw resolved.error;
	return resolved.value;
}

function queueEntry(queueEntryId: string): SchedulerQueueEntry {
	return {
		schemaVersion: 1,
		queueEntryId,
		sessionId: "session_1",
		taskId: "task_1",
		goalId: "goal_1",
		state: "queued",
		priority: 1,
		attemptsUsed: 0,
		enqueuedAt: NOW,
		revision: 0,
	};
}

function executorEntry(providerId: string): SchedulerExecutorEntry {
	return {
		schemaVersion: 1,
		descriptor: { schemaVersion: 1, providerId, providerClass: "task_executor" },
		capabilities: [TASK_CAPABILITY],
		costClass: "local",
		registeredAt: NOW,
	};
}

function runtimeSnapshot(providerId: string, bindingValue: AgentBinding) {
	const bindingDigest = schedulerBindingRequirementDigest(bindingValue);
	if (!bindingDigest.ok) throw bindingDigest.error;
	if (bindingValue.policyRevision.fingerprint === undefined) throw new Error("policy fingerprint missing");
	const created = createSchedulerExecutorRuntimeSnapshot({
		schemaVersion: 1,
		capabilitySnapshot: createConnectorCapabilitySnapshot({
			schemaVersion: 1,
			providerId,
			revision: 1,
			protocol: { name: "scheduler-test", version: "1" },
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
		credentialTargetRefs: ["credential:test"],
		sandboxTargetRefs: ["sandbox:test"],
		observedAt: NOW,
		expiresAt: "2026-08-21T14:00:00.000Z",
	});
	if (!created.ok) throw created.error;
	return created.value;
}

class CountingQuota implements QuotaProvider {
	readonly schemaVersion = 1 as const;
	readonly providerId = "quota.scheduler-selection";
	readonly providerClass = "quota" as const;
	reserveCount = 0;
	settleAttempts = 0;
	settleCount = 0;
	failNextSettlement = false;
	lastUsage: BudgetUsage | undefined;
	readonly settlementReservationIds: string[] = [];

	async capabilities(): Promise<readonly FoundationProviderCapability[]> {
		return [];
	}

	async reserve(attribution: QuotaAttribution, budget: QuotaReservation["budget"]) {
		this.reserveCount += 1;
		return Result.ok({
			schemaVersion: 1 as const,
			reservationId: `quota_reservation_${this.reserveCount}`,
			attribution,
			budget,
			grantedAt: NOW,
		});
	}

	async settle(reservation: QuotaReservation, usage: BudgetUsage) {
		this.settleAttempts += 1;
		this.settlementReservationIds.push(reservation.reservationId);
		if (this.failNextSettlement) {
			this.failNextSettlement = false;
			return Result.err(new FoundationError("quota_exceeded", "Injected quota settlement failure"));
		}
		this.settleCount += 1;
		this.lastUsage = usage;
		return Result.ok(usage);
	}

	async dispose(): Promise<void> {}
}

class FailOnceSession extends Session {
	failNextFoundationAppend = false;

	override appendFoundationRecord(
		record: Parameters<Session["appendFoundationRecord"]>[0],
	): ReturnType<Session["appendFoundationRecord"]> {
		if (this.failNextFoundationAppend) {
			this.failNextFoundationAppend = false;
			return Promise.reject(new Error("injected selection persistence failure"));
		}
		return super.appendFoundationRecord(record);
	}
}

async function configuredRegistry(session: Session, quota: CountingQuota, ownerId: string, providerId: string) {
	const bindingValue = binding();
	const store = new SchedulerSelectionReservationStore(session, { ownerId, now: () => NOW });
	const registry = new SchedulerExecutorRegistry({ reservationStore: store });
	const provider = new SchedulerInProcessTaskExecutorProvider({ providerId, now: () => NOW });
	const registered = await registry.register({
		entry: executorEntry(providerId),
		provider,
		trusted: true,
		latencyMs: 0,
		maxConcurrency: 1,
		runtimeSnapshot: runtimeSnapshot(providerId, bindingValue),
		quota,
		budget: { tokens: 10 },
	});
	if (!registered.ok) throw registered.error;
	return { bindingValue, registry, store };
}

async function reserve(registry: SchedulerExecutorRegistry, bindingValue: AgentBinding, queueEntryId: string) {
	return registry.select({
		queueEntry: queueEntry(queueEntryId),
		requiredCapabilities: [TASK_CAPABILITY],
		decidedAt: NOW,
		exactRequirements: {
			binding: bindingValue,
			attemptId: `attempt_${queueEntryId}`,
			bindingEpochId: `epoch_${queueEntryId}`,
			requireResume: true,
			modelAccess: "aos_gateway",
			credentialTargetRefs: ["credential:test"],
			sandboxTargetRefs: ["sandbox:test"],
		},
	});
}

describe("Session-backed Scheduler selection reservation lifecycle", () => {
	it("settles every terminal path exactly once, including repeated settlement", async () => {
		const reasons: readonly SchedulerSelectionSettlementReason[] = [
			"succeeded",
			"failed",
			"rejected",
			"cancelled",
			"timeout",
			"runner_throw",
			"persistence_failure",
		];
		for (const reason of reasons) {
			const quota = new CountingQuota();
			const session = new Session(new InMemorySessionStorage({ id: `terminal-${reason}`, createdAt: 1 }));
			const configured = await configuredRegistry(session, quota, `owner-${reason}`, `provider.${reason}`);
			const selected = await reserve(configured.registry, configured.bindingValue, `queue_${reason}`);
			expect(selected.ok, reason).toBe(true);
			const canonicalUsage = {
				inputTokens: 1,
				outputTokens: 2,
				cacheReadInputTokens: 3,
				cacheCreationInputTokens: 4,
				costUsd: 0.5,
			};
			const usage = reason === "succeeded" || reason === "failed" ? canonicalUsage : {};
			const first = await configured.registry.settleSelection(`queue_${reason}`, reason, usage);
			const second = await configured.registry.settleSelection(`queue_${reason}`, reason, usage);
			expect(first.ok, reason).toBe(true);
			expect(second.ok, reason).toBe(true);
			expect(quota.reserveCount, reason).toBe(1);
			expect(quota.settleCount, reason).toBe(1);
			expect(quota.lastUsage, reason).toEqual(
				reason === "succeeded" || reason === "failed" ? { tokens: 10, costUsd: 0.5 } : {},
			);
			const record = await configured.registry.reservationRecord(`queue_${reason}`);
			expect(record.ok, reason).toBe(true);
			if (record.ok) {
				expect(record.value?.status, reason).toBe("settled");
				expect(record.value?.settlementReason, reason).toBe(reason);
			}
			await configured.store.release();
		}
	});

	it("compensates quota exactly once when the immutable SelectionFact cannot persist", async () => {
		const quota = new CountingQuota();
		const session = new FailOnceSession(new InMemorySessionStorage({ id: "persist-failure", createdAt: 1 }));
		const configured = await configuredRegistry(session, quota, "persist-owner", "provider.persist-failure");
		session.failNextFoundationAppend = true;
		const selected = await reserve(configured.registry, configured.bindingValue, "queue_persist_failure");
		expect(selected.ok).toBe(false);
		if (!selected.ok) expect(selected.error.code).toBe("scheduler_persistence_failed");
		expect(quota.reserveCount).toBe(1);
		expect(quota.settleCount).toBe(1);
		expect(quota.lastUsage).toEqual({});
		const record = await configured.registry.reservationRecord("queue_persist_failure");
		expect(record.ok).toBe(true);
		if (record.ok) expect(record.value).toBeUndefined();
		await configured.store.release();
	});

	it("resumes the same durable quota settlement after restart", async () => {
		const storage = new InMemorySessionStorage({ id: "settlement-restart", createdAt: 1 });
		const quota = new CountingQuota();
		quota.failNextSettlement = true;
		const first = await configuredRegistry(
			new Session(storage),
			quota,
			"settlement-owner-1",
			"provider.settlement-restart",
		);
		const selected = await reserve(first.registry, first.bindingValue, "queue_settlement_restart");
		expect(selected.ok).toBe(true);
		const usage = {
			inputTokens: 1,
			outputTokens: 2,
			cacheReadInputTokens: 3,
			cacheCreationInputTokens: 4,
			costUsd: 0.5,
		};
		const failed = await first.registry.settleSelection("queue_settlement_restart", "failed", usage);
		expect(failed.ok).toBe(false);
		if (!failed.ok) expect(failed.error.code).toBe("scheduler_budget_exhausted_wait");
		expect(quota.settleAttempts).toBe(1);
		expect(quota.settleCount).toBe(0);
		const pending = await first.registry.reservationRecord("queue_settlement_restart");
		if (!pending.ok) throw pending.error;
		if (pending.value === undefined) throw new Error("durable settlement reservation missing");
		expect(pending.value).toMatchObject({
			status: "reconcile_required",
			settlementReason: "failed",
			usage: { tokens: 10, costUsd: 0.5 },
		});
		const reservationId = pending.value.fact.quotaReservation?.reservationId;
		if (reservationId === undefined) throw new Error("quota reservation missing");
		await first.store.release();

		const second = await configuredRegistry(
			new Session(storage),
			quota,
			"settlement-owner-2",
			"provider.settlement-restart",
		);
		const reconciled = await second.registry.reconcileReservations([]);
		expect(reconciled.ok).toBe(true);
		expect(quota.settleAttempts).toBe(2);
		expect(quota.settleCount).toBe(1);
		expect(quota.settlementReservationIds).toEqual([reservationId, reservationId]);
		const settled = await second.registry.reservationRecord("queue_settlement_restart");
		expect(settled.ok).toBe(true);
		if (settled.ok) {
			expect(settled.value).toMatchObject({
				status: "settled",
				settlementReason: "failed",
				usage: { tokens: 10, costUsd: 0.5 },
			});
		}
		const repeated = await second.registry.reconcileReservations([]);
		expect(repeated.ok).toBe(true);
		expect(quota.settleAttempts).toBe(2);
		expect(quota.settleCount).toBe(1);
		await second.store.release();
	});

	it("reconciles abandoned and interrupted reservations once", async () => {
		const storage = new InMemorySessionStorage({ id: "restart-reconcile", createdAt: 1 });
		const quota = new CountingQuota();
		const first = await configuredRegistry(new Session(storage), quota, "restart-owner-1", "provider.restart");
		const selected = await reserve(first.registry, first.bindingValue, "queue_restart");
		expect(selected.ok).toBe(true);
		await first.store.release();

		const second = await configuredRegistry(new Session(storage), quota, "restart-owner-2", "provider.restart");
		const reconciled = await second.registry.reconcileReservations([]);
		const reconciledAgain = await second.registry.reconcileReservations([]);
		expect(reconciled.ok).toBe(true);
		expect(reconciledAgain.ok).toBe(true);
		expect(quota.reserveCount).toBe(1);
		expect(quota.settleCount).toBe(1);
		const record = await second.registry.reservationRecord("queue_restart");
		expect(record.ok).toBe(true);
		if (record.ok) expect(record.value?.status).toBe("settled");

		const selectedInterrupted = await reserve(second.registry, second.bindingValue, "queue_interrupted");
		expect(selectedInterrupted.ok).toBe(true);
		const began = await second.store.beginSettlement("queue_interrupted", "failed", { tokens: 1 });
		expect(began.ok).toBe(true);
		await second.store.release();

		const third = await configuredRegistry(new Session(storage), quota, "restart-owner-3", "provider.restart");
		const interrupted = await third.registry.reconcileReservations(["queue_interrupted"]);
		expect(interrupted.ok).toBe(true);
		expect(quota.settleCount).toBe(2);
		expect(quota.lastUsage).toEqual({ tokens: 1 });
		const interruptedRecord = await third.registry.reservationRecord("queue_interrupted");
		expect(interruptedRecord.ok).toBe(true);
		if (interruptedRecord.ok) {
			expect(interruptedRecord.value).toMatchObject({
				status: "settled",
				settlementReason: "failed",
				usage: { tokens: 1 },
			});
		}
		const interruptedAgain = await third.registry.reconcileReservations([]);
		expect(interruptedAgain.ok).toBe(true);
		expect(quota.settleCount).toBe(2);
		await third.store.release();
	});
});
