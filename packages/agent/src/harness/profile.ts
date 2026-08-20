/**
 * Profile and extension policy helpers that build on the frozen Foundation
 * v1 profile contracts.
 *
 * A selector is a capability boundary. A child scope may remove resources
 * from its parent scope, but it may never add them back. The helpers in this
 * file are intentionally provider-neutral and do not connect to MCP servers.
 */
import { Result, type Result as ResultValue } from "./result.ts";
import type { ChildSpawnRequestV1, TaskExecutorProvider } from "./foundation/providers.ts";
import { FoundationError } from "./foundation/errors.ts";
import {
	ResourceSelectorV1Schema,
	selectorsNarrow,
	type ResourceSelectorV1,
} from "./foundation/reference.ts";
import { validateExactShape } from "./foundation/schema.ts";
import type { FingerprintV1 } from "./foundation/identity.ts";
import type { FoundationJsonValue } from "./foundation/event-catalog.ts";
import type { ProfileContractV1 } from "./foundation/profile.ts";

export type SelectorPolicyV1 = ResourceSelectorV1["policy"];
export type McpSelectorV1 = ResourceSelectorV1;
export type SkillMcpSelectorV1 = ResourceSelectorV1;

export const SELECTOR_POLICIES_V1: readonly SelectorPolicyV1[] = ["all", "none", "named", "except"];

/** Metadata carried by a skill extension without changing the base Skill shape. */
export interface SkillMetadataV1 {
	/** Optional schema marker for persisted skill metadata. */
	schemaVersion?: 1;
	skillId?: string;
	version?: string;
	capabilityRefs?: readonly string[];
	mcpSelector?: ResourceSelectorV1;
	tags?: readonly string[];
	source?: string;
	digest?: FingerprintV1;
	parameters?: FoundationJsonValue;
	model?: string;
	effort?: string;
	fork?: FoundationJsonValue;
	toolPolicy?: FoundationJsonValue;
	externalProjection?: FoundationJsonValue;
}

export type SkillExtensionMetadataV1 = SkillMetadataV1;

export interface ProfilePatchV1 {
	schemaVersion: 1;
	patchId: string;
	targetProfileId: string;
	baseRevision?: number;
	revision: number;
	source: string;
	values?: Readonly<Record<string, string | number | boolean>>;
	unset?: readonly string[];
}

export interface ProfileBundleV1 {
	schemaVersion: 1;
	bundleId: string;
	revision: number;
	source: string;
	profiles: readonly ProfileContractV1[];
	patches?: readonly ProfilePatchV1[];
}

export interface ProfileSourceRecordV1 {
	profileId: string;
	field: string;
	source: string;
	patchId?: string;
	revision: number;
}

export interface ProfileCompositionConflictV1 {
	profileId: string;
	field: string;
	firstSource: string;
	secondSource: string;
	reason: "managed_lock" | "revision_mismatch" | "duplicate_patch";
}

export interface ProfileCompositionResultV1 {
	profiles: readonly ProfileContractV1[];
	sources: readonly ProfileSourceRecordV1[];
	conflicts: readonly ProfileCompositionConflictV1[];
}

export type ProfileBundle = ProfileBundleV1;
export type ProfilePatch = ProfilePatchV1;
export type ProfileSourceRecord = ProfileSourceRecordV1;

export function applyProfilePatchV1(profile: ProfileContractV1, patch: ProfilePatchV1): ResultValue<ProfileContractV1, FoundationError> {
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

function authoritativeManagedKeys(profile: ProfileContractV1): ResultValue<ReadonlySet<string>, FoundationError> {
	if (!Array.isArray(profile.managedKeys) || profile.managedKeys.length === 0 || profile.managedKeys.some((key) => typeof key !== "string" || key.length === 0) || new Set(profile.managedKeys).size !== profile.managedKeys.length) {
		return Result.err(new FoundationError("profile_conflict", "profile managed lock set is invalid", { details: { profileId: profile.profileId } }));
	}
	return Result.ok(new Set(profile.managedKeys));
}

export function composeProfileBundleV1(bundle: ProfileBundleV1): ResultValue<ProfileCompositionResultV1, FoundationError> {
	const current = new Map(bundle.profiles.map((profile) => [profile.profileId, profile]));
	const sources: ProfileSourceRecordV1[] = [];
	const conflicts: ProfileCompositionConflictV1[] = [];
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
		const applied = applyProfilePatchV1(profile, patch);
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

export const composeProfilesV1 = composeProfileBundleV1;
export const resolveProfileBundleV1 = composeProfileBundleV1;
export const applyProfilePatch = applyProfilePatchV1;

/** Child and executor selector additions are extension records, not provider implementations. */
export interface ChildMcpSelectorV1 {
	mcpSelector: ResourceSelectorV1;
}

export interface ExecutorMcpSelectorV1 {
	mcpSelector: ResourceSelectorV1;
}

export type ChildSpawnWithMcpSelectorV1 = ChildSpawnRequestV1 & ChildMcpSelectorV1;
export type TaskExecutorWithMcpSelectorV1 = TaskExecutorProvider & ExecutorMcpSelectorV1;

export interface ChildExecutorMcpSelectorInputV1 {
	parentSelector: ResourceSelectorV1;
	childSelector?: ResourceSelectorV1;
	executorSelector?: ResourceSelectorV1;
}

export interface ChildExecutorMcpSelectorResultV1 {
	parentSelector: ResourceSelectorV1;
	childSelector: ResourceSelectorV1;
	executorSelector: ResourceSelectorV1;
}

/** Validate the frozen selector shape at an extension boundary. */
export function validateSelectorV1(value: unknown): ResultValue<ResourceSelectorV1, FoundationError> {
	return validateExactShape<ResourceSelectorV1>(ResourceSelectorV1Schema, value, "resource_selector");
}

export const validateMcpSelectorV1 = validateSelectorV1;

/** Normalize selector names so fingerprints and reports remain deterministic. */
export function normalizeSelectorV1(selector: ResourceSelectorV1): ResourceSelectorV1 {
	if (selector.policy === "all" || selector.policy === "none") return { policy: selector.policy };
	return { policy: selector.policy, named: [...new Set(selector.named ?? [])].sort() };
}

export const normalizeMcpSelectorV1 = normalizeSelectorV1;

/** True when the child selection is a subset of the parent selection. */
export function selectorTightensV1(parent: ResourceSelectorV1, child: ResourceSelectorV1): boolean {
	return selectorsNarrow(parent, child);
}

export const selectorsTightenV1 = selectorTightensV1;
export const validateSelectorTighteningV1 = selectorTightensV1;

/** Return a failed result when a child attempts to widen its parent's scope. */
export function validateMcpSelectorTighteningV1(
	parent: ResourceSelectorV1,
	child: ResourceSelectorV1,
): ResultValue<ResourceSelectorV1, FoundationError> {
	const parentResult = validateSelectorV1(parent);
	if (!parentResult.ok) return parentResult;
	const childResult = validateSelectorV1(child);
	if (!childResult.ok) return childResult;
	const normalizedParent = normalizeSelectorV1(parentResult.value);
	const normalizedChild = normalizeSelectorV1(childResult.value);
	if (!selectorsNarrow(normalizedParent, normalizedChild)) {
		return Result.err(
			new FoundationError("role_resolver_scope_widened", "MCP selector widens its parent scope", {
				details: { parent: selectorDetails(normalizedParent), child: selectorDetails(normalizedChild) },
			}),
		);
	}
	return Result.ok(normalizedChild);
}

export const validateChildMcpSelectorV1 = validateMcpSelectorTighteningV1;
export const validateExecutorMcpSelectorV1 = validateMcpSelectorTighteningV1;

/**
 * Resolve child and executor selectors in order. An omitted selector inherits
 * the preceding scope; an explicit selector may only tighten that scope.
 */
export function resolveChildExecutorMcpSelectorsV1(
	input: ChildExecutorMcpSelectorInputV1,
): ResultValue<ChildExecutorMcpSelectorResultV1, FoundationError>;
export function resolveChildExecutorMcpSelectorsV1(
	parentSelector: ResourceSelectorV1,
	childSelector?: ResourceSelectorV1,
	executorSelector?: ResourceSelectorV1,
): ResultValue<ChildExecutorMcpSelectorResultV1, FoundationError>;
export function resolveChildExecutorMcpSelectorsV1(
	inputOrParent: ChildExecutorMcpSelectorInputV1 | ResourceSelectorV1,
	childSelector?: ResourceSelectorV1,
	executorSelector?: ResourceSelectorV1,
): ResultValue<ChildExecutorMcpSelectorResultV1, FoundationError> {
	const input: ChildExecutorMcpSelectorInputV1 = "parentSelector" in inputOrParent
		? inputOrParent
		: { parentSelector: inputOrParent, childSelector, executorSelector };
	const parentResult = validateSelectorV1(input.parentSelector);
	if (!parentResult.ok) return parentResult;
	const parent = normalizeSelectorV1(parentResult.value);
	const child = input.childSelector === undefined ? parent : input.childSelector;
	const childResult = validateMcpSelectorTighteningV1(parent, child);
	if (!childResult.ok) return childResult;
	const executor = input.executorSelector === undefined ? childResult.value : input.executorSelector;
	const executorResult = validateMcpSelectorTighteningV1(childResult.value, executor);
	if (!executorResult.ok) return executorResult;
	return Result.ok({ parentSelector: parent, childSelector: childResult.value, executorSelector: executorResult.value });
}

export const resolveChildMcpSelectorV1 = resolveChildExecutorMcpSelectorsV1;
export const resolveExecutorMcpSelectorV1 = resolveChildExecutorMcpSelectorsV1;

function selectorDetails(selector: ResourceSelectorV1): { policy: SelectorPolicyV1; named?: string[] } {
	return selector.policy === "all" || selector.policy === "none"
		? { policy: selector.policy }
		: { policy: selector.policy, named: [...(selector.named ?? [])] };
}

/** Select named resources for tests and provider adapters without opening a connection. */
export function selectResourcesV1(selector: ResourceSelectorV1, available: readonly string[]): readonly string[] {
	const normalized = normalizeSelectorV1(selector);
	const names = new Set(normalized.policy === "named" || normalized.policy === "except" ? (normalized.named ?? []) : []);
	return available.filter((name) => {
		if (normalized.policy === "all") return true;
		if (normalized.policy === "none") return false;
		return normalized.policy === "named" ? names.has(name) : !names.has(name);
	});
}

export const selectMcpServersV1 = selectResourcesV1;
