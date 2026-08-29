import { describe, expect, it } from "vitest";
import {
	TASK_CREDENTIAL_ACTION,
	TASK_CREDENTIAL_DELIVERY_STATUS,
	TASK_CREDENTIAL_ERROR_CODES,
	TASK_CREDENTIAL_MAX_OPERATIONS,
	TASK_CREDENTIAL_MAX_SCOPES,
	TASK_CREDENTIAL_MAX_TARGET_KINDS,
	TASK_CREDENTIAL_MAX_TTL_MS,
	TASK_CREDENTIAL_MIN_TTL_MS,
	TASK_CREDENTIAL_RENEWAL_WINDOW_MS,
	TASK_CREDENTIAL_REASON_CODE_MAX_LENGTH,
	TASK_CREDENTIAL_SCOPE_FIELD_MAX_LENGTH,
	TASK_CREDENTIAL_SCOPE_ITEM_MAX_LENGTH,
	TASK_CREDENTIAL_STATUS,
	TaskCredentialError,
	calculateBoundedTtl,
	calculateScopeDigest,
	canHeartbeatTaskLease,
	canReconcileTaskLease,
	canRenewTaskLease,
	canRevokeTaskLease,
	canSettleTaskLease,
	isLegalTaskCredentialTransition,
	isTaskCredentialDeliveryReceipt,
	isTaskCredentialGrant,
	isTaskExecutionBinding,
	issueTaskCredentialGrant,
	normalizeTaskCredentialScopes,
	parseTaskCredentialDeliveryReceipt,
	parseTaskCredentialGrant,
	parseTaskExecutionBinding,
	serializeTaskCredentialDeliveryReceipt,
	serializeTaskCredentialGrant,
	transitionTaskCredentialStatus,
	validateTaskExecutionBinding,
	type TaskCredentialAction,
	type TaskCredentialDeliveryReceipt,
	type TaskCredentialErrorCode,
	type TaskCredentialGrant,
	type TaskCredentialIssueRequest,
	type TaskCredentialScope,
	type TaskCredentialTransitionOptions,
	type TaskCredentialTtlBounds,
	type TaskExecutionBinding,
} from "../src/core/policy/task-credential-lease.ts";

const NOW = Date.parse("2026-08-16T10:00:00.000Z");
const TTL = 60_000;

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
		createdAt: "2026-08-16T09:59:00.000Z",
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

function issue(overrides: Partial<TaskCredentialIssueRequest> = {}): TaskCredentialGrant {
	return issueTaskCredentialGrant(
		{
			grantId: "grant_001",
			leaseId: "lease_001",
			binding: makeBinding(),
			scopes: [makeScope()],
			requestedTtlMs: TTL,
			ttlBounds: makeBounds(),
			...overrides,
		},
		NOW,
	);
}

function transition(
	grant: TaskCredentialGrant,
	action: Exclude<TaskCredentialAction, "issued">,
	options: Partial<TaskCredentialTransitionOptions> = {},
): TaskCredentialGrant {
	return transitionTaskCredentialStatus(
		grant,
		action,
		{ nowMs: NOW + 1_000, ...options } as TaskCredentialTransitionOptions,
	);
}

function heartbeat(
	grant: TaskCredentialGrant,
	sequence = grant.heartbeatSequence + 1,
	nowMs = NOW + 1_000,
	ttlMs = TTL,
	ttlBounds = makeBounds(),
): TaskCredentialGrant {
	return transitionTaskCredentialStatus(grant, "renewed", { nowMs, heartbeatSequence: sequence, ttlMs, ttlBounds });
}

function expectCredentialError(fn: () => unknown, code: TaskCredentialErrorCode): void {
	try {
		fn();
	} catch (error) {
		expect(error).toBeInstanceOf(TaskCredentialError);
		expect((error as TaskCredentialError).code).toBe(code);
		return;
	}
	throw new Error(`expected TaskCredentialError with code ${code}`);
}

function grantedIso(ms: number): string {
	return new Date(ms).toISOString();
}

describe("task execution binding", () => {
	it("accepts a complete binding and round-trips it", () => {
		const binding = makeBinding();
		expect(() => validateTaskExecutionBinding(binding)).not.toThrow();
		expect(isTaskExecutionBinding(binding)).toBe(true);
		expect(parseTaskExecutionBinding(binding)).toEqual(binding);
	});

	it("accepts a binding without stage, sandbox, target, or worker", () => {
		const minimal = makeBinding({
			stageId: undefined,
			stageRevision: undefined,
			sandboxBindingId: undefined,
			targetId: undefined,
			workerId: undefined,
		});
		expect(isTaskExecutionBinding(minimal)).toBe(true);
	});

	it("rejects stageId without stageRevision and vice versa", () => {
		expectCredentialError(
			() => validateTaskExecutionBinding(makeBinding({ stageRevision: undefined })),
			"task_credential_binding_invalid",
		);
		expectCredentialError(
			() => validateTaskExecutionBinding(makeBinding({ stageId: undefined })),
			"task_credential_binding_invalid",
		);
	});

	it("rejects unsafe identifiers, non-positive revisions, and non-ISO createdAt", () => {
		expectCredentialError(
			() => validateTaskExecutionBinding(makeBinding({ sessionId: "" })),
			"task_credential_binding_invalid",
		);
		expectCredentialError(
			() => validateTaskExecutionBinding(makeBinding({ nodeId: "node/path" })),
			"task_credential_binding_invalid",
		);
		expectCredentialError(
			() => validateTaskExecutionBinding(makeBinding({ runId: "run@evil" })),
			"task_credential_binding_invalid",
		);
		expectCredentialError(
			() => validateTaskExecutionBinding(makeBinding({ graphRevision: 0 })),
			"task_credential_binding_invalid",
		);
		expectCredentialError(
			() => validateTaskExecutionBinding(makeBinding({ bindingRevision: 0 })),
			"task_credential_binding_invalid",
		);
		expectCredentialError(
			() => validateTaskExecutionBinding(makeBinding({ stageRevision: -1 })),
			"task_credential_binding_invalid",
		);
		expectCredentialError(
			() => validateTaskExecutionBinding(makeBinding({ createdAt: "2026-08-16T09:59:00Z" })),
			"task_credential_binding_invalid",
		);
		expectCredentialError(
			() => validateTaskExecutionBinding(makeBinding({ createdAt: "yesterday" })),
			"task_credential_binding_invalid",
		);
	});

	it("rejects unknown keys, wrong schema, and non-objects", () => {
		const polluted = { ...makeBinding(), prompt: "hi", token: "abc" };
		expect(isTaskExecutionBinding(polluted)).toBe(false);
		expect(isTaskExecutionBinding({ ...makeBinding(), schemaVersion: 2 })).toBe(false);
		expect(isTaskExecutionBinding(null)).toBe(false);
		expect(isTaskExecutionBinding("binding_001")).toBe(false);
		expect(isTaskExecutionBinding([])).toBe(false);
	});
});

describe("scope normalization and digest", () => {
	it("trims, drops empties, dedupes, and sorts operations and target kinds", () => {
		const normalized = normalizeTaskCredentialScopes([
			makeScope({
				credentialName: " registry ",
				purpose: "dependency_read",
				operations: ["list", "read", "", "  ", "list"],
				targetKinds: ["isolated_sandbox", "isolated_sandbox"],
			}),
		]);
		expect(normalized).toEqual([
			{
				credentialName: "registry",
				purpose: "dependency_read",
				resource: "registry.internal",
				operations: ["list", "read"],
				targetKinds: ["isolated_sandbox"],
			},
		]);
	});

	it("dedupes identical scopes and sorts the scope list canonically", () => {
		const a = makeScope({ credentialName: "a_registry", operations: ["list", "read"] });
		const b = makeScope({ credentialName: "b_registry", operations: ["list", "read"] });
		expect(normalizeTaskCredentialScopes([b, a, b])).toEqual([a, b]);
	});

	it("computes an order- and duplicate-invariant sha256 digest", () => {
		const digest = calculateScopeDigest([makeScope()]);
		expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
		expect(calculateScopeDigest([makeScope({ operations: ["list", "read"] }), makeScope()])).toBe(
			calculateScopeDigest([makeScope(), makeScope({ operations: ["read", "list", "read"] })]),
		);
	});

	it("produces different digests for different scopes", () => {
		expect(calculateScopeDigest([makeScope({ purpose: "dependency_read" })])).not.toBe(
			calculateScopeDigest([makeScope({ purpose: "dependency_write" })]),
		);
		expect(calculateScopeDigest([makeScope()])).not.toBe(
			calculateScopeDigest([makeScope(), makeScope({ purpose: "dependency_write" })]),
		);
	});

	it("rejects scope lists over the item count limit", () => {
		const many = Array.from({ length: TASK_CREDENTIAL_MAX_SCOPES + 1 }, (_, i) =>
			makeScope({ credentialName: `registry_${i}` }),
		);
		expectCredentialError(() => normalizeTaskCredentialScopes(many), "task_credential_invalid");
		expectCredentialError(() => issue({ scopes: many }), "task_credential_invalid");
	});

	it("accepts exactly the scope count limit", () => {
		const exactly = Array.from({ length: TASK_CREDENTIAL_MAX_SCOPES }, (_, i) =>
			makeScope({ credentialName: `registry_${i}` }),
		);
		expect(issue({ scopes: exactly }).scopeCount).toBe(TASK_CREDENTIAL_MAX_SCOPES);
	});

	it("rejects over-limit operations and target kinds", () => {
		const tooManyOps = makeScope({
			operations: Array.from({ length: TASK_CREDENTIAL_MAX_OPERATIONS + 1 }, (_, i) => `op_${i}`),
		});
		expectCredentialError(() => normalizeTaskCredentialScopes([tooManyOps]), "task_credential_invalid");

		const tooManyKinds = makeScope({
			targetKinds: Array.from({ length: TASK_CREDENTIAL_MAX_TARGET_KINDS + 1 }, (_, i) => `kind_${i}`),
		});
		expectCredentialError(() => normalizeTaskCredentialScopes([tooManyKinds]), "task_credential_invalid");
	});

	it("rejects over-length fields and items and invalid characters", () => {
		expectCredentialError(
			() =>
				normalizeTaskCredentialScopes([
					makeScope({ credentialName: `r${"x".repeat(TASK_CREDENTIAL_SCOPE_FIELD_MAX_LENGTH)}` }),
				]),
			"task_credential_invalid",
		);
		expectCredentialError(
			() => normalizeTaskCredentialScopes([makeScope({ operations: [`o${"x".repeat(TASK_CREDENTIAL_SCOPE_ITEM_MAX_LENGTH)}`] })]),
			"task_credential_invalid",
		);
		expectCredentialError(
			() => normalizeTaskCredentialScopes([makeScope({ credentialName: "bad name" })]),
			"task_credential_invalid",
		);
		expectCredentialError(
			() => normalizeTaskCredentialScopes([makeScope({ resource: "https://evil.example.com" })]),
			"task_credential_invalid",
		);
		expectCredentialError(
			() => normalizeTaskCredentialScopes([makeScope({ operations: ["read/scope"] })]),
			"task_credential_invalid",
		);
	});

	it("rejects missing fields, unknown keys, and non-arrays", () => {
		expectCredentialError(
			() => normalizeTaskCredentialScopes([{ purpose: "x", operations: [], targetKinds: [] } as never]),
			"task_credential_invalid",
		);
		expectCredentialError(
			() =>
				normalizeTaskCredentialScopes([
					{ ...makeScope(), secret: "abc" } as never,
				]),
			"task_credential_invalid",
		);
		expectCredentialError(() => normalizeTaskCredentialScopes(null as never), "task_credential_invalid");
		expectCredentialError(() => normalizeTaskCredentialScopes([42 as never]), "task_credential_invalid");
	});
});

describe("grant issue", () => {
	it("issues an active grant with the full contract snapshot", () => {
		const record = issue();
		expect(record).toEqual({
			schemaVersion: 1,
			grantId: "grant_001",
			leaseId: "lease_001",
			bindingId: "binding_001",
			sessionId: "session_001",
			taskId: "task_42",
			graphRevision: 7,
			nodeId: "node_test",
			stageId: "stage_run",
			stageRevision: 2,
			runId: "run_001",
			scopeDigest: calculateScopeDigest([makeScope()]),
			scopeCount: 1,
			status: "active",
			issuedAt: grantedIso(NOW),
			expiresAt: grantedIso(NOW + TTL),
			renewAfter: grantedIso(NOW + TTL - TASK_CREDENTIAL_RENEWAL_WINDOW_MS),
			heartbeatSequence: 0,
			revision: 0,
			targetId: "target_1",
		});
	});

	it("inherits optional stage and target fields from the binding", () => {
		const withStage = issue();
		expect(withStage.stageId).toBe("stage_run");
		expect(withStage.stageRevision).toBe(2);

		const withoutOptional = issue({
			binding: makeBinding({ stageId: undefined, stageRevision: undefined, targetId: undefined }),
		});
		expect(withoutOptional.stageId).toBeUndefined();
		expect(withoutOptional.stageRevision).toBeUndefined();
		expect(withoutOptional.targetId).toBeUndefined();
	});

	it("records scopeCount and digest for multiple scopes", () => {
		const record = issue({ scopes: [makeScope(), makeScope({ credentialName: "npm_registry" })] });
		expect(record.scopeCount).toBe(2);
		expect(record.scopeDigest).toBe(
			calculateScopeDigest([makeScope(), makeScope({ credentialName: "npm_registry" })]),
		);
	});

	it("dedupes identical scopes at issue time", () => {
		expect(issue({ scopes: [makeScope(), makeScope()] }).scopeCount).toBe(1);
	});

	it("is deterministic for the same clock value", () => {
		expect(issue()).toEqual(issue());
	});

	it("rejects invalid grant IDs, lease IDs, and clock values", () => {
		expectCredentialError(() => issue({ grantId: "grant/path" }), "task_credential_invalid");
		expectCredentialError(() => issue({ leaseId: "x".repeat(129) }), "task_credential_invalid");
		expectCredentialError(
			() => issueTaskCredentialGrant(issueInput(), -1),
			"task_credential_invalid",
		);
		expectCredentialError(
			() => issueTaskCredentialGrant(issueInput(), Number.NaN),
			"task_credential_invalid",
		);
	});

	it("rejects invalid bindings before issuing", () => {
		expectCredentialError(
			() => issue({ binding: makeBinding({ runId: "run/path" }) }),
			"task_credential_binding_invalid",
		);
		expectCredentialError(
			() => issue({ binding: makeBinding({ stageId: undefined }) }),
			"task_credential_binding_invalid",
		);
	});

	it("rejects unknown issue input keys", () => {
		expectCredentialError(
			() => issue({ clientRequestId: "req-1" } as never),
			"task_credential_invalid",
		);
	});
});

function issueInput(): TaskCredentialIssueRequest {
	return {
		grantId: "grant_001",
		leaseId: "lease_001",
		binding: makeBinding(),
		scopes: [makeScope()],
		requestedTtlMs: TTL,
		ttlBounds: makeBounds(),
	};
}

describe("bounded TTL", () => {
	it("accepts the minimum and maximum TTL and rejects one millisecond outside", () => {
		expect(issue({ requestedTtlMs: TASK_CREDENTIAL_MIN_TTL_MS }).expiresAt).toBe(
			grantedIso(NOW + TASK_CREDENTIAL_MIN_TTL_MS),
		);
		expect(issue({ requestedTtlMs: TASK_CREDENTIAL_MAX_TTL_MS }).expiresAt).toBe(
			grantedIso(NOW + TASK_CREDENTIAL_MAX_TTL_MS),
		);
		expectCredentialError(
			() => issue({ requestedTtlMs: TASK_CREDENTIAL_MIN_TTL_MS - 1 }),
			"task_credential_ttl_invalid",
		);
		expectCredentialError(
			() => issue({ requestedTtlMs: TASK_CREDENTIAL_MAX_TTL_MS + 1 }),
			"task_credential_ttl_invalid",
		);
		expectCredentialError(() => issue({ requestedTtlMs: 0 }), "task_credential_ttl_invalid");
		expectCredentialError(() => issue({ requestedTtlMs: Number.NaN }), "task_credential_ttl_invalid");
		expectCredentialError(() => issue({ requestedTtlMs: 1.5 }), "task_credential_ttl_invalid");
	});

	it("accepts the renewal window as the effective floor", () => {
		expect(
			calculateBoundedTtl(TASK_CREDENTIAL_RENEWAL_WINDOW_MS, { minTtlMs: 1, maxTtlMs: TASK_CREDENTIAL_MAX_TTL_MS }, NOW),
		).toBe(TASK_CREDENTIAL_RENEWAL_WINDOW_MS);
		expectCredentialError(
			() =>
				calculateBoundedTtl(TASK_CREDENTIAL_RENEWAL_WINDOW_MS - 1, { minTtlMs: 1, maxTtlMs: TASK_CREDENTIAL_MAX_TTL_MS }, NOW),
			"task_credential_ttl_invalid",
		);
	});

	it("rejects TTL beyond the earliest deadline", () => {
		const deadline = NOW + 30_000;
		expect(issue({ requestedTtlMs: 30_000, ttlBounds: makeBounds({ deadlineAtMs: deadline }) }).expiresAt).toBe(
			grantedIso(deadline),
		);
		expectCredentialError(
			() => issue({ requestedTtlMs: 30_001, ttlBounds: makeBounds({ deadlineAtMs: deadline }) }),
			"task_credential_ttl_invalid",
		);
		expectCredentialError(
			() => issue({ requestedTtlMs: TTL, ttlBounds: makeBounds({ deadlineAtMs: NOW - 1 }) }),
			"task_credential_ttl_invalid",
		);
	});

	it("rejects inconsistent bounds", () => {
		expectCredentialError(
			() => issue({ requestedTtlMs: TTL, ttlBounds: makeBounds({ minTtlMs: 5_000, maxTtlMs: 4_000 }) }),
			"task_credential_ttl_invalid",
		);
		expectCredentialError(
			() => issue({ requestedTtlMs: TTL, ttlBounds: makeBounds({ deadlineAtMs: -1 }) }),
			"task_credential_ttl_invalid",
		);
	});

	it("caps the effective ceiling at the core maximum even with untrusted caller bounds", () => {
		const hugeBounds = makeBounds({ maxTtlMs: Number.MAX_SAFE_INTEGER });
		expect(calculateBoundedTtl(TASK_CREDENTIAL_MAX_TTL_MS, hugeBounds, NOW)).toBe(
			TASK_CREDENTIAL_MAX_TTL_MS,
		);
		expectCredentialError(
			() => calculateBoundedTtl(TASK_CREDENTIAL_MAX_TTL_MS + 1, hugeBounds, NOW),
			"task_credential_ttl_invalid",
		);
		expect(issue({ requestedTtlMs: TASK_CREDENTIAL_MAX_TTL_MS, ttlBounds: hugeBounds }).expiresAt).toBe(
			grantedIso(NOW + TASK_CREDENTIAL_MAX_TTL_MS),
		);
		expectCredentialError(
			() => issue({ requestedTtlMs: TASK_CREDENTIAL_MAX_TTL_MS + 1, ttlBounds: hugeBounds }),
			"task_credential_ttl_invalid",
		);
	});

	it("caps the ceiling at the earliest of core maximum, caller maximum, and deadline", () => {
		const bounds = makeBounds({ maxTtlMs: TASK_CREDENTIAL_MAX_TTL_MS * 2, deadlineAtMs: NOW + 60_000 });
		expect(calculateBoundedTtl(60_000, bounds, NOW)).toBe(60_000);
		expectCredentialError(() => calculateBoundedTtl(60_001, bounds, NOW), "task_credential_ttl_invalid");

		const callerCapped = makeBounds({ maxTtlMs: 30_000 });
		expect(calculateBoundedTtl(30_000, callerCapped, NOW)).toBe(30_000);
		expectCredentialError(() => calculateBoundedTtl(30_001, callerCapped, NOW), "task_credential_ttl_invalid");
	});
});

describe("heartbeat / renew", () => {
	it("extends the lease with strictly increasing sequence and revision", () => {
		const record = issue();
		const renewed = heartbeat(record);

		expect(renewed.status).toBe("active");
		expect(renewed.heartbeatSequence).toBe(1);
		expect(renewed.revision).toBe(1);
		expect(renewed.issuedAt).toBe(record.issuedAt);
		expect(renewed.expiresAt).toBe(grantedIso(NOW + 1_000 + TTL));
		expect(renewed.renewAfter).toBe(grantedIso(NOW + 1_000 + TTL - TASK_CREDENTIAL_RENEWAL_WINDOW_MS));

		const second = heartbeat(renewed, 2, NOW + 2_000);
		expect(second.heartbeatSequence).toBe(2);
		expect(second.revision).toBe(2);
		expect(second.expiresAt).toBe(grantedIso(NOW + 2_000 + TTL));
	});

	it("never changes binding, scope, or target on renewal", () => {
		const record = issue();
		const renewed = heartbeat(record);
		expect(renewed.bindingId).toBe(record.bindingId);
		expect(renewed.sessionId).toBe(record.sessionId);
		expect(renewed.taskId).toBe(record.taskId);
		expect(renewed.graphRevision).toBe(record.graphRevision);
		expect(renewed.nodeId).toBe(record.nodeId);
		expect(renewed.stageId).toBe(record.stageId);
		expect(renewed.stageRevision).toBe(record.stageRevision);
		expect(renewed.runId).toBe(record.runId);
		expect(renewed.scopeDigest).toBe(record.scopeDigest);
		expect(renewed.scopeCount).toBe(record.scopeCount);
		expect(renewed.targetId).toBe(record.targetId);
		expect(renewed.grantId).toBe(record.grantId);
		expect(renewed.leaseId).toBe(record.leaseId);
	});

	it("rejects replayed, backwards, and skipped sequences", () => {
		const record = issue();
		expectCredentialError(() => heartbeat(record, 0), "task_lease_heartbeat_invalid");
		expectCredentialError(() => heartbeat(record, 2), "task_lease_heartbeat_invalid");
		expectCredentialError(() => heartbeat(record, Number.NaN), "task_credential_invalid");

		const renewed = heartbeat(record, 1);
		expectCredentialError(() => heartbeat(renewed, 1), "task_lease_heartbeat_invalid");
		expectCredentialError(() => heartbeat(renewed, 0), "task_lease_heartbeat_invalid");
		expectCredentialError(() => heartbeat(renewed, 3), "task_lease_heartbeat_invalid");
	});

	it("rejects heartbeat on a due or expired lease", () => {
		const record = issue();
		expectCredentialError(
			() =>
				transition(record, "renewed", {
					nowMs: NOW + TTL,
					heartbeatSequence: 1,
					ttlMs: TTL,
					ttlBounds: makeBounds(),
				}),
			"task_lease_expired",
		);
		const expired = transition(record, "expired", { nowMs: NOW + TTL });
		expectCredentialError(() => heartbeat(expired), "task_lease_expired");
	});

	it("rejects heartbeat on terminal statuses without resurrection", () => {
		const revoked = transition(issue(), "revoked");
		const settled = transition(transition(issue(), "revoked"), "settled");
		const unknown = transition(issue(), "revocation_unknown");
		expectCredentialError(() => heartbeat(revoked), "task_credential_conflict");
		expectCredentialError(() => heartbeat(settled), "task_credential_conflict");
		expectCredentialError(() => heartbeat(unknown), "task_credential_conflict");
	});

	it("bounds the renewal TTL and rejects out-of-range requests", () => {
		const record = issue();
		expectCredentialError(
			() => transition(record, "renewed", { nowMs: NOW + 1_000, heartbeatSequence: 1, ttlMs: TASK_CREDENTIAL_MAX_TTL_MS + 1, ttlBounds: makeBounds() }),
			"task_credential_ttl_invalid",
		);
		expectCredentialError(
			() => transition(record, "renewed", { nowMs: NOW + 1_000, heartbeatSequence: 1, ttlMs: TTL }),
			"task_credential_invalid",
		);
		expectCredentialError(
			() => transition(record, "renewed", { nowMs: NOW + 1_000, ttlMs: TTL, ttlBounds: makeBounds() }),
			"task_credential_invalid",
		);
	});

	it("exposes matching canHeartbeatTaskLease / canRenewTaskLease predicates", () => {
		const record = issue();
		expect(canHeartbeatTaskLease(record, 1, NOW + 1_000)).toBeUndefined();
		expect(canHeartbeatTaskLease(record, 1, NOW + 1_000)).toBeUndefined();
		expect(canHeartbeatTaskLease(record, 0, NOW + 1_000)).toBe("task_lease_heartbeat_invalid");
		expect(canHeartbeatTaskLease(record, 1, NOW + TTL)).toBe("task_lease_expired");
		expect(canHeartbeatTaskLease(transition(issue(), "revoked"), 1, NOW + 1_000)).toBe("task_credential_conflict");
		expect(canHeartbeatTaskLease({} as never, 1, NOW + 1_000)).toBe("task_credential_invalid");

		expect(canRenewTaskLease(record, NOW + 1_000)).toBeUndefined();
		expect(canRenewTaskLease(record, NOW + TTL)).toBe("task_lease_expired");
		expect(canRenewTaskLease(transition(transition(issue(), "revoked"), "settled"), NOW + 1_000)).toBe("task_credential_conflict");
		expect(canRenewTaskLease(null as never, NOW + 1_000)).toBe("task_credential_invalid");
	});

	it("rejects unknown transition option keys", () => {
		const record = issue();
		expectCredentialError(
			() => transitionTaskCredentialStatus(record, "renewed", { nowMs: NOW + 1_000, heartbeatSequence: 1, ttlMs: TTL, ttlBounds: makeBounds(), prompt: "hi" } as never),
			"task_credential_invalid",
		);
	});

	it("rejects null, array, primitive, and incomplete options with a TaskCredentialError", () => {
		const record = issue();
		const action = "revoked" as const;
		for (const bad of [null, [], "oops", undefined, {}] as const) {
			expectCredentialError(
				() => transitionTaskCredentialStatus(record, action, bad as never),
				"task_credential_invalid",
			);
		}
		// Unknown keys are rejected before any option field is read.
		expectCredentialError(
			() => transitionTaskCredentialStatus(record, action, { prompt: "hi" } as never),
			"task_credential_invalid",
		);
		// A valid container without nowMs is rejected, not coerced.
		expectCredentialError(
			() => transitionTaskCredentialStatus(record, action, {} as never),
			"task_credential_invalid",
		);
	});
});

describe("delivery", () => {
	function receipt(status: "succeeded" | "failed", overrides: Partial<TaskCredentialDeliveryReceipt> = {}): TaskCredentialDeliveryReceipt {
		return {
			schemaVersion: 1,
			leaseId: "lease_001",
			grantId: "grant_001",
			bindingId: "binding_001",
			targetId: "target_1",
			status,
			recordedAt: grantedIso(NOW + 1_000),
			...(status === "failed" ? { reasonCode: "target_quarantined" } : {}),
			...overrides,
		};
	}

	it("records delivery_succeeded without changing lease status or sequence", () => {
		const record = issue();
		const delivered = transition(record, "delivery_succeeded", { delivery: receipt("succeeded") });
		expect(delivered.status).toBe("active");
		expect(delivered.revision).toBe(1);
		expect(delivered.heartbeatSequence).toBe(0);
		expect(delivered.expiresAt).toBe(record.expiresAt);
		expect(delivered.scopeDigest).toBe(record.scopeDigest);
	});

	it("records delivery_failed with a safe reason code", () => {
		const record = issue();
		const failed = transition(record, "delivery_failed", { delivery: receipt("failed") });
		expect(failed.status).toBe("active");
		expect(failed.revision).toBe(1);
		expect(isTaskCredentialDeliveryReceipt(receipt("failed"))).toBe(true);
		expect(serializeTaskCredentialDeliveryReceipt(receipt("failed"))).toEqual(receipt("failed"));
		expect(parseTaskCredentialDeliveryReceipt(receipt("failed"))).toEqual(receipt("failed"));
	});

	it("rejects receipts whose status does not match the action", () => {
		const record = issue();
		expectCredentialError(
			() => transition(record, "delivery_succeeded", { delivery: receipt("failed") }),
			"task_credential_invalid",
		);
		expectCredentialError(
			() => transition(record, "delivery_failed", { delivery: receipt("succeeded") }),
			"task_credential_invalid",
		);
		expectCredentialError(
			() => transition(record, "delivery_succeeded", { delivery: { ...receipt("succeeded"), status: "unknown" } }),
			"task_credential_invalid",
		);
		expectCredentialError(
			() => transition(record, "delivery_succeeded", { delivery: { ...receipt("succeeded"), recordedAt: "now" } }),
			"task_credential_invalid",
		);
	});

	it("rejects delivery on terminal leases", () => {
		const expired = transition(issue(), "expired", { nowMs: NOW + TTL });
		const revoked = transition(issue(), "revoked");
		expectCredentialError(
			() => transition(expired, "delivery_succeeded", { delivery: receipt("succeeded") }),
			"task_lease_expired",
		);
		expectCredentialError(
			() => transition(revoked, "delivery_succeeded", { delivery: receipt("succeeded") }),
			"task_credential_conflict",
		);
	});

	it("validates receipt snapshots strictly", () => {
		const ok = receipt("succeeded");
		expect(isTaskCredentialDeliveryReceipt(ok)).toBe(true);
		expect(isTaskCredentialDeliveryReceipt({ ...ok, token: "abc" })).toBe(false);
		expect(isTaskCredentialDeliveryReceipt({ ...ok, status: "done" })).toBe(false);
		expect(isTaskCredentialDeliveryReceipt({ ...ok, bindingId: "" })).toBe(false);
		expect(isTaskCredentialDeliveryReceipt({ ...ok, reasonCode: "r".repeat(TASK_CREDENTIAL_REASON_CODE_MAX_LENGTH + 1) })).toBe(false);
		expect(TASK_CREDENTIAL_DELIVERY_STATUS).toEqual(["succeeded", "failed", "unknown"]);
	});
});

describe("expiry", () => {
	it("expires exactly at expiresAt and not before", () => {
		const record = issue();
		expectCredentialError(() => transition(record, "expired", { nowMs: NOW + TTL - 1 }), "task_credential_conflict");
		const expired = transition(record, "expired", { nowMs: NOW + TTL });
		expect(expired.status).toBe("expired");
		expect(expired.revision).toBe(1);
		expect(expired.heartbeatSequence).toBe(0);
		expect(transition(record, "expired", { nowMs: NOW + TTL + 1 }).status).toBe("expired");
	});

	it("never resurrects an expired lease", () => {
		const expired = transition(issue(), "expired", { nowMs: NOW + TTL });
		expectCredentialError(() => heartbeat(expired), "task_lease_expired");
		expectCredentialError(() => transition(expired, "delivery_succeeded"), "task_lease_expired");
		expectCredentialError(() => transition(expired, "settled"), "task_credential_conflict");
		expect(isLegalTaskCredentialTransition("expired", "renewed")).toBe(false);
		expect(isLegalTaskCredentialTransition("expired", "issued")).toBe(false);
	});
});

describe("revoke and revocation_unknown", () => {
	it("revokes an active lease with a reason code", () => {
		const revoked = transition(issue(), "revoked", { reasonCode: "run_cancelled" });
		expect(revoked.status).toBe("revoked");
		expect(revoked.revision).toBe(1);
		expect(revoked.reasonCode).toBe("run_cancelled");
		expect(revoked.heartbeatSequence).toBe(0);
	});

	it("revokes an expired lease (post-expiry revoke)", () => {
		const expired = transition(issue(), "expired", { nowMs: NOW + TTL });
		expect(transition(expired, "revoked").status).toBe("revoked");
	});

	it("rejects repeated revoke without new side effects", () => {
		const revoked = transition(issue(), "revoked");
		expectCredentialError(() => transition(revoked, "revoked"), "task_credential_conflict");
		expectCredentialError(() => transition(revoked, "revocation_unknown"), "task_credential_conflict");
	});

	it("records revocation_unknown from active and expired", () => {
		const unknown = transition(issue(), "revocation_unknown", { reasonCode: "provider_timeout" });
		expect(unknown.status).toBe("revocation_unknown");
		expect(unknown.reasonCode).toBe("provider_timeout");

		const expired = transition(issue(), "expired", { nowMs: NOW + TTL });
		expect(transition(expired, "revocation_unknown").status).toBe("revocation_unknown");
	});

	it("converges revocation_unknown to revoked only via provider confirmed reconciliation", () => {
		const unknown = transition(issue(), "revocation_unknown");

		// Without the confirmation flag the convergence is denied, and a
		// false or non-boolean flag is structurally invalid; the flag never
		// carries raw or provider data.
		expectCredentialError(
			() => transition(unknown, "revoked", { reasonCode: "reconciliation" }),
			"task_credential_conflict",
		);
		expectCredentialError(
			() => transition(unknown, "revoked", { providerConfirmedRevoke: false }),
			"task_credential_invalid",
		);
		expectCredentialError(
			() => transition(unknown, "revoked", { providerConfirmedRevoke: "yes" } as never),
			"task_credential_invalid",
		);
		expectCredentialError(() => transition(unknown, "settled"), "task_credential_conflict");
		expect(isLegalTaskCredentialTransition("revocation_unknown", "settled")).toBe(false);

		const confirmed = transition(unknown, "revoked", { reasonCode: "reconciliation", providerConfirmedRevoke: true });
		expect(confirmed.status).toBe("revoked");
		expect(confirmed.revision).toBe(2);
		expect(confirmed.reasonCode).toBe("reconciliation");

		// Fresh revokes (active / expired) never require the flag.
		expect(transition(issue(), "revoked").status).toBe("revoked");
		expect(transition(transition(issue(), "expired", { nowMs: NOW + TTL }), "revoked").status).toBe("revoked");

		const deniedOptions = (action: TaskCredentialAction): Partial<TaskCredentialTransitionOptions> => {
			if (action === "renewed") return { heartbeatSequence: 1, ttlMs: TTL, ttlBounds: makeBounds() };
			return {};
		};
		for (const action of ["renewed", "delivery_succeeded", "delivery_failed", "expired", "settled", "revocation_unknown"] as const) {
			expectCredentialError(() => transition(unknown, action, deniedOptions(action)), "task_credential_conflict");
			expect(isLegalTaskCredentialTransition("revocation_unknown", action)).toBe(false);
		}
		expect(isLegalTaskCredentialTransition("revocation_unknown", "revoked")).toBe(true);
	});

	it("exposes matching canRevokeTaskLease predicate", () => {
		expect(canRevokeTaskLease(issue())).toBeUndefined();
		expect(canRevokeTaskLease(transition(issue(), "expired", { nowMs: NOW + TTL }))).toBeUndefined();
		expect(canRevokeTaskLease(transition(transition(issue(), "revoked"), "settled"))).toBe("task_credential_conflict");
		expect(canRevokeTaskLease(transition(issue(), "revocation_unknown"))).toBe("task_credential_conflict");
		expect(canRevokeTaskLease(null as never)).toBe("task_credential_invalid");
	});

	it("exposes the reconcile predicate the store gates on before provider confirmation", () => {
		// Only a valid revocation_unknown grant passes the gate.
		expect(canReconcileTaskLease(transition(issue(), "revocation_unknown"))).toBeUndefined();
		expect(canReconcileTaskLease(transition(issue(), "revocation_unknown", { reasonCode: "provider_timeout" }))).toBeUndefined();

		// Every other valid status is a conflict.
		expect(canReconcileTaskLease(issue())).toBe("task_credential_conflict");
		expect(canReconcileTaskLease(transition(issue(), "expired", { nowMs: NOW + TTL }))).toBe("task_credential_conflict");
		expect(canReconcileTaskLease(transition(issue(), "revoked"))).toBe("task_credential_conflict");
		expect(canReconcileTaskLease(transition(transition(issue(), "revoked"), "settled"))).toBe("task_credential_conflict");
		expect(canReconcileTaskLease({ ...issue(), status: "renewing" })).toBe("task_credential_conflict");

		// Malformed input is invalid, never I/O and never raw provider data.
		expect(canReconcileTaskLease({} as never)).toBe("task_credential_invalid");
		expect(canReconcileTaskLease(null as never)).toBe("task_credential_invalid");
		expect(canReconcileTaskLease({ ...issue(), scopeDigest: "deadbeef" } as TaskCredentialGrant)).toBe(
			"task_credential_invalid",
		);
	});

	it("rejects invalid reason codes", () => {
		expectCredentialError(
			() => transition(issue(), "revoked", { reasonCode: "not a code!" }),
			"task_credential_invalid",
		);
		expectCredentialError(
			() => transition(issue(), "revoked", { reasonCode: "r".repeat(TASK_CREDENTIAL_REASON_CODE_MAX_LENGTH + 1) }),
			"task_credential_invalid",
		);
		expectCredentialError(
			() => transition(issue(), "revocation_unknown", { reasonCode: "x/y" }),
			"task_credential_invalid",
		);
	});
});

describe("settle", () => {
	it("settles only a revoked lease and records the reason", () => {
		const revoked = transition(issue(), "revoked", { reasonCode: "run_cancelled" });
		const settled = transition(revoked, "settled", { reasonCode: "run_completed" });
		expect(settled.status).toBe("settled");
		expect(settled.revision).toBe(2);
		expect(settled.reasonCode).toBe("run_completed");
		expect(settled.heartbeatSequence).toBe(0);
	});

	it("rejects settle from active, expired, revocation_unknown, and settled", () => {
		const active = issue();
		const expired = transition(issue(), "expired", { nowMs: NOW + TTL });
		const unknown = transition(issue(), "revocation_unknown");
		const settled = transition(transition(issue(), "revoked"), "settled");
		for (const record of [active, expired, unknown, settled]) {
			expectCredentialError(() => transition(record, "settled"), "task_credential_conflict");
			expect(isLegalTaskCredentialTransition(record.status, "settled")).toBe(false);
			expect(canSettleTaskLease(record)).toBe("task_credential_conflict");
		}
	});

	it("exposes the settle predicate the store gates on", () => {
		expect(canSettleTaskLease(transition(issue(), "revoked"))).toBeUndefined();
		expect(canSettleTaskLease(issue())).toBe("task_credential_conflict");
		expect(canSettleTaskLease(transition(issue(), "expired", { nowMs: NOW + TTL }))).toBe("task_credential_conflict");
		expect(canSettleTaskLease(transition(issue(), "revocation_unknown"))).toBe("task_credential_conflict");
		expect(canSettleTaskLease({ ...issue(), status: "renewing" })).toBe("task_credential_conflict");
		expect(canSettleTaskLease({} as never)).toBe("task_credential_invalid");
	});
});

describe("state machine matrix", () => {
	it("exposes the frozen status and action unions", () => {
		expect(TASK_CREDENTIAL_STATUS).toEqual([
			"active",
			"renewing",
			"expired",
			"revoked",
			"settled",
			"revocation_unknown",
		]);
		expect(TASK_CREDENTIAL_ACTION).toEqual([
			"issued",
			"renewed",
			"delivery_succeeded",
			"delivery_failed",
			"revoked",
			"expired",
			"settled",
			"revocation_unknown",
		]);
	});

	it("allows only issued before any grant exists", () => {
		expect(isLegalTaskCredentialTransition(undefined, "issued")).toBe(true);
		for (const action of TASK_CREDENTIAL_ACTION) {
			if (action !== "issued") {
				expect(isLegalTaskCredentialTransition(undefined, action)).toBe(false);
			}
		}
	});

	it("allows every non-issued, non-settle action from active", () => {
		for (const action of TASK_CREDENTIAL_ACTION) {
			expect(isLegalTaskCredentialTransition("active", action)).toBe(
				action !== "issued" && action !== "settled",
			);
		}
	});

	it("allows only post-expiry revoke from expired", () => {
		for (const action of TASK_CREDENTIAL_ACTION) {
			const expected = action === "revoked" || action === "revocation_unknown";
			expect(isLegalTaskCredentialTransition("expired", action)).toBe(expected);
		}
	});

	it("allows only settle from revoked", () => {
		for (const action of TASK_CREDENTIAL_ACTION) {
			expect(isLegalTaskCredentialTransition("revoked", action)).toBe(action === "settled");
		}
	});

	it("never allows transitions from renewing or settled", () => {
		for (const status of ["renewing", "settled"] as const) {
			for (const action of TASK_CREDENTIAL_ACTION) {
				expect(isLegalTaskCredentialTransition(status, action)).toBe(false);
			}
		}
	});

	it("rejects issued as a transition on an existing grant", () => {
		expectCredentialError(
			() => transition(issue(), "issued" as never),
			"task_credential_invalid",
		);
	});
});

describe("serializer safety", () => {
	it("round-trips grants and bindings through parse", () => {
		const record = issue();
		expect(parseTaskCredentialGrant(record)).toEqual(record);
		expect(isTaskCredentialGrant(record)).toBe(true);
		expect(serializeTaskCredentialGrant(record)).toEqual(record);
	});

	it("never emits scope raw content or unknown fields from a grant", () => {
		const polluted = {
			...issue(),
			scopes: [{ credentialName: "x", purpose: "y", operations: [], targetKinds: [] }],
			token: "secret-value",
			env: { PATH: "/tmp" },
		} as TaskCredentialGrant;
		const safe = serializeTaskCredentialGrant(polluted);
		expect("scopes" in safe).toBe(false);
		expect("token" in safe).toBe(false);
		expect("env" in safe).toBe(false);
		expect(Object.keys(safe).sort()).toEqual(
			[
				"bindingId",
				"expiresAt",
				"grantId",
				"graphRevision",
				"heartbeatSequence",
				"issuedAt",
				"leaseId",
				"nodeId",
				"renewAfter",
				"revision",
				"runId",
				"scopeCount",
				"scopeDigest",
				"sessionId",
				"stageId",
				"stageRevision",
				"status",
				"targetId",
				"taskId",
				"schemaVersion",
			].sort(),
		);
	});

	it("rejects tampered grant snapshots", () => {
		const record = issue();
		const cases: Array<[string, Record<string, unknown>]> = [
			["unknown key", { ...record, token: "abc" }],
			["bad digest shape", { ...record, scopeDigest: "deadbeef" }],
			["unknown status", { ...record, status: "revoking" }],
			["non-ISO expiresAt", { ...record, expiresAt: "2026-08-16T10:01:00Z" }],
			["expiresAt not after issuedAt", { ...record, expiresAt: record.issuedAt }],
			["renewAfter not before expiresAt", { ...record, renewAfter: record.expiresAt }],
			["renewAfter before issuedAt", { ...record, renewAfter: "2026-08-16T09:59:59.999Z" }],
			["stage pairing broken", { ...record, stageRevision: undefined }],
			["negative revision", { ...record, revision: -1 }],
			["negative heartbeat sequence", { ...record, heartbeatSequence: -1 }],
			["scope count over limit", { ...record, scopeCount: TASK_CREDENTIAL_MAX_SCOPES + 1 }],
			["reason code too long", { ...record, reasonCode: "r".repeat(TASK_CREDENTIAL_REASON_CODE_MAX_LENGTH + 1) }],
			["wrong schema", { ...record, schemaVersion: 2 }],
		];
		for (const [name, value] of cases) {
			expect(isTaskCredentialGrant(value), name).toBe(false);
			expect(parseTaskCredentialGrant(value), name).toBeUndefined();
		}
		expect(isTaskCredentialGrant(null)).toBe(false);
		expect(isTaskCredentialGrant("grant")).toBe(false);
	});

	it("rejects transitions on snapshots that fail validation", () => {
		const invalid = { ...issue(), scopeDigest: "deadbeef" } as TaskCredentialGrant;
		expectCredentialError(() => transition(invalid, "revoked"), "task_credential_invalid");
		expectCredentialError(() => transition(invalid, "settled"), "task_credential_invalid");
	});

	it("enforces strict ISO timestamps with millisecond precision", () => {
		const record = issue();
		expect(record.issuedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
		expect(record.expiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
		expect(record.renewAfter).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
		expect(Date.parse(record.expiresAt)).toBe(Date.parse(record.issuedAt) + TTL);
		expect(Date.parse(record.renewAfter)).toBe(
			Date.parse(record.expiresAt) - TASK_CREDENTIAL_RENEWAL_WINDOW_MS,
		);
	});
});

describe("error contract", () => {
	it("exposes the frozen provider-neutral error codes", () => {
		expect(TASK_CREDENTIAL_ERROR_CODES).toEqual([
			"task_credential_invalid",
			"task_credential_binding_invalid",
			"task_credential_gate_required",
			"task_credential_policy_denied",
			"task_credential_approval_required",
			"task_credential_scope_denied",
			"task_credential_ttl_invalid",
			"task_credential_provider_unavailable",
			"task_credential_issue_failed",
			"task_credential_not_found",
			"task_credential_conflict",
			"task_lease_expired",
			"task_lease_heartbeat_invalid",
			"task_credential_target_unavailable",
			"task_credential_delivery_failed",
			"task_credential_revocation_unknown",
			"task_credential_persistence_failed",
		]);
	});

	it("derives stable code-based messages and views", () => {
		for (const code of TASK_CREDENTIAL_ERROR_CODES) {
			const error = new TaskCredentialError(code);
			expect(error.message.length).toBeGreaterThan(0);
			expect(error.name).toBe("TaskCredentialError");
			expect(error.toJSON()).toEqual({
				code,
				message: error.message,
				retryable: error.retryable,
			});
			expect(error.retryable).toBe(code === "task_credential_provider_unavailable");
		}
	});

	it("keeps only provider_unavailable retryable", () => {
		expect(new TaskCredentialError("task_credential_provider_unavailable").retryable).toBe(true);
		expect(new TaskCredentialError("task_credential_ttl_invalid").retryable).toBe(false);
		expect(new TaskCredentialError("task_credential_persistence_failed").retryable).toBe(false);
		expect(new TaskCredentialError("task_credential_conflict").retryable).toBe(false);
	});
});

describe("deterministic clock", () => {
	it("produces identical grants and transitions for identical clock values", () => {
		const a = issue();
		const b = issue();
		expect(a).toEqual(b);
		const ha = heartbeat(a);
		const hb = heartbeat(b);
		expect(ha).toEqual(hb);
	});

	it("advancing the clock by one millisecond changes only time-derived fields", () => {
		const early = heartbeat(issue(), 1, NOW + 1_000);
		const late = heartbeat(issue(), 1, NOW + 1_001);
		expect(late.expiresAt).toBe(grantedIso(NOW + 1_001 + TTL));
		expect(late.renewAfter).toBe(grantedIso(NOW + 1_001 + TTL - TASK_CREDENTIAL_RENEWAL_WINDOW_MS));
		expect(late.heartbeatSequence).toBe(early.heartbeatSequence);
		expect(late.revision).toBe(early.revision);
		expect(late.scopeDigest).toBe(early.scopeDigest);
		expect(late.bindingId).toBe(early.bindingId);
	});

	it("never reads Date.now: a fixed clock yields a fixed history", () => {
		const history: TaskCredentialGrant[] = [issue()];
		history.push(heartbeat(history[0], 1, NOW + 1_000));
		history.push(heartbeat(history[1], 2, NOW + 2_000));
		history.push(transition(history[2], "delivery_succeeded"));
		history.push(transition(history[3], "revoked", { reasonCode: "run_cancelled" }));

		const replay: TaskCredentialGrant[] = [issue()];
		replay.push(heartbeat(replay[0], 1, NOW + 1_000));
		replay.push(heartbeat(replay[1], 2, NOW + 2_000));
		replay.push(transition(replay[2], "delivery_succeeded"));
		replay.push(transition(replay[3], "revoked", { reasonCode: "run_cancelled" }));
		expect(replay).toEqual(history);
		expect(history[4].status).toBe("revoked");
		expect(history[4].revision).toBe(4);
		expect(history[4].heartbeatSequence).toBe(2);
	});
});
