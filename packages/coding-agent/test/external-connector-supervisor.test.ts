import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	ExternalConnectorBoundedSupervisor,
	FileExternalConnectorSupervisorPrivateStateStore,
	ExternalConnectorSupervisorError,
	externalConnectorProcessContainment,
	externalConnectorSupervisorFailure,
	type ExternalConnectorProcessController,
	type ExternalConnectorProcessHandle,
	type ExternalConnectorProcessIdentity,
	type ExternalConnectorProcessLaunchRequest,
	type ExternalConnectorProcessReattachResult,
	type ExternalConnectorProcessTerminationRequest,
	type ExternalConnectorProcessTerminationResult,
	type ExternalConnectorProcessTerminationOptions,
	type ExternalConnectorSupervisorLimits,
	type ExternalConnectorSupervisorSegment,
} from "../src/core/external-connector-supervisor.ts";
import type { RuntimeClock } from "../src/core/runtime-clock.ts";
import { DeterministicClock } from "./support/deterministic-clock.ts";

class ControlledHandle implements ExternalConnectorProcessHandle {
	readonly operationNonce: string;
	readonly detached = false as const;
	readonly containment: "process_group" | "job_object";
	readonly identity: ExternalConnectorProcessIdentity;
	readonly exited: Promise<void>;
	activationCalls = 0;
	activationGate: Promise<void> | undefined;
	activationAbortObserved = false;
	forceCalls = 0;
	resolveOnForce = true;
	terminationIdentity: ExternalConnectorProcessIdentity;
	boundedTermination:
		| ((
				request: ExternalConnectorProcessTerminationRequest,
				options: ExternalConnectorProcessTerminationOptions,
		  ) => Promise<ExternalConnectorProcessTerminationResult>)
		| undefined;
	#resolveExit: (() => void) | undefined;

	constructor(request: ExternalConnectorProcessLaunchRequest, identity: ExternalConnectorProcessIdentity) {
		this.operationNonce = request.operationNonce;
		this.containment = request.containment;
		this.identity = identity;
		this.terminationIdentity = identity;
		this.exited = new Promise<void>((resolve) => {
			this.#resolveExit = resolve;
		});
	}

	async activate(options?: { readonly signal?: AbortSignal }): Promise<void> {
		this.activationCalls += 1;
		if (this.activationGate !== undefined) {
			await Promise.race([
				this.activationGate,
				new Promise<never>((_resolve, reject) => {
					const abort = (): void => {
						this.activationAbortObserved = true;
						reject(new Error("activation aborted"));
					};
					if (options?.signal?.aborted === true) abort();
					else options?.signal?.addEventListener("abort", abort, { once: true });
				}),
			]);
		}
	}

	forceTerminate(request: ExternalConnectorProcessTerminationRequest): ExternalConnectorProcessTerminationResult {
		if (
			request.operationNonce !== this.operationNonce ||
			request.processIdentity.pid !== this.terminationIdentity.pid ||
			request.processIdentity.startToken !== this.terminationIdentity.startToken ||
			request.processIdentity.executableIdentity !== this.terminationIdentity.executableIdentity ||
			request.processIdentity.fileIdentity !== this.terminationIdentity.fileIdentity
		) {
			return "identity_mismatch";
		}
		this.forceCalls += 1;
		if (this.resolveOnForce) this.#resolveExit?.();
		return "termination_requested";
	}

	forceTerminateBounded(
		request: ExternalConnectorProcessTerminationRequest,
		options: ExternalConnectorProcessTerminationOptions,
	): Promise<ExternalConnectorProcessTerminationResult> {
		return this.boundedTermination?.(request, options) ?? Promise.resolve(this.forceTerminate(request));
	}
}

class ControlledProcessController implements ExternalConnectorProcessController {
	readonly identity: ExternalConnectorProcessIdentity = {
		pid: 3210,
		startToken: "start-token",
		executableIdentity: "vendor-executable",
		fileIdentity: "vendor-file",
	};
	lastHandle: ControlledHandle | undefined;
	launchGate: Promise<void> | undefined;
	launchAbortObserved = false;
	launchRequest: ExternalConnectorProcessLaunchRequest | undefined;
	reattachResult: ExternalConnectorProcessReattachResult | undefined;

	async launch(
		request: ExternalConnectorProcessLaunchRequest,
		options?: { readonly signal?: AbortSignal },
	): Promise<ExternalConnectorProcessHandle> {
		this.launchRequest = request;
		this.lastHandle = new ControlledHandle(request, this.identity);
		if (this.launchGate !== undefined) {
			await Promise.race([
				this.launchGate,
				new Promise<never>((_resolve, reject) => {
					const abort = (): void => {
						this.launchAbortObserved = true;
						this.lastHandle?.forceTerminate({
							operationNonce: request.operationNonce,
							processIdentity: this.identity,
						});
						reject(new Error("launch aborted"));
					};
					if (options?.signal?.aborted === true) abort();
					else options?.signal?.addEventListener("abort", abort, { once: true });
				}),
			]);
		}
		return this.lastHandle;
	}

	reattach(
		_identity: ExternalConnectorProcessIdentity,
		_request: ExternalConnectorProcessLaunchRequest,
	): ExternalConnectorProcessReattachResult {
		return (
			this.reattachResult ??
			(this.lastHandle === undefined ? { status: "not_found" } : { status: "attached", handle: this.lastHandle })
		);
	}
}

function supervisor(
	controller: ControlledProcessController,
	deadlines: Partial<Record<ExternalConnectorSupervisorSegment, { hardMs: number; idleMs: number }>> = {},
	artifactsAllowed = true,
	clock?: RuntimeClock,
	limits: Partial<ExternalConnectorSupervisorLimits> = {},
) {
	return new ExternalConnectorBoundedSupervisor({
		reference: { schemaVersion: 1, supervisorRef: "current-supervisor", operationNonce: "current-nonce" },
		containment: externalConnectorProcessContainment(),
		processController: controller,
		artifactsAllowed,
		deadlines: {
			start: { hardMs: 50, idleMs: 50 },
			event: { hardMs: 50, idleMs: 50 },
			receipt: { hardMs: 50, idleMs: 50 },
			cancel: { hardMs: 50, idleMs: 50 },
			dispose: { hardMs: 50, idleMs: 50 },
			...deadlines,
		},
		limits: {
			maxEvents: 2,
			maxEventsPerWindow: 2,
			eventRateWindowMs: 1_000,
			maxItemBytes: 512,
			maxTotalBytes: 1_024,
			maxArtifactRefs: 1,
			...limits,
		},
		...(clock === undefined ? {} : { clock }),
	});
}

const driverHandle = {
	externalSessionId: "external-session",
	externalTurnId: "external-turn",
	supervisorRef: "current-supervisor",
	operationNonce: "current-nonce",
} as const;

function event(
	type: "started" | "progress" | "heartbeat" | "artifact",
	extra: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		schemaVersion: 1,
		type,
		externalSessionId: driverHandle.externalSessionId,
		externalTurnId: driverHandle.externalTurnId,
		producedAt: "2026-08-27T00:00:00.000Z",
		...extra,
	};
}

function gate<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
	let resolve = (_value: T): void => {
		throw new Error("gate resolver is unavailable");
	};
	const promise = new Promise<T>((currentResolve) => {
		resolve = currentResolve;
	});
	return { promise, resolve };
}

async function drainPromiseJobs(): Promise<void> {
	for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

describe("current External Connector robust supervision", () => {
	it("selects process-group containment on Linux and macOS and Job containment on Windows", () => {
		expect(externalConnectorProcessContainment("linux")).toBe("process_group");
		expect(externalConnectorProcessContainment("darwin")).toBe("process_group");
		expect(externalConnectorProcessContainment("win32")).toBe("job_object");
		expect(() => externalConnectorProcessContainment("freebsd")).toThrow("unsupported");
	});

	for (const stage of ["launch", "private-state persistence", "activation"] as const) {
		for (const deadlineKind of ["hard", "idle"] as const) {
			it(`includes ${stage} inside the configured start ${deadlineKind} deadline`, async () => {
				const clock = new DeterministicClock();
				const controller = new ControlledProcessController();
				const blocked = gate<void>();
				if (stage === "launch") controller.launchGate = blocked.promise;
				const value = supervisor(
					controller,
					{
						start: deadlineKind === "hard" ? { hardMs: 5, idleMs: 50 } : { hardMs: 50, idleMs: 5 },
					},
					true,
					clock,
				);
				let persistenceCalls = 0;
				const launched = value.launch(async () => {
					persistenceCalls += 1;
					if (stage === "private-state persistence") await blocked.promise;
					if (stage === "activation") controller.lastHandle!.activationGate = blocked.promise;
				});
				await drainPromiseJobs();

				clock.advanceBy(5);
				await drainPromiseJobs();

				await expect(launched).rejects.toMatchObject({ segment: "start" });
				expect(controller.lastHandle?.forceCalls).toBe(1);
				expect(value.snapshot.cleaned).toBe(stage !== "launch");
				if (stage === "launch") expect(controller.launchAbortObserved).toBe(true);
				if (stage === "private-state persistence") expect(persistenceCalls).toBe(1);
				if (stage === "activation") expect(controller.lastHandle?.activationAbortObserved).toBe(true);
			});
		}
	}

	for (const segment of ["start", "receipt", "cancel"] as const) {
		for (const deadlineKind of ["hard", "idle"] as const) {
			it(`${segment} enforces its ${deadlineKind} deadline and force-terminates the contained process`, async () => {
				const controller = new ControlledProcessController();
				const value = supervisor(controller, {
					[segment]: deadlineKind === "hard" ? { hardMs: 5, idleMs: 50 } : { hardMs: 50, idleMs: 5 },
				});
				await value.launch(() => Promise.resolve());
				await expect(value.run(segment, () => new Promise<never>(() => undefined))).rejects.toMatchObject({
					code: "side_effect_unknown",
					segment,
					forcedTermination: true,
				});
				expect(controller.lastHandle?.forceCalls).toBe(1);
				expect(value.snapshot.cleaned).toBe(true);
			});
		}
	}

	it("honors cancel grace during an active start before exact forced containment", async () => {
		const clock = new DeterministicClock();
		const controller = new ControlledProcessController();
		const value = supervisor(
			controller,
			{
				start: { hardMs: 500, idleMs: 500 },
				cancel: { hardMs: 50, idleMs: 50 },
			},
			true,
			clock,
		);
		await value.launch(() => Promise.resolve());
		const cancellation = new AbortController();
		const running = value.run(
			"start",
			() => new Promise<never>(() => undefined),
			undefined,
			"opaque",
			undefined,
			cancellation.signal,
		);
		await drainPromiseJobs();

		cancellation.abort();
		await drainPromiseJobs();
		clock.advanceBy(49);
		await drainPromiseJobs();
		expect(controller.lastHandle?.forceCalls).toBe(0);
		clock.advanceBy(1);
		await drainPromiseJobs();

		await expect(running).rejects.toMatchObject({
			code: "side_effect_unknown",
			segment: "start",
			forcedTermination: true,
		});
		expect(controller.lastHandle?.forceCalls).toBe(1);
		expect(value.snapshot.cleaned).toBe(true);
	});

	it("event idle deadline resets only on bounded event progress", async () => {
		const controller = new ControlledProcessController();
		const value = supervisor(controller, { event: { hardMs: 50, idleMs: 5 } });
		await value.launch(() => Promise.resolve());
		async function* idleEvents(): AsyncGenerator<unknown> {
			await new Promise<never>(() => undefined);
		}
		await expect(value.consumeEvents(() => idleEvents(), driverHandle)).rejects.toMatchObject({ segment: "event" });
		expect(controller.lastHandle?.forceCalls).toBe(1);
	});

	it("event hard deadline remains bounded while progress refreshes the idle deadline", async () => {
		const controller = new ControlledProcessController();
		const value = supervisor(controller, { event: { hardMs: 12, idleMs: 8 } });
		await value.launch(() => Promise.resolve());
		async function* progressingEvents(): AsyncGenerator<unknown> {
			yield event("started");
			let sequence = 0;
			for (;;) {
				await new Promise((resolve) => setTimeout(resolve, 4));
				sequence += 1;
				yield event("progress", { sequence });
			}
		}
		await expect(value.consumeEvents(() => progressingEvents(), driverHandle)).rejects.toBeInstanceOf(
			ExternalConnectorSupervisorError,
		);
		expect(controller.lastHandle?.forceCalls).toBe(1);
	});

	it("lets a receipt run longer than the 30 second idle window while valid events remain active", async () => {
		const clock = new DeterministicClock();
		const controller = new ControlledProcessController();
		const value = supervisor(
			controller,
			{
				event: { hardMs: 120_000, idleMs: 30_000 },
				receipt: { hardMs: 120_000, idleMs: 30_000 },
			},
			true,
			clock,
			{ maxEvents: 4, maxEventsPerWindow: 4 },
		);
		await value.launch(() => Promise.resolve());
		const heartbeat = gate<void>();
		const progress = gate<void>();
		const eventsDone = gate<void>();
		const receipt = gate<{
			readonly externalSessionId: string;
			readonly externalTurnId: string;
			readonly operationNonce: string;
			readonly status: "succeeded";
			readonly sideEffectState: "none";
			readonly producedAt: string;
		}>();
		async function* activeEvents(): AsyncGenerator<unknown> {
			yield event("started");
			await heartbeat.promise;
			yield event("heartbeat", { sequence: 1 });
			await progress.promise;
			yield event("progress", { sequence: 1 });
			await eventsDone.promise;
		}
		const observed = value.consumeEvents(() => activeEvents(), driverHandle);
		const evidence = value.run("receipt", () => receipt.promise, undefined, "terminal_evidence");
		await drainPromiseJobs();

		clock.advanceBy(20_000);
		heartbeat.resolve(undefined);
		await drainPromiseJobs();
		clock.advanceBy(20_000);
		progress.resolve(undefined);
		await drainPromiseJobs();
		clock.advanceBy(20_000);
		eventsDone.resolve(undefined);
		receipt.resolve({
			externalSessionId: driverHandle.externalSessionId,
			externalTurnId: driverHandle.externalTurnId,
			operationNonce: driverHandle.operationNonce,
			status: "succeeded",
			sideEffectState: "none",
			producedAt: "2026-08-27T00:01:00.000Z",
		});
		await drainPromiseJobs();

		await expect(Promise.all([observed, evidence])).resolves.toMatchObject([undefined, { status: "succeeded" }]);
		expect(value.snapshot.eventCount).toBe(3);
		expect(controller.lastHandle?.forceCalls).toBe(0);
		await value.dispose();
	});

	it("terminates a stalled receipt and event stream after supervised activity stops", async () => {
		const clock = new DeterministicClock();
		const controller = new ControlledProcessController();
		const value = supervisor(
			controller,
			{
				event: { hardMs: 120_000, idleMs: 30_000 },
				receipt: { hardMs: 120_000, idleMs: 30_000 },
			},
			true,
			clock,
		);
		await value.launch(() => Promise.resolve());
		async function* stalledEvents(): AsyncGenerator<unknown> {
			yield event("started");
			await new Promise<never>(() => undefined);
		}
		const observed = value.consumeEvents(() => stalledEvents(), driverHandle);
		const evidence = value.run("receipt", () => new Promise<never>(() => undefined), undefined, "terminal_evidence");
		await drainPromiseJobs();

		clock.advanceBy(30_000);
		await drainPromiseJobs();

		const outcomes = await Promise.allSettled([observed, evidence]);
		expect(outcomes.every((outcome) => outcome.status === "rejected")).toBe(true);
		expect(controller.lastHandle?.forceCalls).toBe(1);
		expect(value.snapshot.cleaned).toBe(true);
	});

	it("dispose enforces both deadline bounds when force termination cannot be confirmed", async () => {
		for (const deadline of [
			{ hardMs: 5, idleMs: 50 },
			{ hardMs: 50, idleMs: 5 },
		]) {
			const controller = new ControlledProcessController();
			const value = supervisor(controller, { dispose: deadline });
			await value.launch(() => Promise.resolve());
			controller.lastHandle!.resolveOnForce = false;
			await expect(value.dispose()).rejects.toMatchObject({
				code: "reconcile_required",
				segment: "dispose",
			});
			expect(value.snapshot.quarantined).toBe(true);
		}
	});

	it("includes bounded identity termination in one disposal deadline and never accepts a late cleanup", async () => {
		const clock = new DeterministicClock();
		const controller = new ControlledProcessController();
		const value = supervisor(controller, { dispose: { hardMs: 5, idleMs: 50 } }, true, clock);
		await value.launch(() => Promise.resolve());
		const termination = gate<ExternalConnectorProcessTerminationResult>();
		let terminationSignal: AbortSignal | undefined;
		let terminationDeadlineMs: number | undefined;
		controller.lastHandle!.boundedTermination = async (_request, options) => {
			terminationSignal = options.signal;
			terminationDeadlineMs = options.deadlineMs;
			return termination.promise;
		};

		const disposing = value.dispose();
		await drainPromiseJobs();
		expect(terminationDeadlineMs).toBe(5);
		expect(terminationSignal?.aborted).toBe(false);

		clock.advanceBy(5);
		await drainPromiseJobs();
		await expect(disposing).rejects.toMatchObject({ code: "reconcile_required", segment: "dispose" });
		expect(terminationSignal?.aborted).toBe(true);
		expect(value.snapshot).toMatchObject({ cleaned: false, quarantined: true });
		expect(clock.pendingCount()).toBe(0);

		termination.resolve("termination_requested");
		await drainPromiseJobs();
		expect(value.snapshot.cleaned).toBe(false);
	});

	it("bounds event count, bytes, artifact refs, and rate before force termination", async () => {
		for (const events of [
			[event("started"), event("progress", { sequence: 1 }), event("progress", { sequence: 2 })],
			[
				event("started"),
				event("artifact", {
					artifact: {
						schemaVersion: 1,
						artifactId: "artifact-large",
						mediaType: "application/octet-stream",
						digest: `sha256:${"a".repeat(64)}`,
						producer: "x".repeat(600),
					},
				}),
			],
			[
				event("started"),
				event("artifact", {
					artifact: {
						schemaVersion: 1,
						artifactId: "artifact-1",
						mediaType: "text/plain",
						digest: `sha256:${"b".repeat(64)}`,
						sizeBytes: 1,
					},
				}),
				event("artifact", {
					artifact: {
						schemaVersion: 1,
						artifactId: "artifact-2",
						mediaType: "text/plain",
						digest: `sha256:${"c".repeat(64)}`,
						sizeBytes: 1,
					},
				}),
			],
		]) {
			const controller = new ControlledProcessController();
			const value = supervisor(controller);
			await value.launch(() => Promise.resolve());
			async function* source(): AsyncGenerator<unknown> {
				for (const event of events) yield event;
			}
			await expect(value.consumeEvents(() => source(), driverHandle)).rejects.toMatchObject({
				code: "external_resource_limit_exceeded",
				segment: "event",
			});
			expect(controller.lastHandle?.forceCalls).toBe(1);
		}
	});

	it("rejects exact event schema, identity, ordering, progress, and artifact capability violations", async () => {
		for (const testCase of [
			{ events: [event("progress", { sequence: 1 })], artifactsAllowed: true },
			{ events: [event("started"), event("started")], artifactsAllowed: true },
			{
				events: [event("started"), event("progress", { sequence: 2 }), event("progress", { sequence: 1 })],
				artifactsAllowed: true,
			},
			{
				events: [event("started"), event("heartbeat", { sequence: 2 }), event("heartbeat", { sequence: 1 })],
				artifactsAllowed: true,
			},
			{ events: [{ ...event("started"), externalSessionId: "different-session" }], artifactsAllowed: true },
			{ events: [{ ...event("started"), unknown: true }], artifactsAllowed: true },
			{
				events: [
					event("started"),
					event("artifact", {
						artifact: {
							schemaVersion: 1,
							artifactId: "artifact-1",
							mediaType: "text/plain",
							digest: `sha256:${"d".repeat(64)}`,
						},
					}),
				],
				artifactsAllowed: false,
			},
		]) {
			const controller = new ControlledProcessController();
			const value = supervisor(controller, {}, testCase.artifactsAllowed);
			await value.launch(() => Promise.resolve());
			async function* source(): AsyncGenerator<unknown> {
				for (const item of testCase.events) yield item;
			}
			await expect(value.consumeEvents(() => source(), driverHandle)).rejects.toMatchObject({
				code: "external_event_invalid",
				segment: "event",
			});
			expect(controller.lastHandle?.forceCalls).toBe(1);
		}
	});

	it("does not call an operation, events factory, or iterator for an already-aborted signal", async () => {
		const signal = AbortSignal.abort();
		const operationController = new ControlledProcessController();
		const operationSupervisor = supervisor(operationController);
		await operationSupervisor.launch(() => Promise.resolve());
		let operationCalls = 0;
		await expect(
			operationSupervisor.run(
				"start",
				async () => {
					operationCalls += 1;
				},
				signal,
			),
		).rejects.toBeInstanceOf(ExternalConnectorSupervisorError);
		expect(operationCalls).toBe(0);

		const eventController = new ControlledProcessController();
		const eventSupervisor = supervisor(eventController);
		await eventSupervisor.launch(() => Promise.resolve());
		let eventFactoryCalls = 0;
		let iteratorCalls = 0;
		await expect(
			eventSupervisor.consumeEvents(
				() => {
					eventFactoryCalls += 1;
					return {
						[Symbol.asyncIterator]: () => {
							iteratorCalls += 1;
							return { next: async () => ({ done: true, value: undefined }) };
						},
					};
				},
				driverHandle,
				signal,
			),
		).rejects.toBeInstanceOf(ExternalConnectorSupervisorError);
		expect(eventFactoryCalls).toBe(0);
		expect(iteratorCalls).toBe(0);
	});

	it("persists non-detached exact host-private identity and reattaches only that process", async () => {
		const controller = new ControlledProcessController();
		const first = supervisor(controller);
		const state = await first.launch(() => Promise.resolve());
		expect(controller.launchRequest).toMatchObject({
			detached: false,
			containment: externalConnectorProcessContainment(),
		});
		expect(state.processIdentity).toEqual(controller.identity);
		const restarted = supervisor(controller);
		restarted.reattach(state);
		expect(restarted.snapshot.phase).toBe("running");
		await restarted.dispose();
	});

	it("does not activate a launched process until private identity persistence succeeds", async () => {
		const controller = new ControlledProcessController();
		const value = supervisor(controller);
		await expect(value.launch(() => Promise.reject(new Error("private state write failed")))).rejects.toMatchObject({
			code: "reconcile_required",
			segment: "start",
		});
		expect(controller.lastHandle?.activationCalls).toBe(0);
		await value.dispose();
		expect(value.snapshot.cleaned).toBe(true);
	});

	it("reaps an exact orphan on restart", async () => {
		const controller = new ControlledProcessController();
		const first = supervisor(controller);
		const state = await first.launch(() => Promise.resolve());
		const restarted = supervisor(controller);
		await restarted.recoverAndReap(state);
		expect(controller.lastHandle?.forceCalls).toBe(1);
		expect(restarted.snapshot.cleaned).toBe(true);
	});

	it("quarantines PID reuse and ambiguous identity during orphan recovery without killing", async () => {
		for (const status of ["identity_mismatch", "ambiguous"] as const) {
			const controller = new ControlledProcessController();
			const first = supervisor(controller);
			const state = await first.launch(() => Promise.resolve());
			const unrelated = new ControlledHandle(controller.launchRequest!, {
				...controller.identity,
				startToken: "reused-pid-start-token",
			});
			controller.reattachResult =
				status === "ambiguous" ? { status: "ambiguous" } : { status: "attached", handle: unrelated };
			const restarted = supervisor(controller);
			await expect(restarted.recoverAndReap(state)).rejects.toBeInstanceOf(ExternalConnectorSupervisorError);
			expect(restarted.snapshot.quarantined).toBe(true);
			expect(restarted.snapshot.cleaned).toBe(false);
			expect(unrelated.forceCalls).toBe(0);
		}
	});

	it("keeps a missing guardian quarantined because descendants may remain", async () => {
		const controller = new ControlledProcessController();
		const first = supervisor(controller);
		const state = await first.launch(() => Promise.resolve());
		controller.reattachResult = { status: "not_found" };
		const restarted = supervisor(controller);

		await expect(restarted.recoverAndReap(state)).rejects.toBeInstanceOf(ExternalConnectorSupervisorError);

		expect(restarted.snapshot.quarantined).toBe(true);
		expect(restarted.snapshot.cleaned).toBe(false);
		expect(controller.lastHandle?.forceCalls).toBe(0);
	});

	it("rechecks exact nonce and process identity before force termination", async () => {
		const controller = new ControlledProcessController();
		const value = supervisor(controller);
		await value.launch(() => Promise.resolve());
		controller.lastHandle!.terminationIdentity = {
			...controller.identity,
			startToken: "pid-was-reused",
		};
		await expect(value.dispose()).rejects.toMatchObject({
			code: "reconcile_required",
			forcedTermination: true,
		});
		expect(controller.lastHandle?.forceCalls).toBe(0);
		expect(value.snapshot.quarantined).toBe(true);
	});

	it("persists exact identity in crash-safe private storage and rejects identity replacement", async () => {
		const root = mkdtempSync(join(tmpdir(), "aos-external-supervisor-"));
		const path = join(root, "private", "process-identities.json");
		try {
			const store = new FileExternalConnectorSupervisorPrivateStateStore(path);
			const controller = new ControlledProcessController();
			const state = await supervisor(controller).launch(() => Promise.resolve());
			await store.write("attempt-1", state);
			expect(await store.read("attempt-1")).toEqual(state);
			expect(await store.list()).toEqual([{ attemptId: "attempt-1", state }]);
			expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
				schemaVersion: 1,
				attempts: { "attempt-1": state },
			});
			if (process.platform !== "win32") {
				expect(statSync(path).mode & 0o777).toBe(0o600);
				expect(statSync(join(root, "private")).mode & 0o777).toBe(0o700);
			}
			writeFileSync(path, '{"schemaVersion":1,"attempts":');
			const restarted = new FileExternalConnectorSupervisorPrivateStateStore(path);
			expect(await restarted.read("attempt-1")).toEqual(state);
			expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
				schemaVersion: 1,
				attempts: { "attempt-1": state },
			});
			await expect(
				restarted.write("attempt-1", {
					...state,
					processIdentity: { ...state.processIdentity, startToken: "different-start" },
				}),
			).rejects.toThrow("identity conflict");
			await restarted.delete("attempt-1");
			expect(await restarted.read("attempt-1")).toBeUndefined();
			expect(await restarted.list()).toEqual([]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it.each(["external_frame_oversize", "external_process_identity_ambiguous"] as const)(
		"projects %s through the Foundation supervisor error contract",
		(code) => {
			const projected = externalConnectorSupervisorFailure(
				new ExternalConnectorSupervisorError(code, "event", false),
			);
			expect(projected.code).toBe(code);
			expect(projected.message).not.toContain("event");
			expect(projected.details).toEqual({ segment: "event" });
		},
	);
});
