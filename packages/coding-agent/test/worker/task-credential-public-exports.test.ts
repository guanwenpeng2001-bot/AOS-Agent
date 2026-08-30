import { describe, expect, it } from "vitest";
import * as packageEntry from "../../src/index.ts";
import {
	TASK_CREDENTIAL_ACTION,
	TASK_CREDENTIAL_CUSTOM_TYPE,
	TASK_CREDENTIAL_DELIVERY_STATUS,
	TASK_CREDENTIAL_ERROR_CODES,
	TASK_CREDENTIAL_SCHEMA_VERSION,
	TASK_CREDENTIAL_STATUS,
	TaskCredentialError,
	createTaskCredentialNullTarget,
	type TaskCredentialDeliveryReceipt,
	type TaskCredentialErrorCode,
	type TaskCredentialGrant,
	type TaskCredentialIssueRequest,
	type TaskCredentialIssuer,
	type TaskCredentialProvider,
	type TaskCredentialProviderReceipt,
	type TaskCredentialScope,
	type TaskCredentialTarget,
	type TaskCredentialTargetCapabilities,
	type TaskCredentialTtlBounds,
	type TaskExecutionBinding,
} from "../../src/core/index.ts";
import type {
	RpcTaskCredentialCommandType,
	TaskCredentialGetData,
	TaskCredentialHeartbeatData,
	TaskCredentialIssueData,
	TaskCredentialListData,
	TaskCredentialRevokeData,
	TaskCredentialSettleData,
} from "../../src/modes/index.ts";
import type {
	TaskCredentialServiceRevokeInput,
	TaskCredentialServiceSettleInput,
} from "../../src/core/policy/task-credential-service.ts";
// The modes entry must expose the same RPC command/response union surface.
import type { RpcTaskCredentialCommandType as ModesRpcTaskCredentialCommandType } from "../../src/modes/index.ts";

const NOW = "2026-08-16T10:00:00.000Z";
const DIGEST = `sha256:${"0".repeat(64)}`;

function validBinding(): TaskExecutionBinding {
	return {
		schemaVersion: 1,
		bindingId: "binding_001",
		sessionId: "session_001",
		taskId: "task_001",
		graphRevision: 1,
		nodeId: "node_001",
		runId: "run_001",
		capabilityBindingId: "cap_001",
		policyBindingId: "policy_001",
		createdAt: NOW,
		bindingRevision: 1,
	};
}

function validScope(): TaskCredentialScope {
	return {
		credentialName: "package_registry",
		purpose: "dependency_read",
		operations: ["read"],
		targetKinds: ["isolated_sandbox"],
	};
}

function validGrant(): TaskCredentialGrant {
	return {
		schemaVersion: 1,
		grantId: "grant_001",
		leaseId: "lease_001",
		bindingId: "binding_001",
		sessionId: "session_001",
		taskId: "task_001",
		graphRevision: 1,
		nodeId: "node_001",
		runId: "run_001",
		scopeDigest: DIGEST,
		scopeCount: 1,
		status: "active",
		issuedAt: NOW,
		expiresAt: "2026-08-16T10:01:00.000Z",
		renewAfter: "2026-08-16T10:00:55.000Z",
		heartbeatSequence: 0,
		revision: 0,
	};
}

function validCapabilities(): TaskCredentialTargetCapabilities {
	return {
		schemaVersion: 1,
		targetId: "target_001",
		targetKind: "isolated_sandbox",
		bindingId: "binding_001",
		canReceiveShortLivedCredential: true,
		canRenewCredential: true,
		canRevokeCredential: true,
		supportsPerBindingIsolation: true,
		supportsDeliveryReceipt: true,
	};
}

describe("Task Credential / Lease internal contracts", () => {
	it("keeps the contract available internally and out of the package entry", () => {
		expect(typeof TaskCredentialError).toBe("function");
		expect(typeof createTaskCredentialNullTarget).toBe("function");
		expect(TASK_CREDENTIAL_SCHEMA_VERSION).toBe(1);
		expect(TASK_CREDENTIAL_CUSTOM_TYPE).toBe("task.credential");
		expect(TASK_CREDENTIAL_STATUS).toEqual([
			"active",
			"renewing",
			"expired",
			"revoked",
			"settled",
			"revocation_unknown",
		]);
		expect(TASK_CREDENTIAL_ACTION).toContain("issued");
		expect(TASK_CREDENTIAL_DELIVERY_STATUS).toEqual(["succeeded", "failed", "unknown"]);
		expect(TASK_CREDENTIAL_ERROR_CODES).toContain("task_credential_revocation_unknown");
		expect(TASK_CREDENTIAL_ERROR_CODES).toContain("task_lease_heartbeat_invalid");
		expect("TASK_CREDENTIAL_SCHEMA_VERSION" in packageEntry).toBe(false);
		expect("TaskCredentialError" in packageEntry).toBe(false);
		// Material-bearing internals stay module-private: the test provider
		// (which seeds sentinel material), the material-receiving target
		// request, the material target, and the store implementation are not
		// part of the public entry.
		expect("createTaskCredentialTestProvider" in packageEntry).toBe(false);
		expect("TaskCredentialTargetProjectRequest" in packageEntry).toBe(false);
		expect("TaskCredentialMaterialTarget" in packageEntry).toBe(false);
		expect("TaskCredentialTestProviderOptions" in packageEntry).toBe(false);
		expect("TaskCredentialStore" in packageEntry).toBe(false);
	});

	it("exposes the stable TaskCredentialError contract", () => {
		const unknown = new TaskCredentialError("task_credential_revocation_unknown");
		expect(unknown.code).toBe("task_credential_revocation_unknown");
		expect(unknown.retryable).toBe(false);
		expect(unknown.toJSON()).toEqual({
			code: "task_credential_revocation_unknown",
			message: "Task credential revocation outcome is unknown.",
			retryable: false,
		});
		expect(new TaskCredentialError("task_credential_provider_unavailable").retryable).toBe(true);
	});

	it("null target fails closed through the exported facade", () => {
		const target = createTaskCredentialNullTarget({ now: () => NOW });
		const capabilities = target.getCapabilities({
			schemaVersion: 1,
			targetId: "target_001",
			targetKind: "isolated_sandbox",
			bindingId: "binding_001",
			requestedAt: NOW,
		});
		expect(capabilities.canReceiveShortLivedCredential).toBe(false);
		expect(capabilities.canRenewCredential).toBe(false);
		expect(capabilities.canRevokeCredential).toBe(false);
		expect(capabilities.supportsPerBindingIsolation).toBe(false);
		expect(capabilities.supportsDeliveryReceipt).toBe(false);
		const receipt = target.project({
			schemaVersion: 1,
			leaseId: "lease_001",
			grantId: "grant_001",
			bindingId: "binding_001",
			requestedAt: NOW,
		});
		expect(receipt.status).toBe("failed");
		expect(receipt.reasonCode).toBe("task_credential_target_unavailable");
	});

	it("keeps the public types type-safe for Host wiring", () => {
		const binding = validBinding();
		const scopes: TaskCredentialScope[] = [validScope()];
		const grant = validGrant();
		expect(grant.leaseId).toBe("lease_001");
		const capabilities = validCapabilities();
		const providerReceipt: TaskCredentialProviderReceipt = {
			schemaVersion: 1,
			leaseId: "lease_001",
			grantId: "grant_001",
			bindingId: "binding_001",
			status: "issued",
			recordedAt: NOW,
		};
		const deliveryReceipt: TaskCredentialDeliveryReceipt = {
			schemaVersion: 1,
			leaseId: "lease_001",
			grantId: "grant_001",
			bindingId: "binding_001",
			status: "succeeded",
			recordedAt: NOW,
		};
		const ttlBounds: TaskCredentialTtlBounds = { minTtlMs: 10_000, maxTtlMs: 60_000 };
		const issueRequest: TaskCredentialIssueRequest = {
			grantId: "grant_001",
			leaseId: "lease_001",
			binding,
			scopes,
			requestedTtlMs: 30_000,
			ttlBounds,
		};
		expect(issueRequest.requestedTtlMs).toBe(30_000);
		const issuer: TaskCredentialIssuer = {
			issue: () => providerReceipt,
			renew: () => providerReceipt,
			revoke: () => providerReceipt,
		};
		const target: TaskCredentialTarget = {
			getCapabilities: () => capabilities,
			project: () => deliveryReceipt,
			renew: () => providerReceipt,
			revoke: () => providerReceipt,
		};
		const provider: TaskCredentialProvider = { issuer, target };
		expect(provider.issuer).toBe(issuer);
		expect(provider.target).toBe(target);
		const revokeInput: TaskCredentialServiceRevokeInput = {
			leaseId: "lease_001",
			clientRequestId: "revoke-001",
			nodeAttached: true,
		};
		expect(revokeInput.leaseId).toBe("lease_001");
		const settleInput: TaskCredentialServiceSettleInput = {
			leaseId: "lease_001",
			clientRequestId: "settle-001",
		};
		expect(settleInput.clientRequestId).toBe("settle-001");
	});

	it("exposes the additive RPC command and response union types from both entries", () => {
		const commands: RpcTaskCredentialCommandType[] = [
			"task.credential.issue",
			"task.credential.get",
			"task.credential.list",
			"task.credential.heartbeat",
			"task.credential.revoke",
			"task.credential.settle",
		];
		expect(commands).toHaveLength(6);
		const modesCommands: ModesRpcTaskCredentialCommandType[] = commands;
		expect(modesCommands).toEqual(commands);
		const grant = validGrant();
		const issueData: TaskCredentialIssueData = { grant, leaseId: "lease_001", bindingId: "binding_001", idempotent: false };
		const getData: TaskCredentialGetData = { grant };
		const listData: TaskCredentialListData = { grants: [grant], truncated: false };
		const heartbeatData: TaskCredentialHeartbeatData = {
			grant,
			leaseId: "lease_001",
			bindingId: "binding_001",
			idempotent: false,
		};
		const revokeData: TaskCredentialRevokeData = { grant, idempotent: false };
		const settleData: TaskCredentialSettleData = { grant, idempotent: false };
		expect(issueData.grant.leaseId).toBe("lease_001");
		expect(issueData.idempotent).toBe(false);
		expect(getData.grant.leaseId).toBe("lease_001");
		expect(listData.grants).toHaveLength(1);
		expect(listData.truncated).toBe(false);
		expect(heartbeatData.grant.status).toBe("active");
		expect(revokeData.grant.grantId).toBe("grant_001");
		expect(settleData.grant.grantId).toBe("grant_001");
	});

	it("keeps error codes assignable to the public error code type", () => {
		const codes: readonly TaskCredentialErrorCode[] = TASK_CREDENTIAL_ERROR_CODES;
		expect(codes).toContain("task_credential_target_unavailable");
		expect(codes).toContain("task_credential_persistence_failed");
	});
});
