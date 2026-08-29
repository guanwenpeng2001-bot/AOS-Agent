/**
 * Task Credential / Lease lifecycle service (T4).
 *
 * Session-scoped facade that owns the {@link TaskCredentialStore} and turns
 * host lifecycle signals into fail-closed revoke / quarantine / settle
 * operations:
 *
 * - Run terminal (`completed` / `failed` / `cancelled`, including the
 *   deadline path which settles `failed` + `run_deadline_exceeded`) revokes
 *   and settles every lease of the run.
 * - Run interrupted (an accepted/running Run recovered without a terminal
 *   receipt) revokes with `run_interrupted`, quarantines the target when the
 *   provider cannot confirm, and settles only a confirmed revoke.
 * - Resume never restores an old grant: {@link issueForTaskRun} derives a
 *   fresh deterministic execution binding per run context and issues a brand
 *   new grant; the source run's grant stays terminal (revoked/settled).
 * - Every issue / renew / revoke command runs the frozen T3 preflight
 *   ({@link resolveTaskCredentialPreflight}) through the injected pure
 *   Session resolver BEFORE the provider, the store, and every append: the
 *   resolver supplies the real policy decision, approval state, capability
 *   target facts, per-binding sandbox facts, and provider scope, and any
 *   unresolvable fact fails closed with the frozen provider-neutral code.
 *   Issue additionally preflights the `project` operation so a target that
 *   cannot receive a confirmed delivery never creates an active grant. The
 *   first cancel request of a Run revokes its live leases before the
 *   terminal transition (settlement stays with the terminal event).
 * - Heartbeat / renew is a material-free facade over the store + provider
 *   contract, bound to the lease and its current grant/binding, that fails
 *   closed on deadline, terminal, unknown, quarantined-target, closed, and
 *   provider-less states and never exposes provider material.
 * - Session shutdown closes the service first (every later issue / renew
 *   fails closed) and then revokes and settles every outstanding lease;
 *   shutdown stays idempotent and best-effort, and an unknown revocation
 *   keeps its quarantine / `revocation_unknown` state.
 * - Task Gate invalidation (rejected / cancelled) revokes and settles every
 *   lease bound to the gate's task stage.
 * - Task Graph node terminal revokes and settles every lease bound to the
 *   node / run.
 * - Worker detach revokes and settles every lease bound to the worker (or
 *   run) and quarantines unconfirmed targets.
 *
 * The service is a pure side-channel of the existing lifecycle ledgers: it
 * never rewrites RunStatus / RunReceipt / Gate / Graph terminal facts and it
 * never resurrects a terminal grant. Every write goes through the session
 * single-writer as a `task.credential` custom entry (the store), and every
 * signal is idempotent and best-effort: a signal never throws into the host
 * lifecycle and never surfaces material, provider text, paths, or raw
 * payloads. Without a provider every operation fails closed (no lease is
 * ever issued, so signals become no-ops).
 *
 * Erasable TypeScript only (no enums, namespaces, parameter properties, or
 * dynamic imports); no `any`; no `Date.now` (the clock is injected).
 */

import { createHash } from "node:crypto";

import type {
	TaskCredentialGatePreflight,
	TaskCredentialPreflightOperation,
	TaskCredentialPreflightResult,
} from "./execution-policy.ts";
import {
	TASK_CREDENTIAL_MIN_TTL_MS,
	TASK_CREDENTIAL_STATUS,
	TaskCredentialError,
	calculateScopeDigest,
	isTaskCredentialIdentifier,
	isTaskCredentialIsoTimestamp,
	normalizeTaskCredentialScopes,
	validateTaskExecutionBinding,
	type TaskCredentialDeliveryReceipt,
	type TaskCredentialErrorCode,
	type TaskCredentialGrant,
	type TaskCredentialScope,
	type TaskCredentialStatus,
	type TaskCredentialTtlBounds,
	type TaskExecutionBinding,
} from "./task-credential-lease.ts";
import type { TaskCredentialProvider } from "./task-credential-provider.ts";
import {
	validateOperationWorkerLeaseProjection,
	validateOperationWorkerLeaseReference,
	type SafeLeaseProjection,
	type SafeLeaseReference,
} from "./worker-protocol.ts";
import {
	TaskCredentialStore,
	type TaskCredentialSession,
	type TaskCredentialStoreResult,
	type TaskCredentialWarning,
} from "./task-credential-store.ts";

// ---- Public types ----------------------------------------------------------

/** Stable reason codes persisted on lifecycle revokes (never free text). */
export type TaskCredentialLifecycleReasonCode =
	| "run_completed"
	| "run_failed"
	| "run_cancelled"
	| "run_deadline_exceeded"
	| "run_interrupted"
	| "session_shutdown"
	| "gate_rejected"
	| "gate_cancelled"
	| "node_succeeded"
	| "node_failed"
	| "node_cancelled"
	| "worker_detach";

const TASK_CREDENTIAL_LIFECYCLE_REASON_CODES: ReadonlySet<TaskCredentialLifecycleReasonCode> = new Set([
	"run_completed",
	"run_failed",
	"run_cancelled",
	"run_deadline_exceeded",
	"run_interrupted",
	"session_shutdown",
	"gate_rejected",
	"gate_cancelled",
	"node_succeeded",
	"node_failed",
	"node_cancelled",
	"worker_detach",
]);

/** Outcome of one lease handled by a lifecycle signal. */
export interface TaskCredentialSignalOutcome {
	readonly leaseId: string;
	readonly grantId: string;
	/** What the signal did to this lease. */
	readonly action: "revoked" | "settled" | "quarantined" | "noop";
	/** True when the lease is `settled` after the signal (confirmed revoke -> settle). */
	readonly settled: boolean;
	readonly reasonCode?: TaskCredentialLifecycleReasonCode;
	/** Target quarantined because the revoke outcome was unknown or delivery failed. */
	readonly quarantinedTarget?: string;
}

export interface TaskCredentialServiceOptions {
	/** Session surface; `SessionManager` satisfies it. */
	readonly session: TaskCredentialSession;
	/** Credential provider owning material; absent fails closed. */
	readonly provider?: TaskCredentialProvider;
	/** Optional safe-reference Worker targets, indexed by Worker identity. */
	readonly workerTargets?: ReadonlyMap<string, TaskCredentialWorkerTarget>;
	/** Optional default safe-reference Worker target for this Session. */
	readonly workerTarget?: TaskCredentialWorkerTarget;
	/**
	 * Pure T3 preflight resolver supplied by the Session; absent fails every
	 * issue / renew / revoke command closed (no operation can be proven
	 * authorized before the provider or the store is touched).
	 */
	readonly preflight?: TaskCredentialPreflightResolver;
	/** Policy ceiling for any lease TTL (host-configured; required, positive). */
	readonly policyMaxTtlMs: number;
	/** Task deadline; a lease TTL may never cross it (fail closed). */
	readonly taskDeadlineAt?: string;
	/** Run deadline; a lease TTL may never cross it (fail closed). */
	readonly runDeadlineAt?: string;
	/** Server timestamp source; must return a canonical UTC ISO timestamp. */
	readonly now?: () => string;
	readonly diagnostics?: (warning: TaskCredentialWarning) => void;
}

/** Material-free result returned by a Worker credential target. */
export interface TaskCredentialWorkerTargetResult {
	readonly ok: boolean;
}

/**
 * Host-side bridge to one trusted Worker target. The target receives only the
 * protocol's safe lease references; it never receives scopes, bindings,
 * provider receipts, or credential material.
 */
export interface TaskCredentialWorkerTarget {
	project(lease: SafeLeaseProjection): TaskCredentialWorkerTargetResult;
	renew(lease: SafeLeaseProjection): TaskCredentialWorkerTargetResult;
	revoke(lease: SafeLeaseReference): TaskCredentialWorkerTargetResult;
}

/**
 * Read-only T3 preflight facts input for one Task Credential operation. The
 * service supplies the frozen execution binding, the normalized scope facts,
 * the canonical service-clock timestamp, and the host-resolvable Gate /
 * node-attach facts; the Session resolver supplies the frozen policy,
 * capability, sandbox, and provider facts and runs the frozen preflight.
 */
export interface TaskCredentialPreflightFactsInput {
	readonly operation: TaskCredentialPreflightOperation;
	/** The frozen Task Execution Binding of the lease or request. */
	readonly binding: TaskExecutionBinding;
	/** Resolved Gate fact; the preflight requires it when the binding has a stage pair. */
	readonly gate?: TaskCredentialGatePreflight;
	/** Resolved graph node attach fact; a detached node never passes. */
	readonly nodeAttached: boolean;
	/**
	 * Validated credential target kind (host command field); when absent the
	 * resolver derives it only when the scopes declare exactly one distinct
	 * target kind, otherwise it fails closed.
	 */
	readonly targetKind?: string;
	/** Normalized requested scope allowlist (deduped, sorted, structurally valid). */
	readonly scopes: ReadonlyArray<TaskCredentialScope>;
	/** Canonical digest of the normalized scope allowlist. */
	readonly scopeDigest: string;
	/** Length of the normalized scope allowlist; must equal `scopes.length`. */
	readonly scopeCount: number;
	readonly requestedTtlMs: number;
	/**
	 * Canonical UTC ISO timestamp from the service clock (injected `now()`);
	 * the resolver uses it for the provider capability snapshot and the T3
	 * `nowMs` fact, so the Host preflight can never ignore the service clock.
	 */
	readonly requestedAt: string;
}

/**
 * Host-supplied pure Task Credential preflight resolver. The service builds
 * the frozen execution binding and the normalized scope facts and asks the
 * resolver for the frozen T3 preflight decision; the resolver resolves the
 * Gate / node-attach facts and the Session's frozen policy, capability,
 * sandbox, and provider facts and runs {@link resolveTaskCredentialPreflight}
 * without writing the Session, preparing a binding, or touching the
 * provider's material paths. Every unresolvable fact fails closed with the
 * frozen provider-neutral code. Without a resolver every issue / renew /
 * revoke command fails closed.
 */
export interface TaskCredentialPreflightResolver {
	resolve(input: TaskCredentialPreflightFactsInput): TaskCredentialPreflightResult;
}

/** Execution context of one task run; the service derives the binding from it. */
export interface TaskCredentialRunIssueContext {
	readonly taskId: string;
	readonly graphRevision: number;
	readonly nodeId: string;
	readonly stageId?: string;
	readonly stageRevision?: number;
	readonly runId: string;
	readonly capabilityBindingId: string;
	readonly policyBindingId: string;
	readonly sandboxBindingId?: string;
	readonly targetId?: string;
	readonly targetKind?: string;
	readonly workerId?: string;
	/** Optional transient Worker bridge; never serialized into the binding. */
	readonly workerTarget?: TaskCredentialWorkerTarget;
	/** External-target assertion; lifecycle is derived from the validated exact target kind. */
	readonly targetLifecycle?: "external_connector";
	readonly scopes: ReadonlyArray<TaskCredentialScope>;
	readonly requestedTtlMs: number;
	readonly clientRequestId: string;
	/** Resolved Gate fact (host-resolvable); required when a stage pair is present. */
	readonly gate?: TaskCredentialGatePreflight;
	/** Resolved graph node attach fact; a detached node never issues. */
	readonly nodeAttached: boolean;
}

export type TaskCredentialServiceIssueResult =
	| {
			readonly ok: true;
			readonly grant: TaskCredentialGrant;
			readonly leaseId: string;
			readonly bindingId: string;
			/** True when this result replays an already durable issue (same context + clientRequestId). */
			readonly idempotent: boolean;
			readonly delivery?: TaskCredentialDeliveryReceipt;
	  }
	| { readonly ok: false; readonly code: TaskCredentialErrorCode };

export interface TaskCredentialRunTerminalInput {
	readonly runId: string;
	readonly status: "completed" | "failed" | "cancelled";
	/** Persisted terminal error code; `run_deadline_exceeded` distinguishes deadline. */
	readonly terminalErrorCode?: string;
}

export interface TaskCredentialGateInvalidationInput {
	readonly taskId: string;
	readonly stageId: string;
	readonly stageRevision: number;
	readonly status: "rejected" | "cancelled";
}

export interface TaskCredentialGraphNodeTerminalInput {
	readonly taskId: string;
	readonly nodeId: string;
	readonly runId: string;
	readonly status: "succeeded" | "failed" | "cancelled";
}

export interface TaskCredentialWorkerDetachInput {
	readonly runId?: string;
	readonly workerId?: string;
}

/**
 * Material-free heartbeat / renew request for one active lease. The input
 * is bound to the lease AND its current grant/binding: every identifier must
 * match the folded grant or the renew fails closed (no provider call, no
 * append). `heartbeatSequence` must be the exact next sequence of the
 * current grant (`grant.heartbeatSequence + 1`): a duplicate, regression, or
 * skip is rejected with `task_lease_heartbeat_invalid` before any provider
 * call or append, while a replay with the same `clientRequestId` and
 * identical payload still returns the original result. `requestedTtlMs`
 * extends from the service clock and may never cross the policy ceiling or
 * the earliest Task / Run deadline.
 */
export interface TaskCredentialRenewInput {
	readonly leaseId: string;
	readonly grantId: string;
	readonly bindingId: string;
	/** Must equal the current grant's `heartbeatSequence + 1`; stale sequences fail closed. */
	readonly heartbeatSequence: number;
	readonly requestedTtlMs: number;
	readonly clientRequestId: string;
	/** Resolved Gate fact of the lease's binding (host-resolvable). */
	readonly gate?: TaskCredentialGatePreflight;
	/** Resolved graph node attach fact of the lease's binding (host-resolvable). */
	readonly nodeAttached: boolean;
}

export type TaskCredentialServiceRenewResult =
	| {
			readonly ok: true;
			readonly grant: TaskCredentialGrant;
			readonly leaseId: string;
			readonly bindingId: string;
			/** True when the same clientRequestId already renewed this lease (no new entry). */
			readonly idempotent: boolean;
	  }
	| { readonly ok: false; readonly code: TaskCredentialErrorCode };

/** `task.credential.revoke` input; bound to one lease of the current Session. */
export interface TaskCredentialServiceRevokeInput {
	readonly leaseId: string;
	/** Reject-only stable short code; never free text, path, or payload. */
	readonly reasonCode?: string;
	readonly clientRequestId: string;
	/** Resolved Gate fact of the lease's binding (host-resolvable). */
	readonly gate?: TaskCredentialGatePreflight;
	/** Resolved graph node attach fact of the lease's binding (host-resolvable). */
	readonly nodeAttached: boolean;
}

/** `task.credential.settle` input; bound to one lease of the current Session. */
export interface TaskCredentialServiceSettleInput {
	readonly leaseId: string;
	/** Reject-only stable short code; never free text, path, or payload. */
	readonly reasonCode?: string;
	readonly clientRequestId: string;
}

export type TaskCredentialServiceMutationResult =
	| {
			readonly ok: true;
			readonly grant: TaskCredentialGrant;
			/** True when this result replays an already durable mutation (same clientRequestId + payload). */
			readonly idempotent: boolean;
	  }
	| { readonly ok: false; readonly code: TaskCredentialErrorCode };

/** Exact safe reference used by the External Connector Host boundary. */
export interface TaskCredentialDeliveredLeaseReference {
	readonly projection: SafeLeaseProjection;
	readonly targetId: string;
}

/** Read-only Host lookup of a currently usable delivered lease. */
export type TaskCredentialDeliveredLeaseLookupResult =
	| {
			readonly ok: true;
			readonly grant: TaskCredentialGrant;
			readonly delivery: TaskCredentialDeliveryReceipt;
			readonly projection: SafeLeaseProjection;
	  }
	| { readonly ok: false; readonly code: TaskCredentialErrorCode };

export interface TaskCredentialDeliveredLeaseReleaseInput {
	readonly reference: SafeLeaseReference;
	readonly targetId: string;
	readonly reasonCode: TaskCredentialLifecycleReasonCode;
}


const TASK_CREDENTIAL_SERVICE_REQUEST_PREFIX = "lc_";
const TASK_CREDENTIAL_SERVICE_BINDING_PREFIX = "binding_";
const TASK_CREDENTIAL_SERVICE_LEASE_PREFIX = "lease_";
const TASK_CREDENTIAL_SERVICE_GRANT_PREFIX = "grant_";

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
	return Object.keys(value).every((key) => allowed.has(key));
}

function isPositiveSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isOptionalIdentifier(value: unknown): value is string | undefined {
	return value === undefined || isTaskCredentialIdentifier(value);
}

function isTaskCredentialGatePreflight(value: unknown): value is TaskCredentialGatePreflight {
	if (value === undefined) return true;
	if (!isRecord(value) || !hasOnlyKeys(value, new Set(["status", "stageRevision"]))) return false;
	return (
		(value.status === "pending" ||
			value.status === "approved" ||
			value.status === "rejected" ||
			value.status === "cancelled") &&
		isPositiveSafeInteger(value.stageRevision)
	);
}

function isScopeList(value: unknown): value is ReadonlyArray<TaskCredentialScope> {
	return Array.isArray(value) && value.length > 0;
}

function isTaskCredentialStatus(value: unknown): value is TaskCredentialStatus {
	return TASK_CREDENTIAL_STATUS.includes(value as TaskCredentialStatus);
}

function isWorkerTarget(value: unknown): value is TaskCredentialWorkerTarget {
	if (!isRecord(value)) return false;
	return typeof value.project === "function" && typeof value.renew === "function" && typeof value.revoke === "function";
}

/**
 * Deterministic, collision-safe request id for one lease transition. The same
 * lease + reason always derives the same id, so a replayed signal replays the
 * store transition (idempotent) instead of creating a new one, while a
 * different lease or reason always derives a different id (no cross-lease
 * idempotency collisions).
 */
function lifecycleRequestId(leaseId: string, reasonCode: string): string {
	const digest = createHash("sha256").update(`${leaseId}\u0000${reasonCode}`, "utf8").digest("hex");
	return `${TASK_CREDENTIAL_SERVICE_REQUEST_PREFIX}${digest}`;
}

/**
 * Deterministic execution binding id for a task run context. The id is a
 * digest of every correlation field of the context (including the scope
 * digest), so the same context always maps to the same binding (issue replays
 * return the original grant) while a resume — a new run id, binding, stage, or
 * scope set — always maps to a NEW binding and can never restore the old
 * grant. The digest never contains scope values, paths, or material.
 */
function bindingIdForContext(
	context: TaskCredentialRunIssueContext,
	scopeDigest: string,
	scopeCount: number,
): string {
	const canonical = JSON.stringify({
		taskId: context.taskId,
		graphRevision: context.graphRevision,
		nodeId: context.nodeId,
		stageId: context.stageId ?? null,
		stageRevision: context.stageRevision ?? null,
		runId: context.runId,
		capabilityBindingId: context.capabilityBindingId,
		policyBindingId: context.policyBindingId,
		sandboxBindingId: context.sandboxBindingId ?? null,
		targetId: context.targetId ?? null,
		workerId: context.workerId ?? null,
		scopeDigest,
		scopeCount,
	});
	const digest = createHash("sha256").update(canonical, "utf8").digest("hex");
	return `${TASK_CREDENTIAL_SERVICE_BINDING_PREFIX}${digest}`;
}

/**
 * Deterministic lease id of one task run context. Derives from the same
 * correlation fields as the binding id, so the same context replays the
 * original lease while a resume (a new run id) maps to a brand new lease.
 */
function leaseIdForContext(context: TaskCredentialRunIssueContext, scopeDigest: string, scopeCount: number): string {
	const digest = createHash("sha256")
		.update(
			JSON.stringify({
				taskId: context.taskId,
				graphRevision: context.graphRevision,
				nodeId: context.nodeId,
				runId: context.runId,
				capabilityBindingId: context.capabilityBindingId,
				policyBindingId: context.policyBindingId,
				scopeDigest,
				scopeCount,
			}),
			"utf8",
		)
		.digest("hex");
	return `${TASK_CREDENTIAL_SERVICE_LEASE_PREFIX}${digest}`;
}

/** Deterministic grant id: one lease, one issue request (replay-safe). */
function grantIdForContext(leaseId: string, clientRequestId: string): string {
	const digest = createHash("sha256").update(`${leaseId}\u0000${clientRequestId}`, "utf8").digest("hex");
	return `${TASK_CREDENTIAL_SERVICE_GRANT_PREFIX}${digest}`;
}

function reasonCodeForRun(
	status: "completed" | "failed" | "cancelled",
	terminalErrorCode: string | undefined,
): TaskCredentialLifecycleReasonCode {
	if (status === "cancelled") return "run_cancelled";
	if (terminalErrorCode === "run_deadline_exceeded") return "run_deadline_exceeded";
	if (status === "failed") return "run_failed";
	return "run_completed";
}

function reasonCodeForGate(status: "rejected" | "cancelled"): TaskCredentialLifecycleReasonCode {
	return status === "rejected" ? "gate_rejected" : "gate_cancelled";
}

function reasonCodeForNode(status: "succeeded" | "failed" | "cancelled"): TaskCredentialLifecycleReasonCode {
	switch (status) {
		case "succeeded":
			return "node_succeeded";
		case "failed":
			return "node_failed";
		case "cancelled":
			return "node_cancelled";
	}
}

/**
 * Session-scoped Task Credential lifecycle service. Owns the store and the
 * provider and translates host lifecycle signals into revoke / quarantine /
 * settle operations. All signals are idempotent and best-effort: they never
 * throw, never rewrite Run / Gate / Graph ledgers, and never resurrect a
 * terminal grant. After {@link onSessionShutdown} the service is closed:
 * it stays readable, but issue and renew fail closed and only best-effort
 * revoke / settle signals keep running.
 */
export class TaskCredentialService {
	readonly sessionId: string;
	private readonly store: TaskCredentialStore | undefined;
	private readonly preflightResolver: TaskCredentialPreflightResolver | undefined;
	private readonly policyMaxTtlMs: number;
	private readonly taskDeadlineAtMs: number | undefined;
	private readonly runDeadlineAtMs: number | undefined;
	private readonly nowFn: () => string;
	private readonly quarantinedTargets = new Set<string>();
	/** Issue-time worker correlation (grants carry no worker id); lost on restart. */
	private readonly workerByLeaseId = new Map<string, string>();
	/** Issue-time Worker target bridge; lost on restart so old targets cannot revive. */
	private readonly workerTargetByLeaseId = new Map<string, TaskCredentialWorkerTarget>();
	/** Per-request fence for safe Worker projection/revoke calls. */
	private readonly workerRequestKeys = new Set<string>();
	private readonly workerTargets: ReadonlyMap<string, TaskCredentialWorkerTarget> | undefined;
	private readonly defaultWorkerTarget: TaskCredentialWorkerTarget | undefined;
	/**
	 * Issue-time execution facts per live lease: the frozen binding and the
	 * normalized scope allowlist with its digest/count. In-memory only, never
	 * serialized, never exported: the persisted Grant deliberately keeps only
	 * `scopeDigest`/`scopeCount`, so after a reload/restart the scope facts of
	 * a recovered lease are unknowable and every later issue / renew / revoke
	 * command on it fails closed instead of widening or guessing scopes.
	 */
	private readonly issueFactsByLeaseId = new Map<
		string,
		{
			readonly binding: TaskExecutionBinding;
			readonly scopes: ReadonlyArray<TaskCredentialScope>;
			readonly scopeDigest: string;
			readonly scopeCount: number;
			readonly targetKind?: string;
		}
	>();
	/**
	 * Session shutdown (dispose) was observed. The service stays readable but
	 * every sensitive action (issue / renew) fails closed from here on; only
	 * best-effort revoke / settle signals keep running, so outstanding grants
	 * can still be torn down and shutdown stays idempotent.
	 */
	private isClosed = false;

	constructor(options: TaskCredentialServiceOptions) {
		if (
			!isRecord(options) ||
			!hasOnlyKeys(
				options,
				new Set([
					"session",
					"provider",
					"workerTargets",
					"workerTarget",
					"preflight",
					"policyMaxTtlMs",
					"taskDeadlineAt",
					"runDeadlineAt",
					"now",
					"diagnostics",
				]),
			)
		) {
			throw new TaskCredentialError("task_credential_invalid");
		}
		if (!isPositiveSafeInteger(options.policyMaxTtlMs)) {
			throw new TaskCredentialError("task_credential_invalid");
		}
		if (options.workerTarget !== undefined && !isWorkerTarget(options.workerTarget)) {
			throw new TaskCredentialError("task_credential_invalid");
		}
		if (options.workerTargets !== undefined) {
			if (typeof options.workerTargets.get !== "function" || typeof options.workerTargets[Symbol.iterator] !== "function") {
				throw new TaskCredentialError("task_credential_invalid");
			}
			for (const [workerId, target] of options.workerTargets) {
				if (!isTaskCredentialIdentifier(workerId) || !isWorkerTarget(target)) {
					throw new TaskCredentialError("task_credential_invalid");
				}
			}
		}
		if (options.taskDeadlineAt !== undefined && !isTaskCredentialIsoTimestamp(options.taskDeadlineAt)) {
			throw new TaskCredentialError("task_credential_invalid");
		}
		if (options.runDeadlineAt !== undefined && !isTaskCredentialIsoTimestamp(options.runDeadlineAt)) {
			throw new TaskCredentialError("task_credential_invalid");
		}
		this.sessionId = options.session.getSessionId();
		this.preflightResolver = options.preflight;
		this.workerTargets = options.workerTargets;
		this.defaultWorkerTarget = options.workerTarget;
		this.policyMaxTtlMs = options.policyMaxTtlMs;
		this.taskDeadlineAtMs = options.taskDeadlineAt === undefined ? undefined : Date.parse(options.taskDeadlineAt);
		this.runDeadlineAtMs = options.runDeadlineAt === undefined ? undefined : Date.parse(options.runDeadlineAt);
		this.nowFn = options.now ?? (() => new Date().toISOString());
		// Without a provider every operation fails closed: no lease is ever
		// issued and every signal becomes a no-op.
		this.store =
			options.provider === undefined
				? undefined
				: new TaskCredentialStore(options.session, options.provider, {
						...(options.now === undefined ? {} : { now: options.now }),
						...(options.diagnostics === undefined ? {} : { diagnostics: options.diagnostics }),
					});
	}

	// ---- Read-only surface --------------------------------------------------

	/** Complete snapshot of every grant in this Session (read-only fold). */
	snapshot(): ReadonlyArray<TaskCredentialGrant> {
		return this.safeSnapshot();
	}

	/** List grants of the current Session with optional filters. Read-only. */
	list(filter: {
		taskId?: string;
		nodeId?: string;
		runId?: string;
		status?: string;
		limit?: number;
	} = {}): ReadonlyArray<TaskCredentialGrant> {
		const status = filter.status === undefined || isTaskCredentialStatus(filter.status) ? filter.status : undefined;
		let grants = this.safeSnapshot();
		if (filter.taskId !== undefined) grants = grants.filter((grant) => grant.taskId === filter.taskId);
		if (filter.nodeId !== undefined) grants = grants.filter((grant) => grant.nodeId === filter.nodeId);
		if (filter.runId !== undefined) grants = grants.filter((grant) => grant.runId === filter.runId);
		if (status !== undefined) grants = grants.filter((grant) => grant.status === status);
		if (filter.limit !== undefined && Number.isSafeInteger(filter.limit) && filter.limit > 0) {
			grants = grants.slice(0, filter.limit);
		}
		return grants;
	}

	/** Read one lease by leaseId. Read-only; never appends. */
	get(leaseId: string): TaskCredentialGrant | undefined {
		return this.safeGet(leaseId);
	}

	/** Current lease of this Session by binding id. Read-only; never appends. */
	getByBindingId(bindingId: string): TaskCredentialGrant | undefined {
		if (!isTaskCredentialIdentifier(bindingId)) return undefined;
		if (this.store === undefined) return undefined;
		try {
			const grants = this.store.getByBindingId(bindingId);
			return grants.length === 0 ? undefined : grants[grants.length - 1];
		} catch {
			return undefined;
		}
	}

	/** Current leases of this Session by run id. Read-only; never appends. */
	getByRunId(runId: string): ReadonlyArray<TaskCredentialGrant> {
		if (!isTaskCredentialIdentifier(runId)) return [];
		return this.safeSnapshot().filter((grant) => grant.runId === runId);
	}

	/**
	 * Resolve only a currently active, successfully delivered lease. This is
	 * the restart authority used by External Connectors; it reads the durable
	 * credential fold and never restores material or calls the provider.
	 */
	lookupDeliveredLease(
		input: TaskCredentialDeliveredLeaseReference,
	): TaskCredentialDeliveredLeaseLookupResult {
		if (
			!isRecord(input) ||
			!hasOnlyKeys(input, new Set(["projection", "targetId"])) ||
			!validateOperationWorkerLeaseProjection(input.projection) ||
			!isTaskCredentialIdentifier(input.targetId)
		) {
			return { ok: false, code: "task_credential_invalid" };
		}
		const grant = this.safeGet(input.projection.leaseId);
		if (grant === undefined) return { ok: false, code: "task_credential_not_found" };
		let observedAt: string;
		try {
			observedAt = this.nextTimestamp();
		} catch {
			return { ok: false, code: "task_credential_persistence_failed" };
		}
		if (
			grant.grantId !== input.projection.grantId ||
			grant.bindingId !== input.projection.bindingId ||
			grant.scopeDigest !== input.projection.scopeDigest ||
			grant.targetId !== input.targetId ||
			Date.parse(input.projection.expiresAt) > Date.parse(grant.expiresAt)
		) {
			return { ok: false, code: "task_credential_conflict" };
		}
		if (Date.parse(observedAt) >= Date.parse(grant.expiresAt)) {
			return { ok: false, code: "task_lease_expired" };
		}
		if (grant.status === "expired") return { ok: false, code: "task_lease_expired" };
		if (grant.status !== "active") return { ok: false, code: "task_credential_conflict" };
		let delivery: TaskCredentialDeliveryReceipt | undefined;
		try {
			delivery = this.store?.getDeliveryReceipt(grant.leaseId);
		} catch {
			return { ok: false, code: "task_credential_persistence_failed" };
		}
		if (
			delivery === undefined ||
			delivery.status !== "succeeded" ||
			delivery.leaseId !== grant.leaseId ||
			delivery.grantId !== grant.grantId ||
			delivery.bindingId !== grant.bindingId ||
			delivery.targetId !== input.targetId
		) {
			return { ok: false, code: "task_credential_delivery_failed" };
		}
		return {
			ok: true,
			grant,
			delivery,
			projection: Object.freeze({
				...input.projection,
				expiresAt: grant.expiresAt,
			}),
		};
	}

	/**
	 * Revoke and settle one exact delivered lease without command preflight.
	 * This teardown path remains available after restart when issue-time scope
	 * facts are intentionally absent, and repeated calls are idempotent.
	 */
	releaseDeliveredLease(
		input: TaskCredentialDeliveredLeaseReleaseInput,
	): TaskCredentialServiceMutationResult {
		if (
			!isRecord(input) ||
			!hasOnlyKeys(input, new Set(["reference", "targetId", "reasonCode"])) ||
			!validateOperationWorkerLeaseReference(input.reference) ||
			!isTaskCredentialIdentifier(input.targetId) ||
			!TASK_CREDENTIAL_LIFECYCLE_REASON_CODES.has(input.reasonCode)
		) {
			return { ok: false, code: "task_credential_invalid" };
		}
		const grant = this.safeGet(input.reference.leaseId);
		if (grant === undefined) return { ok: false, code: "task_credential_not_found" };
		if (
			grant.grantId !== input.reference.grantId ||
			grant.bindingId !== input.reference.bindingId ||
			grant.targetId !== input.targetId
		) {
			return { ok: false, code: "task_credential_conflict" };
		}
		this.revokeAndSettleLease(grant.leaseId, input.reasonCode, true);
		const released = this.safeGet(grant.leaseId);
		if (released?.status !== "settled") {
			return {
				ok: false,
				code: released?.status === "revocation_unknown"
					? "task_credential_revocation_unknown"
					: "task_credential_persistence_failed",
			};
		}
		return { ok: true, grant: released, idempotent: grant.status === "settled" };
	}

	/** Whether a target is quarantined; quarantined targets fail closed. */
	isTargetQuarantined(targetId: string): boolean {
		return this.quarantinedTargets.has(targetId);
	}

	// ---- Issue (new binding / new grant; never restores an old grant) ------

	/**
	 * Issue a fresh credential grant for one task run. The execution binding
	 * is derived deterministically from the run context, so the same context +
	 * clientRequestId replays the original grant, while a resume (a new run
	 * id) always produces a NEW binding and a NEW grant. The old grant is
	 * never touched here: it stays in the ledger exactly as it is — this
	 * method never restores or resurrects it.
	 *
	 * The T3 preflight runs for BOTH `issue` and `project` as the first step,
	 * before the provider, the store, and every append: the project preflight
	 * proves the delivery capabilities (per-binding isolation, short-lived
	 * delivery, delivery receipts, provider delivery scope), so a missing
	 * delivery capability can never create an active grant first. After the
	 * `issued` entry lands, the lease material is projected onto the target
	 * (provider `project`). A failed or unknown delivery quarantines
	 * the target and destroys the lease (revoke + settle), so a lease can
	 * never stay active without a confirmed delivery.
	 */
	issueForTaskRun(context: TaskCredentialRunIssueContext): TaskCredentialServiceIssueResult {
		if (!this.validateIssueContext(context)) return { ok: false, code: "task_credential_invalid" };
		if (this.isClosed) return { ok: false, code: "task_credential_invalid" };
		if (this.store === undefined) return { ok: false, code: "task_credential_invalid" };
		if (context.targetId !== undefined && this.quarantinedTargets.has(context.targetId)) {
			return { ok: false, code: "task_credential_binding_invalid" };
		}
		if (context.workerId !== undefined && this.quarantinedTargets.has(context.workerId)) {
			return { ok: false, code: "task_credential_target_unavailable" };
		}
		let normalizedScopes: ReadonlyArray<TaskCredentialScope>;
		try {
			normalizedScopes = normalizeTaskCredentialScopes(context.scopes);
		} catch {
			return { ok: false, code: "task_credential_invalid" };
		}
		const scopeDigest = calculateScopeDigest(normalizedScopes);
		const workerTarget = this.resolveWorkerTarget(context.workerId, context.workerTarget);
		if (workerTarget === null) return { ok: false, code: "task_credential_target_unavailable" };
		const bindingId = bindingIdForContext(context, scopeDigest, normalizedScopes.length);
		const leaseId = leaseIdForContext(context, scopeDigest, normalizedScopes.length);
		const grantId = grantIdForContext(leaseId, context.clientRequestId);
		let binding: TaskExecutionBinding;
		try {
			binding = this.buildBinding(context, bindingId);
		} catch {
			return { ok: false, code: "task_credential_binding_invalid" };
		}
		// T3 preflight (issue AND project) before the provider, the store, and
		// every append: the project preflight proves the delivery capabilities
		// (per-binding isolation, short-lived delivery, delivery receipts, and
		// the provider's declared delivery scope), so a target that cannot
		// receive a confirmed projection never creates an active grant first.
		const issuePreflight = this.resolveOperationPreflight(
			"issue",
			binding,
			context.gate,
			context.nodeAttached,
			context.targetKind,
			normalizedScopes,
			scopeDigest,
			normalizedScopes.length,
			context.requestedTtlMs,
		);
		if (!issuePreflight.allowed) return { ok: false, code: issuePreflight.error.code };
		const projectPreflight = this.resolveOperationPreflight(
			"project",
			binding,
			context.gate,
			context.nodeAttached,
			context.targetKind,
			normalizedScopes,
			scopeDigest,
			normalizedScopes.length,
			context.requestedTtlMs,
		);
		if (!projectPreflight.allowed) return { ok: false, code: projectPreflight.error.code };
		let issued: TaskCredentialStoreResult;
		try {
			issued = this.store.issue({
				leaseId,
				grantId,
				binding,
				scopes: normalizedScopes,
				requestedTtlMs: context.requestedTtlMs,
				ttlBounds: this.ttlBounds(),
				clientRequestId: context.clientRequestId,
			});
		} catch (error) {
			return { ok: false, code: this.mapErrorCode(error) };
		}
		// The execution facts stay in-memory for the lease's renew / revoke
		// preflights; they are never serialized and never exported.
		this.issueFactsByLeaseId.set(issued.grant.leaseId, {
			binding,
			scopes: [...normalizedScopes],
			scopeDigest,
			scopeCount: normalizedScopes.length,
			...(context.targetKind === undefined ? {} : { targetKind: context.targetKind }),
		});
		if (context.workerId !== undefined) {
			this.workerByLeaseId.set(issued.grant.leaseId, context.workerId);
			if (workerTarget !== undefined) this.workerTargetByLeaseId.set(issued.grant.leaseId, workerTarget);
		}
		try {
			if (!issued.idempotent && workerTarget !== undefined && !this.workerProject(issued.grant, context.clientRequestId, workerTarget)) {
				this.quarantineWorker(issued.grant.leaseId);
				this.revokeAndSettleLease(issued.grant.leaseId, "run_interrupted");
				return { ok: false, code: "task_credential_target_unavailable" };
			}
			const projected = this.store.project({
				leaseId: issued.grant.leaseId,
				...(context.targetId === undefined ? {} : { targetId: context.targetId }),
				clientRequestId: context.clientRequestId,
			});
			// `project` always answers with a delivery receipt (`succeeded` /
			// `failed`); `unknown` outcomes throw and land in the catch below.
			const receipt = projected.receipt;
			if (receipt.status !== "succeeded") {
				// A confirmed `failed` delivery never leaves active material either.
				this.revokeAndSettleLease(issued.grant.leaseId, "run_interrupted");
				this.quarantineWorker(issued.grant.leaseId);
				if (context.targetId !== undefined) this.quarantinedTargets.add(context.targetId);
				return { ok: false, code: "task_credential_delivery_failed" };
			}
			return {
				ok: true,
				grant: issued.grant,
				leaseId: issued.grant.leaseId,
				bindingId,
				idempotent: issued.idempotent,
				delivery: receipt,
			};
		} catch (error) {
			// The lease is active but the delivery never landed: destroy it and
			// quarantine the target (fail closed; never leave active material
			// without a confirmed delivery).
			this.revokeAndSettleLease(issued.grant.leaseId, "run_interrupted");
			this.quarantineWorker(issued.grant.leaseId);
			if (context.targetId !== undefined) this.quarantinedTargets.add(context.targetId);
			return { ok: false, code: this.mapErrorCode(error) };
		}
	}

	// ---- Lifecycle signals --------------------------------------------------

	/** Run reached a terminal status: revoke + settle every lease of the run. */
	onRunTerminal(input: TaskCredentialRunTerminalInput): readonly TaskCredentialSignalOutcome[] {
		if (!this.validateRunTerminalInput(input)) return [];
		return this.revokeAndSettleByFilter({ runId: input.runId }, reasonCodeForRun(input.status, input.terminalErrorCode));
	}

	/**
	 * Run interrupted (recovered without a terminal receipt): revoke with
	 * `run_interrupted`. A confirmed revoke is settled; an unknown revoke
	 * leaves the lease `revocation_unknown` (fail closed) and quarantines the
	 * target until a provider-confirmed reconciliation.
	 */
	onRunInterrupted(runId: string): readonly TaskCredentialSignalOutcome[] {
		if (!isTaskCredentialIdentifier(runId)) return [];
		return this.revokeAndSettleByFilter({ runId }, "run_interrupted");
	}

	/**
	 * The first cancel request of a Run was recorded: revoke every live lease
	 * of the run BEFORE the terminal transition, so issuer-side material is
	 * destroyed as soon as the cancel intent exists. Never settles here: the
	 * unique terminal event (a later settle) settles the revoked leases, and
	 * the intent observer never rewrites a Run fact. Best-effort and
	 * idempotent: an unknown revoke quarantines the target, an already
	 * terminal lease is a no-op, and a provider-less store degrades to a
	 * noop. Never throws.
	 */
	onRunCancelRequested(runId: string): readonly TaskCredentialSignalOutcome[] {
		if (!isTaskCredentialIdentifier(runId)) return [];
		const outcomes: TaskCredentialSignalOutcome[] = [];
		for (const grant of this.safeSnapshot()) {
			if (grant.runId !== runId) continue;
			outcomes.push(...this.revokeLeaseOnCancelRequested(grant.leaseId));
		}
		return outcomes;
	}

	/** Task Gate invalidation (rejected / cancelled): revoke + settle the task stage's leases. */
	onGateInvalidated(input: TaskCredentialGateInvalidationInput): readonly TaskCredentialSignalOutcome[] {
		if (!this.validateGateInvalidationInput(input)) return [];
		return this.revokeAndSettleByFilter(
			{ taskId: input.taskId, stageId: input.stageId, stageRevision: input.stageRevision },
			reasonCodeForGate(input.status),
		);
	}

	/** Task Graph node terminal: revoke + settle every lease of the node / run. */
	onGraphNodeTerminal(input: TaskCredentialGraphNodeTerminalInput): readonly TaskCredentialSignalOutcome[] {
		if (!this.validateGraphNodeTerminalInput(input)) return [];
		return this.revokeAndSettleByFilter(
			{ taskId: input.taskId, nodeId: input.nodeId, runId: input.runId },
			reasonCodeForNode(input.status),
		);
	}

	/** Worker detach: revoke + settle every lease of the worker (or run). */
	onWorkerDetach(input: TaskCredentialWorkerDetachInput): readonly TaskCredentialSignalOutcome[] {
		if (!isRecord(input) || !hasOnlyKeys(input, new Set(["runId", "workerId"]))) return [];
		if (!isOptionalIdentifier(input.runId) || !isOptionalIdentifier(input.workerId)) return [];
		if (input.runId === undefined && input.workerId === undefined) return [];
		const outcomes: TaskCredentialSignalOutcome[] = [];
		const seen = new Set<string>();
		for (const grant of this.safeSnapshot()) {
			if (input.runId !== undefined && grant.runId === input.runId) seen.add(grant.leaseId);
			if (input.workerId !== undefined && this.workerByLeaseId.get(grant.leaseId) === input.workerId) {
				seen.add(grant.leaseId);
			}
		}
		for (const leaseId of seen) {
			outcomes.push(...this.revokeAndSettleLease(leaseId, "worker_detach"));
		}
		return outcomes;
	}

	/**
	 * Heartbeat / renew facade: extend one active lease through the existing
	 * store + provider contract without ever exposing provider material. The
	 * input is bound to the lease and its current grant/binding (a mismatched
	 * identifier fails closed), the current scope / target stay immutable, the
	 * client-supplied `heartbeatSequence` must be the exact next sequence of
	 * the current grant (a duplicate, regression, or skip fails closed with
	 * `task_lease_heartbeat_invalid` before any provider call or append), and
	 * deadline, terminal (revoked / settled / expired), revocation_unknown,
	 * quarantined-target, closed, and provider-less states all fail closed. A
	 * replay with the same clientRequestId and identical payload returns the
	 * original result without appending again; the sequence cannot be bypassed
	 * by replaying a reused request id with a different payload.
	 */
	renew(input: TaskCredentialRenewInput): TaskCredentialServiceRenewResult {
		if (!this.validateRenewInput(input)) return { ok: false, code: "task_credential_invalid" };
		if (this.isClosed) return { ok: false, code: "task_credential_invalid" };
		if (this.store === undefined) return { ok: false, code: "task_credential_not_found" };
		const grant = this.safeGet(input.leaseId);
		if (grant === undefined) return { ok: false, code: "task_credential_not_found" };
		if (input.grantId !== grant.grantId || input.bindingId !== grant.bindingId) {
			return { ok: false, code: "task_credential_conflict" };
		}
		// A quarantined target never receives a renewed lease: fail closed.
		if (grant.targetId !== undefined && this.quarantinedTargets.has(grant.targetId)) {
			return { ok: false, code: "task_credential_binding_invalid" };
		}
		// T3 renew preflight: the lease's in-memory execution facts (binding +
		// normalized scopes) are required; after a reload/restart they are
		// unknowable and the renew fails closed instead of widening or
		// guessing scopes, and the current scope/target stay immutable.
		const facts = this.issueFactsByLeaseId.get(input.leaseId);
		if (facts === undefined) return { ok: false, code: "task_credential_invalid" };
		const renewPreflight = this.resolveOperationPreflight(
			"renew",
			facts.binding,
			input.gate,
			input.nodeAttached,
			facts.targetKind,
			facts.scopes,
			facts.scopeDigest,
			facts.scopeCount,
			input.requestedTtlMs,
		);
		if (!renewPreflight.allowed) return { ok: false, code: renewPreflight.error.code };
		try {
			const result = this.store.renew({
				leaseId: input.leaseId,
				heartbeatSequence: input.heartbeatSequence,
				requestedTtlMs: input.requestedTtlMs,
				ttlBounds: this.ttlBounds(),
				clientRequestId: input.clientRequestId,
				...(this.hasExternalTargetLifecycle(input.leaseId)
					? { targetLifecycle: "external_connector" as const }
					: {}),
			});
			const workerTarget = this.workerTargetByLeaseId.get(input.leaseId);
			if (workerTarget !== undefined && !this.workerRenew(result.grant, input.clientRequestId, workerTarget)) {
				this.quarantineWorker(input.leaseId);
				this.revokeAndSettleLease(input.leaseId, "run_interrupted");
				return { ok: false, code: "task_credential_target_unavailable" };
			}
			return {
				ok: true,
				grant: result.grant,
				leaseId: result.grant.leaseId,
				bindingId: result.grant.bindingId,
				idempotent: result.idempotent,
			};
		} catch (error) {
			if (error instanceof TaskCredentialError && error.code === "task_credential_delivery_failed") {
				this.revokeAndSettleLease(input.leaseId, "run_interrupted");
			}
			return { ok: false, code: this.mapErrorCode(error) };
		}
	}

	// ---- Command-plane operations (host task.credential.* commands) --------

	/**
	 * `task.credential.revoke`: revoke one lease of this Session through the
	 * store + provider contract. A provider-confirmed revoke persists
	 * `revoked`; an unknown outcome persists `revocation_unknown` (fail
	 * closed). Idempotent on `clientRequestId` + payload: a replay returns
	 * the original grant. Never surfaces material or provider text; without a
	 * provider the operation fails closed.
	 */
	revoke(input: TaskCredentialServiceRevokeInput): TaskCredentialServiceMutationResult {
		if (!this.validateRevokeInput(input)) return { ok: false, code: "task_credential_invalid" };
		if (this.store === undefined) return { ok: false, code: "task_credential_not_found" };
		// T3 revoke preflight for the command plane: the lease's in-memory
		// execution facts (binding + normalized scopes) are required and the
		// decision is authorized against the lease's current TTL; after a
		// reload/restart the scope facts are unknowable and the revoke command
		// fails closed BEFORE the store is touched (an existing lease without
		// issue facts never falls through to store.revoke). Lifecycle revokes
		// (run terminal / interrupted / gate / node / worker detach / session
		// shutdown / cancel intent) stay best-effort and never run a policy
		// preflight, so teardown can never be blocked by a denial.
		const grant = this.safeGet(input.leaseId);
		if (grant !== undefined) {
			const facts = this.issueFactsByLeaseId.get(input.leaseId);
			if (facts === undefined) return { ok: false, code: "task_credential_invalid" };
			const revokePreflight = this.resolveOperationPreflight(
				"revoke",
				facts.binding,
				input.gate,
				input.nodeAttached,
				facts.targetKind,
				facts.scopes,
				facts.scopeDigest,
				facts.scopeCount,
				this.leaseTtlMs(grant),
			);
			if (!revokePreflight.allowed) return { ok: false, code: revokePreflight.error.code };
		}
		const workerTarget = this.workerTargetByLeaseId.get(input.leaseId);
		if (grant !== undefined && workerTarget !== undefined && !this.workerRevoke(grant, input.clientRequestId, workerTarget)) {
			this.quarantineWorker(input.leaseId);
		}
		try {
			const result = this.store.revoke({
				leaseId: input.leaseId,
				...(input.reasonCode === undefined ? {} : { reasonCode: input.reasonCode }),
				clientRequestId: input.clientRequestId,
				...(this.hasExternalTargetLifecycle(input.leaseId)
					? { targetLifecycle: "external_connector" as const }
					: {}),
			});
			return { ok: true, grant: result.grant, idempotent: result.idempotent };
		} catch (error) {
			return { ok: false, code: this.mapErrorCode(error) };
		}
	}

	/**
	 * `task.credential.settle`: settle a terminal lease of this Session
	 * locally with a safe receipt; the issuer is not touched. Legal only
	 * after a delivery receipt AND a provider-confirmed revoke; `active`,
	 * `expired`, and `revocation_unknown` never settle. Idempotent on
	 * `clientRequestId` + payload; without a provider the operation fails
	 * closed.
	 */
	settle(input: TaskCredentialServiceSettleInput): TaskCredentialServiceMutationResult {
		if (!this.validateSettleInput(input)) return { ok: false, code: "task_credential_invalid" };
		if (this.store === undefined) return { ok: false, code: "task_credential_not_found" };
		try {
			const result = this.store.settle({
				leaseId: input.leaseId,
				...(input.reasonCode === undefined ? {} : { reasonCode: input.reasonCode }),
				clientRequestId: input.clientRequestId,
			});
			return { ok: true, grant: result.grant, idempotent: result.idempotent };
		} catch (error) {
			return { ok: false, code: this.mapErrorCode(error) };
		}
	}
	onSessionShutdown(): readonly TaskCredentialSignalOutcome[] {
		// Close first: a reentrant issue / renew during teardown fails closed,
		// while the revoke / settle loop below stays best-effort and idempotent.
		this.isClosed = true;
		const outcomes: TaskCredentialSignalOutcome[] = [];
		for (const grant of this.safeSnapshot()) {
			outcomes.push(...this.revokeAndSettleLease(grant.leaseId, "session_shutdown"));
		}
		return outcomes;
	}

	// ---- Internals ---------------------------------------------------------

	private buildBinding(context: TaskCredentialRunIssueContext, bindingId: string): TaskExecutionBinding {
		const binding: TaskExecutionBinding = {
			schemaVersion: 1,
			bindingId,
			sessionId: this.sessionId,
			taskId: context.taskId,
			graphRevision: context.graphRevision,
			nodeId: context.nodeId,
			runId: context.runId,
			capabilityBindingId: context.capabilityBindingId,
			policyBindingId: context.policyBindingId,
			createdAt: this.nextTimestamp(),
			bindingRevision: 1,
		};
		if (context.stageId !== undefined) (binding as { stageId?: string }).stageId = context.stageId;
		if (context.stageRevision !== undefined) (binding as { stageRevision?: number }).stageRevision = context.stageRevision;
		if (context.sandboxBindingId !== undefined) {
			(binding as { sandboxBindingId?: string }).sandboxBindingId = context.sandboxBindingId;
		}
		if (context.targetId !== undefined) (binding as { targetId?: string }).targetId = context.targetId;
		if (context.workerId !== undefined) (binding as { workerId?: string }).workerId = context.workerId;
		validateTaskExecutionBinding(binding);
		return binding;
	}

	/** TTL bounds for one lease: policy ceiling and the earliest task/run deadline. */
	private ttlBounds(): TaskCredentialTtlBounds {
		const bounds: TaskCredentialTtlBounds = {
			minTtlMs: TASK_CREDENTIAL_MIN_TTL_MS,
			maxTtlMs: this.policyMaxTtlMs,
		};
		const deadlineMs = this.earliestDeadlineMs();
		if (deadlineMs !== undefined) (bounds as { deadlineAtMs?: number }).deadlineAtMs = deadlineMs;
		return bounds;
	}

	/** Earliest of the Task and Run deadlines; a lease TTL may never cross it. */
	private earliestDeadlineMs(): number | undefined {
		const candidates: number[] = [];
		if (this.taskDeadlineAtMs !== undefined) candidates.push(this.taskDeadlineAtMs);
		if (this.runDeadlineAtMs !== undefined) candidates.push(this.runDeadlineAtMs);
		if (candidates.length === 0) return undefined;
		return Math.min(...candidates);
	}

	private validateIssueContext(context: TaskCredentialRunIssueContext): boolean {
		if (
			!isRecord(context) ||
			!hasOnlyKeys(
				context,
				new Set([
					"taskId",
					"graphRevision",
					"nodeId",
					"stageId",
					"stageRevision",
					"runId",
					"capabilityBindingId",
					"policyBindingId",
					"sandboxBindingId",
					"targetId",
					"targetKind",
					"workerId",
					"workerTarget",
					"targetLifecycle",
					"scopes",
					"requestedTtlMs",
					"clientRequestId",
					"gate",
					"nodeAttached",
				]),
			)
		) {
			return false;
		}
		return (
			isTaskCredentialIdentifier(context.taskId) &&
			isPositiveSafeInteger(context.graphRevision) &&
			isTaskCredentialIdentifier(context.nodeId) &&
			isOptionalIdentifier(context.stageId) &&
			(context.stageRevision === undefined || isPositiveSafeInteger(context.stageRevision)) &&
			isTaskCredentialIdentifier(context.runId) &&
			isTaskCredentialIdentifier(context.capabilityBindingId) &&
			isTaskCredentialIdentifier(context.policyBindingId) &&
			isOptionalIdentifier(context.sandboxBindingId) &&
			isOptionalIdentifier(context.targetId) &&
			isOptionalIdentifier(context.targetKind) &&
			isOptionalIdentifier(context.workerId) &&
			(context.workerTarget === undefined || isWorkerTarget(context.workerTarget)) &&
			(context.targetLifecycle === undefined ||
				(context.targetLifecycle === "external_connector" && context.targetKind === "external_connector")) &&
			isScopeList(context.scopes) &&
			isPositiveSafeInteger(context.requestedTtlMs) &&
			isTaskCredentialIdentifier(context.clientRequestId) &&
			context.clientRequestId.length <= 128 &&
			isTaskCredentialGatePreflight(context.gate) &&
			typeof context.nodeAttached === "boolean"
		);
	}

	private validateRunTerminalInput(input: TaskCredentialRunTerminalInput): boolean {
		if (!isRecord(input) || !hasOnlyKeys(input, new Set(["runId", "status", "terminalErrorCode"]))) return false;
		if (!isTaskCredentialIdentifier(input.runId)) return false;
		if (input.status !== "completed" && input.status !== "failed" && input.status !== "cancelled") return false;
		return input.terminalErrorCode === undefined || isTaskCredentialIdentifier(input.terminalErrorCode);
	}

	private validateGateInvalidationInput(input: TaskCredentialGateInvalidationInput): boolean {
		if (!isRecord(input) || !hasOnlyKeys(input, new Set(["taskId", "stageId", "stageRevision", "status"]))) {
			return false;
		}
		if (
			!isTaskCredentialIdentifier(input.taskId) ||
			!isTaskCredentialIdentifier(input.stageId) ||
			!isPositiveSafeInteger(input.stageRevision)
		) {
			return false;
		}
		return input.status === "rejected" || input.status === "cancelled";
	}

	private validateGraphNodeTerminalInput(input: TaskCredentialGraphNodeTerminalInput): boolean {
		if (!isRecord(input) || !hasOnlyKeys(input, new Set(["taskId", "nodeId", "runId", "status"]))) {
			return false;
		}
		if (
			!isTaskCredentialIdentifier(input.taskId) ||
			!isTaskCredentialIdentifier(input.nodeId) ||
			!isTaskCredentialIdentifier(input.runId)
		) {
			return false;
		}
		return input.status === "succeeded" || input.status === "failed" || input.status === "cancelled";
	}

	private validateRenewInput(input: TaskCredentialRenewInput): boolean {
		if (
			!isRecord(input) ||
			!hasOnlyKeys(
				input,
				new Set([
					"leaseId",
					"grantId",
					"bindingId",
					"heartbeatSequence",
					"requestedTtlMs",
					"clientRequestId",
					"gate",
					"nodeAttached",
				]),
			)
		) {
			return false;
		}
		return (
			isTaskCredentialIdentifier(input.leaseId) &&
			isTaskCredentialIdentifier(input.grantId) &&
			isTaskCredentialIdentifier(input.bindingId) &&
			isNonNegativeSafeInteger(input.heartbeatSequence) &&
			isPositiveSafeInteger(input.requestedTtlMs) &&
			isTaskCredentialIdentifier(input.clientRequestId) &&
			input.clientRequestId.length <= 128 &&
			isTaskCredentialGatePreflight(input.gate) &&
			typeof input.nodeAttached === "boolean"
		);
	}

	private validateRevokeInput(input: TaskCredentialServiceRevokeInput): boolean {
		if (!isRecord(input) || !hasOnlyKeys(input, new Set(["leaseId", "reasonCode", "clientRequestId", "gate", "nodeAttached"]))) {
			return false;
		}
		return (
			isTaskCredentialIdentifier(input.leaseId) &&
			(input.reasonCode === undefined || isTaskCredentialIdentifier(input.reasonCode)) &&
			isTaskCredentialIdentifier(input.clientRequestId) &&
			input.clientRequestId.length <= 128 &&
			isTaskCredentialGatePreflight(input.gate) &&
			typeof input.nodeAttached === "boolean"
		);
	}

	private validateSettleInput(input: TaskCredentialServiceSettleInput): boolean {
		if (!isRecord(input) || !hasOnlyKeys(input, new Set(["leaseId", "reasonCode", "clientRequestId"]))) {
			return false;
		}
		return (
			isTaskCredentialIdentifier(input.leaseId) &&
			(input.reasonCode === undefined || isTaskCredentialIdentifier(input.reasonCode)) &&
			isTaskCredentialIdentifier(input.clientRequestId) &&
			input.clientRequestId.length <= 128
		);
	}

	/**
	 * Run the frozen T3 preflight for one operation through the injected
	 * resolver. The resolver is pure and fail-closed: it resolves the Gate /
	 * node-attach facts and the Session's frozen policy / capability / sandbox
	 * / provider facts and runs {@link resolveTaskCredentialPreflight}; a
	 * missing resolver or a throwing resolver fails closed with
	 * `task_credential_invalid` and never fabricates an allow.
	 */
	private resolveOperationPreflight(
		operation: TaskCredentialPreflightOperation,
		binding: TaskExecutionBinding,
		gate: TaskCredentialGatePreflight | undefined,
		nodeAttached: boolean,
		targetKind: string | undefined,
		scopes: ReadonlyArray<TaskCredentialScope>,
		scopeDigest: string,
		scopeCount: number,
		requestedTtlMs: number,
	): TaskCredentialPreflightResult {
		if (this.preflightResolver === undefined) {
			return { allowed: false, error: new TaskCredentialError("task_credential_invalid") };
		}
		try {
			// The canonical service clock is the preflight's `now` fact: the
			// resolver must never substitute its own wall clock.
			const requestedAt = this.nextTimestamp();
			return this.preflightResolver.resolve({
				operation,
				binding,
				...(gate === undefined ? {} : { gate }),
				nodeAttached,
				...(targetKind === undefined ? {} : { targetKind }),
				scopes,
				scopeDigest,
				scopeCount,
				requestedTtlMs,
				requestedAt,
			});
		} catch {
			return { allowed: false, error: new TaskCredentialError("task_credential_invalid") };
		}
	}

	/** Current TTL of one lease (issuedAt -> expiresAt); used for the revoke preflight facts. */
	private leaseTtlMs(grant: TaskCredentialGrant): number {
		return Date.parse(grant.expiresAt) - Date.parse(grant.issuedAt);
	}

	/** Exact validated target kind is the single lifecycle authority. */
	private hasExternalTargetLifecycle(leaseId: string): boolean {
		return this.issueFactsByLeaseId.get(leaseId)?.targetKind === "external_connector";
	}

	private revokeAndSettleByFilter(
		filter: {
			taskId?: string;
			nodeId?: string;
			runId?: string;
			stageId?: string;
			stageRevision?: number;
		},
		reasonCode: TaskCredentialLifecycleReasonCode,
	): readonly TaskCredentialSignalOutcome[] {
		const outcomes: TaskCredentialSignalOutcome[] = [];
		for (const grant of this.safeSnapshot()) {
			if (filter.runId !== undefined && grant.runId !== filter.runId) continue;
			if (filter.taskId !== undefined && grant.taskId !== filter.taskId) continue;
			if (filter.nodeId !== undefined && grant.nodeId !== filter.nodeId) continue;
			if (filter.stageId !== undefined && (grant.stageId ?? undefined) !== filter.stageId) continue;
			if (filter.stageRevision !== undefined && (grant.stageRevision ?? undefined) !== filter.stageRevision) continue;
			outcomes.push(...this.revokeAndSettleLease(grant.leaseId, reasonCode));
		}
		return outcomes;
	}

	/**
	 * Revoke one lease and settle it when the revoke is confirmed (or the
	 * lease is already revoked/expired). An unknown revoke leaves the lease
	 * `revocation_unknown` and quarantines its target. Never throws: every
	 * failure degrades to a `noop` outcome so a lifecycle signal can never
	 * break the host path that fired it.
	 */
	private revokeAndSettleLease(
		leaseId: string,
		reasonCode: TaskCredentialLifecycleReasonCode,
		forceExternalTarget = false,
	): readonly TaskCredentialSignalOutcome[] {
		const outcomes: TaskCredentialSignalOutcome[] = [];
		const grant = this.safeGet(leaseId);
		if (grant === undefined) return outcomes;
		const grantId = grant.grantId;
		if (grant.status === "settled") {
			outcomes.push({ leaseId, grantId, action: "noop", settled: true });
			return outcomes;
		}
		// Preserve the existing non-external expired path. External targets must
		// still be revoked because their projected material can outlive the Host
		// lease record until the target confirms teardown.
		const externalTarget = forceExternalTarget || this.hasExternalTargetLifecycle(leaseId);
		if (grant.status === "revoked" || (grant.status === "expired" && !externalTarget)) {
			if (this.safeSettle(leaseId)) {
				outcomes.push({ leaseId, grantId, action: "settled", settled: true, reasonCode });
			} else {
				outcomes.push({ leaseId, grantId, action: "noop", settled: false });
			}
			return outcomes;
		}
		if (grant.status === "revocation_unknown") {
			// Fail closed: an unknown revocation is never reported as settled.
			const targetId = grant.targetId;
			if (targetId !== undefined) this.quarantinedTargets.add(targetId);
			this.quarantineWorker(leaseId);
			outcomes.push({
				leaseId,
				grantId,
				action: "quarantined",
				settled: false,
				reasonCode,
				...(targetId === undefined ? {} : { quarantinedTarget: targetId }),
			});
			return outcomes;
		}
		if (this.store === undefined) {
			// No provider: the revoke cannot be performed; degrade to a noop.
			outcomes.push({ leaseId, grantId, action: "noop", settled: false, reasonCode });
			return outcomes;
		}
		const workerTarget = this.workerTargetByLeaseId.get(leaseId);
		if (workerTarget !== undefined && !this.workerRevoke(grant, lifecycleRequestId(leaseId, reasonCode), workerTarget)) {
			this.quarantineWorker(leaseId);
		}
		// Active / renewing: revoke, then settle on a confirmed outcome.
		let confirmed = false;
		try {
			const result = this.store.revoke({
				leaseId,
				reasonCode,
				clientRequestId: lifecycleRequestId(leaseId, reasonCode),
				...(externalTarget
					? { targetLifecycle: "external_connector" as const }
					: {}),
			});
			confirmed = result.grant.status === "revoked";
		} catch {
			// The revoke failed (conflict, persistence): degrade to a noop; the
			// lease stays non-terminal in the ledger and a later signal (or a
			// restart) can retry it.
			outcomes.push({ leaseId, grantId, action: "noop", settled: false, reasonCode });
			return outcomes;
		}
		if (!confirmed) {
			const targetId = grant.targetId;
			if (targetId !== undefined) this.quarantinedTargets.add(targetId);
			outcomes.push({
				leaseId,
				grantId,
				action: "quarantined",
				settled: false,
				reasonCode,
				...(targetId === undefined ? {} : { quarantinedTarget: targetId }),
			});
			return outcomes;
		}
		if (this.safeSettle(leaseId)) {
			outcomes.push({ leaseId, grantId, action: "revoked", settled: true, reasonCode });
		} else {
			outcomes.push({ leaseId, grantId, action: "revoked", settled: false, reasonCode });
		}
		return outcomes;
	}

	/** Resolve a transient Worker target; absence never counts as success. */
	private resolveWorkerTarget(
		workerId: string | undefined,
		requested: TaskCredentialWorkerTarget | undefined,
	): TaskCredentialWorkerTarget | null | undefined {
		if (workerId === undefined) return requested === undefined ? undefined : null;
		if (requested !== undefined) return requested;
		const indexed = this.workerTargets?.get(workerId);
		if (indexed !== undefined) return indexed;
		if (this.defaultWorkerTarget !== undefined) return this.defaultWorkerTarget;
		return null;
	}

	private isWorkerSuccessResult(value: unknown): boolean {
		return isRecord(value) && Object.keys(value).length === 1 && value.ok === true;
	}

	private workerProject(grant: TaskCredentialGrant, clientRequestId: string, target: TaskCredentialWorkerTarget): boolean {
		const key = `project\u0000${grant.leaseId}\u0000${clientRequestId}`;
		if (this.workerRequestKeys.has(key)) return true;
		try {
			const result = target.project({ schemaVersion: 1, leaseId: grant.leaseId, grantId: grant.grantId, bindingId: grant.bindingId, scopeDigest: grant.scopeDigest, expiresAt: grant.expiresAt, clientRequestId });
			if (!this.isWorkerSuccessResult(result)) return false;
			this.workerRequestKeys.add(key);
			return true;
		} catch {
			return false;
		}
	}

	private workerRenew(grant: TaskCredentialGrant, clientRequestId: string, target: TaskCredentialWorkerTarget): boolean {
		const key = `renew\u0000${grant.leaseId}\u0000${clientRequestId}`;
		if (this.workerRequestKeys.has(key)) return true;
		try {
			const result = target.renew({ schemaVersion: 1, leaseId: grant.leaseId, grantId: grant.grantId, bindingId: grant.bindingId, scopeDigest: grant.scopeDigest, expiresAt: grant.expiresAt, clientRequestId });
			if (!this.isWorkerSuccessResult(result)) return false;
			this.workerRequestKeys.add(key);
			return true;
		} catch {
			return false;
		}
	}

	private workerRevoke(grant: TaskCredentialGrant, clientRequestId: string, target: TaskCredentialWorkerTarget): boolean {
		const key = `revoke\u0000${grant.leaseId}\u0000${clientRequestId}`;
		if (this.workerRequestKeys.has(key)) return true;
		try {
			const result = target.revoke({ schemaVersion: 1, leaseId: grant.leaseId, grantId: grant.grantId, bindingId: grant.bindingId, clientRequestId });
			if (!this.isWorkerSuccessResult(result)) return false;
			this.workerRequestKeys.add(key);
			return true;
		} catch {
			return false;
		}
	}

	private quarantineWorker(leaseId: string): void {
		const workerId = this.workerByLeaseId.get(leaseId);
		if (workerId !== undefined) this.quarantinedTargets.add(workerId);
	}

	/**
	 * Revoke one lease because the first cancel request of its Run was
	 * recorded. The revoke is confirmed without settling: the unique terminal
	 * event settles later. An unknown outcome quarantines the target (fail
	 * closed); an already terminal or unknown lease degrades to a noop.
	 * Never throws.
	 */
	private revokeLeaseOnCancelRequested(leaseId: string): readonly TaskCredentialSignalOutcome[] {
		const outcomes: TaskCredentialSignalOutcome[] = [];
		const grant = this.safeGet(leaseId);
		if (grant === undefined) return outcomes;
		const grantId = grant.grantId;
		const targetId = grant.targetId;
		if (
			grant.status === "settled" ||
			grant.status === "revoked" ||
			(grant.status === "expired" && !this.hasExternalTargetLifecycle(leaseId))
		) {
			// Already terminal: nothing to revoke; the terminal event settles.
			outcomes.push({ leaseId, grantId, action: "noop", settled: false, reasonCode: "run_cancelled" });
			return outcomes;
		}
		if (grant.status === "revocation_unknown") {
			if (targetId !== undefined) this.quarantinedTargets.add(targetId);
			this.quarantineWorker(leaseId);
			outcomes.push({
				leaseId,
				grantId,
				action: "quarantined",
				settled: false,
				reasonCode: "run_cancelled",
				...(targetId === undefined ? {} : { quarantinedTarget: targetId }),
			});
			return outcomes;
		}
		if (this.store === undefined) {
			outcomes.push({ leaseId, grantId, action: "noop", settled: false, reasonCode: "run_cancelled" });
			return outcomes;
		}
		const workerTarget = this.workerTargetByLeaseId.get(leaseId);
		if (workerTarget !== undefined && !this.workerRevoke(grant, lifecycleRequestId(leaseId, "run_cancel_requested"), workerTarget)) {
			this.quarantineWorker(leaseId);
		}
		try {
			const result = this.store.revoke({
				leaseId,
				reasonCode: "run_cancelled",
				clientRequestId: lifecycleRequestId(leaseId, "run_cancel_requested"),
				...(this.hasExternalTargetLifecycle(leaseId)
					? { targetLifecycle: "external_connector" as const }
					: {}),
			});
			if (result.grant.status === "revoked") {
				outcomes.push({ leaseId, grantId, action: "revoked", settled: false, reasonCode: "run_cancelled" });
				return outcomes;
			}
			if (targetId !== undefined) this.quarantinedTargets.add(targetId);
			outcomes.push({
				leaseId,
				grantId,
				action: "quarantined",
				settled: false,
				reasonCode: "run_cancelled",
				...(targetId === undefined ? {} : { quarantinedTarget: targetId }),
			});
			return outcomes;
		} catch {
			outcomes.push({ leaseId, grantId, action: "noop", settled: false, reasonCode: "run_cancelled" });
			return outcomes;
		}
	}

	/** Best-effort settle; never throws. */
	private safeSettle(leaseId: string): boolean {
		if (this.store === undefined) return false;
		try {
			this.store.settle({ leaseId, clientRequestId: lifecycleRequestId(leaseId, "settled") });
			return true;
		} catch {
			return false;
		}
	}

	/** Read one lease; never throws. */
	private safeGet(leaseId: string): TaskCredentialGrant | undefined {
		if (this.store === undefined) return undefined;
		try {
			return this.store.get(leaseId);
		} catch {
			return undefined;
		}
	}

	/** Read the session snapshot; never throws. */
	private safeSnapshot(): ReadonlyArray<TaskCredentialGrant> {
		if (this.store === undefined) return [];
		try {
			return this.store.list();
		} catch {
			return [];
		}
	}

	private nextTimestamp(): string {
		let timestamp: string;
		try {
			timestamp = this.nowFn();
		} catch {
			throw new TaskCredentialError("task_credential_persistence_failed");
		}
		if (!isTaskCredentialIsoTimestamp(timestamp)) {
			throw new TaskCredentialError("task_credential_persistence_failed");
		}
		return timestamp;
	}

	private mapErrorCode(error: unknown): TaskCredentialErrorCode {
		if (error instanceof TaskCredentialError) return error.code;
		return "task_credential_persistence_failed";
	}
}
