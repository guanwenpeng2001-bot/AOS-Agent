import { Result, type ResultValue } from "../result.ts";
import { DurableLedgerError } from "../session/durable/errors.ts";
import { FoundationError } from "./errors.ts";
import { canonicalFoundationJson, type ExecutionCorrelation } from "./identity.ts";
import { cloneDeepFrozen } from "./immutability.ts";
import { validateImmutableAgentBinding, createOrderedBindingEpoch } from "./binding.ts";
import type { AgentBinding, BindingEpoch } from "./role.ts";
import {
	validateChildSpawnRequest,
	validateChildSpawnResult,
	validateSandboxOperationRequest,
	type ChildAgentProvider,
	type ChildSpawnRequest,
	type ChildSpawnResult,
	type SandboxOperationProvider,
	type SandboxOperationRequest,
	type TaskExecutorAttemptContext,
	type TaskExecutorProvider,
} from "./providers.ts";
import { validateAttemptReceiptForProvider, validateWorkerReceiptForProvider } from "./conformance.ts";
import type { AttemptReceipt, ResultProvenance, WorkerReceipt } from "./results.ts";
import { validateAgentInstance, validateBindingEpoch, type AgentInstance, type ModelProfile, type ModelRoute, type RoleRevision } from "./role.ts";
import { validateAttempt, validateDispatch, type Attempt, type Dispatch, type ModeSwitchIntent } from "./task.ts";

export interface DispatchExecutionInput {
	readonly dispatch: Dispatch;
	readonly binding: AgentBinding;
	readonly initialBindingEpoch: BindingEpoch;
	readonly provider: TaskExecutorProvider;
	readonly correlation: ExecutionCorrelation;
	/** Canonical durable source facts supplied by the settlement gate. */
	readonly roleRevision?: RoleRevision;
	readonly modelProfile?: ModelProfile;
	readonly modelRoute?: ModelRoute;
	readonly agentInstance?: AgentInstance;
	/** A previously persisted Attempt may be resumed after a crash. */
	readonly existingAttempt?: Attempt;
	/** Internal provider-consumer hook used to persist the Attempt before runAttempt. */
	readonly beforeRunAttempt?: (attempt: Attempt) => Promise<ResultValue<void, FoundationError>>;
	readonly signal?: AbortSignal;
}

/** The only receipt accepted by the layered settlement gate is a provider-consumed execution. */
export interface DispatchExecutionResult {
	readonly attempt: Attempt;
	readonly receipt: AttemptReceipt;
	readonly providerId: string;
	readonly providerClass: "scheduler" | "task_executor" | "agent" | "external_connector";
}

export interface DispatchAttemptStartResult {
	readonly attempt: Attempt;
	readonly providerId: string;
	readonly providerClass: "scheduler" | "task_executor" | "agent" | "external_connector";
}

export interface OperationExecutionInput {
	readonly request: SandboxOperationRequest;
	readonly provider: SandboxOperationProvider;
	readonly correlation: ExecutionCorrelation;
	readonly signal?: AbortSignal;
}

export interface ChildSpawnExecutionInput {
	readonly request: ChildSpawnRequest;
	readonly provider: ChildAgentProvider;
	readonly correlation: ExecutionCorrelation;
	readonly signal?: AbortSignal;
}

export interface ModeSwitchExecutionInput {
	readonly intent: ModeSwitchIntent;
	readonly currentEpoch: BindingEpoch;
	readonly correlation: ExecutionCorrelation;
	/** The immutable Binding must be supplied; an id alone is not a binding. */
	readonly nextBinding?: AgentBinding;
	readonly nextBindingId?: string;
	readonly safeBoundary?: "turn_end" | "checkpoint" | "provider_idle";
	readonly now?: () => string;
}

const CORRELATION_ID_FIELDS = ["sessionId", "laneId", "revision"] as const;
const EXECUTION_IDENTITY_FIELDS = ["taskId", "dispatchId", "attemptId", "bindingId", "bindingEpochId", "agentInstanceId"] as const;
type ExecutionIdentity = Partial<Pick<ExecutionCorrelation, (typeof EXECUTION_IDENTITY_FIELDS)[number]>>;

function validateCompleteCorrelation(correlation: ExecutionCorrelation | undefined, required: readonly (keyof ExecutionCorrelation)[], objectId: string): ResultValue<ExecutionCorrelation, FoundationError> {
	if (correlation === undefined || typeof correlation.sessionId !== "string" || correlation.sessionId.length === 0 || typeof correlation.laneId !== "string" || correlation.laneId.length === 0 || !Number.isSafeInteger(correlation.revision) || correlation.revision < 0) return Result.err(new FoundationError("invalid_correlation", "ExecutionCorrelation is required and incomplete", { details: { objectId } }));
	for (const key of required) {
		const value = correlation[key];
		const valid = key === "revision" ? Number.isSafeInteger(value) && (value as number) >= 0 : typeof value === "string" && value.length > 0;
		if (!valid) return Result.err(new FoundationError("invalid_correlation", "ExecutionCorrelation is missing a required identity field", { details: { objectId, field: key } }));
	}
	return Result.ok(correlation);
}

function correlationMatchesIdentity(correlation: ExecutionCorrelation, expected: ExecutionIdentity, objectId: string): ResultValue<void, FoundationError> {
	for (const field of EXECUTION_IDENTITY_FIELDS) {
		const expectedValue = expected[field];
		if (expectedValue !== undefined && correlation[field] !== expectedValue) return Result.err(new FoundationError("invalid_correlation", "ExecutionCorrelation does not match its execution identity", { details: { objectId, field } }));
	}
	return Result.ok(undefined);
}

function correlationMatches(actual: ResultProvenance, expected: ExecutionCorrelation, required: readonly (keyof ExecutionCorrelation)[], objectId: string): ResultValue<void, FoundationError> {
	const actualCorrelation = actual.correlation;
	const complete = validateCompleteCorrelation(actualCorrelation, required, objectId);
	if (!complete.ok) return Result.err(complete.error);
	const completeCorrelation = complete.value;
	for (const key of CORRELATION_ID_FIELDS) {
		const expectedValue = expected[key];
		if (expectedValue === undefined) continue;
		const actualValue = completeCorrelation[key];
		if (actualValue === undefined || canonicalFoundationJson(actualValue) !== canonicalFoundationJson(expectedValue)) return Result.err(new FoundationError("invalid_correlation", "Provider receipt correlation does not match its execution request", { details: { objectId, field: key } }));
	}
	for (const key of required) {
		const expectedValue = expected[key];
		if (expectedValue === undefined) continue;
		const actualValue = completeCorrelation[key];
		if (actualValue === undefined || canonicalFoundationJson(actualValue) !== canonicalFoundationJson(expectedValue)) return Result.err(new FoundationError("invalid_correlation", "Provider receipt correlation does not match its execution request", { details: { objectId, field: key } }));
	}
	return Result.ok(undefined);
}

function providerError(error: unknown, message: string): ResultValue<never, FoundationError> {
	if (error instanceof DurableLedgerError) throw error;
	return FoundationError.is(error)
		? Result.err(error)
		: Result.err(new FoundationError("task_executor_invalid_provider_class", message, { cause: error }));
}

function validateInitialEpoch(input: DispatchExecutionInput): ResultValue<void, FoundationError> {
	const epochResult = validateBindingEpoch(input.initialBindingEpoch);
	if (!epochResult.ok) return epochResult;
	const epoch = epochResult.value;
	if (epoch.ordinal !== 0 || epoch.activationReason !== "attempt_started" || epoch.previousBindingEpochId !== undefined) return Result.err(new FoundationError("binding_epoch_invalid_ordinal", "Dispatch consumer requires an initial attempt BindingEpoch", { details: { bindingEpochId: epoch.bindingEpochId } }));
	if (epoch.taskId !== input.dispatch.taskId || epoch.bindingId !== input.dispatch.bindingId) return Result.err(new FoundationError("binding_epoch_mismatch", "Initial BindingEpoch does not match the Dispatch", { details: { bindingEpochId: epoch.bindingEpochId, dispatchId: input.dispatch.dispatchId } }));
	if (input.provider.providerClass === "agent" && epoch.agentInstanceId === undefined) return Result.err(new FoundationError("agent_instance_required_for_agent_provider", "Agent provider dispatch requires an AgentInstance-bound epoch", { details: { providerId: input.provider.providerId } }));
	if (input.provider.providerClass !== "agent" && epoch.agentInstanceId !== undefined) return Result.err(new FoundationError("agent_instance_forbidden_for_provider", "Non-agent provider dispatch cannot carry an AgentInstance", { details: { providerId: input.provider.providerId } }));
	return Result.ok(undefined);
}

function validateAttemptCorrelation(attempt: Attempt, input: DispatchExecutionInput): ResultValue<void, FoundationError> {
	if (attempt.attemptId !== input.initialBindingEpoch.attemptId || attempt.dispatchId !== input.dispatch.dispatchId || attempt.taskId !== input.dispatch.taskId || attempt.providerId !== input.provider.providerId || attempt.bindingId !== input.dispatch.bindingId) return Result.err(new FoundationError("invalid_correlation", "Provider-created Attempt does not match its Dispatch, Binding, or epoch", { details: { attemptId: attempt.attemptId, dispatchId: input.dispatch.dispatchId } }));
	if (!attempt.bindingEpochIds.includes(input.initialBindingEpoch.bindingEpochId)) return Result.err(new FoundationError("invalid_correlation", "Provider-created Attempt omitted its initial BindingEpoch", { details: { attemptId: attempt.attemptId, bindingEpochId: input.initialBindingEpoch.bindingEpochId } }));
	if (input.provider.providerClass === "agent" && attempt.agentInstanceId !== input.initialBindingEpoch.agentInstanceId) return Result.err(new FoundationError("invalid_correlation", "Agent Attempt must retain the epoch AgentInstance", { details: { attemptId: attempt.attemptId } }));
	if (input.provider.providerClass !== "agent" && attempt.agentInstanceId !== undefined) return Result.err(new FoundationError("agent_instance_forbidden_for_provider", "Non-agent Attempt cannot carry an AgentInstance", { details: { attemptId: attempt.attemptId } }));
	if (attempt.status === "succeeded" || attempt.status === "failed" || attempt.status === "cancelled") return Result.err(new FoundationError("task_executor_invalid_provider_class", "Provider must return a non-terminal Attempt before runAttempt", { details: { attemptId: attempt.attemptId } }));
	return Result.ok(undefined);
}

function validateReceiptCorrelation(receipt: AttemptReceipt, attempt: Attempt, input: DispatchExecutionInput): ResultValue<void, FoundationError> {
	if (receipt.taskId !== attempt.taskId || receipt.dispatchId !== attempt.dispatchId || receipt.attemptId !== attempt.attemptId || receipt.providerId !== attempt.providerId || receipt.bindingId !== attempt.bindingId) return Result.err(new FoundationError("invalid_correlation", "Provider AttemptReceipt does not match its Attempt", { details: { attemptReceiptId: receipt.attemptReceiptId, attemptId: attempt.attemptId } }));
	if (receipt.bindingEpochIds.length === 0 || attempt.bindingEpochIds.some((id) => !receipt.bindingEpochIds.includes(id))) return Result.err(new FoundationError("invalid_correlation", "AttemptReceipt does not retain the Attempt BindingEpoch chain", { details: { attemptReceiptId: receipt.attemptReceiptId } }));
	if (receipt.agentInstanceId !== attempt.agentInstanceId) return Result.err(new FoundationError("invalid_correlation", "AttemptReceipt AgentInstance does not match its Attempt", { details: { attemptReceiptId: receipt.attemptReceiptId } }));
	return correlationMatches(receipt.provenance, input.correlation, ["sessionId", "laneId", "taskId", "dispatchId", "attemptId", "bindingId", "bindingEpochId"], receipt.attemptReceiptId);
}

function validateDispatchInput(input: DispatchExecutionInput): ResultValue<{ readonly dispatch: Dispatch; readonly binding: AgentBinding; readonly correlation: ExecutionCorrelation }, FoundationError> {
	const dispatchResult = validateDispatch(input.dispatch);
	if (!dispatchResult.ok) return dispatchResult;
	const bindingResult = validateImmutableAgentBinding(input.binding);
	if (!bindingResult.ok) return bindingResult;
	if (dispatchResult.value.taskExecutorProviderId !== input.provider.providerId) return Result.err(new FoundationError("task_executor_invalid_provider_class", "Dispatch selected a different provider identity", { details: { dispatchId: input.dispatch.dispatchId } }));
	if (bindingResult.value.taskId !== input.dispatch.taskId || bindingResult.value.bindingId !== input.dispatch.bindingId) return Result.err(new FoundationError("invalid_correlation", "Dispatch Binding does not match its Task identity", { details: { dispatchId: input.dispatch.dispatchId } }));
	const epoch = validateInitialEpoch(input);
	if (!epoch.ok) return epoch;
	const correlation = validateCompleteCorrelation(input.correlation, ["sessionId", "laneId", "taskId", "dispatchId", "attemptId", "bindingId", "bindingEpochId"], input.initialBindingEpoch.attemptId);
	if (!correlation.ok) return correlation;
	const correlationIdentity = correlationMatchesIdentity(correlation.value, { taskId: dispatchResult.value.taskId, dispatchId: dispatchResult.value.dispatchId, attemptId: input.initialBindingEpoch.attemptId, bindingId: bindingResult.value.bindingId, bindingEpochId: input.initialBindingEpoch.bindingEpochId }, input.initialBindingEpoch.attemptId);
	if (!correlationIdentity.ok) return correlationIdentity;
	return Result.ok({ dispatch: dispatchResult.value, binding: bindingResult.value, correlation: correlation.value });
}

/** Creates or validates the first Attempt without running provider side effects. */
export async function startDispatchAttempt(input: DispatchExecutionInput): Promise<ResultValue<DispatchAttemptStartResult, FoundationError>> {
	const checked = validateDispatchInput(input);
	if (!checked.ok) return checked;
	const context: TaskExecutorAttemptContext = {
		initialBindingEpoch: input.initialBindingEpoch,
		correlation: checked.value.correlation,
		...(input.signal === undefined ? {} : { signal: input.signal }),
		...(input.roleRevision === undefined ? {} : { roleRevision: input.roleRevision }),
		...(input.modelProfile === undefined ? {} : { modelProfile: input.modelProfile }),
		...(input.modelRoute === undefined ? {} : { modelRoute: input.modelRoute }),
		...(input.agentInstance === undefined ? {} : { agentInstance: input.agentInstance }),
	};
	try {
		const candidate = input.existingAttempt === undefined
			? await input.provider.createAttempt(checked.value.dispatch, checked.value.binding, context)
			: Result.ok(input.existingAttempt);
		if (!candidate.ok) return candidate;
		const attemptResult = validateAttempt(candidate.value);
		if (!attemptResult.ok) return attemptResult;
		const attemptCorrelation = validateAttemptCorrelation(attemptResult.value, input);
		if (!attemptCorrelation.ok) return attemptCorrelation;
		return Result.ok({ attempt: cloneDeepFrozen(attemptResult.value), providerId: input.provider.providerId, providerClass: input.provider.providerClass });
	} catch (error) {
		return providerError(error, "TaskExecutor provider threw while creating an Attempt");
	}
}

/** Runs Dispatch -> selected provider -> provider-created Attempt -> AttemptReceipt. */
export async function executeDispatch(input: DispatchExecutionInput): Promise<ResultValue<DispatchExecutionResult, FoundationError>> {
	try {
		const started = await startDispatchAttempt(input);
		if (!started.ok) return started;
		const attempt = started.value.attempt;
		if (input.beforeRunAttempt !== undefined) {
			const persisted = await input.beforeRunAttempt(attempt);
			if (!persisted.ok) return persisted;
		}
		const settled = await input.provider.runAttempt(attempt, { correlation: input.correlation, ...(input.signal === undefined ? {} : { signal: input.signal }) });
		if (!settled.ok) return settled;
		const receiptResult = validateAttemptReceiptForProvider(settled.value, { providerId: input.provider.providerId, providerClass: input.provider.providerClass });
		if (!receiptResult.ok) return receiptResult;
		const receiptCorrelation = validateReceiptCorrelation(receiptResult.value, attempt, input);
		if (!receiptCorrelation.ok) return receiptCorrelation;
		return Result.ok({ attempt: cloneDeepFrozen(attempt), receipt: cloneDeepFrozen(receiptResult.value), providerId: input.provider.providerId, providerClass: input.provider.providerClass });
	} catch (error) {
		return providerError(error, "TaskExecutor provider threw while consuming a Dispatch");
	}
}

function validateWorkerCorrelation(receipt: WorkerReceipt, request: SandboxOperationRequest, expected: ExecutionCorrelation | undefined): ResultValue<void, FoundationError> {
	if (receipt.operationId !== request.operationId) return Result.err(new FoundationError("invalid_correlation", "WorkerReceipt operation does not match its request", { details: { workerReceiptId: receipt.workerReceiptId } }));
	for (const field of ["taskId", "dispatchId", "attemptId"] as const) {
		const expectedValue = request[field];
		if (expectedValue !== undefined && receipt[field] !== expectedValue) return Result.err(new FoundationError("invalid_correlation", "WorkerReceipt does not match its operation request", { details: { workerReceiptId: receipt.workerReceiptId, field } }));
	}
	if (expected === undefined) return Result.err(new FoundationError("invalid_correlation", "Operation execution requires a complete ExecutionCorrelation", { details: { workerReceiptId: receipt.workerReceiptId } }));
	const requestIdentity: ExecutionIdentity = {};
	for (const field of ["taskId", "dispatchId", "attemptId"] as const) if (request[field] !== undefined) requestIdentity[field] = request[field];
	const correlationIdentity = correlationMatchesIdentity(expected, requestIdentity, receipt.workerReceiptId);
	if (!correlationIdentity.ok) return correlationIdentity;
	const required: (keyof ExecutionCorrelation)[] = ["sessionId", "laneId"];
	for (const field of ["taskId", "dispatchId", "attemptId"] as const) if (request[field] !== undefined) required.push(field);
	return correlationMatches(receipt.provenance, expected, required, receipt.workerReceiptId);
}

/** Runs an operation worker through its public start surface and validates the WorkerReceipt. */
export async function executeOperation(input: OperationExecutionInput): Promise<ResultValue<WorkerReceipt, FoundationError>> {
	if (input.provider.providerClass !== "operation_worker") return Result.err(new FoundationError("worker_receipt_invalid_producer", "Operation execution requires an Operation Worker provider", { details: { providerId: input.provider.providerId } }));
	const requestResult = validateSandboxOperationRequest(input.request);
	if (!requestResult.ok) return requestResult;
	try {
		const providerCorrelation = validateCompleteCorrelation(input.correlation, ["sessionId", "laneId"], requestResult.value.operationId);
		if (!providerCorrelation.ok) return providerCorrelation;
		const started = await input.provider.start(requestResult.value, { correlation: providerCorrelation.value, ...(input.signal === undefined ? {} : { signal: input.signal }) });
		if (!started.ok) return started;
		const receiptResult = validateWorkerReceiptForProvider(started.value, { providerId: input.provider.providerId, providerClass: input.provider.providerClass });
		if (!receiptResult.ok) return receiptResult;
		const receiptCorrelation = validateWorkerCorrelation(receiptResult.value, requestResult.value, input.correlation);
		if (!receiptCorrelation.ok) return Result.err(receiptCorrelation.error);
		return Result.ok(cloneDeepFrozen(receiptResult.value));
	} catch (error) {
		return providerError(error, "Operation Worker provider threw while consuming a request");
	}
}

/** Validates the Agent-only spawn result; an Operation Worker has no path to this function. */
export async function executeAgentSpawn(input: ChildSpawnExecutionInput): Promise<ResultValue<ChildSpawnResult, FoundationError>> {
	if (input.provider.providerClass !== "agent") return Result.err(new FoundationError("agent_instance_not_agent_provider", "Agent spawn requires an Agent provider", { details: { providerId: input.provider.providerId } }));
	const requestResult = validateChildSpawnRequest(input.request);
	if (!requestResult.ok) return requestResult;
	try {
		const correlation = validateCompleteCorrelation(input.correlation, ["sessionId", "laneId", "taskId", "agentInstanceId"], requestResult.value.spawnId);
		if (!correlation.ok) return correlation;
		const spawned = await input.provider.spawn(requestResult.value, { correlation: correlation.value, ...(input.signal === undefined ? {} : { signal: input.signal }) });
		if (!spawned.ok) return spawned;
		const checked = validateChildSpawnResult(spawned.value);
		if (!checked.ok) return checked;
		const { attempt, agentInstance, initialBindingEpoch } = checked.value;
		const attemptResult = validateAttempt(attempt);
		if (!attemptResult.ok) return attemptResult;
		const agentResult = validateAgentInstance(agentInstance);
		if (!agentResult.ok) return agentResult;
		const epochResult = validateBindingEpoch(initialBindingEpoch);
		if (!epochResult.ok) return epochResult;
		if (attemptResult.value.providerId !== input.provider.providerId || attemptResult.value.taskId !== requestResult.value.taskEnvelope.taskId) return Result.err(new FoundationError("invalid_correlation", "Agent spawn Attempt does not match its provider or task", { details: { spawnId: requestResult.value.spawnId } }));
		if (agentResult.value.providerId !== input.provider.providerId || agentResult.value.taskId !== attemptResult.value.taskId || agentResult.value.agentInstanceId !== attemptResult.value.agentInstanceId) return Result.err(new FoundationError("invalid_correlation", "Agent spawn must bind one AgentInstance to its Attempt", { details: { spawnId: requestResult.value.spawnId } }));
		if (agentResult.value.roleRevision.id !== requestResult.value.roleRevision.roleRevisionId || agentResult.value.roleRevision.revision !== requestResult.value.roleRevision.revision) return Result.err(new FoundationError("invalid_correlation", "Agent spawn AgentInstance must retain the requested durable RoleRevision", { details: { spawnId: requestResult.value.spawnId } }));
		if (epochResult.value.ordinal !== 0 || epochResult.value.attemptId !== attemptResult.value.attemptId || epochResult.value.taskId !== attemptResult.value.taskId || epochResult.value.bindingId !== attemptResult.value.bindingId || epochResult.value.agentInstanceId !== agentResult.value.agentInstanceId) return Result.err(new FoundationError("invalid_correlation", "Agent spawn epoch does not match its Attempt or AgentInstance", { details: { spawnId: requestResult.value.spawnId } }));
		if (!attemptResult.value.bindingEpochIds.includes(epochResult.value.bindingEpochId)) return Result.err(new FoundationError("invalid_correlation", "Agent spawn Attempt omitted its initial BindingEpoch", { details: { spawnId: requestResult.value.spawnId } }));
		if (requestResult.value.parentSpawn !== undefined && (requestResult.value.parentSpawn.parentTaskId === requestResult.value.taskEnvelope.taskId || requestResult.value.parentSpawn.newTaskEnvelopeRef.id !== requestResult.value.taskEnvelope.taskId)) return Result.err(new FoundationError("invalid_correlation", "Agent spawn parent intent does not identify a distinct requested child TaskEnvelope", { details: { spawnId: requestResult.value.spawnId } }));
		if (requestResult.value.parentAgentInstanceId !== undefined && agentResult.value.lineage.parentId !== requestResult.value.parentAgentInstanceId) return Result.err(new FoundationError("invalid_correlation", "Agent spawn child AgentInstance lineage does not identify its parent", { details: { spawnId: requestResult.value.spawnId } }));
		if (correlation.value.taskId !== attemptResult.value.taskId || correlation.value.agentInstanceId !== agentResult.value.agentInstanceId) return Result.err(new FoundationError("invalid_correlation", "Agent spawn result does not match its requested correlation", { details: { spawnId: requestResult.value.spawnId } }));
		return Result.ok(cloneDeepFrozen({ schemaVersion: 1 as const, attempt: attemptResult.value, agentInstance: agentResult.value, initialBindingEpoch: epochResult.value }));
	} catch (error) {
		return providerError(error, "Agent provider threw while consuming a spawn request");
	}
}

/** Switches an existing AgentInstance to a new immutable Binding at an ordered safe boundary. */
export function switchAgentMode(input: ModeSwitchExecutionInput): ResultValue<BindingEpoch, FoundationError> {
	const correlation = validateCompleteCorrelation(input.correlation, ["sessionId", "laneId", "taskId", "attemptId", "bindingId", "bindingEpochId", "agentInstanceId"], input.intent.modeSwitchId);
	if (!correlation.ok) return correlation;
	if (input.nextBinding === undefined) return Result.err(new FoundationError("binding_required_fact", "Mode switch requires the next immutable Binding, not only its id"));
	const bindingResult = validateImmutableAgentBinding(input.nextBinding);
	if (!bindingResult.ok) return bindingResult;
	const nextBindingId = input.nextBindingId ?? bindingResult.value.bindingId;
	if (nextBindingId.length === 0 || bindingResult.value.bindingId !== nextBindingId) return Result.err(new FoundationError("invalid_identifier", "Mode switch requires a new Binding identity"));
	if (nextBindingId === input.currentEpoch.bindingId) return Result.err(new FoundationError("binding_epoch_mismatch", "Mode switch requires a Binding identity different from the current epoch"));
	if (input.safeBoundary === undefined || !["turn_end", "checkpoint", "provider_idle"].includes(input.safeBoundary)) return Result.err(new FoundationError("binding_epoch_invalid_ordinal", "Mode switch requires an acknowledged safe boundary"));
	if (input.intent.taskId !== input.currentEpoch.taskId || input.intent.attemptId !== input.currentEpoch.attemptId || input.intent.bindingId !== input.currentEpoch.bindingId || input.intent.agentInstanceId !== input.currentEpoch.agentInstanceId) return Result.err(new FoundationError("binding_epoch_mismatch", "Mode switch must retain Task, Attempt, current Binding, and AgentInstance correlation", { details: { modeSwitchId: input.intent.modeSwitchId } }));
	if (correlation.value.taskId !== input.currentEpoch.taskId || correlation.value.attemptId !== input.currentEpoch.attemptId || correlation.value.bindingId !== input.currentEpoch.bindingId || correlation.value.bindingEpochId !== input.currentEpoch.bindingEpochId || correlation.value.agentInstanceId !== input.currentEpoch.agentInstanceId) return Result.err(new FoundationError("invalid_correlation", "Mode switch correlation does not match the current BindingEpoch", { details: { modeSwitchId: input.intent.modeSwitchId } }));
	if (bindingResult.value.taskId !== input.currentEpoch.taskId) return Result.err(new FoundationError("binding_epoch_mismatch", "Mode switch next Binding must retain the current Task", { details: { modeSwitchId: input.intent.modeSwitchId } }));
	if (input.intent.newBindingId !== undefined && input.intent.newBindingId !== nextBindingId) return Result.err(new FoundationError("binding_epoch_mismatch", "Mode switch intent does not identify the requested next Binding", { details: { modeSwitchId: input.intent.modeSwitchId } }));
	return createOrderedBindingEpoch({ bindingEpochId: `binding_epoch_${input.intent.modeSwitchId}`, taskId: input.currentEpoch.taskId, attemptId: input.currentEpoch.attemptId, bindingId: nextBindingId, agentInstanceId: input.currentEpoch.agentInstanceId, activationReason: "mode_switch", activatedByCommandId: input.intent.activatedByCommandId, previous: input.currentEpoch, now: input.now });
}
