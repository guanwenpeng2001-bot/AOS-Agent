import { describe, expect, it } from "vitest";
import { FoundationError } from "../../src/harness/foundation/errors.ts";
import { type TaskResultRefV1, validateGoalV1 } from "../../src/harness/foundation/goal.ts";
import { GoalStore } from "../../src/harness/foundation/goal-store.ts";
import type { FoundationRecordV1, ProvisionedFoundationRecordV1 } from "../../src/harness/session/durable/types.ts";
import { InMemorySessionStorage, Session } from "../../src/harness/session/index.ts";

function createStore(id: string): { readonly session: Session; readonly store: GoalStore } {
	const session = new Session(new InMemorySessionStorage({ id, createdAt: 1 }));
	return { session, store: new GoalStore(session) };
}

function options(
	clientRequestId: string,
	expectedRevision: number,
): { readonly clientRequestId: string; readonly expectedRevision: number } {
	return { clientRequestId, expectedRevision };
}

async function createGoal(store: GoalStore, requestId: string, withCriterion = false) {
	const sessionId = (await store.session.getMetadata()).id;
	return store.create(
		{
			sessionId,
			title: "Durable goal",
			...(withCriterion
				? {
						acceptanceCriteria: [
							{ criterionId: "criterion-1", description: "A criterion", satisfiedBy: "evidence" as const },
						],
					}
				: {}),
		},
		options(requestId, 0),
	);
}

function injectAppendFault(
	session: Session,
	predicate: (record: ProvisionedFoundationRecordV1) => boolean,
	phase: "before" | "after",
): () => void {
	const original = session.appendFoundationRecord.bind(session);
	let injected = false;
	session.appendFoundationRecord = async (record) => {
		if (!injected && phase === "before" && predicate(record)) {
			injected = true;
			throw new FoundationError("session_ledger_storage", "injected GoalStore crash");
		}
		const accepted = await original(record);
		if (!injected && phase === "after" && predicate(record)) {
			injected = true;
			throw new FoundationError("session_ledger_storage", "injected GoalStore crash");
		}
		return accepted;
	};
	return () => {
		session.appendFoundationRecord = original;
	};
}

function isFoundationError(error: unknown, code: string): boolean {
	return error instanceof FoundationError && error.code === code;
}

describe("GoalStore durability", () => {
	it("recovers a crash after the command intent and preserves one result", async () => {
		const { session, store } = createStore("goal-intent-recovery");
		const restore = injectAppendFault(
			session,
			(record) => record.kind === "fact" && record.objectType === "foundation.goal",
			"before",
		);
		await expect(createGoal(store, "create-after-intent")).rejects.toMatchObject({ code: "session_ledger_storage" });
		restore();

		const intents = await session.findFoundationRecords({
			kind: "intent",
			objectType: "foundation.goal.command",
			includePruned: true,
		});
		expect(intents).toHaveLength(1);
		const goal = await createGoal(store, "create-after-intent");
		expect(goal.revision).toBe(1);
		expect((await store.eventsFor(goal.goalId)).map((event) => event.type)).toEqual(["goal.created"]);
	});

	it("repairs an event and command result after a crash following the Goal CAS", async () => {
		const { session, store } = createStore("goal-event-recovery");
		const restore = injectAppendFault(
			session,
			(record) => record.kind === "fact" && record.objectType === "foundation.goal.event",
			"after",
		);
		await expect(createGoal(store, "create-after-goal")).rejects.toMatchObject({ code: "session_ledger_storage" });
		restore();

		const goal = await createGoal(store, "create-after-goal");
		expect(goal.revision).toBe(1);
		expect(await store.eventsFor(goal.goalId)).toHaveLength(1);
		const commandRecords = (
			await session.findFoundationRecords({
				objectType: "foundation.goal.command",
				order: "oldestFirst",
				includePruned: true,
			})
		).filter(
			(record): record is Extract<FoundationRecordV1, { kind: "intent" | "fact" }> =>
				record.kind === "intent" || record.kind === "fact",
		);
		expect(commandRecords).toHaveLength(2);
		expect(commandRecords.map((record) => record.kind)).toEqual(["intent", "fact"]);
		expect(commandRecords.map((record) => record.revision)).toEqual([1, 2]);
	});

	it("rejects request payload reuse while preserving idempotent replay", async () => {
		const { store } = createStore("goal-payload-mismatch");
		const goal = await createGoal(store, "create");
		const first = await store.edit(goal.goalId, { title: "First title" }, options("edit-request", 1));
		expect(await store.edit(goal.goalId, { title: "First title" }, options("edit-request", 1))).toEqual(first);
		await expect(store.edit(goal.goalId, { title: "Different title" }, options("edit-request", 1))).rejects.toSatisfy(
			(error: unknown) => isFoundationError(error, "session_writer_duplicate_request"),
		);
	});

	it("persists a Todo no-op command and rejects terminal-state regression", async () => {
		const { store } = createStore("goal-todo-noop");
		const goal = await createGoal(store, "create");
		const plan = await store.addPlan(goal.goalId, { planId: "plan-1", title: "Plan" }, options("plan", 1));
		const stage = await store.addStage(
			goal.goalId,
			plan.planId,
			{ stageId: "stage-1", title: "Stage" },
			options("stage", 2),
		);
		const todo = await store.addTodo(
			goal.goalId,
			plan.planId,
			stage.stageId,
			{ todoId: "todo-1", title: "Todo" },
			options("todo", 3),
		);

		const noOp = await store.setTodoStatus(
			goal.goalId,
			plan.planId,
			stage.stageId,
			todo.todoId,
			"pending",
			options("todo-no-op", 4),
		);
		expect(noOp.status).toBe("pending");
		expect((await store.get(goal.goalId)).revision).toBe(4);
		expect(
			await store.setTodoStatus(
				goal.goalId,
				plan.planId,
				stage.stageId,
				todo.todoId,
				"pending",
				options("todo-no-op", 4),
			),
		).toEqual(noOp);
		await expect(
			store.setTodoStatus(
				goal.goalId,
				plan.planId,
				stage.stageId,
				todo.todoId,
				"in_progress",
				options("todo-no-op", 4),
			),
		).rejects.toMatchObject({ code: "session_writer_duplicate_request" });

		const completed = await store.setTodoStatus(
			goal.goalId,
			plan.planId,
			stage.stageId,
			todo.todoId,
			"completed",
			options("todo-complete", 4),
		);
		expect(completed.status).toBe("completed");
		expect((await store.get(goal.goalId)).revision).toBe(5);
		await expect(
			store.setTodoStatus(
				goal.goalId,
				plan.planId,
				stage.stageId,
				todo.todoId,
				"in_progress",
				options("todo-regression", 5),
			),
		).rejects.toMatchObject({ code: "goal_invalid_transition" });
	});

	it("enforces the aggregate CAS for distinct concurrent requests", async () => {
		const { store } = createStore("goal-distinct-stale");
		const goal = await createGoal(store, "create");
		const outcomes = await Promise.allSettled([
			store.edit(goal.goalId, { title: "left" }, options("edit-left", 1)),
			store.edit(goal.goalId, { title: "right" }, options("edit-right", 1)),
		]);
		const fulfilled = outcomes.filter((outcome) => outcome.status === "fulfilled");
		const rejected = outcomes.filter((outcome) => outcome.status === "rejected");
		expect(fulfilled).toHaveLength(1);
		expect(rejected).toHaveLength(1);
		expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({ code: "session_writer_stale_revision" });
		expect((await store.get(goal.goalId)).revision).toBe(2);
	});

	it("covers Plan and Stage transitions and rejects terminal fallback", async () => {
		const { store } = createStore("goal-plan-stage-transitions");
		const goal = await createGoal(store, "create");
		const plan = await store.addPlan(goal.goalId, { planId: "plan-1", title: "Plan" }, options("plan", 1));
		expect((await store.setPlanStatus(goal.goalId, plan.planId, "active", options("plan-active", 2))).status).toBe(
			"active",
		);
		expect((await store.pausePlan(goal.goalId, plan.planId, options("plan-paused", 3))).status).toBe("paused");
		expect((await store.resumePlan(goal.goalId, plan.planId, options("plan-resumed", 4))).status).toBe("active");
		const stage = await store.addStage(
			goal.goalId,
			plan.planId,
			{ stageId: "stage-1", title: "Stage" },
			options("stage", 5),
		);
		expect((await store.readyStage(goal.goalId, plan.planId, stage.stageId, options("stage-ready", 6))).status).toBe(
			"ready",
		);
		expect((await store.startStage(goal.goalId, plan.planId, stage.stageId, options("stage-active", 7))).status).toBe(
			"active",
		);
		expect(
			(await store.completeStage(goal.goalId, plan.planId, stage.stageId, options("stage-complete", 8))).status,
		).toBe("completed");
		expect((await store.completePlan(goal.goalId, plan.planId, options("plan-complete", 9))).status).toBe(
			"completed",
		);
		await expect(
			store.setPlanStatus(goal.goalId, plan.planId, "paused", options("plan-regression", 10)),
		).rejects.toMatchObject({ code: "goal_invalid_transition" });
	});

	it("validates observedAt, recursive projections, and acceptance references", async () => {
		const { store } = createStore("goal-acceptance-refs");
		const goal = await createGoal(store, "create", true);
		const plan = await store.addPlan(goal.goalId, { planId: "plan-1", title: "Plan" }, options("plan", 1));
		const stage = await store.addStage(
			goal.goalId,
			plan.planId,
			{ stageId: "stage-1", title: "Stage" },
			options("stage", 2),
		);
		const todo = await store.addTodo(
			goal.goalId,
			plan.planId,
			stage.stageId,
			{ todoId: "todo-1", title: "Todo" },
			options("todo", 3),
		);
		const artifact = {
			schemaVersion: 1 as const,
			artifactId: "artifact-1",
			mediaType: "text/plain",
			digest: `sha256:${"a".repeat(64)}`,
		};
		const taskResult: TaskResultRefV1 = { schemaVersion: 1, type: "task_result", id: "task-result-1", revision: 2 };
		const fact = await store.recordAcceptanceFact(
			goal.goalId,
			{
				criterionId: "criterion-1",
				statement: "The criterion is verified",
				verified: true,
				observedAt: "2024-01-02T03:04:05.000Z",
				evidenceRefs: [artifact],
				taskResultRefs: [taskResult],
			},
			options("acceptance", 4),
		);
		expect(fact.observedAt).toBe("2024-01-02T03:04:05.000Z");
		expect(fact.evidenceRefs).toEqual([artifact]);
		expect(fact.taskResultRefs).toEqual([taskResult]);
		const valid = await store.get(goal.goalId);
		expect(valid.acceptanceCriteria[0]?.satisfiedBy).toBe("evidence");
		expect(validateGoalV1(valid).ok).toBe(true);

		const firstPlan = valid.plans?.[0];
		const firstStage = firstPlan?.stages?.[0];
		const malformed = {
			...valid,
			plans: valid.plans?.map((candidatePlan) =>
				candidatePlan.planId === firstPlan?.planId
					? {
							...candidatePlan,
							stages: candidatePlan.stages?.map((candidateStage) =>
								candidateStage.stageId === firstStage?.stageId
									? {
											...candidateStage,
											todos: candidateStage.todos?.map((candidateTodo) =>
												candidateTodo.todoId === todo.todoId
													? { ...candidateTodo, status: "not-a-status" }
													: candidateTodo,
											),
										}
									: candidateStage,
							),
						}
					: candidatePlan,
			),
		};
		expect(validateGoalV1(malformed).ok).toBe(false);
		await expect(
			store.recordAcceptanceFact(
				goal.goalId,
				{
					criterionId: "criterion-1",
					statement: "bad digest",
					evidenceRefs: [{ ...artifact, digest: "sha256:bad" }],
				},
				options("bad-artifact", 5),
			),
		).rejects.toMatchObject({ code: "foundation_schema_invalid_shape" });
		await expect(
			store.recordAcceptanceFact(
				goal.goalId,
				{ criterionId: "criterion-1", statement: "bad result", taskResultRefs: [{ ...taskResult, revision: -1 }] },
				options("bad-task-result", 5),
			),
		).rejects.toMatchObject({ code: "foundation_schema_invalid_shape" });
		await expect(
			store.recordAcceptanceFact(
				goal.goalId,
				{ criterionId: "criterion-1", statement: "bad time", observedAt: "not-a-timestamp" },
				options("bad-time", 5),
			),
		).rejects.toMatchObject({ code: "foundation_schema_invalid_shape" });
	});

	it("fails closed on malformed durable Goal events", async () => {
		const { store } = createStore("goal-event-shape");
		const goal = await createGoal(store, "create");
		await store.writer.writeFact({
			objectType: "foundation.goal.event",
			objectId: `${goal.goalId}:malformed`,
			clientRequestId: "malformed-event",
			expectedRevision: 0,
			payload: {
				schemaVersion: 1,
				eventId: "malformed-event",
				type: "goal.malformed",
				goalId: goal.goalId,
				revision: goal.revision,
				timestamp: goal.updatedAt,
				clientRequestId: "malformed-event",
			},
		});
		await expect(store.eventsFor(goal.goalId)).rejects.toMatchObject({ code: "foundation_schema_invalid_shape" });
	});

	it("recovers and replays acceptance evidence after an event write crash", async () => {
		const { session, store } = createStore("goal-acceptance-recovery");
		const goal = await createGoal(store, "create", true);
		const artifact = {
			schemaVersion: 1 as const,
			artifactId: "artifact-1",
			mediaType: "text/plain",
			digest: `sha256:${"b".repeat(64)}`,
		};
		const taskResult: TaskResultRefV1 = { schemaVersion: 1, type: "task_result", id: "task-result-1", revision: 7 };
		const input = {
			criterionId: "criterion-1",
			statement: "Recovered evidence",
			verified: true,
			evidenceRefs: [artifact],
			taskResultRefs: [taskResult],
		};
		const restore = injectAppendFault(
			session,
			(record) => record.kind === "fact" && record.objectType === "foundation.goal.event",
			"after",
		);
		await expect(
			store.recordAcceptanceFact(goal.goalId, input, options("acceptance-recovery", 1)),
		).rejects.toMatchObject({ code: "session_ledger_storage" });
		restore();
		const recovered = await store.recordAcceptanceFact(goal.goalId, input, options("acceptance-recovery", 1));
		expect(recovered.evidenceRefs).toEqual([artifact]);
		expect(recovered.taskResultRefs).toEqual([taskResult]);
		expect(await store.eventsFor(goal.goalId)).toHaveLength(2);
	});

	it("repairs clear retry event/projection state and compares the full payload", async () => {
		const { session, store } = createStore("goal-clear-retry");
		const goal = await createGoal(store, "create");
		const plan = await store.addPlan(goal.goalId, { planId: "plan-1", title: "Plan" }, options("plan", 1));
		const restore = injectAppendFault(
			session,
			(record) => record.kind === "fact" && record.objectType === "foundation.goal.event",
			"after",
		);
		await expect(store.clear(goal.goalId, { ...options("clear-retry", 2), reason: "done" })).rejects.toMatchObject({
			code: "session_ledger_storage",
		});
		restore();
		const cleared = await store.clear(goal.goalId, { ...options("clear-retry", 2), reason: "done" });
		expect(cleared.status).toBe("cleared");
		expect((await store.eventsFor(goal.goalId)).at(-1)?.type).toBe("goal.cleared");
		await expect(
			store.clear(goal.goalId, { ...options("clear-retry", 2), reason: "different" }),
		).rejects.toMatchObject({ code: "session_writer_duplicate_request" });
		expect((await store.plans(goal.goalId)).map((candidate) => candidate.planId)).toEqual([plan.planId]);
	});

	it("closes ordinary Goal mutations after completion", async () => {
		const { store } = createStore("goal-terminal");
		const goal = await createGoal(store, "create");
		const plan = await store.addPlan(goal.goalId, { planId: "plan-1", title: "Plan" }, options("plan", 1));
		const activePlan = await store.setPlanStatus(goal.goalId, plan.planId, "active", options("plan-active", 2));
		const stage = await store.addStage(
			goal.goalId,
			activePlan.planId,
			{ stageId: "stage-1", title: "Stage" },
			options("stage", 3),
		);
		await store.readyStage(goal.goalId, activePlan.planId, stage.stageId, options("stage-ready", 4));
		const activeStage = await store.startStage(
			goal.goalId,
			activePlan.planId,
			stage.stageId,
			options("stage-active", 5),
		);
		const todo = await store.addTodo(
			goal.goalId,
			activePlan.planId,
			activeStage.stageId,
			{ todoId: "todo-1", title: "Todo" },
			options("todo", 6),
		);
		const completedTodo = await store.setTodoStatus(
			goal.goalId,
			activePlan.planId,
			activeStage.stageId,
			todo.todoId,
			"completed",
			options("todo-complete", 7),
		);
		const completedStage = await store.completeStage(
			goal.goalId,
			activePlan.planId,
			activeStage.stageId,
			options("stage-complete", 8),
		);
		const completedPlan = await store.completePlan(goal.goalId, activePlan.planId, options("plan-complete", 9));
		const completedGoal = await store.complete(goal.goalId, options("goal-complete", 10));
		expect(completedTodo.status).toBe("completed");
		expect(completedStage.status).toBe("completed");
		expect(completedPlan.status).toBe("completed");
		expect(completedGoal.status).toBe("completed");
		expect(completedGoal.revision).toBe(11);
		await expect(store.edit(goal.goalId, { title: "late edit" }, options("late-edit", 11))).rejects.toMatchObject({
			code: "goal_invalid_transition",
		});
		await expect(
			store.addPlan(goal.goalId, { planId: "late-plan", title: "Late plan" }, options("late-plan", 11)),
		).rejects.toMatchObject({ code: "goal_invalid_transition" });
		await expect(
			store.addStage(
				goal.goalId,
				activePlan.planId,
				{ stageId: "late-stage", title: "Late stage" },
				options("late-stage", 11),
			),
		).rejects.toMatchObject({ code: "goal_invalid_transition" });
		await expect(
			store.addTodo(
				goal.goalId,
				activePlan.planId,
				activeStage.stageId,
				{ todoId: "late-todo", title: "Late todo" },
				options("late-todo", 11),
			),
		).rejects.toMatchObject({ code: "goal_invalid_transition" });
		await expect(
			store.setTodoStatus(
				goal.goalId,
				activePlan.planId,
				activeStage.stageId,
				todo.todoId,
				"cancelled",
				options("late-status", 11),
			),
		).rejects.toMatchObject({ code: "goal_invalid_transition" });
		await expect(
			store.recordAcceptanceFact(goal.goalId, { statement: "late fact" }, options("late-fact", 11)),
		).rejects.toMatchObject({ code: "goal_invalid_transition" });
		await expect(store.addArtifact(goal.goalId, "late-artifact", options("late-artifact", 11))).rejects.toMatchObject(
			{ code: "goal_invalid_transition" },
		);
	});

	it("requires terminal Plan status before Goal completion", async () => {
		const { store } = createStore("goal-completion-hierarchy");
		const goal = await createGoal(store, "create");
		const plan = await store.addPlan(goal.goalId, { planId: "plan-1", title: "Plan" }, options("plan", 1));
		await expect(store.complete(goal.goalId, options("complete-draft-plan", 2))).rejects.toMatchObject({
			code: "goal_invalid_transition",
		});
		const activePlan = await store.setPlanStatus(goal.goalId, plan.planId, "active", options("plan-active", 2));
		await store.addStage(goal.goalId, activePlan.planId, { stageId: "stage-1", title: "Stage" }, options("stage", 3));
		await expect(store.complete(goal.goalId, options("complete-pending-stage", 4))).rejects.toMatchObject({
			code: "goal_invalid_transition",
		});
		expect((await store.get(goal.goalId)).revision).toBe(4);
	});

	it("rejects child writes beneath a stopped Plan", async () => {
		const { store } = createStore("goal-stopped-plan");
		const goal = await createGoal(store, "create");
		const plan = await store.addPlan(goal.goalId, { planId: "plan-1", title: "Plan" }, options("plan", 1));
		const activePlan = await store.setPlanStatus(goal.goalId, plan.planId, "active", options("plan-active", 2));
		const stage = await store.addStage(
			goal.goalId,
			activePlan.planId,
			{ stageId: "stage-1", title: "Stage" },
			options("stage", 3),
		);
		const todo = await store.addTodo(
			goal.goalId,
			activePlan.planId,
			stage.stageId,
			{ todoId: "todo-1", title: "Todo" },
			options("todo", 4),
		);
		const stoppedPlan = await store.stopPlan(goal.goalId, activePlan.planId, options("plan-stop", 5));
		expect(stoppedPlan.status).toBe("stopped");
		await expect(
			store.addStage(
				goal.goalId,
				activePlan.planId,
				{ stageId: "late-stage", title: "Late stage" },
				options("late-stage", 6),
			),
		).rejects.toMatchObject({ code: "goal_invalid_transition" });
		await expect(
			store.addTodo(
				goal.goalId,
				activePlan.planId,
				stage.stageId,
				{ todoId: "late-todo", title: "Late todo" },
				options("late-todo", 6),
			),
		).rejects.toMatchObject({ code: "goal_invalid_transition" });
		await expect(
			store.setStageStatus(goal.goalId, activePlan.planId, stage.stageId, "active", options("late-stage-status", 6)),
		).rejects.toMatchObject({ code: "goal_invalid_transition" });
		await expect(
			store.setTodoStatus(
				goal.goalId,
				activePlan.planId,
				stage.stageId,
				todo.todoId,
				"in_progress",
				options("late-todo-status", 6),
			),
		).rejects.toMatchObject({ code: "goal_invalid_transition" });
		const completedGoal = await store.complete(goal.goalId, options("goal-complete", 6));
		expect(completedGoal.status).toBe("completed");
	});

	it("rejects child writes beneath completed Plan and Stage", async () => {
		const { store } = createStore("goal-completed-plan-stage");
		const goal = await createGoal(store, "create");
		const plan = await store.addPlan(goal.goalId, { planId: "plan-1", title: "Plan" }, options("plan", 1));
		const activePlan = await store.setPlanStatus(goal.goalId, plan.planId, "active", options("plan-active", 2));
		const stage = await store.addStage(
			goal.goalId,
			activePlan.planId,
			{ stageId: "stage-1", title: "Stage" },
			options("stage", 3),
		);
		await store.readyStage(goal.goalId, activePlan.planId, stage.stageId, options("stage-ready", 4));
		const activeStage = await store.startStage(
			goal.goalId,
			activePlan.planId,
			stage.stageId,
			options("stage-active", 5),
		);
		const todo = await store.addTodo(
			goal.goalId,
			activePlan.planId,
			activeStage.stageId,
			{ todoId: "todo-1", title: "Todo" },
			options("todo", 6),
		);
		await store.setTodoStatus(
			goal.goalId,
			activePlan.planId,
			activeStage.stageId,
			todo.todoId,
			"completed",
			options("todo-complete", 7),
		);
		const completedStage = await store.completeStage(
			goal.goalId,
			activePlan.planId,
			activeStage.stageId,
			options("stage-complete", 8),
		);
		const completedPlan = await store.completePlan(goal.goalId, activePlan.planId, options("plan-complete", 9));
		expect(completedStage.status).toBe("completed");
		expect(completedPlan.status).toBe("completed");
		await expect(
			store.addStage(
				goal.goalId,
				activePlan.planId,
				{ stageId: "late-stage", title: "Late stage" },
				options("late-stage", 10),
			),
		).rejects.toMatchObject({ code: "goal_invalid_transition" });
		await expect(
			store.addTodo(
				goal.goalId,
				activePlan.planId,
				activeStage.stageId,
				{ todoId: "late-todo", title: "Late todo" },
				options("late-todo", 10),
			),
		).rejects.toMatchObject({ code: "goal_invalid_transition" });
		await expect(
			store.setStageStatus(
				goal.goalId,
				activePlan.planId,
				activeStage.stageId,
				"active",
				options("late-stage-status", 10),
			),
		).rejects.toMatchObject({ code: "goal_invalid_transition" });
		await expect(
			store.setTodoStatus(
				goal.goalId,
				activePlan.planId,
				activeStage.stageId,
				todo.todoId,
				"cancelled",
				options("late-todo-status", 10),
			),
		).rejects.toMatchObject({ code: "goal_invalid_transition" });
	});
});
