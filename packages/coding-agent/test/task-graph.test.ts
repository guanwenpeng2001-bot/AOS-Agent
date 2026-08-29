import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isAutomationErrorCode, type RunStatus, type RunTerminalStatus } from "../src/core/run-lifecycle.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { TASK_GATE_CUSTOM_TYPE, TaskGateStore, type TaskGateRecord, type TaskGateStatus } from "../src/core/task-gate.ts";
import {
	TASK_GRAPH_CUSTOM_TYPE,
	TASK_GRAPH_ERROR_CODES,
	TaskGraphError,
	TaskGraphStore,
	canonicalTaskGraphCreatePayload,
	foldTaskGraphEntries,
	isTaskGraphDefinitionRecord,
	isTaskGraphNodeRecord,
	isTaskGraphTransition,
	taskGraphActionForStatus,
	taskGraphCommandType,
	taskGraphNodeStatusForRunTerminal,
	type TaskGraphCreateRequest,
	type TaskGraphNodeStatus,
	type TaskGraphRunLookup,
	type TaskGraphRunSnapshot,
	type TaskGraphStatus,
	type TaskGraphStoreOptions,
} from "../src/core/scheduler/task-graph.ts";
import type { TaskGraphGateLookup } from "../src/core/scheduler/task-graph.ts";

const NOW = "2026-08-16T12:00:00.000Z";

function makeSession(): SessionManager {
	return SessionManager.inMemory("/workspace/task-graph");
}

class FakeRunLookup implements TaskGraphRunLookup {
	runs = new Map<string, { sessionId: string; status: RunStatus; receiptStatus?: RunTerminalStatus }>();
	calls: string[] = [];
	sessionId = "session";

	add(runId: string, status: RunStatus, overrides: Partial<{ sessionId: string; receiptStatus: RunTerminalStatus }> = {}) {
		this.runs.set(runId, {
			sessionId: overrides.sessionId ?? this.sessionId,
			status,
			...(overrides.receiptStatus === undefined ? {} : { receiptStatus: overrides.receiptStatus }),
		});
	}

	remove(runId: string) {
		this.runs.delete(runId);
	}

	get(runId: string): TaskGraphRunSnapshot | undefined {
		this.calls.push(runId);
		const run = this.runs.get(runId);
		if (run === undefined) return undefined;
		return {
			sessionId: run.sessionId,
			runId,
			status: run.status,
			...(run.receiptStatus === undefined ? {} : { receiptStatus: run.receiptStatus }),
		};
	}
}

class FakeGateLookup implements TaskGraphGateLookup {
	gates = new Map<string, TaskGateRecord>();
	calls: string[] = [];

	set(taskId: string, stageId: string, stageRevision: number, status: TaskGateStatus) {
		this.gates.set(`${taskId}\u0000${stageId}\u0000${stageRevision}`, {
			schemaVersion: 1,
			sessionId: "session",
			gateId: `gate_${stageId}`,
			taskId,
			stageId,
			stageRevision,
			status,
			revision: status === "pending" ? 0 : 1,
			requestedAt: NOW,
			...(status === "pending" ? {} : { decidedAt: NOW }),
		});
	}

	getByBusinessKey(taskId: string, stageId: string, stageRevision: number): TaskGateRecord | undefined {
		this.calls.push(`${taskId}\u0000${stageId}\u0000${stageRevision}`);
		return this.gates.get(`${taskId}\u0000${stageId}\u0000${stageRevision}`);
	}
}

function makeStore(
	session: SessionManager,
	runLookup: FakeRunLookup,
	gateLookup: FakeGateLookup,
	diagnostics?: NonNullable<TaskGraphStoreOptions["diagnostics"]>,
): TaskGraphStore {
	runLookup.sessionId = session.getSessionId();
	return new TaskGraphStore(session, runLookup, gateLookup, {
		now: () => NOW,
		...(diagnostics === undefined ? {} : { diagnostics }),
	});
}

function createRequest(
	overrides: Partial<{
		taskId: string;
		graphRevision: number;
		nodes: Array<{ nodeId: string; dependsOn: string[]; gateRef?: { stageId: string; stageRevision: number } }>;
		clientRequestId: string;
	}> = {},
) {
	return {
		taskId: "task_42",
		graphRevision: 1,
		nodes: [
			{ nodeId: "inspect", dependsOn: [] },
			{ nodeId: "implement", dependsOn: ["inspect"] },
			{
				nodeId: "review",
				dependsOn: ["implement"],
				gateRef: { stageId: "stage_review", stageRevision: 1 },
			},
		],
		clientRequestId: "create-1",
		...overrides,
	};
}

function attachRequest(
	overrides: Partial<{
		taskId: string;
		graphRevision: number;
		nodeId: string;
		runId: string;
		clientRequestId: string;
	}> = {},
) {
	return { taskId: "task_42", graphRevision: 1, nodeId: "inspect", runId: "run_a", clientRequestId: "attach-1", ...overrides };
}

function settleRequest(
	overrides: Partial<{ taskId: string; graphRevision: number; nodeId: string; clientRequestId: string }> = {},
) {
	return { taskId: "task_42", graphRevision: 1, nodeId: "inspect", clientRequestId: "settle-1", ...overrides };
}

function expectGraphError(fn: () => unknown, code: string): void {
	try {
		fn();
	} catch (error) {
		expect(error).toBeInstanceOf(TaskGraphError);
		expect((error as TaskGraphError).code).toBe(code);
		return;
	}
	throw new Error(`expected TaskGraphError with code ${code}`);
}

function pendingGraph(session: SessionManager, runLookup: FakeRunLookup, gateLookup: FakeGateLookup) {
	const store = makeStore(session, runLookup, gateLookup);
	store.create(createRequest());
	return store;
}

/** Attach `nodeId` to an accepted run and settle it with the given terminal status. */
function settleNode(
	store: TaskGraphStore,
	runLookup: FakeRunLookup,
	nodeId: string,
	runId: string,
	terminal: RunTerminalStatus,
	prefix: string,
): void {
	runLookup.add(runId, "accepted");
	store.attach(attachRequest({ nodeId, runId, clientRequestId: `${prefix}-attach` }));
	runLookup.add(runId, terminal, { receiptStatus: terminal });
	store.settle(settleRequest({ nodeId, clientRequestId: `${prefix}-settle` }));
}

describe("task graph store", () => {
	it("create persists the immutable definition with all pending nodes", () => {
		const session = makeSession();
		const store = makeStore(session, new FakeRunLookup(), new FakeGateLookup());

		const result = store.create(createRequest());

		expect(result.appended).toBe(true);
		expect(result.idempotent).toBe(false);
		expect(result.node).toBeUndefined();
		expect(result.entryId).toEqual(expect.any(String));
		expect(result.graph).toEqual({
			schemaVersion: 1,
			sessionId: session.getSessionId(),
			taskId: "task_42",
			graphRevision: 1,
			createdAt: NOW,
			nodes: [
				{ schemaVersion: 1, nodeId: "inspect", dependsOn: [], status: "pending", nodeRevision: 0, availability: "ready", blockingNodeIds: [] },
				{
					schemaVersion: 1,
					nodeId: "implement",
					dependsOn: ["inspect"],
					status: "pending",
					nodeRevision: 0,
					availability: "waiting_dependencies",
					blockingNodeIds: ["inspect"],
				},
				{
					schemaVersion: 1,
					nodeId: "review",
					dependsOn: ["implement"],
					gateRef: { stageId: "stage_review", stageRevision: 1 },
					status: "pending",
					nodeRevision: 0,
					availability: "waiting_dependencies",
					blockingNodeIds: ["implement"],
				},
			],
			summary: { status: "active", pending: 3, running: 0, succeeded: 0, failed: 0, cancelled: 0 },
		});
		expect(session.getEntries()).toHaveLength(1);
		expect(session.getEntries()[0]).toMatchObject({
			type: "custom",
			customType: TASK_GRAPH_CUSTOM_TYPE,
			data: {
				schemaVersion: 1,
				action: "created",
				taskId: "task_42",
				graphRevision: 1,
				clientRequestId: "create-1",
				graph: {
					schemaVersion: 1,
					sessionId: session.getSessionId(),
					taskId: "task_42",
					graphRevision: 1,
					createdAt: NOW,
					nodes: [
						{ nodeId: "inspect", dependsOn: [], status: "pending", nodeRevision: 0 },
						{ nodeId: "implement", dependsOn: ["inspect"], status: "pending", nodeRevision: 0 },
						{
							nodeId: "review",
							dependsOn: ["implement"],
							gateRef: { stageId: "stage_review", stageRevision: 1 },
							status: "pending",
							nodeRevision: 0,
						},
					],
				},
			},
		});
		expect(JSON.stringify(session.buildSessionContext())).not.toContain("task_42");
		expect(JSON.stringify(session.buildSessionContext())).not.toContain("implement");
	});

	it("rejects empty, duplicate, unknown-dependency, self-dependency, oversized, and unsafe graphs without writing", () => {
		const session = makeSession();
		const store = makeStore(session, new FakeRunLookup(), new FakeGateLookup());

		expectGraphError(() => store.create(createRequest({ nodes: [] })), "task_graph_invalid");
		expectGraphError(
			() =>
				store.create(
					createRequest({
						nodes: [
							{ nodeId: "a", dependsOn: [] },
							{ nodeId: "a", dependsOn: [] },
						],
					}),
				),
			"task_graph_invalid",
		);
		expectGraphError(
			() => store.create(createRequest({ nodes: [{ nodeId: "a", dependsOn: ["missing"] }] })),
			"task_graph_invalid",
		);
		expectGraphError(
			() => store.create(createRequest({ nodes: [{ nodeId: "a", dependsOn: ["a"] }] })),
			"task_graph_invalid",
		);
		expectGraphError(
			() => store.create(createRequest({ nodes: [{ nodeId: "a", dependsOn: ["b", "b"] }] })),
			"task_graph_invalid",
		);
		expectGraphError(
			() =>
				store.create(
					createRequest({
						nodes: Array.from({ length: 257 }, (_, index) => ({ nodeId: `n${index}`, dependsOn: [] })),
					}),
				),
			"task_graph_invalid",
		);
		expectGraphError(
			() =>
				store.create(
					createRequest({
						nodes: [
							{ nodeId: "a", dependsOn: [] },
							{ nodeId: "b", dependsOn: Array.from({ length: 65 }, (_, index) => `d${index}`) },
						],
					}),
				),
			"task_graph_invalid",
		);
		const hubs = Array.from({ length: 64 }, (_, index) => ({ nodeId: `h${index}`, dependsOn: [] as string[] }));
		const hubIds = hubs.map((hub) => hub.nodeId);
		const dependents = Array.from({ length: 17 }, (_, index) => ({ nodeId: `d${index}`, dependsOn: hubIds }));
		// 17 x 64 = 1088 edges exceeds the 1024 edge bound while staying under the node bound.
		expectGraphError(
			() => store.create(createRequest({ nodes: [...hubs, ...dependents] })),
			"task_graph_invalid",
		);
		expectGraphError(
			() => store.create(createRequest({ taskId: "x".repeat(300) })),
			"task_graph_invalid",
		);
		expectGraphError(
			() => store.create(createRequest({ clientRequestId: "x".repeat(129) })),
			"task_graph_invalid",
		);
		for (const graphRevision of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
			expectGraphError(() => store.create(createRequest({ graphRevision })), "task_graph_invalid");
		}
		for (const taskId of ["", "a/b", "http://host/x", "a b", "a@b"]) {
			expectGraphError(() => store.create(createRequest({ taskId })), "task_graph_invalid");
		}
		expect(session.getEntries()).toHaveLength(0);
	});

	it("rejects cyclic graphs with task_graph_dependency_cycle", () => {
		const session = makeSession();
		const store = makeStore(session, new FakeRunLookup(), new FakeGateLookup());

		expectGraphError(
			() =>
				store.create(
					createRequest({
						nodes: [
							{ nodeId: "a", dependsOn: ["b"] },
							{ nodeId: "b", dependsOn: ["a"] },
						],
					}),
				),
			"task_graph_dependency_cycle",
		);
		expectGraphError(
			() =>
				store.create(
					createRequest({
						nodes: [
							{ nodeId: "a", dependsOn: ["b"] },
							{ nodeId: "b", dependsOn: ["c"] },
							{ nodeId: "c", dependsOn: ["a"] },
						],
					}),
				),
			"task_graph_dependency_cycle",
		);
		expect(session.getEntries()).toHaveLength(0);
	});

	it("rejects forbidden payload fields without writing", () => {
		const session = makeSession();
		const store = makeStore(session, new FakeRunLookup(), new FakeGateLookup());

		expectGraphError(
			() => store.create({ ...createRequest(), prompt: "run this task" } as unknown as TaskGraphCreateRequest),
			"task_graph_invalid",
		);
		expectGraphError(
			() =>
				store.create({
					taskId: "task_42",
					graphRevision: 1,
					nodes: [
						{ nodeId: "a", dependsOn: [] },
						{ nodeId: "b", dependsOn: ["a"], content: "secret" },
					],
					clientRequestId: "create-1",
				} as unknown as TaskGraphCreateRequest),
			"task_graph_invalid",
		);
		expectGraphError(
			() =>
				store.create({
					taskId: "task_42",
					graphRevision: 1,
					nodes: [{ nodeId: "a", dependsOn: [], gateRef: { stageId: "s", stageRevision: 1, cwd: "/tmp" } }],
					clientRequestId: "create-1",
				} as unknown as TaskGraphCreateRequest),
			"task_graph_invalid",
		);
		expectGraphError(
			() =>
				store.create({
					taskId: "task_42",
					graphRevision: 1,
					nodes: [{ nodeId: "a", dependsOn: [], message: "secret" }],
					clientRequestId: "create-1",
				} as unknown as TaskGraphCreateRequest),
			"task_graph_invalid",
		);
		expect(session.getEntries()).toHaveLength(0);
	});

	it("rejects a second graph for the same business key", () => {
		const session = makeSession();
		const store = makeStore(session, new FakeRunLookup(), new FakeGateLookup());
		store.create(createRequest());

		expectGraphError(
			() =>
				store.create(
					createRequest({
						nodes: [{ nodeId: "other", dependsOn: [] }],
						clientRequestId: "create-2",
					}),
				),
			"task_graph_conflict",
		);
		expect(session.getEntries()).toHaveLength(1);
	});

	it("creates a new immutable graph for a higher graphRevision without touching the old one", () => {
		const session = makeSession();
		const store = makeStore(session, new FakeRunLookup(), new FakeGateLookup());
		const first = store.create(createRequest());

		const second = store.create(
			createRequest({ graphRevision: 2, nodes: [{ nodeId: "fresh", dependsOn: [] }], clientRequestId: "create-2" }),
		);

		expect(second.graph.graphRevision).toBe(2);
		expect(second.graph.nodes.map((node) => node.nodeId)).toEqual(["fresh"]);
		const firstAgain = store.get("task_42", 1);
		expect(firstAgain?.nodes.map((node) => node.nodeId)).toEqual(["inspect", "implement", "review"]);
		expect(firstAgain?.summary).toEqual(first.graph.summary);
		expect(store.list().graphs).toHaveLength(2);
	});

	it("replays an identical create idempotently even with reordered nodes", () => {
		const session = makeSession();
		const store = makeStore(session, new FakeRunLookup(), new FakeGateLookup());
		const first = store.create(createRequest());

		const replay = store.create(
			createRequest({
				nodes: [
					{ nodeId: "review", dependsOn: ["implement"], gateRef: { stageId: "stage_review", stageRevision: 1 } },
					{ nodeId: "implement", dependsOn: ["inspect"] },
					{ nodeId: "inspect", dependsOn: [] },
				],
			}),
		);

		expect(replay).toEqual({ graph: first.graph, appended: false, idempotent: true });
		expect(session.getEntries()).toHaveLength(1);
	});

	it("rejects a reused create clientRequestId with a different payload", () => {
		const session = makeSession();
		const store = makeStore(session, new FakeRunLookup(), new FakeGateLookup());
		store.create(createRequest());

		expectGraphError(
			() => store.create(createRequest({ nodes: [{ nodeId: "other", dependsOn: [] }] })),
			"task_graph_idempotency_conflict",
		);
		expectGraphError(() => store.create(createRequest({ graphRevision: 2 })), "task_graph_idempotency_conflict");
		expect(session.getEntries()).toHaveLength(1);
	});

	it("derives waiting_dependencies and ready from dependency status", () => {
		const session = makeSession();
		const runLookup = new FakeRunLookup();
		const store = pendingGraph(session, runLookup, new FakeGateLookup());

		const before = store.get("task_42", 1);
		expect(before?.nodes.map((node) => node.availability)).toEqual(["ready", "waiting_dependencies", "waiting_dependencies"]);
		expect(before?.nodes[1]?.blockingNodeIds).toEqual(["inspect"]);

		runLookup.add("run_a", "accepted");
		store.attach(attachRequest());
		expect(store.get("task_42", 1)?.nodes[0]).toMatchObject({ status: "running", availability: null });

		runLookup.add("run_a", "completed", { receiptStatus: "completed" });
		store.settle(settleRequest());
		const after = store.get("task_42", 1);
		expect(after?.nodes[0]).toMatchObject({ status: "succeeded", availability: null });
		expect(after?.nodes[1]).toMatchObject({ availability: "ready", blockingNodeIds: [] });
		expect(after?.nodes[2]).toMatchObject({ availability: "waiting_dependencies", blockingNodeIds: ["implement"] });
	});

	it("reports waiting_gate for missing and pending gates and ready for approved gates", () => {
		const session = makeSession();
		const runLookup = new FakeRunLookup();
		const gateLookup = new FakeGateLookup();
		const store = pendingGraph(session, runLookup, gateLookup);
		settleNode(store, runLookup, "inspect", "run_a", "completed", "a");
		settleNode(store, runLookup, "implement", "run_b", "completed", "b");

		expect(store.get("task_42", 1)?.nodes[2]).toMatchObject({ availability: "waiting_gate", gateStatus: "missing" });
		expect(gateLookup.calls).toContain("task_42\u0000stage_review\u00001");

		gateLookup.set("task_42", "stage_review", 1, "pending");
		expect(store.get("task_42", 1)?.nodes[2]).toMatchObject({ availability: "waiting_gate", gateStatus: "pending" });

		gateLookup.set("task_42", "stage_review", 1, "approved");
		expect(store.get("task_42", 1)?.nodes[2]).toMatchObject({ availability: "ready", gateStatus: "approved", blockingNodeIds: [] });
	});

	it("reports blocked for rejected or cancelled gates", () => {
		const session = makeSession();
		const runLookup = new FakeRunLookup();
		const gateLookup = new FakeGateLookup();
		const store = pendingGraph(session, runLookup, gateLookup);
		settleNode(store, runLookup, "inspect", "run_a", "completed", "a");
		settleNode(store, runLookup, "implement", "run_b", "completed", "b");

		gateLookup.set("task_42", "stage_review", 1, "rejected");
		expect(store.get("task_42", 1)?.nodes[2]).toMatchObject({ availability: "blocked", gateStatus: "rejected" });

		gateLookup.set("task_42", "stage_review", 1, "cancelled");
		expect(store.get("task_42", 1)?.nodes[2]).toMatchObject({ availability: "blocked", gateStatus: "cancelled" });
	});

	it("reports blocked when a dependency failed or was cancelled", () => {
		const session = makeSession();
		const runLookup = new FakeRunLookup();
		const store = makeStore(session, runLookup, new FakeGateLookup());
		store.create(createRequest({ nodes: [{ nodeId: "a", dependsOn: [] }, { nodeId: "b", dependsOn: ["a"] }] }));

		runLookup.add("run_a", "accepted");
		store.attach(attachRequest({ nodeId: "a", runId: "run_a", clientRequestId: "attach-a" }));
		runLookup.add("run_a", "failed", { receiptStatus: "failed" });
		store.settle(settleRequest({ nodeId: "a", clientRequestId: "settle-a" }));

		expect(store.get("task_42", 1)?.nodes[1]).toMatchObject({ availability: "blocked", blockingNodeIds: ["a"] });

		const cancelledSession = makeSession();
		const cancelledRuns = new FakeRunLookup();
		const cancelledStore = makeStore(cancelledSession, cancelledRuns, new FakeGateLookup());
		cancelledStore.create(
			createRequest({ nodes: [{ nodeId: "a", dependsOn: [] }, { nodeId: "b", dependsOn: ["a"] }], clientRequestId: "create-c" }),
		);
		settleNode(cancelledStore, cancelledRuns, "a", "run_x", "cancelled", "x");
		expect(cancelledStore.get("task_42", 1)?.nodes[1]).toMatchObject({ availability: "blocked", blockingNodeIds: ["a"] });
	});

	it("attach associates an accepted run and persists the transition", () => {
		const session = makeSession();
		const runLookup = new FakeRunLookup();
		const store = pendingGraph(session, runLookup, new FakeGateLookup());
		runLookup.add("run_a", "accepted");

		const result = store.attach(attachRequest());

		expect(result.appended).toBe(true);
		expect(result.idempotent).toBe(false);
		expect(result.node).toMatchObject({
			nodeId: "inspect",
			status: "running",
			nodeRevision: 1,
			runRef: { sessionId: session.getSessionId(), runId: "run_a" },
			availability: null,
			blockingNodeIds: [],
		});
		expect(session.getEntries()).toHaveLength(2);
		expect(session.getEntries()[1]).toMatchObject({
			customType: TASK_GRAPH_CUSTOM_TYPE,
			data: {
				schemaVersion: 1,
				action: "node.attached",
				taskId: "task_42",
				graphRevision: 1,
				previousNodeRevision: 0,
				clientRequestId: "attach-1",
				node: { nodeId: "inspect", status: "running", nodeRevision: 1, runRef: { sessionId: session.getSessionId(), runId: "run_a" } },
			},
		});
		expect(runLookup.calls).toEqual(["run_a", "run_a"]);
	});

	it("attach accepts a run that is already running", () => {
		const session = makeSession();
		const runLookup = new FakeRunLookup();
		const store = pendingGraph(session, runLookup, new FakeGateLookup());
		runLookup.add("run_a", "running");

		const result = store.attach(attachRequest());

		expect(result.node?.status).toBe("running");
		expect(result.node?.runRef?.runId).toBe("run_a");
	});

	it("attach rejects unknown, foreign, and terminal runs", () => {
		const session = makeSession();
		const runLookup = new FakeRunLookup();
		const store = pendingGraph(session, runLookup, new FakeGateLookup());

		expectGraphError(() => store.attach(attachRequest()), "task_graph_run_not_found");

		runLookup.add("run_a", "accepted", { sessionId: "other-session" });
		expectGraphError(() => store.attach(attachRequest()), "task_graph_run_not_found");

		runLookup.add("run_a", "accepted");
		runLookup.add("run_a", "completed");
		expectGraphError(() => store.attach(attachRequest()), "task_graph_run_not_found");
		expect(session.getEntries()).toHaveLength(1);
	});

	it("attach rejects nodes that are not pending and ready", () => {
		const session = makeSession();
		const runLookup = new FakeRunLookup();
		const gateLookup = new FakeGateLookup();
		const store = pendingGraph(session, runLookup, gateLookup);
		runLookup.add("run_a", "accepted");

		expectGraphError(
			() => store.attach(attachRequest({ nodeId: "implement", clientRequestId: "attach-b" })),
			"task_graph_node_not_eligible",
		);
		expectGraphError(
			() => store.attach(attachRequest({ nodeId: "review", clientRequestId: "attach-c" })),
			"task_graph_node_not_eligible",
		);
		expect(session.getEntries()).toHaveLength(1);
	});

	it("attach rejects nodes that already have a run or are terminal", () => {
		const session = makeSession();
		const runLookup = new FakeRunLookup();
		const store = pendingGraph(session, runLookup, new FakeGateLookup());
		runLookup.add("run_a", "accepted");
		store.attach(attachRequest());

		expectGraphError(
			() => store.attach(attachRequest({ clientRequestId: "attach-2" })),
			"task_graph_node_conflict",
		);

		runLookup.add("run_a", "completed", { receiptStatus: "completed" });
		store.settle(settleRequest());
		expectGraphError(
			() => store.attach(attachRequest({ runId: "run_a", clientRequestId: "attach-3" })),
			"task_graph_node_conflict",
		);
		expect(session.getEntries()).toHaveLength(3);
	});

	it("attach rejects a run already associated with another node of the same graph", () => {
		const session = makeSession();
		const runLookup = new FakeRunLookup();
		const store = makeStore(session, runLookup, new FakeGateLookup());
		store.create(createRequest({ nodes: [{ nodeId: "a", dependsOn: [] }, { nodeId: "b", dependsOn: [] }] }));
		runLookup.add("run_x", "accepted");
		store.attach(attachRequest({ nodeId: "a", runId: "run_x", clientRequestId: "attach-a" }));

		expectGraphError(
			() => store.attach(attachRequest({ nodeId: "b", runId: "run_x", clientRequestId: "attach-b" })),
			"task_graph_node_conflict",
		);
		expect(session.getEntries()).toHaveLength(2);
	});

	it("replays an identical attach idempotently without appending a second transition", () => {
		const session = makeSession();
		const runLookup = new FakeRunLookup();
		const store = pendingGraph(session, runLookup, new FakeGateLookup());
		runLookup.add("run_a", "accepted");
		const first = store.attach(attachRequest());

		const replay = store.attach(attachRequest());

		expect(replay).toEqual({ graph: first.graph, node: first.node, appended: false, idempotent: true });
		expect(session.getEntries()).toHaveLength(2);
	});

	it("rejects a reused attach clientRequestId with a different run", () => {
		const session = makeSession();
		const runLookup = new FakeRunLookup();
		const store = pendingGraph(session, runLookup, new FakeGateLookup());
		runLookup.add("run_a", "accepted");
		store.attach(attachRequest());

		expectGraphError(
			() => store.attach(attachRequest({ runId: "run_b" })),
			"task_graph_idempotency_conflict",
		);
		expect(session.getEntries()).toHaveLength(2);
	});

	it("settle maps completed, failed, and cancelled runs to node terminals", () => {
		const session = makeSession();
		const runLookup = new FakeRunLookup();
		const store = makeStore(session, runLookup, new FakeGateLookup());
		store.create(
			createRequest({
				nodes: [
					{ nodeId: "a", dependsOn: [] },
					{ nodeId: "b", dependsOn: [] },
					{ nodeId: "c", dependsOn: [] },
				],
			}),
		);

		settleNode(store, runLookup, "a", "run_a", "completed", "a");
		const succeeded = store.get("task_42", 1)?.nodes[0];
		expect(succeeded).toMatchObject({ status: "succeeded", nodeRevision: 2, runRef: { runId: "run_a" } });

		settleNode(store, runLookup, "b", "run_b", "failed", "b");
		expect(store.get("task_42", 1)?.nodes[1]).toMatchObject({ status: "failed", nodeRevision: 2 });

		settleNode(store, runLookup, "c", "run_c", "cancelled", "c");
		expect(store.get("task_42", 1)?.nodes[2]).toMatchObject({ status: "cancelled", nodeRevision: 2 });

		expect(session.getEntries()).toHaveLength(7);
		const terminalEntry = session.getEntries()[6] as { data?: { action?: string; node?: { status?: string } } };
		expect(terminalEntry.data?.action).toBe("node.cancelled");
		expect(terminalEntry.data?.node?.status).toBe("cancelled");
		expect(store.get("task_42", 1)?.summary).toEqual({
			status: "failed",
			pending: 0,
			running: 0,
			succeeded: 1,
			failed: 1,
			cancelled: 1,
		});
	});

	it("settle refuses non-terminal runs without appending", () => {
		const session = makeSession();
		const runLookup = new FakeRunLookup();
		const store = pendingGraph(session, runLookup, new FakeGateLookup());
		runLookup.add("run_a", "accepted");
		store.attach(attachRequest());

		expectGraphError(() => store.settle(settleRequest()), "task_graph_run_not_terminal");

		runLookup.add("run_a", "running");
		expectGraphError(() => store.settle(settleRequest()), "task_graph_run_not_terminal");
		expect(session.getEntries()).toHaveLength(2);
	});

	it("settle rejects inconsistent run record and receipt facts", () => {
		const session = makeSession();
		const runLookup = new FakeRunLookup();
		const store = pendingGraph(session, runLookup, new FakeGateLookup());
		runLookup.add("run_a", "accepted");
		store.attach(attachRequest());
		runLookup.add("run_a", "completed", { receiptStatus: "failed" });

		expectGraphError(() => store.settle(settleRequest()), "task_graph_run_state_mismatch");
		expect(session.getEntries()).toHaveLength(2);
	});

	it("settle requires the current terminal receipt and rejects a terminal record without one", () => {
		const session = makeSession();
		const runLookup = new FakeRunLookup();
		const store = pendingGraph(session, runLookup, new FakeGateLookup());
		runLookup.add("run_a", "accepted");
		store.attach(attachRequest());

		// The record claims a terminal status but no receipt backs it: settle must
		// not map the record status alone and must fail with state_mismatch.
		runLookup.add("run_a", "completed");
		expectGraphError(() => store.settle(settleRequest()), "task_graph_run_state_mismatch");
		expectGraphError(() => store.settle(settleRequest({ clientRequestId: "settle-2" })), "task_graph_run_state_mismatch");
		expect(session.getEntries()).toHaveLength(2);

		// Once the persisted receipt agrees with the record, the same request
		// settles normally.
		runLookup.add("run_a", "completed", { receiptStatus: "completed" });
		expect(store.settle(settleRequest()).node?.status).toBe("succeeded");
		expect(session.getEntries()).toHaveLength(3);
	});

	it("settle rejects unknown or foreign runs", () => {
		const session = makeSession();
		const runLookup = new FakeRunLookup();
		const store = pendingGraph(session, runLookup, new FakeGateLookup());
		runLookup.add("run_a", "accepted");
		store.attach(attachRequest());
		runLookup.remove("run_a");

		expectGraphError(() => store.settle(settleRequest()), "task_graph_run_not_found");
	});

	it("settle rejects pending nodes, unknown graphs, and unknown nodes", () => {
		const session = makeSession();
		const runLookup = new FakeRunLookup();
		const store = pendingGraph(session, runLookup, new FakeGateLookup());

		expectGraphError(() => store.settle(settleRequest()), "task_graph_node_conflict");
		expectGraphError(
			() => store.settle(settleRequest({ taskId: "task_missing" })),
			"task_graph_not_found",
		);
		expectGraphError(
			() => store.settle(settleRequest({ nodeId: "ghost" })),
			"task_graph_node_not_found",
		);
		expect(session.getEntries()).toHaveLength(1);
	});

	it("settle rejects a terminal node with a new key and replays with the same key", () => {
		const session = makeSession();
		const runLookup = new FakeRunLookup();
		const store = pendingGraph(session, runLookup, new FakeGateLookup());
		settleNode(store, runLookup, "inspect", "run_a", "completed", "a");
		const before = store.get("task_42", 1);

		expectGraphError(
			() => store.settle(settleRequest({ clientRequestId: "settle-again" })),
			"task_graph_node_conflict",
		);

		const replay = store.settle(settleRequest({ clientRequestId: "a-settle" }));
		expect(replay).toEqual({
			graph: before,
			node: before?.nodes[0],
			appended: false,
			idempotent: true,
		});
		expect(session.getEntries()).toHaveLength(3);
	});

	it("settles concurrent attach and settle with first writer wins", () => {
		const session = makeSession();
		const runLookup = new FakeRunLookup();
		const first = makeStore(session, runLookup, new FakeGateLookup());
		const second = makeStore(session, runLookup, new FakeGateLookup());
		first.create(createRequest());
		runLookup.add("run_a", "accepted");

		const attached = first.attach(attachRequest());
		expect(attached.node?.status).toBe("running");

		expectGraphError(
			() => second.attach(attachRequest({ clientRequestId: "attach-other" })),
			"task_graph_node_conflict",
		);

		runLookup.add("run_a", "completed", { receiptStatus: "completed" });
		expect(first.settle(settleRequest()).node?.status).toBe("succeeded");
		expectGraphError(
			() => second.settle(settleRequest({ clientRequestId: "settle-other" })),
			"task_graph_node_conflict",
		);
		expect(session.getEntries()).toHaveLength(3);
	});

	it("computes aggregate summaries for active, succeeded, failed, and cancelled graphs", () => {
		const succeededSession = makeSession();
		const succeededRuns = new FakeRunLookup();
		const succeededStore = makeStore(succeededSession, succeededRuns, new FakeGateLookup());
		succeededStore.create(createRequest({ nodes: [{ nodeId: "a", dependsOn: [] }] }));
		settleNode(succeededStore, succeededRuns, "a", "run_a", "completed", "a");
		expect(succeededStore.get("task_42", 1)?.summary.status).toBe("succeeded");

		const failedSession = makeSession();
		const failedRuns = new FakeRunLookup();
		const failedStore = makeStore(failedSession, failedRuns, new FakeGateLookup());
		failedStore.create(createRequest({ nodes: [{ nodeId: "a", dependsOn: [] }, { nodeId: "b", dependsOn: [] }] }));
		settleNode(failedStore, failedRuns, "a", "run_a", "failed", "a");
		settleNode(failedStore, failedRuns, "b", "run_b", "completed", "b");
		expect(failedStore.get("task_42", 1)?.summary.status).toBe("failed");

		const cancelledSession = makeSession();
		const cancelledRuns = new FakeRunLookup();
		const cancelledStore = makeStore(cancelledSession, cancelledRuns, new FakeGateLookup());
		cancelledStore.create(
			createRequest({ nodes: [{ nodeId: "a", dependsOn: [] }, { nodeId: "b", dependsOn: [] }], clientRequestId: "create-c" }),
		);
		settleNode(cancelledStore, cancelledRuns, "a", "run_a", "cancelled", "a");
		settleNode(cancelledStore, cancelledRuns, "b", "run_b", "completed", "b");
		expect(cancelledStore.get("task_42", 1)?.summary.status).toBe("cancelled");

		const activeSession = makeSession();
		const activeRuns = new FakeRunLookup();
		const activeStore = makeStore(activeSession, activeRuns, new FakeGateLookup());
		activeStore.create(createRequest({ nodes: [{ nodeId: "a", dependsOn: [] }, { nodeId: "b", dependsOn: [] }], clientRequestId: "create-a" }));
		activeRuns.add("run_a", "accepted");
		activeStore.attach(attachRequest({ nodeId: "a", runId: "run_a", clientRequestId: "attach-a" }));
		const summary = activeStore.get("task_42", 1)?.summary;
		expect(summary).toMatchObject({ status: "active", pending: 1, running: 1 });
	});

	it("recovers definitions, running nodes, and terminal nodes after a session reload from disk", () => {
		const dir = mkdtempSync(join(tmpdir(), "task-graph-reload-"));
		try {
			const first = SessionManager.create(dir, dir);
			first.appendMessage({ role: "user", content: "seed", timestamp: 1 });
			first.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: "seed reply" }],
				api: "anthropic-messages",
				provider: "test",
				model: "test-model",
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				stopReason: "stop" as const,
				timestamp: 2,
			});
			const runLookup = new FakeRunLookup();
			const store = makeStore(first, runLookup, new FakeGateLookup());
			store.create(createRequest());
			settleNode(store, runLookup, "inspect", "run_a", "completed", "a");
			runLookup.add("run_b", "accepted");
			store.attach(attachRequest({ nodeId: "implement", runId: "run_b", clientRequestId: "attach-b" }));
			const sessionFile = first.getSessionFile();
			if (!sessionFile) throw new Error("expected a persisted session file");

			const reloaded = SessionManager.open(sessionFile, dir);
			const restored = makeStore(reloaded, new FakeRunLookup(), new FakeGateLookup());

			expect(restored.warnings()).toEqual([]);
			const graph = restored.get("task_42", 1);
			expect(graph?.nodes[0]).toMatchObject({ status: "succeeded", nodeRevision: 2, runRef: { runId: "run_a" } });
			expect(graph?.nodes[1]).toMatchObject({ status: "running", nodeRevision: 1, runRef: { runId: "run_b" } });
			expect(graph?.nodes[2]).toMatchObject({ status: "pending", availability: "waiting_dependencies", blockingNodeIds: ["implement"] });
			expect(graph?.summary).toMatchObject({ status: "active", pending: 1, running: 1, succeeded: 1 });
			expect(restored.list().graphs).toHaveLength(1);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("skips malformed, unsupported, mismatched, gapped, and conflicting entries without exposing raw data", () => {
		const session = makeSession();
		pendingGraph(session, new FakeRunLookup(), new FakeGateLookup());
		const sessionId = session.getSessionId();
		const definition = {
			schemaVersion: 1,
			sessionId,
			taskId: "task_42",
			graphRevision: 1,
			createdAt: NOW,
			nodes: [
				{ schemaVersion: 1, nodeId: "inspect", dependsOn: [], status: "pending", nodeRevision: 0 },
				{ schemaVersion: 1, nodeId: "implement", dependsOn: ["inspect"], status: "pending", nodeRevision: 0 },
				{
					schemaVersion: 1,
					nodeId: "review",
					dependsOn: ["implement"],
					gateRef: { stageId: "stage_review", stageRevision: 1 },
					status: "pending",
					nodeRevision: 0,
				},
			],
		};

		session.appendCustomEntry(TASK_GRAPH_CUSTOM_TYPE, { schemaVersion: 2, action: "created" });
		session.appendCustomEntry(TASK_GRAPH_CUSTOM_TYPE, "raw garbage");
		session.appendCustomEntry(TASK_GRAPH_CUSTOM_TYPE, {
			schemaVersion: 1,
			action: "created",
			taskId: "task_50",
			graphRevision: 1,
			clientRequestId: "create-other",
			graph: { ...definition, sessionId: "other-session", taskId: "task_50" },
		});
		session.appendCustomEntry(TASK_GRAPH_CUSTOM_TYPE, {
			schemaVersion: 1,
			action: "node.attached",
			taskId: "task_99",
			graphRevision: 1,
			clientRequestId: "attach-ghost-graph",
			node: {
				schemaVersion: 1,
				nodeId: "a",
				dependsOn: [],
				status: "running",
				nodeRevision: 1,
				runRef: { sessionId, runId: "run_x" },
			},
			previousNodeRevision: 0,
		});
		const businessConflictId = session.appendCustomEntry(TASK_GRAPH_CUSTOM_TYPE, {
			schemaVersion: 1,
			action: "created",
			taskId: "task_42",
			graphRevision: 1,
			clientRequestId: "create-dup",
			graph: definition,
		});
		session.appendCustomEntry(TASK_GRAPH_CUSTOM_TYPE, {
			schemaVersion: 1,
			action: "created",
			taskId: "task_98",
			graphRevision: 1,
			clientRequestId: "create-cycle",
			graph: {
				...definition,
				taskId: "task_98",
				nodes: [
					{ schemaVersion: 1, nodeId: "a", dependsOn: ["b"], status: "pending", nodeRevision: 0 },
					{ schemaVersion: 1, nodeId: "b", dependsOn: ["a"], status: "pending", nodeRevision: 0 },
				],
			},
		});
		const ghostNodeId = session.appendCustomEntry(TASK_GRAPH_CUSTOM_TYPE, {
			schemaVersion: 1,
			action: "node.attached",
			taskId: "task_42",
			graphRevision: 1,
			clientRequestId: "attach-ghost",
			node: {
				schemaVersion: 1,
				nodeId: "ghost",
				dependsOn: [],
				status: "running",
				nodeRevision: 1,
				runRef: { sessionId, runId: "run_x" },
			},
			previousNodeRevision: 0,
		});
		const validAttachId = session.appendCustomEntry(TASK_GRAPH_CUSTOM_TYPE, {
			schemaVersion: 1,
			action: "node.attached",
			taskId: "task_42",
			graphRevision: 1,
			clientRequestId: "attach-a-1",
			node: {
				schemaVersion: 1,
				nodeId: "inspect",
				dependsOn: [],
				status: "running",
				nodeRevision: 1,
				runRef: { sessionId, runId: "run_a" },
			},
			previousNodeRevision: 0,
		});
		const secondAttachId = session.appendCustomEntry(TASK_GRAPH_CUSTOM_TYPE, {
			schemaVersion: 1,
			action: "node.attached",
			taskId: "task_42",
			graphRevision: 1,
			clientRequestId: "attach-a-2",
			node: {
				schemaVersion: 1,
				nodeId: "inspect",
				dependsOn: [],
				status: "running",
				nodeRevision: 1,
				runRef: { sessionId, runId: "run_b" },
			},
			previousNodeRevision: 0,
		});
		const sharedRunId = session.appendCustomEntry(TASK_GRAPH_CUSTOM_TYPE, {
			schemaVersion: 1,
			action: "node.attached",
			taskId: "task_42",
			graphRevision: 1,
			clientRequestId: "attach-b",
			node: {
				schemaVersion: 1,
				nodeId: "implement",
				dependsOn: ["inspect"],
				status: "running",
				nodeRevision: 1,
				runRef: { sessionId, runId: "run_a" },
			},
			previousNodeRevision: 0,
		});
		const changedRunId = session.appendCustomEntry(TASK_GRAPH_CUSTOM_TYPE, {
			schemaVersion: 1,
			action: "node.failed",
			taskId: "task_42",
			graphRevision: 1,
			clientRequestId: "settle-a-other-run",
			node: {
				schemaVersion: 1,
				nodeId: "inspect",
				dependsOn: [],
				status: "failed",
				nodeRevision: 2,
				runRef: { sessionId, runId: "run_c" },
			},
			previousNodeRevision: 1,
		});
		const validTerminalId = session.appendCustomEntry(TASK_GRAPH_CUSTOM_TYPE, {
			schemaVersion: 1,
			action: "node.succeeded",
			taskId: "task_42",
			graphRevision: 1,
			clientRequestId: "settle-a-1",
			node: {
				schemaVersion: 1,
				nodeId: "inspect",
				dependsOn: [],
				status: "succeeded",
				nodeRevision: 2,
				runRef: { sessionId, runId: "run_a" },
			},
			previousNodeRevision: 1,
		});
		const repeatTerminalId = session.appendCustomEntry(TASK_GRAPH_CUSTOM_TYPE, {
			schemaVersion: 1,
			action: "node.succeeded",
			taskId: "task_42",
			graphRevision: 1,
			clientRequestId: "settle-a-dup",
			node: {
				schemaVersion: 1,
				nodeId: "inspect",
				dependsOn: [],
				status: "succeeded",
				nodeRevision: 2,
				runRef: { sessionId, runId: "run_a" },
			},
			previousNodeRevision: 1,
		});
		const idempotencyConflictId = session.appendCustomEntry(TASK_GRAPH_CUSTOM_TYPE, {
			schemaVersion: 1,
			action: "node.attached",
			taskId: "task_42",
			graphRevision: 1,
			clientRequestId: "attach-a-1",
			node: {
				schemaVersion: 1,
				nodeId: "implement",
				dependsOn: ["inspect"],
				status: "running",
				nodeRevision: 1,
				runRef: { sessionId, runId: "run_d" },
			},
			previousNodeRevision: 0,
		});

		const restarted = makeStore(session, new FakeRunLookup(), new FakeGateLookup());

		const graph = restarted.get("task_42", 1);
		expect(graph?.nodes[0]).toMatchObject({ status: "succeeded", nodeRevision: 2, runRef: { runId: "run_a" } });
		expect(graph?.nodes[1]).toMatchObject({ status: "pending", nodeRevision: 0 });
		expect(graph?.nodes[2]).toMatchObject({ status: "pending", nodeRevision: 0 });
		expect(restarted.list().graphs.map((candidate) => candidate.taskId)).toEqual(["task_42"]);
		expect(restarted.warnings().map((warning) => warning.code)).toEqual([
			"unsupported_schema",
			"malformed_source",
			"session_mismatch",
			"revision_gap",
			"business_key_conflict",
			"malformed_source",
			"revision_gap",
			"run_association_conflict",
			"run_association_conflict",
			"run_association_conflict",
			"illegal_transition",
			"idempotency_conflict",
		]);
		expect(restarted.warnings().map((warning) => warning.entryId)).toEqual([
			expect.any(String),
			expect.any(String),
			expect.any(String),
			expect.any(String),
			businessConflictId,
			expect.any(String),
			ghostNodeId,
			secondAttachId,
			sharedRunId,
			changedRunId,
			repeatTerminalId,
			idempotencyConflictId,
		]);
		expect(validAttachId).toEqual(expect.any(String));
		expect(validTerminalId).toEqual(expect.any(String));
		expect(JSON.stringify(restarted.warnings())).not.toContain("raw garbage");
		expect(JSON.stringify(restarted.warnings())).not.toContain("other-session");
		expect(JSON.stringify(restarted.warnings())).not.toContain('"runId"');
		expect(JSON.stringify(restarted.warnings())).not.toContain('"nodeId"');
	});

	it("rejects node transitions whose run association leaves the current session", () => {
		const session = makeSession();
		pendingGraph(session, new FakeRunLookup(), new FakeGateLookup());

		const foreignAttachId = session.appendCustomEntry(TASK_GRAPH_CUSTOM_TYPE, {
			schemaVersion: 1,
			action: "node.attached",
			taskId: "task_42",
			graphRevision: 1,
			clientRequestId: "attach-foreign",
			node: {
				schemaVersion: 1,
				nodeId: "inspect",
				dependsOn: [],
				status: "running",
				nodeRevision: 1,
				runRef: { sessionId: "other-session", runId: "run_x" },
			},
			previousNodeRevision: 0,
		});
		const foreignSettleId = session.appendCustomEntry(TASK_GRAPH_CUSTOM_TYPE, {
			schemaVersion: 1,
			action: "node.succeeded",
			taskId: "task_42",
			graphRevision: 1,
			clientRequestId: "settle-foreign",
			node: {
				schemaVersion: 1,
				nodeId: "inspect",
				dependsOn: [],
				status: "succeeded",
				nodeRevision: 2,
				runRef: { sessionId: "other-session", runId: "run_x" },
			},
			previousNodeRevision: 1,
		});

		const restarted = makeStore(session, new FakeRunLookup(), new FakeGateLookup());

		// Neither foreign fact entered the public projection; the node stays
		// pending and the warnings never echo the foreign session id.
		expect(restarted.get("task_42", 1)?.nodes[0]).toMatchObject({ status: "pending", nodeRevision: 0 });
		expect(restarted.warnings().map((warning) => warning.code)).toEqual(["session_mismatch", "illegal_transition"]);
		expect(restarted.warnings().map((warning) => warning.entryId)).toEqual([foreignAttachId, foreignSettleId]);
		expect(JSON.stringify(restarted.warnings())).not.toContain("other-session");
		expect(JSON.stringify(restarted.warnings())).not.toContain("run_x");
	});

	it("folds duplicate identical idempotent transitions into a single result without warnings", () => {
		const session = makeSession();
		const sessionId = session.getSessionId();
		const created = {
			schemaVersion: 1,
			action: "created",
			taskId: "task_42",
			graphRevision: 1,
			clientRequestId: "create-1",
			graph: {
				schemaVersion: 1,
				sessionId,
				taskId: "task_42",
				graphRevision: 1,
				createdAt: NOW,
				nodes: [{ schemaVersion: 1, nodeId: "a", dependsOn: [], status: "pending", nodeRevision: 0 }],
			},
		};
		const attached = {
			schemaVersion: 1,
			action: "node.attached",
			taskId: "task_42",
			graphRevision: 1,
			clientRequestId: "attach-a",
			node: {
				schemaVersion: 1,
				nodeId: "a",
				dependsOn: [],
				status: "running",
				nodeRevision: 1,
				runRef: { sessionId, runId: "run_a" },
			},
			previousNodeRevision: 0,
		};
		session.appendCustomEntry(TASK_GRAPH_CUSTOM_TYPE, created);
		session.appendCustomEntry(TASK_GRAPH_CUSTOM_TYPE, created);
		session.appendCustomEntry(TASK_GRAPH_CUSTOM_TYPE, attached);
		session.appendCustomEntry(TASK_GRAPH_CUSTOM_TYPE, attached);

		const folded = foldTaskGraphEntries(session.getEntries(), sessionId);

		expect(folded.graphs).toHaveLength(1);
		expect(folded.byNodeId.get(`${sessionId}\u0000task_42\u00001`)?.get("a")).toMatchObject({ status: "running" });
		expect(folded.warnings).toEqual([]);
	});

	it("reports append failures as persistence errors without acknowledging success", () => {
		const inner = makeSession();
		const session = {
			getSessionId: () => inner.getSessionId(),
			getEntries: () => inner.getEntries(),
			appendCustomEntry: () => {
				throw new Error("disk full");
			},
		};
		const store = new TaskGraphStore(session, new FakeRunLookup(), new FakeGateLookup(), { now: () => NOW });

		expectGraphError(() => store.create(createRequest()), "task_graph_persistence_failed");
		expect(inner.getEntries()).toHaveLength(0);
	});

	it("does not acknowledge an append that is not visible in durable entries", () => {
		const inner = makeSession();
		const session = {
			getSessionId: () => inner.getSessionId(),
			getEntries: () => inner.getEntries(),
			appendCustomEntry: () => "entry-not-visible",
		};
		const store = new TaskGraphStore(session, new FakeRunLookup(), new FakeGateLookup(), { now: () => NOW });

		expectGraphError(() => store.create(createRequest()), "task_graph_persistence_failed");
		expect(inner.getEntries()).toHaveLength(0);
	});

	it("does not acknowledge a create when a concurrent writer claims the business key first", () => {
		const inner = makeSession();
		const sessionId = inner.getSessionId();
		let raced = false;
		// The wrapper lets a concurrent writer win the append race: a conflicting
		// create for the same business key is appended just before ours.
		const session = {
			getSessionId: () => sessionId,
			getEntries: () => inner.getEntries(),
			appendCustomEntry: (customType: string, data?: unknown) => {
				if (raced) return inner.appendCustomEntry(customType, data);
				raced = true;
				inner.appendCustomEntry(TASK_GRAPH_CUSTOM_TYPE, {
					schemaVersion: 1,
					action: "created",
					taskId: "task_42",
					graphRevision: 1,
					clientRequestId: "create-winner",
					graph: {
						schemaVersion: 1,
						sessionId,
						taskId: "task_42",
						graphRevision: 1,
						createdAt: NOW,
						nodes: [{ schemaVersion: 1, nodeId: "winner", dependsOn: [], status: "pending", nodeRevision: 0 }],
					},
				});
				return inner.appendCustomEntry(customType, data);
			},
		};
		const store = new TaskGraphStore(session, new FakeRunLookup(), new FakeGateLookup(), { now: () => NOW });

		// Our create was not the folded transition; it must not be acknowledged.
		expectGraphError(() => store.create(createRequest()), "task_graph_persistence_failed");
		expect(store.get("task_42", 1)?.nodes.map((node) => node.nodeId)).toEqual(["winner"]);
	});

	it("does not acknowledge an attach when a concurrent first valid transition wins the race", () => {
		const inner = makeSession();
		const sessionId = inner.getSessionId();
		const runLookup = new FakeRunLookup();
		const gateLookup = new FakeGateLookup();
		const seed = makeStore(inner, runLookup, gateLookup);
		seed.create(createRequest({ nodes: [{ nodeId: "a", dependsOn: [] }, { nodeId: "b", dependsOn: [] }] }));
		let raced = false;
		const session = {
			getSessionId: () => sessionId,
			getEntries: () => inner.getEntries(),
			appendCustomEntry: (customType: string, data?: unknown) => {
				if (raced) return inner.appendCustomEntry(customType, data);
				raced = true;
				// The concurrent first valid transition attaches node "a" to run_x;
				// our later attach of run_a to the same node is then dropped.
				inner.appendCustomEntry(TASK_GRAPH_CUSTOM_TYPE, {
					schemaVersion: 1,
					action: "node.attached",
					taskId: "task_42",
					graphRevision: 1,
					clientRequestId: "attach-winner",
					node: {
						schemaVersion: 1,
						nodeId: "a",
						dependsOn: [],
						status: "running",
						nodeRevision: 1,
						runRef: { sessionId, runId: "run_x" },
					},
					previousNodeRevision: 0,
				});
				return inner.appendCustomEntry(customType, data);
			},
		};
		const store = new TaskGraphStore(session, runLookup, gateLookup, { now: () => NOW });
		runLookup.add("run_x", "accepted");
		runLookup.add("run_a", "accepted");

		// Our attach must not be reported as success: the winner's transition is
		// the folded state and our transition was skipped.
		expectGraphError(
			() => store.attach(attachRequest({ nodeId: "a", runId: "run_a", clientRequestId: "attach-a" })),
			"task_graph_persistence_failed",
		);
		expect(store.get("task_42", 1)?.nodes[0]).toMatchObject({
			status: "running",
			runRef: { sessionId, runId: "run_x" },
		});
		expect(store.get("task_42", 1)?.nodes[1]).toMatchObject({ status: "pending" });
	});

	it("fails without writing when the timestamp source fails", () => {
		const session = makeSession();
		const store = new TaskGraphStore(session, new FakeRunLookup(), new FakeGateLookup(), {
			now: () => {
				throw new Error("clock broken");
			},
		});

		expectGraphError(() => store.create(createRequest()), "task_graph_persistence_failed");
		expect(session.getEntries()).toHaveLength(0);
	});

	it("keeps get and list read-only and applies filters and bounded limits", () => {
		const session = makeSession();
		const runLookup = new FakeRunLookup();
		const store = makeStore(session, runLookup, new FakeGateLookup());
		store.create(createRequest());
		settleNode(store, runLookup, "inspect", "run_a", "completed", "a");
		store.create(createRequest({ taskId: "task_7", clientRequestId: "create-2" }));
		const entriesBefore = session.getEntries().length;

		expect(store.get("task_42", 1)?.summary.status).toBe("active");
		expect(store.get("task_unknown", 1)).toBeUndefined();
		expectGraphError(() => store.get("bad/id", 1), "task_graph_invalid");
		expectGraphError(() => store.get("task_42", 0), "task_graph_invalid");
		expect(store.list().graphs).toHaveLength(2);
		expect(store.list({ taskId: "task_42" }).graphs).toHaveLength(1);
		expect(store.list({ graphRevision: 1, taskId: "task_7" }).graphs.map((candidate) => candidate.taskId)).toEqual(["task_7"]);
		expect(store.list({ status: "active" as TaskGraphStatus }).graphs).toHaveLength(2);
		expect(store.list({ status: "succeeded" as TaskGraphStatus }).graphs).toHaveLength(0);
		const truncated = store.list({ limit: 1 });
		expect(truncated.graphs).toHaveLength(1);
		expect(truncated.truncated).toBe(true);
		expect(store.list({ limit: 100 }).truncated).toBe(false);
		expectGraphError(() => store.list({ limit: 101 }), "task_graph_invalid");
		expectGraphError(() => store.list({ limit: 0 }), "task_graph_invalid");
		expectGraphError(() => store.list({ status: "running" as TaskGraphStatus }), "task_graph_invalid");
		expectGraphError(() => store.list({ taskId: "bad/id" }), "task_graph_invalid");
		expect(session.getEntries()).toHaveLength(entriesBefore);
	});

	it("returns defensive copies that cannot mutate store state", () => {
		const session = makeSession();
		const store = makeStore(session, new FakeRunLookup(), new FakeGateLookup());
		store.create(createRequest());
		const graph = store.get("task_42", 1);
		if (graph === undefined) throw new Error("expected graph");

		(graph.nodes[0] as { status: string }).status = "succeeded";
		(graph.nodes[0] as { nodeRevision: number }).nodeRevision = 9;
		(graph.summary as { status: string }).status = "failed";
		expect(store.get("task_42", 1)?.nodes[0]).toMatchObject({ status: "pending", nodeRevision: 0 });
		expect(store.get("task_42", 1)?.summary.status).toBe("active");
	});

	it("emits diagnostics once per malformed entry", () => {
		const session = makeSession();
		session.appendCustomEntry(TASK_GRAPH_CUSTOM_TYPE, "raw garbage");
		const codes: string[] = [];
		const store = new TaskGraphStore(session, new FakeRunLookup(), new FakeGateLookup(), {
			now: () => NOW,
			diagnostics: (warning) => codes.push(warning.code),
		});

		store.refresh();

		expect(codes).toEqual(["malformed_source"]);
	});

	it("registers every task_graph error code in the shared AutomationErrorCode contract", () => {
		expect(TASK_GRAPH_ERROR_CODES).toHaveLength(12);
		for (const code of TASK_GRAPH_ERROR_CODES) {
			expect(isAutomationErrorCode(code)).toBe(true);
		}
		expect(isAutomationErrorCode("task_graph_run_state_mismatch")).toBe(true);
		expect(isAutomationErrorCode("not_a_graph_code")).toBe(false);
	});

	it("exposes stable action, command, and status mappings", () => {
		expect(taskGraphCommandType("created")).toBe("task.graph.create");
		expect(taskGraphCommandType("node.attached")).toBe("task.graph.node.attach");
		expect(taskGraphCommandType("node.succeeded")).toBe("task.graph.node.settle");
		expect(taskGraphCommandType("node.failed")).toBe("task.graph.node.settle");
		expect(taskGraphCommandType("node.cancelled")).toBe("task.graph.node.settle");
		expect(taskGraphActionForStatus("pending")).toBe("created");
		expect(taskGraphActionForStatus("running")).toBe("node.attached");
		expect(taskGraphActionForStatus("succeeded")).toBe("node.succeeded");
		expect(taskGraphActionForStatus("failed")).toBe("node.failed");
		expect(taskGraphActionForStatus("cancelled")).toBe("node.cancelled");
		expect(taskGraphNodeStatusForRunTerminal("completed")).toBe("succeeded");
		expect(taskGraphNodeStatusForRunTerminal("failed")).toBe("failed");
		expect(taskGraphNodeStatusForRunTerminal("cancelled")).toBe("cancelled");
	});

	it("validates node records, definitions, and transitions without accepting forbidden fields", () => {
		const pending = {
			schemaVersion: 1,
			nodeId: "a",
			dependsOn: [],
			status: "pending",
			nodeRevision: 0,
		};
		expect(isTaskGraphNodeRecord(pending)).toBe(true);
		expect(isTaskGraphNodeRecord({ ...pending, status: "running" })).toBe(false);
		expect(isTaskGraphNodeRecord({ ...pending, nodeRevision: 1 })).toBe(false);
		expect(isTaskGraphNodeRecord({ ...pending, runRef: { sessionId: "s", runId: "r" } })).toBe(false);
		expect(
			isTaskGraphNodeRecord({ ...pending, nodeId: "a", status: "running", nodeRevision: 1, runRef: { sessionId: "s", runId: "r" } }),
		).toBe(true);
		expect(
			isTaskGraphNodeRecord({
				...pending,
				status: "succeeded",
				nodeRevision: 2,
				runRef: { sessionId: "s", runId: "r" },
				prompt: "approve",
			}),
		).toBe(false);
		expect(isTaskGraphNodeRecord({ ...pending, dependsOn: ["a"], status: "pending" })).toBe(true);
		expect(isTaskGraphNodeRecord({ ...pending, gateRef: { stageId: "s", stageRevision: 0 } })).toBe(false);
		expect(isTaskGraphNodeRecord({ ...pending, outcomeCode: "x".repeat(100) })).toBe(false);

		const definition = {
			schemaVersion: 1,
			sessionId: "s",
			taskId: "t",
			graphRevision: 1,
			createdAt: NOW,
			nodes: [{ ...pending, nodeId: "a" }, { ...pending, nodeId: "b", dependsOn: ["a"] }],
		};
		expect(isTaskGraphDefinitionRecord(definition)).toBe(true);
		expect(isTaskGraphDefinitionRecord({ ...definition, nodes: [] })).toBe(false);
		expect(
			isTaskGraphDefinitionRecord({
				...definition,
				nodes: [
					{ ...pending, nodeId: "a", dependsOn: ["b"] },
					{ ...pending, nodeId: "b", dependsOn: ["a"] },
				],
			}),
		).toBe(false);
		expect(isTaskGraphDefinitionRecord({ ...definition, nodes: [{ ...pending, nodeId: "a", status: "succeeded", nodeRevision: 2 }] })).toBe(false);

		const created = {
			schemaVersion: 1,
			action: "created",
			taskId: "t",
			graphRevision: 1,
			graph: definition,
			clientRequestId: "req-1",
		};
		expect(isTaskGraphTransition(created)).toBe(true);
		expect(isTaskGraphTransition({ ...created, graph: undefined })).toBe(false);
		expect(isTaskGraphTransition({ ...created, action: "node.attached" })).toBe(false);
		expect(isTaskGraphTransition({ ...created, clientRequestId: "" })).toBe(false);
		expect(isTaskGraphTransition({ ...created, schemaVersion: 2 })).toBe(false);

		const attached = {
			schemaVersion: 1,
			action: "node.attached",
			taskId: "t",
			graphRevision: 1,
			node: { ...pending, status: "running", nodeRevision: 1, runRef: { sessionId: "s", runId: "r" } },
			previousNodeRevision: 0,
			clientRequestId: "req-2",
		};
		expect(isTaskGraphTransition(attached)).toBe(true);
		expect(isTaskGraphTransition({ ...attached, previousNodeRevision: 1 })).toBe(false);
		expect(isTaskGraphTransition({ ...attached, node: { ...attached.node, status: "pending" } })).toBe(false);
	});

	it("keeps graph state independent from run and gate ledgers", () => {
		const session = makeSession();
		const gateStore = new TaskGateStore(session, { now: () => NOW, createGateId: () => "gate_001" });
		gateStore.request({ taskId: "task_42", stageId: "stage_review", stageRevision: 1, clientRequestId: "gate-req" });
		const gateEntriesBefore = session
			.getEntries()
			.filter((entry) => entry.type === "custom" && entry.customType === TASK_GATE_CUSTOM_TYPE)
			.map((entry) => JSON.stringify((entry as { data?: unknown }).data));

		const runLookup = new FakeRunLookup();
		const store = makeStore(session, runLookup, new FakeGateLookup());
		store.create(createRequest());
		runLookup.add("run_a", "accepted");
		store.attach(attachRequest());
		runLookup.add("run_a", "completed", { receiptStatus: "completed" });
		store.settle(settleRequest());

		const gateEntriesAfter = session
			.getEntries()
			.filter((entry) => entry.type === "custom" && entry.customType === TASK_GATE_CUSTOM_TYPE)
			.map((entry) => JSON.stringify((entry as { data?: unknown }).data));
		expect(gateEntriesAfter).toEqual(gateEntriesBefore);
		const customTypes = session
			.getEntries()
			.filter((entry) => entry.type === "custom")
			.map((entry) => entry.customType);
		expect(customTypes).toEqual([TASK_GATE_CUSTOM_TYPE, TASK_GRAPH_CUSTOM_TYPE, TASK_GRAPH_CUSTOM_TYPE, TASK_GRAPH_CUSTOM_TYPE]);
		// The Graph store only ever read the Run lookup; it never started,
		// cancelled, or rewrote a Run, and it never mutated a Gate.
		expect(runLookup.calls).toEqual(["run_a", "run_a", "run_a", "run_a"]);
		expect(gateStore.get("gate_001")?.status).toBe("pending");
	});

	it("scopes idempotency per command type", () => {
		const session = makeSession();
		const runLookup = new FakeRunLookup();
		const store = makeStore(session, runLookup, new FakeGateLookup());
		store.create(createRequest({ clientRequestId: "shared-key" }));
		runLookup.add("run_a", "accepted");
		const attached = store.attach(attachRequest({ clientRequestId: "shared-key" }));

		expect(attached.appended).toBe(true);
		expect(attached.node?.status).toBe("running");
		expect(session.getEntries()).toHaveLength(2);
	});

	it("produces deterministic canonical create payloads regardless of node order", () => {
		const nodes = [
			{ nodeId: "review", dependsOn: ["implement"], gateRef: { stageId: "s", stageRevision: 1 } },
			{ nodeId: "implement", dependsOn: ["inspect"] },
			{ nodeId: "inspect", dependsOn: [] },
		];
		const first = canonicalTaskGraphCreatePayload(createRequest({ nodes }));
		const second = canonicalTaskGraphCreatePayload(createRequest({ nodes: [...nodes].reverse() }));

		expect(first).toBe(second);
		expect(first).toContain('"nodeId":"implement"');
		expect(first).not.toContain('"status"');
	});
});

describe("task graph credential node-terminal hook", () => {
	it("fires onNodeTerminal once per terminal settle with node, task, and run facts", () => {
		const session = makeSession();
		const runLookup = new FakeRunLookup();
		runLookup.sessionId = session.getSessionId();
		const gateLookup = new FakeGateLookup();
		const terminal: Array<{ nodeId: string; status: TaskGraphNodeStatus; taskId: string; runId: string }> = [];
		const store = new TaskGraphStore(session, runLookup, gateLookup, {
			now: () => NOW,
			onNodeTerminal: (node, taskId, runId) =>
				terminal.push({ nodeId: node.nodeId, status: node.status, taskId, runId }),
		});
		store.create(createRequest());
		runLookup.add("run_a", "accepted");
		store.attach(attachRequest({ nodeId: "inspect", runId: "run_a", clientRequestId: "attach-hook-1" }));
		expect(terminal).toEqual([]);
		runLookup.add("run_a", "failed", { receiptStatus: "failed" });
		store.settle(settleRequest({ nodeId: "inspect", clientRequestId: "settle-hook-1" }));
		expect(terminal).toHaveLength(1);
		expect(terminal[0]).toEqual({ nodeId: "inspect", status: "failed", taskId: "task_42", runId: "run_a" });
	});

	it("maps succeeded and cancelled receipts and never re-fires on replays", () => {
		const session = makeSession();
		const runLookup = new FakeRunLookup();
		runLookup.sessionId = session.getSessionId();
		const gateLookup = new FakeGateLookup();
		const terminal: Array<{ nodeId: string; status: TaskGraphNodeStatus }> = [];
		const store = new TaskGraphStore(session, runLookup, gateLookup, {
			now: () => NOW,
			onNodeTerminal: (node, taskId, runId) => terminal.push({ nodeId: node.nodeId, status: node.status }),
		});
		store.create(createRequest());

		// implement depends on inspect: settle inspect first so implement is ready.
		runLookup.add("run_c", "accepted");
		store.attach(attachRequest({ nodeId: "inspect", runId: "run_c", clientRequestId: "attach-hook-2a" }));
		runLookup.add("run_c", "completed", { receiptStatus: "completed" });
		store.settle(settleRequest({ nodeId: "inspect", clientRequestId: "settle-hook-2a" }));
		expect(terminal).toHaveLength(1);
		expect(terminal[0]).toEqual({ nodeId: "inspect", status: "succeeded" });

		runLookup.add("run_b", "accepted");
		store.attach(attachRequest({ nodeId: "implement", runId: "run_b", clientRequestId: "attach-hook-2" }));
		runLookup.add("run_b", "completed", { receiptStatus: "completed" });
		store.settle(settleRequest({ nodeId: "implement", clientRequestId: "settle-hook-2" }));
		expect(terminal).toHaveLength(2);
		expect(terminal[1]).toEqual({ nodeId: "implement", status: "succeeded" });

		// The same settle replayed is idempotent and does not fire again.
		const replay = store.settle(settleRequest({ nodeId: "implement", clientRequestId: "settle-hook-2" }));
		expect(replay.idempotent).toBe(true);
		expect(terminal).toHaveLength(2);

		// The persisted terminal node record is untouched: exactly one node entry.
		const nodeEntries = session
			.getEntries()
			.filter(
				(entry) =>
					entry.type === "custom" && (entry.data as { node?: { nodeId?: string } }).node?.nodeId === "implement",
			);
		expect(nodeEntries).toHaveLength(2); // attach + settle
	});
});
