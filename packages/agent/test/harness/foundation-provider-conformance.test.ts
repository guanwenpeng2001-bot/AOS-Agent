import { describe, expect, it } from "vitest";
import {
	AGENT_RUNTIME_HOST_PROVIDER,
	type SubagentProviderDescriptor,
	SubagentProviderRegistry,
} from "../../../coding-agent/src/core/subagent-registry.ts";
import {
	type AttemptReceipt,
	type ChildAgentProvider,
	type ChildSpawnRequest,
	type ChildSpawnResult,
	createAgentInstance,
	createAttempt,
	createBindingEpoch,
	createModelProfileRevision,
	createRoleRevision,
	FoundationError,
	type FoundationProviderCapability,
	fingerprintFoundationValue,
	LayeredResultSettlement,
	type ModelProfile,
	negotiateProtocol,
	type RevisionReference,
	resolveAgentBinding,
	SessionLedger,
	type TaskEnvelope,
	validateAttemptReceiptForProvider,
	validateWorkerReceiptForProvider,
} from "../../src/harness/foundation/index.ts";
import { Result } from "../../src/harness/result.ts";
import { InMemorySessionStorage, Session } from "../../src/harness/session/index.ts";

const capabilities = (min: number, max: number) => ({
	versions: { min, max },
	features: ["observer.attach"] as const,
});

describe("Foundation provider and transport conformance", () => {
	it("negotiates a version present in the feature matrix", () => {
		const result = negotiateProtocol(capabilities(1, 1), capabilities(1, 1));
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.value.version).toBe(1);
	});

	it("fails closed when the common range has no protocol matrix entry", () => {
		const result = negotiateProtocol(capabilities(2, 2), capabilities(2, 2));
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.code).toBe("protocol_unsupported_version");
	});

	it("keeps receipt producers bound to their provider class", () => {
		const workerResult = validateWorkerReceiptForProvider(undefined, {
			providerId: "worker-1",
			providerClass: "task_executor",
		});
		const attemptResult = validateAttemptReceiptForProvider(undefined, {
			providerId: "worker-1",
			providerClass: "operation_worker",
		});
		expect(workerResult.ok).toBe(false);
		expect(attemptResult.ok).toBe(false);
	});
});

describe("Agent spawn consumer fakes via LayeredResultSettlementV1.executeAgentSpawn", () => {
	const fakeNow = "2026-01-01T00:00:00.000Z";

	const taskEnvelope = (id: string): TaskEnvelope => ({
		schemaVersion: 1,
		taskId: id,
		goalId: "goal-fake",
		goal: "fake goal",
		workspace: "workspace-fake",
		capabilityRefs: [],
		inputs: [],
		expectedOutputs: [],
		budget: {},
		acceptanceCriteria: [],
		status: "ready",
		createdAt: fakeNow,
		updatedAt: fakeNow,
	});

	const modelProfile = (id: string): ModelProfile =>
		createModelProfileRevision({
			schemaVersion: 1,
			modelProfileId: id,
			provider: "fake",
			model: "fake-model",
			budget: {},
			revision: 1,
			createdAt: fakeNow,
		});

	const roleRevision = createRoleRevision({
		definition: {
			schemaVersion: 1,
			roleId: "role-fake",
			scope: "project",
			slug: "fake",
			name: "Fake",
			description: "Fake role",
			revision: 1,
			persona: "Fake persona",
			modelProfileRef: { schemaVersion: 1, type: "model_profile", id: "profile-fake", revision: 1 },
			capabilitySelector: { policy: "all" },
			skillSelector: { policy: "none" },
			mcpSelector: { policy: "none" },
		},
		now: () => fakeNow,
	});

	function immutableFact(type: string, id: string, revision = 1): RevisionReference {
		const payload = { schemaVersion: 1 as const, type, id, revision };
		return { ...payload, fingerprint: fingerprintFoundationValue(payload) };
	}

	function binding(id: string, taskId: string) {
		const result = resolveAgentBinding({
			task: taskEnvelope(taskId),
			roleRevision,
			modelProfile: modelProfile("profile-fake"),
			contextRevision: immutableFact("external_agent_binding", "external-existing", 1),
			capabilityRevision: immutableFact("capability_binding", "capability-existing", 1),
			modelBrokerBindingRevision: immutableFact("model_broker_binding", "model-broker-existing", 1),
			policyRevision: immutableFact("policy_binding", "policy-existing", 1),
			newBindingId: id,
			now: () => fakeNow,
		});
		if (!result.ok) throw result.error;
		return result.value;
	}

	async function seedParentSpawnContext(session: Session, parentTaskId: string, parentSpawnId: string): Promise<void> {
		const ledger = new SessionLedger(session, { ownerId: `seed-parent-${parentSpawnId}` });
		await ledger.appendFact("task", parentTaskId, taskEnvelope(parentTaskId), {
			clientRequestId: `seed:parent-task:${parentTaskId}`,
			expectedRevision: 0,
			correlation: { taskId: parentTaskId },
		});
		const contextId = `context_${parentSpawnId}`;
		await ledger.appendFact(
			"context",
			contextId,
			{
				schemaVersion: 1 as const,
				contextId,
				taskId: parentTaskId,
				spawnId: parentSpawnId,
				forkScope: "none" as const,
				lineage: { schemaVersion: 1 as const, entityType: "context", entityId: contextId, depth: 0 },
				createdAt: fakeNow,
			},
			{
				clientRequestId: `seed:parent-context:${parentSpawnId}`,
				expectedRevision: 0,
				correlation: { taskId: parentTaskId },
			},
		);
		await ledger.release();
	}

	async function seedBindingFacts(session: Session, taskId: string, bindingId: string): Promise<void> {
		const value = binding(bindingId, taskId);
		const ledger = new SessionLedger(session, { ownerId: `seed-${value.bindingId}` });
		await ledger.appendFact("task", value.taskId, taskEnvelope(value.taskId), {
			clientRequestId: `seed:task:${value.taskId}`,
			expectedRevision: 0,
			correlation: { taskId: value.taskId },
		});
		await ledger.appendFact("role_revision", value.roleRevision.id, roleRevision, {
			clientRequestId: `seed:role:${value.roleRevision.id}`,
			expectedRevision: 0,
			correlation: { taskId: value.taskId, bindingId: value.bindingId },
		});
		await ledger.appendFact("model_profile_revision", value.modelProfileRevision.id, modelProfile("profile-fake"), {
			clientRequestId: `seed:model:${value.modelProfileRevision.id}`,
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
				clientRequestId: `seed:${objectType}:${reference.id}`,
				correlation: { taskId: value.taskId, bindingId: value.bindingId },
			});
		}
		await ledger.release();
	}

	class ConformanceTestProvider implements ChildAgentProvider {
		readonly schemaVersion = 1 as const;
		readonly providerClass = "agent" as const;
		public spawnCalled = 0;
		public lastSpawn: ChildSpawnResult | undefined;
		public lastSpawnId: string | undefined;
		public providerId: string;

		constructor(providerId: string) {
			this.providerId = providerId;
		}

		async capabilities(): Promise<readonly FoundationProviderCapability[]> {
			return [{ schemaVersion: 1, id: "foundation.conformance", version: 1 }];
		}

		async spawn(request: ChildSpawnRequest): Promise<Result<ChildSpawnResult, FoundationError>> {
			this.spawnCalled++;
			this.lastSpawnId = request.spawnId;
			const childTaskId = request.taskEnvelope.taskId;
			const childBindingId = `binding-${childTaskId}`;
			const agent = createAgentInstance({
				agentInstanceId: `child-instance-${childTaskId}`,
				providerId: this.providerId,
				providerDeclaredAgent: true,
				roleRevision,
				taskId: childTaskId,
				now: () => fakeNow,
			});
			if (!agent.ok) return Result.err(agent.error);

			const epoch = createBindingEpoch({
				bindingEpochId: `child-epoch-${childTaskId}`,
				taskId: childTaskId,
				attemptId: `child-attempt-${childTaskId}`,
				bindingId: childBindingId,
				agentInstanceId: agent.value.agentInstanceId,
				activationReason: "attempt_started",
				activatedByCommandId: `child-command-${childTaskId}`,
				now: () => fakeNow,
			});
			if (!epoch.ok) return Result.err(epoch.error);

			const childAttempt = createAttempt({
				attemptId: `child-attempt-${childTaskId}`,
				dispatch: {
					schemaVersion: 1,
					dispatchId: `dispatch-${this.providerId}`,
					taskId: childTaskId,
					bindingId: childBindingId,
					taskExecutorProviderId: this.providerId,
					status: "pending",
					createdAt: fakeNow,
				},
				providerId: this.providerId,
				initialBindingEpoch: epoch.value,
				providerClass: "agent",
				agentInstanceId: agent.value.agentInstanceId,
				now: () => fakeNow,
			});
			if (!childAttempt.ok) return Result.err(childAttempt.error);

			this.lastSpawn = {
				schemaVersion: 1,
				attempt: childAttempt.value,
				agentInstance: agent.value,
				initialBindingEpoch: epoch.value,
			};
			return Result.ok(this.lastSpawn);
		}

		async lookupSpawn(spawnId: string): Promise<Result<ChildSpawnResult | undefined, FoundationError>> {
			if (spawnId === this.lastSpawnId) return Result.ok(this.lastSpawn);
			return Result.ok(undefined);
		}

		async resume(attemptId: string): Promise<Result<AttemptReceipt, FoundationError>> {
			if (!this.lastSpawn) return Result.err(new FoundationError("subagent_provider_unavailable", "no spawn"));
			if (attemptId !== this.lastSpawn.attempt.attemptId)
				return Result.err(new FoundationError("subagent_provider_unavailable", "wrong id"));

			const bindingEpochId = this.lastSpawn.attempt.bindingEpochIds[0];
			if (typeof bindingEpochId !== "string") {
				return Result.err(new FoundationError("subagent_provider_unavailable", "no binding epoch"));
			}

			const correlation = {
				sessionId: `session-${this.providerId}`,
				laneId: "main",
				taskId: this.lastSpawn.attempt.taskId,
				dispatchId: this.lastSpawn.attempt.dispatchId,
				attemptId,
				bindingId: this.lastSpawn.attempt.bindingId,
				bindingEpochId,
				agentInstanceId: this.lastSpawn.agentInstance.agentInstanceId,
				attemptReceiptId: `receipt-${attemptId}`,
				revision: 1,
			};
			return Result.ok({
				schemaVersion: 1,
				attemptReceiptId: `receipt-${attemptId}`,
				taskId: this.lastSpawn.attempt.taskId,
				dispatchId: this.lastSpawn.attempt.dispatchId,
				attemptId,
				providerId: this.providerId,
				agentInstanceId: this.lastSpawn.agentInstance.agentInstanceId,
				bindingId: this.lastSpawn.attempt.bindingId,
				bindingEpochIds: [...this.lastSpawn.attempt.bindingEpochIds],
				status: "succeeded",
				workerReceiptRefs: [],
				artifacts: [],
				provenance: {
					producerKind: "agent_executor",
					providerId: this.providerId,
					producedAt: fakeNow,
					correlation,
				},
				sideEffectState: "none",
			});
		}
		async cancel() {
			return Result.ok(undefined);
		}
		async dispose() {}
	}

	function spawnRequest(childTaskId: string): ChildSpawnRequest {
		const { fingerprint: _roleFingerprint, ...roleSnapshot } = roleRevision;
		const callerRole = {
			...roleSnapshot,
			name: "caller-shaped-role",
			fingerprint: fingerprintFoundationValue({ ...roleSnapshot, name: "caller-shaped-role" }),
		};
		const mp = modelProfile("profile-fake");
		const { fingerprint: _profileFingerprint, ...profileSnapshot } = mp;
		const callerProfile = {
			...profileSnapshot,
			model: "caller-shaped-model",
			fingerprint: fingerprintFoundationValue({ ...profileSnapshot, model: "caller-shaped-model" }),
		};

		return {
			schemaVersion: 1,
			spawnId: `spawn-${childTaskId}`,
			parentSpawn: {
				schemaVersion: 1,
				type: "agent.spawn",
				spawnId: "parent-spawn-fake",
				parentTaskId: "parent-task-fake",
				newTaskEnvelopeRef: { schemaVersion: 1, type: "task_envelope", id: childTaskId, revision: 1 },
				createdAt: fakeNow,
			},
			taskEnvelope: taskEnvelope(childTaskId),
			roleRevision: callerRole,
			modelProfile: callerProfile,
			forkScope: "none",
		};
	}

	async function executeSpawnTest(descriptor: SubagentProviderDescriptor, childTaskId: string) {
		const registry = new SubagentProviderRegistry();
		registry.register(descriptor);
		expect(registry.get(descriptor.descriptor.providerId)).toEqual(descriptor);
		expect(descriptor.implementedInThisLine).toBe(false);
		expect(() =>
			registry.resolve(descriptor.descriptor.providerId, { providerKind: descriptor.providerKind }),
		).toThrowError(
			new FoundationError(
				"subagent_provider_unavailable",
				`Provider ${descriptor.descriptor.providerId} is not implemented in this line.`,
			),
		);

		const providerId = descriptor.descriptor.providerId;
		const session = new Session(new InMemorySessionStorage({ id: `session-${providerId}`, createdAt: 1 }));
		await seedParentSpawnContext(session, "parent-task-fake", "parent-spawn-fake");
		await seedBindingFacts(session, childTaskId, `binding-${childTaskId}`);

		const childBinding = binding(`binding-${childTaskId}`, childTaskId);
		const seed = new SessionLedger(session, { ownerId: `spawn-seed-${providerId}` });
		await seed.appendFact("agent_binding", childBinding.bindingId, childBinding, {
			clientRequestId: "spawn:binding",
			correlation: { taskId: childBinding.taskId, bindingId: childBinding.bindingId },
		});
		await seed.release();

		const provider = new ConformanceTestProvider(providerId);
		const settlement = new LayeredResultSettlement(session, { ownerId: `settlement-${providerId}` });
		const request = spawnRequest(childTaskId);
		const correlation = {
			sessionId: `session-${providerId}`,
			laneId: "main",
			taskId: childTaskId,
			agentInstanceId: `child-instance-${childTaskId}`,
			revision: 1,
		};

		const result = await settlement.executeAgentSpawn({ provider, request, correlation });
		expect(result.ok).toBe(true);
		if (!result.ok) throw result.error;

		expect(provider.spawnCalled).toBe(1);
		expect(result.value.attempt.attemptId).toBe(`child-attempt-${childTaskId}`);

		// Replay
		const replay = await settlement.executeAgentSpawn({ provider, request, correlation });
		expect(replay.ok).toBe(true);
		expect(provider.spawnCalled).toBe(1); // not called again

		const wrongLookup = await provider.lookupSpawn("wrong-id");
		expect(wrongLookup.ok).toBe(true);
		if (wrongLookup.ok) expect(wrongLookup.value).toBeUndefined();

		const receiptResult = await provider.resume(result.value.attempt.attemptId);
		expect(receiptResult.ok).toBe(true);
		if (receiptResult.ok) {
			const valid = validateAttemptReceiptForProvider(receiptResult.value, { providerId, providerClass: "agent" });
			expect(valid.ok).toBe(true);

			expect(receiptResult.value.providerId).toBe(providerId);
			expect(receiptResult.value.taskId).toBe(childTaskId);
			expect(receiptResult.value.dispatchId).toBe(`dispatch-${providerId}`);
			expect(receiptResult.value.attemptId).toBe(`child-attempt-${childTaskId}`);
			expect(receiptResult.value.bindingId).toBe(`binding-${childTaskId}`);
			expect(receiptResult.value.bindingEpochIds[0]).toBe(`child-epoch-${childTaskId}`);
			expect(receiptResult.value.agentInstanceId).toBe(`child-instance-${childTaskId}`);
		}

		await settlement.release();
	}

	it("registers agent_runtime_host as unavailable while a consumer fake conforms through the public spawn entry", async () => {
		await executeSpawnTest(AGENT_RUNTIME_HOST_PROVIDER, "task-host");
	});

});
