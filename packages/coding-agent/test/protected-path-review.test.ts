import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { ToolGatewayRequest, ToolGatewayRoute } from "@aos-agent/agent-core";
import {
	POLICY_EFFECTS,
	createPolicyReviewEvidence,
	type ExecutionPolicyProfile,
	resolveExecutionPolicy,
} from "../src/core/execution-policy.ts";
import {
	createExecutionPolicyLedger,
	POLICY_APPROVAL_CUSTOM_TYPE,
	type PolicyLedgerSession,
	type PolicyLedgerSessionEntry,
} from "../src/core/execution-policy-ledger.ts";
import { buildExecutionPolicySettings, ExecutionPolicySettingsError } from "../src/core/execution-policy-settings.ts";
import { resolveHostPathForPolicy } from "../src/core/policy-filesystem.ts";
import { classifyExternalToolPolicyOperation } from "../src/core/external-tool-policy-operation.ts";

const protectedPaths = {
	rules: [
		{ id: "env-lock", pattern: ".env", effects: ["write", "create", "delete"], requirement: "approval" },
		{ id: "config-review", pattern: ".config/**", effects: ["write", "create", "delete", "move"], requirement: "reviewer", reviewerIds: ["alice"] },
		{ id: "git-team", pattern: ".git/**", effects: ["write", "create", "delete", "move", "commit", "merge"], requirement: "team_enforced", teamId: "security" },
	],
	managedLocks: ["git-team"],
} as const;

const profile: ExecutionPolicyProfile = {
	id: "protected",
	enforcement: "host",
	defaultAction: "allow",
	workspace: { read: ["workspace"], write: ["workspace"], deny: [] },
	process: { action: "allow", inheritEnvironment: false, allowEnvironment: [] },
	network: { action: "allow", allowDestinations: [] },
	credentials: { action: "deny", allowNames: [] },
	approvals: { writeOutsideWorkspace: "deny", network: "allow", process: "allow" },
	protectedPaths,
};

function resolveProtected(
	canonicalPath: string,
	effects?: ReadonlyArray<(typeof POLICY_EFFECTS)[number]>,
	reviewEvidence?: Parameters<typeof resolveExecutionPolicy>[0]["reviewEvidence"],
) {
	return resolveExecutionPolicy({
		profiles: { [profile.id]: profile },
		defaultProfile: profile.id,
		bindingId: "policy-binding-protected",
		runId: "run-protected",
		workspaceIdentity: "workspace-protected",
		createdAt: "2026-08-28T01:00:00.000Z",
		operation: {
			resource: "filesystem.write",
			source: "sdk",
			scope: "workspace",
			canonicalPath,
			...(effects === undefined ? {} : { effects }),
		},
		reviewEvidence,
	});
}

class MemorySession implements PolicyLedgerSession {
	readonly entries: PolicyLedgerSessionEntry[] = [];

	appendCustomEntry(customType: string, data?: unknown): string {
		const id = `entry-${this.entries.length + 1}`;
		this.entries.push({ id, type: "custom", customType, data });
		return id;
	}

	getEntries(): ReadonlyArray<PolicyLedgerSessionEntry> {
		return this.entries;
	}
}

function gatewayRequest(toolName: string, originalArguments: ToolGatewayRequest["originalArguments"]): ToolGatewayRequest {
	return {
		schemaVersion: 1,
		toolCallId: `tool-call-${toolName}`,
		toolName,
		originalArguments,
		context: {
			schemaVersion: 1,
			bindingId: "binding-product-policy",
			bindingEpochId: "epoch-product-policy",
			taskId: "task-product-policy",
			providerId: "external-product-connector",
			attemptId: "attempt-product-policy",
			operationId: "run-product-policy",
		},
	};
}

function gatewayRoute(kind: ToolGatewayRoute["kind"], toolName: string, providerId = "product-local"): ToolGatewayRoute {
	return { kind, namespace: "workspace", toolName, providerId, revision: 1 };
}

describe("canonical protected path classification", () => {
	it("enforces canonical containment through the External Connector product classifier", async () => {
		const root = await mkdtemp(join(tmpdir(), "aos-product-path-"));
		const workspace = join(root, "workspace");
		const outside = join(root, "outside");
		await mkdir(join(workspace, "existing"), { recursive: true });
		await mkdir(outside);
		const linkType = process.platform === "win32" ? "junction" : "dir";
		await symlink(outside, join(workspace, "escape"), linkType);
		try {
			const classify = (targetPath: string) => classifyExternalToolPolicyOperation({
				request: gatewayRequest("workspace.write", { path: targetPath }),
				route: gatewayRoute("local", "workspace.write"),
				cwd: workspace,
				roots: { workspace },
			});

			await expect(classify("../traversal.txt")).rejects.toMatchObject({ code: "workspace_boundary_violation" });
			await expect(classify(join(root, "absolute.txt"))).rejects.toMatchObject({ code: "workspace_boundary_violation" });
			await expect(classify("escape/nonexistent.txt")).rejects.toMatchObject({ code: "workspace_boundary_violation" });
			await expect(classify(join(workspace, "existing", "new", "file.txt"))).resolves.toMatchObject({
				canonicalPath: "existing/new/file.txt",
				effects: ["create"],
			});
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("rejects traversal and outside absolute paths while accepting contained absolute paths", async () => {
		const root = await mkdtemp(join(tmpdir(), "aos-protected-path-"));
		const workspace = join(root, "workspace");
		await mkdir(workspace);
		try {
			await expect(resolveHostPathForPolicy({
				cwd: workspace,
				targetPath: "../escape.txt",
				roots: { workspace },
				access: "write",
			})).rejects.toMatchObject({ code: "workspace_boundary_violation" });
			await expect(resolveHostPathForPolicy({
				cwd: workspace,
				targetPath: join(root, "absolute-escape.txt"),
				roots: { workspace },
				access: "write",
			})).rejects.toMatchObject({ code: "workspace_boundary_violation" });

			const contained = await resolveHostPathForPolicy({
				cwd: workspace,
				targetPath: join(workspace, "nested", "file.txt"),
				roots: { workspace },
				access: "write",
			});
			expect(contained).toMatchObject({ scope: "workspace", canonicalPath: "nested/file.txt" });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("preserves every nonexistent suffix after the nearest real ancestor", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "aos-protected-suffix-"));
		await mkdir(join(workspace, "existing"));
		try {
			const resolvedPath = await resolveHostPathForPolicy({
				cwd: workspace,
				targetPath: "existing/one/two/three.txt",
				roots: { workspace },
				access: "write",
			});
			expect(resolvedPath.existingPath).toBe(false);
			expect(resolvedPath.canonicalPath).toBe("existing/one/two/three.txt");
			expect(resolvedPath.realPath).toBe(resolve(await realpath(join(workspace, "existing")), "one", "two", "three.txt"));
		} finally {
			await rm(workspace, { recursive: true, force: true });
		}
	});

	it("canonicalizes in-workspace symlink aliases and rejects symlink escapes", async () => {
		const root = await mkdtemp(join(tmpdir(), "aos-protected-link-"));
		const workspace = join(root, "workspace");
		const outside = join(root, "outside");
		await mkdir(join(workspace, ".config"), { recursive: true });
		await mkdir(outside);
		await writeFile(join(workspace, ".config", "settings.json"), "{}");
		const linkType = process.platform === "win32" ? "junction" : "dir";
		await symlink(join(workspace, ".config"), join(workspace, "alias"), linkType);
		await symlink(outside, join(workspace, "escape"), linkType);
		try {
			const alias = await resolveHostPathForPolicy({
				cwd: workspace,
				targetPath: "alias/settings.json",
				roots: { workspace },
				access: "write",
			});
			expect(alias.canonicalPath).toBe(".config/settings.json");

			await expect(resolveHostPathForPolicy({
				cwd: workspace,
				targetPath: "escape/new/deep/file.txt",
				roots: { workspace },
				access: "write",
			})).rejects.toMatchObject({ code: "workspace_boundary_violation" });
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe("raw Tool Gateway command policy", () => {
	it("classifies every raw command as potentially mutating and requires the exact ready sandbox", async () => {
		const workspace = await mkdtemp(join(tmpdir(), "aos-product-command-"));
		try {
			const request = gatewayRequest("workspace.bash", { command: "git status" });
			const localOperation = await classifyExternalToolPolicyOperation({
				request,
				route: gatewayRoute("local", "workspace.bash"),
				cwd: workspace,
				roots: { workspace },
			});
			expect(localOperation).toMatchObject({
				resource: "process.spawn",
				requiresSandbox: true,
				sandboxed: false,
				effects: ["write", "create", "delete", "move", "command", "network", "commit", "push", "merge"],
			});

			const rawProfile: ExecutionPolicyProfile = {
				...profile,
				id: "raw-command",
				enforcement: "sandbox",
				sandboxProvider: "product-sandbox",
				protectedPaths: undefined,
			};
			const resolveRaw = (operation: typeof localOperation) => resolveExecutionPolicy({
				profiles: { [rawProfile.id]: rawProfile },
				defaultProfile: rawProfile.id,
				runId: "run-product-command",
				workspaceIdentity: "workspace-product-command",
				createdAt: "2026-08-28T01:00:00.000Z",
				operation,
				sandbox: {
					providerConfigured: true,
					providerId: "product-sandbox",
					providerStatus: "ready",
					providerCapabilities: {
						filesystem: true,
						process: true,
						network: true,
						credentialIsolation: true,
					},
				},
			});
			const denied = resolveRaw(localOperation);
			expect(denied.ok && denied.decision).toMatchObject({
				outcome: "sandbox_required",
				reasonCode: "sandbox_required",
				hardDeny: true,
			});

			const sandboxOperation = await classifyExternalToolPolicyOperation({
				request,
				route: gatewayRoute("sandbox", "workspace.bash", "product-sandbox"),
				cwd: workspace,
				roots: { workspace },
			});
			const allowed = resolveRaw(sandboxOperation);
			expect(allowed.ok && allowed.decision).toMatchObject({ outcome: "allow" });
		} finally {
			await rm(workspace, { recursive: true, force: true });
		}
	});
});

describe("protected path review authority", () => {
	it("uses exact structured effect categories and scope-bound approval ids", () => {
		expect(POLICY_EFFECTS).toEqual(["read", "write", "create", "delete", "move", "command", "network", "commit", "push", "merge"]);
		expect(resolveProtected(".env")).toMatchObject({ ok: false, error: { code: "protected_path_invalid" } });
		const first = resolveProtected(".env", ["write"]);
		const second = resolveProtected(".env", ["delete"]);
		expect(first.ok).toBe(true);
		expect(second.ok).toBe(true);
		if (!first.ok || !second.ok) return;
		expect(first.decision).toMatchObject({ outcome: "ask", reviewRequirement: "approval" });
		expect(first.approval).toMatchObject({ reviewRequirement: "approval", scope: { effectCount: 1, pathCount: 1 } });
		expect(first.approval?.scopeDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
		expect(second.approval?.scopeDigest).not.toBe(first.approval?.scopeDigest);
		expect(second.approval?.id).not.toBe(first.approval?.id);
	});

	it("does not let ordinary approval or wrong-scope reviewer evidence bypass review", () => {
		const pending = resolveProtected(".config/settings.json", ["write"]);
		expect(pending.ok).toBe(true);
		if (!pending.ok || pending.approval === undefined || pending.decision === undefined) return;
		expect(pending.decision).toMatchObject({ outcome: "deny", reasonCode: "policy_review_required", hardDeny: true });

		const ordinaryRetry = resolveProtected(".config/settings.json", ["write"]);
		expect(ordinaryRetry.ok && ordinaryRetry.decision?.outcome).toBe("deny");
		const wrongScope = createPolicyReviewEvidence({
			requestId: pending.approval.id,
			bindingId: pending.binding.id,
			requirement: "reviewer",
			reviewer: { kind: "user", id: "alice" },
			decision: "approved",
			resolvedAt: "2026-08-28T01:01:00.000Z",
			scopeDigest: `sha256:${"0".repeat(64)}`,
		});
		const denied = resolveProtected(".config/settings.json", ["write"], wrongScope);
		expect(denied.ok).toBe(true);
		if (denied.ok) expect(denied.decision).toMatchObject({ outcome: "deny", reasonCode: "policy_review_evidence_invalid" });
	});

	it("accepts safe reviewer evidence and preserves approved/rejected decisions", () => {
		const pending = resolveProtected(".config/settings.json", ["write"]);
		expect(pending.ok).toBe(true);
		if (!pending.ok || pending.approval === undefined) return;
		const approved = createPolicyReviewEvidence({
			requestId: pending.approval.id,
			bindingId: pending.binding.id,
			requirement: "reviewer",
			reviewer: { kind: "user", id: "alice" },
			decision: "approved",
			resolvedAt: "2026-08-28T01:01:00.000Z",
			scopeDigest: pending.approval.scopeDigest!,
		});
		const predated = createPolicyReviewEvidence({ ...approved, resolvedAt: "2026-08-28T00:59:59.999Z" });
		const invalidTimestamp = resolveProtected(".config/settings.json", ["write"], predated);
		expect(invalidTimestamp.ok).toBe(true);
		if (invalidTimestamp.ok) {
			expect(invalidTimestamp.decision).toMatchObject({ outcome: "deny", reasonCode: "policy_review_evidence_invalid" });
		}
		const allowed = resolveProtected(".config/settings.json", ["write"], approved);
		expect(allowed.ok).toBe(true);
		if (allowed.ok) {
			expect(allowed.decision).toMatchObject({ outcome: "allow", reviewRequirement: "reviewer" });
			expect(allowed.decision?.reviewEvidence).toEqual([approved]);
		}

		const rejected = createPolicyReviewEvidence({ ...approved, decision: "rejected", resolvedAt: "2026-08-28T01:02:00.000Z" });
		const blocked = resolveProtected(".config/settings.json", ["write"], rejected);
		expect(blocked.ok).toBe(true);
		if (blocked.ok) expect(blocked.decision).toMatchObject({ outcome: "deny", reasonCode: "policy_review_rejected" });
		expect(() => createPolicyReviewEvidence({ ...approved, reviewer: { kind: "user", id: "unsafe reviewer" } })).toThrow();
	});

	it("requires the managed team identity for team-enforced paths", () => {
		const pending = resolveProtected(".git/config", ["write"]);
		expect(pending.ok).toBe(true);
		if (!pending.ok || pending.approval === undefined) return;
		const wrong = createPolicyReviewEvidence({
			requestId: pending.approval.id,
			bindingId: pending.binding.id,
			requirement: "team_enforced",
			reviewer: { kind: "team", id: "other-team" },
			decision: "approved",
			resolvedAt: "2026-08-28T01:01:00.000Z",
			scopeDigest: pending.approval.scopeDigest!,
		});
		const wrongTeam = resolveProtected(".git/config", ["write"], wrong);
		expect(wrongTeam.ok).toBe(true);
		if (wrongTeam.ok) expect(wrongTeam.decision).toMatchObject({ outcome: "deny", reasonCode: "policy_review_evidence_invalid" });

		const approved = createPolicyReviewEvidence({ ...wrong, reviewer: { kind: "team", id: "security" } });
		const allowed = resolveProtected(".git/config", ["write"], approved);
		expect(allowed.ok).toBe(true);
		if (allowed.ok) expect(allowed.decision?.outcome).toBe("allow");
	});

	it("persists and replays review evidence through the existing Session ledger", () => {
		const pending = resolveProtected(".config/settings.json", ["write"]);
		expect(pending.ok).toBe(true);
		if (!pending.ok || pending.approval === undefined) return;
		const evidence = createPolicyReviewEvidence({
			requestId: pending.approval.id,
			bindingId: pending.binding.id,
			requirement: "reviewer",
			reviewer: { kind: "user", id: "alice" },
			decision: "approved",
			resolvedAt: "2026-08-28T01:03:00.000Z",
			scopeDigest: pending.approval.scopeDigest!,
		});
		const session = new MemorySession();
		const first = createExecutionPolicyLedger(session);
		first.appendApproval(pending.approval);
		first.appendReviewOutcome(pending.approval, evidence);

		const restarted = createExecutionPolicyLedger(session);
		expect(restarted.query({ customType: POLICY_APPROVAL_CUSTOM_TYPE })).toHaveLength(2);
		expect(restarted.reviewEvidence({ requestId: evidence.requestId })).toEqual([evidence]);
		expect(restarted.reviewEvidence()[0]?.resolvedAt).toBe("2026-08-28T01:03:00.000Z");
	});
});

describe("managed protected path settings", () => {
	it("rejects project and user attempts to widen managed requirements", () => {
		const projectWiden = resolveExecutionPolicy({
			profiles: { [profile.id]: profile },
			defaultProfile: profile.id,
			projectTrusted: true,
			projectProfile: {
				protectedPaths: {
					rules: [{ ...protectedPaths.rules[2], requirement: "approval", teamId: undefined }],
				},
			},
		});
		expect(projectWiden).toMatchObject({ ok: false, error: { code: "policy_profile_untrusted" } });

		expect(() => buildExecutionPolicySettings({
			system: { executionPolicy: { defaultProfile: profile.id, profiles: { [profile.id]: profile } } },
			global: {
				executionPolicy: {
					profiles: {
						[profile.id]: {
							...profile,
							protectedPaths: {
								rules: [{ ...protectedPaths.rules[2], requirement: "approval", teamId: undefined }],
							},
						},
					},
				},
			},
		})).toThrow(ExecutionPolicySettingsError);
	});
});
