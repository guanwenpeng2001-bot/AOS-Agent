import {
	type AgentBinding,
	type AppendFoundationRecordResult,
	type Attempt,
	type AttemptReceipt,
	type BudgetUsage,
	createAttempt,
	createConnectorCapabilitySnapshot,
	createModelProfileRevision,
	createRoleRevision,
	type Dispatch,
	type DurableLedgerApi,
	DurableLedgerError,
	FoundationError,
	type FoundationObjectResult,
	type FoundationProviderCapability,
	type FoundationProviderExecutionOptions,
	type FoundationRecord,
	type FoundationRecordQuery,
	type FoundationRetentionPolicy,
	fingerprintFoundationValue,
	InMemorySessionStorage,
	type LedgerWriterLease,
	type ModelProfile,
	type ProvisionedFoundationRecord,
	type QuotaAttribution,
	type QuotaProvider,
	type QuotaReservation,
	Result,
	type Result as ResultValue,
	type RevisionReference,
	resolveAgentBinding,
	Session,
	SessionLedger,
	type SetRetentionPolicyOptions,
	type TaskEnvelope,
	type TaskExecutorAttemptContext,
	type TaskExecutorProvider,
	validateAttemptReceiptForProvider,
} from "@aos-agent/agent-core";
import { describe, expect, it } from "vitest";
import { createRunLifecycleCoordinator } from "../src/core/run-lifecycle.ts";
import type { SchedulerClaimV1, SchedulerQueueEntryV1 } from "../src/core/scheduler.ts";
import {
	assembleSchedulerDispatchV1,
	bindSchedulerInProcessTaskExecutorV1,
	SchedulerDispatchController,
	schedulerDispatchIdentityV1,
} from "../src/core/scheduler-dispatch.ts";
import {
	createSchedulerExecutorRuntimeSnapshotV1,
	SCHEDULER_IN_PROCESS_CAPABILITY_ID,
	SCHEDULER_IN_PROCESS_PROVIDER_ID,
	SchedulerExecutorRegistry,
	schedulerBindingRequirementDigestV1,
} from "../src/core/scheduler-executors.ts";
import { SchedulerQueueStore } from "../src/core/scheduler-queue.ts";
import { SchedulerSelectionReservationStore } from "../src/core/scheduler-selection-reservations.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { observeCanonicalTerminal } from "./support/canonical-run-terminal.ts";

const NOW = "2026-08-22T10:00:00.000Z";
const LATER = "2026-08-22T10:20:00.000Z";
const OWNER_ID = "scheduler_dispatch_owner";
const RUN_MODEL = { provider: "host", id: "host", thinkingLevel: "off" as const };
const CAPABILITY: FoundationProviderCapability = {
	schemaVersion: 1,
	id: SCHEDULER_IN_PROCESS_CAPABILITY_ID,
	version: 1,
};
const ARTIFACT = {
	schemaVersion: 1 as const,
	artifactId: "artifact_scheduler_dispatch",
	mediaType: "application/json",
	digest: `sha256:${"c".repeat(64)}`,
};

function expectCode(result: { ok: false; error: { code: string } } | { ok: true }, code: string): void {
	expect(result.ok).toBe(false);
	if (!result.ok) expect(result.error.code).toBe(code);
}

function task(): TaskEnvelope {
	return {
		schemaVersion: 1,
		taskId: "task_dispatch_1",
		goalId: "goal_dispatch_1",
		goal: "Exercise the durable scheduler dispatch chain",
		workspace: "workspace_scheduler_dispatch",
		capabilityRefs: [],
		inputs: [],
		expectedOutputs: [],
		budget: { tokens: 100 },
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
			roleId: "role_dispatch_1",
			scope: "project",
			slug: "scheduler-dispatch",
			name: "Scheduler dispatch",
			description: "Runs one durable scheduler dispatch",
			revision: 1,
			persona: "Execute the claimed task.",
			modelProfileRef: {
				schemaVersion: 1,
				type: "model_profile",
				id: "profile_dispatch_1",
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
		modelProfileId: "profile_dispatch_1",
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

function binding(): AgentBinding {
	const resolved = resolveAgentBinding({
		task: task(),
		roleRevision: roleRevision(),
		modelProfile: modelProfile(),
		contextRevision: immutableFact("external_agent_binding", "external_dispatch_1"),
		capabilityRevision: immutableFact("capability_binding", "capability_dispatch_1"),
		modelBrokerBindingRevision: immutableFact("model_broker_binding", "broker_dispatch_1"),
		policyRevision: immutableFact("policy_binding", "policy_dispatch_1"),
		newBindingId: "binding_dispatch_1",
		now: () => NOW,
	});
	if (!resolved.ok) throw resolved.error;
	return resolved.value;
}

async function seedBindingFacts(session: Session, value: AgentBinding): Promise<void> {
	const ledger = new SessionLedger(session, { ownerId: "scheduler_dispatch_seed" });
	await ledger.appendFact("task", value.taskId, task(), {
		clientRequestId: "dispatch-seed:task",
		expectedRevision: 0,
		correlation: { taskId: value.taskId },
	});
	await ledger.appendFact("role_revision", value.roleRevision.id, roleRevision(), {
		clientRequestId: "dispatch-seed:role",
		expectedRevision: 0,
		correlation: { taskId: value.taskId, bindingId: value.bindingId },
	});
	await ledger.appendFact("model_profile_revision", value.modelProfileRevision.id, modelProfile(), {
		clientRequestId: "dispatch-seed:model",
		expectedRevision: 0,
		correlation: { taskId: value.taskId, bindingId: value.bindingId },
	});
	for (const [objectType, reference] of [
		["external_agent_binding", value.contextRevision],
		["capability_binding", value.capabilityRevision],
		["model_broker_binding", value.modelBrokerBindingRevision],
		["policy_binding", value.policyRevision],
	] as const) {
		const payload = {
			schemaVersion: 1 as const,
			type: reference.type,
			id: reference.id,
			revision: reference.revision,
		};
		await ledger.appendFact(objectType, reference.id, payload, {
			clientRequestId: `dispatch-seed:${objectType}`,
			expectedRevision: 0,
			correlation: { taskId: value.taskId, bindingId: value.bindingId },
		});
	}
	await ledger.release();
}

function queued(deadlineAt?: string): SchedulerQueueEntryV1 {
	return {
		schemaVersion: 1,
		queueEntryId: "queue_dispatch_1",
		sessionId: "session_dispatch_1",
		taskId: "task_dispatch_1",
		goalId: "goal_dispatch_1",
		state: "queued",
		priority: 10,
		attemptsUsed: 0,
		enqueuedAt: NOW,
		revision: 0,
		...(deadlineAt === undefined ? {} : { deadlineAt }),
	};
}

function providerReceipt(
	attempt: Attempt,
	options: FoundationProviderExecutionOptions | undefined,
	status: "succeeded" | "cancelled" = "succeeded",
): AttemptReceipt {
	const attemptReceiptId = `attempt_receipt_${attempt.attemptId}`;
	const correlation = options?.correlation;
	if (correlation === undefined)
		throw new FoundationError("invalid_correlation", "Test provider requires correlation");
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
		usage: {
			inputTokens: 2,
			outputTokens: 3,
			cacheReadInputTokens: 1,
			cacheCreationInputTokens: 1,
			costUsd: 0.5,
		},
		provenance: {
			producerKind: "scheduler",
			providerId: attempt.providerId,
			producedAt: NOW,
			correlation: { ...correlation, attemptReceiptId },
		},
		sideEffectState: "none",
		...(status === "cancelled"
			? { error: { code: "cancelled", message: "Attempt cancelled", retryable: false } }
			: {}),
	};
}

class RecordingQuota implements QuotaProvider {
	readonly schemaVersion = 1 as const;
	readonly providerId = "quota_scheduler_dispatch";
	readonly providerClass = "quota" as const;
	reserved: QuotaAttribution | undefined;
	settled: BudgetUsage | undefined;
	settleCount = 0;
	async capabilities(): Promise<readonly FoundationProviderCapability[]> {
		return [];
	}
	async reserve(attribution: QuotaAttribution, budget: QuotaReservation["budget"]) {
		this.reserved = attribution;
		return Result.ok({
			schemaVersion: 1 as const,
			reservationId: "reservation_scheduler_dispatch",
			attribution,
			budget,
			grantedAt: NOW,
		});
	}
	async settle(_reservation: QuotaReservation, usage: BudgetUsage) {
		this.settleCount += 1;
		this.settled = usage;
		return Result.ok(usage);
	}
	async dispose(): Promise<void> {}
}

type ScriptedMode = "success" | "fail" | "block";

class ScriptedTaskExecutor implements TaskExecutorProvider {
	readonly schemaVersion = 1 as const;
	readonly providerId = "task_executor_scheduler_dispatch";
	readonly providerClass = "task_executor" as const;
	mode: ScriptedMode;
	cancelFails = false;
	runCount = 0;
	cancelCount = 0;
	readonly started: Promise<void>;
	private startRun: () => void = () => {};
	private releaseRun: () => void = () => {};
	private readonly cancelled = new Set<string>();

	constructor(mode: ScriptedMode) {
		this.mode = mode;
		this.started = new Promise((resolve) => {
			this.startRun = resolve;
		});
	}

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
		this.runCount += 1;
		this.startRun();
		if (this.mode === "fail") return Result.err(new FoundationError("worker_lost", "Injected worker loss"));
		if (this.mode === "block" && !this.cancelled.has(attempt.attemptId) && options?.signal?.aborted !== true) {
			await new Promise<void>((resolve) => {
				this.releaseRun = resolve;
			});
		}
		const status =
			this.cancelled.has(attempt.attemptId) || options?.signal?.aborted === true ? "cancelled" : "succeeded";
		return validateAttemptReceiptForProvider(providerReceipt(attempt, options, status), {
			providerId: this.providerId,
			providerClass: this.providerClass,
		});
	}

	async cancelAttempt(attemptId: string) {
		this.cancelCount += 1;
		if (this.cancelFails) return Result.err(new FoundationError("worker_lost", "Injected cancellation failure"));
		this.cancelled.add(attemptId);
		this.releaseRun();
		return Result.ok(undefined);
	}

	finish(): void {
		this.releaseRun();
	}

	async dispose(): Promise<void> {}
}

class ResumableTaskExecutor extends ScriptedTaskExecutor {
	resumeCount = 0;
	readonly queueEntryId: string;
	readonly claimId: string;

	constructor(queueEntryId: string, claimId: string) {
		super("success");
		this.queueEntryId = queueEntryId;
		this.claimId = claimId;
	}

	async resumeAttempt(
		attemptId: string,
		options: FoundationProviderExecutionOptions,
	): Promise<ResultValue<AttemptReceipt, FoundationError>> {
		this.resumeCount += 1;
		const ids = schedulerDispatchIdentityV1(this.queueEntryId, this.claimId);
		if (attemptId !== ids.attemptId) {
			return Result.err(new FoundationError("invalid_correlation", "Resume attempt identity mismatch"));
		}
		const attempt: Attempt = {
			schemaVersion: 1,
			attemptId,
			dispatchId: ids.dispatchId,
			taskId: "task_dispatch_1",
			providerId: this.providerId,
			bindingId: "binding_dispatch_1",
			bindingEpochIds: [ids.bindingEpochId],
			status: "starting",
			startedAt: NOW,
		};
		return validateAttemptReceiptForProvider(providerReceipt(attempt, options), {
			providerId: this.providerId,
			providerClass: this.providerClass,
		});
	}
}

async function registerScripted(registry: SchedulerExecutorRegistry, provider: TaskExecutorProvider): Promise<void> {
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
}

function runtimeSnapshot(providerId: string, bindingValue: AgentBinding) {
	const bindingDigest = schedulerBindingRequirementDigestV1(bindingValue);
	if (!bindingDigest.ok) throw bindingDigest.error;
	if (bindingValue.policyRevision.fingerprint === undefined) throw new Error("policy fingerprint missing");
	const capabilitySnapshot = createConnectorCapabilitySnapshot({
		schemaVersion: 1,
		providerId,
		revision: 1,
		protocol: { name: "scheduler-dispatch-test", version: "1" },
		modelAccess: "aos_gateway",
		resume: true,
		toolGateway: true,
		artifacts: true,
		images: false,
	});
	const created = createSchedulerExecutorRuntimeSnapshotV1({
		schemaVersion: 1,
		capabilitySnapshot,
		configRevision: fingerprintFoundationValue(`config:${providerId}:1`),
		bindingRequirementDigests: [bindingDigest.value],
		toolSelectionDigests: [bindingValue.mcpSelection.digest],
		policyRevisionDigests: [bindingValue.policyRevision.fingerprint],
		reviewRevisionDigests: [],
		credentialTargetRefs: [],
		sandboxTargetRefs: [],
		observedAt: NOW,
		expiresAt: "2026-08-22T12:00:00.000Z",
	});
	if (!created.ok) throw created.error;
	return created.value;
}

class FailDispatchedEntryLedger implements DurableLedgerApi {
	readonly inner: DurableLedgerApi;
	failDispatchedEntry = false;

	constructor(inner: DurableLedgerApi) {
		this.inner = inner;
	}

	acquireWriterLease(options: { ownerId: string; ttlMs?: number }): Promise<LedgerWriterLease> {
		return this.inner.acquireWriterLease(options);
	}
	renewWriterLease(options: { fencingToken: string; ttlMs?: number }): Promise<LedgerWriterLease> {
		return this.inner.renewWriterLease(options);
	}
	releaseWriterLease(options: { fencingToken: string }): Promise<void> {
		return this.inner.releaseWriterLease(options);
	}
	getWriterLease(): Promise<LedgerWriterLease | null> {
		return this.inner.getWriterLease();
	}
	getLedgerRevision(): Promise<number> {
		return this.inner.getLedgerRevision();
	}
	appendFoundationRecord(record: ProvisionedFoundationRecord): Promise<AppendFoundationRecordResult> {
		if (
			this.failDispatchedEntry &&
			record.kind === "fact" &&
			record.objectType === "scheduler.queue_entry" &&
			typeof record.payload === "object" &&
			record.payload !== null &&
			!Array.isArray(record.payload) &&
			record.payload.state === "dispatched"
		) {
			this.failDispatchedEntry = false;
			throw new DurableLedgerError("session_writer_busy", "Injected queue-entry crash");
		}
		return this.inner.appendFoundationRecord(record);
	}
	setRetentionPolicy(
		policy: FoundationRetentionPolicy,
		options: SetRetentionPolicyOptions,
	): Promise<AppendFoundationRecordResult> {
		return this.inner.setRetentionPolicy(policy, options);
	}
	findFoundationRecords(query?: FoundationRecordQuery): Promise<FoundationRecord[]> {
		return this.inner.findFoundationRecords(query);
	}
	getFoundationObject(objectType: string, objectId: string): Promise<FoundationObjectResult | undefined> {
		return this.inner.getFoundationObject(objectType, objectId);
	}
	getFoundationRevision(objectType: string, objectId: string): Promise<number> {
		return this.inner.getFoundationRevision(objectType, objectId);
	}
	isObjectTombstoned(objectType: string, objectId: string): Promise<boolean> {
		return this.inner.isObjectTombstoned(objectType, objectId);
	}
	getRetentionPolicy(): Promise<FoundationRetentionPolicy | undefined> {
		return this.inner.getRetentionPolicy();
	}
	prunableFoundationRecords(): Promise<readonly FoundationRecord[]> {
		return this.inner.prunableFoundationRecords();
	}
}

async function claimedHarness(
	options: {
		readonly deadlineAt?: string;
		readonly session?: Session;
		readonly ledger?: DurableLedgerApi;
		readonly now?: () => string;
		readonly cancelAttempt?: (attemptId: string) => Promise<ResultValue<void, FoundationError>>;
	} = {},
): Promise<{
	readonly session: Session;
	readonly queue: SchedulerQueueStore;
	readonly binding: AgentBinding;
	readonly claim: SchedulerClaimV1;
}> {
	const session =
		options.session ?? new Session(new InMemorySessionStorage({ id: "session_dispatch_1", createdAt: 1 }));
	const ledger = options.ledger ?? session;
	const currentBinding = binding();
	await seedBindingFacts(session, currentBinding);
	const queue = new SchedulerQueueStore({
		ledger,
		sessionId: "session_dispatch_1",
		ownerId: OWNER_ID,
		now: options.now ?? (() => NOW),
		...(options.cancelAttempt === undefined ? {} : { cancelAttempt: options.cancelAttempt }),
	});
	const enqueued = await queue.enqueue(queued(options.deadlineAt));
	if (!enqueued.ok) throw enqueued.error;
	const claimed = await queue.claim({
		queueEntryId: "queue_dispatch_1",
		ownerId: OWNER_ID,
		claimId: "claim_dispatch_1",
		fencingToken: "fence_dispatch_1",
	});
	if (!claimed.ok) throw claimed.error;
	return { session, queue, binding: currentBinding, claim: claimed.value.claim };
}

describe("scheduler dispatch assembly", () => {
	it("builds bounded deterministic identities and rejects frozen-contract violations", () => {
		const currentBinding = binding();
		const entry: SchedulerQueueEntryV1 = {
			...queued("2026-08-22T10:05:00.000Z"),
			state: "claimed",
			claimId: "claim_dispatch_1",
			revision: 1,
		};
		const claim: SchedulerClaimV1 = {
			schemaVersion: 1,
			claimId: "claim_dispatch_1",
			queueEntryId: entry.queueEntryId,
			taskId: entry.taskId,
			ownerId: OWNER_ID,
			fencingToken: "fence_dispatch_1",
			acquiredAt: NOW,
			expiresAt: "2026-08-22T10:10:00.000Z",
			revision: 0,
		};
		const input = {
			entry,
			claim,
			binding: currentBinding,
			providerId: "task_executor_scheduler_dispatch",
			providerClass: "task_executor" as const,
			sessionId: "session_dispatch_1",
			laneId: "main",
			now: NOW,
		};
		const first = assembleSchedulerDispatchV1(input);
		const second = assembleSchedulerDispatchV1(input);
		expect(first.ok).toBe(true);
		expect(second).toEqual(first);
		if (!first.ok) return;
		expect(first.value.dispatch.deadlineAt).toBe(entry.deadlineAt);
		expect(first.value.initialBindingEpoch).toMatchObject({ ordinal: 0, activationReason: "attempt_started" });
		expect(first.value.initialBindingEpoch.agentInstanceId).toBeUndefined();
		expect(first.value.correlation).toMatchObject({
			sessionId: "session_dispatch_1",
			laneId: "main",
			taskId: entry.taskId,
			dispatchId: first.value.dispatchId,
			attemptId: first.value.attemptId,
			bindingId: currentBinding.bindingId,
			bindingEpochId: first.value.bindingEpochId,
			providerId: "task_executor_scheduler_dispatch",
			roleRevisionId: currentBinding.roleRevision.id,
			modelProfileRevisionId: currentBinding.modelProfileRevision.id,
		});
		for (const id of Object.values(schedulerDispatchIdentityV1("q".repeat(256), "c".repeat(256)))) {
			expect(id.length).toBeLessThanOrEqual(256);
		}
		expect(schedulerDispatchIdentityV1(entry.queueEntryId, claim.claimId)).not.toEqual(
			schedulerDispatchIdentityV1(entry.queueEntryId, "claim_dispatch_2"),
		);
		const invalidEntry = { ...entry, prompt: "forbidden" };
		expectCode(assembleSchedulerDispatchV1({ ...input, entry: invalidEntry }), "scheduler_queue_invalid");
		expectCode(
			assembleSchedulerDispatchV1({
				...input,
				binding: { ...currentBinding, resolvedAt: "2026-08-22T10:00:01.000Z" },
			}),
			"profile_conflict",
		);
		expectCode(
			assembleSchedulerDispatchV1({ ...input, providerClass: "agent" }),
			"agent_instance_required_for_agent_provider",
		);
	});
});

describe("scheduler dispatch controller", () => {
	it("runs the public Host chain after markDispatched and settles quota from actual usage", async () => {
		const harness = await claimedHarness();
		const registry = new SchedulerExecutorRegistry();
		const quota = new RecordingQuota();
		let observedQueueState: string | undefined;
		let observedAttempt = false;
		const registered = await bindSchedulerInProcessTaskExecutorV1(registry, {
			now: () => NOW,
			sessionId: "session_dispatch_1",
			budget: { tokens: 100 },
			quota,
			hostAttemptRunner: async (attempt, options) => {
				const snapshot = await harness.queue.snapshot();
				if (!snapshot.ok) return snapshot;
				observedQueueState = snapshot.value.entries[0]?.state;
				observedAttempt =
					(await harness.session.getFoundationObject("attempt", attempt.attemptId))?.kind === "fact";
				return Result.ok({
					usage: { tokens: 7, wallClockMs: 12 },
					receipt: providerReceipt(attempt, options),
				});
			},
		});
		expect(registered.ok).toBe(true);
		const controller = new SchedulerDispatchController({
			session: harness.session,
			queue: harness.queue,
			registry,
			sessionId: "session_dispatch_1",
			ownerId: OWNER_ID,
			now: () => NOW,
		});
		const executed = await controller.dispatchClaimed({
			queueEntryId: "queue_dispatch_1",
			fencingToken: harness.claim.fencingToken,
			binding: harness.binding,
		});
		expect(executed.ok).toBe(true);
		if (!executed.ok) return;
		expect(observedQueueState).toBe("dispatched");
		expect(observedAttempt).toBe(true);
		expect(executed.value.providerId).toBe(SCHEDULER_IN_PROCESS_PROVIDER_ID);
		expect(executed.value.selection.chosenProviderId).toBe(SCHEDULER_IN_PROCESS_PROVIDER_ID);
		expect(executed.value.dispatchRecord).toMatchObject({
			status: "in_flight",
			attemptId: executed.value.attempt.attemptId,
		});
		expect(executed.value.attempt.agentInstanceId).toBeUndefined();
		expect(executed.value.receipt.agentInstanceId).toBeUndefined();
		expect(executed.value.receipt.artifacts).toEqual([ARTIFACT]);
		expect(quota.reserved).toMatchObject({
			taskId: "task_dispatch_1",
			attemptId: executed.value.attempt.attemptId,
			providerId: SCHEDULER_IN_PROCESS_PROVIDER_ID,
			ownerKind: "host",
		});
		expect(quota.settled).toEqual({ tokens: 7, wallClockMs: 12 });
		for (const objectType of ["agent_binding", "binding_epoch", "dispatch", "attempt", "attempt_receipt"]) {
			const records = await harness.session.findFoundationRecords({ kind: "fact", objectType });
			expect(records).toHaveLength(1);
		}
		expect(await harness.session.findFoundationRecords({ kind: "fact", objectType: "task_result" })).toEqual([]);
		expect(await harness.session.findFoundationRecords({ kind: "fact", objectType: "run_receipt" })).toEqual([]);
		expect(executed.value).not.toHaveProperty("taskResult");
		expect(executed.value).not.toHaveProperty("runReceipt");
	});

	it("repairs claimed plus in_flight after a queue crash and resumes through the provider", async () => {
		const session = new Session(new InMemorySessionStorage({ id: "session_dispatch_1", createdAt: 1 }));
		const ledger = new FailDispatchedEntryLedger(session);
		const harness = await claimedHarness({ session, ledger });
		const firstProvider = new ScriptedTaskExecutor("success");
		const firstRegistry = new SchedulerExecutorRegistry();
		await registerScripted(firstRegistry, firstProvider);
		const firstController = new SchedulerDispatchController({
			session,
			queue: harness.queue,
			registry: firstRegistry,
			sessionId: "session_dispatch_1",
			ownerId: OWNER_ID,
			now: () => NOW,
		});
		ledger.failDispatchedEntry = true;
		expectCode(
			await firstController.dispatchClaimed({
				queueEntryId: "queue_dispatch_1",
				fencingToken: harness.claim.fencingToken,
				binding: harness.binding,
			}),
			"scheduler_persistence_failed",
		);
		expect(firstProvider.runCount).toBe(0);
		const crashed = await harness.queue.snapshot();
		expect(crashed.ok).toBe(true);
		if (!crashed.ok) return;
		expect(crashed.value.entries[0]?.state).toBe("claimed");
		expect(crashed.value.dispatches[0]?.status).toBe("in_flight");

		const resumedProvider = new ResumableTaskExecutor("queue_dispatch_1", "claim_dispatch_1");
		const resumedRegistry = new SchedulerExecutorRegistry();
		await registerScripted(resumedRegistry, resumedProvider);
		const resumedQueue = new SchedulerQueueStore({
			ledger,
			sessionId: "session_dispatch_1",
			ownerId: OWNER_ID,
			now: () => NOW,
		});
		const resumedController = new SchedulerDispatchController({
			session,
			queue: resumedQueue,
			registry: resumedRegistry,
			sessionId: "session_dispatch_1",
			ownerId: OWNER_ID,
			now: () => NOW,
		});
		const resumed = await resumedController.dispatchClaimed({
			queueEntryId: "queue_dispatch_1",
			fencingToken: harness.claim.fencingToken,
			binding: harness.binding,
		});
		expect(resumed.ok).toBe(true);
		if (!resumed.ok) return;
		expect(resumedProvider.resumeCount).toBe(1);
		expect(resumedProvider.runCount).toBe(0);
		expect(resumed.value.entry.state).toBe("dispatched");
		expect(resumed.value.receipt.status).toBe("succeeded");
	});

	it("fails closed when an in_flight provider cannot resume", async () => {
		const session = new Session(new InMemorySessionStorage({ id: "session_dispatch_1", createdAt: 1 }));
		const ledger = new FailDispatchedEntryLedger(session);
		const harness = await claimedHarness({ session, ledger });
		const firstProvider = new ScriptedTaskExecutor("success");
		const firstRegistry = new SchedulerExecutorRegistry();
		await registerScripted(firstRegistry, firstProvider);
		const firstController = new SchedulerDispatchController({
			session,
			queue: harness.queue,
			registry: firstRegistry,
			sessionId: "session_dispatch_1",
			ownerId: OWNER_ID,
			now: () => NOW,
		});
		ledger.failDispatchedEntry = true;
		expect(
			(
				await firstController.dispatchClaimed({
					queueEntryId: "queue_dispatch_1",
					fencingToken: harness.claim.fencingToken,
					binding: harness.binding,
				})
			).ok,
		).toBe(false);

		const unsupported = new ScriptedTaskExecutor("success");
		const registry = new SchedulerExecutorRegistry();
		await registerScripted(registry, unsupported);
		const queue = new SchedulerQueueStore({
			ledger,
			sessionId: "session_dispatch_1",
			ownerId: OWNER_ID,
			now: () => NOW,
		});
		const controller = new SchedulerDispatchController({
			session,
			queue,
			registry,
			sessionId: "session_dispatch_1",
			ownerId: OWNER_ID,
			now: () => NOW,
		});
		const result = await controller.dispatchClaimed({
			queueEntryId: "queue_dispatch_1",
			fencingToken: harness.claim.fencingToken,
			binding: harness.binding,
		});
		expectCode(result, "scheduler_attempt_recovery_failed");
		expect(unsupported.runCount).toBe(0);
	});

	it("routes explicit cancellation and an expired deadline through cancelAttempt", async () => {
		const explicit = await claimedHarness();
		const blockingProvider = new ScriptedTaskExecutor("block");
		const explicitRegistry = new SchedulerExecutorRegistry();
		await registerScripted(explicitRegistry, blockingProvider);
		const explicitController = new SchedulerDispatchController({
			session: explicit.session,
			queue: explicit.queue,
			registry: explicitRegistry,
			sessionId: "session_dispatch_1",
			ownerId: OWNER_ID,
			now: () => NOW,
		});
		const pending = explicitController.dispatchClaimed({
			queueEntryId: "queue_dispatch_1",
			fencingToken: explicit.claim.fencingToken,
			binding: explicit.binding,
		});
		await blockingProvider.started;
		const cancelled = await explicitController.cancelDispatch("queue_dispatch_1", explicit.claim.fencingToken);
		expect(cancelled.ok).toBe(true);
		const explicitOutcome = await pending;
		expect(explicitOutcome.ok).toBe(true);
		if (explicitOutcome.ok) expect(explicitOutcome.value.receipt.status).toBe("cancelled");
		expect(blockingProvider.cancelCount).toBe(1);

		const deadline = await claimedHarness({ deadlineAt: NOW });
		const deadlineProvider = new ScriptedTaskExecutor("success");
		const deadlineRegistry = new SchedulerExecutorRegistry();
		await registerScripted(deadlineRegistry, deadlineProvider);
		const deadlineController = new SchedulerDispatchController({
			session: deadline.session,
			queue: deadline.queue,
			registry: deadlineRegistry,
			sessionId: "session_dispatch_1",
			ownerId: OWNER_ID,
			now: () => NOW,
		});
		const deadlineOutcome = await deadlineController.dispatchClaimed({
			queueEntryId: "queue_dispatch_1",
			fencingToken: deadline.claim.fencingToken,
			binding: deadline.binding,
		});
		expect(deadlineOutcome.ok).toBe(true);
		if (deadlineOutcome.ok) {
			expect(deadlineOutcome.value.dispatch.deadlineAt).toBe(NOW);
			expect(deadlineOutcome.value.receipt.status).toBe("cancelled");
		}
		expect(deadlineProvider.cancelCount).toBe(1);
	});

	it("retains a durable reservation when provider cancellation is non-terminal", async () => {
		const harness = await claimedHarness();
		const store = new SchedulerSelectionReservationStore(harness.session, {
			ownerId: OWNER_ID,
			now: () => NOW,
		});
		const registry = new SchedulerExecutorRegistry({ reservationStore: store });
		const quota = new RecordingQuota();
		const provider = new ScriptedTaskExecutor("block");
		provider.cancelFails = true;
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
			maxConcurrency: 1,
			runtimeSnapshot: runtimeSnapshot(provider.providerId, harness.binding),
			quota,
			budget: { tokens: 100 },
		});
		expect(registered.ok).toBe(true);
		const controller = new SchedulerDispatchController({
			session: harness.session,
			queue: harness.queue,
			registry,
			sessionId: "session_dispatch_1",
			ownerId: OWNER_ID,
			now: () => NOW,
		});
		const pending = controller.dispatchClaimed({
			queueEntryId: "queue_dispatch_1",
			fencingToken: harness.claim.fencingToken,
			binding: harness.binding,
			executorRequirements: { requireResume: true, modelAccess: "aos_gateway" },
		});
		await provider.started;
		const cancelled = await controller.cancelDispatch("queue_dispatch_1", harness.claim.fencingToken);
		expectCode(cancelled, "worker_lost");
		expect(quota.settleCount).toBe(0);
		const retained = await registry.reservationRecord("queue_dispatch_1");
		expect(retained.ok).toBe(true);
		if (retained.ok) expect(retained.value?.status).toBe("reserved");
		const activeReconcile = await registry.reconcileReservations(["queue_dispatch_1"]);
		expect(activeReconcile.ok).toBe(true);
		expect(quota.settleCount).toBe(0);

		provider.finish();
		const completed = await pending;
		expect(completed.ok).toBe(true);
		expect(quota.settleCount).toBe(1);
		expect(quota.settled).toEqual({ tokens: 7, costUsd: 0.5 });
		const terminal = await registry.reservationRecord("queue_dispatch_1");
		expect(terminal.ok).toBe(true);
		if (terminal.ok) expect(terminal.value?.status).toBe("settled");
		await store.release();
	});

	it("routes Run cancellation through the registered observer to provider cancelAttempt", async () => {
		const harness = await claimedHarness();
		const provider = new ScriptedTaskExecutor("block");
		const registry = new SchedulerExecutorRegistry();
		await registerScripted(registry, provider);
		const runSession = SessionManager.inMemory("/workspace/scheduler-run-cancel", {
			id: "session_dispatch_1",
		});
		const controller = new SchedulerDispatchController({
			session: harness.session,
			queue: harness.queue,
			registry,
			sessionId: "session_dispatch_1",
			ownerId: OWNER_ID,
			now: () => NOW,
			runLifecycleSession: runSession,
		});
		try {
			const coordinator = createRunLifecycleCoordinator(runSession, { diagnostics: () => {} });
			const run = coordinator.reserve().accept({ runId: "run-dispatch-cancel", attempt: 1, model: RUN_MODEL });
			run.start();
			run.requestCancel();
			const pending = controller.dispatchRunClaimed({
				runId: run.runId,
				queueEntryId: "queue_dispatch_1",
				fencingToken: harness.claim.fencingToken,
				binding: harness.binding,
			});
			await provider.started;
			const outcome = await pending;
			expect(outcome.ok).toBe(true);
			if (outcome.ok) expect(outcome.value.receipt.status).toBe("cancelled");
			expect(provider.cancelCount).toBe(1);
			await observeCanonicalTerminal(runSession, run, { outcome: "cancelled" });
			expect(coordinator.getRun(run.runId)?.record.status).toBe("cancelled");
		} finally {
			controller.dispose();
		}
	});

	it("routes Run deadline intent through the registered observer to provider cancelAttempt", async () => {
		const harness = await claimedHarness();
		const provider = new ScriptedTaskExecutor("block");
		const registry = new SchedulerExecutorRegistry();
		await registerScripted(registry, provider);
		const runSession = SessionManager.inMemory("/workspace/scheduler-run-deadline", {
			id: "session_dispatch_1",
		});
		const controller = new SchedulerDispatchController({
			session: harness.session,
			queue: harness.queue,
			registry,
			sessionId: "session_dispatch_1",
			ownerId: OWNER_ID,
			now: () => NOW,
			runLifecycleSession: runSession,
		});
		try {
			const coordinator = createRunLifecycleCoordinator(runSession, { diagnostics: () => {} });
			const run = coordinator.reserve().accept({ runId: "run-dispatch-deadline", attempt: 1, model: RUN_MODEL });
			run.start();
			const pending = controller.dispatchRunClaimed({
				runId: run.runId,
				queueEntryId: "queue_dispatch_1",
				fencingToken: harness.claim.fencingToken,
				binding: harness.binding,
			});
			await provider.started;
			run.requestDeadlineExceeded();
			const outcome = await pending;
			expect(outcome.ok).toBe(true);
			if (outcome.ok) expect(outcome.value.receipt.status).toBe("cancelled");
			expect(provider.cancelCount).toBe(1);
			await observeCanonicalTerminal(runSession, run, {
				outcome: "failed",
				terminalErrorCode: "run_deadline_exceeded",
			});
			expect(coordinator.getRun(run.runId)?.record).toMatchObject({
				status: "failed",
				terminalError: { code: "run_deadline_exceeded" },
			});
		} finally {
			controller.dispose();
		}
	});

	it("cancels a live Scheduler Attempt after Run terminal without rewriting Run facts", async () => {
		const harness = await claimedHarness();
		const provider = new ScriptedTaskExecutor("block");
		const registry = new SchedulerExecutorRegistry();
		await registerScripted(registry, provider);
		const runSession = SessionManager.inMemory("/workspace/scheduler-run-terminal", {
			id: "session_dispatch_1",
		});
		const controller = new SchedulerDispatchController({
			session: harness.session,
			queue: harness.queue,
			registry,
			sessionId: "session_dispatch_1",
			ownerId: OWNER_ID,
			now: () => NOW,
			runLifecycleSession: runSession,
		});
		try {
			const coordinator = createRunLifecycleCoordinator(runSession, { diagnostics: () => {} });
			const run = coordinator.reserve().accept({ runId: "run-dispatch-terminal", attempt: 1, model: RUN_MODEL });
			run.start();
			const pending = controller.dispatchRunClaimed({
				runId: run.runId,
				queueEntryId: "queue_dispatch_1",
				fencingToken: harness.claim.fencingToken,
				binding: harness.binding,
			});
			await provider.started;
			await observeCanonicalTerminal(runSession, run, { outcome: "completed" });
			const outcome = await pending;
			expect(outcome.ok).toBe(true);
			if (outcome.ok) expect(outcome.value.receipt.status).toBe("cancelled");
			expect(provider.cancelCount).toBe(1);
			expect(coordinator.getRun(run.runId)).toMatchObject({
				record: { status: "completed" },
				receipt: { status: "completed" },
			});
			expect(
				runSession.getEntries().filter((entry) => entry.type === "custom" && entry.customType === "automation.run"),
			).toHaveLength(0);
		} finally {
			controller.dispose();
		}
	});

	it("fails closed on cross-Session or conflicting Scheduler observer ownership", async () => {
		const harness = await claimedHarness();
		const registry = new SchedulerExecutorRegistry();
		const foreignRunSession = SessionManager.inMemory("/workspace/scheduler-run-foreign", {
			id: "session_dispatch_foreign",
		});
		expect(
			() =>
				new SchedulerDispatchController({
					session: harness.session,
					queue: harness.queue,
					registry,
					sessionId: "session_dispatch_1",
					ownerId: OWNER_ID,
					runLifecycleSession: foreignRunSession,
				}),
		).toThrow(expect.objectContaining({ code: "service_conflict" }));

		const runSession = SessionManager.inMemory("/workspace/scheduler-run-owner", {
			id: "session_dispatch_1",
		});
		const owner = new SchedulerDispatchController({
			session: harness.session,
			queue: harness.queue,
			registry,
			sessionId: "session_dispatch_1",
			ownerId: OWNER_ID,
			runLifecycleSession: runSession,
		});
		try {
			expect(
				() =>
					new SchedulerDispatchController({
						session: harness.session,
						queue: harness.queue,
						registry,
						sessionId: "session_dispatch_1",
						ownerId: OWNER_ID,
						runLifecycleSession: runSession,
					}),
			).toThrow(expect.objectContaining({ code: "service_conflict" }));
		} finally {
			owner.dispose();
		}
	});

	it("preserves stale-fence rejection across claim expiry and deterministic redispatch", async () => {
		let currentNow = NOW;
		let controller: SchedulerDispatchController | undefined;
		const session = new Session(new InMemorySessionStorage({ id: "session_dispatch_1", createdAt: 1 }));
		const currentBinding = binding();
		await seedBindingFacts(session, currentBinding);
		const queue = new SchedulerQueueStore({
			ledger: session,
			sessionId: "session_dispatch_1",
			ownerId: OWNER_ID,
			now: () => currentNow,
			cancelAttempt: async (attemptId) =>
				controller === undefined
					? Result.err(new FoundationError("scheduler_attempt_recovery_failed", "Controller unavailable"))
					: controller.cancelAttempt(attemptId),
		});
		expect((await queue.enqueue(queued())).ok).toBe(true);
		const firstClaim = await queue.claim({
			queueEntryId: "queue_dispatch_1",
			ownerId: OWNER_ID,
			claimId: "claim_dispatch_1",
			fencingToken: "fence_dispatch_1",
			ttlMs: 60_000,
		});
		if (!firstClaim.ok) throw firstClaim.error;
		const provider = new ScriptedTaskExecutor("fail");
		const registry = new SchedulerExecutorRegistry();
		await registerScripted(registry, provider);
		controller = new SchedulerDispatchController({
			session,
			queue,
			registry,
			sessionId: "session_dispatch_1",
			ownerId: OWNER_ID,
			now: () => currentNow,
		});
		const first = await controller.dispatchClaimed({
			queueEntryId: "queue_dispatch_1",
			fencingToken: firstClaim.value.claim.fencingToken,
			binding: currentBinding,
		});
		expectCode(first, "worker_lost");
		const firstIds = schedulerDispatchIdentityV1("queue_dispatch_1", "claim_dispatch_1");
		currentNow = LATER;
		const recovered = await queue.recoverExpired();
		expect(recovered.ok).toBe(true);
		expect(provider.cancelCount).toBe(1);
		const secondClaim = await queue.claim({
			queueEntryId: "queue_dispatch_1",
			ownerId: OWNER_ID,
			claimId: "claim_dispatch_2",
			fencingToken: "fence_dispatch_2",
		});
		if (!secondClaim.ok) throw secondClaim.error;
		expectCode(
			await controller.dispatchClaimed({
				queueEntryId: "queue_dispatch_1",
				fencingToken: "fence_dispatch_1",
				binding: currentBinding,
			}),
			"scheduler_lease_lost",
		);
		provider.mode = "success";
		const second = await controller.dispatchClaimed({
			queueEntryId: "queue_dispatch_1",
			fencingToken: secondClaim.value.claim.fencingToken,
			binding: currentBinding,
		});
		expect(second.ok).toBe(true);
		if (!second.ok) return;
		expect(second.value.dispatch.dispatchId).not.toBe(firstIds.dispatchId);
		expect(second.value.dispatch.dispatchId).toBe(
			schedulerDispatchIdentityV1("queue_dispatch_1", "claim_dispatch_2").dispatchId,
		);
	});
});
