export const FOUNDATION_WORKFLOW_DSL_VERSION = 1 as const;
import { Type } from "typebox";
import type { Result as ResultValue } from "../result.ts";
import type { FoundationError } from "./errors.ts";
import { parseExactShape, serializeExactShape, validateExactShape } from "./schema.ts";

export type WorkflowStatusV1 = "draft" | "active" | "paused" | "stopped" | "completed";
export type WorkflowStepStatusV1 = "pending" | "ready" | "active" | "awaiting_dispatch" | "awaiting_result" | "completed" | "failed" | "skipped";
export interface WorkflowStepBaseV1 { schemaVersion: 1; stepId: string; ordinal: number; status: WorkflowStepStatusV1; label?: string; dependsOn?: readonly string[]; }
export interface AgentStepV1 extends WorkflowStepBaseV1 { type: "agent"; taskId: string; }
export interface ToolStepV1 extends WorkflowStepBaseV1 { type: "tool"; toolName: string; }
export interface ParallelStepV1 extends WorkflowStepBaseV1 { type: "parallel"; childStepIds: readonly string[]; }
export interface GateStepV1 extends WorkflowStepBaseV1 { type: "gate"; gateId: string; }
export interface AwaitUserStepV1 extends WorkflowStepBaseV1 { type: "await_user"; askId: string; }
export interface BarrierStepV1 extends WorkflowStepBaseV1 { type: "barrier"; barrierId: string; }
export interface AcceptanceStepV1 extends WorkflowStepBaseV1 { type: "acceptance"; criterionIds: readonly string[]; }
export type WorkflowStepV1 = AgentStepV1 | ToolStepV1 | ParallelStepV1 | GateStepV1 | AwaitUserStepV1 | BarrierStepV1 | AcceptanceStepV1;
export interface WorkflowV1 { schemaVersion: 1; workflowId: string; revision: number; status: WorkflowStatusV1; goalId?: string; planId?: string; steps: readonly WorkflowStepV1[]; createdAt: string; updatedAt: string; }

const workflowStepProperties = { schemaVersion: Type.Literal(1), stepId: Type.String({ minLength: 1 }), ordinal: Type.Integer({ minimum: 0 }), status: Type.Union([Type.Literal("pending"), Type.Literal("ready"), Type.Literal("active"), Type.Literal("awaiting_dispatch"), Type.Literal("awaiting_result"), Type.Literal("completed"), Type.Literal("failed"), Type.Literal("skipped")]), label: Type.Optional(Type.String()), dependsOn: Type.Optional(Type.Array(Type.String({ minLength: 1 }))) } as const;
export const WorkflowStepV1Schema = Type.Union([
	Type.Object({ ...workflowStepProperties, type: Type.Literal("agent"), taskId: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
	Type.Object({ ...workflowStepProperties, type: Type.Literal("tool"), toolName: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
	Type.Object({ ...workflowStepProperties, type: Type.Literal("parallel"), childStepIds: Type.Array(Type.String({ minLength: 1 })) }, { additionalProperties: false }),
	Type.Object({ ...workflowStepProperties, type: Type.Literal("gate"), gateId: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
	Type.Object({ ...workflowStepProperties, type: Type.Literal("await_user"), askId: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
	Type.Object({ ...workflowStepProperties, type: Type.Literal("barrier"), barrierId: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
	Type.Object({ ...workflowStepProperties, type: Type.Literal("acceptance"), criterionIds: Type.Array(Type.String({ minLength: 1 })) }, { additionalProperties: false }),
]);
export const WorkflowV1Schema = Type.Object({ schemaVersion: Type.Literal(1), workflowId: Type.String({ minLength: 1 }), revision: Type.Integer({ minimum: 0 }), status: Type.Union([Type.Literal("draft"), Type.Literal("active"), Type.Literal("paused"), Type.Literal("stopped"), Type.Literal("completed")]), goalId: Type.Optional(Type.String({ minLength: 1 })), planId: Type.Optional(Type.String({ minLength: 1 })), steps: Type.Array(WorkflowStepV1Schema), createdAt: Type.String({ minLength: 1 }), updatedAt: Type.String({ minLength: 1 }) }, { additionalProperties: false });
export function validateWorkflowV1(value: unknown): ResultValue<WorkflowV1, FoundationError> { return validateExactShape<WorkflowV1>(WorkflowV1Schema, value, "workflow"); }
export function serializeWorkflowV1(value: WorkflowV1): string { return serializeExactShape(WorkflowV1Schema, value, "workflow"); }
export function parseWorkflowV1(text: string): ResultValue<WorkflowV1, FoundationError> { return parseExactShape(WorkflowV1Schema, text, "workflow"); }
export const validateWorkflow = validateWorkflowV1;
export const serializeWorkflow = serializeWorkflowV1;
export const parseWorkflow = parseWorkflowV1;
export function workflowAwaitingExternalExecutor(workflow: WorkflowV1): boolean { return workflow.steps.some((step) => step.status === "awaiting_dispatch" || step.status === "awaiting_result"); }
