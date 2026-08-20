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

export interface WorkflowEvaluationExpectedStepV1 {
	readonly stepId: string;
	readonly status: WorkflowStepStatusV1;
}

export interface WorkflowEvaluationCaseV1 {
	readonly schemaVersion: 1;
	readonly caseId: string;
	readonly workflow: WorkflowV1;
	readonly expectedStatus: WorkflowStatusV1;
	readonly expectedSteps: readonly WorkflowEvaluationExpectedStepV1[];
	readonly maxCost: number;
	readonly requireRecovery: boolean;
}

export interface WorkflowEvaluationDatasetV1 {
	readonly schemaVersion: 1;
	readonly datasetId: string;
	readonly revision: number;
	readonly cases: readonly WorkflowEvaluationCaseV1[];
}

export interface WorkflowEvaluationObservationV1 {
	readonly caseId: string;
	readonly workflow: WorkflowV1;
	readonly cost: number;
	readonly recovered: boolean;
}

export interface WorkflowEvaluationCaseResultV1 {
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

export interface WorkflowEvaluationSnapshotV1 {
	readonly schemaVersion: 1;
	readonly datasetId: string;
	readonly datasetRevision: number;
	readonly runId: string;
	readonly createdAt: string;
	readonly cases: readonly WorkflowEvaluationCaseResultV1[];
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
export const WorkflowEvaluationSnapshotV1Schema = Type.Object(
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

function workflowEvaluationError(message: string): ResultValue<never, FoundationError> {
	return Result.err(new FoundationError("structure_schema_invalid", message));
}

export function runWorkflowEvaluationV1(input: {
	readonly dataset: WorkflowEvaluationDatasetV1;
	readonly observations: readonly WorkflowEvaluationObservationV1[];
	readonly runId: string;
	readonly createdAt: string;
}): ResultValue<WorkflowEvaluationSnapshotV1, FoundationError> {
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
	const observations = new Map<string, WorkflowEvaluationObservationV1>();
	for (const observation of input.observations) {
		if (observations.has(observation.caseId)) {
			return workflowEvaluationError("Workflow evaluation observations must be unique per case");
		}
		observations.set(observation.caseId, observation);
	}
	if (input.observations.length !== input.dataset.cases.length || input.observations.some((item) => !caseIds.includes(item.caseId))) {
		return workflowEvaluationError("Workflow evaluation observations must exactly cover the dataset");
	}

	const results: WorkflowEvaluationCaseResultV1[] = [];
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

export function serializeWorkflowEvaluationSnapshotV1(value: WorkflowEvaluationSnapshotV1): string {
	return serializeExactShape(WorkflowEvaluationSnapshotV1Schema, value, "workflow evaluation snapshot");
}

export function parseWorkflowEvaluationSnapshotV1(
	text: string,
): ResultValue<WorkflowEvaluationSnapshotV1, FoundationError> {
	return parseExactShape<WorkflowEvaluationSnapshotV1>(
		WorkflowEvaluationSnapshotV1Schema,
		text,
		"workflow evaluation snapshot",
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
