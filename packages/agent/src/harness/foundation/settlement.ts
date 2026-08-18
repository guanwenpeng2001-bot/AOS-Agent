import { Result, type Result as ResultValue } from "../result.ts";
import { FoundationError } from "./errors.ts";
import { canonicalFoundationJson } from "./identity.ts";
import { cloneDeepFrozen } from "./immutability.ts";
import { executeDispatchV1, executeOperationV1, type DispatchExecutionInputV1, type DispatchExecutionResultV1, type OperationExecutionInputV1 } from "./execution.ts";
import { validateAttemptReceiptForProviderV1 } from "./conformance.ts";
import {
	finalizeRunReceipt,
	settleTaskResult,
	validateRunReceiptV1,
	type AttemptReceiptV1,
	type FinalizeRunReceiptInput,
	type HostTerminalGateAuthorityV1,
	type RunReceiptV1,
	type SettleTaskResultInput,
	type TaskResultV1,
	type WorkerReceiptV1,
} from "./results.ts";
import type { TaskEnvelopeV1 } from "./task.ts";

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
 * Provider-driven receipt ledger. It owns the only path from provider execution to TaskResult
 * and then to the Host terminal RunReceipt gate; callers cannot supply an arbitrary receipt list.
 */
export class LayeredResultSettlementV1 {
	private readonly workerReceipts = new Map<string, WorkerReceiptV1>();
	private readonly attemptReceipts = new Map<string, AttemptReceiptV1>();
	private readonly taskResults = new Map<string, TaskResultV1>();
	private readonly runReceipts = new Map<string, RunReceiptV1>();

	async executeOperation(input: OperationExecutionInputV1): Promise<ResultValue<WorkerReceiptV1, FoundationError>> {
		const executed = await executeOperationV1(input);
		if (!executed.ok) return executed;
		const existing = this.workerReceipts.get(executed.value.workerReceiptId);
		if (existing !== undefined && canonicalFoundationJson(existing) !== canonicalFoundationJson(executed.value)) return Result.err(new FoundationError("worker_receipt_invalid_producer", "WorkerReceipt replay conflicts with the accepted provider receipt", { details: { workerReceiptId: executed.value.workerReceiptId } }));
		this.workerReceipts.set(executed.value.workerReceiptId, cloneDeepFrozen(executed.value));
		return Result.ok(cloneDeepFrozen(executed.value));
	}

	async executeDispatch(input: DispatchExecutionInputV1): Promise<ResultValue<DispatchExecutionResultV1, FoundationError>> {
		const executed = await executeDispatchV1(input);
		if (!executed.ok) return executed;
		const accepted = this.acceptExecution(executed.value);
		return accepted.ok ? Result.ok(executed.value) : accepted;
	}

	/** Accepts only the output of executeDispatchV1, not a manually assembled AttemptReceipt. */
	acceptExecution(execution: DispatchExecutionResultV1): ResultValue<AttemptReceiptV1, FoundationError> {
		const checked = validateAttemptReceiptForProviderV1(execution.receipt, { providerId: execution.providerId, providerClass: execution.providerClass });
		if (!checked.ok) return checked;
		if (checked.value.attemptId !== execution.attempt.attemptId || checked.value.dispatchId !== execution.attempt.dispatchId || checked.value.taskId !== execution.attempt.taskId || checked.value.bindingId !== execution.attempt.bindingId || checked.value.agentInstanceId !== execution.attempt.agentInstanceId) return Result.err(new FoundationError("invalid_correlation", "Accepted AttemptReceipt does not match the provider-created Attempt", { details: { attemptReceiptId: checked.value.attemptReceiptId } }));
		for (const reference of checked.value.workerReceiptRefs) {
			if (!this.workerReceipts.has(reference.id)) return Result.err(new FoundationError("invalid_correlation", "AttemptReceipt references a WorkerReceipt that was not consumed by this ledger", { details: { attemptReceiptId: checked.value.attemptReceiptId, workerReceiptId: reference.id } }));
		}
		const existing = this.attemptReceipts.get(checked.value.attemptReceiptId);
		if (existing !== undefined && canonicalFoundationJson(existing) !== canonicalFoundationJson(checked.value)) return Result.err(new FoundationError("worker_receipt_invalid_producer", "AttemptReceipt replay conflicts with the accepted provider receipt", { details: { attemptReceiptId: checked.value.attemptReceiptId } }));
		this.attemptReceipts.set(checked.value.attemptReceiptId, cloneDeepFrozen(checked.value));
		return Result.ok(cloneDeepFrozen(checked.value));
	}

	settle(input: LayeredTaskSettlementInput): ResultValue<TaskResultV1, FoundationError> {
		if (input.sourceAttemptReceiptIds.length === 0 || new Set(input.sourceAttemptReceiptIds).size !== input.sourceAttemptReceiptIds.length) return Result.err(new FoundationError("task_result_no_source_receipts", "Task settlement requires unique provider AttemptReceipt sources", { details: { taskResultId: input.taskResultId } }));
		const receipts: AttemptReceiptV1[] = [];
		for (const id of input.sourceAttemptReceiptIds) {
			const receipt = this.attemptReceipts.get(id);
			if (receipt === undefined) return Result.err(new FoundationError("task_result_no_source_receipts", "Task settlement source was not produced by a provider consumer", { details: { taskResultId: input.taskResultId, attemptReceiptId: id } }));
			receipts.push(receipt);
		}
		const settled = settleTaskResult({ taskResultId: input.taskResultId, task: input.task, receipts, summary: input.summary, ...(input.artifacts === undefined ? {} : { artifacts: input.artifacts }), ...(input.diff === undefined ? {} : { diff: input.diff }), tests: input.tests, evidence: input.evidence, producer: input.producer, ...(input.validation === undefined ? {} : { validation: input.validation }) });
		if (!settled.ok) return settled;
		const existing = this.taskResults.get(settled.value.taskResultId);
		if (existing !== undefined && canonicalFoundationJson(existing) !== canonicalFoundationJson(settled.value)) return Result.err(new FoundationError("task_result_validation_failed", "TaskResult replay conflicts with the accepted settlement", { details: { taskResultId: settled.value.taskResultId } }));
		const result = cloneDeepFrozen(settled.value);
		this.taskResults.set(result.taskResultId, result);
		return Result.ok(result);
	}

	finalize(input: LayeredRunFinalizationInput): ResultValue<RunReceiptV1, FoundationError> {
		for (const id of input.attemptReceiptIds) if (!this.attemptReceipts.has(id)) return Result.err(new FoundationError("task_result_no_source_receipts", "Run finalization references an AttemptReceipt not accepted by a provider consumer", { details: { runId: input.runId, attemptReceiptId: id } }));
		const taskResult = input.taskResultId === undefined ? undefined : this.taskResults.get(input.taskResultId);
		if (input.taskResultId !== undefined && taskResult === undefined) return Result.err(new FoundationError("task_result_terminal_requires_task_result", "Run finalization references a TaskResult that has not crossed the Host settlement gate", { details: { runId: input.runId, taskResultId: input.taskResultId } }));
		const finalized = finalizeRunReceipt({ runReceiptId: input.runReceiptId, runId: input.runId, terminalStatus: input.terminalStatus, authority: input.authority, attemptReceiptIds: input.attemptReceiptIds, ...(taskResult === undefined ? {} : { taskResult }), ...(input.terminalErrorCode === undefined ? {} : { terminalErrorCode: input.terminalErrorCode }), ...(input.completedAt === undefined ? {} : { completedAt: input.completedAt }) });
		if (!finalized.ok) return finalized;
		const checked = validateRunReceiptV1(finalized.value);
		if (!checked.ok) return checked;
		const existing = this.runReceipts.get(checked.value.runReceiptId);
		if (existing !== undefined && canonicalFoundationJson(existing) !== canonicalFoundationJson(checked.value)) return Result.err(new FoundationError("run_terminal_authority_invalid", "RunReceipt replay conflicts with the Host terminal gate result", { details: { runReceiptId: checked.value.runReceiptId } }));
		const result = cloneDeepFrozen(checked.value);
		this.runReceipts.set(result.runReceiptId, result);
		return Result.ok(result);
	}

	getAttemptReceipt(attemptReceiptId: string): AttemptReceiptV1 | undefined { const receipt = this.attemptReceipts.get(attemptReceiptId); return receipt === undefined ? undefined : cloneDeepFrozen(receipt); }
	getTaskResult(taskResultId: string): TaskResultV1 | undefined { const result = this.taskResults.get(taskResultId); return result === undefined ? undefined : cloneDeepFrozen(result); }
	getRunReceipt(runReceiptId: string): RunReceiptV1 | undefined { const receipt = this.runReceipts.get(runReceiptId); return receipt === undefined ? undefined : cloneDeepFrozen(receipt); }
}

export const LayeredResultSettlement = LayeredResultSettlementV1;

/** Existing public RunReceipt remains an additive, validated projection of the Foundation receipt. */
export function projectRunReceiptV1(value: RunReceiptV1): ResultValue<RunReceiptV1, FoundationError> {
	const checked = validateRunReceiptV1(value);
	return checked.ok ? Result.ok(cloneDeepFrozen({ ...checked.value })) : checked;
}
