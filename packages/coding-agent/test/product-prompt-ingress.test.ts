import {
	AgentHarness,
	FoundationError,
	InMemorySessionStorage,
	Result,
	Session,
	SessionLedgerV1,
	sha256HexValue,
	type FoundationProviderExecutionOptionsV1,
	type FoundationJsonValue,
	type SandboxOperationProvider,
	type SandboxOperationRequestV1,
	type StreamFn,
	type ToolGateway,
} from "@aos-agent/agent-core";
import { NodeExecutionEnv } from "@aos-agent/agent-core/node";
import {
	createAssistantMessageEventStream,
	createModels,
	type AssistantMessage,
	type Context,
} from "@aos-agent/ai";
import { getModel } from "@aos-agent/ai/compat";
import { describe, expect, it } from "vitest";
import { ProductPromptIngressV1 } from "../src/core/product-prompt-ingress.ts";
import { createCodingAgentHarness } from "../src/server/create-harness.ts";

const MODEL = getModel("openai", "gpt-4o-mini");

function workerProvider(): SandboxOperationProvider {
	return {
		schemaVersion: 1,
		providerClass: "operation_worker",
		providerId: "test.operation-worker",
		capabilities: async () => [{ schemaVersion: 1, id: "tool_gateway", version: 1 }],
		start: async (request: SandboxOperationRequestV1, options: FoundationProviderExecutionOptionsV1 = {}) => {
			const correlation = options.correlation;
			if (correlation === undefined) return Result.err(new FoundationError("invalid_correlation", "test Worker requires correlation"));
			const { agentInstanceId: _agentInstanceId, ...workerCorrelation } = correlation;
			return Result.ok({
				schemaVersion: 1 as const,
				workerReceiptId: `worker-receipt-${request.operationId}`,
				sandboxProviderId: "test.operation-worker",
				operationId: request.operationId,
				taskId: request.taskId,
				dispatchId: request.dispatchId,
				attemptId: request.attemptId,
				status: "succeeded" as const,
				sideEffectState: "none" as const,
				provenance: { producerKind: "operation_worker" as const, providerId: "test.operation-worker", producedAt: "2026-08-21T00:00:00.000Z", correlation: workerCorrelation },
				startedAt: "2026-08-21T00:00:00.000Z",
				completedAt: "2026-08-21T00:00:01.000Z",
			});
		},
		cancel: async () => Result.ok(undefined),
		dispose: async () => {},
	};
}

function response(text: string): AssistantMessage {
	if (MODEL === undefined) throw new Error("Test model is unavailable");
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: MODEL.api,
		provider: MODEL.provider,
		model: MODEL.id,
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

describe("ProductPromptIngressV1", () => {
	it("uses one Harness and Goal while producing a replayable Task receipt chain per run", async () => {
		if (MODEL === undefined) throw new Error("Test model is unavailable");
		const session = new Session(new InMemorySessionStorage({ id: "product-prompt-ingress", createdAt: 1 }));
		const baseModels = createModels();
		const models = Object.create(baseModels) as typeof baseModels;
		const originalGetModel = baseModels.getModel.bind(baseModels);
		models.getModel = (provider, id) => provider === MODEL.provider && id === MODEL.id ? MODEL : originalGetModel(provider, id);
		const contexts: Context[] = [];
		let calls = 0;
		const streamFunction: StreamFn = (_model, context) => {
			contexts.push(structuredClone(context));
			calls += 1;
			const stream = createAssistantMessageEventStream();
			const message = response(`reply-${calls}`);
			queueMicrotask(() => {
				stream.push({ type: "start", partial: message });
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		};
		const created = await AgentHarness.create({ session, models, model: MODEL, drive: "automatic", streamFunction });
		const ingress = new ProductPromptIngressV1({
			session,
			harness: created.harness,
			models,
			cwd: "C:/workspace",
			currentModel: () => MODEL,
			currentThinkingLevel: () => "off",
			dependencySnapshot: (name, context): FoundationJsonValue => ({ name, runId: context.runId, state: "active" }),
			now: () => "2026-08-20T00:00:00.000Z",
		});

		try {
			const first = await ingress.execute({
				prompt: "first prompt",
				surface: "sdk",
				runId: "product-run-1",
				images: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }],
			});
			const second = await ingress.execute({ prompt: "second prompt", surface: "rpc", runId: "product-run-2" });
			const replay = await ingress.execute({
				prompt: "first prompt",
				surface: "sdk",
				runId: "product-run-1",
				images: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }],
			});
			expect(calls).toBe(2);
			expect(first.run.runId).toBe("product-run-1");
			expect(second.run.runId).toBe("product-run-2");
			expect(first.attemptReceipt.workerReceiptRefs).toEqual([]);
			expect(second.attemptReceipt.workerReceiptRefs).toEqual([]);
			expect(replay).toEqual(first);
			expect(contexts[0]?.messages[0]?.role).toBe("user");
			expect(contexts[0]?.messages[0]?.content).toEqual([
				{ type: "text", text: "first prompt" },
				{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
			]);

			const tasks = await session.findFoundationRecords({ kind: "fact", objectType: "task", order: "oldestFirst" });
			const attempts = await session.findFoundationRecords({ kind: "fact", objectType: "attempt", order: "oldestFirst" });
			const attemptReceipts = await session.findFoundationRecords({ kind: "fact", objectType: "attempt_receipt", order: "oldestFirst" });
			const taskResults = await session.findFoundationRecords({ kind: "fact", objectType: "task_result", order: "oldestFirst" });
			const runReceipts = await session.findFoundationRecords({ kind: "fact", objectType: "run_receipt", order: "oldestFirst" });
			expect(tasks).toHaveLength(2);
			expect(attempts).toHaveLength(2);
			expect(attemptReceipts).toHaveLength(2);
			expect(taskResults).toHaveLength(2);
			expect(runReceipts).toHaveLength(2);
			expect(new Set(tasks.map((record) => record.kind === "fact" && (record.payload as { goalId: string }).goalId))).toEqual(new Set([first.task.goalId]));
			await expect(ingress.execute({ prompt: "conflicting prompt", surface: "sdk", runId: "product-run-1" })).rejects.toMatchObject({ code: "session_ledger_conflict" });
			await expect(ingress.execute({ prompt: "first prompt", surface: "tui", runId: "product-run-1" })).rejects.toMatchObject({ code: "session_ledger_conflict" });
		} finally {
			await created.harness.close();
		}
	});

	it("persists the production sandbox ToolExecutionResult chain into Host Attempt, Task, and Run receipts", async () => {
		if (MODEL === undefined) throw new Error("Test model is unavailable");
		const runId = "product-run-worker-chain";
		const token = sha256HexValue(runId).slice(0, 32);
		const session = new Session(new InMemorySessionStorage({ id: "product-worker-chain", createdAt: 1 }));
		const baseModels = createModels();
		const models = Object.create(baseModels) as typeof baseModels;
		const originalGetModel = baseModels.getModel.bind(baseModels);
		models.getModel = (provider, id) => provider === MODEL.provider && id === MODEL.id ? MODEL : originalGetModel(provider, id);
		let gateway: ToolGateway | undefined;
		let gatewayResult: Awaited<ReturnType<ToolGateway["execute"]>> | undefined;
		let streamRuns = 0;
		const streamFunction: StreamFn = (_model, _context) => {
			const stream = createAssistantMessageEventStream();
			void (async () => {
				if (streamRuns++ === 0) {
					if (gateway === undefined) throw new Error("Worker gateway was not composed");
					const request = {
						schemaVersion: 1 as const,
						toolCallId: "worker-tool-call",
						toolName: "worker-read",
						originalArguments: { resource: "filesystem.read", operation: "file.read", path: "README.md" },
						context: {
							schemaVersion: 1 as const,
							operationId: `sandbox-operation-${token}`,
							bindingId: `binding_coding_agent_${token}`,
							bindingEpochId: `binding_epoch_coding_agent_${token}`,
							taskId: `task_coding_agent_${token}`,
							dispatchId: `dispatch_coding_agent_${token}`,
							attemptId: `attempt_coding_agent_${token}`,
							agentInstanceId: `agent_instance_coding_agent_${token}`,
						},
					};
					gatewayResult = await gateway.execute(request);
				}
				const message = response("worker-chain");
				stream.push({ type: "start", partial: message });
				stream.push({ type: "done", reason: "stop", message });
			})();
			return stream;
		};
		const env = new NodeExecutionEnv({ cwd: process.cwd() });
		const created = await createCodingAgentHarness({
			session,
			models,
			model: MODEL,
			env,
			drive: "automatic",
			streamFunction,
			workerSandbox: {
				provider: workerProvider(),
				routes: [{ kind: "sandbox", toolName: "worker-read", providerId: "test.operation-worker", revision: 1 }],
			},
		});
		if (!("operationToolGateway" in created)) throw new Error("Expected Worker ToolGateway composition");
		gateway = created.operationToolGateway;
		const ingress = new ProductPromptIngressV1({
			session,
			harness: created.harness,
			models,
			cwd: process.cwd(),
			currentModel: () => MODEL,
			currentThinkingLevel: () => "off",
			dependencySnapshot: (name, context): FoundationJsonValue => ({ name, runId: context.runId, state: "active" }),
			now: () => "2026-08-21T00:00:00.000Z",
		});
		try {
			const execution = await ingress.execute({ prompt: "worker chain", surface: "sdk", runId });
			if (gatewayResult !== undefined && !gatewayResult.ok) throw gatewayResult.error;
			expect(gatewayResult).toMatchObject({ ok: true, value: { toolReceiptRef: expect.any(String) } });
			expect(execution.attemptReceipt.workerReceiptRefs).toHaveLength(1);
			expect(execution.attemptReceipt.workerReceiptRefs[0]?.id).toBe(gatewayResult?.ok ? gatewayResult.value.toolReceiptRef : undefined);
			expect(execution.taskResult.sourceAttemptReceiptIds).toEqual([execution.attemptReceipt.attemptReceiptId]);
			expect(execution.taskResult.provenance.producerKind).toBe("host");
			expect(execution.runReceipt.terminalStatus).toBe("completed");
			expect(execution.runReceipt.taskResultId).toBe(execution.taskResult.taskResultId);
			expect(execution.runReceipt.attemptReceiptIds).toContain(execution.attemptReceipt.attemptReceiptId);
			expect(await session.findFoundationRecords({ kind: "fact", objectType: "worker_receipt" })).toHaveLength(1);
			const replay = await ingress.execute({ prompt: "worker chain", surface: "sdk", runId });
			expect(replay.attemptReceipt.workerReceiptRefs).toEqual(execution.attemptReceipt.workerReceiptRefs);
			const forgedRunId = "product-run-forged-worker-ref";
			const forgedToken = sha256HexValue(forgedRunId).slice(0, 32);
			const forgedTaskId = `task_coding_agent_${forgedToken}`;
			const forgedBindingId = `binding_coding_agent_${forgedToken}`;
			const forgedBindingEpochId = `binding_epoch_coding_agent_${forgedToken}`;
			const forgedDispatchId = `dispatch_coding_agent_${forgedToken}`;
			const forgedAttemptId = `attempt_coding_agent_${forgedToken}`;
			const forgedAgentInstanceId = `agent_instance_coding_agent_${forgedToken}`;
			const forgedOperationId = `sandbox-operation-${forgedToken}`;
			const ledger = new SessionLedgerV1(session, { writer: created.harness.t5.writer });
			await ledger.appendFact("worker_receipt", "bad-receipt", {
				schemaVersion: 1,
				workerReceiptId: "bad-receipt",
				sandboxProviderId: "wrong.operation-worker",
				operationId: forgedOperationId,
				taskId: forgedTaskId,
				dispatchId: forgedDispatchId,
				attemptId: forgedAttemptId,
				status: "succeeded",
				sideEffectState: "none",
				provenance: { producerKind: "operation_worker", providerId: "wrong.operation-worker", producedAt: "2026-08-21T00:00:00.000Z", correlation: { sessionId: "product-worker-chain", laneId: "main", revision: 0, runId: forgedRunId, operationId: forgedOperationId, providerId: "wrong.operation-worker", toolCallId: "forged-call", taskId: forgedTaskId, dispatchId: forgedDispatchId, attemptId: forgedAttemptId, bindingId: forgedBindingId, bindingEpochId: forgedBindingEpochId } },
				startedAt: "2026-08-21T00:00:00.000Z",
				completedAt: "2026-08-21T00:00:01.000Z",
			}, {
				clientRequestId: "worker-receipt:bad-receipt",
				expectedRevision: 0,
				correlation: { operationId: forgedOperationId, runId: forgedRunId, providerId: "wrong.operation-worker", toolCallId: "forged-call", taskId: forgedTaskId, dispatchId: forgedDispatchId, attemptId: forgedAttemptId, bindingId: forgedBindingId, bindingEpochId: forgedBindingEpochId, agentInstanceId: forgedAgentInstanceId },
			});
			await ledger.appendFact("coding_agent.worker_tool_execution", forgedOperationId, {
				schemaVersion: 1,
				type: "coding_agent.worker_tool_execution",
				id: forgedOperationId,
				revision: 1,
				sessionId: "product-worker-chain",
				laneId: "main",
				operationId: forgedOperationId,
				runId: forgedRunId,
				providerId: "test.operation-worker",
				taskId: forgedTaskId,
				dispatchId: forgedDispatchId,
				attemptId: forgedAttemptId,
				bindingId: forgedBindingId,
				bindingEpochId: forgedBindingEpochId,
				agentInstanceId: forgedAgentInstanceId,
				result: { schemaVersion: 1, toolCallId: "forged-call", toolName: "worker-read", ok: true, sideEffectState: "none", toolReceiptRef: "bad-receipt" },
			}, {
				clientRequestId: `worker-tool-execution:${forgedOperationId}`,
				expectedRevision: 0,
				correlation: { operationId: forgedOperationId, runId: forgedRunId, providerId: "test.operation-worker", toolCallId: "forged-call", taskId: forgedTaskId, dispatchId: forgedDispatchId, attemptId: forgedAttemptId, bindingId: forgedBindingId, bindingEpochId: forgedBindingEpochId, agentInstanceId: forgedAgentInstanceId },
			});
			await expect(ingress.execute({ prompt: "forged worker ref", surface: "sdk", runId: forgedRunId })).rejects.toMatchObject({ cause: { code: "worker_receipt_invalid_producer" } });
			expect(await session.getFoundationObject("attempt_receipt", `attempt_receipt_${forgedRunId}`)).toBeUndefined();
		} finally {
			await created.operationToolGateway.dispose();
			await created.harness.close();
			await env.cleanup();
		}
	});
});
