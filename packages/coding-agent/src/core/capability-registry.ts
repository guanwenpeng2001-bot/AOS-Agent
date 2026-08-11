import type { SourceInfo, SourceOrigin, SourceScope } from "./source-info.ts";

export type CapabilityKind =
	| "builtin_tool"
	| "extension_tool"
	| "sdk_tool"
	| "skill"
	| "extension"
	| "mcp_server"
	| "mcp_tool";

export type CapabilityDecision = "allow" | "ask" | "deny";

export type CapabilityAvailability = "available" | "unavailable" | "degraded";

export interface CapabilitySelector {
	/** Matches the descriptor's stable capability id. */
	id?: string;
	kind?: CapabilityKind;
	/** Matches SourceInfo.source (the capability origin's identity). */
	sourceId?: string;
	scope?: SourceScope;
	/** Matches the logical MCP server id, for mcp_server and its mcp_tool children. */
	mcpServerId?: string;
	/** Matches the parent descriptor id (mcp_tool -> mcp_server). */
	parentId?: string;
}

export interface CapabilityProfileRule {
	selector: CapabilitySelector;
	action: CapabilityDecision;
}

export interface CapabilityProfile {
	/** Applied in order; the last matching rule wins. */
	rules: ReadonlyArray<CapabilityProfileRule>;
}

export interface CapabilityCandidate {
	kind: CapabilityKind;
	/** Display name; may change without changing the stable id. */
	name: string;
	/** Stable origin identity, a component of the capability id. */
	sourceIdentity: string;
	source: SourceInfo;
	/** Identity component of the id; defaults to name. */
	localName?: string;
	exposedToolName?: string;
	/** mcp_tool -> its parent mcp_server descriptor id. */
	parentId?: string;
	/** Logical MCP server id; mcp_server and its mcp_tool children share it. */
	mcpServerId?: string;
	/**
	 * Trust result computed by the caller. Project-scoped sources default to
	 * untrusted; an untrusted capability is force-denied regardless of profile.
	 */
	trusted?: boolean;
	availability?: CapabilityAvailability;
	/** Discovered content used for the revision fingerprint; must be secret-free. */
	revisionInput?: unknown;
}

export interface CapabilityDescriptor {
	id: string;
	revision: string;
	kind: CapabilityKind;
	name: string;
	source: SourceInfo;
	availability: CapabilityAvailability;
	/** Baseline decision before profile resolution (defaults + trust + parent). */
	decision: CapabilityDecision;
	trusted: boolean;
	exposedToolName?: string;
	parentId?: string;
	mcpServerId?: string;
}

export interface CapabilityCatalogInput {
	candidates: ReadonlyArray<CapabilityCandidate>;
}

export interface CapabilityCatalog {
	version: 1;
	descriptors: ReadonlyArray<CapabilityDescriptor>;
}

export interface ResolveBindingInput {
	catalog: CapabilityCatalog;
	/** Named profile to resolve; must exist in {@link profiles}. */
	profile: string;
	profiles?: Readonly<Record<string, CapabilityProfile>>;
	/** Session-local approvals for ask capabilities; never overrides a deny. */
	approvedDescriptorIds?: ReadonlyArray<string>;
	/** `tools` narrowing: only these exposed tool names may be model-visible. */
	toolAllowlist?: ReadonlyArray<string>;
	/** `excludeTools` narrowing. */
	excludeToolNames?: ReadonlyArray<string>;
	/** `noTools` narrowing: no tool is model-visible. */
	noTools?: boolean;
	/** ISO timestamp for the binding; defaults to the current time. */
	now?: string;
}

export interface CapabilityBindingDescriptorRef {
	id: string;
	revision: string;
	exposedToolName?: string;
}

export interface CapabilityDecisionSummary {
	allowed: number;
	awaitingApproval: number;
	denied: number;
}

export interface CapabilityBinding {
	id: string;
	profile: string;
	createdAt: string;
	/** Only available and allowed (or ask-approved) descriptors. */
	descriptors: ReadonlyArray<CapabilityBindingDescriptorRef>;
	decisionSummary: CapabilityDecisionSummary;
	/** Final model-visible tool names after the tools/excludeTools/noTools intersection. */
	toolAllowlist: ReadonlyArray<string>;
}

export type CapabilityErrorCode =
	| "capability_profile_not_found"
	| "capability_denied"
	| "capability_approval_required"
	| "capability_name_conflict"
	| "capability_mcp_connect_failed"
	| "capability_mcp_auth_required"
	| "capability_mcp_unavailable"
	| "capability_binding_unavailable";

export interface CapabilitySourceView {
	source: string;
	scope: SourceScope;
	origin: SourceOrigin;
	path?: string;
	baseDir?: string;
}

export interface CapabilityDescriptorView {
	id: string;
	revision: string;
	kind: CapabilityKind;
	name: string;
	source: CapabilitySourceView;
	availability: CapabilityAvailability;
	decision: CapabilityDecision;
	trusted: boolean;
	exposedToolName?: string;
	parentId?: string;
	mcpServerId?: string;
}

export interface CapabilityCatalogView {
	version: 1;
	descriptors: ReadonlyArray<CapabilityDescriptorView>;
}

export interface CapabilityBindingView {
	id: string;
	profile: string;
	createdAt: string;
	descriptors: ReadonlyArray<CapabilityBindingDescriptorRef>;
	decisionSummary: CapabilityDecisionSummary;
	toolAllowlist: ReadonlyArray<string>;
}

export class CapabilityError extends Error {
	readonly code: CapabilityErrorCode;

	constructor(code: CapabilityErrorCode, message: string) {
		super(message);
		this.name = "CapabilityError";
		this.code = code;
	}
}

export class CapabilityProfileNotFoundError extends CapabilityError {
	readonly profile: string;

	constructor(profile: string) {
		super("capability_profile_not_found", `Capability profile not found: ${profile}`);
		this.name = "CapabilityProfileNotFoundError";
		this.profile = profile;
	}
}

export class CapabilityNameConflictError extends CapabilityError {
	readonly conflictingNames: ReadonlyArray<string>;

	constructor(conflictingNames: ReadonlyArray<string>) {
		super(
			"capability_name_conflict",
			`Multiple selected capabilities expose the same tool name: ${[...new Set(conflictingNames)].join(", ")}`,
		);
		this.name = "CapabilityNameConflictError";
		this.conflictingNames = [...new Set(conflictingNames)];
	}
}

const FNV_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const FNV_MASK = 0xffffffffffffffffn;

function fnv1a64(input: string): string {
	let hash = FNV_OFFSET_BASIS;
	for (let i = 0; i < input.length; i++) {
		hash ^= BigInt(input.charCodeAt(i));
		hash = (hash * FNV_PRIME) & FNV_MASK;
	}
	return hash.toString(16).padStart(16, "0");
}

/** Secret values are omitted so secret rotation never changes a capability revision. */
const SECRET_KEY_PATTERN = /secret|token|passwd|password|authorization|api[_-]?key|access[_-]?key|cookie|credential/i;
const SECRET_CONTAINER_KEYS = new Set(["env", "environment", "headers"]);

function redactUrlSecrets(text: string): string {
	return text.replace(/([a-z][a-z0-9+.-]*:\/\/)(?:[^/@\s]+@)?([^\s?#]*(?:\/[^\s?#]*)?)(?:[?#][^\s]*)?/gi, "$1$2");
}

function sanitizeSecrets(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map((item) => sanitizeSecrets(item));
	}
	if (value !== null && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
			if (SECRET_KEY_PATTERN.test(key)) {
				continue;
			}
			if (SECRET_CONTAINER_KEYS.has(key) && item !== null && typeof item === "object" && !Array.isArray(item)) {
				// env/headers records hold name -> value; keep the names, redact the values
				const record: Record<string, unknown> = {};
				for (const name of Object.keys(item as Record<string, unknown>)) {
					record[name] = "[redacted]";
				}
				out[key] = record;
				continue;
			}
			out[key] = sanitizeSecrets(item);
		}
		return out;
	}
	return typeof value === "string" ? redactUrlSecrets(value) : value;
}

function stableStringify(value: unknown): string {
	if (value === null) return "null";
	const type = typeof value;
	if (type === "string") return JSON.stringify(value);
	if (type === "number" || type === "boolean") return String(value);
	if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
	if (type === "object") {
		const keys = Object.keys(value as Record<string, unknown>).sort();
		return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`).join(",")}}`;
	}
	return "undefined";
}

export function createCapabilityRevision(input: unknown): string {
	return `rev:${fnv1a64(stableStringify(sanitizeSecrets(input)))}`;
}

export function createCapabilityId(kind: CapabilityKind, sourceIdentity: string, localName: string): string {
	return `${kind}:${sourceIdentity}:${localName}`;
}

function defaultDecisionFor(kind: CapabilityKind): CapabilityDecision {
	return kind === "mcp_server" || kind === "mcp_tool" ? "deny" : "allow";
}

function defaultTrustFor(source: SourceInfo): boolean {
	return source.scope !== "project";
}

const DECISION_RANK: Record<CapabilityDecision, number> = { allow: 0, ask: 1, deny: 2 };

function stricterDecision(a: CapabilityDecision, b: CapabilityDecision): CapabilityDecision {
	return DECISION_RANK[a] >= DECISION_RANK[b] ? a : b;
}

function defaultExposedToolName(
	kind: CapabilityKind,
	localName: string,
	mcpServerId: string | undefined,
): string | undefined {
	switch (kind) {
		case "mcp_tool":
			return mcpServerId !== undefined ? `mcp__${mcpServerId}__${localName}` : localName;
		case "builtin_tool":
		case "extension_tool":
		case "sdk_tool":
			return localName;
		default:
			return undefined;
	}
}

function selectorMatches(selector: CapabilitySelector, descriptor: CapabilityDescriptor): boolean {
	if (selector.id !== undefined && selector.id !== descriptor.id) return false;
	if (selector.kind !== undefined && selector.kind !== descriptor.kind) return false;
	if (selector.sourceId !== undefined && selector.sourceId !== descriptor.source.source) return false;
	if (selector.scope !== undefined && selector.scope !== descriptor.source.scope) return false;
	if (selector.parentId !== undefined && selector.parentId !== descriptor.parentId) return false;
	if (selector.mcpServerId !== undefined && selector.mcpServerId !== descriptor.mcpServerId) return false;
	return true;
}

function applyProfileRules(
	descriptor: CapabilityDescriptor,
	profile: CapabilityProfile,
): CapabilityDecision | undefined {
	let matched: CapabilityDecision | undefined;
	for (const rule of profile.rules) {
		if (selectorMatches(rule.selector, descriptor)) {
			matched = rule.action;
		}
	}
	return matched;
}

function resolveDecision(
	descriptor: CapabilityDescriptor,
	profile: CapabilityProfile | undefined,
	parentDecision?: CapabilityDecision,
): CapabilityDecision {
	let decision = profile ? applyProfileRules(descriptor, profile) : undefined;
	if (decision === undefined) decision = defaultDecisionFor(descriptor.kind);
	if (!descriptor.trusted) decision = stricterDecision(decision, "deny");
	if (descriptor.kind === "mcp_tool" && parentDecision !== undefined) {
		// A tool cannot be enabled independently of its parent server
		decision = stricterDecision(decision, parentDecision);
	}
	return decision;
}

function resolveDecisions(
	descriptors: ReadonlyArray<CapabilityDescriptor>,
	profile: CapabilityProfile | undefined,
): Map<string, CapabilityDecision> {
	const byId = new Map(descriptors.map((descriptor) => [descriptor.id, descriptor]));
	const decisions = new Map<string, CapabilityDecision>();
	for (const descriptor of descriptors) {
		if (descriptor.kind !== "mcp_tool") {
			decisions.set(descriptor.id, resolveDecision(descriptor, profile));
		}
	}
	for (const descriptor of descriptors) {
		if (descriptor.kind === "mcp_tool") {
			const parent = descriptor.parentId !== undefined ? byId.get(descriptor.parentId) : undefined;
			const parentDecision = parent !== undefined ? (decisions.get(parent.id) ?? "deny") : "deny";
			decisions.set(descriptor.id, resolveDecision(descriptor, profile, parentDecision));
		}
	}
	return decisions;
}

export function buildCapabilityCatalog(input: CapabilityCatalogInput): CapabilityCatalog {
	const byId = new Map<string, CapabilityDescriptor>();
	for (const candidate of input.candidates) {
		const localName = candidate.localName ?? candidate.name;
		const id = createCapabilityId(candidate.kind, candidate.sourceIdentity, localName);
		const descriptor: CapabilityDescriptor = {
			id,
			revision: createCapabilityRevision(
				candidate.revisionInput ?? {
					kind: candidate.kind,
					source: candidate.source,
					name: localName,
				},
			),
			kind: candidate.kind,
			name: candidate.name,
			source: candidate.source,
			availability: candidate.availability ?? "available",
			decision: "allow",
			trusted: candidate.trusted ?? defaultTrustFor(candidate.source),
			...(candidate.exposedToolName !== undefined ? { exposedToolName: candidate.exposedToolName } : {}),
			...(candidate.parentId !== undefined ? { parentId: candidate.parentId } : {}),
			...(candidate.mcpServerId !== undefined ? { mcpServerId: candidate.mcpServerId } : {}),
		};
		if (descriptor.exposedToolName === undefined) {
			descriptor.exposedToolName = defaultExposedToolName(candidate.kind, localName, candidate.mcpServerId);
		}
		// Same kind + source identity + local name is the same capability; a later
		// discovery replaces the earlier revision.
		byId.set(id, descriptor);
	}
	const descriptors = [...byId.values()];
	const decisions = resolveDecisions(descriptors, undefined);
	return {
		version: 1,
		descriptors: descriptors.map((descriptor) => ({
			...descriptor,
			decision: decisions.get(descriptor.id) ?? "deny",
		})),
	};
}

function createBindingId(profile: string, refs: ReadonlyArray<CapabilityBindingDescriptorRef>): string {
	const parts = refs.map((ref) => `${ref.id}@${ref.revision}`).sort();
	return `binding:${profile}:${fnv1a64(parts.join("|"))}`;
}

export function resolveCapabilityBinding(input: ResolveBindingInput): CapabilityBinding {
	const profileDef = input.profiles?.[input.profile];
	if (profileDef === undefined) {
		throw new CapabilityProfileNotFoundError(input.profile);
	}

	const decisions = resolveDecisions(input.catalog.descriptors, profileDef);
	const approved = new Set(input.approvedDescriptorIds ?? []);

	// A descriptor is selectable only when allowed (or ask-approved) and available.
	const selectable = new Set<string>();
	for (const descriptor of input.catalog.descriptors) {
		const decision = decisions.get(descriptor.id) ?? "deny";
		if (decision === "deny") {
			continue;
		}
		if (decision === "ask" && !approved.has(descriptor.id)) {
			continue;
		}
		if (descriptor.availability !== "available") {
			continue;
		}
		selectable.add(descriptor.id);
	}

	const byId = new Map(input.catalog.descriptors.map((descriptor) => [descriptor.id, descriptor]));
	const refs: CapabilityBindingDescriptorRef[] = [];
	let awaitingApproval = 0;
	let denied = 0;
	for (const descriptor of input.catalog.descriptors) {
		const decision = decisions.get(descriptor.id) ?? "deny";
		if (decision === "deny") {
			denied++;
			continue;
		}
		if (decision === "ask") {
			if (!approved.has(descriptor.id)) {
				awaitingApproval++;
				continue;
			}
		}
		if (descriptor.availability !== "available") {
			continue;
		}
		if (descriptor.kind === "mcp_tool") {
			const parent = descriptor.parentId !== undefined ? byId.get(descriptor.parentId) : undefined;
			if (parent === undefined || !selectable.has(parent.id)) {
				// A tool never enters the binding without its parent server selected
				if (parent !== undefined && decisions.get(parent.id) === "ask" && !approved.has(parent.id)) {
					awaitingApproval++;
				} else {
					denied++;
				}
				continue;
			}
		}
		refs.push({
			id: descriptor.id,
			revision: descriptor.revision,
			...(descriptor.exposedToolName !== undefined ? { exposedToolName: descriptor.exposedToolName } : {}),
		});
	}

	const nameCounts = new Map<string, number>();
	for (const ref of refs) {
		if (ref.exposedToolName !== undefined) {
			nameCounts.set(ref.exposedToolName, (nameCounts.get(ref.exposedToolName) ?? 0) + 1);
		}
	}
	const conflicts: string[] = [];
	for (const [name, count] of nameCounts) {
		if (count > 1) {
			conflicts.push(name);
		}
	}
	if (conflicts.length > 0) {
		throw new CapabilityNameConflictError(conflicts);
	}

	let toolAllowlist = refs.map((ref) => ref.exposedToolName).filter((name): name is string => name !== undefined);
	if (input.noTools) {
		toolAllowlist = [];
	} else {
		if (input.toolAllowlist !== undefined) {
			const allowed = new Set(input.toolAllowlist);
			toolAllowlist = toolAllowlist.filter((name) => allowed.has(name));
		}
		if (input.excludeToolNames !== undefined) {
			const excluded = new Set(input.excludeToolNames);
			toolAllowlist = toolAllowlist.filter((name) => !excluded.has(name));
		}
	}

	return {
		id: createBindingId(input.profile, refs),
		profile: input.profile,
		createdAt: input.now ?? new Date().toISOString(),
		descriptors: refs,
		decisionSummary: {
			allowed: refs.length,
			awaitingApproval,
			denied,
		},
		toolAllowlist,
	};
}

function redactSource(source: SourceInfo): CapabilitySourceView {
	return {
		source: redactUrlSecrets(source.source),
		scope: source.scope,
		origin: source.origin,
		...(source.path !== undefined ? { path: redactUrlSecrets(source.path) } : {}),
		...(source.baseDir !== undefined ? { baseDir: redactUrlSecrets(source.baseDir) } : {}),
	};
}

export function createCapabilityCatalogView(catalog: CapabilityCatalog): CapabilityCatalogView {
	return {
		version: 1,
		descriptors: catalog.descriptors.map((descriptor) => ({
			id: descriptor.id,
			revision: descriptor.revision,
			kind: descriptor.kind,
			name: descriptor.name,
			source: redactSource(descriptor.source),
			availability: descriptor.availability,
			decision: descriptor.decision,
			trusted: descriptor.trusted,
			...(descriptor.exposedToolName !== undefined ? { exposedToolName: descriptor.exposedToolName } : {}),
			...(descriptor.parentId !== undefined ? { parentId: descriptor.parentId } : {}),
			...(descriptor.mcpServerId !== undefined ? { mcpServerId: descriptor.mcpServerId } : {}),
		})),
	};
}

export function createCapabilityBindingView(binding: CapabilityBinding): CapabilityBindingView {
	return {
		id: binding.id,
		profile: binding.profile,
		createdAt: binding.createdAt,
		descriptors: binding.descriptors,
		decisionSummary: binding.decisionSummary,
		toolAllowlist: binding.toolAllowlist,
	};
}

export class CapabilityRegistry {
	private catalog: CapabilityCatalog | undefined;
	private readonly bindings = new Map<string, CapabilityBinding>();

	buildCatalog(input: CapabilityCatalogInput): CapabilityCatalog {
		this.catalog = buildCapabilityCatalog(input);
		return this.catalog;
	}

	resolveBinding(input: ResolveBindingInput): CapabilityBinding {
		const binding = resolveCapabilityBinding(input);
		this.bindings.set(binding.id, binding);
		return binding;
	}

	inspectCatalog(): CapabilityCatalogView | undefined {
		return this.catalog !== undefined ? createCapabilityCatalogView(this.catalog) : undefined;
	}

	inspectBinding(id: string): CapabilityBindingView | undefined {
		const binding = this.bindings.get(id);
		return binding !== undefined ? createCapabilityBindingView(binding) : undefined;
	}
}
