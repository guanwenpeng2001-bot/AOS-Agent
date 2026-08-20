import { Type } from "typebox";
import { Result, type Result as ResultValue } from "../result.ts";
import { FoundationError } from "./errors.ts";
import { validateExactShape } from "./schema.ts";

export interface BudgetV1 {
	tokens?: number; costUsd?: number; modelCalls?: number; toolCalls?: number; wallClockMs?: number; concurrency?: number;
}
export const BudgetV1Schema = Type.Object({ tokens: Type.Optional(Type.Number({ minimum: 0 })), costUsd: Type.Optional(Type.Number({ minimum: 0 })), modelCalls: Type.Optional(Type.Integer({ minimum: 0 })), toolCalls: Type.Optional(Type.Integer({ minimum: 0 })), wallClockMs: Type.Optional(Type.Integer({ minimum: 0 })), concurrency: Type.Optional(Type.Integer({ minimum: 0 })) }, { additionalProperties: false });
export type BudgetLimit = BudgetV1;
export interface BudgetUsageV1 { tokens?: number; costUsd?: number; modelCalls?: number; toolCalls?: number; wallClockMs?: number; concurrency?: number; }
export const BudgetUsageV1Schema = Type.Object({ tokens: Type.Optional(Type.Number({ minimum: 0 })), costUsd: Type.Optional(Type.Number({ minimum: 0 })), modelCalls: Type.Optional(Type.Integer({ minimum: 0 })), toolCalls: Type.Optional(Type.Integer({ minimum: 0 })), wallClockMs: Type.Optional(Type.Integer({ minimum: 0 })), concurrency: Type.Optional(Type.Integer({ minimum: 0 })) }, { additionalProperties: false });
export type BudgetExhaustionReasonV1 = "tokens" | "cost" | "model_calls" | "tool_calls" | "wall_clock" | "concurrency";
export function budgetExhaustionReason(budget: BudgetV1, usage: BudgetUsageV1): BudgetExhaustionReasonV1 | undefined {
	if (budget.tokens !== undefined && (usage.tokens ?? 0) > budget.tokens) return "tokens";
	if (budget.costUsd !== undefined && (usage.costUsd ?? 0) > budget.costUsd) return "cost";
	if (budget.modelCalls !== undefined && (usage.modelCalls ?? 0) > budget.modelCalls) return "model_calls";
	if (budget.toolCalls !== undefined && (usage.toolCalls ?? 0) > budget.toolCalls) return "tool_calls";
	if (budget.wallClockMs !== undefined && (usage.wallClockMs ?? 0) > budget.wallClockMs) return "wall_clock";
	if (budget.concurrency !== undefined && (usage.concurrency ?? 0) > budget.concurrency) return "concurrency";
	return undefined;
}
export function validateBudgetV1(value: unknown): ResultValue<BudgetV1, FoundationError> {
	return validateFiniteBudget(BudgetV1Schema, value, "budget");
}

export function validateBudgetUsageV1(value: unknown): ResultValue<BudgetUsageV1, FoundationError> {
	return validateFiniteBudget(BudgetUsageV1Schema, value, "budget_usage");
}

function validateFiniteBudget(schema: Parameters<typeof validateExactShape>[0], value: unknown, kind: string): ResultValue<BudgetV1 | BudgetUsageV1, FoundationError> {
	const checked = validateExactShape<BudgetV1 | BudgetUsageV1>(schema, value, kind);
	if (!checked.ok) return checked;
	for (const amount of Object.values(checked.value)) {
		if (typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) return Result.err(new FoundationError("foundation_schema_invalid_shape", `${kind} failed exact-shape validation`));
	}
	return checked;
}

export interface BudgetScopeV1 {
	taskId: string;
	goalId?: string;
	runId?: string;
	attemptId?: string;
	agentInstanceId?: string;
}

export interface BudgetLedgerV1 {
	reserve(scope: BudgetScopeV1, budget: BudgetV1): ResultValue<BudgetUsageV1, FoundationError>;
	record(scope: BudgetScopeV1, usage: BudgetUsageV1): ResultValue<BudgetUsageV1, FoundationError>;
	usage(scope: BudgetScopeV1): BudgetUsageV1;
	remaining(scope: BudgetScopeV1, budget: BudgetV1): BudgetV1;
}

/** Small deterministic in-memory ledger used by scoped gateways and conformance tests. */
export class InMemoryBudgetLedger implements BudgetLedgerV1 {
	private readonly limits = new Map<string, BudgetV1>();
	private readonly usages = new Map<string, BudgetUsageV1>();

	reserve(scope: BudgetScopeV1, budget: BudgetV1): ResultValue<BudgetUsageV1, FoundationError> {
		const valid = validateBudgetV1(budget);
		if (!valid.ok) return valid;
		const key = budgetScopeKey(scope);
		const existing = this.limits.get(key);
		const merged = mergeLimits(existing, valid.value);
		const current = this.usages.get(key) ?? {};
		if (budgetExhaustionReason(merged, current) !== undefined) return Result.err(new FoundationError("budget_exhausted", "Budget scope is already exhausted"));
		this.limits.set(key, merged);
		this.usages.set(key, { ...current });
		return Result.ok({ ...current });
	}

	record(scope: BudgetScopeV1, usage: BudgetUsageV1): ResultValue<BudgetUsageV1, FoundationError> {
		const valid = validateBudgetUsageV1(usage);
		if (!valid.ok) return valid;
		const key = budgetScopeKey(scope);
		const next = addBudgetUsage(this.usages.get(key) ?? {}, valid.value);
		const reason = budgetExhaustionReason(this.limits.get(key) ?? {}, next);
		if (reason !== undefined) return Result.err(new FoundationError("budget_exhausted", `Budget exhausted: ${reason}`, { details: { reason } }));
		this.usages.set(key, next);
		return Result.ok({ ...next });
	}

	usage(scope: BudgetScopeV1): BudgetUsageV1 {
		return { ...(this.usages.get(budgetScopeKey(scope)) ?? {}) };
	}

	remaining(scope: BudgetScopeV1, budget: BudgetV1): BudgetV1 {
		const used = this.usage(scope);
		const remaining: BudgetV1 = {};
		for (const key of ["tokens", "costUsd", "modelCalls", "toolCalls", "wallClockMs", "concurrency"] as const) {
			const limit = budget[key];
			if (limit !== undefined) remaining[key] = Math.max(0, limit - (used[key] ?? 0));
		}
		return remaining;
	}
}

export const BudgetLedger = InMemoryBudgetLedger;
export const budgetScopeKey = (scope: BudgetScopeV1): string => [scope.taskId, scope.goalId ?? "", scope.runId ?? "", scope.attemptId ?? "", scope.agentInstanceId ?? ""].join("\u001f");

function mergeLimits(existing: BudgetV1 | undefined, incoming: BudgetV1): BudgetV1 {
	if (existing === undefined) return { ...incoming };
	const merged: BudgetV1 = {};
	for (const key of ["tokens", "costUsd", "modelCalls", "toolCalls", "wallClockMs", "concurrency"] as const) {
		const left = existing[key];
		const right = incoming[key];
		if (left !== undefined || right !== undefined) merged[key] = left === undefined ? right : right === undefined ? left : Math.min(left, right);
	}
	return merged;
}

function addBudgetUsage(left: BudgetUsageV1, right: BudgetUsageV1): BudgetUsageV1 {
	const total: BudgetUsageV1 = {};
	for (const key of ["tokens", "costUsd", "modelCalls", "toolCalls", "wallClockMs", "concurrency"] as const) {
		const value = (left[key] ?? 0) + (right[key] ?? 0);
		if (value !== 0) total[key] = value;
	}
	return total;
}
