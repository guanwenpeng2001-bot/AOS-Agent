import { describe, expect, it } from "vitest";
import {
	createAgentInstance,
	createAttempt,
	createBindingEpoch,
	createModelProfileRevision,
	createRoleRevision,
	createTaskEnvelope,
	executeDispatch,
	fingerprintFoundationValue,
	FoundationError,
	InMemorySessionStorage,
	LayeredResultSettlement,
	resolveAgentBinding,
	Result,
	Session,
	SessionLedger,
	SessionLedgerWriter,
	type AgentBinding,
	type AgentInstance,
	type ArtifactDescriptor,
	type ArtifactRef,
	type ArtifactStoreProvider,
	type AttemptReceipt,
	type Attempt,
	type BindingEpoch,
	type Dispatch,
	type FoundationProviderCapability,
	type FoundationProviderExecutionOptions,
	type ModelProfile,
	type Result as ResultValue,
	type RevisionReference,
	type RoleRevision,
	type TaskEnvelope,
	type TaskExecutorAttemptContext,
	type TaskExecutorProvider,
} from "@aos-agent/agent-core";
import {
	projectSafeChildResult,
	settleChildTaskResult,
	validateSafeChildResultProjection,
	type ChildResultTransportHost,
	type ChildTaskSettlementAdapterInput,
} from "../src/core/subagent-result.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const NOW_MS = Date.parse(NOW);
const CHILD_LANE = "child-source-lane";
const PARENT_LANE = "parent-host-lane";
const ARTIFACT: ArtifactRef = {
	schemaVersion: 1,
	artifactId: "artifact-result",
	mediaType: "text/plain",
	digest: `sha256:${"a".repeat(64)}`,
};

function must<T>(result: ResultValue<T, FoundationError>): T {
	if (!result.ok) throw result.error;
	return result.value;
}

function task(taskId = "child-task"): TaskEnvelope {
	return must(createTaskEnvelope({
		schemaVersion: 1,
		taskId,
		goalId: "goal-result",
		goal: "produce a child result through the Foundation gates",
		workspace: "workspace-result",
		capabilityRefs: [],
		inputs: [],
		expectedOutputs: [ARTIFACT],
		budget: {},
		acceptanceCriteria: [],
		status: "ready",
		createdAt: NOW,
		updatedAt: NOW,
	}));
}

function roleRevision(): RoleRevision {
	return createRoleRevision({
		definition: {
			schemaVersion: 1,
			roleId: "role-result",
			scope: "project",
			slug: "result-worker",
			name: "Result worker",
			description: "Produces Foundation test receipts",
			revision: 1,
			persona: "execute the task",
			modelProfileRef: { schemaVersion: 1, type: "model_profile", id: "profile-result", revision: 1 },
			capabilitySelector: { policy: "none" },
			skillSelector: { policy: "none" },
			mcpSelector: { policy: "none" },
		},
		now: () => NOW,
	});
}

function modelProfile(): ModelProfile {
	return createModelProfileRevision({
		schemaVersion: 1,
		modelProfileId: "profile-result",
		provider: "fake",
		model: "fake-model",
		budget: {},
		revision: 1,
		createdAt: NOW,
	});
}

function immutableFact(type: string, id: string): RevisionReference {
	const value = { schemaVersion: 1 as const, type, id, revision: 1 };
	return { ...value, fingerprint: fingerprintFoundationValue(value) };
}

function binding(taskValue: TaskEnvelope): AgentBinding {
	return must(resolveAgentBinding({
		task: taskValue,
		roleRevision: roleRevision(),
		modelProfile: modelProfile(),
		contextRevision: immutableFact("external_agent_binding", "external-result"),
		capabilityRevision: immutableFact("capability_binding", "capability-result"),
		modelBrokerBindingRevision: immutableFact("model_broker_binding", "broker-result"),
		policyRevision: immutableFact("policy_binding", "policy-result"),
		newBindingId: "binding-result",
		now: () => NOW,
	}));
}

class FakeArtifactStore implements ArtifactStoreProvider {
	readonly schemaVersion = 1 as const;
	readonly providerId = "artifact-store-result";
	readonly providerClass = "store" as const;
	readonly validArtifactIds = new Set([ARTIFACT.artifactId]);
	readonly verifyCalls: string[] = [];

	async capabilities(): Promise<readonly FoundationProviderCapability[]> {
		return [{ schemaVersion: 1, id: "artifact.verify", version: 1 }];
	}

	async put(descriptor: ArtifactDescriptor, data: Uint8Array) {
		this.validArtifactIds.add(descriptor.artifactId);
		return Result.ok({ schemaVersion: 1 as const, ref: descriptor.artifactId, sizeBytes: data.byteLength });
	}

	async get(ref: string): Promise<ResultValue<Uint8Array, FoundationError>> {
		return this.validArtifactIds.has(ref)
			? Result.ok(new Uint8Array())
			: Result.err(new FoundationError("worker_unavailable", "artifact not found"));
	}

	async verify(artifactId: string) {
		this.verifyCalls.push(artifactId);
		return Result.ok({ schemaVersion: 1 as const, digestValid: this.validArtifactIds.has(artifactId) });
	}

	async delete(artifactId: string): Promise<ResultValue<void, FoundationError>> {
		this.validArtifactIds.delete(artifactId);
		return Result.ok(undefined);
	}

	async dispose(): Promise<void> {}
}

class FakeAgentExecutor implements TaskExecutorProvider {
	readonly schemaVersion = 1 as const;
	readonly providerId = "agent-result";
	readonly providerClass = "agent" as const;
	readonly failedAttempts = new Set<string>();
	forcedReceiptId: string | undefined;

	async capabilities(): Promise<readonly FoundationProviderCapability[]> {
		return [{ schemaVersion: 1, id: "agent.execute", version: 1 }];
	}

	async createAttempt(
		dispatch: Dispatch,
		_binding: AgentBinding,
		context?: TaskExecutorAttemptContext,
	): Promise<ResultValue<Attempt, FoundationError>> {
		if (context?.agentInstance === undefined) return Result.err(new FoundationError("agent_instance_required_for_agent_provider", "missing AgentInstance"));
		return createAttempt({
			attemptId: context.initialBindingEpoch.attemptId,
			dispatch,
			providerId: this.providerId,
			initialBindingEpoch: context.initialBindingEpoch,
			providerClass: "agent",
			agentInstanceId: context.agentInstance.agentInstanceId,
			now: () => NOW,
		});
	}

	async runAttempt(
		attempt: Attempt,
		options?: FoundationProviderExecutionOptions,
	): Promise<ResultValue<AttemptReceipt, FoundationError>> {
		if (options?.correlation === undefined || attempt.agentInstanceId === undefined) {
			return Result.err(new FoundationError("invalid_correlation", "missing execution correlation"));
		}
		const attemptReceiptId = this.forcedReceiptId ?? `receipt-${attempt.attemptId}`;
		const failed = this.failedAttempts.has(attempt.attemptId);
		return Result.ok({
			schemaVersion: 1,
			attemptReceiptId,
			taskId: attempt.taskId,
			dispatchId: attempt.dispatchId,
			attemptId: attempt.attemptId,
			providerId: this.providerId,
			agentInstanceId: attempt.agentInstanceId,
			bindingId: attempt.bindingId,
			bindingEpochIds: [...attempt.bindingEpochIds],
			status: failed ? "failed" : "succeeded",
			workerReceiptRefs: [],
			artifacts: failed ? [] : [ARTIFACT],
			provenance: {
				producerKind: "agent_executor",
				providerId: this.providerId,
				producedAt: NOW,
				correlation: {
					...options.correlation,
					taskId: attempt.taskId,
					dispatchId: attempt.dispatchId,
					attemptId: attempt.attemptId,
					agentInstanceId: attempt.agentInstanceId,
					attemptReceiptId,
				},
			},
			sideEffectState: "none",
			...(failed ? { error: { code: "tool_execution_failed", message: "fake failure", retryable: false } } : {}),
		});
	}

	async cancelAttempt(): Promise<ResultValue<void, FoundationError>> {
		return Result.ok(undefined);
	}

	async dispose(): Promise<void> {}
}

interface Fixture {
	readonly session: Session;
	readonly sessionId: string;
	readonly task: TaskEnvelope;
	readonly binding: AgentBinding;
	readonly agent: AgentInstance;
	readonly provider: FakeAgentExecutor;
	readonly childWriter: SessionLedgerWriter;
	readonly childGate: LayeredResultSettlement;
	readonly artifactStore: FakeArtifactStore;
}

async function fixture(sessionId: string): Promise<Fixture> {
	const session = new Session(new InMemorySessionStorage({ id: sessionId, createdAt: 1 }));
	const childWriter = new SessionLedgerWriter(session, { ownerId: `${sessionId}-child-writer`, lane: CHILD_LANE });
	const ledger = new SessionLedger(session, { writer: childWriter });
	const taskValue = task();
	const bindingValue = binding(taskValue);
	await ledger.appendFact("task", taskValue.taskId, taskValue, { clientRequestId: "seed:task", expectedRevision: 0, correlation: { taskId: taskValue.taskId } });
	await ledger.appendFact("role_revision", bindingValue.roleRevision.id, roleRevision(), { clientRequestId: "seed:role", expectedRevision: 0, correlation: { taskId: taskValue.taskId, bindingId: bindingValue.bindingId } });
	await ledger.appendFact("model_profile_revision", bindingValue.modelProfileRevision.id, modelProfile(), { clientRequestId: "seed:model", expectedRevision: 0, correlation: { taskId: taskValue.taskId, bindingId: bindingValue.bindingId } });
	for (const [objectType, reference] of [
		["external_agent_binding", bindingValue.contextRevision],
		["capability_binding", bindingValue.capabilityRevision],
		["model_broker_binding", bindingValue.modelBrokerBindingRevision],
		["policy_binding", bindingValue.policyRevision],
	] as const) {
		await ledger.appendFact(objectType, reference.id, { schemaVersion: 1, type: reference.type, id: reference.id, revision: reference.revision }, {
			clientRequestId: `seed:${objectType}`,
			expectedRevision: 0,
			correlation: { taskId: taskValue.taskId, bindingId: bindingValue.bindingId },
		});
	}
	const agent = must(createAgentInstance({
		agentInstanceId: "child-agent",
		providerId: "agent-result",
		providerDeclaredAgent: true,
		roleRevision: roleRevision(),
		taskId: taskValue.taskId,
		now: () => NOW,
	}));
	return {
		session,
		sessionId,
		task: taskValue,
		binding: bindingValue,
		agent,
		provider: new FakeAgentExecutor(),
		childWriter,
		childGate: new LayeredResultSettlement(session, { writer: childWriter }),
		artifactStore: new FakeArtifactStore(),
	};
}

function dispatchInput(value: Fixture, ordinal: number): {
	readonly dispatch: Dispatch;
	readonly epoch: BindingEpoch;
	readonly correlation: NonNullable<AttemptReceipt["provenance"]["correlation"]>;
} {
	const attemptId = `attempt-${ordinal}`;
	const dispatch: Dispatch = {
		schemaVersion: 1,
		dispatchId: `dispatch-${ordinal}`,
		taskId: value.task.taskId,
		bindingId: value.binding.bindingId,
		taskExecutorProviderId: value.provider.providerId,
		status: "pending",
		createdAt: NOW,
	};
	const epoch = must(createBindingEpoch({
		bindingEpochId: `epoch-${ordinal}`,
		taskId: value.task.taskId,
		attemptId,
		bindingId: value.binding.bindingId,
		agentInstanceId: value.agent.agentInstanceId,
		activationReason: "attempt_started",
		activatedByCommandId: `command-${ordinal}`,
		now: () => NOW,
	}));
	return {
		dispatch,
		epoch,
		correlation: {
			sessionId: value.sessionId,
			laneId: CHILD_LANE,
			taskId: value.task.taskId,
			dispatchId: dispatch.dispatchId,
			attemptId,
			bindingId: value.binding.bindingId,
			bindingEpochId: epoch.bindingEpochId,
			agentInstanceId: value.agent.agentInstanceId,
			revision: 1,
		},
	};
}

async function executeReceipt(value: Fixture, ordinal: number, status: "succeeded" | "failed" = "succeeded"): Promise<AttemptReceipt> {
	const input = dispatchInput(value, ordinal);
	if (status === "failed") value.provider.failedAttempts.add(input.epoch.attemptId);
	const executed = await value.childGate.executeDispatch({
		provider: value.provider,
		dispatch: input.dispatch,
		binding: value.binding,
		initialBindingEpoch: input.epoch,
		agentInstance: value.agent,
		correlation: input.correlation,
	});
	if (!executed.ok) throw executed.error;
	return executed.value.receipt;
}

async function executeRawReceipt(value: Fixture, ordinal: number): Promise<AttemptReceipt> {
	const input = dispatchInput(value, ordinal);
	const executed = await executeDispatch({
		provider: value.provider,
		dispatch: input.dispatch,
		binding: value.binding,
		initialBindingEpoch: input.epoch,
		agentInstance: value.agent,
		correlation: input.correlation,
	});
	if (!executed.ok) throw executed.error;
	return executed.value.receipt;
}

interface ParentHost {
	readonly writer: SessionLedgerWriter;
	readonly gate: LayeredResultSettlement;
	readonly ledger: SessionLedger;
}

async function openParentHost(value: Fixture): Promise<ParentHost> {
	await value.childWriter.releaseLease();
	const writer = new SessionLedgerWriter(value.session, { ownerId: `${value.sessionId}-parent-writer`, lane: PARENT_LANE });
	return {
		writer,
		gate: new LayeredResultSettlement(value.session, { writer }),
		ledger: new SessionLedger(value.session, { writer }),
	};
}

function settlementInput(
	value: Fixture,
	receipts: readonly AttemptReceipt[],
	taskResultId: string,
	policy: ChildTaskSettlementAdapterInput["policy"],
	summary = `summary for ${taskResultId}`,
): ChildTaskSettlementAdapterInput {
	const first = receipts[0];
	if (first === undefined || first.provenance.correlation === undefined) throw new Error("settlement requires a correlated source receipt");
	return {
		taskResultId,
		task: value.task,
		receipts,
		policy,
		summary,
		artifacts: [ARTIFACT],
		tests: [{ name: "fake-provider-output", required: true, status: "passed", evidenceRefs: [ARTIFACT] }],
		evidence: [],
		producer: {
			producerKind: "host",
			providerId: "parent-host",
			producedAt: NOW,
			correlation: {
				...first.provenance.correlation,
				laneId: PARENT_LANE,
				attemptReceiptId: first.attemptReceiptId,
				taskResultId,
				revision: 1,
			},
		},
	};
}

async function projectionFixture(id: string, receiptCount = 1, settledReceiptCount = receiptCount, summary?: string) {
	const value = await fixture(id);
	const receipts: AttemptReceipt[] = [];
	for (let ordinal = 1; ordinal <= receiptCount; ordinal += 1) receipts.push(await executeReceipt(value, ordinal));
	const taskResultId = `${id}-task-result`;
	const parent = await openParentHost(value);
	const settled = await settleChildTaskResult(parent.gate, settlementInput(value, receipts.slice(0, settledReceiptCount), taskResultId, { type: "all_succeed" }, summary));
	if (!settled.ok) throw settled.error;
	const host: ChildResultTransportHost = {
		artifactStore: value.artifactStore,
		ledger: parent.ledger,
		sessionId: value.sessionId,
		childLaneId: CHILD_LANE,
		parentLaneId: PARENT_LANE,
		now: () => NOW_MS,
	};
	return { value, receipts, parent, taskResult: settled.value, host };
}

function taskResultTransport(
	value: Awaited<ReturnType<typeof projectionFixture>>,
	sourceReceipts: readonly AttemptReceipt[] = value.receipts,
	taskResult = value.taskResult,
) {
	return {
		schemaVersion: 1 as const,
		type: "task_result" as const,
		childAgentInstanceId: value.value.agent.agentInstanceId,
		taskId: value.value.task.taskId,
		taskResult,
		sourceReceipts,
	};
}

describe("Subagent result transport and Host settlement", () => {
	it("rejects missing and unknown transport keys before projection", async () => {
		const setup = await projectionFixture("result-exact-transport");
		const valid = taskResultTransport(setup);
		const { taskId: _taskId, ...missingTaskId } = valid;
		expect(await projectSafeChildResult(setup.host, missingTaskId)).toMatchObject({ ok: false, error: { code: "subagent_result_untrusted" } });
		expect(await projectSafeChildResult(setup.host, { ...valid, unexpected: true })).toMatchObject({ ok: false, error: { code: "subagent_result_untrusted" } });
		expect(await setup.value.session.findFoundationRecords({ kind: "fact", objectType: "subagent_result_projection" })).toHaveLength(0);
	});

	it("projects a parent-lane Host TaskResult in declared source order and persists one frozen parent projection", async () => {
		const setup = await projectionFixture("result-distinct-lanes", 2);
		const projected = await projectSafeChildResult(setup.host, taskResultTransport(setup, [setup.receipts[1]!, setup.receipts[0]!]));
		expect(projected).toMatchObject({
			ok: true,
			value: {
				attemptReceiptId: setup.receipts[0]?.attemptReceiptId,
				taskResultId: setup.taskResult.taskResultId,
				trust: "untrusted_child_output",
			},
		});
		if (!projected.ok) return;
		expect(Object.isFrozen(projected.value)).toBe(true);
		expect(Object.isFrozen(projected.value.artifacts)).toBe(true);
		expect(Object.isFrozen(projected.value.artifacts[0])).toBe(true);
		const replay = await projectSafeChildResult(setup.host, taskResultTransport(setup));
		expect(replay).toEqual(projected);
		const records = await setup.value.session.findFoundationRecords({ kind: "fact", objectType: "subagent_result_projection" });
		expect(records).toHaveLength(1);
		expect(records[0]).toMatchObject({ lane: PARENT_LANE, revision: 1, correlation: { laneId: PARENT_LANE } });
		expect((await setup.value.session.getFoundationObject("task_result", setup.taskResult.taskResultId))?.lane).toBe(PARENT_LANE);
		expect((await setup.value.session.getFoundationObject("attempt_receipt", setup.receipts[0]!.attemptReceiptId))?.lane).toBe(CHILD_LANE);
	});

	it("truncates multibyte summaries to the UTF-8 byte bound without splitting a character", async () => {
		const setup = await projectionFixture("result-multibyte-summary", 1, 1, "界".repeat(6_000));
		const projected = await projectSafeChildResult(setup.host, taskResultTransport(setup));
		if (!projected.ok) throw projected.error;
		expect(new TextEncoder().encode(projected.value.summary).byteLength).toBeLessThanOrEqual(16_384);
		expect(projected.value.summary.endsWith("\n[TRUNCATED]")).toBe(true);
		expect(projected.value.summary.includes("�")).toBe(false);
	});

	it("rejects missing and tampered durable AttemptReceipt sources", async () => {
		const missing = await projectionFixture("result-missing-receipt");
		await missing.parent.writer.tombstone({ objectType: "attempt_receipt", objectId: missing.receipts[0]!.attemptReceiptId, reason: "negative-test" });
		expect(await projectSafeChildResult(missing.host, taskResultTransport(missing))).toMatchObject({ ok: false, error: { code: "subagent_result_untrusted" } });

		const tampered = await projectionFixture("result-tampered-receipt");
		const changedReceipt: AttemptReceipt = { ...tampered.receipts[0]!, artifacts: [] };
		expect(await projectSafeChildResult(tampered.host, taskResultTransport(tampered, [changedReceipt]))).toMatchObject({ ok: false, error: { code: "subagent_result_untrusted" } });
	});

	it("rejects missing and tampered durable parent Host TaskResult facts", async () => {
		const missing = await projectionFixture("result-missing-task-result");
		await missing.parent.writer.tombstone({ objectType: "task_result", objectId: missing.taskResult.taskResultId, reason: "negative-test" });
		expect(await projectSafeChildResult(missing.host, taskResultTransport(missing))).toMatchObject({ ok: false, error: { code: "subagent_result_untrusted" } });

		const tampered = await projectionFixture("result-tampered-task-result");
		const changedResult = { ...tampered.taskResult, summary: "caller changed the durable summary" };
		expect(await projectSafeChildResult(tampered.host, taskResultTransport(tampered, tampered.receipts, changedResult))).toMatchObject({ ok: false, error: { code: "subagent_result_untrusted" } });
	});

	it("rejects conflicting durable projection content and metadata", async () => {
		for (const conflict of ["content", "metadata"] as const) {
			const setup = await projectionFixture(`result-replay-${conflict}`);
			const receipt = setup.receipts[0]!;
			const base = {
				schemaVersion: 1 as const,
				childAgentInstanceId: setup.value.agent.agentInstanceId,
				attemptReceiptId: receipt.attemptReceiptId,
				taskResultId: setup.taskResult.taskResultId,
				summary: conflict === "content" ? "wrong durable summary" : setup.taskResult.summary,
				artifacts: setup.taskResult.artifacts,
				trust: "untrusted_child_output" as const,
				producedAt: NOW,
			};
			const projection = { ...base, digest: fingerprintFoundationValue(base) };
			await setup.parent.ledger.appendFact("subagent_result_projection", `task-result:${setup.taskResult.taskResultId}`, projection, {
				clientRequestId: `negative-projection-${conflict}`,
				expectedRevision: 0,
				correlation: {
					taskId: setup.value.task.taskId,
					dispatchId: receipt.dispatchId,
					attemptId: conflict === "metadata" ? "wrong-attempt" : receipt.attemptId,
					agentInstanceId: setup.value.agent.agentInstanceId,
					attemptReceiptId: receipt.attemptReceiptId,
					taskResultId: setup.taskResult.taskResultId,
				},
			});
			expect(await projectSafeChildResult(setup.host, taskResultTransport(setup))).toMatchObject({ ok: false, error: { code: "subagent_result_untrusted" } });
		}
	});

	it("uses ArtifactStoreProvider.verify and requires digestValid", async () => {
		const setup = await projectionFixture("result-artifact-verification");
		setup.value.artifactStore.validArtifactIds.clear();
		expect(await projectSafeChildResult(setup.host, taskResultTransport(setup))).toMatchObject({ ok: false, error: { code: "subagent_result_untrusted" } });
		expect(setup.value.artifactStore.verifyCalls).toEqual([ARTIFACT.artifactId]);
	});

	it("returns errors instead of throwing for out-of-range times", async () => {
		const setup = await projectionFixture("result-extreme-time");
		const extremeHost = { ...setup.host, now: () => Number.MAX_VALUE };
		await expect(projectSafeChildResult(extremeHost, taskResultTransport(setup))).resolves.toMatchObject({ ok: false, error: { code: "subagent_result_untrusted" } });
		const base = {
			schemaVersion: 1 as const,
			childAgentInstanceId: "child-agent",
			attemptReceiptId: "receipt",
			summary: "summary",
			artifacts: [],
			trust: "untrusted_child_output" as const,
			producedAt: "+999999-01-01T00:00:00.000Z",
		};
		expect(() => validateSafeChildResultProjection({ ...base, digest: fingerprintFoundationValue(base) })).not.toThrow();
		expect(validateSafeChildResultProjection({ ...base, digest: fingerprintFoundationValue(base) })).toMatchObject({ ok: false });
	});

	it("replays the original projection time when the Host clock changes or becomes invalid", async () => {
		const setup = await projectionFixture("result-time-replay");
		const projected = await projectSafeChildResult(setup.host, taskResultTransport(setup));
		if (!projected.ok) throw projected.error;
		const replayed = await projectSafeChildResult({ ...setup.host, now: () => Number.MAX_VALUE }, taskResultTransport(setup));
		expect(replayed).toEqual(projected);
		expect(replayed.ok && replayed.value.producedAt).toBe(NOW);
	});

	it("enforces all_succeed, quorum, and partial policies through the public Host gate", async () => {
		const value = await fixture("result-policies");
		const succeeded = await executeReceipt(value, 1);
		const failed = await executeReceipt(value, 2, "failed");
		const parent = await openParentHost(value);
		expect(await settleChildTaskResult(parent.gate, settlementInput(value, [succeeded, failed], "all-result", { type: "all_succeed" }))).toMatchObject({ ok: false });
		expect(await settleChildTaskResult(parent.gate, settlementInput(value, [succeeded, failed], "quorum-result", { type: "quorum", minimumSucceeded: 1 }))).toMatchObject({ ok: true, value: { sourceAttemptReceiptIds: [succeeded.attemptReceiptId] } });
		expect(await settleChildTaskResult(parent.gate, settlementInput(value, [succeeded, failed], "partial-result", { type: "partial" }))).toMatchObject({ ok: true, value: { sourceAttemptReceiptIds: [succeeded.attemptReceiptId] } });
		expect(await settleChildTaskResult(parent.gate, settlementInput(value, [succeeded, succeeded], "duplicate-result", { type: "partial" }))).toMatchObject({ ok: false });
	});

	it("rejects non-Host settlement and incomplete or extra declared TaskResult sources", async () => {
		const value = await fixture("result-authority-and-source-set");
		const first = await executeReceipt(value, 1);
		const second = await executeReceipt(value, 2);
		const third = await executeReceipt(value, 3);
		const parent = await openParentHost(value);
		const hostInput = settlementInput(value, [first, second], "authority-result", { type: "all_succeed" });
		const nonHostInput: ChildTaskSettlementAdapterInput = {
			...hostInput,
			producer: { ...hostInput.producer, producerKind: "agent_executor" },
		};
		expect(await settleChildTaskResult(parent.gate, nonHostInput)).toMatchObject({ ok: false, error: { code: "task_result_validation_failed" } });
		const settled = await settleChildTaskResult(parent.gate, hostInput);
		if (!settled.ok) throw settled.error;
		const setup = {
			value,
			receipts: [first, second, third],
			parent,
			taskResult: settled.value,
			host: {
				artifactStore: value.artifactStore,
				ledger: parent.ledger,
				sessionId: value.sessionId,
				childLaneId: CHILD_LANE,
				parentLaneId: PARENT_LANE,
				now: () => NOW_MS,
			} satisfies ChildResultTransportHost,
		};
		expect(await projectSafeChildResult(setup.host, taskResultTransport(setup, [first]))).toMatchObject({ ok: false, error: { code: "subagent_result_untrusted" } });
		expect(await projectSafeChildResult(setup.host, taskResultTransport(setup, [first, second, third]))).toMatchObject({ ok: false, error: { code: "subagent_result_untrusted" } });
	});

	it("rejects conflicting real provider receipts that reuse one id", async () => {
		const value = await fixture("result-conflicting-receipts");
		value.provider.forcedReceiptId = "shared-real-receipt";
		const first = await executeRawReceipt(value, 1);
		const second = await executeRawReceipt(value, 2);
		expect(first.attemptReceiptId).toBe(second.attemptReceiptId);
		expect(first.attemptId).not.toBe(second.attemptId);
		const parent = await openParentHost(value);
		expect(await settleChildTaskResult(parent.gate, settlementInput(value, [first, second], "conflicting-result", { type: "partial" }))).toMatchObject({ ok: false, error: { code: "task_result_validation_failed" } });
	});
});
