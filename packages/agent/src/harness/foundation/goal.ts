import { Type } from "typebox";
import type { Result as ResultValue } from "../result.ts";
import type { FoundationError } from "./errors.ts";
import type { FoundationJsonValue } from "./event-catalog.ts";
import { type ArtifactRef, ArtifactRefSchema } from "./reference.ts";
import { FoundationJsonValueSchema, parseExactShape, serializeExactShape, validateExactShape } from "./schema.ts";

export type GoalStatus = "active" | "paused" | "completed" | "cleared";
export interface AcceptanceCriterion {
	schemaVersion: 1;
	criterionId: string;
	description: string;
	satisfiedBy?: "artifact" | "test" | "evidence" | "manual";
	required: boolean;
	/** Derived convenience state retained for recovery. */
	satisfied?: boolean;
	/** Acceptance fact ids folded into this criterion. */
	factIds?: readonly string[];
}
export interface TaskResultRef {
	schemaVersion: 1;
	type: "task_result";
	id: string;
	revision: number;
}
export interface AcceptanceFact {
	schemaVersion: 1;
	factId: string;
	criterionId?: string;
	outcome: "satisfied" | "unsatisfied" | "pending";
	evidenceRefs?: readonly ArtifactRef[] /** Reference-only acceptance evidence. */;
	taskResultRefs?: readonly TaskResultRef[] /** Legacy statement/source fields are retained as opaque audit text. */;
	statement?: string;
	verified?: boolean;
	source?: { kind: string; ref: string };
	recordedAt: string;
	observedAt?: string;
	recordedBy?: string;
}
export interface GoalTombstone {
	schemaVersion: 1;
	clearedAt: string;
	reason?: string;
}
export interface Goal {
	schemaVersion: 1;
	sessionId: string;
	goalId: string;
	title: string;
	status: GoalStatus;
	revision: number;
	acceptanceCriteria: readonly AcceptanceCriterion[];
	acceptanceFacts?: readonly AcceptanceFact[];
	description?: string;
	planIds?: readonly string[];
	plans?: readonly Plan[];
	artifactIds?: readonly string[];
	createdAt: string;
	updatedAt: string;
	tombstone?: GoalTombstone;
}
export type PlanStatus = "draft" | "active" | "paused" | "completed" | "stopped";
export type StageStatus = "pending" | "ready" | "active" | "completed" | "stopped";
export type TodoStatus = "pending" | "in_progress" | "blocked" | "completed" | "cancelled";
export interface Plan {
	schemaVersion: 1;
	planId: string;
	goalId: string;
	status: PlanStatus;
	revision: number;
	stageIds: readonly string[];
	title?: string;
	description?: string;
	stages?: readonly Stage[];
	createdAt: string;
	updatedAt: string;
}
export interface Stage {
	schemaVersion: 1;
	stageId: string;
	planId: string;
	status: StageStatus;
	ordinal: number;
	todoIds: readonly string[];
	revision?: number;
	title?: string;
	order?: number;
	todos?: readonly Todo[];
}
export interface Todo {
	schemaVersion: 1;
	todoId: string;
	stageId: string;
	status: TodoStatus;
	title: string;
	ordinal: number;
	revision?: number;
	order?: number;
	dependsOn?: readonly string[];
	taskId?: string;
}
export type AskStatus = "pending" | "answered" | "expired" | "escalated" | "cancelled";
export interface AskReply {
	schemaVersion: 1;
	replyId: string;
	askId: string;
	value: FoundationJsonValue;
	by: string;
	createdAt: string;
	clientRequestId: string;
}
export interface Ask {
	schemaVersion: 1;
	sessionId: string;
	askId: string;
	status: AskStatus;
	question: string;
	goalId?: string;
	taskId?: string;
	options?: readonly string[];
	revision: number;
	dueAt?: string;
	escalationAt?: string;
	escalationTarget?: string;
	reply?: AskReply;
	settledAt?: string;
	tombstone?: { schemaVersion: 1; cancelledAt: string; reason?: string };
	createdAt: string;
	updatedAt: string;
}

const criterionSchema = Type.Object(
	{
		schemaVersion: Type.Literal(1),
		criterionId: Type.String({ minLength: 1 }),
		description: Type.String(),
		satisfiedBy: Type.Optional(
			Type.Union([Type.Literal("artifact"), Type.Literal("test"), Type.Literal("evidence"), Type.Literal("manual")]),
		),
		required: Type.Boolean(),
		satisfied: Type.Optional(Type.Boolean()),
		factIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
	},
	{ additionalProperties: false },
);
export const TaskResultRefSchema = Type.Object(
	{
		schemaVersion: Type.Literal(1),
		type: Type.Literal("task_result"),
		id: Type.String({ minLength: 1 }),
		revision: Type.Integer({ minimum: 0 }),
	},
	{ additionalProperties: false },
);
const acceptanceFactSchema = Type.Object(
	{
		schemaVersion: Type.Literal(1),
		factId: Type.String({ minLength: 1 }),
		criterionId: Type.Optional(Type.String({ minLength: 1 })),
		outcome: Type.Union([Type.Literal("satisfied"), Type.Literal("unsatisfied"), Type.Literal("pending")]),
		evidenceRefs: Type.Optional(Type.Array(ArtifactRefSchema)),
		taskResultRefs: Type.Optional(Type.Array(TaskResultRefSchema)),
		statement: Type.Optional(Type.String()),
		verified: Type.Optional(Type.Boolean()),
		source: Type.Optional(
			Type.Object(
				{ kind: Type.String({ minLength: 1 }), ref: Type.String({ minLength: 1 }) },
				{ additionalProperties: false },
			),
		),
		recordedAt: Type.String({ minLength: 1 }),
		observedAt: Type.Optional(Type.String({ minLength: 1 })),
		recordedBy: Type.Optional(Type.String({ minLength: 1 })),
	},
	{ additionalProperties: false },
);
export const AcceptanceCriterionSchema = criterionSchema;
export const AcceptanceFactSchema = acceptanceFactSchema;
export const GoalTombstoneSchema = Type.Object(
	{ schemaVersion: Type.Literal(1), clearedAt: Type.String({ minLength: 1 }), reason: Type.Optional(Type.String()) },
	{ additionalProperties: false },
);
const todoProjectionSchema = Type.Object(
	{
		schemaVersion: Type.Literal(1),
		todoId: Type.String({ minLength: 1 }),
		stageId: Type.String({ minLength: 1 }),
		status: Type.Union([
			Type.Literal("pending"),
			Type.Literal("in_progress"),
			Type.Literal("blocked"),
			Type.Literal("completed"),
			Type.Literal("cancelled"),
		]),
		title: Type.String({ minLength: 1 }),
		ordinal: Type.Integer({ minimum: 0 }),
		revision: Type.Optional(Type.Integer({ minimum: 0 })),
		order: Type.Optional(Type.Integer({ minimum: 0 })),
		dependsOn: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
		taskId: Type.Optional(Type.String({ minLength: 1 })),
	},
	{ additionalProperties: false },
);
const stageProjectionSchema = Type.Object(
	{
		schemaVersion: Type.Literal(1),
		stageId: Type.String({ minLength: 1 }),
		planId: Type.String({ minLength: 1 }),
		status: Type.Union([
			Type.Literal("pending"),
			Type.Literal("ready"),
			Type.Literal("active"),
			Type.Literal("completed"),
			Type.Literal("stopped"),
		]),
		ordinal: Type.Integer({ minimum: 0 }),
		todoIds: Type.Array(Type.String({ minLength: 1 })),
		revision: Type.Optional(Type.Integer({ minimum: 0 })),
		title: Type.Optional(Type.String()),
		order: Type.Optional(Type.Integer({ minimum: 0 })),
		todos: Type.Optional(Type.Array(todoProjectionSchema)),
	},
	{ additionalProperties: false },
);
const planProjectionSchema = Type.Object(
	{
		schemaVersion: Type.Literal(1),
		planId: Type.String({ minLength: 1 }),
		goalId: Type.String({ minLength: 1 }),
		status: Type.Union([
			Type.Literal("draft"),
			Type.Literal("active"),
			Type.Literal("paused"),
			Type.Literal("completed"),
			Type.Literal("stopped"),
		]),
		revision: Type.Integer({ minimum: 0 }),
		stageIds: Type.Array(Type.String({ minLength: 1 })),
		title: Type.Optional(Type.String()),
		description: Type.Optional(Type.String()),
		stages: Type.Optional(Type.Array(stageProjectionSchema)),
		createdAt: Type.String({ minLength: 1 }),
		updatedAt: Type.String({ minLength: 1 }),
	},
	{ additionalProperties: false },
);
export const GoalSchema = Type.Object(
	{
		schemaVersion: Type.Literal(1),
		sessionId: Type.String({ minLength: 1 }),
		goalId: Type.String({ minLength: 1 }),
		title: Type.String({ minLength: 1 }),
		status: Type.Union([
			Type.Literal("active"),
			Type.Literal("paused"),
			Type.Literal("completed"),
			Type.Literal("cleared"),
		]),
		revision: Type.Integer({ minimum: 0 }),
		acceptanceCriteria: Type.Array(criterionSchema),
		acceptanceFacts: Type.Optional(Type.Array(acceptanceFactSchema)),
		description: Type.Optional(Type.String()),
		planIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
		plans: Type.Optional(Type.Array(planProjectionSchema)),
		artifactIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
		createdAt: Type.String({ minLength: 1 }),
		updatedAt: Type.String({ minLength: 1 }),
		tombstone: Type.Optional(GoalTombstoneSchema),
	},
	{ additionalProperties: false },
);
export const PlanSchema = planProjectionSchema;
export const StageSchema = stageProjectionSchema;
export const TodoSchema = todoProjectionSchema;
export const AskReplySchema = Type.Object(
	{
		schemaVersion: Type.Literal(1),
		replyId: Type.String({ minLength: 1 }),
		askId: Type.String({ minLength: 1 }),
		value: FoundationJsonValueSchema,
		by: Type.String({ minLength: 1 }),
		createdAt: Type.String({ minLength: 1 }),
		clientRequestId: Type.String({ minLength: 1 }),
	},
	{ additionalProperties: false },
);
export const AskSchema = Type.Object(
	{
		schemaVersion: Type.Literal(1),
		sessionId: Type.String({ minLength: 1 }),
		askId: Type.String({ minLength: 1 }),
		status: Type.Union([
			Type.Literal("pending"),
			Type.Literal("answered"),
			Type.Literal("expired"),
			Type.Literal("escalated"),
			Type.Literal("cancelled"),
		]),
		question: Type.String({ minLength: 1 }),
		goalId: Type.Optional(Type.String({ minLength: 1 })),
		taskId: Type.Optional(Type.String({ minLength: 1 })),
		options: Type.Optional(Type.Array(Type.String())),
		revision: Type.Integer({ minimum: 0 }),
		dueAt: Type.Optional(Type.String({ minLength: 1 })),
		escalationAt: Type.Optional(Type.String({ minLength: 1 })),
		escalationTarget: Type.Optional(Type.String({ minLength: 1 })),
		reply: Type.Optional(AskReplySchema),
		settledAt: Type.Optional(Type.String({ minLength: 1 })),
		tombstone: Type.Optional(
			Type.Object(
				{
					schemaVersion: Type.Literal(1),
					cancelledAt: Type.String({ minLength: 1 }),
					reason: Type.Optional(Type.String()),
				},
				{ additionalProperties: false },
			),
		),
		createdAt: Type.String({ minLength: 1 }),
		updatedAt: Type.String({ minLength: 1 }),
	},
	{ additionalProperties: false },
);
export function validateTaskResultRef(value: unknown): ResultValue<TaskResultRef, FoundationError> {
	return validateExactShape<TaskResultRef>(TaskResultRefSchema, value, "task_result_ref");
}
export function validateGoal(value: unknown): ResultValue<Goal, FoundationError> {
	return validateExactShape<Goal>(GoalSchema, value, "goal");
}
export function serializeGoal(value: Goal): string {
	return serializeExactShape(GoalSchema, value, "goal");
}
export function parseGoal(text: string): ResultValue<Goal, FoundationError> {
	return parseExactShape(GoalSchema, text, "goal");
}
export function validatePlan(value: unknown): ResultValue<Plan, FoundationError> {
	return validateExactShape<Plan>(PlanSchema, value, "plan");
}
export function serializePlan(value: Plan): string {
	return serializeExactShape(PlanSchema, value, "plan");
}
export function parsePlan(text: string): ResultValue<Plan, FoundationError> {
	return parseExactShape(PlanSchema, text, "plan");
}
export function validateStage(value: unknown): ResultValue<Stage, FoundationError> {
	return validateExactShape<Stage>(StageSchema, value, "stage");
}
export function serializeStage(value: Stage): string {
	return serializeExactShape(StageSchema, value, "stage");
}
export function parseStage(text: string): ResultValue<Stage, FoundationError> {
	return parseExactShape(StageSchema, text, "stage");
}
export function validateTodo(value: unknown): ResultValue<Todo, FoundationError> {
	return validateExactShape<Todo>(TodoSchema, value, "todo");
}
export function serializeTodo(value: Todo): string {
	return serializeExactShape(TodoSchema, value, "todo");
}
export function parseTodo(text: string): ResultValue<Todo, FoundationError> {
	return parseExactShape(TodoSchema, text, "todo");
}
export function validateAsk(value: unknown): ResultValue<Ask, FoundationError> {
	return validateExactShape<Ask>(AskSchema, value, "ask");
}
export function serializeAsk(value: Ask): string {
	return serializeExactShape(AskSchema, value, "ask");
}
export function parseAsk(text: string): ResultValue<Ask, FoundationError> {
	return parseExactShape(AskSchema, text, "ask");
}
