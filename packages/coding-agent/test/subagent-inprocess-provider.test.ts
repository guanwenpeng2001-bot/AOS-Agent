import {
	AgentHarness,
	createAgentInstance,
	createContextSnapshot,
	createModelProfileRevision,
	createRoleRevision,
	createTaskEnvelopeV1,
	fingerprintFoundationValue,
	FoundationError,
	InMemorySessionStorage,
	InMemoryArtifactBlobStore,
	LayeredResultSettlementV1,
	resolveAgentBinding,
	Result,
	Session,
	SessionLedgerV1,
	SessionLedgerWriter,
	SessionT5Ledger,
	createScopedMemoryStore,
	validateAttemptReceiptForProviderV1,
	type AgentBindingV1,
	type AgentInstanceV1,
	type BudgetUsageV1,
	type BudgetV1,
	type ChildSpawnRequestV1,
	type ChildSpawnResultV1,
	type ContextSnapshot,
	type DispatchV1,
	type FoundationProviderCapabilityV1,
	type ModelProfileV1,
	type QuotaAttributionV1,
	type QuotaProvider,
	type QuotaReservationV1,
	type RevisionReferenceV1,
	type Result as ResultValue,
	type RoleRevisionV1,
	type ScopedMemoryStore,
	type ScopedModelGateway,
	type ScopedModelRequestV1,
	type TaskEnvelopeV1,
	type ToolGateway,
	type ToolGatewayRequestV1,
} from "@aos-agent/agent-core";
import { createAssistantMessageEventStream, createModels, fauxProvider } from "@aos-agent/ai";
import { describe, expect, it } from "vitest";
import type { SubagentProviderDescriptorV1 } from "../src/core/subagent-registry.ts";
import {
	InProcessChildAgentProviderV1,
	type ChildAgentHarnessCreateInputV1,
} from "../src/core/subagent-inprocess-provider.ts";
import {
	SubagentSupervisorV1,
	type PlanSubagentSpawnInputV1,
	type SubagentSpawnPlanV1,
} from "../src/core/subagent-supervisor.ts";


const NOW = "2026-01-01T00:00:00.000Z";
const PROVIDER_ID = "native.in_process";

function task(taskId: string, concurrency = 2): TaskEnvelopeV1 {
	const result = createTaskEnvelopeV1({
		schemaVersion: 1,
		taskId,
		goalId: "goal-1",
		goal: `run ${taskId}`,
		workspace: "workspace-1",
		capabilityRefs: [],
		inputs: [],
		expectedOutputs: [],
		budget: { tokens: 1000, concurrency },
		acceptanceCriteria: [],
		status: "ready",
		createdAt: NOW,
		updatedAt: NOW,
	});
	if (!result.ok) throw result.error;
	return result.value;
}

function role(): RoleRevisionV1 {
	return createRoleRevision({
		definition: {
			schemaVersion: 1,
			roleId: "role-child",
			scope: "project",
			slug: "child",
			name: "Child",
			description: "Child role",
			revision: 1,
			persona: "Run the child task.",
			modelProfileRef: { schemaVersion: 1, type: "model_profile", id: "profile-child", revision: 1 },
			capabilitySelector: { policy: "none" },
			skillSelector: { policy: "none" },
			mcpSelector: { policy: "none" },
		},
		now: () => NOW,
	});
}

function profile(): ModelProfileV1 {
	return createModelProfileRevision({
		schemaVersion: 1,
		modelProfileId: "profile-child",
		provider: "fake",
		model: "model-1",
		budget: { tokens: 1000, concurrency: 2 },
		revision: 1,
		createdAt: NOW,
	});
}

function immutableFact(type: string, id: string): RevisionReferenceV1 {
	const value = { schemaVersion: 1 as const, type, id, revision: 1 };
	return { ...value, fingerprint: fingerprintFoundationValue(value) };
}

function binding(taskEnvelope: TaskEnvelopeV1, roleRevision: RoleRevisionV1, modelProfile: ModelProfileV1): AgentBindingV1 {
	const result = resolveAgentBinding({
		task: taskEnvelope,
		roleRevision,
		modelProfile,
		contextRevision: immutableFact("external_agent_binding", "context-1"),
		capabilityRevision: immutableFact("capability_binding", "capability-1"),
		modelBrokerBindingRevision: immutableFact("model_broker_binding", "broker-1"),
		policyRevision: immutableFact("policy_binding", "policy-1"),
		newBindingId: `binding-${taskEnvelope.taskId}`,
		now: () => NOW,
	});
	if (!result.ok) throw result.error;
	return result.value;
}

function rootAgent(agentInstanceId: string, taskId: string, roleRevision: RoleRevisionV1): AgentInstanceV1 {
	const result = createAgentInstance({
		agentInstanceId,
		providerId: "parent-provider",
		providerDeclaredAgent: true,
		roleRevision,
		taskId,
		now: () => NOW,
	});
	if (!result.ok) throw result.error;
	return result.value;
}

const descriptor: SubagentProviderDescriptorV1 = {
	schemaVersion: 1,
	providerKind: "in_process",
	descriptor: { schemaVersion: 1, providerId: PROVIDER_ID, providerClass: "agent" },
	revision: 1,
	capabilities: {
		resumeSupported: true,
		mailboxSupported: true,
		backgroundSupported: true,
		worktreeSupported: false,
		maxDepth: 5,
	},
	implementedInThisLine: true,
};

class RecordingQuota implements QuotaProvider {
	readonly schemaVersion = 1 as const;
	readonly providerId = "quota-test";
	readonly providerClass = "quota" as const;
	readonly reservations: QuotaReservationV1[] = [];
	readonly settlements: { readonly reservation: QuotaReservationV1; readonly usage: BudgetUsageV1 }[] = [];
	failReserve = false;
	failSettle = false;

	async capabilities(): Promise<readonly FoundationProviderCapabilityV1[]> {
		return [{ schemaVersion: 1, id: "quota.test", version: 1 }];
	}

	async reserve(attribution: QuotaAttributionV1, budget: BudgetV1) {
		if (this.failReserve) return Result.err(new FoundationError("quota_exceeded", "quota denied"));
		const reservation: QuotaReservationV1 = {
			schemaVersion: 1,
			reservationId: `reservation-${this.reservations.length + 1}`,
			attribution,
			budget,
			grantedAt: NOW,
		};
		this.reservations.push(reservation);
		return Result.ok(reservation);
	}

	async settle(reservation: QuotaReservationV1, usage: BudgetUsageV1) {
		if (this.failSettle) return Result.err(new FoundationError("quota_exceeded", "quota settle denied"));
		this.settlements.push({ reservation, usage });
		return Result.ok(usage);
	}

	async dispose() {}
}

class RecordingModelGateway implements ScopedModelGateway {
	readonly schemaVersion = 1 as const;
	readonly providerId = "model-gateway-test";
	readonly providerClass = "gateway" as const;
	calls = 0;
	lastRequest: ScopedModelRequestV1 | undefined;

	async capabilities(): Promise<readonly FoundationProviderCapabilityV1[]> {
		return [{ schemaVersion: 1, id: "model.gateway.test", version: 1 }];
	}

	async stream(request: ScopedModelRequestV1) {
		this.calls += 1;
		this.lastRequest = request;
		return Result.ok({
			schemaVersion: 1 as const,
			requestId: request.requestId,
			usage: { tokens: 3, modelCalls: 1 },
			stopReason: "stop" as const,
		});
	}

	async dispose() {}
}

class RecordingToolGateway implements ToolGateway {
	readonly schemaVersion = 1 as const;
	readonly providerId = "tool-gateway-test";
	readonly providerClass = "gateway" as const;
	calls = 0;

	async capabilities(): Promise<readonly FoundationProviderCapabilityV1[]> {
		return [{ schemaVersion: 1, id: "tool.gateway.test", version: 1 }];
	}

	async execute(request: ToolGatewayRequestV1) {
		this.calls += 1;
		return Result.ok({
			schemaVersion: 1 as const,
			toolCallId: request.toolCallId,
			toolName: request.toolName,
			ok: true,
			sideEffectState: "none" as const,
		});
	}

	async dispose() {}
}

interface Fixture {
	readonly session: Session;
	readonly ledger: SessionLedgerV1;
	readonly ledgerForLane: (laneId: string) => SessionLedgerV1;
	readonly supervisor: SubagentSupervisorV1;
	readonly roleRevision: RoleRevisionV1;
	readonly modelProfile: ModelProfileV1;
}

function fixture(): Fixture {
	const session = new Session(new InMemorySessionStorage({ id: "session-inprocess", createdAt: 1 }));
	const ledgers = new Map<string, SessionLedgerV1>();
	const ledgerForLane = (laneId: string): SessionLedgerV1 => {
		let selected = ledgers.get(laneId);
		if (selected === undefined) {
			selected = new SessionLedgerV1(session, { ownerId: "supervisor-writer", laneId });
			ledgers.set(laneId, selected);
		}
		return selected;
	};
	const ledger = ledgerForLane("control-lane");
	return {
		session,
		ledger,
		ledgerForLane,
		supervisor: new SubagentSupervisorV1({
			schemaVersion: 1,
			ledger,
			ledgerForLane,
			sessionId: "session-inprocess",
			laneId: "control-lane",
			maxDepth: 4,
			maxConcurrent: 2,
			maxTurns: 4,
			queueCapacity: 2,
			maximumQueueWaitMs: 100,
			now: () => NOW,
		}),
		roleRevision: role(),
		modelProfile: profile(),
	};
}

async function planInput(value: Fixture, overrides: Partial<PlanSubagentSpawnInputV1> = {}): Promise<PlanSubagentSpawnInputV1> {
	const origin = overrides.originParentAgentInstance ?? rootAgent("parent-1", "task-parent", value.roleRevision);
	const lineageParent = overrides.lineageParentAgentInstance ?? origin;
	const childTask = overrides.request?.taskEnvelope ?? task(`task-child-${overrides.childAgentInstanceId ?? "1"}`);
	const childBinding = overrides.childBinding ?? binding(childTask, value.roleRevision, value.modelProfile);
	const seed = async (
		objectType: string,
		objectId: string,
		payload: object,
		correlation: {
			readonly taskId?: string;
			readonly dispatchId?: string;
			readonly attemptId?: string;
			readonly bindingId?: string;
			readonly bindingEpochId?: string;
			readonly agentInstanceId?: string;
		} = {},
	): Promise<void> => {
		if ((await value.ledger.get(objectType, objectId)) !== undefined) return;
		await value.ledger.appendFact(objectType, objectId, payload, {
			clientRequestId: `seed:${objectType}:${objectId}`,
			expectedRevision: 0,
			correlation: { taskId: childTask.taskId, bindingId: childBinding.bindingId, ...correlation },
		});
	};
	await seed("task", childTask.taskId, childTask);
	await seed("role_revision", childBinding.roleRevision.id, value.roleRevision);
	await seed("model_profile_revision", childBinding.modelProfileRevision.id, value.modelProfile);
	for (const [objectType, reference] of [
		["external_agent_binding", childBinding.contextRevision],
		["capability_binding", childBinding.capabilityRevision],
		["model_broker_binding", childBinding.modelBrokerBindingRevision],
		["policy_binding", childBinding.policyRevision],
	] as const) {
		await seed(objectType, reference.id, {
			schemaVersion: 1,
			type: reference.type,
			id: reference.id,
			revision: reference.revision,
		});
	}
	await seed("agent_binding", childBinding.bindingId, childBinding);
	await seed("agent_instance", origin.agentInstanceId, origin, {
		taskId: origin.taskId,
		agentInstanceId: origin.agentInstanceId,
	});
	await seed("agent_instance", lineageParent.agentInstanceId, lineageParent, {
		taskId: lineageParent.taskId,
		agentInstanceId: lineageParent.agentInstanceId,
	});
	const originAttemptId = overrides.originParentAttemptId ?? "attempt-parent";
	if ((await value.ledger.get("attempt", originAttemptId)) === undefined) {
		await value.ledger.appendFact(
			"attempt",
			originAttemptId,
			{
				schemaVersion: 1,
				attemptId: originAttemptId,
				dispatchId: `dispatch-${originAttemptId}`,
				taskId: origin.taskId,
				providerId: origin.providerId,
				agentInstanceId: origin.agentInstanceId,
				bindingId: `binding-${origin.taskId}`,
				bindingEpochIds: [`epoch-${originAttemptId}`],
				status: "running",
				startedAt: NOW,
			},
			{
				clientRequestId: `seed:attempt:${originAttemptId}`,
				expectedRevision: 0,
				correlation: {
					taskId: origin.taskId,
					dispatchId: `dispatch-${originAttemptId}`,
					attemptId: originAttemptId,
					bindingId: `binding-${origin.taskId}`,
					bindingEpochId: `epoch-${originAttemptId}`,
					agentInstanceId: origin.agentInstanceId,
				},
			},
		);
	}
	const spawnId = overrides.request?.spawnId ?? `spawn-${overrides.childAgentInstanceId ?? "1"}`;
	const parentSpawnId = `parent-${spawnId}`;
	const request: ChildSpawnRequestV1 = overrides.request ?? {
		schemaVersion: 1,
		spawnId,
		parentSpawn: {
			schemaVersion: 1,
			type: "agent.spawn",
			spawnId: parentSpawnId,
			parentTaskId: origin.taskId,
			newTaskEnvelopeRef: { schemaVersion: 1, type: "task_envelope", id: childTask.taskId, revision: 1 },
			providerId: PROVIDER_ID,
			createdAt: NOW,
		},
		taskEnvelope: childTask,
		roleRevision: value.roleRevision,
		modelProfile: value.modelProfile,
		parentAttemptId: originAttemptId,
		parentAgentInstanceId: lineageParent.agentInstanceId,
		forkScope: "none",
	};
	await seed("task", origin.taskId, task(origin.taskId));
	if (request.parentSpawn !== undefined) {
		const parentContextId = `context_${request.parentSpawn.spawnId}`;
		await seed("context", parentContextId, {
			schemaVersion: 1,
			contextId: parentContextId,
			taskId: request.parentSpawn.parentTaskId,
			spawnId: request.parentSpawn.spawnId,
			forkScope: "none",
			lineage: {
				schemaVersion: 1,
				entityType: "context",
				entityId: parentContextId,
				depth: 0,
			},
			createdAt: NOW,
		});
	}
	return {
		schemaVersion: 1,
		request,
		originParentAgentInstance: origin,
		originParentAttemptId: originAttemptId,
		lineageParentAgentInstance: lineageParent,
		childLaneId: overrides.childLaneId ?? `child-lane-${overrides.childAgentInstanceId ?? "1"}`,
		childBinding,
		providerDescriptor: descriptor,
		childAgentInstanceId: overrides.childAgentInstanceId ?? "child-1",
		dispatchId: overrides.dispatchId ?? "dispatch-1",
		attemptId: overrides.attemptId ?? "attempt-1",
		bindingEpochId: overrides.bindingEpochId ?? "epoch-1",
		activatedByCommandId: overrides.activatedByCommandId ?? "command-1",
		queue: overrides.queue ?? { mode: "fail" },
	};
}

async function driveScopedGateway(input: ChildAgentHarnessCreateInputV1): Promise<void> {
	const streamed = await input.gateway.stream(
		{
			schemaVersion: 1,
			requestId: `model:${input.agentInstance.agentInstanceId}`,
			modelProfileRevision: {
				schemaVersion: 1,
				type: "model_profile",
				id: input.binding.modelProfileRevision.id,
				revision: input.binding.modelProfileRevision.revision ?? 1,
			},
			bindingEpochId: input.epoch.bindingEpochId,
			taskId: input.binding.taskId,
			attemptId: input.epoch.attemptId,
			agentInstanceId: input.agentInstance.agentInstanceId,
			input: { prompt: "child" },
		},
		input.signal === undefined ? undefined : { signal: input.signal },
	);
	if (!streamed.ok) throw streamed.error;
	const executed = await input.gateway.execute(
		{
			schemaVersion: 1,
			toolCallId: `tool:${input.agentInstance.agentInstanceId}`,
			toolName: "child.noop",
			originalArguments: {},
			context: {
				schemaVersion: 1,
				bindingId: input.binding.bindingId,
				bindingEpochId: input.epoch.bindingEpochId,
				taskId: input.binding.taskId,
				attemptId: input.epoch.attemptId,
				agentInstanceId: input.agentInstance.agentInstanceId,
			},
		},
		input.signal === undefined ? undefined : { signal: input.signal },
	);
	if (!executed.ok) throw executed.error;
}

async function createHarness(input: ChildAgentHarnessCreateInputV1): Promise<AgentHarness> {
	const faux = fauxProvider();
	const created = await AgentHarness.create({
		session: input.session,
		models: createModels(),
		model: faux.getModel(),
		streamFunction: async (model) => {
			await driveScopedGateway(input);
			const stream = createAssistantMessageEventStream();
			stream.push({
				type: "done",
				reason: "stop",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "ok" }],
					api: model.api,
					provider: model.provider,
					model: model.id,
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
				},
			});
			return stream;
		},
		t5Options: { allowInMemory: true, ownerId: `child:${input.agentInstance.agentInstanceId}` },
	});
	return created.harness;
}

function dispatchFromSpawn(spawned: ChildSpawnResultV1): DispatchV1 {
	return {
		schemaVersion: 1,
		dispatchId: spawned.attempt.dispatchId,
		taskId: spawned.attempt.taskId,
		bindingId: spawned.attempt.bindingId,
		taskExecutorProviderId: spawned.attempt.providerId,
		status: "pending",
		createdAt: spawned.attempt.startedAt,
	};
}

function providerAuthorities(
	_value: Fixture,
	loadParentContext: () => Promise<ResultValue<ContextSnapshot, FoundationError>> =
		async () => Result.err(new FoundationError("subagent_context_fork_invalid", "no parent context")),
) {
	const memorySession = new Session(new InMemorySessionStorage({ id: "provider-parent-memory", createdAt: 1 }));
	const memoryLedger = new SessionT5Ledger(memorySession, {
		ownerId: "parent-memory-writer",
		memoryScopeId: "parent-memory-scope",
		memoryOwnerId: "parent-1",
		artifactBlobStore: new InMemoryArtifactBlobStore(),
	});
	const parentMemory = createScopedMemoryStore(
		memoryLedger.memory,
		"session",
		{ ownerId: "parent-1", scopeId: "parent-memory-scope", createdBy: "system" },
		{ ownerId: "parent-1", scopeId: "parent-memory-scope" },
	);
	return {
		loadParentContext,
		parentMemory: { store: parentMemory, parentAgentInstanceId: "parent-1" } as const,
	};
}

function providerFor(
	value: Fixture,
	quota: RecordingQuota,
	modelGateway: RecordingModelGateway,
	toolGateway: RecordingToolGateway,
	loadParentContext?: () => Promise<ResultValue<ContextSnapshot, FoundationError>>,
): InProcessChildAgentProviderV1 {
	return new InProcessChildAgentProviderV1({
		schemaVersion: 1,
		providerId: PROVIDER_ID,
		supervisor: value.supervisor,
		quota,
		modelGateway,
		toolGateway,
		session: value.session,
		ledger: value.ledger,
		createHarness,
		...providerAuthorities(value, loadParentContext),
		now: () => NOW,
	});
}

function settlementFor(value: Fixture, laneId: string): LayeredResultSettlementV1 {
	return new LayeredResultSettlementV1(value.session, {
		writer: new SessionLedgerWriter(value.session, {
			ownerId: "supervisor-writer",
			lane: laneId,
		}),
	});
}

async function planChild(value: Fixture, overrides: Partial<PlanSubagentSpawnInputV1> = {}): Promise<SubagentSpawnPlanV1> {
	const input = await planInput(value, overrides);
	const planned = await value.supervisor.planSpawn(input);
	if (!planned.ok) throw planned.error;
	return planned.value;
}

function completedOutcome() {
	return Result.ok({
		runId: "run-1",
		kind: "completed" as const,
		leafId: "leaf-1",
		finalEntryId: "entry-1",
		finalMessage: { role: "assistant" as const, content: [{ type: "text" as const, text: "ok" }] },
	});
}

function fakeHarness(hooks: {
	readonly prompt?: () => unknown;
	readonly resume?: () => unknown;
	readonly promptedLanes?: string[];
	readonly resumedLanes?: string[];
}): AgentHarness {
	const prompt = async () => (hooks.prompt !== undefined ? hooks.prompt() : completedOutcome());
	const resume = async () => {
		if (hooks.resume !== undefined) {
			const resumed = (await hooks.resume()) as ReturnType<typeof completedOutcome>;
			if (!resumed.ok) return Result.err({ message: "nothing to resume" });
			return Result.ok({ operation: "run" as const, ...resumed.value });
		}
		return Result.err({ message: "nothing to resume" });
	};
	return {
		prompt,
		promptOnLane: async (lane: string) => {
			hooks.promptedLanes?.push(lane);
			return prompt();
		},
		resume,
		resumeOnLane: async (lane: string) => {
			hooks.resumedLanes?.push(lane);
			return resume();
		},
		createLane: async () => Result.ok({ name: "lane" }),
		abort: async () => Result.ok({ runId: "run-1", steer: [], followUp: [] }),
		close: async () => undefined,
	} as unknown as AgentHarness;
}

describe("InProcessChildAgentProviderV1", () => {
	it("spawns and settles a legal agent_executor receipt through LayeredResultSettlementV1", async () => {
		const value = fixture();
		const planned = await planChild(value);
		const quota = new RecordingQuota();
		const modelGateway = new RecordingModelGateway();
		const toolGateway = new RecordingToolGateway();
		const provider = providerFor(value, quota, modelGateway, toolGateway);
		const settlement = settlementFor(value, planned.childLaneId);
		const spawned = await value.supervisor.executeSpawn(planned, provider, settlement);
		expect(spawned.ok).toBe(true);
		if (!spawned.ok) throw spawned.error;
		expect(spawned.value.attempt.agentInstanceId).toBe(planned.agentInstance.agentInstanceId);
		const lookedUp = await provider.lookupSpawn(planned.request.spawnId);
		expect(lookedUp.ok && lookedUp.value?.attempt.attemptId).toBe(planned.initialBindingEpoch.attemptId);
		const executed = await settlement.executeDispatch({
			dispatch: dispatchFromSpawn(spawned.value),
			binding: planned.childBinding,
			initialBindingEpoch: spawned.value.initialBindingEpoch,
			provider,
			agentInstance: spawned.value.agentInstance,
			correlation: planned.correlation,
		});
		if (!executed.ok) throw executed.error;
		expect(executed.ok).toBe(true);
		const checked = validateAttemptReceiptForProviderV1(executed.value.receipt, {
			providerId: PROVIDER_ID,
			providerClass: "agent",
		});
		expect(checked.ok).toBe(true);
		if (!checked.ok) throw checked.error;
		expect(checked.value.provenance.producerKind).toBe("agent_executor");
		expect(checked.value.agentInstanceId).toBe(planned.agentInstance.agentInstanceId);
		expect(checked.value.sideEffectState).toBe("none");
		expect(checked.value.status).toBe("succeeded");
		expect(modelGateway.calls).toBeGreaterThan(0);
		expect(toolGateway.calls).toBeGreaterThan(0);
		expect(modelGateway.lastRequest?.agentInstanceId).toBe(planned.agentInstance.agentInstanceId);
		expect(quota.reservations).toHaveLength(1);
		expect(quota.reservations[0]?.attribution).toMatchObject({
			ownerKind: "agent_executor",
			taskId: planned.dispatch.taskId,
			attemptId: planned.initialBindingEpoch.attemptId,
			agentInstanceId: planned.agentInstance.agentInstanceId,
			providerId: PROVIDER_ID,
		});
		expect(quota.settlements).toHaveLength(1);
		expect(quota.settlements[0]?.usage.modelCalls).toBeGreaterThan(0);
		expect(quota.settlements[0]?.usage.toolCalls).toBeGreaterThan(0);
		expect(quota.settlements[0]?.usage.tokens).toBeGreaterThan(0);
		const control = await value.ledger.get("subagent.supervisor_control", planned.agentInstance.agentInstanceId);
		expect(control?.kind === "fact" ? (control.payload as { turnCount?: unknown }).turnCount : undefined).toBe(1);
		await provider.dispose();
	});

	it("loads live parent context only for inherited fork scopes and fails closed when it is unavailable", async () => {
		for (const forkScope of ["all", "recent_n"] as const) {
			const value = fixture();
			const input = await planInput(value);
			const planned = await value.supervisor.planSpawn({
				...input,
				request: {
					...input.request,
					forkScope,
					...(forkScope === "recent_n" ? { recentN: 1 } : {}),
				},
			});
			if (!planned.ok) throw planned.error;
			let loads = 0;
			const provider = providerFor(
				value,
				new RecordingQuota(),
				new RecordingModelGateway(),
				new RecordingToolGateway(),
				async () => {
					loads += 1;
					return Result.err(new FoundationError("subagent_context_fork_invalid", "parent snapshot missing"));
				},
			);
			const spawned = await value.supervisor.executeSpawn(planned.value, provider, settlementFor(value, planned.value.childLaneId));
			expect(spawned).toMatchObject({ ok: false, error: { code: "subagent_context_fork_invalid" } });
			expect(loads).toBe(1);
			await provider.dispose();
		}

		const value = fixture();
		const planned = await planChild(value);
		let loads = 0;
		const provider = providerFor(
			value,
			new RecordingQuota(),
			new RecordingModelGateway(),
			new RecordingToolGateway(),
			async () => {
				loads += 1;
				return Result.ok(createContextSnapshot([], { bindingEpochId: "parent-epoch", forkMode: "none", trust: "builtin", budget: { maxTokens: 1000 } }));
			},
		);
		const spawned = await value.supervisor.executeSpawn(planned, provider, settlementFor(value, planned.childLaneId));
		expect(spawned.ok).toBe(true);
		expect(loads).toBe(0);
		await provider.dispose();
	});

	it("fails closed when quota reserve is denied and does not emit a success receipt", async () => {
		const value = fixture();
		const planned = await planChild(value);
		const quota = new RecordingQuota();
		quota.failReserve = true;
		const provider = providerFor(value, quota, new RecordingModelGateway(), new RecordingToolGateway());
		const settlement = settlementFor(value, planned.childLaneId);
		const spawned = await value.supervisor.executeSpawn(planned, provider, settlement);
		expect(spawned.ok).toBe(false);
		if (spawned.ok) throw new Error("expected quota failure");
		expect(spawned.error.code).toBe("quota_exceeded");
		expect(quota.settlements).toHaveLength(0);
		await provider.dispose();
	});

	it("cancels an in-flight child through AbortSignal without fabricating a succeeded receipt", async () => {
		const value = fixture();
		const planned = await planChild(value);
		const quota = new RecordingQuota();
		const modelGateway = new RecordingModelGateway();
		const toolGateway = new RecordingToolGateway();
		const provider = new InProcessChildAgentProviderV1({
			schemaVersion: 1,
			providerId: PROVIDER_ID,
			supervisor: value.supervisor,
			quota,
			modelGateway,
			toolGateway,
			session: value.session,
			ledger: value.ledger,
			...providerAuthorities(value),
			now: () => NOW,
			createHarness: async (input) => {
				if (input.signal?.aborted) {
					throw input.signal.reason ?? new Error("aborted");
				}
				await new Promise<void>((resolve, reject) => {
					const timer = setTimeout(resolve, 1_000);
					input.signal?.addEventListener(
						"abort",
						() => {
							clearTimeout(timer);
							reject(input.signal?.reason ?? new Error("aborted"));
						},
						{ once: true },
					);
				});
				return createHarness(input);
			},
		});
		const settlement = settlementFor(value, planned.childLaneId);
		const spawned = await value.supervisor.executeSpawn(planned, provider, settlement);
		expect(spawned.ok).toBe(true);
		if (!spawned.ok) throw spawned.error;
		const controller = new AbortController();
		const running = settlement.executeDispatch({
			dispatch: dispatchFromSpawn(spawned.value),
			binding: planned.childBinding,
			initialBindingEpoch: spawned.value.initialBindingEpoch,
			provider,
			agentInstance: spawned.value.agentInstance,
			correlation: planned.correlation,
			signal: controller.signal,
		});
		controller.abort();
		const executed = await running;
		if (executed.ok) {
			expect(executed.value.receipt.status).not.toBe("succeeded");
		} else {
			expect(executed.error.code).not.toBeUndefined();
		}
		await provider.dispose();
	});

	it("attaches a background observer cursor for a running child", async () => {
		const value = fixture();
		const planned = await planChild(value);
		const provider = providerFor(value, new RecordingQuota(), new RecordingModelGateway(), new RecordingToolGateway());
		const settlement = settlementFor(value, planned.childLaneId);
		const spawned = await value.supervisor.executeSpawn(planned, provider, settlement);
		expect(spawned.ok).toBe(true);
		const attached = await provider.markBackground(planned.initialBindingEpoch.attemptId);
		expect(attached.ok).toBe(true);
		if (!attached.ok) throw attached.error;
		expect(attached.value.cursor.sessionId).toBe("session-inprocess");
		const replay = provider.attachObserver(planned.initialBindingEpoch.attemptId, attached.value.cursor);
		expect(replay.ok).toBe(true);
		await provider.dispose();
	});

	it("resumes a suspended child on the existing harness without caching the suspended receipt", async () => {
		const value = fixture();
		const planned = await planChild(value);
		const quota = new RecordingQuota();
		const modelGateway = new RecordingModelGateway();
		const toolGateway = new RecordingToolGateway();
		const created: ChildAgentHarnessCreateInputV1[] = [];
		const resumedLanes: string[] = [];
		let prompts = 0;
		let resumes = 0;
		const provider = new InProcessChildAgentProviderV1({
			schemaVersion: 1,
			providerId: PROVIDER_ID,
			supervisor: value.supervisor,
			quota,
			modelGateway,
			toolGateway,
			session: value.session,
			ledger: value.ledger,
			...providerAuthorities(value),
			now: () => NOW,
			createHarness: async (input) => {
				created.push(input);
				return fakeHarness({
					promptedLanes: [],
					resumedLanes,
					prompt: () => {
						prompts += 1;
						return Result.ok({
							runId: "run-1",
							kind: "suspended",
							leafId: "leaf-1",
							finalEntryId: "entry-1",
							deferred: { id: "deferred-1" },
						});
					},
					resume: async () => {
						resumes += 1;
						await driveScopedGateway(input);
						return completedOutcome();
					},
				});
			},
		});
		const settlement = settlementFor(value, planned.childLaneId);
		const spawned = await value.supervisor.executeSpawn(planned, provider, settlement);
		expect(spawned.ok).toBe(true);
		if (!spawned.ok) throw spawned.error;
		const executed = await settlement.executeDispatch({
			dispatch: dispatchFromSpawn(spawned.value),
			binding: planned.childBinding,
			initialBindingEpoch: spawned.value.initialBindingEpoch,
			provider,
			agentInstance: spawned.value.agentInstance,
			correlation: planned.correlation,
		});
		expect(executed.ok).toBe(true);
		if (!executed.ok) throw executed.error;
		expect(executed.value.receipt.status).toBe("suspended");
		expect(quota.settlements).toHaveLength(0);
		const resumed = await provider.resume(planned.initialBindingEpoch.attemptId);
		expect(resumed.ok).toBe(true);
		if (!resumed.ok) throw resumed.error;
		expect(resumed.value.status).toBe("succeeded");
		expect(created).toHaveLength(1);
		expect(prompts).toBe(1);
		expect(resumes).toBe(1);
		expect(resumedLanes).toEqual([planned.childLaneId]);
		expect(quota.settlements).toHaveLength(1);
		expect(quota.settlements[0]?.usage.modelCalls).toBeGreaterThan(0);
		await provider.dispose();
	});

	it("reconstructs resume context from the durable child-lane transcript", async () => {
		const value = fixture();
		const planned = await planChild(value);
		const quota = new RecordingQuota();
		const modelGateway = new RecordingModelGateway();
		const toolGateway = new RecordingToolGateway();
		const created: ChildAgentHarnessCreateInputV1[] = [];
		const promptedLanes: string[] = [];
		const resumedLanes: string[] = [];
		let prompts = 0;
		const provider = new InProcessChildAgentProviderV1({
			schemaVersion: 1,
			providerId: PROVIDER_ID,
			supervisor: value.supervisor,
			quota,
			modelGateway,
			toolGateway,
			session: value.session,
			ledger: value.ledger,
			...providerAuthorities(value),
			now: () => NOW,
			createHarness: async (input) => {
				created.push(input);
				await driveScopedGateway(input);
				return fakeHarness({
					promptedLanes,
					resumedLanes,
					prompt: () => {
						prompts += 1;
						return completedOutcome();
					},
					resume: async () => completedOutcome(),
				});
			},
		});
		const settlement = settlementFor(value, planned.childLaneId);
		const spawned = await value.supervisor.executeSpawn(planned, provider, settlement);
		expect(spawned.ok).toBe(true);
		if (!spawned.ok) throw spawned.error;
		await value.session.createLane(planned.childLaneId, null);
		await value.session.view(planned.childLaneId).appendCustomEntry("child.transcript", { marker: "lane-fact" });
		const resumed = await provider.resume(planned.initialBindingEpoch.attemptId);
		expect(resumed.ok).toBe(true);
		if (!resumed.ok) throw resumed.error;
		expect(resumed.value.status).toBe("succeeded");
		expect(created).toHaveLength(1);
		expect(created[0]?.laneId).toBe(planned.childLaneId);
		expect(prompts).toBe(0);
		expect(promptedLanes).toEqual([]);
		expect(resumedLanes).toEqual([planned.childLaneId]);
		const entries = created[0]?.snapshot?.entries() ?? [];
		expect(entries.some((entry) => "customType" in entry && entry.customType === "child.transcript")).toBe(true);
		expect(quota.settlements).toHaveLength(1);
		await provider.dispose();
	});

	it("fails closed when reconstructed resume has no durable child-lane transcript", async () => {
		const value = fixture();
		const planned = await planChild(value);
		const created: ChildAgentHarnessCreateInputV1[] = [];
		const provider = new InProcessChildAgentProviderV1({
			schemaVersion: 1,
			providerId: PROVIDER_ID,
			supervisor: value.supervisor,
			quota: new RecordingQuota(),
			modelGateway: new RecordingModelGateway(),
			toolGateway: new RecordingToolGateway(),
			session: value.session,
			ledger: value.ledger,
			...providerAuthorities(value),
			now: () => NOW,
			createHarness: async (input) => {
				created.push(input);
				return fakeHarness({});
			},
		});
		const settlement = settlementFor(value, planned.childLaneId);
		const spawned = await value.supervisor.executeSpawn(planned, provider, settlement);
		expect(spawned.ok).toBe(true);
		if (!spawned.ok) throw spawned.error;
		const resumed = await provider.resume(planned.initialBindingEpoch.attemptId);
		expect(resumed.ok).toBe(false);
		if (resumed.ok) throw new Error("expected missing transcript to fail");
		expect(resumed.error.code).toBe("subagent_resume_failed");
		expect(created).toHaveLength(0);
		await provider.dispose();
	});

	it("consumes mailbox context immediately before the recorded child turn", async () => {
		const value = fixture();
		const planned = await planChild(value);
		const prompts: string[] = [];
		let boundaryLoads = 0;
		const provider = new InProcessChildAgentProviderV1({
			schemaVersion: 1,
			providerId: PROVIDER_ID,
			supervisor: value.supervisor,
			quota: new RecordingQuota(),
			modelGateway: new RecordingModelGateway(),
			toolGateway: new RecordingToolGateway(),
			session: value.session,
			ledger: value.ledger,
			...providerAuthorities(value),
			loadTurnBoundaryContext: async () => {
				boundaryLoads += 1;
				return Result.ok('{"messageId":"mail-1","body":"bounded"}');
			},
			createHarness: async () => ({
				promptOnLane: async (_lane: string, prompt: string) => {
					prompts.push(prompt);
					return completedOutcome();
				},
				createLane: async () => Result.ok({ name: planned.childLaneId }),
				abort: async () => Result.ok({ runId: "run-1", steer: [], followUp: [] }),
				close: async () => undefined,
			}) as unknown as AgentHarness,
		});
		const settlement = settlementFor(value, planned.childLaneId);
		const spawned = await value.supervisor.executeSpawn(planned, provider, settlement);
		if (!spawned.ok) throw spawned.error;
		const executed = await settlement.executeDispatch({
			dispatch: dispatchFromSpawn(spawned.value),
			binding: planned.childBinding,
			initialBindingEpoch: spawned.value.initialBindingEpoch,
			provider,
			agentInstance: spawned.value.agentInstance,
			correlation: planned.correlation,
		});
		if (!executed.ok) throw executed.error;
		expect(boundaryLoads).toBe(1);
		expect(prompts[0]).toContain("Child mailbox messages at this turn boundary");
		expect(prompts[0]).toContain("mail-1");
		await provider.dispose();
	});

	it("marks the handle lost when in-process execution throws", async () => {
		const value = fixture();
		const planned = await planChild(value);
		const privateDiagnostic = "provider-private-diagnostic";
		let childMemory: ScopedMemoryStore | undefined;
		const provider = new InProcessChildAgentProviderV1({
			schemaVersion: 1,
			providerId: PROVIDER_ID,
			supervisor: value.supervisor,
			quota: new RecordingQuota(),
			modelGateway: new RecordingModelGateway(),
			toolGateway: new RecordingToolGateway(),
			session: value.session,
			ledger: value.ledger,
			...providerAuthorities(value),
			now: () => NOW,
			createHarness: async (input) => {
				childMemory = input.memory;
				await input.memory.put({
					id: "failed-child-memory",
					kind: "fact",
					trust: "user_owned",
					content: "must be cleaned",
					source: "failure test",
					principal: "system",
				});
				throw new Error(privateDiagnostic);
			},
		});
		const settlement = settlementFor(value, planned.childLaneId);
		const spawned = await value.supervisor.executeSpawn(planned, provider, settlement);
		expect(spawned.ok).toBe(true);
		if (!spawned.ok) throw spawned.error;
		const executed = await settlement.executeDispatch({
			dispatch: dispatchFromSpawn(spawned.value),
			binding: planned.childBinding,
			initialBindingEpoch: spawned.value.initialBindingEpoch,
			provider,
			agentInstance: spawned.value.agentInstance,
			correlation: planned.correlation,
		});
		expect(executed.ok).toBe(false);
		if (executed.ok) throw new Error("expected lost");
		expect(executed.error.code).toBe("subagent_lost");
		expect(executed.error.message).toBe("Child Agent in-process execution was lost");
		expect(executed.error.message).not.toContain(privateDiagnostic);
		const lookedUp = await provider.lookupSpawn(planned.request.spawnId);
		expect(lookedUp.ok).toBe(false);
		if (lookedUp.ok) throw new Error("expected lost lookup");
		expect(lookedUp.error.code).toBe("subagent_lost");
		expect(childMemory?.ownerId).toBe(planned.agentInstance.agentInstanceId);
		expect(await childMemory?.list()).toEqual([]);
		await provider.dispose();
	});

	it("passes the isolated child memory authority to the harness and cleans it on close", async () => {
		const value = fixture();
		const planned = await planChild(value);
		let childMemory: ScopedMemoryStore | undefined;
		const provider = new InProcessChildAgentProviderV1({
			schemaVersion: 1,
			providerId: PROVIDER_ID,
			supervisor: value.supervisor,
			quota: new RecordingQuota(),
			modelGateway: new RecordingModelGateway(),
			toolGateway: new RecordingToolGateway(),
			session: value.session,
			ledger: value.ledger,
			...providerAuthorities(value),
			createHarness: async (input) => {
				childMemory = input.memory;
				await input.memory.put({
					id: "successful-child-memory",
					kind: "fact",
					trust: "user_owned",
					content: "temporary child state",
					source: "close test",
					principal: "system",
				});
				return fakeHarness({});
			},
		});
		const settlement = settlementFor(value, planned.childLaneId);
		const spawned = await value.supervisor.executeSpawn(planned, provider, settlement);
		if (!spawned.ok) throw spawned.error;
		const executed = await settlement.executeDispatch({
			dispatch: dispatchFromSpawn(spawned.value),
			binding: planned.childBinding,
			initialBindingEpoch: spawned.value.initialBindingEpoch,
			provider,
			agentInstance: spawned.value.agentInstance,
			correlation: planned.correlation,
		});
		if (!executed.ok) throw executed.error;
		expect(childMemory?.parentId).toBe("parent-memory-scope");
		expect(await childMemory?.count()).toBe(1);
		const closed = await provider.close(planned.initialBindingEpoch.attemptId);
		expect(closed.ok).toBe(true);
		expect(await childMemory?.list()).toEqual([]);
		await provider.dispose();
	});

	it("keeps independent child lanes and contexts from crossing", async () => {
		const value = fixture();
		const plannedA = await planChild(value, {
			childAgentInstanceId: "child-a",
			attemptId: "attempt-a",
			dispatchId: "dispatch-a",
			bindingEpochId: "epoch-a",
			activatedByCommandId: "command-a",
		});
		const plannedB = await planChild(value, {
			childAgentInstanceId: "child-b",
			attemptId: "attempt-b",
			dispatchId: "dispatch-b",
			bindingEpochId: "epoch-b",
			activatedByCommandId: "command-b",
		});
		const quota = new RecordingQuota();
		const modelGateway = new RecordingModelGateway();
		const toolGateway = new RecordingToolGateway();
		const created: ChildAgentHarnessCreateInputV1[] = [];
		const promptedLanes: string[] = [];
		const provider = new InProcessChildAgentProviderV1({
			schemaVersion: 1,
			providerId: PROVIDER_ID,
			supervisor: value.supervisor,
			quota,
			modelGateway,
			toolGateway,
			session: value.session,
			ledger: value.ledger,
			...providerAuthorities(value),
			now: () => NOW,
			createHarness: async (input) => {
				created.push(input);
				await driveScopedGateway(input);
				return fakeHarness({ promptedLanes });
			},
		});
		const settlementA = settlementFor(value, plannedA.childLaneId);
		const settlementB = settlementFor(value, plannedB.childLaneId);
		const spawnedA = await value.supervisor.executeSpawn(plannedA, provider, settlementA);
		const spawnedB = await value.supervisor.executeSpawn(plannedB, provider, settlementB);
		expect(spawnedA.ok).toBe(true);
		expect(spawnedB.ok).toBe(true);
		if (!spawnedA.ok || !spawnedB.ok) throw new Error("expected both spawns");
		const executedA = await settlementA.executeDispatch({
			dispatch: dispatchFromSpawn(spawnedA.value),
			binding: plannedA.childBinding,
			initialBindingEpoch: spawnedA.value.initialBindingEpoch,
			provider,
			agentInstance: spawnedA.value.agentInstance,
			correlation: plannedA.correlation,
		});
		const executedB = await settlementB.executeDispatch({
			dispatch: dispatchFromSpawn(spawnedB.value),
			binding: plannedB.childBinding,
			initialBindingEpoch: spawnedB.value.initialBindingEpoch,
			provider,
			agentInstance: spawnedB.value.agentInstance,
			correlation: plannedB.correlation,
		});
		expect(executedA.ok).toBe(true);
		expect(executedB.ok).toBe(true);
		expect(created.map((input) => input.laneId)).toEqual([plannedA.childLaneId, plannedB.childLaneId]);
		expect(promptedLanes).toEqual([plannedA.childLaneId, plannedB.childLaneId]);
		expect(plannedA.childLaneId).not.toBe(plannedB.childLaneId);
		expect(created[0]?.snapshot).not.toBe(created[1]?.snapshot);
		expect(quota.reservations).toHaveLength(2);
		expect(quota.reservations[0]?.attribution.agentInstanceId).toBe(plannedA.agentInstance.agentInstanceId);
		expect(quota.reservations[1]?.attribution.agentInstanceId).toBe(plannedB.agentInstance.agentInstanceId);
		await provider.dispose();
	});
});
