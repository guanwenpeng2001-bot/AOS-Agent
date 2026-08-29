import { describe, expect, test, vi } from "vitest";
import {
	ShutdownCoordinator,
	type ShutdownSignalHandlers,
	type TerminationSignal,
	terminationSignalExitCode,
} from "../src/core/runtime/shutdown-coordinator.ts";
import { DeterministicClock } from "./support/deterministic-clock.ts";

class FakeSignalHandlers implements ShutdownSignalHandlers {
	private readonly handlers = new Map<TerminationSignal, Set<() => void>>();

	add(signal: TerminationSignal, handler: () => void): void {
		let listeners = this.handlers.get(signal);
		if (listeners === undefined) {
			listeners = new Set();
			this.handlers.set(signal, listeners);
		}
		listeners.add(handler);
	}

	remove(signal: TerminationSignal, handler: () => void): void {
		const listeners = this.handlers.get(signal);
		listeners?.delete(handler);
		if (listeners?.size === 0) this.handlers.delete(signal);
	}

	emit(signal: TerminationSignal): void {
		for (const handler of [...(this.handlers.get(signal) ?? [])]) handler();
	}

	listenerCount(): number {
		return [...this.handlers.values()].reduce((total, listeners) => total + listeners.size, 0);
	}
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
	let resolvePromise: (() => void) | undefined;
	const promise = new Promise<void>((resolve) => {
		resolvePromise = resolve;
	});
	return { promise, resolve: () => resolvePromise?.() };
}

async function drainPromises(): Promise<void> {
	for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
}

describe("ShutdownCoordinator", () => {
	test("uses stable documented termination exit codes", () => {
		expect(terminationSignalExitCode("SIGHUP")).toBe(129);
		expect(terminationSignalExitCode("SIGINT")).toBe(130);
		expect(terminationSignalExitCode("SIGTERM")).toBe(143);
	});

	test("the first signal fences admission, orders phases, and cleans listeners", async () => {
		const signalHandlers = new FakeSignalHandlers();
		const exit = vi.fn<(exitCode: number) => void>();
		const firstResource = deferred();
		const order: string[] = [];
		const coordinator = new ShutdownCoordinator({
			signalHandlers,
			terminationSignals: ["SIGINT", "SIGTERM", "SIGHUP"],
			closeAdmission: (request) => {
				order.push(`admission:${request.signal}`);
			},
			handoffRecovery: () => {
				order.push("recovery");
			},
			resourceGroups: [
				[
					{
						name: "first",
						cleanup: async () => {
							order.push("first:start");
							await firstResource.promise;
							order.push("first:end");
						},
					},
					{
						name: "independent",
						cleanup: () => {
							order.push("independent");
						},
					},
				],
				[{
					name: "ordered",
					cleanup: () => {
						order.push("ordered");
					},
				}],
			],
			finalize: () => {
				order.push("finalize");
			},
			exit,
		});

		coordinator.installSignalHandlers();
		expect(signalHandlers.listenerCount()).toBe(3);
		signalHandlers.emit("SIGINT");
		await drainPromises();

		expect(order).toEqual(["admission:SIGINT", "recovery", "first:start", "independent"]);
		expect(coordinator.state).toBe("cleaning_resources");
		expect(exit).not.toHaveBeenCalled();

		firstResource.resolve();
		const result = await coordinator.completion;

		expect(order).toEqual([
			"admission:SIGINT",
			"recovery",
			"first:start",
			"independent",
			"first:end",
			"ordered",
			"finalize",
		]);
		expect(result).toEqual({ state: "completed", exitCode: 130, failures: [] });
		expect(exit).toHaveBeenCalledExactlyOnceWith(130);
		expect(signalHandlers.listenerCount()).toBe(0);
	});

	test("a repeated signal forces the first signal's exit code and preserves recovery facts", async () => {
		const clock = new DeterministicClock();
		const signalHandlers = new FakeSignalHandlers();
		const exit = vi.fn<(exitCode: number) => void>();
		const durableFacts = ["attempt", "start_intent", "mapping"];
		let resourceStarted = false;
		const coordinator = new ShutdownCoordinator({
			clock,
			signalHandlers,
			terminationSignals: ["SIGINT", "SIGTERM"],
			budget: { totalMs: 50, resourceMs: 40, finalizationMs: 10 },
			closeAdmission: () => {},
			handoffRecovery: () => {
				durableFacts.push("reconcile_required");
				return new Promise<void>(() => {});
			},
			resourceGroups: [[{
				name: "must_not_start_after_force",
				cleanup: () => {
					resourceStarted = true;
				},
			}]],
			exit,
		});
		coordinator.installSignalHandlers();

		signalHandlers.emit("SIGTERM");
		expect(coordinator.state).toBe("handing_off_recovery");
		expect(durableFacts).toEqual(["attempt", "start_intent", "mapping", "reconcile_required"]);

		signalHandlers.emit("SIGINT");
		expect(coordinator.state).toBe("forced");
		expect(exit).toHaveBeenCalledExactlyOnceWith(143);
		expect(durableFacts).toEqual(["attempt", "start_intent", "mapping", "reconcile_required"]);
		expect(signalHandlers.listenerCount()).toBe(0);

		clock.advanceBy(40);
		await drainPromises();
		expect(await coordinator.completion).toMatchObject({ state: "forced", exitCode: 143 });
		expect(resourceStarted).toBe(false);
	});

	test("enforces the total deadline while isolating cleanup failures and non-cooperative resources", async () => {
		const clock = new DeterministicClock();
		const exit = vi.fn<(exitCode: number) => void>();
		const reported: string[] = [];
		const aborts: string[] = [];
		const order: string[] = [];
		const neverSettles = (name: string) => (signal: AbortSignal): Promise<void> => {
			order.push(`${name}:start`);
			signal.addEventListener("abort", () => aborts.push(name), { once: true });
			return new Promise<void>(() => {});
		};
		const coordinator = new ShutdownCoordinator({
			clock,
			budget: { totalMs: 100, resourceMs: 60, finalizationMs: 20 },
			closeAdmission: () => {
				order.push("admission");
			},
			resourceGroups: [
				[
					{ name: "stuck_first", cleanup: neverSettles("stuck_first") },
					{
						name: "throws",
						cleanup: () => {
							order.push("throws");
							throw new Error("cleanup fault");
						},
					},
					{
						name: "independent_success",
						cleanup: () => {
							order.push("independent_success");
						},
					},
				],
				[{ name: "stuck_second", cleanup: neverSettles("stuck_second") }],
			],
			finalize: neverSettles("finalization"),
			onFailure: (failure) => reported.push(`${failure.resource}:${failure.reason}`),
			exit,
		});

		const completion = coordinator.requestShutdown();
		await drainPromises();
		expect(order).toEqual(["admission", "stuck_first:start", "throws", "independent_success"]);

		clock.advanceBy(60);
		await drainPromises();
		expect(order).toContain("stuck_second:start");
		clock.advanceBy(20);
		await drainPromises();
		expect(order).toContain("finalization:start");
		clock.advanceBy(20);
		await drainPromises();

		const result = await completion;
		expect(clock.monotonicNow()).toBe(100);
		expect(aborts).toEqual(["stuck_first", "stuck_second", "finalization"]);
		expect(reported).toEqual([
			"throws:cleanup_failed",
			"stuck_first:deadline_exceeded",
			"stuck_second:deadline_exceeded",
			"finalization:deadline_exceeded",
		]);
		expect(result.failures.map(({ resource, reason }) => `${resource}:${reason}`)).toEqual(reported);
		expect(result.state).toBe("completed");
		expect(exit).toHaveBeenCalledExactlyOnceWith(0);
		expect(clock.pendingCount()).toBe(0);
	});

	test("rejects infinite or internally inconsistent budgets", () => {
		expect(() => new ShutdownCoordinator({
			closeAdmission: () => {},
			budget: { totalMs: Number.POSITIVE_INFINITY, resourceMs: 1, finalizationMs: 1 },
		})).toThrow("shutdown totalMs must be a non-negative safe integer");
		expect(() => new ShutdownCoordinator({
			closeAdmission: () => {},
			budget: { totalMs: 5, resourceMs: 1, finalizationMs: 6 },
		})).toThrow("shutdown finalizationMs cannot exceed totalMs");
	});
});
