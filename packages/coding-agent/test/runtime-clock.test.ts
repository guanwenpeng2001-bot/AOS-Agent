import { describe, expect, test } from "vitest";
import { SYSTEM_RUNTIME_CLOCK } from "../src/core/runtime-clock.ts";
import { DeterministicClock } from "./support/deterministic-clock.ts";

describe("runtime clock", () => {
	test("system clock exposes distinct wall and monotonic time domains", () => {
		expect(Number.isFinite(SYSTEM_RUNTIME_CLOCK.wallNow())).toBe(true);
		expect(Number.isFinite(SYSTEM_RUNTIME_CLOCK.monotonicNow())).toBe(true);
	});

	test("deterministically orders timers and drains microtasks after each timer", () => {
		const clock = new DeterministicClock({ wallTimeMs: 1_000, monotonicTimeMs: 20 });
		const events: string[] = [];
		clock.setTimeout(() => events.push("second"), 10);
		clock.setTimeout(() => {
			events.push("first");
			clock.queueMicrotask(() => events.push("microtask"));
		}, 5);
		clock.setTimeout(() => events.push("same-due-order"), 5);

		clock.advanceBy(5);
		expect(events).toEqual(["first", "microtask", "same-due-order"]);
		expect(clock.wallNow()).toBe(1_005);
		expect(clock.monotonicNow()).toBe(25);
		expect(clock.pendingCount()).toBe(1);

		clock.flush();
		expect(events).toEqual(["first", "microtask", "same-due-order", "second"]);
		expect(clock.pendingCount()).toBe(0);
	});

	test("cancels timers and allows wall time to change without moving monotonic time", () => {
		const clock = new DeterministicClock({ wallTimeMs: 100, monotonicTimeMs: 7 });
		let called = false;
		const handle = clock.setTimeout(() => {
			called = true;
		}, 1);
		clock.clearTimeout(handle);
		clock.setWallTime(4_000);
		clock.flush();
		expect(called).toBe(false);
		expect(clock.wallNow()).toBe(4_000);
		expect(clock.monotonicNow()).toBe(7);
	});

	test("advances through due times so nested timers remain relative to their callback", () => {
		const clock = new DeterministicClock();
		const events: number[] = [];
		clock.setTimeout(() => {
			events.push(clock.monotonicNow());
			clock.setTimeout(() => events.push(clock.monotonicNow()), 1);
		}, 5);
		clock.advanceTo(10);
		expect(events).toEqual([5, 6]);
		expect(clock.monotonicNow()).toBe(10);
	});

	test("rejects runaway self-scheduling work", () => {
		const clock = new DeterministicClock({ runawayLimit: 3 });
		const schedule = (): void => clock.queueMicrotask(schedule);
		schedule();
		expect(() => clock.flush()).toThrow("deterministic clock exceeded runaway limit 3");
	});
});
