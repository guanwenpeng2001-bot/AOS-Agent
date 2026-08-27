import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
	createRoleRevision,
	createSecretFreeModelProfile,
	createTaskEnvelope,
	fingerprintFoundationValue,
	projectMcpSelectionToSelector,
	resolveAgentBinding,
	resolveMcpSelection,
	validateAgentBinding,
	validateChildMcpSelection,
	type McpInheritanceApprovalEvidence,
	type McpCapabilityBinding,
	type McpSelection,
	type ModelProfile,
	type RevisionReference,
	type RoleRevision,
} from "@aos-agent/agent-core";
import { CapabilityPublicIdentity } from "../src/core/capability-public-identity.ts";
import {
	CapabilityRegistry,
	type CapabilityBinding,
} from "../src/core/capability-registry.ts";
import { createSyntheticSourceInfo } from "../src/core/source-info.ts";

const NOW = "2026-08-28T00:00:00.000Z";
const TEST_AGENT_DIR = mkdtempSync(join(tmpdir(), "mcp-exact-selection-test-"));
const IDENTITY = CapabilityPublicIdentity.loadSync(TEST_AGENT_DIR);
const ARTIFACT_DIGEST = `sha256:${"ab".repeat(32)}`;

afterAll(() => {
	rmSync(TEST_AGENT_DIR, { recursive: true, force: true });
});

function immutableFact(type: string, id: string): RevisionReference {
	const value = { schemaVersion: 1 as const, type, id, revision: 1 };
	return { ...value, fingerprint: fingerprintFoundationValue(value) };
}

function role(): RoleRevision {
	return createRoleRevision({
		definition: {
			schemaVersion: 1,
			roleId: "role-mcp",
			scope: "project",
			slug: "mcp-worker",
			name: "MCP worker",
			description: "Uses selected MCP tools",
			revision: 1,
			persona: "Use exact MCP tools.",
			modelProfileRef: { schemaVersion: 1, type: "model_profile", id: "profile-mcp", revision: 1 },
			capabilitySelector: { policy: "all" },
			skillSelector: { policy: "none" },
			mcpSelector: { policy: "all" },
		},
		now: () => NOW,
	});
}

function modelProfile(): ModelProfile {
	const result = createSecretFreeModelProfile({
		schemaVersion: 1,
		modelProfileId: "profile-mcp",
		provider: "fake",
		model: "model",
		budget: { tokens: 1000 },
		revision: 1,
		createdAt: NOW,
	});
	if (!result.ok) throw result.error;
	return result.value;
}

function capabilityBinding(toolAllowlist: readonly string[]): CapabilityBinding {
	const registry = new CapabilityRegistry(IDENTITY);
	const source = createSyntheticSourceInfo("<mcp:docs>", {
		source: "mcp:docs",
		scope: "user",
		origin: "top-level",
	});
	const serverDescriptorId = registry.createCapabilityId("mcp_server", "mcp:docs", "docs");
	const catalog = registry.buildCatalog({
		candidates: [
			{
				kind: "mcp_server",
				name: "docs",
				localName: "docs",
				sourceIdentity: "mcp:docs",
				source,
				mcpServerId: "docs",
			},
			...(["read", "write"] as const).map((toolName) => ({
				kind: "mcp_tool" as const,
				name: toolName,
				localName: toolName,
				sourceIdentity: "mcp:docs",
				source,
				parentId: serverDescriptorId,
				mcpServerId: "docs",
				exposedToolName: `mcp__docs__${toolName}`,
			})),
		],
	});
	return registry.resolveBinding({
		catalog,
		profile: "test",
		profiles: {
			test: {
				rules: [
					{ selector: { kind: "mcp_server" }, action: "allow" },
					{ selector: { kind: "mcp_tool" }, action: "allow" },
				],
			},
		},
		toolAllowlist,
		now: NOW,
	});
}

function routes() {
	return (["read", "write"] as const).map((toolName): { kind: string; namespace: string; toolName: string; providerId: string; revision: number } => ({
		kind: "mcp",
		namespace: "docs",
		toolName,
		providerId: "mcp-provider",
		revision: 1,
	}));
}

function exactBinding(binding: CapabilityBinding): McpCapabilityBinding {
	return {
		id: binding.id,
		descriptors: binding.descriptors.map((descriptor) => {
			if (descriptor.kind === undefined || descriptor.name === undefined) {
				throw new Error("CapabilityBinding descriptor is missing exact MCP identity");
			}
			return { ...descriptor, kind: descriptor.kind, name: descriptor.name };
		}),
		toolAllowlist: binding.toolAllowlist,
	};
}

function mustResolve(binding: CapabilityBinding): McpSelection {
	const result = resolveMcpSelection({ selector: { policy: "all" }, capabilityBinding: exactBinding(binding), routeCatalog: routes() });
	if (!result.ok) throw result.error;
	return result.value;
}

function approval(parentBindingId: string, parent: McpSelection, child: McpSelection): McpInheritanceApprovalEvidence {
	return {
		schemaVersion: 1,
		evidenceId: "approval-mcp-1",
		parentBindingId,
		parentSelectionDigest: parent.digest,
		childSelectionDigest: child.digest,
		decision: "allow",
		approvedBy: "principal:reviewer-1",
		decidedAt: NOW,
	};
}

describe("exact MCP selection core", () => {
	it("trims every MCP tool not present in the CapabilityBinding tool allowlist", () => {
		const selection = mustResolve(capabilityBinding(["mcp__docs__read"]));
		expect(selection.servers).toHaveLength(1);
		expect(selection.servers[0]?.tools.map((tool) => tool.toolId)).toEqual(["read"]);
		expect(JSON.stringify(selection)).not.toContain('"toolId":"write"');
	});

	it("rejects a child exact set that adds a parent-trimmed tool", () => {
		const parent = mustResolve(capabilityBinding(["mcp__docs__read"]));
		const child = mustResolve(capabilityBinding(["mcp__docs__read", "mcp__docs__write"]));
		const result = validateChildMcpSelection({
			parentBindingId: "binding-parent",
			parentSelection: parent,
			childSelection: child,
			inheritanceApprovalRequired: false,
		});
		expect(result).toMatchObject({ ok: false, error: { code: "subagent_binding_projection_invalid" } });
	});

	it("rejects wrong or stale parent/child selection digests", () => {
		const parent = mustResolve(capabilityBinding(["mcp__docs__read"]));
		const childResult = projectMcpSelectionToSelector(parent, { policy: "named", named: ["docs"] }, parent.capabilityBindingId);
		const staleResult = projectMcpSelectionToSelector(parent, { policy: "none" }, parent.capabilityBindingId);
		if (!childResult.ok) throw childResult.error;
		if (!staleResult.ok) throw staleResult.error;
		const evidence = approval("binding-parent", parent, staleResult.value);
		for (const approvalEvidence of [
			evidence,
			{
				...evidence,
				parentSelectionDigest: { algorithm: "sha256" as const, value: "0".repeat(64) },
				childSelectionDigest: childResult.value.digest,
			},
		]) {
			const result = validateChildMcpSelection({
				parentBindingId: "binding-parent",
				parentSelection: parent,
				childSelection: childResult.value,
				inheritanceApprovalRequired: true,
				approvalEvidence,
			});
			expect(result).toMatchObject({ ok: false, error: { code: "subagent_binding_projection_invalid" } });
		}
	});

	it("rejects missing inheritance approval when Policy requires it", () => {
		const parent = mustResolve(capabilityBinding(["mcp__docs__read"]));
		const result = validateChildMcpSelection({
			parentBindingId: "binding-parent",
			parentSelection: parent,
			childSelection: parent,
			inheritanceApprovalRequired: true,
		});
		expect(result).toMatchObject({ ok: false, error: { code: "subagent_binding_projection_invalid" } });
	});

	it("freezes the resolved set in AgentBinding identity and accepts bound durable approval evidence", () => {
		const liveBinding = capabilityBinding(["mcp__docs__read"]);
		const descriptors = liveBinding.descriptors.map((descriptor) => ({ ...descriptor }));
		const toolAllowlist = [...liveBinding.toolAllowlist];
		const routeCatalog = routes().map((route) => ({ ...route }));
		const selected = resolveMcpSelection({
			selector: { policy: "all" },
			capabilityBinding: exactBinding({ ...liveBinding, descriptors, toolAllowlist }),
			routeCatalog,
		});
		if (!selected.ok) throw selected.error;
		descriptors.splice(0, descriptors.length);
		toolAllowlist.push("mcp__docs__write");
		routeCatalog[0]!.toolName = "changed";
		expect(selected.value.servers[0]?.tools.map((tool) => tool.toolId)).toEqual(["read"]);
		expect(Object.isFrozen(selected.value)).toBe(true);
		expect(Object.isFrozen(selected.value.servers[0]?.tools)).toBe(true);

		const task = createTaskEnvelope({
			schemaVersion: 1,
			taskId: "task-mcp",
			goalId: "goal-mcp",
			goal: "Use exact MCP",
			workspace: "workspace",
			capabilityRefs: [],
			inputs: [{ schemaVersion: 1, artifactId: "input", mediaType: "text/plain", digest: ARTIFACT_DIGEST }],
			expectedOutputs: [{ schemaVersion: 1, artifactId: "output", mediaType: "text/plain", digest: ARTIFACT_DIGEST }],
			budget: { tokens: 1000 },
			acceptanceCriteria: [
				{
					schemaVersion: 1,
					criterionId: "criterion-mcp",
					description: "Uses only selected MCP tools",
					satisfiedBy: "evidence",
					required: true,
				},
			],
			status: "ready",
			createdAt: NOW,
			updatedAt: NOW,
		});
		if (!task.ok) throw task.error;
		const resolvedBinding = resolveAgentBinding({
			task: task.value,
			roleRevision: role(),
			modelProfile: modelProfile(),
			contextRevision: immutableFact("external_agent_binding", "external-binding"),
			capabilityRevision: immutableFact("capability_binding", liveBinding.id),
			modelBrokerBindingRevision: immutableFact("model_broker_binding", "model-binding"),
			policyRevision: immutableFact("policy_binding", "policy-binding"),
			mcpSelection: selected.value,
			newBindingId: "binding-parent",
			now: () => NOW,
		});
		if (!resolvedBinding.ok) throw resolvedBinding.error;
		expect(resolvedBinding.value.mcpSelection.digest).toEqual(selected.value.digest);
		expect(Object.isFrozen(resolvedBinding.value.mcpSelection.servers[0]?.tools)).toBe(true);
		const emptySelection = projectMcpSelectionToSelector(
			selected.value,
			{ policy: "none" },
			selected.value.capabilityBindingId,
		);
		if (!emptySelection.ok) throw emptySelection.error;
		expect(validateAgentBinding({
			...resolvedBinding.value,
			mcpSelection: emptySelection.value,
		}).ok).toBe(false);

		const accepted = validateChildMcpSelection({
			parentBindingId: resolvedBinding.value.bindingId,
			parentSelection: selected.value,
			childSelection: selected.value,
			inheritanceApprovalRequired: true,
			approvalEvidence: approval(resolvedBinding.value.bindingId, selected.value, selected.value),
		});
		expect(accepted.ok).toBe(true);
		if (accepted.ok) expect(Object.isFrozen(accepted.value.approvalEvidence)).toBe(true);
	});
});
