import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import {
	FoundationToolGuardV1,
	FoundationToolPipelineV1,
	InMemoryToolPipelineStorageV1,
	SessionToolPipelineStorageV1,
	type ToolDefinitionRegistryV1,
	type ToolDefinitionV1,
	type ToolGateCheckV1,
	type ToolPipelineContextV1,
	type ToolPipelineStorageV1,
} from "../../src/harness/tool-pipeline.ts";
import { FoundationError } from "../../src/harness/foundation/errors.ts";
import { createExecutionCorrelation } from "../../src/harness/foundation/identity.ts";
import { Result } from "../../src/harness/result.ts";
import { InMemorySessionStorage, Session } from "../../src/harness/session/index.ts";

function context(): ToolPipelineContextV1 {
	return {
		sessionId: "session-1",
		laneId: "main",
		taskId: "task-1",
		workspace: "workspace-1",
		binding: {
			schemaVersion: 1,
			bindingId: "binding-1",
			taskId: "task-1",
			roleRevision: { schemaVersion: 1, type: "role_revision", id: "role-1", revision: 1 },
			modelProfileRevision: { schemaVersion: 1, type: "model_profile", id: "model-1", revision: 1 },
			modelRoute: { provider: "test", model: "test-model" },
			contextRevision: { schemaVersion: 1, type: "context", id: "context-1", revision: 1 },
			capabilityRevision: { schemaVersion: 1, type: "capability", id: "capability-1", revision: 1 },
			policyRevision: { schemaVersion: 1, type: "policy", id: "policy-1", revision: 1 },
			capabilitySelector: { policy: "all" },
			budget: {},
			sourceTrace: [],
			conflicts: [],
			fingerprint: { algorithm: "sha256", value: "fingerprint" },
			resolvedAt: "now",
		},
		bindingEpoch: {
			schemaVersion: 1,
			bindingEpochId: "epoch-1",
			taskId: "task-1",
			attemptId: "attempt-1",
			bindingId: "binding-1",
			ordinal: 0,
			activationReason: "attempt_started",
			activatedByCommandId: "command-1",
			activatedAt: "now",
		},
	};
}

function operationContext(operationId: string, runId = operationId): ToolPipelineContextV1 {
	const attemptId = `attempt-${operationId}`;
	return {
		...context(),
		runId,
		operationId,
		dispatchId: "dispatch-1",
		providerId: "provider-1",
		agentInstanceId: "agent-1",
		attemptId,
		attempt: 1,
		bindingEpoch: { ...context().bindingEpoch, attemptId },
	};
}

function reference(type: string) {
	return { schemaVersion: 1 as const, type, id: `${type}-1`, revision: 1 };
}

function tool(name: string, execute: ToolDefinitionV1["execute"], options: Partial<Pick<ToolDefinitionV1, "capabilities" | "conflictKeys" | "idempotency">> = {}): ToolDefinitionV1 {
	return {
		name,
		toolRevision: { schemaVersion: 1, type: "tool_revision", id: `${name}-revision`, revision: 1 },
		capabilities: options.capabilities ?? [],
		parameters: Type.Object({ value: Type.String() }, { additionalProperties: false }),
		...(options.conflictKeys === undefined ? {} : { conflictKeys: options.conflictKeys }),
		...(options.idempotency === undefined ? {} : { idempotency: options.idempotency }),
		execute,
	};
}

function registry(tools: readonly ToolDefinitionV1[]): ToolDefinitionRegistryV1 {
	return {
		resolve(name: string) {
			const found = tools.find((candidate) => candidate.name === name);
			return found === undefined ? Result.err(new FoundationError("invalid_identifier", `unknown tool ${name}`)) : Result.ok(found);
		},
	};
}

function allowCheck(order: string[], name: string): ToolGateCheckV1 {
	return () => {
		order.push(name);
		return Result.ok({ allowed: true, reference: reference(name) });
	};
}

function allowNonQuotaGuards(): FoundationToolGuardV1 {
	return new FoundationToolGuardV1({
		capability: { check: () => Result.ok({ allowed: true, reference: reference("capability") }) },
		policy: { check: () => Result.ok({ allowed: true, reference: reference("policy") }) },
		approval: { check: () => Result.ok({ allowed: true, reference: reference("approval") }) },
		sandbox: { check: () => Result.ok({ allowed: true, reference: reference("sandbox") }) },
	});
}

function allowAllGuards(): FoundationToolGuardV1 {
	return new FoundationToolGuardV1({
		capability: { check: () => Result.ok({ allowed: true, reference: reference("capability") }) },
		policy: { check: () => Result.ok({ allowed: true, reference: reference("policy") }) },
		approval: { check: () => Result.ok({ allowed: true, reference: reference("approval") }) },
		sandbox: { check: () => Result.ok({ allowed: true, reference: reference("sandbox") }) },
		quota: { check: () => Result.ok({ allowed: true, reference: reference("quota") }) },
		conflictLock: { check: () => Result.ok({ allowed: true, reference: reference("conflict_lock") }) },
	});
}

describe("T4 fixed tool runtime", () => {
	it("arms a durable intent fence before executing and records the result fact after execution", async () => {
		const events: string[] = [];
		const storage = new InMemoryToolPipelineStorageV1();
		const originalWrite = storage.writeIntent.bind(storage);
		storage.writeIntent = async (intent) => {
			events.push("intent");
			return originalWrite(intent);
		};
		const originalFinalize = storage.finalizeReceipt.bind(storage);
		storage.finalizeReceipt = async (receipt) => {
			events.push("fact");
			return originalFinalize(receipt);
		};
		const order: string[] = [];
		const guard = new FoundationToolGuardV1({
			capability: { check: allowCheck(order, "capability") },
			policy: { check: allowCheck(order, "policy") },
			approval: { check: allowCheck(order, "approval") },
			sandbox: { check: allowCheck(order, "sandbox") },
			quota: { check: allowCheck(order, "quota") },
			conflictLock: { check: allowCheck(order, "conflict_lock") },
		});
		const pipeline = new FoundationToolPipelineV1({
			registry: registry([tool("write", async () => { events.push("execute"); return { ok: true, sideEffectState: "none" }; })]),
			storage,
			guard,
			now: () => "now",
			idGenerator: (prefix) => `${prefix}-1`,
		});

		const result = await pipeline.execute({ toolCallId: "call-1", toolName: "write", args: { value: "x" } }, context());
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.outcome).toBe("succeeded");
		expect(order).toEqual(["capability", "policy", "approval", "sandbox", "quota", "conflict_lock"]);
		expect(events).toEqual(["intent", "execute", "fact"]);
		expect(storage.intents[0]?.fence?.bindingEpochId).toBe("epoch-1");
		expect(storage.intents[0]?.argumentDigests.accepted).toEqual(storage.intents[0]?.fence?.acceptedArgumentsDigest);
	});

	it("records original and accepted argument digests with transform provenance", async () => {
		const storage = new InMemoryToolPipelineStorageV1();
		const transform = {
			...tool("transform", async () => ({ ok: true, sideEffectState: "none" as const })),
			prepareArguments: () => ({ value: "accepted" }),
		};
		const pipeline = new FoundationToolPipelineV1({
			registry: registry([transform]),
			storage,
			guard: allowAllGuards(),
			now: () => "now",
			idGenerator: (prefix) => `${prefix}-digest`,
		});

		const result = await pipeline.execute({ toolCallId: "call-digest", toolName: "transform", args: { value: "original" } }, context());

		expect(result).toMatchObject({ ok: true, value: { outcome: "succeeded", transformProvenance: [{ field: "value", kind: "normalized" }] } });
		expect(storage.intents[0]?.argumentDigests.original.value).not.toBe(storage.intents[0]?.argumentDigests.accepted.value);
	});

	it("stops the guard chain at the first denial and never executes", async () => {
		const order: string[] = [];
		let executed = false;
		const denied = () => {
			order.push("approval");
			return Result.ok({ allowed: false, reference: reference("approval"), reason: "human approval required" });
		};
		const guard = new FoundationToolGuardV1({
			capability: { check: allowCheck(order, "capability") },
			policy: { check: allowCheck(order, "policy") },
			approval: { check: denied },
			sandbox: { check: allowCheck(order, "sandbox") },
			quota: { check: allowCheck(order, "quota") },
		});
		const pipeline = new FoundationToolPipelineV1({
			registry: registry([tool("blocked", async () => { executed = true; return { ok: true, sideEffectState: "none" }; })]),
			guard,
			now: () => "now",
			idGenerator: (prefix) => `${prefix}-1`,
		});

		const result = await pipeline.execute({ toolCallId: "call-2", toolName: "blocked", args: { value: "x" } }, context());

		expect(result).toMatchObject({ ok: true, value: { outcome: "blocked", gates: [{ kind: "capability", verdict: "allowed" }, { kind: "policy", verdict: "allowed" }, { kind: "approval", verdict: "denied" }] } });
		expect(order).toEqual(["capability", "policy", "approval"]);
		expect(executed).toBe(false);
	});

	it("fails closed when a custom guard attempts to reorder the fixed sequence", async () => {
		let executed = false;
		const pipeline = new FoundationToolPipelineV1({
			registry: registry([tool("reordered", async () => { executed = true; return { ok: true, sideEffectState: "none" }; })]),
			guard: {
				guard: async () => Result.ok([{ kind: "policy", verdict: "allowed", reference: reference("policy") }]),
			},
			now: () => "now",
			idGenerator: (prefix) => `${prefix}-reordered`,
		});

		const result = await pipeline.execute({ toolCallId: "call-reordered", toolName: "reordered", args: { value: "x" } }, context());

		expect(result).toMatchObject({ ok: true, value: { outcome: "blocked", error: { code: "tool_guard_denied" } } });
		expect(executed).toBe(false);
	});

	it("records a quota denial at the quota gate without reaching the provider", async () => {
		let executed = false;
		const pipeline = new FoundationToolPipelineV1({
			registry: registry([tool("over-limit", async () => { executed = true; return { ok: true, sideEffectState: "none" }; })]),
			budget: { toolCalls: 0 },
			guard: allowNonQuotaGuards(),
			now: () => "now",
			idGenerator: (prefix) => `${prefix}-quota`,
		});

		const result = await pipeline.execute({ toolCallId: "call-quota", toolName: "over-limit", args: { value: "x" } }, context());

		expect(result).toMatchObject({ ok: true, value: { outcome: "blocked", gates: [
			{ kind: "capability", verdict: "allowed" },
			{ kind: "policy", verdict: "allowed" },
			{ kind: "approval", verdict: "allowed" },
			{ kind: "sandbox", verdict: "allowed" },
			{ kind: "quota", verdict: "denied" },
		] } });
		expect(executed).toBe(false);
	});

	it("does not retry side-effect-unknown and joins conflicting calls in source order", async () => {
		let attempts = 0;
		const executionOrder: string[] = [];
		const pipeline = new FoundationToolPipelineV1({
			registry: registry([
				tool("unknown", async () => { attempts += 1; return { ok: false, sideEffectState: "side_effect_unknown", error: { code: "lost", message: "outcome unknown", retryable: true } }; }),
				tool("slow", async () => { await new Promise((resolve) => setTimeout(resolve, 5)); executionOrder.push("slow"); return { ok: true, sideEffectState: "none" }; }, { conflictKeys: () => ["shared"] }),
				tool("fast", async () => { executionOrder.push("fast"); return { ok: true, sideEffectState: "none" }; }, { conflictKeys: () => ["shared"] }),
			]),
			maxRetries: 3,
			maxConcurrency: 2,
			guard: allowAllGuards(),
			now: () => "now",
			idGenerator: (() => { let id = 0; return (prefix: string) => `${prefix}-${++id}`; })(),
		});

		const unknown = await pipeline.execute({ toolCallId: "unknown-call", toolName: "unknown", args: { value: "x" } }, context());
		const joined = await pipeline.executeBatch([
			{ toolCallId: "slow-call", toolName: "slow", args: { value: "x" } },
			{ toolCallId: "fast-call", toolName: "fast", args: { value: "x" } },
		], context());
		expect(unknown).toMatchObject({ ok: true, value: { outcome: "side_effect_unknown", retried: 0 } });
		expect(attempts).toBe(1);
		expect(joined).toMatchObject({ ok: true, value: { receipts: [{ toolCallId: "slow-call" }, { toolCallId: "fast-call" }], conflicts: [{ keys: ["shared"], toolCallIds: ["slow-call", "fast-call"] }] } });
		expect(executionOrder).toEqual(["slow", "fast"]);
	});

	it("does not call a later conflicting gateway provider after an unknown receipt", async () => {
		const storage = new InMemoryToolPipelineStorageV1();
		let firstGatewayCalls = 0;
		let secondGatewayCalls = 0;
		const pipeline = new FoundationToolPipelineV1({
			registry: registry([
				tool("gateway-first", async () => {
					firstGatewayCalls += 1;
					return { ok: false, sideEffectState: "side_effect_unknown", error: { code: "gateway_lost", message: "gateway outcome unknown", retryable: true } };
				}, { conflictKeys: () => ["gateway:shared"] }),
				tool("gateway-second", async () => {
					secondGatewayCalls += 1;
					return { ok: true, sideEffectState: "none" };
				}, { conflictKeys: () => ["gateway:shared"] }),
			]),
			storage,
			guard: allowAllGuards(),
			maxConcurrency: 2,
			now: () => "now",
			idGenerator: (() => { let id = 0; return (prefix: string) => `${prefix}-${++id}`; })(),
		});

		const result = await pipeline.executeBatch([
			{ toolCallId: "gateway-first-call", toolName: "gateway-first", args: { value: "first" } },
			{ toolCallId: "gateway-second-call", toolName: "gateway-second", args: { value: "second" } },
		], context());
		expect(result).toMatchObject({ ok: true, value: { receipts: [
			{ toolCallId: "gateway-first-call", outcome: "side_effect_unknown" },
			{ toolCallId: "gateway-second-call", outcome: "blocked", sideEffectState: "none", error: { code: "tool_conflict_dependency_blocked" } },
		] } });
		expect(firstGatewayCalls).toBe(1);
		expect(secondGatewayCalls).toBe(0);
		expect(storage.receipts.map((receipt) => receipt.toolCallId)).toEqual(["gateway-first-call", "gateway-second-call"]);
	});

	it("blocks a later conflicting provider when the prior receipt cannot be finalized", async () => {
		const durable = new InMemoryToolPipelineStorageV1();
		const storage: ToolPipelineStorageV1 = {
			writeIntent: (intent) => durable.writeIntent(intent),
			finalizeReceipt: async (receipt) => receipt.toolCallId === "finalize-first-call"
				? Result.err(new FoundationError("serialization_failed", "durable receipt unavailable"))
				: durable.finalizeReceipt(receipt),
			listIntents: () => durable.listIntents(),
			listReceipts: () => durable.listReceipts(),
		};
		let secondProviderCalls = 0;
		const pipeline = new FoundationToolPipelineV1({
			registry: registry([
				tool("finalize-first", async () => ({ ok: true, sideEffectState: "none" }), { conflictKeys: () => ["finalize:shared"] }),
				tool("finalize-second", async () => {
					secondProviderCalls += 1;
					return { ok: true, sideEffectState: "none" };
				}, { conflictKeys: () => ["finalize:shared"] }),
			]),
			storage,
			guard: allowAllGuards(),
			maxConcurrency: 2,
			now: () => "now",
			idGenerator: (() => { let id = 0; return (prefix: string) => `${prefix}-${++id}`; })(),
		});

		const result = await pipeline.executeBatch([
			{ toolCallId: "finalize-first-call", toolName: "finalize-first", args: { value: "first" } },
			{ toolCallId: "finalize-second-call", toolName: "finalize-second", args: { value: "second" } },
		], context());
		expect(result).toMatchObject({ ok: false, error: { code: "side_effect_unknown" } });
		expect(secondProviderCalls).toBe(0);
		expect(durable.receipts).toMatchObject([{ toolCallId: "finalize-second-call", outcome: "blocked", error: { code: "tool_conflict_dependency_blocked" } }]);
	});

	it("fails closed when durable fact finalization fails, then recovers the unsettled intent", async () => {
		const durable = new InMemoryToolPipelineStorageV1();
		let failFinalize = true;
		const storage: ToolPipelineStorageV1 = {
			writeIntent: (intent) => durable.writeIntent(intent),
			finalizeReceipt: async (receipt) => failFinalize
				? Result.err(new FoundationError("serialization_failed", "durable fact unavailable"))
				: durable.finalizeReceipt(receipt),
			listIntents: () => durable.listIntents(),
			listReceipts: () => durable.listReceipts(),
		};
		let sideEffects = 0;
		const options = {
			registry: registry([tool("uncertain", async () => { sideEffects += 1; return { ok: true, sideEffectState: "none" }; })]),
			storage,
			guard: allowAllGuards(),
			now: () => "now",
			idGenerator: (prefix: string) => `${prefix}-1`,
		};
		const first = await new FoundationToolPipelineV1(options).execute({ toolCallId: "call-recovery", toolName: "uncertain", args: { value: "x" } }, context());

		expect(first.ok).toBe(false);
		expect(sideEffects).toBe(1);
		expect(durable.intents).toHaveLength(1);
		expect(durable.receipts).toHaveLength(0);

		failFinalize = false;
		const recovery = await new FoundationToolPipelineV1(options).recoverUnsettled();
		expect(recovery).toMatchObject({ ok: true, value: [{ outcome: "side_effect_unknown", sideEffectState: "side_effect_unknown", retried: 0 }] });
		expect(durable.receipts).toHaveLength(1);
		expect(await new FoundationToolPipelineV1(options).recoverUnsettled()).toMatchObject({ ok: true, value: [] });
		expect(sideEffects).toBe(1);
	});

	it("fails closed when policy, approval, or sandbox authority is absent", async () => {
		let executed = false;
		const pipeline = new FoundationToolPipelineV1({
			registry: registry([tool("guarded", async () => { executed = true; return { ok: true, sideEffectState: "none" }; })]),
			now: () => "now",
			idGenerator: (() => { let id = 0; return (prefix: string) => `${prefix}-${++id}`; })(),
		});
		const result = await pipeline.execute({ toolCallId: "call-guarded", toolName: "guarded", args: { value: "x" } }, context());
		expect(result).toMatchObject({ ok: true, value: { outcome: "blocked", gates: [{ kind: "capability", verdict: "allowed" }, { kind: "policy", verdict: "denied" }] } });
		expect(executed).toBe(false);
	});

	it("normalizes cancellation and deadline ambiguity to side_effect_unknown", async () => {
		const controller = new AbortController();
		const pipeline = new FoundationToolPipelineV1({
			registry: registry([tool("ambiguous", async (_args, options) => {
				await new Promise<void>((resolve) => options.signal?.addEventListener("abort", () => resolve(), { once: true }));
				return { ok: true, sideEffectState: "none" };
			})]),
			guard: allowAllGuards(),
			now: () => "now",
			idGenerator: (() => { let id = 0; return (prefix: string) => `${prefix}-${++id}`; })(),
		});
		const cancellation = pipeline.execute({ toolCallId: "call-cancel", toolName: "ambiguous", args: { value: "x" } }, context(), { signal: controller.signal });
		setTimeout(() => controller.abort(), 1);
		await expect(cancellation).resolves.toMatchObject({ ok: true, value: { outcome: "side_effect_unknown", sideEffectState: "side_effect_unknown" } });

		const deadline = await pipeline.execute({ toolCallId: "call-deadline", toolName: "ambiguous", args: { value: "x" } }, context(), { deadlineAt: Date.now() - 1 });
		expect(deadline).toMatchObject({ ok: true, value: { outcome: "side_effect_unknown", sideEffectState: "side_effect_unknown" } });

		const durable = new InMemoryToolPipelineStorageV1();
		const transport = new FoundationToolPipelineV1({
			registry: registry([tool("transport", async () => ({ ok: true, sideEffectState: "none" }))]),
			storage: {
				writeIntent: (intent) => durable.writeIntent(intent),
				finalizeReceipt: async () => { throw new Error("transport disconnected"); },
				listIntents: () => durable.listIntents(),
				listReceipts: () => durable.listReceipts(),
			},
			guard: allowAllGuards(),
			idGenerator: (() => { let id = 0; return (prefix: string) => `${prefix}-${++id}`; })(),
		});
		expect(await transport.execute({ toolCallId: "call-transport", toolName: "transport", args: { value: "x" } }, context())).toMatchObject({ ok: false, error: { code: "side_effect_unknown" } });
	});

	it("reuses durable idempotency across a pipeline restart and runs unrelated calls in parallel", async () => {
		const durable = new InMemoryToolPipelineStorageV1();
		let failFinalize = true;
		let sideEffects = 0;
		let active = 0;
		let peak = 0;
		const storage: ToolPipelineStorageV1 = {
			writeIntent: (intent) => durable.writeIntent(intent),
			finalizeReceipt: async (receipt) => failFinalize ? Result.err(new FoundationError("serialization_failed", "simulated crash")) : durable.finalizeReceipt(receipt),
			listIntents: () => durable.listIntents(),
			listReceipts: () => durable.listReceipts(),
		};
		const make = () => new FoundationToolPipelineV1({
			registry: registry([tool("once", async () => { sideEffects += 1; return { ok: true, sideEffectState: "none" }; }), tool("parallel-a", async () => { active += 1; peak = Math.max(peak, active); await new Promise((resolve) => setTimeout(resolve, 5)); active -= 1; return { ok: true, sideEffectState: "none" }; }), tool("parallel-b", async () => { active += 1; peak = Math.max(peak, active); await new Promise((resolve) => setTimeout(resolve, 5)); active -= 1; return { ok: true, sideEffectState: "none" }; })]),
			storage,
			guard: allowAllGuards(),
			maxConcurrency: 2,
			idGenerator: (() => { let id = 0; return (prefix: string) => `${prefix}-${++id}`; })(),
		});
		const first = await make().execute({ toolCallId: "call-once", toolName: "once", idempotencyKey: "once-key", args: { value: "x" } }, context());
		expect(first.ok).toBe(false);
		expect(sideEffects).toBe(1);
		failFinalize = false;
		const restarted = make();
		const recovered = await restarted.recoverUnsettled();
		expect(recovered).toMatchObject({ ok: true, value: [{ outcome: "side_effect_unknown" }] });
		const replay = await restarted.execute({ toolCallId: "call-once", toolName: "once", idempotencyKey: "once-key", args: { value: "x" } }, context());
		expect(replay).toMatchObject({ ok: true, value: { deduplicatedFrom: expect.any(String), outcome: "side_effect_unknown" } });
		expect(sideEffects).toBe(1);
		const batch = await restarted.executeBatch([
			{ toolCallId: "parallel-a", toolName: "parallel-a", args: { value: "a" } },
			{ toolCallId: "parallel-b", toolName: "parallel-b", args: { value: "b" } },
		], context());
		expect(batch.ok).toBe(true);
		expect(peak).toBe(2);
	});

	it("keeps the same toolCallId separate across operations and fails closed on key conflicts", async () => {
		const storage = new InMemoryToolPipelineStorageV1();
		let sideEffects = 0;
		const options = {
			registry: registry([tool("identity", async () => { sideEffects += 1; return { ok: true, sideEffectState: "none" }; })]),
			storage,
			guard: allowAllGuards(),
			idGenerator: (() => { let id = 0; return (prefix: string) => `${prefix}-${++id}`; })(),
		};
		const pipeline = new FoundationToolPipelineV1(options);
		const first = await pipeline.execute({ toolCallId: "shared-call", toolName: "identity", idempotencyKey: "operation-a-key", args: { value: "a" } }, operationContext("operation-a"));
		const second = await pipeline.execute({ toolCallId: "shared-call", toolName: "identity", idempotencyKey: "operation-b-key", args: { value: "b" } }, operationContext("operation-b"));
		expect(first.ok).toBe(true);
		expect(second.ok).toBe(true);
		expect(sideEffects).toBe(2);
		expect(storage.receipts.map((receipt) => receipt.binding.operationId)).toEqual(["operation-a", "operation-b"]);

		const replay = await new FoundationToolPipelineV1(options).execute({ toolCallId: "shared-call", toolName: "identity", idempotencyKey: "operation-a-key", args: { value: "a" } }, operationContext("operation-a"));
		expect(replay).toMatchObject({ ok: true, value: { deduplicatedFrom: expect.any(String) } });
		expect(sideEffects).toBe(2);

		const argumentConflict = await pipeline.execute({ toolCallId: "shared-call", toolName: "identity", idempotencyKey: "operation-a-key", args: { value: "changed" } }, operationContext("operation-a"));
		expect(argumentConflict).toMatchObject({ ok: false, error: { code: "goal_conflict" } });
		const identityConflict = await pipeline.execute({ toolCallId: "shared-call", toolName: "identity", idempotencyKey: "operation-a-key", args: { value: "a" } }, operationContext("operation-b"));
		expect(identityConflict).toMatchObject({ ok: false, error: { code: "goal_conflict" } });
		expect(sideEffects).toBe(2);
	});

	it("rejects a ledger append when correlation identity does not match the tool binding", async () => {
		const session = new Session(new InMemorySessionStorage({ id: "session-1", createdAt: 1 }));
		const lease = await session.acquireWriterLease({ ownerId: "correlation-owner" });
		const executionContext = operationContext("operation-correlation");
		const storage = new SessionToolPipelineStorageV1({
			ledger: session,
			laneId: executionContext.laneId,
			correlationFor: (_kind, value) => createExecutionCorrelation(executionContext.sessionId, executionContext.laneId, {
				bindingId: value.binding.bindingId,
				bindingEpochId: value.binding.bindingEpochId,
				taskId: value.binding.taskId,
				dispatchId: value.binding.dispatchId,
				runId: "wrong-operation",
				operationId: value.binding.operationId,
				attemptId: value.binding.attemptId,
				providerId: value.binding.providerId,
				agentInstanceId: value.binding.agentInstanceId,
				toolCallId: value.toolCallId,
			}),
			fencingToken: () => lease.fencingToken,
		});
		let sideEffects = 0;
		const pipeline = new FoundationToolPipelineV1({
			registry: registry([tool("correlation", async () => { sideEffects += 1; return { ok: true, sideEffectState: "none" }; })]),
			storage,
			guard: allowAllGuards(),
		});

		const result = await pipeline.execute({ toolCallId: "correlation-call", toolName: "correlation", args: { value: "x" } }, executionContext);
		expect(result).toMatchObject({ ok: false, error: { code: "invalid_correlation" } });
		expect(sideEffects).toBe(0);
		expect(await session.findFoundationRecords({ kind: "intent", objectType: "tool_intent", includePruned: true })).toHaveLength(0);
		await session.releaseWriterLease({ fencingToken: lease.fencingToken });
	});

	it("rejects a default ledger append made with a stale writer fencing token", async () => {
		const session = new Session(new InMemorySessionStorage({ id: "session-1", createdAt: 1 }));
		const staleLease = await session.acquireWriterLease({ ownerId: "stale-owner" });
		await session.releaseWriterLease({ fencingToken: staleLease.fencingToken });
		await session.acquireWriterLease({ ownerId: "current-owner" });
		const executionContext = operationContext("operation-fencing");
		const storage = new SessionToolPipelineStorageV1({
			ledger: session,
			laneId: executionContext.laneId,
			correlationFor: (_kind, value) => createExecutionCorrelation(executionContext.sessionId, executionContext.laneId, {
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
			fencingToken: () => staleLease.fencingToken,
		});
		let sideEffects = 0;
		const pipeline = new FoundationToolPipelineV1({
			registry: registry([tool("fenced", async () => { sideEffects += 1; return { ok: true, sideEffectState: "none" }; })]),
			storage,
			guard: allowAllGuards(),
		});

		const result = await pipeline.execute({ toolCallId: "fenced-call", toolName: "fenced", args: { value: "x" } }, executionContext);
		expect(result).toMatchObject({ ok: false, error: { code: "session_writer_fencing_token" } });
		expect(sideEffects).toBe(0);
		expect(await session.findFoundationRecords({ kind: "intent", objectType: "tool_intent", includePruned: true })).toHaveLength(0);
	});
});
