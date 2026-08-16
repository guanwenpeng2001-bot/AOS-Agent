import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../src/core/session-manager.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import {
	TASK_CREDENTIAL_MAX_TTL_MS,
	TASK_CREDENTIAL_MIN_TTL_MS,
	TASK_CREDENTIAL_SCHEMA_VERSION,
	TaskCredentialError,
	calculateScopeDigest,
	type TaskCredentialDeliveryReceipt,
	type TaskCredentialScope,
	type TaskCredentialTtlBounds,
	type TaskExecutionBinding,
} from "../src/core/task-credential-lease.ts";
import {
	TASK_CREDENTIAL_CUSTOM_TYPE,
	TASK_CREDENTIAL_FORBIDDEN_PAYLOAD_KEYS,
	TaskCredentialStore,
	canonicalTaskCredentialIssuePayload,
	foldTaskCredentialEntries,
	isTaskCredentialTransition,
	parseTaskCredentialTransition,
	serializeTaskCredentialTransition,
	type TaskCredentialSession,
	type TaskCredentialStoreIssueRequest,
	type TaskCredentialStoreOptions,
	type TaskCredentialStoreRevokeRequest,
	type TaskCredentialWarning,
} from "../src/core/task-credential-store.ts";
import {
	createTaskCredentialNullTarget,
	createTaskCredentialTestProvider,
	type TaskCredentialProvider,
	type TaskCredentialProviderReceipt,
	type TaskCredentialTarget,
	type TaskCredentialTargetCapabilities,
	type TaskCredentialTargetCapabilitiesRequest,
	type TaskCredentialTargetRenewRequest,
	type TaskCredentialTargetRevokeRequest,
	type TaskCredentialTestProvider,
} from "../src/core/task-credential-provider.ts";

const NOW = "2026-08-16T12:00:00.000Z";
const NOW_MS = Date.parse(NOW);
const TTL = 60_000;
const SENTINEL = "sentinel-secret-42";
// A fresh in-memory Session id, used by the binding fixture.
const SESSION_ID = "session_cred_test";

function makeBinding(overrides: Partial<TaskExecutionBinding> = {}): TaskExecutionBinding {
	return {
		schemaVersion: 1,
		bindingId: "binding_001",
		sessionId: SESSION_ID,
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

function makeBounds(overrides: Partial<TaskCredentialTtlBounds> = {}): TaskCredentialTtlBounds {
	return { minTtlMs: TASK_CREDENTIAL_MIN_TTL_MS, maxTtlMs: TASK_CREDENTIAL_MAX_TTL_MS, ...overrides };
}

function issueRequest(overrides: Partial<TaskCredentialStoreIssueRequest> = {}): TaskCredentialStoreIssueRequest {
	return {
		leaseId: "lease_001",
		grantId: "grant_001",
		binding: makeBinding(),
		scopes: [makeScope()],
		requestedTtlMs: TTL,
		ttlBounds: makeBounds(),
		clientRequestId: "issue-1",
		...overrides,
	};
}

function makeProvider(overrides: {
	target?: RecordingTarget;
	revokeOutcome?: "revoked" | "revocation_unknown";
} = {}): TaskCredentialTestProvider {
	return createTaskCredentialTestProvider({
		materials: { package_registry: SENTINEL },
		now: () => NOW,
		...(overrides.target === undefined ? {} : { target: overrides.target }),
		...(overrides.revokeOutcome === undefined ? {} : { revokeOutcome: overrides.revokeOutcome }),
	});
}

class RecordingTarget {
	received: Array<{ leaseId: string; material: Record<string, string> }> = [];
	status: "succeeded" | "failed" | "unknown" = "succeeded";

	project(request: {
		readonly schemaVersion: 1;
		readonly leaseId: string;
		readonly grantId: string;
		readonly bindingId: string;
		readonly targetId?: string;
		readonly scopes: ReadonlyArray<TaskCredentialScope>;
		readonly material: Readonly<Record<string, string>>;
		readonly projectedAt: string;
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
		return receipt;
	}

	getCapabilities(request: TaskCredentialTargetCapabilitiesRequest): TaskCredentialTargetCapabilities {
		return {
			schemaVersion: TASK_CREDENTIAL_SCHEMA_VERSION,
			targetId: request.targetId,
			targetKind: request.targetKind,
			bindingId: request.bindingId,
			canReceiveShortLivedCredential: true,
			canRenewCredential: true,
			canRevokeCredential: true,
			supportsPerBindingIsolation: true,
			supportsDeliveryReceipt: true,
		};
	}

	renew(request: TaskCredentialTargetRenewRequest): TaskCredentialProviderReceipt {
		return {
			schemaVersion: TASK_CREDENTIAL_SCHEMA_VERSION,
			leaseId: request.leaseId,
			grantId: request.grantId,
			bindingId: request.bindingId,
			status: "renewed",
			recordedAt: NOW,
		};
	}

	revoke(request: TaskCredentialTargetRevokeRequest): TaskCredentialProviderReceipt {
		return {
			schemaVersion: TASK_CREDENTIAL_SCHEMA_VERSION,
			leaseId: request.leaseId,
			grantId: request.grantId,
			bindingId: request.bindingId,
			status: "revoked",
			recordedAt: NOW,
		};
	}
}

function recordingProvider(provider: TaskCredentialProvider): { provider: TaskCredentialProvider; calls: string[] } {
	const calls: string[] = [];
	const target = provider.target;
	return {
		calls,
		provider: {
			issuer: {
				issue: (request) => {
					calls.push("issue");
					return provider.issuer.issue(request);
				},
				renew: (request) => {
					calls.push("renew");
					return provider.issuer.renew(request);
				},
				revoke: (request) => {
					calls.push("revoke");
					return provider.issuer.revoke(request);
				},
			},
			target: {
				getCapabilities: (request) => target.getCapabilities(request),
				project: (request) => {
					calls.push("project");
					return target.project(request);
				},
				renew: (request) => target.renew(request),
				revoke: (request) => target.revoke(request),
			} satisfies TaskCredentialTarget,
		},
	};
}

function makeSession(): SessionManager {
	return SessionManager.inMemory("/workspace/task-credential", { id: SESSION_ID });
}

function makeStore(
	session: TaskCredentialSession,
	provider: TaskCredentialProvider,
	options: { now?: () => string; diagnostics?: NonNullable<TaskCredentialStoreOptions["diagnostics"]> } = {},
): TaskCredentialStore {
	return new TaskCredentialStore(session, provider, {
		now: options.now ?? (() => NOW),
		...(options.diagnostics === undefined ? {} : { diagnostics: options.diagnostics }),
	});
}

/** Drive one lease through issue -> delivery -> revoke -> settle. */
function settleLease(store: TaskCredentialStore, leaseId: string, clientRequestIdPrefix: string): void {
	store.project({ leaseId, clientRequestId: `${clientRequestIdPrefix}-project` });
	store.revoke({ leaseId, clientRequestId: `${clientRequestIdPrefix}-revoke` });
	store.settle({ leaseId, clientRequestId: `${clientRequestIdPrefix}-settle` });
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

function isCredentialEntry(entry: SessionEntry): entry is Extract<SessionEntry, { type: "custom" }> {
	return entry.type === "custom" && entry.customType === TASK_CREDENTIAL_CUSTOM_TYPE;
}

function entryPayloads(session: SessionManager): unknown[] {
	return session.getEntries().filter(isCredentialEntry).map((entry) => entry.data);
}

function assertNoSentinel(value: unknown, label: string): void {
	expect(JSON.stringify(value), label).not.toContain(SENTINEL);
}

describe("store issue", () => {
	it("issues a grant, persists one transition, and exposes every index", () => {
		const session = makeSession();
		const recorded = recordingProvider(makeProvider());
		const store = makeStore(session, recorded.provider);

		const result = store.issue(issueRequest());

		expect(result.appended).toBe(true);
		expect(result.idempotent).toBe(false);
		expect(result.receipt).toMatchObject({ status: "issued", leaseId: "lease_001", grantId: "grant_001" });
		expect(recorded.calls).toEqual(["issue"]);
		expect(result.grant).toMatchObject({
			schemaVersion: 1,
			leaseId: "lease_001",
			grantId: "grant_001",
			bindingId: "binding_001",
			sessionId: session.getSessionId(),
			status: "active",
			revision: 0,
			heartbeatSequence: 0,
			scopeCount: 1,
			scopeDigest: calculateScopeDigest([makeScope()]),
			targetId: "target_1",
			issuedAt: NOW,
			expiresAt: new Date(NOW_MS + TTL).toISOString(),
			renewAfter: new Date(NOW_MS + TTL - 5_000).toISOString(),
		});
		expect(result.entryId).toBeDefined();
		expect(entryPayloads(session)).toHaveLength(1);
		expect(store.get("lease_001")).toEqual(result.grant);
		expect(store.getByGrantId("grant_001")).toEqual(result.grant);
		expect(store.getByBindingId("binding_001")).toEqual([result.grant]);
		expect(store.list()).toEqual([result.grant]);
		expect(store.warnings()).toEqual([]);
	});

	it("never lets sentinel material reach entries, warnings, errors, or the public projection", () => {
		const session = makeSession();
		const provider = makeProvider();
		const store = makeStore(session, provider);

		const result = store.issue(issueRequest());
		assertNoSentinel(result.grant, "grant");
		assertNoSentinel(result.receipt, "receipt");
		assertNoSentinel(entryPayloads(session), "entries");
		assertNoSentinel(store.warnings(), "warnings");
		assertNoSentinel(store.list(), "projection");
		assertNoSentinel(session.getEntries(), "full session");
	});

	it("rejects requests that smuggle material keys before appending anything", () => {
		const session = makeSession();
		const store = makeStore(session, makeProvider());
		for (const key of TASK_CREDENTIAL_FORBIDDEN_PAYLOAD_KEYS.slice(0, 8)) {
			expectCredentialError(() => store.issue({ ...issueRequest(), [key]: SENTINEL }), "task_credential_invalid");
		}
		expectCredentialError(
			() => store.issue({ ...issueRequest(), token: SENTINEL, clientRequestId: "issue-token" } as TaskCredentialStoreIssueRequest),
			"task_credential_invalid",
		);
		expect(entryPayloads(session)).toHaveLength(0);
		assertNoSentinel(entryPayloads(session), "entries");
	});

	it("rejects malformed requests with the frozen error codes", () => {
		const session = makeSession();
		const store = makeStore(session, makeProvider());
		expectCredentialError(() => store.issue(issueRequest({ leaseId: "lease/../x" })), "task_credential_invalid");
		expectCredentialError(() => store.issue(issueRequest({ grantId: "grant@evil" })), "task_credential_invalid");
		expectCredentialError(() => store.issue(issueRequest({ clientRequestId: "" })), "task_credential_invalid");
		expectCredentialError(
			() => store.issue(issueRequest({ binding: makeBinding({ sessionId: "" }) })),
			"task_credential_binding_invalid",
		);
		expectCredentialError(
			() => store.issue(issueRequest({ binding: makeBinding({ token: SENTINEL } as Partial<TaskExecutionBinding>) })),
			"task_credential_binding_invalid",
		);
		expectCredentialError(
			() => store.issue(issueRequest({ scopes: [{ ...makeScope(), value: SENTINEL } as TaskCredentialScope] })),
			"task_credential_invalid",
		);
		expectCredentialError(
			() => store.issue(issueRequest({ requestedTtlMs: TASK_CREDENTIAL_MIN_TTL_MS - 1 })),
			"task_credential_ttl_invalid",
		);
		expectCredentialError(
			() => store.issue(issueRequest({ requestedTtlMs: TASK_CREDENTIAL_MAX_TTL_MS + 1 })),
			"task_credential_ttl_invalid",
		);
		expectCredentialError(
			() => store.issue(issueRequest({ ttlBounds: makeBounds({ minTtlMs: 5_000, maxTtlMs: 1_000 }) })),
			"task_credential_ttl_invalid",
		);
		expectCredentialError(
			() => store.issue(issueRequest({ ttlBounds: makeBounds({ deadlineAtMs: NOW_MS + 10_000 }) })),
			"task_credential_ttl_invalid",
		);
		expect(entryPayloads(session)).toHaveLength(0);
	});

	it("conflicts on duplicate lease, grant, or active binding", () => {
		const session = makeSession();
		const store = makeStore(session, makeProvider());
		store.issue(issueRequest());
		expectCredentialError(
			() => store.issue(issueRequest({ grantId: "grant_002", clientRequestId: "issue-2" })),
			"task_credential_conflict",
		);
		expectCredentialError(
			() => store.issue(issueRequest({ leaseId: "lease_002", clientRequestId: "issue-2" })),
			"task_credential_conflict",
		);
		expectCredentialError(
			() => store.issue(issueRequest({ leaseId: "lease_002", grantId: "grant_002", clientRequestId: "issue-2" })),
			"task_credential_conflict",
		);
		expect(entryPayloads(session)).toHaveLength(1);
	});

	it("allows a new grant for the same binding after the previous lease is terminal", () => {
		const session = makeSession();
		const store = makeStore(session, makeProvider());
		store.issue(issueRequest());
		settleLease(store, "lease_001", "lease-1");
		const second = store.issue(
			issueRequest({ leaseId: "lease_002", grantId: "grant_002", clientRequestId: "issue-2" }),
		);
		expect(second.appended).toBe(true);
		expect(store.getByBindingId("binding_001")).toHaveLength(2);
	});

	it("replays an identical issue and conflicts on a different payload with the same key", () => {
		const session = makeSession();
		const store = makeStore(session, makeProvider());
		const first = store.issue(issueRequest());
		const replay = store.issue(issueRequest());
		expect(replay).toMatchObject({ grant: first.grant, appended: false, idempotent: true });
		expect(replay.receipt).toMatchObject({ status: "issued" });
		expect(entryPayloads(session)).toHaveLength(1);
		expectCredentialError(
			() => store.issue(issueRequest({ requestedTtlMs: 120_000 })),
			"task_credential_conflict",
		);
		expectCredentialError(
			() => store.issue(issueRequest({ scopes: [makeScope({ purpose: "dependency_write" })] })),
			"task_credential_conflict",
		);
		expect(entryPayloads(session)).toHaveLength(1);
	});

	it("surfaces issuer failures without appending anything", () => {
		const session = makeSession();
		const store = makeStore(
			session,
			createTaskCredentialTestProvider({
				materials: { other_cred: "sentinel-other" },
				now: () => NOW,
			}),
		);
		expectCredentialError(() => store.issue(issueRequest()), "task_credential_scope_denied");
		expect(entryPayloads(session)).toHaveLength(0);
	});

	it("rethrows a retryable provider outage without appending anything", () => {
		const session = makeSession();
		const store = makeStore(session, {
			issuer: {
				issue: () => {
					throw new TaskCredentialError("task_credential_provider_unavailable");
				},
				renew: () => {
					throw new TaskCredentialError("task_credential_provider_unavailable");
				},
				revoke: () => {
					throw new TaskCredentialError("task_credential_provider_unavailable");
				},
			},
			target: createTaskCredentialNullTarget({ now: () => NOW }),
		});
		const error = expectCredentialError(() => store.issue(issueRequest()), "task_credential_provider_unavailable");
		void error;
		expect(entryPayloads(session)).toHaveLength(0);
		expect(store.list()).toEqual([]);
	});

	it("reports a provider receipt that is not an issued receipt as an issuer failure", () => {
		const session = makeSession();
		const store = makeStore(session, {
			issuer: {
				issue: (): TaskCredentialProviderReceipt => ({
					schemaVersion: TASK_CREDENTIAL_SCHEMA_VERSION,
					leaseId: "lease_001",
					grantId: "grant_001",
					bindingId: "binding_001",
					status: "revoked",
					recordedAt: NOW,
				}),
				renew: () => {
					throw new TaskCredentialError("task_credential_provider_unavailable");
				},
				revoke: () => {
					throw new TaskCredentialError("task_credential_provider_unavailable");
				},
			},
			target: createTaskCredentialNullTarget({ now: () => NOW }),
		});
		expectCredentialError(() => store.issue(issueRequest()), "task_credential_issue_failed");
		expect(entryPayloads(session)).toHaveLength(0);
	});
});

describe("store renew", () => {
	function setup(nowMs: number = NOW_MS + 1_000) {
		const session = makeSession();
		const recorded = recordingProvider(makeProvider());
		let clock = nowMs;
		const store = makeStore(session, recorded.provider, { now: () => new Date(clock).toISOString() });
		store.issue(issueRequest());
		clock += 1_000;
		return {
			session,
			recorded,
			store,
			advance: (ms: number) => {
				clock += ms;
			},
		};
	}

	it("extends the lease with a strict heartbeat and revision bump", () => {
		const { session, recorded, store } = setup();
		const result = store.renew({ leaseId: "lease_001", heartbeatSequence: 1, requestedTtlMs: TTL, ttlBounds: makeBounds(), clientRequestId: "renew-1" });
		expect(result.appended).toBe(true);
		expect(recorded.calls).toEqual(["issue", "renew"]);
		expect(result.receipt).toMatchObject({ status: "renewed" });
		expect(result.grant).toMatchObject({
			status: "active",
			revision: 1,
			heartbeatSequence: 1,
			issuedAt: new Date(NOW_MS + 1_000).toISOString(),
		});
		expect(result.grant.expiresAt).toBe(new Date(NOW_MS + 2_000 + TTL).toISOString());
		expect(result.grant.scopeDigest).toBe(calculateScopeDigest([makeScope()]));
		expect(entryPayloads(session)).toHaveLength(2);
		expect(store.warnings()).toEqual([]);
	});

	it("replays an identical renew and conflicts on a different TTL with the same key", () => {
		const { session, store } = setup();
		store.renew({ leaseId: "lease_001", heartbeatSequence: 1, requestedTtlMs: TTL, ttlBounds: makeBounds(), clientRequestId: "renew-1" });
		const replay = store.renew({ leaseId: "lease_001", heartbeatSequence: 1, requestedTtlMs: TTL, ttlBounds: makeBounds(), clientRequestId: "renew-1" });
		expect(replay.idempotent).toBe(true);
		expect(replay.appended).toBe(false);
		expect(entryPayloads(session)).toHaveLength(2);
		expectCredentialError(
			() => store.renew({ leaseId: "lease_001", heartbeatSequence: 1, requestedTtlMs: 120_000, ttlBounds: makeBounds(), clientRequestId: "renew-1" }),
			"task_credential_conflict",
		);
		expect(entryPayloads(session)).toHaveLength(2);
	});

	it("validates the client heartbeat sequence strictly before the provider", () => {
		const { session, recorded, store, advance } = setup();
		advance(1_000);
		// A jump ahead of the current sequence is rejected before the provider.
		expectCredentialError(
			() => store.renew({ leaseId: "lease_001", heartbeatSequence: 2, requestedTtlMs: TTL, ttlBounds: makeBounds(), clientRequestId: "renew-jump" }),
			"task_lease_heartbeat_invalid",
		);
		// A sequence below the next one is rejected too.
		expectCredentialError(
			() => store.renew({ leaseId: "lease_001", heartbeatSequence: 0, requestedTtlMs: TTL, ttlBounds: makeBounds(), clientRequestId: "renew-zero" }),
			"task_lease_heartbeat_invalid",
		);
		expect(recorded.calls).toEqual(["issue"]);
		expect(entryPayloads(session)).toHaveLength(1);
		// The exact next sequence renews once...
		const renewed = store.renew({ leaseId: "lease_001", heartbeatSequence: 1, requestedTtlMs: TTL, ttlBounds: makeBounds(), clientRequestId: "renew-1" });
		expect(renewed.appended).toBe(true);
		expect(recorded.calls).toEqual(["issue", "renew"]);
		// ...and the same stale sequence under a new key is rejected without
		// a second provider call or append.
		expectCredentialError(
			() => store.renew({ leaseId: "lease_001", heartbeatSequence: 1, requestedTtlMs: TTL, ttlBounds: makeBounds(), clientRequestId: "renew-dup" }),
			"task_lease_heartbeat_invalid",
		);
		expect(recorded.calls).toEqual(["issue", "renew"]);
		expect(entryPayloads(session)).toHaveLength(2);
	});

	it("replays an identical sequence payload and conflicts on a different sequence with the same key", () => {
		const { session, recorded, store } = setup();
		store.renew({ leaseId: "lease_001", heartbeatSequence: 1, requestedTtlMs: TTL, ttlBounds: makeBounds(), clientRequestId: "renew-1" });
		const replay = store.renew({ leaseId: "lease_001", heartbeatSequence: 1, requestedTtlMs: TTL, ttlBounds: makeBounds(), clientRequestId: "renew-1" });
		expect(replay.idempotent).toBe(true);
		expect(replay.appended).toBe(false);
		expect(recorded.calls).toEqual(["issue", "renew"]);
		expect(entryPayloads(session)).toHaveLength(2);
		// Reusing the key with a different sequence can never replay the result:
		// the canonical payload now includes the sequence, so this is a conflict.
		expectCredentialError(
			() => store.renew({ leaseId: "lease_001", heartbeatSequence: 2, requestedTtlMs: TTL, ttlBounds: makeBounds(), clientRequestId: "renew-1" }),
			"task_credential_conflict",
		);
		expect(recorded.calls).toEqual(["issue", "renew"]);
		expect(entryPayloads(session)).toHaveLength(2);
	});

	it("rejects renew of an unknown lease, an expired lease, and a settled lease", () => {
		const { store, advance } = setup();
		expectCredentialError(
			() => store.renew({ leaseId: "lease_missing", heartbeatSequence: 1, requestedTtlMs: TTL, ttlBounds: makeBounds(), clientRequestId: "renew-x" }),
			"task_credential_not_found",
		);
		advance(TTL + 1_000);
		expectCredentialError(
			() => store.renew({ leaseId: "lease_001", heartbeatSequence: 1, requestedTtlMs: TTL, ttlBounds: makeBounds(), clientRequestId: "renew-x" }),
			"task_lease_expired",
		);
	});

	it("rejects an out-of-bounds renew TTL before calling the provider", () => {
		const { recorded, store } = setup();
		expectCredentialError(
			() => store.renew({ leaseId: "lease_001", heartbeatSequence: 1, requestedTtlMs: TASK_CREDENTIAL_MAX_TTL_MS + 1, ttlBounds: makeBounds(), clientRequestId: "renew-x" }),
			"task_credential_ttl_invalid",
		);
		expect(recorded.calls).toEqual(["issue"]);
	});

	it("rejects renew after revoke with a conflict", () => {
		const { store } = setup();
		store.revoke({ leaseId: "lease_001", clientRequestId: "revoke-1" });
		expectCredentialError(
			() => store.renew({ leaseId: "lease_001", heartbeatSequence: 1, requestedTtlMs: TTL, ttlBounds: makeBounds(), clientRequestId: "renew-x" }),
			"task_credential_conflict",
		);
	});
});

describe("store project", () => {
	function setup(target: RecordingTarget | null | undefined = new RecordingTarget(), nowMs: number = NOW_MS + 1_000) {
		const session = makeSession();
		const materialTarget = target === null ? undefined : (target ?? new RecordingTarget());
		const recorded = recordingProvider(makeProvider(materialTarget === undefined ? {} : { target: materialTarget }));
		let clock = nowMs;
		const store = makeStore(session, recorded.provider, { now: () => new Date(clock).toISOString() });
		store.issue(issueRequest());
		clock += 1_000;
		return {
			session,
			recorded,
			store,
			materialTarget,
			advance: (ms: number) => {
				clock += ms;
			},
		};
	}

	it("records a successful delivery with a safe receipt and forwards material to the target", () => {
		const materialTarget = new RecordingTarget();
		const { session, recorded, store } = setup(materialTarget);
		const result = store.project({ leaseId: "lease_001", clientRequestId: "project-1" });
		expect(result.appended).toBe(true);
		expect(recorded.calls).toEqual(["issue", "project"]);
		expect(result.receipt).toMatchObject({ status: "succeeded", targetId: "target_1" });
		expect(result.grant).toMatchObject({ status: "active", revision: 1, heartbeatSequence: 0 });
		// Material reached the target (the only channel where it may flow) ...
		expect(materialTarget.received).toHaveLength(1);
		expect(materialTarget.received[0]!.material).toEqual({ package_registry: SENTINEL });
		// ... but never the receipt, the persisted entry, or the projection.
		assertNoSentinel(result.receipt, "receipt");
		assertNoSentinel(entryPayloads(session), "entries");
		const persisted = parseTaskCredentialTransition(entryPayloads(session)[1]);
		expect(persisted?.deliveryReceipt).toMatchObject({ status: "succeeded", targetId: "target_1" });
	});

	it("fails closed through the null target and records delivery_failed", () => {
		const { session, store } = setup(null);
		const result = store.project({ leaseId: "lease_001", clientRequestId: "project-1" });
		expect(result.appended).toBe(true);
		expect(result.receipt).toMatchObject({ status: "failed", reasonCode: "task_credential_target_unavailable" });
		expect(result.grant).toMatchObject({ status: "active", revision: 1 });
		assertNoSentinel(entryPayloads(session), "entries");
	});

	it("conflicts when the requested target does not match the bound target", () => {
		const { session, store } = setup();
		expectCredentialError(
			() => store.project({ leaseId: "lease_001", targetId: "target_other", clientRequestId: "project-1" }),
			"task_credential_conflict",
		);
		expect(entryPayloads(session)).toHaveLength(1);
	});

	it("rejects projection of an unknown lease", () => {
		const { store } = setup();
		expectCredentialError(
			() => store.project({ leaseId: "lease_missing", clientRequestId: "project-1" }),
			"task_credential_not_found",
		);
	});

	it("rejects projection of an expired lease", () => {
		const { store, advance } = setup();
		advance(TTL + 1_000);
		expectCredentialError(
			() => store.project({ leaseId: "lease_001", clientRequestId: "project-1" }),
			"task_lease_expired",
		);
	});

	it("fails closed when the target reports an unconfirmed outcome and records nothing", () => {
		const target = new RecordingTarget();
		target.status = "unknown";
		const { session, store } = setup(target);
		expectCredentialError(
			() => store.project({ leaseId: "lease_001", clientRequestId: "project-1" }),
			"task_credential_delivery_failed",
		);
		expect(entryPayloads(session)).toHaveLength(1);
	});

	it("replays a delivery with the persisted safe receipt", () => {
		const { session, store } = setup();
		const first = store.project({ leaseId: "lease_001", clientRequestId: "project-1" });
		const replay = store.project({ leaseId: "lease_001", clientRequestId: "project-1" });
		expect(replay.idempotent).toBe(true);
		expect(replay.appended).toBe(false);
		expect(replay.receipt).toEqual(first.receipt);
		expect(entryPayloads(session)).toHaveLength(2);
	});

	it("does not record a delivery when the target receipt is unsafe or mismatched", () => {
		const session = makeSession();
		const store = makeStore(
			session,
			createTaskCredentialTestProvider({
				materials: { package_registry: SENTINEL },
				now: () => NOW,
				target: {
					project: () => ({ token: SENTINEL }) as never,
					renew: () => ({ token: SENTINEL }) as never,
					revoke: () => ({ token: SENTINEL }) as never,
					getCapabilities: () => ({ token: SENTINEL }) as never,
				},
			}),
		);
		store.issue(issueRequest());
		expectCredentialError(
			() => store.project({ leaseId: "lease_001", clientRequestId: "project-1" }),
			"task_credential_delivery_failed",
		);
		expect(entryPayloads(session)).toHaveLength(1);
	});
});

describe("store revoke", () => {
	function setup(revokeOutcome?: "revoked" | "revocation_unknown") {
		const session = makeSession();
		const recorded = recordingProvider(makeProvider(revokeOutcome === undefined ? {} : { revokeOutcome }));
		const store = makeStore(session, recorded.provider, { now: () => NOW });
		store.issue(issueRequest());
		return { session, recorded, store };
	}

	it("revokes the lease and records a revoked terminal state", () => {
		const { session, recorded, store } = setup();
		const result = store.revoke({ leaseId: "lease_001", reasonCode: "task_completed", clientRequestId: "revoke-1" });
		expect(result.appended).toBe(true);
		expect(recorded.calls).toEqual(["issue", "revoke"]);
		expect(result.receipt).toMatchObject({ status: "revoked", reasonCode: "task_completed" });
		expect(result.grant).toMatchObject({ status: "revoked", revision: 1, heartbeatSequence: 0, reasonCode: "task_completed" });
		const persisted = parseTaskCredentialTransition(entryPayloads(session)[1]);
		expect(persisted?.reasonCode).toBe("task_completed");
		expect(persisted?.action).toBe("revoked");
		expect(store.warnings()).toEqual([]);
	});

	it("records revocation_unknown when the issuer cannot confirm", () => {
		const { store } = setup("revocation_unknown");
		const result = store.revoke({ leaseId: "lease_001", clientRequestId: "revoke-1" });
		expect(result.receipt).toMatchObject({ status: "revocation_unknown" });
		expect(result.grant.status).toBe("revocation_unknown");
	});

	it("fails closed on a thrown sensitive provider failure and appends revocation_unknown without raw data", () => {
		const session = makeSession();
		const provider = makeProvider();
		const store = makeStore(session, {
			issuer: {
				issue: (request) => provider.issuer.issue(request),
				renew: (request) => provider.issuer.renew(request),
				revoke: () => {
					throw new Error(`issuer exploded: ${SENTINEL}`);
				},
			},
			target: provider.target,
		});
		store.issue(issueRequest());
		const result = store.revoke({ leaseId: "lease_001", clientRequestId: "revoke-1" });
		expect(result.appended).toBe(true);
		expect(result.receipt).toMatchObject({ status: "revocation_unknown", leaseId: "lease_001" });
		expect(result.receipt).not.toHaveProperty("reasonCode");
		expect(result.grant.status).toBe("revocation_unknown");
		assertNoSentinel(result.receipt, "receipt");
		assertNoSentinel(result.grant, "grant");
		assertNoSentinel(entryPayloads(session), "entries");
		assertNoSentinel(store.warnings(), "warnings");
		expect(store.warnings()).toEqual([]);
	});

	it("fails closed on a timeout-like provider outage instead of throwing", () => {
		const session = makeSession();
		const provider = makeProvider();
		const store = makeStore(session, {
			issuer: {
				issue: (request) => provider.issuer.issue(request),
				renew: (request) => provider.issuer.renew(request),
				revoke: () => {
					throw new TaskCredentialError("task_credential_provider_unavailable");
				},
			},
			target: provider.target,
		});
		store.issue(issueRequest());
		const result = store.revoke({ leaseId: "lease_001", clientRequestId: "revoke-1" });
		expect(result.appended).toBe(true);
		expect(result.receipt).toMatchObject({ status: "revocation_unknown" });
		expect(entryPayloads(session)).toHaveLength(2);
	});

	it("fails closed on malformed, unsafe, or mismatched revoke receipts", () => {
		for (const [label, raw] of [
			["unsafe", { token: SENTINEL } as never],
			["malformed", "garbage" as never],
			["mismatched", {
				schemaVersion: TASK_CREDENTIAL_SCHEMA_VERSION,
				leaseId: "lease_other",
				grantId: "grant_other",
				bindingId: "binding_other",
				status: "revoked",
				recordedAt: NOW,
			} as never],
			["wrong status", {
				schemaVersion: TASK_CREDENTIAL_SCHEMA_VERSION,
				leaseId: "lease_001",
				grantId: "grant_001",
				bindingId: "binding_001",
				status: "renewed",
				recordedAt: NOW,
			} as never],
		] as Array<[string, unknown]>) {
			const session = makeSession();
			const provider = makeProvider();
			const store = makeStore(session, {
				issuer: {
					issue: (request) => provider.issuer.issue(request),
					renew: (request) => provider.issuer.renew(request),
					revoke: () => raw as TaskCredentialProviderReceipt,
				},
				target: provider.target,
			});
			store.issue(issueRequest());
			const result = store.revoke({ leaseId: "lease_001", clientRequestId: "revoke-1" });
			expect(result.appended, label).toBe(true);
			expect(result.receipt, label).toMatchObject({ status: "revocation_unknown" });
			assertNoSentinel(entryPayloads(session), `entries (${label})`);
			assertNoSentinel(result.receipt, `receipt (${label})`);
		}
	});

	it("replays a revoke and rejects a second revoke", () => {
		const { session, store } = setup();
		store.revoke({ leaseId: "lease_001", clientRequestId: "revoke-1" });
		const replay = store.revoke({ leaseId: "lease_001", clientRequestId: "revoke-1" });
		expect(replay.idempotent).toBe(true);
		expect(replay.appended).toBe(false);
		expectCredentialError(
			() => store.revoke({ leaseId: "lease_001", clientRequestId: "revoke-2" }),
			"task_credential_conflict",
		);
		expect(entryPayloads(session)).toHaveLength(2);
	});

	it("rejects revoke of an unknown lease", () => {
		const { store } = setup();
		expectCredentialError(
			() => store.revoke({ leaseId: "lease_missing", clientRequestId: "revoke-1" }),
			"task_credential_not_found",
		);
	});

	it("rejects a confirmation flag that is not exactly true", () => {
		const { session, store } = setup();
		expectCredentialError(
			() =>
				store.revoke({
					leaseId: "lease_001",
					clientRequestId: "revoke-1",
					providerConfirmedRevoke: false,
				} as TaskCredentialStoreRevokeRequest),
			"task_credential_invalid",
		);
		expect(entryPayloads(session)).toHaveLength(1);
	});

	it("reconciles a confirmed retry from revocation_unknown to revoked and keeps unknown quarantined", () => {
		const session = makeSession();
		let revokes = 0;
		const provider = makeProvider();
		const store = makeStore(session, {
			issuer: {
				issue: (request) => provider.issuer.issue(request),
				renew: (request) => provider.issuer.renew(request),
				revoke: () => {
					revokes += 1;
					if (revokes === 1) throw new Error(`revoke failed: ${SENTINEL}`);
					return {
						schemaVersion: TASK_CREDENTIAL_SCHEMA_VERSION,
						leaseId: "lease_001",
						grantId: "grant_001",
						bindingId: "binding_001",
						status: "revoked",
						recordedAt: NOW,
					};
				},
			},
			target: provider.target,
		});
		store.issue(issueRequest());
		const unknown = store.revoke({ leaseId: "lease_001", clientRequestId: "revoke-1" });
		expect(unknown.grant.status).toBe("revocation_unknown");
		expect(unknown.receipt).toMatchObject({ status: "revocation_unknown" });
		// Unknown is quarantined: no settle, no plain revoke, no delivery.
		expectCredentialError(
			() => store.settle({ leaseId: "lease_001", clientRequestId: "settle-1" }),
			"task_credential_conflict",
		);
		expectCredentialError(
			() => store.revoke({ leaseId: "lease_001", clientRequestId: "revoke-2" }),
			"task_credential_conflict",
		);
		expectCredentialError(
			() => store.project({ leaseId: "lease_001", clientRequestId: "project-1" }),
			"task_credential_conflict",
		);
		// A confirmed retry reconciles to revoked.
		const confirmed = store.revoke({
			leaseId: "lease_001",
			clientRequestId: "revoke-2",
			providerConfirmedRevoke: true,
		});
		expect(confirmed.appended).toBe(true);
		expect(confirmed.receipt).toMatchObject({ status: "revoked" });
		expect(confirmed.grant.status).toBe("revoked");
		expect(store.warnings()).toEqual([]);
		// Reconcile is legal only from revocation_unknown.
		expectCredentialError(
			() => store.revoke({ leaseId: "lease_001", clientRequestId: "revoke-3", providerConfirmedRevoke: true }),
			"task_credential_conflict",
		);
	});

	it("keeps revocation_unknown quarantined when the confirmed retry also fails and appends nothing", () => {
		const session = makeSession();
		const provider = makeProvider();
		const store = makeStore(session, {
			issuer: {
				issue: (request) => provider.issuer.issue(request),
				renew: (request) => provider.issuer.renew(request),
				revoke: () => {
					throw new Error("issuer still down");
				},
			},
			target: provider.target,
		});
		store.issue(issueRequest());
		store.revoke({ leaseId: "lease_001", clientRequestId: "revoke-1" });
		expectCredentialError(
			() => store.revoke({ leaseId: "lease_001", clientRequestId: "revoke-2", providerConfirmedRevoke: true }),
			"task_credential_revocation_unknown",
		);
		expect(store.get("lease_001")?.status).toBe("revocation_unknown");
		expect(entryPayloads(session)).toHaveLength(2);
	});
});

describe("store settle", () => {
	function setup() {
		const session = makeSession();
		const recorded = recordingProvider(makeProvider());
		let clock = NOW_MS + 1_000;
		const store = makeStore(session, recorded.provider, { now: () => new Date(clock).toISOString() });
		store.issue(issueRequest());
		clock += 1_000;
		store.project({ leaseId: "lease_001", clientRequestId: "project-1" });
		clock += 1_000;
		store.revoke({ leaseId: "lease_001", clientRequestId: "revoke-1" });
		return { session, recorded, store };
	}

	it("settles the lease locally with a safe receipt and never calls the provider", () => {
		const { session, recorded, store } = setup();
		expect(recorded.calls).toEqual(["issue", "project", "revoke"]);
		const result = store.settle({ leaseId: "lease_001", reasonCode: "task_done", clientRequestId: "settle-1" });
		expect(result.appended).toBe(true);
		expect(recorded.calls).toEqual(["issue", "project", "revoke"]);
		expect(result.receipt).toMatchObject({ status: "settled" });
		expect(result.receipt).not.toHaveProperty("reasonCode");
		expect(result.grant).toMatchObject({ status: "settled", revision: 3, reasonCode: "task_done" });
		const persisted = parseTaskCredentialTransition(entryPayloads(session)[3]);
		expect(persisted?.action).toBe("settled");
		expect(persisted?.reasonCode).toBe("task_done");
	});

	it("replays a settle and rejects settle after revoke without delivery", () => {
		const { session, store } = setup();
		store.settle({ leaseId: "lease_001", clientRequestId: "settle-1" });
		const replay = store.settle({ leaseId: "lease_001", clientRequestId: "settle-1" });
		expect(replay.idempotent).toBe(true);
		expect(entryPayloads(session)).toHaveLength(4);
		// Revoke without a folded delivery receipt never settles.
		const second = makeSession();
		const secondStore = makeStore(second, makeProvider());
		secondStore.issue(issueRequest());
		secondStore.revoke({ leaseId: "lease_001", clientRequestId: "revoke-1" });
		expect(secondStore.get("lease_001")?.status).toBe("revoked");
		expectCredentialError(
			() => secondStore.settle({ leaseId: "lease_001", clientRequestId: "settle-1" }),
			"task_credential_conflict",
		);
		expect(entryPayloads(second)).toHaveLength(2);
	});

	it("rejects early settle before delivery, before revoke, and from revocation_unknown", () => {
		// Right after issue: active, no delivery receipt.
		const session = makeSession();
		const store = makeStore(session, makeProvider());
		store.issue(issueRequest());
		expectCredentialError(
			() => store.settle({ leaseId: "lease_001", clientRequestId: "settle-1" }),
			"task_credential_conflict",
		);
		// Delivered but still active: delivery alone must not settle.
		store.project({ leaseId: "lease_001", clientRequestId: "project-1" });
		expectCredentialError(
			() => store.settle({ leaseId: "lease_001", clientRequestId: "settle-2" }),
			"task_credential_conflict",
		);
		expect(entryPayloads(session)).toHaveLength(2);
		// Delivered but revoke unconfirmed: revocation_unknown never settles.
		const unknownSession = makeSession();
		const unknownStore = makeStore(unknownSession, makeProvider({ revokeOutcome: "revocation_unknown" }));
		unknownStore.issue(issueRequest());
		unknownStore.project({ leaseId: "lease_001", clientRequestId: "project-1" });
		unknownStore.revoke({ leaseId: "lease_001", clientRequestId: "revoke-1" });
		expect(unknownStore.get("lease_001")?.status).toBe("revocation_unknown");
		expectCredentialError(
			() => unknownStore.settle({ leaseId: "lease_001", clientRequestId: "settle-1" }),
			"task_credential_conflict",
		);
		expect(entryPayloads(unknownSession)).toHaveLength(3);
	});

	it("rejects settle of an unknown lease", () => {
		const { store } = setup();
		expectCredentialError(
			() => store.settle({ leaseId: "lease_missing", clientRequestId: "settle-1" }),
			"task_credential_not_found",
		);
	});

	it("enforces delivery-before-revoke-before-settle ordering", () => {
		// Revoke first: delivery and settle become impossible.
		const session = makeSession();
		const store = makeStore(session, makeProvider());
		store.issue(issueRequest());
		store.revoke({ leaseId: "lease_001", clientRequestId: "revoke-1" });
		expectCredentialError(
			() => store.project({ leaseId: "lease_001", clientRequestId: "project-1" }),
			"task_credential_conflict",
		);
		expectCredentialError(
			() => store.settle({ leaseId: "lease_001", clientRequestId: "settle-1" }),
			"task_credential_conflict",
		);
		// The full order issue -> delivery -> revoke -> settle succeeds.
		const ordered = makeSession();
		const orderedStore = makeStore(ordered, makeProvider());
		orderedStore.issue(issueRequest());
		orderedStore.project({ leaseId: "lease_001", clientRequestId: "project-1" });
		orderedStore.revoke({ leaseId: "lease_001", clientRequestId: "revoke-1" });
		const settled = orderedStore.settle({ leaseId: "lease_001", clientRequestId: "settle-1" });
		expect(settled.appended).toBe(true);
		expect(orderedStore.get("lease_001")?.status).toBe("settled");
	});

	it("settles a revoked lease that carries a revoke reason code", () => {
		const harness = makeSession();
		const store = makeStore(harness, makeProvider());
		store.issue(issueRequest());
		store.project({ leaseId: "lease_001", clientRequestId: "project-1" });
		store.revoke({ leaseId: "lease_001", reasonCode: "run_cancelled", clientRequestId: "revoke-1" });
		const settled = store.settle({ leaseId: "lease_001", clientRequestId: "settle-1" });
		expect(settled.grant.status).toBe("settled");
		// The revoked entry carried the reason code; the settle folded back.
		const revokedEntry = parseTaskCredentialTransition(entryPayloads(harness)[2]);
		expect(revokedEntry?.action).toBe("revoked");
		expect(revokedEntry?.reasonCode).toBe("run_cancelled");
		const settledEntry = parseTaskCredentialTransition(entryPayloads(harness)[3]);
		expect(settledEntry?.action).toBe("settled");
		expect(settledEntry?.grant.status).toBe("settled");
	});
});

describe("store reload", () => {
	it("recovers grant facts from entries without restoring material or renewing", () => {
		const session = makeSession();
		const provider = makeProvider();
		const store = makeStore(session, provider);
		store.issue(issueRequest());
		const before = store.get("lease_001")!;

		const recorded = recordingProvider(provider);
		const restarted = makeStore(session, recorded.provider);
		const after = restarted.get("lease_001")!;
		expect(after).toEqual(before);
		expect(after.status).toBe("active");
		expect(after.expiresAt).toBe(before.expiresAt);
		expect(after.heartbeatSequence).toBe(0);
		// Reload never touches the provider and never restores material.
		expect(recorded.calls).toEqual([]);
		assertNoSentinel(restarted.list(), "projection");
		assertNoSentinel(restarted.warnings(), "warnings");
		expect(restarted.warnings()).toEqual([]);
	});

	it("survives a restart mid-lifecycle with full idempotent replay", () => {
		const session = makeSession();
		const provider = makeProvider();
		let clock = NOW_MS;
		const first = makeStore(session, provider, { now: () => new Date(clock).toISOString() });
		first.issue(issueRequest());
		clock += 1_000;
		first.renew({ leaseId: "lease_001", heartbeatSequence: 1, requestedTtlMs: TTL, ttlBounds: makeBounds(), clientRequestId: "renew-1" });
		clock += 1_000;
		first.project({ leaseId: "lease_001", clientRequestId: "project-1" });
		const before = first.get("lease_001")!;

		const restarted = makeStore(session, provider, { now: () => new Date(clock).toISOString() });
		expect(restarted.get("lease_001")).toEqual(before);
		const replay = restarted.renew({ leaseId: "lease_001", heartbeatSequence: 1, requestedTtlMs: TTL, ttlBounds: makeBounds(), clientRequestId: "renew-1" });
		expect(replay.idempotent).toBe(true);
		expect(replay.appended).toBe(false);
		expect(restarted.warnings()).toEqual([]);
	});

	it("tolerates a Session whose getSessionId disagrees with written entries", () => {
		const session = makeSession();
		const store = makeStore(session, makeProvider());
		store.issue(issueRequest());
		const folded = foldTaskCredentialEntries(session.getEntries(), "some-other-session");
		expect(folded.warnings.map((warning) => warning.code)).toEqual(["session_mismatch"]);
		expect(folded.grants).toEqual([]);
	});

	it("preserves delivery, revoke, and settle receipts across reload with idempotent replay", () => {
		const session = makeSession();
		const provider = makeProvider({ target: new RecordingTarget() });
		let clock = NOW_MS;
		const first = makeStore(session, provider, { now: () => new Date(clock).toISOString() });
		first.issue(issueRequest());
		clock += 1_000;
		first.project({ leaseId: "lease_001", clientRequestId: "project-1" });
		clock += 1_000;
		first.revoke({ leaseId: "lease_001", clientRequestId: "revoke-1" });
		clock += 1_000;
		first.settle({ leaseId: "lease_001", clientRequestId: "settle-1" });

		const recorded = recordingProvider(provider);
		const restarted = makeStore(session, recorded.provider, { now: () => new Date(clock).toISOString() });
		// Reload, get, and list never touch the provider.
		expect(recorded.calls).toEqual([]);
		expect(restarted.get("lease_001")?.status).toBe("settled");
		const replayDelivery = restarted.project({ leaseId: "lease_001", clientRequestId: "project-1" });
		expect(replayDelivery.idempotent).toBe(true);
		expect(replayDelivery.appended).toBe(false);
		expect(replayDelivery.receipt).toMatchObject({ status: "succeeded" });
		const replayRevoke = restarted.revoke({ leaseId: "lease_001", clientRequestId: "revoke-1" });
		expect(replayRevoke.idempotent).toBe(true);
		expect(replayRevoke.receipt).toMatchObject({ status: "revoked" });
		const replaySettle = restarted.settle({ leaseId: "lease_001", clientRequestId: "settle-1" });
		expect(replaySettle.idempotent).toBe(true);
		expect(replaySettle.receipt).toMatchObject({ status: "settled" });
		expect(recorded.calls).toEqual([]);
		assertNoSentinel(entryPayloads(session), "entries");
		expect(restarted.warnings()).toEqual([]);
	});

	it("reloads a fail-closed revocation_unknown, keeps it quarantined, and reconciles with a confirmed retry", () => {
		const session = makeSession();
		const inner = makeProvider();
		let revokes = 0;
		const provider: TaskCredentialProvider = {
			issuer: {
				issue: (request) => inner.issuer.issue(request),
				renew: (request) => inner.issuer.renew(request),
				revoke: () => {
					revokes += 1;
					if (revokes === 1) throw new Error(`timeout ${SENTINEL}`);
					return {
						schemaVersion: TASK_CREDENTIAL_SCHEMA_VERSION,
						leaseId: "lease_001",
						grantId: "grant_001",
						bindingId: "binding_001",
						status: "revoked",
						recordedAt: NOW,
					};
				},
			},
			target: inner.target,
		};
		const store = makeStore(session, provider);
		store.issue(issueRequest());
		const unknown = store.revoke({ leaseId: "lease_001", clientRequestId: "revoke-1" });
		expect(unknown.grant.status).toBe("revocation_unknown");

		const restarted = makeStore(session, provider);
		expect(restarted.get("lease_001")?.status).toBe("revocation_unknown");
		expectCredentialError(
			() => restarted.settle({ leaseId: "lease_001", clientRequestId: "settle-1" }),
			"task_credential_conflict",
		);
		// The failed revoke replays its safe unknown receipt without re-calling
		// the provider.
		const replay = restarted.revoke({ leaseId: "lease_001", clientRequestId: "revoke-1" });
		expect(replay.idempotent).toBe(true);
		expect(replay.receipt).toMatchObject({ status: "revocation_unknown" });
		expect(revokes).toBe(1);
		const confirmed = restarted.revoke({
			leaseId: "lease_001",
			clientRequestId: "revoke-2",
			providerConfirmedRevoke: true,
		});
		expect(confirmed.appended).toBe(true);
		expect(confirmed.receipt).toMatchObject({ status: "revoked" });
		expect(confirmed.grant.status).toBe("revoked");
		expect(revokes).toBe(2);
		expect(restarted.warnings()).toEqual([]);
	});
});

function sessionWithIssue(overrides: Partial<TaskCredentialStoreIssueRequest> = {}): SessionManager {
	const session = makeSession();
	const store = makeStore(session, makeProvider());
	store.issue(issueRequest(overrides));
	return session;
}

describe("store fold", () => {
	function foldWarnings(session: SessionManager): readonly TaskCredentialWarning[] {
		return foldTaskCredentialEntries(session.getEntries(), session.getSessionId()).warnings;
	}

	it("skips malformed, unsupported, and material-smuggling entries without surfacing raw data", () => {
		const session = sessionWithIssue();
		const goodGrant = parseTaskCredentialTransition(entryPayloads(session)[0])!.grant;
		session.appendCustomEntry(TASK_CREDENTIAL_CUSTOM_TYPE, "raw garbage");
		session.appendCustomEntry(TASK_CREDENTIAL_CUSTOM_TYPE, { schemaVersion: 2, action: "issued" });
		session.appendCustomEntry(TASK_CREDENTIAL_CUSTOM_TYPE, {
			schemaVersion: TASK_CREDENTIAL_SCHEMA_VERSION,
			action: "issued",
			token: SENTINEL,
		});
		session.appendCustomEntry(TASK_CREDENTIAL_CUSTOM_TYPE, {
			schemaVersion: TASK_CREDENTIAL_SCHEMA_VERSION,
			action: "issued",
			leaseId: "lease_bad",
			grantId: "grant_bad",
			bindingId: "binding_bad",
			sessionId: session.getSessionId(),
			previousRevision: 0,
			clientRequestId: "bad-1",
			recordedAt: NOW,
			grant: { ...goodGrant, leaseId: "lease_bad", grantId: "grant_bad" },
			binding: makeBinding({ bindingId: "binding_bad" }),
		});
		const warnings = foldWarnings(session);
		expect(warnings.map((warning) => warning.code)).toEqual([
			"malformed_source",
			"unsupported_schema",
			"malformed_source",
			"malformed_source",
		]);
		assertNoSentinel(warnings, "warnings");
		expect(foldTaskCredentialEntries(session.getEntries(), session.getSessionId()).grants).toHaveLength(1);
	});

	it("skips gapped, illegal, and conflicted transitions with safe warnings", () => {
		const session = makeSession();
		const store = makeStore(session, makeProvider());
		store.issue(issueRequest());
		settleLease(store, "lease_001", "lease-1");
		// Renew after settle is illegal; renew without a prior grant is gapped.
		store.issue(issueRequest({ leaseId: "lease_002", grantId: "grant_002", clientRequestId: "issue-2" }));
		const warnings = foldWarnings(session);
		expect(warnings).toEqual([]);
		const folded = foldTaskCredentialEntries(session.getEntries(), session.getSessionId());
		expect(folded.byLeaseId.get("lease_001")?.status).toBe("settled");
		expect(folded.byLeaseId.get("lease_002")?.status).toBe("active");
	});

	it("emits lease, grant, and binding conflicts for duplicate issued entries", () => {
		const session = sessionWithIssue();
		const issued = parseTaskCredentialTransition(entryPayloads(session)[0])!;
		session.appendCustomEntry(TASK_CREDENTIAL_CUSTOM_TYPE, { ...serializeTaskCredentialTransition(issued), clientRequestId: "issue-dup-lease" });
		session.appendCustomEntry(
			TASK_CREDENTIAL_CUSTOM_TYPE,
			{ ...serializeTaskCredentialTransition(issued), leaseId: "lease_other", clientRequestId: "issue-dup-grant", grant: { ...issued.grant, leaseId: "lease_other" } },
		);
		session.appendCustomEntry(
			TASK_CREDENTIAL_CUSTOM_TYPE,
			{
				...serializeTaskCredentialTransition(issued),
				leaseId: "lease_third",
				grantId: "grant_third",
				clientRequestId: "issue-dup-binding",
				grant: { ...issued.grant, leaseId: "lease_third", grantId: "grant_third" },
			},
		);
		const warnings = foldWarnings(session);
		expect(warnings.map((warning) => warning.code)).toEqual(["lease_conflict", "grant_conflict", "binding_conflict"]);
		assertNoSentinel(warnings, "warnings");
	});

	it("emits idempotency conflicts for the same key with a different payload and silently skips replays", () => {
		const session = sessionWithIssue();
		const issued = parseTaskCredentialTransition(entryPayloads(session)[0])!;
		session.appendCustomEntry(TASK_CREDENTIAL_CUSTOM_TYPE, serializeTaskCredentialTransition(issued));
		session.appendCustomEntry(
			TASK_CREDENTIAL_CUSTOM_TYPE,
			{
				...serializeTaskCredentialTransition(issued),
				leaseId: "lease_other",
				grantId: "grant_other",
				grant: { ...issued.grant, leaseId: "lease_other", grantId: "grant_other" },
			},
		);
		const folded = foldTaskCredentialEntries(session.getEntries(), session.getSessionId());
		expect(folded.warnings.map((warning) => warning.code)).toEqual(["idempotency_conflict"]);
		expect(folded.grants).toHaveLength(1);
	});

	it("exposes folded delivery receipts per lease through safe allowlisted fields", () => {
		const session = makeSession();
		const store = makeStore(session, makeProvider({ target: new RecordingTarget() }));
		store.issue(issueRequest());
		const before = foldTaskCredentialEntries(session.getEntries(), session.getSessionId());
		expect(before.deliveryByLeaseId.has("lease_001")).toBe(false);
		store.project({ leaseId: "lease_001", clientRequestId: "project-1" });
		const folded = foldTaskCredentialEntries(session.getEntries(), session.getSessionId());
		const receipt = folded.deliveryByLeaseId.get("lease_001");
		expect(receipt).toMatchObject({ status: "succeeded", leaseId: "lease_001", grantId: "grant_001" });
		expect(receipt).not.toHaveProperty("clientRequestId");
		assertNoSentinel(folded.deliveryByLeaseId, "deliveryByLeaseId");
	});

	it("emits revision gaps and illegal transitions for broken follow-ups", () => {
		const session = makeSession();
		let clock = NOW_MS;
		const store = makeStore(session, makeProvider(), { now: () => new Date(clock).toISOString() });
		store.issue(issueRequest());
		clock += 1_000;
		store.renew({ leaseId: "lease_001", heartbeatSequence: 1, requestedTtlMs: TTL, ttlBounds: makeBounds(), clientRequestId: "renew-1" });
		const entries = entryPayloads(session);
		const firstRenew = parseTaskCredentialTransition(entries[1])!;
		// Replay the same renewed snapshot under a new key: heartbeat is not +1.
		session.appendCustomEntry(
			TASK_CREDENTIAL_CUSTOM_TYPE,
			{ ...serializeTaskCredentialTransition(firstRenew), clientRequestId: "renew-dup", previousRevision: 1 },
		);
		// A follow-up with a stale previousRevision.
		session.appendCustomEntry(
			TASK_CREDENTIAL_CUSTOM_TYPE,
			{ ...serializeTaskCredentialTransition(firstRenew), grantId: "grant_001", clientRequestId: "renew-gap", previousRevision: 99 },
		);
		// Renew an unknown lease.
		session.appendCustomEntry(
			TASK_CREDENTIAL_CUSTOM_TYPE,
			{
				...serializeTaskCredentialTransition(firstRenew),
				leaseId: "lease_ghost",
				bindingId: "binding_ghost",
				clientRequestId: "renew-ghost",
				grant: { ...firstRenew.grant, leaseId: "lease_ghost", bindingId: "binding_ghost" },
			},
		);
		const warnings = foldWarnings(session);
		expect(warnings.map((warning) => warning.code)).toEqual(["illegal_transition", "revision_gap", "revision_gap"]);
		assertNoSentinel(warnings, "warnings");
		expect(store.get("lease_001")?.status).toBe("active");
	});

	it("exposes warnings through refresh and the diagnostics sink exactly once", () => {
		const session = sessionWithIssue();
		const seen: TaskCredentialWarning[] = [];
		const store = makeStore(session, makeProvider(), { diagnostics: (warning) => seen.push(warning) });
		session.appendCustomEntry(TASK_CREDENTIAL_CUSTOM_TYPE, "raw garbage");
		store.refresh();
		store.refresh();
		expect(seen).toHaveLength(1);
		expect(seen[0]!.code).toBe("malformed_source");
		assertNoSentinel(seen, "diagnostics");
	});
});

describe("store persistence failures", () => {
	it("keeps the old projection and reports persistence_failed when append throws", () => {
		const inner = makeSession();
		const session: TaskCredentialSession = {
			getSessionId: () => inner.getSessionId(),
			getEntries: () => inner.getEntries(),
			appendCustomEntry: () => {
				throw new Error("disk full");
			},
		};
		const store = makeStore(session, makeProvider());
		expectCredentialError(() => store.issue(issueRequest()), "task_credential_persistence_failed");
		expect(store.get("lease_001")).toBeUndefined();
		expect(store.list()).toEqual([]);
		expect(store.warnings()).toEqual([]);
	});

	it("keeps the old projection when a later append fails after a successful issue", () => {
		const inner = makeSession();
		let clock = NOW_MS;
		const provider = makeProvider();
		const seeded = makeStore(inner, provider, { now: () => new Date(clock).toISOString() });
		seeded.issue(issueRequest());
		clock += 1_000;
		const before = seeded.get("lease_001")!;
		let failing = false;
		const session: TaskCredentialSession = {
			getSessionId: () => inner.getSessionId(),
			getEntries: () => inner.getEntries(),
			appendCustomEntry: (customType: string, data?: unknown) => {
				if (failing) throw new Error("disk full");
				return inner.appendCustomEntry(customType, data);
			},
		};
		failing = true;
		const store = makeStore(session, provider, { now: () => new Date(clock).toISOString() });
		expectCredentialError(
			() => store.renew({ leaseId: "lease_001", heartbeatSequence: 1, requestedTtlMs: TTL, ttlBounds: makeBounds(), clientRequestId: "renew-1" }),
			"task_credential_persistence_failed",
		);
		expect(store.get("lease_001")).toEqual(before);
		expect(store.warnings()).toEqual([]);
	});

	it("does not acknowledge an append that is not visible in durable entries", () => {
		const inner = makeSession();
		const session: TaskCredentialSession = {
			getSessionId: () => inner.getSessionId(),
			getEntries: () => inner.getEntries(),
			appendCustomEntry: () => "entry-not-visible",
		};
		const store = makeStore(session, makeProvider());
		expectCredentialError(() => store.issue(issueRequest()), "task_credential_persistence_failed");
		expect(inner.getEntries()).toHaveLength(0);
	});

	it("does not acknowledge an issue when a concurrent writer claims the lease first", () => {
		const inner = makeSession();
		const sessionId = inner.getSessionId();
		let raced = false;
		const session: TaskCredentialSession = {
			getSessionId: () => sessionId,
			getEntries: () => inner.getEntries(),
			appendCustomEntry: (customType: string, data?: unknown) => {
				if (raced) return inner.appendCustomEntry(customType, data);
				raced = true;
				const winner = makeStore(inner, makeProvider());
				winner.issue(issueRequest({ clientRequestId: "issue-winner" }));
				return inner.appendCustomEntry(customType, data);
			},
		};
		const store = makeStore(session, makeProvider());
		expectCredentialError(() => store.issue(issueRequest()), "task_credential_persistence_failed");
		expect(store.list()).toHaveLength(1);
		expect(store.list()[0]).toMatchObject({ leaseId: "lease_001" });
	});
});

describe("store read validation", () => {
	it("rejects malformed read identifiers", () => {
		const store = makeStore(makeSession(), makeProvider());
		expectCredentialError(() => store.get("lease/../x"), "task_credential_invalid");
		expectCredentialError(() => store.getByGrantId(""), "task_credential_invalid");
		expectCredentialError(() => store.getByBindingId("binding@evil"), "task_credential_invalid");
	});

	it("keeps operations isolated per clientRequestId across operations", () => {
		const session = makeSession();
		let clock = NOW_MS;
		const store = makeStore(session, makeProvider(), { now: () => new Date(clock).toISOString() });
		store.issue(issueRequest({ clientRequestId: "shared-id" }));
		clock += 1_000;
		const renewed = store.renew({ leaseId: "lease_001", heartbeatSequence: 1, requestedTtlMs: TTL, ttlBounds: makeBounds(), clientRequestId: "shared-id" });
		expect(renewed.appended).toBe(true);
		expect(entryPayloads(session)).toHaveLength(2);
	});
});

describe("store transition surface", () => {
	it("round-trips persisted transitions and rejects unknown keys", () => {
		const session = makeSession();
		const store = makeStore(session, makeProvider());
		store.issue(issueRequest());
		const payload = entryPayloads(session)[0];
		const parsed = parseTaskCredentialTransition(payload);
		expect(parsed).toBeDefined();
		expect(isTaskCredentialTransition(payload)).toBe(true);
		expect(isTaskCredentialTransition({ ...(payload as object), token: SENTINEL })).toBe(false);
		expect(parseTaskCredentialTransition({ ...(payload as object), grant: { ...(parsed!.grant), scopeDigest: "sha256:xyz" } })).toBeUndefined();
		expect(JSON.stringify(parsed)).not.toContain(SENTINEL);
	});

	it("derives canonical issue payloads deterministically from the request and the persisted snapshot", () => {
		const session = makeSession();
		const store = makeStore(session, makeProvider());
		const request = issueRequest();
		const result = store.issue(request);
		const fromRequest = canonicalTaskCredentialIssuePayload(
			{ ...request.binding, sandboxBindingId: "sandbox_1" },
			result.grant,
			request.leaseId,
			request.grantId,
		);
		const transition = parseTaskCredentialTransition(entryPayloads(session)[0])!;
		const fromSnapshot = canonicalTaskCredentialIssuePayload(transition.binding!, transition.grant, transition.leaseId, transition.grantId);
		expect(fromSnapshot).toBe(fromRequest);
		expect(fromSnapshot).not.toContain(SENTINEL);
	});

	it("exposes the frozen warning kind alias on every warning", () => {
		const session = sessionWithIssue();
		session.appendCustomEntry(TASK_CREDENTIAL_CUSTOM_TYPE, "raw garbage");
		const store = makeStore(session, makeProvider());
		const warning = store.warnings()[0]!;
		expect(warning.code).toBe(warning.kind);
		expect(warning.entryId).toBeDefined();
	});

	it("lists grants in issue order with terminal states preserved", () => {
		const session = makeSession();
		const store = makeStore(session, makeProvider());
		store.issue(issueRequest());
		settleLease(store, "lease_001", "lease-1");
		store.issue(issueRequest({ leaseId: "lease_002", grantId: "grant_002", clientRequestId: "issue-2" }));
		const grants = store.list();
		expect(grants.map((grant) => grant.leaseId)).toEqual(["lease_001", "lease_002"]);
		expect(grants[0]?.status).toBe("settled");
		expect(grants[1]?.status).toBe("active");
	});

	it("keeps delivery receipts out of the public grant projection", () => {
		const session = makeSession();
		const store = makeStore(session, makeProvider());
		store.issue(issueRequest());
		store.project({ leaseId: "lease_001", clientRequestId: "project-1" });
		const grant = store.get("lease_001")!;
		expect(grant).not.toHaveProperty("deliveryReceipt");
		expect(grant).not.toHaveProperty("clientRequestId");
		assertNoSentinel(grant, "grant");
	});
});
