import { describe, expect, it } from "vitest";
import {
	createSessionRemoteOperationLedger,
	executeRemoteOperation,
	isRemoteOperationReceipt,
	isRemoteOperationRequest,
	REMOTE_ARTIFACT_KINDS,
	REMOTE_OPERATION_CUSTOM_TYPE,
	REMOTE_OPERATION_ERROR_CATEGORIES,
	REMOTE_OPERATION_LEDGER_SCHEMA_VERSION,
	REMOTE_OPERATION_SCHEMA_VERSION,
	REMOTE_OPERATION_SIDE_EFFECT_STATES,
	REMOTE_OPERATION_STATUSES,
	startRemoteOperation,
	isTaskLeaseReference,
	type RemoteOperationInvoker,
	type RemoteOperationProvider,
	type RemoteOperationRequest,
	type RemoteOperationTaskLeaseVerifier,
	type TaskLeaseReference,
} from "../src/core/remote-operation.ts";
import { ExecutionAuditQuery } from "../src/core/session/execution-audit-query.ts";
import { SessionManager, type SessionEntry } from "../src/core/session/manager.ts";
import {
	TASK_CREDENTIAL_CUSTOM_TYPE,
	TaskCredentialStore,
	parseTaskCredentialTransition,
} from "../src/core/task-credential-store.ts";
import {
	createTaskCredentialTestProvider,
	type TaskCredentialProvider,
} from "../src/core/task-credential-provider.ts";
import {
	TASK_CREDENTIAL_MIN_TTL_MS,
	type TaskCredentialGrant,
	type TaskCredentialScope,
	type TaskExecutionBinding,
} from "../src/core/task-credential-lease.ts";
import {
	createLocalRemoteProvider,
	FakeRemoteProvider,
	type FakeRemoteProviderOptions,
} from "./fixtures/fake-remote-provider.ts";

const NOW = "2026-08-14T00:00:00.000Z";
const FUTURE = "2026-08-14T00:01:00.000Z";
const LEASE_EXPIRY = "2026-08-14T00:02:00.000Z";

function request(operationId: string): RemoteOperationRequest {
	return {
		operationId,
		runId: "run-1",
		sessionId: "session-1",
		capabilityBindingId: "capability-binding-1",
		modelBindingId: "model-binding-1",
		policyBindingId: "policy-binding-1",
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

// ---- Task Lease correlation fixtures ---------------------------------------

const TASK_LEASE_NOW = "2026-08-16T12:00:00.000Z";
const TASK_LEASE_EXPIRED = "2026-08-16T12:01:01.000Z";
const LEASE_TARGET = "target_sandbox";

const LEASE_SCOPES: ReadonlyArray<TaskCredentialScope> = [
	{
		credentialName: "package_registry",
		purpose: "artifact.push",
		operations: ["push"],
		targetKinds: ["isolated_sandbox"],
	},
];

interface TaskLeaseCredentialCalls {
	readonly issue: number;
	readonly renew: number;
	readonly project: number;
	readonly revoke: number;
}

/** A Session store + scripted credential provider with call counters and a mutable clock. */
function makeCredentialFixture(options: { revokeOutcome?: "revoked" | "revocation_unknown" } = {}): {
	readonly session: SessionManager;
	readonly store: TaskCredentialStore;
	readonly calls: TaskLeaseCredentialCalls;
	readonly now: () => string;
	readonly setClock: (now: string) => void;
} {
	let now = TASK_LEASE_NOW;
	const calls = { issue: 0, renew: 0, project: 0, revoke: 0 };
	const inner = createTaskCredentialTestProvider({
		materials: { package_registry: "sentinel-secret-42" },
		now: () => now,
		...(options.revokeOutcome === undefined ? {} : { revokeOutcome: options.revokeOutcome }),
	});
	const provider: TaskCredentialProvider = {
		issuer: {
			issue: (request) => {
				calls.issue += 1;
				return inner.issuer.issue(request);
			},
			renew: (request) => {
				calls.renew += 1;
				return inner.issuer.renew(request);
			},
			revoke: (request) => {
				calls.revoke += 1;
				return inner.issuer.revoke(request);
			},
		},
		target: inner.target,
	};
	const session = SessionManager.inMemory("/workspace/remote-operation-lease", { id: "session-1" });
	const store = new TaskCredentialStore(session, provider, { now: () => now });
	return {
		session,
		store,
		calls,
		now: () => now,
		setClock: (value) => {
			now = value;
		},
	};
}

function makeLeaseBinding(overrides: Partial<TaskExecutionBinding> = {}): TaskExecutionBinding {
	return {
		schemaVersion: 1,
		bindingId: "binding-1",
		sessionId: "session-1",
		taskId: "task-lease-1",
		graphRevision: 1,
		nodeId: "node-1",
		runId: "run-1",
		capabilityBindingId: "capability-binding-1",
		policyBindingId: "policy-binding-1",
		targetId: LEASE_TARGET,
		createdAt: TASK_LEASE_NOW,
		bindingRevision: 1,
		...overrides,
	};
}

/** Issue one lease whose binding correlates with the shared `request()` binding refs. */
function issueTaskLease(store: TaskCredentialStore, overrides: Partial<TaskExecutionBinding> = {}): TaskCredentialGrant {
	return store.issue({
		leaseId: "lease-001",
		grantId: "grant-001",
		binding: makeLeaseBinding(overrides),
		scopes: LEASE_SCOPES,
		requestedTtlMs: 60_000,
		ttlBounds: { minTtlMs: TASK_CREDENTIAL_MIN_TTL_MS, maxTtlMs: 300_000 },
		clientRequestId: "issue-op-1",
	}).grant;
}

/** The persisted binding of the lease's `issued` transition; read-only store fold. */
function issuedBindingFor(entries: ReadonlyArray<SessionEntry>, bindingId: string): TaskExecutionBinding | undefined {
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== TASK_CREDENTIAL_CUSTOM_TYPE) continue;
		const transition = parseTaskCredentialTransition(entry.data);
		if (transition === undefined || transition.action !== "issued" || transition.binding === undefined) continue;
		if (transition.bindingId === bindingId) return transition.binding;
	}
	return undefined;
}

/**
 * The injected read-only verifier contract used by these tests: store lookups
 * only (`get` plus the persisted binding fold), no provider calls, plus
 * live-status, expiry, identity, and binding/scope/target correlation checks.
 * The grant carries session/run/scope/target facts; the full capability and
 * policy binding correlation lives on the issuance binding.
 */
function makeTaskLeaseVerifier(
	store: TaskCredentialStore,
	session: SessionManager,
	now: () => string,
): {
	readonly verifier: RemoteOperationTaskLeaseVerifier;
	readonly verifications: string[];
} {
	const verifications: string[] = [];
	return {
		verifications,
		verifier: (reference, request) => {
			verifications.push(reference.leaseId);
			const grant = store.get(reference.leaseId);
			if (grant === undefined) return undefined;
			if (grant.grantId !== reference.grantId || grant.bindingId !== reference.bindingId) return undefined;
			if (grant.status !== "active" && grant.status !== "renewing") return undefined;
			if (Date.parse(now()) >= Date.parse(grant.expiresAt)) return undefined;
			if (grant.sessionId !== request.sessionId || grant.runId !== request.runId) return undefined;
			if (grant.targetId === undefined) return undefined;
			const binding = issuedBindingFor(session.getEntries(), reference.bindingId);
			if (binding === undefined) return undefined;
			if (binding.capabilityBindingId !== request.capabilityBindingId) return undefined;
			if (binding.policyBindingId !== request.policyBindingId) return undefined;
			return { status: grant.status, scopeDigest: grant.scopeDigest, targetId: grant.targetId };
		},
	};
}

function referenceFor(grant: TaskCredentialGrant): TaskLeaseReference {
	return { leaseId: grant.leaseId, grantId: grant.grantId, bindingId: grant.bindingId };
}

/** Build a fixture whose referenced lease is missing, terminal, or quarantined. */
function terminalLeaseCase(
	kind: "unknown" | "revoked" | "settled" | "revocation_unknown",
): {
	readonly fixture: ReturnType<typeof makeCredentialFixture>;
	readonly reference: TaskLeaseReference;
} {
	if (kind === "unknown") {
		return {
			fixture: makeCredentialFixture(),
			reference: { leaseId: "lease-missing", grantId: "grant-missing", bindingId: "binding-1" },
		};
	}
	const fixture = makeCredentialFixture({ revokeOutcome: kind === "revocation_unknown" ? "revocation_unknown" : "revoked" });
	const grant = issueTaskLease(fixture.store);
	if (kind === "revoked") {
		fixture.store.revoke({ leaseId: grant.leaseId, clientRequestId: "revoke-setup-1" });
	} else if (kind === "settled") {
		fixture.store.project({ leaseId: grant.leaseId, clientRequestId: "project-setup-1" });
		fixture.store.revoke({ leaseId: grant.leaseId, clientRequestId: "revoke-setup-1" });
		fixture.store.settle({ leaseId: grant.leaseId, clientRequestId: "settle-setup-1" });
	} else if (kind === "revocation_unknown") {
		fixture.store.revoke({ leaseId: grant.leaseId, clientRequestId: "revoke-setup-1" });
	}
	return { fixture, reference: referenceFor(grant) };
}

function invalidError(): { category: "invalid"; code: "invalid"; retryable: false; sideEffects: "none" } {
	return { category: "invalid", code: "invalid", retryable: false, sideEffects: "none" };
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
		"records canonical correlation refs and rejects association input on the %s path",
		async (_name, _state, provider) => {
			const session = SessionManager.inMemory("/workspace/remote-operation");
			expect(
				isRemoteOperationRequest({
					...request("operation-association-rejected"),
					bindingAssociation: { schemaVersion: 1, associationId: "association-1", runId: "run-1", bindings: [] },
				}),
			).toBe(false);
			const receipt = await executeRemoteOperation(
				provider,
				{ ...request("operation-ledger"), sessionId: session.getSessionId() },
				{
					now: () => NOW,
					ledger: createSessionRemoteOperationLedger(session),
				},
			);

			expect(receipt).not.toHaveProperty("bindingAssociation");
			expect(session.getEntries()).toHaveLength(1);
			expect(session.getEntries()[0]).toMatchObject({
				type: "custom",
				customType: REMOTE_OPERATION_CUSTOM_TYPE,
				data: {
					schemaVersion: REMOTE_OPERATION_LEDGER_SCHEMA_VERSION,
					receipt: {
						operationId: "operation-ledger",
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
				summary: { operationId: "operation-ledger" },
			});
			expect(audit.events[0]?.summary).not.toHaveProperty("bindingAssociation");
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

describe("task lease correlation", () => {
	it("accepts only the exact safe task lease reference shape", () => {
		expect(isTaskLeaseReference({ leaseId: "lease-1", grantId: "grant-1", bindingId: "binding-1" })).toBe(true);
		expect(isTaskLeaseReference({ leaseId: "lease-1", grantId: "grant-1" })).toBe(false);
		expect(
			isTaskLeaseReference({ leaseId: "lease-1", grantId: "grant-1", bindingId: "binding-1", expiresAt: NOW }),
		).toBe(false);
		expect(
			isTaskLeaseReference({ leaseId: "lease-1", grantId: "grant-1", bindingId: "binding-1", status: "active" }),
		).toBe(false);
		expect(isTaskLeaseReference({ leaseId: "../../etc/passwd", grantId: "grant-1", bindingId: "binding-1" })).toBe(false);
		expect(isTaskLeaseReference(null)).toBe(false);
	});

	it("verifies an active task lease before start and keeps the correlation on the receipt", async () => {
		const fixture = makeCredentialFixture();
		const grant = issueTaskLease(fixture.store);
		const reference = referenceFor(grant);
		const { verifier, verifications } = makeTaskLeaseVerifier(fixture.store, fixture.session, fixture.now);
		const pair = providerPair();

		const receipt = await executeRemoteOperation(
			pair.fake,
			{ ...request("operation-task-lease"), taskLease: reference },
			{ now: () => NOW, taskLeaseVerifier: verifier },
		);

		expect(receipt.status).toBe("completed");
		expect(receipt.operationId).toBe("operation-task-lease");
		expect(receipt.operationId).not.toBe(grant.leaseId);
		expect(receipt.taskLease).toEqual(reference);
		expect(receipt.taskLeaseVerified).toEqual({
			status: "active",
			scopeDigest: grant.scopeDigest,
			targetId: LEASE_TARGET,
		});
		expect(isRemoteOperationReceipt(receipt)).toBe(true);
		expect(verifications).toEqual([grant.leaseId]);
		expect(pair.fake.state.invocations).toHaveLength(1);
		// The verification is read-only: only the setup issuance touched the credential provider.
		expect(fixture.calls).toEqual({ issue: 1, renew: 0, project: 0, revoke: 0 });
	});

	it("keeps the task lease correlation in the session ledger entry", async () => {
		const fixture = makeCredentialFixture();
		const grant = issueTaskLease(fixture.store);
		const reference = referenceFor(grant);
		const { verifier } = makeTaskLeaseVerifier(fixture.store, fixture.session, fixture.now);
		const pair = providerPair();

		const receipt = await executeRemoteOperation(
			pair.fake,
			{
				...request("operation-lease-ledger"),
				sessionId: fixture.session.getSessionId(),
				taskLease: reference,
			},
			{
				now: () => NOW,
				taskLeaseVerifier: verifier,
				ledger: createSessionRemoteOperationLedger(fixture.session),
			},
		);

		const operationEntry = fixture.session.getEntries().find(
			(entry) => entry.type === "custom" && entry.customType === REMOTE_OPERATION_CUSTOM_TYPE,
		);
		expect(operationEntry).toBeDefined();
		if (operationEntry === undefined || operationEntry.type !== "custom") throw new Error("expected entry");
		expect(operationEntry.data).toMatchObject({
			schemaVersion: REMOTE_OPERATION_LEDGER_SCHEMA_VERSION,
			receipt: { operationId: "operation-lease-ledger", taskLease: reference },
		});
		expect(receipt.taskLeaseVerified).toEqual({
			status: "active",
			scopeDigest: grant.scopeDigest,
			targetId: LEASE_TARGET,
		});
		const audit = new ExecutionAuditQuery(fixture.session).query({
			scope: "current-session",
			types: ["remote.operation"],
		});
		expect(audit.events).toHaveLength(1);
		expect(audit.events[0]).toMatchObject({ type: "remote.operation", runId: "run-1" });
		expect(JSON.stringify(fixture.session.getEntries())).not.toContain("sentinel-secret-42");
	});

	it("requires an injected verifier for a credential-dependent operation", async () => {
		const fixture = makeCredentialFixture();
		const grant = issueTaskLease(fixture.store);
		const pair = providerPair();

		const receipt = await executeRemoteOperation(
			pair.fake,
			{ ...request("operation-no-verifier"), taskLease: referenceFor(grant) },
			{ now: () => NOW },
		);

		expect(receipt.status).toBe("failed");
		expect(receipt.error).toEqual(invalidError());
		expect(receipt.taskLease).toEqual(referenceFor(grant));
		expect(receipt.taskLeaseVerified).toBeUndefined();
		expect(pair.fake.state.invocations).toHaveLength(0);
		expect(pair.fake.state.sideEffects).toHaveLength(0);
	});

	it.each(["unknown", "revoked", "settled", "revocation_unknown"] as const)(
		"refuses a credential-dependent operation for a %s lease before start",
		async (kind) => {
			const { fixture, reference } = terminalLeaseCase(kind);
			const { verifier, verifications } = makeTaskLeaseVerifier(fixture.store, fixture.session, fixture.now);
			const pair = providerPair();

			const receipt = await executeRemoteOperation(
				pair.fake,
				{ ...request("operation-terminal-lease"), taskLease: reference },
				{ now: () => NOW, taskLeaseVerifier: verifier },
			);

			expect(receipt.status).toBe("failed");
			expect(receipt.error).toEqual(invalidError());
			expect(receipt.sideEffects).toBe("none");
			expect(receipt.taskLease).toEqual(reference);
			expect(receipt.taskLeaseVerified).toBeUndefined();
			expect(pair.fake.state.invocations).toHaveLength(0);
			expect(pair.fake.state.sideEffects).toHaveLength(0);
			expect(verifications).toEqual([reference.leaseId]);

			// The terminal or quarantined state only blocks credential-dependent
			// operations: an operation without a task lease reference still runs.
			const independent = await executeRemoteOperation(pair.fake, request("operation-independent"), { now: () => NOW });
			expect(independent.status).toBe("completed");
		},
	);

	it("refuses a credential-dependent operation after the task lease expires", async () => {
		const fixture = makeCredentialFixture();
		const grant = issueTaskLease(fixture.store);
		const reference = referenceFor(grant);
		fixture.setClock(TASK_LEASE_EXPIRED);
		const { verifier, verifications } = makeTaskLeaseVerifier(fixture.store, fixture.session, fixture.now);
		const pair = providerPair();

		const receipt = await executeRemoteOperation(
			pair.fake,
			{ ...request("operation-expired-lease"), taskLease: reference },
			{ now: () => NOW, taskLeaseVerifier: verifier },
		);

		expect(receipt.status).toBe("failed");
		expect(receipt.error).toEqual(invalidError());
		expect(pair.fake.state.invocations).toHaveLength(0);
		expect(verifications).toEqual([grant.leaseId]);
	});

	it("refuses a credential-dependent operation when the binding does not correlate with the request", async () => {
		const fixture = makeCredentialFixture();
		const grant = issueTaskLease(fixture.store, { runId: "run-other" });
		const reference = referenceFor(grant);
		const { verifier, verifications } = makeTaskLeaseVerifier(fixture.store, fixture.session, fixture.now);
		const pair = providerPair();

		const receipt = await executeRemoteOperation(
			pair.fake,
			{ ...request("operation-uncorrelated"), taskLease: reference },
			{ now: () => NOW, taskLeaseVerifier: verifier },
		);

		expect(receipt.status).toBe("failed");
		expect(receipt.error).toEqual(invalidError());
		expect(pair.fake.state.invocations).toHaveLength(0);
		expect(verifications).toEqual([grant.leaseId]);
	});

	it("operation heartbeats never advance the task lease sequence", async () => {
		const fixture = makeCredentialFixture();
		const grant = issueTaskLease(fixture.store);
		const reference = referenceFor(grant);
		const { verifier, verifications } = makeTaskLeaseVerifier(fixture.store, fixture.session, fixture.now);
		const pair = providerPair({ hold: true });
		const operationId = "operation-heartbeat-lease";
		const handle = startRemoteOperation(
			pair.fake,
			{ ...request(operationId), taskLease: reference },
			{ now: () => NOW, taskLeaseVerifier: verifier },
		);
		await Promise.resolve();

		const first = await handle.heartbeat();
		const second = await handle.heartbeat();
		pair.fake.release(operationId);
		const receipt = await handle.receipt;

		// Operation heartbeats renew the operation lease (lease-1), not the task lease.
		expect(first).toEqual({ leaseId: "lease-1", expiresAt: FUTURE });
		expect(second).toEqual({ leaseId: "lease-1", expiresAt: FUTURE });
		expect(pair.fake.state.heartbeats).toEqual([
			{ operationId, leaseId: "lease-1", sequence: 1, sentAt: NOW },
			{ operationId, leaseId: "lease-1", sequence: 2, sentAt: NOW },
		]);
		expect(pair.fake.state.heartbeats.every((heartbeat) => heartbeat.leaseId !== grant.leaseId)).toBe(true);
		// The task lease grant is untouched: its sequence stays 0 and the
		// credential provider was never called after the setup issuance.
		expect(fixture.store.get(grant.leaseId)?.heartbeatSequence).toBe(0);
		expect(fixture.calls).toEqual({ issue: 1, renew: 0, project: 0, revoke: 0 });
		// The verifier ran exactly once at start; heartbeats do not re-verify.
		expect(verifications).toEqual([grant.leaseId]);
		expect(receipt.status).toBe("completed");
		expect(receipt.heartbeatSequence).toBe(2);
		expect(receipt.taskLeaseVerified?.status).toBe("active");
	});

	it("a task lease revoke never fakes an operation terminal", async () => {
		const fixture = makeCredentialFixture();
		const grant = issueTaskLease(fixture.store);
		const reference = referenceFor(grant);
		const { verifier } = makeTaskLeaseVerifier(fixture.store, fixture.session, fixture.now);
		const pair = providerPair();

		const handle = startRemoteOperation(
			pair.fake,
			{ ...request("operation-revoke-independent"), sessionId: fixture.session.getSessionId(), taskLease: reference },
			{
				now: () => NOW,
				taskLeaseVerifier: verifier,
				ledger: createSessionRemoteOperationLedger(fixture.session),
			},
		);
		const receipt = await handle.receipt;
		expect(receipt.status).toBe("completed");
		expect(pair.fake.state.cancellations).toEqual([]);

		// Revoking the task lease touches only the lease; the operation receipt
		// stays terminal and no second operation entry is appended.
		const revoke = fixture.store.revoke({ leaseId: grant.leaseId, clientRequestId: "revoke-after-1" });
		expect(revoke.grant.status).toBe("revoked");
		expect(pair.fake.state.cancellations).toEqual([]);
		expect(receipt.status).toBe("completed");
		expect(
			fixture.session
				.getEntries()
				.filter((entry) => entry.type === "custom" && entry.customType === REMOTE_OPERATION_CUSTOM_TYPE),
		).toHaveLength(1);

		// The revoked lease now refuses a new credential-dependent operation.
		const after = await executeRemoteOperation(
			pair.fake,
			{ ...request("operation-after-revoke"), taskLease: reference },
			{ now: () => NOW, taskLeaseVerifier: verifier },
		);
		expect(after.status).toBe("failed");
		expect(after.error).toEqual(invalidError());
		expect(pair.fake.state.invocations).toHaveLength(1);
	});

	it("operation cancellation never revokes the task lease", async () => {
		const fixture = makeCredentialFixture();
		const grant = issueTaskLease(fixture.store);
		const reference = referenceFor(grant);
		const { verifier } = makeTaskLeaseVerifier(fixture.store, fixture.session, fixture.now);
		const pair = providerPair({ hold: true });
		const operationId = "operation-cancel-lease";
		const handle = startRemoteOperation(
			pair.fake,
			{ ...request(operationId), taskLease: reference },
			{ now: () => NOW, taskLeaseVerifier: verifier },
		);
		await Promise.resolve();
		await handle.cancel();
		pair.fake.release(operationId);
		const receipt = await handle.receipt;

		expect(receipt.status).toBe("cancelled");
		expect(pair.fake.state.cancellations).toEqual([operationId]);
		// The task lease was never revoked and its status is untouched.
		expect(fixture.calls.revoke).toBe(0);
		expect(fixture.store.get(grant.leaseId)?.status).toBe("active");
	});

	it("task lease expiry never terminates a running operation", async () => {
		const fixture = makeCredentialFixture();
		const grant = issueTaskLease(fixture.store);
		const reference = referenceFor(grant);
		const { verifier } = makeTaskLeaseVerifier(fixture.store, fixture.session, fixture.now);
		const pair = providerPair({ hold: true });
		const operationId = "operation-expiry-independent";
		const handle = startRemoteOperation(
			pair.fake,
			{ ...request(operationId), taskLease: reference },
			{ now: () => NOW, taskLeaseVerifier: verifier },
		);
		await Promise.resolve();

		// The lease expires mid-operation; the running operation is unaffected.
		fixture.setClock(TASK_LEASE_EXPIRED);
		pair.fake.release(operationId);
		const receipt = await handle.receipt;

		expect(receipt.status).toBe("completed");
		expect(receipt.error).toBeUndefined();
		expect(receipt.taskLeaseVerified?.status).toBe("active");
		expect(pair.fake.state.cancellations).toEqual([]);
	});

	it("a quarantined lease and an unknown side effect coexist without faking a terminal", async () => {
		const fixture = makeCredentialFixture({ revokeOutcome: "revocation_unknown" });
		const grant = issueTaskLease(fixture.store);
		const reference = referenceFor(grant);
		const { verifier } = makeTaskLeaseVerifier(fixture.store, fixture.session, fixture.now);
		const pair = providerPair({ hold: true, sideEffectBeforeHold: true });
		const operationId = "operation-quarantine-unknown";
		const handle = startRemoteOperation(
			pair.fake,
			{ ...request(operationId), taskLease: reference },
			{ now: () => NOW, taskLeaseVerifier: verifier },
		);
		await Promise.resolve();

		// The lease is quarantined mid-operation; the operation is not terminated
		// by it, and its own fail-closed side-effect outcome stays independent.
		const revoked = fixture.store.revoke({ leaseId: grant.leaseId, clientRequestId: "revoke-mid-1" });
		expect(revoked.grant.status).toBe("revocation_unknown");
		await handle.cancel();
		pair.fake.release(operationId);
		const receipt = await handle.receipt;

		expect(receipt.status).toBe("failed");
		expect(receipt.error?.category).toBe("side-effect-unknown");
		expect(receipt.sideEffects).toBe("unknown");
		expect(pair.fake.state.cancellations).toEqual([operationId]);
		// revocation_unknown and side_effect_unknown coexist: the lease is still
		// quarantined and the operation receipt is independently fail-closed.
		expect(fixture.store.get(grant.leaseId)?.status).toBe("revocation_unknown");
	});

	it("does not echo a malformed task lease reference", async () => {
		const fixture = makeCredentialFixture();
		const { verifier } = makeTaskLeaseVerifier(fixture.store, fixture.session, fixture.now);
		const pair = providerPair();
		const malformed = {
			...request("operation-bad-lease"),
			taskLease: { leaseId: "../../secret", grantId: "grant-1", bindingId: "binding-1" },
		} as RemoteOperationRequest;

		expect(isRemoteOperationRequest(malformed)).toBe(false);
		const receipt = await executeRemoteOperation(pair.fake, malformed, {
			now: () => NOW,
			taskLeaseVerifier: verifier,
		});

		expect(receipt.status).toBe("failed");
		expect(receipt.error).toEqual(invalidError());
		expect(receipt).not.toHaveProperty("taskLease");
		expect(pair.fake.state.invocations).toHaveLength(0);
		expect(JSON.stringify(receipt)).not.toContain("secret");
	});

	it("receipt guards reject verified facts without a reference or with terminal status", async () => {
		const fixture = makeCredentialFixture();
		const grant = issueTaskLease(fixture.store);
		const reference = referenceFor(grant);
		const { verifier } = makeTaskLeaseVerifier(fixture.store, fixture.session, fixture.now);
		const pair = providerPair();
		const receipt = await executeRemoteOperation(
			pair.fake,
			{ ...request("operation-guard"), taskLease: reference },
			{ now: () => NOW, taskLeaseVerifier: verifier },
		);
		expect(isRemoteOperationReceipt(receipt)).toBe(true);

		const { taskLease: _taskLease, ...withoutReference } = receipt;
		expect(isRemoteOperationReceipt(withoutReference)).toBe(false);
		expect(
			isRemoteOperationReceipt({ ...receipt, taskLease: { ...reference, expiresAt: NOW } }),
		).toBe(false);
		expect(
			isRemoteOperationReceipt({
				...receipt,
				taskLeaseVerified: {
					...(receipt.taskLeaseVerified as NonNullable<typeof receipt.taskLeaseVerified>),
					status: "expired",
				},
			}),
		).toBe(false);
	});
});
