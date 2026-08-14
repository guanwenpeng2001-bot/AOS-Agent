/** Error used as the abort reason when an Agent operation reaches its deadline. */
export class AgentDeadlineExceeded extends Error {
	readonly deadlineAt: number;

	constructor(deadlineAt: number) {
		super(`Agent operation deadline exceeded at ${deadlineAt}`);
		this.name = "AgentDeadlineExceeded";
		this.deadlineAt = deadlineAt;
	}
}

/** Stable cancellation reason shared with Automation Host deadline handling. */
export class AgentOperationError extends Error {
	readonly code: "cancelled" | "deadline_exceeded";

	constructor(code: "cancelled" | "deadline_exceeded") {
		super(code === "deadline_exceeded" ? "Operation deadline exceeded." : "Operation cancelled.");
		this.name = "AgentOperationError";
		this.code = code;
	}
}

export interface AgentOperationSignalOptions {
	parent?: AbortSignal;
	deadlineAt?: number;
	deadlineMs?: number;
	now?: () => number;
}

export interface AgentOperationSignal {
	readonly controller: AbortController;
	readonly signal: AbortSignal;
	readonly deadlineAt?: number;
	abort(reason?: unknown): void;
	dispose(): void;
	cleanup(): void;
}

function validateDeadline(deadlineAt: number | undefined, deadlineMs: number | undefined): void {
	if (deadlineAt !== undefined && !Number.isFinite(deadlineAt)) {
		throw new RangeError("deadlineAt must be finite");
	}
	if (deadlineMs !== undefined && (!Number.isFinite(deadlineMs) || deadlineMs < 0)) {
		throw new RangeError("deadlineMs must be a non-negative finite number");
	}
}

/** Create one linked signal for a run and all provider/tool callbacks in it. */
export function createAgentOperationSignal(options?: AgentOperationSignalOptions): AgentOperationSignal;
export function createAgentOperationSignal(parent?: AbortSignal, deadlineMs?: number): AgentOperationSignal;
export function createAgentOperationSignal(
	optionsOrParent: AgentOperationSignalOptions | AbortSignal = {},
	deadlineMs?: number,
): AgentOperationSignal {
	const options: AgentOperationSignalOptions =
		optionsOrParent instanceof AbortSignal ? { parent: optionsOrParent, deadlineMs } : optionsOrParent;
	validateDeadline(options.deadlineAt, options.deadlineMs);
	const now = options.now ?? Date.now;
	const deadlineAt = options.deadlineAt ?? (options.deadlineMs === undefined ? undefined : now() + options.deadlineMs);
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	let parentListener: (() => void) | undefined;

	const abortForDeadline = () => {
		if (!controller.signal.aborted && deadlineAt !== undefined) {
			controller.abort(new AgentDeadlineExceeded(deadlineAt));
		}
	};

	if (options.parent) {
		if (options.parent.aborted) controller.abort(options.parent.reason);
		else {
			parentListener = () => controller.abort(options.parent?.reason);
			options.parent.addEventListener("abort", parentListener, { once: true });
		}
	}

	if (deadlineAt !== undefined) {
		const delay = deadlineAt - now();
		if (delay <= 0) abortForDeadline();
		else timer = setTimeout(abortForDeadline, delay);
	}

	return {
		controller,
		signal: controller.signal,
		...(deadlineAt === undefined ? {} : { deadlineAt }),
		abort(reason?: unknown): void {
			controller.abort(reason ?? new AgentOperationError("cancelled"));
		},
		dispose(): void {
			if (timer !== undefined) clearTimeout(timer);
			if (parentListener && options.parent) options.parent.removeEventListener("abort", parentListener);
		},
		cleanup: () => {
			if (timer !== undefined) clearTimeout(timer);
			if (parentListener && options.parent) options.parent.removeEventListener("abort", parentListener);
		},
	};
}

function abortReason(signal: AbortSignal): unknown {
	if (signal.reason !== undefined) return signal.reason;
	const error = new Error("The Agent operation was aborted");
	error.name = "AbortError";
	return error;
}

/** Stop waiting at cancellation while observing the abandoned promise safely. */
export function raceWithAbortSignal<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (signal === undefined) return operation;
	if (signal.aborted) {
		void operation.catch(() => undefined);
		return Promise.reject(abortReason(signal));
	}

	return new Promise<T>((resolve, reject) => {
		let settled = false;
		const cleanup = () => signal.removeEventListener("abort", onAbort);
		const onAbort = () => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(abortReason(signal));
		};

		signal.addEventListener("abort", onAbort, { once: true });
		void operation.then(
			(value) => {
				if (settled) return;
				settled = true;
				cleanup();
				resolve(value);
			},
			(error: unknown) => {
				if (settled) return;
				settled = true;
				cleanup();
				reject(error);
			},
		);
		if (signal.aborted) onAbort();
	});
}
