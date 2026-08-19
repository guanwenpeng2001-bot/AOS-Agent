import { describe, expect, it } from "vitest";
import * as AgentPublic from "../../src/index.ts";
import { Result, type Result as ResultValue } from "../../src/harness/result.ts";
import { FoundationError } from "../../src/harness/foundation/errors.ts";
import { InMemorySessionStorage, Session } from "../../src/harness/session/index.ts";
import {
	createAgentInstance,
	createBindingEpoch,
	createHostTerminalGateAuthorityV1,
	createModelProfileRevision,
	createRoleRevision,
	createAttempt,
	DurableModelProfileStoreV1,
	DurableRoleRegistryV1,
	executeDispatchV1,
	executeOperationV1,
	fingerprintFoundationValue,
	LayeredResultSettlementV1,
	SessionLedgerV1,
	resolveAgentBinding,
	ROLE_RESOLUTION_ORDER_V1,
	switchAgentModeV1,
	type AgentBindingV1,
	type AttemptReceiptV1,
	type AttemptV1,
	type BindingEpochV1,
	type DispatchV1,
	type FoundationProviderCapabilityV1,
	type FoundationProviderExecutionOptionsV1,
	type ModelProfileV1,
	type RevisionReferenceV1,
	type RoleRevisionV1,
	type ChildAgentProvider,
	type ChildSpawnRequestV1,
	type ChildSpawnResultV1,
	type SandboxOperationProvider,
	type SandboxOperationRequestV1,
	type SchedulerTaskExecutorProvider,
	type TaskEnvelopeV1,
	type TaskExecutorAttemptContextV1,
	type WorkerReceiptV1,
} from "../../src/harness/foundation/index.ts";

const now = "2026-01-01T00:00:00.000Z";
const artifact = { schemaVersion: 1 as const, artifactId: "artifact-1", mediaType: "text/plain", digest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" };
const capability = { schemaVersion: 1 as const, artifactId: "capability-1", mediaType: "application/json", digest: "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" };

function task(taskId = "task-t6"): TaskEnvelopeV1 {
	return { schemaVersion: 1, taskId, goalId: taskId === "task-t6" ? "goal-t6" : `${taskId}-goal`, goal: "exercise the T6 provider consumer", workspace: "workspace-t6", capabilityRefs: [capability], inputs: [], expectedOutputs: [artifact], budget: {}, acceptanceCriteria: [{ schemaVersion: 1, criterionId: "criterion-t6", description: "provider output is accepted", satisfiedBy: "evidence", required: true }], status: "ready", createdAt: now, updatedAt: now };
}

function roleRevision() {
	return createRoleRevision({ definition: { schemaVersion: 1, roleId: "role-t6", scope: "project", slug: "t6", name: "T6", description: "T6 provider", revision: 1, persona: "execute T6", modelProfileRef: { schemaVersion: 1, type: "model_profile", id: "profile-t6", revision: 1 }, capabilitySelector: { policy: "all" }, skillSelector: { policy: "none" }, mcpSelector: { policy: "none" } }, now: () => now });
}

function roleDefinition() {
	return { schemaVersion: 1 as const, roleId: "role-t6", scope: "project" as const, slug: "t6", name: "T6", description: "T6 provider", revision: 1, persona: "execute T6", modelProfileRef: { schemaVersion: 1 as const, type: "model_profile", id: "profile-t6", revision: 1 }, capabilitySelector: { policy: "all" as const }, skillSelector: { policy: "none" as const }, mcpSelector: { policy: "none" as const } };
}

function immutableFact(type: string, id: string, revision = 1): RevisionReferenceV1 {
	const payload = { schemaVersion: 1 as const, type, id, revision };
	return { ...payload, fingerprint: fingerprintFoundationValue(payload) };
}

function modelProfile(revision = 1): ModelProfileV1 {
	return createModelProfileRevision({ schemaVersion: 1, modelProfileId: "profile-t6", provider: "fake", model: "fake-model", budget: {}, revision, createdAt: now });
}

function binding(id = "binding-t6", taskValue = task()): AgentBindingV1 {
	const result = resolveAgentBinding({ task: taskValue, roleRevision: roleRevision(), modelProfile: modelProfile(), contextRevision: immutableFact("external_agent_binding", "external-existing", 1), capabilityRevision: immutableFact("capability_binding", "capability-existing", 1), modelBrokerBindingRevision: immutableFact("model_broker_binding", "model-broker-existing", 1), policyRevision: immutableFact("policy_binding", "policy-existing", 1), newBindingId: id, now: () => now });
	if (!result.ok) throw result.error;
	return result.value;
}

async function seedBindingFacts(session: Session, value: AgentBindingV1): Promise<void> {
	const ledger = new SessionLedgerV1(session, { ownerId: `seed-${value.bindingId}` });
	await ledger.appendFact("task", value.taskId, task(value.taskId), { clientRequestId: `seed:task:${value.taskId}`, expectedRevision: 0, correlation: { taskId: value.taskId } });
	await ledger.appendFact("role_revision", value.roleRevision.id, roleRevision(), { clientRequestId: `seed:role:${value.roleRevision.id}`, expectedRevision: 0, correlation: { taskId: value.taskId, bindingId: value.bindingId } });
	await ledger.appendFact("model_profile_revision", value.modelProfileRevision.id, modelProfile(), { clientRequestId: `seed:model:${value.modelProfileRevision.id}`, expectedRevision: 0, correlation: { taskId: value.taskId, bindingId: value.bindingId } });
	for (const [objectType, reference] of [["external_agent_binding", value.contextRevision], ["capability_binding", value.capabilityRevision], ["model_broker_binding", value.modelBrokerBindingRevision], ["policy_binding", value.policyRevision]] as const) {
		const payload = { schemaVersion: 1 as const, type: reference.type, id: reference.id, revision: reference.revision };
		await ledger.appendFact(objectType, reference.id, payload, { clientRequestId: `seed:${objectType}:${reference.id}`, correlation: { taskId: value.taskId, bindingId: value.bindingId } });
	}
	await ledger.release();
}

async function seedParentSpawnContext(session: Session, parentTaskId: string, parentSpawnId: string): Promise<void> {
	const ledger = new SessionLedgerV1(session, { ownerId: `seed-parent-${parentSpawnId}` });
	await ledger.appendFact("task", parentTaskId, task(parentTaskId), { clientRequestId: `seed:parent-task:${parentTaskId}`, expectedRevision: 0, correlation: { taskId: parentTaskId } });
	const contextId = `context_${parentSpawnId}`;
	await ledger.appendFact("context", contextId, { schemaVersion: 1 as const, contextId, taskId: parentTaskId, spawnId: parentSpawnId, forkScope: "none" as const, lineage: { schemaVersion: 1 as const, entityType: "context", entityId: contextId, depth: 0 }, createdAt: now }, { clientRequestId: `seed:parent-context:${parentSpawnId}`, expectedRevision: 0, correlation: { taskId: parentTaskId } });
	await ledger.release();
}

function dispatch(providerId: string, bindingId = "binding-t6", taskId = "task-t6"): DispatchV1 {
	return { schemaVersion: 1, dispatchId: `dispatch-${providerId}`, taskId, bindingId, taskExecutorProviderId: providerId, status: "pending", createdAt: now };
}

function epoch(providerId: string, providerClass: "scheduler" | "agent" = "scheduler", agentInstanceId?: string): BindingEpochV1 {
	const result = createBindingEpoch({ bindingEpochId: `epoch-${providerId}`, taskId: "task-t6", attemptId: `attempt-${providerId}`, bindingId: "binding-t6", activationReason: "attempt_started", activatedByCommandId: `command-${providerId}`, ...(providerClass === "agent" ? { agentInstanceId } : {}), now: () => now });
	if (!result.ok) throw result.error;
	return result.value;
}

const providerCapability: FoundationProviderCapabilityV1 = { schemaVersion: 1, id: "foundation.t6", version: 1 };

class SchedulerProvider implements SchedulerTaskExecutorProvider {
	readonly schemaVersion = 1 as const;
	readonly providerId = "scheduler-t6";
	readonly providerClass = "scheduler" as const;
	runCount = 0;
	async capabilities(): Promise<readonly FoundationProviderCapabilityV1[]> { return [providerCapability]; }
	async createAttempt(dispatchValue: DispatchV1, _binding: AgentBindingV1, context?: TaskExecutorAttemptContextV1) {
		if (context === undefined) return Result.err(new FoundationError("invalid_correlation", "missing provider context"));
		return createAttempt({ attemptId: context.initialBindingEpoch.attemptId, dispatch: dispatchValue, providerId: this.providerId, initialBindingEpoch: context.initialBindingEpoch, providerClass: this.providerClass, now: () => now });
	}
	async runAttempt(attempt: AttemptV1, options?: FoundationProviderExecutionOptionsV1) {
		this.runCount += 1;
		const correlation = { ...(options?.correlation ?? { sessionId: "session-t6", laneId: "main", revision: 1 }), taskId: attempt.taskId, dispatchId: attempt.dispatchId, attemptId: attempt.attemptId, bindingId: attempt.bindingId, bindingEpochId: attempt.bindingEpochIds[0], attemptReceiptId: "attempt-receipt-t6" };
		return Result.ok<AttemptReceiptV1>({ schemaVersion: 1, attemptReceiptId: "attempt-receipt-t6", taskId: attempt.taskId, dispatchId: attempt.dispatchId, attemptId: attempt.attemptId, providerId: this.providerId, bindingId: attempt.bindingId, bindingEpochIds: [...attempt.bindingEpochIds], status: "succeeded", workerReceiptRefs: [], artifacts: [artifact], provenance: { producerKind: "scheduler", providerId: this.providerId, producedAt: now, correlation }, sideEffectState: "none" });
	}
	async cancelAttempt(_attemptId: string) { return Result.ok(undefined); }
	async dispose() {}
}

class OperationProvider implements SandboxOperationProvider {
	readonly schemaVersion = 1 as const;
	readonly providerId = "worker-t6";
	readonly providerClass = "operation_worker" as const;
	async capabilities(): Promise<readonly FoundationProviderCapabilityV1[]> { return [providerCapability]; }
	async start(request: SandboxOperationRequestV1, options?: FoundationProviderExecutionOptionsV1) {
		const correlation = { ...(options?.correlation ?? { sessionId: "session-t6", laneId: "main", revision: 1 }), taskId: request.taskId, dispatchId: request.dispatchId, attemptId: request.attemptId };
		return Result.ok<WorkerReceiptV1>({ schemaVersion: 1, workerReceiptId: "worker-receipt-t6", sandboxProviderId: this.providerId, operationId: request.operationId, taskId: request.taskId, dispatchId: request.dispatchId, attemptId: request.attemptId, status: "succeeded", sideEffectState: "none", provenance: { producerKind: "operation_worker", providerId: this.providerId, producedAt: now, correlation }, startedAt: now, completedAt: now });
	}
	async cancel(_operationId: string) { return Result.ok(undefined); }
	async dispose() {}
}

class BrokenSchedulerProvider extends SchedulerProvider {
	async runAttempt(attempt: AttemptV1, options?: FoundationProviderExecutionOptionsV1) {
		const result = await super.runAttempt(attempt, options);
		if (!result.ok) return result;
		return Result.ok({ ...result.value, providerId: "wrong-provider", provenance: { ...result.value.provenance, providerId: "wrong-provider" } });
	}
}

class UnknownSideEffectSchedulerProvider extends SchedulerProvider {
	async runAttempt(attempt: AttemptV1, options?: FoundationProviderExecutionOptionsV1) {
		const result = await super.runAttempt(attempt, options);
		if (!result.ok) return result;
		return Result.ok({ ...result.value, sideEffectState: "unknown" as const });
	}
}

class ChildProvider implements ChildAgentProvider {
	readonly schemaVersion = 1 as const;
	readonly providerId: string;
	readonly providerClass = "agent" as const;
	spawnCount = 0;
	lookupCount = 0;
	failSpawn = false;
	receivedRoleRevision: RoleRevisionV1 | undefined;
	receivedModelProfile: ModelProfileV1 | undefined;
	private lastSpawn: ChildSpawnResultV1 | undefined;
	constructor(providerId = "agent-child-t6") { this.providerId = providerId; }
	async capabilities(): Promise<readonly FoundationProviderCapabilityV1[]> { return [providerCapability]; }
	async spawn(request: ChildSpawnRequestV1, _options: FoundationProviderExecutionOptionsV1): Promise<ResultValue<ChildSpawnResultV1, FoundationError>> {
		this.spawnCount += 1;
		this.receivedRoleRevision = request.roleRevision;
		this.receivedModelProfile = request.modelProfile;
		if (this.failSpawn) return Result.err(new FoundationError("provider_spawn_failed", "provider spawn failed after the durable intent"));
		const childTaskId = request.taskEnvelope.taskId;
		const childBindingId = `binding-${childTaskId}`;
		const child = createAgentInstance({ agentInstanceId: `child-instance-${childTaskId}`, providerId: this.providerId, providerDeclaredAgent: true, roleRevision: request.roleRevision, taskId: childTaskId, now: () => now });
		if (!child.ok) return child;
		const childEpoch = createBindingEpoch({ bindingEpochId: `child-epoch-${childTaskId}`, taskId: childTaskId, attemptId: `child-attempt-${childTaskId}`, bindingId: childBindingId, agentInstanceId: child.value.agentInstanceId, activationReason: "attempt_started", activatedByCommandId: `child-command-${childTaskId}`, now: () => now });
		if (!childEpoch.ok) return childEpoch;
		const childDispatch = dispatch(this.providerId, childBindingId, childTaskId);
		const childAttempt = createAttempt({ attemptId: `child-attempt-${childTaskId}`, dispatch: childDispatch, providerId: this.providerId, initialBindingEpoch: childEpoch.value, providerClass: "agent", agentInstanceId: child.value.agentInstanceId, now: () => now });
		if (!childAttempt.ok) return childAttempt;
		this.lastSpawn = { schemaVersion: 1, attempt: childAttempt.value, agentInstance: child.value, initialBindingEpoch: childEpoch.value };
		return Result.ok(this.lastSpawn);
	}
	async lookupSpawn(_spawnId: string) { this.lookupCount += 1; return Result.ok(this.lastSpawn); }
	async resume(_attemptId: string) { return Result.err(new FoundationError("foundation_schema_unknown_record", "child resume is not implemented")); }
	async cancel(_attemptId: string) { return Result.ok(undefined); }
	async dispose() {}
}

describe("T6 provider-driven role binding and result settlement", () => {
	it("keeps raw child spawn execution behind the settlement boundary", () => {
		expect("executeAgentSpawnV1" in AgentPublic).toBe(false);
	});

	it("fails closed without all four existing binding facts", () => {
		const result = resolveAgentBinding({ task: task(), roleRevision: roleRevision(), modelProfile: modelProfile(), newBindingId: "missing-facts", now: () => now });
		expect(result).toMatchObject({ ok: false, error: { code: "binding_required_fact" } });
	});

	it("rejects a succeeded provider receipt with unresolved side effects", async () => {
		const provider = new UnknownSideEffectSchedulerProvider();
		const result = await executeDispatchV1({ provider, dispatch: dispatch(provider.providerId), binding: binding(), initialBindingEpoch: epoch(provider.providerId), correlation: { sessionId: "session-t6", laneId: "main", taskId: "task-t6", dispatchId: "dispatch-scheduler-t6", attemptId: "attempt-scheduler-t6", bindingId: "binding-t6", bindingEpochId: "epoch-scheduler-t6", revision: 1 } });
		expect(result).toMatchObject({ ok: false, error: { code: "side_effect_unknown" } });
	});

	it("restores Role and ModelProfile revisions from the Session ledger and fences writers", async () => {
		const session = new Session(new InMemorySessionStorage({ id: "role-session", createdAt: 1 }));
		const rolesA = await DurableRoleRegistryV1.create(session, { now: () => now, ownerId: "role-writer-a" });
		expect(await rolesA.create({ definition: roleDefinition() })).toMatchObject({ ok: true, value: { currentRevision: { revision: 1 } } });
		const staleLedger = new SessionLedgerV1(session, { ownerId: "role-stale-cas" });
		await expect(staleLedger.appendFact("role_registry", "project:role-t6", { schemaVersion: 1, stale: true }, { clientRequestId: "stale-cas", expectedRevision: 0, correlation: { roleId: "role-t6" } })).rejects.toMatchObject({ code: "session_writer_stale_revision" });
		const rolesB = await DurableRoleRegistryV1.create(session, { now: () => now, ownerId: "role-writer-b" });
		expect(await rolesB.edit({ roleId: "role-t6", scope: "project", expectedRevision: 1, patch: { persona: "blocked" } })).toMatchObject({ ok: false, error: { code: expect.stringMatching(/session_writer/) } });
		await rolesA.release();
		expect(await rolesB.edit({ roleId: "role-t6", scope: "project", expectedRevision: 1, patch: { persona: "edited" } })).toMatchObject({ ok: true, value: { currentRevision: { revision: 2, persona: "edited" } } });
		await rolesB.release();
		const restartedRoles = await DurableRoleRegistryV1.create(session, { now: () => now, ownerId: "role-writer-restart" });
		expect(await restartedRoles.get({ roleId: "role-t6", scope: "project", revision: 2 })).toMatchObject({ ok: true, value: { currentRevision: { revision: 2, persona: "edited" } } });
		await restartedRoles.release();
		const profiles = await DurableModelProfileStoreV1.create(session, { ownerId: "profile-writer" });
		expect(await profiles.register({ profile: modelProfile() })).toMatchObject({ ok: true, value: { modelProfileId: "profile-t6", revision: 1 } });
		await profiles.release();
		const restartedProfiles = await DurableModelProfileStoreV1.create(session, { ownerId: "profile-restart" });
		expect(await restartedProfiles.get({ modelProfileId: "profile-t6" })).toMatchObject({ ok: true, value: { revision: 1 } });
		await restartedProfiles.release();
	});

	it("resolves only Task, Role, ModelProfile, and binding sources from durable facts", async () => {
		const session = new Session(new InMemorySessionStorage({ id: "resolver-session", createdAt: 1 }));
		const roles = await DurableRoleRegistryV1.create(session, { now: () => now, ownerId: "resolver-roles" });
		expect(await roles.create({ definition: roleDefinition() })).toMatchObject({ ok: true });
		await roles.release();
		const profiles = await DurableModelProfileStoreV1.create(session, { ownerId: "resolver-profiles" });
		expect(await profiles.register({ profile: modelProfile() })).toMatchObject({ ok: true });
		await profiles.release();
		const value = binding("resolver-binding");
		const layers = ROLE_RESOLUTION_ORDER_V1.map((layer, ordinal) => ({ schemaVersion: 1 as const, layer, ordinal, referenceId: `${layer}-resolver`, revision: 1, overrideReason: "durable-resolver" }));
		const input = { schemaVersion: 1 as const, task: task(), roleId: "role-t6", scope: "project" as const, modelProfile: modelProfile(), orderedLayers: layers, contextRevision: value.contextRevision, capabilityRevision: value.capabilityRevision, modelBrokerBindingRevision: value.modelBrokerBindingRevision, policyRevision: value.policyRevision, bindingId: "resolver-binding" };
		expect(await roles.resolve(input)).toMatchObject({ ok: false, error: { code: "role_resolver_task_required" } });
		const seed = new SessionLedgerV1(session, { ownerId: "resolver-seed" });
		await seed.appendFact("task", value.taskId, task(), { clientRequestId: "resolver:task", expectedRevision: 0, correlation: { taskId: value.taskId } });
		for (const [objectType, reference] of [["external_agent_binding", value.contextRevision], ["capability_binding", value.capabilityRevision], ["model_broker_binding", value.modelBrokerBindingRevision], ["policy_binding", value.policyRevision]] as const) {
			const payload = { schemaVersion: 1 as const, type: reference.type, id: reference.id, revision: reference.revision };
			await seed.appendFact(objectType, reference.id, payload, { clientRequestId: `resolver:${objectType}`, correlation: { taskId: value.taskId } });
		}
		await seed.release();
		const resolved = await roles.resolve(input);
		if (!resolved.ok) throw resolved.error;
		expect(resolved).toMatchObject({ ok: true, value: { binding: { bindingId: "resolver-binding" } } });
		const { fingerprint: _fingerprint, ...fabricatedBase } = modelProfile();
		const fabricatedModel = createModelProfileRevision({ ...fabricatedBase, model: "caller-shaped-model" });
		const canonicalized = await roles.resolve({ ...input, modelProfile: fabricatedModel });
		expect(canonicalized).toMatchObject({ ok: true, value: { binding: { modelRoute: { model: "fake-model" } } } });
		await roles.release();
	});

	it("composes only immutable Capability/ModelBroker/Policy/External-Agent Binding references", () => {
		const value = binding("binding-existing");
		expect(value).toMatchObject({ contextRevision: { type: "external_agent_binding" }, capabilityRevision: { type: "capability_binding" }, modelBrokerBindingRevision: { type: "model_broker_binding" }, policyRevision: { type: "policy_binding" } });
		for (const reference of [value.contextRevision, value.capabilityRevision, value.modelBrokerBindingRevision, value.policyRevision]) expect(reference.fingerprint?.value).toBeTruthy();
		expect(value).not.toHaveProperty("capabilityDefinition");
		expect(value).not.toHaveProperty("policyDefinition");
	});

	it("persists provider-created Attempt/AttemptReceipt and Host settlement in one Session ledger", async () => {
		const session = new Session(new InMemorySessionStorage({ id: "session-t6", createdAt: 1 }));
		const currentBinding = binding();
		await seedBindingFacts(session, currentBinding);
		const executor = new SchedulerProvider();
		const currentDispatch = dispatch(executor.providerId, currentBinding.bindingId);
		const currentEpoch = epoch(executor.providerId);
		const ledger = new LayeredResultSettlementV1(session, { ownerId: "settlement-t6" });
		const correlation = { sessionId: "session-t6", laneId: "main", taskId: currentDispatch.taskId, dispatchId: currentDispatch.dispatchId, attemptId: currentEpoch.attemptId, bindingId: currentBinding.bindingId, bindingEpochId: currentEpoch.bindingEpochId, revision: 1 };
		const executed = await ledger.executeDispatch({ provider: executor, dispatch: currentDispatch, binding: currentBinding, initialBindingEpoch: currentEpoch, correlation });
		if (!executed.ok) throw executed.error;
		const persisted = await session.getFoundationObject("attempt_receipt", executed.value.receipt.attemptReceiptId);
		expect(persisted?.kind).toBe("fact");
		expect(executor.runCount).toBe(1);
		await ledger.release();
		const restarted = new LayeredResultSettlementV1(session, { ownerId: "settlement-t6-restart" });
		const replayed = await restarted.executeDispatch({ provider: executor, dispatch: currentDispatch, binding: currentBinding, initialBindingEpoch: currentEpoch, correlation });
		expect(replayed).toMatchObject({ ok: true, value: { receipt: { attemptReceiptId: executed.value.receipt.attemptReceiptId } } });
		expect(executor.runCount).toBe(1);
		const settled = await restarted.settle({ taskResultId: "task-result-t6", task: task(), sourceAttemptReceiptIds: [executed.value.receipt.attemptReceiptId], summary: "provider completed", artifacts: [artifact], tests: [{ name: "provider", required: true, status: "passed", evidenceRefs: [artifact] }], evidence: [{ schemaVersion: 1, factId: "fact-t6", criterionId: "criterion-t6", outcome: "satisfied", evidenceRefs: [artifact], recordedAt: now }], producer: { producerKind: "host", providerId: "host-t6", producedAt: now, correlation: { ...correlation, taskResultId: "task-result-t6", attemptReceiptId: executed.value.receipt.attemptReceiptId } } });
		expect(settled.ok).toBe(true);
		if (!settled.ok) return;
		const run = await restarted.finalize({ runReceiptId: "run-receipt-t6", runId: "run-t6", terminalStatus: "completed", authority: createHostTerminalGateAuthorityV1("host-t6"), attemptReceiptIds: [executed.value.receipt.attemptReceiptId], taskResultId: settled.value.taskResultId, completedAt: now });
		expect(run).toMatchObject({ ok: true, value: { taskResultId: "task-result-t6", terminalStatus: "completed" } });
		const conflicting = await restarted.finalize({ runReceiptId: "run-receipt-conflict", runId: "run-t6", terminalStatus: "failed", authority: createHostTerminalGateAuthorityV1("host-t6"), attemptReceiptIds: [executed.value.receipt.attemptReceiptId], terminalErrorCode: "replay-conflict", completedAt: now });
		expect(conflicting).toMatchObject({ ok: false, error: { code: "run_terminal_authority_invalid" } });
		const reusedReceiptId = await restarted.finalize({ runReceiptId: "run-receipt-t6", runId: "run-other", terminalStatus: "failed", authority: createHostTerminalGateAuthorityV1("host-t6"), attemptReceiptIds: [executed.value.receipt.attemptReceiptId], terminalErrorCode: "receipt-id-reuse", completedAt: now });
		expect(reusedReceiptId).toMatchObject({ ok: false, error: { code: "run_terminal_authority_invalid" } });
	});

	it("does not expose a structured receipt acceptance escape hatch and rejects runId conflicts", async () => {
		const session = new Session(new InMemorySessionStorage({ id: "session-forgery", createdAt: 1 }));
		const ledger = new LayeredResultSettlementV1(session, { ownerId: "settlement-forgery" });
		expect((ledger as unknown as { acceptExecution?: unknown }).acceptExecution).toBeUndefined();
		const missing = await ledger.finalize({ runReceiptId: "run-1", runId: "same-run", terminalStatus: "failed", authority: createHostTerminalGateAuthorityV1("host"), attemptReceiptIds: ["missing"] });
		expect(missing).toMatchObject({ ok: false, error: { code: "task_result_no_source_receipts" } });
	});

	it("rejects provider provenance mismatch and keeps Operation Worker free of AgentInstance", async () => {
		const provider = new BrokenSchedulerProvider();
		const result = await executeDispatchV1({ provider, dispatch: dispatch(provider.providerId), binding: binding(), initialBindingEpoch: epoch(provider.providerId), correlation: { sessionId: "session-t6", laneId: "main", taskId: "task-t6", dispatchId: "dispatch-scheduler-t6", attemptId: "attempt-scheduler-t6", bindingId: "binding-t6", bindingEpochId: "epoch-scheduler-t6", revision: 1 } });
		expect(result).toMatchObject({ ok: false, error: { code: "worker_receipt_invalid_producer" } });
		const worker = new OperationProvider();
		const operation = await executeOperationV1({ provider: worker, request: { schemaVersion: 1, operationId: "operation-t6", taskId: "task-t6", dispatchId: "dispatch-worker-t6", attemptId: "attempt-worker-t6" }, correlation: { sessionId: "session-t6", laneId: "main", taskId: "task-t6", dispatchId: "dispatch-worker-t6", attemptId: "attempt-worker-t6", revision: 1 } });
		expect(operation).toMatchObject({ ok: true, value: { sandboxProviderId: worker.providerId } });
		if (operation.ok) expect("agentInstanceId" in operation.value).toBe(false);
	});

	it("persists child Task, Context, Dispatch, AgentInstance, and Attempt identities without lease inheritance", async () => {
		const session = new Session(new InMemorySessionStorage({ id: "spawn-session", createdAt: 1 }));
		const childTask = task("child-task-t6");
		const childBinding = binding("binding-child-task-t6", childTask);
		await seedBindingFacts(session, childBinding);
		await seedParentSpawnContext(session, "parent-task-t6", "parent-spawn-t6");
		const seed = new SessionLedgerV1(session, { ownerId: "spawn-binding-seed" });
		await seed.appendFact("agent_binding", childBinding.bindingId, childBinding, { clientRequestId: "spawn:binding", correlation: { taskId: childBinding.taskId, bindingId: childBinding.bindingId } });
		await seed.release();
		const provider = new ChildProvider();
		const settlement = new LayeredResultSettlementV1(session, { ownerId: "spawn-settlement" });
		const canonicalRole = roleRevision();
		const { fingerprint: _roleFingerprint, ...callerRoleSnapshot } = canonicalRole;
		const callerRole = { ...callerRoleSnapshot, name: "caller-shaped-role", fingerprint: fingerprintFoundationValue({ ...callerRoleSnapshot, name: "caller-shaped-role" }) };
		const canonicalProfile = modelProfile();
		const { fingerprint: _profileFingerprint, ...callerProfileSnapshot } = canonicalProfile;
		const callerProfile = { ...callerProfileSnapshot, model: "caller-shaped-model", fingerprint: fingerprintFoundationValue({ ...callerProfileSnapshot, model: "caller-shaped-model" }) };
		const spawnInput = { provider, request: { schemaVersion: 1 as const, spawnId: "spawn-t6", parentSpawn: { schemaVersion: 1 as const, type: "agent.spawn" as const, spawnId: "parent-spawn-t6", parentTaskId: "parent-task-t6", newTaskEnvelopeRef: { schemaVersion: 1 as const, type: "task_envelope" as const, id: childTask.taskId, revision: 1 }, createdAt: now }, taskEnvelope: childTask, roleRevision: callerRole, modelProfile: callerProfile, forkScope: "none" as const }, correlation: { sessionId: "spawn-session", laneId: "main", taskId: childTask.taskId, agentInstanceId: `child-instance-${childTask.taskId}`, revision: 1 } };
		const spawned = await settlement.executeAgentSpawn(spawnInput);
		if (!spawned.ok) throw spawned.error;
		expect(spawned).toMatchObject({ ok: true, value: { attempt: { attemptId: `child-attempt-${childTask.taskId}`, taskId: childTask.taskId } } });
		expect(provider.spawnCount).toBe(1);
		expect(provider.receivedRoleRevision).toEqual(canonicalRole);
		expect(provider.receivedModelProfile).toEqual(canonicalProfile);
		expect(spawned.value.agentInstance.roleRevision).toEqual({ schemaVersion: 1, type: "role_revision", id: canonicalRole.roleRevisionId, revision: canonicalRole.revision, fingerprint: canonicalRole.fingerprint });
		const replayed = await settlement.executeAgentSpawn(spawnInput);
		expect(replayed).toMatchObject({ ok: true, value: { attempt: { attemptId: `child-attempt-${childTask.taskId}` } } });
		expect(provider.spawnCount).toBe(1);
		for (const objectType of ["task", "context", "dispatch", "agent_instance", "binding_epoch", "attempt"] as const) expect((await session.findFoundationRecords({ kind: "fact", objectType, order: "oldestFirst" })).length).toBeGreaterThan(0);
		const childContext = await session.getFoundationObject("context", "context_spawn-t6");
		expect(childContext).toMatchObject({ kind: "fact", payload: { contextId: "context_spawn-t6", taskId: childTask.taskId, parentTaskId: "parent-task-t6", parentContextId: "context_parent-spawn-t6", lineage: { entityType: "context", entityId: "context_spawn-t6", parentId: "context_parent-spawn-t6", depth: 1 } } });
		const orderedFacts = await session.findFoundationRecords({ kind: "fact", order: "oldestFirst" });
		const childTaskIndex = orderedFacts.findIndex((record) => record.kind === "fact" && record.objectType === "task" && record.objectId === childTask.taskId);
		const childContextIndex = orderedFacts.findIndex((record) => record.kind === "fact" && record.objectType === "context" && record.objectId === "context_spawn-t6");
		const childDispatchIndex = orderedFacts.findIndex((record) => record.kind === "fact" && record.objectType === "dispatch" && record.objectId === `dispatch-${provider.providerId}`);
		expect(childTaskIndex).toBeGreaterThanOrEqual(0);
		expect(childContextIndex).toBeGreaterThan(childTaskIndex);
		expect(childDispatchIndex).toBeGreaterThan(childContextIndex);
		await settlement.release();
	});

	it("executes the canonical public spawn-intent validator before any child records are written", async () => {
		const session = new Session(new InMemorySessionStorage({ id: "spawn-validator-session", createdAt: 1 }));
		const provider = new ChildProvider();
		const settlement = new LayeredResultSettlementV1(session, { ownerId: "spawn-validator-settlement" });
		const childTask = task("validator-child-task-t6");
		const invalid = await settlement.executeAgentSpawn({ provider, request: { schemaVersion: 1, spawnId: "validator-spawn-t6", parentSpawn: { schemaVersion: 1, type: "agent.spawn", spawnId: "validator-parent-spawn-t6", parentTaskId: childTask.taskId, newTaskEnvelopeRef: { schemaVersion: 1, type: "task_envelope", id: childTask.taskId, revision: 1 }, createdAt: now }, taskEnvelope: childTask, roleRevision: roleRevision(), modelProfile: modelProfile(), forkScope: "none" }, correlation: { sessionId: "spawn-validator-session", laneId: "main", taskId: childTask.taskId, agentInstanceId: "validator-child-instance-t6", revision: 1 } });
		expect(invalid).toMatchObject({ ok: false, error: { code: "role_resolver_conflict" } });
		expect(provider.spawnCount).toBe(0);
		expect(await session.findFoundationRecords({ order: "oldestFirst" })).toHaveLength(0);
		await settlement.release();
	});

	it("fails closed without a durable parent Context before creating the child Task", async () => {
		const session = new Session(new InMemorySessionStorage({ id: "spawn-missing-parent-context-session", createdAt: 1 }));
		const parentTask = task("missing-context-parent-task-t6");
		const childTask = task("missing-context-child-task-t6");
		const seed = new SessionLedgerV1(session, { ownerId: "missing-context-parent-seed" });
		await seed.appendFact("task", parentTask.taskId, parentTask, { clientRequestId: "missing-context:parent-task", expectedRevision: 0, correlation: { taskId: parentTask.taskId } });
		await seed.release();
		const provider = new ChildProvider();
		const settlement = new LayeredResultSettlementV1(session, { ownerId: "missing-context-settlement" });
		const missing = await settlement.executeAgentSpawn({ provider, request: { schemaVersion: 1, spawnId: "missing-context-spawn-t6", parentSpawn: { schemaVersion: 1, type: "agent.spawn", spawnId: "missing-context-parent-spawn-t6", parentTaskId: parentTask.taskId, newTaskEnvelopeRef: { schemaVersion: 1, type: "task_envelope", id: childTask.taskId, revision: 1 }, createdAt: now }, taskEnvelope: childTask, roleRevision: roleRevision(), modelProfile: modelProfile(), forkScope: "none" }, correlation: { sessionId: "spawn-missing-parent-context-session", laneId: "main", taskId: childTask.taskId, agentInstanceId: "missing-context-child-instance-t6", revision: 1 } });
		expect(missing).toMatchObject({ ok: false, error: { code: "role_resolver_task_required" } });
		expect(provider.spawnCount).toBe(0);
		expect(await session.getFoundationObject("task", childTask.taskId)).toBeUndefined();
		expect(await session.getFoundationObject("context", "context_missing-context-spawn-t6")).toBeUndefined();
		expect(await session.findFoundationRecords({ kind: "fact", objectType: "dispatch", order: "oldestFirst" })).toHaveLength(0);
		await settlement.release();
	});

	it("fails closed before lookup when a durable spawn intent belongs to another provider", async () => {
		const session = new Session(new InMemorySessionStorage({ id: "spawn-recovery-session", createdAt: 1 }));
		const childTask = task("recovery-child-task-t6");
		const childBinding = binding("binding-recovery-child-task-t6", childTask);
		await seedBindingFacts(session, childBinding);
		await seedParentSpawnContext(session, "recovery-parent-task-t6", "recovery-parent-spawn-t6");
		const seed = new SessionLedgerV1(session, { ownerId: "spawn-recovery-binding-seed" });
		await seed.appendFact("agent_binding", childBinding.bindingId, childBinding, { clientRequestId: "spawn-recovery:binding", correlation: { taskId: childBinding.taskId, bindingId: childBinding.bindingId } });
		await seed.release();
		const providerA = new ChildProvider("agent-child-t6-a");
		providerA.failSpawn = true;
		const spawnInput = { provider: providerA, request: { schemaVersion: 1 as const, spawnId: "spawn-recovery-t6", parentSpawn: { schemaVersion: 1 as const, type: "agent.spawn" as const, spawnId: "recovery-parent-spawn-t6", parentTaskId: "recovery-parent-task-t6", newTaskEnvelopeRef: { schemaVersion: 1 as const, type: "task_envelope" as const, id: childTask.taskId, revision: 1 }, createdAt: now }, taskEnvelope: childTask, roleRevision: roleRevision(), modelProfile: modelProfile(), forkScope: "none" as const }, correlation: { sessionId: "spawn-recovery-session", laneId: "main", taskId: childTask.taskId, agentInstanceId: `child-instance-${childTask.taskId}`, revision: 1 } };
		const settlementA = new LayeredResultSettlementV1(session, { ownerId: "spawn-recovery-a" });
		const first = await settlementA.executeAgentSpawn(spawnInput);
		expect(first).toMatchObject({ ok: false, error: { code: "provider_spawn_failed" } });
		expect(providerA.spawnCount).toBe(1);
		await settlementA.release();
		const providerB = new ChildProvider("agent-child-t6-b");
		const settlementB = new LayeredResultSettlementV1(session, { ownerId: "spawn-recovery-b" });
		const recovered = await settlementB.executeAgentSpawn({ ...spawnInput, provider: providerB });
		expect(recovered).toMatchObject({ ok: false, error: { code: "session_ledger_conflict" } });
		expect(providerB.lookupCount).toBe(0);
		expect(providerB.spawnCount).toBe(0);
		await settlementB.release();
	});

	it("requires the next immutable Binding and safe boundary for mode switch", () => {
		const current = binding();
		const currentEpoch = { ...epoch("agent-t6", "agent", "agent-instance-t6"), agentInstanceId: "agent-instance-t6" };
		const modeCorrelation = { sessionId: "session-t6", laneId: "main", taskId: currentEpoch.taskId, attemptId: currentEpoch.attemptId, bindingId: currentEpoch.bindingId, bindingEpochId: currentEpoch.bindingEpochId, agentInstanceId: currentEpoch.agentInstanceId, revision: 1 };
		const agent = createAgentInstance({ agentInstanceId: "agent-instance-t6", providerId: "agent-t6", providerDeclaredAgent: true, roleRevision: roleRevision(), taskId: "task-t6", now: () => now });
		expect(agent.ok).toBe(true);
		const missing = createAttempt({ attemptId: currentEpoch.attemptId, dispatch: dispatch("agent-t6"), providerId: "agent-t6", initialBindingEpoch: currentEpoch, providerClass: "agent", now: () => now });
		expect(missing).toMatchObject({ ok: false, error: { code: "agent_instance_required_for_agent_provider" } });
		const missingNext = switchAgentModeV1({ intent: { schemaVersion: 1, type: "role.switch", modeSwitchId: "mode-t6-missing", taskId: currentEpoch.taskId, attemptId: currentEpoch.attemptId, agentInstanceId: "agent-instance-t6", bindingId: currentEpoch.bindingId, newBindingId: "binding-next", activationReason: "mode_switch", activatedByCommandId: "command-mode-t6", createdAt: now }, currentEpoch, correlation: modeCorrelation, nextBindingId: "binding-next", safeBoundary: "checkpoint", now: () => now });
		expect(missingNext).toMatchObject({ ok: false, error: { code: "binding_required_fact" } });
		const nextBindingBase = { ...current, bindingId: "binding-next" };
		const { fingerprint: _oldFingerprint, ...nextBindingSnapshot } = nextBindingBase;
		const nextBinding = { ...nextBindingBase, fingerprint: fingerprintFoundationValue(nextBindingSnapshot) };
		const switched = switchAgentModeV1({ intent: { schemaVersion: 1, type: "role.switch", modeSwitchId: "mode-t6", taskId: currentEpoch.taskId, attemptId: currentEpoch.attemptId, agentInstanceId: "agent-instance-t6", bindingId: currentEpoch.bindingId, newBindingId: "binding-next", activationReason: "mode_switch", activatedByCommandId: "command-mode-t6", createdAt: now }, currentEpoch, correlation: modeCorrelation, nextBinding, nextBindingId: "binding-next", safeBoundary: "checkpoint", now: () => now });
		expect(switched).toMatchObject({ ok: true, value: { ordinal: 1, bindingId: "binding-next", agentInstanceId: "agent-instance-t6", previousBindingEpochId: currentEpoch.bindingEpochId } });
	});

	it("persists mode-switch BindingEpoch and binding.activated records after the durable boundary", async () => {
		const session = new Session(new InMemorySessionStorage({ id: "mode-session", createdAt: 1 }));
		const currentBinding = binding();
		const currentEpoch = epoch("agent-t6", "agent", "agent-instance-t6");
		const agent = createAgentInstance({ agentInstanceId: "agent-instance-t6", providerId: "agent-t6", providerDeclaredAgent: true, roleRevision: roleRevision(), taskId: "task-t6", now: () => now });
		if (!agent.ok) throw agent.error;
		await seedBindingFacts(session, currentBinding);
		const seed = new SessionLedgerV1(session, { ownerId: "mode-seed" });
		await seed.appendFact("agent_binding", currentBinding.bindingId, currentBinding, { clientRequestId: "mode:binding", correlation: { taskId: currentBinding.taskId, bindingId: currentBinding.bindingId } });
		await seed.appendFact("binding_epoch", currentEpoch.bindingEpochId, currentEpoch, { clientRequestId: "mode:epoch", correlation: { taskId: currentEpoch.taskId, attemptId: currentEpoch.attemptId, bindingId: currentEpoch.bindingId, bindingEpochId: currentEpoch.bindingEpochId, agentInstanceId: currentEpoch.agentInstanceId } });
		await seed.appendFact("agent_instance", agent.value.agentInstanceId, agent.value, { clientRequestId: "mode:agent", correlation: { taskId: agent.value.taskId, agentInstanceId: agent.value.agentInstanceId } });
		const currentAttempt = createAttempt({ attemptId: currentEpoch.attemptId, dispatch: dispatch("agent-t6"), providerId: "agent-t6", initialBindingEpoch: currentEpoch, providerClass: "agent", agentInstanceId: agent.value.agentInstanceId, now: () => now });
		if (!currentAttempt.ok) throw currentAttempt.error;
		await seed.appendFact("attempt", currentAttempt.value.attemptId, currentAttempt.value, { clientRequestId: "mode:attempt", correlation: { taskId: currentAttempt.value.taskId, dispatchId: currentAttempt.value.dispatchId, attemptId: currentAttempt.value.attemptId, bindingId: currentAttempt.value.bindingId, bindingEpochId: currentEpoch.bindingEpochId, agentInstanceId: currentAttempt.value.agentInstanceId } });
		await seed.release();
		const nextBase = { ...currentBinding, bindingId: "binding-next" };
		const { fingerprint: _oldFingerprint, ...nextSnapshot } = nextBase;
		const nextBinding = { ...nextBase, fingerprint: fingerprintFoundationValue(nextSnapshot) };
		const settlement = new LayeredResultSettlementV1(session, { ownerId: "mode-settlement" });
		const correlation = { sessionId: "mode-session", laneId: "main", taskId: currentEpoch.taskId, attemptId: currentEpoch.attemptId, bindingId: currentEpoch.bindingId, bindingEpochId: currentEpoch.bindingEpochId, agentInstanceId: currentEpoch.agentInstanceId, revision: 1 };
		const switched = await settlement.switchAgentMode({ intent: { schemaVersion: 1, type: "role.switch", modeSwitchId: "mode-durable", taskId: currentEpoch.taskId, attemptId: currentEpoch.attemptId, agentInstanceId: "agent-instance-t6", bindingId: currentEpoch.bindingId, newBindingId: nextBinding.bindingId, activationReason: "mode_switch", activatedByCommandId: "mode-command", createdAt: now }, currentEpoch, correlation, nextBinding, nextBindingId: nextBinding.bindingId, safeBoundary: "checkpoint", now: () => now });
		expect(switched).toMatchObject({ ok: true, value: { bindingId: "binding-next", ordinal: 1 } });
		expect(await session.getFoundationObject("binding.activated", switched.ok ? switched.value.bindingEpochId : "missing")).toMatchObject({ kind: "fact", objectType: "binding.activated" });
		expect(await session.getFoundationObject("attempt", currentEpoch.attemptId)).toMatchObject({ kind: "fact", payload: { bindingEpochIds: [currentEpoch.bindingEpochId, "binding_epoch_mode-durable"] } });
		await settlement.release();
	});
});
