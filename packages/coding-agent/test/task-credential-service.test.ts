/**
 * Tests for the Task Credential lifecycle service v1: the session-scoped
 * facade that turns host lifecycle signals (run terminal / interrupted /
 * resume, session shutdown, task gate invalidation, graph node terminal,
 * worker detach) into fail-closed revoke / quarantine / settle operations.
 *
 * Covers: fresh deterministic bindings + grants per run context (resume
 * never restores an old grant), idempotent issue replays, delivery failure
 * quarantine, run terminal / deadline / interrupted signals with confirmed
 * and unknown revoke outcomes, gate / node / worker-detach / session-shutdown
 * signals, signal idempotency, the material-free renew / heartbeat facade
 * (bound to lease/grant/binding, strictly increasing sequence, fail closed
 * on deadline / terminal / unknown / quarantine / closed states), the
 * post-shutdown closed state (issue and renew fail closed while shutdown
 * stays idempotent and unknown revocations keep their quarantine), invalid-
 * input no-ops, and the hard rule that the service never rewrites Run / Gate /
 * Graph ledgers (only `task.credential` custom entries are ever appended) and
 * never resurrects a terminal grant.
 */

import { describe, expect, it } from "vitest";
import type { SessionEntry } from "../src/core/session-manager.ts";
import {
	TaskCredentialError,
	calculateScopeDigest,
	isTaskCredentialGrant,
	type TaskCredentialDeliveryReceipt,
	type TaskCredentialScope,
} from "../src/core/task-credential-lease.ts";
import {
	createTaskCredentialTestProvider,
	type TaskCredentialProviderReceipt,
	type TaskCredentialProviderRenewRequest,
	type TaskCredentialProviderRevokeRequest,
	type TaskCredentialTargetCapabilities,
	type TaskCredentialTargetCapabilitiesRequest,
	type TaskCredentialTargetRenewRequest,
	type TaskCredentialTargetRevokeRequest,
	type TaskCredentialTestProvider,
} from "../src/core/task-credential-provider.ts";
import {
	TASK_CREDENTIAL_CUSTOM_TYPE,
	type TaskCredentialSession,
} from "../src/core/task-credential-store.ts";
import {
	TaskCredentialService,
	type TaskCredentialGateInvalidationInput,
	type TaskCredentialGraphNodeTerminalInput,
	type TaskCredentialPreflightResolver,
	type TaskCredentialRunIssueContext,
	type TaskCredentialRunTerminalInput,
	type TaskCredentialServiceOptions,
	type TaskCredentialWorkerTarget,
} from "../src/core/task-credential-service.ts";
import type { TaskCredentialPreflightOperation } from "../src/core/execution-policy.ts";

const NOW = "2026-08-15T12:00:00.000Z";
const SENTINEL = "sentinel-secret-42";

class FakeSession implements TaskCredentialSession {
	readonly sessionId: string;
	readonly entries: SessionEntry[] = [];

	constructor(sessionId: string) {
		this.sessionId = sessionId;
	}

	getSessionId(): string {
		return this.sessionId;
	}

	getEntries(): ReadonlyArray<SessionEntry> {
		return this.entries;
	}

	appendCustomEntry(customType: string, data?: unknown): string {
		const entry = { id: `entry_${this.entries.length + 1}`, type: "custom", customType, data };
		this.entries.push(entry as SessionEntry);
		return entry.id;
	}
}

const SCOPES: ReadonlyArray<TaskCredentialScope> = [
	{
		credentialName: "package_registry",
		purpose: "dependency_read",
		resource: "registry.internal",
		operations: ["read"],
		targetKinds: ["isolated_sandbox"],
	},
];

/** Material-receiving target adapter; records projections and answers statuses. */
class RecordingTarget {
	received: Array<{ leaseId: string; material: Readonly<Record<string, string>> }> = [];
	renewals: TaskCredentialTargetRenewRequest[] = [];
	revocations: TaskCredentialTargetRevokeRequest[] = [];
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
			schemaVersion: 1,
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
			schemaVersion: 1,
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
		this.renewals.push(request);
		return {
			schemaVersion: 1,
			leaseId: request.leaseId,
			grantId: request.grantId,
			bindingId: request.bindingId,
			status: "renewed",
			recordedAt: NOW,
		};
	}

	revoke(request: TaskCredentialTargetRevokeRequest): TaskCredentialProviderReceipt {
		this.revocations.push(request);
		return {
			schemaVersion: 1,
			leaseId: request.leaseId,
			grantId: request.grantId,
			bindingId: request.bindingId,
			status: "revoked",
			recordedAt: NOW,
		};
	}
}

function makeProvider(options: {
	target?: RecordingTarget;
	revokeOutcome?: "revoked" | "revocation_unknown";
} = {}): TaskCredentialTestProvider {
	const target = options.target ?? new RecordingTarget();
	return createTaskCredentialTestProvider({
		materials: { package_registry: SENTINEL },
		now: () => NOW,
		target,
		...(options.revokeOutcome === undefined ? {} : { revokeOutcome: options.revokeOutcome }),
	});
}

/** Wrap a provider so tests can count exactly how many renews reach the issuer. */
function countingProvider(provider: TaskCredentialTestProvider): {
	provider: TaskCredentialTestProvider;
	renewCalls: () => number;
} {
	let renews = 0;
	const issuer = provider.issuer;
	const target = provider.target;
	const wrapped: TaskCredentialTestProvider = {
		issuer: {
			issue: (request) => issuer.issue(request),
			renew: (request) => {
				renews += 1;
				return issuer.renew(request);
			},
			revoke: (request) => issuer.revoke(request),
		},
		target: {
			getCapabilities: (request) => target.getCapabilities(request),
			project: (request) => target.project(request),
			renew: (request) => target.renew(request),
			revoke: (request) => target.revoke(request),
		},
		records: provider.records,
	};
	return { provider: wrapped, renewCalls: () => renews };
}

interface Harness {
	session: FakeSession;
	provider: TaskCredentialTestProvider;
	service: TaskCredentialService;
	clock: { nowMs: number };
	advance(ms: number): void;
}

/**
 * Test double for the Session's pure preflight resolver. The happy path
 * allows every operation with the bounded TTL; `denyCode` (optionally
 * scoped to `denyOperations`) makes a stable denial so tests can prove the
 * preflight runs BEFORE the provider and the store (zero issuer calls, zero
 * appends).
 */
function makePreflightResolver(options: {
	denyCode?: TaskCredentialError["code"];
	denyOperations?: ReadonlyArray<TaskCredentialPreflightOperation>;
} = {}): TaskCredentialPreflightResolver {
	return {
		resolve: (input) => {
			if (
				options.denyCode !== undefined &&
				(options.denyOperations === undefined || options.denyOperations.includes(input.operation))
			) {
				return { allowed: false, error: new TaskCredentialError(options.denyCode) };
			}
			return { allowed: true, boundedTtlMs: input.requestedTtlMs };
		},
	};
}

function makeService(options: {
	sessionId?: string;
	provider?: TaskCredentialTestProvider;
	policyMaxTtlMs?: number;
	taskDeadlineAt?: string;
	runDeadlineAt?: string;
	preflight?: TaskCredentialPreflightResolver;
	preflightDenyCode?: TaskCredentialError["code"];
	denyOperations?: ReadonlyArray<TaskCredentialPreflightOperation>;
} = {}): Harness {
	const session = new FakeSession(options.sessionId ?? "session_001");
	const provider = options.provider ?? makeProvider();
	const clock = { nowMs: Date.parse(NOW) };
	const service = new TaskCredentialService({
		session,
		provider,
		policyMaxTtlMs: options.policyMaxTtlMs ?? 300_000,
		now: () => new Date(clock.nowMs).toISOString(),
		preflight:
			options.preflight ??
			makePreflightResolver({ denyCode: options.preflightDenyCode, denyOperations: options.denyOperations }),
		...(options.taskDeadlineAt === undefined ? {} : { taskDeadlineAt: options.taskDeadlineAt }),
		...(options.runDeadlineAt === undefined ? {} : { runDeadlineAt: options.runDeadlineAt }),
	});
	return {
		session,
		provider,
		service,
		clock,
		advance(ms: number) {
			clock.nowMs += ms;
		},
	};
}

function issueContext(overrides: Partial<TaskCredentialRunIssueContext> = {}): TaskCredentialRunIssueContext {
	return {
		taskId: "task_42",
		graphRevision: 7,
		nodeId: "node_review",
		stageId: "stage_review",
		stageRevision: 3,
		runId: "run_001",
		capabilityBindingId: "capability_001",
		policyBindingId: "policy_001",
		sandboxBindingId: "policy_001",
		targetId: "target_sandbox",
		scopes: SCOPES,
		requestedTtlMs: 60_000,
		clientRequestId: "req_issue_1",
		nodeAttached: true,
		...overrides,
	};
}

function runTerminal(overrides: Partial<TaskCredentialRunTerminalInput> = {}): TaskCredentialRunTerminalInput {
	return { runId: "run_001", status: "completed", ...overrides };
}

function gateInvalidation(overrides: Partial<TaskCredentialGateInvalidationInput> = {}): TaskCredentialGateInvalidationInput {
	return {
		taskId: "task_42",
		stageId: "stage_review",
		stageRevision: 3,
		status: "rejected",
		...overrides,
	};
}

function nodeTerminal(overrides: Partial<TaskCredentialGraphNodeTerminalInput> = {}): TaskCredentialGraphNodeTerminalInput {
	return {
		taskId: "task_42",
		nodeId: "node_review",
		runId: "run_001",
		status: "failed",
		...overrides,
	};
}

function credentialEntryIds(session: FakeSession): string[] {
	return session.entries
		.filter((entry) => entry.type === "custom")
		.map((entry) => (entry as Extract<SessionEntry, { type: "custom" }>).customType);
}

/** Issue one lease through the harness and return its bound identifiers. */
function issuedLease(harness: Harness, overrides: Partial<TaskCredentialRunIssueContext> = {}): {
	leaseId: string;
	grantId: string;
	bindingId: string;
} {
	const result = harness.service.issueForTaskRun(issueContext(overrides));
	expect(result.ok).toBe(true);
	if (!result.ok) throw new Error("issue failed");
	return { leaseId: result.leaseId, grantId: result.grant.grantId, bindingId: result.bindingId };
}

/** Every custom entry ever appended by the service is a task.credential entry. */
function expectOnlyCredentialEntries(session: FakeSession): void {
	expect(credentialEntryIds(session).every((type) => type === TASK_CREDENTIAL_CUSTOM_TYPE)).toBe(true);
}

function revokedEntries(session: FakeSession): Extract<SessionEntry, { type: "custom" }>[] {
	return session.entries.filter(
		(entry): entry is Extract<SessionEntry, { type: "custom" }> =>
			entry.type === "custom" && (entry.data as { action?: string }).action === "revoked",
	);
}

describe("issueForTaskRun", () => {
	it("runs the T3 preflight BEFORE the provider, the store, and every append", () => {
		const { service, session, provider } = makeService({ preflightDenyCode: "task_credential_policy_denied" });
		const result = service.issueForTaskRun(issueContext());
		expect(result).toEqual({ ok: false, code: "task_credential_policy_denied" });
		// Zero provider calls (no issuer.issue, no projection) and zero appends.
		expect(provider.records.size).toBe(0);
		expect(session.entries).toHaveLength(0);

		// The project preflight is also gated: a delivery-capability denial
		// must never create an active grant first.
		const delivery = makeService({ preflightDenyCode: "task_credential_target_unavailable" });
		const deliveryResult = delivery.service.issueForTaskRun(issueContext());
		expect(deliveryResult).toEqual({ ok: false, code: "task_credential_target_unavailable" });
		expect(delivery.provider.records.size).toBe(0);
		expect(delivery.session.entries).toHaveLength(0);
	});

	it("fails closed without a preflight resolver (no proof, no provider, no append)", () => {
		const session = new FakeSession("session_001");
		const provider = makeProvider();
		const service = new TaskCredentialService({
			session,
			provider,
			policyMaxTtlMs: 300_000,
			now: () => NOW,
		});
		const result = service.issueForTaskRun(issueContext());
		expect(result).toEqual({ ok: false, code: "task_credential_invalid" });
		expect(provider.records.size).toBe(0);
		expect(session.entries).toHaveLength(0);
	});

	it("renew and revoke commands run their operation preflight before the store", () => {
		const harness = makeService({
			preflightDenyCode: "task_credential_policy_denied",
			// issue + project stay allowed so the lease exists; only the
			// operation preflights under test deny.
			denyOperations: ["renew", "revoke"],
		});
		const { service, provider } = harness;
		const { leaseId, grantId, bindingId } = issuedLease(harness);
		const grant = service.get(leaseId);
		expect(grant).toBeDefined();
		const renew = service.renew({
			leaseId,
			grantId,
			bindingId,
			heartbeatSequence: grant!.heartbeatSequence + 1,
			requestedTtlMs: 60_000,
			clientRequestId: "req_renew_denied",
			nodeAttached: true,
		});
		expect(renew).toEqual({ ok: false, code: "task_credential_policy_denied" });
		// Zero provider calls and zero appends for the denied renew.
		expect(provider.records.get(leaseId)?.revoked).toBe(false);

		const revoke = service.revoke({
			leaseId,
			clientRequestId: "req_revoke_denied",
			nodeAttached: true,
		});
		expect(revoke).toEqual({ ok: false, code: "task_credential_policy_denied" });
	});

	it("issues a fresh grant with a derived binding and delivers material", async () => {
		const { service, session, provider } = makeService();
		const result = service.issueForTaskRun(issueContext());
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(isTaskCredentialGrant(result.grant)).toBe(true);
		expect(result.grant.taskId).toBe("task_42");
		expect(result.grant.nodeId).toBe("node_review");
		expect(result.grant.runId).toBe("run_001");
		expect(result.grant.stageId).toBe("stage_review");
		expect(result.grant.stageRevision).toBe(3);
		expect(result.grant.status).toBe("active");
		expect(result.grant.targetId).toBe("target_sandbox");
		expect(result.grant.scopeCount).toBe(1);
		expect(result.grant.scopeDigest).toBe(calculateScopeDigest(SCOPES));
		expect(result.bindingId.startsWith("binding_")).toBe(true);
		expect(result.leaseId.startsWith("lease_")).toBe(true);
		expect(result.delivery?.status).toBe("succeeded");
		expect(provider.records.get(result.leaseId)?.revoked).toBe(false);
		expect(provider.records.get(result.leaseId)?.credentialNames).toEqual(["package_registry"]);
		expectOnlyCredentialEntries(session);
		// The persisted grant and entries carry no scope values and no material.
		expect(JSON.stringify(session.entries)).not.toContain("registry.internal");
		expect(JSON.stringify(session.entries)).not.toContain(SENTINEL);
	});

	it("replays the same grant for the same context + clientRequestId", () => {
		const { service, session } = makeService();
		const first = service.issueForTaskRun(issueContext());
		const second = service.issueForTaskRun(issueContext());
		expect(first.ok && second.ok).toBe(true);
		if (!first.ok || !second.ok) return;
		expect(second.grant.leaseId).toBe(first.grant.leaseId);
		expect(second.grant.grantId).toBe(first.grant.grantId);
		expect(second.bindingId).toBe(first.bindingId);
		expect(second.grant.status).toBe("active");
		// A replay never re-issues: exactly issue + delivery entries only.
		expect(session.entries).toHaveLength(2);
	});

	it("resume issues a NEW binding and a NEW grant; the old grant is never restored", () => {
		const { service } = makeService();
		const first = service.issueForTaskRun(issueContext());
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		const firstLeaseId = first.leaseId;
		// The source run is interrupted: its grant is revoked and settled.
		service.onRunInterrupted("run_001");
		expect(service.get(firstLeaseId)?.status).toBe("settled");
		// Resume: the new run carries a new run id; the issue must produce a
		// brand-new binding + grant, never the old one.
		const resumed = service.issueForTaskRun(
			issueContext({ runId: "run_001_resume", clientRequestId: "req_issue_resume_1" }),
		);
		expect(resumed.ok).toBe(true);
		if (!resumed.ok) return;
		expect(resumed.bindingId).not.toBe(first.bindingId);
		expect(resumed.leaseId).not.toBe(firstLeaseId);
		expect(resumed.grant.grantId).not.toBe(first.grant.grantId);
		expect(resumed.grant.runId).toBe("run_001_resume");
		expect(resumed.grant.status).toBe("active");
		// The old grant stays settled; nothing ever resurrects it.
		expect(service.get(firstLeaseId)?.status).toBe("settled");
		expect(service.get(resumed.leaseId)?.status).toBe("active");
	});

	it("fails closed without a provider and never appends", () => {
		const session = new FakeSession("session_001");
		const service = new TaskCredentialService({
			session,
			policyMaxTtlMs: 300_000,
			now: () => NOW,
		});
		const result = service.issueForTaskRun(issueContext());
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.code).toBe("task_credential_invalid");
		expect(session.entries).toHaveLength(0);
	});

	it("destroys the lease and quarantines the target when delivery fails", () => {
		const target = new RecordingTarget();
		target.status = "failed";
		const provider = makeProvider({ target });
		const { service } = makeService({ provider });
		const result = service.issueForTaskRun(issueContext());
		expect(result.ok).toBe(false);
		expect(service.isTargetQuarantined("target_sandbox")).toBe(true);
		// The issuer-side material is revoked.
		const leases = service.snapshot();
		expect(leases.length).toBe(1);
		expect(leases[0].status).toBe("settled");
		expect(provider.records.get(leases[0].leaseId)?.revoked).toBe(true);
		// A later issue onto the quarantined target fails closed.
		const retry = service.issueForTaskRun(issueContext({ clientRequestId: "req_issue_2" }));
		expect(retry.ok).toBe(false);
		if (!retry.ok) expect(retry.code).toBe("task_credential_binding_invalid");
	});

	it("an unknown delivery never leaves active material", () => {
		const target = new RecordingTarget();
		target.status = "unknown";
		const provider = makeProvider({ target });
		const { service } = makeService({ provider });
		const result = service.issueForTaskRun(issueContext());
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.code).toBe("task_credential_delivery_failed");
		expect(service.isTargetQuarantined("target_sandbox")).toBe(true);
		// No delivery receipt was recorded, so the lease stops at revoked: it is
		// never reported settled and never stays active.
		const leases = service.snapshot();
		expect(leases.length).toBe(1);
		expect(leases[0].status).toBe("revoked");
		expect(provider.records.get(leases[0].leaseId)?.revoked).toBe(true);
	});

	it("rejects invalid contexts without appending", () => {
		const { service, session } = makeService();
		const result = service.issueForTaskRun(
			issueContext({ taskId: "bad/path" }) as TaskCredentialRunIssueContext,
		);
		expect(result.ok).toBe(false);
		expect(session.entries).toHaveLength(0);
	});

	it("never issues a lease that crosses the run deadline (fail closed)", () => {
		// Deadline in 30s; a 60s TTL cannot fit inside it.
		const { service, session } = makeService({
			runDeadlineAt: "2026-08-15T12:00:30.000Z",
		});
		const result = service.issueForTaskRun(issueContext());
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.code).toBe("task_credential_ttl_invalid");
		expect(session.entries).toHaveLength(0);
	});
});

describe("run terminal signals", () => {
	function issuedRun(harness: Harness, runId = "run_001"): string {
		const result = harness.service.issueForTaskRun(issueContext({ runId, clientRequestId: `req_${runId}` }));
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("issue failed");
		return result.leaseId;
	}

	it("completed revokes and settles the run's lease with run_completed", () => {
		const harness = makeService();
		const leaseId = issuedRun(harness);
		const outcomes = harness.service.onRunTerminal(runTerminal({ status: "completed" }));
		expect(outcomes).toHaveLength(1);
		expect(outcomes[0]).toMatchObject({ leaseId, action: "revoked", settled: true, reasonCode: "run_completed" });
		expect(harness.service.get(leaseId)?.status).toBe("settled");
		expect(harness.provider.records.get(leaseId)?.revoked).toBe(true);
		expectOnlyCredentialEntries(harness.session);
	});

	it("cancelled and failed map to their own reason codes", () => {
		const cancelled = makeService();
		const cancelledLease = issuedRun(cancelled);
		const cancelOutcomes = cancelled.service.onRunTerminal(runTerminal({ status: "cancelled" }));
		expect(cancelOutcomes[0].reasonCode).toBe("run_cancelled");
		expect(cancelled.service.get(cancelledLease)?.status).toBe("settled");

		const failed = makeService();
		const failedLease = issuedRun(failed);
		const failOutcomes = failed.service.onRunTerminal(runTerminal({ status: "failed" }));
		expect(failOutcomes[0].reasonCode).toBe("run_failed");
		expect(failed.service.get(failedLease)?.status).toBe("settled");
	});

	it("deadline settles failed + run_deadline_exceeded", () => {
		const harness = makeService();
		const leaseId = issuedRun(harness);
		const outcomes = harness.service.onRunTerminal(
			runTerminal({ status: "failed", terminalErrorCode: "run_deadline_exceeded" }),
		);
		expect(outcomes[0].reasonCode).toBe("run_deadline_exceeded");
		expect(harness.service.get(leaseId)?.status).toBe("settled");
	});

	it("an unknown revoke quarantines the target and never settles", () => {
		const provider = makeProvider({ revokeOutcome: "revocation_unknown" });
		const harness = makeService({ provider });
		const leaseId = issuedRun(harness);
		const outcomes = harness.service.onRunTerminal(runTerminal({ status: "failed" }));
		expect(outcomes).toHaveLength(1);
		expect(outcomes[0]).toMatchObject({
			leaseId,
			action: "quarantined",
			settled: false,
			quarantinedTarget: "target_sandbox",
		});
		const view = harness.service.get(leaseId);
		expect(view?.status).toBe("revocation_unknown");
		expect(view?.reasonCode).toBe("run_failed");
		expect(harness.service.isTargetQuarantined("target_sandbox")).toBe(true);
		// The credential status changed but no Run fact was ever rewritten.
		expectOnlyCredentialEntries(harness.session);
	});

	it("signals are idempotent: a second terminal signal settles nothing new", () => {
		const harness = makeService();
		const leaseId = issuedRun(harness);
		harness.service.onRunTerminal(runTerminal({ status: "completed" }));
		const again = harness.service.onRunTerminal(runTerminal({ status: "completed" }));
		expect(again).toHaveLength(1);
		expect(again[0]).toMatchObject({ leaseId, action: "noop", settled: true });
		expect(harness.service.get(leaseId)?.status).toBe("settled");
		// One revoke + one settle only: issued, delivery, revoked, settled.
		const credentialEntries = harness.session.entries.filter(
			(entry) => entry.type === "custom" && (entry as Extract<SessionEntry, { type: "custom" }>).customType === TASK_CREDENTIAL_CUSTOM_TYPE,
		);
		expect(credentialEntries.length).toBe(4);
	});

	it("a run without a lease is a no-op", () => {
		const { service } = makeService();
		const outcomes = service.onRunTerminal(runTerminal({ runId: "run_unknown" }));
		expect(outcomes).toEqual([]);
	});

	it("invalid terminal inputs are rejected without appending", () => {
		const { service, session } = makeService();
		expect(service.onRunTerminal({ runId: "bad/path", status: "completed" })).toEqual([]);
		expect(service.onRunTerminal({ runId: "run_001", status: "wat" as never })).toEqual([]);
		expect(session.entries).toHaveLength(0);
	});
});

describe("run interrupted", () => {
	it("revokes with run_interrupted and settles a confirmed revoke", () => {
		const harness = makeService();
		const result = harness.service.issueForTaskRun(issueContext());
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const outcomes = harness.service.onRunInterrupted("run_001");
		expect(outcomes).toHaveLength(1);
		expect(outcomes[0]).toMatchObject({
			leaseId: result.leaseId,
			action: "revoked",
			settled: true,
			reasonCode: "run_interrupted",
		});
		expect(harness.service.get(result.leaseId)?.status).toBe("settled");
		// The revoked entry carried the interrupted reason code.
		const revoked = revokedEntries(harness.session);
		expect(revoked).toHaveLength(1);
		expect((revoked[0].data as { reasonCode?: string }).reasonCode).toBe("run_interrupted");
	});

	it("an unknown revoke leaves revocation_unknown and quarantines", () => {
		const provider = makeProvider({ revokeOutcome: "revocation_unknown" });
		const harness = makeService({ provider });
		const result = harness.service.issueForTaskRun(issueContext());
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		harness.service.onRunInterrupted("run_001");
		expect(harness.service.get(result.leaseId)?.status).toBe("revocation_unknown");
		expect(harness.service.isTargetQuarantined("target_sandbox")).toBe(true);
		// A second interrupted signal keeps the fail-closed state.
		const again = harness.service.onRunInterrupted("run_001");
		expect(again[0].action).toBe("quarantined");
		expect(harness.service.get(result.leaseId)?.status).toBe("revocation_unknown");
	});

	it("only touches leases of the interrupted run", () => {
		const harness = makeService();
		const result = harness.service.issueForTaskRun(issueContext());
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		harness.service.onRunInterrupted("run_other");
		expect(harness.service.get(result.leaseId)?.status).toBe("active");
	});
});

describe("resume never restores an old grant", () => {
	it("keeps the source grant terminal and issues a fresh grant for the successor", () => {
		const harness = makeService();
		const source = harness.service.issueForTaskRun(issueContext({ runId: "run_a" }));
		expect(source.ok).toBe(true);
		if (!source.ok) return;
		// The source run is interrupted, then the worker resumes it as run_b.
		harness.service.onRunInterrupted("run_a");
		const resumed = harness.service.issueForTaskRun(
			issueContext({ runId: "run_b", clientRequestId: "req_run_b" }),
		);
		expect(resumed.ok).toBe(true);
		if (!resumed.ok) return;
		// Same task context, different run: different binding, different grant.
		expect(resumed.bindingId).not.toBe(source.bindingId);
		expect(resumed.leaseId).not.toBe(source.leaseId);
		expect(harness.service.getByBindingId(source.bindingId)?.status).toBe("settled");
		expect(harness.service.getByBindingId(resumed.bindingId)?.status).toBe("active");
		// The old grant is never re-issued: the binding id remains unique.
		const leases = harness.service.list({ taskId: "task_42" });
		expect(leases.length).toBe(2);
	});
});

describe("session shutdown", () => {
	it("revokes and settles every outstanding lease", () => {
		const harness = makeService();
		const first = harness.service.issueForTaskRun(issueContext({ runId: "run_1", clientRequestId: "req_1" }));
		const second = harness.service.issueForTaskRun(
			issueContext({ runId: "run_2", clientRequestId: "req_2", targetId: "target_sandbox" }),
		);
		expect(first.ok && second.ok).toBe(true);
		if (!first.ok || !second.ok) return;
		const outcomes = harness.service.onSessionShutdown();
		expect(outcomes).toHaveLength(2);
		expect(outcomes.every((outcome) => outcome.settled)).toBe(true);
		expect(harness.service.get(first.leaseId)?.status).toBe("settled");
		expect(harness.service.get(second.leaseId)?.status).toBe("settled");
		expect(harness.provider.records.get(first.leaseId)?.revoked).toBe(true);
		expect(harness.provider.records.get(second.leaseId)?.revoked).toBe(true);
		// Shutdown is idempotent.
		const again = harness.service.onSessionShutdown();
		expect(again.every((outcome) => outcome.action === "noop")).toBe(true);
	});

	it("never settles an unknown revocation", () => {
		const provider = makeProvider({ revokeOutcome: "revocation_unknown" });
		const harness = makeService({ provider });
		const result = harness.service.issueForTaskRun(issueContext());
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const outcomes = harness.service.onSessionShutdown();
		expect(outcomes[0].action).toBe("quarantined");
		expect(harness.service.get(result.leaseId)?.status).toBe("revocation_unknown");
	});
});

describe("renew / heartbeat facade", () => {
	it("renews an active lease: strictly increasing sequence, immutable scope/target, no material", () => {
		const target = new RecordingTarget();
		const harness = makeService({ provider: makeProvider({ target }) });
		const { leaseId, grantId, bindingId } = issuedLease(harness);
		const before = harness.service.get(leaseId);
		expect(before?.status).toBe("active");
		expect(before?.heartbeatSequence).toBe(0);
		// revision 1: the delivery_succeeded transition after issue.
		expect(before?.revision).toBe(1);
		expect(before?.expiresAt).toBe("2026-08-15T12:01:00.000Z");
		harness.advance(10_000);
		const result = harness.service.renew({
			leaseId,
			grantId,
			bindingId,
			heartbeatSequence: 1,
			requestedTtlMs: 60_000,
			clientRequestId: "req_renew_1",
			nodeAttached: true,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.grant.leaseId).toBe(leaseId);
		expect(result.grant.grantId).toBe(grantId);
		expect(result.grant.bindingId).toBe(bindingId);
		expect(result.grant.status).toBe("active");
		expect(result.grant.heartbeatSequence).toBe(1);
		expect(result.grant.revision).toBe(2);
		expect(result.grant.expiresAt).toBe("2026-08-15T12:01:10.000Z");
		expect(result.idempotent).toBe(false);
		// Scope digest/count and target are immutable across the renewal.
		expect(result.grant.scopeDigest).toBe(before?.scopeDigest);
		expect(result.grant.scopeCount).toBe(before?.scopeCount);
		expect(result.grant.targetId).toBe(before?.targetId);
		// The issuer-side credential is still live (renew is not a revoke) and
		// no material ever reached the ledger.
		expect(harness.provider.records.get(leaseId)?.revoked).toBe(false);
		expect(JSON.stringify(harness.session.entries)).not.toContain(SENTINEL);
		expectOnlyCredentialEntries(harness.session);
		const renewed = harness.session.entries.filter(
			(entry) =>
				entry.type === "custom" && (entry.data as { action?: string }).action === "renewed",
		);
		expect(renewed).toHaveLength(1);
		// Non-external leases preserve the default-off target lifecycle.
		expect(target.renewals).toEqual([]);
	});

	it("restores external target lifecycle from the exact target kind after service reconstruction", () => {
		const target = new RecordingTarget();
		const base = makeProvider({ target });
		const issuerRenewals: TaskCredentialProviderRenewRequest[] = [];
		const issuerRevocations: TaskCredentialProviderRevokeRequest[] = [];
		const provider: TaskCredentialTestProvider = {
			issuer: {
				issue: (request) => base.issuer.issue(request),
				renew: (request) => {
					issuerRenewals.push(request);
					return base.issuer.renew(request);
				},
				revoke: (request) => {
					issuerRevocations.push(request);
					return base.issuer.revoke(request);
				},
			},
			target: base.target,
			records: base.records,
		};
		const harness = makeService({ provider });
		const externalScopes: ReadonlyArray<TaskCredentialScope> = [{
			credentialName: "package_registry",
			purpose: "dependency_read",
			resource: "registry.internal",
			operations: ["read"],
			targetKinds: ["external_connector"],
		}];
		const initialContext = issueContext({
			targetId: "target_external",
			targetKind: "external_connector",
			targetLifecycle: "external_connector",
			scopes: externalScopes,
		});
		const issued = harness.service.issueForTaskRun(initialContext);
		expect(issued.ok).toBe(true);
		if (!issued.ok) return;

		const restarted = new TaskCredentialService({
			session: harness.session,
			provider,
			preflight: makePreflightResolver(),
			policyMaxTtlMs: 300_000,
			now: () => new Date(harness.clock.nowMs).toISOString(),
		});
		// Replay the durable issue from its exact validated target kind. The
		// host-only lifecycle assertion is intentionally absent after restart.
		const replayed = restarted.issueForTaskRun(issueContext({
			targetId: "target_external",
			targetKind: "external_connector",
			scopes: externalScopes,
		}));
		expect(replayed).toMatchObject({ ok: true, idempotent: true });
		harness.advance(10_000);

		const renewed = restarted.renew({
			leaseId: issued.leaseId,
			grantId: issued.grant.grantId,
			bindingId: issued.bindingId,
			heartbeatSequence: 1,
			requestedTtlMs: 120_000,
			clientRequestId: "req_external_renew_after_restart",
			nodeAttached: true,
		});
		expect(renewed).toMatchObject({ ok: true, grant: { heartbeatSequence: 1 } });
		expect(issuerRenewals).toHaveLength(1);
		expect(target.renewals).toHaveLength(1);
		expect(issuerRenewals[0]).toMatchObject({
			leaseId: issued.leaseId,
			grantId: issued.grant.grantId,
			bindingId: issued.bindingId,
			requestedTtlMs: 120_000,
		});
		expect(target.renewals[0]).toMatchObject({
			leaseId: issued.leaseId,
			grantId: issued.grant.grantId,
			bindingId: issued.bindingId,
			targetId: "target_external",
			requestedTtlMs: 120_000,
		});
		expect(target.renewals[0]?.requestedAt).toBe(issuerRenewals[0]?.requestedAt);

		const reference = {
			schemaVersion: 1 as const,
			leaseId: issued.leaseId,
			grantId: issued.grant.grantId,
			bindingId: issued.bindingId,
			clientRequestId: initialContext.clientRequestId,
		};
		const released = restarted.releaseDeliveredLease({
			reference,
			targetId: "target_external",
			reasonCode: "run_interrupted",
		});
		expect(released).toMatchObject({ ok: true, idempotent: false, grant: { status: "settled" } });
		const replayedRelease = restarted.releaseDeliveredLease({
			reference,
			targetId: "target_external",
			reasonCode: "run_interrupted",
		});
		expect(replayedRelease).toMatchObject({ ok: true, idempotent: true, grant: { status: "settled" } });
		expect(issuerRevocations).toHaveLength(1);
		expect(target.revocations).toHaveLength(1);
		expect(target.revocations[0]).toMatchObject({
			leaseId: issued.leaseId,
			grantId: issued.grant.grantId,
			bindingId: issued.bindingId,
			targetId: "target_external",
			reasonCode: "run_interrupted",
		});
	});

	it("replays the same clientRequestId without appending a second transition", () => {
		const base = makeProvider();
		const counted = countingProvider(base);
		const harness = makeService({ provider: counted.provider });
		const { leaseId, grantId, bindingId } = issuedLease(harness);
		const input = {
			leaseId,
			grantId,
			bindingId,
			heartbeatSequence: 1,
			requestedTtlMs: 60_000,
			clientRequestId: "req_renew_same",
			nodeAttached: true,
		};
		// A renewal must strictly extend expiry, so the clock moves first.
		harness.advance(10_000);
		const first = harness.service.renew(input);
		const second = harness.service.renew(input);
		expect(first.ok && second.ok).toBe(true);
		if (!first.ok || !second.ok) return;
		expect(second.grant.grantId).toBe(first.grant.grantId);
		expect(second.idempotent).toBe(true);
		expect(harness.service.get(leaseId)?.heartbeatSequence).toBe(1);
		// The replay returned the original result without a provider call.
		expect(counted.renewCalls()).toBe(1);
		// issued + delivery + renewed only: the replay appended nothing.
		expect(harness.session.entries).toHaveLength(3);
	});

	it("rejects a stale duplicate sequence under a new clientRequestId without calling the provider", () => {
		const base = makeProvider();
		const counted = countingProvider(base);
		const harness = makeService({ provider: counted.provider });
		const { leaseId, grantId, bindingId } = issuedLease(harness);
		harness.advance(10_000);
		const first = harness.service.renew({
			leaseId,
			grantId,
			bindingId,
			heartbeatSequence: 1,
			requestedTtlMs: 60_000,
			clientRequestId: "req_renew_seq_a",
			nodeAttached: true,
		});
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		expect(first.grant.heartbeatSequence).toBe(1);
		// The same (now stale) sequence under a different request id must fail
		// closed with the stable heartbeat error, before the provider is called.
		const duplicate = harness.service.renew({
			leaseId,
			grantId,
			bindingId,
			heartbeatSequence: 1,
			requestedTtlMs: 60_000,
			clientRequestId: "req_renew_seq_b",
			nodeAttached: true,
		});
		expect(duplicate).toEqual({ ok: false, code: "task_lease_heartbeat_invalid" });
		expect(counted.renewCalls()).toBe(1);
		expect(harness.service.get(leaseId)?.heartbeatSequence).toBe(1);
		// issued + delivery + the single renewed entry only.
		expect(harness.session.entries).toHaveLength(3);
	});

	it("rejects regressions and jumps with the stable heartbeat error", () => {
		const harness = makeService();
		const { leaseId, grantId, bindingId } = issuedLease(harness);
		harness.advance(10_000);
		// Jumping ahead from sequence 0 is rejected.
		expect(
			harness.service.renew({
				leaseId,
				grantId,
				bindingId,
				heartbeatSequence: 2,
				requestedTtlMs: 60_000,
				clientRequestId: "req_renew_jump",
				nodeAttached: true,
			}),
		).toEqual({ ok: false, code: "task_lease_heartbeat_invalid" });
		// So is a sequence below the next one.
		expect(
			harness.service.renew({
				leaseId,
				grantId,
				bindingId,
				heartbeatSequence: 0,
				requestedTtlMs: 60_000,
				clientRequestId: "req_renew_regress",
				nodeAttached: true,
			}),
		).toEqual({ ok: false, code: "task_lease_heartbeat_invalid" });
		const renewed = harness.service.renew({
			leaseId,
			grantId,
			bindingId,
			heartbeatSequence: 1,
			requestedTtlMs: 60_000,
			clientRequestId: "req_renew_seq_1",
			nodeAttached: true,
		});
		expect(renewed.ok).toBe(true);
		if (!renewed.ok) return;
		// After sequence 1 landed, jumping straight to 3 is rejected too.
		expect(
			harness.service.renew({
				leaseId,
				grantId,
				bindingId,
				heartbeatSequence: 3,
				requestedTtlMs: 60_000,
				clientRequestId: "req_renew_jump_3",
				nodeAttached: true,
			}),
		).toEqual({ ok: false, code: "task_lease_heartbeat_invalid" });
		expect(harness.service.get(leaseId)?.heartbeatSequence).toBe(1);
		expect(harness.session.entries).toHaveLength(3);
	});

	it("a reused clientRequestId with a different sequence can never replay the result", () => {
		const base = makeProvider();
		const counted = countingProvider(base);
		const harness = makeService({ provider: counted.provider });
		const { leaseId, grantId, bindingId } = issuedLease(harness);
		harness.advance(10_000);
		const first = harness.service.renew({
			leaseId,
			grantId,
			bindingId,
			heartbeatSequence: 1,
			requestedTtlMs: 60_000,
			clientRequestId: "req_renew_reused",
			nodeAttached: true,
		});
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		// Same request id, different sequence: the idempotency fold must reject
		// the conflict instead of replaying the original result, so a stale
		// client can never launder a new sequence through an old request id.
		const reused = harness.service.renew({
			leaseId,
			grantId,
			bindingId,
			heartbeatSequence: 2,
			requestedTtlMs: 60_000,
			clientRequestId: "req_renew_reused",
			nodeAttached: true,
		});
		expect(reused).toEqual({ ok: false, code: "task_credential_conflict" });
		expect(counted.renewCalls()).toBe(1);
		expect(harness.service.get(leaseId)?.heartbeatSequence).toBe(1);
		expect(harness.session.entries).toHaveLength(3);
	});

	it("fails closed on a grant or binding mismatch (input must be bound)", () => {
		const harness = makeService();
		const { leaseId, grantId, bindingId } = issuedLease(harness);
		const wrongGrant = harness.service.renew({
			leaseId,
			grantId: "grant_other",
			bindingId,
			heartbeatSequence: 1,
			requestedTtlMs: 60_000,
			clientRequestId: "req_renew_bad_grant",
			nodeAttached: true,
		});
		expect(wrongGrant.ok).toBe(false);
		if (wrongGrant.ok) return;
		expect(wrongGrant.code).toBe("task_credential_conflict");
		const wrongBinding = harness.service.renew({
			leaseId,
			grantId,
			bindingId: "binding_other",
			heartbeatSequence: 1,
			requestedTtlMs: 60_000,
			clientRequestId: "req_renew_bad_binding",
			nodeAttached: true,
		});
		expect(wrongBinding.ok).toBe(false);
		if (wrongBinding.ok) return;
		expect(wrongBinding.code).toBe("task_credential_conflict");
		// Nothing was appended and the lease is untouched.
		expect(harness.service.get(leaseId)?.heartbeatSequence).toBe(0);
		expect(harness.session.entries).toHaveLength(2);
	});

	it("fails closed on terminal leases (settled) and unknown revocations", () => {
		const harness = makeService();
		const { leaseId, grantId, bindingId } = issuedLease(harness);
		harness.service.onRunTerminal(runTerminal({ status: "failed" }));
		const terminal = harness.service.renew({
			leaseId,
			grantId,
			bindingId,
			heartbeatSequence: 1,
			requestedTtlMs: 60_000,
			clientRequestId: "req_renew_terminal",
			nodeAttached: true,
		});
		expect(terminal.ok).toBe(false);
		if (terminal.ok) return;
		expect(terminal.code).toBe("task_credential_conflict");
		expect(harness.service.get(leaseId)?.status).toBe("settled");

		const provider = makeProvider({ revokeOutcome: "revocation_unknown" });
		const unknown = makeService({ provider });
		// A target-less lease: the unknown revoke quarantines nothing, so the
		// store's own deny path answers the conflict.
		const unknownLease = issuedLease(unknown, { targetId: undefined });
		unknown.service.onRunInterrupted("run_001");
		expect(unknown.service.get(unknownLease.leaseId)?.status).toBe("revocation_unknown");
		const renewUnknown = unknown.service.renew({
			leaseId: unknownLease.leaseId,
			grantId: unknownLease.grantId,
			bindingId: unknownLease.bindingId,
			heartbeatSequence: 1,
			requestedTtlMs: 60_000,
			clientRequestId: "req_renew_unknown",
			nodeAttached: true,
		});
		expect(renewUnknown.ok).toBe(false);
		if (renewUnknown.ok) return;
		expect(renewUnknown.code).toBe("task_credential_conflict");
		expect(unknown.service.get(unknownLease.leaseId)?.status).toBe("revocation_unknown");
	});

	it("fails closed on an expired lease", () => {
		const harness = makeService();
		const { leaseId, grantId, bindingId } = issuedLease(harness, { requestedTtlMs: 60_000 });
		harness.advance(120_000);
		const result = harness.service.renew({
			leaseId,
			grantId,
			bindingId,
			heartbeatSequence: 1,
			requestedTtlMs: 60_000,
			clientRequestId: "req_renew_expired",
			nodeAttached: true,
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.code).toBe("task_lease_expired");
	});

	it("fails closed when a renewed TTL would cross the run deadline", () => {
		const harness = makeService({ runDeadlineAt: "2026-08-15T12:01:30.000Z" });
		const { leaseId, grantId, bindingId } = issuedLease(harness);
		harness.advance(30_000);
		const result = harness.service.renew({
			leaseId,
			grantId,
			bindingId,
			// now + 61s would land past the 12:01:30 deadline (now + 60s).
			heartbeatSequence: 1,
			requestedTtlMs: 61_000,
			clientRequestId: "req_renew_deadline",
			nodeAttached: true,
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.code).toBe("task_credential_ttl_invalid");
		expect(harness.service.get(leaseId)?.heartbeatSequence).toBe(0);
	});

	it("fails closed on a quarantined target", () => {
		const target = new RecordingTarget();
		const harness = makeService({ provider: makeProvider({ target }) });
		const { leaseId, grantId, bindingId } = issuedLease(harness);
		// A second delivery fails: the shared target is quarantined while the
		// first lease is still active.
		target.status = "failed";
		harness.service.issueForTaskRun(issueContext({ runId: "run_002", clientRequestId: "req_issue_2" }));
		expect(harness.service.isTargetQuarantined("target_sandbox")).toBe(true);
		const result = harness.service.renew({
			leaseId,
			grantId,
			bindingId,
			heartbeatSequence: 1,
			requestedTtlMs: 60_000,
			clientRequestId: "req_renew_quarantined",
			nodeAttached: true,
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.code).toBe("task_credential_binding_invalid");
		expect(harness.service.get(leaseId)?.heartbeatSequence).toBe(0);
	});

	it("fails closed without a provider and on unknown leases", () => {
		const session = new FakeSession("session_001");
		const service = new TaskCredentialService({
			session,
			policyMaxTtlMs: 300_000,
			now: () => NOW,
		});
		expect(
			service.renew({
				leaseId: "lease_001",
				grantId: "grant_001",
				bindingId: "binding_001",
				heartbeatSequence: 1,
				requestedTtlMs: 60_000,
				clientRequestId: "req_renew_noprovider",
				nodeAttached: true,
			}),
		).toEqual({ ok: false, code: "task_credential_not_found" });

		const harness = makeService();
		expect(
			harness.service.renew({
				leaseId: "lease_missing",
				grantId: "grant_missing",
				bindingId: "binding_missing",
				heartbeatSequence: 1,
				requestedTtlMs: 60_000,
				clientRequestId: "req_renew_missing",
				nodeAttached: true,
			}),
		).toEqual({ ok: false, code: "task_credential_not_found" });
	});

	it("rejects malformed renew inputs without appending", () => {
		const harness = makeService();
		const { leaseId, grantId, bindingId } = issuedLease(harness);
		expect(
			harness.service.renew({
				leaseId: "bad/path",
				grantId,
				bindingId,
				heartbeatSequence: 1,
				requestedTtlMs: 60_000,
				clientRequestId: "req_renew_bad",
				nodeAttached: true,
			}),
		).toEqual({ ok: false, code: "task_credential_invalid" });
		expect(
			harness.service.renew({
				leaseId,
				grantId,
				bindingId,
				heartbeatSequence: 1,
				requestedTtlMs: 0,
				clientRequestId: "req_renew_bad_ttl",
				nodeAttached: true,
			}),
		).toEqual({ ok: false, code: "task_credential_invalid" });
		expect(
			harness.service.renew({
				leaseId,
				grantId,
				bindingId,
				heartbeatSequence: 1,
				requestedTtlMs: 60_000,
				clientRequestId: "req_renew_bad_extra",
				unknown: 1,
			} as never),
		).toEqual({ ok: false, code: "task_credential_invalid" });
		expect(
			harness.service.renew({
				leaseId,
				grantId,
				bindingId,
				heartbeatSequence: -1,
				requestedTtlMs: 60_000,
				clientRequestId: "req_renew_bad_seq",
				nodeAttached: true,
			}),
		).toEqual({ ok: false, code: "task_credential_invalid" });
		expect(
			harness.service.renew({
				leaseId,
				grantId,
				bindingId,
				heartbeatSequence: "1" as never,
				requestedTtlMs: 60_000,
				clientRequestId: "req_renew_bad_seq_type",
				nodeAttached: true,
			}),
		).toEqual({ ok: false, code: "task_credential_invalid" });
		expect(harness.session.entries).toHaveLength(2);
	});
});

describe("closed state (post-shutdown fail closed)", () => {
	it("issue and renew fail closed after shutdown and nothing new is appended", () => {
		const harness = makeService();
		const { leaseId, grantId, bindingId } = issuedLease(harness);
		harness.service.onSessionShutdown();
		expect(harness.service.get(leaseId)?.status).toBe("settled");
		// Shutdown itself appended the revoke + settle pair; count that baseline.
		const entriesAfterShutdown = harness.session.entries.length;
		// Reads stay available after close.
		expect(harness.service.get(leaseId)?.grantId).toBe(grantId);
		expect(harness.service.list({ runId: "run_001" })).toHaveLength(1);
		// Sensitive actions fail closed.
		const issue = harness.service.issueForTaskRun(issueContext({ clientRequestId: "req_issue_after_close" }));
		expect(issue.ok).toBe(false);
		if (issue.ok) return;
		expect(issue.code).toBe("task_credential_invalid");
		const renew = harness.service.renew({
			leaseId,
			grantId,
			bindingId,
			heartbeatSequence: 1,
			requestedTtlMs: 60_000,
			clientRequestId: "req_renew_after_close",
			nodeAttached: true,
		});
		expect(renew.ok).toBe(false);
		if (renew.ok) return;
		expect(renew.code).toBe("task_credential_invalid");
		expect(harness.session.entries).toHaveLength(entriesAfterShutdown);
		expect(harness.service.get(leaseId)?.status).toBe("settled");
		expect(harness.service.get(leaseId)?.heartbeatSequence).toBe(0);
	});

	it("shutdown stays idempotent and an unknown revocation keeps quarantine", () => {
		const provider = makeProvider({ revokeOutcome: "revocation_unknown" });
		const harness = makeService({ provider });
		const result = harness.service.issueForTaskRun(issueContext());
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const first = harness.service.onSessionShutdown();
		expect(first[0].action).toBe("quarantined");
		expect(harness.service.get(result.leaseId)?.status).toBe("revocation_unknown");
		expect(harness.service.isTargetQuarantined("target_sandbox")).toBe(true);
		// A second shutdown cannot settle the unknown lease or change the state.
		const second = harness.service.onSessionShutdown();
		expect(second[0].action).toBe("quarantined");
		expect(harness.service.get(result.leaseId)?.status).toBe("revocation_unknown");
		expect(harness.service.isTargetQuarantined("target_sandbox")).toBe(true);
		// Renewing the unknown lease after close still fails closed.
		const renew = harness.service.renew({
			leaseId: result.leaseId,
			grantId: result.grant.grantId,
			bindingId: result.bindingId,
			heartbeatSequence: 1,
			requestedTtlMs: 60_000,
			clientRequestId: "req_renew_after_close_unknown",
			nodeAttached: true,
		});
		expect(renew.ok).toBe(false);
		if (renew.ok) return;
		expect(renew.code).toBe("task_credential_invalid");
	});
});

describe("task gate invalidation", () => {
	it("revokes and settles the stage's leases with gate_rejected", () => {
		const harness = makeService();
		const result = harness.service.issueForTaskRun(issueContext());
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const outcomes = harness.service.onGateInvalidated(gateInvalidation({ status: "rejected" }));
		expect(outcomes).toHaveLength(1);
		expect(outcomes[0]).toMatchObject({
			leaseId: result.leaseId,
			reasonCode: "gate_rejected",
			settled: true,
		});
		expect(harness.service.get(result.leaseId)?.status).toBe("settled");
	});

	it("cancelled maps to gate_cancelled; other stages and tasks are untouched", () => {
		const harness = makeService();
		const result = harness.service.issueForTaskRun(issueContext());
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		harness.service.onGateInvalidated(gateInvalidation({ stageId: "stage_other", status: "cancelled" }));
		expect(harness.service.get(result.leaseId)?.status).toBe("active");
		harness.service.onGateInvalidated(gateInvalidation({ status: "cancelled" }));
		expect(harness.service.get(result.leaseId)?.status).toBe("settled");
	});
});

describe("graph node terminal", () => {
	it("revokes and settles the node's leases with the node reason code", () => {
		const harness = makeService();
		const result = harness.service.issueForTaskRun(issueContext());
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const outcomes = harness.service.onGraphNodeTerminal(nodeTerminal({ status: "failed" }));
		expect(outcomes).toHaveLength(1);
		expect(outcomes[0]).toMatchObject({
			leaseId: result.leaseId,
			reasonCode: "node_failed",
			settled: true,
		});
		expect(harness.service.get(result.leaseId)?.status).toBe("settled");
	});

	it("succeeded and cancelled map to their reason codes; foreign nodes are untouched", () => {
		const harness = makeService();
		const result = harness.service.issueForTaskRun(issueContext());
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		harness.service.onGraphNodeTerminal(nodeTerminal({ nodeId: "node_other", status: "cancelled" }));
		expect(harness.service.get(result.leaseId)?.status).toBe("active");
		harness.service.onGraphNodeTerminal(nodeTerminal({ status: "succeeded" }));
		expect(harness.service.get(result.leaseId)?.status).toBe("settled");
		const revoked = revokedEntries(harness.session);
		expect(revoked).toHaveLength(1);
		expect((revoked[0].data as { reasonCode?: string }).reasonCode).toBe("node_succeeded");
	});
});

describe("worker detach", () => {
	it("revokes and settles the detached run's leases with worker_detach", () => {
		const harness = makeService();
		const result = harness.service.issueForTaskRun(issueContext());
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const outcomes = harness.service.onWorkerDetach({ runId: "run_001" });
		expect(outcomes).toHaveLength(1);
		expect(outcomes[0]).toMatchObject({
			leaseId: result.leaseId,
			reasonCode: "worker_detach",
			settled: true,
		});
		expect(harness.service.get(result.leaseId)?.status).toBe("settled");
	});

	it("revokes by issue-time worker correlation when no run is given", () => {
		const harness = makeService();
		const workerTarget: TaskCredentialWorkerTarget = {
			project: () => ({ ok: true }),
			renew: () => ({ ok: true }),
			revoke: () => ({ ok: true }),
		};
		const result = harness.service.issueForTaskRun(issueContext({ workerId: "worker_001", workerTarget }));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const outcomes = harness.service.onWorkerDetach({ workerId: "worker_001" });
		expect(outcomes).toHaveLength(1);
		expect(outcomes[0].reasonCode).toBe("worker_detach");
		expect(harness.service.get(result.leaseId)?.status).toBe("settled");
	});

	it("invalid or empty inputs are no-ops", () => {
		const { service } = makeService();
		expect(service.onWorkerDetach({})).toEqual([]);
		expect(service.onWorkerDetach({ runId: "bad/path" })).toEqual([]);
		expect(service.onWorkerDetach({ workerId: "bad/path" })).toEqual([]);
	});
});

describe("service contract safety", () => {
	it("never rewrites Run / Gate / Graph ledgers: only task.credential entries are appended", () => {
		const harness = makeService();
		const result = harness.service.issueForTaskRun(issueContext());
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		harness.service.onRunTerminal(runTerminal({ status: "cancelled" }));
		harness.service.onGateInvalidated(gateInvalidation({ status: "rejected" }));
		harness.service.onGraphNodeTerminal(nodeTerminal({ status: "failed" }));
		harness.service.onWorkerDetach({ runId: "run_001" });
		expectOnlyCredentialEntries(harness.session);
	});

	it("a terminal grant is never resurrected by any later signal", () => {
		const harness = makeService();
		const result = harness.service.issueForTaskRun(issueContext());
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		harness.service.onRunTerminal(runTerminal({ status: "completed" }));
		expect(harness.service.get(result.leaseId)?.status).toBe("settled");
		// Every later signal keeps the terminal state.
		harness.service.onRunInterrupted("run_001");
		harness.service.onSessionShutdown();
		harness.service.onWorkerDetach({ runId: "run_001" });
		harness.service.onGateInvalidated(gateInvalidation({ status: "cancelled" }));
		const view = harness.service.get(result.leaseId);
		expect(view?.status).toBe("settled");
		expect(view?.revision).toBe(3); // issued, revoked, settled — never more
	});

	it("signals never throw on store failures (no provider)", () => {
		const session = new FakeSession("session_001");
		const service = new TaskCredentialService({
			session,
			policyMaxTtlMs: 300_000,
			now: () => NOW,
		});
		expect(service.onRunTerminal(runTerminal({ status: "completed" }))).toEqual([]);
		expect(service.onRunInterrupted("run_001")).toEqual([]);
		expect(service.onSessionShutdown()).toEqual([]);
		expect(service.onWorkerDetach({ runId: "run_001" })).toEqual([]);
	});

	it("rejects invalid service options", () => {
		const session = new FakeSession("session_001");
		expect(() => new TaskCredentialService({ session, policyMaxTtlMs: 0 } as TaskCredentialServiceOptions)).toThrow(
			TaskCredentialError,
		);
		expect(
			() =>
				new TaskCredentialService({
					session,
					provider: makeProvider(),
					policyMaxTtlMs: 300_000,
					unknown: 1,
				} as never),
		).toThrow(TaskCredentialError);
	});

	it("lease expiry still settles on lifecycle signals (auto-expire path)", () => {
		const harness = makeService();
		const result = harness.service.issueForTaskRun(issueContext({ requestedTtlMs: 60_000 }));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		harness.advance(120_000);
		const outcomes = harness.service.onRunTerminal(runTerminal({ status: "failed" }));
		expect(outcomes[0].settled).toBe(true);
		expect(harness.service.get(result.leaseId)?.status).toBe("settled");
	});
});
