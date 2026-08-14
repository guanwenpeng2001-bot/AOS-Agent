import type { AssistantMessage, ToolResultMessage } from "@aos-agent/ai";

/** Reasons for ending a run before starting another provider turn. */
export type AgentLoopConvergenceReason = "max_iterations" | "duplicate_tool_call" | "dead_loop";

/** Bounds applied to one Agent provider/tool loop. */
export interface AgentLoopConvergenceOptions {
	/** Maximum number of provider turns in one loop invocation. */
	maxIterations?: number;
	/** Maximum observations of the same tool name and arguments. */
	maxDuplicateToolCalls?: number;
	/** Maximum consecutive turns without a progress change. */
	maxNoProgressIterations?: number;
}

export interface AgentLoopConvergenceDecision {
	readonly stop: boolean;
	readonly iteration: number;
	readonly reason?: AgentLoopConvergenceReason;
	readonly fingerprint?: string;
}

export interface AgentLoopConvergenceObservation {
	readonly toolCalls?: readonly { readonly name: string; readonly arguments: unknown }[];
	readonly progressToken?: string;
	readonly madeProgress?: boolean;
}

export interface AgentLoopConvergenceState {
	readonly maxIterations: number;
	readonly maxDuplicateToolCalls: number;
	readonly maxNoProgressIterations: number;
	readonly iterations: number;
	readonly noProgressIterations: number;
	readonly toolCallCounts: ReadonlyArray<{ readonly fingerprint: string; readonly count: number }>;
	readonly decision?: AgentLoopConvergenceDecision;
}

export const DEFAULT_AGENT_LOOP_CONVERGENCE = Object.freeze({
	maxIterations: 100,
	maxDuplicateToolCalls: 3,
	maxNoProgressIterations: 5,
} satisfies Required<AgentLoopConvergenceOptions>);

function assertPositiveInteger(value: number, name: string): void {
	if (!Number.isInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive integer`);
}

function stableValue(value: unknown, active: Set<object>): string {
	if (value === null) return "null";
	if (typeof value === "string") return JSON.stringify(value);
	if (typeof value === "number") return `number:${value}`;
	if (typeof value === "boolean") return `boolean:${value}`;
	if (typeof value === "bigint") return `bigint:${value}`;
	if (value === undefined) return "undefined";
	if (typeof value !== "object") return String(value);
	if (active.has(value)) return "[Circular]";
	active.add(value);
	let result: string;
	if (Array.isArray(value)) {
		result = `[${value.map((item) => stableValue(item, active)).join(",")}]`;
	} else {
		result = `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${stableValue((value as Record<string, unknown>)[key], active)}`)
			.join(",")}}`;
	}
	active.delete(value);
	return result;
}

function toolCallFingerprint(toolCall: { readonly name: string; readonly arguments: unknown }): string {
	return `${toolCall.name}:${stableValue(toolCall.arguments, new Set<object>())}`;
}

/** Build a progress token without provider-generated ids or timestamps. */
export function fingerprintAgentTurn(message: AssistantMessage, toolResults: readonly ToolResultMessage[]): string {
	const assistantContent = message.content.map((block) => {
		if (block.type === "toolCall") return { type: block.type, name: block.name, arguments: block.arguments };
		return block;
	});
	const resultContent = toolResults.map((result) => ({
		content: result.content,
		isError: result.isError,
	}));
	return stableValue({ assistantContent, resultContent }, new Set<object>());
}

/**
 * Stateful guard used by the production Agent loop. It records only bounded,
 * in-memory fingerprints; it never becomes a second durable ledger.
 */
export class AgentLoopConvergenceGuard {
	private readonly maxIterations: number;
	private readonly maxDuplicateToolCalls: number;
	private readonly maxNoProgressIterations: number;
	private iterations = 0;
	private noProgressIterations = 0;
	private lastProgressToken: string | undefined;
	private readonly toolCallCounts = new Map<string, number>();
	private terminalDecision: AgentLoopConvergenceDecision | undefined;

	constructor(options: AgentLoopConvergenceOptions = {}) {
		this.maxIterations = options.maxIterations ?? DEFAULT_AGENT_LOOP_CONVERGENCE.maxIterations;
		this.maxDuplicateToolCalls =
			options.maxDuplicateToolCalls ?? DEFAULT_AGENT_LOOP_CONVERGENCE.maxDuplicateToolCalls;
		this.maxNoProgressIterations =
			options.maxNoProgressIterations ?? DEFAULT_AGENT_LOOP_CONVERGENCE.maxNoProgressIterations;
		assertPositiveInteger(this.maxIterations, "maxIterations");
		assertPositiveInteger(this.maxDuplicateToolCalls, "maxDuplicateToolCalls");
		assertPositiveInteger(this.maxNoProgressIterations, "maxNoProgressIterations");
	}

	get state(): AgentLoopConvergenceState {
		return {
			maxIterations: this.maxIterations,
			maxDuplicateToolCalls: this.maxDuplicateToolCalls,
			maxNoProgressIterations: this.maxNoProgressIterations,
			iterations: this.iterations,
			noProgressIterations: this.noProgressIterations,
			toolCallCounts: [...this.toolCallCounts.entries()].map(([fingerprint, count]) => ({ fingerprint, count })),
			...(this.terminalDecision === undefined ? {} : { decision: this.terminalDecision }),
		};
	}

	/** Decide whether another provider turn may begin. */
	beforeTurn(): AgentLoopConvergenceDecision {
		if (this.terminalDecision !== undefined) return this.terminalDecision;
		if (this.iterations >= this.maxIterations) {
			return this.stop({ stop: true, iteration: this.iterations, reason: "max_iterations" });
		}
		this.iterations += 1;
		return { stop: false, iteration: this.iterations };
	}

	/** Record the completed turn and decide whether the loop should end now. */
	observe(observation: AgentLoopConvergenceObservation): AgentLoopConvergenceDecision {
		if (this.terminalDecision !== undefined) return this.terminalDecision;

		let duplicateFingerprint: string | undefined;
		const observedFingerprints = new Set<string>();
		for (const toolCall of observation.toolCalls ?? []) {
			const fingerprint = toolCallFingerprint(toolCall);
			if (observedFingerprints.has(fingerprint)) continue;
			observedFingerprints.add(fingerprint);
			const count = (this.toolCallCounts.get(fingerprint) ?? 0) + 1;
			this.toolCallCounts.set(fingerprint, count);
			if (count >= this.maxDuplicateToolCalls && duplicateFingerprint === undefined) {
				duplicateFingerprint = fingerprint;
			}
		}

		const repeatedProgress =
			observation.progressToken !== undefined && observation.progressToken === this.lastProgressToken;
		const noProgress = observation.madeProgress === false || repeatedProgress;
		this.noProgressIterations = noProgress ? this.noProgressIterations + 1 : 0;
		if (observation.progressToken !== undefined) this.lastProgressToken = observation.progressToken;

		if (this.iterations >= this.maxIterations) {
			return this.stop({ stop: true, iteration: this.iterations, reason: "max_iterations" });
		}
		if (duplicateFingerprint !== undefined) {
			return this.stop({
				stop: true,
				iteration: this.iterations,
				reason: "duplicate_tool_call",
				fingerprint: duplicateFingerprint,
			});
		}
		if (this.noProgressIterations >= this.maxNoProgressIterations) {
			return this.stop({ stop: true, iteration: this.iterations, reason: "dead_loop" });
		}
		return { stop: false, iteration: this.iterations };
	}

	private stop(decision: AgentLoopConvergenceDecision): AgentLoopConvergenceDecision {
		this.terminalDecision = decision;
		return decision;
	}
}

export function createAgentLoopConvergenceGuard(
	options: AgentLoopConvergenceOptions | undefined,
): AgentLoopConvergenceGuard {
	return new AgentLoopConvergenceGuard(options);
}
