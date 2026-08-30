/**
 * Private Codex app-server v2 driver.
 *
 * The Host injects an already bounded stdio transport and owns process,
 * credential, policy, receipt, and reconciliation authority. This module only
 * translates the frozen app-server JSONL subset into the existing private
 * ExternalAgentConnector driver boundary.
 */

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import path from "node:path";
import {
	type ConnectorCapabilitySnapshot,
	type FoundationJsonValue,
	Result,
	type ToolExecutionResult,
	type ToolGatewayRequest,
} from "../../../../../agent/src/internal.ts";
import {
	createDurableExternalAgentConnector,
	type ExternalAgentConnectorRuntimeOptions,
} from "../durable-connector.ts";
import { ExternalConnectorSupervisorError } from "../supervisor.ts";
import {
	type CanonicalExternalConnectorMapping,
	isExternalConnectorMappingIdentifier,
} from "../session-mapping.ts";
import { assertPathInsideWorkspace, type HostFilesystemRoots, resolveHostPathForPolicy } from "../../policy/filesystem.ts";
import type {
	ExternalConnectorDriverEvent,
	ExternalConnectorDriverHandle,
	ExternalConnectorDriverLookup,
	ExternalConnectorDriverSpawnRequest,
	ExternalConnectorDriverWriteRequest,
	ExternalConnectorTerminalEvidence,
	ExternalConnectorVendorDriver,
} from "./types.ts";

/** Frozen against `codex-cli 0.149.0 app-server generate-json-schema --experimental`. */
export const PRIVATE_CODEX_APP_SERVER_IDENTITY = Object.freeze({
	cliVersion: "0.149.0",
	schemaSha256: "6f76cce25156d405f1da54f205751e38f7b9eb42246ac0742b9958dd60275350",
});

export const PRIVATE_CODEX_APP_SERVER_LIMITS = Object.freeze({
	maxFrameBytes: 256 * 1024,
	maxTotalBytes: 4 * 1024 * 1024,
	maxEvents: 256,
	maxPendingWriteBytes: 256 * 1024,
	maxPendingRequests: 64,
	maxStderrBytes: 256 * 1024,
	requestTimeoutMs: 30_000,
	operationTimeoutMs: 60 * 60_000,
});

export const PRIVATE_CODEX_SERVER_REQUEST_ROUTES = Object.freeze({
	commandApproval: Object.freeze({ namespace: "codex", toolName: "approval.command_execution" }),
	fileChangeApproval: Object.freeze({ namespace: "codex", toolName: "approval.file_change" }),
	permissionsApproval: Object.freeze({ namespace: "codex", toolName: "approval.permissions" }),
	mcpElicitation: Object.freeze({ namespace: "codex", toolName: "mcp.elicitation" }),
	requestUserInput: Object.freeze({ namespace: "codex", toolName: "tool.request_user_input" }),
});

export interface PrivateCodexAppServerLimits {
	readonly maxFrameBytes: number;
	readonly maxTotalBytes: number;
	readonly maxEvents: number;
	readonly maxPendingWriteBytes: number;
	readonly maxPendingRequests: number;
	readonly maxStderrBytes: number;
	readonly requestTimeoutMs: number;
	readonly operationTimeoutMs: number;
}

export interface PrivateCodexAppServerTransport {
	/** Raw app-server stdout JSONL bytes. */
	readonly input: ReadableStream<Uint8Array>;
	/** Raw app-server stdin JSONL bytes. */
	readonly output: WritableStream<Uint8Array>;
	readonly stderr?: ReadableStream<Uint8Array>;
	/** Identity proven by the explicit activation/composition layer. */
	readonly identity: {
		readonly cliVersion: string;
		readonly schemaSha256: string;
	};
	close(error?: unknown): void | Promise<void>;
}

export interface PrivateCodexAppServerTransportRequest {
	readonly mode: "start" | "resume";
	readonly supervisorRef: string;
	readonly operationNonce: string;
	readonly signal?: AbortSignal;
}

export type PrivateCodexAppServerTransportFactory = (
	request: PrivateCodexAppServerTransportRequest,
) => Promise<PrivateCodexAppServerTransport>;

export interface PrivateCodexDynamicTool {
	/** Codex-visible namespace. Null creates a top-level function. */
	readonly codexNamespace: string | null;
	readonly codexName: string;
	readonly description: string;
	readonly inputSchema: FoundationJsonValue;
	/** Exact existing Tool Gateway route selected by the Host. */
	readonly gateway: {
		readonly namespace: string;
		readonly toolName: string;
	};
}

type CodexApprovalPolicy = "untrusted" | "on-request" | "never";
type CodexApprovalsReviewer = "user" | "auto_review" | "guardian_subagent";
type CodexSandboxMode = "read-only" | "workspace-write" | "danger-full-access";

export interface PrivateCodexAppServerDriverOptions {
	readonly providerId: string;
	readonly transportFactory: PrivateCodexAppServerTransportFactory;
	readonly cwd: string;
	readonly roots: HostFilesystemRoots;
	readonly dynamicTools?: readonly PrivateCodexDynamicTool[];
	readonly approvalPolicy?: CodexApprovalPolicy;
	readonly approvalsReviewer?: CodexApprovalsReviewer;
	readonly sandbox?: CodexSandboxMode;
	readonly limits?: Partial<PrivateCodexAppServerLimits>;
	readonly now?: () => string;
}

export type PrivateCodexExternalAgentConnectorOptions = Omit<
	ExternalAgentConnectorRuntimeOptions,
	"capabilityProbe" | "driver"
> &
	PrivateCodexAppServerDriverOptions;

type CodexDriverErrorCode =
	| "external_event_invalid"
	| "external_frame_oversize"
	| "external_protocol_unsupported"
	| "external_resource_limit_exceeded";

export class PrivateCodexAppServerError extends Error {
	readonly code: CodexDriverErrorCode;

	constructor(code: CodexDriverErrorCode) {
		super(`Codex app-server driver failed: ${code}`);
		this.name = "PrivateCodexAppServerError";
		this.code = code;
	}
}

interface Deferred<T> {
	readonly promise: Promise<T>;
	readonly settled: () => boolean;
	readonly resolve: (value: T) => void;
	readonly reject: (error: unknown) => void;
}

interface RpcPending {
	readonly accept: (value: unknown) => void;
	readonly reject: (error: unknown) => void;
}

interface GatewayPending {
	readonly requestId: string | number;
	readonly toolName: string;
	readonly responseKind:
		| "command_approval"
		| "file_approval"
		| "permissions_approval"
		| "mcp_elicitation"
		| "request_user_input"
		| "dynamic_tool";
	readonly sideEffecting: boolean;
}

interface CodexExecutionAuthority {
	readonly providerId: string;
	readonly attemptId: string;
	readonly taskId: string;
	readonly dispatchId: string;
	readonly bindingId: string;
	readonly bindingEpochId: string;
	readonly operationId: string;
}

interface CodexOperation {
	handle: ExternalConnectorDriverHandle;
	readonly transport: PrivateCodexAppServerTransport;
	readonly writer: WritableStreamDefaultWriter<Uint8Array>;
	readonly events: BoundedEventQueue;
	readonly terminal: Deferred<ExternalConnectorTerminalEvidence>;
	readonly rpcPending: Map<string, RpcPending>;
	readonly gatewayPending: Map<string, GatewayPending>;
	readonly respondedServerRequests: Set<string>;
	readonly acceptedSideEffectingRequests: Set<string>;
	readonly authority?: CodexExecutionAuthority;
	readerTask?: Promise<void>;
	stderrTask?: Promise<void>;
	deadline?: ReturnType<typeof setTimeout>;
	threadId: string;
	turnId: string;
	requestSequence: number;
	eventSequence: number;
	pendingWriteBytes: number;
	sideEffectState: "none" | "unknown" | "side_effect_unknown";
	cancelRequested: boolean;
	turnStarted: boolean;
	startedEventEmitted: boolean;
	terminalSeen: boolean;
	closed: boolean;
	failure?: Error;
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
			const error = resourceLimitError();
			this.fail(error);
			throw error;
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

function hasExactKeys(value: Record<string, unknown>, keys: ReadonlySet<string>): boolean {
	return hasOnlyKeys(value, keys) && [...keys].every((key) => Object.hasOwn(value, key));
}

function isPositiveSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
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

function normalizeError(error: unknown): Error {
	return error instanceof ExternalConnectorSupervisorError || error instanceof PrivateCodexAppServerError
		? error
		: eventInvalidError();
}

function resolveLimits(value: Partial<PrivateCodexAppServerLimits> | undefined): PrivateCodexAppServerLimits {
	const limits = { ...PRIVATE_CODEX_APP_SERVER_LIMITS, ...value };
	if (Object.values(limits).some((limit) => !isPositiveSafeInteger(limit))) {
		throw new RangeError("Codex app-server limits must be positive safe integers");
	}
	return Object.freeze(limits);
}

function rpcIdKey(value: unknown): string | undefined {
	if (typeof value === "string" && value.length > 0) return `s:${value}`;
	if (typeof value === "number" && Number.isSafeInteger(value)) return `n:${value}`;
	return undefined;
}

function validateTransport(value: unknown): asserts value is PrivateCodexAppServerTransport {
	if (
		!isRecord(value) ||
		!(value.input instanceof ReadableStream) ||
		!(value.output instanceof WritableStream) ||
		typeof value.close !== "function" ||
		(value.stderr !== undefined && !(value.stderr instanceof ReadableStream)) ||
		!isRecord(value.identity) ||
		!hasExactKeys(value.identity, new Set(["cliVersion", "schemaSha256"])) ||
		typeof value.identity.cliVersion !== "string" ||
		typeof value.identity.schemaSha256 !== "string"
	) {
		throw new TypeError("Codex app-server transport is invalid");
	}
	if (
		value.identity.cliVersion !== PRIVATE_CODEX_APP_SERVER_IDENTITY.cliVersion ||
		value.identity.schemaSha256.toLowerCase() !== PRIVATE_CODEX_APP_SERVER_IDENTITY.schemaSha256
	) {
		throw new PrivateCodexAppServerError("external_protocol_unsupported");
	}
}

function validateCapability(providerId: string, capability: ConnectorCapabilitySnapshot): void {
	if (
		capability.providerId !== providerId ||
		capability.protocol.name !== "codex-app-server" ||
		capability.protocol.version !== PRIVATE_CODEX_APP_SERVER_IDENTITY.cliVersion ||
		capability.resume !== true ||
		capability.toolGateway !== true ||
		capability.artifacts ||
		capability.images ||
		(capability.modelAccess !== "agent_owned" && capability.modelAccess !== "none")
	) {
		throw new PrivateCodexAppServerError("external_protocol_unsupported");
	}
}

const CODEX_NAME = /^[a-zA-Z0-9_-]+$/;
const RESERVED_NAMESPACES = new Set([
	"functions",
	"multi_tool_use",
	"file_search",
	"web",
	"browser",
	"image_gen",
	"computer",
	"container",
	"terminal",
	"python",
	"python_user_visible",
	"api_tool",
	"tool_search",
	"submodel_delegator",
]);

function cloneJson(value: FoundationJsonValue): FoundationJsonValue {
	return JSON.parse(JSON.stringify(value)) as FoundationJsonValue;
}

function resolveTools(value: readonly PrivateCodexDynamicTool[] | undefined): readonly PrivateCodexDynamicTool[] {
	const seenCodex = new Set<string>();
	const seenGateway = new Set<string>();
	return Object.freeze(
		(value ?? []).map((tool) => {
			if (
				!isRecord(tool) ||
				!hasExactKeys(tool, new Set(["codexNamespace", "codexName", "description", "inputSchema", "gateway"])) ||
				(tool.codexNamespace !== null &&
					(typeof tool.codexNamespace !== "string" ||
						tool.codexNamespace.length > 64 ||
						!CODEX_NAME.test(tool.codexNamespace) ||
						RESERVED_NAMESPACES.has(tool.codexNamespace))) ||
				typeof tool.codexName !== "string" ||
				tool.codexName.length > 128 ||
				!CODEX_NAME.test(tool.codexName) ||
				typeof tool.description !== "string" ||
				Buffer.byteLength(tool.description) > 1024 ||
				!isRecord(tool.gateway) ||
				!hasExactKeys(tool.gateway, new Set(["namespace", "toolName"])) ||
				typeof tool.gateway.namespace !== "string" ||
				tool.gateway.namespace.length === 0 ||
				typeof tool.gateway.toolName !== "string" ||
				tool.gateway.toolName.length === 0
			) {
				throw new TypeError("Codex dynamic tool selection is invalid");
			}
			const codexKey = `${tool.codexNamespace ?? ""}\u0000${tool.codexName}`;
			const gatewayKey = `${tool.gateway.namespace}\u0000${tool.gateway.toolName}`;
			if (seenCodex.has(codexKey) || seenGateway.has(gatewayKey)) {
				throw new TypeError("Codex dynamic tool selection contains a duplicate route");
			}
			seenCodex.add(codexKey);
			seenGateway.add(gatewayKey);
			return Object.freeze({
				codexNamespace: tool.codexNamespace,
				codexName: tool.codexName,
				description: tool.description,
				inputSchema: cloneJson(tool.inputSchema),
				gateway: Object.freeze({ ...tool.gateway }),
			});
		}),
	);
}

function dynamicToolParams(tools: readonly PrivateCodexDynamicTool[]): FoundationJsonValue[] {
	const topLevel = tools
		.filter((tool) => tool.codexNamespace === null)
		.map((tool) => ({
			type: "function",
			name: tool.codexName,
			description: tool.description,
			inputSchema: cloneJson(tool.inputSchema),
		}));
	const namespaces = new Map<string, PrivateCodexDynamicTool[]>();
	for (const tool of tools) {
		if (tool.codexNamespace === null) continue;
		const values = namespaces.get(tool.codexNamespace) ?? [];
		values.push(tool);
		namespaces.set(tool.codexNamespace, values);
	}
	return [
		...topLevel,
		...[...namespaces.entries()].map(([name, values]) => ({
			type: "namespace",
			name,
			description: `Host-selected ${name} tools`,
			tools: values.map((tool) => ({
				name: tool.codexName,
				description: tool.description,
				inputSchema: cloneJson(tool.inputSchema),
			})),
		})),
	];
}

function authorityFor(request: ExternalConnectorDriverSpawnRequest): CodexExecutionAuthority {
	const bindingEpochId = request.attempt.bindingEpochIds[0];
	const operationId = request.correlation.operationId;
	if (
		bindingEpochId === undefined ||
		request.correlation.runId === undefined ||
		operationId === undefined ||
		operationId !== request.correlation.runId ||
		request.attempt.dispatchId === undefined
	) {
		throw new TypeError("Codex execution requires canonical Tool Gateway correlation");
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

async function canonicalWorkspace(cwd: string, roots: HostFilesystemRoots): Promise<string> {
	if (!path.isAbsolute(cwd)) throw new TypeError("Codex workspace cwd must be absolute");
	const resolved = await resolveHostPathForPolicy({ cwd, targetPath: cwd, roots, access: "read" });
	assertPathInsideWorkspace(resolved);
	return resolved.realPath;
}

async function canonicalApprovalPath(
	candidate: unknown,
	access: "read" | "write",
	cwd: string,
	roots: HostFilesystemRoots,
): Promise<string | null | undefined> {
	if (candidate === null || candidate === undefined) return candidate;
	if (typeof candidate !== "string" || !path.isAbsolute(candidate)) throw eventInvalidError();
	const resolved = await resolveHostPathForPolicy({ cwd, targetPath: candidate, roots, access });
	assertPathInsideWorkspace(resolved);
	return resolved.realPath;
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

function operationEvent(operation: CodexOperation, event: ExternalConnectorDriverEvent): void {
	operation.events.push(event as unknown as FoundationJsonValue);
}

function progress(operation: CodexOperation, phase: string): void {
	operation.eventSequence += 1;
	operationEvent(operation, {
		schemaVersion: 1,
		type: "progress",
		externalSessionId: operation.threadId,
		...(operation.turnId.length === 0 ? {} : { externalTurnId: operation.turnId }),
		sequence: operation.eventSequence,
		phase,
		producedAt: new Date().toISOString(),
	});
}

function toolCallId(operation: CodexOperation, candidate: string): string {
	if (isExternalConnectorMappingIdentifier(candidate)) return candidate;
	return `codex_tool_${createHash("sha256").update(`${operation.handle.operationNonce}:${candidate}`).digest("hex")}`;
}

function gatewayRequest(
	operation: CodexOperation,
	callId: string,
	namespace: string,
	toolName: string,
	argumentsValue: FoundationJsonValue,
): ToolGatewayRequest {
	const authority = operation.authority;
	if (authority === undefined) throw eventInvalidError();
	return Object.freeze({
		schemaVersion: 1,
		toolCallId: callId,
		toolName,
		namespace,
		originalArguments: argumentsValue,
		idempotencyKey: `${operation.handle.operationNonce}:${callId}`,
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

function updateSideEffects(operation: CodexOperation, result: ToolExecutionResult): void {
	if (result.sideEffectState === "side_effect_unknown") operation.sideEffectState = "side_effect_unknown";
	else if (result.sideEffectState === "unknown" && operation.sideEffectState === "none") {
		operation.sideEffectState = "unknown";
	}
}

function terminalEvidence(
	operation: CodexOperation,
	status: "completed" | "interrupted" | "failed",
	now: () => string,
): ExternalConnectorTerminalEvidence {
	if (status === "interrupted") {
		if (operation.sideEffectState !== "none" || operation.acceptedSideEffectingRequests.size > 0) {
			operation.sideEffectState = "side_effect_unknown";
			return {
				externalSessionId: operation.threadId,
				externalTurnId: operation.turnId,
				operationNonce: operation.handle.operationNonce,
				status: "failed",
				artifacts: [],
				error: {
					code: "side_effect_unknown",
					message: "External side effect could not be confirmed.",
					category: "side_effect_unknown",
					retryable: false,
				},
				sideEffectState: "side_effect_unknown",
				producedAt: now(),
			};
		}
		return {
			externalSessionId: operation.threadId,
			externalTurnId: operation.turnId,
			operationNonce: operation.handle.operationNonce,
			status: "cancelled",
			artifacts: [],
			sideEffectState: operation.sideEffectState,
			producedAt: now(),
		};
	}
	if (status === "failed") {
		return {
			externalSessionId: operation.threadId,
			externalTurnId: operation.turnId,
			operationNonce: operation.handle.operationNonce,
			status: "failed",
			artifacts: [],
			error: { code: "agent_run_failed", message: "Run failed.", category: "unknown", retryable: false },
			sideEffectState: operation.sideEffectState,
			producedAt: now(),
		};
	}
	return {
		externalSessionId: operation.threadId,
		externalTurnId: operation.turnId,
		operationNonce: operation.handle.operationNonce,
		status: "succeeded",
		artifacts: [],
		sideEffectState: operation.sideEffectState,
		producedAt: now(),
	};
}

function suspendedEvidence(operation: CodexOperation, now: () => string): ExternalConnectorTerminalEvidence {
	return {
		externalSessionId: operation.threadId,
		externalTurnId: operation.turnId,
		operationNonce: operation.handle.operationNonce,
		status: "suspended",
		artifacts: [],
		sideEffectState: "unknown",
		producedAt: now(),
	};
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
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

const INITIALIZE_KEYS = new Set(["userAgent", "codexHome", "platformFamily", "platformOs"]);
const THREAD_RESPONSE_KEYS = new Set([
	"thread",
	"model",
	"modelProvider",
	"serviceTier",
	"cwd",
	"runtimeWorkspaceRoots",
	"instructionSources",
	"approvalPolicy",
	"approvalsReviewer",
	"sandbox",
	"activePermissionProfile",
	"reasoningEffort",
	"multiAgentMode",
]);
const RESUME_RESPONSE_KEYS = new Set([
	...THREAD_RESPONSE_KEYS,
	"initialTurnsPage",
	"turnsBackwardsCursor",
	"itemsBackwardsCursor",
]);
const THREAD_KEYS = new Set([
	"id",
	"extra",
	"sessionId",
	"forkedFromId",
	"parentThreadId",
	"preview",
	"ephemeral",
	"section",
	"sectionEnteredAt",
	"projectId",
	"historyMode",
	"modelProvider",
	"createdAt",
	"updatedAt",
	"recencyAt",
	"status",
	"path",
	"cwd",
	"cliVersion",
	"source",
	"canAcceptDirectInput",
	"threadSource",
	"agentNickname",
	"agentRole",
	"gitInfo",
	"name",
	"turns",
]);
const TURN_KEYS = new Set(["id", "items", "itemsView", "status", "error", "startedAt", "completedAt", "durationMs"]);

function isNullableString(value: unknown): boolean {
	return value === null || typeof value === "string";
}

function isNullableSafeInteger(value: unknown): boolean {
	return value === null || (typeof value === "number" && Number.isSafeInteger(value));
}

function hasOptionalNullableString(value: Record<string, unknown>, key: string): boolean {
	return !Object.hasOwn(value, key) || isNullableString(value[key]);
}

function validateThreadStatus(value: unknown): void {
	if (!isRecord(value) || typeof value.type !== "string") throw eventInvalidError();
	if (new Set(["notLoaded", "idle", "systemError"]).has(value.type)) {
		if (!hasExactKeys(value, new Set(["type"]))) throw eventInvalidError();
		return;
	}
	if (
		value.type !== "active" ||
		!hasExactKeys(value, new Set(["type", "activeFlags"])) ||
		!Array.isArray(value.activeFlags) ||
		!value.activeFlags.every(
			(flag) => typeof flag === "string" && new Set(["waitingOnApproval", "waitingOnUserInput"]).has(flag),
		)
	) {
		throw eventInvalidError();
	}
}

function validateThreadSection(value: unknown): void {
	if (value === null) return;
	if (
		!isRecord(value) ||
		!hasOnlyKeys(value, new Set(["id", "name", "appearance"])) ||
		!Object.hasOwn(value, "id") ||
		!Object.hasOwn(value, "name") ||
		typeof value.id !== "string" ||
		typeof value.name !== "string"
	) {
		throw eventInvalidError();
	}
	if (!Object.hasOwn(value, "appearance") || value.appearance === null) return;
	if (
		!isRecord(value.appearance) ||
		!hasOnlyKeys(value.appearance, new Set(["color", "icon"])) ||
		!hasOptionalNullableString(value.appearance, "color") ||
		!hasOptionalNullableString(value.appearance, "icon")
	) {
		throw eventInvalidError();
	}
}

function validateSubAgentSource(value: unknown): void {
	if (typeof value === "string") {
		if (!new Set(["review", "compact", "memory_consolidation"]).has(value)) throw eventInvalidError();
		return;
	}
	if (!isRecord(value)) throw eventInvalidError();
	if (hasExactKeys(value, new Set(["other"]))) {
		if (typeof value.other !== "string") throw eventInvalidError();
		return;
	}
	if (!hasExactKeys(value, new Set(["thread_spawn"])) || !isRecord(value.thread_spawn)) {
		throw eventInvalidError();
	}
	const spawn = value.thread_spawn;
	if (
		!hasOnlyKeys(spawn, new Set(["agent_nickname", "agent_path", "agent_role", "depth", "parent_thread_id"])) ||
		!Object.hasOwn(spawn, "depth") ||
		!Object.hasOwn(spawn, "parent_thread_id") ||
		typeof spawn.depth !== "number" ||
		!Number.isSafeInteger(spawn.depth) ||
		spawn.depth < -2_147_483_648 ||
		spawn.depth > 2_147_483_647 ||
		typeof spawn.parent_thread_id !== "string" ||
		!hasOptionalNullableString(spawn, "agent_nickname") ||
		!hasOptionalNullableString(spawn, "agent_path") ||
		!hasOptionalNullableString(spawn, "agent_role")
	) {
		throw eventInvalidError();
	}
}

function validateSessionSource(value: unknown): void {
	if (typeof value === "string") {
		if (!new Set(["cli", "vscode", "exec", "appServer", "unknown"]).has(value)) throw eventInvalidError();
		return;
	}
	if (!isRecord(value)) throw eventInvalidError();
	if (hasExactKeys(value, new Set(["custom"]))) {
		if (typeof value.custom !== "string") throw eventInvalidError();
		return;
	}
	if (!hasExactKeys(value, new Set(["subAgent"]))) throw eventInvalidError();
	validateSubAgentSource(value.subAgent);
}

function validateGitInfo(value: unknown): void {
	if (value === null) return;
	if (
		!isRecord(value) ||
		!hasOnlyKeys(value, new Set(["sha", "branch", "originUrl"])) ||
		!hasOptionalNullableString(value, "sha") ||
		!hasOptionalNullableString(value, "branch") ||
		!hasOptionalNullableString(value, "originUrl")
	) {
		throw eventInvalidError();
	}
}

function validateSandboxPolicy(value: unknown): void {
	if (!isRecord(value) || typeof value.type !== "string") throw eventInvalidError();
	if (value.type === "dangerFullAccess") {
		if (!hasExactKeys(value, new Set(["type"]))) throw eventInvalidError();
		return;
	}
	if (value.type === "readOnly") {
		if (
			!hasOnlyKeys(value, new Set(["type", "networkAccess"])) ||
			(Object.hasOwn(value, "networkAccess") && typeof value.networkAccess !== "boolean")
		) {
			throw eventInvalidError();
		}
		return;
	}
	if (value.type === "externalSandbox") {
		if (
			!hasOnlyKeys(value, new Set(["type", "networkAccess"])) ||
			(Object.hasOwn(value, "networkAccess") &&
				(typeof value.networkAccess !== "string" ||
					!new Set(["restricted", "enabled"]).has(value.networkAccess)))
		) {
			throw eventInvalidError();
		}
		return;
	}
	if (
		value.type !== "workspaceWrite" ||
		!hasOnlyKeys(
			value,
			new Set(["type", "writableRoots", "networkAccess", "excludeTmpdirEnvVar", "excludeSlashTmp"]),
		) ||
		(Object.hasOwn(value, "writableRoots") &&
			(!Array.isArray(value.writableRoots) || !value.writableRoots.every((root) => typeof root === "string"))) ||
		(Object.hasOwn(value, "networkAccess") && typeof value.networkAccess !== "boolean") ||
		(Object.hasOwn(value, "excludeTmpdirEnvVar") && typeof value.excludeTmpdirEnvVar !== "boolean") ||
		(Object.hasOwn(value, "excludeSlashTmp") && typeof value.excludeSlashTmp !== "boolean")
	) {
		throw eventInvalidError();
	}
}

const CODEX_ERROR_INFO_VALUES = new Set([
	"contextWindowExceeded",
	"sessionBudgetExceeded",
	"usageLimitExceeded",
	"serverOverloaded",
	"cyberPolicy",
	"misalignmentPolicyViolation",
	"internalServerError",
	"unauthorized",
	"badRequest",
	"threadRollbackFailed",
	"sandboxError",
	"other",
]);

function validateCodexErrorInfo(value: unknown): void {
	if (typeof value === "string") {
		if (!CODEX_ERROR_INFO_VALUES.has(value)) throw eventInvalidError();
		return;
	}
	if (!isRecord(value) || Reflect.ownKeys(value).length !== 1) throw eventInvalidError();
	const key = Object.keys(value)[0];
	if (key === undefined) throw eventInvalidError();
	const details = value[key];
	if (key === "activeTurnNotSteerable") {
		if (
			!isRecord(details) ||
			!hasExactKeys(details, new Set(["turnKind"])) ||
			typeof details.turnKind !== "string" ||
			!new Set(["review", "compact"]).has(details.turnKind)
		) {
			throw eventInvalidError();
		}
		return;
	}
	if (
		!new Set([
			"httpConnectionFailed",
			"responseStreamConnectionFailed",
			"responseStreamDisconnected",
			"responseTooManyFailedAttempts",
		]).has(key) ||
		!isRecord(details) ||
		!hasOnlyKeys(details, new Set(["httpStatusCode"]))
	) {
		throw eventInvalidError();
	}
	if (Object.hasOwn(details, "httpStatusCode")) {
		const status = details.httpStatusCode;
		if (
			status !== null &&
			(typeof status !== "number" || !Number.isSafeInteger(status) || status < 0 || status > 65_535)
		) {
			throw eventInvalidError();
		}
	}
}

function validateTurnError(value: unknown): void {
	if (
		!isRecord(value) ||
		!hasOnlyKeys(value, new Set(["message", "codexErrorInfo", "additionalDetails"])) ||
		!Object.hasOwn(value, "message") ||
		typeof value.message !== "string" ||
		!hasOptionalNullableString(value, "additionalDetails")
	) {
		throw eventInvalidError();
	}
	if (Object.hasOwn(value, "codexErrorInfo") && value.codexErrorInfo !== null) {
		validateCodexErrorInfo(value.codexErrorInfo);
	}
}

function validateInitialize(value: unknown): void {
	if (
		!isRecord(value) ||
		!hasExactKeys(value, INITIALIZE_KEYS) ||
		typeof value.userAgent !== "string" ||
		typeof value.codexHome !== "string" ||
		typeof value.platformFamily !== "string" ||
		typeof value.platformOs !== "string"
	) {
		throw eventInvalidError();
	}
}

function validateThread(value: unknown, expectedId?: string): string {
	if (
		!isRecord(value) ||
		!hasExactKeys(value, THREAD_KEYS) ||
		!isExternalConnectorMappingIdentifier(value.id) ||
		(expectedId !== undefined && value.id !== expectedId) ||
		!isExternalConnectorMappingIdentifier(value.sessionId) ||
		!isNullableString(value.forkedFromId) ||
		!isNullableString(value.parentThreadId) ||
		typeof value.preview !== "string" ||
		value.ephemeral !== false ||
		!isNullableSafeInteger(value.sectionEnteredAt) ||
		!isNullableString(value.projectId) ||
		(typeof value.historyMode !== "string" || !new Set(["legacy", "paginated"]).has(value.historyMode)) ||
		typeof value.modelProvider !== "string" ||
		typeof value.createdAt !== "number" ||
		!Number.isSafeInteger(value.createdAt) ||
		typeof value.updatedAt !== "number" ||
		!Number.isSafeInteger(value.updatedAt) ||
		!isNullableSafeInteger(value.recencyAt) ||
		!isNullableString(value.path) ||
		typeof value.cwd !== "string" ||
		value.cliVersion !== PRIVATE_CODEX_APP_SERVER_IDENTITY.cliVersion ||
		(value.canAcceptDirectInput !== null && typeof value.canAcceptDirectInput !== "boolean") ||
		!isNullableString(value.threadSource) ||
		!isNullableString(value.agentNickname) ||
		!isNullableString(value.agentRole) ||
		!isNullableString(value.name) ||
		!Array.isArray(value.turns) ||
		value.turns.length !== 0
	) {
		throw eventInvalidError();
	}
	if (value.extra !== null && !isRecord(value.extra)) throw eventInvalidError();
	validateThreadSection(value.section);
	validateThreadStatus(value.status);
	validateSessionSource(value.source);
	validateGitInfo(value.gitInfo);
	return value.id;
}

function validateThreadResponse(value: unknown, resumeId?: string): string {
	const keys = resumeId === undefined ? THREAD_RESPONSE_KEYS : RESUME_RESPONSE_KEYS;
	if (
		!isRecord(value) ||
		!hasExactKeys(value, keys) ||
		typeof value.model !== "string" ||
		typeof value.modelProvider !== "string" ||
		!isNullableString(value.serviceTier) ||
		typeof value.cwd !== "string" ||
		!Array.isArray(value.runtimeWorkspaceRoots) ||
		!value.runtimeWorkspaceRoots.every((root) => typeof root === "string") ||
		!Array.isArray(value.instructionSources) ||
		!value.instructionSources.every((source) => typeof source === "string") ||
		typeof value.approvalPolicy !== "string" ||
		!new Set(["untrusted", "on-request", "never"]).has(value.approvalPolicy) ||
		typeof value.approvalsReviewer !== "string" ||
		!new Set(["user", "auto_review", "guardian_subagent"]).has(value.approvalsReviewer) ||
		(value.reasoningEffort !== null &&
			(typeof value.reasoningEffort !== "string" || value.reasoningEffort.length === 0))
	) {
		throw eventInvalidError();
	}
	validateSandboxPolicy(value.sandbox);
	if (value.activePermissionProfile !== null) {
		if (
			!isRecord(value.activePermissionProfile) ||
			!hasOnlyKeys(value.activePermissionProfile, new Set(["id", "extends"])) ||
			!Object.hasOwn(value.activePermissionProfile, "id") ||
			typeof value.activePermissionProfile.id !== "string" ||
			!hasOptionalNullableString(value.activePermissionProfile, "extends")
		) {
			throw eventInvalidError();
		}
	}
	if (typeof value.multiAgentMode === "string") {
		if (!new Set(["explicitRequestOnly", "proactive"]).has(value.multiAgentMode)) throw eventInvalidError();
	} else if (
		!isRecord(value.multiAgentMode) ||
		!hasExactKeys(value.multiAgentMode, new Set(["custom"])) ||
		typeof value.multiAgentMode.custom !== "string"
	) {
		throw eventInvalidError();
	}
	if (resumeId !== undefined) {
		if (!isNullableString(value.turnsBackwardsCursor) || !isNullableString(value.itemsBackwardsCursor)) {
			throw eventInvalidError();
		}
		if (value.initialTurnsPage !== null) {
			if (
				!isRecord(value.initialTurnsPage) ||
				!hasOnlyKeys(value.initialTurnsPage, new Set(["data", "nextCursor", "backwardsCursor"])) ||
				!Object.hasOwn(value.initialTurnsPage, "data") ||
				!Array.isArray(value.initialTurnsPage.data) ||
				!hasOptionalNullableString(value.initialTurnsPage, "nextCursor") ||
				!hasOptionalNullableString(value.initialTurnsPage, "backwardsCursor")
			) {
				throw eventInvalidError();
			}
			for (const turn of value.initialTurnsPage.data) validateTurn(turn);
		}
	}
	return validateThread(value.thread, resumeId);
}

function validateTurn(value: unknown, expectedId?: string): { readonly id: string; readonly status: string } {
	if (
		!isRecord(value) ||
		!hasExactKeys(value, TURN_KEYS) ||
		!isExternalConnectorMappingIdentifier(value.id) ||
		(expectedId !== undefined && value.id !== expectedId) ||
		!Array.isArray(value.items) ||
		value.items.length !== 0 ||
		typeof value.itemsView !== "string" ||
		!new Set(["notLoaded", "summary", "full"]).has(value.itemsView) ||
		typeof value.status !== "string" ||
		!new Set(["completed", "interrupted", "failed", "inProgress"]).has(value.status) ||
		!isNullableSafeInteger(value.startedAt) ||
		!isNullableSafeInteger(value.completedAt) ||
		!isNullableSafeInteger(value.durationMs)
	) {
		throw eventInvalidError();
	}
	if (value.status === "failed") {
		validateTurnError(value.error);
	} else if (value.error !== null) {
		throw eventInvalidError();
	}
	return { id: value.id, status: value.status as string };
}

function validateTurnStartResponse(value: unknown): string {
	if (!isRecord(value) || !hasExactKeys(value, new Set(["turn"]))) throw eventInvalidError();
	const turn = validateTurn(value.turn);
	if (turn.status !== "inProgress") throw eventInvalidError();
	return turn.id;
}

function jsonResult(value: ToolExecutionResult): FoundationJsonValue {
	if (value.result === undefined) return null;
	return cloneJson(value.result);
}

function exactServerResponse(
	kind: "permissions_approval" | "mcp_elicitation" | "request_user_input",
	value: unknown,
): FoundationJsonValue {
	if (!isRecord(value)) throw eventInvalidError();
	if (kind === "permissions_approval") {
		if (
			!hasOnlyKeys(value, new Set(["permissions", "scope", "strictAutoReview"])) ||
			!Object.hasOwn(value, "permissions") ||
			!Object.hasOwn(value, "scope") ||
			!isRecord(value.permissions) ||
			(value.scope !== "turn" && value.scope !== "session") ||
			(value.strictAutoReview !== undefined && typeof value.strictAutoReview !== "boolean")
		) {
			throw eventInvalidError();
		}
	} else if (kind === "mcp_elicitation") {
		if (
			!hasExactKeys(value, new Set(["action", "content", "_meta"])) ||
			(value.action !== "accept" && value.action !== "decline" && value.action !== "cancel") ||
			(value.action !== "accept" && value.content !== null)
		) {
			throw eventInvalidError();
		}
	} else {
		if (!hasExactKeys(value, new Set(["answers"])) || !isRecord(value.answers)) throw eventInvalidError();
		for (const answer of Object.values(value.answers)) {
			if (
				!isRecord(answer) ||
				!hasExactKeys(answer, new Set(["answers"])) ||
				!Array.isArray(answer.answers) ||
				answer.answers.some((item) => typeof item !== "string")
			) {
				throw eventInvalidError();
			}
		}
	}
	return cloneJson(value as FoundationJsonValue);
}

/** @internal Package-private frozen Codex app-server protocol driver. */
export class PrivateCodexAppServerDriver implements ExternalConnectorVendorDriver {
	readonly #providerId: string;
	readonly #transportFactory: PrivateCodexAppServerTransportFactory;
	readonly #cwd: string;
	readonly #roots: HostFilesystemRoots;
	readonly #tools: readonly PrivateCodexDynamicTool[];
	readonly #approvalPolicy: CodexApprovalPolicy;
	readonly #approvalsReviewer: CodexApprovalsReviewer;
	readonly #sandbox: CodexSandboxMode;
	readonly #limits: PrivateCodexAppServerLimits;
	readonly #now: () => string;
	readonly #operations = new Map<string, CodexOperation>();
	readonly #allOperations = new Set<CodexOperation>();

	constructor(options: PrivateCodexAppServerDriverOptions) {
		if (!isExternalConnectorMappingIdentifier(options.providerId))
			throw new TypeError("Codex provider id is invalid");
		if (typeof options.transportFactory !== "function") throw new TypeError("Codex transport factory is required");
		this.#providerId = options.providerId;
		this.#transportFactory = options.transportFactory;
		this.#cwd = options.cwd;
		this.#roots = options.roots;
		this.#tools = resolveTools(options.dynamicTools);
		this.#approvalPolicy = options.approvalPolicy ?? "on-request";
		this.#approvalsReviewer = options.approvalsReviewer ?? "user";
		this.#sandbox = options.sandbox ?? "workspace-write";
		this.#limits = resolveLimits(options.limits);
		this.#now = options.now ?? (() => new Date().toISOString());
	}

	async spawn(request: ExternalConnectorDriverSpawnRequest): Promise<ExternalConnectorDriverHandle> {
		validateCapability(this.#providerId, request.capability);
		if (
			request.input.artifacts.length > 0 ||
			request.modelProjection !== undefined ||
			request.modelTranslation !== undefined
		) {
			throw new PrivateCodexAppServerError("external_protocol_unsupported");
		}
		const operation = await this.#openOperation({
			mode: "start",
			supervisorRef: request.supervisorRef,
			operationNonce: request.operationNonce,
			authority: authorityFor(request),
			signal: request.signal,
		});
		try {
			await this.#initialize(operation, request.signal);
			const cwd = await canonicalWorkspace(this.#cwd, this.#roots);
			const threadId = validateThreadResponse(
				await this.#request(
					operation,
					"thread/start",
					{
						cwd,
						approvalPolicy: this.#approvalPolicy,
						approvalsReviewer: this.#approvalsReviewer,
						sandbox: this.#sandbox,
						dynamicTools: dynamicToolParams(this.#tools),
					},
					request.signal,
				),
			);
			operation.threadId = threadId;
			operation.handle = Object.freeze({ ...operation.handle, externalSessionId: threadId });
			this.#operations.set(threadId, operation);
			const turnId = validateTurnStartResponse(
				await this.#request(
					operation,
					"turn/start",
					{
						threadId,
						input: [{ type: "text", text: request.input.text, text_elements: [] }],
					},
					request.signal,
				),
			);
			if (operation.turnId.length > 0 && operation.turnId !== turnId) throw eventInvalidError();
			operation.turnId = turnId;
			operation.handle = Object.freeze({ ...operation.handle, externalTurnId: turnId });
			this.#emitStarted(operation);
			return operation.handle;
		} catch (error) {
			await this.#closeOperation(operation, error);
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
		if (mapping.externalTurnId === undefined) throw eventInvalidError();
		const operation = await this.#openOperation({
			mode: "resume",
			supervisorRef: mapping.supervisor.ref,
			operationNonce: mapping.supervisor.nonce,
			externalSessionId: mapping.externalSessionId,
			externalTurnId: mapping.externalTurnId,
			signal: options?.signal,
		});
		try {
			await this.#initialize(operation, options?.signal);
			validateThreadResponse(
				await this.#request(
					operation,
					"thread/resume",
					{
						threadId: mapping.externalSessionId,
						cwd: await canonicalWorkspace(this.#cwd, this.#roots),
						approvalPolicy: this.#approvalPolicy,
						approvalsReviewer: this.#approvalsReviewer,
						sandbox: this.#sandbox,
						excludeTurns: true,
					},
					options?.signal,
				),
				mapping.externalSessionId,
			);
			operationEvent(operation, {
				schemaVersion: 1,
				type: "started",
				externalSessionId: operation.threadId,
				externalTurnId: operation.turnId,
				producedAt: this.#now(),
			});
			operation.terminalSeen = true;
			if (operation.deadline !== undefined) {
				clearTimeout(operation.deadline);
				operation.deadline = undefined;
			}
			operation.terminal.resolve(suspendedEvidence(operation, this.#now));
			operation.events.close();
			return operation.handle;
		} catch (error) {
			await this.#closeOperation(operation, error);
			throw error;
		}
	}

	async lookup(mapping: CanonicalExternalConnectorMapping): Promise<ExternalConnectorDriverLookup> {
		const operation = this.#operations.get(mapping.externalSessionId);
		if (
			operation === undefined ||
			!mappingMatchesHandle(mapping, operation.handle) ||
			operation.failure !== undefined
		) {
			return { status: "ambiguous" };
		}
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
		if (operation.failure !== undefined) throw operation.failure;
		const evidence = await withTimeout(operation.terminal.promise, this.#limits.operationTimeoutMs, options?.signal);
		if (operation.failure !== undefined) throw operation.failure;
		return evidence;
	}

	async write(handle: ExternalConnectorDriverHandle, request: ExternalConnectorDriverWriteRequest): Promise<void> {
		const operation = this.#requireOperation(handle);
		if (request.operationNonce !== operation.handle.operationNonce) throw eventInvalidError();
		const pending = operation.gatewayPending.get(request.result.toolCallId);
		if (pending === undefined || pending.toolName !== request.result.toolName) throw eventInvalidError();
		operation.gatewayPending.delete(request.result.toolCallId);
		updateSideEffects(operation, request.result);
		await this.#respondToServer(operation, pending, request.result);
	}

	async heartbeat(handle: ExternalConnectorDriverHandle): Promise<void> {
		const operation = this.#requireOperation(handle);
		if (operation.failure !== undefined || operation.closed) throw eventInvalidError();
	}

	async cancel(
		handle: ExternalConnectorDriverHandle,
		options?: { readonly signal?: AbortSignal },
	): Promise<ExternalConnectorTerminalEvidence | undefined> {
		const operation = this.#requireOperation(handle);
		operation.cancelRequested = true;
		if (
			operation.acceptedSideEffectingRequests.size > 0 ||
			[...operation.gatewayPending.values()].some(
				(pending) => pending.responseKind === "dynamic_tool" && pending.sideEffecting,
			)
		) {
			operation.sideEffectState = "side_effect_unknown";
		}
		try {
			const interrupted = await this.#request(
				operation,
				"turn/interrupt",
				{
					threadId: operation.threadId,
					turnId: operation.turnId,
				},
				options?.signal,
			);
			if (!isRecord(interrupted) || !hasExactKeys(interrupted, new Set())) throw eventInvalidError();
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

	async #initialize(operation: CodexOperation, signal?: AbortSignal): Promise<void> {
		validateInitialize(
			await this.#request(
				operation,
				"initialize",
				{
					clientInfo: { name: "aos_agent", title: "AOS Agent", version: "1" },
					capabilities: {
						experimentalApi: true,
						requestAttestation: false,
						mcpServerOpenaiFormElicitation: false,
						optOutNotificationMethods: [
							"thread/started",
							"thread/status/changed",
							"thread/tokenUsage/updated",
							"item/started",
							"item/completed",
							"item/agentMessage/delta",
							"item/reasoning/summaryTextDelta",
							"item/reasoning/summaryPartAdded",
							"item/reasoning/textDelta",
							"item/commandExecution/outputDelta",
							"item/fileChange/patchUpdated",
						],
					},
				},
				signal,
			),
		);
		await this.#send(operation, { method: "initialized" });
	}

	async #openOperation(input: {
		readonly mode: "start" | "resume";
		readonly supervisorRef: string;
		readonly operationNonce: string;
		readonly externalSessionId?: string;
		readonly externalTurnId?: string;
		readonly authority?: CodexExecutionAuthority;
		readonly signal?: AbortSignal;
	}): Promise<CodexOperation> {
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
		try {
			validateTransport(transport);
		} catch (error) {
			await Promise.resolve(transport.close(error)).catch(() => undefined);
			throw error;
		}
		const operation: CodexOperation = {
			handle: Object.freeze({
				externalSessionId: input.externalSessionId ?? "codex_thread_pending",
				...(input.externalTurnId === undefined ? {} : { externalTurnId: input.externalTurnId }),
				supervisorRef: input.supervisorRef,
				operationNonce: input.operationNonce,
			}),
			transport,
			writer: transport.output.getWriter(),
			events: new BoundedEventQueue(this.#limits.maxEvents),
			terminal: deferred<ExternalConnectorTerminalEvidence>(),
			rpcPending: new Map(),
			gatewayPending: new Map(),
			respondedServerRequests: new Set(),
			acceptedSideEffectingRequests: new Set(),
			...(input.authority === undefined ? {} : { authority: input.authority }),
			threadId: input.externalSessionId ?? "",
			turnId: input.externalTurnId ?? "",
			requestSequence: 0,
			eventSequence: 0,
			pendingWriteBytes: 0,
			sideEffectState: "none",
			cancelRequested: false,
			turnStarted: false,
			startedEventEmitted: false,
			terminalSeen: false,
			closed: false,
		};
		this.#allOperations.add(operation);
		if (input.externalSessionId !== undefined) this.#operations.set(input.externalSessionId, operation);
		operation.readerTask = this.#readLoop(operation);
		if (transport.stderr !== undefined) operation.stderrTask = this.#drainStderr(operation, transport.stderr);
		operation.deadline = setTimeout(
			() => this.#fail(operation, resourceLimitError()),
			this.#limits.operationTimeoutMs,
		);
		operation.deadline.unref?.();
		return operation;
	}

	async #request(
		operation: CodexOperation,
		method: string,
		params: FoundationJsonValue,
		signal?: AbortSignal,
	): Promise<unknown> {
		if (
			operation.rpcPending.size + operation.gatewayPending.size + operation.respondedServerRequests.size >=
			this.#limits.maxPendingRequests
		) {
			throw resourceLimitError();
		}
		operation.requestSequence += 1;
		const id = operation.requestSequence;
		const key = rpcIdKey(id)!;
		const pending = deferred<unknown>();
		operation.rpcPending.set(key, { accept: pending.resolve, reject: pending.reject });
		try {
			await this.#send(operation, { method, id, params });
			return await withTimeout(pending.promise, this.#limits.requestTimeoutMs, signal);
		} finally {
			operation.rpcPending.delete(key);
		}
	}

	async #send(operation: CodexOperation, value: FoundationJsonValue): Promise<void> {
		const bytes = new TextEncoder().encode(`${JSON.stringify(value)}\n`);
		if (bytes.byteLength > this.#limits.maxFrameBytes) throw frameOversizeError();
		operation.pendingWriteBytes += bytes.byteLength;
		if (operation.pendingWriteBytes > this.#limits.maxPendingWriteBytes) {
			operation.pendingWriteBytes -= bytes.byteLength;
			throw resourceLimitError();
		}
		try {
			await withTimeout(operation.writer.write(bytes), this.#limits.requestTimeoutMs);
		} finally {
			operation.pendingWriteBytes -= bytes.byteLength;
		}
	}

	async #readLoop(operation: CodexOperation): Promise<void> {
		const reader = operation.transport.input.getReader();
		let totalBytes = 0;
		let buffered = new Uint8Array();
		try {
			for (;;) {
				const next = await reader.read();
				if (next.done) {
					if (buffered.byteLength !== 0) throw eventInvalidError();
					if (!operation.terminalSeen && !operation.closed) throw eventInvalidError();
					return;
				}
				totalBytes += next.value.byteLength;
				if (totalBytes > this.#limits.maxTotalBytes) throw resourceLimitError();
				const combined = new Uint8Array(buffered.byteLength + next.value.byteLength);
				combined.set(buffered);
				combined.set(next.value, buffered.byteLength);
				let start = 0;
				for (let index = 0; index < combined.byteLength; index += 1) {
					if (combined[index] !== 0x0a) continue;
					const frame = combined.subarray(start, index);
					if (frame.byteLength === 0 || frame.byteLength > this.#limits.maxFrameBytes) throw frameOversizeError();
					let parsed: unknown;
					try {
						parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(frame));
					} catch {
						throw eventInvalidError();
					}
					await this.#acceptMessage(operation, parsed);
					start = index + 1;
				}
				buffered = combined.slice(start);
				if (buffered.byteLength > this.#limits.maxFrameBytes) throw frameOversizeError();
			}
		} catch (error) {
			this.#fail(operation, error);
		} finally {
			reader.releaseLock();
		}
	}

	async #acceptMessage(operation: CodexOperation, value: unknown): Promise<void> {
		if (!isRecord(value) || Object.hasOwn(value, "jsonrpc")) throw eventInvalidError();
		if (typeof value.method === "string") {
			if (Object.hasOwn(value, "id")) {
				if (!hasExactKeys(value, new Set(["method", "id", "params"]))) throw eventInvalidError();
				await this.#acceptServerRequest(operation, value.method, value.id, value.params);
				return;
			}
			if (!hasExactKeys(value, new Set(["method", "params"]))) throw eventInvalidError();
			this.#acceptNotification(operation, value.method, value.params);
			return;
		}
		if (!Object.hasOwn(value, "id") || !hasOnlyKeys(value, new Set(["id", "result", "error"]))) {
			throw eventInvalidError();
		}
		const key = rpcIdKey(value.id);
		const pending = key === undefined ? undefined : operation.rpcPending.get(key);
		if (pending === undefined) throw eventInvalidError();
		const hasResult = Object.hasOwn(value, "result");
		const hasError = Object.hasOwn(value, "error");
		if (hasResult === hasError) throw eventInvalidError();
		if (hasError) {
			if (
				!isRecord(value.error) ||
				!hasOnlyKeys(value.error, new Set(["code", "message", "data"])) ||
				!Number.isSafeInteger(value.error.code) ||
				typeof value.error.message !== "string"
			) {
				throw eventInvalidError();
			}
			pending.reject(new PrivateCodexAppServerError("external_protocol_unsupported"));
		} else {
			pending.accept(value.result);
		}
	}

	#acceptNotification(operation: CodexOperation, method: string, params: unknown): void {
		if (method === "turn/started") {
			if (
				operation.turnStarted ||
				!isRecord(params) ||
				!hasExactKeys(params, new Set(["threadId", "turn"])) ||
				params.threadId !== operation.threadId
			) {
				throw eventInvalidError();
			}
			const turn = validateTurn(params.turn, operation.turnId.length === 0 ? undefined : operation.turnId);
			if (turn.status !== "inProgress") throw eventInvalidError();
			if (operation.turnId.length === 0) operation.turnId = turn.id;
			operation.handle = Object.freeze({ ...operation.handle, externalTurnId: operation.turnId });
			this.#emitStarted(operation);
			operation.turnStarted = true;
			progress(operation, "turn_started");
			return;
		}
		if (method === "turn/completed") {
			if (
				!operation.turnStarted ||
				operation.terminalSeen ||
				operation.gatewayPending.size > 0 ||
				operation.respondedServerRequests.size > 0 ||
				!isRecord(params) ||
				!hasExactKeys(params, new Set(["threadId", "turn"])) ||
				params.threadId !== operation.threadId
			) {
				throw eventInvalidError();
			}
			const turn = validateTurn(params.turn, operation.turnId);
			if (turn.status !== "completed" && turn.status !== "interrupted" && turn.status !== "failed") {
				throw eventInvalidError();
			}
			if (operation.cancelRequested && turn.status !== "interrupted") throw eventInvalidError();
			operation.terminalSeen = true;
			if (operation.deadline !== undefined) {
				clearTimeout(operation.deadline);
				operation.deadline = undefined;
			}
			operation.terminal.resolve(
				terminalEvidence(operation, turn.status as "completed" | "interrupted" | "failed", this.#now),
			);
			operation.events.close();
			return;
		}
		if (method === "serverRequest/resolved") {
			if (
				!isRecord(params) ||
				!hasExactKeys(params, new Set(["threadId", "requestId"])) ||
				params.threadId !== operation.threadId
			) {
				throw eventInvalidError();
			}
			const requestKey = rpcIdKey(params.requestId);
			if (requestKey === undefined) throw eventInvalidError();
			if (!operation.respondedServerRequests.delete(requestKey)) {
				const unresolved = [...operation.gatewayPending.entries()].find(
					([, pending]) => rpcIdKey(pending.requestId) === requestKey,
				);
				if (unresolved === undefined) throw eventInvalidError();
				if (unresolved[1].responseKind === "dynamic_tool" && unresolved[1].sideEffecting) {
					operation.sideEffectState = "side_effect_unknown";
				}
				operation.gatewayPending.delete(unresolved[0]);
			}
			progress(operation, "server_request_resolved");
			return;
		}
		if (method === "error") {
			if (
				!isRecord(params) ||
				!hasExactKeys(params, new Set(["error", "threadId", "turnId", "willRetry"])) ||
				params.threadId !== operation.threadId ||
				params.turnId !== operation.turnId ||
				typeof params.willRetry !== "boolean"
			) {
				throw eventInvalidError();
			}
			validateTurnError(params.error);
			progress(operation, "error");
			return;
		}
		throw eventInvalidError();
	}

	async #acceptServerRequest(
		operation: CodexOperation,
		method: string,
		requestId: unknown,
		params: unknown,
	): Promise<void> {
		const requestKey = rpcIdKey(requestId);
		if (
			requestKey === undefined ||
			operation.rpcPending.size + operation.gatewayPending.size + operation.respondedServerRequests.size >=
				this.#limits.maxPendingRequests
		) {
			throw resourceLimitError();
		}
		if (
			[...operation.gatewayPending.values()].some((pending) => rpcIdKey(pending.requestId) === requestKey) ||
			operation.respondedServerRequests.has(requestKey)
		) {
			throw eventInvalidError();
		}
		if (!isRecord(params)) throw eventInvalidError();
		let route: { readonly namespace: string; readonly toolName: string };
		let responseKind: GatewayPending["responseKind"];
		let candidate: string;
		let sideEffecting = false;
		let argumentsValue: FoundationJsonValue;
		if (method === "item/tool/call") {
			if (
				!hasExactKeys(params, new Set(["threadId", "turnId", "callId", "namespace", "tool", "arguments"])) ||
				params.threadId !== operation.threadId ||
				params.turnId !== operation.turnId ||
				typeof params.callId !== "string" ||
				(params.namespace !== null && typeof params.namespace !== "string") ||
				typeof params.tool !== "string"
			) {
				throw eventInvalidError();
			}
			const selected = this.#tools.find(
				(tool) => tool.codexNamespace === params.namespace && tool.codexName === params.tool,
			);
			if (selected === undefined) throw eventInvalidError();
			route = selected.gateway;
			responseKind = "dynamic_tool";
			candidate = params.callId;
			sideEffecting = true;
			argumentsValue = cloneJson(params.arguments as FoundationJsonValue);
		} else {
			if (params.threadId !== operation.threadId || params.turnId !== operation.turnId) {
				throw eventInvalidError();
			}
			if (method === "mcpServer/elicitation/request") candidate = `mcp-${requestKey}`;
			else if (typeof params.itemId === "string") candidate = params.itemId;
			else throw eventInvalidError();
			argumentsValue = cloneJson(params as unknown as FoundationJsonValue);
			if (method === "item/commandExecution/requestApproval") {
				if (
					!hasOnlyKeys(
						params,
						new Set([
							"threadId",
							"turnId",
							"itemId",
							"startedAtMs",
							"approvalId",
							"environmentId",
							"reason",
							"networkApprovalContext",
							"command",
							"cwd",
							"commandActions",
							"proposedExecpolicyAmendment",
							"proposedNetworkPolicyAmendments",
							"kind",
							"additionalPermissions",
							"availableDecisions",
						]),
					)
				)
					throw eventInvalidError();
				if (
					!Number.isSafeInteger(params.startedAtMs) ||
					(params.environmentId !== null && typeof params.environmentId !== "string") ||
					(params.approvalId !== undefined &&
						params.approvalId !== null &&
						typeof params.approvalId !== "string") ||
					(params.reason !== undefined && params.reason !== null && typeof params.reason !== "string") ||
					(params.command !== undefined && params.command !== null && typeof params.command !== "string") ||
					(params.commandActions !== undefined &&
						params.commandActions !== null &&
						!Array.isArray(params.commandActions))
				) {
					throw eventInvalidError();
				}
				const canonicalCwd = await canonicalApprovalPath(params.cwd, "read", this.#cwd, this.#roots);
				argumentsValue = { ...(argumentsValue as Record<string, FoundationJsonValue>), cwd: canonicalCwd ?? null };
				route = PRIVATE_CODEX_SERVER_REQUEST_ROUTES.commandApproval;
				responseKind = "command_approval";
				sideEffecting = true;
			} else if (method === "item/fileChange/requestApproval") {
				if (!hasOnlyKeys(params, new Set(["threadId", "turnId", "itemId", "startedAtMs", "reason", "grantRoot"]))) {
					throw eventInvalidError();
				}
				if (
					!Number.isSafeInteger(params.startedAtMs) ||
					(params.reason !== undefined && params.reason !== null && typeof params.reason !== "string")
				) {
					throw eventInvalidError();
				}
				const grantRoot = await canonicalApprovalPath(params.grantRoot, "write", this.#cwd, this.#roots);
				argumentsValue = {
					...(argumentsValue as Record<string, FoundationJsonValue>),
					grantRoot: grantRoot ?? null,
				};
				route = PRIVATE_CODEX_SERVER_REQUEST_ROUTES.fileChangeApproval;
				responseKind = "file_approval";
				sideEffecting = true;
			} else if (method === "item/permissions/requestApproval") {
				if (
					!hasExactKeys(
						params,
						new Set([
							"threadId",
							"turnId",
							"itemId",
							"environmentId",
							"startedAtMs",
							"cwd",
							"reason",
							"permissions",
						]),
					)
				)
					throw eventInvalidError();
				if (
					!Number.isSafeInteger(params.startedAtMs) ||
					(params.environmentId !== null && typeof params.environmentId !== "string") ||
					typeof params.cwd !== "string" ||
					(params.reason !== null && typeof params.reason !== "string") ||
					!isRecord(params.permissions)
				) {
					throw eventInvalidError();
				}
				const canonicalCwd = await canonicalApprovalPath(params.cwd, "read", this.#cwd, this.#roots);
				argumentsValue = { ...(argumentsValue as Record<string, FoundationJsonValue>), cwd: canonicalCwd ?? null };
				route = PRIVATE_CODEX_SERVER_REQUEST_ROUTES.permissionsApproval;
				responseKind = "permissions_approval";
				sideEffecting = true;
			} else if (method === "mcpServer/elicitation/request") {
				const form = params.mode === "form" || params.mode === "openai/form";
				const expectedKeys = form
					? new Set(["threadId", "turnId", "serverName", "mode", "_meta", "message", "requestedSchema"])
					: new Set(["threadId", "turnId", "serverName", "mode", "_meta", "message", "url", "elicitationId"]);
				if (
					(params.mode !== "form" && params.mode !== "openai/form" && params.mode !== "url") ||
					!hasExactKeys(params, expectedKeys) ||
					typeof params.serverName !== "string" ||
					typeof params.message !== "string" ||
					(!form && (typeof params.url !== "string" || typeof params.elicitationId !== "string"))
				)
					throw eventInvalidError();
				route = PRIVATE_CODEX_SERVER_REQUEST_ROUTES.mcpElicitation;
				responseKind = "mcp_elicitation";
			} else if (method === "item/tool/requestUserInput") {
				if (
					!hasExactKeys(
						params,
						new Set(["threadId", "turnId", "itemId", "questions", "isBlocking", "autoResolutionMs"]),
					)
				)
					throw eventInvalidError();
				if (!Array.isArray(params.questions) || typeof params.isBlocking !== "boolean") {
					throw eventInvalidError();
				}
				route = PRIVATE_CODEX_SERVER_REQUEST_ROUTES.requestUserInput;
				responseKind = "request_user_input";
			} else {
				throw eventInvalidError();
			}
		}
		const callId = toolCallId(operation, candidate);
		if (operation.gatewayPending.has(callId)) throw eventInvalidError();
		operation.gatewayPending.set(callId, {
			requestId: requestId as string | number,
			toolName: route.toolName,
			responseKind,
			sideEffecting,
		});
		operationEvent(operation, {
			schemaVersion: 1,
			type: "tool_gateway_request",
			externalSessionId: operation.threadId,
			externalTurnId: operation.turnId,
			operationNonce: operation.handle.operationNonce,
			request: gatewayRequest(operation, callId, route.namespace, route.toolName, argumentsValue),
			producedAt: this.#now(),
		});
	}

	async #respondToServer(
		operation: CodexOperation,
		pending: GatewayPending,
		result: ToolExecutionResult,
	): Promise<void> {
		let payload: FoundationJsonValue;
		if (pending.responseKind === "dynamic_tool") {
			payload = {
				contentItems: [{ type: "inputText", text: JSON.stringify(jsonResult(result)) }],
				success: result.ok,
			};
		} else if (pending.responseKind === "command_approval" || pending.responseKind === "file_approval") {
			if (!result.ok) payload = { decision: "decline" };
			else if (
				!isRecord(result.result) ||
				!hasExactKeys(result.result, new Set(["decision"])) ||
				typeof result.result.decision !== "string" ||
				!new Set(["accept", "acceptForSession", "decline", "cancel"]).has(result.result.decision)
			) {
				throw eventInvalidError();
			} else payload = { decision: result.result.decision as FoundationJsonValue };
		} else {
			if (!result.ok) throw eventInvalidError();
			payload = exactServerResponse(pending.responseKind, result.result);
		}
		const requestKey = rpcIdKey(pending.requestId)!;
		operation.respondedServerRequests.add(requestKey);
		if (
			pending.sideEffecting &&
			result.ok &&
			(pending.responseKind === "permissions_approval" ||
				((pending.responseKind === "command_approval" || pending.responseKind === "file_approval") &&
					isRecord(payload) &&
					(payload.decision === "accept" || payload.decision === "acceptForSession")))
		) {
			operation.acceptedSideEffectingRequests.add(requestKey);
		}
		try {
			await this.#send(operation, { id: pending.requestId, result: payload });
		} catch (error) {
			operation.respondedServerRequests.delete(requestKey);
			throw error;
		}
	}

	#fail(operation: CodexOperation, error: unknown): void {
		if (operation.failure !== undefined || operation.closed) return;
		if (
			operation.acceptedSideEffectingRequests.size > 0 ||
			[...operation.gatewayPending.values()].some(
				(pending) => pending.responseKind === "dynamic_tool" && pending.sideEffecting,
			)
		) {
			operation.sideEffectState = "side_effect_unknown";
		}
		operation.failure = normalizeError(error);
		operation.events.fail(operation.failure);
		operation.terminal.reject(operation.failure);
		for (const pending of operation.rpcPending.values()) pending.reject(operation.failure);
		operation.rpcPending.clear();
		void Promise.resolve(operation.transport.close(operation.failure)).catch(() => undefined);
	}

	#emitStarted(operation: CodexOperation): void {
		if (operation.startedEventEmitted || operation.threadId.length === 0 || operation.turnId.length === 0) return;
		operation.startedEventEmitted = true;
		operationEvent(operation, {
			schemaVersion: 1,
			type: "started",
			externalSessionId: operation.threadId,
			externalTurnId: operation.turnId,
			producedAt: this.#now(),
		});
	}

	#requireOperation(handle: ExternalConnectorDriverHandle): CodexOperation {
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

	async #drainStderr(operation: CodexOperation, stderr: ReadableStream<Uint8Array>): Promise<void> {
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
			this.#fail(operation, error);
		} finally {
			reader.releaseLock();
		}
	}

	async #closeOperation(operation: CodexOperation, error?: unknown): Promise<void> {
		if (operation.closed) return;
		operation.closed = true;
		if (operation.deadline !== undefined) clearTimeout(operation.deadline);
		const failure = error === undefined ? eventInvalidError() : normalizeError(error);
		for (const pending of operation.rpcPending.values()) pending.reject(failure);
		operation.rpcPending.clear();
		operation.gatewayPending.clear();
		operation.events.close();
		try {
			await withTimeout(operation.writer.close(), this.#limits.requestTimeoutMs);
		} catch {
			// Transport close below is authoritative.
		} finally {
			operation.writer.releaseLock();
		}
		await Promise.allSettled([
			Promise.resolve(operation.transport.close(error)),
			...(operation.readerTask === undefined ? [] : [operation.readerTask]),
			...(operation.stderrTask === undefined ? [] : [operation.stderrTask]),
		]);
	}
}

/**
 * Explicit opt-in composition. Import and construction are passive; only a
 * durable run or resume opens the injected transport. This symbol is not
 * exported from the package root.
 */
export function createPrivateCodexExternalAgentConnector(options: PrivateCodexExternalAgentConnectorOptions) {
	validateCapability(options.providerId, options.capability);
	const driver = new PrivateCodexAppServerDriver(options);
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
