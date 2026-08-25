import { describe, expect, it } from "vitest";
import {
	parseWorkflowEvaluationSnapshot,
	runWorkflowEvaluation,
	serializeWorkflowEvaluationSnapshot,
	type WorkflowEvaluationDataset,
	type WorkflowStatus,
	type Workflow,
} from "../../src/harness/foundation/workflow.ts";

function workflow(workflowId: string, status: WorkflowStatus, revision: number): Workflow {
	const contract = { schemaVersion: 1 as const, contractId: "none", kind: "none" as const, required: false };
	return {
		schemaVersion: 1,
		dslVersion: 1,
		sessionId: "session-evaluation",
		workflowId,
		revision,
		status,
		steps: [
			{
				schemaVersion: 1,
				type: "tool",
				stepId: "execute",
				ordinal: 0,
				revision,
				status: status === "completed" ? "succeeded" : "ready",
				input: [contract],
				output: [contract],
				toolName: "read",
			},
			{
				schemaVersion: 1,
				type: "acceptance",
				stepId: "accept",
				ordinal: 1,
				revision,
				status: status === "completed" ? "succeeded" : "pending",
				input: [contract],
				output: [contract],
				dependsOn: ["execute"],
				criterionIds: ["criterion-1"],
			},
		],
		createdAt: "2026-08-20T00:00:00.000Z",
		updatedAt: "2026-08-20T00:00:00.000Z",
	};
}

function dataset(): WorkflowEvaluationDataset {
	return {
		schemaVersion: 1,
		datasetId: "foundation-local",
		revision: 3,
		cases: [
			{
				schemaVersion: 1,
				caseId: "ordinary",
				workflow: workflow("workflow-ordinary", "active", 1),
				expectedStatus: "completed",
				expectedSteps: [
					{ stepId: "execute", status: "succeeded" },
					{ stepId: "accept", status: "succeeded" },
				],
				maxCost: 2,
				requireRecovery: false,
			},
			{
				schemaVersion: 1,
				caseId: "recovery",
				workflow: workflow("workflow-recovery", "active", 1),
				expectedStatus: "completed",
				expectedSteps: [{ stepId: "accept", status: "succeeded" }],
				maxCost: 1,
				requireRecovery: true,
			},
		],
	};
}

describe("T12 workflow evaluation", () => {
	it("produces a deterministic quality, cost, and recovery regression snapshot", () => {
		const evaluated = runWorkflowEvaluation({
			dataset: dataset(),
			observations: [
				{ caseId: "ordinary", workflow: workflow("workflow-ordinary", "completed", 2), cost: 1.5, recovered: false },
				{ caseId: "recovery", workflow: workflow("workflow-recovery", "active", 2), cost: 1.25, recovered: false },
			],
			runId: "evaluation-run-1",
			createdAt: "2026-08-20T01:00:00.000Z",
		});

		expect(evaluated.ok).toBe(true);
		if (!evaluated.ok) return;
		expect(evaluated.value.cases).toEqual([
			expect.objectContaining({ caseId: "ordinary", qualityPassed: true, costPassed: true, recoveryPassed: true, passed: true, failures: [] }),
			expect.objectContaining({ caseId: "recovery", qualityPassed: false, costPassed: false, recoveryPassed: false, passed: false, failures: ["workflow_status", "step_status:accept", "cost", "recovery"] }),
		]);
		expect(evaluated.value.summary).toEqual({
			total: 2,
			passed: 1,
			qualityFailures: 1,
			costFailures: 1,
			recoveryFailures: 1,
		});
	});

	it("round-trips result snapshots through the strict persistence shape", () => {
		const evaluated = runWorkflowEvaluation({
			dataset: { ...dataset(), cases: [dataset().cases[0]!] },
			observations: [
				{ caseId: "ordinary", workflow: workflow("workflow-ordinary", "completed", 2), cost: 1, recovered: false },
			],
			runId: "evaluation-run-2",
			createdAt: "2026-08-20T02:00:00.000Z",
		});
		if (!evaluated.ok) throw evaluated.error;

		const serialized = serializeWorkflowEvaluationSnapshot(evaluated.value);
		expect(parseWorkflowEvaluationSnapshot(serialized)).toEqual(evaluated);
		expect(parseWorkflowEvaluationSnapshot(serialized.replace('"passed":true', '"passed":true,"extra":true'))).toMatchObject({
			ok: false,
		});
	});

	it("rejects incomplete observations and invalid dataset expectations", () => {
		const missing = runWorkflowEvaluation({
			dataset: dataset(),
			observations: [],
			runId: "evaluation-run-3",
			createdAt: "2026-08-20T03:00:00.000Z",
		});
		expect(missing).toMatchObject({ ok: false, error: { code: "structure_schema_invalid" } });

		const invalidCase = dataset().cases[0]!;
		const invalid = runWorkflowEvaluation({
			dataset: {
				...dataset(),
				cases: [{ ...invalidCase, expectedSteps: [{ stepId: "missing", status: "succeeded" }] }],
			},
			observations: [
				{ caseId: "ordinary", workflow: workflow("workflow-ordinary", "completed", 2), cost: 1, recovered: false },
			],
			runId: "evaluation-run-4",
			createdAt: "2026-08-20T04:00:00.000Z",
		});
		expect(invalid).toMatchObject({ ok: false, error: { code: "structure_schema_invalid" } });
	});
});
