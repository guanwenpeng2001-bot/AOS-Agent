/**
 * Host-private JSONL adapter for settings-selected External Connector targets.
 *
 * The adapter never starts a process. Production composition binds it to the
 * channel owned by ProductionExternalConnectorProcessController after that
 * controller has launched and activated the exact supervised process.
 */

import { randomUUID } from "node:crypto";
import {
	canonicalFoundationJson,
	validateConnectorCapabilitySnapshot,
	validateProviderJson,
	type ConnectorCapabilitySnapshot,
	type FoundationJsonValue,
} from "@aos-agent/agent-core";
import type {
	ExternalConnectorProcessChannel,
	ExternalConnectorProcessController,
	ExternalConnectorSupervisorReference,
} from "../supervisor.ts";
import type {
	ExternalConnectorDriverEvent,
	ExternalConnectorDriverHandle,
	ExternalConnectorDriverLookup,
	ExternalConnectorDriverSpawnRequest,
	ExternalConnectorDriverWriteRequest,
	ExternalConnectorTerminalEvidence,
	ExternalConnectorVendorDriver,
} from "./types.ts";
import {
	isExternalConnectorDriverHandle,
	isExternalConnectorDriverLookup,
	isExternalConnectorTerminalEvidence,
} from "./types.ts";
import type { CanonicalExternalConnectorMapping } from "../session-mapping.ts";
import {
	assertExternalConnectorJsonlFrameSize,
	EXTERNAL_CONNECTOR_JSONL_MAX_FRAME_BYTES,
	EXTERNAL_CONNECTOR_JSONL_PROTOCOL_VERSION,
	EXTERNAL_CONNECTOR_JSONL_SCHEMA_VERSION,
	isExternalConnectorJsonlHandshakeRequest,
	isExternalConnectorJsonlRequestFrame,
	parseExternalConnectorJsonlFrame,
	type ExternalConnectorJsonlEventFrame,
	type ExternalConnectorJsonlFrame,
	type ExternalConnectorJsonlHandshakeResult,
	type ExternalConnectorJsonlOperation,
	type ExternalConnectorJsonlEventsEndFrame,
} from "./jsonl-frame-validator.ts";

const BASE_IMPLEMENTED_OPERATIONS = Object.freeze([
	"spawn",
	"events",
	"connect",
	"lookup",
	"read",
	"write",
	"heartbeat",
	"cancel",
	"dispose",
] as const);

type JsonlReference = Pick<ExternalConnectorSupervisorReference, "supervisorRef" | "operationNonce">;

export interface JsonlProcessDriverOptions {
	readonly providerId: string;
	readonly version: string;
	readonly capability: ConnectorCapabilitySnapshot;
	readonly processController?: ExternalConnectorProcessController;
}

interface PendingResponse {
	readonly requestId: string;
	readonly operation: ExternalConnectorJsonlOperation | "handshake";
	readonly resolve: (value: unknown) => void;
	readonly reject: (error: unknown) => void;
	readonly cleanup: () => void;
}

interface EventStream {
	readonly streamId: string;
	readonly events: ExternalConnectorDriverEvent[];
	ended: boolean;
	error: Error | undefined;
	waiter:
		| {
				readonly resolve: (value: ExternalConnectorDriverEvent | undefined) => void;
				readonly reject: (error: unknown) => void;
				readonly signal?: AbortSignal;
				readonly onAbort?: () => void;
		  }
		| undefined;
}

interface ProcessSession {
	readonly key: string;
	readonly reference: JsonlReference;
	readonly channel: ExternalConnectorProcessChannel;
	readonly pending: Map<string, PendingResponse>;
	readonly streams: Map<string, EventStream>;
	readonly closedStreamIds: Set<string>;
	handshake: Promise<void> | undefined;
	pump: Promise<void> | undefined;
	error: Error | undefined;
}

class ExternalConnectorJsonlDriverError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "ExternalConnectorJsonlDriverError";
		this.code = code;
	}
}

function referenceKey(reference: JsonlReference): string {
	return `${reference.supervisorRef}\0${reference.operationNonce}`;
}

function jsonPayload(value: unknown): FoundationJsonValue {
	if (!validateProviderJson(value)) throw new ExternalConnectorJsonlDriverError("external_event_invalid", "JSONL payload is not valid Foundation JSON");
	return value;
}

function requestReference(value: ExternalConnectorDriverHandle | CanonicalExternalConnectorMapping): JsonlReference {
	return "supervisorRef" in value
		? { supervisorRef: value.supervisorRef, operationNonce: value.operationNonce }
		: { supervisorRef: value.supervisor.ref, operationNonce: value.supervisor.nonce };
}

function validateOperationResult(operation: ExternalConnectorJsonlOperation, value: unknown): unknown {
	const valid =
		operation === "spawn" || operation === "connect"
			? isExternalConnectorDriverHandle(value)
			: operation === "lookup"
				? isExternalConnectorDriverLookup(value)
				: operation === "read"
					? isExternalConnectorTerminalEvidence(value)
					: operation === "cancel"
						? value === null || value === undefined || isExternalConnectorTerminalEvidence(value)
						: validateProviderJson(value);
	if (!valid) throw new ExternalConnectorJsonlDriverError("external_event_invalid", `JSONL ${operation} response is invalid`);
	return value;
}

function implementedOperationsFor(capability: ConnectorCapabilitySnapshot): readonly string[] {
	return Object.freeze([
		...BASE_IMPLEMENTED_OPERATIONS,
		...(capability.toolGateway ? ["tool_gateway_request", "tool_gateway_result"] : []),
	]);
}

function capabilityMatches(left: ConnectorCapabilitySnapshot, right: ConnectorCapabilitySnapshot): boolean {
	return canonicalFoundationJson(left) === canonicalFoundationJson(right);
}

/**
 * Adapt one exact supervised JSONL process to the package-private vendor
 * driver contract. This class is not part of the coding-agent package entry.
 */
export class JsonlProcessExternalConnectorDriver implements ExternalConnectorVendorDriver {
	readonly #providerId: string;
	readonly #version: string;
	readonly #capability: ConnectorCapabilitySnapshot;
	readonly #sessions = new Map<string, ProcessSession>();
	#processController: ExternalConnectorProcessController | undefined;
	#requestSequence = 0;

	constructor(options: JsonlProcessDriverOptions) {
		if (
			typeof options.providerId !== "string" ||
			options.providerId.length === 0 ||
			typeof options.version !== "string" ||
			options.version.length === 0 ||
			!validateConnectorCapabilitySnapshot(options.capability).ok ||
			options.capability.providerId !== options.providerId ||
			options.capability.protocol.name !== options.providerId ||
			options.capability.protocol.version !== options.version
		) {
			throw new TypeError("External Connector JSONL driver identity is invalid");
		}
		this.#providerId = options.providerId;
		this.#version = options.version;
		this.#capability = Object.freeze({ ...options.capability });
		if (options.processController !== undefined) this.bindProcessController(options.processController);
	}

	/** Package-private behavior evidence used by Host registration checks. */
	get jsonlImplementedOperations(): readonly string[] {
		return implementedOperationsFor(this.#capability);
	}

	/** Bind the adapter to the already-created production controller. */
	bindProcessController(processController: ExternalConnectorProcessController): void {
		if (typeof processController.channelFor !== "function") {
			throw new TypeError("External Connector JSONL process controller does not expose a channel");
		}
		if (this.#processController !== undefined && this.#processController !== processController) {
			throw new TypeError("External Connector JSONL driver is already bound to another process controller");
		}
		this.#processController = processController;
	}

	get modelSupportMatrix(): undefined {
		return undefined;
	}

	async spawn(request: ExternalConnectorDriverSpawnRequest): Promise<ExternalConnectorDriverHandle> {
		const reference = { supervisorRef: request.supervisorRef, operationNonce: request.operationNonce };
		const session = this.#session(reference);
		await this.#ensureHandshake(session, request.signal);
		const payload = {
			attempt: request.attempt,
			correlation: request.correlation,
			input: request.input,
			...(request.modelProjection === undefined ? {} : { modelProjection: request.modelProjection }),
			...(request.modelTranslation === undefined ? {} : { modelTranslation: request.modelTranslation }),
			capability: request.capability,
			bindingDigest: request.bindingDigest,
			bindingRevision: request.bindingRevision,
			...(request.credential === undefined ? {} : { credential: request.credential }),
			...(request.mcpSelection === undefined ? {} : { mcpSelection: request.mcpSelection }),
			...(request.toolGatewayRoutes === undefined ? {} : { toolGatewayRoutes: request.toolGatewayRoutes }),
		};
		const result = await this.#request(session, "spawn", jsonPayload(payload), reference, request.signal);
		if (!isExternalConnectorDriverHandle(result)) {
			throw new ExternalConnectorJsonlDriverError("external_event_invalid", "JSONL spawn response is invalid");
		}
		return result;
	}

	async *events(
		handle: ExternalConnectorDriverHandle,
		options?: { readonly signal?: AbortSignal },
	): AsyncIterable<FoundationJsonValue> {
		const reference = requestReference(handle);
		const session = this.#session(reference);
		await this.#ensureHandshake(session, options?.signal);
		const streamId = this.#nextRequestId();
		const stream: EventStream = {
			streamId,
			events: [],
			ended: false,
			error: undefined,
			waiter: undefined,
		};
		session.streams.set(streamId, stream);
		try {
			this.#send(session, {
				schemaVersion: EXTERNAL_CONNECTOR_JSONL_SCHEMA_VERSION,
				type: "request",
				requestId: streamId,
				operation: "events",
				supervisorRef: reference.supervisorRef,
				operationNonce: reference.operationNonce,
				payload: jsonPayload(handle),
			});
			for (;;) {
				const event = await this.#nextEvent(stream, options?.signal);
				if (event === undefined) return;
				yield jsonPayload(event);
			}
		} finally {
			session.streams.delete(streamId);
			session.closedStreamIds.add(streamId);
		}
	}

	async connect(
		mapping: CanonicalExternalConnectorMapping,
		options?: { readonly signal?: AbortSignal },
	): Promise<ExternalConnectorDriverHandle> {
		const reference = requestReference(mapping);
		const session = this.#session(reference);
		await this.#ensureHandshake(session, options?.signal);
		const result = await this.#request(session, "connect", jsonPayload(mapping), reference, options?.signal);
		if (!isExternalConnectorDriverHandle(result)) {
			throw new ExternalConnectorJsonlDriverError("external_event_invalid", "JSONL connect response is invalid");
		}
		return result;
	}

	async lookup(
		mapping: CanonicalExternalConnectorMapping,
		options?: { readonly signal?: AbortSignal },
	): Promise<ExternalConnectorDriverLookup> {
		const reference = requestReference(mapping);
		const session = this.#session(reference);
		await this.#ensureHandshake(session, options?.signal);
		const result = await this.#request(session, "lookup", jsonPayload(mapping), reference, options?.signal);
		if (!isExternalConnectorDriverLookup(result)) {
			throw new ExternalConnectorJsonlDriverError("external_event_invalid", "JSONL lookup response is invalid");
		}
		return result;
	}

	async read(
		handle: ExternalConnectorDriverHandle,
		options?: { readonly signal?: AbortSignal },
	): Promise<ExternalConnectorTerminalEvidence> {
		const reference = requestReference(handle);
		const session = this.#session(reference);
		await this.#ensureHandshake(session, options?.signal);
		const result = await this.#request(session, "read", jsonPayload(handle), reference, options?.signal);
		if (!isExternalConnectorTerminalEvidence(result)) {
			throw new ExternalConnectorJsonlDriverError("external_event_invalid", "JSONL read response is invalid");
		}
		return result;
	}

	async write(
		handle: ExternalConnectorDriverHandle,
		request: ExternalConnectorDriverWriteRequest,
		options?: { readonly signal?: AbortSignal },
	): Promise<void> {
		const reference = requestReference(handle);
		if (request.operationNonce !== reference.operationNonce) {
			throw new ExternalConnectorJsonlDriverError("external_event_invalid", "JSONL write nonce conflicts with its handle");
		}
		const session = this.#session(reference);
		await this.#ensureHandshake(session, options?.signal);
		await this.#request(session, "write", jsonPayload({ handle, request }), reference, options?.signal);
	}

	async heartbeat(
		handle: ExternalConnectorDriverHandle,
		options?: { readonly signal?: AbortSignal },
	): Promise<void> {
		const reference = requestReference(handle);
		const session = this.#session(reference);
		await this.#ensureHandshake(session, options?.signal);
		await this.#request(session, "heartbeat", jsonPayload(handle), reference, options?.signal);
	}

	async cancel(
		handle: ExternalConnectorDriverHandle,
		options?: { readonly signal?: AbortSignal },
	): Promise<ExternalConnectorTerminalEvidence | undefined> {
		const reference = requestReference(handle);
		const session = this.#session(reference);
		await this.#ensureHandshake(session, options?.signal);
		const result = await this.#request(session, "cancel", jsonPayload(handle), reference, options?.signal);
		if (result === null || result === undefined) return undefined;
		if (!isExternalConnectorTerminalEvidence(result)) {
			throw new ExternalConnectorJsonlDriverError("external_event_invalid", "JSONL cancel response is invalid");
		}
		return result;
	}

	async dispose(options?: { readonly signal?: AbortSignal }): Promise<void> {
		const sessions = [...this.#sessions.values()];
		const outcomes = await Promise.allSettled(
			sessions.map(async (session) => {
				if (session.error !== undefined) return;
				await this.#ensureHandshake(session, options?.signal);
				await this.#request(session, "dispose", jsonPayload(null), session.reference, options?.signal);
			}),
		);
		this.#sessions.clear();
		const failure = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
		if (failure !== undefined && !isProcessGoneError(failure.reason)) throw failure.reason;
	}

	async #ensureHandshake(session: ProcessSession, signal?: AbortSignal): Promise<void> {
		if (session.handshake !== undefined) return session.handshake;
		session.handshake = this.#performHandshake(session, signal);
		try {
			await session.handshake;
		} catch (error) {
			session.handshake = undefined;
			throw error;
		}
	}

	async #performHandshake(session: ProcessSession, signal?: AbortSignal): Promise<void> {
		const requestId = this.#nextRequestId();
		const frame = {
			schemaVersion: EXTERNAL_CONNECTOR_JSONL_SCHEMA_VERSION,
			type: "handshake" as const,
			requestId,
			supervisorRef: session.reference.supervisorRef,
			operationNonce: session.reference.operationNonce,
			protocolVersion: EXTERNAL_CONNECTOR_JSONL_PROTOCOL_VERSION,
			providerId: this.#providerId,
			version: this.#version,
			capability: this.#capability,
		};
		if (!isExternalConnectorJsonlHandshakeRequest(frame)) {
			throw new ExternalConnectorJsonlDriverError("external_event_invalid", "JSONL handshake request is invalid");
		}
		const response = await this.#requestResponse(session, requestId, "handshake", frame, signal);
		if (!isHandshakeResult(response)) {
			throw new ExternalConnectorJsonlDriverError("external_protocol_unsupported", "JSONL capability handshake response is invalid");
		}
		if (
			response.protocolVersion !== EXTERNAL_CONNECTOR_JSONL_PROTOCOL_VERSION ||
			response.providerId !== this.#providerId ||
			response.version !== this.#version ||
			!capabilityMatches(response.capability, this.#capability) ||
			!this.#hasRequiredImplementedOperations(response.implementedOperations)
		) {
			throw new ExternalConnectorJsonlDriverError(
				"external_capability_mismatch",
				"JSONL capability handshake does not match the trusted target",
			);
		}
	}

	#hasRequiredImplementedOperations(value: readonly string[]): boolean {
		const required = implementedOperationsFor(this.#capability);
		return required.every((operation) => value.includes(operation));
	}

	async #request(
		session: ProcessSession,
		operation: ExternalConnectorJsonlOperation,
		payload: FoundationJsonValue,
		reference: JsonlReference,
		signal?: AbortSignal,
	): Promise<unknown> {
		const requestId = this.#nextRequestId();
		const frame = {
			schemaVersion: EXTERNAL_CONNECTOR_JSONL_SCHEMA_VERSION,
			type: "request" as const,
			requestId,
			operation,
			supervisorRef: reference.supervisorRef,
			operationNonce: reference.operationNonce,
			payload,
		};
		if (!isExternalConnectorJsonlRequestFrame(frame)) {
			throw new ExternalConnectorJsonlDriverError("external_event_invalid", `JSONL ${operation} request is invalid`);
		}
		return this.#requestResponse(session, requestId, operation, frame, signal);
	}

	#requestResponse(
		session: ProcessSession,
		requestId: string,
		operation: ExternalConnectorJsonlOperation | "handshake",
		frame: FoundationJsonValue | Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<unknown> {
		if (session.error !== undefined) return Promise.reject(session.error);
		this.#startPump(session);
		return new Promise<unknown>((resolve, reject) => {
			let cleanup = (): void => undefined;
			const pending: PendingResponse = {
				requestId,
				operation,
				resolve,
				reject,
				cleanup: () => cleanup(),
			};
			session.pending.set(requestId, pending);
			try {
				this.#send(session, frame);
			} catch (error) {
				session.pending.delete(requestId);
				reject(error);
				return;
			}
			if (signal === undefined) return;
			const abort = (): void => {
				if (session.pending.get(requestId) !== pending) return;
				session.pending.delete(requestId);
				pending.cleanup();
				reject(new Error("External Connector JSONL request was aborted"));
			};
			if (signal.aborted) abort();
		else {
				signal.addEventListener("abort", abort, { once: true });
				cleanup = () => signal.removeEventListener("abort", abort);
			}
		});
	}

	#send(session: ProcessSession, frame: FoundationJsonValue | Record<string, unknown>): void {
		if (session.error !== undefined) throw session.error;
		let serialized: string;
		try {
			serialized = assertExternalConnectorJsonlFrameSize(frame);
		} catch (error) {
			if (error instanceof TypeError && error.message === "External Connector JSONL frame exceeds its size limit") {
				throw new ExternalConnectorJsonlDriverError("external_frame_oversize", "JSONL frame exceeds its size limit");
			}
			throw error;
		}
		if (Buffer.byteLength(serialized, "utf8") > EXTERNAL_CONNECTOR_JSONL_MAX_FRAME_BYTES) {
			throw new ExternalConnectorJsonlDriverError("external_frame_oversize", "JSONL frame exceeds its size limit");
		}
		session.channel.writeLine(serialized);
	}

	#startPump(session: ProcessSession): void {
		if (session.pump !== undefined) return;
		session.pump = this.#pump(session);
		void session.pump.catch((error: unknown) => this.#failSession(session, error));
	}

	async #pump(session: ProcessSession): Promise<void> {
		for (;;) {
			const line = await session.channel.readLine();
			if (line === undefined) throw new Error("External Connector JSONL process channel closed");
			let frame: ExternalConnectorJsonlFrame;
			try {
				frame = parseExternalConnectorJsonlFrame(line);
			} catch {
				throw new ExternalConnectorJsonlDriverError("external_event_invalid", "External Connector JSONL frame is invalid");
			}
			this.#dispatch(session, frame);
		}
	}

	#dispatch(session: ProcessSession, frame: ExternalConnectorJsonlFrame): void {
		if (
			("supervisorRef" in frame && frame.supervisorRef !== session.reference.supervisorRef) ||
			("operationNonce" in frame && frame.operationNonce !== session.reference.operationNonce)
		) {
			throw new ExternalConnectorJsonlDriverError("external_event_invalid", "JSONL frame reference conflicts with its channel");
		}
		if (frame.type === "event") {
			this.#dispatchEvent(session, frame);
			return;
		}
		if (frame.type === "events_end") {
			this.#dispatchEventsEnd(session, frame);
			return;
		}
		if (frame.type === "handshake_result") {
			const pending = session.pending.get(frame.requestId);
			if (pending === undefined || pending.operation !== "handshake") {
				throw new ExternalConnectorJsonlDriverError("external_event_invalid", "Unexpected or duplicate JSONL handshake response");
			}
			session.pending.delete(frame.requestId);
			pending.cleanup();
			pending.resolve(frame);
			return;
		}
		if (frame.type === "response" || frame.type === "error") {
			const pending = session.pending.get(frame.requestId);
			if (pending === undefined || pending.operation !== frame.operation) {
				throw new ExternalConnectorJsonlDriverError("external_event_invalid", "Unexpected, duplicate, or late JSONL response");
			}
			session.pending.delete(frame.requestId);
			pending.cleanup();
			if (frame.type === "error") pending.reject(new ExternalConnectorJsonlDriverError(frame.code, frame.message));
			else {
				try {
					pending.resolve(validateOperationResult(frame.operation, frame.result));
				} catch (error) {
					pending.reject(error);
					throw error;
				}
			}
		}
	}

	#dispatchEvent(session: ProcessSession, frame: ExternalConnectorJsonlEventFrame): void {
		const stream = session.streams.get(frame.streamId);
		if (stream === undefined || session.closedStreamIds.has(frame.streamId) || stream.ended) {
			throw new ExternalConnectorJsonlDriverError("external_event_invalid", "Unexpected, duplicate, or late JSONL event");
		}
		if (stream.waiter !== undefined) {
			const waiter = stream.waiter;
			stream.waiter = undefined;
			if (waiter.signal !== undefined && waiter.onAbort !== undefined) waiter.signal.removeEventListener("abort", waiter.onAbort);
			waiter.resolve(frame.event);
		} else {
			stream.events.push(frame.event);
		}
	}

	#dispatchEventsEnd(session: ProcessSession, frame: ExternalConnectorJsonlEventsEndFrame): void {
		const stream = session.streams.get(frame.streamId);
		if (stream === undefined || session.closedStreamIds.has(frame.streamId) || stream.ended) {
			throw new ExternalConnectorJsonlDriverError("external_event_invalid", "Unexpected, duplicate, or late JSONL event stream end");
		}
		stream.ended = true;
		if (stream.waiter !== undefined) {
			const waiter = stream.waiter;
			stream.waiter = undefined;
			if (waiter.signal !== undefined && waiter.onAbort !== undefined) waiter.signal.removeEventListener("abort", waiter.onAbort);
			waiter.resolve(undefined);
		}
	}

	#nextEvent(stream: EventStream, signal?: AbortSignal): Promise<ExternalConnectorDriverEvent | undefined> {
		if (stream.events.length > 0) return Promise.resolve(stream.events.shift());
		if (stream.error !== undefined) return Promise.reject(stream.error);
		if (stream.ended) return Promise.resolve(undefined);
		if (stream.waiter !== undefined) return Promise.reject(new Error("External Connector JSONL event stream has concurrent readers"));
		return new Promise<ExternalConnectorDriverEvent | undefined>((resolve, reject) => {
			const onAbort = (): void => {
				if (stream.waiter?.resolve !== resolve) return;
				stream.waiter = undefined;
				reject(new Error("External Connector JSONL event stream was aborted"));
			};
			stream.waiter = { resolve, reject, signal, onAbort };
			if (signal?.aborted === true) onAbort();
			else signal?.addEventListener("abort", onAbort, { once: true });
		});
	}

	#session(reference: JsonlReference): ProcessSession {
		const key = referenceKey(reference);
		const existing = this.#sessions.get(key);
		if (existing !== undefined) return existing;
		const controller = this.#processController;
		const channel = controller?.channelFor?.(reference);
		if (channel === undefined) {
			throw new ExternalConnectorJsonlDriverError("external_connector_unavailable", "External Connector JSONL process channel is unavailable");
		}
		const session: ProcessSession = {
			key,
			reference: Object.freeze({ ...reference }),
			channel,
			pending: new Map(),
			streams: new Map(),
			closedStreamIds: new Set(),
			handshake: undefined,
			pump: undefined,
			error: undefined,
		};
		this.#sessions.set(key, session);
		return session;
	}

	#failSession(session: ProcessSession, error: unknown): void {
		if (session.error !== undefined) return;
		session.error = error instanceof Error ? error : new Error(String(error));
		for (const pending of session.pending.values()) {
			pending.cleanup();
			pending.reject(session.error);
		}
		session.pending.clear();
		for (const stream of session.streams.values()) {
			stream.error = session.error;
			if (stream.waiter !== undefined) {
				const waiter = stream.waiter;
				stream.waiter = undefined;
				waiter.reject(session.error);
			}
		}
	}

	#nextRequestId(): string {
		this.#requestSequence += 1;
		return `jsonl_${this.#requestSequence}_${randomUUID().replaceAll("-", "")}`;
	}
}

function isHandshakeResult(value: unknown): value is ExternalConnectorJsonlHandshakeResult {
	return value !== null && typeof value === "object" && !Array.isArray(value) && "type" in value && value.type === "handshake_result";
}

function isProcessGoneError(value: unknown): boolean {
	if (!(value instanceof Error)) return false;
	if (/channel is closed|process channel closed|unavailable/iu.test(value.message)) return true;
	return "code" in value && value.code === "EPIPE";
}

/** Alias retained for package-private tests and composition code. */
export { JsonlProcessExternalConnectorDriver as JsonlProcessDriver };
