import { performance } from "node:perf_hooks";

export type RuntimeTimerHandle = ReturnType<typeof setTimeout>;

export interface RuntimeClock {
	wallNow(): number;
	monotonicNow(): number;
	setTimeout(callback: () => void, delayMs: number): RuntimeTimerHandle;
	clearTimeout(handle: RuntimeTimerHandle): void;
	queueMicrotask(callback: () => void): void;
}

export const SYSTEM_RUNTIME_CLOCK: RuntimeClock = Object.freeze({
	wallNow: () => Date.now(),
	monotonicNow: () => performance.now(),
	setTimeout: (callback: () => void, delayMs: number) => setTimeout(callback, delayMs),
	clearTimeout: (handle: RuntimeTimerHandle) => clearTimeout(handle),
	queueMicrotask: (callback: () => void) => queueMicrotask(callback),
});
