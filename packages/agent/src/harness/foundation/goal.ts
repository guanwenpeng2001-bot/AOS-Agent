import type { ArtifactRefV1 } from "./reference.ts";
import { Type } from "typebox";
import type { Result as ResultValue } from "../result.ts";
import type { FoundationError } from "./errors.ts";
import { ArtifactRefV1Schema } from "./reference.ts";
import { parseExactShape, serializeExactShape, validateExactShape } from "./schema.ts";

export type GoalStatusV1 = "active" | "paused" | "completed" | "cleared";
export interface AcceptanceCriterionV1 { schemaVersion: 1; criterionId: string; description: string; satisfiedBy: "artifact" | "test" | "evidence" | "manual"; required: boolean; }
export interface AcceptanceFactV1 { schemaVersion: 1; factId: string; criterionId: string; outcome: "satisfied" | "unsatisfied" | "pending"; evidenceRefs?: readonly ArtifactRefV1[]; recordedAt: string; recordedBy?: string; }
export interface GoalV1 { schemaVersion: 1; sessionId: string; goalId: string; title: string; status: GoalStatusV1; revision: number; acceptanceCriteria: readonly AcceptanceCriterionV1[]; createdAt: string; updatedAt: string; }
export type PlanStatusV1 = "draft" | "active" | "paused" | "completed" | "stopped";
export type StageStatusV1 = "pending" | "ready" | "active" | "completed" | "stopped";
export type TodoStatusV1 = "pending" | "in_progress" | "completed" | "cancelled";
export interface PlanV1 { schemaVersion: 1; planId: string; goalId: string; status: PlanStatusV1; revision: number; stageIds: readonly string[]; createdAt: string; updatedAt: string; }
export interface StageV1 { schemaVersion: 1; stageId: string; planId: string; status: StageStatusV1; ordinal: number; todoIds: readonly string[]; }
export interface TodoV1 { schemaVersion: 1; todoId: string; stageId: string; status: TodoStatusV1; title: string; ordinal: number; }
export type AskStatusV1 = "pending" | "answered" | "expired" | "escalated" | "cancelled";
export interface AskV1 { schemaVersion: 1; askId: string; status: AskStatusV1; question: string; answer?: string; createdAt: string; updatedAt: string; }

const criterionSchema = Type.Object({ schemaVersion: Type.Literal(1), criterionId: Type.String({ minLength: 1 }), description: Type.String(), satisfiedBy: Type.Union([Type.Literal("artifact"), Type.Literal("test"), Type.Literal("evidence"), Type.Literal("manual")]), required: Type.Boolean() }, { additionalProperties: false });
const acceptanceFactSchema = Type.Object({ schemaVersion: Type.Literal(1), factId: Type.String({ minLength: 1 }), criterionId: Type.String({ minLength: 1 }), outcome: Type.Union([Type.Literal("satisfied"), Type.Literal("unsatisfied"), Type.Literal("pending")]), evidenceRefs: Type.Optional(Type.Array(ArtifactRefV1Schema)), recordedAt: Type.String({ minLength: 1 }), recordedBy: Type.Optional(Type.String({ minLength: 1 })) }, { additionalProperties: false });
export const AcceptanceCriterionV1Schema = criterionSchema;
export const AcceptanceFactV1Schema = acceptanceFactSchema;
export const GoalV1Schema = Type.Object({ schemaVersion: Type.Literal(1), sessionId: Type.String({ minLength: 1 }), goalId: Type.String({ minLength: 1 }), title: Type.String({ minLength: 1 }), status: Type.Union([Type.Literal("active"), Type.Literal("paused"), Type.Literal("completed"), Type.Literal("cleared")]), revision: Type.Integer({ minimum: 0 }), acceptanceCriteria: Type.Array(criterionSchema), createdAt: Type.String({ minLength: 1 }), updatedAt: Type.String({ minLength: 1 }) }, { additionalProperties: false });
export const PlanV1Schema = Type.Object({ schemaVersion: Type.Literal(1), planId: Type.String({ minLength: 1 }), goalId: Type.String({ minLength: 1 }), status: Type.Union([Type.Literal("draft"), Type.Literal("active"), Type.Literal("paused"), Type.Literal("completed"), Type.Literal("stopped")]), revision: Type.Integer({ minimum: 0 }), stageIds: Type.Array(Type.String({ minLength: 1 })), createdAt: Type.String({ minLength: 1 }), updatedAt: Type.String({ minLength: 1 }) }, { additionalProperties: false });
export const StageV1Schema = Type.Object({ schemaVersion: Type.Literal(1), stageId: Type.String({ minLength: 1 }), planId: Type.String({ minLength: 1 }), status: Type.Union([Type.Literal("pending"), Type.Literal("ready"), Type.Literal("active"), Type.Literal("completed"), Type.Literal("stopped")]), ordinal: Type.Integer({ minimum: 0 }), todoIds: Type.Array(Type.String({ minLength: 1 })) }, { additionalProperties: false });
export const TodoV1Schema = Type.Object({ schemaVersion: Type.Literal(1), todoId: Type.String({ minLength: 1 }), stageId: Type.String({ minLength: 1 }), status: Type.Union([Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("completed"), Type.Literal("cancelled")]), title: Type.String({ minLength: 1 }), ordinal: Type.Integer({ minimum: 0 }) }, { additionalProperties: false });
export const AskV1Schema = Type.Object({ schemaVersion: Type.Literal(1), askId: Type.String({ minLength: 1 }), status: Type.Union([Type.Literal("pending"), Type.Literal("answered"), Type.Literal("expired"), Type.Literal("escalated"), Type.Literal("cancelled")]), question: Type.String({ minLength: 1 }), answer: Type.Optional(Type.String()), createdAt: Type.String({ minLength: 1 }), updatedAt: Type.String({ minLength: 1 }) }, { additionalProperties: false });
export function validateGoalV1(value: unknown): ResultValue<GoalV1, FoundationError> { return validateExactShape<GoalV1>(GoalV1Schema, value, "goal"); }
export function serializeGoalV1(value: GoalV1): string { return serializeExactShape(GoalV1Schema, value, "goal"); }
export function parseGoalV1(text: string): ResultValue<GoalV1, FoundationError> { return parseExactShape(GoalV1Schema, text, "goal"); }
export function validatePlanV1(value: unknown): ResultValue<PlanV1, FoundationError> { return validateExactShape<PlanV1>(PlanV1Schema, value, "plan"); }
export function serializePlanV1(value: PlanV1): string { return serializeExactShape(PlanV1Schema, value, "plan"); }
export function parsePlanV1(text: string): ResultValue<PlanV1, FoundationError> { return parseExactShape(PlanV1Schema, text, "plan"); }
export function validateStageV1(value: unknown): ResultValue<StageV1, FoundationError> { return validateExactShape<StageV1>(StageV1Schema, value, "stage"); }
export function serializeStageV1(value: StageV1): string { return serializeExactShape(StageV1Schema, value, "stage"); }
export function parseStageV1(text: string): ResultValue<StageV1, FoundationError> { return parseExactShape(StageV1Schema, text, "stage"); }
export function validateTodoV1(value: unknown): ResultValue<TodoV1, FoundationError> { return validateExactShape<TodoV1>(TodoV1Schema, value, "todo"); }
export function serializeTodoV1(value: TodoV1): string { return serializeExactShape(TodoV1Schema, value, "todo"); }
export function parseTodoV1(text: string): ResultValue<TodoV1, FoundationError> { return parseExactShape(TodoV1Schema, text, "todo"); }
export function validateAskV1(value: unknown): ResultValue<AskV1, FoundationError> { return validateExactShape<AskV1>(AskV1Schema, value, "ask"); }
export function serializeAskV1(value: AskV1): string { return serializeExactShape(AskV1Schema, value, "ask"); }
export function parseAskV1(text: string): ResultValue<AskV1, FoundationError> { return parseExactShape(AskV1Schema, text, "ask"); }
