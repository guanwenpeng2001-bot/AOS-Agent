/** Cancellation and deadline propagation for one Agent operation. */

export type AgentOperationErrorCode = "cancelled" | "deadline_exceeded";

export class AgentOperationError extends Error {
	readonly code: AgentOperationErrorCode;

	constructor(code: AgentOperationErrorCode) {
		super(code === "deadline_exceeded" ? "Operation deadline exceeded." : "Operation cancelled.");
		this.name = "AgentOperationError";
		this.code = code;
	}
}

export interface AgentOperationSignal {
	readonly signal: AbortSignal;
	readonly deadlineAt?: number;
	abort(reason?: unknown): void;
	dispose(): void;
}

/** Create a child signal linked to a caller signal and an optional duration. */
export function createAgentOperationSignal(parent?: AbortSignal, deadlineMs?: number): AgentOperationSignal {
	const controller = new AbortController();
	const normalizedDeadlineMs =
		deadlineMs === undefined ? undefined : Number.isFinite(deadlineMs) ? Math.max(0, deadlineMs) : 0;
	const deadlineAt = normalizedDeadlineMs === undefined ? undefined : Date.now() + normalizedDeadlineMs;
	let timeout: ReturnType<typeof setTimeout> | undefined;
	const abortFromParent = (): void => {
		if (!controller.signal.aborted) controller.abort(parent?.reason ?? new AgentOperationError("cancelled"));
	};
	if (parent?.aborted) {
		abortFromParent();
	} else {
		parent?.addEventListener("abort", abortFromParent, { once: true });
	}
	if (deadlineAt !== undefined) {
		const abortAtDeadline = (): void => {
			if (!controller.signal.aborted) controller.abort(new AgentOperationError("deadline_exceeded"));
		};
		if (deadlineAt <= Date.now()) abortAtDeadline();
		else timeout = setTimeout(abortAtDeadline, deadlineAt - Date.now());
	}
	return {
		signal: controller.signal,
		...(deadlineAt === undefined ? {} : { deadlineAt }),
		abort(reason?: unknown): void {
			controller.abort(reason ?? new AgentOperationError("cancelled"));
		},
		dispose(): void {
			if (timeout !== undefined) clearTimeout(timeout);
			parent?.removeEventListener("abort", abortFromParent);
		},
	};
}

export function throwIfAgentOperationAborted(signal?: AbortSignal): void {
	if (!signal?.aborted) return;
	const reason = signal.reason;
	if (reason instanceof AgentOperationError) throw reason;
	throw new AgentOperationError("cancelled");
}
