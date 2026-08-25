/**
 * Profile and extension policy helpers that build on the frozen Foundation
 * v1 profile contracts.
 *
 * A selector is a capability boundary. A child scope may remove resources
 * from its parent scope, but it may never add them back. The helpers in this
 * file are intentionally provider-neutral and do not connect to MCP servers.
 */
import { Result, type Result as ResultValue } from "./result.ts";
import type { ChildSpawnRequest, TaskExecutorProvider } from "./foundation/providers.ts";
import { FoundationError } from "./foundation/errors.ts";
import {
	ResourceSelectorSchema,
	selectorsNarrow,
	type ResourceSelector,
} from "./foundation/reference.ts";
import { validateExactShape } from "./foundation/schema.ts";
import type { Fingerprint } from "./foundation/identity.ts";
import type { FoundationJsonValue } from "./foundation/event-catalog.ts";
import type { ProfileContract } from "./foundation/profile.ts";

export type SelectorPolicy = ResourceSelector["policy"];

export const SELECTOR_POLICIES: readonly SelectorPolicy[] = ["all", "none", "named", "except"];

/** Metadata carried by a skill extension without changing the base Skill shape. */
export interface SkillMetadata {
	/** Optional schema marker for persisted skill metadata. */
	schemaVersion?: 1;
	skillId?: string;
	version?: string;
	capabilityRefs?: readonly string[];
	mcpSelector?: ResourceSelector;
	tags?: readonly string[];
	source?: string;
	digest?: Fingerprint;
	parameters?: FoundationJsonValue;
	model?: string;
	effort?: string;
	fork?: FoundationJsonValue;
	toolPolicy?: FoundationJsonValue;
	externalProjection?: FoundationJsonValue;
}

export interface ProfilePatch {
	schemaVersion: 1;
	patchId: string;
	targetProfileId: string;
	baseRevision?: number;
	revision: number;
	source: string;
	values?: Readonly<Record<string, string | number | boolean>>;
	unset?: readonly string[];
}

export interface ProfileBundle {
	schemaVersion: 1;
	bundleId: string;
	revision: number;
	source: string;
	profiles: readonly ProfileContract[];
	patches?: readonly ProfilePatch[];
}

export interface ProfileSourceRecord {
	profileId: string;
	field: string;
	source: string;
	patchId?: string;
	revision: number;
}

export interface ProfileCompositionConflict {
	profileId: string;
	field: string;
	firstSource: string;
	secondSource: string;
	reason: "managed_lock" | "revision_mismatch" | "duplicate_patch";
}

export interface ProfileCompositionResult {
	profiles: readonly ProfileContract[];
	sources: readonly ProfileSourceRecord[];
	conflicts: readonly ProfileCompositionConflict[];
}

export function applyProfilePatch(profile: ProfileContract, patch: ProfilePatch): ResultValue<ProfileContract, FoundationError> {
	if (patch.targetProfileId !== profile.profileId) return Result.err(new FoundationError("profile_conflict", "profile patch targets a different profile"));
	if (patch.baseRevision !== undefined && patch.baseRevision !== profile.revision) return Result.err(new FoundationError("profile_conflict", "profile patch base revision is stale"));
	const managedKeysResult = authoritativeManagedKeys(profile);
	if (!managedKeysResult.ok) return managedKeysResult;
	if (Object.hasOwn(patch as unknown as Record<string, unknown>, "managedKeys")) {
		return Result.err(new FoundationError("profile_conflict", "profile patch cannot supply managed keys", { details: { profileId: profile.profileId } }));
	}
	const managedKeys = managedKeysResult.value;
	const managedUnset = (patch.unset ?? []).find((key) => managedKeys.has(key));
	if (managedUnset !== undefined) return Result.err(new FoundationError("profile_conflict", "profile patch cannot unset a managed value", { details: { profileId: profile.profileId, field: managedUnset } }));
	const values: Record<string, string | number | boolean> = { ...profile.values };
	for (const key of patch.unset ?? []) delete values[key];
	for (const [key, value] of Object.entries(patch.values ?? {})) {
		if (managedKeys.has(key)) return Result.err(new FoundationError("profile_conflict", "profile patch cannot override a managed value", { details: { profileId: profile.profileId, field: key } }));
		values[key] = value;
	}
	return Result.ok({ ...profile, managedKeys: Object.freeze([...managedKeys]), revision: Math.max(profile.revision, patch.revision), values });
}

function authoritativeManagedKeys(profile: ProfileContract): ResultValue<ReadonlySet<string>, FoundationError> {
	if (!Array.isArray(profile.managedKeys) || profile.managedKeys.length === 0 || profile.managedKeys.some((key) => typeof key !== "string" || key.length === 0) || new Set(profile.managedKeys).size !== profile.managedKeys.length) {
		return Result.err(new FoundationError("profile_conflict", "profile managed lock set is invalid", { details: { profileId: profile.profileId } }));
	}
	return Result.ok(new Set(profile.managedKeys));
}

export function composeProfileBundle(bundle: ProfileBundle): ResultValue<ProfileCompositionResult, FoundationError> {
	const current = new Map(bundle.profiles.map((profile) => [profile.profileId, profile]));
	const sources: ProfileSourceRecord[] = [];
	const conflicts: ProfileCompositionConflict[] = [];
	const patchIds = new Set<string>();
	for (const profile of bundle.profiles) {
		for (const field of Object.keys(profile.values)) sources.push({ profileId: profile.profileId, field, source: bundle.source, revision: profile.revision });
	}
	for (const patch of [...(bundle.patches ?? [])].sort((left, right) => left.revision - right.revision || left.patchId.localeCompare(right.patchId))) {
		if (patchIds.has(patch.patchId)) {
			conflicts.push({ profileId: patch.targetProfileId, field: "*", firstSource: bundle.source, secondSource: patch.source, reason: "duplicate_patch" });
			continue;
		}
		patchIds.add(patch.patchId);
		const profile = current.get(patch.targetProfileId);
		if (profile === undefined) return Result.err(new FoundationError("model_profile_not_found", "profile patch target is not in the bundle", { details: { profileId: patch.targetProfileId } }));
		const applied = applyProfilePatch(profile, patch);
		if (!applied.ok) {
			conflicts.push({ profileId: patch.targetProfileId, field: Object.keys(patch.values ?? {})[0] ?? patch.unset?.[0] ?? "*", firstSource: bundle.source, secondSource: patch.source, reason: applied.error.message.includes("managed") ? "managed_lock" : "revision_mismatch" });
			continue;
		}
		current.set(profile.profileId, applied.value);
		for (const field of Object.keys(patch.values ?? {})) sources.push({ profileId: profile.profileId, field, source: patch.source, patchId: patch.patchId, revision: patch.revision });
		for (const field of patch.unset ?? []) sources.push({ profileId: profile.profileId, field, source: patch.source, patchId: patch.patchId, revision: patch.revision });
	}
	return Result.ok({ profiles: [...current.values()].sort((left, right) => left.profileId.localeCompare(right.profileId)), sources, conflicts });
}

/** Child and executor selector additions are extension records, not provider implementations. */
export interface ChildMcpSelector {
	mcpSelector: ResourceSelector;
}

export interface ExecutorMcpSelector {
	mcpSelector: ResourceSelector;
}

export type ChildSpawnWithMcpSelector = ChildSpawnRequest & ChildMcpSelector;
export type TaskExecutorWithMcpSelector = TaskExecutorProvider & ExecutorMcpSelector;

export interface ChildExecutorMcpSelectorInput {
	parentSelector: ResourceSelector;
	childSelector?: ResourceSelector;
	executorSelector?: ResourceSelector;
}

export interface ChildExecutorMcpSelectorResult {
	parentSelector: ResourceSelector;
	childSelector: ResourceSelector;
	executorSelector: ResourceSelector;
}

/** Validate the frozen selector shape at an extension boundary. */
export function validateSelector(value: unknown): ResultValue<ResourceSelector, FoundationError> {
	return validateExactShape<ResourceSelector>(ResourceSelectorSchema, value, "resource_selector");
}

/** Normalize selector names so fingerprints and reports remain deterministic. */
export function normalizeSelector(selector: ResourceSelector): ResourceSelector {
	if (selector.policy === "all" || selector.policy === "none") return { policy: selector.policy };
	return { policy: selector.policy, named: [...new Set(selector.named ?? [])].sort() };
}

/** True when the child selection is a subset of the parent selection. */
export function selectorTightens(parent: ResourceSelector, child: ResourceSelector): boolean {
	return selectorsNarrow(parent, child);
}

/** Return a failed result when a child attempts to widen its parent's scope. */
export function validateMcpSelectorTightening(
	parent: ResourceSelector,
	child: ResourceSelector,
): ResultValue<ResourceSelector, FoundationError> {
	const parentResult = validateSelector(parent);
	if (!parentResult.ok) return parentResult;
	const childResult = validateSelector(child);
	if (!childResult.ok) return childResult;
	const normalizedParent = normalizeSelector(parentResult.value);
	const normalizedChild = normalizeSelector(childResult.value);
	if (!selectorsNarrow(normalizedParent, normalizedChild)) {
		return Result.err(
			new FoundationError("role_resolver_scope_widened", "MCP selector widens its parent scope", {
				details: { parent: selectorDetails(normalizedParent), child: selectorDetails(normalizedChild) },
			}),
		);
	}
	return Result.ok(normalizedChild);
}

/**
 * Resolve child and executor selectors in order. An omitted selector inherits
 * the preceding scope; an explicit selector may only tighten that scope.
 */
export function resolveChildExecutorMcpSelectors(
	input: ChildExecutorMcpSelectorInput,
): ResultValue<ChildExecutorMcpSelectorResult, FoundationError>;
export function resolveChildExecutorMcpSelectors(
	parentSelector: ResourceSelector,
	childSelector?: ResourceSelector,
	executorSelector?: ResourceSelector,
): ResultValue<ChildExecutorMcpSelectorResult, FoundationError>;
export function resolveChildExecutorMcpSelectors(
	inputOrParent: ChildExecutorMcpSelectorInput | ResourceSelector,
	childSelector?: ResourceSelector,
	executorSelector?: ResourceSelector,
): ResultValue<ChildExecutorMcpSelectorResult, FoundationError> {
	const input: ChildExecutorMcpSelectorInput = "parentSelector" in inputOrParent
		? inputOrParent
		: { parentSelector: inputOrParent, childSelector, executorSelector };
	const parentResult = validateSelector(input.parentSelector);
	if (!parentResult.ok) return parentResult;
	const parent = normalizeSelector(parentResult.value);
	const child = input.childSelector === undefined ? parent : input.childSelector;
	const childResult = validateMcpSelectorTightening(parent, child);
	if (!childResult.ok) return childResult;
	const executor = input.executorSelector === undefined ? childResult.value : input.executorSelector;
	const executorResult = validateMcpSelectorTightening(childResult.value, executor);
	if (!executorResult.ok) return executorResult;
	return Result.ok({ parentSelector: parent, childSelector: childResult.value, executorSelector: executorResult.value });
}

function selectorDetails(selector: ResourceSelector): { policy: SelectorPolicy; named?: string[] } {
	return selector.policy === "all" || selector.policy === "none"
		? { policy: selector.policy }
		: { policy: selector.policy, named: [...(selector.named ?? [])] };
}

/** Select named resources for tests and provider adapters without opening a connection. */
export function selectResources(selector: ResourceSelector, available: readonly string[]): readonly string[] {
	const normalized = normalizeSelector(selector);
	const names = new Set(normalized.policy === "named" || normalized.policy === "except" ? (normalized.named ?? []) : []);
	return available.filter((name) => {
		if (normalized.policy === "all") return true;
		if (normalized.policy === "none") return false;
		return normalized.policy === "named" ? names.has(name) : !names.has(name);
	});
}
