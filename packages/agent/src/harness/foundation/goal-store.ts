import { Type } from "typebox";
import type { FoundationRecord } from "../session/durable/types.ts";
import type { Session } from "../session/session.ts";
import type { SessionLedgerWriter, SessionLedgerWriterOptions } from "../session/t5.ts";
import {
	asFoundationStoreError,
	cloneStoreValue,
	createStoreWriter,
	expectedRevision,
	jsonValue,
	mutationId,
	readCommandResult,
	recordsForObject,
	storeId,
	storeText,
	validateTimestamp,
	writeCommandIntent,
	writeCommandResult,
	writeFact,
	writeTombstone,
} from "./durable-store.ts";
import { FoundationError, type FoundationErrorCode } from "./errors.ts";
import {
	type AcceptanceCriterion,
	type AcceptanceFact,
	type Goal,
	type PlanStatus,
	type Plan,
	type StageStatus,
	type Stage,
	type TaskResultRef,
	type TodoStatus,
	type Todo,
	validateGoal,
	validatePlan,
	validateStage,
	validateTaskResultRef,
	validateTodo,
} from "./goal.ts";
import { canonicalFoundationJson, sha256HexValue } from "./identity.ts";
import { type ArtifactRef, validateArtifactRef } from "./reference.ts";
import { validateExactShape } from "./schema.ts";

const GOAL_OBJECT_TYPE = "foundation.goal";
const PLAN_OBJECT_TYPE = "foundation.plan";
const STAGE_OBJECT_TYPE = "foundation.stage";
const TODO_OBJECT_TYPE = "foundation.todo";
const EVENT_OBJECT_TYPE = "foundation.goal.event";
const COMMAND_OBJECT_TYPE = "foundation.goal.command";

export interface GoalCreateInput {
	readonly sessionId: string;
	readonly title: string;
	readonly description?: string;
	readonly acceptanceCriteria?: readonly AcceptanceCriterionInput[];
}

export interface AcceptanceCriterionInput {
	readonly criterionId?: string;
	readonly description: string;
	readonly required?: boolean;
	readonly satisfiedBy?: NonNullable<AcceptanceCriterion["satisfiedBy"]>;
}

export interface GoalMutationOptions {
	readonly clientRequestId: string;
	readonly expectedRevision: number;
}

export interface PlanCreateInput {
	readonly title: string;
	readonly planId?: string;
	readonly description?: string;
}

export interface StageCreateInput {
	readonly title: string;
	readonly stageId?: string;
	readonly order?: number;
}

export interface TodoCreateInput {
	readonly title: string;
	readonly todoId?: string;
	readonly order?: number;
	readonly dependsOn?: readonly string[];
	readonly taskId?: string;
}

export interface AcceptanceFactInput {
	readonly factId?: string;
	readonly criterionId?: string;
	readonly statement: string;
	readonly verified?: boolean;
	readonly source?: { readonly kind: string; readonly ref: string };
	readonly observedAt?: string;
	readonly evidenceRefs?: readonly ArtifactRef[];
	readonly taskResultRefs?: readonly TaskResultRef[];
}

export type GoalEventType = "goal.created" | "goal.edited" | "goal.paused" | "goal.resumed" | "goal.completed" | "goal.cleared" | "goal.artifact.associated" | "plan.created" | "plan.status" | "stage.created" | "stage.status" | "todo.created" | "todo.updated" | "todo.completed" | "todo.status" | "acceptance.fact.recorded";

export interface GoalEvent {
	readonly schemaVersion: 1;
	readonly eventId: string;
	readonly type: GoalEventType;
	readonly goalId: string;
	readonly revision: number;
	readonly timestamp: string;
	readonly clientRequestId: string;
	readonly commandPayload: string;
	readonly planId?: string;
	readonly subjectId?: string;
}

export const GoalEventSchema = Type.Object(
	{
		schemaVersion: Type.Literal(1),
		eventId: Type.String({ minLength: 1 }),
		type: Type.Union([Type.Literal("goal.created"), Type.Literal("goal.edited"), Type.Literal("goal.paused"), Type.Literal("goal.resumed"), Type.Literal("goal.completed"), Type.Literal("goal.cleared"), Type.Literal("goal.artifact.associated"), Type.Literal("plan.created"), Type.Literal("plan.status"), Type.Literal("stage.created"), Type.Literal("stage.status"), Type.Literal("todo.created"), Type.Literal("todo.updated"), Type.Literal("todo.completed"), Type.Literal("todo.status"), Type.Literal("acceptance.fact.recorded")]),
		goalId: Type.String({ minLength: 1 }),
		revision: Type.Integer({ minimum: 0 }),
		timestamp: Type.String({ minLength: 1 }),
		clientRequestId: Type.String({ minLength: 1 }),
		commandPayload: Type.String({ minLength: 1 }),
		planId: Type.Optional(Type.String({ minLength: 1 })),
		subjectId: Type.Optional(Type.String({ minLength: 1 })),
	},
	{ additionalProperties: false },
);

export interface GoalRequestSnapshot {
	readonly clientRequestId: string;
	readonly command: string;
	readonly payload: string;
}

export interface GoalStoreSnapshot {
	readonly schemaVersion: 1;
	readonly goals: readonly Goal[];
	readonly events: readonly GoalEvent[];
	readonly requests?: readonly GoalRequestSnapshot[];
}

export interface GoalStoreOptions extends SessionLedgerWriterOptions {
	readonly writer?: SessionLedgerWriter;
}

interface LoadedObject<TValue> {
	readonly value: TValue;
	readonly record: Extract<FoundationRecord, { kind: "fact" | "tombstone" }>;
}

interface LoadedGoal extends LoadedObject<Goal> {
	readonly tombstoned: boolean;
}

interface GoalCommand {
	readonly request: GoalMutationOptions;
	readonly command: string;
	readonly payload: string;
	readonly objectId: string;
	readonly timestamp: string;
}

function clone<T>(value: T): T {
	return cloneStoreValue(value);
}

function fail(code: FoundationErrorCode, message: string): never {
	throw new FoundationError(code, message);
}

function mutation(options: GoalMutationOptions): GoalMutationOptions {
	mutationId(options.clientRequestId);
	expectedRevision(options.expectedRevision);
	return options;
}

function derivedId(prefix: string, requestId: string, suffix = ""): string {
	return `${prefix}_${sha256HexValue(`${requestId}:${suffix}`).slice(0, 32)}`;
}

function commandPayload(command: string, value: Record<string, unknown>): string {
	try {
		return canonicalFoundationJson({ command, ...value });
	} catch (error) {
		throw asFoundationStoreError(error);
	}
}

function assertGoal(value: unknown): Goal {
	const result = validateGoal(value);
	if (!result.ok) throw result.error;
	return result.value;
}

function assertPlan(value: unknown): Plan {
	const result = validatePlan(value);
	if (!result.ok) throw result.error;
	return result.value;
}

function assertStage(value: unknown): Stage {
	const result = validateStage(value);
	if (!result.ok) throw result.error;
	return result.value;
}

function assertTodo(value: unknown): Todo {
	const result = validateTodo(value);
	if (!result.ok) throw result.error;
	return result.value;
}

function assertGoalEvent(value: unknown): GoalEvent {
	const result = validateExactShape<GoalEvent>(GoalEventSchema, value, "goal_event");
	if (!result.ok) throw result.error;
	validateTimestamp(result.value.timestamp, "goal event timestamp");
	return result.value;
}

function storedPlan(value: Plan): Plan {
	const { stages: _stages, ...withoutProjection } = value;
	return withoutProjection;
}

function storedStage(value: Stage): Stage {
	const { todos: _todos, ...withoutProjection } = value;
	return withoutProjection;
}

function sortGoals(values: readonly Goal[]): Goal[] {
	return [...values]
		.sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.goalId.localeCompare(right.goalId))
		.map(clone);
}

function latestRecords(records: readonly FoundationRecord[]): Map<string, FoundationRecord> {
	const latest = new Map<string, FoundationRecord>();
	for (const record of records) {
		if (record.kind !== "retention") latest.set(record.objectId, record);
	}
	return latest;
}

function replacePlan(goal: Goal, plan: Plan): Goal {
	const plans = [...(goal.plans ?? [])].map((candidate) => (candidate.planId === plan.planId ? plan : candidate));
	return { ...goal, plans, planIds: plans.map((candidate) => candidate.planId) };
}

function replaceStage(goal: Goal, planId: string, stage: Stage): Goal {
	const plan = (goal.plans ?? []).find((candidate) => candidate.planId === planId);
	if (plan === undefined) fail("goal_not_found", "Plan was not found");
	return replacePlan(goal, {
		...plan,
		stages: [...(plan.stages ?? [])].map((candidate) => (candidate.stageId === stage.stageId ? stage : candidate)),
	});
}

function findPlan(goal: Goal, planId: string): Plan {
	const plan = (goal.plans ?? []).find((candidate) => candidate.planId === planId);
	if (plan === undefined) fail("goal_not_found", "Plan was not found");
	return plan;
}

function findStage(plan: Plan, stageId: string): Stage {
	const stage = (plan.stages ?? []).find((candidate) => candidate.stageId === stageId);
	if (stage === undefined) fail("goal_not_found", "Stage was not found");
	return stage;
}

function findTodo(stage: Stage, todoId: string): Todo {
	const todo = (stage.todos ?? []).find((candidate) => candidate.todoId === todoId);
	if (todo === undefined) fail("goal_not_found", "Todo was not found");
	return todo;
}

function planTransitionAllowed(from: PlanStatus, to: PlanStatus): boolean {
	if (from === to) return true;
	if (from === "draft") return to === "active" || to === "stopped";
	if (from === "active") return to === "paused" || to === "completed" || to === "stopped";
	if (from === "paused") return to === "active" || to === "stopped";
	return false;
}

function stageTransitionAllowed(from: StageStatus, to: StageStatus): boolean {
	if (from === to) return true;
	if (from === "pending") return to === "ready" || to === "active" || to === "stopped";
	if (from === "ready") return to === "active" || to === "stopped";
	if (from === "active") return to === "completed" || to === "stopped";
	return false;
}

function todoTransitionAllowed(from: TodoStatus, to: TodoStatus): boolean {
	if (from === to) return true;
	if (from === "pending") return to === "in_progress" || to === "blocked" || to === "completed" || to === "cancelled";
	if (from === "in_progress") return to === "blocked" || to === "completed" || to === "cancelled";
	if (from === "blocked") return to === "in_progress" || to === "completed" || to === "cancelled";
	return false;
}

function planTerminal(status: PlanStatus): boolean {
	return status === "completed" || status === "stopped";
}

function stageTerminal(status: StageStatus): boolean {
	return status === "completed" || status === "stopped";
}

/** Durable Goal aggregate. Plan/Stage/Todo facts are rebuildable projections. */
export class GoalStore {
	readonly session: Session;
	readonly writer: ReturnType<typeof createStoreWriter>;

	constructor(session: Session, options: GoalStoreOptions = {}) {
		this.session = session;
		this.writer = createStoreWriter(session, options);
	}

	async create(input: GoalCreateInput, options: GoalMutationOptions): Promise<Goal> {
		return this.safe("goal_conflict", async () => {
			const request = mutation(options);
			if (request.expectedRevision !== 0) fail("goal_conflict", "Goal creation expectedRevision must be zero");
			const sessionId = storeId(input.sessionId, "sessionId");
			const metadata = await this.session.getMetadata();
			if (sessionId !== metadata.id)
				fail("session_ledger_conflict", "Goal sessionId does not match the supplied Session");
			const title = storeText(input.title, "title");
			const description = input.description === undefined ? undefined : storeText(input.description, "description");
			const criteriaInput = (input.acceptanceCriteria ?? []).map((criterion, index) => ({
				...(criterion.criterionId === undefined
					? {}
					: { criterionId: storeId(criterion.criterionId, "criterionId") }),
				description: storeText(criterion.description, "criterion description"),
				required: criterion.required ?? true,
				...(criterion.satisfiedBy === undefined ? {} : { satisfiedBy: criterion.satisfiedBy }),
				index,
			}));
			if (
				criteriaInput.some(
					(criterion) =>
						criterion.satisfiedBy !== undefined &&
						!["artifact", "test", "evidence", "manual"].includes(criterion.satisfiedBy),
				)
			)
				fail("foundation_schema_invalid_shape", "Invalid acceptance criterion satisfiedBy");
			const criteriaIds = criteriaInput.map(
				(criterion, index) =>
					criterion.criterionId ?? derivedId("criterion", request.clientRequestId, String(index)),
			);
			if (new Set(criteriaIds).size !== criteriaIds.length)
				fail("goal_conflict", "Acceptance criterion already exists");
			const normalizedInput = {
				sessionId,
				title,
				...(description === undefined ? {} : { description }),
				acceptanceCriteria: criteriaInput.map((criterion, index) => ({
					criterionId: criteriaIds[index],
					description: criterion.description,
					required: criterion.required,
					...(criterion.satisfiedBy === undefined ? {} : { satisfiedBy: criterion.satisfiedBy }),
				})),
			};
			const command = await this.begin(
				request,
				"goal.create",
				commandPayload("goal.create", { input: normalizedInput, expectedRevision: request.expectedRevision }),
			);
			const replay = await this.resumeAggregate<Goal>(command, "goal.created");
			if (replay !== undefined) return replay;
			const timestamp = command.timestamp;
			const goal: Goal = {
				schemaVersion: 1,
				sessionId,
				goalId: derivedId("goal", request.clientRequestId),
				title,
				status: "active",
				revision: 1,
				acceptanceCriteria: criteriaInput.map((criterion, index) => ({
					schemaVersion: 1,
					criterionId: criteriaIds[index]!,
					description: criterion.description,
					required: criterion.required,
					...(criterion.satisfiedBy === undefined ? {} : { satisfiedBy: criterion.satisfiedBy }),
					satisfied: false,
					factIds: [],
				})),
				acceptanceFacts: [],
				planIds: [],
				plans: [],
				artifactIds: [],
				...(description === undefined ? {} : { description }),
				createdAt: timestamp,
				updatedAt: timestamp,
			};
			return this.commitAggregate(command, goal, "goal.created");
		});
	}

	async get(goalId: string): Promise<Goal> {
		return this.safe("goal_not_found", async () => (await this.loadGoal(storeId(goalId, "goalId"))).value);
	}

	async list(sessionId?: string): Promise<Goal[]> {
		return this.safe("goal_conflict", async () => {
			const normalized = sessionId === undefined ? undefined : storeId(sessionId, "sessionId");
			const records = await this.session.findFoundationRecords({
				objectType: GOAL_OBJECT_TYPE,
				order: "oldestFirst",
				includePruned: true,
			});
			const values: Goal[] = [];
			for (const record of latestRecords(records).values()) {
				if (record.kind === "retention") continue;
				values.push((await this.loadGoal(record.objectId)).value);
			}
			return sortGoals(values.filter((goal) => normalized === undefined || goal.sessionId === normalized));
		});
	}

	async edit(
		goalId: string,
		patch: { readonly title?: string; readonly description?: string },
		options: GoalMutationOptions,
	): Promise<Goal> {
		return this.safe("goal_conflict", async () => {
			const request = mutation(options);
			const normalizedGoalId = storeId(goalId, "goalId");
			if (patch.title === undefined && patch.description === undefined)
				fail("foundation_schema_invalid_shape", "Goal edit is empty");
			const normalizedPatch = {
				...(patch.title === undefined ? {} : { title: storeText(patch.title, "title") }),
				...(patch.description === undefined ? {} : { description: storeText(patch.description, "description") }),
			};
			const command = await this.begin(
				request,
				"goal.edit",
				commandPayload("goal.edit", {
					goalId: normalizedGoalId,
					patch: normalizedPatch,
					expectedRevision: request.expectedRevision,
				}),
			);
			const replay = await this.resumeAggregate<Goal>(command, "goal.edited");
			if (replay !== undefined) return replay;
			const loaded = await this.loadGoal(normalizedGoalId);
			this.assertMutable(loaded, request.expectedRevision);
			const next: Goal = {
				...loaded.value,
				...normalizedPatch,
				revision: loaded.value.revision + 1,
				updatedAt: command.timestamp,
			};
			return this.commitAggregate(command, next, "goal.edited");
		});
	}

	async pause(goalId: string, options: GoalMutationOptions): Promise<Goal> {
		return this.goalTransition(goalId, "active", "paused", "goal.paused", options);
	}

	async resume(goalId: string, options: GoalMutationOptions): Promise<Goal> {
		return this.goalTransition(goalId, "paused", "active", "goal.resumed", options);
	}

	async complete(goalId: string, options: GoalMutationOptions): Promise<Goal> {
		return this.safe("goal_conflict", async () => {
			const request = mutation(options);
			const normalizedGoalId = storeId(goalId, "goalId");
			const command = await this.begin(
				request,
				"goal.complete",
				commandPayload("goal.complete", { goalId: normalizedGoalId, expectedRevision: request.expectedRevision }),
			);
			const replay = await this.resumeAggregate<Goal>(command, "goal.completed");
			if (replay !== undefined) return replay;
			const loaded = await this.loadGoal(normalizedGoalId);
			this.assertMutable(loaded, request.expectedRevision);
			if (loaded.value.status !== "active" && loaded.value.status !== "paused")
				fail("goal_invalid_transition", "Only active or paused goals can complete");
			const plans = loaded.value.plans ?? [];
			if (
				loaded.value.acceptanceCriteria.some((criterion) => criterion.required && !criterion.satisfied) ||
				plans.some((plan) => !planTerminal(plan.status))
			)
				fail("goal_invalid_transition", "Goal acceptance is incomplete");
			return this.commitAggregate(
				command,
				{ ...loaded.value, status: "completed", revision: loaded.value.revision + 1, updatedAt: command.timestamp },
				"goal.completed",
			);
		});
	}

	async clear(goalId: string, options: GoalMutationOptions & { readonly reason?: string }): Promise<Goal> {
		return this.safe("goal_conflict", async () => {
			const request = mutation(options);
			const normalizedGoalId = storeId(goalId, "goalId");
			const reason = options.reason === undefined ? undefined : storeText(options.reason, "clear reason");
			const command = await this.begin(
				request,
				"goal.clear",
				commandPayload("goal.clear", {
					goalId: normalizedGoalId,
					expectedRevision: request.expectedRevision,
					...(reason === undefined ? {} : { reason }),
				}),
			);
			const replay = await this.resumeAggregate<Goal>(command, "goal.cleared");
			if (replay !== undefined) return replay;
			const loaded = await this.loadGoal(normalizedGoalId);
			if (loaded.tombstoned) fail("session_ledger_tombstoned", "Goal is already cleared");
			this.assertRevision(loaded, request.expectedRevision);
			const tombstone = await writeTombstone(
				this.writer,
				GOAL_OBJECT_TYPE,
				normalizedGoalId,
				this.aggregateRequestId(request),
				loaded.value.revision,
				reason,
			);
			const clearedAt = new Date(tombstone.timestamp).toISOString();
			const value: Goal = {
				...loaded.value,
				status: "cleared",
				revision: tombstone.revision,
				updatedAt: clearedAt,
				tombstone: { schemaVersion: 1, clearedAt, ...(reason === undefined ? {} : { reason }) },
			};
			await this.writeEvent(command, value, "goal.cleared");
			await this.repairProjections(value, request.clientRequestId);
			return this.finishCommand(command, value);
		});
	}

	async addPlan(goalId: string, input: PlanCreateInput, options: GoalMutationOptions): Promise<Plan> {
		return this.safe("goal_conflict", async () => {
			const request = mutation(options);
			const normalizedGoalId = storeId(goalId, "goalId");
			const title = storeText(input.title, "plan title");
			const description =
				input.description === undefined ? undefined : storeText(input.description, "plan description");
			const planId =
				input.planId === undefined ? derivedId("plan", request.clientRequestId) : storeId(input.planId, "planId");
			const command = await this.begin(
				request,
				"plan.create",
				commandPayload("plan.create", {
					goalId: normalizedGoalId,
					input: { planId, title, ...(description === undefined ? {} : { description }) },
					expectedRevision: request.expectedRevision,
				}),
			);
			const replay = await this.resumeAggregate<Goal>(command, "plan.created", planId);
			if (replay !== undefined) return clone(findPlan(replay, planId));
			const loaded = await this.loadGoal(normalizedGoalId);
			this.assertMutable(loaded, request.expectedRevision);
			if ((loaded.value.plans ?? []).some((plan) => plan.planId === planId))
				fail("goal_conflict", "Plan already exists");
			const plan: Plan = {
				schemaVersion: 1,
				planId,
				goalId: normalizedGoalId,
				status: "draft",
				revision: 1,
				stageIds: [],
				stages: [],
				title,
				...(description === undefined ? {} : { description }),
				createdAt: command.timestamp,
				updatedAt: command.timestamp,
			};
			const next: Goal = {
				...loaded.value,
				plans: [...(loaded.value.plans ?? []), plan],
				planIds: [...(loaded.value.planIds ?? []), planId],
				revision: loaded.value.revision + 1,
				updatedAt: command.timestamp,
			};
			const committed = await this.commitAggregate(command, next, "plan.created", planId);
			return clone(findPlan(committed, planId));
		});
	}

	async addStage(
		goalId: string,
		planId: string,
		input: StageCreateInput,
		options: GoalMutationOptions,
	): Promise<Stage> {
		return this.safe("goal_conflict", async () => {
			const request = mutation(options);
			const normalizedGoalId = storeId(goalId, "goalId");
			const normalizedPlanId = storeId(planId, "planId");
			const title = storeText(input.title, "stage title");
			const order = input.order ?? 0;
			if (!Number.isSafeInteger(order) || order < 0) fail("foundation_schema_invalid_shape", "Invalid stage order");
			const stageId =
				input.stageId === undefined
					? derivedId("stage", request.clientRequestId)
					: storeId(input.stageId, "stageId");
			const command = await this.begin(
				request,
				"stage.create",
				commandPayload("stage.create", {
					goalId: normalizedGoalId,
					planId: normalizedPlanId,
					input: { stageId, title, order },
					expectedRevision: request.expectedRevision,
				}),
			);
			const replay = await this.resumeAggregate<Goal>(command, "stage.created", normalizedPlanId, stageId);
			if (replay !== undefined) return clone(findStage(findPlan(replay, normalizedPlanId), stageId));
			const loaded = await this.loadGoal(normalizedGoalId);
			this.assertMutable(loaded, request.expectedRevision);
			const plan = findPlan(loaded.value, normalizedPlanId);
			if (planTerminal(plan.status)) fail("goal_invalid_transition", "Plan is terminal");
			if ((plan.stages ?? []).some((stage) => stage.stageId === stageId))
				fail("goal_conflict", "Stage already exists");
			const stage: Stage = {
				schemaVersion: 1,
				stageId,
				planId: normalizedPlanId,
				status: "pending",
				ordinal: order,
				order,
				todoIds: [],
				todos: [],
				title,
				revision: 1,
			};
			const nextPlan: Plan = {
				...plan,
				stageIds: [...plan.stageIds, stageId],
				stages: [...(plan.stages ?? []), stage],
				revision: plan.revision + 1,
				updatedAt: command.timestamp,
			};
			const next = replacePlan(
				{ ...loaded.value, revision: loaded.value.revision + 1, updatedAt: command.timestamp },
				nextPlan,
			);
			const committed = await this.commitAggregate(command, next, "stage.created", normalizedPlanId, stageId);
			return clone(findStage(findPlan(committed, normalizedPlanId), stageId));
		});
	}

	async addTodo(
		goalId: string,
		planId: string,
		stageId: string,
		input: TodoCreateInput,
		options: GoalMutationOptions,
	): Promise<Todo> {
		return this.safe("goal_conflict", async () => {
			const request = mutation(options);
			const normalizedGoalId = storeId(goalId, "goalId");
			const normalizedPlanId = storeId(planId, "planId");
			const normalizedStageId = storeId(stageId, "stageId");
			const title = storeText(input.title, "todo title");
			const order = input.order ?? 0;
			if (!Number.isSafeInteger(order) || order < 0) fail("foundation_schema_invalid_shape", "Invalid todo order");
			const todoId =
				input.todoId === undefined ? derivedId("todo", request.clientRequestId) : storeId(input.todoId, "todoId");
			const dependsOn = input.dependsOn?.map((value) => storeId(value, "dependency")) ?? [];
			const taskId = input.taskId === undefined ? undefined : storeId(input.taskId, "taskId");
			const command = await this.begin(
				request,
				"todo.create",
				commandPayload("todo.create", {
					goalId: normalizedGoalId,
					planId: normalizedPlanId,
					stageId: normalizedStageId,
					input: {
						todoId,
						title,
						order,
						...(dependsOn.length === 0 ? {} : { dependsOn }),
						...(taskId === undefined ? {} : { taskId }),
					},
					expectedRevision: request.expectedRevision,
				}),
			);
			const replay = await this.resumeAggregate<Goal>(command, "todo.created", normalizedPlanId, todoId);
			if (replay !== undefined)
				return clone(findTodo(findStage(findPlan(replay, normalizedPlanId), normalizedStageId), todoId));
			const loaded = await this.loadGoal(normalizedGoalId);
			this.assertMutable(loaded, request.expectedRevision);
			const plan = findPlan(loaded.value, normalizedPlanId);
			const stage = findStage(plan, normalizedStageId);
			if (planTerminal(plan.status)) fail("goal_invalid_transition", "Plan is terminal");
			if (stageTerminal(stage.status)) fail("goal_invalid_transition", "Stage is terminal");
			if ((stage.todos ?? []).some((todo) => todo.todoId === todoId)) fail("goal_conflict", "Todo already exists");
			const todo: Todo = {
				schemaVersion: 1,
				todoId,
				stageId: normalizedStageId,
				status: "pending",
				title,
				ordinal: order,
				order,
				...(dependsOn.length === 0 ? {} : { dependsOn }),
				...(taskId === undefined ? {} : { taskId }),
				revision: 1,
			};
			const nextStage: Stage = {
				...stage,
				todoIds: [...stage.todoIds, todoId],
				todos: [...(stage.todos ?? []), todo],
				revision: (stage.revision ?? 0) + 1,
			};
			const nextPlan = replaceStage(loaded.value, normalizedPlanId, nextStage);
			const updatedPlan = {
				...findPlan(nextPlan, normalizedPlanId),
				revision: plan.revision + 1,
				updatedAt: command.timestamp,
			};
			const next = replacePlan(
				{ ...nextPlan, revision: loaded.value.revision + 1, updatedAt: command.timestamp },
				updatedPlan,
			);
			const committed = await this.commitAggregate(command, next, "todo.created", normalizedPlanId, todoId);
			return clone(findTodo(findStage(findPlan(committed, normalizedPlanId), normalizedStageId), todoId));
		});
	}

	async setTodoStatus(
		goalId: string,
		planId: string,
		stageId: string,
		todoId: string,
		status: TodoStatus,
		options: GoalMutationOptions,
	): Promise<Todo> {
		return this.safe("goal_conflict", async () => {
			const request = mutation(options);
			const normalizedGoalId = storeId(goalId, "goalId");
			const normalizedPlanId = storeId(planId, "planId");
			const normalizedStageId = storeId(stageId, "stageId");
			const normalizedTodoId = storeId(todoId, "todoId");
			if (!["pending", "in_progress", "blocked", "completed", "cancelled"].includes(status))
				fail("foundation_schema_invalid_shape", "Invalid todo status");
			const command = await this.begin(
				request,
				"todo.status",
				commandPayload("todo.status", {
					goalId: normalizedGoalId,
					planId: normalizedPlanId,
					stageId: normalizedStageId,
					todoId: normalizedTodoId,
					status,
					expectedRevision: request.expectedRevision,
				}),
			);
			const replay = await this.resumeAggregate<Goal>(
				command,
				status === "completed" ? "todo.completed" : "todo.updated",
				normalizedPlanId,
				normalizedTodoId,
			);
			if (replay !== undefined)
				return clone(findTodo(findStage(findPlan(replay, normalizedPlanId), normalizedStageId), normalizedTodoId));
			const loaded = await this.loadGoal(normalizedGoalId);
			this.assertMutable(loaded, request.expectedRevision);
			const plan = findPlan(loaded.value, normalizedPlanId);
			const stage = findStage(plan, normalizedStageId);
			if (planTerminal(plan.status)) fail("goal_invalid_transition", "Plan is terminal");
			if (stageTerminal(stage.status)) fail("goal_invalid_transition", "Stage is terminal");
			const todo = findTodo(stage, normalizedTodoId);
			if (!todoTransitionAllowed(todo.status, status))
				fail("goal_invalid_transition", `Todo cannot transition from ${todo.status} to ${status}`);
			if (todo.status === status) {
				await this.repairProjections(loaded.value, request.clientRequestId);
				const replayed = await this.finishCommand(command, loaded.value);
				return clone(
					findTodo(findStage(findPlan(replayed, normalizedPlanId), normalizedStageId), normalizedTodoId),
				);
			}
			const nextTodo: Todo = { ...todo, status, revision: (todo.revision ?? 0) + 1 };
			const nextStage: Stage = {
				...stage,
				todos: [...(stage.todos ?? [])].map((candidate) =>
					candidate.todoId === todo.todoId ? nextTodo : candidate,
				),
				revision: (stage.revision ?? 0) + 1,
			};
			const nextPlan = replaceStage(loaded.value, normalizedPlanId, nextStage);
			const updatedPlan = {
				...findPlan(nextPlan, normalizedPlanId),
				revision: plan.revision + 1,
				updatedAt: command.timestamp,
			};
			const next = replacePlan(
				{ ...nextPlan, revision: loaded.value.revision + 1, updatedAt: command.timestamp },
				updatedPlan,
			);
			const committed = await this.commitAggregate(
				command,
				next,
				status === "completed" ? "todo.completed" : "todo.updated",
				normalizedPlanId,
				normalizedTodoId,
			);
			return clone(findTodo(findStage(findPlan(committed, normalizedPlanId), normalizedStageId), normalizedTodoId));
		});
	}

	async recordAcceptanceFact(
		goalId: string,
		input: AcceptanceFactInput,
		options: GoalMutationOptions,
	): Promise<AcceptanceFact> {
		return this.safe("goal_conflict", async () => {
			const request = mutation(options);
			const normalizedGoalId = storeId(goalId, "goalId");
			const criterionId = input.criterionId === undefined ? undefined : storeId(input.criterionId, "criterionId");
			const statement = storeText(input.statement, "fact statement");
			const source =
				input.source === undefined
					? undefined
					: {
							kind: storeText(input.source.kind, "fact source kind"),
							ref: storeId(input.source.ref, "fact source ref"),
						};
			const observedAt =
				input.observedAt === undefined ? undefined : validateTimestamp(input.observedAt, "observedAt");
			const factId =
				input.factId === undefined
					? derivedId("acceptance_fact", request.clientRequestId)
					: storeId(input.factId, "factId");
			const evidenceRefs = input.evidenceRefs?.map((candidate) => {
				const result = validateArtifactRef(candidate);
				if (!result.ok) throw result.error;
				return clone(result.value);
			});
			const taskResultRefs = input.taskResultRefs?.map((candidate) => {
				const result = validateTaskResultRef(candidate);
				if (!result.ok) throw result.error;
				return clone(result.value);
			});
			const command = await this.begin(
				request,
				"acceptance.record",
				commandPayload("acceptance.record", {
					goalId: normalizedGoalId,
					input: {
						factId,
						...(criterionId === undefined ? {} : { criterionId }),
						statement,
						verified: input.verified ?? false,
						...(source === undefined ? {} : { source }),
						...(observedAt === undefined ? {} : { observedAt }),
						...(evidenceRefs === undefined ? {} : { evidenceRefs }),
						...(taskResultRefs === undefined ? {} : { taskResultRefs }),
					},
					expectedRevision: request.expectedRevision,
				}),
			);
			const replay = await this.resumeAggregate<Goal>(command, "acceptance.fact.recorded", undefined, factId);
			if (replay !== undefined) {
				const fact = (replay.acceptanceFacts ?? []).find((candidate) => candidate.factId === factId);
				if (fact === undefined) fail("foundation_schema_invalid_shape", "Acceptance fact result is missing");
				return clone(fact);
			}
			const loaded = await this.loadGoal(normalizedGoalId);
			this.assertMutable(loaded, request.expectedRevision);
			if (
				criterionId !== undefined &&
				!loaded.value.acceptanceCriteria.some((criterion) => criterion.criterionId === criterionId)
			)
				fail("goal_not_found", "Acceptance criterion was not found");
			if ((loaded.value.acceptanceFacts ?? []).some((candidate) => candidate.factId === factId))
				fail("goal_conflict", "Acceptance fact already exists");
			const verified = input.verified ?? false;
			const fact: AcceptanceFact = {
				schemaVersion: 1,
				factId,
				...(criterionId === undefined ? {} : { criterionId }),
				outcome: verified ? "satisfied" : "unsatisfied",
				statement,
				verified,
				...(source === undefined ? {} : { source }),
				...(evidenceRefs === undefined ? {} : { evidenceRefs }),
				...(taskResultRefs === undefined ? {} : { taskResultRefs }),
				recordedAt: command.timestamp,
				observedAt: observedAt ?? command.timestamp,
			};
			const acceptanceCriteria = loaded.value.acceptanceCriteria.map((criterion) =>
				criterion.criterionId === criterionId && verified
					? { ...criterion, satisfied: true, factIds: [...(criterion.factIds ?? []), fact.factId] }
					: criterion,
			);
			const next: Goal = {
				...loaded.value,
				acceptanceCriteria,
				acceptanceFacts: [...(loaded.value.acceptanceFacts ?? []), fact],
				revision: loaded.value.revision + 1,
				updatedAt: command.timestamp,
			};
			const committed = await this.commitAggregate(
				command,
				next,
				"acceptance.fact.recorded",
				undefined,
				fact.factId,
			);
			const result = (committed.acceptanceFacts ?? []).find((candidate) => candidate.factId === factId);
			if (result === undefined) fail("foundation_schema_invalid_shape", "Acceptance fact result is missing");
			return clone(result);
		});
	}

	async addArtifact(goalId: string, artifactId: string, options: GoalMutationOptions): Promise<Goal> {
		return this.safe("goal_conflict", async () => {
			const request = mutation(options);
			const normalizedGoalId = storeId(goalId, "goalId");
			const normalizedArtifactId = storeId(artifactId, "artifactId");
			const command = await this.begin(
				request,
				"goal.artifact",
				commandPayload("goal.artifact", {
					goalId: normalizedGoalId,
					artifactId: normalizedArtifactId,
					expectedRevision: request.expectedRevision,
				}),
			);
			const replay = await this.resumeAggregate<Goal>(
				command,
				"goal.artifact.associated",
				undefined,
				normalizedArtifactId,
			);
			if (replay !== undefined) return replay;
			const loaded = await this.loadGoal(normalizedGoalId);
			this.assertMutable(loaded, request.expectedRevision);
			if ((loaded.value.artifactIds ?? []).includes(normalizedArtifactId))
				fail("goal_conflict", "Artifact is already associated");
			return this.commitAggregate(
				command,
				{
					...loaded.value,
					artifactIds: [...(loaded.value.artifactIds ?? []), normalizedArtifactId],
					revision: loaded.value.revision + 1,
					updatedAt: command.timestamp,
				},
				"goal.artifact.associated",
				undefined,
				normalizedArtifactId,
			);
		});
	}

	async plans(goalId: string): Promise<Plan[]> {
		const plans = (await this.get(goalId)).plans ?? [];
		return plans.map((plan) => clone(plan));
	}

	async setPlanStatus(
		goalId: string,
		planId: string,
		status: PlanStatus,
		options: GoalMutationOptions,
	): Promise<Plan> {
		return this.safe("goal_conflict", async () => {
			const request = mutation(options);
			const normalizedGoalId = storeId(goalId, "goalId");
			const normalizedPlanId = storeId(planId, "planId");
			if (!["draft", "active", "paused", "completed", "stopped"].includes(status))
				fail("foundation_schema_invalid_shape", "Invalid plan status");
			const command = await this.begin(
				request,
				"plan.status",
				commandPayload("plan.status", {
					goalId: normalizedGoalId,
					planId: normalizedPlanId,
					status,
					expectedRevision: request.expectedRevision,
				}),
			);
			const replay = await this.resumeAggregate<Goal>(command, "plan.status", normalizedPlanId);
			if (replay !== undefined) return clone(findPlan(replay, normalizedPlanId));
			const loaded = await this.loadGoal(normalizedGoalId);
			this.assertMutable(loaded, request.expectedRevision);
			const plan = findPlan(loaded.value, normalizedPlanId);
			if (!planTransitionAllowed(plan.status, status))
				fail("goal_invalid_transition", `Plan cannot transition from ${plan.status} to ${status}`);
			if (plan.status === status) {
				await this.repairProjections(loaded.value, request.clientRequestId);
				const replayed = await this.finishCommand(command, loaded.value);
				return clone(findPlan(replayed, normalizedPlanId));
			}
			if (
				status === "completed" &&
				(plan.stages ?? []).some((stage) => stage.status !== "completed" && stage.status !== "stopped")
			)
				fail("goal_invalid_transition", "Plan stages are incomplete");
			const nextPlan: Plan = { ...plan, status, revision: plan.revision + 1, updatedAt: command.timestamp };
			const committed = await this.commitAggregate(
				command,
				replacePlan(
					{ ...loaded.value, revision: loaded.value.revision + 1, updatedAt: command.timestamp },
					nextPlan,
				),
				"plan.status",
				normalizedPlanId,
			);
			return clone(findPlan(committed, normalizedPlanId));
		});
	}

	async setStageStatus(
		goalId: string,
		planId: string,
		stageId: string,
		status: StageStatus,
		options: GoalMutationOptions,
	): Promise<Stage> {
		return this.safe("goal_conflict", async () => {
			const request = mutation(options);
			const normalizedGoalId = storeId(goalId, "goalId");
			const normalizedPlanId = storeId(planId, "planId");
			const normalizedStageId = storeId(stageId, "stageId");
			if (!["pending", "ready", "active", "completed", "stopped"].includes(status))
				fail("foundation_schema_invalid_shape", "Invalid stage status");
			const command = await this.begin(
				request,
				"stage.status",
				commandPayload("stage.status", {
					goalId: normalizedGoalId,
					planId: normalizedPlanId,
					stageId: normalizedStageId,
					status,
					expectedRevision: request.expectedRevision,
				}),
			);
			const replay = await this.resumeAggregate<Goal>(
				command,
				"stage.status",
				normalizedPlanId,
				normalizedStageId,
			);
			if (replay !== undefined) return clone(findStage(findPlan(replay, normalizedPlanId), normalizedStageId));
			const loaded = await this.loadGoal(normalizedGoalId);
			this.assertMutable(loaded, request.expectedRevision);
			const plan = findPlan(loaded.value, normalizedPlanId);
			if (planTerminal(plan.status)) fail("goal_invalid_transition", "Plan is terminal");
			const stage = findStage(plan, normalizedStageId);
			if (!stageTransitionAllowed(stage.status, status))
				fail("goal_invalid_transition", `Stage cannot transition from ${stage.status} to ${status}`);
			if (stage.status === status) {
				await this.repairProjections(loaded.value, request.clientRequestId);
				const replayed = await this.finishCommand(command, loaded.value);
				return clone(findStage(findPlan(replayed, normalizedPlanId), normalizedStageId));
			}
			if (
				status === "completed" &&
				(stage.todos ?? []).some((todo) => todo.status !== "completed" && todo.status !== "cancelled")
			)
				fail("goal_invalid_transition", "Stage todos are incomplete");
			const nextStage: Stage = { ...stage, status, revision: (stage.revision ?? 0) + 1 };
			const next = replaceStage(
				{ ...loaded.value, revision: loaded.value.revision + 1, updatedAt: command.timestamp },
				normalizedPlanId,
				nextStage,
			);
			const currentPlan = findPlan(next, normalizedPlanId);
			const committed = await this.commitAggregate(
				command,
				replacePlan(next, { ...currentPlan, revision: currentPlan.revision + 1, updatedAt: command.timestamp }),
				"stage.status",
				normalizedPlanId,
				normalizedStageId,
			);
			return clone(findStage(findPlan(committed, normalizedPlanId), normalizedStageId));
		});
	}

	async pausePlan(goalId: string, planId: string, options: GoalMutationOptions): Promise<Plan> {
		return this.setPlanStatus(goalId, planId, "paused", options);
	}
	async resumePlan(goalId: string, planId: string, options: GoalMutationOptions): Promise<Plan> {
		return this.setPlanStatus(goalId, planId, "active", options);
	}
	async stopPlan(goalId: string, planId: string, options: GoalMutationOptions): Promise<Plan> {
		return this.setPlanStatus(goalId, planId, "stopped", options);
	}
	async completePlan(goalId: string, planId: string, options: GoalMutationOptions): Promise<Plan> {
		return this.setPlanStatus(goalId, planId, "completed", options);
	}
	async readyStage(goalId: string, planId: string, stageId: string, options: GoalMutationOptions): Promise<Stage> {
		return this.setStageStatus(goalId, planId, stageId, "ready", options);
	}
	async startStage(goalId: string, planId: string, stageId: string, options: GoalMutationOptions): Promise<Stage> {
		return this.setStageStatus(goalId, planId, stageId, "active", options);
	}
	async stopStage(goalId: string, planId: string, stageId: string, options: GoalMutationOptions): Promise<Stage> {
		return this.setStageStatus(goalId, planId, stageId, "stopped", options);
	}
	async completeStage(
		goalId: string,
		planId: string,
		stageId: string,
		options: GoalMutationOptions,
	): Promise<Stage> {
		return this.setStageStatus(goalId, planId, stageId, "completed", options);
	}

	async eventsFor(goalId: string): Promise<GoalEvent[]> {
		return this.safe("goal_not_found", async () => {
			const normalizedGoalId = storeId(goalId, "goalId");
			await this.loadGoal(normalizedGoalId);
			const records = await this.session.findFoundationRecords({
				objectType: EVENT_OBJECT_TYPE,
				kind: "fact",
				order: "oldestFirst",
				includePruned: true,
			});
			return records
				.filter((record): record is Extract<FoundationRecord, { kind: "fact" }> => record.kind === "fact")
				.map((record) => assertGoalEvent(record.payload))
				.filter((event) => event.goalId === normalizedGoalId)
				.map(clone);
		});
	}

	async snapshot(): Promise<GoalStoreSnapshot> {
		const goals = await this.list();
		const events: GoalEvent[] = [];
		for (const goal of goals) events.push(...(await this.eventsFor(goal.goalId)));
		return { schemaVersion: 1, goals, events };
	}

	async fold(): Promise<GoalStoreSnapshot> {
		return this.snapshot();
	}

	private async goalTransition(
		goalId: string,
		from: Goal["status"],
		to: Goal["status"],
		eventType: GoalEventType,
		options: GoalMutationOptions,
	): Promise<Goal> {
		return this.safe("goal_conflict", async () => {
			const request = mutation(options);
			const normalizedGoalId = storeId(goalId, "goalId");
			const command = await this.begin(
				request,
				eventType.replace(".", "_"),
				commandPayload(eventType, { goalId: normalizedGoalId, expectedRevision: request.expectedRevision }),
			);
			const replay = await this.resumeAggregate<Goal>(command, eventType);
			if (replay !== undefined) return replay;
			const loaded = await this.loadGoal(normalizedGoalId);
			this.assertMutable(loaded, request.expectedRevision);
			if (loaded.value.status !== from) fail("goal_invalid_transition", `Goal is not ${from}`);
			return this.commitAggregate(
				command,
				{ ...loaded.value, status: to, revision: loaded.value.revision + 1, updatedAt: command.timestamp },
				eventType,
			);
		});
	}

	private async begin(request: GoalMutationOptions, command: string, payload: string): Promise<GoalCommand> {
		const objectId = derivedId("goal_command", request.clientRequestId);
		const intent = await writeCommandIntent(
			this.writer,
			COMMAND_OBJECT_TYPE,
			objectId,
			request.clientRequestId,
			command,
			payload,
		);
		return { request, command, payload, objectId, timestamp: new Date(intent.timestamp).toISOString() };
	}

	private aggregateRequestId(request: GoalMutationOptions): string {
		return derivedId("goal_aggregate", request.clientRequestId);
	}

	private async resumeAggregate<TValue>(
		command: GoalCommand,
		eventType: GoalEventType,
		planId?: string,
		subjectId?: string,
	): Promise<TValue | undefined> {
		const stored = await readCommandResult<TValue>(
			this.writer,
			COMMAND_OBJECT_TYPE,
			command.objectId,
			command.request.clientRequestId,
			command.command,
			command.payload,
		);
		if (stored !== undefined) return stored;
		const records = await this.session.findFoundationRecords({
			objectType: GOAL_OBJECT_TYPE,
			order: "oldestFirst",
			includePruned: true,
		});
		const aggregateRequestId = this.aggregateRequestId(command.request);
		const matched = [...records]
			.reverse()
			.find(
				(record): record is Extract<FoundationRecord, { kind: "fact" | "tombstone" }> =>
					(record.kind === "fact" || record.kind === "tombstone") && record.clientRequestId === aggregateRequestId,
			);
		if (matched === undefined) return undefined;
		const value =
			matched.kind === "tombstone" ? (await this.loadGoal(matched.objectId)).value : assertGoal(matched.payload);
		await this.writeEvent(command, value, eventType, planId, subjectId);
		await this.repairProjections(value, command.request.clientRequestId);
		return this.finishCommand(command, value) as Promise<TValue>;
	}

	private async commitAggregate(
		command: GoalCommand,
		goal: Goal,
		eventType: GoalEventType,
		planId?: string,
		subjectId?: string,
	): Promise<Goal> {
		const persisted = await this.commitEntity(
			GOAL_OBJECT_TYPE,
			goal.goalId,
			goal,
			this.aggregateRequestId(command.request),
			command.request.expectedRevision,
		);
		const value = assertGoal(persisted);
		await this.writeEvent(command, value, eventType, planId, subjectId);
		await this.repairProjections(value, command.request.clientRequestId);
		return this.finishCommand(command, value);
	}

	private async finishCommand<TValue>(command: GoalCommand, value: TValue): Promise<TValue> {
		return writeCommandResult(
			this.writer,
			COMMAND_OBJECT_TYPE,
			command.objectId,
			command.request.clientRequestId,
			command.command,
			command.payload,
			value,
		);
	}

	private async writeEvent(
		command: GoalCommand,
		goal: Goal,
		type: GoalEventType,
		planId?: string,
		subjectId?: string,
	): Promise<void> {
		const event: GoalEvent = {
			schemaVersion: 1,
			eventId: derivedId("goal_event", command.request.clientRequestId),
			type,
			goalId: goal.goalId,
			revision: goal.revision,
			timestamp: goal.updatedAt,
			clientRequestId: command.request.clientRequestId,
			commandPayload: command.payload,
			...(planId === undefined ? {} : { planId }),
			...(subjectId === undefined ? {} : { subjectId }),
		};
		await this.commitEntity(
			EVENT_OBJECT_TYPE,
			`${goal.goalId}:${goal.revision}`,
			event,
			derivedId("goal_event_request", command.request.clientRequestId),
			0,
		);
	}

	private async repairProjections(goal: Goal, requestId: string): Promise<void> {
		for (const plan of goal.plans ?? []) {
			await this.repairProjection(
				PLAN_OBJECT_TYPE,
				plan.planId,
				storedPlan(plan),
				requestId,
				`plan:${plan.planId}:${plan.revision}`,
			);
			for (const stage of plan.stages ?? []) {
				await this.repairProjection(
					STAGE_OBJECT_TYPE,
					stage.stageId,
					storedStage(stage),
					requestId,
					`stage:${stage.stageId}:${stage.revision ?? 0}`,
				);
				for (const todo of stage.todos ?? [])
					await this.repairProjection(
						TODO_OBJECT_TYPE,
						todo.todoId,
						todo,
						requestId,
						`todo:${todo.todoId}:${todo.revision ?? 0}`,
					);
			}
		}
	}

	private async repairProjection<TValue>(
		objectType: string,
		objectId: string,
		value: TValue,
		requestId: string,
		suffix: string,
	): Promise<void> {
		const records = await recordsForObject(this.writer, objectType, objectId);
		const latest = records.at(-1);
		if (latest?.kind === "tombstone") fail("session_ledger_tombstoned", `${objectType}/${objectId} is tombstoned`);
		if (latest?.kind === "fact" && canonicalFoundationJson(latest.payload) === canonicalFoundationJson(value)) return;
		await this.commitEntity(
			objectType,
			objectId,
			value,
			derivedId("goal_projection", `${requestId}:${suffix}`),
			latest?.kind === "fact" ? latest.revision : 0,
		);
	}

	private async commitEntity<TValue>(
		objectType: string,
		objectId: string,
		value: TValue,
		requestId: string,
		expectedObjectRevision: number,
	): Promise<TValue> {
		const result = await writeFact(
			this.writer,
			objectType,
			objectId,
			jsonValue(value, objectType),
			requestId,
			expectedObjectRevision,
		);
		return result.value as TValue;
	}

	private async loadGoal(goalId: string): Promise<LoadedGoal> {
		const records = await recordsForObject(this.writer, GOAL_OBJECT_TYPE, goalId);
		const latest = records.at(-1);
		if (latest === undefined) fail("goal_not_found", "Goal was not found");
		if (latest.kind === "fact")
			return { value: await this.projectAggregate(assertGoal(latest.payload)), record: latest, tombstoned: false };
		if (latest.kind !== "tombstone")
			fail("foundation_schema_invalid_shape", "Goal ledger contains an unsupported record");
		const previous = [...records]
			.reverse()
			.find((record): record is Extract<FoundationRecord, { kind: "fact" }> => record.kind === "fact");
		if (previous === undefined) fail("foundation_schema_invalid_shape", "Goal tombstone has no prior state");
		const base = assertGoal(previous.payload);
		const clearedAt = new Date(latest.timestamp).toISOString();
		const value: Goal = {
			...base,
			status: "cleared",
			revision: latest.revision,
			updatedAt: clearedAt,
			tombstone: { schemaVersion: 1, clearedAt, ...(latest.reason === undefined ? {} : { reason: latest.reason }) },
		};
		return { value: await this.projectAggregate(value), record: latest, tombstoned: true };
	}

	private async projectAggregate(goal: Goal): Promise<Goal> {
		if (goal.plans !== undefined) return clone(goal);
		return clone({ ...goal, plans: await this.projectPlans(goal.goalId) });
	}

	private async projectPlans(goalId: string): Promise<Plan[]> {
		const records = await this.session.findFoundationRecords({
			objectType: PLAN_OBJECT_TYPE,
			kind: "fact",
			order: "oldestFirst",
			includePruned: true,
		});
		const plans: Plan[] = [];
		for (const record of latestRecords(records).values()) {
			if (record.kind !== "fact") continue;
			const plan = assertPlan(record.payload);
			if (plan.goalId !== goalId) continue;
			plans.push({ ...plan, stages: await this.projectStages(plan) });
		}
		return plans;
	}

	private async projectStages(plan: Plan): Promise<Stage[]> {
		const records = await this.session.findFoundationRecords({
			objectType: STAGE_OBJECT_TYPE,
			kind: "fact",
			order: "oldestFirst",
			includePruned: true,
		});
		const stages: Stage[] = [];
		for (const record of latestRecords(records).values()) {
			if (record.kind !== "fact") continue;
			const stage = assertStage(record.payload);
			if (stage.planId === plan.planId) stages.push({ ...stage, todos: await this.projectTodos(stage) });
		}
		return stages.sort((left, right) => (left.order ?? left.ordinal) - (right.order ?? right.ordinal));
	}

	private async projectTodos(stage: Stage): Promise<Todo[]> {
		const records = await this.session.findFoundationRecords({
			objectType: TODO_OBJECT_TYPE,
			kind: "fact",
			order: "oldestFirst",
			includePruned: true,
		});
		const todos: Todo[] = [];
		for (const record of latestRecords(records).values()) {
			if (record.kind !== "fact") continue;
			const todo = assertTodo(record.payload);
			if (todo.stageId === stage.stageId) todos.push(todo);
		}
		return todos.sort((left, right) => (left.order ?? left.ordinal) - (right.order ?? right.ordinal));
	}

	private assertRevision(loaded: LoadedGoal, revision: number): void {
		if (loaded.value.revision !== revision) fail("session_writer_stale_revision", "Goal revision is stale");
	}

	private assertMutable(loaded: LoadedGoal, revision: number): void {
		this.assertRevision(loaded, revision);
		if (loaded.tombstoned || loaded.value.status === "cleared") fail("session_ledger_tombstoned", "Goal is cleared");
		if (loaded.value.status !== "active" && loaded.value.status !== "paused")
			fail("goal_invalid_transition", "Goal is terminal");
	}

	private async safe<TValue>(fallbackCode: FoundationErrorCode, operation: () => Promise<TValue>): Promise<TValue> {
		try {
			return await operation();
		} catch (error) {
			throw asFoundationStoreError(error, fallbackCode);
		}
	}
}

export function createGoalStore(session: Session, options?: GoalStoreOptions): GoalStore {
	return new GoalStore(session, options);
}
