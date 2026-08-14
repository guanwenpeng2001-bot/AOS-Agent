/** Shared cancellation/deadline boundary for model, tool, MCP, and sandbox calls. */

import { type AgentOperationSignal, createAgentOperationSignal } from "@aos-agent/agent-core";

export interface OperationBoundaryOptions {
	signals?: ReadonlyArray<AbortSignal | undefined>;
	deadlineMs?: number;
}

export type OperationBoundary = AgentOperationSignal;

/** Link all parent signals and a deadline into one signal for a boundary call. */
export function createOperationBoundary(options: OperationBoundaryOptions = {}): OperationBoundary {
	const parent = new AbortController();
	const linkedSignals = (options.signals ?? []).filter((signal): signal is AbortSignal => signal !== undefined);
	const listeners = new Map<AbortSignal, () => void>();
	for (const signal of linkedSignals) {
		const abortParent = (): void => {
			if (!parent.signal.aborted) parent.abort(signal.reason);
		};
		listeners.set(signal, abortParent);
		if (signal.aborted) abortParent();
		else signal.addEventListener("abort", abortParent, { once: true });
	}
	const operation = createAgentOperationSignal(parent.signal, options.deadlineMs);
	return {
		signal: operation.signal,
		...(operation.deadlineAt === undefined ? {} : { deadlineAt: operation.deadlineAt }),
		abort: operation.abort,
		dispose(): void {
			for (const [signal, listener] of listeners) signal.removeEventListener("abort", listener);
			operation.dispose();
		},
	};
}
