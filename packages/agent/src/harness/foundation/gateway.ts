import { Result, type ResultValue } from "../result.ts";
import { InMemoryBudgetLedger, type BudgetLedger, type BudgetScope, type BudgetUsage, type Budget } from "./budget.ts";
import { FoundationError, toFoundationError } from "./errors.ts";
import { validateScopedModelRequest, validateScopedModelResult, validateToolExecutionResult, validateToolGatewayRequest, type ScopedModelGateway, type ScopedModelRequest, type ScopedModelResult, type ToolExecutionResult, type ToolGateway, type ToolGatewayRequest } from "./providers.ts";
import type { AgentBinding, BindingEpoch } from "./role.ts";

export type ScopedExecutorProviderClass = "scheduler" | "task_executor" | "agent" | "external_connector";
export interface ScopedGatewayScope extends BudgetScope {
	bindingId: string;
	bindingEpochId: string;
	providerClass: ScopedExecutorProviderClass;
}

export interface ScopedExecutionGatewayOptions {
	model: ScopedModelGateway;
	tool?: ToolGateway;
	binding: AgentBinding;
	epoch: BindingEpoch;
	providerClass?: ScopedExecutorProviderClass;
	budget?: Budget;
	ledger?: BudgetLedger;
}

/** The only model/tool boundary exposed to an executor; every call is checked against one epoch. */
export class ScopedExecutionGateway {
	readonly scope: ScopedGatewayScope;
	private readonly model: ScopedModelGateway;
	private readonly tool?: ToolGateway;
	private readonly ledger: BudgetLedger;
	private readonly budget: Budget;
	private readonly boundModelProfileId: string;
	private readonly boundModelProfileRevision: number;
	private readonly initializationError?: FoundationError;

	constructor(options: ScopedExecutionGatewayOptions) {
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

	async stream(request: ScopedModelRequest, options?: { signal?: AbortSignal }): Promise<ResultValue<ScopedModelResult, FoundationError>> {
		const checked = this.checkModelRequest(request);
		if (!checked.ok) return checked;
		const counted = this.ledger.record(this.scope, { modelCalls: 1 });
		if (!counted.ok) return counted;
		try {
			const response = await this.model.stream(checked.value, options);
			if (!response.ok) return response;
			const validResponse = validateScopedModelResult(response.value);
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

	async execute(request: ToolGatewayRequest, options?: { signal?: AbortSignal }): Promise<ResultValue<ToolExecutionResult, FoundationError>> {
		if (this.initializationError !== undefined) return Result.err(this.initializationError);
		if (this.tool === undefined) return Result.err(new FoundationError("tool_guard_denied", "This scoped gateway has no tool provider"));
		const checked = validateToolGatewayRequest(request);
		if (!checked.ok) return checked;
		const scopeCheck = checkScope(this.scope, checked.value.context.taskId, checked.value.context.bindingId, checked.value.context.bindingEpochId, checked.value.context.attemptId, checked.value.context.agentInstanceId);
		if (!scopeCheck.ok) return scopeCheck;
		const counted = this.ledger.record(this.scope, { toolCalls: 1 });
		if (!counted.ok) return counted;
		try {
			const response = await this.tool.execute(checked.value, options);
			if (!response.ok) return response;
			const validResponse = validateToolExecutionResult(response.value);
			if (!validResponse.ok) return validResponse;
			if (validResponse.value.toolCallId !== checked.value.toolCallId || validResponse.value.toolName !== checked.value.toolName) return Result.err(new FoundationError("invalid_correlation", "Tool gateway response does not match its request", { details: { toolCallId: checked.value.toolCallId } }));
			return validResponse;
		} catch (error) {
			return Result.err(toFoundationError(error, "tool_guard_denied"));
		}
	}

	usage(): BudgetUsage { return this.ledger.usage(this.scope); }
	remaining(): Budget { return this.ledger.remaining(this.scope, this.budget); }

	private checkModelRequest(request: ScopedModelRequest): ResultValue<ScopedModelRequest, FoundationError> {
		if (this.initializationError !== undefined) return Result.err(this.initializationError);
		const checked = validateScopedModelRequest(request);
		if (!checked.ok) return checked;
		const scopeCheck = checkScope(this.scope, checked.value.taskId, this.scope.bindingId, checked.value.bindingEpochId, checked.value.attemptId, checked.value.agentInstanceId);
		if (!scopeCheck.ok) return scopeCheck;
		if (checked.value.modelProfileRevision.id !== this.boundModelProfileId || checked.value.modelProfileRevision.revision !== this.boundModelProfileRevision) return Result.err(new FoundationError("binding_task_before_binding", "Model request does not use the bound ModelProfile revision"));
		return checked;
	}

}

function checkScope(scope: ScopedGatewayScope, taskId: string, bindingId: string, bindingEpochId: string, attemptId?: string, agentInstanceId?: string): ResultValue<true, FoundationError> {
	if (taskId !== scope.taskId || bindingId !== scope.bindingId || bindingEpochId !== scope.bindingEpochId || attemptId !== undefined && attemptId !== scope.attemptId) return Result.err(new FoundationError("binding_task_before_binding", "Gateway request is outside its binding epoch"));
	if (scope.providerClass === "agent" && agentInstanceId !== scope.agentInstanceId) return Result.err(new FoundationError("agent_instance_required_for_agent_provider", "Agent gateway request must identify its bound AgentInstance"));
	if (scope.providerClass !== "agent" && agentInstanceId !== undefined) return Result.err(new FoundationError("agent_instance_forbidden_for_provider", "Non-agent gateway requests cannot identify an AgentInstance"));
	return Result.ok(true);
}

function withoutCallCount(usage: BudgetUsage, field: "modelCalls" | "toolCalls"): BudgetUsage {
	const { modelCalls: _modelCalls, toolCalls: _toolCalls, ...rest } = usage;
	return field === "modelCalls" ? { ...rest, ...(usage.toolCalls === undefined ? {} : { toolCalls: usage.toolCalls }) } : { ...rest, ...(usage.modelCalls === undefined ? {} : { modelCalls: usage.modelCalls }) };
}

function mergeBudget(left: Budget, right: Budget): Budget {
	const result: Budget = {};
	for (const key of ["tokens", "costUsd", "modelCalls", "toolCalls", "wallClockMs", "concurrency"] as const) {
		const a = left[key];
		const b = right[key];
		if (a !== undefined || b !== undefined) result[key] = a === undefined ? b : b === undefined ? a : Math.min(a, b);
	}
	return result;
}

export const ScopedGateway = ScopedExecutionGateway;
