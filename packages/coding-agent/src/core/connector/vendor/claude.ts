/**
 * Private Claude Agent SDK driver.
 *
 * The SDK is deliberately absent from this module. A trusted companion owns
 * the static vendor import and receives only this bounded, package-private
 * protocol. Attempt, policy, Tool Gateway, receipt, and terminal authority
 * remain in the existing DurableExternalAgentConnector path.
 */

import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import type { Readable, Writable } from "node:stream";
import {
	Result,
	canonicalFoundationJson,
	isToolGatewayRoute,
	validateMcpSelection,
	type ArtifactStoreProvider,
	type AttemptReceiptUsage,
	type ConnectorCapabilitySnapshot,
	type FoundationJsonValue,
	type McpSelection,
	type ToolExecutionResult,
	type ToolGatewayRequest,
	type ToolGatewayRoute,
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
	translateExternalModelProjection,
	type ExternalModelFieldSupport,
	type ExternalModelSupportMatrix,
} from "../model-projection.ts";
import { ExternalConnectorSupervisorError } from "../supervisor.ts";
import {
	validateSafeLeaseProjection,
	type SafeLeaseProjection,
} from "../../worker/protocol.ts";
import type {
	CanonicalExternalAgentArtifactReference,
	CanonicalExternalAgentInput,
} from "../input.ts";
import type {
	ExternalConnectorDriverHandle,
	ExternalConnectorDriverLookup,
	ExternalConnectorDriverSpawnRequest,
	ExternalConnectorDriverWriteRequest,
	ExternalConnectorTerminalEvidence,
	ExternalConnectorVendorDriver,
} from "./types.ts";
import type { ExternalModelGatewayCapability } from "../model-gateway.ts";
import { PRIVATE_EXTERNAL_CONNECTOR_VENDOR_IDENTITIES } from "./identity.ts";

export const PRIVATE_CLAUDE_AGENT_SDK_VERSION = PRIVATE_EXTERNAL_CONNECTOR_VENDOR_IDENTITIES.claude.version;
const CLAUDE_PROTOCOL_NAME = "claude-agent-sdk";
const CLAUDE_PERMISSION_TOOL = "claude.permission.request";
const CLAUDE_NAMESPACE = "claude";
const CLAUDE_AOS_GATEWAY_PROVIDER = "bedrock";
const CLAUDE_EFFORT_LEVELS = Object.freeze(["low", "medium", "high", "xhigh", "max"] as const);
const CLAUDE_IMAGE_MEDIA_TYPES = Object.freeze(["image/gif", "image/jpeg", "image/png", "image/webp"] as const);
const CLAUDE_FILE_MEDIA_TYPES = Object.freeze(["application/pdf", "text/plain"] as const);

export const PRIVATE_CLAUDE_AGENT_SDK_CAPABILITIES = Object.freeze({
	sdkVersion: PRIVATE_CLAUDE_AGENT_SDK_VERSION,
	images: Object.freeze({ status: "supported" as const, mediaTypes: CLAUDE_IMAGE_MEDIA_TYPES }),
	files: Object.freeze({ status: "version-limited" as const, mediaTypes: CLAUDE_FILE_MEDIA_TYPES }),
	model: Object.freeze({ status: "supported" as const }),
	effort: Object.freeze({ status: "supported" as const, values: CLAUDE_EFFORT_LEVELS }),
	serviceTier: Object.freeze({ status: "version-limited" as const, provider: CLAUDE_AOS_GATEWAY_PROVIDER }),
	resume: Object.freeze({ status: "version-limited" as const, connectorEnabled: false }),
});

type PrivateClaudeEffortLevel = (typeof CLAUDE_EFFORT_LEVELS)[number];
type PrivateClaudeImageMediaType = (typeof CLAUDE_IMAGE_MEDIA_TYPES)[number];

export type PrivateClaudeNativeContentBlock =
	| { readonly type: "text"; readonly text: string }
	| {
			readonly type: "image";
			readonly source: {
				readonly type: "base64";
				readonly media_type: PrivateClaudeImageMediaType;
				readonly data: string;
			};
	  }
	| {
			readonly type: "document";
			readonly source:
				| { readonly type: "base64"; readonly media_type: "application/pdf"; readonly data: string }
				| { readonly type: "text"; readonly media_type: "text/plain"; readonly data: string };
	  };

export interface PrivateClaudeNativePrompt {
	readonly type: "user";
	readonly content: readonly PrivateClaudeNativeContentBlock[];
}

export interface PrivateClaudeModelSelection {
	readonly provider: typeof CLAUDE_AOS_GATEWAY_PROVIDER;
	readonly model: string;
	readonly effort: PrivateClaudeEffortLevel;
	readonly serviceTier: string;
	readonly fallbackDecision: string;
	readonly bindingDigest: string;
}

function exactModelSupport(
	targetField: string,
	accepts: (value: string) => boolean,
): ExternalModelFieldSupport {
	return Object.freeze({
		supported: true,
		targetField,
		accepts,
		translate: (value: string) => accepts(value) ? Object.freeze({ kind: "exact" as const, value }) : undefined,
	});
}

function acceptsCanonicalObject(value: string): boolean {
	try {
		const parsed: unknown = JSON.parse(value);
		return isRecord(parsed) && canonicalFoundationJson(parsed) === value;
	} catch {
		return false;
	}
}

export const PRIVATE_CLAUDE_MODEL_SUPPORT_MATRIX: ExternalModelSupportMatrix = Object.freeze({
	provider: exactModelSupport("apiProvider", (value) => value === CLAUDE_AOS_GATEWAY_PROVIDER),
	model: exactModelSupport("model", (value) => value.length > 0),
	effort: exactModelSupport("effort", (value) => CLAUDE_EFFORT_LEVELS.includes(value as PrivateClaudeEffortLevel)),
	serviceTier: exactModelSupport("serviceTier", (value) => value.length > 0),
	fallbackDecision: exactModelSupport("fallbackDecision", acceptsCanonicalObject),
	bindingDigest: exactModelSupport("bindingDigest", acceptsCanonicalObject),
});

export const PRIVATE_CLAUDE_AGENT_SDK_LIMITS = Object.freeze({
	maxMessageBytes: 256 * 1024,
	maxTotalBytes: 4 * 1024 * 1024,
	maxEvents: 256,
	maxPendingOperations: 64,
	requestTimeoutMs: 30_000,
});

export interface PrivateClaudeAgentSdkLimits {
	readonly maxMessageBytes: number;
	readonly maxTotalBytes: number;
	readonly maxEvents: number;
	readonly maxPendingOperations: number;
	readonly requestTimeoutMs: number;
}

export interface PrivateClaudeSelectedTool {
	readonly serverName: string;
	readonly toolName: string;
	readonly exposedToolName: string;
	readonly providerId: string;
	readonly routeRevision: number;
}

export interface PrivateClaudePermissionRequest {
	readonly requestId: string;
	readonly toolUseId: string;
	readonly toolName: string;
	readonly input: FoundationJsonValue;
	readonly signal: AbortSignal;
}

export interface PrivateClaudeToolRequest {
	readonly toolUseId: string;
	readonly toolName: string;
	readonly input: FoundationJsonValue;
	readonly signal: AbortSignal;
}

export interface PrivateClaudeToolResult {
	readonly ok: boolean;
	readonly sideEffectState: "none" | "unknown" | "side_effect_unknown";
	readonly result?: FoundationJsonValue;
}

export interface PrivateClaudeCompanionQueryRequest {
	readonly sdkVersion: typeof PRIVATE_CLAUDE_AGENT_SDK_VERSION;
	readonly prompt: PrivateClaudeNativePrompt;
	readonly model?: PrivateClaudeModelSelection;
	readonly credential?: SafeLeaseProjection;
	readonly modelGateway?: ExternalModelGatewayCapability;
	readonly cwd: string;
	readonly env: Readonly<Record<string, string>>;
	readonly tools: readonly PrivateClaudeSelectedTool[];
	readonly abortController: AbortController;
	readonly spawnClaudeCodeProcess?: (options: PrivateClaudeSpawnOptions) => PrivateClaudeSpawnedProcess;
	requestPermission(request: PrivateClaudePermissionRequest): Promise<"allow" | "deny">;
	executeTool(request: PrivateClaudeToolRequest): Promise<PrivateClaudeToolResult>;
	observeHook(eventName: "PreToolUse" | "PostToolUse" | "PostToolUseFailure", toolUseId?: string): void;
}

export interface PrivateClaudeCompanionQuery extends AsyncIterable<unknown> {
	close(): void;
}

/** Trusted static-import companion injected by activation code outside the default package root. */
export interface PrivateClaudeAgentSdkCompanion {
	readonly sdkVersion: typeof PRIVATE_CLAUDE_AGENT_SDK_VERSION;
	query(request: PrivateClaudeCompanionQueryRequest): PrivateClaudeCompanionQuery;
}

export interface PrivateClaudeSpawnOptions {
	readonly command: string;
	readonly args: readonly string[];
	readonly cwd?: string;
	readonly env: Readonly<Record<string, string | undefined>>;
	readonly signal: AbortSignal;
}

export interface PrivateClaudeSpawnedProcess {
	readonly stdin: Writable;
	readonly stdout: Readable;
	readonly killed: boolean;
	readonly exitCode: number | null;
	readonly signalCode?: NodeJS.Signals | null;
	kill(signal: NodeJS.Signals): boolean;
	on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
	on(event: "error", listener: (error: Error) => void): void;
	once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
	once(event: "error", listener: (error: Error) => void): void;
	off(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): void;
	off(event: "error", listener: (error: Error) => void): void;
}

export interface PrivateClaudeProcessBridge {
	spawn(
		reference: { readonly supervisorRef: string; readonly operationNonce: string },
		options: PrivateClaudeSpawnOptions,
	): PrivateClaudeSpawnedProcess;
}

export interface PrivateClaudeAgentSdkDriverOptions {
	readonly providerId: string;
	readonly companion: PrivateClaudeAgentSdkCompanion;
	readonly cwd: string;
	readonly processBridge?: PrivateClaudeProcessBridge;
	/** Optional exact fixed selection. Stock settings bind each run's canonical selection instead. */
	readonly mcpSelection?: McpSelection;
	readonly artifactStore?: Pick<ArtifactStoreProvider, "get">;
	/** Trusted, already-projected environment. Ambient process.env is never consulted. */
	readonly env?: Readonly<Record<string, string>>;
	readonly limits?: Partial<PrivateClaudeAgentSdkLimits>;
	readonly now?: () => string;
}

export type PrivateClaudeExternalAgentConnectorOptions = Omit<
	ExternalAgentConnectorRuntimeOptions,
	"capabilityProbe" | "driver"
> & PrivateClaudeAgentSdkDriverOptions;

type ClaudeDriverErrorCode =
	| "external_event_invalid"
	| "external_frame_oversize"
	| "external_protocol_unsupported"
	| "external_resume_unsupported"
	| "external_resource_limit_exceeded";

export class PrivateClaudeAgentSdkError extends Error {
	readonly code: ClaudeDriverErrorCode;

	constructor(code: ClaudeDriverErrorCode) {
		super(`Claude Agent SDK driver failed: ${code}`);
		this.name = "PrivateClaudeAgentSdkError";
		this.code = code;
	}
}

interface Deferred<T> {
	readonly promise: Promise<T>;
	readonly settled: () => boolean;
	readonly resolve: (value: T) => void;
	readonly reject: (error: unknown) => void;
}

interface ClaudeExecutionAuthority {
	readonly providerId: string;
	readonly attemptId: string;
	readonly taskId: string;
	readonly dispatchId: string;
	readonly bindingId: string;
	readonly bindingEpochId: string;
	readonly bindingDigest: string;
	readonly bindingRevision: number;
	readonly capabilityDigest: string;
	readonly capabilityRevision: number;
	readonly operationId: string;
}

interface PendingClaudeOperation {
	readonly toolName: string;
	readonly permission: boolean;
	readonly accept: (result: ToolExecutionResult) => void;
	readonly reject: (error: unknown) => void;
}

interface ClaudeOperation {
	handle: ExternalConnectorDriverHandle;
	readonly query: PrivateClaudeCompanionQuery;
	readonly tools: readonly PrivateClaudeSelectedTool[];
	readonly toolNames: ReadonlySet<string>;
	readonly abortController: AbortController;
	readonly events: BoundedEventQueue;
	readonly initialized: Deferred<void>;
	readonly terminal: Deferred<ExternalConnectorTerminalEvidence>;
	readonly pending: Map<string, PendingClaudeOperation>;
	readonly seenCallbacks: Set<string>;
	readonly model?: PrivateClaudeModelSelection;
	readonly authority?: ClaudeExecutionAuthority;
	sessionId: string;
	sequence: number;
	totalBytes: number;
	activeEffects: number;
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
		if (this.#closed || this.#error !== undefined) throw eventInvalidError();
		this.#count += 1;
		if (this.#count > this.#limit || this.#values.length >= this.#limit) {
			this.fail(resourceLimitError());
			throw resourceLimitError();
		}
		const waiter = this.#waiters.shift();
		if (waiter === undefined) this.#values.push(value);
		else waiter.resolve({ done: false, value });
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		for (const waiter of this.#waiters.splice(0)) waiter.resolve({ done: true, value: undefined });
	}

	fail(error: unknown): void {
		if (this.#error !== undefined) return;
		this.#error = error;
		for (const waiter of this.#waiters.splice(0)) waiter.reject(error);
	}

	iterable(signal?: AbortSignal): AsyncIterable<FoundationJsonValue> {
		return {
			[Symbol.asyncIterator]: () => ({
				next: () => {
					if (signal?.aborted === true) return Promise.reject(eventInvalidError());
					if (this.#values.length > 0) {
						return Promise.resolve({ done: false as const, value: this.#values.shift()! });
					}
					if (this.#error !== undefined) return Promise.reject(this.#error);
					if (this.#closed) return Promise.resolve({ done: true as const, value: undefined });
					const next = deferred<IteratorResult<FoundationJsonValue>>();
					this.#waiters.push(next);
					return next.promise;
				},
			}),
		};
	}
}

function deferred<T>(): Deferred<T> {
	let complete = false;
	let resolvePromise: (value: T) => void = () => undefined;
	let rejectPromise: (error: unknown) => void = () => undefined;
	const promise = new Promise<T>((resolve, reject) => {
		resolvePromise = resolve;
		rejectPromise = reject;
	});
	void promise.catch(() => undefined);
	return {
		promise,
		settled: () => complete,
		resolve: (value) => {
			if (complete) return;
			complete = true;
			resolvePromise(value);
		},
		reject: (error) => {
			if (complete) return;
			complete = true;
			rejectPromise(error);
		},
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function positiveSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function resolveLimits(value: Partial<PrivateClaudeAgentSdkLimits> | undefined): PrivateClaudeAgentSdkLimits {
	const resolved = { ...PRIVATE_CLAUDE_AGENT_SDK_LIMITS, ...value };
	for (const limit of Object.values(resolved)) {
		if (!positiveSafeInteger(limit)) throw new TypeError("Claude Agent SDK limit must be a positive safe integer");
	}
	return Object.freeze(resolved);
}

function resourceLimitError(): ExternalConnectorSupervisorError {
	return new ExternalConnectorSupervisorError("external_resource_limit_exceeded", "event", false);
}

function frameOversizeError(): ExternalConnectorSupervisorError {
	return new ExternalConnectorSupervisorError("external_frame_oversize", "event", false);
}

function eventInvalidError(): PrivateClaudeAgentSdkError {
	return new PrivateClaudeAgentSdkError("external_event_invalid");
}

function safeFailure(error: unknown): Error {
	if (error instanceof PrivateClaudeAgentSdkError || error instanceof ExternalConnectorSupervisorError) return error;
	return eventInvalidError();
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
	if (signal?.aborted === true) return Promise.reject(eventInvalidError());
	let timer: ReturnType<typeof setTimeout> | undefined;
	let abort: (() => void) | undefined;
	const timeout = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => reject(resourceLimitError()), timeoutMs);
		timer.unref?.();
		if (signal !== undefined) {
			abort = () => reject(eventInvalidError());
			signal.addEventListener("abort", abort, { once: true });
		}
	});
	return Promise.race([promise, timeout]).finally(() => {
		if (timer !== undefined) clearTimeout(timer);
		if (abort !== undefined) signal?.removeEventListener("abort", abort);
	});
}

function asFoundationJson(value: unknown): FoundationJsonValue {
	return JSON.parse(canonicalFoundationJson(value)) as FoundationJsonValue;
}

function validateCapability(providerId: string, capability: ConnectorCapabilitySnapshot): void {
	if (
		capability.providerId !== providerId ||
		capability.protocol.name !== CLAUDE_PROTOCOL_NAME ||
		capability.protocol.version !== PRIVATE_CLAUDE_AGENT_SDK_VERSION ||
		capability.resume !== false ||
		capability.toolGateway !== true ||
		(capability.images && !capability.artifacts) ||
		!(["agent_owned", "aos_gateway", "none"] as const).includes(capability.modelAccess)
	) {
		throw new PrivateClaudeAgentSdkError("external_protocol_unsupported");
	}
}

function resolveModelSelection(
	request: ExternalConnectorDriverSpawnRequest,
): PrivateClaudeModelSelection | undefined {
	if (request.capability.modelAccess !== "aos_gateway") {
		if (request.modelProjection !== undefined || request.modelTranslation !== undefined) {
			throw new PrivateClaudeAgentSdkError("external_protocol_unsupported");
		}
		return undefined;
	}
	if (
		request.modelProjection === undefined ||
		request.modelTranslation === undefined ||
		request.credential === undefined ||
		!validateSafeLeaseProjection(request.credential) ||
		request.modelGateway === undefined ||
		request.modelGateway.leaseId !== request.credential.leaseId ||
		request.modelGateway.modelBindingDigest !== request.modelProjection.bindingDigest.value ||
		request.modelGateway.expiresAt !== request.credential.expiresAt ||
		!request.modelGateway.authorization.startsWith("Bearer ")
	) {
		throw new PrivateClaudeAgentSdkError("external_protocol_unsupported");
	}
	try {
		const endpoint = new URL(request.modelGateway.endpoint);
		if (endpoint.protocol !== "http:" || endpoint.hostname !== "127.0.0.1") {
			throw new PrivateClaudeAgentSdkError("external_protocol_unsupported");
		}
	} catch {
		throw new PrivateClaudeAgentSdkError("external_protocol_unsupported");
	}
	const translated = translateExternalModelProjection(
		request.modelProjection,
		PRIVATE_CLAUDE_MODEL_SUPPORT_MATRIX,
	);
	if (
		!translated.ok ||
		canonicalFoundationJson(translated.translation) !== canonicalFoundationJson(request.modelTranslation)
	) {
		throw new PrivateClaudeAgentSdkError("external_protocol_unsupported");
	}
	const fields = request.modelTranslation.fields;
	if (
		fields.provider.targetField !== "apiProvider" ||
		fields.provider.value !== CLAUDE_AOS_GATEWAY_PROVIDER ||
		fields.model.targetField !== "model" ||
		fields.effort.targetField !== "effort" ||
		!CLAUDE_EFFORT_LEVELS.includes(fields.effort.value as PrivateClaudeEffortLevel) ||
		fields.serviceTier.targetField !== "serviceTier" ||
		fields.fallbackDecision.targetField !== "fallbackDecision" ||
		fields.bindingDigest.targetField !== "bindingDigest"
	) {
		throw new PrivateClaudeAgentSdkError("external_protocol_unsupported");
	}
	return Object.freeze({
		provider: CLAUDE_AOS_GATEWAY_PROVIDER,
		model: fields.model.value,
		effort: fields.effort.value as PrivateClaudeEffortLevel,
		serviceTier: fields.serviceTier.value,
		fallbackDecision: fields.fallbackDecision.value,
		bindingDigest: fields.bindingDigest.value,
	});
}

function resolveTools(selection: McpSelection): readonly PrivateClaudeSelectedTool[] {
	const tools: PrivateClaudeSelectedTool[] = [];
	const names = new Set<string>();
	for (const server of selection.servers) {
		if (!isExternalConnectorMappingIdentifier(server.serverId)) throw new TypeError("Claude MCP server id is invalid");
		for (const selected of server.tools) {
			if (!isExternalConnectorMappingIdentifier(selected.toolId)) throw new TypeError("Claude MCP tool id is invalid");
			const exposedToolName = `mcp__${server.serverId}__${selected.toolId}`;
			if (names.has(exposedToolName)) throw new TypeError("Claude MCP selection contains a duplicate tool");
			names.add(exposedToolName);
			tools.push(Object.freeze({
				serverName: server.serverId,
				toolName: selected.toolId,
				exposedToolName,
				providerId: selected.providerId,
				routeRevision: selected.routeRevision,
			}));
		}
	}
	return Object.freeze(tools);
}

function intersectToolGatewayRoutes(
	selectedTools: readonly PrivateClaudeSelectedTool[],
	routes: readonly ToolGatewayRoute[] | undefined,
): readonly PrivateClaudeSelectedTool[] {
	if (routes === undefined) throw new PrivateClaudeAgentSdkError("external_protocol_unsupported");
	const routeKeys = new Set<string>();
	for (const route of routes) {
		if (!isToolGatewayRoute(route)) throw new PrivateClaudeAgentSdkError("external_protocol_unsupported");
		const key = canonicalFoundationJson([route.namespace ?? "", route.toolName]);
		if (routeKeys.has(key)) throw new PrivateClaudeAgentSdkError("external_protocol_unsupported");
		routeKeys.add(key);
		if (
			route.kind === "mcp" &&
			!selectedTools.some(
				(tool) =>
					tool.serverName === route.namespace &&
					tool.toolName === route.toolName &&
					tool.providerId === route.providerId &&
					tool.routeRevision === route.revision,
			)
		) {
			throw new PrivateClaudeAgentSdkError("external_protocol_unsupported");
		}
	}
	return Object.freeze(
		selectedTools.filter((tool) =>
			routes.some(
				(route) =>
					route.kind === "mcp" &&
					route.namespace === tool.serverName &&
					route.toolName === tool.toolName &&
					route.providerId === tool.providerId &&
					route.revision === tool.routeRevision,
			),
		),
	);
}

function authorityFor(request: ExternalConnectorDriverSpawnRequest): ClaudeExecutionAuthority {
	const bindingEpochId = request.attempt.bindingEpochIds[0];
	const operationId = request.correlation.operationId;
	if (
		bindingEpochId === undefined ||
		request.attempt.dispatchId === undefined ||
		request.correlation.runId === undefined ||
		operationId === undefined ||
		operationId !== request.correlation.runId
	) {
		throw new TypeError("Claude execution requires canonical Tool Gateway correlation");
	}
	return Object.freeze({
		providerId: request.capability.providerId,
		attemptId: request.attempt.attemptId,
		taskId: request.attempt.taskId,
		dispatchId: request.attempt.dispatchId,
		bindingId: request.attempt.bindingId,
		bindingEpochId,
		bindingDigest: request.bindingDigest,
		bindingRevision: request.bindingRevision,
		capabilityDigest: request.capability.digest.value,
		capabilityRevision: request.capability.revision,
		operationId,
	});
}

function callbackId(prefix: "permission" | "tool", operation: ClaudeOperation, candidate: string): string {
	return `claude_${prefix}_${createHash("sha256")
		.update(`${operation.handle.operationNonce}:${candidate}`)
		.digest("hex")}`;
}

function toolGatewayRequest(
	operation: ClaudeOperation,
	toolCallId: string,
	toolName: string,
	input: FoundationJsonValue,
): ToolGatewayRequest {
	const authority = operation.authority;
	if (authority === undefined) throw eventInvalidError();
	return Object.freeze({
		schemaVersion: 1,
		toolCallId,
		toolName,
		namespace: toolName === CLAUDE_PERMISSION_TOOL ? CLAUDE_NAMESPACE : undefined,
		originalArguments: input,
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

function updateSideEffectState(operation: ClaudeOperation, result: ToolExecutionResult): void {
	if (result.sideEffectState === "side_effect_unknown") operation.sideEffectState = "side_effect_unknown";
	else if (result.sideEffectState === "unknown" && operation.sideEffectState === "none") {
		operation.sideEffectState = "unknown";
	}
}

function mappingMatchesHandle(
	mapping: CanonicalExternalConnectorMapping,
	handle: ExternalConnectorDriverHandle,
): boolean {
	return mapping.externalSessionId === handle.externalSessionId &&
		mapping.externalTurnId === handle.externalTurnId &&
		mapping.supervisor.ref === handle.supervisorRef &&
		mapping.supervisor.nonce === handle.operationNonce;
}

function mappingMatchesOperation(mapping: CanonicalExternalConnectorMapping, operation: ClaudeOperation): boolean {
	const authority = operation.authority;
	return authority !== undefined &&
		mappingMatchesHandle(mapping, operation.handle) &&
		mapping.providerId === authority.providerId &&
		mapping.attemptId === authority.attemptId &&
		mapping.binding.digest.value === authority.bindingDigest &&
		mapping.binding.revision === authority.bindingRevision &&
		mapping.capability.digest.value === authority.capabilityDigest &&
		mapping.capability.revision === authority.capabilityRevision;
}

const CLAUDE_MODEL_USAGE_KEYS = new Set([
	"inputTokens",
	"outputTokens",
	"cacheReadInputTokens",
	"cacheCreationInputTokens",
	"webSearchRequests",
	"costUSD",
	"contextWindow",
	"maxOutputTokens",
	"canonicalModel",
	"provider",
	"costBasis",
]);

function boundedCount(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function boundedCost(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
}

function validateUsage(message: Record<string, unknown>): AttemptReceiptUsage {
	if (
		!isRecord(message.usage) ||
		!boundedCount(message.usage.input_tokens) ||
		!boundedCount(message.usage.output_tokens) ||
		(message.usage.cache_read_input_tokens !== undefined && !boundedCount(message.usage.cache_read_input_tokens)) ||
		(message.usage.cache_creation_input_tokens !== undefined && !boundedCount(message.usage.cache_creation_input_tokens)) ||
		!boundedCost(message.total_cost_usd)
	) throw eventInvalidError();
	if (!isRecord(message.modelUsage)) throw eventInvalidError();
	for (const usage of Object.values(message.modelUsage)) {
		if (
			!isRecord(usage) ||
			Reflect.ownKeys(usage).some((key) => typeof key !== "string" || !CLAUDE_MODEL_USAGE_KEYS.has(key)) ||
			![
				usage.inputTokens,
				usage.outputTokens,
				usage.cacheReadInputTokens,
				usage.cacheCreationInputTokens,
				usage.webSearchRequests,
				usage.contextWindow,
				usage.maxOutputTokens,
			].every(boundedCount) ||
			!boundedCost(usage.costUSD) ||
			(usage.canonicalModel !== undefined && typeof usage.canonicalModel !== "string") ||
			(usage.provider !== undefined && typeof usage.provider !== "string") ||
			(usage.costBasis !== undefined &&
				(typeof usage.costBasis !== "string" || !["list", "managed", "unknown"].includes(usage.costBasis)))
		) throw eventInvalidError();
	}
	return Object.freeze({
		inputTokens: message.usage.input_tokens,
		outputTokens: message.usage.output_tokens,
		cacheReadInputTokens: message.usage.cache_read_input_tokens ?? 0,
		cacheCreationInputTokens: message.usage.cache_creation_input_tokens ?? 0,
		costUsd: message.total_cost_usd,
	});
}

function effectiveModelEvidence(
	operation: ClaudeOperation,
	message: Record<string, unknown>,
	observedAt: string,
): ExternalConnectorTerminalEvidence["effectiveModel"] {
	const model = operation.model;
	if (model === undefined) return undefined;
	if (!isRecord(message.modelUsage)) throw eventInvalidError();
	const observations = Object.values(message.modelUsage);
	if (
		observations.length !== 1 ||
		!observations.every((usage) =>
			isRecord(usage) && usage.provider === model.provider && usage.canonicalModel === model.model)
	) throw new PrivateClaudeAgentSdkError("external_protocol_unsupported");
	let bindingDigest: { algorithm: "sha256"; value: string };
	try {
		bindingDigest = JSON.parse(model.bindingDigest) as { algorithm: "sha256"; value: string };
	} catch {
		throw new PrivateClaudeAgentSdkError("external_protocol_unsupported");
	}
	return Object.freeze({
		provider: model.provider,
		model: model.model,
		bindingDigest,
		observedAt,
		source: "claude_init_and_usage" as const,
	});
}

function failedEvidence(
	operation: ClaudeOperation,
	now: () => string,
	code: "agent_run_failed" | "side_effect_unknown" = "agent_run_failed",
	usage?: AttemptReceiptUsage,
): ExternalConnectorTerminalEvidence {
	return {
		externalSessionId: operation.sessionId,
		externalTurnId: operation.handle.externalTurnId,
		operationNonce: operation.handle.operationNonce,
		status: "failed",
		artifacts: [],
		...(usage === undefined ? {} : { usage }),
		error: code === "side_effect_unknown"
			? { code, message: "External side effect state is unknown.", category: "side_effect_unknown", retryable: false }
			: { code, message: "Run failed.", category: "unknown", retryable: false },
		sideEffectState: operation.sideEffectState,
		producedAt: now(),
	};
}

function cancellationEvidence(
	operation: ClaudeOperation,
	now: () => string,
	usage?: AttemptReceiptUsage,
): ExternalConnectorTerminalEvidence {
	if (operation.activeEffects > 0 || operation.sideEffectState !== "none") {
		operation.sideEffectState = "side_effect_unknown";
		return failedEvidence(operation, now, "side_effect_unknown", usage);
	}
	return {
		externalSessionId: operation.sessionId,
		externalTurnId: operation.handle.externalTurnId,
		operationNonce: operation.handle.operationNonce,
		status: "cancelled",
		artifacts: [],
		...(usage === undefined ? {} : { usage }),
		sideEffectState: "none",
		producedAt: now(),
	};
}

/** @internal Package-private driver for the pinned Claude Agent SDK companion. */
export class PrivateClaudeAgentSdkDriver implements ExternalConnectorVendorDriver {
	readonly modelSupportMatrix = PRIVATE_CLAUDE_MODEL_SUPPORT_MATRIX;
	readonly toolGatewayMcpSelection?: McpSelection;
	readonly #providerId: string;
	readonly #companion: PrivateClaudeAgentSdkCompanion;
	readonly #cwd: string;
	readonly #env: Readonly<Record<string, string>>;
	readonly #artifactStore: Pick<ArtifactStoreProvider, "get"> | undefined;
	readonly #processBridge: PrivateClaudeProcessBridge | undefined;
	readonly #selectedTools: readonly PrivateClaudeSelectedTool[] | undefined;
	readonly #limits: PrivateClaudeAgentSdkLimits;
	readonly #now: () => string;
	readonly #operations = new Map<string, ClaudeOperation>();
	readonly #allOperations = new Set<ClaudeOperation>();

	constructor(options: PrivateClaudeAgentSdkDriverOptions) {
		if (!isExternalConnectorMappingIdentifier(options.providerId)) throw new TypeError("Claude provider id is invalid");
		if (options.companion.sdkVersion !== PRIVATE_CLAUDE_AGENT_SDK_VERSION) {
			throw new PrivateClaudeAgentSdkError("external_protocol_unsupported");
		}
		if (typeof options.cwd !== "string" || options.cwd.length === 0) throw new TypeError("Claude cwd is required");
		const mcpSelection = options.mcpSelection === undefined ? undefined : validateMcpSelection(options.mcpSelection);
		if (mcpSelection !== undefined && !mcpSelection.ok) throw new TypeError("Claude MCP selection is not canonical");
		this.#providerId = options.providerId;
		this.#companion = options.companion;
		this.#cwd = options.cwd;
		this.#env = Object.freeze({ ...(options.env ?? {}) });
		this.#artifactStore = options.artifactStore;
		this.#processBridge = options.processBridge;
		if (mcpSelection?.ok === true) this.toolGatewayMcpSelection = mcpSelection.value;
		this.#selectedTools = mcpSelection?.ok === true ? resolveTools(mcpSelection.value) : undefined;
		this.#limits = resolveLimits(options.limits);
		this.#now = options.now ?? (() => new Date().toISOString());
	}

	async spawn(request: ExternalConnectorDriverSpawnRequest): Promise<ExternalConnectorDriverHandle> {
		validateCapability(this.#providerId, request.capability);
		if (
			(request.input.artifacts.length > 0 && !request.capability.artifacts) ||
			(request.input.artifacts.some((artifact) => artifact.kind === "image") && !request.capability.images)
		) {
			throw new PrivateClaudeAgentSdkError("external_protocol_unsupported");
		}
		const model = resolveModelSelection(request);
		const prompt = await this.#nativePrompt(request.input, request.signal);
		const mcpSelection = validateMcpSelection(request.mcpSelection);
		if (
			!mcpSelection.ok ||
			(this.toolGatewayMcpSelection !== undefined &&
				canonicalFoundationJson(mcpSelection.value) !== canonicalFoundationJson(this.toolGatewayMcpSelection))
		) throw new PrivateClaudeAgentSdkError("external_protocol_unsupported");
		const tools = intersectToolGatewayRoutes(
			this.#selectedTools ?? resolveTools(mcpSelection.value),
			request.toolGatewayRoutes,
		);
		const operation = this.#openOperation({
			prompt,
			tools,
			...(model === undefined ? {} : { model, credential: request.credential, modelGateway: request.modelGateway }),
			supervisorRef: request.supervisorRef,
			operationNonce: request.operationNonce,
			externalTurnId: request.attempt.attemptId,
			authority: authorityFor(request),
			signal: request.signal,
		});
		await withTimeout(operation.initialized.promise, this.#limits.requestTimeoutMs, request.signal);
		return operation.handle;
	}

	events(
		handle: ExternalConnectorDriverHandle,
		options?: { readonly signal?: AbortSignal },
	): AsyncIterable<FoundationJsonValue> {
		return this.#requireOperation(handle).events.iterable(options?.signal);
	}

	async connect(
		mapping: CanonicalExternalConnectorMapping,
	): Promise<ExternalConnectorDriverHandle> {
		const known = this.#operations.get(mapping.externalSessionId);
		if (known !== undefined && !known.closed) {
			if (!mappingMatchesOperation(mapping, known)) throw eventInvalidError();
			return known.handle;
		}
		throw new PrivateClaudeAgentSdkError("external_resume_unsupported");
	}

	async lookup(mapping: CanonicalExternalConnectorMapping): Promise<ExternalConnectorDriverLookup> {
		const operation = this.#operations.get(mapping.externalSessionId);
		if (operation === undefined) return { status: "missing" };
		if (!mappingMatchesOperation(mapping, operation)) return { status: "ambiguous" };
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
		return withTimeout(this.#requireOperation(handle).terminal.promise, this.#limits.requestTimeoutMs, options?.signal);
	}

	async write(
		handle: ExternalConnectorDriverHandle,
		request: ExternalConnectorDriverWriteRequest,
	): Promise<void> {
		const operation = this.#requireOperation(handle);
		if (request.operationNonce !== operation.handle.operationNonce || operation.terminal.settled()) {
			throw eventInvalidError();
		}
		const pending = operation.pending.get(request.result.toolCallId);
		if (pending === undefined || pending.toolName !== request.result.toolName) throw eventInvalidError();
		operation.pending.delete(request.result.toolCallId);
		updateSideEffectState(operation, request.result);
		pending.accept(request.result);
	}

	async heartbeat(handle: ExternalConnectorDriverHandle): Promise<void> {
		const operation = this.#requireOperation(handle);
		if (operation.closed || operation.abortController.signal.aborted) throw eventInvalidError();
	}

	async cancel(handle: ExternalConnectorDriverHandle): Promise<ExternalConnectorTerminalEvidence | undefined> {
		const operation = this.#requireOperation(handle);
		if (operation.terminal.settled()) return operation.terminal.promise;
		operation.cancelRequested = true;
		for (const pending of operation.pending.values()) pending.reject(eventInvalidError());
		operation.pending.clear();
		operation.abortController.abort();
		operation.query.close();
		const evidence = cancellationEvidence(operation, this.#now);
		operation.terminal.resolve(evidence);
		operation.events.close();
		return evidence;
	}

	async dispose(): Promise<void> {
		const operations = [...this.#allOperations];
		this.#operations.clear();
		for (const operation of operations) this.#closeOperation(operation);
		this.#allOperations.clear();
	}

	#openOperation(input: {
		readonly prompt: PrivateClaudeNativePrompt;
		readonly tools: readonly PrivateClaudeSelectedTool[];
		readonly model?: PrivateClaudeModelSelection;
		readonly credential?: SafeLeaseProjection;
		readonly modelGateway?: ExternalModelGatewayCapability;
		readonly supervisorRef: string;
		readonly operationNonce: string;
		readonly externalTurnId?: string;
		readonly authority?: ClaudeExecutionAuthority;
		readonly signal?: AbortSignal;
	}): ClaudeOperation {
		const abortController = new AbortController();
		if (input.signal?.aborted === true) abortController.abort();
		else input.signal?.addEventListener("abort", () => abortController.abort(), { once: true });
		let operation: ClaudeOperation | undefined;
		const processBridge = this.#processBridge;
		const query = this.#companion.query({
			sdkVersion: PRIVATE_CLAUDE_AGENT_SDK_VERSION,
			prompt: input.prompt,
			...(input.model === undefined ? {} : { model: input.model }),
			...(input.credential === undefined ? {} : { credential: input.credential }),
			...(input.modelGateway === undefined ? {} : { modelGateway: input.modelGateway }),
			cwd: this.#cwd,
			env: this.#env,
			tools: input.tools,
			abortController,
			...(processBridge === undefined
				? {}
				: {
					spawnClaudeCodeProcess: (options: PrivateClaudeSpawnOptions) =>
						processBridge.spawn(
							{ supervisorRef: input.supervisorRef, operationNonce: input.operationNonce },
							options,
						),
				}),
			requestPermission: (request) => this.#requestPermission(this.#requireLiveOperation(operation), request),
			executeTool: (request) => this.#executeTool(this.#requireLiveOperation(operation), request),
			observeHook: (eventName) => {
				const current = this.#requireLiveOperation(operation);
				if (current.terminal.settled()) throw eventInvalidError();
				this.#progress(current, `hook.${eventName}`);
			},
		});
		if (!isRecord(query) || typeof query.close !== "function" || query[Symbol.asyncIterator] === undefined) {
			throw new TypeError("Claude companion query is invalid");
		}
		operation = {
			handle: Object.freeze({
				externalSessionId: "claude_session_pending",
				...(input.externalTurnId === undefined ? {} : { externalTurnId: input.externalTurnId }),
				supervisorRef: input.supervisorRef,
				operationNonce: input.operationNonce,
			}),
			query,
			tools: input.tools,
			toolNames: new Set(input.tools.map((tool) => tool.exposedToolName)),
			abortController,
			events: new BoundedEventQueue(this.#limits.maxEvents),
			initialized: deferred<void>(),
			terminal: deferred<ExternalConnectorTerminalEvidence>(),
			pending: new Map(),
			seenCallbacks: new Set(),
			...(input.model === undefined ? {} : { model: input.model }),
			...(input.authority === undefined ? {} : { authority: input.authority }),
			sessionId: "",
			sequence: 0,
			totalBytes: 0,
			activeEffects: 0,
			sideEffectState: "none",
			cancelRequested: false,
			closed: false,
		};
		this.#allOperations.add(operation);
		void this.#consume(operation);
		return operation;
	}

	async #consume(operation: ClaudeOperation): Promise<void> {
		try {
			for await (const raw of operation.query) {
				this.#acceptMessage(operation, raw);
				if (operation.terminal.settled()) break;
			}
			if (!operation.terminal.settled() && !operation.cancelRequested) throw eventInvalidError();
		} catch (error) {
			if (!operation.terminal.settled()) {
				if (
					operation.initialized.settled() &&
					operation.abortController.signal.aborted &&
					(operation.activeEffects > 0 || operation.sideEffectState !== "none")
				) {
					const evidence = cancellationEvidence(operation, this.#now);
					operation.terminal.resolve(evidence);
					operation.events.close();
				} else {
					const safe = safeFailure(error);
					operation.initialized.reject(safe);
					operation.terminal.reject(safe);
					operation.events.fail(safe);
				}
			}
		} finally {
			for (const pending of operation.pending.values()) pending.reject(eventInvalidError());
			operation.pending.clear();
		}
	}

	#acceptMessage(operation: ClaudeOperation, raw: unknown): void {
		if (operation.terminal.settled()) throw eventInvalidError();
		let serialized: string;
		try {
			serialized = canonicalFoundationJson(raw);
		} catch {
			throw eventInvalidError();
		}
		const bytes = Buffer.byteLength(serialized, "utf8");
		if (bytes > this.#limits.maxMessageBytes) throw frameOversizeError();
		operation.totalBytes += bytes;
		if (operation.totalBytes > this.#limits.maxTotalBytes) throw resourceLimitError();
		if (!isRecord(raw) || typeof raw.type !== "string") throw eventInvalidError();
		if (raw.type === "system" && raw.subtype === "init") {
			this.#acceptInit(operation, raw);
			return;
		}
		if (!operation.initialized.settled()) throw eventInvalidError();
		if (raw.type === "result") {
			this.#acceptResult(operation, raw);
			return;
		}
		if (!["assistant", "user", "system"].includes(raw.type)) throw eventInvalidError();
		if (typeof raw.session_id !== "string" || raw.session_id !== operation.sessionId) throw eventInvalidError();
		this.#progress(operation, raw.type === "system" && typeof raw.subtype === "string"
			? `sdk.system.${raw.subtype}`
			: `sdk.${raw.type}`);
	}

	#acceptInit(operation: ClaudeOperation, message: Record<string, unknown>): void {
		if (operation.initialized.settled()) throw eventInvalidError();
		if (
			typeof message.session_id !== "string" ||
			!isExternalConnectorMappingIdentifier(message.session_id) ||
			!Array.isArray(message.tools) ||
			message.tools.some((tool) => typeof tool !== "string") ||
			!Array.isArray(message.mcp_servers) ||
			message.mcp_servers.some((server) =>
				!isRecord(server) || typeof server.name !== "string" || server.status !== "connected"
			)
		) {
			throw eventInvalidError();
		}
		const actualTools = [...message.tools].sort();
		const expectedTools = operation.tools.map((tool) => tool.exposedToolName).sort();
		const actualServers = message.mcp_servers.map((server) => (server as Record<string, unknown>).name).sort();
		const expectedServers = [...new Set(operation.tools.map((tool) => tool.serverName))].sort();
		if (
			actualTools.length !== expectedTools.length ||
			actualTools.some((tool, index) => tool !== expectedTools[index]) ||
			actualServers.length !== expectedServers.length ||
			actualServers.some((server, index) => server !== expectedServers[index]) ||
			(operation.model !== undefined &&
				(message.model !== operation.model.model || message.effort !== operation.model.effort))
		) {
			throw new PrivateClaudeAgentSdkError("external_protocol_unsupported");
		}
		operation.sessionId = message.session_id;
		operation.handle = Object.freeze({ ...operation.handle, externalSessionId: message.session_id });
		this.#operations.set(message.session_id, operation);
		operation.events.push({
			schemaVersion: 1,
			type: "started",
			externalSessionId: message.session_id,
			...(operation.handle.externalTurnId === undefined ? {} : { externalTurnId: operation.handle.externalTurnId }),
			producedAt: this.#now(),
		} as unknown as FoundationJsonValue);
		operation.initialized.resolve();
	}

	#acceptResult(operation: ClaudeOperation, message: Record<string, unknown>): void {
		if (
			typeof message.session_id !== "string" ||
			message.session_id !== operation.sessionId ||
			typeof message.subtype !== "string" ||
			typeof message.is_error !== "boolean"
		) {
			throw eventInvalidError();
		}
		const usage = validateUsage(message);
		let evidence: ExternalConnectorTerminalEvidence;
		if (operation.cancelRequested) {
			evidence = cancellationEvidence(operation, this.#now, usage);
		} else if (message.subtype !== "success" || message.is_error || operation.sideEffectState !== "none") {
			evidence = failedEvidence(
				operation,
				this.#now,
				operation.sideEffectState === "none" ? "agent_run_failed" : "side_effect_unknown",
				usage,
			);
		} else {
			const observedAt = this.#now();
			const effectiveModel = effectiveModelEvidence(operation, message, observedAt);
			evidence = {
				externalSessionId: operation.sessionId,
				externalTurnId: operation.handle.externalTurnId,
				operationNonce: operation.handle.operationNonce,
				status: "succeeded",
				artifacts: [],
				usage,
				...(effectiveModel === undefined ? {} : { effectiveModel }),
				sideEffectState: "none",
				producedAt: observedAt,
			};
		}
		operation.terminal.resolve(evidence);
		operation.events.close();
	}

	#progress(operation: ClaudeOperation, phase: string): void {
		operation.sequence += 1;
		operation.events.push({
			schemaVersion: 1,
			type: "progress",
			externalSessionId: operation.sessionId,
			...(operation.handle.externalTurnId === undefined ? {} : { externalTurnId: operation.handle.externalTurnId }),
			sequence: operation.sequence,
			phase,
			producedAt: this.#now(),
		} as unknown as FoundationJsonValue);
	}

	async #requestPermission(
		operation: ClaudeOperation,
		request: PrivateClaudePermissionRequest,
	): Promise<"allow" | "deny"> {
		if (
			operation.terminal.settled() ||
			request.signal.aborted ||
			!operation.toolNames.has(request.toolName) ||
			request.requestId.length === 0 ||
			request.toolUseId.length === 0
		) {
			return "deny";
		}
		const callbackKey = `permission:${request.requestId}`;
		if (operation.seenCallbacks.has(callbackKey)) return "deny";
		operation.seenCallbacks.add(callbackKey);
		try {
			const result = await this.#requestGateway(
				operation,
				callbackId("permission", operation, request.requestId),
				CLAUDE_PERMISSION_TOOL,
				asFoundationJson({ toolName: request.toolName, input: request.input }),
				true,
				request.signal,
			);
			return result.ok && isRecord(result.result) && result.result.behavior === "allow" ? "allow" : "deny";
		} catch {
			return "deny";
		}
	}

	async #executeTool(operation: ClaudeOperation, request: PrivateClaudeToolRequest): Promise<PrivateClaudeToolResult> {
		if (
			operation.terminal.settled() ||
			request.signal.aborted ||
			!operation.toolNames.has(request.toolName) ||
			request.toolUseId.length === 0
		) {
			return { ok: false, sideEffectState: "none" };
		}
		const callbackKey = `tool:${request.toolUseId}`;
		if (operation.seenCallbacks.has(callbackKey)) return { ok: false, sideEffectState: "none" };
		operation.seenCallbacks.add(callbackKey);
		operation.activeEffects += 1;
		try {
			const result = await this.#requestGateway(
				operation,
				callbackId("tool", operation, request.toolUseId),
				request.toolName,
				request.input,
				false,
				request.signal,
			);
			return {
				ok: result.ok,
				sideEffectState: result.sideEffectState,
				...(result.result === undefined ? {} : { result: result.result }),
			};
		} catch {
			if (operation.cancelRequested || request.signal.aborted) operation.sideEffectState = "side_effect_unknown";
			return { ok: false, sideEffectState: operation.sideEffectState };
		} finally {
			operation.activeEffects -= 1;
		}
	}

	async #requestGateway(
		operation: ClaudeOperation,
		toolCallId: string,
		toolName: string,
		input: FoundationJsonValue,
		permission: boolean,
		signal: AbortSignal,
	): Promise<ToolExecutionResult> {
		if (operation.cancelRequested || operation.terminal.settled() || signal.aborted) throw eventInvalidError();
		if (operation.pending.size >= this.#limits.maxPendingOperations || operation.pending.has(toolCallId)) {
			throw resourceLimitError();
		}
		const result = deferred<ToolExecutionResult>();
		operation.pending.set(toolCallId, {
			toolName,
			permission,
			accept: result.resolve,
			reject: result.reject,
		});
		const request = toolGatewayRequest(operation, toolCallId, toolName, input);
		operation.events.push({
			schemaVersion: 1,
			type: "tool_gateway_request",
			externalSessionId: operation.sessionId,
			...(operation.handle.externalTurnId === undefined ? {} : { externalTurnId: operation.handle.externalTurnId }),
			operationNonce: operation.handle.operationNonce,
			request,
			producedAt: this.#now(),
		} as unknown as FoundationJsonValue);
		try {
			return await withTimeout(result.promise, this.#limits.requestTimeoutMs, signal);
		} finally {
			operation.pending.delete(toolCallId);
		}
	}

	#requireLiveOperation(operation: ClaudeOperation | undefined): ClaudeOperation {
		if (operation === undefined || operation.closed) throw eventInvalidError();
		return operation;
	}

	#requireOperation(handle: ExternalConnectorDriverHandle): ClaudeOperation {
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

	#closeOperation(operation: ClaudeOperation): void {
		if (operation.closed) return;
		operation.closed = true;
		operation.abortController.abort();
		for (const pending of operation.pending.values()) pending.reject(eventInvalidError());
		operation.pending.clear();
		operation.events.close();
		operation.query.close();
	}

	async #nativePrompt(input: CanonicalExternalAgentInput, signal?: AbortSignal): Promise<PrivateClaudeNativePrompt> {
		const content: PrivateClaudeNativeContentBlock[] = [{ type: "text", text: input.text }];
		for (const artifact of input.artifacts) content.push(await this.#nativeArtifact(artifact, signal));
		return Object.freeze({ type: "user", content: Object.freeze(content) });
	}

	async #nativeArtifact(
		artifact: CanonicalExternalAgentArtifactReference,
		signal?: AbortSignal,
	): Promise<PrivateClaudeNativeContentBlock> {
		const imageMediaType = CLAUDE_IMAGE_MEDIA_TYPES.find((mediaType) => mediaType === artifact.mediaType);
		const fileMediaType = CLAUDE_FILE_MEDIA_TYPES.find((mediaType) => mediaType === artifact.mediaType);
		if (
			this.#artifactStore === undefined ||
			(artifact.kind === "image" && imageMediaType === undefined) ||
			(artifact.kind === "file" && fileMediaType === undefined)
		) {
			throw new PrivateClaudeAgentSdkError("external_protocol_unsupported");
		}
		const loaded = await withTimeout(
			this.#artifactStore.get(artifact.artifactId),
			this.#limits.requestTimeoutMs,
			signal,
		);
		if (
			!loaded.ok ||
			loaded.value.byteLength !== artifact.sizeBytes ||
			createHash("sha256").update(loaded.value).digest("hex") !== artifact.artifactId
		) {
			throw eventInvalidError();
		}
		if (artifact.kind === "image" && imageMediaType !== undefined) {
			return Object.freeze({
				type: "image",
				source: Object.freeze({
					type: "base64",
					media_type: imageMediaType,
					data: Buffer.from(loaded.value).toString("base64"),
				}),
			});
		}
		if (fileMediaType === "application/pdf") {
			return Object.freeze({
				type: "document",
				source: Object.freeze({
					type: "base64",
					media_type: "application/pdf",
					data: Buffer.from(loaded.value).toString("base64"),
				}),
			});
		}
		try {
			return Object.freeze({
				type: "document",
				source: Object.freeze({
					type: "text",
					media_type: "text/plain",
					data: new TextDecoder("utf-8", { fatal: true }).decode(loaded.value),
				}),
			});
		} catch {
			throw eventInvalidError();
		}
	}
}

/** Explicit opt-in composition. Construction itself does not touch the companion. */
export function createPrivateClaudeExternalAgentConnector(
	options: PrivateClaudeExternalAgentConnectorOptions,
) {
	validateCapability(options.providerId, options.capability);
	const driver = new PrivateClaudeAgentSdkDriver(options);
	return createDurableExternalAgentConnector({
		providerId: options.providerId,
		capability: options.capability,
		capabilityProbe: async () => Result.ok(options.capability),
		store: options.store,
		driver,
		supervision: options.supervision,
		...(options.credential === undefined ? {} : { credential: options.credential }),
		...(options.now === undefined ? {} : { now: options.now }),
		...(options.operationNonce === undefined ? {} : { operationNonce: options.operationNonce }),
	});
}
