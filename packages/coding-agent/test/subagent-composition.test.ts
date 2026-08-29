import {
	type AgentHarness,
	createAgentInstance,
	createBindingEpoch,
	createModelProfileRevision,
	createRoleRevision,
	createTaskEnvelope,
	fingerprintFoundationValue,
	FoundationError,
	InMemoryArtifactBlobStore,
	InMemoryRoleRegistry,
	InMemorySessionStorage,
	isMcpSelectionSubset,
	resolveAgentBinding,
	resolveMcpSelection,
	Result,
	Session,
	SessionLedger,
	SessionLedgerWriter,
	ContextLedger,
	createScopedMemoryStore,
	type AgentBinding,
	type AgentInstance,
	type ArtifactStoreProvider,
	type ChildSpawnRequest,
	type McpSelection,
	type ModelProfile,
	type QuotaProvider,
	type RevisionReference,
	type ResourceSelector,
	type RoleRevision,
	type ScopedModelGateway,
	type TaskEnvelope,
	type TaskExecutorProvider,
	type ToolGateway,
} from "@aos-agent/agent-core";
import { NodeExecutionEnv } from "@aos-agent/agent-core/node";
import { createModels } from "@aos-agent/ai";
import { getModel } from "@aos-agent/ai/compat";
import { googleProvider } from "@aos-agent/ai/providers/google";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	createSubagentComposition,
	SubagentComposition,
	type SubagentCompositionOptions,
} from "../src/core/subagent-composition.ts";
import {
	createMcpInheritanceApprovalAuthority,
	type McpInheritanceApprovalAuthority,
} from "../src/core/subagent-binding.ts";
import {
	resolveExecutionPolicy,
	type ExecutionPolicyProfile,
	type PolicyApprovalRequest,
} from "../src/core/execution-policy.ts";
import {
	createExecutionPolicyLedger,
	type PolicyLedgerSession,
	type PolicyLedgerSessionEntry,
} from "../src/core/execution-policy-ledger.ts";
import { createCodingAgentHarnessFromTrustedProvidersForTest } from "../src/server/create-harness.ts";
import type { SubagentProviderDescriptor } from "../src/core/subagent-registry.ts";
import type { PlanSubagentSpawnInput } from "../src/core/subagent-supervisor.ts";
import type { SchedulerNativeAgentResolveInput } from "../src/core/scheduler-dispatch.ts";
import type {
	ChildWorktreeIdentity,
	OwnedWorktreeState,
	WorktreeAdapter,
} from "../src/core/subagent-worktree.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const APPROVED_AT = "2026-01-01T00:01:00.000Z";

class MemoryPolicySession implements PolicyLedgerSession {
	readonly entries: PolicyLedgerSessionEntry[] = [];

	appendCustomEntry(customType: string, data?: unknown): string {
		const id = `policy-entry-${this.entries.length + 1}`;
		this.entries.push({ id, type: "custom", customType, data });
		return id;
	}

	getEntries(): ReadonlyArray<PolicyLedgerSessionEntry> {
		return this.entries;
	}
}

function mcpInheritanceAuthority(pending: PolicyApprovalRequest[]) {
	const profile: ExecutionPolicyProfile = {
		id: "composition-mcp-inheritance",
		revision: "revision-1",
		enforcement: "host",
		defaultAction: "allow",
		workspace: { read: ["workspace"], write: ["workspace"], deny: [] },
		process: { action: "allow", inheritEnvironment: false, allowEnvironment: [] },
		network: { action: "allow", allowDestinations: [] },
		credentials: { action: "deny", allowNames: [] },
		approvals: { writeOutsideWorkspace: "deny", network: "allow", process: "allow", mcp: "ask" },
	};
	const resolved = resolveExecutionPolicy({
		profiles: { [profile.id]: profile },
		defaultProfile: profile.id,
		bindingId: "policy-1",
		runId: "run-product-mcp-inheritance",
		workspaceIdentity: "workspace-product-mcp-inheritance",
		createdAt: NOW,
	});
	if (!resolved.ok) throw resolved.error;
	const ledger = createExecutionPolicyLedger(new MemoryPolicySession());
	const authority = createMcpInheritanceApprovalAuthority({
		schemaVersion: 1,
		profile: resolved.profile,
		binding: resolved.binding,
		policyRevision: immutableFact("policy_binding", "policy-1"),
		ledger,
		onApprovalRequired: (approval) => pending.push(approval),
	});
	return { authority, ledger };
}

function compositionAuthorities(session: Session) {
	const memoryLedger = new ContextLedger(session, {
		ownerId: "composition-parent-memory-writer",
		memoryScopeId: "composition-parent-memory",
		memoryOwnerId: "parent-agent",
		artifactBlobStore: new InMemoryArtifactBlobStore(),
	});
	const parentMemoryForAgent = (parentAgentInstanceId: string) => ({
		store: createScopedMemoryStore(
			memoryLedger.memory,
			"session",
			{ ownerId: parentAgentInstanceId, scopeId: `composition-parent-memory:${parentAgentInstanceId}`, createdBy: "system" },
			{ ownerId: parentAgentInstanceId, scopeId: `composition-parent-memory:${parentAgentInstanceId}` },
		),
		parentAgentInstanceId,
	});
	return {
		loadParentContext: async () => Result.err(new FoundationError("subagent_context_fork_invalid", "no parent context")),
		parentMemory: parentMemoryForAgent("parent-agent"),
		parentMemoryForAgent,
	};
}

function task(taskId: string): TaskEnvelope {
	const created = createTaskEnvelope({
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

function role(options: { readonly roleId?: string; readonly mcpSelector?: ResourceSelector } = {}): RoleRevision {
	return createRoleRevision({
		definition: {
			schemaVersion: 1,
			roleId: options.roleId ?? "role-child",
			scope: "project",
			slug: "child",
			name: "Child",
			description: "Child role",
			revision: 1,
			persona: "Run the child task.",
			modelProfileRef: { schemaVersion: 1, type: "model_profile", id: "profile-child", revision: 1 },
			capabilitySelector: { policy: "none" },
			skillSelector: { policy: "none" },
			mcpSelector: options.mcpSelector ?? { policy: "none" },
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
		budget: { tokens: 1_000, concurrency: 2 },
		revision: 1,
		createdAt: NOW,
	});
}

function immutableFact(type: string, id: string): RevisionReference {
	const value = { schemaVersion: 1 as const, type, id, revision: 1 };
	return { ...value, fingerprint: fingerprintFoundationValue(value) };
}

function binding(
	taskEnvelope: TaskEnvelope,
	roleRevision: RoleRevision,
	modelProfile: ModelProfile,
	mcpSelection?: McpSelection,
): AgentBinding {
	const resolved = resolveAgentBinding({
		task: taskEnvelope,
		roleRevision,
		modelProfile,
		contextRevision: immutableFact("external_agent_binding", "context-1"),
		capabilityRevision: immutableFact("capability_binding", "capability-1"),
		modelBrokerBindingRevision: immutableFact("model_broker_binding", "broker-1"),
		policyRevision: immutableFact("policy_binding", "policy-1"),
		...(mcpSelection === undefined ? {} : { mcpSelection }),
		newBindingId: `binding-${taskEnvelope.taskId}`,
		now: () => NOW,
	});
	if (!resolved.ok) throw resolved.error;
	return resolved.value;
}

function exactMcpSelection(selector: ResourceSelector): McpSelection {
	const selected = resolveMcpSelection({
		selector,
		capabilityBinding: {
			id: "capability-1",
			descriptors: ["docs", "search"].map((serverId) => ({
				id: `mcp-server-${serverId}`,
				revision: "revision-1",
				kind: "mcp_server",
				name: serverId,
				mcpServerId: serverId,
			})),
			toolAllowlist: [],
		},
		routeCatalog: [],
	});
	if (!selected.ok) throw selected.error;
	return selected.value;
}

function rootAgent(roleRevision: RoleRevision): AgentInstance {
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

const descriptor: SubagentProviderDescriptor = {
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

class ReceiptHidingLedger extends SessionLedger {
	override async get(objectType: string, objectId: string) {
		if (objectType === "attempt_receipt") return undefined;
		return super.get(objectType, objectId);
	}
}

class FakeHostWorktreeAdapter implements WorktreeAdapter {
	readonly calls: string[] = [];
	readonly workspaces = new Map<string, string>();
	private readonly states = new Map<string, OwnedWorktreeState>();
	applyStatus: "applied" | "conflict" | "unknown" = "applied";

	private key(identity: ChildWorktreeIdentity): string {
		return `${identity.childAgentInstanceId}:${identity.attemptId}`;
	}

	async createWorktree(identity: ChildWorktreeIdentity, baseRef: string) {
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

	async resolveOwnedWorktree(identity: ChildWorktreeIdentity) {
		return Result.ok(this.states.get(this.key(identity)) ?? {
			schemaVersion: 1 as const,
			childAgentInstanceId: identity.childAgentInstanceId,
			attemptId: identity.attemptId,
			state: "missing" as const,
		});
	}

	async resolveExecutionWorkspace(identity: ChildWorktreeIdentity) {
		const workspace = this.workspaces.get(this.key(identity));
		return workspace === undefined
			? Result.err(new FoundationError("subagent_worktree_conflict", "missing execution workspace"))
			: Result.ok(workspace);
	}

	async applyWorktree(identity: ChildWorktreeIdentity) {
		this.calls.push(`apply:${this.key(identity)}:${this.applyStatus}`);
		return Result.ok({ status: this.applyStatus });
	}

	async deleteWorktree(identity: ChildWorktreeIdentity) {
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

	async quarantineWorktree(identity: ChildWorktreeIdentity) {
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
	ledger: SessionLedger,
	roleRevision: RoleRevision,
	modelProfile: ModelProfile,
	suffix = "",
	providerDescriptor: SubagentProviderDescriptor = descriptor,
	forkScope: "none" | "task_package" = "none",
	maxTurns?: number,
): Promise<PlanSubagentSpawnInput> {
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
	const request: ChildSpawnRequest = {
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
		childAgentInstanceId: id("child-fake"),
		dispatchId: id("child-dispatch"),
		attemptId: id("child-attempt"),
		bindingEpochId: id("child-epoch"),
		activatedByCommandId: id("child-command"),
		queue: { mode: "fail" },
		...(maxTurns === undefined ? {} : { maxTurns }),
	};
}

async function correctionHarness(options: {
	readonly failDispatch?: boolean;
	readonly hideAttemptReceipt?: boolean;
	readonly worktreeAdapter?: FakeHostWorktreeAdapter;
	readonly productionPath?: boolean;
	readonly failedChildren?: readonly string[];
	readonly suspendThenResume?: boolean;
	readonly planMaxTurns?: number;
	readonly productPrompt?: SubagentCompositionOptions["productPrompt"];
	readonly mcpInheritanceAuthority?: McpInheritanceApprovalAuthority;
} = {}) {
	const session = new Session(new InMemorySessionStorage({ id: "session-composition", createdAt: 1 }));
	const ledgers = new Map<string, SessionLedger>();
	const ledgerForLane = (laneId: string): SessionLedger => {
		let ledger = ledgers.get(laneId);
		if (ledger === undefined) {
			ledger = laneId === "parent-lane" && options.hideAttemptReceipt === true
				? new ReceiptHidingLedger(session, { ownerId: "composition-correction-writer", laneId })
				: new SessionLedger(session, { ownerId: "composition-correction-writer", laneId });
			ledgers.set(laneId, ledger);
		}
		return ledger;
	};
	const quota: QuotaProvider = {
		schemaVersion: 1,
		providerId: "fake",
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
		providerId: "fake-model-gateway",
		providerClass: "gateway" as const,
		capabilities: async () => [],
		stream: async () => Result.err(new Error("not used")),
		dispose: async () => {},
	} as unknown as ScopedModelGateway;
	const toolGateway = {
		schemaVersion: 1 as const,
		providerId: "fake-tool-gateway",
		providerClass: "gateway" as const,
		capabilities: async () => [],
		execute: async () => Result.err(new Error("not used")),
		dispose: async () => {},
	} as unknown as ToolGateway;
	const artifactStore = {
		schemaVersion: 1 as const,
		providerId: "fake-artifact-store",
		providerClass: "store" as const,
		capabilities: async () => [],
		put: async () => Result.err(new Error("not used")),
		get: async () => Result.err(new Error("not used")),
		verify: async () => Result.ok({ schemaVersion: 1 as const, digestValid: true }),
		delete: async () => Result.ok(undefined),
		dispose: async () => {},
	} as unknown as ArtifactStoreProvider;
	const harnessWorkspaces: Array<string | undefined> = [];
	let resumeCalls = 0;
	const compositionOptions: SubagentCompositionOptions = {
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
		...(options.mcpInheritanceAuthority === undefined ? {} : { mcpInheritanceAuthority: options.mcpInheritanceAuthority }),
		...compositionAuthorities(session),
		createHarness: async (input) => {
			harnessWorkspaces.push(input.executionWorkspace);
			if (options.worktreeAdapter !== undefined) {
				options.worktreeAdapter.calls.push(`harness:${input.agentInstance.agentInstanceId}:${input.epoch.attemptId}`);
			}
			if (options.failDispatch === true) throw new FoundationError("subagent_lost", "dispatch-failure-sentinel");
			const failChild = options.failedChildren?.includes(input.agentInstance.agentInstanceId) === true;
			return {
				promptOnLane: async () => options.suspendThenResume === true
					? Result.ok({
							runId: `child-run-${input.agentInstance.agentInstanceId}`,
							kind: "suspended" as const,
						})
					: failChild
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
				resumeOnLane: async () => {
					resumeCalls += 1;
					return options.suspendThenResume === true
						? Result.ok({
								operation: "run" as const,
								runId: `child-run-${input.agentInstance.agentInstanceId}`,
								kind: "completed" as const,
								leafId: "child-leaf-resumed",
								finalEntryId: "child-entry-resumed",
								finalMessage: { role: "assistant" as const, content: [{ type: "text" as const, text: "resumed" }] },
							})
						: Result.err({ message: "not used" });
				},
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
		...(options.productPrompt === undefined ? {} : { productPrompt: options.productPrompt }),
		parentEndpoints: [
			{ schemaVersion: 1, sessionId: "session-composition", laneId: "child-lane", agentInstanceId: "child-fake", taskId: "child-task", attemptId: "child-attempt" },
			{ schemaVersion: 1, sessionId: "session-composition", laneId: "parent-lane", agentInstanceId: "parent-agent", taskId: "parent-task", attemptId: "parent-attempt" },
		],
		limits: { maxDepth: 4, maxConcurrent: 2, maxTurns: 4, queueCapacity: 2, maximumQueueWaitMs: 100 },
		now: () => NOW,
	};
	let productionHarness: AgentHarness | undefined;
	let productionEnv: NodeExecutionEnv | undefined;
	let composition: SubagentComposition;
	if (options.productionPath === true) {
		const models = createModels();
		models.setProvider(googleProvider());
		productionEnv = new NodeExecutionEnv({ cwd: process.cwd() });
		const created = await createCodingAgentHarnessFromTrustedProvidersForTest({
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
		composition = new SubagentComposition(compositionOptions);
	}
	const inProcessDescriptor = composition.providerDescriptors().find((candidate) => candidate.providerKind === "in_process");
	if (inProcessDescriptor === undefined) throw new Error("Expected in-process provider descriptor");
	const planned = await composition.planSpawn(await planInput(
		ledgerForLane("parent-lane"),
		role(),
		profile(),
		"",
		inProcessDescriptor,
		"none",
		options.planMaxTurns,
	));
	if (!planned.ok) throw planned.error;
	return {
		session,
		composition,
		plan: planned.value,
		harnessWorkspaces,
		resumeCalls: () => resumeCalls,
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
			"C:\\ephemeral\\child-fake:child-attempt",
			"C:\\ephemeral\\child-fake-second:child-attempt-second",
		]);
		expect(adapter.calls).toEqual([
			"create:child-fake:child-attempt",
			"harness:child-fake:child-attempt",
			"apply:child-fake:child-attempt:applied",
			"create:child-fake-second:child-attempt-second",
			"harness:child-fake-second:child-attempt-second",
			"apply:child-fake-second:child-attempt-second:applied",
			"delete:child-fake:child-attempt",
			"delete:child-fake-second:child-attempt-second",
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
			{ trust: "untrusted_child_output", childAgentInstanceId: "child-fake" },
			{ trust: "untrusted_child_output", childAgentInstanceId: "child-fake-second" },
		] } });
		await fixture.close();
	});

	it("projects a nonempty parent MCP selection before production Role resolution and replays trusted approval", async () => {
		const pendingApprovals: PolicyApprovalRequest[] = [];
		const approval = mcpInheritanceAuthority(pendingApprovals);
		const registry = new InMemoryRoleRegistry({ now: () => NOW });
		const registered = registry.create({ definition: {
			schemaVersion: 1,
			roleId: "mcp-reviewer",
			scope: "project",
			slug: "mcp-reviewer",
			name: "MCP reviewer",
			description: "Review with the exact docs MCP subset",
			revision: 0,
			persona: "Review the child task.",
			modelProfileRef: { schemaVersion: 1, type: "model_profile", id: "profile-child", revision: 1 },
			capabilitySelector: { policy: "none" },
			skillSelector: { policy: "none" },
			mcpSelector: { policy: "named", named: ["docs"] },
		} });
		if (!registered.ok) throw registered.error;
		const fixture = await correctionHarness({
			productionPath: true,
			mcpInheritanceAuthority: approval.authority,
			productPrompt: {
				registry,
				scope: "project",
				providerId: "native.in_process",
				forkScope: "none",
				mailboxRequired: true,
				resumeRequired: false,
				worktreeRequired: false,
				backgroundRequired: false,
			},
		});
		try {
			const parentTask = task("product-mcp-parent-task");
			const parentRole = role({ roleId: "role-product-mcp-parent", mcpSelector: { policy: "all" } });
			const parentProfile = profile();
			const parentSelection = exactMcpSelection(parentRole.mcpSelector);
			const parentBinding = binding(parentTask, parentRole, parentProfile, parentSelection);
			const parentEpoch = createBindingEpoch({
				bindingEpochId: "product-mcp-parent-epoch",
				taskId: parentTask.taskId,
				attemptId: "product-mcp-parent-attempt",
				bindingId: parentBinding.bindingId,
				agentInstanceId: "product-mcp-parent-agent",
				activationReason: "attempt_started",
				activatedByCommandId: "product-mcp-parent-dispatch",
				now: () => NOW,
			});
			if (!parentEpoch.ok) throw parentEpoch.error;
			const createdParent = createAgentInstance({
				agentInstanceId: "product-mcp-parent-agent",
				providerId: "parent-provider",
				providerDeclaredAgent: true,
				roleRevision: parentRole,
				taskId: parentTask.taskId,
				now: () => NOW,
			});
			if (!createdParent.ok) throw createdParent.error;
			const parentAgent = { ...createdParent.value, bindingEpochIds: [parentEpoch.value.bindingEpochId] };
			const parentDispatch = {
				schemaVersion: 1 as const,
				dispatchId: "product-mcp-parent-dispatch",
				taskId: parentTask.taskId,
				bindingId: parentBinding.bindingId,
				taskExecutorProviderId: "parent-provider",
				status: "pending" as const,
				createdAt: NOW,
			};
			const ledger = fixture.ledgerForLane("parent-lane");
			const seed = async (objectType: string, objectId: string, payload: object): Promise<void> => {
				if (await ledger.get(objectType, objectId) !== undefined) return;
				await ledger.appendFact(objectType, objectId, payload, {
					clientRequestId: `product-mcp-parent:${objectType}:${objectId}`,
					expectedRevision: 0,
					correlation: {
						taskId: parentTask.taskId,
						dispatchId: parentDispatch.dispatchId,
						attemptId: parentEpoch.value.attemptId,
						bindingId: parentBinding.bindingId,
						bindingEpochId: parentEpoch.value.bindingEpochId,
						agentInstanceId: parentAgent.agentInstanceId,
					},
				});
			};
			await seed("task", parentTask.taskId, parentTask);
			await seed("role_revision", parentRole.roleRevisionId, parentRole);
			await seed("model_profile_revision", parentProfile.modelProfileId, parentProfile);
			for (const [objectType, reference] of [
				["external_agent_binding", parentBinding.contextRevision],
				["capability_binding", parentBinding.capabilityRevision],
				["model_broker_binding", parentBinding.modelBrokerBindingRevision],
				["policy_binding", parentBinding.policyRevision],
			] as const) {
				await seed(objectType, reference.id, reference);
			}
			await seed("agent_binding", parentBinding.bindingId, parentBinding);
			await seed("agent_instance", parentAgent.agentInstanceId, parentAgent);
			await seed("binding_epoch", parentEpoch.value.bindingEpochId, parentEpoch.value);
			await seed("dispatch", parentDispatch.dispatchId, parentDispatch);
			await seed("attempt", parentEpoch.value.attemptId, {
				schemaVersion: 1,
				attemptId: parentEpoch.value.attemptId,
				dispatchId: parentDispatch.dispatchId,
				taskId: parentTask.taskId,
				providerId: "parent-provider",
				agentInstanceId: parentAgent.agentInstanceId,
				bindingId: parentBinding.bindingId,
				bindingEpochIds: [parentEpoch.value.bindingEpochId],
				status: "running",
				startedAt: NOW,
			});

			const productRoles = fixture.composition.productPromptRoles();
			if (productRoles === undefined) throw new Error("Expected product prompt roles");
			const runId = "run-product-mcp-inheritance";
			const parentCorrelation = {
				sessionId: "session-composition",
				laneId: "parent-lane",
				runId,
				operationId: runId,
				taskId: parentTask.taskId,
				dispatchId: parentDispatch.dispatchId,
				attemptId: parentEpoch.value.attemptId,
				bindingId: parentBinding.bindingId,
				bindingEpochId: parentEpoch.value.bindingEpochId,
				agentInstanceId: parentAgent.agentInstanceId,
				providerId: "parent-provider",
				revision: 0,
			};
			const spawnInput = {
				schemaVersion: 1 as const,
				runId,
				prompt: "Review the docs server only",
				parentTask,
				parentBinding,
				parentRoleRevision: parentRole,
				parentModelProfile: parentProfile,
				parentDispatch,
				parentBindingEpoch: parentEpoch.value,
				parentAgentInstance: parentAgent,
				parentCorrelation,
				timestamp: NOW,
				selectedRoleRevision: registered.value.currentRevision,
			};
			const approvalRequired = await productRoles.spawn(spawnInput);
			expect(approvalRequired).toMatchObject({ ok: false, error: { code: "subagent_binding_projection_invalid" } });
			expect(pendingApprovals).toHaveLength(1);
			approval.ledger.appendApprovalOutcome(pendingApprovals[0]!, {
				outcome: "approved",
				source: "system",
				resolvedAt: APPROVED_AT,
			});
			const replayed = await productRoles.spawn(spawnInput);
			if (!replayed.ok) throw replayed.error;
			expect(replayed.value.attemptReceiptIds).toHaveLength(1);

			const facts = (await fixture.session.findFoundationRecords({ kind: "fact", order: "oldestFirst" }))
				.filter((record) => record.kind === "fact");
			const childBindingFact = facts.find((record) => record.objectType === "agent_binding" && record.objectId.startsWith("binding_child_"));
			if (childBindingFact?.kind !== "fact") throw new Error("Expected the durable child AgentBinding");
			const childBinding = childBindingFact.payload as unknown as AgentBinding;
			expect(childBinding.mcpSelection.servers.map((server) => server.serverId)).toEqual(["docs"]);
			expect(isMcpSelectionSubset(parentSelection, childBinding.mcpSelection)).toBe(true);
			const projection = facts.find((record) => record.objectType === "subagent.child_binding_projection");
			expect(projection).toMatchObject({ kind: "fact", payload: { mcpApprovalEvidenceId: "policy-entry-2" } });
		} finally {
			await fixture.close();
		}
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
		["quorum", { type: "quorum", minimumSucceeded: 1 } as const, ["child-fake-second"] as const, true],
		["partial", { type: "partial" } as const, ["child-fake-second"] as const, true],
		["all_succeed failure", { type: "all_succeed" } as const, ["child-fake-second"] as const, false],
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
		const fixture = await correctionHarness({ productionPath: true, failedChildren: ["child-fake"] });
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
			"create:child-fake:child-attempt",
			"harness:child-fake:child-attempt",
			"apply:child-fake:child-attempt:conflict",
			"delete:child-fake:child-attempt",
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
		expect(adapter.calls).toContain("quarantine:child-fake:child-attempt");
		await fixture.close();
	});

	it("bridges an exact Scheduler agent provider through native spawn, lookup, and rebind", async () => {
		const fixture = await correctionHarness();
		try {
			const provider = fixture.composition
				.schedulerAgentProviders()
				.find((candidate) => candidate.providerId === "native.in_process");
			if (provider === undefined) throw new Error("Expected Scheduler Native Agent provider");
			const descriptor = fixture.composition
				.providerDescriptors()
				.find((candidate) => candidate.descriptor.providerId === provider.providerId);
			if (descriptor === undefined) throw new Error("Expected Scheduler Native Agent descriptor");
			const sourcePlan = await planInput(
				fixture.ledgerForLane("parent-lane"),
				role(),
				profile(),
				"scheduler",
				descriptor,
			);
			const resolveInput: SchedulerNativeAgentResolveInput = {
				schemaVersion: 1,
				provider,
				entry: {
					schemaVersion: 1,
					queueEntryId: "queue-native-scheduler",
					sessionId: "session-composition",
					taskId: sourcePlan.request.taskEnvelope.taskId,
					goalId: sourcePlan.request.taskEnvelope.goalId,
					state: "claimed",
					priority: 1,
					attemptsUsed: 0,
					enqueuedAt: NOW,
					claimId: "claim-native-scheduler",
					revision: 1,
				},
				claim: {
					schemaVersion: 1,
					claimId: "claim-native-scheduler",
					queueEntryId: "queue-native-scheduler",
					taskId: sourcePlan.request.taskEnvelope.taskId,
					ownerId: "scheduler-owner",
					fencingToken: "scheduler-fence",
					acquiredAt: NOW,
					expiresAt: "2026-01-01T01:00:00.000Z",
					revision: 0,
				},
				binding: sourcePlan.childBinding,
				sessionId: "session-composition",
				laneId: "scheduler-child-lane",
				dispatchId: "dispatch-native-scheduler",
				attemptId: "attempt-native-scheduler",
				bindingEpochId: "epoch-native-scheduler",
				agentInstanceId: "agent-native-scheduler",
				spawnId: sourcePlan.request.spawnId,
				activatedByCommandId: `command:${sourcePlan.request.spawnId}`,
				now: NOW,
			};
			let plannerCalls = 0;
			const planner = {
				schemaVersion: 1 as const,
				plan: async (input: SchedulerNativeAgentResolveInput, current: SubagentProviderDescriptor) => {
					plannerCalls += 1;
					return Result.ok({
						...sourcePlan,
						childLaneId: input.laneId,
						childBinding: input.binding,
						providerDescriptor: current,
						childAgentInstanceId: input.agentInstanceId,
						dispatchId: input.dispatchId,
						attemptId: input.attemptId,
						bindingEpochId: input.bindingEpochId,
						activatedByCommandId: input.activatedByCommandId,
					});
				},
			};
			const bridge = fixture.composition.schedulerNativeAgentBridge(planner);
			const resolved = await bridge.resolve(resolveInput);
			expect(resolved.ok).toBe(true);
			if (!resolved.ok) return;
			expect(plannerCalls).toBe(1);
			expect(resolved.value).toMatchObject({
				providerId: provider.providerId,
				agentInstance: { agentInstanceId: resolveInput.agentInstanceId },
				initialBindingEpoch: {
					bindingEpochId: resolveInput.bindingEpochId,
					agentInstanceId: resolveInput.agentInstanceId,
				},
				correlation: {
					providerId: provider.providerId,
					agentInstanceId: resolveInput.agentInstanceId,
					bindingEpochId: resolveInput.bindingEpochId,
				},
			});
			const revalidated = await bridge.revalidate({
				schemaVersion: 1,
				provider,
				binding: sourcePlan.childBinding,
				resolution: resolved.value,
			});
			if (!revalidated.ok) throw revalidated.error;
			const attempt = await provider.createAttempt(
				resolved.value.dispatch,
				sourcePlan.childBinding,
				{
					initialBindingEpoch: resolved.value.initialBindingEpoch,
					agentInstance: resolved.value.agentInstance,
					correlation: resolved.value.correlation,
				},
			);
			if (!attempt.ok) throw attempt.error;
			const receipt = await provider.runAttempt(attempt.value, { correlation: resolved.value.correlation });
			expect(receipt).toMatchObject({
				ok: true,
				value: {
					attemptId: resolveInput.attemptId,
					agentInstanceId: resolveInput.agentInstanceId,
					bindingEpochIds: [resolveInput.bindingEpochId],
					provenance: { producerKind: "agent_executor" },
				},
			});

			expect((await fixture.composition.reload()).ok).toBe(true);
			const rebound = fixture.composition.schedulerNativeAgentBridge(planner);
			const replayed = await rebound.resolve(resolveInput);
			expect(replayed).toEqual(resolved);
			expect(plannerCalls).toBe(1);
			expect(
				await rebound.revalidate({
					schemaVersion: 1,
					provider,
					binding: sourcePlan.childBinding,
					resolution: resolved.value,
				}),
			).toEqual(Result.ok(undefined));

			const staleEpoch = {
				...resolved.value,
				initialBindingEpoch: {
					...resolved.value.initialBindingEpoch,
					bindingEpochId: "epoch-native-stale",
				},
			};
			expect(
				await bridge.revalidate({
					schemaVersion: 1,
					provider,
					binding: sourcePlan.childBinding,
					resolution: staleEpoch,
				}),
			).toMatchObject({ ok: false, error: { code: "subagent_conflict" } });
			const spoof = new Proxy(provider, {}) as TaskExecutorProvider;
			expect(await bridge.resolve({ ...resolveInput, provider: spoof })).toMatchObject({
				ok: false,
				error: { code: "subagent_provider_unavailable" },
			});
		} finally {
			await fixture.close();
		}
	});

	it("is default-off and constructs only the fixed in-process/fork registry after explicit Host opt-in", async () => {
		expect(createSubagentComposition(undefined)).toBeUndefined();
		const session = new Session(new InMemorySessionStorage({ id: "session-composition", createdAt: 1 }));
		const ledgers = new Map<string, SessionLedger>();
		const ledgerForLane = (laneId: string): SessionLedger => {
			let ledger = ledgers.get(laneId);
			if (ledger === undefined) {
				ledger = new SessionLedger(session, { ownerId: "composition-writer", laneId });
				ledgers.set(laneId, ledger);
			}
			return ledger;
		};
		const passiveProvider: QuotaProvider = {
			schemaVersion: 1 as const,
			providerId: "fake",
			providerClass: "quota" as const,
			capabilities: async () => [],
			reserve: async (attribution, budget) => Result.ok({
				schemaVersion: 1,
				reservationId: "reservation-fake",
				attribution,
				budget,
				grantedAt: NOW,
			}),
			settle: async (_reservation, usage) => Result.ok(usage),
			dispose: async () => {},
		};
		const modelGateway = {
			schemaVersion: 1 as const,
			providerId: "fake-model-gateway",
			providerClass: "gateway" as const,
			capabilities: async () => [],
			stream: async () => Result.err(new Error("not used")),
			dispose: async () => {},
		} as unknown as ScopedModelGateway;
		const toolGateway = {
			schemaVersion: 1 as const,
			providerId: "fake-tool-gateway",
			providerClass: "gateway" as const,
			capabilities: async () => [],
			execute: async () => Result.err(new Error("not used")),
			dispose: async () => {},
		} as unknown as ToolGateway;
		const artifactStore = {
			schemaVersion: 1 as const,
			providerId: "fake-artifact-store",
			providerClass: "store" as const,
			capabilities: async () => [],
			put: async () => Result.err(new Error("not used")),
			get: async () => Result.err(new Error("not used")),
			verify: async () => Result.ok({ schemaVersion: 1 as const, digestValid: true }),
			delete: async () => Result.ok(undefined),
			dispose: async () => {},
		} as unknown as ArtifactStoreProvider;
		const composition = new SubagentComposition({
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
				{ schemaVersion: 1, sessionId: "session-composition", laneId: "child-lane", agentInstanceId: "child-fake", taskId: "child-task", attemptId: "child-attempt" },
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
		const executed = await composition.executePlan({ schemaVersion: 1, runId: "run-fake", plan: planned.value });
		if (!executed.ok) throw executed.error;
		expect(executed).toMatchObject({ ok: true, value: { receipt: { receipt: { status: "succeeded" } } } });
		const sent = await composition.deliverChildMailbox({
			schemaVersion: 1,
			messageId: "message-fake",
			fromAgentInstanceId: "child-fake",
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
		const nextTurn = await composition.consumeParentNextTurnForRun("run-fake");
		expect(nextTurn).toMatchObject({ ok: true, value: { entries: [{ trust: "untrusted_child_output" }] } });
		if (!nextTurn.ok) throw nextTurn.error;
		expect(nextTurn.value.contextText).toContain('trust="untrusted_child_output"');
		expect(nextTurn.value.contextText).not.toContain("\r");
		expect(nextTurn.value.entries[0]).not.toHaveProperty("body");
		await composition.dispose();
	});

	it("closes a spawned Child after parent Run binding conflict and removes RPC ownership", async () => {
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
		expect((await fixture.statuses()).at(-1)).toBe("closed");
		expect(await fixture.composition.get("run-bind-conflict", "child-fake")).toEqual(Result.ok(undefined));
		expect(await fixture.composition.list("run-bind-conflict", { limit: 10 })).toEqual(Result.ok([]));
		await fixture.composition.dispose();
	});

	it("preserves the dispatch error while closing the spawned Child and removing RPC ownership", async () => {
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
		expect((await fixture.statuses()).at(-1)).toBe("closed");
		expect(await fixture.composition.get("run-dispatch-failure", "child-fake")).toEqual(Result.ok(undefined));
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
		expect((await fixture.statuses()).at(-1)).toBe("closed");
		expect(await fixture.composition.get("run-settlement-failure", "child-fake")).toEqual(Result.ok(undefined));
		expect(await fixture.composition.list("run-settlement-failure", { limit: 10 })).toEqual(Result.ok([]));
		await fixture.composition.dispose();
	});

	it("closes a successful no-worktree Child during composition disposal", async () => {
		const fixture = await correctionHarness();
		const result = await fixture.composition.executePlan({
			schemaVersion: 1,
			runId: "run-dispose-no-worktree",
			plan: fixture.plan,
		});
		if (!result.ok) throw result.error;
		expect((await fixture.statuses()).at(-1)).toBe("succeeded");

		await fixture.composition.dispose();

		expect((await fixture.statuses()).at(-1)).toBe("closed");
	});

	it("recovers a suspended Child handle across reload and resumes from its transcript", async () => {
		const fixture = await correctionHarness({ suspendThenResume: true, planMaxTurns: 1 });
		const suspended = await fixture.composition.executePlan({
			schemaVersion: 1,
			runId: "run-resume-after-reload",
			plan: fixture.plan,
		});
		if (!suspended.ok) throw suspended.error;
		expect(suspended.value.receipt.receipt.status).toBe("suspended");
		expect((await fixture.statuses()).at(-1)).toBe("awaiting_input");
		expect(await fixture.ledgerForLane("child-lane").get(
			"attempt_receipt",
			suspended.value.receipt.receipt.attemptReceiptId,
		)).toBeUndefined();

		expect(await fixture.composition.reload()).toEqual(Result.ok(undefined));
		expect((await fixture.statuses()).at(-1)).toBe("awaiting_input");
		const resumed = await fixture.composition.resumeChild({
			schemaVersion: 1,
			runId: "run-resume-after-reload",
			childAgentInstanceId: "child-fake",
			expectedTurnCount: 1,
			additionalTurns: 1,
		});
		if (!resumed.ok) throw resumed.error;
		expect(resumed.value.receipt.status).toBe("succeeded");
		expect(resumed.value.lifecycle.status).toBe("succeeded");
		expect(fixture.resumeCalls()).toBe(1);
		expect(await fixture.ledgerForLane("child-lane").get(
			"attempt_receipt",
			resumed.value.receipt.attemptReceiptId,
		)).toMatchObject({ kind: "fact", payload: { status: "succeeded" } });
		await fixture.close();
	});
});
