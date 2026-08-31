import { SYSTEM_RUNTIME_CLOCK, type RuntimeClock, type RuntimeTimerHandle } from "./runtime/clock.ts";

const MAX_PROTOCOL_LIMIT = 0xffff_ffff;

export interface BoundedProtocolLimits {
	readonly maxPendingBytes: number;
	readonly maxPendingEntries: number;
	readonly drainTimeoutMs: number;
}

export interface BoundedProtocolLimitOptions {
	readonly maxPendingBytes?: number;
	readonly maxPendingEntries?: number;
	readonly drainTimeoutMs?: number;
}

export const DEFAULT_BOUNDED_PROTOCOL_LIMITS: BoundedProtocolLimits = Object.freeze({
	maxPendingBytes: 8 * 1024 * 1024,
	maxPendingEntries: 1024,
	drainTimeoutMs: 5_000,
});

export type BoundedProtocolState = "accepting" | "closing" | "draining" | "finalizing" | "closed" | "failed";

export type BoundedProtocolErrorCode =
	| "protocol_pending_bytes_exceeded"
	| "protocol_pending_entries_exceeded"
	| "protocol_closed"
	| "protocol_write_failed"
	| "protocol_drain_timeout";

export class BoundedProtocolError extends Error {
	readonly code: BoundedProtocolErrorCode;
	readonly actual: number | undefined;
	readonly limit: number | undefined;

	constructor(
		code: BoundedProtocolErrorCode,
		message: string,
		options: { readonly actual?: number; readonly limit?: number; readonly cause?: unknown } = {},
	) {
		super(message, options.cause === undefined ? undefined : { cause: options.cause });
		this.name = "BoundedProtocolError";
		this.code = code;
		this.actual = options.actual;
		this.limit = options.limit;
	}
}

export interface BoundedProtocolWriterOptions<T> extends BoundedProtocolLimitOptions {
	readonly byteLength: (value: T) => number;
	readonly write: (value: T, signal: AbortSignal) => void | Promise<void>;
	readonly finalize?: (signal: AbortSignal) => void | Promise<void>;
	readonly clock?: RuntimeClock;
	readonly onError?: (error: Error) => void;
}

interface PendingEntry<T> {
	readonly value: T;
	readonly bytes: number;
	readonly promise: Promise<void>;
	readonly resolve: () => void;
	readonly reject: (error: Error) => void;
	settled: boolean;
}

type OperationOutcome = { readonly status: "succeeded" } | { readonly status: "failed"; readonly error: Error };

const STATE_TRANSITIONS: Readonly<Record<BoundedProtocolState, readonly BoundedProtocolState[]>> = Object.freeze({
	accepting: ["closing", "failed"],
	closing: ["draining", "failed"],
	draining: ["finalizing", "closed", "failed"],
	finalizing: ["closed", "failed"],
	closed: [],
	failed: [],
});

export function resolveBoundedProtocolLimits(options: BoundedProtocolLimitOptions = {}): BoundedProtocolLimits {
	return Object.freeze({
		maxPendingBytes: resolvePositiveLimit(
			options.maxPendingBytes ?? DEFAULT_BOUNDED_PROTOCOL_LIMITS.maxPendingBytes,
			"maxPendingBytes",
		),
		maxPendingEntries: resolvePositiveLimit(
			options.maxPendingEntries ?? DEFAULT_BOUNDED_PROTOCOL_LIMITS.maxPendingEntries,
			"maxPendingEntries",
		),
		drainTimeoutMs: resolveDuration(
			options.drainTimeoutMs ?? DEFAULT_BOUNDED_PROTOCOL_LIMITS.drainTimeoutMs,
			"drainTimeoutMs",
		),
	});
}

/**
 * Owns admission, FIFO execution, and bounded drain for one protocol writer.
 * Capacity is reserved before admission. Closing fences new entries, drains all
 * accepted entries in order, and bounds both drain and finalization together.
 */
export class BoundedProtocolWriter<T> {
	private readonly clock: RuntimeClock;
	private closePromise?: Promise<void>;
	private readonly controllers = new Set<AbortController>();
	private readonly entries: PendingEntry<T>[] = [];
	private readonly idleWaiters = new Set<() => void>();
	private admissionError?: Error;
	private terminalError?: BoundedProtocolError;
	private pendingBytesValue = 0;
	private pendingEntriesValue = 0;
	private pumping = false;
	private readonly limits: BoundedProtocolLimits;
	private readonly options: BoundedProtocolWriterOptions<T>;
	private stateValue: BoundedProtocolState = "accepting";

	constructor(options: BoundedProtocolWriterOptions<T>) {
		this.options = options;
		this.limits = resolveBoundedProtocolLimits(options);
		this.clock = options.clock ?? SYSTEM_RUNTIME_CLOCK;
	}

	get state(): BoundedProtocolState {
		return this.stateValue;
	}

	get closed(): boolean {
		return this.stateValue !== "accepting";
	}

	get error(): Error | undefined {
		return this.terminalError ?? this.admissionError;
	}

	get pendingBytes(): number {
		return this.pendingBytesValue;
	}

	get pendingEntries(): number {
		return this.pendingEntriesValue;
	}

	write(value: T): Promise<void> {
		if (this.stateValue !== "accepting") {
			return handledRejection(this.error ?? new BoundedProtocolError("protocol_closed", "Protocol writer is closed"));
		}

		let bytes: number;
		try {
			bytes = this.options.byteLength(value);
			if (!Number.isSafeInteger(bytes) || bytes < 0) {
				throw new RangeError("Protocol entry byte length must be a non-negative safe integer");
			}
		} catch (error) {
			return handledRejection(toError(error));
		}

		if (bytes > this.limits.maxPendingBytes - this.pendingBytesValue) {
			const error = new BoundedProtocolError(
				"protocol_pending_bytes_exceeded",
				"Protocol pending-write byte limit exceeded",
				{ actual: this.pendingBytesValue + bytes, limit: this.limits.maxPendingBytes },
			);
			void this.close(error).catch(() => {});
			return handledRejection(error);
		}
		if (this.pendingEntriesValue >= this.limits.maxPendingEntries) {
			const error = new BoundedProtocolError(
				"protocol_pending_entries_exceeded",
				"Protocol pending-write entry limit exceeded",
				{ actual: this.pendingEntriesValue + 1, limit: this.limits.maxPendingEntries },
			);
			void this.close(error).catch(() => {});
			return handledRejection(error);
		}

		let resolveEntry!: () => void;
		let rejectEntry!: (error: Error) => void;
		const promise = new Promise<void>((resolve, reject) => {
			resolveEntry = resolve;
			rejectEntry = reject;
		});
		void promise.catch(() => {});
		this.entries.push({ value, bytes, promise, resolve: resolveEntry, reject: rejectEntry, settled: false });
		this.pendingBytesValue += bytes;
		this.pendingEntriesValue++;
		this.startPump();
		return promise;
	}

	waitForDrain(): Promise<void> {
		if (this.closePromise !== undefined) return this.closePromise;
		if (this.terminalError !== undefined) return handledRejection(this.terminalError);
		if (this.stateValue === "closed") {
			return this.admissionError === undefined ? Promise.resolve() : handledRejection(this.admissionError);
		}
		const promise = this.runWithDeadline(async () => {
			await this.waitUntilIdle();
			if (this.terminalError !== undefined) throw this.terminalError;
		});
		void promise.catch(() => {});
		return promise;
	}

	close(error?: Error): Promise<void> {
		if (error !== undefined && this.admissionError === undefined) {
			this.admissionError = error;
			this.reportError(error);
		}
		if (this.closePromise !== undefined) return this.closePromise;
		if (this.terminalError !== undefined) return handledRejection(this.terminalError);
		if (this.stateValue === "closed") {
			return this.admissionError === undefined ? Promise.resolve() : handledRejection(this.admissionError);
		}
		if (this.stateValue === "accepting") this.transition("closing");
		const promise = this.runClose();
		this.closePromise = promise;
		void promise.catch(() => {});
		return promise;
	}

	fail(error: unknown): BoundedProtocolError {
		if (this.terminalError !== undefined) return this.terminalError;
		const cause = toError(error);
		const failure =
			cause instanceof BoundedProtocolError
				? cause
				: new BoundedProtocolError("protocol_write_failed", `Protocol write failed: ${cause.message}`, { cause });
		this.terminalError = failure;
		if (this.stateValue !== "closed" && this.stateValue !== "failed") this.transition("failed");
		for (const controller of this.controllers) controller.abort(failure);
		this.rejectAll(failure);
		this.reportError(failure);
		return failure;
	}

	private startPump(): void {
		if (this.pumping) return;
		this.pumping = true;
		void this.runPump().then(
			() => {
				this.pumping = false;
				if (this.entries.length > 0 && this.terminalError === undefined) this.startPump();
			},
			(error: unknown) => {
				this.pumping = false;
				this.fail(error);
			},
		);
	}

	private async runPump(): Promise<void> {
		while (this.entries.length > 0 && this.terminalError === undefined) {
			const entry = this.entries[0];
			const controller = new AbortController();
			this.controllers.add(controller);
			const outcome = await runAbortableOperation(() => this.options.write(entry.value, controller.signal), controller.signal);
			this.controllers.delete(controller);
			if (entry.settled) continue;
			if (outcome.status === "failed") {
				this.fail(outcome.error);
				return;
			}
			if (this.entries[0] === entry) this.entries.shift();
			this.settleEntry(entry);
		}
		this.notifyIdle();
	}

	private async runClose(): Promise<void> {
		if (this.stateValue === "closing") this.transition("draining");
		await this.runWithDeadline(async (signal) => {
			await this.waitUntilIdle();
			if (this.terminalError !== undefined) throw this.terminalError;
			if (this.options.finalize !== undefined) {
				if (this.stateValue === "draining") this.transition("finalizing");
				const outcome = await runAbortableOperation(() => this.options.finalize?.(signal), signal);
				if (outcome.status === "failed") throw outcome.error;
			}
		});
		if (this.terminalError !== undefined) throw this.terminalError;
		if (this.stateValue === "draining" || this.stateValue === "finalizing") this.transition("closed");
		if (this.admissionError !== undefined) throw this.admissionError;
	}

	private async runWithDeadline(operation: (signal: AbortSignal) => void | Promise<void>): Promise<void> {
		if (this.terminalError !== undefined) throw this.terminalError;
		const controller = new AbortController();
		this.controllers.add(controller);
		let timer: RuntimeTimerHandle | undefined;
		const timeoutError = new BoundedProtocolError(
			"protocol_drain_timeout",
			`Protocol drain exceeded ${this.limits.drainTimeoutMs}ms`,
			{ actual: this.limits.drainTimeoutMs, limit: this.limits.drainTimeoutMs },
		);
		const timeoutOutcome = new Promise<OperationOutcome>((resolve) => {
			timer = this.clock.setTimeout(() => {
				this.fail(timeoutError);
				resolve({ status: "failed", error: timeoutError });
			}, this.limits.drainTimeoutMs);
		});
		const operationOutcome = runAbortableOperation(() => operation(controller.signal), controller.signal);
		const outcome = await Promise.race([operationOutcome, timeoutOutcome]);
		if (timer !== undefined) this.clock.clearTimeout(timer);
		this.controllers.delete(controller);
		if (outcome.status === "failed") {
			throw this.terminalError ?? this.fail(outcome.error);
		}
	}

	private waitUntilIdle(): Promise<void> {
		if (this.pendingEntriesValue === 0) return Promise.resolve();
		return new Promise<void>((resolve) => this.idleWaiters.add(resolve));
	}

	private rejectAll(error: Error): void {
		const entries = this.entries.splice(0);
		for (const entry of entries) this.settleEntry(entry, error);
		this.notifyIdle();
	}

	private settleEntry(entry: PendingEntry<T>, error?: Error): void {
		if (entry.settled) return;
		entry.settled = true;
		this.pendingBytesValue -= entry.bytes;
		this.pendingEntriesValue--;
		if (error === undefined) entry.resolve();
		else entry.reject(error);
	}

	private notifyIdle(): void {
		if (this.pendingEntriesValue !== 0) return;
		for (const resolve of this.idleWaiters) resolve();
		this.idleWaiters.clear();
	}

	private reportError(error: Error): void {
		try {
			this.options.onError?.(error);
		} catch {
			// Error observers cannot become another protocol dependency.
		}
	}

	private transition(next: BoundedProtocolState): void {
		if (!STATE_TRANSITIONS[this.stateValue].includes(next)) {
			throw new Error(`Invalid bounded protocol state transition: ${this.stateValue} -> ${next}`);
		}
		this.stateValue = next;
	}
}

async function runAbortableOperation(
	operation: () => void | Promise<void>,
	signal: AbortSignal,
): Promise<OperationOutcome> {
	if (signal.aborted) return { status: "failed", error: abortReason(signal) };
	let operationResult: void | Promise<void>;
	try {
		operationResult = operation();
	} catch (error) {
		return { status: "failed", error: toError(error) };
	}
	const completed = Promise.resolve(operationResult).then<OperationOutcome, OperationOutcome>(
		() => ({ status: "succeeded" }),
		(error: unknown) => ({ status: "failed", error: toError(error) }),
	);
	let onAbort!: () => void;
	const aborted = new Promise<OperationOutcome>((resolve) => {
		onAbort = () => resolve({ status: "failed", error: abortReason(signal) });
		signal.addEventListener("abort", onAbort, { once: true });
	});
	const outcome = await Promise.race([completed, aborted]);
	signal.removeEventListener("abort", onAbort);
	return outcome;
}

function handledRejection(error: Error): Promise<void> {
	const promise = Promise.reject<void>(error);
	void promise.catch(() => {});
	return promise;
}

function resolvePositiveLimit(value: number, name: string): number {
	if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_PROTOCOL_LIMIT) {
		throw new RangeError(`${name} must be an integer between 1 and ${MAX_PROTOCOL_LIMIT}`);
	}
	return value;
}

function resolveDuration(value: number, name: string): number {
	if (!Number.isSafeInteger(value) || value < 0 || value > MAX_PROTOCOL_LIMIT) {
		throw new RangeError(`${name} must be an integer between 0 and ${MAX_PROTOCOL_LIMIT}`);
	}
	return value;
}

function abortReason(signal: AbortSignal): Error {
	return signal.reason instanceof Error ? signal.reason : new Error("Protocol operation aborted");
}

function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}
