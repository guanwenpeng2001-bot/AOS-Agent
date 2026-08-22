/**
 * Child Binding projection: seven-resource tighten-only inheritance.
 *
 * This module does not spawn, resolve a new Binding, or mutate Foundation
 * contracts. The projection is the durable proof T4 persists before spawn.
 */

import { Type } from "typebox";
import {
	cloneDeepFrozen,
	canonicalFoundationJson,
	fingerprintFoundationValue,
	FingerprintV1Schema,
	FoundationError,
	ModelRouteV1Schema,
	ResourceSelectorV1Schema,
	Result,
	RevisionReferenceV1Schema,
	selectorsNarrow,
	validateBudgetV1,
	validateExactShape,
	validateImmutableAgentBindingV1,
	validateRoleRevisionV1,
	validateSecretFreeModelProfileV1,
	validateTaskEnvelope,
	type AgentBindingV1,
	type BudgetV1,
	type FingerprintV1,
	type ModelProfileV1,
	type ModelRouteV1,
	type ResourceSelectorV1,
	type Result as ResultValue,
	type RevisionReferenceV1,
	type RoleRevisionV1,
	type SessionLedgerV1,
	type TaskEnvelopeV1,
	type VersionedReferenceV1,
} from "@aos-agent/agent-core";

export const CHILD_BINDING_PROJECTION_SCHEMA_VERSION = 1 as const;
export const CHILD_BINDING_PROJECTION_OBJECT_TYPE = "subagent.child_binding_projection";

export const CHILD_BINDING_PROJECTION_FIELDS = [
	"instructions",
	"skills",
	"mcp",
	"model",
	"sandbox",
	"git",
	"budget",
] as const;
export type ChildBindingProjectionFieldV1 = (typeof CHILD_BINDING_PROJECTION_FIELDS)[number];
export type ChildBindingTighteningProofV1 = "equal" | "narrowed";

export interface ChildBindingProjectionFieldRecordV1 {
	readonly field: ChildBindingProjectionFieldV1;
	readonly parentDigest: FingerprintV1;
	readonly childDigest: FingerprintV1;
	readonly tighteningProof: ChildBindingTighteningProofV1;
}

export interface ChildBindingProjectionV1 {
	readonly schemaVersion: 1;
	readonly parentBindingId: string;
	readonly childBindingId: string;
	readonly spawnId: string;
	readonly fields: readonly ChildBindingProjectionFieldRecordV1[];
	readonly digest: FingerprintV1;
	readonly createdAt: string;
}

export interface ChildBindingHostPreflightV1 {
	readonly policyTighter?: boolean;
	readonly capabilityTighter?: boolean;
	readonly instructionsTighter?: boolean;
}

export interface ProjectChildBindingInputV1 {
	readonly schemaVersion: 1;
	readonly spawnId: string;
	readonly parentBinding: AgentBindingV1;
	readonly childBindingId: string;
	readonly parentRoleRevision: RoleRevisionV1;
	readonly childRoleRevision: RoleRevisionV1;
	readonly parentModelProfile: ModelProfileV1;
	readonly childModelProfile: ModelProfileV1;
	readonly childTaskEnvelope: TaskEnvelopeV1;
	readonly createdAt: string;
	readonly childModelRoute?: ModelRouteV1;
	readonly childBudget?: BudgetV1;
	readonly parentGitSelector?: ResourceSelectorV1;
	readonly childGitSelector?: ResourceSelectorV1;
	readonly childPolicyRevision?: RevisionReferenceV1;
	readonly childCapabilityRevision?: RevisionReferenceV1;
	readonly managedLocks?: readonly ChildBindingProjectionFieldV1[];
	readonly hostPreflight?: ChildBindingHostPreflightV1;
}

const BUDGET_KEYS = ["tokens", "costUsd", "modelCalls", "toolCalls", "wallClockMs", "concurrency"] as const;
const INPUT_KEYS = new Set([
	"schemaVersion",
	"spawnId",
	"parentBinding",
	"childBindingId",
	"parentRoleRevision",
	"childRoleRevision",
	"parentModelProfile",
	"childModelProfile",
	"childTaskEnvelope",
	"createdAt",
	"childModelRoute",
	"childBudget",
	"parentGitSelector",
	"childGitSelector",
	"childPolicyRevision",
	"childCapabilityRevision",
	"managedLocks",
	"hostPreflight",
]);
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const FIELD_LITERALS = CHILD_BINDING_PROJECTION_FIELDS.map((field) => Type.Literal(field));
const ChildBindingProjectionFieldRecordV1Schema = Type.Object(
	{
		field: Type.Union(FIELD_LITERALS),
		parentDigest: FingerprintV1Schema,
		childDigest: FingerprintV1Schema,
		tighteningProof: Type.Union([Type.Literal("equal"), Type.Literal("narrowed")]),
	},
	{ additionalProperties: false },
);
const ChildBindingProjectionV1Schema = Type.Object(
	{
		schemaVersion: Type.Literal(1),
		parentBindingId: Type.String({ minLength: 1 }),
		childBindingId: Type.String({ minLength: 1 }),
		spawnId: Type.String({ minLength: 1 }),
		fields: Type.Array(ChildBindingProjectionFieldRecordV1Schema),
		digest: FingerprintV1Schema,
		createdAt: Type.String({ minLength: 1 }),
	},
	{ additionalProperties: false },
);
const HostPreflightV1Schema = Type.Object(
	{
		policyTighter: Type.Optional(Type.Boolean()),
		capabilityTighter: Type.Optional(Type.Boolean()),
		instructionsTighter: Type.Optional(Type.Boolean()),
	},
	{ additionalProperties: false },
);

function projectionError(message: string): ResultValue<never, FoundationError> {
	return Result.err(new FoundationError("subagent_binding_projection_invalid", message));
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSafeIdentifier(value: unknown): value is string {
	return typeof value === "string" && IDENTIFIER_PATTERN.test(value);
}

function isCanonicalTimestamp(value: unknown): value is string {
	if (typeof value !== "string" || !TIMESTAMP_PATTERN.test(value)) return false;
	const parsed = new Date(value);
	return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function routeFromProfile(profile: ModelProfileV1): ModelRouteV1 {
	return {
		provider: profile.provider,
		model: profile.model,
		...(profile.effort === undefined ? {} : { effort: profile.effort }),
		...(profile.serviceTier === undefined ? {} : { serviceTier: profile.serviceTier }),
		...(profile.fallback === undefined ? {} : { fallback: profile.fallback.map((route) => ({ ...route })) }),
	};
}

function mergeBudgetMin(left: BudgetV1, right: BudgetV1): BudgetV1 {
	const result: BudgetV1 = {};
	for (const key of BUDGET_KEYS) {
		const a = left[key];
		const b = right[key];
		if (a !== undefined || b !== undefined) result[key] = a === undefined ? b : b === undefined ? a : Math.min(a, b);
	}
	return result;
}

function budgetAtMost(candidate: BudgetV1, ceiling: BudgetV1): boolean {
	for (const key of BUDGET_KEYS) {
		const cap = ceiling[key];
		const got = candidate[key];
		if (cap === undefined) continue;
		if (got === undefined || got > cap) return false;
	}
	return true;
}

function cloneSelector(value: ResourceSelectorV1): ResourceSelectorV1 {
	if (value.policy === "all" || value.policy === "none") return { policy: value.policy };
	return { policy: value.policy, named: Object.freeze([...(value.named ?? [])]) };
}

function selectorProof(parent: ResourceSelectorV1, child: ResourceSelectorV1): ChildBindingTighteningProofV1 | undefined {
	if (!selectorsNarrow(parent, child)) return undefined;
	return canonicalFoundationJson(parent) === canonicalFoundationJson(child) ? "equal" : "narrowed";
}

function sameJson(left: unknown, right: unknown): boolean {
	return canonicalFoundationJson(left) === canonicalFoundationJson(right);
}

function digestOf(value: unknown): FingerprintV1 {
	return fingerprintFoundationValue(value);
}

function applyManagedLock(
	field: ChildBindingProjectionFieldV1,
	locks: ReadonlySet<ChildBindingProjectionFieldV1>,
	proof: ChildBindingTighteningProofV1 | undefined,
): ChildBindingTighteningProofV1 | undefined {
	if (proof === undefined) return undefined;
	if (!locks.has(field)) return proof;
	return proof === "equal" ? "equal" : undefined;
}

function referenceProof(
	parent: VersionedReferenceV1 | RevisionReferenceV1 | undefined,
	child: VersionedReferenceV1 | RevisionReferenceV1 | undefined,
	preflightTighter: boolean,
): ChildBindingTighteningProofV1 | undefined {
	if (parent === undefined && child === undefined) return "equal";
	if (parent === undefined && child !== undefined) return "narrowed";
	if (parent !== undefined && child === undefined) return undefined;
	if (parent === undefined || child === undefined) return undefined;
	if (parent.type !== child.type || parent.id !== child.id) return undefined;
	if (sameJson(parent, child)) return "equal";
	const parentRevision = parent.revision;
	const childRevision = child.revision;
	if (parentRevision === undefined || childRevision === undefined) return undefined;
	if (childRevision < parentRevision) return undefined;
	if (childRevision === parentRevision) {
		return parent.fingerprint !== undefined && child.fingerprint !== undefined && parent.fingerprint.value === child.fingerprint.value
			? "equal"
			: undefined;
	}
	return preflightTighter ? "narrowed" : undefined;
}

function fieldRecord(
	field: ChildBindingProjectionFieldV1,
	parentValue: unknown,
	childValue: unknown,
	proof: ChildBindingTighteningProofV1,
): ChildBindingProjectionFieldRecordV1 {
	return {
		field,
		parentDigest: digestOf(parentValue),
		childDigest: digestOf(childValue),
		tighteningProof: proof,
	};
}

function validateOptionalSelector(value: unknown, label: string): ResultValue<ResourceSelectorV1 | undefined, FoundationError> {
	if (value === undefined) return Result.ok(undefined);
	const checked = validateExactShape<ResourceSelectorV1>(ResourceSelectorV1Schema, value, "resource_selector");
	return checked.ok ? checked : projectionError(`${label} is not an exact ResourceSelectorV1`);
}

function validateOptionalRevision(value: unknown, label: string): ResultValue<RevisionReferenceV1 | undefined, FoundationError> {
	if (value === undefined) return Result.ok(undefined);
	const checked = validateExactShape<RevisionReferenceV1>(RevisionReferenceV1Schema, value, "revision_reference");
	return checked.ok ? checked : projectionError(`${label} is not an exact RevisionReferenceV1`);
}

function validateInputShape(value: unknown): value is ProjectChildBindingInputV1 {
	if (!isRecord(value) || Object.keys(value).some((key) => !INPUT_KEYS.has(key))) return false;
	if (value.schemaVersion !== CHILD_BINDING_PROJECTION_SCHEMA_VERSION) return false;
	if (!isSafeIdentifier(value.spawnId) || !isSafeIdentifier(value.childBindingId) || !isCanonicalTimestamp(value.createdAt)) return false;
	if (value.managedLocks !== undefined) {
		if (!Array.isArray(value.managedLocks)) return false;
		if (!value.managedLocks.every((field) => CHILD_BINDING_PROJECTION_FIELDS.includes(field as ChildBindingProjectionFieldV1))) return false;
	}
	return true;
}

function projectChildBindingUnchecked(input: ProjectChildBindingInputV1): ResultValue<ChildBindingProjectionV1, FoundationError> {
	if (input.childBudget !== undefined) {
		const budget = validateBudgetV1(input.childBudget);
		if (!budget.ok) return projectionError("Child budget is not an exact BudgetV1");
	}
	if (input.childModelRoute !== undefined) {
		const route = validateExactShape<ModelRouteV1>(ModelRouteV1Schema, input.childModelRoute, "model_route");
		if (!route.ok) return projectionError("Child model route is not an exact ModelRouteV1");
	}
	if (input.hostPreflight !== undefined) {
		const preflight = validateExactShape<ChildBindingHostPreflightV1>(HostPreflightV1Schema, input.hostPreflight, "host_preflight");
		if (!preflight.ok) return projectionError("Host preflight is not an exact shape");
	}
	const parentGitSelector = validateOptionalSelector(input.parentGitSelector, "Parent git selector");
	if (!parentGitSelector.ok) return parentGitSelector;
	const childGitSelector = validateOptionalSelector(input.childGitSelector, "Child git selector");
	if (!childGitSelector.ok) return childGitSelector;
	const childPolicyRevision = validateOptionalRevision(input.childPolicyRevision, "Child policy revision");
	if (!childPolicyRevision.ok) return childPolicyRevision;
	const childCapabilityRevision = validateOptionalRevision(input.childCapabilityRevision, "Child capability revision");
	if (!childCapabilityRevision.ok) return childCapabilityRevision;

	const parentBinding = validateImmutableAgentBindingV1(input.parentBinding);
	if (!parentBinding.ok) return projectionError("Parent AgentBinding is invalid");
	const parentRole = validateRoleRevisionV1(input.parentRoleRevision);
	if (!parentRole.ok) return projectionError("Parent RoleRevision is invalid");
	const childRole = validateRoleRevisionV1(input.childRoleRevision);
	if (!childRole.ok) return projectionError("Child RoleRevision is invalid");
	const parentProfile = validateSecretFreeModelProfileV1(input.parentModelProfile);
	if (!parentProfile.ok) return projectionError("Parent ModelProfile is invalid");
	const childProfile = validateSecretFreeModelProfileV1(input.childModelProfile);
	if (!childProfile.ok) return projectionError("Child ModelProfile is invalid");
	const childTask = validateTaskEnvelope(input.childTaskEnvelope);
	if (!childTask.ok) return projectionError("Child TaskEnvelope is invalid");
	if (parentBinding.value.roleRevision.id !== parentRole.value.roleRevisionId) {
		return projectionError("Parent RoleRevision does not match the parent Binding");
	}
	if (parentBinding.value.modelProfileRevision.id !== parentProfile.value.modelProfileId) {
		return projectionError("Parent ModelProfile does not match the parent Binding");
	}
	const locks = new Set(input.managedLocks ?? []);
	const childRoute = input.childModelRoute ?? routeFromProfile(childProfile.value);
	if (canonicalFoundationJson(childRoute) !== canonicalFoundationJson(routeFromProfile(childProfile.value))) {
		return projectionError("Child model route is not frozen from its durable ModelProfile");
	}

	const instructionParent = parentRole.value.contextPolicyRef;
	const instructionChild = childRole.value.contextPolicyRef;
	const instructionProof = applyManagedLock(
		"instructions",
		locks,
		referenceProof(instructionParent, instructionChild, input.hostPreflight?.instructionsTighter === true),
	);
	if (instructionProof === undefined) return projectionError("Instruction policy reference cannot loosen the parent");

	const skillProof = applyManagedLock("skills", locks, selectorProof(parentRole.value.skillSelector, childRole.value.skillSelector));
	if (skillProof === undefined) return projectionError("Skill selector cannot widen the parent");

	const mcpProof = applyManagedLock("mcp", locks, selectorProof(parentRole.value.mcpSelector, childRole.value.mcpSelector));
	if (mcpProof === undefined) return projectionError("MCP selector cannot widen the parent");

	const parentModelValue = {
		modelProfileRevision: parentBinding.value.modelProfileRevision,
		modelRoute: parentBinding.value.modelRoute,
	};
	const childModelValue = {
		modelProfileRevision: {
			schemaVersion: 1 as const,
			type: "model_profile_revision",
			id: childProfile.value.modelProfileId,
			revision: childProfile.value.revision,
			fingerprint: childProfile.value.fingerprint,
		},
		modelRoute: childRoute,
	};
	const modelBaseProof: ChildBindingTighteningProofV1 = sameJson(parentModelValue, childModelValue) ? "equal" : "narrowed";
	const modelProof = applyManagedLock("model", locks, modelBaseProof);
	if (modelProof === undefined) return projectionError("Managed Lock forbids changing the parent model");

	const childPolicy = childPolicyRevision.value ?? parentBinding.value.policyRevision;
	const childCapability = childCapabilityRevision.value ?? parentBinding.value.capabilityRevision;
	const policyProof = referenceProof(parentBinding.value.policyRevision, childPolicy, input.hostPreflight?.policyTighter === true);
	const capabilityProof = referenceProof(
		parentBinding.value.capabilityRevision,
		childCapability,
		input.hostPreflight?.capabilityTighter === true,
	);
	if (policyProof === undefined || capabilityProof === undefined) {
		return projectionError("Sandbox policy or capability revision cannot loosen the parent");
	}
	const sandboxProof = applyManagedLock(
		"sandbox",
		locks,
		policyProof === "equal" && capabilityProof === "equal" ? "equal" : "narrowed",
	);
	if (sandboxProof === undefined) return projectionError("Managed Lock forbids changing the parent sandbox");

	const parentGit = cloneSelector(parentGitSelector.value ?? parentBinding.value.capabilitySelector);
	const childGit = cloneSelector(childGitSelector.value ?? parentGit);
	const gitProof = applyManagedLock("git", locks, selectorProof(parentGit, childGit));
	if (gitProof === undefined) return projectionError("Git selector cannot widen the parent");

	const floor = mergeBudgetMin(
		mergeBudgetMin(parentBinding.value.budget, childTask.value.budget),
		childProfile.value.budget,
	);
	const requested = input.childBudget;
	if (requested !== undefined) {
		const exactBudget = validateBudgetV1(requested);
		if (!exactBudget.ok) return projectionError("Child budget is not an exact BudgetV1");
		if (!budgetAtMost(exactBudget.value, floor)) {
			return projectionError("Child budget cannot exceed the parent, task, and model-profile minimum");
		}
	}
	const projectedBudget = requested === undefined ? floor : mergeBudgetMin(floor, requested);
	const budgetBaseProof: ChildBindingTighteningProofV1 = sameJson(projectedBudget, parentBinding.value.budget) ? "equal" : "narrowed";
	const budgetProof = applyManagedLock("budget", locks, budgetBaseProof);
	if (budgetProof === undefined) return projectionError("Managed Lock forbids changing the parent budget");

	const fields: ChildBindingProjectionFieldRecordV1[] = [
		fieldRecord("instructions", instructionParent ?? null, instructionChild ?? null, instructionProof),
		fieldRecord("skills", parentRole.value.skillSelector, childRole.value.skillSelector, skillProof),
		fieldRecord("mcp", parentRole.value.mcpSelector, childRole.value.mcpSelector, mcpProof),
		fieldRecord("model", parentModelValue, childModelValue, modelProof),
		fieldRecord(
			"sandbox",
			{ policyRevision: parentBinding.value.policyRevision, capabilityRevision: parentBinding.value.capabilityRevision },
			{ policyRevision: childPolicy, capabilityRevision: childCapability },
			sandboxProof,
		),
		fieldRecord("git", parentGit, childGit, gitProof),
		fieldRecord("budget", parentBinding.value.budget, projectedBudget, budgetProof),
	];
	const base = {
		schemaVersion: CHILD_BINDING_PROJECTION_SCHEMA_VERSION,
		parentBindingId: parentBinding.value.bindingId,
		childBindingId: input.childBindingId,
		spawnId: input.spawnId,
		fields,
		createdAt: input.createdAt,
	};
	return Result.ok(
		cloneDeepFrozen({
			...base,
			digest: digestOf(base),
		}),
	);
}

/**
 * Project the seven inherited resources from parent Binding + child Role/Profile/Task.
 * Any widening, Managed Lock change, or unfrozen model route fails closed.
 */
export function projectChildBindingV1(inputValue: unknown): ResultValue<ChildBindingProjectionV1, FoundationError> {
	try {
		if (!validateInputShape(inputValue)) {
			return projectionError("Child Binding projection input is invalid");
		}
		return projectChildBindingUnchecked(inputValue);
	} catch {
		return projectionError("Child Binding projection input is invalid");
	}
}

export function validateChildBindingProjectionV1(value: unknown): value is ChildBindingProjectionV1 {
	try {
		const checked = validateExactShape<ChildBindingProjectionV1>(ChildBindingProjectionV1Schema, value, "child_binding_projection");
		if (!checked.ok) return false;
		if (
			!isSafeIdentifier(checked.value.parentBindingId) ||
			!isSafeIdentifier(checked.value.childBindingId) ||
			!isSafeIdentifier(checked.value.spawnId) ||
			!isCanonicalTimestamp(checked.value.createdAt)
		) {
			return false;
		}
		if (checked.value.fields.length !== CHILD_BINDING_PROJECTION_FIELDS.length) return false;
		if (checked.value.fields.some((field, index) => field.field !== CHILD_BINDING_PROJECTION_FIELDS[index])) return false;
		const { digest, ...base } = checked.value;
		return digestOf(base).value === digest.value;
	} catch {
		return false;
	}
}

export async function persistChildBindingProjectionV1(
	ledger: SessionLedgerV1,
	projection: ChildBindingProjectionV1,
	options: {
		readonly clientRequestId: string;
		readonly correlation: { readonly taskId?: string; readonly attemptId?: string; readonly agentInstanceId?: string };
	},
): Promise<ResultValue<ChildBindingProjectionV1, FoundationError>> {
	if (!validateChildBindingProjectionV1(projection)) {
		return projectionError("Child Binding projection cannot be persisted");
	}
	try {
		const result = await ledger.appendFact(CHILD_BINDING_PROJECTION_OBJECT_TYPE, projection.spawnId, projection, {
			clientRequestId: options.clientRequestId,
			correlation: options.correlation,
		});
		return Result.ok(cloneDeepFrozen(result.payload));
	} catch {
		return Result.err(new FoundationError("subagent_persistence_failed", "Child Binding projection could not be persisted"));
	}
}
