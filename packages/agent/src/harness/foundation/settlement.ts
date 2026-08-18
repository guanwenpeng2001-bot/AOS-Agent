import { Result, type Result as ResultValue } from "../result.ts";
import type { Session } from "../session/session.ts";
import { DurableLedgerError } from "../session/durable/errors.ts";
import { FoundationError, toFoundationError } from "./errors.ts";
import { canonicalFoundationJson, fingerprintFoundationValue } from "./identity.ts";
import { cloneDeepFrozen } from "./immutability.ts";
import { executeDispatchV1, executeOperationV1, executeAgentSpawnV1, switchAgentModeV1, type DispatchExecutionInputV1, type DispatchExecutionResultV1, type OperationExecutionInputV1, type ChildSpawnExecutionInputV1, type ModeSwitchExecutionInputV1 } from "./execution.ts";
import { validateImmutableAgentBinding } from "./binding.ts";
import { validateAttemptReceiptForProviderV1, validateWorkerReceiptForProviderV1 } from "./conformance.ts";
import {
	finalizeRunReceipt,
	settleTaskResult,
	validateAttemptReceipt,
	validateWorkerReceipt,
	validateRunReceiptV1,
	type AttemptReceiptV1,
	type FinalizeRunReceiptInput,
	type HostTerminalGateAuthorityV1,
	type RunReceiptV1,
	type SettleTaskResultInput,
	type TaskResultV1,
	type WorkerReceiptV1,
} from "./results.ts";
import { validateChildSpawnRequestV1, type ChildSpawnResultV1 } from "./providers.ts";
import { validateAgentInstanceV1, validateBindingEpochV1, validateRoleRevisionV1, type AgentBindingV1, type AgentInstanceV1, type BindingEpochV1, type ModelProfileV1, type RoleRevisionV1 } from "./role.ts";
import { validateRoleRegistryRecordV1 } from "./role-registry.ts";
import { validateSecretFreeModelProfileV1 } from "./model-profile.ts";
import { validateAttempt, validateDispatch, validateTaskEnvelope, type AttemptV1, type DispatchV1, type TaskEnvelopeV1 } from "./task.ts";
import { SessionLedgerV1 } from "./session-ledger.ts";

export interface FoundationTaskPersistenceOptionsV1 {
	readonly ownerId?: string;
}

/**
 * The public execution surface establishes the TaskEnvelope in Session before
 * binding or role resolution can consume it. Existing task identities are
 * immutable; a caller cannot replace a durable task with a caller-shaped copy.
 */
export async function persistTaskEnvelopeBeforeResolverV1(session: Session, task: TaskEnvelopeV1, options: FoundationTaskPersistenceOptionsV1 = {}): Promise<ResultValue<TaskEnvelopeV1, FoundationError>> {
	const checked = validateTaskEnvelope(task);
	if (!checked.ok) return checked;
	const ledger = new SessionLedgerV1(session, { ownerId: options.ownerId });
	try {
		const existing = await ledger.get("task", checked.value.taskId);
		if (existing?.kind === "fact") {
			if (canonicalFoundationJson(existing.payload) !== canonicalFoundationJson(checked.value)) return Result.err(new FoundationError("session_ledger_conflict", "A durable TaskEnvelope already exists with different content", { details: { taskId: checked.value.taskId } }));
			return Result.ok(cloneDeepFrozen(existing.payload as unknown as TaskEnvelopeV1));
		}
		if (existing !== undefined) return Result.err(new FoundationError("session_ledger_tombstoned", "A durable TaskEnvelope identity cannot replace a terminal object", { details: { taskId: checked.value.taskId } }));
		const stored = await ledger.appendFact("task", checked.value.taskId, checked.value, { clientRequestId: `task:${checked.value.taskId}`, expectedRevision: 0, correlation: { taskId: checked.value.taskId, goalId: checked.value.goalId } });
		return Result.ok(cloneDeepFrozen(stored.payload));
	} catch (error) {
		if (error instanceof DurableLedgerError) throw error;
		return Result.err(toFoundationError(error, "session_writer_stale_revision"));
	} finally {
		await ledger.release();
	}
}

/** Validate every immutable reference used by an AgentBinding against Session facts. */
export async function validateDurableBindingSourcesV1(session: Session, binding: AgentBindingV1, task?: TaskEnvelopeV1): Promise<ResultValue<AgentBindingV1, FoundationError>> {
	const checked = validateImmutableAgentBinding(binding);
	if (!checked.ok) return checked;
	const ledger = new SessionLedgerV1(session);
	try {
		await requireDurableBindingSources(ledger, checked.value, task);
		return Result.ok(cloneDeepFrozen(checked.value));
	} catch (error) {
		if (error instanceof FoundationError) return Result.err(error);
		if (error instanceof DurableLedgerError) throw error;
		return Result.err(toFoundationError(error, "binding_required_fact"));
	} finally {
		await ledger.release();
	}
}

export interface LayeredTaskSettlementInput {
	readonly taskResultId: string;
	readonly task: TaskEnvelopeV1;
	readonly sourceAttemptReceiptIds: readonly string[];
	readonly summary: string;
	readonly artifacts?: SettleTaskResultInput["artifacts"];
	readonly diff?: SettleTaskResultInput["diff"];
	readonly tests: SettleTaskResultInput["tests"];
	readonly evidence: SettleTaskResultInput["evidence"];
	readonly producer: SettleTaskResultInput["producer"];
	readonly validation?: SettleTaskResultInput["validation"];
}

export interface LayeredRunFinalizationInput {
	readonly runReceiptId: string;
	readonly runId: string;
	readonly terminalStatus: FinalizeRunReceiptInput["terminalStatus"];
	readonly authority: HostTerminalGateAuthorityV1;
	readonly attemptReceiptIds: readonly string[];
	readonly taskResultId?: string;
	readonly terminalErrorCode?: string;
	readonly completedAt?: string;
}

function durableReferenceMatches(reference: { readonly id: string; readonly revision: number; readonly fingerprint?: { readonly value: string } }, payload: unknown): boolean {
	if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return false;
	const record = payload as Record<string, unknown>;
	if (record.revision !== reference.revision) return false;
	if (reference.fingerprint === undefined) return false;
	return fingerprintFoundationValue(payload).value === reference.fingerprint.value;
}

function sourceRequired(reference: { readonly id: string; readonly revision: number }, field: string): FoundationError {
	return new FoundationError("binding_required_fact", `AgentBinding ${field} must resolve to a durable immutable source fact`, { details: { field, objectId: reference.id, revision: reference.revision } });
}

function immutableEntityFingerprintValid(payload: { readonly fingerprint: { readonly value: string } } & Record<string, unknown>): boolean {
	const { fingerprint, ...base } = payload;
	return fingerprint.value === fingerprintFoundationValue(base).value;
}

async function findDurableRoleRevision(ledger: SessionLedgerV1, reference: AgentBindingV1["roleRevision"]): Promise<RoleRevisionV1> {
	const direct = await ledger.get("role_revision", reference.id);
	if (direct?.kind === "fact") {
		const checked = validateRoleRevisionV1(direct.payload);
		if (checked.ok && checked.value.roleRevisionId === reference.id && checked.value.revision === reference.revision && checked.value.fingerprint.value === reference.fingerprint?.value && immutableEntityFingerprintValid(checked.value as unknown as { readonly fingerprint: { readonly value: string } } & Record<string, unknown>)) return checked.value;
	}
	const records = await ledger.find({ kind: "fact", objectType: "role_registry", order: "oldestFirst" });
	for (const record of records) {
		if (record.kind !== "fact") continue;
		const checked = validateRoleRegistryRecordV1(record.payload);
		if (!checked.ok) continue;
		const revision = checked.value.revisions.find((candidate) => candidate.roleRevisionId === reference.id && candidate.revision === reference.revision);
		if (revision !== undefined && revision.fingerprint.value === reference.fingerprint?.value && immutableEntityFingerprintValid(revision as unknown as { readonly fingerprint: { readonly value: string } } & Record<string, unknown>)) return revision;
	}
	throw sourceRequired(reference, "roleRevision");
}

function profileFromRecord(payload: unknown, reference: AgentBindingV1["modelProfileRevision"]): ModelProfileV1 | undefined {
	const direct = validateSecretFreeModelProfileV1(payload);
	if (direct.ok && direct.value.modelProfileId === reference.id && direct.value.revision === reference.revision && direct.value.fingerprint.value === reference.fingerprint?.value) return direct.value;
	if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return undefined;
	const record = payload as Record<string, unknown>;
	if (record.modelProfileId !== reference.id || !Array.isArray(record.revisions)) return undefined;
	for (const candidate of record.revisions) {
		const checked = validateSecretFreeModelProfileV1(candidate);
		if (checked.ok && checked.value.modelProfileId === reference.id && checked.value.revision === reference.revision && checked.value.fingerprint.value === reference.fingerprint?.value) return checked.value;
	}
	return undefined;
}

async function findDurableModelProfile(ledger: SessionLedgerV1, reference: AgentBindingV1["modelProfileRevision"]): Promise<ModelProfileV1> {
	const direct = await ledger.get("model_profile_revision", reference.id);
	if (direct?.kind === "fact") {
		const profile = profileFromRecord(direct.payload, reference);
		if (profile !== undefined) return profile;
	}
	const records = await ledger.find({ kind: "fact", objectType: "model_profile", order: "oldestFirst" });
	for (const record of records) {
		if (record.kind !== "fact") continue;
		const profile = profileFromRecord(record.payload, reference);
		if (profile !== undefined) return profile;
	}
	throw sourceRequired(reference, "modelProfileRevision");
}

async function requireDurableRevisionFact(ledger: SessionLedgerV1, objectType: string, reference: AgentBindingV1["contextRevision"]): Promise<void> {
	const fact = await ledger.get(objectType, reference.id);
	if (fact?.kind !== "fact" || !durableReferenceMatches(reference, fact.payload)) throw sourceRequired(reference, reference.type);
}

async function requireDurableBindingSources(ledger: SessionLedgerV1, binding: AgentBindingV1, task?: TaskEnvelopeV1): Promise<void> {
	const role = await findDurableRoleRevision(ledger, binding.roleRevision);
	const profile = await findDurableModelProfile(ledger, binding.modelProfileRevision);
	if (task !== undefined && binding.taskId !== task.taskId) throw new FoundationError("binding_task_before_binding", "Binding references a different durable TaskEnvelope", { details: { bindingId: binding.bindingId, taskId: task.taskId } });
	if (task !== undefined && binding.goalId !== task.goalId) throw new FoundationError("binding_task_before_binding", "Binding goal identity does not match its durable TaskEnvelope", { details: { bindingId: binding.bindingId, taskId: task.taskId } });
	if (binding.roleRevision.id !== role.roleRevisionId || binding.roleRevision.revision !== role.revision || binding.roleRevision.fingerprint?.value !== role.fingerprint.value) throw sourceRequired(binding.roleRevision, "roleRevision");
	if (binding.modelProfileRevision.id !== profile.modelProfileId || binding.modelProfileRevision.revision !== profile.revision || binding.modelProfileRevision.fingerprint?.value !== profile.fingerprint.value) throw sourceRequired(binding.modelProfileRevision, "modelProfileRevision");
	const expectedRoute = { provider: profile.provider, model: profile.model, ...(profile.effort === undefined ? {} : { effort: profile.effort }), ...(profile.serviceTier === undefined ? {} : { serviceTier: profile.serviceTier }) };
	if (canonicalFoundationJson(binding.modelRoute) !== canonicalFoundationJson(expectedRoute)) throw new FoundationError("binding_required_fact", "AgentBinding model route does not match the durable ModelProfile", { details: { bindingId: binding.bindingId, modelProfileId: profile.modelProfileId } });
	await requireDurableRevisionFact(ledger, "external_agent_binding", binding.contextRevision);
	await requireDurableRevisionFact(ledger, "capability_binding", binding.capabilityRevision);
	await requireDurableRevisionFact(ledger, "model_broker_binding", binding.modelBrokerBindingRevision);
	await requireDurableRevisionFact(ledger, "policy_binding", binding.policyRevision);
}

/**
 * Session-backed provider consumer and Host terminal gate. The Session ledger is
 * the sole authority; this class retains only its writer lease token.
 */
export class LayeredResultSettlementV1 {
	private readonly ledger: SessionLedgerV1;
	private finalizationTail: Promise<void> = Promise.resolve();

	constructor(session: Session, options: { readonly ownerId?: string } = {}) {
		this.ledger = new SessionLedgerV1(session, { ownerId: options.ownerId });
	}

	async executeOperation(input: OperationExecutionInputV1): Promise<ResultValue<WorkerReceiptV1, FoundationError>> {
		const executed = await executeOperationV1(input);
		if (!executed.ok) return executed;
		const checked = validateWorkerReceiptForProviderV1(executed.value, { providerId: input.provider.providerId, providerClass: input.provider.providerClass });
		if (!checked.ok) return checked;
		try {
			const stored = await this.persistFact("worker_receipt", checked.value.workerReceiptId, checked.value, { taskId: checked.value.taskId, dispatchId: checked.value.dispatchId, attemptId: checked.value.attemptId }, { immutable: true });
			return Result.ok(cloneDeepFrozen(stored.payload));
		} catch (error) {
			return this.persistenceError(error, "worker_receipt_invalid_producer");
		}
	}

	async executeDispatch(input: DispatchExecutionInputV1 & { readonly agentInstance?: AgentInstanceV1 }): Promise<ResultValue<DispatchExecutionResultV1, FoundationError>> {
		const checkedDispatch = validateDispatch(input.dispatch);
		if (!checkedDispatch.ok) return checkedDispatch;
		const checkedBinding = validateImmutableAgentBinding(input.binding);
		if (!checkedBinding.ok) return checkedBinding;
		const checkedEpoch = validateBindingEpochV1(input.initialBindingEpoch);
		if (!checkedEpoch.ok) return checkedEpoch;
		if (input.provider.providerClass === "agent") {
			if (input.agentInstance === undefined) return Result.err(new FoundationError("agent_instance_required_for_agent_provider", "Agent provider execution requires a durable AgentInstance", { details: { providerId: input.provider.providerId } }));
			const checkedAgent = validateAgentInstanceV1(input.agentInstance);
			if (!checkedAgent.ok) return checkedAgent;
			if (checkedAgent.value.agentInstanceId !== checkedEpoch.value.agentInstanceId || checkedAgent.value.taskId !== checkedDispatch.value.taskId || checkedAgent.value.providerId !== input.provider.providerId) return Result.err(new FoundationError("invalid_correlation", "AgentInstance does not match the dispatch epoch", { details: { dispatchId: checkedDispatch.value.dispatchId } }));
		} else if (input.agentInstance !== undefined) {
			return Result.err(new FoundationError("agent_instance_forbidden_for_provider", "Non-agent provider execution cannot carry an AgentInstance", { details: { providerId: input.provider.providerId } }));
		}
		try {
			await this.requireExistingTask(checkedDispatch.value.taskId);
			await this.requireExistingBindingFacts(checkedBinding.value, checkedDispatch.value.taskId);
			await this.persistFact("agent_binding", checkedBinding.value.bindingId, checkedBinding.value, { taskId: checkedBinding.value.taskId, bindingId: checkedBinding.value.bindingId }, { immutable: true });
			await this.persistFact("binding_epoch", checkedEpoch.value.bindingEpochId, checkedEpoch.value, { taskId: checkedEpoch.value.taskId, attemptId: checkedEpoch.value.attemptId, bindingId: checkedEpoch.value.bindingId, bindingEpochId: checkedEpoch.value.bindingEpochId, agentInstanceId: checkedEpoch.value.agentInstanceId }, { immutable: true });
			if (input.agentInstance !== undefined) await this.persistFact("agent_instance", input.agentInstance.agentInstanceId, input.agentInstance, { taskId: input.agentInstance.taskId, agentInstanceId: input.agentInstance.agentInstanceId }, { immutable: true });
			await this.persistFact("dispatch", checkedDispatch.value.dispatchId, checkedDispatch.value, { taskId: checkedDispatch.value.taskId, dispatchId: checkedDispatch.value.dispatchId, bindingId: checkedDispatch.value.bindingId }, { immutable: true });
			const replayed = await this.findDurableDispatchExecution(checkedDispatch.value, checkedBinding.value, checkedEpoch.value, input.provider);
			if (replayed !== undefined) return Result.ok(replayed);
			const executed = await executeDispatchV1({ ...input, beforeRunAttempt: async (attempt) => {
				const checkedAttempt = validateAttempt(attempt);
				if (!checkedAttempt.ok) return checkedAttempt;
				try {
					await this.persistFact("attempt", checkedAttempt.value.attemptId, checkedAttempt.value, { taskId: checkedAttempt.value.taskId, dispatchId: checkedAttempt.value.dispatchId, attemptId: checkedAttempt.value.attemptId, bindingId: checkedAttempt.value.bindingId, bindingEpochId: checkedAttempt.value.bindingEpochIds[0], agentInstanceId: checkedAttempt.value.agentInstanceId }, { immutable: true });
					return Result.ok(undefined);
				} catch (error) {
					return this.persistenceError(error, "session_writer_stale_revision");
				}
			} });
			if (!executed.ok) return executed;
			return this.acceptProviderExecution(executed.value, input.provider.providerId, input.provider.providerClass);
		} catch (error) {
			return this.persistenceError(error, "session_writer_stale_revision");
		}
	}

	/** Provider execution is consumed and persisted privately; no public structured accept path exists. */
	private async acceptProviderExecution(execution: DispatchExecutionResultV1, providerId: string, providerClass: DispatchExecutionResultV1["providerClass"]): Promise<ResultValue<DispatchExecutionResultV1, FoundationError>> {
		const checked = validateAttemptReceiptForProviderV1(execution.receipt, { providerId, providerClass });
		if (!checked.ok) return checked;
		if (checked.value.attemptId !== execution.attempt.attemptId || checked.value.dispatchId !== execution.attempt.dispatchId || checked.value.taskId !== execution.attempt.taskId || checked.value.bindingId !== execution.attempt.bindingId || checked.value.agentInstanceId !== execution.attempt.agentInstanceId) return Result.err(new FoundationError("invalid_correlation", "Provider AttemptReceipt does not match its consumed Attempt", { details: { attemptReceiptId: checked.value.attemptReceiptId } }));
		for (const reference of checked.value.workerReceiptRefs) {
			const stored = await this.ledger.get("worker_receipt", reference.id);
			if (stored === undefined || stored.kind !== "fact") return Result.err(new FoundationError("invalid_correlation", "AttemptReceipt references a WorkerReceipt that is not present in Session", { details: { attemptReceiptId: checked.value.attemptReceiptId, workerReceiptId: reference.id } }));
			const worker = validateWorkerReceipt(stored.payload);
			if (!worker.ok || (reference.revision > 0 && stored.revision !== reference.revision) || (reference.providerId !== undefined && worker.ok && worker.value.provenance.providerId !== reference.providerId) || (reference.fingerprint !== undefined && worker.ok && fingerprintFoundationValue(worker.value).value !== reference.fingerprint.value)) return Result.err(new FoundationError("invalid_correlation", "AttemptReceipt WorkerReceipt reference does not match the durable WorkerReceipt", { details: { attemptReceiptId: checked.value.attemptReceiptId, workerReceiptId: reference.id } }));
		}
		try {
			await this.persistFact("attempt_receipt", checked.value.attemptReceiptId, checked.value, { taskId: checked.value.taskId, dispatchId: checked.value.dispatchId, attemptId: checked.value.attemptId, bindingId: checked.value.bindingId, bindingEpochId: checked.value.bindingEpochIds[0], attemptReceiptId: checked.value.attemptReceiptId, agentInstanceId: checked.value.agentInstanceId }, { immutable: true });
			return Result.ok({ ...execution, receipt: cloneDeepFrozen(checked.value) });
		} catch (error) {
			return this.persistenceError(error, "worker_receipt_invalid_producer");
		}
	}

	async executeAgentSpawn(input: ChildSpawnExecutionInputV1): Promise<ResultValue<ChildSpawnResultV1, FoundationError>> {
		const checkedRequest = validateChildSpawnRequestV1(input.request);
		if (!checkedRequest.ok) return checkedRequest;
		try {
			await this.persistFact("task", checkedRequest.value.taskEnvelope.taskId, checkedRequest.value.taskEnvelope, { taskId: checkedRequest.value.taskEnvelope.taskId, spawnId: checkedRequest.value.spawnId }, { immutable: true });
			await this.requireDurableSpawnSources(checkedRequest.value.roleRevision, checkedRequest.value.modelProfile);
			const spawned = await executeAgentSpawnV1(input);
			if (!spawned.ok) return spawned;
			await this.requireExistingBindingFactsFromId(spawned.value.attempt.bindingId, spawned.value.attempt.taskId);
			const childDispatch: DispatchV1 = { schemaVersion: 1, dispatchId: spawned.value.attempt.dispatchId, taskId: spawned.value.attempt.taskId, bindingId: spawned.value.attempt.bindingId, taskExecutorProviderId: input.provider.providerId, status: "pending", createdAt: spawned.value.attempt.startedAt };
			const checkedDispatch = validateDispatch(childDispatch);
			if (!checkedDispatch.ok) return checkedDispatch;
			const contextId = `context_${spawned.value.attempt.taskId}`;
			const context = { schemaVersion: 1 as const, contextId, taskId: spawned.value.attempt.taskId, spawnId: checkedRequest.value.spawnId, forkScope: checkedRequest.value.forkScope, ...(checkedRequest.value.parentSpawn === undefined ? {} : { parentTaskId: checkedRequest.value.parentSpawn.parentTaskId }), createdAt: spawned.value.attempt.startedAt };
			await this.persistFact("context", contextId, context, { taskId: spawned.value.attempt.taskId, spawnId: checkedRequest.value.spawnId, contextId }, { immutable: true });
			await this.persistFact("dispatch", checkedDispatch.value.dispatchId, checkedDispatch.value, { taskId: checkedDispatch.value.taskId, dispatchId: checkedDispatch.value.dispatchId, bindingId: checkedDispatch.value.bindingId, spawnId: checkedRequest.value.spawnId }, { immutable: true });
			await this.persistFact("agent_instance", spawned.value.agentInstance.agentInstanceId, spawned.value.agentInstance, { taskId: spawned.value.agentInstance.taskId, agentInstanceId: spawned.value.agentInstance.agentInstanceId }, { immutable: true });
			await this.persistFact("binding_epoch", spawned.value.initialBindingEpoch.bindingEpochId, spawned.value.initialBindingEpoch, { taskId: spawned.value.initialBindingEpoch.taskId, attemptId: spawned.value.initialBindingEpoch.attemptId, bindingId: spawned.value.initialBindingEpoch.bindingId, bindingEpochId: spawned.value.initialBindingEpoch.bindingEpochId, agentInstanceId: spawned.value.initialBindingEpoch.agentInstanceId }, { immutable: true });
			await this.persistFact("attempt", spawned.value.attempt.attemptId, spawned.value.attempt, { taskId: spawned.value.attempt.taskId, dispatchId: spawned.value.attempt.dispatchId, attemptId: spawned.value.attempt.attemptId, bindingId: spawned.value.attempt.bindingId, bindingEpochId: spawned.value.attempt.bindingEpochIds[0], agentInstanceId: spawned.value.attempt.agentInstanceId }, { immutable: true });
			return spawned;
		} catch (error) {
			return this.persistenceError(error, "session_writer_stale_revision");
		}
	}

	async switchAgentMode(input: ModeSwitchExecutionInputV1): Promise<ResultValue<BindingEpochV1, FoundationError>> {
		const switched = switchAgentModeV1(input);
		if (!switched.ok) return switched;
		if (input.nextBinding === undefined) return Result.err(new FoundationError("binding_required_fact", "Mode switch requires the next immutable Binding"));
		try {
			await this.requireExistingEpoch(input.currentEpoch);
			await this.requireExistingBindingFactsFromId(input.currentEpoch.bindingId, input.currentEpoch.taskId);
			await this.requireExistingAgentInstance(input.currentEpoch);
			const attemptRecord = await this.ledger.get("attempt", input.currentEpoch.attemptId);
			if (attemptRecord === undefined || attemptRecord.kind !== "fact") throw new FoundationError("binding_required_fact", "Mode switch requires the current Attempt to be durable", { details: { attemptId: input.currentEpoch.attemptId } });
			const checkedAttempt = validateAttempt(attemptRecord.payload);
			if (!checkedAttempt.ok || checkedAttempt.value.taskId !== input.currentEpoch.taskId || checkedAttempt.value.bindingId !== input.currentEpoch.bindingId || !checkedAttempt.value.bindingEpochIds.includes(input.currentEpoch.bindingEpochId)) throw new FoundationError("binding_epoch_mismatch", "Mode switch current BindingEpoch is not part of the durable Attempt chain", { details: { attemptId: input.currentEpoch.attemptId, bindingEpochId: input.currentEpoch.bindingEpochId } });
			await this.requireExistingBindingFacts(input.nextBinding);
			await this.persistFact("agent_binding", input.nextBinding.bindingId, input.nextBinding, { taskId: input.nextBinding.taskId, bindingId: input.nextBinding.bindingId }, { immutable: true });
			await this.persistFact("binding_epoch", switched.value.bindingEpochId, switched.value, { taskId: switched.value.taskId, attemptId: switched.value.attemptId, bindingId: switched.value.bindingId, bindingEpochId: switched.value.bindingEpochId, agentInstanceId: switched.value.agentInstanceId }, { immutable: true });
			const nextAttempt: AttemptV1 = checkedAttempt.value.bindingEpochIds.includes(switched.value.bindingEpochId)
				? checkedAttempt.value
				: { ...checkedAttempt.value, bindingEpochIds: [...checkedAttempt.value.bindingEpochIds, switched.value.bindingEpochId] };
			await this.persistFact("attempt", nextAttempt.attemptId, nextAttempt, { taskId: nextAttempt.taskId, dispatchId: nextAttempt.dispatchId, attemptId: nextAttempt.attemptId, bindingId: nextAttempt.bindingId, bindingEpochId: switched.value.bindingEpochId, agentInstanceId: nextAttempt.agentInstanceId }, { expectedRevision: attemptRecord.revision });
			await this.persistFact("binding.activated", switched.value.bindingEpochId, switched.value, { taskId: switched.value.taskId, attemptId: switched.value.attemptId, bindingId: switched.value.bindingId, bindingEpochId: switched.value.bindingEpochId, agentInstanceId: switched.value.agentInstanceId }, { immutable: true });
			return switched;
		} catch (error) {
			return this.persistenceError(error, "session_writer_stale_revision");
		}
	}

	async settle(input: LayeredTaskSettlementInput): Promise<ResultValue<TaskResultV1, FoundationError>> {
		if (input.sourceAttemptReceiptIds.length === 0 || new Set(input.sourceAttemptReceiptIds).size !== input.sourceAttemptReceiptIds.length) return Result.err(new FoundationError("task_result_no_source_receipts", "Task settlement requires unique provider AttemptReceipt sources", { details: { taskResultId: input.taskResultId } }));
		try {
			const durableTask = await this.requireExistingTask(input.task.taskId);
			if (canonicalFoundationJson(durableTask) !== canonicalFoundationJson(input.task)) return Result.err(new FoundationError("role_resolver_task_required", "Task settlement must consume the durable TaskEnvelope", { details: { taskId: input.task.taskId } }));
			const receipts: AttemptReceiptV1[] = [];
			for (const id of input.sourceAttemptReceiptIds) {
				const stored = await this.ledger.get("attempt_receipt", id);
				if (stored === undefined || stored.kind !== "fact") return Result.err(new FoundationError("task_result_no_source_receipts", "Task settlement source was not produced by a provider consumer", { details: { taskResultId: input.taskResultId, attemptReceiptId: id } }));
				const checked = validateAttemptReceipt(stored.payload);
				if (!checked.ok) return checked;
				await this.requireWorkerReceiptRefs(checked.value);
				receipts.push(checked.value);
			}
			const settled = settleTaskResult({ taskResultId: input.taskResultId, task: input.task, receipts, summary: input.summary, ...(input.artifacts === undefined ? {} : { artifacts: input.artifacts }), ...(input.diff === undefined ? {} : { diff: input.diff }), tests: input.tests, evidence: input.evidence, producer: input.producer, ...(input.validation === undefined ? {} : { validation: input.validation }) });
			if (!settled.ok) return settled;
			const stored = await this.persistFact("task_result", settled.value.taskResultId, settled.value, { taskId: settled.value.taskId, taskResultId: settled.value.taskResultId, attemptId: settled.value.sourceAttemptReceiptIds[0] }, { immutable: true });
			return Result.ok(cloneDeepFrozen(stored.payload));
		} catch (error) {
			return this.persistenceError(error, "task_result_validation_failed");
		}
	}

	async finalize(input: LayeredRunFinalizationInput): Promise<ResultValue<RunReceiptV1, FoundationError>> {
		const result = this.finalizationTail.then(() => this.finalizeInternal(input));
		this.finalizationTail = result.then(() => undefined, () => undefined);
		return result;
	}

	private async finalizeInternal(input: LayeredRunFinalizationInput): Promise<ResultValue<RunReceiptV1, FoundationError>> {
		try {
			let sourceTaskId: string | undefined;
			for (const id of input.attemptReceiptIds) {
				const stored = await this.ledger.get("attempt_receipt", id);
				if (stored === undefined || stored.kind !== "fact") return Result.err(new FoundationError("task_result_no_source_receipts", "Run finalization references an AttemptReceipt not accepted by a provider consumer", { details: { runId: input.runId, attemptReceiptId: id } }));
				const checkedAttempt = validateAttemptReceipt(stored.payload);
				if (!checkedAttempt.ok) return Result.err(checkedAttempt.error);
				sourceTaskId ??= checkedAttempt.value.taskId;
			}
			const taskResultRecord = input.taskResultId === undefined ? undefined : await this.ledger.get("task_result", input.taskResultId);
			if (input.taskResultId !== undefined && (taskResultRecord === undefined || taskResultRecord.kind !== "fact")) return Result.err(new FoundationError("task_result_terminal_requires_task_result", "Run finalization references a TaskResult that has not crossed the Host settlement gate", { details: { runId: input.runId, taskResultId: input.taskResultId } }));
			const taskResult = taskResultRecord?.kind === "fact" ? taskResultRecord.payload as unknown as TaskResultV1 : undefined;
			const finalized = finalizeRunReceipt({ runReceiptId: input.runReceiptId, runId: input.runId, terminalStatus: input.terminalStatus, authority: input.authority, attemptReceiptIds: input.attemptReceiptIds, ...(taskResult === undefined ? {} : { taskResult }), ...(input.terminalErrorCode === undefined ? {} : { terminalErrorCode: input.terminalErrorCode }), ...(input.completedAt === undefined ? {} : { completedAt: input.completedAt }) });
			if (!finalized.ok) return finalized;
			const checked = validateRunReceiptV1(finalized.value);
			if (!checked.ok) return checked;
			const existingByRun = await this.findRunTerminal(input.runId);
			const existingByReceipt = await this.findRunReceiptById(input.runReceiptId);
			if (existingByRun !== undefined && canonicalFoundationJson(existingByRun) !== canonicalFoundationJson(checked.value)) return Result.err(new FoundationError("run_terminal_authority_invalid", "Conflicting terminal replay for a runId is rejected", { details: { runId: input.runId } }));
			if (existingByReceipt !== undefined && canonicalFoundationJson(existingByReceipt) !== canonicalFoundationJson(checked.value)) return Result.err(new FoundationError("run_terminal_authority_invalid", "A runReceiptId is already bound to a different terminal run identity", { details: { runReceiptId: input.runReceiptId } }));
			if (existingByRun !== undefined) return Result.ok(cloneDeepFrozen(existingByRun));
			if (existingByReceipt !== undefined) return Result.ok(cloneDeepFrozen(existingByReceipt));
			const stored = await this.persistFact("run_receipt", checked.value.runId, checked.value, { taskId: taskResult?.taskId ?? sourceTaskId, runId: checked.value.runId, runReceiptId: checked.value.runReceiptId, taskResultId: checked.value.taskResultId, attemptId: checked.value.attemptReceiptIds[0] }, { immutable: true });
			return Result.ok(cloneDeepFrozen(stored.payload));
		} catch (error) {
			return this.persistenceError(error, "run_terminal_authority_invalid");
		}
	}

	async getAttemptReceipt(attemptReceiptId: string): Promise<AttemptReceiptV1 | undefined> { return this.getEntity<AttemptReceiptV1>("attempt_receipt", attemptReceiptId); }
	async getTaskResult(taskResultId: string): Promise<TaskResultV1 | undefined> { return this.getEntity<TaskResultV1>("task_result", taskResultId); }
	async getRunReceipt(runReceiptId: string): Promise<RunReceiptV1 | undefined> { return this.getEntity<RunReceiptV1>("run_receipt", runReceiptId); }

	async release(): Promise<void> { await this.ledger.release(); }

	private async getEntity<T>(objectType: string, objectId: string): Promise<T | undefined> {
		if (objectType === "run_receipt") {
			const records = await this.ledger.find({ kind: "fact", objectType, order: "oldestFirst" });
			for (const record of records) {
				if (record.kind !== "fact") continue;
				const checked = validateRunReceiptV1(record.payload);
				if (checked.ok && checked.value.runReceiptId === objectId) return cloneDeepFrozen(checked.value as T);
			}
			return undefined;
		}
		const stored = await this.ledger.get(objectType, objectId);
		return stored?.kind === "fact" ? cloneDeepFrozen(stored.payload as T) : undefined;
	}

	private async persistFact<T>(objectType: string, objectId: string, payload: T, correlation: Record<string, string | undefined>, options: { readonly immutable?: boolean; readonly expectedRevision?: number } = {}): Promise<{ readonly payload: T }> {
		if (options.immutable === true) {
			const existing = await this.ledger.get(objectType, objectId);
			if (existing?.kind === "fact") {
				if (canonicalFoundationJson(existing.payload) !== canonicalFoundationJson(payload)) throw new FoundationError("session_ledger_conflict", "An immutable Foundation fact already exists with different content", { details: { objectType, objectId } });
				return { payload: existing.payload as T };
			}
			if (existing !== undefined) throw new FoundationError("session_ledger_tombstoned", "An immutable Foundation fact cannot replace a terminal object", { details: { objectType, objectId } });
		}
		if (options.expectedRevision !== undefined) {
			const existing = await this.ledger.get(objectType, objectId);
			if (existing?.kind === "fact" && canonicalFoundationJson(existing.payload) === canonicalFoundationJson(payload)) return { payload: existing.payload as T };
		}
		const compact = Object.fromEntries(Object.entries(correlation).filter(([, value]) => value !== undefined)) as Record<string, string>;
		const result = await this.ledger.appendFact(objectType, objectId, payload, { clientRequestId: `${objectType}:${objectId}`, ...(options.immutable === true ? { expectedRevision: 0 } : options.expectedRevision === undefined ? {} : { expectedRevision: options.expectedRevision }), correlation: compact });
		return { payload: result.payload };
	}

	private async requireExistingTask(taskId: string): Promise<TaskEnvelopeV1> {
		const stored = await this.ledger.get("task", taskId);
		if (stored === undefined || stored.kind !== "fact") throw new FoundationError("role_resolver_task_required", "Execution requires a TaskEnvelope that is durable in Session", { details: { taskId } });
		const checked = validateTaskEnvelope(stored.payload);
		if (!checked.ok || checked.value.taskId !== taskId) throw new FoundationError("role_resolver_task_required", "Durable TaskEnvelope identity is invalid", { details: { taskId } });
		return checked.value;
	}

	private async requireExistingBindingFacts(binding: AgentBindingV1, taskId?: string): Promise<void> {
		const task = taskId === undefined ? undefined : await this.requireExistingTask(taskId);
		await requireDurableBindingSources(this.ledger, binding, task);
		const refs: readonly [string, string, string][] = [
			["external_agent_binding", binding.contextRevision.id, binding.contextRevision.fingerprint?.value ?? ""],
			["capability_binding", binding.capabilityRevision.id, binding.capabilityRevision.fingerprint?.value ?? ""],
			["model_broker_binding", binding.modelBrokerBindingRevision.id, binding.modelBrokerBindingRevision.fingerprint?.value ?? ""],
			["policy_binding", binding.policyRevision.id, binding.policyRevision.fingerprint?.value ?? ""],
		];
		const revisions = [binding.contextRevision, binding.capabilityRevision, binding.modelBrokerBindingRevision, binding.policyRevision];
		for (const [index, [objectType, objectId, fingerprint]] of refs.entries()) {
			const fact = await this.ledger.get(objectType, objectId);
			const reference = revisions[index];
			if (fact === undefined || fact.kind !== "fact" || fact.revision <= 0 || reference === undefined || fact.payload === undefined || fact.payload === null || typeof fact.payload !== "object" || !("revision" in fact.payload) || fact.payload.revision !== reference.revision || fingerprint.length === 0 || fingerprintFoundationValue(fact.payload).value !== fingerprint) throw new FoundationError("binding_required_fact", "AgentBinding references a missing or different immutable binding fact", { details: { objectType, objectId, revision: reference?.revision } });
		}
	}

	private async requireDurableSpawnSources(roleRevision: RoleRevisionV1, modelProfile: ModelProfileV1): Promise<void> {
		const roleReference = { schemaVersion: 1 as const, type: "role_revision", id: roleRevision.roleRevisionId, revision: roleRevision.revision, fingerprint: roleRevision.fingerprint };
		const profileReference = { schemaVersion: 1 as const, type: "model_profile_revision", id: modelProfile.modelProfileId, revision: modelProfile.revision, fingerprint: modelProfile.fingerprint };
		await findDurableRoleRevision(this.ledger, roleReference);
		await findDurableModelProfile(this.ledger, profileReference);
	}

	private async requireExistingBindingFactsFromId(bindingId: string, taskId: string): Promise<void> {
		const binding = await this.ledger.get("agent_binding", bindingId);
		if (binding === undefined || binding.kind !== "fact") throw new FoundationError("binding_required_fact", "Agent execution references a binding that is not durable", { details: { bindingId, taskId } });
		const checked = validateImmutableAgentBinding(binding.payload);
		if (!checked.ok || checked.value.taskId !== taskId) throw new FoundationError("binding_required_fact", "Agent execution references a binding with a different task", { details: { bindingId, taskId } });
		await this.requireExistingBindingFacts(checked.value);
	}

	private async requireExistingAgentInstance(epoch: BindingEpochV1): Promise<void> {
		if (epoch.agentInstanceId === undefined) throw new FoundationError("agent_instance_required_for_agent_provider", "Agent mode switch requires a durable AgentInstance", { details: { bindingEpochId: epoch.bindingEpochId } });
		const stored = await this.ledger.get("agent_instance", epoch.agentInstanceId);
		if (stored === undefined || stored.kind !== "fact") throw new FoundationError("agent_instance_required_for_agent_provider", "Agent mode switch requires a durable AgentInstance", { details: { bindingEpochId: epoch.bindingEpochId, agentInstanceId: epoch.agentInstanceId } });
		const checked = validateAgentInstanceV1(stored.payload);
		if (!checked.ok || checked.value.taskId !== epoch.taskId || checked.value.agentInstanceId !== epoch.agentInstanceId) throw new FoundationError("invalid_correlation", "Durable AgentInstance does not match the current BindingEpoch", { details: { bindingEpochId: epoch.bindingEpochId, agentInstanceId: epoch.agentInstanceId } });
	}

	private async requireExistingEpoch(epoch: BindingEpochV1): Promise<void> {
		const stored = await this.ledger.get("binding_epoch", epoch.bindingEpochId);
		if (stored === undefined || stored.kind !== "fact" || canonicalFoundationJson(stored.payload) !== canonicalFoundationJson(epoch)) throw new FoundationError("binding_required_fact", "Mode switch requires the current immutable BindingEpoch to be durable", { details: { bindingEpochId: epoch.bindingEpochId } });
	}

	private async findDurableDispatchExecution(dispatch: DispatchExecutionInputV1["dispatch"], binding: AgentBindingV1, epoch: BindingEpochV1, provider: DispatchExecutionInputV1["provider"]): Promise<DispatchExecutionResultV1 | undefined> {
		const records = await this.ledger.find({ kind: "fact", objectType: "attempt_receipt", order: "oldestFirst" });
		for (const record of records) {
			if (record.kind !== "fact") continue;
			const genericReceipt = validateAttemptReceipt(record.payload);
			if (!genericReceipt.ok) continue;
			if (genericReceipt.value.attemptId !== epoch.attemptId) continue;
			if (genericReceipt.value.taskId !== dispatch.taskId || genericReceipt.value.dispatchId !== dispatch.dispatchId || genericReceipt.value.bindingId !== binding.bindingId || genericReceipt.value.bindingEpochIds[0] !== epoch.bindingEpochId) throw new FoundationError("invalid_correlation", "Durable AttemptReceipt does not match the replayed Dispatch", { details: { attemptReceiptId: genericReceipt.value.attemptReceiptId, dispatchId: dispatch.dispatchId } });
			const checkedReceipt = validateAttemptReceiptForProviderV1(genericReceipt.value, { providerId: provider.providerId, providerClass: provider.providerClass });
			if (!checkedReceipt.ok) {
				if (genericReceipt.value.providerId !== provider.providerId) throw new FoundationError("session_ledger_conflict", "Existing AttemptReceipt conflicts with its deterministic reconstruction", { details: { attemptReceiptId: genericReceipt.value.attemptReceiptId, expectedProviderId: provider.providerId, actualProviderId: genericReceipt.value.providerId } });
				throw checkedReceipt.error;
			}
			const attemptRecord = await this.ledger.get("attempt", epoch.attemptId);
			if (attemptRecord === undefined || attemptRecord.kind !== "fact") throw new FoundationError("invalid_correlation", "Durable AttemptReceipt is missing its Attempt fact", { details: { attemptReceiptId: checkedReceipt.value.attemptReceiptId, attemptId: epoch.attemptId } });
			const checkedAttempt = validateAttempt(attemptRecord.payload);
			if (!checkedAttempt.ok) throw checkedAttempt.error;
			if (checkedAttempt.value.taskId !== dispatch.taskId || checkedAttempt.value.dispatchId !== dispatch.dispatchId || checkedAttempt.value.bindingId !== binding.bindingId || checkedAttempt.value.providerId !== provider.providerId || !checkedAttempt.value.bindingEpochIds.includes(epoch.bindingEpochId) || checkedAttempt.value.agentInstanceId !== epoch.agentInstanceId) throw new FoundationError("invalid_correlation", "Durable Attempt does not match the replayed Dispatch", { details: { attemptId: checkedAttempt.value.attemptId, dispatchId: dispatch.dispatchId } });
			await this.requireWorkerReceiptRefs(checkedReceipt.value);
			return { attempt: cloneDeepFrozen(checkedAttempt.value), receipt: cloneDeepFrozen(checkedReceipt.value), providerId: provider.providerId, providerClass: provider.providerClass };
		}
		return undefined;
	}

	private async requireWorkerReceiptRefs(receipt: AttemptReceiptV1): Promise<void> {
		for (const reference of receipt.workerReceiptRefs) {
			const worker = await this.ledger.get("worker_receipt", reference.id);
			if (worker === undefined || worker.kind !== "fact" || worker.revision !== reference.revision || reference.fingerprint !== undefined && fingerprintFoundationValue(worker.payload).value !== reference.fingerprint.value) throw new FoundationError("invalid_correlation", "AttemptReceipt references a missing or different WorkerReceipt", { details: { attemptReceiptId: receipt.attemptReceiptId, workerReceiptId: reference.id } });
		}
	}

	private async findRunTerminal(runId: string): Promise<RunReceiptV1 | undefined> {
		const stored = await this.ledger.get("run_receipt", runId);
		if (stored?.kind === "fact") {
			const checked = validateRunReceiptV1(stored.payload);
			if (checked.ok) return checked.value;
		}
		const records = await this.ledger.find({ kind: "fact", objectType: "run_receipt", order: "oldestFirst" });
		for (const record of records) {
			if (record.kind !== "fact") continue;
			const checked = validateRunReceiptV1(record.payload);
			if (checked.ok && checked.value.runId === runId) return checked.value;
		}
		return undefined;
	}

	private async findRunReceiptById(runReceiptId: string): Promise<RunReceiptV1 | undefined> {
		const records = await this.ledger.find({ kind: "fact", objectType: "run_receipt", order: "oldestFirst" });
		for (const record of records) {
			if (record.kind !== "fact") continue;
			const checked = validateRunReceiptV1(record.payload);
			if (checked.ok && checked.value.runReceiptId === runReceiptId) return checked.value;
		}
		return undefined;
	}

	private persistenceError<T>(error: unknown, fallback: string): ResultValue<T, FoundationError> {
		if (error instanceof DurableLedgerError) throw error;
		return Result.err(toFoundationError(error, fallback));
	}
}

export const LayeredResultSettlement = LayeredResultSettlementV1;
