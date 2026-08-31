import { describe, expect, it } from "vitest";
import { Result, type ResultValue } from "../../src/harness/result.ts";
import {
	ScopedExecutionGateway,
	createBindingEpoch,
	createModelProfileRevision,
	createRoleRevision,
	fingerprintFoundationValue,
	FoundationError,
	PROVIDER_CLASS,
	resolveAgentBinding,
	SessionLedger,
	validateImmutableAgentBinding,
	validateRoleRevision,
	validateSecretFreeModelProfile,
	type AgentBinding,
	type BindingEpoch,
	type FoundationProviderCapability,
	type FoundationJsonValue,
	type ModelProfile,
	type RevisionReference,
	type RoleRevision,
	type ScopedModelGateway,
	type ScopedModelRequest,
	type ScopedModelResult,
	type TaskEnvelope,
} from "../../src/harness/foundation/index.ts";
import { InMemorySessionStorage, Session } from "../../src/harness/session/index.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const EXPIRES = "2026-01-01T00:05:00.000Z";
const CREDENTIAL_SENTINEL = "credential-material-must-not-cross";
const capability: FoundationProviderCapability = { schemaVersion: 1, id: "foundation.t6.gateway", version: 1 };

interface CredentialTargetReference {
	readonly schemaVersion: 1;
	readonly targetId: string;
	readonly targetKind: string;
	readonly bindingId: string;
	readonly issuedAt: string;
	readonly expiresAt: string;
}

interface CredentialLeaseReference {
	readonly schemaVersion: 1;
	readonly leaseId: string;
	readonly targetId: string;
	readonly bindingId: string;
	readonly bindingEpochId: string;
	readonly issuedAt: string;
	readonly expiresAt: string;
}

interface ExternalExecutorRequest {
	readonly requestId: string;
	readonly taskId: string;
	readonly bindingEpochId: string;
	readonly attemptId: string;
	readonly modelProfileRevision: RevisionReference;
	readonly input: FoundationJsonValue;
}

function task(): TaskEnvelope {
	return {
		schemaVersion: 1,
		taskId: "task-t6-gateway",
		goalId: "goal-t6-gateway",
		goal: "exercise the scoped external executor contract",
		workspace: "workspace-t6-gateway",
		capabilityRefs: [],
		inputs: [],
		expectedOutputs: [],
		budget: { modelCalls: 2 },
		acceptanceCriteria: [],
		status: "ready",
		createdAt: NOW,
		updatedAt: NOW,
	};
}

function roleRevision(): RoleRevision {
	return createRoleRevision({
		definition: {
			schemaVersion: 1,
			roleId: "role-t6-gateway",
			scope: "project",
			slug: "t6-gateway",
			name: "gateway role",
			description: "A credential-free external executor role",
			revision: 1,
			persona: "Use the scoped gateway",
			modelProfileRef: { schemaVersion: 1, type: "model_profile", id: "profile-t6-gateway", revision: 1 },
			capabilitySelector: { policy: "none" },
			skillSelector: { policy: "none" },
			mcpSelector: { policy: "none" },
		},
		now: () => NOW,
	});
}

function modelProfile(): ModelProfile {
	return createModelProfileRevision({ schemaVersion: 1, modelProfileId: "profile-t6-gateway", provider: "fake", model: "fake-model", budget: { modelCalls: 2 }, revision: 1, createdAt: NOW });
}

function immutableReference(type: string, id: string): RevisionReference {
	const payload = { schemaVersion: 1 as const, type, id, revision: 1 };
	return { ...payload, fingerprint: fingerprintFoundationValue(payload) };
}

function binding(): AgentBinding {
	const currentTask = task();
	const currentRole = roleRevision();
	const currentProfile = modelProfile();
	const result = resolveAgentBinding({
		task: currentTask,
		roleRevision: currentRole,
		modelProfile: currentProfile,
		contextRevision: immutableReference("external_agent_binding", "external-t6-gateway"),
		capabilityRevision: immutableReference("capability_binding", "capability-t6-gateway"),
		modelBrokerBindingRevision: immutableReference("model_broker_binding", "broker-t6-gateway"),
		policyRevision: immutableReference("policy_binding", "policy-t6-gateway"),
		newBindingId: "binding-t6-gateway",
		now: () => NOW,
	});
	if (!result.ok) throw result.error;
	return result.value;
}

function epoch(currentBinding: AgentBinding): BindingEpoch {
	const result = createBindingEpoch({
		bindingEpochId: "epoch-t6-gateway",
		taskId: currentBinding.taskId,
		attemptId: "attempt-t6-gateway",
		bindingId: currentBinding.bindingId,
		activationReason: "attempt_started",
		activatedByCommandId: "dispatch-t6-gateway",
		now: () => NOW,
	});
	if (!result.ok) throw result.error;
	return result.value;
}

function targetReference(currentBinding: AgentBinding): CredentialTargetReference {
	return { schemaVersion: 1, targetId: "target-t6-gateway", targetKind: "external-model", bindingId: currentBinding.bindingId, issuedAt: NOW, expiresAt: EXPIRES };
}

function leaseReference(currentBinding: AgentBinding, currentEpoch: BindingEpoch): CredentialLeaseReference {
	return { schemaVersion: 1, leaseId: "lease-t6-gateway", targetId: "target-t6-gateway", bindingId: currentBinding.bindingId, bindingEpochId: currentEpoch.bindingEpochId, issuedAt: NOW, expiresAt: EXPIRES };
}

function isShortLivedReference(value: unknown, now = NOW): value is CredentialTargetReference | CredentialLeaseReference {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const record = value as Record<string, unknown>;
	if (record.schemaVersion !== 1 || typeof record.bindingId !== "string" || typeof record.issuedAt !== "string" || typeof record.expiresAt !== "string") return false;
	if (Date.parse(record.expiresAt) <= Date.parse(now)) return false;
	if (typeof record.targetId !== "string") return false;
	if ("leaseId" in record) {
		if (Object.keys(record).some((key) => !["schemaVersion", "leaseId", "targetId", "bindingId", "bindingEpochId", "issuedAt", "expiresAt"].includes(key))) return false;
		return typeof record.leaseId === "string" && typeof record.bindingEpochId === "string";
	}
	if (Object.keys(record).some((key) => !["schemaVersion", "targetId", "targetKind", "bindingId", "issuedAt", "expiresAt"].includes(key))) return false;
	return typeof record.targetKind === "string";
}

function hasCredentialMaterial(value: unknown): boolean {
	if (value === null || typeof value !== "object") return false;
	if (Array.isArray(value)) return value.some(hasCredentialMaterial);
	for (const [key, child] of Object.entries(value)) {
		if (key !== "fencingToken" && /credential|secret|password|token|authorization|apiKey|material/i.test(key)) return true;
		if (hasCredentialMaterial(child)) return true;
	}
	return false;
}

class ConsumerModelGateway implements ScopedModelGateway {
	readonly schemaVersion = 1 as const;
	readonly providerId = "model-gateway-t6";
	readonly providerClass = "gateway" as const;
	readonly requests: ScopedModelRequest[] = [];
	async capabilities(): Promise<readonly FoundationProviderCapability[]> { return [capability]; }
	async stream(request: ScopedModelRequest): Promise<ResultValue<ScopedModelResult, FoundationError>> {
		this.requests.push(request);
		return Result.ok({ schemaVersion: 1, requestId: request.requestId, usage: { tokens: 1 }, stopReason: "stop" });
	}
	async dispose(): Promise<void> {}
}

class ConsumerShapedExternalExecutor {
	private readonly gateway: ScopedExecutionGateway;
	private readonly logs: string[] = [];

	constructor(gateway: ScopedExecutionGateway) {
		this.gateway = gateway;
	}

	async execute(request: ExternalExecutorRequest, target: CredentialTargetReference, lease: CredentialLeaseReference): Promise<ResultValue<ScopedModelResult, FoundationError>> {
		if (!isShortLivedReference(target) || !isShortLivedReference(lease) || !("leaseId" in lease)) return Result.err(new FoundationError("tool_guard_denied", "External executor requires short-lived credential references"));
		if (target.bindingId !== this.gateway.scope.bindingId || lease.bindingId !== this.gateway.scope.bindingId || lease.bindingEpochId !== this.gateway.scope.bindingEpochId || lease.targetId !== target.targetId) return Result.err(new FoundationError("invalid_correlation", "Credential references do not match the scoped gateway"));
		this.logs.push(JSON.stringify({ requestId: request.requestId, bindingId: lease.bindingId, bindingEpochId: lease.bindingEpochId, targetId: target.targetId, leaseId: lease.leaseId }));
		return this.gateway.stream({ schemaVersion: 1, requestId: request.requestId, modelProfileRevision: request.modelProfileRevision, bindingEpochId: request.bindingEpochId, taskId: request.taskId, attemptId: request.attemptId, input: request.input });
	}

	logEntries(): readonly string[] { return [...this.logs]; }
}

function request(currentBinding: AgentBinding, currentEpoch: BindingEpoch, overrides: Partial<ExternalExecutorRequest> = {}): ExternalExecutorRequest {
	return {
		requestId: "model-request-t6-gateway",
		taskId: currentBinding.taskId,
		bindingEpochId: currentEpoch.bindingEpochId,
		attemptId: currentEpoch.attemptId,
		modelProfileRevision: currentBinding.modelProfileRevision,
		input: { text: "bounded" },
		...overrides,
	};
}

async function persistCredentialFreeFacts(session: Session, currentBinding: AgentBinding, currentEpoch: BindingEpoch): Promise<void> {
	const ledger = new SessionLedger(session, { ownerId: "t6-gateway-seed" });
	await ledger.appendFact("task", currentBinding.taskId, task(), { clientRequestId: "t6-gateway:task", expectedRevision: 0, correlation: { taskId: currentBinding.taskId } });
	await ledger.appendFact("role_revision", currentBinding.roleRevision.id, roleRevision(), { clientRequestId: "t6-gateway:role", expectedRevision: 0, correlation: { taskId: currentBinding.taskId } });
	await ledger.appendFact("model_profile_revision", currentBinding.modelProfileRevision.id, modelProfile(), { clientRequestId: "t6-gateway:profile", expectedRevision: 0, correlation: { taskId: currentBinding.taskId } });
	await ledger.appendFact("agent_binding", currentBinding.bindingId, currentBinding, { clientRequestId: "t6-gateway:binding", expectedRevision: 0, correlation: { taskId: currentBinding.taskId, bindingId: currentBinding.bindingId } });
	await ledger.appendFact("binding_epoch", currentEpoch.bindingEpochId, currentEpoch, { clientRequestId: "t6-gateway:epoch", expectedRevision: 0, correlation: { taskId: currentBinding.taskId, bindingId: currentBinding.bindingId, bindingEpochId: currentEpoch.bindingEpochId } });
	await ledger.release();
}

describe("external executor scoped gateway conformance", () => {
	it("uses only the scoped gateways and short-lived credential references", async () => {
		const currentBinding = binding();
		const currentEpoch = epoch(currentBinding);
		const target = targetReference(currentBinding);
		const lease = leaseReference(currentBinding, currentEpoch);
		const model = new ConsumerModelGateway();
		const gateway = new ScopedExecutionGateway({ model, binding: currentBinding, epoch: currentEpoch, providerClass: PROVIDER_CLASS.externalConnector, budget: { modelCalls: 1 } });
		const executor = new ConsumerShapedExternalExecutor(gateway);
		const result = await executor.execute(request(currentBinding, currentEpoch), target, lease);
		expect(result).toMatchObject({ ok: true, value: { requestId: "model-request-t6-gateway" } });
		expect(model.requests).toHaveLength(1);
		expect(isShortLivedReference(target)).toBe(true);
		expect(isShortLivedReference(lease)).toBe(true);
		expect(executor.logEntries()).toHaveLength(1);
		expect(hasCredentialMaterial(model.requests)).toBe(false);
		expect(hasCredentialMaterial(executor.logEntries())).toBe(false);
		const expired = { ...lease, expiresAt: NOW };
		expect(isShortLivedReference(expired)).toBe(false);
		const forged = { ...target, material: CREDENTIAL_SENTINEL };
		expect(isShortLivedReference(forged)).toBe(false);
	});

	it("rejects credential material at role/profile/binding boundaries and keeps durable facts free of it", async () => {
		const currentBinding = binding();
		const currentEpoch = epoch(currentBinding);
		const profileWithMaterial = { ...modelProfile(), credentialMaterial: CREDENTIAL_SENTINEL };
		const roleWithMaterial = { ...roleRevision(), credentialMaterial: CREDENTIAL_SENTINEL };
		const bindingWithMaterial = { ...currentBinding, credentialMaterial: CREDENTIAL_SENTINEL };
		expect(validateSecretFreeModelProfile(profileWithMaterial).ok).toBe(false);
		expect(validateRoleRevision(roleWithMaterial).ok).toBe(false);
		expect(validateImmutableAgentBinding(bindingWithMaterial).ok).toBe(false);
		const session = new Session(new InMemorySessionStorage({ id: "t6-gateway-session", createdAt: 1 }));
		await persistCredentialFreeFacts(session, currentBinding, currentEpoch);
		const records = await session.findFoundationRecords({ order: "oldestFirst" });
		expect(hasCredentialMaterial(records)).toBe(false);
		expect(hasCredentialMaterial(currentBinding)).toBe(false);
		expect(hasCredentialMaterial(modelProfile())).toBe(false);
		expect(hasCredentialMaterial(roleRevision())).toBe(false);
	});

	it("fails closed across binding, epoch, and profile identities", async () => {
		const currentBinding = binding();
		const currentEpoch = epoch(currentBinding);
		const target = targetReference(currentBinding);
		const lease = leaseReference(currentBinding, currentEpoch);
		const model = new ConsumerModelGateway();
		const gateway = new ScopedExecutionGateway({ model, binding: currentBinding, epoch: currentEpoch, providerClass: PROVIDER_CLASS.externalConnector, budget: { modelCalls: 2 } });
		const executor = new ConsumerShapedExternalExecutor(gateway);
		const good = await executor.execute(request(currentBinding, currentEpoch), target, lease);
		expect(good.ok).toBe(true);
		const wrongEpoch = await executor.execute(request(currentBinding, currentEpoch, { bindingEpochId: "epoch-other" }), target, lease);
		expect(wrongEpoch).toMatchObject({ ok: false, error: { code: "binding_task_before_binding" } });
		const wrongProfile = { ...currentBinding.modelProfileRevision, id: "profile-other" };
		const profileResult = await executor.execute(request(currentBinding, currentEpoch, { modelProfileRevision: wrongProfile }), target, lease);
		expect(profileResult).toMatchObject({ ok: false, error: { code: "binding_task_before_binding" } });
		const otherBinding = { ...currentBinding, bindingId: "binding-other" };
		const mismatchedEpoch = { ...currentEpoch, bindingId: otherBinding.bindingId };
		const mismatchedGateway = new ScopedExecutionGateway({ model, binding: currentBinding, epoch: mismatchedEpoch, providerClass: PROVIDER_CLASS.externalConnector });
		const mismatchedExecutor = new ConsumerShapedExternalExecutor(mismatchedGateway);
		const bindingResult = await mismatchedExecutor.execute(request(currentBinding, mismatchedEpoch), target, lease);
		expect(bindingResult).toMatchObject({ ok: false, error: { code: "binding_epoch_mismatch" } });
	});
});
