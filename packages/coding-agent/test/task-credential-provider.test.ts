import { describe, expect, it } from "vitest";
import {
	TASK_CREDENTIAL_SCHEMA_VERSION,
	TaskCredentialError,
	isTaskCredentialScope,
	isTaskExecutionBinding,
	serializeTaskCredentialDeliveryReceipt,
	type TaskCredentialDeliveryReceipt,
	type TaskCredentialDeliveryStatus,
	type TaskCredentialScope,
	type TaskExecutionBinding,
} from "../src/core/policy/task-credential-lease.ts";
import {
	createTaskCredentialNullTarget,
	createTaskCredentialTestProvider,
	isTaskCredentialProviderIssueRequest,
	isTaskCredentialProviderProjectRequest,
	isTaskCredentialProviderReceipt,
	isTaskCredentialProviderRenewRequest,
	isTaskCredentialProviderRevokeRequest,
	isTaskCredentialTargetCapabilities,
	isTaskCredentialTargetCapabilitiesRequest,
	isTaskCredentialTargetRenewRequest,
	isTaskCredentialTargetRevokeRequest,
	parseTaskCredentialProviderReceipt,
	parseTaskCredentialTargetCapabilities,
	serializeTaskCredentialProviderReceipt,
	serializeTaskCredentialTargetCapabilities,
	type TaskCredentialProviderIssueRequest,
	type TaskCredentialProviderProjectRequest,
	type TaskCredentialProviderReceipt,
	type TaskCredentialProviderReceiptStatus,
	type TaskCredentialTargetCapabilities,
	type TaskCredentialTargetCapabilitiesRequest,
	type TaskCredentialTargetRenewRequest,
	type TaskCredentialTargetRevokeRequest,
} from "../src/core/policy/task-credential-provider.ts";

const NOW = "2026-08-16T12:00:00.000Z";
const SENTINEL = "sentinel-secret-42";

function makeBinding(overrides: Partial<TaskExecutionBinding> = {}): TaskExecutionBinding {
	return {
		schemaVersion: 1,
		bindingId: "binding_001",
		sessionId: "session_001",
		taskId: "task_42",
		graphRevision: 7,
		nodeId: "node_test",
		stageId: "stage_run",
		stageRevision: 2,
		runId: "run_001",
		capabilityBindingId: "cap_001",
		policyBindingId: "policy_001",
		sandboxBindingId: "sandbox_1",
		targetId: "target_1",
		workerId: "worker_1",
		createdAt: "2026-08-16T11:59:00.000Z",
		bindingRevision: 1,
		...overrides,
	};
}

function makeScope(overrides: Partial<TaskCredentialScope> = {}): TaskCredentialScope {
	return {
		credentialName: "package_registry",
		purpose: "dependency_read",
		resource: "registry.internal",
		operations: ["read", "list"],
		targetKinds: ["isolated_sandbox"],
		...overrides,
	};
}

function issueRequest(overrides: Partial<TaskCredentialProviderIssueRequest> = {}): TaskCredentialProviderIssueRequest {
	return {
		schemaVersion: TASK_CREDENTIAL_SCHEMA_VERSION,
		leaseId: "lease_001",
		grantId: "grant_001",
		binding: makeBinding(),
		scopes: [makeScope()],
		requestedTtlMs: 60_000,
		requestedAt: NOW,
		...overrides,
	};
}

function projectRequest(overrides: Partial<TaskCredentialProviderProjectRequest> = {}): TaskCredentialProviderProjectRequest {
	return {
		schemaVersion: TASK_CREDENTIAL_SCHEMA_VERSION,
		leaseId: "lease_001",
		grantId: "grant_001",
		bindingId: "binding_001",
		targetId: "target_1",
		requestedAt: NOW,
		...overrides,
	};
}

function capabilitiesRequest(
	overrides: Partial<TaskCredentialTargetCapabilitiesRequest> = {},
): TaskCredentialTargetCapabilitiesRequest {
	return {
		schemaVersion: TASK_CREDENTIAL_SCHEMA_VERSION,
		targetId: "target_1",
		targetKind: "isolated_sandbox",
		bindingId: "binding_001",
		requestedAt: NOW,
		...overrides,
	};
}

function targetRenewRequest(overrides: Partial<TaskCredentialTargetRenewRequest> = {}): TaskCredentialTargetRenewRequest {
	return {
		schemaVersion: TASK_CREDENTIAL_SCHEMA_VERSION,
		leaseId: "lease_001",
		grantId: "grant_001",
		bindingId: "binding_001",
		targetId: "target_1",
		requestedTtlMs: 60_000,
		requestedAt: NOW,
		...overrides,
	};
}

function targetRevokeRequest(overrides: Partial<TaskCredentialTargetRevokeRequest> = {}): TaskCredentialTargetRevokeRequest {
	return {
		schemaVersion: TASK_CREDENTIAL_SCHEMA_VERSION,
		leaseId: "lease_001",
		grantId: "grant_001",
		bindingId: "binding_001",
		targetId: "target_1",
		reasonCode: "task_completed",
		requestedAt: NOW,
		...overrides,
	};
}

function providerReceipt(
	overrides: Partial<TaskCredentialProviderReceipt> = {},
): TaskCredentialProviderReceipt {
	return {
		schemaVersion: TASK_CREDENTIAL_SCHEMA_VERSION,
		leaseId: "lease_001",
		grantId: "grant_001",
		bindingId: "binding_001",
		status: "issued",
		recordedAt: NOW,
		...overrides,
	};
}

function expectCredentialError(fn: () => unknown, code: string): void {
	try {
		fn();
	} catch (error) {
		expect(error).toBeInstanceOf(TaskCredentialError);
		expect((error as TaskCredentialError).code).toBe(code);
		expect((error as TaskCredentialError).message).not.toContain(SENTINEL);
		expect(JSON.stringify((error as TaskCredentialError).toJSON())).not.toContain(SENTINEL);
		return;
	}
	throw new Error(`expected TaskCredentialError with code ${code}`);
}

describe("provider receipt", () => {
	it("round-trips a receipt and rejects unknown or material keys", () => {
		const receipt = providerReceipt({ status: "renewed", reasonCode: "operator_initiated" });
		expect(isTaskCredentialProviderReceipt(receipt)).toBe(true);
		expect(parseTaskCredentialProviderReceipt(receipt)).toEqual(receipt);
		expect(parseTaskCredentialProviderReceipt(serializeTaskCredentialProviderReceipt(receipt))).toEqual(receipt);
		expect(isTaskCredentialProviderReceipt({ ...receipt, token: SENTINEL })).toBe(false);
		expect(isTaskCredentialProviderReceipt({ ...receipt, material: SENTINEL })).toBe(false);
		expect(isTaskCredentialProviderReceipt({ ...receipt, value: SENTINEL })).toBe(false);
		expect(isTaskCredentialProviderReceipt({ ...receipt, secret: SENTINEL })).toBe(false);
	});

	it("rejects bad identifiers, statuses, timestamps, and reason codes", () => {
		expect(isTaskCredentialProviderReceipt(providerReceipt({ leaseId: "lease/../x" }))).toBe(false);
		expect(isTaskCredentialProviderReceipt(providerReceipt({ grantId: "grant@evil" }))).toBe(false);
		expect(isTaskCredentialProviderReceipt(providerReceipt({ status: "leaked" as never }))).toBe(false);
		expect(isTaskCredentialProviderReceipt(providerReceipt({ recordedAt: "2026-08-16T12:00:00Z" }))).toBe(false);
		expect(isTaskCredentialProviderReceipt(providerReceipt({ recordedAt: "yesterday" }))).toBe(false);
		expect(isTaskCredentialProviderReceipt(providerReceipt({ reasonCode: "a".repeat(65) }))).toBe(false);
		expect(isTaskCredentialProviderReceipt(null)).toBe(false);
		expect(isTaskCredentialProviderReceipt("issued")).toBe(false);
	});

	it("never serializes material into JSON", () => {
		const json = JSON.stringify(serializeTaskCredentialProviderReceipt(providerReceipt()));
		expect(json).not.toContain(SENTINEL);
		expect(json).not.toContain("token");
		expect(json).not.toContain("secret");
		expect(json).not.toContain("material");
	});
});

describe("provider request contracts", () => {
	it("accepts a complete material-free issue request", () => {
		const request = issueRequest();
		expect(isTaskCredentialProviderIssueRequest(request)).toBe(true);
		expect(JSON.stringify(request)).not.toContain(SENTINEL);
	});

	it("rejects issue requests that smuggle material keys", () => {
		for (const key of ["token", "secret", "material", "value", "password", "apiKey", "authorization", "credentials"]) {
			expect(isTaskCredentialProviderIssueRequest({ ...issueRequest(), [key]: SENTINEL })).toBe(false);
		}
		expect(isTaskCredentialProviderIssueRequest({ ...issueRequest(), binding: { ...makeBinding(), token: SENTINEL } })).toBe(false);
		expect(isTaskCredentialProviderIssueRequest({ ...issueRequest(), scopes: [{ ...makeScope(), value: SENTINEL }] })).toBe(false);
	});

	it("rejects malformed issue requests", () => {
		expect(isTaskCredentialProviderIssueRequest({ ...issueRequest(), requestedAt: "now" })).toBe(false);
		expect(isTaskCredentialProviderIssueRequest({ ...issueRequest(), requestedTtlMs: 0 })).toBe(false);
		expect(isTaskCredentialProviderIssueRequest({ ...issueRequest(), requestedTtlMs: 1.5 })).toBe(false);
		expect(isTaskCredentialProviderIssueRequest({ ...issueRequest(), binding: makeBinding({ sessionId: "" }) })).toBe(false);
		expect(isTaskCredentialProviderIssueRequest({ ...issueRequest(), scopes: [] })).toBe(true);
		expect(isTaskCredentialProviderIssueRequest({ ...issueRequest(), leaseId: "lease/path" })).toBe(false);
		expect(isTaskCredentialProviderIssueRequest({ ...issueRequest(), schemaVersion: 2 })).toBe(false);
		expect(isTaskCredentialProviderIssueRequest(null)).toBe(false);
	});

	it("validates renew, revoke, and project requests strictly", () => {
		const renew = {
			schemaVersion: TASK_CREDENTIAL_SCHEMA_VERSION,
			leaseId: "lease_001",
			grantId: "grant_001",
			bindingId: "binding_001",
			requestedTtlMs: 60_000,
			requestedAt: NOW,
		};
		expect(isTaskCredentialProviderRenewRequest(renew)).toBe(true);
		expect(isTaskCredentialProviderRenewRequest({ ...renew, secret: SENTINEL })).toBe(false);
		expect(isTaskCredentialProviderRenewRequest({ ...renew, requestedAt: "later" })).toBe(false);

		const revoke = {
			schemaVersion: TASK_CREDENTIAL_SCHEMA_VERSION,
			leaseId: "lease_001",
			grantId: "grant_001",
			bindingId: "binding_001",
			reasonCode: "task_completed",
			requestedAt: NOW,
		};
		expect(isTaskCredentialProviderRevokeRequest(revoke)).toBe(true);
		expect(isTaskCredentialProviderRevokeRequest({ ...revoke, token: SENTINEL })).toBe(false);
		expect(isTaskCredentialProviderRevokeRequest({ ...revoke, reasonCode: "a".repeat(65) })).toBe(false);

		const project = {
			schemaVersion: TASK_CREDENTIAL_SCHEMA_VERSION,
			leaseId: "lease_001",
			grantId: "grant_001",
			bindingId: "binding_001",
			targetId: "target_1",
			requestedAt: NOW,
		};
		expect(isTaskCredentialProviderProjectRequest(project)).toBe(true);
		expect(isTaskCredentialProviderProjectRequest({ ...project, material: SENTINEL })).toBe(false);
		expect(isTaskCredentialProviderProjectRequest({ ...project, targetId: "target/path" })).toBe(false);
	});
});

describe("target capabilities contract", () => {
	it("accepts a complete material-free capabilities request and rejects material keys", () => {
		const request = capabilitiesRequest();
		expect(isTaskCredentialTargetCapabilitiesRequest(request)).toBe(true);
		expect(JSON.stringify(request)).not.toContain(SENTINEL);
		for (const key of ["token", "secret", "material", "value", "password"]) {
			expect(isTaskCredentialTargetCapabilitiesRequest({ ...request, [key]: SENTINEL })).toBe(false);
		}
		expect(isTaskCredentialTargetCapabilitiesRequest({ ...request, bindingId: "binding/path" })).toBe(false);
		expect(isTaskCredentialTargetCapabilitiesRequest({ ...request, targetId: "" })).toBe(false);
		expect(isTaskCredentialTargetCapabilitiesRequest({ ...request, targetKind: "" })).toBe(false);
		expect(isTaskCredentialTargetCapabilitiesRequest({ ...request, targetKind: "kind/path" })).toBe(false);
		expect(isTaskCredentialTargetCapabilitiesRequest({ ...request, targetId: undefined })).toBe(false);
		expect(isTaskCredentialTargetCapabilitiesRequest({ ...request, targetKind: undefined })).toBe(false);
		expect(isTaskCredentialTargetCapabilitiesRequest({ ...request, requestedAt: "now" })).toBe(false);
		expect(isTaskCredentialTargetCapabilitiesRequest(null)).toBe(false);
	});

	it("validates the capabilities snapshot shape, booleans, and identity", () => {
		const snapshot = {
			schemaVersion: TASK_CREDENTIAL_SCHEMA_VERSION,
			targetId: "target_1",
			targetKind: "isolated_sandbox",
			bindingId: "binding_001",
			canReceiveShortLivedCredential: true,
			canRenewCredential: false,
			canRevokeCredential: true,
			supportsPerBindingIsolation: true,
			supportsDeliveryReceipt: true,
		};
		expect(isTaskCredentialTargetCapabilities(snapshot)).toBe(true);
		expect(isTaskCredentialTargetCapabilities({ ...snapshot, token: SENTINEL })).toBe(false);
		expect(isTaskCredentialTargetCapabilities({ ...snapshot, material: SENTINEL })).toBe(false);
		expect(isTaskCredentialTargetCapabilities({ ...snapshot, canReceiveShortLivedCredential: "yes" as never })).toBe(false);
		expect(isTaskCredentialTargetCapabilities({ ...snapshot, canRenewCredential: 1 as never })).toBe(false);
		expect(isTaskCredentialTargetCapabilities({ ...snapshot, supportsDeliveryReceipt: "yes" as never })).toBe(false);
		expect(isTaskCredentialTargetCapabilities({ ...snapshot, bindingId: "" })).toBe(false);
		expect(isTaskCredentialTargetCapabilities({ ...snapshot, targetId: "target/path" })).toBe(false);
		expect(isTaskCredentialTargetCapabilities({ ...snapshot, targetKind: "" })).toBe(false);
		expect(isTaskCredentialTargetCapabilities({ ...snapshot, schemaVersion: 2 })).toBe(false);
		expect(JSON.stringify(snapshot)).not.toContain(SENTINEL);
	});

	it("round-trips a capabilities snapshot through parse and serialize", () => {
		const snapshot = serializeTaskCredentialTargetCapabilities({
			schemaVersion: TASK_CREDENTIAL_SCHEMA_VERSION,
			targetId: "target_1",
			targetKind: "isolated_sandbox",
			bindingId: "binding_001",
			canReceiveShortLivedCredential: false,
			canRenewCredential: false,
			canRevokeCredential: false,
			supportsPerBindingIsolation: false,
			supportsDeliveryReceipt: false,
		});
		expect(parseTaskCredentialTargetCapabilities(snapshot)).toEqual(snapshot);
		expect(parseTaskCredentialTargetCapabilities({ ...snapshot, secret: SENTINEL })).toBeUndefined();
		expect(parseTaskCredentialTargetCapabilities("issued")).toBeUndefined();
	});
});

describe("target renew and revoke request contracts", () => {
	it("accepts a complete material-free target renew request and rejects material keys", () => {
		const request = targetRenewRequest();
		expect(isTaskCredentialTargetRenewRequest(request)).toBe(true);
		expect(JSON.stringify(request)).not.toContain(SENTINEL);
		for (const key of ["token", "secret", "material", "value"]) {
			expect(isTaskCredentialTargetRenewRequest({ ...request, [key]: SENTINEL })).toBe(false);
		}
		expect(isTaskCredentialTargetRenewRequest({ ...request, requestedTtlMs: 0 })).toBe(false);
		expect(isTaskCredentialTargetRenewRequest({ ...request, requestedTtlMs: 1.5 })).toBe(false);
		expect(isTaskCredentialTargetRenewRequest({ ...request, leaseId: "lease/path" })).toBe(false);
		expect(isTaskCredentialTargetRenewRequest({ ...request, targetId: "target/path" })).toBe(false);
		expect(isTaskCredentialTargetRenewRequest({ ...request, requestedAt: "later" })).toBe(false);
	});

	it("accepts a complete material-free target revoke request and rejects material keys", () => {
		const request = targetRevokeRequest();
		expect(isTaskCredentialTargetRevokeRequest(request)).toBe(true);
		expect(JSON.stringify(request)).not.toContain(SENTINEL);
		for (const key of ["token", "secret", "material", "value"]) {
			expect(isTaskCredentialTargetRevokeRequest({ ...request, [key]: SENTINEL })).toBe(false);
		}
		expect(isTaskCredentialTargetRevokeRequest({ ...request, reasonCode: "a".repeat(65) })).toBe(false);
		expect(isTaskCredentialTargetRevokeRequest({ ...request, bindingId: "" })).toBe(false);
		expect(isTaskCredentialTargetRevokeRequest({ ...request, requestedAt: "now" })).toBe(false);
		expect(isTaskCredentialTargetRevokeRequest(null)).toBe(false);
	});
});

describe("fail-closed null target", () => {
	it("returns a failed delivery receipt with the target-unavailable reason", () => {
		const target = createTaskCredentialNullTarget({ now: () => NOW });
		const receipt = target.project(projectRequest());
		expect(receipt.status).toBe("failed");
		expect(receipt.reasonCode).toBe("task_credential_target_unavailable");
		expect(receipt.leaseId).toBe("lease_001");
		expect(receipt.grantId).toBe("grant_001");
		expect(receipt.bindingId).toBe("binding_001");
		expect(receipt.targetId).toBe("target_1");
		expect(JSON.stringify(receipt)).not.toContain(SENTINEL);
	});

	it("declares no capabilities for any binding", () => {
		const target = createTaskCredentialNullTarget({ now: () => NOW });
		const capabilities = target.getCapabilities(capabilitiesRequest());
		expect(capabilities).toEqual({
			schemaVersion: TASK_CREDENTIAL_SCHEMA_VERSION,
			targetId: "target_1",
			targetKind: "isolated_sandbox",
			bindingId: "binding_001",
			canReceiveShortLivedCredential: false,
			canRenewCredential: false,
			canRevokeCredential: false,
			supportsPerBindingIsolation: false,
			supportsDeliveryReceipt: false,
		});
		expect(JSON.stringify(capabilities)).not.toContain(SENTINEL);
		// The target identity, kind, and binding are echoed so the caller can
		// match the snapshot to the request.
		const other = target.getCapabilities(
			capabilitiesRequest({ targetId: "target_2", targetKind: "worker", bindingId: "binding_002" }),
		);
		expect(other.targetId).toBe("target_2");
		expect(other.targetKind).toBe("worker");
		expect(other.bindingId).toBe("binding_002");
	});

	it("fails closed for target renew and revoke without reading material", () => {
		const target = createTaskCredentialNullTarget({ now: () => NOW });
		const renewed = target.renew(targetRenewRequest());
		expect(renewed).toMatchObject({
			status: "failed",
			reasonCode: "task_credential_target_unavailable",
			leaseId: "lease_001",
			grantId: "grant_001",
			bindingId: "binding_001",
			recordedAt: NOW,
		});
		expect(JSON.stringify(renewed)).not.toContain(SENTINEL);
		const revoked = target.revoke(targetRevokeRequest());
		expect(revoked).toMatchObject({
			status: "failed",
			reasonCode: "task_credential_target_unavailable",
			leaseId: "lease_001",
			grantId: "grant_001",
			bindingId: "binding_001",
			recordedAt: NOW,
		});
		expect(JSON.stringify(revoked)).not.toContain(SENTINEL);
	});

	it("rejects structurally invalid capabilities, renew, and revoke requests", () => {
		const target = createTaskCredentialNullTarget({ now: () => NOW });
		expectCredentialError(
			() => target.getCapabilities(capabilitiesRequest({ bindingId: "" })),
			"task_credential_invalid",
		);
		expectCredentialError(
			() => target.renew(targetRenewRequest({ leaseId: "lease/path" })),
			"task_credential_invalid",
		);
		expectCredentialError(
			() => target.revoke(targetRevokeRequest({ requestedAt: "later" })),
			"task_credential_invalid",
		);
	});

	it("rejects structurally invalid projection requests", () => {
		const target = createTaskCredentialNullTarget({ now: () => NOW });
		expectCredentialError(
			() => target.project(projectRequest({ leaseId: "" })),
			"task_credential_invalid",
		);
	});
});

class RecordingTarget {
	received: Array<{ leaseId: string; material: Record<string, string> }> = [];
	renewReceived: Array<{ leaseId: string; grantId: string; bindingId: string; requestedTtlMs: number }> = [];
	revokeReceived: Array<{ leaseId: string; grantId: string; bindingId: string; reasonCode?: string }> = [];
	status: TaskCredentialDeliveryStatus = "succeeded";
	renewReceiptStatus: TaskCredentialProviderReceiptStatus = "renewed";
	revokeReceiptStatus: TaskCredentialProviderReceiptStatus = "revoked";
	capabilities: TaskCredentialTargetCapabilities | undefined;

	project(request: {
		readonly leaseId: string;
		readonly grantId: string;
		readonly bindingId: string;
		readonly targetId?: string;
		readonly material: Readonly<Record<string, string>>;
	}): TaskCredentialDeliveryReceipt {
		this.received.push({ leaseId: request.leaseId, material: { ...request.material } });
		const receipt: TaskCredentialDeliveryReceipt = {
			schemaVersion: TASK_CREDENTIAL_SCHEMA_VERSION,
			leaseId: request.leaseId,
			grantId: request.grantId,
			bindingId: request.bindingId,
			status: this.status,
			recordedAt: NOW,
		};
		if (request.targetId !== undefined) (receipt as { targetId?: string }).targetId = request.targetId;
		return serializeTaskCredentialDeliveryReceipt(receipt);
	}

	getCapabilities(request: TaskCredentialTargetCapabilitiesRequest): TaskCredentialTargetCapabilities {
		if (this.capabilities !== undefined) return serializeTaskCredentialTargetCapabilities(this.capabilities);
		return serializeTaskCredentialTargetCapabilities({
			schemaVersion: TASK_CREDENTIAL_SCHEMA_VERSION,
			targetId: request.targetId,
			targetKind: request.targetKind,
			bindingId: request.bindingId,
			canReceiveShortLivedCredential: true,
			canRenewCredential: true,
			canRevokeCredential: true,
			supportsPerBindingIsolation: true,
			supportsDeliveryReceipt: true,
		});
	}

	renew(request: TaskCredentialTargetRenewRequest): TaskCredentialProviderReceipt {
		this.renewReceived.push({
			leaseId: request.leaseId,
			grantId: request.grantId,
			bindingId: request.bindingId,
			requestedTtlMs: request.requestedTtlMs,
		});
		const receipt: TaskCredentialProviderReceipt = {
			schemaVersion: TASK_CREDENTIAL_SCHEMA_VERSION,
			leaseId: request.leaseId,
			grantId: request.grantId,
			bindingId: request.bindingId,
			status: this.renewReceiptStatus,
			recordedAt: NOW,
		};
		return serializeTaskCredentialProviderReceipt(receipt);
	}

	revoke(request: TaskCredentialTargetRevokeRequest): TaskCredentialProviderReceipt {
		this.revokeReceived.push({
			leaseId: request.leaseId,
			grantId: request.grantId,
			bindingId: request.bindingId,
			...(request.reasonCode === undefined ? {} : { reasonCode: request.reasonCode }),
		});
		const receipt: TaskCredentialProviderReceipt = {
			schemaVersion: TASK_CREDENTIAL_SCHEMA_VERSION,
			leaseId: request.leaseId,
			grantId: request.grantId,
			bindingId: request.bindingId,
			status: this.revokeReceiptStatus,
			recordedAt: NOW,
		};
		if (request.reasonCode !== undefined) (receipt as { reasonCode?: string }).reasonCode = request.reasonCode;
		return serializeTaskCredentialProviderReceipt(receipt);
	}
}

describe("in-memory test provider", () => {
	type TargetStub = Pick<RecordingTarget, "project" | "renew" | "revoke" | "getCapabilities">;
	function makeProvider(overrides: {
		target?: TargetStub;
		revokeOutcome?: "revoked" | "revocation_unknown";
	} = {}) {
		return createTaskCredentialTestProvider({
			materials: { package_registry: SENTINEL, npm_registry: "sentinel-secret-99" },
			now: () => NOW,
			...(overrides.target === undefined ? {} : { target: overrides.target }),
			...(overrides.revokeOutcome === undefined ? {} : { revokeOutcome: overrides.revokeOutcome }),
		});
	}

	it("issues and holds sentinel material strictly inside the provider", () => {
		const provider = makeProvider();
		const receipt = provider.issuer.issue(issueRequest());
		expect(receipt.status).toBe("issued");
		expect(receipt.recordedAt).toBe(NOW);
		expect(JSON.stringify(receipt)).not.toContain(SENTINEL);
		expect(JSON.stringify(provider.records.get("lease_001"))).not.toContain(SENTINEL);
		expect(provider.records.get("lease_001")).toMatchObject({
			leaseId: "lease_001",
			grantId: "grant_001",
			bindingId: "binding_001",
			credentialNames: ["package_registry"],
			revoked: false,
		});
	});

	it("rejects scopes whose credential is not in its material allowlist", () => {
		const provider = makeProvider();
		expectCredentialError(
			() => provider.issuer.issue(issueRequest({ scopes: [makeScope({ credentialName: "unknown_cred" })] })),
			"task_credential_scope_denied",
		);
		expect(provider.records.size).toBe(0);
	});

	it("is idempotent for the same grant and conflicts on a different grant id", () => {
		const provider = makeProvider();
		provider.issuer.issue(issueRequest());
		expect(provider.issuer.issue(issueRequest()).status).toBe("issued");
		expect(provider.records.size).toBe(1);
		expectCredentialError(
			() => provider.issuer.issue(issueRequest({ grantId: "grant_other" })),
			"task_credential_conflict",
		);
	});

	it("rejects material-smuggling issue requests before touching state", () => {
		const provider = makeProvider();
		expectCredentialError(
			() => provider.issuer.issue({ ...issueRequest(), token: SENTINEL } as never),
			"task_credential_invalid",
		);
		expect(provider.records.size).toBe(0);
	});

	it("renews only known, live, unrevoked grants and extends the internal expiry", () => {
		const provider = makeProvider();
		provider.issuer.issue(issueRequest());
		const receipt = provider.issuer.renew({
			schemaVersion: TASK_CREDENTIAL_SCHEMA_VERSION,
			leaseId: "lease_001",
			grantId: "grant_001",
			bindingId: "binding_001",
			requestedTtlMs: 120_000,
			requestedAt: NOW,
		});
		expect(receipt.status).toBe("renewed");
		expect(provider.records.get("lease_001")?.expiresAt).toBe("2026-08-16T12:02:00.000Z");
		expectCredentialError(
			() =>
				provider.issuer.renew({
					schemaVersion: TASK_CREDENTIAL_SCHEMA_VERSION,
					leaseId: "lease_unknown",
					grantId: "grant_001",
					bindingId: "binding_001",
					requestedTtlMs: 60_000,
					requestedAt: NOW,
				}),
			"task_credential_not_found",
		);
		expectCredentialError(
			() =>
				provider.issuer.renew({
					schemaVersion: TASK_CREDENTIAL_SCHEMA_VERSION,
					leaseId: "lease_001",
					grantId: "grant_001",
					bindingId: "binding_001",
					requestedTtlMs: 60_000,
					requestedAt: "2026-08-16T12:02:00.001Z",
				}),
			"task_lease_expired",
		);
	});

	it("revokes known grants and reports the configured outcome", () => {
		const revoked = makeProvider();
		revoked.issuer.issue(issueRequest());
		const receipt = revoked.issuer.revoke({
			schemaVersion: TASK_CREDENTIAL_SCHEMA_VERSION,
			leaseId: "lease_001",
			grantId: "grant_001",
			bindingId: "binding_001",
			requestedAt: NOW,
		});
		expect(receipt.status).toBe("revoked");
		expect(revoked.records.get("lease_001")?.revoked).toBe(true);

		const unknown = makeProvider({ revokeOutcome: "revocation_unknown" });
		unknown.issuer.issue(issueRequest());
		const unknownReceipt = unknown.issuer.revoke({
			schemaVersion: TASK_CREDENTIAL_SCHEMA_VERSION,
			leaseId: "lease_001",
			grantId: "grant_001",
			bindingId: "binding_001",
			requestedAt: NOW,
		});
		expect(unknownReceipt.status).toBe("revocation_unknown");
		expectCredentialError(
			() =>
				unknown.issuer.revoke({
					schemaVersion: TASK_CREDENTIAL_SCHEMA_VERSION,
					leaseId: "lease_missing",
					grantId: "grant_001",
					bindingId: "binding_001",
					requestedAt: NOW,
				}),
			"task_credential_not_found",
		);
	});

	it("projects material to the target and returns the material-free delivery receipt", () => {
		const target = new RecordingTarget();
		const provider = makeProvider({ target });
		provider.issuer.issue(issueRequest());
		const receipt = provider.target.project({
			schemaVersion: TASK_CREDENTIAL_SCHEMA_VERSION,
			leaseId: "lease_001",
			grantId: "grant_001",
			bindingId: "binding_001",
			targetId: "target_1",
			requestedAt: NOW,
		});
		expect(receipt.status).toBe("succeeded");
		expect(receipt.recordedAt).toBe(NOW);
		// The sentinel reaches the target, the only channel where material flows.
		expect(target.received).toHaveLength(1);
		expect(target.received[0]!.material).toEqual({ package_registry: SENTINEL });
		// ... but it never appears in the provider's receipt or records.
		expect(JSON.stringify(receipt)).not.toContain(SENTINEL);
		expect(JSON.stringify(provider.records.get("lease_001"))).not.toContain(SENTINEL);
	});

	it("fails closed through the default target when no target is configured", () => {
		const provider = makeProvider();
		provider.issuer.issue(issueRequest());
		const receipt = provider.target.project({
			schemaVersion: TASK_CREDENTIAL_SCHEMA_VERSION,
			leaseId: "lease_001",
			grantId: "grant_001",
			bindingId: "binding_001",
			targetId: "target_1",
			requestedAt: NOW,
		});
		expect(receipt.status).toBe("failed");
		expect(receipt.reasonCode).toBe("task_credential_target_unavailable");
		expect(JSON.stringify(receipt)).not.toContain(SENTINEL);
	});

	it("fails closed when the target responds with an unsafe receipt", () => {
		const provider = makeProvider({
			target: {
				project: () => ({ token: SENTINEL }) as never,
				renew: () => ({ token: SENTINEL }) as never,
				revoke: () => ({ token: SENTINEL }) as never,
				getCapabilities: () => ({ token: SENTINEL }) as never,
			},
		});
		provider.issuer.issue(issueRequest());
		expectCredentialError(
			() =>
				provider.target.project({
					schemaVersion: TASK_CREDENTIAL_SCHEMA_VERSION,
					leaseId: "lease_001",
					grantId: "grant_001",
					bindingId: "binding_001",
					requestedAt: NOW,
				}),
			"task_credential_delivery_failed",
		);
	});

	it("declares target capabilities from the configured target and fails closed by default", () => {
		const target = new RecordingTarget();
		const provider = makeProvider({ target });
		const capabilities = provider.target.getCapabilities(capabilitiesRequest());
		expect(capabilities).toEqual({
			schemaVersion: TASK_CREDENTIAL_SCHEMA_VERSION,
			targetId: "target_1",
			targetKind: "isolated_sandbox",
			bindingId: "binding_001",
			canReceiveShortLivedCredential: true,
			canRenewCredential: true,
			canRevokeCredential: true,
			supportsPerBindingIsolation: true,
			supportsDeliveryReceipt: true,
		});
		expect(JSON.stringify(capabilities)).not.toContain(SENTINEL);
		// Capabilities are per-target and per-binding: the request identity is echoed.
		const other = provider.target.getCapabilities(
			capabilitiesRequest({ targetId: "target_2", targetKind: "worker", bindingId: "binding_002" }),
		);
		expect(other.targetId).toBe("target_2");
		expect(other.targetKind).toBe("worker");
		expect(other.bindingId).toBe("binding_002");

		const defaulted = makeProvider();
		const closed = defaulted.target.getCapabilities(capabilitiesRequest());
		expect(closed).toEqual({
			schemaVersion: TASK_CREDENTIAL_SCHEMA_VERSION,
			targetId: "target_1",
			targetKind: "isolated_sandbox",
			bindingId: "binding_001",
			canReceiveShortLivedCredential: false,
			canRenewCredential: false,
			canRevokeCredential: false,
			supportsPerBindingIsolation: false,
			supportsDeliveryReceipt: false,
		});
	});

	it("fails closed when the target capability identity does not match the request", () => {
		const target = new RecordingTarget();
		target.capabilities = serializeTaskCredentialTargetCapabilities({
			schemaVersion: TASK_CREDENTIAL_SCHEMA_VERSION,
			targetId: "target_9",
			targetKind: "isolated_sandbox",
			bindingId: "binding_001",
			canReceiveShortLivedCredential: true,
			canRenewCredential: true,
			canRevokeCredential: true,
			supportsPerBindingIsolation: true,
			supportsDeliveryReceipt: true,
		});
		const provider = makeProvider({ target });
		expectCredentialError(
			() => provider.target.getCapabilities(capabilitiesRequest()),
			"task_credential_delivery_failed",
		);
	});

	it("fails closed when the target capability kind or binding does not match the request", () => {
		const kindMismatch = new RecordingTarget();
		kindMismatch.capabilities = serializeTaskCredentialTargetCapabilities({
			schemaVersion: TASK_CREDENTIAL_SCHEMA_VERSION,
			targetId: "target_1",
			targetKind: "worker",
			bindingId: "binding_001",
			canReceiveShortLivedCredential: true,
			canRenewCredential: true,
			canRevokeCredential: true,
			supportsPerBindingIsolation: true,
			supportsDeliveryReceipt: true,
		});
		expectCredentialError(
			() => makeProvider({ target: kindMismatch }).target.getCapabilities(capabilitiesRequest()),
			"task_credential_delivery_failed",
		);

		const bindingMismatch = new RecordingTarget();
		bindingMismatch.capabilities = serializeTaskCredentialTargetCapabilities({
			schemaVersion: TASK_CREDENTIAL_SCHEMA_VERSION,
			targetId: "target_1",
			targetKind: "isolated_sandbox",
			bindingId: "binding_009",
			canReceiveShortLivedCredential: true,
			canRenewCredential: true,
			canRevokeCredential: true,
			supportsPerBindingIsolation: true,
			supportsDeliveryReceipt: true,
		});
		expectCredentialError(
			() => makeProvider({ target: bindingMismatch }).target.getCapabilities(capabilitiesRequest()),
			"task_credential_delivery_failed",
		);
	});

	it("renews the target-side lease through the configured target", () => {
		const target = new RecordingTarget();
		const provider = makeProvider({ target });
		provider.issuer.issue(issueRequest());
		const receipt = provider.target.renew(targetRenewRequest({ requestedTtlMs: 120_000 }));
		expect(receipt.status).toBe("renewed");
		expect(receipt.recordedAt).toBe(NOW);
		expect(target.renewReceived).toHaveLength(1);
		expect(target.renewReceived[0]).toEqual({
			leaseId: "lease_001",
			grantId: "grant_001",
			bindingId: "binding_001",
			requestedTtlMs: 120_000,
		});
		// The sentinel never reaches the target on renew, the receipt, or the records.
		expect(target.received).toHaveLength(0);
		expect(JSON.stringify(receipt)).not.toContain(SENTINEL);
		expect(JSON.stringify(provider.records.get("lease_001"))).not.toContain(SENTINEL);
	});

	it("revokes the target-side material through the configured target", () => {
		const target = new RecordingTarget();
		const provider = makeProvider({ target });
		provider.issuer.issue(issueRequest());
		const receipt = provider.target.revoke(targetRevokeRequest());
		expect(receipt.status).toBe("revoked");
		expect(receipt.reasonCode).toBe("task_completed");
		expect(target.revokeReceived).toHaveLength(1);
		expect(target.revokeReceived[0]).toEqual({
			leaseId: "lease_001",
			grantId: "grant_001",
			bindingId: "binding_001",
			reasonCode: "task_completed",
		});
		expect(JSON.stringify(receipt)).not.toContain(SENTINEL);
	});

	it("forwards a revocation_unknown target outcome unchanged", () => {
		const target = new RecordingTarget();
		target.revokeReceiptStatus = "revocation_unknown";
		const provider = makeProvider({ target });
		provider.issuer.issue(issueRequest());
		const receipt = provider.target.revoke(targetRevokeRequest());
		expect(receipt.status).toBe("revocation_unknown");
	});

	it("rejects target renew of unknown, expired, or revoked grants", () => {
		const provider = makeProvider();
		expectCredentialError(
			() => provider.target.renew(targetRenewRequest({ leaseId: "lease_missing" })),
			"task_credential_not_found",
		);
		provider.issuer.issue(issueRequest());
		expectCredentialError(
			() => provider.target.renew(targetRenewRequest({ grantId: "grant_other" })),
			"task_credential_conflict",
		);
		expectCredentialError(
			() => provider.target.renew(targetRenewRequest({ requestedAt: "2026-08-16T12:02:00.001Z" })),
			"task_lease_expired",
		);
		provider.issuer.revoke({
			schemaVersion: TASK_CREDENTIAL_SCHEMA_VERSION,
			leaseId: "lease_001",
			grantId: "grant_001",
			bindingId: "binding_001",
			requestedAt: NOW,
		});
		expectCredentialError(
			() => provider.target.renew(targetRenewRequest()),
			"task_credential_conflict",
		);
	});

	it("rejects target revoke of unknown grants and keeps the request material-free", () => {
		const provider = makeProvider();
		expectCredentialError(
			() => provider.target.revoke(targetRevokeRequest({ leaseId: "lease_missing" })),
			"task_credential_not_found",
		);
		provider.issuer.issue(issueRequest());
		expectCredentialError(
			() => provider.target.revoke(targetRevokeRequest({ grantId: "grant_other" })),
			"task_credential_conflict",
		);
		expect(JSON.stringify(targetRevokeRequest())).not.toContain(SENTINEL);
	});

	it("fails closed when the target responds with unsafe capabilities, renew, or revoke receipts", () => {
		const provider = makeProvider({
			target: {
				project: () => ({ status: "succeeded" }) as never,
				renew: () => ({ token: SENTINEL }) as never,
				revoke: () => ({ token: SENTINEL }) as never,
				getCapabilities: () => ({ token: SENTINEL }) as never,
			},
		});
		provider.issuer.issue(issueRequest());
		expectCredentialError(
			() => provider.target.getCapabilities(capabilitiesRequest()),
			"task_credential_delivery_failed",
		);
		expectCredentialError(
			() => provider.target.renew(targetRenewRequest()),
			"task_credential_delivery_failed",
		);
		expectCredentialError(
			() => provider.target.revoke(targetRevokeRequest()),
			"task_credential_delivery_failed",
		);
	});

	it("rejects projection of unknown or revoked grants", () => {
		const provider = makeProvider();
		expectCredentialError(
			() =>
				provider.target.project({
					schemaVersion: TASK_CREDENTIAL_SCHEMA_VERSION,
					leaseId: "lease_missing",
					grantId: "grant_001",
					bindingId: "binding_001",
					requestedAt: NOW,
				}),
			"task_credential_not_found",
		);
		provider.issuer.issue(issueRequest());
		provider.issuer.revoke({
			schemaVersion: TASK_CREDENTIAL_SCHEMA_VERSION,
			leaseId: "lease_001",
			grantId: "grant_001",
			bindingId: "binding_001",
			requestedAt: NOW,
		});
		expectCredentialError(
			() =>
				provider.target.project({
					schemaVersion: TASK_CREDENTIAL_SCHEMA_VERSION,
					leaseId: "lease_001",
					grantId: "grant_001",
					bindingId: "binding_001",
					requestedAt: NOW,
				}),
			"task_credential_conflict",
		);
	});

	it("keeps sentinel material out of every error it raises", () => {
		const provider = makeProvider();
		expectCredentialError(
			() => provider.issuer.issue(issueRequest({ scopes: [makeScope({ credentialName: "ghost_cred" })] })),
			"task_credential_scope_denied",
		);
		expectCredentialError(
			() => provider.issuer.renew({} as never),
			"task_credential_invalid",
		);
	});
});

describe("scope and binding guards used by provider contracts", () => {
	it("keeps validating scope and binding shapes", () => {
		expect(isTaskCredentialScope(makeScope())).toBe(true);
		expect(isTaskCredentialScope({ ...makeScope(), operations: ["read", "read"] })).toBe(true);
		expect(isTaskCredentialScope({ ...makeScope(), purpose: "" })).toBe(false);
		expect(isTaskExecutionBinding(makeBinding())).toBe(true);
		expect(isTaskExecutionBinding(makeBinding({ workerId: undefined, sandboxBindingId: undefined }))).toBe(true);
	});
});
