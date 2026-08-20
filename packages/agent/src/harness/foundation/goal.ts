import { Type } from "typebox";
import type { Result as ResultValue } from "../result.ts";
import type { FoundationError } from "./errors.ts";
import type { FoundationJsonValue } from "./event-catalog.ts";
import { type ArtifactRefV1, ArtifactRefV1Schema } from "./reference.ts";
import { FoundationJsonValueSchema, parseExactShape, serializeExactShape, validateExactShape } from "./schema.ts";

export type GoalStatusV1 = "active" | "paused" | "completed" | "cleared";
export interface AcceptanceCriterionV1 {
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
export interface TaskResultRefV1 {
	schemaVersion: 1;
	type: "task_result";
	id: string;
	revision: number;
}
export interface AcceptanceFactV1 {
	schemaVersion: 1;
	factId: string;
	criterionId?: string;
	outcome: "satisfied" | "unsatisfied" | "pending";
	evidenceRefs?: readonly ArtifactRefV1[] /** Reference-only acceptance evidence. */;
	taskResultRefs?: readonly TaskResultRefV1[] /** Legacy statement/source fields are retained as opaque audit text. */;
	statement?: string;
	verified?: boolean;
	source?: { kind: string; ref: string };
	recordedAt: string;
	observedAt?: string;
	recordedBy?: string;
}
export interface GoalTombstoneV1 {
	schemaVersion: 1;
	clearedAt: string;
	reason?: string;
}
export interface GoalV1 {
	schemaVersion: 1;
	sessionId: string;
	goalId: string;
	title: string;
	status: GoalStatusV1;
	revision: number;
	acceptanceCriteria: readonly AcceptanceCriterionV1[];
	acceptanceFacts?: readonly AcceptanceFactV1[];
	description?: string;
	planIds?: readonly string[];
	plans?: readonly PlanV1[];
	artifactIds?: readonly string[];
	createdAt: string;
	updatedAt: string;
	tombstone?: GoalTombstoneV1;
}
export type PlanStatusV1 = "draft" | "active" | "paused" | "completed" | "stopped";
export type StageStatusV1 = "pending" | "ready" | "active" | "completed" | "stopped";
export type TodoStatusV1 = "pending" | "in_progress" | "blocked" | "completed" | "cancelled";
export interface PlanV1 {
	schemaVersion: 1;
	planId: string;
	goalId: string;
	status: PlanStatusV1;
	revision: number;
	stageIds: readonly string[];
	title?: string;
	description?: string;
	stages?: readonly StageV1[];
	createdAt: string;
	updatedAt: string;
}
export interface StageV1 {
	schemaVersion: 1;
	stageId: string;
	planId: string;
	status: StageStatusV1;
	ordinal: number;
	todoIds: readonly string[];
	revision?: number;
	title?: string;
	order?: number;
	todos?: readonly TodoV1[];
}
export interface TodoV1 {
	schemaVersion: 1;
	todoId: string;
	stageId: string;
	status: TodoStatusV1;
	title: string;
	ordinal: number;
	revision?: number;
	order?: number;
	dependsOn?: readonly string[];
	taskId?: string;
}
export type AskStatusV1 = "pending" | "answered" | "expired" | "escalated" | "cancelled";
export interface AskReplyV1 {
	schemaVersion: 1;
	replyId: string;
	askId: string;
	value: FoundationJsonValue;
	by: string;
	createdAt: string;
	clientRequestId: string;
}
export type ReplyV1 = AskReplyV1;
export interface AskV1 {
	schemaVersion: 1;
	sessionId: string;
	askId: string;
	status: AskStatusV1;
	question: string;
	goalId?: string;
	taskId?: string;
	options?: readonly string[];
	revision: number;
	dueAt?: string;
	escalationAt?: string;
	escalationTarget?: string;
	reply?: AskReplyV1;
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
export const TaskResultRefV1Schema = Type.Object(
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
		evidenceRefs: Type.Optional(Type.Array(ArtifactRefV1Schema)),
		taskResultRefs: Type.Optional(Type.Array(TaskResultRefV1Schema)),
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
export const AcceptanceCriterionV1Schema = criterionSchema;
export const AcceptanceFactV1Schema = acceptanceFactSchema;
export const GoalTombstoneV1Schema = Type.Object(
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
export const GoalV1Schema = Type.Object(
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
		tombstone: Type.Optional(GoalTombstoneV1Schema),
	},
	{ additionalProperties: false },
);
export const PlanV1Schema = planProjectionSchema;
export const StageV1Schema = stageProjectionSchema;
export const TodoV1Schema = todoProjectionSchema;
export const AskReplyV1Schema = Type.Object(
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
export const AskV1Schema = Type.Object(
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
		reply: Type.Optional(AskReplyV1Schema),
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
export function validateTaskResultRefV1(value: unknown): ResultValue<TaskResultRefV1, FoundationError> {
	return validateExactShape<TaskResultRefV1>(TaskResultRefV1Schema, value, "task_result_ref");
}
export function validateGoalV1(value: unknown): ResultValue<GoalV1, FoundationError> {
	return validateExactShape<GoalV1>(GoalV1Schema, value, "goal");
}
export function serializeGoalV1(value: GoalV1): string {
	return serializeExactShape(GoalV1Schema, value, "goal");
}
export function parseGoalV1(text: string): ResultValue<GoalV1, FoundationError> {
	return parseExactShape(GoalV1Schema, text, "goal");
}
export function validatePlanV1(value: unknown): ResultValue<PlanV1, FoundationError> {
	return validateExactShape<PlanV1>(PlanV1Schema, value, "plan");
}
export function serializePlanV1(value: PlanV1): string {
	return serializeExactShape(PlanV1Schema, value, "plan");
}
export function parsePlanV1(text: string): ResultValue<PlanV1, FoundationError> {
	return parseExactShape(PlanV1Schema, text, "plan");
}
export function validateStageV1(value: unknown): ResultValue<StageV1, FoundationError> {
	return validateExactShape<StageV1>(StageV1Schema, value, "stage");
}
export function serializeStageV1(value: StageV1): string {
	return serializeExactShape(StageV1Schema, value, "stage");
}
export function parseStageV1(text: string): ResultValue<StageV1, FoundationError> {
	return parseExactShape(StageV1Schema, text, "stage");
}
export function validateTodoV1(value: unknown): ResultValue<TodoV1, FoundationError> {
	return validateExactShape<TodoV1>(TodoV1Schema, value, "todo");
}
export function serializeTodoV1(value: TodoV1): string {
	return serializeExactShape(TodoV1Schema, value, "todo");
}
export function parseTodoV1(text: string): ResultValue<TodoV1, FoundationError> {
	return parseExactShape(TodoV1Schema, text, "todo");
}
export function validateAskV1(value: unknown): ResultValue<AskV1, FoundationError> {
	return validateExactShape<AskV1>(AskV1Schema, value, "ask");
}
export function serializeAskV1(value: AskV1): string {
	return serializeExactShape(AskV1Schema, value, "ask");
}
export function parseAskV1(text: string): ResultValue<AskV1, FoundationError> {
	return parseExactShape(AskV1Schema, text, "ask");
}
