import {
	SYSTEM_RUNTIME_CLOCK,
	type RuntimeClock,
	type RuntimeTimerHandle,
} from "./clock.ts";

export type TerminationSignal = "SIGHUP" | "SIGINT" | "SIGTERM";

export type ShutdownState =
	| "accepting"
	| "closing_admission"
	| "handing_off_recovery"
	| "cleaning_resources"
	| "finalizing"
	| "completed"
	| "forced";

export interface ShutdownBudget {
	/** Total time from the first request through bounded finalization. */
	readonly totalMs: number;
	/** Maximum time granted to one recovery or resource cleanup. */
	readonly resourceMs: number;
	/** Reserved maximum time for the finalization hook. */
	readonly finalizationMs: number;
}

export const DEFAULT_SHUTDOWN_BUDGET: ShutdownBudget = Object.freeze({
	totalMs: 10_000,
	resourceMs: 5_000,
	finalizationMs: 1_000,
});

export interface ShutdownRequest {
	readonly kind: "request" | "signal";
	readonly exitCode: number;
	readonly signal?: TerminationSignal;
}

export interface ShutdownResource {
	readonly name: string;
	cleanup(signal: AbortSignal): void | Promise<void>;
}

export type ShutdownFailurePhase = "admission" | "recovery_handoff" | "resource" | "finalization";
export type ShutdownFailureReason = "cleanup_failed" | "deadline_exceeded";

export interface ShutdownFailure {
	readonly phase: ShutdownFailurePhase;
	readonly resource: string;
	readonly reason: ShutdownFailureReason;
	readonly error: unknown;
}

export interface ShutdownResult {
	readonly state: "completed" | "forced";
	readonly exitCode: number;
	readonly failures: readonly ShutdownFailure[];
}

export interface ShutdownSignalHandlers {
	add(signal: TerminationSignal, handler: () => void): void;
	remove(signal: TerminationSignal, handler: () => void): void;
}

export interface ShutdownCoordinatorOptions {
	/** This hook must synchronously fence every product admission surface. */
	readonly closeAdmission: (request: ShutdownRequest) => void;
	/**
	 * Best-effort handoff from accepted work to its already-durable recovery
	 * facts. Recovery after forced exit must not depend on this hook completing.
	 */
	readonly handoffRecovery?: (signal: AbortSignal) => void | Promise<void>;
	/** Groups run in order; resources within one group are independent and run in parallel. */
	readonly resourceGroups?: readonly (readonly ShutdownResource[])[];
	/** Bounded final diagnostics or output flush. It must not be recovery authority. */
	readonly finalize?: (signal: AbortSignal) => void | Promise<void>;
	readonly budget?: ShutdownBudget;
	readonly clock?: RuntimeClock;
	readonly onFailure?: (failure: ShutdownFailure) => void;
	readonly exit?: (exitCode: number) => void;
	readonly signalHandlers?: ShutdownSignalHandlers;
	readonly terminationSignals?: readonly TerminationSignal[];
}

type CleanupOutcome =
	| { readonly status: "succeeded" }
	| { readonly status: "failed"; readonly error: unknown }
	| { readonly status: "deadline_exceeded"; readonly error: Error };

const SIGNAL_EXIT_CODES: Readonly<Record<TerminationSignal, number>> = Object.freeze({
	SIGHUP: 129,
	SIGINT: 130,
	SIGTERM: 143,
});

const PROCESS_SIGNAL_HANDLERS: ShutdownSignalHandlers = Object.freeze({
	add: (signal: TerminationSignal, handler: () => void) => {
		process.on(signal, handler);
	},
	remove: (signal: TerminationSignal, handler: () => void) => {
		process.off(signal, handler);
	},
});

const STATE_TRANSITIONS: Readonly<Record<ShutdownState, readonly ShutdownState[]>> = Object.freeze({
	accepting: ["closing_admission"],
	closing_admission: ["handing_off_recovery", "forced"],
	handing_off_recovery: ["cleaning_resources", "forced"],
	cleaning_resources: ["finalizing", "forced"],
	finalizing: ["completed", "forced"],
	completed: [],
	forced: [],
});

/** POSIX-compatible stable exit status: 128 plus the signal number. */
export function terminationSignalExitCode(signal: TerminationSignal): number {
	return SIGNAL_EXIT_CODES[signal];
}

function validateDuration(name: string, value: number): void {
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new RangeError(`${name} must be a non-negative safe integer`);
	}
}

function validateBudget(budget: ShutdownBudget): void {
	validateDuration("shutdown totalMs", budget.totalMs);
	validateDuration("shutdown resourceMs", budget.resourceMs);
	validateDuration("shutdown finalizationMs", budget.finalizationMs);
	if (budget.finalizationMs > budget.totalMs) {
		throw new RangeError("shutdown finalizationMs cannot exceed totalMs");
	}
}

/**
 * Coordinates process shutdown through one finite state machine.
 *
 * The first termination signal determines the exit code. A later termination
 * signal forces that same code immediately, so signal races cannot make exit
 * status nondeterministic. Forced exit never clears or replaces durable facts;
 * restart recovery remains derived from facts persisted before shutdown.
 */
export class ShutdownCoordinator {
	private readonly activeControllers = new Set<AbortController>();
	private readonly budget: ShutdownBudget;
	private readonly clock: RuntimeClock;
	private completionPromise?: Promise<ShutdownResult>;
	private exitCode = 0;
	private exitIssued = false;
	private readonly failures: ShutdownFailure[] = [];
	private readonly options: ShutdownCoordinatorOptions;
	private request?: ShutdownRequest;
	private readonly signalHandlers = new Map<TerminationSignal, () => void>();
	private stateValue: ShutdownState = "accepting";

	constructor(options: ShutdownCoordinatorOptions) {
		this.options = options;
		this.budget = options.budget ?? DEFAULT_SHUTDOWN_BUDGET;
		validateBudget(this.budget);
		this.clock = options.clock ?? SYSTEM_RUNTIME_CLOCK;
	}

	get state(): ShutdownState {
		return this.stateValue;
	}

	get completion(): Promise<ShutdownResult> | undefined {
		return this.completionPromise;
	}

	installSignalHandlers(): void {
		if (this.signalHandlers.size > 0) return;
		const handlers = this.options.signalHandlers ?? PROCESS_SIGNAL_HANDLERS;
		const signals = this.options.terminationSignals ?? (
			process.platform === "win32"
				? (["SIGINT", "SIGTERM"] as const)
				: (["SIGINT", "SIGTERM", "SIGHUP"] as const)
		);
		for (const signal of signals) {
			if (this.signalHandlers.has(signal)) continue;
			const handler = (): void => {
				if (this.stateValue === "accepting") {
					void this.startShutdown({
						kind: "signal",
						signal,
						exitCode: terminationSignalExitCode(signal),
					});
					return;
				}
				if (this.request?.signal === undefined) {
					this.exitCode = terminationSignalExitCode(signal);
					this.request = Object.freeze({ kind: "signal", signal, exitCode: this.exitCode });
				}
				this.forceExit();
			};
			this.signalHandlers.set(signal, handler);
			handlers.add(signal, handler);
		}
	}

	removeSignalHandlers(): void {
		const handlers = this.options.signalHandlers ?? PROCESS_SIGNAL_HANDLERS;
		for (const [signal, handler] of this.signalHandlers) {
			handlers.remove(signal, handler);
		}
		this.signalHandlers.clear();
	}

	requestShutdown(exitCode = 0): Promise<ShutdownResult> {
		return this.startShutdown({ kind: "request", exitCode });
	}

	private startShutdown(request: ShutdownRequest): Promise<ShutdownResult> {
		if (this.completionPromise !== undefined) return this.completionPromise;
		if (this.stateValue !== "accepting") {
			return Promise.resolve(this.result());
		}
		this.request = Object.freeze({ ...request });
		this.exitCode = request.exitCode;
		const startedAt = this.clock.monotonicNow();
		this.transition("closing_admission");
		try {
			this.options.closeAdmission(this.request);
		} catch (error) {
			this.recordFailure({
				phase: "admission",
				resource: "admission",
				reason: "cleanup_failed",
				error,
			});
		}
		this.completionPromise = this.runShutdown(startedAt);
		return this.completionPromise;
	}

	private async runShutdown(startedAt: number): Promise<ShutdownResult> {
		const totalDeadlineAt = startedAt + this.budget.totalMs;
		const resourceDeadlineAt = totalDeadlineAt - this.budget.finalizationMs;
		if (this.isForced()) return this.result();

		this.transition("handing_off_recovery");
		if (this.options.handoffRecovery !== undefined) {
			await this.runBoundedCleanup(
				"recovery_handoff",
				"recovery_handoff",
				this.options.handoffRecovery,
				this.budget.resourceMs,
				resourceDeadlineAt,
			);
		}
		if (this.isForced()) return this.result();

		this.transition("cleaning_resources");
		for (const group of this.options.resourceGroups ?? []) {
			await Promise.all(group.map((resource) => this.runBoundedCleanup(
				"resource",
				resource.name,
				resource.cleanup,
				this.budget.resourceMs,
				resourceDeadlineAt,
			)));
			if (this.isForced()) return this.result();
		}

		this.transition("finalizing");
		if (this.options.finalize !== undefined) {
			await this.runBoundedCleanup(
				"finalization",
				"finalization",
				this.options.finalize,
				this.budget.finalizationMs,
				totalDeadlineAt,
			);
		}
		if (this.isForced()) return this.result();

		this.transition("completed");
		this.removeSignalHandlers();
		this.issueExit();
		return this.result();
	}

	private async runBoundedCleanup(
		phase: Exclude<ShutdownFailurePhase, "admission">,
		resource: string,
		cleanup: (signal: AbortSignal) => void | Promise<void>,
		maximumMs: number,
		deadlineAt: number,
	): Promise<void> {
		const remainingMs = Math.min(maximumMs, Math.max(0, deadlineAt - this.clock.monotonicNow()));
		if (remainingMs <= 0) {
			this.recordFailure({
				phase,
				resource,
				reason: "deadline_exceeded",
				error: new Error(`${resource} cleanup deadline exceeded`),
			});
			return;
		}

		const controller = new AbortController();
		this.activeControllers.add(controller);
		let timer: RuntimeTimerHandle | undefined;
		let deadlineExceeded = false;
		const deadlineError = new Error(`${resource} cleanup exceeded ${remainingMs}ms`);
		const timeoutOutcome = new Promise<CleanupOutcome>((resolve) => {
			timer = this.clock.setTimeout(() => {
				deadlineExceeded = true;
				controller.abort(deadlineError);
				resolve({ status: "deadline_exceeded", error: deadlineError });
			}, remainingMs);
		});

		let cleanupResult: void | Promise<void>;
		try {
			cleanupResult = cleanup(controller.signal);
		} catch (error) {
			cleanupResult = Promise.reject(error);
		}
		const cleanupOutcome = Promise.resolve(cleanupResult).then<CleanupOutcome, CleanupOutcome>(
			() => deadlineExceeded
				? { status: "deadline_exceeded", error: deadlineError }
				: { status: "succeeded" },
			(error: unknown) => deadlineExceeded
				? { status: "deadline_exceeded", error: deadlineError }
				: { status: "failed", error },
		);

		const outcome = await Promise.race([cleanupOutcome, timeoutOutcome]);
		if (timer !== undefined) this.clock.clearTimeout(timer);
		this.activeControllers.delete(controller);
		if (outcome.status === "failed") {
			this.recordFailure({ phase, resource, reason: "cleanup_failed", error: outcome.error });
		} else if (outcome.status === "deadline_exceeded") {
			this.recordFailure({ phase, resource, reason: "deadline_exceeded", error: outcome.error });
		}
	}

	private forceExit(): void {
		if (this.stateValue === "completed") return;
		if (this.stateValue !== "forced") {
			this.transition("forced");
			const error = new Error("Shutdown forced by a repeated termination signal");
			for (const controller of this.activeControllers) controller.abort(error);
		}
		this.removeSignalHandlers();
		this.issueExit();
	}

	private issueExit(): void {
		if (this.exitIssued) return;
		this.exitIssued = true;
		try {
			(this.options.exit ?? ((exitCode: number) => process.exit(exitCode)))(this.exitCode);
		} catch {
			// Tests and embedders may replace process.exit with a throwing sentinel.
		}
	}

	private recordFailure(failure: ShutdownFailure): void {
		const frozen = Object.freeze({ ...failure });
		this.failures.push(frozen);
		try {
			this.options.onFailure?.(frozen);
		} catch {
			// Diagnostics cannot become another shutdown dependency.
		}
	}

	private result(): ShutdownResult {
		return Object.freeze({
			state: this.stateValue === "forced" ? "forced" : "completed",
			exitCode: this.exitCode,
			failures: Object.freeze([...this.failures]),
		});
	}

	private isForced(): boolean {
		return this.stateValue === "forced";
	}

	private transition(next: ShutdownState): void {
		if (!STATE_TRANSITIONS[this.stateValue].includes(next)) {
			throw new Error(`Invalid shutdown state transition: ${this.stateValue} -> ${next}`);
		}
		this.stateValue = next;
	}
}
