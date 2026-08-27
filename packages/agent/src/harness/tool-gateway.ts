import { FoundationError, publicExecutionError, toFoundationError } from "./foundation/errors.ts";
import type { FoundationJsonValue } from "./foundation/event-catalog.ts";
import { canonicalFoundationJson, newFoundationId } from "./foundation/identity.ts";
import {
	type FoundationProviderCapability,
	type FoundationProvider,
	type SandboxOperationProvider,
	type SandboxOperationRequest,
	type ToolExecutionResult,
	type ToolGateway,
	type ToolGatewayRequest,
	validateSandboxOperationRequest,
	validateToolExecutionResult,
	validateToolGatewayRequest,
} from "./foundation/providers.ts";
import { validateWorkerReceipt, type WorkerReceipt } from "./foundation/results.ts";
import type { Result as ResultValue } from "./result.ts";
import { Result } from "./result.ts";

export type ToolGatewayRouteKind = "local" | "mcp" | "sandbox" | "external";

/** Route identity of one tool exposed by one gateway provider. */
export interface ToolGatewayRoute {
	kind: ToolGatewayRouteKind;
	toolName: string;
	/** Optional namespace such as an MCP server id or a sandbox name. */
	namespace?: string;
	providerId: string;
	/** Tool revision frozen on this route. */
	revision: number;
}

/** Provider-neutral adapter registered in a FoundationToolGateway. */
export interface ToolGatewayProvider {
	readonly providerId: string;
	readonly kind: ToolGatewayRouteKind;
	readonly routes: readonly ToolGatewayRoute[];
	capabilities(): Promise<readonly FoundationProviderCapability[]>;
	execute(
		request: ToolGatewayRequest,
		options?: { signal?: AbortSignal },
	): Promise<ResultValue<ToolExecutionResult, FoundationError>>;
	dispose(): Promise<void>;
}

export interface FoundationToolGatewayOptions {
	readonly gatewayId: string;
	readonly providers: readonly ToolGatewayProvider[];
}

/** Read-only route catalog exposed by a composed Foundation gateway. */
export interface ToolGatewayRouteCatalog {
	getRouteCatalog(): readonly ToolGatewayRoute[];
}

/** Composition-owned authorization invoked after route selection and before provider effect. */
export interface ToolGatewayRequestAuthorizer {
	authorize(
		request: ToolGatewayRequest,
		route: ToolGatewayRoute,
		options?: { signal?: AbortSignal },
	): Promise<ResultValue<true, FoundationError>>;
}

export interface FoundationToolGatewayAuthorityOptions {
	readonly gateway: ToolGateway;
	readonly routeCatalog?: readonly ToolGatewayRoute[];
	readonly authorizer?: ToolGatewayRequestAuthorizer;
}

export interface ConsumerToolGatewayFakeOptions {
	readonly providerId?: string;
	readonly capabilities?: readonly FoundationProviderCapability[];
	readonly nowMs?: () => number;
	/** Consumer-facing behavior; it returns provider-neutral execution results, never final receipts. */
	readonly invoke?: (request: ToolGatewayRequest, options: { signal?: AbortSignal }) => Promise<ResultValue<ToolExecutionResult, FoundationError>>;
}

/**
 * Public consumer-shaped gateway fake. It exercises the same request/result
 * boundary as a real consumer and keeps only provider-neutral settlements for
 * restart recovery; it never manufactures ToolReceipt/TaskResult/RunReceipt.
 */
export class ConsumerToolGatewayFake implements ToolGateway, FoundationProvider {
	readonly schemaVersion = 1 as const;
	readonly providerId: string;
	readonly providerClass = "gateway" as const;
	private readonly invoke: NonNullable<ConsumerToolGatewayFakeOptions["invoke"]>;
	private readonly declared: readonly FoundationProviderCapability[];
	private readonly nowMs: () => number;
	private readonly settlements = new Map<string, ToolExecutionResult>();
	private readonly inFlight = new Set<string>();
	private disposed = false;

	constructor(options: ConsumerToolGatewayFakeOptions = {}) {
		this.providerId = options.providerId ?? "consumer-tool-gateway-fake";
		if (this.providerId.length === 0) throw new TypeError("providerId must not be empty");
		this.invoke = options.invoke ?? (async (request) => Result.ok({ schemaVersion: 1, toolCallId: request.toolCallId, toolName: request.toolName, ok: true, sideEffectState: "none" }));
		this.declared = options.capabilities ?? [];
		this.nowMs = options.nowMs ?? Date.now;
	}

	async capabilities(): Promise<readonly FoundationProviderCapability[]> {
		return [{ schemaVersion: 1, id: "consumer_tool_gateway_fake", version: 1 }, ...this.declared];
	}

	async execute(request: ToolGatewayRequest, options: { signal?: AbortSignal } = {}): Promise<ResultValue<ToolExecutionResult, FoundationError>> {
		if (this.disposed) return Result.err(new FoundationError("invalid_identifier", "consumer ToolGateway fake is disposed"));
		const checkedRequest = validateToolGatewayRequest(request);
		if (!checkedRequest.ok) return checkedRequest;
		const value = checkedRequest.value;
		const settle = (result: ToolExecutionResult): ResultValue<ToolExecutionResult, FoundationError> => {
			const checked = validateToolExecutionResult(result);
			if (!checked.ok) return checked;
			this.settlements.set(value.toolCallId, checked.value);
			return Result.ok(checked.value);
		};
		if (options.signal?.aborted) return settle({ schemaVersion: 1, toolCallId: value.toolCallId, toolName: value.toolName, ok: false, sideEffectState: "none", error: publicExecutionError("tool_cancelled", "tool execution was cancelled", { category: "cancelled" }) });
		if (value.deadlineAt !== undefined && this.nowMs() >= value.deadlineAt) return settle({ schemaVersion: 1, toolCallId: value.toolCallId, toolName: value.toolName, ok: false, sideEffectState: "none", error: publicExecutionError("deadline_exceeded", "tool execution deadline was exceeded", { category: "deadline", retryable: false }) });
		this.inFlight.add(value.toolCallId);
		try {
			let result: ResultValue<ToolExecutionResult, FoundationError>;
			try {
				result = await this.invoke(value, options);
			} catch (error) {
				return settle({ schemaVersion: 1, toolCallId: value.toolCallId, toolName: value.toolName, ok: false, sideEffectState: "side_effect_unknown", error: toFoundationError(error, "side_effect_unknown").toPublicExecutionError() });
			}
			if (!result.ok) return settle({ schemaVersion: 1, toolCallId: value.toolCallId, toolName: value.toolName, ok: false, sideEffectState: "side_effect_unknown", error: result.error.toPublicExecutionError() });
			if (options.signal?.aborted) return settle({ schemaVersion: 1, toolCallId: value.toolCallId, toolName: value.toolName, ok: false, sideEffectState: "side_effect_unknown", error: publicExecutionError("tool_cancelled", "tool execution was cancelled after provider invocation", { category: "side_effect_unknown" }) });
			if (value.deadlineAt !== undefined && this.nowMs() >= value.deadlineAt) return settle({ schemaVersion: 1, toolCallId: value.toolCallId, toolName: value.toolName, ok: false, sideEffectState: "side_effect_unknown", error: publicExecutionError("deadline_exceeded", "tool execution deadline was exceeded after provider invocation", { category: "side_effect_unknown", retryable: false }) });
			if (result.value.toolCallId !== value.toolCallId || result.value.toolName !== value.toolName) return settle({ schemaVersion: 1, toolCallId: value.toolCallId, toolName: value.toolName, ok: false, sideEffectState: "side_effect_unknown", error: publicExecutionError("invalid_correlation", "consumer fake returned a result for another tool call", { category: "parameter", retryable: false }) });
			return settle(result.value);
		} finally {
			this.inFlight.delete(value.toolCallId);
		}
	}

	/** Return provider-neutral settlements that a restarted consumer can reconcile. */
	recoverSettlements(toolCallId?: string): readonly ToolExecutionResult[] {
		if (toolCallId !== undefined) {
			const settlement = this.settlements.get(toolCallId);
			return settlement === undefined ? [] : [settlement];
		}
		return [...this.settlements.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, settlement]) => settlement);
	}

	async dispose(): Promise<void> {
		this.disposed = true;
		this.inFlight.clear();
	}
}

export function createConsumerToolGatewayFake(options: ConsumerToolGatewayFakeOptions = {}): ConsumerToolGatewayFake {
	return new ConsumerToolGatewayFake(options);
}

/**
 * Provider-neutral ToolGateway consuming the T1 contracts. It validates every
 * request with the frozen exact-shape schema, routes by `(namespace, toolName)`
 * and never falls through to a broader default when no route matches.
 */
export class FoundationToolGateway implements ToolGateway, FoundationProvider, ToolGatewayRouteCatalog {
	readonly schemaVersion = 1 as const;
	readonly providerId: string;
	readonly providerClass = "gateway" as const;

	private readonly routes: readonly ToolGatewayRoute[];
	private readonly providers: readonly ToolGatewayProvider[];

	constructor(options: FoundationToolGatewayOptions) {
		if (options.gatewayId.length === 0) throw new TypeError("gatewayId must not be empty");
		this.providerId = options.gatewayId;
		this.providers = Object.freeze([...options.providers]);
		this.routes = Object.freeze(options.providers.flatMap((provider) => provider.routes).map((route) => Object.freeze({ ...route })));
	}

	async capabilities(): Promise<readonly FoundationProviderCapability[]> {
		const gateway: FoundationProviderCapability = { schemaVersion: 1, id: "tool_gateway", version: 1 };
		const providerCapabilities = await Promise.all(this.providers.map((provider) => provider.capabilities()));
		return [gateway, ...providerCapabilities.flat()];
	}

	getRouteCatalog(): readonly ToolGatewayRoute[] {
		return this.routes;
	}

	async execute(
		request: ToolGatewayRequest,
		options: { signal?: AbortSignal } = {},
	): Promise<ResultValue<ToolExecutionResult, FoundationError>> {
		const checked = validateToolGatewayRequest(request);
		if (!checked.ok) return checked;
		const value = checked.value;
		const namespace = value.namespace ?? "";
		const matches = this.routes.filter(
			(route) => (route.namespace ?? "") === namespace && route.toolName === value.toolName,
		);
		if (matches.length === 0) {
			return Result.err(
				new FoundationError("invalid_identifier", `no tool route matches ${JSON.stringify(namespace)}/${value.toolName}`),
			);
		}
		if (matches.length > 1) {
			return Result.err(
				new FoundationError("invalid_identifier", `tool route ${JSON.stringify(namespace)}/${value.toolName} is ambiguous`),
			);
		}
		const route = matches[0]!;
		const provider = this.providers.find((candidate) => candidate.providerId === route.providerId);
		if (provider === undefined) {
			return Result.err(new FoundationError("invalid_identifier", "route references an unknown provider", { details: { providerId: route.providerId } }));
		}
		if (value.context.providerId !== undefined && value.context.providerId !== route.providerId) {
			return Result.err(new FoundationError("invalid_identifier", "tool request provider identity does not match its route", { details: { expected: route.providerId, actual: value.context.providerId } }));
		}
		return provider.execute({
			...value,
			context: { ...value.context, providerId: route.providerId },
		}, options);
	}

	async dispose(): Promise<void> {
		await Promise.all(this.providers.map((provider) => provider.dispose()));
	}
}

/**
 * Foundation authority used by composition roots. It owns route selection and
 * invokes the composition authorizer before delegating to the underlying
 * gateway, so provider effects cannot occur before binding/policy checks.
 */
export class FoundationToolGatewayAuthority implements ToolGateway, FoundationProvider, ToolGatewayRouteCatalog {
	readonly schemaVersion = 1 as const;
	readonly providerId: string;
	readonly providerClass = "gateway" as const;

	private readonly gateway: ToolGateway;
	private readonly routes: readonly ToolGatewayRoute[];
	private authorizer: ToolGatewayRequestAuthorizer | undefined;

	constructor(options: FoundationToolGatewayAuthorityOptions) {
		this.gateway = options.gateway;
		this.providerId = options.gateway.providerId;
		this.authorizer = options.authorizer;
		const catalog = options.gateway as ToolGateway & Partial<ToolGatewayRouteCatalog>;
		const routes = options.routeCatalog ?? (typeof catalog.getRouteCatalog === "function" ? catalog.getRouteCatalog() : []);
		this.routes = Object.freeze(routes.map((route) => Object.freeze({ ...route })));
	}

	setAuthorizer(authorizer: ToolGatewayRequestAuthorizer | undefined): void {
		this.authorizer = authorizer;
	}

	getRouteCatalog(): readonly ToolGatewayRoute[] {
		return this.routes;
	}

	async capabilities(): Promise<readonly FoundationProviderCapability[]> {
		return this.gateway.capabilities();
	}

	async execute(
		request: ToolGatewayRequest,
		options: { signal?: AbortSignal } = {},
	): Promise<ResultValue<ToolExecutionResult, FoundationError>> {
		const checked = validateToolGatewayRequest(request);
		if (!checked.ok) return checked;
		const value = checked.value;
		const namespace = value.namespace ?? "";
		const matches = this.routes.filter(
			(route) => (route.namespace ?? "") === namespace && route.toolName === value.toolName,
		);
		if (matches.length !== 1) {
			return Result.err(
				new FoundationError(
					"invalid_identifier",
					matches.length === 0
						? `no tool route matches ${JSON.stringify(namespace)}/${value.toolName}`
						: `tool route ${JSON.stringify(namespace)}/${value.toolName} is ambiguous`,
				),
			);
		}
		const route = matches[0]!;
		if (value.context.providerId !== undefined && value.context.providerId !== route.providerId) {
			return Result.err(
				new FoundationError("invalid_identifier", "tool request provider identity does not match its route"),
			);
		}
		const authorizer = this.authorizer;
		if (authorizer === undefined) {
			return Result.err(
				new FoundationError("external_tool_route_denied", "External connector Tool Gateway authority is not ready"),
			);
		}
		let authorized: ResultValue<true, FoundationError>;
		try {
			authorized = await authorizer.authorize(value, route, options);
		} catch {
			return Result.err(
				new FoundationError("external_tool_route_denied", "External connector Tool Gateway policy denied the request"),
			);
		}
		if (!authorized.ok) return authorized;
		return this.gateway.execute({ ...value, context: { ...value.context, providerId: route.providerId } }, options);
	}

	async dispose(): Promise<void> {
		await this.gateway.dispose();
	}
}

export function createFoundationToolGatewayAuthority(
	options: FoundationToolGatewayAuthorityOptions,
): FoundationToolGatewayAuthority {
	return new FoundationToolGatewayAuthority(options);
}

export function createFoundationToolGateway(options: FoundationToolGatewayOptions): FoundationToolGateway {
	return new FoundationToolGateway(options);
}

export interface LocalToolGatewayProviderOptions {
	readonly providerId: string;
	readonly routes: readonly ToolGatewayRoute[];
	readonly invoke: (
		request: ToolGatewayRequest,
		options?: { signal?: AbortSignal },
	) => Promise<ResultValue<ToolExecutionResult, FoundationError>>;
	readonly capabilities?: readonly FoundationProviderCapability[];
}

/** Local tool provider: the host executes the tool and returns a validated T1 result. */
export function createLocalToolGatewayProvider(options: LocalToolGatewayProviderOptions): ToolGatewayProvider {
	const declared = options.capabilities ?? [];
	return {
		providerId: options.providerId,
		kind: "local",
		routes: options.routes,
		async capabilities(): Promise<readonly FoundationProviderCapability[]> {
			return declared;
		},
		async execute(
			request: ToolGatewayRequest,
			gatewayOptions: { signal?: AbortSignal } = {},
		): Promise<ResultValue<ToolExecutionResult, FoundationError>> {
			const result = await options.invoke(request, gatewayOptions);
			if (!result.ok) return result;
			const checked = validateToolExecutionResult(result.value);
			return checked.ok ? checked : Result.err(checked.error);
		},
		async dispose(): Promise<void> {},
	};
}

/**
 * Sandbox translator consumed by {@link createSandboxOperationToolGatewayProviderV1}.
 * It maps a T1 ToolGateway request onto a T1 SandboxOperationRequest; the
 * provider stays opaque about how the operation is performed.
 */
export interface SandboxOperationTranslator {
	translate(request: ToolGatewayRequest): ResultValue<SandboxOperationRequest, FoundationError>;
}

export function createDefaultSandboxOperationTranslator(
	operationIdGenerator: (prefix: string) => string = newFoundationId,
): SandboxOperationTranslator {
	return {
		translate(request: ToolGatewayRequest): ResultValue<SandboxOperationRequest, FoundationError> {
			const args = recordOf(request.originalArguments);
			const operationId = request.context.operationId ?? operationIdGenerator("operation");
			const credentialTargets: readonly string[] | undefined = stringArray(args.credentialTargets);
			return Result.ok({
				schemaVersion: 1,
				operationId,
				payload: request.originalArguments,
				toolCallId: request.toolCallId,
				toolName: request.toolName,
				...(request.namespace === undefined ? {} : { namespace: request.namespace }),
				...(request.context.providerId === undefined ? {} : { providerId: request.context.providerId }),
				bindingId: request.context.bindingId,
				bindingEpochId: request.context.bindingEpochId,
				...(request.context.agentInstanceId === undefined ? {} : { agentInstanceId: request.context.agentInstanceId }),
				...(request.context.taskId === undefined ? {} : { taskId: request.context.taskId }),
				...(request.context.dispatchId === undefined ? {} : { dispatchId: request.context.dispatchId }),
				...(request.context.attemptId === undefined ? {} : { attemptId: request.context.attemptId }),
				...(credentialTargets === undefined ? {} : { credentialTargets }),
				...(typeof args.workspace === "string" && args.workspace.length > 0 ? { workspace: args.workspace } : {}),
				...(request.deadlineAt === undefined ? {} : { deadlineAt: request.deadlineAt }),
			});
		},
	};
}

export interface SandboxOperationToolGatewayProviderOptions {
	readonly providerId: string;
	readonly routes: readonly ToolGatewayRoute[];
	readonly sandbox: SandboxOperationProvider;
	readonly translator?: SandboxOperationTranslator;
	/** Records the invocation payload per operation id so a real line-11 Worker can resolve it later. */
	readonly onOperationPayload?: (operationId: string, args: FoundationJsonValue) => void;
	readonly capabilities?: readonly FoundationProviderCapability[];
}

/**
 * Sandbox tool provider consuming the frozen {@link SandboxOperationProvider}
 * contract. The WorkerReceipt is exact-shape validated and mapped onto the T1
 * ToolExecutionResult; the gateway only ever sees provider-neutral values.
 */
export function createSandboxOperationToolGatewayProvider(
	options: SandboxOperationToolGatewayProviderOptions,
): ToolGatewayProvider {
	const sandbox = options.sandbox;
	const translator = options.translator ?? createDefaultSandboxOperationTranslator();
	const inFlight = new Map<string, { operationId: string; args: FoundationJsonValue }>();
	const declared = options.capabilities ?? [];
	return {
		providerId: options.providerId,
		kind: "sandbox",
		routes: options.routes,
		async capabilities(): Promise<readonly FoundationProviderCapability[]> {
			return declared;
		},
		async execute(
			request: ToolGatewayRequest,
			gatewayOptions: { signal?: AbortSignal } = {},
		): Promise<ResultValue<ToolExecutionResult, FoundationError>> {
			const translated = translator.translate(request);
			if (!translated.ok) return translated;
			const operation = translated.value;
			if (!isSandboxOperationRequestValid(operation)) {
				return Result.err(new FoundationError("foundation_schema_invalid_shape", "sandbox operation request failed exact-shape validation"));
			}
			const operationPayload = operation.payload;
			if (operation.providerId !== undefined && operation.providerId !== options.providerId || operation.taskId !== request.context.taskId || operation.toolCallId !== request.toolCallId || operation.toolName !== request.toolName || operation.namespace !== request.namespace || operation.bindingId !== request.context.bindingId || operation.bindingEpochId !== request.context.bindingEpochId) {
				return Result.err(new FoundationError("invalid_identifier", "sandbox operation identity does not match the gateway request"));
			}
			if (request.context.operationId !== undefined && operation.operationId !== request.context.operationId) return Result.err(new FoundationError("invalid_identifier", "sandbox operation id does not match the gateway request"));
			if (request.context.agentInstanceId !== undefined && operation.agentInstanceId !== request.context.agentInstanceId) return Result.err(new FoundationError("invalid_identifier", "sandbox operation agent identity does not match the gateway request"));
			if (request.context.attemptId !== undefined && operation.attemptId !== request.context.attemptId) return Result.err(new FoundationError("invalid_identifier", "sandbox operation attempt identity does not match the gateway request"));
			if (operationPayload === undefined || canonicalFoundationJson(operationPayload) !== canonicalFoundationJson(request.originalArguments)) {
				return Result.err(new FoundationError("foundation_schema_invalid_shape", "sandbox operation payload does not match the gateway request"));
			}
			if (request.context.dispatchId !== undefined && operation.dispatchId !== request.context.dispatchId) {
				return Result.err(new FoundationError("invalid_identifier", "sandbox operation dispatch identity does not match the gateway request"));
			}
			const tracked = { operationId: operation.operationId, args: request.originalArguments };
			inFlight.set(operation.operationId, tracked);
			options.onOperationPayload?.(operation.operationId, request.originalArguments);
			try {
				const started = await sandbox.start(operation, { signal: gatewayOptions.signal });
				if (!started.ok) return started;
				const receiptChecked = validateWorkerReceipt(started.value);
				if (!receiptChecked.ok) return Result.err(new FoundationError("worker_receipt_invalid_producer", "sandbox provider returned an invalid WorkerReceipt", { details: { operationId: operation.operationId } }));
				const receipt: WorkerReceipt = receiptChecked.value;
				const result: ToolExecutionResult = {
					schemaVersion: 1,
					toolCallId: request.toolCallId,
					toolName: request.toolName,
					ok: receipt.status === "succeeded",
					sideEffectState: receipt.sideEffectState,
					toolReceiptRef: receipt.workerReceiptId,
					...(receipt.artifacts === undefined ? {} : { artifacts: [...receipt.artifacts] }),
					...(receipt.error === undefined ? {} : { error: receipt.error }),
				};
				const checked = validateToolExecutionResult(result);
				return checked.ok ? checked : Result.err(checked.error);
			} finally {
				inFlight.delete(operation.operationId);
			}
		},
		async dispose(): Promise<void> {
			const operations = [...inFlight.values()];
			inFlight.clear();
			for (const tracked of operations) {
				await sandbox.cancel(tracked.operationId);
			}
			await sandbox.dispose();
		},
	};
}

function recordOf(value: FoundationJsonValue): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringArray(value: unknown): readonly string[] | undefined {
	return Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0)
		? (value as string[])
		: undefined;
}

function isSandboxOperationRequestValid(value: SandboxOperationRequest): boolean {
	const checked = validateSandboxOperationRequest(value);
	return checked.ok;
}
