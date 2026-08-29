import {
	createBindingHandle,
	createBindingRevision,
	isBindingHandle,
	type BindingHandle,
	type PublicBindingSummary,
} from "../binding-handles.ts";

/**
 * Model Broker v1.
 *
 * The broker resolves already-declared model references. It does not inspect
 * credentials, contact providers, or persist state. Provider adapters can use
 * the frozen binding and budget receipts produced here without exposing their
 * private configuration to callers that only need a public summary.
 *
 * Erasable TypeScript only (no enums, namespaces, or parameter properties).
 */

export const MODEL_BROKER_SCHEMA_VERSION = 1 as const;
export const MODEL_BINDING_PREFIX = "model-binding:";

export type ModelThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** Caller-facing reference. `model` and `modelId` are accepted aliases for `id`. */
export interface ModelReference {
	provider: string;
	id?: string;
	model?: string;
	modelId?: string;
	api?: string;
	thinkingLevel?: string;
	serviceTier?: string;
}

export type ModelReferenceInput = ModelReference | string;

/** Canonical, immutable reference used by a binding. */
export interface NormalizedModelReference {
	readonly provider: string;
	readonly id: string;
	readonly api?: string;
	readonly thinkingLevel?: string;
	readonly serviceTier?: string;
}

/**
 * A route candidate deliberately contains model identity only. Credentials,
 * request headers, endpoints, and environment values are not part of this
 * contract and are rejected when a candidate is parsed.
 */
export interface ModelRouteCandidate {
	reference?: ModelReferenceInput;
	model?: ModelReferenceInput;
	provider?: string;
	id?: string;
	modelId?: string;
	api?: string;
	thinkingLevel?: string;
	serviceTier?: string;
	priority?: number;
	weight?: number;
	enabled?: boolean;
	available?: boolean;
	label?: string;
}

export type ModelFallbackReason = "provider_unavailable" | "transient_provider_error";

export interface ModelFallbackPolicy {
	readonly maxAttempts: number;
	readonly on: readonly ModelFallbackReason[];
}

export interface ModelRoute {
	id?: string;
	candidates: readonly ModelRouteCandidate[];
	fallback?: ModelFallbackPolicy;
	budget?: ModelBudget;
}

export interface ModelRole {
	id?: string;
	role?: string;
	route?: string;
	candidates?: readonly ModelRouteCandidate[];
}

export type ModelRouteSelection = string | ModelRoute | readonly ModelRouteCandidate[];
export type ModelRoleSelection = string | ModelRole | readonly ModelRouteCandidate[];
export type ModelRouteCatalogInput =
	| Readonly<Record<string, ModelRoute | readonly ModelRouteCandidate[]>>
	| readonly (ModelRoute & { id: string })[];
export type ModelRoleCatalogInput =
	| Readonly<Record<string, ModelRole | readonly ModelRouteCandidate[] | string>>
	| readonly ModelRole[];

export interface ModelBrokerOptions {
	/** Optional catalog used for public summaries and direct model discovery. */
	models?: readonly ModelReferenceInput[];
	/** Default candidates used by callers that build a route inline. */
	candidates?: readonly ModelRouteCandidate[];
	routes?: ModelRouteCatalogInput;
	globalRoutes?: ModelRouteCatalogInput;
	roles?: ModelRoleCatalogInput;
	roleRoutes?: ModelRoleCatalogInput;
	defaultRoute?: string;
	defaultRole?: string;
	budget?: ModelBudget;
	/** Secret-free revision supplied by the settings layer. */
	configRevision?: string;
	now?: () => string;
	bindingIdFactory?: () => string;
}

export interface ModelBrokerResolveInput {
	/** Highest-precedence explicit override. */
	manual?: ModelReferenceInput | null;
	/** Explicit model selection after manual override. */
	direct?: ModelReferenceInput | null;
	/** Named or inline route selection. */
	route?: ModelRouteSelection | null;
	/** RPC spelling retained as an additive alias. */
	modelRoute?: ModelRouteSelection | null;
	/** Named or inline role selection. */
	role?: ModelRoleSelection | null;
	/** RPC spelling retained as an additive alias. */
	modelRole?: ModelRoleSelection | null;
}

export type ModelResolutionSource = "manual" | "direct" | "route" | "role";

export interface ModelBinding {
	readonly schemaVersion: typeof MODEL_BROKER_SCHEMA_VERSION;
	readonly id: string;
	readonly reference: NormalizedModelReference;
	readonly source: ModelResolutionSource;
	/** Explicit manual/direct selections never silently switch models. */
	readonly fallbackAllowed: boolean;
	/** All ordered enabled candidates considered by the route resolution. */
	readonly candidates?: readonly NormalizedModelReference[];
	readonly fallback?: ModelFallbackPolicy;
	readonly budget?: ModelBudget;
	readonly configRevision?: string;
	readonly createdAt: string;
	readonly routeId?: string;
	readonly role?: string;
	readonly candidateIndex?: number;
}

export interface ModelResolution {
	readonly binding: ModelBinding;
	readonly bindingId: string;
	readonly reference: NormalizedModelReference;
	readonly source: ModelResolutionSource;
	readonly fallbackAllowed: boolean;
	readonly routeId?: string;
	readonly role?: string;
	readonly candidateIndex?: number;
	readonly candidatesConsidered: readonly NormalizedModelReference[];
	readonly fallback?: ModelFallbackPolicy;
	readonly budget?: ModelBudget;
	readonly configRevision?: string;
}

export type ModelErrorCode =
	| "model_invalid_reference"
	| "model_route_not_found"
	| "model_role_not_found"
	| "model_no_candidate"
	| "model_route_unavailable"
	| "model_binding_invalid"
	| "model_binding_unavailable"
	| "model_binding_conflict"
	| "model_budget_invalid"
	| "model_budget_exceeded"
	| "model_budget_settlement_invalid"
	| "model_fallback_ineligible"
	| "model_fallback_exhausted"
	| "model_provider_failure";

export interface ModelError {
	readonly code: ModelErrorCode;
	readonly message: string;
	readonly retryable: boolean;
	readonly details?: Readonly<Record<string, unknown>>;
}

const SECRET_KEY_PATTERN = /(?:api[_-]?key|authorization|cookie|credential|header|password|secret|token|env)/i;
const URL_USERINFO_PATTERN = /([a-z][a-z0-9+.-]*:\/\/)(?:[^/@\s]+@)?([^\s?#]*)/gi;
const URL_QUERY_SECRET_PATTERN = /([?&](?:api[_-]?key|authorization|token|secret|password|credential)=)[^&#\s]*/gi;
const SECRET_ASSIGNMENT_PATTERN =
	/\b(?:api[_-]?key|authorization|bearer|cookie|credential|password|secret|token)\b\s*[:=]\s*[^\s,;]+/gi;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
const UNSAFE_REFERENCE_PATTERN = /(?:^|[\s])(?:bearer|token|secret|password|api[_-]?key)\s*[:=]/i;

function deepFreeze<T>(value: T): T {
	if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
	Object.freeze(value);
	for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
	return value;
}

function redactModelText(text: string): string {
	return text
		.replace(URL_USERINFO_PATTERN, "$1$2")
		.replace(URL_QUERY_SECRET_PATTERN, "$1[redacted]")
		.replace(SECRET_ASSIGNMENT_PATTERN, (match) => {
			const separator = match.includes("=") ? "=" : ":";
			const key = match.slice(0, match.indexOf(separator)).trim();
			return `${key}${separator}[redacted]`;
		});
}

function redactModelValue(value: unknown): unknown {
	if (typeof value === "string") return redactModelText(value);
	if (Array.isArray(value)) return value.map(redactModelValue);
	if (!isRecord(value)) return value;
	const redacted: Record<string, unknown> = {};
	for (const [key, child] of Object.entries(value)) {
		if (SECRET_KEY_PATTERN.test(key)) continue;
		redacted[key] = redactModelValue(child);
	}
	return redacted;
}

function cloneReadonlyRecord(value: Readonly<Record<string, unknown>>): Record<string, unknown> {
	return redactModelValue(value) as Record<string, unknown>;
}

export function createModelError(
	code: ModelErrorCode,
	message: string,
	retryable: boolean,
	details?: Readonly<Record<string, unknown>>,
): ModelError {
	const error: ModelError = {
		code,
		message: redactModelText(message),
		retryable,
		...(details !== undefined ? { details: deepFreeze(cloneReadonlyRecord(details)) } : {}),
	};
	return deepFreeze(error);
}

export class ModelBrokerError extends Error {
	readonly code: ModelErrorCode;
	readonly retryable: boolean;
	readonly details?: Readonly<Record<string, unknown>>;

	constructor(error: ModelError);
	constructor(code: ModelErrorCode, message: string, retryable?: boolean, details?: Readonly<Record<string, unknown>>);
	constructor(
		codeOrError: ModelErrorCode | ModelError,
		message?: string,
		retryable = false,
		details?: Readonly<Record<string, unknown>>,
	) {
		const error =
			typeof codeOrError === "string"
				? createModelError(codeOrError, message ?? codeOrError, retryable, details)
				: codeOrError;
		super(error.message);
		this.name = "ModelBrokerError";
		this.code = error.code;
		this.retryable = error.retryable;
		this.details = error.details;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCandidateList(value: unknown): value is readonly ModelRouteCandidate[] {
	return Array.isArray(value);
}

function hasUnsafeKey(value: Record<string, unknown>): string | undefined {
	for (const key of Object.keys(value)) {
		if (SECRET_KEY_PATTERN.test(key)) return key;
	}
	return undefined;
}

function validIdentityPart(value: unknown, label: string): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (!trimmed || trimmed.length > 256 || CONTROL_CHARACTER_PATTERN.test(trimmed)) return undefined;
	if (UNSAFE_REFERENCE_PATTERN.test(trimmed) || trimmed.includes("://")) return undefined;
	return trimmed;
}

function invalidReference(message: string): { ok: false; error: ModelError } {
	return { ok: false, error: createModelError("model_invalid_reference", message, false) };
}

export type ModelReferenceParseResult =
	| { ok: true; reference: NormalizedModelReference }
	| { ok: false; error: ModelError };

/** Parse a provider/model string or a safe object reference. */
export function parseModelReference(input: unknown): ModelReferenceParseResult {
	if (typeof input === "string") {
		const value = input.trim();
		const slash = value.indexOf("/");
		if (slash <= 0 || slash === value.length - 1) {
			return invalidReference("Model reference must be provider/model");
		}
		const provider = validIdentityPart(value.slice(0, slash), "provider");
		const id = validIdentityPart(value.slice(slash + 1), "model");
		if (!provider || !id) return invalidReference("Model reference contains an unsafe provider or model id");
		return deepFreeze({ ok: true, reference: { provider, id } });
	}

	if (!isRecord(input)) return invalidReference("Model reference must be an object or provider/model string");
	const unsafeKey = hasUnsafeKey(input);
	if (unsafeKey !== undefined) return invalidReference(`Model reference contains private field ${unsafeKey}`);

	const provider = validIdentityPart(input.provider, "provider");
	if (!provider) return invalidReference("Model reference requires a safe provider");

	const aliases = [input.id, input.model, input.modelId].filter((value): value is string => value !== undefined);
	if (aliases.length === 0) return invalidReference("Model reference requires id, model, or modelId");
	const ids = aliases.map((value) => validIdentityPart(value, "model"));
	if (ids.some((value) => value === undefined)) return invalidReference("Model reference contains an unsafe model id");
	const id = ids[0];
	if (id === undefined || ids.some((value) => value !== id)) {
		return invalidReference("Model reference aliases disagree");
	}

	const api = input.api === undefined ? undefined : validIdentityPart(input.api, "api");
	if (input.api !== undefined && !api) return invalidReference("Model reference contains an unsafe api");
	const thinkingLevel =
		input.thinkingLevel === undefined ? undefined : validIdentityPart(input.thinkingLevel, "thinking level");
	if (input.thinkingLevel !== undefined && !thinkingLevel) {
		return invalidReference("Model reference contains an unsafe thinking level");
	}
	const serviceTier =
		input.serviceTier === undefined ? undefined : validIdentityPart(input.serviceTier, "service tier");
	if (input.serviceTier !== undefined && !serviceTier) {
		return invalidReference("Model reference contains an unsafe service tier");
	}

	const reference: NormalizedModelReference = {
		provider,
		id,
		...(api !== undefined ? { api } : {}),
		...(thinkingLevel !== undefined ? { thinkingLevel } : {}),
		...(serviceTier !== undefined ? { serviceTier } : {}),
	};
	return deepFreeze({ ok: true, reference: deepFreeze(reference) });
}

/** Normalize a safe reference or throw a stable ModelBrokerError. */
export function normalizeModelReference(input: unknown): NormalizedModelReference {
	const result = parseModelReference(input);
	if (!result.ok) throw new ModelBrokerError(result.error);
	return result.reference;
}

export function isSafeModelReference(input: unknown): input is ModelReferenceInput {
	return parseModelReference(input).ok;
}

function referencesEqual(a: NormalizedModelReference, b: NormalizedModelReference): boolean {
	return a.provider === b.provider && a.id === b.id && a.api === b.api && a.thinkingLevel === b.thinkingLevel && a.serviceTier === b.serviceTier;
}

interface NormalizedRouteCandidate {
	readonly reference: NormalizedModelReference;
	readonly priority: number;
	readonly weight?: number;
	readonly enabled: boolean;
	readonly available: boolean;
	readonly label?: string;
}

type CandidateParseResult = { ok: true; candidate: NormalizedRouteCandidate } | { ok: false; error: ModelError };

function validFiniteNumber(value: unknown, label: string): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new ModelBrokerError("model_invalid_reference", `${label} must be a finite number`);
	}
	return value;
}

function parseCandidate(input: unknown): CandidateParseResult {
	if (!isRecord(input)) {
		return {
			ok: false,
			error: createModelError("model_invalid_reference", "Route candidate must be an object", false),
		};
	}
	const unsafeKey = hasUnsafeKey(input);
	if (unsafeKey !== undefined) {
		return {
			ok: false,
			error: createModelError(
				"model_invalid_reference",
				`Route candidate contains private field ${unsafeKey}`,
				false,
			),
		};
	}

	let referenceInput: unknown = input.reference ?? input.model;
	const directReference: Record<string, unknown> = {
		provider: input.provider,
		id: input.id,
		modelId: input.modelId,
		api: input.api,
		thinkingLevel: input.thinkingLevel,
		serviceTier: input.serviceTier,
	};
	const hasDirectReference = Object.values(directReference).some((value) => value !== undefined);
	if (referenceInput === undefined && hasDirectReference) referenceInput = directReference;
	if (referenceInput === undefined) {
		return {
			ok: false,
			error: createModelError("model_invalid_reference", "Route candidate requires a model reference", false),
		};
	}

	const parsed = parseModelReference(referenceInput);
	if (!parsed.ok) return parsed;
	if (hasDirectReference && (input.reference !== undefined || input.model !== undefined)) {
		const directParsed = parseModelReference(directReference);
		if (!directParsed.ok) return directParsed;
		if (!referencesEqual(parsed.reference, directParsed.reference)) {
			return {
				ok: false,
				error: createModelError("model_invalid_reference", "Route candidate references disagree", false),
			};
		}
	}

	let priority = 0;
	try {
		priority = validFiniteNumber(input.priority, "Route candidate priority") ?? 0;
		const weight = validFiniteNumber(input.weight, "Route candidate weight");
		if (weight !== undefined && weight < 0) {
			return {
				ok: false,
				error: createModelError("model_invalid_reference", "Route candidate weight cannot be negative", false),
			};
		}
		const label = input.label === undefined ? undefined : validIdentityPart(input.label, "label");
		if (input.label !== undefined && !label) {
			return {
				ok: false,
				error: createModelError("model_invalid_reference", "Route candidate label is unsafe", false),
			};
		}
		return deepFreeze({
			ok: true,
			candidate: {
				reference: parsed.reference,
				priority,
				...(weight !== undefined ? { weight } : {}),
				enabled: input.enabled !== false,
				available: input.available !== false,
				...(label !== undefined ? { label } : {}),
			},
		});
	} catch (error) {
		if (error instanceof ModelBrokerError)
			return { ok: false, error: createModelError(error.code, error.message, error.retryable) };
		return { ok: false, error: createModelError("model_invalid_reference", "Route candidate is invalid", false) };
	}
}

function normalizeCandidates(input: readonly ModelRouteCandidate[]): NormalizedRouteCandidate[] {
	const normalized: NormalizedRouteCandidate[] = [];
	for (const candidate of input) {
		const result = parseCandidate(candidate);
		if (!result.ok) throw new ModelBrokerError(result.error);
		normalized.push(result.candidate);
	}
	return normalized;
}

interface NormalizedRoutePolicy {
	fallback: ModelFallbackPolicy;
	budget?: ModelBudget;
}

function normalizeFallbackPolicy(input: ModelFallbackPolicy | undefined, candidateCount: number): ModelFallbackPolicy {
	const maxAttempts = input?.maxAttempts ?? 1;
	if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > Math.max(1, candidateCount)) {
		throw new ModelBrokerError("model_invalid_reference", "Route fallback maxAttempts is invalid", false);
	}
	const on = input?.on ?? [];
	if (on.some((reason) => reason !== "provider_unavailable" && reason !== "transient_provider_error")) {
		throw new ModelBrokerError("model_invalid_reference", "Route fallback reason is invalid", false);
	}
	return deepFreeze({ maxAttempts, on: deepFreeze([...new Set(on)]) });
}

function normalizeRoutePolicy(route: ModelRoute | readonly ModelRouteCandidate[]): NormalizedRoutePolicy {
	const candidates = isCandidateList(route) ? route : route.candidates;
	return deepFreeze({
		fallback: normalizeFallbackPolicy(isCandidateList(route) ? undefined : route.fallback, candidates.length),
		...(isCandidateList(route) || route.budget === undefined ? {} : { budget: deepFreeze({ ...route.budget }) }),
	});
}

function candidatesForSelection(
	selection: ModelRouteSelection,
	routes: ReadonlyMap<string, readonly NormalizedRouteCandidate[]>,
	routePolicies?: ReadonlyMap<string, NormalizedRoutePolicy>,
): { candidates: readonly NormalizedRouteCandidate[]; routeId: string; policy?: NormalizedRoutePolicy } | ModelError {
	if (typeof selection === "string") {
		const candidates = routes.get(selection);
		if (!candidates) return createModelError("model_route_not_found", `Model route not found: ${selection}`, false);
		return { candidates, routeId: selection, policy: routePolicies?.get(selection) };
	}
	if (isCandidateList(selection)) {
		return {
			candidates: normalizeCandidates(selection),
			routeId: "route:inline",
			policy: normalizeRoutePolicy(selection),
		};
	}
	return {
		candidates: normalizeCandidates(selection.candidates),
		routeId: selection.id ?? "route:inline",
		policy: normalizeRoutePolicy(selection),
	};
}

function candidatesForRoleSelection(
	selection: ModelRoleSelection,
	routes: ReadonlyMap<string, readonly NormalizedRouteCandidate[]>,
	roles: ReadonlyMap<string, readonly NormalizedRouteCandidate[] | string>,
): { candidates: readonly NormalizedRouteCandidate[]; role: string; routeId?: string } | ModelError {
	if (typeof selection === "string") {
		const value = roles.get(selection);
		if (value === undefined)
			return createModelError("model_role_not_found", `Model role not found: ${selection}`, false);
		if (typeof value === "string") {
			const candidates = routes.get(value);
			if (!candidates) return createModelError("model_route_not_found", `Model route not found: ${value}`, false);
			return { candidates, role: selection, routeId: value };
		}
		return { candidates: value, role: selection };
	}
	if (isCandidateList(selection)) return { candidates: normalizeCandidates(selection), role: "role:inline" };
	if (selection.route !== undefined) {
		const candidates = routes.get(selection.route);
		if (!candidates)
			return createModelError("model_route_not_found", `Model route not found: ${selection.route}`, false);
		return { candidates, role: selection.role ?? selection.id ?? "role:inline", routeId: selection.route };
	}
	return {
		candidates: normalizeCandidates(selection.candidates ?? []),
		role: selection.role ?? selection.id ?? "role:inline",
	};
}

function chooseCandidate(
	candidates: readonly NormalizedRouteCandidate[],
): { candidate: NormalizedRouteCandidate; index: number; considered: NormalizedModelReference[] } | ModelError {
	const indexed = candidates.map((candidate, index) => ({ candidate, index }));
	indexed.sort((a, b) => a.candidate.priority - b.candidate.priority || a.index - b.index);
	const considered = indexed.filter(({ candidate }) => candidate.enabled).map(({ candidate }) => candidate.reference);
	for (const { candidate, index } of indexed) {
		if (candidate.enabled && candidate.available) return { candidate, index, considered };
	}
	if (candidates.length === 0) {
		return createModelError("model_no_candidate", "Model selection has no safe route candidates", false);
	}
	return createModelError("model_route_unavailable", "Model route has no available safe candidate", true);
}

let fallbackBindingSequence = 0;

function defaultBindingId(): string {
	fallbackBindingSequence += 1;
	return `${MODEL_BINDING_PREFIX}${Date.now().toString(36)}-${fallbackBindingSequence.toString(36)}`;
}

function createBinding(
	reference: NormalizedModelReference,
	source: ModelResolutionSource,
	createdAt: string,
	bindingIdFactory: (() => string) | undefined,
	metadata?: {
		routeId?: string;
		role?: string;
		candidateIndex?: number;
		candidates?: readonly NormalizedModelReference[];
		fallback?: ModelFallbackPolicy;
		budget?: ModelBudget;
		configRevision?: string;
	},
): ModelBinding {
	const id = bindingIdFactory?.() ?? defaultBindingId();
	const safeId = validIdentityPart(id, "binding id");
	if (!safeId) throw new ModelBrokerError("model_binding_invalid", "Binding id is unsafe", false);
	const binding: ModelBinding = {
		schemaVersion: MODEL_BROKER_SCHEMA_VERSION,
		id: safeId,
		reference,
		source,
		fallbackAllowed: source === "route" || source === "role",
		candidates: deepFreeze([...(metadata?.candidates ?? [reference])]),
		fallback: metadata?.fallback ?? deepFreeze({ maxAttempts: 1, on: [] }),
		budget: deepFreeze({ ...(metadata?.budget ?? {}) }),
		createdAt,
		...(metadata?.routeId !== undefined ? { routeId: metadata.routeId } : {}),
		...(metadata?.role !== undefined ? { role: metadata.role } : {}),
		...(metadata?.candidateIndex !== undefined ? { candidateIndex: metadata.candidateIndex } : {}),
		...(metadata?.configRevision !== undefined ? { configRevision: metadata.configRevision } : {}),
	};
	return deepFreeze(binding);
}

function resolveWithCatalog(
	input: ModelBrokerResolveInput,
	routes: ReadonlyMap<string, readonly NormalizedRouteCandidate[]>,
	roles: ReadonlyMap<string, readonly NormalizedRouteCandidate[] | string>,
	options: Pick<ModelBrokerOptions, "now" | "bindingIdFactory" | "configRevision" | "budget"> & {
		routePolicies?: ReadonlyMap<string, NormalizedRoutePolicy>;
		defaultRoute?: string;
		defaultRole?: string;
	},
): ModelResolutionResult {
	const sources: readonly ModelResolutionSource[] = ["manual", "direct", "route", "role"];
	for (const source of sources) {
		let reference: NormalizedModelReference | undefined;
		let routeId: string | undefined;
		let role: string | undefined;
		let candidateIndex: number | undefined;
		let considered: NormalizedModelReference[] = [];
		let selectedRoutePolicy: NormalizedRoutePolicy | undefined;

		if (source === "manual") {
			const selection = input.manual;
			if (selection === undefined || selection === null) continue;
			const parsed = parseModelReference(selection);
			if (!parsed.ok) return parsed;
			reference = parsed.reference;
			considered = [reference];
		} else if (source === "direct") {
			const selection = input.direct;
			if (selection === undefined || selection === null) continue;
			const parsed = parseModelReference(selection);
			if (!parsed.ok) return parsed;
			reference = parsed.reference;
			considered = [reference];
		} else if (source === "route") {
			const selection = input.route;
			if (selection === undefined || selection === null) continue;
			const selected = candidatesForSelection(selection, routes, options.routePolicies);
			if ("code" in selected) return { ok: false, error: selected };
			routeId = selected.routeId;
			selectedRoutePolicy = selected.policy;
			const chosen = chooseCandidate(selected.candidates);
			if ("code" in chosen) return { ok: false, error: chosen };
			reference = chosen.candidate.reference;
			candidateIndex = chosen.index;
			considered = chosen.considered;
		} else {
			const selection = input.role;
			if (selection === undefined || selection === null) continue;
			const selected = candidatesForRoleSelection(selection, routes, roles);
			if ("code" in selected) return { ok: false, error: selected };
			role = selected.role;
			routeId = selected.routeId;
			const chosen = chooseCandidate(selected.candidates);
			if ("code" in chosen) return { ok: false, error: chosen };
			reference = chosen.candidate.reference;
			candidateIndex = chosen.index;
			considered = chosen.considered;
		}

		if (reference === undefined) {
			return {
				ok: false,
				error: createModelError("model_no_candidate", `No model candidate was resolved for ${source}`, false),
			};
		}
		const createdAt = options.now?.() ?? new Date().toISOString();
		const routePolicy =
			selectedRoutePolicy ?? (routeId === undefined ? undefined : options.routePolicies?.get(routeId));
		const binding = createBinding(reference, source, createdAt, options.bindingIdFactory, {
			routeId,
			role,
			candidateIndex,
			candidates: considered,
			fallback: source === "route" || source === "role" ? routePolicy?.fallback : undefined,
			budget: routePolicy?.budget ?? options.budget,
			configRevision: options.configRevision,
		});
		const resolution: ModelResolution = {
			binding,
			bindingId: binding.id,
			reference,
			source,
			fallbackAllowed: binding.fallbackAllowed,
			...(routeId !== undefined ? { routeId } : {}),
			...(role !== undefined ? { role } : {}),
			...(candidateIndex !== undefined ? { candidateIndex } : {}),
			candidatesConsidered: deepFreeze([...considered]),
			...(binding.fallback === undefined ? {} : { fallback: binding.fallback }),
			...(binding.budget === undefined ? {} : { budget: binding.budget }),
			...(binding.configRevision === undefined ? {} : { configRevision: binding.configRevision }),
		};
		return { ok: true, resolution: deepFreeze(resolution) };
	}

	return {
		ok: false,
		error: createModelError(
			"model_no_candidate",
			"No manual, direct, route, or role model selection was supplied",
			false,
		),
	};
}

function applyResolutionAliases(
	input: ModelBrokerResolveInput,
	options: Pick<ModelBrokerOptions, "defaultRoute" | "defaultRole">,
): ModelBrokerResolveInput {
	const route = input.route ?? input.modelRoute ?? options.defaultRoute;
	const role = input.role ?? input.modelRole ?? options.defaultRole;
	return {
		...input,
		...(route !== undefined ? { route } : {}),
		...(role !== undefined ? { role } : {}),
	};
}

export type ModelResolutionResult = { ok: true; resolution: ModelResolution } | { ok: false; error: ModelError };

function normalizeRouteMap(
	routes: ModelRouteCatalogInput | undefined,
): Map<string, readonly NormalizedRouteCandidate[]> {
	const result = new Map<string, readonly NormalizedRouteCandidate[]>();
	if (Array.isArray(routes)) {
		for (const route of routes) result.set(route.id, deepFreeze(normalizeCandidates(route.candidates)));
		return result;
	}
	for (const [id, value] of Object.entries(routes ?? {})) {
		const candidates = isCandidateList(value) ? value : (value.candidates ?? []);
		result.set(id, deepFreeze(normalizeCandidates(candidates)));
	}
	return result;
}

function normalizeRoutePolicyMap(routes: ModelRouteCatalogInput | undefined): Map<string, NormalizedRoutePolicy> {
	const result = new Map<string, NormalizedRoutePolicy>();
	if (Array.isArray(routes)) {
		for (const route of routes) result.set(route.id, normalizeRoutePolicy(route));
		return result;
	}
	for (const [id, value] of Object.entries(routes ?? {})) {
		result.set(id, normalizeRoutePolicy(value));
	}
	return result;
}

function normalizeRoleMap(
	roles: ModelRoleCatalogInput | undefined,
): Map<string, readonly NormalizedRouteCandidate[] | string> {
	const result = new Map<string, readonly NormalizedRouteCandidate[] | string>();
	if (Array.isArray(roles)) {
		for (const role of roles) {
			const roleId = role.role ?? role.id;
			if (roleId === undefined) continue;
			if (role.route !== undefined) {
				result.set(roleId, role.route);
			} else {
				result.set(roleId, deepFreeze(normalizeCandidates(role.candidates ?? [])));
			}
		}
		return result;
	}
	for (const [id, value] of Object.entries(roles ?? {})) {
		if (typeof value === "string") {
			result.set(id, value);
			continue;
		}
		const candidates = isCandidateList(value) ? value : (value.candidates ?? []);
		result.set(id, deepFreeze(normalizeCandidates(candidates)));
	}
	return result;
}

function mergeRouteMaps(
	primary: ModelRouteCatalogInput | undefined,
	secondary: ModelRouteCatalogInput | undefined,
): Map<string, readonly NormalizedRouteCandidate[]> {
	const result = normalizeRouteMap(primary);
	for (const [id, candidates] of normalizeRouteMap(secondary)) result.set(id, candidates);
	return result;
}

function mergeRoutePolicies(
	primary: ModelRouteCatalogInput | undefined,
	secondary: ModelRouteCatalogInput | undefined,
): Map<string, NormalizedRoutePolicy> {
	const result = normalizeRoutePolicyMap(primary);
	for (const [id, policy] of normalizeRoutePolicyMap(secondary)) result.set(id, policy);
	return result;
}

function mergeRoleMaps(
	primary: ModelRoleCatalogInput | undefined,
	secondary: ModelRoleCatalogInput | undefined,
): Map<string, readonly NormalizedRouteCandidate[] | string> {
	const result = normalizeRoleMap(primary);
	for (const [id, candidates] of normalizeRoleMap(secondary)) result.set(id, candidates);
	return result;
}

/** Pure route/role resolution without constructing a broker instance. */
export function resolveModel(input: ModelBrokerResolveInput, options: ModelBrokerOptions = {}): ModelResolutionResult {
	return resolveWithCatalog(
		applyResolutionAliases(input, options),
		mergeRouteMaps(options.globalRoutes, options.routes),
		mergeRoleMaps(options.roles, options.roleRoutes),
		{ ...options, routePolicies: mergeRoutePolicies(options.globalRoutes, options.routes) },
	);
}

// ---- Fallback policy -------------------------------------------------------

export type ProviderFailureCategory =
	| "transport"
	| "network"
	| "timeout"
	| "rate_limit"
	| "overloaded"
	| "unavailable"
	| "server"
	| "auth"
	| "permission"
	| "invalid_request"
	| "context_overflow"
	| "content_policy"
	| "billing"
	| "tool_error"
	| "side_effect_unknown"
	| "unknown";

export type VisibleSideEffect =
	| "none"
	| "partial_output"
	| "assistant_output"
	| "tool_call"
	| "tool_result"
	| "external_request"
	| "state_change"
	| "unknown"
	| "user_visible";

export interface ModelVisibleSideEffectState {
	[key: string]: unknown;
	emittedText?: boolean;
	partialOutput?: boolean;
	visibleOutput?: boolean;
	assistantOutput?: boolean;
	toolCall?: boolean;
	toolResult?: boolean;
	toolCalls?: number;
	toolResults?: number;
	externalRequest?: boolean;
	externalRequests?: number;
	stateChange?: boolean;
	stateChanged?: boolean;
	userVisible?: boolean;
	/** The provider may have performed work that was not observable locally. */
	sideEffectUnknown?: boolean;
	unknown?: boolean;
}

export type VisibleSideEffectsInput = readonly VisibleSideEffect[] | ModelVisibleSideEffectState | boolean;

export interface ProviderFailure {
	category: ProviderFailureCategory | string;
	status?: number;
	message?: string;
	visibleSideEffects?: VisibleSideEffectsInput;
	sideEffects?: VisibleSideEffectsInput;
	/** Explicitly records whether a dispatch may have produced an unobserved effect. */
	sideEffectStatus?: "none" | "visible" | "unknown";
}

export interface FallbackEligibility {
	readonly eligible: boolean;
	readonly category: string;
	readonly visibleSideEffects: readonly VisibleSideEffect[];
	readonly reason: string;
}

const SAFE_FALLBACK_CATEGORIES = new Set<string>([
	"transport",
	"network",
	"timeout",
	"rate_limit",
	"overloaded",
	"unavailable",
	"server",
	"server_error",
	"gateway",
	"5xx",
]);

const VISIBLE_SIDE_EFFECTS = new Set<VisibleSideEffect>([
	"partial_output",
	"assistant_output",
	"tool_call",
	"tool_result",
	"external_request",
	"state_change",
	"unknown",
	"user_visible",
]);

function normalizedSideEffects(value: VisibleSideEffectsInput | undefined): VisibleSideEffect[] {
	if (value === undefined || value === false) return [];
	if (value === true) return ["user_visible"];
	if (Array.isArray(value)) return [...new Set(value)];
	if (!isRecord(value)) return [];
	const state = value as ModelVisibleSideEffectState;
	const effects: VisibleSideEffect[] = [];
	const hasCount = (candidate: unknown): boolean => typeof candidate === "number" && candidate > 0;
	if (state.emittedText === true || state.partialOutput === true || state.visibleOutput === true)
		effects.push("partial_output");
	if (state.assistantOutput === true) effects.push("assistant_output");
	if (state.toolCall === true || hasCount(state.toolCalls)) effects.push("tool_call");
	if (state.toolResult === true || hasCount(state.toolResults)) effects.push("tool_result");
	if (state.externalRequest === true || hasCount(state.externalRequests)) effects.push("external_request");
	if (state.stateChange === true || state.stateChanged === true) effects.push("state_change");
	if (state.sideEffectUnknown === true || state.unknown === true) effects.push("unknown");
	if (state.userVisible === true) effects.push("user_visible");
	return [...new Set(effects)];
}

/** Fallback is allowed only for transient provider failures before visible work. */
export function classifyFallbackEligibility(
	failure: ProviderFailure | string,
	sideEffects?: VisibleSideEffectsInput,
	fallbackAllowed = true,
): FallbackEligibility {
	const providerFailure: ProviderFailure = typeof failure === "string" ? { category: failure } : failure;
	const rawCategory = typeof providerFailure.category === "string" ? providerFailure.category : "unknown";
	const normalizedCategory = rawCategory.trim().toLowerCase().replace(/-/g, "_");
	const category =
		(normalizedCategory === "unknown" || normalizedCategory.length === 0) &&
		providerFailure.status !== undefined &&
		providerFailure.status >= 500
			? "server"
			: normalizedCategory;
	const visibleSideEffects = normalizedSideEffects(
		sideEffects ?? providerFailure.visibleSideEffects ?? providerFailure.sideEffects,
	);
	if (providerFailure.sideEffectStatus === "unknown" && !visibleSideEffects.includes("unknown")) {
		visibleSideEffects.push("unknown");
	}
	if (!fallbackAllowed) {
		return deepFreeze({
			eligible: false,
			category,
			visibleSideEffects,
			reason: "Fallback is disabled for an explicit model selection",
		});
	}
	if (!SAFE_FALLBACK_CATEGORIES.has(category)) {
		return deepFreeze({
			eligible: false,
			category,
			visibleSideEffects,
			reason: `Provider failure category ${category || "unknown"} is not safe to retry`,
		});
	}
	const unsafeEffect = visibleSideEffects.find((effect) => VISIBLE_SIDE_EFFECTS.has(effect));
	if (unsafeEffect !== undefined) {
		return deepFreeze({
			eligible: false,
			category,
			visibleSideEffects,
			reason: `Fallback is unsafe after ${unsafeEffect === "unknown" ? "an unknown side effect" : `visible side effect ${unsafeEffect}`}`,
		});
	}
	return deepFreeze({
		eligible: true,
		category,
		visibleSideEffects,
		reason: "Transient provider failure occurred before visible side effects",
	});
}

export const isFallbackEligible = (
	failure: ProviderFailure | string,
	sideEffects?: VisibleSideEffectsInput,
	fallbackAllowed = true,
): boolean => classifyFallbackEligibility(failure, sideEffects, fallbackAllowed).eligible;

// ---- Budget ----------------------------------------------------------------

export interface ModelBudget {
	maxModelCalls?: number;
	maxInputTokens?: number;
	maxOutputTokens?: number;
	maxTotalTokens?: number;
	maxCost?: number;
	maxCostUsd?: number;
	inputTokenLimit?: number;
	outputTokenLimit?: number;
	totalTokenLimit?: number;
	costLimit?: number;
	/** Alias for maxCost for callers that use a short budget shape. */
	cost?: number;
}

export interface ModelUsage {
	modelCalls?: number;
	input?: number;
	output?: number;
	total?: number;
	cost?: number | { total?: number };
	inputTokens?: number;
	outputTokens?: number;
	totalTokens?: number;
	costUsd?: number;
}

export interface NormalizedModelUsage {
	readonly modelCalls?: number;
	readonly inputTokens: number;
	readonly outputTokens: number;
	readonly totalTokens: number;
	readonly cost: number;
}

export interface ModelBudgetPreflightInput {
	budget: ModelBudget;
	estimate?: ModelUsage;
	usage?: ModelUsage;
	estimatedInputTokens?: number;
	estimatedOutputTokens?: number;
	estimatedTotalTokens?: number;
	estimatedCost?: number;
	committed?: ModelUsage;
	reserved?: ModelUsage;
	reservationId?: string;
	bindingId?: string;
	now?: string;
}

export interface ModelBudgetReservation {
	readonly id: string;
	readonly estimate: NormalizedModelUsage;
	readonly bindingId?: string;
	readonly createdAt: string;
}

export interface ModelBudgetState {
	readonly committed: NormalizedModelUsage;
	readonly reserved: NormalizedModelUsage;
}

export interface ModelBudgetPreflight {
	readonly budget: ModelBudget;
	readonly reservation: ModelBudgetReservation;
	readonly state: ModelBudgetState;
	readonly remaining: NormalizedModelUsage;
}

export type ModelBudgetPreflightResult =
	| { ok: true; preflight: ModelBudgetPreflight }
	| { ok: false; error: ModelError };

export interface ModelBudgetSettlement {
	readonly reservationId: string;
	readonly usage: NormalizedModelUsage;
	readonly state: ModelBudgetState;
	readonly remaining: NormalizedModelUsage;
}

export type ModelBudgetSettlementResult =
	| { ok: true; settlement: ModelBudgetSettlement }
	| { ok: false; error: ModelError };

const ZERO_USAGE: NormalizedModelUsage = deepFreeze({ inputTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0 });

function usageNumber(value: unknown, label: string): number {
	if (value === undefined) return 0;
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
		throw new ModelBrokerError("model_budget_invalid", `${label} must be a non-negative finite number`, false);
	}
	return value;
}

export function normalizeModelUsage(input: ModelUsage | undefined): NormalizedModelUsage {
	if (input === undefined) return ZERO_USAGE;
	const modelCalls = input.modelCalls === undefined ? undefined : usageNumber(input.modelCalls, "Model call usage");
	const inputTokens = usageNumber(input.inputTokens ?? input.input, "Input token usage");
	const outputTokens = usageNumber(input.outputTokens ?? input.output, "Output token usage");
	const declaredTotal = input.totalTokens ?? input.total;
	const totalTokens =
		declaredTotal === undefined ? inputTokens + outputTokens : usageNumber(declaredTotal, "Total token usage");
	if (totalTokens < inputTokens + outputTokens) {
		throw new ModelBrokerError("model_budget_invalid", "Total token usage cannot be below input plus output", false);
	}
	const rawCost = input.costUsd ?? (typeof input.cost === "number" ? input.cost : input.cost?.total);
	const cost = usageNumber(rawCost, "Cost usage");
	return deepFreeze({
		...(modelCalls === undefined ? {} : { modelCalls }),
		inputTokens,
		outputTokens,
		totalTokens,
		cost,
	});
}

function addUsage(a: NormalizedModelUsage, b: NormalizedModelUsage): NormalizedModelUsage {
	return deepFreeze({
		...(a.modelCalls === undefined && b.modelCalls === undefined
			? {}
			: { modelCalls: (a.modelCalls ?? 0) + (b.modelCalls ?? 0) }),
		inputTokens: a.inputTokens + b.inputTokens,
		outputTokens: a.outputTokens + b.outputTokens,
		totalTokens: a.totalTokens + b.totalTokens,
		cost: a.cost + b.cost,
	});
}

function subtractUsage(a: NormalizedModelUsage, b: NormalizedModelUsage): NormalizedModelUsage {
	return deepFreeze({
		...(a.modelCalls === undefined && b.modelCalls === undefined
			? {}
			: { modelCalls: Math.max(0, (a.modelCalls ?? 0) - (b.modelCalls ?? 0)) }),
		inputTokens: Math.max(0, a.inputTokens - b.inputTokens),
		outputTokens: Math.max(0, a.outputTokens - b.outputTokens),
		totalTokens: Math.max(0, a.totalTokens - b.totalTokens),
		cost: Math.max(0, a.cost - b.cost),
	});
}

interface NormalizedModelBudget {
	readonly maxModelCalls: number;
	readonly maxInputTokens: number;
	readonly maxOutputTokens: number;
	readonly maxTotalTokens: number;
	readonly maxCost: number;
}

interface BindingBudgetState {
	readonly budget: ModelBudget;
	committed: NormalizedModelUsage;
	reserved: NormalizedModelUsage;
	exceeded: boolean;
}

interface TrackedBindingBudgetReservation {
	readonly bindingId: string;
	readonly budget: ModelBudget;
	readonly reservation: ModelBudgetReservation;
	settled: boolean;
}

function normalizeBudget(input: ModelBudget): NormalizedModelBudget {
	const limitNumber = (value: number | undefined, label: string): number =>
		value === undefined || value === Number.POSITIVE_INFINITY ? Number.POSITIVE_INFINITY : usageNumber(value, label);
	const maxModelCalls = input.maxModelCalls;
	const maxInputTokens = input.maxInputTokens ?? input.inputTokenLimit;
	const maxOutputTokens = input.maxOutputTokens ?? input.outputTokenLimit;
	const maxTotalTokens = input.maxTotalTokens ?? input.totalTokenLimit;
	const maxCost = input.maxCost ?? input.maxCostUsd ?? input.costLimit ?? input.cost;
	const normalizedInputTokens = limitNumber(maxInputTokens, "maxInputTokens");
	const normalizedOutputTokens = limitNumber(maxOutputTokens, "maxOutputTokens");
	const normalizedTotalTokens = limitNumber(maxTotalTokens, "maxTotalTokens");
	const normalizedCost = limitNumber(maxCost, "maxCost");
	return {
		maxModelCalls: limitNumber(maxModelCalls, "maxModelCalls"),
		maxInputTokens: normalizedInputTokens,
		maxOutputTokens: normalizedOutputTokens,
		maxTotalTokens: normalizedTotalTokens,
		maxCost: normalizedCost,
	};
}

function budgetRemaining(
	budget: NormalizedModelBudget,
	committed: NormalizedModelUsage,
	reserved: NormalizedModelUsage,
): NormalizedModelUsage {
	const used = addUsage(committed, reserved);
	return deepFreeze({
		...(Number.isFinite(budget.maxModelCalls) || used.modelCalls !== undefined
			? { modelCalls: Math.max(0, budget.maxModelCalls - (used.modelCalls ?? 0)) }
			: {}),
		inputTokens: Math.max(0, budget.maxInputTokens - used.inputTokens),
		outputTokens: Math.max(0, budget.maxOutputTokens - used.outputTokens),
		totalTokens: Math.max(0, budget.maxTotalTokens - used.totalTokens),
		cost: Math.max(0, budget.maxCost - used.cost),
	});
}

function budgetExceeded(
	budget: NormalizedModelBudget,
	committed: NormalizedModelUsage,
	reserved: NormalizedModelUsage,
	estimate: NormalizedModelUsage,
): string[] {
	const projected = addUsage(addUsage(committed, reserved), estimate);
	const exceeded: string[] = [];
	if (projected.inputTokens > budget.maxInputTokens) exceeded.push("inputTokens");
	if (projected.outputTokens > budget.maxOutputTokens) exceeded.push("outputTokens");
	if (projected.totalTokens > budget.maxTotalTokens) exceeded.push("totalTokens");
	if (projected.cost > budget.maxCost) exceeded.push("cost");
	if (projected.modelCalls !== undefined && projected.modelCalls > budget.maxModelCalls) exceeded.push("modelCalls");
	return exceeded;
}

let reservationSequence = 0;

function defaultReservationId(): string {
	reservationSequence += 1;
	return `model-reservation:${Date.now().toString(36)}-${reservationSequence.toString(36)}`;
}

function preflightEstimate(input: Omit<ModelBudgetPreflightInput, "budget">): ModelUsage | undefined {
	if (input.estimate !== undefined) return input.estimate;
	if (input.usage !== undefined) return input.usage;
	if (
		input.estimatedInputTokens === undefined &&
		input.estimatedOutputTokens === undefined &&
		input.estimatedTotalTokens === undefined &&
		input.estimatedCost === undefined
	) {
		return undefined;
	}
	return {
		inputTokens: input.estimatedInputTokens,
		outputTokens: input.estimatedOutputTokens,
		totalTokens: input.estimatedTotalTokens,
		costUsd: input.estimatedCost,
	};
}

function preflightBudgetInternal(input: ModelBudgetPreflightInput): ModelBudgetPreflightResult {
	let budget: NormalizedModelBudget;
	let estimate: NormalizedModelUsage;
	let committed: NormalizedModelUsage;
	let reserved: NormalizedModelUsage;
	try {
		budget = normalizeBudget(input.budget);
		const rawEstimate = preflightEstimate(input);
		estimate = normalizeModelUsage(
			rawEstimate === undefined || (Number.isFinite(budget.maxModelCalls) && rawEstimate.modelCalls === undefined)
				? { ...(rawEstimate ?? {}), ...(Number.isFinite(budget.maxModelCalls) ? { modelCalls: 1 } : {}) }
				: rawEstimate,
		);
		committed = normalizeModelUsage(input.committed);
		reserved = normalizeModelUsage(input.reserved);
	} catch (error) {
		const modelError =
			error instanceof ModelBrokerError
				? createModelError(error.code, error.message, error.retryable)
				: createModelError("model_budget_invalid", "Budget preflight input is invalid", false);
		return { ok: false, error: modelError };
	}
	const exceeded = budgetExceeded(budget, committed, reserved, estimate);
	if (exceeded.length > 0) {
		return {
			ok: false,
			error: createModelError("model_budget_exceeded", `Model budget exceeded: ${exceeded.join(", ")}`, false, {
				exceeded,
			}),
		};
	}
	const id = input.reservationId ?? defaultReservationId();
	const reservation: ModelBudgetReservation = {
		id,
		estimate,
		...(input.bindingId !== undefined ? { bindingId: input.bindingId } : {}),
		createdAt: input.now ?? new Date().toISOString(),
	};
	const nextReserved = addUsage(reserved, estimate);
	const state: ModelBudgetState = deepFreeze({ committed, reserved: nextReserved });
	return {
		ok: true,
		preflight: deepFreeze({
			budget: deepFreeze({ ...input.budget }),
			reservation: deepFreeze(reservation),
			state,
			remaining: budgetRemaining(budget, committed, nextReserved),
		}),
	};
}

export function preflightBudget(input: ModelBudgetPreflightInput): ModelBudgetPreflightResult;
export function preflightBudget(
	budget: ModelBudget,
	estimate: ModelUsage,
	committed?: ModelUsage,
	reserved?: ModelUsage,
): ModelBudgetPreflightResult;
export function preflightBudget(
	inputOrBudget: ModelBudgetPreflightInput | ModelBudget,
	estimate?: ModelUsage,
	committed?: ModelUsage,
	reserved?: ModelUsage,
): ModelBudgetPreflightResult {
	if ("budget" in inputOrBudget) return preflightBudgetInternal(inputOrBudget);
	return preflightBudgetInternal({ budget: inputOrBudget, estimate, committed, reserved });
}

/** Pure settlement of one preflight receipt. */
export function settleBudget(preflight: ModelBudgetPreflight, actual: ModelUsage): ModelBudgetSettlementResult;
export function settleBudget(
	budget: ModelBudget,
	reservation: ModelBudgetReservation,
	actual: ModelUsage,
	committed?: ModelUsage,
	reserved?: ModelUsage,
): ModelBudgetSettlementResult;
export function settleBudget(
	preflightOrBudget: ModelBudgetPreflight | ModelBudget,
	reservationOrActual: ModelBudgetReservation | ModelUsage,
	actualMaybe?: ModelUsage,
	committedInput?: ModelUsage,
	reservedInput?: ModelUsage,
): ModelBudgetSettlementResult {
	let budget: ModelBudget;
	let reservation: ModelBudgetReservation;
	let actual: ModelUsage;
	let committed: NormalizedModelUsage;
	let reserved: NormalizedModelUsage;
	if ("reservation" in preflightOrBudget) {
		budget = preflightOrBudget.budget;
		reservation = preflightOrBudget.reservation;
		actual = reservationOrActual as ModelUsage;
		committed = preflightOrBudget.state.committed;
		reserved = preflightOrBudget.state.reserved;
	} else {
		budget = preflightOrBudget;
		reservation = reservationOrActual as ModelBudgetReservation;
		actual = actualMaybe ?? {};
		try {
			committed = normalizeModelUsage(committedInput);
			reserved = normalizeModelUsage(reservedInput);
		} catch (error) {
			const modelError =
				error instanceof ModelBrokerError
					? createModelError(error.code, error.message, error.retryable)
					: createModelError("model_budget_settlement_invalid", "Budget settlement input is invalid", false);
			return { ok: false, error: modelError };
		}
	}
	let normalizedActual: NormalizedModelUsage;
	let normalizedBudget: NormalizedModelBudget;
	try {
		normalizedBudget = normalizeBudget(budget);
		normalizedActual = normalizeModelUsage(
			Number.isFinite(normalizedBudget.maxModelCalls) && actual.modelCalls === undefined
				? { ...actual, modelCalls: reservation.estimate.modelCalls ?? 1 }
				: actual,
		);
	} catch (error) {
		const modelError =
			error instanceof ModelBrokerError
				? createModelError("model_budget_settlement_invalid", error.message, false)
				: createModelError("model_budget_settlement_invalid", "Budget settlement input is invalid", false);
		return { ok: false, error: modelError };
	}
	const releasedReserved = subtractUsage(reserved, reservation.estimate);
	const exceeded = budgetExceeded(normalizedBudget, committed, releasedReserved, normalizedActual);
	if (exceeded.length > 0) {
		return {
			ok: false,
			error: createModelError(
				"model_budget_exceeded",
				`Model budget exceeded at settlement: ${exceeded.join(", ")}`,
				false,
			),
		};
	}
	const nextCommitted = addUsage(committed, normalizedActual);
	const state: ModelBudgetState = deepFreeze({ committed: nextCommitted, reserved: releasedReserved });
	return {
		ok: true,
		settlement: deepFreeze({
			reservationId: reservation.id,
			usage: normalizedActual,
			state,
			remaining: budgetRemaining(normalizedBudget, nextCommitted, releasedReserved),
		}),
	};
}

// ---- Public summaries ------------------------------------------------------

export interface PublicModelRouteCandidate {
	readonly reference: NormalizedModelReference;
	readonly priority: number;
	readonly weight?: number;
	readonly enabled: boolean;
	readonly available: boolean;
	readonly label?: string;
}

export interface PublicModelRoute {
	readonly id: string;
	readonly candidates: readonly PublicModelRouteCandidate[];
	readonly fallback?: ModelFallbackPolicy;
	readonly budget?: ModelBudget;
}

export interface PublicModelRole {
	readonly id: string;
	readonly routeId?: string;
	readonly candidates?: readonly PublicModelRouteCandidate[];
}

export interface PublicModelBinding {
	readonly id: string;
	readonly reference: NormalizedModelReference;
	readonly source: ModelResolutionSource;
	readonly fallbackAllowed: boolean;
	readonly candidates: readonly NormalizedModelReference[];
	readonly fallback: ModelFallbackPolicy;
	readonly budget: ModelBudget;
	readonly configRevision?: string;
	readonly createdAt: string;
	readonly routeId?: string;
	readonly role?: string;
	readonly candidateIndex?: number;
}

export interface PublicModelSummary {
	readonly schemaVersion: typeof MODEL_BROKER_SCHEMA_VERSION;
	readonly models: readonly NormalizedModelReference[];
	readonly routes: readonly PublicModelRoute[];
	readonly roles: readonly string[];
	readonly roleRoutes: readonly PublicModelRole[];
	readonly bindings: readonly PublicModelBinding[];
	/** Binding selected for the current session operation, when one is attached. */
	readonly currentBindingId?: string;
	readonly budget?: {
		readonly committed: NormalizedModelUsage;
		readonly reserved: NormalizedModelUsage;
		readonly remaining: NormalizedModelUsage;
	};
}

export interface ModelBindingBudgetSummary {
	readonly budget: ModelBudget;
	readonly committed: NormalizedModelUsage;
	readonly reserved: NormalizedModelUsage;
	readonly remaining: NormalizedModelUsage;
	readonly exceeded: boolean;
}

export function toPublicModelReference(
	reference: NormalizedModelReference | ModelReferenceInput,
): NormalizedModelReference {
	return normalizeModelReference(reference);
}

function publicCandidate(candidate: NormalizedRouteCandidate): PublicModelRouteCandidate {
	return deepFreeze({
		reference: candidate.reference,
		priority: candidate.priority,
		...(candidate.weight !== undefined ? { weight: candidate.weight } : {}),
		enabled: candidate.enabled,
		available: candidate.available,
		...(candidate.label !== undefined ? { label: candidate.label } : {}),
	});
}

export function toPublicModelBinding(binding: ModelBinding): PublicModelBinding {
	return deepFreeze({
		id: binding.id,
		reference: binding.reference,
		source: binding.source,
		fallbackAllowed: binding.fallbackAllowed,
		candidates: deepFreeze([...(binding.candidates ?? [binding.reference])]),
		fallback: binding.fallback ?? deepFreeze({ maxAttempts: 1, on: [] }),
		budget: deepFreeze({ ...(binding.budget ?? {}) }),
		createdAt: binding.createdAt,
		...(binding.routeId !== undefined ? { routeId: binding.routeId } : {}),
		...(binding.role !== undefined ? { role: binding.role } : {}),
		...(binding.candidateIndex !== undefined ? { candidateIndex: binding.candidateIndex } : {}),
		...(binding.configRevision === undefined ? {} : { configRevision: binding.configRevision }),
	});
}

/**
 * Derive a stable public revision from the persisted ModelBroker facts. The
 * creation timestamp is intentionally excluded so replaying the same binding
 * does not create a new handle.
 */
export function getModelBindingRevision(binding: ModelBinding): string {
	return createBindingRevision({
		reference: binding.reference,
		source: binding.source,
		candidates: binding.candidates ?? [binding.reference],
		fallback: binding.fallback,
		budget: binding.budget,
		configRevision: binding.configRevision,
		routeId: binding.routeId,
		role: binding.role,
		candidateIndex: binding.candidateIndex,
	});
}

/** Build the small, public-safe ModelBroker binding handle. */
export function toModelBindingHandle(binding: ModelBinding): BindingHandle {
	const summary: PublicBindingSummary = {
		source: binding.source,
		provider: binding.reference.provider,
		candidateCount: binding.candidates?.length ?? 1,
		fallbackAllowed: binding.fallbackAllowed,
		...(binding.reference.id.length <= 256 && !/[\\/@]/.test(binding.reference.id) && !/[a-z][a-z0-9+.-]*:\/\//i.test(binding.reference.id)
			? { modelId: binding.reference.id }
			: {}),
		...(binding.routeId === undefined ? {} : { routeId: binding.routeId }),
		...(binding.role === undefined ? {} : { role: binding.role }),
	};
	return createBindingHandle({
		domain: "model",
		bindingId: binding.id,
		revision: getModelBindingRevision(binding),
		relation: "run.model",
		role: binding.role ?? binding.source,
		summary,
	});
}

export const createModelBindingHandle = toModelBindingHandle;
export const toPublicModelBindingHandle = toModelBindingHandle;
export const serializePublicModelBindingHandle = toModelBindingHandle;

export function isModelBindingHandle(value: unknown): value is BindingHandle {
	return isBindingHandle(value) && value.domain === "model";
}

export function createPublicModelSummary(input: {
	models?: readonly NormalizedModelReference[];
	routes?: ReadonlyMap<string, readonly NormalizedRouteCandidate[]>;
	routePolicies?: ReadonlyMap<string, NormalizedRoutePolicy>;
	roles?: ReadonlyMap<string, readonly NormalizedRouteCandidate[] | string>;
	bindings?: readonly ModelBinding[];
	currentBindingId?: string;
	budget?: PublicModelSummary["budget"];
}): PublicModelSummary {
	const routes = [...(input.routes?.entries() ?? [])].map(([id, candidates]) => {
		const policy = input.routePolicies?.get(id);
		return deepFreeze({
			id,
			candidates: deepFreeze(candidates.map(publicCandidate)),
			...(policy?.fallback === undefined ? {} : { fallback: policy.fallback }),
			...(policy?.budget === undefined ? {} : { budget: deepFreeze({ ...policy.budget }) }),
		});
	});
	const roleRoutes = [...(input.roles?.entries() ?? [])].map(([id, value]) =>
		deepFreeze({
			id,
			...(typeof value === "string" ? { routeId: value } : { candidates: deepFreeze(value.map(publicCandidate)) }),
		}),
	);
	return deepFreeze({
		schemaVersion: MODEL_BROKER_SCHEMA_VERSION,
		models: deepFreeze([...(input.models ?? [])]),
		routes: deepFreeze(routes),
		roles: deepFreeze([...(input.roles?.keys() ?? [])]),
		roleRoutes: deepFreeze(roleRoutes),
		bindings: deepFreeze((input.bindings ?? []).map(toPublicModelBinding)),
		...(input.currentBindingId === undefined ? {} : { currentBindingId: input.currentBindingId }),
		...(input.budget !== undefined ? { budget: input.budget } : {}),
	});
}

function isBudgetPreflightRequest(
	input: ModelBrokerBudgetPreflightInput | ModelUsage,
): input is ModelBrokerBudgetPreflightInput {
	return (
		"estimate" in input ||
		"usage" in input ||
		"estimatedInputTokens" in input ||
		"estimatedOutputTokens" in input ||
		"estimatedTotalTokens" in input ||
		"estimatedCost" in input ||
		"reservationId" in input ||
		"bindingId" in input ||
		"now" in input
	);
}

// ---- Broker ----------------------------------------------------------------

export class ModelBroker {
	private readonly routes: ReadonlyMap<string, readonly NormalizedRouteCandidate[]>;
	private readonly routePolicies: ReadonlyMap<string, NormalizedRoutePolicy>;
	private readonly roles: ReadonlyMap<string, readonly NormalizedRouteCandidate[] | string>;
	private readonly models: readonly NormalizedModelReference[];
	private readonly now: () => string;
	private readonly bindingIdFactory?: () => string;
	private readonly defaultRoute?: string;
	private readonly defaultRole?: string;
	private readonly configRevision?: string;
	private readonly bindings = new Map<string, ModelBinding>();
	private readonly budget?: NormalizedModelBudget;
	private committedUsage: NormalizedModelUsage = ZERO_USAGE;
	private reservedUsage: NormalizedModelUsage = ZERO_USAGE;
	private readonly reservations = new Map<string, { reservation: ModelBudgetReservation; settled: boolean }>();
	private readonly bindingBudgetStates = new Map<string, BindingBudgetState>();
	private readonly bindingBudgetReservations = new Map<string, TrackedBindingBudgetReservation>();

	constructor(options: ModelBrokerOptions = {}) {
		this.routes = mergeRouteMaps(options.globalRoutes, options.routes);
		this.routePolicies = mergeRoutePolicies(options.globalRoutes, options.routes);
		this.roles = mergeRoleMaps(options.roles, options.roleRoutes);
		this.models = deepFreeze(
			(options.models ?? []).flatMap((model) => {
				const parsed = parseModelReference(model);
				return parsed.ok ? [parsed.reference] : [];
			}),
		);
		this.now = options.now ?? (() => new Date().toISOString());
		this.bindingIdFactory = options.bindingIdFactory;
		this.defaultRoute = options.defaultRoute;
		this.defaultRole = options.defaultRole;
		this.configRevision = options.configRevision;
		if (options.budget !== undefined) this.budget = normalizeBudget(options.budget);
	}

	/** Return a discriminated result without throwing on selection failures. */
	resolveResult(input: ModelBrokerResolveInput): ModelResolutionResult {
		let result: ModelResolutionResult;
		try {
			result = resolveWithCatalog(
				applyResolutionAliases(input, {
					defaultRoute: this.defaultRoute,
					defaultRole: this.defaultRole,
				}),
				this.routes,
				this.roles,
				{
					now: this.now,
					bindingIdFactory: this.bindingIdFactory,
					routePolicies: this.routePolicies,
					configRevision: this.configRevision,
					budget: this.budget,
				},
			);
		} catch (error) {
			if (error instanceof ModelBrokerError) {
				return {
					ok: false,
					error: createModelError(error.code, error.message, error.retryable, error.details),
				};
			}
			return {
				ok: false,
				error: createModelError("model_invalid_reference", "Model selection is invalid", false),
			};
		}
		if (result.ok) {
			if (this.bindings.has(result.resolution.binding.id)) {
				return {
					ok: false,
					error: createModelError("model_binding_conflict", "Binding id has already been used", false),
				};
			}
			this.bindings.set(result.resolution.binding.id, result.resolution.binding);
		}
		return result;
	}

	/** Resolve and throw a stable ModelBrokerError when no safe selection exists. */
	resolve(input: ModelBrokerResolveInput): ModelResolution {
		const result = this.resolveResult(input);
		if (!result.ok) throw new ModelBrokerError(result.error);
		return result.resolution;
	}

	resolveModel(input: ModelBrokerResolveInput): ModelResolution {
		return this.resolve(input);
	}

	bind(input: ModelBrokerResolveInput): ModelBinding {
		return this.resolve(input).binding;
	}

	getBinding(id: string): ModelBinding | undefined {
		return this.bindings.get(id);
	}

	getBindings(): readonly ModelBinding[] {
		return deepFreeze([...this.bindings.values()]);
	}

	/** Return the stable public handle for a persisted broker binding. */
	getBindingHandle(bindingId: string): BindingHandle | undefined {
		const binding = this.bindings.get(bindingId);
		return binding === undefined ? undefined : toModelBindingHandle(binding);
	}

	getBindingHandles(): readonly BindingHandle[] {
		return deepFreeze([...this.bindings.values()].map(toModelBindingHandle));
	}

	hasDefaultSelection(): boolean {
		return this.defaultRoute !== undefined || this.defaultRole !== undefined;
	}

	getBindingPolicy(bindingId: string):
		| {
				fallback: ModelFallbackPolicy;
				budget: ModelBudget;
				configRevision?: string;
		  }
		| undefined {
		const binding = this.bindings.get(bindingId);
		if (binding === undefined) return undefined;
		return deepFreeze({
			fallback: binding.fallback ?? deepFreeze({ maxAttempts: 1, on: [] }),
			budget: deepFreeze({ ...(binding.budget ?? {}) }),
			...(binding.configRevision === undefined ? {} : { configRevision: binding.configRevision }),
		});
	}

	hasBudgetForBinding(bindingId: string): boolean {
		const budget = this.bindings.get(bindingId)?.budget;
		return budget !== undefined && Object.values(budget).some((value) => value !== undefined);
	}

	beginBindingOperation(bindingId: string): void {
		this.bindingBudgetStates.delete(bindingId);
		for (const [reservationId, reservation] of this.bindingBudgetReservations) {
			if (reservation.bindingId === bindingId) this.bindingBudgetReservations.delete(reservationId);
		}
	}

	preflightBudgetForBinding(
		bindingId: string,
		input: ModelBrokerBudgetPreflightInput | ModelUsage = {},
	): ModelBudgetPreflightResult {
		const binding = this.bindings.get(bindingId);
		if (binding === undefined) {
			return {
				ok: false,
				error: createModelError("model_binding_unavailable", "Model binding is not available", false),
			};
		}
		const budget = binding.budget ?? {};
		const request = isBudgetPreflightRequest(input) ? input : { estimate: input };
		const state = this.bindingBudgetStates.get(bindingId) ?? {
			budget,
			committed: ZERO_USAGE,
			reserved: ZERO_USAGE,
			exceeded: false,
		};
		let normalizedBudget: NormalizedModelBudget;
		try {
			normalizedBudget = normalizeBudget(budget);
		} catch (error) {
			return {
				ok: false,
				error:
					error instanceof ModelBrokerError
						? createModelError("model_budget_invalid", error.message, false)
						: createModelError("model_budget_invalid", "Binding budget is invalid", false),
			};
		}
		const rawEstimate = preflightEstimate(request);
		const estimate =
			Number.isFinite(normalizedBudget.maxModelCalls) && rawEstimate?.modelCalls === undefined
				? { ...(rawEstimate ?? {}), modelCalls: 1 }
				: rawEstimate;
		const result = preflightBudgetInternal({
			budget,
			estimate,
			reservationId: request.reservationId,
			bindingId,
			now: request.now ?? this.now(),
			committed: state.committed,
			reserved: state.reserved,
		});
		if (!result.ok) {
			if (result.error.code === "model_budget_exceeded") {
				this.bindingBudgetStates.set(bindingId, { ...state, exceeded: true });
			}
			return result;
		}
		if (this.bindingBudgetReservations.has(result.preflight.reservation.id)) {
			return {
				ok: false,
				error: createModelError(
					"model_budget_settlement_invalid",
					"Budget reservation id has already been used",
					false,
				),
			};
		}
		this.bindingBudgetStates.set(bindingId, {
			budget,
			committed: state.committed,
			reserved: result.preflight.state.reserved,
			exceeded: state.exceeded,
		});
		this.bindingBudgetReservations.set(result.preflight.reservation.id, {
			bindingId,
			budget,
			reservation: result.preflight.reservation,
			settled: false,
		});
		return result;
	}

	settleBudgetForBinding(
		bindingId: string,
		reservationId: string,
		actual: ModelUsage = {},
	): ModelBudgetSettlementResult {
		const tracked = this.bindingBudgetReservations.get(reservationId);
		const state = this.bindingBudgetStates.get(bindingId);
		if (!tracked || tracked.bindingId !== bindingId || tracked.settled || !state) {
			return {
				ok: false,
				error: createModelError(
					"model_budget_settlement_invalid",
					"Unknown or already settled binding budget reservation",
					false,
				),
			};
		}
		let normalizedBudget: NormalizedModelBudget;
		try {
			normalizedBudget = normalizeBudget(tracked.budget);
		} catch (error) {
			return {
				ok: false,
				error:
					error instanceof ModelBrokerError
						? createModelError("model_budget_settlement_invalid", error.message, false)
						: createModelError("model_budget_settlement_invalid", "Binding budget is invalid", false),
			};
		}
		const settledUsage =
			Number.isFinite(normalizedBudget.maxModelCalls) && actual.modelCalls === undefined
				? { ...actual, modelCalls: tracked.reservation.estimate.modelCalls ?? 1 }
				: actual;
		const result = settleBudget(tracked.budget, tracked.reservation, settledUsage, state.committed, state.reserved);
		if (result.ok) {
			tracked.settled = true;
			state.committed = result.settlement.state.committed;
			state.reserved = result.settlement.state.reserved;
			return result;
		}
		if (result.error.code === "model_budget_exceeded") {
			try {
				const normalizedActual = normalizeModelUsage(settledUsage);
				tracked.settled = true;
				state.committed = addUsage(state.committed, normalizedActual);
				state.reserved = subtractUsage(state.reserved, tracked.reservation.estimate);
				state.exceeded = true;
			} catch {
				// Keep the original settlement error when the provider usage is malformed.
			}
		}
		return result;
	}

	getBindingBudgetSummary(bindingId: string): ModelBindingBudgetSummary | undefined {
		const state = this.bindingBudgetStates.get(bindingId);
		if (!state) return undefined;
		const budget = normalizeBudget(state.budget);
		return deepFreeze({
			budget: deepFreeze({ ...state.budget }),
			committed: state.committed,
			reserved: state.reserved,
			remaining: budgetRemaining(budget, state.committed, state.reserved),
			exceeded: state.exceeded,
		});
	}

	preflightBudget(input: ModelBrokerBudgetPreflightInput | ModelUsage = {}): ModelBudgetPreflightResult {
		const request = isBudgetPreflightRequest(input) ? input : { estimate: input };
		if (!this.budget) {
			let estimate: NormalizedModelUsage;
			try {
				estimate = normalizeModelUsage(preflightEstimate(request));
			} catch (error) {
				const modelError =
					error instanceof ModelBrokerError
						? createModelError("model_budget_invalid", error.message, false)
						: createModelError("model_budget_invalid", "Budget preflight input is invalid", false);
				return { ok: false, error: modelError };
			}
			const reservation: ModelBudgetReservation = deepFreeze({
				id: request.reservationId ?? defaultReservationId(),
				estimate,
				...(request.bindingId !== undefined ? { bindingId: request.bindingId } : {}),
				createdAt: request.now ?? this.now(),
			});
			if (this.reservations.has(reservation.id)) {
				return {
					ok: false,
					error: createModelError(
						"model_budget_settlement_invalid",
						"Budget reservation id has already been used",
						false,
					),
				};
			}
			this.reservations.set(reservation.id, { reservation, settled: false });
			this.reservedUsage = addUsage(this.reservedUsage, estimate);
			return {
				ok: true,
				preflight: deepFreeze({
					budget: deepFreeze({
						maxInputTokens: Number.POSITIVE_INFINITY,
						maxOutputTokens: Number.POSITIVE_INFINITY,
						maxTotalTokens: Number.POSITIVE_INFINITY,
						maxCost: Number.POSITIVE_INFINITY,
					}),
					reservation,
					state: deepFreeze({ committed: this.committedUsage, reserved: this.reservedUsage }),
					remaining: deepFreeze({
						inputTokens: Number.POSITIVE_INFINITY,
						outputTokens: Number.POSITIVE_INFINITY,
						totalTokens: Number.POSITIVE_INFINITY,
						cost: Number.POSITIVE_INFINITY,
					}),
				}),
			};
		}
		const result = preflightBudgetInternal({
			budget: this.budget,
			estimate: preflightEstimate(request),
			reservationId: request.reservationId,
			bindingId: request.bindingId,
			now: request.now ?? this.now(),
			committed: this.committedUsage,
			reserved: this.reservedUsage,
		});
		if (!result.ok) return result;
		if (this.reservations.has(result.preflight.reservation.id)) {
			return {
				ok: false,
				error: createModelError(
					"model_budget_settlement_invalid",
					"Budget reservation id has already been used",
					false,
				),
			};
		}
		this.reservations.set(result.preflight.reservation.id, {
			reservation: result.preflight.reservation,
			settled: false,
		});
		this.reservedUsage = result.preflight.state.reserved;
		return result;
	}

	preflight(input: ModelBrokerBudgetPreflightInput | ModelUsage = {}): ModelBudgetPreflightResult {
		return this.preflightBudget(input);
	}

	settleBudget(reservationId: string, actual: ModelUsage = {}): ModelBudgetSettlementResult {
		const tracked = this.reservations.get(reservationId);
		if (!tracked || tracked.settled) {
			return {
				ok: false,
				error: createModelError(
					"model_budget_settlement_invalid",
					`Unknown or already settled reservation ${reservationId}`,
					false,
				),
			};
		}
		const budget = this.budget ?? {
			maxInputTokens: Number.POSITIVE_INFINITY,
			maxOutputTokens: Number.POSITIVE_INFINITY,
			maxTotalTokens: Number.POSITIVE_INFINITY,
			maxCost: Number.POSITIVE_INFINITY,
			cost: Number.POSITIVE_INFINITY,
		};
		const result = settleBudget(budget, tracked.reservation, actual, this.committedUsage, this.reservedUsage);
		if (!result.ok) return result;
		tracked.settled = true;
		this.committedUsage = result.settlement.state.committed;
		this.reservedUsage = result.settlement.state.reserved;
		return result;
	}

	settle(reservationId: string, actual: ModelUsage = {}): ModelBudgetSettlementResult {
		return this.settleBudget(reservationId, actual);
	}

	classifyFallback(
		failure: ProviderFailure | string,
		sideEffects?: VisibleSideEffectsInput,
		fallbackAllowed = true,
	): FallbackEligibility {
		return classifyFallbackEligibility(failure, sideEffects, fallbackAllowed);
	}

	publicSummary(currentBindingId?: string): PublicModelSummary {
		const budget = this.budget
			? deepFreeze({
					committed: this.committedUsage,
					reserved: this.reservedUsage,
					remaining: budgetRemaining(this.budget, this.committedUsage, this.reservedUsage),
				})
			: undefined;
		return createPublicModelSummary({
			models: this.models,
			routes: this.routes,
			routePolicies: this.routePolicies,
			roles: this.roles,
			bindings: [...this.bindings.values()],
			...(currentBindingId === undefined ? {} : { currentBindingId }),
			budget,
		});
	}

	getPublicSummary(): PublicModelSummary {
		return this.publicSummary();
	}

	summary(): PublicModelSummary {
		return this.publicSummary();
	}
}

export type ModelBrokerBudgetPreflightInput = Omit<ModelBudgetPreflightInput, "budget"> & {
	estimate?: ModelUsage;
	usage?: ModelUsage;
};
