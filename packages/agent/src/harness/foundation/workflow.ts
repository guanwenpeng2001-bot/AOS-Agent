import { Type } from "typebox";
import { Result, type Result as ResultValue } from "../result.ts";
import {
	type BudgetUsageV1,
	BudgetUsageV1Schema,
	type BudgetV1,
	BudgetV1Schema,
	validateBudgetUsageV1,
	validateBudgetV1,
} from "./budget.ts";
import { FoundationError } from "./errors.ts";
import type { FoundationJsonValue } from "./event-catalog.ts";
import { type RevisionReferenceV1, RevisionReferenceV1Schema } from "./reference.ts";
import { parseExactShape, serializeExactShape, validateExactShape } from "./schema.ts";

export const FOUNDATION_WORKFLOW_DSL_VERSION = 1 as const;
export type WorkflowDslVersionV1 = typeof FOUNDATION_WORKFLOW_DSL_VERSION;
export type WorkflowStatusV1 = "draft" | "active" | "paused" | "stopped" | "completed";
export const WORKFLOW_STEP_STATUSES_V1 = Object.freeze([
	"pending",
	"ready",
	"running",
	"waiting_user",
	"awaiting_dispatch",
	"blocked",
	"succeeded",
	"failed",
	"cancelled",
	"skipped",
] as const);
export type WorkflowStepStatusV1 = (typeof WORKFLOW_STEP_STATUSES_V1)[number];
export const WORKFLOW_STEP_TYPES_V1 = Object.freeze([
	"agent",
	"tool",
	"parallel",
	"gate",
	"await_user",
	"barrier",
	"acceptance",
] as const);
export type WorkflowContractKindV1 = "json" | "artifact_ref" | "task_result_ref" | "none";

export interface WorkflowValueContractV1 {
	readonly schemaVersion: 1;
	readonly contractId: string;
	readonly kind: WorkflowContractKindV1;
	readonly required: boolean;
	readonly schemaRef?: RevisionReferenceV1;
}

export interface WorkflowStepBaseV1 {
	readonly schemaVersion: 1;
	readonly stepId: string;
	readonly ordinal: number;
	readonly revision: number;
	readonly status: WorkflowStepStatusV1;
	readonly input: readonly WorkflowValueContractV1[];
	readonly output: readonly WorkflowValueContractV1[];
	readonly label?: string;
	readonly dependsOn?: readonly string[];
}

export interface AgentStepV1 extends WorkflowStepBaseV1 {
	readonly type: "agent";
	readonly taskId: string;
	readonly roleRevision: RevisionReferenceV1 & { readonly type: "role_revision" };
	readonly executor: "local" | "external";
}

export interface ToolStepV1 extends WorkflowStepBaseV1 {
	readonly type: "tool";
	readonly toolName: string;
}

export interface ParallelIntentV1 {
	readonly schemaVersion: 1;
	readonly intentId: string;
	readonly stepId: string;
	readonly executor: "local" | "external";
}

export interface ParallelStepV1 extends WorkflowStepBaseV1 {
	readonly type: "parallel";
	readonly intents: readonly ParallelIntentV1[];
}

export interface GateStepV1 extends WorkflowStepBaseV1 {
	readonly type: "gate";
	readonly gateId: string;
}
export interface AwaitUserStepV1 extends WorkflowStepBaseV1 {
	readonly type: "await_user";
	readonly askId: string;
}
export interface BarrierStepV1 extends WorkflowStepBaseV1 {
	readonly type: "barrier";
	readonly barrierId: string;
}
export interface AcceptanceStepV1 extends WorkflowStepBaseV1 {
	readonly type: "acceptance";
	readonly criterionIds: readonly string[];
}
export type WorkflowStepV1 =
	| AgentStepV1
	| ToolStepV1
	| ParallelStepV1
	| GateStepV1
	| AwaitUserStepV1
	| BarrierStepV1
	| AcceptanceStepV1;

export interface WorkflowV1 {
	readonly schemaVersion: 1;
	readonly dslVersion: WorkflowDslVersionV1;
	readonly sessionId: string;
	readonly workflowId: string;
	readonly revision: number;
	readonly status: WorkflowStatusV1;
	readonly goalId?: string;
	readonly planId?: string;
	readonly budget?: BudgetV1;
	readonly budgetUsage?: BudgetUsageV1;
	readonly steps: readonly WorkflowStepV1[];
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly stoppedAt?: string;
}

const workflowContractKindSchema = Type.Union([
	Type.Literal("json"),
	Type.Literal("artifact_ref"),
	Type.Literal("task_result_ref"),
	Type.Literal("none"),
]);
export const WorkflowValueContractV1Schema = Type.Object(
	{
		schemaVersion: Type.Literal(1),
		contractId: Type.String({ minLength: 1 }),
		kind: workflowContractKindSchema,
		required: Type.Boolean(),
		schemaRef: Type.Optional(RevisionReferenceV1Schema),
	},
	{ additionalProperties: false },
);
const workflowStepStatusSchema = Type.Union([
	Type.Literal("pending"),
	Type.Literal("ready"),
	Type.Literal("running"),
	Type.Literal("waiting_user"),
	Type.Literal("awaiting_dispatch"),
	Type.Literal("blocked"),
	Type.Literal("succeeded"),
	Type.Literal("failed"),
	Type.Literal("cancelled"),
	Type.Literal("skipped"),
]);
const workflowStepProperties = {
	schemaVersion: Type.Literal(1),
	stepId: Type.String({ minLength: 1 }),
	ordinal: Type.Integer({ minimum: 0 }),
	revision: Type.Integer({ minimum: 0 }),
	status: workflowStepStatusSchema,
	input: Type.Array(WorkflowValueContractV1Schema, { minItems: 1 }),
	output: Type.Array(WorkflowValueContractV1Schema, { minItems: 1 }),
	label: Type.Optional(Type.String()),
	dependsOn: Type.Optional(Type.Array(Type.String({ minLength: 1 }))),
} as const;
const roleRevisionReferenceSchema = Type.Object(
	{
		schemaVersion: Type.Literal(1),
		type: Type.Literal("role_revision"),
		id: Type.String({ minLength: 1 }),
		revision: Type.Integer({ minimum: 0 }),
		fingerprint: Type.Optional(
			Type.Object(
				{ algorithm: Type.Literal("sha256"), value: Type.String({ minLength: 1 }) },
				{ additionalProperties: false },
			),
		),
		providerId: Type.Optional(Type.String({ minLength: 1 })),
	},
	{ additionalProperties: false },
);
export const ParallelIntentV1Schema = Type.Object(
	{
		schemaVersion: Type.Literal(1),
		intentId: Type.String({ minLength: 1 }),
		stepId: Type.String({ minLength: 1 }),
		executor: Type.Union([Type.Literal("local"), Type.Literal("external")]),
	},
	{ additionalProperties: false },
);
export const WorkflowStepV1Schema = Type.Union([
	Type.Object(
		{
			...workflowStepProperties,
			type: Type.Literal("agent"),
			taskId: Type.String({ minLength: 1 }),
			roleRevision: roleRevisionReferenceSchema,
			executor: Type.Union([Type.Literal("local"), Type.Literal("external")]),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{ ...workflowStepProperties, type: Type.Literal("tool"), toolName: Type.String({ minLength: 1 }) },
		{ additionalProperties: false },
	),
	Type.Object(
		{ ...workflowStepProperties, type: Type.Literal("parallel"), intents: Type.Array(ParallelIntentV1Schema) },
		{ additionalProperties: false },
	),
	Type.Object(
		{ ...workflowStepProperties, type: Type.Literal("gate"), gateId: Type.String({ minLength: 1 }) },
		{ additionalProperties: false },
	),
	Type.Object(
		{ ...workflowStepProperties, type: Type.Literal("await_user"), askId: Type.String({ minLength: 1 }) },
		{ additionalProperties: false },
	),
	Type.Object(
		{ ...workflowStepProperties, type: Type.Literal("barrier"), barrierId: Type.String({ minLength: 1 }) },
		{ additionalProperties: false },
	),
	Type.Object(
		{
			...workflowStepProperties,
			type: Type.Literal("acceptance"),
			criterionIds: Type.Array(Type.String({ minLength: 1 })),
		},
		{ additionalProperties: false },
	),
]);
export const WorkflowV1Schema = Type.Object(
	{
		schemaVersion: Type.Literal(1),
		dslVersion: Type.Literal(FOUNDATION_WORKFLOW_DSL_VERSION),
		sessionId: Type.String({ minLength: 1 }),
		workflowId: Type.String({ minLength: 1 }),
		revision: Type.Integer({ minimum: 0 }),
		status: Type.Union([
			Type.Literal("draft"),
			Type.Literal("active"),
			Type.Literal("paused"),
			Type.Literal("stopped"),
			Type.Literal("completed"),
		]),
		goalId: Type.Optional(Type.String({ minLength: 1 })),
		planId: Type.Optional(Type.String({ minLength: 1 })),
		budget: Type.Optional(BudgetV1Schema),
		budgetUsage: Type.Optional(BudgetUsageV1Schema),
		steps: Type.Array(WorkflowStepV1Schema),
		createdAt: Type.String({ minLength: 1 }),
		updatedAt: Type.String({ minLength: 1 }),
		stoppedAt: Type.Optional(Type.String({ minLength: 1 })),
	},
	{ additionalProperties: false },
);

function checkedWorkflow(value: unknown): ResultValue<WorkflowV1, FoundationError> {
	const checked = validateExactShape<WorkflowV1>(WorkflowV1Schema, value, "workflow");
	if (!checked.ok) return checked;
	const workflow = checked.value;
	if (workflow.budget !== undefined) {
		const budget = validateBudgetV1(workflow.budget);
		if (!budget.ok) return Result.err(budget.error);
	}
	if (workflow.budgetUsage !== undefined) {
		const usage = validateBudgetUsageV1(workflow.budgetUsage);
		if (!usage.ok) return Result.err(usage.error);
	}
	const stepIds = workflow.steps.map((step) => step.stepId);
	if (new Set(stepIds).size !== stepIds.length)
		return Result.err(new FoundationError("structure_schema_invalid", "Workflow step ids must be unique"));
	const ordinals = workflow.steps.map((step) => step.ordinal);
	if (new Set(ordinals).size !== ordinals.length)
		return Result.err(new FoundationError("structure_schema_invalid", "Workflow step ordinals must be unique"));
	const known = new Set(stepIds);
	for (const step of workflow.steps) {
		if (step.dependsOn?.some((dependency) => dependency === step.stepId || !known.has(dependency)))
			return Result.err(new FoundationError("structure_schema_invalid", "Workflow dependency is invalid"));
		if (step.status === "awaiting_dispatch" && (step.type !== "agent" || step.executor !== "external"))
			return Result.err(
				new FoundationError("structure_schema_invalid", "Only an external Agent step can await dispatch"),
			);
		if (step.type === "agent" && step.executor === "external" && step.status === "running")
			return Result.err(
				new FoundationError("structure_schema_invalid", "External Agent step cannot claim running state"),
			);
		if (step.status === "waiting_user" && step.type !== "await_user")
			return Result.err(
				new FoundationError("structure_schema_invalid", "Only AwaitUser steps can wait for user input"),
			);
		if (step.type === "await_user" && (step.status === "running" || step.status === "awaiting_dispatch"))
			return Result.err(
				new FoundationError("structure_schema_invalid", "AwaitUser step has an invalid execution state"),
			);
		if (step.type === "parallel") {
			const intentIds = step.intents.map((intent) => intent.intentId);
			const intentSteps = step.intents.map((intent) => intent.stepId);
			if (
				new Set(intentIds).size !== intentIds.length ||
				new Set(intentSteps).size !== intentSteps.length ||
				intentSteps.some((stepId) => stepId === step.stepId || !known.has(stepId))
			)
				return Result.err(
					new FoundationError("structure_schema_invalid", "Parallel intents must uniquely reference child steps"),
				);
		}
	}
	return Result.ok(workflow);
}

export function validateWorkflowV1(value: unknown): ResultValue<WorkflowV1, FoundationError> {
	return checkedWorkflow(value);
}
export function serializeWorkflowV1(value: WorkflowV1): string {
	return serializeExactShape(WorkflowV1Schema, value, "workflow");
}
export function parseWorkflowV1(text: string): ResultValue<WorkflowV1, FoundationError> {
	const parsed = parseExactShape<WorkflowV1>(WorkflowV1Schema, text, "workflow");
	return parsed.ok ? checkedWorkflow(parsed.value) : parsed;
}
export const validateWorkflow = validateWorkflowV1;
export const serializeWorkflow = serializeWorkflowV1;
export const parseWorkflow = parseWorkflowV1;
export function workflowAwaitingExternalExecutor(workflow: WorkflowV1): boolean {
	return workflow.steps.some(
		(step) => step.type === "agent" && step.executor === "external" && step.status === "awaiting_dispatch",
	);
}

export type WorkflowMigrationV1 = (value: FoundationJsonValue) => FoundationJsonValue;

export class WorkflowMigrationRegistryV1 {
	private readonly migrations = new Map<
		number,
		{ readonly toVersion: number; readonly migrate: WorkflowMigrationV1 }
	>();

	register(fromVersion: number, toVersion: number, migrate: WorkflowMigrationV1): void {
		if (!Number.isSafeInteger(fromVersion) || !Number.isSafeInteger(toVersion) || fromVersion < 0 || toVersion !== fromVersion + 1)
			throw new FoundationError(
				"foundation_schema_unsupported_version",
				"Workflow migrations must advance exactly one version",
			);
		if (this.migrations.has(fromVersion))
			throw new FoundationError("workflow_conflict", "Workflow migration source version is already registered");
		this.migrations.set(fromVersion, { toVersion, migrate });
	}

	migrate(
		value: FoundationJsonValue,
		targetVersion: number = FOUNDATION_WORKFLOW_DSL_VERSION,
	): ResultValue<WorkflowV1, FoundationError> {
		if (targetVersion !== FOUNDATION_WORKFLOW_DSL_VERSION)
			return Result.err(
				new FoundationError("foundation_schema_unsupported_version", "Workflow migration target is unsupported"),
			);
		if (value === null || typeof value !== "object" || Array.isArray(value))
			return Result.err(
				new FoundationError("foundation_schema_invalid_shape", "Workflow migration input must be an object"),
			);
		const source = value.dslVersion;
		if (typeof source !== "number" || !Number.isSafeInteger(source) || source < 0 || source > targetVersion)
			return Result.err(
				new FoundationError("foundation_schema_unsupported_version", "Workflow DSL version is unsupported"),
			);
		let current: FoundationJsonValue = value;
		let version = source;
		try {
			while (version < targetVersion) {
				const migration = this.migrations.get(version);
				if (migration === undefined)
					return Result.err(
						new FoundationError(
							"foundation_schema_unsupported_version",
							`Workflow migration ${version} is not registered`,
						),
					);
				current = migration.migrate(current);
				version = migration.toVersion;
				if (
					current === null ||
					typeof current !== "object" ||
					Array.isArray(current) ||
					current.dslVersion !== version
				)
					return Result.err(
						new FoundationError(
							"foundation_schema_invalid_shape",
							"Workflow migration returned the wrong version",
						),
					);
			}
			return checkedWorkflow(current);
		} catch (error) {
			return Result.err(
				error instanceof FoundationError
					? error
					: new FoundationError(
							"foundation_schema_invalid_shape",
							error instanceof Error ? error.message : String(error),
						),
			);
		}
	}
}

export const foundationWorkflowMigrationRegistryV1 = new WorkflowMigrationRegistryV1();
export function migrateWorkflowV1(value: FoundationJsonValue): ResultValue<WorkflowV1, FoundationError> {
	return foundationWorkflowMigrationRegistryV1.migrate(value);
}
