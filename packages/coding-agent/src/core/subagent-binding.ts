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
	FingerprintSchema,
	FoundationError,
	projectMcpSelectionToSelector,
	ModelRouteSchema,
	ResourceSelectorSchema,
	Result,
	RevisionReferenceSchema,
	selectorsNarrow,
	validateBudget,
	validateExactShape,
	validateImmutableAgentBinding,
	validateChildMcpSelection,
	validateMcpSelectionForBinding,
	validateRoleRevision,
	validateSecretFreeModelProfile,
	validateTaskEnvelope,
	type AgentBinding,
	type Budget,
	type Fingerprint,
	type ModelProfile,
	type ModelRoute,
	type McpSelection,
	type ResourceSelector,
	type Result as ResultValue,
	type RevisionReference,
	type RoleRevision,
	type SessionLedger,
	type TaskEnvelope,
	type VersionedReference,
} from "@aos-agent/agent-core";
import {
	POLICY_REQUEST_PREFIX,
	authorizePolicyOperation,
	freezePolicyProfile,
	type ExecutionPolicyProfile,
	type PolicyApprovalRequest,
	type PolicyBinding,
	type PolicyDecision,
} from "./execution-policy.ts";
import {
	InMemoryExecutionPolicyLedger,
	POLICY_APPROVAL_CUSTOM_TYPE,
	createPolicyBindingLedgerRecord,
	type PolicyLedgerEvent,
} from "./execution-policy-ledger.ts";

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
export type ChildBindingProjectionField = (typeof CHILD_BINDING_PROJECTION_FIELDS)[number];
export type ChildBindingTighteningProof = "equal" | "narrowed";

export interface ChildBindingProjectionFieldRecord {
	readonly field: ChildBindingProjectionField;
	readonly parentDigest: Fingerprint;
	readonly childDigest: Fingerprint;
	readonly tighteningProof: ChildBindingTighteningProof;
}

export interface ChildBindingProjection {
	readonly schemaVersion: 1;
	readonly parentBindingId: string;
	readonly childBindingId: string;
	readonly spawnId: string;
	readonly fields: readonly ChildBindingProjectionFieldRecord[];
	readonly digest: Fingerprint;
	readonly createdAt: string;
	readonly mcpApprovalEvidenceId?: string;
}

export interface ChildBindingHostPreflight {
	readonly policyTighter?: boolean;
	readonly capabilityTighter?: boolean;
	readonly instructionsTighter?: boolean;
}

/** Nominal Host authority backed by one effective PolicyBinding and its durable approval ledger. */
export interface McpInheritanceApprovalAuthority {
	readonly schemaVersion: 1;
	readonly policyBindingId: string;
}

export interface CreateMcpInheritanceApprovalAuthorityInput {
	readonly schemaVersion: 1;
	readonly profile: ExecutionPolicyProfile;
	readonly binding: PolicyBinding;
	readonly policyRevision: RevisionReference;
	readonly ledger: InMemoryExecutionPolicyLedger;
	readonly onApprovalRequired?: (approval: PolicyApprovalRequest) => void;
}

export interface ProjectChildBindingInput {
	readonly schemaVersion: 1;
	readonly spawnId: string;
	readonly parentBinding: AgentBinding;
	readonly childBindingId: string;
	readonly parentRoleRevision: RoleRevision;
	readonly childRoleRevision: RoleRevision;
	readonly parentModelProfile: ModelProfile;
	readonly childModelProfile: ModelProfile;
	readonly childTaskEnvelope: TaskEnvelope;
	readonly createdAt: string;
	readonly childModelRoute?: ModelRoute;
	readonly childBudget?: Budget;
	readonly parentGitSelector?: ResourceSelector;
	readonly childGitSelector?: ResourceSelector;
	readonly childPolicyRevision?: RevisionReference;
	readonly childCapabilityRevision?: RevisionReference;
	readonly childMcpSelection?: McpSelection;
	readonly managedLocks?: readonly ChildBindingProjectionField[];
	readonly hostPreflight?: ChildBindingHostPreflight;
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
	"childMcpSelection",
	"managedLocks",
	"hostPreflight",
]);
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const MCP_POLICY_RESOURCE = "mcp.auth" as const;
const FIELD_LITERALS = CHILD_BINDING_PROJECTION_FIELDS.map((field) => Type.Literal(field));
const ChildBindingProjectionFieldRecordV1Schema = Type.Object(
	{
		field: Type.Union(FIELD_LITERALS),
		parentDigest: FingerprintSchema,
		childDigest: FingerprintSchema,
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
		digest: FingerprintSchema,
		createdAt: Type.String({ minLength: 1 }),
		mcpApprovalEvidenceId: Type.Optional(Type.String({ minLength: 1 })),
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

interface McpInheritanceApprovalAuthorityStateV1 {
	readonly profile: ExecutionPolicyProfile;
	readonly binding: PolicyBinding;
	readonly policyRevision: RevisionReference;
	readonly ledger: InMemoryExecutionPolicyLedger;
	readonly onApprovalRequired?: (approval: PolicyApprovalRequest) => void;
}

const MCP_INHERITANCE_AUTHORITIES = new WeakMap<
	McpInheritanceApprovalAuthority,
	McpInheritanceApprovalAuthorityStateV1
>();
const TRUSTED_CHILD_BINDING_PROJECTIONS = new WeakSet<ChildBindingProjection>();

export function createMcpInheritanceApprovalAuthority(
	input: CreateMcpInheritanceApprovalAuthorityInput,
): McpInheritanceApprovalAuthority {
	if (input.schemaVersion !== 1 || !(input.ledger instanceof InMemoryExecutionPolicyLedger)) {
		throw new FoundationError("subagent_binding_projection_invalid", "MCP inheritance approval authority is invalid");
	}
	const profile = freezePolicyProfile(input.profile);
	const binding = createPolicyBindingLedgerRecord(input.binding);
	const policyRevision = validateExactShape<RevisionReference>(RevisionReferenceSchema, input.policyRevision, "policy_revision");
	if (
		!policyRevision.ok ||
		policyRevision.value.type !== "policy_binding" ||
		policyRevision.value.id !== binding.id ||
		binding.profileId !== profile.id ||
		(profile.revision !== undefined && binding.profileRevision !== profile.revision)
	) {
		throw new FoundationError("subagent_binding_projection_invalid", "MCP inheritance Policy profile does not match its binding");
	}
	const authority = Object.freeze({ schemaVersion: 1 as const, policyBindingId: binding.id });
	MCP_INHERITANCE_AUTHORITIES.set(authority, {
		profile,
		binding,
		policyRevision: policyRevision.value,
		ledger: input.ledger,
		...(input.onApprovalRequired === undefined ? {} : { onApprovalRequired: input.onApprovalRequired }),
	});
	return authority;
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

function resolveMcpInheritanceApproval(
	authority: McpInheritanceApprovalAuthority | undefined,
	input: {
		readonly parentBindingId: string;
		readonly childBindingId: string;
		readonly policyRevision: RevisionReference;
		readonly parentSelection: McpSelection;
		readonly childSelection: McpSelection;
	},
): ResultValue<string | undefined, FoundationError> {
	if (input.childSelection.servers.length === 0) return Result.ok(undefined);
	const state = authority === undefined ? undefined : MCP_INHERITANCE_AUTHORITIES.get(authority);
	if (state === undefined || !sameJson(state.policyRevision, input.policyRevision)) {
		return projectionError("MCP inheritance requires trusted effective Policy authority");
	}
	const scope = {
		schemaVersion: 1 as const,
		policyRevision: input.policyRevision,
		parentBindingId: input.parentBindingId,
		childBindingId: input.childBindingId,
		parentSelectionDigest: input.parentSelection.digest,
		childSelectionDigest: input.childSelection.digest,
	};
	const scopeDigest = `sha256:${digestOf(scope).value}`;
	const requestId = `${POLICY_REQUEST_PREFIX}${scopeDigest.slice("sha256:".length)}`;
	let decision: PolicyDecision;
	try {
		decision = authorizePolicyOperation({
			profile: state.profile,
			binding: state.binding,
			operation: { resource: MCP_POLICY_RESOURCE, source: "system", id: requestId },
		});
	} catch {
		return projectionError("MCP inheritance Policy evaluation failed");
	}
	if (decision.bindingId !== input.policyRevision.id || decision.requestId !== requestId) {
		return projectionError("MCP inheritance Policy decision is bound to another scope");
	}
	if (decision.outcome === "allow") return Result.ok(undefined);
	if (decision.outcome !== "ask" || decision.approval === undefined) {
		return projectionError("MCP inheritance is denied by effective Policy");
	}
	const approval = cloneDeepFrozen({
		...decision.approval,
		scopeDigest,
		scope: { ...decision.approval.scope, scopeDigest },
	});
	const events = state.ledger.query({ customType: POLICY_APPROVAL_CUSTOM_TYPE, bindingId: input.policyRevision.id })
		.filter((event): event is Extract<PolicyLedgerEvent, { readonly customType: typeof POLICY_APPROVAL_CUSTOM_TYPE }> =>
			event.customType === POLICY_APPROVAL_CUSTOM_TYPE)
		.filter((event) => (event.record.requestId ?? event.record.id) === requestId);
	if (events.length === 0) {
		try {
			state.ledger.appendApproval(approval);
			state.onApprovalRequired?.(approval);
		} catch {
			return projectionError("MCP inheritance approval request could not be persisted");
		}
		return projectionError("MCP inheritance approval evidence is required");
	}
	if (events.some((event) => {
		const record = event.record;
		return record.bindingId !== input.policyRevision.id ||
			record.resource !== MCP_POLICY_RESOURCE ||
			record.reasonCode !== "policy_approval_required" ||
			record.createdAt !== approval.createdAt ||
			record.scopeDigest !== scopeDigest ||
			record.scope.scopeDigest !== scopeDigest;
	})) {
		return projectionError("MCP inheritance approval evidence is stale or bound to another scope");
	}
	const terminal = events.filter((event) => event.record.outcome !== undefined);
	if (terminal.length !== 1) {
		return projectionError("MCP inheritance approval evidence is missing or conflicting");
	}
	const evidence = terminal[0]!;
	const resolvedAt = evidence.record.resolvedAt;
	if (
		evidence.entryId === undefined ||
		evidence.record.outcome !== "approved" ||
		resolvedAt === undefined ||
		!isCanonicalTimestamp(resolvedAt) ||
		Date.parse(resolvedAt) < Date.parse(approval.createdAt)
	) {
		return projectionError("MCP inheritance approval evidence is rejected, stale, or not durable");
	}
	return Result.ok(evidence.entryId);
}

function routeFromProfile(profile: ModelProfile): ModelRoute {
	return {
		provider: profile.provider,
		model: profile.model,
		...(profile.effort === undefined ? {} : { effort: profile.effort }),
		...(profile.serviceTier === undefined ? {} : { serviceTier: profile.serviceTier }),
		...(profile.fallback === undefined ? {} : { fallback: profile.fallback.map((route) => ({ ...route })) }),
	};
}

function mergeBudgetMin(left: Budget, right: Budget): Budget {
	const result: Budget = {};
	for (const key of BUDGET_KEYS) {
		const a = left[key];
		const b = right[key];
		if (a !== undefined || b !== undefined) result[key] = a === undefined ? b : b === undefined ? a : Math.min(a, b);
	}
	return result;
}

function budgetAtMost(candidate: Budget, ceiling: Budget): boolean {
	for (const key of BUDGET_KEYS) {
		const cap = ceiling[key];
		const got = candidate[key];
		if (cap === undefined) continue;
		if (got === undefined || got > cap) return false;
	}
	return true;
}

function cloneSelector(value: ResourceSelector): ResourceSelector {
	if (value.policy === "all" || value.policy === "none") return { policy: value.policy };
	return { policy: value.policy, named: Object.freeze([...(value.named ?? [])]) };
}

function selectorProof(parent: ResourceSelector, child: ResourceSelector): ChildBindingTighteningProof | undefined {
	if (!selectorsNarrow(parent, child)) return undefined;
	return canonicalFoundationJson(parent) === canonicalFoundationJson(child) ? "equal" : "narrowed";
}

function sameJson(left: unknown, right: unknown): boolean {
	return canonicalFoundationJson(left) === canonicalFoundationJson(right);
}

function digestOf(value: unknown): Fingerprint {
	return fingerprintFoundationValue(value);
}

function applyManagedLock(
	field: ChildBindingProjectionField,
	locks: ReadonlySet<ChildBindingProjectionField>,
	proof: ChildBindingTighteningProof | undefined,
): ChildBindingTighteningProof | undefined {
	if (proof === undefined) return undefined;
	if (!locks.has(field)) return proof;
	return proof === "equal" ? "equal" : undefined;
}

function referenceProof(
	parent: VersionedReference | RevisionReference | undefined,
	child: VersionedReference | RevisionReference | undefined,
	preflightTighter: boolean,
): ChildBindingTighteningProof | undefined {
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
	field: ChildBindingProjectionField,
	parentValue: unknown,
	childValue: unknown,
	proof: ChildBindingTighteningProof,
): ChildBindingProjectionFieldRecord {
	return {
		field,
		parentDigest: digestOf(parentValue),
		childDigest: digestOf(childValue),
		tighteningProof: proof,
	};
}

function validateOptionalSelector(value: unknown, label: string): ResultValue<ResourceSelector | undefined, FoundationError> {
	if (value === undefined) return Result.ok(undefined);
	const checked = validateExactShape<ResourceSelector>(ResourceSelectorSchema, value, "resource_selector");
	return checked.ok ? checked : projectionError(`${label} is not an exact ResourceSelectorV1`);
}

function validateOptionalRevision(value: unknown, label: string): ResultValue<RevisionReference | undefined, FoundationError> {
	if (value === undefined) return Result.ok(undefined);
	const checked = validateExactShape<RevisionReference>(RevisionReferenceSchema, value, "revision_reference");
	return checked.ok ? checked : projectionError(`${label} is not an exact RevisionReferenceV1`);
}

function validateInputShape(value: unknown): value is ProjectChildBindingInput {
	if (!isRecord(value) || Object.keys(value).some((key) => !INPUT_KEYS.has(key))) return false;
	if (value.schemaVersion !== CHILD_BINDING_PROJECTION_SCHEMA_VERSION) return false;
	if (!isSafeIdentifier(value.spawnId) || !isSafeIdentifier(value.childBindingId) || !isCanonicalTimestamp(value.createdAt)) return false;
	if (value.managedLocks !== undefined) {
		if (!Array.isArray(value.managedLocks)) return false;
		if (!value.managedLocks.every((field) => CHILD_BINDING_PROJECTION_FIELDS.includes(field as ChildBindingProjectionField))) return false;
	}
	return true;
}

function projectChildBindingUnchecked(
	input: ProjectChildBindingInput,
	mcpInheritanceAuthority?: McpInheritanceApprovalAuthority,
): ResultValue<ChildBindingProjection, FoundationError> {
	if (input.childBudget !== undefined) {
		const budget = validateBudget(input.childBudget);
		if (!budget.ok) return projectionError("Child budget is not an exact BudgetV1");
	}
	if (input.childModelRoute !== undefined) {
		const route = validateExactShape<ModelRoute>(ModelRouteSchema, input.childModelRoute, "model_route");
		if (!route.ok) return projectionError("Child model route is not an exact ModelRouteV1");
	}
	if (input.hostPreflight !== undefined) {
		const preflight = validateExactShape<ChildBindingHostPreflight>(HostPreflightV1Schema, input.hostPreflight, "host_preflight");
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

	const parentBinding = validateImmutableAgentBinding(input.parentBinding);
	if (!parentBinding.ok) return projectionError("Parent AgentBinding is invalid");
	const parentRole = validateRoleRevision(input.parentRoleRevision);
	if (!parentRole.ok) return projectionError("Parent RoleRevision is invalid");
	const childRole = validateRoleRevision(input.childRoleRevision);
	if (!childRole.ok) return projectionError("Child RoleRevision is invalid");
	const parentProfile = validateSecretFreeModelProfile(input.parentModelProfile);
	if (!parentProfile.ok) return projectionError("Parent ModelProfile is invalid");
	const childProfile = validateSecretFreeModelProfile(input.childModelProfile);
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
	const childPolicy = childPolicyRevision.value ?? parentBinding.value.policyRevision;
	const childCapability = childCapabilityRevision.value ?? parentBinding.value.capabilityRevision;

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

	const mcpSelectorProof = selectorProof(parentRole.value.mcpSelector, childRole.value.mcpSelector);
	if (mcpSelectorProof === undefined) return projectionError("MCP selector cannot widen the parent");
	let childMcpSelection = input.childMcpSelection;
	if (childMcpSelection === undefined) {
		if (!sameJson(childCapability, parentBinding.value.capabilityRevision)) {
			return projectionError("Child MCP selection is required when the CapabilityBinding changes");
		}
		const projected = projectMcpSelectionToSelector(
			parentBinding.value.mcpSelection,
			childRole.value.mcpSelector,
			childCapability.id,
		);
		if (!projected.ok) return projectionError("Child MCP selector cannot resolve outside the parent exact set");
		childMcpSelection = projected.value;
	}
	const checkedChildMcpSelection = validateMcpSelectionForBinding(
		childMcpSelection,
		childRole.value.mcpSelector,
		childCapability.id,
	);
	if (!checkedChildMcpSelection.ok) return projectionError("Child MCP selection is invalid");
	const checkedMcpInheritance = validateChildMcpSelection({
		parentSelection: parentBinding.value.mcpSelection,
		childSelection: checkedChildMcpSelection.value,
	});
	if (!checkedMcpInheritance.ok) return projectionError(checkedMcpInheritance.error.message);
	const mcpApprovalEvidenceId = resolveMcpInheritanceApproval(mcpInheritanceAuthority, {
		parentBindingId: parentBinding.value.bindingId,
		childBindingId: input.childBindingId,
		policyRevision: childPolicy,
		parentSelection: parentBinding.value.mcpSelection,
		childSelection: checkedChildMcpSelection.value,
	});
	if (!mcpApprovalEvidenceId.ok) return mcpApprovalEvidenceId;
	const mcpBaseProof: ChildBindingTighteningProof =
		mcpSelectorProof === "equal" && sameJson(parentBinding.value.mcpSelection, checkedChildMcpSelection.value)
			? "equal"
			: "narrowed";
	const mcpProof = applyManagedLock("mcp", locks, mcpBaseProof);
	if (mcpProof === undefined) return projectionError("Managed Lock forbids changing the parent MCP selection");

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
	const modelBaseProof: ChildBindingTighteningProof = sameJson(parentModelValue, childModelValue) ? "equal" : "narrowed";
	const modelProof = applyManagedLock("model", locks, modelBaseProof);
	if (modelProof === undefined) return projectionError("Managed Lock forbids changing the parent model");

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
		const exactBudget = validateBudget(requested);
		if (!exactBudget.ok) return projectionError("Child budget is not an exact BudgetV1");
		if (!budgetAtMost(exactBudget.value, floor)) {
			return projectionError("Child budget cannot exceed the parent, task, and model-profile minimum");
		}
	}
	const projectedBudget = requested === undefined ? floor : mergeBudgetMin(floor, requested);
	const budgetBaseProof: ChildBindingTighteningProof = sameJson(projectedBudget, parentBinding.value.budget) ? "equal" : "narrowed";
	const budgetProof = applyManagedLock("budget", locks, budgetBaseProof);
	if (budgetProof === undefined) return projectionError("Managed Lock forbids changing the parent budget");

	const fields: ChildBindingProjectionFieldRecord[] = [
		fieldRecord("instructions", instructionParent ?? null, instructionChild ?? null, instructionProof),
		fieldRecord("skills", parentRole.value.skillSelector, childRole.value.skillSelector, skillProof),
		fieldRecord("mcp", parentBinding.value.mcpSelection, checkedChildMcpSelection.value, mcpProof),
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
		...(mcpApprovalEvidenceId.value === undefined ? {} : { mcpApprovalEvidenceId: mcpApprovalEvidenceId.value }),
	};
	const projection = cloneDeepFrozen({
		...base,
		digest: digestOf(base),
	});
	TRUSTED_CHILD_BINDING_PROJECTIONS.add(projection);
	return Result.ok(projection);
}

/**
 * Project the seven inherited resources from parent Binding + child Role/Profile/Task.
 * Any widening, Managed Lock change, or unfrozen model route fails closed.
 */
export function projectChildBinding(
	inputValue: unknown,
	mcpInheritanceAuthority?: McpInheritanceApprovalAuthority,
): ResultValue<ChildBindingProjection, FoundationError> {
	try {
		if (!validateInputShape(inputValue)) {
			return projectionError("Child Binding projection input is invalid");
		}
		return projectChildBindingUnchecked(inputValue, mcpInheritanceAuthority);
	} catch {
		return projectionError("Child Binding projection input is invalid");
	}
}

export function validateChildBindingProjection(value: unknown): value is ChildBindingProjection {
	try {
		const checked = validateExactShape<ChildBindingProjection>(ChildBindingProjectionV1Schema, value, "child_binding_projection");
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

export async function persistChildBindingProjection(
	ledger: SessionLedger,
	projection: ChildBindingProjection,
	options: {
		readonly clientRequestId: string;
		readonly correlation: { readonly taskId?: string; readonly attemptId?: string; readonly agentInstanceId?: string };
	},
): Promise<ResultValue<ChildBindingProjection, FoundationError>> {
	if (!validateChildBindingProjection(projection)) {
		return projectionError("Child Binding projection cannot be persisted");
	}
	if (!TRUSTED_CHILD_BINDING_PROJECTIONS.has(projection)) {
		return projectionError("Child Binding projection lacks trusted projection authority");
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
