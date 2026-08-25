import type { RuntimeClock, RuntimeTimerHandle } from "../../src/core/runtime-clock.ts";

interface ScheduledTimer {
	readonly id: number;
	readonly dueAt: number;
	readonly callback: () => void;
	cancelled: boolean;
}

export interface DeterministicClockOptions {
	readonly wallTimeMs?: number;
	readonly monotonicTimeMs?: number;
	readonly runawayLimit?: number;
}

export class DeterministicClock implements RuntimeClock {
	private wallTimeMs: number;
	private monotonicTimeMs: number;
	private readonly runawayLimit: number;
	private nextTimerId = 1;
	private readonly timers = new Map<number, ScheduledTimer>();
	private readonly microtasks: Array<() => void> = [];

	constructor(options: DeterministicClockOptions = {}) {
		this.wallTimeMs = options.wallTimeMs ?? 0;
		this.monotonicTimeMs = options.monotonicTimeMs ?? 0;
		this.runawayLimit = options.runawayLimit ?? 10_000;
		if (!Number.isFinite(this.wallTimeMs) || !Number.isFinite(this.monotonicTimeMs)) {
			throw new Error("deterministic clock times must be finite");
		}
		if (!Number.isSafeInteger(this.runawayLimit) || this.runawayLimit < 1) {
			throw new Error("deterministic clock runawayLimit must be a positive safe integer");
		}
	}

	wallNow(): number {
		return this.wallTimeMs;
	}

	monotonicNow(): number {
		return this.monotonicTimeMs;
	}

	setTimeout(callback: () => void, delayMs: number): RuntimeTimerHandle {
		if (!Number.isFinite(delayMs)) throw new Error("deterministic timer delay must be finite");
		const timer: ScheduledTimer = {
			id: this.nextTimerId++,
			dueAt: this.monotonicTimeMs + Math.max(0, delayMs),
			callback,
			cancelled: false,
		};
		this.timers.set(timer.id, timer);
		return timer.id as unknown as RuntimeTimerHandle;
	}

	clearTimeout(handle: RuntimeTimerHandle): void {
		const id = handle as unknown as number;
		const timer = this.timers.get(id);
		if (timer) timer.cancelled = true;
		this.timers.delete(id);
	}

	unrefTimeout(_handle: RuntimeTimerHandle): void {}

	queueMicrotask(callback: () => void): void {
		this.microtasks.push(callback);
	}

	pendingCount(): number {
		return this.timers.size + this.microtasks.length;
	}

	setWallTime(wallTimeMs: number): void {
		if (!Number.isFinite(wallTimeMs)) throw new Error("deterministic wall time must be finite");
		this.wallTimeMs = wallTimeMs;
	}

	advanceBy(delayMs: number): void {
		if (!Number.isFinite(delayMs) || delayMs < 0) {
			throw new Error("deterministic clock advance must be a finite non-negative number");
		}
		this.advanceTo(this.monotonicTimeMs + delayMs);
	}

	advanceTo(monotonicTimeMs: number): void {
		if (!Number.isFinite(monotonicTimeMs) || monotonicTimeMs < this.monotonicTimeMs) {
			throw new Error("deterministic clock cannot move monotonic time backwards");
		}
		let executions = this.drainMicrotasks(0);
		for (;;) {
			const timer = this.nextTimer();
			if (!timer || timer.dueAt > monotonicTimeMs) break;
			const delta = Math.max(0, timer.dueAt - this.monotonicTimeMs);
			this.monotonicTimeMs += delta;
			this.wallTimeMs += delta;
			executions = this.runTimer(timer, executions);
			executions = this.drainMicrotasks(executions);
		}
		const finalDelta = monotonicTimeMs - this.monotonicTimeMs;
		this.monotonicTimeMs = monotonicTimeMs;
		this.wallTimeMs += finalDelta;
	}

	flush(): void {
		let executions = 0;
		while (this.pendingCount() > 0) {
			executions = this.drainMicrotasks(executions);
			const timer = this.nextTimer();
			if (!timer) return;
			const delta = Math.max(0, timer.dueAt - this.monotonicTimeMs);
			this.monotonicTimeMs += delta;
			this.wallTimeMs += delta;
			executions = this.runTimer(timer, executions);
		}
	}

	private drainMicrotasks(executions: number): number {
		let count = executions;
		while (this.microtasks.length > 0) {
			this.guardRunaway(++count);
			this.microtasks.shift()!();
		}
		return count;
	}

	private runTimer(timer: ScheduledTimer, executions: number): number {
		this.timers.delete(timer.id);
		if (timer.cancelled) return executions;
		const count = executions + 1;
		this.guardRunaway(count);
		timer.callback();
		return count;
	}

	private nextTimer(): ScheduledTimer | undefined {
		return [...this.timers.values()].sort((left, right) => left.dueAt - right.dueAt || left.id - right.id)[0];
	}

	private guardRunaway(executions: number): void {
		if (executions > this.runawayLimit) {
			throw new Error(`deterministic clock exceeded runaway limit ${this.runawayLimit}`);
		}
	}
}
