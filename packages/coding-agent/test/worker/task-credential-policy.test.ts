import { describe, expect, it } from "vitest";

import {
	POLICY_DEFAULT_PROFILE,
	TASK_CREDENTIAL_POLICY_RESOURCES,
	isTaskCredentialPolicyResource,
	resolveExecutionPolicy,
	resolveTaskCredentialPreflight,
	taskCredentialPolicyResource,
	type ExecutionPolicyProfile,
	type PolicyDecision,
	type TaskCredentialPreflightInput,
	type TaskCredentialPreflightResult,
} from "../../src/core/policy/execution.ts";
import {
	TaskCredentialError,
	calculateScopeDigest,
	type TaskCredentialErrorCode,
	type TaskCredentialScope,
} from "../../src/core/policy/task-credential-lease.ts";
import type { TaskCredentialTargetCapabilities } from "../../src/core/policy/task-credential-provider.ts";

const legacy: ExecutionPolicyProfile = {
	id: POLICY_DEFAULT_PROFILE,
	enforcement: "legacy",
	defaultAction: "allow",
	workspace: { read: ["workspace", "declared-read-only"], write: ["workspace"], deny: [] },
	process: { action: "allow", inheritEnvironment: true, allowEnvironment: [] },
	network: { action: "allow", allowDestinations: [] },
	credentials: { action: "allow", allowNames: [] },
	approvals: { writeOutsideWorkspace: "allow", network: "allow", process: "allow" },
};

const hostProfile: ExecutionPolicyProfile = {
	id: "host-safe",
	enforcement: "host",
	defaultAction: "deny",
	workspace: { read: ["workspace"], write: ["workspace"], deny: ["credentials", "agent-internal"] },
	process: { action: "ask", inheritEnvironment: false, allowEnvironment: ["PATH", "LANG"] },
	network: { action: "deny", allowDestinations: [] },
	credentials: { action: "deny", allowNames: [] },
	approvals: { writeOutsideWorkspace: "deny", network: "ask", process: "ask" },
};

const sandboxProfile: ExecutionPolicyProfile = {
	...hostProfile,
	id: "sandbox-safe",
	enforcement: "sandbox",
	sandboxProvider: "fake-sandbox",
};

function resolve(
	profile: ExecutionPolicyProfile,
	operation: Record<string, unknown>,
	options: Record<string, unknown> = {},
): ReturnType<typeof resolveExecutionPolicy> {
	return resolveExecutionPolicy({
		profiles: { [profile.id]: profile },
		defaultProfile: profile.id,
		operation,
		createdAt: "2026-08-13T00:00:00.000Z",
		runId: "run-test",
		workspaceIdentity: "workspace-test",
		...options,
	});
}

const NOW_MS = Date.parse("2026-08-16T12:00:00.000Z");

const PREFLIGHT_SCOPES: ReadonlyArray<TaskCredentialScope> = [
	{
		credentialName: "GITHUB_TOKEN",
		purpose: "task",
		operations: ["read"],
		targetKinds: ["isolated_sandbox"],
	},
];
const PREFLIGHT_SCOPE_DIGEST = calculateScopeDigest(PREFLIGHT_SCOPES);

const TARGET_CAPABILITIES: TaskCredentialTargetCapabilities = {
	schemaVersion: 1,
	targetId: "target_sandbox_1",
	targetKind: "isolated_sandbox",
	// The resolved target facts address the Task Execution Binding id, not
	// the capability binding id.
	bindingId: "binding_exec_1",
	canReceiveShortLivedCredential: true,
	canRenewCredential: true,
	canRevokeCredential: true,
	supportsPerBindingIsolation: true,
	supportsDeliveryReceipt: true,
};

function makeDecision(overrides: Partial<PolicyDecision> = {}): PolicyDecision {
	return {
		bindingId: "policy-binding:preflight-test",
		profileId: "preflight-test",
		profileRevision: "revision:preflight-test",
		projectTrust: "trusted",
		enforcement: "sandbox",
		resource: "credential.task.project",
		source: "rpc",
		action: "allow",
		outcome: "allow",
		hardDeny: false,
		timestamp: "2026-08-16T12:00:00.000Z",
		// Safe decision facts: exactly the requested scope credential-name
		// set, target identity, and TTL, so the preflight can prove
		// correlation.
		credentialNames: ["GITHUB_TOKEN"],
		targetId: "target_sandbox_1",
		ttlMs: 60_000,
		...overrides,
	};
}

/** Assert one preflight failure by its frozen `error.code`. */
function expectPreflightDenied(input: TaskCredentialPreflightInput, code: TaskCredentialErrorCode): void {
	const result: TaskCredentialPreflightResult = resolveTaskCredentialPreflight(input);
	expect(result).toMatchObject({ allowed: false });
	if (!result.allowed) {
		expect(result.error).toBeInstanceOf(TaskCredentialError);
		expect(result.error.code).toBe(code);
		expect(result.error.message.length).toBeGreaterThan(0);
	}
}

function makePreflightInput(overrides: Partial<TaskCredentialPreflightInput> = {}): TaskCredentialPreflightInput {
	return {
		operation: "project",
		binding: {
			schemaVersion: 1,
			bindingId: "binding_exec_1",
			sessionId: "session_test_1",
			taskId: "task_test_1",
			graphRevision: 1,
			nodeId: "node_test_1",
			stageId: "stage_test_1",
			stageRevision: 1,
			runId: "run_test_1",
			capabilityBindingId: "capability_binding_1",
			policyBindingId: "policy-binding:preflight-test",
			sandboxBindingId: "sandbox-binding:preflight-test",
			targetId: "target_sandbox_1",
			createdAt: "2026-08-16T11:00:00.000Z",
			bindingRevision: 1,
		},
		sessionId: "session_test_1",
		runId: "run_test_1",
		graphRevision: 1,
		policyBindingId: "policy-binding:preflight-test",
		capabilityBindingId: "capability_binding_1",
		gate: { status: "approved", stageRevision: 1 },
		nodeAttached: true,
		decision: makeDecision(),
		approvalGranted: false,
		capabilityBinding: { id: "capability_binding_1", allowedTargetIds: ["target_sandbox_1"] },
		scopes: PREFLIGHT_SCOPES,
		scopeDigest: PREFLIGHT_SCOPE_DIGEST,
		scopeCount: PREFLIGHT_SCOPES.length,
		target: TARGET_CAPABILITIES,
		sandbox: {
			bindingId: "sandbox-binding:preflight-test",
			status: "ready",
			capabilities: {
				filesystem: true,
				process: true,
				network: false,
				credentialIsolation: true,
				credentialDelivery: true,
			},
			perBinding: true,
		},
		requestedTtlMs: 60_000,
		ttlBounds: { minTtlMs: 10_000, maxTtlMs: 300_000, deadlineAtMs: NOW_MS + 3_600_000 },
		nowMs: NOW_MS,
		provider: { available: true, declaresDelivery: true },
		...overrides,
	};
}

describe("credential.task policy resources", () => {
	it("freezes the four Task Credential resources as independent categories", () => {
		expect(TASK_CREDENTIAL_POLICY_RESOURCES).toEqual([
			"credential.task.issue",
			"credential.task.renew",
			"credential.task.project",
			"credential.task.revoke",
		]);
		for (const resource of TASK_CREDENTIAL_POLICY_RESOURCES) {
			expect(isTaskCredentialPolicyResource(resource)).toBe(true);
		}
		expect(isTaskCredentialPolicyResource("credential.expose")).toBe(false);
		expect(taskCredentialPolicyResource("issue")).toBe("credential.task.issue");
		expect(taskCredentialPolicyResource("renew")).toBe("credential.task.renew");
		expect(taskCredentialPolicyResource("project")).toBe("credential.task.project");
		expect(taskCredentialPolicyResource("revoke")).toBe("credential.task.revoke");
	});

	it("governs issue/renew/project/revoke through the credentials action", () => {
		const denyCredentials: ExecutionPolicyProfile = {
			...hostProfile,
			credentials: { action: "deny", allowNames: ["GITHUB_TOKEN"] },
		};
		for (const resource of TASK_CREDENTIAL_POLICY_RESOURCES) {
			const result = resolve(denyCredentials, {
				resource,
				source: "rpc",
				credentialNames: ["GITHUB_TOKEN"],
				targetId: "target_sandbox",
				ttlMs: 60_000,
			});
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.decision).toMatchObject({ outcome: "deny", reasonCode: "policy_denied", hardDeny: true });
				expect(result.decision).not.toHaveProperty("approval");
			}
		}

		const ruleProfile: ExecutionPolicyProfile = {
			...hostProfile,
			id: "cred-rule",
			credentials: { action: "allow", allowNames: ["GITHUB_TOKEN"] },
			rules: [
				{ resource: "credential.task.renew", action: "deny" },
				{ resource: "credential.task.project", scope: "credentials", action: "deny" },
			],
		};
		const deniedRenew = resolve(ruleProfile, {
			resource: "credential.task.renew",
			source: "rpc",
			credentialNames: ["GITHUB_TOKEN"],
			targetId: "target_sandbox",
		});
		const allowedIssue = resolve(ruleProfile, {
			resource: "credential.task.issue",
			source: "rpc",
			credentialNames: ["GITHUB_TOKEN"],
			targetId: "target_sandbox",
		});
		const deniedScoped = resolve(ruleProfile, {
			resource: "credential.task.project",
			source: "rpc",
			scope: "credentials",
			credentialNames: ["GITHUB_TOKEN"],
			targetId: "target_sandbox",
		});
		expect(deniedRenew.ok).toBe(true);
		expect(allowedIssue.ok).toBe(true);
		expect(deniedScoped.ok).toBe(true);
		if (deniedRenew.ok && allowedIssue.ok && deniedScoped.ok) {
			expect(deniedRenew.decision?.outcome).toBe("deny");
			expect(allowedIssue.decision?.outcome).toBe("allow");
			expect(deniedScoped.decision?.outcome).toBe("deny");
		}
	});

	it("enforces the credential scope allowlist for every task credential resource", () => {
		const allowlisted: ExecutionPolicyProfile = {
			...hostProfile,
			id: "cred-allowlist",
			credentials: { action: "allow", allowNames: ["GITHUB_TOKEN"] },
		};
		for (const resource of TASK_CREDENTIAL_POLICY_RESOURCES) {
			const allowed = resolve(allowlisted, {
				resource,
				source: "rpc",
				credentialNames: ["GITHUB_TOKEN"],
				targetId: "target_sandbox",
			});
			const outside = resolve(allowlisted, {
				resource,
				source: "rpc",
				credentialNames: ["OTHER_TOKEN"],
				targetId: "target_sandbox",
			});
			const unnamed = resolve(allowlisted, { resource, source: "rpc", targetId: "target_sandbox" });
			expect(allowed.ok).toBe(true);
			expect(outside.ok).toBe(true);
			expect(unnamed.ok).toBe(true);
			if (allowed.ok && outside.ok && unnamed.ok) {
				expect(allowed.decision?.outcome).toBe("allow");
				expect(outside.decision).toMatchObject({
					outcome: "deny",
					reasonCode: "credential_policy_violation",
					hardDeny: true,
				});
				expect(unnamed.decision).toMatchObject({
					outcome: "deny",
					reasonCode: "credential_policy_violation",
					hardDeny: true,
				});
			}
		}
	});

	it("denies every task credential resource when a non-legacy profile has an empty allowlist", () => {
		for (const profile of [hostProfile, sandboxProfile]) {
			for (const resource of TASK_CREDENTIAL_POLICY_RESOURCES) {
				const result = resolve(profile, {
					resource,
					source: "rpc",
					credentialNames: ["GITHUB_TOKEN"],
					targetId: "target_sandbox",
				});
				expect(result.ok).toBe(true);
				if (result.ok) {
					// An empty allowlist never means "all": in host/sandbox
					// enforcement every credential-scoped operation is denied.
					expect(result.decision).toMatchObject({
						outcome: "deny",
						reasonCode: "credential_policy_violation",
						hardDeny: true,
					});
				}
			}
		}
		// Legacy enforcement keeps the legacy meaning: an empty allowlist does
		// not itself deny.
		const legacyAllowed = resolve(legacy, {
			resource: "credential.task.issue",
			source: "rpc",
			targetId: "target_sandbox",
		});
		expect(legacyAllowed.ok).toBe(true);
		if (legacyAllowed.ok) expect(legacyAllowed.decision?.outcome).toBe("allow");
	});

	it("creates credential approvals without leaking target or TTL facts", () => {
		const askCredentials: ExecutionPolicyProfile = {
			...hostProfile,
			credentials: { action: "ask", allowNames: ["GITHUB_TOKEN"] },
			approvals: { writeOutsideWorkspace: "deny", network: "ask", process: "ask", credentials: "ask" },
		};
		const result = resolve(askCredentials, {
			resource: "credential.task.project",
			source: "rpc",
			id: "request-credential",
			credentialNames: ["GITHUB_TOKEN"],
			targetId: "target_sandbox",
			ttlMs: 60_000,
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.decision).toMatchObject({ action: "ask", outcome: "ask", reasonCode: "policy_approval_required" });
			expect(result.approval).toMatchObject({ id: "request-credential", resource: "credential.task.project" });
			expect(JSON.stringify(result.approval)).not.toContain("target_sandbox");
			expect(JSON.stringify(result.approval)).not.toContain("60000");
		}
	});

	it("lets the capability binding declare the credential target", () => {
		const declared = resolve(
			legacy,
			{ resource: "credential.task.issue", source: "rpc", targetId: "target_sandbox" },
			{ capabilityBinding: { id: "capability_binding_1", allowedTargetIds: ["target_sandbox"] } },
		);
		const undeclared = resolve(
			legacy,
			{ resource: "credential.task.issue", source: "rpc", targetId: "target_sandbox" },
			{ capabilityBinding: { id: "capability_binding_1", allowedTargetIds: ["target_other"] } },
		);
		const denied = resolve(
			legacy,
			{ resource: "credential.task.issue", source: "rpc", targetId: "target_sandbox" },
			{ capabilityBinding: { id: "capability_binding_1", deniedTargetIds: ["target_sandbox"] } },
		);
		expect(declared.ok).toBe(true);
		expect(undeclared.ok).toBe(true);
		expect(denied.ok).toBe(true);
		if (declared.ok && undeclared.ok && denied.ok) {
			expect(declared.decision?.outcome).toBe("allow");
			expect(undeclared.decision).toMatchObject({ outcome: "deny", reasonCode: "policy_denied", hardDeny: true });
			expect(denied.decision).toMatchObject({ outcome: "deny", reasonCode: "policy_denied", hardDeny: true });
		}
	});

	it("requires credentialDelivery for delivery/renew/revoke but only isolation for issue", () => {
		const credentialSandbox: ExecutionPolicyProfile = {
			...sandboxProfile,
			id: "sandbox-cred",
			credentials: { action: "allow", allowNames: ["GITHUB_TOKEN"] },
		};
		const base = {
			providerConfigured: true,
			providerStatus: "ready" as const,
			capabilities: {
				filesystem: true,
				process: true,
				network: false,
				credentialIsolation: true,
			},
		};
		const issue = resolve(
			credentialSandbox,
			{ resource: "credential.task.issue", source: "rpc", credentialNames: ["GITHUB_TOKEN"], targetId: "target_sandbox" },
			{ sandbox: base },
		);
		const project = resolve(
			credentialSandbox,
			{ resource: "credential.task.project", source: "rpc", credentialNames: ["GITHUB_TOKEN"], targetId: "target_sandbox" },
			{ sandbox: base },
		);
		const renew = resolve(
			credentialSandbox,
			{ resource: "credential.task.renew", source: "rpc", credentialNames: ["GITHUB_TOKEN"], targetId: "target_sandbox" },
			{ sandbox: base },
		);
		const revoke = resolve(
			credentialSandbox,
			{ resource: "credential.task.revoke", source: "rpc", credentialNames: ["GITHUB_TOKEN"], targetId: "target_sandbox" },
			{ sandbox: base },
		);
		expect(issue.ok).toBe(true);
		expect(project.ok).toBe(true);
		expect(renew.ok).toBe(true);
		expect(revoke.ok).toBe(true);
		if (issue.ok && project.ok && renew.ok && revoke.ok) {
			expect(issue.decision?.outcome).toBe("allow");
			for (const decision of [project.decision, renew.decision, revoke.decision]) {
				expect(decision).toMatchObject({
					outcome: "deny",
					reasonCode: "sandbox_capability_insufficient",
					hardDeny: true,
				});
			}
		}
	});

	it("allows delivery operations when the sandbox declares credentialDelivery", () => {
		const credentialSandbox: ExecutionPolicyProfile = {
			...sandboxProfile,
			id: "sandbox-cred-full",
			credentials: { action: "allow", allowNames: ["GITHUB_TOKEN"] },
		};
		const base = {
			providerConfigured: true,
			providerStatus: "ready" as const,
			capabilities: {
				filesystem: true,
				process: true,
				network: false,
				credentialIsolation: true,
				credentialDelivery: true,
			},
		};
		const result = resolve(
			credentialSandbox,
			{ resource: "credential.task.project", source: "rpc", credentialNames: ["GITHUB_TOKEN"], targetId: "target_sandbox" },
			{ sandbox: base },
		);
		expect(result.ok).toBe(true);
		if (result.ok) expect(result.decision?.outcome).toBe("allow");
	});

	it("rejects operations with malformed target ids or TTL facts", () => {
		const badTarget = resolve(legacy, { resource: "credential.task.issue", source: "rpc", targetId: "bad/target" });
		const badTtl = resolve(legacy, { resource: "credential.task.issue", source: "rpc", targetId: "target_sandbox", ttlMs: 0 });
		expect(badTarget).toMatchObject({ ok: false, error: { code: "policy_settings_invalid" } });
		expect(badTtl).toMatchObject({ ok: false, error: { code: "policy_settings_invalid" } });
	});

	it("records the exact scope, target, and TTL facts on task credential decisions", () => {
		const allowlisted: ExecutionPolicyProfile = {
			...hostProfile,
			id: "cred-facts",
			credentials: { action: "allow", allowNames: ["GITHUB_TOKEN"] },
		};
		const result = resolve(allowlisted, {
			resource: "credential.task.project",
			source: "rpc",
			credentialNames: ["GITHUB_TOKEN"],
			targetId: "target_sandbox",
			ttlMs: 60_000,
		});
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.decision).toMatchObject({
				outcome: "allow",
				credentialNames: ["GITHUB_TOKEN"],
				targetId: "target_sandbox",
				ttlMs: 60_000,
			});
		}

		// Denied task decisions carry the same facts so a denial can never be
		// mistaken for a different request.
		const denied = resolve(hostProfile, {
			resource: "credential.task.renew",
			source: "rpc",
			credentialNames: ["GITHUB_TOKEN"],
			targetId: "target_sandbox",
			ttlMs: 30_000,
		});
		expect(denied.ok).toBe(true);
		if (denied.ok) {
			expect(denied.decision).toMatchObject({
				outcome: "deny",
				credentialNames: ["GITHUB_TOKEN"],
				targetId: "target_sandbox",
				ttlMs: 30_000,
			});
		}

		// Non-task resources carry no credential facts.
		const other = resolve(legacy, { resource: "filesystem.read", source: "rpc", path: "/tmp/x" });
		expect(other.ok).toBe(true);
		if (other.ok) {
			expect(other.decision).not.toHaveProperty("credentialNames");
			expect(other.decision).not.toHaveProperty("targetId");
			expect(other.decision).not.toHaveProperty("ttlMs");
		}
	});
});

describe("resolveTaskCredentialPreflight", () => {
	it("passes a fully satisfied delivery preflight and reports the bounded TTL", () => {
		expect(resolveTaskCredentialPreflight(makePreflightInput())).toEqual({ allowed: true, boundedTtlMs: 60_000 });
	});

	it("rejects malformed input and binding snapshots before any check", () => {
		expectPreflightDenied({ ...makePreflightInput(), operation: "unknown" as never }, "task_credential_invalid");
		expectPreflightDenied({ ...makePreflightInput(), nowMs: -1 }, "task_credential_invalid");
		expectPreflightDenied({
				...makePreflightInput(),
				binding: { ...makePreflightInput().binding, graphRevision: 0 },
			}, "task_credential_binding_invalid");
		expectPreflightDenied({
				...makePreflightInput(),
				ttlBounds: { minTtlMs: 300_000, maxTtlMs: 10_000 },
			}, "task_credential_invalid");
	});

	it("requires the capability binding to exist and carry the capability binding id", () => {
		const missing = makePreflightInput({ capabilityBinding: undefined as never });
		expectPreflightDenied(missing, "task_credential_invalid");

		// A capability binding from a different execution context is an
		// ownership mismatch, like a wrong session or run id.
		const wrongId = makePreflightInput({ capabilityBinding: { id: "capability_binding_other" } });
		expectPreflightDenied(wrongId, "task_credential_binding_invalid");
	});

	it("rejects malformed, unnormalized, or non-correlating scope facts", () => {
		expectPreflightDenied(makePreflightInput({ scopes: [] }), "task_credential_invalid");
		expectPreflightDenied(makePreflightInput({ scopes: [{ ...PREFLIGHT_SCOPES[0], purpose: "" }] }), "task_credential_invalid");
		// Unnormalized: the same scope duplicated with different casing.
		expectPreflightDenied(makePreflightInput({
					scopes: [
						{ ...PREFLIGHT_SCOPES[0], credentialName: "GITHUB_TOKEN " },
						{ ...PREFLIGHT_SCOPES[0], purpose: "other" },
					],
				}), "task_credential_invalid");
		// Structurally valid but not normalized: the canonical digest matches,
		// yet the list order is not the normalized (sorted) order.
		const otherScope: TaskCredentialScope = { ...PREFLIGHT_SCOPES[0], purpose: "zzz" };
		const unsorted = [otherScope, PREFLIGHT_SCOPES[0]];
		const unsortedDigest = calculateScopeDigest([PREFLIGHT_SCOPES[0], otherScope]);
		expectPreflightDenied(makePreflightInput({ scopes: unsorted, scopeDigest: unsortedDigest, scopeCount: unsorted.length }), "task_credential_invalid");
		expectPreflightDenied(makePreflightInput({ scopeCount: 2 }), "task_credential_invalid");
		expectPreflightDenied(makePreflightInput({ scopeDigest: `sha256:${"b".repeat(64)}` }), "task_credential_invalid");
		expectPreflightDenied(makePreflightInput({ scopeDigest: "not-a-digest" }), "task_credential_invalid");
	});

	it("rejects resolved target facts that address a different target or binding", () => {
		const wrongTarget = makePreflightInput({
			target: { ...TARGET_CAPABILITIES, targetId: "target_other" },
		});
		expectPreflightDenied(wrongTarget, "task_credential_policy_denied");

		// The target snapshot bindingId is the Task Execution Binding id, not
		// the capability binding id: a snapshot addressed to another execution
		// binding, or one still addressed to the capability binding (the old
		// contract), never authorizes the lease.
		const wrongBinding = makePreflightInput({
			target: { ...TARGET_CAPABILITIES, bindingId: "binding_exec_other" },
		});
		expectPreflightDenied(wrongBinding, "task_credential_policy_denied");

		const capabilityBindingAsTarget = makePreflightInput({
			target: { ...TARGET_CAPABILITIES, bindingId: "capability_binding_1" },
		});
		expectPreflightDenied(capabilityBindingAsTarget, "task_credential_policy_denied");

		const malformed = makePreflightInput({ target: { ...TARGET_CAPABILITIES, canRevokeCredential: "yes" as never } });
		expectPreflightDenied(malformed, "task_credential_invalid");
	});

	it("requires the operation-specific target capabilities and per-binding isolation", () => {
		// Builds the preflight input with one target capability disabled; the
		// preflight itself is resolved by `expectPreflightDenied`.
		const without = (flag: keyof TaskCredentialTargetCapabilities, operation: TaskCredentialPreflightInput["operation"]) =>
			makePreflightInput({
				operation,
				decision: makeDecision({ resource: taskCredentialPolicyResource(operation) }),
				target: { ...TARGET_CAPABILITIES, [flag]: false },
			});
		expectPreflightDenied(without("canReceiveShortLivedCredential", "project"), "task_credential_target_unavailable");
		expectPreflightDenied(without("supportsDeliveryReceipt", "project"), "task_credential_target_unavailable");
		expectPreflightDenied(without("canRenewCredential", "renew"), "task_credential_target_unavailable");
		expectPreflightDenied(without("canRevokeCredential", "revoke"), "task_credential_target_unavailable");
		expectPreflightDenied(without("canReceiveShortLivedCredential", "issue"), "task_credential_target_unavailable");
		for (const operation of ["issue", "renew", "project", "revoke"] as const) {
			expectPreflightDenied(without("supportsPerBindingIsolation", operation), "task_credential_target_unavailable");
		}
	});

	it("rejects ownership mismatches for Session, Run, Policy, Graph, and Capability", () => {
		const cases: ReadonlyArray<[string, Partial<TaskCredentialPreflightInput>]> = [
			["session", { sessionId: "session_other" }],
			["run", { runId: "run_other" }],
			["policy", { policyBindingId: "policy-binding:other" }],
			["graph", { graphRevision: 2 }],
			["capability", { capabilityBindingId: "capability_binding_other" }],
		];
		for (const [name, overrides] of cases) {
			expectPreflightDenied(makePreflightInput(overrides), "task_credential_binding_invalid");
			expect(name.length).toBeGreaterThan(0);
		}
	});

	it("requires an approved Gate at the exact stage revision", () => {
		const missing = makePreflightInput({ gate: undefined });
		expectPreflightDenied(missing, "task_credential_gate_required");

		for (const status of ["pending", "rejected", "cancelled"] as const) {
			expectPreflightDenied(makePreflightInput({ gate: { status, stageRevision: 1 } }), "task_credential_gate_required");
		}
		expectPreflightDenied(makePreflightInput({ gate: { status: "approved", stageRevision: 2 } }), "task_credential_gate_required");
	});

	it("does not require a Gate when the binding has no stage pair", () => {
		const input = makePreflightInput({
			binding: { ...makePreflightInput().binding, stageId: undefined, stageRevision: undefined },
		});
		expect(resolveTaskCredentialPreflight(input)).toEqual({ allowed: true, boundedTtlMs: 60_000 });
	});

	it("requires the graph node to be attached", () => {
		expectPreflightDenied(makePreflightInput({ nodeAttached: false }), "task_credential_binding_invalid");
	});

	it("denies policy-denied decisions with the scope/action split", () => {
		const denied = makePreflightInput({ decision: makeDecision({ outcome: "deny", action: "deny", hardDeny: true }) });
		expectPreflightDenied(denied, "task_credential_policy_denied");

		const scopeDenied = makePreflightInput({
			decision: makeDecision({
				outcome: "deny",
				action: "deny",
				hardDeny: true,
				reasonCode: "credential_policy_violation",
			}),
		});
		expectPreflightDenied(scopeDenied, "task_credential_scope_denied");

		const sandboxFailedDecision = makePreflightInput({
			decision: makeDecision({
				outcome: "deny",
				action: "deny",
				hardDeny: true,
				reasonCode: "sandbox_capability_insufficient",
			}),
		});
		expectPreflightDenied(sandboxFailedDecision, "task_credential_target_unavailable");
	});

	it("rejects a decision that does not belong to this binding or operation", () => {
		const wrongBinding = makePreflightInput({
			decision: makeDecision({ bindingId: "policy-binding:other" }),
		});
		expectPreflightDenied(wrongBinding, "task_credential_invalid");

		const wrongResource = makePreflightInput({
			decision: makeDecision({ resource: "credential.task.revoke" }),
		});
		expectPreflightDenied(wrongResource, "task_credential_invalid");
	});

	it("requires the decision to carry exactly the requested scope, target, and TTL facts", () => {
		// A decision that authorized different names, a different target, or a
		// different TTL can never authorize this request; missing facts fail
		// closed the same way.
		const otherNames = makePreflightInput({
			decision: makeDecision({ credentialNames: ["OTHER_TOKEN"] }),
		});
		expectPreflightDenied(otherNames, "task_credential_scope_denied");

		const extraNames = makePreflightInput({
			scopes: [
				PREFLIGHT_SCOPES[0],
				{ ...PREFLIGHT_SCOPES[0], credentialName: "OTHER_TOKEN", purpose: "other" },
			],
			scopeDigest: calculateScopeDigest([
				PREFLIGHT_SCOPES[0],
				{ ...PREFLIGHT_SCOPES[0], credentialName: "OTHER_TOKEN", purpose: "other" },
			]),
			scopeCount: 2,
		});
		expectPreflightDenied(extraNames, "task_credential_scope_denied");

		const missingNames = makePreflightInput({ decision: makeDecision({ credentialNames: undefined }) });
		expectPreflightDenied(missingNames, "task_credential_scope_denied");

		const otherTarget = makePreflightInput({ decision: makeDecision({ targetId: "target_other" }) });
		expectPreflightDenied(otherTarget, "task_credential_policy_denied");

		const missingTarget = makePreflightInput({ decision: makeDecision({ targetId: undefined }) });
		expectPreflightDenied(missingTarget, "task_credential_policy_denied");

		const otherTtl = makePreflightInput({ decision: makeDecision({ ttlMs: 90_000 }) });
		expectPreflightDenied(otherTtl, "task_credential_ttl_invalid");

		const missingTtl = makePreflightInput({ decision: makeDecision({ ttlMs: undefined }) });
		expectPreflightDenied(missingTtl, "task_credential_ttl_invalid");

		// A decision carrying the exact facts still authorizes the request.
		expect(resolveTaskCredentialPreflight(makePreflightInput())).toEqual({ allowed: true, boundedTtlMs: 60_000 });
	});

	it("enforces the scope contract target-kind correlation", () => {
		// The requested scope allowlist restricts which target kinds may
		// receive material: a target whose kind is not permitted by every
		// declaring scope cannot be authorized.
		const wrongKindScope = { ...PREFLIGHT_SCOPES[0], targetKinds: ["vm"] };
		expectPreflightDenied(
			makePreflightInput({
				scopes: [wrongKindScope],
				scopeDigest: calculateScopeDigest([wrongKindScope]),
			}),
			"task_credential_scope_denied",
		);

		const partiallyWrong = makePreflightInput({
			scopes: [
				{ ...PREFLIGHT_SCOPES[0], purpose: "other", targetKinds: ["vm"] },
				PREFLIGHT_SCOPES[0],
			],
			scopeDigest: calculateScopeDigest([
				{ ...PREFLIGHT_SCOPES[0], purpose: "other", targetKinds: ["vm"] },
				PREFLIGHT_SCOPES[0],
			]),
			scopeCount: 2,
		});
		expectPreflightDenied(partiallyWrong, "task_credential_scope_denied");

		// A scope that permits the resolved target kind passes, and an
		// unrestricted scope (empty targetKinds) permits every target kind.
		const matchingKind = makePreflightInput({
			scopes: [{ ...PREFLIGHT_SCOPES[0], targetKinds: ["isolated_sandbox", "vm"] }],
			scopeDigest: calculateScopeDigest([
				{ ...PREFLIGHT_SCOPES[0], targetKinds: ["isolated_sandbox", "vm"] },
			]),
		});
		expect(resolveTaskCredentialPreflight(matchingKind)).toEqual({ allowed: true, boundedTtlMs: 60_000 });

		const unrestricted = makePreflightInput({
			scopes: [{ ...PREFLIGHT_SCOPES[0], targetKinds: [] }],
			scopeDigest: calculateScopeDigest([{ ...PREFLIGHT_SCOPES[0], targetKinds: [] }]),
		});
		expect(resolveTaskCredentialPreflight(unrestricted)).toEqual({ allowed: true, boundedTtlMs: 60_000 });
	});

	it("rejects TTL outside the policy bounds", () => {
		expectPreflightDenied(makePreflightInput({ requestedTtlMs: 5_000 }), "task_credential_ttl_invalid");
		expectPreflightDenied(makePreflightInput({ requestedTtlMs: 400_000 }), "task_credential_ttl_invalid");
	});

	it("never auto-approves an ask decision", () => {
		const ask = makeDecision({ outcome: "ask", action: "ask", reasonCode: "policy_approval_required", hardDeny: false });
		expectPreflightDenied(makePreflightInput({ decision: ask, approvalGranted: false }), "task_credential_approval_required");
		expect(resolveTaskCredentialPreflight(makePreflightInput({ decision: ask, approvalGranted: true }))).toEqual({
			allowed: true,
			boundedTtlMs: 60_000,
		});
	});

	it("enforces the capability-binding target allow/deny lists", () => {
		const denied = makePreflightInput({
			capabilityBinding: { id: "capability_binding_1", deniedTargetIds: ["target_sandbox_1"] },
		});
		expectPreflightDenied(denied, "task_credential_policy_denied");

		const undeclared = makePreflightInput({
			capabilityBinding: { id: "capability_binding_1", allowedTargetIds: ["target_other"] },
		});
		expectPreflightDenied(undeclared, "task_credential_policy_denied");
	});

	it("requires the live per-binding sandbox with isolation and delivery capabilities", () => {
		const noSandbox = makePreflightInput({ sandbox: undefined });
		expectPreflightDenied(noSandbox, "task_credential_target_unavailable");

		const wrongSandboxBinding = makePreflightInput({
			sandbox: { ...makePreflightInput().sandbox!, bindingId: "sandbox-binding:other" },
		});
		expectPreflightDenied(wrongSandboxBinding, "task_credential_target_unavailable");

		const notPerBinding = makePreflightInput({
			sandbox: { ...makePreflightInput().sandbox!, perBinding: false },
		});
		expectPreflightDenied(notPerBinding, "task_credential_target_unavailable");

		const notReady = makePreflightInput({
			sandbox: { ...makePreflightInput().sandbox!, status: "preparing" },
		});
		expectPreflightDenied(notReady, "task_credential_target_unavailable");

		const noIsolation = makePreflightInput({
			sandbox: {
				...makePreflightInput().sandbox!,
				capabilities: { ...makePreflightInput().sandbox!.capabilities, credentialIsolation: false },
			},
		});
		expectPreflightDenied(noIsolation, "task_credential_target_unavailable");

		const noDelivery = makePreflightInput({
			sandbox: {
				...makePreflightInput().sandbox!,
				capabilities: { ...makePreflightInput().sandbox!.capabilities, credentialDelivery: false },
			},
		});
		expectPreflightDenied(noDelivery, "task_credential_target_unavailable");
	});

	it("needs only isolation for issue but delivery for renew/revoke", () => {
		const isolationOnly = makePreflightInput({
			sandbox: {
				...makePreflightInput().sandbox!,
				capabilities: { ...makePreflightInput().sandbox!.capabilities, credentialDelivery: false },
			},
		});
		expect(
			resolveTaskCredentialPreflight({
				...isolationOnly,
				operation: "issue",
				decision: makeDecision({ resource: "credential.task.issue" }),
			}),
		).toEqual({ allowed: true, boundedTtlMs: 60_000 });
		expectPreflightDenied({
				...isolationOnly,
				operation: "renew",
				decision: makeDecision({ resource: "credential.task.renew" }),
			}, "task_credential_target_unavailable");
		expectPreflightDenied({
				...isolationOnly,
				operation: "revoke",
				decision: makeDecision({ resource: "credential.task.revoke" }),
			}, "task_credential_target_unavailable");
	});

	it("fails when the requested TTL cannot fit before the earliest deadline", () => {
		const passedDeadline = makePreflightInput({ ttlBounds: { minTtlMs: 10_000, maxTtlMs: 300_000, deadlineAtMs: NOW_MS } });
		expectPreflightDenied(passedDeadline, "task_credential_ttl_invalid");

		const tooLong = makePreflightInput({
			requestedTtlMs: 200_000,
			ttlBounds: { minTtlMs: 10_000, maxTtlMs: 300_000, deadlineAtMs: NOW_MS + 100_000 },
		});
		expectPreflightDenied(tooLong, "task_credential_ttl_invalid");
	});

	it("fails closed when the provider scope is missing", () => {
		expectPreflightDenied(makePreflightInput({ provider: { available: false, declaresDelivery: true } }), "task_credential_provider_unavailable");
		const noDelivery = makePreflightInput({ provider: { available: true, declaresDelivery: false } });
		expectPreflightDenied(noDelivery, "task_credential_target_unavailable");
		expect(
			resolveTaskCredentialPreflight({
				...noDelivery,
				operation: "issue",
				decision: makeDecision({ resource: "credential.task.issue" }),
			}),
		).toEqual({ allowed: true, boundedTtlMs: 60_000 });
	});

	it("bounds the success TTL to the requested TTL within the policy ceiling and deadline", () => {
		const bounded = makePreflightInput({
			requestedTtlMs: 90_000,
			decision: makeDecision({ ttlMs: 90_000 }),
			ttlBounds: { minTtlMs: 10_000, maxTtlMs: 300_000, deadlineAtMs: NOW_MS + 100_000 },
		});
		expect(resolveTaskCredentialPreflight(bounded)).toEqual({ allowed: true, boundedTtlMs: 90_000 });
	});

	it("is read-only: it never writes and never calls the provider", () => {
		const input = makePreflightInput();
		const result = resolveTaskCredentialPreflight(input);
		expect(result).toEqual({ allowed: true, boundedTtlMs: 60_000 });
		expect(Object.isFrozen(result)).toBe(false);
		expect(input.sandbox).toBeDefined();
		expect(input.provider.available).toBe(true);
	});
});
