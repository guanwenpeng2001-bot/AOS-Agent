import {
	type AgentBinding,
	type AttemptReceipt,
	type Attempt,
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
} from "@aos-agent/agent-core";
import { describe, expect, it } from "vitest";
import {
	TrustedSchedulerComposition,
	type TrustedSchedulerCompositionOptions,
} from "../src/core/foundation-control-plane.ts";
import { SchedulerDeadlockController } from "../src/core/scheduler-deadlock.ts";
import {
	SCHEDULER_IN_PROCESS_CAPABILITY_ID,
	SchedulerExecutorRegistry,
	SchedulerInProcessTaskExecutorProvider,
} from "../src/core/scheduler-executors.ts";
import { SchedulerFanInController } from "../src/core/scheduler-fan-in.ts";
import { SchedulerHandoffController } from "../src/core/scheduler-handoff.ts";
import { SchedulerMessageOrchestrator } from "../src/core/scheduler-messages.ts";
import { SchedulerWorkflowController } from "../src/core/scheduler-workflow.ts";
import type { RunHandle } from "../src/core/run-lifecycle.ts";
import { SchedulerHost } from "../src/core/scheduler.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { TaskGraphStore } from "../src/core/task-graph.ts";

const NOW = "2026-08-22T00:00:00.000Z";
const RUN_MODEL = { provider: "host", id: "host", thinkingLevel: "off" as const };

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
} = {}): CompositionFixture {
	const sourceId = "session-composition-source";
	const targetId = "session-composition-target";
	const sourceSession = new Session(new InMemorySessionStorage({ id: input.sourceSessionId ?? sourceId, createdAt: 1 }));
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
	eventSource?: TrustedSchedulerCompositionOptions["eventSource"],
): TrustedSchedulerCompositionOptions {
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
		expect(() => new TrustedSchedulerComposition(compositionOptions(fixture, {
			subscribe() {
				throw new Error("event subscription failed");
			},
		}))).toThrow("event subscription failed");
		await expectNoDurableWrites(fixture);

		const retry = new TrustedSchedulerComposition(compositionOptions(fixture));
		await retry.dispose();
	});

	it("rejects a mismatched source Session identity before any durable write", async () => {
		const fixture = compositionFixture({ sourceSessionId: "wrong-source-session" });
		const composition = new TrustedSchedulerComposition(compositionOptions(fixture));
		try {
			await expect(composition.tick()).rejects.toMatchObject({ code: "scheduler_queue_invalid" });
			await expectNoDurableWrites(fixture);
		} finally {
			await composition.dispose();
		}
	});

	it("rejects a mismatched target Session identity before any durable write", async () => {
		const fixture = compositionFixture({ targetSessionId: "wrong-target-session" });
		const composition = new TrustedSchedulerComposition(compositionOptions(fixture));
		try {
			await expect(composition.tick()).rejects.toMatchObject({ code: "scheduler_queue_invalid" });
			await expectNoDurableWrites(fixture);
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
		let composition: TrustedSchedulerComposition | undefined;
		composition = new TrustedSchedulerComposition({
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
				run.settle({ outcome: input.taskResult === undefined ? "failed" : "completed" });
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
		const composition = new TrustedSchedulerComposition({
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
