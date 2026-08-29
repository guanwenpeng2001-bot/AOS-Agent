import { describe, expect, it } from "vitest";
import {
	EXECUTION_POLICY_SCHEMA_VERSION,
	POLICY_DEFAULT_PROFILE,
	PolicyError,
	freezePolicyProfile,
	type ApprovalPolicy,
	type ExecutionPolicyProfile,
	resolveExecutionPolicy,
} from "../src/core/policy/execution.ts";

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

describe("execution policy resolver", () => {
	it("uses the last matching rule while keeping the default for unmatched resources", () => {
		const profile: ExecutionPolicyProfile = {
			...hostProfile,
			id: "rules",
			defaultAction: "deny",
			rules: [
				{ resource: "capability.invoke", action: "ask" },
				{ resource: "capability.invoke", action: "allow" },
			],
		};
		const matched = resolve(profile, { resource: "capability.invoke", source: "builtin", id: "request-1" });
		const unmatched = resolve(profile, { resource: "filesystem.read", source: "builtin", scope: "workspace" });

		expect(matched.ok).toBe(true);
		expect(unmatched.ok).toBe(true);
		if (matched.ok && unmatched.ok) {
			expect(matched.decision?.outcome).toBe("allow");
			expect(unmatched.decision?.outcome).toBe("deny");
			expect(unmatched.decision?.reasonCode).toBe("policy_denied");
		}
	});

	it("selects the explicit profile and falls back to immutable legacy defaults", () => {
		const selected = resolveExecutionPolicy({
			profiles: { legacy, "host-safe": hostProfile },
			defaultProfile: "host-safe",
			policyProfile: "legacy",
			operation: { resource: "capability.invoke", source: "builtin" },
		});
		const fallback = resolveExecutionPolicy({ operation: { resource: "capability.invoke", source: "builtin" } });

		expect(selected.ok).toBe(true);
		expect(fallback.ok).toBe(true);
		if (selected.ok && fallback.ok) {
			expect(selected.profile.id).toBe("legacy");
			expect(selected.decision?.outcome).toBe("allow");
			expect(fallback.profile.id).toBe("legacy");
			expect(fallback.binding.enforcement).toBe("legacy");
			expect(fallback.summary.enforcement).toBe("legacy");
		}
	});

	it("returns hard-deny reasons for boundary and explicit credential denials", () => {
		const filesystem = resolve(hostProfile, {
			resource: "filesystem.write",
			source: "builtin",
			scope: "credentials",
			path: "C:\\private\\token.txt",
		});
		const credential = resolve(hostProfile, {
			resource: "credential.expose",
			source: "mcp",
			credentialNames: ["MODEL_TOKEN"],
		});

		expect(filesystem.ok).toBe(true);
		expect(credential.ok).toBe(true);
		if (filesystem.ok && credential.ok) {
			expect(filesystem.decision).toMatchObject({
				outcome: "deny",
				reasonCode: "workspace_boundary_violation",
				hardDeny: true,
			});
			expect(credential.decision).toMatchObject({
				outcome: "deny",
				reasonCode: "credential_policy_violation",
				hardDeny: true,
			});
			expect(credential.decision).not.toHaveProperty("approval");
		}
	});

	it("creates an approval request before any side effect and keeps it safe", () => {
		const result = resolve(hostProfile, {
			resource: "process.spawn",
			source: "user_bash",
			id: "request-process",
			command: "cat C:\\private\\secret.txt",
			cwd: "C:\\private",
			environmentNames: ["PATH"],
		});

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.decision).toMatchObject({ action: "ask", outcome: "ask", reasonCode: "policy_approval_required" });
			expect(result.approval).toMatchObject({ id: "request-process", resource: "process.spawn" });
			expect(JSON.stringify(result.approval)).not.toContain("secret.txt");
			expect(result.binding.sandboxStatus).toBe("not_required");
		}
	});

	it("accepts Windows environment names exposed by Node", () => {
		const result = resolve(legacy, {
			resource: "process.spawn",
			source: "user_bash",
			command: "echo ok",
			cwd: "C:\\workspace",
			environmentNames: ["PATH", "ProgramFiles(x86)"],
		});

		expect(result.ok).toBe(true);
	});

	it("rejects malformed profiles instead of best-effort allowing them", () => {
		const result = resolveExecutionPolicy({
			profiles: {
				broken: {
					...hostProfile,
					id: "broken",
					process: { action: "maybe", inheritEnvironment: false, allowEnvironment: [] },
				},
			},
			defaultProfile: "broken",
			operation: { resource: "capability.invoke", source: "builtin" },
		});

		expect(result).toMatchObject({ ok: false, error: { code: "policy_settings_invalid", retryable: false } });
	});

	it("allows project narrowing and rejects project expansion, including for untrusted projects", () => {
		const narrowed = resolveExecutionPolicy({
			profiles: { "host-safe": hostProfile },
			defaultProfile: "host-safe",
			projectTrusted: false,
			projectProfile: { process: { action: "deny" } },
			operation: { resource: "process.spawn", source: "extension" },
		});
		const widened = resolveExecutionPolicy({
			profiles: { "host-safe": hostProfile },
			defaultProfile: "host-safe",
			projectTrusted: false,
			projectProfile: { network: { action: "allow", allowDestinations: ["example.invalid"] } },
			operation: { resource: "network.connect", source: "extension", destination: "example.invalid" },
		});

		expect(narrowed.ok).toBe(true);
		if (narrowed.ok) expect(narrowed.decision).toMatchObject({ outcome: "deny", reasonCode: "policy_denied" });
		expect(widened).toMatchObject({ ok: false, error: { code: "policy_profile_untrusted" } });
	});

	it("honors capability binding denies and never turns them into approval", () => {
		const result = resolve(hostProfile, { resource: "capability.invoke", source: "mcp", capabilityId: "mcp:docs:read" }, {
			capabilityBinding: { id: "capability-binding-test", allowed: false },
		});

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.decision).toMatchObject({ outcome: "deny", reasonCode: "policy_denied", hardDeny: true });
			expect(result.decision).not.toHaveProperty("approval");
		}
	});

	it("fails closed with sandbox_required when strict execution has no provider", () => {
		const result = resolve(sandboxProfile, { resource: "process.spawn", source: "user_bash" });

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.decision).toMatchObject({
				action: "deny",
				outcome: "sandbox_required",
				reasonCode: "sandbox_required",
				hardDeny: true,
			});
			expect(result.decision).not.toHaveProperty("approval");
		}
	});

	it("does not fall back when a strict provider is unavailable or incomplete", () => {
		const unavailable = resolve(
			sandboxProfile,
			{ resource: "network.connect", source: "mcp", destination: "example.invalid" },
			{ sandbox: { providerConfigured: true, providerStatus: "unavailable" } },
		);
		const incomplete = resolve(
			sandboxProfile,
			{ resource: "process.spawn", source: "user_bash" },
			{
				sandbox: {
					providerConfigured: true,
					providerStatus: "ready",
					providerCapabilitiesComplete: false,
				},
			},
		);

		expect(unavailable.ok).toBe(true);
		expect(incomplete.ok).toBe(true);
		if (unavailable.ok && incomplete.ok) {
			expect(unavailable.decision).toMatchObject({ outcome: "deny", reasonCode: "sandbox_unavailable" });
			expect(incomplete.decision).toMatchObject({ outcome: "deny", reasonCode: "sandbox_capability_insufficient" });
		}
	});

	it("freezes bindings and summaries without leaking operation data", () => {
		const operation = {
			resource: "filesystem.read",
			source: "builtin",
			scope: "workspace",
			path: "C:\\private\\secret.txt",
		};
		const result = resolve(legacy, operation);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(EXECUTION_POLICY_SCHEMA_VERSION).toBe(1);
			expect(Object.isFrozen(result.profile)).toBe(true);
			expect(Object.isFrozen(result.binding)).toBe(true);
			expect(Object.isFrozen(result.binding.constraints.workspace.read)).toBe(true);
			expect(Object.isFrozen(result.summary)).toBe(true);
			expect(JSON.stringify(result.summary)).not.toContain("secret.txt");
		}
		(operation as { scope: "workspace" | "declared-read-only" | "temporary" | "credentials" | "agent-internal" }).scope = "temporary";
		if (result.ok) expect(result.binding.constraints.workspace.read).toEqual(["workspace", "declared-read-only"]);
	});

	it("maps policy errors to fixed non-retryable views", () => {
		const error = new PolicyError("policy_denied", "raw command should never be public");
		expect(error.toJSON()).toEqual({
			code: "policy_denied",
			message: "The operation was denied by execution policy.",
			retryable: false,
		});
	});
});

describe("MCP auth and content operation policy", () => {
	const MCP_OPERATIONS = ["mcp.auth", "resource.list", "resource.read", "prompt.list", "prompt.get", "context.attach"] as const;

	it("resolves the new operations through the default action and rules", () => {
		const denied = resolve(hostProfile, { resource: "resource.read", source: "mcp" });
		expect(denied.ok).toBe(true);
		if (denied.ok) {
			expect(denied.decision).toMatchObject({ resource: "resource.read", outcome: "deny", reasonCode: "policy_denied" });
		}

		const profile: ExecutionPolicyProfile = {
			...hostProfile,
			id: "content-rules",
			rules: MCP_OPERATIONS.map((resource) => ({ resource, action: "allow" })),
		};
		for (const resource of MCP_OPERATIONS) {
			const result = resolve(profile, { resource, source: "mcp" });
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.decision).toMatchObject({ resource, outcome: "allow" });
			}
		}
	});

	it("creates safe approval requests for ask decisions on the new operations", () => {
		const profile: ExecutionPolicyProfile = {
			...hostProfile,
			id: "content-ask",
			rules: MCP_OPERATIONS.map((resource) => ({ resource, action: "ask" })),
		};
		for (const resource of MCP_OPERATIONS) {
			const result = resolve(profile, { resource, source: "mcp" });
			expect(result.ok).toBe(true);
			if (result.ok) {
				expect(result.decision).toMatchObject({
					resource,
				action: "ask",
				outcome: "ask",
				reasonCode: "policy_approval_required",
				hardDeny: false,
			});
				expect(result.approval).toMatchObject({ resource });
			}
		}
	});

	it("maps the new approval policy keys to their operation groups", () => {
		const profile: ExecutionPolicyProfile = {
			...legacy,
			id: "content-approvals",
			approvals: {
				...legacy.approvals,
				mcp: "ask",
				resource: "ask",
				prompt: "ask",
				context: "ask",
			},
		};
		const cases: ReadonlyArray<[string, keyof ApprovalPolicy]> = [
			["mcp.auth", "mcp"],
			["resource.list", "resource"],
			["resource.read", "resource"],
			["prompt.list", "prompt"],
			["prompt.get", "prompt"],
			["context.attach", "context"],
		];
		for (const [resource, key] of cases) {
			const result = resolve(profile, { resource, source: "mcp" });
			expect(result.ok).toBe(true);
			if (result.ok) {
				// The ask decision comes from the matching approval key, not from a rule.
				expect(profile.approvals[key]).toBe("ask");
				expect(result.decision).toMatchObject({ resource, action: "ask", outcome: "ask" });
			}
		}
	});

	it("freezes profiles that carry the new approval keys", () => {
		const profile: ExecutionPolicyProfile = {
			...hostProfile,
			id: "content-freeze",
			approvals: {
				...hostProfile.approvals,
				mcp: "deny",
				resource: "ask",
				prompt: "ask",
				context: "deny",
			},
		};
		const frozen = freezePolicyProfile(profile);
		expect(frozen.approvals).toMatchObject({ mcp: "deny", resource: "ask", prompt: "ask", context: "deny" });
		expect(Object.isFrozen(frozen)).toBe(true);
	});

	it("rejects a project narrowing that widens the new approval keys", () => {
		const base: ExecutionPolicyProfile = {
			...hostProfile,
			id: "content-base",
			approvals: { ...hostProfile.approvals, resource: "ask" },
		};
		const widened = resolveExecutionPolicy({
			profiles: { "content-base": base },
			defaultProfile: "content-base",
			projectTrusted: false,
			projectProfile: { approvals: { resource: "allow" } },
			operation: { resource: "resource.read", source: "mcp" },
		});
		expect(widened).toMatchObject({ ok: false, error: { code: "policy_profile_untrusted" } });

		const narrowed = resolveExecutionPolicy({
			profiles: { "content-base": base },
			defaultProfile: "content-base",
			projectTrusted: false,
			projectProfile: { approvals: { resource: "deny" } },
			operation: { resource: "resource.read", source: "mcp" },
		});
		expect(narrowed.ok).toBe(true);
		if (narrowed.ok) {
			expect(narrowed.decision).toMatchObject({ outcome: "deny", reasonCode: "policy_denied" });
		}
	});
});
