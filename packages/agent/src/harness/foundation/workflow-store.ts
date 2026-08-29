import { Type } from "typebox";
import type { FoundationRecord } from "../session/durable/types.ts";
import type { Session } from "../session/session.ts";
import type { SessionLedgerWriter, SessionLedgerWriterOptions } from "../session/ledger-writer.ts";
import {
	type BudgetUsage,
	type Budget,
	budgetExhaustionReason,
	validateBudgetUsage,
	validateBudget,
} from "./budget.ts";
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
	validateTimestamp,
	writeCommandIntent,
	writeCommandResult,
	writeFact,
} from "./durable-store.ts";
import { FoundationError, type FoundationErrorCode } from "./errors.ts";
import { canonicalFoundationJson, sha256HexValue } from "./identity.ts";
import { validateExactShape } from "./schema.ts";
import {
	FOUNDATION_WORKFLOW_DSL_VERSION,
	validateWorkflow,
	type WorkflowStatus,
	type WorkflowStepStatus,
	type WorkflowStep,
	type Workflow,
} from "./workflow.ts";

const WORKFLOW_OBJECT_TYPE = "foundation.workflow";
const EVENT_OBJECT_TYPE = "foundation.workflow.event";
const COMMAND_OBJECT_TYPE = "foundation.workflow.command";

const TERMINAL_STEP_STATUSES = new Set<WorkflowStepStatus>(["succeeded", "failed", "cancelled", "skipped"]);
const COMPLETED_STEP_STATUSES = new Set<WorkflowStepStatus>(["succeeded", "cancelled", "skipped"]);
const STEP_TRANSITIONS: Readonly<Record<WorkflowStepStatus, readonly WorkflowStepStatus[]>> = {
	pending: ["ready", "cancelled", "skipped"],
	ready: ["running", "waiting_user", "awaiting_dispatch", "blocked", "cancelled", "skipped"],
	running: ["waiting_user", "awaiting_dispatch", "blocked", "succeeded", "failed", "cancelled"],
	waiting_user: ["ready", "running", "blocked", "succeeded", "failed", "cancelled"],
	awaiting_dispatch: ["blocked", "succeeded", "failed", "cancelled"],
	blocked: ["ready", "running", "cancelled", "skipped"],
	succeeded: [],
	failed: [],
	cancelled: [],
	skipped: [],
};

export interface WorkflowCreateInput {
	readonly sessionId: string;
	readonly workflowId?: string;
	readonly goalId?: string;
	readonly planId?: string;
	readonly budget?: Budget;
	readonly steps: readonly WorkflowStep[];
}

export interface WorkflowStepTransitionInput {
	readonly stepId: string;
	readonly status: WorkflowStepStatus;
}

export interface WorkflowMutationOptions {
	readonly clientRequestId: string;
	readonly expectedRevision: number;
}

export interface WorkflowStoreOptions extends SessionLedgerWriterOptions {
	readonly writer?: SessionLedgerWriter;
}
export type WorkflowEventType = "workflow.created" | "workflow.activated" | "workflow.paused" | "workflow.resumed" | "workflow.stopped" | "workflow.completed" | "workflow.budget_set" | "workflow.budget_recorded" | "workflow.step_transitioned";

export interface WorkflowEvent {
	readonly schemaVersion: 1;
	readonly eventId: string;
	readonly type: WorkflowEventType;
	readonly workflowId: string;
	readonly revision: number;
	readonly timestamp: string;
	readonly clientRequestId: string;
	readonly commandPayload: string;
}

export const WorkflowEventSchema = Type.Object(
	{
		schemaVersion: Type.Literal(1),
		eventId: Type.String({ minLength: 1 }),
		type: Type.Union([Type.Literal("workflow.created"), Type.Literal("workflow.activated"), Type.Literal("workflow.paused"), Type.Literal("workflow.resumed"), Type.Literal("workflow.stopped"), Type.Literal("workflow.completed"), Type.Literal("workflow.budget_set"), Type.Literal("workflow.budget_recorded"), Type.Literal("workflow.step_transitioned")]),
		workflowId: Type.String({ minLength: 1 }),
		revision: Type.Integer({ minimum: 0 }),
		timestamp: Type.String({ minLength: 1 }),
		clientRequestId: Type.String({ minLength: 1 }),
		commandPayload: Type.String({ minLength: 1 }),
	},
	{ additionalProperties: false },
);

interface WorkflowCommand {
	readonly request: WorkflowMutationOptions;
	readonly command: string;
	readonly payload: string;
	readonly objectId: string;
	readonly timestamp: string;
}

function fail(code: FoundationErrorCode, message: string): never {
	throw new FoundationError(code, message);
}

function mutation(options: WorkflowMutationOptions): WorkflowMutationOptions {
	mutationId(options.clientRequestId);
	expectedRevision(options.expectedRevision);
	return options;
}

function derivedId(prefix: string, requestId: string): string {
	return `${prefix}_${sha256HexValue(requestId).slice(0, 32)}`;
}

function commandPayload(command: string, value: Record<string, unknown>): string {
	try {
		return canonicalFoundationJson({ command, ...value });
	} catch (error) {
		throw asFoundationStoreError(error);
	}
}

function clone<TValue>(value: TValue): TValue {
	return cloneStoreValue(value);
}

function assertWorkflow(value: unknown): Workflow {
	const result = validateWorkflow(value);
	if (!result.ok) throw result.error;
	const workflow = result.value;
	validateTimestamp(workflow.createdAt, "workflow createdAt");
	validateTimestamp(workflow.updatedAt, "workflow updatedAt");
	if (workflow.stoppedAt !== undefined) validateTimestamp(workflow.stoppedAt, "workflow stoppedAt");
	if (workflow.status === "stopped" && workflow.stoppedAt === undefined)
		fail("foundation_schema_invalid_shape", "Stopped Workflow has no stoppedAt");
	if (workflow.status !== "stopped" && workflow.stoppedAt !== undefined)
		fail("foundation_schema_invalid_shape", "Only stopped Workflow may have stoppedAt");
	if (workflow.status === "completed" && workflow.steps.some((step) => !COMPLETED_STEP_STATUSES.has(step.status)))
		fail("foundation_schema_invalid_shape", "Completed Workflow has unfinished steps");
	return workflow;
}

function assertWorkflowEvent(value: unknown): WorkflowEvent {
	const result = validateExactShape<WorkflowEvent>(WorkflowEventSchema, value, "workflow_event");
	if (!result.ok) throw result.error;
	validateTimestamp(result.value.timestamp, "workflow event timestamp");
	return result.value;
}

function latestRecords(records: readonly FoundationRecord[]): Map<string, FoundationRecord> {
	const latest = new Map<string, FoundationRecord>();
	for (const record of records) if (record.kind !== "retention") latest.set(record.objectId, record);
	return latest;
}

function addBudgetUsage(left: BudgetUsage, right: BudgetUsage): BudgetUsage {
	const result: BudgetUsage = {};
	for (const key of ["tokens", "costUsd", "modelCalls", "toolCalls", "wallClockMs", "concurrency"] as const) {
		const value = (left[key] ?? 0) + (right[key] ?? 0);
		if (value !== 0) result[key] = value;
	}
	return result;
}

export class WorkflowStore {
	readonly session: Session;
	readonly writer: ReturnType<typeof createStoreWriter>;

	constructor(session: Session, options: WorkflowStoreOptions = {}) {
		this.session = session;
		this.writer = createStoreWriter(session, options);
	}

	async create(input: WorkflowCreateInput, options: WorkflowMutationOptions): Promise<Workflow> {
		return this.safe("workflow_conflict", async () => {
			const request = mutation(options);
			if (request.expectedRevision !== 0)
				fail("workflow_conflict", "Workflow creation expectedRevision must be zero");
			const sessionId = storeId(input.sessionId, "sessionId");
			if ((await this.session.getMetadata()).id !== sessionId)
				fail("session_ledger_conflict", "Workflow sessionId does not match the supplied Session");
			const workflowId =
				input.workflowId === undefined
					? derivedId("workflow", request.clientRequestId)
					: storeId(input.workflowId, "workflowId");
			const goalId = input.goalId === undefined ? undefined : storeId(input.goalId, "goalId");
			const planId = input.planId === undefined ? undefined : storeId(input.planId, "planId");
			const steps = input.steps.map((step) => clone(step));
			if (steps.some((step) => step.revision !== 1 || step.status !== "pending"))
				fail("workflow_invalid_transition", "New Workflow steps must start pending at revision one");
			const budget = input.budget === undefined ? undefined : this.checkedBudget(input.budget);
			const normalized = {
				sessionId,
				workflowId,
				steps,
				...(goalId === undefined ? {} : { goalId }),
				...(planId === undefined ? {} : { planId }),
				...(budget === undefined ? {} : { budget }),
			};
			const command = await this.begin(
				request,
				"workflow.create",
				commandPayload("workflow.create", { input: normalized, expectedRevision: request.expectedRevision }),
			);
			const replay = await this.recoverCommand(command, "workflow.created");
			if (replay !== undefined) return replay;
			return this.commit(
				command,
				assertWorkflow({
					schemaVersion: 1,
					dslVersion: FOUNDATION_WORKFLOW_DSL_VERSION,
					...normalized,
					revision: 1,
					status: "draft",
					createdAt: command.timestamp,
					updatedAt: command.timestamp,
				}),
				"workflow.created",
			);
		});
	}

	async get(workflowId: string): Promise<Workflow> {
		return this.safe("workflow_not_found", async () => this.load(storeId(workflowId, "workflowId")));
	}

	async list(sessionId?: string): Promise<Workflow[]> {
		return this.safe("workflow_conflict", async () => {
			const normalized = sessionId === undefined ? undefined : storeId(sessionId, "sessionId");
			const records = await this.session.findFoundationRecords({
				objectType: WORKFLOW_OBJECT_TYPE,
				kind: "fact",
				order: "oldestFirst",
				includePruned: true,
			});
			return [...latestRecords(records).values()]
				.filter((record): record is Extract<FoundationRecord, { kind: "fact" }> => record.kind === "fact")
				.map((record) => assertWorkflow(record.payload))
				.filter((workflow) => normalized === undefined || workflow.sessionId === normalized)
				.sort(
					(left, right) =>
						left.createdAt.localeCompare(right.createdAt) || left.workflowId.localeCompare(right.workflowId),
				)
				.map(clone);
		});
	}

	async activate(workflowId: string, options: WorkflowMutationOptions): Promise<Workflow> {
		return this.workflowTransition(
			workflowId,
			options,
			"workflow.activate",
			"workflow.activated",
			["draft"],
			"active",
		);
	}

	async pause(workflowId: string, options: WorkflowMutationOptions): Promise<Workflow> {
		return this.workflowTransition(workflowId, options, "workflow.pause", "workflow.paused", ["active"], "paused");
	}

	async resume(workflowId: string, options: WorkflowMutationOptions): Promise<Workflow> {
		return this.workflowTransition(workflowId, options, "workflow.resume", "workflow.resumed", ["paused"], "active");
	}

	async complete(workflowId: string, options: WorkflowMutationOptions): Promise<Workflow> {
		return this.safe("workflow_conflict", async () => {
			const prepared = await this.prepare(workflowId, options, "workflow.complete");
			const replay = await this.recoverCommand(prepared.command, "workflow.completed");
			if (replay !== undefined) return replay;
			const workflow = await this.load(prepared.workflowId);
			this.assertWorkflowState(workflow, prepared.command.request.expectedRevision, ["active"]);
			if (workflow.steps.some((step) => !COMPLETED_STEP_STATUSES.has(step.status)))
				fail(
					"workflow_invalid_transition",
					"Workflow cannot complete before every step succeeds, is cancelled, or is skipped",
				);
			return this.commit(
				prepared.command,
				{
					...workflow,
					status: "completed",
					revision: workflow.revision + 1,
					updatedAt: prepared.command.timestamp,
				},
				"workflow.completed",
			);
		});
	}

	async stop(workflowId: string, options: WorkflowMutationOptions): Promise<Workflow> {
		return this.safe("workflow_conflict", async () => {
			const prepared = await this.prepare(workflowId, options, "workflow.stop");
			const replay = await this.recoverCommand(prepared.command, "workflow.stopped");
			if (replay !== undefined) return replay;
			const workflow = await this.load(prepared.workflowId);
			this.assertWorkflowState(workflow, prepared.command.request.expectedRevision, ["draft", "active", "paused"]);
			const steps = workflow.steps.map((step) =>
				TERMINAL_STEP_STATUSES.has(step.status)
					? step
					: { ...step, status: "cancelled" as const, revision: step.revision + 1 },
			);
			return this.commit(
				prepared.command,
				{
					...workflow,
					status: "stopped",
					revision: workflow.revision + 1,
					steps,
					stoppedAt: prepared.command.timestamp,
					updatedAt: prepared.command.timestamp,
				},
				"workflow.stopped",
			);
		});
	}

	async setBudget(workflowId: string, budget: Budget, options: WorkflowMutationOptions): Promise<Workflow> {
		return this.safe("workflow_conflict", async () => {
			const normalized = this.checkedBudget(budget);
			const prepared = await this.prepare(workflowId, options, "workflow.set_budget", { budget: normalized });
			const replay = await this.recoverCommand(prepared.command, "workflow.budget_set");
			if (replay !== undefined) return replay;
			const workflow = await this.load(prepared.workflowId);
			this.assertWorkflowState(workflow, prepared.command.request.expectedRevision, ["draft", "active", "paused"]);
			const reason = budgetExhaustionReason(normalized, workflow.budgetUsage ?? {});
			if (reason !== undefined) fail("budget_exhausted", `Workflow budget is already exhausted: ${reason}`);
			return this.commit(
				prepared.command,
				{ ...workflow, budget: normalized, revision: workflow.revision + 1, updatedAt: prepared.command.timestamp },
				"workflow.budget_set",
			);
		});
	}

	async recordBudgetUsage(
		workflowId: string,
		usage: BudgetUsage,
		options: WorkflowMutationOptions,
	): Promise<Workflow> {
		return this.safe("workflow_conflict", async () => {
			const normalized = this.checkedUsage(usage);
			const prepared = await this.prepare(workflowId, options, "workflow.record_budget", { usage: normalized });
			const replay = await this.recoverCommand(prepared.command, "workflow.budget_recorded");
			if (replay !== undefined) return replay;
			const workflow = await this.load(prepared.workflowId);
			this.assertWorkflowState(workflow, prepared.command.request.expectedRevision, ["draft", "active", "paused"]);
			const budgetUsage = addBudgetUsage(workflow.budgetUsage ?? {}, normalized);
			const reason = budgetExhaustionReason(workflow.budget ?? {}, budgetUsage);
			if (reason !== undefined) fail("budget_exhausted", `Workflow budget exhausted: ${reason}`);
			return this.commit(
				prepared.command,
				{ ...workflow, budgetUsage, revision: workflow.revision + 1, updatedAt: prepared.command.timestamp },
				"workflow.budget_recorded",
			);
		});
	}

	async transitionStep(
		workflowId: string,
		input: WorkflowStepTransitionInput,
		options: WorkflowMutationOptions,
	): Promise<Workflow> {
		return this.safe("workflow_conflict", async () => {
			const stepId = storeId(input.stepId, "stepId");
			const status = input.status;
			const prepared = await this.prepare(workflowId, options, "workflow.transition_step", { stepId, status });
			const replay = await this.recoverCommand(prepared.command, "workflow.step_transitioned");
			if (replay !== undefined) return replay;
			const workflow = await this.load(prepared.workflowId);
			this.assertWorkflowState(workflow, prepared.command.request.expectedRevision, ["active"]);
			const index = workflow.steps.findIndex((step) => step.stepId === stepId);
			if (index < 0) fail("workflow_not_found", "Workflow step was not found");
			const step = workflow.steps[index]!;
			if (!STEP_TRANSITIONS[step.status].includes(status))
				fail("workflow_invalid_transition", `Workflow step cannot transition from ${step.status} to ${status}`);
			if (
				status === "ready" &&
				step.dependsOn?.some((dependency) => {
					const dependencyStep = workflow.steps.find((candidate) => candidate.stepId === dependency);
					return dependencyStep === undefined || !COMPLETED_STEP_STATUSES.has(dependencyStep.status);
				})
			)
				fail("workflow_invalid_transition", "Workflow step dependencies are not settled");
			this.assertExecutorTransition(step, status);
			const steps = [...workflow.steps];
			steps[index] = { ...step, status, revision: step.revision + 1 };
			return this.commit(
				prepared.command,
				{ ...workflow, steps, revision: workflow.revision + 1, updatedAt: prepared.command.timestamp },
				"workflow.step_transitioned",
			);
		});
	}

	async eventsFor(workflowId: string): Promise<WorkflowEvent[]> {
		return this.safe("workflow_not_found", async () => {
			const normalized = storeId(workflowId, "workflowId");
			await this.load(normalized);
			const records = await this.session.findFoundationRecords({
				objectType: EVENT_OBJECT_TYPE,
				kind: "fact",
				order: "oldestFirst",
				includePruned: true,
			});
			return records
				.filter((record): record is Extract<FoundationRecord, { kind: "fact" }> => record.kind === "fact")
				.map((record) => assertWorkflowEvent(record.payload))
				.filter((event) => event.workflowId === normalized)
				.map(clone);
		});
	}

	private async workflowTransition(
		workflowId: string,
		options: WorkflowMutationOptions,
		commandName: string,
		eventType: WorkflowEventType,
		from: readonly WorkflowStatus[],
		to: WorkflowStatus,
	): Promise<Workflow> {
		return this.safe("workflow_conflict", async () => {
			const prepared = await this.prepare(workflowId, options, commandName);
			const replay = await this.recoverCommand(prepared.command, eventType);
			if (replay !== undefined) return replay;
			const workflow = await this.load(prepared.workflowId);
			this.assertWorkflowState(workflow, prepared.command.request.expectedRevision, from);
			return this.commit(
				prepared.command,
				{ ...workflow, status: to, revision: workflow.revision + 1, updatedAt: prepared.command.timestamp },
				eventType,
			);
		});
	}

	private async prepare(
		workflowId: string,
		options: WorkflowMutationOptions,
		commandName: string,
		extra: Record<string, unknown> = {},
	): Promise<{ readonly workflowId: string; readonly command: WorkflowCommand }> {
		const request = mutation(options);
		const normalized = storeId(workflowId, "workflowId");
		const payload = commandPayload(commandName, {
			workflowId: normalized,
			...extra,
			expectedRevision: request.expectedRevision,
		});
		return { workflowId: normalized, command: await this.begin(request, commandName, payload) };
	}

	private async begin(request: WorkflowMutationOptions, command: string, payload: string): Promise<WorkflowCommand> {
		const objectId = derivedId("workflow_command", request.clientRequestId);
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

	private aggregateRequestId(request: WorkflowMutationOptions): string {
		return derivedId("workflow_aggregate", request.clientRequestId);
	}

	private async recoverCommand(command: WorkflowCommand, eventType: WorkflowEventType): Promise<Workflow | undefined> {
		const stored = await readCommandResult<Workflow>(
			this.writer,
			COMMAND_OBJECT_TYPE,
			command.objectId,
			command.request.clientRequestId,
			command.command,
			command.payload,
		);
		if (stored !== undefined) return assertWorkflow(stored);
		const records = await this.session.findFoundationRecords({
			objectType: WORKFLOW_OBJECT_TYPE,
			kind: "fact",
			order: "oldestFirst",
			includePruned: true,
		});
		const aggregateRequestId = this.aggregateRequestId(command.request);
		const matched = [...records]
			.reverse()
			.find(
				(record): record is Extract<FoundationRecord, { kind: "fact" }> =>
					record.kind === "fact" && record.clientRequestId === aggregateRequestId,
			);
		if (matched === undefined) return undefined;
		const workflow = assertWorkflow(matched.payload);
		await this.writeEvent(command, workflow, eventType);
		return this.finish(command, workflow);
	}

	private async commit(command: WorkflowCommand, workflow: Workflow, eventType: WorkflowEventType): Promise<Workflow> {
		const checked = assertWorkflow(workflow);
		const accepted = await writeFact(
			this.writer,
			WORKFLOW_OBJECT_TYPE,
			checked.workflowId,
			jsonValue(checked, "workflow"),
			this.aggregateRequestId(command.request),
			command.request.expectedRevision,
		);
		const value = assertWorkflow(accepted.value);
		await this.writeEvent(command, value, eventType);
		return this.finish(command, value);
	}

	private async finish(command: WorkflowCommand, workflow: Workflow): Promise<Workflow> {
		return assertWorkflow(
			await writeCommandResult(
				this.writer,
				COMMAND_OBJECT_TYPE,
				command.objectId,
				command.request.clientRequestId,
				command.command,
				command.payload,
				workflow,
			),
		);
	}

	private async writeEvent(command: WorkflowCommand, workflow: Workflow, type: WorkflowEventType): Promise<void> {
		const event: WorkflowEvent = {
			schemaVersion: 1,
			eventId: derivedId("workflow_event", command.request.clientRequestId),
			type,
			workflowId: workflow.workflowId,
			revision: workflow.revision,
			timestamp: workflow.updatedAt,
			clientRequestId: command.request.clientRequestId,
			commandPayload: command.payload,
		};
		await writeFact(
			this.writer,
			EVENT_OBJECT_TYPE,
			`${workflow.workflowId}:${workflow.revision}`,
			jsonValue(event, "workflow event"),
			derivedId("workflow_event_request", command.request.clientRequestId),
			0,
		);
	}

	private async load(workflowId: string): Promise<Workflow> {
		const records = await recordsForObject(this.writer, WORKFLOW_OBJECT_TYPE, workflowId);
		const latest = records.at(-1);
		if (latest === undefined) fail("workflow_not_found", "Workflow was not found");
		if (latest.kind !== "fact")
			fail("foundation_schema_invalid_shape", "Workflow ledger contains an unsupported record");
		return clone(assertWorkflow(latest.payload));
	}

	private assertWorkflowState(workflow: Workflow, revision: number, statuses: readonly WorkflowStatus[]): void {
		if (workflow.revision !== revision) fail("session_writer_stale_revision", "Workflow revision is stale");
		if (!statuses.includes(workflow.status))
			fail("workflow_invalid_transition", `Workflow cannot transition from ${workflow.status}`);
	}

	private assertExecutorTransition(step: WorkflowStep, status: WorkflowStepStatus): void {
		if (step.type === "agent" && step.executor === "external" && status === "running")
			fail("workflow_invalid_transition", "External Agent step cannot claim running state");
		if (step.type === "agent" && step.executor === "local" && status === "awaiting_dispatch")
			fail("workflow_invalid_transition", "Local Agent step cannot await external dispatch");
		if (step.type !== "agent" && status === "awaiting_dispatch")
			fail("workflow_invalid_transition", "Only an external Agent step can await dispatch");
		if (step.type === "await_user" && (status === "running" || status === "awaiting_dispatch"))
			fail("workflow_invalid_transition", "AwaitUser step must enter waiting_user");
		if (step.type !== "await_user" && status === "waiting_user")
			fail("workflow_invalid_transition", "Only AwaitUser step can wait for user input");
	}

	private checkedBudget(value: Budget): Budget {
		const result = validateBudget(value);
		if (!result.ok) throw result.error;
		return clone(result.value);
	}

	private checkedUsage(value: BudgetUsage): BudgetUsage {
		const result = validateBudgetUsage(value);
		if (!result.ok) throw result.error;
		return clone(result.value);
	}

	private async safe<TValue>(fallbackCode: FoundationErrorCode, operation: () => Promise<TValue>): Promise<TValue> {
		try {
			return await operation();
		} catch (error) {
			throw asFoundationStoreError(error, fallbackCode);
		}
	}
}

export function createWorkflowStore(session: Session, options?: WorkflowStoreOptions): WorkflowStore {
	return new WorkflowStore(session, options);
}
