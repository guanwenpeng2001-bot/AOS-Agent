import { realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createWorkspaceIdentity, type PolicyBinding, type SandboxCapabilities } from "../src/core/policy/execution.ts";
import {
	SandboxCredentialChannel,
	SandboxError,
	SandboxSession,
	preflightTaskCredentialDelivery,
	type SandboxCredentialDeliveryRequest,
	type SandboxCredentialRenewRequest,
	type SandboxCredentialRevokeRequest,
	type SandboxHandle,
	type SandboxOperationResult,
	type SandboxProvider,
} from "../src/core/policy/sandbox.ts";
import { TaskCredentialError, calculateScopeDigest, type TaskCredentialGrant, type TaskCredentialStatus } from "../src/core/policy/task-credential-lease.ts";
import type { TaskCredentialTargetCapabilities } from "../src/core/policy/task-credential-provider.ts";
import { createGondolinSandboxProvider, GONDOLIN_SANDBOX_PROVIDER_ID } from "../examples/extensions/gondolin/provider.ts";
import { createFakeGondolinVm, createFakeGondolinVmFactory } from "./fixtures/fake-gondolin-vm.ts";
import { createFakeSandboxProvider, FAKE_SANDBOX_PROVIDER_ID } from "./fixtures/fake-sandbox-provider.ts";

const NOW = "2026-08-16T12:00:00.000Z";

const DELIVERY_CAPABILITIES: SandboxCapabilities = {
	filesystem: true,
	process: true,
	network: false,
	credentialIsolation: true,
	credentialDelivery: true,
};

function makeBinding(overrides: Partial<PolicyBinding> = {}): PolicyBinding {
	return {
		schemaVersion: 1,
		id: "policy-binding:delivery-test",
		profileId: "delivery-test",
		profileRevision: "revision:delivery-test",
		projectTrust: "trusted",
		enforcement: "sandbox",
		sandboxProviderId: FAKE_SANDBOX_PROVIDER_ID,
		sandboxCapabilities: DELIVERY_CAPABILITIES,
		sandboxStatus: "ready",
		runId: "run:delivery-test",
		createdAt: "2026-08-16T00:00:00.000Z",
		workspaceIdentity: createWorkspaceIdentity("C:\\workspace\\delivery-test"),
		constraints: {
			workspace: { read: ["workspace"], write: ["workspace"], deny: [] },
			process: { action: "allow", inheritEnvironment: false, allowedEnvironmentCount: 0 },
			network: { action: "deny", allowedDestinationCount: 0 },
			credentials: { action: "deny", allowedNameCount: 0 },
		},
		bindingHash: "digest:delivery-test",
		...overrides,
	};
}

const SCOPES = [
	{
		credentialName: "GITHUB_TOKEN",
		purpose: "task",
		operations: ["read"],
		targetKinds: ["env"],
	},
];

// The grant's scope digest/count are the canonical facts of the SCOPES
// allowlist; delivery requests must correlate with them exactly.
const SCOPE_DIGEST = calculateScopeDigest(SCOPES);

const TARGET_CAPABILITIES: TaskCredentialTargetCapabilities = {
	schemaVersion: 1,
	targetId: "target_sandbox_1",
	targetKind: "isolated_sandbox",
	// The resolved target facts address the Task Execution Binding id, not
	// the capability binding id.
	bindingId: "binding_exec_1",
	canReceiveShortLivedCredential: true,
	canRenewCredential: true,
	canRevokeCredential: true,
	supportsPerBindingIsolation: true,
	supportsDeliveryReceipt: true,
};

function makeGrant(overrides: Partial<TaskCredentialGrant> = {}): TaskCredentialGrant {
	return {
		schemaVersion: 1,
		grantId: "grant_test_1",
		leaseId: "lease_test_1",
		bindingId: "binding_exec_1",
		sessionId: "session_test_1",
		taskId: "task_test_1",
		graphRevision: 1,
		nodeId: "node_test_1",
		runId: "run_test_1",
		scopeDigest: SCOPE_DIGEST,
		scopeCount: 1,
		status: "active",
		issuedAt: "2026-08-16T11:00:00.000Z",
		expiresAt: "2026-08-16T12:30:00.000Z",
		renewAfter: "2026-08-16T12:07:30.000Z",
		heartbeatSequence: 0,
		revision: 0,
		targetId: "target_sandbox_1",
		...overrides,
	};
}

function deliveryRequest(overrides: Partial<SandboxCredentialDeliveryRequest> = {}): SandboxCredentialDeliveryRequest {
	return {
		bindingId: "binding_exec_1",
		sandboxBindingId: "policy-binding:delivery-test",
		leaseId: "lease_test_1",
		grantId: "grant_test_1",
		targetId: "target_sandbox_1",
		scopes: SCOPES,
		expiresAt: "2026-08-16T12:30:00.000Z",
		clientRequestId: "delivery_request_1",
		...overrides,
	};
}

function renewRequest(overrides: Partial<SandboxCredentialRenewRequest> = {}): SandboxCredentialRenewRequest {
	return {
		bindingId: "binding_exec_1",
		sandboxBindingId: "policy-binding:delivery-test",
		leaseId: "lease_test_1",
		grantId: "grant_test_1",
		targetId: "target_sandbox_1",
		expiresAt: "2026-08-16T13:00:00.000Z",
		clientRequestId: "renew_request_1",
		...overrides,
	};
}

function revokeRequest(overrides: Partial<SandboxCredentialRevokeRequest> = {}): SandboxCredentialRevokeRequest {
	return {
		bindingId: "binding_exec_1",
		sandboxBindingId: "policy-binding:delivery-test",
		leaseId: "lease_test_1",
		grantId: "grant_test_1",
		targetId: "target_sandbox_1",
		clientRequestId: "revoke_request_1",
		...overrides,
	};
}

async function preparedChannel(
	options: { readonly capabilities?: Partial<SandboxCapabilities> } & Parameters<typeof createFakeSandboxProvider>[0] = {},
): Promise<{
	readonly channel: SandboxCredentialChannel;
	readonly session: SandboxSession;
	readonly handle: SandboxHandle;
	readonly state: ReturnType<typeof createFakeSandboxProvider>["state"];
}> {
	const { provider, state } = createFakeSandboxProvider({
		...(options.capabilities === undefined ? {} : { capabilities: options.capabilities }),
		...(options.credentialDeliveryStatus === undefined ? {} : { credentialDeliveryStatus: options.credentialDeliveryStatus }),
		...(options.credentialRevokeStatus === undefined ? {} : { credentialRevokeStatus: options.credentialRevokeStatus }),
		...(options.failCredentialOperation === undefined ? {} : { failCredentialOperation: options.failCredentialOperation }),
	});
	const binding = makeBinding(
		options.capabilities === undefined ? {} : { sandboxCapabilities: { ...DELIVERY_CAPABILITIES, ...options.capabilities } },
	);
	const session = new SandboxSession(provider, binding);
	const handle = await session.prepare();
	const channel = new SandboxCredentialChannel({
		session,
		bindingId: "binding_exec_1",
		capabilityBindingId: "capability_binding_1",
		sandboxBindingId: binding.id,
		targetId: "target_sandbox_1",
		targetCapabilities: TARGET_CAPABILITIES,
		now: () => NOW,
	});
	return { channel, session, handle, state };
}

const workspaces: string[] = [];

async function createWorkspace(): Promise<string> {
	const workspace = await mkdtemp(path.join(os.tmpdir(), "aos-task-credential-delivery-"));
	workspaces.push(workspace);
	return workspace;
}

afterEach(async () => {
	for (const workspace of workspaces.splice(0)) {
		await rm(workspace, { recursive: true, force: true }).catch(() => undefined);
	}
});

describe("read-only Task Credential delivery preflight", () => {
	it("accepts a live lease whose identity, binding, and target all match", () => {
		expect(preflightTaskCredentialDelivery(makeGrant(), deliveryRequest(), NOW)).toEqual({ ok: true });
	});

	it("fails closed on unknown, foreign, or mismatched leases", () => {
		expect(preflightTaskCredentialDelivery(undefined, deliveryRequest(), NOW)).toEqual({
			ok: false,
			code: "task_credential_not_found",
		});
		expect(preflightTaskCredentialDelivery(makeGrant({ leaseId: "lease_other" }), deliveryRequest(), NOW)).toEqual({
			ok: false,
			code: "task_credential_not_found",
		});
		expect(preflightTaskCredentialDelivery(makeGrant({ grantId: "grant_other" }), deliveryRequest(), NOW)).toEqual({
			ok: false,
			code: "task_credential_not_found",
		});
	});

	it("rejects a wrong binding and a wrong target", () => {
		expect(preflightTaskCredentialDelivery(makeGrant(), deliveryRequest({ bindingId: "binding_other" }), NOW)).toEqual({
			ok: false,
			code: "task_credential_binding_invalid",
		});
		expect(preflightTaskCredentialDelivery(makeGrant(), deliveryRequest({ targetId: "target_other" }), NOW)).toEqual({
			ok: false,
			code: "task_credential_binding_invalid",
		});
	});

	it("rejects terminal and expired leases and invalid clocks", () => {
		const statuses: ReadonlyArray<[TaskCredentialStatus, string]> = [
			["expired", "task_lease_expired"],
			["revoked", "task_credential_conflict"],
			["settled", "task_credential_conflict"],
			["revocation_unknown", "task_credential_revocation_unknown"],
		];
		for (const [status, code] of statuses) {
			expect(preflightTaskCredentialDelivery(makeGrant({ status }), deliveryRequest(), NOW)).toEqual({
				ok: false,
				code,
			});
		}
		expect(
			preflightTaskCredentialDelivery(makeGrant({ expiresAt: "2026-08-16T11:59:00.000Z" }), deliveryRequest(), NOW),
		).toEqual({ ok: false, code: "task_lease_expired" });
		expect(preflightTaskCredentialDelivery(makeGrant(), deliveryRequest(), "not-a-timestamp")).toEqual({
			ok: false,
			code: "task_credential_invalid",
		});
	});

	it("accepts renewing grants like active ones", () => {
		expect(preflightTaskCredentialDelivery(makeGrant({ status: "renewing" }), deliveryRequest(), NOW)).toEqual({
			ok: true,
		});
	});
});

describe("SandboxCredentialChannel per-binding delivery", () => {
	it("delivers material onto the bound target and builds a safe receipt", async () => {
		const { channel, state } = await preparedChannel();
		const receipt = await channel.project(makeGrant(), deliveryRequest());

		expect(receipt).toEqual({
			schemaVersion: 1,
			leaseId: "lease_test_1",
			grantId: "grant_test_1",
			bindingId: "binding_exec_1",
			targetId: "target_sandbox_1",
			status: "succeeded",
			recordedAt: NOW,
		});
		expect(state.credentialState.projects).toHaveLength(1);
		expect(state.credentialState.projects[0]).toMatchObject({
			bindingId: "binding_exec_1",
			sandboxBindingId: "policy-binding:delivery-test",
			leaseId: "lease_test_1",
			grantId: "grant_test_1",
			targetId: "target_sandbox_1",
			expiresAt: "2026-08-16T12:30:00.000Z",
			clientRequestId: "delivery_request_1",
		});
		expect(state.credentialState.projects[0].scopes).toEqual(SCOPES);
		expect(state.credentialState.revokes).toHaveLength(0);
	});

	it("renews and revokes on the same binding", async () => {
		const { channel, state } = await preparedChannel();

		const renewed = await channel.renew(makeGrant(), renewRequest());
		expect(renewed).toMatchObject({ status: "succeeded", recordedAt: NOW });
		expect(state.credentialState.renews).toHaveLength(1);
		expect(state.credentialState.renews[0].expiresAt).toBe("2026-08-16T13:00:00.000Z");

		const revoked = await channel.revoke(makeGrant(), revokeRequest({ reasonCode: "binding_replaced" }));
		expect(revoked).toMatchObject({
			status: "revoked",
			leaseId: "lease_test_1",
			grantId: "grant_test_1",
			bindingId: "binding_exec_1",
			reasonCode: "binding_replaced",
			recordedAt: NOW,
		});
		expect(state.credentialState.revokes).toHaveLength(1);
		expect(state.credentialState.revokes[0].reasonCode).toBe("binding_replaced");
		expect(channel.quarantined()).toEqual([]);
	});

	it("quarantines the target after a failed or unknown delivery and fails closed", async () => {
		const { channel, state } = await preparedChannel({ credentialDeliveryStatus: "failed" });

		const failed = await channel.project(makeGrant(), deliveryRequest());
		expect(failed.status).toBe("failed");
		expect(channel.isTargetQuarantined("target_sandbox_1")).toBe(true);
		expect(channel.quarantined()).toEqual(["target_sandbox_1"]);

		// Every later operation against the quarantined target fails closed
		// before the handle is touched again.
		await expect(channel.project(makeGrant(), deliveryRequest())).rejects.toMatchObject({
			code: "task_credential_binding_invalid",
		});
		await expect(channel.renew(makeGrant(), renewRequest())).rejects.toMatchObject({ code: "task_credential_binding_invalid" });
		await expect(channel.revoke(makeGrant(), revokeRequest())).rejects.toMatchObject({ code: "task_credential_binding_invalid" });
		expect(state.credentialState.projects).toHaveLength(1);
		expect(state.credentialState.renews).toHaveLength(0);
		expect(state.credentialState.revokes).toHaveLength(0);
	});

	it("quarantines the target after an unknown revoke outcome", async () => {
		const { channel, state } = await preparedChannel({ credentialRevokeStatus: "unknown" });

		const revoked = await channel.revoke(makeGrant(), revokeRequest());
		expect(revoked).toMatchObject({ status: "revocation_unknown", recordedAt: NOW });
		expect(channel.isTargetQuarantined("target_sandbox_1")).toBe(true);
		await expect(channel.revoke(makeGrant(), revokeRequest())).rejects.toMatchObject({ code: "task_credential_binding_invalid" });
		expect(state.credentialState.revokes).toHaveLength(1);
	});

	it("honors host-driven quarantine before any handle call", async () => {
		const { channel, state } = await preparedChannel();
		channel.quarantineTarget("target_sandbox_1");

		await expect(channel.project(makeGrant(), deliveryRequest())).rejects.toMatchObject({ code: "task_credential_binding_invalid" });
		expect(state.credentialState.projects).toHaveLength(0);
	});

	it("rejects a wrong execution binding and a wrong policy binding", async () => {
		const { channel, state } = await preparedChannel();

		await expect(channel.project(makeGrant(), deliveryRequest({ bindingId: "binding_other" }))).rejects.toMatchObject({
			code: "task_credential_binding_invalid",
		});
		await expect(
			channel.project(makeGrant(), deliveryRequest({ sandboxBindingId: "policy-binding:other" })),
		).rejects.toMatchObject({ code: "task_credential_binding_invalid" });
		expect(state.credentialState.projects).toHaveLength(0);
	});

	it("rejects a wrong target", async () => {
		const { channel, state } = await preparedChannel();

		await expect(channel.project(makeGrant(), deliveryRequest({ targetId: "target_other" }))).rejects.toMatchObject({
			code: "task_credential_binding_invalid",
		});
		expect(state.credentialState.projects).toHaveLength(0);
	});

	it("fails closed after the sandbox session is disposed", async () => {
		const { channel, session, state } = await preparedChannel();
		await session.dispose();

		await expect(channel.project(makeGrant(), deliveryRequest())).rejects.toMatchObject({ code: "sandbox_unavailable" });
		await expect(channel.renew(makeGrant(), renewRequest())).rejects.toMatchObject({ code: "sandbox_unavailable" });
		await expect(channel.revoke(makeGrant(), revokeRequest())).rejects.toMatchObject({ code: "sandbox_unavailable" });
		expect(state.credentialState.projects).toHaveLength(0);
		expect(state.credentialState.renews).toHaveLength(0);
		expect(state.credentialState.revokes).toHaveLength(0);
	});

	it("fails closed with task_credential_target_unavailable when the provider does not declare credentialDelivery", async () => {
		const { channel, state } = await preparedChannel({
			capabilities: { credentialDelivery: false },
		});

		const error = await channel.project(makeGrant(), deliveryRequest()).catch((reason: unknown) => reason);
		expect(error).toBeInstanceOf(TaskCredentialError);
		expect(error).toMatchObject({ code: "task_credential_target_unavailable" });
		expect(state.credentialState.projects).toHaveLength(0);
		expect(channel.preflight(makeGrant(), deliveryRequest(), NOW)).toEqual({
			ok: false,
			code: "task_credential_target_unavailable",
		});
	});

	it("fails closed when the handle exposes no delivery method despite the capability", async () => {
		const provider: SandboxProvider = {
			id: "raw-provider",
			capabilities: { ...DELIVERY_CAPABILITIES },
			prepare: async () => ({
				id: "raw-provider-handle",
				capabilities: { ...DELIVERY_CAPABILITIES },
				execute: async (): Promise<SandboxOperationResult> => ({ exitCode: 0 }),
			}),
			dispose: async () => undefined,
		};
		const session = new SandboxSession(provider, makeBinding({ sandboxProviderId: "raw-provider" }));
		await session.prepare();
		const channel = new SandboxCredentialChannel({
			session,
			bindingId: "binding_exec_1",
			capabilityBindingId: "capability_binding_1",
			sandboxBindingId: "policy-binding:delivery-test",
			targetId: "target_sandbox_1",
			targetCapabilities: TARGET_CAPABILITIES,
			now: () => NOW,
		});

		const error = await channel.project(makeGrant(), deliveryRequest()).catch((reason: unknown) => reason);
		expect(error).toBeInstanceOf(TaskCredentialError);
		expect(error).toMatchObject({ code: "task_credential_target_unavailable" });
	});

	it("quarantines and maps unknown handle failures to code-derived errors without leaking text", async () => {
		const { channel, state } = await preparedChannel({
			failCredentialOperation: (operation, leaseId) => operation === "project" && leaseId === "lease_test_1",
		});

		const error = await channel.project(makeGrant(), deliveryRequest()).catch((reason: unknown) => reason);
		expect(error).toBeInstanceOf(TaskCredentialError);
		expect(error).toMatchObject({ code: "task_credential_delivery_failed" });
		expect(String(error)).not.toContain("fake sandbox");
		expect(channel.isTargetQuarantined("target_sandbox_1")).toBe(true);

		const revokeError = await channel.revoke(makeGrant(), revokeRequest()).catch((reason: unknown) => reason);
		expect(revokeError).toMatchObject({ code: "task_credential_binding_invalid" });
		expect(state.credentialState.projects).toHaveLength(1);
		expect(state.credentialState.revokes).toHaveLength(0);
	});

	it("rejects malformed requests before any side effect", async () => {
		const { channel, state } = await preparedChannel();

		await expect(channel.project(makeGrant(), deliveryRequest({ targetId: "bad/target" }))).rejects.toMatchObject({
			code: "task_credential_invalid",
		});
		await expect(channel.project(makeGrant(), deliveryRequest({ expiresAt: "not-a-timestamp" }))).rejects.toMatchObject({
			code: "task_credential_invalid",
		});
		await expect(channel.project(makeGrant(), deliveryRequest({ scopes: [] }))).rejects.toMatchObject({
			code: "task_credential_invalid",
		});
		await expect(channel.revoke(makeGrant(), revokeRequest({ reasonCode: "bad reason!" }))).rejects.toMatchObject({
			code: "task_credential_invalid",
		});
		expect(state.credentialState.projects).toHaveLength(0);
		expect(state.credentialState.revokes).toHaveLength(0);
	});

	it("rejects a channel bound to a different policy binding", async () => {
		const { session } = await preparedChannel();
		expect(
			() =>
				new SandboxCredentialChannel({
					session,
					bindingId: "binding_exec_1",
					capabilityBindingId: "capability_binding_1",
					sandboxBindingId: "policy-binding:other",
					targetId: "target_sandbox_1",
					targetCapabilities: TARGET_CAPABILITIES,
				}),
		).toThrowError(new TaskCredentialError("task_credential_binding_invalid"));
	});

	it("rejects a channel whose target capabilities address a different target or binding", async () => {
		const { session } = await preparedChannel();
		expect(
			() =>
				new SandboxCredentialChannel({
					session,
					bindingId: "binding_exec_1",
					capabilityBindingId: "capability_binding_1",
					sandboxBindingId: "policy-binding:delivery-test",
					targetId: "target_sandbox_1",
					targetCapabilities: { ...TARGET_CAPABILITIES, targetId: "target_other" },
				}),
		).toThrowError(new TaskCredentialError("task_credential_binding_invalid"));
		// The target snapshot bindingId is the Task Execution Binding id: a
		// snapshot addressed to another execution binding fails closed.
		expect(
			() =>
				new SandboxCredentialChannel({
					session,
					bindingId: "binding_exec_1",
					capabilityBindingId: "capability_binding_1",
					sandboxBindingId: "policy-binding:delivery-test",
					targetId: "target_sandbox_1",
					targetCapabilities: { ...TARGET_CAPABILITIES, bindingId: "binding_exec_other" },
				}),
		).toThrowError(new TaskCredentialError("task_credential_binding_invalid"));
		// A snapshot still addressed to the capability binding (the old
		// contract) never authorizes the channel either.
		expect(
			() =>
				new SandboxCredentialChannel({
					session,
					bindingId: "binding_exec_1",
					capabilityBindingId: "capability_binding_1",
					sandboxBindingId: "policy-binding:delivery-test",
					targetId: "target_sandbox_1",
					targetCapabilities: { ...TARGET_CAPABILITIES, bindingId: "capability_binding_1" },
				}),
		).toThrowError(new TaskCredentialError("task_credential_binding_invalid"));
		expect(
			() =>
				new SandboxCredentialChannel({
					session,
					bindingId: "binding_exec_1",
					capabilityBindingId: "capability_binding_1",
					sandboxBindingId: "policy-binding:delivery-test",
					targetId: "target_sandbox_1",
					targetCapabilities: { ...TARGET_CAPABILITIES, canRevokeCredential: "yes" as never },
				}),
		).toThrowError(new TaskCredentialError("task_credential_invalid"));
	});

	it("validates raw target capability input before serialization and never throws TypeError", async () => {
		const { session } = await preparedChannel();
		const base = {
			session,
			bindingId: "binding_exec_1",
			capabilityBindingId: "capability_binding_1",
			sandboxBindingId: "policy-binding:delivery-test",
			targetId: "target_sandbox_1",
			now: () => NOW,
		};
		// Malformed runtime data (null, primitives, partial shapes, unknown
		// keys, extra material keys) yields only the stable TaskCredentialError
		// with the frozen code — never a TypeError or raw provider text.
		const malformed: unknown[] = [
			null,
			"raw provider text",
			42,
			{ schemaVersion: 1 },
			{ schemaVersion: 1, targetId: "target_sandbox_1", targetKind: "isolated_sandbox", bindingId: "binding_exec_1" },
			{ ...TARGET_CAPABILITIES, canRevokeCredential: "yes" },
			{ ...TARGET_CAPABILITIES, canRevokeCredential: undefined },
			{ ...TARGET_CAPABILITIES, token: "secret" },
			{ ...TARGET_CAPABILITIES, targetId: "bad/target" },
		];
		for (const targetCapabilities of malformed) {
			let thrown: unknown;
			try {
				new SandboxCredentialChannel({ ...base, targetCapabilities: targetCapabilities as never });
			} catch (error) {
				thrown = error;
			}
			expect(thrown).toBeInstanceOf(TaskCredentialError);
			expect(thrown).not.toBeInstanceOf(TypeError);
			if (thrown instanceof TaskCredentialError) {
				expect(thrown.code).toBe("task_credential_invalid");
				expect(thrown.message).not.toContain("raw provider text");
			}
		}
	});

	it("keeps preflight read-only: no handle calls, no quarantine mutations", async () => {
		const { channel, state } = await preparedChannel({ credentialDeliveryStatus: "failed" });

		expect(channel.preflight(makeGrant(), deliveryRequest(), NOW)).toEqual({ ok: true });
		expect(channel.preflight(makeGrant({ status: "revoked" }), deliveryRequest(), NOW)).toEqual({
			ok: false,
			code: "task_credential_conflict",
		});
		expect(channel.preflight(makeGrant(), deliveryRequest({ targetId: "target_other" }), NOW)).toEqual({
			ok: false,
			code: "task_credential_binding_invalid",
		});
		expect(channel.isTargetQuarantined("target_sandbox_1")).toBe(false);
		expect(channel.quarantined()).toEqual([]);
		expect(state.credentialState.projects).toHaveLength(0);
		expect(state.credentialState.renews).toHaveLength(0);
		expect(state.credentialState.revokes).toHaveLength(0);
	});

	it("reports capability and availability failures through read-only preflight", async () => {
		const withoutCapability = await preparedChannel({ capabilities: { credentialDelivery: false } });
		expect(withoutCapability.channel.preflight(makeGrant(), deliveryRequest(), NOW)).toEqual({
			ok: false,
			code: "task_credential_target_unavailable",
		});

		const disposed = await preparedChannel();
		await disposed.session.dispose();
		expect(disposed.channel.preflight(makeGrant(), deliveryRequest(), NOW)).toEqual({
			ok: false,
			code: "sandbox_unavailable",
		});
	});

	it("never reaches the handle without a live grant preflight", async () => {
		const { channel, state } = await preparedChannel();

		// Missing, foreign, terminal, or expired grants fail before the handle.
		await expect(channel.project(undefined as never, deliveryRequest())).rejects.toMatchObject({
			code: "task_credential_not_found",
		});
		await expect(channel.project(makeGrant({ leaseId: "lease_other" }), deliveryRequest())).rejects.toMatchObject({
			code: "task_credential_not_found",
		});
		await expect(channel.renew(makeGrant({ status: "expired" }), renewRequest())).rejects.toMatchObject({
			code: "task_lease_expired",
		});
		await expect(channel.revoke(makeGrant({ status: "revoked" }), revokeRequest())).rejects.toMatchObject({
			code: "task_credential_conflict",
		});
		expect(state.credentialState.projects).toHaveLength(0);
		expect(state.credentialState.renews).toHaveLength(0);
		expect(state.credentialState.revokes).toHaveLength(0);
	});

	it("correlates the projected scopes and expiry with the grant", async () => {
		const { channel, state } = await preparedChannel();

		// A different scope list (wrong count) is a conflict.
		await expect(
			channel.project(makeGrant(), deliveryRequest({ scopes: [{ ...SCOPES[0], purpose: "other" }] })),
		).rejects.toMatchObject({ code: "task_credential_conflict" });
		// A scope set that normalizes to a different count is a conflict too.
		await expect(
			channel.project(
				makeGrant(),
				deliveryRequest({ scopes: [SCOPES[0], { ...SCOPES[0], purpose: "other" }] }),
			),
		).rejects.toMatchObject({ code: "task_credential_conflict" });
		// A wrong digest (grant declares different scopes) is a conflict.
		const otherGrant = makeGrant({
			scopeDigest: calculateScopeDigest([{ ...SCOPES[0], purpose: "other" }]),
		});
		await expect(channel.project(otherGrant, deliveryRequest())).rejects.toMatchObject({
			code: "task_credential_conflict",
		});
		// The projected expiry must be the grant's canonical expiry.
		await expect(
			channel.project(makeGrant(), deliveryRequest({ expiresAt: "2026-08-16T12:45:00.000Z" })),
		).rejects.toMatchObject({ code: "task_credential_conflict" });
		expect(state.credentialState.projects).toHaveLength(0);
	});

	it("bounds the proposed renew expiry against the current grant", async () => {
		const { channel, state } = await preparedChannel();

		// Renewal must strictly extend the current expiry.
		await expect(
			channel.renew(makeGrant(), renewRequest({ expiresAt: "2026-08-16T12:30:00.000Z" })),
		).rejects.toMatchObject({ code: "task_credential_ttl_invalid" });
		await expect(
			channel.renew(makeGrant(), renewRequest({ expiresAt: "2026-08-16T12:00:00.000Z" })),
		).rejects.toMatchObject({ code: "task_credential_ttl_invalid" });
		// Renewal must never push the lease past the absolute ceiling
		// (issuedAt 11:00 + 24h).
		await expect(
			channel.renew(makeGrant(), renewRequest({ expiresAt: "2026-08-17T12:00:00.000Z" })),
		).rejects.toMatchObject({ code: "task_credential_ttl_invalid" });
		await expect(channel.renew(makeGrant(), renewRequest())).resolves.toMatchObject({ status: "succeeded" });
		expect(state.credentialState.renews).toHaveLength(1);
	});

	it("enforces the per-operation target capabilities and receipt support", async () => {
		const withTarget = async (capabilities: Partial<TaskCredentialTargetCapabilities>) => {
			const { provider, state } = createFakeSandboxProvider();
			const session = new SandboxSession(provider, makeBinding());
			await session.prepare();
			return {
				channel: new SandboxCredentialChannel({
					session,
					bindingId: "binding_exec_1",
					capabilityBindingId: "capability_binding_1",
					sandboxBindingId: "policy-binding:delivery-test",
					targetId: "target_sandbox_1",
					targetCapabilities: { ...TARGET_CAPABILITIES, ...capabilities },
					now: () => NOW,
				}),
				state,
			};
		};

		const noProject = await withTarget({ canReceiveShortLivedCredential: false });
		await expect(noProject.channel.project(makeGrant(), deliveryRequest())).rejects.toMatchObject({
			code: "task_credential_target_unavailable",
		});
		const noReceipt = await withTarget({ supportsDeliveryReceipt: false });
		await expect(noReceipt.channel.project(makeGrant(), deliveryRequest())).rejects.toMatchObject({
			code: "task_credential_target_unavailable",
		});
		const noRenew = await withTarget({ canRenewCredential: false });
		await expect(noRenew.channel.renew(makeGrant(), renewRequest())).rejects.toMatchObject({
			code: "task_credential_target_unavailable",
		});
		const noRevoke = await withTarget({ canRevokeCredential: false });
		await expect(noRevoke.channel.revoke(makeGrant(), revokeRequest())).rejects.toMatchObject({
			code: "task_credential_target_unavailable",
		});
		const noIsolation = await withTarget({ supportsPerBindingIsolation: false });
		for (const operation of [
			() => noIsolation.channel.project(makeGrant(), deliveryRequest()),
			() => noIsolation.channel.renew(makeGrant(), renewRequest()),
			() => noIsolation.channel.revoke(makeGrant(), revokeRequest()),
		]) {
			await expect(operation()).rejects.toMatchObject({ code: "task_credential_target_unavailable" });
		}
		// The same failures are visible through read-only preflight.
		expect(noProject.channel.preflight(makeGrant(), deliveryRequest(), NOW)).toEqual({
			ok: false,
			code: "task_credential_target_unavailable",
		});
		expect(noReceipt.channel.preflight(makeGrant(), deliveryRequest(), NOW)).toEqual({
			ok: false,
			code: "task_credential_target_unavailable",
		});
		expect(noProject.state.credentialState.projects).toHaveLength(0);
		expect(noReceipt.state.credentialState.projects).toHaveLength(0);
	});

	it("reports malformed preflight input as the stable invalid error", async () => {
		const { channel, state } = await preparedChannel();

		// Malformed requests fail with the stable TaskCredentialError both on
		// the read-only preflight surface and on the operations, and never
		// reach the handle.
		expect(() => channel.preflight(makeGrant(), deliveryRequest({ targetId: "bad/target" }), NOW)).toThrowError(
			new TaskCredentialError("task_credential_invalid"),
		);
		await expect(channel.project(makeGrant(), deliveryRequest({ expiresAt: "not-a-timestamp" }))).rejects.toMatchObject({
			code: "task_credential_invalid",
		});
		expect(state.credentialState.projects).toHaveLength(0);
	});

	it("maps disposed-handle provider errors to stable codes and quarantines the target", async () => {
		const { channel, handle, state } = await preparedChannel();
		state.disposedHandles.push(handle.id);

		// The provider's credential method throws its own disposed-handle
		// error; the channel maps it to a stable Task Credential code without
		// raw text and quarantines the target, so the second call fails closed
		// before the handle is touched again.
		const error = await channel.project(makeGrant(), deliveryRequest()).catch((reason: unknown) => reason);
		expect(error).toBeInstanceOf(TaskCredentialError);
		expect(error).toMatchObject({ code: "task_credential_delivery_failed" });
		expect(String(error)).not.toContain("has been disposed");
		expect(channel.isTargetQuarantined("target_sandbox_1")).toBe(true);
		expect(state.credentialState.projects).toHaveLength(0);
		await expect(channel.project(makeGrant(), deliveryRequest())).rejects.toMatchObject({
			code: "task_credential_binding_invalid",
		});
		expect(state.credentialState.projects).toHaveLength(0);
	});
});

describe("gondolin-local credential delivery", () => {
	it("never declares credentialDelivery and rejects any credential routing", async () => {
		const workspace = await createWorkspace();
		const vm = createFakeGondolinVm();
		const provider = createGondolinSandboxProvider({
			workspaceRoot: workspace,
			vmFactory: createFakeGondolinVmFactory(vm),
		});

		// gondolin-local never declares the credential delivery capability.
		expect(provider.capabilities.credentialDelivery).toBe(false);

		// A binding that requires the undeclared capability fails closed at
		// prepare; no delivery channel exists and no host fallback is possible.
		const requiring = makeBinding({
			id: "policy-binding:gondolin-requiring",
			sandboxProviderId: GONDOLIN_SANDBOX_PROVIDER_ID,
			workspaceIdentity: createWorkspaceIdentity(realpathSync(workspace)),
			sandboxCapabilities: {
				filesystem: true,
				process: true,
				network: false,
				credentialIsolation: true,
				credentialDelivery: true,
			},
		});
		await expect(provider.prepare(requiring)).rejects.toMatchObject({
			code: "sandbox_capability_insufficient",
			providerId: GONDOLIN_SANDBOX_PROVIDER_ID,
		});

		// The handle has no provider-neutral credential methods at all, and
		// routed credential delivery operations fail closed with the missing
		// capability instead of any fallback.
		const binding = makeBinding({
			id: "policy-binding:gondolin-plain",
			sandboxProviderId: GONDOLIN_SANDBOX_PROVIDER_ID,
			workspaceIdentity: createWorkspaceIdentity(realpathSync(workspace)),
			sandboxCapabilities: {
				filesystem: true,
				process: true,
				network: false,
				credentialIsolation: true,
			},
		});
		const handle = await provider.prepare(binding);
		expect(handle.projectCredential).toBeUndefined();
		expect(handle.renewCredential).toBeUndefined();
		expect(handle.revokeCredential).toBeUndefined();
		for (const resource of ["credential.task.project", "credential.task.renew", "credential.task.revoke"] as const) {
			await expect(handle.execute({ bindingId: binding.id, resource })).rejects.toMatchObject({
				code: "sandbox_capability_insufficient",
				providerId: GONDOLIN_SANDBOX_PROVIDER_ID,
			});
		}

		// A channel over the gondolin session fails closed with the strict
		// provider-neutral code before the handle is ever called.
		const session = new SandboxSession(provider, binding);
		await session.prepare();
		const channel = new SandboxCredentialChannel({
			session,
			bindingId: "binding_exec_1",
			capabilityBindingId: "capability_binding_1",
			sandboxBindingId: binding.id,
			targetId: "target_sandbox_1",
			targetCapabilities: TARGET_CAPABILITIES,
			now: () => NOW,
		});
		await expect(channel.project(makeGrant(), deliveryRequest({ sandboxBindingId: binding.id }))).rejects.toMatchObject({
			code: "task_credential_target_unavailable",
		});
		expect(channel.preflight(makeGrant(), deliveryRequest({ sandboxBindingId: binding.id }), NOW)).toEqual({
			ok: false,
			code: "task_credential_target_unavailable",
		});
		expect(await channel.project(makeGrant(), deliveryRequest({ sandboxBindingId: binding.id })).catch((reason: unknown) => reason)).toBeInstanceOf(TaskCredentialError);
		expect(await channel.project(makeGrant(), deliveryRequest({ sandboxBindingId: binding.id })).catch((reason: unknown) => reason)).not.toBeInstanceOf(SandboxError);
	});
});
