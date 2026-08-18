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
import type { ChildSpawnResultV1 } from "./providers.ts";
import { validateAgentInstanceV1, validateBindingEpochV1, type AgentBindingV1, type AgentInstanceV1, type BindingEpochV1 } from "./role.ts";
import { validateAttempt, validateDispatch, type TaskEnvelopeV1 } from "./task.ts";
import { SessionLedgerV1 } from "./session-ledger.ts";

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
			await this.requireExistingBindingFacts(checkedBinding.value);
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
		const spawned = await executeAgentSpawnV1(input);
		if (!spawned.ok) return spawned;
		try {
			await this.requireExistingBindingFactsFromId(spawned.value.attempt.bindingId, spawned.value.attempt.taskId);
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
			await this.requireExistingBindingFacts(input.nextBinding);
			await this.persistFact("agent_binding", input.nextBinding.bindingId, input.nextBinding, { taskId: input.nextBinding.taskId, bindingId: input.nextBinding.bindingId }, { immutable: true });
			await this.persistFact("binding_epoch", switched.value.bindingEpochId, switched.value, { taskId: switched.value.taskId, attemptId: switched.value.attemptId, bindingId: switched.value.bindingId, bindingEpochId: switched.value.bindingEpochId, agentInstanceId: switched.value.agentInstanceId }, { immutable: true });
			await this.persistFact("binding.activated", switched.value.bindingEpochId, switched.value, { taskId: switched.value.taskId, attemptId: switched.value.attemptId, bindingId: switched.value.bindingId, bindingEpochId: switched.value.bindingEpochId, agentInstanceId: switched.value.agentInstanceId }, { immutable: true });
			return switched;
		} catch (error) {
			return this.persistenceError(error, "session_writer_stale_revision");
		}
	}

	async settle(input: LayeredTaskSettlementInput): Promise<ResultValue<TaskResultV1, FoundationError>> {
		if (input.sourceAttemptReceiptIds.length === 0 || new Set(input.sourceAttemptReceiptIds).size !== input.sourceAttemptReceiptIds.length) return Result.err(new FoundationError("task_result_no_source_receipts", "Task settlement requires unique provider AttemptReceipt sources", { details: { taskResultId: input.taskResultId } }));
		try {
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
			if (existingByRun !== undefined && canonicalFoundationJson(existingByRun) !== canonicalFoundationJson(checked.value)) return Result.err(new FoundationError("run_terminal_authority_invalid", "Conflicting terminal replay for a runId is rejected", { details: { runId: input.runId } }));
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

	private async persistFact<T>(objectType: string, objectId: string, payload: T, correlation: Record<string, string | undefined>, options: { readonly immutable?: boolean } = {}): Promise<{ readonly payload: T }> {
		if (options.immutable === true) {
			const existing = await this.ledger.get(objectType, objectId);
			if (existing?.kind === "fact") {
				if (canonicalFoundationJson(existing.payload) !== canonicalFoundationJson(payload)) throw new FoundationError("session_ledger_conflict", "An immutable Foundation fact already exists with different content", { details: { objectType, objectId } });
				return { payload: existing.payload as T };
			}
			if (existing !== undefined) throw new FoundationError("session_ledger_tombstoned", "An immutable Foundation fact cannot replace a terminal object", { details: { objectType, objectId } });
		}
		const compact = Object.fromEntries(Object.entries(correlation).filter(([, value]) => value !== undefined)) as Record<string, string>;
		const result = await this.ledger.appendFact(objectType, objectId, payload, { clientRequestId: `${objectType}:${objectId}`, ...(options.immutable === true ? { expectedRevision: 0 } : {}), correlation: compact });
		return { payload: result.payload };
	}

	private async requireExistingBindingFacts(binding: AgentBindingV1): Promise<void> {
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

	private persistenceError<T>(error: unknown, fallback: string): ResultValue<T, FoundationError> {
		if (error instanceof DurableLedgerError) throw error;
		return Result.err(toFoundationError(error, fallback));
	}
}

export const LayeredResultSettlement = LayeredResultSettlementV1;

/** Existing public RunReceipt remains an additive, validated projection of the Foundation receipt. */
export function projectRunReceiptV1(value: RunReceiptV1): ResultValue<RunReceiptV1, FoundationError> {
	const checked = validateRunReceiptV1(value);
	return checked.ok ? Result.ok(cloneDeepFrozen({ ...checked.value })) : checked;
}
