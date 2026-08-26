/**
 * Host-private supervision for one external connector execution.
 *
 * The Adapter contract remains the protocol boundary. This module owns only
 * bounded Host execution: non-detached process containment, segment
 * deadlines, output limits, forced termination, and exact-identity orphan
 * recovery. It never writes a Run terminal, mapping, receipt, registry, or
 * product shutdown fact.
 */

import { Buffer } from "node:buffer";
import { FoundationError } from "@aos-agent/agent-core";
import {
	isExternalExecutionRef,
	isExternalMappingIdentifier,
	type ExternalExecutionRef,
} from "./external-session-mapping.ts";
import {
	ExternalAgentError,
	isExternalAgentEvent,
	isExternalAgentReceipt,
	isExternalAgentStartRequest,
	serializeExternalAgentEvent,
	serializeExternalAgentReceipt,
	type ExternalAgentAdapter,
	type ExternalAgentEvent,
	type ExternalAgentHandle,
	type ExternalAgentReceipt,
	type ExternalAgentStartRequest,
} from "./external-agent-adapter.ts";
import {
	SYSTEM_RUNTIME_CLOCK,
	type RuntimeClock,
	type RuntimeTimerHandle,
} from "./runtime-clock.ts";

export const EXTERNAL_AGENT_SUPERVISOR_SCHEMA_VERSION = 1 as const;

export const EXTERNAL_AGENT_SUPERVISOR_SEGMENTS = ["start", "event", "receipt", "cancel", "dispose"] as const;
export type ExternalAgentSupervisorSegment = (typeof EXTERNAL_AGENT_SUPERVISOR_SEGMENTS)[number];

export const EXTERNAL_AGENT_SUPERVISOR_ERROR_CODES = [
	"external_resource_limit_exceeded",
	"external_event_invalid",
	"side_effect_unknown",
	"reconcile_required",
] as const;
export type ExternalAgentSupervisorErrorCode = (typeof EXTERNAL_AGENT_SUPERVISOR_ERROR_CODES)[number];

export type ExternalAgentProcessContainment = "process_group" | "job_object";

export interface ExternalAgentSupervisorReference {
	readonly schemaVersion: typeof EXTERNAL_AGENT_SUPERVISOR_SCHEMA_VERSION;
	readonly supervisorRef: string;
	readonly operationNonce: string;
}

/** Process identity is never part of the canonical supervisor reference. */
export interface ExternalAgentProcessIdentity {
	readonly pid: number;
	readonly startToken: string;
	readonly executableIdentity: string;
	readonly fileIdentity: string;
}

/**
 * Host-private recovery material. This value belongs in a Host-private store,
 * never in external.mapping, a receipt, an event, Audit, or public RPC.
 */
export interface ExternalAgentSupervisorPrivateState {
	readonly schemaVersion: typeof EXTERNAL_AGENT_SUPERVISOR_SCHEMA_VERSION;
	readonly reference: ExternalAgentSupervisorReference;
	readonly detached: false;
	readonly containment: ExternalAgentProcessContainment;
	readonly processIdentity: ExternalAgentProcessIdentity;
}

export interface ExternalAgentProcessLaunchRequest {
	readonly supervisorRef: string;
	readonly operationNonce: string;
	readonly detached: false;
	readonly containment: ExternalAgentProcessContainment;
}

/** Exact, force-capable handle retained only by the Host. */
export interface ExternalAgentProcessHandle {
	readonly operationNonce: string;
	readonly detached: false;
	readonly containment: ExternalAgentProcessContainment;
	readonly identity: ExternalAgentProcessIdentity;
	readonly exited: Promise<void>;
	forceTerminate(): void;
}

export type ExternalAgentProcessReattachResult =
	| { readonly status: "attached"; readonly handle: ExternalAgentProcessHandle }
	| { readonly status: "not_found" | "identity_mismatch" | "ambiguous" };

export interface ExternalAgentProcessController {
	/** Launch must return the containment handle synchronously before Adapter start. */
	launch(request: ExternalAgentProcessLaunchRequest): ExternalAgentProcessHandle;
	/** Reattach must return a handle only after exact process identity verification. */
	reattach?(
		identity: ExternalAgentProcessIdentity,
		request: ExternalAgentProcessLaunchRequest,
	): ExternalAgentProcessReattachResult;
}

export interface ExternalAgentSegmentDeadline {
	readonly hardMs: number;
	readonly idleMs: number;
}

export type ExternalAgentSupervisorDeadlineOverrides = {
	readonly [Segment in ExternalAgentSupervisorSegment]?: Partial<ExternalAgentSegmentDeadline>;
};

export interface ExternalAgentSupervisorLimits {
	readonly maxEvents: number;
	readonly maxEventsPerWindow: number;
	readonly eventRateWindowMs: number;
	readonly maxItemBytes: number;
	readonly maxTotalBytes: number;
	readonly maxArtifactRefs: number;
}

export interface ExternalAgentSupervisorOptions {
	readonly reference: ExternalAgentSupervisorReference;
	readonly containment: ExternalAgentProcessContainment;
	readonly processController: ExternalAgentProcessController;
	readonly deadlines?: ExternalAgentSupervisorDeadlineOverrides;
	readonly limits?: Partial<ExternalAgentSupervisorLimits>;
	readonly clock?: RuntimeClock;
}

export interface ExternalAgentSupervisorFailure {
	readonly code: ExternalAgentSupervisorErrorCode;
	readonly segment: ExternalAgentSupervisorSegment;
	readonly sideEffects: "unknown";
	readonly forcedTermination: boolean;
	readonly at: string;
}

export interface ExternalAgentSupervisorReceiptResult {
	readonly kind: "receipt";
	readonly reference: ExternalAgentSupervisorReference;
	readonly receipt: ExternalAgentReceipt;
	readonly events: ReadonlyArray<ExternalAgentEvent>;
	readonly eventCount: number;
	readonly totalBytes: number;
	readonly artifactRefCount: number;
}

export interface ExternalAgentSupervisorFailureResult {
	readonly kind: "failure";
	readonly reference: ExternalAgentSupervisorReference;
	readonly failure: ExternalAgentSupervisorFailure;
	readonly events: ReadonlyArray<ExternalAgentEvent>;
	readonly eventCount: number;
	readonly totalBytes: number;
	readonly artifactRefCount: number;
}

export type ExternalAgentSupervisorResult =
	| ExternalAgentSupervisorReceiptResult
	| ExternalAgentSupervisorFailureResult;

export interface ExternalAgentSupervisorSnapshot {
	readonly reference: ExternalAgentSupervisorReference;
	readonly phase: "idle" | "starting" | "running" | "cancelling" | "disposing" | "terminal" | "recovering";
	readonly eventCount: number;
	readonly totalBytes: number;
	readonly artifactRefCount: number;
	readonly forcedTermination: boolean;
	readonly quarantined: boolean;
}

export interface ExternalAgentSupervisedOperation {
	readonly reference: ExternalAgentSupervisorReference;
	readonly result: Promise<ExternalAgentSupervisorResult>;
	readonly events: ReadonlyArray<ExternalAgentEvent>;
	readonly snapshot: ExternalAgentSupervisorSnapshot;
	readonly hostPrivateState: ExternalAgentSupervisorPrivateState | undefined;
	cancel(): Promise<ExternalAgentSupervisorFailure | undefined>;
	dispose(): Promise<ExternalAgentSupervisorFailure | undefined>;
}

const DEFAULT_DEADLINES: Readonly<Record<ExternalAgentSupervisorSegment, ExternalAgentSegmentDeadline>> = Object.freeze({
	start: Object.freeze({ hardMs: 30_000, idleMs: 10_000 }),
	event: Object.freeze({ hardMs: 60 * 60_000, idleMs: 30_000 }),
	receipt: Object.freeze({ hardMs: 60 * 60_000, idleMs: 30_000 }),
	cancel: Object.freeze({ hardMs: 5_000, idleMs: 2_000 }),
	dispose: Object.freeze({ hardMs: 5_000, idleMs: 2_000 }),
});

const DEFAULT_LIMITS: Readonly<ExternalAgentSupervisorLimits> = Object.freeze({
	maxEvents: 256,
	maxEventsPerWindow: 64,
	eventRateWindowMs: 1_000,
	maxItemBytes: 256 * 1024,
	maxTotalBytes: 4 * 1024 * 1024,
	maxArtifactRefs: 64,
});

const REFERENCE_KEYS = new Set(["schemaVersion", "supervisorRef", "operationNonce"]);
const PROCESS_IDENTITY_KEYS = new Set(["pid", "startToken", "executableIdentity", "fileIdentity"]);
const PRIVATE_STATE_KEYS = new Set(["schemaVersion", "reference", "detached", "containment", "processIdentity"]);

interface Deferred<T> {
	readonly promise: Promise<T>;
	readonly resolve: (value: T) => void;
	readonly settled: () => boolean;
}

type SegmentTimerOutcome = { readonly deadline: "hard" | "idle" };

type AwaitOutcome<T> =
	| { readonly kind: "value"; readonly value: T }
	| { readonly kind: "rejected" }
	| { readonly kind: "timeout"; readonly deadline: "hard" | "idle" }
	| { readonly kind: "stopped" };

class SegmentTimeoutError extends Error {
	readonly segment: ExternalAgentSupervisorSegment;
	readonly deadline: "hard" | "idle";

	constructor(segment: ExternalAgentSupervisorSegment, deadline: "hard" | "idle") {
		super(`${segment} ${deadline} deadline exceeded`);
		this.name = "SegmentTimeoutError";
		this.segment = segment;
		this.deadline = deadline;
	}
}

class SegmentRejectedError extends Error {
	readonly segment: ExternalAgentSupervisorSegment;

	constructor(segment: ExternalAgentSupervisorSegment) {
		super(`${segment} rejected`);
		this.name = "SegmentRejectedError";
		this.segment = segment;
	}
}

class OperationStoppedError extends Error {
	constructor() {
		super("external agent supervision stopped");
		this.name = "OperationStoppedError";
	}
}

class SupervisorViolationError extends Error {
	readonly code: ExternalAgentSupervisorErrorCode;
	readonly segment: ExternalAgentSupervisorSegment;

	constructor(code: ExternalAgentSupervisorErrorCode, segment: ExternalAgentSupervisorSegment) {
		super(code);
		this.name = "SupervisorViolationError";
		this.code = code;
		this.segment = segment;
	}
}

class SegmentTimer {
	private readonly clock: RuntimeClock;
	private readonly deadline: ExternalAgentSegmentDeadline;
	private readonly timeout: Deferred<SegmentTimerOutcome>;
	private hardTimer: RuntimeTimerHandle | undefined;
	private idleTimer: RuntimeTimerHandle | undefined;

	constructor(clock: RuntimeClock, deadline: ExternalAgentSegmentDeadline) {
		this.clock = clock;
		this.deadline = deadline;
		this.timeout = deferred<SegmentTimerOutcome>();
		this.hardTimer = this.schedule("hard", deadline.hardMs);
		this.idleTimer = this.schedule("idle", deadline.idleMs);
	}

	get expired(): Promise<SegmentTimerOutcome> {
		return this.timeout.promise;
	}

	touch(): void {
		if (this.timeout.settled()) return;
		if (this.idleTimer !== undefined) this.clock.clearTimeout(this.idleTimer);
		this.idleTimer = this.schedule("idle", this.deadline.idleMs);
	}

	close(): void {
		if (this.hardTimer !== undefined) this.clock.clearTimeout(this.hardTimer);
		if (this.idleTimer !== undefined) this.clock.clearTimeout(this.idleTimer);
		this.hardTimer = undefined;
		this.idleTimer = undefined;
	}

	private schedule(deadline: "hard" | "idle", delayMs: number): RuntimeTimerHandle {
		const handle = this.clock.setTimeout(() => this.timeout.resolve({ deadline }), delayMs);
		this.clock.unrefTimeout(handle);
		return handle;
	}
}

function deferred<T>(): Deferred<T> {
	let resolver: ((value: T) => void) | undefined;
	let done = false;
	const promise = new Promise<T>((resolve) => {
		resolver = resolve;
	});
	return {
		promise,
		resolve: (value) => {
			if (done) return;
			done = true;
			resolver!(value);
		},
		settled: () => done,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: ReadonlySet<string>): boolean {
	return Object.keys(value).every((key) => keys.has(key));
}

function isPositiveBound(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function isExternalAgentSupervisorReference(value: unknown): value is ExternalAgentSupervisorReference {
	return (
		isRecord(value) &&
		hasOnlyKeys(value, REFERENCE_KEYS) &&
		value.schemaVersion === EXTERNAL_AGENT_SUPERVISOR_SCHEMA_VERSION &&
		isExternalMappingIdentifier(value.supervisorRef) &&
		isExternalMappingIdentifier(value.operationNonce)
	);
}

export function serializeExternalAgentSupervisorReference(
	value: unknown,
): ExternalAgentSupervisorReference | undefined {
	if (!isExternalAgentSupervisorReference(value)) return undefined;
	return Object.freeze({
		schemaVersion: EXTERNAL_AGENT_SUPERVISOR_SCHEMA_VERSION,
		supervisorRef: value.supervisorRef,
		operationNonce: value.operationNonce,
	});
}

export function isExternalAgentProcessIdentity(value: unknown): value is ExternalAgentProcessIdentity {
	return (
		isRecord(value) &&
		hasOnlyKeys(value, PROCESS_IDENTITY_KEYS) &&
		typeof value.pid === "number" &&
		Number.isSafeInteger(value.pid) &&
		value.pid > 0 &&
		isExternalMappingIdentifier(value.startToken) &&
		isExternalMappingIdentifier(value.executableIdentity) &&
		isExternalMappingIdentifier(value.fileIdentity)
	);
}

export function isExternalAgentSupervisorPrivateState(
	value: unknown,
): value is ExternalAgentSupervisorPrivateState {
	return (
		isRecord(value) &&
		hasOnlyKeys(value, PRIVATE_STATE_KEYS) &&
		value.schemaVersion === EXTERNAL_AGENT_SUPERVISOR_SCHEMA_VERSION &&
		isExternalAgentSupervisorReference(value.reference) &&
		value.detached === false &&
		(value.containment === "process_group" || value.containment === "job_object") &&
		isExternalAgentProcessIdentity(value.processIdentity)
	);
}

function sameReference(left: ExternalAgentSupervisorReference, right: ExternalAgentSupervisorReference): boolean {
	return left.supervisorRef === right.supervisorRef && left.operationNonce === right.operationNonce;
}

function sameProcessIdentity(left: ExternalAgentProcessIdentity, right: ExternalAgentProcessIdentity): boolean {
	return (
		left.pid === right.pid &&
		left.startToken === right.startToken &&
		left.executableIdentity === right.executableIdentity &&
		left.fileIdentity === right.fileIdentity
	);
}

function sameExternalRef(left: ExternalExecutionRef, right: ExternalExecutionRef): boolean {
	return (
		left.namespace === right.namespace &&
		left.externalSessionId === right.externalSessionId &&
		(left.externalRunId ?? undefined) === (right.externalRunId ?? undefined)
	);
}

function cloneProcessIdentity(identity: ExternalAgentProcessIdentity): ExternalAgentProcessIdentity {
	return Object.freeze({
		pid: identity.pid,
		startToken: identity.startToken,
		executableIdentity: identity.executableIdentity,
		fileIdentity: identity.fileIdentity,
	});
}

function mergeDeadlines(
	overrides: ExternalAgentSupervisorDeadlineOverrides | undefined,
): Readonly<Record<ExternalAgentSupervisorSegment, ExternalAgentSegmentDeadline>> {
	const merged = Object.fromEntries(
		EXTERNAL_AGENT_SUPERVISOR_SEGMENTS.map((segment) => {
			const value = {
				hardMs: overrides?.[segment]?.hardMs ?? DEFAULT_DEADLINES[segment].hardMs,
				idleMs: overrides?.[segment]?.idleMs ?? DEFAULT_DEADLINES[segment].idleMs,
			};
			if (!isPositiveBound(value.hardMs) || !isPositiveBound(value.idleMs)) {
				throw new RangeError(`External agent ${segment} deadlines must be positive safe integers`);
			}
			return [segment, Object.freeze(value)];
		}),
	) as unknown as Record<ExternalAgentSupervisorSegment, ExternalAgentSegmentDeadline>;
	return Object.freeze(merged);
}

function mergeLimits(overrides: Partial<ExternalAgentSupervisorLimits> | undefined): ExternalAgentSupervisorLimits {
	const limits: ExternalAgentSupervisorLimits = {
		maxEvents: overrides?.maxEvents ?? DEFAULT_LIMITS.maxEvents,
		maxEventsPerWindow: overrides?.maxEventsPerWindow ?? DEFAULT_LIMITS.maxEventsPerWindow,
		eventRateWindowMs: overrides?.eventRateWindowMs ?? DEFAULT_LIMITS.eventRateWindowMs,
		maxItemBytes: overrides?.maxItemBytes ?? DEFAULT_LIMITS.maxItemBytes,
		maxTotalBytes: overrides?.maxTotalBytes ?? DEFAULT_LIMITS.maxTotalBytes,
		maxArtifactRefs: overrides?.maxArtifactRefs ?? DEFAULT_LIMITS.maxArtifactRefs,
	};
	if (Object.values(limits).some((value) => !isPositiveBound(value))) {
		throw new RangeError("External agent supervisor limits must be positive safe integers");
	}
	return Object.freeze(limits);
}

function isProcessHandle(
	value: unknown,
	reference: ExternalAgentSupervisorReference,
	containment: ExternalAgentProcessContainment,
): value is ExternalAgentProcessHandle {
	if (!isRecord(value)) return false;
	const exited = value.exited;
	return (
		value.operationNonce === reference.operationNonce &&
		value.detached === false &&
		value.containment === containment &&
		isExternalAgentProcessIdentity(value.identity) &&
		typeof value.forceTerminate === "function" &&
		isRecord(exited) &&
		typeof exited.then === "function"
	);
}

function isAdapterHandle(value: unknown): value is ExternalAgentHandle {
	if (!isRecord(value) || !isExternalExecutionRef(value.external)) return false;
	const events = value.events;
	const receipt = value.receipt;
	return (
		isRecord(events) &&
		typeof Reflect.get(events, Symbol.asyncIterator) === "function" &&
		isRecord(receipt) &&
		typeof receipt.then === "function" &&
		typeof value.cancel === "function" &&
		typeof value.heartbeat === "function"
	);
}

function byteLength(value: unknown): number | undefined {
	try {
		const serialized = JSON.stringify(value);
		return typeof serialized === "string" ? Buffer.byteLength(serialized, "utf8") : undefined;
	} catch {
		return undefined;
	}
}

export class ExternalAgentSupervisor implements ExternalAgentSupervisedOperation {
	readonly reference: ExternalAgentSupervisorReference;
	readonly result: Promise<ExternalAgentSupervisorResult>;

	private readonly containment: ExternalAgentProcessContainment;
	private readonly processController: ExternalAgentProcessController;
	private readonly deadlines: Readonly<Record<ExternalAgentSupervisorSegment, ExternalAgentSegmentDeadline>>;
	private readonly limits: ExternalAgentSupervisorLimits;
	private readonly clock: RuntimeClock;
	private readonly resultDeferred: Deferred<ExternalAgentSupervisorResult>;
	private readonly stopped = deferred<void>();
	private readonly controller = new AbortController();
	private processHandle: ExternalAgentProcessHandle | undefined;
	private privateState: ExternalAgentSupervisorPrivateState | undefined;
	private adapterHandle: ExternalAgentHandle | undefined;
	private sourceSignal: AbortSignal | undefined;
	private acceptedEvents: ExternalAgentEvent[] = [];
	private eventTimes: number[] = [];
	private observedEventCount = 0;
	private totalByteCount = 0;
	private artifactCount = 0;
	private lastProgressSequence = 0;
	private startedEventSeen = false;
	private eventMode: "none" | "metadata" | "stream" = "none";
	private artifactsAllowed = false;
	private started = false;
	private resultDone = false;
	private forceIssued = false;
	private quarantinedValue = false;
	private phaseValue: ExternalAgentSupervisorSnapshot["phase"] = "idle";
	private failurePromise: Promise<ExternalAgentSupervisorFailure> | undefined;
	private cancelPromise: Promise<ExternalAgentSupervisorFailure | undefined> | undefined;

	constructor(options: ExternalAgentSupervisorOptions) {
		const reference = serializeExternalAgentSupervisorReference(options.reference);
		if (reference === undefined) throw new TypeError("External agent supervisor reference is invalid");
		if (options.containment !== "process_group" && options.containment !== "job_object") {
			throw new TypeError("External agent process containment is invalid");
		}
		if (typeof options.processController?.launch !== "function") {
			throw new TypeError("External agent process controller is invalid");
		}
		this.reference = reference;
		this.containment = options.containment;
		this.processController = options.processController;
		this.deadlines = mergeDeadlines(options.deadlines);
		this.limits = mergeLimits(options.limits);
		this.clock = options.clock ?? SYSTEM_RUNTIME_CLOCK;
		this.resultDeferred = deferred<ExternalAgentSupervisorResult>();
		this.result = this.resultDeferred.promise;
	}

	get events(): ReadonlyArray<ExternalAgentEvent> {
		return Object.freeze([...this.acceptedEvents]);
	}

	get snapshot(): ExternalAgentSupervisorSnapshot {
		return Object.freeze({
			reference: this.reference,
			phase: this.phaseValue,
			eventCount: this.observedEventCount,
			totalBytes: this.totalByteCount,
			artifactRefCount: this.artifactCount,
			forcedTermination: this.forceIssued,
			quarantined: this.quarantinedValue,
		});
	}

	get hostPrivateState(): ExternalAgentSupervisorPrivateState | undefined {
		const state = this.privateState;
		if (state === undefined) return undefined;
		return Object.freeze({
			schemaVersion: EXTERNAL_AGENT_SUPERVISOR_SCHEMA_VERSION,
			reference: this.reference,
			detached: false,
			containment: state.containment,
			processIdentity: cloneProcessIdentity(state.processIdentity),
		});
	}

	start(adapter: ExternalAgentAdapter, request: ExternalAgentStartRequest, signal?: AbortSignal): ExternalAgentSupervisedOperation {
		if (this.started) throw new Error("External agent supervisor is single-use");
		if (!isExternalAgentStartRequest(request) || adapter.id !== request.preparedBinding.adapterId) {
			throw new ExternalAgentError("external_agent_adapter_invalid");
		}
		this.started = true;
		this.phaseValue = "starting";
		this.eventMode = request.preparedBinding.capabilities.events;
		this.artifactsAllowed = request.preparedBinding.capabilities.artifacts;
		let processHandle: ExternalAgentProcessHandle;
		try {
			processHandle = this.processController.launch(this.launchRequest());
		} catch {
			this.settleDirectFailure("reconcile_required", "start", false);
			return this;
		}
		if (!isProcessHandle(processHandle, this.reference, this.containment)) {
			// A mismatched handle may name a reused or unrelated process. Never signal it.
			this.quarantinedValue = true;
			this.settleDirectFailure("reconcile_required", "start", false);
			return this;
		}
		this.bindProcess(processHandle);
		this.sourceSignal = signal;
		if (signal !== undefined) {
			signal.addEventListener("abort", this.onSourceAbort, { once: true });
			if (signal.aborted) this.clock.queueMicrotask(this.onSourceAbort);
		}
		void this.run(adapter, request);
		return this;
	}

	async recoverAndReap(stateValue: unknown): Promise<ExternalAgentSupervisorResult> {
		if (this.started) throw new Error("External agent supervisor is single-use");
		this.started = true;
		this.phaseValue = "recovering";
		if (
			!isExternalAgentSupervisorPrivateState(stateValue) ||
			!sameReference(stateValue.reference, this.reference) ||
			stateValue.containment !== this.containment
		) {
			this.quarantinedValue = true;
			this.settleDirectFailure("reconcile_required", "dispose", false);
			return this.result;
		}
		const reattach = this.processController.reattach;
		if (reattach === undefined) {
			this.quarantinedValue = true;
			this.settleDirectFailure("reconcile_required", "dispose", false);
			return this.result;
		}
		let recovered: ExternalAgentProcessReattachResult;
		try {
			recovered = reattach.call(this.processController, stateValue.processIdentity, this.launchRequest());
		} catch {
			this.quarantinedValue = true;
			this.settleDirectFailure("reconcile_required", "dispose", false);
			return this.result;
		}
		if (recovered.status !== "attached") {
			// not_found, PID reuse, and ambiguity are all reconciliation states.
			this.quarantinedValue = true;
			this.settleDirectFailure("reconcile_required", "dispose", false);
			return this.result;
		}
		if (
			!isProcessHandle(recovered.handle, this.reference, this.containment) ||
			!sameProcessIdentity(recovered.handle.identity, stateValue.processIdentity)
		) {
			// Refuse the handle without signalling it: exact identity was not proven.
			this.quarantinedValue = true;
			this.settleDirectFailure("reconcile_required", "dispose", false);
			return this.result;
		}
		this.bindProcess(recovered.handle);
		await this.requestFailure("side_effect_unknown", "dispose");
		return this.result;
	}

	cancel(): Promise<ExternalAgentSupervisorFailure | undefined> {
		if (this.resultDone) return Promise.resolve(undefined);
		this.cancelPromise ??= this.performCancel();
		return this.cancelPromise;
	}

	async dispose(): Promise<ExternalAgentSupervisorFailure | undefined> {
		if (!this.started || this.processHandle === undefined) return undefined;
		if (!this.resultDone) return this.requestFailure("side_effect_unknown", "dispose");
		if (this.forceIssued) {
			const result = await this.result;
			return result.kind === "failure" ? result.failure : undefined;
		}
		this.phaseValue = "disposing";
		const cleaned = await this.forceAndWait();
		this.phaseValue = "terminal";
		if (cleaned) return undefined;
		this.quarantinedValue = true;
		return this.createFailure("reconcile_required", "dispose", true);
	}

	private readonly onSourceAbort = (): void => {
		void this.cancel();
	};

	private launchRequest(): ExternalAgentProcessLaunchRequest {
		return Object.freeze({
			supervisorRef: this.reference.supervisorRef,
			operationNonce: this.reference.operationNonce,
			detached: false,
			containment: this.containment,
		});
	}

	private bindProcess(handle: ExternalAgentProcessHandle): void {
		this.processHandle = handle;
		this.privateState = Object.freeze({
			schemaVersion: EXTERNAL_AGENT_SUPERVISOR_SCHEMA_VERSION,
			reference: this.reference,
			detached: false,
			containment: this.containment,
			processIdentity: cloneProcessIdentity(handle.identity),
		});
		void handle.exited.then(
			() => {
				if (!this.resultDone && !this.forceIssued) void this.requestFailure("side_effect_unknown", "receipt");
			},
			() => {
				if (!this.resultDone && !this.forceIssued) void this.requestFailure("reconcile_required", "dispose");
			},
		);
	}

	private async run(adapter: ExternalAgentAdapter, request: ExternalAgentStartRequest): Promise<void> {
		try {
			const handle = await this.awaitSegment(
				"start",
				Promise.resolve().then(() =>
					adapter.start(request, {
						signal: this.controller.signal,
						...(request.deadlineAt === undefined ? {} : { deadlineAt: request.deadlineAt }),
					}),
				),
			);
			if (!isAdapterHandle(handle)) throw new SupervisorViolationError("side_effect_unknown", "start");
			this.adapterHandle = handle;
			this.phaseValue = "running";
			const [, receipt] = await Promise.all([this.consumeEvents(handle), this.receiveReceipt(handle)]);
			if (this.resultDone) return;
			if (receipt.status === "cancelled" && receipt.sideEffects !== "none") {
				await this.requestFailure("side_effect_unknown", "receipt");
				return;
			}
			this.settleReceipt(receipt);
		} catch (error) {
			if (error instanceof OperationStoppedError || this.resultDone) return;
			if (error instanceof SupervisorViolationError) {
				await this.requestFailure(error.code, error.segment);
				return;
			}
			if (error instanceof SegmentTimeoutError || error instanceof SegmentRejectedError) {
				await this.requestFailure("side_effect_unknown", error.segment);
				return;
			}
			await this.requestFailure("side_effect_unknown", "receipt");
		}
	}

	private async consumeEvents(handle: ExternalAgentHandle): Promise<void> {
		const budget = new SegmentTimer(this.clock, this.deadlines.event);
		let iterator: AsyncIterator<ExternalAgentEvent>;
		try {
			iterator = handle.events[Symbol.asyncIterator]();
		} catch {
			budget.close();
			throw new SegmentRejectedError("event");
		}
		try {
			for (;;) {
				const outcome = await Promise.race<AwaitOutcome<IteratorResult<ExternalAgentEvent>>>([
					Promise.resolve()
						.then(() => iterator.next())
						.then(
							(value): AwaitOutcome<IteratorResult<ExternalAgentEvent>> => ({ kind: "value", value }),
							(): AwaitOutcome<IteratorResult<ExternalAgentEvent>> => ({ kind: "rejected" }),
						),
					budget.expired.then(
						(value): AwaitOutcome<IteratorResult<ExternalAgentEvent>> => ({ kind: "timeout", deadline: value.deadline }),
					),
					this.stopped.promise.then(
						(): AwaitOutcome<IteratorResult<ExternalAgentEvent>> => ({ kind: "stopped" }),
					),
				]);
				if (outcome.kind === "timeout") throw new SegmentTimeoutError("event", outcome.deadline);
				if (outcome.kind === "rejected") throw new SegmentRejectedError("event");
				if (outcome.kind === "stopped") throw new OperationStoppedError();
				budget.touch();
				if (outcome.value.done) return;
				this.acceptEvent(outcome.value.value, handle.external);
			}
		} finally {
			budget.close();
		}
	}

	private async receiveReceipt(handle: ExternalAgentHandle): Promise<ExternalAgentReceipt> {
		const value = await this.awaitSegment(
			"receipt",
			Promise.resolve().then(() => handle.receipt),
		);
		this.observeBytes(value, "receipt", "side_effect_unknown");
		if (isRecord(value) && Array.isArray(value.artifactRefs)) {
			if (value.artifactRefs.length + this.artifactCount > this.limits.maxArtifactRefs) {
				throw new SupervisorViolationError("external_resource_limit_exceeded", "receipt");
			}
		}
		if (!isExternalAgentReceipt(value) || !sameExternalRef(value.external, handle.external)) {
			throw new SupervisorViolationError("side_effect_unknown", "receipt");
		}
		if (!this.artifactsAllowed && value.artifactRefs.length > 0) {
			throw new SupervisorViolationError("side_effect_unknown", "receipt");
		}
		this.artifactCount += value.artifactRefs.length;
		const receipt = serializeExternalAgentReceipt(value);
		if (receipt === undefined) throw new SupervisorViolationError("side_effect_unknown", "receipt");
		return receipt;
	}

	private acceptEvent(value: unknown, external: ExternalExecutionRef): void {
		this.observedEventCount += 1;
		if (this.observedEventCount > this.limits.maxEvents) {
			throw new SupervisorViolationError("external_resource_limit_exceeded", "event");
		}
		const now = this.clock.monotonicNow();
		const earliest = now - this.limits.eventRateWindowMs;
		this.eventTimes = this.eventTimes.filter((timestamp) => timestamp > earliest);
		this.eventTimes.push(now);
		if (this.eventTimes.length > this.limits.maxEventsPerWindow) {
			throw new SupervisorViolationError("external_resource_limit_exceeded", "event");
		}
		this.observeBytes(value, "event", "external_event_invalid");
		if (!isExternalAgentEvent(value) || !sameExternalRef(value.external, external)) {
			throw new SupervisorViolationError("external_event_invalid", "event");
		}
		if (this.eventMode === "none") throw new SupervisorViolationError("external_event_invalid", "event");
		if (this.adapterHandle?.external !== undefined && !sameExternalRef(value.external, this.adapterHandle.external)) {
			throw new SupervisorViolationError("external_event_invalid", "event");
		}
		if (value.type === "started") {
			if (this.startedEventSeen) throw new SupervisorViolationError("external_event_invalid", "event");
			this.startedEventSeen = true;
		}
		if (value.type === "progress") {
			if (value.sequence <= this.lastProgressSequence) {
				throw new SupervisorViolationError("external_event_invalid", "event");
			}
			this.lastProgressSequence = value.sequence;
		}
		if (value.type === "artifact") {
			if (!this.artifactsAllowed) throw new SupervisorViolationError("external_event_invalid", "event");
			this.artifactCount += 1;
			if (this.artifactCount > this.limits.maxArtifactRefs) {
				throw new SupervisorViolationError("external_resource_limit_exceeded", "event");
			}
		}
		const event = serializeExternalAgentEvent(value);
		if (event === undefined) throw new SupervisorViolationError("external_event_invalid", "event");
		this.acceptedEvents.push(event);
	}

	private observeBytes(
		value: unknown,
		segment: "event" | "receipt",
		invalidCode: "external_event_invalid" | "side_effect_unknown",
	): void {
		const bytes = byteLength(value);
		if (bytes === undefined) throw new SupervisorViolationError(invalidCode, segment);
		if (bytes > this.limits.maxItemBytes || this.totalByteCount + bytes > this.limits.maxTotalBytes) {
			throw new SupervisorViolationError("external_resource_limit_exceeded", segment);
		}
		this.totalByteCount += bytes;
	}

	private async performCancel(): Promise<ExternalAgentSupervisorFailure | undefined> {
		if (!this.controller.signal.aborted) this.controller.abort();
		this.phaseValue = "cancelling";
		const handle = this.adapterHandle;
		if (handle === undefined) return this.requestFailure("side_effect_unknown", "cancel");
		try {
			await this.awaitSegment("cancel", Promise.resolve().then(() => handle.cancel()));
			return undefined;
		} catch (error) {
			if (error instanceof OperationStoppedError || this.resultDone) return undefined;
			return this.requestFailure("side_effect_unknown", "cancel");
		}
	}

	private async awaitSegment<T>(
		segment: ExternalAgentSupervisorSegment,
		promise: Promise<T>,
		observeOperationStop = true,
	): Promise<T> {
		const budget = new SegmentTimer(this.clock, this.deadlines[segment]);
		try {
			const candidates: Promise<AwaitOutcome<T>>[] = [
				promise.then(
					(value): AwaitOutcome<T> => ({ kind: "value", value }),
					(): AwaitOutcome<T> => ({ kind: "rejected" }),
				),
				budget.expired.then((value): AwaitOutcome<T> => ({ kind: "timeout", deadline: value.deadline })),
			];
			if (observeOperationStop) {
				candidates.push(this.stopped.promise.then((): AwaitOutcome<T> => ({ kind: "stopped" })));
			}
			const outcome = await Promise.race(candidates);
			if (outcome.kind === "value") return outcome.value;
			if (outcome.kind === "timeout") throw new SegmentTimeoutError(segment, outcome.deadline);
			if (outcome.kind === "rejected") throw new SegmentRejectedError(segment);
			throw new OperationStoppedError();
		} finally {
			budget.close();
		}
	}

	private requestFailure(
		code: ExternalAgentSupervisorErrorCode,
		segment: ExternalAgentSupervisorSegment,
	): Promise<ExternalAgentSupervisorFailure> {
		this.failurePromise ??= (async () => {
			this.phaseValue = "disposing";
			if (!this.controller.signal.aborted) this.controller.abort();
			const cleaned = await this.forceAndWait();
			const finalCode = cleaned ? code : "reconcile_required";
			if (!cleaned) this.quarantinedValue = true;
			const failure = this.createFailure(finalCode, cleaned ? segment : "dispose", this.forceIssued);
			this.settleFailure(failure);
			return failure;
		})();
		return this.failurePromise;
	}

	private async forceAndWait(): Promise<boolean> {
		const handle = this.processHandle;
		if (handle === undefined) return false;
		if (!this.forceIssued) {
			this.forceIssued = true;
			try {
				handle.forceTerminate();
			} catch {
				return false;
			}
		}
		try {
			await this.awaitSegment("dispose", handle.exited, false);
			return true;
		} catch {
			return false;
		}
	}

	private createFailure(
		code: ExternalAgentSupervisorErrorCode,
		segment: ExternalAgentSupervisorSegment,
		forcedTermination: boolean,
	): ExternalAgentSupervisorFailure {
		return Object.freeze({
			code,
			segment,
			sideEffects: "unknown",
			forcedTermination,
			at: new Date(this.clock.wallNow()).toISOString(),
		});
	}

	private settleReceipt(receipt: ExternalAgentReceipt): void {
		if (this.resultDone) return;
		this.resultDone = true;
		this.phaseValue = "terminal";
		this.removeSourceAbort();
		this.stopped.resolve();
		this.resultDeferred.resolve(Object.freeze({
			kind: "receipt",
			reference: this.reference,
			receipt,
			events: this.events,
			eventCount: this.observedEventCount,
			totalBytes: this.totalByteCount,
			artifactRefCount: this.artifactCount,
		}));
	}

	private settleFailure(failure: ExternalAgentSupervisorFailure): void {
		if (this.resultDone) return;
		this.resultDone = true;
		this.phaseValue = "terminal";
		this.removeSourceAbort();
		this.stopped.resolve();
		this.resultDeferred.resolve(Object.freeze({
			kind: "failure",
			reference: this.reference,
			failure,
			events: this.events,
			eventCount: this.observedEventCount,
			totalBytes: this.totalByteCount,
			artifactRefCount: this.artifactCount,
		}));
	}

	private settleDirectFailure(
		code: ExternalAgentSupervisorErrorCode,
		segment: ExternalAgentSupervisorSegment,
		forcedTermination: boolean,
	): void {
		this.settleFailure(this.createFailure(code, segment, forcedTermination));
	}

	private removeSourceAbort(): void {
		this.sourceSignal?.removeEventListener("abort", this.onSourceAbort);
		this.sourceSignal = undefined;
	}
}

export type ExternalConnectorSupervisorSegment = "start" | "event" | "receipt" | "cancel" | "dispose";

export interface ExternalConnectorBoundedSupervisorOptions {
	readonly deadlines?: Partial<Record<ExternalConnectorSupervisorSegment, number>>;
	readonly maxEvents?: number;
	readonly maxEventsPerWindow?: number;
	readonly eventRateWindowMs?: number;
	readonly maxItemBytes?: number;
	readonly maxTotalBytes?: number;
	readonly maxArtifactRefs?: number;
	readonly forceTerminate: () => Promise<void>;
}

const CURRENT_CONNECTOR_DEADLINES: Readonly<Record<ExternalConnectorSupervisorSegment, number>> = Object.freeze({
	start: 30_000,
	event: 30_000,
	receipt: 60 * 60_000,
	cancel: 5_000,
	dispose: 5_000,
});

/** Bounded supervisor used by the current External Connector lifecycle. */
export class ExternalConnectorBoundedSupervisor {
	readonly #deadlines: Readonly<Record<ExternalConnectorSupervisorSegment, number>>;
	readonly #maxEvents: number;
	readonly #maxEventsPerWindow: number;
	readonly #eventRateWindowMs: number;
	readonly #maxItemBytes: number;
	readonly #maxTotalBytes: number;
	readonly #maxArtifactRefs: number;
	readonly #forceTerminate: () => Promise<void>;

	constructor(options: ExternalConnectorBoundedSupervisorOptions) {
		const deadlines = { ...CURRENT_CONNECTOR_DEADLINES, ...options.deadlines };
		if (Object.values(deadlines).some((value) => !Number.isSafeInteger(value) || value <= 0)) {
			throw new RangeError("External Connector supervisor deadlines must be positive safe integers");
		}
		this.#deadlines = Object.freeze(deadlines);
		this.#maxEvents = options.maxEvents ?? 256;
		this.#maxEventsPerWindow = options.maxEventsPerWindow ?? 64;
		this.#eventRateWindowMs = options.eventRateWindowMs ?? 1_000;
		this.#maxItemBytes = options.maxItemBytes ?? 256 * 1024;
		this.#maxTotalBytes = options.maxTotalBytes ?? 4 * 1024 * 1024;
		this.#maxArtifactRefs = options.maxArtifactRefs ?? 64;
		this.#forceTerminate = options.forceTerminate;
		if (
			[this.#maxEvents, this.#maxEventsPerWindow, this.#eventRateWindowMs, this.#maxItemBytes, this.#maxTotalBytes, this.#maxArtifactRefs]
				.some((value) => !Number.isSafeInteger(value) || value <= 0)
		) {
			throw new RangeError("External Connector supervisor limits must be positive safe integers");
		}
	}

	async run<T>(
		segment: ExternalConnectorSupervisorSegment,
		operation: (signal: AbortSignal) => Promise<T>,
		sourceSignal?: AbortSignal,
	): Promise<T> {
		const controller = new AbortController();
		const abort = (): void => controller.abort(sourceSignal?.reason);
		sourceSignal?.addEventListener("abort", abort, { once: true });
		if (sourceSignal?.aborted === true) abort();
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const timeout = new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => {
					controller.abort();
					reject(new FoundationError("side_effect_unknown", `External Connector ${segment} deadline exceeded`));
				}, this.#deadlines[segment]);
				if (typeof timer === "object" && "unref" in timer && typeof timer.unref === "function") timer.unref();
			});
			const value = await Promise.race([operation(controller.signal), timeout]);
			if (segment === "event" || segment === "receipt") this.#observeBoundedValue(value, segment);
			return value;
		} catch (error) {
			if (!controller.signal.aborted) throw error;
			await this.forceTerminate();
			throw error;
		} finally {
			if (timer !== undefined) clearTimeout(timer);
			sourceSignal?.removeEventListener("abort", abort);
		}
	}

	async forceTerminate(): Promise<void> {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				this.#forceTerminate().catch(() => undefined),
				new Promise<void>((resolve) => {
					timer = setTimeout(resolve, this.#deadlines.dispose);
					if (typeof timer === "object" && "unref" in timer && typeof timer.unref === "function") timer.unref();
				}),
			]);
		} finally {
			if (timer !== undefined) clearTimeout(timer);
		}
	}

	async consumeEvents(events: AsyncIterable<unknown>, sourceSignal?: AbortSignal): Promise<void> {
		const controller = new AbortController();
		const abort = (): void => controller.abort(sourceSignal?.reason);
		sourceSignal?.addEventListener("abort", abort, { once: true });
		if (sourceSignal?.aborted === true) abort();
		const wallTimer = setTimeout(() => controller.abort(), this.#deadlines.event);
		if (typeof wallTimer === "object" && "unref" in wallTimer && typeof wallTimer.unref === "function") wallTimer.unref();
		let eventCount = 0;
		let totalBytes = 0;
		let eventTimes: number[] = [];
		try {
			const iterator = events[Symbol.asyncIterator]();
			for (;;) {
				const next = await this.run("event", () => iterator.next(), controller.signal);
				if (next.done) return;
				eventCount += 1;
				if (eventCount > this.#maxEvents) {
					throw new FoundationError("side_effect_unknown", "External Connector event count exceeded its bound");
				}
				let serialized: string;
				try {
					serialized = JSON.stringify(next.value);
				} catch {
					throw new FoundationError("side_effect_unknown", "External Connector event is not serializable");
				}
				totalBytes += Buffer.byteLength(serialized, "utf8");
				if (totalBytes > this.#maxTotalBytes) {
					throw new FoundationError("side_effect_unknown", "External Connector event bytes exceeded their bound");
				}
				const now = Date.now();
				eventTimes = eventTimes.filter((timestamp) => timestamp > now - this.#eventRateWindowMs);
				eventTimes.push(now);
				if (eventTimes.length > this.#maxEventsPerWindow) {
					throw new FoundationError("side_effect_unknown", "External Connector event rate exceeded its bound");
				}
			}
		} catch (error) {
			await this.forceTerminate();
			throw error;
		} finally {
			clearTimeout(wallTimer);
			sourceSignal?.removeEventListener("abort", abort);
		}
	}

	#observeBoundedValue(value: unknown, segment: "event" | "receipt"): void {
		let serialized: string;
		try {
			serialized = JSON.stringify(value);
		} catch {
			throw new FoundationError("side_effect_unknown", `External Connector ${segment} is not serializable`);
		}
		if (Buffer.byteLength(serialized, "utf8") > this.#maxItemBytes) {
			throw new FoundationError("side_effect_unknown", `External Connector ${segment} exceeded its byte bound`);
		}
		if (
			value !== null &&
			typeof value === "object" &&
			"artifacts" in value &&
			Array.isArray(value.artifacts) &&
			value.artifacts.length > this.#maxArtifactRefs
		) {
			throw new FoundationError("side_effect_unknown", `External Connector ${segment} exceeded its artifact bound`);
		}
	}
}
