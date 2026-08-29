import { Type } from "typebox";
import { Result, type ResultValue } from "../result.ts";
import {
	type BudgetUsage,
	BudgetUsageSchema,
	type Budget,
	BudgetSchema,
	validateBudgetUsage,
	validateBudget,
} from "./budget.ts";
import { FoundationError } from "./errors.ts";
import type { FoundationJsonValue } from "./event-catalog.ts";
import { type RevisionReference, RevisionReferenceSchema } from "./reference.ts";
import { parseExactShape, serializeExactShape, validateExactShape } from "./schema.ts";

export const FOUNDATION_WORKFLOW_DSL_VERSION = 1 as const;
export type WorkflowDslVersion = typeof FOUNDATION_WORKFLOW_DSL_VERSION;
export type WorkflowStatus = "draft" | "active" | "paused" | "stopped" | "completed";
export const WORKFLOW_STEP_STATUSES = Object.freeze([
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
export type WorkflowStepStatus = (typeof WORKFLOW_STEP_STATUSES)[number];
export const WORKFLOW_STEP_TYPES = Object.freeze([
	"agent",
	"tool",
	"parallel",
	"gate",
	"await_user",
	"barrier",
	"acceptance",
] as const);
export type WorkflowContractKind = "json" | "artifact_ref" | "task_result_ref" | "none";

export interface WorkflowValueContract {
	readonly schemaVersion: 1;
	readonly contractId: string;
	readonly kind: WorkflowContractKind;
	readonly required: boolean;
	readonly schemaRef?: RevisionReference;
}

export interface WorkflowStepBase {
	readonly schemaVersion: 1;
	readonly stepId: string;
	readonly ordinal: number;
	readonly revision: number;
	readonly status: WorkflowStepStatus;
	readonly input: readonly WorkflowValueContract[];
	readonly output: readonly WorkflowValueContract[];
	readonly label?: string;
	readonly dependsOn?: readonly string[];
}

export interface AgentStep extends WorkflowStepBase {
	readonly type: "agent";
	readonly taskId: string;
	readonly roleRevision: RevisionReference & { readonly type: "role_revision" };
	readonly executor: "local" | "external";
}

export interface ToolStep extends WorkflowStepBase {
	readonly type: "tool";
	readonly toolName: string;
}

export interface ParallelIntent {
	readonly schemaVersion: 1;
	readonly intentId: string;
	readonly stepId: string;
	readonly executor: "local" | "external";
}

export interface ParallelStep extends WorkflowStepBase {
	readonly type: "parallel";
	readonly intents: readonly ParallelIntent[];
}

export interface GateStep extends WorkflowStepBase {
	readonly type: "gate";
	readonly gateId: string;
}
export interface AwaitUserStep extends WorkflowStepBase {
	readonly type: "await_user";
	readonly askId: string;
}
export interface BarrierStep extends WorkflowStepBase {
	readonly type: "barrier";
	readonly barrierId: string;
}
export interface AcceptanceStep extends WorkflowStepBase {
	readonly type: "acceptance";
	readonly criterionIds: readonly string[];
}
export type WorkflowStep =
	| AgentStep
	| ToolStep
	| ParallelStep
	| GateStep
	| AwaitUserStep
	| BarrierStep
	| AcceptanceStep;

export interface Workflow {
	readonly schemaVersion: 1;
	readonly dslVersion: WorkflowDslVersion;
	readonly sessionId: string;
	readonly workflowId: string;
	readonly revision: number;
	readonly status: WorkflowStatus;
	readonly goalId?: string;
	readonly planId?: string;
	readonly budget?: Budget;
	readonly budgetUsage?: BudgetUsage;
	readonly steps: readonly WorkflowStep[];
	readonly createdAt: string;
	readonly updatedAt: string;
	readonly stoppedAt?: string;
}

export interface WorkflowEvaluationExpectedStep {
	readonly stepId: string;
	readonly status: WorkflowStepStatus;
}

export interface WorkflowEvaluationCase {
	readonly schemaVersion: 1;
	readonly caseId: string;
	readonly workflow: Workflow;
	readonly expectedStatus: WorkflowStatus;
	readonly expectedSteps: readonly WorkflowEvaluationExpectedStep[];
	readonly maxCost: number;
	readonly requireRecovery: boolean;
}

export interface WorkflowEvaluationDataset {
	readonly schemaVersion: 1;
	readonly datasetId: string;
	readonly revision: number;
	readonly cases: readonly WorkflowEvaluationCase[];
}

export interface WorkflowEvaluationObservation {
	readonly caseId: string;
	readonly workflow: Workflow;
	readonly cost: number;
	readonly recovered: boolean;
}

export interface WorkflowEvaluationCaseResult {
	readonly schemaVersion: 1;
	readonly caseId: string;
	readonly workflowId: string;
	readonly baselineRevision: number;
	readonly observedRevision: number;
	readonly qualityPassed: boolean;
	readonly costPassed: boolean;
	readonly recoveryPassed: boolean;
	readonly actualCost: number;
	readonly maxCost: number;
	readonly failures: readonly string[];
	readonly passed: boolean;
}

export interface WorkflowEvaluationSnapshot {
	readonly schemaVersion: 1;
	readonly datasetId: string;
	readonly datasetRevision: number;
	readonly runId: string;
	readonly createdAt: string;
	readonly cases: readonly WorkflowEvaluationCaseResult[];
	readonly summary: {
		readonly total: number;
		readonly passed: number;
		readonly qualityFailures: number;
		readonly costFailures: number;
		readonly recoveryFailures: number;
	};
}

const workflowContractKindSchema = Type.Union([
	Type.Literal("json"),
	Type.Literal("artifact_ref"),
	Type.Literal("task_result_ref"),
	Type.Literal("none"),
]);
export const WorkflowValueContractSchema = Type.Object(
	{
		schemaVersion: Type.Literal(1),
		contractId: Type.String({ minLength: 1 }),
		kind: workflowContractKindSchema,
		required: Type.Boolean(),
		schemaRef: Type.Optional(RevisionReferenceSchema),
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
	input: Type.Array(WorkflowValueContractSchema, { minItems: 1 }),
	output: Type.Array(WorkflowValueContractSchema, { minItems: 1 }),
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
export const ParallelIntentSchema = Type.Object(
	{
		schemaVersion: Type.Literal(1),
		intentId: Type.String({ minLength: 1 }),
		stepId: Type.String({ minLength: 1 }),
		executor: Type.Union([Type.Literal("local"), Type.Literal("external")]),
	},
	{ additionalProperties: false },
);
export const WorkflowStepSchema = Type.Union([
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
		{ ...workflowStepProperties, type: Type.Literal("parallel"), intents: Type.Array(ParallelIntentSchema) },
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
export const WorkflowSchema = Type.Object(
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
		budget: Type.Optional(BudgetSchema),
		budgetUsage: Type.Optional(BudgetUsageSchema),
		steps: Type.Array(WorkflowStepSchema),
		createdAt: Type.String({ minLength: 1 }),
		updatedAt: Type.String({ minLength: 1 }),
		stoppedAt: Type.Optional(Type.String({ minLength: 1 })),
	},
	{ additionalProperties: false },
);
const WorkflowEvaluationCaseResultV1Schema = Type.Object(
	{
		schemaVersion: Type.Literal(1),
		caseId: Type.String({ minLength: 1 }),
		workflowId: Type.String({ minLength: 1 }),
		baselineRevision: Type.Integer({ minimum: 0 }),
		observedRevision: Type.Integer({ minimum: 0 }),
		qualityPassed: Type.Boolean(),
		costPassed: Type.Boolean(),
		recoveryPassed: Type.Boolean(),
		actualCost: Type.Number({ minimum: 0 }),
		maxCost: Type.Number({ minimum: 0 }),
		failures: Type.Array(Type.String({ minLength: 1 })),
		passed: Type.Boolean(),
	},
	{ additionalProperties: false },
);
export const WorkflowEvaluationSnapshotSchema = Type.Object(
	{
		schemaVersion: Type.Literal(1),
		datasetId: Type.String({ minLength: 1 }),
		datasetRevision: Type.Integer({ minimum: 0 }),
		runId: Type.String({ minLength: 1 }),
		createdAt: Type.String({ minLength: 1 }),
		cases: Type.Array(WorkflowEvaluationCaseResultV1Schema),
		summary: Type.Object(
			{
				total: Type.Integer({ minimum: 0 }),
				passed: Type.Integer({ minimum: 0 }),
				qualityFailures: Type.Integer({ minimum: 0 }),
				costFailures: Type.Integer({ minimum: 0 }),
				recoveryFailures: Type.Integer({ minimum: 0 }),
			},
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);

function checkedWorkflow(value: unknown): ResultValue<Workflow, FoundationError> {
	const checked = validateExactShape<Workflow>(WorkflowSchema, value, "workflow");
	if (!checked.ok) return checked;
	const workflow = checked.value;
	if (workflow.budget !== undefined) {
		const budget = validateBudget(workflow.budget);
		if (!budget.ok) return Result.err(budget.error);
	}
	if (workflow.budgetUsage !== undefined) {
		const usage = validateBudgetUsage(workflow.budgetUsage);
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

export function validateWorkflow(value: unknown): ResultValue<Workflow, FoundationError> {
	return checkedWorkflow(value);
}
export function serializeWorkflow(value: Workflow): string {
	return serializeExactShape(WorkflowSchema, value, "workflow");
}
export function parseWorkflow(text: string): ResultValue<Workflow, FoundationError> {
	const parsed = parseExactShape<Workflow>(WorkflowSchema, text, "workflow");
	return parsed.ok ? checkedWorkflow(parsed.value) : parsed;
}
export function workflowAwaitingExternalExecutor(workflow: Workflow): boolean {
	return workflow.steps.some(
		(step) => step.type === "agent" && step.executor === "external" && step.status === "awaiting_dispatch",
	);
}

function workflowEvaluationError(message: string): ResultValue<never, FoundationError> {
	return Result.err(new FoundationError("structure_schema_invalid", message));
}

export function runWorkflowEvaluation(input: {
	readonly dataset: WorkflowEvaluationDataset;
	readonly observations: readonly WorkflowEvaluationObservation[];
	readonly runId: string;
	readonly createdAt: string;
}): ResultValue<WorkflowEvaluationSnapshot, FoundationError> {
	if (
		input.dataset.schemaVersion !== 1 ||
		input.dataset.datasetId.length === 0 ||
		!Number.isSafeInteger(input.dataset.revision) ||
		input.dataset.revision < 0 ||
		input.dataset.cases.length === 0 ||
		input.runId.length === 0 ||
		input.createdAt.length === 0
	) return workflowEvaluationError("Workflow evaluation metadata is invalid");

	const caseIds = input.dataset.cases.map((testCase) => testCase.caseId);
	if (caseIds.some((caseId) => caseId.length === 0) || new Set(caseIds).size !== caseIds.length) {
		return workflowEvaluationError("Workflow evaluation case ids must be nonempty and unique");
	}
	const observations = new Map<string, WorkflowEvaluationObservation>();
	for (const observation of input.observations) {
		if (observations.has(observation.caseId)) {
			return workflowEvaluationError("Workflow evaluation observations must be unique per case");
		}
		observations.set(observation.caseId, observation);
	}
	if (input.observations.length !== input.dataset.cases.length || input.observations.some((item) => !caseIds.includes(item.caseId))) {
		return workflowEvaluationError("Workflow evaluation observations must exactly cover the dataset");
	}

	const results: WorkflowEvaluationCaseResult[] = [];
	for (const testCase of input.dataset.cases) {
		if (testCase.schemaVersion !== 1 || !Number.isFinite(testCase.maxCost) || testCase.maxCost < 0) {
			return workflowEvaluationError(`Workflow evaluation case ${testCase.caseId} is invalid`);
		}
		const baseline = checkedWorkflow(testCase.workflow);
		if (!baseline.ok) return Result.err(baseline.error);
		const expectedStepIds = testCase.expectedSteps.map((step) => step.stepId);
		const baselineStepIds = new Set(testCase.workflow.steps.map((step) => step.stepId));
		if (
			new Set(expectedStepIds).size !== expectedStepIds.length ||
			expectedStepIds.some((stepId) => !baselineStepIds.has(stepId))
		) return workflowEvaluationError(`Workflow evaluation case ${testCase.caseId} has invalid step expectations`);

		const observation = observations.get(testCase.caseId);
		if (observation === undefined) return workflowEvaluationError(`Workflow evaluation case ${testCase.caseId} is missing`);
		const observed = checkedWorkflow(observation.workflow);
		if (!observed.ok) return Result.err(observed.error);
		if (observation.workflow.workflowId !== testCase.workflow.workflowId) {
			return workflowEvaluationError(`Workflow evaluation case ${testCase.caseId} observed the wrong workflow`);
		}
		if (!Number.isFinite(observation.cost) || observation.cost < 0) {
			return workflowEvaluationError(`Workflow evaluation case ${testCase.caseId} has invalid cost`);
		}

		const failures: string[] = [];
		if (observation.workflow.status !== testCase.expectedStatus) failures.push("workflow_status");
		const observedSteps = new Map(observation.workflow.steps.map((step) => [step.stepId, step.status]));
		for (const expectation of testCase.expectedSteps) {
			if (observedSteps.get(expectation.stepId) !== expectation.status) failures.push(`step_status:${expectation.stepId}`);
		}
		const qualityPassed = failures.length === 0;
		const costPassed = observation.cost <= testCase.maxCost;
		const recoveryPassed = !testCase.requireRecovery || observation.recovered;
		if (!costPassed) failures.push("cost");
		if (!recoveryPassed) failures.push("recovery");
		results.push({
			schemaVersion: 1,
			caseId: testCase.caseId,
			workflowId: testCase.workflow.workflowId,
			baselineRevision: testCase.workflow.revision,
			observedRevision: observation.workflow.revision,
			qualityPassed,
			costPassed,
			recoveryPassed,
			actualCost: observation.cost,
			maxCost: testCase.maxCost,
			failures,
			passed: qualityPassed && costPassed && recoveryPassed,
		});
	}

	return Result.ok({
		schemaVersion: 1,
		datasetId: input.dataset.datasetId,
		datasetRevision: input.dataset.revision,
		runId: input.runId,
		createdAt: input.createdAt,
		cases: results,
		summary: {
			total: results.length,
			passed: results.filter((result) => result.passed).length,
			qualityFailures: results.filter((result) => !result.qualityPassed).length,
			costFailures: results.filter((result) => !result.costPassed).length,
			recoveryFailures: results.filter((result) => !result.recoveryPassed).length,
		},
	});
}

export function serializeWorkflowEvaluationSnapshot(value: WorkflowEvaluationSnapshot): string {
	return serializeExactShape(WorkflowEvaluationSnapshotSchema, value, "workflow evaluation snapshot");
}

export function parseWorkflowEvaluationSnapshot(
	text: string,
): ResultValue<WorkflowEvaluationSnapshot, FoundationError> {
	return parseExactShape<WorkflowEvaluationSnapshot>(
		WorkflowEvaluationSnapshotSchema,
		text,
		"workflow evaluation snapshot",
	);
}

export type WorkflowMigration = (value: FoundationJsonValue) => FoundationJsonValue;

export class WorkflowMigrationRegistry {
	private readonly migrations = new Map<
		number,
		{ readonly toVersion: number; readonly migrate: WorkflowMigration }
	>();

	register(fromVersion: number, toVersion: number, migrate: WorkflowMigration): void {
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
	): ResultValue<Workflow, FoundationError> {
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

export const foundationWorkflowMigrationRegistry = new WorkflowMigrationRegistry();
export function migrateWorkflow(value: FoundationJsonValue): ResultValue<Workflow, FoundationError> {
	return foundationWorkflowMigrationRegistry.migrate(value);
}
