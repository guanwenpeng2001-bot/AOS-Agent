import { describe, expect, it } from "vitest";
import { Result } from "../../src/harness/result.ts";
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

function task(): TaskEnvelopeV1 {
	return { schemaVersion: 1, taskId: "task-t6", goalId: "goal-t6", goal: "exercise the T6 provider consumer", workspace: "workspace-t6", capabilityRefs: [capability], inputs: [], expectedOutputs: [artifact], budget: {}, acceptanceCriteria: [{ schemaVersion: 1, criterionId: "criterion-t6", description: "provider output is accepted", satisfiedBy: "evidence", required: true }], status: "ready", createdAt: now, updatedAt: now };
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

function binding(id = "binding-t6"): AgentBindingV1 {
	const result = resolveAgentBinding({ task: task(), roleRevision: roleRevision(), modelProfile: modelProfile(), contextRevision: immutableFact("external_agent_binding", "external-existing", 1), capabilityRevision: immutableFact("capability_binding", "capability-existing", 1), modelBrokerBindingRevision: immutableFact("model_broker_binding", "model-broker-existing", 1), policyRevision: immutableFact("policy_binding", "policy-existing", 1), newBindingId: id, now: () => now });
	if (!result.ok) throw result.error;
	return result.value;
}

async function seedBindingFacts(session: Session, value: AgentBindingV1): Promise<void> {
	const ledger = new SessionLedgerV1(session, { ownerId: `seed-${value.bindingId}` });
	for (const [objectType, reference] of [["external_agent_binding", value.contextRevision], ["capability_binding", value.capabilityRevision], ["model_broker_binding", value.modelBrokerBindingRevision], ["policy_binding", value.policyRevision]] as const) {
		const payload = { schemaVersion: 1 as const, type: reference.type, id: reference.id, revision: reference.revision };
		await ledger.appendFact(objectType, reference.id, payload, { clientRequestId: `seed:${objectType}:${reference.id}`, correlation: { taskId: value.taskId, bindingId: value.bindingId } });
	}
	await ledger.release();
}

function dispatch(providerId: string, bindingId = "binding-t6"): DispatchV1 {
	return { schemaVersion: 1, dispatchId: `dispatch-${providerId}`, taskId: "task-t6", bindingId, taskExecutorProviderId: providerId, status: "pending", createdAt: now };
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

describe("T6 provider-driven role binding and result settlement", () => {
	it("fails closed without all four existing binding facts", () => {
		const result = resolveAgentBinding({ task: task(), roleRevision: roleRevision(), modelProfile: modelProfile(), newBindingId: "missing-facts", now: () => now });
		expect(result).toMatchObject({ ok: false, error: { code: "binding_required_fact" } });
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
		expect(executed.ok).toBe(true);
		if (!executed.ok) return;
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
		await seed.release();
		const nextBase = { ...currentBinding, bindingId: "binding-next" };
		const { fingerprint: _oldFingerprint, ...nextSnapshot } = nextBase;
		const nextBinding = { ...nextBase, fingerprint: fingerprintFoundationValue(nextSnapshot) };
		const settlement = new LayeredResultSettlementV1(session, { ownerId: "mode-settlement" });
		const correlation = { sessionId: "mode-session", laneId: "main", taskId: currentEpoch.taskId, attemptId: currentEpoch.attemptId, bindingId: currentEpoch.bindingId, bindingEpochId: currentEpoch.bindingEpochId, agentInstanceId: currentEpoch.agentInstanceId, revision: 1 };
		const switched = await settlement.switchAgentMode({ intent: { schemaVersion: 1, type: "role.switch", modeSwitchId: "mode-durable", taskId: currentEpoch.taskId, attemptId: currentEpoch.attemptId, agentInstanceId: "agent-instance-t6", bindingId: currentEpoch.bindingId, newBindingId: nextBinding.bindingId, activationReason: "mode_switch", activatedByCommandId: "mode-command", createdAt: now }, currentEpoch, correlation, nextBinding, nextBindingId: nextBinding.bindingId, safeBoundary: "checkpoint", now: () => now });
		expect(switched).toMatchObject({ ok: true, value: { bindingId: "binding-next", ordinal: 1 } });
		expect(await session.getFoundationObject("binding.activated", switched.ok ? switched.value.bindingEpochId : "missing")).toMatchObject({ kind: "fact", objectType: "binding.activated" });
		await settlement.release();
	});
});
