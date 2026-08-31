import { describe, expect, it } from "vitest";
import { FoundationError } from "../../src/harness/foundation/errors.ts";
import type { FoundationJsonValue } from "../../src/harness/foundation/event-catalog.ts";
import {
	validateWorkflow,
	WORKFLOW_STEP_STATUSES,
	WORKFLOW_STEP_TYPES,
	WorkflowMigrationRegistry,
	type WorkflowStep,
} from "../../../coding-agent/src/core/orchestration/workflow.ts";
import { WorkflowStore } from "../../../coding-agent/src/core/orchestration/workflow-store.ts";
import type { ProvisionedFoundationRecord } from "../../src/harness/session/durable/types.ts";
import { InMemorySessionStorage, Session } from "../../src/harness/session/index.ts";

function createStore(id: string): { readonly session: Session; readonly store: WorkflowStore } {
	const session = new Session(new InMemorySessionStorage({ id, createdAt: 1 }));
	return { session, store: new WorkflowStore(session) };
}

function options(
	clientRequestId: string,
	expectedRevision: number,
): { readonly clientRequestId: string; readonly expectedRevision: number } {
	return { clientRequestId, expectedRevision };
}

function contract(contractId: string) {
	return { schemaVersion: 1 as const, contractId, kind: "json" as const, required: true };
}

function baseStep(stepId: string, ordinal: number) {
	return {
		schemaVersion: 1 as const,
		stepId,
		ordinal,
		revision: 1,
		status: "pending" as const,
		input: [contract(`${stepId}-input`)],
		output: [contract(`${stepId}-output`)],
	};
}

function allSteps(): WorkflowStep[] {
	return [
		{
			...baseStep("local-agent", 0),
			type: "agent",
			taskId: "task-local",
			roleRevision: { schemaVersion: 1, type: "role_revision", id: "role-local", revision: 1 },
			executor: "local",
		},
		{
			...baseStep("external-agent", 1),
			type: "agent",
			taskId: "task-external",
			roleRevision: { schemaVersion: 1, type: "role_revision", id: "role-external", revision: 2 },
			executor: "external",
		},
		{ ...baseStep("tool", 2), type: "tool", toolName: "read" },
		{
			...baseStep("parallel", 3),
			type: "parallel",
			intents: [
				{ schemaVersion: 1, intentId: "intent-local", stepId: "local-agent", executor: "local" },
				{ schemaVersion: 1, intentId: "intent-external", stepId: "external-agent", executor: "external" },
			],
		},
		{ ...baseStep("gate", 4), type: "gate", gateId: "gate-1" },
		{ ...baseStep("await-user", 5), type: "await_user", askId: "ask-1" },
		{ ...baseStep("barrier", 6), type: "barrier", barrierId: "barrier-1" },
		{ ...baseStep("acceptance", 7), type: "acceptance", criterionIds: ["criterion-1"] },
	];
}

async function createWorkflow(
	store: WorkflowStore,
	requestId: string,
	workflowId = `workflow-${requestId}`,
	steps = allSteps(),
) {
	const sessionId = (await store.session.getMetadata()).id;
	return store.create({ sessionId, workflowId, goalId: "goal-1", planId: "plan-1", steps }, options(requestId, 0));
}

function injectAppendFault(
	session: Session,
	predicate: (record: ProvisionedFoundationRecord) => boolean,
	phase: "before" | "after",
): () => void {
	const original = session.appendFoundationRecord.bind(session);
	let injected = false;
	session.appendFoundationRecord = async (record) => {
		if (!injected && phase === "before" && predicate(record)) {
			injected = true;
			throw new FoundationError("session_ledger_storage", "injected WorkflowStore crash");
		}
		const accepted = await original(record);
		if (!injected && phase === "after" && predicate(record)) {
			injected = true;
			throw new FoundationError("session_ledger_storage", "injected WorkflowStore crash");
		}
		return accepted;
	};
	return () => {
		session.appendFoundationRecord = original;
	};
}

describe("Workflow V1 DSL and durable store", () => {
	it("freezes the exact statuses, unified step kinds, contracts, and migration path", async () => {
		expect(WORKFLOW_STEP_STATUSES).toEqual([
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
		]);
		expect(WORKFLOW_STEP_TYPES).toEqual([
			"agent",
			"tool",
			"parallel",
			"gate",
			"await_user",
			"barrier",
			"acceptance",
		]);
		const { store } = createStore("workflow-shape");
		const workflow = await createWorkflow(store, "create");
		expect(new Set(workflow.steps.map((step) => step.type))).toEqual(new Set(WORKFLOW_STEP_TYPES));
		expect(workflow.steps.every((step) => step.input.length === 1 && step.output.length === 1)).toBe(true);
		expect(validateWorkflow(workflow).ok).toBe(true);
		expect(validateWorkflow({ ...workflow, dslVersion: 2 }).ok).toBe(false);
		expect(validateWorkflow({ ...workflow, steps: [{ ...workflow.steps[0]!, input: [] }] }).ok).toBe(false);
		expect(validateWorkflow({ ...workflow, steps: [{ ...workflow.steps[2]!, status: "awaiting_dispatch" }] }).ok).toBe(false);

		const registry = new WorkflowMigrationRegistry();
		registry.register(0, 1, (value) =>
			value !== null && typeof value === "object" && !Array.isArray(value) ? { ...value, dslVersion: 1 } : value,
		);
		const legacy = JSON.parse(JSON.stringify({ ...workflow, dslVersion: 0 })) as FoundationJsonValue;
		expect(registry.migrate(legacy).ok).toBe(true);
		expect(() => registry.register(0, 1, (value) => value)).toThrowError(FoundationError);
	});

	it("uses awaiting_dispatch for external Agents and never lets them claim running", async () => {
		const { store } = createStore("workflow-external");
		let workflow = await createWorkflow(store, "create");
		workflow = await store.activate(workflow.workflowId, options("activate", 1));
		workflow = await store.transitionStep(
			workflow.workflowId,
			{ stepId: "external-agent", status: "ready" },
			options("external-ready", 2),
		);
		await expect(
			store.transitionStep(
				workflow.workflowId,
				{ stepId: "external-agent", status: "running" },
				options("external-running", 3),
			),
		).rejects.toMatchObject({ code: "workflow_invalid_transition" });
		workflow = await store.transitionStep(
			workflow.workflowId,
			{ stepId: "external-agent", status: "awaiting_dispatch" },
			options("external-dispatch", 3),
		);
		expect(workflow.steps.find((step) => step.stepId === "external-agent")?.status).toBe("awaiting_dispatch");

		workflow = await store.transitionStep(
			workflow.workflowId,
			{ stepId: "local-agent", status: "ready" },
			options("local-ready", 4),
		);
		await expect(
			store.transitionStep(
				workflow.workflowId,
				{ stepId: "local-agent", status: "awaiting_dispatch" },
				options("local-dispatch", 5),
			),
		).rejects.toMatchObject({ code: "workflow_invalid_transition" });
		expect((await store.get(workflow.workflowId)).revision).toBe(5);
	});

	it("persists pause and stop without a scheduler or automatic restart", async () => {
		const { session, store } = createStore("workflow-lifecycle");
		let workflow = await createWorkflow(store, "create", "workflow-lifecycle", [
			{ ...baseStep("tool", 0), type: "tool", toolName: "read" },
		]);
		workflow = await store.activate(workflow.workflowId, options("activate", 1));
		workflow = await store.transitionStep(
			workflow.workflowId,
			{ stepId: "tool", status: "ready" },
			options("ready", 2),
		);
		workflow = await store.transitionStep(
			workflow.workflowId,
			{ stepId: "tool", status: "running" },
			options("running", 3),
		);
		workflow = await store.pause(workflow.workflowId, options("pause", 4));
		expect(workflow).toMatchObject({ status: "paused", revision: 5, steps: [{ status: "running" }] });

		const reopened = new WorkflowStore(session);
		expect(await reopened.get(workflow.workflowId)).toEqual(workflow);
		await expect(
			reopened.transitionStep(
				workflow.workflowId,
				{ stepId: "tool", status: "succeeded" },
				options("paused-step", 5),
			),
		).rejects.toMatchObject({ code: "workflow_invalid_transition" });
		workflow = await reopened.stop(workflow.workflowId, options("stop", 5));
		expect(workflow).toMatchObject({ status: "stopped", revision: 6, steps: [{ status: "cancelled", revision: 4 }] });
		await expect(reopened.resume(workflow.workflowId, options("restart", 6))).rejects.toMatchObject({
			code: "workflow_invalid_transition",
		});
	});

	it("records budget usage durably and rejects an over-budget fact before mutation", async () => {
		const { store } = createStore("workflow-budget");
		let workflow = await createWorkflow(store, "create", "workflow-budget", [
			{ ...baseStep("tool", 0), type: "tool", toolName: "read" },
		]);
		workflow = await store.setBudget(workflow.workflowId, { tokens: 10, toolCalls: 1 }, options("budget", 1));
		workflow = await store.recordBudgetUsage(workflow.workflowId, { tokens: 7, toolCalls: 1 }, options("usage", 2));
		expect(workflow).toMatchObject({ revision: 3, budgetUsage: { tokens: 7, toolCalls: 1 } });
		await expect(
			store.recordBudgetUsage(workflow.workflowId, { tokens: 4 }, options("over", 3)),
		).rejects.toMatchObject({ code: "budget_exhausted" });
		expect((await store.get(workflow.workflowId)).revision).toBe(3);
	});

	it("recovers after command intent and aggregate CAS and preserves idempotency", async () => {
		const { session, store } = createStore("workflow-recovery");
		const restoreIntent = injectAppendFault(
			session,
			(record) => record.kind === "fact" && record.objectType === "foundation.workflow",
			"before",
		);
		await expect(
			createWorkflow(store, "create", "workflow-recovery", [
				{ ...baseStep("tool", 0), type: "tool", toolName: "read" },
			]),
		).rejects.toMatchObject({ code: "session_ledger_storage" });
		restoreIntent();
		let workflow = await createWorkflow(store, "create", "workflow-recovery", [
			{ ...baseStep("tool", 0), type: "tool", toolName: "read" },
		]);

		const restoreEvent = injectAppendFault(
			session,
			(record) => record.kind === "fact" && record.objectType === "foundation.workflow.event",
			"after",
		);
		await expect(store.activate(workflow.workflowId, options("activate", 1))).rejects.toMatchObject({
			code: "session_ledger_storage",
		});
		restoreEvent();
		workflow = await store.activate(workflow.workflowId, options("activate", 1));
		expect(workflow).toMatchObject({ status: "active", revision: 2 });
		expect(await store.activate(workflow.workflowId, options("activate", 1))).toEqual(workflow);
		expect(await store.eventsFor(workflow.workflowId)).toHaveLength(2);
	});

	it("enforces aggregate CAS and requires settled steps before completion", async () => {
		const { store } = createStore("workflow-cas");
		let workflow = await createWorkflow(store, "create", "workflow-cas", [
			{ ...baseStep("tool", 0), type: "tool", toolName: "read" },
		]);
		workflow = await store.activate(workflow.workflowId, options("activate", 1));
		const outcomes = await Promise.allSettled([
			store.pause(workflow.workflowId, options("pause-left", 2)),
			store.stop(workflow.workflowId, options("stop-right", 2)),
		]);
		expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
		expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);

		const { store: completionStore } = createStore("workflow-complete");
		let completed = await createWorkflow(completionStore, "create-complete", "workflow-complete", [
			{ ...baseStep("tool", 0), type: "tool", toolName: "read" },
		]);
		completed = await completionStore.activate(completed.workflowId, options("activate-complete", 1));
		await expect(completionStore.complete(completed.workflowId, options("complete-early", 2))).rejects.toMatchObject({
			code: "workflow_invalid_transition",
		});
		completed = await completionStore.transitionStep(
			completed.workflowId,
			{ stepId: "tool", status: "ready" },
			options("ready-complete", 2),
		);
		completed = await completionStore.transitionStep(
			completed.workflowId,
			{ stepId: "tool", status: "running" },
			options("running-complete", 3),
		);
		completed = await completionStore.transitionStep(
			completed.workflowId,
			{ stepId: "tool", status: "succeeded" },
			options("succeed-complete", 4),
		);
		completed = await completionStore.complete(completed.workflowId, options("complete", 5));
		expect(completed).toMatchObject({ status: "completed", revision: 6 });
	});
});
