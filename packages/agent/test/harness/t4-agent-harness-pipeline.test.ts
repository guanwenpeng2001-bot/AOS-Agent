import { createAssistantMessageEventStream, type AssistantMessage, type Model, type Models } from "@aos-agent/ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { AgentHarness, type AgentHarnessFoundationExecution, type HarnessTool } from "../../src/harness/agent-harness.ts";
import { fingerprintFoundationValue, canonicalFoundationJson, createHostTerminalGateAuthorityV1, type ArtifactStoreProvider, type FoundationJsonValue } from "../../src/harness/foundation/index.ts";
import { FoundationError } from "../../src/harness/foundation/errors.ts";
import { FoundationToolGuardV1, FoundationToolPipelineV1, SessionToolPipelineStorageV1, finalizeToolReceiptV1, validateToolIntentV1, validateToolReceiptV1, type ToolDefinitionRegistryV1, type ToolPipelineContextV1 } from "../../src/harness/tool-pipeline.ts";
import { createExecutionCorrelation } from "../../src/harness/foundation/identity.ts";
import { Result } from "../../src/harness/result.ts";
import { InMemorySessionStorage, Session } from "../../src/harness/session/index.ts";
import type { AgentContext } from "../../src/types.ts";

type ArtifactReadFailure = "none" | "missing" | "malformed" | "get_throw" | "verify_false" | "verify_throw" | "wrong_bytes" | "wrong_size";

function artifactStore(): { store: ArtifactStoreProvider; puts: () => number; gets: () => number; verifies: () => number; clear: () => void; setReadFailure: (failure: ArtifactReadFailure) => void } {
	const values = new Map<string, Uint8Array>();
	let putCount = 0;
	let getCount = 0;
	let verifyCount = 0;
	let readFailure: ArtifactReadFailure = "none";
	const store: ArtifactStoreProvider = {
		schemaVersion: 1,
		providerId: "artifact-provider",
		providerClass: "store",
		capabilities: async () => [],
		dispose: async () => undefined,
		put: async (descriptor, data) => {
			putCount += 1;
			values.set(descriptor.artifactId, new Uint8Array(data));
			return Result.ok({ schemaVersion: 1, ref: descriptor.artifactId, sizeBytes: data.byteLength });
		},
		get: async (ref) => {
			getCount += 1;
			if (readFailure === "get_throw") throw new Error("artifact get disconnected");
			if (readFailure === "malformed") return { ok: true, value: "not bytes" } as never;
			if (readFailure === "missing") return Result.err(new FoundationError("side_effect_unknown", "artifact is missing"));
			const value = values.get(ref);
			if (value === undefined) return Result.err(new FoundationError("side_effect_unknown", "artifact is missing"));
			if (readFailure === "wrong_bytes") return Result.ok(new Uint8Array([9, 8, 7]));
			if (readFailure === "wrong_size") return Result.ok(new Uint8Array([1, 2]));
			return Result.ok(new Uint8Array(value));
		},
		verify: async (artifactId) => {
			verifyCount += 1;
			if (readFailure === "verify_throw") throw new Error("artifact verify disconnected");
			if (readFailure === "verify_false") return Result.ok({ schemaVersion: 1, digestValid: false });
			return Result.ok({ schemaVersion: 1, digestValid: values.has(artifactId) });
		},
		delete: async (artifactId) => {
			values.delete(artifactId);
			return Result.ok(undefined);
		},
	};
	return { store, puts: () => putCount, gets: () => getCount, verifies: () => verifyCount, clear: () => values.clear(), setReadFailure: (failure) => { readFailure = failure; } };
}

function foundationJson(value: unknown): FoundationJsonValue {
	if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") return value;
	if (Array.isArray(value)) return value.map((item) => foundationJson(item));
	if (typeof value !== "object") throw new Error("expected JSON value");
	const result: { [key: string]: FoundationJsonValue } = {};
	for (const [key, item] of Object.entries(value as Record<string, unknown>)) result[key] = foundationJson(item);
	return result;
}

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

function consumerModels(toolName: string): { model: Model<"openai-responses">; models: Models; requests: () => number; contexts: () => readonly AgentContext[] } {
	const model = { id: "tool-consumer-model", name: "Tool Consumer Model", api: "openai-responses" as const, provider: "openai" as const, baseUrl: "", reasoning: false, input: ["text"] as ("text")[], cost: { input: 0, output: 0 }, contextWindow: 1000, maxTokens: 1000 } as Model<"openai-responses">;
	let requests = 0;
	const contexts: AgentContext[] = [];
	const models = {
		getModel: () => model,
		streamSimple: (...args: unknown[]) => {
			const context = args[1];
			if (context !== null && typeof context === "object") {
				const messages = (context as { messages?: unknown }).messages;
				if (Array.isArray(messages)) contexts.push({ systemPrompt: "", messages: structuredClone(messages) as AgentContext["messages"], tools: [] });
			}
			const stream = createAssistantMessageEventStream();
			requests += 1;
			const message: AssistantMessage = requests === 1
				? { role: "assistant", content: [{ type: "toolCall", id: "consumer-call", name: toolName, arguments: {} }], api: model.api, provider: model.provider, model: model.id, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: Date.now() }
				: { role: "assistant", content: [{ type: "text", text: "done" }], api: model.api, provider: model.provider, model: model.id, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() };
			stream.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message });
			return stream;
		},
	} as unknown as Models;
	return { model, models, requests: () => requests, contexts: () => contexts };
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
		const write: HarnessTool = { name: "write", label: "Write", description: "write", parameters: Type.Object({ value: Type.String() }, { additionalProperties: false }), sideEffectState: "none", execute: async () => { sideEffects += 1; return { content: [{ type: "text", text: "written" }], details: { token: "opaque", data: "payload", message: "ordinary detail" } }; } };
		const foundation = execution();
		const { harness } = await AgentHarness.create({ session, models, model, tools: [write], foundationExecution: foundation, toolPipelineOptions: { guard: allowAllGuards() } });
		const result = await harness.prompt("invoke write");
		expect(result.ok).toBe(true);
		expect(sideEffects).toBe(1);
		const intents = await session.findFoundationRecords({ kind: "intent", objectType: "tool_intent", order: "oldestFirst" });
		const receipts = await session.findFoundationRecords({ kind: "fact", objectType: "tool_receipt", order: "oldestFirst" });
		expect(intents).toHaveLength(1);
		expect(receipts).toHaveLength(1);
		const firstReceipt = receipts[0];
		if (firstReceipt?.kind !== "fact") throw new Error("missing public tool receipt");
		expect(JSON.stringify(firstReceipt.payload)).toContain('"token":"[redacted]"');
		expect(JSON.stringify(firstReceipt.payload)).toContain('"data":"[redacted]"');
		expect(JSON.stringify(firstReceipt.payload)).toContain('"message":"[redacted]"');
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
		expect(JSON.stringify(replay.ok ? replay.value.result : undefined)).toContain('"token":"[redacted]"');
		expect(sideEffects).toBe(1);
		expect((await session.findFoundationRecords({ kind: "fact", objectType: "tool_receipt", order: "oldestFirst" })).length).toBe(2);
		await session.releaseWriterLease({ fencingToken: lease.fencingToken });
	});

	it("fails all public receipt layers when text redaction would change tool semantics", async () => {
		const session = new Session(new InMemorySessionStorage({ id: "redacted-text-session", createdAt: 1 }));
		const { model, models } = consumerModels("secret-tool");
		const secretTool: HarnessTool = {
			name: "secret-tool",
			label: "Secret tool",
			description: "secret tool",
			parameters: Type.Object({}, { additionalProperties: false }),
			sideEffectState: "none",
			execute: async () => ({ content: [{ type: "text" as const, text: "token=plaintext-secret" }], details: {} }),
		};
		const { harness } = await AgentHarness.create({ session, models, model, tools: [secretTool], foundationExecution: execution(), toolPipelineOptions: { guard: allowAllGuards() } });
		const result = await harness.prompt("invoke secret tool");
		expect(result.ok).toBe(true);
		const facts = (await session.findFoundationRecords({ kind: "fact", order: "oldestFirst" })).filter((record) => record.kind === "fact");
		const payloadFor = (objectType: string): unknown => facts.find((record) => record.objectType === objectType)?.payload;
		expect(payloadFor("tool_receipt")).toMatchObject({ outcome: "side_effect_unknown", sideEffectState: "side_effect_unknown" });
		expect(payloadFor("attempt_receipt")).toMatchObject({ status: "failed", sideEffectState: "side_effect_unknown" });
		expect(payloadFor("task_result")).toMatchObject({ status: "failed" });
		expect(payloadFor("run_receipt")).toMatchObject({ terminalStatus: "failed" });
		expect(JSON.stringify(facts)).not.toContain("plaintext-secret");
		expect(JSON.stringify(facts)).not.toContain("[redacted]");
		await harness.close();
	});

	it("persists image tool results as verified ArtifactRefs and never writes base64 to the Session ledger", async () => {
		const session = new Session(new InMemorySessionStorage({ id: "image-tool-session", createdAt: 1 }));
		const artifacts = artifactStore();
		const { model, models, contexts } = consumerModels("image-tool");
		let executions = 0;
		const imageTool: HarnessTool = {
			name: "image-tool",
			label: "Image tool",
			description: "image tool",
			parameters: Type.Object({}, { additionalProperties: false }),
			sideEffectState: "none",
			execute: async () => {
				executions += 1;
				return { content: [{ type: "image" as const, data: "AQID", mimeType: "image/png" }], details: {} };
			},
		};
		const foundation = execution();
		const first = await AgentHarness.create({ session, models, model, tools: [imageTool], foundationExecution: foundation, artifactStore: artifacts.store, toolPipelineOptions: { guard: allowAllGuards() } });
		const result = await first.harness.prompt("invoke image tool");
		expect(result.ok).toBe(true);
		expect(executions).toBe(1);
		expect(artifacts.puts()).toBe(1);
		expect(artifacts.gets()).toBeGreaterThan(0);
		expect(artifacts.verifies()).toBeGreaterThan(0);
		const entries = await session.view("main").findEntries({ order: "oldestFirst" });
		const toolResultEntries = entries.filter((entry) => entry.type === "custom" && entry.customType === "foundation.tool_result");
		expect(toolResultEntries).toHaveLength(1);
		const leafId = await session.view("main").getLeafId();
		if (leafId === null) throw new Error("missing image session leaf");
		const branchEntries = await session.view("main").findEntriesOnBranch({ start: leafId, order: "oldestFirst" });
		expect(branchEntries.some((entry) => entry.type === "custom" && entry.customType === "foundation.tool_result")).toBe(true);
		const started = (await session.findRecords({ lane: "main", type: "tool_started", order: "oldestFirst" }))[0];
		if (started?.type !== "tool_started") throw new Error("missing image tool start");
		expect(toolResultEntries[0]?.id).toBe(started.resultEntryId);
		const persistedResult = toolResultEntries[0]?.type === "custom" ? JSON.stringify(toolResultEntries[0].data) : "";
		expect(persistedResult).toContain('"type":"image"');
		expect(persistedResult).toContain('"artifact"');
		expect(JSON.stringify(toolResultEntries)).not.toContain("AQID");
		const receipts = await session.findFoundationRecords({ kind: "fact", objectType: "tool_receipt", order: "oldestFirst" });
		expect(JSON.stringify(receipts)).not.toContain("AQID");
		await first.harness.close();
		const restarted = await AgentHarness.create({ session, models, model, tools: [imageTool], foundationExecution: foundation, artifactStore: artifacts.store, entryProjectors: { "foundation.tool_result": () => [{ role: "user" as const, content: [{ type: "text" as const, text: "caller override" }], timestamp: Date.now() }] }, toolPipelineOptions: { guard: allowAllGuards() } });
		await restarted.harness.resume();
		const restartedLeaf = await session.view("main").getLeafId();
		if (restartedLeaf === null) throw new Error("missing restarted image leaf");
		const restartedBranch = await session.view("main").findEntriesOnBranch({ start: restartedLeaf, order: "oldestFirst" });
		expect(restartedBranch.some((entry) => entry.type === "custom" && entry.customType === "foundation.tool_result")).toBe(true);
		const hydrated = await restarted.harness.prompt("read prior image");
		expect(hydrated.ok).toBe(true);
		expect(executions).toBe(1);
		expect(artifacts.puts()).toBe(1);
		expect(artifacts.gets()).toBeGreaterThan(1);
		const toolResultMessages = contexts().flatMap((context) => context.messages.filter((message) => message.role === "toolResult"));
		expect(toolResultMessages.length).toBeGreaterThanOrEqual(2);
		const canonicalToolResult = (message: (typeof toolResultMessages)[number]): string => canonicalFoundationJson({ toolCallId: message.toolCallId, toolName: message.toolName, content: message.content, details: message.details, isError: message.isError, ...(message.usage === undefined ? {} : { usage: message.usage }) });
		expect(canonicalToolResult(toolResultMessages[0]!)).toBe(canonicalToolResult(toolResultMessages.at(-1)!));
		expect(JSON.stringify(contexts())).not.toContain("caller override");
		const allEntries = await session.findEntries({ order: "oldestFirst" });
		const allRecords = await session.findRecords({ order: "oldestFirst" });
		expect(JSON.stringify({ entries: allEntries, records: allRecords })).not.toContain("AQID");
		await restarted.harness.close();
	});

	it("fails closed before a model request when a hydrated ArtifactRef is missing or malformed", async () => {
		const failures: ArtifactReadFailure[] = ["missing", "malformed", "get_throw", "verify_false", "verify_throw"];
		for (const failure of failures) {
			const session = new Session(new InMemorySessionStorage({ id: `image-hydration-${failure}`, createdAt: 1 }));
			const artifacts = artifactStore();
			const { model, models, requests } = consumerModels(`image-hydration-${failure}`);
			const imageTool: HarnessTool = {
				name: `image-hydration-${failure}`,
				label: "Image tool",
				description: "image tool",
				parameters: Type.Object({}, { additionalProperties: false }),
				sideEffectState: "none",
				execute: async () => ({ content: [{ type: "image" as const, data: "AQID", mimeType: "image/png" }], details: {} }),
			};
			const first = await AgentHarness.create({ session, models, model, tools: [imageTool], foundationExecution: execution(), artifactStore: artifacts.store, toolPipelineOptions: { guard: allowAllGuards() } });
			const firstResult = await first.harness.prompt("persist image before hydration failure");
			expect(firstResult).toMatchObject({ ok: true, value: { kind: "completed" } });
			const requestsBeforeHydration = requests();
			await first.harness.close();
			artifacts.setReadFailure(failure);
			const restarted = await AgentHarness.create({ session, models, model, tools: [imageTool], foundationExecution: execution(), artifactStore: artifacts.store, toolPipelineOptions: { guard: allowAllGuards() } });
			const hydrated = await restarted.harness.prompt("read image after hydration failure");
			expect(hydrated).toMatchObject({ ok: true, value: { kind: "failed", error: { code: "side_effect_unknown" } } });
			expect(requests()).toBe(requestsBeforeHydration);
			const facts = (await session.findFoundationRecords({ kind: "fact", order: "oldestFirst" })).filter((record) => record.kind === "fact");
			const runReceipts = facts.filter((record) => record.objectType === "run_receipt");
			expect(runReceipts.at(-1)?.payload).toMatchObject({ terminalStatus: "failed", terminalErrorCode: "side_effect_unknown" });
			await restarted.harness.close();
		}
	});

	it("fails all receipt layers on first artifact read/integrity failure without another provider turn", async () => {
		const failures: ArtifactReadFailure[] = ["missing", "malformed", "get_throw", "verify_false", "verify_throw", "wrong_bytes", "wrong_size"];
		for (const failure of failures) {
			const session = new Session(new InMemorySessionStorage({ id: `image-first-${failure}`, createdAt: 1 }));
			const artifacts = artifactStore();
			artifacts.setReadFailure(failure);
			const { model, models, requests } = consumerModels(`image-first-${failure}`);
			const imageTool: HarnessTool = {
				name: `image-first-${failure}`,
				label: "Image tool",
				description: "Image tool",
				parameters: Type.Object({}, { additionalProperties: false }),
				sideEffectState: "none",
				execute: async () => ({ content: [{ type: "image" as const, data: "AQID", mimeType: "image/png" }], details: {} }),
			};
			const { harness } = await AgentHarness.create({ session, models, model, tools: [imageTool], foundationExecution: execution(), artifactStore: artifacts.store, toolPipelineOptions: { guard: allowAllGuards() } });
			const result = await harness.prompt("fail closed while storing image");
			expect(result).toMatchObject({ ok: true, value: { kind: "failed", error: { code: "side_effect_unknown" } } });
			expect(requests()).toBe(1);
			const facts = (await session.findFoundationRecords({ kind: "fact", order: "oldestFirst" })).filter((record) => record.kind === "fact");
			const payloadFor = (objectType: string): unknown => facts.find((record) => record.objectType === objectType)?.payload;
			expect(payloadFor("tool_receipt")).toMatchObject({ outcome: "side_effect_unknown", sideEffectState: "side_effect_unknown" });
			expect(payloadFor("attempt_receipt")).toMatchObject({ status: "failed", sideEffectState: "side_effect_unknown" });
			expect(payloadFor("task_result")).toMatchObject({ status: "failed" });
			expect(payloadFor("run_receipt")).toMatchObject({ terminalStatus: "failed" });
			await harness.close();
		}
	});

	it("rejects an orphan reserved custom result before invoking the model provider", async () => {
		const session = new Session(new InMemorySessionStorage({ id: "orphan-custom-session", createdAt: 1 }));
		await session.appendCustomEntry("foundation.tool_result", {
			schemaVersion: 1,
			runId: "orphan-run",
			operationId: "orphan-run",
			toolCallId: "orphan-call",
			toolName: "orphan-tool",
			isError: false,
			result: { schemaVersion: 1, content: [{ type: "text", text: "forged result" }] },
		});
		const { model, models, requests } = consumerModels("orphan-tool");
		const tool: HarnessTool = {
			name: "orphan-tool",
			label: "Orphan tool",
			description: "orphan tool",
			parameters: Type.Object({}, { additionalProperties: false }),
			sideEffectState: "none",
			execute: async () => ({ content: [{ type: "text" as const, text: "never" }], details: {} }),
		};
		const { harness } = await AgentHarness.create({ session, models, model, tools: [tool], foundationExecution: execution(), toolPipelineOptions: { guard: allowAllGuards() } });
		const result = await harness.prompt("must reject orphan custom");
		expect(result).toMatchObject({ ok: true, value: { kind: "failed", error: { code: "side_effect_unknown" } } });
		expect(requests()).toBe(0);
		const facts = (await session.findFoundationRecords({ kind: "fact", order: "oldestFirst" })).filter((record) => record.kind === "fact");
		expect(facts.filter((record) => record.objectType === "run_receipt").at(-1)?.payload).toMatchObject({ terminalStatus: "failed", terminalErrorCode: "side_effect_unknown" });
		await harness.close();
	});

	it("backfills a missing tool UsageRecord from an existing deferred custom result exactly once", async () => {
		const session = new Session(new InMemorySessionStorage({ id: "deferred-tool-usage-session", createdAt: 1 }));
		const target = {
			type: "custom" as const,
			id: "deferred-tool-result",
			customType: "foundation.tool_result",
			data: {
				schemaVersion: 1 as const,
				runId: "deferred-run",
				operationId: "deferred-run",
				toolCallId: "deferred-call",
				toolName: "deferred-tool",
				isError: false,
				result: {
					schemaVersion: 1 as const,
					content: [{ type: "text" as const, text: "deferred result" }],
					usage: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 5, cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 } },
				},
			},
		};
		await session.appendRecord({ type: "operation_started", id: "deferred-run", lane: "main", sourceLeafId: null, intent: { kind: "run", originalPrompt: [], initialMessages: [target] } });
		await session.appendRecord({ type: "write_deferred", id: "deferred-write", lane: "main", runId: "deferred-run", target });
		const { model, models } = consumerModels("deferred-tool");
		const foundation = execution();
		const first = await AgentHarness.create({ session, models, model, tools: [], foundationExecution: foundation, drive: "manual", toolPipelineOptions: { guard: allowAllGuards() } });
		await first.harness.close();
		const reopened = await AgentHarness.create({ session, models, model, tools: [], foundationExecution: foundation, drive: "manual", toolPipelineOptions: { guard: allowAllGuards() } });
		const action = await reopened.harness.executeAction();
		expect(action).toMatchObject({ kind: "append_entry", entryId: target.id });
		const usage = await session.findRecords({ lane: "main", type: "usage", order: "oldestFirst" });
		expect(usage).toHaveLength(1);
		expect(usage[0]).toMatchObject({ cause: "tool", entryId: target.id, toolCallId: "deferred-call", usage: { input: 2, output: 3, totalTokens: 5 } });
		await reopened.harness.close();
	});

	it("fails all public receipt layers when an image result has no ArtifactStore", async () => {
		const session = new Session(new InMemorySessionStorage({ id: "image-tool-missing-store", createdAt: 1 }));
		const { model, models } = consumerModels("image-tool-missing-store");
		const imageTool: HarnessTool = {
			name: "image-tool-missing-store",
			label: "Image tool",
			description: "image tool",
			parameters: Type.Object({}, { additionalProperties: false }),
			sideEffectState: "none",
			execute: async () => ({ content: [{ type: "image" as const, data: "AQID", mimeType: "image/png" }], details: {} }),
		};
		const { harness } = await AgentHarness.create({ session, models, model, tools: [imageTool], foundationExecution: execution(), toolPipelineOptions: { guard: allowAllGuards() } });
		const result = await harness.prompt("invoke image tool without store");
		expect(result.ok).toBe(true);
		const facts = (await session.findFoundationRecords({ kind: "fact", order: "oldestFirst" })).filter((record) => record.kind === "fact");
		const payloadFor = (objectType: string): unknown => facts.find((record) => record.objectType === objectType)?.payload;
		expect(payloadFor("tool_receipt")).toMatchObject({ outcome: "side_effect_unknown", sideEffectState: "side_effect_unknown" });
		expect(payloadFor("attempt_receipt")).toMatchObject({ status: "failed", sideEffectState: "side_effect_unknown" });
		expect(payloadFor("task_result")).toMatchObject({ status: "failed" });
		expect(payloadFor("run_receipt")).toMatchObject({ terminalStatus: "failed" });
		expect(JSON.stringify(facts)).not.toContain("AQID");
		await harness.close();
	});

	it("fails closed when duplicate durable receipts for one tool call conflict, even if success is written last", async () => {
		const session = new Session(new InMemorySessionStorage({ id: "duplicate-receipt-session", createdAt: 1 }));
		const { model, models } = consumerModels("duplicate-receipt-tool");
		const foundation = execution();
		const originalAppend = session.appendFoundationRecord.bind(session);
		let injected = false;
		session.appendFoundationRecord = async (record) => {
			const accepted = await originalAppend(record);
			if (!injected && record.kind === "fact" && record.objectType === "tool_receipt" && record.payload !== undefined) {
				injected = true;
				const checked = validateToolReceiptV1(record.payload);
				if (!checked.ok) throw checked.error;
				const { digest: _digest, result: _result, artifacts: _artifacts, ...withoutResult } = checked.value;
				const unknown = finalizeToolReceiptV1({
					...withoutResult,
					toolReceiptId: "duplicate-unknown",
					outcome: "side_effect_unknown",
					sideEffectState: "side_effect_unknown",
					error: { code: "side_effect_unknown", message: "duplicate outcome unknown", retryable: false },
				});
				const { digest: _successDigest, ...withoutSuccessDigest } = checked.value;
				const success = finalizeToolReceiptV1({ ...withoutSuccessDigest, toolReceiptId: "duplicate-success" });
				await originalAppend({ ...record, id: "tool_receipt:duplicate-unknown", objectId: unknown.toolReceiptId, clientRequestId: "duplicate-unknown", payload: foundationJson(unknown) });
				await originalAppend({ ...record, id: "tool_receipt:duplicate-success", objectId: success.toolReceiptId, clientRequestId: "duplicate-success", payload: foundationJson(success) });
			}
			return accepted;
		};
		const tool: HarnessTool = {
			name: "duplicate-receipt-tool",
			label: "Duplicate receipt tool",
			description: "duplicate receipt fixture",
			parameters: Type.Object({}, { additionalProperties: false }),
			sideEffectState: "none",
			execute: async () => ({ content: [{ type: "text" as const, text: "ok" }], details: {} }),
		};
		const { harness } = await AgentHarness.create({ session, models, model, tools: [tool], foundationExecution: foundation, toolPipelineOptions: { guard: allowAllGuards() } });
		const result = await harness.prompt("duplicate receipt");
		expect(result.ok).toBe(true);
		expect(injected).toBe(true);
		const facts = (await session.findFoundationRecords({ kind: "fact", order: "oldestFirst" })).filter((record) => record.kind === "fact");
		expect(facts.filter((record) => record.objectType === "tool_receipt")).toHaveLength(3);
		expect(facts.find((record) => record.objectType === "attempt_receipt")?.payload).toMatchObject({ status: "failed", sideEffectState: "side_effect_unknown" });
		expect(facts.find((record) => record.objectType === "task_result")?.payload).toMatchObject({ status: "failed" });
		expect(facts.find((record) => record.objectType === "run_receipt")?.payload).toMatchObject({ terminalStatus: "failed" });
		await harness.close();
	});

	it("preserves consumer AgentTool outcomes, usage, side effects, and terminal receipts", async () => {
		const cases = [
			{ name: "known no side effect", sideEffectState: "none" as const, throws: false, expectedOutcome: "succeeded", expectedStatus: "succeeded", expectedRunStatus: "completed", usage: true },
			{ name: "unknown side effect", sideEffectState: undefined, throws: false, expectedOutcome: "side_effect_unknown", expectedStatus: "failed", expectedRunStatus: "failed", usage: false },
			{ name: "underlying failure with known no side effect", sideEffectState: "none" as const, throws: true, expectedOutcome: "failed", expectedStatus: "failed", expectedRunStatus: "failed", usage: false },
			{ name: "underlying throw with non-none side effect", sideEffectState: "unknown" as const, throws: true, expectedOutcome: "side_effect_unknown", expectedStatus: "failed", expectedRunStatus: "failed", usage: false },
			{ name: "underlying throw with unknown side effect", sideEffectState: undefined, throws: true, expectedOutcome: "side_effect_unknown", expectedStatus: "failed", expectedRunStatus: "failed", usage: false },
		] as const;
		for (const current of cases) {
			const session = new Session(new InMemorySessionStorage({ id: `consumer-${current.name}`, createdAt: 1 }));
			const { model, models } = consumerModels("consumer-tool");
			const foundation = { ...execution(), settlement: { tests: [{ name: "consumer receipt", required: true, status: "passed" as const }], evidence: [] } };
			let calls = 0;
			const tool: HarnessTool = {
				name: "consumer-tool",
				label: "Consumer tool",
				description: "consumer outcome fixture",
				parameters: Type.Object({}, { additionalProperties: false }),
				...(current.sideEffectState === undefined ? {} : { sideEffectState: current.sideEffectState }),
				execute: async () => {
					calls += 1;
					if (current.throws) throw new Error(`${current.name} failed`);
					return {
						content: [{ type: "text" as const, text: "consumer result" }],
						details: {},
						...(current.usage ? { usage: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 5, cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 } } } : {}),
					};
				},
			};
			const { harness } = await AgentHarness.create({ session, models, model, tools: [tool], foundationExecution: foundation, toolPipelineOptions: { guard: allowAllGuards() } });
			const result = await harness.prompt(current.name);
			expect(result.ok, current.name).toBe(true);
			expect(calls, `${current.name} must not retry unknown execution`).toBe(1);
			const facts = await session.findFoundationRecords({ kind: "fact", order: "oldestFirst" });
			const factPayload = (objectType: string): unknown => {
				const record = facts.find((candidate) => candidate.kind === "fact" && candidate.objectType === objectType);
				return record?.kind === "fact" ? record.payload : undefined;
			};
			const toolReceipt = factPayload("tool_receipt");
			const attemptReceipt = factPayload("attempt_receipt");
			const taskResult = factPayload("task_result");
			const runReceipt = factPayload("run_receipt");
			const expectedSideEffectState = current.sideEffectState === "none" ? "none" : "side_effect_unknown";
			expect(toolReceipt).toMatchObject({ outcome: current.expectedOutcome, sideEffectState: expectedSideEffectState });
			if (current.usage) expect(toolReceipt).toMatchObject({ usage: { tokens: 5, costUsd: 0.3, toolCalls: 1 } });
			expect(attemptReceipt).toMatchObject({ status: current.expectedStatus, sideEffectState: expectedSideEffectState });
			expect(taskResult).toMatchObject({ status: current.expectedStatus });
			expect(runReceipt).toMatchObject({ terminalStatus: current.expectedRunStatus });
			if (current.throws) {
				const error = (toolReceipt as { error?: { code?: string; category?: string; retryable?: boolean } }).error;
				expect(error?.code).toBe("tool_execution_failed");
				expect(error?.retryable).toBe(false);
				expect(error?.category).toBe(current.sideEffectState === "none" ? undefined : "side_effect_unknown");
			}
			await harness.close();
		}
	});
});
