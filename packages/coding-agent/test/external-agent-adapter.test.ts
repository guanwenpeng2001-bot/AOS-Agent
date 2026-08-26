import { describe, expect, it } from "vitest";
import type { ExternalExecutionRef } from "../src/core/external-session-mapping.ts";
import { isExternalExecutionRef } from "../src/core/external-session-mapping.ts";
import type { RemoteOperationLease } from "../src/core/remote-operation.ts";
import {
	EXTERNAL_AGENT_ADAPTER_SCHEMA_VERSION,
	EXTERNAL_AGENT_BINDING_FINGERPRINT_PREFIX,
	EXTERNAL_AGENT_MAX_EVENTS,
	ExternalAgentError,
	createExternalAgentBindingFingerprint,
	createExternalAgentEventCollector,
	createExternalAgentPreparedBinding,
	externalAgentBindingFingerprintFor,
	externalAgentCapabilityError,
	externalAgentMeetsMinimumCapabilities,
	isExternalAgentBindingFingerprint,
	isExternalAgentBindingInput,
	isExternalAgentCapabilitySnapshot,
	isExternalAgentEvent,
	isExternalAgentIdentifier,
	isExternalAgentInput,
	isExternalAgentPreparedBinding,
	isExternalAgentPrepareRequest,
	isExternalAgentProbeContext,
	isExternalAgentReceipt,
	isExternalAgentReceiptError,
	isExternalAgentSelection,
	isExternalAgentStartRequest,
	isExternalAgentTarget,
	runExternalAgentAdapter,
	serializeExternalAgentCapabilitySnapshot,
	serializeExternalAgentEvent,
	serializeExternalAgentPreparedBinding,
	serializeExternalAgentReceipt,
	toExternalAgentError,
	toExternalAgentReceiptError,
	verifyExternalAgentPreparedBinding,
	type ExternalAgentAdapter,
	type ExternalAgentBindingInput,
	type ExternalAgentCapabilityFlags,
	type ExternalAgentCapabilitySnapshot,
	type ExternalAgentErrorCode,
	type ExternalAgentEvent,
	type ExternalAgentExecutionContext,
	type ExternalAgentHandle,
	type ExternalAgentInput,
	type ExternalAgentPrepareRequest,
	type ExternalAgentPreparedBinding,
	type ExternalAgentProbeContext,
	type ExternalAgentReceipt,
	type ExternalAgentRequiredCapabilityFlags,
	type ExternalAgentSelection,
	type ExternalAgentStartRequest,
	type ExternalAgentTarget,
} from "../src/core/external-agent-adapter.ts";

const NOW = "2026-08-16T12:00:00.000Z";

const READY_CAPABILITIES: ExternalAgentCapabilityFlags = {
	start: true,
	events: "metadata",
	cancel: "cooperative",
	receipt: "terminal",
	resume: false,
	artifacts: true,
	toolGateway: false,
};

function externalRef(overrides: Partial<ExternalExecutionRef> = {}): ExternalExecutionRef {
	return {
		namespace: "fake-adapter",
		externalSessionId: "ext-session-1",
		...overrides,
	};
}

function sampleBindingInput(overrides: Partial<ExternalAgentBindingInput> = {}): ExternalAgentBindingInput {
	return {
		runId: "run-1",
		sessionId: "session-1",
		capabilitySummary: ["bash", "read"],
		...overrides,
	};
}

function sampleSelection(overrides: Partial<ExternalAgentSelection> = {}): ExternalAgentSelection {
	return { adapterId: "fake-adapter", targetId: "target-a", ...overrides };
}

function sampleSnapshot(overrides: Partial<ExternalAgentCapabilitySnapshot> = {}): ExternalAgentCapabilitySnapshot {
	return {
		schemaVersion: EXTERNAL_AGENT_ADAPTER_SCHEMA_VERSION,
		adapterId: "fake-adapter",
		targetId: "target-a",
		protocol: { name: "fake-agent", version: "1" },
		status: "ready",
		capabilities: { ...READY_CAPABILITIES },
		observedAt: NOW,
		...overrides,
	};
}

function samplePrepareRequest(overrides: Partial<ExternalAgentPrepareRequest> = {}): ExternalAgentPrepareRequest {
	return {
		...sampleBindingInput(),
		selection: sampleSelection(),
		...overrides,
	};
}

function samplePreparedBinding(overrides: Partial<ExternalAgentPreparedBinding> = {}): ExternalAgentPreparedBinding {
	return { ...createExternalAgentPreparedBinding(samplePrepareRequest(), sampleSnapshot()), ...overrides };
}

/** Required-capability literal shape for binding overrides; plain spreads of READY_CAPABILITIES widen. */
function requiredCapabilities(
	overrides: Partial<ExternalAgentRequiredCapabilityFlags> = {},
): ExternalAgentRequiredCapabilityFlags {
	return {
		start: true,
		events: "metadata",
		cancel: "cooperative",
		receipt: "terminal",
		resume: false,
		artifacts: true,
		toolGateway: false,
		...overrides,
	};
}

function sampleInput(overrides: Partial<ExternalAgentInput> = {}): ExternalAgentInput {
	return { message: "do the thing", ...overrides };
}

function sampleStartRequest(overrides: Partial<ExternalAgentStartRequest> = {}): ExternalAgentStartRequest {
	return {
		preparedBinding: samplePreparedBinding(),
		input: sampleInput(),
		operationId: "operation-1",
		...overrides,
	};
}

function startedEvent(overrides: Partial<Extract<ExternalAgentEvent, { type: "started" }>> = {}): ExternalAgentEvent {
	return { type: "started", external: externalRef(), timestamp: NOW, ...overrides };
}

function progressEvent(
	sequence: number,
	overrides: Partial<Extract<ExternalAgentEvent, { type: "progress" }>> = {},
): ExternalAgentEvent {
	return { type: "progress", external: externalRef(), sequence, timestamp: NOW, ...overrides };
}

function artifactEvent(
	overrides: Partial<Extract<ExternalAgentEvent, { type: "artifact" }>> = {},
): ExternalAgentEvent {
	return {
		type: "artifact",
		external: externalRef(),
		artifact: {
			id: "artifact-1",
			kind: "output",
			digest: "sha256:artifact-1",
			sizeBytes: 10,
			mediaType: "application/octet-stream",
		},
		timestamp: NOW,
		...overrides,
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

function failedReceipt(
	code: ExternalAgentErrorCode,
	sideEffects: "none" | "associated" | "unknown" = "unknown",
	overrides: Partial<ExternalAgentReceipt> = {},
): ExternalAgentReceipt {
	return {
		schemaVersion: EXTERNAL_AGENT_ADAPTER_SCHEMA_VERSION,
		external: externalRef(),
		status: "failed",
		endedAt: NOW,
		artifactRefs: [],
		sideEffects,
		error: { code, retryable: false, sideEffects },
		...overrides,
	};
}

/** Fake target with controllable protocol, status, and capability flags. */
class FakeExternalAgentTarget {
	readonly targetId = "target-a";
	protocol = { name: "fake-agent", version: "1" };
	status: ExternalAgentCapabilitySnapshot["status"] = "ready";
	capabilities: ExternalAgentCapabilityFlags = { ...READY_CAPABILITIES };
	reasonCode: string | undefined;
	probeCalls = 0;

	snapshot(adapterId: string): ExternalAgentCapabilitySnapshot {
		this.probeCalls += 1;
		return {
			schemaVersion: EXTERNAL_AGENT_ADAPTER_SCHEMA_VERSION,
			adapterId,
			targetId: this.targetId,
			protocol: { ...this.protocol },
			status: this.status,
			capabilities: { ...this.capabilities },
			...(this.reasonCode === undefined ? {} : { reasonCode: this.reasonCode }),
			observedAt: NOW,
		};
	}
}

interface FakeHandleOptions {
	readonly external: ExternalExecutionRef;
	readonly events: ReadonlyArray<unknown>;
	readonly receipt: Promise<unknown>;
	readonly cancelError?: unknown;
	readonly heartbeatResult?: RemoteOperationLease;
	readonly heartbeatError?: unknown;
}

/** Fake in-process handle; it may emit malformed values the driver must reject. */
class FakeExternalAgentHandle implements ExternalAgentHandle {
	readonly external: ExternalExecutionRef;
	readonly events: AsyncIterable<ExternalAgentEvent>;
	readonly receipt: Promise<ExternalAgentReceipt>;
	readonly cancelError: unknown;
	readonly heartbeatResult: RemoteOperationLease | undefined;
	readonly heartbeatError: unknown;
	cancelCalls = 0;
	heartbeatCalls = 0;

	constructor(options: FakeHandleOptions) {
		this.external = options.external;
		this.events = {
			async *[Symbol.asyncIterator]() {
				for (const event of options.events) yield event as ExternalAgentEvent;
			},
		};
		this.receipt = options.receipt as Promise<ExternalAgentReceipt>;
		this.cancelError = options.cancelError;
		this.heartbeatResult = options.heartbeatResult;
		this.heartbeatError = options.heartbeatError;
	}

	async cancel(): Promise<void> {
		this.cancelCalls += 1;
		if (this.cancelError !== undefined) throw this.cancelError;
	}

	async heartbeat(): Promise<RemoteOperationLease> {
		this.heartbeatCalls += 1;
		if (this.heartbeatError !== undefined) throw this.heartbeatError;
		if (this.heartbeatResult === undefined) throw new Error("fake target has no lease");
		return { leaseId: this.heartbeatResult.leaseId, expiresAt: this.heartbeatResult.expiresAt };
	}
}

/** Fake in-process adapter; every failure mode is injectable. */
class FakeExternalAgentAdapter implements ExternalAgentAdapter {
	readonly id: string;
	readonly target: FakeExternalAgentTarget;
	probeResult: unknown;
	probeError: unknown;
	prepareError: unknown;
	startError: unknown;
	startDelayMs: number | undefined;
	startResult: ExternalAgentHandle | undefined;
	probeCalls = 0;
	prepareCalls = 0;
	startCalls = 0;
	lastProbeContext: ExternalAgentProbeContext | undefined;
	lastStartRequest: ExternalAgentStartRequest | undefined;
	lastStartContext: ExternalAgentExecutionContext | undefined;

	constructor(id = "fake-adapter", target = new FakeExternalAgentTarget()) {
		this.id = id;
		this.target = target;
		this.probeResult = undefined;
		this.probeError = undefined;
		this.prepareError = undefined;
		this.startError = undefined;
		this.startDelayMs = undefined;
	}

	async probe(target: ExternalAgentTarget, context: ExternalAgentProbeContext): Promise<ExternalAgentCapabilitySnapshot> {
		this.probeCalls += 1;
		this.lastProbeContext = context;
		if (this.probeError !== undefined) throw this.probeError;
		if (this.probeResult !== undefined) return this.probeResult as ExternalAgentCapabilitySnapshot;
		if (context.signal.aborted) throw new Error("probe aborted by signal");
		return this.target.snapshot(this.id);
	}

	async prepare(
		request: ExternalAgentPrepareRequest,
		snapshot: ExternalAgentCapabilitySnapshot,
	): Promise<ExternalAgentPreparedBinding> {
		this.prepareCalls += 1;
		if (this.prepareError !== undefined) throw this.prepareError;
		return createExternalAgentPreparedBinding(request, snapshot);
	}

	async start(
		request: ExternalAgentStartRequest,
		context: ExternalAgentExecutionContext,
	): Promise<ExternalAgentHandle> {
		this.startCalls += 1;
		this.lastStartRequest = request;
		this.lastStartContext = context;
		if (this.startDelayMs !== undefined) {
			await new Promise<void>((resolve) => setTimeout(resolve, this.startDelayMs));
		}
		if (this.startError !== undefined) throw this.startError;
		if (this.startResult !== undefined) return this.startResult;
		return new FakeExternalAgentHandle({
			external: externalRef(),
			events: [],
			receipt: Promise.resolve(completedReceipt()),
		});
	}
}

async function collectEvents(events: AsyncIterable<ExternalAgentEvent>): Promise<ExternalAgentEvent[]> {
	const collected: ExternalAgentEvent[] = [];
	for await (const event of events) collected.push(event);
	return collected;
}

describe("safe identifiers and exact shapes", () => {
	it("accepts bounded safe identifiers and rejects URLs, paths, and secret-looking values", () => {
		for (const value of ["adapter-1", "target_a:1", "protocol.v2", "run:1"]) {
			expect(isExternalAgentIdentifier(value)).toBe(true);
		}
		for (const value of [
			"https://example.com/adapter",
			"a/b",
			"a\\b",
			"a@b",
			"a?b",
			"a#b",
			"Bearer token: abc",
			"api_key=secret",
			"a b",
			"",
			"a\nb",
		]) {
			expect(isExternalAgentIdentifier(value)).toBe(false);
		}
	});

	it("validates targets and selections exactly", () => {
		expect(isExternalAgentTarget({ targetId: "target-a" })).toBe(true);
		expect(isExternalAgentTarget({ targetId: "target-a", endpoint: "https://x" })).toBe(false);
		expect(isExternalAgentTarget({ targetId: "a/b" })).toBe(false);
		expect(isExternalAgentTarget({ targetId: "x".repeat(257) })).toBe(false);
		expect(isExternalAgentTarget({})).toBe(false);

		expect(isExternalAgentSelection({ adapterId: "fake-adapter", targetId: "target-a" })).toBe(true);
		expect(isExternalAgentSelection({ adapterId: "fake-adapter" })).toBe(false);
		expect(isExternalAgentSelection({ adapterId: "x".repeat(129), targetId: "target-a" })).toBe(false);
		expect(isExternalAgentSelection({ adapterId: "fake-adapter", targetId: "target-a", credentials: "x" })).toBe(false);
	});

	it("validates probe contexts", () => {
		const signal = new AbortController().signal;
		expect(isExternalAgentProbeContext({ signal, deadlineAt: NOW })).toBe(true);
		expect(isExternalAgentProbeContext({ signal })).toBe(true);
		expect(isExternalAgentProbeContext({ signal, deadlineAt: "not-a-timestamp" })).toBe(false);
		expect(isExternalAgentProbeContext({ signal, extra: 1 })).toBe(false);
		expect(isExternalAgentProbeContext({ deadlineAt: NOW })).toBe(false);
	});

	it("rejects unknown keys and raw-looking fields in every public value", () => {
		expect(isExternalAgentCapabilitySnapshot(sampleSnapshot({ rawProtocol: "x" } as never))).toBe(false);
		expect(isExternalAgentCapabilitySnapshot(sampleSnapshot({ endpoint: "https://x" } as never))).toBe(false);
		expect(isExternalAgentPreparedBinding(samplePreparedBinding({ credentials: "x" } as never))).toBe(false);
		expect(
			isExternalAgentPreparedBinding(
				samplePreparedBinding({ capabilities: { ...READY_CAPABILITIES, toolGateway: false, token: true } } as never),
			),
		).toBe(false);
		expect(isExternalAgentReceipt(completedReceipt({ payload: "x" } as never))).toBe(false);
		expect(isExternalAgentReceipt(completedReceipt({ rawReceipt: "x" } as never))).toBe(false);
		expect(isExternalAgentEvent({ ...startedEvent(), stdout: "x" } as never)).toBe(false);
		expect(isExternalAgentEvent({ ...artifactEvent(), path: "/tmp/x" } as never)).toBe(false);
		expect(isExternalAgentStartRequest({ ...sampleStartRequest(), env: { A: "1" } } as never)).toBe(false);
	});
});

describe("capability snapshot", () => {
	it("accepts a ready snapshot and serializes it frozen", () => {
		const snapshot = sampleSnapshot();
		expect(isExternalAgentCapabilitySnapshot(snapshot)).toBe(true);
		const serialized = serializeExternalAgentCapabilitySnapshot(snapshot);
		expect(serialized).toEqual(snapshot);
		expect(Object.isFrozen(serialized)).toBe(true);
		expect(Object.isFrozen(serialized?.capabilities)).toBe(true);
	});

	it("rejects malformed snapshots", () => {
		expect(isExternalAgentCapabilitySnapshot(sampleSnapshot({ schemaVersion: 2 } as never))).toBe(false);
		expect(isExternalAgentCapabilitySnapshot(sampleSnapshot({ status: "running" } as never))).toBe(false);
		expect(
			isExternalAgentCapabilitySnapshot(
				sampleSnapshot({ capabilities: { ...READY_CAPABILITIES, cancel: "nope" } } as never),
			),
		).toBe(false);
		expect(
			isExternalAgentCapabilitySnapshot(sampleSnapshot({ protocol: { name: "https://x", version: "1" } } as never)),
		).toBe(false);
		expect(isExternalAgentCapabilitySnapshot(sampleSnapshot({ reasonCode: "a/b" } as never))).toBe(false);
		expect(isExternalAgentCapabilitySnapshot(sampleSnapshot({ observedAt: "yesterday" } as never))).toBe(false);
		expect(isExternalAgentCapabilitySnapshot(sampleSnapshot({ adapterId: "x".repeat(129) } as never))).toBe(false);
	});

	it("probes a fake target in-process without side effects", async () => {
		const adapter = new FakeExternalAgentAdapter();
		const snapshot = await adapter.probe({ targetId: adapter.target.targetId }, { signal: new AbortController().signal, deadlineAt: NOW });
		expect(adapter.probeCalls).toBe(1);
		expect(isExternalAgentCapabilitySnapshot(snapshot)).toBe(true);
		expect(snapshot.adapterId).toBe("fake-adapter");
		expect(snapshot.targetId).toBe("target-a");
		expect(snapshot.capabilities.start).toBe(true);
	});

	it("fails closed on probe abort and on malformed handshakes", async () => {
		const aborted = new AbortController();
		aborted.abort();
		const adapter = new FakeExternalAgentAdapter();
		adapter.probeError = new Error("handshake timeout");
		await expect(
			adapter.probe({ targetId: "target-a" }, { signal: aborted.signal }),
		).rejects.toMatchObject({ message: "handshake timeout" });

		adapter.probeError = undefined;
		adapter.probeResult = { rawProtocol: "x", token: "secret" };
		const malformed = await adapter.probe({ targetId: "target-a" }, { signal: new AbortController().signal });
		expect(isExternalAgentCapabilitySnapshot(malformed)).toBe(false);
		await expect(
			adapter.prepare(samplePrepareRequest(), malformed as ExternalAgentCapabilitySnapshot),
		).rejects.toBeInstanceOf(ExternalAgentError);
		await expect(
			adapter.prepare(samplePrepareRequest(), malformed as ExternalAgentCapabilitySnapshot),
		).rejects.toMatchObject({ code: "external_agent_adapter_invalid" });
	});
});

describe("capability requirements", () => {
	it("reduces probe status and required flags to stable errors", () => {
		expect(externalAgentCapabilityError(sampleSnapshot())).toBeUndefined();
		expect(externalAgentMeetsMinimumCapabilities(sampleSnapshot())).toBe(true);

		expect(externalAgentCapabilityError(sampleSnapshot({ status: "unavailable" }))).toBe(
			"external_agent_probe_failed",
		);
		expect(externalAgentCapabilityError(sampleSnapshot({ status: "incompatible" }))).toBe(
			"external_agent_protocol_unsupported",
		);

		expect(
			externalAgentCapabilityError(sampleSnapshot({ capabilities: { ...READY_CAPABILITIES, start: false } })),
		).toBe("external_agent_capability_missing");
		expect(
			externalAgentCapabilityError(sampleSnapshot({ capabilities: { ...READY_CAPABILITIES, receipt: "none" } })),
		).toBe("external_agent_capability_missing");
		expect(
			externalAgentCapabilityError(sampleSnapshot({ capabilities: { ...READY_CAPABILITIES, cancel: "none" } })),
		).toBe("external_agent_capability_missing");

		// Optional capabilities never block a controlled Run.
		expect(
			externalAgentCapabilityError(
				sampleSnapshot({ capabilities: { ...READY_CAPABILITIES, events: "none", resume: false } }),
			),
		).toBeUndefined();
	});

	it("rejects prepare when the capability gate fails", () => {
		expect(() =>
			createExternalAgentPreparedBinding(
				samplePrepareRequest(),
				sampleSnapshot({ status: "unavailable" }),
			),
		).toThrowError(new ExternalAgentError("external_agent_probe_failed"));
		expect(() =>
			createExternalAgentPreparedBinding(
				samplePrepareRequest(),
				sampleSnapshot({ capabilities: { ...READY_CAPABILITIES, cancel: "none" } }),
			),
		).toThrowError(new ExternalAgentError("external_agent_capability_missing"));
		expect(() =>
			createExternalAgentPreparedBinding(samplePrepareRequest(), sampleSnapshot({ status: "incompatible" })),
		).toThrowError(new ExternalAgentError("external_agent_protocol_unsupported"));
	});

	it("rejects selection/snapshot mismatch and unverified tool-gateway mode", () => {
		expect(() =>
			createExternalAgentPreparedBinding(
				samplePrepareRequest({ selection: sampleSelection({ adapterId: "other-adapter" }) }),
				sampleSnapshot(),
			),
		).toThrowError(new ExternalAgentError("external_agent_adapter_invalid"));

		expect(() =>
			createExternalAgentPreparedBinding(samplePrepareRequest(), sampleSnapshot(), { bindingMode: "tool-gateway" }),
		).toThrowError(new ExternalAgentError("external_agent_capability_missing"));

		const gatewaySnapshot = sampleSnapshot({
			capabilities: { ...READY_CAPABILITIES, toolGateway: true },
		});
		const gatewayBinding = createExternalAgentPreparedBinding(samplePrepareRequest(), gatewaySnapshot, {
			bindingMode: "tool-gateway",
		});
		expect(gatewayBinding.bindingMode).toBe("tool-gateway");
		expect(gatewayBinding.capabilities.toolGateway).toBe(true);
	});
});

describe("binding input and prepared binding", () => {
	it("validates binding input exactly and rejects smuggled raw data", () => {
		expect(
			isExternalAgentBindingInput({
				...sampleBindingInput(),
				bindingAssociation: { schemaVersion: 1, associationId: "association-1", runId: "run-1", bindings: [] },
			}),
		).toBe(false);

		for (const smuggled of [
			{ credentials: "secret" },
			{ rawPolicy: "x" },
			{ processEnv: { A: "1" } },
			{ prompt: "do it" },
			{ apiKey: "k" },
			{ endpoint: "https://x" },
		]) {
			expect(isExternalAgentBindingInput(sampleBindingInput(smuggled as never))).toBe(false);
		}

		expect(
			isExternalAgentBindingInput(sampleBindingInput({ capabilitySummary: ["https://x"] })),
		).toBe(false);
		expect(
			isExternalAgentBindingInput(sampleBindingInput({ capabilitySummary: ["x".repeat(65)] })),
		).toBe(false);
		expect(
			isExternalAgentBindingInput(
				sampleBindingInput({ capabilitySummary: Array.from({ length: 65 }, (_, index) => `cap-${index}`) }),
			),
		).toBe(false);
		expect(isExternalAgentBindingInput(sampleBindingInput({ policyProfile: "a/b" }))).toBe(false);
	});

	it("builds an immutable prepared binding bound to the fingerprint", () => {
		const prepared = createExternalAgentPreparedBinding(samplePrepareRequest(), sampleSnapshot());
		expect(isExternalAgentPreparedBinding(prepared)).toBe(true);
		expect(prepared.capabilities.start).toBe(true);
		expect(prepared.capabilities.receipt).toBe("terminal");
		expect(prepared.capabilities.cancel).not.toBe("none");
		expect(prepared.bindingMode).toBe("reference-only");
		expect(isExternalAgentBindingFingerprint(prepared.bindingFingerprint)).toBe(true);
		expect(Object.isFrozen(prepared)).toBe(true);
		expect(Object.isFrozen(prepared.capabilities)).toBe(true);
		expect(serializeExternalAgentPreparedBinding(prepared)).toEqual(prepared);
	});

	it("validates start requests including lease and input bounds", () => {
		expect(isExternalAgentStartRequest(sampleStartRequest())).toBe(true);
		expect(
			isExternalAgentStartRequest(
				sampleStartRequest({ lease: { leaseId: "lease-1", expiresAt: NOW } }),
			),
		).toBe(true);
		expect(
			isExternalAgentStartRequest(sampleStartRequest({ lease: { leaseId: "lease-1", expiresAt: "soon" } })),
		).toBe(false);
		expect(
			isExternalAgentStartRequest(sampleStartRequest({ deadlineAt: "not-a-timestamp" })),
		).toBe(false);
		expect(isExternalAgentStartRequest(sampleStartRequest({ operationId: "a/b" }))).toBe(false);

		const input = sampleInput({ message: "" });
		expect(isExternalAgentInput(input)).toBe(false);
		expect(isExternalAgentInput(sampleInput({ message: "x".repeat(256 * 1024 + 1) }))).toBe(false);
		expect(
			isExternalAgentInput(
				sampleInput({
					images: [
						{ id: "image-1", mimeType: "image/png", sizeBytes: 10 },
						{ id: "image-2", mimeType: "image/png", sizeBytes: 0 },
						{ id: "https://x", mimeType: "image/png" },
					],
				}),
			),
		).toBe(false);
	});

	it("rejects malformed prepare requests", () => {
		expect(isExternalAgentPrepareRequest(samplePrepareRequest())).toBe(true);
		expect(isExternalAgentPrepareRequest(samplePrepareRequest({ runId: "run-2" }))).toBe(true);
		expect(isExternalAgentPrepareRequest({ ...samplePrepareRequest(), prompt: "x" } as never)).toBe(false);
		expect(isExternalAgentPrepareRequest(samplePrepareRequest({ selection: { adapterId: "a" } } as never))).toBe(false);
	});
});

describe("binding fingerprint", () => {
	it("is deterministic and order-insensitive over the capability summary", () => {
		const request = samplePrepareRequest();
		const snapshot = sampleSnapshot();
		const first = externalAgentBindingFingerprintFor(request, snapshot, "reference-only");
		expect(first.startsWith(EXTERNAL_AGENT_BINDING_FINGERPRINT_PREFIX)).toBe(true);

		const reordered = externalAgentBindingFingerprintFor(
			{ ...request, capabilitySummary: ["read", "bash", "bash"] },
			snapshot,
			"reference-only",
		);
		expect(reordered).toBe(first);
	});

	it("changes when any binding fact changes", () => {
		const request = samplePrepareRequest();
		const snapshot = sampleSnapshot();
		const base = externalAgentBindingFingerprintFor(request, snapshot, "reference-only");
		const variants: Array<() => string> = [
			() => externalAgentBindingFingerprintFor({ ...request, runId: "run-2" }, snapshot, "reference-only"),
			() => externalAgentBindingFingerprintFor({ ...request, sessionId: "session-2" }, snapshot, "reference-only"),
			() => externalAgentBindingFingerprintFor({ ...request, modelBindingId: "model-binding:1" }, snapshot, "reference-only"),
			() => externalAgentBindingFingerprintFor({ ...request, policyBindingId: "policy-binding:1" }, snapshot, "reference-only"),
			() => externalAgentBindingFingerprintFor({ ...request, policyProfile: "strict" }, snapshot, "reference-only"),
			() => externalAgentBindingFingerprintFor({ ...request, sandboxProfile: "sandbox-1" }, snapshot, "reference-only"),
			() => externalAgentBindingFingerprintFor({ ...request, capabilitySummary: ["bash", "read", "edit"] }, snapshot, "reference-only"),
			() => externalAgentBindingFingerprintFor(
				request,
				{ ...snapshot, protocol: { name: "fake-agent", version: "2" } },
				"reference-only",
			),
			() =>
				externalAgentBindingFingerprintFor(
					{ ...request, selection: sampleSelection({ targetId: "target-b" }) },
					snapshot,
					"reference-only",
				),
			() => externalAgentBindingFingerprintFor(request, snapshot, "tool-gateway"),
		];
		for (const variant of variants) expect(variant()).not.toBe(base);
		expect(createExternalAgentBindingFingerprint({
			runId: "run-1",
			sessionId: "session-1",
			adapterId: "fake-adapter",
			targetId: "target-a",
			protocolName: "fake-agent",
			protocolVersion: "1",
			bindingMode: "reference-only",
			capabilitySummary: ["bash", "read"],
		})).toBe(base);
	});

	it("verifies a prepared binding against request and snapshot", () => {
		const request = samplePrepareRequest();
		const snapshot = sampleSnapshot();
		const prepared = createExternalAgentPreparedBinding(request, snapshot);
		expect(verifyExternalAgentPreparedBinding(prepared, request, snapshot)).toBe(true);
		expect(
			verifyExternalAgentPreparedBinding(
				{ ...prepared, bindingFingerprint: "ext-binding:tampered" },
				request,
				snapshot,
			),
		).toBe(false);
		expect(verifyExternalAgentPreparedBinding(prepared, { ...request, runId: "run-2" }, snapshot)).toBe(false);
		expect(
			verifyExternalAgentPreparedBinding(
				prepared,
				request,
				{ ...snapshot, protocol: { name: "fake-agent", version: "2" } },
			),
		).toBe(false);
		expect(isExternalAgentBindingFingerprint("ext-binding:abc")).toBe(false);
		expect(isExternalAgentBindingFingerprint("not-a-fingerprint")).toBe(false);
	});
});

describe("bounded events and collector", () => {
	it("accepts ordered started, progress, and artifact events", () => {
		const collector = createExternalAgentEventCollector();
		expect(collector.push(startedEvent())).toBe(true);
		expect(collector.push(progressEvent(1, { phase: "planning" }))).toBe(true);
		expect(collector.push(artifactEvent())).toBe(true);
		expect(collector.events).toHaveLength(3);
		expect(collector.dropped).toBe(0);
		expect(collector.truncated).toBe(false);
		expect(collector.establishedExternal).toEqual(externalRef());
		expect(serializeExternalAgentEvent(collector.events[1])).toEqual(progressEvent(1, { phase: "planning" }));
	});

	it("drops malformed, duplicate, regressing, and identity-drifted events", () => {
		const collector = createExternalAgentEventCollector();
		expect(collector.push(startedEvent())).toBe(true);
		expect(collector.push({ ...startedEvent(), extra: 1 } as never)).toBe(false);
		expect(collector.push(startedEvent())).toBe(false);
		expect(collector.push(progressEvent(1))).toBe(true);
		expect(collector.push(progressEvent(1))).toBe(false);
		expect(collector.push(progressEvent(0))).toBe(false);
		expect(collector.push(progressEvent(2, { timestamp: "yesterday" } as never))).toBe(false);
		expect(collector.push(progressEvent(2, { phase: "a/b" }))).toBe(false);
		expect(collector.push(artifactEvent({ artifact: { id: "x", kind: "nope" } as never }))).toBe(false);
		expect(collector.push(progressEvent(2, { external: externalRef({ externalSessionId: "other" }) }))).toBe(false);
		expect(collector.events).toHaveLength(2);
		expect(collector.dropped).toBe(8);
		expect(collector.truncated).toBe(false);
	});

	it("bounds the event stream", () => {
		const collector = createExternalAgentEventCollector({ maxEvents: 2 });
		expect(collector.push(startedEvent())).toBe(true);
		expect(collector.push(progressEvent(1))).toBe(true);
		expect(collector.push(progressEvent(2))).toBe(false);
		expect(collector.events).toHaveLength(2);
		expect(collector.dropped).toBe(1);
		expect(collector.truncated).toBe(true);
	});

	it("clamps the event bound to the contract maximum", () => {
		const collector = createExternalAgentEventCollector({ maxEvents: EXTERNAL_AGENT_MAX_EVENTS + 100 });
		for (let index = 0; index < EXTERNAL_AGENT_MAX_EVENTS; index += 1) {
			collector.push(progressEvent(index + 1));
		}
		expect(collector.events).toHaveLength(EXTERNAL_AGENT_MAX_EVENTS);
		expect(collector.push(progressEvent(EXTERNAL_AGENT_MAX_EVENTS + 1))).toBe(false);
	});
});

describe("receipt validation", () => {
	it("accepts coherent terminal receipts", () => {
		expect(isExternalAgentReceipt(completedReceipt())).toBe(true);
		expect(
			isExternalAgentReceipt(
				completedReceipt({
					artifactRefs: [
						{ id: "artifact-1", kind: "output", digest: "sha256:x", sizeBytes: 1, mediaType: "application/json" },
					],
					sideEffects: "associated",
				}),
			),
		).toBe(true);
		expect(isExternalAgentReceipt(failedReceipt("external_agent_start_failed"))).toBe(true);
		expect(
			isExternalAgentReceipt(
				completedReceipt({
					status: "cancelled",
					sideEffects: "none",
				}),
			),
		).toBe(true);
		// A cancelled report with effects is shape-valid; the driver never
		// surfaces it as cancelled (see the side-effect-unknown rewrite tests).
		expect(
			isExternalAgentReceipt(
				completedReceipt({
					status: "cancelled",
					sideEffects: "associated",
				}),
			),
		).toBe(true);
	});

	it("rejects contradictory or malformed receipts", () => {
		// An error is only valid on failed.
		expect(isExternalAgentReceipt(completedReceipt({ error: { code: "external_agent_start_failed", retryable: false, sideEffects: "none" } }))).toBe(false);
		// A failed receipt must carry a stable error.
		expect(isExternalAgentReceipt(failedReceipt("external_agent_start_failed", "unknown", { error: undefined }))).toBe(false);
		// Unknown error codes fail closed.
		expect(
			isExternalAgentReceipt(
				failedReceipt("external_agent_start_failed", "unknown", {
					error: { code: "provider_exploded", retryable: false, sideEffects: "unknown" },
				} as never),
			),
		).toBe(false);
		expect(isExternalAgentReceiptError({ code: "provider_exploded", retryable: false, sideEffects: "none" })).toBe(false);
		expect(isExternalAgentReceiptError({ code: "external_agent_receipt_invalid", retryable: false, sideEffects: "none" })).toBe(true);
		// Shape and value rules.
		expect(isExternalAgentReceipt(completedReceipt({ schemaVersion: 2 } as never))).toBe(false);
		expect(isExternalAgentReceipt(completedReceipt({ endedAt: "soon" } as never))).toBe(false);
		expect(isExternalAgentReceipt(completedReceipt({ status: "running" } as never))).toBe(false);
		expect(isExternalAgentReceipt(completedReceipt({ sideEffects: "maybe" } as never))).toBe(false);
		expect(isExternalAgentReceipt(completedReceipt({ external: { namespace: "a/b", externalSessionId: "x" } }))).toBe(false);
		expect(
			isExternalAgentReceipt(
				completedReceipt({ artifactRefs: Array.from({ length: 65 }, (_, index) => ({ id: `a-${index}`, kind: "output" })) }),
			),
		).toBe(false);
	});

	it("serializes receipts frozen with exact keys", () => {
		const receipt = failedReceipt("external_agent_receipt_invalid");
		const serialized = serializeExternalAgentReceipt(receipt);
		expect(serialized).toEqual(receipt);
		expect(Object.isFrozen(serialized)).toBe(true);
		expect(Object.isFrozen(serialized?.error)).toBe(true);
		expect(Object.keys(serialized ?? {}).sort()).toEqual(
			["schemaVersion", "external", "status", "endedAt", "artifactRefs", "sideEffects", "error"].sort(),
		);
	});
});

describe("stable errors", () => {
	it("carries stable codes with code-derived messages", () => {
		const error = new ExternalAgentError("external_agent_side_effect_unknown");
		expect(error.name).toBe("ExternalAgentError");
		expect(error.code).toBe("external_agent_side_effect_unknown");
		expect(error.message).not.toContain("raw");
		expect(error.retryable).toBe(false);
		expect(new ExternalAgentError("external_agent_probe_failed").retryable).toBe(true);
		expect(new ExternalAgentError("external_agent_cancel_failed").retryable).toBe(true);
		expect(error.toJSON()).toEqual({
			code: "external_agent_side_effect_unknown",
			message: error.message,
			retryable: false,
		});
	});

	it("maps unknown exceptions to stable errors without leaking raw detail", () => {
		const raw = new Error("connection refused: token=SECRET at https://x/path");
		const mapped = toExternalAgentError(raw);
		expect(mapped).toBeInstanceOf(ExternalAgentError);
		expect(mapped.code).toBe("external_agent_side_effect_unknown");
		expect(mapped.message).not.toContain("SECRET");
		expect(mapped.message).not.toContain("https://");

		const start = toExternalAgentError(raw, "external_agent_start_failed");
		expect(start.code).toBe("external_agent_start_failed");
		expect(start.message).not.toContain("SECRET");

		const preserved = new ExternalAgentError("external_agent_cancel_failed");
		expect(toExternalAgentError(preserved)).toBe(preserved);

		expect(toExternalAgentError({ code: "external_agent_mapping_conflict" }).code).toBe(
			"external_agent_mapping_conflict",
		);
	});

	it("maps receipt errors with side-effect-safe defaults", () => {
		expect(toExternalAgentReceiptError(new Error("boom"))).toEqual({
			code: "external_agent_side_effect_unknown",
			retryable: false,
			sideEffects: "unknown",
		});
		expect(toExternalAgentReceiptError(new ExternalAgentError("external_agent_start_failed"))).toMatchObject({
			code: "external_agent_start_failed",
			retryable: false,
			sideEffects: "unknown",
		});
		expect(toExternalAgentReceiptError(new ExternalAgentError("external_agent_receipt_invalid"))).toMatchObject({
			sideEffects: "unknown",
		});
		expect(toExternalAgentReceiptError(new ExternalAgentError("external_agent_binding_unsupported"))).toMatchObject({
			sideEffects: "none",
		});
		expect(
			toExternalAgentReceiptError(new ExternalAgentError("external_agent_start_failed"), "associated"),
		).toMatchObject({ sideEffects: "associated" });
	});
});

describe("runExternalAgentAdapter: request validation", () => {
	it("rejects malformed start requests synchronously", () => {
		const adapter = new FakeExternalAgentAdapter();
		expect(() => runExternalAgentAdapter(adapter, { ...sampleStartRequest(), input: undefined } as never)).toThrowError(
			new ExternalAgentError("external_agent_adapter_invalid"),
		);
		expect(() =>
			runExternalAgentAdapter(adapter, sampleStartRequest({ operationId: "a/b" })),
		).toThrowError(new ExternalAgentError("external_agent_adapter_invalid"));
		expect(() =>
			runExternalAgentAdapter(adapter, sampleStartRequest({ preparedBinding: { ...samplePreparedBinding(), bindingFingerprint: "x" } })),
		).toThrowError(new ExternalAgentError("external_agent_adapter_invalid"));
	});

	it("rejects an adapter id that is unsafe or does not match the prepared binding", () => {
		const adapter = new FakeExternalAgentAdapter();
		expect(() => runExternalAgentAdapter(adapter, sampleStartRequest({ preparedBinding: samplePreparedBinding({ adapterId: "other" }) }))).toThrowError(
			new ExternalAgentError("external_agent_adapter_invalid"),
		);
		const unsafe = new FakeExternalAgentAdapter("https://x");
		expect(() => runExternalAgentAdapter(unsafe, sampleStartRequest())).toThrowError(
			new ExternalAgentError("external_agent_adapter_invalid"),
		);
	});
});

describe("runExternalAgentAdapter: happy path", () => {
	it("validates and bounds events, then settles the terminal receipt", async () => {
		const adapter = new FakeExternalAgentAdapter();
		const events: unknown[] = [
			startedEvent(),
			progressEvent(1, { phase: "planning" }),
			progressEvent(2),
			artifactEvent(),
		];
		adapter.startResult = new FakeExternalAgentHandle({
			external: externalRef(),
			events,
			receipt: Promise.resolve(completedReceipt({ artifactRefs: [{ id: "artifact-1", kind: "output" }] })),
		});
		const handle = runExternalAgentAdapter(adapter, sampleStartRequest());
		expect(adapter.startCalls).toBe(1);
		expect(adapter.lastStartRequest?.operationId).toBe("operation-1");
		expect(adapter.lastStartContext?.signal.aborted).toBe(false);

		const receipt = await handle.receipt;
		expect(receipt.status).toBe("completed");
		expect(receipt.external).toEqual(externalRef());
		expect(handle.external).toEqual(externalRef());
		expect(handle.eventsList).toHaveLength(4);
		expect(handle.droppedEvents).toBe(0);
		expect(await collectEvents(handle.events)).toHaveLength(4);
	});
});

describe("runExternalAgentAdapter: capability-governed artifact facts", () => {
	it("drops artifact events when the prepared binding declares artifacts unsupported", async () => {
		const adapter = new FakeExternalAgentAdapter();
		adapter.startResult = new FakeExternalAgentHandle({
			external: externalRef(),
			events: [
				startedEvent(),
				progressEvent(1),
				artifactEvent(),
				artifactEvent({ artifact: { id: "artifact-2", kind: "output" } }),
			],
			receipt: Promise.resolve(completedReceipt()),
		});
		const handle = runExternalAgentAdapter(
			adapter,
			sampleStartRequest({
				preparedBinding: samplePreparedBinding({ capabilities: requiredCapabilities({ artifacts: false }) }),
			}),
		);
		const receipt = await handle.receipt;
		expect(receipt.status).toBe("completed");
		// Artifact observations are rejected like any other invalid event and
		// never reach the accepted surface.
		expect(handle.eventsList.map((event) => event.type)).toEqual(["started", "progress"]);
		expect(handle.droppedEvents).toBe(2);
		expect(await collectEvents(handle.events)).toHaveLength(2);
	});

	it("fails closed on a receipt that claims artifactRefs for an artifacts-unsupported target", async () => {
		const adapter = new FakeExternalAgentAdapter();
		adapter.startResult = new FakeExternalAgentHandle({
			external: externalRef(),
			events: [startedEvent(), progressEvent(1)],
			receipt: Promise.resolve(
				completedReceipt({
					artifactRefs: [{ id: "artifact-1", kind: "output" }],
					sideEffects: "associated",
				}),
			),
		});
		const handle = runExternalAgentAdapter(
			adapter,
			sampleStartRequest({
				preparedBinding: samplePreparedBinding({ capabilities: requiredCapabilities({ artifacts: false }) }),
			}),
		);
		const receipt = await handle.receipt;
		expect(receipt.status).toBe("failed");
		expect(receipt.error?.code).toBe("external_agent_receipt_invalid");
		expect(receipt.error?.retryable).toBe(false);
		// The contract-violating terminal's side-effect claim is untrustworthy.
		expect(receipt.error?.sideEffects).toBe("unknown");
		expect(receipt.sideEffects).toBe("unknown");
		// The fabricated refs are stripped, never forwarded.
		expect(receipt.artifactRefs).toEqual([]);
		expect(handle.eventsList.some((event) => event.type === "artifact")).toBe(false);
	});

	it("fails closed on a cancelled receipt that claims artifactRefs when artifacts are unsupported", async () => {
		const adapter = new FakeExternalAgentAdapter();
		adapter.startResult = new FakeExternalAgentHandle({
			external: externalRef(),
			events: [],
			receipt: Promise.resolve(
				completedReceipt({
					status: "cancelled",
					sideEffects: "none",
					artifactRefs: [{ id: "artifact-1", kind: "output" }],
				}),
			),
		});
		const handle = runExternalAgentAdapter(
			adapter,
			sampleStartRequest({
				preparedBinding: samplePreparedBinding({ capabilities: requiredCapabilities({ artifacts: false }) }),
			}),
		);
		const receipt = await handle.receipt;
		// The artifact contract violation wins over the cancelled rewrite.
		expect(receipt.status).toBe("failed");
		expect(receipt.error?.code).toBe("external_agent_receipt_invalid");
		expect(receipt.artifactRefs).toEqual([]);
	});

	it("still accepts artifact events and artifactRefs when the binding declares artifacts supported", async () => {
		const adapter = new FakeExternalAgentAdapter();
		adapter.startResult = new FakeExternalAgentHandle({
			external: externalRef(),
			events: [startedEvent(), progressEvent(1), artifactEvent()],
			receipt: Promise.resolve(
				completedReceipt({
					artifactRefs: [{ id: "artifact-1", kind: "output" }],
					sideEffects: "associated",
				}),
			),
		});
		const handle = runExternalAgentAdapter(adapter, sampleStartRequest());
		const receipt = await handle.receipt;
		expect(receipt.status).toBe("completed");
		expect(receipt.artifactRefs).toEqual([{ id: "artifact-1", kind: "output" }]);
		expect(handle.eventsList.map((event) => event.type)).toEqual(["started", "progress", "artifact"]);
		expect(handle.droppedEvents).toBe(0);
	});
});

describe("runExternalAgentAdapter: start readiness", () => {
	it("keeps externalReady pending until a delayed start resolves, then yields the validated ref", async () => {
		const adapter = new FakeExternalAgentAdapter();
		adapter.startDelayMs = 20;
		const realRef = externalRef({ externalRunId: "ext-run-1" });
		adapter.startResult = new FakeExternalAgentHandle({
			external: realRef,
			events: [startedEvent()],
			receipt: Promise.resolve(completedReceipt({ external: realRef })),
		});
		const handle = runExternalAgentAdapter(adapter, sampleStartRequest());
		// Before start settles, the compatibility fallback identity is visible.
		expect(handle.external).toEqual({ namespace: "external-agent", externalSessionId: "operation-1" });

		let readyValue: ExternalExecutionRef | undefined | "pending" = "pending";
		void handle.externalReady.then((value) => {
			readyValue = value;
		});
		expect(readyValue).toBe("pending");

		await expect(handle.externalReady).resolves.toEqual(realRef);
		expect(readyValue).toEqual(realRef);
		expect(handle.external).toEqual(realRef);
		const receipt = await handle.receipt;
		expect(receipt.status).toBe("completed");
	});

	it("resolves externalReady to undefined when start fails", async () => {
		const adapter = new FakeExternalAgentAdapter();
		adapter.startError = new Error("start refused: token=SECRET");
		const handle = runExternalAgentAdapter(adapter, sampleStartRequest());
		await expect(handle.externalReady).resolves.toBeUndefined();
		const receipt = await handle.receipt;
		expect(receipt.status).toBe("failed");
		expect(receipt.error?.code).toBe("external_agent_start_failed");
	});

	it("resolves externalReady to undefined when the start identity is malformed", async () => {
		const adapter = new FakeExternalAgentAdapter();
		adapter.startResult = new FakeExternalAgentHandle({
			external: { namespace: "a/b", externalSessionId: "x" },
			events: [],
			receipt: Promise.resolve(completedReceipt()),
		});
		const handle = runExternalAgentAdapter(adapter, sampleStartRequest());
		await expect(handle.externalReady).resolves.toBeUndefined();
		const receipt = await handle.receipt;
		expect(receipt.status).toBe("failed");
		expect(receipt.error?.code).toBe("external_agent_mapping_invalid");
	});

	it("resolves externalReady to the exact validated ref on success and never rejects", async () => {
		const adapter = new FakeExternalAgentAdapter();
		const realRef = externalRef({ externalRunId: "ext-run-1" });
		adapter.startResult = new FakeExternalAgentHandle({
			external: realRef,
			events: [startedEvent()],
			receipt: Promise.resolve(completedReceipt({ external: realRef })),
		});
		const handle = runExternalAgentAdapter(adapter, sampleStartRequest());
		const resolved = await handle.externalReady;
		expect(resolved).toEqual(realRef);
		expect(isExternalExecutionRef(resolved)).toBe(true);
		expect(Object.isFrozen(resolved)).toBe(true);
		const receipt = await handle.receipt;
		expect(receipt.status).toBe("completed");
	});

	it("resolves externalReady with the real ref even when the later receipt fails", async () => {
		const adapter = new FakeExternalAgentAdapter();
		const realRef = externalRef({ externalRunId: "ext-run-1" });
		adapter.startResult = new FakeExternalAgentHandle({
			external: realRef,
			events: [],
			receipt: Promise.resolve({ schemaVersion: 1, status: "completed", raw: true }),
		});
		const handle = runExternalAgentAdapter(adapter, sampleStartRequest());
		// Readiness is bounded to start + identity validation, not the terminal.
		await expect(handle.externalReady).resolves.toEqual(realRef);
		const receipt = await handle.receipt;
		expect(receipt.status).toBe("failed");
		expect(receipt.error?.code).toBe("external_agent_receipt_invalid");
	});
});

describe("runExternalAgentAdapter: malformed adapter output", () => {
	it("fails closed when start throws", async () => {
		const adapter = new FakeExternalAgentAdapter();
		adapter.startError = new Error("connection lost: token=SECRET");
		const handle = runExternalAgentAdapter(adapter, sampleStartRequest());
		const receipt = await handle.receipt;
		expect(receipt.status).toBe("failed");
		expect(receipt.error?.code).toBe("external_agent_start_failed");
		expect(receipt.error?.retryable).toBe(false);
		expect(receipt.error?.sideEffects).toBe("unknown");
		expect(receipt.sideEffects).toBe("unknown");
		expect(receipt.error?.code).not.toContain("SECRET");
		// The fallback identity is never persisted; the failed status prevents mapping.
		expect(handle.external.namespace).toBe("external-agent");
		expect(handle.external.externalSessionId).toBe("operation-1");
	});

	it("fails closed when the adapter returns an invalid external identity", async () => {
		const adapter = new FakeExternalAgentAdapter();
		adapter.startResult = new FakeExternalAgentHandle({
			external: { namespace: "a/b", externalSessionId: "x" },
			events: [],
			receipt: Promise.resolve(completedReceipt()),
		});
		const handle = runExternalAgentAdapter(adapter, sampleStartRequest());
		const receipt = await handle.receipt;
		expect(receipt.status).toBe("failed");
		expect(receipt.error?.code).toBe("external_agent_mapping_invalid");
	});

	it("fails closed on a malformed or rejected receipt", async () => {
		const adapter = new FakeExternalAgentAdapter();
		adapter.startResult = new FakeExternalAgentHandle({
			external: externalRef(),
			events: [],
			receipt: Promise.resolve({ schemaVersion: 1, status: "completed", raw: true }),
		});
		const handle = runExternalAgentAdapter(adapter, sampleStartRequest());
		const receipt = await handle.receipt;
		expect(receipt.status).toBe("failed");
		expect(receipt.error?.code).toBe("external_agent_receipt_invalid");
		expect(receipt.error?.sideEffects).toBe("unknown");

		adapter.startResult = new FakeExternalAgentHandle({
			external: externalRef(),
			events: [],
			receipt: Promise.reject(new Error("disconnected")),
		});
		const rejected = await runExternalAgentAdapter(adapter, sampleStartRequest()).receipt;
		expect(rejected.status).toBe("failed");
		expect(rejected.error?.code).toBe("external_agent_receipt_invalid");
	});

	it("fails closed on receipt identity drift", async () => {
		const adapter = new FakeExternalAgentAdapter();
		adapter.startResult = new FakeExternalAgentHandle({
			external: externalRef(),
			events: [],
			receipt: Promise.resolve(completedReceipt({ external: externalRef({ externalSessionId: "other" }) })),
		});
		const handle = runExternalAgentAdapter(adapter, sampleStartRequest());
		const receipt = await handle.receipt;
		expect(receipt.status).toBe("failed");
		expect(receipt.error?.code).toBe("external_agent_receipt_invalid");
	});

	it("drops malformed and identity-drifted events without inventing a terminal", async () => {
		const adapter = new FakeExternalAgentAdapter();
		const events: unknown[] = [
			startedEvent(),
			{ type: "progress", sequence: 0, external: externalRef(), timestamp: NOW },
			progressEvent(1),
			progressEvent(1),
			{ rawProtocol: "x" },
			progressEvent(2, { external: externalRef({ externalSessionId: "other" }) }),
			progressEvent(3),
		];
		adapter.startResult = new FakeExternalAgentHandle({
			external: externalRef(),
			events,
			receipt: Promise.resolve(completedReceipt()),
		});
		const handle = runExternalAgentAdapter(adapter, sampleStartRequest());
		const receipt = await handle.receipt;
		expect(receipt.status).toBe("completed");
		expect(handle.eventsList).toHaveLength(3);
		expect(handle.droppedEvents).toBe(4);
	});

	it("bounds events through the run options", async () => {
		const adapter = new FakeExternalAgentAdapter();
		adapter.startResult = new FakeExternalAgentHandle({
			external: externalRef(),
			events: [startedEvent(), progressEvent(1), progressEvent(2)],
			receipt: Promise.resolve(completedReceipt()),
		});
		const handle = runExternalAgentAdapter(adapter, sampleStartRequest(), { maxEvents: 2 });
		await handle.receipt;
		expect(handle.eventsList).toHaveLength(2);
		expect(handle.droppedEvents).toBe(1);
	});
});

describe("runExternalAgentAdapter: cancel idempotence and side-effect-unknown", () => {
	it("forwards cancel once and never after the terminal receipt", async () => {
		const adapter = new FakeExternalAgentAdapter();
		const fakeHandle = new FakeExternalAgentHandle({
			external: externalRef(),
			events: [],
			receipt: Promise.resolve(completedReceipt({ status: "cancelled", sideEffects: "none" })),
		});
		adapter.startResult = fakeHandle;
		const handle = runExternalAgentAdapter(adapter, sampleStartRequest());
		await handle.cancel();
		await handle.cancel();
		expect(fakeHandle.cancelCalls).toBe(1);
		const receipt = await handle.receipt;
		expect(receipt.status).toBe("cancelled");
		await handle.cancel();
		expect(fakeHandle.cancelCalls).toBe(1);
	});

	it("coalesces concurrent cancels", async () => {
		const adapter = new FakeExternalAgentAdapter();
		const fakeHandle = new FakeExternalAgentHandle({
			external: externalRef(),
			events: [],
			receipt: Promise.resolve(completedReceipt()),
		});
		adapter.startResult = fakeHandle;
		const handle = runExternalAgentAdapter(adapter, sampleStartRequest());
		await Promise.all([handle.cancel(), handle.cancel(), handle.cancel()]);
		expect(fakeHandle.cancelCalls).toBe(1);
		await handle.receipt;
	});

	it("aborts the execution context signal and forwards cancel on abort", async () => {
		const adapter = new FakeExternalAgentAdapter();
		const fakeHandle = new FakeExternalAgentHandle({
			external: externalRef(),
			events: [],
			receipt: Promise.resolve(completedReceipt({ status: "cancelled", sideEffects: "none" })),
		});
		adapter.startResult = fakeHandle;
		const controller = new AbortController();
		const handle = runExternalAgentAdapter(adapter, sampleStartRequest(), { signal: controller.signal });
		controller.abort();
		const receipt = await handle.receipt;
		expect(receipt.status).toBe("cancelled");
		expect(fakeHandle.cancelCalls).toBe(1);
	});

	it("rewrites a cancelled receipt with associated side effects to side-effect-unknown", async () => {
		const adapter = new FakeExternalAgentAdapter();
		adapter.startResult = new FakeExternalAgentHandle({
			external: externalRef(),
			events: [],
			receipt: Promise.resolve(completedReceipt({ status: "cancelled", sideEffects: "associated" })),
		});
		const handle = runExternalAgentAdapter(adapter, sampleStartRequest());
		await handle.cancel();
		const receipt = await handle.receipt;
		expect(receipt.status).toBe("failed");
		expect(receipt.error?.code).toBe("external_agent_side_effect_unknown");
		expect(receipt.error?.retryable).toBe(false);
		expect(receipt.error?.sideEffects).toBe("associated");
		expect(receipt.sideEffects).toBe("associated");
	});

	it("rewrites a cancelled receipt with unknown side effects to side-effect-unknown", async () => {
		const adapter = new FakeExternalAgentAdapter();
		adapter.startResult = new FakeExternalAgentHandle({
			external: externalRef(),
			events: [],
			receipt: Promise.resolve(completedReceipt({ status: "cancelled", sideEffects: "unknown" })),
		});
		const handle = runExternalAgentAdapter(adapter, sampleStartRequest());
		await handle.cancel();
		const receipt = await handle.receipt;
		expect(receipt.status).toBe("failed");
		expect(receipt.error?.code).toBe("external_agent_side_effect_unknown");
		expect(receipt.error?.sideEffects).toBe("unknown");
	});

	it("keeps a completed receipt after a cancel request", async () => {
		const adapter = new FakeExternalAgentAdapter();
		adapter.startResult = new FakeExternalAgentHandle({
			external: externalRef(),
			events: [],
			receipt: Promise.resolve(completedReceipt()),
		});
		const handle = runExternalAgentAdapter(adapter, sampleStartRequest());
		await handle.cancel();
		const receipt = await handle.receipt;
		expect(receipt.status).toBe("completed");
	});

	it("surfaces cancel failures as stable errors", async () => {
		const adapter = new FakeExternalAgentAdapter();
		const fakeHandle = new FakeExternalAgentHandle({
			external: externalRef(),
			events: [],
			receipt: Promise.resolve(completedReceipt()),
			cancelError: new Error("cancel refused: token=SECRET"),
		});
		adapter.startResult = fakeHandle;
		const handle = runExternalAgentAdapter(adapter, sampleStartRequest());
		await expect(handle.cancel()).rejects.toMatchObject({
			name: "ExternalAgentError",
			code: "external_agent_cancel_failed",
		});
		const receipt = await handle.receipt;
		expect(receipt.status).toBe("completed");
	});

	it("validates heartbeat leases and rejects heartbeats without a lease", async () => {
		const adapter = new FakeExternalAgentAdapter();
		adapter.startResult = new FakeExternalAgentHandle({
			external: externalRef(),
			events: [],
			receipt: Promise.resolve(completedReceipt()),
			heartbeatResult: { leaseId: "lease-1", expiresAt: NOW },
		});
		const noLease = runExternalAgentAdapter(adapter, sampleStartRequest());
		await expect(noLease.heartbeat()).rejects.toMatchObject({ code: "external_agent_adapter_invalid" });

		const withLease = runExternalAgentAdapter(
			adapter,
			sampleStartRequest({ lease: { leaseId: "lease-1", expiresAt: NOW } }),
		);
		await expect(withLease.heartbeat()).resolves.toEqual({ leaseId: "lease-1", expiresAt: NOW });

		adapter.startResult = new FakeExternalAgentHandle({
			external: externalRef(),
			events: [],
			receipt: Promise.resolve(completedReceipt()),
			heartbeatResult: { leaseId: "lease-1", expiresAt: "not-a-timestamp" },
		});
		const invalidLease = runExternalAgentAdapter(
			adapter,
			sampleStartRequest({ lease: { leaseId: "lease-1", expiresAt: NOW } }),
		);
		await expect(invalidLease.heartbeat()).rejects.toMatchObject({ code: "external_agent_adapter_invalid" });
	});

	it("rejects heartbeat after the terminal receipt", async () => {
		const adapter = new FakeExternalAgentAdapter();
		adapter.startResult = new FakeExternalAgentHandle({
			external: externalRef(),
			events: [],
			receipt: Promise.resolve(completedReceipt()),
			heartbeatResult: { leaseId: "lease-1", expiresAt: NOW },
		});
		const handle = runExternalAgentAdapter(
			adapter,
			sampleStartRequest({ lease: { leaseId: "lease-1", expiresAt: NOW } }),
		);
		await handle.receipt;
		await expect(handle.heartbeat()).rejects.toMatchObject({ code: "external_agent_adapter_invalid" });
	});
});
