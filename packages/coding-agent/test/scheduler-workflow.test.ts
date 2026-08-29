import {
	type AgentBinding,
	createAttempt,
	createConnectorCapabilitySnapshot,
	createModelProfileRevision,
	createRoleRevision,
	fingerprintFoundationValue,
	FoundationError,
	InMemorySessionStorage,
	type ModelProfile,
	type AttemptReceipt,
	type Attempt,
	type Dispatch,
	type FoundationProviderCapability,
	type FoundationProviderExecutionOptions,
	resolveAgentBinding,
	Result,
	type Result as ResultValue,
	type RevisionReference,
	Session,
	SessionLedger,
	type SideEffectState,
	type TaskEnvelope,
	type TaskExecutorAttemptContext,
	type TaskExecutorProvider,
	type TaskResult,
	validateAttemptReceiptForProvider,
	type WorkflowStep,
	type Workflow,
	type WorkflowStore,
} from "@aos-agent/agent-core";
import { describe, expect, it, vi } from "vitest";
import { createRunLifecycleCoordinator, type RunLifecycleCoordinator } from "../src/core/run-lifecycle.ts";
import {
	createSchedulerExecutorRuntimeSnapshotV1,
	SCHEDULER_IN_PROCESS_CAPABILITY_ID,
	SchedulerExecutorRegistry,
	schedulerBindingRequirementDigestV1,
} from "../src/core/scheduler-executors.ts";
import { SchedulerDispatchController } from "../src/core/scheduler-dispatch.ts";
import { SchedulerFanInController } from "../src/core/scheduler-fan-in.ts";
import { SchedulerHandoffController } from "../src/core/scheduler-handoff.ts";
import { SchedulerMessageOrchestrator } from "../src/core/scheduler-messages.ts";
import { SchedulerSelectionReservationStore } from "../src/core/scheduler-selection-reservations.ts";
import {
	CONNECTOR_RETRY_DECISION_OBJECT_TYPE,
	type ConnectorRetryPolicyV1,
} from "../src/core/connector-retry-circuit.ts";
import { withRuntimeClock, type RuntimeClock } from "../src/core/runtime-clock.ts";
import { SchedulerHost, type SchedulerWakeV1 } from "../src/core/scheduler.ts";
import {
	SCHEDULER_WORKFLOW_ATTEMPT_OBJECT_TYPE,
	SCHEDULER_WORKFLOW_COMPENSATION_OBJECT_TYPE,
	SCHEDULER_WORKFLOW_EXTERNAL_OBJECT_TYPE,
	SCHEDULER_WORKFLOW_POLICY_OBJECT_TYPE,
	SCHEDULER_WORKFLOW_WAKE_OBJECT_TYPE,
	SchedulerWorkflowController,
	type SchedulerWorkflowCompensationFactV1,
	type SchedulerWorkflowCompensationPolicyV1,
	type SchedulerWorkflowConnectorRetryOptionsV1,
	type SchedulerWorkflowPolicyFactV1,
	schedulerWorkflowExternalIds,
} from "../src/core/scheduler-workflow.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { observeCanonicalTerminal } from "./support/canonical-run-terminal.ts";
import { DeterministicClock } from "./support/deterministic-clock.ts";
import { createTaskGraphStore, type TaskGraphStore } from "../src/core/task-graph.ts";

vi.mock("@aos-agent/ai/compat", () => ({
	clampThinkingLevel: (level: unknown) => level,
	cleanupSessionResources: () => {},
	getSupportedThinkingLevels: () => ["off"],
	isContextOverflow: () => false,
	isRecoverableLength: () => false,
	isRetryableAssistantError: () => false,
	modelsAreEqual: () => false,
	resetApiProviders: () => {},
	streamSimple: async () => {
		throw new Error("streamSimple is not exercised by scheduler workflow");
	},
}));

vi.mock("@aos-agent/ai/providers/all", () => ({}));

const T0 = "2026-08-22T12:00:00.000Z";
const T1 = "2026-08-22T12:01:00.000Z";
const T2 = "2026-08-22T12:02:00.000Z";
const T_EXPIRED = "2026-08-22T12:11:00.000Z";
const RUN_MODEL = { provider: "host", id: "host", thinkingLevel: "off" as const };
const OWNER_ID = "workflow_owner";
const EXECUTOR_OWNER_ID = "workflow_executor";
const CAPABILITY: FoundationProviderCapability = {
	schemaVersion: 1,
	id: SCHEDULER_IN_PROCESS_CAPABILITY_ID,
	version: 1,
};
const ARTIFACT = {
	schemaVersion: 1 as const,
	artifactId: "artifact_workflow",
	mediaType: "application/json",
	digest: `sha256:${"e".repeat(64)}`,
};

let harnessOrdinal = 0;

function contract(contractId: string) {
	return { schemaVersion: 1 as const, contractId, kind: "json" as const, required: true };
}

function baseStep(stepId: string, ordinal: number, dependsOn?: readonly string[]): Omit<
	WorkflowStep,
	"type"
> & { type?: WorkflowStep["type"] } {
	return {
		schemaVersion: 1,
		stepId,
		ordinal,
		revision: 1,
		status: "pending",
		input: [contract(`${stepId}-in`)],
		output: [contract(`${stepId}-out`)],
		...(dependsOn === undefined ? {} : { dependsOn }),
	};
}

function toolStep(stepId: string, ordinal: number, dependsOn?: readonly string[]): WorkflowStep {
	return { ...baseStep(stepId, ordinal, dependsOn), type: "tool", toolName: "read" };
}

function agentStep(
	stepId: string,
	ordinal: number,
	executor: "local" | "external",
	taskId: string,
	dependsOn?: readonly string[],
): WorkflowStep {
	return {
		...baseStep(stepId, ordinal, dependsOn),
		type: "agent",
		taskId,
		roleRevision: { schemaVersion: 1, type: "role_revision", id: `role_${executor}`, revision: 1 },
		executor,
	};
}

function parallelStep(
	stepId: string,
	ordinal: number,
	intents: readonly { stepId: string; executor: "local" | "external" }[],
	dependsOn: readonly string[],
): WorkflowStep {
	return {
		...baseStep(stepId, ordinal, dependsOn),
		type: "parallel",
		intents: intents.map((intent, index) => ({
			schemaVersion: 1 as const,
			intentId: `intent_${index}_${intent.stepId}`,
			stepId: intent.stepId,
			executor: intent.executor,
		})),
	};
}

function barrierStep(stepId: string, ordinal: number, dependsOn: readonly string[]): WorkflowStep {
	return { ...baseStep(stepId, ordinal, dependsOn), type: "barrier", barrierId: `barrier_${stepId}` };
}

function awaitUserStep(stepId: string, ordinal: number, dependsOn?: readonly string[]): WorkflowStep {
	return { ...baseStep(stepId, ordinal, dependsOn), type: "await_user", askId: `ask_${stepId}` };
}

function taskEnvelope(taskId: string, goalId: string): TaskEnvelope {
	return {
		schemaVersion: 1,
		taskId,
		goalId,
		goal: "Exercise production Workflow scheduling",
		workspace: "workspace_scheduler_workflow",
		capabilityRefs: [],
		inputs: [],
		expectedOutputs: [ARTIFACT],
		budget: { tokens: 100, concurrency: 4 },
		acceptanceCriteria: [],
		status: "ready",
		createdAt: T0,
		updatedAt: T0,
	};
}

function roleRevision() {
	return createRoleRevision({
		definition: {
			schemaVersion: 1,
			roleId: "role_workflow",
			scope: "project",
			slug: "scheduler-workflow",
			name: "Scheduler workflow",
			description: "Runs production Workflow steps",
			revision: 1,
			persona: "Execute claimed workflow work.",
			modelProfileRef: { schemaVersion: 1, type: "model_profile", id: "profile_workflow", revision: 1 },
			capabilitySelector: { policy: "all" },
			skillSelector: { policy: "none" },
			mcpSelector: { policy: "none" },
		},
		now: () => T0,
	});
}

function modelProfile(): ModelProfile {
	return createModelProfileRevision({
		schemaVersion: 1,
		modelProfileId: "profile_workflow",
		provider: "host",
		model: "host",
		budget: { tokens: 100 },
		revision: 1,
		createdAt: T0,
	});
}

function immutableFact(type: string, id: string): RevisionReference {
	const value = { schemaVersion: 1 as const, type, id, revision: 1 };
	return { ...value, fingerprint: fingerprintFoundationValue(value) };
}

function bindingFor(task: TaskEnvelope): AgentBinding {
	const resolved = resolveAgentBinding({
		task,
		roleRevision: roleRevision(),
		modelProfile: modelProfile(),
		contextRevision: immutableFact("external_agent_binding", "external_workflow"),
		capabilityRevision: immutableFact("capability_binding", "capability_workflow"),
		modelBrokerBindingRevision: immutableFact("model_broker_binding", "broker_workflow"),
		policyRevision: immutableFact("policy_binding", "policy_workflow"),
		newBindingId: "binding_workflow",
		now: () => T0,
	});
	if (!resolved.ok) throw resolved.error;
	return resolved.value;
}

function runtimeSnapshot(providerId: string, binding: AgentBinding) {
	const bindingDigest = schedulerBindingRequirementDigestV1(binding);
	if (!bindingDigest.ok) throw bindingDigest.error;
	if (binding.policyRevision.fingerprint === undefined) throw new Error("policy fingerprint missing");
	const snapshot = createSchedulerExecutorRuntimeSnapshotV1({
		schemaVersion: 1,
		capabilitySnapshot: createConnectorCapabilitySnapshot({
			schemaVersion: 1,
			providerId,
			revision: 1,
			protocol: { name: "scheduler-workflow-test", version: "1" },
			modelAccess: "aos_gateway",
			resume: true,
			toolGateway: true,
			artifacts: true,
			images: false,
		}),
		configRevision: fingerprintFoundationValue(`config:${providerId}`),
		bindingRequirementDigests: [bindingDigest.value],
		toolSelectionDigests: [binding.mcpSelection.digest],
		policyRevisionDigests: [binding.policyRevision.fingerprint],
		reviewRevisionDigests: [],
		credentialTargetRefs: [],
		sandboxTargetRefs: [],
		observedAt: T0,
		expiresAt: "2026-08-22T14:00:00.000Z",
	});
	if (!snapshot.ok) throw snapshot.error;
	return snapshot.value;
}

async function seedBindingFacts(session: Session, task: TaskEnvelope, value: AgentBinding): Promise<void> {
	const ledger = new SessionLedger(session, { ownerId: `${OWNER_ID}_seed` });
	await ledger.appendFact("task", value.taskId, task, {
		clientRequestId: `workflow-seed:task:${value.taskId}`,
		expectedRevision: 0,
		correlation: { taskId: value.taskId },
	});
	await ledger.appendFact("role_revision", value.roleRevision.id, roleRevision(), {
		clientRequestId: `workflow-seed:role:${value.taskId}`,
		expectedRevision: 0,
		correlation: { taskId: value.taskId, bindingId: value.bindingId },
	});
	await ledger.appendFact("model_profile_revision", value.modelProfileRevision.id, modelProfile(), {
		clientRequestId: `workflow-seed:model:${value.taskId}`,
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
			{ schemaVersion: 1, type: reference.type, id: reference.id, revision: reference.revision },
			{
				clientRequestId: `workflow-seed:${objectType}:${value.taskId}`,
				expectedRevision: 0,
				correlation: { taskId: value.taskId, bindingId: value.bindingId },
			},
		);
	}
	await ledger.release();
}

class ScriptedTaskExecutor implements TaskExecutorProvider {
	readonly schemaVersion = 1 as const;
	readonly providerId: string;
	readonly providerClass: "task_executor" | "external_connector";
	failuresRemaining = 0;
	nextSideEffect: SideEffectState = "none";
	runCount = 0;
	resumeCount = 0;
	cancelCount = 0;
	readonly queueEntryIds: string[] = [];
	private blockNextRun = false;
	private blockedRun: Promise<void> | undefined;
	private signalBlockedRun: (() => void) | undefined;
	private releaseBlockedRun: (() => void) | undefined;
	private readonly cancelledAttemptIds = new Set<string>();

	blockNextAttempt(): Promise<void> {
		if (this.blockNextRun || this.blockedRun !== undefined) {
			throw new Error("A workflow attempt is already blocked");
		}
		this.blockNextRun = true;
		const started = new Promise<void>((resolve) => {
			this.signalBlockedRun = resolve;
		});
		this.blockedRun = new Promise<void>((resolve) => {
			this.releaseBlockedRun = resolve;
		});
		return started;
	}

	releaseBlockedAttempt(): void {
		const release = this.releaseBlockedRun;
		this.blockedRun = undefined;
		this.signalBlockedRun = undefined;
		this.releaseBlockedRun = undefined;
		release?.();
	}

	constructor(providerClass: "task_executor" | "external_connector" = "task_executor") {
		this.providerClass = providerClass;
		this.providerId = `${providerClass}_scheduler_workflow`;
	}

	async capabilities(): Promise<readonly FoundationProviderCapability[]> {
		return [CAPABILITY];
	}

	async createAttempt(dispatch: Dispatch, _binding: AgentBinding, context?: TaskExecutorAttemptContext) {
		if (context === undefined) {
			return Result.err(new FoundationError("invalid_correlation", "Attempt context required"));
		}
		return createAttempt({
			attemptId: context.initialBindingEpoch.attemptId,
			dispatch,
			providerId: this.providerId,
			initialBindingEpoch: context.initialBindingEpoch,
			providerClass: this.providerClass,
			now: () => T0,
		});
	}

	async runAttempt(attempt: Attempt, options?: FoundationProviderExecutionOptions) {
		this.runCount += 1;
		this.queueEntryIds.push(attempt.dispatchId);
		if (this.blockNextRun) {
			this.blockNextRun = false;
			const blockedRun = this.blockedRun;
			this.signalBlockedRun?.();
			if (blockedRun === undefined) throw new Error("Blocked workflow attempt has no release signal");
			await blockedRun;
		}
		const cancelled = this.cancelledAttemptIds.has(attempt.attemptId);
		const fail = !cancelled && this.failuresRemaining > 0;
		if (fail) this.failuresRemaining -= 1;
		const status = cancelled ? "cancelled" : fail ? "failed" : "succeeded";
		const sideEffectState = fail ? this.nextSideEffect : "none";
		const correlation = options?.correlation;
		if (correlation === undefined) {
			return Result.err(new FoundationError("invalid_correlation", "Provider correlation is required"));
		}
		const attemptReceiptId = `attempt_receipt_${attempt.attemptId}`;
		const receipt: AttemptReceipt = {
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
				producerKind: this.providerClass === "external_connector" ? "external_connector" : "scheduler",
				providerId: attempt.providerId,
				producedAt: T0,
				correlation: { ...correlation, attemptReceiptId },
			},
			sideEffectState,
			...(status === "succeeded"
				? {}
				: {
						error: {
							code: cancelled
								? "cancelled"
								: sideEffectState === "side_effect_unknown"
									? "side_effect_unknown"
									: "worker_lost",
							message: cancelled ? "Workflow attempt cancelled" : "Injected workflow executor failure",
							retryable: !cancelled && sideEffectState !== "side_effect_unknown",
						},
					}),
		};
		return validateAttemptReceiptForProvider(receipt, {
			providerId: this.providerId,
			providerClass: this.providerClass,
		});
	}

	async resumeAttempt(
		_attemptId: string,
		_options: FoundationProviderExecutionOptions,
	): Promise<ResultValue<AttemptReceipt, FoundationError>> {
		this.resumeCount += 1;
		return Result.err(new FoundationError("scheduler_attempt_recovery_failed", "Implicit replay is forbidden"));
	}

	async cancelAttempt(attemptId: string) {
		this.cancelCount += 1;
		this.cancelledAttemptIds.add(attemptId);
		return Result.ok(undefined);
	}

	async dispose(): Promise<void> {}
}

interface WorkflowHarness {
	readonly sourceSessionId: string;
	readonly targetSessionId: string;
	readonly sourceSession: Session;
	readonly targetSession: Session;
	readonly targetManager: SessionManager;
	readonly sourceGraph: TaskGraphStore;
	readonly targetGraph: TaskGraphStore;
	readonly targetRuns: RunLifecycleCoordinator;
	readonly store: WorkflowStore;
	readonly controller: SchedulerWorkflowController;
	readonly provider: ScriptedTaskExecutor;
	readonly task: TaskEnvelope;
	readonly selectionStore?: SchedulerSelectionReservationStore;
	readonly now: () => string;
	setNow: (iso: string) => void;
}

function graphStore(manager: SessionManager, runs: RunLifecycleCoordinator, now: () => string): TaskGraphStore {
	return createTaskGraphStore(
		manager,
		{
			get: (runId) => {
				const result = runs.getRun(runId);
				if (result === undefined) return undefined;
				return {
					sessionId: result.record.sessionId,
					runId: result.record.id,
					status: result.record.status,
					...(result.receipt === undefined ? {} : { receiptStatus: result.receipt.status }),
				};
			},
		},
		{ getByBusinessKey: () => undefined },
		{ now },
	);
}

async function createHarness(
	options: {
		readonly enabled?: boolean;
		readonly compensationPolicy?: SchedulerWorkflowCompensationPolicyV1;
		readonly maxAttempts?: number;
		readonly executorOwnerId?: string;
		readonly providerClass?: "task_executor" | "external_connector";
		readonly connectorRetry?: SchedulerWorkflowConnectorRetryOptionsV1;
		readonly clock?: RuntimeClock;
		readonly durableSelections?: boolean;
	} = {},
): Promise<WorkflowHarness> {
	harnessOrdinal += 1;
	const sourceSessionId = `session_source_${harnessOrdinal}`;
	const targetSessionId = `session_target_${harnessOrdinal}`;
	let nowIso = T0;
	const now = () => options.clock === undefined ? nowIso : new Date(options.clock.wallNow()).toISOString();
	const task = taskEnvelope(`task_workflow_${harnessOrdinal}`, `goal_workflow_${harnessOrdinal}`);
	const binding = bindingFor(task);
	const sourceSession = new Session(new InMemorySessionStorage({ id: sourceSessionId, createdAt: 1 }));
	const targetSession = new Session(new InMemorySessionStorage({ id: targetSessionId, createdAt: 1 }));
	await seedBindingFacts(sourceSession, task, binding);
	const sourceManager = SessionManager.inMemory("C:/workspace/source", { id: sourceSessionId });
	const targetManager = SessionManager.inMemory("C:/workspace/target", { id: targetSessionId });
	const sourceRuns = createRunLifecycleCoordinator(sourceManager, { diagnostics: () => {}, now });
	const targetRuns = createRunLifecycleCoordinator(targetManager, { diagnostics: () => {}, now });
	const sourceGraph = graphStore(sourceManager, sourceRuns, now);
	const targetGraph = graphStore(targetManager, targetRuns, now);
	const provider = new ScriptedTaskExecutor(options.providerClass);
	const selectionStore = options.durableSelections === true
		? new SchedulerSelectionReservationStore(sourceSession, { ownerId: OWNER_ID, now })
		: undefined;
	const registry = new SchedulerExecutorRegistry(
		selectionStore === undefined ? {} : { reservationStore: selectionStore },
	);
	const registered = await registry.register({
		entry: {
			schemaVersion: 1,
			descriptor: { schemaVersion: 1, providerId: provider.providerId, providerClass: provider.providerClass },
			capabilities: [CAPABILITY],
			costClass: "local",
			registeredAt: T0,
		},
		provider,
		trusted: true,
		latencyMs: 0,
		...(selectionStore === undefined
			? {}
			: { maxConcurrency: 1, runtimeSnapshot: runtimeSnapshot(provider.providerId, binding) }),
	});
	if (!registered.ok) throw registered.error;
	const controllerOptions = {
		enabled: options.enabled,
		sourceSession,
		targetSession,
		sourceSessionId,
		targetSessionId,
		sourceGraph,
		targetGraph,
		ownerId: OWNER_ID,
		registry,
		task,
		binding,
		now,
		...(options.executorOwnerId === undefined ? {} : { executorOwnerId: options.executorOwnerId }),
		...(options.compensationPolicy === undefined ? {} : { compensationPolicy: options.compensationPolicy }),
		...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
		...(options.connectorRetry === undefined ? {} : { connectorRetry: options.connectorRetry }),
	};
	const controller = new SchedulerWorkflowController(
		options.clock === undefined ? controllerOptions : withRuntimeClock(controllerOptions, options.clock),
	);
	return {
		sourceSessionId,
		targetSessionId,
		sourceSession,
		targetSession,
		targetManager,
		sourceGraph,
		targetGraph,
		targetRuns,
		store: controller.store,
		controller,
		provider,
		task,
		...(selectionStore === undefined ? {} : { selectionStore }),
		now,
		setNow(iso) {
			nowIso = iso;
		},
	};
}

async function reopenController(
	harness: WorkflowHarness,
	options: {
		readonly compensationPolicy?: SchedulerWorkflowCompensationPolicyV1;
		readonly maxAttempts?: number;
		readonly connectorRetry?: SchedulerWorkflowConnectorRetryOptionsV1;
		readonly clock?: RuntimeClock;
	} = {},
): Promise<SchedulerWorkflowController> {
	const registry = new SchedulerExecutorRegistry();
	const registered = await registry.register({
		entry: {
			schemaVersion: 1,
			descriptor: {
				schemaVersion: 1,
				providerId: harness.provider.providerId,
				providerClass: harness.provider.providerClass,
			},
			capabilities: [CAPABILITY],
			costClass: "local",
			registeredAt: T0,
		},
		provider: harness.provider,
		trusted: true,
		latencyMs: 0,
	});
	if (!registered.ok) throw registered.error;
	const controllerOptions = {
		enabled: true,
		sourceSession: harness.sourceSession,
		targetSession: harness.targetSession,
		sourceSessionId: harness.sourceSessionId,
		targetSessionId: harness.targetSessionId,
		sourceGraph: harness.sourceGraph,
		targetGraph: harness.targetGraph,
		ownerId: OWNER_ID,
		registry,
		task: harness.task,
		binding: bindingFor(harness.task),
		now: harness.now,
		...(options.compensationPolicy === undefined ? {} : { compensationPolicy: options.compensationPolicy }),
		...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
		...(options.connectorRetry === undefined ? {} : { connectorRetry: options.connectorRetry }),
	};
	return new SchedulerWorkflowController(
		options.clock === undefined ? controllerOptions : withRuntimeClock(controllerOptions, options.clock),
	);
}

async function createActiveWorkflow(
	harness: WorkflowHarness,
	steps: readonly WorkflowStep[],
	workflowId: string,
	budget?: TaskEnvelope["budget"],
) {
	const created = await harness.store.create(
		{
			sessionId: harness.sourceSessionId,
			workflowId,
			goalId: harness.task.goalId,
			steps,
			...(budget === undefined ? {} : { budget }),
		},
		{ clientRequestId: `create_${workflowId}`, expectedRevision: 0 },
	);
	return harness.store.activate(created.workflowId, {
		clientRequestId: `activate_${workflowId}`,
		expectedRevision: created.revision,
	});
}

async function settleTargetNode(
	graph: TaskGraphStore,
	runs: RunLifecycleCoordinator,
	manager: SessionManager,
	input: { readonly taskId: string; readonly nodeId: string; readonly runId: string },
): Promise<void> {
	const run = runs.reserve().accept({
		runId: input.runId,
		attempt: 1,
		model: RUN_MODEL,
	});
	graph.attach({
		taskId: input.taskId,
		graphRevision: 1,
		nodeId: input.nodeId,
		runId: input.runId,
		clientRequestId: `attach-${input.runId}`,
	});
	run.start();
	await observeCanonicalTerminal(manager, run, { outcome: "completed" });
	graph.settle({
		taskId: input.taskId,
		graphRevision: 1,
		nodeId: input.nodeId,
		clientRequestId: `settle-${input.runId}`,
	});
}

async function seedTargetTaskResult(
	session: Session,
	sessionId: string,
	input: { readonly taskResultId: string; readonly taskId: string },
): Promise<{
	readonly schemaVersion: 1;
	readonly type: "task_result";
	readonly sessionId: string;
	readonly id: string;
	readonly revision: number;
}> {
	const result: TaskResult = {
		schemaVersion: 1,
		taskResultId: input.taskResultId,
		taskId: input.taskId,
		sourceAttemptReceiptIds: ["attempt_receipt_external"],
		status: "succeeded",
		summary: "Target Session settled the external Agent",
		artifacts: [],
		tests: [],
		evidence: [],
		provenance: {
			producerKind: "host",
			providerId: "host-gate",
			producedAt: T0,
			correlation: {
				sessionId,
				laneId: "main",
				taskId: input.taskId,
				taskResultId: input.taskResultId,
				revision: 0,
			},
		},
		validation: {
			schemaValid: true,
			artifactDigestsValid: true,
			acceptanceVerified: true,
			requiredEvidencePresent: true,
		},
	};
	const ledger = new SessionLedger(session, { ownerId: OWNER_ID });
	const stored = await ledger.appendFact("task_result", input.taskResultId, result, {
		clientRequestId: `seed-task-result-${input.taskResultId}`,
		expectedRevision: 0,
		correlation: { taskId: input.taskId, taskResultId: input.taskResultId },
	});
	await ledger.release();
	return {
		schemaVersion: 1,
		type: "task_result",
		sessionId,
		id: input.taskResultId,
		revision: stored.record.revision,
	};
}

async function completeExternal(
	harness: WorkflowHarness,
	workflowId: string,
	step: WorkflowStep,
	messages: SchedulerMessageOrchestrator = harness.controller.messages,
): Promise<void> {
	if (step.type !== "agent") throw new Error("expected agent step");
	const ids = schedulerWorkflowExternalIds(workflowId, step.stepId);
	await settleTargetNode(harness.targetGraph, harness.targetRuns, harness.targetManager, {
		taskId: step.taskId,
		nodeId: step.stepId,
		runId: `run_${step.stepId}`,
	});
	const reference = await seedTargetTaskResult(harness.targetSession, harness.targetSessionId, {
		taskResultId: `task_result_${step.stepId}`,
		taskId: step.taskId,
	});
	await messages.publishResultReady({
		ownerSessionId: harness.targetSessionId,
		consumerSessionId: harness.sourceSessionId,
		taskId: step.taskId,
		threadId: ids.threadId,
		messageId: ids.readyMessageId,
		createdAt: harness.now(),
		expiresAt: "2026-08-22T13:00:00.000Z",
		reference,
	});
}

describe("scheduler T7 production Workflow controller", () => {
	it("is default-off and does not schedule, dispatch, or fire wakes", async () => {
		const harness = await createHarness();
		expect(harness.controller.enabled).toBe(false);
		expect(harness.controller.messages).toBeInstanceOf(SchedulerMessageOrchestrator);
		expect(harness.controller.handoff).toBeInstanceOf(SchedulerHandoffController);
		expect(harness.controller.dispatch).toBeInstanceOf(SchedulerDispatchController);
		expect(harness.controller.fanIn).toBeInstanceOf(SchedulerFanInController);
		expect(harness.controller.host).toBeInstanceOf(SchedulerHost);
		const dispatch = vi.spyOn(harness.controller.dispatch, "dispatchClaimed");
		const fanIn = vi.spyOn(harness.controller.fanIn, "settle");
		const submit = vi.spyOn(harness.controller.messages, "submitCrossSessionTask");
		const workflow = await createActiveWorkflow(harness, [toolStep("tool1", 0)], "workflow_off");
		const ticked = await harness.controller.tick();
		expect(ticked).toMatchObject({ enabled: false, scheduled: 0, completed: 0, wakesFired: 0 });
		expect(await harness.controller.hostTick()).toMatchObject({ enabled: false, dispatched: 0, settled: 0 });
		expect((await harness.store.get(workflow.workflowId)).steps[0]?.status).toBe("pending");
		expect(dispatch).not.toHaveBeenCalled();
		expect(fanIn).not.toHaveBeenCalled();
		expect(submit).not.toHaveBeenCalled();
		expect(harness.provider.runCount).toBe(0);
		await harness.controller.dispose();
	});

	it("dispatches a local step through the durable registry with exact binding requirements", async () => {
		const harness = await createHarness({ enabled: true, durableSelections: true });
		const step = { ...toolStep("durable-tool", 0), status: "running" as const };
		const workflow: Workflow = {
			schemaVersion: 1,
			dslVersion: 1,
			sessionId: harness.sourceSessionId,
			workflowId: "workflow-durable-direct",
			revision: 1,
			status: "active",
			goalId: harness.task.goalId,
			steps: [step],
			createdAt: T0,
			updatedAt: T0,
		};
		const transition = vi.spyOn(harness.store, "transitionStep").mockResolvedValue({
			...workflow,
			revision: 2,
			steps: [{ ...step, status: "succeeded", revision: 2 }],
		});
		const dispatched = vi.spyOn(harness.controller.dispatch, "dispatchClaimed");
		const result = await (harness.controller as unknown as {
			executeLocal(
				workflow: Workflow,
				step: WorkflowStep,
			): Promise<ResultValue<{ readonly progressed: boolean; readonly scheduled: boolean }, FoundationError>>;
		}).executeLocal(workflow, step);

		expect(result).toMatchObject({ ok: true, value: { progressed: true } });
		expect(dispatched).toHaveBeenCalledWith(expect.objectContaining({
			binding: expect.objectContaining({ bindingId: "binding_workflow" }),
			executorRequirements: { requireResume: true, modelAccess: "aos_gateway" },
		}));
		expect(harness.provider.runCount).toBe(1);
		expect(transition).toHaveBeenCalledWith(
			workflow.workflowId,
			{ stepId: step.stepId, status: "succeeded" },
			expect.objectContaining({ expectedRevision: workflow.revision }),
		);
		await harness.controller.dispose();
		await harness.selectionStore?.release();
	});

	it("schedules local agent and tool steps in dependency order through dispatch and fan-in", async () => {
		const harness = await createHarness({ enabled: true });
		const dispatch = vi.spyOn(harness.controller.dispatch, "dispatchClaimed");
		const fanIn = vi.spyOn(harness.controller.fanIn, "settle");
		const workflow = await createActiveWorkflow(
			harness,
			[
				agentStep("local_agent", 0, "local", harness.task.taskId),
				toolStep("tool1", 1, ["local_agent"]),
			],
			"workflow_agent_tool",
		);
		const ticked = await harness.controller.tick();
		expect(ticked.enabled).toBe(true);
		expect(ticked.completed).toBe(1);
		expect(ticked.errors).toEqual([]);
		const done = await harness.store.get(workflow.workflowId);
		expect(done.status).toBe("completed");
		expect(done.steps.map((step) => [step.stepId, step.status])).toEqual([
			["local_agent", "succeeded"],
			["tool1", "succeeded"],
		]);
		expect(dispatch).toHaveBeenCalled();
		expect(fanIn).toHaveBeenCalled();
		expect(harness.provider.runCount).toBe(2);
		expect(harness.provider.resumeCount).toBe(0);
		await harness.controller.dispose();
	});

	it("joins parallel children then a barrier through the Host fan-in settlement path", async () => {
		const harness = await createHarness({ enabled: true });
		const fanIn = vi.spyOn(harness.controller.fanIn, "settle");
		const workflow = await createActiveWorkflow(
			harness,
			[
				toolStep("left", 0),
				toolStep("right", 1),
				parallelStep(
					"join",
					2,
					[
						{ stepId: "left", executor: "local" },
						{ stepId: "right", executor: "local" },
					],
					["left", "right"],
				),
				barrierStep("barrier", 3, ["join"]),
			],
			"workflow_parallel",
		);
		const ticked = await harness.controller.tick();
		expect(ticked.completed).toBe(1);
		const done = await harness.store.get(workflow.workflowId);
		expect(done.status).toBe("completed");
		expect(done.steps.map((step) => step.status)).toEqual(["succeeded", "succeeded", "succeeded", "succeeded"]);
		expect(fanIn.mock.calls.length).toBeGreaterThanOrEqual(3);
		await harness.controller.dispose();
	});

	it("keeps external Agent steps at awaiting_dispatch, submits to the target Session, then reclaims", async () => {
		const harness = await createHarness({ enabled: true });
		const submit = vi.spyOn(harness.controller.messages, "submitCrossSessionTask");
		const wait = vi.spyOn(harness.controller.messages, "waitForCrossSessionTask");
		const reclaim = vi.spyOn(harness.controller.messages, "reclaimResult");
		const step = agentStep("external_agent", 0, "external", harness.task.taskId);
		const workflow = await createActiveWorkflow(harness, [step], "workflow_external");
		const first = await harness.controller.tick();
		expect(first.completed).toBe(0);
		const waiting = await harness.store.get(workflow.workflowId);
		expect(waiting.status).toBe("active");
		expect(waiting.steps[0]?.status).toBe("awaiting_dispatch");
		expect(submit).toHaveBeenCalledTimes(1);
		expect(harness.sourceGraph.get(harness.task.taskId, 1)).toBeUndefined();
		expect(harness.targetGraph.get(harness.task.taskId, 1)?.nodes[0]?.status).toBe("pending");
		expect(harness.provider.runCount).toBe(0);
		await completeExternal(harness, workflow.workflowId, step);
		const second = await harness.controller.tick();
		expect(second.completed).toBe(1);
		expect(wait).toHaveBeenCalled();
		expect(reclaim).toHaveBeenCalled();
		expect((await harness.store.get(workflow.workflowId)).status).toBe("completed");
		expect(
			await harness.sourceSession.findFoundationRecords({
				kind: "fact",
				objectType: SCHEDULER_WORKFLOW_EXTERNAL_OBJECT_TYPE,
			}),
		).toHaveLength(1);
		await harness.controller.dispose();
	});

	it("recovers a paused Workflow to completion without restarting it automatically", async () => {
		const harness = await createHarness({ enabled: true });
		const workflow = await createActiveWorkflow(harness, [toolStep("tool1", 0)], "workflow_paused");
		const paused = await harness.store.pause(workflow.workflowId, {
			clientRequestId: "pause_1",
			expectedRevision: workflow.revision,
		});
		expect(paused.status).toBe("paused");
		await harness.controller.dispose();
		const recovered = await reopenController(harness);
		const idle = await recovered.tick();
		expect(idle.completed).toBe(0);
		expect((await recovered.store.get(workflow.workflowId)).status).toBe("paused");
		expect((await recovered.store.get(workflow.workflowId)).steps[0]?.status).toBe("pending");
		await recovered.store.resume(workflow.workflowId, {
			clientRequestId: "resume_1",
			expectedRevision: paused.revision,
		});
		const finished = await recovered.tick();
		expect(finished.completed).toBe(1);
		expect((await recovered.store.get(workflow.workflowId)).status).toBe("completed");
		await recovered.dispose();
	});

	it("reloads awaiting_dispatch and reclaims through the production message chain to completion", async () => {
		const harness = await createHarness({ enabled: true });
		const step = agentStep("external_agent", 0, "external", harness.task.taskId);
		const workflow = await createActiveWorkflow(harness, [step], "workflow_external_recovery");
		await harness.controller.tick();
		expect((await harness.store.get(workflow.workflowId)).steps[0]?.status).toBe("awaiting_dispatch");
		await harness.controller.dispose();
		const recovered = await reopenController(harness);
		expect((await recovered.store.get(workflow.workflowId)).steps[0]?.status).toBe("awaiting_dispatch");
		await completeExternal(harness, workflow.workflowId, step, recovered.messages);
		const reclaim = vi.spyOn(recovered.messages, "reclaimResult");
		const finished = await recovered.tick();
		expect(finished.completed).toBe(1);
		expect(reclaim).toHaveBeenCalled();
		expect((await recovered.store.get(workflow.workflowId)).status).toBe("completed");
		await recovered.dispose();
	});

	it("cancels an expired dispatched Attempt after reopen and does not double-settle on replay", async () => {
		const harness = await createHarness({ enabled: true });
		const started = harness.provider.blockNextAttempt();
		const workflow = await createActiveWorkflow(
			harness,
			[toolStep("tool1", 0)],
			"workflow_dispatch_recovery",
		);
		const interruptedTick = harness.controller.tick();
		await started;
		const beforeRestart = await harness.controller.queue.snapshot();
		expect(beforeRestart.ok).toBe(true);
		if (!beforeRestart.ok) throw beforeRestart.error;
		const expiredEntry = beforeRestart.value.entries.find((entry) => entry.state === "dispatched");
		const expiredDispatch = beforeRestart.value.dispatches.find((dispatch) => dispatch.status === "in_flight");
		expect(expiredEntry).toBeDefined();
		expect(expiredDispatch).toBeDefined();
		if (expiredEntry === undefined || expiredDispatch === undefined) {
			throw new Error("Expected a durable in-flight workflow dispatch before reopen");
		}

		await harness.controller.dispose();
		harness.setNow(T_EXPIRED);
		const reopened = await reopenController(harness);
		try {
			const recovered = await reopened.queue.recoverExpired();
			expect(recovered.ok).toBe(true);
			if (!recovered.ok) return;
			expect(recovered.value).toHaveLength(1);
			expect(recovered.value[0]).toMatchObject({
				action: "requeued",
				cancelledAttemptId: expiredDispatch.attemptId,
				entry: { queueEntryId: expiredEntry.queueEntryId, state: "queued", attemptsUsed: 1 },
			});
			expect(harness.provider.cancelCount).toBe(1);

			const replayed = await reopened.queue.recoverExpired();
			expect(replayed.ok).toBe(true);
			if (!replayed.ok) return;
			expect(replayed.value).toEqual([]);
			expect(harness.provider.cancelCount).toBe(1);

			const progressed = await reopened.tick();
			expect(progressed).toMatchObject({ completed: 1, stopped: 0, errors: [] });
			expect(harness.provider.runCount).toBe(2);
			expect((await reopened.store.get(workflow.workflowId)).status).toBe("completed");
			const taskResultsBeforeStaleCompletion = await harness.sourceSession.findFoundationRecords({
				kind: "fact",
				objectType: "task_result",
			});
			expect(taskResultsBeforeStaleCompletion).toHaveLength(1);

			harness.provider.releaseBlockedAttempt();
			await interruptedTick.catch(() => undefined);
			const taskResultsAfterStaleCompletion = await harness.sourceSession.findFoundationRecords({
				kind: "fact",
				objectType: "task_result",
			});
			expect(taskResultsAfterStaleCompletion).toHaveLength(taskResultsBeforeStaleCompletion.length);
			expect((await reopened.store.get(workflow.workflowId)).status).toBe("completed");
			const finalQueue = await reopened.queue.snapshot();
			expect(finalQueue.ok).toBe(true);
			if (!finalQueue.ok) return;
			expect(
				finalQueue.value.dispatches.find((dispatch) => dispatch.dispatchId === expiredDispatch.dispatchId)?.status,
			).toBe("expired");
			expect(finalQueue.value.dispatches.filter((dispatch) => dispatch.status === "settled")).toHaveLength(1);
		} finally {
			harness.provider.releaseBlockedAttempt();
			await interruptedTick.catch(() => undefined);
			await reopened.dispose();
		}
	});

	it("fires a due wake on the due boundary, reloads, fires overdue wakes immediately, and is idempotent", async () => {
		const harness = await createHarness({ enabled: true });
		const workflow = await createActiveWorkflow(harness, [toolStep("tool1", 0)], "workflow_wake");
		const paused = await harness.store.pause(workflow.workflowId, {
			clientRequestId: "pause_wake",
			expectedRevision: workflow.revision,
		});
		const wake: SchedulerWakeV1 = {
			schemaVersion: 1,
			wakeId: "wake_due",
			workflowId: workflow.workflowId,
			stepId: "tool1",
			dueAt: T1,
			revision: 0,
		};
		const scheduled = await harness.controller.scheduleWake(wake);
		expect(scheduled.ok).toBe(true);
		const beforeDue = await harness.controller.tick();
		expect(beforeDue.wakesFired).toBe(0);
		expect((await harness.store.get(workflow.workflowId)).status).toBe("paused");
		await harness.controller.dispose();
		const reloaded = await reopenController(harness);
		const loaded = await reloaded.reload();
		expect(loaded.ok).toBe(true);
		if (loaded.ok) {
			expect(loaded.value).toHaveLength(1);
			expect(loaded.value[0]?.firedAt).toBeUndefined();
		}
		harness.setNow(T1);
		const due = await reloaded.tick();
		expect(due.wakesFired).toBe(1);
		expect(due.completed).toBe(1);
		const after = await reloaded.reload();
		expect(after.ok).toBe(true);
		if (after.ok) expect(after.value[0]?.firedAt).toBe(T1);
		const again = await reloaded.tick();
		expect(again.wakesFired).toBe(0);
		harness.setNow(T2);
		const overdueWake: SchedulerWakeV1 = {
			schemaVersion: 1,
			wakeId: "wake_overdue",
			workflowId: (await reloaded.store.get(workflow.workflowId)).workflowId,
			dueAt: T1,
			revision: 0,
		};
		const overdue = await reloaded.scheduleWake(overdueWake);
		expect(overdue.ok).toBe(true);
		if (overdue.ok) expect(overdue.value.firedAt).toBe(T2);
		const dueWake = await harness.sourceSession.getFoundationObject(SCHEDULER_WORKFLOW_WAKE_OBJECT_TYPE, "wake_due");
		expect(dueWake).toMatchObject({ payload: { firedAt: T1, wakeId: "wake_due" } });
		expect(paused.status).toBe("paused");
		await reloaded.dispose();
	});

	it("stops the Workflow on the stop compensation policy", async () => {
		const harness = await createHarness({ enabled: true, compensationPolicy: "stop" });
		harness.provider.failuresRemaining = 1;
		harness.provider.nextSideEffect = "none";
		const workflow = await createActiveWorkflow(harness, [toolStep("tool1", 0)], "workflow_stop");
		const ticked = await harness.controller.tick();
		expect(ticked.stopped).toBe(1);
		const stopped = await harness.store.get(workflow.workflowId);
		expect(stopped.status).toBe("stopped");
		expect(stopped.steps[0]?.status).toBe("cancelled");
		expect(harness.provider.runCount).toBe(1);
		await harness.controller.dispose();
	});

	it("retries with a durable attempt count and never implicitly replays a side-effecting attempt", async () => {
		const harness = await createHarness({
			enabled: true,
			compensationPolicy: "bounded_retry",
			maxAttempts: 2,
		});
		harness.provider.failuresRemaining = 1;
		harness.provider.nextSideEffect = "none";
		const dispatch = vi.spyOn(harness.controller.dispatch, "dispatchClaimed");
		const workflow = await createActiveWorkflow(harness, [toolStep("tool1", 0)], "workflow_retry");
		const ticked = await harness.controller.tick();
		expect(ticked.completed).toBe(1);
		expect(dispatch).toHaveBeenCalledTimes(2);
		expect(harness.provider.runCount).toBe(2);
		expect(harness.provider.resumeCount).toBe(0);
		expect(new Set(harness.provider.queueEntryIds).size).toBe(2);
		const attempt = await harness.sourceSession.getFoundationObject(
			SCHEDULER_WORKFLOW_ATTEMPT_OBJECT_TYPE,
			`${workflow.workflowId}:tool1`,
		);
		expect(attempt).toMatchObject({ payload: { attemptsUsed: 2, maxAttempts: 2 } });
		expect((await harness.store.get(workflow.workflowId)).status).toBe("completed");
		await harness.controller.dispose();
	});

	it("delays eligible connector retry across ticks and replays the durable deadline after restart", async () => {
		const clock = new DeterministicClock({ wallTimeMs: Date.parse(T0), monotonicTimeMs: 0 });
		const retryPolicy: ConnectorRetryPolicyV1 = {
			maxAttempts: 3,
			baseDelayMs: 100,
			maxDelayMs: 100,
			totalRetryTimeMs: 1_000,
			jitterPermille: 0,
			failureThreshold: 3,
			openDurationMs: 100,
			halfOpenProbeTimeoutMs: 100,
		};
		const connectorRetry: SchedulerWorkflowConnectorRetryOptionsV1 = {
			providerId: "external_connector_scheduler_workflow",
			targetId: "external_connector_scheduler_workflow",
			guarantee: "idempotent",
			policy: retryPolicy,
		};
		const harness = await createHarness({
			enabled: true,
			compensationPolicy: "bounded_retry",
			maxAttempts: 3,
			providerClass: "external_connector",
			connectorRetry,
			clock,
		});
		harness.provider.failuresRemaining = 1;
		harness.provider.nextSideEffect = "none";
		const workflow = await createActiveWorkflow(
			harness,
			[toolStep("tool1", 0)],
			"workflow_connector_retry",
		);

		const firstTick = await harness.controller.tick();
		expect(firstTick.errors).toEqual([]);
		expect(firstTick.completed).toBe(0);
		expect(harness.provider.runCount).toBe(1);
		const decisions = await harness.sourceSession.findFoundationRecords({
			objectType: CONNECTOR_RETRY_DECISION_OBJECT_TYPE,
			kind: "fact",
		});
		expect(decisions).toHaveLength(1);
		expect(decisions[0]).toMatchObject({
			payload: {
				decision: "retry",
				reasonCode: "eligible",
				attemptCount: 1,
				targetId: connectorRetry.targetId,
				delayMs: 100,
				nextEligibleAt: new Date(Date.parse(T0) + 100).toISOString(),
			},
		});
		expect((await harness.store.get(workflow.workflowId)).status).toBe("active");

		await harness.controller.dispose();
		const reopened = await reopenController(harness, {
			compensationPolicy: "bounded_retry",
			maxAttempts: 3,
			connectorRetry,
			clock,
		});
		const beforeDeadline = await reopened.tick();
		expect(beforeDeadline.completed).toBe(0);
		expect(harness.provider.runCount).toBe(1);
		clock.advanceBy(100);
		const afterDeadline = await reopened.tick();
		expect(afterDeadline.errors).toEqual([]);
		expect(afterDeadline.completed).toBe(1);
		expect(harness.provider.runCount).toBe(2);
		expect((await harness.store.get(workflow.workflowId)).status).toBe("completed");
		await reopened.dispose();
	});

	it("fails closed when an external connector operation has no explicit retry eligibility", async () => {
		const harness = await createHarness({
			enabled: true,
			compensationPolicy: "bounded_retry",
			maxAttempts: 3,
			providerClass: "external_connector",
		});
		harness.provider.failuresRemaining = 1;
		harness.provider.nextSideEffect = "none";
		const workflow = await createActiveWorkflow(
			harness,
			[toolStep("tool1", 0)],
			"workflow_connector_missing_eligibility",
		);

		const ticked = await harness.controller.tick();
		expect(ticked.stopped).toBe(1);
		expect(harness.provider.runCount).toBe(1);
		expect((await harness.store.get(workflow.workflowId)).status).toBe("stopped");
		const decisions = await harness.sourceSession.findFoundationRecords({
			objectType: CONNECTOR_RETRY_DECISION_OBJECT_TYPE,
			kind: "fact",
		});
		expect(decisions).toHaveLength(1);
		expect(decisions[0]).toMatchObject({
			payload: {
				decision: "stop",
				reasonCode: "missing_operation_eligibility",
				attemptCount: 1,
				targetId: harness.provider.providerId,
			},
		});
		await harness.controller.dispose();
	});

	it("schedules a compensation Task through the same production path", async () => {
		const harness = await createHarness({ enabled: true, compensationPolicy: "compensate" });
		harness.provider.failuresRemaining = 1;
		harness.provider.nextSideEffect = "none";
		const dispatch = vi.spyOn(harness.controller.dispatch, "dispatchClaimed");
		const fanIn = vi.spyOn(harness.controller.fanIn, "settle");
		const workflow = await createActiveWorkflow(harness, [toolStep("tool1", 0)], "workflow_compensate");
		const ticked = await harness.controller.tick();
		expect(ticked.completed).toBe(1);
		expect(dispatch.mock.calls.length).toBeGreaterThanOrEqual(2);
		expect(fanIn).toHaveBeenCalled();
		const done = await harness.store.get(workflow.workflowId);
		expect(done.status).toBe("completed");
		expect(done.steps[0]?.status).toBe("skipped");
		const compensation = await harness.sourceSession.getFoundationObject(
			SCHEDULER_WORKFLOW_COMPENSATION_OBJECT_TYPE,
			`${workflow.workflowId}:tool1`,
		);
		expect(compensation).toMatchObject({
			payload: {
				state: "settled",
				attempt: 2,
				nodeId: "compensate_tool1_r2",
				queueEntryId: expect.any(String),
			},
		});
		await harness.controller.dispose();
	});

	it("never auto-retries side_effect_unknown", async () => {
		const harness = await createHarness({
			enabled: true,
			compensationPolicy: "bounded_retry",
			maxAttempts: 3,
		});
		harness.provider.failuresRemaining = 1;
		harness.provider.nextSideEffect = "side_effect_unknown";
		const workflow = await createActiveWorkflow(harness, [toolStep("tool1", 0)], "workflow_unknown");
		const ticked = await harness.controller.tick();
		expect(ticked.stopped).toBe(1);
		expect(harness.provider.runCount).toBe(1);
		expect(harness.provider.resumeCount).toBe(0);
		expect((await harness.store.get(workflow.workflowId)).status).toBe("stopped");
		await harness.controller.dispose();
	});

	it("stops scheduling new work when WorkflowStore rejects budget exhaustion", async () => {
		const harness = await createHarness({ enabled: true });
		const workflow = await createActiveWorkflow(
			harness,
			[toolStep("first", 0), toolStep("second", 1, ["first"])],
			"workflow_budget",
			{ toolCalls: 1 },
		);
		const ticked = await harness.controller.tick();
		expect(ticked.errors.some((error) => error.code === "budget_exhausted")).toBe(true);
		const current = await harness.store.get(workflow.workflowId);
		expect(current.status).toBe("active");
		expect(current.steps.map((step) => [step.stepId, step.status])).toEqual([
			["first", "succeeded"],
			["second", "ready"],
		]);
		expect(current.budgetUsage).toEqual({ toolCalls: 1 });
		expect(harness.provider.runCount).toBe(1);
		const second = await harness.controller.tick();
		expect(second.errors.some((error) => error.code === "budget_exhausted")).toBe(true);
		expect(harness.provider.runCount).toBe(1);
		expect((await harness.store.get(workflow.workflowId)).steps.map((step) => [step.stepId, step.status])).toEqual([
			["first", "succeeded"],
			["second", "ready"],
		]);
		await harness.controller.dispose();
	});

	it("invokes the four production modules rather than type-referencing them", async () => {
		const harness = await createHarness({ enabled: true, executorOwnerId: EXECUTOR_OWNER_ID });
		const dispatch = vi.spyOn(harness.controller.dispatch, "dispatchClaimed");
		const fanIn = vi.spyOn(harness.controller.fanIn, "settle");
		const submit = vi.spyOn(harness.controller.messages, "submitCrossSessionTask");
		const offer = vi.spyOn(harness.controller.handoff, "offer");
		const accept = vi.spyOn(harness.controller.handoff, "accept");
		const external = agentStep("external_agent", 1, "external", harness.task.taskId, ["tool1"]);
		const workflow = await createActiveWorkflow(
			harness,
			[toolStep("tool1", 0), external],
			"workflow_modules",
		);
		await harness.controller.tick();
		expect(dispatch).toHaveBeenCalled();
		expect(fanIn).toHaveBeenCalled();
		expect(offer).toHaveBeenCalled();
		expect(accept).toHaveBeenCalled();
		expect(submit).toHaveBeenCalled();
		expect(harness.controller.messages).toBeInstanceOf(SchedulerMessageOrchestrator);
		expect(harness.controller.handoff).toBeInstanceOf(SchedulerHandoffController);
		expect(harness.controller.dispatch).toBeInstanceOf(SchedulerDispatchController);
		expect(harness.controller.fanIn).toBeInstanceOf(SchedulerFanInController);
		await completeExternal(harness, workflow.workflowId, external);
		const finished = await harness.controller.tick();
		expect(finished.completed).toBe(1);
		expect(
			await harness.sourceSession.findFoundationRecords({
				kind: "fact",
				objectType: SCHEDULER_WORKFLOW_POLICY_OBJECT_TYPE,
			}),
		).toHaveLength(1);
		await harness.controller.dispose();
	});

	it("stops after exactly one compensation attempt when original and compensation both fail", async () => {
		const harness = await createHarness({ enabled: true, compensationPolicy: "compensate", maxAttempts: 3 });
		harness.provider.failuresRemaining = 2;
		harness.provider.nextSideEffect = "none";
		const dispatch = vi.spyOn(harness.controller.dispatch, "dispatchClaimed");
		const workflow = await createActiveWorkflow(harness, [toolStep("tool1", 0)], "workflow_compensate_fail");
		const ticked = await harness.controller.tick();
		expect(ticked.stopped).toBe(1);
		expect(dispatch).toHaveBeenCalledTimes(2);
		expect(harness.provider.runCount).toBe(2);
		expect(harness.provider.resumeCount).toBe(0);
		const stopped = await harness.store.get(workflow.workflowId);
		expect(stopped.status).toBe("stopped");
		const compensation = await harness.sourceSession.getFoundationObject(
			SCHEDULER_WORKFLOW_COMPENSATION_OBJECT_TYPE,
			`${workflow.workflowId}:tool1`,
		);
		expect(compensation).toMatchObject({ payload: { state: "failed", attempt: 2 } });
		await harness.controller.dispose();
	});

	it("does not enqueue a new compensation attempt after crash reload", async () => {
		const harness = await createHarness({ enabled: true, compensationPolicy: "compensate" });
		harness.provider.failuresRemaining = 1;
		const workflow = await createActiveWorkflow(
			harness,
			[toolStep("tool1", 0), awaitUserStep("wait_user", 1, ["tool1"])],
			"workflow_compensate_reload",
		);
		const first = await harness.controller.tick();
		expect(first.completed).toBe(0);
		expect(harness.provider.runCount).toBe(2);
		const afterFirst = await harness.store.get(workflow.workflowId);
		expect(afterFirst.status).toBe("active");
		expect(afterFirst.steps.map((step) => [step.stepId, step.status])).toEqual([
			["tool1", "skipped"],
			["wait_user", "waiting_user"],
		]);
		const runsAfterFirst = harness.provider.runCount;
		await harness.controller.dispose();
		const recovered = await reopenController(harness, { compensationPolicy: "compensate", maxAttempts: 9 });
		const second = await recovered.tick();
		expect(second.completed).toBe(0);
		expect(harness.provider.runCount).toBe(runsAfterFirst);
		expect(harness.provider.resumeCount).toBe(0);
		expect((await recovered.store.get(workflow.workflowId)).steps.map((step) => [step.stepId, step.status])).toEqual([
			["tool1", "skipped"],
			["wait_user", "waiting_user"],
		]);
		await recovered.dispose();
	});

	it("fails closed on a scheduled compensation whose queue entry is missing", async () => {
		const harness = await createHarness({ enabled: true, compensationPolicy: "compensate" });
		const workflow = await createActiveWorkflow(harness, [toolStep("tool1", 0)], "workflow_compensate_missing");
		let current = await harness.store.transitionStep(
			workflow.workflowId,
			{ stepId: "tool1", status: "ready" },
			{ clientRequestId: "missing_ready", expectedRevision: workflow.revision },
		);
		current = await harness.store.transitionStep(
			workflow.workflowId,
			{ stepId: "tool1", status: "running" },
			{ clientRequestId: "missing_running", expectedRevision: current.revision },
		);
		expect(current.steps[0]?.status).toBe("running");
		const ledger = new SessionLedger(harness.sourceSession, { ownerId: OWNER_ID });
		await ledger.appendFact(
			SCHEDULER_WORKFLOW_COMPENSATION_OBJECT_TYPE,
			`${workflow.workflowId}:tool1`,
			{
				schemaVersion: 1,
				workflowId: workflow.workflowId,
				stepId: "tool1",
				queueEntryId: "q_missing_compensation",
				attempt: 2,
				nodeId: "compensate_tool1_r2",
				state: "scheduled",
				scheduledAt: T0,
			} satisfies SchedulerWorkflowCompensationFactV1,
			{
				clientRequestId: "seed-compensation-missing",
				expectedRevision: 0,
				correlation: { taskId: harness.task.taskId, parentId: workflow.workflowId, stepId: "tool1" },
			},
		);
		await ledger.release();
		expect((await harness.store.get(workflow.workflowId)).steps[0]?.status).toBe("running");
		const enqueue = vi.spyOn(harness.controller.queue, "enqueue");
		const dispatch = vi.spyOn(harness.controller.dispatch, "dispatchClaimed");
		await harness.controller.dispose();
		const recovered = await reopenController(harness, { compensationPolicy: "compensate", maxAttempts: 9 });
		const recoveredEnqueue = vi.spyOn(recovered.queue, "enqueue");
		const recoveredDispatch = vi.spyOn(recovered.dispatch, "dispatchClaimed");
		const ticked = await recovered.tick();
		expect(ticked.stopped).toBe(1);
		expect(harness.provider.runCount).toBe(0);
		expect(enqueue).not.toHaveBeenCalled();
		expect(dispatch).not.toHaveBeenCalled();
		expect(recoveredEnqueue).not.toHaveBeenCalled();
		expect(recoveredDispatch).not.toHaveBeenCalled();
		expect((await recovered.store.get(workflow.workflowId)).status).toBe("stopped");
		const compensation = await harness.sourceSession.getFoundationObject(
			SCHEDULER_WORKFLOW_COMPENSATION_OBJECT_TYPE,
			`${workflow.workflowId}:tool1`,
		);
		expect(compensation).toMatchObject({ payload: { state: "failed", queueEntryId: "q_missing_compensation" } });
		await recovered.dispose();
	});

	it("consumes the persisted Workflow policy on reopen instead of constructor defaults", async () => {
		const harness = await createHarness({ enabled: true, compensationPolicy: "stop", maxAttempts: 1 });
		const workflow = await createActiveWorkflow(harness, [toolStep("tool1", 0)], "workflow_policy_reload");
		await harness.controller.dispose();
		const ledger = new SessionLedger(harness.sourceSession, { ownerId: OWNER_ID });
		await ledger.appendFact(
			SCHEDULER_WORKFLOW_POLICY_OBJECT_TYPE,
			workflow.workflowId,
			{
				schemaVersion: 1,
				workflowId: workflow.workflowId,
				policy: "bounded_retry",
				maxAttempts: 2,
			} satisfies SchedulerWorkflowPolicyFactV1,
			{
				clientRequestId: "seed-policy-bounded",
				expectedRevision: 0,
				correlation: { taskId: harness.task.taskId, parentId: workflow.workflowId },
			},
		);
		await ledger.release();
		const recovered = await reopenController(harness, { compensationPolicy: "stop", maxAttempts: 99 });
		harness.provider.failuresRemaining = 1;
		harness.provider.nextSideEffect = "none";
		const ticked = await recovered.tick();
		expect(ticked.completed).toBe(1);
		expect(ticked.stopped).toBe(0);
		expect(harness.provider.runCount).toBe(2);
		const stored = await harness.sourceSession.getFoundationObject(
			SCHEDULER_WORKFLOW_POLICY_OBJECT_TYPE,
			workflow.workflowId,
		);
		expect(stored).toMatchObject({ payload: { policy: "bounded_retry", maxAttempts: 2 } });
		await recovered.dispose();
	});
});
