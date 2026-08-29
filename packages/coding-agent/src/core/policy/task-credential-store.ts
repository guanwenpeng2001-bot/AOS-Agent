/**
 * Task Credential / Lease store.
 *
 * Session-scoped store for task credential grants and leases. The store
 * strictly reuses the Session custom-entry single-writer shape
 * (`getSessionId` / `getEntries` / `appendCustomEntry`) with
 * `customType: "task.credential"`, schema version 1. All writes go through
 * the injected Session single-writer; a write is acknowledged only after the
 * appended transition folds back, and an append failure keeps the previous
 * projection and reports `task_credential_persistence_failed`.
 *
 * The store orchestrates a provider-neutral `TaskCredentialProvider`
 * (issuer + target capabilities) with material-free requests and consumes
 * only safe receipts. Credential material never enters a store request, a
 * persisted entry, a warning, an error, or a public projection; the provider
 * holds material internally and forwards it to its target only inside the
 * provider-to-target projection request. Reload (`refresh`) folds persisted
 * entries only: it never restores material and never renews or touches the
 * provider.
 *
 * A persisted transition is a full grant snapshot after one state-machine
 * step (`issued`, `renewed`, `delivery_succeeded`, `delivery_failed`,
 * `revoked`, `revocation_unknown`, `settled`). `expired` is derived at read
 * time from the clock and is never persisted. The fold validates schema,
 * session, identifiers, grant continuity, lease / grant / binding
 * uniqueness, strict revision increments, heartbeat sequence, the legal
 * transition matrix, and idempotency. Malformed, unsupported,
 * session-mismatched, gapped, illegal, conflicting, and replayed entries are
 * skipped with safe warnings that never surface raw data.
 *
 * Revoke fails closed: a provider exception, a timeout-like failure, or an
 * unsafe, malformed, or mismatched revoke receipt appends a safe
 * provider-neutral `revocation_unknown` transition and never surfaces raw
 * error data. Settle is legal only after a `delivery_succeeded` /
 * `delivery_failed` receipt has been folded for the lease and the current
 * grant is `revoked` (provider-confirmed); `active`, `expired`, and
 * `revocation_unknown` never settle. A confirmed retry from
 * `revocation_unknown` reconciles to `revoked` through
 * `canReconcileTaskLease` and the explicit `providerConfirmedRevoke: true`
 * transition option; an unconfirmed retry leaves the lease quarantined in
 * `revocation_unknown` and appends nothing.
 *
 * Idempotency: the key is `operation\0clientRequestId`. Retrying the same
 * request with the same key and canonical payload replays the previous
 * result without appending a second transition; the same key with a
 * different payload is a conflict. Canonical payloads are derived from the
 * persisted snapshot, so replay comparison survives restart.
 *
 * No enum, namespace, parameter property, or dynamic import is used.
 */

import type { SessionEntry } from "../session/manager.ts";
import {
	TASK_CREDENTIAL_IDENTIFIER_MAX_LENGTH,
	TASK_CREDENTIAL_MAX_TTL_MS,
	TASK_CREDENTIAL_MIN_TTL_MS,
	TASK_CREDENTIAL_REASON_CODE_MAX_LENGTH,
	TASK_CREDENTIAL_RENEWAL_WINDOW_MS,
	TASK_CREDENTIAL_SCHEMA_VERSION,
	TaskCredentialError,
	canHeartbeatTaskLease,
	canReconcileTaskLease,
	canRenewTaskLease,
	canRevokeTaskLease,
	canSettleTaskLease,
	isLegalTaskCredentialTransition,
	isTaskCredentialDeliveryReceipt,
	isTaskCredentialGrant,
	isTaskCredentialIdentifier,
	isTaskCredentialIsoTimestamp,
	isTaskExecutionBinding,
	issueTaskCredentialGrant,
	normalizeTaskCredentialScopes,
	parseTaskCredentialDeliveryReceipt,
	serializeTaskCredentialDeliveryReceipt,
	serializeTaskCredentialGrant,
	serializeTaskExecutionBinding,
	transitionTaskCredentialStatus,
	type TaskCredentialDeliveryReceipt,
	type TaskCredentialGrant,
	type TaskCredentialIssueRequest,
	type TaskCredentialScope,
	type TaskCredentialTtlBounds,
	type TaskExecutionBinding,
} from "./task-credential-lease.ts";
import {
	parseTaskCredentialProviderReceipt,
	serializeTaskCredentialProviderReceipt,
	type TaskCredentialProvider,
	type TaskCredentialProviderReceipt,
} from "./task-credential-provider.ts";

export const TASK_CREDENTIAL_CUSTOM_TYPE = "task.credential" as const;

/** Actions the store persists; `expired` is derived at read time, never persisted. */
export const TASK_CREDENTIAL_PERSISTED_ACTIONS = [
	"issued",
	"renewed",
	"delivery_succeeded",
	"delivery_failed",
	"revoked",
	"revocation_unknown",
	"settled",
] as const;
export type TaskCredentialPersistedAction = (typeof TASK_CREDENTIAL_PERSISTED_ACTIONS)[number];

export type TaskCredentialWarningCode =
	| "malformed_source"
	| "unsupported_schema"
	| "session_mismatch"
	| "revision_gap"
	| "illegal_transition"
	| "idempotency_conflict"
	| "lease_conflict"
	| "grant_conflict"
	| "binding_conflict";

export interface TaskCredentialWarning {
	readonly code: TaskCredentialWarningCode;
	/** Alias used by diagnostics consumers that classify warnings by kind. */
	readonly kind: TaskCredentialWarningCode;
	readonly entryId: string;
}

/**
 * One persisted state-machine step: the full grant snapshot after the
 * transition plus the facts the fold needs to validate and replay it.
 * Only the issued transition carries the execution binding; only renewed
 * carries `requestedTtlMs`; only delivery carries `deliveryReceipt`; only
 * terminal transitions carry `reasonCode`. No field can carry material.
 */
export interface TaskCredentialTransition {
	readonly schemaVersion: typeof TASK_CREDENTIAL_SCHEMA_VERSION;
	readonly action: TaskCredentialPersistedAction;
	readonly leaseId: string;
	readonly grantId: string;
	readonly bindingId: string;
	readonly sessionId: string;
	readonly grant: TaskCredentialGrant;
	readonly previousRevision: number;
	readonly clientRequestId: string;
	/** Store clock at write time; canonical UTC ISO timestamp. */
	readonly recordedAt: string;
	readonly requestedTtlMs?: number;
	readonly binding?: TaskExecutionBinding;
	readonly reasonCode?: string;
	readonly deliveryReceipt?: TaskCredentialDeliveryReceipt;
}

export interface TaskCredentialFoldResult {
	/** Current grant snapshots in append order of their accepted `issued` transition. */
	readonly grants: ReadonlyArray<TaskCredentialGrant>;
	readonly byLeaseId: ReadonlyMap<string, TaskCredentialGrant>;
	readonly byGrantId: ReadonlyMap<string, TaskCredentialGrant>;
	/** Every grant per binding, in append order of the accepted `issued` transition. */
	readonly byBindingId: ReadonlyMap<string, ReadonlyArray<TaskCredentialGrant>>;
	/** Idempotency index: `operation\0clientRequestId` maps to the canonical payload of the winning transition. */
	readonly byIdempotencyKey: ReadonlyMap<string, string>;
	/** Safe receipt of the transition that won each idempotency key; used for replays. */
	readonly receiptByKey: ReadonlyMap<string, TaskCredentialProviderReceipt | TaskCredentialDeliveryReceipt>;
	/** Latest folded delivery receipt per lease; safe allowlisted fields only. */
	readonly deliveryByLeaseId: ReadonlyMap<string, TaskCredentialDeliveryReceipt>;
	readonly warnings: ReadonlyArray<TaskCredentialWarning>;
}

export interface TaskCredentialStoreIssueRequest {
	readonly leaseId: string;
	readonly grantId: string;
	readonly binding: TaskExecutionBinding;
	readonly scopes: ReadonlyArray<TaskCredentialScope>;
	readonly requestedTtlMs: number;
	readonly ttlBounds: TaskCredentialTtlBounds;
	readonly clientRequestId: string;
}

export interface TaskCredentialStoreRenewRequest {
	readonly leaseId: string;
	/**
	 * Client-supplied heartbeat sequence: must equal the current grant's
	 * `heartbeatSequence + 1`. A duplicate, regression, or skip is rejected
	 * with `task_lease_heartbeat_invalid` before any provider call or append;
	 * the canonical idempotency payload includes the sequence so a reused
	 * `clientRequestId` with a different sequence conflicts instead of
	 * replaying.
	 */
	readonly heartbeatSequence: number;
	readonly requestedTtlMs: number;
	readonly ttlBounds: TaskCredentialTtlBounds;
	readonly clientRequestId: string;
	/** Also renew the exact external material target; default-off. */
	readonly targetLifecycle?: "external_connector";
}

export interface TaskCredentialStoreProjectRequest {
	readonly leaseId: string;
	readonly targetId?: string;
	readonly clientRequestId: string;
}

export interface TaskCredentialStoreRevokeRequest {
	readonly leaseId: string;
	readonly reasonCode?: string;
	readonly clientRequestId: string;
	/**
	 * Confirm a revoke retry from `revocation_unknown`: the issuer is asked to
	 * confirm again and only a confirmed `revoked` receipt appends `revoked`.
	 * Must be exactly `true` when present; `false` is rejected.
	 */
	readonly providerConfirmedRevoke?: boolean;
	/** Also revoke the exact external material target; default-off. */
	readonly targetLifecycle?: "external_connector";
}

export interface TaskCredentialStoreSettleRequest {
	readonly leaseId: string;
	readonly reasonCode?: string;
	readonly clientRequestId: string;
}

export interface TaskCredentialStoreResult {
	/** Current public grant of the lease. */
	readonly grant: TaskCredentialGrant;
	/** Safe receipt of this call; never carries material. */
	readonly receipt: TaskCredentialProviderReceipt | TaskCredentialDeliveryReceipt;
	readonly appended: boolean;
	readonly idempotent: boolean;
	readonly entryId?: string;
}

/** Minimal Session surface used by the store; `SessionManager` satisfies it. */
export interface TaskCredentialSession {
	getSessionId(): string;
	getEntries(): ReadonlyArray<SessionEntry>;
	appendCustomEntry(customType: string, data?: unknown): string;
}

export interface TaskCredentialStoreOptions {
	/** Server timestamp source; must return a canonical UTC ISO timestamp. */
	readonly now?: () => string;
	readonly diagnostics?: (warning: TaskCredentialWarning) => void;
}

const ISSUE_KEYS = new Set(["leaseId", "grantId", "binding", "scopes", "requestedTtlMs", "ttlBounds", "clientRequestId"]);
const RENEW_KEYS = new Set([
	"leaseId",
	"heartbeatSequence",
	"requestedTtlMs",
	"ttlBounds",
	"clientRequestId",
	"targetLifecycle",
]);
const PROJECT_KEYS = new Set(["leaseId", "targetId", "clientRequestId"]);
const REVOKE_KEYS = new Set([
	"leaseId",
	"reasonCode",
	"clientRequestId",
	"providerConfirmedRevoke",
	"targetLifecycle",
]);
const SETTLE_KEYS = new Set(["leaseId", "reasonCode", "clientRequestId"]);
const TTL_BOUNDS_KEYS = new Set(["minTtlMs", "maxTtlMs", "deadlineAtMs"]);
const TRANSITION_KEYS = new Set([
	"schemaVersion",
	"action",
	"leaseId",
	"grantId",
	"bindingId",
	"sessionId",
	"grant",
	"previousRevision",
	"clientRequestId",
	"recordedAt",
	"requestedTtlMs",
	"binding",
	"reasonCode",
	"deliveryReceipt",
]);

/**
 * Keys that must never appear in a store request or persisted transition.
 * These are rejected before the state machine runs so tokens, secrets,
 * environment values, and provider internals cannot become credential
 * facts or leak into JSON.
 */
export const TASK_CREDENTIAL_FORBIDDEN_PAYLOAD_KEYS = Object.freeze([
	"token",
	"secret",
	"material",
	"value",
	"password",
	"authorization",
	"credentials",
	"credential",
	"apiKey",
	"api_key",
	"accessKey",
	"access_key",
	"secretKey",
	"secret_key",
	"privateKey",
	"private_key",
	"sessionKey",
	"session_key",
	"signature",
	"ciphertext",
	"plaintext",
	"encrypted",
	"decrypted",
	"payload",
	"raw",
	"nonce",
]);

const EXPECTED_GRANT_STATUS: Record<TaskCredentialPersistedAction, TaskCredentialGrant["status"]> = {
	renewed: "active",
	delivery_succeeded: "active",
	delivery_failed: "active",
	revoked: "revoked",
	revocation_unknown: "revocation_unknown",
	settled: "settled",
	issued: "active",
};

const OPERATION_FOR_ACTION: Record<TaskCredentialPersistedAction, string> = {
	issued: "issue",
	renewed: "renew",
	delivery_succeeded: "project",
	delivery_failed: "project",
	revoked: "revoke",
	revocation_unknown: "revoke",
	settled: "settle",
};

const RECEIPT_STATUS_FOR_ACTION: Record<TaskCredentialPersistedAction, TaskCredentialProviderReceipt["status"]> = {
	issued: "issued",
	renewed: "renewed",
	delivery_succeeded: "failed",
	delivery_failed: "failed",
	revoked: "revoked",
	revocation_unknown: "revocation_unknown",
	settled: "settled",
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
	return Object.keys(value).every((key) => allowed.has(key));
}

function isBoundedIdentifier(value: unknown, maxLength: number): value is string {
	return isTaskCredentialIdentifier(value) && value.length <= maxLength;
}

function isBoundedReasonCode(value: unknown): value is string {
	return isBoundedIdentifier(value, TASK_CREDENTIAL_REASON_CODE_MAX_LENGTH);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isTaskCredentialTtlBounds(value: unknown): value is TaskCredentialTtlBounds {
	if (!isRecord(value) || !hasOnlyKeys(value, TTL_BOUNDS_KEYS)) return false;
	if (
		!isPositiveSafeInteger(value.minTtlMs) ||
		!isPositiveSafeInteger(value.maxTtlMs) ||
		(value.minTtlMs as number) > (value.maxTtlMs as number)
	) {
		return false;
	}
	if (value.deadlineAtMs !== undefined && !isNonNegativeSafeInteger(value.deadlineAtMs)) return false;
	return true;
}

function warningFor(entryId: string, code: TaskCredentialWarningCode): TaskCredentialWarning {
	return { code, kind: code, entryId: isTaskCredentialIdentifier(entryId) ? entryId : "unknown" };
}

function idempotencyKey(operation: string, clientRequestId: string): string {
	return `${operation}\u0000${clientRequestId}`;
}

function operationForAction(action: TaskCredentialPersistedAction): string {
	return OPERATION_FOR_ACTION[action];
}

function customEntry(value: SessionEntry): value is Extract<SessionEntry, { type: "custom" }> {
	return value.type === "custom";
}

function declaredSchemaVersion(value: unknown): number | undefined {
	if (!isRecord(value) || typeof value.schemaVersion !== "number") return undefined;
	return value.schemaVersion;
}

/** The binding facts a persisted grant freezes must agree with the binding snapshot. */
function bindingConsistentWithGrant(binding: TaskExecutionBinding, grant: TaskCredentialGrant): boolean {
	if (
		binding.bindingId !== grant.bindingId ||
		binding.sessionId !== grant.sessionId ||
		binding.taskId !== grant.taskId ||
		binding.graphRevision !== grant.graphRevision ||
		binding.nodeId !== grant.nodeId ||
		binding.runId !== grant.runId
	) {
		return false;
	}
	if ((binding.stageId ?? undefined) !== (grant.stageId ?? undefined)) return false;
	if ((binding.stageRevision ?? undefined) !== (grant.stageRevision ?? undefined)) return false;
	return (binding.targetId ?? undefined) === (grant.targetId ?? undefined);
}

/** Structural guard for a persisted transition; unknown, forbidden, or material keys fail. */
export function isTaskCredentialTransition(value: unknown): value is TaskCredentialTransition {
	if (!isRecord(value) || !hasOnlyKeys(value, TRANSITION_KEYS)) return false;
	if (value.schemaVersion !== TASK_CREDENTIAL_SCHEMA_VERSION) return false;
	if (!TASK_CREDENTIAL_PERSISTED_ACTIONS.includes(value.action as TaskCredentialPersistedAction)) return false;
	const action = value.action as TaskCredentialPersistedAction;
	if (
		!isBoundedIdentifier(value.leaseId, TASK_CREDENTIAL_IDENTIFIER_MAX_LENGTH) ||
		!isBoundedIdentifier(value.grantId, TASK_CREDENTIAL_IDENTIFIER_MAX_LENGTH) ||
		!isBoundedIdentifier(value.bindingId, TASK_CREDENTIAL_IDENTIFIER_MAX_LENGTH) ||
		!isBoundedIdentifier(value.sessionId, TASK_CREDENTIAL_IDENTIFIER_MAX_LENGTH) ||
		!isBoundedIdentifier(value.clientRequestId, TASK_CREDENTIAL_IDENTIFIER_MAX_LENGTH)
	) {
		return false;
	}
	if (!isNonNegativeSafeInteger(value.previousRevision)) return false;
	if (!isTaskCredentialIsoTimestamp(value.recordedAt)) return false;
	if (!isTaskCredentialGrant(value.grant)) return false;
	const grant = value.grant as TaskCredentialGrant;
	if (
		grant.leaseId !== value.leaseId ||
		grant.grantId !== value.grantId ||
		grant.bindingId !== value.bindingId ||
		grant.sessionId !== value.sessionId
	) {
		return false;
	}
	if (value.reasonCode !== undefined && !isBoundedReasonCode(value.reasonCode)) return false;
	switch (action) {
		case "issued":
			if (value.previousRevision !== 0) return false;
			if (grant.revision !== 0 || grant.heartbeatSequence !== 0 || grant.status !== "active") return false;
			if (value.requestedTtlMs !== undefined || value.deliveryReceipt !== undefined || value.reasonCode !== undefined) {
				return false;
			}
			if (!isTaskExecutionBinding(value.binding) || !bindingConsistentWithGrant(value.binding as TaskExecutionBinding, grant)) {
				return false;
			}
			return true;
		case "renewed":
			if (!isPositiveSafeInteger(value.requestedTtlMs)) return false;
			if (value.binding !== undefined || value.deliveryReceipt !== undefined || value.reasonCode !== undefined) {
				return false;
			}
			return true;
		case "delivery_succeeded":
		case "delivery_failed": {
			if (value.requestedTtlMs !== undefined || value.binding !== undefined || value.reasonCode !== undefined) {
				return false;
			}
			if (!isTaskCredentialDeliveryReceipt(value.deliveryReceipt)) return false;
			const receipt = value.deliveryReceipt as TaskCredentialDeliveryReceipt;
			if (
				receipt.leaseId !== value.leaseId ||
				receipt.grantId !== value.grantId ||
				receipt.bindingId !== value.bindingId
			) {
				return false;
			}
			if (receipt.status !== (action === "delivery_succeeded" ? "succeeded" : "failed")) return false;
			if ((receipt.targetId ?? undefined) !== (grant.targetId ?? undefined)) return false;
			return true;
		}
		case "revoked":
		case "revocation_unknown":
		case "settled":
			if (value.requestedTtlMs !== undefined || value.binding !== undefined || value.deliveryReceipt !== undefined) {
				return false;
			}
			return true;
	}
}

/** Defensive copy of a persisted transition; copies only the allowlist. */
export function serializeTaskCredentialTransition(value: TaskCredentialTransition): TaskCredentialTransition {
	const transition: TaskCredentialTransition = {
		schemaVersion: TASK_CREDENTIAL_SCHEMA_VERSION,
		action: value.action,
		leaseId: value.leaseId,
		grantId: value.grantId,
		bindingId: value.bindingId,
		sessionId: value.sessionId,
		grant: serializeTaskCredentialGrant(value.grant),
		previousRevision: value.previousRevision,
		clientRequestId: value.clientRequestId,
		recordedAt: value.recordedAt,
	};
	if (value.requestedTtlMs !== undefined) (transition as { requestedTtlMs?: number }).requestedTtlMs = value.requestedTtlMs;
	if (value.binding !== undefined) (transition as { binding?: TaskExecutionBinding }).binding = serializeTaskExecutionBinding(value.binding);
	if (value.reasonCode !== undefined) (transition as { reasonCode?: string }).reasonCode = value.reasonCode;
	if (value.deliveryReceipt !== undefined) {
		(transition as { deliveryReceipt?: TaskCredentialDeliveryReceipt }).deliveryReceipt = serializeTaskCredentialDeliveryReceipt(
			value.deliveryReceipt,
		);
	}
	return transition;
}

/** Parse only the exact schema-versioned transition payload. */
export function parseTaskCredentialTransition(value: unknown): TaskCredentialTransition | undefined {
	return isTaskCredentialTransition(value) ? serializeTaskCredentialTransition(value) : undefined;
}

/** The canonical idempotency payload of `task.credential` issue. */
export function canonicalTaskCredentialIssuePayload(
	binding: TaskExecutionBinding,
	grant: TaskCredentialGrant,
	leaseId: string,
	grantId: string,
): string {
	const payload: Record<string, unknown> = {
		operation: "issue",
		leaseId,
		grantId,
		bindingId: binding.bindingId,
		bindingRevision: binding.bindingRevision,
		sessionId: binding.sessionId,
		taskId: binding.taskId,
		graphRevision: binding.graphRevision,
		nodeId: binding.nodeId,
		runId: binding.runId,
		capabilityBindingId: binding.capabilityBindingId,
		policyBindingId: binding.policyBindingId,
		scopeDigest: grant.scopeDigest,
		scopeCount: grant.scopeCount,
		ttlMs: Date.parse(grant.expiresAt) - Date.parse(grant.issuedAt),
	};
	if (binding.stageId !== undefined) payload.stageId = binding.stageId;
	if (binding.stageRevision !== undefined) payload.stageRevision = binding.stageRevision;
	if (binding.sandboxBindingId !== undefined) payload.sandboxBindingId = binding.sandboxBindingId;
	if (binding.targetId !== undefined) payload.targetId = binding.targetId;
	if (binding.workerId !== undefined) payload.workerId = binding.workerId;
	return JSON.stringify(payload);
}

/** The canonical idempotency payload of `task.credential` renew. */
export function canonicalTaskCredentialRenewPayload(
	leaseId: string,
	grantId: string,
	bindingId: string,
	requestedTtlMs: number,
	heartbeatSequence: number,
): string {
	return JSON.stringify({ operation: "renew", leaseId, grantId, bindingId, requestedTtlMs, heartbeatSequence });
}

/** The canonical idempotency payload of `task.credential` project (delivery). */
export function canonicalTaskCredentialProjectPayload(
	leaseId: string,
	grantId: string,
	bindingId: string,
	targetId: string | undefined,
): string {
	const payload: Record<string, unknown> = { operation: "project", leaseId, grantId, bindingId };
	if (targetId !== undefined) payload.targetId = targetId;
	return JSON.stringify(payload);
}

/** The canonical idempotency payload of `task.credential` revoke. */
export function canonicalTaskCredentialRevokePayload(
	leaseId: string,
	grantId: string,
	bindingId: string,
	reasonCode: string | undefined,
): string {
	const payload: Record<string, unknown> = { operation: "revoke", leaseId, grantId, bindingId };
	if (reasonCode !== undefined) payload.reasonCode = reasonCode;
	return JSON.stringify(payload);
}

/** The canonical idempotency payload of `task.credential` settle. */
export function canonicalTaskCredentialSettlePayload(
	leaseId: string,
	grantId: string,
	bindingId: string,
	reasonCode: string | undefined,
): string {
	const payload: Record<string, unknown> = { operation: "settle", leaseId, grantId, bindingId };
	if (reasonCode !== undefined) payload.reasonCode = reasonCode;
	return JSON.stringify(payload);
}

/** Derive the canonical payload of a persisted transition from its snapshot. */
function canonicalTransitionPayload(transition: TaskCredentialTransition): string {
	switch (transition.action) {
		case "issued":
			return canonicalTaskCredentialIssuePayload(transition.binding!, transition.grant, transition.leaseId, transition.grantId);
		case "renewed":
			return canonicalTaskCredentialRenewPayload(
				transition.leaseId,
				transition.grantId,
				transition.bindingId,
				transition.requestedTtlMs!,
				transition.grant.heartbeatSequence,
			);
		case "delivery_succeeded":
		case "delivery_failed":
			return canonicalTaskCredentialProjectPayload(
				transition.leaseId,
				transition.grantId,
				transition.bindingId,
				transition.grant.targetId,
			);
		case "revoked":
		case "revocation_unknown":
			return canonicalTaskCredentialRevokePayload(
				transition.leaseId,
				transition.grantId,
				transition.bindingId,
				transition.reasonCode,
			);
		case "settled":
			return canonicalTaskCredentialSettlePayload(
				transition.leaseId,
				transition.grantId,
				transition.bindingId,
				transition.reasonCode,
			);
	}
}

/** Full persisted grant snapshot equality across every field. */
function sameGrantSnapshot(left: TaskCredentialGrant, right: TaskCredentialGrant): boolean {
	return (
		left.schemaVersion === right.schemaVersion &&
		left.grantId === right.grantId &&
		left.leaseId === right.leaseId &&
		left.bindingId === right.bindingId &&
		left.sessionId === right.sessionId &&
		left.taskId === right.taskId &&
		left.graphRevision === right.graphRevision &&
		left.nodeId === right.nodeId &&
		(left.stageId ?? undefined) === (right.stageId ?? undefined) &&
		(left.stageRevision ?? undefined) === (right.stageRevision ?? undefined) &&
		left.runId === right.runId &&
		left.scopeDigest === right.scopeDigest &&
		left.scopeCount === right.scopeCount &&
		left.status === right.status &&
		left.issuedAt === right.issuedAt &&
		left.expiresAt === right.expiresAt &&
		left.renewAfter === right.renewAfter &&
		left.heartbeatSequence === right.heartbeatSequence &&
		left.revision === right.revision &&
		(left.targetId ?? undefined) === (right.targetId ?? undefined) &&
		(left.reasonCode ?? undefined) === (right.reasonCode ?? undefined)
	);
}

/** An accepted `issued` snapshot must be a coherent revision-0 active grant. */
function isConsistentIssuedTransition(transition: TaskCredentialTransition): boolean {
	const grant = transition.grant;
	if (transition.previousRevision !== 0) return false;
	if (grant.revision !== 0 || grant.heartbeatSequence !== 0 || grant.status !== "active") return false;
	const ttlMs = Date.parse(grant.expiresAt) - Date.parse(grant.issuedAt);
	if (ttlMs < TASK_CREDENTIAL_MIN_TTL_MS || ttlMs > TASK_CREDENTIAL_MAX_TTL_MS) return false;
	return Date.parse(grant.expiresAt) - Date.parse(grant.renewAfter) === TASK_CREDENTIAL_RENEWAL_WINDOW_MS;
}

/**
 * A follow-up snapshot must advance exactly one revision over the current
 * grant, obey the legal transition matrix, keep every immutable fact, and
 * move heartbeat / expiry only the way its action allows.
 */
function isConsistentTransition(current: TaskCredentialGrant, transition: TaskCredentialTransition): boolean {
	const grant = transition.grant;
	const action = transition.action;
	if (grant.revision !== current.revision + 1) return false;
	if (!isLegalTaskCredentialTransition(current.status, action)) return false;
	if (grant.status !== EXPECTED_GRANT_STATUS[action]) return false;
	if (
		grant.leaseId !== current.leaseId ||
		grant.grantId !== current.grantId ||
		grant.bindingId !== current.bindingId ||
		grant.sessionId !== current.sessionId ||
		grant.taskId !== current.taskId ||
		grant.graphRevision !== current.graphRevision ||
		grant.nodeId !== current.nodeId ||
		grant.runId !== current.runId ||
		grant.scopeDigest !== current.scopeDigest ||
		grant.scopeCount !== current.scopeCount ||
		(grant.stageId ?? undefined) !== (current.stageId ?? undefined) ||
		(grant.stageRevision ?? undefined) !== (current.stageRevision ?? undefined) ||
		(grant.targetId ?? undefined) !== (current.targetId ?? undefined)
	) {
		return false;
	}
	if (action === "renewed") {
		if (grant.heartbeatSequence !== current.heartbeatSequence + 1) return false;
		if (Date.parse(grant.expiresAt) <= Date.parse(current.expiresAt)) return false;
		return Date.parse(grant.expiresAt) - Date.parse(grant.renewAfter) === TASK_CREDENTIAL_RENEWAL_WINDOW_MS;
	}
	return grant.heartbeatSequence === current.heartbeatSequence;
}

function bindingHasActiveGrant(
	byBindingId: ReadonlyMap<string, ReadonlyArray<TaskCredentialGrant>>,
	bindingId: string,
): boolean {
	const grants = byBindingId.get(bindingId);
	if (grants === undefined) return false;
	return grants.some((grant) => grant.status === "active");
}

/**
 * Fold `task.credential` custom entries in append order into the current
 * projection. Entries that fail schema, identifier, session, grant, lease,
 * revision, transition, or idempotency rules are skipped with a warning and
 * never surface raw data. For duplicate idempotency keys the first accepted
 * transition wins; a later entry with the same key but a different payload
 * is dropped with a warning. Delivery receipts are additionally exposed
 * per lease through safe allowlisted fields only. The fold never calls the
 * provider: it restores no material and never renews or extends a lease.
 */
export function foldTaskCredentialEntries(
	entries: ReadonlyArray<SessionEntry>,
	sessionId: string,
	diagnostics?: (warning: TaskCredentialWarning) => void,
): TaskCredentialFoldResult {
	const grants: TaskCredentialGrant[] = [];
	const byLeaseId = new Map<string, TaskCredentialGrant>();
	const byGrantId = new Map<string, TaskCredentialGrant>();
	const byBindingId = new Map<string, TaskCredentialGrant[]>();
	const byIdempotencyKey = new Map<string, string>();
	const receiptByKey = new Map<string, TaskCredentialProviderReceipt | TaskCredentialDeliveryReceipt>();
	const deliveryByLeaseId = new Map<string, TaskCredentialDeliveryReceipt>();
	const warnings: TaskCredentialWarning[] = [];
	const emit = (warning: TaskCredentialWarning): void => {
		warnings.push(warning);
		diagnostics?.(warning);
	};
	for (const entry of entries) {
		if (!customEntry(entry) || entry.customType !== TASK_CREDENTIAL_CUSTOM_TYPE) continue;
		const schemaVersion = declaredSchemaVersion(entry.data);
		if (schemaVersion === undefined) {
			emit(warningFor(entry.id, "malformed_source"));
			continue;
		}
		if (schemaVersion !== TASK_CREDENTIAL_SCHEMA_VERSION) {
			emit(warningFor(entry.id, "unsupported_schema"));
			continue;
		}
		const transition = parseTaskCredentialTransition(entry.data);
		if (transition === undefined) {
			emit(warningFor(entry.id, "malformed_source"));
			continue;
		}
		if (transition.sessionId !== sessionId) {
			emit(warningFor(entry.id, "session_mismatch"));
			continue;
		}
		const key = idempotencyKey(operationForAction(transition.action), transition.clientRequestId);
		const payload = canonicalTransitionPayload(transition);
		const existingPayload = byIdempotencyKey.get(key);
		if (existingPayload !== undefined) {
			if (existingPayload !== payload) {
				emit(warningFor(entry.id, "idempotency_conflict"));
			}
			continue;
		}
		const current = byLeaseId.get(transition.leaseId);
		if (transition.action === "issued") {
			if (current !== undefined) {
				emit(warningFor(entry.id, "lease_conflict"));
				continue;
			}
			if (byGrantId.has(transition.grantId)) {
				emit(warningFor(entry.id, "grant_conflict"));
				continue;
			}
			if (bindingHasActiveGrant(byBindingId, transition.bindingId)) {
				emit(warningFor(entry.id, "binding_conflict"));
				continue;
			}
			if (!isConsistentIssuedTransition(transition)) {
				emit(warningFor(entry.id, "illegal_transition"));
				continue;
			}
			const grant = serializeTaskCredentialGrant(transition.grant);
			byLeaseId.set(transition.leaseId, grant);
			byGrantId.set(transition.grantId, grant);
			const bindingGrants = byBindingId.get(transition.bindingId) ?? [];
			bindingGrants.push(grant);
			byBindingId.set(transition.bindingId, bindingGrants);
			byIdempotencyKey.set(key, payload);
			receiptByKey.set(key, {
				schemaVersion: TASK_CREDENTIAL_SCHEMA_VERSION,
				leaseId: transition.leaseId,
				grantId: transition.grantId,
				bindingId: transition.bindingId,
				status: "issued",
				recordedAt: transition.recordedAt,
			});
			grants.push(grant);
			continue;
		}
		if (current === undefined) {
			emit(warningFor(entry.id, "revision_gap"));
			continue;
		}
		if (transition.previousRevision !== current.revision) {
			emit(warningFor(entry.id, "revision_gap"));
			continue;
		}
		if (!isConsistentTransition(current, transition)) {
			emit(warningFor(entry.id, "illegal_transition"));
			continue;
		}
		const grant = serializeTaskCredentialGrant(transition.grant);
		byLeaseId.set(transition.leaseId, grant);
		byGrantId.set(transition.grantId, grant);
		const bindingGrants = byBindingId.get(transition.bindingId) ?? [];
		if (bindingGrants.length > 0 && bindingGrants[bindingGrants.length - 1]!.grantId === transition.grantId) {
			bindingGrants[bindingGrants.length - 1] = grant;
		}
		byBindingId.set(transition.bindingId, bindingGrants);
		const issueIndex = grants.findIndex((candidate) => candidate.grantId === transition.grantId);
		if (issueIndex >= 0) grants[issueIndex] = grant;
		byIdempotencyKey.set(key, payload);
		if (transition.action === "delivery_succeeded" || transition.action === "delivery_failed") {
			receiptByKey.set(key, serializeTaskCredentialDeliveryReceipt(transition.deliveryReceipt!));
			deliveryByLeaseId.set(transition.leaseId, serializeTaskCredentialDeliveryReceipt(transition.deliveryReceipt!));
		} else {
			receiptByKey.set(key, {
				schemaVersion: TASK_CREDENTIAL_SCHEMA_VERSION,
				leaseId: transition.leaseId,
				grantId: transition.grantId,
				bindingId: transition.bindingId,
				status: RECEIPT_STATUS_FOR_ACTION[transition.action],
				recordedAt: transition.recordedAt,
			});
		}
	}
	return { grants, byLeaseId, byGrantId, byBindingId, byIdempotencyKey, receiptByKey, deliveryByLeaseId, warnings };
}

function assertNoForbiddenPayloadKeys(input: Record<string, unknown>): void {
	const forbidden = new Set(TASK_CREDENTIAL_FORBIDDEN_PAYLOAD_KEYS);
	for (const key of Object.keys(input)) {
		if (forbidden.has(key.toLowerCase())) {
			throw new TaskCredentialError("task_credential_invalid");
		}
	}
}

function validateStoreIssueRequest(input: TaskCredentialStoreIssueRequest): void {
	const raw: unknown = input;
	if (!isRecord(raw) || !hasOnlyKeys(raw, ISSUE_KEYS)) {
		throw new TaskCredentialError("task_credential_invalid");
	}
	assertNoForbiddenPayloadKeys(raw);
	if (
		!isBoundedIdentifier(input.leaseId, TASK_CREDENTIAL_IDENTIFIER_MAX_LENGTH) ||
		!isBoundedIdentifier(input.grantId, TASK_CREDENTIAL_IDENTIFIER_MAX_LENGTH) ||
		!isBoundedIdentifier(input.clientRequestId, TASK_CREDENTIAL_IDENTIFIER_MAX_LENGTH)
	) {
		throw new TaskCredentialError("task_credential_invalid");
	}
	// binding, scopes, TTL, and bounds are validated by issueTaskCredentialGrant.
}

function validateStoreRenewRequest(input: TaskCredentialStoreRenewRequest): void {
	const raw: unknown = input;
	if (!isRecord(raw) || !hasOnlyKeys(raw, RENEW_KEYS)) {
		throw new TaskCredentialError("task_credential_invalid");
	}
	assertNoForbiddenPayloadKeys(raw);
	if (
		!isBoundedIdentifier(input.leaseId, TASK_CREDENTIAL_IDENTIFIER_MAX_LENGTH) ||
		!isBoundedIdentifier(input.clientRequestId, TASK_CREDENTIAL_IDENTIFIER_MAX_LENGTH) ||
		!isNonNegativeSafeInteger(input.heartbeatSequence)
	) {
		throw new TaskCredentialError("task_credential_invalid");
	}
	if (!isPositiveSafeInteger(input.requestedTtlMs) || !isTaskCredentialTtlBounds(input.ttlBounds)) {
		throw new TaskCredentialError("task_credential_invalid");
	}
	if (input.targetLifecycle !== undefined && input.targetLifecycle !== "external_connector") {
		throw new TaskCredentialError("task_credential_invalid");
	}
}

function validateStoreProjectRequest(input: TaskCredentialStoreProjectRequest): void {
	const raw: unknown = input;
	if (!isRecord(raw) || !hasOnlyKeys(raw, PROJECT_KEYS)) {
		throw new TaskCredentialError("task_credential_invalid");
	}
	assertNoForbiddenPayloadKeys(raw);
	if (
		!isBoundedIdentifier(input.leaseId, TASK_CREDENTIAL_IDENTIFIER_MAX_LENGTH) ||
		!isBoundedIdentifier(input.clientRequestId, TASK_CREDENTIAL_IDENTIFIER_MAX_LENGTH)
	) {
		throw new TaskCredentialError("task_credential_invalid");
	}
	if (input.targetId !== undefined && !isBoundedIdentifier(input.targetId, TASK_CREDENTIAL_IDENTIFIER_MAX_LENGTH)) {
		throw new TaskCredentialError("task_credential_invalid");
	}
}

function validateStoreRevokeRequest(input: TaskCredentialStoreRevokeRequest): void {
	const raw: unknown = input;
	if (!isRecord(raw) || !hasOnlyKeys(raw, REVOKE_KEYS)) {
		throw new TaskCredentialError("task_credential_invalid");
	}
	assertNoForbiddenPayloadKeys(raw);
	// The confirmation flag is all-or-nothing: only the literal `true` is
	// accepted, mirroring the transition option guard.
	if (input.providerConfirmedRevoke !== undefined && input.providerConfirmedRevoke !== true) {
		throw new TaskCredentialError("task_credential_invalid");
	}
	if (input.targetLifecycle !== undefined && input.targetLifecycle !== "external_connector") {
		throw new TaskCredentialError("task_credential_invalid");
	}
	if (
		!isBoundedIdentifier(input.leaseId, TASK_CREDENTIAL_IDENTIFIER_MAX_LENGTH) ||
		!isBoundedIdentifier(input.clientRequestId, TASK_CREDENTIAL_IDENTIFIER_MAX_LENGTH)
	) {
		throw new TaskCredentialError("task_credential_invalid");
	}
	if (input.reasonCode !== undefined && !isBoundedReasonCode(input.reasonCode)) {
		throw new TaskCredentialError("task_credential_invalid");
	}
}

function validateStoreSettleRequest(input: TaskCredentialStoreSettleRequest): void {
	const raw: unknown = input;
	if (!isRecord(raw) || !hasOnlyKeys(raw, SETTLE_KEYS)) {
		throw new TaskCredentialError("task_credential_invalid");
	}
	assertNoForbiddenPayloadKeys(raw);
	if (
		!isBoundedIdentifier(input.leaseId, TASK_CREDENTIAL_IDENTIFIER_MAX_LENGTH) ||
		!isBoundedIdentifier(input.clientRequestId, TASK_CREDENTIAL_IDENTIFIER_MAX_LENGTH)
	) {
		throw new TaskCredentialError("task_credential_invalid");
	}
	if (input.reasonCode !== undefined && !isBoundedReasonCode(input.reasonCode)) {
		throw new TaskCredentialError("task_credential_invalid");
	}
}

/**
 * Session-scoped Task Credential store. A new instance folds the current
 * Session's `task.credential` entries, which makes lease / grant / binding
 * uniqueness, revision continuity, and idempotency restart-safe. Provider
 * calls happen only inside issue / renew / project / revoke; reload and
 * reads never touch the provider and never restore material.
 */
export class TaskCredentialStore {
	private readonly session: TaskCredentialSession;
	private readonly sessionId: string;
	private readonly provider: TaskCredentialProvider;
	private readonly nowFn: () => string;
	private readonly diagnosticsSink: ((warning: TaskCredentialWarning) => void) | undefined;
	private diagnosedEntryIds = new Set<string>();
	private fold: TaskCredentialFoldResult = {
		grants: [],
		byLeaseId: new Map(),
		byGrantId: new Map(),
		byBindingId: new Map(),
		byIdempotencyKey: new Map(),
		receiptByKey: new Map(),
		deliveryByLeaseId: new Map(),
		warnings: [],
	};

	constructor(session: TaskCredentialSession, provider: TaskCredentialProvider, options: TaskCredentialStoreOptions = {}) {
		this.session = session;
		this.sessionId = session.getSessionId();
		this.provider = provider;
		this.nowFn = options.now ?? (() => new Date().toISOString());
		this.diagnosticsSink = options.diagnostics;
		this.refresh();
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

	private nowMs(): number {
		return Date.parse(this.nextTimestamp());
	}

	/** Re-read append-only entries and return the current diagnostics snapshot. */
	refresh(): ReadonlyArray<TaskCredentialWarning> {
		let entries: ReadonlyArray<SessionEntry>;
		try {
			entries = this.session.getEntries();
		} catch {
			throw new TaskCredentialError("task_credential_persistence_failed");
		}
		const warnings: TaskCredentialWarning[] = [];
		this.fold = foldTaskCredentialEntries(entries, this.sessionId, (warning) => {
			warnings.push(warning);
			if (!this.diagnosedEntryIds.has(warning.entryId)) {
				this.diagnosedEntryIds.add(warning.entryId);
				this.diagnosticsSink?.(warning);
			}
		});
		return warnings;
	}

	warnings(): readonly TaskCredentialWarning[] {
		return this.fold.warnings;
	}

	getWarnings(): readonly TaskCredentialWarning[] {
		return this.warnings();
	}

	private bindingHasActiveGrant(bindingId: string): boolean {
		return bindingHasActiveGrant(this.fold.byBindingId, bindingId);
	}

	private callIssuer(
		operation: "issue" | "renew",
		leaseId: string,
		grantId: string,
		bindingId: string,
		fn: () => TaskCredentialProviderReceipt,
	): TaskCredentialProviderReceipt {
		let raw: unknown;
		try {
			raw = fn();
		} catch (error) {
			if (error instanceof TaskCredentialError) throw error;
			throw new TaskCredentialError("task_credential_issue_failed");
		}
		const receipt = parseTaskCredentialProviderReceipt(raw);
		if (
			receipt === undefined ||
			receipt.leaseId !== leaseId ||
			receipt.grantId !== grantId ||
			receipt.bindingId !== bindingId
		) {
			throw new TaskCredentialError("task_credential_issue_failed");
		}
		if (operation === "issue" && receipt.status !== "issued") {
			throw new TaskCredentialError("task_credential_issue_failed");
		}
		if (operation === "renew" && receipt.status !== "renewed") {
			throw new TaskCredentialError("task_credential_issue_failed");
		}
		return receipt;
	}

	/** Safe provider-neutral `revocation_unknown` receipt; never carries raw error data. */
	private revocationUnknownReceipt(leaseId: string, grantId: string, bindingId: string): TaskCredentialProviderReceipt {
		return serializeTaskCredentialProviderReceipt({
			schemaVersion: TASK_CREDENTIAL_SCHEMA_VERSION,
			leaseId,
			grantId,
			bindingId,
			status: "revocation_unknown",
			recordedAt: this.nextTimestamp(),
		});
	}

	/**
	 * Fail-closed issuer revoke: a provider exception, a timeout-like
	 * failure, or an unsafe, malformed, or mismatched revoke receipt all map
	 * to a safe provider-neutral `revocation_unknown` receipt. Raw error data
	 * never escapes into the receipt, a persisted entry, or a warning.
	 */
	private callRevoke(
		leaseId: string,
		grantId: string,
		bindingId: string,
		fn: () => TaskCredentialProviderReceipt,
	): TaskCredentialProviderReceipt {
		let raw: unknown;
		try {
			raw = fn();
		} catch {
			return this.revocationUnknownReceipt(leaseId, grantId, bindingId);
		}
		const receipt = parseTaskCredentialProviderReceipt(raw);
		if (
			receipt === undefined ||
			receipt.leaseId !== leaseId ||
			receipt.grantId !== grantId ||
			receipt.bindingId !== bindingId ||
			(receipt.status !== "revoked" && receipt.status !== "revocation_unknown")
		) {
			return this.revocationUnknownReceipt(leaseId, grantId, bindingId);
		}
		return receipt;
	}

	private callTarget(
		leaseId: string,
		grantId: string,
		bindingId: string,
		targetId: string | undefined,
		fn: () => TaskCredentialDeliveryReceipt,
	): TaskCredentialDeliveryReceipt {
		let raw: unknown;
		try {
			raw = fn();
		} catch (error) {
			if (error instanceof TaskCredentialError) throw error;
			throw new TaskCredentialError("task_credential_delivery_failed");
		}
		const receipt = parseTaskCredentialDeliveryReceipt(raw);
		if (
			receipt === undefined ||
			receipt.leaseId !== leaseId ||
			receipt.grantId !== grantId ||
			receipt.bindingId !== bindingId
		) {
			throw new TaskCredentialError("task_credential_delivery_failed");
		}
		if (receipt.targetId !== undefined && receipt.targetId !== targetId) {
			throw new TaskCredentialError("task_credential_delivery_failed");
		}
		return receipt;
	}

	/** Replay the result of the transition that won an idempotency key. */
	private replay(leaseId: string, key: string): TaskCredentialStoreResult {
		const grant = this.fold.byLeaseId.get(leaseId);
		const receipt = this.fold.receiptByKey.get(key);
		if (grant === undefined || receipt === undefined) {
			throw new TaskCredentialError("task_credential_persistence_failed");
		}
		// `failed` only ever appears on delivery receipts in the fold; every other
		// status identifies the provider receipt synthesized from the transition.
		const isDeliveryReceipt =
			receipt.status === "succeeded" || receipt.status === "unknown" || receipt.status === "failed";
		return {
			grant: serializeTaskCredentialGrant(grant),
			receipt: isDeliveryReceipt
				? serializeTaskCredentialDeliveryReceipt(receipt as TaskCredentialDeliveryReceipt)
				: serializeTaskCredentialProviderReceipt(receipt as TaskCredentialProviderReceipt),
			appended: false,
			idempotent: true,
		};
	}

	private appendTransition(
		transition: TaskCredentialTransition,
		receipt: TaskCredentialProviderReceipt | TaskCredentialDeliveryReceipt,
	): TaskCredentialStoreResult {
		if (!isTaskCredentialTransition(transition)) {
			throw new TaskCredentialError("task_credential_persistence_failed");
		}
		let entryId: string;
		try {
			entryId = this.session.appendCustomEntry(TASK_CREDENTIAL_CUSTOM_TYPE, serializeTaskCredentialTransition(transition));
		} catch (error) {
			if (error instanceof TaskCredentialError) throw error;
			throw new TaskCredentialError("task_credential_persistence_failed");
		}
		try {
			this.refresh();
		} catch (error) {
			if (error instanceof TaskCredentialError) throw error;
			throw new TaskCredentialError("task_credential_persistence_failed");
		}
		// Prove that exactly this transition was folded back. The idempotency key
		// is registered only by the first accepted transition carrying it, so it
		// must now resolve to this transition's canonical payload; and the folded
		// grant must equal the appended snapshot in full.
		const key = idempotencyKey(operationForAction(transition.action), transition.clientRequestId);
		if (this.fold.byIdempotencyKey.get(key) !== canonicalTransitionPayload(transition)) {
			throw new TaskCredentialError("task_credential_persistence_failed");
		}
		const folded = this.fold.byLeaseId.get(transition.leaseId);
		if (folded === undefined || !sameGrantSnapshot(folded, transition.grant)) {
			throw new TaskCredentialError("task_credential_persistence_failed");
		}
		return {
			grant: serializeTaskCredentialGrant(folded),
			receipt,
			appended: true,
			idempotent: false,
			...(isTaskCredentialIdentifier(entryId) ? { entryId } : {}),
		};
	}

	/** Issue a grant and record the lease; the provider is called exactly once. */
	issue(input: TaskCredentialStoreIssueRequest): TaskCredentialStoreResult {
		validateStoreIssueRequest(input);
		// A binding from another Session cannot be issued into this Session's store.
		if (input.binding.sessionId !== this.sessionId) {
			throw new TaskCredentialError("task_credential_binding_invalid");
		}
		this.refresh();
		const nowMs = this.nowMs();
		const issueRequest: TaskCredentialIssueRequest = {
			grantId: input.grantId,
			leaseId: input.leaseId,
			binding: input.binding,
			scopes: input.scopes,
			requestedTtlMs: input.requestedTtlMs,
			ttlBounds: input.ttlBounds,
		};
		const grant = issueTaskCredentialGrant(issueRequest, nowMs);
		const key = idempotencyKey("issue", input.clientRequestId);
		const payload = canonicalTaskCredentialIssuePayload(
			serializeTaskExecutionBinding(input.binding),
			grant,
			input.leaseId,
			input.grantId,
		);
		const existing = this.fold.byIdempotencyKey.get(key);
		if (existing !== undefined) {
			if (existing !== payload) throw new TaskCredentialError("task_credential_conflict");
			return this.replay(input.leaseId, key);
		}
		if (this.fold.byLeaseId.has(input.leaseId)) throw new TaskCredentialError("task_credential_conflict");
		if (this.fold.byGrantId.has(input.grantId)) throw new TaskCredentialError("task_credential_conflict");
		if (this.bindingHasActiveGrant(input.binding.bindingId)) throw new TaskCredentialError("task_credential_conflict");
		const receipt = this.callIssuer("issue", input.leaseId, input.grantId, input.binding.bindingId, () =>
			this.provider.issuer.issue({
				schemaVersion: TASK_CREDENTIAL_SCHEMA_VERSION,
				leaseId: input.leaseId,
				grantId: input.grantId,
				binding: serializeTaskExecutionBinding(input.binding),
				scopes: normalizeTaskCredentialScopes(input.scopes),
				requestedTtlMs: input.requestedTtlMs,
				requestedAt: this.nextTimestamp(),
			}),
		);
		// Re-fold immediately before append so a concurrent writer cannot sneak a
		// conflicting grant or idempotency payload past the command-start snapshot.
		this.refresh();
		const freshExisting = this.fold.byIdempotencyKey.get(key);
		if (freshExisting !== undefined) {
			if (freshExisting !== payload) throw new TaskCredentialError("task_credential_conflict");
			return this.replay(input.leaseId, key);
		}
		if (this.fold.byLeaseId.has(input.leaseId)) throw new TaskCredentialError("task_credential_conflict");
		if (this.fold.byGrantId.has(input.grantId)) throw new TaskCredentialError("task_credential_conflict");
		if (this.bindingHasActiveGrant(input.binding.bindingId)) throw new TaskCredentialError("task_credential_conflict");
		const transition: TaskCredentialTransition = {
			schemaVersion: TASK_CREDENTIAL_SCHEMA_VERSION,
			action: "issued",
			leaseId: input.leaseId,
			grantId: input.grantId,
			bindingId: input.binding.bindingId,
			sessionId: this.sessionId,
			grant,
			previousRevision: 0,
			clientRequestId: input.clientRequestId,
			recordedAt: this.nextTimestamp(),
			binding: serializeTaskExecutionBinding(input.binding),
		};
		return this.appendTransition(transition, receipt);
	}

	/** Heartbeat-renew an active lease; the provider is called exactly once. */
	renew(input: TaskCredentialStoreRenewRequest): TaskCredentialStoreResult {
		validateStoreRenewRequest(input);
		this.refresh();
		const nowMs = this.nowMs();
		const grant = this.fold.byLeaseId.get(input.leaseId);
		if (grant === undefined) throw new TaskCredentialError("task_credential_not_found");
		const key = idempotencyKey("renew", input.clientRequestId);
		const payload = canonicalTaskCredentialRenewPayload(
			input.leaseId,
			grant.grantId,
			grant.bindingId,
			input.requestedTtlMs,
			input.heartbeatSequence,
		);
		const existing = this.fold.byIdempotencyKey.get(key);
		if (existing !== undefined) {
			if (existing !== payload) throw new TaskCredentialError("task_credential_conflict");
			return this.replay(input.leaseId, key);
		}
		// The client-supplied heartbeat sequence must be exactly the next one:
		// a duplicate, regression, or skip is rejected before the provider is
		// ever touched (and no entry is appended). The idempotency fold above
		// already decided replays, so a legal retry of the same request never
		// reaches this deny path.
		const denied = canHeartbeatTaskLease(grant, input.heartbeatSequence, nowMs);
		if (denied !== undefined) throw new TaskCredentialError(denied);
		// Validate TTL before the provider call so a bad TTL can never leave an
		// extended issuer-side credential behind; the snapshot is recomputed from
		// the fresh grant after the re-fold.
		transitionTaskCredentialStatus(grant, "renewed", {
			nowMs,
			heartbeatSequence: input.heartbeatSequence,
			ttlMs: input.requestedTtlMs,
			ttlBounds: input.ttlBounds,
		});
		const requestedAt = this.nextTimestamp();
		const receipt = this.callIssuer("renew", input.leaseId, grant.grantId, grant.bindingId, () =>
			this.provider.issuer.renew({
				schemaVersion: TASK_CREDENTIAL_SCHEMA_VERSION,
				leaseId: input.leaseId,
				grantId: grant.grantId,
				bindingId: grant.bindingId,
				requestedTtlMs: input.requestedTtlMs,
				requestedAt,
			}),
		);
		// The issuer is the renewal authority, but the exact material target
		// must also acknowledge the same bounded extension before it is made
		// durable. A target failure is fail-closed; the service tears the lease
		// down instead of leaving a partially renewed projection in use.
		if (input.targetLifecycle === "external_connector") {
			try {
				this.callIssuer("renew", input.leaseId, grant.grantId, grant.bindingId, () =>
					this.provider.target.renew({
						schemaVersion: TASK_CREDENTIAL_SCHEMA_VERSION,
						leaseId: input.leaseId,
						grantId: grant.grantId,
						bindingId: grant.bindingId,
						...(grant.targetId === undefined ? {} : { targetId: grant.targetId }),
						requestedTtlMs: input.requestedTtlMs,
						requestedAt,
					}),
				);
			} catch {
				throw new TaskCredentialError("task_credential_delivery_failed");
			}
		}
		this.refresh();
		const freshGrant = this.fold.byLeaseId.get(input.leaseId);
		if (freshGrant === undefined) throw new TaskCredentialError("task_credential_not_found");
		const freshExisting = this.fold.byIdempotencyKey.get(key);
		if (freshExisting !== undefined) {
			if (freshExisting !== payload) throw new TaskCredentialError("task_credential_conflict");
			return this.replay(input.leaseId, key);
		}
		const freshDenied = canHeartbeatTaskLease(freshGrant, input.heartbeatSequence, nowMs);
		if (freshDenied !== undefined) throw new TaskCredentialError(freshDenied);
		const freshNext = transitionTaskCredentialStatus(freshGrant, "renewed", {
			nowMs,
			heartbeatSequence: input.heartbeatSequence,
			ttlMs: input.requestedTtlMs,
			ttlBounds: input.ttlBounds,
		});
		const transition: TaskCredentialTransition = {
			schemaVersion: TASK_CREDENTIAL_SCHEMA_VERSION,
			action: "renewed",
			leaseId: input.leaseId,
			grantId: freshGrant.grantId,
			bindingId: freshGrant.bindingId,
			sessionId: this.sessionId,
			grant: freshNext,
			previousRevision: freshGrant.revision,
			clientRequestId: input.clientRequestId,
			recordedAt: this.nextTimestamp(),
			requestedTtlMs: input.requestedTtlMs,
		};
		return this.appendTransition(transition, receipt);
	}

	/** Project the credential into its bound target; the receipt decides the recorded outcome. */
	project(input: TaskCredentialStoreProjectRequest): TaskCredentialStoreResult {
		validateStoreProjectRequest(input);
		this.refresh();
		const nowMs = this.nowMs();
		const grant = this.fold.byLeaseId.get(input.leaseId);
		if (grant === undefined) throw new TaskCredentialError("task_credential_not_found");
		if (input.targetId !== undefined && input.targetId !== grant.targetId) {
			throw new TaskCredentialError("task_credential_conflict");
		}
		const key = idempotencyKey("project", input.clientRequestId);
		const payload = canonicalTaskCredentialProjectPayload(input.leaseId, grant.grantId, grant.bindingId, grant.targetId);
		const existing = this.fold.byIdempotencyKey.get(key);
		if (existing !== undefined) {
			if (existing !== payload) throw new TaskCredentialError("task_credential_conflict");
			return this.replay(input.leaseId, key);
		}
		const denied = canRenewTaskLease(grant, nowMs);
		if (denied !== undefined) throw new TaskCredentialError(denied);
		const requestedAt = this.nextTimestamp();
		const receipt = this.callTarget(input.leaseId, grant.grantId, grant.bindingId, grant.targetId, () =>
			this.provider.target.project({
				schemaVersion: TASK_CREDENTIAL_SCHEMA_VERSION,
				leaseId: input.leaseId,
				grantId: grant.grantId,
				bindingId: grant.bindingId,
				...(grant.targetId === undefined ? {} : { targetId: grant.targetId }),
				requestedAt,
			}),
		);
		if (receipt.status === "unknown") {
			// An unconfirmed outcome is never recorded as success; fail closed.
			throw new TaskCredentialError("task_credential_delivery_failed");
		}
		const action = receipt.status === "succeeded" ? "delivery_succeeded" : "delivery_failed";
		const persistedReceipt: TaskCredentialDeliveryReceipt = {
			schemaVersion: TASK_CREDENTIAL_SCHEMA_VERSION,
			leaseId: input.leaseId,
			grantId: grant.grantId,
			bindingId: grant.bindingId,
			status: receipt.status,
			recordedAt: receipt.recordedAt,
		};
		if (grant.targetId !== undefined) (persistedReceipt as { targetId?: string }).targetId = grant.targetId;
		if (receipt.reasonCode !== undefined) (persistedReceipt as { reasonCode?: string }).reasonCode = receipt.reasonCode;
		this.refresh();
		const freshGrant = this.fold.byLeaseId.get(input.leaseId);
		if (freshGrant === undefined) throw new TaskCredentialError("task_credential_not_found");
		const freshExisting = this.fold.byIdempotencyKey.get(key);
		if (freshExisting !== undefined) {
			if (freshExisting !== payload) throw new TaskCredentialError("task_credential_conflict");
			return this.replay(input.leaseId, key);
		}
		const freshDenied = canRenewTaskLease(freshGrant, nowMs);
		if (freshDenied !== undefined) throw new TaskCredentialError(freshDenied);
		const next = transitionTaskCredentialStatus(freshGrant, action, { nowMs, delivery: persistedReceipt });
		const transition: TaskCredentialTransition = {
			schemaVersion: TASK_CREDENTIAL_SCHEMA_VERSION,
			action,
			leaseId: input.leaseId,
			grantId: freshGrant.grantId,
			bindingId: freshGrant.bindingId,
			sessionId: this.sessionId,
			grant: next,
			previousRevision: freshGrant.revision,
			clientRequestId: input.clientRequestId,
			recordedAt: this.nextTimestamp(),
			deliveryReceipt: persistedReceipt,
		};
		return this.appendTransition(transition, persistedReceipt);
	}

	/**
	 * Revoke the lease at the issuer. A confirmed `revoked` receipt appends
	 * `revoked`. Any provider exception, timeout-like failure, or unsafe,
	 * malformed, or mismatched revoke receipt fails closed: it appends
	 * `revocation_unknown` with a safe provider-neutral receipt and never
	 * surfaces raw error data. A retry from `revocation_unknown` must set
	 * `providerConfirmedRevoke: true`; the issuer is asked to confirm again
	 * and only a confirmed `revoked` receipt appends `revoked`. An
	 * unconfirmed retry leaves the lease quarantined in `revocation_unknown`
	 * and appends nothing.
	 */
	revoke(input: TaskCredentialStoreRevokeRequest): TaskCredentialStoreResult {
		validateStoreRevokeRequest(input);
		this.refresh();
		const nowMs = this.nowMs();
		const grant = this.fold.byLeaseId.get(input.leaseId);
		if (grant === undefined) throw new TaskCredentialError("task_credential_not_found");
		const key = idempotencyKey("revoke", input.clientRequestId);
		const payload = canonicalTaskCredentialRevokePayload(input.leaseId, grant.grantId, grant.bindingId, input.reasonCode);
		const existing = this.fold.byIdempotencyKey.get(key);
		if (existing !== undefined) {
			if (existing !== payload) throw new TaskCredentialError("task_credential_conflict");
			return this.replay(input.leaseId, key);
		}
		// A confirmed retry is the only way out of `revocation_unknown`; a
		// plain revoke request must come from a live lease.
		const reconcile = input.providerConfirmedRevoke === true;
		const denied = reconcile ? canReconcileTaskLease(grant) : canRevokeTaskLease(grant);
		if (denied !== undefined) throw new TaskCredentialError(denied);
		const requestedAt = this.nextTimestamp();
		const targetReceipt =
			input.targetLifecycle === "external_connector"
				? this.callRevoke(input.leaseId, grant.grantId, grant.bindingId, () =>
						this.provider.target.revoke({
							schemaVersion: TASK_CREDENTIAL_SCHEMA_VERSION,
							leaseId: input.leaseId,
							grantId: grant.grantId,
							bindingId: grant.bindingId,
							...(grant.targetId === undefined ? {} : { targetId: grant.targetId }),
							...(input.reasonCode === undefined ? {} : { reasonCode: input.reasonCode }),
							requestedAt,
						}),
					)
				: undefined;
		const issuerReceipt = this.callRevoke(input.leaseId, grant.grantId, grant.bindingId, () =>
			this.provider.issuer.revoke({
				schemaVersion: TASK_CREDENTIAL_SCHEMA_VERSION,
				leaseId: input.leaseId,
				grantId: grant.grantId,
				bindingId: grant.bindingId,
				...(input.reasonCode === undefined ? {} : { reasonCode: input.reasonCode }),
				requestedAt,
			}),
		);
		const receipt =
			(targetReceipt === undefined || targetReceipt.status === "revoked") && issuerReceipt.status === "revoked"
				? issuerReceipt
				: this.revocationUnknownReceipt(input.leaseId, grant.grantId, grant.bindingId);
		if (reconcile && receipt.status !== "revoked") {
			// The confirmed retry did not confirm; the lease stays quarantined
			// in `revocation_unknown` and no new transition is legal.
			throw new TaskCredentialError("task_credential_revocation_unknown");
		}
		const action = receipt.status === "revoked" ? "revoked" : "revocation_unknown";
		this.refresh();
		const freshGrant = this.fold.byLeaseId.get(input.leaseId);
		if (freshGrant === undefined) throw new TaskCredentialError("task_credential_not_found");
		const freshExisting = this.fold.byIdempotencyKey.get(key);
		if (freshExisting !== undefined) {
			if (freshExisting !== payload) throw new TaskCredentialError("task_credential_conflict");
			return this.replay(input.leaseId, key);
		}
		const freshDenied = reconcile ? canReconcileTaskLease(freshGrant) : canRevokeTaskLease(freshGrant);
		if (freshDenied !== undefined) throw new TaskCredentialError(freshDenied);
		const next = transitionTaskCredentialStatus(freshGrant, action, {
			nowMs,
			...(reconcile ? { providerConfirmedRevoke: true } : {}),
			...(input.reasonCode === undefined ? {} : { reasonCode: input.reasonCode }),
		});
		const transition: TaskCredentialTransition = {
			schemaVersion: TASK_CREDENTIAL_SCHEMA_VERSION,
			action,
			leaseId: input.leaseId,
			grantId: freshGrant.grantId,
			bindingId: freshGrant.bindingId,
			sessionId: this.sessionId,
			grant: next,
			previousRevision: freshGrant.revision,
			clientRequestId: input.clientRequestId,
			recordedAt: this.nextTimestamp(),
			...(input.reasonCode === undefined ? {} : { reasonCode: input.reasonCode }),
		};
		return this.appendTransition(transition, receipt);
	}

	/**
	 * Settle the lease locally with a safe receipt; the issuer is not
	 * touched. Legal only after a delivery receipt (`delivery_succeeded` /
	 * `delivery_failed`) has already been folded for the lease AND the
	 * current grant is `revoked` (provider-confirmed); `active`, `expired`,
	 * and `revocation_unknown` never settle.
	 */
	settle(input: TaskCredentialStoreSettleRequest): TaskCredentialStoreResult {
		validateStoreSettleRequest(input);
		this.refresh();
		const nowMs = this.nowMs();
		const grant = this.fold.byLeaseId.get(input.leaseId);
		if (grant === undefined) throw new TaskCredentialError("task_credential_not_found");
		const key = idempotencyKey("settle", input.clientRequestId);
		const payload = canonicalTaskCredentialSettlePayload(input.leaseId, grant.grantId, grant.bindingId, input.reasonCode);
		const existing = this.fold.byIdempotencyKey.get(key);
		if (existing !== undefined) {
			if (existing !== payload) throw new TaskCredentialError("task_credential_conflict");
			return this.replay(input.leaseId, key);
		}
		const denied = canSettleTaskLease(grant);
		if (denied !== undefined) throw new TaskCredentialError(denied);
		// The service settles only after delivery is recorded and the revoke
		// is confirmed; a lease revoked without a folded delivery receipt, or
		// one stuck in `revocation_unknown`, is unsuitable for settle.
		if (!this.fold.deliveryByLeaseId.has(input.leaseId)) {
			throw new TaskCredentialError("task_credential_conflict");
		}
		const recordedAt = this.nextTimestamp();
		const receipt: TaskCredentialProviderReceipt = {
			schemaVersion: TASK_CREDENTIAL_SCHEMA_VERSION,
			leaseId: input.leaseId,
			grantId: grant.grantId,
			bindingId: grant.bindingId,
			status: "settled",
			recordedAt,
		};
		this.refresh();
		const freshGrant = this.fold.byLeaseId.get(input.leaseId);
		if (freshGrant === undefined) throw new TaskCredentialError("task_credential_not_found");
		const freshExisting = this.fold.byIdempotencyKey.get(key);
		if (freshExisting !== undefined) {
			if (freshExisting !== payload) throw new TaskCredentialError("task_credential_conflict");
			return this.replay(input.leaseId, key);
		}
		const freshDenied = canSettleTaskLease(freshGrant);
		if (freshDenied !== undefined) throw new TaskCredentialError(freshDenied);
		if (!this.fold.deliveryByLeaseId.has(input.leaseId)) {
			throw new TaskCredentialError("task_credential_conflict");
		}
		const next = transitionTaskCredentialStatus(freshGrant, "settled", {
			nowMs,
			...(input.reasonCode === undefined ? {} : { reasonCode: input.reasonCode }),
		});
		const transition: TaskCredentialTransition = {
			schemaVersion: TASK_CREDENTIAL_SCHEMA_VERSION,
			action: "settled",
			leaseId: input.leaseId,
			grantId: freshGrant.grantId,
			bindingId: freshGrant.bindingId,
			sessionId: this.sessionId,
			grant: next,
			previousRevision: freshGrant.revision,
			clientRequestId: input.clientRequestId,
			recordedAt,
			...(input.reasonCode === undefined ? {} : { reasonCode: input.reasonCode }),
		};
		return this.appendTransition(transition, receipt);
	}

	/** Read the current grant of one lease. Read-only; never appends. */
	get(leaseId: string): TaskCredentialGrant | undefined {
		if (!isBoundedIdentifier(leaseId, TASK_CREDENTIAL_IDENTIFIER_MAX_LENGTH)) {
			throw new TaskCredentialError("task_credential_invalid");
		}
		this.refresh();
		const grant = this.fold.byLeaseId.get(leaseId);
		return grant === undefined ? undefined : serializeTaskCredentialGrant(grant);
	}

	/** Latest safe delivery receipt for one lease. Read-only; never appends. */
	getDeliveryReceipt(leaseId: string): TaskCredentialDeliveryReceipt | undefined {
		if (!isBoundedIdentifier(leaseId, TASK_CREDENTIAL_IDENTIFIER_MAX_LENGTH)) {
			throw new TaskCredentialError("task_credential_invalid");
		}
		this.refresh();
		const receipt = this.fold.deliveryByLeaseId.get(leaseId);
		return receipt === undefined ? undefined : serializeTaskCredentialDeliveryReceipt(receipt);
	}

	/** Read the current grant by opaque grant id. Read-only; never appends. */
	getByGrantId(grantId: string): TaskCredentialGrant | undefined {
		if (!isBoundedIdentifier(grantId, TASK_CREDENTIAL_IDENTIFIER_MAX_LENGTH)) {
			throw new TaskCredentialError("task_credential_invalid");
		}
		this.refresh();
		const grant = this.fold.byGrantId.get(grantId);
		return grant === undefined ? undefined : serializeTaskCredentialGrant(grant);
	}

	/** Read every grant of one binding in issue order. Read-only; never appends. */
	getByBindingId(bindingId: string): ReadonlyArray<TaskCredentialGrant> {
		if (!isBoundedIdentifier(bindingId, TASK_CREDENTIAL_IDENTIFIER_MAX_LENGTH)) {
			throw new TaskCredentialError("task_credential_invalid");
		}
		this.refresh();
		const grants = this.fold.byBindingId.get(bindingId);
		return grants === undefined ? [] : grants.map((grant) => serializeTaskCredentialGrant(grant));
	}

	/** Read every grant of the current Session in issue order. Read-only; never appends. */
	list(): ReadonlyArray<TaskCredentialGrant> {
		this.refresh();
		return this.fold.grants.map((grant) => serializeTaskCredentialGrant(grant));
	}
}

export function createTaskCredentialStore(
	session: TaskCredentialSession,
	provider: TaskCredentialProvider,
	options?: TaskCredentialStoreOptions,
): TaskCredentialStore {
	return new TaskCredentialStore(session, provider, options);
}
