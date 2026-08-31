import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
	createModelProfileRevision,
	createRoleRevision,
	fingerprintFoundationValue,
	resolveAgentBinding,
	type AgentBinding,
	type RevisionReference,
	type TaskEnvelope,
} from "../../../agent/src/internal.ts";
import { describe, expect, it } from "vitest";
import {
	projectAgentBindingHandles,
	projectRunBindingAssociation,
} from "../../src/core/binding-handles.ts";

const NOW = "2026-08-26T00:00:00.000Z";

function revision(type: string, id: string, revisionNumber = 1): RevisionReference {
	const payload = { schemaVersion: 1 as const, type, id, revision: revisionNumber };
	return { ...payload, fingerprint: fingerprintFoundationValue(payload) };
}

function binding(capabilityRevision = revision("capability_binding", "capability-revision-1")): AgentBinding {
	const modelProfile = createModelProfileRevision({
		schemaVersion: 1,
		modelProfileId: "model-profile-1",
		provider: "test-provider",
		model: "test-model",
		budget: {},
		revision: 1,
		createdAt: NOW,
	});
	const roleRevision = createRoleRevision({
		definition: {
			schemaVersion: 1,
			roleId: "role-1",
			scope: "global",
			slug: "role-1",
			name: "Role 1",
			description: "Binding authority test role",
			revision: 1,
			persona: "Exercise immutable binding facts",
			modelProfileRef: {
				schemaVersion: 1,
				type: "model_profile",
				id: modelProfile.modelProfileId,
				revision: modelProfile.revision,
				fingerprint: modelProfile.fingerprint,
			},
			capabilitySelector: { policy: "all" },
			skillSelector: { policy: "none" },
			mcpSelector: { policy: "none" },
		},
		now: () => NOW,
	});
	const task: TaskEnvelope = {
		schemaVersion: 1,
		taskId: "task-1",
		goalId: "goal-1",
		goal: "Verify binding authority",
		workspace: "workspace-1",
		capabilityRefs: [],
		inputs: [],
		expectedOutputs: [],
		budget: {},
		acceptanceCriteria: [],
		status: "ready",
		createdAt: NOW,
		updatedAt: NOW,
	};
	const result = resolveAgentBinding({
		task,
		roleRevision,
		modelProfile,
		contextRevision: revision("external_agent_binding", "external-revision-1"),
		capabilityRevision,
		modelBrokerBindingRevision: revision("model_broker_binding", "model-broker-revision-1"),
		policyRevision: revision("policy_binding", "policy-revision-1"),
		newBindingId: "binding-1",
		now: () => NOW,
	});
	if (!result.ok) throw result.error;
	return result.value;
}

function source(relativePath: string): string {
	return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), "utf8");
}

describe("AgentBinding authority", () => {
	it("keeps binding fingerprints and public projections deterministic across revisions", () => {
		const first = binding();
		const repeated = binding();
		expect(repeated).toEqual(first);
		expect(repeated.fingerprint).toEqual(first.fingerprint);

		const revised = binding(revision("capability_binding", "capability-revision-2", 2));
		expect(revised.fingerprint).not.toEqual(first.fingerprint);
		expect(projectAgentBindingHandles(repeated)).toEqual(projectAgentBindingHandles(first));
		expect(projectRunBindingAssociation("run-1", repeated)).toEqual(
			projectRunBindingAssociation("run-1", first),
		);
		expect(projectRunBindingAssociation("run-1", revised)).not.toEqual(
			projectRunBindingAssociation("run-1", first),
		);
	});

	it("keeps public view mutation detached from the execution binding", () => {
		const executionBinding = binding();
		const originalView = projectRunBindingAssociation("run-1", executionBinding);
		const mutableView = structuredClone(originalView) as unknown as {
			bindings: Array<{ bindingId: string; revision: string }>;
		};
		mutableView.bindings[0]!.bindingId = "tampered-binding";
		mutableView.bindings[0]!.revision = "tampered-revision";

		expect(executionBinding.capabilityRevision.id).toBe("capability-revision-1");
		expect(projectRunBindingAssociation("run-1", executionBinding)).toEqual(originalView);
		expect(projectRunBindingAssociation("run-1", executionBinding)).not.toEqual(mutableView);
	});

	it("keeps association writers and execution inputs out of the call graph", () => {
		const ingress = source("../../src/core/runtime/prompt-ingress.ts");
		const runLifecycle = source("../../src/core/session/run-lifecycle.ts");
		const externalConnector = source("../../src/core/connector/durable-connector.ts");
		const remoteOperation = source("../../src/core/runtime/remote-operation.ts");
		const rpcHost = source("../../src/modes/rpc/rpc-host.ts");
		const association = source("../../src/core/session/execution-association.ts");
		const providers = source("../../../agent/src/harness/foundation/providers.ts");

		expect(ingress).not.toContain("DEPENDENCY_FACT_TYPES");
		expect(ingress).not.toMatch(/function\s+(?:roleRevision|modelProfile|dependencies)\s*\(/);
		expect(runLifecycle).not.toContain("bindingHandles?:");
		expect(runLifecycle).not.toContain("createRunBindingAssociation");
		expect(externalConnector).not.toContain("bindingAssociation");
		expect(remoteOperation).not.toContain("bindingAssociation");
		expect(rpcHost).not.toContain("createRunBindingAssociation");
		expect(rpcHost).not.toContain("getActiveBindingHandles");
		expect(association).not.toContain("appendCustomEntry");
		expect(association).not.toContain("persistExecutionAssociation");
		expect(providers).toContain("createAttempt(dispatch: Dispatch, binding: AgentBinding");
		expect(providers).toContain("binding: AgentBinding");
		expect(providers).not.toContain("RunBindingAssociation");
		expect(providers).not.toContain("BindingHandle");
	});
});
