import {
	createBindingHandle,
	createBindingRevision,
	isBindingHandle,
	type BindingHandle,
	type PublicBindingSummary,
} from "./binding-handles.ts";

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
export type PolicyResource =
	| "capability.invoke"
	| "mcp.auth"
	| "mcp.content.list"
	| "mcp.content.read"
	| "mcp.content.attach"
	| "filesystem.read"
	| "filesystem.write"
	| "filesystem.find"
	| "filesystem.grep"
	| "process.spawn"
	| "network.connect"
	| "credential.expose"
	| "sandbox.prepare";
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
	"mcp.auth",
	"mcp.content.list",
	"mcp.content.read",
	"mcp.content.attach",
	"filesystem.read",
	"filesystem.write",
	"filesystem.find",
	"filesystem.grep",
	"process.spawn",
	"network.connect",
	"credential.expose",
	"sandbox.prepare",
] as const);
export const POLICY_OPERATION_CATEGORIES = POLICY_RESOURCE_CATEGORIES;
export const POLICY_RESOURCES = POLICY_RESOURCE_CATEGORIES;
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
	| "policy_ledger_persistence_failed";

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

export interface ApprovalPolicy {
	readonly writeOutsideWorkspace: PolicyAction;
	readonly network: PolicyAction;
	readonly process: PolicyAction;
	readonly filesystemRead?: PolicyAction;
	readonly filesystemWrite?: PolicyAction;
	readonly credentials?: PolicyAction;
	readonly sandbox?: PolicyAction;
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
	readonly approvals: ApprovalPolicy;
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
	readonly approvals?: Partial<ApprovalPolicy>;
	readonly rules?: ReadonlyArray<PolicyRule>;
}

export interface PolicyOperationRequest {
	readonly id?: string;
	readonly resource: PolicyResource;
	readonly source: PolicyOperationSource;
	readonly scope?: WorkspaceScope;
	readonly capabilityId?: string;
	/** For MCP content operations: the logical MCP server id (e.g. "docs"). */
	readonly serverId?: string;
	/** For MCP content operations: the digest id of the content item (resourceId/promptId). */
	readonly sourceId?: string;
	/** For MCP content operations: the parent mcp_server descriptor id. */
	readonly parentId?: string;
	/** For MCP content operations: the descriptor revision the caller resolved. */
	readonly revision?: string;
	readonly path?: string;
	readonly targetPath?: string;
	readonly command?: string;
	readonly args?: ReadonlyArray<string>;
	readonly cwd?: string;
	readonly destination?: string;
	readonly port?: number;
	readonly credentialNames?: ReadonlyArray<string>;
	readonly environmentNames?: ReadonlyArray<string>;
}

export interface SandboxCapabilities {
	readonly filesystem: boolean;
	readonly process: boolean;
	readonly network: boolean;
	readonly credentialIsolation: boolean;
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
	readonly descriptors?: ReadonlyArray<{ readonly id: string; readonly revision?: string }>;
	readonly allowedCapabilityIds?: ReadonlyArray<string>;
	readonly deniedCapabilityIds?: ReadonlyArray<string>;
	readonly allowedResources?: ReadonlyArray<PolicyResource>;
	readonly deniedResources?: ReadonlyArray<PolicyResource>;
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
}

export interface PolicyApprovalRequest {
	readonly id: string;
	readonly bindingId: string;
	readonly resource: PolicyResource;
	readonly source: PolicyOperationSource;
	readonly scope: PolicyApprovalScope;
	readonly reasonCode: "policy_approval_required";
	readonly reason: string;
	readonly createdAt: string;
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
	const keys = ["writeOutsideWorkspace", "network", "process", "filesystemRead", "filesystemWrite", "credentials", "sandbox"];
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
		approvals: { ...profile.approvals },
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
		"approvals",
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
	const networkDestinations = parseStringArray(value.network.allowDestinations, isSafeText);
	const credentialsAction = parseAction(value.credentials.action);
	const credentialNames = parseStringArray(value.credentials.allowNames, isEnvironmentName);
	if (networkAction === undefined || networkDestinations === undefined || credentialsAction === undefined || credentialNames === undefined) {
		return undefined;
	}
	const approvals = parseApprovals(value.approvals, false);
	if (approvals === undefined) return undefined;
	const completeApprovals = approvals as ApprovalPolicy;
	const rules = parseRules(value.rules);
	if (rules === undefined) return undefined;
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
		approvals: completeApprovals,
		...(rules.length > 0 ? { rules } : {}),
	});
}

function parseNarrowing(value: unknown): PolicyProfileNarrowing | undefined {
	if (!isRecord(value)) return undefined;
	const allowed = ["id", "revision", "enforcement", "sandboxProvider", "defaultAction", "workspace", "process", "network", "credentials", "approvals", "rules"];
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
			const destinations = parseStringArray(value.network.allowDestinations, isSafeText);
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
			const names = parseStringArray(value.credentials.allowNames, isEnvironmentName);
			if (names === undefined) return undefined;
			credentials.allowNames = names;
		}
	}
	const approvals = value.approvals === undefined ? undefined : parseApprovals(value.approvals, true);
	if (value.approvals !== undefined && approvals === undefined) return undefined;
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
		...(approvals === undefined ? {} : { approvals }),
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
	if (narrowing.approvals !== undefined) {
		const approvalPairs: ReadonlyArray<[PolicyAction, PolicyAction | undefined]> = [
			[base.approvals.writeOutsideWorkspace, narrowing.approvals.writeOutsideWorkspace],
			[base.approvals.network, narrowing.approvals.network],
			[base.approvals.process, narrowing.approvals.process],
			[base.approvals.filesystemRead ?? "allow", narrowing.approvals.filesystemRead],
			[base.approvals.filesystemWrite ?? "allow", narrowing.approvals.filesystemWrite],
			[base.approvals.credentials ?? "allow", narrowing.approvals.credentials],
			[base.approvals.sandbox ?? "allow", narrowing.approvals.sandbox],
		];
		if (approvalPairs.some(([baseAction, requestedAction]) => requestedAction !== undefined && ACTION_RANK[requestedAction] < ACTION_RANK[baseAction])) {
			return { ok: false, error: policyError("policy_profile_untrusted") };
		}
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
		base.network.allowDestinations.length > 0 &&
		!arraySubset(narrowing.network.allowDestinations, base.network.allowDestinations)
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
	// T0 does not allow a project to introduce a second rule layer. It can
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
			approvals,
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
	if (
		value.descriptors?.some(
			(descriptor) =>
				!isRecord(descriptor) ||
				!isSafeOpaqueId(descriptor.id) ||
				(descriptor.revision !== undefined && !isSafeOpaqueId(descriptor.revision)),
		)
	) {
		return false;
	}
	for (const ids of [value.allowedCapabilityIds, value.deniedCapabilityIds]) {
		if (ids !== undefined && (!Array.isArray(ids) || !ids.every(isSafeOpaqueId))) return false;
	}
	for (const resources of [value.allowedResources, value.deniedResources]) {
		if (resources !== undefined && (!Array.isArray(resources) || !resources.every(isResource))) return false;
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
				typeof capabilities.credentialIsolation !== "boolean")
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
	if (!isSafeText(createdAt)) throw policyError("policy_binding_failed");
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
			return profile.network.action;
		case "credential.expose":
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
			return profile.approvals.credentials;
		case "sandbox.prepare":
			return profile.approvals.sandbox;
		default:
			return undefined;
	}
}

/**
 * MCP operation resources governed by the frozen capability binding. Every
 * one names the governing mcp_server descriptor; item operations (read and
 * attach) additionally name the content item descriptor and its parent.
 */
function isMCPOperationResource(resource: PolicyResource): boolean {
	return (
		resource === "mcp.auth" ||
		resource === "mcp.content.list" ||
		resource === "mcp.content.read" ||
		resource === "mcp.content.attach"
	);
}

/** MCP operations that name a content item (mcp_resource/mcp_prompt) and its parent. */
function isMCPContentItemResource(resource: PolicyResource): boolean {
	return resource === "mcp.content.read" || resource === "mcp.content.attach";
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
	// MCP operations always name their governing capability: auth and list
	// name the mcp_server descriptor, read and attach name the content item
	// descriptor. Without it the operation cannot be checked against the
	// frozen binding.
	if (isMCPOperationResource(operation.resource) && capability.descriptors !== undefined && operation.capabilityId === undefined) {
		return "policy_denied";
	}
	// A content read/attach also names its parent: the mcp_server descriptor
	// that must be selected in the same frozen binding.
	if (
		isMCPContentItemResource(operation.resource) &&
		capability.descriptors !== undefined &&
		operation.parentId === undefined
	) {
		return "policy_denied";
	}
	if (operation.capabilityId !== undefined) {
		if (capability.deniedCapabilityIds?.includes(operation.capabilityId)) return "policy_denied";
		if (capability.allowedCapabilityIds !== undefined && !capability.allowedCapabilityIds.includes(operation.capabilityId)) {
			return "policy_denied";
		}
		if (capability.descriptors !== undefined) {
			const descriptor = capability.descriptors.find((descriptor) => descriptor.id === operation.capabilityId);
			if (descriptor === undefined) return "policy_denied";
			if (isMCPOperationResource(operation.resource)) {
				// The binding froze the exact descriptor revision. A caller holding
				// a stale catalog entry fails closed instead of touching content
				// the binding never selected.
				if (operation.revision === undefined || descriptor.revision === undefined || descriptor.revision !== operation.revision) {
					return "policy_denied";
				}
			}
		}
		if (
			isMCPContentItemResource(operation.resource) &&
			operation.parentId !== undefined &&
			capability.descriptors !== undefined &&
			!capability.descriptors.some((descriptor) => descriptor.id === operation.parentId)
		) {
			// A content item can never be read or attached unless its parent
			// mcp_server is selected in the same frozen binding.
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
			return "credentialIsolation";
		case "capability.invoke":
		case "sandbox.prepare":
			return undefined;
	}
}

function requiredSandboxCapabilities(resource: PolicyResource): ReadonlyArray<keyof SandboxCapabilities> {
	// Capability invocation and MCP operations (auth, content listing, content
	// reads, and content attachment) pull remote content or execute remote
	// behavior in-process; a sandbox-enforced profile requires the full
	// isolation report before any of them may proceed.
	if (
		resource === "capability.invoke" ||
		resource === "mcp.auth" ||
		resource === "mcp.content.list" ||
		resource === "mcp.content.read" ||
		resource === "mcp.content.attach"
	) {
		return ["filesystem", "process", "network", "credentialIsolation"];
	}
	const required = requiredSandboxCapability(resource);
	return required === undefined ? [] : [required];
}

function safeDestinationMatches(destination: string, allowed: ReadonlyArray<string>): boolean {
	return allowed.includes(destination);
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
		if (operation.destination === undefined || !safeDestinationMatches(operation.destination, profile.network.allowDestinations)) {
			return "network_policy_violation";
		}
	}
	if (operation.resource === "credential.expose" && profile.credentials.allowNames.length > 0) {
		const names = operation.credentialNames ?? [];
		if (names.length === 0 || names.some((name) => !profile.credentials.allowNames.includes(name))) {
			return "credential_policy_violation";
		}
	}
	if (
		operation.resource === "credential.expose" &&
		profile.enforcement !== "legacy" &&
		profile.credentials.allowNames.length === 0
	) {
		return "credential_policy_violation";
	}
	return undefined;
}

function sandboxDecision(
	profile: ExecutionPolicyProfile,
	binding: PolicyBinding,
	operation: PolicyOperationRequest,
): { outcome?: PolicyDecisionOutcome; reasonCode?: PolicyErrorCode; hardDeny: boolean } {
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

function createApprovalRequest(
	binding: PolicyBinding,
	operation: PolicyOperationRequest,
	requestId: string,
	timestamp: string,
): PolicyApprovalRequest {
	const scope: PolicyApprovalScope = {
		resource: operation.resource,
		...(operation.scope === undefined ? {} : { workspaceScopes: [operation.scope] }),
		...(operation.environmentNames === undefined ? {} : { environmentCount: operation.environmentNames.length }),
		...(operation.destination === undefined ? {} : { destinationCount: 1 }),
		...(operation.credentialNames === undefined ? {} : { credentialCount: operation.credentialNames.length }),
	};
	return deepFreeze({
		id: requestId,
		bindingId: binding.id,
		resource: operation.resource,
		source: operation.source,
		scope,
		reasonCode: "policy_approval_required",
		reason: POLICY_ERROR_MESSAGES.policy_approval_required,
		createdAt: timestamp,
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
	if (!isSafeText(requestId) || !isSafeText(timestamp)) throw policyError("policy_settings_invalid");
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
	const serverId = value.serverId === undefined ? undefined : isSafeText(value.serverId) ? value.serverId : undefined;
	const sourceId = value.sourceId === undefined ? undefined : isSafeText(value.sourceId) ? value.sourceId : undefined;
	const parentId = value.parentId === undefined ? undefined : isSafeText(value.parentId) ? value.parentId : undefined;
	const revision = value.revision === undefined ? undefined : isSafeText(value.revision) ? value.revision : undefined;
	if (
		(value.serverId !== undefined && serverId === undefined) ||
		(value.sourceId !== undefined && sourceId === undefined) ||
		(value.parentId !== undefined && parentId === undefined) ||
		(value.revision !== undefined && revision === undefined)
	) {
		return undefined;
	}
	const path = value.path === undefined ? undefined : isSafeText(value.path) ? value.path : undefined;
	const targetPath = value.targetPath === undefined ? undefined : isSafeText(value.targetPath) ? value.targetPath : undefined;
	const command = value.command === undefined ? undefined : isSafeText(value.command) ? value.command : undefined;
	const cwd = value.cwd === undefined ? undefined : isSafeText(value.cwd) ? value.cwd : undefined;
	const destination = value.destination === undefined ? undefined : isSafeText(value.destination) ? value.destination : undefined;
	if (
		(value.path !== undefined && path === undefined) ||
		(value.targetPath !== undefined && targetPath === undefined) ||
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
	const parsedCredentialNames =
		credentialNames === undefined ? undefined : parseStringArray(credentialNames, isEnvironmentName);
	const parsedEnvironmentNames =
		environmentNames === undefined ? undefined : parseStringArray(environmentNames, isEnvironmentName);
	if (credentialNames !== undefined && parsedCredentialNames === undefined) return undefined;
	if (environmentNames !== undefined && parsedEnvironmentNames === undefined) return undefined;
	return deepFreeze({
		resource: value.resource,
		source: value.source,
		...(id === undefined ? {} : { id }),
		...(scope === undefined ? {} : { scope }),
		...(capabilityId === undefined ? {} : { capabilityId }),
		...(serverId === undefined ? {} : { serverId }),
		...(sourceId === undefined ? {} : { sourceId }),
		...(parentId === undefined ? {} : { parentId }),
		...(revision === undefined ? {} : { revision }),
		...(path === undefined ? {} : { path }),
		...(targetPath === undefined ? {} : { targetPath }),
		...(command === undefined ? {} : { command }),
		...(args === undefined ? {} : { args: args.map((arg) => String(arg)) }),
		...(cwd === undefined ? {} : { cwd }),
		...(destination === undefined ? {} : { destination }),
		...(port === undefined ? {} : { port }),
		...(parsedCredentialNames === undefined ? {} : { credentialNames: parsedCredentialNames }),
		...(parsedEnvironmentNames === undefined ? {} : { environmentNames: parsedEnvironmentNames }),
	});
}

export function authorizePolicyOperation(input: {
	readonly profile: ExecutionPolicyProfile;
	readonly binding: PolicyBinding;
	readonly operation: PolicyOperationRequest;
	readonly capabilityBinding?: CapabilityBindingInput;
	readonly mode?: PolicyInterfaceMode;
	readonly projectRules?: ReadonlyArray<PolicyRule>;
}): PolicyDecision {
	const operation = validateOperation(input.operation);
	if (operation === undefined) throw policyError("policy_settings_invalid");
	const capabilityCode = capabilityDecision(operation, input.capabilityBinding);
	const requestId = operation.id;
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
		});
	}
	if (action === "deny") {
		const reasonCode: PolicyErrorCode =
			operation.resource === "credential.expose" ? "credential_policy_violation" : "policy_denied";
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
		});
	}
	if (action === "ask") {
		const approval = createApprovalRequest(
			input.binding,
			operation,
			requestId ?? `${POLICY_REQUEST_PREFIX}${hashText(stableStringify({ bindingId: input.binding.id, operation }))}`,
			timestamp,
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
			...(requestId === undefined ? { requestId: approval.id } : { requestId }),
			timestamp,
			approval,
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
