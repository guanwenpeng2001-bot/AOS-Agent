import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
	EXTERNAL_AGENT_ADAPTER_SCHEMA_VERSION,
	createExternalAgentPreparedBinding,
	type ExternalAgentAdapter,
	type ExternalAgentCapabilitySnapshot,
	type ExternalAgentEvent,
	type ExternalAgentHandle,
	type ExternalAgentReceipt,
	type ExternalAgentStartRequest,
} from "../src/core/external-agent-adapter.ts";
import type { ExternalExecutionRef } from "../src/core/external-session-mapping.ts";
import {
	EXTERNAL_AGENT_SUPERVISOR_SCHEMA_VERSION,
	ExternalAgentSupervisor,
	isExternalAgentSupervisorPrivateState,
	isExternalAgentSupervisorReference,
	serializeExternalAgentSupervisorReference,
	type ExternalAgentProcessController,
	type ExternalAgentProcessHandle,
	type ExternalAgentProcessIdentity,
	type ExternalAgentProcessLaunchRequest,
	type ExternalAgentProcessReattachResult,
	type ExternalAgentSupervisorDeadlineOverrides,
	type ExternalAgentSupervisorLimits,
	type ExternalAgentSupervisorOptions,
	type ExternalAgentSupervisorPrivateState,
	type ExternalAgentSupervisorReference,
} from "../src/core/external-agent-supervisor.ts";
import type { RuntimeClock } from "../src/core/runtime-clock.ts";
import { DeterministicClock } from "./support/deterministic-clock.ts";

const WALL_NOW = Date.parse("2026-08-27T00:00:00.000Z");
const NOW = "2026-08-27T00:00:00.000Z";

interface TestDeferred<T> {
	readonly promise: Promise<T>;
	readonly resolve: (value: T) => void;
	readonly reject: (error: unknown) => void;
}

function testDeferred<T>(): TestDeferred<T> {
	let resolvePromise: ((value: T) => void) | undefined;
	let rejectPromise: ((error: unknown) => void) | undefined;
	const promise = new Promise<T>((resolve, reject) => {
		resolvePromise = resolve;
		rejectPromise = reject;
	});
	return { promise, resolve: (value) => resolvePromise!(value), reject: (error) => rejectPromise!(error) };
}

function reference(overrides: Partial<ExternalAgentSupervisorReference> = {}): ExternalAgentSupervisorReference {
	return {
		schemaVersion: EXTERNAL_AGENT_SUPERVISOR_SCHEMA_VERSION,
		supervisorRef: "supervisor-1",
		operationNonce: "nonce-1",
		...overrides,
	};
}

function identity(overrides: Partial<ExternalAgentProcessIdentity> = {}): ExternalAgentProcessIdentity {
	return {
		pid: 4242,
		startToken: "start-token-1",
		executableIdentity: "sha256:executable-1",
		fileIdentity: "sha256:file-1",
		...overrides,
	};
}

class FakeProcessHandle implements ExternalAgentProcessHandle {
	readonly operationNonce: string;
	readonly detached = false as const;
	readonly containment = "job_object" as const;
	readonly identity: ExternalAgentProcessIdentity;
	readonly exited: Promise<void>;
	readonly exitDeferred = testDeferred<void>();
	forceCalls = 0;
	terminateOnForce: boolean;

	constructor(options: {
		readonly operationNonce?: string;
		readonly identity?: ExternalAgentProcessIdentity;
		readonly terminateOnForce?: boolean;
	} = {}) {
		this.operationNonce = options.operationNonce ?? "nonce-1";
		this.identity = options.identity ?? identity();
		this.terminateOnForce = options.terminateOnForce ?? true;
		this.exited = this.exitDeferred.promise;
	}

	forceTerminate(): void {
		this.forceCalls += 1;
		if (this.terminateOnForce) this.exitDeferred.resolve();
	}

	hostKill(): void {
		this.exitDeferred.resolve();
	}
}

class FakeProcessController implements ExternalAgentProcessController {
	readonly process: FakeProcessHandle;
	launches: ExternalAgentProcessLaunchRequest[] = [];
	reattachCalls: ExternalAgentProcessIdentity[] = [];
	reattachResult: ExternalAgentProcessReattachResult | undefined;

	constructor(processHandle = new FakeProcessHandle()) {
		this.process = processHandle;
	}

	launch(request: ExternalAgentProcessLaunchRequest): ExternalAgentProcessHandle {
		this.launches.push(request);
		return this.process;
	}

	reattach(
		processIdentity: ExternalAgentProcessIdentity,
		_request: ExternalAgentProcessLaunchRequest,
	): ExternalAgentProcessReattachResult {
		this.reattachCalls.push(processIdentity);
		return this.reattachResult ?? { status: "attached", handle: this.process };
	}
}

function externalRef(overrides: Partial<ExternalExecutionRef> = {}): ExternalExecutionRef {
	return { namespace: "fake-connector", externalSessionId: "external-session-1", ...overrides };
}

function progress(sequence: number): ExternalAgentEvent {
	return { type: "progress", external: externalRef(), sequence, timestamp: NOW };
}

function artifact(id: string): ExternalAgentEvent {
	return {
		type: "artifact",
		external: externalRef(),
		artifact: { id, kind: "output", sizeBytes: 1 },
		timestamp: NOW,
	};
}

function completedReceipt(overrides: Partial<ExternalAgentReceipt> = {}): ExternalAgentReceipt {
	return {
		schemaVersion: EXTERNAL_AGENT_ADAPTER_SCHEMA_VERSION,
		external: externalRef(),
		status: "completed",
		endedAt: NOW,
		artifactRefs: [],
		sideEffects: "none",
		...overrides,
	};
}

function startRequest(): ExternalAgentStartRequest {
	const snapshot: ExternalAgentCapabilitySnapshot = {
		schemaVersion: EXTERNAL_AGENT_ADAPTER_SCHEMA_VERSION,
		adapterId: "fake-adapter",
		targetId: "target-1",
		protocol: { name: "fake-protocol", version: "1" },
		status: "ready",
		capabilities: {
			start: true,
			events: "metadata",
			cancel: "strong",
			receipt: "terminal",
			resume: false,
			artifacts: true,
			toolGateway: false,
		},
		observedAt: NOW,
	};
	const preparedBinding = createExternalAgentPreparedBinding(
		{
			runId: "run-1",
			sessionId: "session-1",
			capabilitySummary: [],
			selection: { adapterId: "fake-adapter", targetId: "target-1" },
		},
		snapshot,
	);
	return { preparedBinding, input: { message: "bounded input" }, operationId: "operation-1" };
}

function iterable(events: ReadonlyArray<unknown>): AsyncIterable<ExternalAgentEvent> {
	return {
		async *[Symbol.asyncIterator]() {
			for (const event of events) yield event as ExternalAgentEvent;
		},
	};
}

function pendingEvents(): AsyncIterable<ExternalAgentEvent> {
	return {
		[Symbol.asyncIterator]() {
			return { next: () => new Promise<IteratorResult<ExternalAgentEvent>>(() => {}) };
		},
	};
}

function infiniteEvents(): AsyncIterable<ExternalAgentEvent> {
	return {
		async *[Symbol.asyncIterator]() {
			let sequence = 0;
			for (;;) yield progress(++sequence);
		},
	};
}

function timedEvents(clock: RuntimeClock, delayMs: number): AsyncIterable<ExternalAgentEvent> {
	let sequence = 0;
	return {
		[Symbol.asyncIterator]() {
			return {
				next: () =>
					new Promise<IteratorResult<ExternalAgentEvent>>((resolve) => {
						clock.setTimeout(() => resolve({ done: false, value: progress(++sequence) }), delayMs);
					}),
			};
		},
	};
}

function externalHandle(options: {
	readonly events?: AsyncIterable<ExternalAgentEvent>;
	readonly receipt?: Promise<ExternalAgentReceipt>;
	readonly cancel?: () => Promise<void>;
	readonly external?: ExternalExecutionRef;
} = {}): ExternalAgentHandle {
	return {
		external: options.external ?? externalRef(),
		events: options.events ?? iterable([]),
		receipt: options.receipt ?? Promise.resolve(completedReceipt()),
		cancel: options.cancel ?? (async () => {}),
		async heartbeat() {
			throw new Error("heartbeat is outside supervisor tests");
		},
	};
}

function adapter(start: ExternalAgentAdapter["start"]): ExternalAgentAdapter {
	return {
		id: "fake-adapter",
		async probe() {
			throw new Error("probe is outside supervisor tests");
		},
		async prepare() {
			throw new Error("prepare is outside supervisor tests");
		},
		start,
	};
}

const SHORT_DEADLINES: ExternalAgentSupervisorDeadlineOverrides = {
	start: { hardMs: 50, idleMs: 20 },
	event: { hardMs: 50, idleMs: 20 },
	receipt: { hardMs: 50, idleMs: 20 },
	cancel: { hardMs: 50, idleMs: 20 },
	dispose: { hardMs: 50, idleMs: 20 },
};

function supervisorFixture(options: {
	readonly clock?: DeterministicClock;
	readonly process?: FakeProcessHandle;
	readonly controller?: FakeProcessController;
	readonly deadlines?: ExternalAgentSupervisorDeadlineOverrides;
	readonly limits?: Partial<ExternalAgentSupervisorLimits>;
} = {}): {
	readonly clock: DeterministicClock;
	readonly process: FakeProcessHandle;
	readonly controller: FakeProcessController;
	readonly supervisor: ExternalAgentSupervisor;
} {
	const clock = options.clock ?? new DeterministicClock({ wallTimeMs: WALL_NOW });
	const processHandle = options.process ?? options.controller?.process ?? new FakeProcessHandle();
	const controller = options.controller ?? new FakeProcessController(processHandle);
	const supervisorOptions: ExternalAgentSupervisorOptions = {
		reference: reference(),
		containment: "job_object",
		processController: controller,
		deadlines: options.deadlines ?? SHORT_DEADLINES,
		limits: options.limits,
		clock,
	};
	return { clock, process: processHandle, controller, supervisor: new ExternalAgentSupervisor(supervisorOptions) };
}

async function drainMicrotasks(iterations = 12): Promise<void> {
	for (let index = 0; index < iterations; index += 1) await Promise.resolve();
}

async function advance(clock: DeterministicClock, milliseconds: number): Promise<void> {
	await drainMicrotasks();
	clock.advanceBy(milliseconds);
	await drainMicrotasks();
}

function privateState(processIdentity = identity()): ExternalAgentSupervisorPrivateState {
	return {
		schemaVersion: EXTERNAL_AGENT_SUPERVISOR_SCHEMA_VERSION,
		reference: reference(),
		detached: false,
		containment: "job_object",
		processIdentity,
	};
}

describe("ExternalAgentSupervisor", () => {
	it("keeps canonical correlation opaque and process identity Host-private", async () => {
		const value = supervisorFixture();
		value.supervisor.start(adapter(async () => externalHandle()), startRequest());
		const result = await value.supervisor.result;
		expect(result).toMatchObject({ kind: "receipt", receipt: { status: "completed" } });
		expect(value.controller.launches).toEqual([
			{ supervisorRef: "supervisor-1", operationNonce: "nonce-1", detached: false, containment: "job_object" },
		]);
		expect(isExternalAgentSupervisorReference(value.supervisor.reference)).toBe(true);
		expect(serializeExternalAgentSupervisorReference(value.supervisor.reference)).toEqual(reference());
		expect(Object.keys(value.supervisor.reference).sort()).toEqual(["operationNonce", "schemaVersion", "supervisorRef"]);
		expect(isExternalAgentSupervisorPrivateState(value.supervisor.hostPrivateState)).toBe(true);
		expect(value.supervisor.hostPrivateState?.processIdentity).toEqual(identity());
		const canonical = JSON.stringify({ reference: value.supervisor.reference, snapshot: value.supervisor.snapshot, result });
		for (const forbidden of ["pid", "startToken", "executableIdentity", "fileIdentity"]) {
			expect(canonical).not.toContain(forbidden);
		}
	});

	it("refuses detached or uncontained launch handles without signalling an ambiguous process", async () => {
		const value = supervisorFixture();
		const unsafe = {
			...value.process,
			detached: true,
			forceTerminate: () => {
				value.process.forceCalls += 1;
			},
		} as unknown as ExternalAgentProcessHandle;
		value.controller.launch = () => unsafe;
		value.supervisor.start(adapter(async () => externalHandle()), startRequest());
		await expect(value.supervisor.result).resolves.toMatchObject({
			kind: "failure",
			failure: { code: "reconcile_required", forcedTermination: false },
		});
		expect(value.process.forceCalls).toBe(0);
	});

	it("bounds a non-cooperative start and force-terminates the contained process", async () => {
		const value = supervisorFixture();
		value.supervisor.start(adapter(() => new Promise<ExternalAgentHandle>(() => {})), startRequest());
		await advance(value.clock, 20);
		await expect(value.supervisor.result).resolves.toMatchObject({
			kind: "failure",
			failure: { code: "side_effect_unknown", segment: "start", forcedTermination: true },
		});
		expect(value.process.forceCalls).toBe(1);
	});

	it("bounds a non-cooperative event segment independently from receipt", async () => {
		const receipt = testDeferred<ExternalAgentReceipt>();
		const value = supervisorFixture({
			deadlines: { ...SHORT_DEADLINES, receipt: { hardMs: 200, idleMs: 100 } },
		});
		value.supervisor.start(
			adapter(async () => externalHandle({ events: pendingEvents(), receipt: receipt.promise })),
			startRequest(),
		);
		await advance(value.clock, 20);
		await expect(value.supervisor.result).resolves.toMatchObject({
			kind: "failure",
			failure: { code: "side_effect_unknown", segment: "event" },
		});
		expect(value.process.forceCalls).toBe(1);
	});

	it("bounds a non-cooperative receipt after the event stream ends", async () => {
		const value = supervisorFixture();
		value.supervisor.start(
			adapter(async () => externalHandle({ receipt: new Promise<ExternalAgentReceipt>(() => {}) })),
			startRequest(),
		);
		await advance(value.clock, 20);
		await expect(value.supervisor.result).resolves.toMatchObject({
			kind: "failure",
			failure: { code: "side_effect_unknown", segment: "receipt" },
		});
		expect(value.process.forceCalls).toBe(1);
	});

	it("bounds a non-cooperative cancel instead of trusting AbortSignal", async () => {
		const value = supervisorFixture({
			deadlines: {
				...SHORT_DEADLINES,
				event: { hardMs: 200, idleMs: 100 },
				receipt: { hardMs: 200, idleMs: 100 },
			},
		});
		value.supervisor.start(
			adapter(async () =>
				externalHandle({
					events: pendingEvents(),
					receipt: new Promise<ExternalAgentReceipt>(() => {}),
					cancel: () => new Promise<void>(() => {}),
				})),
			startRequest(),
		);
		await drainMicrotasks();
		const cancellation = value.supervisor.cancel();
		await advance(value.clock, 20);
		await expect(cancellation).resolves.toMatchObject({ code: "side_effect_unknown", segment: "cancel" });
		await expect(value.supervisor.result).resolves.toMatchObject({ kind: "failure" });
		expect(value.process.forceCalls).toBe(1);
	});

	it("bounds a non-cooperative dispose and marks orphan cleanup for reconciliation", async () => {
		const processHandle = new FakeProcessHandle({ terminateOnForce: false });
		const value = supervisorFixture({ process: processHandle });
		value.supervisor.start(adapter(async () => externalHandle()), startRequest());
		await expect(value.supervisor.result).resolves.toMatchObject({ kind: "receipt" });
		const disposal = value.supervisor.dispose();
		let disposalSettled = false;
		void disposal.then(() => {
			disposalSettled = true;
		});
		await drainMicrotasks();
		expect(disposalSettled).toBe(false);
		await advance(value.clock, 20);
		await expect(disposal).resolves.toMatchObject({ code: "reconcile_required", segment: "dispose" });
		expect(value.process.forceCalls).toBe(1);
		expect(value.supervisor.snapshot.quarantined).toBe(true);
	});

	it("stops an infinite event source at the hard event-count limit", async () => {
		const value = supervisorFixture({ limits: { maxEvents: 5, maxEventsPerWindow: 100 } });
		value.supervisor.start(
			adapter(async () =>
				externalHandle({ events: infiniteEvents(), receipt: new Promise<ExternalAgentReceipt>(() => {}) })),
			startRequest(),
		);
		await drainMicrotasks(30);
		await expect(value.supervisor.result).resolves.toMatchObject({
			kind: "failure",
			failure: { code: "resource_limit_exceeded", segment: "event" },
			eventCount: 6,
		});
		expect(value.supervisor.events).toHaveLength(5);
		expect(value.process.forceCalls).toBe(1);
	});

	it("fails closed on an invalid event and never exposes a completed receipt", async () => {
		const value = supervisorFixture();
		value.supervisor.start(
			adapter(async () =>
				externalHandle({
					events: iterable([{ ...progress(1), sequence: 0 }]),
					receipt: Promise.resolve(completedReceipt()),
				})),
			startRequest(),
		);
		const result = await value.supervisor.result;
		expect(result).toMatchObject({ kind: "failure", failure: { code: "event_invalid" } });
		expect(result).not.toHaveProperty("receipt");
		expect(JSON.stringify(result)).not.toContain('"status":"completed"');
		expect(value.process.forceCalls).toBe(1);
	});

	it("enforces per-item bytes before event validation", async () => {
		const value = supervisorFixture({ limits: { maxItemBytes: 128 } });
		value.supervisor.start(
			adapter(async () =>
				externalHandle({
					events: iterable([{ ...progress(1), payload: "x".repeat(256) }]),
					receipt: new Promise<ExternalAgentReceipt>(() => {}),
				})),
			startRequest(),
		);
		await expect(value.supervisor.result).resolves.toMatchObject({
			kind: "failure",
			failure: { code: "resource_limit_exceeded", segment: "event" },
		});
	});

	it("enforces cumulative bytes across bounded event items", async () => {
		const first = progress(1);
		const second = progress(2);
		const firstBytes = Buffer.byteLength(JSON.stringify(first));
		const secondBytes = Buffer.byteLength(JSON.stringify(second));
		const value = supervisorFixture({
			limits: { maxItemBytes: Math.max(firstBytes, secondBytes) + 10, maxTotalBytes: firstBytes + secondBytes - 1 },
		});
		value.supervisor.start(
			adapter(async () => externalHandle({ events: iterable([first, second]), receipt: new Promise(() => {}) })),
			startRequest(),
		);
		await expect(value.supervisor.result).resolves.toMatchObject({
			kind: "failure",
			failure: { code: "resource_limit_exceeded", segment: "event" },
		});
		expect(value.supervisor.events).toHaveLength(1);
	});

	it("enforces event rate with a monotonic window", async () => {
		const value = supervisorFixture({ limits: { maxEvents: 10, maxEventsPerWindow: 2, eventRateWindowMs: 1_000 } });
		value.supervisor.start(
			adapter(async () =>
				externalHandle({ events: iterable([progress(1), progress(2), progress(3)]), receipt: new Promise(() => {}) })),
			startRequest(),
		);
		await expect(value.supervisor.result).resolves.toMatchObject({
			kind: "failure",
			failure: { code: "resource_limit_exceeded", segment: "event" },
		});
		expect(value.supervisor.events).toHaveLength(2);
	});

	it("enforces cumulative artifact references across events", async () => {
		const value = supervisorFixture({ limits: { maxArtifactRefs: 1 } });
		value.supervisor.start(
			adapter(async () =>
				externalHandle({ events: iterable([artifact("artifact-1"), artifact("artifact-2")]), receipt: new Promise(() => {}) })),
			startRequest(),
		);
		await expect(value.supervisor.result).resolves.toMatchObject({
			kind: "failure",
			failure: { code: "resource_limit_exceeded", segment: "event" },
		});
		expect(value.supervisor.events).toHaveLength(1);
	});

	it("enforces artifact-reference limits on the terminal receipt", async () => {
		const value = supervisorFixture({ limits: { maxArtifactRefs: 1 } });
		value.supervisor.start(
			adapter(async () =>
				externalHandle({
					receipt: Promise.resolve(
						completedReceipt({ artifactRefs: [{ id: "artifact-1", kind: "output" }, { id: "artifact-2", kind: "output" }] }),
					),
				})),
			startRequest(),
		);
		await expect(value.supervisor.result).resolves.toMatchObject({
			kind: "failure",
			failure: { code: "resource_limit_exceeded", segment: "receipt" },
		});
	});

	it("keeps the event idle deadline renewable but never extends its hard deadline", async () => {
		const clock = new DeterministicClock({ wallTimeMs: WALL_NOW });
		const value = supervisorFixture({
			clock,
			deadlines: {
				...SHORT_DEADLINES,
				event: { hardMs: 25, idleMs: 15 },
				receipt: { hardMs: 200, idleMs: 100 },
			},
		});
		value.supervisor.start(
			adapter(async () => externalHandle({ events: timedEvents(clock, 10), receipt: new Promise(() => {}) })),
			startRequest(),
		);
		await advance(clock, 10);
		await advance(clock, 10);
		await advance(clock, 5);
		await expect(value.supervisor.result).resolves.toMatchObject({
			kind: "failure",
			failure: { code: "side_effect_unknown", segment: "event" },
		});
		expect(value.supervisor.events).toHaveLength(2);
	});

	it("classifies Host process death before receipt as side-effect unknown and reaps the exact handle", async () => {
		const value = supervisorFixture({
			deadlines: {
				...SHORT_DEADLINES,
				event: { hardMs: 200, idleMs: 100 },
				receipt: { hardMs: 200, idleMs: 100 },
			},
		});
		value.supervisor.start(
			adapter(async () => externalHandle({ events: pendingEvents(), receipt: new Promise(() => {}) })),
			startRequest(),
		);
		await drainMicrotasks();
		value.process.hostKill();
		await drainMicrotasks();
		await expect(value.supervisor.result).resolves.toMatchObject({
			kind: "failure",
			failure: { code: "side_effect_unknown", segment: "receipt" },
		});
		expect(value.process.forceCalls).toBe(1);
	});

	it("reattaches and reaps only an exact restart identity", async () => {
		const processHandle = new FakeProcessHandle();
		const controller = new FakeProcessController(processHandle);
		controller.reattachResult = { status: "attached", handle: processHandle };
		const value = supervisorFixture({ process: processHandle, controller });
		const result = await value.supervisor.recoverAndReap(privateState());
		expect(result).toMatchObject({
			kind: "failure",
			failure: { code: "side_effect_unknown", segment: "dispose", forcedTermination: true },
		});
		expect(controller.reattachCalls).toEqual([identity()]);
		expect(processHandle.forceCalls).toBe(1);
	});

	it("refuses a PID-reused process whose start token or file identity differs", async () => {
		const reused = new FakeProcessHandle({ identity: identity({ startToken: "start-token-reused" }) });
		const controller = new FakeProcessController(reused);
		controller.reattachResult = { status: "attached", handle: reused };
		const value = supervisorFixture({ process: reused, controller });
		const result = await value.supervisor.recoverAndReap(privateState());
		expect(result).toMatchObject({
			kind: "failure",
			failure: { code: "reconcile_required", forcedTermination: false },
		});
		expect(reused.forceCalls).toBe(0);
		expect(value.supervisor.snapshot.quarantined).toBe(true);
	});

	it("refuses ambiguous restart identity without killing any candidate", async () => {
		const controller = new FakeProcessController();
		controller.reattachResult = { status: "ambiguous" };
		const value = supervisorFixture({ controller });
		const result = await value.supervisor.recoverAndReap(privateState());
		expect(result).toMatchObject({ kind: "failure", failure: { code: "reconcile_required" } });
		expect(controller.process.forceCalls).toBe(0);
	});
});
