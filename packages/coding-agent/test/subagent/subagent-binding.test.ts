import { describe, expect, it } from "vitest";
import {
	createRoleRevision,
	createSecretFreeModelProfile,
	createTaskEnvelope,
	fingerprintFoundationValue,
	InMemorySessionStorage,
	resolveAgentBinding,
	resolveMcpSelection,
	selectorsNarrow,
	Session,
	SessionLedger,
	type AgentBinding,
	type ModelProfile,
	type ResourceSelector,
	type RevisionReference,
	type RoleRevision,
	type TaskEnvelope,
} from "../../../agent/src/internal.ts";
import {
	CHILD_BINDING_PROJECTION_FIELDS,
	CHILD_BINDING_PROJECTION_OBJECT_TYPE,
	createMcpInheritanceApprovalAuthority,
	persistChildBindingProjection,
	projectChildBinding,
	validateChildBindingProjection,
	type ChildBindingProjectionField,
	type ProjectChildBindingInput,
	type McpInheritanceApprovalAuthority,
} from "../../src/core/subagent/binding.ts";
import {
	resolveExecutionPolicy,
	type ExecutionPolicyProfile,
	type PolicyApprovalRequest,
} from "../../src/core/policy/execution.ts";
import {
	createExecutionPolicyLedger,
	type PolicyLedgerSession,
	type PolicyLedgerSessionEntry,
} from "../../src/core/policy/execution-ledger.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const ARTIFACT_DIGEST = `sha256:${"ab".repeat(32)}`;
const APPROVED_AT = "2026-01-01T00:01:00.000Z";

class MemoryPolicySession implements PolicyLedgerSession {
	readonly entries: PolicyLedgerSessionEntry[] = [];

	appendCustomEntry(customType: string, data?: unknown): string {
		const id = `policy-entry-${this.entries.length + 1}`;
		this.entries.push({ id, type: "custom", customType, data });
		return id;
	}

	getEntries(): ReadonlyArray<PolicyLedgerSessionEntry> {
		return this.entries;
	}
}

function policyResolution(mcpApproval: "allow" | "ask" | "deny") {
	const profile: ExecutionPolicyProfile = {
		id: `mcp-inheritance-${mcpApproval}`,
		revision: "revision-1",
		enforcement: "host",
		defaultAction: "allow",
		workspace: { read: ["workspace"], write: ["workspace"], deny: [] },
		process: { action: "allow", inheritEnvironment: false, allowEnvironment: [] },
		network: { action: "allow", allowDestinations: [] },
		credentials: { action: "deny", allowNames: [] },
		approvals: { writeOutsideWorkspace: "deny", network: "allow", process: "allow", mcp: mcpApproval },
	};
	const resolved = resolveExecutionPolicy({
		profiles: { [profile.id]: profile },
		defaultProfile: profile.id,
		bindingId: "policy-1",
		runId: "run-mcp-inheritance",
		workspaceIdentity: "workspace-mcp-inheritance",
		createdAt: NOW,
	});
	if (!resolved.ok) throw resolved.error;
	return { profile: resolved.profile, binding: resolved.binding };
}

function policyAuthority(
	mcpApproval: "allow" | "ask" | "deny",
	options: {
		readonly session?: MemoryPolicySession;
		readonly pending?: PolicyApprovalRequest[];
	} = {},
) {
	const session = options.session ?? new MemoryPolicySession();
	const ledger = createExecutionPolicyLedger(session);
	const policy = policyResolution(mcpApproval);
	const authority = createMcpInheritanceApprovalAuthority({
		schemaVersion: 1,
		...policy,
		policyRevision: immutableFact("policy_binding", "policy-1"),
		ledger,
		...(options.pending === undefined ? {} : { onApprovalRequired: (approval: PolicyApprovalRequest) => options.pending?.push(approval) }),
	});
	return { authority, ledger, policy, session };
}

function immutableFact(type: string, id: string, revision = 1): RevisionReference {
	const payload = { schemaVersion: 1 as const, type, id, revision };
	return { ...payload, fingerprint: fingerprintFoundationValue(payload) };
}

function bindingFacts() {
	return {
		contextRevision: immutableFact("external_agent_binding", "external-1"),
		capabilityRevision: immutableFact("capability_binding", "capability-1"),
		modelBrokerBindingRevision: immutableFact("model_broker_binding", "model-broker-1"),
		policyRevision: immutableFact("policy_binding", "policy-1"),
	};
}

function modelProfile(overrides: Partial<Omit<ModelProfile, "fingerprint" | "schemaVersion">> = {}): ModelProfile {
	const result = createSecretFreeModelProfile({
		schemaVersion: 1,
		modelProfileId: "profile-1",
		provider: "fake",
		model: "model-1",
		budget: { tokens: 8000, concurrency: 4 },
		revision: 1,
		createdAt: NOW,
		...overrides,
	});
	if (!result.ok) throw result.error;
	return result.value;
}

function role(overrides: Partial<RoleRevision> & { skillSelector?: ResourceSelector; mcpSelector?: ResourceSelector } = {}): RoleRevision {
	return createRoleRevision({
		definition: {
			schemaVersion: 1,
			roleId: "role-1",
			scope: "project",
			slug: "worker",
			name: "Worker",
			description: "Runs the task",
			revision: 1,
			persona: "You run the task.",
			modelProfileRef: { schemaVersion: 1, type: "model_profile", id: "profile-1", revision: 1 },
			capabilitySelector: { policy: "all" },
			skillSelector: overrides.skillSelector ?? { policy: "all" },
			mcpSelector: overrides.mcpSelector ?? { policy: "none" },
			...(overrides.contextPolicyRef === undefined ? {} : { contextPolicyRef: overrides.contextPolicyRef }),
		},
		now: () => NOW,
	});
}

function task(overrides: Partial<TaskEnvelope> = {}): TaskEnvelope {
	const result = createTaskEnvelope({
		schemaVersion: 1,
		taskId: "task-child",
		goalId: "goal-1",
		goal: "do the work",
		workspace: "workspace-1",
		capabilityRefs: [],
		inputs: [{ schemaVersion: 1, artifactId: "in-1", mediaType: "text/plain", digest: ARTIFACT_DIGEST }],
		expectedOutputs: [{ schemaVersion: 1, artifactId: "out-1", mediaType: "text/plain", digest: ARTIFACT_DIGEST }],
		budget: { tokens: 8000, concurrency: 4 },
		acceptanceCriteria: [{ schemaVersion: 1, criterionId: "criterion-1", description: "works", satisfiedBy: "evidence", required: true }],
		status: "ready",
		createdAt: NOW,
		updatedAt: NOW,
		...overrides,
	});
	if (!result.ok) throw result.error;
	return result.value;
}

function parentBinding(parentRole: RoleRevision, profile: ModelProfile, budget?: TaskEnvelope["budget"]): AgentBinding {
	const mcpSelection = resolveMcpSelection({
		selector: parentRole.mcpSelector,
		capabilityBinding: {
			id: "capability-1",
			descriptors: ["a", "b", "c"].map((serverId) => ({
				id: `mcp-server-${serverId}`,
				revision: "revision-1",
				kind: "mcp_server",
				name: serverId,
				mcpServerId: serverId,
			})),
			toolAllowlist: [],
		},
		routeCatalog: [],
	});
	if (!mcpSelection.ok) throw mcpSelection.error;
	const result = resolveAgentBinding({
		task: task({ taskId: "task-parent", budget: budget ?? { tokens: 8000, concurrency: 4 } }),
		roleRevision: parentRole,
		modelProfile: profile,
		...bindingFacts(),
		mcpSelection: mcpSelection.value,
		budget: budget ?? { tokens: 8000, concurrency: 4 },
		newBindingId: "binding-parent",
		now: () => NOW,
	});
	if (!result.ok) throw result.error;
	return result.value;
}

function input(overrides: Partial<ProjectChildBindingInput> = {}): ProjectChildBindingInput {
	const parentRole = overrides.parentRoleRevision ?? role();
	const profile = overrides.parentModelProfile ?? modelProfile();
	return {
		schemaVersion: 1,
		spawnId: "spawn-1",
		parentBinding: overrides.parentBinding ?? parentBinding(parentRole, profile),
		childBindingId: "binding-child",
		parentRoleRevision: parentRole,
		childRoleRevision: overrides.childRoleRevision ?? parentRole,
		parentModelProfile: profile,
		childModelProfile: overrides.childModelProfile ?? profile,
		childTaskEnvelope: overrides.childTaskEnvelope ?? task(),
		createdAt: NOW,
		...Object.fromEntries(
			Object.entries(overrides).filter(
				([key]) =>
					key !== "parentRoleRevision" &&
					key !== "parentModelProfile" &&
					key !== "parentBinding" &&
					key !== "childRoleRevision" &&
					key !== "childModelProfile" &&
					key !== "childTaskEnvelope",
			),
		),
	};
}

function mustProject(value: ProjectChildBindingInput, authority?: McpInheritanceApprovalAuthority) {
	const result = projectChildBinding(value, authority);
	if (!result.ok) throw result.error;
	return result.value;
}

function proof(projection: ReturnType<typeof mustProject>, field: ChildBindingProjectionField) {
	return projection.fields.find((entry) => entry.field === field)?.tighteningProof;
}

const SELECTORS: readonly ResourceSelector[] = [
	{ policy: "all" },
	{ policy: "none" },
	{ policy: "named", named: ["a"] },
	{ policy: "named", named: ["a", "b"] },
	{ policy: "except", named: ["a"] },
	{ policy: "except", named: ["a", "b"] },
];

describe("child binding projection", () => {
	it("projects all seven resources with equal proofs when the child inherits the parent", () => {
		const projection = mustProject(input());
		expect(validateChildBindingProjection(projection)).toBe(true);
		expect(Object.isFrozen(projection)).toBe(true);
		expect(projection.fields.map((field) => field.field)).toEqual([...CHILD_BINDING_PROJECTION_FIELDS]);
		expect(projection.fields.every((field) => field.tighteningProof === "equal")).toBe(true);
		expect(projection.parentBindingId).toBe("binding-parent");
		expect(projection.childBindingId).toBe("binding-child");
	});

	it("accepts every selectorsNarrow-true skill combination and rejects widening", () => {
		for (const parentSelector of SELECTORS) {
			for (const childSelector of SELECTORS) {
				const parentRole = role({ skillSelector: parentSelector });
				const childRole = role({ skillSelector: childSelector });
				const result = projectChildBinding(input({ parentRoleRevision: parentRole, childRoleRevision: childRole }));
				const allowed = selectorsNarrow(parentSelector, childSelector);
				if (allowed) {
					expect(result.ok).toBe(true);
					if (result.ok) {
						expect(proof(result.value, "skills")).toBe(
							JSON.stringify(parentSelector) === JSON.stringify(childSelector) ? "equal" : "narrowed",
						);
					}
				} else {
					expect(result).toMatchObject({ ok: false, error: { code: "subagent_binding_projection_invalid" } });
				}
			}
		}
	});

	it("accepts every selectorsNarrow-true MCP combination and rejects widening", () => {
		const { authority } = policyAuthority("allow");
		for (const parentSelector of SELECTORS) {
			for (const childSelector of SELECTORS) {
				const parentRole = role({ mcpSelector: parentSelector });
				const childRole = role({ mcpSelector: childSelector });
				const result = projectChildBinding(input({ parentRoleRevision: parentRole, childRoleRevision: childRole }), authority);
				expect(result.ok).toBe(selectorsNarrow(parentSelector, childSelector));
			}
		}
	});

	it("accepts every selectorsNarrow-true git combination and rejects widening", () => {
		for (const parentSelector of SELECTORS) {
			for (const childSelector of SELECTORS) {
				const result = projectChildBinding(input({ parentGitSelector: parentSelector, childGitSelector: childSelector }));
				expect(result.ok).toBe(selectorsNarrow(parentSelector, childSelector));
			}
		}
	});

	it("takes the exact budget minimum across parent binding, child task, child model profile, and request", () => {
		const parentRole = role();
		const profile = modelProfile({ budget: { tokens: 300, concurrency: 3, costUsd: 5 } });
		const binding = parentBinding(parentRole, profile, { tokens: 1000, concurrency: 4, costUsd: 5 });
		const exactMin = { tokens: 200, concurrency: 2, costUsd: 5 };
		const narrowed = mustProject(
			input({
				parentRoleRevision: parentRole,
				parentModelProfile: profile,
				parentBinding: binding,
				childModelProfile: profile,
				childTaskEnvelope: task({ budget: { tokens: 800, concurrency: 2 } }),
				childBudget: exactMin,
			}),
		);
		expect(proof(narrowed, "budget")).toBe("narrowed");
		expect(narrowed.fields.find((field) => field.field === "budget")?.childDigest).toEqual(fingerprintFoundationValue(exactMin));
		const profileMin = mustProject(
			input({
				parentRoleRevision: parentRole,
				parentModelProfile: profile,
				parentBinding: binding,
				childModelProfile: profile,
				childTaskEnvelope: task({ budget: { tokens: 800, concurrency: 4 } }),
			}),
		);
		expect(profileMin.fields.find((field) => field.field === "budget")?.childDigest).toEqual(
			fingerprintFoundationValue({ tokens: 300, concurrency: 3, costUsd: 5 }),
		);
		const looserTokens = projectChildBinding(
			input({
				parentRoleRevision: parentRole,
				parentModelProfile: profile,
				parentBinding: binding,
				childModelProfile: profile,
				childBudget: { tokens: 2000, concurrency: 3, costUsd: 5 },
			}),
		);
		expect(looserTokens).toMatchObject({ ok: false, error: { code: "subagent_binding_projection_invalid" } });
		const looserConcurrency = projectChildBinding(
			input({
				parentRoleRevision: parentRole,
				parentModelProfile: profile,
				parentBinding: binding,
				childModelProfile: profile,
				childBudget: { tokens: 300, concurrency: 8, costUsd: 5 },
			}),
		);
		expect(looserConcurrency).toMatchObject({ ok: false, error: { code: "subagent_binding_projection_invalid" } });
	});

	it("rejects Managed Lock changes even when the child would otherwise narrow", () => {
		const parentRole = role({ skillSelector: { policy: "all" } });
		const childRole = role({ skillSelector: { policy: "named", named: ["a"] } });
		const unlocked = projectChildBinding(input({ parentRoleRevision: parentRole, childRoleRevision: childRole }));
		expect(unlocked.ok).toBe(true);
		const lockedSkills = projectChildBinding(
			input({ parentRoleRevision: parentRole, childRoleRevision: childRole, managedLocks: ["skills"] }),
		);
		expect(lockedSkills).toMatchObject({ ok: false, error: { code: "subagent_binding_projection_invalid" } });
		const lockedEqual = mustProject(input({ managedLocks: ["skills", "mcp", "budget", "sandbox", "git", "instructions", "model"] }));
		expect(lockedEqual.fields.every((field) => field.tighteningProof === "equal")).toBe(true);
	});

	it("rejects dropping or swapping a parent instruction policy reference", () => {
		const parentPolicy = { schemaVersion: 1 as const, type: "context_policy", id: "policy-a", revision: 1 };
		const parentRole = role({ contextPolicyRef: parentPolicy });
		const dropped = projectChildBinding(input({ parentRoleRevision: parentRole, childRoleRevision: role() }));
		expect(dropped).toMatchObject({ ok: false, error: { code: "subagent_binding_projection_invalid" } });
		const swapped = projectChildBinding(
			input({
				parentRoleRevision: parentRole,
				childRoleRevision: role({ contextPolicyRef: { schemaVersion: 1, type: "context_policy", id: "policy-b", revision: 1 } }),
			}),
		);
		expect(swapped).toMatchObject({ ok: false, error: { code: "subagent_binding_projection_invalid" } });
		const same = mustProject(input({ parentRoleRevision: parentRole, childRoleRevision: role({ contextPolicyRef: parentPolicy }) }));
		expect(proof(same, "instructions")).toBe("equal");
	});

	it("rejects a looser sandbox policy revision without host preflight", () => {
		const result = projectChildBinding(
			input({
				childPolicyRevision: immutableFact("policy_binding", "policy-1", 2),
			}),
		);
		expect(result).toMatchObject({ ok: false, error: { code: "subagent_binding_projection_invalid" } });
		const tighter = mustProject(
			input({
				childPolicyRevision: immutableFact("policy_binding", "policy-1", 2),
				hostPreflight: { policyTighter: true },
			}),
		);
		expect(proof(tighter, "sandbox")).toBe("narrowed");
	});

	it("allows a different frozen child ModelProfile whose route is taken from the profile", () => {
		const parentRole = role();
		const parentProfile = modelProfile();
		const childProfile = modelProfile({
			modelProfileId: "profile-2",
			model: "model-2",
			effort: "high",
			serviceTier: "default",
			fallback: [{ provider: "fake", model: "model-1" }],
		});
		const projected = mustProject(
			input({
				parentRoleRevision: parentRole,
				parentModelProfile: parentProfile,
				childModelProfile: childProfile,
			}),
		);
		expect(proof(projected, "model")).toBe("narrowed");
		const mismatchedRoute = projectChildBinding(
			input({
				parentRoleRevision: parentRole,
				parentModelProfile: parentProfile,
				childModelProfile: childProfile,
				childModelRoute: { provider: "fake", model: "other" },
			}),
		);
		expect(mismatchedRoute).toMatchObject({ ok: false, error: { code: "subagent_binding_projection_invalid" } });
	});

	it("returns a stable Result for malformed unknown input and never throws", () => {
		expect(() => projectChildBinding(null)).not.toThrow();
		expect(projectChildBinding(null)).toMatchObject({ ok: false, error: { code: "subagent_binding_projection_invalid" } });
		expect(projectChildBinding({ extra: true })).toMatchObject({ ok: false, error: { code: "subagent_binding_projection_invalid" } });
		expect(projectChildBinding(input({ childBudget: { tokens: 1, extra: true } as never }))).toMatchObject({
			ok: false,
			error: { code: "subagent_binding_projection_invalid" },
		});
		expect(projectChildBinding(input({ parentGitSelector: { policy: "named" } as never }))).toMatchObject({
			ok: false,
			error: { code: "subagent_binding_projection_invalid" },
		});
		expect(projectChildBinding(input({ childGitSelector: { policy: "all", extra: true } as never }))).toMatchObject({
			ok: false,
			error: { code: "subagent_binding_projection_invalid" },
		});
		expect(projectChildBinding(input({ childPolicyRevision: { schemaVersion: 1, type: "policy_binding", id: "policy-1" } as never }))).toMatchObject({
			ok: false,
			error: { code: "subagent_binding_projection_invalid" },
		});
	});

	it("validates the projection as an exact runtime shape", () => {
		const projection = mustProject(input());
		expect(validateChildBindingProjection(projection)).toBe(true);
		expect(validateChildBindingProjection({ ...projection, extra: true })).toBe(false);
		expect(validateChildBindingProjection({ ...projection, fields: projection.fields.slice(1) })).toBe(false);
	});

	it("rejects omitted Policy authority and caller-fabricated approval fields for non-empty inheritance", () => {
		const parentRole = role({ mcpSelector: { policy: "all" } });
		const projectionInput = input({ parentRoleRevision: parentRole, childRoleRevision: parentRole });
		expect(projectChildBinding(projectionInput)).toMatchObject({
			ok: false,
			error: { code: "subagent_binding_projection_invalid" },
		});
		for (const fabricated of [
			{ mcpInheritanceApprovalRequired: false },
			{ mcpApprovalEvidenceId: "fabricated-evidence" },
			{
				mcpInheritanceApprovalEvidence: {
					evidenceId: "fabricated-evidence",
					decision: "allow",
				},
			},
		]) {
			expect(projectChildBinding({ ...projectionInput, ...fabricated })).toMatchObject({
				ok: false,
				error: { code: "subagent_binding_projection_invalid" },
			});
		}
	});

	it("derives the inheritance decision from the trusted effective MCP Policy", () => {
		const parentRole = role({ mcpSelector: { policy: "all" } });
		const projectionInput = input({ parentRoleRevision: parentRole, childRoleRevision: parentRole });
		const allowed = policyAuthority("allow");
		const allowedProjection = projectChildBinding(projectionInput, allowed.authority);
		expect(allowedProjection.ok).toBe(true);
		if (allowedProjection.ok) expect(allowedProjection.value.mcpApprovalEvidenceId).toBeUndefined();
		const denied = policyAuthority("deny");
		expect(projectChildBinding(projectionInput, denied.authority)).toMatchObject({
			ok: false,
			error: { code: "subagent_binding_projection_invalid" },
		});
	});

	it("rejects approved evidence from a stale child selection", () => {
		const pending: PolicyApprovalRequest[] = [];
		const { authority, ledger: policyLedger } = policyAuthority("ask", { pending });
		const parentRole = role({ mcpSelector: { policy: "all" } });
		const first = input({
			parentRoleRevision: parentRole,
			childRoleRevision: role({ mcpSelector: { policy: "named", named: ["a"] } }),
		});
		expect(projectChildBinding(first, authority).ok).toBe(false);
		expect(pending).toHaveLength(1);
		policyLedger.appendApprovalOutcome(pending[0]!, { outcome: "approved", source: "system", resolvedAt: APPROVED_AT });
		expect(projectChildBinding(first, authority).ok).toBe(true);

		const stale = input({
			parentRoleRevision: parentRole,
			childRoleRevision: role({ mcpSelector: { policy: "named", named: ["b"] } }),
		});
		expect(projectChildBinding(stale, authority)).toMatchObject({
			ok: false,
			error: { code: "subagent_binding_projection_invalid" },
		});
		expect(pending).toHaveLength(2);
	});

	it("rejects durable approval records carrying a wrong scope digest", () => {
		const pending: PolicyApprovalRequest[] = [];
		const { authority, ledger } = policyAuthority("ask", { pending });
		const parentRole = role({ mcpSelector: { policy: "all" } });
		const projectionInput = input({ parentRoleRevision: parentRole, childRoleRevision: parentRole });
		expect(projectChildBinding(projectionInput, authority).ok).toBe(false);
		const wrongScopeDigest = `sha256:${"0".repeat(64)}`;
		const wrongScope = {
			...pending[0]!,
			scopeDigest: wrongScopeDigest,
			scope: { ...pending[0]!.scope, scopeDigest: wrongScopeDigest },
		};
		ledger.appendApprovalOutcome(wrongScope, { outcome: "approved", source: "system", resolvedAt: APPROVED_AT });
		expect(projectChildBinding(projectionInput, authority)).toMatchObject({
			ok: false,
			error: { code: "subagent_binding_projection_invalid" },
		});
	});

	it("replays valid approved MCP inheritance from the durable Policy ledger after restart", () => {
		const session = new MemoryPolicySession();
		const pending: PolicyApprovalRequest[] = [];
		const first = policyAuthority("ask", { session, pending });
		const parentRole = role({ mcpSelector: { policy: "all" } });
		const projectionInput = input({ parentRoleRevision: parentRole, childRoleRevision: parentRole });
		expect(projectChildBinding(projectionInput, first.authority).ok).toBe(false);
		first.ledger.appendApprovalOutcome(pending[0]!, { outcome: "approved", source: "system", resolvedAt: APPROVED_AT });

		const restarted = policyAuthority("ask", { session });
		const projection = mustProject(projectionInput, restarted.authority);
		expect(projection.mcpApprovalEvidenceId).toBe("policy-entry-2");
	});

	it("persists the projection and inherited MCP approval evidence reference as a durable Session fact", async () => {
		const pending: PolicyApprovalRequest[] = [];
		const { authority, ledger } = policyAuthority("ask", { pending });
		const parentRole = role({ mcpSelector: { policy: "all" } });
		const projectionInput = input({ parentRoleRevision: parentRole, childRoleRevision: parentRole });
		expect(projectChildBinding(projectionInput, authority).ok).toBe(false);
		ledger.appendApprovalOutcome(pending[0]!, { outcome: "approved", source: "system", resolvedAt: APPROVED_AT });
		const projection = mustProject(projectionInput, authority);
		expect(projection.mcpApprovalEvidenceId).toBe("policy-entry-2");
		const session = new Session(new InMemorySessionStorage({ id: "session-binding", createdAt: 1 }));
		const foundationLedger = new SessionLedger(session);
		const fabricated = await persistChildBindingProjection(foundationLedger, { ...projection }, {
			clientRequestId: "project-fabricated",
			correlation: { taskId: "task-child" },
		});
		expect(fabricated).toMatchObject({ ok: false, error: { code: "subagent_binding_projection_invalid" } });
		const persisted = await persistChildBindingProjection(foundationLedger, projection, {
			clientRequestId: "project-1",
			correlation: { taskId: "task-child" },
		});
		expect(persisted.ok).toBe(true);
		const stored = await foundationLedger.getFact(CHILD_BINDING_PROJECTION_OBJECT_TYPE, projection.spawnId);
		expect(stored?.payload).toEqual(projection);
		expect((stored?.payload as { mcpApprovalEvidenceId?: string } | undefined)?.mcpApprovalEvidenceId).toBe(
			"policy-entry-2",
		);
	});
});
