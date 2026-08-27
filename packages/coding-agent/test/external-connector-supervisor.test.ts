import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	ExternalConnectorBoundedSupervisor,
	FileExternalConnectorSupervisorPrivateStateStore,
	ExternalConnectorSupervisorError,
	externalConnectorProcessContainment,
	type ExternalConnectorProcessController,
	type ExternalConnectorProcessHandle,
	type ExternalConnectorProcessIdentity,
	type ExternalConnectorProcessLaunchRequest,
	type ExternalConnectorProcessReattachResult,
	type ExternalConnectorProcessTerminationRequest,
	type ExternalConnectorProcessTerminationResult,
	type ExternalConnectorSupervisorSegment,
} from "../src/core/external-connector-supervisor.ts";

class ControlledHandle implements ExternalConnectorProcessHandle {
	readonly operationNonce: string;
	readonly detached = false as const;
	readonly containment: "process_group" | "job_object";
	readonly identity: ExternalConnectorProcessIdentity;
	readonly exited: Promise<void>;
	forceCalls = 0;
	resolveOnForce = true;
	terminationIdentity: ExternalConnectorProcessIdentity;
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
	artifactsAllowed = true,
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
		},
	});
}

const driverHandle = {
	externalSessionId: "external-session",
	externalTurnId: "external-turn",
	supervisorRef: "current-supervisor",
	operationNonce: "current-nonce",
} as const;

function event(
	type: "started" | "progress" | "artifact",
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

describe("current External Connector robust supervision", () => {
	it("selects process-group containment on POSIX and Job containment on Windows", () => {
		expect(externalConnectorProcessContainment("linux")).toBe("process_group");
		expect(externalConnectorProcessContainment("darwin")).toBe("process_group");
		expect(externalConnectorProcessContainment("win32")).toBe("job_object");
	});

	for (const segment of ["start", "receipt", "cancel"] as const) {
		for (const deadlineKind of ["hard", "idle"] as const) {
			it(`${segment} enforces its ${deadlineKind} deadline and force-terminates the contained process`, async () => {
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
		await expect(value.consumeEvents(() => idleEvents(), driverHandle)).rejects.toMatchObject({ segment: "event" });
		expect(controller.lastHandle?.forceCalls).toBe(1);
	});

	it("event hard deadline remains bounded while progress refreshes the idle deadline", async () => {
		const controller = new ControlledProcessController();
		const value = supervisor(controller, { event: { hardMs: 12, idleMs: 8 } });
		value.launch();
		async function* progressingEvents(): AsyncGenerator<unknown> {
			yield event("started");
			let sequence = 0;
			for (;;) {
				await new Promise((resolve) => setTimeout(resolve, 4));
				sequence += 1;
				yield event("progress", { sequence });
			}
		}
		await expect(value.consumeEvents(() => progressingEvents(), driverHandle)).rejects.toBeInstanceOf(ExternalConnectorSupervisorError);
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
			[event("started"), event("progress", { sequence: 1 }), event("progress", { sequence: 2 })],
			[
				event("started"),
				event("artifact", { artifact: {
					schemaVersion: 1,
					artifactId: "artifact-large",
					mediaType: "application/octet-stream",
					digest: `sha256:${"a".repeat(64)}`,
					producer: "x".repeat(600),
				} }),
			],
			[
				event("started"),
				event("artifact", { artifact: { schemaVersion: 1, artifactId: "artifact-1", mediaType: "text/plain", digest: `sha256:${"b".repeat(64)}`, sizeBytes: 1 } }),
				event("artifact", { artifact: { schemaVersion: 1, artifactId: "artifact-2", mediaType: "text/plain", digest: `sha256:${"c".repeat(64)}`, sizeBytes: 1 } }),
			],
		]) {
			const controller = new ControlledProcessController();
			const value = supervisor(controller);
			value.launch();
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
			{ events: [event("started"), event("progress", { sequence: 2 }), event("progress", { sequence: 1 })], artifactsAllowed: true },
			{ events: [{ ...event("started"), externalSessionId: "different-session" }], artifactsAllowed: true },
			{ events: [{ ...event("started"), unknown: true }], artifactsAllowed: true },
			{
				events: [event("started"), event("artifact", { artifact: {
					schemaVersion: 1,
					artifactId: "artifact-1",
					mediaType: "text/plain",
					digest: `sha256:${"d".repeat(64)}`,
				} })],
				artifactsAllowed: false,
			},
		]) {
			const controller = new ControlledProcessController();
			const value = supervisor(controller, {}, testCase.artifactsAllowed);
			value.launch();
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
		operationSupervisor.launch();
		let operationCalls = 0;
		await expect(operationSupervisor.run("start", async () => {
			operationCalls += 1;
		}, signal)).rejects.toBeInstanceOf(ExternalConnectorSupervisorError);
		expect(operationCalls).toBe(0);

		const eventController = new ControlledProcessController();
		const eventSupervisor = supervisor(eventController);
		eventSupervisor.launch();
		let eventFactoryCalls = 0;
		let iteratorCalls = 0;
		await expect(eventSupervisor.consumeEvents(() => {
			eventFactoryCalls += 1;
			return {
				[Symbol.asyncIterator]: () => {
					iteratorCalls += 1;
					return { next: async () => ({ done: true, value: undefined }) };
				},
			};
		}, driverHandle, signal)).rejects.toBeInstanceOf(ExternalConnectorSupervisorError);
		expect(eventFactoryCalls).toBe(0);
		expect(iteratorCalls).toBe(0);
	});

	it("persists non-detached exact host-private identity and reattaches only that process", async () => {
		const controller = new ControlledProcessController();
		const first = supervisor(controller);
		const state = first.launch();
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

	it("rechecks exact nonce and process identity before force termination", async () => {
		const controller = new ControlledProcessController();
		const value = supervisor(controller);
		value.launch();
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
			const state = supervisor(controller).launch();
			await store.write("attempt-1", state);
			expect(await store.read("attempt-1")).toEqual(state);
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
			await expect(restarted.write("attempt-1", {
				...state,
				processIdentity: { ...state.processIdentity, startToken: "different-start" },
			})).rejects.toThrow("identity conflict");
			await restarted.delete("attempt-1");
			expect(await restarted.read("attempt-1")).toBeUndefined();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
