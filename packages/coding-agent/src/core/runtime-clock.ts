import { performance } from "node:perf_hooks";

export type RuntimeTimerHandle = ReturnType<typeof setTimeout>;

export interface RuntimeClock {
	wallNow(): number;
	monotonicNow(): number;
	setTimeout(callback: () => void, delayMs: number): RuntimeTimerHandle;
	clearTimeout(handle: RuntimeTimerHandle): void;
	unrefTimeout(handle: RuntimeTimerHandle): void;
	queueMicrotask(callback: () => void): void;
}

export const SYSTEM_RUNTIME_CLOCK: RuntimeClock = Object.freeze({
	wallNow: () => Date.now(),
	monotonicNow: () => performance.now(),
	setTimeout: (callback: () => void, delayMs: number) => setTimeout(callback, delayMs),
	clearTimeout: (handle: RuntimeTimerHandle) => clearTimeout(handle),
	unrefTimeout: (handle: RuntimeTimerHandle) => handle.unref(),
	queueMicrotask: (callback: () => void) => queueMicrotask(callback),
});

const RUNTIME_CLOCK = Symbol("schedulerRuntimeClock");

interface RuntimeClockCarrier {
	readonly [RUNTIME_CLOCK]?: RuntimeClock;
}

/** @internal Private constructor-options seam; intentionally absent from package barrels. */
export function withRuntimeClock<T extends object>(options: T, clock: RuntimeClock): T {
	return Object.assign({}, options, { [RUNTIME_CLOCK]: clock });
}

/** @internal Resolve the private constructor-options seam with the production clock as default. */
export function runtimeClockFor(options: object): RuntimeClock {
	return (options as RuntimeClockCarrier)[RUNTIME_CLOCK] ?? SYSTEM_RUNTIME_CLOCK;
}
