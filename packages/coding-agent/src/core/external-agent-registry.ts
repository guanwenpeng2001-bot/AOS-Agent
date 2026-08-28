/** Trusted, instance-only External Connector registry. */

import {
	EXTERNAL_ERROR_MESSAGES,
	FoundationError,
	Result,
	cloneDeepFrozen,
	fingerprintFoundationValue,
	isToolGatewayRoute,
	validateAgentBinding,
	validateToolExecutionResult,
	validateToolGatewayRequest,
	validateConnectorCapabilitySnapshotForProvider,
	type ConnectorCapabilitySnapshot,
	type Attempt,
	type AgentBinding,
	type AttemptReceipt,
	type ExternalAgentConnector,
	type Fingerprint,
	type FoundationProviderExecutionOptions,
	type Result as ResultValue,
	type ToolExecutionResult,
	type ToolGateway,
	type ToolGatewayRequest,
	type ToolGatewayRoute,
} from "@aos-agent/agent-core";
import {
	createExternalCapabilityTruthSnapshot,
	type ExternalCapabilityBehavior,
	type ExternalCapabilityEvidenceInput,
	type ExternalCapabilityTruthSnapshot,
	type ExternalResolvedModelProjection,
} from "./external-model-projection.ts";
import {
	DEFAULT_EXTERNAL_CONNECTOR_READINESS_TTL_MS,
	createDescriptorExternalConnectorActivationSource,
	createExternalConnectorReadinessSnapshot,
	externalConnectorActivationSourceMatchesCapability,
	externalConnectorReadinessSnapshotIsCurrent,
	externalConnectorReadinessSnapshotMatchesSource,
	sameExternalConnectorActivationSource,
	validateExternalConnectorActivationSource,
	type ExternalConnectorActivationSource,
	type ExternalConnectorReadinessReasonCode,
	type ExternalConnectorReadinessSnapshot,
} from "./external-connector-readiness.ts";
import {
	getHostSupervisedExternalAgentConnectorImplementation,
	getHostSupervisedExternalConnectorRecoveryFailureSettler,
	hasHostSupervisedExternalAgentConnectorProof,
	type ExternalConnectorToolGatewayConsumer,
	type ExternalConnectorToolGatewayScope,
	type HostSupervisedExternalAgentConnectorImplementation,
} from "./external-agent-connector.ts";
import { getProductionExternalConnectorStartupStatus } from "./external-connector-production.ts";
import type { PolicyBinding } from "./execution-policy.ts";
import { createPolicyBindingLedgerRecord } from "./execution-policy-ledger.ts";
import {
	runExternalConnectorHostDispose,
	runExternalConnectorHostOperation,
	type ExternalConnectorSegmentDeadline,
} from "./external-connector-supervisor.ts";
import {
	projectConnectorRuntimeStatus,
	type ConnectorRuntimeStatus,
	type ConnectorRuntimeStatusSource,
} from "./connector-runtime-status.ts";
import type { RuntimeClock } from "./runtime-clock.ts";

/** The only current provider class admitted by the open connector registry. */
export const EXTERNAL_CONNECTOR_PROVIDER_CLASSES = Object.freeze(["external_connector"] as const);
export type ExternalConnectorProviderClass = (typeof EXTERNAL_CONNECTOR_PROVIDER_CLASSES)[number];

/** Immutable identity and capability revision pinned at registration. */
export interface ExternalConnectorDescriptor {
	readonly schemaVersion: 1;
	readonly providerId: string;
	readonly providerClass: ExternalConnectorProviderClass;
	readonly revision: number;
	readonly capabilitySnapshotDigest: Fingerprint;
}

/** Host-only registration input. No module, command, endpoint, or vendor selector is accepted. */
export interface ExternalConnectorRegistration {
	readonly descriptor: ExternalConnectorDescriptor;
	readonly connector: ExternalAgentConnector;
}

/** A selection must pin every mutable connector capability identity field. */
export interface ExternalConnectorSelection {
	readonly providerId: string;
	readonly revision: number;
	readonly capabilitySnapshotDigest: Fingerprint;
}

/** Selected constructed instance plus the verified immutable capability facts. */
export interface ExternalConnectorResolvedSelection {
	readonly descriptor: ExternalConnectorDescriptor;
	readonly connector: ExternalAgentConnector;
	readonly capabilitySnapshot: ConnectorCapabilitySnapshot;
	readonly capabilityTruth: ExternalCapabilityTruthSnapshot;
}

export interface ExternalConnectorReadinessStatus {
	readonly schemaVersion: 1;
	readonly providerId: string;
	readonly trust: "host_configured";
	readonly status: "ready" | "not_ready" | "quarantined";
	readonly reasonCode: ExternalConnectorReadinessReasonCode;
}

type ExternalConnectorToolGatewayConsumerBinder = (
	attemptId: string,
	binding: AgentBinding,
	policyBinding: PolicyBinding,
) => () => void;

export interface ExternalConnectorToolGatewayCatalogSnapshot {
	readonly gatewayId: string;
	readonly catalogDigest: Fingerprint;
	readonly routes: readonly ToolGatewayRoute[];
}

interface CapturedExternalConnectorToolGatewayCatalog {
	readonly gateway: ToolGateway;
	readonly scope: ExternalConnectorToolGatewayCatalogSnapshot & { readonly schemaVersion: 1 };
}

const externalConnectorToolGatewayConsumerBinders = new WeakMap<
	ExternalConnectorResolvedSelection,
	ExternalConnectorToolGatewayConsumerBinder
>();
const externalConnectorRecoveryFailureSettlers = new WeakMap<
	ExternalConnectorResolvedSelection,
	(attempt: Attempt, error: FoundationError) => Promise<ResultValue<AttemptReceipt, FoundationError>>
>();
const externalConnectorToolGatewayCatalogs = new WeakMap<
	ExternalConnectorResolvedSelection,
	CapturedExternalConnectorToolGatewayCatalog
>();

export interface ExternalConnectorRegistry {
	register(
		registration: ExternalConnectorRegistration,
	): Promise<ResultValue<ExternalConnectorDescriptor, FoundationError>>;
	/** Trusted composition bootstrap when the exact probed snapshot is already pinned. */
	registerPrepared(
		registration: ExternalConnectorRegistration,
		capabilitySnapshot: ConnectorCapabilitySnapshot,
	): ResultValue<ExternalConnectorDescriptor, FoundationError>;
	select(
		selection: ExternalConnectorSelection,
		options?: FoundationProviderExecutionOptions,
	): Promise<ResultValue<ExternalConnectorResolvedSelection, FoundationError>>;
	list(): readonly ExternalConnectorDescriptor[];
	/** Passive, side-effect-free readiness projection. */
	readiness(): readonly ExternalConnectorReadinessStatus[];
	/** Passive immutable readiness facts. No Connector or product operation is invoked. */
	readinessSnapshots(): readonly ExternalConnectorReadinessSnapshot[];
	/** Passive immutable runtime projection from readiness and a trusted aggregate source. */
	runtimeStatus(): readonly ConnectorRuntimeStatus[];
	/** Explicit bounded active probe. It never creates a vendor session or Attempt. */
	probeReadiness(selection: ExternalConnectorSelection): Promise<ExternalConnectorReadinessStatus>;
	dispose(): Promise<void>;
}

export interface ExternalConnectorRegistryOptions {
	readonly capabilityProbeDeadline?: Partial<ExternalConnectorSegmentDeadline>;
	readonly clock?: RuntimeClock;
	/** Trusted Host captures taken before candidate Connectors are constructed. */
	readonly activationSources?: readonly ExternalConnectorActivationSource[];
	/** Re-read the trusted Host source before publishing or selecting a candidate. */
	readonly readActivationSource?: (providerId: string) => unknown;
	readonly readinessTtlMs?: number;
	/** Passive in-memory aggregate source populated by later product composition. */
	readonly runtimeStatusSource?: ConnectorRuntimeStatusSource;
	/** Canonical Foundation Tool Gateway for this Session composition. */
	readonly toolGateway?: ToolGateway;
}

type RegisteredExternalConnectorImplementation = Omit<
	HostSupervisedExternalAgentConnectorImplementation,
	"preflightModelProjection" | "bindToolGatewayConsumer"
> &
	Partial<
		Pick<
			HostSupervisedExternalAgentConnectorImplementation,
			"preflightModelProjection" | "bindToolGatewayConsumer"
		>
	>;

interface CapturedExternalConnectorProperty {
	readonly key: keyof RegisteredExternalConnectorImplementation;
	readonly owner: object;
	readonly descriptor: Readonly<PropertyDescriptor>;
	readonly value: unknown;
}

interface ExternalConnectorImplementationProof {
	readonly kind: "host_supervised" | "public_spi";
	readonly prototype?: object | null;
	readonly properties?: readonly CapturedExternalConnectorProperty[];
}

interface ResolvedExternalConnectorImplementation {
	readonly implementation: RegisteredExternalConnectorImplementation;
	readonly proof: ExternalConnectorImplementationProof;
}

interface RegisteredConnector {
	readonly descriptor: ExternalConnectorDescriptor;
	readonly connector: ExternalAgentConnector;
	readonly implementation: RegisteredExternalConnectorImplementation;
	readonly implementationProof: ExternalConnectorImplementationProof;
	readonly selectedConnectors: WeakMap<ExternalConnectorReadinessSnapshot, ExternalAgentConnector>;
	readonly capabilitySnapshot: ConnectorCapabilitySnapshot;
	readonly capabilityTruth: ExternalCapabilityTruthSnapshot;
	readonly activationSource: ExternalConnectorActivationSource;
}

interface PendingConnector {
	readonly connector: ExternalAgentConnector;
	readonly implementation: RegisteredExternalConnectorImplementation;
	readonly implementationProof: ExternalConnectorImplementationProof;
}

const EXTERNAL_CONNECTOR_DESCRIPTOR_KEYS = new Set([
	"schemaVersion",
	"providerId",
	"providerClass",
	"revision",
	"capabilitySnapshotDigest",
]);
const EXTERNAL_CONNECTOR_REGISTRATION_KEYS = new Set(["descriptor", "connector"]);
const EXTERNAL_CONNECTOR_SELECTION_KEYS = new Set(["providerId", "revision", "capabilitySnapshotDigest"]);
const RESULT_OK_KEYS = new Set(["ok", "value"]);
const RESULT_ERROR_KEYS = new Set(["ok", "error"]);
const FINGERPRINT_KEYS = new Set(["algorithm", "value"]);
const EXTERNAL_CONNECTOR_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;

function connectorRegistryError(message: string): FoundationError {
	return new FoundationError("task_executor_invalid_provider_class", message);
}

const EXTERNAL_CONNECTOR_TOOL_GATEWAY_ROUTE_DENIAL_CODES: ReadonlySet<string> = new Set([
	"external_tool_route_denied",
	"invalid_identifier",
	"tool_guard_denied",
	"tool_pre_hook_denied",
	"transport_not_authorized",
]);

const EXTERNAL_CONNECTOR_TOOL_GATEWAY_POLICY_DENIAL_CODES: ReadonlySet<string> = new Set([
	"external_tool_route_denied",
	"tool_guard_denied",
	"tool_pre_hook_denied",
	"transport_not_authorized",
]);

function externalConnectorToolGatewayDeniedResult(request: ToolGatewayRequest): ToolExecutionResult {
	return cloneDeepFrozen({
		schemaVersion: 1,
		toolCallId: request.toolCallId,
		toolName: request.toolName,
		ok: false,
		sideEffectState: "none",
		error: {
			code: "external_tool_route_denied",
			message: EXTERNAL_ERROR_MESSAGES.external_tool_route_denied,
			category: "permission",
			retryable: false,
		},
	});
}

function routeCatalogForGateway(
	gateway: ToolGateway,
): ResultValue<CapturedExternalConnectorToolGatewayCatalog, FoundationError> {
	const candidate = gateway as ToolGateway & { readonly getRouteCatalog?: () => readonly ToolGatewayRoute[] };
	if (typeof candidate.getRouteCatalog !== "function") {
		return Result.err(
			new FoundationError("external_connector_not_ready", "External connector Tool Gateway catalog is not ready."),
		);
	}
	let routeCatalog: readonly ToolGatewayRoute[];
	try {
		routeCatalog = Reflect.apply(candidate.getRouteCatalog, candidate, []);
	} catch {
		return Result.err(
			new FoundationError("external_connector_not_ready", "External connector Tool Gateway catalog is not ready."),
		);
	}
	if (!Array.isArray(routeCatalog)) {
		return Result.err(connectorRegistryError("External connector Tool Gateway catalog is invalid."));
	}
	const routes: ToolGatewayRoute[] = [];
	const exactRoutes = new Set<string>();
	for (const route of routeCatalog) {
		if (!isToolGatewayRoute(route)) {
			return Result.err(connectorRegistryError("External connector Tool Gateway catalog is invalid."));
		}
		const key = JSON.stringify([route.namespace ?? "", route.toolName]);
		if (exactRoutes.has(key)) {
			return Result.err(connectorRegistryError("External connector Tool Gateway catalog is ambiguous."));
		}
		exactRoutes.add(key);
		routes.push({
			kind: route.kind,
			toolName: route.toolName,
			...(route.namespace === undefined ? {} : { namespace: route.namespace }),
			providerId: route.providerId,
			revision: route.revision,
			operation: {
				resource: route.operation.resource,
				effects: [...route.operation.effects],
				...(route.operation.requiresSandbox === true ? { requiresSandbox: true } : {}),
			},
		});
	}
	const frozenRoutes = cloneDeepFrozen(routes);
	return Result.ok({
		gateway,
		scope: cloneDeepFrozen({
			schemaVersion: 1,
			gatewayId: gateway.providerId,
			catalogDigest: fingerprintFoundationValue({ gatewayId: gateway.providerId, routes: frozenRoutes }),
			routes: frozenRoutes,
		}),
	});
}

function routeBindingName(route: ToolGatewayRoute): string | undefined {
	if (route.kind !== "mcp") return route.toolName;
	return route.namespace === undefined ? undefined : `mcp__${route.namespace}__${route.toolName}`;
}

function routeSelectedByBinding(route: ToolGatewayRoute, binding: AgentBinding): boolean {
	const selector = binding.capabilitySelector;
	const name = routeBindingName(route);
	if (name === undefined) return false;
	if (selector.policy === "none") return false;
	if (selector.policy === "named" && !(selector.named ?? []).includes(name)) return false;
	if (selector.policy === "except" && (selector.named ?? []).includes(name)) return false;
	if (route.kind !== "mcp") return true;
	if (route.namespace === undefined) return false;
	const server = binding.mcpSelection.servers.find((candidate) => candidate.serverId === route.namespace);
	const tool = server?.tools.find((candidate) => candidate.toolId === route.toolName);
	return tool !== undefined && tool.providerId === route.providerId && tool.routeRevision === route.revision;
}

function routeSelectedByPolicy(route: ToolGatewayRoute, policy: PolicyBinding): boolean {
	if (!isToolGatewayRoute(route)) return false;
	const workspaceAllowed = (access: "read" | "write"): boolean =>
		policy.constraints.workspace[access].includes("workspace") &&
		!policy.constraints.workspace.deny.includes("workspace");
	const effects = route.operation.effects;
	const requiresWrite = effects.some((effect) => ["write", "create", "delete", "move", "commit", "merge"].includes(effect));
	const requiresProcess = route.operation.resource === "process.spawn" || effects.includes("command");
	const requiresNetwork = route.operation.resource === "network.connect" || effects.some((effect) => effect === "network" || effect === "push");
	if (
		(["filesystem.read", "filesystem.find", "filesystem.grep"].includes(route.operation.resource) && !workspaceAllowed("read")) ||
		(route.operation.resource === "filesystem.write" && !workspaceAllowed("write")) ||
		(requiresWrite && !workspaceAllowed("write")) ||
		(requiresProcess && policy.constraints.process.action === "deny") ||
		(requiresNetwork && policy.constraints.network.action === "deny")
	) return false;
	if (route.operation.requiresSandbox === true) {
		if (
			route.kind !== "sandbox" ||
			policy.sandboxProviderId !== route.providerId ||
			policy.sandboxStatus !== "ready" ||
			(requiresWrite && !policy.sandboxCapabilities.filesystem) ||
			(requiresProcess && !policy.sandboxCapabilities.process) ||
			(requiresNetwork && !policy.sandboxCapabilities.network)
		) return false;
	}
	return [
		"filesystem.read",
		"filesystem.write",
		"filesystem.find",
		"filesystem.grep",
		"process.spawn",
		"network.connect",
	].includes(route.operation.resource);
}

function scopedToolGatewayConsumer(
	catalog: CapturedExternalConnectorToolGatewayCatalog,
	attemptId: string,
	bindingValue: AgentBinding,
	policyBinding: PolicyBinding,
	executeGateway: (
		request: ToolGatewayRequest,
		options?: { readonly signal?: AbortSignal },
	) => Promise<ResultValue<ToolExecutionResult, FoundationError>>,
): ExternalConnectorToolGatewayConsumer {
	const checkedBinding = validateAgentBinding(bindingValue);
	if (!checkedBinding.ok) throw checkedBinding.error;
	const binding = checkedBinding.value;
	const policyRevisionPayload = {
		...createPolicyBindingLedgerRecord(policyBinding),
		type: "policy_binding" as const,
		revision: binding.policyRevision.revision,
	};
	if (
		binding.policyRevision.id !== policyBinding.id ||
		binding.policyRevision.fingerprint === undefined ||
		binding.policyRevision.fingerprint.value !== fingerprintFoundationValue(policyRevisionPayload).value
	) {
		throw connectorRegistryError("External connector PolicyBinding does not match its durable AgentBinding.");
	}
	const routes = cloneDeepFrozen(catalog.scope.routes.filter(
		(route) => routeSelectedByBinding(route, binding) && routeSelectedByPolicy(route, policyBinding),
	));
	const scope: ExternalConnectorToolGatewayScope = cloneDeepFrozen({
		schemaVersion: 1,
		gatewayId: catalog.scope.gatewayId,
		catalogDigest: catalog.scope.catalogDigest,
		bindingId: binding.bindingId,
		capabilityBindingId: binding.capabilityRevision.id,
		policyBindingId: binding.policyRevision.id,
		policyRevision: binding.policyRevision.revision,
		policyBindingDigest: binding.policyRevision.fingerprint,
		mcpSelectionDigest: binding.mcpSelection.digest,
		routes,
	});
	const execute = async (
		request: ToolGatewayRequest,
		options?: { readonly signal?: AbortSignal },
	): Promise<ResultValue<ToolExecutionResult, FoundationError>> => {
		const currentCatalog = routeCatalogForGateway(catalog.gateway);
		if (
			!currentCatalog.ok ||
			currentCatalog.value.scope.gatewayId !== catalog.scope.gatewayId ||
			!sameFingerprint(currentCatalog.value.scope.catalogDigest, catalog.scope.catalogDigest) ||
			request.context.bindingId !== binding.bindingId ||
			request.context.attemptId !== attemptId
		) {
			return Result.err(new FoundationError("external_tool_route_denied", "External connector Tool Gateway scope changed."));
		}
		const matches = routes.filter(
			(route) => route.toolName === request.toolName && route.namespace === request.namespace,
		);
		if (matches.length !== 1) {
			return Result.err(new FoundationError("external_tool_route_denied", "External connector Tool Gateway route is outside its binding scope."));
		}
		return executeGateway({
			...request,
			context: { ...request.context, providerId: matches[0]!.providerId },
		}, options);
	};
	Object.defineProperty(execute, "scope", { value: scope, enumerable: true, writable: false, configurable: false });
	return Object.freeze(execute) as ExternalConnectorToolGatewayConsumer;
}

/** @internal Exact gateway catalog captured when the connector selection was resolved. */
export function getExternalConnectorToolGatewayRouteCatalog(
	selection: ExternalConnectorResolvedSelection,
): readonly ToolGatewayRoute[] {
	return getExternalConnectorToolGatewayCatalogSnapshot(selection).routes;
}

/** @internal Exact gateway identity, digest, and routes captured for a resolved selection. */
export function getExternalConnectorToolGatewayCatalogSnapshot(
	selection: ExternalConnectorResolvedSelection,
): ExternalConnectorToolGatewayCatalogSnapshot {
	const catalog = externalConnectorToolGatewayCatalogs.get(selection);
	if (catalog === undefined) throw connectorRegistryError("External connector selection has no Tool Gateway catalog authority.");
	return cloneDeepFrozen({
		gatewayId: catalog.scope.gatewayId,
		catalogDigest: catalog.scope.catalogDigest,
		routes: catalog.scope.routes,
	});
}

/** @internal Bind the private Tool Gateway consumer for a selected durable Attempt. */
export function bindExternalConnectorToolGatewayConsumer(
	selection: ExternalConnectorResolvedSelection,
	attemptId: string,
	binding: AgentBinding,
	policyBinding: PolicyBinding,
): () => void {
	const bind = externalConnectorToolGatewayConsumerBinders.get(selection);
	if (bind === undefined) {
		throw connectorRegistryError("External connector selection has no Tool Gateway consumer authority.");
	}
	return bind(attemptId, binding, policyBinding);
}

/** @internal Invoke only the recovery-failure authority owned by the selected Connector. */
export function settleExternalConnectorRecoveryFailure(
	selection: ExternalConnectorResolvedSelection,
	attempt: Attempt,
	error: FoundationError,
): Promise<ResultValue<AttemptReceipt, FoundationError>> | undefined {
	return externalConnectorRecoveryFailureSettlers.get(selection)?.(attempt, error);
}

function isConnectorRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactConnectorKeys(value: Record<string, unknown>, expected: ReadonlySet<string>): boolean {
	const keys = Object.keys(value);
	return keys.length === expected.size && keys.every((key) => expected.has(key));
}

function hasOnlyConnectorKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
	return Object.keys(value).every((key) => allowed.has(key));
}

function isExternalConnectorIdentifier(value: unknown): value is string {
	return typeof value === "string" && EXTERNAL_CONNECTOR_IDENTIFIER_PATTERN.test(value);
}

function isExternalConnectorFingerprint(value: unknown): value is Fingerprint {
	return (
		isConnectorRecord(value) &&
		hasExactConnectorKeys(value, FINGERPRINT_KEYS) &&
		value.algorithm === "sha256" &&
		typeof value.value === "string" &&
		SHA256_PATTERN.test(value.value)
	);
}

function sameFingerprint(left: Fingerprint, right: Fingerprint): boolean {
	return left.algorithm === right.algorithm && left.value === right.value;
}

function isExternalConnectorDescriptor(value: unknown): value is ExternalConnectorDescriptor {
	return (
		isConnectorRecord(value) &&
		hasExactConnectorKeys(value, EXTERNAL_CONNECTOR_DESCRIPTOR_KEYS) &&
		value.schemaVersion === 1 &&
		isExternalConnectorIdentifier(value.providerId) &&
		value.providerClass === "external_connector" &&
		Number.isSafeInteger(value.revision) &&
		(value.revision as number) > 0 &&
		isExternalConnectorFingerprint(value.capabilitySnapshotDigest)
	);
}

const EXTERNAL_CONNECTOR_PUBLIC_PROPERTIES = Object.freeze([
	"schemaVersion",
	"providerId",
	"providerClass",
	"capabilities",
	"dispose",
	"probeCapabilities",
	"createAttempt",
	"runAttempt",
	"cancelAttempt",
	"resumeAttempt",
	"reconcileAttempt",
] as const);
type ExternalConnectorPublicProperty = (typeof EXTERNAL_CONNECTOR_PUBLIC_PROPERTIES)[number];

function resolveExternalConnectorProperty(
	value: object,
	key: ExternalConnectorPublicProperty,
): { readonly owner: object; readonly descriptor: PropertyDescriptor } | undefined {
	let owner: object | null = value;
	while (owner !== null) {
		const descriptor = Object.getOwnPropertyDescriptor(owner, key);
		if (descriptor !== undefined) return { owner, descriptor };
		owner = Object.getPrototypeOf(owner) as object | null;
	}
	return undefined;
}

function sameExternalConnectorProperty(value: object, captured: CapturedExternalConnectorProperty): boolean {
	const current = readExternalConnectorProperty(value, captured.key as ExternalConnectorPublicProperty);
	if (current === undefined || current.owner !== captured.owner) return false;
	const left = current.descriptor;
	const right = captured.descriptor;
	return (
		left.configurable === right.configurable &&
		left.enumerable === right.enumerable &&
		left.writable === right.writable &&
		left.get === right.get &&
		left.set === right.set &&
		Object.is(current.value, captured.value)
	);
}

function readExternalConnectorProperty(
	value: object,
	key: ExternalConnectorPublicProperty,
): { readonly owner: object; readonly descriptor: PropertyDescriptor; readonly value: unknown } | undefined {
	const resolved = resolveExternalConnectorProperty(value, key);
	if (resolved === undefined) return undefined;
	if (Object.hasOwn(resolved.descriptor, "value")) return { ...resolved, value: resolved.descriptor.value };
	if (typeof resolved.descriptor.get !== "function") return undefined;
	try {
		return { ...resolved, value: Reflect.get(value, key, value) };
	} catch {
		return undefined;
	}
}

function capturePublicExternalConnector(
	value: unknown,
): { readonly implementation: RegisteredExternalConnectorImplementation; readonly proof: ExternalConnectorImplementationProof } | undefined {
	if (!isConnectorRecord(value)) return undefined;
	try {
		const connector = value as unknown as ExternalAgentConnector;
		const captured = new Map<ExternalConnectorPublicProperty, {
			readonly owner: object;
			readonly descriptor: PropertyDescriptor;
			readonly value: unknown;
		}>();
		for (const key of EXTERNAL_CONNECTOR_PUBLIC_PROPERTIES) {
			const property = readExternalConnectorProperty(connector, key);
			if (property === undefined) return undefined;
			captured.set(key, property);
		}
		const schemaVersion = captured.get("schemaVersion")?.value;
		const providerId = captured.get("providerId")?.value;
		const providerClass = captured.get("providerClass")?.value;
		if (schemaVersion !== 1 || !isExternalConnectorIdentifier(providerId) || providerClass !== "external_connector") {
			return undefined;
		}
		const capabilities = captured.get("capabilities")?.value;
		const dispose = captured.get("dispose")?.value;
		const probeCapabilities = captured.get("probeCapabilities")?.value;
		const createAttempt = captured.get("createAttempt")?.value;
		const runAttempt = captured.get("runAttempt")?.value;
		const cancelAttempt = captured.get("cancelAttempt")?.value;
		const resumeAttempt = captured.get("resumeAttempt")?.value;
		const reconcileAttempt = captured.get("reconcileAttempt")?.value;
		if (
			typeof capabilities !== "function" ||
			typeof dispose !== "function" ||
			typeof probeCapabilities !== "function" ||
			typeof createAttempt !== "function" ||
			typeof runAttempt !== "function" ||
			typeof cancelAttempt !== "function" ||
			typeof resumeAttempt !== "function" ||
			typeof reconcileAttempt !== "function"
		) {
			return undefined;
		}
		const implementation: RegisteredExternalConnectorImplementation = Object.freeze({
			schemaVersion,
			providerId,
			providerClass,
			capabilities: () => Reflect.apply(capabilities as ExternalAgentConnector["capabilities"], connector, []),
			dispose: () => Reflect.apply(dispose as ExternalAgentConnector["dispose"], connector, []),
			probeCapabilities: (options) =>
				Reflect.apply(probeCapabilities as ExternalAgentConnector["probeCapabilities"], connector, [options]),
			createAttempt: (dispatch, binding, context) =>
				Reflect.apply(createAttempt as ExternalAgentConnector["createAttempt"], connector, [dispatch, binding, context]),
			runAttempt: (attempt, options) =>
				Reflect.apply(runAttempt as ExternalAgentConnector["runAttempt"], connector, [attempt, options]),
			cancelAttempt: (attemptId) =>
				Reflect.apply(cancelAttempt as ExternalAgentConnector["cancelAttempt"], connector, [attemptId]),
			resumeAttempt: (attempt, options) =>
				Reflect.apply(resumeAttempt as ExternalAgentConnector["resumeAttempt"], connector, [attempt, options]),
			reconcileAttempt: (attempt, options) =>
				Reflect.apply(reconcileAttempt as ExternalAgentConnector["reconcileAttempt"], connector, [attempt, options]),
		});
		const properties = Object.freeze(
			EXTERNAL_CONNECTOR_PUBLIC_PROPERTIES.map((key) => {
				const property = captured.get(key);
				if (property === undefined) throw new Error(`External connector property ${key} is unavailable.`);
				return Object.freeze({
					key,
					owner: property.owner,
					descriptor: Object.freeze({ ...property.descriptor }),
					value: property.value,
				});
			}),
		);
		return {
			implementation,
			proof: Object.freeze({
				kind: "public_spi",
				prototype: Object.getPrototypeOf(connector) as object | null,
				properties,
			}),
		};
	} catch {
		return undefined;
	}
}

function resolveExternalConnectorImplementation(value: unknown): ResolvedExternalConnectorImplementation | undefined {
	if (!isConnectorRecord(value)) return undefined;
	try {
		const hostImplementation = getHostSupervisedExternalAgentConnectorImplementation(value);
		if (hostImplementation !== undefined) {
			return { implementation: hostImplementation, proof: Object.freeze({ kind: "host_supervised" }) };
		}
		if (hasHostSupervisedExternalAgentConnectorProof(value)) return undefined;
		return capturePublicExternalConnector(value);
	} catch {
		return undefined;
	}
}

function isCurrentExternalConnectorImplementation(
	connector: ExternalAgentConnector,
	implementation: RegisteredExternalConnectorImplementation,
	proof: ExternalConnectorImplementationProof,
): boolean {
	try {
		if (proof.kind === "host_supervised") {
			return getHostSupervisedExternalAgentConnectorImplementation(connector) === implementation;
		}
		if (Object.getPrototypeOf(connector) !== proof.prototype || proof.properties === undefined) return false;
		return proof.properties.every((property) => sameExternalConnectorProperty(connector, property));
	} catch {
		return false;
	}
}

function isConstructedExternalConnector(value: unknown): value is ExternalAgentConnector {
	return resolveExternalConnectorImplementation(value) !== undefined;
}

function isExternalConnectorRegistration(value: unknown): value is ExternalConnectorRegistration {
	return (
		isConnectorRecord(value) &&
		hasOnlyConnectorKeys(value, EXTERNAL_CONNECTOR_REGISTRATION_KEYS) &&
		Object.hasOwn(value, "descriptor") &&
		Object.hasOwn(value, "connector") &&
		isExternalConnectorDescriptor(value.descriptor) &&
		isConstructedExternalConnector(value.connector)
	);
}

export function isExternalConnectorSelection(value: unknown): value is ExternalConnectorSelection {
	return (
		isConnectorRecord(value) &&
		hasExactConnectorKeys(value, EXTERNAL_CONNECTOR_SELECTION_KEYS) &&
		isExternalConnectorIdentifier(value.providerId) &&
		Number.isSafeInteger(value.revision) &&
		(value.revision as number) > 0 &&
		isExternalConnectorFingerprint(value.capabilitySnapshotDigest)
	);
}

export function serializeExternalConnectorSelection(value: unknown): ExternalConnectorSelection | undefined {
	if (!isExternalConnectorSelection(value)) return undefined;
	return Object.freeze({
		providerId: value.providerId,
		revision: value.revision,
		capabilitySnapshotDigest: Object.freeze({ ...value.capabilitySnapshotDigest }),
	});
}

function cloneConnectorDescriptor(value: ExternalConnectorDescriptor): ExternalConnectorDescriptor {
	return Object.freeze({
		schemaVersion: 1,
		providerId: value.providerId,
		providerClass: "external_connector",
		revision: value.revision,
		capabilitySnapshotDigest: Object.freeze({ ...value.capabilitySnapshotDigest }),
	});
}

function lifecycleCapabilityError(): FoundationError {
	return new FoundationError(
		"external_capability_mismatch",
		"External connector capability truth could not be rechecked",
	);
}

function connectorRegistryShutdownError(): FoundationError {
	return new FoundationError(
		"side_effect_unknown",
		"External connector registry shutdown could not confirm cleanup.",
	);
}

function createCapabilityPinnedConnector(
	connector: ExternalAgentConnector,
	implementation: RegisteredExternalConnectorImplementation,
	probePinned: (
		options?: FoundationProviderExecutionOptions,
	) => Promise<ResultValue<ConnectorCapabilitySnapshot, FoundationError>>,
	probeSelected: (
		options?: FoundationProviderExecutionOptions,
	) => Promise<ResultValue<ConnectorCapabilitySnapshot, FoundationError>>,
): ExternalAgentConnector {
	const recheck = async (options?: FoundationProviderExecutionOptions): Promise<FoundationError | undefined> => {
		const probed = await probePinned(options);
		return probed.ok || options?.signal?.aborted === true ? undefined : lifecycleCapabilityError();
	};
	const reconcileAttempt: ExternalAgentConnector["reconcileAttempt"] = async (attempt, options) => {
		await recheck(options);
		return Reflect.apply(implementation.reconcileAttempt, connector, [attempt, options]);
	};
	const runAttempt: ExternalAgentConnector["runAttempt"] = async (attempt, options) => {
		const drift = await recheck(options);
		if (drift !== undefined) {
			return Reflect.apply(implementation.reconcileAttempt, connector, [attempt, options]);
		}
		return Reflect.apply(implementation.runAttempt, connector, [attempt, options]);
	};
	const resumeAttempt: ExternalAgentConnector["resumeAttempt"] = async (attempt, options) => {
		const drift = await recheck(options);
		return drift === undefined
			? Reflect.apply(implementation.resumeAttempt, connector, [attempt, options])
			: Reflect.apply(implementation.reconcileAttempt, connector, [attempt, options]);
	};
	const cancelAttempt: ExternalAgentConnector["cancelAttempt"] = async (attemptId) => {
		const drift = await recheck();
		const cancelled = await Reflect.apply(implementation.cancelAttempt, connector, [attemptId]);
		return drift === undefined || !cancelled.ok ? cancelled : Result.err(drift);
	};
	const capabilities: ExternalAgentConnector["capabilities"] = () =>
		Reflect.apply(implementation.capabilities, connector, []);
	const dispose: ExternalAgentConnector["dispose"] = () => Reflect.apply(implementation.dispose, connector, []);
	const probeCapabilities: ExternalAgentConnector["probeCapabilities"] = (options) => probeSelected(options);
	const createAttempt: ExternalAgentConnector["createAttempt"] = (dispatch, binding, context) =>
		Reflect.apply(implementation.createAttempt, connector, [dispatch, binding, context]);
	const base = {
		schemaVersion: implementation.schemaVersion,
		providerId: implementation.providerId,
		providerClass: implementation.providerClass,
		capabilities,
		dispose,
		probeCapabilities,
		createAttempt,
		runAttempt,
		cancelAttempt,
		resumeAttempt,
		reconcileAttempt,
	};
	if (implementation.preflightModelProjection === undefined) return Object.freeze(base);
	return Object.freeze({
		...base,
		preflightModelProjection: (projection: ExternalResolvedModelProjection) =>
			Reflect.apply(implementation.preflightModelProjection!, connector, [projection]),
	});
}

function capabilityTruth(
	connectorId: string,
	snapshot: ConnectorCapabilitySnapshot,
	implementation: RegisteredExternalConnectorImplementation,
	toolGateway: ToolGateway | undefined,
): ResultValue<ExternalCapabilityTruthSnapshot, FoundationError> {
	const evidence: Partial<
		Record<ExternalCapabilityBehavior, NonNullable<ExternalCapabilityEvidenceInput[ExternalCapabilityBehavior]>>
	> = {};
	const declare = (
		behavior: ExternalCapabilityBehavior,
		handlerId: string,
		invoke: (...args: never[]) => unknown,
	): void => {
		evidence[behavior] = {
			declaration: { id: `${connectorId}.${behavior}`, revision: snapshot.revision, reachable: true },
			handler: { id: handlerId, invoke },
		};
	};
	if (snapshot.resume) declare("resume", `${connectorId}.resumeAttempt`, implementation.resumeAttempt);
	if (snapshot.toolGateway && implementation.bindToolGatewayConsumer === undefined) {
		return Result.err(
			new FoundationError(
				"external_connector_not_ready",
				"External connector Tool Gateway consumer authority is not ready.",
			),
		);
	}
	if (snapshot.toolGateway && toolGateway === undefined) {
		return Result.err(
			new FoundationError("external_connector_not_ready", "External connector Tool Gateway is not ready."),
		);
	}
	if (snapshot.toolGateway && toolGateway !== undefined) {
		const catalog = routeCatalogForGateway(toolGateway);
		if (!catalog.ok) return catalog;
		declare("toolGateway", `${toolGateway.providerId}.execute`, toolGateway.execute);
	}
	if (snapshot.artifacts) declare("artifacts", `${connectorId}.runAttempt.artifacts`, implementation.runAttempt);
	if (snapshot.images) declare("images", `${connectorId}.runAttempt.images`, implementation.runAttempt);
	if (snapshot.modelAccess === "aos_gateway") {
		if (implementation.preflightModelProjection === undefined) {
			return Result.err(
				new FoundationError("external_connector_not_ready", "External connector model gateway is not ready."),
			);
		}
		declare("aosGateway", `${connectorId}.preflightModelProjection`, implementation.preflightModelProjection);
	}
	const result = createExternalCapabilityTruthSnapshot({
		connectorId,
		protocol: `${snapshot.protocol.name}:${snapshot.protocol.version}`,
		capabilityVersion: snapshot.revision,
		capabilities: {
			resume: snapshot.resume,
			toolGateway: snapshot.toolGateway,
			artifacts: snapshot.artifacts,
			images: snapshot.images,
			modelAccess: snapshot.modelAccess,
		},
		evidence,
	});
	return result.ok
		? Result.ok(result.snapshot)
		: Result.err(
				connectorRegistryError(`External connector capability evidence failed closed: ${result.error.reasonCode}.`),
			);
}

async function probeConnector(
	connector: ExternalAgentConnector,
	implementation: RegisteredExternalConnectorImplementation,
	options: {
		readonly capabilityProbeDeadline?: Partial<ExternalConnectorSegmentDeadline>;
		readonly clock?: RuntimeClock;
		readonly execution?: Parameters<ExternalAgentConnector["probeCapabilities"]>[0];
		readonly registrySignal: AbortSignal;
		readonly requireCurrentImplementation?: boolean;
		readonly isCurrentImplementation?: () => boolean;
	},
): Promise<ResultValue<ConnectorCapabilitySnapshot, FoundationError>> {
	try {
		const signals =
			options.execution?.signal === undefined
				? [options.registrySignal]
				: [options.registrySignal, options.execution.signal];
		const probed: unknown = await runExternalConnectorHostOperation(
			"start",
			(signal) =>
				Reflect.apply(implementation.probeCapabilities, connector, [
					{
						...options.execution,
						signal,
					},
				]),
			{
				...(options.capabilityProbeDeadline === undefined
					? {}
					: { deadline: options.capabilityProbeDeadline }),
				...(options.clock === undefined ? {} : { clock: options.clock }),
				signals,
			},
		);
		if (
			options.requireCurrentImplementation !== false &&
			(options.isCurrentImplementation === undefined || !options.isCurrentImplementation())
		) {
			return Result.err(
				connectorRegistryError("External connector constructed implementation changed while probing capabilities."),
			);
		}
		if (!isConnectorRecord(probed) || typeof probed.ok !== "boolean") {
			return Result.err(connectorRegistryError("External connector returned a malformed capability probe result."));
		}
		if (probed.ok) {
			if (!hasExactConnectorKeys(probed, RESULT_OK_KEYS)) {
				return Result.err(
					connectorRegistryError("External connector returned a malformed capability probe result."),
				);
			}
			return validateConnectorCapabilitySnapshotForProvider(probed.value, implementation);
		}
		if (!hasExactConnectorKeys(probed, RESULT_ERROR_KEYS) || !FoundationError.is(probed.error)) {
			return Result.err(connectorRegistryError("External connector returned a malformed capability probe failure."));
		}
		return Result.err(connectorRegistryError("External connector capability probe failed."));
	} catch {
		return Result.err(connectorRegistryError("External connector threw while probing capabilities."));
	}
}

/** Open, instance-only connector registry with pinned capability identity. */
class ExternalConnectorRegistryImpl implements ExternalConnectorRegistry {
	readonly #connectors = new Map<string, RegisteredConnector>();
	readonly #pendingRegistrations = new Map<string, PendingConnector>();
	readonly #disposalOperations = new Map<ExternalAgentConnector, Promise<void>>();
	readonly #readinessSnapshots = new Map<string, ExternalConnectorReadinessSnapshot>();
	readonly #activationSources = new Map<string, ExternalConnectorActivationSource>();
	readonly #lifetime = new AbortController();
	readonly #options: ExternalConnectorRegistryOptions;
	readonly #readinessTtlMs: number;
	#disposed = false;
	#disposal: Promise<void> | undefined;

	constructor(options: ExternalConnectorRegistryOptions) {
		const readinessTtlMs = options.readinessTtlMs ?? DEFAULT_EXTERNAL_CONNECTOR_READINESS_TTL_MS;
		if (!Number.isSafeInteger(readinessTtlMs) || readinessTtlMs <= 0) {
			throw new RangeError("External Connector readiness TTL must be a positive safe integer");
		}
		const activationSources = options.activationSources ?? [];
		if ((activationSources.length > 0) !== (options.readActivationSource !== undefined)) {
			throw new TypeError(
				"External Connector activation source captures and the current-source reader must be configured together",
			);
		}
		if (options.runtimeStatusSource !== undefined && typeof options.runtimeStatusSource.read !== "function") {
			throw new TypeError("External Connector runtime status source must expose a passive read method");
		}
		this.#options = options;
		this.#readinessTtlMs = readinessTtlMs;
		for (const sourceValue of activationSources) {
			const source = validateExternalConnectorActivationSource(sourceValue);
			if (source === undefined || this.#activationSources.has(source.providerId)) {
				throw new TypeError("External Connector activation sources must be valid and unique by provider id");
			}
			this.#activationSources.set(source.providerId, source);
		}
	}

	#nowMs(): number {
		return this.#options.clock?.wallNow() ?? Date.now();
	}

	#createReadinessSnapshot(
		source: ExternalConnectorActivationSource,
		status: ExternalConnectorReadinessSnapshot["status"],
		reasonCode: ExternalConnectorReadinessReasonCode,
		state: ExternalConnectorReadinessSnapshot["state"],
		observedAtMs = this.#nowMs(),
	): ExternalConnectorReadinessSnapshot {
		return createExternalConnectorReadinessSnapshot({
			source,
			status,
			reasonCode,
			state,
			observedAtMs,
			ttlMs: this.#readinessTtlMs,
		});
	}

	#publishReadiness(
		source: ExternalConnectorActivationSource,
		status: ExternalConnectorReadinessSnapshot["status"],
		reasonCode: ExternalConnectorReadinessReasonCode,
		state: ExternalConnectorReadinessSnapshot["state"],
	): ExternalConnectorReadinessSnapshot {
		const snapshot = this.#createReadinessSnapshot(source, status, reasonCode, state);
		this.#readinessSnapshots.set(source.providerId, snapshot);
		return snapshot;
	}

	#descriptorActivationSource(descriptor: ExternalConnectorDescriptor): ExternalConnectorActivationSource {
		return createDescriptorExternalConnectorActivationSource({
			providerId: descriptor.providerId,
			revision: descriptor.revision,
			capabilityDigest: descriptor.capabilitySnapshotDigest,
		});
	}

	#readCurrentActivationSource(providerId: string): ExternalConnectorActivationSource | undefined {
		const readActivationSource = this.#options.readActivationSource;
		if (readActivationSource === undefined) return undefined;
		try {
			const source = validateExternalConnectorActivationSource(readActivationSource(providerId));
			return source?.providerId === providerId ? source : undefined;
		} catch {
			return undefined;
		}
	}

	#captureActivationSource(
		registration: ExternalConnectorRegistration,
	): ResultValue<ExternalConnectorActivationSource, FoundationError> {
		const descriptor = registration.descriptor;
		const descriptorSource = this.#descriptorActivationSource(descriptor);
		const supplied = this.#activationSources.get(descriptor.providerId);
		const current = this.#readCurrentActivationSource(descriptor.providerId);
		if (this.#options.readActivationSource !== undefined && supplied === undefined) {
			this.#publishReadiness(descriptorSource, "quarantined", "source_changed", "quarantined");
			return Result.err(connectorRegistryError("External connector activation source was not captured."));
		}
		if (this.#options.readActivationSource !== undefined && current === undefined) {
			this.#publishReadiness(supplied ?? descriptorSource, "quarantined", "source_changed", "quarantined");
			return Result.err(connectorRegistryError("External connector activation source is unavailable."));
		}
		const source = supplied ?? current ?? descriptorSource;
		if (
			!externalConnectorActivationSourceMatchesCapability(source, {
				providerId: descriptor.providerId,
				revision: descriptor.revision,
				digest: descriptor.capabilitySnapshotDigest,
			})
		) {
			this.#publishReadiness(source.providerId === descriptor.providerId ? source : descriptorSource, "quarantined", "source_changed", "quarantined");
			return Result.err(
				connectorRegistryError("External connector activation source does not match its pinned descriptor."),
			);
		}
		if (supplied !== undefined && current !== undefined) {
			if (!sameExternalConnectorActivationSource(source, current)) {
				this.#publishReadiness(source, "quarantined", "source_changed", "quarantined");
				return Result.err(
					connectorRegistryError("External connector activation source changed before candidate admission."),
				);
			}
		}
		return Result.ok(source);
	}

	#activationSourceIsCurrent(source: ExternalConnectorActivationSource): boolean {
		if (this.#options.readActivationSource === undefined) return true;
		const current = this.#readCurrentActivationSource(source.providerId);
		return current !== undefined && sameExternalConnectorActivationSource(source, current);
	}

	async #disposeConnectorOnce(
		connector: ExternalAgentConnector,
		implementation: RegisteredExternalConnectorImplementation,
	): Promise<void> {
		const active = this.#disposalOperations.get(connector);
		if (active !== undefined) return active;
		const disposal = Promise.resolve().then(() => Reflect.apply(implementation.dispose, connector, []));
		this.#disposalOperations.set(connector, disposal);
		return disposal;
	}

	async #disposeConnectorBounded(
		connector: ExternalAgentConnector,
		implementation: RegisteredExternalConnectorImplementation,
	): Promise<boolean> {
		try {
			await runExternalConnectorHostDispose(
				() => this.#disposeConnectorOnce(connector, implementation),
				{
					...(this.#options.capabilityProbeDeadline === undefined
						? {}
						: { deadline: this.#options.capabilityProbeDeadline }),
					...(this.#options.clock === undefined ? {} : { clock: this.#options.clock }),
				},
			);
			return true;
		} catch {
			return false;
		}
	}

	#resolvePublishedReadiness(
		registered: RegisteredConnector,
		requireCurrentImplementation: boolean,
		allowRefresh: boolean,
		expectedSnapshot?: ExternalConnectorReadinessSnapshot,
	): ResultValue<ExternalConnectorReadinessSnapshot, FoundationError> {
		const providerId = registered.descriptor.providerId;
		const readinessSnapshot = this.#readinessSnapshots.get(providerId);
		if (
			this.#disposed ||
			this.#connectors.get(providerId) !== registered ||
			readinessSnapshot === undefined ||
			(expectedSnapshot !== undefined && readinessSnapshot !== expectedSnapshot) ||
			readinessSnapshot.state === "quarantined" ||
			(requireCurrentImplementation &&
				!isCurrentExternalConnectorImplementation(
					registered.connector,
					registered.implementation,
					registered.implementationProof,
				)) ||
			registered.implementation.providerClass !== "external_connector" ||
			registered.implementation.providerId !== providerId
		) {
			return Result.err(connectorRegistryError("External connector registry or constructed instance changed."));
		}
		if (
			!externalConnectorReadinessSnapshotMatchesSource(readinessSnapshot, registered.activationSource) ||
			!this.#activationSourceIsCurrent(registered.activationSource)
		) {
			this.#publishReadiness(registered.activationSource, "quarantined", "source_changed", "quarantined");
			return Result.err(connectorRegistryError("External connector activation source changed after publication."));
		}
		if (
			this.#disposed ||
			this.#connectors.get(providerId) !== registered ||
			this.#readinessSnapshots.get(providerId) !== readinessSnapshot
		) {
			return Result.err(connectorRegistryError("External connector readiness snapshot was superseded."));
		}
		if (!allowRefresh && !externalConnectorReadinessSnapshotIsCurrent(readinessSnapshot, this.#nowMs())) {
			return Result.err(connectorRegistryError("External connector readiness snapshot is stale or not ready."));
		}
		return Result.ok(readinessSnapshot);
	}

	async #verifyRegisteredConnector(
		registered: RegisteredConnector,
		execution?: FoundationProviderExecutionOptions,
		requireCurrentImplementation = true,
		refreshReadiness = false,
		expectedReadinessSnapshot?: ExternalConnectorReadinessSnapshot,
	): Promise<
		ResultValue<
			{
				readonly snapshot: ConnectorCapabilitySnapshot;
				readonly truth: ExternalCapabilityTruthSnapshot;
			},
			FoundationError
		>
	> {
		const providerId = registered.descriptor.providerId;
		const readinessResult = this.#resolvePublishedReadiness(
			registered,
			requireCurrentImplementation,
			refreshReadiness,
			expectedReadinessSnapshot,
		);
		if (!readinessResult.ok) return readinessResult;
		const readinessSnapshot = readinessResult.value;
		const snapshotResult = await probeConnector(registered.connector, registered.implementation, {
			...this.#options,
			...(execution === undefined ? {} : { execution }),
			registrySignal: this.#lifetime.signal,
			requireCurrentImplementation,
			isCurrentImplementation: () =>
				isCurrentExternalConnectorImplementation(
					registered.connector,
					registered.implementation,
					registered.implementationProof,
				),
		});
		if (!this.#activationSourceIsCurrent(registered.activationSource)) {
			this.#publishReadiness(registered.activationSource, "quarantined", "source_changed", "quarantined");
			return Result.err(
				connectorRegistryError("External connector activation source changed while probing capabilities."),
			);
		}
		if (!snapshotResult.ok) {
			this.#publishReadiness(registered.activationSource, "not_ready", "probe_failed", "current");
			return snapshotResult;
		}
		if (this.#disposed || this.#connectors.get(providerId) !== registered) {
			return Result.err(
				connectorRegistryError("External connector registry changed while resolving the selection."),
			);
		}
		const snapshot = snapshotResult.value;
		if (
			snapshot.revision !== registered.descriptor.revision ||
			!sameFingerprint(snapshot.digest, registered.capabilitySnapshot.digest) ||
			!sameFingerprint(snapshot.digest, registered.descriptor.capabilitySnapshotDigest)
		) {
			return Result.err(
				connectorRegistryError("External connector capability snapshot drifted after registration."),
			);
		}
		const truthResult = capabilityTruth(
			registered.implementation.providerId,
			snapshot,
			registered.implementation,
			this.#options.toolGateway,
		);
		if (!truthResult.ok) return truthResult;
		if (!sameFingerprint(truthResult.value.snapshotDigest, registered.capabilityTruth.snapshotDigest)) {
			return Result.err(
				connectorRegistryError("External connector capability evidence drifted after registration."),
			);
		}
		const observedAtMs = this.#nowMs();
		if (!this.#activationSourceIsCurrent(registered.activationSource)) {
			this.#publishReadiness(registered.activationSource, "quarantined", "source_changed", "quarantined");
			return Result.err(
				connectorRegistryError("External connector activation source changed before readiness publication."),
			);
		}
		if (
			this.#disposed ||
			this.#connectors.get(providerId) !== registered ||
			this.#readinessSnapshots.get(providerId) !== readinessSnapshot
		) {
			return Result.err(connectorRegistryError("External connector readiness snapshot was superseded."));
		}
		if (refreshReadiness) {
			const refreshed = this.#createReadinessSnapshot(
				registered.activationSource,
				"ready",
				"ready",
				"current",
				observedAtMs,
			);
			this.#readinessSnapshots.set(providerId, refreshed);
			return Result.ok({ snapshot, truth: truthResult.value });
		}
		return Result.ok({ snapshot, truth: truthResult.value });
	}

	async register(
		registration: ExternalConnectorRegistration,
	): Promise<ResultValue<ExternalConnectorDescriptor, FoundationError>> {
		if (this.#disposed) return Result.err(connectorRegistryError("External connector registry is disposed."));
		if (!isExternalConnectorRegistration(registration)) {
			return Result.err(
				connectorRegistryError(
					"External connector registration must contain one Host-constructed instance and an exact descriptor.",
				),
			);
		}
		const descriptor = registration.descriptor;
		const connector = registration.connector;
		const resolved = resolveExternalConnectorImplementation(connector);
		if (resolved === undefined) {
			return Result.err(
				connectorRegistryError("External connector constructed implementation changed before registration."),
			);
		}
		const { implementation, proof: implementationProof } = resolved;
		if (this.#connectors.has(descriptor.providerId) || this.#pendingRegistrations.has(descriptor.providerId)) {
			return Result.err(connectorRegistryError("External connector provider identity is already registered."));
		}
		if (
			descriptor.providerId !== implementation.providerId ||
			descriptor.providerClass !== implementation.providerClass
		) {
			return Result.err(
				connectorRegistryError("External connector descriptor identity does not match its constructed instance."),
			);
		}
		const activationSourceResult = this.#captureActivationSource(registration);
		if (!activationSourceResult.ok) {
			await this.#disposeConnectorBounded(connector, implementation);
			return activationSourceResult;
		}
		const activationSource = activationSourceResult.value;
		if (this.#disposed) return Result.err(connectorRegistryError("External connector registry is disposed."));

		const pending = Object.freeze({ connector, implementation, implementationProof });
		this.#pendingRegistrations.set(descriptor.providerId, pending);
		try {
			const snapshotResult = await probeConnector(connector, implementation, {
				...this.#options,
				registrySignal: this.#lifetime.signal,
				isCurrentImplementation: () =>
					isCurrentExternalConnectorImplementation(connector, implementation, implementationProof),
			});
			if (!snapshotResult.ok) {
				const cleaned = await this.#disposeConnectorBounded(connector, implementation);
				this.#publishReadiness(
					activationSource,
					cleaned ? "not_ready" : "quarantined",
					cleaned ? "probe_failed" : "cleanup_unconfirmed",
					cleaned ? "current" : "quarantined",
				);
				return snapshotResult;
			}
			if (this.#disposed) {
				try {
					await this.#disposeConnectorOnce(connector, implementation);
				} catch {
					return Result.err(connectorRegistryShutdownError());
				}
				return Result.err(connectorRegistryError("External connector registry is disposed."));
			}
			const prepared = this.#registerPrepared(registration, snapshotResult.value, activationSource);
			if (
				!prepared.ok &&
				this.#readinessSnapshots.get(descriptor.providerId)?.reasonCode === "source_changed"
			) {
				await this.#disposeConnectorBounded(connector, implementation);
			}
			return prepared;
		} finally {
			if (this.#pendingRegistrations.get(descriptor.providerId) === pending) {
				this.#pendingRegistrations.delete(descriptor.providerId);
			}
		}
	}

	registerPrepared(
		registration: ExternalConnectorRegistration,
		capabilitySnapshot: ConnectorCapabilitySnapshot,
	): ResultValue<ExternalConnectorDescriptor, FoundationError> {
		if (this.#disposed) return Result.err(connectorRegistryError("External connector registry is disposed."));
		if (!isExternalConnectorRegistration(registration)) {
			return Result.err(
				connectorRegistryError(
					"External connector registration must contain one Host-constructed instance and an exact descriptor.",
				),
			);
		}
		const descriptor = registration.descriptor;
		const connector = registration.connector;
		const resolved = resolveExternalConnectorImplementation(connector);
		if (resolved === undefined) {
			return Result.err(
				connectorRegistryError("External connector constructed implementation changed before registration."),
			);
		}
		const { implementation, proof: implementationProof } = resolved;
		if (this.#connectors.has(descriptor.providerId) || this.#pendingRegistrations.has(descriptor.providerId)) {
			return Result.err(connectorRegistryError("External connector provider identity is already registered."));
		}
		const activationSourceResult = this.#captureActivationSource(registration);
		if (!activationSourceResult.ok) return activationSourceResult;
		if (this.#disposed) return Result.err(connectorRegistryError("External connector registry is disposed."));
		const pending = Object.freeze({ connector, implementation, implementationProof });
		this.#pendingRegistrations.set(descriptor.providerId, pending);
		try {
			return this.#registerPrepared(registration, capabilitySnapshot, activationSourceResult.value);
		} finally {
			if (this.#pendingRegistrations.get(descriptor.providerId) === pending) {
				this.#pendingRegistrations.delete(descriptor.providerId);
			}
		}
	}

	#registerPrepared(
		registration: ExternalConnectorRegistration,
		capabilitySnapshot: ConnectorCapabilitySnapshot,
		activationSource: ExternalConnectorActivationSource,
	): ResultValue<ExternalConnectorDescriptor, FoundationError> {
		if (this.#disposed) return Result.err(connectorRegistryError("External connector registry is disposed."));
		if (!isExternalConnectorRegistration(registration)) {
			return Result.err(
				connectorRegistryError(
					"External connector registration must contain one Host-constructed instance and an exact descriptor.",
				),
			);
		}
		const descriptor = registration.descriptor;
		const connector = registration.connector;
		const pending = this.#pendingRegistrations.get(descriptor.providerId);
		if (pending === undefined || pending.connector !== connector) {
			return Result.err(
				connectorRegistryError(
					"External connector provider identity is already registered or does not match its constructed instance.",
				),
			);
		}
		const implementation = pending.implementation;
		if (
			this.#connectors.has(descriptor.providerId) ||
			!isCurrentExternalConnectorImplementation(connector, implementation, pending.implementationProof) ||
			descriptor.providerId !== implementation.providerId ||
			descriptor.providerClass !== implementation.providerClass
		) {
			return Result.err(
				connectorRegistryError(
					"External connector provider identity is already registered or does not match its constructed instance.",
				),
			);
		}
		const checkedSnapshot = validateConnectorCapabilitySnapshotForProvider(capabilitySnapshot, implementation);
		if (!checkedSnapshot.ok) return checkedSnapshot;
		const snapshot = checkedSnapshot.value;
		if (
			descriptor.revision !== snapshot.revision ||
			!sameFingerprint(descriptor.capabilitySnapshotDigest, snapshot.digest)
		) {
			return Result.err(
				connectorRegistryError(
					"External connector descriptor revision or capability snapshot digest does not match its probe.",
				),
			);
		}
		if (
			!externalConnectorActivationSourceMatchesCapability(activationSource, {
				providerId: snapshot.providerId,
				revision: snapshot.revision,
				digest: snapshot.digest,
			})
		) {
			this.#publishReadiness(activationSource, "quarantined", "source_changed", "quarantined");
			return Result.err(
				connectorRegistryError("External connector activation source does not match its capability probe."),
			);
		}
		const truthResult = capabilityTruth(
			implementation.providerId,
			snapshot,
			implementation,
			this.#options.toolGateway,
		);
		if (!truthResult.ok) return truthResult;
		const storedDescriptor = cloneConnectorDescriptor(descriptor);
		if (this.#disposed || this.#pendingRegistrations.get(descriptor.providerId) !== pending) {
			return Result.err(connectorRegistryError("External connector registry is disposed."));
		}
		const stored: RegisteredConnector = {
			descriptor: storedDescriptor,
			connector,
			implementation,
			implementationProof: pending.implementationProof,
			selectedConnectors: new WeakMap(),
			capabilitySnapshot: snapshot,
			capabilityTruth: truthResult.value,
			activationSource,
		};
		const startupStatus = getProductionExternalConnectorStartupStatus(connector);
		const status = startupStatus?.readiness === "quarantined" ? "quarantined" : "ready";
		const state = startupStatus?.readiness === "quarantined" ? "quarantined" : "current";
		const reasonCode = startupStatus?.readiness === "quarantined" ? "cleanup_unconfirmed" : "ready";
		const observedAtMs = this.#nowMs();
		if (!this.#activationSourceIsCurrent(activationSource)) {
			this.#publishReadiness(activationSource, "quarantined", "source_changed", "quarantined");
			return Result.err(
				connectorRegistryError("External connector activation source changed before readiness publication."),
			);
		}
		if (this.#disposed || this.#pendingRegistrations.get(descriptor.providerId) !== pending) {
			return Result.err(connectorRegistryError("External connector registry is disposed."));
		}
		const readinessSnapshot = this.#createReadinessSnapshot(
			activationSource,
			status,
			reasonCode,
			state,
			observedAtMs,
		);
		this.#connectors.set(descriptor.providerId, stored);
		this.#readinessSnapshots.set(descriptor.providerId, readinessSnapshot);
		return Result.ok(storedDescriptor);
	}

	async select(
		selection: ExternalConnectorSelection,
		_options?: FoundationProviderExecutionOptions,
	): Promise<ResultValue<ExternalConnectorResolvedSelection, FoundationError>> {
		if (this.#disposed) return Result.err(connectorRegistryError("External connector registry is disposed."));
		if (!isExternalConnectorSelection(selection)) {
			return Result.err(
				connectorRegistryError(
					"External connector selection must pin an exact provider id, revision, and capability snapshot digest.",
				),
			);
		}
		const registered = this.#connectors.get(selection.providerId);
		if (
			registered === undefined ||
			selection.revision !== registered.descriptor.revision ||
			!sameFingerprint(selection.capabilitySnapshotDigest, registered.descriptor.capabilitySnapshotDigest)
		) {
			return Result.err(
				connectorRegistryError("External connector selection is unknown or does not match its pinned descriptor."),
			);
		}
		const readiness = this.#resolvePublishedReadiness(registered, true, false);
		if (!readiness.ok) return readiness;
		const readinessSnapshot = readiness.value;
		const capabilitySnapshot = registered.capabilitySnapshot;
		const capabilityTruthSnapshot = registered.capabilityTruth;
		let selectedConnector = registered.selectedConnectors.get(readinessSnapshot);
		if (selectedConnector === undefined) {
			selectedConnector = createCapabilityPinnedConnector(
				registered.connector,
				registered.implementation,
				async (execution) => {
					const verified = await this.#verifyRegisteredConnector(
						registered,
						execution,
						true,
						false,
						readinessSnapshot,
					);
					return verified.ok ? Result.ok(verified.value.snapshot) : Result.err(verified.error);
				},
				async (execution) => {
					const verified = await this.#verifyRegisteredConnector(
						registered,
						execution,
						false,
						false,
						readinessSnapshot,
					);
					return verified.ok ? Result.ok(verified.value.snapshot) : Result.err(verified.error);
				},
			);
			registered.selectedConnectors.set(readinessSnapshot, selectedConnector);
		}
		let toolGatewayCatalog: CapturedExternalConnectorToolGatewayCatalog | undefined;
		if (capabilitySnapshot.toolGateway) {
			const toolGateway = this.#options.toolGateway;
			if (toolGateway === undefined) {
				return Result.err(new FoundationError("external_connector_not_ready", "External connector Tool Gateway is not ready."));
			}
			const captured = routeCatalogForGateway(toolGateway);
			if (!captured.ok) return captured;
			toolGatewayCatalog = captured.value;
		}
		const executeToolGateway = async (
			request: ToolGatewayRequest,
			options?: { readonly signal?: AbortSignal },
		): Promise<ResultValue<ToolExecutionResult, FoundationError>> => {
			const current = await this.#verifyRegisteredConnector(
				registered,
				options,
				true,
				false,
				readinessSnapshot,
			);
			if (!current.ok) return Result.err(lifecycleCapabilityError());
			if (!current.value.truth.capabilities.toolGateway) {
				return Result.err(connectorRegistryError("External connector does not support the Tool Gateway bridge."));
			}
			const checkedRequest = validateToolGatewayRequest(request);
			if (!checkedRequest.ok) return checkedRequest;
			const canonicalRequest = cloneDeepFrozen(checkedRequest.value);
			const toolGateway = this.#options.toolGateway;
			if (toolGateway === undefined) {
				return Result.err(connectorRegistryError("External connector Tool Gateway handler is unavailable."));
			}
			if (options?.signal?.aborted === true) {
				return Result.err(
					new FoundationError("provider_spawn_failed", "External connector Tool Gateway request was aborted."),
				);
			}
			let result: unknown;
			try {
				result = await Reflect.apply(toolGateway.execute, toolGateway, [canonicalRequest, options ?? {}]);
			} catch {
				return Result.err(
					new FoundationError("provider_spawn_failed", "External connector Tool Gateway handler failed."),
				);
			}
			if (!isConnectorRecord(result) || typeof result.ok !== "boolean") {
				return Result.err(
					connectorRegistryError("External connector Tool Gateway handler returned a malformed result."),
				);
			}
			if (!result.ok) {
				if (!hasExactConnectorKeys(result, RESULT_ERROR_KEYS) || !FoundationError.is(result.error)) {
					return Result.err(
						connectorRegistryError("External connector Tool Gateway handler returned a malformed failure."),
					);
				}
				return EXTERNAL_CONNECTOR_TOOL_GATEWAY_ROUTE_DENIAL_CODES.has(result.error.code)
					? Result.ok(externalConnectorToolGatewayDeniedResult(canonicalRequest))
					: Result.err(result.error);
			}
			if (!hasExactConnectorKeys(result, RESULT_OK_KEYS)) {
				return Result.err(
					connectorRegistryError("External connector Tool Gateway handler returned a malformed result."),
				);
			}
			const checkedResult = validateToolExecutionResult(result.value);
			if (!checkedResult.ok) return checkedResult;
			if (
				checkedResult.value.toolCallId !== canonicalRequest.toolCallId ||
				checkedResult.value.toolName !== canonicalRequest.toolName
			) {
				return Result.err(
					connectorRegistryError("External connector Tool Gateway result does not match its request."),
				);
			}
			if (
				!checkedResult.value.ok &&
				checkedResult.value.error !== undefined &&
				EXTERNAL_CONNECTOR_TOOL_GATEWAY_POLICY_DENIAL_CODES.has(checkedResult.value.error.code)
			) {
				return Result.ok(externalConnectorToolGatewayDeniedResult(canonicalRequest));
			}
			return Result.ok(cloneDeepFrozen(checkedResult.value));
		};
		const currentReadiness = this.#resolvePublishedReadiness(registered, true, false, readinessSnapshot);
		if (!currentReadiness.ok) return currentReadiness;
		const resolvedSelection: ExternalConnectorResolvedSelection = Object.freeze({
			descriptor: registered.descriptor,
			connector: selectedConnector,
			capabilitySnapshot,
			capabilityTruth: capabilityTruthSnapshot,
		});
		const settleRecoveryFailure = getHostSupervisedExternalConnectorRecoveryFailureSettler(registered.connector);
		if (settleRecoveryFailure !== undefined) {
			externalConnectorRecoveryFailureSettlers.set(resolvedSelection, settleRecoveryFailure);
		}
		if (capabilitySnapshot.toolGateway) {
			if (registered.implementation.bindToolGatewayConsumer === undefined || toolGatewayCatalog === undefined) {
				return Result.err(
					new FoundationError(
						"external_connector_not_ready",
						"External connector Tool Gateway consumer authority is not ready.",
					),
				);
			}
			externalConnectorToolGatewayCatalogs.set(resolvedSelection, toolGatewayCatalog);
			const bindToolGatewayConsumer: ExternalConnectorToolGatewayConsumerBinder = (attemptId, binding, policyBinding) =>
				Reflect.apply(registered.implementation.bindToolGatewayConsumer!, registered.connector, [
					attemptId,
					scopedToolGatewayConsumer(toolGatewayCatalog, attemptId, binding, policyBinding, executeToolGateway),
				]);
			externalConnectorToolGatewayConsumerBinders.set(resolvedSelection, bindToolGatewayConsumer);
		}
		return Result.ok(resolvedSelection);
	}

	list(): readonly ExternalConnectorDescriptor[] {
		return Object.freeze([...this.#connectors.values()].map(({ descriptor }) => descriptor));
	}

	readiness(): readonly ExternalConnectorReadinessStatus[] {
		const nowMs = this.#nowMs();
		return Object.freeze(
			[...this.#readinessSnapshots.values()].map((snapshot): ExternalConnectorReadinessStatus =>
				Object.freeze({
					schemaVersion: 1,
					providerId: snapshot.providerId,
					trust: "host_configured",
					status:
						snapshot.status === "ready" && !externalConnectorReadinessSnapshotIsCurrent(snapshot, nowMs)
							? "not_ready"
							: snapshot.status,
					reasonCode:
						snapshot.status === "ready" && !externalConnectorReadinessSnapshotIsCurrent(snapshot, nowMs)
							? "snapshot_stale"
							: snapshot.reasonCode,
				}),
			),
		);
	}

	readinessSnapshots(): readonly ExternalConnectorReadinessSnapshot[] {
		return Object.freeze([...this.#readinessSnapshots.values()]);
	}

	runtimeStatus(): readonly ConnectorRuntimeStatus[] {
		const nowMs = this.#nowMs();
		const source = this.#options.runtimeStatusSource;
		return Object.freeze(
			[...this.#readinessSnapshots.values()]
				.sort((left, right) => left.providerId.localeCompare(right.providerId))
				.map((readinessSnapshot) => {
					let runtimeSnapshot: unknown;
					try {
						runtimeSnapshot = source?.read(readinessSnapshot.providerId);
					} catch {
						runtimeSnapshot = null;
					}
					return projectConnectorRuntimeStatus({
						providerId: readinessSnapshot.providerId,
						readinessSnapshot,
						runtimeSnapshot,
						nowMs,
					});
				}),
		);
	}

	async probeReadiness(selection: ExternalConnectorSelection): Promise<ExternalConnectorReadinessStatus> {
		const providerId = selection.providerId;
		const statusFor = (snapshot: ExternalConnectorReadinessSnapshot): ExternalConnectorReadinessStatus =>
			Object.freeze({
				schemaVersion: 1,
				providerId: snapshot.providerId,
				trust: "host_configured",
				status: snapshot.status,
				reasonCode: snapshot.reasonCode,
			});
		const existing = this.#readinessSnapshots.get(providerId);
		if (existing?.state === "quarantined") return statusFor(existing);
		if (!isExternalConnectorSelection(selection)) {
			return Object.freeze({
				schemaVersion: 1,
				providerId,
				trust: "host_configured",
				status: "not_ready",
				reasonCode: "probe_failed",
			});
		}
		const registered = this.#connectors.get(providerId);
		if (
			registered === undefined ||
			selection.revision !== registered.descriptor.revision ||
			!sameFingerprint(selection.capabilitySnapshotDigest, registered.descriptor.capabilitySnapshotDigest)
		) {
			return Object.freeze({
				schemaVersion: 1,
				providerId: selection.providerId,
				trust: "host_configured",
				status: "not_ready",
				reasonCode: "probe_failed",
			});
		}
		const verified = await this.#verifyRegisteredConnector(registered, undefined, true, true);
		let current = this.#readinessSnapshots.get(providerId);
		if (!verified.ok && current === existing && !this.#disposed) {
			current = this.#publishReadiness(registered.activationSource, "not_ready", "probe_failed", "current");
		}
		return current === undefined
			? Object.freeze({
					schemaVersion: 1,
					providerId,
					trust: "host_configured",
					status: "not_ready",
					reasonCode: "probe_failed",
				})
			: statusFor(current);
	}

	dispose(): Promise<void> {
		if (this.#disposal !== undefined) return this.#disposal;
		this.#disposed = true;
		this.#lifetime.abort();
		const connectors: readonly PendingConnector[] = [
			...Array.from(this.#connectors.values(), ({ connector, implementation, implementationProof }) => ({
				connector,
				implementation,
				implementationProof,
			})),
			...this.#pendingRegistrations.values(),
		];
		this.#connectors.clear();
		this.#pendingRegistrations.clear();
		this.#readinessSnapshots.clear();
		this.#disposal = Promise.all(
			connectors.map(({ connector, implementation }) => this.#disposeConnectorBounded(connector, implementation)),
		).then((results) => {
			if (results.some((confirmed) => !confirmed)) {
				throw connectorRegistryShutdownError();
			}
		});
		return this.#disposal;
	}
}

/** Create the single open External Connector registry. */
export function createExternalConnectorRegistry(
	options: ExternalConnectorRegistryOptions = {},
): ExternalConnectorRegistry {
	return new ExternalConnectorRegistryImpl(options);
}
