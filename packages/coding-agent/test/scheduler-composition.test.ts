import {
	type AgentBinding,
	type AttemptReceipt,
	type Attempt,
	type BudgetUsage,
	createConnectorCapabilitySnapshot,
	createModelProfileRevision,
	createRoleRevision,
	fingerprintFoundationValue,
	FoundationError,
	InMemorySessionStorage,
	type ModelProfile,
	resolveAgentBinding,
	Result,
	type RevisionReference,
	Session,
	SessionLedger,
	type TaskEnvelope,
	type FoundationProviderExecutionOptions,
	type FoundationProviderCapability,
	type QuotaAttribution,
	type QuotaProvider,
	type QuotaReservation,
} from "@aos-agent/agent-core";
import { describe, expect, it, vi } from "vitest";
import {
	SchedulerComposition,
	type SchedulerCompositionOptions,
} from "../src/core/foundation-control-plane.ts";
import { SchedulerDeadlockController } from "../src/core/scheduler/deadlock.ts";
import {
	SCHEDULER_IN_PROCESS_CAPABILITY_ID,
	createSchedulerExecutorRuntimeSnapshot,
	SchedulerExecutorRegistry,
	SchedulerInProcessTaskExecutorProvider,
	schedulerBindingRequirementDigest,
} from "../src/core/scheduler/executors.ts";
import { SchedulerFanInController } from "../src/core/scheduler/fan-in.ts";
import { SchedulerHandoffController } from "../src/core/scheduler/handoff.ts";
import { SchedulerMessageOrchestrator } from "../src/core/scheduler/messages.ts";
import { SchedulerWorkflowController } from "../src/core/scheduler/workflow.ts";
import { SchedulerQueueStore } from "../src/core/scheduler/queue.ts";
import { SchedulerSelectionReservationStore } from "../src/core/scheduler/selection-reservations.ts";
import type { RunHandle } from "../src/core/run-lifecycle.ts";
import { SchedulerHost, type SchedulerQueueEntry } from "../src/core/scheduler/host.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { observeCanonicalTerminal } from "./support/canonical-run-terminal.ts";
import { TaskGraphStore } from "../src/core/scheduler/task-graph.ts";
import { withRuntimeClock } from "../src/core/runtime-clock.ts";
import { DeterministicClock } from "./support/deterministic-clock.ts";

const NOW = "2026-08-22T00:00:00.000Z";
const RUN_MODEL = { provider: "host", id: "host", thinkingLevel: "off" as const };
const TASK_CAPABILITY: FoundationProviderCapability = {
	schemaVersion: 1,
	id: SCHEDULER_IN_PROCESS_CAPABILITY_ID,
	version: 1,
};

function task(): TaskEnvelope {
	return {
		schemaVersion: 1,
		taskId: "task-composition",
		goalId: "goal-composition",
		goal: "Exercise scheduler composition",
		workspace: "workspace-composition",
		capabilityRefs: [],
		inputs: [],
		expectedOutputs: [],
		budget: { tokens: 100, concurrency: 1 },
		acceptanceCriteria: [],
		status: "ready",
		createdAt: NOW,
		updatedAt: NOW,
	};
}

function roleRevision() {
	return createRoleRevision({
		definition: {
			schemaVersion: 1,
			roleId: "role-composition",
			scope: "project",
			slug: "scheduler-composition",
			name: "Scheduler composition",
			description: "Runs the production Scheduler composition test",
			revision: 1,
			persona: "Execute scheduler work.",
			modelProfileRef: { schemaVersion: 1, type: "model_profile", id: "profile-composition", revision: 1 },
			capabilitySelector: { policy: "all" },
			skillSelector: { policy: "none" },
			mcpSelector: { policy: "none" },
		},
		now: () => NOW,
	});
}

function modelProfile(): ModelProfile {
	return createModelProfileRevision({
		schemaVersion: 1,
		modelProfileId: "profile-composition",
		provider: "host",
		model: "host",
		budget: { tokens: 100 },
		revision: 1,
		createdAt: NOW,
	});
}

function immutableFact(type: string, id: string): RevisionReference {
	const value = { schemaVersion: 1 as const, type, id, revision: 1 };
	return { ...value, fingerprint: fingerprintFoundationValue(value) };
}

function bindingFor(currentTask: TaskEnvelope): AgentBinding {
	const resolved = resolveAgentBinding({
		task: currentTask,
		roleRevision: roleRevision(),
		modelProfile: modelProfile(),
		contextRevision: immutableFact("external_agent_binding", "context-composition"),
		capabilityRevision: immutableFact("capability_binding", "capability-composition"),
		modelBrokerBindingRevision: immutableFact("model_broker_binding", "broker-composition"),
		policyRevision: immutableFact("policy_binding", "policy-composition"),
		newBindingId: "binding-composition",
		now: () => NOW,
	});
	if (!resolved.ok) throw resolved.error;
	return resolved.value;
}

function reservationRuntimeSnapshot(providerId: string, binding: AgentBinding, now: string) {
	const bindingDigest = schedulerBindingRequirementDigest(binding);
	if (!bindingDigest.ok) throw bindingDigest.error;
	if (binding.policyRevision.fingerprint === undefined) throw new Error("policy fingerprint missing");
	const snapshot = createSchedulerExecutorRuntimeSnapshot({
		schemaVersion: 1,
		capabilitySnapshot: createConnectorCapabilitySnapshot({
			schemaVersion: 1,
			providerId,
			revision: 1,
			protocol: { name: "scheduler-restart-test", version: "1" },
			modelAccess: "aos_gateway",
			resume: true,
			toolGateway: true,
			artifacts: true,
			images: false,
		}),
		configRevision: fingerprintFoundationValue(`config:${providerId}`),
		bindingRequirementDigests: [bindingDigest.value],
		toolSelectionDigests: [binding.mcpSelection.digest],
		policyRevisionDigests: [binding.policyRevision.fingerprint],
		reviewRevisionDigests: [],
		credentialTargetRefs: [],
		sandboxTargetRefs: [],
		observedAt: now,
		expiresAt: "2026-08-22T02:00:00.000Z",
	});
	if (!snapshot.ok) throw snapshot.error;
	return snapshot.value;
}

class RestartQuota implements QuotaProvider {
	readonly schemaVersion = 1 as const;
	readonly providerId = "quota.scheduler-restart";
	readonly providerClass = "quota" as const;
	reserveCount = 0;
	settleAttempts = 0;
	settleCount = 0;
	failNextSettlement = false;
	onSettle: (() => void) | undefined;

	async capabilities(): Promise<readonly FoundationProviderCapability[]> {
		return [];
	}

	async reserve(attribution: QuotaAttribution, budget: QuotaReservation["budget"]) {
		this.reserveCount += 1;
		return Result.ok({
			schemaVersion: 1 as const,
			reservationId: `restart_quota_${this.reserveCount}`,
			attribution,
			budget,
			grantedAt: NOW,
		});
	}

	async settle(_reservation: QuotaReservation, usage: BudgetUsage) {
		this.settleAttempts += 1;
		this.onSettle?.();
		if (this.failNextSettlement) {
			this.failNextSettlement = false;
			return Result.err(new FoundationError("quota_exceeded", "Injected restart settlement failure"));
		}
		this.settleCount += 1;
		return Result.ok(usage);
	}

	async dispose(): Promise<void> {}
}

async function registerReservationExecutor(
	registry: SchedulerExecutorRegistry,
	quota: RestartQuota,
	binding: AgentBinding,
	now: string,
): Promise<void> {
	const provider = new SchedulerInProcessTaskExecutorProvider({ providerId: "scheduler.restart", now: () => now });
	const registered = await registry.register({
		entry: {
			schemaVersion: 1,
			descriptor: { schemaVersion: 1, providerId: provider.providerId, providerClass: "task_executor" },
			capabilities: [TASK_CAPABILITY],
			costClass: "local",
			registeredAt: now,
		},
		provider,
		trusted: true,
		latencyMs: 0,
		maxConcurrency: 2,
		runtimeSnapshot: reservationRuntimeSnapshot(provider.providerId, binding, now),
		quota,
		budget: { tokens: 10 },
	});
	if (!registered.ok) throw registered.error;
}

function reservationQueueEntry(queueEntryId: string, sessionId: string, now: string): SchedulerQueueEntry {
	return {
		schemaVersion: 1,
		queueEntryId,
		sessionId,
		taskId: task().taskId,
		nodeRef: { taskId: task().taskId, graphRevision: 1, nodeId: queueEntryId },
		goalId: task().goalId,
		state: "queued",
		priority: 0,
		attemptsUsed: 0,
		enqueuedAt: now,
		revision: 0,
	};
}

async function reserveExecutor(
	registry: SchedulerExecutorRegistry,
	binding: AgentBinding,
	entry: SchedulerQueueEntry,
) {
	return registry.select({
		queueEntry: entry,
		requiredCapabilities: [TASK_CAPABILITY],
		decidedAt: entry.enqueuedAt,
		exactRequirements: {
			binding,
			attemptId: `attempt_${entry.queueEntryId}`,
			bindingEpochId: `epoch_${entry.queueEntryId}`,
			requireResume: true,
			modelAccess: "aos_gateway",
		},
	});
}

async function seedBindingFacts(session: Session, currentTask: TaskEnvelope, binding: AgentBinding): Promise<void> {
	const ledger = new SessionLedger(session, { ownerId: "scheduler-composition-seed" });
	await ledger.appendFact("task", currentTask.taskId, currentTask, {
		clientRequestId: "scheduler-composition-seed:task",
		expectedRevision: 0,
		correlation: { taskId: currentTask.taskId },
	});
	await ledger.appendFact("role_revision", binding.roleRevision.id, roleRevision(), {
		clientRequestId: "scheduler-composition-seed:role",
		expectedRevision: 0,
		correlation: { taskId: currentTask.taskId, bindingId: binding.bindingId },
	});
	await ledger.appendFact("model_profile_revision", binding.modelProfileRevision.id, modelProfile(), {
		clientRequestId: "scheduler-composition-seed:model",
		expectedRevision: 0,
		correlation: { taskId: currentTask.taskId, bindingId: binding.bindingId },
	});
	for (const [objectType, reference] of [
		["external_agent_binding", binding.contextRevision],
		["capability_binding", binding.capabilityRevision],
		["model_broker_binding", binding.modelBrokerBindingRevision],
		["policy_binding", binding.policyRevision],
	] as const) {
		await ledger.appendFact(
			objectType,
			reference.id,
			{ schemaVersion: 1, type: reference.type, id: reference.id, revision: reference.revision },
			{
				clientRequestId: `scheduler-composition-seed:${objectType}`,
				expectedRevision: 0,
				correlation: { taskId: currentTask.taskId, bindingId: binding.bindingId },
			},
		);
	}
	await ledger.release();
}

function hostReceipt(attempt: Attempt, options?: FoundationProviderExecutionOptions): AttemptReceipt {
	const correlation = options?.correlation;
	if (correlation === undefined) throw new Error("Expected Scheduler Host correlation");
	const attemptReceiptId = `attempt_receipt_${attempt.attemptId}`;
	return {
		schemaVersion: 1,
		attemptReceiptId,
		taskId: attempt.taskId,
		dispatchId: attempt.dispatchId,
		attemptId: attempt.attemptId,
		providerId: attempt.providerId,
		bindingId: attempt.bindingId,
		bindingEpochIds: [...attempt.bindingEpochIds],
		status: "succeeded",
		workerReceiptRefs: [],
		artifacts: [],
		provenance: {
			producerKind: "scheduler",
			providerId: attempt.providerId,
			producedAt: NOW,
			correlation: { ...correlation, attemptReceiptId },
		},
		sideEffectState: "none",
	};
}

interface CompositionFixture {
	readonly sourceId: string;
	readonly targetId: string;
	readonly sourceSession: Session;
	readonly targetSession: Session;
	readonly sourceManager: SessionManager;
	readonly targetManager: SessionManager;
	readonly targetGraph: TaskGraphStore;
}

function compositionFixture(input: {
	readonly sourceSessionId?: string;
	readonly targetSessionId?: string;
	readonly sourceStorage?: InMemorySessionStorage;
} = {}): CompositionFixture {
	const sourceId = "session-composition-source";
	const targetId = "session-composition-target";
	const sourceSession = new Session(
		input.sourceStorage ?? new InMemorySessionStorage({ id: input.sourceSessionId ?? sourceId, createdAt: 1 }),
	);
	const targetSession = new Session(new InMemorySessionStorage({ id: input.targetSessionId ?? targetId, createdAt: 1 }));
	const sourceManager = SessionManager.inMemory("C:/workspace/source", { id: sourceId });
	const targetManager = SessionManager.inMemory("C:/workspace/target", { id: targetId });
	const targetGraph = new TaskGraphStore(
		targetManager,
		{ get: () => undefined },
		{ getByBusinessKey: () => undefined },
		{ now: () => NOW },
	);
	return { sourceId, targetId, sourceSession, targetSession, sourceManager, targetManager, targetGraph };
}

function compositionOptions(
	fixture: CompositionFixture,
	eventSource?: SchedulerCompositionOptions["eventSource"],
): SchedulerCompositionOptions {
	return {
		schemaVersion: 1,
		enabled: true,
		sourceSession: fixture.sourceSession,
		targetSession: fixture.targetSession,
		targetSessionId: fixture.targetId,
		targetGraph: fixture.targetGraph,
		runLifecycleSession: fixture.sourceManager,
		ownerId: "scheduler-composition-owner",
		registry: new SchedulerExecutorRegistry(),
		task: task(),
		binding: { schemaVersion: 1 } as unknown as AgentBinding,
		gateLookup: { getByBusinessKey: () => undefined },
		resolveRunAssociation: async () => {
			throw new Error("No graph work is present");
		},
		settleRunAtHost: async () => {
			throw new Error("No graph work is present");
		},
		...(eventSource === undefined ? {} : { eventSource }),
		now: () => NOW,
	};
}

async function expectNoDurableWrites(fixture: CompositionFixture): Promise<void> {
	const [sourceRecords, targetRecords] = await Promise.all([
		fixture.sourceSession.findFoundationRecords({ includePruned: true }),
		fixture.targetSession.findFoundationRecords({ includePruned: true }),
	]);
	expect(sourceRecords).toEqual([]);
	expect(targetRecords).toEqual([]);
	expect(fixture.sourceManager.getEntries()).toEqual([]);
	expect(fixture.targetManager.getEntries()).toEqual([]);
}

describe("trusted Scheduler production composition", () => {
	it("releases construction resources when event subscription throws and permits same-Session retry", async () => {
		const fixture = compositionFixture();
		expect(() => new SchedulerComposition(compositionOptions(fixture, {
			subscribe() {
				throw new Error("event subscription failed");
			},
		}))).toThrow("event subscription failed");
		await expectNoDurableWrites(fixture);

		const retry = new SchedulerComposition(compositionOptions(fixture));
		await retry.dispose();
	});

	it("rejects a mismatched source Session identity before any durable write", async () => {
		const fixture = compositionFixture({ sourceSessionId: "wrong-source-session" });
		const composition = new SchedulerComposition(compositionOptions(fixture));
		try {
			await expect(composition.tick()).rejects.toMatchObject({ code: "scheduler_queue_invalid" });
			await expectNoDurableWrites(fixture);
		} finally {
			await composition.dispose();
		}
	});

	it("rejects a mismatched target Session identity before any durable write", async () => {
		const fixture = compositionFixture({ targetSessionId: "wrong-target-session" });
		const composition = new SchedulerComposition(compositionOptions(fixture));
		try {
			await expect(composition.tick()).rejects.toMatchObject({ code: "scheduler_queue_invalid" });
			await expectNoDurableWrites(fixture);
		} finally {
			await composition.dispose();
		}
	});

	it("reclaims crashed reservations after provider registration and before the first restart tick", async () => {
		const sourceId = "session-composition-source";
		const storage = new InMemorySessionStorage({ id: sourceId, createdAt: 1 });
		const firstSession = new Session(storage);
		const currentTask = task();
		const currentBinding = bindingFor(currentTask);
		const quota = new RestartQuota();
		const firstStore = new SchedulerSelectionReservationStore(firstSession, {
			ownerId: "scheduler-restart-owner-1",
			now: () => NOW,
		});
		const firstRegistry = new SchedulerExecutorRegistry({ reservationStore: firstStore });
		await registerReservationExecutor(firstRegistry, quota, currentBinding, NOW);
		const firstQueue = new SchedulerQueueStore({
			ledger: firstSession,
			sessionId: sourceId,
			ownerId: "scheduler-restart-owner-1",
			now: () => NOW,
		});
		const interruptedEntries = [
			reservationQueueEntry("queue_restart_reserved", sourceId, NOW),
			reservationQueueEntry("queue_restart_settling", sourceId, NOW),
		];
		for (const entry of interruptedEntries) {
			const enqueued = await firstQueue.enqueue(entry);
			if (!enqueued.ok) throw enqueued.error;
			const claimed = await firstQueue.claim({
				queueEntryId: entry.queueEntryId,
				ownerId: "scheduler-restart-owner-1",
				ttlMs: 1_000,
			});
			if (!claimed.ok) throw claimed.error;
			const selected = await reserveExecutor(firstRegistry, currentBinding, claimed.value.entry);
			if (!selected.ok) throw selected.error;
		}
		expect(await firstStore.activeCounts()).toMatchObject({
			ok: true,
			value: new Map([["scheduler.restart", 2]]),
		});
		quota.failNextSettlement = true;
		const interruptedSettlement = await firstRegistry.settleSelection(
			"queue_restart_settling",
			"failed",
			{
				inputTokens: 3,
				outputTokens: 0,
				cacheReadInputTokens: 0,
				cacheCreationInputTokens: 0,
				costUsd: 0,
			},
		);
		expect(interruptedSettlement).toMatchObject({
			ok: false,
			error: { code: "scheduler_budget_exhausted_wait" },
		});
		await firstStore.release();

		const restartClock = new DeterministicClock({
			wallTimeMs: Date.parse(NOW) + 2_000,
			monotonicTimeMs: 2_000,
		});
		const fixture = compositionFixture({ sourceStorage: storage });
		const restartStore = new SchedulerSelectionReservationStore(fixture.sourceSession, {
			ownerId: "scheduler-restart-owner-2",
			now: () => new Date(restartClock.wallNow()).toISOString(),
		});
		const restartRegistry = new SchedulerExecutorRegistry({ reservationStore: restartStore });
		const trace: string[] = [];
		quota.onSettle = () => trace.push("quota_settled");
		const composition = new SchedulerComposition(withRuntimeClock({
			...compositionOptions(fixture),
			ownerId: "scheduler-restart-owner-2",
			registry: restartRegistry,
			selectionReservationStore: restartStore,
			initializeBeforeStart: async () => {
				trace.push("providers_registered");
				await registerReservationExecutor(
					restartRegistry,
					quota,
					currentBinding,
					new Date(restartClock.wallNow()).toISOString(),
				);
			},
			eventSource: {
				subscribe() {
					trace.push("host_started");
					return () => {};
				},
			},
			now: () => new Date(restartClock.wallNow()).toISOString(),
		}, restartClock));
		const workflowTick = vi.spyOn(composition.workflow, "tick").mockImplementation(async () => {
			trace.push("first_tick");
			workflowTick.mockRestore();
			return composition.workflow.tick();
		});
		try {
			await composition.whenInitialized();
			expect(trace).toEqual([
				"providers_registered",
				"quota_settled",
				"quota_settled",
				"host_started",
			]);
			expect(quota.reserveCount).toBe(2);
			expect(quota.settleAttempts).toBe(3);
			expect(quota.settleCount).toBe(2);
			expect(await restartStore.activeCounts()).toMatchObject({ ok: true, value: new Map() });
			for (const entry of interruptedEntries) {
				const record = await restartRegistry.reservationRecord(entry.queueEntryId);
				expect(record).toMatchObject({ ok: true, value: { status: "settled" } });
			}

			const repeated = await restartRegistry.reconcileReservations([]);
			expect(repeated.ok).toBe(true);
			expect(quota.settleAttempts).toBe(3);
			expect(quota.settleCount).toBe(2);

			const plateauEntries = ["queue_plateau_1", "queue_plateau_2", "queue_plateau_3"].map((id) =>
				reservationQueueEntry(id, sourceId, new Date(restartClock.wallNow()).toISOString())
			);
			const concurrent = await Promise.all(
				plateauEntries.map((entry) => reserveExecutor(restartRegistry, currentBinding, entry)),
			);
			expect(concurrent.filter((result) => result.ok)).toHaveLength(2);
			expect(concurrent.filter((result) => !result.ok)).toMatchObject([
				{ error: { code: "scheduler_backpressure" } },
			]);
			expect(quota.reserveCount).toBe(4);
			expect(await restartStore.activeCounts()).toMatchObject({
				ok: true,
				value: new Map([["scheduler.restart", 2]]),
			});
			for (const [index, selected] of concurrent.entries()) {
				if (!selected.ok) continue;
				const settled = await restartRegistry.settleSelection(plateauEntries[index]!.queueEntryId, "succeeded");
				if (!settled.ok) throw settled.error;
			}
			expect(quota.settleAttempts).toBe(5);
			expect(quota.settleCount).toBe(4);
			expect(await restartStore.activeCounts()).toMatchObject({ ok: true, value: new Map() });

			await composition.tick();
			expect(trace.at(-1)).toBe("first_tick");
			expect(trace.indexOf("host_started")).toBeLessThan(trace.indexOf("first_tick"));
		} finally {
			await composition.dispose();
		}
	});

	it("drives a production Graph node through queue, dispatch, fan-in, and Host settlement", async () => {
		const fixture = compositionFixture();
		const currentTask = task();
		const currentBinding = bindingFor(currentTask);
		await seedBindingFacts(fixture.sourceSession, currentTask, currentBinding);
		let runnerCalls = 0;
		const provider = new SchedulerInProcessTaskExecutorProvider({
			now: () => NOW,
			hostAttemptRunner: async (attempt, options) => {
				runnerCalls += 1;
				return Result.ok({ usage: { tokens: 1 }, receipt: hostReceipt(attempt, options) });
			},
		});
		const registry = new SchedulerExecutorRegistry();
		const registered = await registry.register({
			entry: {
				schemaVersion: 1,
				descriptor: {
					schemaVersion: 1,
					providerId: provider.providerId,
					providerClass: provider.providerClass,
				},
				capabilities: [{ schemaVersion: 1, id: SCHEDULER_IN_PROCESS_CAPABILITY_ID, version: 1 }],
				costClass: "local",
				registeredAt: NOW,
			},
			provider,
			trusted: true,
			latencyMs: 0,
		});
		if (!registered.ok) throw registered.error;
		const runs = new Map<string, RunHandle>();
		let composition: SchedulerComposition | undefined;
		composition = new SchedulerComposition({
			schemaVersion: 1,
			enabled: true,
			sourceSession: fixture.sourceSession,
			targetSession: fixture.targetSession,
			targetSessionId: fixture.targetId,
			targetGraph: fixture.targetGraph,
			runLifecycleSession: fixture.sourceManager,
			ownerId: "scheduler-composition-owner",
			registry,
			task: currentTask,
			binding: currentBinding,
			gateLookup: { getByBusinessKey: () => undefined },
			resolveRunAssociation: async (_graph, node) => {
				if (composition === undefined) {
					return Result.err(new FoundationError("scheduler_not_found", "Scheduler composition is unavailable"));
				}
				const runId = `run-${node.nodeId}`;
				if (!runs.has(runId)) {
					const run = composition.runLifecycle.reserve().accept({ runId, attempt: 1, model: RUN_MODEL });
					run.start();
					runs.set(runId, run);
				}
				return Result.ok({ runId, task: currentTask, binding: currentBinding });
			},
			settleRunAtHost: async (input) => {
				const run = runs.get(input.runId);
				if (run === undefined) {
					return Result.err(new FoundationError("scheduler_not_found", "Scheduler Run was not reserved"));
				}
				await observeCanonicalTerminal(fixture.sourceManager, run, {
					outcome: input.taskResult === undefined ? "failed" : "completed",
				});
				return Result.ok(undefined);
			},
			now: () => NOW,
		});
		try {
			composition.graph.create({
				taskId: currentTask.taskId,
				graphRevision: 1,
				nodes: [{ nodeId: "root", dependsOn: [] }],
				clientRequestId: "create-production-composition-graph",
			});

			await composition.tick();

			const graph = composition.graph.get(currentTask.taskId, 1);
			expect(graph?.nodes).toMatchObject([{ nodeId: "root", status: "succeeded" }]);
			expect(runnerCalls).toBe(1);
			expect(composition.runLifecycle.getRun("run-root")?.receipt?.status).toBe("completed");
			const queueFacts = await fixture.sourceSession.findFoundationRecords({
				kind: "fact",
				objectType: "scheduler.queue_transitioned",
				order: "oldestFirst",
			});
			expect(queueFacts.length).toBeGreaterThanOrEqual(4);
			expect(await fixture.sourceSession.findFoundationRecords({ kind: "fact", objectType: "attempt_receipt" }))
				.toHaveLength(1);
			expect(await fixture.sourceSession.findFoundationRecords({ kind: "fact", objectType: "task_result" }))
				.toHaveLength(1);
		} finally {
			await composition.dispose();
		}
	});

	it("wires all stages behind one tick driver", async () => {
		const sourceId = "session-composition-source";
		const targetId = "session-composition-target";
		const sourceSession = new Session(new InMemorySessionStorage({ id: sourceId, createdAt: 1 }));
		const targetSession = new Session(new InMemorySessionStorage({ id: targetId, createdAt: 1 }));
		const sourceManager = SessionManager.inMemory("C:/workspace/source", { id: sourceId });
		const targetManager = SessionManager.inMemory("C:/workspace/target", { id: targetId });
		const emptyRunLookup = { get: () => undefined };
		const emptyGateLookup = { getByBusinessKey: () => undefined };
		const targetGraph = new TaskGraphStore(targetManager, emptyRunLookup, emptyGateLookup, { now: () => NOW });
		let subscriptions = 0;
		let wake: (() => void) | undefined;
		const composition = new SchedulerComposition({
			schemaVersion: 1,
			enabled: true,
			sourceSession,
			targetSession,
			targetSessionId: targetId,
			targetGraph,
			runLifecycleSession: sourceManager,
			ownerId: "scheduler-composition-owner",
			registry: new SchedulerExecutorRegistry(),
			task: task(),
			binding: { schemaVersion: 1 } as unknown as AgentBinding,
			gateLookup: emptyGateLookup,
			resolveRunAssociation: async () => {
				throw new Error("No graph work is present");
			},
			settleRunAtHost: async () => {
				throw new Error("No graph work is present");
			},
			eventSource: {
				subscribe(listener) {
					subscriptions += 1;
					wake = listener;
					return () => { wake = undefined; };
				},
			},
			now: () => NOW,
		});
		try {
			const host = (composition as unknown as { readonly host: unknown }).host;
			expect(composition.workflow).toBeInstanceOf(SchedulerWorkflowController);
			expect(composition.messages).toBeInstanceOf(SchedulerMessageOrchestrator);
			expect(composition.messages).toBe(composition.workflow.messages);
			expect(composition.handoff).toBeInstanceOf(SchedulerHandoffController);
			expect(composition.handoff).toBe(composition.workflow.handoff);
			expect(composition.fanIn).toBeInstanceOf(SchedulerFanInController);
			expect(composition.fanIn).toBe(composition.workflow.fanIn);
			expect(composition.deadlock).toBeInstanceOf(SchedulerDeadlockController);
			expect(host).toBeInstanceOf(SchedulerHost);
			expect(composition.workflow.host.start()).toBe(false);
			expect(subscriptions).toBe(1);
			await composition.tick();
			expect(composition.status()).toMatchObject({
				enabled: true,
				started: true,
				components: ["messages", "handoff", "workflow", "deadlock", "host", "fan_in"],
			});
			wake?.();
		} finally {
			await composition.dispose();
		}
	});
});
