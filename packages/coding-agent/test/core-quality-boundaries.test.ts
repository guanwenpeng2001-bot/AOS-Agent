import { describe, expect, it } from "vitest";
import { classifyProviderFailure } from "../src/core/execution-error.ts";
import {
	createSessionCheckpoint,
	getExecutionAssociations,
	persistExecutionAssociation,
	recoverSessionCheckpoint,
	SESSION_BOUNDARY_CUSTOM_TYPE,
} from "../src/core/index.ts";
import { classifyFallbackEligibility } from "../src/core/model-broker.ts";
import { createOperationBoundary } from "../src/core/operation-boundary.ts";
import { type SandboxHandle, type SandboxProvider, SandboxSession } from "../src/core/sandbox.ts";
import { SessionManager } from "../src/core/session-manager.ts";

describe("core quality boundaries", () => {
	it("does not allow fallback after an unknown provider side effect", () => {
		const result = classifyFallbackEligibility({ category: "network", sideEffectStatus: "unknown" });
		expect(result.eligible).toBe(false);
		expect(result.visibleSideEffects).toContain("unknown");
	});

	it("retries only typed transient provider failures before dispatch", () => {
		expect(classifyProviderFailure("provider returned error: terminated")).toMatchObject({
			kind: "transient_provider",
			retryable: true,
		});
		expect(classifyProviderFailure("provider returned error: terminated", { dispatched: true })).toMatchObject({
			kind: "side_effect_unknown",
			retryable: false,
		});
		expect(classifyProviderFailure("invalid_api_key")).toMatchObject({
			kind: "permanent_provider",
			retryable: false,
		});
	});

	it("persists associations without copying provider secrets", () => {
		const manager = SessionManager.inMemory(process.cwd());
		persistExecutionAssociation(manager, {
			schemaVersion: 1,
			associationId: "association:test",
			sessionId: manager.getSessionId(),
			modelAttemptId: "model-attempt:test",
			modelBindingId: "model-binding:test",
			contextSnapshotId: "snapshot:test",
			policyBindingId: "policy:test",
			capabilityBindingId: "capability:test",
			createdAt: new Date().toISOString(),
		});
		expect(getExecutionAssociations(manager)).toHaveLength(1);
		expect(JSON.stringify(manager.getEntries())).not.toContain("apiKey");
	});

	it("records checkpoint and recovery boundaries on existing Session facts", () => {
		const manager = SessionManager.inMemory(process.cwd());
		const checkpoint = createSessionCheckpoint(manager, "before change");
		const lastEntry = manager.getEntries().at(-1);
		expect(lastEntry?.type === "custom" ? lastEntry.customType : undefined).toBe(SESSION_BOUNDARY_CUSTOM_TYPE);
		const recovered = recoverSessionCheckpoint(manager, checkpoint.boundaryId, "restore");
		expect(recovered.kind).toBe("recovery");
		expect(recovered.checkpointId).toBe(checkpoint.boundaryId);
	});

	it("propagates cancellation and deadline to one operation signal", async () => {
		const controller = new AbortController();
		const boundary = createOperationBoundary({ signals: [controller.signal] });
		controller.abort();
		expect(boundary.signal.aborted).toBe(true);
		boundary.dispose();

		const deadline = createOperationBoundary({ deadlineMs: 0 });
		expect(deadline.signal.aborted).toBe(true);
		deadline.dispose();
	});

	it("disposes a sandbox handle that resolves after cancellation", async () => {
		let resolvePrepare: ((handle: SandboxHandle) => void) | undefined;
		let disposed = 0;
		const handle: SandboxHandle = {
			id: "sandbox-handle:test",
			bindingId: "policy-binding:test",
			providerId: "sandbox:test",
			status: "ready",
			capabilities: { filesystem: true, process: true, network: false, credentialIsolation: true },
			execute: async () => ({ exitCode: 0 }),
		};
		const provider: SandboxProvider = {
			id: "sandbox:test",
			capabilities: handle.capabilities,
			prepare: async () =>
				await new Promise<SandboxHandle>((resolve) => {
					resolvePrepare = resolve;
				}),
			dispose: async () => {
				disposed += 1;
			},
		};
		const session = new SandboxSession(provider, {
			schemaVersion: 1,
			id: "policy-binding:test",
			profileId: "strict",
			profileRevision: "revision:test",
			projectTrust: "trusted",
			enforcement: "sandbox",
			capabilityBindingId: "capability:test",
			sandboxProviderId: provider.id,
			sandboxCapabilities: handle.capabilities,
			sandboxStatus: "preparing",
			workspaceIdentity: "workspace:test",
			runId: "run:test",
			createdAt: new Date().toISOString(),
			constraints: {
				workspace: { read: ["workspace"], write: ["workspace"], deny: [] },
				process: { action: "allow", inheritEnvironment: false, allowedEnvironmentCount: 0 },
				network: { action: "deny", allowedDestinationCount: 0 },
				credentials: { action: "deny", allowedNameCount: 0 },
			},
			bindingHash: "hash:test",
		});
		const controller = new AbortController();
		const preparing = session.prepare(controller.signal);
		controller.abort();
		resolvePrepare?.(handle);
		await expect(preparing).rejects.toMatchObject({ name: "AbortError" });
		expect(disposed).toBe(1);
		expect(session.currentHandle).toBeUndefined();
		expect(session.currentStatus).toBe("failed");
	});
});
