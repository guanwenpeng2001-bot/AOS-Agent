/**
 * Task Credential / Lease v1 provider (T2, provider contract).
 *
 * Provider-neutral issuer / target capabilities with material-free request
 * contracts and safe receipts. A `TaskCredentialProvider` bundles two
 * capabilities:
 *
 * - `TaskCredentialIssuer` issues, renews, and revokes credentials at the
 *   credential source. Requests carry only opaque identifiers, the frozen
 *   execution binding, structured scopes, and a TTL; the issuer returns a
 *   `TaskCredentialProviderReceipt` that never carries material.
 * - `TaskCredentialTarget` exposes the four safe target capabilities:
 *   `getCapabilities` (the target identity and kind, the binding
 *   correlation, and the five safe capability flags: short-lived
 *   credential delivery, renew, revoke, per-binding isolation, and
 *   delivery receipts), `project` (delivers credential material into a
 *   target environment), `renew`, and `revoke`. The provider-to-target
 *   projection request (the only contract where material flows) is
 *   module-private; every target response is material-free (the T1 core
 *   delivery receipt or a provider receipt).
 *
 * Every request and receipt type in this module validates through a strict
 * key allowlist, so a material-bearing key (`token`, `secret`, `value`,
 * `material`, ...) can never ride along into JSON. The store never holds,
 * receives, or persists material: it talks to `TaskCredentialProvider` with
 * the material-free request contracts and consumes only receipts.
 *
 * The module ships two deterministic implementations for tests and for
 * fail-closed operation:
 *
 * - `createTaskCredentialTestProvider` is an in-memory issuer that stores
 *   sentinel material internally, keyed by credential name. Material enters
 *   only through the module-private construction options and is handed to
 *   the target exclusively inside the module-private
 *   `TaskCredentialTargetProjectRequest`; it never appears in an exported
 *   contract, a receipt, a record, an error, or a JSON serialization.
 * - `createTaskCredentialNullTarget` is the fail-closed store-facing target:
 *   `getCapabilities` declares no capability, and every operation returns a
 *   `failed` receipt with reason `task_credential_target_unavailable`
 *   without reading anything it is handed, so an unconfigured target can
 *   never silently absorb a credential. The material-receiving channel
 *   fails closed through a module-private target with the same guarantee.
 *
 * No enum, namespace, parameter property, or dynamic import is used.
 */

import {
	TASK_CREDENTIAL_IDENTIFIER_MAX_LENGTH,
	TASK_CREDENTIAL_MAX_SCOPES,
	TASK_CREDENTIAL_REASON_CODE_MAX_LENGTH,
	TASK_CREDENTIAL_SCHEMA_VERSION,
	TaskCredentialError,
	isTaskCredentialIdentifier,
	isTaskCredentialIsoTimestamp,
	isTaskCredentialScope,
	isTaskExecutionBinding,
	parseTaskCredentialDeliveryReceipt,
	serializeTaskCredentialDeliveryReceipt,
	serializeTaskCredentialScope,
	type TaskCredentialDeliveryReceipt,
	type TaskCredentialScope,
	type TaskExecutionBinding,
} from "./task-credential-lease.ts";

/** Material payload size cap: one credential material value. Module-private. */
const TASK_CREDENTIAL_PROVIDER_MATERIAL_MAX_LENGTH = 8192;

export const TASK_CREDENTIAL_PROVIDER_RECEIPT_STATUS = [
	"issued",
	"renewed",
	"revoked",
	"revocation_unknown",
	"settled",
	"failed",
] as const;
export type TaskCredentialProviderReceiptStatus = (typeof TASK_CREDENTIAL_PROVIDER_RECEIPT_STATUS)[number];

/**
 * Safe provider outcome. The receipt carries only opaque identifiers, a
 * status, the recorded timestamp, and an optional bounded reason code; it
 * never carries credential material. The store persists and replays only
 * these fields.
 */
export interface TaskCredentialProviderReceipt {
	readonly schemaVersion: typeof TASK_CREDENTIAL_SCHEMA_VERSION;
	readonly leaseId: string;
	readonly grantId: string;
	readonly bindingId: string;
	readonly status: TaskCredentialProviderReceiptStatus;
	readonly recordedAt: string;
	readonly reasonCode?: string;
}

/** Material-free issue request: identifiers, frozen binding, scopes, TTL. */
export interface TaskCredentialProviderIssueRequest {
	readonly schemaVersion: typeof TASK_CREDENTIAL_SCHEMA_VERSION;
	readonly leaseId: string;
	readonly grantId: string;
	readonly binding: TaskExecutionBinding;
	readonly scopes: ReadonlyArray<TaskCredentialScope>;
	readonly requestedTtlMs: number;
	readonly requestedAt: string;
}

/** Material-free renew request: identifiers and the requested extension TTL. */
export interface TaskCredentialProviderRenewRequest {
	readonly schemaVersion: typeof TASK_CREDENTIAL_SCHEMA_VERSION;
	readonly leaseId: string;
	readonly grantId: string;
	readonly bindingId: string;
	readonly requestedTtlMs: number;
	readonly requestedAt: string;
}

/** Material-free revoke request. */
export interface TaskCredentialProviderRevokeRequest {
	readonly schemaVersion: typeof TASK_CREDENTIAL_SCHEMA_VERSION;
	readonly leaseId: string;
	readonly grantId: string;
	readonly bindingId: string;
	readonly reasonCode?: string;
	readonly requestedAt: string;
}

/**
 * Material-free store-to-provider projection request. The provider resolves
 * the material it holds for the grant and forwards it to its target inside
 * `TaskCredentialTargetProjectRequest`; the store never sees material.
 */
export interface TaskCredentialProviderProjectRequest {
	readonly schemaVersion: typeof TASK_CREDENTIAL_SCHEMA_VERSION;
	readonly leaseId: string;
	readonly grantId: string;
	readonly bindingId: string;
	readonly targetId?: string;
	readonly requestedAt: string;
}

/**
 * Material-free target capabilities request: which target's capabilities
 * for which binding are being queried. Capabilities are per-binding, so
 * the request never needs a lease or grant id. Target identity, target
 * kind, and binding correlation are all explicit and bounded so the
 * caller can match the returned snapshot to the request.
 */
export interface TaskCredentialTargetCapabilitiesRequest {
	readonly schemaVersion: typeof TASK_CREDENTIAL_SCHEMA_VERSION;
	readonly targetId: string;
	readonly targetKind: string;
	readonly bindingId: string;
	readonly requestedAt: string;
}

/**
 * Bounded capability snapshot of one target for one binding: the target
 * identity and kind plus the binding the caller must address, and the five
 * explicit capability flags (short-lived credential delivery, renew,
 * revoke, per-binding isolation, and delivery receipts). Never carries
 * material.
 */
export interface TaskCredentialTargetCapabilities {
	readonly schemaVersion: typeof TASK_CREDENTIAL_SCHEMA_VERSION;
	readonly targetId: string;
	readonly targetKind: string;
	readonly bindingId: string;
	/** True when the target accepts short-lived credential projection (delivery). */
	readonly canReceiveShortLivedCredential: boolean;
	/** True when the target accepts renew requests. */
	readonly canRenewCredential: boolean;
	/** True when the target accepts revoke requests. */
	readonly canRevokeCredential: boolean;
	/** True when the target isolates projected material per binding. */
	readonly supportsPerBindingIsolation: boolean;
	/** True when the target returns a delivery receipt for projections. */
	readonly supportsDeliveryReceipt: boolean;
}

/** Material-free target-side renew request: identifiers and the extension TTL. */
export interface TaskCredentialTargetRenewRequest {
	readonly schemaVersion: typeof TASK_CREDENTIAL_SCHEMA_VERSION;
	readonly leaseId: string;
	readonly grantId: string;
	readonly bindingId: string;
	readonly targetId?: string;
	readonly requestedTtlMs: number;
	readonly requestedAt: string;
}

/** Material-free target-side revoke request. */
export interface TaskCredentialTargetRevokeRequest {
	readonly schemaVersion: typeof TASK_CREDENTIAL_SCHEMA_VERSION;
	readonly leaseId: string;
	readonly grantId: string;
	readonly bindingId: string;
	readonly targetId?: string;
	readonly reasonCode?: string;
	readonly requestedAt: string;
}

/**
 * Module-private provider-to-target projection request: the only contract
 * where credential material flows. `material` maps credential name to
 * material; the response is a material-free delivery receipt. The type is
 * never exported, so raw material cannot enter the provider-neutral API.
 */
interface TaskCredentialTargetProjectRequest {
	readonly schemaVersion: typeof TASK_CREDENTIAL_SCHEMA_VERSION;
	readonly leaseId: string;
	readonly grantId: string;
	readonly bindingId: string;
	readonly targetId?: string;
	readonly scopes: ReadonlyArray<TaskCredentialScope>;
	readonly material: Readonly<Record<string, string>>;
	readonly projectedAt: string;
}

/** Issuer capability: issue, renew, and revoke; requests and results are material-free. */
export interface TaskCredentialIssuer {
	issue(request: TaskCredentialProviderIssueRequest): TaskCredentialProviderReceipt;
	renew(request: TaskCredentialProviderRenewRequest): TaskCredentialProviderReceipt;
	revoke(request: TaskCredentialProviderRevokeRequest): TaskCredentialProviderReceipt;
}

/**
 * Target capability the provider exposes to the store: material-free
 * capability discovery plus the safe lifecycle operations. The provider
 * resolves material internally for `project`; the other three operations
 * never touch material.
 */
export interface TaskCredentialTarget {
	getCapabilities(request: TaskCredentialTargetCapabilitiesRequest): TaskCredentialTargetCapabilities;
	project(request: TaskCredentialProviderProjectRequest): TaskCredentialDeliveryReceipt;
	renew(request: TaskCredentialTargetRenewRequest): TaskCredentialProviderReceipt;
	revoke(request: TaskCredentialTargetRevokeRequest): TaskCredentialProviderReceipt;
}

/**
 * Module-private material-receiving target the provider forwards
 * projections to; the only capability that is ever handed credential
 * material. It implements the same four-operation contract, with
 * `project` carrying the material-bearing request. Every response is
 * material-free.
 */
interface TaskCredentialMaterialTarget {
	getCapabilities(request: TaskCredentialTargetCapabilitiesRequest): TaskCredentialTargetCapabilities;
	project(request: TaskCredentialTargetProjectRequest): TaskCredentialDeliveryReceipt;
	renew(request: TaskCredentialTargetRenewRequest): TaskCredentialProviderReceipt;
	revoke(request: TaskCredentialTargetRevokeRequest): TaskCredentialProviderReceipt;
}

/** Provider-neutral facade the store talks to. */
export interface TaskCredentialProvider {
	readonly issuer: TaskCredentialIssuer;
	readonly target: TaskCredentialTarget;
}

/**
 * Configured safe availability facts of one Task Credential provider. The
 * provider object's existence is never treated as an availability proof: the
 * host explicitly configures whether the issuer is reachable and whether the
 * target declares delivery, and the T3 preflight fails closed when the fact
 * is absent or false. Never derived from a provider call.
 */
export interface TaskCredentialProviderAvailability {
	/** True when the configured issuer is reachable for issue. */
	readonly available: boolean;
	/** True when the configured target declares delivery (project/renew/revoke). */
	readonly declaresDelivery: boolean;
}

const ISSUE_KEYS = new Set(["schemaVersion", "leaseId", "grantId", "binding", "scopes", "requestedTtlMs", "requestedAt"]);
const RENEW_KEYS = new Set(["schemaVersion", "leaseId", "grantId", "bindingId", "requestedTtlMs", "requestedAt"]);
const REVOKE_KEYS = new Set(["schemaVersion", "leaseId", "grantId", "bindingId", "reasonCode", "requestedAt"]);
const PROJECT_KEYS = new Set(["schemaVersion", "leaseId", "grantId", "bindingId", "targetId", "requestedAt"]);
const CAPABILITIES_REQUEST_KEYS = new Set(["schemaVersion", "targetId", "targetKind", "bindingId", "requestedAt"]);
const CAPABILITIES_KEYS = new Set([
	"schemaVersion",
	"targetId",
	"targetKind",
	"bindingId",
	"canReceiveShortLivedCredential",
	"canRenewCredential",
	"canRevokeCredential",
	"supportsPerBindingIsolation",
	"supportsDeliveryReceipt",
]);
const TARGET_RENEW_KEYS = new Set([
	"schemaVersion",
	"leaseId",
	"grantId",
	"bindingId",
	"targetId",
	"requestedTtlMs",
	"requestedAt",
]);
const TARGET_REVOKE_KEYS = new Set([
	"schemaVersion",
	"leaseId",
	"grantId",
	"bindingId",
	"targetId",
	"reasonCode",
	"requestedAt",
]);
const TARGET_PROJECT_KEYS = new Set([
	"schemaVersion",
	"leaseId",
	"grantId",
	"bindingId",
	"targetId",
	"scopes",
	"material",
	"projectedAt",
]);
const RECEIPT_KEYS = new Set([
	"schemaVersion",
	"leaseId",
	"grantId",
	"bindingId",
	"status",
	"recordedAt",
	"reasonCode",
]);

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

function isPositiveSafeInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/** Structural guard for a provider receipt; unknown or material keys are rejected. */
export function isTaskCredentialProviderReceipt(value: unknown): value is TaskCredentialProviderReceipt {
	if (!isRecord(value) || !hasOnlyKeys(value, RECEIPT_KEYS)) return false;
	if (value.schemaVersion !== TASK_CREDENTIAL_SCHEMA_VERSION) return false;
	if (
		!isBoundedIdentifier(value.leaseId, TASK_CREDENTIAL_IDENTIFIER_MAX_LENGTH) ||
		!isBoundedIdentifier(value.grantId, TASK_CREDENTIAL_IDENTIFIER_MAX_LENGTH) ||
		!isBoundedIdentifier(value.bindingId, TASK_CREDENTIAL_IDENTIFIER_MAX_LENGTH)
	) {
		return false;
	}
	if (!TASK_CREDENTIAL_PROVIDER_RECEIPT_STATUS.includes(value.status as TaskCredentialProviderReceiptStatus)) {
		return false;
	}
	if (!isTaskCredentialIsoTimestamp(value.recordedAt)) return false;
	return value.reasonCode === undefined || isBoundedReasonCode(value.reasonCode);
}

/** Defensive public copy of a provider receipt; copies only the allowlist. */
export function serializeTaskCredentialProviderReceipt(value: TaskCredentialProviderReceipt): TaskCredentialProviderReceipt {
	const receipt: TaskCredentialProviderReceipt = {
		schemaVersion: TASK_CREDENTIAL_SCHEMA_VERSION,
		leaseId: value.leaseId,
		grantId: value.grantId,
		bindingId: value.bindingId,
		status: value.status,
		recordedAt: value.recordedAt,
	};
	if (value.reasonCode !== undefined) (receipt as { reasonCode?: string }).reasonCode = value.reasonCode;
	return receipt;
}

/** Parse only the exact schema-versioned provider receipt payload. */
export function parseTaskCredentialProviderReceipt(value: unknown): TaskCredentialProviderReceipt | undefined {
	return isTaskCredentialProviderReceipt(value) ? serializeTaskCredentialProviderReceipt(value) : undefined;
}

function isScopeArray(value: unknown): value is ReadonlyArray<TaskCredentialScope> {
	if (!Array.isArray(value) || value.length > TASK_CREDENTIAL_MAX_SCOPES) return false;
	return value.every((item) => isTaskCredentialScope(item));
}

function hasRequestTimestamp(value: Record<string, unknown>, key: string): boolean {
	return isTaskCredentialIsoTimestamp(value[key]);
}

function commonRequestRules(
	value: Record<string, unknown>,
	allowed: ReadonlySet<string>,
): boolean {
	if (!hasOnlyKeys(value, allowed)) return false;
	if (value.schemaVersion !== TASK_CREDENTIAL_SCHEMA_VERSION) return false;
	if (
		!isBoundedIdentifier(value.leaseId, TASK_CREDENTIAL_IDENTIFIER_MAX_LENGTH) ||
		!isBoundedIdentifier(value.grantId, TASK_CREDENTIAL_IDENTIFIER_MAX_LENGTH)
	) {
		return false;
	}
	return true;
}

/** Structural guard for the material-free issue request. */
export function isTaskCredentialProviderIssueRequest(value: unknown): value is TaskCredentialProviderIssueRequest {
	if (!isRecord(value) || !commonRequestRules(value, ISSUE_KEYS)) return false;
	if (!isTaskExecutionBinding(value.binding)) return false;
	if (!isScopeArray(value.scopes)) return false;
	if (!isPositiveSafeInteger(value.requestedTtlMs)) return false;
	return hasRequestTimestamp(value, "requestedAt");
}

/** Structural guard for the material-free renew request. */
export function isTaskCredentialProviderRenewRequest(value: unknown): value is TaskCredentialProviderRenewRequest {
	if (!isRecord(value) || !commonRequestRules(value, RENEW_KEYS)) return false;
	if (!isBoundedIdentifier(value.bindingId, TASK_CREDENTIAL_IDENTIFIER_MAX_LENGTH)) return false;
	if (!isPositiveSafeInteger(value.requestedTtlMs)) return false;
	return hasRequestTimestamp(value, "requestedAt");
}

/** Structural guard for the material-free revoke request. */
export function isTaskCredentialProviderRevokeRequest(value: unknown): value is TaskCredentialProviderRevokeRequest {
	if (!isRecord(value) || !commonRequestRules(value, REVOKE_KEYS)) return false;
	if (!isBoundedIdentifier(value.bindingId, TASK_CREDENTIAL_IDENTIFIER_MAX_LENGTH)) return false;
	if (value.reasonCode !== undefined && !isBoundedReasonCode(value.reasonCode)) return false;
	return hasRequestTimestamp(value, "requestedAt");
}

/** Structural guard for the material-free store-to-provider projection request. */
export function isTaskCredentialProviderProjectRequest(value: unknown): value is TaskCredentialProviderProjectRequest {
	if (!isRecord(value) || !commonRequestRules(value, PROJECT_KEYS)) return false;
	if (!isBoundedIdentifier(value.bindingId, TASK_CREDENTIAL_IDENTIFIER_MAX_LENGTH)) return false;
	if (value.targetId !== undefined && !isBoundedIdentifier(value.targetId, TASK_CREDENTIAL_IDENTIFIER_MAX_LENGTH)) {
		return false;
	}
	return hasRequestTimestamp(value, "requestedAt");
}

/** Structural guard for the material-free target capabilities request. */
export function isTaskCredentialTargetCapabilitiesRequest(
	value: unknown,
): value is TaskCredentialTargetCapabilitiesRequest {
	if (!isRecord(value) || !hasOnlyKeys(value, CAPABILITIES_REQUEST_KEYS)) return false;
	if (value.schemaVersion !== TASK_CREDENTIAL_SCHEMA_VERSION) return false;
	if (
		!isBoundedIdentifier(value.targetId, TASK_CREDENTIAL_IDENTIFIER_MAX_LENGTH) ||
		!isBoundedIdentifier(value.targetKind, TASK_CREDENTIAL_IDENTIFIER_MAX_LENGTH) ||
		!isBoundedIdentifier(value.bindingId, TASK_CREDENTIAL_IDENTIFIER_MAX_LENGTH)
	) {
		return false;
	}
	return hasRequestTimestamp(value, "requestedAt");
}

/** Structural guard for a capabilities snapshot; unknown or material keys are rejected. */
export function isTaskCredentialTargetCapabilities(value: unknown): value is TaskCredentialTargetCapabilities {
	if (!isRecord(value) || !hasOnlyKeys(value, CAPABILITIES_KEYS)) return false;
	if (value.schemaVersion !== TASK_CREDENTIAL_SCHEMA_VERSION) return false;
	if (
		!isBoundedIdentifier(value.targetId, TASK_CREDENTIAL_IDENTIFIER_MAX_LENGTH) ||
		!isBoundedIdentifier(value.targetKind, TASK_CREDENTIAL_IDENTIFIER_MAX_LENGTH) ||
		!isBoundedIdentifier(value.bindingId, TASK_CREDENTIAL_IDENTIFIER_MAX_LENGTH)
	) {
		return false;
	}
	return (
		typeof value.canReceiveShortLivedCredential === "boolean" &&
		typeof value.canRenewCredential === "boolean" &&
		typeof value.canRevokeCredential === "boolean" &&
		typeof value.supportsPerBindingIsolation === "boolean" &&
		typeof value.supportsDeliveryReceipt === "boolean"
	);
}

/** Defensive public copy of a capabilities snapshot; copies only the allowlist. */
export function serializeTaskCredentialTargetCapabilities(
	value: TaskCredentialTargetCapabilities,
): TaskCredentialTargetCapabilities {
	return {
		schemaVersion: TASK_CREDENTIAL_SCHEMA_VERSION,
		targetId: value.targetId,
		targetKind: value.targetKind,
		bindingId: value.bindingId,
		canReceiveShortLivedCredential: value.canReceiveShortLivedCredential,
		canRenewCredential: value.canRenewCredential,
		canRevokeCredential: value.canRevokeCredential,
		supportsPerBindingIsolation: value.supportsPerBindingIsolation,
		supportsDeliveryReceipt: value.supportsDeliveryReceipt,
	};
}

/** Parse only the exact schema-versioned capabilities snapshot. */
export function parseTaskCredentialTargetCapabilities(value: unknown): TaskCredentialTargetCapabilities | undefined {
	return isTaskCredentialTargetCapabilities(value) ? serializeTaskCredentialTargetCapabilities(value) : undefined;
}

/** Structural guard for the material-free target-side renew request. */
export function isTaskCredentialTargetRenewRequest(value: unknown): value is TaskCredentialTargetRenewRequest {
	if (!isRecord(value) || !commonRequestRules(value, TARGET_RENEW_KEYS)) return false;
	if (!isBoundedIdentifier(value.bindingId, TASK_CREDENTIAL_IDENTIFIER_MAX_LENGTH)) return false;
	if (value.targetId !== undefined && !isBoundedIdentifier(value.targetId, TASK_CREDENTIAL_IDENTIFIER_MAX_LENGTH)) {
		return false;
	}
	if (!isPositiveSafeInteger(value.requestedTtlMs)) return false;
	return hasRequestTimestamp(value, "requestedAt");
}

/** Structural guard for the material-free target-side revoke request. */
export function isTaskCredentialTargetRevokeRequest(value: unknown): value is TaskCredentialTargetRevokeRequest {
	if (!isRecord(value) || !commonRequestRules(value, TARGET_REVOKE_KEYS)) return false;
	if (!isBoundedIdentifier(value.bindingId, TASK_CREDENTIAL_IDENTIFIER_MAX_LENGTH)) return false;
	if (value.targetId !== undefined && !isBoundedIdentifier(value.targetId, TASK_CREDENTIAL_IDENTIFIER_MAX_LENGTH)) {
		return false;
	}
	if (value.reasonCode !== undefined && !isBoundedReasonCode(value.reasonCode)) return false;
	return hasRequestTimestamp(value, "requestedAt");
}

function isMaterialMap(value: unknown): value is Readonly<Record<string, string>> {
	if (!isRecord(value)) return false;
	const names = Object.keys(value);
	if (names.length === 0 || names.length > TASK_CREDENTIAL_MAX_SCOPES) return false;
	for (const name of names) {
		if (!isBoundedIdentifier(name, TASK_CREDENTIAL_IDENTIFIER_MAX_LENGTH)) return false;
		const material = value[name];
		if (typeof material !== "string" || material.length === 0 || material.length > TASK_CREDENTIAL_PROVIDER_MATERIAL_MAX_LENGTH) {
			return false;
		}
	}
	return true;
}

/**
 * Module-private structural guard for the provider-to-target projection
 * request, the only contract that carries material. The request is still
 * key-allowlisted and the material map is bounded; only this request type
 * may carry material.
 */
function isTaskCredentialTargetProjectRequest(value: unknown): value is TaskCredentialTargetProjectRequest {
	if (!isRecord(value) || !hasOnlyKeys(value, TARGET_PROJECT_KEYS)) return false;
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
	if (!isScopeArray(value.scopes)) return false;
	if (!isMaterialMap(value.material)) return false;
	return hasRequestTimestamp(value, "projectedAt");
}

/** Shared fail-closed delivery receipt; never reads the request beyond IDs. */
function failClosedReceipt(
	request: { readonly leaseId: string; readonly grantId: string; readonly bindingId: string; readonly targetId?: string },
	nowFn: () => string,
): TaskCredentialDeliveryReceipt {
	const receipt: TaskCredentialDeliveryReceipt = {
		schemaVersion: TASK_CREDENTIAL_SCHEMA_VERSION,
		leaseId: request.leaseId,
		grantId: request.grantId,
		bindingId: request.bindingId,
		status: "failed",
		recordedAt: nowFn(),
		reasonCode: "task_credential_target_unavailable",
	};
	if (request.targetId !== undefined) {
		(receipt as { targetId?: string }).targetId = request.targetId;
	}
	return serializeTaskCredentialDeliveryReceipt(receipt);
}

/** Shared fail-closed renew / revoke receipt; never reads the request beyond IDs. */
function failClosedProviderReceipt(
	request: { readonly leaseId: string; readonly grantId: string; readonly bindingId: string; readonly targetId?: string },
	nowFn: () => string,
): TaskCredentialProviderReceipt {
	const receipt: TaskCredentialProviderReceipt = {
		schemaVersion: TASK_CREDENTIAL_SCHEMA_VERSION,
		leaseId: request.leaseId,
		grantId: request.grantId,
		bindingId: request.bindingId,
		status: "failed",
		recordedAt: nowFn(),
		reasonCode: "task_credential_target_unavailable",
	};
	return serializeTaskCredentialProviderReceipt(receipt);
}

/** Fail-closed capabilities snapshot: request identity echoed, every capability unavailable. */
function failClosedCapabilities(request: TaskCredentialTargetCapabilitiesRequest): TaskCredentialTargetCapabilities {
	return serializeTaskCredentialTargetCapabilities({
		schemaVersion: TASK_CREDENTIAL_SCHEMA_VERSION,
		targetId: request.targetId,
		targetKind: request.targetKind,
		bindingId: request.bindingId,
		canReceiveShortLivedCredential: false,
		canRenewCredential: false,
		canRevokeCredential: false,
		supportsPerBindingIsolation: false,
		supportsDeliveryReceipt: false,
	});
}

/** Fail-closed capabilities lookup: validates the request, then declares no capability. */
function failClosedGetCapabilities(request: TaskCredentialTargetCapabilitiesRequest): TaskCredentialTargetCapabilities {
	if (!isTaskCredentialTargetCapabilitiesRequest(request)) {
		throw new TaskCredentialError("task_credential_invalid");
	}
	return failClosedCapabilities(request);
}

/** Fail-closed target renew: validates the request, then reports the unavailable capability. */
function failClosedRenew(request: TaskCredentialTargetRenewRequest, nowFn: () => string): TaskCredentialProviderReceipt {
	if (!isTaskCredentialTargetRenewRequest(request)) {
		throw new TaskCredentialError("task_credential_invalid");
	}
	return failClosedProviderReceipt(request, nowFn);
}

/** Fail-closed target revoke: validates the request, then reports the unavailable capability. */
function failClosedRevoke(request: TaskCredentialTargetRevokeRequest, nowFn: () => string): TaskCredentialProviderReceipt {
	if (!isTaskCredentialTargetRevokeRequest(request)) {
		throw new TaskCredentialError("task_credential_invalid");
	}
	return failClosedProviderReceipt(request, nowFn);
}

/**
 * Fail-closed null target for the store-facing channel. `getCapabilities`
 * declares no capability, and every operation returns a `failed` receipt
 * with reason `task_credential_target_unavailable`; the target never
 * reads, stores, or serializes anything it is handed, so an unconfigured
 * target can never silently absorb a credential. The material-receiving
 * channel fails closed through a module-private target with the same
 * guarantee.
 */
export function createTaskCredentialNullTarget(
	options: { readonly now?: () => string } = {},
): TaskCredentialTarget {
	const nowFn = options.now ?? (() => new Date().toISOString());
	return {
		getCapabilities: failClosedGetCapabilities,
		project(request: TaskCredentialProviderProjectRequest): TaskCredentialDeliveryReceipt {
			if (!isTaskCredentialProviderProjectRequest(request)) {
				throw new TaskCredentialError("task_credential_invalid");
			}
			return failClosedReceipt(request, nowFn);
		},
		renew: (request: TaskCredentialTargetRenewRequest) => failClosedRenew(request, nowFn),
		revoke: (request: TaskCredentialTargetRevokeRequest) => failClosedRevoke(request, nowFn),
	};
}

/**
 * Module-private fail-closed default for the material-receiving channel. It
 * receives the provider-to-target projection and implements the same
 * four-operation contract as the null target, returning `failed` receipts
 * with reason `task_credential_target_unavailable` without reading the
 * material, so an unconfigured adapter can never silently absorb a
 * credential.
 */
function createFailClosedMaterialTarget(nowFn: () => string): TaskCredentialMaterialTarget {
	return {
		getCapabilities: failClosedGetCapabilities,
		project(request: TaskCredentialTargetProjectRequest): TaskCredentialDeliveryReceipt {
			if (!isTaskCredentialTargetProjectRequest(request)) {
				throw new TaskCredentialError("task_credential_invalid");
			}
			return failClosedReceipt(request, nowFn);
		},
		renew: (request: TaskCredentialTargetRenewRequest) => failClosedRenew(request, nowFn),
		revoke: (request: TaskCredentialTargetRevokeRequest) => failClosedRevoke(request, nowFn),
	};
}

/** Test-only inspection record; safe fields only, never material. */
export interface TaskCredentialTestProviderRecord {
	readonly leaseId: string;
	readonly grantId: string;
	readonly bindingId: string;
	readonly credentialNames: ReadonlyArray<string>;
	readonly issuedAt: string;
	readonly expiresAt: string;
	readonly revoked: boolean;
}

/**
 * Module-private construction options of the test provider. `materials` is
 * the adapter's seed data: it stays inside the provider and never appears in
 * an exported contract, receipt, record, error, or serialization. The type
 * is not exported so the material map is not part of the provider-neutral
 * API.
 */
interface TaskCredentialTestProviderOptions {
	/** Credential name to material map; kept strictly inside the provider. */
	readonly materials: Readonly<Record<string, string>>;
	/**
	 * Full target adapter; defaults to the module-private fail-closed
	 * target. Only its `project` request ever carries material.
	 */
	readonly target?: TaskCredentialMaterialTarget;
	/** Revocation outcome to report; defaults to `revoked`. */
	readonly revokeOutcome?: "revoked" | "revocation_unknown";
	/** Clock for receipt timestamps; must return canonical UTC ISO timestamps. */
	readonly now?: () => string;
}

export interface TaskCredentialTestProvider extends TaskCredentialProvider {
	/** Issued grants by leaseId; safe records only, never material. */
	readonly records: ReadonlyMap<string, TaskCredentialTestProviderRecord>;
}

interface ProviderGrant {
	record: TaskCredentialTestProviderRecord;
	readonly scopes: ReadonlyArray<TaskCredentialScope>;
	readonly material: Readonly<Record<string, string>>;
}

/** Resolve a known grant by the request ids; `not_found` / `conflict` on mismatch. */
function grantFor(
	grants: ReadonlyMap<string, ProviderGrant>,
	leaseId: string,
	grantId: string,
	bindingId: string,
): ProviderGrant {
	const existing = grants.get(leaseId);
	if (existing === undefined) {
		throw new TaskCredentialError("task_credential_not_found");
	}
	if (existing.record.grantId !== grantId || existing.record.bindingId !== bindingId) {
		throw new TaskCredentialError("task_credential_conflict");
	}
	return existing;
}

/**
 * In-memory issuer for tests and local development. Sentinel material is
 * stored internally at construction, keyed by credential name, and is handed
 * to the target only inside `TaskCredentialTargetProjectRequest`. Receipts,
 * records, errors, and JSON serializations never contain material.
 */
export function createTaskCredentialTestProvider(
	options: TaskCredentialTestProviderOptions,
): TaskCredentialTestProvider {
	const materials: Readonly<Record<string, string>> = { ...options.materials };
	if (Object.keys(materials).length === 0 || !isMaterialMap(materials)) {
		throw new TypeError("Task credential test provider requires a non-empty bounded material map");
	}
	const nowFn = options.now ?? (() => new Date().toISOString());
	const target = options.target ?? createFailClosedMaterialTarget(nowFn);
	const grants = new Map<string, ProviderGrant>();

	const provider: Omit<TaskCredentialTestProvider, "records"> = {
		issuer: {
			issue(request: TaskCredentialProviderIssueRequest): TaskCredentialProviderReceipt {
				if (!isTaskCredentialProviderIssueRequest(request)) {
					throw new TaskCredentialError("task_credential_invalid");
				}
				const existing = grants.get(request.leaseId);
				if (existing !== undefined) {
					if (existing.record.grantId !== request.grantId) {
						throw new TaskCredentialError("task_credential_conflict");
					}
					// Idempotent replay: the same grant was already issued here.
					return {
						schemaVersion: TASK_CREDENTIAL_SCHEMA_VERSION,
						leaseId: request.leaseId,
						grantId: request.grantId,
						bindingId: request.binding.bindingId,
						status: "issued",
						recordedAt: nowFn(),
					};
				}
				const scopes = request.scopes.map((scope) => serializeTaskCredentialScope(scope));
				const credentialNames: string[] = [];
				const material: Record<string, string> = {};
				for (const scope of scopes) {
					if (!credentialNames.includes(scope.credentialName)) credentialNames.push(scope.credentialName);
				}
				for (const name of credentialNames) {
					const value = materials[name];
					if (value === undefined) {
						// The requested credential is not in the issuer's allowlist.
						throw new TaskCredentialError("task_credential_scope_denied");
					}
					material[name] = value;
				}
				const issuedAtMs = Date.parse(request.requestedAt);
				grants.set(request.leaseId, {
					record: {
						leaseId: request.leaseId,
						grantId: request.grantId,
						bindingId: request.binding.bindingId,
						credentialNames,
						issuedAt: request.requestedAt,
						expiresAt: new Date(issuedAtMs + request.requestedTtlMs).toISOString(),
						revoked: false,
					},
					scopes,
					material,
				});
				return {
					schemaVersion: TASK_CREDENTIAL_SCHEMA_VERSION,
					leaseId: request.leaseId,
					grantId: request.grantId,
					bindingId: request.binding.bindingId,
					status: "issued",
					recordedAt: nowFn(),
				};
			},
			renew(request: TaskCredentialProviderRenewRequest): TaskCredentialProviderReceipt {
				if (!isTaskCredentialProviderRenewRequest(request)) {
					throw new TaskCredentialError("task_credential_invalid");
				}
				const existing = grantFor(grants, request.leaseId, request.grantId, request.bindingId);
				if (existing.record.revoked) {
					throw new TaskCredentialError("task_credential_conflict");
				}
				const requestedAtMs = Date.parse(request.requestedAt);
				if (requestedAtMs >= Date.parse(existing.record.expiresAt)) {
					throw new TaskCredentialError("task_lease_expired");
				}
				existing.record = {
					...existing.record,
					expiresAt: new Date(requestedAtMs + request.requestedTtlMs).toISOString(),
				};
				return {
					schemaVersion: TASK_CREDENTIAL_SCHEMA_VERSION,
					leaseId: request.leaseId,
					grantId: request.grantId,
					bindingId: request.bindingId,
					status: "renewed",
					recordedAt: nowFn(),
				};
			},
			revoke(request: TaskCredentialProviderRevokeRequest): TaskCredentialProviderReceipt {
				if (!isTaskCredentialProviderRevokeRequest(request)) {
					throw new TaskCredentialError("task_credential_invalid");
				}
				const existing = grantFor(grants, request.leaseId, request.grantId, request.bindingId);
				existing.record = { ...existing.record, revoked: true };
				const receipt: TaskCredentialProviderReceipt = {
					schemaVersion: TASK_CREDENTIAL_SCHEMA_VERSION,
					leaseId: request.leaseId,
					grantId: request.grantId,
					bindingId: request.bindingId,
					status: options.revokeOutcome ?? "revoked",
					recordedAt: nowFn(),
				};
				if (request.reasonCode !== undefined) (receipt as { reasonCode?: string }).reasonCode = request.reasonCode;
				return receipt;
			},
		},
		target: {
			getCapabilities(request: TaskCredentialTargetCapabilitiesRequest): TaskCredentialTargetCapabilities {
				if (!isTaskCredentialTargetCapabilitiesRequest(request)) {
					throw new TaskCredentialError("task_credential_invalid");
				}
				const capabilities = parseTaskCredentialTargetCapabilities(target.getCapabilities(request));
				if (
					capabilities === undefined ||
					capabilities.targetId !== request.targetId ||
					capabilities.targetKind !== request.targetKind ||
					capabilities.bindingId !== request.bindingId
				) {
					// The target responded with something that is not a safe snapshot
					// matching the requested target identity, kind, and binding; fail
					// closed and never surface the raw response.
					throw new TaskCredentialError("task_credential_delivery_failed");
				}
				return capabilities;
			},
			project(request: TaskCredentialProviderProjectRequest): TaskCredentialDeliveryReceipt {
				if (!isTaskCredentialProviderProjectRequest(request)) {
					throw new TaskCredentialError("task_credential_invalid");
				}
				const existing = grantFor(grants, request.leaseId, request.grantId, request.bindingId);
				if (existing.record.revoked) {
					throw new TaskCredentialError("task_credential_conflict");
				}
				const projection: TaskCredentialTargetProjectRequest = {
					schemaVersion: TASK_CREDENTIAL_SCHEMA_VERSION,
					leaseId: request.leaseId,
					grantId: request.grantId,
					bindingId: request.bindingId,
					scopes: existing.scopes,
					material: { ...existing.material },
					projectedAt: request.requestedAt,
				};
				if (request.targetId !== undefined) {
					(projection as { targetId?: string }).targetId = request.targetId;
				}
				const receipt = target.project(projection);
				const parsed = parseTaskCredentialDeliveryReceipt(receipt);
				if (parsed === undefined) {
					// The target responded with something that is not a safe receipt;
					// fail closed and never surface the raw response.
					throw new TaskCredentialError("task_credential_delivery_failed");
				}
				return parsed;
			},
			renew(request: TaskCredentialTargetRenewRequest): TaskCredentialProviderReceipt {
				if (!isTaskCredentialTargetRenewRequest(request)) {
					throw new TaskCredentialError("task_credential_invalid");
				}
				const existing = grantFor(grants, request.leaseId, request.grantId, request.bindingId);
				if (existing.record.revoked) {
					throw new TaskCredentialError("task_credential_conflict");
				}
				if (Date.parse(request.requestedAt) >= Date.parse(existing.record.expiresAt)) {
					throw new TaskCredentialError("task_lease_expired");
				}
				const receipt = parseTaskCredentialProviderReceipt(target.renew(request));
				if (
					receipt === undefined ||
					receipt.leaseId !== request.leaseId ||
					receipt.grantId !== request.grantId ||
					receipt.bindingId !== request.bindingId
				) {
					// The target responded with something that is not a safe, matching
					// receipt; fail closed and never surface the raw response.
					throw new TaskCredentialError("task_credential_delivery_failed");
				}
				return receipt;
			},
			revoke(request: TaskCredentialTargetRevokeRequest): TaskCredentialProviderReceipt {
				if (!isTaskCredentialTargetRevokeRequest(request)) {
					throw new TaskCredentialError("task_credential_invalid");
				}
				grantFor(grants, request.leaseId, request.grantId, request.bindingId);
				const receipt = parseTaskCredentialProviderReceipt(target.revoke(request));
				if (
					receipt === undefined ||
					receipt.leaseId !== request.leaseId ||
					receipt.grantId !== request.grantId ||
					receipt.bindingId !== request.bindingId
				) {
					// The target responded with something that is not a safe, matching
					// receipt; fail closed and never surface the raw response.
					throw new TaskCredentialError("task_credential_delivery_failed");
				}
				return receipt;
			},
		},
	};

	// Live snapshot of the internal grants map; safe records only, never material.
	Object.defineProperty(provider, "records", {
		get: () => {
			const snapshot = new Map<string, TaskCredentialTestProviderRecord>();
			for (const [leaseId, grant] of grants) {
				snapshot.set(leaseId, { ...grant.record });
			}
			return snapshot;
		},
		enumerable: true,
		configurable: false,
	});
	return provider as TaskCredentialTestProvider;
}
