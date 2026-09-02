import {
	createBindingHandle,
	createBindingRevision,
	isBindingHandle,
	type BindingHandle,
	type PublicBindingSummary,
} from "../binding-handles.ts";
import {
	TASK_CREDENTIAL_MAX_SCOPES,
	TASK_CREDENTIAL_MAX_TTL_MS,
	TASK_CREDENTIAL_RENEWAL_WINDOW_MS,
	TaskCredentialError,
	calculateScopeDigest,
	isTaskCredentialEpochMs,
	isTaskCredentialIdentifier,
	isTaskCredentialScope,
	isTaskExecutionBinding,
	normalizeTaskCredentialScopes,
	type TaskCredentialErrorCode,
	type TaskCredentialScope,
	type TaskCredentialTtlBounds,
	type TaskExecutionBinding,
} from "./task-credential-lease.ts";
import {
	isTaskCredentialTargetCapabilities,
	type TaskCredentialTargetCapabilities,
} from "./task-credential-provider.ts";
import {
	calculateProtectedPathPolicyDigest,
	classifyProtectedPathOperation,
	cloneProtectedPathPolicy,
	isCanonicalPolicyTimestamp,
	isCanonicalWorkspaceRelativePath,
	isPolicyEffect,
	narrowProtectedPathPolicy,
	parseProtectedPathPolicy,
	resolvePolicyReviewEvidence,
	type PolicyEffect,
	type PolicyReviewEvidence,
	type PolicyReviewRequirement,
	type ProtectedPathClassification,
	type ProtectedPathPolicy,
} from "./protected-path.ts";

export {
	POLICY_EFFECTS,
	POLICY_REVIEWER_KINDS,
	POLICY_REVIEW_REQUIREMENTS,
	calculatePolicyReviewScopeDigest,
	classifyProtectedPathOperation,
	createPolicyReviewEvidence,
	isCanonicalReviewScopeDigest,
	isCanonicalWorkspaceRelativePath,
	isPolicyEffect,
	isPolicyReviewEvidence,
	isPolicyReviewRequirement,
	resolvePolicyReviewEvidence,
} from "./protected-path.ts";
export type {
	PolicyEffect,
	PolicyReviewDecision,
	PolicyReviewEvidence,
	PolicyReviewEvidenceResolution,
	PolicyReviewerIdentity,
	PolicyReviewerKind,
	PolicyReviewRequirement,
	ProtectedPathClassification,
	ProtectedPathPolicy,
	ProtectedPathRule,
} from "./protected-path.ts";

/**
 * Pure Execution Policy v1 resolver.
 *
 * This module accepts already-resolved inputs only. It does not read settings,
 * environment variables, files, or network state and it never starts an
 * operation. Sensitive operation details are accepted only for local matching
 * and are deliberately omitted from bindings, decisions, summaries, and
 * approval requests.
 */

export const EXECUTION_POLICY_SCHEMA_VERSION = 1 as const;
export const POLICY_SETTINGS_KEY = "executionPolicy" as const;
export const POLICY_DEFAULT_PROFILE = "legacy" as const;
export const POLICY_RUN_FIELD = "policyProfile" as const;
export const POLICY_BINDING_PREFIX = "policy-binding:";
export const POLICY_REQUEST_PREFIX = "policy-request:";

export type PolicyAction = "allow" | "ask" | "deny";
export type PolicyEnforcement = "legacy" | "host" | "sandbox";
export type DlpPolicyAction = "warn" | "redact" | "deny";
export type PolicyResource =
	| "capability.invoke"
	| "filesystem.read"
	| "filesystem.write"
	| "filesystem.find"
	| "filesystem.grep"
	| "process.spawn"
	| "network.connect"
	| "credential.expose"
	| "credential.task.issue"
	| "credential.task.renew"
	| "credential.task.project"
	| "credential.task.revoke"
	| "sandbox.prepare"
	| "mcp.auth"
	| "resource.list"
	| "resource.read"
	| "prompt.list"
	| "prompt.get"
	| "context.attach";
export type PolicyResourceCategory = PolicyResource;
export type PolicyOperation = PolicyResource;
export type PolicyDecisionOutcome = PolicyAction | "sandbox_required";
export type PolicyDecisionStatus = PolicyDecisionOutcome;
export type PolicyDecisionResult = PolicyDecisionOutcome;
/** Final result recorded when an approval request is resolved. */
export type PolicyApprovalOutcome = "approved" | "rejected";
/** Interface that resolved an approval request. */
export type PolicyApprovalSource = "interactive" | "rpc" | "sdk" | "system";
export type PolicyOperationSource =
	| "builtin"
	| "user_bash"
	| "mcp"
	| "extension"
	| "sdk"
	| "rpc"
	| "cli"
	| "system";
export type PolicyWorkspaceScope = WorkspaceScope;
export type PolicyInterfaceMode = "interactive" | "headless";
export type PolicyTrust = "trusted" | "untrusted";
export type SandboxStatus =
	| "not_required"
	| "unavailable"
	| "preparing"
	| "ready"
	| "failed"
	| "disposed";

export type WorkspaceScope =
	| "workspace"
	| "declared-read-only"
	| "temporary"
	| "credentials"
	| "agent-internal";

export const POLICY_ACTIONS = Object.freeze(["allow", "ask", "deny"] as const);
export const POLICY_ENFORCEMENTS = Object.freeze(["legacy", "host", "sandbox"] as const);
export const POLICY_RESOURCE_CATEGORIES = Object.freeze([
	"capability.invoke",
	"filesystem.read",
	"filesystem.write",
	"filesystem.find",
	"filesystem.grep",
	"process.spawn",
	"network.connect",
	"credential.expose",
	"credential.task.issue",
	"credential.task.renew",
	"credential.task.project",
	"credential.task.revoke",
	"sandbox.prepare",
	"mcp.auth",
	"resource.list",
	"resource.read",
	"prompt.list",
	"prompt.get",
	"context.attach",
] as const);
export const POLICY_OPERATION_CATEGORIES = POLICY_RESOURCE_CATEGORIES;
export const POLICY_RESOURCES = POLICY_RESOURCE_CATEGORIES;

/**
 * The Task Credential / Lease operations governed as independent policy
 * resources. Each operation is authorized separately so a profile can allow
 * issuance while denying delivery, renewal, or revoke paths.
 */
export const TASK_CREDENTIAL_POLICY_RESOURCES = Object.freeze([
	"credential.task.issue",
	"credential.task.renew",
	"credential.task.project",
	"credential.task.revoke",
] as const);
export type TaskCredentialPolicyResource = (typeof TASK_CREDENTIAL_POLICY_RESOURCES)[number];

export function isTaskCredentialPolicyResource(value: unknown): value is TaskCredentialPolicyResource {
	return typeof value === "string" && (TASK_CREDENTIAL_POLICY_RESOURCES as readonly string[]).includes(value);
}

export const POLICY_DECISION_OUTCOMES = Object.freeze(["allow", "ask", "deny", "sandbox_required"] as const);
export const POLICY_APPROVAL_OUTCOMES = Object.freeze(["approved", "rejected"] as const);
export const POLICY_APPROVAL_SOURCES = Object.freeze(["interactive", "rpc", "sdk", "system"] as const);
export const POLICY_PUBLIC_SUMMARY_KEYS = Object.freeze([
	"bindingId",
	"profileId",
	"profileRevision",
	"projectTrust",
	"enforcement",
	"sandboxProviderId",
	"sandboxStatus",
	"sandboxCapabilities",
	"resource",
	"action",
	"outcome",
	"reasonCode",
	"requestId",
	"timestamp",
] as const);
export const POLICY_LEDGER_EVENT_TYPES = Object.freeze([
	"policy.binding",
	"policy.decision",
	"policy.approval",
	"sandbox.lifecycle",
	"policy.violation",
] as const);
export const POLICY_QUERY_COMMAND = "get_execution_policy" as const;
export const POLICY_APPROVE_COMMAND = "policy.approve" as const;
export const POLICY_REJECT_COMMAND = "policy.reject" as const;
export const POLICY_BINDING_CUSTOM_TYPE = "policy.binding" as const;

export type PolicyErrorCode =
	| "policy_settings_invalid"
	| "policy_profile_not_found"
	| "policy_profile_untrusted"
	| "policy_binding_failed"
	| "policy_approval_required"
	| "policy_denied"
	| "policy_violation"
	| "workspace_boundary_violation"
	| "network_policy_violation"
	| "credential_policy_violation"
	| "sandbox_required"
	| "sandbox_unavailable"
	| "sandbox_start_failed"
	| "sandbox_capability_insufficient"
	| "policy_ledger_persistence_failed"
	| "protected_path_invalid"
	| "policy_review_required"
	| "policy_review_rejected"
	| "policy_review_evidence_invalid";

export const POLICY_ERROR_CODES = Object.freeze([
	"policy_settings_invalid",
	"policy_profile_not_found",
	"policy_profile_untrusted",
	"policy_binding_failed",
	"policy_approval_required",
	"policy_denied",
	"policy_violation",
	"workspace_boundary_violation",
	"network_policy_violation",
	"credential_policy_violation",
	"sandbox_required",
	"sandbox_unavailable",
	"sandbox_start_failed",
	"sandbox_capability_insufficient",
	"policy_ledger_persistence_failed",
	"protected_path_invalid",
	"policy_review_required",
	"policy_review_rejected",
	"policy_review_evidence_invalid",
] as const);

const POLICY_ERROR_MESSAGES: Readonly<Record<PolicyErrorCode, string>> = {
	policy_settings_invalid: "Execution policy settings are invalid.",
	policy_profile_not_found: "Execution policy profile was not found.",
	policy_profile_untrusted: "Execution policy profile is not trusted for this project.",
	policy_binding_failed: "Execution policy binding could not be created.",
	policy_approval_required: "Policy approval is required before this operation.",
	policy_denied: "The operation was denied by execution policy.",
	policy_violation: "The operation violated execution policy.",
	workspace_boundary_violation: "The operation crossed the workspace boundary.",
	network_policy_violation: "The operation violated the network policy.",
	credential_policy_violation: "Credential exposure is not allowed by execution policy.",
	sandbox_required: "This operation requires a sandbox execution boundary.",
	sandbox_unavailable: "The required sandbox provider is unavailable.",
	sandbox_start_failed: "The sandbox could not be started.",
	sandbox_capability_insufficient: "The sandbox does not provide the required capability.",
	policy_ledger_persistence_failed: "The policy decision could not be recorded safely.",
	protected_path_invalid: "The protected path scope could not be proven.",
	policy_review_required: "Protected path review is required before this operation.",
	policy_review_rejected: "Protected path review rejected this operation.",
	policy_review_evidence_invalid: "Protected path review evidence is invalid for this operation.",
};

const ACTION_RANK: Readonly<Record<PolicyAction, number>> = { allow: 0, ask: 1, deny: 2 };
const ENFORCEMENT_RANK: Readonly<Record<PolicyEnforcement, number>> = { legacy: 0, host: 1, sandbox: 2 };
const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const ENVIRONMENT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_()]*$/;
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;

export interface WorkspacePolicy {
	readonly read: ReadonlyArray<WorkspaceScope>;
	readonly write: ReadonlyArray<WorkspaceScope>;
	readonly deny: ReadonlyArray<WorkspaceScope>;
}

export interface ProcessPolicy {
	readonly action: PolicyAction;
	readonly inheritEnvironment: boolean;
	readonly allowEnvironment: ReadonlyArray<string>;
	readonly cwdScopes?: ReadonlyArray<WorkspaceScope>;
	readonly timeoutMs?: number;
}

export interface NetworkPolicy {
	readonly action: PolicyAction;
	readonly allowDestinations: ReadonlyArray<string>;
}

export interface CredentialPolicy {
	readonly action: PolicyAction;
	readonly allowNames: ReadonlyArray<string>;
}

/** Content-level secret handling at durable-write and public-projection boundaries. */
export interface DlpPolicy {
	readonly enabled: boolean;
	readonly action: DlpPolicyAction;
}

export const DEFAULT_DLP_POLICY: DlpPolicy = Object.freeze({ enabled: true, action: "redact" });

export interface ApprovalPolicy {
	readonly writeOutsideWorkspace: PolicyAction;
	readonly network: PolicyAction;
	readonly process: PolicyAction;
	readonly filesystemRead?: PolicyAction;
	readonly filesystemWrite?: PolicyAction;
	readonly credentials?: PolicyAction;
	readonly sandbox?: PolicyAction;
	/** MCP auth operations (mcp.auth), e.g. OAuth start/logout. */
	readonly mcp?: PolicyAction;
	/** MCP resource catalog/content operations (resource.list, resource.read). */
	readonly resource?: PolicyAction;
	/** MCP prompt catalog/content operations (prompt.list, prompt.get). */
	readonly prompt?: PolicyAction;
	/** Context attachment operations (context.attach). */
	readonly context?: PolicyAction;
}

/** A rule is evaluated in declaration order; the last matching rule wins. */
export interface PolicyRule {
	readonly resource?: PolicyResource | ReadonlyArray<PolicyResource>;
	readonly resources?: ReadonlyArray<PolicyResource>;
	readonly source?: PolicyOperationSource | ReadonlyArray<PolicyOperationSource>;
	readonly sources?: ReadonlyArray<PolicyOperationSource>;
	readonly scope?: WorkspaceScope | ReadonlyArray<WorkspaceScope>;
	readonly scopes?: ReadonlyArray<WorkspaceScope>;
	readonly action: PolicyAction;
}

/** Declarative policy selected from the registered profile catalog. */
export interface ExecutionPolicyProfile {
	readonly id: string;
	readonly revision?: string;
	readonly enforcement: PolicyEnforcement;
	readonly sandboxProvider?: string;
	readonly defaultAction: PolicyAction;
	readonly workspace: WorkspacePolicy;
	readonly process: ProcessPolicy;
	readonly network: NetworkPolicy;
	readonly credentials: CredentialPolicy;
	readonly dlp?: DlpPolicy;
	readonly approvals: ApprovalPolicy;
	readonly protectedPaths?: ProtectedPathPolicy;
	readonly rules?: ReadonlyArray<PolicyRule>;
}

export type PolicyProfile = ExecutionPolicyProfile;

/** A project policy may omit fields; omitted fields leave the user profile unchanged. */
export interface PolicyProfileNarrowing {
	readonly id?: string;
	readonly revision?: string;
	readonly enforcement?: PolicyEnforcement;
	readonly sandboxProvider?: string;
	readonly defaultAction?: PolicyAction;
	readonly workspace?: Partial<WorkspacePolicy>;
	readonly process?: Partial<ProcessPolicy>;
	readonly network?: Partial<NetworkPolicy>;
	readonly credentials?: Partial<CredentialPolicy>;
	readonly dlp?: Partial<DlpPolicy>;
	readonly approvals?: Partial<ApprovalPolicy>;
	readonly protectedPaths?: ProtectedPathPolicy;
	readonly rules?: ReadonlyArray<PolicyRule>;
}

export interface PolicyOperationRequest {
	readonly id?: string;
	readonly resource: PolicyResource;
	readonly source: PolicyOperationSource;
	readonly scope?: WorkspaceScope;
	readonly capabilityId?: string;
	readonly path?: string;
	readonly targetPath?: string;
	/** Exact structured effects; raw commands must not infer these from text. */
	readonly effects?: ReadonlyArray<PolicyEffect>;
	/** Canonical workspace-relative path produced by the host path classifier. */
	readonly canonicalPath?: string;
	readonly canonicalPaths?: ReadonlyArray<string>;
	readonly command?: string;
	readonly args?: ReadonlyArray<string>;
	readonly cwd?: string;
	readonly destination?: string;
	readonly port?: number;
	readonly credentialNames?: ReadonlyArray<string>;
	readonly environmentNames?: ReadonlyArray<string>;
	/** A structured classifier could not enumerate the command's effects. */
	readonly requiresSandbox?: boolean;
	/** True only when the selected Tool Gateway route is a sandbox provider. */
	readonly sandboxed?: boolean;
	/** Exact sandbox Tool Gateway provider identity. */
	readonly sandboxProviderId?: string;
	/** Opaque credential target identity of a Task Credential operation; matched locally only. */
	readonly targetId?: string;
	/** Requested lease TTL of a Task Credential operation; matched locally only. */
	readonly ttlMs?: number;
}

export interface SandboxCapabilities {
	readonly filesystem: boolean;
	readonly process: boolean;
	readonly network: boolean;
	readonly credentialIsolation: boolean;
	/**
	 * Declares per-binding Task Credential delivery (project/renew/revoke)
	 * inside the sandbox target. Absent or false fails closed: the credential
	 * delivery path never falls back to Host environment, command line, or
	 * temporary files.
	 */
	readonly credentialDelivery?: boolean;
}

export interface SandboxPreflight {
	/** `configured` and `providerConfigured` are equivalent aliases. */
	readonly configured?: boolean;
	readonly providerConfigured?: boolean;
	readonly providerId?: string;
	readonly status?: SandboxStatus;
	readonly providerStatus?: SandboxStatus;
	readonly capabilities?: SandboxCapabilities;
	readonly providerCapabilities?: SandboxCapabilities;
	/** Fixture-friendly shorthand for a complete/incomplete capability report. */
	readonly providerCapabilitiesComplete?: boolean;
}

export interface CapabilityBindingInput {
	readonly id?: string;
	readonly allowed?: boolean;
	readonly trusted?: boolean;
	readonly descriptors?: ReadonlyArray<{ readonly id: string }>;
	readonly allowedCapabilityIds?: ReadonlyArray<string>;
	readonly deniedCapabilityIds?: ReadonlyArray<string>;
	readonly allowedResources?: ReadonlyArray<PolicyResource>;
	readonly deniedResources?: ReadonlyArray<PolicyResource>;
	/** Target identities the capability binding declares for Task Credential operations. */
	readonly allowedTargetIds?: ReadonlyArray<string>;
	readonly deniedTargetIds?: ReadonlyArray<string>;
}

export interface PolicyProjectInput {
	readonly trusted?: boolean;
	readonly trust?: PolicyTrust;
	readonly profileId?: string;
	readonly profile?: unknown;
}

export interface ResolveExecutionPolicyInput {
	/** Values are unknown at this boundary so malformed profiles fail closed. */
	readonly profiles?: Readonly<Record<string, unknown>>;
	readonly defaultProfile?: string;
	readonly policyProfile?: string;
	readonly profile?: string;
	readonly projectTrusted?: boolean;
	readonly projectTrust?: PolicyTrust;
	readonly project?: PolicyProjectInput;
	readonly projectProfileId?: string;
	readonly projectProfile?: unknown;
	readonly capabilityBinding?: CapabilityBindingInput;
	readonly capability?: CapabilityBindingInput;
	readonly sandbox?: SandboxPreflight;
	readonly operation?: PolicyOperationRequest | unknown;
	readonly reviewEvidence?: PolicyReviewEvidence | ReadonlyArray<PolicyReviewEvidence>;
	readonly mode?: PolicyInterfaceMode;
	readonly interfaceMode?: PolicyInterfaceMode;
	readonly workspaceIdentity?: string;
	readonly runId?: string;
	readonly bindingId?: string;
	readonly previousPolicyBindingId?: string;
	readonly createdAt?: string;
}

export interface PolicyBindingConstraints {
	readonly workspace: {
		readonly read: ReadonlyArray<WorkspaceScope>;
		readonly write: ReadonlyArray<WorkspaceScope>;
		readonly deny: ReadonlyArray<WorkspaceScope>;
	};
	readonly process: {
		readonly action: PolicyAction;
		readonly inheritEnvironment: boolean;
		readonly allowedEnvironmentCount: number;
		readonly cwdScopes?: ReadonlyArray<WorkspaceScope>;
	};
	readonly network: {
		readonly action: PolicyAction;
		readonly allowedDestinationCount: number;
	};
	readonly credentials: {
		readonly action: PolicyAction;
		readonly allowedNameCount: number;
	};
	readonly protectedPaths?: {
		readonly ruleCount: number;
		readonly managedLockCount: number;
		readonly policyDigest: string;
	};
}

export interface PolicyBinding {
	readonly schemaVersion: typeof EXECUTION_POLICY_SCHEMA_VERSION;
	readonly id: string;
	readonly profileId: string;
	readonly profileRevision: string;
	readonly projectTrust: PolicyTrust;
	readonly capabilityBindingId?: string;
	readonly enforcement: PolicyEnforcement;
	readonly sandboxProviderId?: string;
	readonly sandboxCapabilities: SandboxCapabilities;
	readonly sandboxStatus: SandboxStatus;
	readonly runId: string;
	readonly createdAt: string;
	readonly previousPolicyBindingId?: string;
	readonly workspaceIdentity: string;
	readonly constraints: PolicyBindingConstraints;
	readonly bindingHash: string;
}

export interface PolicyApprovalScope {
	readonly resource: PolicyResource;
	readonly workspaceScopes?: ReadonlyArray<WorkspaceScope>;
	readonly environmentCount?: number;
	readonly destinationCount?: number;
	readonly credentialCount?: number;
	readonly effectCount?: number;
	readonly pathCount?: number;
	readonly scopeDigest?: string;
}

export interface PolicyApprovalRequest {
	readonly id: string;
	readonly bindingId: string;
	readonly resource: PolicyResource;
	readonly source: PolicyOperationSource;
	readonly scope: PolicyApprovalScope;
	readonly reasonCode: "policy_approval_required" | "policy_review_required";
	readonly reason: string;
	readonly createdAt: string;
	readonly reviewRequirement?: Exclude<PolicyReviewRequirement, "none">;
	readonly scopeDigest?: string;
}

export interface PolicyDecision {
	readonly bindingId: string;
	readonly profileId: string;
	readonly profileRevision: string;
	readonly projectTrust: PolicyTrust;
	readonly enforcement: PolicyEnforcement;
	readonly resource: PolicyResource;
	readonly source: PolicyOperationSource;
	readonly action: PolicyAction;
	readonly outcome: PolicyDecisionOutcome;
	readonly reasonCode?: PolicyErrorCode;
	readonly reason?: string;
	readonly hardDeny: boolean;
	readonly requestId?: string;
	readonly timestamp: string;
	readonly approval?: PolicyApprovalRequest;
	readonly effects?: ReadonlyArray<PolicyEffect>;
	readonly protectedPathCount?: number;
	readonly matchedProtectedRuleIds?: ReadonlyArray<string>;
	readonly reviewRequirement?: PolicyReviewRequirement;
	readonly scopeDigest?: string;
	readonly reviewEvidence?: ReadonlyArray<PolicyReviewEvidence>;
	/**
	 * Safe decision facts for Task Credential resources only: the exact
	 * normalized requested credential-name set, the credential target
	 * identity, and the requested lease TTL. Carried on every
	 * `credential.task.*` decision so a later preflight can prove the
	 * decision authorized exactly the requested scope, target, and TTL;
	 * absent on every other resource.
	 */
	readonly credentialNames?: ReadonlyArray<string>;
	readonly targetId?: string;
	readonly ttlMs?: number;
}

/** The allowlisted public shape; raw operation data is intentionally absent. */
export interface PublicPolicySummary {
	readonly bindingId: string;
	readonly profileId: string;
	readonly profileRevision: string;
	readonly projectTrust: PolicyTrust;
	readonly enforcement: PolicyEnforcement;
	readonly sandboxProviderId?: string;
	readonly sandboxStatus: SandboxStatus;
	readonly sandboxCapabilities: SandboxCapabilities;
	readonly resource?: PolicyResource;
	readonly action?: PolicyAction;
	readonly outcome?: PolicyDecisionOutcome;
	readonly reasonCode?: PolicyErrorCode;
	readonly requestId?: string;
	readonly timestamp?: string;
}

/** Stable public name for a policy decision summary. */
export type PolicyDecisionSummary = PublicPolicySummary;

export type PolicySummary = PublicPolicySummary;

export interface PolicyResolution {
	readonly profile: ExecutionPolicyProfile;
	readonly binding: PolicyBinding;
	readonly decision?: PolicyDecision;
	readonly approval?: PolicyApprovalRequest;
	readonly summary: PublicPolicySummary;
}

export interface PolicyErrorView {
	readonly code: PolicyErrorCode;
	readonly message: string;
	readonly retryable: false;
}

export class PolicyError extends Error {
	readonly code: PolicyErrorCode;
	readonly retryable = false as const;

	constructor(code: PolicyErrorCode, _message = POLICY_ERROR_MESSAGES[code]) {
		// Policy errors cross legacy RPC and tool-result boundaries as Error.message.
		// Keep that channel code-derived so provider diagnostics, paths, commands,
		// and credentials cannot escape through a caller-supplied message.
		super(POLICY_ERROR_MESSAGES[code]);
		this.name = "PolicyError";
		this.code = code;
	}

	toJSON(): PolicyErrorView {
		return { code: this.code, message: POLICY_ERROR_MESSAGES[this.code], retryable: false };
	}
}

export type PolicyResolutionResult =
	| {
			readonly ok: true;
			readonly resolution: PolicyResolution;
			readonly profile: ExecutionPolicyProfile;
			readonly binding: PolicyBinding;
			readonly decision?: PolicyDecision;
			readonly approval?: PolicyApprovalRequest;
			readonly summary: PublicPolicySummary;
		}
	| {
			readonly ok: false;
			readonly error: PolicyError;
		};

export type PolicyProfileResolutionResult =
	| {
			readonly ok: true;
			readonly profile: ExecutionPolicyProfile;
			readonly binding: PolicyBinding;
			readonly summary: PublicPolicySummary;
		}
	| {
			readonly ok: false;
			readonly error: PolicyError;
		};

export const LEGACY_PROFILE: ExecutionPolicyProfile = deepFreeze({
	id: "legacy",
	enforcement: "legacy",
	defaultAction: "allow",
	workspace: { read: ["workspace", "declared-read-only"], write: ["workspace"], deny: [] },
	process: { action: "allow", inheritEnvironment: true, allowEnvironment: [] },
	network: { action: "allow", allowDestinations: [] },
	credentials: { action: "allow", allowNames: [] },
	dlp: DEFAULT_DLP_POLICY,
	approvals: { writeOutsideWorkspace: "allow", network: "allow", process: "allow" },
});

function deepFreeze<T>(value: T): T {
	if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
	Object.freeze(value);
	for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
	return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isAction(value: unknown): value is PolicyAction {
	return typeof value === "string" && (value === "allow" || value === "ask" || value === "deny");
}

function isEnforcement(value: unknown): value is PolicyEnforcement {
	return typeof value === "string" && (value === "legacy" || value === "host" || value === "sandbox");
}

function isDlpAction(value: unknown): value is DlpPolicyAction {
	return value === "warn" || value === "redact" || value === "deny";
}

function parseDlpPolicy(value: unknown, partial: boolean): DlpPolicy | Partial<DlpPolicy> | undefined {
	if (value === undefined) return partial ? {} : DEFAULT_DLP_POLICY;
	if (!isRecord(value) || Object.keys(value).some((key) => key !== "enabled" && key !== "action")) return undefined;
	if (value.enabled !== undefined && typeof value.enabled !== "boolean") return undefined;
	if (value.action !== undefined && !isDlpAction(value.action)) return undefined;
	if (!partial) {
		return {
			enabled: value.enabled ?? DEFAULT_DLP_POLICY.enabled,
			action: value.action ?? DEFAULT_DLP_POLICY.action,
		};
	}
	return {
		...(value.enabled === undefined ? {} : { enabled: value.enabled }),
		...(value.action === undefined ? {} : { action: value.action }),
	};
}

/** Resolve the effective DLP policy for profiles created before this field existed. */
export function resolveDlpPolicy(policy: DlpPolicy | undefined): DlpPolicy {
	return policy ?? DEFAULT_DLP_POLICY;
}

function isResource(value: unknown): value is PolicyResource {
	return typeof value === "string" && (POLICY_RESOURCE_CATEGORIES as readonly string[]).includes(value);
}

function isSource(value: unknown): value is PolicyOperationSource {
	return (
		typeof value === "string" &&
		["builtin", "user_bash", "mcp", "extension", "sdk", "rpc", "cli", "system"].includes(value)
	);
}

function isWorkspaceScope(value: unknown): value is WorkspaceScope {
	return (
		typeof value === "string" &&
		["workspace", "declared-read-only", "temporary", "credentials", "agent-internal"].includes(value)
	);
}

function isSandboxStatus(value: unknown): value is SandboxStatus {
	return (
		typeof value === "string" &&
		["not_required", "unavailable", "preparing", "ready", "failed", "disposed"].includes(value)
	);
}

function isSafeIdentifier(value: unknown): value is string {
	return typeof value === "string" && IDENTIFIER_PATTERN.test(value);
}

function isSafeOpaqueId(value: unknown): value is string {
	return typeof value === "string" && OPAQUE_ID_PATTERN.test(value);
}

function isSafeText(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && !CONTROL_CHARACTER_PATTERN.test(value);
}

function isEnvironmentName(value: unknown): value is string {
	return typeof value === "string" && ENVIRONMENT_NAME_PATTERN.test(value);
}

function uniqueSorted(values: ReadonlyArray<string>): string[] {
	return [...new Set(values)].sort();
}

function uniqueInOrder<T extends string>(values: ReadonlyArray<T>): T[] {
	return [...new Set(values)];
}

function strictest(a: PolicyAction, b: PolicyAction): PolicyAction {
	return ACTION_RANK[a] >= ACTION_RANK[b] ? a : b;
}

function strictestEnforcement(a: PolicyEnforcement, b: PolicyEnforcement): PolicyEnforcement {
	return ENFORCEMENT_RANK[a] >= ENFORCEMENT_RANK[b] ? a : b;
}

function policyError(code: PolicyErrorCode): PolicyError {
	return new PolicyError(code);
}

function invalid(): { ok: false; error: PolicyError } {
	return { ok: false, error: policyError("policy_settings_invalid") };
}

function parseStringArray(value: unknown, validate: (item: unknown) => item is string): string[] | undefined {
	if (!Array.isArray(value) || !value.every(validate)) return undefined;
	return uniqueSorted(value);
}

function parseScopeArray(value: unknown): WorkspaceScope[] | undefined {
	if (!Array.isArray(value) || !value.every(isWorkspaceScope)) return undefined;
	return uniqueInOrder(value);
}

function parseAction(value: unknown): PolicyAction | undefined {
	return isAction(value) ? value : undefined;
}

function isPositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isPort(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65535;
}

interface ParsedNetworkDestination {
	readonly hostname: string;
	readonly port?: number;
	readonly wildcard: boolean;
}

const NETWORK_URL_SCHEME_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//;

function defaultNetworkPort(protocol: string): number | undefined {
	switch (protocol.toLowerCase()) {
		case "http:":
		case "ws:":
			return 80;
		case "https:":
		case "wss:":
			return 443;
		default:
			return undefined;
	}
}

function parseNetworkDestination(
	value: string,
	explicitPort: number | undefined,
	options: { readonly allowWildcard: boolean; readonly allowUrlPath: boolean },
): ParsedNetworkDestination | undefined {
	if (value.length === 0 || value !== value.trim() || (explicitPort !== undefined && !isPort(explicitPort))) return undefined;
	const wildcard = options.allowWildcard && value.startsWith("*.");
	const address = wildcard ? value.slice(2) : value;
	if (address.length === 0 || address.includes("*")) return undefined;
	const hasScheme = NETWORK_URL_SCHEME_PATTERN.test(address);
	if (wildcard && hasScheme) return undefined;
	if (!hasScheme && /[/@?#]/.test(address)) return undefined;
	let parsed: URL;
	try {
		parsed = new URL(hasScheme ? address : `network://${address}`);
	} catch {
		return undefined;
	}
	if (
		parsed.hostname.length === 0 ||
		parsed.username.length > 0 ||
		parsed.password.length > 0 ||
		(!options.allowUrlPath &&
			(parsed.pathname !== "" && parsed.pathname !== "/" || parsed.search.length > 0 || parsed.hash.length > 0))
	) {
		return undefined;
	}
	const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
	if (hostname.length === 0) return undefined;
	const parsedPort = parsed.port.length > 0
		? Number(parsed.port)
		: hasScheme
			? defaultNetworkPort(parsed.protocol)
			: undefined;
	if (parsedPort !== undefined && !isPort(parsedPort)) return undefined;
	if (explicitPort !== undefined && parsedPort !== undefined && explicitPort !== parsedPort) return undefined;
	return {
		hostname,
		...(explicitPort === undefined && parsedPort === undefined ? {} : { port: explicitPort ?? parsedPort }),
		wildcard,
	};
}

function isNetworkDestinationPattern(value: unknown): value is string {
	return typeof value === "string" && parseNetworkDestination(value, undefined, { allowWildcard: true, allowUrlPath: false }) !== undefined;
}

/** Match one requested destination against one exact-host or `*.suffix` allowlist pattern. */
export function matchesNetworkDestination(
	destination: string,
	port: number | undefined,
	allowedDestination: string,
): boolean {
	const requested = parseNetworkDestination(destination, port, { allowWildcard: false, allowUrlPath: true });
	const allowed = parseNetworkDestination(allowedDestination, undefined, { allowWildcard: true, allowUrlPath: false });
	if (requested === undefined || allowed === undefined) return false;
	if (allowed.port !== undefined && requested.port !== allowed.port) return false;
	if (!allowed.wildcard) return requested.hostname === allowed.hostname;
	return requested.hostname !== allowed.hostname && requested.hostname.endsWith(`.${allowed.hostname}`);
}

function networkDestinationAllowed(
	destination: string | undefined,
	port: number | undefined,
	allowedDestinations: ReadonlyArray<string>,
): boolean {
	return destination !== undefined && allowedDestinations.some((allowed) => matchesNetworkDestination(destination, port, allowed));
}

function networkPatternIsSubset(candidateValue: string, allowedValue: string): boolean {
	const candidate = parseNetworkDestination(candidateValue, undefined, { allowWildcard: true, allowUrlPath: false });
	const allowed = parseNetworkDestination(allowedValue, undefined, { allowWildcard: true, allowUrlPath: false });
	if (candidate === undefined || allowed === undefined) return false;
	if (allowed.port !== undefined && candidate.port !== allowed.port) return false;
	if (!allowed.wildcard) {
		return !candidate.wildcard && candidate.hostname === allowed.hostname;
	}
	return candidate.wildcard
		? candidate.hostname === allowed.hostname || candidate.hostname.endsWith(`.${allowed.hostname}`)
		: candidate.hostname !== allowed.hostname && candidate.hostname.endsWith(`.${allowed.hostname}`);
}

function networkPatternsSubset(requested: ReadonlyArray<string>, allowed: ReadonlyArray<string>): boolean {
	return requested.every((candidate) => allowed.some((pattern) => networkPatternIsSubset(candidate, pattern)));
}

function parseRule(value: unknown): PolicyRule | undefined {
	if (!isRecord(value) || !isAction(value.action)) return undefined;
	const allowedKeys = ["resource", "resources", "source", "sources", "scope", "scopes", "action"];
	if (Object.keys(value).some((key) => !allowedKeys.includes(key))) return undefined;
	const resourceValues = value.resource === undefined ? [] : Array.isArray(value.resource) ? value.resource : [value.resource];
	const resourcesAlias = value.resources === undefined ? [] : value.resources;
	if (!Array.isArray(resourcesAlias)) return undefined;
	const resources = [...resourceValues, ...resourcesAlias];
	if (resources.length === 0 || !resources.every(isResource)) return undefined;
	const sourceValues = value.source === undefined ? [] : Array.isArray(value.source) ? value.source : [value.source];
	const sourcesAlias = value.sources === undefined ? [] : value.sources;
	if (!Array.isArray(sourcesAlias)) return undefined;
	const sources = [...sourceValues, ...sourcesAlias];
	if (!sources.every(isSource)) return undefined;
	const scopeValues = value.scope === undefined ? [] : Array.isArray(value.scope) ? value.scope : [value.scope];
	const scopesAlias = value.scopes === undefined ? [] : value.scopes;
	if (!Array.isArray(scopesAlias)) return undefined;
	const scopes = [...scopeValues, ...scopesAlias];
	if (!scopes.every(isWorkspaceScope)) return undefined;
	return deepFreeze({
		resource: uniqueInOrder(resources),
		...(sources.length > 0 ? { source: uniqueInOrder(sources) } : {}),
		...(scopes.length > 0 ? { scope: uniqueInOrder(scopes) } : {}),
		action: value.action,
	});
}

function parseRules(value: unknown): PolicyRule[] | undefined {
	if (value === undefined) return [];
	if (!Array.isArray(value)) return undefined;
	const rules = value.map(parseRule);
	return rules.every((rule): rule is PolicyRule => rule !== undefined) ? rules : undefined;
}

function parseApprovals(value: unknown, partial: boolean): ApprovalPolicy | Partial<ApprovalPolicy> | undefined {
	if (!isRecord(value)) return undefined;
	const keys = ["writeOutsideWorkspace", "network", "process", "filesystemRead", "filesystemWrite", "credentials", "sandbox", "mcp", "resource", "prompt", "context"];
	if (Object.keys(value).some((key) => !keys.includes(key))) return undefined;
	const result: Record<string, PolicyAction> = {};
	for (const key of keys) {
		if (value[key] === undefined) continue;
		const action = parseAction(value[key]);
		if (action === undefined) return undefined;
		result[key] = action;
	}
	if (!partial && (result.writeOutsideWorkspace === undefined || result.network === undefined || result.process === undefined)) {
		return undefined;
	}
	return result as ApprovalPolicy | Partial<ApprovalPolicy>;
}

function cloneProfile(profile: ExecutionPolicyProfile): ExecutionPolicyProfile {
	return deepFreeze({
		id: profile.id,
		...(profile.revision === undefined ? {} : { revision: profile.revision }),
		enforcement: profile.enforcement,
		...(profile.sandboxProvider === undefined ? {} : { sandboxProvider: profile.sandboxProvider }),
		defaultAction: profile.defaultAction,
		workspace: {
			read: [...profile.workspace.read],
			write: [...profile.workspace.write],
			deny: [...profile.workspace.deny],
		},
		process: {
			action: profile.process.action,
			inheritEnvironment: profile.process.inheritEnvironment,
			allowEnvironment: [...profile.process.allowEnvironment],
			...(profile.process.cwdScopes === undefined ? {} : { cwdScopes: [...profile.process.cwdScopes] }),
			...(profile.process.timeoutMs === undefined ? {} : { timeoutMs: profile.process.timeoutMs }),
		},
		network: { action: profile.network.action, allowDestinations: [...profile.network.allowDestinations] },
		credentials: { action: profile.credentials.action, allowNames: [...profile.credentials.allowNames] },
		dlp: { ...resolveDlpPolicy(profile.dlp) },
		approvals: { ...profile.approvals },
		...(profile.protectedPaths === undefined ? {} : { protectedPaths: cloneProtectedPathPolicy(profile.protectedPaths) }),
		...(profile.rules === undefined ? {} : { rules: profile.rules.map((rule) => ({ ...rule })) }),
	});
}

function parseProfile(value: unknown, expectedId?: string): ExecutionPolicyProfile | undefined {
	if (!isRecord(value)) return undefined;
	const allowedKeys = [
		"id",
		"revision",
		"enforcement",
		"sandboxProvider",
		"defaultAction",
		"workspace",
		"process",
		"network",
		"credentials",
		"dlp",
		"approvals",
		"protectedPaths",
		"rules",
	];
	if (Object.keys(value).some((key) => !allowedKeys.includes(key))) return undefined;
	if (!isSafeIdentifier(value.id) || (expectedId !== undefined && value.id !== expectedId)) return undefined;
	if (!isEnforcement(value.enforcement) || !isAction(value.defaultAction)) return undefined;
	if (value.revision !== undefined && !isSafeOpaqueId(value.revision)) return undefined;
	if (value.sandboxProvider !== undefined && !isSafeIdentifier(value.sandboxProvider)) return undefined;
	if (value.enforcement !== "sandbox" && value.sandboxProvider !== undefined) return undefined;
	if (!isRecord(value.workspace) || !isRecord(value.process) || !isRecord(value.network) || !isRecord(value.credentials)) {
		return undefined;
	}
	if (Object.keys(value.workspace).some((key) => !["read", "write", "deny"].includes(key))) return undefined;
	if (
		Object.keys(value.process).some((key) => !["action", "inheritEnvironment", "allowEnvironment", "cwdScopes", "timeoutMs"].includes(key))
	) {
		return undefined;
	}
	if (Object.keys(value.network).some((key) => !["action", "allowDestinations"].includes(key))) return undefined;
	if (Object.keys(value.credentials).some((key) => !["action", "allowNames"].includes(key))) return undefined;
	const workspaceRead = parseScopeArray(value.workspace.read);
	const workspaceWrite = parseScopeArray(value.workspace.write);
	const workspaceDeny = parseScopeArray(value.workspace.deny);
	if (workspaceRead === undefined || workspaceWrite === undefined || workspaceDeny === undefined) return undefined;
	if (workspaceRead.some((scope) => workspaceDeny.includes(scope)) || workspaceWrite.some((scope) => workspaceDeny.includes(scope))) {
		return undefined;
	}
	const processAction = parseAction(value.process.action);
	const processAllowEnvironment = parseStringArray(value.process.allowEnvironment, isEnvironmentName);
	if (processAction === undefined || processAllowEnvironment === undefined || typeof value.process.inheritEnvironment !== "boolean") {
		return undefined;
	}
	const cwdScopes = value.process.cwdScopes === undefined ? undefined : parseScopeArray(value.process.cwdScopes);
	if (value.process.cwdScopes !== undefined && cwdScopes === undefined) return undefined;
	const processTimeoutMs = value.process.timeoutMs;
	if (processTimeoutMs !== undefined && !isPositiveInteger(processTimeoutMs)) {
		return undefined;
	}
	const networkAction = parseAction(value.network.action);
	const networkDestinations = parseStringArray(value.network.allowDestinations, isNetworkDestinationPattern);
	const credentialsAction = parseAction(value.credentials.action);
	const credentialNames = parseStringArray(value.credentials.allowNames, isTaskCredentialIdentifier);
	if (networkAction === undefined || networkDestinations === undefined || credentialsAction === undefined || credentialNames === undefined) {
		return undefined;
	}
	const approvals = parseApprovals(value.approvals, false);
	if (approvals === undefined) return undefined;
	const completeApprovals = approvals as ApprovalPolicy;
	const dlp = parseDlpPolicy(value.dlp, false);
	if (dlp === undefined) return undefined;
	const rules = parseRules(value.rules);
	if (rules === undefined) return undefined;
	const protectedPaths = value.protectedPaths === undefined ? undefined : parseProtectedPathPolicy(value.protectedPaths);
	if (value.protectedPaths !== undefined && protectedPaths === undefined) return undefined;
	return cloneProfile({
		id: value.id,
		...(value.revision === undefined ? {} : { revision: value.revision }),
		enforcement: value.enforcement,
		...(value.sandboxProvider === undefined ? {} : { sandboxProvider: value.sandboxProvider }),
		defaultAction: value.defaultAction,
		workspace: { read: workspaceRead, write: workspaceWrite, deny: workspaceDeny },
		process: {
			action: processAction,
			inheritEnvironment: value.process.inheritEnvironment,
			allowEnvironment: processAllowEnvironment,
			...(cwdScopes === undefined ? {} : { cwdScopes }),
			...(processTimeoutMs === undefined ? {} : { timeoutMs: processTimeoutMs }),
		},
		network: { action: networkAction, allowDestinations: networkDestinations },
		credentials: { action: credentialsAction, allowNames: credentialNames },
		dlp: dlp as DlpPolicy,
		approvals: completeApprovals,
		...(protectedPaths === undefined ? {} : { protectedPaths }),
		...(rules.length > 0 ? { rules } : {}),
	});
}

function parseNarrowing(value: unknown): PolicyProfileNarrowing | undefined {
	if (!isRecord(value)) return undefined;
	const allowed = ["id", "revision", "enforcement", "sandboxProvider", "defaultAction", "workspace", "process", "network", "credentials", "dlp", "approvals", "protectedPaths", "rules"];
	if (Object.keys(value).some((key) => !allowed.includes(key))) return undefined;
	if (value.id !== undefined && !isSafeOpaqueId(value.id)) return undefined;
	if (value.revision !== undefined && !isSafeOpaqueId(value.revision)) return undefined;
	if (value.enforcement !== undefined && !isEnforcement(value.enforcement)) return undefined;
	if (value.sandboxProvider !== undefined && !isSafeIdentifier(value.sandboxProvider)) return undefined;
	if (value.defaultAction !== undefined && !isAction(value.defaultAction)) return undefined;
	const workspace: { read?: WorkspaceScope[]; write?: WorkspaceScope[]; deny?: WorkspaceScope[] } = {};
	if (value.workspace !== undefined) {
		if (!isRecord(value.workspace)) return undefined;
		if (Object.keys(value.workspace).some((key) => !["read", "write", "deny"].includes(key))) return undefined;
		if (value.workspace.read !== undefined) {
			const read = parseScopeArray(value.workspace.read);
			if (read === undefined) return undefined;
			workspace.read = read;
		}
		if (value.workspace.write !== undefined) {
			const write = parseScopeArray(value.workspace.write);
			if (write === undefined) return undefined;
			workspace.write = write;
		}
		if (value.workspace.deny !== undefined) {
			const deny = parseScopeArray(value.workspace.deny);
			if (deny === undefined) return undefined;
			workspace.deny = deny;
		}
	}
	const process: {
		action?: PolicyAction;
		inheritEnvironment?: boolean;
		allowEnvironment?: string[];
		cwdScopes?: WorkspaceScope[];
		timeoutMs?: number;
	} = {};
	if (value.process !== undefined) {
		if (!isRecord(value.process)) return undefined;
		if (
			Object.keys(value.process).some((key) => !["action", "inheritEnvironment", "allowEnvironment", "cwdScopes", "timeoutMs"].includes(key))
		) {
			return undefined;
		}
		if (value.process.action !== undefined) {
			const action = parseAction(value.process.action);
			if (action === undefined) return undefined;
			process.action = action;
		}
		if (value.process.inheritEnvironment !== undefined) {
			if (typeof value.process.inheritEnvironment !== "boolean") return undefined;
			process.inheritEnvironment = value.process.inheritEnvironment;
		}
		if (value.process.allowEnvironment !== undefined) {
			const names = parseStringArray(value.process.allowEnvironment, isEnvironmentName);
			if (names === undefined) return undefined;
			process.allowEnvironment = names;
		}
		if (value.process.cwdScopes !== undefined) {
			const scopes = parseScopeArray(value.process.cwdScopes);
			if (scopes === undefined) return undefined;
			process.cwdScopes = scopes;
		}
		const timeoutMs = value.process.timeoutMs;
		if (timeoutMs !== undefined) {
			if (!isPositiveInteger(timeoutMs)) return undefined;
			process.timeoutMs = timeoutMs;
		}
	}
	const network: { action?: PolicyAction; allowDestinations?: string[] } = {};
	if (value.network !== undefined) {
		if (!isRecord(value.network)) return undefined;
		if (Object.keys(value.network).some((key) => !["action", "allowDestinations"].includes(key))) return undefined;
		if (value.network.action !== undefined) {
			const action = parseAction(value.network.action);
			if (action === undefined) return undefined;
			network.action = action;
		}
		if (value.network.allowDestinations !== undefined) {
			const destinations = parseStringArray(value.network.allowDestinations, isNetworkDestinationPattern);
			if (destinations === undefined) return undefined;
			network.allowDestinations = destinations;
		}
	}
	const credentials: { action?: PolicyAction; allowNames?: string[] } = {};
	if (value.credentials !== undefined) {
		if (!isRecord(value.credentials)) return undefined;
		if (Object.keys(value.credentials).some((key) => !["action", "allowNames"].includes(key))) return undefined;
		if (value.credentials.action !== undefined) {
			const action = parseAction(value.credentials.action);
			if (action === undefined) return undefined;
			credentials.action = action;
		}
		if (value.credentials.allowNames !== undefined) {
			const names = parseStringArray(value.credentials.allowNames, isTaskCredentialIdentifier);
			if (names === undefined) return undefined;
			credentials.allowNames = names;
		}
	}
	const dlp = parseDlpPolicy(value.dlp, true);
	if (dlp === undefined) return undefined;
	const approvals = value.approvals === undefined ? undefined : parseApprovals(value.approvals, true);
	if (value.approvals !== undefined && approvals === undefined) return undefined;
	const protectedPaths = value.protectedPaths === undefined ? undefined : parseProtectedPathPolicy(value.protectedPaths);
	if (value.protectedPaths !== undefined && protectedPaths === undefined) return undefined;
	const rules = value.rules === undefined ? undefined : parseRules(value.rules);
	if (value.rules !== undefined && rules === undefined) return undefined;
	return {
		...(value.id === undefined ? {} : { id: value.id }),
		...(value.revision === undefined ? {} : { revision: value.revision }),
		...(value.enforcement === undefined ? {} : { enforcement: value.enforcement }),
		...(value.sandboxProvider === undefined ? {} : { sandboxProvider: value.sandboxProvider }),
		...(value.defaultAction === undefined ? {} : { defaultAction: value.defaultAction }),
		...(Object.keys(workspace).length === 0 ? {} : { workspace }),
		...(Object.keys(process).length === 0 ? {} : { process }),
		...(Object.keys(network).length === 0 ? {} : { network }),
		...(Object.keys(credentials).length === 0 ? {} : { credentials }),
		...(Object.keys(dlp).length === 0 ? {} : { dlp }),
		...(approvals === undefined ? {} : { approvals }),
		...(protectedPaths === undefined ? {} : { protectedPaths }),
		...(rules === undefined ? {} : { rules }),
	};
}

function parseProfiles(input: Readonly<Record<string, unknown>> | undefined):
	| { ok: true; profiles: ReadonlyMap<string, ExecutionPolicyProfile> }
	| { ok: false; error: PolicyError } {
	const result = new Map<string, ExecutionPolicyProfile>();
	for (const [id, value] of Object.entries(input ?? {})) {
		if (!isSafeIdentifier(id)) return invalid();
		const profile = parseProfile(value, id);
		if (profile === undefined) return invalid();
		result.set(id, profile);
	}
	return { ok: true, profiles: result };
}

function profileRevision(profile: ExecutionPolicyProfile, narrowing?: PolicyProfileNarrowing): string {
	if (profile.revision !== undefined && narrowing === undefined) return profile.revision;
	const source = stableStringify({ profile, narrowing: narrowing ?? null });
	return `rev:${hashText(source)}`;
}

function stableStringify(value: unknown): string {
	if (value === null) return "null";
	if (typeof value === "string") return JSON.stringify(value);
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
	if (typeof value === "object") {
		const record = value as Record<string, unknown>;
		return `{${Object.keys(record)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
			.join(",")}}`;
	}
	return "undefined";
}

function hashText(value: string): string {
	let hash = 2166136261;
	for (let index = 0; index < value.length; index++) {
		hash ^= value.charCodeAt(index);
		hash = Math.imul(hash, 16777619);
	}
	return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Derive the opaque workspace identity used by strict provider bindings.
 * Callers must provide a canonical host path; the path itself never enters a
 * binding, ledger entry, public summary, or RPC response.
 */
export function createWorkspaceIdentity(canonicalWorkspacePath: string): string {
	return `workspace:${hashText(canonicalWorkspacePath)}`;
}

function arraySubset(requested: ReadonlyArray<string>, allowed: ReadonlyArray<string>): boolean {
	const allowedSet = new Set(allowed);
	return requested.every((value) => allowedSet.has(value));
}

function mergeNarrowing(
	base: ExecutionPolicyProfile,
	narrowing: PolicyProfileNarrowing,
): { ok: true; profile: ExecutionPolicyProfile } | { ok: false; error: PolicyError } {
	if (narrowing.id !== undefined && narrowing.id !== base.id) return { ok: false, error: policyError("policy_profile_untrusted") };
	if (
		narrowing.sandboxProvider !== undefined &&
		narrowing.sandboxProvider !== base.sandboxProvider
	) {
		return { ok: false, error: policyError("policy_profile_untrusted") };
	}
	if (narrowing.enforcement !== undefined && ENFORCEMENT_RANK[narrowing.enforcement] < ENFORCEMENT_RANK[base.enforcement]) {
		return { ok: false, error: policyError("policy_profile_untrusted") };
	}
	if (narrowing.defaultAction !== undefined && ACTION_RANK[narrowing.defaultAction] < ACTION_RANK[base.defaultAction]) {
		return { ok: false, error: policyError("policy_profile_untrusted") };
	}
	if (narrowing.process?.action !== undefined && ACTION_RANK[narrowing.process.action] < ACTION_RANK[base.process.action]) {
		return { ok: false, error: policyError("policy_profile_untrusted") };
	}
	if (narrowing.network?.action !== undefined && ACTION_RANK[narrowing.network.action] < ACTION_RANK[base.network.action]) {
		return { ok: false, error: policyError("policy_profile_untrusted") };
	}
	if (
		narrowing.credentials?.action !== undefined &&
		ACTION_RANK[narrowing.credentials.action] < ACTION_RANK[base.credentials.action]
	) {
		return { ok: false, error: policyError("policy_profile_untrusted") };
	}
	const baseDlp = resolveDlpPolicy(base.dlp);
	const DLP_ACTION_RANK: Readonly<Record<DlpPolicyAction, number>> = { warn: 0, redact: 1, deny: 2 };
	if (narrowing.dlp?.enabled === false && baseDlp.enabled) {
		return { ok: false, error: policyError("policy_profile_untrusted") };
	}
	if (
		narrowing.dlp?.action !== undefined &&
		DLP_ACTION_RANK[narrowing.dlp.action] < DLP_ACTION_RANK[baseDlp.action]
	) {
		return { ok: false, error: policyError("policy_profile_untrusted") };
	}
	if (narrowing.approvals !== undefined) {
		const approvalPairs: ReadonlyArray<[PolicyAction, PolicyAction | undefined]> = [
			[base.approvals.writeOutsideWorkspace, narrowing.approvals.writeOutsideWorkspace],
			[base.approvals.network, narrowing.approvals.network],
			[base.approvals.process, narrowing.approvals.process],
			[base.approvals.filesystemRead ?? "allow", narrowing.approvals.filesystemRead],
			[base.approvals.filesystemWrite ?? "allow", narrowing.approvals.filesystemWrite],
			[base.approvals.credentials ?? "allow", narrowing.approvals.credentials],
			[base.approvals.sandbox ?? "allow", narrowing.approvals.sandbox],
			[base.approvals.mcp ?? "allow", narrowing.approvals.mcp],
			[base.approvals.resource ?? "allow", narrowing.approvals.resource],
			[base.approvals.prompt ?? "allow", narrowing.approvals.prompt],
			[base.approvals.context ?? "allow", narrowing.approvals.context],
		];
		if (approvalPairs.some(([baseAction, requestedAction]) => requestedAction !== undefined && ACTION_RANK[requestedAction] < ACTION_RANK[baseAction])) {
			return { ok: false, error: policyError("policy_profile_untrusted") };
		}
	}
	let protectedPaths = base.protectedPaths;
	if (narrowing.protectedPaths !== undefined) {
		if ((narrowing.protectedPaths.managedLocks?.length ?? 0) > 0) {
			return { ok: false, error: policyError("policy_profile_untrusted") };
		}
		protectedPaths = narrowProtectedPathPolicy(base.protectedPaths, narrowing.protectedPaths);
		if (protectedPaths === undefined) return { ok: false, error: policyError("policy_profile_untrusted") };
	}
	if (base.process.inheritEnvironment === false && narrowing.process?.inheritEnvironment === true) {
		return { ok: false, error: policyError("policy_profile_untrusted") };
	}
	if (narrowing.workspace?.read !== undefined && !arraySubset(narrowing.workspace.read, base.workspace.read)) {
		return { ok: false, error: policyError("policy_profile_untrusted") };
	}
	if (narrowing.workspace?.write !== undefined && !arraySubset(narrowing.workspace.write, base.workspace.write)) {
		return { ok: false, error: policyError("policy_profile_untrusted") };
	}
	if (narrowing.workspace?.deny !== undefined && !arraySubset(base.workspace.deny, narrowing.workspace.deny)) {
		// A project may add deny scopes, but it cannot remove a user deny.
		return { ok: false, error: policyError("policy_profile_untrusted") };
	}
	if (
		narrowing.process?.allowEnvironment !== undefined &&
		!arraySubset(narrowing.process.allowEnvironment, base.process.allowEnvironment) &&
		!base.process.inheritEnvironment
	) {
		return { ok: false, error: policyError("policy_profile_untrusted") };
	}
	if (
		narrowing.process?.cwdScopes !== undefined &&
		base.process.cwdScopes !== undefined &&
		!arraySubset(narrowing.process.cwdScopes, base.process.cwdScopes)
	) {
		return { ok: false, error: policyError("policy_profile_untrusted") };
	}
	if (
		narrowing.process?.timeoutMs !== undefined &&
		base.process.timeoutMs !== undefined &&
		narrowing.process.timeoutMs > base.process.timeoutMs
	) {
		return { ok: false, error: policyError("policy_profile_untrusted") };
	}
	if (
		narrowing.network?.allowDestinations !== undefined &&
		((base.network.allowDestinations.length === 0 && base.network.action !== "allow" && narrowing.network.allowDestinations.length > 0) ||
			(base.network.allowDestinations.length > 0 &&
				!networkPatternsSubset(narrowing.network.allowDestinations, base.network.allowDestinations)))
	) {
		return { ok: false, error: policyError("policy_profile_untrusted") };
	}
	if (
		narrowing.credentials?.allowNames !== undefined &&
		base.credentials.allowNames.length > 0 &&
		!arraySubset(narrowing.credentials.allowNames, base.credentials.allowNames)
	) {
		return { ok: false, error: policyError("policy_profile_untrusted") };
	}
	// A project cannot introduce a second rule layer. It can
	// narrow declarative fields, but rules are selected from registered profiles.
	if (narrowing.rules !== undefined && narrowing.rules.length > 0) {
		return { ok: false, error: policyError("policy_profile_untrusted") };
	}
	const workspace = {
		read: narrowing.workspace?.read ?? base.workspace.read,
		write: narrowing.workspace?.write ?? base.workspace.write,
		deny: uniqueInOrder([...base.workspace.deny, ...(narrowing.workspace?.deny ?? [])]),
	};
	const process: ProcessPolicy = {
		action: strictest(base.process.action, narrowing.process?.action ?? base.process.action),
		inheritEnvironment: base.process.inheritEnvironment && (narrowing.process?.inheritEnvironment ?? true),
		allowEnvironment: narrowing.process?.allowEnvironment ?? base.process.allowEnvironment,
		...(narrowing.process?.cwdScopes !== undefined
			? { cwdScopes: narrowing.process.cwdScopes }
			: base.process.cwdScopes === undefined
				? {}
				: { cwdScopes: base.process.cwdScopes }),
		...(narrowing.process?.timeoutMs !== undefined
			? { timeoutMs: narrowing.process.timeoutMs }
			: base.process.timeoutMs === undefined
				? {}
				: { timeoutMs: base.process.timeoutMs }),
	};
	const network: NetworkPolicy = {
		action: strictest(base.network.action, narrowing.network?.action ?? base.network.action),
		allowDestinations: narrowing.network?.allowDestinations ?? base.network.allowDestinations,
	};
	const credentials: CredentialPolicy = {
		action: strictest(base.credentials.action, narrowing.credentials?.action ?? base.credentials.action),
		allowNames: narrowing.credentials?.allowNames ?? base.credentials.allowNames,
	};
	const dlp: DlpPolicy = {
		enabled: baseDlp.enabled || narrowing.dlp?.enabled === true,
		action: narrowing.dlp?.action === undefined || DLP_ACTION_RANK[baseDlp.action] >= DLP_ACTION_RANK[narrowing.dlp.action]
			? baseDlp.action
			: narrowing.dlp.action,
	};
	const baseApprovals = base.approvals;
	const requestedApprovals = narrowing.approvals ?? {};
	const approvals: ApprovalPolicy = {
		writeOutsideWorkspace: strictest(
			baseApprovals.writeOutsideWorkspace,
			requestedApprovals.writeOutsideWorkspace ?? baseApprovals.writeOutsideWorkspace,
		),
		network: strictest(baseApprovals.network, requestedApprovals.network ?? baseApprovals.network),
		process: strictest(baseApprovals.process, requestedApprovals.process ?? baseApprovals.process),
		...(baseApprovals.filesystemRead !== undefined || requestedApprovals.filesystemRead !== undefined
			? { filesystemRead: strictest(baseApprovals.filesystemRead ?? "allow", requestedApprovals.filesystemRead ?? baseApprovals.filesystemRead ?? "allow") }
			: {}),
		...(baseApprovals.filesystemWrite !== undefined || requestedApprovals.filesystemWrite !== undefined
			? { filesystemWrite: strictest(baseApprovals.filesystemWrite ?? "allow", requestedApprovals.filesystemWrite ?? baseApprovals.filesystemWrite ?? "allow") }
			: {}),
		...(baseApprovals.credentials !== undefined || requestedApprovals.credentials !== undefined
			? { credentials: strictest(baseApprovals.credentials ?? "allow", requestedApprovals.credentials ?? baseApprovals.credentials ?? "allow") }
			: {}),
		...(baseApprovals.sandbox !== undefined || requestedApprovals.sandbox !== undefined
			? { sandbox: strictest(baseApprovals.sandbox ?? "allow", requestedApprovals.sandbox ?? baseApprovals.sandbox ?? "allow") }
			: {}),
		...(baseApprovals.mcp !== undefined || requestedApprovals.mcp !== undefined
			? { mcp: strictest(baseApprovals.mcp ?? "allow", requestedApprovals.mcp ?? baseApprovals.mcp ?? "allow") }
			: {}),
		...(baseApprovals.resource !== undefined || requestedApprovals.resource !== undefined
			? { resource: strictest(baseApprovals.resource ?? "allow", requestedApprovals.resource ?? baseApprovals.resource ?? "allow") }
			: {}),
		...(baseApprovals.prompt !== undefined || requestedApprovals.prompt !== undefined
			? { prompt: strictest(baseApprovals.prompt ?? "allow", requestedApprovals.prompt ?? baseApprovals.prompt ?? "allow") }
			: {}),
		...(baseApprovals.context !== undefined || requestedApprovals.context !== undefined
			? { context: strictest(baseApprovals.context ?? "allow", requestedApprovals.context ?? baseApprovals.context ?? "allow") }
			: {}),
	};
	return {
		ok: true,
		profile: cloneProfile({
			id: base.id,
			revision: profileRevision(base, narrowing),
			enforcement: strictestEnforcement(base.enforcement, narrowing.enforcement ?? base.enforcement),
			...(base.sandboxProvider === undefined ? {} : { sandboxProvider: base.sandboxProvider }),
			defaultAction: strictest(base.defaultAction, narrowing.defaultAction ?? base.defaultAction),
			workspace,
			process,
			network,
			credentials,
			dlp,
			approvals,
			...(protectedPaths === undefined ? {} : { protectedPaths }),
			...(base.rules === undefined ? {} : { rules: base.rules }),
		}),
	};
}

function projectTrust(input: ResolveExecutionPolicyInput, projectProvided: boolean): PolicyTrust {
	if (input.projectTrust !== undefined) return input.projectTrust;
	if (input.projectTrusted !== undefined) return input.projectTrusted ? "trusted" : "untrusted";
	if (input.project?.trust !== undefined) return input.project.trust;
	if (input.project?.trusted !== undefined) return input.project.trusted ? "trusted" : "untrusted";
	return projectProvided ? "untrusted" : "trusted";
}

function getProjectInput(input: ResolveExecutionPolicyInput): PolicyProjectInput | undefined {
	if (input.project !== undefined) return input.project;
	if (input.projectProfile !== undefined || input.projectProfileId !== undefined) {
		return { profile: input.projectProfile, profileId: input.projectProfileId };
	}
	return undefined;
}

function normalizeOpaqueIdentity(value: unknown, fallback: string): string | undefined {
	if (value === undefined) return fallback;
	return isSafeOpaqueId(value) ? value : undefined;
}

function normalizeSandbox(profile: ExecutionPolicyProfile, input: ResolveExecutionPolicyInput): {
	status: SandboxStatus;
	capabilities: SandboxCapabilities;
	providerId?: string;
} {
	const empty: SandboxCapabilities = { filesystem: false, process: false, network: false, credentialIsolation: false };
	if (profile.enforcement !== "sandbox") return { status: "not_required", capabilities: empty };
	const preflight = input.sandbox;
	const configured = preflight?.configured ?? preflight?.providerConfigured ?? false;
	if (profile.sandboxProvider === undefined || !configured) return { status: "unavailable", capabilities: empty };
	const providerId = preflight?.providerId ?? profile.sandboxProvider;
	const statusValue = preflight?.status ?? preflight?.providerStatus ?? "unavailable";
	const status = isSandboxStatus(statusValue) ? statusValue : "unavailable";
	const capabilities = preflight?.capabilities ?? preflight?.providerCapabilities ?? empty;
	if (preflight?.providerCapabilitiesComplete === false) return { status, capabilities: empty, providerId };
	return { status, capabilities, providerId };
}

function validCapabilityBinding(value: CapabilityBindingInput | undefined): boolean {
	if (value === undefined) return true;
	if (value.id !== undefined && !isSafeOpaqueId(value.id)) return false;
	if (value.descriptors?.some((descriptor) => !isRecord(descriptor) || !isSafeOpaqueId(descriptor.id))) {
		return false;
	}
	for (const ids of [value.allowedCapabilityIds, value.deniedCapabilityIds]) {
		if (ids !== undefined && (!Array.isArray(ids) || !ids.every(isSafeOpaqueId))) return false;
	}
	for (const resources of [value.allowedResources, value.deniedResources]) {
		if (resources !== undefined && (!Array.isArray(resources) || !resources.every(isResource))) return false;
	}
	for (const targets of [value.allowedTargetIds, value.deniedTargetIds]) {
		if (targets !== undefined && (!Array.isArray(targets) || !targets.every(isSafeOpaqueId))) return false;
	}
	return value.allowed === undefined || typeof value.allowed === "boolean";
}

function validSandboxPreflight(value: SandboxPreflight | undefined): boolean {
	if (value === undefined) return true;
	for (const flag of [value.configured, value.providerConfigured, value.providerCapabilitiesComplete]) {
		if (flag !== undefined && typeof flag !== "boolean") return false;
	}
	if (value.providerId !== undefined && !isSafeIdentifier(value.providerId)) return false;
	for (const status of [value.status, value.providerStatus]) {
		if (status !== undefined && !isSandboxStatus(status)) return false;
	}
	for (const capabilities of [value.capabilities, value.providerCapabilities]) {
		if (
			capabilities !== undefined &&
			(!isRecord(capabilities) ||
				typeof capabilities.filesystem !== "boolean" ||
				typeof capabilities.process !== "boolean" ||
				typeof capabilities.network !== "boolean" ||
				typeof capabilities.credentialIsolation !== "boolean" ||
				(capabilities.credentialDelivery !== undefined && typeof capabilities.credentialDelivery !== "boolean"))
		) {
			return false;
		}
	}
	return true;
}

function createBinding(
	profile: ExecutionPolicyProfile,
	trust: PolicyTrust,
	input: ResolveExecutionPolicyInput,
	capabilityBinding: CapabilityBindingInput | undefined,
): PolicyBinding {
	const sandbox = normalizeSandbox(profile, input);
	const sandboxCapabilities: SandboxCapabilities = { ...sandbox.capabilities };
	const runId = normalizeOpaqueIdentity(input.runId, "run:unbound");
	const workspaceIdentity = normalizeOpaqueIdentity(input.workspaceIdentity, "workspace:opaque");
	const previousPolicyBindingId =
		input.previousPolicyBindingId === undefined
			? undefined
			: normalizeOpaqueIdentity(input.previousPolicyBindingId, "");
	if (runId === undefined || workspaceIdentity === undefined || (input.previousPolicyBindingId !== undefined && previousPolicyBindingId === undefined)) {
		throw policyError("policy_binding_failed");
	}
	const createdAt = input.createdAt ?? "1970-01-01T00:00:00.000Z";
	if (!isCanonicalPolicyTimestamp(createdAt)) throw policyError("policy_binding_failed");
	const constraints: PolicyBindingConstraints = {
		workspace: {
			read: [...profile.workspace.read],
			write: [...profile.workspace.write],
			deny: [...profile.workspace.deny],
		},
		process: {
			action: profile.process.action,
			inheritEnvironment: profile.process.inheritEnvironment,
			allowedEnvironmentCount: profile.process.allowEnvironment.length,
			...(profile.process.cwdScopes === undefined ? {} : { cwdScopes: [...profile.process.cwdScopes] }),
		},
		network: { action: profile.network.action, allowedDestinationCount: profile.network.allowDestinations.length },
		credentials: { action: profile.credentials.action, allowedNameCount: profile.credentials.allowNames.length },
		...(profile.protectedPaths === undefined
			? {}
			: {
				protectedPaths: {
					ruleCount: profile.protectedPaths.rules.length,
					managedLockCount: profile.protectedPaths.managedLocks?.length ?? 0,
					policyDigest: calculateProtectedPathPolicyDigest(profile.protectedPaths),
				},
			}),
	};
	const bindingSeed = {
		profileId: profile.id,
		profileRevision: profileRevision(profile),
		projectTrust: trust,
		capabilityBindingId: capabilityBinding?.id,
		enforcement: profile.enforcement,
		sandboxProviderId: sandbox.providerId,
		sandboxStatus: sandbox.status,
		sandboxCapabilities,
		runId,
		createdAt,
		previousPolicyBindingId,
		workspaceIdentity,
		constraints,
	};
	const bindingHash = `digest:${hashText(stableStringify(bindingSeed))}`;
	const id = input.bindingId ?? `${POLICY_BINDING_PREFIX}${hashText(stableStringify({ ...bindingSeed, bindingHash }))}`;
	if (!isSafeOpaqueId(id)) {
		throw policyError("policy_binding_failed");
	}
	return deepFreeze({
		schemaVersion: EXECUTION_POLICY_SCHEMA_VERSION,
		id,
		profileId: profile.id,
		profileRevision: profileRevision(profile),
		projectTrust: trust,
		...(capabilityBinding?.id === undefined ? {} : { capabilityBindingId: capabilityBinding.id }),
		enforcement: profile.enforcement,
		...(sandbox.providerId === undefined)
			? {}
			: { sandboxProviderId: sandbox.providerId },
		sandboxCapabilities,
		sandboxStatus: sandbox.status,
		runId,
		createdAt,
		...(previousPolicyBindingId === undefined ? {} : { previousPolicyBindingId }),
		workspaceIdentity,
		constraints,
		bindingHash,
	});
}

function ruleMatches(rule: PolicyRule, operation: PolicyOperationRequest): boolean {
	const resources = rule.resource === undefined ? [] : Array.isArray(rule.resource) ? rule.resource : [rule.resource];
	const allResources = [...resources, ...(rule.resources ?? [])];
	if (!allResources.includes(operation.resource)) return false;
	const sources = rule.source === undefined ? [] : Array.isArray(rule.source) ? rule.source : [rule.source];
	const allSources = [...sources, ...(rule.sources ?? [])];
	if (allSources.length > 0 && !allSources.includes(operation.source)) return false;
	const scopes = rule.scope === undefined ? [] : Array.isArray(rule.scope) ? rule.scope : [rule.scope];
	const allScopes = [...scopes, ...(rule.scopes ?? [])];
	return allScopes.length === 0 || (operation.scope !== undefined && allScopes.includes(operation.scope));
}

function ruleAction(profile: ExecutionPolicyProfile, operation: PolicyOperationRequest): PolicyAction {
	let action = defaultResourceAction(profile, operation);
	for (const rule of profile.rules ?? []) {
		if (ruleMatches(rule, operation)) action = rule.action;
	}
	return action;
}

function defaultResourceAction(profile: ExecutionPolicyProfile, operation: PolicyOperationRequest): PolicyAction {
	switch (operation.resource) {
		case "process.spawn":
			return profile.process.action;
		case "network.connect":
			return profile.network.allowDestinations.length > 0 &&
				networkDestinationAllowed(operation.destination, operation.port, profile.network.allowDestinations) &&
				profile.network.action === "deny"
				? "allow"
				: profile.network.action;
		case "credential.expose":
		case "credential.task.issue":
		case "credential.task.renew":
		case "credential.task.project":
		case "credential.task.revoke":
			return profile.credentials.action;
		default:
			return profile.defaultAction;
	}
}

function approvalAction(profile: ExecutionPolicyProfile, operation: PolicyOperationRequest): PolicyAction | undefined {
		switch (operation.resource) {
		case "filesystem.read":
		case "filesystem.find":
		case "filesystem.grep":
			return profile.approvals.filesystemRead;
		case "filesystem.write":
			return operation.scope !== "workspace"
				? (profile.approvals.filesystemWrite ?? profile.approvals.writeOutsideWorkspace)
				: profile.approvals.filesystemWrite;
		case "network.connect":
			return profile.approvals.network;
		case "process.spawn":
			return profile.approvals.process;
		case "credential.expose":
		case "credential.task.issue":
		case "credential.task.renew":
		case "credential.task.project":
		case "credential.task.revoke":
			return profile.approvals.credentials;
		case "sandbox.prepare":
			return profile.approvals.sandbox;
		case "mcp.auth":
			return profile.approvals.mcp;
		case "resource.list":
		case "resource.read":
			return profile.approvals.resource;
		case "prompt.list":
		case "prompt.get":
			return profile.approvals.prompt;
		case "context.attach":
			return profile.approvals.context;
		default:
			return undefined;
	}
}

function capabilityDecision(
	operation: PolicyOperationRequest,
	capability: CapabilityBindingInput | undefined,
): PolicyErrorCode | undefined {
	if (capability === undefined) return undefined;
	if (capability.trusted === false) return "policy_profile_untrusted";
	if (capability.allowed === false) return "policy_denied";
	if (capability.deniedResources?.includes(operation.resource)) return "policy_denied";
	if (capability.allowedResources !== undefined && !capability.allowedResources.includes(operation.resource)) return "policy_denied";
	if (
		operation.resource === "capability.invoke" &&
		(operation.source === "mcp" || operation.source === "extension") &&
		capability.descriptors !== undefined &&
		operation.capabilityId === undefined
	) {
		return "policy_denied";
	}
	if (operation.capabilityId !== undefined) {
		if (capability.deniedCapabilityIds?.includes(operation.capabilityId)) return "policy_denied";
		if (capability.allowedCapabilityIds !== undefined && !capability.allowedCapabilityIds.includes(operation.capabilityId)) {
			return "policy_denied";
		}
		if (capability.descriptors !== undefined && !capability.descriptors.some((descriptor) => descriptor.id === operation.capabilityId)) {
			return "policy_denied";
		}
	}
	if (operation.targetId !== undefined) {
		// The capability binding declares the credential target: a target that
		// is denied or outside the declared allowlist is a hard deny.
		if (capability.deniedTargetIds?.includes(operation.targetId)) return "policy_denied";
		if (capability.allowedTargetIds !== undefined && !capability.allowedTargetIds.includes(operation.targetId)) {
			return "policy_denied";
		}
	}
	return undefined;
}

function requiredSandboxCapability(resource: PolicyResource): keyof SandboxCapabilities | undefined {
		switch (resource) {
		case "filesystem.read":
		case "filesystem.write":
		case "filesystem.find":
		case "filesystem.grep":
			return "filesystem";
		case "process.spawn":
			return "process";
		case "network.connect":
			return "network";
		case "credential.expose":
		case "credential.task.issue":
		case "credential.task.renew":
		case "credential.task.project":
		case "credential.task.revoke":
			return "credentialIsolation";
		case "capability.invoke":
		case "sandbox.prepare":
		case "mcp.auth":
		case "resource.list":
		case "resource.read":
		case "prompt.list":
		case "prompt.get":
		case "context.attach":
			// MCP auth and content operations execute in the host client, not inside
			// the sandbox, so no sandbox capability is required for them.
			return undefined;
	}
}

function requiredSandboxCapabilities(resource: PolicyResource): ReadonlyArray<keyof SandboxCapabilities> {
	if (resource === "capability.invoke") return ["filesystem", "process", "network", "credentialIsolation"];
	if (resource === "credential.task.renew" || resource === "credential.task.project" || resource === "credential.task.revoke") {
		// Delivery, renewal, and revocation move material inside the target, so
		// they additionally need the sandbox's declared credential delivery
		// capability; issuance only needs isolation.
		return ["credentialIsolation", "credentialDelivery"];
	}
	const required = requiredSandboxCapability(resource);
	return required === undefined ? [] : [required];
}

function operationBoundaryReason(profile: ExecutionPolicyProfile, operation: PolicyOperationRequest): PolicyErrorCode | undefined {
	if (
		operation.resource === "filesystem.read" ||
		operation.resource === "filesystem.write" ||
		operation.resource === "filesystem.find" ||
		operation.resource === "filesystem.grep"
	) {
		if (operation.scope === undefined && profile.enforcement !== "legacy") return "workspace_boundary_violation";
		if (operation.scope !== undefined && profile.workspace.deny.includes(operation.scope)) return "workspace_boundary_violation";
		const allowedScopes = operation.resource === "filesystem.write" ? profile.workspace.write : profile.workspace.read;
		if (operation.scope !== undefined && allowedScopes.length > 0 && !allowedScopes.includes(operation.scope)) {
			return "workspace_boundary_violation";
		}
	}
	if (operation.resource === "process.spawn") {
		if (profile.process.cwdScopes !== undefined && (operation.scope === undefined || !profile.process.cwdScopes.includes(operation.scope))) {
			return "workspace_boundary_violation";
		}
		if (!profile.process.inheritEnvironment) {
			const names = operation.environmentNames ?? [];
			if (names.some((name) => !profile.process.allowEnvironment.includes(name))) return "policy_denied";
		}
	}
	if (operation.resource === "network.connect" && profile.network.allowDestinations.length > 0) {
		if (!networkDestinationAllowed(operation.destination, operation.port, profile.network.allowDestinations)) {
			return "network_policy_violation";
		}
	}
	// The credential boundary covers both host-side exposure and the Task
	// Credential lifecycle resources: every credential-scoped operation must
	// name at least one credential and every name must be inside the profile
	// allowlist, and a non-legacy profile with an empty allowlist denies all
	// credential-scoped operations (an empty allowlist never means "all").
	const credentialScoped =
		operation.resource === "credential.expose" || isTaskCredentialPolicyResource(operation.resource);
	if (credentialScoped && profile.credentials.allowNames.length > 0) {
		const names = operation.credentialNames ?? [];
		if (names.length === 0 || names.some((name) => !profile.credentials.allowNames.includes(name))) {
			return "credential_policy_violation";
		}
	}
	if (credentialScoped && profile.enforcement !== "legacy" && profile.credentials.allowNames.length === 0) {
		return "credential_policy_violation";
	}
	return undefined;
}

function sandboxDecision(
	profile: ExecutionPolicyProfile,
	binding: PolicyBinding,
	operation: PolicyOperationRequest,
): { outcome?: PolicyDecisionOutcome; reasonCode?: PolicyErrorCode; hardDeny: boolean } {
	if (operation.requiresSandbox === true) {
		if (
			operation.sandboxed !== true ||
			binding.sandboxProviderId === undefined ||
			operation.sandboxProviderId !== binding.sandboxProviderId
		) {
			return { outcome: "sandbox_required", reasonCode: "sandbox_required", hardDeny: true };
		}
		if (binding.sandboxStatus !== "ready") {
			return { outcome: "deny", reasonCode: "sandbox_unavailable", hardDeny: true };
		}
		if (
			!binding.sandboxCapabilities.filesystem ||
			!binding.sandboxCapabilities.process ||
			!binding.sandboxCapabilities.network
		) {
			return { outcome: "deny", reasonCode: "sandbox_capability_insufficient", hardDeny: true };
		}
	}
	if (profile.enforcement !== "sandbox") return { hardDeny: false };
	if (profile.sandboxProvider === undefined || binding.sandboxProviderId === undefined) {
		return { outcome: "sandbox_required", reasonCode: "sandbox_required", hardDeny: true };
	}
	if (binding.sandboxStatus === "unavailable") {
		return { outcome: "deny", reasonCode: "sandbox_unavailable", hardDeny: true };
	}
	if (binding.sandboxStatus !== "ready") {
		return { outcome: "deny", reasonCode: "sandbox_unavailable", hardDeny: true };
	}
	const required = requiredSandboxCapabilities(operation.resource);
	if (required.some((capability) => !binding.sandboxCapabilities[capability])) {
		return { outcome: "deny", reasonCode: "sandbox_capability_insufficient", hardDeny: true };
	}
	return { hardDeny: false };
}

function safeReason(code: PolicyErrorCode | undefined): string | undefined {
	return code === undefined ? undefined : POLICY_ERROR_MESSAGES[code];
}

/**
 * Safe decision facts for Task Credential resources: the exact normalized
 * requested credential-name set, the credential target identity, and the
 * requested lease TTL. These are copied onto every `credential.task.*`
 * decision so a later preflight can prove the decision authorized exactly
 * the requested scope, target, and TTL; other resources carry no facts.
 */
function taskCredentialDecisionFacts(operation: PolicyOperationRequest): {
	readonly credentialNames?: ReadonlyArray<string>;
	readonly targetId?: string;
	readonly ttlMs?: number;
} {
	if (!isTaskCredentialPolicyResource(operation.resource)) return {};
	return {
		...(operation.credentialNames === undefined ? {} : { credentialNames: [...operation.credentialNames] }),
		...(operation.targetId === undefined ? {} : { targetId: operation.targetId }),
		...(operation.ttlMs === undefined ? {} : { ttlMs: operation.ttlMs }),
	};
}

function createApprovalRequest(
	binding: PolicyBinding,
	operation: PolicyOperationRequest,
	requestId: string,
	timestamp: string,
	classification?: ProtectedPathClassification,
): PolicyApprovalRequest {
	const scope: PolicyApprovalScope = {
		resource: operation.resource,
		...(operation.scope === undefined ? {} : { workspaceScopes: [operation.scope] }),
		...(operation.environmentNames === undefined ? {} : { environmentCount: operation.environmentNames.length }),
		...(operation.destination === undefined ? {} : { destinationCount: 1 }),
		...(operation.credentialNames === undefined ? {} : { credentialCount: operation.credentialNames.length }),
		...(classification === undefined ? {} : { effectCount: classification.effects.length }),
		...(classification === undefined ? {} : { pathCount: classification.pathCount }),
		...(classification?.scopeDigest === undefined ? {} : { scopeDigest: classification.scopeDigest }),
	};
	const reviewRequirement = classification?.requirement;
	const reviewerRequired = reviewRequirement === "reviewer" || reviewRequirement === "team_enforced";
	const reasonCode = reviewerRequired ? "policy_review_required" : "policy_approval_required";
	return deepFreeze({
		id: requestId,
		bindingId: binding.id,
		resource: operation.resource,
		source: operation.source,
		scope,
		reasonCode,
		reason: POLICY_ERROR_MESSAGES[reasonCode],
		createdAt: timestamp,
		...(reviewRequirement === undefined || reviewRequirement === "none" ? {} : { reviewRequirement }),
		...(classification?.scopeDigest === undefined ? {} : { scopeDigest: classification.scopeDigest }),
	});
}

export function createPolicyApprovalRequest(input: {
	readonly binding: PolicyBinding;
	readonly operation: PolicyOperationRequest;
	readonly requestId?: string;
	readonly timestamp?: string;
}): PolicyApprovalRequest {
	const operation = validateOperation(input.operation);
	if (operation === undefined) throw policyError("policy_settings_invalid");
	const requestId = input.requestId ?? `${POLICY_REQUEST_PREFIX}${hashText(stableStringify({ bindingId: input.binding.id, operation }))}`;
	const timestamp = input.timestamp ?? input.binding.createdAt;
	if (!isSafeOpaqueId(requestId) || !isCanonicalPolicyTimestamp(timestamp)) throw policyError("policy_settings_invalid");
	return createApprovalRequest(input.binding, operation, requestId, timestamp);
}

function validateOperation(value: unknown): PolicyOperationRequest | undefined {
	if (!isRecord(value) || !isResource(value.resource) || !isSource(value.source)) return undefined;
	const id = value.id;
	const scope = value.scope;
	const capabilityId = value.capabilityId;
	if (id !== undefined && !isSafeOpaqueId(id)) return undefined;
	if (scope !== undefined && !isWorkspaceScope(scope)) return undefined;
	if (capabilityId !== undefined && !isSafeText(capabilityId)) return undefined;
	const requestedPath = value.path === undefined ? undefined : isSafeText(value.path) ? value.path : undefined;
	const targetPath = value.targetPath === undefined ? undefined : isSafeText(value.targetPath) ? value.targetPath : undefined;
	const effects = value.effects;
	const parsedEffects = effects === undefined
		? undefined
		: Array.isArray(effects) && effects.length > 0 && effects.every(isPolicyEffect)
			? uniqueInOrder(effects)
			: undefined;
	const path = value.canonicalPath === undefined
		? undefined
		: isCanonicalWorkspaceRelativePath(value.canonicalPath)
			? value.canonicalPath
			: undefined;
	const paths = value.canonicalPaths;
	const parsedCanonicalPaths = paths === undefined
		? undefined
		: Array.isArray(paths) && paths.every(isCanonicalWorkspaceRelativePath)
			? uniqueSorted(paths)
			: undefined;
	const command = value.command === undefined ? undefined : isSafeText(value.command) ? value.command : undefined;
	const cwd = value.cwd === undefined ? undefined : isSafeText(value.cwd) ? value.cwd : undefined;
	const destination = value.destination === undefined ? undefined : isSafeText(value.destination) ? value.destination : undefined;
	if (
		(value.path !== undefined && requestedPath === undefined) ||
		(value.targetPath !== undefined && targetPath === undefined) ||
		(value.effects !== undefined && parsedEffects === undefined) ||
		(value.canonicalPath !== undefined && path === undefined) ||
		(value.canonicalPaths !== undefined && parsedCanonicalPaths === undefined) ||
		(value.command !== undefined && command === undefined) ||
		(value.cwd !== undefined && cwd === undefined) ||
		(value.destination !== undefined && destination === undefined)
	) {
		return undefined;
	}
	const args = value.args;
	if (args !== undefined && (!Array.isArray(args) || !args.every(isSafeText))) return undefined;
	const port = value.port;
	if (port !== undefined && !isPort(port)) return undefined;
	const credentialNames = value.credentialNames;
	const environmentNames = value.environmentNames;
	const targetId = value.targetId;
	const ttlMs = value.ttlMs;
	const requiresSandbox = value.requiresSandbox;
	const sandboxed = value.sandboxed;
	const sandboxProviderId = value.sandboxProviderId;
	const parsedCredentialNames =
		credentialNames === undefined ? undefined : parseStringArray(credentialNames, isTaskCredentialIdentifier);
	const parsedEnvironmentNames =
		environmentNames === undefined ? undefined : parseStringArray(environmentNames, isEnvironmentName);
	if (credentialNames !== undefined && parsedCredentialNames === undefined) return undefined;
	if (environmentNames !== undefined && parsedEnvironmentNames === undefined) return undefined;
	if (targetId !== undefined && !isSafeOpaqueId(targetId)) return undefined;
	if (ttlMs !== undefined && !isPositiveInteger(ttlMs)) return undefined;
	if (requiresSandbox !== undefined && typeof requiresSandbox !== "boolean") return undefined;
	if (sandboxed !== undefined && typeof sandboxed !== "boolean") return undefined;
	if (sandboxProviderId !== undefined && !isSafeText(sandboxProviderId)) return undefined;
	if (requiresSandbox === true && sandboxed === true && sandboxProviderId === undefined) return undefined;
	return deepFreeze({
		resource: value.resource,
		source: value.source,
		...(id === undefined ? {} : { id }),
		...(scope === undefined ? {} : { scope }),
		...(capabilityId === undefined ? {} : { capabilityId }),
		...(requestedPath === undefined ? {} : { path: requestedPath }),
		...(targetPath === undefined ? {} : { targetPath }),
		...(parsedEffects === undefined ? {} : { effects: parsedEffects }),
		...(path === undefined ? {} : { canonicalPath: path }),
		...(parsedCanonicalPaths === undefined ? {} : { canonicalPaths: parsedCanonicalPaths }),
		...(command === undefined ? {} : { command }),
		...(args === undefined ? {} : { args: args.map((arg) => String(arg)) }),
		...(cwd === undefined ? {} : { cwd }),
		...(destination === undefined ? {} : { destination }),
		...(port === undefined ? {} : { port }),
		...(parsedCredentialNames === undefined ? {} : { credentialNames: parsedCredentialNames }),
		...(parsedEnvironmentNames === undefined ? {} : { environmentNames: parsedEnvironmentNames }),
		...(requiresSandbox === undefined ? {} : { requiresSandbox }),
		...(sandboxed === undefined ? {} : { sandboxed }),
		...(sandboxProviderId === undefined ? {} : { sandboxProviderId }),
		...(targetId === undefined ? {} : { targetId }),
		...(ttlMs === undefined ? {} : { ttlMs }),
	});
}

const PATH_EFFECTS = new Set<PolicyEffect>(["read", "write", "create", "delete", "move", "commit", "merge"]);

function protectedClassification(
	profile: ExecutionPolicyProfile,
	binding: PolicyBinding,
	operation: PolicyOperationRequest,
): ProtectedPathClassification | undefined {
	if (profile.protectedPaths === undefined) return undefined;
	const paths = uniqueSorted([
		...(operation.canonicalPath === undefined ? [] : [operation.canonicalPath]),
		...(operation.canonicalPaths ?? []),
	]);
	if (operation.effects === undefined) {
		if (
			operation.resource === "filesystem.read" ||
			operation.resource === "filesystem.write" ||
			operation.resource === "filesystem.find" ||
			operation.resource === "filesystem.grep"
		) {
			throw policyError("protected_path_invalid");
		}
		return undefined;
	}
	if (operation.effects.some((effect) => PATH_EFFECTS.has(effect)) && paths.length === 0) {
		throw policyError("protected_path_invalid");
	}
	try {
		return classifyProtectedPathOperation({
			policy: profile.protectedPaths,
			bindingId: binding.id,
			resource: operation.resource,
			source: operation.source,
			effects: operation.effects,
			paths,
			...(operation.requiresSandbox === true ? { matchAllPaths: true } : {}),
		});
	} catch {
		throw policyError("protected_path_invalid");
	}
}

function protectedRequestId(classification: ProtectedPathClassification | undefined, fallback: string | undefined): string | undefined {
	if (classification?.scopeDigest !== undefined) return `${POLICY_REQUEST_PREFIX}${classification.scopeDigest.slice("sha256:".length)}`;
	return fallback;
}

function protectedDecisionFacts(
	classification: ProtectedPathClassification | undefined,
	reviewEvidence?: ReadonlyArray<PolicyReviewEvidence>,
): {
	readonly effects?: ReadonlyArray<PolicyEffect>;
	readonly protectedPathCount?: number;
	readonly matchedProtectedRuleIds?: ReadonlyArray<string>;
	readonly reviewRequirement?: PolicyReviewRequirement;
	readonly scopeDigest?: string;
	readonly reviewEvidence?: ReadonlyArray<PolicyReviewEvidence>;
} {
	if (classification === undefined) return {};
	return {
		effects: [...classification.effects],
		protectedPathCount: classification.protected ? classification.pathCount : 0,
		matchedProtectedRuleIds: [...classification.matchedRuleIds],
		reviewRequirement: classification.requirement,
		...(classification.scopeDigest === undefined ? {} : { scopeDigest: classification.scopeDigest }),
		...(reviewEvidence === undefined ? {} : { reviewEvidence: reviewEvidence.map((item) => ({ ...item, reviewer: { ...item.reviewer } })) }),
	};
}

export function authorizePolicyOperation(input: {
	readonly profile: ExecutionPolicyProfile;
	readonly binding: PolicyBinding;
	readonly operation: PolicyOperationRequest;
	readonly capabilityBinding?: CapabilityBindingInput;
	readonly mode?: PolicyInterfaceMode;
	readonly projectRules?: ReadonlyArray<PolicyRule>;
	readonly reviewEvidence?: PolicyReviewEvidence | ReadonlyArray<PolicyReviewEvidence>;
}): PolicyDecision {
	const operation = validateOperation(input.operation);
	if (operation === undefined) throw policyError("policy_settings_invalid");
	const facts = taskCredentialDecisionFacts(operation);
	const classification = protectedClassification(input.profile, input.binding, operation);
	const protectedFacts = protectedDecisionFacts(classification);
	const capabilityCode = capabilityDecision(operation, input.capabilityBinding);
	const requestId = protectedRequestId(classification, operation.id);
	const timestamp = input.binding.createdAt;
	if (capabilityCode !== undefined) {
		return deepFreeze({
			bindingId: input.binding.id,
			profileId: input.profile.id,
			profileRevision: input.binding.profileRevision,
			projectTrust: input.binding.projectTrust,
			enforcement: input.binding.enforcement,
			resource: operation.resource,
			source: operation.source,
			action: "deny",
			outcome: "deny",
			reasonCode: capabilityCode,
			reason: safeReason(capabilityCode),
			hardDeny: true,
			...(requestId === undefined ? {} : { requestId }),
			timestamp,
			...protectedFacts,
			...facts,
		});
	}
	let action = ruleAction(input.profile, operation);
	for (const rule of input.projectRules ?? []) {
		if (ruleMatches(rule, operation)) action = strictest(action, rule.action);
	}
	const boundaryCode = operationBoundaryReason(input.profile, operation);
	if (boundaryCode !== undefined) action = "deny";
	const configuredApproval = approvalAction(input.profile, operation);
	if (configuredApproval !== undefined) action = strictest(action, configuredApproval);
	if (classification?.requirement === "approval") action = strictest(action, "ask");
	if (boundaryCode !== undefined) {
		return deepFreeze({
			bindingId: input.binding.id,
			profileId: input.profile.id,
			profileRevision: input.binding.profileRevision,
			projectTrust: input.binding.projectTrust,
			enforcement: input.binding.enforcement,
			resource: operation.resource,
			source: operation.source,
			action: "deny",
			outcome: "deny",
			reasonCode: boundaryCode,
			reason: safeReason(boundaryCode),
			hardDeny: true,
			...(requestId === undefined ? {} : { requestId }),
			timestamp,
			...protectedFacts,
			...facts,
		});
	}
	const sandbox = sandboxDecision(input.profile, input.binding, operation);
	if (sandbox.outcome !== undefined) {
		return deepFreeze({
			bindingId: input.binding.id,
			profileId: input.profile.id,
			profileRevision: input.binding.profileRevision,
			projectTrust: input.binding.projectTrust,
			enforcement: input.binding.enforcement,
			resource: operation.resource,
			source: operation.source,
			action: "deny",
			outcome: sandbox.outcome,
			reasonCode: sandbox.reasonCode,
			reason: safeReason(sandbox.reasonCode),
			hardDeny: sandbox.hardDeny,
			...(requestId === undefined ? {} : { requestId }),
			timestamp,
			...protectedFacts,
			...facts,
		});
	}
	if (action === "deny") {
		const reasonCode: PolicyErrorCode =
			operation.resource === "credential.expose"
				? "credential_policy_violation"
				: operation.resource === "network.connect"
					? "network_policy_violation"
					: "policy_denied";
		return deepFreeze({
			bindingId: input.binding.id,
			profileId: input.profile.id,
			profileRevision: input.binding.profileRevision,
			projectTrust: input.binding.projectTrust,
			enforcement: input.binding.enforcement,
			resource: operation.resource,
			source: operation.source,
			action,
			outcome: "deny",
			reasonCode,
			reason: safeReason(reasonCode),
			hardDeny: true,
			...(requestId === undefined ? {} : { requestId }),
			timestamp,
			...protectedFacts,
			...facts,
		});
	}
	let approvedReviewEvidence: ReadonlyArray<PolicyReviewEvidence> | undefined;
	if (classification?.requirement === "reviewer" || classification?.requirement === "team_enforced") {
		const reviewRequestId = requestId;
		if (input.profile.protectedPaths === undefined || reviewRequestId === undefined) throw policyError("protected_path_invalid");
		const review = resolvePolicyReviewEvidence({
			policy: input.profile.protectedPaths,
			classification,
			bindingId: input.binding.id,
			requestId: reviewRequestId,
			requestCreatedAt: timestamp,
			evidence: input.reviewEvidence,
		});
		if (review.status !== "approved") {
			const reasonCode: PolicyErrorCode = review.status === "rejected"
				? "policy_review_rejected"
				: review.status === "invalid"
					? "policy_review_evidence_invalid"
					: "policy_review_required";
			const approval = review.status === "missing"
				? createApprovalRequest(input.binding, operation, reviewRequestId, timestamp, classification)
				: undefined;
			return deepFreeze({
				bindingId: input.binding.id,
				profileId: input.profile.id,
				profileRevision: input.binding.profileRevision,
				projectTrust: input.binding.projectTrust,
				enforcement: input.binding.enforcement,
				resource: operation.resource,
				source: operation.source,
				action: "deny",
				outcome: "deny",
				reasonCode,
				reason: safeReason(reasonCode),
				hardDeny: true,
				requestId: reviewRequestId,
				timestamp,
				...(approval === undefined ? {} : { approval }),
				...protectedFacts,
				...facts,
			});
		}
		approvedReviewEvidence = review.evidence;
	}
	if (action === "ask") {
		const approval = createApprovalRequest(
			input.binding,
			operation,
			requestId ?? `${POLICY_REQUEST_PREFIX}${hashText(stableStringify({ bindingId: input.binding.id, operation }))}`,
			timestamp,
			classification,
		);
		return deepFreeze({
			bindingId: input.binding.id,
			profileId: input.profile.id,
			profileRevision: input.binding.profileRevision,
			projectTrust: input.binding.projectTrust,
			enforcement: input.binding.enforcement,
			resource: operation.resource,
			source: operation.source,
			action,
			outcome: "ask",
			reasonCode: "policy_approval_required",
			reason: safeReason("policy_approval_required"),
			hardDeny: false,
			requestId: approval.id,
			timestamp,
			approval,
			...protectedFacts,
			...facts,
		});
	}
	return deepFreeze({
		bindingId: input.binding.id,
		profileId: input.profile.id,
		profileRevision: input.binding.profileRevision,
		projectTrust: input.binding.projectTrust,
		enforcement: input.binding.enforcement,
		resource: operation.resource,
		source: operation.source,
		action,
		outcome: "allow",
		hardDeny: false,
		...(requestId === undefined ? {} : { requestId }),
		timestamp,
		...protectedDecisionFacts(classification, approvedReviewEvidence),
		...facts,
	});
}

export function toPublicPolicySummary(binding: PolicyBinding, decision?: PolicyDecision): PublicPolicySummary {
	return deepFreeze({
		bindingId: binding.id,
		profileId: binding.profileId,
		profileRevision: binding.profileRevision,
		projectTrust: binding.projectTrust,
		enforcement: binding.enforcement,
		...(binding.sandboxProviderId === undefined ? {} : { sandboxProviderId: binding.sandboxProviderId }),
		sandboxStatus: binding.sandboxStatus,
		sandboxCapabilities: { ...binding.sandboxCapabilities },
		...(decision === undefined
			? {}
			: {
				resource: decision.resource,
				action: decision.action,
				outcome: decision.outcome,
				...(decision.reasonCode === undefined ? {} : { reasonCode: decision.reasonCode }),
				...(decision.requestId === undefined ? {} : { requestId: decision.requestId }),
				timestamp: decision.timestamp,
			}),
	});
}

/** Stable policy revision used by the public binding handle. */
export function getPolicyBindingRevision(binding: PolicyBinding): string {
	return binding.bindingHash.startsWith("digest:") ? binding.bindingHash : createBindingRevision({ bindingHash: binding.bindingHash });
}

/** Build the small, public-safe Execution Policy binding handle. */
export function toPolicyBindingHandle(binding: PolicyBinding, decision?: PolicyDecision): BindingHandle {
	const summarySource = toPublicPolicySummary(binding, decision);
	const summary: PublicBindingSummary = {
		profileId: summarySource.profileId,
		profileRevision: summarySource.profileRevision,
		projectTrust: summarySource.projectTrust,
		enforcement: summarySource.enforcement,
		sandboxStatus: summarySource.sandboxStatus,
		filesystem: summarySource.sandboxCapabilities.filesystem,
		process: summarySource.sandboxCapabilities.process,
		network: summarySource.sandboxCapabilities.network,
		credentialIsolation: summarySource.sandboxCapabilities.credentialIsolation,
		...(summarySource.sandboxProviderId === undefined ? {} : { sandboxProviderId: summarySource.sandboxProviderId }),
		...(summarySource.resource === undefined ? {} : { resource: summarySource.resource }),
		...(summarySource.action === undefined ? {} : { action: summarySource.action }),
		...(summarySource.outcome === undefined ? {} : { outcome: summarySource.outcome }),
		...(summarySource.reasonCode === undefined ? {} : { reasonCode: summarySource.reasonCode }),
		...(summarySource.requestId === undefined ? {} : { requestId: summarySource.requestId }),
		...(summarySource.timestamp === undefined ? {} : { timestamp: summarySource.timestamp }),
	};
	return createBindingHandle({
		domain: "policy",
		bindingId: binding.id,
		revision: getPolicyBindingRevision(binding),
		relation: "run.policy",
		role: binding.profileId,
		summary,
	});
}

export const createPolicyBindingHandle = toPolicyBindingHandle;
export const toPublicPolicyBindingHandle = toPolicyBindingHandle;
export const serializePublicPolicyBindingHandle = toPolicyBindingHandle;

export function isPolicyBindingHandle(value: unknown): value is BindingHandle {
	return isBindingHandle(value) && value.domain === "policy";
}

export const createPolicySummary = toPublicPolicySummary;

export function toPolicyDecisionSummary(decision: PolicyDecision, binding: PolicyBinding): PolicyDecisionSummary {
	return toPublicPolicySummary(binding, decision);
}

export function freezePolicyProfile(profile: ExecutionPolicyProfile): ExecutionPolicyProfile {
	const parsed = parseProfile(profile);
	if (parsed === undefined) throw policyError("policy_settings_invalid");
	return parsed;
}

export function freezePolicyBinding(binding: PolicyBinding): PolicyBinding {
	return deepFreeze({
		...binding,
		sandboxCapabilities: { ...binding.sandboxCapabilities },
		constraints: {
			workspace: {
				read: [...binding.constraints.workspace.read],
				write: [...binding.constraints.workspace.write],
				deny: [...binding.constraints.workspace.deny],
			},
			process: {
				...binding.constraints.process,
				...(binding.constraints.process.cwdScopes === undefined
					? {}
					: { cwdScopes: [...binding.constraints.process.cwdScopes] }),
			},
			network: { ...binding.constraints.network },
			credentials: { ...binding.constraints.credentials },
			...(binding.constraints.protectedPaths === undefined
				? {}
				: { protectedPaths: { ...binding.constraints.protectedPaths } }),
		},
	});
}

export function toPolicyErrorView(error: PolicyError | PolicyErrorCode): PolicyErrorView {
	const code = typeof error === "string" ? error : error.code;
	return deepFreeze({ code, message: POLICY_ERROR_MESSAGES[code], retryable: false });
}

function selectedProfile(
	input: ResolveExecutionPolicyInput,
	profiles: ReadonlyMap<string, ExecutionPolicyProfile>,
): { ok: true; profile: ExecutionPolicyProfile; projectNarrowing?: PolicyProfileNarrowing } | { ok: false; error: PolicyError } {
	const project = getProjectInput(input);
	const trust = projectTrust(input, project !== undefined);
	const explicit = input.policyProfile ?? input.profile;
	if (input.policyProfile !== undefined && input.profile !== undefined && input.policyProfile !== input.profile) return invalid();
	const projectId = project?.profileId;
	const requestedId = explicit ?? projectId ?? input.defaultProfile ?? POLICY_DEFAULT_PROFILE;
	if (!isSafeIdentifier(requestedId)) return invalid();
	let profile = profiles.get(requestedId);
	if (profile === undefined && requestedId === POLICY_DEFAULT_PROFILE && explicit === undefined && projectId === undefined) {
		profile = cloneProfile(LEGACY_PROFILE);
	}
	if (profile === undefined) return { ok: false, error: policyError("policy_profile_not_found") };
	if (projectId !== undefined && explicit === undefined && trust === "untrusted" && projectId !== (input.defaultProfile ?? POLICY_DEFAULT_PROFILE)) {
		return { ok: false, error: policyError("policy_profile_untrusted") };
	}
	if (project?.profile === undefined && input.projectProfile === undefined) return { ok: true, profile };
	const narrowing = parseNarrowing(project?.profile ?? input.projectProfile);
	if (narrowing === undefined) return invalid();
	const merged = mergeNarrowing(profile, narrowing);
	if (!merged.ok) return merged;
	return { ok: true, profile: merged.profile, projectNarrowing: narrowing };
}

export function resolveExecutionPolicyProfile(input: ResolveExecutionPolicyInput): PolicyProfileResolutionResult {
	const parsedProfiles = parseProfiles(input.profiles);
	if (!parsedProfiles.ok) return parsedProfiles;
	const selected = selectedProfile(input, parsedProfiles.profiles);
	if (!selected.ok) return selected;
	const project = getProjectInput(input);
	const trust = projectTrust(input, project !== undefined);
	const capabilityBinding = input.capabilityBinding ?? input.capability;
	if (!validCapabilityBinding(capabilityBinding) || !validSandboxPreflight(input.sandbox)) return invalid();
	let binding: PolicyBinding;
	try {
		binding = createBinding(selected.profile, trust, input, capabilityBinding);
	} catch (error) {
		return { ok: false, error: error instanceof PolicyError ? error : policyError("policy_binding_failed") };
	}
	const summary = toPublicPolicySummary(binding);
	return deepFreeze({ ok: true, profile: selected.profile, binding, summary });
}

export function resolveExecutionPolicy(input: ResolveExecutionPolicyInput): PolicyResolutionResult {
	const profileResult = resolveExecutionPolicyProfile(input);
	if (!profileResult.ok) return profileResult;
	if (input.operation === undefined) {
		const resolution: PolicyResolution = {
			profile: profileResult.profile,
			binding: profileResult.binding,
			summary: profileResult.summary,
		};
		return deepFreeze({
			ok: true,
			resolution,
			profile: profileResult.profile,
			binding: profileResult.binding,
			summary: profileResult.summary,
		});
	}
	const operation = validateOperation(input.operation);
	if (operation === undefined) return { ok: false, error: policyError("policy_settings_invalid") };
	const capabilityBinding = input.capabilityBinding ?? input.capability;
	let decision: PolicyDecision;
	try {
		decision = authorizePolicyOperation({
			profile: profileResult.profile,
			binding: profileResult.binding,
			operation,
			capabilityBinding,
			mode: input.mode ?? input.interfaceMode,
			reviewEvidence: input.reviewEvidence,
		});
	} catch (error) {
		return { ok: false, error: error instanceof PolicyError ? error : policyError("policy_settings_invalid") };
	}
	const summary = toPublicPolicySummary(profileResult.binding, decision);
	const resolution: PolicyResolution = {
		profile: profileResult.profile,
		binding: profileResult.binding,
		decision,
		...(decision.approval === undefined ? {} : { approval: decision.approval }),
		summary,
	};
	return deepFreeze({
		ok: true,
		resolution,
		profile: profileResult.profile,
		binding: profileResult.binding,
		decision,
		...(decision.approval === undefined ? {} : { approval: decision.approval }),
		summary,
	});
}

export const resolvePolicy = resolveExecutionPolicy;

/**
 * Task Credential / Lease preflight.
 *
 * Read-only preflight for one `credential.task.issue` / `renew` / `project` /
 * `revoke` operation. It accepts already-resolved facts only (the frozen
 * execution binding, the current Session/Run/Policy/Graph identities, the
 * resolved Gate record, node attach state, the resolved policy decision, the
 * capability binding, the per-binding sandbox facts, the TTL bounds with the
 * earliest deadline, and the provider scope) and checks them in the fixed
 * order below. It never writes to the Session, never calls the provider, and
 * never starts an operation; every failure returns a provider-neutral
 * `TaskCredentialError` carrying the frozen `task_credential_*` code.
 */

export const TASK_CREDENTIAL_PREFLIGHT_OPERATIONS = Object.freeze(["issue", "renew", "project", "revoke"] as const);
export type TaskCredentialPreflightOperation = (typeof TASK_CREDENTIAL_PREFLIGHT_OPERATIONS)[number];

/** The policy resource that governs one Task Credential preflight operation. */
export function taskCredentialPolicyResource(operation: TaskCredentialPreflightOperation): TaskCredentialPolicyResource {
	switch (operation) {
		case "issue":
			return "credential.task.issue";
		case "renew":
			return "credential.task.renew";
		case "project":
			return "credential.task.project";
		case "revoke":
			return "credential.task.revoke";
	}
}

/** Resolved Task Gate fact for the preflight; never a live store handle. */
export interface TaskCredentialGatePreflight {
	readonly status: "pending" | "approved" | "rejected" | "cancelled";
	readonly stageRevision: number;
}

/** Resolved per-binding sandbox facts for the preflight; never a live handle. */
export interface TaskCredentialSandboxPreflight {
	readonly bindingId: string;
	readonly status: SandboxStatus;
	readonly capabilities: SandboxCapabilities;
	readonly perBinding: boolean;
}

/** Resolved provider scope facts for the preflight; never a live provider call. */
export interface TaskCredentialProviderPreflight {
	readonly available: boolean;
	readonly declaresDelivery: boolean;
}

export interface TaskCredentialPreflightInput {
	readonly operation: TaskCredentialPreflightOperation;
	/** The frozen Task Execution Binding of the lease. */
	readonly binding: TaskExecutionBinding;
	/** Current Session id; must equal `binding.sessionId`. */
	readonly sessionId: string;
	/** Current Run id; must equal `binding.runId`. */
	readonly runId: string;
	/** Current graph revision; must equal `binding.graphRevision`. */
	readonly graphRevision: number;
	/** Current Policy Binding id; must equal `binding.policyBindingId`. */
	readonly policyBindingId: string;
	/** Current Capability Binding id; must equal `binding.capabilityBindingId`. */
	readonly capabilityBindingId: string;
	/**
	 * Resolved Gate for `(sessionId, taskId, stageId, stageRevision)` when the
	 * binding has a stage pair; must be `approved` with a matching revision.
	 */
	readonly gate?: TaskCredentialGatePreflight;
	/** The graph node of the binding must be attached to the Run. */
	readonly nodeAttached: boolean;
	/**
	 * The resolved policy decision for `credential.task.<operation>` carrying
	 * the operation's scope/target/TTL facts (`credentialNames`,
	 * `targetId`, `ttlMs`); never auto-approved here.
	 */
	readonly decision: PolicyDecision;
	/** Resolved approval state for `ask` decisions. */
	readonly approvalGranted: boolean;
	/**
	 * The capability binding of the execution context; required and its `id`
	 * must equal `capabilityBindingId`. It declares the credential target via
	 * `allowedTargetIds` / `deniedTargetIds`.
	 */
	readonly capabilityBinding: CapabilityBindingInput;
	/**
	 * Normalized requested scope allowlist (deduped, sorted, structurally
	 * valid). `scopeDigest` must equal `calculateScopeDigest(scopes)` and
	 * `scopeCount` must equal `scopes.length`, so the safe facts correlate
	 * with exactly the requested scopes.
	 */
	readonly scopes: ReadonlyArray<TaskCredentialScope>;
	/** Digest of the normalized requested scopes; must match `scopes`. */
	readonly scopeDigest: string;
	/** Count of the normalized requested scopes; must equal `scopes.length`. */
	readonly scopeCount: number;
	/**
	 * Safe resolved per-binding target capability facts; never a live
	 * provider call. `targetId` must equal `binding.targetId` and `bindingId`
	 * must equal the Task Execution Binding id (`binding.bindingId`), not the
	 * capability binding id — the capability binding stays a separately
	 * checked execution-context identity.
	 */
	readonly target: TaskCredentialTargetCapabilities;
	readonly sandbox?: TaskCredentialSandboxPreflight;
	readonly requestedTtlMs: number;
	/** Profile/policy TTL bounds including the earliest Task/Run deadline. */
	readonly ttlBounds: TaskCredentialTtlBounds;
	readonly nowMs: number;
	readonly provider: TaskCredentialProviderPreflight;
}

export type TaskCredentialPreflightResult =
	| { readonly allowed: true; readonly boundedTtlMs: number }
	| { readonly allowed: false; readonly error: TaskCredentialError };

const TASK_CREDENTIAL_PREFLIGHT_INPUT_KEYS = Object.freeze([
	"operation",
	"binding",
	"sessionId",
	"runId",
	"graphRevision",
	"policyBindingId",
	"capabilityBindingId",
	"gate",
	"nodeAttached",
	"decision",
	"approvalGranted",
	"capabilityBinding",
	"scopes",
	"scopeDigest",
	"scopeCount",
	"target",
	"sandbox",
	"requestedTtlMs",
	"ttlBounds",
	"nowMs",
	"provider",
] as const);

const TASK_CREDENTIAL_GATE_STATUSES = Object.freeze(["pending", "approved", "rejected", "cancelled"] as const);
const TASK_CREDENTIAL_GATE_KEYS = Object.freeze(["status", "stageRevision"] as const);
const TASK_CREDENTIAL_TTL_BOUNDS_KEYS = Object.freeze(["minTtlMs", "maxTtlMs", "deadlineAtMs"] as const);
const TASK_CREDENTIAL_SANDBOX_KEYS = Object.freeze(["bindingId", "status", "capabilities", "perBinding"] as const);
const TASK_CREDENTIAL_PROVIDER_KEYS = Object.freeze(["available", "declaresDelivery"] as const);

function hasOnlyPreflightKeys(value: Record<string, unknown>, allowed: ReadonlyArray<string>): boolean {
	return Object.keys(value).every((key) => allowed.includes(key));
}

function validTaskCredentialGate(value: unknown): value is TaskCredentialGatePreflight {
	if (value === undefined) return true;
	if (!isRecord(value) || !hasOnlyPreflightKeys(value, TASK_CREDENTIAL_GATE_KEYS)) {
		return false;
	}
	return (
		(TASK_CREDENTIAL_GATE_STATUSES as readonly string[]).includes(value.status as string) &&
		isPositiveInteger(value.stageRevision)
	);
}

function validTaskCredentialDecision(value: unknown): value is PolicyDecision {
	if (!isRecord(value)) return false;
	return (
		isSafeOpaqueId(value.bindingId) &&
		isResource(value.resource) &&
		isAction(value.action) &&
		(POLICY_DECISION_OUTCOMES as readonly string[]).includes(value.outcome as string) &&
		(value.reasonCode === undefined || (POLICY_ERROR_CODES as readonly string[]).includes(value.reasonCode as string)) &&
		(value.credentialNames === undefined ||
			(Array.isArray(value.credentialNames) && value.credentialNames.every(isTaskCredentialIdentifier))) &&
		(value.targetId === undefined || isSafeOpaqueId(value.targetId)) &&
		(value.ttlMs === undefined || isPositiveInteger(value.ttlMs))
	);
}

function validTaskCredentialSandbox(value: unknown): value is TaskCredentialSandboxPreflight {
	if (value === undefined) return true;
	if (!isRecord(value) || !hasOnlyPreflightKeys(value, TASK_CREDENTIAL_SANDBOX_KEYS)) return false;
	if (!isSafeOpaqueId(value.bindingId) || !isSandboxStatus(value.status) || typeof value.perBinding !== "boolean") {
		return false;
	}
	const capabilities = value.capabilities;
	if (!isRecord(capabilities)) return false;
	for (const key of ["filesystem", "process", "network", "credentialIsolation"] as const) {
		if (typeof capabilities[key] !== "boolean") return false;
	}
	return capabilities.credentialDelivery === undefined || typeof capabilities.credentialDelivery === "boolean";
}

function validTaskCredentialProvider(value: unknown): value is TaskCredentialProviderPreflight {
	if (!isRecord(value) || !hasOnlyPreflightKeys(value, TASK_CREDENTIAL_PROVIDER_KEYS)) return false;
	return typeof value.available === "boolean" && typeof value.declaresDelivery === "boolean";
}

function validTaskCredentialTtlBounds(value: unknown): value is TaskCredentialTtlBounds {
	if (!isRecord(value) || !hasOnlyPreflightKeys(value, TASK_CREDENTIAL_TTL_BOUNDS_KEYS)) return false;
	if (
		!isPositiveInteger(value.minTtlMs) ||
		!isPositiveInteger(value.maxTtlMs) ||
		(value.minTtlMs as number) > (value.maxTtlMs as number)
	) {
		return false;
	}
	return value.deadlineAtMs === undefined || isTaskCredentialEpochMs(value.deadlineAtMs);
}

function sameTaskCredentialScope(left: TaskCredentialScope, right: TaskCredentialScope): boolean {
	return (
		left.credentialName === right.credentialName &&
		left.purpose === right.purpose &&
		(left.resource ?? null) === (right.resource ?? null) &&
		left.operations.length === right.operations.length &&
		left.operations.every((item, index) => item === right.operations[index]) &&
		left.targetKinds.length === right.targetKinds.length &&
		left.targetKinds.every((item, index) => item === right.targetKinds[index])
	);
}

/**
 * Structural scope facts check: the requested scope allowlist must be
 * non-empty, bounded, structurally valid, already normalized (deduped and
 * sorted), and must correlate with the supplied `scopeDigest` (the canonical
 * digest of the normalized list) and `scopeCount` (its length). Any mismatch
 * fails the preflight input.
 */
function validTaskCredentialScopeFacts(
	scopes: unknown,
	scopeDigest: unknown,
	scopeCount: unknown,
): scopes is ReadonlyArray<TaskCredentialScope> {
	if (!Array.isArray(scopes) || scopes.length === 0 || scopes.length > TASK_CREDENTIAL_MAX_SCOPES) return false;
	if (!scopes.every((item) => isTaskCredentialScope(item))) return false;
	if (scopeCount !== scopes.length) return false;
	if (typeof scopeDigest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(scopeDigest)) return false;
	let normalized: ReadonlyArray<TaskCredentialScope>;
	try {
		normalized = normalizeTaskCredentialScopes(scopes);
	} catch {
		return false;
	}
	if (normalized.length !== scopes.length) return false;
	if (!normalized.every((scope, index) => sameTaskCredentialScope(scope, scopes[index]))) return false;
	let digest: string;
	try {
		digest = calculateScopeDigest(normalized);
	} catch {
		return false;
	}
	return digest === scopeDigest;
}

/**
 * Per-operation target capabilities: delivery needs the short-lived
 * projection capability and delivery receipts; renew and revoke need their
 * own operation capability; every operation needs per-binding isolation.
 */
function requiredTaskCredentialTargetCapabilities(
	operation: TaskCredentialPreflightOperation,
): ReadonlyArray<keyof TaskCredentialTargetCapabilities> {
	switch (operation) {
		case "issue":
			return ["canReceiveShortLivedCredential", "supportsPerBindingIsolation"];
		case "renew":
			return ["canRenewCredential", "supportsPerBindingIsolation"];
		case "revoke":
			return ["canRevokeCredential", "supportsPerBindingIsolation"];
		case "project":
			return ["canReceiveShortLivedCredential", "supportsPerBindingIsolation", "supportsDeliveryReceipt"];
	}
}

/** Build one provider-neutral preflight failure with the frozen code. */
function preflightError(code: TaskCredentialErrorCode): { readonly allowed: false; readonly error: TaskCredentialError } {
	return { allowed: false, error: new TaskCredentialError(code) };
}

/**
 * Resolve the read-only Task Credential preflight in the fixed check order:
 * input/binding (including the normalized scope facts and the resolved target
 * capability snapshot), Session/Run/Policy/Graph ownership, Task Gate
 * approved/stageRevision, node attach, Policy scope/target/TTL correlation
 * and action, ask unapproved `approval_required`, Capability target identity
 * and per-operation capabilities, Sandbox/provider per-binding
 * isolation/delivery/renew/revoke, earliest deadline, provider scope. Pure:
 * no Session writes, no provider calls, no side effects. Success reports the
 * bounded TTL actually granted; every failure is `{ allowed: false, error }`
 * with a `TaskCredentialError` carrying the frozen provider-neutral code.
 */
export function resolveTaskCredentialPreflight(input: TaskCredentialPreflightInput): TaskCredentialPreflightResult {
	// Step 1 - input/binding: structural validation only, no I/O. The
	// capability binding is required and must carry the capability binding id,
	// and the scope facts must be normalized and mutually consistent.
	const raw: unknown = input;
	if (
		!isRecord(raw) ||
		!hasOnlyPreflightKeys(raw, TASK_CREDENTIAL_PREFLIGHT_INPUT_KEYS) ||
		!(TASK_CREDENTIAL_PREFLIGHT_OPERATIONS as readonly string[]).includes(input.operation) ||
		!isTaskCredentialIdentifier(input.sessionId) ||
		!isTaskCredentialIdentifier(input.runId) ||
		!isTaskCredentialIdentifier(input.policyBindingId) ||
		!isTaskCredentialIdentifier(input.capabilityBindingId) ||
		!isPositiveInteger(input.graphRevision) ||
		typeof input.nodeAttached !== "boolean" ||
		typeof input.approvalGranted !== "boolean" ||
		!isPositiveInteger(input.requestedTtlMs) ||
		!isTaskCredentialEpochMs(input.nowMs) ||
		!validTaskCredentialTtlBounds(input.ttlBounds) ||
		!validTaskCredentialGate(input.gate) ||
		!validTaskCredentialDecision(input.decision) ||
		input.capabilityBinding === undefined ||
		!validCapabilityBinding(input.capabilityBinding) ||
		!validTaskCredentialScopeFacts(input.scopes, input.scopeDigest, input.scopeCount) ||
		!isTaskCredentialTargetCapabilities(input.target) ||
		!validTaskCredentialSandbox(input.sandbox) ||
		!validTaskCredentialProvider(input.provider)
	) {
		return preflightError("task_credential_invalid");
	}
	if (!isTaskExecutionBinding(input.binding)) {
		return preflightError("task_credential_binding_invalid");
	}
	// Step 2 - Session/Run/Policy/Graph ownership: every identity the lease
	// froze must equal the current execution context, including the capability
	// binding the input carries.
	if (
		input.binding.sessionId !== input.sessionId ||
		input.binding.runId !== input.runId ||
		input.binding.policyBindingId !== input.policyBindingId ||
		input.binding.graphRevision !== input.graphRevision ||
		input.binding.capabilityBindingId !== input.capabilityBindingId ||
		input.capabilityBinding.id !== input.capabilityBindingId
	) {
		return preflightError("task_credential_binding_invalid");
	}
	// Step 3 - Task Gate approved/stageRevision: the stage pair requires an
	// approved Gate at the exact stage revision; a pending, rejected,
	// cancelled, missing, or revision-mismatched Gate never passes.
	if (input.binding.stageId !== undefined) {
		if (
			input.gate === undefined ||
			input.gate.status !== "approved" ||
			input.gate.stageRevision !== input.binding.stageRevision
		) {
			return preflightError("task_credential_gate_required");
		}
	}
	// Step 4 - node attach: the graph node must be attached to the Run.
	if (!input.nodeAttached) {
		return preflightError("task_credential_binding_invalid");
	}
	// Step 5 - Policy scope/target/TTL/action: the decision must belong to
	// this Policy Binding and this operation and must carry exactly the
	// requested scope credential-name set, target identity, and TTL facts; a
	// decision that authorized a different scope, target, or TTL can never
	// authorize this request, and the requested TTL must fit the
	// profile/policy ceiling before the deadline is consulted.
	if (
		input.decision.bindingId !== input.policyBindingId ||
		input.decision.resource !== taskCredentialPolicyResource(input.operation)
	) {
		return preflightError("task_credential_invalid");
	}
	const requestedCredentialNames = uniqueSorted(input.scopes.map((scope) => scope.credentialName));
	if (
		input.decision.credentialNames === undefined ||
		input.decision.credentialNames.length !== requestedCredentialNames.length ||
		!arraySubset(requestedCredentialNames, input.decision.credentialNames) ||
		!arraySubset(input.decision.credentialNames, requestedCredentialNames)
	) {
		return preflightError("task_credential_scope_denied");
	}
	if (input.decision.targetId !== input.binding.targetId) {
		return preflightError("task_credential_policy_denied");
	}
	if (input.decision.ttlMs !== input.requestedTtlMs) {
		return preflightError("task_credential_ttl_invalid");
	}
	const ttlFloor = Math.max(input.ttlBounds.minTtlMs, TASK_CREDENTIAL_RENEWAL_WINDOW_MS);
	const ttlCeiling = Math.min(input.ttlBounds.maxTtlMs, TASK_CREDENTIAL_MAX_TTL_MS);
	if (ttlCeiling < ttlFloor || input.requestedTtlMs < ttlFloor || input.requestedTtlMs > ttlCeiling) {
		return preflightError("task_credential_ttl_invalid");
	}
	if (input.decision.outcome === "deny") {
		if (input.decision.reasonCode === "credential_policy_violation") {
			return preflightError("task_credential_scope_denied");
		}
		if (
			input.decision.reasonCode === "sandbox_unavailable" ||
			input.decision.reasonCode === "sandbox_capability_insufficient"
		) {
			// The decision already failed on the sandbox boundary; the live
			// sandbox facts below confirm the same failure with the
			// provider-neutral code.
			return preflightError("task_credential_target_unavailable");
		}
		return preflightError("task_credential_policy_denied");
	}
	if (input.decision.outcome === "sandbox_required") {
		return preflightError("task_credential_target_unavailable");
	}
	if (input.decision.outcome !== "allow" && input.decision.outcome !== "ask") {
		return preflightError("task_credential_policy_denied");
	}
	// Step 6 - ask must be explicitly approved; an unapproved ask never passes
	// and is never auto-approved here.
	if (input.decision.outcome === "ask" && !input.approvalGranted) {
		return preflightError("task_credential_approval_required");
	}
	// Step 7 - Capability target: the capability binding declares the
	// credential target; a denied or undeclared target is a hard deny. The
	// resolved target facts must address the lease's own target under the
	// lease's Task Execution Binding (the target snapshot `bindingId` is the
	// execution binding id, never the capability binding id) and declare the
	// operation's capabilities. The scope contract also restricts which target
	// kinds may receive material: every scope that declares a non-empty
	// `targetKinds` list must permit the resolved target's kind.
	const targetId = input.binding.targetId;
	if (targetId === undefined) {
		return preflightError("task_credential_target_unavailable");
	}
	const capabilityBinding = input.capabilityBinding;
	if (capabilityBinding.deniedTargetIds?.includes(targetId)) {
		return preflightError("task_credential_policy_denied");
	}
	if (capabilityBinding.allowedTargetIds !== undefined && !capabilityBinding.allowedTargetIds.includes(targetId)) {
		return preflightError("task_credential_policy_denied");
	}
	if (input.target.targetId !== targetId || input.target.bindingId !== input.binding.bindingId) {
		// The capability snapshot addresses a different target or a different
		// Task Execution Binding than the lease's.
		return preflightError("task_credential_policy_denied");
	}
	if (input.scopes.some((scope) => scope.targetKinds.length > 0 && !scope.targetKinds.includes(input.target.targetKind))) {
		return preflightError("task_credential_scope_denied");
	}
	for (const capability of requiredTaskCredentialTargetCapabilities(input.operation)) {
		if (!input.target[capability]) {
			return preflightError("task_credential_target_unavailable");
		}
	}
	// Step 8 - Sandbox/provider per-binding isolation/delivery/renew/revoke:
	// the lease's sandbox binding must be the live per-binding session and
	// declare credentialIsolation for every operation, plus credentialDelivery
	// for delivery/renewal/revocation.
	const sandboxBindingId = input.binding.sandboxBindingId;
	if (
		sandboxBindingId === undefined ||
		input.sandbox === undefined ||
		input.sandbox.bindingId !== sandboxBindingId ||
		!input.sandbox.perBinding ||
		input.sandbox.status !== "ready" ||
		!input.sandbox.capabilities.credentialIsolation
	) {
		return preflightError("task_credential_target_unavailable");
	}
	if (input.operation !== "issue" && !input.sandbox.capabilities.credentialDelivery) {
		return preflightError("task_credential_target_unavailable");
	}
	// Step 9 - earliest deadline: the requested TTL must fit before the
	// earliest of the Task and Run deadlines; a passed deadline never issues.
	if (input.ttlBounds.deadlineAtMs !== undefined) {
		if (input.nowMs >= input.ttlBounds.deadlineAtMs || input.nowMs + input.requestedTtlMs > input.ttlBounds.deadlineAtMs) {
			return preflightError("task_credential_ttl_invalid");
		}
	}
	// Step 10 - provider scope: the issuer must be reachable for issue, and
	// the target must declare delivery for project/renew/revoke.
	if (!input.provider.available) {
		return preflightError("task_credential_provider_unavailable");
	}
	if (input.operation !== "issue" && !input.provider.declaresDelivery) {
		return preflightError("task_credential_target_unavailable");
	}
	// The bounded TTL is the requested TTL clamped to the policy ceiling and
	// the earliest deadline; every bound above already passed, so the result
	// is the effective grant length the caller may rely on.
	let boundedTtlMs = Math.min(input.requestedTtlMs, ttlCeiling);
	if (input.ttlBounds.deadlineAtMs !== undefined) {
		boundedTtlMs = Math.min(boundedTtlMs, input.ttlBounds.deadlineAtMs - input.nowMs);
	}
	return { allowed: true, boundedTtlMs };
}
