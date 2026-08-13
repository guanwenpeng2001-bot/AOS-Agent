import {
	POLICY_ERROR_CODES,
	type PolicyApprovalRequest,
	type PolicyResource,
	type PolicyOperationSource,
	type PublicPolicySummary,
} from "../../core/execution-policy.ts";
import { theme } from "./theme/theme.ts";

const POLICY_RESOURCES: ReadonlySet<PolicyResource> = new Set([
	"capability.invoke",
	"filesystem.read",
	"filesystem.write",
	"filesystem.find",
	"filesystem.grep",
	"process.spawn",
	"network.connect",
	"credential.expose",
	"sandbox.prepare",
]);

const POLICY_SOURCES: ReadonlySet<PolicyOperationSource> = new Set([
	"builtin",
	"user_bash",
	"mcp",
	"extension",
	"sdk",
	"rpc",
	"cli",
	"system",
]);

const POLICY_SCOPES = new Set(["workspace", "declared-read-only", "temporary", "credentials", "agent-internal"]);

/** The supported `/policy` command forms. */
export function formatPolicyUsage(): string {
	return ["/policy", "/policy approve <request-id>", "/policy reject <request-id>"].join("\n");
}

function safeEnum<T extends string>(value: unknown, allowed: ReadonlySet<T>): string {
	return typeof value === "string" && allowed.has(value as T) ? value : "unknown";
}

function formatApprovalScope(approval: PolicyApprovalRequest): string {
	const scope = approval.scope;
	const details: string[] = [];
	if (Array.isArray(scope.workspaceScopes)) {
		const scopes = scope.workspaceScopes.filter((value) => POLICY_SCOPES.has(value));
		if (scopes.length > 0) details.push(`workspace=${scopes.join(",")}`);
	}
	const environmentCount = scope.environmentCount;
	if (environmentCount !== undefined && Number.isInteger(environmentCount) && environmentCount >= 0) {
		details.push(`environment values=${environmentCount}`);
	}
	const destinationCount = scope.destinationCount;
	if (destinationCount !== undefined && Number.isInteger(destinationCount) && destinationCount >= 0) {
		details.push(`destinations=${destinationCount}`);
	}
	const credentialCount = scope.credentialCount;
	if (credentialCount !== undefined && Number.isInteger(credentialCount) && credentialCount >= 0) {
		details.push(`credentials=${credentialCount}`);
	}
	return details.length === 0 ? "metadata only" : details.join(", ");
}

function formatPendingApproval(approval: PolicyApprovalRequest): string[] {
	return [
		`${approval.id}  ${safeEnum(approval.resource, POLICY_RESOURCES)}  ${safeEnum(approval.source, POLICY_SOURCES)}`,
		`  ${theme.fg("dim", "Binding:")} ${approval.bindingId}`,
		`  ${theme.fg("dim", "Reason:")} policy_approval_required`,
		`  ${theme.fg("dim", "Scope:")} ${formatApprovalScope(approval)}`,
	];
}

function bool(value: boolean): string {
	return value ? "yes" : "no";
}

export function formatPolicySummary(
	summary: PublicPolicySummary,
	pendingApprovals: ReadonlyArray<PolicyApprovalRequest>,
): string {
	const capabilities = summary.sandboxCapabilities;
	const lines = [
		theme.bold("Execution Policy"),
		"",
		`${theme.fg("dim", "Profile:")} ${summary.profileId}`,
		`${theme.fg("dim", "Binding:")} ${summary.bindingId}`,
		`${theme.fg("dim", "Project trust:")} ${summary.projectTrust}`,
		`${theme.fg("dim", "Enforcement:")} ${summary.enforcement}`,
		`${theme.fg("dim", "Sandbox:")} ${summary.sandboxStatus}`,
		`${theme.fg("dim", "Sandbox provider:")} ${summary.sandboxProviderId ?? "-"}`,
		`${theme.fg("dim", "Sandbox capabilities:")} filesystem=${bool(capabilities.filesystem)} process=${bool(capabilities.process)} network=${bool(capabilities.network)} credentialIsolation=${bool(capabilities.credentialIsolation)}`,
	];
	if (summary.resource !== undefined) {
		lines.push(
			"",
			theme.bold("Last decision"),
			`${theme.fg("dim", "Resource:")} ${summary.resource}`,
			`${theme.fg("dim", "Action:")} ${summary.action ?? "-"}`,
			`${theme.fg("dim", "Outcome:")} ${summary.outcome ?? "-"}`,
			`${theme.fg("dim", "Reason:")} ${summary.reasonCode ?? "-"}`,
		);
	}
	lines.push("", theme.bold(`Pending approvals (${pendingApprovals.length})`));
	if (pendingApprovals.length === 0) {
		lines.push("None");
	} else {
		for (const approval of pendingApprovals) {
			lines.push(...formatPendingApproval(approval));
		}
		lines.push("", theme.fg("dim", "Use /policy approve <request-id> or /policy reject <request-id>."));
	}
	return `${lines.join("\n")}\n`;
}

/** Format the result of an explicit, session-local approval action. */
export function formatPolicyAction(action: "approve" | "reject", requestId?: string): string {
	const verb = action === "approve" ? "Approved" : "Rejected";
	const request = requestId === undefined ? "policy request" : `policy request ${requestId}`;
	const note =
		action === "approve"
			? "The approval is session-local and never overrides the active binding or a deny."
			: "The request remains denied for this session.";
	return `${theme.bold(`${verb} ${request}`)}\n${theme.fg("dim", note)}`;
}

export function formatPolicyError(error: unknown): string {
	if (typeof error === "object" && error !== null && "code" in error) {
		const code = String((error as { code: unknown }).code);
		if ((POLICY_ERROR_CODES as readonly string[]).includes(code)) {
			return `${theme.fg("error", code)}\n`;
		}
	}
	return `${theme.fg("error", "Policy inspection failed.")}\n`;
}
