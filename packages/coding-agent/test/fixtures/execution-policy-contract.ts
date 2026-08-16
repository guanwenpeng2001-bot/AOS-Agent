/**
 * T0-only contract fixture.
 *
 * This file intentionally does not import production policy code. It records
 * the values that T1-T7 must implement and gives the contract test stable
 * cases for fail-closed and public-boundary review.
 */

export const POLICY_ACTIONS = ["allow", "ask", "deny"] as const;
export type PolicyAction = (typeof POLICY_ACTIONS)[number];

export const POLICY_ENFORCEMENTS = ["legacy", "host", "sandbox"] as const;
export type PolicyEnforcement = (typeof POLICY_ENFORCEMENTS)[number];

export const POLICY_RESOURCES = [
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
] as const;
export type PolicyResource = (typeof POLICY_RESOURCES)[number];

export const POLICY_DECISION_OUTCOMES = [...POLICY_ACTIONS, "sandbox_required"] as const;
export type PolicyDecisionOutcome = (typeof POLICY_DECISION_OUTCOMES)[number];

export const POLICY_ERROR_CODES = [
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
] as const;
export type PolicyErrorCode = (typeof POLICY_ERROR_CODES)[number];

export const POLICY_LEDGER_EVENT_TYPES = [
	"policy.binding",
	"policy.decision",
	"policy.approval",
	"sandbox.lifecycle",
	"policy.violation",
] as const;

export const POLICY_PUBLIC_SUMMARY_KEYS = [
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
] as const;

export const POLICY_SETTINGS_KEY = "executionPolicy" as const;
export const POLICY_DEFAULT_PROFILE = "legacy" as const;
export const POLICY_RUN_FIELD = "policyProfile" as const;
export const POLICY_QUERY_COMMAND = "get_execution_policy" as const;
export const POLICY_APPROVE_COMMAND = "policy.approve" as const;
export const POLICY_REJECT_COMMAND = "policy.reject" as const;
export const POLICY_BINDING_CUSTOM_TYPE = "policy.binding" as const;

export type WorkspaceScope =
	| "workspace"
	| "declared-read-only"
	| "temporary"
	| "credentials"
	| "agent-internal";

export interface PolicyProfileFixture {
	id: string;
	enforcement: PolicyEnforcement;
	sandboxProvider?: string;
	defaultAction: PolicyAction;
	workspace: {
		read: ReadonlyArray<WorkspaceScope>;
		write: ReadonlyArray<WorkspaceScope>;
		deny: ReadonlyArray<WorkspaceScope>;
	};
	process: {
		action: PolicyAction;
		inheritEnvironment: boolean;
		allowEnvironment: ReadonlyArray<string>;
	};
	network: {
		action: PolicyAction;
		allowDestinations: ReadonlyArray<string>;
	};
	credentials: {
		action: PolicyAction;
		allowNames: ReadonlyArray<string>;
	};
	approvals: {
		writeOutsideWorkspace: PolicyAction;
		network: PolicyAction;
		process: PolicyAction;
	};
}

export const LEGACY_PROFILE_FIXTURE = {
	id: "legacy",
	enforcement: "legacy",
	defaultAction: "allow",
	workspace: { read: ["workspace", "declared-read-only"], write: ["workspace"], deny: [] },
	process: { action: "allow", inheritEnvironment: true, allowEnvironment: [] },
	network: { action: "allow", allowDestinations: [] },
	credentials: { action: "allow", allowNames: [] },
	approvals: { writeOutsideWorkspace: "allow", network: "allow", process: "allow" },
} as const satisfies PolicyProfileFixture;

export const STRICT_PROFILE_FIXTURE = {
	id: "workspace-safe",
	enforcement: "sandbox",
	sandboxProvider: "fake-sandbox",
	defaultAction: "deny",
	workspace: {
		read: ["workspace", "declared-read-only"],
		write: ["workspace"],
		deny: ["credentials", "agent-internal"],
	},
	process: { action: "ask", inheritEnvironment: false, allowEnvironment: ["PATH", "LANG", "TEMP"] },
	network: { action: "deny", allowDestinations: [] },
	credentials: { action: "deny", allowNames: [] },
	approvals: { writeOutsideWorkspace: "deny", network: "ask", process: "ask" },
} as const satisfies PolicyProfileFixture;

export type SandboxStatus =
	| "not_required"
	| "unavailable"
	| "preparing"
	| "ready"
	| "failed"
	| "disposed";

export interface SandboxCapabilitiesFixture {
	filesystem: boolean;
	process: boolean;
	network: boolean;
	credentialIsolation: boolean;
}

export interface PolicyContractCase {
	id: string;
	enforcement: PolicyEnforcement;
	providerConfigured: boolean;
	providerStatus: SandboxStatus;
	providerCapabilitiesComplete: boolean;
	projectTrusted: boolean;
	projectAttemptsExpansion: boolean;
	action: PolicyAction;
	interfaceMode: "interactive" | "headless";
	agentSelfReport?: string;
	authoritativeEvidence: "local-policy" | "sandbox-provider";
	expectedOutcome: PolicyDecisionOutcome;
	expectedError?: PolicyErrorCode;
	sideEffectMayStart: boolean;
}

export const POLICY_CONTRACT_CASES = [
	{
		id: "legacy-default",
		enforcement: "legacy",
		providerConfigured: false,
		providerStatus: "not_required",
		providerCapabilitiesComplete: false,
		projectTrusted: true,
		projectAttemptsExpansion: false,
		action: "allow",
		interfaceMode: "interactive",
		authoritativeEvidence: "local-policy",
		expectedOutcome: "allow",
		sideEffectMayStart: true,
	},
	{
		id: "sandbox-provider-missing",
		enforcement: "sandbox",
		providerConfigured: false,
		providerStatus: "unavailable",
		providerCapabilitiesComplete: false,
		projectTrusted: true,
		projectAttemptsExpansion: false,
		action: "allow",
		interfaceMode: "headless",
		authoritativeEvidence: "local-policy",
		expectedOutcome: "sandbox_required",
		expectedError: "sandbox_required",
		sideEffectMayStart: false,
	},
	{
		id: "sandbox-provider-unavailable",
		enforcement: "sandbox",
		providerConfigured: true,
		providerStatus: "unavailable",
		providerCapabilitiesComplete: true,
		projectTrusted: true,
		projectAttemptsExpansion: false,
		action: "allow",
		interfaceMode: "headless",
		authoritativeEvidence: "sandbox-provider",
		expectedOutcome: "deny",
		expectedError: "sandbox_unavailable",
		sideEffectMayStart: false,
	},
	{
		id: "sandbox-capability-insufficient",
		enforcement: "sandbox",
		providerConfigured: true,
		providerStatus: "ready",
		providerCapabilitiesComplete: false,
		projectTrusted: true,
		projectAttemptsExpansion: false,
		action: "allow",
		interfaceMode: "headless",
		authoritativeEvidence: "sandbox-provider",
		expectedOutcome: "deny",
		expectedError: "sandbox_capability_insufficient",
		sideEffectMayStart: false,
	},
	{
		id: "untrusted-project-expansion",
		enforcement: "sandbox",
		providerConfigured: true,
		providerStatus: "ready",
		providerCapabilitiesComplete: true,
		projectTrusted: false,
		projectAttemptsExpansion: true,
		action: "allow",
		interfaceMode: "headless",
		authoritativeEvidence: "local-policy",
		expectedOutcome: "deny",
		expectedError: "policy_profile_untrusted",
		sideEffectMayStart: false,
	},
	{
		id: "headless-approval",
		enforcement: "host",
		providerConfigured: false,
		providerStatus: "not_required",
		providerCapabilitiesComplete: false,
		projectTrusted: true,
		projectAttemptsExpansion: false,
		action: "ask",
		interfaceMode: "headless",
		authoritativeEvidence: "local-policy",
		expectedOutcome: "ask",
		expectedError: "policy_approval_required",
		sideEffectMayStart: false,
	},
	{
		id: "agent-self-report-is-not-evidence",
		enforcement: "sandbox",
		providerConfigured: true,
		providerStatus: "ready",
		providerCapabilitiesComplete: true,
		projectTrusted: true,
		projectAttemptsExpansion: false,
		action: "deny",
		interfaceMode: "interactive",
		agentSelfReport: "I did not read outside the workspace.",
		authoritativeEvidence: "sandbox-provider",
		expectedOutcome: "deny",
		expectedError: "policy_denied",
		sideEffectMayStart: false,
	},
] as const satisfies ReadonlyArray<PolicyContractCase>;
