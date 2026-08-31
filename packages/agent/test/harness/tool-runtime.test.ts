import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import {
	FoundationToolGuard,
	FoundationToolQuotaAccount,
	FoundationToolPipeline,
	InMemoryToolPipelineStorage,
	SessionToolPipelineStorage,
	finalizeToolReceipt,
	validateToolResultPayload,
	validateToolReceipt,
	validateAndVerifyToolReceipt,
	type ToolDefinitionRegistry,
	type ToolDefinition,
	type ToolGateCheck,
	type ToolPipelineContext,
	type ToolPipelineStorage,
} from "../../src/harness/tool-pipeline.ts";
import { FoundationError } from "../../src/harness/foundation/errors.ts";
import { createExecutionCorrelation } from "../../src/harness/foundation/identity.ts";
import { createEmptyMcpSelection } from "../../src/harness/foundation/mcp-selection.ts";
import { Result } from "../../src/harness/result.ts";
import { InMemorySessionStorage, Session } from "../../src/harness/session/index.ts";

function context(): ToolPipelineContext {
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
			modelBrokerBindingRevision: { schemaVersion: 1, type: "model_broker_binding", id: "model-broker-1", revision: 1 },
			contextRevision: { schemaVersion: 1, type: "context", id: "context-1", revision: 1 },
			capabilityRevision: { schemaVersion: 1, type: "capability", id: "capability-1", revision: 1 },
			policyRevision: { schemaVersion: 1, type: "policy", id: "policy-1", revision: 1 },
			capabilitySelector: { policy: "all" },
			mcpSelection: createEmptyMcpSelection("capability-1"),
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

function operationContext(operationId: string, runId = operationId): ToolPipelineContext {
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

function tool(name: string, execute: ToolDefinition["execute"], options: Partial<Pick<ToolDefinition, "capabilities" | "conflictKeys" | "idempotency">> = {}): ToolDefinition {
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

function registry(tools: readonly ToolDefinition[]): ToolDefinitionRegistry {
	return {
		resolve(name: string) {
			const found = tools.find((candidate) => candidate.name === name);
			return found === undefined ? Result.err(new FoundationError("invalid_identifier", `unknown tool ${name}`)) : Result.ok(found);
		},
	};
}

function allowCheck(order: string[], name: string): ToolGateCheck {
	return () => {
		order.push(name);
		return Result.ok({ allowed: true, reference: reference(name) });
	};
}

function allowNonQuotaGuards(): FoundationToolGuard {
	return new FoundationToolGuard({
		capability: { check: () => Result.ok({ allowed: true, reference: reference("capability") }) },
		policy: { check: () => Result.ok({ allowed: true, reference: reference("policy") }) },
		approval: { check: () => Result.ok({ allowed: true, reference: reference("approval") }) },
		sandbox: { check: () => Result.ok({ allowed: true, reference: reference("sandbox") }) },
	});
}

function allowAllGuards(): FoundationToolGuard {
	return new FoundationToolGuard({
		capability: { check: () => Result.ok({ allowed: true, reference: reference("capability") }) },
		policy: { check: () => Result.ok({ allowed: true, reference: reference("policy") }) },
		approval: { check: () => Result.ok({ allowed: true, reference: reference("approval") }) },
		sandbox: { check: () => Result.ok({ allowed: true, reference: reference("sandbox") }) },
		quota: { check: () => Result.ok({ allowed: true, reference: reference("quota") }) },
		conflictLock: { check: () => Result.ok({ allowed: true, reference: reference("conflict_lock") }) },
	});
}

describe("fixed tool runtime", () => {
	it("arms a durable intent fence before executing and records the result fact after execution", async () => {
		const events: string[] = [];
		const storage = new InMemoryToolPipelineStorage();
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
		const guard = new FoundationToolGuard({
			capability: { check: allowCheck(order, "capability") },
			policy: { check: allowCheck(order, "policy") },
			approval: { check: allowCheck(order, "approval") },
			sandbox: { check: allowCheck(order, "sandbox") },
			quota: { check: allowCheck(order, "quota") },
			conflictLock: { check: allowCheck(order, "conflict_lock") },
		});
		const pipeline = new FoundationToolPipeline({
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
		const storage = new InMemoryToolPipelineStorage();
		const transform = {
			...tool("transform", async () => ({ ok: true, sideEffectState: "none" as const })),
			prepareArguments: () => ({ value: "accepted" }),
		};
		const pipeline = new FoundationToolPipeline({
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

	it("records stable transformer identity and rejects exact provenance or receipt tampering", async () => {
		const storage = new InMemoryToolPipelineStorage();
		const transformed = {
			...tool("transform-stable", async () => ({ ok: true, sideEffectState: "none" as const })),
			argumentTransformer: { transformerId: "transformer:stable", transformerRevision: 7, transform: () => ({ value: "accepted" }) },
		};
		const options = { registry: registry([transformed]), storage, guard: allowAllGuards(), idGenerator: (prefix: string) => `${prefix}-stable` };
		const first = await new FoundationToolPipeline(options).execute({ toolCallId: "call-stable", toolName: "transform-stable", idempotencyKey: "stable-key", args: { value: "original" } }, context());
		if (!first.ok) throw first.error;
		const provenance = first.value.transformProvenance[0]!;
		expect(provenance).toMatchObject({ transformerId: "transformer:stable", transformerRevision: 7, beforeDigest: { algorithm: "sha256" }, afterDigest: { algorithm: "sha256" } });
		const tamperedIntent = { ...storage.intents[0]!, transformProvenance: storage.intents[0]!.transformProvenance.map((entry) => ({ ...entry, beforeDigest: { algorithm: "sha256" as const, value: "0".repeat(64) } })) };
		const tamperedStorage = {
			writeIntent: async () => Result.ok(tamperedIntent),
			finalizeReceipt: async (receipt: Parameters<InMemoryToolPipelineStorage["finalizeReceipt"]>[0]) => Result.ok({ toolReceiptRef: receipt.toolReceiptId }),
			listIntents: async () => [tamperedIntent],
			listReceipts: async () => [],
		};
		const replay = await new FoundationToolPipeline({ ...options, storage: tamperedStorage }).execute({ toolCallId: "call-stable", toolName: "transform-stable", idempotencyKey: "stable-key", args: { value: "original" } }, context());
		expect(replay).toMatchObject({ ok: false, error: { code: "tool_guard_denied" } });
		const forgedDigest = { ...first.value, digest: { algorithm: "sha256" as const, value: "0".repeat(64) } };
		expect(validateAndVerifyToolReceipt(forgedDigest)).toMatchObject({ ok: false, error: { code: "side_effect_unknown" } });

		const ambiguous = await new FoundationToolPipeline({
			registry: registry([{ ...transformed, prepareArguments: () => ({ value: "ambiguous" }) }]),
			guard: allowAllGuards(),
		}).execute({ toolCallId: "call-ambiguous-transform", toolName: "transform-stable", args: { value: "x" } }, context());
		expect(ambiguous).toMatchObject({ ok: false, error: { code: "foundation_schema_invalid_shape" } });
	});

	it("runs provider-neutral pre/post hooks read-only and fails closed on mutation or invalid normalization", async () => {
		const stages: string[] = [];
		let executions = 0;
		const hooked = {
			...tool("hooked", async () => { executions += 1; return { ok: true, sideEffectState: "none" as const }; }),
			preHook: (scope: Parameters<NonNullable<ToolDefinition["preHook"]>>[0]) => {
				expect(Object.isFrozen(scope)).toBe(true);
				expect(Object.isFrozen(scope.args)).toBe(true);
				expect(Object.isFrozen(scope.intent)).toBe(true);
			},
			postProcessor: () => ({ result: { schemaVersion: 1 as const, content: [{ type: "text" as const, text: "normalized" }] }, usage: { tokens: 1, costUsd: 0.25, toolCalls: 1 } }),
		};
		const pipeline = new FoundationToolPipeline({ registry: registry([hooked]), guard: allowAllGuards(), onStage: (event) => { stages.push(event.stage); } });
		const result = await pipeline.execute({ toolCallId: "call-hooked", toolName: "hooked", args: { value: "x" } }, context());
		expect(result).toMatchObject({ ok: true, value: { outcome: "succeeded", result: { content: [{ text: "normalized" }] }, usage: { costUsd: 0.25 } } });
		expect(stages).toEqual(["prepare", "pre", "guard", "execute", "post", "finalize"]);
		expect(executions).toBe(1);

		let mutatedExecutions = 0;
		const mutation = await new FoundationToolPipeline({
			registry: registry([{ ...tool("mutation", async () => { mutatedExecutions += 1; return { ok: true, sideEffectState: "none" as const }; }), preHook: (scope) => {
				(scope.args as Record<string, unknown>).value = "tampered";
			} }]),
			guard: allowAllGuards(),
		}).execute({ toolCallId: "call-mutation", toolName: "mutation", args: { value: "x" } }, context());
		expect(mutation).toMatchObject({ ok: true, value: { outcome: "blocked", sideEffectState: "none", error: { code: "tool_pre_hook_denied" } } });
		expect(mutatedExecutions).toBe(0);

		const invalidPost = await new FoundationToolPipeline({
			registry: registry([{ ...tool("invalid-post", async () => ({ ok: true, sideEffectState: "none" as const })), postProcessor: () => ({ outcome: "succeeded" } as never) }]),
			guard: allowAllGuards(),
		}).execute({ toolCallId: "call-invalid-post", toolName: "invalid-post", args: { value: "x" } }, context());
		expect(invalidPost).toMatchObject({ ok: true, value: { outcome: "failed", sideEffectState: "none", error: { code: "tool_post_validation_failed" } } });

		const providerPostError = await new FoundationToolPipeline({
			registry: registry([{ ...tool("provider-post-error", async () => ({ ok: true, sideEffectState: "none" as const })), postProcessor: () => Result.err(new FoundationError("tool_execution_failed", "provider error must not escape post validation")) }]),
			guard: allowAllGuards(),
		}).execute({ toolCallId: "call-provider-post-error", toolName: "provider-post-error", args: { value: "x" } }, context());
		expect(providerPostError).toMatchObject({ ok: true, value: { outcome: "failed", sideEffectState: "none", error: { code: "tool_post_validation_failed" } } });
	});

	it("accepts fractional currency while rejecting fractional usage counts", () => {
		const payload = {
			schemaVersion: 1 as const,
			content: [{ type: "text" as const, text: "ok" }],
			usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: 3, cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 } },
		};
		expect(validateToolResultPayload(payload)).toMatchObject({ ok: true });
		expect(validateToolResultPayload({ ...payload, usage: { ...payload.usage, input: 1.5 } })).toMatchObject({ ok: false });
	});

	it("stops the guard chain at the first denial and never executes", async () => {
		const order: string[] = [];
		let executed = false;
		const denied = () => {
			order.push("approval");
			return Result.ok({ allowed: false, reference: reference("approval"), reason: "human approval required" });
		};
		const guard = new FoundationToolGuard({
			capability: { check: allowCheck(order, "capability") },
			policy: { check: allowCheck(order, "policy") },
			approval: { check: denied },
			sandbox: { check: allowCheck(order, "sandbox") },
			quota: { check: allowCheck(order, "quota") },
		});
		const pipeline = new FoundationToolPipeline({
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
		const pipeline = new FoundationToolPipeline({
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
		const pipeline = new FoundationToolPipeline({
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
		const pipeline = new FoundationToolPipeline({
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
		const storage = new InMemoryToolPipelineStorage();
		let firstGatewayCalls = 0;
		let secondGatewayCalls = 0;
		const pipeline = new FoundationToolPipeline({
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
		const durable = new InMemoryToolPipelineStorage();
		const storage: ToolPipelineStorage = {
			writeIntent: (intent) => durable.writeIntent(intent),
			finalizeReceipt: async (receipt) => receipt.toolCallId === "finalize-first-call"
				? Result.err(new FoundationError("serialization_failed", "durable receipt unavailable"))
				: durable.finalizeReceipt(receipt),
			listIntents: () => durable.listIntents(),
			listReceipts: () => durable.listReceipts(),
		};
		let secondProviderCalls = 0;
		const pipeline = new FoundationToolPipeline({
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
		const durable = new InMemoryToolPipelineStorage();
		let failFinalize = true;
		const storage: ToolPipelineStorage = {
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
		const first = await new FoundationToolPipeline(options).execute({ toolCallId: "call-recovery", toolName: "uncertain", args: { value: "x" } }, context());

		expect(first.ok).toBe(false);
		expect(sideEffects).toBe(1);
		expect(durable.intents).toHaveLength(1);
		expect(durable.receipts).toHaveLength(0);

		failFinalize = false;
		const recovery = await new FoundationToolPipeline(options).recoverUnsettled();
		expect(recovery).toMatchObject({ ok: true, value: [{ outcome: "side_effect_unknown", sideEffectState: "side_effect_unknown", retried: 0 }] });
		expect(durable.receipts).toHaveLength(1);
		expect(await new FoundationToolPipeline(options).recoverUnsettled()).toMatchObject({ ok: true, value: [] });
		expect(sideEffects).toBe(1);
	});

	it("fails closed when policy, approval, or sandbox authority is absent", async () => {
		let executed = false;
		const pipeline = new FoundationToolPipeline({
			registry: registry([tool("guarded", async () => { executed = true; return { ok: true, sideEffectState: "none" }; })]),
			now: () => "now",
			idGenerator: (() => { let id = 0; return (prefix: string) => `${prefix}-${++id}`; })(),
		});
		const result = await pipeline.execute({ toolCallId: "call-guarded", toolName: "guarded", args: { value: "x" } }, context());
		expect(result).toMatchObject({ ok: true, value: { outcome: "blocked", gates: [{ kind: "capability", verdict: "allowed" }, { kind: "policy", verdict: "denied" }] } });
		expect(executed).toBe(false);
	});

	it("scopes concurrency reservations to binding and epoch across overlapping batches", async () => {
		const quota = new FoundationToolQuotaAccount({ budget: { concurrency: 1 } });
		const guard = new FoundationToolGuard({
			capability: { check: () => Result.ok({ allowed: true, reference: reference("capability") }) },
			policy: { check: () => Result.ok({ allowed: true, reference: reference("policy") }) },
			approval: { check: () => Result.ok({ allowed: true, reference: reference("approval") }) },
			sandbox: { check: () => Result.ok({ allowed: true, reference: reference("sandbox") }) },
			quota: { account: quota },
		});
		let releaseFirst: () => void = () => undefined;
		const firstEntered = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		let firstStarted = false;
		const pipeline = new FoundationToolPipeline({
			registry: registry([tool("scoped", async (_args, options) => {
				if (options.toolCallId === "same-first") {
					firstStarted = true;
					await firstEntered;
				}
				return { ok: true, sideEffectState: "none" as const };
			})]),
			guard,
			quotaAccount: quota,
			maxConcurrency: 4,
		});
		const bindingA = context();
		const bindingB = { ...context(), binding: { ...context().binding, bindingId: "binding-2", budget: { concurrency: 1 } }, bindingEpoch: { ...context().bindingEpoch, bindingId: "binding-2", bindingEpochId: "epoch-2" } };
		const first = pipeline.execute({ toolCallId: "same-first", toolName: "scoped", args: { value: "a" } }, bindingA);
		while (!firstStarted) await new Promise((resolve) => setTimeout(resolve, 0));
		const sameBinding = await pipeline.execute({ toolCallId: "same-second", toolName: "scoped", args: { value: "b" } }, bindingA);
		expect(sameBinding).toMatchObject({ ok: true, value: { outcome: "blocked", error: { code: "tool_guard_denied" } } });
		const unrelated = await pipeline.execute({ toolCallId: "other-binding", toolName: "scoped", args: { value: "c" } }, bindingB);
		expect(unrelated).toMatchObject({ ok: true, value: { outcome: "succeeded" } });
		releaseFirst();
		expect(await first).toMatchObject({ ok: true, value: { outcome: "succeeded" } });
		expect(quota.reservations).toHaveLength(0);
	});

	it("keeps pre-provider cancellation/deadline safe and only marks in-flight interruption unknown", async () => {
		const controller = new AbortController();
		const preProvider = new AbortController();
		preProvider.abort();
		let executions = 0;
		const pipeline = new FoundationToolPipeline({
			registry: registry([tool("ambiguous", async (_args, options) => {
				executions += 1;
				await new Promise<void>((resolve) => options.signal?.addEventListener("abort", () => resolve(), { once: true }));
				return { ok: true, sideEffectState: "none" };
			})]),
			guard: allowAllGuards(),
			now: () => "now",
			idGenerator: (() => { let id = 0; return (prefix: string) => `${prefix}-${++id}`; })(),
		});
		const preCancelled = await pipeline.execute({ toolCallId: "call-pre-cancel", toolName: "ambiguous", args: { value: "x" } }, context(), { signal: preProvider.signal });
		expect(preCancelled).toMatchObject({ ok: true, value: { outcome: "cancelled", sideEffectState: "none", error: { code: "tool_cancelled" } } });
		expect(executions).toBe(0);
		const cancellation = pipeline.execute({ toolCallId: "call-cancel", toolName: "ambiguous", args: { value: "x" } }, context(), { signal: controller.signal });
		setTimeout(() => controller.abort(), 1);
		await expect(cancellation).resolves.toMatchObject({ ok: true, value: { outcome: "side_effect_unknown", sideEffectState: "side_effect_unknown" } });

		const deadline = await pipeline.execute({ toolCallId: "call-deadline", toolName: "ambiguous", args: { value: "x" } }, context(), { deadlineAt: Date.now() - 1 });
		expect(deadline).toMatchObject({ ok: true, value: { outcome: "failed", sideEffectState: "none", error: { code: "deadline_exceeded" } } });
		expect(executions).toBe(1);

		const durable = new InMemoryToolPipelineStorage();
		const transport = new FoundationToolPipeline({
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
		const durable = new InMemoryToolPipelineStorage();
		let failFinalize = true;
		let sideEffects = 0;
		let active = 0;
		let peak = 0;
		const storage: ToolPipelineStorage = {
			writeIntent: (intent) => durable.writeIntent(intent),
			finalizeReceipt: async (receipt) => failFinalize ? Result.err(new FoundationError("serialization_failed", "simulated crash")) : durable.finalizeReceipt(receipt),
			listIntents: () => durable.listIntents(),
			listReceipts: () => durable.listReceipts(),
		};
		const make = () => new FoundationToolPipeline({
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

	it("folds identical durable receipt replays and rejects an unknown state hidden by a later success", async () => {
		const durable = new InMemoryToolPipelineStorage();
		let executions = 0;
		const registryWithResult = registry([tool("durable", async () => {
			executions += 1;
			return { ok: true, sideEffectState: "none" as const, result: { schemaVersion: 1 as const, content: [{ type: "text" as const, text: "durable result" }] } };
		})]);
		const firstPipeline = new FoundationToolPipeline({ registry: registryWithResult, storage: durable, guard: allowAllGuards(), idGenerator: (() => { let id = 0; return (prefix: string) => `${prefix}-${++id}`; })() });
		const first = await firstPipeline.execute({ toolCallId: "durable-call", toolName: "durable", idempotencyKey: "durable-key", args: { value: "x" } }, context());
		if (!first.ok) throw first.error;
		const { digest: _digest, ...withoutDigest } = first.value;
		const envelopeReplay = finalizeToolReceipt({ ...withoutDigest, toolReceiptId: "envelope-replay", completedAt: "later" });
		const replayStorage: ToolPipelineStorage = {
			writeIntent: (intent) => durable.writeIntent(intent),
			finalizeReceipt: (receipt) => durable.finalizeReceipt(receipt),
			listIntents: () => durable.listIntents(),
			listReceipts: async () => [first.value, envelopeReplay],
		};
		const replay = await new FoundationToolPipeline({ registry: registryWithResult, storage: replayStorage, guard: allowAllGuards(), idGenerator: (prefix) => `${prefix}-replay` }).execute({ toolCallId: "durable-call", toolName: "durable", idempotencyKey: "durable-key", args: { value: "x" } }, context());
		expect(replay).toMatchObject({ ok: true, value: { outcome: "succeeded", deduplicatedFrom: expect.any(String), result: { content: [{ type: "text", text: "durable result" }] } } });
		expect(executions).toBe(1);

		const { result: _unknownResult, artifacts: _unknownArtifacts, ...withoutResult } = withoutDigest;
		const unknownReplay = finalizeToolReceipt({ ...withoutResult, toolReceiptId: "unknown-replay", outcome: "side_effect_unknown", sideEffectState: "side_effect_unknown", error: { code: "side_effect_unknown", message: "outcome unknown", retryable: false } });
		const successAfterUnknown = finalizeToolReceipt({ ...withoutDigest, toolReceiptId: "success-after-unknown", completedAt: "latest" });
		const conflictStorage: ToolPipelineStorage = {
			writeIntent: (intent) => durable.writeIntent(intent),
			finalizeReceipt: (receipt) => durable.finalizeReceipt(receipt),
			listIntents: () => durable.listIntents(),
			listReceipts: async () => [first.value, unknownReplay, successAfterUnknown],
		};
		const conflict = await new FoundationToolPipeline({ registry: registryWithResult, storage: conflictStorage, guard: allowAllGuards() }).execute({ toolCallId: "durable-call", toolName: "durable", idempotencyKey: "durable-key", args: { value: "x" } }, context());
		expect(conflict).toMatchObject({ ok: false, error: { code: "session_ledger_conflict" } });
	});

	it("rejects duplicate receipts whose error or gate semantics differ in either order", async () => {
		const firstPipeline = new FoundationToolPipeline({ registry: registry([tool("semantic", async () => ({ ok: true, sideEffectState: "none" as const }))]), guard: allowAllGuards(), idGenerator: (prefix) => `${prefix}-first` });
		const first = await firstPipeline.execute({ toolCallId: "semantic-call", toolName: "semantic", idempotencyKey: "semantic-key", args: { value: "x" } }, context());
		if (!first.ok) throw first.error;
		const { digest: _digest, result: _result, artifacts: _artifacts, ...withoutSuccess } = first.value;
		const failedOne = finalizeToolReceipt({ ...withoutSuccess, toolReceiptId: "semantic-failed-one", outcome: "failed", sideEffectState: "none", error: { code: "failed-one", message: "first failure", retryable: false } });
		const changedGates = failedOne.gates.map((gate, index) => index === 0 ? { ...gate, reason: "different gate reason" } : gate);
		const failedTwo = finalizeToolReceipt({ ...withoutSuccess, toolReceiptId: "semantic-failed-two", outcome: "failed", sideEffectState: "none", gates: changedGates, error: { code: "failed-two", message: "second failure", retryable: false } });
		for (const receipts of [[failedOne, failedTwo], [failedTwo, failedOne]]) {
			const storage: ToolPipelineStorage = {
				writeIntent: async (intent) => Result.ok(intent),
				finalizeReceipt: async (receipt) => Result.ok({ toolReceiptRef: receipt.toolReceiptId }),
				listIntents: async () => [],
				listReceipts: async () => receipts,
			};
			const replay = await new FoundationToolPipeline({ registry: registry([tool("semantic", async () => ({ ok: true, sideEffectState: "none" as const }))]), storage, guard: allowAllGuards() }).execute({ toolCallId: "semantic-call", toolName: "semantic", idempotencyKey: "semantic-key", args: { value: "x" } }, context());
			expect(replay).toMatchObject({ ok: false, error: { code: "session_ledger_conflict" } });
		}
	});

	it("requires exact image ArtifactRef equality between result content and receipt artifacts", async () => {
		const artifact = (artifactId: string) => ({ schemaVersion: 1 as const, artifactId, mediaType: "image/png", digest: `sha256:${"a".repeat(64)}`, producer: "provider-1", sizeBytes: 3 });
		const firstArtifact = artifact("artifact-one");
		const secondArtifact = artifact("artifact-two");
		const extraArtifact = artifact("artifact-extra");
		const durable = new InMemoryToolPipelineStorage();
		const pipeline = new FoundationToolPipeline({
			registry: registry([tool("image", async () => ({ ok: true, sideEffectState: "none" as const, artifacts: [firstArtifact, secondArtifact], result: { schemaVersion: 1 as const, content: [{ type: "image" as const, artifact: firstArtifact }, { type: "image" as const, artifact: secondArtifact }] } }))]),
			storage: durable,
			guard: allowAllGuards(),
			idGenerator: (prefix) => `${prefix}-image`,
		});
		const first = await pipeline.execute({ toolCallId: "image-call", toolName: "image", args: { value: "x" } }, context());
		if (!first.ok) throw first.error;
		expect(validateToolReceipt(first.value).ok).toBe(true);
		const { digest: _digest, ...withoutDigest } = first.value;
		for (const artifacts of [[firstArtifact, secondArtifact, extraArtifact], [firstArtifact, firstArtifact], [firstArtifact]]) {
			const invalid = validateToolReceipt(finalizeToolReceipt({ ...withoutDigest, toolReceiptId: `invalid-${artifacts.length}`, artifacts }));
			expect(invalid).toMatchObject({ ok: false, error: { code: "side_effect_unknown" } });
		}
	});

	it("rejects forged text/plain image ArtifactRefs before any provider execution", async () => {
		const artifact = { schemaVersion: 1 as const, artifactId: "forged-image", mediaType: "text/plain", digest: `sha256:${"a".repeat(64)}`, producer: "provider-1", sizeBytes: 3 };
		const payload = { schemaVersion: 1 as const, content: [{ type: "image" as const, artifact }] };
		expect(validateToolResultPayload(payload)).toMatchObject({ ok: false, error: { code: "side_effect_unknown" } });
	});

	it("keeps the same toolCallId separate across operations and fails closed on key conflicts", async () => {
		const storage = new InMemoryToolPipelineStorage();
		let sideEffects = 0;
		const options = {
			registry: registry([tool("identity", async () => { sideEffects += 1; return { ok: true, sideEffectState: "none" }; })]),
			storage,
			guard: allowAllGuards(),
			idGenerator: (() => { let id = 0; return (prefix: string) => `${prefix}-${++id}`; })(),
		};
		const pipeline = new FoundationToolPipeline(options);
		const first = await pipeline.execute({ toolCallId: "shared-call", toolName: "identity", idempotencyKey: "operation-a-key", args: { value: "a" } }, operationContext("operation-a"));
		const second = await pipeline.execute({ toolCallId: "shared-call", toolName: "identity", idempotencyKey: "operation-b-key", args: { value: "b" } }, operationContext("operation-b"));
		expect(first.ok).toBe(true);
		expect(second.ok).toBe(true);
		expect(sideEffects).toBe(2);
		expect(storage.receipts.map((receipt) => receipt.binding.operationId)).toEqual(["operation-a", "operation-b"]);

		const replay = await new FoundationToolPipeline(options).execute({ toolCallId: "shared-call", toolName: "identity", idempotencyKey: "operation-a-key", args: { value: "a" } }, operationContext("operation-a"));
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
		const storage = new SessionToolPipelineStorage({
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
		const pipeline = new FoundationToolPipeline({
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
		const storage = new SessionToolPipelineStorage({
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
		const pipeline = new FoundationToolPipeline({
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
