import { fileURLToPath } from "node:url";
import {
	createSandboxOperationToolGatewayProvider,
	type SandboxOperationRequest,
} from "../../../agent/src/internal.ts";
import { afterEach, describe, expect, it } from "vitest";
import {
	resolveExecutionPolicyProfile,
	type ExecutionPolicyProfile,
} from "../../src/core/policy/execution.ts";
import {
	createBuiltinToolPolicy,
	createSandboxHandleOperationProvider,
} from "../../src/core/policy/sandbox-host.ts";
import type { SandboxHandle } from "../../src/core/policy/sandbox.ts";
import type { WorkerBinding } from "../../src/core/worker/lifecycle.ts";
import { OperationWorkerSupervisor } from "../../src/core/worker/supervisor.ts";

const CHILD_ENTRY = fileURLToPath(new URL("../fixtures/fake-worker-child.ts", import.meta.url));
const RAW_COMMAND_EFFECTS = [
	"write",
	"create",
	"delete",
	"move",
	"command",
	"network",
	"commit",
	"push",
	"merge",
] as const;
const supervisors: OperationWorkerSupervisor[] = [];

const profile: ExecutionPolicyProfile = {
	id: "readonly-timeout-settlement",
	enforcement: "sandbox",
	sandboxProvider: "sandbox-worker",
	defaultAction: "allow",
	workspace: { read: ["workspace"], write: ["workspace"], deny: ["credentials", "agent-internal"] },
	process: { action: "allow", inheritEnvironment: false, allowEnvironment: [], timeoutMs: 10_000 },
	network: { action: "deny", allowDestinations: [] },
	credentials: { action: "deny", allowNames: [] },
	approvals: { writeOutsideWorkspace: "deny", network: "deny", process: "allow" },
};

function policy(execute: SandboxHandle["execute"]) {
	const resolved = resolveExecutionPolicyProfile({
		profiles: { [profile.id]: profile },
		defaultProfile: profile.id,
		workspaceIdentity: "readonly-timeout-workspace",
		runId: "run-readonly-timeout",
		createdAt: "2026-09-01T00:00:00.000Z",
		sandbox: {
			providerConfigured: true,
			providerId: "sandbox-worker",
			providerStatus: "ready",
			providerCapabilities: { filesystem: true, process: true, network: false, credentialIsolation: true },
		},
	});
	if (!resolved.ok) throw resolved.error;
	const sandbox: SandboxHandle = {
		id: "readonly-timeout-handle",
		bindingId: resolved.binding.id,
		providerId: "sandbox-worker",
		status: "ready",
		capabilities: { filesystem: true, process: true, network: false, credentialIsolation: true },
		execute,
	};
	return createBuiltinToolPolicy({
		profile,
		binding: resolved.binding,
		roots: { workspace: process.cwd() },
		sandbox,
	});
}

function workerBinding(sideEffect: "none" | "writes"): WorkerBinding {
	return {
		schemaVersion: 1,
		workerId: `worker-cancel-timeout-${sideEffect}`,
		providerId: "sandbox-worker",
		sessionId: "session-1",
		laneId: "main",
		runId: "run-1",
		bindingId: "binding-1",
		bindingEpochId: "epoch-1",
		attemptId: "attempt-1",
		profileId: "cancel_timeout",
		profileRevision: 1,
		capabilitySummary: ["filesystem.read", "process.spawn"],
		deadlineAt: Date.now() + 10_000,
		credentialTargetRefs: [],
		requestFingerprint: `sha256:${(sideEffect === "none" ? "a" : "b").repeat(64)}`,
	};
}

async function synchronizeRunning(supervisor: OperationWorkerSupervisor, operationId: string): Promise<void> {
	const live = await supervisor.probeLiveness(operationId);
	if (!live.ok) throw live.error;
	if (supervisor.snapshot.record?.status !== "running") {
		throw new Error("Operation Worker did not enter running before pong");
	}
}

afterEach(async () => {
	for (const supervisor of supervisors.splice(0)) await supervisor.dispose();
});

describe("readonly Operation Worker timeout settlement", () => {
	it("settles a readonly search timeout as a clean failure while process execution remains unknown", async () => {
		const timedOut = new Error("sandbox process timed out");
		timedOut.name = "TimeoutError";
		const childPolicy = policy(async () => {
			throw timedOut;
		});
		const childProvider = createSandboxHandleOperationProvider({
			providerId: "sandbox-worker",
			policy: childPolicy,
			correlation: { sessionId: "session-1", laneId: "main" },
			capabilities: [
				{ schemaVersion: 1, id: "filesystem.grep", version: 1 },
				{ schemaVersion: 1, id: "process.spawn", version: 1 },
			],
			mapResult: () => [],
		});
		const gateway = createSandboxOperationToolGatewayProvider({
			providerId: "sandbox-worker",
			revision: 1,
			routes: [
				{
					kind: "sandbox",
					toolName: "grep",
					providerId: "sandbox-worker",
					revision: 1,
					operation: { resource: "filesystem.grep", effects: ["read"] },
				},
				{
					kind: "sandbox",
					toolName: "bash",
					providerId: "sandbox-worker",
					revision: 1,
					operation: { resource: "process.spawn", effects: RAW_COMMAND_EFFECTS, requiresSandbox: true },
				},
			],
			sandbox: childProvider,
		});
		const execute = (toolCallId: string, toolName: string, originalArguments: SandboxOperationRequest["payload"]) => gateway.execute({
			schemaVersion: 1,
			toolCallId,
			toolName,
			originalArguments: originalArguments ?? {},
			context: {
				schemaVersion: 1,
				operationId: `operation-${toolCallId}`,
				bindingId: childPolicy.binding.id,
				bindingEpochId: "epoch-1",
				taskId: "task-1",
			},
		});

		try {
			expect(await execute("readonly-timeout", "grep", {
				resource: "filesystem.grep",
				operation: "filesystem.grep",
				path: ".",
				pattern: "needle",
				command: process.execPath,
				args: [],
				cwd: ".",
				timeoutMs: 5,
			})).toMatchObject({
				ok: true,
				value: {
					ok: false,
					sideEffectState: "none",
					error: { code: "worker_deadline_exceeded", message: "Read-only operation timed out" },
				},
			});
			expect(await execute("write-timeout", "bash", {
				resource: "process.spawn",
				command: process.execPath,
				args: [],
				cwd: ".",
				timeoutMs: 5,
			})).toMatchObject({
				ok: true,
				value: {
					ok: false,
					sideEffectState: "side_effect_unknown",
					error: { code: "worker_operation_invalid", message: "Operation failed" },
				},
			});
		} finally {
			await gateway.dispose();
		}
	});

	it.each(["none", "writes"] as const)(
		"uses %s side-effect metadata when cancellation acknowledgement times out",
		async (sideEffect) => {
			const binding = workerBinding(sideEffect);
			const supervisor = new OperationWorkerSupervisor({
				executable: process.execPath,
				entrypoint: CHILD_ENTRY,
				profileId: "cancel_timeout",
				profileRevision: 1,
				capabilities: ["filesystem.read", "process.spawn"],
				environment: { AOS_SAFE_TEST_MARKER: "1" },
				readyTimeoutMs: 2_000,
				heartbeatTimeoutMs: 500,
				cancelTimeoutMs: 40,
				terminateTimeoutMs: 500,
			});
			supervisors.push(supervisor);
			const planned = supervisor.preflight({ binding, runAccepted: true });
			if (!planned.ok) throw planned.error;
			const activated = await supervisor.activate(planned.value);
			if (!activated.ok) throw activated.error;
			const request: SandboxOperationRequest = {
				schemaVersion: 1,
				operationId: `cancel-timeout-${sideEffect}`,
				sideEffect,
				providerId: "sandbox-worker",
				bindingId: "binding-1",
				bindingEpochId: "epoch-1",
				payload: { action: "wait" },
			};
			const execution = supervisor.execute(request);
			await synchronizeRunning(supervisor, request.operationId);

			expect(await supervisor.cancel("cancel", request.operationId)).toMatchObject({
				ok: false,
				error: { code: "worker_cancel_failed", message: "Operation Worker cancellation timed out" },
			});
			expect(await execution).toMatchObject({
				ok: false,
				error: { code: "worker_cancel_failed", message: "Operation Worker cancellation timed out" },
			});
			const terminal = supervisor.lifecycleState?.transitions.find((transition) =>
				transition.to === "failed" || transition.to === "lost"
			);
			expect(terminal).toMatchObject(
				sideEffect === "none"
					? { to: "failed", sideEffectState: "none" }
					: { to: "lost", sideEffectState: "side_effect_unknown" },
			);
		},
	);
});
