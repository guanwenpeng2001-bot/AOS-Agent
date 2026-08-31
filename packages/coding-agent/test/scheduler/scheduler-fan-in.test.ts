import {
	type AcceptanceFact,
	type AgentBinding,
	type AttemptReceipt,
	type Attempt,
	createAttempt,
	createModelProfileRevision,
	createRoleRevision,
	type Dispatch,
	FoundationError,
	type FoundationProviderCapability,
	type FoundationProviderExecutionOptions,
	fingerprintFoundationValue,
	InMemorySessionStorage,
	type ModelProfile,
	Result,
	type ResultValue,
	type RevisionReference,
	resolveAgentBinding,
	Session,
	SessionLedger,
	type TaskEnvelope,
	type TaskExecutorAttemptContext,
	type TaskExecutorProvider,
	type ValidationResult,
	validateAttemptReceiptForProvider,
} from "../../../agent/src/internal.ts";
import { describe, expect, it, vi } from "vitest";
import { createRunLifecycleCoordinator, type RunHandle } from "../../src/core/session/run-lifecycle.ts";
import {
	type SchedulerHostOptions,
	type SchedulerHostRunAssociation,
	SchedulerHost,
	type SchedulerJoinPlan,
	type SchedulerNodeRef,
	type SchedulerQueueEntry,
} from "../../src/core/scheduler/host.ts";
import {
	SchedulerDispatchController,
	type SchedulerDispatchExecutorRequirements,
} from "../../src/core/scheduler/dispatch.ts";
import { SCHEDULER_IN_PROCESS_CAPABILITY_ID, SchedulerExecutorRegistry } from "../../src/core/scheduler/executors.ts";
import {
	SchedulerFanInController,
	type SchedulerFanInSettleRequest,
	schedulerFanInSnapshotsEqual,
	schedulerNodeJoinId,
} from "../../src/core/scheduler/fan-in.ts";
import { SchedulerQueueStore } from "../../src/core/scheduler/queue.ts";
import { SessionManager } from "../../src/core/session/manager.ts";
import { observeCanonicalTerminal } from "../support/canonical-run-terminal.ts";
import {
	type TaskGraphGateLookup,
	type TaskGraphNodeView,
	type TaskGraphRecord,
	type TaskGraphRunLookup,
	type TaskGraphRunSnapshot,
	TaskGraphStore,
} from "../../src/core/scheduler/task-graph.ts";

const NOW = "2026-08-22T12:00:00.000Z";
const SESSION_ID = "session_scheduler_fan_in";
let harnessOrdinal = 0;
const OWNER_ID = "scheduler_fan_in_host";
const RUN_MODEL = { provider: "host", id: "host", thinkingLevel: "off" as const };
const CAPABILITY: FoundationProviderCapability = {
	schemaVersion: 1,
	id: SCHEDULER_IN_PROCESS_CAPABILITY_ID,
	version: 1,
};
const ARTIFACT = {
	schemaVersion: 1 as const,
	artifactId: "artifact_scheduler_fan_in",
	mediaType: "application/json",
	digest: `sha256:${"d".repeat(64)}`,
};
const TEST_RESULT: ValidationResult = {
	name: "scheduler-fan-in",
	required: true,
	status: "passed",
};
const ACCEPTANCE_FACT: AcceptanceFact = {
	schemaVersion: 1,
	factId: "acceptance_scheduler_fan_in",
	criterionId: "criterion_scheduler_fan_in",
	outcome: "satisfied",
	evidenceRefs: [ARTIFACT],
	recordedAt: NOW,
	recordedBy: OWNER_ID,
};
const VALIDATION = {
	schemaValid: true,
	artifactDigestsValid: true,
	acceptanceVerified: true,
	requiredEvidencePresent: true,
};

function task(overrides: Partial<TaskEnvelope> = {}): TaskEnvelope {
	return {
		schemaVersion: 1,
		taskId: "task_scheduler_fan_in",
		goalId: "goal_scheduler_fan_in",
		goal: "Exercise the production Scheduler Host fan-in chain",
		workspace: "workspace_scheduler_fan_in",
		capabilityRefs: [],
		inputs: [],
		expectedOutputs: [ARTIFACT],
		budget: { tokens: 100, concurrency: 3 },
		acceptanceCriteria: [
			{
				schemaVersion: 1,
				criterionId: "criterion_scheduler_fan_in",
				description: "The executor output is accepted",
				satisfiedBy: "evidence",
				required: true,
			},
		],
		status: "ready",
		createdAt: NOW,
		updatedAt: NOW,
		...overrides,
	};
}

function roleRevision() {
	return createRoleRevision({
		definition: {
			schemaVersion: 1,
			roleId: "role_scheduler_fan_in",
			scope: "project",
			slug: "scheduler-fan-in",
			name: "Scheduler fan-in",
			description: "Runs Scheduler fan-in tests",
			revision: 1,
			persona: "Execute the claimed graph node.",
			modelProfileRef: {
				schemaVersion: 1,
				type: "model_profile",
				id: "profile_scheduler_fan_in",
				revision: 1,
			},
			capabilitySelector: { policy: "all" },
			skillSelector: { policy: "none" },
			mcpSelector: { policy: "none" },
		},
		now: () => NOW,
	});
}

function modelProfile(): ModelProfile {
	return createModelProfileRevision({
		schemaVersion: 1,
		modelProfileId: "profile_scheduler_fan_in",
		provider: "host",
		model: "host",
		budget: { tokens: 100 },
		revision: 1,
		createdAt: NOW,
	});
}

function immutableFact(type: string, id: string): RevisionReference {
	const value = { schemaVersion: 1 as const, type, id, revision: 1 };
	return { ...value, fingerprint: fingerprintFoundationValue(value) };
}

function binding(currentTask: TaskEnvelope): AgentBinding {
	const resolved = resolveAgentBinding({
		task: currentTask,
		roleRevision: roleRevision(),
		modelProfile: modelProfile(),
		contextRevision: immutableFact("external_agent_binding", "external_scheduler_fan_in"),
		capabilityRevision: immutableFact("capability_binding", "capability_scheduler_fan_in"),
		modelBrokerBindingRevision: immutableFact("model_broker_binding", "broker_scheduler_fan_in"),
		policyRevision: immutableFact("policy_binding", "policy_scheduler_fan_in"),
		newBindingId: "binding_scheduler_fan_in",
		now: () => NOW,
	});
	if (!resolved.ok) throw resolved.error;
	return resolved.value;
}

async function seedBindingFacts(session: Session, currentTask: TaskEnvelope, value: AgentBinding): Promise<void> {
	const ledger = new SessionLedger(session, { ownerId: "scheduler_fan_in_seed" });
	await ledger.appendFact("task", value.taskId, currentTask, {
		clientRequestId: "fan-in-seed:task",
		expectedRevision: 0,
		correlation: { taskId: value.taskId },
	});
	await ledger.appendFact("role_revision", value.roleRevision.id, roleRevision(), {
		clientRequestId: "fan-in-seed:role",
		expectedRevision: 0,
		correlation: { taskId: value.taskId, bindingId: value.bindingId },
	});
	await ledger.appendFact("model_profile_revision", value.modelProfileRevision.id, modelProfile(), {
		clientRequestId: "fan-in-seed:model",
		expectedRevision: 0,
		correlation: { taskId: value.taskId, bindingId: value.bindingId },
	});
	for (const [objectType, reference] of [
		["external_agent_binding", value.contextRevision],
		["capability_binding", value.capabilityRevision],
		["model_broker_binding", value.modelBrokerBindingRevision],
		["policy_binding", value.policyRevision],
	] as const) {
		await ledger.appendFact(
			objectType,
			reference.id,
			{
				schemaVersion: 1,
				type: reference.type,
				id: reference.id,
				revision: reference.revision,
			},
			{
				clientRequestId: `fan-in-seed:${objectType}`,
				expectedRevision: 0,
				correlation: { taskId: value.taskId, bindingId: value.bindingId },
			},
		);
	}
	await ledger.release();
}

type ReceiptStatus = "succeeded" | "failed" | "cancelled";

function providerReceipt(
	attempt: Attempt,
	options: FoundationProviderExecutionOptions | undefined,
	status: ReceiptStatus,
): AttemptReceipt {
	const correlation = options?.correlation;
	if (correlation === undefined) throw new FoundationError("invalid_correlation", "Provider correlation is required");
	const attemptReceiptId = `attempt_receipt_${attempt.attemptId}`;
	return {
		schemaVersion: 1,
		attemptReceiptId,
		taskId: attempt.taskId,
		dispatchId: attempt.dispatchId,
		attemptId: attempt.attemptId,
		providerId: attempt.providerId,
		bindingId: attempt.bindingId,
		bindingEpochIds: [...attempt.bindingEpochIds],
		status,
		workerReceiptRefs: [],
		artifacts: status === "succeeded" ? [ARTIFACT] : [],
		provenance: {
			producerKind: "scheduler",
			providerId: attempt.providerId,
			producedAt: NOW,
			correlation: { ...correlation, attemptReceiptId },
		},
		sideEffectState: "none",
		...(status === "succeeded"
			? {}
			: {
					error: {
						code: status === "cancelled" ? "cancelled" : "worker_lost",
						message: status === "cancelled" ? "Attempt cancelled" : "Injected worker loss",
						retryable: false,
					},
				}),
	};
}

class FakeTaskExecutor implements TaskExecutorProvider {
	readonly schemaVersion = 1 as const;
	readonly providerId = "task_executor_scheduler_fan_in";
	readonly providerClass = "task_executor" as const;
	nextStatus: ReceiptStatus = "succeeded";
	emitSuccessArtifact = true;
	block = false;
	active = 0;
	maxActive = 0;
	startedCount = 0;
	cancelCount = 0;
	private releaseBlocked: () => void = () => {};
	private blockPromise: Promise<void> = Promise.resolve();
	private readonly cancelled = new Set<string>();

	async capabilities(): Promise<readonly FoundationProviderCapability[]> {
		return [CAPABILITY];
	}

	async createAttempt(dispatch: Dispatch, _binding: AgentBinding, context?: TaskExecutorAttemptContext) {
		if (context === undefined)
			return Result.err(new FoundationError("invalid_correlation", "Attempt context required"));
		return createAttempt({
			attemptId: context.initialBindingEpoch.attemptId,
			dispatch,
			providerId: this.providerId,
			initialBindingEpoch: context.initialBindingEpoch,
			providerClass: this.providerClass,
			now: () => NOW,
		});
	}

	async runAttempt(attempt: Attempt, options?: FoundationProviderExecutionOptions) {
		this.active++;
		this.startedCount++;
		this.maxActive = Math.max(this.maxActive, this.active);
		if (this.block && !this.cancelled.has(attempt.attemptId) && options?.signal?.aborted !== true) {
			await this.blockPromise;
		}
		const status =
			this.cancelled.has(attempt.attemptId) || options?.signal?.aborted === true ? "cancelled" : this.nextStatus;
		this.active--;
		const receipt = providerReceipt(attempt, options, status);
		return validateAttemptReceiptForProvider(
			status === "succeeded" && !this.emitSuccessArtifact ? { ...receipt, artifacts: [] } : receipt,
			{
				providerId: this.providerId,
				providerClass: this.providerClass,
			},
		);
	}

	async cancelAttempt(attemptId: string) {
		this.cancelCount++;
		this.cancelled.add(attemptId);
		this.release();
		return Result.ok(undefined);
	}

	prepareBlock(): void {
		this.block = true;
		this.blockPromise = new Promise((resolve) => {
			this.releaseBlocked = resolve;
		});
	}

	release(): void {
		this.block = false;
		this.releaseBlocked();
	}

	async dispose(): Promise<void> {}
}

class EmptyGateLookup implements TaskGraphGateLookup {
	getByBusinessKey(): undefined {
		return undefined;
	}
}

class CoordinatorRunLookup implements TaskGraphRunLookup {
	private readonly sessionId: string;
	private readonly coordinator: ReturnType<typeof createRunLifecycleCoordinator>;

	constructor(sessionId: string, coordinator: ReturnType<typeof createRunLifecycleCoordinator>) {
		this.sessionId = sessionId;
		this.coordinator = coordinator;
	}

	get(runId: string): TaskGraphRunSnapshot | undefined {
		const run = this.coordinator.getRun(runId);
		if (run === undefined) return undefined;
		return {
			sessionId: this.sessionId,
			runId,
			status: run.record.status,
			...(run.receipt === undefined ? {} : { receiptStatus: run.receipt.status }),
		};
	}
}

interface FanInHarness {
	readonly sessionId: string;
	readonly foundationSession: Session;
	readonly runSession: SessionManager;
	readonly currentTask: TaskEnvelope;
	readonly currentBinding: AgentBinding;
	readonly queue: SchedulerQueueStore;
	readonly dispatch: SchedulerDispatchController;
	readonly fanIn: SchedulerFanInController;
	readonly graph: TaskGraphStore;
	readonly provider: FakeTaskExecutor;
	readonly registry: SchedulerExecutorRegistry;
	readonly coordinator: ReturnType<typeof createRunLifecycleCoordinator>;
	readonly runs: Map<string, RunHandle>;
	association(
		graph: TaskGraphRecord,
		node: TaskGraphNodeView,
	): ResultValue<SchedulerHostRunAssociation, FoundationError>;
	settleRun(runId: string, succeeded: boolean): Promise<ResultValue<void, FoundationError>>;
}

async function createHarness(
	nodes: readonly { nodeId: string; dependsOn: readonly string[] }[],
	taskOverrides: Partial<TaskEnvelope> = {},
): Promise<FanInHarness> {
	harnessOrdinal++;
	const sessionId = `${SESSION_ID}_${harnessOrdinal}`;
	const currentTask = task(taskOverrides);
	const currentBinding = binding(currentTask);
	const foundationSession = new Session(new InMemorySessionStorage({ id: sessionId, createdAt: 1 }));
	await seedBindingFacts(foundationSession, currentTask, currentBinding);
	const runSession = SessionManager.inMemory("/workspace/scheduler-fan-in", { id: sessionId });
	const coordinator = createRunLifecycleCoordinator(runSession, { diagnostics: () => {} });
	const graph = new TaskGraphStore(
		runSession,
		new CoordinatorRunLookup(sessionId, coordinator),
		new EmptyGateLookup(),
		{ now: () => NOW },
	);
	graph.create({
		taskId: currentTask.taskId,
		graphRevision: 1,
		nodes: nodes.map((node) => ({ nodeId: node.nodeId, dependsOn: [...node.dependsOn] })),
		clientRequestId: "create-scheduler-fan-in-graph",
	});
	const provider = new FakeTaskExecutor();
	const registry = new SchedulerExecutorRegistry();
	const registered = await registry.register({
		entry: {
			schemaVersion: 1,
			descriptor: {
				schemaVersion: 1,
				providerId: provider.providerId,
				providerClass: provider.providerClass,
			},
			capabilities: [CAPABILITY],
			costClass: "local",
			registeredAt: NOW,
		},
		provider,
		trusted: true,
		latencyMs: 0,
	});
	if (!registered.ok) throw registered.error;
	const queue = new SchedulerQueueStore({
		ledger: foundationSession,
		sessionId,
		ownerId: OWNER_ID,
		now: () => NOW,
		cancelAttempt: (attemptId) => provider.cancelAttempt(attemptId),
	});
	const dispatch = new SchedulerDispatchController({
		session: foundationSession,
		queue,
		registry,
		sessionId,
		ownerId: OWNER_ID,
		now: () => NOW,
		runLifecycleSession: runSession,
	});
	const fanIn = new SchedulerFanInController({
		session: foundationSession,
		sessionId,
		ownerId: OWNER_ID,
		now: () => NOW,
	});
	const runs = new Map<string, RunHandle>();
	return {
		sessionId,
		foundationSession,
		runSession,
		currentTask,
		currentBinding,
		queue,
		dispatch,
		fanIn,
		graph,
		provider,
		registry,
		coordinator,
		runs,
		association(_graph, node) {
			const runId = `run-${node.nodeId}`;
			if (!runs.has(runId)) {
				const run = coordinator.reserve().accept({ runId, attempt: 1, model: RUN_MODEL });
				run.start();
				runs.set(runId, run);
			}
			return Result.ok({ runId, task: currentTask, binding: currentBinding });
		},
		async settleRun(runId, succeeded) {
			const run = runs.get(runId);
			if (run === undefined) return Result.err(new FoundationError("scheduler_not_found", "Run was not reserved"));
			await observeCanonicalTerminal(runSession, run, { outcome: succeeded ? "completed" : "failed" });
			return Result.ok(undefined);
		},
	};
}

function validEvidence() {
	return {
		summary: "Scheduler fan-in accepted the executor result.",
		tests: [TEST_RESULT],
		evidence: [ACCEPTANCE_FACT],
		validation: VALIDATION,
	};
}

async function executeDirectReceipt(
	harness: FanInHarness,
	nodeId: string,
	status: ReceiptStatus,
): Promise<AttemptReceipt> {
	harness.provider.nextStatus = status;
	const entry: SchedulerQueueEntry = {
		schemaVersion: 1,
		queueEntryId: `queue-direct-${nodeId}`,
		sessionId: harness.sessionId,
		taskId: harness.currentTask.taskId,
		nodeRef: { taskId: harness.currentTask.taskId, graphRevision: 1, nodeId },
		state: "queued",
		priority: 0,
		attemptsUsed: 0,
		enqueuedAt: NOW,
		revision: 0,
	};
	const enqueued = await harness.queue.enqueue(entry);
	if (!enqueued.ok) throw enqueued.error;
	const claimed = await harness.queue.claim({ queueEntryId: entry.queueEntryId, ownerId: OWNER_ID });
	if (!claimed.ok) throw claimed.error;
	const executed = await harness.dispatch.dispatchClaimed({
		queueEntryId: entry.queueEntryId,
		fencingToken: claimed.value.claim.fencingToken,
		binding: harness.currentBinding,
	});
	if (!executed.ok) throw executed.error;
	return executed.value.receipt;
}

function settleRequest(
	harness: FanInHarness,
	nodeId: string,
	receiptIds: readonly string[],
	plan?: SchedulerJoinPlan,
): SchedulerFanInSettleRequest {
	return {
		task: harness.currentTask,
		nodeRef: { taskId: harness.currentTask.taskId, graphRevision: 1, nodeId },
		currentAttemptReceiptIds: receiptIds,
		...(plan === undefined ? {} : { plan }),
		...validEvidence(),
	};
}

describe("scheduler production fan-in", () => {
	it("forwards the exact Host association executor requirements to dispatch", async () => {
		const harness = await createHarness([{ nodeId: "requirements", dependsOn: [] }]);
		const executorRequirements = Object.freeze({
			requireResume: true,
			modelAccess: "aos_gateway" as const,
			credentialTargetRefs: Object.freeze(["credential:fake"]),
			sandboxTargetRefs: Object.freeze(["sandbox:fake"]),
		});
		let forwardedRequirements: SchedulerDispatchExecutorRequirements | undefined;
		const host = new SchedulerHost({
			enabled: true,
			sessionId: harness.sessionId,
			ownerId: OWNER_ID,
			graph: harness.graph,
			queue: harness.queue,
			dispatch: {
				dispatchRunClaimed(request) {
					forwardedRequirements = request.executorRequirements;
					return harness.dispatch.dispatchRunClaimed({
						runId: request.runId,
						queueEntryId: request.queueEntryId,
						fencingToken: request.fencingToken,
						binding: request.binding,
					});
				},
			},
			fanIn: harness.fanIn,
			resolveRunAssociation: async (graph, node) => {
				const association = harness.association(graph, node);
				return association.ok
					? Result.ok({ ...association.value, executorRequirements })
					: association;
			},
			settlementEvidence: async () => Result.ok(validEvidence()),
			settleRunAtHost: async (input) => harness.settleRun(input.runId, input.taskResult !== undefined),
		});

		const tick = await host.tick();
		expect(tick.dispatched).toBe(1);
		expect(forwardedRequirements).toBe(executorRequirements);
		harness.dispatch.dispose();
		await harness.fanIn.release();
	});

	it("runs a dependent DAG through ready scan, dispatchRunClaimed, settlement, and successor readiness", async () => {
		const harness = await createHarness([
			{ nodeId: "root", dependsOn: [] },
			{ nodeId: "child", dependsOn: ["root"] },
		]);
		let dispatchRunClaimedCalls = 0;
		const host = new SchedulerHost({
			enabled: true,
			sessionId: harness.sessionId,
			ownerId: OWNER_ID,
			graph: harness.graph,
			queue: harness.queue,
			dispatch: {
				dispatchRunClaimed(request) {
					dispatchRunClaimedCalls++;
					return harness.dispatch.dispatchRunClaimed(request);
				},
			},
			fanIn: harness.fanIn,
			resolveRunAssociation: async (graph, node) => harness.association(graph, node),
			settlementEvidence: async () => Result.ok(validEvidence()),
			settleRunAtHost: async (input) => harness.settleRun(input.runId, input.taskResult !== undefined),
		});

		const rootTick = await host.tick();
		expect(rootTick).toMatchObject({ enqueued: 1, claimed: 1, dispatched: 1, settled: 1, rejected: 0 });
		let graph = harness.graph.get(harness.currentTask.taskId, 1);
		if (graph === undefined) throw new Error("Expected scheduler graph");
		expect(graph.nodes.map((node) => [node.nodeId, node.status])).toEqual([
			["root", "succeeded"],
			["child", "pending"],
		]);
		expect(graph.nodes[1]?.availability).toBe("ready");
		const childTick = await host.tick();
		expect(childTick).toMatchObject({ enqueued: 1, claimed: 1, dispatched: 1, settled: 1, rejected: 0 });
		graph = harness.graph.get(harness.currentTask.taskId, 1);
		if (graph === undefined) throw new Error("Expected scheduler graph");
		expect(graph.nodes.map((node) => node.status)).toEqual(["succeeded", "succeeded"]);
		const resultRecords = await harness.foundationSession.findFoundationRecords({
			kind: "fact",
			objectType: "task_result",
		});
		const results = resultRecords.filter((record) => record.kind === "fact");
		expect(results).toHaveLength(2);
		const resultPayloads = results.map(
			(record) =>
				record.payload as { status: string; validation: typeof VALIDATION; sourceAttemptReceiptIds: string[] },
		);
		expect(resultPayloads.every((result) => result.status === "succeeded")).toBe(true);
		expect(resultPayloads.every((result) => result.validation.schemaValid)).toBe(true);
		expect(resultPayloads.map((result) => result.sourceAttemptReceiptIds.length).sort()).toEqual([1, 2]);
		const rootReceiptId = resultPayloads.find((result) => result.sourceAttemptReceiptIds.length === 1)
			?.sourceAttemptReceiptIds[0];
		expect(rootReceiptId).toBeDefined();
		expect(
			resultPayloads.find((result) => result.sourceAttemptReceiptIds.length === 2)?.sourceAttemptReceiptIds,
		).toContain(rootReceiptId);
		expect(
			await harness.foundationSession.findFoundationRecords({ kind: "fact", objectType: "run_receipt" }),
		).toEqual([]);
		expect(harness.coordinator.getRun("run-root")?.receipt?.status).toBe("completed");
		expect(harness.coordinator.getRun("run-child")?.receipt?.status).toBe("completed");
		expect(dispatchRunClaimedCalls).toBe(2);
		harness.dispatch.dispose();
		await harness.fanIn.release();
	});

	it("applies require_all and allow_partial to missing, failed, and cancelled predecessors", async () => {
		const harness = await createHarness([{ nodeId: "placeholder", dependsOn: [] }]);
		const succeeded = await executeDirectReceipt(harness, "good", "succeeded");
		const failed = await executeDirectReceipt(harness, "failed", "failed");
		const cancelled = await executeDirectReceipt(harness, "cancelled", "cancelled");
		const current = await executeDirectReceipt(harness, "join-current", "succeeded");
		for (const [nodeId, receipt] of [
			["good", succeeded],
			["failed", failed],
			["cancelled", cancelled],
		] as const) {
			const settled = await harness.fanIn.settle(settleRequest(harness, nodeId, [receipt.attemptReceiptId]));
			expect(settled.ok).toBe(true);
		}
		const predecessorNodeIds = ["good", "missing", "failed", "cancelled"];
		const nodeRef: SchedulerNodeRef = {
			taskId: harness.currentTask.taskId,
			graphRevision: 1,
			nodeId: "joined",
		};
		const planBase = {
			schemaVersion: 1 as const,
			joinId: schedulerNodeJoinId(nodeRef),
			taskId: harness.currentTask.taskId,
			nodeRef,
			predecessorTaskIds: predecessorNodeIds,
			createdAt: NOW,
		};
		const required = await harness.fanIn.settle(
			settleRequest(harness, "joined", [current.attemptReceiptId], {
				...planBase,
				policy: "require_all",
			}),
		);
		expect(required.ok).toBe(false);
		if (!required.ok) expect(required.error.code).toBe("scheduler_settlement_rejected");
		const partial = await harness.fanIn.settle(
			settleRequest(harness, "joined", [current.attemptReceiptId], {
				...planBase,
				policy: "allow_partial",
			}),
		);
		expect(partial.ok).toBe(true);
		if (!partial.ok) return;
		expect(partial.value.taskResult.status).toBe("succeeded");
		expect(partial.value.snapshot.missingPredecessorNodeIds).toEqual(["missing"]);
		expect(partial.value.snapshot.degradedPredecessorNodeIds).toEqual(["missing", "failed", "cancelled"]);
		expect(partial.value.snapshot.predecessorTaskResultIds).toHaveLength(3);
		harness.dispatch.dispose();
		await harness.fanIn.release();
	});

	it("rejects duplicate and task-mismatched receipts", async () => {
		const harness = await createHarness([{ nodeId: "placeholder", dependsOn: [] }]);
		const receipt = await executeDirectReceipt(harness, "duplicate", "succeeded");
		const duplicate = await harness.fanIn.settle(
			settleRequest(harness, "duplicate", [receipt.attemptReceiptId, receipt.attemptReceiptId]),
		);
		expect(duplicate.ok).toBe(false);
		if (!duplicate.ok) expect(duplicate.error.code).toBe("scheduler_fanin_invalid");
		const otherTask = task({ taskId: "task_scheduler_fan_in_other" });
		const mismatched = await harness.fanIn.settle({
			...settleRequest(harness, "other", [receipt.attemptReceiptId]),
			task: otherTask,
			nodeRef: { taskId: otherTask.taskId, graphRevision: 1, nodeId: "other" },
		});
		expect(mismatched.ok).toBe(false);
		if (!mismatched.ok) expect(mismatched.error.code).toBe("scheduler_fanin_invalid");
		harness.dispatch.dispose();
		await harness.fanIn.release();
	});

	it("rejects success when any of the four sealed acceptance gates fails", async () => {
		const harness = await createHarness([{ nodeId: "placeholder", dependsOn: [] }]);
		const receiptIds: string[] = [];
		for (const nodeId of ["gate-output", "gate-test", "gate-evidence", "gate-validation"]) {
			harness.provider.emitSuccessArtifact = nodeId !== "gate-output";
			const receipt = await executeDirectReceipt(harness, nodeId, "succeeded");
			receiptIds.push(receipt.attemptReceiptId);
		}
		harness.provider.emitSuccessArtifact = true;
		const requests: SchedulerFanInSettleRequest[] = [
			{
				...settleRequest(harness, "gate-output", [receiptIds[0]!]),
			},
			{
				...settleRequest(harness, "gate-test", [receiptIds[1]!]),
				tests: [{ ...TEST_RESULT, status: "failed" }],
			},
			{
				...settleRequest(harness, "gate-evidence", [receiptIds[2]!]),
				evidence: [],
			},
			{
				...settleRequest(harness, "gate-validation", [receiptIds[3]!]),
				validation: { ...VALIDATION, schemaValid: false },
			},
		];
		for (const request of requests) {
			const rejected = await harness.fanIn.settle(request);
			expect(rejected.ok).toBe(false);
			if (!rejected.ok) expect(rejected.error.code).toBe("task_result_validation_failed");
		}
		expect(
			await harness.foundationSession.findFoundationRecords({ kind: "fact", objectType: "task_result" }),
		).toEqual([]);
		harness.dispatch.dispose();
		await harness.fanIn.release();
	});

	it("replays the exact immutable fan-in snapshot after controller reload", async () => {
		const harness = await createHarness([{ nodeId: "placeholder", dependsOn: [] }]);
		const receipt = await executeDirectReceipt(harness, "replay", "succeeded");
		const request = settleRequest(harness, "replay", [receipt.attemptReceiptId]);
		const first = await harness.fanIn.settle(request);
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		await harness.fanIn.release();
		const reloaded = new SchedulerFanInController({
			session: harness.foundationSession,
			sessionId: harness.sessionId,
			ownerId: OWNER_ID,
			now: () => "2026-08-22T13:00:00.000Z",
		});
		const replay = await reloaded.settle(request);
		expect(replay.ok).toBe(true);
		if (!replay.ok) return;
		expect(replay.value.snapshotReplayed).toBe(true);
		expect(schedulerFanInSnapshotsEqual(first.value.snapshot, replay.value.snapshot)).toBe(true);
		expect(replay.value.snapshot).toEqual(first.value.snapshot);
		harness.dispatch.dispose();
		await reloaded.release();
	});

	it("fails the Graph node when one of the four settlement gates rejects success", async () => {
		const harness = await createHarness([{ nodeId: "rejected", dependsOn: [] }]);
		const host = new SchedulerHost({
			enabled: true,
			sessionId: harness.sessionId,
			ownerId: OWNER_ID,
			graph: harness.graph,
			queue: harness.queue,
			dispatch: harness.dispatch,
			fanIn: harness.fanIn,
			resolveRunAssociation: async (graph, node) => harness.association(graph, node),
			settlementEvidence: async () =>
				Result.ok({
					...validEvidence(),
					validation: { ...VALIDATION, requiredEvidencePresent: false },
				}),
			settleRunAtHost: async (input) => harness.settleRun(input.runId, input.taskResult !== undefined),
		});
		const tick = await host.tick();
		expect(tick.rejected).toBe(1);
		expect(tick.errors).toEqual([
			{ taskId: harness.currentTask.taskId, nodeId: "rejected", code: "task_result_validation_failed" },
		]);
		expect(harness.graph.get(harness.currentTask.taskId, 1)?.nodes[0]?.status).toBe("failed");
		expect(
			await harness.foundationSession.findFoundationRecords({ kind: "fact", objectType: "task_result" }),
		).toEqual([]);
		const snapshot = await harness.queue.snapshot();
		expect(snapshot.ok).toBe(true);
		if (snapshot.ok) expect(snapshot.value.entries[0]?.state).toBe("cancelled");
		harness.dispatch.dispose();
		await harness.fanIn.release();
	});

	it("bounds concurrent fan-out Attempts to the configured budget", async () => {
		const harness = await createHarness([
			{ nodeId: "fan-a", dependsOn: [] },
			{ nodeId: "fan-b", dependsOn: [] },
			{ nodeId: "fan-c", dependsOn: [] },
		]);
		const graphRecord = harness.graph.get(harness.currentTask.taskId, 1);
		if (graphRecord === undefined) throw new Error("Expected fan-out graph");
		const graph = {
			list() {
				return { graphs: [graphRecord], truncated: false };
			},
			attach() {
				return { graph: graphRecord, appended: true, idempotent: false };
			},
			settle() {
				return { graph: graphRecord, appended: true, idempotent: false };
			},
		};
		const dispatch = new SchedulerDispatchController({
			session: harness.foundationSession,
			queue: harness.queue,
			registry: harness.registry,
			sessionId: harness.sessionId,
			ownerId: OWNER_ID,
			now: () => NOW,
		});
		harness.provider.prepareBlock();
		const host = new SchedulerHost({
			enabled: true,
			sessionId: harness.sessionId,
			ownerId: OWNER_ID,
			graph,
			queue: harness.queue,
			dispatch: {
				dispatchRunClaimed(request) {
					return dispatch.dispatchClaimed({
						queueEntryId: request.queueEntryId,
						fencingToken: request.fencingToken,
						binding: request.binding,
					});
				},
			},
			fanIn: harness.fanIn,
			maxConcurrentAttempts: 2,
			resolveRunAssociation: async (_graph, node) =>
				Result.ok({
					runId: `run-fan-out-${node.nodeId}`,
					task: harness.currentTask,
					binding: harness.currentBinding,
				}),
			settlementEvidence: async () => Result.ok(validEvidence()),
			settleRunAtHost: async () => Result.ok(undefined),
		});
		const pending = host.tick();
		await vi.waitFor(() => expect(harness.provider.startedCount).toBe(2));
		expect(harness.provider.maxActive).toBe(2);
		harness.provider.release();
		const firstTick = await pending;
		expect(firstTick.dispatched).toBe(2);
		expect(firstTick.errors).toEqual([]);
		expect(harness.provider.maxActive).toBeLessThanOrEqual(2);
		const secondTick = await host.tick();
		expect(secondTick.dispatched).toBe(1);
		expect(secondTick.errors).toEqual([]);
		expect(harness.provider.startedCount).toBe(3);
		expect(harness.provider.maxActive).toBeLessThanOrEqual(2);
		dispatch.dispose();
		harness.dispatch.dispose();
		await harness.fanIn.release();
	});

	it("bounds each Task to its budget concurrency and resumes queued work after capacity releases", async () => {
		const harness = await createHarness(
			[
				{ nodeId: "budget-a", dependsOn: [] },
				{ nodeId: "budget-b", dependsOn: [] },
				{ nodeId: "budget-c", dependsOn: [] },
			],
			{ budget: { tokens: 100, concurrency: 1 } },
		);
		const graphRecord = harness.graph.get(harness.currentTask.taskId, 1);
		if (graphRecord === undefined) throw new Error("Expected budget-constrained graph");
		const graph = {
			list() {
				return { graphs: [graphRecord], truncated: false };
			},
			attach() {
				return { graph: graphRecord, appended: true, idempotent: false };
			},
			settle() {
				return { graph: graphRecord, appended: true, idempotent: false };
			},
		};
		const dispatch = new SchedulerDispatchController({
			session: harness.foundationSession,
			queue: harness.queue,
			registry: harness.registry,
			sessionId: harness.sessionId,
			ownerId: OWNER_ID,
			now: () => NOW,
		});
		harness.provider.prepareBlock();
		const associatedNodeIds: string[] = [];
		const host = new SchedulerHost({
			enabled: true,
			sessionId: harness.sessionId,
			ownerId: OWNER_ID,
			graph,
			queue: harness.queue,
			dispatch: {
				dispatchRunClaimed(request) {
					return dispatch.dispatchClaimed({
						queueEntryId: request.queueEntryId,
						fencingToken: request.fencingToken,
						binding: request.binding,
					});
				},
			},
			fanIn: harness.fanIn,
			maxConcurrentAttempts: 8,
			resolveRunAssociation: async (currentGraph, node) => {
				associatedNodeIds.push(node.nodeId);
				return harness.association(currentGraph, node);
			},
			settlementEvidence: async () => Result.ok(validEvidence()),
			settleRunAtHost: async (input) => harness.settleRun(input.runId, input.taskResult !== undefined),
		});
		const pending = host.tick();
		await vi.waitFor(() => expect(harness.provider.startedCount).toBe(1));
		expect(harness.provider.active).toBe(1);
		expect(harness.provider.maxActive).toBe(1);
		harness.provider.release();
		const firstTick = await pending;
		expect(firstTick.dispatched).toBe(1);
		expect(firstTick.errors).toEqual([
			{ taskId: harness.currentTask.taskId, nodeId: "budget-b", code: "scheduler_budget_exhausted_wait" },
			{ taskId: harness.currentTask.taskId, nodeId: "budget-c", code: "scheduler_budget_exhausted_wait" },
		]);
		expect(associatedNodeIds).toEqual(["budget-a"]);
		expect([...harness.runs.keys()]).toEqual(["run-budget-a"]);
		const firstSnapshot = await harness.queue.snapshot();
		expect(firstSnapshot.ok).toBe(true);
		if (firstSnapshot.ok) {
			expect(firstSnapshot.value.entries.filter((entry) => entry.state === "queued")).toHaveLength(2);
		}
		const secondTick = await host.tick();
		expect(secondTick.dispatched).toBe(1);
		expect(harness.provider.startedCount).toBe(2);
		expect(harness.provider.maxActive).toBe(1);
		expect(associatedNodeIds).toEqual(["budget-a", "budget-b"]);
		expect([...harness.runs.keys()]).toEqual(["run-budget-a", "run-budget-b"]);
		dispatch.dispose();
		harness.dispatch.dispose();
		await harness.fanIn.release();
	});

	it("is default-off and coalesces event wakes with bounded fallback polling", async () => {
		let listCount = 0;
		let subscribedWake: (() => void) | undefined;
		const graph = {
			list() {
				listCount++;
				return { graphs: [], truncated: false };
			},
			attach() {
				throw new Error("not reached");
			},
			settle() {
				throw new Error("not reached");
			},
		};
		const queue = {
			async recoverExpired() {
				return Result.ok([]);
			},
			async snapshot() {
				return Result.ok({ entries: [], claims: [], dispatches: [] });
			},
			async enqueue() {
				return Result.err(new FoundationError("scheduler_queue_invalid", "not reached"));
			},
			async claim() {
				return Result.err(new FoundationError("scheduler_queue_invalid", "not reached"));
			},
			async renew() {
				return Result.err(new FoundationError("scheduler_lease_lost", "not reached"));
			},
			async markTerminal() {
				return Result.err(new FoundationError("scheduler_queue_invalid", "not reached"));
			},
		};
		const base: SchedulerHostOptions = {
			sessionId: SESSION_ID,
			ownerId: OWNER_ID,
			graph,
			queue,
			dispatch: {
				async dispatchRunClaimed() {
					return Result.err(new FoundationError("scheduler_dispatch_invalid", "not reached"));
				},
			},
			fanIn: {
				async settle() {
					return Result.err(new FoundationError("scheduler_fanin_invalid", "not reached"));
				},
			},
			resolveRunAssociation: async (): Promise<ResultValue<SchedulerHostRunAssociation, FoundationError>> =>
				Result.err(new FoundationError("scheduler_not_found", "not reached")),
			settleRunAtHost: async () => Result.ok(undefined),
		};
		const disabled = new SchedulerHost(base);
		expect(disabled.start()).toBe(false);
		expect(await disabled.tick()).toMatchObject({ enabled: false, scannedGraphs: 0 });
		expect(listCount).toBe(0);
		const enabled = new SchedulerHost({
			...base,
			enabled: true,
			pollIntervalMs: 50,
			eventSource: {
				subscribe(wake) {
					subscribedWake = wake;
					return () => {
						subscribedWake = undefined;
					};
				},
			},
		});
		expect(enabled.start()).toBe(true);
		await vi.waitFor(() => expect(listCount).toBeGreaterThanOrEqual(1));
		const afterInitial = listCount;
		subscribedWake?.();
		subscribedWake?.();
		await vi.waitFor(() => expect(listCount).toBeGreaterThan(afterInitial));
		const afterEvent = listCount;
		await vi.waitFor(() => expect(listCount).toBeGreaterThan(afterEvent), { timeout: 250 });
		enabled.stop();
		const stoppedAt = listCount;
		await new Promise((resolve) => setTimeout(resolve, 75));
		expect(listCount).toBe(stoppedAt);
	});
});
