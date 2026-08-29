import {
	createAgentInstance,
	createAttempt,
	createModelProfileRevision,
	createRoleRevision,
	createTaskEnvelope,
	fingerprintFoundationValue,
	FoundationError,
	InMemorySessionStorage,
	LayeredResultSettlement,
	resolveAgentBinding,
	Result,
	Session,
	SessionLedger,
	SessionLedgerWriter,
	validateAgentInstance,
	validateAttempt,
	type AgentBinding,
	type AgentInstance,
	type AttemptReceipt,
	type ChildAgentProvider,
	type ChildSpawnRequest,
	type ChildSpawnResult,
	type ModelProfile,
	type RevisionReference,
	type RoleRevision,
	type TaskEnvelope,
	type TaskExecutorProvider,
} from "@aos-agent/agent-core";
import { describe, expect, it } from "vitest";
import type { SubagentProviderDescriptor } from "../src/core/subagent-registry.ts";
import {
	SUBAGENT_SUPERVISOR_CONTROL_OBJECT_TYPE,
	SubagentSupervisor,
	type PlanSubagentSpawnInput,
	type SubagentSpawnPlan,
} from "../src/core/subagent-supervisor.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const PROVIDER_ID = "native.in_process";

function task(taskId: string, concurrency = 2): TaskEnvelope {
	const result = createTaskEnvelope({
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

function role(): RoleRevision {
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

function profile(): ModelProfile {
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

function immutableFact(type: string, id: string): RevisionReference {
	const value = { schemaVersion: 1 as const, type, id, revision: 1 };
	return { ...value, fingerprint: fingerprintFoundationValue(value) };
}

function binding(taskEnvelope: TaskEnvelope, roleRevision: RoleRevision, modelProfile: ModelProfile): AgentBinding {
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

function rootAgent(agentInstanceId: string, taskId: string, roleRevision: RoleRevision): AgentInstance {
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

function childAgent(agentInstanceId: string, taskId: string, parent: AgentInstance, roleRevision: RoleRevision): AgentInstance {
	const result = createAgentInstance({
		agentInstanceId,
		providerId: "parent-provider",
		providerDeclaredAgent: true,
		roleRevision,
		taskId,
		parent,
		now: () => NOW,
	});
	if (!result.ok) throw result.error;
	return result.value;
}

const descriptor: SubagentProviderDescriptor = {
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

interface Fixture {
	readonly session: Session;
	readonly ledger: SessionLedger;
	readonly ledgerForLane: (laneId: string) => SessionLedger;
	readonly supervisor: SubagentSupervisor;
	readonly roleRevision: RoleRevision;
	readonly modelProfile: ModelProfile;
	readonly misdirectChildWrites: () => void;
	readonly scheduledQueueTimeouts: readonly { readonly milliseconds: number; readonly fire: () => void; readonly cancelled: () => boolean }[];
}

function fixture(
	options: {
		maxDepth?: number;
		maxConcurrent?: number;
		maxTurns?: number;
		queueCapacity?: number;
		session?: Session;
		controlLaneId?: string;
	} = {},
): Fixture {
	const session = options.session ?? new Session(new InMemorySessionStorage({ id: "session-supervisor", createdAt: 1 }));
	const controlLaneId = options.controlLaneId ?? "control-lane";
	const ledgers = new Map<string, SessionLedger>();
	const scheduledQueueTimeouts: { milliseconds: number; fire: () => void; cancelled: () => boolean }[] = [];
	let misdirect = false;
	const ledgerForLane = (laneId: string): SessionLedger => {
		const selectedLane = misdirect && laneId !== controlLaneId ? controlLaneId : laneId;
		let ledger = ledgers.get(selectedLane);
		if (ledger === undefined) {
			ledger = new SessionLedger(session, { ownerId: "supervisor-writer", laneId: selectedLane });
			ledgers.set(selectedLane, ledger);
		}
		return ledger;
	};
	const ledger = ledgerForLane(controlLaneId);
	return {
		session,
		ledger,
		ledgerForLane,
		supervisor: new SubagentSupervisor({
			schemaVersion: 1,
			ledger,
			ledgerForLane,
			sessionId: "session-supervisor",
			laneId: controlLaneId,
			maxDepth: options.maxDepth ?? 4,
			maxConcurrent: options.maxConcurrent ?? 2,
			maxTurns: options.maxTurns ?? 4,
			queueCapacity: options.queueCapacity ?? 2,
			maximumQueueWaitMs: 100,
			now: () => NOW,
			scheduleQueueTimeout: (milliseconds, onTimeout) => {
				let cancelled = false;
				scheduledQueueTimeouts.push({
					milliseconds,
					fire: () => {
						if (!cancelled) onTimeout();
					},
					cancelled: () => cancelled,
				});
				return () => {
					cancelled = true;
				};
			},
		}),
		roleRevision: role(),
		modelProfile: profile(),
		misdirectChildWrites: () => {
			misdirect = true;
		},
		scheduledQueueTimeouts,
	};
}

async function planInput(
	value: Fixture,
	overrides: Partial<PlanSubagentSpawnInput> = {},
	originAttemptOverrides: {
		readonly objectId?: string;
		readonly payloadAttemptId?: string;
		readonly status?: "starting" | "running" | "awaiting_checkpoint" | "suspended" | "succeeded" | "failed" | "cancelled";
		readonly laneId?: string;
		readonly correlationAttemptId?: string;
		readonly correlationAgentInstanceId?: string;
		readonly correlationTaskId?: string;
		readonly correlationDispatchId?: string;
		readonly correlationBindingId?: string;
		readonly correlationBindingEpochId?: string;
		readonly emptyBindingEpochIds?: boolean;
		readonly lineageParentLaneId?: string;
	} = {},
): Promise<PlanSubagentSpawnInput> {
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
		laneId?: string,
	): Promise<void> => {
		if ((await value.ledger.get(objectType, objectId)) !== undefined) return;
		await (laneId === undefined ? value.ledger : value.ledgerForLane(laneId)).appendFact(objectType, objectId, payload, {
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
	}, originAttemptOverrides.lineageParentLaneId);
	const originAttemptId = overrides.originParentAttemptId ?? "attempt-parent";
	const originAttemptObjectId = originAttemptOverrides.objectId ?? originAttemptId;
	if ((await value.ledger.get("attempt", originAttemptObjectId)) === undefined) {
		await (originAttemptOverrides.laneId === undefined ? value.ledger : value.ledgerForLane(originAttemptOverrides.laneId)).appendFact("attempt", originAttemptObjectId, {
		schemaVersion: 1,
		attemptId: originAttemptOverrides.payloadAttemptId ?? originAttemptId,
		dispatchId: `dispatch-${originAttemptId}`,
		taskId: origin.taskId,
		providerId: origin.providerId,
		agentInstanceId: origin.agentInstanceId,
		bindingId: `binding-${origin.taskId}`,
		bindingEpochIds: originAttemptOverrides.emptyBindingEpochIds ? [] : [`epoch-${originAttemptId}`],
		status: originAttemptOverrides.status ?? "running",
		startedAt: NOW,
		}, {
			clientRequestId: `seed:attempt:${originAttemptObjectId}`,
			expectedRevision: 0,
			correlation: {
				taskId: originAttemptOverrides.correlationTaskId ?? origin.taskId,
				dispatchId: originAttemptOverrides.correlationDispatchId ?? `dispatch-${originAttemptId}`,
				attemptId: originAttemptOverrides.correlationAttemptId ?? originAttemptId,
				bindingId: originAttemptOverrides.correlationBindingId ?? `binding-${origin.taskId}`,
				bindingEpochId: originAttemptOverrides.correlationBindingEpochId ?? `epoch-${originAttemptId}`,
				agentInstanceId: originAttemptOverrides.correlationAgentInstanceId ?? origin.agentInstanceId,
			},
		});
	}
	const spawnId = overrides.request?.spawnId ?? `spawn-${overrides.childAgentInstanceId ?? "1"}`;
	const parentSpawnId = `parent-${spawnId}`;
	const request: ChildSpawnRequest = overrides.request ?? {
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
		...(overrides.maxTurns === undefined ? {} : { maxTurns: overrides.maxTurns }),
		...(overrides.parentDeadlineAt === undefined ? {} : { parentDeadlineAt: overrides.parentDeadlineAt }),
	};
}

function spawnResult(plan: SubagentSpawnPlan): ChildSpawnResult {
	const attempt = createAttempt({
		attemptId: plan.initialBindingEpoch.attemptId,
		dispatch: plan.dispatch,
		providerId: plan.providerId,
		initialBindingEpoch: plan.initialBindingEpoch,
		providerClass: "agent",
		agentInstanceId: plan.agentInstance.agentInstanceId,
		now: () => NOW,
	});
	if (!attempt.ok) throw attempt.error;
	return { schemaVersion: 1, attempt: attempt.value, agentInstance: plan.agentInstance, initialBindingEpoch: plan.initialBindingEpoch };
}

function provider(overrides: Partial<ChildAgentProvider> = {}): ChildAgentProvider {
	return {
		schemaVersion: 1,
		providerId: PROVIDER_ID,
		providerClass: "agent",
		async capabilities() {
			return [];
		},
		async spawn() {
			return Result.err(new FoundationError("subagent_provider_unavailable", "not called directly"));
		},
		async resume() {
			return Result.err(new FoundationError("subagent_resume_failed", "not configured"));
		},
		async cancel() {
			return Result.ok(undefined);
		},
		async dispose() {},
		...overrides,
	};
}

async function makeRunning(value: Fixture, input: PlanSubagentSpawnInput): Promise<SubagentSpawnPlan> {
	const planned = await value.supervisor.planSpawn(input);
	if (!planned.ok) throw planned.error;
	const childProvider = provider({
		spawn: async () => Result.ok(spawnResult(planned.value)),
	});
	const settlement = new LayeredResultSettlement(value.session, {
		writer: new SessionLedgerWriter(value.session, {
			ownerId: "supervisor-writer",
			lane: planned.value.childLaneId,
		}),
	});
	const executed = await value.supervisor.executeSpawn(planned.value, childProvider, settlement);
	if (!executed.ok) throw executed.error;
	return planned.value;
}

function receipt(plan: SubagentSpawnPlan, status: AttemptReceipt["status"] = "succeeded"): AttemptReceipt {
	return {
		schemaVersion: 1,
		attemptReceiptId: `receipt-${plan.initialBindingEpoch.attemptId}`,
		taskId: plan.dispatch.taskId,
		dispatchId: plan.dispatch.dispatchId,
		attemptId: plan.initialBindingEpoch.attemptId,
		providerId: plan.providerId,
		agentInstanceId: plan.agentInstance.agentInstanceId,
		bindingId: plan.childBinding.bindingId,
		bindingEpochIds: [plan.initialBindingEpoch.bindingEpochId],
		status,
		workerReceiptRefs: [],
		artifacts: [],
		provenance: {
			producerKind: "agent_executor",
			providerId: plan.providerId,
			producedAt: NOW,
			correlation: { ...plan.correlation, attemptReceiptId: `receipt-${plan.initialBindingEpoch.attemptId}` },
		},
		sideEffectState: "none",
	};
}

async function persistReceipt(
	value: Fixture,
	plan: SubagentSpawnPlan,
	status: AttemptReceipt["status"] = "succeeded",
): Promise<AttemptReceipt> {
	const produced = receipt(plan, status);
	const durableAttempt = await value.ledger.get("attempt", plan.initialBindingEpoch.attemptId);
	const attempt = durableAttempt?.kind === "fact" ? validateAttempt(durableAttempt.payload) : undefined;
	if (attempt === undefined || !attempt.ok) throw new Error("missing durable child Attempt");
	const executionProvider: TaskExecutorProvider = {
		schemaVersion: 1,
		providerId: plan.providerId,
		providerClass: "agent",
		async capabilities() {
			return [];
		},
		async createAttempt() {
			return Result.ok(attempt.value);
		},
		async runAttempt() {
			return Result.ok(produced);
		},
		async cancelAttempt() {
			return Result.ok(undefined);
		},
		async dispose() {},
	};
	const writer = new SessionLedgerWriter(value.session, {
		ownerId: "supervisor-writer",
		lane: plan.childLaneId,
	});
	const settlement = new LayeredResultSettlement(value.session, { writer });
	const accepted = await settlement.executeDispatch({
		dispatch: plan.dispatch,
		binding: plan.childBinding,
		initialBindingEpoch: plan.initialBindingEpoch,
		provider: executionProvider,
		agentInstance: plan.agentInstance,
		correlation: plan.correlation,
	});
	if (!accepted.ok) throw accepted.error;
	return accepted.value.receipt;
}

describe("SubagentSupervisor", () => {
	it("persists unique child lanes and exposes the exact provider plan keyed by spawnId", async () => {
		const value = fixture();
		const input = await planInput(value);
		const planned = await makeRunning(value, input);
		expect(planned.correlation.laneId).toBe("child-lane-1");
		expect(value.supervisor.roster()[0]?.laneId).toBe("child-lane-1");
		expect(value.supervisor.providerSpawnPlan({ schemaVersion: 1, spawnId: input.request.spawnId })).toMatchObject({
			ok: true,
			value: {
				childLaneId: "child-lane-1",
				childAgentInstanceId: "child-1",
				dispatchId: "dispatch-1",
				attemptId: "attempt-1",
				bindingEpochId: "epoch-1",
			},
		});
		for (const [objectType, objectId] of [
			["attempt", planned.initialBindingEpoch.attemptId],
			["agent_instance", planned.agentInstance.agentInstanceId],
			["binding_epoch", planned.initialBindingEpoch.bindingEpochId],
		] as const) {
			const fact = await value.ledger.get(objectType, objectId);
			expect(fact?.kind).toBe("fact");
			if (fact?.kind !== "fact") throw new Error(`missing ${objectType} fact`);
			expect(fact.correlation).toMatchObject({
				sessionId: "session-supervisor",
				laneId: "child-lane-1",
				taskId: planned.dispatch.taskId,
				agentInstanceId: planned.agentInstance.agentInstanceId,
			});
		}
		expect(value.supervisor.providerSpawnPlan({ schemaVersion: 1, spawnId: input.request.spawnId, extra: true })).toMatchObject({
			ok: false,
			error: { code: "subagent_spawn_invalid" },
		});
	});

	it("keeps origin spawn proof separate from a proven ancestor lineage reparent", async () => {
		const value = fixture();
		const ancestor = rootAgent("ancestor-1", "task-ancestor", value.roleRevision);
		const origin = childAgent("parent-nested", "task-nested", ancestor, value.roleRevision);
		const input = await planInput(value, {
			originParentAgentInstance: origin,
			lineageParentAgentInstance: ancestor,
			childAgentInstanceId: "child-flat",
			childLaneId: "child-lane-flat",
			dispatchId: "dispatch-flat",
			attemptId: "attempt-flat",
			bindingEpochId: "epoch-flat",
		});
		const planned = await value.supervisor.planSpawn(input);
		expect(planned.ok).toBe(true);
		if (!planned.ok) throw planned.error;
		expect(planned.value.agentInstance.lineage.parentId).toBe(ancestor.agentInstanceId);
		expect(planned.value.agentInstance.lineage.ancestorIds).toEqual([ancestor.agentInstanceId]);
		const control = await value.ledger.get(SUBAGENT_SUPERVISOR_CONTROL_OBJECT_TYPE, "child-flat");
		if (control?.kind !== "fact") throw new Error("missing control fact");
		expect(control?.payload).toMatchObject({
			originParentAgentInstanceId: origin.agentInstanceId,
			originParentTaskId: origin.taskId,
			originParentAttemptId: "attempt-parent",
			lineageParentAgentInstanceId: ancestor.agentInstanceId,
			reparented: true,
		});
	});

	it("rejects a reparent lineage AgentInstance stored with foreign lane metadata", async () => {
		const value = fixture();
		const ancestor = rootAgent("ancestor-wrong-lane", "task-ancestor-wrong-lane", value.roleRevision);
		const origin = childAgent("origin-wrong-lane", "task-origin-wrong-lane", ancestor, value.roleRevision);
		const input = await planInput(
			value,
			{
				originParentAgentInstance: origin,
				lineageParentAgentInstance: ancestor,
			},
			{ lineageParentLaneId: "foreign-lineage-lane" },
		);
		expect(await value.supervisor.planSpawn(input)).toMatchObject({
			ok: false,
			error: { code: "subagent_spawn_invalid" },
		});
	});

	it("rejects forged reparenting, extra input keys, duplicate lanes, and depth overflow", async () => {
		const value = fixture({ maxDepth: 1 });
		const input = await planInput(value);
		expect(await value.supervisor.planSpawn({ ...input, extra: true })).toMatchObject({ ok: false, error: { code: "subagent_spawn_invalid" } });
		const foreign = rootAgent("foreign", "task-foreign", value.roleRevision);
		expect(await value.supervisor.planSpawn({ ...input, lineageParentAgentInstance: foreign })).toMatchObject({
			ok: false,
			error: { code: "subagent_spawn_invalid" },
		});
		const first = await value.supervisor.planSpawn(input);
		expect(first.ok).toBe(true);
		const secondInput = await planInput(value, {
			childAgentInstanceId: "child-2",
			childLaneId: input.childLaneId,
			dispatchId: "dispatch-2",
			attemptId: "attempt-2",
			bindingEpochId: "epoch-2",
		});
		expect(await value.supervisor.planSpawn(secondInput)).toMatchObject({ ok: false, error: { code: "subagent_conflict" } });
		const nested = childAgent("nested", "task-nested", input.originParentAgentInstance, value.roleRevision);
		const tooDeep = await planInput(fixture({ maxDepth: 1 }), { originParentAgentInstance: nested });
		expect(await fixture({ maxDepth: 1 }).supervisor.planSpawn(tooDeep)).toMatchObject({
			ok: false,
			error: { code: "subagent_depth_exceeded" },
		});
	});

	it("rejects missing, forged, miscorrelated, and terminal durable parent Attempts", async () => {
		for (const [caseName, attemptOverrides] of [
			["object", { objectId: "attempt-other" }],
			["payload", { payloadAttemptId: "attempt-forged" }],
			["correlation", { correlationAgentInstanceId: "foreign-parent" }],
			["lane", { laneId: "foreign-parent-lane" }],
			["internal-correlation", { correlationDispatchId: "dispatch-forged" }],
			["empty-binding-epochs", { emptyBindingEpochIds: true }],
			["terminal", { status: "succeeded" as const }],
		] as const) {
			const value = fixture();
			const input = await planInput(value, {}, attemptOverrides);
			expect(await value.supervisor.planSpawn(input), caseName).toMatchObject({
				ok: false,
				error: { code: "subagent_spawn_invalid" },
			});
		}
	});

	it("accepts a mode-switched parent Attempt revision and derives a registered child origin lane", async () => {
		const revised = fixture();
		const revisedInput = await planInput(revised);
		const current = await revised.ledger.get("attempt", revisedInput.originParentAttemptId);
		const checked = current?.kind === "fact" ? validateAttempt(current.payload) : undefined;
		if (checked === undefined || !checked.ok) throw new Error("missing parent Attempt");
		const nextEpochId = "epoch-parent-mode-switch";
		await revised.ledger.appendFact(
			"attempt",
			checked.value.attemptId,
			{ ...checked.value, bindingEpochIds: [...checked.value.bindingEpochIds, nextEpochId] },
			{
				clientRequestId: "seed:attempt:mode-switch",
				expectedRevision: 1,
				correlation: {
					taskId: checked.value.taskId,
					dispatchId: checked.value.dispatchId,
					attemptId: checked.value.attemptId,
					bindingId: checked.value.bindingId,
					bindingEpochId: nextEpochId,
					agentInstanceId: checked.value.agentInstanceId,
				},
			},
		);
		expect((await revised.supervisor.planSpawn(revisedInput)).ok).toBe(true);

		const nested = fixture({ maxConcurrent: 2 });
		const parentPlan = await makeRunning(nested, await planInput(nested));
		const durableParentAgent = await nested.ledger.get("agent_instance", parentPlan.agentInstance.agentInstanceId);
		const checkedParentAgent = durableParentAgent?.kind === "fact"
			? validateAgentInstance(durableParentAgent.payload)
			: undefined;
		if (checkedParentAgent === undefined || !checkedParentAgent.ok) throw new Error("missing durable nested parent AgentInstance");
		const grandchildInput = await planInput(nested, {
			originParentAgentInstance: checkedParentAgent.value,
			originParentAttemptId: parentPlan.initialBindingEpoch.attemptId,
			lineageParentAgentInstance: checkedParentAgent.value,
			childAgentInstanceId: "grandchild-1",
			childLaneId: "grandchild-lane-1",
			dispatchId: "dispatch-grandchild-1",
			attemptId: "attempt-grandchild-1",
			bindingEpochId: "epoch-grandchild-1",
		});
		const grandchild = await nested.supervisor.planSpawn(grandchildInput);
		if (!grandchild.ok) throw grandchild.error;
		expect(grandchild.ok).toBe(true);
	});

	it("uses deterministic fail or bounded FIFO queue concurrency gates", async () => {
		const value = fixture({ maxConcurrent: 1, queueCapacity: 1 });
		const firstInput = await planInput(value);
		const firstPlan = await makeRunning(value, firstInput);
		const secondInput = await planInput(value, {
			childAgentInstanceId: "child-2",
			childLaneId: "child-lane-2",
			dispatchId: "dispatch-2",
			attemptId: "attempt-2",
			bindingEpochId: "epoch-2",
		});
		expect(await value.supervisor.planSpawn(secondInput)).toMatchObject({
			ok: false,
			error: { code: "subagent_concurrency_exceeded" },
		});
		const queued = value.supervisor.planSpawn({ ...secondInput, queue: { mode: "queue", timeoutMs: 50 } });
		const firstReceipt = await persistReceipt(value, firstPlan);
		const settled = await value.supervisor.settleReceipt("child-1", firstReceipt);
		expect(settled.ok).toBe(true);
		expect((await queued).ok).toBe(true);
		expect(value.scheduledQueueTimeouts).toHaveLength(1);
		expect(value.scheduledQueueTimeouts[0]?.milliseconds).toBe(50);
		expect(value.scheduledQueueTimeouts[0]?.cancelled()).toBe(true);
	});

	it("releases all reserved identities after an injected queue timeout", async () => {
		const value = fixture({ maxConcurrent: 1, queueCapacity: 1 });
		const firstPlan = await makeRunning(value, await planInput(value));
		const secondInput = await planInput(value, {
			childAgentInstanceId: "child-timeout",
			childLaneId: "child-lane-timeout",
			dispatchId: "dispatch-timeout",
			attemptId: "attempt-timeout",
			bindingEpochId: "epoch-timeout",
			queue: { mode: "queue", timeoutMs: 25 },
		});
		const queued = value.supervisor.planSpawn(secondInput);
		for (let index = 0; index < 20 && value.scheduledQueueTimeouts.length === 0; index += 1) await Promise.resolve();
		expect(value.scheduledQueueTimeouts).toHaveLength(1);
		value.scheduledQueueTimeouts[0]!.fire();
		expect(await queued).toMatchObject({ ok: false, error: { code: "subagent_concurrency_exceeded" } });
		const firstReceipt = await persistReceipt(value, firstPlan);
		expect((await value.supervisor.settleReceipt("child-1", firstReceipt)).ok).toBe(true);
		expect(await value.supervisor.planSpawn({ ...secondInput, queue: { mode: "fail" } })).toMatchObject({ ok: true });
	});

	it("atomically reserves lane, spawn, and child identities across concurrent plans", async () => {
		for (const collision of ["lane", "spawn", "child"] as const) {
			const value = fixture({ maxConcurrent: 2 });
			const first = await planInput(value, {
				childAgentInstanceId: `child-a-${collision}`,
				childLaneId: `child-lane-a-${collision}`,
				dispatchId: `dispatch-a-${collision}`,
				attemptId: `attempt-a-${collision}`,
				bindingEpochId: `epoch-a-${collision}`,
			});
			let second = await planInput(value, {
				childAgentInstanceId: `child-b-${collision}`,
				childLaneId: `child-lane-b-${collision}`,
				dispatchId: `dispatch-b-${collision}`,
				attemptId: `attempt-b-${collision}`,
				bindingEpochId: `epoch-b-${collision}`,
			});
			if (collision === "lane") second = { ...second, childLaneId: first.childLaneId };
			if (collision === "child") second = { ...second, childAgentInstanceId: first.childAgentInstanceId };
			if (collision === "spawn") {
				second = {
					...second,
					request: {
						...second.request,
						spawnId: first.request.spawnId,
					},
				};
			}
			const results = await Promise.all([value.supervisor.planSpawn(first), value.supervisor.planSpawn(second)]);
			expect(results.filter((result) => result.ok), collision).toHaveLength(1);
			expect(results.filter((result) => !result.ok), collision).toMatchObject([
				{ ok: false, error: { code: "subagent_conflict" } },
			]);
		}
	});

	it("reloads only controls and lifecycle owned by its parent lane in a shared Session", async () => {
		const session = new Session(new InMemorySessionStorage({ id: "session-supervisor", createdAt: 1 }));
		const first = fixture({ session, controlLaneId: "control-a" });
		const second = fixture({ session, controlLaneId: "control-b" });
		expect((await first.supervisor.planSpawn(await planInput(first, {
			childAgentInstanceId: "child-owned-a",
			childLaneId: "child-lane-owned-a",
			dispatchId: "dispatch-owned-a",
			attemptId: "attempt-owned-a",
			bindingEpochId: "epoch-owned-a",
		}))).ok).toBe(true);
		const secondOrigin = rootAgent("parent-owned-b", "task-parent-owned-b", second.roleRevision);
		const secondPlan = await second.supervisor.planSpawn(await planInput(second, {
			originParentAgentInstance: secondOrigin,
			lineageParentAgentInstance: secondOrigin,
			originParentAttemptId: "attempt-parent-owned-b",
			childAgentInstanceId: "child-owned-b",
			childLaneId: "child-lane-owned-b",
			dispatchId: "dispatch-owned-b",
			attemptId: "attempt-owned-b",
			bindingEpochId: "epoch-owned-b",
		}));
		if (!secondPlan.ok) throw secondPlan.error;
		expect(secondPlan.ok).toBe(true);
		expect(await first.supervisor.reload()).toMatchObject({ ok: true, value: [{ childAgentInstanceId: "child-owned-a" }] });
		expect(await second.supervisor.reload()).toMatchObject({ ok: true, value: [{ childAgentInstanceId: "child-owned-b" }] });
	});

	it("durably suspends at max turns and requires an exact bounded parent decision", async () => {
		const value = fixture({ maxTurns: 3 });
		const input = await planInput(value, { maxTurns: 1 });
		await makeRunning(value, input);
		expect(await value.supervisor.recordTurn({ schemaVersion: 1, childAgentInstanceId: "child-1", expectedTurnCount: 0 })).toEqual({
			ok: true,
			value: 1,
		});
		expect(value.supervisor.get("child-1")?.status).toBe("awaiting_input");
		expect(await value.supervisor.recordTurn({ schemaVersion: 1, childAgentInstanceId: "child-1", expectedTurnCount: 1 })).toMatchObject({
			ok: false,
			error: { code: "subagent_max_turns_exceeded" },
		});
		expect(
			await value.supervisor.decideMaxTurns({
				schemaVersion: 1,
				childAgentInstanceId: "child-1",
				expectedTurnCount: 1,
				decision: "continue",
				additionalTurns: 3,
			}),
		).toMatchObject({ ok: false, error: { code: "subagent_max_turns_exceeded" } });
		expect(
			await value.supervisor.decideMaxTurns({
				schemaVersion: 1,
				childAgentInstanceId: "child-1",
			expectedTurnCount: 1,
				decision: "continue",
				additionalTurns: 1,
			}),
		).toMatchObject({ ok: true, value: { status: "background" } });
	});

	it("requires reload recovery before resume and persists terminal close", async () => {
		const value = fixture();
		const input = await planInput(value);
		const plan = await makeRunning(value, input);
		const durableReceipt = await persistReceipt(value, plan);
		const resumeProvider = provider({ resume: async () => Result.ok(durableReceipt) });
		expect(await value.supervisor.resume("child-1", resumeProvider)).toMatchObject({
			ok: false,
			error: { code: "subagent_resume_failed" },
		});
		const reloaded = new SubagentSupervisor({
			schemaVersion: 1,
			ledger: value.ledger,
			ledgerForLane: value.ledgerForLane,
			sessionId: "session-supervisor",
			laneId: "control-lane",
			maxDepth: 4,
			maxConcurrent: 2,
			maxTurns: 4,
			queueCapacity: 2,
			maximumQueueWaitMs: 100,
			now: () => NOW,
		});
		expect(await reloaded.reload()).toMatchObject({ ok: true });
		expect(await reloaded.resume("child-1", resumeProvider)).toMatchObject({ ok: true, value: { status: "succeeded" } });
		expect(await reloaded.close("child-1", false)).toMatchObject({ ok: false, error: { code: "subagent_close_unknown" } });
		expect(await reloaded.close("child-1", true)).toMatchObject({ ok: true, value: { status: "closed" } });
	});

	it("durably suspends a valid suspended receipt and never converts resume suspension to lost", async () => {
		const value = fixture({ maxTurns: 4 });
		const input = await planInput(value, { maxTurns: 2 });
		const plan = await makeRunning(value, input);
		const suspended = await persistReceipt(value, plan, "suspended");
		expect(await value.supervisor.settleReceipt("child-1", suspended)).toMatchObject({
			ok: true,
			value: { status: "awaiting_input" },
		});
		expect(await value.supervisor.resume("child-1", provider({ resume: async () => Result.ok(suspended) }))).toMatchObject({
			ok: false,
			error: { code: "subagent_resume_failed" },
		});
		expect(await value.supervisor.decideMaxTurns({
				schemaVersion: 1,
				childAgentInstanceId: "child-1",
				expectedTurnCount: 0,
				decision: "continue",
				additionalTurns: 1,
			})).toMatchObject({ ok: true, value: { status: "background" } });

		const recovery = fixture({ maxTurns: 4 });
		const recoveryInput = await planInput(recovery, { maxTurns: 2 });
		const recoveryPlan = await makeRunning(recovery, recoveryInput);
		const recoverySupervisor = new SubagentSupervisor({
			schemaVersion: 1,
			ledger: recovery.ledger,
			ledgerForLane: recovery.ledgerForLane,
			sessionId: "session-supervisor",
			laneId: "control-lane",
			maxDepth: 4,
			maxConcurrent: 2,
			maxTurns: 4,
			queueCapacity: 2,
			maximumQueueWaitMs: 100,
			now: () => NOW,
		});
		expect((await recoverySupervisor.reload()).ok).toBe(true);
		const recoveryReceipt = await persistReceipt(recovery, recoveryPlan, "suspended");
		expect(
			await recoverySupervisor.resume(
				"child-1",
				provider({ resume: async () => Result.ok(recoveryReceipt) }),
			),
		).toMatchObject({ ok: true, value: { status: "awaiting_input" } });
		expect(recoverySupervisor.get("child-1")?.status).not.toBe("lost");
	});

	it("marks malformed, missing, and unsafe receipts lost with no retry", async () => {
		for (const [caseName, makeReceipt] of [
			["malformed", (_plan: SubagentSpawnPlan): unknown => ({ schemaVersion: 1 })],
			["missing", (plan: SubagentSpawnPlan): unknown => receipt(plan)],
			[
				"unsafe",
				(plan: SubagentSpawnPlan): unknown => ({ ...receipt(plan, "cancelled"), sideEffectState: "unknown" }),
			],
		] as const) {
			const value = fixture();
			const input = await planInput(value);
			const plan = await makeRunning(value, input);
			const rejected = await value.supervisor.settleReceipt("child-1", makeReceipt(plan));
			expect(rejected.ok, caseName).toBe(false);
			expect(value.supervisor.get("child-1")?.status, caseName).toBe("lost");
			expect(await value.supervisor.settleReceipt("child-1", receipt(plan))).toMatchObject({
				ok: false,
				error: { code: "subagent_conflict" },
			});
			expect(value.supervisor.get("child-1")?.status).toBe("lost");
		}
	});

	it("marks a caller-tampered receipt lost when it differs from the immutable Host-settled fact", async () => {
		const value = fixture();
		const input = await planInput(value);
		const plan = await makeRunning(value, input);
		const durable = await persistReceipt(value, plan);
		const tampered = {
			...durable,
			agentInstanceId: "foreign-child",
			provenance: {
				...durable.provenance,
				correlation: { ...durable.provenance.correlation!, agentInstanceId: "foreign-child" },
			},
		};
		expect(await value.supervisor.settleReceipt("child-1", tampered)).toMatchObject({
			ok: false,
			error: { code: "subagent_conflict" },
		});
		expect(value.supervisor.get("child-1")?.status).toBe("lost");
	});

	it("rejects a receipt fact with tampered durable binding-epoch correlation", async () => {
		const value = fixture();
		const plan = await makeRunning(value, await planInput(value));
		const candidate = receipt(plan);
		await value.ledgerForLane(plan.childLaneId).appendFact("attempt_receipt", candidate.attemptReceiptId, candidate, {
			clientRequestId: "tampered-receipt-metadata",
			expectedRevision: 0,
			correlation: {
				taskId: candidate.taskId,
				dispatchId: candidate.dispatchId,
				attemptId: candidate.attemptId,
				bindingId: candidate.bindingId,
				bindingEpochId: "epoch-forged",
				attemptReceiptId: candidate.attemptReceiptId,
				agentInstanceId: candidate.agentInstanceId,
			},
		});
		expect(await value.supervisor.settleReceipt("child-1", candidate)).toMatchObject({
			ok: false,
			error: { code: "subagent_conflict" },
		});
		expect(value.supervisor.get("child-1")?.status).toBe("lost");
	});

	it("persists confirmed cancellation/deadline and propagates lifecycle persistence failures", async () => {
		const value = fixture();
		const input = await planInput(value);
		const deadlinePlan = await makeRunning(value, input);
		expect(await value.supervisor.cancel("child-1", provider())).toMatchObject({
			ok: true,
			value: { status: "cancelling" },
		});
		const cancelledReceipt = await persistReceipt(value, deadlinePlan, "cancelled");
		expect(await value.supervisor.settleReceipt("child-1", cancelledReceipt)).toMatchObject({
			ok: true,
			value: { status: "cancelled" },
		});
		const deadline = fixture();
		const deadlineInput = await planInput(deadline, { parentDeadlineAt: NOW });
		const deadlinePlanned = await deadline.supervisor.planSpawn(deadlineInput);
		expect(deadlinePlanned).toMatchObject({ ok: true, value: { dispatch: { deadlineAt: NOW }, deadlineAt: NOW } });

		const failing = fixture();
		const failingInput = await planInput(failing);
		const planned = await failing.supervisor.planSpawn(failingInput);
		if (!planned.ok) throw planned.error;
		failing.misdirectChildWrites();
		const settlement = new LayeredResultSettlement(failing.session, {
			writer: new SessionLedgerWriter(failing.session, {
				ownerId: "supervisor-writer",
				lane: planned.value.childLaneId,
			}),
		});
		const result = await failing.supervisor.executeSpawn(
			planned.value,
			provider({ spawn: async () => Result.err(new FoundationError("subagent_provider_unavailable", "spawn failed")) }),
			settlement,
		);
		expect(result).toMatchObject({ ok: false, error: { code: "subagent_persistence_failed" } });
		expect(failing.supervisor.get("child-1")?.status).toBe("spawning");
	});
});
