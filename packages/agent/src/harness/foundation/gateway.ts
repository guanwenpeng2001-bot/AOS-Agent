import { Result, type Result as ResultValue } from "../result.ts";
import { InMemoryBudgetLedger, type BudgetLedgerV1, type BudgetScopeV1, type BudgetUsageV1, type BudgetV1 } from "./budget.ts";
import { FoundationError, toFoundationError } from "./errors.ts";
import { validateScopedModelRequestV1, validateScopedModelResultV1, validateToolExecutionResultV1, validateToolGatewayRequestV1, type ScopedModelGateway, type ScopedModelRequestV1, type ScopedModelResultV1, type ToolExecutionResultV1, type ToolGateway, type ToolGatewayRequestV1 } from "./providers.ts";
import type { AgentBindingV1, BindingEpochV1 } from "./role.ts";

export type ScopedExecutorProviderClassV1 = "scheduler" | "task_executor" | "agent" | "external_connector";
export interface ScopedGatewayScopeV1 extends BudgetScopeV1 {
	bindingId: string;
	bindingEpochId: string;
	providerClass: ScopedExecutorProviderClassV1;
}

export interface ScopedExecutionGatewayOptionsV1 {
	model: ScopedModelGateway;
	tool?: ToolGateway;
	binding: AgentBindingV1;
	epoch: BindingEpochV1;
	providerClass?: ScopedExecutorProviderClassV1;
	budget?: BudgetV1;
	ledger?: BudgetLedgerV1;
}

/** The only model/tool boundary exposed to an executor; every call is checked against one epoch. */
export class ScopedExecutionGatewayV1 {
	readonly scope: ScopedGatewayScopeV1;
	private readonly model: ScopedModelGateway;
	private readonly tool?: ToolGateway;
	private readonly ledger: BudgetLedgerV1;
	private readonly budget: BudgetV1;
	private readonly boundModelProfileId: string;
	private readonly boundModelProfileRevision: number;
	private readonly initializationError?: FoundationError;

	constructor(options: ScopedExecutionGatewayOptionsV1) {
		this.model = options.model;
		this.tool = options.tool;
		this.ledger = options.ledger ?? new InMemoryBudgetLedger();
		this.boundModelProfileId = options.binding.modelProfileRevision.id;
		this.boundModelProfileRevision = options.binding.modelProfileRevision.revision;
		this.scope = {
			taskId: options.binding.taskId,
			goalId: options.binding.goalId,
			attemptId: options.epoch.attemptId,
			...(options.epoch.agentInstanceId === undefined ? {} : { agentInstanceId: options.epoch.agentInstanceId }),
			bindingId: options.binding.bindingId,
			bindingEpochId: options.epoch.bindingEpochId,
			providerClass: options.providerClass ?? "task_executor",
		};
		this.budget = mergeBudget(options.binding.budget, options.budget ?? {});
		if (options.epoch.taskId !== options.binding.taskId || options.epoch.bindingId !== options.binding.bindingId) this.initializationError = new FoundationError("binding_epoch_mismatch", "Scoped gateway epoch does not belong to its binding");
		else if (this.scope.providerClass === "agent" && options.epoch.agentInstanceId === undefined) this.initializationError = new FoundationError("agent_instance_required_for_agent_provider", "Agent gateway requires an AgentInstance");
		else if (this.scope.providerClass !== "agent" && options.epoch.agentInstanceId !== undefined) this.initializationError = new FoundationError("agent_instance_forbidden_for_provider", "Non-agent gateway cannot carry an AgentInstance");
		else {
			const reserved = this.ledger.reserve(this.scope, this.budget);
			if (!reserved.ok) this.initializationError = reserved.error;
		}
	}

	async stream(request: ScopedModelRequestV1, options?: { signal?: AbortSignal }): Promise<ResultValue<ScopedModelResultV1, FoundationError>> {
		const checked = this.checkModelRequest(request);
		if (!checked.ok) return checked;
		const counted = this.ledger.record(this.scope, { modelCalls: 1 });
		if (!counted.ok) return counted;
		try {
			const response = await this.model.stream(checked.value, options);
			if (!response.ok) return response;
			const validResponse = validateScopedModelResultV1(response.value);
			if (!validResponse.ok) return validResponse;
			if (validResponse.value.requestId !== checked.value.requestId) return Result.err(new FoundationError("invalid_correlation", "Model gateway response does not match its request", { details: { requestId: checked.value.requestId } }));
			const usage = withoutCallCount(validResponse.value.usage, "modelCalls");
			const recorded = this.ledger.record(this.scope, usage);
			if (!recorded.ok) return recorded;
			return validResponse;
		} catch (error) {
			return Result.err(toFoundationError(error, "tool_guard_denied"));
		}
	}

	async execute(request: ToolGatewayRequestV1, options?: { signal?: AbortSignal }): Promise<ResultValue<ToolExecutionResultV1, FoundationError>> {
		if (this.initializationError !== undefined) return Result.err(this.initializationError);
		if (this.tool === undefined) return Result.err(new FoundationError("tool_guard_denied", "This scoped gateway has no tool provider"));
		const checked = validateToolGatewayRequestV1(request);
		if (!checked.ok) return checked;
		const scopeCheck = checkScope(this.scope, checked.value.context.taskId, checked.value.context.bindingId, checked.value.context.bindingEpochId, checked.value.context.attemptId, checked.value.context.agentInstanceId);
		if (!scopeCheck.ok) return scopeCheck;
		const counted = this.ledger.record(this.scope, { toolCalls: 1 });
		if (!counted.ok) return counted;
		try {
			const response = await this.tool.execute(checked.value, options);
			if (!response.ok) return response;
			const validResponse = validateToolExecutionResultV1(response.value);
			if (!validResponse.ok) return validResponse;
			if (validResponse.value.toolCallId !== checked.value.toolCallId || validResponse.value.toolName !== checked.value.toolName) return Result.err(new FoundationError("invalid_correlation", "Tool gateway response does not match its request", { details: { toolCallId: checked.value.toolCallId } }));
			return validResponse;
		} catch (error) {
			return Result.err(toFoundationError(error, "tool_guard_denied"));
		}
	}

	usage(): BudgetUsageV1 { return this.ledger.usage(this.scope); }
	remaining(): BudgetV1 { return this.ledger.remaining(this.scope, this.budget); }

	private checkModelRequest(request: ScopedModelRequestV1): ResultValue<ScopedModelRequestV1, FoundationError> {
		if (this.initializationError !== undefined) return Result.err(this.initializationError);
		const checked = validateScopedModelRequestV1(request);
		if (!checked.ok) return checked;
		const scopeCheck = checkScope(this.scope, checked.value.taskId, this.scope.bindingId, checked.value.bindingEpochId, checked.value.attemptId, checked.value.agentInstanceId);
		if (!scopeCheck.ok) return scopeCheck;
		if (checked.value.modelProfileRevision.id !== this.boundModelProfileId || checked.value.modelProfileRevision.revision !== this.boundModelProfileRevision) return Result.err(new FoundationError("binding_task_before_binding", "Model request does not use the bound ModelProfile revision"));
		return checked;
	}

}

function checkScope(scope: ScopedGatewayScopeV1, taskId: string, bindingId: string, bindingEpochId: string, attemptId?: string, agentInstanceId?: string): ResultValue<true, FoundationError> {
	if (taskId !== scope.taskId || bindingId !== scope.bindingId || bindingEpochId !== scope.bindingEpochId || attemptId !== undefined && attemptId !== scope.attemptId) return Result.err(new FoundationError("binding_task_before_binding", "Gateway request is outside its binding epoch"));
	if (scope.providerClass === "agent" && agentInstanceId !== scope.agentInstanceId) return Result.err(new FoundationError("agent_instance_required_for_agent_provider", "Agent gateway request must identify its bound AgentInstance"));
	if (scope.providerClass !== "agent" && agentInstanceId !== undefined) return Result.err(new FoundationError("agent_instance_forbidden_for_provider", "Non-agent gateway requests cannot identify an AgentInstance"));
	return Result.ok(true);
}

function withoutCallCount(usage: BudgetUsageV1, field: "modelCalls" | "toolCalls"): BudgetUsageV1 {
	const { modelCalls: _modelCalls, toolCalls: _toolCalls, ...rest } = usage;
	return field === "modelCalls" ? { ...rest, ...(usage.toolCalls === undefined ? {} : { toolCalls: usage.toolCalls }) } : { ...rest, ...(usage.modelCalls === undefined ? {} : { modelCalls: usage.modelCalls }) };
}

function mergeBudget(left: BudgetV1, right: BudgetV1): BudgetV1 {
	const result: BudgetV1 = {};
	for (const key of ["tokens", "costUsd", "modelCalls", "toolCalls", "wallClockMs", "concurrency"] as const) {
		const a = left[key];
		const b = right[key];
		if (a !== undefined || b !== undefined) result[key] = a === undefined ? b : b === undefined ? a : Math.min(a, b);
	}
	return result;
}

export const ScopedGateway = ScopedExecutionGatewayV1;
export const BudgetedScopedGatewayV1 = ScopedExecutionGatewayV1;
