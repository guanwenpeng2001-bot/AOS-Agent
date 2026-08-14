import { describe, expect, it } from "vitest";
import {
	createSessionRemoteOperationLedger,
	executeRemoteOperation,
	REMOTE_ARTIFACT_KINDS,
	REMOTE_OPERATION_CUSTOM_TYPE,
	REMOTE_OPERATION_ERROR_CATEGORIES,
	REMOTE_OPERATION_LEDGER_SCHEMA_VERSION,
	REMOTE_OPERATION_SCHEMA_VERSION,
	REMOTE_OPERATION_SIDE_EFFECT_STATES,
	REMOTE_OPERATION_STATUSES,
	startRemoteOperation,
	type RemoteOperationInvoker,
	type RemoteOperationProvider,
	type RemoteOperationRequest,
} from "../src/core/remote-operation.ts";
import {
	createBindingHandle,
	createRunBindingAssociation,
	type RunBindingAssociation,
} from "../src/core/binding-handles.ts";
import { ExecutionAuditQuery } from "../src/core/execution-audit-query.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import {
	createLocalRemoteProvider,
	FakeRemoteProvider,
	type FakeRemoteProviderOptions,
} from "./fixtures/fake-remote-provider.ts";

const NOW = "2026-08-14T00:00:00.000Z";
const FUTURE = "2026-08-14T00:01:00.000Z";
const LEASE_EXPIRY = "2026-08-14T00:02:00.000Z";

function request(operationId: string, bindingAssociation?: RunBindingAssociation): RemoteOperationRequest {
	return {
		operationId,
		runId: "run-1",
		sessionId: "session-1",
		capabilityBindingId: "capability-binding-1",
		modelBindingId: "model-binding-1",
		policyBindingId: "policy-binding-1",
		...(bindingAssociation === undefined ? {} : { bindingAssociation }),
		deadlineAt: FUTURE,
		lease: { leaseId: "lease-1", expiresAt: LEASE_EXPIRY },
		artifactRefs: [{ id: "input-1", kind: "input", digest: "sha256:input-1", sizeBytes: 2 }],
	};
}

function providerPair(options: FakeRemoteProviderOptions = {}): {
	readonly fake: FakeRemoteProvider;
	readonly local: RemoteOperationProvider;
} {
	const fake = new FakeRemoteProvider({ now: () => NOW, ...options });
	return { fake, local: createLocalRemoteProvider(fake) };
}

function eachProvider(
	options: FakeRemoteProviderOptions = {},
): Array<readonly [string, FakeRemoteProvider, RemoteOperationInvoker]> {
	const localPair = providerPair(options);
	const fake = new FakeRemoteProvider({ now: () => NOW, ...options });
	return [
		["local", localPair.fake, localPair.local],
		["fake transport", fake, fake],
	];
}

describe("remote-neutral operation contract", () => {
	it("freezes the minimal versioned state, error, side-effect, and artifact domains", () => {
		expect(REMOTE_OPERATION_SCHEMA_VERSION).toBe(1);
		expect(REMOTE_OPERATION_STATUSES).toEqual(["accepted", "running", "completed", "failed", "cancelled"]);
		expect(REMOTE_OPERATION_ERROR_CATEGORIES).toEqual([
			"transient",
			"rejected",
			"invalid",
			"side-effect-unknown",
			"cancelled",
			"deadline",
		]);
		expect(REMOTE_OPERATION_SIDE_EFFECT_STATES).toEqual(["none", "associated", "unknown"]);
		expect(REMOTE_ARTIFACT_KINDS).toEqual(["input", "output", "log", "checkpoint"]);
	});

	it.each(eachProvider())("returns the same terminal receipt for the %s path", async (_name, _state, provider) => {
		const receipt = await executeRemoteOperation(provider, request("operation-success"), { now: () => NOW });

		expect(receipt).toMatchObject({
			schemaVersion: 1,
			operationId: "operation-success",
			runId: "run-1",
			sessionId: "session-1",
			capabilityBindingId: "capability-binding-1",
			modelBindingId: "model-binding-1",
			policyBindingId: "policy-binding-1",
			status: "completed",
			sideEffects: "associated",
			endedAt: NOW,
		});
		expect(receipt.error).toBeUndefined();
		expect(receipt.artifactRefs).toEqual([
			{ id: "input-1", kind: "input", digest: "sha256:input-1", sizeBytes: 2 },
			{
				id: "fake-output-1",
				kind: "output",
				digest: "sha256:fake-output-1",
				sizeBytes: 1,
				mediaType: "application/octet-stream",
			},
		]);
	});

	it("rejects malformed requests before invoking a provider", async () => {
		const pair = providerPair();
		const malformed = { ...request("invalid operation"), operationId: "invalid operation" } as RemoteOperationRequest;

		const receipt = await executeRemoteOperation(pair.fake, malformed, { now: () => NOW });

		expect(receipt.status).toBe("failed");
		expect(receipt.error).toEqual({ category: "invalid", code: "invalid", retryable: false, sideEffects: "none" });
		expect(pair.fake.state.invocations).toHaveLength(0);
		expect(pair.fake.state.sideEffects).toHaveLength(0);
	});

	it.each(eachProvider())(
		"records the same safe terminal fact through the Session ledger on the %s path",
		async (_name, _state, provider) => {
			const session = SessionManager.inMemory("/workspace/remote-operation");
			const bindingAssociation = createRunBindingAssociation("run-1", [
				createBindingHandle({
					domain: "model",
					bindingId: "model-binding-1",
					revision: "rev-1",
					relation: "run.model",
				}),
			]);
			const receipt = await executeRemoteOperation(
				provider,
				{ ...request("operation-ledger", bindingAssociation), sessionId: session.getSessionId() },
				{
					now: () => NOW,
					ledger: createSessionRemoteOperationLedger(session),
				},
			);

			expect(receipt.bindingAssociation).toEqual(bindingAssociation);
			expect(session.getEntries()).toHaveLength(1);
			expect(session.getEntries()[0]).toMatchObject({
				type: "custom",
				customType: REMOTE_OPERATION_CUSTOM_TYPE,
				data: {
					schemaVersion: REMOTE_OPERATION_LEDGER_SCHEMA_VERSION,
					receipt: {
						operationId: "operation-ledger",
						bindingAssociation,
						sessionId: session.getSessionId(),
					},
				},
			});
			const audit = new ExecutionAuditQuery(session).query({
				scope: "current-session",
				runId: "run-1",
				types: ["remote.operation"],
			});
			expect(audit.events).toHaveLength(1);
			expect(audit.events[0]).toMatchObject({
				type: "remote.operation",
				runId: "run-1",
				summary: { operationId: "operation-ledger", bindingAssociation },
			});
			expect(JSON.stringify(session.getEntries())).not.toContain("fake-provider");
		},
	);

	it("does not echo unsafe binding or artifact data from malformed requests", async () => {
		const pair = providerPair();
		const malformed = {
			operationId: "operation-invalid-fields",
			runId: "../../secret-run",
			artifactRefs: [{ id: "C:/secret.txt", kind: "output", path: "C:/secret.txt" }],
		} as unknown as RemoteOperationRequest;

		const receipt = await executeRemoteOperation(pair.fake, malformed, { now: () => NOW });

		expect(receipt.status).toBe("failed");
		expect(receipt.error?.category).toBe("invalid");
		expect(receipt).not.toHaveProperty("runId");
		expect(receipt.artifactRefs).toEqual([]);
		expect(JSON.stringify(receipt)).not.toContain("secret");
		expect(pair.fake.state.invocations).toHaveLength(0);
	});

	it.each(eachProvider({ hold: true }))(
		"uses the same cancellation receipt and leaves no unassociated side effect after cancel on the %s path",
		async (_name, state, provider) => {
			const handle = startRemoteOperation(provider, request("operation-cancel"), { now: () => NOW });
			await Promise.resolve();
			await handle.cancel();
			state.release("operation-cancel");
			const receipt = await handle.receipt;

			expect(receipt.status).toBe("cancelled");
			expect(receipt.error).toEqual({
				category: "cancelled",
				code: "cancelled",
				retryable: false,
				sideEffects: "none",
			});
			expect(receipt.sideEffects).toBe("none");
			expect(state.state.sideEffects).toHaveLength(0);
			expect(state.state.cancellations).toEqual(["operation-cancel"]);
		},
	);

	it.each(eachProvider())(
		"uses the same deadline receipt and prevents provider execution on the %s path",
		async (_name, state, provider) => {
			const expired = { ...request("operation-deadline"), deadlineAt: "2020-01-01T00:00:00.000Z" };
			const receipt = await executeRemoteOperation(provider, expired, { now: () => NOW });

			expect(receipt.status).toBe("cancelled");
			expect(receipt.error).toEqual({
				category: "deadline",
				code: "deadline",
				retryable: false,
				sideEffects: "none",
			});
			expect(state.state.invocations).toHaveLength(0);
			expect(state.state.sideEffects).toHaveLength(0);
		},
	);

	it("renews a lease through the provider-neutral heartbeat contract on both paths", async () => {
		for (const [name, state, provider] of eachProvider({ hold: true })) {
			const operationId = `operation-heartbeat-${name === "local" ? "local" : "fake"}`;
			const handle = startRemoteOperation(provider, request(operationId), { now: () => NOW });
			await Promise.resolve();

			const lease = await handle.heartbeat();
			state.release(operationId);
			const receipt = await handle.receipt;

			expect(lease).toEqual({ leaseId: "lease-1", expiresAt: FUTURE });
			expect(state.state.heartbeats).toEqual([{ operationId, leaseId: "lease-1", sequence: 1, sentAt: NOW }]);
			expect(receipt.status).toBe("completed");
			expect(receipt.heartbeatSequence).toBe(1);
		}
	});

	it.each([
		["transient", true],
		["rejected", false],
		["invalid", false],
		["side-effect-unknown", false],
	] as const)("preserves the stable %s error category on both paths", async (category, retryable) => {
		for (const [_name, _state, provider] of eachProvider({ failureCategory: category })) {
			const receipt = await executeRemoteOperation(provider, request(`operation-${category}`), { now: () => NOW });

			expect(receipt.status).toBe("failed");
			expect(receipt.error).toEqual({
				category,
				code: category,
				retryable,
				sideEffects: category === "side-effect-unknown" ? "unknown" : "none",
			});
		}
	});

	it("never marks a transient failure retryable after an associated side effect on either path", async () => {
		for (const [_name, _state, provider] of eachProvider({
			failureCategory: "transient",
			failureSideEffects: "associated",
		})) {
			const receipt = await executeRemoteOperation(provider, request("operation-transient-associated"), {
				now: () => NOW,
			});

			expect(receipt.status).toBe("failed");
			expect(receipt.error).toEqual({
				category: "transient",
				code: "transient",
				retryable: false,
				sideEffects: "associated",
			});
		}
	});

	it.each(eachProvider({ hold: true, sideEffectBeforeHold: true }))(
		"fails closed as side-effect-unknown when cancellation follows an associated effect on the %s path",
		async (_name, state, provider) => {
			const handle = startRemoteOperation(provider, request("operation-unknown"), { now: () => NOW });
			await Promise.resolve();
			await handle.cancel();
			state.release("operation-unknown");
			const receipt = await handle.receipt;

			expect(receipt.status).toBe("failed");
			expect(receipt.error).toEqual({
				category: "side-effect-unknown",
				code: "side-effect-unknown",
				retryable: false,
				sideEffects: "unknown",
			});
			expect(receipt.sideEffects).toBe("unknown");
			expect(state.state.sideEffects).toHaveLength(1);
		},
	);
});
