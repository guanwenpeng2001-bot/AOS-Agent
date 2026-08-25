import {
	AgentHarness,
	createScopedMemoryStore,
	createTaskEnvelope,
	FoundationError,
	InMemoryArtifactBlobStore,
	InMemoryRoleRegistry,
	InMemorySessionStorage,
	resolveAgentBinding,
	Result,
	Session,
	SessionLedger,
	SessionT5Ledger,
	sha256HexValue,
	type AgentBinding,
	type AgentHarness as AgentHarnessType,
	type ArtifactStoreProvider,
	type ChildSpawnRequest,
	type FoundationJsonValue,
	type QuotaProvider,
	type RevisionReference,
	type ScopedModelGateway,
	type StreamFn,
	type TaskEnvelope,
	type ToolGateway,
} from "@aos-agent/agent-core";
import {
	createAssistantMessageEventStream,
	createModels,
	type AssistantMessage,
} from "@aos-agent/ai";
import { getModel } from "@aos-agent/ai/compat";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { PromptTaskSubagentCompositionInputV1 } from "../src/core/prompt-task-adapter.ts";
import { ProductPromptIngressV1 } from "../src/core/product-prompt-ingress.ts";
import {
	TrustedSubagentCompositionV1,
	type TrustedProductPromptCompositionPolicyV1,
} from "../src/core/subagent-composition.ts";
import type { SubagentProviderDescriptorV1 } from "../src/core/subagent-registry.ts";
import type { PlanSubagentSpawnInputV1, SubagentSpawnPlanV1 } from "../src/core/subagent-supervisor.ts";
import type { ChildTaskSettlementPolicyV1 } from "../src/core/subagent-result.ts";

const MODEL = getModel("openai", "gpt-4o-mini");
const NOW = "2026-08-22T00:00:00.000Z";

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
		timestamp: Date.parse(NOW),
	};
}

function childTask(input: PromptTaskSubagentCompositionInputV1): TaskEnvelope {
	const token = sha256HexValue(input.runId).slice(0, 24);
	const created = createTaskEnvelope({
		schemaVersion: 1,
		taskId: `task_product_composition_${token}`,
		goalId: input.parentTask.goalId,
		goal: "Execute the trusted product Child Agent composition",
		kind: "task",
		title: "Trusted product Child Agent composition",
		description: "Host-configured multi-child execution",
		workspace: input.parentTask.workspace,
		capabilityRefs: input.parentTask.capabilityRefs,
		inputs: input.parentTask.inputs,
		expectedOutputs: [],
		budget: input.parentTask.budget,
		acceptanceCriteria: [],
		status: "ready",
		createdAt: input.timestamp,
		updatedAt: input.timestamp,
	});
	if (!created.ok) throw created.error;
	return created.value;
}

function childBinding(
	input: PromptTaskSubagentCompositionInputV1,
	task: TaskEnvelope,
	suffix: string,
): AgentBinding {
	const resolved = resolveAgentBinding({
		task,
		roleRevision: input.parentRoleRevision,
		modelProfile: input.parentModelProfile,
		contextRevision: input.parentBinding.contextRevision,
		capabilityRevision: input.parentBinding.capabilityRevision,
		modelBrokerBindingRevision: input.parentBinding.modelBrokerBindingRevision,
		policyRevision: input.parentBinding.policyRevision,
		newBindingId: `binding_product_child_${sha256HexValue(input.runId).slice(0, 16)}_${suffix}`,
		now: () => input.timestamp,
	});
	if (!resolved.ok) throw resolved.error;
	return resolved.value;
}

async function preparePlan(
	input: PromptTaskSubagentCompositionInputV1,
	composition: TrustedSubagentCompositionV1,
	ledger: SessionLedger,
	descriptor: SubagentProviderDescriptorV1,
	task: TaskEnvelope,
	suffix: string,
): Promise<SubagentSpawnPlanV1> {
	const binding = childBinding(input, task, suffix);
	const token = sha256HexValue(`${input.runId}:${suffix}`).slice(0, 24);
	const spawnId = `spawn_product_composition_${token}`;
	const childAgentInstanceId = `agent_product_child_${token}`;
	const attemptId = `attempt_product_child_${token}`;
	const seed = async (
		objectType: string,
		objectId: string,
		payload: object,
		correlation: Record<string, string> = {},
	): Promise<void> => {
		if (await ledger.get(objectType, objectId) !== undefined) return;
		await ledger.appendFact(objectType, objectId, payload, {
			clientRequestId: `product-composition:${input.runId}:${objectType}:${objectId}`,
			expectedRevision: 0,
			correlation: { taskId: task.taskId, bindingId: binding.bindingId, ...correlation },
		});
	};
	await seed("task", task.taskId, task);
	await seed("role_revision", input.parentRoleRevision.roleRevisionId, input.parentRoleRevision);
	await seed("model_profile_revision", input.parentModelProfile.modelProfileId, input.parentModelProfile);
	for (const [objectType, reference] of [
		["external_agent_binding", binding.contextRevision],
		["capability_binding", binding.capabilityRevision],
		["model_broker_binding", binding.modelBrokerBindingRevision],
		["policy_binding", binding.policyRevision],
	] as const satisfies readonly (readonly [string, RevisionReference])[]) {
		await seed(objectType, reference.id, {
			schemaVersion: 1,
			type: reference.type,
			id: reference.id,
			revision: reference.revision,
		});
	}
	await seed("agent_binding", binding.bindingId, binding);
	const parentSpawnId = `origin_${spawnId}`;
	await seed("context", `context_${parentSpawnId}`, {
		schemaVersion: 1,
		contextId: `context_${parentSpawnId}`,
		taskId: input.parentTask.taskId,
		spawnId: parentSpawnId,
		forkScope: "none",
		lineage: { schemaVersion: 1, entityType: "context", entityId: `context_${parentSpawnId}`, depth: 0 },
		createdAt: input.timestamp,
	});
	const request: ChildSpawnRequest = {
		schemaVersion: 1,
		spawnId,
		parentSpawn: {
			schemaVersion: 1,
			type: "agent.spawn",
			spawnId: parentSpawnId,
			parentTaskId: input.parentTask.taskId,
			newTaskEnvelopeRef: { schemaVersion: 1, type: "task_envelope", id: task.taskId, revision: 1, fingerprint: task.fingerprint },
			providerId: descriptor.descriptor.providerId,
			createdAt: input.timestamp,
		},
		taskEnvelope: task,
		roleRevision: input.parentRoleRevision,
		modelProfile: input.parentModelProfile,
		parentAttemptId: input.parentBindingEpoch.attemptId,
		parentAgentInstanceId: input.parentAgentInstance.agentInstanceId,
		forkScope: "none",
	};
	const planInput: PlanSubagentSpawnInputV1 = {
		schemaVersion: 1,
		request,
		originParentAgentInstance: input.parentAgentInstance,
		originParentAttemptId: input.parentBindingEpoch.attemptId,
		lineageParentAgentInstance: input.parentAgentInstance,
		childLaneId: `child_product_${token}`,
		childBinding: binding,
		providerDescriptor: descriptor,
		childAgentInstanceId,
		dispatchId: `dispatch_product_child_${token}`,
		attemptId,
		bindingEpochId: `binding_epoch_product_child_${token}`,
		activatedByCommandId: spawnId,
		queue: { mode: "fail" },
	};
	const planned = await composition.planSpawn(planInput);
	if (!planned.ok) throw planned.error;
	return planned.value;
}

interface CompositionFixture {
	readonly session: Session;
	readonly ingress: ProductPromptIngressV1;
	readonly composition: TrustedSubagentCompositionV1;
	close(): Promise<void>;
}

async function createFixture(options: {
	readonly mode: "parallel" | "chain";
	readonly join: ChildTaskSettlementPolicyV1;
	readonly failSecond?: boolean;
}): Promise<CompositionFixture> {
	if (MODEL === undefined) throw new Error("Test model is unavailable");
	const session = new Session(new InMemorySessionStorage({ id: `product-composition-${options.mode}-${options.failSecond === true ? "failure" : "success"}`, createdAt: 1 }));
	const baseModels = createModels();
	const models = Object.create(baseModels) as typeof baseModels;
	const originalGetModel = baseModels.getModel.bind(baseModels);
	models.getModel = (provider, id) => provider === MODEL.provider && id === MODEL.id ? MODEL : originalGetModel(provider, id);
	const streamFunction: StreamFn = () => {
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
		const existing = ledgers.get(laneId);
		if (existing !== undefined) return existing;
		const ledger = new SessionLedger(session, { writer: created.harness.t5.writer, laneId });
		ledgers.set(laneId, ledger);
		return ledger;
	};
	const quota: QuotaProvider = {
		schemaVersion: 1,
		providerId: "product-composition-quota",
		providerClass: "quota",
		capabilities: async () => [],
		reserve: async (attribution, budget) => Result.ok({ schemaVersion: 1, reservationId: `reservation-${attribution.attemptId}`, attribution, budget, grantedAt: NOW }),
		settle: async (_reservation, usage) => Result.ok(usage),
		dispose: async () => {},
	};
	const modelGateway = {
		schemaVersion: 1 as const,
		providerId: "product-composition-model",
		providerClass: "gateway" as const,
		capabilities: async () => [],
		stream: async () => Result.err(new FoundationError("subagent_lost", "not used")),
		dispose: async () => {},
	} as unknown as ScopedModelGateway;
	const toolGateway = {
		schemaVersion: 1 as const,
		providerId: "product-composition-tool",
		providerClass: "gateway" as const,
		capabilities: async () => [],
		execute: async () => Result.err(new FoundationError("subagent_lost", "not used")),
		dispose: async () => {},
	} as unknown as ToolGateway;
	const artifactStore = {
		schemaVersion: 1 as const,
		providerId: "product-composition-artifacts",
		providerClass: "store" as const,
		capabilities: async () => [],
		put: async () => Result.err(new FoundationError("subagent_lost", "not used")),
		get: async () => Result.err(new FoundationError("subagent_lost", "not used")),
		verify: async () => Result.ok({ schemaVersion: 1 as const, digestValid: true }),
		delete: async () => Result.ok(undefined),
		dispose: async () => {},
	} as unknown as ArtifactStoreProvider;
	const memoryLedger = new SessionT5Ledger(session, {
		ownerId: "product-composition-memory",
		memoryScopeId: "product-composition-parent-memory",
		memoryOwnerId: "configured-parent",
		artifactBlobStore: new InMemoryArtifactBlobStore(),
	});
	const parentMemoryForAgent = (parentAgentInstanceId: string) => ({
		store: createScopedMemoryStore(
			memoryLedger.memory,
			"session",
			{ ownerId: parentAgentInstanceId, scopeId: `memory:${parentAgentInstanceId}`, createdBy: "system" },
			{ ownerId: parentAgentInstanceId, scopeId: `memory:${parentAgentInstanceId}` },
		),
		parentAgentInstanceId,
	});
	let composition: TrustedSubagentCompositionV1 | undefined;
	const failingChildren = new Set<string>();
	const policy: TrustedProductPromptCompositionPolicyV1 = {
		schemaVersion: 1,
		mode: options.mode,
		join: options.join,
		prepare: async (input) => {
			if (composition === undefined) throw new Error("Composition is not ready");
			const descriptor = composition.providerDescriptors().find((candidate) => candidate.providerKind === "in_process");
			if (descriptor === undefined) throw new Error("In-process provider is unavailable");
			const task = childTask(input);
			const ledger = ledgerForLane("main");
			const first = await preparePlan(input, composition, ledger, descriptor, task, "first");
			const second = await preparePlan(input, composition, ledger, descriptor, task, "second");
			if (options.failSecond === true) failingChildren.add(second.agentInstance.agentInstanceId);
			return {
				steps: options.mode === "parallel"
					? [{ input: "root" as const, plan: first }, { input: "root" as const, plan: second }]
					: [{ input: "root" as const, plan: first }, { input: "safe_projection" as const, createPlan: () => second }],
				taskResultId: `task_result_join_${sha256HexValue(input.runId).slice(0, 24)}`,
				task,
				summary: `Trusted ${options.mode} product composition`,
				tests: [],
				evidence: [],
			};
		},
	};
	const registry = new InMemoryRoleRegistry({ now: () => NOW });
	composition = new TrustedSubagentCompositionV1({
		schemaVersion: 1,
		enabled: true,
		session,
		writer: created.harness.t5.writer,
		ledger: ledgerForLane("main"),
		ledgerForLane,
		sessionId: (await session.getMetadata()).id,
		parentLaneId: "main",
		quota,
		modelGateway,
		toolGateway,
		artifactStore,
		createHarness: async (input) => ({
			promptOnLane: async () => failingChildren.has(input.agentInstance.agentInstanceId)
				? Result.ok({ runId: `child-run-${input.epoch.attemptId}`, kind: "failed" as const, error: { code: "child_failed", message: "planned child failure" } })
				: Result.ok({ runId: `child-run-${input.epoch.attemptId}`, kind: "completed" as const, leafId: "child-leaf", finalEntryId: "child-entry", finalMessage: { role: "assistant" as const, content: [{ type: "text" as const, text: "child-complete" }] } }),
			resumeOnLane: async () => Result.err({ message: "not used" }),
			createLane: async () => Result.ok({ name: "child-lane" }),
			abort: async () => Result.ok({ runId: "child-run", steer: [], followUp: [] }),
			close: async () => undefined,
		} as unknown as AgentHarnessType),
		loadParentContext: async () => Result.err(new FoundationError("subagent_context_fork_invalid", "none scope has no parent snapshot")),
		parentMemory: parentMemoryForAgent("configured-parent"),
		parentMemoryForAgent,
		fork: { executable: process.execPath, entrypoint: fileURLToPath(new URL("../src/child-agent-entry.ts", import.meta.url)) },
		productPrompt: {
			registry,
			scope: "project",
			providerId: "native.in_process",
			forkScope: "none",
			mailboxRequired: true,
			resumeRequired: false,
			worktreeRequired: false,
			backgroundRequired: false,
			composition: policy,
		},
		limits: { maxDepth: 2, maxConcurrent: 2, maxTurns: 2, queueCapacity: 2, maximumQueueWaitMs: 100 },
		now: () => NOW,
	});
	const ingress = new ProductPromptIngressV1({
		session,
		harness: created.harness,
		models,
		cwd: "C:/workspace",
		currentModel: () => MODEL,
		currentThinkingLevel: () => "off",
		dependencySnapshot: (name, context): FoundationJsonValue => ({ name, runId: context.runId, state: "active" }),
		subagents: composition,
		now: () => NOW,
	});
	return {
		session,
		ingress,
		composition,
		async close() {
			await composition?.dispose();
			await created.harness.close();
		},
	};
}

async function productionFacts(session: Session) {
	return (await session.findFoundationRecords({ kind: "fact", order: "oldestFirst" }))
		.filter((record) => record.kind === "fact");
}

describe("ProductPromptIngress trusted Child Agent composition", () => {
	it.each([
		["parallel", { type: "quorum", minimumSucceeded: 1 } as const, true],
		["chain", { type: "all_succeed" } as const, false],
	] as const)("finalizes one parent RunReceipt for trusted %s composition", async (mode, join, failSecond) => {
		const fixture = await createFixture({ mode, join, failSecond });
		const runId = `product-${mode}-composition-success`;
		try {
			const execution = await fixture.ingress.execute({ prompt: "plain product prompt", surface: "sdk", runId });
			const facts = await productionFacts(fixture.session);
			const childReceipts = facts.filter((record) => record.objectType === "attempt_receipt" && record.correlation.providerId === "native.in_process");
			expect(childReceipts).toHaveLength(2);
			expect(childReceipts.every((record) => record.lane !== "main")).toBe(true);
			expect(new Set(childReceipts.map((record) => record.lane)).size).toBe(2);
			const joinedResult = facts.find((record) => record.objectType === "task_result" && record.objectId.startsWith("task_result_join_"));
			if (joinedResult === undefined) throw new Error("Expected joined TaskResult");
			expect(joinedResult.lane).toBe("main");
			const acceptedChildIds = (joinedResult.payload as { sourceAttemptReceiptIds: string[] }).sourceAttemptReceiptIds;
			expect(new Set(acceptedChildIds).size).toBe(acceptedChildIds.length);
			expect(acceptedChildIds).toHaveLength(mode === "parallel" ? 1 : 2);
			const runReceipts = facts.filter((record) => record.objectType === "run_receipt");
			expect(runReceipts).toHaveLength(1);
			expect(runReceipts[0]?.lane).toBe("main");
			const runAttemptReceiptIds = (runReceipts[0]?.payload as { attemptReceiptIds: string[] }).attemptReceiptIds;
			expect(new Set(runAttemptReceiptIds).size).toBe(runAttemptReceiptIds.length);
			expect(runAttemptReceiptIds).toEqual([execution.attemptReceipt.attemptReceiptId]);
			for (const acceptedChildId of acceptedChildIds) expect(runAttemptReceiptIds).not.toContain(acceptedChildId);
			const rejectedChildIds = childReceipts.map((record) => record.objectId).filter((id) => !acceptedChildIds.includes(id));
			for (const rejectedChildId of rejectedChildIds) expect(runAttemptReceiptIds).not.toContain(rejectedChildId);
			expect((runReceipts[0]?.payload as { usage: unknown }).usage).toEqual({
				inputTokens: 1,
				outputTokens: 1,
				totalTokens: 2,
			});
			const taskResults = facts.filter((record) => record.objectType === "task_result");
			expect(taskResults).toHaveLength(2);
			expect(taskResults.every((record) => record.lane === "main")).toBe(true);
		} finally {
			await fixture.close();
		}
	});

	it.each([
		["parallel", { type: "quorum", minimumSucceeded: 2 } as const],
		["chain", { type: "all_succeed" } as const],
	] as const)("does not overclaim receipt coverage when trusted %s composition fails", async (mode, join) => {
		const fixture = await createFixture({ mode, join, failSecond: true });
		try {
			await expect(fixture.ingress.execute({
				prompt: "plain failing product prompt",
				surface: "sdk",
				runId: `product-${mode}-composition-failure`,
			})).rejects.toMatchObject({ code: "prompt_task_binding_invalid" });
			const facts = await productionFacts(fixture.session);
			expect(facts.filter((record) => record.objectType === "attempt_receipt" && record.correlation.providerId === "native.in_process")).toHaveLength(2);
			expect(facts.filter((record) => record.objectType === "run_receipt")).toHaveLength(0);
			expect(facts.filter((record) => record.objectType === "task_result")).toHaveLength(0);
		} finally {
			await fixture.close();
		}
	});
});
