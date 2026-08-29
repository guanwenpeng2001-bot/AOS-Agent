import {
	type AgentBinding,
	type AgentInstance,
	type ArtifactRef,
	type Attempt,
	type AttemptReceipt,
	type BudgetUsage,
	type ConnectorCapabilitySnapshot,
	createAttempt,
	createBindingEpoch,
	createConnectorCapabilitySnapshot,
	createDurableEvent,
	createExecutionCorrelation,
	createRoleRevision,
	type Dispatch,
	executeDispatch,
	FoundationError,
	type FoundationProviderCapability,
	type FoundationProviderExecutionOptions,
	fingerprintFoundationValue,
	InMemorySessionStorage,
	type ModelProfile,
	type QuotaAttribution,
	type QuotaProvider,
	type QuotaReservation,
	Result,
	type ResultValue,
	type RevisionReference,
	resolveAgentBinding,
	resolveMcpSelection,
	type SchedulerSelectionEventPayload,
	type SchedulerTaskExecutorProvider,
	Session,
	type TaskEnvelope,
	type TaskExecutorAttemptContext,
	type TaskExecutorProvider,
	validateAttemptReceiptForProvider,
	validateDurableEvent,
	type WorkerReceiptRef,
} from "@aos-agent/agent-core";
import { describe, expect, it } from "vitest";
import { BUILTIN_CODING_AGENT_PROVIDER_ID } from "../src/core/product-prompt-ingress.ts";
import {
	parseSchedulerExecutorEntry,
	type SchedulerExecutorEntry,
	type SchedulerQueueEntry,
	schedulerErrorRetryable,
	serializeSchedulerSelectionFact,
} from "../src/core/scheduler/host.ts";
import {
	createSchedulerExecutorRuntimeSnapshot,
	executorPassesHardFilters,
	projectSchedulerSelectionFact,
	SCHEDULER_EXECUTOR_SCORE_AFFINITY_SESSION,
	SCHEDULER_EXECUTOR_SCORE_AFFINITY_WORKSPACE,
	SCHEDULER_EXECUTOR_SCORE_COST_LOCAL,
	SCHEDULER_EXECUTOR_SCORE_COST_REMOTE,
	SCHEDULER_EXECUTOR_SCORE_LATENCY_MAX,
	SCHEDULER_EXECUTOR_SCORE_LOAD_MAX,
	SCHEDULER_IN_PROCESS_CAPABILITY_ID,
	SCHEDULER_IN_PROCESS_PROVIDER_ID,
	SchedulerExecutorRegistry,
	type SchedulerExecutorRuntimeSnapshot,
	type SchedulerHostAttemptRunner,
	SchedulerInProcessTaskExecutorProvider,
	schedulerBindingRequirementDigest,
	schedulerQuotaOwnerKind,
	scoreSchedulerExecutor,
	selectSchedulerExecutor,
} from "../src/core/scheduler/executors.ts";
import { SchedulerSelectionReservationStore } from "../src/core/scheduler/selection-reservations.ts";

const NOW = "2026-08-21T12:00:00.000Z";
const TASK_CAPABILITY: FoundationProviderCapability = {
	schemaVersion: 1,
	id: SCHEDULER_IN_PROCESS_CAPABILITY_ID,
	version: 1,
};
const AGENT_CAPABILITY: FoundationProviderCapability = {
	schemaVersion: 1,
	id: "foundation.agent-executor",
	version: 1,
};
const WORKSPACE_DIGEST = fingerprintFoundationValue("workspace_sched_t3");
const HOST_ARTIFACT: ArtifactRef = {
	schemaVersion: 1,
	artifactId: "artifact_host_work",
	mediaType: "application/json",
	digest: `sha256:${"b".repeat(64)}`,
};
const HOST_WORKER_RECEIPT_REF: WorkerReceiptRef = {
	schemaVersion: 1,
	type: "worker_receipt",
	id: "worker_receipt_host_1",
	revision: 0,
};

type FakeKind = "in_process" | "agent" | "acp_sdk" | "external";
type FakeMode = "success" | "slow" | "cancel_ack" | "lost" | "invalid_receipt" | "resume_false" | "quota_reject";

const FAKE_KINDS: readonly FakeKind[] = ["in_process", "agent", "acp_sdk", "external"];
const FAKE_MODES: readonly FakeMode[] = [
	"success",
	"slow",
	"cancel_ack",
	"lost",
	"invalid_receipt",
	"resume_false",
	"quota_reject",
];

function expectCode(result: { ok: false; error: { code: string } } | { ok: true }, code: string): void {
	expect(result.ok).toBe(false);
	if (!result.ok) expect(result.error.code).toBe(code);
}

function hostAttemptReceipt(attempt: Attempt, options?: FoundationProviderExecutionOptions): AttemptReceipt {
	const attemptReceiptId = `attempt_receipt_${attempt.attemptId}`;
	const baseCorrelation = options?.correlation ?? correlation(attempt.attemptId);
	return {
		schemaVersion: 1,
		attemptReceiptId,
		taskId: attempt.taskId,
		dispatchId: attempt.dispatchId,
		attemptId: attempt.attemptId,
		providerId: attempt.providerId,
		bindingId: attempt.bindingId,
		bindingEpochIds: [...attempt.bindingEpochIds],
		status: "succeeded",
		workerReceiptRefs: [HOST_WORKER_RECEIPT_REF],
		artifacts: [HOST_ARTIFACT],
		provenance: {
			producerKind: "scheduler",
			providerId: attempt.providerId,
			producedAt: NOW,
			correlation: { ...baseCorrelation, attemptReceiptId },
		},
		sideEffectState: "none",
	};
}

function hostAttemptRunner(
	usage: BudgetUsage = { tokens: 3 },
	onRun?: (receipt: AttemptReceipt) => void,
	mutate?: (receipt: AttemptReceipt) => AttemptReceipt,
): SchedulerHostAttemptRunner {
	return async (attempt, options) => {
		const receipt =
			mutate === undefined ? hostAttemptReceipt(attempt, options) : mutate(hostAttemptReceipt(attempt, options));
		onRun?.(receipt);
		return Result.ok({ usage, receipt });
	};
}

function queueEntry(overrides: Partial<SchedulerQueueEntry> = {}): SchedulerQueueEntry {
	return {
		schemaVersion: 1,
		queueEntryId: "queue_1",
		sessionId: "session_a",
		taskId: "task_1",
		state: "queued",
		priority: 10,
		attemptsUsed: 0,
		enqueuedAt: NOW,
		revision: 0,
		...overrides,
	};
}

function executorEntry(
	providerId: string,
	providerClass: SchedulerExecutorEntry["descriptor"]["providerClass"],
	overrides: Partial<SchedulerExecutorEntry> = {},
): SchedulerExecutorEntry {
	return {
		schemaVersion: 1,
		descriptor: { schemaVersion: 1, providerId, providerClass },
		capabilities:
			providerClass === "task_executor" || providerClass === "scheduler" ? [TASK_CAPABILITY] : [AGENT_CAPABILITY],
		costClass: "local",
		registeredAt: NOW,
		...overrides,
	};
}

function immutableBindingFact(type: string, id: string): RevisionReference {
	const payload = { schemaVersion: 1 as const, type, id, revision: 1 };
	return { ...payload, fingerprint: fingerprintFoundationValue(payload) };
}

function taskEnvelope(): TaskEnvelope {
	return {
		schemaVersion: 1,
		taskId: "task_1",
		goalId: "goal_1",
		goal: "Run the in-process scheduler executor",
		workspace: "workspace_sched_t3",
		capabilityRefs: [],
		inputs: [],
		expectedOutputs: [],
		budget: {},
		acceptanceCriteria: [],
		status: "ready",
		createdAt: NOW,
		updatedAt: NOW,
	};
}

function roleRevision() {
	return createRoleRevision({
		definition: {
			schemaVersion: 1,
			roleId: "role_1",
			scope: "project",
			slug: "worker",
			name: "Worker",
			description: "Runs the task",
			revision: 1,
			persona: "You run the task.",
			modelProfileRef: { schemaVersion: 1, type: "model_profile", id: "profile_1", revision: 1 },
			capabilitySelector: { policy: "all" },
			skillSelector: { policy: "none" },
			mcpSelector: { policy: "none" },
		},
		now: () => NOW,
	});
}

function modelProfile(): ModelProfile {
	const base = {
		schemaVersion: 1 as const,
		modelProfileId: "profile_1",
		provider: "none",
		model: "none",
		budget: {},
		revision: 1,
		createdAt: NOW,
	};
	return { ...base, fingerprint: fingerprintFoundationValue(base) };
}

function binding(): AgentBinding {
	const resolved = resolveAgentBinding({
		task: taskEnvelope(),
		roleRevision: roleRevision(),
		modelProfile: modelProfile(),
		contextRevision: immutableBindingFact("external_agent_binding", "external_1"),
		capabilityRevision: immutableBindingFact("capability_binding", "capability_1"),
		modelBrokerBindingRevision: immutableBindingFact("model_broker_binding", "model_broker_1"),
		policyRevision: immutableBindingFact("policy_binding", "policy_1"),
		newBindingId: "binding_1",
		now: () => NOW,
	});
	if (!resolved.ok) throw resolved.error;
	return resolved.value;
}

function bindingWithTool(): AgentBinding {
	const role = createRoleRevision({
		definition: {
			schemaVersion: 1,
			roleId: "role_tools",
			scope: "project",
			slug: "tool-worker",
			name: "Tool worker",
			description: "Runs one exact tool",
			revision: 1,
			persona: "You run the task.",
			modelProfileRef: { schemaVersion: 1, type: "model_profile", id: "profile_1", revision: 1 },
			capabilitySelector: { policy: "all" },
			skillSelector: { policy: "none" },
			mcpSelector: { policy: "named", named: ["server"] },
		},
		now: () => NOW,
	});
	const mcpSelection = resolveMcpSelection({
		selector: role.mcpSelector,
		capabilityBinding: {
			id: "capability_1",
			descriptors: [
				{ id: "descriptor_server", revision: "1", kind: "mcp_server", name: "server", mcpServerId: "server" },
				{
					id: "descriptor_tool",
					revision: "1",
					kind: "mcp_tool",
					name: "read",
					exposedToolName: "mcp__server__read",
					parentId: "descriptor_server",
					mcpServerId: "server",
				},
			],
			toolAllowlist: ["mcp__server__read"],
		},
		routeCatalog: [{ kind: "mcp", namespace: "server", toolName: "read", providerId: "tool.gateway", revision: 1 }],
	});
	if (!mcpSelection.ok) throw mcpSelection.error;
	const resolved = resolveAgentBinding({
		task: taskEnvelope(),
		roleRevision: role,
		modelProfile: modelProfile(),
		contextRevision: immutableBindingFact("external_agent_binding", "external_1"),
		capabilityRevision: immutableBindingFact("capability_binding", "capability_1"),
		modelBrokerBindingRevision: immutableBindingFact("model_broker_binding", "model_broker_1"),
		policyRevision: immutableBindingFact("policy_binding", "policy_1"),
		mcpSelection: mcpSelection.value,
		newBindingId: "binding_tools",
		now: () => NOW,
	});
	if (!resolved.ok) throw resolved.error;
	return resolved.value;
}

function runtimeSnapshotFor(
	providerId: string,
	options: {
		readonly bindingValue?: AgentBinding;
		readonly revision?: number;
		readonly resume?: boolean;
		readonly modelAccess?: ConnectorCapabilitySnapshot["modelAccess"];
		readonly toolGateway?: boolean;
		readonly bindingRequirementDigests?: readonly ReturnType<typeof fingerprintFoundationValue>[];
		readonly toolSelectionDigests?: readonly ReturnType<typeof fingerprintFoundationValue>[];
		readonly policyRevisionDigests?: readonly ReturnType<typeof fingerprintFoundationValue>[];
		readonly reviewRevisionDigests?: readonly ReturnType<typeof fingerprintFoundationValue>[];
		readonly credentialTargetRefs?: readonly string[];
		readonly sandboxTargetRefs?: readonly string[];
		readonly configRevision?: ReturnType<typeof fingerprintFoundationValue>;
		readonly expiresAt?: string;
	} = {},
): SchedulerExecutorRuntimeSnapshot {
	const bindingValue = options.bindingValue ?? binding();
	const bindingDigest = schedulerBindingRequirementDigest(bindingValue);
	if (!bindingDigest.ok) throw bindingDigest.error;
	if (bindingValue.policyRevision.fingerprint === undefined) throw new Error("policy fingerprint missing");
	const capabilitySnapshot = createConnectorCapabilitySnapshot({
		schemaVersion: 1,
		providerId,
		revision: options.revision ?? 1,
		protocol: { name: "scheduler-test", version: "1" },
		modelAccess: options.modelAccess ?? "aos_gateway",
		resume: options.resume ?? true,
		toolGateway: options.toolGateway ?? true,
		artifacts: true,
		images: false,
	});
	const created = createSchedulerExecutorRuntimeSnapshot({
		schemaVersion: 1,
		capabilitySnapshot,
		configRevision: options.configRevision ?? fingerprintFoundationValue(`config:${providerId}:1`),
		bindingRequirementDigests: options.bindingRequirementDigests ?? [bindingDigest.value],
		toolSelectionDigests: options.toolSelectionDigests ?? [bindingValue.mcpSelection.digest],
		policyRevisionDigests: options.policyRevisionDigests ?? [bindingValue.policyRevision.fingerprint],
		reviewRevisionDigests: options.reviewRevisionDigests ?? [],
		credentialTargetRefs: options.credentialTargetRefs ?? ["credential:test"],
		sandboxTargetRefs: options.sandboxTargetRefs ?? ["sandbox:test"],
		observedAt: NOW,
		expiresAt: options.expiresAt ?? "2026-08-21T14:00:00.000Z",
	});
	if (!created.ok) throw created.error;
	return created.value;
}

function dispatchFor(providerId: string): Dispatch {
	return {
		schemaVersion: 1,
		dispatchId: "dispatch_1",
		taskId: "task_1",
		bindingId: "binding_1",
		taskExecutorProviderId: providerId,
		status: "pending",
		createdAt: NOW,
	};
}

function epoch(attemptId: string, agentInstanceId?: string) {
	const created = createBindingEpoch({
		bindingEpochId: "epoch_1",
		taskId: "task_1",
		attemptId,
		bindingId: "binding_1",
		activationReason: "attempt_started",
		activatedByCommandId: "command_1",
		now: () => NOW,
		...(agentInstanceId === undefined ? {} : { agentInstanceId }),
	});
	if (!created.ok) throw created.error;
	return created.value;
}

function correlation(attemptId: string, agentInstanceId?: string) {
	return createExecutionCorrelation("session_a", "main", {
		revision: 1,
		taskId: "task_1",
		dispatchId: "dispatch_1",
		attemptId,
		bindingId: "binding_1",
		bindingEpochId: "epoch_1",
		...(agentInstanceId === undefined ? {} : { agentInstanceId }),
	});
}

function providerClassOf(kind: FakeKind): TaskExecutorProvider["providerClass"] {
	if (kind === "in_process") return "task_executor";
	if (kind === "external") return "external_connector";
	return "agent";
}

function providerIdOf(kind: FakeKind): string {
	if (kind === "in_process") return "fake.in-process";
	if (kind === "agent") return "fake.agent";
	if (kind === "acp_sdk") return "fake.acp-sdk";
	return "fake.external";
}

function producerKindOf(kind: FakeKind): AttemptReceipt["provenance"]["producerKind"] {
	if (kind === "in_process") return "scheduler";
	if (kind === "external") return "external_connector";
	return "agent_executor";
}

function agentInstance(providerId: string): AgentInstance {
	return {
		schemaVersion: 1,
		agentInstanceId: "agent_instance_1",
		providerId,
		taskId: "task_1",
		roleRevision: { schemaVersion: 1, type: "role_revision", id: "role_revision_role_1_1", revision: 1 },
		bindingEpochIds: ["epoch_1"],
		status: "starting",
		lineage: { schemaVersion: 1, entityType: "agent_instance", entityId: "agent_instance_1", depth: 0 },
		createdAt: NOW,
		updatedAt: NOW,
	};
}

class ScriptedQuota implements QuotaProvider {
	readonly schemaVersion = 1 as const;
	readonly providerId = "quota.test";
	readonly providerClass = "quota" as const;
	lastAttribution: QuotaAttribution | undefined;
	lastUsage: BudgetUsage | undefined;
	reserveCount = 0;
	settleCount = 0;
	reject: boolean;
	constructor(reject = false) {
		this.reject = reject;
	}
	async capabilities(): Promise<readonly FoundationProviderCapability[]> {
		return [];
	}
	async reserve(attribution: QuotaAttribution, budget: QuotaReservation["budget"]) {
		this.reserveCount += 1;
		this.lastAttribution = attribution;
		if (this.reject) return Result.err(new FoundationError("quota_exceeded", "Quota exceeded"));
		return Result.ok({
			schemaVersion: 1 as const,
			reservationId: "reservation_1",
			attribution,
			budget,
			grantedAt: NOW,
		});
	}
	async settle(_reservation: QuotaReservation, usage: BudgetUsage) {
		this.settleCount += 1;
		this.lastUsage = usage;
		return Result.ok(usage);
	}
	async dispose(): Promise<void> {}
}

class SchedulerExecutorFake implements TaskExecutorProvider {
	readonly schemaVersion = 1 as const;
	readonly providerId: string;
	readonly providerClass: TaskExecutorProvider["providerClass"];
	readonly kind: FakeKind;
	readonly mode: FakeMode;
	readonly quota: ScriptedQuota;
	cancelAcked = false;
	slowReleased = false;
	runStarted = false;
	private readonly slowWaiters: Array<() => void> = [];
	private readonly cancelled = new Set<string>();

	constructor(kind: FakeKind, mode: FakeMode, quota = new ScriptedQuota(mode === "quota_reject")) {
		this.kind = kind;
		this.mode = mode;
		this.providerId = providerIdOf(kind);
		this.providerClass = providerClassOf(kind);
		this.quota = quota;
	}

	releaseSlow(): void {
		this.slowReleased = true;
		for (const resume of this.slowWaiters) resume();
		this.slowWaiters.length = 0;
	}

	async capabilities(): Promise<readonly FoundationProviderCapability[]> {
		return this.providerClass === "task_executor" ? [TASK_CAPABILITY] : [AGENT_CAPABILITY];
	}

	connectorSnapshot(): ConnectorCapabilitySnapshot {
		return createConnectorCapabilitySnapshot({
			schemaVersion: 1,
			providerId: this.providerId,
			revision: 1,
			protocol: { name: this.kind === "acp_sdk" ? "acp" : "external", version: "1" },
			modelAccess: "none",
			resume: this.mode !== "resume_false",
			toolGateway: false,
			artifacts: false,
			images: false,
		});
	}

	async probe() {
		return Result.ok(this.connectorSnapshot());
	}

	async createAttempt(dispatch: Dispatch, _binding: AgentBinding, context?: TaskExecutorAttemptContext) {
		if (context === undefined)
			return Result.err(new FoundationError("invalid_correlation", "fake requires attempt context"));
		if (this.providerClass === "agent") {
			if (context.initialBindingEpoch.agentInstanceId === undefined) {
				return Result.err(
					new FoundationError(
						"agent_instance_required_for_agent_provider",
						"Agent fake requires an AgentInstance",
					),
				);
			}
			return createAttempt({
				attemptId: context.initialBindingEpoch.attemptId,
				dispatch,
				providerId: this.providerId,
				initialBindingEpoch: context.initialBindingEpoch,
				providerClass: this.providerClass,
				agentInstanceId: context.initialBindingEpoch.agentInstanceId,
				now: () => NOW,
			});
		}
		if (context.initialBindingEpoch.agentInstanceId !== undefined || context.agentInstance !== undefined) {
			return Result.err(
				new FoundationError(
					"agent_instance_forbidden_for_provider",
					"Non-agent fake cannot carry an AgentInstance",
				),
			);
		}
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
		this.runStarted = true;
		if (this.mode === "slow" && !this.slowReleased) {
			await new Promise<void>((resolve) => {
				this.slowWaiters.push(resolve);
			});
		}
		if (this.mode === "lost") return Result.err(new FoundationError("worker_lost", "Worker lost"));
		if (this.mode === "quota_reject") {
			const attribution: QuotaAttribution = {
				schemaVersion: 1,
				taskId: attempt.taskId,
				attemptId: attempt.attemptId,
				providerId: this.providerId,
				ownerKind: schedulerQuotaOwnerKind(this.providerClass),
			};
			const reserved = await this.quota.reserve(attribution, {});
			if (!reserved.ok) {
				return Result.err(
					new FoundationError(
						"scheduler_budget_exhausted_wait",
						"Scheduler concurrency or quota is exhausted; keep the entry queued.",
						{ retryable: true, cause: reserved.error },
					),
				);
			}
		}
		if (this.mode === "success" || this.mode === "slow" || this.mode === "resume_false") {
			const attribution: QuotaAttribution = {
				schemaVersion: 1,
				taskId: attempt.taskId,
				attemptId: attempt.attemptId,
				providerId: this.providerId,
				ownerKind: schedulerQuotaOwnerKind(this.providerClass),
			};
			await this.quota.reserve(attribution, {});
		}
		const attemptReceiptId = `attempt_receipt_${attempt.attemptId}`;
		const cancelled =
			this.mode === "cancel_ack" || this.cancelled.has(attempt.attemptId) || options?.signal?.aborted === true;
		const receipt = this.receipt(attempt, attemptReceiptId, options, cancelled ? "cancelled" : "succeeded");
		if (this.mode === "invalid_receipt") return Result.ok(receipt);
		return validateAttemptReceiptForProvider(receipt, {
			providerId: this.providerId,
			providerClass: this.providerClass,
		});
	}

	async cancelAttempt(attemptId: string) {
		if (this.mode === "lost") return Result.err(new FoundationError("worker_lost", "Worker lost"));
		this.cancelled.add(attemptId);
		this.cancelAcked = true;
		this.releaseSlow();
		return Result.ok(undefined);
	}

	async start() {
		return this.createAttempt(dispatchFor(this.providerId), binding(), {
			initialBindingEpoch: epoch("attempt_1", this.providerClass === "agent" ? "agent_instance_1" : undefined),
			correlation: correlation("attempt_1", this.providerClass === "agent" ? "agent_instance_1" : undefined),
		});
	}

	async resume(_attemptId: string): Promise<ResultValue<AttemptReceipt, FoundationError>> {
		if (this.mode === "resume_false" || this.connectorSnapshot().resume === false) {
			return Result.err(new FoundationError("foundation_schema_unknown_record", "resume is not supported"));
		}
		return Result.err(new FoundationError("foundation_schema_unknown_record", "resume is not implemented"));
	}

	async cancel(_attemptId: string) {
		return this.cancelAttempt(_attemptId);
	}

	async dispose(): Promise<void> {}

	private receipt(
		attempt: Attempt,
		attemptReceiptId: string,
		options: FoundationProviderExecutionOptions | undefined,
		status: "succeeded" | "cancelled",
	): AttemptReceipt {
		const invalid = this.mode === "invalid_receipt";
		const agentClass = this.providerClass === "agent";
		const agentInstanceId = invalid ? (agentClass ? undefined : "agent_instance_1") : attempt.agentInstanceId;
		const producerKind = invalid ? (agentClass ? "scheduler" : "agent_executor") : producerKindOf(this.kind);
		const baseCorrelation = options?.correlation ?? correlation(attempt.attemptId, attempt.agentInstanceId);
		return {
			schemaVersion: 1,
			attemptReceiptId,
			taskId: attempt.taskId,
			dispatchId: attempt.dispatchId,
			attemptId: attempt.attemptId,
			providerId: this.providerId,
			...(agentInstanceId === undefined ? {} : { agentInstanceId }),
			bindingId: attempt.bindingId,
			bindingEpochIds: [...attempt.bindingEpochIds],
			status,
			workerReceiptRefs: [],
			artifacts: [],
			provenance: {
				producerKind,
				providerId: this.providerId,
				producedAt: NOW,
				correlation: { ...baseCorrelation, attemptReceiptId },
			},
			sideEffectState: "none",
			...(status === "succeeded"
				? {}
				: { error: { code: "cancelled", message: "Attempt cancelled", retryable: false } }),
		};
	}
}

async function executeFake(
	fake: SchedulerExecutorFake,
): Promise<ResultValue<{ attempt: Attempt; receipt: AttemptReceipt }, FoundationError>> {
	const agentClass = fake.providerClass === "agent";
	const attemptId = "attempt_1";
	const instance = agentClass ? agentInstance(fake.providerId) : undefined;
	return executeDispatch({
		dispatch: dispatchFor(fake.providerId),
		binding: binding(),
		initialBindingEpoch: epoch(attemptId, instance?.agentInstanceId),
		provider: fake,
		correlation: correlation(attemptId, instance?.agentInstanceId),
		...(instance === undefined ? {} : { agentInstance: instance }),
	});
}

describe("scheduler executor registry and hard filters", () => {
	it("rejects operation_worker entries and mismatched provider class at registration", async () => {
		const registry = new SchedulerExecutorRegistry();
		const worker = parseSchedulerExecutorEntry({
			schemaVersion: 1,
			descriptor: { schemaVersion: 1, providerId: "worker_1", providerClass: "operation_worker" },
			capabilities: [TASK_CAPABILITY],
			costClass: "local",
			registeredAt: NOW,
		});
		expectCode(worker, "scheduler_no_executor");
		const provider = new SchedulerInProcessTaskExecutorProvider({ now: () => NOW });
		const mismatch = await registry.register({
			entry: executorEntry(SCHEDULER_IN_PROCESS_PROVIDER_ID, "agent", { capabilities: [AGENT_CAPABILITY] }),
			provider,
			trusted: true,
			latencyMs: 0,
		});
		expectCode(mismatch, "task_executor_invalid_provider_class");
	});

	it("filters untrusted and capability-mismatched executors and does not fall back to Host", async () => {
		const untrusted: Parameters<typeof executorPassesHardFilters>[0] = {
			entry: executorEntry("exec_untrusted", "task_executor"),
			trusted: false,
			latencyMs: 0,
			load: 0,
			maxConcurrency: 1,
		};
		const missingCap: Parameters<typeof executorPassesHardFilters>[0] = {
			entry: executorEntry("exec_agent", "agent", { capabilities: [AGENT_CAPABILITY] }),
			trusted: true,
			latencyMs: 0,
			load: 0,
			maxConcurrency: 1,
		};
		expect(executorPassesHardFilters(untrusted, [TASK_CAPABILITY])).toBe(false);
		expect(executorPassesHardFilters(missingCap, [TASK_CAPABILITY])).toBe(false);
		const selected = selectSchedulerExecutor([untrusted, missingCap], {
			queueEntry: queueEntry(),
			requiredCapabilities: [TASK_CAPABILITY],
			decidedAt: NOW,
		});
		expectCode(selected, "scheduler_no_executor");
		expect(schedulerErrorRetryable("scheduler_no_executor")).toBe(false);
		if (!selected.ok) expect(selected).not.toHaveProperty("value");
	});

	it("returns scheduler_backpressure when every hard-eligible executor is at capacity", () => {
		const full: Parameters<typeof selectSchedulerExecutor>[0][number] = {
			entry: executorEntry("exec_full", "task_executor"),
			trusted: true,
			latencyMs: 0,
			load: 1,
			maxConcurrency: 1,
		};
		const selected = selectSchedulerExecutor([full], {
			queueEntry: queueEntry(),
			requiredCapabilities: [TASK_CAPABILITY],
			decidedAt: NOW,
		});
		expectCode(selected, "scheduler_backpressure");
		expect(schedulerErrorRetryable("scheduler_backpressure")).toBe(true);
	});
});

describe("scheduler executor deterministic scoring and catalog projection", () => {
	it("scores cost, latency, load, and affinity deterministically and records evidence", () => {
		const localIdle = {
			entry: executorEntry("exec_local", "task_executor"),
			trusted: true,
			latencyMs: 0,
			load: 0,
			maxConcurrency: 4,
		};
		const remoteAffinity = {
			entry: executorEntry("exec_remote", "agent", {
				capabilities: [AGENT_CAPABILITY, TASK_CAPABILITY],
				costClass: "remote_paid" as const,
				affinity: { sessionId: "session_a", workspaceDigest: WORKSPACE_DIGEST },
			}),
			trusted: true,
			latencyMs: 0,
			load: 0,
			maxConcurrency: 4,
		};
		const localAffinity = {
			entry: executorEntry("exec_best", "task_executor", {
				affinity: { sessionId: "session_a", workspaceDigest: WORKSPACE_DIGEST },
			}),
			trusted: true,
			latencyMs: 0,
			load: 0,
			maxConcurrency: 4,
		};
		expect(scoreSchedulerExecutor(localIdle, {})).toBe(
			SCHEDULER_EXECUTOR_SCORE_COST_LOCAL + SCHEDULER_EXECUTOR_SCORE_LATENCY_MAX + SCHEDULER_EXECUTOR_SCORE_LOAD_MAX,
		);
		expect(
			scoreSchedulerExecutor(remoteAffinity, { sessionId: "session_a", workspaceDigest: WORKSPACE_DIGEST }),
		).toBe(
			SCHEDULER_EXECUTOR_SCORE_COST_REMOTE +
				SCHEDULER_EXECUTOR_SCORE_LATENCY_MAX +
				SCHEDULER_EXECUTOR_SCORE_LOAD_MAX +
				SCHEDULER_EXECUTOR_SCORE_AFFINITY_SESSION +
				SCHEDULER_EXECUTOR_SCORE_AFFINITY_WORKSPACE,
		);
		const first = selectSchedulerExecutor([localIdle, remoteAffinity, localAffinity], {
			queueEntry: queueEntry(),
			requiredCapabilities: [TASK_CAPABILITY],
			sessionId: "session_a",
			workspaceDigest: WORKSPACE_DIGEST,
			decidedAt: NOW,
		});
		const second = selectSchedulerExecutor([localAffinity, remoteAffinity, localIdle], {
			queueEntry: queueEntry(),
			requiredCapabilities: [TASK_CAPABILITY],
			sessionId: "session_a",
			workspaceDigest: WORKSPACE_DIGEST,
			decidedAt: NOW,
		});
		expect(first.ok).toBe(true);
		expect(second.ok).toBe(true);
		if (!first.ok || !second.ok) return;
		expect(first.value.chosenProviderId).toBe("exec_best");
		expect(first.value.scores.map((item) => item.providerId)).toEqual(["exec_best", "exec_local", "exec_remote"]);
		expect(first.value.inputsDigest).toEqual(second.value.inputsDigest);
		expect(first.value.scores).toEqual(second.value.scores);
		const projected = projectSchedulerSelectionFact(first.value);
		expect(projected.ok).toBe(true);
		if (!projected.ok) return;
		expect(projected.value).toEqual({
			schemaVersion: 1,
			queueEntryId: "queue_1",
			taskId: "task_1",
			chosenProviderId: "exec_best",
			inputsDigest: first.value.inputsDigest.value,
			decidedAt: NOW,
			scoreCount: 3,
		});
		expect(projected.value).not.toHaveProperty("scores");
		const catalogPayload: SchedulerSelectionEventPayload = {
			schemaVersion: 1,
			queueEntryId: projected.value.queueEntryId,
			taskId: projected.value.taskId,
			chosenProviderId: projected.value.chosenProviderId,
			inputsDigest: projected.value.inputsDigest,
			decidedAt: projected.value.decidedAt,
			scoreCount: projected.value.scoreCount,
		};
		const event = createDurableEvent({
			category: "scheduler.executor_selected",
			eventId: "event_1",
			streamId: "session_a",
			sequence: 1,
			timestamp: NOW,
			correlation: { sessionId: "session_a", taskId: "task_1" },
			payload: catalogPayload,
		});
		expect(event.payload).toMatchObject({ chosenProviderId: "exec_best", scoreCount: 3 });
		expect(
			validateDurableEvent({
				...event,
				payload: { ...event.payload, scores: first.value.scores },
			}).ok,
		).toBe(false);
	});

	it("breaks score ties by providerId and never invents an unregistered Host executor", () => {
		const left = {
			entry: executorEntry("exec_a", "task_executor"),
			trusted: true,
			latencyMs: 0,
			load: 0,
			maxConcurrency: 4,
		};
		const right = {
			entry: executorEntry("exec_b", "task_executor"),
			trusted: true,
			latencyMs: 0,
			load: 0,
			maxConcurrency: 4,
		};
		const selected = selectSchedulerExecutor([right, left], {
			queueEntry: queueEntry(),
			requiredCapabilities: [TASK_CAPABILITY],
			decidedAt: NOW,
		});
		expect(selected.ok).toBe(true);
		if (!selected.ok) return;
		expect(selected.value.chosenProviderId).toBe("exec_a");
		expect(selected.value.chosenProviderId).not.toBe(SCHEDULER_IN_PROCESS_PROVIDER_ID);
		expect(selectSchedulerExecutor([], { queueEntry: queueEntry(), decidedAt: NOW }).ok).toBe(false);
	});

	it("fails closed on duplicate providerIds", () => {
		const left = {
			entry: executorEntry("exec_a", "task_executor"),
			trusted: true,
			latencyMs: 0,
			load: 0,
			maxConcurrency: 4,
		};
		const duplicate = {
			entry: executorEntry("exec_a", "task_executor", { costClass: "remote_paid" as const }),
			trusted: true,
			latencyMs: 10,
			load: 0,
			maxConcurrency: 4,
		};
		const selected = selectSchedulerExecutor([left, duplicate], {
			queueEntry: queueEntry(),
			requiredCapabilities: [TASK_CAPABILITY],
			decidedAt: NOW,
		});
		expectCode(selected, "scheduler_queue_conflict");
		expect(schedulerErrorRetryable("scheduler_queue_conflict")).toBe(false);
	});
});

describe("scheduler in-process TaskExecutor provider", () => {
	it("is a non-agent task_executor and does not reuse the coding-agent provider", () => {
		const provider = new SchedulerInProcessTaskExecutorProvider({ now: () => NOW });
		expect(provider.providerClass).toBe("task_executor");
		expect(provider.providerId).toBe(SCHEDULER_IN_PROCESS_PROVIDER_ID);
		expect(provider.providerId).not.toBe(BUILTIN_CODING_AGENT_PROVIDER_ID);
		expect("resume" in provider).toBe(false);
		expect(schedulerQuotaOwnerKind(provider.providerClass)).toBe("host");
	});

	it("fails closed without a Host attempt-runner and never mints an empty succeeded receipt", async () => {
		const quota = new ScriptedQuota();
		const provider = new SchedulerInProcessTaskExecutorProvider({ now: () => NOW, quota });
		const started = await provider.createAttempt(dispatchFor(provider.providerId), binding(), {
			initialBindingEpoch: epoch("attempt_1"),
		});
		expect(started.ok).toBe(true);
		if (!started.ok) return;
		const ran = await provider.runAttempt(started.value, { correlation: correlation("attempt_1") });
		expectCode(ran, "scheduler_executor_unavailable");
		if (!ran.ok) expect(ran).not.toHaveProperty("value");
		expect(quota.lastUsage).toBeUndefined();
		const executed = await executeDispatch({
			dispatch: dispatchFor(provider.providerId),
			binding: binding(),
			initialBindingEpoch: epoch("attempt_1"),
			provider,
			correlation: correlation("attempt_1"),
		});
		expectCode(executed, "scheduler_executor_unavailable");
		if (!executed.ok) expect(executed).not.toHaveProperty("value");
	});

	it("runs Host work through the injected runner, wraps quota around it, and settles actual usage", async () => {
		const usage: BudgetUsage = { tokens: 4, wallClockMs: 12 };
		const quota = new ScriptedQuota();
		let ran = false;
		let runnerReceipt: AttemptReceipt | undefined;
		const provider = new SchedulerInProcessTaskExecutorProvider({
			now: () => NOW,
			quota,
			hostAttemptRunner: hostAttemptRunner(usage, (receipt) => {
				ran = true;
				runnerReceipt = receipt;
			}),
		});
		const executed = await executeDispatch({
			dispatch: dispatchFor(provider.providerId),
			binding: binding(),
			initialBindingEpoch: epoch("attempt_1"),
			provider,
			correlation: correlation("attempt_1"),
		});
		expect(executed.ok).toBe(true);
		if (!executed.ok) return;
		expect(ran).toBe(true);
		expect(runnerReceipt).toBeDefined();
		expect(executed.value.receipt).toEqual(runnerReceipt);
		expect(executed.value.receipt.artifacts).toEqual([HOST_ARTIFACT]);
		expect(executed.value.receipt.workerReceiptRefs).toEqual([HOST_WORKER_RECEIPT_REF]);
		expect(executed.value.receipt.artifacts).not.toEqual([]);
		expect(executed.value.receipt.workerReceiptRefs).not.toEqual([]);
		expect(executed.value.receipt.agentInstanceId).toBeUndefined();
		expect(executed.value.receipt.provenance.producerKind).toBe("scheduler");
		expect(executed.value.receipt.status).toBe("succeeded");
		expect(quota.lastAttribution?.ownerKind).toBe("host");
		expect(quota.lastUsage).toEqual(usage);
		const checked = validateAttemptReceiptForProvider(executed.value.receipt, {
			providerId: provider.providerId,
			providerClass: provider.providerClass,
		});
		expect(checked.ok).toBe(true);
	});

	it("rejects invalid or mismatched Host runner receipts and never fabricates empty production success", async () => {
		const usage: BudgetUsage = { tokens: 2 };
		async function runMutated(mutate: (receipt: AttemptReceipt) => AttemptReceipt) {
			const quota = new ScriptedQuota();
			const provider = new SchedulerInProcessTaskExecutorProvider({
				now: () => NOW,
				quota,
				hostAttemptRunner: hostAttemptRunner(usage, undefined, mutate),
			});
			const started = await provider.createAttempt(dispatchFor(provider.providerId), binding(), {
				initialBindingEpoch: epoch("attempt_1"),
			});
			expect(started.ok).toBe(true);
			if (!started.ok) return { quota, ran: started };
			return { quota, ran: await provider.runAttempt(started.value, { correlation: correlation("attempt_1") }) };
		}
		const mismatchedAttempt = await runMutated((receipt) => {
			const provenanceCorrelation = receipt.provenance.correlation;
			if (provenanceCorrelation === undefined) return receipt;
			return {
				...receipt,
				attemptId: "attempt_other",
				provenance: {
					...receipt.provenance,
					correlation: { ...provenanceCorrelation, attemptId: "attempt_other" },
				},
			};
		});
		expectCode(mismatchedAttempt.ran, "invalid_correlation");
		if (!mismatchedAttempt.ran.ok) expect(mismatchedAttempt.ran).not.toHaveProperty("value");
		expect(mismatchedAttempt.quota.lastUsage).toEqual(usage);
		const mismatchedProvider = await runMutated((receipt) => ({
			...receipt,
			providerId: "other.provider",
			provenance: { ...receipt.provenance, providerId: "other.provider" },
		}));
		expectCode(mismatchedProvider.ran, "worker_receipt_invalid_producer");
		if (!mismatchedProvider.ran.ok) expect(mismatchedProvider.ran).not.toHaveProperty("value");
		const mismatchedEpoch = await runMutated((receipt) => {
			const provenanceCorrelation = receipt.provenance.correlation;
			if (provenanceCorrelation === undefined) return receipt;
			return {
				...receipt,
				bindingEpochIds: ["epoch_other"],
				provenance: {
					...receipt.provenance,
					correlation: { ...provenanceCorrelation, bindingEpochId: "epoch_other" },
				},
			};
		});
		expectCode(mismatchedEpoch.ran, "invalid_correlation");
		const mismatchedCorrelation = await runMutated((receipt) => {
			const provenanceCorrelation = receipt.provenance.correlation;
			if (provenanceCorrelation === undefined) return receipt;
			return {
				...receipt,
				provenance: {
					...receipt.provenance,
					correlation: { ...provenanceCorrelation, sessionId: "session_other" },
				},
			};
		});
		expectCode(mismatchedCorrelation.ran, "invalid_correlation");
		const invalidShape = await runMutated((receipt) => Object.assign({}, receipt, { extra: true }));
		expectCode(invalidShape.ran, "foundation_schema_invalid_shape");
		const wrongProducer = await runMutated((receipt) => ({
			...receipt,
			provenance: { ...receipt.provenance, producerKind: "host" },
		}));
		expectCode(wrongProducer.ran, "agent_instance_not_agent_provider");
		const emptyProvider = new SchedulerInProcessTaskExecutorProvider({ now: () => NOW });
		const started = await emptyProvider.createAttempt(dispatchFor(emptyProvider.providerId), binding(), {
			initialBindingEpoch: epoch("attempt_1"),
		});
		expect(started.ok).toBe(true);
		if (!started.ok) return;
		const missing = await emptyProvider.runAttempt(started.value, { correlation: correlation("attempt_1") });
		expectCode(missing, "scheduler_executor_unavailable");
		if (!missing.ok) expect(missing).not.toHaveProperty("value");
	});

	it("rejects AgentInstance on create/run and quota exhaustion without a Host fallback", async () => {
		const provider = new SchedulerInProcessTaskExecutorProvider({ now: () => NOW });
		const created = await provider.createAttempt(dispatchFor(provider.providerId), binding(), {
			initialBindingEpoch: epoch("attempt_1", "agent_instance_1"),
			agentInstance: agentInstance(provider.providerId),
		});
		expectCode(created, "agent_instance_forbidden_for_provider");
		const rejected = await executeDispatch({
			dispatch: dispatchFor(provider.providerId),
			binding: binding(),
			initialBindingEpoch: epoch("attempt_1", "agent_instance_1"),
			provider,
			correlation: correlation("attempt_1", "agent_instance_1"),
			agentInstance: agentInstance(provider.providerId),
		});
		expectCode(rejected, "agent_instance_forbidden_for_provider");
		let ran = false;
		const quotaProvider = new SchedulerInProcessTaskExecutorProvider({
			now: () => NOW,
			quota: new ScriptedQuota(true),
			hostAttemptRunner: hostAttemptRunner({ tokens: 1 }, () => {
				ran = true;
			}),
		});
		const quotaRejected = await executeDispatch({
			dispatch: dispatchFor(quotaProvider.providerId),
			binding: binding(),
			initialBindingEpoch: epoch("attempt_1"),
			provider: quotaProvider,
			correlation: correlation("attempt_1"),
		});
		expectCode(quotaRejected, "scheduler_budget_exhausted_wait");
		expect(ran).toBe(false);
		expect(schedulerErrorRetryable("scheduler_budget_exhausted_wait")).toBe(true);
	});

	it("acks cancel and settles a scheduler cancelled receipt", async () => {
		const provider = new SchedulerInProcessTaskExecutorProvider({ now: () => NOW });
		const started = await provider.createAttempt(dispatchFor(provider.providerId), binding(), {
			initialBindingEpoch: epoch("attempt_1"),
		});
		expect(started.ok).toBe(true);
		if (!started.ok) return;
		expect((await provider.cancelAttempt("attempt_1")).ok).toBe(true);
		const cancelled = await provider.runAttempt(started.value, { correlation: correlation("attempt_1") });
		expect(cancelled.ok).toBe(true);
		if (!cancelled.ok) return;
		expect(cancelled.value.status).toBe("cancelled");
		expect(cancelled.value.provenance.producerKind).toBe("scheduler");
		expect(cancelled.value.agentInstanceId).toBeUndefined();
		expect(
			validateAttemptReceiptForProvider(cancelled.value, {
				providerId: provider.providerId,
				providerClass: "task_executor",
			}).ok,
		).toBe(true);
		const again = await provider.runAttempt(started.value, { correlation: correlation("attempt_1") });
		expectCode(again, "scheduler_executor_unavailable");
	});
});

describe("scheduler executor public-contract fake matrix", () => {
	it("does not treat fabricated in-process fake success as production Host evidence", () => {
		expect(providerIdOf("in_process")).not.toBe(SCHEDULER_IN_PROCESS_PROVIDER_ID);
		expect(new SchedulerInProcessTaskExecutorProvider({ now: () => NOW }).providerId).toBe(
			SCHEDULER_IN_PROCESS_PROVIDER_ID,
		);
	});

	it.each(FAKE_KINDS.flatMap((kind) => FAKE_MODES.map((mode) => [kind, mode] as const)))(
		"%s / %s",
		async (kind, mode) => {
			const fake = new SchedulerExecutorFake(kind, mode);
			expect(schedulerQuotaOwnerKind(fake.providerClass)).toBe(
				kind === "in_process" ? "host" : kind === "external" ? "external_connector" : "agent_executor",
			);
			if (kind === "in_process") {
				expect(fake.providerClass).toBe("task_executor");
				expect((fake as SchedulerTaskExecutorProvider).providerClass).not.toBe("agent");
			}
			if (kind === "acp_sdk")
				expect(fake.connectorSnapshot()).toMatchObject({
					protocol: { name: "acp", version: "1" },
					resume: mode !== "resume_false",
				});
			if (mode === "resume_false") {
				expectCode(await fake.resume("attempt_1"), "foundation_schema_unknown_record");
			}
			if (mode === "slow") {
				const pending = executeFake(fake);
				let settled = false;
				void pending.then(() => {
					settled = true;
				});
				for (let i = 0; i < 20 && !fake.runStarted; i++) await Promise.resolve();
				expect(fake.runStarted).toBe(true);
				expect(settled).toBe(false);
				fake.releaseSlow();
				const executed = await pending;
				expect(executed.ok).toBe(true);
				if (!executed.ok) return;
				expect(executed.value.receipt.provenance.producerKind).toBe(producerKindOf(kind));
				return;
			}
			if (mode === "lost") {
				expectCode(await fake.cancelAttempt("attempt_1"), "worker_lost");
				expectCode(await executeFake(fake), "worker_lost");
				return;
			}
			if (mode === "quota_reject") {
				expectCode(await executeFake(fake), "scheduler_budget_exhausted_wait");
				expect(fake.quota.lastAttribution?.ownerKind).toBe(schedulerQuotaOwnerKind(fake.providerClass));
				return;
			}
			if (mode === "invalid_receipt") {
				const executed = await executeFake(fake);
				expect(executed.ok).toBe(false);
				if (executed.ok) return;
				expect([
					"agent_instance_required_for_agent_provider",
					"agent_instance_forbidden_for_provider",
					"agent_instance_not_agent_provider",
				]).toContain(executed.error.code);
				return;
			}
			if (mode === "cancel_ack") {
				expect((await fake.cancelAttempt("attempt_1")).ok).toBe(true);
				expect(fake.cancelAcked).toBe(true);
				const executed = await executeFake(fake);
				expect(executed.ok).toBe(true);
				if (!executed.ok) return;
				expect(executed.value.receipt.status).toBe("cancelled");
				expect(executed.value.receipt.provenance.producerKind).toBe(producerKindOf(kind));
				if (kind === "in_process" || kind === "external")
					expect(executed.value.receipt.agentInstanceId).toBeUndefined();
				else expect(executed.value.receipt.agentInstanceId).toBe("agent_instance_1");
				return;
			}
			const executed = await executeFake(fake);
			expect(executed.ok).toBe(true);
			if (!executed.ok) return;
			expect(executed.value.receipt.provenance.producerKind).toBe(producerKindOf(kind));
			expect(executed.value.receipt.status).toBe("succeeded");
			if (kind === "in_process" || kind === "external")
				expect(executed.value.receipt.agentInstanceId).toBeUndefined();
			else expect(executed.value.receipt.agentInstanceId).toBe("agent_instance_1");
			expect(fake.quota.lastAttribution?.ownerKind).toBe(schedulerQuotaOwnerKind(fake.providerClass));
			const checked = validateAttemptReceiptForProvider(executed.value.receipt, {
				providerId: fake.providerId,
				providerClass: fake.providerClass,
			});
			expect(checked.ok).toBe(true);
		},
	);
});

describe("scheduler executor registry selection wiring", () => {
	it("selects the in-process provider through the registry and projects the catalog event", async () => {
		const registry = new SchedulerExecutorRegistry();
		const provider = new SchedulerInProcessTaskExecutorProvider({ now: () => NOW });
		const registered = await registry.register({
			entry: executorEntry(provider.providerId, provider.providerClass, {
				affinity: { sessionId: "session_a", workspaceDigest: WORKSPACE_DIGEST },
			}),
			provider,
			trusted: true,
			latencyMs: 0,
		});
		expect(registered.ok).toBe(true);
		const duplicate = await registry.register({
			entry: executorEntry(provider.providerId, provider.providerClass),
			provider,
			trusted: true,
			latencyMs: 0,
		});
		expectCode(duplicate, "scheduler_queue_conflict");
		const selected = await registry.select({
			queueEntry: queueEntry(),
			requiredCapabilities: [TASK_CAPABILITY],
			sessionId: "session_a",
			workspaceDigest: WORKSPACE_DIGEST,
			decidedAt: NOW,
		});
		expect(selected.ok).toBe(true);
		if (!selected.ok) return;
		expect(selected.value.provider).toBe(provider);
		expect(selected.value.fact.chosenProviderId).toBe(SCHEDULER_IN_PROCESS_PROVIDER_ID);
		expect(selected.value.catalogPayload.scoreCount).toBe(1);
		expect(selected.value.catalogPayload.inputsDigest).toBe(selected.value.fact.inputsDigest.value);
		expect(Object.keys(selected.value.catalogPayload).sort()).toEqual([
			"chosenProviderId",
			"decidedAt",
			"inputsDigest",
			"queueEntryId",
			"schemaVersion",
			"scoreCount",
			"taskId",
		]);
		const replayed = registry.replaySelectionFact("queue_1");
		expect(replayed.ok).toBe(true);
		if (!replayed.ok) return;
		expect(replayed.value).toEqual(serializeSchedulerSelectionFact(selected.value.fact));
		expect(replayed.value.scores).toEqual(selected.value.fact.scores);
		expect(replayed.value).toHaveProperty("scores");
		expect(selected.value.catalogPayload).not.toHaveProperty("scores");
		const selectedAgain = await registry.select({
			queueEntry: queueEntry(),
			requiredCapabilities: [TASK_CAPABILITY],
			sessionId: "session_a",
			workspaceDigest: WORKSPACE_DIGEST,
			decidedAt: NOW,
		});
		expect(selectedAgain.ok).toBe(true);
		if (!selectedAgain.ok) return;
		expect(selectedAgain.value.fact).toEqual(replayed.value);
		const wrongTask = await registry.select({
			queueEntry: queueEntry({ taskId: "task_2" }),
			requiredCapabilities: [TASK_CAPABILITY],
			sessionId: "session_a",
			workspaceDigest: WORKSPACE_DIGEST,
			decidedAt: NOW,
		});
		expectCode(wrongTask, "scheduler_queue_conflict");
		const conflicted = registry.persistSelectionFact({
			...selected.value.fact,
			decidedAt: "2026-08-21T13:00:00.000Z",
		});
		expectCode(conflicted, "scheduler_queue_conflict");
		expectCode(registry.replaySelectionFact("missing_queue"), "scheduler_not_found");
	});

	it("rejects registration when live capabilities do not cover declared entry capabilities", async () => {
		const registry = new SchedulerExecutorRegistry();
		const fake = new SchedulerExecutorFake("in_process", "success");
		const uncovered = await registry.register({
			entry: executorEntry(fake.providerId, fake.providerClass, {
				capabilities: [{ schemaVersion: 1, id: SCHEDULER_IN_PROCESS_CAPABILITY_ID, version: 2 }],
			}),
			provider: fake,
			trusted: true,
			latencyMs: 0,
		});
		expectCode(uncovered, "scheduler_no_executor");
		const missing = await registry.register({
			entry: executorEntry(fake.providerId, fake.providerClass, {
				capabilities: [{ schemaVersion: 1, id: "foundation.missing-capability", version: 1 }],
			}),
			provider: fake,
			trusted: true,
			latencyMs: 0,
		});
		expectCode(missing, "scheduler_no_executor");
	});
});

describe("scheduler durable exact selection", () => {
	it("rejects exact requirements at the first ordered mismatch without downgrade", async () => {
		const plainBinding = binding();
		const toolBinding = bindingWithTool();
		const cases: readonly {
			readonly name: string;
			readonly bindingValue: AgentBinding;
			readonly snapshot: (providerId: string) => SchedulerExecutorRuntimeSnapshot;
			readonly expectedStage: string;
		}[] = [
			{
				name: "resume before all later mismatches",
				bindingValue: plainBinding,
				snapshot: (providerId) =>
					runtimeSnapshotFor(providerId, {
						resume: false,
						modelAccess: "agent_owned",
						bindingRequirementDigests: [fingerprintFoundationValue("wrong-binding")],
						policyRevisionDigests: [fingerprintFoundationValue("wrong-policy")],
						credentialTargetRefs: [],
					}),
				expectedStage: "resume_replay",
			},
			{
				name: "model access is exact, not a strength-based fallback",
				bindingValue: plainBinding,
				snapshot: (providerId) => runtimeSnapshotFor(providerId, { modelAccess: "agent_owned" }),
				expectedStage: "model_access",
			},
			{
				name: "tool gateway follows the immutable binding",
				bindingValue: toolBinding,
				snapshot: (providerId) => runtimeSnapshotFor(providerId, { bindingValue: toolBinding, toolGateway: false }),
				expectedStage: "binding_tools",
			},
			{
				name: "policy follows binding and review",
				bindingValue: plainBinding,
				snapshot: (providerId) =>
					runtimeSnapshotFor(providerId, {
						policyRevisionDigests: [fingerprintFoundationValue("wrong-policy")],
					}),
				expectedStage: "policy_review",
			},
			{
				name: "credential and sandbox are checked last",
				bindingValue: plainBinding,
				snapshot: (providerId) => runtimeSnapshotFor(providerId, { credentialTargetRefs: [] }),
				expectedStage: "credential_sandbox",
			},
		];
		for (const [index, testCase] of cases.entries()) {
			const providerId = `strict.reject.${index}`;
			const session = new Session(new InMemorySessionStorage({ id: `strict-reject-${index}`, createdAt: 1 }));
			const store = new SchedulerSelectionReservationStore(session, {
				ownerId: `strict-reject-${index}`,
				now: () => NOW,
			});
			const registry = new SchedulerExecutorRegistry({ reservationStore: store });
			const provider = new SchedulerInProcessTaskExecutorProvider({ providerId, now: () => NOW });
			const registered = await registry.register({
				entry: executorEntry(providerId, "task_executor"),
				provider,
				trusted: true,
				latencyMs: 0,
				runtimeSnapshot: testCase.snapshot(providerId),
			});
			expect(registered.ok, testCase.name).toBe(true);
			const selected = await registry.select({
				queueEntry: queueEntry({ queueEntryId: `queue_reject_${index}` }),
				requiredCapabilities: [TASK_CAPABILITY],
				decidedAt: NOW,
				exactRequirements: {
					binding: testCase.bindingValue,
					attemptId: `attempt_reject_${index}`,
					bindingEpochId: `epoch_reject_${index}`,
					requireResume: true,
					modelAccess: "aos_gateway",
					credentialTargetRefs: ["credential:test"],
					sandboxTargetRefs: ["sandbox:test"],
				},
			});
			expectCode(selected, "scheduler_no_executor");
			if (!selected.ok) {
				const details = selected.error.details as { rejections?: readonly { stage?: string }[] } | undefined;
				expect(details?.rejections?.[0]?.stage, testCase.name).toBe(testCase.expectedStage);
			}
			await store.release();
		}
	});

	it("replays the immutable durable fact and rejects a stale chosen capability", async () => {
		const storage = new InMemorySessionStorage({ id: "strict-replay", createdAt: 1 });
		const bindingValue = binding();
		const exactRequirements = {
			binding: bindingValue,
			attemptId: "attempt_replay",
			bindingEpochId: "epoch_replay",
			requireResume: true,
			modelAccess: "aos_gateway" as const,
			credentialTargetRefs: ["credential:test"],
			sandboxTargetRefs: ["sandbox:test"],
		};
		const store1 = new SchedulerSelectionReservationStore(new Session(storage), {
			ownerId: "replay-1",
			now: () => NOW,
		});
		const registry1 = new SchedulerExecutorRegistry({ reservationStore: store1 });
		for (const [providerId, latencyMs] of [
			["strict.a", 0],
			["strict.b", 1_000],
		] as const) {
			const provider = new SchedulerInProcessTaskExecutorProvider({ providerId, now: () => NOW });
			const registered = await registry1.register({
				entry: executorEntry(providerId, "task_executor"),
				provider,
				trusted: true,
				latencyMs,
				maxConcurrency: 2,
				runtimeSnapshot: runtimeSnapshotFor(providerId, { bindingValue }),
			});
			expect(registered.ok).toBe(true);
		}
		const selected = await registry1.select({
			queueEntry: queueEntry({ queueEntryId: "queue_replay" }),
			requiredCapabilities: [TASK_CAPABILITY],
			decidedAt: NOW,
			exactRequirements,
		});
		expect(selected.ok).toBe(true);
		if (!selected.ok) return;
		expect(selected.value.provider.providerId).toBe("strict.a");
		expect(selected.value.durableFact?.reservationId).toMatch(/^scheduler_reservation_/);
		await store1.release();

		const store2 = new SchedulerSelectionReservationStore(new Session(storage), {
			ownerId: "replay-2",
			now: () => NOW,
		});
		const registry2 = new SchedulerExecutorRegistry({ reservationStore: store2 });
		for (const [providerId, latencyMs] of [
			["strict.a", 2_000],
			["strict.b", 0],
		] as const) {
			const provider = new SchedulerInProcessTaskExecutorProvider({ providerId, now: () => NOW });
			const registered = await registry2.register({
				entry: executorEntry(providerId, "task_executor"),
				provider,
				trusted: true,
				latencyMs,
				maxConcurrency: 2,
				runtimeSnapshot: runtimeSnapshotFor(providerId, { bindingValue }),
			});
			expect(registered.ok).toBe(true);
		}
		const replayed = await registry2.select({
			queueEntry: queueEntry({ queueEntryId: "queue_replay" }),
			requiredCapabilities: [TASK_CAPABILITY],
			decidedAt: "2026-08-21T12:30:00.000Z",
			exactRequirements,
		});
		expect(replayed.ok).toBe(true);
		if (!replayed.ok) return;
		expect(replayed.value.provider.providerId).toBe("strict.a");
		expect(replayed.value.durableFact).toEqual(selected.value.durableFact);
		await store2.release();

		const store3 = new SchedulerSelectionReservationStore(new Session(storage), {
			ownerId: "replay-3",
			now: () => NOW,
		});
		const registry3 = new SchedulerExecutorRegistry({ reservationStore: store3 });
		const staleProvider = new SchedulerInProcessTaskExecutorProvider({ providerId: "strict.a", now: () => NOW });
		const staleRegistered = await registry3.register({
			entry: executorEntry("strict.a", "task_executor"),
			provider: staleProvider,
			trusted: true,
			latencyMs: 0,
			maxConcurrency: 2,
			runtimeSnapshot: runtimeSnapshotFor("strict.a", { bindingValue, revision: 2 }),
		});
		expect(staleRegistered.ok).toBe(true);
		const stale = await registry3.select({
			queueEntry: queueEntry({ queueEntryId: "queue_replay" }),
			requiredCapabilities: [TASK_CAPABILITY],
			decidedAt: "2026-08-21T12:45:00.000Z",
			exactRequirements,
		});
		expectCode(stale, "scheduler_executor_unavailable");
		const reconciled = await registry3.reservationRecord("queue_replay");
		expect(reconciled.ok).toBe(true);
		if (reconciled.ok) expect(reconciled.value?.status).toBe("settled");
		await store3.release();
	});

	it("atomically admits only one concurrent selection at maxConcurrency one", async () => {
		const session = new Session(new InMemorySessionStorage({ id: "strict-capacity", createdAt: 1 }));
		const store = new SchedulerSelectionReservationStore(session, { ownerId: "capacity", now: () => NOW });
		const registry = new SchedulerExecutorRegistry({ reservationStore: store });
		const providerId = "strict.capacity";
		const provider = new SchedulerInProcessTaskExecutorProvider({ providerId, now: () => NOW });
		const registered = await registry.register({
			entry: executorEntry(providerId, "task_executor"),
			provider,
			trusted: true,
			latencyMs: 0,
			maxConcurrency: 1,
			runtimeSnapshot: runtimeSnapshotFor(providerId),
		});
		expect(registered.ok).toBe(true);
		const select = (queueEntryId: string, attemptId: string) =>
			registry.select({
				queueEntry: queueEntry({ queueEntryId }),
				requiredCapabilities: [TASK_CAPABILITY],
				decidedAt: NOW,
				exactRequirements: {
					binding: binding(),
					attemptId,
					bindingEpochId: `epoch_${attemptId}`,
					requireResume: true,
					modelAccess: "aos_gateway",
				},
			});
		const results = await Promise.all([
			select("queue_capacity_1", "attempt_capacity_1"),
			select("queue_capacity_2", "attempt_capacity_2"),
		]);
		expect(results.filter((result) => result.ok)).toHaveLength(1);
		const rejected = results.find((result) => !result.ok);
		if (rejected !== undefined) expectCode(rejected, "scheduler_backpressure");
		const records = await store.list();
		expect(records.ok).toBe(true);
		if (records.ok) expect(records.value.filter((record) => record.status === "reserved")).toHaveLength(1);
		await store.release();
	});
});

describe("scheduler quota terminal cleanup", () => {
	it("settles quota exactly once when the Host runner throws", async () => {
		const quota = new ScriptedQuota();
		const provider = new SchedulerInProcessTaskExecutorProvider({
			quota,
			now: () => NOW,
			hostAttemptRunner: async () => {
				throw new Error("runner exploded");
			},
		});
		const created = await provider.createAttempt(dispatchFor(provider.providerId), binding(), {
			initialBindingEpoch: epoch("attempt_throw"),
			correlation: correlation("attempt_throw"),
		});
		expect(created.ok).toBe(true);
		if (!created.ok) return;
		const run = await provider.runAttempt(created.value, { correlation: correlation("attempt_throw") });
		expectCode(run, "scheduler_executor_unavailable");
		expect(quota.reserveCount).toBe(1);
		expect(quota.settleCount).toBe(1);
		expect(quota.lastUsage).toEqual({});
	});
});
