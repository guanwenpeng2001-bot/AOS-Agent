import { describe, expect, it } from "vitest";
import { InMemoryArtifactBlobStore, SessionArtifactStore } from "../../src/harness/artifacts.ts";
import {
	aggregateTaskResultProducers,
	TASK_RESULT_SUMMARY_MAX_LENGTH,
	writeTaskResultArtifact,
	type DurableTaskResultToolRecord,
} from "../../src/harness/result-producers.ts";
import {
	createHostTerminalGateAuthority,
	finalizeRunReceipt,
	parseRunReceipt,
	parseTaskResult,
	serializeRunReceipt,
	serializeTaskResult,
	settleTaskResult,
	type AttemptReceipt,
} from "../../src/harness/foundation/results.ts";
import type { TaskEnvelope } from "../../src/harness/foundation/task.ts";
import { InMemorySessionStorage, Session } from "../../src/harness/session/index.ts";

const NOW = "2026-09-01T00:00:00.000Z";

function durableTool(
	toolCallId: string,
	toolName: string,
	arguments_: DurableTaskResultToolRecord["arguments"],
	overrides: Partial<Pick<DurableTaskResultToolRecord, "outcome" | "sideEffectState" | "artifacts" | "result">> = {},
): DurableTaskResultToolRecord {
	return {
		toolCallId,
		toolName,
		arguments: arguments_,
		outcome: overrides.outcome ?? "succeeded",
		sideEffectState: overrides.sideEffectState ?? "none",
		artifacts: overrides.artifacts ?? [],
		...(overrides.result === undefined ? {} : { result: overrides.result }),
		source: {
			objectType: "tool_receipt",
			objectId: `receipt-${toolCallId}`,
			revision: 1,
			digest: toolCallId.padEnd(64, "a").slice(0, 64),
		},
	};
}

function task(): TaskEnvelope {
	return {
		schemaVersion: 1,
		taskId: "task-result-producers",
		goalId: "goal-result-producers",
		goal: "produce durable task results",
		workspace: "workspace:test",
		capabilityRefs: [],
		inputs: [],
		expectedOutputs: [],
		budget: {},
		acceptanceCriteria: [],
		status: "ready",
		createdAt: NOW,
		updatedAt: NOW,
	};
}

function attemptReceipt(): AttemptReceipt {
	return {
		schemaVersion: 1,
		attemptReceiptId: "attempt-receipt-result-producers",
		taskId: "task-result-producers",
		dispatchId: "dispatch-result-producers",
		attemptId: "attempt-result-producers",
		providerId: "fake-provider",
		agentInstanceId: "agent-result-producers",
		bindingId: "binding-result-producers",
		bindingEpochIds: ["epoch-result-producers"],
		status: "succeeded",
		workerReceiptRefs: [],
		artifacts: [],
		provenance: {
			producerKind: "agent_executor",
			providerId: "fake-provider",
			producedAt: NOW,
			correlation: {
				sessionId: "session-result-producers",
				laneId: "main",
				runId: "run-result-producers",
				operationId: "run-result-producers",
				taskId: "task-result-producers",
				dispatchId: "dispatch-result-producers",
				attemptId: "attempt-result-producers",
				bindingId: "binding-result-producers",
				bindingEpochId: "epoch-result-producers",
				agentInstanceId: "agent-result-producers",
				attemptReceiptId: "attempt-receipt-result-producers",
				revision: 0,
			},
		},
		sideEffectState: "none",
	};
}

describe("durable TaskResult producers", () => {
	it("projects validation outcomes and file changes only from fake durable tool records", async () => {
		const session = new Session(new InMemorySessionStorage({ id: "result-producer-artifacts", createdAt: 1 }));
		const store = new SessionArtifactStore(session, { blobStore: new InMemoryArtifactBlobStore() });
		const durableTools = [
			durableTool("check-pass", "bash", { command: "npm run check" }, {
				result: { schemaVersion: 1, content: [{ type: "text", text: "all checks passed" }] },
			}),
			durableTool("test-fail", "bash", { command: "./test.sh" }, {
				outcome: "failed",
			}),
			durableTool("inspect", "bash", { command: "git status --short" }, {
				result: { schemaVersion: 1, content: [{ type: "text", text: "clean" }] },
			}),
			durableTool("write-file", "write", { path: "src/result.ts", content: "export const result = true;\n" }, {
				result: { schemaVersion: 1, content: [{ type: "text", text: "written" }] },
			}),
			durableTool("edit-file", "edit", { path: "src/result.ts", edits: [] }, {
				result: {
					schemaVersion: 1,
					content: [{ type: "text", text: "edited" }],
					details: { patch: "--- a/src/result.ts\n+++ b/src/result.ts\n@@ -1 +1 @@\n-false\n+true\n" },
				},
			}),
		];

		const produced = await aggregateTaskResultProducers({
			finalAssistantText: "Implemented durable result producers.",
			durableTools,
			writeArtifact: (input) => writeTaskResultArtifact(store, input),
		});

		expect(produced.summary).toBe("Implemented durable result producers.");
		expect(produced.tests).toHaveLength(2);
		expect(produced.tests).toEqual([
			expect.objectContaining({ name: "npm run check", required: true, status: "passed" }),
			expect.objectContaining({ name: "./test.sh", required: true, status: "failed" }),
		]);
		expect(produced.tests.every((test) => test.evidenceRefs?.length === 1)).toBe(true);
		expect(produced.diff).toMatchObject({
			mediaType: "application/json",
			producer: "task-result-producer:durable-workspace-diff",
		});
		expect(produced.artifacts).toHaveLength(5);
		expect(produced.artifacts).toContainEqual(produced.diff);
		for (const artifact of produced.artifacts) {
			expect(artifact.digest).toBe(`sha256:${artifact.artifactId}`);
			expect(await store.verify(artifact.artifactId)).toBe("verified");
		}
		if (produced.diff === undefined) throw new Error("Expected durable workspace diff");
		const diff = await store.get(produced.diff.artifactId);
		expect(new TextDecoder().decode(diff.content)).toContain('"type":"workspace_diff"');
		expect(new TextDecoder().decode(diff.content)).toContain('"objectId":"receipt-edit-file"');
	});

	it("keeps empty truth arrays and derives a bounded redacted non-placeholder summary", async () => {
		const produced = await aggregateTaskResultProducers({
			finalAssistantText: `I ran npm run check and wrote src/claimed.ts. token=secret-value ${"x".repeat(TASK_RESULT_SUMMARY_MAX_LENGTH * 2)}`,
		});

		expect(produced.artifacts).toEqual([]);
		expect(produced.diff).toBeUndefined();
		expect(produced.tests).toEqual([]);
		expect(produced.summary).not.toMatch(/Agent run (completed|did not complete)/);
		expect(produced.summary).toContain("[redacted]");
		expect(produced.summary.length).toBeLessThanOrEqual(TASK_RESULT_SUMMARY_MAX_LENGTH);
	});

	it("round-trips the existing TaskResult and RunReceipt shapes", async () => {
		const receipt = attemptReceipt();
		const produced = await aggregateTaskResultProducers({
			finalAssistantText: "Durable execution completed.",
			attemptReceipt: receipt,
		});
		const settled = settleTaskResult({
			taskResultId: "task-result-result-producers",
			task: task(),
			receipts: [receipt],
			summary: produced.summary,
			artifacts: produced.artifacts,
			tests: produced.tests,
			evidence: [],
			producer: {
				producerKind: "host",
				providerId: "host-result-producers",
				producedAt: NOW,
				correlation: {
					sessionId: "session-result-producers",
					laneId: "main",
					taskId: "task-result-producers",
					taskResultId: "task-result-result-producers",
					revision: 0,
				},
			},
		});
		if (!settled.ok) throw settled.error;
		const replayedTask = parseTaskResult(serializeTaskResult(settled.value));
		expect(replayedTask).toEqual({ ok: true, value: settled.value });

		const run = finalizeRunReceipt({
			runReceiptId: "run-receipt-result-producers",
			runId: "run-result-producers",
			terminalStatus: "completed",
			authority: createHostTerminalGateAuthority("host-result-producers"),
			taskResult: settled.value,
			attemptReceiptIds: [receipt.attemptReceiptId],
			usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
			completedAt: NOW,
		});
		if (!run.ok) throw run.error;
		const replayedRun = parseRunReceipt(serializeRunReceipt(run.value));
		expect(replayedRun).toEqual({ ok: true, value: run.value });
	});
});
