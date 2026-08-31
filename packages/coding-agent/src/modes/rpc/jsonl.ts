import type { Readable, Writable } from "node:stream";
import {
	BoundedProtocolError,
	BoundedProtocolWriter,
	DEFAULT_BOUNDED_PROTOCOL_LIMITS,
} from "../../core/bounded-protocol.ts";
import { runtimeClockFor } from "../../core/runtime/clock.ts";

const MAX_UINT32 = 0xffff_ffff;

/** Default bound used by every JSONL transport, including stdio. */
export const DEFAULT_MAX_JSONL_FRAME_BYTES = 1024 * 1024;
/** Alias using line terminology for callers that do not count the LF delimiter. */
export const DEFAULT_MAX_JSONL_LINE_BYTES = DEFAULT_MAX_JSONL_FRAME_BYTES - 1;
export const DEFAULT_MAX_JSONL_PENDING_WRITE_BYTES = DEFAULT_BOUNDED_PROTOCOL_LIMITS.maxPendingBytes;
export const DEFAULT_MAX_JSONL_PENDING_WRITE_ENTRIES = DEFAULT_BOUNDED_PROTOCOL_LIMITS.maxPendingEntries;
export const DEFAULT_JSONL_DRAIN_TIMEOUT_MS = DEFAULT_BOUNDED_PROTOCOL_LIMITS.drainTimeoutMs;

export interface JsonlLineReaderOptions {
	/** Maximum UTF-8 bytes in one record, including its LF delimiter. */
	readonly maxFrameBytes?: number;
	/** Compatibility spelling used by length-prefixed transports. */
	readonly maxFrameLength?: number;
	/** Maximum UTF-8 bytes in one record, excluding its LF delimiter. */
	readonly maxLineBytes?: number;
	readonly onError?: (error: Error) => void;
	readonly onEnd?: () => void;
}

export interface JsonlLineWriterOptions {
	/** Maximum UTF-8 bytes in one record, including its LF delimiter. */
	readonly maxFrameBytes?: number;
	/** Compatibility spelling used by length-prefixed transports. */
	readonly maxFrameLength?: number;
	/** Maximum UTF-8 bytes in one record, excluding its LF delimiter. */
	readonly maxLineBytes?: number;
	/** Maximum UTF-8 bytes admitted across writes that have not settled. */
	readonly maxPendingWriteBytes?: number;
	/** Maximum entries admitted across writes that have not settled. */
	readonly maxPendingWriteEntries?: number;
	/** Total bound for ordered pending-write drain and stream finalization. */
	readonly drainTimeoutMs?: number;
	readonly onError?: (error: Error) => void;
}

/** Raised when a JSONL record exceeds the configured network frame bound. */
export class JsonlFrameError extends Error {
	readonly frameBytes: number;
	readonly maxFrameBytes: number;

	constructor(frameBytes: number, maxFrameBytes: number) {
		super(`JSONL frame is ${frameBytes} bytes; maximum is ${maxFrameBytes}`);
		this.name = "JsonlFrameError";
		this.frameBytes = frameBytes;
		this.maxFrameBytes = maxFrameBytes;
	}
}

/**
 * Serialize a single strict JSONL record.
 *
 * Framing is LF-only. Payload strings may contain other Unicode separators such
 * as U+2028 and U+2029. Clients must split records on `\n` only.
 */
export function serializeJsonLine(value: unknown): string {
	return `${JSON.stringify(value)}\n`;
}

/**
 * Attach an LF-only JSONL reader to a stream.
 *
 * The reader accumulates bytes rather than JavaScript characters. This keeps the
 * network limit correct for multi-byte UTF-8 input and avoids splitting a
 * partial UTF-8 sequence between chunks. A CR immediately before LF is removed
 * for compatibility with CRLF peers; other CR bytes remain payload data.
 */
export function attachJsonlLineReader(
	stream: Readable,
	onLine: (line: string) => void,
	options: JsonlLineReaderOptions = {},
): () => void {
	const limits = resolveLimits(options);
	let buffer = Buffer.alloc(0);
	let detached = false;
	let ended = false;
	let reportedError = false;

	const detachListeners = (): void => {
		stream.off("data", onData);
		stream.off("end", onEnd);
		if (options.onError) stream.off("error", onStreamError);
	};

	const reportError = (error: unknown): void => {
		if (reportedError) return;
		reportedError = true;
		try {
			options.onError?.(toError(error));
		} catch {
			// Error observers cannot affect stream framing state.
		}
	};

	const fail = (error: unknown): void => {
		if (detached || ended) return;
		detached = true;
		buffer = Buffer.alloc(0);
		detachListeners();
		reportError(error);
	};

	const checkFrame = (payloadBytes: number, hasDelimiter: boolean): boolean => {
		const frameBytes = payloadBytes + (hasDelimiter ? 1 : 0);
		if (limits.maxFrameBytes !== undefined && frameBytes > limits.maxFrameBytes) {
			fail(new JsonlFrameError(frameBytes, limits.maxFrameBytes));
			return false;
		}
		if (limits.maxLineBytes !== undefined && payloadBytes > limits.maxLineBytes) {
			fail(new JsonlFrameError(payloadBytes, limits.maxLineBytes));
			return false;
		}
		return true;
	};

	const emitLine = (bytes: Buffer): void => {
		const payload = bytes.length > 0 && bytes[bytes.length - 1] === 0x0d ? bytes.subarray(0, -1) : bytes;
		onLine(payload.toString("utf8"));
	};

	const onData = (chunk: string | Buffer): void => {
		if (detached || ended) return;
		try {
			const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
			let offset = 0;
			while (offset < bytes.length) {
				const newlineIndex = bytes.indexOf(0x0a, offset);
				const segmentEnd = newlineIndex === -1 ? bytes.length : newlineIndex;
				const segment = bytes.subarray(offset, segmentEnd);
				const payloadBytes = buffer.length + segment.length;
				if (!checkFrame(payloadBytes, newlineIndex !== -1)) return;
				if (segment.length > 0) {
					buffer = buffer.length === 0 ? Buffer.from(segment) : Buffer.concat([buffer, segment]);
				}
				if (newlineIndex === -1) return;
				emitLine(buffer);
				if (detached) return;
				buffer = Buffer.alloc(0);
				offset = newlineIndex + 1;
			}
		} catch (error) {
			fail(error);
		}
	};

	const onEnd = (): void => {
		if (detached || ended) return;
		try {
			if (buffer.length > 0 && !checkFrame(buffer.length, false)) return;
			ended = true;
			detachListeners();
			if (buffer.length > 0) {
				emitLine(buffer);
				buffer = Buffer.alloc(0);
			}
			options.onEnd?.();
		} catch (error) {
			reportError(error);
		}
	};

	const onStreamError = (error: Error): void => {
		fail(error);
	};

	stream.on("data", onData);
	stream.on("end", onEnd);
	if (options.onError) stream.on("error", onStreamError);

	return () => {
		if (detached) return;
		detached = true;
		buffer = Buffer.alloc(0);
		detachListeners();
	};
}

/**
 * Serialize JSONL records in call order and wait for both write callbacks and
 * `drain` when a writable reports backpressure. Once one write fails, the
 * queue is terminal: later records are rejected and never reach the stream.
 */
export class JsonlLineWriter<TOutput = unknown> {
	private readonly stream: Writable;
	private readonly options: JsonlLineWriterOptions;
	private readonly limits: JsonlLimits;
	private readonly protocol: BoundedProtocolWriter<string>;
	private closedValue = false;
	private reportedError = false;

	constructor(stream: Writable, options: JsonlLineWriterOptions = {}) {
		this.stream = stream;
		this.options = options;
		this.limits = resolveLimits(options);
		this.protocol = new BoundedProtocolWriter<string>({
			maxPendingBytes: options.maxPendingWriteBytes ?? DEFAULT_MAX_JSONL_PENDING_WRITE_BYTES,
			maxPendingEntries: options.maxPendingWriteEntries ?? DEFAULT_MAX_JSONL_PENDING_WRITE_ENTRIES,
			drainTimeoutMs: options.drainTimeoutMs ?? DEFAULT_JSONL_DRAIN_TIMEOUT_MS,
			byteLength: (line) => Buffer.byteLength(line, "utf8"),
			write: (line, signal) => this.writeChunk(line, signal),
			finalize: (signal) => this.endStream(signal),
			clock: runtimeClockFor(options),
			onError: (error) => this.reportError(error),
		});
		stream.on("error", this.onStreamError);
		stream.on("close", this.onStreamClose);
	}

	get closed(): boolean {
		return this.closedValue || this.protocol.closed || this.stream.destroyed;
	}

	get error(): Error | undefined {
		return this.protocol.error;
	}

	write(value: TOutput): Promise<void> {
		return this.writeLine(serializeJsonLine(value));
	}

	writeLine(line: string): Promise<void> {
		if (!line.endsWith("\n")) return rejectedWrite(new TypeError("JSONL writer records must end with LF"));
		if (this.closed) {
			return rejectedWrite(
				this.protocol.error ?? new BoundedProtocolError("protocol_closed", "JSONL writer is closed"),
			);
		}
		try {
			this.assertWithinLimit(line);
		} catch (error) {
			const normalized = toError(error);
			void this.protocol.close(normalized).catch(() => {});
			return rejectedWrite(normalized);
		}
		return this.protocol.write(line);
	}

	/** Wait until all records queued before this call have drained. */
	waitForDrain(): Promise<void> {
		return this.protocol.waitForDrain();
	}

	close(): Promise<void> {
		return this.protocol.close();
	}

	detach(): void {
		this.stream.off("error", this.onStreamError);
		this.stream.off("close", this.onStreamClose);
	}

	private assertWithinLimit(line: string): void {
		const frameBytes = Buffer.byteLength(line, "utf8");
		if (this.limits.maxFrameBytes !== undefined && frameBytes > this.limits.maxFrameBytes) {
			throw new JsonlFrameError(frameBytes, this.limits.maxFrameBytes);
		}
		if (this.limits.maxLineBytes !== undefined && frameBytes - 1 > this.limits.maxLineBytes) {
			throw new JsonlFrameError(frameBytes - 1, this.limits.maxLineBytes);
		}
	}

	private readonly onStreamError = (error: Error): void => {
		this.protocol.fail(error);
	};

	private readonly onStreamClose = (): void => {
		this.closedValue = true;
	};

	private reportError(error: Error): void {
		if (!this.reportedError) {
			this.reportedError = true;
			try {
				this.options.onError?.(error);
			} catch {
				// Error observers cannot affect writer state.
			}
		}
	}

	private writeChunk(line: string, signal: AbortSignal): Promise<void> {
		if (signal.aborted) return rejectedWrite(abortReason(signal));
		if (this.closedValue || this.stream.destroyed || !this.stream.writable) {
			return rejectedWrite(this.protocol.error ?? new Error("JSONL writer is closed"));
		}
		return new Promise<void>((resolve, reject) => {
			let callbackDone = false;
			let callbackError: Error | undefined;
			let needsDrain = false;
			let settled = false;
			let writeReturned = false;

			const cleanup = (): void => {
				this.stream.off("error", onError);
				this.stream.off("close", onClose);
				this.stream.off("drain", onDrain);
				signal.removeEventListener("abort", onAbort);
			};
			const finish = (error?: Error): void => {
				if (settled) return;
				if (error !== undefined) {
					settled = true;
					cleanup();
					reject(error);
					return;
				}
				if (!callbackDone || needsDrain) return;
				settled = true;
				cleanup();
				resolve();
			};
			const onError = (error: Error): void => finish(error);
			const onClose = (): void => finish(new Error("JSONL writer stream closed during write"));
			const onAbort = (): void => finish(abortReason(signal));
			const onDrain = (): void => {
				needsDrain = false;
				finish();
			};

			this.stream.once("error", onError);
			this.stream.once("close", onClose);
			signal.addEventListener("abort", onAbort, { once: true });
			try {
				const accepted = this.stream.write(line, "utf8", (error?: Error | null) => {
					if (error) {
						callbackError = error;
						callbackDone = true;
						if (writeReturned) finish(error);
						return;
					}
					callbackDone = true;
					if (writeReturned) finish();
				});
				writeReturned = true;
				needsDrain = !accepted;
				if (needsDrain) this.stream.once("drain", onDrain);
				if (callbackError !== undefined) finish(callbackError);
				else finish();
			} catch (error) {
				finish(toError(error));
			}
		});
	}

	private endStream(signal: AbortSignal): Promise<void> {
		if (signal.aborted) return rejectedWrite(abortReason(signal));
		if (this.closedValue || this.stream.destroyed || this.stream.writableFinished || !this.stream.writable) {
			return Promise.resolve();
		}
		return new Promise<void>((resolve, reject) => {
			let settled = false;
			const cleanup = (): void => {
				this.stream.off("error", onError);
				this.stream.off("close", onClose);
				signal.removeEventListener("abort", onAbort);
			};
			const finish = (error?: Error): void => {
				if (settled) return;
				settled = true;
				cleanup();
				if (error === undefined) resolve();
				else reject(error);
			};
			const onError = (error: Error): void => finish(error);
			const onClose = (): void => finish(new Error("JSONL writer stream closed during finalization"));
			const onAbort = (): void => finish(abortReason(signal));
			this.stream.once("error", onError);
			this.stream.once("close", onClose);
			signal.addEventListener("abort", onAbort, { once: true });
			try {
				this.stream.end(() => finish());
			} catch (error) {
				finish(toError(error));
			}
		});
	}
}

export function createJsonlLineWriter<TOutput = unknown>(
	stream: Writable,
	options?: JsonlLineWriterOptions,
): JsonlLineWriter<TOutput> {
	return new JsonlLineWriter<TOutput>(stream, options);
}

interface JsonlLimits {
	readonly maxFrameBytes: number | undefined;
	readonly maxLineBytes: number | undefined;
}

function resolveLimits(options: JsonlLineReaderOptions | JsonlLineWriterOptions): JsonlLimits {
	const frameValue = options.maxFrameBytes ?? options.maxFrameLength;
	const lineValue = options.maxLineBytes;
	return {
		maxFrameBytes:
			frameValue === undefined && lineValue === undefined
				? DEFAULT_MAX_JSONL_FRAME_BYTES
				: frameValue === undefined
					? undefined
					: resolvePositiveByteLimit(frameValue, "maxFrameBytes"),
		maxLineBytes: lineValue === undefined ? undefined : resolvePositiveByteLimit(lineValue, "maxLineBytes"),
	};
}

function resolvePositiveByteLimit(value: number, name: string): number {
	if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_UINT32) {
		throw new RangeError(`${name} must be an integer between 1 and ${MAX_UINT32}`);
	}
	return value;
}

function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

function abortReason(signal: AbortSignal): Error {
	return signal.reason instanceof Error ? signal.reason : new Error("JSONL writer operation aborted");
}

function rejectedWrite(error: Error): Promise<void> {
	const promise = Promise.reject<void>(error);
	void promise.catch(() => {});
	return promise;
}
