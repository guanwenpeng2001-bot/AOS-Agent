import { describe, expect, it } from "vitest";
import {
	ExternalConnectorBoundedSupervisor,
	ExternalConnectorSupervisorError,
	type ExternalConnectorProcessController,
	type ExternalConnectorProcessHandle,
	type ExternalConnectorProcessIdentity,
	type ExternalConnectorProcessLaunchRequest,
	type ExternalConnectorProcessReattachResult,
	type ExternalConnectorSupervisorSegment,
} from "../src/core/external-connector-supervisor.ts";

class ControlledHandle implements ExternalConnectorProcessHandle {
	readonly operationNonce: string;
	readonly detached = false as const;
	readonly containment = "process_group" as const;
	readonly identity: ExternalConnectorProcessIdentity;
	readonly exited: Promise<void>;
	forceCalls = 0;
	resolveOnForce = true;
	#resolveExit: (() => void) | undefined;

	constructor(request: ExternalConnectorProcessLaunchRequest, identity: ExternalConnectorProcessIdentity) {
		this.operationNonce = request.operationNonce;
		this.identity = identity;
		this.exited = new Promise<void>((resolve) => {
			this.#resolveExit = resolve;
		});
	}

	forceTerminate(): void {
		this.forceCalls += 1;
		if (this.resolveOnForce) this.#resolveExit?.();
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
	launchRequest: ExternalConnectorProcessLaunchRequest | undefined;
	reattachResult: ExternalConnectorProcessReattachResult | undefined;

	launch(request: ExternalConnectorProcessLaunchRequest): ExternalConnectorProcessHandle {
		this.launchRequest = request;
		this.lastHandle = new ControlledHandle(request, this.identity);
		return this.lastHandle;
	}

	reattach(
		_identity: ExternalConnectorProcessIdentity,
		_request: ExternalConnectorProcessLaunchRequest,
	): ExternalConnectorProcessReattachResult {
		return this.reattachResult ?? (this.lastHandle === undefined
			? { status: "not_found" }
			: { status: "attached", handle: this.lastHandle });
	}
}

function supervisor(
	controller: ControlledProcessController,
	deadlines: Partial<Record<ExternalConnectorSupervisorSegment, { hardMs: number; idleMs: number }>> = {},
) {
	return new ExternalConnectorBoundedSupervisor({
		reference: { schemaVersion: 1, supervisorRef: "current-supervisor", operationNonce: "current-nonce" },
		containment: "process_group",
		processController: controller,
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
			maxItemBytes: 32,
			maxTotalBytes: 64,
			maxArtifactRefs: 1,
		},
	});
}

describe("current External Connector robust supervision", () => {
	for (const segment of ["start", "receipt", "cancel"] as const) {
		for (const deadlineKind of ["hard", "idle"] as const) {
			it(`${segment} enforces its ${deadlineKind} deadline and force-terminates the process group`, async () => {
				const controller = new ControlledProcessController();
				const value = supervisor(controller, {
					[segment]: deadlineKind === "hard"
						? { hardMs: 5, idleMs: 50 }
						: { hardMs: 50, idleMs: 5 },
				});
				value.launch();
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

	it("event idle deadline resets only on bounded event progress", async () => {
		const controller = new ControlledProcessController();
		const value = supervisor(controller, { event: { hardMs: 50, idleMs: 5 } });
		value.launch();
		async function* idleEvents(): AsyncGenerator<unknown> {
			await new Promise<never>(() => undefined);
		}
		await expect(value.consumeEvents(idleEvents())).rejects.toMatchObject({ segment: "event" });
		expect(controller.lastHandle?.forceCalls).toBe(1);
	});

	it("event hard deadline remains bounded while progress refreshes the idle deadline", async () => {
		const controller = new ControlledProcessController();
		const value = supervisor(controller, { event: { hardMs: 12, idleMs: 8 } });
		value.launch();
		async function* progressingEvents(): AsyncGenerator<unknown> {
			for (;;) {
				await new Promise((resolve) => setTimeout(resolve, 4));
				yield { progress: true };
			}
		}
		await expect(value.consumeEvents(progressingEvents())).rejects.toBeInstanceOf(ExternalConnectorSupervisorError);
		expect(controller.lastHandle?.forceCalls).toBe(1);
	});

	it("dispose enforces both deadline bounds when force termination cannot be confirmed", async () => {
		for (const deadline of [{ hardMs: 5, idleMs: 50 }, { hardMs: 50, idleMs: 5 }]) {
			const controller = new ControlledProcessController();
			const value = supervisor(controller, { dispose: deadline });
			value.launch();
			controller.lastHandle!.resolveOnForce = false;
			await expect(value.dispose()).rejects.toMatchObject({
				code: "reconcile_required",
				segment: "dispose",
			});
			expect(value.snapshot.quarantined).toBe(true);
		}
	});

	it("bounds event count, bytes, artifact refs, and rate before force termination", async () => {
		for (const events of [
			[{ n: 1 }, { n: 2 }, { n: 3 }],
			[{ value: "x".repeat(40) }],
			[{ artifacts: [{ id: 1 }, { id: 2 }] }],
		]) {
			const controller = new ControlledProcessController();
			const value = supervisor(controller);
			value.launch();
			async function* source(): AsyncGenerator<unknown> {
				for (const event of events) yield event;
			}
			await expect(value.consumeEvents(source())).rejects.toMatchObject({
				code: "external_resource_limit_exceeded",
				segment: "event",
			});
			expect(controller.lastHandle?.forceCalls).toBe(1);
		}
	});

	it("persists non-detached exact host-private identity and reattaches only that process", async () => {
		const controller = new ControlledProcessController();
		const first = supervisor(controller);
		const state = first.launch();
		expect(controller.launchRequest).toMatchObject({ detached: false, containment: "process_group" });
		expect(state.processIdentity).toEqual(controller.identity);
		const restarted = supervisor(controller);
		restarted.reattach(state);
		expect(restarted.snapshot.phase).toBe("running");
		await restarted.dispose();
	});

	it("reaps an exact orphan on restart", async () => {
		const controller = new ControlledProcessController();
		const first = supervisor(controller);
		const state = first.launch();
		const restarted = supervisor(controller);
		await restarted.recoverAndReap(state);
		expect(controller.lastHandle?.forceCalls).toBe(1);
		expect(restarted.snapshot.cleaned).toBe(true);
	});

	it("quarantines PID reuse and ambiguous identity without killing the observed process", () => {
		for (const status of ["identity_mismatch", "ambiguous"] as const) {
			const controller = new ControlledProcessController();
			const first = supervisor(controller);
			const state = first.launch();
			const unrelated = new ControlledHandle(controller.launchRequest!, {
				...controller.identity,
				startToken: "reused-pid-start-token",
			});
			controller.reattachResult = status === "ambiguous"
				? { status: "ambiguous" }
				: { status: "attached", handle: unrelated };
			const restarted = supervisor(controller);
			expect(() => restarted.reattach(state)).toThrow(ExternalConnectorSupervisorError);
			expect(restarted.snapshot.quarantined).toBe(true);
			expect(unrelated.forceCalls).toBe(0);
		}
	});
});
