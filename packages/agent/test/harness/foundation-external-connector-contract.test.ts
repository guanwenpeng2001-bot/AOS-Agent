import { describe, expect, it } from "vitest";
import {
	createAttempt as createCanonicalAttempt,
	createBindingEpoch,
	createConnectorCapabilitySnapshot,
	createModelProfileRevision,
	createRoleRevision,
	fingerprintFoundationValue,
	parseConnectorCapabilitySnapshot,
	resolveAgentBinding,
	serializeConnectorCapabilitySnapshot,
	validateAttemptReceiptForProvider,
	validateConnectorCapabilitySnapshot,
	validateConnectorCapabilitySnapshotForProvider,
	type AgentBinding,
	type Attempt,
	type AttemptReceipt,
	type ConnectorCapabilitySnapshot,
	type ConnectorCapabilitySnapshotInput,
	type Dispatch,
	type ExternalAgentConnector,
	type FoundationProviderCapability,
	type FoundationProviderExecutionOptions,
	type RevisionReference,
	type TaskEnvelope,
	type TaskExecutorAttemptContext,
	type TaskExecutorProvider,
} from "../../src/harness/foundation/index.ts";
import { FoundationError } from "../../src/harness/foundation/errors.ts";
import { Result } from "../../src/harness/result.ts";

const fakeNow = "2026-01-01T00:00:00.000Z";
const providerId = "third-party-connector";
const task: TaskEnvelope = {
	schemaVersion: 1,
	taskId: "task-external",
	goalId: "goal-external",
	goal: "Exercise the external connector contract",
	workspace: "workspace-external",
	capabilityRefs: [],
	inputs: [],
	expectedOutputs: [],
	budget: {},
	acceptanceCriteria: [],
	status: "ready",
	createdAt: fakeNow,
	updatedAt: fakeNow,
};

function immutableFact(type: string, id: string): RevisionReference {
	const value = { schemaVersion: 1 as const, type, id, revision: 1 };
	return { ...value, fingerprint: fingerprintFoundationValue(value) };
}

function binding(): AgentBinding {
	const role = createRoleRevision({
		definition: {
			schemaVersion: 1,
			roleId: "role-external",
			scope: "project",
			slug: "external",
			name: "External",
			description: "External connector role",
			revision: 1,
			persona: "Execute externally.",
			modelProfileRef: { schemaVersion: 1, type: "model_profile", id: "model-external", revision: 1 },
			capabilitySelector: { policy: "all" },
			skillSelector: { policy: "none" },
			mcpSelector: { policy: "none" },
		},
		now: () => fakeNow,
	});
	const modelProfile = createModelProfileRevision({
		schemaVersion: 1,
		modelProfileId: "model-external",
		provider: "host-model",
		model: "model-1",
		budget: {},
		revision: 1,
		createdAt: fakeNow,
	});
	const resolved = resolveAgentBinding({
		task,
		roleRevision: role,
		modelProfile,
		contextRevision: immutableFact("external_agent_binding", "external-binding-fact"),
		capabilityRevision: immutableFact("capability_binding", "capability-fact"),
		modelBrokerBindingRevision: immutableFact("model_broker_binding", "model-binding-fact"),
		policyRevision: immutableFact("policy_binding", "policy-fact"),
		newBindingId: "binding-external",
		now: () => fakeNow,
	});
	if (!resolved.ok) throw resolved.error;
	return resolved.value;
}

function capabilityInput(modelAccess: ConnectorCapabilitySnapshot["modelAccess"] = "agent_owned", resume = true): ConnectorCapabilitySnapshotInput {
	return {
		schemaVersion: 1,
		providerId,
		revision: 3,
		protocol: { name: "third-party-protocol", version: "2.1" },
		modelAccess,
		resume,
		toolGateway: false,
		artifacts: true,
		images: false,
	};
}

function dispatchAndContext(): { dispatch: Dispatch; context: TaskExecutorAttemptContext } {
	const dispatch: Dispatch = {
		schemaVersion: 1,
		dispatchId: "dispatch-external",
		taskId: task.taskId,
		bindingId: "binding-external",
		taskExecutorProviderId: providerId,
		status: "pending",
		createdAt: fakeNow,
	};
	const epoch = createBindingEpoch({
		bindingEpochId: "epoch-external-0",
		taskId: task.taskId,
		attemptId: "attempt-external",
		bindingId: dispatch.bindingId,
		activationReason: "attempt_started",
		activatedByCommandId: dispatch.dispatchId,
		now: () => fakeNow,
	});
	if (!epoch.ok) throw epoch.error;
	return { dispatch, context: { initialBindingEpoch: epoch.value } };
}

class ArbitraryExternalConnector implements ExternalAgentConnector {
	readonly schemaVersion = 1 as const;
	readonly providerId = providerId;
	readonly providerClass = "external_connector" as const;
	readonly calls = { probe: 0, run: 0, resume: 0, reconcile: 0, cancel: 0, dispose: 0 };
	readonly snapshot: ConnectorCapabilitySnapshot;

	constructor(resume = true) {
		this.snapshot = createConnectorCapabilitySnapshot(capabilityInput("agent_owned", resume));
	}

	async capabilities(): Promise<readonly FoundationProviderCapability[]> {
		return [{ schemaVersion: 1, id: "external.connector", version: 1 }];
	}

	async probeCapabilities(): Promise<Result<ConnectorCapabilitySnapshot, FoundationError>> {
		this.calls.probe++;
		return Result.ok(this.snapshot);
	}

	async createAttempt(dispatch: Dispatch, agentBinding: AgentBinding, context?: TaskExecutorAttemptContext): Promise<Result<Attempt, FoundationError>> {
		if (context === undefined || agentBinding.taskId !== dispatch.taskId || agentBinding.bindingId !== dispatch.bindingId) return Result.err(new FoundationError("invalid_correlation", "Connector createAttempt requires the canonical Binding and initial BindingEpoch"));
		return createCanonicalAttempt({
			attemptId: context.initialBindingEpoch.attemptId,
			dispatch,
			providerId: this.providerId,
			initialBindingEpoch: context.initialBindingEpoch,
			providerClass: this.providerClass,
			now: () => fakeNow,
		});
	}

	async runAttempt(attempt: Attempt, options?: FoundationProviderExecutionOptions): Promise<Result<AttemptReceipt, FoundationError>> {
		this.calls.run++;
		return Result.ok(this.receipt(attempt, "run", options));
	}

	async resumeAttempt(attempt: Attempt, options?: FoundationProviderExecutionOptions): Promise<Result<AttemptReceipt, FoundationError>> {
		this.calls.resume++;
		return this.snapshot.resume
			? Result.ok(this.receipt(attempt, "resume", options))
			: Result.err(new FoundationError("unsupported_feature", "External connector resume capability is false"));
	}

	async reconcileAttempt(attempt: Attempt, options?: FoundationProviderExecutionOptions): Promise<Result<AttemptReceipt, FoundationError>> {
		this.calls.reconcile++;
		return Result.ok(this.receipt(attempt, "reconcile", options));
	}

	async cancelAttempt(_attemptId: string): Promise<Result<void, FoundationError>> {
		this.calls.cancel++;
		return Result.ok(undefined);
	}

	async dispose(): Promise<void> {
		this.calls.dispose++;
	}

	private receipt(attempt: Attempt, phase: string, options?: FoundationProviderExecutionOptions): AttemptReceipt {
		const bindingEpochId = attempt.bindingEpochIds[0];
		if (bindingEpochId === undefined) throw new FoundationError("invalid_correlation", "External Attempt has no BindingEpoch");
		const attemptReceiptId = `receipt-external-${phase}`;
		return {
			schemaVersion: 1,
			attemptReceiptId,
			taskId: attempt.taskId,
			dispatchId: attempt.dispatchId,
			attemptId: attempt.attemptId,
			providerId: this.providerId,
			bindingId: attempt.bindingId,
			bindingEpochIds: [...attempt.bindingEpochIds],
			status: "succeeded",
			workerReceiptRefs: [],
			artifacts: [],
			provenance: {
				producerKind: "external_connector",
				providerId: this.providerId,
				producedAt: fakeNow,
				correlation: {
					...(options?.correlation ?? { sessionId: "session-external", laneId: "main", revision: 1 }),
					taskId: attempt.taskId,
					dispatchId: attempt.dispatchId,
					attemptId: attempt.attemptId,
					bindingId: attempt.bindingId,
					bindingEpochId,
					attemptReceiptId,
				},
			},
			sideEffectState: "none",
		};
	}
}

describe("Foundation ExternalAgentConnector contract", () => {
	it("is the external_connector specialization of TaskExecutorProvider and exposes no peer lifecycle", async () => {
		const connector: ExternalAgentConnector = new ArbitraryExternalConnector();
		const executor: TaskExecutorProvider = connector;
		expect(executor.providerClass).toBe("external_connector");
		for (const method of ["createAttempt", "runAttempt", "probeCapabilities", "resumeAttempt", "reconcileAttempt", "cancelAttempt", "dispose"]) expect(method in connector).toBe(true);
		for (const legacyMethod of ["probe", "start", "resume", "cancel"]) expect(legacyMethod in connector).toBe(false);
		const probed = await connector.probeCapabilities();
		expect(probed.ok).toBe(true);
		if (probed.ok) expect(validateConnectorCapabilitySnapshotForProvider(probed.value, connector).ok).toBe(true);
	});

	it("round-trips a stable exact capability snapshot and fails closed on unknown or drifted facts", () => {
		const snapshot = createConnectorCapabilitySnapshot(capabilityInput());
		const sameSnapshot = createConnectorCapabilitySnapshot(capabilityInput());
		expect(snapshot.digest).toEqual(sameSnapshot.digest);
		expect(Object.isFrozen(snapshot)).toBe(true);
		expect(Object.isFrozen(snapshot.protocol)).toBe(true);
		const parsed = parseConnectorCapabilitySnapshot(serializeConnectorCapabilitySnapshot(snapshot));
		expect(parsed).toEqual({ ok: true, value: snapshot });
		for (const modelAccess of ["none", "agent_owned", "aos_gateway"] as const) expect(validateConnectorCapabilitySnapshot(createConnectorCapabilitySnapshot(capabilityInput(modelAccess))).ok).toBe(true);
		expect(createConnectorCapabilitySnapshot({ ...capabilityInput(), revision: 4 }).digest).not.toEqual(snapshot.digest);
		expect(createConnectorCapabilitySnapshot({ ...capabilityInput(), images: true }).digest).not.toEqual(snapshot.digest);
		expect(validateConnectorCapabilitySnapshot({ ...snapshot, unknownCapability: true }).ok).toBe(false);
		expect(validateConnectorCapabilitySnapshot({ ...snapshot, modelAccess: "unknown" }).ok).toBe(false);
		expect(validateConnectorCapabilitySnapshot({ ...snapshot, resume: false }).ok).toBe(false);
		expect(() => createConnectorCapabilitySnapshot({ ...capabilityInput(), revision: 0 })).toThrowError(FoundationError);
		expect(() => createConnectorCapabilitySnapshot({ ...capabilityInput(), unknownCapability: true } as ConnectorCapabilitySnapshotInput)).toThrowError(FoundationError);
		const { images: _images, ...missingImageFact } = snapshot;
		expect(validateConnectorCapabilitySnapshot(missingImageFact).ok).toBe(false);
		expect(validateConnectorCapabilitySnapshotForProvider(snapshot, { providerId, providerClass: "external_connector" }).ok).toBe(true);
		expect(validateConnectorCapabilitySnapshotForProvider(snapshot, { providerId: "other", providerClass: "external_connector" }).ok).toBe(false);
		expect(validateConnectorCapabilitySnapshotForProvider(snapshot, { providerId, providerClass: "agent" }).ok).toBe(false);
	});

	it("keeps createAttempt pure and constructs only the canonical Attempt from Binding and BindingEpoch", async () => {
		const connector = new ArbitraryExternalConnector();
		const { dispatch, context } = dispatchAndContext();
		const created = await connector.createAttempt(dispatch, binding(), context);
		expect(created.ok).toBe(true);
		expect(connector.calls).toEqual({ probe: 0, run: 0, resume: 0, reconcile: 0, cancel: 0, dispose: 0 });
		if (!created.ok) throw created.error;
		expect(created.value).toMatchObject({
			attemptId: context.initialBindingEpoch.attemptId,
			dispatchId: dispatch.dispatchId,
			taskId: dispatch.taskId,
			providerId,
			bindingId: dispatch.bindingId,
			bindingEpochIds: [context.initialBindingEpoch.bindingEpochId],
			status: "starting",
		});
		expect(created.value.agentInstanceId).toBeUndefined();
		const mismatched = await connector.createAttempt({ ...dispatch, bindingId: "other" }, binding(), context);
		expect(mismatched.ok).toBe(false);
		expect(connector.calls).toEqual({ probe: 0, run: 0, resume: 0, reconcile: 0, cancel: 0, dispose: 0 });
	});

	it("settles run, resume, and reconcile through canonical AttemptReceipt conformance", async () => {
		const connector = new ArbitraryExternalConnector();
		const { dispatch, context } = dispatchAndContext();
		const created = await connector.createAttempt(dispatch, binding(), context);
		if (!created.ok) throw created.error;
		for (const receipt of [await connector.runAttempt(created.value), await connector.resumeAttempt(created.value), await connector.reconcileAttempt(created.value)]) {
			expect(receipt.ok).toBe(true);
			if (!receipt.ok) throw receipt.error;
			expect(validateAttemptReceiptForProvider(receipt.value, { providerId, providerClass: "external_connector" }).ok).toBe(true);
			expect(receipt.value.agentInstanceId).toBeUndefined();
			expect(receipt.value.provenance.producerKind).toBe("external_connector");
		}
		expect((await connector.cancelAttempt(created.value.attemptId)).ok).toBe(true);
		await connector.dispose();
		expect(connector.calls).toEqual({ probe: 0, run: 1, resume: 1, reconcile: 1, cancel: 1, dispose: 1 });
		const noResume = new ArbitraryExternalConnector(false);
		expect(await noResume.resumeAttempt(created.value)).toMatchObject({ ok: false, error: { code: "unsupported_feature" } });
	});
});
