import { describe, expect, it } from "vitest";
import {
	createBindingHandle,
	createRunBindingAssociation,
	isBindingHandle,
	isRunBindingAssociation,
	parseBindingHandle,
	serializePublicBindingHandle,
	serializePublicRunBindingAssociation,
} from "../src/core/binding-handles.ts";
import { toCapabilityBindingHandle, type CapabilityBinding } from "../src/core/policy/capability-registry.ts";
import { resolveExecutionPolicyProfile, toPolicyBindingHandle } from "../src/core/policy/execution.ts";
import { ModelBroker, toModelBindingHandle } from "../src/core/runtime/model-broker.ts";
import { toSandboxBindingHandle } from "../src/core/policy/sandbox.ts";

const CAPABILITY_BINDING: CapabilityBinding = {
	id: "binding:capability",
	profile: "default",
	createdAt: "2026-08-14T00:00:00.000Z",
	descriptors: [{ id: "builtin_tool:read", revision: "rev:read", exposedToolName: "read" }],
	decisionSummary: { allowed: 1, awaitingApproval: 0, denied: 0 },
	toolAllowlist: ["read"],
};

function resolvePolicy() {
	const result = resolveExecutionPolicyProfile({
		profiles: {
			strict: {
				id: "strict",
				revision: "revision-1",
				enforcement: "sandbox",
				sandboxProvider: "fake",
				defaultAction: "allow",
				workspace: { read: ["workspace"], write: ["workspace"], deny: [] },
				process: { action: "allow", inheritEnvironment: false, allowEnvironment: [] },
				network: { action: "allow", allowDestinations: [] },
				credentials: { action: "deny", allowNames: [] },
				approvals: { writeOutsideWorkspace: "ask", network: "ask", process: "ask" },
			},
		},
		policyProfile: "strict",
		runId: "run-bindings",
		workspaceIdentity: "workspace-bindings",
		createdAt: "2026-08-14T00:00:00.000Z",
		capabilityBinding: { id: CAPABILITY_BINDING.id },
		sandbox: {
			configured: true,
			providerId: "fake",
			status: "ready",
			capabilities: { filesystem: true, process: true, network: true, credentialIsolation: true },
		},
	});
	if (!result.ok) throw result.error;
	return result.binding;
}

describe("stable binding handles", () => {
	it("derives deterministic handles without creation timestamps", () => {
		const broker = new ModelBroker({
			now: () => "2026-08-14T00:00:00.000Z",
			bindingIdFactory: () => "model-binding:stable",
		});
		const first = broker.resolve({ direct: { provider: "provider", id: "model" } }).binding;
		const handle = toModelBindingHandle(first);
		const replayed = toModelBindingHandle({ ...first, createdAt: "2027-01-01T00:00:00.000Z" });

		expect(replayed).toEqual(handle);
		expect(handle.id).toMatch(/^binding-handle:model:[A-Za-z0-9_-]+$/);
		expect(handle.bindingId).toBe(first.id);
		expect(handle.revision).toMatch(/^rev:[A-Za-z0-9_-]+$/);
	});

	it("associates model, capability, policy, and sandbox handles for replay", () => {
		const model = new ModelBroker({ bindingIdFactory: () => "model-binding:run" }).resolve({
			direct: { provider: "provider", id: "model" },
		}).binding;
		const policy = resolvePolicy();
		const handles = [
			toModelBindingHandle(model),
			toCapabilityBindingHandle(CAPABILITY_BINDING),
			toPolicyBindingHandle(policy),
			toSandboxBindingHandle({
				binding: policy,
				handle: {
					providerId: "fake",
					status: "ready",
					capabilities: policy.sandboxCapabilities,
				},
			}),
		];
		const association = createRunBindingAssociation("run-bindings", handles);
		const replayed = JSON.parse(JSON.stringify(association)) as unknown;

		expect(association.bindings.map((binding) => binding.domain)).toEqual([
			"capability",
			"model",
			"policy",
			"sandbox",
		]);
		expect(isRunBindingAssociation(replayed)).toBe(true);
		expect(serializePublicRunBindingAssociation(replayed)).toEqual(association);
	});

	it("rejects malformed, unknown, and tampered handles", () => {
		const handle = createBindingHandle({
			domain: "model",
			bindingId: "model-binding:test",
			revision: "rev:test",
			relation: "run.model",
			role: "direct",
		});

		expect(isBindingHandle({ ...handle, domain: "future" })).toBe(false);
		expect(isBindingHandle({ ...handle, id: "binding-handle:model:tampered" })).toBe(false);
		expect(isBindingHandle({ ...handle, credentials: "secret" })).toBe(false);
		expect(parseBindingHandle({ ...handle, schemaVersion: 99 })).toBeUndefined();
		expect(() => createRunBindingAssociation("run-bindings", [handle, handle])).toThrow(
		"Run binding association repeats a handle",
	);
	});

	it("redacts sensitive fields and live sandbox identity from public references", () => {
		const handle = createBindingHandle({
			domain: "sandbox",
			bindingId: "policy-binding:test",
			revision: "rev:test",
			relation: "policy.sandbox",
			role: "fake",
			summary: { providerId: "fake", status: "ready" },
		});
		const unsafe = { ...handle, summary: { providerId: "fake", token: "secret", endpoint: "https://private.invalid" } };

		expect(serializePublicBindingHandle(unsafe)).toBeUndefined();
		expect(JSON.stringify(serializePublicBindingHandle(handle))).not.toContain("secret");
		expect(JSON.stringify(serializePublicBindingHandle(handle))).not.toContain("endpoint");
	});
});
