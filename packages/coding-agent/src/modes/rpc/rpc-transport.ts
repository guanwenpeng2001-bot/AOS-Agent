import { createHash } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage, type Server as HttpServer } from "node:http";
import { createServer, type Server, type Socket } from "node:net";
import { TextDecoder } from "node:util";
import {
	BoundedProtocolError,
	BoundedProtocolWriter,
	DEFAULT_BOUNDED_PROTOCOL_LIMITS,
	resolveBoundedProtocolLimits,
	type BoundedProtocolLimits,
} from "../../core/bounded-protocol.ts";
import { runtimeClockFor, withRuntimeClock, type RuntimeClock } from "../../core/runtime/clock.ts";
import {
	attachJsonlLineReader,
	createJsonlLineWriter,
	DEFAULT_MAX_JSONL_FRAME_BYTES,
	JsonlFrameError,
	type JsonlLineWriter,
} from "./jsonl.ts";
import {
	RPC_TRANSPORT_LOOPBACK_HOST,
	validateRpcTransportAddress,
	type RpcTransportAddress,
	type TcpRpcAddress,
	type WebsocketRpcAddress,
} from "./rpc-transport-address.ts";

export const DEFAULT_RPC_TRANSPORT_MAX_FRAME_BYTES = DEFAULT_MAX_JSONL_FRAME_BYTES;
export const DEFAULT_RPC_TRANSPORT_MAX_PENDING_WRITE_BYTES = DEFAULT_BOUNDED_PROTOCOL_LIMITS.maxPendingBytes;
export const DEFAULT_RPC_TRANSPORT_MAX_PENDING_WRITE_ENTRIES = DEFAULT_BOUNDED_PROTOCOL_LIMITS.maxPendingEntries;
export const DEFAULT_RPC_TRANSPORT_DRAIN_TIMEOUT_MS = DEFAULT_BOUNDED_PROTOCOL_LIMITS.drainTimeoutMs;

export type RpcTransportErrorCode =
	| "rpc_transport_address_invalid"
	| "rpc_transport_not_loopback"
	| "rpc_transport_bind_failed"
	| "rpc_transport_connection_busy"
	| "rpc_transport_frame_too_large"
	| "rpc_transport_pending_write_limit"
	| "rpc_transport_drain_timeout"
	| "rpc_transport_closed"
	| "rpc_transport_write_failed"
	| "rpc_transport_invalid_json"
	| "rpc_transport_invalid_command"
	| "rpc_transport_dispatch_failed"
	| "rpc_transport_connection_failed"
	| "rpc_transport_listener_failed"
	| "rpc_transport_close_failed";

const RPC_TRANSPORT_ERROR_MESSAGES: Readonly<Record<RpcTransportErrorCode, string>> = {
	rpc_transport_address_invalid: "RPC transport address is invalid",
	rpc_transport_not_loopback: "RPC transport address must use the loopback host 127.0.0.1",
	rpc_transport_bind_failed: "RPC listener failed to bind",
	rpc_transport_connection_busy: "Another control connection is active",
	rpc_transport_frame_too_large: "RPC JSONL frame exceeds the configured maximum",
	rpc_transport_pending_write_limit: "RPC pending-write capacity exceeded",
	rpc_transport_drain_timeout: "RPC pending writes did not drain before the deadline",
	rpc_transport_closed: "RPC transport connection is closed",
	rpc_transport_write_failed: "RPC transport write failed",
	rpc_transport_invalid_json: "RPC transport received invalid JSON",
	rpc_transport_invalid_command: "RPC transport received an invalid command",
	rpc_transport_dispatch_failed: "RPC command dispatch failed",
	rpc_transport_connection_failed: "RPC transport connection failed",
	rpc_transport_listener_failed: "RPC listener failed",
	rpc_transport_close_failed: "RPC transport close failed",
};

/** An error produced by the JSONL transport boundary rather than by a command. */
export class RpcTransportError extends Error {
	readonly code: RpcTransportErrorCode;

	constructor(code: RpcTransportErrorCode, message: string, cause?: unknown) {
		super(message || RPC_TRANSPORT_ERROR_MESSAGES[code], cause === undefined ? undefined : { cause });
		this.name = "RpcTransportError";
		this.code = code;
	}
}

export interface RpcTransportErrorRecord {
	readonly type: "error";
	readonly error: {
		readonly code: RpcTransportErrorCode;
		readonly message: string;
	};
}

export interface RpcTransportSink<TOutput> {
	readonly closed: boolean;
	send(output: TOutput): Promise<void>;
	write(output: TOutput): Promise<void>;
	close(): Promise<void>;
	release(): Promise<void>;
	onClose(listener: () => void): () => void;
	onError(listener: (error: RpcTransportError) => void): () => void;
}

export type RpcTransportDispatcher<TCommand, TOutput> = (
	command: TCommand,
	sink: RpcTransportSink<TOutput>,
) => void | Promise<void>;

export interface RpcTransportOptions<TCommand, TOutput> {
	/** The parser accepts only the typed command values the dispatcher understands. */
	readonly address: RpcTransportAddress;
	readonly dispatch: RpcTransportDispatcher<TCommand, TOutput>;
	readonly parseCommand?: (value: unknown) => TCommand;
	/** Defaults to one MiB for network transports. */
	readonly maxFrameBytes?: number;
	/** Compatibility spelling used by length-prefixed transports. */
	readonly maxFrameLength?: number;
	/** Defaults to eight MiB across writes that have not settled. */
	readonly maxPendingWriteBytes?: number;
	/** Defaults to 1024 writes that have not settled. */
	readonly maxPendingWriteEntries?: number;
	/** Total bound for ordered pending-write drain and socket finalization. */
	readonly drainTimeoutMs?: number;
	readonly onError?: (error: RpcTransportError) => void;
	readonly onConnection?: (connection: RpcTransportConnection<TCommand, TOutput>) => void;
	readonly onConnectionClose?: (connection: RpcTransportConnection<TCommand, TOutput>) => void;
	readonly onConnectionError?: (error: RpcTransportError) => void;
}

export interface RpcTransportConnection<_TCommand, TOutput> extends RpcTransportSink<TOutput> {
	readonly id: number;
}

interface ConnectionCallbacks<TCommand, TOutput> {
	readonly dispatch: RpcTransportDispatcher<TCommand, TOutput>;
	readonly parseCommand: ((value: unknown) => TCommand) | undefined;
	readonly maxFrameBytes: number;
	readonly protocolLimits: BoundedProtocolLimits;
	readonly clock: RuntimeClock;
	readonly reportError: (error: RpcTransportError) => void;
	readonly onReleased: (connection: RpcTransportConnection<TCommand, TOutput>) => void;
	readonly onConnectionError: ((error: RpcTransportError) => void) | undefined;
}

class RpcTransportConnectionImpl<TCommand, TOutput> implements RpcTransportConnection<TCommand, TOutput> {
	readonly id: number;
	private readonly socket: Socket;
	private readonly writer: JsonlLineWriter;
	private readonly callbacks: ConnectionCallbacks<TCommand, TOutput>;
	private readonly closeListeners = new Set<() => void>();
	private readonly errorListeners = new Set<(error: RpcTransportError) => void>();
	private detachReader?: () => void;
	private closePromise?: Promise<void>;
	private closedValue = false;
	private closing = false;

	constructor(id: number, socket: Socket, callbacks: ConnectionCallbacks<TCommand, TOutput>) {
		this.id = id;
		this.socket = socket;
		this.callbacks = callbacks;
		this.writer = createJsonlLineWriter(
			socket,
			withRuntimeClock(
				{
					maxFrameBytes: callbacks.maxFrameBytes,
					maxPendingWriteBytes: callbacks.protocolLimits.maxPendingBytes,
					maxPendingWriteEntries: callbacks.protocolLimits.maxPendingEntries,
					drainTimeoutMs: callbacks.protocolLimits.drainTimeoutMs,
				},
				callbacks.clock,
			),
		);
	}

	get closed(): boolean {
		return this.closedValue || this.socket.destroyed;
	}

	start(): void {
		this.socket.on("error", this.onSocketError);
		this.socket.once("close", this.onSocketClose);
		this.detachReader = attachJsonlLineReader(this.socket, (line) => this.receiveLine(line), {
			maxFrameBytes: this.callbacks.maxFrameBytes,
			onError: (error) => this.onReaderError(error),
		});
	}

	send(output: TOutput): Promise<void> {
		if (this.closed || this.closing) {
			return rejectedTransportWrite(createTransportError("rpc_transport_closed"));
		}
		const pending = this.writer.write(output);
		if (this.writer.closed) void this.close();
		const result = pending.catch((error: unknown) => {
			const transportError = toTransportError(error, "rpc_transport_write_failed");
			this.reportError(transportError);
			void this.close();
			throw transportError;
		});
		void result.catch(() => {});
		return result;
	}

	write(output: TOutput): Promise<void> {
		return this.send(output);
	}

	close(): Promise<void> {
		if (this.closePromise) return this.closePromise;
		if (this.closed) {
			this.markClosed();
			return Promise.resolve();
		}
		this.closing = true;
		this.detachReader?.();
		this.detachReader = undefined;
		this.closePromise = this.closeInternal();
		return this.closePromise;
	}

	release(): Promise<void> {
		return this.close();
	}

	onClose(listener: () => void): () => void {
		if (this.closedValue) {
			listener();
			return () => {};
		}
		this.closeListeners.add(listener);
		return () => this.closeListeners.delete(listener);
	}

	onError(listener: (error: RpcTransportError) => void): () => void {
		if (this.closedValue) return () => {};
		this.errorListeners.add(listener);
		return () => this.errorListeners.delete(listener);
	}

	/** Abruptly tears down the socket when the listener itself is closing. */
	abort(): void {
		this.closing = true;
		this.detachReader?.();
		this.detachReader = undefined;
		if (this.socket.destroyed) {
			this.markClosed();
			return;
		}
		this.socket.destroy();
	}

	private receiveLine(line: string): void {
		if (this.closed || this.closing) return;
		let value: unknown;
		try {
			value = JSON.parse(line) as unknown;
		} catch (error) {
			const transportError = createTransportError("rpc_transport_invalid_json", error);
			this.reportError(transportError);
			void this.sendError(transportError);
			return;
		}

		let command: TCommand;
		try {
			command = this.callbacks.parseCommand ? this.callbacks.parseCommand(value) : (value as TCommand);
		} catch (error) {
			const transportError = createTransportError("rpc_transport_invalid_command", error);
			this.reportError(transportError);
			void this.sendError(transportError);
			return;
		}

		try {
			const dispatched = this.callbacks.dispatch(command, this);
			if (dispatched !== undefined) {
				void dispatched.catch((error: unknown) => {
					const transportError = createTransportError("rpc_transport_dispatch_failed", error);
					this.reportError(transportError);
					void this.sendError(transportError);
				});
			}
		} catch (error) {
			const transportError = createTransportError("rpc_transport_dispatch_failed", error);
			this.reportError(transportError);
			void this.sendError(transportError);
		}
	}

	private onReaderError(error: Error): void {
		if (this.closed || this.closing) return;
		if (error instanceof JsonlFrameError) {
			const transportError = createTransportError("rpc_transport_frame_too_large", error);
			this.reportError(transportError);
			void this.sendErrorAndClose(transportError);
			return;
		}
		const transportError = createTransportError("rpc_transport_connection_failed", error);
		this.reportError(transportError);
		this.abort();
	}

	private readonly onSocketError = (error: Error): void => {
		if (this.closedValue) return;
		const transportError = createTransportError("rpc_transport_connection_failed", error);
		this.reportError(transportError);
		this.abort();
	};

	private readonly onSocketClose = (): void => {
		this.markClosed();
	};

	private reportError(error: RpcTransportError): void {
		this.callbacks.reportError(error);
		try {
			this.callbacks.onConnectionError?.(error);
		} catch {
			// Error observers cannot affect connection state.
		}
		for (const listener of this.errorListeners) {
			try {
				listener(error);
			} catch {
				// Error observers cannot affect connection state.
			}
		}
	}

	private sendError(error: RpcTransportError): Promise<void> {
		if (this.closed || this.closing) return Promise.resolve();
		return this.send(toTransportErrorRecord(error) as TOutput).catch(() => {});
	}

	private async sendErrorAndClose(error: RpcTransportError): Promise<void> {
		if (this.closed) return;
		this.closing = true;
		this.detachReader?.();
		this.detachReader = undefined;
		try {
			await this.writer.write(toTransportErrorRecord(error));
			await this.close();
		} catch (writeError: unknown) {
			this.reportError(toTransportError(writeError, "rpc_transport_write_failed"));
			await this.close();
		}
	}

	private async closeInternal(): Promise<void> {
		try {
			await this.writer.close();
		} catch (error: unknown) {
			this.reportError(toTransportError(error, "rpc_transport_write_failed"));
		} finally {
			if (!this.socket.destroyed) this.socket.destroy();
			this.markClosed();
		}
	}

	private markClosed(): void {
		if (this.closedValue) return;
		this.closedValue = true;
		this.closing = true;
		this.detachReader?.();
		this.detachReader = undefined;
		this.socket.off("error", this.onSocketError);
		this.socket.off("close", this.onSocketClose);
		this.writer.detach();
		for (const listener of this.closeListeners) {
			try {
				listener();
			} catch {
				// Close observers cannot affect transport state.
			}
		}
		this.closeListeners.clear();
		this.errorListeners.clear();
		this.callbacks.onReleased(this);
	}
}

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const WEBSOCKET_TEXT_OPCODE = 0x1;
const WEBSOCKET_CLOSE_OPCODE = 0x8;
const WEBSOCKET_PING_OPCODE = 0x9;
const WEBSOCKET_PONG_OPCODE = 0xa;

class WebsocketFrameReader {
	private buffer = Buffer.alloc(0);
	private fragments: Buffer[] = [];
	private fragmentedBytes = 0;
	private fragmented = false;
	private readonly maxFrameBytes: number;
	private readonly onMessage: (payload: Buffer) => void;
	private readonly onControl: (opcode: number, payload: Buffer) => void;
	private readonly onError: (error: Error) => void;

	constructor(options: {
		maxFrameBytes: number;
		onMessage: (payload: Buffer) => void;
		onControl: (opcode: number, payload: Buffer) => void;
		onError: (error: Error) => void;
	}) {
		this.maxFrameBytes = options.maxFrameBytes;
		this.onMessage = options.onMessage;
		this.onControl = options.onControl;
		this.onError = options.onError;
	}

	push(chunk: Buffer): void {
		this.buffer = this.buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buffer, chunk]);
		try {
			while (this.readFrame()) {
				// Drain all complete frames from this TCP chunk.
			}
		} catch (error: unknown) {
			this.buffer = Buffer.alloc(0);
			this.fragments = [];
			this.onError(toError(error));
		}
	}

	private readFrame(): boolean {
		if (this.buffer.length < 2) return false;
		const first = this.buffer[0]!;
		const second = this.buffer[1]!;
		const fin = (first & 0x80) !== 0;
		const opcode = first & 0x0f;
		if ((first & 0x70) !== 0) throw new Error("WebSocket extensions are not supported");
		if ((second & 0x80) === 0) throw new Error("Client WebSocket frames must be masked");

		let payloadLength = second & 0x7f;
		let offset = 2;
		if (payloadLength === 126) {
			if (this.buffer.length < 4) return false;
			payloadLength = this.buffer.readUInt16BE(2);
			offset = 4;
		} else if (payloadLength === 127) {
			if (this.buffer.length < 10) return false;
			const extendedLength = this.buffer.readBigUInt64BE(2);
			if (extendedLength > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("WebSocket frame is too large");
			payloadLength = Number(extendedLength);
			offset = 10;
		}
		if (opcode >= 0x8 && (!fin || payloadLength > 125)) {
			throw new Error("WebSocket control frame is invalid");
		}
		if (opcode < 0x8 && payloadLength + this.fragmentedBytes > this.maxFrameBytes) {
			throw new JsonlFrameError(payloadLength + this.fragmentedBytes, this.maxFrameBytes);
		}
		if (this.buffer.length < offset + 4 + payloadLength) return false;
		const mask = this.buffer.subarray(offset, offset + 4);
		offset += 4;
		const payload = Buffer.from(this.buffer.subarray(offset, offset + payloadLength));
		for (let index = 0; index < payload.length; index += 1) {
			payload[index] = payload[index]! ^ mask[index % 4]!;
		}
		this.buffer = this.buffer.subarray(offset + payloadLength);
		this.consumeFrame(fin, opcode, payload);
		return true;
	}

	private consumeFrame(fin: boolean, opcode: number, payload: Buffer): void {
		if (opcode >= 0x8) {
			this.onControl(opcode, payload);
			return;
		}
		if (opcode === WEBSOCKET_TEXT_OPCODE) {
			if (this.fragmented) throw new Error("A fragmented WebSocket message is already active");
			if (fin) {
				this.emitMessage(payload);
				return;
			}
			this.fragmented = true;
			this.fragments = [payload];
			this.fragmentedBytes = payload.length;
			return;
		}
		if (opcode === 0x0) {
			if (!this.fragmented) throw new Error("Unexpected WebSocket continuation frame");
			this.fragments.push(payload);
			this.fragmentedBytes += payload.length;
			if (fin) {
				const message = Buffer.concat(this.fragments, this.fragmentedBytes);
				this.fragmented = false;
				this.fragments = [];
				this.fragmentedBytes = 0;
				this.emitMessage(message);
			}
			return;
		}
		throw new Error("Only WebSocket text messages are supported");
	}

	private emitMessage(payload: Buffer): void {
		const frameBytes = payload[payload.length - 1] === 0x0a ? payload.length : payload.length + 1;
		if (frameBytes > this.maxFrameBytes) {
			throw new JsonlFrameError(frameBytes, this.maxFrameBytes);
		}
		this.onMessage(payload);
	}
}

class WebsocketRpcTransportConnection<TCommand, TOutput>
	implements RpcTransportConnection<TCommand, TOutput>
{
	readonly id: number;
	private readonly socket: Socket;
	private readonly callbacks: ConnectionCallbacks<TCommand, TOutput>;
	private readonly protocol: BoundedProtocolWriter<Buffer>;
	private readonly reader: WebsocketFrameReader;
	private readonly closeListeners = new Set<() => void>();
	private readonly errorListeners = new Set<(error: RpcTransportError) => void>();
	private closedValue = false;
	private closing = false;
	private closePromise?: Promise<void>;

	constructor(id: number, socket: Socket, callbacks: ConnectionCallbacks<TCommand, TOutput>) {
		this.id = id;
		this.socket = socket;
		this.callbacks = callbacks;
		this.protocol = new BoundedProtocolWriter<Buffer>({
			maxPendingBytes: callbacks.protocolLimits.maxPendingBytes,
			maxPendingEntries: callbacks.protocolLimits.maxPendingEntries,
			drainTimeoutMs: callbacks.protocolLimits.drainTimeoutMs,
			byteLength: (frame) => frame.length,
			write: (frame, signal) => writeSocketBuffer(socket, frame, signal),
			finalize: (signal) => finalizeWebsocketSocket(socket, signal),
			clock: callbacks.clock,
		});
		this.reader = new WebsocketFrameReader({
			maxFrameBytes: callbacks.maxFrameBytes,
			onMessage: (payload) => this.receiveMessage(payload),
			onControl: (opcode, payload) => this.receiveControl(opcode, payload),
			onError: (error) => this.onReaderError(error),
		});
	}

	get closed(): boolean {
		return this.closedValue || this.socket.destroyed;
	}

	start(head: Buffer): void {
		this.socket.on("data", this.onSocketData);
		this.socket.on("error", this.onSocketError);
		this.socket.once("close", this.onSocketClose);
		if (head.length > 0) this.reader.push(head);
	}

	send(output: TOutput): Promise<void> {
		if (this.closed || this.closing) return rejectedTransportWrite(createTransportError("rpc_transport_closed"));
		let line: string;
		try {
			line = `${JSON.stringify(output)}\n`;
		} catch (error: unknown) {
			return rejectedTransportWrite(toTransportError(error, "rpc_transport_write_failed"));
		}
		const frameBytes = Buffer.byteLength(line, "utf8");
		if (frameBytes > this.callbacks.maxFrameBytes) {
			const error = createTransportError(
				"rpc_transport_frame_too_large",
				new JsonlFrameError(frameBytes, this.callbacks.maxFrameBytes),
			);
			this.reportError(error);
			void this.close();
			return rejectedTransportWrite(error);
		}
		const pending = this.protocol.write(encodeWebsocketFrame(WEBSOCKET_TEXT_OPCODE, Buffer.from(line, "utf8")));
		if (this.protocol.closed) void this.close();
		const result = pending.catch((error: unknown) => {
			const transportError = toTransportError(error, "rpc_transport_write_failed");
			this.reportError(transportError);
			void this.close();
			throw transportError;
		});
		void result.catch(() => {});
		return result;
	}

	write(output: TOutput): Promise<void> {
		return this.send(output);
	}

	close(): Promise<void> {
		if (this.closePromise) return this.closePromise;
		if (this.closed) {
			this.markClosed();
			return Promise.resolve();
		}
		this.closing = true;
		this.closePromise = this.closeInternal();
		return this.closePromise;
	}

	release(): Promise<void> {
		return this.close();
	}

	onClose(listener: () => void): () => void {
		if (this.closedValue) {
			listener();
			return () => {};
		}
		this.closeListeners.add(listener);
		return () => this.closeListeners.delete(listener);
	}

	onError(listener: (error: RpcTransportError) => void): () => void {
		if (this.closedValue) return () => {};
		this.errorListeners.add(listener);
		return () => this.errorListeners.delete(listener);
	}

	abort(): void {
		this.closing = true;
		if (this.socket.destroyed) {
			this.markClosed();
			return;
		}
		this.socket.destroy();
	}

	private readonly onSocketData = (chunk: Buffer): void => {
		if (!this.closed && !this.closing) this.reader.push(chunk);
	};

	private receiveMessage(payload: Buffer): void {
		if (this.closed || this.closing) return;
		let line: string;
		try {
			line = new TextDecoder("utf-8", { fatal: true }).decode(payload);
		} catch (error: unknown) {
			const transportError = createTransportError("rpc_transport_invalid_json", error);
			this.reportError(transportError);
			void this.sendError(transportError);
			return;
		}
		if (line.endsWith("\n")) line = line.slice(0, -1);
		if (line.endsWith("\r")) line = line.slice(0, -1);
		if (line.includes("\n")) {
			const transportError = createTransportError("rpc_transport_invalid_json");
			this.reportError(transportError);
			void this.sendError(transportError);
			return;
		}

		let value: unknown;
		try {
			value = JSON.parse(line) as unknown;
		} catch (error: unknown) {
			const transportError = createTransportError("rpc_transport_invalid_json", error);
			this.reportError(transportError);
			void this.sendError(transportError);
			return;
		}
		let command: TCommand;
		try {
			command = this.callbacks.parseCommand ? this.callbacks.parseCommand(value) : (value as TCommand);
		} catch (error: unknown) {
			const transportError = createTransportError("rpc_transport_invalid_command", error);
			this.reportError(transportError);
			void this.sendError(transportError);
			return;
		}
		try {
			const dispatched = this.callbacks.dispatch(command, this);
			if (dispatched !== undefined) {
				void dispatched.catch((error: unknown) => {
					const transportError = createTransportError("rpc_transport_dispatch_failed", error);
					this.reportError(transportError);
					void this.sendError(transportError);
				});
			}
		} catch (error: unknown) {
			const transportError = createTransportError("rpc_transport_dispatch_failed", error);
			this.reportError(transportError);
			void this.sendError(transportError);
		}
	}

	private receiveControl(opcode: number, payload: Buffer): void {
		if (opcode === WEBSOCKET_CLOSE_OPCODE) {
			void this.close();
			return;
		}
		if (opcode === WEBSOCKET_PING_OPCODE) {
			void this.protocol.write(encodeWebsocketFrame(WEBSOCKET_PONG_OPCODE, payload)).catch((error: unknown) => {
				this.reportError(toTransportError(error, "rpc_transport_write_failed"));
				this.abort();
			});
		}
	}

	private onReaderError(error: Error): void {
		if (this.closed || this.closing) return;
		const transportError =
			error instanceof JsonlFrameError
				? createTransportError("rpc_transport_frame_too_large", error)
				: createTransportError("rpc_transport_connection_failed", error);
		this.reportError(transportError);
		if (error instanceof JsonlFrameError) void this.sendErrorAndClose(transportError);
		else this.abort();
	}

	private readonly onSocketError = (error: Error): void => {
		if (this.closedValue) return;
		this.reportError(createTransportError("rpc_transport_connection_failed", error));
		this.abort();
	};

	private readonly onSocketClose = (): void => {
		this.markClosed();
	};

	private reportError(error: RpcTransportError): void {
		this.callbacks.reportError(error);
		try {
			this.callbacks.onConnectionError?.(error);
		} catch {
			// Error observers cannot affect connection state.
		}
		for (const listener of this.errorListeners) {
			try {
				listener(error);
			} catch {
				// Error observers cannot affect connection state.
			}
		}
	}

	private sendError(error: RpcTransportError): Promise<void> {
		if (this.closed || this.closing) return Promise.resolve();
		return this.send(toTransportErrorRecord(error) as TOutput).catch(() => {});
	}

	private async sendErrorAndClose(error: RpcTransportError): Promise<void> {
		if (this.closed) return;
		try {
			await this.send(toTransportErrorRecord(error) as TOutput);
		} finally {
			await this.close();
		}
	}

	private async closeInternal(): Promise<void> {
		try {
			await this.protocol.close();
		} catch (error: unknown) {
			this.reportError(toTransportError(error, "rpc_transport_write_failed"));
		} finally {
			if (!this.socket.destroyed) this.socket.destroy();
			this.markClosed();
		}
	}

	private markClosed(): void {
		if (this.closedValue) return;
		this.closedValue = true;
		this.closing = true;
		this.socket.off("data", this.onSocketData);
		this.socket.off("error", this.onSocketError);
		this.socket.off("close", this.onSocketClose);
		for (const listener of this.closeListeners) {
			try {
				listener();
			} catch {
				// Close observers cannot affect transport state.
			}
		}
		this.closeListeners.clear();
		this.errorListeners.clear();
		this.callbacks.onReleased(this);
	}
}

export class RpcTransport<
	TCommand,
	TOutput,
	TAddress extends RpcTransportAddress = TcpRpcAddress,
> {
	private readonly options: RpcTransportOptions<TCommand, TOutput>;
	private readonly maxFrameBytes: number;
	private readonly protocolLimits: BoundedProtocolLimits;
	private readonly clock: RuntimeClock;
	private readonly configuredAddress: TAddress;
	private server?: Server;
	private websocketServer?: HttpServer;
	private boundAddress?: TAddress;
	private activeConnectionValue?: RpcTransportConnection<TCommand, TOutput>;
	private connectionSequence = 0;
	private startPromise?: Promise<this>;
	private closePromise?: Promise<void>;
	private started = false;
	private closing = false;

	constructor(options: RpcTransportOptions<TCommand, TOutput> & { readonly address: TAddress }) {
		this.options = options;
		this.configuredAddress = validateRpcTransportAddress(options.address) as TAddress;
		this.maxFrameBytes = resolveMaxFrameBytes(options.maxFrameBytes ?? options.maxFrameLength);
		this.protocolLimits = resolveBoundedProtocolLimits({
			maxPendingBytes: options.maxPendingWriteBytes ?? DEFAULT_RPC_TRANSPORT_MAX_PENDING_WRITE_BYTES,
			maxPendingEntries: options.maxPendingWriteEntries ?? DEFAULT_RPC_TRANSPORT_MAX_PENDING_WRITE_ENTRIES,
			drainTimeoutMs: options.drainTimeoutMs ?? DEFAULT_RPC_TRANSPORT_DRAIN_TIMEOUT_MS,
		});
		this.clock = runtimeClockFor(options);
	}

	get address(): TAddress | undefined {
		return this.boundAddress;
	}

	get listening(): boolean {
		return this.started && !this.closing;
	}

	get activeConnection(): RpcTransportConnection<TCommand, TOutput> | undefined {
		return this.activeConnectionValue;
	}

	start(): Promise<this> {
		if (this.started) return Promise.reject(new Error("RPC transport is already started"));
		if (this.startPromise) return Promise.reject(new Error("RPC transport is already starting"));
		if (this.closing) return Promise.reject(new Error("RPC transport is closing or closed"));
		const promise = this.startInternal();
		this.startPromise = promise;
		return promise;
	}

	async close(): Promise<void> {
		if (this.closePromise) return this.closePromise;
		this.closing = true;
		this.closePromise = this.closeInternal();
		return this.closePromise;
	}

	private async startInternal(): Promise<this> {
		if (this.configuredAddress.transport === "websocket") {
			return this.startWebsocketInternal(this.configuredAddress);
		}
		const server = createServer({ allowHalfOpen: false }, (socket) => this.accept(socket));
		this.server = server;
		try {
			await listenServer(server, this.configuredAddress);
			if (this.closing) {
				await closeServer(server);
				throw createTransportError("rpc_transport_closed");
			}
			const address = server.address();
			if (address === null || typeof address === "string") {
				throw createTransportError("rpc_transport_bind_failed");
			}
			this.boundAddress = { transport: "tcp", host: RPC_TRANSPORT_LOOPBACK_HOST, port: address.port } as TAddress;
			server.on("error", this.onServerError);
			this.started = true;
			return this;
		} catch (error) {
			this.closing = true;
			try {
				await closeServer(server);
			} catch (closeError: unknown) {
				this.reportError(createTransportError("rpc_transport_close_failed", closeError));
			}
			this.server = undefined;
			const transportError =
				error instanceof RpcTransportError ? error : createTransportError("rpc_transport_bind_failed", error);
			this.reportError(transportError);
			throw transportError;
		} finally {
			this.startPromise = undefined;
		}
	}

	private async startWebsocketInternal(address: WebsocketRpcAddress): Promise<this> {
		const server = createHttpServer((_request, response) => {
			response.writeHead(426, { Connection: "close", "Content-Type": "text/plain" });
			response.end("WebSocket upgrade required");
		});
		this.websocketServer = server;
		server.on("upgrade", (request, socket, head) =>
			this.acceptWebsocket(address, request, socket as Socket, head),
		);
		try {
			await listenHttpServer(server, address);
			if (this.closing) {
				await closeHttpServer(server);
				throw createTransportError("rpc_transport_closed");
			}
			const bound = server.address();
			if (bound === null || typeof bound === "string") throw createTransportError("rpc_transport_bind_failed");
			this.boundAddress = { ...address, port: bound.port } as TAddress;
			server.on("error", this.onServerError);
			this.started = true;
			return this;
		} catch (error: unknown) {
			this.closing = true;
			try {
				await closeHttpServer(server);
			} catch (closeError: unknown) {
				this.reportError(createTransportError("rpc_transport_close_failed", closeError));
			}
			this.websocketServer = undefined;
			const transportError =
				error instanceof RpcTransportError ? error : createTransportError("rpc_transport_bind_failed", error);
			this.reportError(transportError);
			throw transportError;
		} finally {
			this.startPromise = undefined;
		}
	}

	private accept(socket: Socket): void {
		if (this.closing) {
			socket.destroy();
			return;
		}
		const active = this.activeConnectionValue;
		if (active && !active.closed) {
			void this.rejectBusy(socket);
			return;
		}

		const connection = new RpcTransportConnectionImpl(++this.connectionSequence, socket, {
			dispatch: this.options.dispatch,
			parseCommand: this.options.parseCommand,
			maxFrameBytes: this.maxFrameBytes,
			protocolLimits: this.protocolLimits,
			clock: this.clock,
			reportError: (error) => this.reportError(error),
			onReleased: (released) => this.releaseConnection(released),
			onConnectionError: this.options.onConnectionError,
		});
		this.activeConnectionValue = connection;
		connection.start();
		try {
			this.options.onConnection?.(connection);
		} catch (error) {
			const transportError = createTransportError("rpc_transport_connection_failed", error);
			this.reportConnectionError(transportError);
			void connection.release();
		}
	}

	private acceptWebsocket(
		address: WebsocketRpcAddress,
		request: IncomingMessage,
		socket: Socket,
		head: Buffer,
	): void {
		if (this.closing || request.url !== address.path || !acceptWebsocketHandshake(request, socket)) {
			if (!socket.destroyed) socket.destroy();
			return;
		}
		const active = this.activeConnectionValue;
		if (active && !active.closed) {
			void this.rejectBusyWebsocket(socket);
			return;
		}
		const connection = new WebsocketRpcTransportConnection(++this.connectionSequence, socket, {
			dispatch: this.options.dispatch,
			parseCommand: this.options.parseCommand,
			maxFrameBytes: this.maxFrameBytes,
			protocolLimits: this.protocolLimits,
			clock: this.clock,
			reportError: (error) => this.reportError(error),
			onReleased: (released) => this.releaseConnection(released),
			onConnectionError: this.options.onConnectionError,
		});
		this.activeConnectionValue = connection;
		connection.start(head);
		try {
			this.options.onConnection?.(connection);
		} catch (error: unknown) {
			const transportError = createTransportError("rpc_transport_connection_failed", error);
			this.reportConnectionError(transportError);
			void connection.release();
		}
	}

	private async rejectBusy(socket: Socket): Promise<void> {
		const writer = createJsonlLineWriter(
			socket,
			withRuntimeClock(
				{
					maxFrameBytes: this.maxFrameBytes,
					maxPendingWriteBytes: this.protocolLimits.maxPendingBytes,
					maxPendingWriteEntries: this.protocolLimits.maxPendingEntries,
					drainTimeoutMs: this.protocolLimits.drainTimeoutMs,
				},
				this.clock,
			),
		);
		const busyError = createTransportError("rpc_transport_connection_busy");
		this.reportConnectionError(busyError);
		try {
			await writer.write(toTransportErrorRecord(busyError));
			await writer.close();
			if (!socket.destroyed) socket.destroy();
		} catch (error: unknown) {
			this.reportConnectionError(toTransportError(error, "rpc_transport_write_failed"));
			socket.destroy();
		} finally {
			writer.detach();
		}
	}

	private async rejectBusyWebsocket(socket: Socket): Promise<void> {
		const busyError = createTransportError("rpc_transport_connection_busy");
		this.reportConnectionError(busyError);
		try {
			const line = Buffer.from(`${JSON.stringify(toTransportErrorRecord(busyError))}\n`, "utf8");
			await writeSocketBuffer(socket, encodeWebsocketFrame(WEBSOCKET_TEXT_OPCODE, line), new AbortController().signal);
			await writeSocketBuffer(
				socket,
				encodeWebsocketFrame(WEBSOCKET_CLOSE_OPCODE, Buffer.alloc(0)),
				new AbortController().signal,
			);
		} catch (error: unknown) {
			this.reportConnectionError(toTransportError(error, "rpc_transport_write_failed"));
		} finally {
			socket.destroy();
		}
	}

	private releaseConnection(connection: RpcTransportConnection<TCommand, TOutput>): void {
		if (this.activeConnectionValue !== connection) return;
		this.activeConnectionValue = undefined;
		try {
			this.options.onConnectionClose?.(connection);
		} catch {
			// Close observers cannot affect transport state.
		}
	}

	private readonly onServerError = (error: Error): void => {
		if (this.closing || !this.started) return;
		this.reportError(createTransportError("rpc_transport_listener_failed", error));
	};

	private reportError(error: RpcTransportError): void {
		try {
			this.options.onError?.(error);
		} catch {
			// Error observers cannot affect transport state.
		}
	}

	private reportConnectionError(error: RpcTransportError): void {
		this.reportError(error);
		try {
			this.options.onConnectionError?.(error);
		} catch {
			// Error observers cannot affect transport state.
		}
	}

	private async closeInternal(): Promise<void> {
		const starting = this.startPromise;
		if (starting) await starting.catch(() => {});
		const server = this.server;
		const websocketServer = this.websocketServer;
		const active = this.activeConnectionValue;
		try {
			await Promise.all([
				server ? closeServer(server) : Promise.resolve(),
				websocketServer ? closeHttpServer(websocketServer) : Promise.resolve(),
				active?.close() ?? Promise.resolve(),
			]);
		} catch (error: unknown) {
			this.reportError(createTransportError("rpc_transport_close_failed", error));
		}
		this.activeConnectionValue = undefined;
		this.boundAddress = undefined;
		this.started = false;
		this.server = undefined;
		this.websocketServer = undefined;
	}
}

export function createRpcTransport<TCommand, TOutput>(
	options: RpcTransportOptions<TCommand, TOutput> & { readonly address: TcpRpcAddress },
): RpcTransport<TCommand, TOutput, TcpRpcAddress>;
export function createRpcTransport<TCommand, TOutput>(
	options: RpcTransportOptions<TCommand, TOutput> & { readonly address: WebsocketRpcAddress },
): RpcTransport<TCommand, TOutput, WebsocketRpcAddress>;
export function createRpcTransport<TCommand, TOutput>(
	options: RpcTransportOptions<TCommand, TOutput>,
): RpcTransport<TCommand, TOutput, RpcTransportAddress>;
export function createRpcTransport<TCommand, TOutput>(
	options: RpcTransportOptions<TCommand, TOutput>,
): RpcTransport<TCommand, TOutput, RpcTransportAddress> {
	return new RpcTransport<TCommand, TOutput, RpcTransportAddress>(options);
}

export const createTcpRpcTransport = createRpcTransport;

function toTransportErrorRecord(error: RpcTransportError): RpcTransportErrorRecord {
	return { type: "error", error: { code: error.code, message: error.message } };
}

function createTransportError(code: RpcTransportErrorCode, cause?: unknown): RpcTransportError {
	return new RpcTransportError(code, RPC_TRANSPORT_ERROR_MESSAGES[code], cause);
}

function toTransportError(error: unknown, fallbackCode: RpcTransportErrorCode): RpcTransportError {
	if (error instanceof RpcTransportError) return error;
	if (error instanceof JsonlFrameError) {
		return createTransportError("rpc_transport_frame_too_large", error);
	}
	if (error instanceof BoundedProtocolError) {
		if (error.code === "protocol_pending_bytes_exceeded" || error.code === "protocol_pending_entries_exceeded") {
			return createTransportError("rpc_transport_pending_write_limit", error);
		}
		if (error.code === "protocol_drain_timeout") {
			return createTransportError("rpc_transport_drain_timeout", error);
		}
		if (error.code === "protocol_closed") {
			return createTransportError("rpc_transport_closed", error);
		}
	}
	return createTransportError(fallbackCode, error);
}

function rejectedTransportWrite(error: RpcTransportError): Promise<void> {
	const promise = Promise.reject<void>(error);
	void promise.catch(() => {});
	return promise;
}

function resolveMaxFrameBytes(value: number | undefined): number {
	const resolved = value ?? DEFAULT_RPC_TRANSPORT_MAX_FRAME_BYTES;
	if (!Number.isSafeInteger(resolved) || resolved <= 0 || resolved > 0xffff_ffff) {
		throw new RangeError(`maxFrameBytes must be an integer between 1 and ${0xffff_ffff}`);
	}
	return resolved;
}

function listenServer(server: Server, address: RpcTransportAddress): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const onError = (error: Error): void => {
			server.off("listening", onListening);
			server.off("error", onError);
			reject(createTransportError("rpc_transport_bind_failed", error));
		};
		const onListening = (): void => {
			server.off("error", onError);
			resolve();
		};
		server.once("error", onError);
		server.once("listening", onListening);
		server.listen({ host: address.host, port: address.port });
	});
}

function listenHttpServer(server: HttpServer, address: WebsocketRpcAddress): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const onError = (error: Error): void => {
			server.off("listening", onListening);
			server.off("error", onError);
			reject(createTransportError("rpc_transport_bind_failed", error));
		};
		const onListening = (): void => {
			server.off("error", onError);
			resolve();
		};
		server.once("error", onError);
		server.once("listening", onListening);
		server.listen({ host: address.host, port: address.port });
	});
}

function acceptWebsocketHandshake(request: IncomingMessage, socket: Socket): boolean {
	const upgrade = request.headers.upgrade;
	const connection = request.headers.connection;
	const version = request.headers["sec-websocket-version"];
	const key = request.headers["sec-websocket-key"];
	if (
		request.method !== "GET" ||
		typeof upgrade !== "string" ||
		upgrade.toLowerCase() !== "websocket" ||
		typeof connection !== "string" ||
		!connection
			.split(",")
			.map((value) => value.trim().toLowerCase())
			.includes("upgrade") ||
		version !== "13" ||
		typeof key !== "string"
	) {
		socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
		return false;
	}
	let decodedKey: Buffer;
	try {
		decodedKey = Buffer.from(key, "base64");
	} catch {
		socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
		return false;
	}
	if (decodedKey.length !== 16 || decodedKey.toString("base64") !== key) {
		socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
		return false;
	}
	const accept = createHash("sha1").update(`${key}${WEBSOCKET_GUID}`).digest("base64");
	socket.write(
		`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
	);
	return true;
}

function encodeWebsocketFrame(opcode: number, payload: Buffer): Buffer {
	const headerBytes = payload.length < 126 ? 2 : payload.length <= 0xffff ? 4 : 10;
	const frame = Buffer.allocUnsafe(headerBytes + payload.length);
	frame[0] = 0x80 | opcode;
	if (headerBytes === 2) {
		frame[1] = payload.length;
	} else if (headerBytes === 4) {
		frame[1] = 126;
		frame.writeUInt16BE(payload.length, 2);
	} else {
		frame[1] = 127;
		frame.writeBigUInt64BE(BigInt(payload.length), 2);
	}
	payload.copy(frame, headerBytes);
	return frame;
}

function writeSocketBuffer(socket: Socket, buffer: Buffer, signal: AbortSignal): Promise<void> {
	if (signal.aborted) return Promise.reject(signal.reason);
	if (socket.destroyed || !socket.writable) return Promise.reject(new Error("WebSocket is closed"));
	return new Promise<void>((resolve, reject) => {
		let callbackDone = false;
		let needsDrain = false;
		let settled = false;
		const cleanup = (): void => {
			socket.off("error", onError);
			socket.off("close", onClose);
			socket.off("drain", onDrain);
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
		const onClose = (): void => finish(new Error("WebSocket closed during write"));
		const onDrain = (): void => {
			needsDrain = false;
			finish();
		};
		const onAbort = (): void =>
			finish(signal.reason instanceof Error ? signal.reason : new Error("WebSocket write aborted"));
		socket.once("error", onError);
		socket.once("close", onClose);
		signal.addEventListener("abort", onAbort, { once: true });
		try {
			const accepted = socket.write(buffer, (error?: Error | null) => {
				callbackDone = true;
				finish(error ?? undefined);
			});
			needsDrain = !accepted;
			if (needsDrain) socket.once("drain", onDrain);
			finish();
		} catch (error: unknown) {
			finish(toError(error));
		}
	});
}

async function finalizeWebsocketSocket(socket: Socket, signal: AbortSignal): Promise<void> {
	if (socket.destroyed || !socket.writable) return;
	await writeSocketBuffer(socket, encodeWebsocketFrame(WEBSOCKET_CLOSE_OPCODE, Buffer.alloc(0)), signal);
	socket.end();
}

function closeServer(server: Server): Promise<void> {
	if (!server.listening) return Promise.resolve();
	return new Promise<void>((resolve, reject) => {
		server.close((error) => (error ? reject(error) : resolve()));
	});
}

function closeHttpServer(server: HttpServer): Promise<void> {
	if (!server.listening) return Promise.resolve();
	return new Promise<void>((resolve, reject) => {
		server.close((error) => (error ? reject(error) : resolve()));
	});
}

function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}
