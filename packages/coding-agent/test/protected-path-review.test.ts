import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
	createBindingEpoch,
	createModelProfileRevision,
	createRoleRevision,
	fingerprintFoundationValue,
	resolveAgentBinding,
	type AgentHarness,
	type RevisionReference,
	type TaskEnvelope,
	type ToolGatewayRequest,
	type ToolGatewayRoute,
} from "@aos-agent/agent-core";
import { AgentSession } from "../src/core/agent-session.ts";
import { buildCapabilitySettings } from "../src/core/capability-settings.ts";
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
import {
	FoundationControlPlane,
	type FoundationControlPlaneOptions,
} from "../src/core/foundation-control-plane.ts";
import { resolveHostPathForPolicy } from "../src/core/policy-filesystem.ts";
import { classifyExternalToolPolicyOperation } from "../src/core/external-tool-policy-operation.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { createTestResourceLoader } from "./utilities.ts";

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

	getSessionId(): string {
		return "session-protected-review";
	}

	appendCustomEntry(customType: string, data?: unknown): string {
		const id = `entry-${this.entries.length + 1}`;
		this.entries.push({ id, type: "custom", customType, data });
		return id;
	}

	getEntries(): ReadonlyArray<PolicyLedgerSessionEntry> {
		return this.entries;
	}
}

interface ReviewCanonicalSession {
	readonly facts: Map<string, { readonly kind: "fact"; readonly payload: unknown }>;
	readonly session: NonNullable<FoundationControlPlaneOptions["canonicalSession"]>;
}

function reviewCanonicalSession(): ReviewCanonicalSession {
	const facts = new Map<string, { readonly kind: "fact"; readonly payload: unknown }>();
	return {
		facts,
		session: {
			getFoundationObject: async (objectType: string, objectId: string) => facts.get(`${objectType}:${objectId}`),
		} as unknown as NonNullable<FoundationControlPlaneOptions["canonicalSession"]>,
	};
}

function immutableFact(type: string, id: string): RevisionReference {
	const value = { schemaVersion: 1 as const, type, id, revision: 1 };
	return { ...value, fingerprint: fingerprintFoundationValue(value) };
}

function createReviewControlPlane(
	workspace: string,
	session: MemorySession,
	canonical: ReviewCanonicalSession,
): FoundationControlPlane {
	const capabilitySettings = buildCapabilitySettings({ global: {}, projectTrusted: true });
	const executionPolicySettings = buildExecutionPolicySettings({
		system: {
			executionPolicy: {
				defaultProfile: profile.id,
				profiles: { [profile.id]: profile },
			},
		},
	});
	const harness = {
		toolsSnapshot: [],
		activeToolNamesSnapshot: [],
		setTools: async () => undefined,
		setActiveTools: async () => undefined,
		recordCustomEntry: (customType: string, data: unknown) => session.appendCustomEntry(customType, data),
	} as unknown as AgentHarness;
	return new FoundationControlPlane({
		harness,
		canonicalSession: canonical.session,
		sessionManager: SessionManager.inMemory(workspace),
		sessionLedger: session as unknown as NonNullable<FoundationControlPlaneOptions["sessionLedger"]>,
		settingsManager: {
			getCapabilitySettings: () => capabilitySettings,
			getExecutionPolicySettings: () => executionPolicySettings,
			isProjectTrusted: () => true,
		} as unknown as FoundationControlPlaneOptions["settingsManager"],
		resourceLoader: createTestResourceLoader(),
		modelRuntime: {} as FoundationControlPlaneOptions["modelRuntime"],
		extensionRunner: {
			getAllRegisteredTools: () => [],
		} as unknown as FoundationControlPlaneOptions["extensionRunner"],
		cwd: workspace,
		agentDir: workspace,
	});
}

function installGatewayFoundationFacts(
	controlPlane: FoundationControlPlane,
	canonical: ReviewCanonicalSession,
): void {
	const policyBinding = controlPlane.getActiveExecutionPolicyBinding();
	if (policyBinding === undefined) throw new Error("policy binding is required");
	const now = policyBinding.createdAt;
	const task: TaskEnvelope = {
		schemaVersion: 1,
		taskId: "task-product-policy",
		goalId: "goal-product-policy",
		goal: "Exercise reviewer policy evidence",
		workspace: "workspace-product-policy",
		capabilityRefs: [],
		inputs: [],
		expectedOutputs: [],
		budget: {},
		acceptanceCriteria: [],
		status: "ready",
		createdAt: now,
		updatedAt: now,
	};
	const role = createRoleRevision({
		definition: {
			schemaVersion: 1,
			roleId: "role-product-policy",
			scope: "project",
			slug: "product-policy",
			name: "Product policy",
			description: "Exercise reviewer policy evidence",
			revision: 1,
			persona: "Exercise reviewer policy evidence.",
			modelProfileRef: { schemaVersion: 1, type: "model_profile", id: "model-product-policy", revision: 1 },
			capabilitySelector: { policy: "all" },
			skillSelector: { policy: "none" },
			mcpSelector: { policy: "none" },
		},
		now: () => now,
	});
	const modelProfile = createModelProfileRevision({
		schemaVersion: 1,
		modelProfileId: "model-product-policy",
		provider: "host-model",
		model: "model-1",
		budget: {},
		revision: 1,
		createdAt: now,
	});
	const policyRevision: RevisionReference = {
		schemaVersion: 1,
		type: "policy_binding",
		id: policyBinding.id,
		revision: 1,
		fingerprint: fingerprintFoundationValue(policyBinding),
	};
	const binding = resolveAgentBinding({
		task,
		roleRevision: role,
		modelProfile,
		contextRevision: immutableFact("external_agent_binding", "context-product-policy"),
		capabilityRevision: immutableFact("capability_binding", "capability-product-policy"),
		modelBrokerBindingRevision: immutableFact("model_broker_binding", "broker-product-policy"),
		policyRevision,
		newBindingId: "binding-product-policy",
		now: () => now,
	});
	if (!binding.ok) throw binding.error;
	const epoch = createBindingEpoch({
		bindingEpochId: "epoch-product-policy",
		taskId: task.taskId,
		attemptId: "attempt-product-policy",
		bindingId: binding.value.bindingId,
		activationReason: "attempt_started",
		activatedByCommandId: "dispatch-product-policy",
		now: () => now,
	});
	if (!epoch.ok) throw epoch.error;
	canonical.facts.set(`agent_binding:${binding.value.bindingId}`, { kind: "fact", payload: binding.value });
	canonical.facts.set(`binding_epoch:${epoch.value.bindingEpochId}`, { kind: "fact", payload: epoch.value });
	canonical.facts.set(`policy_binding:${policyBinding.id}`, { kind: "fact", payload: policyBinding });
}

async function createReviewFixture(): Promise<{
	readonly workspace: string;
	readonly ledger: MemorySession;
	readonly canonical: ReviewCanonicalSession;
	readonly controlPlane: FoundationControlPlane;
}> {
	const workspace = await mkdtemp(join(tmpdir(), "aos-review-control-plane-"));
	const ledger = new MemorySession();
	const canonical = reviewCanonicalSession();
	const controlPlane = createReviewControlPlane(workspace, ledger, canonical);
	await controlPlane.whenCapabilitiesReady("run-product-policy");
	installGatewayFoundationFacts(controlPlane, canonical);
	return { workspace, ledger, canonical, controlPlane };
}

function onlyPendingReview(controlPlane: FoundationControlPlane) {
	const pending = controlPlane.getPendingExecutionPolicyApprovals();
	expect(pending).toHaveLength(1);
	const approval = pending[0];
	if (approval === undefined) throw new Error("pending review is required");
	return approval;
}

function timestampAfter(timestamp: string, offsetMs = 1_000): string {
	return new Date(Date.parse(timestamp) + offsetMs).toISOString();
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

describe("Foundation reviewer evidence integration", () => {
	it("publishes the reviewer API, isolates approved scopes, and replays them after restart", async () => {
		expect(typeof AgentSession.prototype.resolveExecutionPolicyReview).toBe("function");
		const fixture = await createReviewFixture();
		let restarted: FoundationControlPlane | undefined;
		try {
			const first = gatewayRequest("workspace.write", { path: ".config/first.json", content: "first" });
			const second = gatewayRequest("workspace.write", { path: ".config/second.json", content: "second" });
			const route = gatewayRoute("local", "workspace.write");

			await expect(fixture.controlPlane.authorizeExternalToolGatewayRequest(first, route)).rejects.toMatchObject({
				code: "external_tool_route_denied",
			});
			const firstApproval = onlyPendingReview(fixture.controlPlane);
			expect(firstApproval.reviewRequirement).toBe("reviewer");
			expect(() => fixture.controlPlane.approveExecutionPolicyRequest(firstApproval.id)).toThrow(
				expect.objectContaining({ code: "policy_review_evidence_invalid" }),
			);
			const firstEvidence = fixture.controlPlane.resolveExecutionPolicyReview(
				firstApproval.id,
				{ kind: "user", id: "alice" },
				"approved",
				timestampAfter(firstApproval.createdAt),
			);
			expect(firstEvidence).toMatchObject({
				requestId: firstApproval.id,
				bindingId: firstApproval.bindingId,
				scopeDigest: firstApproval.scopeDigest,
			});
			await expect(fixture.controlPlane.authorizeExternalToolGatewayRequest(first, route)).resolves.toBeUndefined();

			await expect(fixture.controlPlane.authorizeExternalToolGatewayRequest(second, route)).rejects.toMatchObject({
				code: "external_tool_route_denied",
			});
			const secondApproval = onlyPendingReview(fixture.controlPlane);
			expect(secondApproval.id).not.toBe(firstApproval.id);
			fixture.controlPlane.resolveExecutionPolicyReview(
				secondApproval.id,
				{ kind: "user", id: "alice" },
				"approved",
				timestampAfter(secondApproval.createdAt, 2_000),
			);
			await expect(fixture.controlPlane.authorizeExternalToolGatewayRequest(second, route)).resolves.toBeUndefined();
			await expect(fixture.controlPlane.authorizeExternalToolGatewayRequest(first, route)).resolves.toBeUndefined();

			restarted = createReviewControlPlane(fixture.workspace, fixture.ledger, fixture.canonical);
			await expect(restarted.authorizeExternalToolGatewayRequest(first, route)).resolves.toBeUndefined();
			await expect(restarted.authorizeExternalToolGatewayRequest(second, route)).resolves.toBeUndefined();
			const postRestart = gatewayRequest("workspace.write", { path: ".config/post-restart.json", content: "third" });
			await expect(restarted.authorizeExternalToolGatewayRequest(postRestart, route)).rejects.toMatchObject({
				code: "external_tool_route_denied",
			});
			const postRestartApproval = onlyPendingReview(restarted);
			restarted.resolveExecutionPolicyReview(
				postRestartApproval.id,
				{ kind: "user", id: "alice" },
				"approved",
				timestampAfter(postRestartApproval.createdAt, 3_000),
			);
			await expect(restarted.authorizeExternalToolGatewayRequest(postRestart, route)).resolves.toBeUndefined();
		} finally {
			await restarted?.dispose();
			await fixture.controlPlane.dispose();
			await rm(fixture.workspace, { recursive: true, force: true });
		}
	});

	it("rejects stale and wrong reviewers while preserving reviewer and team rejections", async () => {
		const fixture = await createReviewFixture();
		try {
			const route = gatewayRoute("local", "workspace.write");
			const reviewerRequest = gatewayRequest("workspace.write", { path: ".config/rejected.json", content: "blocked" });
			await expect(fixture.controlPlane.authorizeExternalToolGatewayRequest(reviewerRequest, route)).rejects.toMatchObject({
				code: "external_tool_route_denied",
			});
			const reviewerApproval = onlyPendingReview(fixture.controlPlane);
			expect(() => fixture.controlPlane.resolveExecutionPolicyReview(
				reviewerApproval.id,
				{ kind: "user", id: "bob" },
				"approved",
				timestampAfter(reviewerApproval.createdAt),
			)).toThrow(expect.objectContaining({ code: "policy_review_evidence_invalid" }));
			expect(() => fixture.controlPlane.resolveExecutionPolicyReview(
				reviewerApproval.id,
				{ kind: "user", id: "alice" },
				"approved",
				new Date(Date.parse(reviewerApproval.createdAt) - 1).toISOString(),
			)).toThrow(expect.objectContaining({ code: "policy_review_evidence_invalid" }));
			fixture.controlPlane.resolveExecutionPolicyReview(
				reviewerApproval.id,
				{ kind: "user", id: "alice" },
				"rejected",
				timestampAfter(reviewerApproval.createdAt, 2_000),
			);
			await expect(fixture.controlPlane.authorizeExternalToolGatewayRequest(reviewerRequest, route)).rejects.toMatchObject({
				code: "external_tool_route_denied",
			});

			const teamRequest = gatewayRequest("workspace.write", { path: ".git/config", content: "blocked" });
			await expect(fixture.controlPlane.authorizeExternalToolGatewayRequest(teamRequest, route)).rejects.toMatchObject({
				code: "external_tool_route_denied",
			});
			const teamApproval = onlyPendingReview(fixture.controlPlane);
			expect(teamApproval.reviewRequirement).toBe("team_enforced");
			expect(() => fixture.controlPlane.resolveExecutionPolicyReview(
				teamApproval.id,
				{ kind: "team", id: "other-team" },
				"approved",
				timestampAfter(teamApproval.createdAt),
			)).toThrow(expect.objectContaining({ code: "policy_review_evidence_invalid" }));
			fixture.controlPlane.resolveExecutionPolicyReview(
				teamApproval.id,
				{ kind: "team", id: "security" },
				"rejected",
				timestampAfter(teamApproval.createdAt, 2_000),
			);
			await expect(fixture.controlPlane.authorizeExternalToolGatewayRequest(teamRequest, route)).rejects.toMatchObject({
				code: "external_tool_route_denied",
			});
		} finally {
			await fixture.controlPlane.dispose();
			await rm(fixture.workspace, { recursive: true, force: true });
		}
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
