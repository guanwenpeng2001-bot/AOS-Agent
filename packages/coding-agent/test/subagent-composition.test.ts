import {
	type AgentHarness,
	createAgentInstance,
	createModelProfileRevision,
	createRoleRevision,
	createTaskEnvelopeV1,
	fingerprintFoundationValue,
	FoundationError,
	InMemoryArtifactBlobStore,
	InMemorySessionStorage,
	resolveAgentBinding,
	Result,
	Session,
	SessionLedgerV1,
	SessionLedgerWriter,
	SessionT5Ledger,
	createScopedMemoryStore,
	type AgentBindingV1,
	type AgentInstanceV1,
	type ArtifactStoreProvider,
	type ChildSpawnRequestV1,
	type ModelProfileV1,
	type QuotaProvider,
	type RevisionReferenceV1,
	type RoleRevisionV1,
	type ScopedModelGateway,
	type TaskEnvelopeV1,
	type ToolGateway,
} from "@aos-agent/agent-core";
import { NodeExecutionEnv } from "@aos-agent/agent-core/node";
import { createModels } from "@aos-agent/ai";
import { getModel } from "@aos-agent/ai/compat";
import { googleProvider } from "@aos-agent/ai/providers/google";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	createTrustedSubagentCompositionV1,
	TrustedSubagentCompositionV1,
	type TrustedSubagentCompositionOptionsV1,
} from "../src/core/subagent-composition.ts";
import { createCodingAgentHarness } from "../src/server/create-harness.ts";
import type { SubagentProviderDescriptorV1 } from "../src/core/subagent-registry.ts";
import type { PlanSubagentSpawnInputV1 } from "../src/core/subagent-supervisor.ts";
import type {
	ChildWorktreeIdentityV1,
	OwnedWorktreeStateV1,
	WorktreeAdapter,
} from "../src/core/subagent-worktree.ts";

const NOW = "2026-01-01T00:00:00.000Z";

function compositionAuthorities(session: Session) {
	const memoryLedger = new SessionT5Ledger(session, {
		ownerId: "composition-parent-memory-writer",
		memoryScopeId: "composition-parent-memory",
		memoryOwnerId: "parent-agent",
		artifactBlobStore: new InMemoryArtifactBlobStore(),
	});
	const parentMemory = createScopedMemoryStore(
		memoryLedger.memory,
		"session",
		{ ownerId: "parent-agent", scopeId: "composition-parent-memory", createdBy: "system" },
		{ ownerId: "parent-agent", scopeId: "composition-parent-memory" },
	);
	return {
		loadParentContext: async () => Result.err(new FoundationError("subagent_context_fork_invalid", "no parent context")),
		parentMemory: { store: parentMemory, parentAgentInstanceId: "parent-agent" } as const,
	};
}

function task(taskId: string): TaskEnvelopeV1 {
	const created = createTaskEnvelopeV1({
		schemaVersion: 1,
		taskId,
		goalId: "goal-1",
		goal: `run ${taskId}`,
		workspace: "workspace-1",
		capabilityRefs: [],
		inputs: [],
		expectedOutputs: [],
		budget: { tokens: 1_000, concurrency: 2 },
		acceptanceCriteria: [],
		status: "ready",
		createdAt: NOW,
		updatedAt: NOW,
	});
	if (!created.ok) throw created.error;
	return created.value;
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
		budget: { tokens: 1_000, concurrency: 2 },
		revision: 1,
		createdAt: NOW,
	});
}

function immutableFact(type: string, id: string): RevisionReferenceV1 {
	const value = { schemaVersion: 1 as const, type, id, revision: 1 };
	return { ...value, fingerprint: fingerprintFoundationValue(value) };
}

function binding(taskEnvelope: TaskEnvelopeV1, roleRevision: RoleRevisionV1, modelProfile: ModelProfileV1): AgentBindingV1 {
	const resolved = resolveAgentBinding({
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
	if (!resolved.ok) throw resolved.error;
	return resolved.value;
}

function rootAgent(roleRevision: RoleRevisionV1): AgentInstanceV1 {
	const created = createAgentInstance({
		agentInstanceId: "parent-agent",
		providerId: "parent-provider",
		providerDeclaredAgent: true,
		roleRevision,
		taskId: "parent-task",
		now: () => NOW,
	});
	if (!created.ok) throw created.error;
	return created.value;
}

const descriptor: SubagentProviderDescriptorV1 = {
	schemaVersion: 1,
	providerKind: "in_process",
	descriptor: { schemaVersion: 1, providerId: "native.in_process", providerClass: "agent" },
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

class ReceiptHidingLedger extends SessionLedgerV1 {
	override async get(objectType: string, objectId: string) {
		if (objectType === "attempt_receipt") return undefined;
		return super.get(objectType, objectId);
	}
}

class FakeHostWorktreeAdapter implements WorktreeAdapter {
	readonly calls: string[] = [];
	readonly workspaces = new Map<string, string>();
	private readonly states = new Map<string, OwnedWorktreeStateV1>();
	applyStatus: "applied" | "conflict" | "unknown" = "applied";

	private key(identity: ChildWorktreeIdentityV1): string {
		return `${identity.childAgentInstanceId}:${identity.attemptId}`;
	}

	async createWorktree(identity: ChildWorktreeIdentityV1, baseRef: string) {
		const key = this.key(identity);
		this.calls.push(`create:${key}`);
		this.workspaces.set(key, `C:\\ephemeral\\${key}`);
		this.states.set(key, {
			schemaVersion: 1,
			childAgentInstanceId: identity.childAgentInstanceId,
			attemptId: identity.attemptId,
			state: "present",
			baseRef,
			baseDigest: `sha256:${"a".repeat(64)}`,
			targetDigest: `sha256:${"b".repeat(64)}`,
			currentDigest: `sha256:${"c".repeat(64)}`,
		});
		return Result.ok(undefined);
	}

	async resolveOwnedWorktree(identity: ChildWorktreeIdentityV1) {
		return Result.ok(this.states.get(this.key(identity)) ?? {
			schemaVersion: 1 as const,
			childAgentInstanceId: identity.childAgentInstanceId,
			attemptId: identity.attemptId,
			state: "missing" as const,
		});
	}

	async resolveExecutionWorkspace(identity: ChildWorktreeIdentityV1) {
		const workspace = this.workspaces.get(this.key(identity));
		return workspace === undefined
			? Result.err(new FoundationError("subagent_worktree_conflict", "missing execution workspace"))
			: Result.ok(workspace);
	}

	async applyWorktree(identity: ChildWorktreeIdentityV1) {
		this.calls.push(`apply:${this.key(identity)}:${this.applyStatus}`);
		return Result.ok({ status: this.applyStatus });
	}

	async deleteWorktree(identity: ChildWorktreeIdentityV1) {
		const key = this.key(identity);
		this.calls.push(`delete:${key}`);
		this.states.set(key, {
			schemaVersion: 1,
			childAgentInstanceId: identity.childAgentInstanceId,
			attemptId: identity.attemptId,
			state: "missing",
		});
		return Result.ok(undefined);
	}

	async quarantineWorktree(identity: ChildWorktreeIdentityV1) {
		const key = this.key(identity);
		this.calls.push(`quarantine:${key}`);
		this.states.set(key, {
			schemaVersion: 1,
			childAgentInstanceId: identity.childAgentInstanceId,
			attemptId: identity.attemptId,
			state: "quarantined",
		});
		return Result.ok(undefined);
	}
}

async function planInput(
	ledger: SessionLedgerV1,
	roleRevision: RoleRevisionV1,
	modelProfile: ModelProfileV1,
	suffix = "",
	providerDescriptor: SubagentProviderDescriptorV1 = descriptor,
	forkScope: "none" | "task_package" = "none",
): Promise<PlanSubagentSpawnInputV1> {
	const id = (value: string): string => suffix.length === 0 ? value : `${value}-${suffix}`;
	const parent = rootAgent(roleRevision);
	const childTask = task("child-task");
	const childBinding = binding(childTask, roleRevision, modelProfile);
	const seed = async (objectType: string, objectId: string, payload: object, correlation: Record<string, string> = {}): Promise<void> => {
		if (await ledger.get(objectType, objectId) !== undefined) return;
		await ledger.appendFact(objectType, objectId, payload, {
			clientRequestId: `seed:${objectType}:${objectId}`,
			expectedRevision: 0,
			correlation: { taskId: childTask.taskId, bindingId: childBinding.bindingId, ...correlation },
		});
	};
	await seed("task", childTask.taskId, childTask);
	await seed("role_revision", childBinding.roleRevision.id, roleRevision);
	await seed("model_profile_revision", childBinding.modelProfileRevision.id, modelProfile);
	for (const [objectType, reference] of [
		["external_agent_binding", childBinding.contextRevision],
		["capability_binding", childBinding.capabilityRevision],
		["model_broker_binding", childBinding.modelBrokerBindingRevision],
		["policy_binding", childBinding.policyRevision],
	] as const) {
		await seed(objectType, reference.id, { schemaVersion: 1, type: reference.type, id: reference.id, revision: reference.revision });
	}
	await seed("agent_binding", childBinding.bindingId, childBinding);
	await seed("agent_instance", parent.agentInstanceId, parent, { taskId: parent.taskId, agentInstanceId: parent.agentInstanceId });
	await seed("task", parent.taskId, task(parent.taskId));
	await seed("attempt", "parent-attempt", {
		schemaVersion: 1,
		attemptId: "parent-attempt",
		dispatchId: "dispatch-parent-attempt",
		taskId: parent.taskId,
		providerId: parent.providerId,
		agentInstanceId: parent.agentInstanceId,
		bindingId: "binding-parent-task",
		bindingEpochIds: ["epoch-parent-attempt"],
		status: "running",
		startedAt: NOW,
	}, {
		taskId: parent.taskId,
		dispatchId: "dispatch-parent-attempt",
		attemptId: "parent-attempt",
		bindingId: "binding-parent-task",
		bindingEpochId: "epoch-parent-attempt",
		agentInstanceId: parent.agentInstanceId,
	});
	const request: ChildSpawnRequestV1 = {
		schemaVersion: 1,
		spawnId: id("spawn-child"),
		parentSpawn: {
			schemaVersion: 1,
			type: "agent.spawn",
			spawnId: id("parent-spawn-child"),
			parentTaskId: parent.taskId,
			newTaskEnvelopeRef: { schemaVersion: 1, type: "task_envelope", id: childTask.taskId, revision: 1 },
			providerId: providerDescriptor.descriptor.providerId,
			createdAt: NOW,
		},
		taskEnvelope: childTask,
		roleRevision,
		modelProfile,
		parentAttemptId: "parent-attempt",
		parentAgentInstanceId: parent.agentInstanceId,
		forkScope,
		...(forkScope === "task_package" ? { taskPackageRef: childTask.taskId } : {}),
	};
	await seed("context", id("context_parent-spawn-child"), {
		schemaVersion: 1,
		contextId: id("context_parent-spawn-child"),
		taskId: parent.taskId,
		spawnId: id("parent-spawn-child"),
		forkScope: "none",
		lineage: { schemaVersion: 1, entityType: "context", entityId: id("context_parent-spawn-child"), depth: 0 },
		createdAt: NOW,
	});
	return {
		schemaVersion: 1,
		request,
		originParentAgentInstance: parent,
		originParentAttemptId: "parent-attempt",
		lineageParentAgentInstance: parent,
		childLaneId: id("child-lane"),
		childBinding,
		providerDescriptor,
		childAgentInstanceId: id("child-faux"),
		dispatchId: id("child-dispatch"),
		attemptId: id("child-attempt"),
		bindingEpochId: id("child-epoch"),
		activatedByCommandId: id("child-command"),
		queue: { mode: "fail" },
	};
}

async function correctionHarness(options: {
	readonly failDispatch?: boolean;
	readonly hideAttemptReceipt?: boolean;
	readonly worktreeAdapter?: FakeHostWorktreeAdapter;
	readonly productionPath?: boolean;
	readonly failedChildren?: readonly string[];
} = {}) {
	const session = new Session(new InMemorySessionStorage({ id: "session-composition", createdAt: 1 }));
	const ledgers = new Map<string, SessionLedgerV1>();
	const ledgerForLane = (laneId: string): SessionLedgerV1 => {
		let ledger = ledgers.get(laneId);
		if (ledger === undefined) {
			ledger = laneId === "parent-lane" && options.hideAttemptReceipt === true
				? new ReceiptHidingLedger(session, { ownerId: "composition-correction-writer", laneId })
				: new SessionLedgerV1(session, { ownerId: "composition-correction-writer", laneId });
			ledgers.set(laneId, ledger);
		}
		return ledger;
	};
	const quota: QuotaProvider = {
		schemaVersion: 1,
		providerId: "faux",
		providerClass: "quota",
		capabilities: async () => [],
		reserve: async (attribution, budget) => Result.ok({
			schemaVersion: 1,
			reservationId: "reservation-correction",
			attribution,
			budget,
			grantedAt: NOW,
		}),
		settle: async (_reservation, usage) => Result.ok(usage),
		dispose: async () => {},
	};
	const modelGateway = {
		schemaVersion: 1 as const,
		providerId: "faux-model-gateway",
		providerClass: "gateway" as const,
		capabilities: async () => [],
		stream: async () => Result.err(new Error("not used")),
		dispose: async () => {},
	} as unknown as ScopedModelGateway;
	const toolGateway = {
		schemaVersion: 1 as const,
		providerId: "faux-tool-gateway",
		providerClass: "gateway" as const,
		capabilities: async () => [],
		execute: async () => Result.err(new Error("not used")),
		dispose: async () => {},
	} as unknown as ToolGateway;
	const artifactStore = {
		schemaVersion: 1 as const,
		providerId: "faux-artifact-store",
		providerClass: "store" as const,
		capabilities: async () => [],
		put: async () => Result.err(new Error("not used")),
		get: async () => Result.err(new Error("not used")),
		verify: async () => Result.ok({ schemaVersion: 1 as const, digestValid: true }),
		delete: async () => Result.ok(undefined),
		dispose: async () => {},
	} as unknown as ArtifactStoreProvider;
	const harnessWorkspaces: Array<string | undefined> = [];
	const compositionOptions: TrustedSubagentCompositionOptionsV1 = {
		schemaVersion: 1,
		enabled: true,
		session,
		ledger: ledgerForLane("parent-lane"),
		ledgerForLane,
		writer: new SessionLedgerWriter(session, {
			ownerId: "composition-correction-writer",
			lane: "parent-lane",
		}),
		sessionId: "session-composition",
		parentLaneId: "parent-lane",
		quota,
		modelGateway,
		toolGateway,
		artifactStore,
		...compositionAuthorities(session),
		createHarness: async (input) => {
			harnessWorkspaces.push(input.executionWorkspace);
			if (options.worktreeAdapter !== undefined) {
				options.worktreeAdapter.calls.push(`harness:${input.agentInstance.agentInstanceId}:${input.epoch.attemptId}`);
			}
			if (options.failDispatch === true) throw new FoundationError("subagent_lost", "dispatch-failure-sentinel");
			const failChild = options.failedChildren?.includes(input.agentInstance.agentInstanceId) === true;
			return {
				promptOnLane: async () => failChild
					? Result.ok({
							runId: `child-run-${input.agentInstance.agentInstanceId}`,
							kind: "failed" as const,
							error: { code: "child_failed", message: "planned child failure" },
						})
					: Result.ok({
							runId: `child-run-${input.agentInstance.agentInstanceId}`,
							kind: "completed" as const,
							leafId: "child-leaf",
							finalEntryId: "child-entry",
							finalMessage: { role: "assistant" as const, content: [{ type: "text" as const, text: "done" }] },
						}),
				resumeOnLane: async () => Result.err({ message: "not used" }),
				createLane: async () => Result.ok({ name: "child-lane" }),
				abort: async () => Result.ok({ runId: "child-run", steer: [], followUp: [] }),
				close: async () => undefined,
			} as unknown as AgentHarness;
		},
		...(options.worktreeAdapter === undefined ? {} : {
			worktree: {
				schemaVersion: 1 as const,
				enabled: true as const,
				baseRef: "refs/heads/main",
				adapter: options.worktreeAdapter,
			},
		}),
		fork: { executable: process.execPath, entrypoint: fileURLToPath(new URL("../src/child-agent-entry.ts", import.meta.url)) },
		parentEndpoints: [
			{ schemaVersion: 1, sessionId: "session-composition", laneId: "child-lane", agentInstanceId: "child-faux", taskId: "child-task", attemptId: "child-attempt" },
			{ schemaVersion: 1, sessionId: "session-composition", laneId: "parent-lane", agentInstanceId: "parent-agent", taskId: "parent-task", attemptId: "parent-attempt" },
		],
		limits: { maxDepth: 4, maxConcurrent: 2, maxTurns: 4, queueCapacity: 2, maximumQueueWaitMs: 100 },
		now: () => NOW,
	};
	let productionHarness: AgentHarness | undefined;
	let productionEnv: NodeExecutionEnv | undefined;
	let composition: TrustedSubagentCompositionV1;
	if (options.productionPath === true) {
		const models = createModels();
		models.setProvider(googleProvider());
		productionEnv = new NodeExecutionEnv({ cwd: process.cwd() });
		const created = await createCodingAgentHarness({
			session,
			models,
			model: getModel("google", "gemini-2.5-flash"),
			env: productionEnv,
			subagents: compositionOptions,
		});
		if (!("subagentComposition" in created) || created.subagentComposition === undefined) throw new Error("Expected production Subagent composition");
		productionHarness = created.harness;
		composition = created.subagentComposition;
	} else {
		composition = new TrustedSubagentCompositionV1(compositionOptions);
	}
	const inProcessDescriptor = composition.providerDescriptors().find((candidate) => candidate.providerKind === "in_process");
	if (inProcessDescriptor === undefined) throw new Error("Expected in-process provider descriptor");
	const planned = await composition.planSpawn(await planInput(ledgerForLane("parent-lane"), role(), profile(), "", inProcessDescriptor));
	if (!planned.ok) throw planned.error;
	return {
		session,
		composition,
		plan: planned.value,
		harnessWorkspaces,
		ledgerForLane,
		async close() {
			await composition.dispose();
			await productionHarness?.close();
			await productionEnv?.cleanup();
		},
		async planFor(suffix: string, forkScope: "none" | "task_package" = "none") {
			const next = await composition.planSpawn(await planInput(ledgerForLane("parent-lane"), role(), profile(), suffix, inProcessDescriptor, forkScope));
			if (!next.ok) throw next.error;
			return next.value;
		},
		async statuses(): Promise<unknown[]> {
			const facts = await ledgerForLane("child-lane").find({
				kind: "fact",
				objectType: "subagent.lifecycle_transitioned",
				order: "oldestFirst",
			});
			return facts.map((fact) => fact.kind === "fact" && typeof fact.payload === "object" && fact.payload !== null
				? (fact.payload as { status?: unknown }).status
				: undefined);
		},
	};
}

describe("trusted Subagent product composition", () => {
	it("runs a production chain with ephemeral worktrees, Host settlement, and result_ref delivery", async () => {
		const adapter = new FakeHostWorktreeAdapter();
		const fixture = await correctionHarness({ worktreeAdapter: adapter, productionPath: true });
		expect(fixture.composition.providerDescriptors().map((entry) => entry.capabilities.worktreeSupported)).toEqual([true, false]);
		let chainedProjectionTrust: string | undefined;
		const result = await fixture.composition.executeComposition({
			schemaVersion: 1,
			runId: "run-production-chain",
			mode: "chain",
			steps: [
				{ input: "root", plan: fixture.plan },
				{
					input: "safe_projection",
					createPlan: async (projection) => {
						chainedProjectionTrust = projection.trust;
						return fixture.planFor("second");
					},
				},
			],
			join: { type: "all_succeed" },
			taskResultId: "task-result-production-chain",
			task: task("child-task"),
			summary: "production chain completed",
			tests: [],
			evidence: [],
		});
		if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
		expect(result).toMatchObject({
			ok: true,
			value: {
				executions: [{ receipt: { receipt: { status: "succeeded" } } }, { receipt: { receipt: { status: "succeeded" } } }],
				projections: [{ trust: "untrusted_child_output" }, { trust: "untrusted_child_output" }],
				taskResult: { status: "succeeded", sourceAttemptReceiptIds: ["attempt-receipt:child-attempt", "attempt-receipt:child-attempt-second"] },
			},
		});
		expect(chainedProjectionTrust).toBe("untrusted_child_output");
		expect(fixture.harnessWorkspaces).toEqual([
			"C:\\ephemeral\\child-faux:child-attempt",
			"C:\\ephemeral\\child-faux-second:child-attempt-second",
		]);
		expect(adapter.calls).toEqual([
			"create:child-faux:child-attempt",
			"harness:child-faux:child-attempt",
			"apply:child-faux:child-attempt:applied",
			"create:child-faux-second:child-attempt-second",
			"harness:child-faux-second:child-attempt-second",
			"apply:child-faux-second:child-attempt-second:applied",
			"delete:child-faux:child-attempt",
			"delete:child-faux-second:child-attempt-second",
		]);
		const durable = await fixture.session.findFoundationRecords({ order: "oldestFirst" });
		expect(JSON.stringify(durable)).not.toContain("C:\\\\ephemeral");
		const taskResult = await fixture.ledgerForLane("parent-lane").get("task_result", "task-result-production-chain");
		expect(taskResult).toMatchObject({ kind: "fact", lane: "parent-lane" });
		const childReceipts = await Promise.all([
			fixture.ledgerForLane("child-lane").get("attempt_receipt", "attempt-receipt:child-attempt"),
			fixture.ledgerForLane("child-lane-second").get("attempt_receipt", "attempt-receipt:child-attempt-second"),
		]);
		expect(childReceipts).toEqual([
			expect.objectContaining({ kind: "fact", lane: "child-lane" }),
			expect.objectContaining({ kind: "fact", lane: "child-lane-second" }),
		]);
		const parentTurn = await fixture.composition.consumeParentNextTurnForRun("run-production-chain");
		expect(parentTurn).toMatchObject({ ok: true, value: { entries: [
			{ trust: "untrusted_child_output", childAgentInstanceId: "child-faux" },
			{ trust: "untrusted_child_output", childAgentInstanceId: "child-faux-second" },
		] } });
		await fixture.close();
	});

	it("runs a production task_package chain and rejects an unbounded later root plan", async () => {
		const fixture = await correctionHarness({ productionPath: true });
		const taskPackagePlan = await fixture.planFor("task-package", "task_package");
		const accepted = await fixture.composition.executeComposition({
			schemaVersion: 1,
			runId: "run-task-package-chain",
			mode: "chain",
			steps: [{ input: "root", plan: fixture.plan }, { input: "task_package", plan: taskPackagePlan }],
			join: { type: "all_succeed" },
			taskResultId: "task-result-task-package-chain",
			task: task("child-task"),
			summary: "task package chain completed",
			tests: [],
			evidence: [],
		});
		expect(accepted).toMatchObject({ ok: true, value: { executions: [{}, {}], taskResult: { status: "succeeded" } } });
		await fixture.close();

		const rejectedFixture = await correctionHarness({ productionPath: true });
		const unboundedPlan = await rejectedFixture.planFor("unbounded");
		const rejected = await rejectedFixture.composition.executeComposition({
			schemaVersion: 1,
			runId: "run-unbounded-chain",
			mode: "chain",
			steps: [{ input: "root", plan: rejectedFixture.plan }, { input: "root", plan: unboundedPlan }],
			join: { type: "all_succeed" },
			taskResultId: "task-result-unbounded-chain",
			task: task("child-task"),
			summary: "must reject",
			tests: [],
			evidence: [],
		});
		expect(rejected).toMatchObject({ ok: false, error: { code: "subagent_spawn_invalid" } });
		const unboundedReceipts = await rejectedFixture.session.findFoundationRecords({
			kind: "fact",
			objectType: "attempt_receipt",
			order: "oldestFirst",
		});
		expect(unboundedReceipts).toHaveLength(1);
		await rejectedFixture.close();
	});

	it.each([
		["all_succeed", { type: "all_succeed" } as const, [] as const, true],
		["quorum", { type: "quorum", minimumSucceeded: 1 } as const, ["child-faux-second"] as const, true],
		["partial", { type: "partial" } as const, ["child-faux-second"] as const, true],
		["all_succeed failure", { type: "all_succeed" } as const, ["child-faux-second"] as const, false],
	])("runs parallel Host join policy %s", async (_name, join, failedChildren, expectedOk) => {
		const fixture = await correctionHarness({ failedChildren });
		const second = await fixture.planFor("second");
		const result = await fixture.composition.executeComposition({
			schemaVersion: 1,
			runId: `run-parallel-${_name.replaceAll(" ", "-")}`,
			mode: "parallel",
			steps: [{ input: "root", plan: fixture.plan }, { input: "root", plan: second }],
			join,
			taskResultId: `task-result-parallel-${_name.replaceAll(" ", "-")}`,
			task: task("child-task"),
			summary: "parallel composition",
			tests: [],
			evidence: [],
		});
		if (!result.ok && expectedOk) throw new Error(`${result.error.code}: ${result.error.message}`);
		expect(result.ok).toBe(expectedOk);
		if (result.ok) {
			expect(result.value.executions).toHaveLength(2);
			expect(result.value.taskResult.status).toBe("succeeded");
			expect(new Set(result.value.taskResult.sourceAttemptReceiptIds).size).toBe(result.value.taskResult.sourceAttemptReceiptIds.length);
		}
		await fixture.close();
	});

	it("interrupts a production chain after a failed Child receipt", async () => {
		const fixture = await correctionHarness({ productionPath: true, failedChildren: ["child-faux"] });
		let nextCreated = false;
		const result = await fixture.composition.executeComposition({
			schemaVersion: 1,
			runId: "run-chain-failure",
			mode: "chain",
			steps: [
				{ input: "root", plan: fixture.plan },
				{
					input: "safe_projection",
					createPlan: async () => {
						nextCreated = true;
						return fixture.planFor("must-not-run");
					},
				},
			],
			join: { type: "all_succeed" },
			taskResultId: "task-result-chain-failure",
			task: task("child-task"),
			summary: "must fail",
			tests: [],
			evidence: [],
		});
		expect(result).toMatchObject({ ok: false, error: { code: "subagent_result_untrusted" } });
		expect(nextCreated).toBe(false);
		await fixture.close();
	});

	it("fails worktree apply conflicts closed and cleans the owned workspace", async () => {
		const adapter = new FakeHostWorktreeAdapter();
		adapter.applyStatus = "conflict";
		const fixture = await correctionHarness({ worktreeAdapter: adapter, productionPath: true });
		const result = await fixture.composition.executePlan({
			schemaVersion: 1,
			runId: "run-worktree-conflict",
			plan: fixture.plan,
		});
		expect(result).toMatchObject({ ok: false, error: { code: "subagent_worktree_conflict" } });
		expect(adapter.calls).toEqual([
			"create:child-faux:child-attempt",
			"harness:child-faux:child-attempt",
			"apply:child-faux:child-attempt:conflict",
			"delete:child-faux:child-attempt",
		]);
		await fixture.close();
	});

	it("fails unknown worktree apply closed and quarantines the workspace", async () => {
		const adapter = new FakeHostWorktreeAdapter();
		adapter.applyStatus = "unknown";
		const fixture = await correctionHarness({ worktreeAdapter: adapter, productionPath: true });
		const result = await fixture.composition.executePlan({
			schemaVersion: 1,
			runId: "run-worktree-unknown",
			plan: fixture.plan,
		});
		expect(result).toMatchObject({ ok: false, error: { code: "subagent_worktree_conflict" } });
		expect(adapter.calls).toContain("quarantine:child-faux:child-attempt");
		await fixture.close();
	});

	it("is default-off and constructs only the fixed in-process/fork registry after explicit Host opt-in", async () => {
		expect(createTrustedSubagentCompositionV1(undefined)).toBeUndefined();
		const session = new Session(new InMemorySessionStorage({ id: "session-composition", createdAt: 1 }));
		const ledgers = new Map<string, SessionLedgerV1>();
		const ledgerForLane = (laneId: string): SessionLedgerV1 => {
			let ledger = ledgers.get(laneId);
			if (ledger === undefined) {
				ledger = new SessionLedgerV1(session, { ownerId: "composition-writer", laneId });
				ledgers.set(laneId, ledger);
			}
			return ledger;
		};
		const passiveProvider: QuotaProvider = {
			schemaVersion: 1 as const,
			providerId: "faux",
			providerClass: "quota" as const,
			capabilities: async () => [],
			reserve: async (attribution, budget) => Result.ok({
				schemaVersion: 1,
				reservationId: "reservation-faux",
				attribution,
				budget,
				grantedAt: NOW,
			}),
			settle: async (_reservation, usage) => Result.ok(usage),
			dispose: async () => {},
		};
		const modelGateway = {
			schemaVersion: 1 as const,
			providerId: "faux-model-gateway",
			providerClass: "gateway" as const,
			capabilities: async () => [],
			stream: async () => Result.err(new Error("not used")),
			dispose: async () => {},
		} as unknown as ScopedModelGateway;
		const toolGateway = {
			schemaVersion: 1 as const,
			providerId: "faux-tool-gateway",
			providerClass: "gateway" as const,
			capabilities: async () => [],
			execute: async () => Result.err(new Error("not used")),
			dispose: async () => {},
		} as unknown as ToolGateway;
		const artifactStore = {
			schemaVersion: 1 as const,
			providerId: "faux-artifact-store",
			providerClass: "store" as const,
			capabilities: async () => [],
			put: async () => Result.err(new Error("not used")),
			get: async () => Result.err(new Error("not used")),
			verify: async () => Result.ok({ schemaVersion: 1 as const, digestValid: true }),
			delete: async () => Result.ok(undefined),
			dispose: async () => {},
		} as unknown as ArtifactStoreProvider;
		const composition = new TrustedSubagentCompositionV1({
			schemaVersion: 1,
			enabled: true,
			session,
			ledger: ledgerForLane("parent-lane"),
			ledgerForLane,
			writer: new SessionLedgerWriter(session, { ownerId: "composition-writer", lane: "parent-lane" }),
			sessionId: "session-composition",
			parentLaneId: "parent-lane",
			quota: passiveProvider,
			modelGateway,
			toolGateway,
			artifactStore,
			...compositionAuthorities(session),
			createHarness: async () => ({
				promptOnLane: async () => Result.ok({
					runId: "child-run",
					kind: "completed" as const,
					leafId: "child-leaf",
					finalEntryId: "child-entry",
					finalMessage: { role: "assistant" as const, content: [{ type: "text" as const, text: "done" }] },
				}),
				resumeOnLane: async () => Result.err({ message: "not used" }),
				createLane: async () => Result.ok({ name: "child-lane" }),
				abort: async () => Result.ok({ runId: "child-run", steer: [], followUp: [] }),
				close: async () => undefined,
			}) as unknown as AgentHarness,
			fork: { executable: process.execPath, entrypoint: fileURLToPath(new URL("../src/child-agent-entry.ts", import.meta.url)) },
			parentEndpoints: [
				{ schemaVersion: 1, sessionId: "session-composition", laneId: "child-lane", agentInstanceId: "child-faux", taskId: "child-task", attemptId: "child-attempt" },
				{ schemaVersion: 1, sessionId: "session-composition", laneId: "parent-lane", agentInstanceId: "parent-agent", taskId: "parent-task", attemptId: "parent-attempt" },
			],
			limits: { maxDepth: 4, maxConcurrent: 2, maxTurns: 4, queueCapacity: 2, maximumQueueWaitMs: 100 },
		});
		const descriptors = composition.providerDescriptors();
		expect(descriptors.map((entry) => [entry.providerKind, entry.descriptor.providerId])).toEqual([
			["in_process", "native.in_process"],
			["fork", "native.fork"],
		]);
		expect(descriptors.map((entry) => entry.capabilities.worktreeSupported)).toEqual([false, false]);
		expect(Object.isFrozen(descriptors)).toBe(true);
		expect("register" in composition).toBe(false);
		expect(await composition.get("foreign-run", "child-1")).toEqual(Result.ok(undefined));
		expect(await composition.list("run-1", { limit: 101 })).toMatchObject({ ok: false });
		const planned = await composition.planSpawn(await planInput(ledgerForLane("parent-lane"), role(), profile()));
		expect(planned.ok).toBe(true);
		if (!planned.ok) throw planned.error;
		const executed = await composition.executePlan({ schemaVersion: 1, runId: "run-faux", plan: planned.value });
		if (!executed.ok) throw executed.error;
		expect(executed).toMatchObject({ ok: true, value: { receipt: { receipt: { status: "succeeded" } } } });
		const sent = await composition.deliverChildMailbox({
			schemaVersion: 1,
			messageId: "message-faux",
			fromAgentInstanceId: "child-faux",
			fromAttemptId: "child-attempt",
			toAgentInstanceId: "parent-agent",
			kind: "notice",
			body: { schemaVersion: 1, text: "child\r\nstatus", items: ["bounded"] },
			correlation: {
				sessionId: "session-composition",
				laneId: "parent-lane",
				taskId: "parent-task",
				attemptId: "parent-attempt",
				agentInstanceId: "parent-agent",
			},
		});
		expect(sent.ok).toBe(true);
		const nextTurn = await composition.consumeParentNextTurnForRun("run-faux");
		expect(nextTurn).toMatchObject({ ok: true, value: { entries: [{ trust: "untrusted_child_output" }] } });
		if (!nextTurn.ok) throw nextTurn.error;
		expect(nextTurn.value.contextText).toContain('trust="untrusted_child_output"');
		expect(nextTurn.value.contextText).not.toContain("\r");
		expect(nextTurn.value.entries[0]).not.toHaveProperty("body");
		await composition.dispose();
	});

	it("converges a spawned Child after parent Run binding conflict and removes RPC ownership", async () => {
		const fixture = await correctionHarness();
		expect(fixture.composition.bindTrustedParentRun({
			schemaVersion: 1,
			sessionId: "session-composition",
			runId: "run-bind-conflict",
			toAgentInstanceId: "different-parent",
			byAttemptId: "different-attempt",
		}).ok).toBe(true);

		const result = await fixture.composition.executePlan({
			schemaVersion: 1,
			runId: "run-bind-conflict",
			plan: fixture.plan,
		});
		expect(result).toMatchObject({
			ok: false,
			error: {
				code: "subagent_conflict",
				message: "A Run cannot consume Child mailbox data for different parent authorities",
			},
		});
		expect((await fixture.statuses()).at(-1)).toBe("cancelling");
		expect(await fixture.composition.get("run-bind-conflict", "child-faux")).toEqual(Result.ok(undefined));
		expect(await fixture.composition.list("run-bind-conflict", { limit: 10 })).toEqual(Result.ok([]));
		await fixture.composition.dispose();
	});

	it("preserves the dispatch error while marking the spawned Child lost and removing RPC ownership", async () => {
		const fixture = await correctionHarness({ failDispatch: true });
		const result = await fixture.composition.executePlan({
			schemaVersion: 1,
			runId: "run-dispatch-failure",
			plan: fixture.plan,
		});
		expect(result).toMatchObject({
			ok: false,
			error: { code: "subagent_lost", message: "dispatch-failure-sentinel" },
		});
		expect((await fixture.statuses()).at(-1)).toBe("lost");
		expect(await fixture.composition.get("run-dispatch-failure", "child-faux")).toEqual(Result.ok(undefined));
		expect(await fixture.composition.list("run-dispatch-failure", { limit: 10 })).toEqual(Result.ok([]));
		await fixture.composition.dispose();
	});

	it("preserves settlement failure while converging the Child and removing RPC ownership", async () => {
		const fixture = await correctionHarness({ hideAttemptReceipt: true });
		const result = await fixture.composition.executePlan({
			schemaVersion: 1,
			runId: "run-settlement-failure",
			plan: fixture.plan,
		});
		expect(result).toMatchObject({
			ok: false,
			error: {
				code: "subagent_conflict",
				message: "Child Agent receipt is missing or differs from its immutable durable fact",
			},
		});
		expect((await fixture.statuses()).at(-1)).toBe("lost");
		expect(await fixture.composition.get("run-settlement-failure", "child-faux")).toEqual(Result.ok(undefined));
		expect(await fixture.composition.list("run-settlement-failure", { limit: 10 })).toEqual(Result.ok([]));
		await fixture.composition.dispose();
	});
});
