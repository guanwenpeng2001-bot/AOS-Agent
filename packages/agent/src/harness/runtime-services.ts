/** Provider-neutral runtime service, hook, and extension lifecycle contracts. */
import { FoundationError, toFoundationError } from "./foundation/errors.ts";
import { FOUNDATION_SCHEMA_VERSION } from "./foundation/identity.ts";
import type { FoundationJsonValue } from "./foundation/event-catalog.ts";
import type { ExtensionContract, LspExtensionContract, MonitorExtensionContract } from "./foundation/profile.ts";
import type { ToolDefinition } from "./tool-pipeline.ts";
import { Result, type ResultValue } from "./result.ts";

export type RuntimeServiceDependency = string | { serviceId: string; version?: string };

/** Stable service identity. Providers are represented by ids, never executed here. */
export interface RuntimeService {
	schemaVersion: typeof FOUNDATION_SCHEMA_VERSION;
	serviceId: string;
	version: string;
	providerId: string;
	dependencies: readonly RuntimeServiceDependency[];
	capabilities: readonly string[];
	lifecycle: "managed" | "ephemeral" | "external";
	consumers?: readonly string[];
	createdAt: string;
}

export interface RuntimeServiceRegistrationInput {
	serviceId: string;
	version: string;
	providerId: string;
	dependencies?: readonly RuntimeServiceDependency[];
	capabilities?: readonly string[];
	lifecycle?: RuntimeService["lifecycle"];
	consumers?: readonly string[];
	createdAt?: string;
}

export type ServiceConflictKind =
	| "duplicate"
	| "version_mismatch"
	| "provider_mismatch"
	| "dependency_version_mismatch";

export interface ServiceConflictReport {
	kind: ServiceConflictKind;
	serviceId: string;
	registered: { version: string; providerId: string };
	incoming: { version: string; providerId: string };
	dependency?: string;
	requiredVersion?: string;
	actualVersion?: string;
}

export interface ServiceValidationReport {
	serviceId: string;
	missingDependencies: readonly string[];
	conflicts: readonly ServiceConflictReport[];
}

export interface ServiceStartReport {
	/** Dependencies always precede dependents; ties are broken by service id. */
	order: readonly string[];
	conflicts: readonly ServiceConflictReport[];
}

export interface RuntimeServiceDAG {
	services: readonly RuntimeService[];
	version: string;
	order: readonly string[];
}

function dependencyId(dependency: RuntimeServiceDependency): string {
	return typeof dependency === "string" ? dependency : dependency.serviceId;
}

function dependencyVersion(dependency: RuntimeServiceDependency): string | undefined {
	return typeof dependency === "string" ? undefined : dependency.version;
}

function validateServiceInput(input: RuntimeServiceRegistrationInput): void {
	if (input.serviceId.trim().length === 0) throw new TypeError("Runtime service id must not be empty");
	if (input.version.trim().length === 0) throw new TypeError("Runtime service version must not be empty");
	if (input.providerId.trim().length === 0) throw new TypeError("Runtime service provider id must not be empty");
	for (const dependency of input.dependencies ?? []) {
		const id = dependencyId(dependency);
		if (id.trim().length === 0) throw new TypeError("Runtime service dependency id must not be empty");
		if (dependencyVersion(dependency)?.trim().length === 0) throw new TypeError("Runtime service dependency version must not be empty");
	}
}

export function createRuntimeService(input: RuntimeServiceRegistrationInput): RuntimeService {
	validateServiceInput(input);
	return {
		schemaVersion: FOUNDATION_SCHEMA_VERSION,
		serviceId: input.serviceId,
		version: input.version,
		providerId: input.providerId,
		dependencies: [...(input.dependencies ?? [])].map((dependency) => typeof dependency === "string" ? dependency : { serviceId: dependency.serviceId, ...(dependency.version === undefined ? {} : { version: dependency.version }) }),
		capabilities: [...(input.capabilities ?? [])],
		lifecycle: input.lifecycle ?? "managed",
		...(input.consumers === undefined ? {} : { consumers: [...input.consumers] }),
		createdAt: input.createdAt ?? new Date().toISOString(),
	};
}

function conflictForPair(registered: RuntimeServiceRegistrationInput, incoming: RuntimeServiceRegistrationInput): ServiceConflictReport {
	return {
		kind: registered.version !== incoming.version ? "version_mismatch" : registered.providerId !== incoming.providerId ? "provider_mismatch" : "duplicate",
		serviceId: incoming.serviceId,
		registered: { version: registered.version, providerId: registered.providerId },
		incoming: { version: incoming.version, providerId: incoming.providerId },
	};
}

/** Return deterministic missing-dependency and duplicate/version reports. */
export function validateRuntimeServiceRegistrations(
	inputs: readonly RuntimeServiceRegistrationInput[],
): readonly ServiceValidationReport[] {
	const byId = new Map<string, RuntimeServiceRegistrationInput[]>();
	for (const input of inputs) {
		const group = byId.get(input.serviceId) ?? [];
		group.push(input);
		byId.set(input.serviceId, group);
	}
	return [...byId.keys()].sort().map((serviceId) => {
		const group = byId.get(serviceId)!;
		const first = group[0]!;
		const conflicts: ServiceConflictReport[] = [];
		for (const incoming of group.slice(1)) conflicts.push(conflictForPair(first, incoming));
		const missingDependencies = [...new Set((first.dependencies ?? []).map(dependencyId).filter((id) => !byId.has(id)))].sort();
		return { serviceId, missingDependencies, conflicts };
	});
}

function serviceConflictDetails(conflicts: readonly ServiceConflictReport[]): FoundationJsonValue {
	return conflicts.map((conflict) => ({
		kind: conflict.kind,
		serviceId: conflict.serviceId,
		registered: { ...conflict.registered },
		incoming: { ...conflict.incoming },
		...(conflict.dependency === undefined ? {} : { dependency: conflict.dependency }),
		...(conflict.requiredVersion === undefined ? {} : { requiredVersion: conflict.requiredVersion }),
		...(conflict.actualVersion === undefined ? {} : { actualVersion: conflict.actualVersion }),
	}));
}

function topoSortServices(
	services: readonly RuntimeServiceRegistrationInput[],
): ResultValue<readonly string[], FoundationError> {
	const byId = new Map<string, RuntimeServiceRegistrationInput>();
	for (const input of services) {
		if (byId.has(input.serviceId)) {
			return Result.err(new FoundationError("service_conflict", "runtime service id is registered more than once", { details: { serviceId: input.serviceId } }));
		}
		byId.set(input.serviceId, input);
	}
	const dependents = new Map<string, Set<string>>();
	const inDegree = new Map<string, number>();
	for (const input of services) inDegree.set(input.serviceId, 0);
	for (const input of services) {
		for (const dependency of input.dependencies ?? []) {
			const id = dependencyId(dependency);
			const provider = byId.get(id);
			if (provider === undefined) {
				return Result.err(new FoundationError("service_conflict", "runtime service dependency is missing", { details: { serviceId: input.serviceId, dependency: id } }));
			}
			const requiredVersion = dependencyVersion(dependency);
			if (requiredVersion !== undefined && provider.version !== requiredVersion) {
				return Result.err(new FoundationError("service_conflict", "runtime service dependency version conflicts", {
					details: { serviceId: input.serviceId, dependency: id, requiredVersion, actualVersion: provider.version },
				}));
			}
			const list = dependents.get(id) ?? new Set<string>();
			if (!list.has(input.serviceId)) {
				list.add(input.serviceId);
				inDegree.set(input.serviceId, inDegree.get(input.serviceId)! + 1);
			}
			dependents.set(id, list);
		}
	}
	const ready = [...inDegree.entries()].filter(([, degree]) => degree === 0).map(([id]) => id).sort();
	const order: string[] = [];
	while (ready.length > 0) {
		const current = ready.shift()!;
		order.push(current);
		for (const dependent of [...(dependents.get(current) ?? [])].sort()) {
			const degree = inDegree.get(dependent)! - 1;
			inDegree.set(dependent, degree);
			if (degree === 0) {
				ready.push(dependent);
				ready.sort();
			}
		}
	}
	if (order.length !== services.length) {
		const cyclic = [...inDegree.entries()].filter(([, degree]) => degree > 0).map(([id]) => id).sort();
		return Result.err(new FoundationError("service_cycle", "runtime service dependency graph contains a cycle", { details: { cyclic } }));
	}
	return Result.ok(order);
}

/** Validate missing dependencies, duplicate/version conflicts, version requirements, and cycles. */
export function validateRuntimeServiceDAG(
	inputs: readonly RuntimeServiceRegistrationInput[],
): ResultValue<RuntimeServiceDAG, FoundationError> {
	for (const input of inputs) validateServiceInput(input);
	const reports = validateRuntimeServiceRegistrations(inputs);
	const conflicts = reports.flatMap((report) => report.conflicts);
	if (conflicts.length > 0) {
		return Result.err(new FoundationError("service_conflict", "runtime service registrations conflict", { details: { conflicts: serviceConflictDetails(conflicts) } }));
	}
	const missing = reports.filter((report) => report.missingDependencies.length > 0);
	if (missing.length > 0) {
		return Result.err(new FoundationError("service_conflict", "runtime service dependencies are missing", {
			details: { missing: missing.map((report) => ({ serviceId: report.serviceId, dependencies: [...report.missingDependencies] })) },
		}));
	}
	const orderResult = topoSortServices(inputs);
	if (!orderResult.ok) return orderResult;
	const sourceById = new Map(inputs.map((input) => [input.serviceId, createRuntimeService(input)]));
	return Result.ok({
		services: orderResult.value.map((id) => sourceById.get(id)!),
		version: "1",
		order: orderResult.value,
	});
}

/** Registry that deduplicates exact registrations and rejects conflicting identities. */
export class RuntimeServiceRegistry {
	readonly #services = new Map<string, RuntimeService>();
	readonly #conflicts: ServiceConflictReport[] = [];

	register(input: RuntimeServiceRegistrationInput): ResultValue<RuntimeService, FoundationError> {
		validateServiceInput(input);
		const existing = this.#services.get(input.serviceId);
		if (existing === undefined) {
			const service = createRuntimeService(input);
			this.#services.set(service.serviceId, service);
			return Result.ok(service);
		}
		const incoming = createRuntimeService(input);
		if (existing.version !== incoming.version || existing.providerId !== incoming.providerId) {
			const conflict = conflictForPair(
				{ serviceId: existing.serviceId, version: existing.version, providerId: existing.providerId },
				{ serviceId: incoming.serviceId, version: incoming.version, providerId: incoming.providerId },
			);
			this.#conflicts.push(conflict);
			return Result.err(new FoundationError("service_conflict", "runtime service version/provider conflict", { details: serviceConflictDetails([conflict]) }));
		}
		return Result.ok(existing);
	}

	registerService(input: RuntimeServiceRegistrationInput): ResultValue<RuntimeService, FoundationError> {
		return this.register(input);
	}

	has(serviceId: string): boolean {
		return this.#services.has(serviceId);
	}

	get(serviceId: string): RuntimeService | undefined {
		return this.#services.get(serviceId);
	}

	get services(): readonly RuntimeService[] {
		return [...this.#services.values()].sort((left, right) => left.serviceId.localeCompare(right.serviceId));
	}

	getConflicts(): readonly ServiceConflictReport[] {
		return this.#conflicts.map((conflict) => ({ ...conflict, registered: { ...conflict.registered }, incoming: { ...conflict.incoming } }));
	}

	validate(): ResultValue<RuntimeServiceDAG, FoundationError> {
		return validateRuntimeServiceDAG(this.services);
	}

	start(): ResultValue<ServiceStartReport, FoundationError> {
		const validation = this.validate();
		if (!validation.ok) return validation;
		return Result.ok({ order: validation.value.order, conflicts: this.getConflicts() });
	}

	planStart(): ResultValue<ServiceStartReport, FoundationError> {
		return this.start();
	}
}

// ---------------------------------------------------------------------------
// Versioned dynamic tools
// ---------------------------------------------------------------------------

export interface RuntimeToolRegistration {
	tool: ToolDefinition;
	providerId: string;
	version: string;
	revision: number;
	overrideOf?: { providerId: string; version: string; revision: number };
}

export class RuntimeToolRegistry {
	readonly #tools = new Map<string, RuntimeToolRegistration>();

	register(registration: RuntimeToolRegistration): ResultValue<RuntimeToolRegistration, FoundationError> {
		if (registration.providerId.trim().length === 0 || registration.version.trim().length === 0 || !Number.isSafeInteger(registration.revision) || registration.revision < 0 || registration.tool.toolRevision.revision !== registration.revision) return Result.err(new FoundationError("invalid_identifier", "dynamic tool registration identity is invalid"));
		const key = runtimeToolKey(registration.tool.name, registration.tool.namespace);
		const current = this.#tools.get(key);
		if (current === undefined) {
			this.#tools.set(key, registration);
			return Result.ok(registration);
		}
		if (current.providerId === registration.providerId && current.version === registration.version && current.revision === registration.revision) return Result.ok(current);
		const override = registration.overrideOf;
		if (override === undefined || override.providerId !== current.providerId || override.version !== current.version || override.revision !== current.revision || registration.revision <= current.revision) {
			return Result.err(new FoundationError("profile_conflict", "dynamic tool registration conflicts with the active version", { details: { tool: key, activeRevision: current.revision, incomingRevision: registration.revision } }));
		}
		this.#tools.set(key, registration);
		return Result.ok(registration);
	}

	registerTool(registration: RuntimeToolRegistration): ResultValue<RuntimeToolRegistration, FoundationError> { return this.register(registration); }

	reload(registration: RuntimeToolRegistration): ResultValue<RuntimeToolRegistration, FoundationError> { return this.register(registration); }

	unregister(toolName: string, namespace?: string, expectedRevision?: number): ResultValue<void, FoundationError> {
		const key = runtimeToolKey(toolName, namespace);
		const current = this.#tools.get(key);
		if (current === undefined) return Result.err(new FoundationError("invalid_identifier", "dynamic tool is not registered", { details: { tool: key } }));
		if (expectedRevision !== undefined && expectedRevision !== current.revision) return Result.err(new FoundationError("profile_conflict", "dynamic tool revision changed before unregister"));
		this.#tools.delete(key);
		return Result.ok(undefined);
	}

	resolve(toolName: string, namespace?: string): ToolDefinition | undefined { return this.#tools.get(runtimeToolKey(toolName, namespace))?.tool; }

	snapshot(): readonly RuntimeToolRegistration[] { return [...this.#tools.values()].sort((left, right) => runtimeToolKey(left.tool.name, left.tool.namespace).localeCompare(runtimeToolKey(right.tool.name, right.tool.namespace))); }
}

function runtimeToolKey(toolName: string, namespace?: string): string {
	return `${namespace ?? ""}\u0000${toolName}`;
}

// ---------------------------------------------------------------------------
// Deterministic hook ordering
// ---------------------------------------------------------------------------

export type RuntimeHookPhase = "before" | "after" | "observe";
export type RuntimeHookConflictPolicy = "error" | "first" | "last";

export interface RuntimeHookSpec {
	hookId: string;
	phase: RuntimeHookPhase;
	priority: number;
	before?: readonly string[];
	after?: readonly string[];
	conflict?: RuntimeHookConflictPolicy;
	capabilities?: readonly string[];
}

export type HookConflictKind = "cycle" | "unknown_reference" | "duplicate";

export interface HookConflict {
	hookId: string;
	relatedHookId: string;
	kind: HookConflictKind;
	reason?: string;
}

export interface HookOrderReport {
	order: readonly string[];
	conflicts: readonly HookConflict[];
}

interface HookEdgeV1 {
	from: string;
	to: string;
}

function hookComparator(byId: ReadonlyMap<string, RuntimeHookSpec>): (left: string, right: string) => number {
	return (left, right) => {
		const leftSpec = byId.get(left)!;
		const rightSpec = byId.get(right)!;
		const phaseOrder: Record<RuntimeHookPhase, number> = { before: 0, observe: 1, after: 2 };
		return phaseOrder[leftSpec.phase] - phaseOrder[rightSpec.phase] || leftSpec.priority - rightSpec.priority || left.localeCompare(right);
	};
}

function hookPolicy(spec: RuntimeHookSpec | undefined): RuntimeHookConflictPolicy {
	return spec?.conflict ?? "error";
}

function hookOrderFromEdges(
	byId: ReadonlyMap<string, RuntimeHookSpec>,
	edges: readonly HookEdgeV1[],
): { order: string[]; remaining: Set<string> } {
	const adjacency = new Map<string, Set<string>>();
	const inDegree = new Map<string, number>();
	for (const id of byId.keys()) {
		adjacency.set(id, new Set());
		inDegree.set(id, 0);
	}
	for (const edge of edges) {
		const set = adjacency.get(edge.from)!;
		if (!set.has(edge.to)) {
			set.add(edge.to);
			inDegree.set(edge.to, inDegree.get(edge.to)! + 1);
		}
	}
	const compare = hookComparator(byId);
	const ready = [...inDegree.entries()].filter(([, degree]) => degree === 0).map(([id]) => id).sort(compare);
	const order: string[] = [];
	while (ready.length > 0) {
		const current = ready.shift()!;
		order.push(current);
		for (const dependent of [...adjacency.get(current)!].sort(compare)) {
			const degree = inDegree.get(dependent)! - 1;
			inDegree.set(dependent, degree);
			if (degree === 0) {
				ready.push(dependent);
				ready.sort(compare);
			}
		}
	}
	return { order, remaining: new Set([...inDegree.entries()].filter(([, degree]) => degree > 0).map(([id]) => id)) };
}

/**
 * Order hooks by priority and id, while treating before/after as hard edges.
 * A hard edge wins over priority; cycles and unknown references are reported
 * and only non-error conflict policies may deterministically drop a cycle edge.
 */
export function orderRuntimeHooks(specs: readonly RuntimeHookSpec[]): ResultValue<HookOrderReport, FoundationError> {
	const byId = new Map<string, RuntimeHookSpec>();
	const conflicts: HookConflict[] = [];
	for (const spec of specs) {
		if (spec.hookId.trim().length === 0 || !Number.isFinite(spec.priority)) {
			return Result.err(new FoundationError("profile_conflict", "hook id and priority are required"));
		}
		if (byId.has(spec.hookId)) conflicts.push({ hookId: spec.hookId, relatedHookId: spec.hookId, kind: "duplicate" });
		else byId.set(spec.hookId, spec);
	}
	if (conflicts.length > 0) {
		return Result.err(new FoundationError("profile_conflict", "hook ids must be unique", { details: { conflicts: conflicts.map((item) => ({ ...item })) } }));
	}
	const edges: HookEdgeV1[] = [];
	for (const spec of specs) {
		for (const target of [...(spec.before ?? [])].sort()) {
			if (!byId.has(target)) {
				const conflict = { hookId: spec.hookId, relatedHookId: target, kind: "unknown_reference" as const };
				conflicts.push(conflict);
				continue;
			}
			edges.push({ from: spec.hookId, to: target });
		}
		for (const target of [...(spec.after ?? [])].sort()) {
			if (!byId.has(target)) {
				const conflict = { hookId: spec.hookId, relatedHookId: target, kind: "unknown_reference" as const };
				conflicts.push(conflict);
				continue;
			}
			edges.push({ from: target, to: spec.hookId });
		}
	}
	const strictUnknown = conflicts.filter((conflict) => conflict.kind === "unknown_reference" && hookPolicy(byId.get(conflict.hookId)) === "error");
	if (strictUnknown.length > 0) {
		return Result.err(new FoundationError("profile_conflict", "hook ordering references an unknown hook", { details: { conflicts: strictUnknown.map((item) => ({ ...item })) } }));
	}

	let workingEdges = [...edges];
	for (;;) {
		const sorted = hookOrderFromEdges(byId, workingEdges);
		if (sorted.remaining.size === 0) return Result.ok({ order: sorted.order, conflicts });
		const cycleEdges = workingEdges
			.filter((edge) => sorted.remaining.has(edge.from) && sorted.remaining.has(edge.to))
			.sort((left, right) => left.from.localeCompare(right.from) || left.to.localeCompare(right.to));
		const strictCycle = cycleEdges.filter((edge) => hookPolicy(byId.get(edge.from)) === "error");
		if (strictCycle.length > 0 || cycleEdges.length === 0) {
			const cycleConflicts = cycleEdges.map((edge) => ({ hookId: edge.from, relatedHookId: edge.to, kind: "cycle" as const }));
			return Result.err(new FoundationError("profile_conflict", "hook ordering contains a cycle", { details: { conflicts: cycleConflicts.map((item) => ({ ...item })) } }));
		}
		const chosen = cycleEdges[0]!;
		const chosenPolicy = hookPolicy(byId.get(chosen.from));
		const index = chosenPolicy === "last" ? cycleEdges.length - 1 : 0;
		const removed = cycleEdges[index]!;
		workingEdges = workingEdges.filter((edge) => edge.from !== removed.from || edge.to !== removed.to);
		conflicts.push({ hookId: removed.from, relatedHookId: removed.to, kind: "cycle", reason: `resolved by ${chosenPolicy} conflict policy` });
	}
}

// ---------------------------------------------------------------------------
// Effect scopes
// ---------------------------------------------------------------------------

export type EffectResourceKind = "tool" | "hook" | "mcp" | "lsp" | "monitor" | "bin" | "settings" | "listener" | "timer" | "process";
export const EFFECT_RESOURCE_KINDS: readonly EffectResourceKind[] = ["tool", "hook", "mcp", "lsp", "monitor", "bin", "settings", "listener", "timer", "process"];
export type EffectDisposer = () => void | Promise<void>;

export interface EffectRegistration {
	kind: EffectResourceKind;
	resourceId: string;
	dispose: EffectDisposer;
}

export interface EffectDisposeFailure {
	kind: EffectResourceKind;
	resourceId: string;
	error: unknown;
}

export interface EffectScopeReport {
	schemaVersion: typeof FOUNDATION_SCHEMA_VERSION;
	disposed: readonly string[];
	failures: readonly EffectDisposeFailure[];
	rolledBack: boolean;
}

/** Registration scope with idempotent LIFO disposal and individual release. */
export class EffectScope {
	readonly #registrations = new Map<string, EffectRegistration>();
	readonly #order: string[] = [];
	#closed = false;

	register(registration: EffectRegistration): ResultValue<string, FoundationError>;
	register(kind: EffectResourceKind, resourceId: string, dispose: EffectDisposer): ResultValue<string, FoundationError>;
	register(registrationOrKind: EffectRegistration | EffectResourceKind, resourceId?: string, dispose?: EffectDisposer): ResultValue<string, FoundationError> {
		const registration: EffectRegistration = typeof registrationOrKind === "string"
			? { kind: registrationOrKind, resourceId: resourceId ?? "", dispose: dispose ?? (() => undefined) }
			: registrationOrKind;
		if (this.#closed) return Result.err(new FoundationError("profile_conflict", "effect scope is already closed"));
		if (registration.resourceId.trim().length === 0) return Result.err(new FoundationError("invalid_identifier", "effect resource id must not be empty"));
		if (this.#registrations.has(registration.resourceId)) return Result.err(new FoundationError("profile_conflict", "effect resource is already registered", { details: { resourceId: registration.resourceId } }));
		this.#registrations.set(registration.resourceId, registration);
		this.#order.push(registration.resourceId);
		return Result.ok(registration.resourceId);
	}

	registerResource(registration: EffectRegistration): ResultValue<string, FoundationError> {
		return this.register(registration);
	}

	get size(): number {
		return this.#registrations.size;
	}

	get closed(): boolean {
		return this.#closed;
	}

	has(resourceId: string): boolean {
		return this.#registrations.has(resourceId);
	}

	/** Remove a registration after an explicit caller-owned cleanup. */
	remove(resourceId: string): boolean {
		if (!this.#registrations.delete(resourceId)) return false;
		const index = this.#order.indexOf(resourceId);
		if (index >= 0) this.#order.splice(index, 1);
		return true;
	}

	async release(resourceId: string): Promise<EffectScopeReport> {
		const registration = this.#registrations.get(resourceId);
		if (registration === undefined) return this.emptyReport(false);
		this.remove(resourceId);
		try {
			await registration.dispose();
			return { schemaVersion: FOUNDATION_SCHEMA_VERSION, disposed: [resourceId], failures: [], rolledBack: false };
		} catch (error) {
			return { schemaVersion: FOUNDATION_SCHEMA_VERSION, disposed: [resourceId], failures: [{ kind: registration.kind, resourceId, error }], rolledBack: false };
		}
	}

	async dispose(): Promise<EffectScopeReport> {
		if (this.#closed) return this.emptyReport(false);
		this.#closed = true;
		const disposed: string[] = [];
		const failures: EffectDisposeFailure[] = [];
		for (const resourceId of [...this.#order].reverse()) {
			const registration = this.#registrations.get(resourceId);
			if (registration === undefined) continue;
			this.#registrations.delete(resourceId);
			disposed.push(resourceId);
			try {
				await registration.dispose();
			} catch (error) {
				failures.push({ kind: registration.kind, resourceId, error });
			}
		}
		this.#order.length = 0;
		return { schemaVersion: FOUNDATION_SCHEMA_VERSION, disposed, failures, rolledBack: false };
	}

	async rollback(): Promise<EffectScopeReport> {
		const report = await this.dispose();
		return { ...report, rolledBack: true };
	}

	private emptyReport(rolledBack: boolean): EffectScopeReport {
		return { schemaVersion: FOUNDATION_SCHEMA_VERSION, disposed: [], failures: [], rolledBack };
	}

	registerTool(resourceId: string, dispose: EffectDisposer): ResultValue<string, FoundationError> { return this.register("tool", resourceId, dispose); }
	registerHook(resourceId: string, dispose: EffectDisposer): ResultValue<string, FoundationError> { return this.register("hook", resourceId, dispose); }
	registerMCP(resourceId: string, dispose: EffectDisposer): ResultValue<string, FoundationError> { return this.register("mcp", resourceId, dispose); }
	registerMcp(resourceId: string, dispose: EffectDisposer): ResultValue<string, FoundationError> { return this.registerMCP(resourceId, dispose); }
	registerLSP(resourceId: string, dispose: EffectDisposer): ResultValue<string, FoundationError> { return this.register("lsp", resourceId, dispose); }
	registerLsp(resourceId: string, dispose: EffectDisposer): ResultValue<string, FoundationError> { return this.registerLSP(resourceId, dispose); }
	registerMonitor(resourceId: string, dispose: EffectDisposer): ResultValue<string, FoundationError> { return this.register("monitor", resourceId, dispose); }
	registerBin(resourceId: string, dispose: EffectDisposer): ResultValue<string, FoundationError> { return this.register("bin", resourceId, dispose); }
	registerSettings(resourceId: string, dispose: EffectDisposer): ResultValue<string, FoundationError> { return this.register("settings", resourceId, dispose); }
	registerListener(resourceId: string, dispose: EffectDisposer): ResultValue<string, FoundationError> { return this.register("listener", resourceId, dispose); }
	registerTimer(resourceId: string, dispose: EffectDisposer): ResultValue<string, FoundationError> { return this.register("timer", resourceId, dispose); }
	registerProcess(resourceId: string, dispose: EffectDisposer): ResultValue<string, FoundationError> { return this.register("process", resourceId, dispose); }
}

export function createEffectScope(): EffectScope {
	return new EffectScope();
}

// ---------------------------------------------------------------------------
// LSP / Monitor extension lifecycle points
// ---------------------------------------------------------------------------

export type LspLifecycleState = "inactive" | "active" | "failed";
export type MonitorLifecycleState = "inactive" | "running" | "failed";

export interface LspLifecycleRecord {
	schemaVersion: typeof FOUNDATION_SCHEMA_VERSION;
	extensionId: string;
	state: LspLifecycleState;
	languageIds: readonly string[];
	startedAt: string;
	failureReason?: string;
}

export interface MonitorLifecycleRecord {
	schemaVersion: typeof FOUNDATION_SCHEMA_VERSION;
	extensionId: string;
	state: MonitorLifecycleState;
	eventKinds: readonly string[];
	intervalMs: number;
	startedAt: string;
	failureReason?: string;
}

export interface DiagnosticRecord {
	schemaVersion: typeof FOUNDATION_SCHEMA_VERSION;
	extensionId: string;
	kind: "lsp" | "monitor";
	severity: "info" | "warning" | "error";
	message: string;
	reportedAt: string;
	payload?: FoundationJsonValue;
}

export interface LifecycleExtensionHost {
	startLsp(contract: LspExtensionContract, options?: { signal?: AbortSignal }): Promise<ResultValue<LspLifecycleRecord, FoundationError>>;
	stopLsp(extensionId: string): Promise<ResultValue<LspLifecycleRecord, FoundationError>>;
	startMonitor(contract: MonitorExtensionContract, options?: { signal?: AbortSignal }): Promise<ResultValue<MonitorLifecycleRecord, FoundationError>>;
	stopMonitor(extensionId: string): Promise<ResultValue<MonitorLifecycleRecord, FoundationError>>;
	recordDiagnostic(record: DiagnosticRecord): void;
}

export interface LifecycleExtensionCallbacks {
	startLsp?: LifecycleExtensionHost["startLsp"];
	stopLsp?: LifecycleExtensionHost["stopLsp"];
	startMonitor?: LifecycleExtensionHost["startMonitor"];
	stopMonitor?: LifecycleExtensionHost["stopMonitor"];
}

/**
 * Records extension state and delegates actual LSP/Monitor work to injected
 * providers. With no callbacks configured it fails closed and starts nothing.
 */
export class LifecycleExtensionRegistrar implements LifecycleExtensionHost {
	readonly #scope: EffectScope;
	readonly #diagnostics: DiagnosticRecord[] = [];
	readonly #lsp = new Map<string, LspLifecycleRecord>();
	readonly #monitors = new Map<string, MonitorLifecycleRecord>();
	readonly #start: LifecycleExtensionHost["startLsp"];
	readonly #stop: LifecycleExtensionHost["stopLsp"];
	readonly #startMonitor: LifecycleExtensionHost["startMonitor"];
	readonly #stopMonitor: LifecycleExtensionHost["stopMonitor"];

	constructor(scope: EffectScope = new EffectScope(), callbacks: LifecycleExtensionCallbacks = {}) {
		this.#scope = scope;
		this.#start = callbacks.startLsp ?? defaultLifecycleStart;
		this.#stop = callbacks.stopLsp ?? defaultLifecycleStop;
		this.#startMonitor = callbacks.startMonitor ?? defaultMonitorStart;
		this.#stopMonitor = callbacks.stopMonitor ?? defaultMonitorStop;
	}

	get diagnostics(): readonly DiagnosticRecord[] { return [...this.#diagnostics]; }
	get lspRecords(): readonly LspLifecycleRecord[] { return [...this.#lsp.values()]; }
	get monitorRecords(): readonly MonitorLifecycleRecord[] { return [...this.#monitors.values()]; }

	async startLsp(contract: LspExtensionContract, options?: { signal?: AbortSignal }): Promise<ResultValue<LspLifecycleRecord, FoundationError>> {
		if (this.#lsp.has(contract.extensionId)) return Result.err(new FoundationError("profile_conflict", "LSP extension is already active", { details: { extensionId: contract.extensionId } }));
		let result: ResultValue<LspLifecycleRecord, FoundationError>;
		try { result = await this.#start(contract, options); } catch (error) { result = Result.err(toFoundationError(error, "unsupported_feature")); }
		if (!result.ok) return result;
		this.#lsp.set(contract.extensionId, result.value);
		const resourceId = `lsp:${contract.extensionId}`;
		const registration = this.#scope.register("lsp", resourceId, async () => { await this.stopLspInternal(contract.extensionId); });
		if (!registration.ok) {
			this.#lsp.delete(contract.extensionId);
			const rollback = await this.#stop(contract.extensionId);
			if (!rollback.ok) this.recordDiagnostic({ schemaVersion: FOUNDATION_SCHEMA_VERSION, extensionId: contract.extensionId, kind: "lsp", severity: "error", message: `LSP registration rollback failed: ${rollback.error.message}`, reportedAt: new Date().toISOString() });
			return registration;
		}
		return result;
	}

	async stopLsp(extensionId: string): Promise<ResultValue<LspLifecycleRecord, FoundationError>> {
		const result = await this.stopLspInternal(extensionId);
		if (result.ok) this.#scope.remove(`lsp:${extensionId}`);
		return result;
	}

	private async stopLspInternal(extensionId: string): Promise<ResultValue<LspLifecycleRecord, FoundationError>> {
		const current = this.#lsp.get(extensionId);
		if (current === undefined) return Result.err(new FoundationError("profile_conflict", "LSP extension is not active", { details: { extensionId } }));
		this.#lsp.delete(extensionId);
		let result: ResultValue<LspLifecycleRecord, FoundationError>;
		try { result = await this.#stop(extensionId); } catch (error) { result = Result.err(toFoundationError(error, "unsupported_feature")); }
		if (!result.ok) this.#lsp.set(extensionId, { ...current, state: "failed", failureReason: result.error.message });
		return result;
	}

	async startMonitor(contract: MonitorExtensionContract, options?: { signal?: AbortSignal }): Promise<ResultValue<MonitorLifecycleRecord, FoundationError>> {
		if (this.#monitors.has(contract.extensionId)) return Result.err(new FoundationError("profile_conflict", "monitor extension is already active", { details: { extensionId: contract.extensionId } }));
		let result: ResultValue<MonitorLifecycleRecord, FoundationError>;
		try { result = await this.#startMonitor(contract, options); } catch (error) { result = Result.err(toFoundationError(error, "unsupported_feature")); }
		if (!result.ok) return result;
		this.#monitors.set(contract.extensionId, result.value);
		const resourceId = `monitor:${contract.extensionId}`;
		const registration = this.#scope.register("monitor", resourceId, async () => { await this.stopMonitorInternal(contract.extensionId); });
		if (!registration.ok) {
			this.#monitors.delete(contract.extensionId);
			const rollback = await this.#stopMonitor(contract.extensionId);
			if (!rollback.ok) this.recordDiagnostic({ schemaVersion: FOUNDATION_SCHEMA_VERSION, extensionId: contract.extensionId, kind: "monitor", severity: "error", message: `Monitor registration rollback failed: ${rollback.error.message}`, reportedAt: new Date().toISOString() });
			return registration;
		}
		return result;
	}

	async stopMonitor(extensionId: string): Promise<ResultValue<MonitorLifecycleRecord, FoundationError>> {
		const result = await this.stopMonitorInternal(extensionId);
		if (result.ok) this.#scope.remove(`monitor:${extensionId}`);
		return result;
	}

	private async stopMonitorInternal(extensionId: string): Promise<ResultValue<MonitorLifecycleRecord, FoundationError>> {
		const current = this.#monitors.get(extensionId);
		if (current === undefined) return Result.err(new FoundationError("profile_conflict", "monitor extension is not active", { details: { extensionId } }));
		this.#monitors.delete(extensionId);
		let result: ResultValue<MonitorLifecycleRecord, FoundationError>;
		try { result = await this.#stopMonitor(extensionId); } catch (error) { result = Result.err(toFoundationError(error, "unsupported_feature")); }
		if (!result.ok) this.#monitors.set(extensionId, { ...current, state: "failed", failureReason: result.error.message });
		return result;
	}

	recordDiagnostic(record: DiagnosticRecord): void { this.#diagnostics.push({ ...record }); }
}

async function defaultLifecycleStart(_contract: LspExtensionContract, _options?: { signal?: AbortSignal }): Promise<ResultValue<LspLifecycleRecord, FoundationError>> {
	return Result.err(new FoundationError("unsupported_feature", "LSP is a lifecycle extension point and no provider is configured"));
}

async function defaultLifecycleStop(extensionId: string): Promise<ResultValue<LspLifecycleRecord, FoundationError>> {
	return Result.err(new FoundationError("unsupported_feature", "no LSP provider is configured", { details: { extensionId } }));
}

async function defaultMonitorStart(_contract: MonitorExtensionContract, _options?: { signal?: AbortSignal }): Promise<ResultValue<MonitorLifecycleRecord, FoundationError>> {
	return Result.err(new FoundationError("unsupported_feature", "Monitor is a lifecycle extension point and no provider is configured"));
}

async function defaultMonitorStop(extensionId: string): Promise<ResultValue<MonitorLifecycleRecord, FoundationError>> {
	return Result.err(new FoundationError("unsupported_feature", "no monitor provider is configured", { details: { extensionId } }));
}

export function isLspExtensionContract(value: ExtensionContract): value is LspExtensionContract { return value.kind === "lsp"; }
export function isMonitorExtensionContract(value: ExtensionContract): value is MonitorExtensionContract { return value.kind === "monitor"; }
