import type { SandboxOperationRequest as WorkerOperationRequest } from "@aos-agent/agent-core";
import { describe, expect, it } from "vitest";
import {
	resolveExecutionPolicyProfile,
	type ExecutionPolicyProfile,
	type PolicyDecision,
} from "../../src/core/policy/execution.ts";
import { InMemoryExecutionPolicyLedger } from "../../src/core/policy/execution-ledger.ts";
import { classifyExternalToolPolicyOperation } from "../../src/core/connector/tool-policy.ts";
import {
	createBuiltinToolPolicy,
	createSandboxHandleOperationProvider,
} from "../../src/core/policy/sandbox-host.ts";
import type { SandboxHandle, SandboxOperationRequest } from "../../src/core/policy/sandbox.ts";

const profile: ExecutionPolicyProfile = {
	id: "network-worker",
	enforcement: "sandbox",
	sandboxProvider: "network-sandbox",
	defaultAction: "deny",
	workspace: { read: ["workspace"], write: ["workspace"], deny: [] },
	process: { action: "deny", inheritEnvironment: false, allowEnvironment: [] },
	network: { action: "deny", allowDestinations: ["*.example.com:443"] },
	credentials: { action: "deny", allowNames: [] },
	approvals: { writeOutsideWorkspace: "deny", network: "allow", process: "deny" },
};

function workerRequest(bindingId: string, operationId: string, destination: string, port: number): WorkerOperationRequest {
	return {
		schemaVersion: 1,
		operationId,
		providerId: "network-sandbox",
		bindingId,
		sideEffect: "writes",
		payload: { resource: "network.connect", destination, port },
	};
}

describe("sandbox worker network egress policy", () => {
	it("classifies the destination and port from a sandbox Tool Gateway request", async () => {
		const base = {
			request: {
				schemaVersion: 1 as const,
				toolCallId: "network-call",
				toolName: "connect",
				originalArguments: { host: "api.example.com", port: 8443 },
				context: { schemaVersion: 1 as const, bindingId: "binding", bindingEpochId: "epoch", taskId: "task" },
			},
			route: {
				kind: "sandbox" as const,
				toolName: "connect",
				providerId: "network-sandbox",
				revision: 1,
				operation: { resource: "network.connect" as const, effects: ["network" as const] },
			},
			cwd: process.cwd(),
			roots: { workspace: process.cwd() },
		};

		await expect(classifyExternalToolPolicyOperation(base)).resolves.toMatchObject({
			resource: "network.connect",
			destination: "api.example.com",
			port: 8443,
		});
		await expect(classifyExternalToolPolicyOperation({
			...base,
			request: { ...base.request, originalArguments: { host: "api.example.com", port: "8443" } },
		})).rejects.toMatchObject({ code: "policy_settings_invalid" });
	});

	it("uses the shared network decision, rejects violations before execution, and exposes evidence", async () => {
		const resolved = resolveExecutionPolicyProfile({
			profiles: { [profile.id]: profile },
			defaultProfile: profile.id,
			workspaceIdentity: "network-worker-workspace",
			runId: "network-worker-run",
			createdAt: "2026-09-02T00:00:00.000Z",
			sandbox: {
				providerConfigured: true,
				providerId: "network-sandbox",
				providerStatus: "ready",
				providerCapabilities: { filesystem: false, process: false, network: true, credentialIsolation: true },
			},
		});
		if (!resolved.ok) throw resolved.error;

		const executions: SandboxOperationRequest[] = [];
		const decisions: PolicyDecision[] = [];
		const ledger = new InMemoryExecutionPolicyLedger();
		const handle: SandboxHandle = {
			id: "network-sandbox-handle",
			bindingId: resolved.binding.id,
			providerId: "network-sandbox",
			status: "ready",
			capabilities: { filesystem: false, process: false, network: true, credentialIsolation: true },
			async execute(request) {
				executions.push(request);
				return {};
			},
		};
		const policy = createBuiltinToolPolicy({
			profile,
			binding: resolved.binding,
			roots: { workspace: process.cwd() },
			sandbox: handle,
			source: "extension",
			hooks: {
				onDecision(decision) {
					decisions.push(decision);
					ledger.appendDecision(decision);
					if (decision.outcome !== "allow") {
						ledger.appendViolation({
							bindingId: decision.bindingId,
							timestamp: decision.timestamp,
							reasonCode: decision.reasonCode ?? "policy_denied",
							resource: decision.resource,
							...(decision.requestId === undefined ? {} : { requestId: decision.requestId }),
						});
					}
				},
			},
		});
		const provider = createSandboxHandleOperationProvider({
			providerId: "network-sandbox",
			policy,
			correlation: { sessionId: "network-worker-session", laneId: "main" },
			capabilities: [{ schemaVersion: 1, id: "network.connect", version: 1 }],
			mapResult: () => [],
			now: () => "2026-09-02T00:00:00.000Z",
			receiptId: (operationId) => `receipt:${operationId}`,
		});

		const allowed = await provider.start(workerRequest(resolved.binding.id, "network-allowed", "api.example.com", 443));
		const denied = await provider.start(workerRequest(resolved.binding.id, "network-denied", "api.example.com", 80));

		expect(allowed.ok).toBe(true);
		expect(denied).toMatchObject({ ok: false, error: { code: "worker_operation_invalid" } });
		expect(executions).toHaveLength(1);
		expect(executions[0]).toMatchObject({ resource: "network.connect", destination: "api.example.com", port: 443 });
		expect(decisions).toMatchObject([
			{ outcome: "allow", resource: "network.connect" },
			{ outcome: "deny", resource: "network.connect", reasonCode: "network_policy_violation", hardDeny: true },
		]);
		expect(ledger.query({ customType: "policy.violation" })).toMatchObject([
			{ record: { bindingId: resolved.binding.id, resource: "network.connect", reasonCode: "network_policy_violation" } },
		]);

		await provider.dispose();
	});
});
