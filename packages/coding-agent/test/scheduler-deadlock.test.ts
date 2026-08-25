import { FoundationError, InMemorySessionStorage, Result, Session } from "@aos-agent/agent-core";
import { describe, expect, it, vi } from "vitest";
import {
	SCHEDULER_DEADLOCK_OBJECT_TYPE,
	SchedulerDeadlockController,
	type SchedulerDeadlockQueueV1,
	schedulerEffectivePriorityV1,
	schedulerOrderQueuedWorkV1,
} from "../src/core/scheduler-deadlock.ts";
import { SchedulerHandoffController } from "../src/core/scheduler-handoff.ts";
import { SchedulerMessageOrchestratorV1 } from "../src/core/scheduler-messages.ts";
import { SchedulerQueueStore } from "../src/core/scheduler-queue.ts";
import { withRuntimeClock } from "../src/core/runtime-clock.ts";
import type { SchedulerOwnershipTransferV1, SchedulerQueueEntryV1 } from "../src/core/scheduler.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createSessionManagerStorage } from "../src/core/session-manager-storage.ts";
import { TaskGateStore } from "../src/core/task-gate.ts";
import { createTaskGraphStore, type TaskGraphStore } from "../src/core/task-graph.ts";
import { DeterministicClock } from "./support/deterministic-clock.ts";

vi.mock("@aos-agent/ai/compat", () => ({
	clampThinkingLevel: (level: unknown) => level,
	cleanupSessionResources: () => {},
	getSupportedThinkingLevels: () => ["off"],
	isContextOverflow: () => false,
	isRecoverableLength: () => false,
	isRetryableAssistantError: () => false,
	modelsAreEqual: () => false,
	resetApiProviders: () => {},
	streamSimple: async () => {
		throw new Error("streamSimple is not exercised by scheduler deadlock");
	},
}));

vi.mock("@aos-agent/ai/providers/all", () => ({}));

const T0 = "2026-08-22T12:00:00.000Z";
const T1 = "2026-08-22T12:00:10.000Z";
const DEADLINE = "2026-08-22T12:05:00.000Z";
const OWNER_ID = "scheduler_host_1";

function queued(overrides: Partial<SchedulerQueueEntryV1> = {}): SchedulerQueueEntryV1 {
	const taskId = overrides.taskId ?? "task_a";
	return {
		schemaVersion: 1,
		queueEntryId: "queue_a",
		sessionId: "session_a",
		taskId,
		nodeRef: { taskId, graphRevision: 1, nodeId: `node_${taskId}` },
		state: "queued",
		priority: 0,
		attemptsUsed: 0,
		enqueuedAt: T0,
		revision: 0,
		...overrides,
	};
}

function transfer(overrides: Partial<SchedulerOwnershipTransferV1> = {}): SchedulerOwnershipTransferV1 {
	return {
		schemaVersion: 1,
		transferId: "transfer_a",
		taskId: "task_a",
		fromOwnerId: "owner_a",
		toOwnerId: "owner_b",
		state: "offered",
		fencingToken: "fence_a",
		deadlineAt: DEADLINE,
		createdAt: T0,
		revision: 0,
		...overrides,
	};
}

function graphStore(manager: SessionManager, gates?: TaskGateStore, now: () => string = () => T0): TaskGraphStore {
	return createTaskGraphStore(
		manager,
		{ get: () => undefined },
		gates ?? { getByBusinessKey: () => undefined },
		{ now },
	);
}

function waitingDependsNodes(blockingTaskId: string, waiterId: string) {
	return [
		{ nodeId: blockingTaskId, dependsOn: [] as string[] },
		{ nodeId: waiterId, dependsOn: [blockingTaskId] },
	];
}

interface Clock {
	now: () => string;
	set: (iso: string) => void;
}

function clock(start: string = T0): Clock {
	let current = start;
	return {
		now: () => current,
		set: (iso) => {
			current = iso;
		},
	};
}

async function baseHarness(
	options: {
		readonly clock?: Clock;
		readonly maxQueueDepth?: number;
		readonly sessionMaxActive?: number;
		readonly globalMaxActive?: number;
		readonly maxGraphsPerTick?: number;
		readonly maxNodesPerTick?: number;
		readonly tickTimeoutMs?: number;
		readonly withHandoff?: boolean;
		readonly withGates?: boolean;
		readonly sessionId?: string;
	} = {},
) {
	const sessionId = options.sessionId ?? "session_a";
	const time = options.clock ?? clock();
	const manager = SessionManager.inMemory("/workspace/deadlock", { id: sessionId });
	const gates = options.withGates === true ? new TaskGateStore(manager, { now: time.now }) : undefined;
	const graph = graphStore(manager, gates, time.now);
	const session = new Session(new InMemorySessionStorage({ id: sessionId, createdAt: 1 }));
	const queue = new SchedulerQueueStore({
		ledger: session,
		sessionId,
		ownerId: OWNER_ID,
		now: time.now,
	});
	const handoff =
		options.withHandoff === true
			? new SchedulerHandoffController({
					ledger: session,
					queue,
					sessionId,
					ownerId: OWNER_ID,
					now: time.now,
				})
			: undefined;
	const controller = new SchedulerDeadlockController({
		enabled: true,
		sessionId,
		ownerId: OWNER_ID,
		ledger: session,
		graph,
		queue,
		now: time.now,
		...(gates === undefined ? {} : { gates }),
		...(handoff === undefined ? {} : { handoff }),
		...(options.maxQueueDepth === undefined ? {} : { maxQueueDepth: options.maxQueueDepth }),
		...(options.sessionMaxActive === undefined ? {} : { sessionMaxActive: options.sessionMaxActive }),
		...(options.globalMaxActive === undefined ? {} : { globalMaxActive: options.globalMaxActive }),
		...(options.maxGraphsPerTick === undefined ? {} : { maxGraphsPerTick: options.maxGraphsPerTick }),
		...(options.maxNodesPerTick === undefined ? {} : { maxNodesPerTick: options.maxNodesPerTick }),
		...(options.tickTimeoutMs === undefined ? {} : { tickTimeoutMs: options.tickTimeoutMs }),
	});
	return { sessionId, manager, session, graph, gates, queue, handoff, controller, time };
}

function queueFacade(
	queue: SchedulerQueueStore,
	snapshot: SchedulerDeadlockQueueV1["snapshot"],
): SchedulerDeadlockQueueV1 {
	return {
		snapshot,
		enqueue: (candidate, options) => queue.enqueue(candidate, options),
	};
}

async function enqueueClaimed(
	queue: SchedulerQueueStore,
	entry: SchedulerQueueEntryV1,
	ownerId: string,
	claimId: string,
	fencingToken: string,
): Promise<void> {
	const queuedResult = await queue.enqueue(entry);
	expect(queuedResult.ok).toBe(true);
	const claimed = await queue.claim({
		queueEntryId: entry.queueEntryId,
		ownerId,
		claimId,
		fencingToken,
	});
	expect(claimed.ok).toBe(true);
}

describe("scheduler T8 deadlock fairness and backpressure", () => {
	it("detects a dependsOn wait-for cycle from graph view and fails the lowest-revision member", async () => {
		const harness = await baseHarness();
		harness.graph.create({
			taskId: "task_a",
			graphRevision: 1,
			nodes: waitingDependsNodes("task_b", "wait_a"),
			clientRequestId: "g_a",
		});
		harness.graph.create({
			taskId: "task_b",
			graphRevision: 1,
			nodes: waitingDependsNodes("task_a", "wait_b"),
			clientRequestId: "g_b",
		});
		expect((await harness.queue.enqueue(queued({ queueEntryId: "queue_a", taskId: "task_a" }))).ok).toBe(true);
		expect((await harness.queue.claim({ queueEntryId: "queue_a", ownerId: OWNER_ID })).ok).toBe(true);
		expect((await harness.queue.enqueue(queued({ queueEntryId: "queue_b", taskId: "task_b" }))).ok).toBe(true);
		const result = await harness.controller.tick();
		expect(result.enabled).toBe(true);
		expect(result.cycles).toBe(1);
		expect(result.failedTaskIds).toEqual(["task_b"]);
		expect(result.facts[0]).toMatchObject({
			schemaVersion: 1,
			memberTaskIds: ["task_a", "task_b"],
			edgeKinds: ["dependsOn"],
			failedTaskIds: ["task_b"],
		});
		const snapshot = await harness.queue.snapshot();
		expect(snapshot.ok).toBe(true);
		if (!snapshot.ok) return;
		expect(snapshot.value.entries.find((entry) => entry.taskId === "task_b")?.state).toBe("cancelled");
	});

	it("detects a gate-state wait-for cycle from pending Gate records", async () => {
		const harness = await baseHarness({ withGates: true });
		expect(harness.gates).toBeDefined();
		harness.gates?.request({
			taskId: "task_a",
			stageId: "task_b",
			stageRevision: 1,
			clientRequestId: "gate_a",
		});
		harness.gates?.request({
			taskId: "task_b",
			stageId: "task_a",
			stageRevision: 1,
			clientRequestId: "gate_b",
		});
		harness.graph.create({
			taskId: "task_a",
			graphRevision: 1,
			nodes: [
				{
					nodeId: "node_task_a",
					dependsOn: [],
					gateRef: { stageId: "task_b", stageRevision: 1 },
				},
			],
			clientRequestId: "g_a",
		});
		harness.graph.create({
			taskId: "task_b",
			graphRevision: 1,
			nodes: [
				{
					nodeId: "node_task_b",
					dependsOn: [],
					gateRef: { stageId: "task_a", stageRevision: 1 },
				},
			],
			clientRequestId: "g_b",
		});
		expect((await harness.queue.enqueue(queued({ queueEntryId: "queue_a", taskId: "task_a" }))).ok).toBe(true);
		expect((await harness.queue.enqueue(queued({ queueEntryId: "queue_b", taskId: "task_b" }))).ok).toBe(true);
		const result = await harness.controller.tick();
		expect(result.cycles).toBe(1);
		expect(result.facts[0]?.edgeKinds).toEqual(["gate"]);
		expect(result.failedTaskIds).toHaveLength(1);
		expect(["task_a", "task_b"]).toContain(result.failedTaskIds[0]);
		const failedGate = harness.gates?.list({ taskId: result.failedTaskIds[0], limit: 10 }).gates[0];
		expect(failedGate?.status).toBe("rejected");
	});

	it("detects an Ask waiting-fact cycle across two Sessions", async () => {
		const time = clock();
		const sourceManager = SessionManager.inMemory("C:/workspace/source", { id: "session_source" });
		const targetManager = SessionManager.inMemory("C:/workspace/target", { id: "session_target" });
		const sourceSession = new Session(createSessionManagerStorage(sourceManager));
		const targetSession = new Session(createSessionManagerStorage(targetManager));
		const sourceGraph = graphStore(sourceManager, undefined, time.now);
		const targetGraph = graphStore(targetManager, undefined, time.now);
		sourceGraph.create({
			taskId: "task_a",
			graphRevision: 1,
			nodes: [{ nodeId: "node_task_a", dependsOn: [] }],
			clientRequestId: "g_a",
		});
		targetGraph.create({
			taskId: "task_b",
			graphRevision: 1,
			nodes: [{ nodeId: "node_task_b", dependsOn: [] }],
			clientRequestId: "g_b",
		});
		const messages = new SchedulerMessageOrchestratorV1(
			[
				{ session: sourceSession, taskGraph: sourceGraph },
				{ session: targetSession, taskGraph: targetGraph },
			],
			{ ownerId: OWNER_ID },
		);
		await messages.createCrossSessionAsk({
			sourceSessionId: "session_source",
			targetSessionId: "session_target",
			askId: "ask_ab",
			waitId: "wait_ab",
			threadId: "thread_ab",
			messageId: "msg_ab",
			question: "Continue A?",
			options: ["yes", "no"],
			dueAt: DEADLINE,
			createdAt: T0,
			clientRequestId: "ask_ab",
			taskId: "task_a",
		});
		await messages.createCrossSessionAsk({
			sourceSessionId: "session_target",
			targetSessionId: "session_source",
			askId: "ask_ba",
			waitId: "wait_ba",
			threadId: "thread_ba",
			messageId: "msg_ba",
			question: "Continue B?",
			options: ["yes", "no"],
			dueAt: DEADLINE,
			createdAt: T0,
			clientRequestId: "ask_ba",
			taskId: "task_b",
		});
		const sourceQueue = new SchedulerQueueStore({
			ledger: sourceSession,
			sessionId: "session_source",
			ownerId: OWNER_ID,
			now: time.now,
		});
		const controller = new SchedulerDeadlockController({
			enabled: true,
			sessionId: "session_source",
			ownerId: OWNER_ID,
			ledger: sourceSession,
			graph: sourceGraph,
			extraGraphs: [targetGraph],
			queue: sourceQueue,
			waitLedgers: [sourceSession, targetSession],
			now: time.now,
		});
		const result = await controller.tick();
		expect(result.cycles).toBe(1);
		expect(result.facts[0]?.edgeKinds).toContain("ask");
		expect(result.facts[0]?.memberTaskIds).toEqual(["task_a", "task_b"]);
		await messages.release();
	});

	it("ignores older waiting Ask facts once the latest wait status is resolved", async () => {
		const time = clock();
		const sourceManager = SessionManager.inMemory("C:/workspace/source-resolved", { id: "session_source" });
		const targetManager = SessionManager.inMemory("C:/workspace/target-resolved", { id: "session_target" });
		const sourceSession = new Session(createSessionManagerStorage(sourceManager));
		const targetSession = new Session(createSessionManagerStorage(targetManager));
		const sourceGraph = graphStore(sourceManager, undefined, time.now);
		const targetGraph = graphStore(targetManager, undefined, time.now);
		sourceGraph.create({
			taskId: "task_a",
			graphRevision: 1,
			nodes: [{ nodeId: "node_task_a", dependsOn: [] }],
			clientRequestId: "g_a",
		});
		targetGraph.create({
			taskId: "task_b",
			graphRevision: 1,
			nodes: [{ nodeId: "node_task_b", dependsOn: [] }],
			clientRequestId: "g_b",
		});
		const messages = new SchedulerMessageOrchestratorV1(
			[
				{ session: sourceSession, taskGraph: sourceGraph },
				{ session: targetSession, taskGraph: targetGraph },
			],
			{ ownerId: OWNER_ID },
		);
		await messages.createCrossSessionAsk({
			sourceSessionId: "session_source",
			targetSessionId: "session_target",
			askId: "ask_ab",
			waitId: "wait_ab",
			threadId: "thread_ab",
			messageId: "msg_ab",
			question: "Continue A?",
			options: ["yes", "no"],
			dueAt: DEADLINE,
			createdAt: T0,
			clientRequestId: "ask_ab",
			taskId: "task_a",
		});
		await messages.createCrossSessionAsk({
			sourceSessionId: "session_target",
			targetSessionId: "session_source",
			askId: "ask_ba",
			waitId: "wait_ba",
			threadId: "thread_ba",
			messageId: "msg_ba",
			question: "Continue B?",
			options: ["yes", "no"],
			dueAt: DEADLINE,
			createdAt: T0,
			clientRequestId: "ask_ba",
			taskId: "task_b",
		});
		await messages.replyCrossSessionAsk({
			targetSessionId: "session_target",
			askId: "ask_ab",
			optionIndex: 0,
			by: "operator_1",
			replyId: "reply_ab",
			clientRequestId: "reply_ab",
		});
		const resolved = await messages.resolveCrossSessionAsk({
			sourceSessionId: "session_source",
			waitId: "wait_ab",
			at: T1,
			clientRequestId: "resolve_ab",
			messageId: "msg_ab_response",
		});
		expect(resolved.status).toBe("answered");
		const sourceQueue = new SchedulerQueueStore({
			ledger: sourceSession,
			sessionId: "session_source",
			ownerId: OWNER_ID,
			now: time.now,
		});
		const controller = new SchedulerDeadlockController({
			enabled: true,
			sessionId: "session_source",
			ownerId: OWNER_ID,
			ledger: sourceSession,
			graph: sourceGraph,
			extraGraphs: [targetGraph],
			queue: sourceQueue,
			waitLedgers: [sourceSession, targetSession],
			now: time.now,
		});
		const result = await controller.tick();
		expect(result.cycles).toBe(0);
		expect(result.facts).toHaveLength(0);
		await messages.release();
	});

	it("keeps both waiting Ask facts when two Sessions share a waitId", async () => {
		const time = clock();
		const sourceManager = SessionManager.inMemory("C:/workspace/source-collide", { id: "session_source" });
		const targetManager = SessionManager.inMemory("C:/workspace/target-collide", { id: "session_target" });
		const sourceSession = new Session(createSessionManagerStorage(sourceManager));
		const targetSession = new Session(createSessionManagerStorage(targetManager));
		const sourceGraph = graphStore(sourceManager, undefined, time.now);
		const targetGraph = graphStore(targetManager, undefined, time.now);
		sourceGraph.create({
			taskId: "task_a",
			graphRevision: 1,
			nodes: [{ nodeId: "node_task_a", dependsOn: [] }],
			clientRequestId: "g_a",
		});
		targetGraph.create({
			taskId: "task_b",
			graphRevision: 1,
			nodes: [{ nodeId: "node_task_b", dependsOn: [] }],
			clientRequestId: "g_b",
		});
		const messages = new SchedulerMessageOrchestratorV1(
			[
				{ session: sourceSession, taskGraph: sourceGraph },
				{ session: targetSession, taskGraph: targetGraph },
			],
			{ ownerId: OWNER_ID },
		);
		await messages.createCrossSessionAsk({
			sourceSessionId: "session_source",
			targetSessionId: "session_target",
			askId: "ask_ab",
			waitId: "wait_shared",
			threadId: "thread_ab",
			messageId: "msg_ab",
			question: "Continue A?",
			options: ["yes", "no"],
			dueAt: DEADLINE,
			createdAt: T0,
			clientRequestId: "ask_ab",
			taskId: "task_a",
		});
		await messages.createCrossSessionAsk({
			sourceSessionId: "session_target",
			targetSessionId: "session_source",
			askId: "ask_ba",
			waitId: "wait_shared",
			threadId: "thread_ba",
			messageId: "msg_ba",
			question: "Continue B?",
			options: ["yes", "no"],
			dueAt: DEADLINE,
			createdAt: T0,
			clientRequestId: "ask_ba",
			taskId: "task_b",
		});
		const sourceQueue = new SchedulerQueueStore({
			ledger: sourceSession,
			sessionId: "session_source",
			ownerId: OWNER_ID,
			now: time.now,
		});
		const controller = new SchedulerDeadlockController({
			enabled: true,
			sessionId: "session_source",
			ownerId: OWNER_ID,
			ledger: sourceSession,
			graph: sourceGraph,
			extraGraphs: [targetGraph],
			queue: sourceQueue,
			waitLedgers: [sourceSession, targetSession],
			now: time.now,
		});
		const result = await controller.tick();
		expect(result.cycles).toBe(1);
		expect(result.facts[0]?.edgeKinds).toContain("ask");
		expect(result.facts[0]?.memberTaskIds).toEqual(["task_a", "task_b"]);
		await messages.release();
	});

	it("does not let one Session's terminal wait revision suppress another Session's same waitId", async () => {
		const time = clock();
		const sourceManager = SessionManager.inMemory("C:/workspace/source-ns", { id: "session_source" });
		const targetManager = SessionManager.inMemory("C:/workspace/target-ns", { id: "session_target" });
		const sourceSession = new Session(createSessionManagerStorage(sourceManager));
		const targetSession = new Session(createSessionManagerStorage(targetManager));
		const sourceGraph = graphStore(sourceManager, undefined, time.now);
		const targetGraph = graphStore(targetManager, undefined, time.now);
		sourceGraph.create({
			taskId: "task_a",
			graphRevision: 1,
			nodes: [{ nodeId: "node_task_a", dependsOn: [] }],
			clientRequestId: "g_a",
		});
		targetGraph.create({
			taskId: "task_b",
			graphRevision: 1,
			nodes: [{ nodeId: "node_task_b", dependsOn: [] }],
			clientRequestId: "g_b",
		});
		const messages = new SchedulerMessageOrchestratorV1(
			[
				{ session: sourceSession, taskGraph: sourceGraph },
				{ session: targetSession, taskGraph: targetGraph },
			],
			{ ownerId: OWNER_ID },
		);
		await messages.createCrossSessionAsk({
			sourceSessionId: "session_source",
			targetSessionId: "session_target",
			askId: "ask_ab",
			waitId: "wait_shared",
			threadId: "thread_ab",
			messageId: "msg_ab",
			question: "Continue A?",
			options: ["yes", "no"],
			dueAt: DEADLINE,
			createdAt: T0,
			clientRequestId: "ask_ab",
			taskId: "task_a",
		});
		await messages.createCrossSessionAsk({
			sourceSessionId: "session_target",
			targetSessionId: "session_source",
			askId: "ask_ba",
			waitId: "wait_shared",
			threadId: "thread_ba",
			messageId: "msg_ba",
			question: "Continue B?",
			options: ["yes", "no"],
			dueAt: DEADLINE,
			createdAt: T0,
			clientRequestId: "ask_ba",
			taskId: "task_b",
		});
		await messages.createCrossSessionAsk({
			sourceSessionId: "session_source",
			targetSessionId: "session_target",
			askId: "ask_other",
			waitId: "wait_other",
			threadId: "thread_other",
			messageId: "msg_other",
			question: "Continue A again?",
			options: ["yes", "no"],
			dueAt: DEADLINE,
			createdAt: T0,
			clientRequestId: "ask_other",
			taskId: "task_a",
		});
		await messages.replyCrossSessionAsk({
			targetSessionId: "session_target",
			askId: "ask_ab",
			optionIndex: 0,
			by: "operator_1",
			replyId: "reply_ab",
			clientRequestId: "reply_ab",
		});
		expect(
			(
				await messages.resolveCrossSessionAsk({
					sourceSessionId: "session_source",
					waitId: "wait_shared",
					at: T1,
					clientRequestId: "resolve_ab",
					messageId: "msg_ab_response",
				})
			).status,
		).toBe("answered");
		const sourceQueue = new SchedulerQueueStore({
			ledger: sourceSession,
			sessionId: "session_source",
			ownerId: OWNER_ID,
			now: time.now,
		});
		const controller = new SchedulerDeadlockController({
			enabled: true,
			sessionId: "session_source",
			ownerId: OWNER_ID,
			ledger: sourceSession,
			graph: sourceGraph,
			extraGraphs: [targetGraph],
			queue: sourceQueue,
			waitLedgers: [sourceSession, targetSession],
			now: time.now,
		});
		const result = await controller.tick();
		expect(result.cycles).toBe(1);
		expect(result.facts[0]?.edgeKinds).toContain("ask");
		expect(result.facts[0]?.memberTaskIds).toEqual(["task_a", "task_b"]);
		await messages.release();
	});

	it("detects an offered-handoff wait-for cycle from handoff plus claim owners", async () => {
		const harness = await baseHarness({ withHandoff: true });
		expect(harness.handoff).toBeDefined();
		harness.graph.create({
			taskId: "task_a",
			graphRevision: 1,
			nodes: [{ nodeId: "node_task_a", dependsOn: [] }],
			clientRequestId: "g_a",
		});
		harness.graph.create({
			taskId: "task_b",
			graphRevision: 1,
			nodes: [{ nodeId: "node_task_b", dependsOn: [] }],
			clientRequestId: "g_b",
		});
		await enqueueClaimed(
			harness.queue,
			queued({ queueEntryId: "queue_a", taskId: "task_a" }),
			"owner_a",
			"claim_a",
			"fence_a",
		);
		await enqueueClaimed(
			harness.queue,
			queued({ queueEntryId: "queue_b", taskId: "task_b" }),
			"owner_b",
			"claim_b",
			"fence_b",
		);
		expect(
			(
				await harness.handoff!.offer({
					queueEntryId: "queue_a",
					transfer: transfer(),
				})
			).ok,
		).toBe(true);
		expect(
			(
				await harness.handoff!.offer({
					queueEntryId: "queue_b",
					transfer: transfer({
						transferId: "transfer_b",
						taskId: "task_b",
						fromOwnerId: "owner_b",
						toOwnerId: "owner_a",
						fencingToken: "fence_b",
					}),
				})
			).ok,
		).toBe(true);
		const result = await harness.controller.tick();
		expect(result.cycles).toBe(1);
		expect(result.facts[0]?.edgeKinds).toContain("handoff");
		expect(result.facts[0]?.memberTaskIds).toEqual(["task_a", "task_b"]);
		const offered = await harness.handoff!.snapshot();
		expect(offered.ok).toBe(true);
		if (!offered.ok) return;
		const sacrificial = result.failedTaskIds[0];
		expect(offered.value.transfers.find((item) => item.taskId === sacrificial)?.state).toBe("cancelled");
	});

	it("detects a queue claim-state wait-for cycle from swapped claim owners", async () => {
		const harness = await baseHarness();
		harness.graph.create({
			taskId: "task_a",
			graphRevision: 1,
			nodes: [{ nodeId: "node_task_a", dependsOn: [] }],
			clientRequestId: "g_a",
		});
		harness.graph.create({
			taskId: "task_b",
			graphRevision: 1,
			nodes: [{ nodeId: "node_task_b", dependsOn: [] }],
			clientRequestId: "g_b",
		});
		await enqueueClaimed(
			harness.queue,
			queued({ queueEntryId: "queue_a", taskId: "task_a" }),
			"task_b",
			"claim_a",
			"fence_a",
		);
		await enqueueClaimed(
			harness.queue,
			queued({ queueEntryId: "queue_b", taskId: "task_b" }),
			"task_a",
			"claim_b",
			"fence_b",
		);
		const result = await harness.controller.tick();
		expect(result.cycles).toBe(1);
		expect(result.facts[0]?.edgeKinds).toEqual(["claim"]);
		expect(result.facts[0]?.memberTaskIds).toEqual(["task_a", "task_b"]);
		expect(result.failedTaskIds).toHaveLength(1);
	});

	it("fails the sacrificial node by stable ascending entry revision, then task id", async () => {
		const harness = await baseHarness();
		for (const taskId of ["task_a", "task_b", "task_c"] as const) {
			const blocking = taskId === "task_a" ? "task_b" : taskId === "task_b" ? "task_c" : "task_a";
			harness.graph.create({
				taskId,
				graphRevision: 1,
				nodes: waitingDependsNodes(blocking, `wait_${taskId}`),
				clientRequestId: `g_${taskId}`,
			});
		}
		expect((await harness.queue.enqueue(queued({ queueEntryId: "queue_a", taskId: "task_a" }))).ok).toBe(true);
		expect((await harness.queue.claim({ queueEntryId: "queue_a", ownerId: OWNER_ID })).ok).toBe(true);
		expect((await harness.queue.enqueue(queued({ queueEntryId: "queue_c", taskId: "task_c" }))).ok).toBe(true);
		expect((await harness.queue.claim({ queueEntryId: "queue_c", ownerId: OWNER_ID })).ok).toBe(true);
		expect((await harness.queue.enqueue(queued({ queueEntryId: "queue_b", taskId: "task_b" }))).ok).toBe(true);
		const result = await harness.controller.tick();
		expect(result.cycles).toBe(1);
		expect(result.facts[0]?.memberTaskIds).toEqual(["task_a", "task_b", "task_c"]);
		expect(result.failedTaskIds).toEqual(["task_b"]);
	});

	it("reloads durable deadlock facts onto a new controller from the Session ledger", async () => {
		const harness = await baseHarness();
		harness.graph.create({
			taskId: "task_a",
			graphRevision: 1,
			nodes: waitingDependsNodes("task_b", "wait_a"),
			clientRequestId: "g_a",
		});
		harness.graph.create({
			taskId: "task_b",
			graphRevision: 1,
			nodes: waitingDependsNodes("task_a", "wait_b"),
			clientRequestId: "g_b",
		});
		expect((await harness.queue.enqueue(queued({ queueEntryId: "queue_a", taskId: "task_a" }))).ok).toBe(true);
		expect((await harness.queue.enqueue(queued({ queueEntryId: "queue_b", taskId: "task_b" }))).ok).toBe(true);
		const first = await harness.controller.tick();
		expect(first.facts).toHaveLength(1);
		const reloaded = new SchedulerDeadlockController({
			enabled: true,
			sessionId: "session_a",
			ownerId: OWNER_ID,
			ledger: harness.session,
			graph: harness.graph,
			queue: harness.queue,
			now: harness.time.now,
		});
		const loaded = await reloaded.reload();
		expect(loaded.ok).toBe(true);
		if (!loaded.ok) return;
		expect(loaded.value).toHaveLength(1);
		expect(loaded.value[0]?.detectionId).toBe(first.facts[0]?.detectionId);
		const events = await harness.session.findFoundationRecords({
			objectType: "scheduler.deadlock_detected",
			kind: "fact",
			order: "oldestFirst",
			includePruned: true,
		});
		expect(events.length).toBeGreaterThan(0);
		expect(events[0]).toMatchObject({
			kind: "fact",
			objectType: "scheduler.deadlock_detected",
		});
		const objects = await harness.session.findFoundationRecords({
			objectType: SCHEDULER_DEADLOCK_OBJECT_TYPE,
			kind: "fact",
			order: "oldestFirst",
			includePruned: true,
		});
		expect(objects).toHaveLength(1);
		const second = await reloaded.tick();
		expect(second.cycles).toBe(0);
	});

	it("ages waiting duration into effective priority so older work cannot starve", async () => {
		const fresh = queued({
			queueEntryId: "queue_fresh",
			taskId: "task_fresh",
			priority: 5,
			enqueuedAt: T1,
		});
		const aged = queued({
			queueEntryId: "queue_aged",
			taskId: "task_aged",
			priority: 0,
			enqueuedAt: T0,
		});
		expect(schedulerEffectivePriorityV1(fresh, T1)).toBe(5);
		expect(schedulerEffectivePriorityV1(aged, T1)).toBe(10);
		const ordered = schedulerOrderQueuedWorkV1([fresh, aged], T1);
		expect(ordered.map((entry) => entry.queueEntryId)).toEqual(["queue_aged", "queue_fresh"]);
		const harness = await baseHarness({ clock: clock(T1), maxQueueDepth: 8 });
		harness.graph.create({
			taskId: "task_fresh",
			graphRevision: 1,
			nodes: [{ nodeId: "node_task_fresh", dependsOn: [] }],
			clientRequestId: "g_fresh",
		});
		harness.graph.create({
			taskId: "task_aged",
			graphRevision: 1,
			nodes: [{ nodeId: "node_task_aged", dependsOn: [] }],
			clientRequestId: "g_aged",
		});
		expect((await harness.queue.enqueue(fresh)).ok).toBe(true);
		expect((await harness.queue.enqueue(aged)).ok).toBe(true);
		const result = await harness.controller.tick();
		expect(result.readyOrder[0]).toBe("queue_aged");
		expect(result.cycles).toBe(0);
	});

	it("emits scheduler_backpressure for queue depth and retains the extra candidate", async () => {
		const harness = await baseHarness({ maxQueueDepth: 2 });
		for (const taskId of ["task_a", "task_b", "task_c"]) {
			harness.graph.create({
				taskId,
				graphRevision: 1,
				nodes: [{ nodeId: `node_${taskId}`, dependsOn: [] }],
				clientRequestId: `g_${taskId}`,
			});
		}
		const result = await harness.controller.tick();
		expect(result.signals.some((signal) => signal.limit === "queue_depth")).toBe(true);
		expect(result.signals[0]?.code).toBe("scheduler_backpressure");
		const snapshot = await harness.queue.snapshot();
		expect(snapshot.ok).toBe(true);
		if (!snapshot.ok) return;
		expect(snapshot.value.entries.filter((entry) => entry.state === "queued")).toHaveLength(2);
		expect(result.retained.length).toBeGreaterThan(0);
		expect(harness.controller.retainedWork().some((item) => item.reason === "queue_depth")).toBe(true);
		expect(snapshot.value.entries.some((entry) => entry.taskId === "task_c" && entry.state === "cancelled")).toBe(
			false,
		);
	});

	it("emits scheduler_backpressure for per-Session active work and keeps the queued entry", async () => {
		const harness = await baseHarness({ sessionMaxActive: 1, globalMaxActive: 32 });
		harness.graph.create({
			taskId: "task_a",
			graphRevision: 1,
			nodes: [{ nodeId: "node_task_a", dependsOn: [] }],
			clientRequestId: "g_a",
		});
		harness.graph.create({
			taskId: "task_b",
			graphRevision: 1,
			nodes: [{ nodeId: "node_task_b", dependsOn: [] }],
			clientRequestId: "g_b",
		});
		await enqueueClaimed(
			harness.queue,
			queued({ queueEntryId: "queue_a", taskId: "task_a" }),
			OWNER_ID,
			"claim_a",
			"fence_a",
		);
		expect((await harness.queue.enqueue(queued({ queueEntryId: "queue_b", taskId: "task_b" }))).ok).toBe(true);
		const result = await harness.controller.tick();
		expect(result.signals.some((signal) => signal.limit === "session_active")).toBe(true);
		const snapshot = await harness.queue.snapshot();
		expect(snapshot.ok).toBe(true);
		if (!snapshot.ok) return;
		expect(snapshot.value.entries.find((entry) => entry.queueEntryId === "queue_b")?.state).toBe("queued");
		expect(result.retained.some((item) => item.queueEntryId === "queue_b" && item.reason === "session_active")).toBe(
			true,
		);
		expect(result.readyOrder).not.toContain("queue_b");
	});

	it("emits scheduler_backpressure for global active work and retains queued work", async () => {
		const harness = await baseHarness({ sessionMaxActive: 8, globalMaxActive: 1 });
		harness.graph.create({
			taskId: "task_a",
			graphRevision: 1,
			nodes: [{ nodeId: "node_task_a", dependsOn: [] }],
			clientRequestId: "g_a",
		});
		harness.graph.create({
			taskId: "task_b",
			graphRevision: 1,
			nodes: [{ nodeId: "node_task_b", dependsOn: [] }],
			clientRequestId: "g_b",
		});
		await enqueueClaimed(
			harness.queue,
			queued({ queueEntryId: "queue_a", taskId: "task_a" }),
			OWNER_ID,
			"claim_a",
			"fence_a",
		);
		expect((await harness.queue.enqueue(queued({ queueEntryId: "queue_b", taskId: "task_b" }))).ok).toBe(true);
		const result = await harness.controller.tick();
		expect(result.signals.some((signal) => signal.limit === "global_active")).toBe(true);
		const snapshot = await harness.queue.snapshot();
		expect(snapshot.ok).toBe(true);
		if (!snapshot.ok) return;
		expect(snapshot.value.entries.find((entry) => entry.queueEntryId === "queue_b")?.state).toBe("queued");
		expect(result.retained.some((item) => item.reason === "global_active")).toBe(true);
		expect(result.readyOrder).not.toContain("queue_b");
	});

	it("retries retained graph work on a later tick after durable queue capacity is released", async () => {
		const time = clock(T0);
		const manager = SessionManager.inMemory("/workspace/deadlock-depth", { id: "session_a" });
		const graph = graphStore(manager, undefined, time.now);
		for (const taskId of ["task_a", "task_b", "task_c"]) {
			graph.create({
				taskId,
				graphRevision: 1,
				nodes: [{ nodeId: `node_${taskId}`, dependsOn: [] }],
				clientRequestId: `g_${taskId}`,
			});
		}
		const session = new Session(new InMemorySessionStorage({ id: "session_a", createdAt: 1 }));
		const queue = new SchedulerQueueStore({
			ledger: session,
			sessionId: "session_a",
			ownerId: OWNER_ID,
			now: time.now,
			maxAttempts: 1,
		});
		const controller = new SchedulerDeadlockController({
			enabled: true,
			sessionId: "session_a",
			ownerId: OWNER_ID,
			ledger: session,
			graph,
			queue,
			now: time.now,
			maxQueueDepth: 2,
		});
		const first = await controller.tick();
		expect(first.signals.some((signal) => signal.limit === "queue_depth")).toBe(true);
		const retainedTaskId = first.retained.find((item) => item.reason === "queue_depth")?.taskId;
		expect(retainedTaskId).toBeDefined();
		const before = await queue.snapshot();
		expect(before.ok).toBe(true);
		if (!before.ok) return;
		const liveQueued = before.value.entries.filter((entry) => entry.state === "queued");
		expect(liveQueued).toHaveLength(2);
		const released = liveQueued[0];
		expect(released).toBeDefined();
		if (released === undefined) return;
		expect(
			(
				await queue.claim({
					queueEntryId: released.queueEntryId,
					ownerId: OWNER_ID,
					ttlMs: 1_000,
				})
			).ok,
		).toBe(true);
		time.set("2026-08-22T12:00:02.000Z");
		const recovered = await queue.recoverExpired();
		expect(recovered.ok).toBe(true);
		if (!recovered.ok) return;
		expect(recovered.value.some((item) => item.entry.queueEntryId === released.queueEntryId)).toBe(true);
		const second = await controller.tick();
		const after = await queue.snapshot();
		expect(after.ok).toBe(true);
		if (!after.ok) return;
		expect(after.value.entries.filter((entry) => !["settled", "cancelled"].includes(entry.state))).toHaveLength(2);
		expect(after.value.entries.some((entry) => entry.taskId === retainedTaskId && entry.state === "queued")).toBe(
			true,
		);
		expect(second.retained.some((item) => item.reason === "queue_depth" && item.taskId === retainedTaskId)).toBe(
			false,
		);
	});

	it("bounds scans so a tick cannot hang past its timeout", async () => {
		const frozen = clock(T0);
		const runtimeClock = new DeterministicClock({ wallTimeMs: Date.parse(T0) });
		const manager = SessionManager.inMemory("/workspace/deadlock-timeout", { id: "session_a" });
		const graph = graphStore(manager, undefined, frozen.now);
		for (let index = 0; index < 8; index += 1) {
			graph.create({
				taskId: `task_${index}`,
				graphRevision: 1,
				nodes: [
					{ nodeId: "n1", dependsOn: [] },
					{ nodeId: "n2", dependsOn: ["n1"] },
					{ nodeId: "n3", dependsOn: ["n2"] },
				],
				clientRequestId: `g_${index}`,
			});
		}
		const session = new Session(new InMemorySessionStorage({ id: "session_a", createdAt: 1 }));
		const queue = new SchedulerQueueStore({
			ledger: session,
			sessionId: "session_a",
			ownerId: OWNER_ID,
			now: frozen.now,
		});
		const controller = new SchedulerDeadlockController(
			withRuntimeClock(
				{
					enabled: true,
					sessionId: "session_a",
					ownerId: OWNER_ID,
					ledger: session,
					graph,
					queue,
					now: frozen.now,
					maxGraphsPerTick: 50,
					maxNodesPerTick: 64,
					tickTimeoutMs: 1,
				},
				runtimeClock,
			),
		);
		const pending = controller.tick();
		runtimeClock.advanceBy(1);
		const result = await pending;
		expect(result.timedOut).toBe(true);
		expect(result.scannedNodes).toBeLessThan(24);
		const bounded = new SchedulerDeadlockController({
			enabled: true,
			sessionId: "session_a",
			ownerId: OWNER_ID,
			ledger: session,
			graph,
			queue,
			now: frozen.now,
			maxGraphsPerTick: 1,
			maxNodesPerTick: 2,
		});
		const capped = await bounded.tick();
		expect(capped.scannedGraphs).toBeLessThanOrEqual(1);
		expect(capped.scannedNodes).toBeLessThanOrEqual(2);
	});

	it("returns timedOut when an awaited queue read never resolves and does not start a second tick", async () => {
		const frozen = clock(T0);
		const runtimeClock = new DeterministicClock({ wallTimeMs: Date.parse(T0) });
		const manager = SessionManager.inMemory("/workspace/deadlock-hang", { id: "session_a" });
		const graph = graphStore(manager, undefined, frozen.now);
		graph.create({
			taskId: "task_a",
			graphRevision: 1,
			nodes: [{ nodeId: "node_task_a", dependsOn: [] }],
			clientRequestId: "g_a",
		});
		const session = new Session(new InMemorySessionStorage({ id: "session_a", createdAt: 1 }));
		const queue = new SchedulerQueueStore({
			ledger: session,
			sessionId: "session_a",
			ownerId: OWNER_ID,
			now: frozen.now,
		});
		let snapshotCalls = 0;
		const hanging: SchedulerDeadlockQueueV1 = queueFacade(queue, () => {
			snapshotCalls += 1;
			return new Promise(() => {});
		});
		const controller = new SchedulerDeadlockController(
			withRuntimeClock(
				{
					enabled: true,
					sessionId: "session_a",
					ownerId: OWNER_ID,
					ledger: session,
					graph,
					queue: hanging,
					now: frozen.now,
					tickTimeoutMs: 50,
				},
				runtimeClock,
			),
		);
		const pending = controller.tick();
		for (let turn = 0; turn < 10 && snapshotCalls === 0; turn += 1) await Promise.resolve();
		expect(snapshotCalls).toBe(1);
		runtimeClock.advanceBy(50);
		const first = await pending;
		expect(first.timedOut).toBe(true);
		const second = await controller.tick();
		expect(second.timedOut).toBe(true);
	});

	it("does not persist or fail a victim when sacrificial revision evidence cannot be read", async () => {
		const time = clock();
		const harness = await baseHarness({ clock: time });
		harness.graph.create({
			taskId: "task_a",
			graphRevision: 1,
			nodes: waitingDependsNodes("task_b", "wait_a"),
			clientRequestId: "g_a",
		});
		harness.graph.create({
			taskId: "task_b",
			graphRevision: 1,
			nodes: waitingDependsNodes("task_a", "wait_b"),
			clientRequestId: "g_b",
		});
		expect((await harness.queue.enqueue(queued({ queueEntryId: "queue_a", taskId: "task_a" }))).ok).toBe(true);
		expect((await harness.queue.enqueue(queued({ queueEntryId: "queue_b", taskId: "task_b" }))).ok).toBe(true);
		let snapshots = 0;
		const failing = queueFacade(harness.queue, async () => {
			snapshots += 1;
			if (snapshots >= 2) {
				return Result.err(
					new FoundationError("scheduler_persistence_failed", "Forced snapshot failure", { retryable: false }),
				);
			}
			return harness.queue.snapshot();
		});
		const controller = new SchedulerDeadlockController({
			enabled: true,
			sessionId: "session_a",
			ownerId: OWNER_ID,
			ledger: harness.session,
			graph: harness.graph,
			queue: failing,
			now: time.now,
		});
		const result = await controller.tick();
		expect(result.facts).toHaveLength(0);
		expect(result.failedTaskIds).toHaveLength(0);
		expect(result.errors.some((error) => error.code === "scheduler_persistence_failed")).toBe(true);
		const snapshot = await harness.queue.snapshot();
		expect(snapshot.ok).toBe(true);
		if (!snapshot.ok) return;
		expect(snapshot.value.entries.every((entry) => entry.state === "queued")).toBe(true);
	});
});
