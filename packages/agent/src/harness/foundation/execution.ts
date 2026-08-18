import { Result, type Result as ResultValue } from "../result.ts";
import { FoundationError } from "./errors.ts";
import { canonicalFoundationJson, type ExecutionCorrelationV1 } from "./identity.ts";
import { cloneDeepFrozen } from "./immutability.ts";
import { validateImmutableAgentBinding, createOrderedBindingEpoch } from "./binding.ts";
import type { AgentBindingV1, BindingEpochV1 } from "./role.ts";
import {
	validateChildSpawnRequestV1,
	validateChildSpawnResultV1,
	validateSandboxOperationRequestV1,
	type ChildAgentProvider,
	type ChildSpawnRequestV1,
	type ChildSpawnResultV1,
	type SandboxOperationProvider,
	type SandboxOperationRequestV1,
	type TaskExecutorAttemptContextV1,
	type TaskExecutorProvider,
} from "./providers.ts";
import { validateAttemptReceiptForProviderV1, validateWorkerReceiptForProviderV1 } from "./conformance.ts";
import type { AttemptReceiptV1, ResultProvenanceV1, WorkerReceiptV1 } from "./results.ts";
import { validateAgentInstanceV1, validateBindingEpochV1 } from "./role.ts";
import { validateAttempt, validateDispatch, type AttemptV1, type DispatchV1, type ModeSwitchIntentV1 } from "./task.ts";

export interface DispatchExecutionInputV1 {
	readonly dispatch: DispatchV1;
	readonly binding: AgentBindingV1;
	readonly initialBindingEpoch: BindingEpochV1;
	readonly provider: TaskExecutorProvider;
	readonly correlation?: ExecutionCorrelationV1;
	readonly signal?: AbortSignal;
}

/** The only receipt accepted by the layered settlement gate is a provider-consumed execution. */
export interface DispatchExecutionResultV1 {
	readonly attempt: AttemptV1;
	readonly receipt: AttemptReceiptV1;
	readonly providerId: string;
	readonly providerClass: "scheduler" | "task_executor" | "agent" | "external_connector";
}

export interface OperationExecutionInputV1 {
	readonly request: SandboxOperationRequestV1;
	readonly provider: SandboxOperationProvider;
	readonly correlation?: ExecutionCorrelationV1;
	readonly signal?: AbortSignal;
}

export interface ChildSpawnExecutionInputV1 {
	readonly request: ChildSpawnRequestV1;
	readonly provider: ChildAgentProvider;
	readonly correlation?: ExecutionCorrelationV1;
	readonly signal?: AbortSignal;
}

export interface ModeSwitchExecutionInputV1 {
	readonly intent: ModeSwitchIntentV1;
	readonly currentEpoch: BindingEpochV1;
	readonly nextBindingId: string;
	readonly now?: () => string;
}

function correlationMatches(actual: ResultProvenanceV1, expected: ExecutionCorrelationV1 | undefined, objectId: string): ResultValue<void, FoundationError> {
	if (expected === undefined) return Result.ok(undefined);
	const actualCorrelation = actual.correlation;
	if (actualCorrelation === undefined) return Result.err(new FoundationError("invalid_correlation", "Provider receipt is missing execution correlation", { details: { objectId } }));
	const keys = Object.keys(expected) as (keyof ExecutionCorrelationV1)[];
	for (const key of keys) {
		const expectedValue = expected[key];
		if (expectedValue === undefined) continue;
		const actualValue = actualCorrelation[key];
		if (actualValue === undefined || canonicalFoundationJson(actualValue) !== canonicalFoundationJson(expectedValue)) return Result.err(new FoundationError("invalid_correlation", "Provider receipt correlation does not match its execution request", { details: { objectId, field: key } }));
	}
	return Result.ok(undefined);
}

function providerError(error: unknown, message: string): ResultValue<never, FoundationError> {
	return FoundationError.is(error)
		? Result.err(error)
		: Result.err(new FoundationError("task_executor_invalid_provider_class", message, { cause: error }));
}

function validateInitialEpoch(input: DispatchExecutionInputV1): ResultValue<void, FoundationError> {
	const checkedEpoch = validateBindingEpochV1(input.initialBindingEpoch);
	if (!checkedEpoch.ok) return checkedEpoch;
	const epoch = checkedEpoch.value;
	if (epoch.ordinal !== 0 || epoch.activationReason !== "attempt_started" || epoch.previousBindingEpochId !== undefined) return Result.err(new FoundationError("binding_epoch_invalid_ordinal", "Dispatch consumer requires an initial attempt BindingEpoch", { details: { bindingEpochId: epoch.bindingEpochId } }));
	if (epoch.taskId !== input.dispatch.taskId || epoch.bindingId !== input.dispatch.bindingId) return Result.err(new FoundationError("binding_epoch_mismatch", "Initial BindingEpoch does not match the Dispatch", { details: { bindingEpochId: epoch.bindingEpochId, dispatchId: input.dispatch.dispatchId } }));
	if (input.provider.providerClass === "agent" && epoch.agentInstanceId === undefined) return Result.err(new FoundationError("agent_instance_required_for_agent_provider", "Agent provider dispatch requires an AgentInstance-bound epoch", { details: { providerId: input.provider.providerId } }));
	if (input.provider.providerClass !== "agent" && epoch.agentInstanceId !== undefined) return Result.err(new FoundationError("agent_instance_forbidden_for_provider", "Non-agent provider dispatch cannot carry an AgentInstance", { details: { providerId: input.provider.providerId } }));
	return Result.ok(undefined);
}

function validateAttemptCorrelation(attempt: AttemptV1, input: DispatchExecutionInputV1): ResultValue<void, FoundationError> {
	if (attempt.attemptId !== input.initialBindingEpoch.attemptId || attempt.dispatchId !== input.dispatch.dispatchId || attempt.taskId !== input.dispatch.taskId || attempt.providerId !== input.provider.providerId || attempt.bindingId !== input.dispatch.bindingId) return Result.err(new FoundationError("invalid_correlation", "Provider-created Attempt does not match its Dispatch, Binding, or epoch", { details: { attemptId: attempt.attemptId, dispatchId: input.dispatch.dispatchId } }));
	if (!attempt.bindingEpochIds.includes(input.initialBindingEpoch.bindingEpochId)) return Result.err(new FoundationError("invalid_correlation", "Provider-created Attempt omitted its initial BindingEpoch", { details: { attemptId: attempt.attemptId, bindingEpochId: input.initialBindingEpoch.bindingEpochId } }));
	if (input.provider.providerClass === "agent" && attempt.agentInstanceId !== input.initialBindingEpoch.agentInstanceId) return Result.err(new FoundationError("invalid_correlation", "Agent Attempt must retain the epoch AgentInstance", { details: { attemptId: attempt.attemptId } }));
	if (input.provider.providerClass !== "agent" && attempt.agentInstanceId !== undefined) return Result.err(new FoundationError("agent_instance_forbidden_for_provider", "Non-agent Attempt cannot carry an AgentInstance", { details: { attemptId: attempt.attemptId } }));
	if (attempt.status === "succeeded" || attempt.status === "failed" || attempt.status === "cancelled") return Result.err(new FoundationError("task_executor_invalid_provider_class", "Provider must return a non-terminal Attempt before runAttempt", { details: { attemptId: attempt.attemptId } }));
	return Result.ok(undefined);
}

function validateReceiptCorrelation(receipt: AttemptReceiptV1, attempt: AttemptV1, input: DispatchExecutionInputV1): ResultValue<void, FoundationError> {
	if (receipt.taskId !== attempt.taskId || receipt.dispatchId !== attempt.dispatchId || receipt.attemptId !== attempt.attemptId || receipt.providerId !== attempt.providerId || receipt.bindingId !== attempt.bindingId) return Result.err(new FoundationError("invalid_correlation", "Provider AttemptReceipt does not match its Attempt", { details: { attemptReceiptId: receipt.attemptReceiptId, attemptId: attempt.attemptId } }));
	if (receipt.bindingEpochIds.length === 0 || attempt.bindingEpochIds.some((id) => !receipt.bindingEpochIds.includes(id))) return Result.err(new FoundationError("invalid_correlation", "AttemptReceipt does not retain the Attempt BindingEpoch chain", { details: { attemptReceiptId: receipt.attemptReceiptId } }));
	if (receipt.agentInstanceId !== attempt.agentInstanceId) return Result.err(new FoundationError("invalid_correlation", "AttemptReceipt AgentInstance does not match its Attempt", { details: { attemptReceiptId: receipt.attemptReceiptId } }));
	return correlationMatches(receipt.provenance, input.correlation, receipt.attemptReceiptId);
}

/** Runs Dispatch -> selected provider -> provider-created Attempt -> AttemptReceipt. */
export async function executeDispatchV1(input: DispatchExecutionInputV1): Promise<ResultValue<DispatchExecutionResultV1, FoundationError>> {
	const checkedDispatch = validateDispatch(input.dispatch);
	if (!checkedDispatch.ok) return checkedDispatch;
	const checkedBinding = validateImmutableAgentBinding(input.binding);
	if (!checkedBinding.ok) return checkedBinding;
	if (checkedDispatch.value.taskExecutorProviderId !== input.provider.providerId) return Result.err(new FoundationError("task_executor_invalid_provider_class", "Dispatch selected a different provider identity", { details: { dispatchId: input.dispatch.dispatchId } }));
	if (checkedBinding.value.taskId !== input.dispatch.taskId || checkedBinding.value.bindingId !== input.dispatch.bindingId) return Result.err(new FoundationError("invalid_correlation", "Dispatch Binding does not match its Task identity", { details: { dispatchId: input.dispatch.dispatchId } }));
	const epoch = validateInitialEpoch(input);
	if (!epoch.ok) return epoch;
	const context: TaskExecutorAttemptContextV1 = { initialBindingEpoch: input.initialBindingEpoch, ...(input.signal === undefined ? {} : { signal: input.signal }) };
	try {
		const created = await input.provider.createAttempt(checkedDispatch.value, checkedBinding.value, context);
		if (!created.ok) return created;
		const checkedAttempt = validateAttempt(created.value);
		if (!checkedAttempt.ok) return checkedAttempt;
		const attemptCorrelation = validateAttemptCorrelation(checkedAttempt.value, input);
		if (!attemptCorrelation.ok) return attemptCorrelation;
		const settled = await input.provider.runAttempt(checkedAttempt.value, input.signal === undefined ? undefined : { signal: input.signal });
		if (!settled.ok) return settled;
		const checkedReceipt = validateAttemptReceiptForProviderV1(settled.value, { providerId: input.provider.providerId, providerClass: input.provider.providerClass });
		if (!checkedReceipt.ok) return checkedReceipt;
		const receiptCorrelation = validateReceiptCorrelation(checkedReceipt.value, checkedAttempt.value, input);
		if (!receiptCorrelation.ok) return receiptCorrelation;
		return Result.ok({ attempt: cloneDeepFrozen(checkedAttempt.value), receipt: cloneDeepFrozen(checkedReceipt.value), providerId: input.provider.providerId, providerClass: input.provider.providerClass });
	} catch (error) {
		return providerError(error, "TaskExecutor provider threw while consuming a Dispatch");
	}
}

function validateWorkerCorrelation(receipt: WorkerReceiptV1, request: SandboxOperationRequestV1, expected: ExecutionCorrelationV1 | undefined): ResultValue<void, FoundationError> {
	if (receipt.operationId !== request.operationId) return Result.err(new FoundationError("invalid_correlation", "WorkerReceipt operation does not match its request", { details: { workerReceiptId: receipt.workerReceiptId } }));
	for (const field of ["taskId", "dispatchId", "attemptId"] as const) {
		const expectedValue = request[field];
		if (expectedValue !== undefined && receipt[field] !== expectedValue) return Result.err(new FoundationError("invalid_correlation", "WorkerReceipt does not match its operation request", { details: { workerReceiptId: receipt.workerReceiptId, field } }));
	}
	return correlationMatches(receipt.provenance, expected, receipt.workerReceiptId);
}

/** Runs an operation worker through its public start surface and validates the WorkerReceipt. */
export async function executeOperationV1(input: OperationExecutionInputV1): Promise<ResultValue<WorkerReceiptV1, FoundationError>> {
	if (input.provider.providerClass !== "operation_worker") return Result.err(new FoundationError("worker_receipt_invalid_producer", "Operation execution requires an Operation Worker provider", { details: { providerId: input.provider.providerId } }));
	const checkedRequest = validateSandboxOperationRequestV1(input.request);
	if (!checkedRequest.ok) return checkedRequest;
	try {
		const started = await input.provider.start(checkedRequest.value, input.signal === undefined ? undefined : { signal: input.signal });
		if (!started.ok) return started;
		const checkedReceipt = validateWorkerReceiptForProviderV1(started.value, { providerId: input.provider.providerId, providerClass: input.provider.providerClass });
		if (!checkedReceipt.ok) return checkedReceipt;
		const correlation = validateWorkerCorrelation(checkedReceipt.value, checkedRequest.value, input.correlation);
		if (!correlation.ok) return correlation;
		return Result.ok(cloneDeepFrozen(checkedReceipt.value));
	} catch (error) {
		return providerError(error, "Operation Worker provider threw while consuming a request");
	}
}

/** Validates the Agent-only spawn result; an Operation Worker has no path to this function. */
export async function executeAgentSpawnV1(input: ChildSpawnExecutionInputV1): Promise<ResultValue<ChildSpawnResultV1, FoundationError>> {
	if (input.provider.providerClass !== "agent") return Result.err(new FoundationError("agent_instance_not_agent_provider", "Agent spawn requires an Agent provider", { details: { providerId: input.provider.providerId } }));
	const checkedRequest = validateChildSpawnRequestV1(input.request);
	if (!checkedRequest.ok) return checkedRequest;
	try {
		const spawned = await input.provider.spawn(checkedRequest.value, input.signal === undefined ? undefined : { signal: input.signal });
		if (!spawned.ok) return spawned;
		const checked = validateChildSpawnResultV1(spawned.value);
		if (!checked.ok) return checked;
		const { attempt, agentInstance, initialBindingEpoch } = checked.value;
		const checkedAttempt = validateAttempt(attempt);
		if (!checkedAttempt.ok) return checkedAttempt;
		const checkedAgent = validateAgentInstanceV1(agentInstance);
		if (!checkedAgent.ok) return checkedAgent;
		const checkedEpoch = validateBindingEpochV1(initialBindingEpoch);
		if (!checkedEpoch.ok) return checkedEpoch;
		if (checkedAttempt.value.providerId !== input.provider.providerId || checkedAttempt.value.taskId !== checkedRequest.value.taskEnvelope.taskId) return Result.err(new FoundationError("invalid_correlation", "Agent spawn Attempt does not match its provider or task", { details: { spawnId: checkedRequest.value.spawnId } }));
		if (checkedAgent.value.providerId !== input.provider.providerId || checkedAgent.value.taskId !== checkedAttempt.value.taskId || checkedAgent.value.agentInstanceId !== checkedAttempt.value.agentInstanceId) return Result.err(new FoundationError("invalid_correlation", "Agent spawn must bind one AgentInstance to its Attempt", { details: { spawnId: checkedRequest.value.spawnId } }));
		if (checkedEpoch.value.ordinal !== 0 || checkedEpoch.value.attemptId !== checkedAttempt.value.attemptId || checkedEpoch.value.taskId !== checkedAttempt.value.taskId || checkedEpoch.value.bindingId !== checkedAttempt.value.bindingId || checkedEpoch.value.agentInstanceId !== checkedAgent.value.agentInstanceId) return Result.err(new FoundationError("invalid_correlation", "Agent spawn epoch does not match its Attempt or AgentInstance", { details: { spawnId: checkedRequest.value.spawnId } }));
		if ((input.correlation?.taskId !== undefined && input.correlation.taskId !== checkedAttempt.value.taskId) || (input.correlation?.agentInstanceId !== undefined && input.correlation.agentInstanceId !== checkedAgent.value.agentInstanceId)) return Result.err(new FoundationError("invalid_correlation", "Agent spawn result does not match its requested correlation", { details: { spawnId: checkedRequest.value.spawnId } }));
		return Result.ok(cloneDeepFrozen({ schemaVersion: 1 as const, attempt: checkedAttempt.value, agentInstance: checkedAgent.value, initialBindingEpoch: checkedEpoch.value }));
	} catch (error) {
		return providerError(error, "Agent provider threw while consuming a spawn request");
	}
}

/** Switches an existing AgentInstance to a new immutable Binding at an ordered safe boundary. */
export function switchAgentModeV1(input: ModeSwitchExecutionInputV1): ResultValue<BindingEpochV1, FoundationError> {
	if (input.nextBindingId.length === 0) return Result.err(new FoundationError("invalid_identifier", "Mode switch requires a new Binding identity"));
	if (input.intent.taskId !== input.currentEpoch.taskId || input.intent.attemptId !== input.currentEpoch.attemptId || input.intent.bindingId !== input.currentEpoch.bindingId || input.intent.agentInstanceId !== input.currentEpoch.agentInstanceId) return Result.err(new FoundationError("binding_epoch_mismatch", "Mode switch must retain Task, Attempt, current Binding, and AgentInstance correlation", { details: { modeSwitchId: input.intent.modeSwitchId } }));
	if (input.intent.newBindingId !== undefined && input.intent.newBindingId !== input.nextBindingId) return Result.err(new FoundationError("binding_epoch_mismatch", "Mode switch intent does not identify the requested next Binding", { details: { modeSwitchId: input.intent.modeSwitchId } }));
	return createOrderedBindingEpoch({ bindingEpochId: `binding_epoch_${input.intent.modeSwitchId}`, taskId: input.currentEpoch.taskId, attemptId: input.currentEpoch.attemptId, bindingId: input.nextBindingId, agentInstanceId: input.currentEpoch.agentInstanceId, activationReason: "mode_switch", activatedByCommandId: input.intent.activatedByCommandId, previous: input.currentEpoch, now: input.now });
}
