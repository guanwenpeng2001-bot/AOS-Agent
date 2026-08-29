import {
	createAttempt,
	fingerprintFoundationValue,
	FoundationError,
	InMemorySessionStorage,
	InMemoryRoleRegistry,
	Result,
	Session,
	SessionLedger,
	type AgentBinding,
	type AgentInstance,
	type AttemptReceipt,
	type Attempt,
	type Dispatch,
	type ExecutionEnv,
	type FoundationProviderCapability,
	type FoundationProviderExecutionOptions,
	type ModelProfile,
	type PublicExecutionError,
	type RoleRevision,
	type SideEffectState,
	type TaskExecutorAttemptContext,
	type TaskExecutorProvider,
} from "@aos-agent/agent-core";
import { createAssistantMessageEventStream, createModels, type Api, type Model, type Models } from "@aos-agent/ai";
import { getModel } from "@aos-agent/ai/compat";
import { describe, expect, it } from "vitest";
import {
	PROMPT_TASK_DEPENDENCY_NAMES,
	createPromptTaskAdapter,
	type PromptTaskCompositionError,
	type PromptTaskCompositionDependencies,
	type PromptTaskDependencyName,
	type PromptTaskInput,
} from "../../src/core/runtime/prompt-task-adapter.ts";

const NOW = "2026-08-19T00:00:00.000Z";
const PROVIDER_CAPABILITY: FoundationProviderCapability = { schemaVersion: 1, id: "foundation.prompt-task", version: 1 };
const OUTPUT_ARTIFACT = { schemaVersion: 1 as const, artifactId: "artifact-prompt-task", mediaType: "text/plain", digest: `sha256:${"a".repeat(64)}` };

function executionEnv(): ExecutionEnv {
	return { cwd: process.cwd() } as ExecutionEnv;
}

function createModelsWithResponse(): { models: Models; model: Model<"google-generative-ai"> } {
	const models = createModels();
	const model = getModel("google", "gemini-2.5-flash");
	const stub = Object.create(models) as Models;
	const originalGetModel = stub.getModel.bind(stub);
	stub.getModel = (provider, id) => provider === model.provider && id === model.id ? model : originalGetModel(provider, id);
	const responseFor = (requestModel: Model<Api>) => ({
		role: "assistant" as const,
		content: [{ type: "text" as const, text: "done" }],
		api: requestModel.api,
		provider: requestModel.provider,
		model: requestModel.id,
		usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop" as const,
		timestamp: Date.parse(NOW),
	});
	stub.streamSimple = (requestModel) => {
		const stream = createAssistantMessageEventStream();
		stream.push({ type: "done", reason: "stop", message: responseFor(requestModel) });
		return stream;
	};
	stub.completeSimple = async (requestModel) => responseFor(requestModel);
	return { models: stub, model };
}

function roleRevision(): RoleRevision {
	const base = {
		schemaVersion: 1 as const,
		roleRevisionId: "role-revision-prompt-task",
		roleId: "role-prompt-task",
		scope: "project" as const,
		revision: 1,
		slug: "prompt-task",
		name: "Prompt Task",
		description: "Execute one Prompt Task",
		persona: "Execute the bound prompt",
		modelProfileRef: { schemaVersion: 1 as const, type: "model_profile", id: "model-profile-prompt-task", revision: 1 },
		capabilitySelector: { policy: "none" as const },
		skillSelector: { policy: "none" as const },
		mcpSelector: { policy: "none" as const },
		createdAt: NOW,
	};
	return { ...base, fingerprint: fingerprintFoundationValue(base) };
}

function modelProfile(): ModelProfile {
	const base = { schemaVersion: 1 as const, modelProfileId: "model-profile-prompt-task", provider: "google", model: "gemini-2.5-flash", budget: {}, revision: 1, createdAt: NOW };
	return { ...base, fingerprint: fingerprintFoundationValue(base) };
}

const dependencyFactTypes = {
	context: "context_snapshot",
	model: "model_broker_binding",
	capability: "capability_binding",
	mcp: "mcp_binding",
	policy: "policy_binding",
	sandbox: "sandbox_binding",
	audit: "audit_binding",
	run: "run_binding",
	gate: "task_gate_binding",
	graph: "task_graph_binding",
	credential: "credential_lease_binding",
	adapter: "external_agent_binding",
} as const;

function dependencies(calls: PromptTaskDependencyName[]): PromptTaskCompositionDependencies {
	return Object.fromEntries(PROMPT_TASK_DEPENDENCY_NAMES.map((name) => [name, {
		name,
		revision: 1,
		resolve: () => {
			calls.push(name);
			const payload = { schemaVersion: 1 as const, type: dependencyFactTypes[name], id: `${name}-binding-prompt-task`, revision: 1 };
			return { reference: { ...payload, ...(name === "adapter" ? { providerId: "provider-prompt-task" } : {}), fingerprint: fingerprintFoundationValue(payload) }, payload };
		},
	}])) as unknown as PromptTaskCompositionDependencies;
}

function promptInput(): PromptTaskInput {
	return {
		prompt: "Implement the bound task",
		task: {
			taskId: "task-prompt-task",
			goalId: "goal-prompt-task",
			kind: "task",
			workspace: "workspace:prompt-task",
			capabilityRefs: [],
			inputs: [],
			expectedOutputs: [OUTPUT_ARTIFACT],
			budget: {},
			acceptanceCriteria: [],
		},
		roleRevision: roleRevision(),
		modelProfile: modelProfile(),
		identity: {
			bindingId: "binding-prompt-task",
			dispatchId: "dispatch-prompt-task",
			attemptId: "attempt-prompt-task",
			bindingEpochId: "binding-epoch-prompt-task",
			agentInstanceId: "agent-instance-prompt-task",
		},
		settlement: { artifacts: [OUTPUT_ARTIFACT], tests: [{ name: "prompt task", required: true, status: "passed" }], evidence: [] },
		now: () => NOW,
	};
}

class PromptTaskProvider implements TaskExecutorProvider {
	readonly schemaVersion = 1 as const;
	readonly providerId = "provider-prompt-task";
	readonly providerClass = "agent" as const;
	createCount = 0;
	runCount = 0;
	receivedAgentInstance: AgentInstance | undefined;
	receivedRoleRevision: RoleRevision | undefined;
	receivedModelProfile: ModelProfile | undefined;
	receiptError: PublicExecutionError | undefined;
	sideEffectState: SideEffectState = "none";

	async capabilities(): Promise<readonly FoundationProviderCapability[]> { return [PROVIDER_CAPABILITY]; }

	async createAttempt(dispatch: Dispatch, _binding: AgentBinding, context?: TaskExecutorAttemptContext) {
		this.createCount += 1;
		if (context === undefined) return Result.err(new FoundationError("invalid_correlation", "Prompt Task provider requires attempt context"));
		this.receivedAgentInstance = context.agentInstance;
		this.receivedRoleRevision = context.roleRevision;
		this.receivedModelProfile = context.modelProfile;
		return createAttempt({ attemptId: context.initialBindingEpoch.attemptId, dispatch, providerId: this.providerId, initialBindingEpoch: context.initialBindingEpoch, providerClass: this.providerClass, agentInstanceId: context.initialBindingEpoch.agentInstanceId });
	}

	async runAttempt(attempt: Attempt, options?: FoundationProviderExecutionOptions) {
		this.runCount += 1;
		if (options?.correlation === undefined) return Result.err(new FoundationError("invalid_correlation", "Prompt Task provider requires execution correlation"));
		const attemptReceiptId = `attempt-receipt-${attempt.attemptId}`;
		return Result.ok<AttemptReceipt>({
			schemaVersion: 1,
			attemptReceiptId,
			taskId: attempt.taskId,
			dispatchId: attempt.dispatchId,
			attemptId: attempt.attemptId,
			providerId: this.providerId,
			agentInstanceId: attempt.agentInstanceId,
			bindingId: attempt.bindingId,
			bindingEpochIds: [...attempt.bindingEpochIds],
			status: this.receiptError === undefined ? "succeeded" : "failed",
			workerReceiptRefs: [],
			artifacts: [OUTPUT_ARTIFACT],
			...(this.receiptError === undefined ? {} : { error: this.receiptError }),
			provenance: {
				producerKind: "agent_executor",
				providerId: this.providerId,
				producedAt: NOW,
				correlation: { ...options.correlation, attemptReceiptId },
			},
			sideEffectState: this.sideEffectState,
		});
	}

	async cancelAttempt(_attemptId: string) { return Result.ok(undefined); }
	async dispose() {}
}

describe("Foundation Prompt Task adapter", () => {
	it.each([
		["explicit @agent", "@agent reviewer inspect this boundary"],
		["description", "Please review security boundaries and unsafe output"],
	])("routes %s selection through the Role Resolver before the agent provider", async (_selection, prompt) => {
		const calls: PromptTaskDependencyName[] = [];
		const session = new Session(new InMemorySessionStorage({ id: "session-prompt-subagent", createdAt: 1 }));
		const provider = new PromptTaskProvider();
		const runtime = createModelsWithResponse();
		const registry = new InMemoryRoleRegistry({ now: () => NOW });
		const created = registry.create({ definition: {
			schemaVersion: 1,
			roleId: "reviewer",
			scope: "project",
			slug: "reviewer",
			name: "Security reviewer",
			description: "Review security boundaries and unsafe output",
			revision: 0,
			persona: "Review the implementation",
			modelProfileRef: { schemaVersion: 1, type: "model_profile", id: "model-profile-prompt-task", revision: 1 },
			capabilitySelector: { policy: "none" },
			skillSelector: { policy: "none" },
			mcpSelector: { policy: "none" },
		} });
		if (!created.ok) throw created.error;
		let selectedRoleId: string | undefined;
		const adapter = createPromptTaskAdapter({
			dependencies: dependencies(calls),
			provider,
			subagentRoles: {
				registry,
				scope: "project",
				parentLaneId: "main",
				spawn: async (input) => {
					selectedRoleId = input.selectedRoleRevision.roleId;
					return Result.err(new FoundationError("subagent_lost", "selection-only fixture stops before parent execution"));
				},
			},
			harness: { session, env: executionEnv(), models: runtime.models, model: runtime.model, tools: [], activeToolNames: [], systemPrompt: "Prompt Task test" },
		});
		await expect(adapter.execute({ ...promptInput(), runId: "run-prompt-subagent", prompt })).rejects.toMatchObject({ code: "prompt_task_binding_invalid" });
		expect(selectedRoleId).toBe("reviewer");
		expect(provider.receivedRoleRevision?.roleId).toBe("role-prompt-task");
	});
	it("drives the only Prompt Task chain through all injected dependencies and AgentHarness receipts", async () => {
		const calls: PromptTaskDependencyName[] = [];
		const session = new Session(new InMemorySessionStorage({ id: "session-prompt-task", createdAt: 1 }));
		const env = executionEnv();
		const provider = new PromptTaskProvider();
		const runtime = createModelsWithResponse();
		const adapter = createPromptTaskAdapter({
			dependencies: dependencies(calls),
			provider,
			harness: { session, env, models: runtime.models, model: runtime.model, tools: [], activeToolNames: [], systemPrompt: "Prompt Task test" },
		});
		const result = await adapter.execute(promptInput());
			expect(calls).toEqual(PROMPT_TASK_DEPENDENCY_NAMES);
			expect(provider.createCount).toBe(1);
			expect(provider.runCount).toBe(1);
			expect(provider.receivedAgentInstance?.agentInstanceId).toBe("agent-instance-prompt-task");
			expect(provider.receivedRoleRevision?.roleRevisionId).toBe("role-revision-prompt-task");
			expect(provider.receivedModelProfile?.modelProfileId).toBe("model-profile-prompt-task");
			expect(result.task.goal).toBe("Implement the bound task");
			expect(result.binding.sourceTrace.map((source) => source.field)).toEqual(PROMPT_TASK_DEPENDENCY_NAMES);
			expect(result.attemptReceipt.attemptId).toBe("attempt-prompt-task");
			expect(result.taskResult.sourceAttemptReceiptIds).toEqual([result.attemptReceipt.attemptReceiptId]);
			expect(result.taskResult.provenance.providerId).toBe("gate-binding-prompt-task");
			expect(result.runReceipt.taskResultId).toBe(result.taskResult.taskResultId);
			expect(result.runReceipt.terminalStatus).toBe("completed");

		const facts = (await session.findFoundationRecords({ kind: "fact", order: "oldestFirst" })).filter((record) => record.kind === "fact");
			expect(facts[0]).toMatchObject({ kind: "fact", objectType: "task", objectId: "task-prompt-task" });
			for (const name of PROMPT_TASK_DEPENDENCY_NAMES) {
				expect(facts).toContainEqual(expect.objectContaining({ kind: "fact", objectType: dependencyFactTypes[name], objectId: `${name}-binding-prompt-task` }));
			}
			expect(facts.map((fact) => fact.objectType)).toEqual(expect.arrayContaining(["agent_binding", "dispatch", "attempt", "attempt_receipt", "task_result", "run_receipt"]));
	});

	it.each([
		["provider failure", "provider_unavailable", "transient", "none"],
		["deadline", "deadline_exceeded", "deadline", "none"],
		["unknown side effect", "side_effect_unknown", "side_effect_unknown", "side_effect_unknown"],
	] as const)("preserves the durable AttemptReceipt category for a child-composed %s", async (_name, code, category, sideEffectState) => {
		const calls: PromptTaskDependencyName[] = [];
		const sessionId = `session-child-${category}`;
		const session = new Session(new InMemorySessionStorage({ id: sessionId, createdAt: 1 }));
		const provider = new PromptTaskProvider();
		provider.receiptError = { code, message: `${category} failure`, category, retryable: category === "transient" };
		provider.sideEffectState = sideEffectState;
		const runtime = createModelsWithResponse();
		const childAttemptReceiptId = `child-receipt-${category}`;
		const childTaskId = `child-task-${category}`;
		const childDispatchId = `child-dispatch-${category}`;
		const childAttemptId = `child-attempt-${category}`;
		const childBindingId = `child-binding-${category}`;
		const childBindingEpochId = `child-binding-epoch-${category}`;
		const childAgentInstanceId = `child-agent-${category}`;
		const childProviderId = `child-provider-${category}`;
		const childLaneId = `child-lane-${category}`;
		const childReceipt: AttemptReceipt = {
			schemaVersion: 1,
			attemptReceiptId: childAttemptReceiptId,
			taskId: childTaskId,
			dispatchId: childDispatchId,
			attemptId: childAttemptId,
			providerId: childProviderId,
			agentInstanceId: childAgentInstanceId,
			bindingId: childBindingId,
			bindingEpochIds: [childBindingEpochId],
			status: "succeeded",
			workerReceiptRefs: [],
			artifacts: [],
			provenance: {
				producerKind: "agent_executor",
				providerId: childProviderId,
				producedAt: NOW,
				correlation: {
					sessionId,
					laneId: childLaneId,
					taskId: childTaskId,
					dispatchId: childDispatchId,
					attemptId: childAttemptId,
					bindingId: childBindingId,
					bindingEpochId: childBindingEpochId,
					agentInstanceId: childAgentInstanceId,
					attemptReceiptId: childAttemptReceiptId,
					revision: 0,
				},
			},
			sideEffectState: "none",
		};
		const childLedger = new SessionLedger(session, { ownerId: `seed-${childAttemptReceiptId}`, laneId: childLaneId });
		await childLedger.appendFact("attempt_receipt", childAttemptReceiptId, childReceipt, {
			clientRequestId: `seed:${childAttemptReceiptId}`,
			expectedRevision: 0,
			correlation: {
				taskId: childTaskId,
				dispatchId: childDispatchId,
				attemptId: childAttemptId,
				bindingId: childBindingId,
				bindingEpochId: childBindingEpochId,
				agentInstanceId: childAgentInstanceId,
				attemptReceiptId: childAttemptReceiptId,
			},
		});
		await childLedger.release();
		const adapter = createPromptTaskAdapter({
			dependencies: dependencies(calls),
			provider,
			subagentRoles: {
				registry: new InMemoryRoleRegistry({ now: () => NOW }),
				scope: "project",
				parentLaneId: "main",
				spawn: async () => Result.err(new FoundationError("subagent_lost", "spawn is not used by fixed composition")),
				compose: async () => Result.ok({ attemptReceiptIds: [childAttemptReceiptId] }),
			},
			harness: {
				session,
				env: executionEnv(),
				models: runtime.models,
				model: runtime.model,
				tools: [],
				activeToolNames: [],
				systemPrompt: "Prompt Task child settlement test",
			},
		});
		const execution = await adapter.execute({ ...promptInput(), runId: `run-child-${category}` });
		expect(execution.attemptReceipt.error).toEqual(provider.receiptError);
		expect(execution.taskResult.sourceAttemptReceiptIds).toEqual([execution.attemptReceipt.attemptReceiptId, childAttemptReceiptId]);
		expect(execution.taskResult.status).toBe("failed");
		expect(execution.runReceipt).toMatchObject({
			terminalStatus: "failed",
			attemptReceiptIds: [execution.attemptReceipt.attemptReceiptId, childAttemptReceiptId],
			terminalErrorCode: code,
			terminalError: { code, category },
		});
	});

	it("fails construction when any required dependency is absent", () => {
		const calls: PromptTaskDependencyName[] = [];
		const { credential: _credential, ...missing } = dependencies(calls);
		const provider = new PromptTaskProvider();
		const session = new Session(new InMemorySessionStorage({ id: "session-missing-dependency", createdAt: 1 }));
		const env = executionEnv();
		const runtime = createModelsWithResponse();
		expect(() => createPromptTaskAdapter({ dependencies: missing as PromptTaskCompositionDependencies, provider, harness: { session, env, models: runtime.models, model: runtime.model } })).toThrowError(expect.objectContaining<Partial<PromptTaskCompositionError>>({ code: "prompt_task_dependency_missing", dependency: "credential" }));
		expect(provider.createCount).toBe(0);
	});

	it("persists Task first and fails closed before provider execution on a forged dependency fact", async () => {
		const calls: PromptTaskDependencyName[] = [];
		const complete = dependencies(calls);
		const forged: PromptTaskCompositionDependencies = { ...complete, policy: { ...complete.policy, resolve: () => {
			const payload = { schemaVersion: 1 as const, type: "policy_binding", id: "policy-binding-prompt-task", revision: 1 };
			return { reference: { ...payload, fingerprint: fingerprintFoundationValue({ ...payload, revision: 2 }) }, payload };
		} } };
		const provider = new PromptTaskProvider();
		const session = new Session(new InMemorySessionStorage({ id: "session-forged-dependency", createdAt: 1 }));
		const env = executionEnv();
		const runtime = createModelsWithResponse();
		const adapter = createPromptTaskAdapter({ dependencies: forged, provider, harness: { session, env, models: runtime.models, model: runtime.model, tools: [], activeToolNames: [] } });
		await expect(adapter.execute(promptInput())).rejects.toMatchObject({ code: "prompt_task_dependency_invalid", dependency: "policy" });
		expect(await session.getFoundationObject("task", "task-prompt-task")).toMatchObject({ kind: "fact", objectType: "task" });
		expect(await session.getFoundationObject("agent_binding", "binding-prompt-task")).toBeUndefined();
		expect(provider.createCount).toBe(0);
		expect(provider.runCount).toBe(0);
	});

	it("fails closed before provider execution when settlement prerequisites are absent", async () => {
		const calls: PromptTaskDependencyName[] = [];
		const provider = new PromptTaskProvider();
		const session = new Session(new InMemorySessionStorage({ id: "session-missing-settlement", createdAt: 1 }));
		const runtime = createModelsWithResponse();
		const adapter = createPromptTaskAdapter({ dependencies: dependencies(calls), provider, harness: { session, env: executionEnv(), models: runtime.models, model: runtime.model, tools: [], activeToolNames: [] } });
		const input = { ...promptInput(), settlement: undefined } as unknown as PromptTaskInput;
		await expect(adapter.execute(input)).rejects.toMatchObject({ code: "prompt_task_input_invalid" });
		expect(calls).toEqual([]);
		expect(provider.createCount).toBe(0);
		expect(provider.runCount).toBe(0);
	});
});
