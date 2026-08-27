/** Host-private, process-bound supervision for the current External Connector path. */

import { Buffer } from "node:buffer";
import { FoundationError } from "@aos-agent/agent-core";
import { LockedAtomicFileStorage } from "./control-plane-atomic-storage.ts";
import { isExternalConnectorMappingIdentifier } from "./external-session-mapping.ts";
import { SYSTEM_RUNTIME_CLOCK, type RuntimeClock, type RuntimeTimerHandle } from "./runtime-clock.ts";
import {
	isExternalConnectorDriverEvent,
	isExternalConnectorTerminalEvidence,
	type ExternalConnectorDriverEvent,
	type ExternalConnectorDriverHandle,
} from "./vendor-drivers/types.ts";

export const EXTERNAL_CONNECTOR_SUPERVISOR_SCHEMA_VERSION = 1 as const;
export const EXTERNAL_CONNECTOR_SUPERVISOR_SEGMENTS = ["start", "event", "receipt", "cancel", "dispose"] as const;
export type ExternalConnectorSupervisorSegment = (typeof EXTERNAL_CONNECTOR_SUPERVISOR_SEGMENTS)[number];
export type ExternalConnectorSupervisorErrorCode =
	| "external_event_invalid"
	| "external_resource_limit_exceeded"
	| "external_tool_route_denied"
	| "terminal_evidence_invalid"
	| "tool_gateway_ambiguous"
	| "tool_gateway_callback_failed"
	| "side_effect_unknown"
	| "reconcile_required";
export type ExternalConnectorProcessContainment = "process_group" | "job_object";

export function externalConnectorProcessContainment(
	platform: string = process.platform,
): ExternalConnectorProcessContainment {
	if (platform === "linux" || platform === "darwin") return "process_group";
	if (platform === "win32") return "job_object";
	throw new TypeError(`External Connector process supervision is unsupported on ${platform}`);
}

export interface ExternalConnectorSupervisorReference {
	readonly schemaVersion: typeof EXTERNAL_CONNECTOR_SUPERVISOR_SCHEMA_VERSION;
	readonly supervisorRef: string;
	readonly operationNonce: string;
}

export interface ExternalConnectorProcessIdentity {
	readonly pid: number;
	readonly startToken: string;
	readonly executableIdentity: string;
	readonly fileIdentity: string;
}

export interface ExternalConnectorSupervisorPrivateState {
	readonly schemaVersion: typeof EXTERNAL_CONNECTOR_SUPERVISOR_SCHEMA_VERSION;
	readonly reference: ExternalConnectorSupervisorReference;
	readonly detached: false;
	readonly containment: ExternalConnectorProcessContainment;
	readonly processIdentity: ExternalConnectorProcessIdentity;
}

export interface ExternalConnectorProcessLaunchRequest {
	readonly supervisorRef: string;
	readonly operationNonce: string;
	readonly detached: false;
	readonly containment: ExternalConnectorProcessContainment;
}

export interface ExternalConnectorProcessHandle {
	readonly operationNonce: string;
	readonly detached: false;
	readonly containment: ExternalConnectorProcessContainment;
	readonly identity: ExternalConnectorProcessIdentity;
	readonly exited: Promise<void>;
	/** Release a parent-death guard only after the private process identity is durable. */
	activate(options?: { readonly signal?: AbortSignal }): Promise<void>;
	/** Immediately compare the nonce and full live identity before terminating the contained process. */
	forceTerminate(request: ExternalConnectorProcessTerminationRequest): ExternalConnectorProcessTerminationResult;
}

export interface ExternalConnectorProcessTerminationRequest {
	readonly operationNonce: string;
	readonly processIdentity: ExternalConnectorProcessIdentity;
}

export type ExternalConnectorProcessTerminationResult =
	| "termination_requested"
	| "already_exited"
	| "identity_mismatch"
	| "ambiguous";

export type ExternalConnectorProcessReattachResult =
	| { readonly status: "attached"; readonly handle: ExternalConnectorProcessHandle }
	| { readonly status: "not_found" | "identity_mismatch" | "ambiguous" };

export interface ExternalConnectorProcessController {
	/** Launch inactive inside the requested non-detached process group or Windows Job containment. */
	launch(
		request: ExternalConnectorProcessLaunchRequest,
		options?: { readonly signal?: AbortSignal },
	): Promise<ExternalConnectorProcessHandle>;
	/** Reattach only when the nonce and full live identity match; PID-only lookup is forbidden. */
	reattach?(
		identity: ExternalConnectorProcessIdentity,
		request: ExternalConnectorProcessLaunchRequest,
	): ExternalConnectorProcessReattachResult;
}

export interface ExternalConnectorSupervisorPrivateStateStore {
	list(): Promise<readonly ExternalConnectorSupervisorPrivateStateEntry[]>;
	read(attemptId: string): Promise<ExternalConnectorSupervisorPrivateState | undefined>;
	write(attemptId: string, state: ExternalConnectorSupervisorPrivateState): Promise<void>;
	delete(attemptId: string): Promise<void>;
}

export interface ExternalConnectorSupervisorPrivateStateEntry {
	readonly attemptId: string;
	readonly state: ExternalConnectorSupervisorPrivateState;
}

const EXTERNAL_CONNECTOR_PRIVATE_STATE_FILE_SCHEMA_VERSION = 1 as const;

interface ExternalConnectorSupervisorPrivateStateFile {
	readonly schemaVersion: typeof EXTERNAL_CONNECTOR_PRIVATE_STATE_FILE_SCHEMA_VERSION;
	readonly attempts: Readonly<Record<string, ExternalConnectorSupervisorPrivateState>>;
}

const PRIVATE_STATE_FILE_KEYS = new Set(["schemaVersion", "attempts"]);

function isExternalConnectorSupervisorPrivateStateFile(
	value: unknown,
): value is ExternalConnectorSupervisorPrivateStateFile {
	if (
		!isRecord(value) ||
		!hasOnlyKeys(value, PRIVATE_STATE_FILE_KEYS) ||
		value.schemaVersion !== EXTERNAL_CONNECTOR_PRIVATE_STATE_FILE_SCHEMA_VERSION ||
		!isRecord(value.attempts)
	) {
		return false;
	}
	return Object.entries(value.attempts).every(
		([attemptId, state]) =>
			isExternalConnectorMappingIdentifier(attemptId) && isExternalConnectorSupervisorPrivateState(state),
	);
}

function parseExternalConnectorSupervisorPrivateStateFile(
	content: string | undefined,
): ExternalConnectorSupervisorPrivateStateFile {
	let value: unknown;
	try {
		value = JSON.parse(content ?? "");
	} catch {
		throw new TypeError("External Connector supervisor private state file is invalid");
	}
	if (!isExternalConnectorSupervisorPrivateStateFile(value)) {
		throw new TypeError("External Connector supervisor private state file is invalid");
	}
	return value;
}

function serializeExternalConnectorSupervisorPrivateStateFile(
	value: ExternalConnectorSupervisorPrivateStateFile,
): string {
	return `${JSON.stringify(value)}\n`;
}

/** Crash-safe restricted local storage for process identity. Never place this file in canonical Session storage. */
export class FileExternalConnectorSupervisorPrivateStateStore implements ExternalConnectorSupervisorPrivateStateStore {
	readonly #storage: LockedAtomicFileStorage;

	constructor(path: string) {
		if (typeof path !== "string" || path.length === 0) {
			throw new TypeError("External Connector supervisor private state path is invalid");
		}
		const initial = serializeExternalConnectorSupervisorPrivateStateFile({
			schemaVersion: EXTERNAL_CONNECTOR_PRIVATE_STATE_FILE_SCHEMA_VERSION,
			attempts: {},
		});
		this.#storage = new LockedAtomicFileStorage(path, initial, {
			validate: (content) => {
				parseExternalConnectorSupervisorPrivateStateFile(content);
			},
			mode: 0o600,
			directoryMode: 0o700,
		});
	}

	async list(): Promise<readonly ExternalConnectorSupervisorPrivateStateEntry[]> {
		return this.#storage.withLock((content) => {
			const current = parseExternalConnectorSupervisorPrivateStateFile(content);
			const entries = Object.entries(current.attempts)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([attemptId, state]) => Object.freeze({ attemptId, state: clonePrivateState(state) }));
			return { result: Object.freeze(entries) };
		});
	}

	async read(attemptId: string): Promise<ExternalConnectorSupervisorPrivateState | undefined> {
		this.#assertAttemptId(attemptId);
		return this.#storage.withLock((content) => {
			const current = parseExternalConnectorSupervisorPrivateStateFile(content);
			const state = current.attempts[attemptId];
			return { result: state === undefined ? undefined : clonePrivateState(state) };
		});
	}

	async write(attemptId: string, state: ExternalConnectorSupervisorPrivateState): Promise<void> {
		this.#assertAttemptId(attemptId);
		if (!isExternalConnectorSupervisorPrivateState(state)) {
			throw new TypeError("External Connector supervisor private state is invalid");
		}
		this.#storage.withLock((content) => {
			const current = parseExternalConnectorSupervisorPrivateStateFile(content);
			const existing = current.attempts[attemptId];
			if (existing !== undefined && !samePrivateState(existing, state)) {
				throw new Error("External Connector supervisor private state identity conflict");
			}
			if (existing !== undefined) return { result: undefined };
			return {
				result: undefined,
				next: serializeExternalConnectorSupervisorPrivateStateFile({
					schemaVersion: EXTERNAL_CONNECTOR_PRIVATE_STATE_FILE_SCHEMA_VERSION,
					attempts: { ...current.attempts, [attemptId]: clonePrivateState(state) },
				}),
			};
		});
	}

	async delete(attemptId: string): Promise<void> {
		this.#assertAttemptId(attemptId);
		this.#storage.withLock((content) => {
			const current = parseExternalConnectorSupervisorPrivateStateFile(content);
			if (current.attempts[attemptId] === undefined) return { result: undefined };
			const attempts = { ...current.attempts };
			delete attempts[attemptId];
			return {
				result: undefined,
				next: serializeExternalConnectorSupervisorPrivateStateFile({
					schemaVersion: EXTERNAL_CONNECTOR_PRIVATE_STATE_FILE_SCHEMA_VERSION,
					attempts,
				}),
			};
		});
	}

	#assertAttemptId(attemptId: string): void {
		if (!isExternalConnectorMappingIdentifier(attemptId)) {
			throw new TypeError("External Connector supervisor Attempt id is invalid");
		}
	}
}

export class InMemoryExternalConnectorSupervisorPrivateStateStore
	implements ExternalConnectorSupervisorPrivateStateStore
{
	readonly #states = new Map<string, ExternalConnectorSupervisorPrivateState>();

	async list(): Promise<readonly ExternalConnectorSupervisorPrivateStateEntry[]> {
		return Object.freeze(
			[...this.#states.entries()]
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([attemptId, state]) => Object.freeze({ attemptId, state: clonePrivateState(state) })),
		);
	}

	async read(attemptId: string): Promise<ExternalConnectorSupervisorPrivateState | undefined> {
		const state = this.#states.get(attemptId);
		return state === undefined ? undefined : clonePrivateState(state);
	}

	async write(attemptId: string, state: ExternalConnectorSupervisorPrivateState): Promise<void> {
		if (!isExternalConnectorSupervisorPrivateState(state)) {
			throw new TypeError("External Connector supervisor private state is invalid");
		}
		this.#states.set(attemptId, clonePrivateState(state));
	}

	async delete(attemptId: string): Promise<void> {
		this.#states.delete(attemptId);
	}
}

export interface ExternalConnectorSegmentDeadline {
	readonly hardMs: number;
	readonly idleMs: number;
}

export type ExternalConnectorSupervisorDeadlineOverrides = {
	readonly [Segment in ExternalConnectorSupervisorSegment]?: Partial<ExternalConnectorSegmentDeadline>;
};

export interface ExternalConnectorSupervisorLimits {
	readonly maxEvents: number;
	readonly maxEventsPerWindow: number;
	readonly eventRateWindowMs: number;
	readonly maxItemBytes: number;
	readonly maxTotalBytes: number;
	readonly maxArtifactRefs: number;
}

export interface ExternalConnectorBoundedSupervisorOptions {
	readonly reference: ExternalConnectorSupervisorReference;
	readonly containment: ExternalConnectorProcessContainment;
	readonly processController: ExternalConnectorProcessController;
	readonly artifactsAllowed: boolean;
	readonly deadlines?: ExternalConnectorSupervisorDeadlineOverrides;
	readonly limits?: Partial<ExternalConnectorSupervisorLimits>;
	readonly clock?: RuntimeClock;
}

export class ExternalConnectorSupervisorError extends Error {
	readonly code: ExternalConnectorSupervisorErrorCode;
	readonly segment: ExternalConnectorSupervisorSegment;
	readonly forcedTermination: boolean;

	constructor(
		code: ExternalConnectorSupervisorErrorCode,
		segment: ExternalConnectorSupervisorSegment,
		forcedTermination: boolean,
	) {
		super(`External Connector ${segment} failed under bounded supervision`);
		this.name = "ExternalConnectorSupervisorError";
		this.code = code;
		this.segment = segment;
		this.forcedTermination = forcedTermination;
	}
}

export interface ExternalConnectorSupervisorSnapshot {
	readonly reference: ExternalConnectorSupervisorReference;
	readonly phase: "idle" | "running" | "disposing" | "terminal" | "recovering";
	readonly eventCount: number;
	readonly totalBytes: number;
	readonly artifactRefCount: number;
	readonly forcedTermination: boolean;
	readonly quarantined: boolean;
	readonly cleaned: boolean;
}

const DEFAULT_DEADLINES: Readonly<Record<ExternalConnectorSupervisorSegment, ExternalConnectorSegmentDeadline>> =
	Object.freeze({
		start: Object.freeze({ hardMs: 30_000, idleMs: 10_000 }),
		event: Object.freeze({ hardMs: 60 * 60_000, idleMs: 30_000 }),
		receipt: Object.freeze({ hardMs: 60 * 60_000, idleMs: 30_000 }),
		cancel: Object.freeze({ hardMs: 5_000, idleMs: 2_000 }),
		dispose: Object.freeze({ hardMs: 5_000, idleMs: 2_000 }),
	});

const DEFAULT_LIMITS: Readonly<ExternalConnectorSupervisorLimits> = Object.freeze({
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

type AwaitOutcome<T> =
	| { readonly kind: "value"; readonly value: T }
	| { readonly kind: "rejected"; readonly error: unknown }
	| { readonly kind: "timeout" }
	| { readonly kind: "aborted" }
	| { readonly kind: "cancelled" }
	| { readonly kind: "stopped" }
	| { readonly kind: "process_exit" };

class SegmentTimer {
	readonly #clock: RuntimeClock;
	readonly #deadline: ExternalConnectorSegmentDeadline;
	readonly #timeout = deferred<void>();
	#hardTimer: RuntimeTimerHandle | undefined;
	#idleTimer: RuntimeTimerHandle | undefined;

	constructor(clock: RuntimeClock, deadline: ExternalConnectorSegmentDeadline) {
		this.#clock = clock;
		this.#deadline = deadline;
		this.#hardTimer = this.#schedule(deadline.hardMs);
		this.#idleTimer = this.#schedule(deadline.idleMs);
	}

	get expired(): Promise<void> {
		return this.#timeout.promise;
	}

	touch(): void {
		if (this.#timeout.settled()) return;
		if (this.#idleTimer !== undefined) this.#clock.clearTimeout(this.#idleTimer);
		this.#idleTimer = this.#schedule(this.#deadline.idleMs);
	}

	close(): void {
		if (this.#hardTimer !== undefined) this.#clock.clearTimeout(this.#hardTimer);
		if (this.#idleTimer !== undefined) this.#clock.clearTimeout(this.#idleTimer);
		this.#hardTimer = undefined;
		this.#idleTimer = undefined;
	}

	#schedule(delayMs: number): RuntimeTimerHandle {
		const handle = this.#clock.setTimeout(() => this.#timeout.resolve(), delayMs);
		this.#clock.unrefTimeout(handle);
		return handle;
	}
}

class ExternalConnectorObservationStopped extends Error {
	constructor() {
		super("External Connector observation stopped");
		this.name = "ExternalConnectorObservationStopped";
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

export function isExternalConnectorSupervisorReference(value: unknown): value is ExternalConnectorSupervisorReference {
	return (
		isRecord(value) &&
		hasOnlyKeys(value, REFERENCE_KEYS) &&
		value.schemaVersion === EXTERNAL_CONNECTOR_SUPERVISOR_SCHEMA_VERSION &&
		isExternalConnectorMappingIdentifier(value.supervisorRef) &&
		isExternalConnectorMappingIdentifier(value.operationNonce)
	);
}

export function isExternalConnectorProcessIdentity(value: unknown): value is ExternalConnectorProcessIdentity {
	return (
		isRecord(value) &&
		hasOnlyKeys(value, PROCESS_IDENTITY_KEYS) &&
		typeof value.pid === "number" &&
		Number.isSafeInteger(value.pid) &&
		value.pid > 0 &&
		isExternalConnectorMappingIdentifier(value.startToken) &&
		isExternalConnectorMappingIdentifier(value.executableIdentity) &&
		isExternalConnectorMappingIdentifier(value.fileIdentity)
	);
}

export function isExternalConnectorSupervisorPrivateState(
	value: unknown,
): value is ExternalConnectorSupervisorPrivateState {
	return (
		isRecord(value) &&
		hasOnlyKeys(value, PRIVATE_STATE_KEYS) &&
		value.schemaVersion === EXTERNAL_CONNECTOR_SUPERVISOR_SCHEMA_VERSION &&
		isExternalConnectorSupervisorReference(value.reference) &&
		value.detached === false &&
		(value.containment === "process_group" || value.containment === "job_object") &&
		isExternalConnectorProcessIdentity(value.processIdentity)
	);
}

function cloneIdentity(identity: ExternalConnectorProcessIdentity): ExternalConnectorProcessIdentity {
	return Object.freeze({ ...identity });
}

function cloneReference(reference: ExternalConnectorSupervisorReference): ExternalConnectorSupervisorReference {
	return Object.freeze({ ...reference });
}

function clonePrivateState(state: ExternalConnectorSupervisorPrivateState): ExternalConnectorSupervisorPrivateState {
	return Object.freeze({
		schemaVersion: EXTERNAL_CONNECTOR_SUPERVISOR_SCHEMA_VERSION,
		reference: cloneReference(state.reference),
		detached: false,
		containment: state.containment,
		processIdentity: cloneIdentity(state.processIdentity),
	});
}

function sameIdentity(left: ExternalConnectorProcessIdentity, right: ExternalConnectorProcessIdentity): boolean {
	return (
		left.pid === right.pid &&
		left.startToken === right.startToken &&
		left.executableIdentity === right.executableIdentity &&
		left.fileIdentity === right.fileIdentity
	);
}

function samePrivateState(
	left: ExternalConnectorSupervisorPrivateState,
	right: ExternalConnectorSupervisorPrivateState,
): boolean {
	return (
		left.schemaVersion === right.schemaVersion &&
		left.reference.schemaVersion === right.reference.schemaVersion &&
		left.reference.supervisorRef === right.reference.supervisorRef &&
		left.reference.operationNonce === right.reference.operationNonce &&
		left.detached === right.detached &&
		left.containment === right.containment &&
		sameIdentity(left.processIdentity, right.processIdentity)
	);
}

function mergeDeadlines(
	overrides: ExternalConnectorSupervisorDeadlineOverrides | undefined,
): Readonly<Record<ExternalConnectorSupervisorSegment, ExternalConnectorSegmentDeadline>> {
	const result = Object.fromEntries(
		EXTERNAL_CONNECTOR_SUPERVISOR_SEGMENTS.map((segment) => {
			const deadline = {
				hardMs: overrides?.[segment]?.hardMs ?? DEFAULT_DEADLINES[segment].hardMs,
				idleMs: overrides?.[segment]?.idleMs ?? DEFAULT_DEADLINES[segment].idleMs,
			};
			if (!isPositiveBound(deadline.hardMs) || !isPositiveBound(deadline.idleMs)) {
				throw new RangeError(`External Connector ${segment} deadlines must be positive safe integers`);
			}
			return [segment, Object.freeze(deadline)];
		}),
	) as unknown as Record<ExternalConnectorSupervisorSegment, ExternalConnectorSegmentDeadline>;
	return Object.freeze(result);
}

function mergeLimits(value: Partial<ExternalConnectorSupervisorLimits> | undefined): ExternalConnectorSupervisorLimits {
	const limits = {
		maxEvents: value?.maxEvents ?? DEFAULT_LIMITS.maxEvents,
		maxEventsPerWindow: value?.maxEventsPerWindow ?? DEFAULT_LIMITS.maxEventsPerWindow,
		eventRateWindowMs: value?.eventRateWindowMs ?? DEFAULT_LIMITS.eventRateWindowMs,
		maxItemBytes: value?.maxItemBytes ?? DEFAULT_LIMITS.maxItemBytes,
		maxTotalBytes: value?.maxTotalBytes ?? DEFAULT_LIMITS.maxTotalBytes,
		maxArtifactRefs: value?.maxArtifactRefs ?? DEFAULT_LIMITS.maxArtifactRefs,
	};
	if (Object.values(limits).some((limit) => !isPositiveBound(limit))) {
		throw new RangeError("External Connector supervisor limits must be positive safe integers");
	}
	return Object.freeze(limits);
}

function validProcessHandle(
	value: unknown,
	reference: ExternalConnectorSupervisorReference,
	containment: ExternalConnectorProcessContainment,
): value is ExternalConnectorProcessHandle {
	if (!isRecord(value)) return false;
	return (
		value.operationNonce === reference.operationNonce &&
		value.detached === false &&
		value.containment === containment &&
		isExternalConnectorProcessIdentity(value.identity) &&
		typeof value.activate === "function" &&
		typeof value.forceTerminate === "function" &&
		isRecord(value.exited) &&
		typeof value.exited.then === "function"
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

/** Single-use process supervisor for one current External Connector Attempt. */
export class ExternalConnectorBoundedSupervisor {
	readonly reference: ExternalConnectorSupervisorReference;
	readonly #containment: ExternalConnectorProcessContainment;
	readonly #processController: ExternalConnectorProcessController;
	readonly #deadlines: Readonly<Record<ExternalConnectorSupervisorSegment, ExternalConnectorSegmentDeadline>>;
	readonly #limits: ExternalConnectorSupervisorLimits;
	readonly #clock: RuntimeClock;
	#processHandle: ExternalConnectorProcessHandle | undefined;
	#privateState: ExternalConnectorSupervisorPrivateState | undefined;
	#phase: ExternalConnectorSupervisorSnapshot["phase"] = "idle";
	#eventCount = 0;
	#totalBytes = 0;
	#artifactRefCount = 0;
	#forcedTermination = false;
	#quarantined = false;
	#cleaned = false;
	#eventTimes: number[] = [];
	#startedSeen = false;
	#lastProgressSequence = 0;
	#lastHeartbeatSequence = 0;
	readonly #receiptActivityTimers = new Set<SegmentTimer>();
	readonly #artifactsAllowed: boolean;

	constructor(options: ExternalConnectorBoundedSupervisorOptions) {
		if (!isExternalConnectorSupervisorReference(options.reference)) {
			throw new TypeError("External Connector supervisor reference is invalid");
		}
		if (options.containment !== externalConnectorProcessContainment()) {
			throw new TypeError("External Connector process containment does not match the host platform");
		}
		if (typeof options.processController?.launch !== "function") {
			throw new TypeError("External Connector process controller is invalid");
		}
		if (typeof options.artifactsAllowed !== "boolean") {
			throw new TypeError("External Connector artifact capability is invalid");
		}
		this.reference = cloneReference(options.reference);
		this.#containment = options.containment;
		this.#processController = options.processController;
		this.#artifactsAllowed = options.artifactsAllowed;
		this.#deadlines = mergeDeadlines(options.deadlines);
		this.#limits = mergeLimits(options.limits);
		this.#clock = options.clock ?? SYSTEM_RUNTIME_CLOCK;
	}

	get snapshot(): ExternalConnectorSupervisorSnapshot {
		return Object.freeze({
			reference: this.reference,
			phase: this.#phase,
			eventCount: this.#eventCount,
			totalBytes: this.#totalBytes,
			artifactRefCount: this.#artifactRefCount,
			forcedTermination: this.#forcedTermination,
			quarantined: this.#quarantined,
			cleaned: this.#cleaned,
		});
	}

	get hostPrivateState(): ExternalConnectorSupervisorPrivateState | undefined {
		return this.#privateState === undefined ? undefined : clonePrivateState(this.#privateState);
	}

	async launch(
		persistBeforeActivation: (state: ExternalConnectorSupervisorPrivateState) => Promise<void>,
		sourceSignal?: AbortSignal,
	): Promise<ExternalConnectorSupervisorPrivateState> {
		if (this.#processHandle !== undefined || this.#phase !== "idle") {
			throw new Error("External Connector supervisor is single-use");
		}
		const controller = new AbortController();
		const aborted = deferred<void>();
		const abort = (): void => {
			controller.abort(sourceSignal?.reason);
			aborted.resolve();
		};
		if (sourceSignal?.aborted === true) {
			throw new ExternalConnectorSupervisorError("side_effect_unknown", "start", false);
		}
		sourceSignal?.addEventListener("abort", abort, { once: true });
		const timer = new SegmentTimer(this.#clock, this.#deadlines.start);
		const launch = async (): Promise<ExternalConnectorSupervisorPrivateState> => {
			let handle: ExternalConnectorProcessHandle;
			try {
				handle = await this.#processController.launch(this.#launchRequest(), { signal: controller.signal });
			} catch {
				this.#quarantined = true;
				throw new ExternalConnectorSupervisorError("reconcile_required", "start", false);
			}
			if (!validProcessHandle(handle, this.reference, this.#containment)) {
				this.#quarantined = true;
				throw new ExternalConnectorSupervisorError("reconcile_required", "start", false);
			}
			this.#bind(handle);
			timer.touch();
			try {
				await persistBeforeActivation(clonePrivateState(this.#privateState!));
				timer.touch();
				if (controller.signal.aborted) throw controller.signal.reason;
				await handle.activate({ signal: controller.signal });
			} catch {
				throw new ExternalConnectorSupervisorError("reconcile_required", "start", false);
			}
			this.#phase = "running";
			return clonePrivateState(this.#privateState!);
		};
		const launched = launch();
		try {
			const outcome = await Promise.race<AwaitOutcome<ExternalConnectorSupervisorPrivateState>>([
				launched.then(
					(value): AwaitOutcome<ExternalConnectorSupervisorPrivateState> => ({ kind: "value", value }),
					(error: unknown): AwaitOutcome<ExternalConnectorSupervisorPrivateState> => ({
						kind: "rejected",
						error,
					}),
				),
				timer.expired.then((): AwaitOutcome<ExternalConnectorSupervisorPrivateState> => ({ kind: "timeout" })),
				aborted.promise.then((): AwaitOutcome<ExternalConnectorSupervisorPrivateState> => ({ kind: "aborted" })),
			]);
			if (outcome.kind === "value") return outcome.value;
			if (!controller.signal.aborted) controller.abort();
			if (this.#processHandle !== undefined) {
				const cleaned = await this.#forceAndWait();
				if (!cleaned) throw new ExternalConnectorSupervisorError("reconcile_required", "dispose", true);
			} else {
				const containLateLaunch = async (): Promise<void> => {
					try {
						if (this.#processHandle === undefined) return;
						const cleaned = await this.#forceAndWait();
						if (!cleaned) this.#quarantined = true;
					} catch {
						this.#quarantined = true;
					}
				};
				void launched.then(containLateLaunch, containLateLaunch);
			}
			if (outcome.kind === "rejected" && outcome.error instanceof ExternalConnectorSupervisorError) {
				throw outcome.error;
			}
			throw new ExternalConnectorSupervisorError("side_effect_unknown", "start", this.#processHandle !== undefined);
		} finally {
			timer.close();
			sourceSignal?.removeEventListener("abort", abort);
		}
	}

	async recoverAndReap(stateValue: unknown): Promise<void> {
		this.reattach(stateValue);
		this.#phase = "recovering";
		const cleaned = await this.#forceAndWait();
		if (!cleaned) return this.#quarantine(true);
		this.#phase = "terminal";
	}

	reattach(stateValue: unknown): void {
		if (this.#processHandle !== undefined || this.#phase !== "idle") {
			throw new Error("External Connector supervisor is single-use");
		}
		this.#phase = "recovering";
		if (!isExternalConnectorSupervisorPrivateState(stateValue)) this.#quarantine();
		if (
			stateValue.reference.supervisorRef !== this.reference.supervisorRef ||
			stateValue.reference.operationNonce !== this.reference.operationNonce ||
			stateValue.containment !== this.#containment
		) {
			this.#quarantine();
		}
		const reattach = this.#processController.reattach;
		if (reattach === undefined) this.#quarantine();
		let recovered: ExternalConnectorProcessReattachResult;
		try {
			recovered = reattach.call(this.#processController, stateValue.processIdentity, this.#launchRequest());
		} catch {
			this.#quarantine();
		}
		if (
			recovered.status !== "attached" ||
			!validProcessHandle(recovered.handle, this.reference, this.#containment) ||
			!sameIdentity(recovered.handle.identity, stateValue.processIdentity)
		) {
			this.#quarantine();
		}
		this.#bind(recovered.handle);
		this.#phase = "running";
	}

	async run<T>(
		segment: ExternalConnectorSupervisorSegment,
		operation: (signal: AbortSignal) => Promise<T>,
		sourceSignal?: AbortSignal,
		resultKind: "opaque" | "terminal_evidence" | "optional_terminal_evidence" = "opaque",
		stopSignal?: AbortSignal,
		cancellationSignal?: AbortSignal,
	): Promise<T> {
		this.#requireProcess();
		if (stopSignal?.aborted === true) throw new ExternalConnectorObservationStopped();
		if (cancellationSignal?.aborted === true) {
			await this.#containAfterCancellationGrace();
			throw new ExternalConnectorSupervisorError("side_effect_unknown", segment, true);
		}
		if (sourceSignal?.aborted === true) {
			const cleaned = await this.#forceAndWait();
			throw new ExternalConnectorSupervisorError(
				cleaned ? "side_effect_unknown" : "reconcile_required",
				cleaned ? segment : "dispose",
				true,
			);
		}
		const controller = new AbortController();
		const aborted = deferred<void>();
		const cancelled = deferred<void>();
		const stopped = deferred<void>();
		let cancellationRequested = false;
		const abort = (): void => {
			controller.abort(sourceSignal?.reason);
			aborted.resolve();
		};
		sourceSignal?.addEventListener("abort", abort, { once: true });
		const cancel = (): void => {
			cancellationRequested = true;
			cancelled.resolve();
			controller.abort(cancellationSignal?.reason);
		};
		cancellationSignal?.addEventListener("abort", cancel, { once: true });
		const stop = (): void => {
			stopped.resolve();
			controller.abort(stopSignal?.reason);
		};
		stopSignal?.addEventListener("abort", stop, { once: true });
		const timer = new SegmentTimer(this.#clock, this.#deadlines[segment]);
		if (segment === "receipt") this.#receiptActivityTimers.add(timer);
		try {
			let operationPromise: Promise<T>;
			try {
				operationPromise = operation(controller.signal);
			} catch (error) {
				operationPromise = Promise.reject(error);
			}
			const outcome = await Promise.race<AwaitOutcome<T>>([
				operationPromise.then(
					(value): AwaitOutcome<T> => ({ kind: "value", value }),
					(error: unknown): AwaitOutcome<T> => ({ kind: "rejected", error }),
				),
				timer.expired.then((): AwaitOutcome<T> => ({ kind: "timeout" })),
				aborted.promise.then((): AwaitOutcome<T> => ({ kind: "aborted" })),
				cancelled.promise.then((): AwaitOutcome<T> => ({ kind: "cancelled" })),
				stopped.promise.then((): AwaitOutcome<T> => ({ kind: "stopped" })),
				this.#processHandle!.exited.then((): AwaitOutcome<T> => ({ kind: "process_exit" })),
			]);
			if (outcome.kind === "value") {
				if (
					resultKind === "terminal_evidence" ||
					(resultKind === "optional_terminal_evidence" && outcome.value !== undefined)
				) {
					try {
						this.#acceptTerminalEvidence(outcome.value);
					} catch (error) {
						const cleaned = await this.#forceAndWait();
						if (error instanceof ExternalConnectorSupervisorError && cleaned) throw error;
						throw new ExternalConnectorSupervisorError(
							cleaned ? "side_effect_unknown" : "reconcile_required",
							cleaned ? segment : "dispose",
							true,
						);
					}
				}
				return outcome.value;
			}
			if (outcome.kind === "stopped") {
				void operationPromise.catch(() => undefined);
				throw new ExternalConnectorObservationStopped();
			}
			if (outcome.kind === "cancelled" || (outcome.kind === "rejected" && cancellationRequested)) {
				void operationPromise.catch(() => undefined);
				await this.#containAfterCancellationGrace(timer);
				throw new ExternalConnectorSupervisorError("side_effect_unknown", segment, true);
			}
			if (!controller.signal.aborted) controller.abort();
			const cleaned = await this.#forceAndWait();
			if (!cleaned) throw new ExternalConnectorSupervisorError("reconcile_required", "dispose", true);
			if (outcome.kind === "rejected" && outcome.error instanceof ExternalConnectorSupervisorError) {
				throw outcome.error;
			}
			throw new ExternalConnectorSupervisorError("side_effect_unknown", segment, true);
		} finally {
			if (segment === "receipt") this.#receiptActivityTimers.delete(timer);
			timer.close();
			sourceSignal?.removeEventListener("abort", abort);
			cancellationSignal?.removeEventListener("abort", cancel);
			stopSignal?.removeEventListener("abort", stop);
		}
	}

	async consumeEvents(
		createEvents: (signal: AbortSignal) => AsyncIterable<unknown>,
		handle: ExternalConnectorDriverHandle,
		sourceSignal?: AbortSignal,
		onEvent?: (event: ExternalConnectorDriverEvent, signal: AbortSignal) => Promise<void>,
		stopSignal?: AbortSignal,
	): Promise<void> {
		this.#requireProcess();
		if (stopSignal?.aborted === true) throw new ExternalConnectorObservationStopped();
		if (sourceSignal?.aborted === true) {
			const cleaned = await this.#forceAndWait();
			throw new ExternalConnectorSupervisorError(
				cleaned ? "side_effect_unknown" : "reconcile_required",
				cleaned ? "event" : "dispose",
				true,
			);
		}
		const controller = new AbortController();
		const aborted = deferred<void>();
		const stopped = deferred<void>();
		const abort = (): void => {
			controller.abort(sourceSignal?.reason);
			aborted.resolve();
		};
		sourceSignal?.addEventListener("abort", abort, { once: true });
		const stop = (): void => {
			stopped.resolve();
			controller.abort(stopSignal?.reason);
		};
		stopSignal?.addEventListener("abort", stop, { once: true });
		const timer = new SegmentTimer(this.#clock, this.#deadlines.event);
		let iterator: AsyncIterator<unknown>;
		try {
			const events = createEvents(controller.signal);
			iterator = events[Symbol.asyncIterator]();
		} catch {
			const cleaned = await this.#forceAndWait();
			throw new ExternalConnectorSupervisorError(
				cleaned ? "side_effect_unknown" : "reconcile_required",
				"event",
				true,
			);
		}
		try {
			for (;;) {
				if (controller.signal.aborted) {
					const cleaned = await this.#forceAndWait();
					throw new ExternalConnectorSupervisorError(
						cleaned ? "side_effect_unknown" : "reconcile_required",
						cleaned ? "event" : "dispose",
						true,
					);
				}
				let next: Promise<IteratorResult<unknown>>;
				try {
					next = Promise.resolve(iterator.next());
				} catch (error) {
					next = Promise.reject(error);
				}
				const outcome = await Promise.race<AwaitOutcome<IteratorResult<unknown>>>([
					next.then(
						(value): AwaitOutcome<IteratorResult<unknown>> => ({ kind: "value", value }),
						(error: unknown): AwaitOutcome<IteratorResult<unknown>> => ({ kind: "rejected", error }),
					),
					timer.expired.then((): AwaitOutcome<IteratorResult<unknown>> => ({ kind: "timeout" })),
					aborted.promise.then((): AwaitOutcome<IteratorResult<unknown>> => ({ kind: "aborted" })),
					stopped.promise.then((): AwaitOutcome<IteratorResult<unknown>> => ({ kind: "stopped" })),
					this.#processHandle!.exited.then(
						(): AwaitOutcome<IteratorResult<unknown>> => ({ kind: "process_exit" }),
					),
				]);
				if (outcome.kind !== "value") {
					if (outcome.kind === "stopped") throw new ExternalConnectorObservationStopped();
					if (!controller.signal.aborted) controller.abort();
					const cleaned = await this.#forceAndWait();
					throw new ExternalConnectorSupervisorError(
						cleaned ? "side_effect_unknown" : "reconcile_required",
						cleaned ? "event" : "dispose",
						true,
					);
				}
				if (outcome.value.done) return;
				const event = this.#acceptEvent(outcome.value.value, handle);
				if (onEvent !== undefined) {
					let callback: Promise<void>;
					try {
						callback = Promise.resolve(onEvent(event, controller.signal));
					} catch (error) {
						callback = Promise.reject(error);
					}
					const callbackOutcome = await Promise.race<AwaitOutcome<void>>([
						callback.then(
							(): AwaitOutcome<void> => ({ kind: "value", value: undefined }),
							(error: unknown): AwaitOutcome<void> => ({ kind: "rejected", error }),
						),
						timer.expired.then((): AwaitOutcome<void> => ({ kind: "timeout" })),
						aborted.promise.then((): AwaitOutcome<void> => ({ kind: "aborted" })),
						stopped.promise.then((): AwaitOutcome<void> => ({ kind: "stopped" })),
						this.#processHandle!.exited.then((): AwaitOutcome<void> => ({ kind: "process_exit" })),
					]);
					if (callbackOutcome.kind !== "value") {
						if (callbackOutcome.kind === "stopped") throw new ExternalConnectorObservationStopped();
						if (callbackOutcome.kind === "rejected") throw callbackOutcome.error;
						if (!controller.signal.aborted) controller.abort();
						const cleaned = await this.#forceAndWait();
						throw new ExternalConnectorSupervisorError(
							cleaned ? "side_effect_unknown" : "reconcile_required",
							cleaned ? "event" : "dispose",
							true,
						);
					}
				}
				timer.touch();
				this.#touchReceiptActivity();
			}
		} catch (error) {
			if (error instanceof ExternalConnectorObservationStopped) throw error;
			if (error instanceof ExternalConnectorSupervisorError && this.#forcedTermination) throw error;
			const cleaned = await this.#forceAndWait();
			if (error instanceof ExternalConnectorSupervisorError && cleaned) throw error;
			throw new ExternalConnectorSupervisorError(
				cleaned ? "side_effect_unknown" : "reconcile_required",
				cleaned ? "event" : "dispose",
				true,
			);
		} finally {
			timer.close();
			sourceSignal?.removeEventListener("abort", abort);
			stopSignal?.removeEventListener("abort", stop);
		}
	}

	/** Stop cooperative observation first, then force the exact tree after the cancel grace expires. */
	async containAfterCancellationGrace(): Promise<void> {
		await this.#containAfterCancellationGrace();
	}

	async #containAfterCancellationGrace(activeTimer?: SegmentTimer): Promise<void> {
		const handle = this.#requireProcess();
		const timer = new SegmentTimer(this.#clock, this.#deadlines.cancel);
		try {
			const exited = await Promise.race([
				handle.exited.then(
					() => true,
					() => false,
				),
				timer.expired.then(() => false),
				...(activeTimer === undefined ? [] : [activeTimer.expired.then(() => false)]),
			]);
			if (exited) {
				this.#cleaned = true;
				this.#phase = "terminal";
				return;
			}
			const cleaned = await this.#forceAndWait();
			if (!cleaned) throw new ExternalConnectorSupervisorError("reconcile_required", "dispose", true);
			this.#phase = "terminal";
		} finally {
			timer.close();
		}
	}

	async dispose(): Promise<void> {
		if (this.#processHandle === undefined || this.#cleaned) return;
		const cleaned = await this.#forceAndWait();
		if (!cleaned) throw new ExternalConnectorSupervisorError("reconcile_required", "dispose", true);
		this.#phase = "terminal";
	}

	#launchRequest(): ExternalConnectorProcessLaunchRequest {
		return Object.freeze({
			supervisorRef: this.reference.supervisorRef,
			operationNonce: this.reference.operationNonce,
			detached: false,
			containment: this.#containment,
		});
	}

	#bind(handle: ExternalConnectorProcessHandle): void {
		this.#processHandle = handle;
		this.#privateState = Object.freeze({
			schemaVersion: EXTERNAL_CONNECTOR_SUPERVISOR_SCHEMA_VERSION,
			reference: this.reference,
			detached: false,
			containment: this.#containment,
			processIdentity: cloneIdentity(handle.identity),
		});
	}

	#requireProcess(): ExternalConnectorProcessHandle {
		if (this.#processHandle === undefined || this.#quarantined || this.#cleaned) {
			throw new ExternalConnectorSupervisorError("reconcile_required", "dispose", false);
		}
		return this.#processHandle;
	}

	#acceptEvent(value: unknown, handle: ExternalConnectorDriverHandle): ExternalConnectorDriverEvent {
		if (!isExternalConnectorDriverEvent(value) || !this.#matchesHandle(value, handle)) {
			throw new ExternalConnectorSupervisorError("external_event_invalid", "event", false);
		}
		if (value.type === "started") {
			if (this.#startedSeen) {
				throw new ExternalConnectorSupervisorError("external_event_invalid", "event", false);
			}
			this.#startedSeen = true;
		} else {
			if (!this.#startedSeen) {
				throw new ExternalConnectorSupervisorError("external_event_invalid", "event", false);
			}
			if (value.type === "progress") {
				if (value.sequence <= this.#lastProgressSequence) {
					throw new ExternalConnectorSupervisorError("external_event_invalid", "event", false);
				}
				this.#lastProgressSequence = value.sequence;
			} else if (value.type === "heartbeat") {
				if (value.sequence <= this.#lastHeartbeatSequence) {
					throw new ExternalConnectorSupervisorError("external_event_invalid", "event", false);
				}
				this.#lastHeartbeatSequence = value.sequence;
			} else if (value.type === "artifact") {
				if (!this.#artifactsAllowed) {
					throw new ExternalConnectorSupervisorError("external_event_invalid", "event", false);
				}
				this.#artifactRefCount += 1;
				if (this.#artifactRefCount > this.#limits.maxArtifactRefs) {
					throw new ExternalConnectorSupervisorError("external_resource_limit_exceeded", "event", false);
				}
			}
		}
		this.#eventCount += 1;
		if (this.#eventCount > this.#limits.maxEvents) {
			throw new ExternalConnectorSupervisorError("external_resource_limit_exceeded", "event", false);
		}
		const now = this.#clock.monotonicNow();
		this.#eventTimes = this.#eventTimes.filter((timestamp) => timestamp > now - this.#limits.eventRateWindowMs);
		this.#eventTimes.push(now);
		if (this.#eventTimes.length > this.#limits.maxEventsPerWindow) {
			throw new ExternalConnectorSupervisorError("external_resource_limit_exceeded", "event", false);
		}
		this.#observeValue(value, "event");
		return value;
	}

	#matchesHandle(event: ExternalConnectorDriverEvent, handle: ExternalConnectorDriverHandle): boolean {
		return (
			event.externalSessionId === handle.externalSessionId &&
			(event.externalTurnId ?? undefined) === (handle.externalTurnId ?? undefined)
		);
	}

	#touchReceiptActivity(): void {
		for (const timer of this.#receiptActivityTimers) timer.touch();
	}

	#acceptTerminalEvidence(value: unknown): void {
		if (!isExternalConnectorTerminalEvidence(value)) {
			throw new ExternalConnectorSupervisorError("terminal_evidence_invalid", "receipt", false);
		}
		const artifacts = value.artifacts ?? [];
		if (artifacts.length > 0 && !this.#artifactsAllowed) {
			throw new ExternalConnectorSupervisorError("external_event_invalid", "receipt", false);
		}
		this.#artifactRefCount += artifacts.length;
		if (this.#artifactRefCount > this.#limits.maxArtifactRefs) {
			throw new ExternalConnectorSupervisorError("external_resource_limit_exceeded", "receipt", false);
		}
		this.#observeValue(value, "receipt");
	}

	#observeValue(value: unknown, segment: "event" | "receipt"): void {
		const bytes = byteLength(value);
		if (bytes === undefined) throw new ExternalConnectorSupervisorError("side_effect_unknown", segment, false);
		if (bytes > this.#limits.maxItemBytes || this.#totalBytes + bytes > this.#limits.maxTotalBytes) {
			throw new ExternalConnectorSupervisorError("external_resource_limit_exceeded", segment, false);
		}
		this.#totalBytes += bytes;
	}

	async #forceAndWait(): Promise<boolean> {
		const handle = this.#processHandle;
		const state = this.#privateState;
		if (handle === undefined || state === undefined) return false;
		this.#phase = "disposing";
		if (!this.#forcedTermination) {
			this.#forcedTermination = true;
			let termination: ExternalConnectorProcessTerminationResult;
			try {
				termination = handle.forceTerminate(
					Object.freeze({
						operationNonce: state.reference.operationNonce,
						processIdentity: cloneIdentity(state.processIdentity),
					}),
				);
			} catch {
				this.#quarantined = true;
				return false;
			}
			if (termination !== "termination_requested" && termination !== "already_exited") {
				this.#quarantined = true;
				return false;
			}
		}
		const timer = new SegmentTimer(this.#clock, this.#deadlines.dispose);
		try {
			const exited = await Promise.race([
				handle.exited.then(
					() => true,
					() => false,
				),
				timer.expired.then(() => false),
			]);
			this.#cleaned = exited;
			this.#quarantined = !exited;
			return exited;
		} finally {
			timer.close();
		}
	}

	#quarantine(forcedTermination = false): never {
		this.#quarantined = true;
		this.#phase = "terminal";
		throw new ExternalConnectorSupervisorError("reconcile_required", "dispose", forcedTermination);
	}
}

/** Bound provider cleanup when no child process exists, without launching a synthetic process. */
export async function runExternalConnectorHostDispose(
	operation: (signal: AbortSignal) => Promise<void>,
	options: {
		readonly deadline?: Partial<ExternalConnectorSegmentDeadline>;
		readonly clock?: RuntimeClock;
		readonly signals?: readonly AbortSignal[];
	} = {},
): Promise<void> {
	return runExternalConnectorHostOperation("dispose", operation, options);
}

/** Bound a Host-owned operation that has no process handle of its own. */
export async function runExternalConnectorHostOperation<T>(
	segment: ExternalConnectorSupervisorSegment,
	operation: (signal: AbortSignal) => Promise<T>,
	options: {
		readonly deadline?: Partial<ExternalConnectorSegmentDeadline>;
		readonly clock?: RuntimeClock;
		readonly signals?: readonly AbortSignal[];
	} = {},
): Promise<T> {
	const deadline = {
		hardMs: options.deadline?.hardMs ?? DEFAULT_DEADLINES[segment].hardMs,
		idleMs: options.deadline?.idleMs ?? DEFAULT_DEADLINES[segment].idleMs,
	};
	if (!isPositiveBound(deadline.hardMs) || !isPositiveBound(deadline.idleMs)) {
		throw new RangeError(`External Connector host ${segment} deadlines must be positive safe integers`);
	}
	const controller = new AbortController();
	const aborted = deferred<void>();
	const listeners = new Map<AbortSignal, () => void>();
	const sourceSignals = new Set(options.signals ?? []);
	const preAborted = [...sourceSignals].find((signal) => signal.aborted);
	if (preAborted !== undefined) {
		controller.abort(preAborted.reason);
		throw new ExternalConnectorSupervisorError("side_effect_unknown", segment, false);
	}
	for (const signal of sourceSignals) {
		const abort = (): void => {
			controller.abort(signal.reason);
			aborted.resolve();
		};
		listeners.set(signal, abort);
		signal.addEventListener("abort", abort, { once: true });
	}
	const timer = new SegmentTimer(options.clock ?? SYSTEM_RUNTIME_CLOCK, deadline);
	let promise: Promise<T>;
	try {
		promise = operation(controller.signal);
	} catch (error) {
		promise = Promise.reject(error);
	}
	try {
		const outcome = await Promise.race<AwaitOutcome<T>>([
			promise.then(
				(value): AwaitOutcome<T> => ({ kind: "value", value }),
				(error: unknown): AwaitOutcome<T> => ({ kind: "rejected", error }),
			),
			timer.expired.then((): AwaitOutcome<T> => ({ kind: "timeout" })),
			aborted.promise.then((): AwaitOutcome<T> => ({ kind: "aborted" })),
		]);
		if (outcome.kind === "value") return outcome.value;
		if (outcome.kind === "rejected") throw outcome.error;
		if (!controller.signal.aborted) controller.abort();
		void promise.catch(() => undefined);
		throw new ExternalConnectorSupervisorError("side_effect_unknown", segment, false);
	} finally {
		timer.close();
		for (const [signal, abort] of listeners) signal.removeEventListener("abort", abort);
	}
}

export function externalConnectorSupervisorFailure(error: unknown): FoundationError {
	if (error instanceof ExternalConnectorSupervisorError) {
		if (error.code === "external_tool_route_denied") {
			return new FoundationError(
				"external_tool_route_denied",
				"External connector Tool Gateway policy or route denied the request.",
				{ details: { segment: error.segment } },
			);
		}
		if (error.code === "external_event_invalid" || error.code === "external_resource_limit_exceeded") {
			return new FoundationError(
				error.code,
				error.code === "external_event_invalid"
					? "External connector emitted invalid supervised output."
					: "External connector exceeded a supervised resource limit.",
				{ details: { segment: error.segment } },
			);
		}
		return new FoundationError(
			error.code === "reconcile_required" ? "scheduler_attempt_recovery_failed" : "side_effect_unknown",
			"External Connector supervision failed closed",
			{ details: { segment: error.segment, supervisorCode: error.code } },
		);
	}
	return new FoundationError("side_effect_unknown", "External Connector supervision failed closed");
}
