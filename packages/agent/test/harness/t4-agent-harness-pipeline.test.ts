import { createAssistantMessageEventStream, type AssistantMessage, type Model, type Models } from "@aos-agent/ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { AgentHarness, type AgentHarnessFoundationExecution, type HarnessTool } from "../../src/harness/agent-harness.ts";
import { fingerprintFoundationValue, createHostTerminalGateAuthorityV1 } from "../../src/harness/foundation/index.ts";
import { FoundationToolGuardV1, FoundationToolPipelineV1, SessionToolPipelineStorageV1, validateToolIntentV1, type ToolDefinitionRegistryV1, type ToolPipelineContextV1 } from "../../src/harness/tool-pipeline.ts";
import { createExecutionCorrelation } from "../../src/harness/foundation/identity.ts";
import { Result } from "../../src/harness/result.ts";
import { InMemorySessionStorage, Session } from "../../src/harness/session/index.ts";

function execution(): AgentHarnessFoundationExecution {
	const taskId = "task-public-tool";
	const bindingCore = {
		schemaVersion: 1 as const,
		bindingId: "binding-public-tool",
		taskId,
		roleRevision: { schemaVersion: 1 as const, type: "role_revision", id: "role", revision: 1 },
		modelProfileRevision: { schemaVersion: 1 as const, type: "model_profile_revision", id: "model", revision: 1 },
		modelRoute: { provider: "openai", model: "tool-model" },
		contextRevision: { schemaVersion: 1 as const, type: "context_revision", id: "context", revision: 1 },
		capabilityRevision: { schemaVersion: 1 as const, type: "capability_revision", id: "capability", revision: 1 },
		policyRevision: { schemaVersion: 1 as const, type: "policy_revision", id: "policy", revision: 1 },
		capabilitySelector: { policy: "all" as const },
		budget: {},
		sourceTrace: [],
		conflicts: [],
		resolvedAt: "2026-01-01T00:00:00.000Z",
	};
	return {
		task: { schemaVersion: 1, taskId, goalId: "goal-public-tool", goal: "run public tool", workspace: "workspace:test", capabilityRefs: [], inputs: [], expectedOutputs: [], budget: {}, acceptanceCriteria: [], status: "ready", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" },
		dispatch: { schemaVersion: 1, dispatchId: "dispatch-public-tool", taskId, bindingId: bindingCore.bindingId, taskExecutorProviderId: "agent-provider", status: "pending", createdAt: "2026-01-01T00:00:00.000Z" },
		binding: { ...bindingCore, fingerprint: fingerprintFoundationValue(bindingCore) },
		providerId: "agent-provider",
		agentInstanceId: "agent-public-tool",
		bindingEpochIds: ["epoch-public-tool"],
		settlement: { tests: [], evidence: [] },
		hostAuthority: createHostTerminalGateAuthorityV1("host-public-tool"),
	};
}

function allowAllGuards(): FoundationToolGuardV1 {
	const reference = (type: string) => ({ schemaVersion: 1 as const, type, id: type, revision: 1 });
	const allow = (type: string) => () => Result.ok({ allowed: true, reference: reference(type) });
	return new FoundationToolGuardV1({ capability: { check: allow("capability") }, policy: { check: allow("policy") }, approval: { check: allow("approval") }, sandbox: { check: allow("sandbox") }, quota: { check: allow("quota") }, conflictLock: { check: allow("conflict_lock") } });
}

describe("T4 public AgentHarness tool consumer", () => {
	it("routes a public AgentTool through the durable pipeline and replays it after a harness restart", async () => {
		const session = new Session(new InMemorySessionStorage({ id: "public-tool-session", createdAt: 1 }));
		const model = { id: "tool-model", name: "Tool Model", api: "openai-responses" as const, provider: "openai" as const, baseUrl: "", reasoning: false, input: ["text"] as ("text")[], cost: { input: 0, output: 0 }, contextWindow: 1000, maxTokens: 1000 } as Model<"openai-responses">;
		let requests = 0;
		const models = {
			getModel: () => model,
			streamSimple: () => {
				const stream = createAssistantMessageEventStream();
				requests += 1;
				const message: AssistantMessage = requests === 1
					? { role: "assistant", content: [{ type: "toolCall", id: "call-public-tool", name: "write", arguments: { value: "x" } }], api: model.api, provider: model.provider, model: model.id, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: Date.now() }
					: { role: "assistant", content: [{ type: "text", text: "done" }], api: model.api, provider: model.provider, model: model.id, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() };
				stream.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message });
				return stream;
			},
		} as unknown as Models;
		let sideEffects = 0;
		const write: HarnessTool = { name: "write", label: "Write", description: "write", parameters: Type.Object({ value: Type.String() }, { additionalProperties: false }), execute: async () => { sideEffects += 1; return { content: [{ type: "text", text: "written" }], details: {} }; } };
		const foundation = execution();
		const { harness } = await AgentHarness.create({ session, models, model, tools: [write], foundationExecution: foundation, toolPipelineOptions: { guard: allowAllGuards() } });
		const result = await harness.prompt("invoke write");
		expect(result.ok).toBe(true);
		expect(sideEffects).toBe(1);
		const intents = await session.findFoundationRecords({ kind: "intent", objectType: "tool_intent", order: "oldestFirst" });
		const receipts = await session.findFoundationRecords({ kind: "fact", objectType: "tool_receipt", order: "oldestFirst" });
		expect(intents).toHaveLength(1);
		expect(receipts).toHaveLength(1);
		const intentRecord = intents[0];
		if (intentRecord?.kind !== "intent" || intentRecord.payload === undefined) throw new Error("missing public tool intent");
		const checkedIntent = validateToolIntentV1(intentRecord.payload);
		if (!checkedIntent.ok) throw checkedIntent.error;
		if (checkedIntent.value.idempotencyKey === undefined) throw new Error("public tool did not derive an idempotency key");
		const operation = (await session.findRecords({ lane: "main", type: "operation_started", order: "oldestFirst" }))[0];
		if (operation?.type !== "operation_started") throw new Error("missing public tool operation");
		const started = (await session.findRecords({ lane: "main", runId: operation.id, type: "tool_started", order: "oldestFirst" }))[0];
		if (started?.type !== "tool_started") throw new Error("missing public tool start");
		const attempt = (await session.findRecords({ lane: "main", runId: operation.id, type: "step_attempt", order: "oldestFirst" })).find((candidate) => candidate.type === "step_attempt" && candidate.resultEntryId === started.assistantEntryId);
		if (attempt?.type !== "step_attempt") throw new Error("missing public tool attempt");
		await harness.close();
		const restarted = await AgentHarness.create({ session, models, model, tools: [write], foundationExecution: foundation, toolPipelineOptions: { guard: allowAllGuards() } });
		await restarted.harness.close();
		const lease = await session.acquireWriterLease({ ownerId: "public-tool-replay" });
		const replayContext: ToolPipelineContextV1 = {
			sessionId: "public-tool-session",
			laneId: "main",
			runId: operation.id,
			operationId: operation.id,
			binding: foundation.binding,
			bindingEpoch: { schemaVersion: 1, bindingEpochId: foundation.bindingEpochIds[0]!, taskId: foundation.task.taskId, attemptId: attempt.id, bindingId: foundation.binding.bindingId, ordinal: 0, activationReason: "attempt_started", activatedByCommandId: foundation.dispatch.dispatchId, activatedAt: foundation.task.updatedAt, agentInstanceId: foundation.agentInstanceId },
			taskId: foundation.task.taskId,
			dispatchId: foundation.dispatch.dispatchId,
			providerId: foundation.providerId,
			attemptId: attempt.id,
			attempt: attempt.attempt,
			agentInstanceId: foundation.agentInstanceId,
			workspace: foundation.task.workspace,
		};
		const replayStorage = new SessionToolPipelineStorageV1({
			ledger: session,
			laneId: "main",
			correlationFor: (_kind, value) => createExecutionCorrelation(value.binding.sessionId!, value.binding.laneId!, {
				bindingId: value.binding.bindingId,
				bindingEpochId: value.binding.bindingEpochId,
				taskId: value.binding.taskId,
				dispatchId: value.binding.dispatchId,
				runId: value.binding.runId,
				operationId: value.binding.operationId,
				attemptId: value.binding.attemptId,
				providerId: value.binding.providerId,
				agentInstanceId: value.binding.agentInstanceId,
				toolCallId: value.toolCallId,
			}),
			fencingToken: () => lease.fencingToken,
		});
		const replayRegistry: ToolDefinitionRegistryV1 = {
			resolve: () => Result.ok({ name: "write", toolRevision: { schemaVersion: 1, type: "tool_revision", id: "tool:write", revision: 1 }, capabilities: [], parameters: Type.Object({ value: Type.String() }, { additionalProperties: false }), execute: async () => { sideEffects += 1; return { ok: true, sideEffectState: "none" }; } }),
		};
		const replayPipeline = new FoundationToolPipelineV1({ registry: replayRegistry, storage: replayStorage, guard: allowAllGuards() });
		const replay = await replayPipeline.execute({ toolCallId: checkedIntent.value.toolCallId, toolName: checkedIntent.value.toolName, idempotencyKey: checkedIntent.value.idempotencyKey, attempt: checkedIntent.value.attempt, args: { value: "x" } }, replayContext);
		expect(replay).toMatchObject({ ok: true, value: { deduplicatedFrom: expect.any(String) } });
		expect(sideEffects).toBe(1);
		expect((await session.findFoundationRecords({ kind: "fact", objectType: "tool_receipt", order: "oldestFirst" })).length).toBe(2);
		await session.releaseWriterLease({ fencingToken: lease.fencingToken });
	});
});
