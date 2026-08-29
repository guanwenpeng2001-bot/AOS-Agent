import { describe, expect, it } from "vitest";
import {
	CurrentSessionScope,
	type SessionScopeTransitionOptions,
} from "../src/core/session/current-scope.ts";

interface TestScope {
	id: "old" | "candidate";
	disposed: boolean;
}

function createScope(id: TestScope["id"]): TestScope {
	return { id, disposed: false };
}

function transitionOptions(
	candidate: TestScope,
): SessionScopeTransitionOptions<TestScope> {
	return {
		construct: () => candidate,
		validate: () => undefined,
		checkReadiness: () => undefined,
		prepareRebind: () => ({ commit: () => undefined }),
		disposeCandidate: (scope) => {
			scope.disposed = true;
		},
		disposePrevious: (scope) => {
			scope.disposed = true;
		},
	};
}

describe("CurrentSessionScope", () => {
	it("preserves the current scope when candidate construction fails", async () => {
		const old = createScope("old");
		const current = new CurrentSessionScope(old);
		const options = transitionOptions(createScope("candidate"));

		await expect(current.replace({
			...options,
			construct: () => {
				throw new Error("construction fault");
			},
		})).rejects.toThrow("construction fault");

		expect(current.current).toBe(old);
		expect(old.disposed).toBe(false);
	});

	it.each([
		["validation", (options: SessionScopeTransitionOptions<TestScope>) => ({
			...options,
			validate: () => {
				throw new Error("validation fault");
			},
		})],
		["readiness", (options: SessionScopeTransitionOptions<TestScope>) => ({
			...options,
			checkReadiness: () => {
				throw new Error("readiness fault");
			},
		})],
		["rebind preparation", (options: SessionScopeTransitionOptions<TestScope>) => ({
			...options,
			prepareRebind: () => {
				throw new Error("rebind preparation fault");
			},
		})],
		["commit", (options: SessionScopeTransitionOptions<TestScope>) => ({
			...options,
			beforeCommit: () => {
				throw new Error("commit fault");
			},
		})],
	] as const)("cleans the candidate and preserves the old scope after a %s fault", async (_phase, injectFault) => {
		const old = createScope("old");
		const candidate = createScope("candidate");
		const current = new CurrentSessionScope(old);

		await expect(current.replace(injectFault(transitionOptions(candidate)))).rejects.toThrow(`${_phase} fault`);

		expect(current.current).toBe(old);
		expect(old.disposed).toBe(false);
		expect(candidate.disposed).toBe(true);
	});

	it("treats a throwing prepared commit as a rollback-safe pre-commit failure", async () => {
		const old = createScope("old");
		const candidate = createScope("candidate");
		const current = new CurrentSessionScope(old);

		await expect(current.replace({
			...transitionOptions(candidate),
			prepareRebind: () => ({
				commit: () => {
					throw new Error("prepared commit fault");
				},
			}),
		})).rejects.toThrow("prepared commit fault");

		expect(current.current).toBe(old);
		expect(old.disposed).toBe(false);
		expect(candidate.disposed).toBe(true);
	});

	it("reports candidate cleanup faults without publishing the candidate", async () => {
		const old = createScope("old");
		const candidate = createScope("candidate");
		const current = new CurrentSessionScope(old);

		let failure: unknown;
		try {
			await current.replace({
				...transitionOptions(candidate),
				validate: () => {
					throw new Error("validation fault");
				},
				disposeCandidate: () => {
					throw new Error("candidate cleanup fault");
				},
			});
		} catch (error) {
			failure = error;
		}

		expect(failure).toBeInstanceOf(AggregateError);
		expect((failure as AggregateError).errors).toEqual([
			expect.objectContaining({ message: "validation fault" }),
			expect.objectContaining({ message: "candidate cleanup fault" }),
		]);
		expect(current.current).toBe(old);
		expect(old.disposed).toBe(false);
	});

	it("attempts prepared-host and Session cleanup after a pre-commit fault", async () => {
		const old = createScope("old");
		const candidate = createScope("candidate");
		const current = new CurrentSessionScope(old);

		let failure: unknown;
		try {
			await current.replace({
				...transitionOptions(candidate),
				prepareRebind: () => ({
					commit: () => undefined,
					disposeCandidate: () => {
						throw new Error("prepared host cleanup fault");
					},
				}),
				beforeCommit: () => {
					throw new Error("commit gate fault");
				},
				disposeCandidate: () => {
					throw new Error("candidate Session cleanup fault");
				},
			});
		} catch (error) {
			failure = error;
		}

		expect(failure).toBeInstanceOf(AggregateError);
		expect((failure as AggregateError).errors).toEqual([
			expect.objectContaining({ message: "commit gate fault" }),
			expect.objectContaining({ message: "prepared host cleanup fault" }),
			expect.objectContaining({ message: "candidate Session cleanup fault" }),
		]);
		expect(current.current).toBe(old);
		expect(old.disposed).toBe(false);
	});

	it("keeps the committed candidate current when old cleanup fails", async () => {
		const old = createScope("old");
		const candidate = createScope("candidate");
		const current = new CurrentSessionScope(old);

		const result = await current.replace({
			...transitionOptions(candidate),
			disposePrevious: () => {
				throw new Error("old cleanup fault");
			},
		});

		expect(current.current).toBe(candidate);
		expect(candidate.disposed).toBe(false);
		expect(result.postCommitFailures).toEqual([
			{
				phase: "old_scope_cleanup",
				error: expect.objectContaining({ message: "old cleanup fault" }),
			},
		]);
	});

	it("runs host cleanup before Session cleanup and attempts both after a host fault", async () => {
		const old = createScope("old");
		const candidate = createScope("candidate");
		const current = new CurrentSessionScope(old);
		const cleanupOrder: string[] = [];
		let hostSignal: AbortSignal | undefined;
		let sessionSignal: AbortSignal | undefined;

		const result = await current.replace({
			...transitionOptions(candidate),
			prepareRebind: () => ({
				commit: () => undefined,
				disposePrevious: (signal) => {
					hostSignal = signal;
					cleanupOrder.push("host");
					throw new Error("host cleanup fault");
				},
			}),
			disposePrevious: (_previous, signal) => {
				sessionSignal = signal;
				cleanupOrder.push("Session");
				throw new Error("Session cleanup fault");
			},
		});

		expect(cleanupOrder).toEqual(["host", "Session"]);
		expect(hostSignal).not.toBe(sessionSignal);
		expect(current.current).toBe(candidate);
		expect(result.postCommitFailures).toEqual([
			{
				phase: "old_scope_cleanup",
				error: expect.objectContaining({
					errors: [
						expect.objectContaining({ message: "host cleanup fault" }),
						expect.objectContaining({ message: "Session cleanup fault" }),
					],
				}),
			},
		]);
	});

	it("does not begin Session disposal until asynchronous host settlement completes", async () => {
		const old = createScope("old");
		const candidate = createScope("candidate");
		const current = new CurrentSessionScope(old);
		const cleanupOrder: string[] = [];
		let markHostSettlementStarted: (() => void) | undefined;
		let releaseHostSettlement: (() => void) | undefined;
		const hostSettlementStarted = new Promise<void>((resolve) => {
			markHostSettlementStarted = resolve;
		});
		const hostSettlement = new Promise<void>((resolve) => {
			releaseHostSettlement = resolve;
		});

		const replacement = current.replace({
			...transitionOptions(candidate),
			prepareRebind: () => ({
				commit: () => undefined,
				disposePrevious: async () => {
					cleanupOrder.push("host settlement start");
					markHostSettlementStarted?.();
					await hostSettlement;
					cleanupOrder.push("host settlement complete");
				},
			}),
			disposePrevious: () => {
				cleanupOrder.push("Session dispose");
			},
		});
		await hostSettlementStarted;

		expect(current.current).toBe(candidate);
		expect(cleanupOrder).toEqual(["host settlement start"]);
		releaseHostSettlement?.();
		await replacement;

		expect(cleanupOrder).toEqual([
			"host settlement start",
			"host settlement complete",
			"Session dispose",
		]);
	});

	it("bounds old cleanup without rolling back the committed candidate", async () => {
		const old = createScope("old");
		const candidate = createScope("candidate");
		const current = new CurrentSessionScope(old);

		const result = await current.replace({
			...transitionOptions(candidate),
			disposePrevious: () => new Promise<void>(() => undefined),
			oldCleanupTimeoutMs: 1,
		});

		expect(current.current).toBe(candidate);
		expect(result.postCommitFailures[0]?.phase).toBe("old_scope_cleanup");
		expect(result.postCommitFailures[0]?.error).toEqual(
			expect.objectContaining({ message: "Old Session disposal exceeded 1ms" }),
		);
	});

	it("attempts bounded Session disposal after host cleanup ignores cancellation", async () => {
		const old = createScope("old");
		const candidate = createScope("candidate");
		const current = new CurrentSessionScope(old);
		let sessionDisposeCalls = 0;

		const result = await current.replace({
			...transitionOptions(candidate),
			prepareRebind: () => ({
				commit: () => undefined,
				disposePrevious: () => new Promise<void>(() => undefined),
			}),
			disposePrevious: () => {
				sessionDisposeCalls += 1;
				old.disposed = true;
			},
			oldCleanupTimeoutMs: 1,
		});

		expect(sessionDisposeCalls).toBe(1);
		expect(old.disposed).toBe(true);
		expect(current.current).toBe(candidate);
		expect(result.postCommitFailures).toContainEqual({
			phase: "old_scope_cleanup",
			error: expect.objectContaining({ message: "Old host cleanup exceeded 1ms" }),
		});
	});

	it("reports candidate activation faults without rolling back the committed candidate", async () => {
		const old = createScope("old");
		const candidate = createScope("candidate");
		const current = new CurrentSessionScope(old);

		const result = await current.replace({
			...transitionOptions(candidate),
			prepareRebind: () => ({
				commit: () => undefined,
				activate: () => {
					throw new Error("candidate activation fault");
				},
			}),
		});

		expect(current.current).toBe(candidate);
		expect(old.disposed).toBe(true);
		expect(result.postCommitFailures).toEqual([
			{
				phase: "candidate_activation",
				error: expect.objectContaining({ message: "candidate activation fault" }),
			},
		]);
	});

	it("exposes exactly one whole current scope across the commit", async () => {
		const old = createScope("old");
		const candidate = createScope("candidate");
		const current = new CurrentSessionScope(old);
		let releaseReadiness: (() => void) | undefined;
		const readiness = new Promise<void>((resolve) => {
			releaseReadiness = resolve;
		});
		const observations: TestScope[] = [];

		const replacement = current.replace({
			...transitionOptions(candidate),
			validate: () => {
				observations.push(current.current);
			},
			checkReadiness: async () => {
				observations.push(current.current);
				await readiness;
				observations.push(current.current);
			},
			prepareRebind: () => {
				observations.push(current.current);
				return {
					commit: () => {
						observations.push(current.current);
					},
				};
			},
			beforeCommit: () => {
				observations.push(current.current);
			},
		});
		await Promise.resolve();
		await Promise.resolve();
		expect(current.current).toBe(old);
		releaseReadiness?.();
		await replacement;
		observations.push(current.current);

		expect(observations).toEqual([old, old, old, old, old, old, candidate]);
		expect(new Set(observations)).toEqual(new Set([old, candidate]));
	});
});
