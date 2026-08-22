import {
	InMemorySessionStorage,
	Session,
	type AgentBindingV1,
	type TaskEnvelopeV1,
} from "@aos-agent/agent-core";
import { describe, expect, it } from "vitest";
import {
	TrustedSchedulerCompositionV1,
	type TrustedSchedulerCompositionOptionsV1,
} from "../src/core/foundation-control-plane.ts";
import { SchedulerDeadlockController } from "../src/core/scheduler-deadlock.ts";
import { SchedulerExecutorRegistry } from "../src/core/scheduler-executors.ts";
import { SchedulerFanInController } from "../src/core/scheduler-fan-in.ts";
import { SchedulerHandoffController } from "../src/core/scheduler-handoff.ts";
import { SchedulerMessageOrchestratorV1 } from "../src/core/scheduler-messages.ts";
import { SchedulerWorkflowController } from "../src/core/scheduler-workflow.ts";
import { SchedulerHostV1 } from "../src/core/scheduler.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { TaskGraphStore } from "../src/core/task-graph.ts";

const NOW = "2026-08-22T00:00:00.000Z";

function task(): TaskEnvelopeV1 {
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
	eventSource?: TrustedSchedulerCompositionOptionsV1["eventSource"],
): TrustedSchedulerCompositionOptionsV1 {
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
		binding: { schemaVersion: 1 } as unknown as AgentBindingV1,
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
		expect(() => new TrustedSchedulerCompositionV1(compositionOptions(fixture, {
			subscribe() {
				throw new Error("event subscription failed");
			},
		}))).toThrow("event subscription failed");
		await expectNoDurableWrites(fixture);

		const retry = new TrustedSchedulerCompositionV1(compositionOptions(fixture));
		await retry.dispose();
	});

	it("rejects a mismatched source Session identity before any durable write", async () => {
		const fixture = compositionFixture({ sourceSessionId: "wrong-source-session" });
		const composition = new TrustedSchedulerCompositionV1(compositionOptions(fixture));
		try {
			await expect(composition.tick()).rejects.toMatchObject({ code: "scheduler_queue_invalid" });
			await expectNoDurableWrites(fixture);
		} finally {
			await composition.dispose();
		}
	});

	it("rejects a mismatched target Session identity before any durable write", async () => {
		const fixture = compositionFixture({ targetSessionId: "wrong-target-session" });
		const composition = new TrustedSchedulerCompositionV1(compositionOptions(fixture));
		try {
			await expect(composition.tick()).rejects.toMatchObject({ code: "scheduler_queue_invalid" });
			await expectNoDurableWrites(fixture);
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
		const composition = new TrustedSchedulerCompositionV1({
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
			binding: { schemaVersion: 1 } as unknown as AgentBindingV1,
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
			expect(composition.messages).toBeInstanceOf(SchedulerMessageOrchestratorV1);
			expect(composition.messages).toBe(composition.workflow.messages);
			expect(composition.handoff).toBeInstanceOf(SchedulerHandoffController);
			expect(composition.handoff).toBe(composition.workflow.handoff);
			expect(composition.fanIn).toBeInstanceOf(SchedulerFanInController);
			expect(composition.fanIn).toBe(composition.workflow.fanIn);
			expect(composition.deadlock).toBeInstanceOf(SchedulerDeadlockController);
			expect(host).toBeInstanceOf(SchedulerHostV1);
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
