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
import type { ResultValue } from "./result.ts";
import { Result } from "./result.ts";

export type ToolGatewayRouteKind = "local" | "mcp" | "sandbox" | "external";
const TOOL_GATEWAY_ROUTE_KINDS: readonly ToolGatewayRouteKind[] = ["local", "mcp", "sandbox", "external"];

export const TOOL_GATEWAY_ROUTE_RESOURCES = Object.freeze([
	"filesystem.read",
	"filesystem.write",
	"filesystem.find",
	"filesystem.grep",
	"process.spawn",
	"network.connect",
] as const);
export type ToolGatewayRouteResource = (typeof TOOL_GATEWAY_ROUTE_RESOURCES)[number];

export const TOOL_GATEWAY_ROUTE_EFFECTS = Object.freeze([
	"read",
	"write",
	"create",
	"delete",
	"move",
	"command",
	"network",
	"commit",
	"push",
	"merge",
] as const);
export type ToolGatewayRouteEffect = (typeof TOOL_GATEWAY_ROUTE_EFFECTS)[number];

/** Policy identity frozen with a route; provider names never determine effects. */
export interface ToolGatewayRouteOperation {
	readonly resource: ToolGatewayRouteResource;
	/** Complete potential effect set for one invocation of this route. */
	readonly effects: readonly ToolGatewayRouteEffect[];
	/** Required for unstructured operations whose effects cannot be narrowed per invocation. */
	readonly requiresSandbox?: true;
}

/** Route identity of one tool exposed by one gateway provider. */
export interface ToolGatewayRoute {
	readonly kind: ToolGatewayRouteKind;
	readonly toolName: string;
	/** Optional namespace such as an MCP server id or a sandbox name. */
	readonly namespace?: string;
	readonly providerId: string;
	/** Tool revision frozen on this route. */
	readonly revision: number;
	readonly operation: ToolGatewayRouteOperation;
}

/** Immutable route value published by a Tool Gateway catalog. */
export type ToolGatewayRouteSnapshot = ToolGatewayRoute;

/** Provider-neutral adapter registered in a FoundationToolGateway. */
export interface ToolGatewayProvider {
	readonly providerId: string;
	readonly kind: ToolGatewayRouteKind;
	/** Provider identity revision. Every provider route must carry this revision. */
	readonly revision: number;
	readonly routes: readonly ToolGatewayRoute[];
	readonly getInFlightCount?: () => number;
	cancel?(toolCallId: string): Promise<ResultValue<void, FoundationError>>;
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

/** Frozen catalog metadata; provider implementations remain private to the gateway. */
export interface ToolGatewayProviderSnapshot {
	readonly providerId: string;
	readonly kind: ToolGatewayRouteKind;
	readonly revision: number;
}

/** Immutable catalog published by a Foundation Tool Gateway. */
export interface ToolGatewayCatalogSnapshot {
	readonly gatewayId: string;
	readonly providers: readonly ToolGatewayProviderSnapshot[];
	readonly routes: readonly ToolGatewayRouteSnapshot[];
}

interface ToolGatewayCatalogState {
	readonly snapshot: ToolGatewayCatalogSnapshot;
	readonly providers: readonly ToolGatewayProvider[];
	readonly providersById: ReadonlyMap<string, ToolGatewayProvider>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function catalogInvalid(message: string): FoundationError {
	return new FoundationError("tool_gateway_catalog_invalid", message);
}

function isToolGatewayRouteKind(value: unknown): value is ToolGatewayRouteKind {
	return typeof value === "string" && TOOL_GATEWAY_ROUTE_KINDS.includes(value as ToolGatewayRouteKind);
}

function isPositiveRevision(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

const TOOL_GATEWAY_ROUTE_KEYS = new Set(["kind", "toolName", "namespace", "providerId", "revision", "operation"]);
const TOOL_GATEWAY_ROUTE_OPERATION_KEYS = new Set(["resource", "effects", "requiresSandbox"]);
const FILESYSTEM_WRITE_EFFECTS: ReadonlySet<ToolGatewayRouteEffect> = new Set(["write", "create", "delete", "move"]);
const NETWORK_EFFECTS: ReadonlySet<ToolGatewayRouteEffect> = new Set(["network", "push"]);
const RAW_COMMAND_EFFECTS: ReadonlySet<ToolGatewayRouteEffect> = new Set([
	"write",
	"create",
	"delete",
	"move",
	"command",
	"network",
	"commit",
	"push",
	"merge",
]);

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
	return Object.keys(value).every((key) => allowed.has(key));
}

function isToolGatewayRouteEffect(value: unknown): value is ToolGatewayRouteEffect {
	return typeof value === "string" && (TOOL_GATEWAY_ROUTE_EFFECTS as readonly string[]).includes(value);
}

/** Runtime guard used at every catalog boundary before a route becomes visible. */
export function isToolGatewayRoute(value: unknown): value is ToolGatewayRoute {
	if (!isRecord(value) || !hasOnlyKeys(value, TOOL_GATEWAY_ROUTE_KEYS) || !Object.hasOwn(value, "operation")) return false;
	const operation = value.operation;
	if (
		!isToolGatewayRouteKind(value.kind) ||
		typeof value.toolName !== "string" ||
		value.toolName.length === 0 ||
		(value.namespace !== undefined && (typeof value.namespace !== "string" || value.namespace.length === 0)) ||
		typeof value.providerId !== "string" ||
		value.providerId.length === 0 ||
		!isPositiveRevision(value.revision) ||
		!isRecord(operation) ||
		!hasOnlyKeys(operation, TOOL_GATEWAY_ROUTE_OPERATION_KEYS) ||
		!(TOOL_GATEWAY_ROUTE_RESOURCES as readonly unknown[]).includes(operation.resource) ||
		!Array.isArray(operation.effects) ||
		operation.effects.length === 0 ||
		!operation.effects.every(isToolGatewayRouteEffect) ||
		new Set(operation.effects).size !== operation.effects.length ||
		(operation.requiresSandbox !== undefined && operation.requiresSandbox !== true)
	) return false;
	const effects = operation.effects as readonly ToolGatewayRouteEffect[];
	switch (operation.resource) {
		case "filesystem.read":
		case "filesystem.find":
		case "filesystem.grep":
			return operation.requiresSandbox === undefined && effects.length === 1 && effects[0] === "read";
		case "filesystem.write":
			return operation.requiresSandbox === undefined && effects.every((effect) => FILESYSTEM_WRITE_EFFECTS.has(effect));
		case "process.spawn":
			return operation.requiresSandbox === true && effects.length === RAW_COMMAND_EFFECTS.size && effects.every((effect) => RAW_COMMAND_EFFECTS.has(effect));
		case "network.connect":
			return operation.requiresSandbox === undefined && effects.includes("network") && effects.every((effect) => NETWORK_EFFECTS.has(effect));
		default:
			return false;
	}
}

function routeKey(route: Pick<ToolGatewayRoute, "namespace" | "toolName">): string {
	return canonicalFoundationJson([route.namespace ?? "", route.toolName]);
}

function freezeRouteSnapshots(routes: readonly ToolGatewayRoute[]): readonly ToolGatewayRouteSnapshot[] {
	return Object.freeze(routes.map((route) => Object.freeze({
		...route,
		operation: Object.freeze({ ...route.operation, effects: Object.freeze([...route.operation.effects]) }),
	})));
}

/** Defensively clone and freeze a catalog before it is made visible to consumers. */
export function freezeToolGatewayCatalog(snapshot: ToolGatewayCatalogSnapshot): ToolGatewayCatalogSnapshot {
	return Object.freeze({
		gatewayId: snapshot.gatewayId,
		providers: Object.freeze(snapshot.providers.map((provider) => Object.freeze({ ...provider }))),
		routes: freezeRouteSnapshots(snapshot.routes),
	});
}

function buildToolGatewayCatalogState(options: FoundationToolGatewayOptions): ResultValue<ToolGatewayCatalogState, FoundationError> {
	try {
		return buildToolGatewayCatalogStateUnsafe(options);
	} catch {
		return Result.err(catalogInvalid("Tool Gateway catalog is invalid"));
	}
}

function buildToolGatewayCatalogStateUnsafe(options: FoundationToolGatewayOptions): ResultValue<ToolGatewayCatalogState, FoundationError> {
	if (!isRecord(options) || typeof options.gatewayId !== "string" || options.gatewayId.length === 0 || !Array.isArray(options.providers)) {
		return Result.err(catalogInvalid("Tool Gateway catalog options are invalid"));
	}
	const providers = options.providers;
	const providerIds = new Set<string>();
	const providersById = new Map<string, ToolGatewayProvider>();
	const providerSnapshots: ToolGatewayProviderSnapshot[] = [];
	for (const candidate of providers) {
		if (!isRecord(candidate)) return Result.err(catalogInvalid("Tool Gateway provider catalog is invalid"));
		const provider = candidate as unknown as ToolGatewayProvider;
		if (
			typeof provider.providerId !== "string" ||
			provider.providerId.length === 0 ||
			providerIds.has(provider.providerId) ||
			!isToolGatewayRouteKind(provider.kind) ||
			!isPositiveRevision(provider.revision) ||
			!Array.isArray(provider.routes) ||
			typeof provider.capabilities !== "function" ||
			typeof provider.execute !== "function" ||
			typeof provider.dispose !== "function" ||
			(provider.getInFlightCount !== undefined && typeof provider.getInFlightCount !== "function") ||
			(provider.cancel !== undefined && typeof provider.cancel !== "function")
		) {
			return Result.err(catalogInvalid("Tool Gateway provider catalog is invalid"));
		}
		providerIds.add(provider.providerId);
		providersById.set(provider.providerId, provider);
		providerSnapshots.push({ providerId: provider.providerId, kind: provider.kind, revision: provider.revision });
	}

	const routes: ToolGatewayRoute[] = [];
	const routeKeys = new Set<string>();
	for (const candidate of providers) {
		const provider = candidate as unknown as ToolGatewayProvider;
		for (const routeCandidate of provider.routes) {
			if (!isToolGatewayRoute(routeCandidate)) return Result.err(catalogInvalid("Tool Gateway route catalog is invalid"));
			const route = routeCandidate as ToolGatewayRoute;
			if (
				route.providerId !== provider.providerId ||
				route.kind !== provider.kind ||
				route.revision !== provider.revision ||
				!providerIds.has(route.providerId)
			) {
				return Result.err(catalogInvalid("Tool Gateway route catalog is invalid"));
			}
			let key: string;
			try {
				key = routeKey(route);
			} catch {
				return Result.err(catalogInvalid("Tool Gateway route catalog is invalid"));
			}
			if (routeKeys.has(key)) return Result.err(catalogInvalid("Tool Gateway route catalog is invalid"));
			routeKeys.add(key);
			routes.push(route);
		}
	}

	const snapshot = freezeToolGatewayCatalog({
		gatewayId: options.gatewayId,
		providers: providerSnapshots,
		routes,
	});
	return Result.ok({
		snapshot,
		providers: Object.freeze([...providers]),
		providersById,
	});
}

/** Validate and freeze a provider-backed catalog without publishing it. */
export function validateToolGatewayCatalog(options: FoundationToolGatewayOptions): ResultValue<ToolGatewayCatalogSnapshot, FoundationError> {
	const state = buildToolGatewayCatalogState(options);
	return state.ok ? Result.ok(state.value.snapshot) : state;
}

/** Build a candidate catalog. Callers may publish the returned frozen value atomically. */
export function buildToolGatewayCatalog(options: FoundationToolGatewayOptions): ResultValue<ToolGatewayCatalogSnapshot, FoundationError> {
	return validateToolGatewayCatalog(options);
}

/** Build a catalog or fail startup before a gateway can publish any state. */
export function buildToolGatewayCatalogOrThrow(options: FoundationToolGatewayOptions): ToolGatewayCatalogSnapshot {
	const built = validateToolGatewayCatalog(options);
	if (!built.ok) throw built.error;
	return built.value;
}

/** Exact `(namespace, toolName)` lookup against a frozen route snapshot. */
export function lookupToolGatewayRoute(
	routes: readonly ToolGatewayRouteSnapshot[],
	toolName: string,
	namespace?: string,
): ResultValue<ToolGatewayRouteSnapshot, FoundationError> {
	if (typeof toolName !== "string" || toolName.length === 0 || (namespace !== undefined && (typeof namespace !== "string" || namespace.length === 0))) {
		return Result.err(new FoundationError("invalid_identifier", "Tool Gateway route identity is invalid"));
	}
	const key = canonicalFoundationJson([namespace ?? "", toolName]);
	const matches = routes.filter((route) => routeKey(route) === key);
	if (matches.length === 0) {
		return Result.err(new FoundationError("invalid_identifier", `no tool route matches ${JSON.stringify(namespace ?? "")}/${toolName}`));
	}
	if (matches.length > 1) {
		return Result.err(new FoundationError("invalid_identifier", `tool route ${JSON.stringify(namespace ?? "")}/${toolName} is ambiguous`));
	}
	return Result.ok(matches[0]!);
}

function lookupToolGatewayRouteSafely(
	routes: readonly ToolGatewayRouteSnapshot[],
	toolName: string,
	namespace?: string,
): ResultValue<ToolGatewayRouteSnapshot, FoundationError> {
	try {
		return lookupToolGatewayRoute(routes, toolName, namespace);
	} catch {
		return Result.err(catalogInvalid("Tool Gateway route catalog is invalid"));
	}
}

function sameToolGatewayRoute(left: ToolGatewayRouteSnapshot, right: ToolGatewayRouteSnapshot): boolean {
	try {
		return canonicalFoundationJson([
			left.kind,
			left.namespace ?? "",
			left.toolName,
			left.providerId,
			left.revision,
			left.operation.resource,
			left.operation.effects,
			left.operation.requiresSandbox === true,
		]) === canonicalFoundationJson([
			right.kind,
			right.namespace ?? "",
			right.toolName,
			right.providerId,
			right.revision,
			right.operation.resource,
			right.operation.effects,
			right.operation.requiresSandbox === true,
		]);
	} catch {
		return false;
	}
}

export interface FoundationToolGatewayReloadOptions {
	readonly gatewayId?: string;
	readonly providers: readonly ToolGatewayProvider[];
}

/** Atomic catalog publisher used by startup and reload paths. */
export class ToolGatewayCatalogPublisher {
	private state: ToolGatewayCatalogState;

	constructor(options: FoundationToolGatewayOptions) {
		const state = buildToolGatewayCatalogState(options);
		if (!state.ok) throw state.error;
		this.state = state.value;
	}

	getSnapshot(): ToolGatewayCatalogSnapshot {
		return this.state.snapshot;
	}

	getProviders(): readonly ToolGatewayProvider[] {
		return this.state.providers;
	}

	getProvider(providerId: string): ToolGatewayProvider | undefined {
		return this.state.providersById.get(providerId);
	}

	publish(options: FoundationToolGatewayOptions): ResultValue<ToolGatewayCatalogSnapshot, FoundationError> {
		const candidate = buildToolGatewayCatalogState(options);
		if (!candidate.ok) return candidate;
		this.state = candidate.value;
		return Result.ok(this.state.snapshot);
	}

	reload(options: FoundationToolGatewayReloadOptions): ResultValue<ToolGatewayCatalogSnapshot, FoundationError> {
		if (!isRecord(options) || !Array.isArray(options.providers)) return Result.err(catalogInvalid("Tool Gateway reload options are invalid"));
		if (options.gatewayId !== undefined && options.gatewayId !== this.state.snapshot.gatewayId) return Result.err(catalogInvalid("Tool Gateway gateway identity cannot change during reload"));
		return this.publish({ gatewayId: this.state.snapshot.gatewayId, providers: options.providers });
	}
}

/** Read-only route catalog exposed by a composed Foundation gateway. */
export interface ToolGatewayRouteCatalog {
	getRouteCatalog(): readonly ToolGatewayRouteSnapshot[];
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
		const requestResult = validateToolGatewayRequest(request);
		if (!requestResult.ok) return requestResult;
		const value = requestResult.value;
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

	getInFlightCount(): number {
		return this.inFlight.size;
	}
}

export function createConsumerToolGatewayFake(options: ConsumerToolGatewayFakeOptions = {}): ConsumerToolGatewayFake {
	return new ConsumerToolGatewayFake(options);
}

interface LinkedAbortController {
	readonly controller: AbortController;
	readonly signal: AbortSignal;
	detach(): void;
}

function linkAbortSignal(parent: AbortSignal | undefined): LinkedAbortController {
	const controller = new AbortController();
	if (parent === undefined) return { controller, signal: controller.signal, detach(): void {} };
	const abort = (): void => controller.abort(parent.reason);
	if (parent.aborted) abort();
	else parent.addEventListener("abort", abort, { once: true });
	return {
		controller,
		signal: controller.signal,
		detach(): void {
			parent.removeEventListener("abort", abort);
		},
	};
}

/**
 * Provider-neutral ToolGateway consuming the Foundation contracts. It validates every
 * request with the frozen exact-shape schema, routes by `(namespace, toolName)`
 * and never falls through to a broader default when no route matches.
 */
export class FoundationToolGateway implements ToolGateway, FoundationProvider, ToolGatewayRouteCatalog {
	readonly schemaVersion = 1 as const;
	readonly providerId: string;
	readonly providerClass = "gateway" as const;

	private readonly publisher: ToolGatewayCatalogPublisher;
	private readonly inFlight = new Map<symbol, { readonly toolCallId: string; readonly controller: AbortController; readonly provider: ToolGatewayProvider }>();
	private readonly retiredProviders = new Set<ToolGatewayProvider>();
	private disposed = false;
	private disposePromise: Promise<void> | undefined;

	constructor(options: FoundationToolGatewayOptions) {
		this.publisher = new ToolGatewayCatalogPublisher(options);
		this.providerId = this.publisher.getSnapshot().gatewayId;
	}

	async capabilities(): Promise<readonly FoundationProviderCapability[]> {
		const gateway: FoundationProviderCapability = { schemaVersion: 1, id: "tool_gateway", version: 1 };
		const providerCapabilities = await Promise.all(this.publisher.getProviders().map((provider) => provider.capabilities()));
		return [gateway, ...providerCapabilities.flat()];
	}

	getCatalogSnapshot(): ToolGatewayCatalogSnapshot {
		return this.publisher.getSnapshot();
	}

	getRouteCatalog(): readonly ToolGatewayRouteSnapshot[] {
		return this.publisher.getSnapshot().routes;
	}

	getInFlightCount(): number {
		return this.inFlight.size;
	}

	reload(options: FoundationToolGatewayReloadOptions): ResultValue<ToolGatewayCatalogSnapshot, FoundationError> {
		if (this.disposed) return Result.err(new FoundationError("invalid_identifier", "Tool Gateway is disposed"));
		const previousProviders = this.publisher.getProviders();
		const reloaded = this.publisher.reload(options);
		if (!reloaded.ok) return reloaded;
		const activeProviders = new Set(this.publisher.getProviders());
		for (const provider of previousProviders) {
			if (activeProviders.has(provider)) this.retiredProviders.delete(provider);
			else this.retiredProviders.add(provider);
		}
		return reloaded;
	}

	async cancel(toolCallId: string): Promise<ResultValue<void, FoundationError>> {
		const matching = [...this.inFlight.entries()].filter(([, tracked]) => tracked.toolCallId === toolCallId);
		if (matching.length === 0) return Result.err(new FoundationError("invalid_identifier", "tool call is not in flight"));
		const providers = new Set<ToolGatewayProvider>();
		for (const [token, tracked] of matching) {
			tracked.controller.abort();
			this.inFlight.delete(token);
			providers.add(tracked.provider);
		}
		const cancellations = await Promise.allSettled([...providers].map(async (provider) => provider.cancel?.(toolCallId)));
		const failure = cancellations.find(
			(result) => result.status === "rejected" || (result.status === "fulfilled" && result.value !== undefined && !result.value.ok),
		);
		if (failure !== undefined) return Result.err(new FoundationError("side_effect_unknown", "Tool Gateway cancellation could not be confirmed"));
		return Result.ok(undefined);
	}

	async execute(
		request: ToolGatewayRequest,
		options: { signal?: AbortSignal } = {},
	): Promise<ResultValue<ToolExecutionResult, FoundationError>> {
		const checked = validateToolGatewayRequest(request);
		if (!checked.ok) return checked;
		if (this.disposed) return Result.err(new FoundationError("invalid_identifier", "Tool Gateway is disposed"));
		const value = checked.value;
		const routeResult = lookupToolGatewayRoute(this.publisher.getSnapshot().routes, value.toolName, value.namespace);
		if (!routeResult.ok) return routeResult;
		const route = routeResult.value;
		const provider = this.publisher.getProvider(route.providerId);
		if (provider === undefined) {
			return Result.err(new FoundationError("invalid_identifier", "route references an unknown provider", { details: { providerId: route.providerId } }));
		}
		if (provider.providerId !== route.providerId || provider.kind !== route.kind || provider.revision !== route.revision) {
			return Result.err(new FoundationError("tool_gateway_catalog_invalid", "Tool Gateway route/provider revision identity does not match"));
		}
		if (value.context.providerId !== undefined && value.context.providerId !== route.providerId) {
			return Result.err(new FoundationError("invalid_identifier", "tool request provider identity does not match its route", { details: { expected: route.providerId, actual: value.context.providerId } }));
		}
		const linked = linkAbortSignal(options.signal);
		const token = Symbol(value.toolCallId);
		this.inFlight.set(token, { toolCallId: value.toolCallId, controller: linked.controller, provider });
		try {
			return await provider.execute({
				...value,
				context: { ...value.context, providerId: route.providerId },
			}, { signal: linked.signal });
		} finally {
			linked.detach();
			this.inFlight.delete(token);
		}
	}

	async dispose(): Promise<void> {
		if (this.disposePromise !== undefined) return this.disposePromise;
		this.disposed = true;
		for (const tracked of this.inFlight.values()) tracked.controller.abort();
		this.inFlight.clear();
		this.disposePromise = (async (): Promise<void> => {
			const providers = new Set([...this.publisher.getProviders(), ...this.retiredProviders]);
			const results = await Promise.allSettled([...providers].map(async (provider) => provider.dispose()));
			if (results.some((result) => result.status === "rejected")) {
				throw new FoundationError("side_effect_unknown", "Tool Gateway provider cleanup could not be confirmed");
			}
		})();
		return this.disposePromise;
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
	private readonly readRouteCatalog: () => readonly ToolGatewayRoute[];
	private authorizer: ToolGatewayRequestAuthorizer | undefined;

	constructor(options: FoundationToolGatewayAuthorityOptions) {
		this.gateway = options.gateway;
		this.providerId = options.gateway.providerId;
		this.authorizer = options.authorizer;
		const catalog = options.gateway as ToolGateway & Partial<ToolGatewayRouteCatalog>;
		const configuredRoutes = options.routeCatalog;
		this.readRouteCatalog = configuredRoutes === undefined
			? typeof catalog.getRouteCatalog === "function"
				? () => catalog.getRouteCatalog!()
				: () => []
			: () => configuredRoutes;
	}

	setAuthorizer(authorizer: ToolGatewayRequestAuthorizer | undefined): void {
		this.authorizer = authorizer;
	}

	getRouteCatalog(): readonly ToolGatewayRouteSnapshot[] {
		try {
			const routes = this.readRouteCatalog();
			return Array.isArray(routes) ? freezeRouteSnapshots(routes) : Object.freeze([]);
		} catch {
			return Object.freeze([]);
		}
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
		const routeResult = lookupToolGatewayRouteSafely(this.getRouteCatalog(), value.toolName, value.namespace);
		if (!routeResult.ok) return routeResult;
		const route = routeResult.value;
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
		const currentRoute = lookupToolGatewayRouteSafely(this.getRouteCatalog(), value.toolName, value.namespace);
		if (!currentRoute.ok || !sameToolGatewayRoute(route, currentRoute.value)) {
			return Result.err(new FoundationError("external_tool_route_denied", "External connector Tool Gateway route changed during authorization"));
		}
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
	/** Provider revision; every registered route must carry this exact revision. */
	readonly revision: number;
	readonly routes: readonly ToolGatewayRoute[];
	readonly invoke: (
		request: ToolGatewayRequest,
		options?: { signal?: AbortSignal },
	) => Promise<ResultValue<ToolExecutionResult, FoundationError>>;
	readonly capabilities?: readonly FoundationProviderCapability[];
}

/** Local tool provider: the host executes the tool and returns a validated result. */
export function createLocalToolGatewayProvider(options: LocalToolGatewayProviderOptions): ToolGatewayProvider {
	const declared = options.capabilities ?? [];
	const revision = options.revision;
	const inFlight = new Map<symbol, string>();
	let disposed = false;
	return {
		providerId: options.providerId,
		kind: "local",
		revision,
		routes: options.routes,
		getInFlightCount: (): number => inFlight.size,
		async capabilities(): Promise<readonly FoundationProviderCapability[]> {
			return declared;
		},
		async execute(
			request: ToolGatewayRequest,
			gatewayOptions: { signal?: AbortSignal } = {},
		): Promise<ResultValue<ToolExecutionResult, FoundationError>> {
			if (disposed) return Result.err(new FoundationError("invalid_identifier", "local Tool Gateway provider is disposed"));
			const token = Symbol(request.toolCallId);
			inFlight.set(token, request.toolCallId);
			try {
				const result = await options.invoke(request, gatewayOptions);
				if (!result.ok) return result;
				const checked = validateToolExecutionResult(result.value);
				return checked.ok ? checked : Result.err(checked.error);
			} finally {
				inFlight.delete(token);
			}
		},
		async cancel(toolCallId: string): Promise<ResultValue<void, FoundationError>> {
			for (const [token, trackedToolCallId] of inFlight) {
				if (trackedToolCallId === toolCallId) inFlight.delete(token);
			}
			return Result.ok(undefined);
		},
		async dispose(): Promise<void> {
			disposed = true;
			inFlight.clear();
		},
	};
}

/**
 * Sandbox translator consumed by {@link createSandboxOperationToolGatewayProvider}.
 * It maps a ToolGateway request onto a SandboxOperationRequest; the
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
	/** Provider revision; every registered route must carry this exact revision. */
	readonly revision: number;
	readonly routes: readonly ToolGatewayRoute[];
	readonly sandbox: SandboxOperationProvider;
	readonly translator?: SandboxOperationTranslator;
	/** Records the invocation payload per operation id so a sandbox operation Worker can resolve it later. */
	readonly onOperationPayload?: (operationId: string, args: FoundationJsonValue) => void;
	readonly capabilities?: readonly FoundationProviderCapability[];
}

/**
 * Sandbox tool provider consuming the frozen {@link SandboxOperationProvider}
 * contract. The WorkerReceipt is exact-shape validated and mapped onto the
 * ToolExecutionResult; the gateway only ever sees provider-neutral values.
 */
export function createSandboxOperationToolGatewayProvider(
	options: SandboxOperationToolGatewayProviderOptions,
): ToolGatewayProvider {
	const sandbox = options.sandbox;
	const translator = options.translator ?? createDefaultSandboxOperationTranslator();
	const inFlight = new Map<string, { operationId: string; toolCallId: string; args: FoundationJsonValue }>();
	const declared = options.capabilities ?? [];
	const revision = options.revision;
	let disposed = false;
	return {
		providerId: options.providerId,
		kind: "sandbox",
		revision,
		routes: options.routes,
		getInFlightCount: (): number => inFlight.size,
		async capabilities(): Promise<readonly FoundationProviderCapability[]> {
			return declared;
		},
		async execute(
			request: ToolGatewayRequest,
			gatewayOptions: { signal?: AbortSignal } = {},
		): Promise<ResultValue<ToolExecutionResult, FoundationError>> {
			if (disposed) return Result.err(new FoundationError("invalid_identifier", "sandbox Tool Gateway provider is disposed"));
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
			const tracked = { operationId: operation.operationId, toolCallId: request.toolCallId, args: request.originalArguments };
			inFlight.set(operation.operationId, tracked);
			try {
				options.onOperationPayload?.(operation.operationId, request.originalArguments);
				let started: ResultValue<WorkerReceipt, FoundationError>;
				try {
					started = await sandbox.start(operation, { signal: gatewayOptions.signal });
				} catch (error) {
					try {
						await sandbox.cancel(operation.operationId);
					} catch {
						// Preserve the provider throw while the operation tracker is cleared below.
					}
					throw error;
				}
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
		async cancel(toolCallId: string): Promise<ResultValue<void, FoundationError>> {
			const operations = [...inFlight.values()].filter((tracked) => tracked.toolCallId === toolCallId);
		for (const operation of operations) inFlight.delete(operation.operationId);
			const cancellations = await Promise.allSettled(operations.map(async (tracked) => sandbox.cancel(tracked.operationId)));
			const rejected = cancellations.find((result) => result.status === "rejected");
			if (rejected !== undefined && rejected.status === "rejected") {
				return Result.err(toFoundationError(rejected.reason, "side_effect_unknown"));
			}
			const failed = cancellations.find((result) => result.status === "fulfilled" && !result.value.ok);
			if (failed?.status === "fulfilled" && !failed.value.ok) return Result.err(failed.value.error);
			return Result.ok(undefined);
		},
		async dispose(): Promise<void> {
			disposed = true;
			const operations = [...inFlight.values()];
			inFlight.clear();
			const cancellations = await Promise.allSettled(
				operations.map(async (tracked) => sandbox.cancel(tracked.operationId)),
			);
			let disposalError: unknown;
			try {
				await sandbox.dispose();
			} catch (error) {
				disposalError = error;
			}
			const cancellationFailed = cancellations.some(
				(result) => result.status === "rejected" || (result.status === "fulfilled" && !result.value.ok),
			);
			if (disposalError !== undefined || cancellationFailed) {
				throw new FoundationError("side_effect_unknown", "Sandbox Tool Gateway cleanup could not be confirmed", {
					cause: disposalError,
				});
			}
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
