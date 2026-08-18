import { describe, expect, it } from "vitest";
import { Result } from "../../src/harness/result.ts";
import { FoundationError } from "../../src/harness/foundation/errors.ts";
import type { Entry, EntryQuery } from "../../src/harness/session/types.ts";
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
	LayeredResultSettlementV1,
	resolveAgentBinding,
	switchAgentModeV1,
	type AgentBindingV1,
	type AttemptReceiptV1,
	type AttemptV1,
	type BindingEpochV1,
	type DispatchV1,
	type FoundationProviderCapabilityV1,
	type ModelProfileSession,
	type RoleRegistrySession,
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

class MemoryFoundationSession implements RoleRegistrySession, ModelProfileSession {
	readonly entries: Entry[] = [];
	failNextWrite = false;
	async findEntries(query: EntryQuery): Promise<readonly Entry[]> {
		const selected = this.entries.filter((entry) => entry.type === "custom" && (query.customType === undefined || entry.customType === query.customType));
		return query.order === "oldestFirst" ? selected : [...selected].reverse();
	}
	async appendCustomEntry(customType: string, data?: unknown): Promise<string> {
		if (this.failNextWrite) { this.failNextWrite = false; throw new Error("injected persistence failure"); }
		const id = `entry-${this.entries.length + 1}`;
		this.entries.push({ type: "custom", id, customType, data, parentId: null, seq: this.entries.length + 1, timestamp: this.entries.length + 1 });
		return id;
	}
}

function binding(): AgentBindingV1 {
	const profile = createModelProfileRevision({ schemaVersion: 1, modelProfileId: "profile-t6", provider: "fake", model: "fake-model", budget: {}, revision: 1, createdAt: now });
	const result = resolveAgentBinding({ task: task(), roleRevision: roleRevision(), modelProfile: profile, newBindingId: "binding-t6", now: () => now });
	if (!result.ok) throw result.error;
	return result.value;
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
	async capabilities(): Promise<readonly FoundationProviderCapabilityV1[]> { return [providerCapability]; }
	async createAttempt(dispatchValue: DispatchV1, _binding: AgentBindingV1, context?: TaskExecutorAttemptContextV1) {
		if (context === undefined) return Result.err(new FoundationError("invalid_correlation", "missing provider context"));
		return createAttempt({ attemptId: context.initialBindingEpoch.attemptId, dispatch: dispatchValue, providerId: this.providerId, initialBindingEpoch: context.initialBindingEpoch, providerClass: this.providerClass, now: () => now });
	}
	async runAttempt(attempt: AttemptV1) {
		const correlation = { sessionId: "session-t6", laneId: "lane-t6", taskId: attempt.taskId, dispatchId: attempt.dispatchId, attemptId: attempt.attemptId, bindingId: attempt.bindingId, bindingEpochId: attempt.bindingEpochIds[0], attemptReceiptId: "attempt-receipt-t6", revision: 1 };
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
	async start(request: SandboxOperationRequestV1) {
		const correlation = { sessionId: "session-t6", laneId: "lane-t6", taskId: request.taskId, dispatchId: request.dispatchId, attemptId: request.attemptId, revision: 1 };
		return Result.ok<WorkerReceiptV1>({ schemaVersion: 1, workerReceiptId: "worker-receipt-t6", sandboxProviderId: this.providerId, operationId: request.operationId, taskId: request.taskId, dispatchId: request.dispatchId, attemptId: request.attemptId, status: "succeeded", sideEffectState: "none", provenance: { producerKind: "operation_worker", providerId: this.providerId, producedAt: now, correlation }, startedAt: now, completedAt: now });
	}
	async cancel(_operationId: string) { return Result.ok(undefined); }
	async dispose() {}
}

class BrokenSchedulerProvider extends SchedulerProvider {
	async runAttempt(attempt: AttemptV1) {
		const result = await super.runAttempt(attempt);
		if (!result.ok) return result;
		return Result.ok({ ...result.value, providerId: "wrong-provider", provenance: { ...result.value.provenance, providerId: "wrong-provider" } });
	}
}

describe("T6 provider-driven role binding and result settlement", () => {
	it("restores Global/Project registry and ModelProfile revisions, and rolls back failed writes", async () => {
		const session = new MemoryFoundationSession();
		const roles = await DurableRoleRegistryV1.create(session, { now: () => now });
		const created = await roles.create({ definition: roleDefinition() });
		expect(created).toMatchObject({ ok: true, value: { currentRevision: { revision: 1 } } });
		session.failNextWrite = true;
		const failed = await roles.edit({ roleId: "role-t6", scope: "project", expectedRevision: 1, patch: { persona: "should rollback" } });
		expect(failed).toMatchObject({ ok: false, error: { code: "role_registry_persistence_failed" } });
		const unchanged = await roles.get({ roleId: "role-t6", scope: "project" });
		expect(unchanged).toMatchObject({ ok: true, value: { currentRevision: { revision: 1, persona: "execute T6" } } });
		const edited = await roles.edit({ roleId: "role-t6", scope: "project", expectedRevision: 1, patch: { persona: "edited" } });
		expect(edited).toMatchObject({ ok: true, value: { currentRevision: { revision: 2, persona: "edited" } } });
		const restartedRoles = await DurableRoleRegistryV1.create(session, { now: () => now });
		expect(await restartedRoles.get({ roleId: "role-t6", scope: "project", revision: 2 })).toMatchObject({ ok: true, value: { currentRevision: { revision: 2, persona: "edited" } } });
		const profiles = await DurableModelProfileStoreV1.create(session);
		const profile = createModelProfileRevision({ schemaVersion: 1, modelProfileId: "profile-independent", provider: "fake", model: "model-independent", budget: {}, revision: 1, createdAt: now });
		expect(await profiles.register({ profile })).toMatchObject({ ok: true, value: { modelProfileId: "profile-independent", revision: 1 } });
		const restartedProfiles = await DurableModelProfileStoreV1.create(session);
		expect(await restartedProfiles.get({ modelProfileId: "profile-independent" })).toMatchObject({ ok: true, value: { fingerprint: profile.fingerprint } });
	});

	it("composes only existing immutable revision/id references into AgentBinding", () => {
		const role = roleRevision();
		const profile = createModelProfileRevision({ schemaVersion: 1, modelProfileId: "profile-t6", provider: "fake", model: "fake-model", budget: {}, revision: 3, createdAt: now });
		const result = resolveAgentBinding({ task: task(), roleRevision: role, modelProfile: profile, contextRevision: { schemaVersion: 1, type: "context_revision", id: "context-existing", revision: 4 }, capabilityRevision: { schemaVersion: 1, type: "capability_binding", id: "capability-existing", revision: 7 }, policyRevision: { schemaVersion: 1, type: "policy_binding", id: "policy-existing", revision: 9 }, newBindingId: "binding-existing", now: () => now });
		expect(result).toMatchObject({ ok: true, value: { roleRevision: { id: role.roleRevisionId, revision: role.revision }, modelProfileRevision: { id: profile.modelProfileId, revision: profile.revision }, contextRevision: { id: "context-existing", revision: 4 }, capabilityRevision: { id: "capability-existing", revision: 7 }, policyRevision: { id: "policy-existing", revision: 9 } } });
		if (result.ok) {
			expect(result.value).not.toHaveProperty("capabilityDefinition");
			expect(result.value).not.toHaveProperty("policyDefinition");
			expect(result.value).not.toHaveProperty("modelProviderCredential");
		}
	});

	it("drives Dispatch through a provider-created Attempt and Host-only layered settlement", async () => {
		const executor = new SchedulerProvider();
		const currentBinding = binding();
		const currentDispatch = dispatch(executor.providerId, currentBinding.bindingId);
		const currentEpoch = epoch(executor.providerId);
		const ledger = new LayeredResultSettlementV1();
		const executed = await ledger.executeDispatch({ provider: executor, dispatch: currentDispatch, binding: currentBinding, initialBindingEpoch: currentEpoch, correlation: { sessionId: "session-t6", laneId: "lane-t6", taskId: currentDispatch.taskId, dispatchId: currentDispatch.dispatchId, attemptId: currentEpoch.attemptId, bindingId: currentBinding.bindingId, bindingEpochId: currentEpoch.bindingEpochId, revision: 1 } });
		expect(executed.ok).toBe(true);
		if (!executed.ok) return;
		const settled = ledger.settle({ taskResultId: "task-result-t6", task: task(), sourceAttemptReceiptIds: [executed.value.receipt.attemptReceiptId], summary: "provider completed", artifacts: [artifact], tests: [{ name: "provider", required: true, status: "passed", evidenceRefs: [artifact] }], evidence: [{ schemaVersion: 1, factId: "fact-t6", criterionId: "criterion-t6", outcome: "satisfied", evidenceRefs: [artifact], recordedAt: now }], producer: { producerKind: "host", providerId: "host-t6", producedAt: now } });
		expect(settled.ok).toBe(true);
		if (!settled.ok) return;
		const run = ledger.finalize({ runReceiptId: "run-receipt-t6", runId: "run-t6", terminalStatus: "completed", authority: createHostTerminalGateAuthorityV1("host-t6"), attemptReceiptIds: [executed.value.receipt.attemptReceiptId], taskResultId: settled.value.taskResultId, completedAt: now });
		expect(run).toMatchObject({ ok: true, value: { taskResultId: "task-result-t6", terminalStatus: "completed" } });
	});

	it("rejects a provider receipt with mismatched provenance or correlation", async () => {
		const provider = new BrokenSchedulerProvider();
		const result = await executeDispatchV1({ provider, dispatch: dispatch(provider.providerId), binding: binding(), initialBindingEpoch: epoch(provider.providerId) });
		expect(result).toMatchObject({ ok: false, error: { code: "worker_receipt_invalid_producer" } });
	});

	it("consumes Operation Worker receipts without creating an AgentInstance", async () => {
		const provider = new OperationProvider();
		const result = await executeOperationV1({ provider, request: { schemaVersion: 1, operationId: "operation-t6", taskId: "task-t6", dispatchId: "dispatch-worker-t6", attemptId: "attempt-worker-t6" }, correlation: { sessionId: "session-t6", laneId: "lane-t6", taskId: "task-t6", dispatchId: "dispatch-worker-t6", attemptId: "attempt-worker-t6", revision: 1 } });
		expect(result).toMatchObject({ ok: true, value: { sandboxProviderId: provider.providerId } });
		if (result.ok) expect("agentInstanceId" in result.value).toBe(false);
	});

	it("fails closed when an Agent provider has no AgentInstance and permits mode switch to a new Binding", () => {
		const agentEpoch = epoch("agent-t6", "agent");
		const agent = createAgentInstance({ agentInstanceId: "agent-instance-t6", providerId: "agent-t6", providerDeclaredAgent: true, roleRevision: roleRevision(), taskId: "task-t6", now: () => now });
		expect(agent.ok).toBe(true);
		const missingInstanceAttempt = createAttempt({ attemptId: agentEpoch.attemptId, dispatch: dispatch("agent-t6"), providerId: "agent-t6", initialBindingEpoch: agentEpoch, providerClass: "agent", now: () => now });
		expect(missingInstanceAttempt).toMatchObject({ ok: false, error: { code: "agent_instance_required_for_agent_provider" } });
		const badEpoch = createBindingEpoch({ bindingEpochId: "bad-agent-epoch", taskId: "task-t6", attemptId: "attempt-agent-t6", bindingId: "binding-t6", activationReason: "attempt_started", activatedByCommandId: "command-agent-t6", now: () => now });
		expect(badEpoch.ok).toBe(true);
		const switched = switchAgentModeV1({ intent: { schemaVersion: 1, type: "role.switch", modeSwitchId: "mode-t6", taskId: agentEpoch.taskId, attemptId: agentEpoch.attemptId, agentInstanceId: agentEpoch.agentInstanceId ?? "agent-instance-t6", bindingId: agentEpoch.bindingId, newBindingId: "binding-t6-next", activationReason: "mode_switch", activatedByCommandId: "command-mode-t6", createdAt: now }, currentEpoch: { ...agentEpoch, agentInstanceId: "agent-instance-t6" }, nextBindingId: "binding-t6-next", now: () => now });
		expect(switched).toMatchObject({ ok: true, value: { ordinal: 1, bindingId: "binding-t6-next", agentInstanceId: "agent-instance-t6", previousBindingEpochId: agentEpoch.bindingEpochId } });
	});
});
