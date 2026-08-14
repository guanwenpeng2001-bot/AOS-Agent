/**
 * Stable, public-safe references for execution bindings.
 *
 * A handle is an auditable reference, not a live provider, credential, or
 * runtime object. Its id is derived from the domain binding id and revision so
 * replaying the same persisted fact produces the same handle. The allowlist in
 * this module is intentionally smaller than any of the domain binding types.
 */

import { createHash } from "node:crypto";

export const BINDING_HANDLE_SCHEMA_VERSION = 1 as const;
export const BINDING_ASSOCIATION_SCHEMA_VERSION = 1 as const;
export const BINDING_HANDLE_ID_PREFIX = "binding-handle:";
export const BINDING_ASSOCIATION_ID_PREFIX = "binding-association:";

export type BindingDomain = "model" | "capability" | "policy" | "sandbox";

/**
 * Summary values are deliberately scalar. Domain adapters flatten nested
 * capability/status data into this allowlisted shape before creating a handle.
 */
export type PublicBindingSummaryValue = string | number | boolean;

export interface PublicBindingSummary {
	readonly [key: string]: PublicBindingSummaryValue;
}

export interface BindingHandle {
	readonly schemaVersion: typeof BINDING_HANDLE_SCHEMA_VERSION;
	/** Deterministic id for this public handle, distinct from bindingId. */
	readonly id: string;
	readonly domain: BindingDomain;
	/** The persisted domain binding id this handle refers to. */
	readonly bindingId: string;
	/** Stable domain revision or a deterministic digest of the binding facts. */
	readonly revision: string;
	/** Safe relation label, for example `run.model` or `policy.sandbox`. */
	readonly relation?: string;
	/** Safe domain role, for example a ModelBroker role or policy profile. */
	readonly role?: string;
	readonly summary?: PublicBindingSummary;
}

/** Alias for consumers that need only a public binding reference. */
export type PublicBindingReference = BindingHandle;

export interface BindingHandleInput {
	readonly domain: BindingDomain;
	readonly bindingId: string;
	readonly revision: string;
	readonly relation?: string;
	readonly role?: string;
	readonly summary?: Readonly<Record<string, unknown>>;
}

export interface RunBindingAssociation {
	readonly schemaVersion: typeof BINDING_ASSOCIATION_SCHEMA_VERSION;
	readonly id: string;
	readonly runId: string;
	readonly bindings: ReadonlyArray<BindingHandle>;
}

/** Alias used by callers that describe the value as a binding association. */
export type BindingAssociation = RunBindingAssociation;

export type BindingHandleErrorCode =
	| "binding_handle_invalid"
	| "binding_handle_unknown_domain"
	| "binding_association_invalid"
	| "binding_association_conflict";

export class BindingHandleError extends Error {
	readonly code: BindingHandleErrorCode;

	constructor(code: BindingHandleErrorCode, message: string) {
		super(message);
		this.name = "BindingHandleError";
		this.code = code;
	}
}

const DOMAINS: ReadonlySet<string> = new Set(["model", "capability", "policy", "sandbox"]);
const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SAFE_SUMMARY_KEY_PATTERN = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;
const SAFE_SUMMARY_TEXT_PATTERN = /^[^\u0000-\u001f\u007f\r\n]{1,256}$/;
const SUMMARY_KEYS: ReadonlySet<string> = new Set([
	"source",
	"mode",
	"routeId",
	"role",
	"provider",
	"providerId",
	"modelId",
	"profile",
	"profileId",
	"profileRevision",
	"projectTrust",
	"enforcement",
	"sandboxProviderId",
	"sandboxStatus",
	"policyBindingId",
	"status",
	"candidateCount",
	"descriptorCount",
	"toolCount",
	"allowed",
	"awaitingApproval",
	"denied",
	"fallbackAllowed",
	"filesystem",
	"process",
	"network",
	"credentialIsolation",
	"resource",
	"action",
	"outcome",
	"reasonCode",
	"requestId",
	"timestamp",
]);
const FORBIDDEN_SUMMARY_KEY_PATTERN =
	/(?:credential|secret|token|password|authorization|header|endpoint|environment|command|argument|cwd|path|url|raw|internal|object|payload|body|config)/i;
const SECRET_ASSIGNMENT_PATTERN =
	/\b(?:bearer|token|api[_-]?key|secret|password|authorization|credential)\b\s*[:=]/i;
const URL_PATTERN = /[a-z][a-z0-9+.-]*:\/\//i;

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function deepFreeze<T>(value: T): T {
	if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
	Object.freeze(value);
	for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
	return value;
}

function isSafeIdentifier(value: unknown): value is string {
	return (
		typeof value === "string" &&
		SAFE_IDENTIFIER_PATTERN.test(value) &&
		!URL_PATTERN.test(value) &&
		!SECRET_ASSIGNMENT_PATTERN.test(value)
	);
}

function isSafeSummaryText(value: unknown): value is string {
	return (
		typeof value === "string" &&
		SAFE_SUMMARY_TEXT_PATTERN.test(value) &&
		!URL_PATTERN.test(value) &&
		!value.includes("\\") &&
		!value.includes("/") &&
		!value.includes("@") &&
		!SECRET_ASSIGNMENT_PATTERN.test(value)
	);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
	return Object.keys(value).every((key) => allowed.has(key));
}

function normalizeSummary(value: unknown): PublicBindingSummary | undefined {
	if (value === undefined) return undefined;
	if (!isRecord(value)) return undefined;
	for (const [key, child] of Object.entries(value)) {
		if (
			!SAFE_SUMMARY_KEY_PATTERN.test(key) ||
			!SUMMARY_KEYS.has(key) ||
			(FORBIDDEN_SUMMARY_KEY_PATTERN.test(key) && key !== "credentialIsolation")
		) {
			return undefined;
		}
		if (typeof child === "string") {
			if (!isSafeSummaryText(child)) return undefined;
			continue;
		}
		if (typeof child === "number") {
			if (!Number.isFinite(child) || Math.abs(child) > Number.MAX_SAFE_INTEGER) return undefined;
			continue;
		}
		if (typeof child === "boolean") continue;
		return undefined;
	}
	const normalized: PublicBindingSummary = {};
	for (const key of Object.keys(value).sort()) {
		const child = value[key];
		if (typeof child === "string" || typeof child === "number" || typeof child === "boolean") {
			(normalized as Record<string, PublicBindingSummaryValue>)[key] = child;
		}
	}
	return deepFreeze(normalized);
}

function canonicalValue(value: unknown, seen: ReadonlySet<object> = new Set<object>()): string {
	if (value === null) return "null";
	if (value === undefined) return "undefined";
	if (typeof value === "string") return JSON.stringify(value);
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new BindingHandleError("binding_handle_invalid", "Binding seed contains a non-finite number");
		return String(value);
	}
	if (typeof value === "boolean") return value ? "true" : "false";
	if (typeof value !== "object") throw new BindingHandleError("binding_handle_invalid", "Binding seed contains an unsupported value");
	if (seen.has(value)) throw new BindingHandleError("binding_handle_invalid", "Binding seed contains a cycle");
	const nextSeen = new Set(seen);
	nextSeen.add(value);
	if (Array.isArray(value)) return `[${value.map((item) => canonicalValue(item, nextSeen)).join(",")}]`;
	const record = value as Record<string, unknown>;
	return `{${Object.keys(record)
		.sort()
		.map((key) => `${JSON.stringify(key)}:${canonicalValue(record[key], nextSeen)}`)
		.join(",")}}`;
}

function hashCanonical(value: unknown): string {
	return createHash("sha256").update(canonicalValue(value), "utf8").digest("base64url");
}

/** Create a deterministic revision without exposing the source seed. */
export function createBindingRevision(seed: unknown): string {
	return `rev:${hashCanonical(seed)}`;
}

/** Create a deterministic domain binding id for a binding with no persisted id. */
export function createStableBindingId(domain: BindingDomain, seed: unknown): string {
	if (!DOMAINS.has(domain)) throw new BindingHandleError("binding_handle_unknown_domain", "Unknown binding domain");
	return `${domain}-binding:${hashCanonical(seed)}`;
}

function handleIdentity(input: Pick<BindingHandleInput, "domain" | "bindingId" | "revision" | "relation" | "role">): string {
	return `${BINDING_HANDLE_ID_PREFIX}${input.domain}:${hashCanonical({
		domain: input.domain,
		bindingId: input.bindingId,
		revision: input.revision,
		relation: input.relation,
		role: input.role,
	})}`;
}

/** Return the deterministic id a valid handle must carry. */
export function deriveBindingHandleId(
	input: Pick<BindingHandleInput, "domain" | "bindingId" | "revision" | "relation" | "role">,
): string {
	return handleIdentity(input);
}

function normalizeHandleInput(input: BindingHandleInput): BindingHandle {
	if (!DOMAINS.has(input.domain)) {
		throw new BindingHandleError("binding_handle_unknown_domain", "Unknown binding domain");
	}
	if (!isSafeIdentifier(input.bindingId) || !isSafeIdentifier(input.revision)) {
		throw new BindingHandleError("binding_handle_invalid", "Binding handle id or revision is invalid");
	}
	if (input.relation !== undefined && !isSafeIdentifier(input.relation)) {
		throw new BindingHandleError("binding_handle_invalid", "Binding handle relation is invalid");
	}
	if (input.role !== undefined && !isSafeIdentifier(input.role)) {
		throw new BindingHandleError("binding_handle_invalid", "Binding handle role is invalid");
	}
	const summary = normalizeSummary(input.summary);
	if (input.summary !== undefined && summary === undefined) {
		throw new BindingHandleError("binding_handle_invalid", "Binding handle summary is not public-safe");
	}
	const identity = {
		domain: input.domain,
		bindingId: input.bindingId,
		revision: input.revision,
		...(input.relation === undefined ? {} : { relation: input.relation }),
		...(input.role === undefined ? {} : { role: input.role }),
	};
	return deepFreeze({
		schemaVersion: BINDING_HANDLE_SCHEMA_VERSION,
		id: handleIdentity(identity),
		domain: input.domain,
		bindingId: input.bindingId,
		revision: input.revision,
		...(input.relation === undefined ? {} : { relation: input.relation }),
		...(input.role === undefined ? {} : { role: input.role }),
		...(summary === undefined ? {} : { summary }),
	});
}

/** Construct and freeze a minimal public-safe binding handle. */
export function createBindingHandle(input: BindingHandleInput): BindingHandle {
	return normalizeHandleInput(input);
}

const HANDLE_KEYS: ReadonlySet<string> = new Set([
	"schemaVersion",
	"id",
	"domain",
	"bindingId",
	"revision",
	"relation",
	"role",
	"summary",
]);

/** Parse a persisted handle while dropping no unknown data silently. */
export function parseBindingHandle(value: unknown): BindingHandle | undefined {
	if (!isRecord(value) || !hasOnlyKeys(value, HANDLE_KEYS)) return undefined;
	if (value.schemaVersion !== BINDING_HANDLE_SCHEMA_VERSION || !DOMAINS.has(value.domain as string)) return undefined;
	if (!isSafeIdentifier(value.bindingId) || !isSafeIdentifier(value.revision) || !isSafeIdentifier(value.id)) return undefined;
	if (value.relation !== undefined && !isSafeIdentifier(value.relation)) return undefined;
	if (value.role !== undefined && !isSafeIdentifier(value.role)) return undefined;
	const summary = normalizeSummary(value.summary);
	if (value.summary !== undefined && summary === undefined) return undefined;
	const identity = {
		domain: value.domain as BindingDomain,
		bindingId: value.bindingId,
		revision: value.revision,
		...(value.relation === undefined ? {} : { relation: value.relation }),
		...(value.role === undefined ? {} : { role: value.role }),
	};
	if (value.id !== handleIdentity(identity)) return undefined;
	return deepFreeze({
		schemaVersion: BINDING_HANDLE_SCHEMA_VERSION,
		id: value.id,
		domain: value.domain as BindingDomain,
		bindingId: value.bindingId,
		revision: value.revision,
		...(value.relation === undefined ? {} : { relation: value.relation }),
		...(value.role === undefined ? {} : { role: value.role }),
		...(summary === undefined ? {} : { summary }),
	});
}

export function isBindingHandle(value: unknown): value is BindingHandle {
	return parseBindingHandle(value) !== undefined;
}

/** Explicit allowlist serializer for public RPC, audit, and SDK consumers. */
export function serializePublicBindingHandle(value: unknown): PublicBindingReference | undefined {
	const handle = parseBindingHandle(value);
	if (handle === undefined) return undefined;
	return deepFreeze({
		schemaVersion: handle.schemaVersion,
		id: handle.id,
		domain: handle.domain,
		bindingId: handle.bindingId,
		revision: handle.revision,
		...(handle.relation === undefined ? {} : { relation: handle.relation }),
		...(handle.role === undefined ? {} : { role: handle.role }),
		...(handle.summary === undefined ? {} : { summary: { ...handle.summary } }),
	});
}

export const serializePublicBindingReference = serializePublicBindingHandle;
export const toPublicBindingReference = serializePublicBindingHandle;

function compareHandles(left: BindingHandle, right: BindingHandle): number {
	for (const key of ["domain", "bindingId", "revision", "id"] as const) {
		if (left[key] < right[key]) return -1;
		if (left[key] > right[key]) return 1;
	}
	return 0;
}

function associationIdentity(runId: string, bindings: ReadonlyArray<BindingHandle>): string {
	return `${BINDING_ASSOCIATION_ID_PREFIX}${hashCanonical({
		runId,
		bindings: bindings.map((binding) => ({
			domain: binding.domain,
			bindingId: binding.bindingId,
			revision: binding.revision,
			relation: binding.relation,
			role: binding.role,
			id: binding.id,
		})),
	})}`;
}

/** Associate one or more persisted binding handles with a Run. */
export function createRunBindingAssociation(
	runId: string,
	handles: ReadonlyArray<BindingHandle>,
): RunBindingAssociation {
	if (!isSafeIdentifier(runId)) throw new BindingHandleError("binding_association_invalid", "Run id is invalid");
	const parsed = handles.map((handle) => parseBindingHandle(handle));
	if (parsed.some((handle) => handle === undefined)) {
		throw new BindingHandleError("binding_association_invalid", "Run binding association contains an invalid handle");
	}
	const validHandles = parsed.filter((handle): handle is BindingHandle => handle !== undefined).sort(compareHandles);
	const ids = new Set<string>();
	for (const handle of validHandles) {
		if (ids.has(handle.id)) throw new BindingHandleError("binding_association_conflict", "Run binding association repeats a handle");
		ids.add(handle.id);
	}
	return deepFreeze({
		schemaVersion: BINDING_ASSOCIATION_SCHEMA_VERSION,
		id: associationIdentity(runId, validHandles),
		runId,
		bindings: validHandles,
	});
}

export const associateBindingHandles = createRunBindingAssociation;
export const createBindingAssociation = createRunBindingAssociation;

const ASSOCIATION_KEYS: ReadonlySet<string> = new Set(["schemaVersion", "id", "runId", "bindings"]);

export function parseRunBindingAssociation(value: unknown): RunBindingAssociation | undefined {
	if (!isRecord(value) || !hasOnlyKeys(value, ASSOCIATION_KEYS)) return undefined;
	if (
		value.schemaVersion !== BINDING_ASSOCIATION_SCHEMA_VERSION ||
		!isSafeIdentifier(value.id) ||
		!isSafeIdentifier(value.runId) ||
		!Array.isArray(value.bindings)
	) {
		return undefined;
	}
	const bindings = value.bindings.map(parseBindingHandle);
	if (bindings.some((binding) => binding === undefined)) return undefined;
	const validHandles = bindings.filter((binding): binding is BindingHandle => binding !== undefined).sort(compareHandles);
	const ids = new Set<string>();
	for (const handle of validHandles) {
		if (ids.has(handle.id)) return undefined;
		ids.add(handle.id);
	}
	if (value.id !== associationIdentity(value.runId, validHandles)) return undefined;
	return deepFreeze({
		schemaVersion: BINDING_ASSOCIATION_SCHEMA_VERSION,
		id: value.id,
		runId: value.runId,
		bindings: validHandles,
	});
}

export function isRunBindingAssociation(value: unknown): value is RunBindingAssociation {
	return parseRunBindingAssociation(value) !== undefined;
}

export function serializePublicRunBindingAssociation(value: unknown): RunBindingAssociation | undefined {
	const association = parseRunBindingAssociation(value);
	if (association === undefined) return undefined;
	return deepFreeze({
		schemaVersion: association.schemaVersion,
		id: association.id,
		runId: association.runId,
		bindings: association.bindings.map((binding) => serializePublicBindingHandle(binding) as BindingHandle),
	});
}

export const parseBindingAssociation = parseRunBindingAssociation;
export const isBindingAssociation = isRunBindingAssociation;
export const serializePublicBindingAssociation = serializePublicRunBindingAssociation;
