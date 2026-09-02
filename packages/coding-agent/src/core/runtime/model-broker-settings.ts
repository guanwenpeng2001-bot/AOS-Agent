import type { ThinkingLevel } from "@aos-agent/agent-core";
import { createHash } from "node:crypto";

/**
 * ModelBroker settings are deliberately narrower than models.json.  A route
 * selects models which the runtime already knows about; it cannot define a
 * provider, an endpoint, or any authentication material.
 */

export const MODEL_BROKER_SETTINGS_VERSION = 1;

export type ModelBrokerFallbackReason = "provider_unavailable" | "transient_provider_error";

export type ModelBrokerSettingsErrorCode =
	| "model_route_invalid"
	| "model_route_not_found"
	| "model_role_not_found"
	| "model_route_unavailable";

export class ModelBrokerSettingsError extends Error {
	readonly code: ModelBrokerSettingsErrorCode;
	readonly path: string;

	constructor(code: ModelBrokerSettingsErrorCode, message: string, path = "") {
		super(path === "" ? message : `${path}: ${message}`);
		this.name = "ModelBrokerSettingsError";
		this.code = code;
		this.path = path;
	}
}

/** Raw, JSON-compatible route candidate accepted by settings.json. */
export interface ModelBrokerCandidateConfig {
	provider: string;
	modelId: string;
	thinkingLevel?: ThinkingLevel;
	serviceTier?: string;
}

/** Alias used by the broker core contract. */
export type ModelReference = ModelBrokerCandidateConfig;

export interface ModelBrokerFallbackConfig {
	maxAttempts?: number;
	on?: readonly ModelBrokerFallbackReason[];
}

export interface ModelBrokerBudgetConfig {
	maxModelCalls?: number;
	maxInputTokens?: number;
	maxOutputTokens?: number;
	maxTotalTokens?: number;
	maxCostUsd?: number;
}

export interface ModelBrokerRouteConfig {
	candidates: readonly ModelBrokerCandidateConfig[];
	fallback?: ModelBrokerFallbackConfig;
	budget?: ModelBrokerBudgetConfig;
}

/** Raw modelBroker settings after schema validation. */
export interface ModelBrokerSettingsConfig {
	defaultRoute?: string;
	routes?: Readonly<Record<string, ModelBrokerRouteConfig>>;
	roleRoutes?: Readonly<Record<string, string>>;
}

/** Input type for callers loading untrusted JSON. Nested values stay unknown until validated. */
export type ModelBrokerSettingsInput =
	| ModelBrokerSettingsConfig
	| ({
			defaultRoute?: unknown;
			routes?: unknown;
			roleRoutes?: unknown;
	  } & Record<string, unknown>);

export interface ModelBrokerRouteCandidate extends ModelBrokerCandidateConfig {
	/** Stable position in the route, starting at zero. */
	order: number;
}

export interface ModelBrokerFallbackSettings {
	maxAttempts: number;
	on: readonly ModelBrokerFallbackReason[];
}

export interface ModelBrokerBudgetSettings {
	maxModelCalls?: number;
	maxInputTokens?: number;
	maxOutputTokens?: number;
	maxTotalTokens?: number;
	maxCostUsd?: number;
}

/** Validated route consumed by ModelBroker. */
export interface ModelBrokerRoute {
	id: string;
	candidates: readonly ModelBrokerRouteCandidate[];
	fallback: ModelBrokerFallbackSettings;
	budget: ModelBrokerBudgetSettings;
}

export type ModelBrokerSettingsScope = "global" | "project";

export type ModelBrokerDiagnosticCode = "model_broker_project_ignored";

/** Safe diagnostics. Raw project values and errors are never included. */
export interface ModelBrokerSettingsDiagnostic {
	scope: ModelBrokerSettingsScope;
	trusted: boolean;
	ignored: boolean;
	code: ModelBrokerDiagnosticCode;
	reason: "project_untrusted";
	message: string;
}

/** Effective, trust-aware ModelBroker settings. */
export interface ModelBrokerSettings {
	enabled: boolean;
	defaultRoute?: string;
	routes: Readonly<Record<string, ModelBrokerRoute>>;
	roleRoutes: Readonly<Record<string, string>>;
	/** Stable SHA-256 digest of the effective, secret-free configuration. */
	configRevision: string;
	/** Alias kept for consumers that call the value a revision. */
	revision: string;
	diagnostics: readonly ModelBrokerSettingsDiagnostic[];
}

export interface ModelBrokerCostMetadata {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	tiers?: readonly ModelBrokerCostTier[];
}

export interface ModelBrokerCostTier {
	inputTokensAbove: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

/**
 * Safe catalog entry accepted by the settings layer.  `id` is supported in
 * addition to `modelId` so a ModelRuntime Model can be passed directly.
 */
export interface ModelBrokerModelDescriptor {
	provider: string;
	modelId?: string;
	id?: string;
	available?: boolean;
	cost?: unknown;
	thinkingLevelMap?: unknown;
}

export interface ModelBrokerSettingsBuildOptions {
	global?: ModelBrokerSettingsInput;
	project?: ModelBrokerSettingsInput;
	projectTrusted?: boolean;
	/** Runtime-visible models. Omit only when availability is resolved later. */
	availableModels?: readonly ModelBrokerModelDescriptor[];
	/** Alias for availableModels used by older callers. */
	models?: readonly ModelBrokerModelDescriptor[];
	/** Alias for availableModels used by runtime adapters. */
	catalog?: readonly ModelBrokerModelDescriptor[];
}

const IDENTIFIER_PATTERN = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;
const PROVIDER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const MODEL_ID_PATTERN = /^[@A-Za-z0-9][A-Za-z0-9._/@:+-]*$/;
const FALLBACK_REASONS: readonly ModelBrokerFallbackReason[] = ["provider_unavailable", "transient_provider_error"];
const THINKING_LEVELS: readonly ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const ROUTE_KEYS = new Set(["candidates", "fallback", "budget"]);
const FALLBACK_KEYS = new Set(["maxAttempts", "on"]);
const BUDGET_KEYS = new Set(["maxModelCalls", "maxInputTokens", "maxOutputTokens", "maxTotalTokens", "maxCostUsd"]);
const CANDIDATE_KEYS = new Set(["provider", "modelId", "thinkingLevel", "serviceTier"]);
const TOP_LEVEL_KEYS = new Set(["defaultRoute", "routes", "roleRoutes"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(value: object, key: string): boolean {
	return Object.hasOwn(value, key);
}

function fail(code: ModelBrokerSettingsErrorCode, path: string, message: string): never {
	throw new ModelBrokerSettingsError(code, message, path);
}

function assertKnownKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, path: string): void {
	for (const key of Object.keys(value)) {
		if (!allowed.has(key)) {
			fail("model_route_invalid", `${path}.${key}`, "unknown ModelBroker settings field");
		}
	}
}

function validateIdentifier(value: unknown, path: string, kind: "route" | "role"): string {
	if (typeof value !== "string" || !IDENTIFIER_PATTERN.test(value)) {
		fail(
			"model_route_invalid",
			path,
			`${kind} identifier must start with a letter and contain only letters, numbers, '.', '_' or '-'`,
		);
	}
	return value;
}

function validateProvider(value: unknown, path: string): string {
	if (typeof value !== "string" || value.length === 0 || !PROVIDER_PATTERN.test(value)) {
		fail("model_route_invalid", path, "provider must be an exact provider identifier");
	}
	return value;
}

function validateModelId(value: unknown, path: string): string {
	if (typeof value !== "string" || value.trim() !== value || value.length === 0) {
		fail("model_route_invalid", path, "modelId must be a non-empty exact model identifier");
	}
	if (
		!MODEL_ID_PATTERN.test(value) ||
		value.split("/").some((segment) => segment === "" || segment === "." || segment === "..") ||
		/[*?[\]{}]/.test(value) ||
		/:\/\//.test(value) ||
		/[\u0000-\u001f\u007f]/.test(value) ||
		/\s/.test(value)
	) {
		fail("model_route_invalid", path, "modelId must not contain glob, URL or whitespace syntax");
	}
	return value;
}

function validateThinkingLevel(value: unknown, path: string): ThinkingLevel {
	if (typeof value !== "string" || !THINKING_LEVELS.includes(value as ThinkingLevel)) {
		fail("model_route_invalid", path, "thinkingLevel is not supported");
	}
	return value as ThinkingLevel;
}

function parseCandidate(value: unknown, path: string): ModelBrokerCandidateConfig {
	if (!isPlainObject(value)) {
		fail("model_route_invalid", path, "candidate must be an object");
	}
	assertKnownKeys(value, CANDIDATE_KEYS, path);
	if (!hasOwn(value, "provider")) fail("model_route_invalid", `${path}.provider`, "provider is required");
	if (!hasOwn(value, "modelId")) fail("model_route_invalid", `${path}.modelId`, "modelId is required");
	const candidate: ModelBrokerCandidateConfig = {
		provider: validateProvider(value.provider, `${path}.provider`),
		modelId: validateModelId(value.modelId, `${path}.modelId`),
	};
	if (value.thinkingLevel !== undefined) {
		candidate.thinkingLevel = validateThinkingLevel(value.thinkingLevel, `${path}.thinkingLevel`);
	}
	if (
		value.serviceTier !== undefined &&
		(typeof value.serviceTier !== "string" || value.serviceTier.length === 0 || value.serviceTier.length > 128 ||
			value.serviceTier.trim() !== value.serviceTier || /[\u0000-\u001f\u007f]/.test(value.serviceTier))
	) {
		fail("model_route_invalid", `${path}.serviceTier`, "serviceTier must be an explicit bounded string");
	}
	if (typeof value.serviceTier === "string") candidate.serviceTier = value.serviceTier;
	return candidate;
}

function validateNonNegativeInteger(value: unknown, path: string, name: string): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
		fail("model_route_invalid", path, `${name} must be a non-negative safe integer`);
	}
	return value;
}

function validateNonNegativeNumber(value: unknown, path: string, name: string): number {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		fail("model_route_invalid", path, `${name} must be a non-negative finite number`);
	}
	return value;
}

function parseBudget(value: unknown, path: string): ModelBrokerBudgetSettings {
	if (value === undefined) return {};
	if (!isPlainObject(value)) fail("model_route_invalid", path, "budget must be an object");
	assertKnownKeys(value, BUDGET_KEYS, path);
	const budget: ModelBrokerBudgetSettings = {};
	const integerKeys = ["maxModelCalls", "maxInputTokens", "maxOutputTokens", "maxTotalTokens"] as const;
	for (const key of integerKeys) {
		if (value[key] !== undefined) budget[key] = validateNonNegativeInteger(value[key], `${path}.${key}`, key);
	}
	if (value.maxCostUsd !== undefined) {
		budget.maxCostUsd = validateNonNegativeNumber(value.maxCostUsd, `${path}.maxCostUsd`, "maxCostUsd");
	}
	return budget;
}

function parseFallback(value: unknown, path: string, candidateCount: number): ModelBrokerFallbackSettings {
	if (value === undefined) return { maxAttempts: 1, on: [] };
	if (!isPlainObject(value)) fail("model_route_invalid", path, "fallback must be an object");
	assertKnownKeys(value, FALLBACK_KEYS, path);
	const maxAttempts =
		value.maxAttempts === undefined
			? candidateCount
			: validateNonNegativeInteger(value.maxAttempts, `${path}.maxAttempts`, "maxAttempts");
	if (maxAttempts < 1 || maxAttempts > candidateCount) {
		fail("model_route_invalid", `${path}.maxAttempts`, "maxAttempts must be between 1 and the candidate count");
	}
	let on: ModelBrokerFallbackReason[] = [...FALLBACK_REASONS];
	if (value.on !== undefined) {
		if (!Array.isArray(value.on)) fail("model_route_invalid", `${path}.on`, "on must be an array");
		on = [];
		const seen = new Set<string>();
		for (let index = 0; index < value.on.length; index++) {
			const reason = value.on[index];
			if (typeof reason !== "string" || !FALLBACK_REASONS.includes(reason as ModelBrokerFallbackReason)) {
				fail("model_route_invalid", `${path}.on[${index}]`, "unknown fallback reason");
			}
			if (seen.has(reason)) fail("model_route_invalid", `${path}.on[${index}]`, "duplicate fallback reason");
			seen.add(reason);
			on.push(reason as ModelBrokerFallbackReason);
		}
	}
	return { maxAttempts, on };
}

function parseRoute(value: unknown, path: string, routeId: string): ModelBrokerRoute {
	if (!isPlainObject(value)) fail("model_route_invalid", path, "route must be an object");
	assertKnownKeys(value, ROUTE_KEYS, path);
	if (!Array.isArray(value.candidates) || value.candidates.length === 0) {
		fail("model_route_invalid", `${path}.candidates`, "route must contain at least one candidate");
	}
	const candidates: ModelBrokerRouteCandidate[] = [];
	const seenModels = new Set<string>();
	for (let index = 0; index < value.candidates.length; index++) {
		const candidate = parseCandidate(value.candidates[index], `${path}.candidates[${index}]`);
		const key = `${candidate.provider}\u0000${candidate.modelId}`;
		if (seenModels.has(key)) {
			fail("model_route_invalid", `${path}.candidates[${index}]`, "duplicate candidate model");
		}
		seenModels.add(key);
		candidates.push({ ...candidate, order: index });
	}
	return {
		id: routeId,
		candidates,
		fallback: parseFallback(value.fallback, `${path}.fallback`, candidates.length),
		budget: parseBudget(value.budget, `${path}.budget`),
	};
}

interface ParsedSettings {
	defaultRoute?: string;
	routes: Record<string, ModelBrokerRoute>;
	roleRoutes: Record<string, string>;
	hadValue: boolean;
}

function unwrapModelBrokerSettings(value: unknown): unknown {
	if (isPlainObject(value) && hasOwn(value, "modelBroker")) return value.modelBroker;
	return value;
}

function parseConfig(value: unknown, path: string, projectOnlyDefaultRoute = false): ParsedSettings {
	const unwrapped = unwrapModelBrokerSettings(value);
	if (unwrapped === undefined || unwrapped === null) {
		return { routes: {}, roleRoutes: {}, hadValue: false };
	}
	if (!isPlainObject(unwrapped)) fail("model_route_invalid", path, "modelBroker must be an object");
	const allowed = projectOnlyDefaultRoute ? new Set(["defaultRoute"]) : TOP_LEVEL_KEYS;
	assertKnownKeys(unwrapped, allowed, path);
	const hadValue = Object.keys(unwrapped).length > 0;
	let defaultRoute: string | undefined;
	if (unwrapped.defaultRoute !== undefined) {
		defaultRoute = validateIdentifier(unwrapped.defaultRoute, `${path}.defaultRoute`, "route");
	}

	const routes: Record<string, ModelBrokerRoute> = {};
	if (!projectOnlyDefaultRoute && unwrapped.routes !== undefined) {
		if (!isPlainObject(unwrapped.routes)) fail("model_route_invalid", `${path}.routes`, "routes must be an object");
		for (const [routeId, routeValue] of Object.entries(unwrapped.routes)) {
			const safeRouteId = validateIdentifier(routeId, `${path}.routes.${routeId}`, "route");
			routes[safeRouteId] = parseRoute(routeValue, `${path}.routes.${safeRouteId}`, safeRouteId);
		}
	}

	const roleRoutes: Record<string, string> = {};
	if (!projectOnlyDefaultRoute && unwrapped.roleRoutes !== undefined) {
		if (!isPlainObject(unwrapped.roleRoutes)) {
			fail("model_route_invalid", `${path}.roleRoutes`, "roleRoutes must be an object");
		}
		for (const [role, route] of Object.entries(unwrapped.roleRoutes)) {
			const safeRole = validateIdentifier(role, `${path}.roleRoutes.${role}`, "role");
			roleRoutes[safeRole] = validateIdentifier(route, `${path}.roleRoutes.${safeRole}`, "route");
		}
	}
	return { ...(defaultRoute !== undefined ? { defaultRoute } : {}), routes, roleRoutes, hadValue };
}

function parseRawConfig(value: unknown, path = "$.modelBroker"): ModelBrokerSettingsConfig {
	const parsed = parseConfig(value, path);
	if (!parsed.hadValue) return {};
	const routes: Record<string, ModelBrokerRouteConfig> = {};
	for (const [id, route] of Object.entries(parsed.routes)) {
		routes[id] = {
			candidates: route.candidates.map(({ order: _order, ...candidate }) => candidate),
			fallback: { maxAttempts: route.fallback.maxAttempts, on: [...route.fallback.on] },
			budget: { ...route.budget },
		};
	}
	return {
		...(parsed.defaultRoute !== undefined ? { defaultRoute: parsed.defaultRoute } : {}),
		...(Object.keys(routes).length > 0 ? { routes } : {}),
		...(Object.keys(parsed.roleRoutes).length > 0 ? { roleRoutes: { ...parsed.roleRoutes } } : {}),
	};
}

/** Parse and validate a standalone modelBroker object without resolving availability. */
export function parseModelBrokerSettings(value: unknown): ModelBrokerSettingsConfig {
	return parseRawConfig(value);
}

/** Alias for callers that use schema terminology. */
export const validateModelBrokerSettings = parseModelBrokerSettings;

function hasKnownCost(value: unknown): value is ModelBrokerCostMetadata {
	if (!isPlainObject(value)) return false;
	for (const key of ["input", "output", "cacheRead", "cacheWrite"]) {
		if (typeof value[key] !== "number" || !Number.isFinite(value[key]) || value[key] < 0) return false;
	}
	if (value.tiers !== undefined) {
		if (!Array.isArray(value.tiers)) return false;
		for (const tier of value.tiers) {
			if (!isPlainObject(tier)) return false;
			const inputTokensAbove = tier.inputTokensAbove;
			if (typeof inputTokensAbove !== "number" || !Number.isSafeInteger(inputTokensAbove) || inputTokensAbove < 0)
				return false;
			if (!hasKnownCost(tier)) return false;
		}
	}
	return true;
}

interface CatalogEntry {
	available: boolean;
	cost?: ModelBrokerCostMetadata;
	thinkingLevelMap?: Readonly<Record<string, string | null>>;
}

function catalogKey(provider: string, modelId: string): string {
	return `${provider}\u0000${modelId}`;
}

function normalizeThinkingLevelMap(value: unknown): Readonly<Record<string, string | null>> | undefined {
	if (!isPlainObject(value)) return undefined;
	const map: Record<string, string | null> = {};
	for (const [level, mapped] of Object.entries(value)) {
		if (typeof mapped === "string" || mapped === null) map[level] = mapped;
	}
	return map;
}

function getCatalogEntry(value: ModelBrokerModelDescriptor): { key: string; entry: CatalogEntry } | undefined {
	if (typeof value !== "object" || value === null || typeof value.provider !== "string") return undefined;
	const modelId = typeof value.modelId === "string" ? value.modelId : value.id;
	if (typeof modelId !== "string") return undefined;
	const thinkingLevelMap = normalizeThinkingLevelMap(value.thinkingLevelMap);
	const entry: CatalogEntry = {
		available: value.available !== false,

		...(hasKnownCost(value.cost) ? { cost: value.cost } : {}),
		...(thinkingLevelMap ? { thinkingLevelMap } : {}),
	};
	return { key: catalogKey(value.provider, modelId), entry };
}

function checkRouteAvailability(
	route: ModelBrokerRoute,
	catalog: ReadonlyMap<string, CatalogEntry> | undefined,
	path: string,
): void {
	const requiresCost = route.budget.maxCostUsd !== undefined;
	if (requiresCost && catalog === undefined) {
		fail(
			"model_route_invalid",
			`${path}.budget.maxCostUsd`,
			"maxCostUsd requires a runtime catalog with explicit cost metadata for every candidate",
		);
	}
	for (const candidate of route.candidates) {
		if (catalog === undefined) continue;
		const entry = catalog.get(catalogKey(candidate.provider, candidate.modelId));
		if (!entry || !entry.available) {
			fail(
				"model_route_unavailable",
				`${path}.candidates[${candidate.order}]`,
				"candidate is not present in the available model catalog",
			);
		}
		if (candidate.thinkingLevel !== undefined && entry.thinkingLevelMap) {
			const mapped = entry.thinkingLevelMap[candidate.thinkingLevel];
			if (mapped === null) {
				fail(
					"model_route_unavailable",
					`${path}.candidates[${candidate.order}].thinkingLevel`,
					"candidate does not support the requested thinking level",
				);
			}
		}
		if (requiresCost && entry.cost === undefined) {
			fail(
				"model_route_invalid",
				`${path}.budget.maxCostUsd`,
				"maxCostUsd cannot be used when a candidate has unknown cost",
			);
		}
	}
}

function assertRouteReference(
	routeId: string | undefined,
	routes: Readonly<Record<string, ModelBrokerRoute>>,
	path: string,
): void {
	if (routeId !== undefined && routes[routeId] === undefined) {
		fail("model_route_not_found", path, "route is not declared in global modelBroker settings");
	}
}

function canonicalize(value: unknown): unknown {
	if (Array.isArray(value)) return value.map((item) => canonicalize(item));
	if (!isPlainObject(value)) return value;
	const output: Record<string, unknown> = {};
	for (const key of Object.keys(value).sort()) output[key] = canonicalize(value[key]);
	return output;
}

function createConfigRevision(
	defaultRoute: string | undefined,
	routes: Readonly<Record<string, ModelBrokerRoute>>,
	roleRoutes: Readonly<Record<string, string>>,
): string {
	const revisionInput = {
		version: MODEL_BROKER_SETTINGS_VERSION,
		...(defaultRoute === undefined ? {} : { defaultRoute }),
		routes,
		roleRoutes,
	};
	return createHash("sha256")
		.update(JSON.stringify(canonicalize(revisionInput)))
		.digest("hex");
}

function deepFreeze<T>(value: T): T {
	if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
	for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
	return Object.freeze(value);
}

function createProjectIgnoredDiagnostic(): ModelBrokerSettingsDiagnostic {
	return {
		scope: "project",
		trusted: false,
		ignored: true,
		code: "model_broker_project_ignored",
		reason: "project_untrusted",
		message: "Project modelBroker settings were ignored because the project is untrusted.",
	};
}

function hasConfigValue(value: unknown): boolean {
	const unwrapped = unwrapModelBrokerSettings(value);
	return isPlainObject(unwrapped) && Object.keys(unwrapped).length > 0;
}

function normalizeCatalog(
	models: readonly ModelBrokerModelDescriptor[] | undefined,
): ReadonlyMap<string, CatalogEntry> | undefined {
	if (models === undefined) return undefined;
	const catalog = new Map<string, CatalogEntry>();
	for (const model of models) {
		const parsed = getCatalogEntry(model);
		if (parsed) catalog.set(parsed.key, parsed.entry);
	}
	return catalog;
}

/**
 * Parse global routes and apply the project trust boundary. Projects can
 * select one globally declared default route, but can never add routes,
 * candidates, role mappings, fallback policy, or budget limits.
 */
export function buildModelBrokerSettings(options: ModelBrokerSettingsBuildOptions): ModelBrokerSettings {
	const projectTrusted = options.projectTrusted ?? true;
	const global = parseConfig(options.global, "$.modelBroker");
	const catalog = normalizeCatalog(options.availableModels ?? options.models ?? options.catalog);

	for (const [routeId, route] of Object.entries(global.routes)) {
		checkRouteAvailability(route, catalog, `$.modelBroker.routes.${routeId}`);
	}
	for (const [role, routeId] of Object.entries(global.roleRoutes)) {
		assertRouteReference(routeId, global.routes, `$.modelBroker.roleRoutes.${role}`);
	}
	assertRouteReference(global.defaultRoute, global.routes, "$.modelBroker.defaultRoute");

	let projectDefaultRoute: string | undefined;
	const diagnostics: ModelBrokerSettingsDiagnostic[] = [];
	if (projectTrusted) {
		const project = parseConfig(options.project, "$.project.modelBroker", true);
		projectDefaultRoute = project.defaultRoute;
		assertRouteReference(projectDefaultRoute, global.routes, "$.project.modelBroker.defaultRoute");
	} else if (hasConfigValue(options.project)) {
		diagnostics.push(createProjectIgnoredDiagnostic());
	}

	const defaultRoute = projectDefaultRoute ?? global.defaultRoute;
	const configRevision = createConfigRevision(defaultRoute, global.routes, global.roleRoutes);
	const result: ModelBrokerSettings = {
		enabled: Object.keys(global.routes).length > 0,
		...(defaultRoute === undefined ? {} : { defaultRoute }),
		routes: global.routes,
		roleRoutes: global.roleRoutes,
		configRevision,
		revision: configRevision,
		diagnostics,
	};
	return deepFreeze(result);
}

/** Resolve settings using the same name as the broker's route resolver. */
export const resolveModelBrokerSettings = buildModelBrokerSettings;

/** Build a safe, public view without exposing any raw settings values. */
export function createModelBrokerSettingsView(settings: ModelBrokerSettings): ModelBrokerSettings {
	return deepFreeze({
		enabled: settings.enabled,
		...(settings.defaultRoute === undefined ? {} : { defaultRoute: settings.defaultRoute }),
		routes: Object.fromEntries(
			Object.entries(settings.routes).map(([routeId, route]) => [
				routeId,
				{
					id: route.id,
					candidates: route.candidates.map((candidate) => ({ ...candidate })),
					fallback: { maxAttempts: route.fallback.maxAttempts, on: [...route.fallback.on] },
					budget: { ...route.budget },
				},
			]),
		),
		roleRoutes: { ...settings.roleRoutes },
		configRevision: settings.configRevision,
		revision: settings.revision,
		diagnostics: settings.diagnostics.map((diagnostic) => ({ ...diagnostic })),
	});
}

/** A stable empty settings value used by legacy direct-model callers. */
export function createEmptyModelBrokerSettings(): ModelBrokerSettings {
	return buildModelBrokerSettings({ global: undefined, projectTrusted: true });
}
