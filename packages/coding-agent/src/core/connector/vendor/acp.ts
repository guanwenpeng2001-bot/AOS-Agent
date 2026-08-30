/**
 * Private first-party ACP stable-v1 driver.
 *
 * This module is intentionally absent from the package entry point. It owns
 * protocol translation only; Attempt, mapping, ToolIntent, receipt, process,
 * and terminal authority stay with the existing Host connector path.
 */

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import path from "node:path";
import {
	AGENT_METHODS,
	CLIENT_METHODS,
	PROTOCOL_VERSION,
	RequestError,
	client,
	type AnyMessage,
	type ClientConnection,
	type CreateTerminalRequest,
	type InitializeResponse,
	type KillTerminalRequest,
	type LoadSessionResponse,
	type McpServer,
	type NewSessionResponse,
	type ReadTextFileRequest,
	type ReleaseTerminalRequest,
	type RequestPermissionRequest,
	type RequestPermissionResponse,
	type SessionNotification,
	type SessionUpdate,
	type Stream,
	type TerminalOutputRequest,
	type TerminalOutputResponse,
	type ToolCallStatus,
	type WaitForTerminalExitRequest,
	type WaitForTerminalExitResponse,
	type WriteTextFileRequest,
} from "@agentclientprotocol/sdk";
import {
	Result,
	type ArtifactRef,
	type ArtifactStoreProvider,
	type ConnectorCapabilitySnapshot,
	type FoundationJsonValue,
	type ToolExecutionResult,
	type ToolGatewayRequest,
} from "@aos-agent/agent-core";
import {
	createDurableExternalAgentConnector,
	type ExternalAgentConnectorRuntimeOptions,
} from "../durable-connector.ts";
import {
	isExternalConnectorMappingIdentifier,
	type CanonicalExternalConnectorMapping,
} from "../session-mapping.ts";
import {
	assertPathInsideWorkspace,
	resolveHostPathForPolicy,
	type HostFilesystemRoots,
} from "../../policy/filesystem.ts";
import { ExternalConnectorSupervisorError } from "../supervisor.ts";
import type {
	ExternalConnectorDriverEvent,
	ExternalConnectorDriverHandle,
	ExternalConnectorDriverLookup,
	ExternalConnectorDriverSpawnRequest,
	ExternalConnectorDriverWriteRequest,
	ExternalConnectorTerminalEvidence,
	ExternalConnectorVendorDriver,
} from "./types.ts";

const ACP_STABLE_PROTOCOL_VERSION = 1 as const;
const ACP_NAMESPACE = "acp";
const ACP_TOOL_NAMES = Object.freeze({
	permission: "acp.permission.request",
	readTextFile: "acp.fs.read_text_file",
	writeTextFile: "acp.fs.write_text_file",
	createTerminal: "acp.terminal.create",
	terminalOutput: "acp.terminal.output",
	releaseTerminal: "acp.terminal.release",
	waitForTerminalExit: "acp.terminal.wait_for_exit",
	killTerminal: "acp.terminal.kill",
});
const ACP_SIDE_EFFECTING_TOOL_NAMES: ReadonlySet<string> = new Set([
	ACP_TOOL_NAMES.writeTextFile,
	ACP_TOOL_NAMES.createTerminal,
	ACP_TOOL_NAMES.releaseTerminal,
	ACP_TOOL_NAMES.killTerminal,
]);

export const PRIVATE_ACP_STABLE_V1_LIMITS = Object.freeze({
	maxFrameBytes: 256 * 1024,
	maxTotalBytes: 4 * 1024 * 1024,
	maxEvents: 256,
	maxPendingWriteBytes: 256 * 1024,
	maxPendingClientOperations: 64,
	maxStderrBytes: 256 * 1024,
	requestTimeoutMs: 30_000,
});

export interface PrivateAcpStableV1Limits {
	readonly maxFrameBytes: number;
	readonly maxTotalBytes: number;
	readonly maxEvents: number;
	readonly maxPendingWriteBytes: number;
	readonly maxPendingClientOperations: number;
	readonly maxStderrBytes: number;
	readonly requestTimeoutMs: number;
}

/** Trusted Host-injected transport; the host does not discover or launch a process. */
export interface PrivateAcpStableV1Transport {
	/** Raw agent-to-client stable-v1 JSONL bytes. */
	readonly input: ReadableStream<Uint8Array>;
	/** Raw client-to-agent stable-v1 JSONL bytes. */
	readonly output: WritableStream<Uint8Array>;
	readonly stderr?: ReadableStream<Uint8Array>;
	close(error?: unknown): void | Promise<void>;
}

export interface PrivateAcpStableV1TransportRequest {
	readonly mode: "start" | "resume";
	readonly supervisorRef: string;
	readonly operationNonce: string;
	readonly signal?: AbortSignal;
}

export type PrivateAcpStableV1TransportFactory = (
	request: PrivateAcpStableV1TransportRequest,
) => Promise<PrivateAcpStableV1Transport>;

export type PrivateAcpStableV1McpServer = Extract<McpServer, { readonly type: "http" | "sse" }>;

export interface PrivateAcpStableV1DriverOptions {
	readonly providerId: string;
	readonly transportFactory: PrivateAcpStableV1TransportFactory;
	readonly cwd: string;
	readonly roots: HostFilesystemRoots;
	/** Exact Host-selected remote MCP visibility. Stdio and draft ACP transports remain disabled. */
	readonly mcpServers?: readonly PrivateAcpStableV1McpServer[];
	readonly artifactStore?: Pick<ArtifactStoreProvider, "get">;
	readonly limits?: Partial<PrivateAcpStableV1Limits>;
	readonly now?: () => string;
}

export type PrivateAcpExternalAgentConnectorOptions = Omit<
	ExternalAgentConnectorRuntimeOptions,
	"capabilityProbe" | "driver"
> & PrivateAcpStableV1DriverOptions;

type AcpDriverErrorCode =
	| "external_event_invalid"
	| "external_frame_oversize"
	| "external_protocol_unsupported"
	| "external_resource_limit_exceeded";

export class PrivateAcpStableV1Error extends Error {
	readonly code: AcpDriverErrorCode;

	constructor(code: AcpDriverErrorCode) {
		super(`ACP stable-v1 driver failed: ${code}`);
		this.name = "PrivateAcpStableV1Error";
		this.code = code;
	}
}

interface Deferred<T> {
	readonly promise: Promise<T>;
	readonly settled: () => boolean;
	readonly resolve: (value: T) => void;
	readonly reject: (error: unknown) => void;
}

interface PendingClientOperation {
	readonly toolName: string;
	readonly permission: boolean;
	readonly sideEffecting: boolean;
	readonly accept: (result: ToolExecutionResult) => void;
	readonly reject: (error: unknown) => void;
	readonly cancelPermission?: () => void;
}

interface AcpExecutionAuthority {
	readonly providerId: string;
	readonly attemptId: string;
	readonly taskId: string;
	readonly dispatchId: string;
	readonly bindingId: string;
	readonly bindingEpochId: string;
	readonly operationId: string;
}

interface AcpOperation {
	handle: ExternalConnectorDriverHandle;
	readonly transport: PrivateAcpStableV1Transport;
	readonly connection: ClientConnection;
	readonly events: BoundedEventQueue;
	readonly terminal: Deferred<ExternalConnectorTerminalEvidence>;
	readonly pending: Map<string, PendingClientOperation>;
	readonly authority?: AcpExecutionAuthority;
	stderrTask?: Promise<void>;
	sessionId: string;
	lastUpdateSequence: number;
	readonly toolCalls: Map<string, ToolCallStatus>;
	clientOperationSequence: number;
	sideEffectState: "none" | "unknown" | "side_effect_unknown";
	cancelRequested: boolean;
	closed: boolean;
}

class BoundedEventQueue {
	readonly #limit: number;
	readonly #values: FoundationJsonValue[] = [];
	readonly #waiters: Array<Deferred<IteratorResult<FoundationJsonValue>>> = [];
	#count = 0;
	#error: unknown;
	#closed = false;

	constructor(limit: number) {
		this.#limit = limit;
	}

	push(value: FoundationJsonValue): void {
		if (this.#closed || this.#error !== undefined) return;
		this.#count += 1;
		if (this.#count > this.#limit || this.#values.length >= this.#limit) {
			this.fail(resourceLimitError());
			return;
		}
		const waiter = this.#waiters.shift();
		if (waiter !== undefined) waiter.resolve({ done: false, value });
		else this.#values.push(value);
	}

	fail(error: unknown): void {
		if (this.#closed || this.#error !== undefined) return;
		this.#error = error;
		for (const waiter of this.#waiters.splice(0)) waiter.reject(error);
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		for (const waiter of this.#waiters.splice(0)) waiter.resolve({ done: true, value: undefined });
	}

	iterable(signal?: AbortSignal): AsyncIterable<FoundationJsonValue> {
		const queue = this;
		return {
			[Symbol.asyncIterator](): AsyncIterator<FoundationJsonValue> {
				return {
					async next(): Promise<IteratorResult<FoundationJsonValue>> {
						if (signal?.aborted === true) throw signal.reason;
						if (queue.#values.length > 0) return { done: false, value: queue.#values.shift()! };
						if (queue.#error !== undefined) throw queue.#error;
						if (queue.#closed) return { done: true, value: undefined };
						const waiter = deferred<IteratorResult<FoundationJsonValue>>();
						const abort = (): void => waiter.reject(signal?.reason);
						signal?.addEventListener("abort", abort, { once: true });
						queue.#waiters.push(waiter);
						try {
							return await waiter.promise;
						} finally {
							signal?.removeEventListener("abort", abort);
						}
					},
				};
			},
		};
	}
}

function deferred<T>(): Deferred<T> {
	let resolvePromise: ((value: T) => void) | undefined;
	let rejectPromise: ((error: unknown) => void) | undefined;
	let done = false;
	const promise = new Promise<T>((resolve, reject) => {
		resolvePromise = resolve;
		rejectPromise = reject;
	});
	void promise.catch(() => undefined);
	return {
		promise,
		settled: () => done,
		resolve: (value) => {
			if (done) return;
			done = true;
			resolvePromise!(value);
		},
		reject: (error) => {
			if (done) return;
			done = true;
			rejectPromise!(error);
		},
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: ReadonlySet<string>): boolean {
	return Reflect.ownKeys(value).every((key) => typeof key === "string" && keys.has(key));
}

function isPositiveSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function resolveLimits(value: Partial<PrivateAcpStableV1Limits> | undefined): PrivateAcpStableV1Limits {
	const limits = {
		...PRIVATE_ACP_STABLE_V1_LIMITS,
		...value,
	};
	if (Object.values(limits).some((limit) => !isPositiveSafeInteger(limit))) {
		throw new RangeError("ACP stable-v1 limits must be positive safe integers");
	}
	return Object.freeze(limits);
}

function resolveMcpServers(value: readonly PrivateAcpStableV1McpServer[] | undefined): readonly McpServer[] {
	if (value === undefined) return Object.freeze([]);
	return Object.freeze(value.map((server) => {
		if (
			!isRecord(server) ||
			!hasOnlyKeys(server, new Set(["type", "name", "url", "headers"])) ||
			(server.type !== "http" && server.type !== "sse") ||
			typeof server.name !== "string" ||
			server.name.length === 0 ||
			typeof server.url !== "string" ||
			!Array.isArray(server.headers)
		) {
			throw new TypeError("ACP MCP visibility contains an invalid stable remote server");
		}
		let parsed: URL;
		try {
			parsed = new URL(server.url);
		} catch {
			throw new TypeError("ACP MCP visibility contains an invalid server URL");
		}
		if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
			throw new TypeError("ACP MCP visibility only accepts HTTP(S) servers");
		}
		const headers = server.headers.map((header) => {
			if (
				!isRecord(header) ||
				!hasOnlyKeys(header, new Set(["name", "value"])) ||
				typeof header.name !== "string" ||
				header.name.length === 0 ||
				typeof header.value !== "string"
			) {
				throw new TypeError("ACP MCP visibility contains an invalid HTTP header");
			}
			return Object.freeze({ name: header.name, value: header.value });
		});
		return Object.freeze({
			type: server.type,
			name: server.name,
			url: server.url,
			headers,
		}) satisfies PrivateAcpStableV1McpServer;
	}));
}

function resourceLimitError(): ExternalConnectorSupervisorError {
	return new ExternalConnectorSupervisorError("external_resource_limit_exceeded", "event", false);
}

function frameOversizeError(): ExternalConnectorSupervisorError {
	return new ExternalConnectorSupervisorError("external_frame_oversize", "event", false);
}

function eventInvalidError(): ExternalConnectorSupervisorError {
	return new ExternalConnectorSupervisorError("external_event_invalid", "event", false);
}

function normalizeProtocolError(error: unknown): Error {
	return error instanceof ExternalConnectorSupervisorError || error instanceof PrivateAcpStableV1Error
		? error
		: eventInvalidError();
}

function jsonRpcIdKey(value: unknown): string | undefined {
	if (value === null) return "null";
	if (typeof value === "string") return `s:${value}`;
	if (typeof value === "number" && Number.isSafeInteger(value)) return `n:${value}`;
	return undefined;
}

function validateJsonRpcMessage(value: unknown): value is AnyMessage {
	if (!isRecord(value) || value.jsonrpc !== "2.0") return false;
	if (typeof value.method === "string") {
		const request = Object.hasOwn(value, "id");
		const keys = request
			? new Set(["jsonrpc", "id", "method", "params"])
			: new Set(["jsonrpc", "method", "params"]);
		return hasOnlyKeys(value, keys) && (!request || jsonRpcIdKey(value.id) !== undefined);
	}
	if (!Object.hasOwn(value, "id") || jsonRpcIdKey(value.id) === undefined) return false;
	const hasResult = Object.hasOwn(value, "result");
	const hasError = Object.hasOwn(value, "error");
	return hasResult !== hasError && hasOnlyKeys(value, new Set(["jsonrpc", "id", hasResult ? "result" : "error"]));
}

const INITIALIZE_RESPONSE_KEYS = new Set([
	"protocolVersion",
	"agentCapabilities",
	"authMethods",
	"agentInfo",
	"_meta",
]);
const AGENT_CAPABILITY_KEYS = new Set([
	"loadSession",
	"promptCapabilities",
	"mcpCapabilities",
	"sessionCapabilities",
	"auth",
	"_meta",
]);
const SESSION_CAPABILITY_KEYS = new Set(["list", "delete", "additionalDirectories", "resume", "close", "_meta"]);
const PROMPT_CAPABILITY_KEYS = new Set(["image", "audio", "embeddedContext", "_meta"]);
const MCP_CAPABILITY_KEYS = new Set(["http", "sse", "_meta"]);
const AUTH_CAPABILITY_KEYS = new Set(["logout", "_meta"]);
const IMPLEMENTATION_KEYS = new Set(["name", "title", "version", "_meta"]);

function validOptionalBoolean(value: unknown): boolean {
	return value === undefined || typeof value === "boolean";
}

function validOptionalCapabilityObject(value: unknown): boolean {
	return value === undefined || value === null || (isRecord(value) && hasOnlyKeys(value, new Set(["_meta"])));
}

function validateRawInitializeResponse(value: unknown): void {
	if (!isRecord(value) || !hasOnlyKeys(value, INITIALIZE_RESPONSE_KEYS) || value.protocolVersion !== 1) {
		throw new PrivateAcpStableV1Error("external_protocol_unsupported");
	}
	if (value.authMethods !== undefined && (!Array.isArray(value.authMethods) || value.authMethods.length !== 0)) {
		throw new PrivateAcpStableV1Error("external_protocol_unsupported");
	}
	if (
		value.agentInfo !== undefined &&
		value.agentInfo !== null &&
		(!isRecord(value.agentInfo) ||
			!hasOnlyKeys(value.agentInfo, IMPLEMENTATION_KEYS) ||
			typeof value.agentInfo.name !== "string" ||
			typeof value.agentInfo.version !== "string" ||
			(value.agentInfo.title !== undefined &&
				value.agentInfo.title !== null &&
				typeof value.agentInfo.title !== "string"))
	) {
		throw new PrivateAcpStableV1Error("external_protocol_unsupported");
	}
	if (value.agentCapabilities !== undefined) {
		if (!isRecord(value.agentCapabilities) || !hasOnlyKeys(value.agentCapabilities, AGENT_CAPABILITY_KEYS)) {
			throw new PrivateAcpStableV1Error("external_protocol_unsupported");
		}
		if (!validOptionalBoolean(value.agentCapabilities.loadSession)) {
			throw new PrivateAcpStableV1Error("external_protocol_unsupported");
		}
		const prompts = value.agentCapabilities.promptCapabilities;
		if (
			prompts !== undefined &&
			(!isRecord(prompts) ||
				!hasOnlyKeys(prompts, PROMPT_CAPABILITY_KEYS) ||
				!validOptionalBoolean(prompts.image) ||
				!validOptionalBoolean(prompts.audio) ||
				!validOptionalBoolean(prompts.embeddedContext))
		) {
			throw new PrivateAcpStableV1Error("external_protocol_unsupported");
		}
		const mcp = value.agentCapabilities.mcpCapabilities;
		if (
			mcp !== undefined &&
			(!isRecord(mcp) ||
				!hasOnlyKeys(mcp, MCP_CAPABILITY_KEYS) ||
				!validOptionalBoolean(mcp.http) ||
				!validOptionalBoolean(mcp.sse))
		) {
			throw new PrivateAcpStableV1Error("external_protocol_unsupported");
		}
		const sessions = value.agentCapabilities.sessionCapabilities;
		if (sessions !== undefined && sessions !== null && (!isRecord(sessions) || !hasOnlyKeys(sessions, SESSION_CAPABILITY_KEYS))) {
			throw new PrivateAcpStableV1Error("external_protocol_unsupported");
		}
		if (
			isRecord(sessions) &&
			![sessions.list, sessions.delete, sessions.additionalDirectories, sessions.resume, sessions.close].every(
				validOptionalCapabilityObject,
			)
		) {
			throw new PrivateAcpStableV1Error("external_protocol_unsupported");
		}
		const auth = value.agentCapabilities.auth;
		if (
			auth !== undefined &&
			(!isRecord(auth) || !hasOnlyKeys(auth, AUTH_CAPABILITY_KEYS) || !validOptionalCapabilityObject(auth.logout))
		) {
			throw new PrivateAcpStableV1Error("external_protocol_unsupported");
		}
	}
}

function validateRawStableInboundMessage(message: AnyMessage): void {
	if (!("method" in message) || message.method !== CLIENT_METHODS.session_update || !isRecord(message.params)) {
		return;
	}
	const update = message.params.update;
	if (!isRecord(update)) return;
	if (update.sessionUpdate === "plan_update" || update.sessionUpdate === "plan_removed") {
		throw new PrivateAcpStableV1Error("external_protocol_unsupported");
	}
	if (
		(update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") &&
		Object.hasOwn(update, "name")
	) {
		throw new PrivateAcpStableV1Error("external_protocol_unsupported");
	}
}

function boundedStream(
	transport: PrivateAcpStableV1Transport,
	limits: PrivateAcpStableV1Limits,
	onFailure: (error: unknown) => void,
): Stream {
	let totalBytes = 0;
	const pendingMethods = new Map<string, string>();
	const observe = (message: unknown, direction: "read" | "write"): AnyMessage => {
		if (!validateJsonRpcMessage(message)) throw eventInvalidError();
		if (direction === "read") validateRawStableInboundMessage(message);
		if (direction === "write" && "method" in message && Object.hasOwn(message, "id")) {
			pendingMethods.set(jsonRpcIdKey((message as { readonly id: unknown }).id)!, message.method);
		}
		if (direction === "read" && !("method" in message)) {
			const key = jsonRpcIdKey(message.id)!;
			const method = pendingMethods.get(key);
			pendingMethods.delete(key);
			if (method === AGENT_METHODS.initialize && "result" in message) validateRawInitializeResponse(message.result);
		}
		return message;
	};
	const countBytes = (bytes: number): void => {
		totalBytes += bytes;
		if (totalBytes > limits.maxTotalBytes) throw resourceLimitError();
	};

	let readSource: ReadableStreamDefaultReader<Uint8Array> | undefined;
	const readable = new ReadableStream<AnyMessage>({
		async start(controller) {
			const reader = transport.input.getReader();
			readSource = reader;
			let buffered = Buffer.alloc(0);
			const decoder = new TextDecoder("utf-8", { fatal: true });
			try {
				for (;;) {
					const next = await reader.read();
					if (next.done) break;
					const chunk = Buffer.from(next.value);
					countBytes(chunk.byteLength);
					let offset = 0;
					for (;;) {
						const newline = chunk.indexOf(0x0a, offset);
						if (newline === -1) break;
						const segment = chunk.subarray(offset, newline);
						const frameBytes = buffered.byteLength + segment.byteLength + 1;
						if (frameBytes > limits.maxFrameBytes) throw frameOversizeError();
						let line = buffered.byteLength === 0 ? segment : Buffer.concat([buffered, segment]);
						buffered = Buffer.alloc(0);
						if (line.byteLength > 0 && line[line.byteLength - 1] === 0x0d) line = line.subarray(0, -1);
						if (line.byteLength === 0) throw eventInvalidError();
						let parsed: unknown;
						try {
							parsed = JSON.parse(decoder.decode(line));
						} catch {
							throw eventInvalidError();
						}
						controller.enqueue(observe(parsed, "read"));
						offset = newline + 1;
					}
					const remainder = chunk.subarray(offset);
					if (buffered.byteLength + remainder.byteLength >= limits.maxFrameBytes) throw frameOversizeError();
					if (remainder.byteLength > 0) {
						buffered = buffered.byteLength === 0 ? Buffer.from(remainder) : Buffer.concat([buffered, remainder]);
					}
				}
				if (buffered.byteLength !== 0) throw eventInvalidError();
				controller.close();
			} catch (error) {
				const failure = normalizeProtocolError(error);
				onFailure(failure);
				controller.error(failure);
			} finally {
				readSource = undefined;
				reader.releaseLock();
			}
		},
		cancel(reason) {
			return readSource?.cancel(reason);
		},
	});

	const writable = new WritableStream<AnyMessage>({
		async write(message) {
			try {
				const observed = observe(message, "write");
				const frame = new TextEncoder().encode(`${JSON.stringify(observed)}\n`);
				if (frame.byteLength > limits.maxFrameBytes) throw frameOversizeError();
				if (frame.byteLength > limits.maxPendingWriteBytes) throw resourceLimitError();
				countBytes(frame.byteLength);
				const writer = transport.output.getWriter();
				try {
					await writer.write(frame);
				} finally {
					writer.releaseLock();
				}
			} catch (error) {
				const failure = normalizeProtocolError(error);
				onFailure(failure);
				throw failure;
			}
		},
		async close() {
			const writer = transport.output.getWriter();
			try {
				await writer.close();
			} finally {
				writer.releaseLock();
			}
		},
		async abort(reason) {
			const writer = transport.output.getWriter();
			try {
				await writer.abort(reason);
			} finally {
				writer.releaseLock();
			}
		},
	});
	return { readable, writable };
}

async function withTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<T> {
	if (signal?.aborted === true) throw signal.reason;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let abort: (() => void) | undefined;
	const timeout = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => reject(resourceLimitError()), timeoutMs);
		timer.unref?.();
		if (signal !== undefined) {
			abort = () => reject(signal.reason);
			signal.addEventListener("abort", abort, { once: true });
		}
	});
	try {
		return await Promise.race([promise, timeout]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
		if (abort !== undefined) signal?.removeEventListener("abort", abort);
	}
}

function validateTransport(value: unknown): asserts value is PrivateAcpStableV1Transport {
	if (
		!isRecord(value) ||
		!(value.input instanceof ReadableStream) ||
		!(value.output instanceof WritableStream) ||
		typeof value.close !== "function" ||
		(value.stderr !== undefined && !(value.stderr instanceof ReadableStream))
	) {
		throw new TypeError("ACP stable-v1 transport is invalid");
	}
}

function validateCapability(providerId: string, capability: ConnectorCapabilitySnapshot): void {
	if (
		capability.providerId !== providerId ||
		capability.protocol.name !== "acp" ||
		capability.protocol.version !== "1" ||
		capability.resume !== true ||
		capability.toolGateway !== true ||
		capability.artifacts ||
		capability.images ||
		(capability.modelAccess !== "agent_owned" && capability.modelAccess !== "none")
	) {
		throw new PrivateAcpStableV1Error("external_protocol_unsupported");
	}
}

function validateInitializeResponse(value: InitializeResponse, mcpServers: readonly McpServer[]): void {
	const requiresHttp = mcpServers.some((server) => "type" in server && server.type === "http");
	const requiresSse = mcpServers.some((server) => "type" in server && server.type === "sse");
	if (
		PROTOCOL_VERSION !== ACP_STABLE_PROTOCOL_VERSION ||
		value.protocolVersion !== ACP_STABLE_PROTOCOL_VERSION ||
		value.agentCapabilities?.loadSession !== true ||
		(value.authMethods?.length ?? 0) !== 0 ||
		value.agentCapabilities?.providers != null ||
		value.agentCapabilities?.nes != null ||
		value.agentCapabilities?.positionEncoding != null ||
		value.agentCapabilities?.sessionCapabilities?.fork != null
		|| (requiresHttp && value.agentCapabilities?.mcpCapabilities?.http !== true)
		|| (requiresSse && value.agentCapabilities?.mcpCapabilities?.sse !== true)
	) {
		throw new PrivateAcpStableV1Error("external_protocol_unsupported");
	}
}

function authorityFor(request: ExternalConnectorDriverSpawnRequest): AcpExecutionAuthority {
	const bindingEpochId = request.attempt.bindingEpochIds[0];
	const operationId = request.correlation.operationId;
	if (
		bindingEpochId === undefined ||
		request.correlation.runId === undefined ||
		operationId === undefined ||
		operationId !== request.correlation.runId ||
		request.attempt.dispatchId === undefined
	) {
		throw new TypeError("ACP execution requires canonical Tool Gateway correlation");
	}
	return Object.freeze({
		providerId: request.capability.providerId,
		attemptId: request.attempt.attemptId,
		taskId: request.attempt.taskId,
		dispatchId: request.attempt.dispatchId,
		bindingId: request.attempt.bindingId,
		bindingEpochId,
		operationId,
	});
}

function canonicalToolCallId(operation: AcpOperation, candidate?: string): string {
	operation.clientOperationSequence += 1;
	if (candidate !== undefined && isExternalConnectorMappingIdentifier(candidate)) return candidate;
	return `acp_tool_${createHash("sha256")
		.update(`${operation.handle.operationNonce}:${candidate ?? "generated"}:${operation.clientOperationSequence}`)
		.digest("hex")}`;
}

function toolGatewayRequest(
	operation: AcpOperation,
	toolCallId: string,
	toolName: string,
	originalArguments: FoundationJsonValue,
): ToolGatewayRequest {
	const authority = operation.authority;
	if (authority === undefined) throw eventInvalidError();
	return Object.freeze({
		schemaVersion: 1,
		toolCallId,
		toolName,
		namespace: ACP_NAMESPACE,
		originalArguments,
		idempotencyKey: `${operation.handle.operationNonce}:${toolCallId}`,
		context: Object.freeze({
			schemaVersion: 1,
			bindingId: authority.bindingId,
			bindingEpochId: authority.bindingEpochId,
			taskId: authority.taskId,
			dispatchId: authority.dispatchId,
			providerId: authority.providerId,
			attemptId: authority.attemptId,
			operationId: authority.operationId,
		}),
	});
}

function updateSideEffectState(operation: AcpOperation, result: ToolExecutionResult): void {
	if (result.sideEffectState === "side_effect_unknown") operation.sideEffectState = "side_effect_unknown";
	else if (result.sideEffectState === "unknown" && operation.sideEffectState === "none") operation.sideEffectState = "unknown";
}

function requireSuccessfulToolResult(result: ToolExecutionResult): ToolExecutionResult {
	if (!result.ok) throw RequestError.internalError(undefined, "Tool Gateway denied the ACP client operation");
	return result;
}

function requireExactToolResultRecord(
	result: ToolExecutionResult,
	keys: ReadonlySet<string>,
	operation: string,
): Record<string, FoundationJsonValue> {
	if (!isRecord(result.result) || !hasOnlyKeys(result.result, keys)) {
		throw RequestError.internalError(undefined, `${operation} route returned an invalid structured result`);
	}
	return result.result as Record<string, FoundationJsonValue>;
}

function validExitCode(value: FoundationJsonValue | undefined): value is number | null {
	return value === null || (typeof value === "number" && Number.isSafeInteger(value));
}

function validExitSignal(value: FoundationJsonValue | undefined): value is string | null {
	return value === null || typeof value === "string";
}

function terminalExitStatus(
	value: FoundationJsonValue | undefined,
): TerminalOutputResponse["exitStatus"] {
	if (value === undefined || value === null) return value;
	if (!isRecord(value) || !hasOnlyKeys(value, new Set(["exitCode", "signal"]))) {
		throw RequestError.internalError(undefined, "Terminal route returned an invalid exit status");
	}
	const exitCode = value.exitCode as FoundationJsonValue | undefined;
	const signal = value.signal as FoundationJsonValue | undefined;
	if (
		(exitCode !== undefined && !validExitCode(exitCode)) ||
		(signal !== undefined && !validExitSignal(signal))
	) {
		throw RequestError.internalError(undefined, "Terminal route returned an invalid exit status");
	}
	return {
		...(exitCode === undefined ? {} : { exitCode }),
		...(signal === undefined ? {} : { signal }),
	};
}

function permissionResponse(
	request: RequestPermissionRequest,
	result: ToolExecutionResult,
): RequestPermissionResponse {
	if (!result.ok) return { outcome: { outcome: "cancelled" } };
	if (!isRecord(result.result) || !hasOnlyKeys(result.result, new Set(["optionId"]))) {
		return { outcome: { outcome: "cancelled" } };
	}
	const requested = result.result.optionId;
	const selected = typeof requested === "string"
		? request.options.find((option) => option.optionId === requested)
		: undefined;
	return selected === undefined
		? { outcome: { outcome: "cancelled" } }
		: { outcome: { outcome: "selected", optionId: selected.optionId } };
}

function terminalEvidence(
	operation: AcpOperation,
	stopReason: "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled",
	now: () => string,
): ExternalConnectorTerminalEvidence {
	if (stopReason === "cancelled") {
		return {
			externalSessionId: operation.handle.externalSessionId,
			externalTurnId: operation.handle.externalTurnId,
			operationNonce: operation.handle.operationNonce,
			status: "cancelled",
			artifacts: [],
			sideEffectState: operation.sideEffectState,
			producedAt: now(),
		};
	}
	if (stopReason === "refusal") {
		return {
			externalSessionId: operation.handle.externalSessionId,
			externalTurnId: operation.handle.externalTurnId,
			operationNonce: operation.handle.operationNonce,
			status: "failed",
			artifacts: [],
			error: { code: "agent_run_failed", message: "Run failed.", category: "unknown", retryable: false },
			sideEffectState: operation.sideEffectState,
			producedAt: now(),
		};
	}
	return {
		externalSessionId: operation.handle.externalSessionId,
		externalTurnId: operation.handle.externalTurnId,
		operationNonce: operation.handle.operationNonce,
		status: "succeeded",
		artifacts: [],
		sideEffectState: operation.sideEffectState,
		producedAt: now(),
	};
}

function suspendedEvidence(operation: AcpOperation, now: () => string): ExternalConnectorTerminalEvidence {
	return {
		externalSessionId: operation.handle.externalSessionId,
		externalTurnId: operation.handle.externalTurnId,
		operationNonce: operation.handle.operationNonce,
		status: "suspended",
		artifacts: [],
		sideEffectState: "unknown",
		producedAt: now(),
	};
}

function operationEvent(operation: AcpOperation, event: ExternalConnectorDriverEvent): void {
	operation.events.push(event as unknown as FoundationJsonValue);
}

function sequenceForUpdate(operation: AcpOperation, notification: SessionNotification): number {
	const supplied = notification._meta?.["aos.sequence"];
	const sequence = supplied === undefined ? operation.lastUpdateSequence + 1 : supplied;
	if (!isPositiveSafeInteger(sequence) || sequence <= operation.lastUpdateSequence) throw eventInvalidError();
	operation.lastUpdateSequence = sequence;
	return sequence;
}

function isKnownSessionUpdate(update: SessionUpdate): boolean {
	switch (update.sessionUpdate) {
		case "user_message_chunk":
		case "agent_message_chunk":
		case "agent_thought_chunk":
		case "tool_call":
		case "tool_call_update":
		case "plan":
		case "available_commands_update":
		case "current_mode_update":
		case "config_option_update":
		case "session_info_update":
		case "usage_update":
		case "compaction_update":
		case "compaction_summary_chunk":
			return true;
		case "plan_update":
		case "plan_removed":
			return false;
	}
}

function acceptToolCallLifecycle(operation: AcpOperation, update: SessionUpdate): void {
	if (update.sessionUpdate === "tool_call") {
		if (operation.toolCalls.has(update.toolCallId)) throw eventInvalidError();
		operation.toolCalls.set(update.toolCallId, update.status ?? "pending");
		return;
	}
	if (update.sessionUpdate !== "tool_call_update") return;
	const previous = operation.toolCalls.get(update.toolCallId);
	if (previous === undefined || previous === "completed" || previous === "failed") throw eventInvalidError();
	const next = update.status;
	if (next == null || next === previous) return;
	if (
		(previous === "pending" && (next === "in_progress" || next === "completed" || next === "failed")) ||
		(previous === "in_progress" && (next === "completed" || next === "failed"))
	) {
		operation.toolCalls.set(update.toolCallId, next);
		return;
	}
	throw eventInvalidError();
}

function operationForSession(
	operation: AcpOperation | undefined,
	notification: { readonly sessionId: string },
): AcpOperation {
	if (operation === undefined || notification.sessionId !== operation.sessionId) throw eventInvalidError();
	return operation;
}

function mappingMatchesHandle(
	mapping: CanonicalExternalConnectorMapping,
	handle: ExternalConnectorDriverHandle,
): boolean {
	return (
		mapping.externalSessionId === handle.externalSessionId &&
		mapping.externalTurnId === handle.externalTurnId &&
		mapping.supervisor.ref === handle.supervisorRef &&
		mapping.supervisor.nonce === handle.operationNonce
	);
}

async function canonicalAbsolutePath(
	requestPath: string,
	access: "read" | "write",
	cwd: string,
	roots: HostFilesystemRoots,
): Promise<string> {
	let decoded: string;
	try {
		decoded = decodeURIComponent(requestPath);
	} catch {
		throw RequestError.invalidParams(undefined, "ACP path encoding is invalid");
	}
	if (!path.isAbsolute(decoded)) throw RequestError.invalidParams(undefined, "ACP path must be absolute");
	try {
		const resolved = await resolveHostPathForPolicy({ cwd, targetPath: decoded, roots, access });
		assertPathInsideWorkspace(resolved);
		return resolved.realPath;
	} catch {
		throw RequestError.invalidParams(undefined, "ACP path is outside the canonical workspace");
	}
}

async function canonicalWorkspace(cwd: string, roots: HostFilesystemRoots): Promise<string> {
	if (!path.isAbsolute(cwd)) throw new TypeError("ACP workspace cwd must be absolute");
	const resolved = await resolveHostPathForPolicy({ cwd, targetPath: cwd, roots, access: "read" });
	assertPathInsideWorkspace(resolved);
	return resolved.realPath;
}

/** @internal Package-private stable-v1 protocol driver. */
export class PrivateAcpStableV1Driver implements ExternalConnectorVendorDriver {
	readonly #providerId: string;
	readonly #transportFactory: PrivateAcpStableV1TransportFactory;
	readonly #cwd: string;
	readonly #roots: HostFilesystemRoots;
	readonly #artifactStore: Pick<ArtifactStoreProvider, "get"> | undefined;
	readonly #mcpServers: readonly McpServer[];
	readonly #limits: PrivateAcpStableV1Limits;
	readonly #now: () => string;
	readonly #operations = new Map<string, AcpOperation>();
	readonly #allOperations = new Set<AcpOperation>();

	constructor(options: PrivateAcpStableV1DriverOptions) {
		if (!isExternalConnectorMappingIdentifier(options.providerId)) throw new TypeError("ACP provider id is invalid");
		if (typeof options.transportFactory !== "function") throw new TypeError("ACP transport factory is required");
		this.#providerId = options.providerId;
		this.#transportFactory = options.transportFactory;
		this.#cwd = options.cwd;
		this.#roots = options.roots;
		this.#artifactStore = options.artifactStore;
		this.#mcpServers = resolveMcpServers(options.mcpServers);
		this.#limits = resolveLimits(options.limits);
		this.#now = options.now ?? (() => new Date().toISOString());
	}

	async spawn(request: ExternalConnectorDriverSpawnRequest): Promise<ExternalConnectorDriverHandle> {
		validateCapability(this.#providerId, request.capability);
		if (request.input.artifacts.length > 0) throw new PrivateAcpStableV1Error("external_protocol_unsupported");
		const authority = authorityFor(request);
		const operation = await this.#openOperation({
			mode: "start",
			supervisorRef: request.supervisorRef,
			operationNonce: request.operationNonce,
			externalTurnId: request.attempt.attemptId,
			authority,
			signal: request.signal,
		});
		try {
			const initialized = await this.#request<InitializeResponse>(operation, AGENT_METHODS.initialize, {
				protocolVersion: ACP_STABLE_PROTOCOL_VERSION,
				clientCapabilities: {
					fs: { readTextFile: true, writeTextFile: true },
					terminal: true,
				},
				clientInfo: { name: "aos-agent-private-acp", version: "1" },
			}, request.signal);
			validateInitializeResponse(initialized, this.#mcpServers);
			const cwd = await canonicalWorkspace(this.#cwd, this.#roots);
			const session = await this.#request<NewSessionResponse>(operation, AGENT_METHODS.session_new, {
				cwd,
				mcpServers: [...this.#mcpServers],
			}, request.signal);
			if (!isExternalConnectorMappingIdentifier(session.sessionId)) {
				throw new PrivateAcpStableV1Error("external_event_invalid");
			}
			operation.sessionId = session.sessionId;
			operation.handle = Object.freeze({ ...operation.handle, externalSessionId: session.sessionId });
			this.#operations.set(session.sessionId, operation);
			operationEvent(operation, {
				schemaVersion: 1,
				type: "started",
				externalSessionId: session.sessionId,
				externalTurnId: operation.handle.externalTurnId,
				producedAt: this.#now(),
			});
			void this.#prompt(operation, request.input.text, request.signal);
			return operation.handle;
		} catch (error) {
			await this.#closeOperation(operation);
			throw error;
		}
	}

	events(
		handle: ExternalConnectorDriverHandle,
		options?: { readonly signal?: AbortSignal },
	): AsyncIterable<FoundationJsonValue> {
		return this.#requireOperation(handle).events.iterable(options?.signal);
	}

	async connect(
		mapping: CanonicalExternalConnectorMapping,
		options?: { readonly signal?: AbortSignal },
	): Promise<ExternalConnectorDriverHandle> {
		const known = this.#operations.get(mapping.externalSessionId);
		if (known !== undefined && !known.closed) {
			if (!mappingMatchesHandle(mapping, known.handle)) throw eventInvalidError();
			return known.handle;
		}
		const operation = await this.#openOperation({
			mode: "resume",
			supervisorRef: mapping.supervisor.ref,
			operationNonce: mapping.supervisor.nonce,
			externalSessionId: mapping.externalSessionId,
			externalTurnId: mapping.externalTurnId,
			signal: options?.signal,
		});
		try {
			const initialized = await this.#request<InitializeResponse>(operation, AGENT_METHODS.initialize, {
				protocolVersion: ACP_STABLE_PROTOCOL_VERSION,
				clientCapabilities: {
					fs: { readTextFile: true, writeTextFile: true },
					terminal: true,
				},
				clientInfo: { name: "aos-agent-private-acp", version: "1" },
			}, options?.signal);
			validateInitializeResponse(initialized, this.#mcpServers);
			operationEvent(operation, {
				schemaVersion: 1,
				type: "started",
				externalSessionId: operation.sessionId,
				...(operation.handle.externalTurnId === undefined
					? {}
					: { externalTurnId: operation.handle.externalTurnId }),
				producedAt: this.#now(),
			});
			const cwd = await canonicalWorkspace(this.#cwd, this.#roots);
			await this.#request<LoadSessionResponse>(operation, AGENT_METHODS.session_load, {
				sessionId: mapping.externalSessionId,
				cwd,
				mcpServers: [...this.#mcpServers],
			}, options?.signal);
			const evidence = suspendedEvidence(operation, this.#now);
			operation.terminal.resolve(evidence);
			operation.events.close();
			return operation.handle;
		} catch (error) {
			await this.#closeOperation(operation);
			throw error;
		}
	}

	async lookup(mapping: CanonicalExternalConnectorMapping): Promise<ExternalConnectorDriverLookup> {
		const operation = this.#operations.get(mapping.externalSessionId);
		if (operation === undefined || !mappingMatchesHandle(mapping, operation.handle)) return { status: "ambiguous" };
		if (!operation.terminal.settled()) return { status: "running", handle: operation.handle };
		try {
			return { status: "terminal", evidence: await operation.terminal.promise };
		} catch {
			return { status: "ambiguous" };
		}
	}

	async read(
		handle: ExternalConnectorDriverHandle,
		options?: { readonly signal?: AbortSignal },
	): Promise<ExternalConnectorTerminalEvidence> {
		const operation = this.#requireOperation(handle);
		return withTimeout(operation.terminal.promise, this.#limits.requestTimeoutMs, options?.signal);
	}

	async write(
		handle: ExternalConnectorDriverHandle,
		request: ExternalConnectorDriverWriteRequest,
	): Promise<void> {
		const operation = this.#requireOperation(handle);
		if (request.operationNonce !== operation.handle.operationNonce) throw eventInvalidError();
		const pending = operation.pending.get(request.result.toolCallId);
		if (pending === undefined || pending.toolName !== request.result.toolName) throw eventInvalidError();
		operation.pending.delete(request.result.toolCallId);
		updateSideEffectState(operation, request.result);
		pending.accept(request.result);
	}

	async heartbeat(handle: ExternalConnectorDriverHandle): Promise<void> {
		const operation = this.#requireOperation(handle);
		if (operation.connection.signal.aborted) throw eventInvalidError();
	}

	async cancel(
		handle: ExternalConnectorDriverHandle,
		options?: { readonly signal?: AbortSignal },
	): Promise<ExternalConnectorTerminalEvidence | undefined> {
		const operation = this.#requireOperation(handle);
		operation.cancelRequested = true;
		if ([...operation.pending.values()].some((pending) => pending.sideEffecting)) {
			operation.sideEffectState = "side_effect_unknown";
		}
		for (const pending of operation.pending.values()) {
			if (pending.permission) pending.cancelPermission?.();
			pending.reject(RequestError.requestCancelled());
		}
		operation.pending.clear();
		await operation.connection.agent.notify(AGENT_METHODS.session_cancel, { sessionId: operation.sessionId });
		try {
			return await withTimeout(operation.terminal.promise, this.#limits.requestTimeoutMs, options?.signal);
		} catch {
			return undefined;
		}
	}

	async dispose(): Promise<void> {
		const operations = [...this.#allOperations];
		this.#operations.clear();
		await Promise.allSettled(operations.map((operation) => this.#closeOperation(operation)));
		this.#allOperations.clear();
	}

	async #openOperation(input: {
		readonly mode: "start" | "resume";
		readonly supervisorRef: string;
		readonly operationNonce: string;
		readonly externalSessionId?: string;
		readonly externalTurnId?: string;
		readonly authority?: AcpExecutionAuthority;
		readonly signal?: AbortSignal;
	}): Promise<AcpOperation> {
		const transport = await withTimeout(
			this.#transportFactory({
				mode: input.mode,
				supervisorRef: input.supervisorRef,
				operationNonce: input.operationNonce,
				signal: input.signal,
			}),
			this.#limits.requestTimeoutMs,
			input.signal,
		);
		validateTransport(transport);
		let operation: AcpOperation | undefined;
		const fail = (error: unknown): void => {
			if (operation === undefined) return;
			operation.events.fail(error);
			operation.terminal.reject(error);
			operation.connection.close(error);
		};
		const app = client({ name: "aos-agent-private-acp" })
			.onNotification(CLIENT_METHODS.session_update, ({ params }) => {
				const current = operationForSession(operation, params);
				try {
					this.#acceptSessionUpdate(current, params);
				} catch (error) {
					fail(error);
					throw error;
				}
			})
			.onRequest(CLIENT_METHODS.session_request_permission, ({ params }) =>
				this.#requestPermission(operationForSession(operation, params), params),
			)
			.onRequest(CLIENT_METHODS.fs_read_text_file, ({ params, signal }) =>
				this.#readTextFile(operationForSession(operation, params), params, signal),
			)
			.onRequest(CLIENT_METHODS.fs_write_text_file, ({ params }) =>
				this.#writeTextFile(operationForSession(operation, params), params),
			)
			.onRequest(CLIENT_METHODS.terminal_create, ({ params }) =>
				this.#createTerminal(operationForSession(operation, params), params),
			)
			.onRequest(CLIENT_METHODS.terminal_output, ({ params, signal }) =>
				this.#terminalOutput(operationForSession(operation, params), params, signal),
			)
			.onRequest(CLIENT_METHODS.terminal_release, ({ params }) =>
				this.#emptyTerminalOperation(operationForSession(operation, params), ACP_TOOL_NAMES.releaseTerminal, params),
			)
			.onRequest(CLIENT_METHODS.terminal_wait_for_exit, ({ params }) =>
				this.#waitForTerminalExit(operationForSession(operation, params), params),
			)
			.onRequest(CLIENT_METHODS.terminal_kill, ({ params }) =>
				this.#emptyTerminalOperation(operationForSession(operation, params), ACP_TOOL_NAMES.killTerminal, params),
			);
		const connection = app.connect(boundedStream(transport, this.#limits, fail));
		operation = {
			handle: Object.freeze({
				externalSessionId: input.externalSessionId ?? "acp_session_pending",
				...(input.externalTurnId === undefined ? {} : { externalTurnId: input.externalTurnId }),
				supervisorRef: input.supervisorRef,
				operationNonce: input.operationNonce,
			}),
			transport,
			connection,
			events: new BoundedEventQueue(this.#limits.maxEvents),
			terminal: deferred<ExternalConnectorTerminalEvidence>(),
			pending: new Map(),
			...(input.authority === undefined ? {} : { authority: input.authority }),
			sessionId: input.externalSessionId ?? "",
			lastUpdateSequence: 0,
			toolCalls: new Map(),
			clientOperationSequence: 0,
			sideEffectState: "none",
			cancelRequested: false,
			closed: false,
		};
		this.#allOperations.add(operation);
		if (input.externalSessionId !== undefined) this.#operations.set(input.externalSessionId, operation);
		if (transport.stderr !== undefined) operation.stderrTask = this.#drainStderr(operation, transport.stderr);
		void connection.closed.then(() => {
			if (!operation?.closed && !operation?.terminal.settled()) fail(eventInvalidError());
		});
		return operation;
	}

	async #request<Response>(
		operation: AcpOperation,
		method: string,
		params: unknown,
		signal?: AbortSignal,
	): Promise<Response> {
		return withTimeout(
			operation.connection.agent.request<Response, unknown>(method, params, { cancellationSignal: signal }),
			this.#limits.requestTimeoutMs,
			signal,
		);
	}

	async #prompt(operation: AcpOperation, text: string, signal?: AbortSignal): Promise<void> {
		try {
			const response = await this.#request<{
				readonly stopReason: "end_turn" | "max_tokens" | "max_turn_requests" | "refusal" | "cancelled";
			}>(operation, AGENT_METHODS.session_prompt, {
				sessionId: operation.sessionId,
				prompt: [{ type: "text", text }],
				_meta: {
					"aos.operationNonce": operation.handle.operationNonce,
					"aos.turnId": operation.handle.externalTurnId,
				},
			}, signal);
			const evidence = terminalEvidence(operation, response.stopReason, this.#now);
			if (operation.cancelRequested && evidence.status !== "cancelled") throw eventInvalidError();
			operation.terminal.resolve(evidence);
			operation.events.close();
		} catch (error) {
			operation.events.fail(error);
			operation.terminal.reject(error);
		}
	}

	#acceptSessionUpdate(operation: AcpOperation, notification: SessionNotification): void {
		if (!isKnownSessionUpdate(notification.update)) throw eventInvalidError();
		acceptToolCallLifecycle(operation, notification.update);
		const sequence = sequenceForUpdate(operation, notification);
		operationEvent(operation, {
			schemaVersion: 1,
			type: "progress",
			externalSessionId: operation.sessionId,
			...(operation.handle.externalTurnId === undefined ? {} : { externalTurnId: operation.handle.externalTurnId }),
			sequence,
			phase: notification.update.sessionUpdate,
			producedAt: this.#now(),
		});
	}

	async #requestGateway(
		operation: AcpOperation,
		toolName: string,
		originalArguments: FoundationJsonValue,
		options: {
			readonly candidateToolCallId?: string;
			readonly permission?: boolean;
			readonly cancelPermission?: () => void;
		} = {},
	): Promise<ToolExecutionResult> {
		if (operation.cancelRequested) throw RequestError.requestCancelled();
		if (operation.pending.size >= this.#limits.maxPendingClientOperations) throw resourceLimitError();
		const toolCallId = canonicalToolCallId(operation, options.candidateToolCallId);
		if (operation.pending.has(toolCallId)) throw eventInvalidError();
		const result = deferred<ToolExecutionResult>();
		operation.pending.set(toolCallId, {
			toolName,
			permission: options.permission === true,
			sideEffecting: ACP_SIDE_EFFECTING_TOOL_NAMES.has(toolName),
			accept: result.resolve,
			reject: result.reject,
			...(options.cancelPermission === undefined ? {} : { cancelPermission: options.cancelPermission }),
		});
		const request = toolGatewayRequest(operation, toolCallId, toolName, originalArguments);
		operationEvent(operation, {
			schemaVersion: 1,
			type: "tool_gateway_request",
			externalSessionId: operation.sessionId,
			...(operation.handle.externalTurnId === undefined ? {} : { externalTurnId: operation.handle.externalTurnId }),
			operationNonce: operation.handle.operationNonce,
			request,
			producedAt: this.#now(),
		});
		try {
			return await withTimeout(result.promise, this.#limits.requestTimeoutMs);
		} finally {
			operation.pending.delete(toolCallId);
		}
	}

	async #requestPermission(
		operation: AcpOperation,
		params: RequestPermissionRequest,
	): Promise<RequestPermissionResponse> {
		const cancelled = deferred<RequestPermissionResponse>();
		const gateway = this.#requestGateway(
			operation,
			ACP_TOOL_NAMES.permission,
			{
				toolCall: params.toolCall as unknown as FoundationJsonValue,
				options: params.options as unknown as FoundationJsonValue,
			},
			{
				candidateToolCallId: params.toolCall.toolCallId,
				permission: true,
				cancelPermission: () => cancelled.resolve({ outcome: { outcome: "cancelled" } }),
			},
		);
		const outcome = await Promise.race([
			gateway.then(
				(result) => permissionResponse(params, result),
				() => ({ outcome: { outcome: "cancelled" as const } }),
			),
			cancelled.promise,
		]);
		return outcome;
	}

	async #readTextFile(
		operation: AcpOperation,
		params: ReadTextFileRequest,
		signal: AbortSignal,
	): Promise<{ readonly content: string }> {
		const path = await canonicalAbsolutePath(params.path, "read", this.#cwd, this.#roots);
		const result = requireSuccessfulToolResult(await this.#requestGateway(operation, ACP_TOOL_NAMES.readTextFile, {
			path,
			...(params.line == null ? {} : { line: params.line }),
			...(params.limit == null ? {} : { limit: params.limit }),
		}));
		return { content: await this.#readArtifactText(result.artifacts, signal) };
	}

	async #writeTextFile(operation: AcpOperation, params: WriteTextFileRequest): Promise<Record<string, never>> {
		const path = await canonicalAbsolutePath(params.path, "write", this.#cwd, this.#roots);
		requireSuccessfulToolResult(await this.#requestGateway(operation, ACP_TOOL_NAMES.writeTextFile, {
			path,
			content: params.content,
		}));
		return {};
	}

	async #createTerminal(
		operation: AcpOperation,
		params: CreateTerminalRequest,
	): Promise<{ readonly terminalId: string }> {
		const cwd = await canonicalAbsolutePath(params.cwd ?? this.#cwd, "read", this.#cwd, this.#roots);
		const result = requireSuccessfulToolResult(await this.#requestGateway(operation, ACP_TOOL_NAMES.createTerminal, {
			command: params.command,
			args: params.args ?? [],
			env: (params.env ?? []).map((item) => ({ name: item.name, value: item.value })),
			cwd,
			...(params.outputByteLimit == null ? {} : { outputByteLimit: params.outputByteLimit }),
		}));
		const structured = requireExactToolResultRecord(result, new Set(["terminalId"]), "Terminal create");
		if (!isExternalConnectorMappingIdentifier(structured.terminalId)) {
			throw RequestError.internalError(undefined, "Terminal route returned no stable terminal id");
		}
		return { terminalId: structured.terminalId };
	}

	async #terminalOutput(
		operation: AcpOperation,
		params: TerminalOutputRequest,
		signal: AbortSignal,
	): Promise<TerminalOutputResponse> {
		const result = requireSuccessfulToolResult(await this.#requestGateway(operation, ACP_TOOL_NAMES.terminalOutput, {
			terminalId: params.terminalId,
		}));
		if (signal.aborted) throw signal.reason;
		const structured = requireExactToolResultRecord(
			result,
			new Set(["output", "truncated", "exitStatus"]),
			"Terminal output",
		);
		if (typeof structured.output !== "string" || typeof structured.truncated !== "boolean") {
			throw RequestError.internalError(undefined, "Terminal output route returned invalid output metadata");
		}
		const exitStatus = terminalExitStatus(structured.exitStatus);
		return {
			output: structured.output,
			truncated: structured.truncated,
			...(exitStatus === undefined ? {} : { exitStatus }),
		};
	}

	async #emptyTerminalOperation(
		operation: AcpOperation,
		toolName: string,
		params: ReleaseTerminalRequest | KillTerminalRequest,
	): Promise<Record<string, never>> {
		requireSuccessfulToolResult(await this.#requestGateway(operation, toolName, { terminalId: params.terminalId }));
		return {};
	}

	async #waitForTerminalExit(
		operation: AcpOperation,
		params: WaitForTerminalExitRequest,
	): Promise<WaitForTerminalExitResponse> {
		const result = requireSuccessfulToolResult(await this.#requestGateway(operation, ACP_TOOL_NAMES.waitForTerminalExit, {
			terminalId: params.terminalId,
		}));
		const structured = requireExactToolResultRecord(result, new Set(["exitCode", "signal"]), "Terminal wait");
		const exitCode = structured.exitCode;
		const signal = structured.signal;
		if (
			(exitCode !== undefined && !validExitCode(exitCode)) ||
			(signal !== undefined && !validExitSignal(signal))
		) {
			throw RequestError.internalError(undefined, "Terminal wait route returned invalid exit metadata");
		}
		return {
			...(exitCode === undefined ? {} : { exitCode }),
			...(signal === undefined ? {} : { signal }),
		};
	}

	async #readArtifactText(artifacts: readonly ArtifactRef[] | undefined, signal: AbortSignal): Promise<string> {
		if (this.#artifactStore === undefined || artifacts?.length !== 1) {
			throw RequestError.internalError(undefined, "ACP text result requires one Artifact Store reference");
		}
		if (signal.aborted) throw signal.reason;
		const loaded = await this.#artifactStore.get(artifacts[0]!.artifactId);
		if (!loaded.ok || loaded.value.byteLength > this.#limits.maxFrameBytes) {
			throw RequestError.internalError(undefined, "ACP text result artifact is unavailable");
		}
		try {
			return new TextDecoder("utf-8", { fatal: true }).decode(loaded.value);
		} catch {
			throw RequestError.internalError(undefined, "ACP text result artifact is not UTF-8");
		}
	}

	#requireOperation(handle: ExternalConnectorDriverHandle): AcpOperation {
		const operation = this.#operations.get(handle.externalSessionId);
		if (
			operation === undefined ||
			operation.handle.externalTurnId !== handle.externalTurnId ||
			operation.handle.supervisorRef !== handle.supervisorRef ||
			operation.handle.operationNonce !== handle.operationNonce
		) {
			throw eventInvalidError();
		}
		return operation;
	}

	async #drainStderr(operation: AcpOperation, stderr: ReadableStream<Uint8Array>): Promise<void> {
		const reader = stderr.getReader();
		let bytes = 0;
		try {
			for (;;) {
				const next = await reader.read();
				if (next.done) return;
				bytes += next.value.byteLength;
				if (bytes > this.#limits.maxStderrBytes) throw resourceLimitError();
			}
		} catch (error) {
			const failure = normalizeProtocolError(error);
			operation.events.fail(failure);
			operation.terminal.reject(failure);
			operation.connection.close(failure);
		} finally {
			reader.releaseLock();
		}
	}

	async #closeOperation(operation: AcpOperation): Promise<void> {
		if (operation.closed) return;
		operation.closed = true;
		for (const pending of operation.pending.values()) pending.reject(RequestError.requestCancelled());
		operation.pending.clear();
		operation.events.close();
		operation.connection.close();
		await Promise.allSettled([
			Promise.resolve(operation.transport.close()),
			...(operation.stderrTask === undefined ? [] : [operation.stderrTask]),
		]);
	}
}

/**
 * Explicit opt-in composition. Construction is passive; only run/resume opens
 * the injected stable transport. No ACP symbol is exported from package root.
 */
export function createPrivateAcpExternalAgentConnector(
	options: PrivateAcpExternalAgentConnectorOptions,
) {
	validateCapability(options.providerId, options.capability);
	const driver = new PrivateAcpStableV1Driver(options);
	return createDurableExternalAgentConnector({
		providerId: options.providerId,
		capability: options.capability,
		capabilityProbe: async () => Result.ok(options.capability),
		store: options.store,
		driver,
		supervision: options.supervision,
		...(options.now === undefined ? {} : { now: options.now }),
		...(options.operationNonce === undefined ? {} : { operationNonce: options.operationNonce }),
	});
}
