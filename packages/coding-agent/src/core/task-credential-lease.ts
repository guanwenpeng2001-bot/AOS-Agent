/**
 * Task Credential / Lease v1 core (PR contract).
 *
 * Provider-neutral pure types, constants, input validation, scope
 * normalization, digest, bounded TTL, and the legal grant status machine for
 * the Task Credential / Lease v1 contract. This module never talks to a
 * Session, RPC, provider, or wall clock: every state-machine entry point
 * takes an explicit deterministic clock value (`nowMs`, epoch milliseconds)
 * and converts it to canonical UTC ISO timestamps for the public records.
 *
 * Public facts:
 *
 * - `TaskExecutionBinding` freezes the execution identity of a grant:
 *   session, task, graph revision, node, stage (paired), run, capability /
 *   policy / sandbox bindings, and optional target / worker association.
 *   It is immutable once a grant references it; renewals cannot migrate a
 *   grant to a new Run, stage revision, or policy binding.
 * - `TaskCredentialScope` is a structured allowlist item
 *   (`credentialName`, `purpose`, optional `resource`, `operations`,
 *   `targetKinds`) - never a raw string array. Scopes are normalized
 *   (trim, drop empties, validate, dedupe, sort) and reduced to
 *   `scopeDigest` + `scopeCount`; raw scope content never leaves this
 *   module's callers via the grant serializer.
 * - `TaskCredentialGrant` is the public safe record: IDs, digest, count,
 *   status, ISO timestamps, heartbeat sequence, revision, and optional
 *   target / reason code. It never contains credential material; the
 *   module never accepts, stores, or exports material of any kind.
 * - `TaskCredentialDeliveryReceipt` records the provider-neutral outcome of
 *   a target projection (`succeeded` / `failed` / `unknown`).
 *
 * State machine: `issued` creates an `active` grant at revision 0 and
 * heartbeat sequence 0. `renewed` (heartbeat / renew) extends `active` with
 * a strictly increasing `heartbeatSequence` and a bounded TTL, never
 * touching binding, scope, or target. `delivery_succeeded` /
 * `delivery_failed` record projection outcomes on an `active` lease.
 * `revoked` / `revocation_unknown` are reachable from `active` or `expired`;
 * `expired` only from `active` when the clock passed `expiresAt`; `settled`
 * only from `revoked` - the service settles only after delivery is recorded
 * and the revoke is confirmed. `expired`, `revoked`, `settled`, and
 * `revocation_unknown` are terminal - no transition may resurrect them -
 * and `revocation_unknown` converges to `revoked` only through provider
 * confirmed reconciliation, which the `revoked` transition requires as an
 * explicit `providerConfirmedRevoke: true` option (never raw provider
 * data). Every accepted transition increments `revision` by exactly one;
 * only `renewed` increments `heartbeatSequence`.
 *
 * Error codes are the frozen, provider-neutral set from the PR contract.
 * Serializers copy only an explicit allowlist of fields and reject unknown
 * keys, so raw scope, material, provider data, or caller payloads cannot
 * leak through the public record. No enum, namespace, parameter property,
 * or dynamic import is used.
 */

import { createHash } from "node:crypto";

export const TASK_CREDENTIAL_SCHEMA_VERSION = 1 as const;

/** Absolute floor for a grant or renewal TTL (also covers the renewal window). */
export const TASK_CREDENTIAL_MIN_TTL_MS = 10_000;

/** Absolute ceiling for a grant or renewal TTL before deadline limits apply. */
export const TASK_CREDENTIAL_MAX_TTL_MS = 24 * 60 * 60 * 1000;

/** Window before `expiresAt` inside which renewal keeps the lease usable. */
export const TASK_CREDENTIAL_RENEWAL_WINDOW_MS = 5_000;

export const TASK_CREDENTIAL_MAX_SCOPES = 16;
export const TASK_CREDENTIAL_MAX_OPERATIONS = 8;
export const TASK_CREDENTIAL_MAX_TARGET_KINDS = 8;
export const TASK_CREDENTIAL_SCOPE_FIELD_MAX_LENGTH = 128;
export const TASK_CREDENTIAL_SCOPE_ITEM_MAX_LENGTH = 32;
export const TASK_CREDENTIAL_IDENTIFIER_MAX_LENGTH = 128;
export const TASK_CREDENTIAL_REASON_CODE_MAX_LENGTH = 64;

export const TASK_CREDENTIAL_SCOPE_DIGEST_PREFIX = "sha256:" as const;

export const TASK_CREDENTIAL_STATUS = [
	"active",
	"renewing",
	"expired",
	"revoked",
	"settled",
	"revocation_unknown",
] as const;
export type TaskCredentialStatus = (typeof TASK_CREDENTIAL_STATUS)[number];

export const TASK_CREDENTIAL_ACTION = [
	"issued",
	"renewed",
	"delivery_succeeded",
	"delivery_failed",
	"revoked",
	"expired",
	"settled",
	"revocation_unknown",
] as const;
export type TaskCredentialAction = (typeof TASK_CREDENTIAL_ACTION)[number];

export const TASK_CREDENTIAL_DELIVERY_STATUS = ["succeeded", "failed", "unknown"] as const;
export type TaskCredentialDeliveryStatus = (typeof TASK_CREDENTIAL_DELIVERY_STATUS)[number];

/**
 * Stable, provider-neutral error codes frozen by the PR contract. Only
 * `task_credential_provider_unavailable` is retryable; every other failure
 * requires the caller to re-read the current state instead of guessing.
 */
export const TASK_CREDENTIAL_ERROR_CODES = [
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
] as const;
export type TaskCredentialErrorCode = (typeof TASK_CREDENTIAL_ERROR_CODES)[number];

const TASK_CREDENTIAL_ERROR_MESSAGES: Readonly<Record<TaskCredentialErrorCode, string>> = {
	task_credential_invalid: "Task credential input is invalid.",
	task_credential_binding_invalid: "Task credential binding is invalid or does not match the execution context.",
	task_credential_gate_required: "Task credential requires an approved task gate for this stage revision.",
	task_credential_policy_denied: "Task credential policy denied the requested scope, target, or action.",
	task_credential_approval_required: "Task credential policy approval is required but not granted.",
	task_credential_scope_denied: "Task credential requested scope exceeds the allowlist.",
	task_credential_ttl_invalid: "Task credential TTL is outside the allowed bounds or deadlines.",
	task_credential_provider_unavailable: "Task credential issuer is temporarily unavailable.",
	task_credential_issue_failed: "Task credential issuer did not return a manageable grant.",
	task_credential_not_found: "Task credential grant or lease was not found.",
	task_credential_conflict: "Task credential state conflict: binding, scope, target, or revision does not match.",
	task_lease_expired: "Task credential lease is expired and cannot be extended.",
	task_lease_heartbeat_invalid: "Task credential heartbeat sequence is not strictly increasing.",
	task_credential_target_unavailable:
		"Task credential target does not declare the required isolation or revocation capability.",
	task_credential_delivery_failed: "Task credential delivery failed.",
	task_credential_revocation_unknown: "Task credential revocation outcome is unknown.",
	task_credential_persistence_failed: "Task credential transition could not be persisted; re-read the current state.",
};

const RETRYABLE_ERROR_CODES: ReadonlySet<TaskCredentialErrorCode> = new Set([
	"task_credential_provider_unavailable",
]);

export interface TaskCredentialErrorView {
	readonly code: TaskCredentialErrorCode;
	readonly message: string;
	readonly retryable: boolean;
}

/**
 * Immutable execution identity of a grant. `stageId` and `stageRevision`
 * must appear together or not at all. Contains no prompt, diff, command,
 * path, env, headers, token, or model output.
 */
export interface TaskExecutionBinding {
	readonly schemaVersion: 1;
	readonly bindingId: string;
	readonly sessionId: string;
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
	readonly workerId?: string;
	readonly createdAt: string;
	readonly bindingRevision: number;
}

/** Structured allowlist scope item; never a free-form string array. */
export interface TaskCredentialScope {
	readonly credentialName: string;
	readonly purpose: string;
	readonly resource?: string;
	readonly operations: ReadonlyArray<string>;
	readonly targetKinds: ReadonlyArray<string>;
}

/** TTL limits for issue / renewal: profile + policy ceiling and earliest deadline. */
export interface TaskCredentialTtlBounds {
	readonly minTtlMs: number;
	readonly maxTtlMs: number;
	/** Earliest of Task deadline and Run deadline, epoch ms; optional. */
	readonly deadlineAtMs?: number;
}

/** RPC-independent issue input; the caller supplies the IDs and binding. */
export interface TaskCredentialIssueRequest {
	readonly grantId: string;
	readonly leaseId: string;
	readonly binding: TaskExecutionBinding;
	readonly scopes: ReadonlyArray<TaskCredentialScope>;
	readonly requestedTtlMs: number;
	readonly ttlBounds: TaskCredentialTtlBounds;
}

/** Options for one state transition; the action decides which fields apply. */
export interface TaskCredentialTransitionOptions {
	/** Deterministic clock value, epoch ms. */
	readonly nowMs: number;
	/** Required for `renewed`: must equal `heartbeatSequence + 1`. */
	readonly heartbeatSequence?: number;
	/** Required for `renewed`: next window TTL, bounded by `ttlBounds`. */
	readonly ttlMs?: number;
	readonly ttlBounds?: TaskCredentialTtlBounds;
	/** Optional for terminal transitions and delivery actions. */
	readonly reasonCode?: string;
	/** Optional for `delivery_succeeded` / `delivery_failed`. */
	readonly delivery?: TaskCredentialDeliveryReceipt;
	/**
	 * Required `true` for `revoked` from `revocation_unknown`: marks the
	 * transition as provider-confirmed reconciliation. Carries no raw or
	 * provider data; any other value is rejected.
	 */
	readonly providerConfirmedRevoke?: boolean;
}

/**
 * Public safe grant record: opaque IDs, digest, count, status, ISO
 * timestamps, heartbeat sequence, and revision. Never contains credential
 * material and never exposes raw scope content.
 */
export interface TaskCredentialGrant {
	readonly schemaVersion: 1;
	readonly grantId: string;
	readonly leaseId: string;
	readonly bindingId: string;
	readonly sessionId: string;
	readonly taskId: string;
	readonly graphRevision: number;
	readonly nodeId: string;
	readonly stageId?: string;
	readonly stageRevision?: number;
	readonly runId: string;
	readonly scopeDigest: string;
	readonly scopeCount: number;
	readonly status: TaskCredentialStatus;
	readonly issuedAt: string;
	readonly expiresAt: string;
	readonly renewAfter: string;
	readonly heartbeatSequence: number;
	readonly revision: number;
	readonly targetId?: string;
	readonly reasonCode?: string;
}

/** Provider-neutral outcome of a target projection; never carries material. */
export interface TaskCredentialDeliveryReceipt {
	readonly schemaVersion: 1;
	readonly leaseId: string;
	readonly grantId: string;
	readonly bindingId: string;
	readonly targetId?: string;
	readonly status: TaskCredentialDeliveryStatus;
	readonly recordedAt: string;
	readonly reasonCode?: string;
}

export class TaskCredentialError extends Error {
	readonly code: TaskCredentialErrorCode;
	readonly retryable: boolean;

	constructor(code: TaskCredentialErrorCode) {
		// Errors cross boundaries as Error.message. Keep that channel
		// code-derived so caller payloads, paths, or material cannot escape
		// through a caller-supplied message.
		super(TASK_CREDENTIAL_ERROR_MESSAGES[code]);
		this.name = "TaskCredentialError";
		this.code = code;
		this.retryable = RETRYABLE_ERROR_CODES.has(code);
	}

	toJSON(): TaskCredentialErrorView {
		return {
			code: this.code,
			message: TASK_CREDENTIAL_ERROR_MESSAGES[this.code],
			retryable: this.retryable,
		};
	}
}

const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const CANONICAL_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SCOPE_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

const BINDING_KEYS = new Set([
	"schemaVersion",
	"bindingId",
	"sessionId",
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
	"workerId",
	"createdAt",
	"bindingRevision",
]);
const SCOPE_KEYS = new Set(["credentialName", "purpose", "resource", "operations", "targetKinds"]);
const GRANT_KEYS = new Set([
	"schemaVersion",
	"grantId",
	"leaseId",
	"bindingId",
	"sessionId",
	"taskId",
	"graphRevision",
	"nodeId",
	"stageId",
	"stageRevision",
	"runId",
	"scopeDigest",
	"scopeCount",
	"status",
	"issuedAt",
	"expiresAt",
	"renewAfter",
	"heartbeatSequence",
	"revision",
	"targetId",
	"reasonCode",
]);
const RECEIPT_KEYS = new Set([
	"schemaVersion",
	"leaseId",
	"grantId",
	"bindingId",
	"targetId",
	"status",
	"recordedAt",
	"reasonCode",
]);
const ISSUE_KEYS = new Set([
	"grantId",
	"leaseId",
	"binding",
	"scopes",
	"requestedTtlMs",
	"ttlBounds",
]);
const TTL_BOUNDS_KEYS = new Set(["minTtlMs", "maxTtlMs", "deadlineAtMs"]);
const OPTION_KEYS = new Set([
	"nowMs",
	"heartbeatSequence",
	"ttlMs",
	"ttlBounds",
	"reasonCode",
	"delivery",
	"providerConfirmedRevoke",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
	return Object.keys(value).every((key) => allowed.has(key));
}

/** Safe opaque identifiers reject paths, URLs, userinfo, query text, and controls. */
export function isTaskCredentialIdentifier(value: unknown): value is string {
	return (
		typeof value === "string" &&
		SAFE_IDENTIFIER_PATTERN.test(value) &&
		!value.includes("/") &&
		!value.includes("\\") &&
		!value.includes("?") &&
		!value.includes("#") &&
		!value.includes("@") &&
		!value.includes("://")
	);
}

/** Canonical UTC ISO timestamps with millisecond precision, round-trip checked. */
export function isTaskCredentialIsoTimestamp(value: unknown): value is string {
	if (typeof value !== "string" || !CANONICAL_TIMESTAMP_PATTERN.test(value)) return false;
	const ms = Date.parse(value);
	return Number.isFinite(ms) && new Date(ms).toISOString() === value;
}

/** Deterministic clock values are non-negative safe integers (epoch ms). */
export function isTaskCredentialEpochMs(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isBoundedIdentifier(value: unknown, maxLength: number): value is string {
	return isTaskCredentialIdentifier(value) && value.length <= maxLength;
}

function isPositiveSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isBoundedReasonCode(value: unknown): value is string {
	return isBoundedIdentifier(value, TASK_CREDENTIAL_REASON_CODE_MAX_LENGTH);
}

function isoFromEpochMs(epochMs: number): string {
	return new Date(epochMs).toISOString();
}

function epochMsOf(iso: string): number {
	return Date.parse(iso);
}

/** Validate a binding snapshot field-by-field; throws `task_credential_binding_invalid`. */
export function validateTaskExecutionBinding(value: unknown): void {
	if (!isTaskExecutionBinding(value)) {
		throw new TaskCredentialError("task_credential_binding_invalid");
	}
}

/** Structural guard for a binding snapshot, including the stage pairing rule. */
export function isTaskExecutionBinding(value: unknown): value is TaskExecutionBinding {
	if (!isRecord(value) || !hasOnlyKeys(value, BINDING_KEYS)) return false;
	if (value.schemaVersion !== TASK_CREDENTIAL_SCHEMA_VERSION) return false;
	if (
		!isBoundedIdentifier(value.bindingId, TASK_CREDENTIAL_IDENTIFIER_MAX_LENGTH) ||
		!isBoundedIdentifier(value.sessionId, TASK_CREDENTIAL_IDENTIFIER_MAX_LENGTH) ||
		!isBoundedIdentifier(value.taskId, TASK_CREDENTIAL_IDENTIFIER_MAX_LENGTH) ||
		!isBoundedIdentifier(value.nodeId, TASK_CREDENTIAL_IDENTIFIER_MAX_LENGTH) ||
		!isBoundedIdentifier(value.runId, TASK_CREDENTIAL_IDENTIFIER_MAX_LENGTH) ||
		!isBoundedIdentifier(value.capabilityBindingId, TASK_CREDENTIAL_IDENTIFIER_MAX_LENGTH) ||
		!isBoundedIdentifier(value.policyBindingId, TASK_CREDENTIAL_IDENTIFIER_MAX_LENGTH)
	) {
		return false;
	}
	if (
		(value.stageId !== undefined && !isBoundedIdentifier(value.stageId, TASK_CREDENTIAL_IDENTIFIER_MAX_LENGTH)) ||
		(value.sandboxBindingId !== undefined &&
			!isBoundedIdentifier(value.sandboxBindingId, TASK_CREDENTIAL_IDENTIFIER_MAX_LENGTH)) ||
		(value.targetId !== undefined && !isBoundedIdentifier(value.targetId, TASK_CREDENTIAL_IDENTIFIER_MAX_LENGTH)) ||
		(value.workerId !== undefined && !isBoundedIdentifier(value.workerId, TASK_CREDENTIAL_IDENTIFIER_MAX_LENGTH))
	) {
		return false;
	}
	if (
		!isPositiveSafeInteger(value.graphRevision) ||
		(value.stageRevision !== undefined && !isPositiveSafeInteger(value.stageRevision)) ||
		!isPositiveSafeInteger(value.bindingRevision)
	) {
		return false;
	}
	// stageId / stageRevision must appear together or not at all.
	if ((value.stageId === undefined) !== (value.stageRevision === undefined)) return false;
	if (!isTaskCredentialIsoTimestamp(value.createdAt)) return false;
	return true;
}

/** Defensive public copy of a binding snapshot. */
export function serializeTaskExecutionBinding(value: TaskExecutionBinding): TaskExecutionBinding {
	const binding: TaskExecutionBinding = {
		schemaVersion: TASK_CREDENTIAL_SCHEMA_VERSION,
		bindingId: value.bindingId,
		sessionId: value.sessionId,
		taskId: value.taskId,
		graphRevision: value.graphRevision,
		nodeId: value.nodeId,
		runId: value.runId,
		capabilityBindingId: value.capabilityBindingId,
		policyBindingId: value.policyBindingId,
		createdAt: value.createdAt,
		bindingRevision: value.bindingRevision,
	};
	if (value.stageId !== undefined) (binding as { stageId?: string }).stageId = value.stageId;
	if (value.stageRevision !== undefined) (binding as { stageRevision?: number }).stageRevision = value.stageRevision;
	if (value.sandboxBindingId !== undefined) {
		(binding as { sandboxBindingId?: string }).sandboxBindingId = value.sandboxBindingId;
	}
	if (value.targetId !== undefined) (binding as { targetId?: string }).targetId = value.targetId;
	if (value.workerId !== undefined) (binding as { workerId?: string }).workerId = value.workerId;
	return binding;
}

/** Parse only the exact schema-versioned binding payload. */
export function parseTaskExecutionBinding(value: unknown): TaskExecutionBinding | undefined {
	return isTaskExecutionBinding(value) ? serializeTaskExecutionBinding(value) : undefined;
}

function isScopeItemArray(value: unknown, maxItems: number): value is ReadonlyArray<string> {
	if (!Array.isArray(value) || value.length > maxItems) return false;
	for (const item of value) {
		if (
			typeof item !== "string" ||
			!isTaskCredentialIdentifier(item) ||
			item.length > TASK_CREDENTIAL_SCOPE_ITEM_MAX_LENGTH
		) {
			return false;
		}
	}
	return true;
}

/** Structural guard for a single scope item (order and duplicates tolerated). */
export function isTaskCredentialScope(value: unknown): value is TaskCredentialScope {
	if (!isRecord(value) || !hasOnlyKeys(value, SCOPE_KEYS)) return false;
	if (
		!isBoundedIdentifier(value.credentialName, TASK_CREDENTIAL_SCOPE_FIELD_MAX_LENGTH) ||
		!isBoundedIdentifier(value.purpose, TASK_CREDENTIAL_SCOPE_FIELD_MAX_LENGTH)
	) {
		return false;
	}
	if (value.resource !== undefined && !isBoundedIdentifier(value.resource, TASK_CREDENTIAL_SCOPE_FIELD_MAX_LENGTH)) {
		return false;
	}
	return (
		isScopeItemArray(value.operations, TASK_CREDENTIAL_MAX_OPERATIONS) &&
		isScopeItemArray(value.targetKinds, TASK_CREDENTIAL_MAX_TARGET_KINDS)
	);
}

/**
 * Normalize a scope list: validate structure, trim strings, drop empty
 * items, dedupe and sort operations / target kinds, dedupe identical
 * scopes, and sort by canonical key. Throws `task_credential_invalid` for
 * structural violations and over-limit counts. Returns a fresh array; the
 * input is never mutated.
 */
export function normalizeTaskCredentialScopes(
	scopes: ReadonlyArray<TaskCredentialScope>,
): ReadonlyArray<TaskCredentialScope> {
	if (!Array.isArray(scopes)) {
		throw new TaskCredentialError("task_credential_invalid");
	}
	if (scopes.length > TASK_CREDENTIAL_MAX_SCOPES) {
		throw new TaskCredentialError("task_credential_invalid");
	}
	const normalized: TaskCredentialScope[] = [];
	const seen = new Set<string>();
	for (const raw of scopes) {
		if (!isRecord(raw) || !hasOnlyKeys(raw, SCOPE_KEYS)) {
			throw new TaskCredentialError("task_credential_invalid");
		}
		const credentialName = normalizeScopeField(raw.credentialName, TASK_CREDENTIAL_SCOPE_FIELD_MAX_LENGTH);
		const purpose = normalizeScopeField(raw.purpose, TASK_CREDENTIAL_SCOPE_FIELD_MAX_LENGTH);
		const resource =
			raw.resource === undefined ? undefined : normalizeScopeField(raw.resource, TASK_CREDENTIAL_SCOPE_FIELD_MAX_LENGTH);
		const operations = normalizeScopeItems(raw.operations, TASK_CREDENTIAL_MAX_OPERATIONS);
		const targetKinds = normalizeScopeItems(raw.targetKinds, TASK_CREDENTIAL_MAX_TARGET_KINDS);
		const scope: TaskCredentialScope = { credentialName, purpose, operations, targetKinds };
		if (resource !== undefined) (scope as { resource?: string }).resource = resource;
		const key = scopeCanonicalString(scope);
		if (!seen.has(key)) {
			seen.add(key);
			normalized.push(scope);
		}
	}
	normalized.sort((left, right) => {
		const leftKey = scopeCanonicalString(left);
		const rightKey = scopeCanonicalString(right);
		return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
	});
	return normalized;
}

function normalizeScopeField(value: unknown, maxLength: number): string {
	if (typeof value !== "string") {
		throw new TaskCredentialError("task_credential_invalid");
	}
	const trimmed = value.trim();
	if (trimmed.length === 0 || !isBoundedIdentifier(trimmed, maxLength)) {
		throw new TaskCredentialError("task_credential_invalid");
	}
	return trimmed;
}

function normalizeScopeItems(value: unknown, maxItems: number): ReadonlyArray<string> {
	if (!Array.isArray(value)) {
		throw new TaskCredentialError("task_credential_invalid");
	}
	const items: string[] = [];
	const seen = new Set<string>();
	for (const item of value) {
		if (typeof item !== "string") {
			throw new TaskCredentialError("task_credential_invalid");
		}
		const trimmed = item.trim();
		if (trimmed.length === 0) continue;
		if (!isTaskCredentialIdentifier(trimmed) || trimmed.length > TASK_CREDENTIAL_SCOPE_ITEM_MAX_LENGTH) {
			throw new TaskCredentialError("task_credential_invalid");
		}
		if (!seen.has(trimmed)) {
			seen.add(trimmed);
			items.push(trimmed);
		}
	}
	if (items.length > maxItems) {
		throw new TaskCredentialError("task_credential_invalid");
	}
	items.sort();
	return items;
}

function scopeCanonicalString(scope: TaskCredentialScope): string {
	return [
		scope.credentialName,
		scope.purpose,
		scope.resource ?? "",
		scope.operations.join(","),
		scope.targetKinds.join(","),
	].join("\u0000");
}

/**
 * Canonical SHA-256 digest of a normalized scope list, prefixed
 * `sha256:`. The digest is computed over the normalized structure, never
 * over material, and is invariant under item order, duplicates, and
 * surrounding whitespace.
 */
export function calculateScopeDigest(scopes: ReadonlyArray<TaskCredentialScope>): string {
	const normalized = normalizeTaskCredentialScopes(scopes);
	const canonical = normalized.map(scopeCanonicalString).join("\u0001");
	return `${TASK_CREDENTIAL_SCOPE_DIGEST_PREFIX}${createHash("sha256").update(canonical).digest("hex")}`;
}

/**
 * Bound and validate a requested TTL. The effective ceiling is the minimum
 * of `bounds.maxTtlMs` and the remaining time to `bounds.deadlineAtMs`; the
 * effective floor is the maximum of `bounds.minTtlMs` and the renewal
 * window. Requests outside the resulting range throw
 * `task_credential_ttl_invalid`; TTL is never silently clamped.
 */
export function calculateBoundedTtl(
	requestedTtlMs: number,
	bounds: TaskCredentialTtlBounds,
	nowMs: number,
): number {
	if (!isPositiveSafeInteger(requestedTtlMs) || !isTaskCredentialEpochMs(nowMs)) {
		throw new TaskCredentialError("task_credential_ttl_invalid");
	}
	if (!isRecord(bounds) || !hasOnlyKeys(bounds, TTL_BOUNDS_KEYS)) {
		throw new TaskCredentialError("task_credential_ttl_invalid");
	}
	if (
		!isPositiveSafeInteger(bounds.minTtlMs) ||
		!isPositiveSafeInteger(bounds.maxTtlMs) ||
		bounds.minTtlMs > bounds.maxTtlMs
	) {
		throw new TaskCredentialError("task_credential_ttl_invalid");
	}
	if (bounds.deadlineAtMs !== undefined && !isTaskCredentialEpochMs(bounds.deadlineAtMs)) {
		throw new TaskCredentialError("task_credential_ttl_invalid");
	}
	const floor = Math.max(bounds.minTtlMs, TASK_CREDENTIAL_RENEWAL_WINDOW_MS);
	// The effective ceiling is the earliest of the core cap, the caller's
	// profile/policy ceiling, and the remaining time to the earliest
	// deadline; an untrusted bounds.maxTtlMs can never widen the window
	// beyond TASK_CREDENTIAL_MAX_TTL_MS.
	let ceiling = Math.min(bounds.maxTtlMs, TASK_CREDENTIAL_MAX_TTL_MS);
	if (bounds.deadlineAtMs !== undefined) {
		ceiling = Math.min(ceiling, bounds.deadlineAtMs - nowMs);
	}
	if (ceiling < floor) {
		throw new TaskCredentialError("task_credential_ttl_invalid");
	}
	if (requestedTtlMs < floor || requestedTtlMs > ceiling) {
		throw new TaskCredentialError("task_credential_ttl_invalid");
	}
	return requestedTtlMs;
}

/** Defensive public copy of a scope item. */
export function serializeTaskCredentialScope(value: TaskCredentialScope): TaskCredentialScope {
	const scope: TaskCredentialScope = {
		credentialName: value.credentialName,
		purpose: value.purpose,
		operations: [...value.operations],
		targetKinds: [...value.targetKinds],
	};
	if (value.resource !== undefined) (scope as { resource?: string }).resource = value.resource;
	return scope;
}

/** Structural guard for a grant snapshot, including time ordering and stage pairing. */
export function isTaskCredentialGrant(value: unknown): value is TaskCredentialGrant {
	if (!isRecord(value) || !hasOnlyKeys(value, GRANT_KEYS)) return false;
	if (value.schemaVersion !== TASK_CREDENTIAL_SCHEMA_VERSION) return false;
	if (
		!isBoundedIdentifier(value.grantId, TASK_CREDENTIAL_IDENTIFIER_MAX_LENGTH) ||
		!isBoundedIdentifier(value.leaseId, TASK_CREDENTIAL_IDENTIFIER_MAX_LENGTH) ||
		!isBoundedIdentifier(value.bindingId, TASK_CREDENTIAL_IDENTIFIER_MAX_LENGTH) ||
		!isBoundedIdentifier(value.sessionId, TASK_CREDENTIAL_IDENTIFIER_MAX_LENGTH) ||
		!isBoundedIdentifier(value.taskId, TASK_CREDENTIAL_IDENTIFIER_MAX_LENGTH) ||
		!isBoundedIdentifier(value.nodeId, TASK_CREDENTIAL_IDENTIFIER_MAX_LENGTH) ||
		!isBoundedIdentifier(value.runId, TASK_CREDENTIAL_IDENTIFIER_MAX_LENGTH)
	) {
		return false;
	}
	if (
		(value.stageId !== undefined && !isBoundedIdentifier(value.stageId, TASK_CREDENTIAL_IDENTIFIER_MAX_LENGTH)) ||
		(value.targetId !== undefined && !isBoundedIdentifier(value.targetId, TASK_CREDENTIAL_IDENTIFIER_MAX_LENGTH))
	) {
		return false;
	}
	if (
		!isPositiveSafeInteger(value.graphRevision) ||
		(value.stageRevision !== undefined && !isPositiveSafeInteger(value.stageRevision))
	) {
		return false;
	}
	if ((value.stageId === undefined) !== (value.stageRevision === undefined)) return false;
	if (typeof value.scopeDigest !== "string" || !SCOPE_DIGEST_PATTERN.test(value.scopeDigest)) return false;
	if (!isNonNegativeSafeInteger(value.scopeCount) || value.scopeCount > TASK_CREDENTIAL_MAX_SCOPES) return false;
	if (!TASK_CREDENTIAL_STATUS.includes(value.status as TaskCredentialStatus)) return false;
	if (
		!isTaskCredentialIsoTimestamp(value.issuedAt) ||
		!isTaskCredentialIsoTimestamp(value.expiresAt) ||
		!isTaskCredentialIsoTimestamp(value.renewAfter)
	) {
		return false;
	}
	if (epochMsOf(value.expiresAt) <= epochMsOf(value.issuedAt)) return false;
	if (epochMsOf(value.renewAfter) >= epochMsOf(value.expiresAt)) return false;
	if (epochMsOf(value.renewAfter) < epochMsOf(value.issuedAt)) return false;
	if (!isNonNegativeSafeInteger(value.heartbeatSequence)) return false;
	if (!isNonNegativeSafeInteger(value.revision)) return false;
	if (value.reasonCode !== undefined && !isBoundedReasonCode(value.reasonCode)) return false;
	return true;
}

/** Defensive public copy of a grant snapshot; copies only the allowlist. */
export function serializeTaskCredentialGrant(value: TaskCredentialGrant): TaskCredentialGrant {
	const grant: TaskCredentialGrant = {
		schemaVersion: TASK_CREDENTIAL_SCHEMA_VERSION,
		grantId: value.grantId,
		leaseId: value.leaseId,
		bindingId: value.bindingId,
		sessionId: value.sessionId,
		taskId: value.taskId,
		graphRevision: value.graphRevision,
		nodeId: value.nodeId,
		runId: value.runId,
		scopeDigest: value.scopeDigest,
		scopeCount: value.scopeCount,
		status: value.status,
		issuedAt: value.issuedAt,
		expiresAt: value.expiresAt,
		renewAfter: value.renewAfter,
		heartbeatSequence: value.heartbeatSequence,
		revision: value.revision,
	};
	if (value.stageId !== undefined) (grant as { stageId?: string }).stageId = value.stageId;
	if (value.stageRevision !== undefined) (grant as { stageRevision?: number }).stageRevision = value.stageRevision;
	if (value.targetId !== undefined) (grant as { targetId?: string }).targetId = value.targetId;
	if (value.reasonCode !== undefined) (grant as { reasonCode?: string }).reasonCode = value.reasonCode;
	return grant;
}

/** Parse only the exact schema-versioned grant payload. */
export function parseTaskCredentialGrant(value: unknown): TaskCredentialGrant | undefined {
	return isTaskCredentialGrant(value) ? serializeTaskCredentialGrant(value) : undefined;
}

/** Structural guard for a delivery receipt snapshot. */
export function isTaskCredentialDeliveryReceipt(value: unknown): value is TaskCredentialDeliveryReceipt {
	if (!isRecord(value) || !hasOnlyKeys(value, RECEIPT_KEYS)) return false;
	if (value.schemaVersion !== TASK_CREDENTIAL_SCHEMA_VERSION) return false;
	if (
		!isBoundedIdentifier(value.leaseId, TASK_CREDENTIAL_IDENTIFIER_MAX_LENGTH) ||
		!isBoundedIdentifier(value.grantId, TASK_CREDENTIAL_IDENTIFIER_MAX_LENGTH) ||
		!isBoundedIdentifier(value.bindingId, TASK_CREDENTIAL_IDENTIFIER_MAX_LENGTH)
	) {
		return false;
	}
	if (value.targetId !== undefined && !isBoundedIdentifier(value.targetId, TASK_CREDENTIAL_IDENTIFIER_MAX_LENGTH)) {
		return false;
	}
	if (!TASK_CREDENTIAL_DELIVERY_STATUS.includes(value.status as TaskCredentialDeliveryStatus)) return false;
	if (!isTaskCredentialIsoTimestamp(value.recordedAt)) return false;
	return value.reasonCode === undefined || isBoundedReasonCode(value.reasonCode);
}

/** Defensive public copy of a delivery receipt. */
export function serializeTaskCredentialDeliveryReceipt(
	value: TaskCredentialDeliveryReceipt,
): TaskCredentialDeliveryReceipt {
	const receipt: TaskCredentialDeliveryReceipt = {
		schemaVersion: TASK_CREDENTIAL_SCHEMA_VERSION,
		leaseId: value.leaseId,
		grantId: value.grantId,
		bindingId: value.bindingId,
		status: value.status,
		recordedAt: value.recordedAt,
	};
	if (value.targetId !== undefined) (receipt as { targetId?: string }).targetId = value.targetId;
	if (value.reasonCode !== undefined) (receipt as { reasonCode?: string }).reasonCode = value.reasonCode;
	return receipt;
}

/** Parse only the exact schema-versioned delivery receipt payload. */
export function parseTaskCredentialDeliveryReceipt(
	value: unknown,
): TaskCredentialDeliveryReceipt | undefined {
	return isTaskCredentialDeliveryReceipt(value) ? serializeTaskCredentialDeliveryReceipt(value) : undefined;
}

/**
 * Legal transition matrix. `from === undefined` means "no grant yet", where
 * only `issued` is legal. `active` is the only live status; `expired` may
 * still move to `revoked` / `revocation_unknown` (post-expiry revoke), and
 * `revocation_unknown` converges to `revoked` only through provider
 * confirmed reconciliation. `settled` is reachable only from `revoked` (the
 * service settles only after delivery is recorded and revoke is confirmed).
 * `renewing` and `settled` are dead ends. No terminal status may resurrect
 * to `active`.
 */
export function isLegalTaskCredentialTransition(
	from: TaskCredentialStatus | undefined,
	action: TaskCredentialAction,
): boolean {
	switch (from) {
		case undefined:
			return action === "issued";
		case "active":
			return action !== "issued" && action !== "settled";
		case "expired":
			return action === "revoked" || action === "revocation_unknown";
		case "revoked":
			return action === "settled";
		case "revocation_unknown":
			return action === "revoked";
		case "renewing":
		case "settled":
			return false;
	}
}

/**
 * Map an illegal or clock-inconsistent transition onto its stable error
 * code: live-extending actions on an expired lease report
 * `task_lease_expired`; every other illegal transition reports
 * `task_credential_conflict`. The clock is consulted for live extensions
 * (`renewed`, delivery) and for the `expired` action itself.
 */
function transitionDenied(
	from: TaskCredentialStatus,
	action: TaskCredentialAction,
	nowMs: number,
	expiresAtMs: number,
): TaskCredentialErrorCode | undefined {
	if (isLegalTaskCredentialTransition(from, action)) {
		if (action === "renewed" || action === "delivery_succeeded" || action === "delivery_failed") {
			return nowMs >= expiresAtMs ? "task_lease_expired" : undefined;
		}
		if (action === "expired") {
			return nowMs < expiresAtMs ? "task_credential_conflict" : undefined;
		}
		return undefined;
	}
	if (action === "renewed" || action === "delivery_succeeded" || action === "delivery_failed") {
		return from === "expired" ? "task_lease_expired" : "task_credential_conflict";
	}
	return "task_credential_conflict";
}

/** Predicate: may this lease heartbeat with the given sequence at this time? */
export function canHeartbeatTaskLease(
	grant: TaskCredentialGrant,
	heartbeatSequence: number,
	nowMs: number,
): TaskCredentialErrorCode | undefined {
	if (!isTaskCredentialGrant(grant) || !isTaskCredentialEpochMs(nowMs) || !Number.isSafeInteger(heartbeatSequence)) {
		return "task_credential_invalid";
	}
	if (grant.status === "expired" || nowMs >= epochMsOf(grant.expiresAt)) {
		return "task_lease_expired";
	}
	if (grant.status !== "active") {
		return "task_credential_conflict";
	}
	if (heartbeatSequence !== grant.heartbeatSequence + 1) {
		return "task_lease_heartbeat_invalid";
	}
	return undefined;
}

/** Predicate: may this lease renew (extend) at this time? */
export function canRenewTaskLease(grant: TaskCredentialGrant, nowMs: number): TaskCredentialErrorCode | undefined {
	if (!isTaskCredentialGrant(grant) || !isTaskCredentialEpochMs(nowMs)) {
		return "task_credential_invalid";
	}
	if (grant.status === "expired" || nowMs >= epochMsOf(grant.expiresAt)) {
		return "task_lease_expired";
	}
	return grant.status === "active" ? undefined : "task_credential_conflict";
}

/** Predicate: may this lease be revoked (fresh revoke request)? */
export function canRevokeTaskLease(grant: TaskCredentialGrant): TaskCredentialErrorCode | undefined {
	if (!isTaskCredentialGrant(grant)) {
		return "task_credential_invalid";
	}
	if (grant.status === "active" || grant.status === "expired") {
		return undefined;
	}
	return "task_credential_conflict";
}

/** Predicate: may this lease be settled? Settle is legal only from `revoked` (delivery recorded and revoke confirmed). */
export function canSettleTaskLease(grant: TaskCredentialGrant): TaskCredentialErrorCode | undefined {
	if (!isTaskCredentialGrant(grant)) {
		return "task_credential_invalid";
	}
	return grant.status === "revoked" ? undefined : "task_credential_conflict";
}

/**
 * Predicate: may this lease be reconciled to `revoked`? This is the
 * store/lifecycle gate before asking the provider to confirm a revoke, so
 * it is legal only from `revocation_unknown` and never performs I/O or
 * accepts raw provider data (confirmation arrives later as the explicit
 * `providerConfirmedRevoke: true` transition option).
 */
export function canReconcileTaskLease(grant: TaskCredentialGrant): TaskCredentialErrorCode | undefined {
	if (!isTaskCredentialGrant(grant)) {
		return "task_credential_invalid";
	}
	return grant.status === "revocation_unknown" ? undefined : "task_credential_conflict";
}

/** Issue a new active grant at revision 0 and heartbeat sequence 0. */
export function issueTaskCredentialGrant(
	input: TaskCredentialIssueRequest,
	nowMs: number,
): TaskCredentialGrant {
	const raw: unknown = input;
	if (!isRecord(raw) || !hasOnlyKeys(raw, ISSUE_KEYS)) {
		throw new TaskCredentialError("task_credential_invalid");
	}
	if (
		!isBoundedIdentifier(input.grantId, TASK_CREDENTIAL_IDENTIFIER_MAX_LENGTH) ||
		!isBoundedIdentifier(input.leaseId, TASK_CREDENTIAL_IDENTIFIER_MAX_LENGTH)
	) {
		throw new TaskCredentialError("task_credential_invalid");
	}
	validateTaskExecutionBinding(input.binding);
	if (!isTaskCredentialEpochMs(nowMs)) {
		throw new TaskCredentialError("task_credential_invalid");
	}
	const scopes = normalizeTaskCredentialScopes(input.scopes);
	const ttlMs = calculateBoundedTtl(input.requestedTtlMs, input.ttlBounds, nowMs);
	const expiresAtMs = nowMs + ttlMs;
	const grant: TaskCredentialGrant = {
		schemaVersion: TASK_CREDENTIAL_SCHEMA_VERSION,
		grantId: input.grantId,
		leaseId: input.leaseId,
		bindingId: input.binding.bindingId,
		sessionId: input.binding.sessionId,
		taskId: input.binding.taskId,
		graphRevision: input.binding.graphRevision,
		nodeId: input.binding.nodeId,
		runId: input.binding.runId,
		scopeDigest: calculateScopeDigest(scopes),
		scopeCount: scopes.length,
		status: "active",
		issuedAt: isoFromEpochMs(nowMs),
		expiresAt: isoFromEpochMs(expiresAtMs),
		renewAfter: isoFromEpochMs(expiresAtMs - TASK_CREDENTIAL_RENEWAL_WINDOW_MS),
		heartbeatSequence: 0,
		revision: 0,
	};
	if (input.binding.stageId !== undefined) (grant as { stageId?: string }).stageId = input.binding.stageId;
	if (input.binding.stageRevision !== undefined) {
		(grant as { stageRevision?: number }).stageRevision = input.binding.stageRevision;
	}
	if (input.binding.targetId !== undefined) (grant as { targetId?: string }).targetId = input.binding.targetId;
	return serializeTaskCredentialGrant(grant);
}

function validateTransitionOptions(
	action: Exclude<TaskCredentialAction, "issued">,
	options: TaskCredentialTransitionOptions,
): number {
	// Validate the container before touching any property: null, arrays,
	// primitives, and unknown keys must fail as task_credential_invalid,
	// never as a TypeError.
	if (!isRecord(options) || !hasOnlyKeys(options, OPTION_KEYS)) {
		throw new TaskCredentialError("task_credential_invalid");
	}
	const nowMs = options.nowMs;
	if (!isTaskCredentialEpochMs(nowMs)) {
		throw new TaskCredentialError("task_credential_invalid");
	}
	switch (action) {
		case "renewed": {
			if (
				options.delivery !== undefined ||
				options.reasonCode !== undefined ||
				!isNonNegativeSafeInteger(options.heartbeatSequence) ||
				options.ttlMs === undefined ||
				options.ttlBounds === undefined
			) {
				throw new TaskCredentialError("task_credential_invalid");
			}
			// Throws task_credential_ttl_invalid for out-of-bounds requests.
			calculateBoundedTtl(options.ttlMs, options.ttlBounds, nowMs);
			return nowMs;
		}
		case "delivery_succeeded":
		case "delivery_failed": {
			if (
				options.heartbeatSequence !== undefined ||
				options.ttlMs !== undefined ||
				options.ttlBounds !== undefined ||
				options.reasonCode !== undefined
			) {
				throw new TaskCredentialError("task_credential_invalid");
			}
			if (options.delivery !== undefined) {
				if (
					!isTaskCredentialDeliveryReceipt(options.delivery) ||
					options.delivery.status !== (action === "delivery_succeeded" ? "succeeded" : "failed")
				) {
					throw new TaskCredentialError("task_credential_invalid");
				}
			}
			return nowMs;
		}
		case "revoked": {
			if (
				options.heartbeatSequence !== undefined ||
				options.ttlMs !== undefined ||
				options.ttlBounds !== undefined ||
				options.delivery !== undefined
			) {
				throw new TaskCredentialError("task_credential_invalid");
			}
			// Provider-confirmed reconciliation carries no raw or provider
			// data: the only accepted value is the literal `true`.
			if (options.providerConfirmedRevoke !== undefined && options.providerConfirmedRevoke !== true) {
				throw new TaskCredentialError("task_credential_invalid");
			}
			if (options.reasonCode !== undefined && !isBoundedReasonCode(options.reasonCode)) {
				throw new TaskCredentialError("task_credential_invalid");
			}
			return nowMs;
		}
		case "revocation_unknown":
		case "settled": {
			if (
				options.heartbeatSequence !== undefined ||
				options.ttlMs !== undefined ||
				options.ttlBounds !== undefined ||
				options.delivery !== undefined ||
				options.providerConfirmedRevoke !== undefined
			) {
				throw new TaskCredentialError("task_credential_invalid");
			}
			if (options.reasonCode !== undefined && !isBoundedReasonCode(options.reasonCode)) {
				throw new TaskCredentialError("task_credential_invalid");
			}
			return nowMs;
		}
		case "expired": {
			if (
				options.heartbeatSequence !== undefined ||
				options.ttlMs !== undefined ||
				options.ttlBounds !== undefined ||
				options.reasonCode !== undefined ||
				options.delivery !== undefined
			) {
				throw new TaskCredentialError("task_credential_invalid");
			}
			return nowMs;
		}
	}
}

/**
 * Apply one legal transition to a grant snapshot and return the next
 * snapshot. `issued` is not accepted here; use `issueTaskCredentialGrant`.
 * Every accepted transition increments `revision` by exactly one; only
 * `renewed` increments `heartbeatSequence` and rewrites `expiresAt` /
 * `renewAfter` (bounded by the requested TTL and the TTL bounds), never
 * touching binding, scope, or target. Terminal statuses cannot be
 * resurrected, `revocation_unknown` converges only via `revoked` with the
 * `providerConfirmedRevoke: true` reconciliation guard, and `settled` is
 * reachable only from `revoked` (delivery recorded and revoke confirmed).
 */
export function transitionTaskCredentialStatus(
	grant: TaskCredentialGrant,
	action: TaskCredentialAction,
	options: TaskCredentialTransitionOptions,
): TaskCredentialGrant {
	if (!isTaskCredentialGrant(grant)) {
		throw new TaskCredentialError("task_credential_invalid");
	}
	if (action === "issued") {
		throw new TaskCredentialError("task_credential_invalid");
	}
	// Options are validated before any property access: null, arrays, and
	// primitives fail as task_credential_invalid, never as a TypeError.
	const nowMs = validateTransitionOptions(action, options);
	const denied = transitionDenied(grant.status, action, nowMs, epochMsOf(grant.expiresAt));
	if (denied !== undefined) {
		throw new TaskCredentialError(denied);
	}
	if (action === "renewed" && options.heartbeatSequence !== grant.heartbeatSequence + 1) {
		throw new TaskCredentialError("task_lease_heartbeat_invalid");
	}
	// `revocation_unknown` converges to `revoked` only through provider
	// confirmed reconciliation: the caller must pass the explicit
	// confirmation flag. The flag itself is never raw or provider data.
	if (action === "revoked" && grant.status === "revocation_unknown" && options.providerConfirmedRevoke !== true) {
		throw new TaskCredentialError("task_credential_conflict");
	}
	const next = serializeTaskCredentialGrant(grant);
	(next as { revision: number }).revision = grant.revision + 1;
	switch (action) {
		case "renewed": {
			const ttlMs = calculateBoundedTtl(options.ttlMs as number, options.ttlBounds as TaskCredentialTtlBounds, nowMs);
			const expiresAtMs = nowMs + ttlMs;
			(next as { heartbeatSequence: number }).heartbeatSequence = grant.heartbeatSequence + 1;
			(next as { expiresAt: string }).expiresAt = isoFromEpochMs(expiresAtMs);
			(next as { renewAfter: string }).renewAfter = isoFromEpochMs(expiresAtMs - TASK_CREDENTIAL_RENEWAL_WINDOW_MS);
			return next;
		}
		case "delivery_succeeded":
		case "delivery_failed":
			return next;
		case "revoked": {
			(next as { status: TaskCredentialStatus }).status = "revoked";
			if (options.reasonCode !== undefined) (next as { reasonCode?: string }).reasonCode = options.reasonCode;
			return next;
		}
		case "expired": {
			(next as { status: TaskCredentialStatus }).status = "expired";
			return next;
		}
		case "settled": {
			(next as { status: TaskCredentialStatus }).status = "settled";
			if (options.reasonCode !== undefined) (next as { reasonCode?: string }).reasonCode = options.reasonCode;
			return next;
		}
		case "revocation_unknown": {
			(next as { status: TaskCredentialStatus }).status = "revocation_unknown";
			if (options.reasonCode !== undefined) (next as { reasonCode?: string }).reasonCode = options.reasonCode;
			return next;
		}
	}
}
