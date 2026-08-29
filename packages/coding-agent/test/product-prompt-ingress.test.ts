import {
	AgentHarness,
	createScopedMemoryStore,
	FoundationError,
	InMemoryRoleRegistry,
	InMemorySessionStorage,
	Result,
	Session,
	SessionLedger,
	sha256HexValue,
	type FoundationProviderExecutionOptions,
	type FoundationJsonValue,
	type AgentBinding,
	type ArtifactStoreProvider,
	type McpCapabilityBinding,
	type McpToolRoute,
	type QuotaProvider,
	type SandboxOperationProvider,
	type SandboxOperationRequest,
	type StreamFn,
	type ScopedModelGateway,
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
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { deriveProductPromptModelProfileId } from "../src/core/runtime/prompt-binding-authority.ts";
import { ProductPromptIngress } from "../src/core/runtime/prompt-ingress.ts";
import { SubagentComposition } from "../src/core/subagent/composition.ts";
import { createCodingAgentHarnessFromTrustedProvidersForTest } from "../src/server/create-harness.ts";

const MODEL = getModel("openai", "gpt-4o-mini");
const EMPTY_CAPABILITY_BINDING_ID = "capability-binding-product-empty";

function emptyMcpSelectionSource() {
	return {
		capabilityBinding: { id: EMPTY_CAPABILITY_BINDING_ID, descriptors: [], toolAllowlist: [] },
		routeCatalog: [],
	};
}

function activeDependencySnapshot(
	name: string,
	context: { readonly runId: string },
): FoundationJsonValue {
	if (name === "capability") return { name, state: "active", bindingId: EMPTY_CAPABILITY_BINDING_ID };
	if (name === "policy") return { name, state: "active" };
	return { name, runId: context.runId, state: "active" };
}

class LeaseCountingStorage extends InMemorySessionStorage {
	acquireCount = 0;
	releaseCount = 0;

	override async acquireWriterLease(options: Parameters<InMemorySessionStorage["acquireWriterLease"]>[0]) {
		this.acquireCount += 1;
		return super.acquireWriterLease(options);
	}

	override async releaseWriterLease(options: Parameters<InMemorySessionStorage["releaseWriterLease"]>[0]): Promise<void> {
		this.releaseCount += 1;
		return super.releaseWriterLease(options);
	}
}

function workerProvider(): SandboxOperationProvider {
	return {
		schemaVersion: 1,
		providerClass: "operation_worker",
		providerId: "test.operation-worker",
		capabilities: async () => [{ schemaVersion: 1, id: "tool_gateway", version: 1 }],
		start: async (request: SandboxOperationRequest, options: FoundationProviderExecutionOptions = {}) => {
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

describe("ProductPromptIngress", () => {
	it("executes explicit in_process Child Agents through the production ingress and exposes only a durable safe next-turn result", async () => {
		if (MODEL === undefined) throw new Error("Test model is unavailable");
		const runId = "product-run-native-child";
		const storage = new LeaseCountingStorage({ id: "product-native-child", createdAt: 1 });
		const session = new Session(storage);
		const baseModels = createModels();
		const models = Object.create(baseModels) as typeof baseModels;
		const originalGetModel = baseModels.getModel.bind(baseModels);
		models.getModel = (provider, id) => provider === MODEL.provider && id === MODEL.id ? MODEL : originalGetModel(provider, id);
		const parentPrompts: string[] = [];
		const streamFunction: StreamFn = (_model, context) => {
			const user = context.messages.at(-1);
			if (user?.role === "user") {
				parentPrompts.push(typeof user.content === "string"
					? user.content
					: user.content.filter((part) => part.type === "text").map((part) => part.text).join(""));
			}
			const stream = createAssistantMessageEventStream();
			const message = response("parent-complete");
			queueMicrotask(() => {
				stream.push({ type: "start", partial: message });
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		};
		const created = await AgentHarness.create({ session, models, model: MODEL, drive: "automatic", streamFunction });
		const ledgers = new Map<string, SessionLedger>();
		const ledgerForLane = (laneId: string): SessionLedger => {
			let ledger = ledgers.get(laneId);
			if (ledger === undefined) {
				ledger = new SessionLedger(session, { writer: created.harness.ledger.writer, laneId });
				ledgers.set(laneId, ledger);
			}
			return ledger;
		};
		const registry = new InMemoryRoleRegistry({ now: () => "2026-08-20T00:00:00.000Z" });
		const registered = registry.create({ definition: {
			schemaVersion: 1,
			roleId: "reviewer",
			scope: "project",
			slug: "reviewer",
			name: "Reviewer",
			description: "Review explicit product work",
			revision: 0,
			persona: "Review the child task.",
			modelProfileRef: {
				schemaVersion: 1,
				type: "model_profile",
				id: deriveProductPromptModelProfileId(MODEL, "off"),
				revision: 1,
			},
			capabilitySelector: { policy: "none" },
			skillSelector: { policy: "none" },
			mcpSelector: { policy: "none" },
		} });
		if (!registered.ok) throw registered.error;
		const quota: QuotaProvider = {
			schemaVersion: 1,
			providerId: "product-child-quota",
			providerClass: "quota",
			capabilities: async () => [],
			reserve: async (attribution, budget) => Result.ok({ schemaVersion: 1, reservationId: `reservation-${attribution.attemptId}`, attribution, budget, grantedAt: "2026-08-20T00:00:00.000Z" }),
			settle: async (_reservation, usage) => Result.ok(usage),
			dispose: async () => {},
		};
		const modelGateway = {
			schemaVersion: 1 as const,
			providerId: "product-child-model",
			providerClass: "gateway" as const,
			capabilities: async () => [],
			stream: async () => Result.err(new FoundationError("subagent_lost", "not used")),
			dispose: async () => {},
		} as unknown as ScopedModelGateway;
		const toolGateway = {
			schemaVersion: 1 as const,
			providerId: "product-child-tool",
			providerClass: "gateway" as const,
			capabilities: async () => [],
			execute: async () => Result.err(new FoundationError("subagent_lost", "not used")),
			dispose: async () => {},
		} as unknown as ToolGateway;
		const artifactStore = {
			schemaVersion: 1 as const,
			providerId: "product-child-artifacts",
			providerClass: "store" as const,
			capabilities: async () => [],
			put: async () => Result.err(new FoundationError("subagent_lost", "not used")),
			get: async () => Result.err(new FoundationError("subagent_lost", "not used")),
			verify: async () => Result.ok({ schemaVersion: 1 as const, digestValid: true }),
			delete: async () => Result.ok(undefined),
			dispose: async () => {},
		} as unknown as ArtifactStoreProvider;
		const parentMemory = (parentAgentInstanceId: string) => ({
			store: createScopedMemoryStore(
				created.harness.ledger.memory,
				"session",
				{ ownerId: parentAgentInstanceId, scopeId: `parent:${parentAgentInstanceId}`, createdBy: "system" },
				{ ownerId: parentAgentInstanceId, scopeId: `parent:${parentAgentInstanceId}` },
			),
			parentAgentInstanceId,
		});
		const fallbackMemory = parentMemory("configured-parent");
		let replaceLeaseBeforeChildPersistence = false;
		let replacementFencingToken: string | undefined;
		let selectedForkScope: "none" | "recent_n" = "none";
		const composition = new SubagentComposition({
			schemaVersion: 1,
			enabled: true,
			session,
			writer: created.harness.ledger.writer,
			ledger: ledgerForLane("main"),
			ledgerForLane,
			sessionId: "product-native-child",
			parentLaneId: "main",
			quota,
			modelGateway,
			toolGateway,
			artifactStore,
			createHarness: async () => ({
				promptOnLane: async () => Result.ok({ runId: "child-run", kind: "completed" as const, leafId: "child-leaf", finalEntryId: "child-entry", finalMessage: { role: "assistant" as const, content: [{ type: "text" as const, text: "child-complete" }] } }),
				resumeOnLane: async () => Result.err({ message: "not used" }),
				createLane: async () => Result.ok({ name: "child-lane" }),
				abort: async () => Result.ok({ runId: "child-run", steer: [], followUp: [] }),
				close: async () => undefined,
			} as unknown as AgentHarness),
			loadParentContext: async () => Result.err(new FoundationError("subagent_context_fork_invalid", "none scope has no parent snapshot")),
			parentMemory: fallbackMemory,
			parentMemoryForAgent: parentMemory,
			fork: { executable: process.execPath, entrypoint: fileURLToPath(new URL("../src/child-agent-entry.ts", import.meta.url)) },
			productPrompt: {
				registry,
				scope: "project",
				providerId: "native.in_process",
				get forkScope() { return selectedForkScope; },
				mailboxRequired: true,
				resumeRequired: false,
				worktreeRequired: false,
				backgroundRequired: false,
				childModelProfile: async (_roleId, parentModelProfile) => {
					if (!replaceLeaseBeforeChildPersistence) return parentModelProfile;
					const current = await session.getWriterLease();
					if (current === null) throw new Error("Expected the canonical parent lease");
					await session.releaseWriterLease({ fencingToken: current.fencingToken });
					const replacement = await session.acquireWriterLease({ ownerId: "replacement-writer", ttlMs: 60_000 });
					replacementFencingToken = replacement.fencingToken;
					return parentModelProfile;
				},
			},
			limits: { maxDepth: 2, maxConcurrent: 1, maxTurns: 2, queueCapacity: 1, maximumQueueWaitMs: 100 },
			now: () => "2026-08-20T00:00:00.000Z",
		});
		const ingress = new ProductPromptIngress({
			session,
			harness: created.harness,
			models,
			cwd: "C:/workspace",
			currentModel: () => MODEL,
			currentThinkingLevel: () => "off",
			mcpSelectionSource: emptyMcpSelectionSource,
			dependencySnapshot: activeDependencySnapshot,
			subagents: composition,
			now: () => "2026-08-20T00:00:00.000Z",
		});
		try {
			const prompt = "@agent reviewer inspect the production chain";
			const execution = await ingress.execute({ prompt, surface: "sdk", runId });
			expect(parentPrompts).toEqual([prompt]);
			const facts = (await session.findFoundationRecords({ kind: "fact", order: "oldestFirst" }))
				.filter((record) => record.kind === "fact");
			expect(facts.filter((record) => record.objectType === "task")).toHaveLength(2);
			const childTask = facts.find((record) => record.objectType === "task" && record.objectId.startsWith("task_child_"));
			if (childTask === undefined) throw new Error("Expected the durable child TaskEnvelope");
			const childLaneId = childTask.lane;
			expect(childLaneId).toMatch(/^child_/);
			const childExecutionTypes = new Set([
				"task",
				"role_revision",
				"model_profile_revision",
				"subagent.child_binding_projection",
				"agent_binding",
				"agent_spawn",
				"agent_instance",
				"binding_epoch",
				"dispatch",
				"attempt",
				"attempt_receipt",
			]);
			const childFacts = facts.filter((record) =>
				record.correlation.taskId === childTask.objectId && childExecutionTypes.has(record.objectType));
			expect(new Set(childFacts.map((record) => record.lane))).toEqual(new Set([childLaneId]));
			const parentTask = facts.find((record) => record.objectType === "task" && record.lane === "main");
			if (parentTask === undefined) throw new Error("Expected the durable parent TaskEnvelope");
			expect(new Set(facts.map((record) => record.fencingToken)).size).toBe(1);
			expect(storage.acquireCount).toBe(1);
			expect(storage.releaseCount).toBe(0);
			expect(facts.some((record) => record.objectType === "subagent.child_binding_projection")).toBe(true);
			expect(facts.some((record) => record.objectType === "agent_spawn")).toBe(true);
			const childAttemptReceipt = facts.find((record) => record.objectType === "attempt_receipt" && record.correlation.providerId === "native.in_process");
			if (childAttemptReceipt === undefined) throw new Error("Expected the durable child AttemptReceipt");
			expect(childAttemptReceipt.lane).toBe(childLaneId);
			const childTaskResult = facts.find((record) => record.objectType === "task_result" && record.objectId.startsWith("task_result_child_"));
			if (childTaskResult === undefined) throw new Error("Expected the durable child TaskResult");
			expect(childTaskResult.lane).toBe("main");
			const runReceipts = facts.filter((record) => record.objectType === "run_receipt");
			expect(runReceipts).toHaveLength(1);
			expect(runReceipts.some((record) => (record.payload as { runReceiptId?: string }).runReceiptId?.startsWith("run_receipt_child_") === true)).toBe(false);
			const expectedAttemptReceiptIds = [execution.attemptReceipt.attemptReceiptId, childAttemptReceipt.objectId];
			expect(execution.taskResult.sourceAttemptReceiptIds).toEqual(expectedAttemptReceiptIds);
			expect(execution.runReceipt.attemptReceiptIds).toEqual(expectedAttemptReceiptIds);
			expect(runReceipts[0]).toMatchObject({
				lane: "main",
				payload: {
					attemptReceiptIds: expectedAttemptReceiptIds,
				},
			});
			const nextTurn = await composition.consumeParentNextTurnForRun(runId);
			if (!nextTurn.ok) throw nextTurn.error;
			expect(nextTurn.value.entries).toHaveLength(1);
			expect(nextTurn.value.entries[0]).toMatchObject({ trust: "untrusted_child_output", childAgentInstanceId: expect.stringMatching(/^agent_child_/) });
			const reloaded = await composition.reload();
			if (!reloaded.ok) throw reloaded.error;
			const staleAuthority = await composition.consumeParentNextTurnForRun(runId);
			if (!staleAuthority.ok) throw staleAuthority.error;
			expect(staleAuthority.value).toEqual({ entries: [], contextText: "" });
			selectedForkScope = "recent_n";
			await expect(ingress.execute({
				prompt: "@agent reviewer require unsupported fork configuration",
				surface: "sdk",
				runId: "product-run-native-child-invalid-fork-scope",
			})).rejects.toMatchObject({ code: "prompt_task_binding_invalid" });
			selectedForkScope = "none";
			replaceLeaseBeforeChildPersistence = true;
			await expect(ingress.execute({
				prompt: "@agent reviewer verify lease loss",
				surface: "sdk",
				runId: "product-run-native-child-lease-loss",
			})).rejects.toMatchObject({ code: "prompt_task_binding_invalid" });
			if (replacementFencingToken === undefined) throw new Error("Expected the replacement writer lease");
		} finally {
			await composition.dispose();
			if (replacementFencingToken !== undefined) {
				await session.releaseWriterLease({ fencingToken: replacementFencingToken });
			}
			await created.harness.ledger.writer.ensureLease(true);
			await created.harness.close();
		}
	});

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
		const ingress = new ProductPromptIngress({
			session,
			harness: created.harness,
			models,
			cwd: "C:/workspace",
			currentModel: () => MODEL,
			currentThinkingLevel: () => "off",
			mcpSelectionSource: emptyMcpSelectionSource,
			dependencySnapshot: activeDependencySnapshot,
			now: () => "2026-08-20T00:00:00.000Z",
		});

		try {
			const first = await ingress.execute({
				prompt: "@agent reviewer first prompt",
				surface: "sdk",
				runId: "product-run-1",
				images: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }],
			});
			const second = await ingress.execute({ prompt: "second prompt", surface: "rpc", runId: "product-run-2" });
			const replay = await ingress.execute({
				prompt: "@agent reviewer first prompt",
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
				{ type: "text", text: "@agent reviewer first prompt" },
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
			for (const objectType of [
				"role_revision",
				"model_profile_revision",
				"capability_binding",
				"policy_binding",
			] as const) {
				expect(
					await session.findFoundationRecords({ kind: "fact", objectType, order: "oldestFirst" }),
					`${objectType} must be reused across Runs`,
				).toHaveLength(1);
			}
			const bindings = await session.findFoundationRecords({
				kind: "fact",
				objectType: "agent_binding",
				order: "oldestFirst",
			});
			expect(bindings).toHaveLength(2);
			if (bindings[0]?.kind !== "fact" || bindings[1]?.kind !== "fact") {
				throw new Error("Expected two durable AgentBinding facts");
			}
			const firstBinding = bindings[0].payload as unknown as AgentBinding;
			const secondBinding = bindings[1].payload as unknown as AgentBinding;
			expect(firstBinding.roleRevision).toEqual(secondBinding.roleRevision);
			expect(firstBinding.modelProfileRevision).toEqual(secondBinding.modelProfileRevision);
			expect(firstBinding.capabilityRevision).toEqual(secondBinding.capabilityRevision);
			expect(firstBinding.policyRevision).toEqual(secondBinding.policyRevision);
			expect(new Set(tasks.map((record) => record.kind === "fact" && (record.payload as { goalId: string }).goalId))).toEqual(new Set([first.task.goalId]));
			await expect(ingress.execute({ prompt: "conflicting prompt", surface: "sdk", runId: "product-run-1" })).rejects.toMatchObject({ code: "session_ledger_conflict" });
			await expect(ingress.execute({ prompt: "@agent reviewer first prompt", surface: "tui", runId: "product-run-1" })).rejects.toMatchObject({ code: "session_ledger_conflict" });
		} finally {
			await created.harness.close();
		}
	});

	it("freezes the permitted exact MCP server and current Tool Gateway route set into AgentBinding", async () => {
		if (MODEL === undefined) throw new Error("Test model is unavailable");
		const session = new Session(new InMemorySessionStorage({ id: "product-prompt-mcp-selection", createdAt: 1 }));
		const baseModels = createModels();
		const models = Object.create(baseModels) as typeof baseModels;
		const originalGetModel = baseModels.getModel.bind(baseModels);
		models.getModel = (provider, id) => provider === MODEL.provider && id === MODEL.id ? MODEL : originalGetModel(provider, id);
		let streamCalls = 0;
		const streamFunction: StreamFn = () => {
			streamCalls += 1;
			const stream = createAssistantMessageEventStream();
			const message = response("mcp-selection");
			queueMicrotask(() => {
				stream.push({ type: "start", partial: message });
				stream.push({ type: "done", reason: "stop", message });
			});
			return stream;
		};
		const created = await AgentHarness.create({ session, models, model: MODEL, drive: "automatic", streamFunction });
		const persistedCapabilityBindingId = "capability-binding-product-mcp";
		const exactCapabilityBinding: McpCapabilityBinding = {
			id: persistedCapabilityBindingId,
			descriptors: [
				{ id: "descriptor-mcp-docs", revision: "server-revision-3", kind: "mcp_server", name: "docs", mcpServerId: "docs" },
				{ id: "descriptor-mcp-docs-list", revision: "tool-revision-5", kind: "mcp_tool", name: "list", exposedToolName: "mcp__docs__list", parentId: "descriptor-mcp-docs", mcpServerId: "docs" },
			],
			toolAllowlist: ["mcp__docs__list"],
		};
		let currentCapabilityBinding = exactCapabilityBinding;
		let routeCatalog: readonly McpToolRoute[] = [
			{ kind: "mcp", namespace: "docs", toolName: "list", providerId: "mcp-provider-docs", revision: 7 },
		];
		const ingress = new ProductPromptIngress({
			session,
			harness: created.harness,
			models,
			cwd: "C:/workspace",
			currentModel: () => MODEL,
			currentThinkingLevel: () => "off",
			mcpSelectionSource: () => ({ capabilityBinding: currentCapabilityBinding, routeCatalog }),
			dependencySnapshot: (name, context): FoundationJsonValue => name === "capability"
				? { name, state: "active", bindingId: persistedCapabilityBindingId }
				: { name, runId: context.runId, state: "active" },
			now: () => "2026-08-20T00:00:00.000Z",
		});
		try {
			const execution = await ingress.execute({ prompt: "use the permitted docs server", surface: "sdk", runId: "product-run-mcp-selection" });
			expect(execution.binding.mcpSelection.servers).toEqual([{
				serverId: "docs",
				descriptorId: "descriptor-mcp-docs",
				descriptorRevision: "server-revision-3",
				tools: [{
					toolId: "list",
					descriptorId: "descriptor-mcp-docs-list",
					descriptorRevision: "tool-revision-5",
					providerId: "mcp-provider-docs",
					routeRevision: 7,
				}],
			}]);
			expect(Object.isFrozen(execution.binding.mcpSelection.servers[0]?.tools)).toBe(true);

			routeCatalog = [{ kind: "mcp", namespace: "docs", toolName: "search", providerId: "mcp-provider-docs", revision: 8 }];
			await expect(ingress.execute({ prompt: "reject a stale route", surface: "sdk", runId: "product-run-mcp-route-mismatch" }))
				.rejects.toMatchObject({ code: "prompt_task_binding_invalid", dependency: "mcp" });

			routeCatalog = [{ kind: "mcp", namespace: "docs", toolName: "list", providerId: "mcp-provider-docs", revision: 7 }];
			currentCapabilityBinding = { ...exactCapabilityBinding, id: "capability-binding-product-mismatch" };
			await expect(ingress.execute({ prompt: "reject a stale capability", surface: "sdk", runId: "product-run-mcp-capability-mismatch" }))
				.rejects.toMatchObject({ code: "prompt_task_dependency_invalid", dependency: "mcp" });
			expect(streamCalls).toBe(1);
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
		const created = await createCodingAgentHarnessFromTrustedProvidersForTest({
			session,
			models,
			model: MODEL,
			env,
			drive: "automatic",
			streamFunction,
			workerSandbox: {
				provider: workerProvider(),
				routes: [{ kind: "sandbox", toolName: "worker-read", providerId: "test.operation-worker", revision: 1, operation: { resource: "filesystem.read", effects: ["read"] } }],
			},
		});
		if (!("operationToolGateway" in created)) throw new Error("Expected Worker ToolGateway composition");
		gateway = created.operationToolGateway;
		const ingress = new ProductPromptIngress({
			session,
			harness: created.harness,
			models,
			cwd: process.cwd(),
			currentModel: () => MODEL,
			currentThinkingLevel: () => "off",
			mcpSelectionSource: emptyMcpSelectionSource,
			dependencySnapshot: activeDependencySnapshot,
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
			const ledger = new SessionLedger(session, { writer: created.harness.ledger.writer });
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
