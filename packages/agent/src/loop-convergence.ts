/**
 * Bounded progress guards for the Agent loop.
 *
 * The provider is allowed to ask for another tool turn, but it must not be
 * able to keep the process alive forever. The guard is deliberately independent
 * of provider or UI state so callers can use the same limits in tests and in
 * the stateful Agent wrapper.
 */

import type { AgentToolCall } from "./types.ts";

export interface AgentLoopLimits {
	/** Maximum number of assistant turns in one prompt/continuation. */
	readonly maxTurns?: number;
	/** Maximum number of tool calls in one prompt/continuation. */
	readonly maxToolCalls?: number;
	/** Maximum number of queued follow-up messages consumed by one run. */
	readonly maxFollowUps?: number;
	/** Maximum consecutive occurrences of one normalized tool call. */
	readonly maxRepeatedToolCalls?: number;
}

export const DEFAULT_AGENT_LOOP_LIMITS: Required<AgentLoopLimits> = {
	maxTurns: 100,
	maxToolCalls: 200,
	maxFollowUps: 100,
	maxRepeatedToolCalls: 4,
};

export type AgentLoopErrorCode = "max_turns" | "max_tool_calls" | "max_follow_ups" | "repeated_tool_call";

export class AgentLoopError extends Error {
	readonly code: AgentLoopErrorCode;
	readonly count: number;
	readonly limit: number;
	readonly toolCallKey?: string;

	constructor(code: AgentLoopErrorCode, count: number, limit: number, toolCallKey?: string) {
		super(
			code === "repeated_tool_call"
				? `Repeated tool call detected after ${count} occurrences (limit ${limit}).`
				: `Agent loop ${code.replace(/_/g, " ")} after ${count} (limit ${limit}).`,
		);
		this.name = "AgentLoopError";
		this.code = code;
		this.count = count;
		this.limit = limit;
		this.toolCallKey = toolCallKey;
	}
}

function normalizeValue(value: unknown, seen: WeakSet<object>): unknown {
	if (value === null || typeof value !== "object") {
		if (typeof value === "number" && !Number.isFinite(value)) return String(value);
		return value;
	}
	if (seen.has(value)) return "[cycle]";
	seen.add(value);
	if (Array.isArray(value)) return value.map((item) => normalizeValue(item, seen));
	const record = value as Record<string, unknown>;
	return Object.fromEntries(
		Object.keys(record)
			.sort()
			.map((key) => [key, normalizeValue(record[key], seen)]),
	);
}

/** Returns a deterministic key for tool name plus arguments. */
export function normalizeToolCallKey(toolCall: Pick<AgentToolCall, "name" | "arguments">): string {
	return `${toolCall.name}:${JSON.stringify(normalizeValue(toolCall.arguments, new WeakSet<object>()))}`;
}

export interface AgentLoopGuard {
	startTurn(): void;
	recordToolCalls(toolCalls: readonly AgentToolCall[]): void;
	recordFollowUps(count: number): void;
}

function positiveLimit(value: number | undefined, fallback: number): number {
	return value === undefined ? fallback : Math.max(1, Math.floor(value));
}

export function createAgentLoopGuard(limits: AgentLoopLimits = {}): AgentLoopGuard {
	const maxTurns = positiveLimit(limits.maxTurns, DEFAULT_AGENT_LOOP_LIMITS.maxTurns);
	const maxToolCalls = positiveLimit(limits.maxToolCalls, DEFAULT_AGENT_LOOP_LIMITS.maxToolCalls);
	const maxFollowUps = positiveLimit(limits.maxFollowUps, DEFAULT_AGENT_LOOP_LIMITS.maxFollowUps);
	const maxRepeatedToolCalls = positiveLimit(
		limits.maxRepeatedToolCalls,
		DEFAULT_AGENT_LOOP_LIMITS.maxRepeatedToolCalls,
	);
	let turns = 0;
	let toolCalls = 0;
	let followUps = 0;
	let previousToolCallKey: string | undefined;
	let repeatedToolCalls = 0;

	return {
		startTurn(): void {
			turns += 1;
			if (turns > maxTurns) throw new AgentLoopError("max_turns", turns, maxTurns);
		},
		recordToolCalls(calls): void {
			toolCalls += calls.length;
			if (toolCalls > maxToolCalls) throw new AgentLoopError("max_tool_calls", toolCalls, maxToolCalls);
			for (const call of calls) {
				const key = normalizeToolCallKey(call);
				repeatedToolCalls = key === previousToolCallKey ? repeatedToolCalls + 1 : 1;
				previousToolCallKey = key;
				if (repeatedToolCalls > maxRepeatedToolCalls) {
					throw new AgentLoopError("repeated_tool_call", repeatedToolCalls, maxRepeatedToolCalls, key);
				}
			}
		},
		recordFollowUps(count): void {
			followUps += count;
			if (followUps > maxFollowUps) throw new AgentLoopError("max_follow_ups", followUps, maxFollowUps);
		},
	};
}
