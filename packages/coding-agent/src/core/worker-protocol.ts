/**
 * Private Host/Operation-Worker stdio protocol.
 *
 * The protocol is deliberately smaller than the public Foundation transport.
 * Frames carry only safe references and bounded operation facts.  A protocol
 * violation is a terminal Host fact: callers receive a stable Foundation
 * error and never receive the offending frame or a child-process exception.
 */

import {
	FoundationError,
	Result,
	canonicalFoundationJson,
	redactText,
	validateSandboxOperationRequestV1,
	validateWorkerReceipt,
	type ArtifactRefV1,
	type FoundationJsonValue,
	type PublicExecutionErrorV1,
	type Result as ResultValue,
	type SandboxOperationRequestV1,
	type SideEffectStateV1,
	type WorkerReceiptV1,
} from "@aos-agent/agent-core";
import {
	WORKER_SCHEMA_VERSION,
	validateWorkerBindingV1,
	type WorkerBindingV1,
} from "./worker.ts";

export const WORKER_PROTOCOL_SCHEMA_VERSION = 1 as const;

/** Maximum encoded JSONL line size, including its trailing newline. */
export const WORKER_PROTOCOL_MAX_FRAME_BYTES = 64 * 1024;
/** Maximum UTF-8 bytes accepted from one operation.data chunk before truncation. */
export const WORKER_PROTOCOL_MAX_DATA_CHUNK_BYTES = 16 * 1024;
/** Maximum UTF-8 bytes accepted from all operation.data chunks for one operation. */
export const WORKER_PROTOCOL_MAX_OPERATION_DATA_BYTES = 256 * 1024;
/** Maximum operation.data events retained for one operation. */
export const WORKER_PROTOCOL_MAX_OPERATION_DATA_EVENTS = 256;
/** Maximum encoded diagnostic emitted on stderr. */
export const WORKER_PROTOCOL_MAX_DIAGNOSTIC_BYTES = 4 * 1024;
/** Maximum safe result data encoded size. */
export const WORKER_PROTOCOL_MAX_RESULT_DATA_BYTES = 256 * 1024;
/** Maximum number of capabilities in a ready frame. */
export const WORKER_PROTOCOL_MAX_CAPABILITIES = 128;
/** Maximum number of artifact references in a safe result or receipt. */
export const WORKER_PROTOCOL_MAX_ARTIFACTS = 64;

// Descriptive aliases keep the limits discoverable to Supervisor/Runtime users.
export const WORKER_PROTOCOL_MAX_FRAME_SIZE_BYTES = WORKER_PROTOCOL_MAX_FRAME_BYTES;
export const WORKER_PROTOCOL_MAX_SINGLE_CHUNK_BYTES = WORKER_PROTOCOL_MAX_DATA_CHUNK_BYTES;
export const WORKER_PROTOCOL_MAX_OPERATION_BYTES = WORKER_PROTOCOL_MAX_OPERATION_DATA_BYTES;
export const WORKER_PROTOCOL_MAX_OPERATION_EVENTS = WORKER_PROTOCOL_MAX_OPERATION_DATA_EVENTS;
export const WORKER_PROTOCOL_MAX_STDERR_DIAGNOSTIC_BYTES = WORKER_PROTOCOL_MAX_DIAGNOSTIC_BYTES;
export const MAX_WORKER_FRAME_BYTES = WORKER_PROTOCOL_MAX_FRAME_BYTES;
export const MAX_WORKER_DATA_CHUNK_BYTES = WORKER_PROTOCOL_MAX_DATA_CHUNK_BYTES;
export const MAX_WORKER_OPERATION_DATA_BYTES = WORKER_PROTOCOL_MAX_OPERATION_DATA_BYTES;
export const MAX_WORKER_OPERATION_DATA_EVENTS = WORKER_PROTOCOL_MAX_OPERATION_DATA_EVENTS;

export const WORKER_REQUEST_FRAME_TYPES = Object.freeze([
	"initialize",
	"execute",
	"credential.project",
	"credential.renew",
	"credential.revoke",
	"cancel",
	"reclaim",
	"ping",
] as const);
export type WorkerRequestFrameTypeV1 = (typeof WORKER_REQUEST_FRAME_TYPES)[number];

export const WORKER_EVENT_FRAME_TYPES = Object.freeze([
	"ready",
	"heartbeat",
	"operation.started",
	"operation.data",
	"operation.completed",
	"receipt",
	"error",
	"pong",
] as const);
export type WorkerEventFrameTypeV1 = (typeof WORKER_EVENT_FRAME_TYPES)[number];

export type WorkerCancelReasonV1 = "cancel" | "deadline" | "shutdown" | "detach";
export type WorkerDataStreamV1 = "stdout" | "stderr" | "content";

export interface SafeLeaseProjectionV1 {
	readonly schemaVersion: 1;
	readonly leaseId: string;
	readonly grantId: string;
	readonly bindingId: string;
	readonly scopeDigest: string;
	readonly expiresAt: string;
	readonly clientRequestId: string;
}

export interface SafeLeaseReferenceV1 {
	readonly schemaVersion: 1;
	readonly leaseId: string;
	readonly grantId: string;
	readonly bindingId: string;
	readonly clientRequestId: string;
}

export interface SafeOperationResultV1 {
	readonly schemaVersion: 1;
	readonly operationId: string;
	readonly ok: boolean;
	readonly sideEffectState: SideEffectStateV1;
	readonly data?: FoundationJsonValue;
	readonly artifacts?: readonly ArtifactRefV1[];
	readonly error?: PublicExecutionErrorV1;
}

export type WorkerRequestFrameV1 =
	| {
			readonly type: "initialize";
			readonly requestId: string;
			readonly binding: WorkerBindingV1;
	  }
	| {
			readonly type: "execute";
			readonly requestId: string;
			readonly workerId: string;
			readonly operationId: string;
			readonly request: SandboxOperationRequestV1;
	  }
	| {
			readonly type: "credential.project" | "credential.renew";
			readonly requestId: string;
			readonly workerId: string;
			readonly lease: SafeLeaseProjectionV1;
	  }
	| {
			readonly type: "credential.revoke";
			readonly requestId: string;
			readonly workerId: string;
			readonly leaseRef: SafeLeaseReferenceV1;
	  }
	| {
			readonly type: "cancel";
			readonly requestId: string;
			readonly workerId: string;
			readonly operationId?: string;
			readonly reason: WorkerCancelReasonV1;
	  }
	| {
			readonly type: "reclaim";
			readonly requestId: string;
			readonly workerId: string;
	  }
	| {
			readonly type: "ping";
			readonly requestId: string;
			readonly workerId: string;
	  };

export type WorkerEventFrameV1 =
	| {
			readonly type: "ready";
			readonly requestId: string;
			readonly workerId: string;
			readonly providerId: string;
			readonly requestFingerprint: string;
			readonly capabilities: readonly string[];
	  }
	| {
			readonly type: "heartbeat";
			readonly workerId: string;
			readonly sequence: number;
			readonly at: string;
	  }
	| {
			readonly type: "operation.started";
			readonly requestId: string;
			readonly workerId: string;
			readonly operationId: string;
			readonly at: string;
	  }
	| {
			readonly type: "operation.data";
			readonly requestId: string;
			readonly workerId: string;
			readonly operationId: string;
			readonly stream: WorkerDataStreamV1;
			readonly data: string;
			readonly truncated?: boolean;
	  }
	| {
			readonly type: "operation.completed";
			readonly requestId: string;
			readonly workerId: string;
			readonly operationId: string;
			readonly result: SafeOperationResultV1;
	  }
	| {
			readonly type: "receipt";
			readonly requestId: string;
			readonly receipt: WorkerReceiptV1;
	  }
	| {
			readonly type: "error";
			readonly requestId?: string;
			readonly workerId: string;
			readonly code: string;
	  }
	| {
			readonly type: "pong";
			readonly requestId: string;
			readonly workerId: string;
			readonly at: string;
	  };

export type WorkerProtocolFrameV1 = WorkerRequestFrameV1 | WorkerEventFrameV1;
export type WorkerFrameV1 = WorkerProtocolFrameV1;
export type WorkerProtocolDirectionV1 = "host" | "worker";
export type WorkerRequestFrame = WorkerRequestFrameV1;
export type WorkerEventFrame = WorkerEventFrameV1;
export type WorkerProtocolFrame = WorkerProtocolFrameV1;

export const WORKER_REQUEST_FRAME_KEYS_V1: Readonly<Record<WorkerRequestFrameTypeV1, readonly string[]>> = Object.freeze({
	initialize: Object.freeze(["type", "requestId", "binding"]),
	execute: Object.freeze(["type", "requestId", "workerId", "operationId", "request"]),
	"credential.project": Object.freeze(["type", "requestId", "workerId", "lease"]),
	"credential.renew": Object.freeze(["type", "requestId", "workerId", "lease"]),
	"credential.revoke": Object.freeze(["type", "requestId", "workerId", "leaseRef"]),
	cancel: Object.freeze(["type", "requestId", "workerId", "operationId", "reason"]),
	reclaim: Object.freeze(["type", "requestId", "workerId"]),
	ping: Object.freeze(["type", "requestId", "workerId"]),
});

export const WORKER_EVENT_FRAME_KEYS_V1: Readonly<Record<WorkerEventFrameTypeV1, readonly string[]>> = Object.freeze({
	ready: Object.freeze(["type", "requestId", "workerId", "providerId", "requestFingerprint", "capabilities"]),
	heartbeat: Object.freeze(["type", "workerId", "sequence", "at"]),
	"operation.started": Object.freeze(["type", "requestId", "workerId", "operationId", "at"]),
	"operation.data": Object.freeze(["type", "requestId", "workerId", "operationId", "stream", "data", "truncated"]),
	"operation.completed": Object.freeze(["type", "requestId", "workerId", "operationId", "result"]),
	receipt: Object.freeze(["type", "requestId", "receipt"]),
	error: Object.freeze(["type", "requestId", "workerId", "code"]),
	pong: Object.freeze(["type", "requestId", "workerId", "at"]),
});

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][-A-Za-z0-9._:]{0,255}$/;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const FRAME_ERROR_CODES = new Set([
	"worker_invalid",
	"worker_profile_untrusted",
	"worker_unavailable",
	"worker_start_failed",
	"worker_binding_invalid",
	"worker_operation_invalid",
	"worker_cancel_failed",
	"worker_deadline_exceeded",
	"worker_lost",
	"worker_receipt_invalid",
	"worker_reclaim_failed",
	"worker_not_found",
	"worker_conflict",
	"worker_persistence_failed",
	"side_effect_unknown",
	"worker_receipt_invalid_producer",
	"invalid_correlation",
	"task_credential_target_unavailable",
	"sandbox_capability_insufficient",
	"run_deadline_exceeded",
]);
const DATA_FORBIDDEN_KEY_PARTS = [
	"raw",
	"command",
	"executable",
	"argv",
	"args",
	"cwd",
	"workspace",
	"path",
	"env",
	"stdout",
	"stderr",
	"prompt",
	"secret",
	"token",
	"credential",
	"authorization",
	"cookie",
	"header",
	"stack",
	"exception",
	"password",
	"apikey",
	"signature",
	"url",
] as const;
const PUBLIC_ERROR_CATEGORIES = new Set([
	"permission",
	"parameter",
	"transient",
	"deadline",
	"cancelled",
	"side_effect_unknown",
	"unknown",
]);
const PUBLIC_ERROR_FORBIDDEN_DIAGNOSTIC_PATTERNS = [
	/\bpid\b/i,
	/\bexecutable\b/i,
	/\bargv\b/i,
	/\bcwd\b/i,
	/\bpath\b/i,
	/(?:^|[\s:=])(?:[A-Za-z]:)?[\\/][^\s]*/i,
	/\benv(?:ironment)?\b/i,
	/\bstdout\b/i,
	/\bstderr\b/i,
	/\bprompt\b/i,
	/\bsecret\b/i,
	/\btoken\b/i,
	/\bheader\b/i,
	/\bprovider\b/i,
	/\bstack\b/i,
	/\bvm\b/i,
	/\bqemu\b/i,
	/\braw(?:\s+frame)?\b/i,
] as const;

type RecordValue = Record<string, unknown>;
type ProtocolResult<TValue> = ResultValue<TValue, FoundationError>;

function isRecord(value: unknown): value is RecordValue {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	try {
		const prototype = Object.getPrototypeOf(value);
		return (prototype === Object.prototype || prototype === null) && Reflect.ownKeys(value).every((key) => typeof key === "string");
	} catch {
		return false;
	}
}

function hasExactKeys(value: RecordValue, required: readonly string[], optional: readonly string[] = []): boolean {
	const allowed = new Set([...required, ...optional]);
	const keys = Reflect.ownKeys(value);
	return (
		keys.every((key) => typeof key === "string" && allowed.has(key) && value[key] !== undefined) &&
		required.every((key) => Object.hasOwn(value, key))
	);
}

function isSafeIdentifier(value: unknown): value is string {
	return typeof value === "string" && IDENTIFIER_PATTERN.test(value);
}

function isCanonicalTimestamp(value: unknown): value is string {
	if (typeof value !== "string" || !TIMESTAMP_PATTERN.test(value)) return false;
	const parsed = new Date(value);
	return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function isDigest(value: unknown): value is string {
	return typeof value === "string" && DIGEST_PATTERN.test(value);
}

function isSafeInteger(value: unknown, minimum = 0): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}

function utf8ByteLength(value: string): number {
	return new TextEncoder().encode(value).byteLength;
}

function truncateUtf8(value: string, maxBytes: number): { readonly value: string; readonly bytes: number; readonly truncated: boolean } {
	if (utf8ByteLength(value) <= maxBytes) return { value, bytes: utf8ByteLength(value), truncated: false };
	let output = "";
	let bytes = 0;
	for (const character of value) {
		const characterBytes = utf8ByteLength(character);
		if (bytes + characterBytes > maxBytes) break;
		output += character;
		bytes += characterBytes;
	}
	return { value: output, bytes, truncated: true };
}

export interface WorkerDataTruncationV1 {
	readonly value: string;
	readonly bytes: number;
	readonly truncated: boolean;
}

export function truncateWorkerDataChunkV1(value: string, maxBytes = WORKER_PROTOCOL_MAX_DATA_CHUNK_BYTES): WorkerDataTruncationV1 {
	return truncateUtf8(value, maxBytes);
}

function protocolError(code: "worker_operation_invalid" | "worker_binding_invalid" | "worker_conflict" | "worker_receipt_invalid" | "worker_lost", message: string): FoundationError {
	return new FoundationError(code, message);
}

function operationInvalid(): FoundationError {
	return protocolError("worker_operation_invalid", "Worker protocol frame is invalid");
}

function bindingInvalid(): FoundationError {
	return protocolError("worker_binding_invalid", "Worker protocol identity is invalid");
}

function conflict(): FoundationError {
	return protocolError("worker_conflict", "Worker protocol correlation is stale or duplicated");
}

function receiptInvalid(): FoundationError {
	return protocolError("worker_receipt_invalid", "Worker receipt is invalid");
}

function workerLost(): FoundationError {
	return protocolError("worker_lost", "Operation Worker connection was lost");
}

function hasForbiddenDataKey(value: unknown, seen = new WeakSet<object>()): boolean {
	if (value === null || typeof value !== "object") return false;
	if (seen.has(value)) return true;
	seen.add(value);
	if (Array.isArray(value)) return value.some((item) => hasForbiddenDataKey(item, seen));
	if (!isRecord(value)) return true;
	for (const [key, item] of Object.entries(value)) {
		const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
		if (DATA_FORBIDDEN_KEY_PARTS.some((part) => normalized.includes(part))) return true;
		if (hasForbiddenDataKey(item, seen)) return true;
	}
	return false;
}

function isFoundationJson(value: unknown): value is FoundationJsonValue {
	try {
		canonicalFoundationJson(value);
		return !hasForbiddenDataKey(value);
	} catch {
		return false;
	}
}

function isBoundedFoundationJson(value: unknown, maxBytes: number): value is FoundationJsonValue {
	if (!isFoundationJson(value)) return false;
	try {
		return utf8ByteLength(canonicalFoundationJson(value)) <= maxBytes;
	} catch {
		return false;
	}
}

function isSafePublicError(value: unknown): value is PublicExecutionErrorV1 {
	if (!isRecord(value) || !hasExactKeys(value, ["code", "message", "retryable"], ["category"])) return false;
	const message = value.message;
	if (
		typeof value.code !== "string" ||
		!FRAME_ERROR_CODES.has(value.code) ||
		typeof message !== "string" ||
		message.length === 0 ||
		utf8ByteLength(message) > 1024 ||
		/[\u0000-\u001f\u007f]/.test(message) ||
		PUBLIC_ERROR_FORBIDDEN_DIAGNOSTIC_PATTERNS.some((pattern) => pattern.test(message)) ||
		redactText(message) !== message ||
		typeof value.retryable !== "boolean"
	) {
		return false;
	}
	return value.category === undefined || (typeof value.category === "string" && PUBLIC_ERROR_CATEGORIES.has(value.category));
}

function isSafeArtifact(value: unknown): value is ArtifactRefV1 {
	if (!isRecord(value) || !hasExactKeys(value, ["schemaVersion", "artifactId", "mediaType", "digest"], ["producer", "sizeBytes"])) return false;
	return (
		value.schemaVersion === WORKER_SCHEMA_VERSION &&
		isSafeIdentifier(value.artifactId) &&
		typeof value.mediaType === "string" &&
		value.mediaType.length > 0 &&
		utf8ByteLength(value.mediaType) <= 128 &&
		isDigest(value.digest) &&
		(value.producer === undefined || isSafeIdentifier(value.producer)) &&
		(value.sizeBytes === undefined || isSafeInteger(value.sizeBytes))
	);
}

export function validateSafeLeaseProjectionV1(value: unknown): value is SafeLeaseProjectionV1 {
	if (!isRecord(value) || !hasExactKeys(value, ["schemaVersion", "leaseId", "grantId", "bindingId", "scopeDigest", "expiresAt", "clientRequestId"])) return false;
	return (
		value.schemaVersion === WORKER_PROTOCOL_SCHEMA_VERSION &&
		isSafeIdentifier(value.leaseId) &&
		isSafeIdentifier(value.grantId) &&
		isSafeIdentifier(value.bindingId) &&
		isDigest(value.scopeDigest) &&
		isCanonicalTimestamp(value.expiresAt) &&
		isSafeIdentifier(value.clientRequestId)
	);
}

export function validateSafeLeaseReferenceV1(value: unknown): value is SafeLeaseReferenceV1 {
	if (!isRecord(value) || !hasExactKeys(value, ["schemaVersion", "leaseId", "grantId", "bindingId", "clientRequestId"])) return false;
	return (
		value.schemaVersion === WORKER_PROTOCOL_SCHEMA_VERSION &&
		isSafeIdentifier(value.leaseId) &&
		isSafeIdentifier(value.grantId) &&
		isSafeIdentifier(value.bindingId) &&
		isSafeIdentifier(value.clientRequestId)
	);
}

export function validateSafeOperationResultV1(value: unknown): value is SafeOperationResultV1 {
	if (!isRecord(value) || !hasExactKeys(value, ["schemaVersion", "operationId", "ok", "sideEffectState"], ["data", "artifacts", "error"])) return false;
	if (
		value.schemaVersion !== WORKER_PROTOCOL_SCHEMA_VERSION ||
		!isSafeIdentifier(value.operationId) ||
		typeof value.ok !== "boolean" ||
		(value.sideEffectState !== "none" && value.sideEffectState !== "unknown" && value.sideEffectState !== "side_effect_unknown") ||
		(value.ok && value.sideEffectState !== "none") ||
		(value.data !== undefined && !isBoundedFoundationJson(value.data, WORKER_PROTOCOL_MAX_RESULT_DATA_BYTES)) ||
		(value.error !== undefined && !isSafePublicError(value.error))
	) {
		return false;
	}
	if (value.artifacts !== undefined) {
		if (!Array.isArray(value.artifacts) || value.artifacts.length > WORKER_PROTOCOL_MAX_ARTIFACTS || !value.artifacts.every(isSafeArtifact)) return false;
	}
	return true;
}

export const validateSafeLeaseProjection = validateSafeLeaseProjectionV1;
export const validateSafeLeaseReference = validateSafeLeaseReferenceV1;
export const validateSafeOperationResult = validateSafeOperationResultV1;

function cloneBinding(value: WorkerBindingV1): WorkerBindingV1 {
	return Object.freeze({
		...value,
		capabilitySummary: Object.freeze([...value.capabilitySummary]),
		credentialTargetRefs: Object.freeze([...value.credentialTargetRefs]),
	});
}

function sameBinding(left: WorkerBindingV1, right: WorkerBindingV1): boolean {
	try {
		return canonicalFoundationJson(left) === canonicalFoundationJson(right);
	} catch {
		return false;
	}
}

function sameStringSequence(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

function receiptMatchesRequestAndBinding(receipt: WorkerReceiptV1, request: WorkerProtocolRequestStateV1, binding: WorkerBindingV1): boolean {
	const correlation = receipt.provenance.correlation;
	if (
		correlation === undefined ||
		receipt.sandboxProviderId !== binding.providerId ||
		receipt.provenance.providerId !== binding.providerId ||
		correlation.sessionId !== binding.sessionId ||
		correlation.laneId !== binding.laneId ||
		correlation.operationId !== request.operationId
	) return false;
	for (const field of ["taskId", "dispatchId", "attemptId"] as const) {
		const receiptValue = receipt[field];
		const correlationValue = correlation[field];
		const requestValue = request[field];
		const requestPresent = requestValue !== undefined;
		if ((receiptValue !== undefined) !== requestPresent || (correlationValue !== undefined) !== requestPresent) return false;
		if (requestPresent && (receiptValue !== requestValue || correlationValue !== requestValue)) return false;
	}
	return true;
}

function validatePrivateWorkerReceipt(value: unknown): value is WorkerReceiptV1 {
	const checked = validateWorkerReceipt(value);
	if (!checked.ok) return false;
	const receipt = checked.value;
	if (
		!isSafeIdentifier(receipt.workerReceiptId) ||
		!isSafeIdentifier(receipt.sandboxProviderId) ||
		!isSafeIdentifier(receipt.operationId) ||
		(receipt.taskId !== undefined && !isSafeIdentifier(receipt.taskId)) ||
		(receipt.dispatchId !== undefined && !isSafeIdentifier(receipt.dispatchId)) ||
		(receipt.attemptId !== undefined && !isSafeIdentifier(receipt.attemptId)) ||
		!isCanonicalTimestamp(receipt.startedAt) ||
		!isCanonicalTimestamp(receipt.completedAt) ||
		receipt.completedAt < receipt.startedAt ||
		receipt.provenance.producerKind !== "operation_worker" ||
		!isSafeIdentifier(receipt.provenance.providerId) ||
		receipt.provenance.providerId !== receipt.sandboxProviderId ||
		!isCanonicalTimestamp(receipt.provenance.producedAt) ||
		receipt.provenance.correlation === undefined ||
		!isSafeIdentifier(receipt.provenance.correlation.sessionId) ||
		!isSafeIdentifier(receipt.provenance.correlation.laneId) ||
		receipt.provenance.correlation.operationId !== receipt.operationId ||
		!isSafeInteger(receipt.provenance.correlation.revision)
	) {
		return false;
	}
	if (receipt.error !== undefined && !isSafePublicError(receipt.error)) return false;
	if (receipt.artifacts !== undefined && (receipt.artifacts.length > WORKER_PROTOCOL_MAX_ARTIFACTS || !receipt.artifacts.every(isSafeArtifact))) return false;
	return true;
}

function isSafeCapabilities(value: unknown): value is readonly string[] {
	return Array.isArray(value) && value.length <= WORKER_PROTOCOL_MAX_CAPABILITIES && value.every(isSafeIdentifier) && new Set(value).size === value.length;
}

function isSafeRequestId(value: unknown): value is string {
	return isSafeIdentifier(value);
}

function validateExecuteRequest(value: unknown): value is SandboxOperationRequestV1 {
	const checked = validateSandboxOperationRequestV1(value);
	return checked.ok && isSafeIdentifier(checked.value.operationId);
}

function validateWorkerRequestFrameInternal(value: unknown): value is WorkerRequestFrameV1 {
	if (!isRecord(value) || typeof value.type !== "string") return false;
	switch (value.type) {
		case "initialize":
			return hasExactKeys(value, ["type", "requestId", "binding"]) && isSafeRequestId(value.requestId) && validateWorkerBindingV1(value.binding);
		case "execute":
			return (
				hasExactKeys(value, ["type", "requestId", "workerId", "operationId", "request"]) &&
				isSafeRequestId(value.requestId) &&
				isSafeIdentifier(value.workerId) &&
				isSafeIdentifier(value.operationId) &&
				validateExecuteRequest(value.request) &&
				value.operationId === value.request.operationId
			);
		case "credential.project":
		case "credential.renew":
			return hasExactKeys(value, ["type", "requestId", "workerId", "lease"]) && isSafeRequestId(value.requestId) && isSafeIdentifier(value.workerId) && validateSafeLeaseProjectionV1(value.lease);
		case "credential.revoke":
			return hasExactKeys(value, ["type", "requestId", "workerId", "leaseRef"]) && isSafeRequestId(value.requestId) && isSafeIdentifier(value.workerId) && validateSafeLeaseReferenceV1(value.leaseRef);
		case "cancel":
			return (
				hasExactKeys(value, ["type", "requestId", "workerId", "reason"], ["operationId"]) &&
				isSafeRequestId(value.requestId) &&
				isSafeIdentifier(value.workerId) &&
				(value.operationId === undefined || isSafeIdentifier(value.operationId)) &&
				(value.reason === "cancel" || value.reason === "deadline" || value.reason === "shutdown" || value.reason === "detach")
			);
		case "reclaim":
		case "ping":
			return hasExactKeys(value, ["type", "requestId", "workerId"]) && isSafeRequestId(value.requestId) && isSafeIdentifier(value.workerId);
		default:
			return false;
	}
}

function validateWorkerEventFrameInternal(value: unknown): value is WorkerEventFrameV1 {
	if (!isRecord(value) || typeof value.type !== "string") return false;
	switch (value.type) {
		case "ready":
			return (
				hasExactKeys(value, ["type", "requestId", "workerId", "providerId", "requestFingerprint", "capabilities"]) &&
				isSafeRequestId(value.requestId) &&
				isSafeIdentifier(value.workerId) &&
				isSafeIdentifier(value.providerId) &&
				isDigest(value.requestFingerprint) &&
				isSafeCapabilities(value.capabilities)
			);
		case "heartbeat":
			return hasExactKeys(value, ["type", "workerId", "sequence", "at"]) && isSafeIdentifier(value.workerId) && isSafeInteger(value.sequence) && isCanonicalTimestamp(value.at);
		case "operation.started":
			return hasExactKeys(value, ["type", "requestId", "workerId", "operationId", "at"]) && isSafeRequestId(value.requestId) && isSafeIdentifier(value.workerId) && isSafeIdentifier(value.operationId) && isCanonicalTimestamp(value.at);
		case "operation.data":
			return (
				hasExactKeys(value, ["type", "requestId", "workerId", "operationId", "stream", "data"], ["truncated"]) &&
				isSafeRequestId(value.requestId) &&
				isSafeIdentifier(value.workerId) &&
				isSafeIdentifier(value.operationId) &&
				(value.stream === "stdout" || value.stream === "stderr" || value.stream === "content") &&
				typeof value.data === "string" &&
				utf8ByteLength(value.data) <= WORKER_PROTOCOL_MAX_FRAME_BYTES &&
				(value.truncated === undefined || typeof value.truncated === "boolean")
			);
		case "operation.completed":
			return (
				hasExactKeys(value, ["type", "requestId", "workerId", "operationId", "result"]) &&
				isSafeRequestId(value.requestId) &&
				isSafeIdentifier(value.workerId) &&
				isSafeIdentifier(value.operationId) &&
				validateSafeOperationResultV1(value.result) &&
				value.operationId === value.result.operationId
			);
		case "receipt":
			return hasExactKeys(value, ["type", "requestId", "receipt"]) && isSafeRequestId(value.requestId) && validatePrivateWorkerReceipt(value.receipt);
		case "error":
			return (
				hasExactKeys(value, ["type", "workerId", "code"], ["requestId"]) &&
				isSafeIdentifier(value.workerId) &&
				(value.requestId === undefined || isSafeRequestId(value.requestId)) &&
				typeof value.code === "string" &&
				FRAME_ERROR_CODES.has(value.code)
			);
		case "pong":
			return hasExactKeys(value, ["type", "requestId", "workerId", "at"]) && isSafeRequestId(value.requestId) && isSafeIdentifier(value.workerId) && isCanonicalTimestamp(value.at);
		default:
			return false;
	}
}

export function validateWorkerRequestFrameV1(value: unknown): value is WorkerRequestFrameV1 {
	try {
		return validateWorkerRequestFrameInternal(value);
	} catch {
		return false;
	}
}

export function validateWorkerEventFrameV1(value: unknown): value is WorkerEventFrameV1 {
	try {
		return validateWorkerEventFrameInternal(value);
	} catch {
		return false;
	}
}

export function validateWorkerFrameV1(value: unknown): value is WorkerProtocolFrameV1 {
	return validateWorkerRequestFrameV1(value) || validateWorkerEventFrameV1(value);
}

export const validateWorkerRequestFrame = validateWorkerRequestFrameV1;
export const validateWorkerEventFrame = validateWorkerEventFrameV1;
export const validateWorkerFrame = validateWorkerFrameV1;

function validateRequestResult(value: unknown): ProtocolResult<WorkerRequestFrameV1> {
	return validateWorkerRequestFrameV1(value) ? Result.ok(value) : Result.err(operationInvalid());
}

function validateEventResult(value: unknown): ProtocolResult<WorkerEventFrameV1> {
	if (validateWorkerEventFrameV1(value)) return Result.ok(value);
	if (isRecord(value) && value.type === "receipt") return Result.err(receiptInvalid());
	return Result.err(operationInvalid());
}

export function validateWorkerRequestFrameResultV1(value: unknown): ProtocolResult<WorkerRequestFrameV1> {
	return validateRequestResult(value);
}

export function validateWorkerEventFrameResultV1(value: unknown): ProtocolResult<WorkerEventFrameV1> {
	return validateEventResult(value);
}

export function validateWorkerFrameResultV1(value: unknown): ProtocolResult<WorkerProtocolFrameV1> {
	if (validateWorkerRequestFrameV1(value)) return Result.ok(value);
	if (isRecord(value) && typeof value.type === "string" && WORKER_EVENT_FRAME_TYPES.includes(value.type as WorkerEventFrameTypeV1)) return validateEventResult(value);
	return Result.err(operationInvalid());
}

export function serializeWorkerFrameV1(value: unknown): string {
	const checked = validateWorkerFrameResultV1(value);
	if (!checked.ok) throw checked.error;
	const normalized = checked.value.type === "operation.data"
		? (() => {
			const bounded = truncateWorkerDataChunkV1(checked.value.data);
			return Object.freeze({
				...checked.value,
				data: bounded.value,
				...(checked.value.truncated === true || bounded.truncated ? { truncated: true } : {}),
			});
		})()
		: checked.value;
	let encoded: string;
	try {
		encoded = canonicalFoundationJson(normalized);
	} catch {
		throw operationInvalid();
	}
	if (utf8ByteLength(encoded) + 1 > WORKER_PROTOCOL_MAX_FRAME_BYTES) throw operationInvalid();
	return encoded;
}

export function serializeWorkerFrameLineV1(value: unknown): string {
	return `${serializeWorkerFrameV1(value)}\n`;
}

export const serializeWorkerJsonlFrameV1 = serializeWorkerFrameLineV1;
export const serializeWorkerProtocolLineV1 = serializeWorkerFrameLineV1;

function stripSingleLineEnding(value: string): string | undefined {
	if (value.endsWith("\r\n")) return value.slice(0, -2);
	if (value.endsWith("\n")) return value.slice(0, -1);
	if (value.includes("\r") || value.includes("\n")) return undefined;
	return value;
}

export function parseWorkerFrameV1(text: string): ProtocolResult<WorkerProtocolFrameV1> {
	if (typeof text !== "string" || utf8ByteLength(text) > WORKER_PROTOCOL_MAX_FRAME_BYTES) return Result.err(operationInvalid());
	const line = stripSingleLineEnding(text);
	if (line === undefined || line.length === 0) return Result.err(operationInvalid());
	try {
		const value = JSON.parse(line) as unknown;
		return validateWorkerFrameResultV1(value);
	} catch {
		return Result.err(operationInvalid());
	}
}

export const parseWorkerFrameLineV1 = parseWorkerFrameV1;
export const parseWorkerJsonlFrameV1 = parseWorkerFrameV1;
export const serializeWorkerFrame = serializeWorkerFrameV1;
export const serializeWorkerJsonlFrame = serializeWorkerFrameLineV1;
export const parseWorkerFrame = parseWorkerFrameV1;
export const parseWorkerJsonlFrame = parseWorkerFrameV1;
export const encodeWorkerFrameV1 = serializeWorkerFrameLineV1;
export const decodeWorkerFrameV1 = parseWorkerFrameV1;

export function parseWorkerJsonlV1(text: string): ProtocolResult<readonly WorkerProtocolFrameV1[]> {
	if (typeof text !== "string" || text.length === 0) return Result.err(operationInvalid());
	const lines = text.split("\n");
	if (lines.at(-1) === "") lines.pop();
	if (lines.length === 0 || lines.some((line) => line.length === 0)) return Result.err(operationInvalid());
	const frames: WorkerProtocolFrameV1[] = [];
	for (const line of lines) {
		const parsed = parseWorkerFrameV1(line);
		if (!parsed.ok) return parsed;
		frames.push(parsed.value);
	}
	return Result.ok(Object.freeze(frames));
}

export function redactWorkerDiagnosticV1(value: string): string {
	void value;
	return "[redacted worker diagnostic]";
}

export function formatWorkerStderrDiagnosticV1(value: string): string {
	return `${redactWorkerDiagnosticV1(value)}\n`;
}

export const redactWorkerStderrV1 = redactWorkerDiagnosticV1;
export const redactWorkerDiagnostic = redactWorkerDiagnosticV1;

export interface WorkerProtocolRequestStateV1 {
	readonly requestId: string;
	readonly type: WorkerRequestFrameTypeV1;
	readonly operationId?: string;
	readonly providerId?: string;
	readonly taskId?: string;
	readonly dispatchId?: string;
	readonly attemptId?: string;
	readonly bindingId?: string;
	readonly bindingEpochId?: string;
	readonly responseCount: number;
	readonly responseType?: WorkerEventFrameTypeV1;
}

export interface WorkerProtocolOperationStateV1 {
	readonly operationId: string;
	readonly requestId: string;
	readonly started: boolean;
	readonly terminal: boolean;
	readonly completed: boolean;
	readonly receiptReceived: boolean;
	readonly dataBytes: number;
	readonly dataEvents: number;
	readonly dataTruncated: boolean;
}

export type WorkerProtocolPhaseV1 = "new" | "initializing" | "ready" | "running" | "cancelling" | "terminal" | "lost";

export interface WorkerProtocolStateV1 {
	readonly schemaVersion: 1;
	readonly phase: WorkerProtocolPhaseV1;
	readonly binding?: WorkerBindingV1;
	readonly initializedRequestId?: string;
	readonly readyRequestId?: string;
	readonly heartbeatSequence?: number;
	readonly lastHeartbeatAt?: string;
	readonly requests: readonly WorkerProtocolRequestStateV1[];
	readonly operations: readonly WorkerProtocolOperationStateV1[];
	readonly reclaimRequested: boolean;
	readonly disconnected: boolean;
}

export interface WorkerProtocolMutationV1 {
	readonly state: WorkerProtocolStateV1;
	readonly frame?: WorkerProtocolFrameV1;
	readonly idempotent: boolean;
	readonly truncated?: boolean;
}

function freezeRequest(value: WorkerProtocolRequestStateV1): WorkerProtocolRequestStateV1 {
	return Object.freeze({ ...value });
}

function freezeOperation(value: WorkerProtocolOperationStateV1): WorkerProtocolOperationStateV1 {
	return Object.freeze({ ...value });
}

function freezeState(value: WorkerProtocolStateV1): WorkerProtocolStateV1 {
	return Object.freeze({
		...value,
		...(value.binding === undefined ? {} : { binding: cloneBinding(value.binding) }),
		requests: Object.freeze(value.requests.map(freezeRequest)),
		operations: Object.freeze(value.operations.map(freezeOperation)),
	});
}

interface WorkerRequestIdentityV1 {
	readonly providerId?: string;
	readonly taskId?: string;
	readonly dispatchId?: string;
	readonly attemptId?: string;
	readonly bindingId?: string;
	readonly bindingEpochId?: string;
}

function requestIdentity(request: SandboxOperationRequestV1): WorkerRequestIdentityV1 {
	return {
		...(request.providerId === undefined ? {} : { providerId: request.providerId }),
		...(request.taskId === undefined ? {} : { taskId: request.taskId }),
		...(request.dispatchId === undefined ? {} : { dispatchId: request.dispatchId }),
		...(request.attemptId === undefined ? {} : { attemptId: request.attemptId }),
		...(request.bindingId === undefined ? {} : { bindingId: request.bindingId }),
		...(request.bindingEpochId === undefined ? {} : { bindingEpochId: request.bindingEpochId }),
	};
}

export function createWorkerProtocolStateV1(binding?: WorkerBindingV1): WorkerProtocolStateV1 {
	if (binding !== undefined && !validateWorkerBindingV1(binding)) throw protocolError("worker_binding_invalid", "Worker protocol binding is invalid");
	return freezeState({
		schemaVersion: WORKER_PROTOCOL_SCHEMA_VERSION,
		phase: "new",
		...(binding === undefined ? {} : { binding: cloneBinding(binding) }),
		requests: [],
		operations: [],
		reclaimRequested: false,
		disconnected: false,
	});
}

export const newWorkerProtocolStateV1 = createWorkerProtocolStateV1;
export const createWorkerProtocolState = createWorkerProtocolStateV1;

function responseTypeCompatible(type: WorkerRequestFrameTypeV1, responseType: WorkerEventFrameTypeV1): boolean {
	switch (type) {
		case "initialize":
			return responseType === "ready" || responseType === "error";
		case "execute":
			return responseType === "receipt" || responseType === "error";
		case "ping":
			return responseType === "pong" || responseType === "error";
		default:
			return responseType === "error";
	}
}

export function protocolStateValid(value: unknown): value is WorkerProtocolStateV1 {
	try {
	if (
		!isRecord(value) ||
		!hasExactKeys(value, ["schemaVersion", "phase", "requests", "operations", "reclaimRequested", "disconnected"], ["binding", "initializedRequestId", "readyRequestId", "heartbeatSequence", "lastHeartbeatAt"]) ||
		value.schemaVersion !== WORKER_PROTOCOL_SCHEMA_VERSION ||
		!Array.isArray(value.requests) ||
		!Array.isArray(value.operations)
	) return false;
	const state = value as unknown as WorkerProtocolStateV1;
	const phases: readonly WorkerProtocolPhaseV1[] = ["new", "initializing", "ready", "running", "cancelling", "terminal", "lost"];
	if (!phases.includes(state.phase as WorkerProtocolPhaseV1)) return false;
	if (state.binding !== undefined && !validateWorkerBindingV1(state.binding)) return false;
	if (state.initializedRequestId !== undefined && !isSafeRequestId(state.initializedRequestId)) return false;
	if (state.readyRequestId !== undefined && !isSafeRequestId(state.readyRequestId)) return false;
	if (state.heartbeatSequence !== undefined && !isSafeInteger(state.heartbeatSequence)) return false;
	if (state.lastHeartbeatAt !== undefined && !isCanonicalTimestamp(state.lastHeartbeatAt)) return false;
	if ((state.heartbeatSequence === undefined) !== (state.lastHeartbeatAt === undefined)) return false;
	if (typeof state.reclaimRequested !== "boolean" || typeof state.disconnected !== "boolean") return false;
	if (state.disconnected !== (state.phase === "lost")) return false;
	if (!state.reclaimRequested && state.phase === "terminal") return false;
	if (state.reclaimRequested && state.phase !== "terminal" && state.phase !== "lost") return false;

	const requestIds = new Set<string>();
	for (const request of state.requests) {
		if (!isRecord(request) || !hasExactKeys(request, ["requestId", "type", "responseCount"], ["operationId", "providerId", "taskId", "dispatchId", "attemptId", "bindingId", "bindingEpochId", "responseType"]) || !isSafeRequestId(request.requestId) || requestIds.has(request.requestId) || !WORKER_REQUEST_FRAME_TYPES.includes(request.type as WorkerRequestFrameTypeV1)) return false;
		if (!isSafeInteger(request.responseCount) || request.responseCount > 1) return false;
		if (request.responseCount === 0 && request.responseType !== undefined) return false;
		if (request.responseCount === 1 && (request.responseType === undefined || !WORKER_EVENT_FRAME_TYPES.includes(request.responseType as WorkerEventFrameTypeV1) || !responseTypeCompatible(request.type as WorkerRequestFrameTypeV1, request.responseType as WorkerEventFrameTypeV1))) return false;
		if (request.operationId !== undefined && !isSafeIdentifier(request.operationId)) return false;
		if (request.type === "execute" && request.operationId === undefined) return false;
		if (request.type !== "execute" && request.type !== "cancel" && request.operationId !== undefined) return false;
		for (const field of ["providerId", "taskId", "dispatchId", "attemptId", "bindingId", "bindingEpochId"] as const) {
			if (request[field] !== undefined && !isSafeIdentifier(request[field])) return false;
		}
		requestIds.add(request.requestId);
	}

	const initializeRequest = state.initializedRequestId === undefined ? undefined : state.requests.find((request) => request.requestId === state.initializedRequestId);
	if (state.readyRequestId !== undefined && state.readyRequestId !== state.initializedRequestId) return false;
	if (state.phase === "new" && (state.initializedRequestId !== undefined || state.readyRequestId !== undefined || state.requests.length > 0 || state.operations.length > 0)) return false;
	if (state.phase !== "new" && state.phase !== "lost" && (state.binding === undefined || state.initializedRequestId === undefined)) return false;
	if (state.initializedRequestId !== undefined && (initializeRequest === undefined || initializeRequest.type !== "initialize")) return false;
	if (state.readyRequestId !== undefined) {
		const readyRequest = state.requests.find((request) => request.requestId === state.readyRequestId);
		if (readyRequest === undefined || readyRequest.type !== "initialize" || readyRequest.responseCount !== 1 || readyRequest.responseType !== "ready") return false;
	}
	if (state.phase === "initializing" && (initializeRequest === undefined || state.readyRequestId !== undefined || initializeRequest.responseCount > 1 || initializeRequest.responseCount === 1 && initializeRequest.responseType !== "error")) return false;
	if (state.phase === "ready" || state.phase === "running" || state.phase === "cancelling" || state.phase === "terminal") {
		if (state.readyRequestId === undefined) return false;
	}

	const operationIds = new Set<string>();
	for (const operation of state.operations) {
		if (!isRecord(operation) || !hasExactKeys(operation, ["operationId", "requestId", "started", "terminal", "completed", "receiptReceived", "dataBytes", "dataEvents", "dataTruncated"]) || !isSafeIdentifier(operation.operationId) || !isSafeRequestId(operation.requestId) || operationIds.has(operation.operationId)) return false;
		if (!isSafeInteger(operation.dataBytes) || !isSafeInteger(operation.dataEvents) || operation.dataBytes > WORKER_PROTOCOL_MAX_OPERATION_DATA_BYTES || operation.dataEvents > WORKER_PROTOCOL_MAX_OPERATION_DATA_EVENTS) return false;
		if (typeof operation.started !== "boolean" || typeof operation.terminal !== "boolean" || typeof operation.completed !== "boolean" || typeof operation.receiptReceived !== "boolean" || typeof operation.dataTruncated !== "boolean") return false;
		if (operation.completed && (!operation.started || !operation.terminal)) return false;
		if (operation.receiptReceived && (!operation.terminal || !operation.completed)) return false;
		const request = state.requests.find((item) => item.requestId === operation.requestId);
		if (request === undefined || request.type !== "execute" || request.operationId !== operation.operationId) return false;
		if (operation.receiptReceived !== (request.responseType === "receipt")) return false;
		if (request.responseType === "receipt" && (!operation.terminal || !operation.completed || request.responseCount !== 1)) return false;
		if (request.responseType === "error" && (!operation.terminal || operation.completed || operation.receiptReceived)) return false;
		if (operation.terminal && !operation.completed && request.responseType !== "error") return false;
		operationIds.add(operation.operationId);
	}
	for (const request of state.requests) {
		if (request.type !== "execute") continue;
		const operation = state.operations.find((item) => item.operationId === request.operationId);
		if (operation === undefined) return false;
		if (request.responseType === "receipt" && !operation.receiptReceived) return false;
		if (request.responseType !== "receipt" && operation.receiptReceived) return false;
	}
	const activeOperations = state.operations.filter((operation) => isRecord(operation) && operation.terminal === false);
	if (activeOperations.length > 1) return false;
	const activeOperation = activeOperations[0];
	if (state.phase === "running" && (activeOperation === undefined || !activeOperation.started)) return false;
	if (state.phase === "ready" && activeOperation !== undefined && activeOperation.started) return false;
	return true;
	} catch {
		return false;
	}
}

function withState(state: WorkerProtocolStateV1, patch: {
	readonly phase?: WorkerProtocolPhaseV1;
	readonly binding?: WorkerBindingV1;
	readonly initializedRequestId?: string;
	readonly readyRequestId?: string;
	readonly heartbeatSequence?: number;
	readonly lastHeartbeatAt?: string;
	readonly requests?: readonly WorkerProtocolRequestStateV1[];
	readonly operations?: readonly WorkerProtocolOperationStateV1[];
	readonly reclaimRequested?: boolean;
	readonly disconnected?: boolean;
}): WorkerProtocolStateV1 {
	return freezeState({
		schemaVersion: WORKER_PROTOCOL_SCHEMA_VERSION,
		phase: patch.phase ?? state.phase,
		...(patch.binding === undefined ? (state.binding === undefined ? {} : { binding: state.binding }) : { binding: patch.binding }),
		...(patch.initializedRequestId === undefined ? (state.initializedRequestId === undefined ? {} : { initializedRequestId: state.initializedRequestId }) : { initializedRequestId: patch.initializedRequestId }),
		...(patch.readyRequestId === undefined ? (state.readyRequestId === undefined ? {} : { readyRequestId: state.readyRequestId }) : { readyRequestId: patch.readyRequestId }),
		...(patch.heartbeatSequence === undefined ? (state.heartbeatSequence === undefined ? {} : { heartbeatSequence: state.heartbeatSequence }) : { heartbeatSequence: patch.heartbeatSequence }),
		...(patch.lastHeartbeatAt === undefined ? (state.lastHeartbeatAt === undefined ? {} : { lastHeartbeatAt: state.lastHeartbeatAt }) : { lastHeartbeatAt: patch.lastHeartbeatAt }),
		requests: patch.requests ?? state.requests,
		operations: patch.operations ?? state.operations,
		reclaimRequested: patch.reclaimRequested ?? state.reclaimRequested,
		disconnected: patch.disconnected ?? state.disconnected,
	});
}

function findRequest(state: WorkerProtocolStateV1, requestId: string): WorkerProtocolRequestStateV1 | undefined {
	return state.requests.find((request) => request.requestId === requestId);
}

function findOperation(state: WorkerProtocolStateV1, operationId: string): WorkerProtocolOperationStateV1 | undefined {
	return state.operations.find((operation) => operation.operationId === operationId);
}

function operationBlocksNewExecute(state: WorkerProtocolStateV1, operation: WorkerProtocolOperationStateV1): boolean {
	if (operation.receiptReceived) return false;
	const request = findRequest(state, operation.requestId);
	return request?.responseType !== "error";
}

function addRequest(state: WorkerProtocolStateV1, requestId: string, type: WorkerRequestFrameTypeV1, operationId?: string, identity?: WorkerRequestIdentityV1): ProtocolResult<WorkerProtocolStateV1> {
	if (findRequest(state, requestId) !== undefined) return Result.err(conflict());
	return Result.ok(withState(state, { requests: [...state.requests, freezeRequest({ requestId, type, ...(operationId === undefined ? {} : { operationId }), ...(identity ?? {}), responseCount: 0 })] }));
}

function updateRequest(state: WorkerProtocolStateV1, requestId: string, responseType: WorkerEventFrameTypeV1): ProtocolResult<WorkerProtocolStateV1> {
	const request = findRequest(state, requestId);
	if (request === undefined || request.responseCount > 0) return Result.err(conflict());
	const requests = state.requests.map((item) => item.requestId === requestId ? freezeRequest({ ...item, responseCount: item.responseCount + 1, responseType }) : item);
	return Result.ok(withState(state, { requests }));
}

function updateOperation(state: WorkerProtocolStateV1, operationId: string, patch: Partial<WorkerProtocolOperationStateV1>): ProtocolResult<WorkerProtocolStateV1> {
	const operation = findOperation(state, operationId);
	if (operation === undefined) return Result.err(bindingInvalid());
	const operations = state.operations.map((item) => item.operationId === operationId ? freezeOperation({ ...item, ...patch }) : item);
	return Result.ok(withState(state, { operations }));
}

function bindingMatchesRequest(binding: WorkerBindingV1, request: SandboxOperationRequestV1): boolean {
	return (
		(request.providerId === undefined || request.providerId === binding.providerId) &&
		(request.bindingId === undefined || request.bindingId === binding.bindingId) &&
		(request.bindingEpochId === undefined || request.bindingEpochId === binding.bindingEpochId) &&
		(request.attemptId === undefined || request.attemptId === binding.attemptId)
	);
}

function bindingMatchesLease(binding: WorkerBindingV1, leaseBindingId: string): boolean {
	return binding.bindingId !== undefined && binding.bindingId === leaseBindingId;
}

function mutation(state: WorkerProtocolStateV1, frame: WorkerProtocolFrameV1, truncated = false): WorkerProtocolMutationV1 {
	return Object.freeze({ state, frame, idempotent: false, ...(truncated ? { truncated: true } : {}) });
}

export function applyWorkerRequestFrameV1(stateValue: WorkerProtocolStateV1, value: unknown): ProtocolResult<WorkerProtocolMutationV1> {
	if (!protocolStateValid(stateValue)) return Result.err(operationInvalid());
	const state = freezeState(stateValue);
	const checked = validateRequestResult(value);
	if (!checked.ok) return checked;
	const frame = checked.value;
	if (state.disconnected || state.phase === "lost") return Result.err(workerLost());
	if (frame.type === "initialize") {
		if (state.phase !== "new" || state.initializedRequestId !== undefined) return Result.err(conflict());
		if (state.binding !== undefined && !sameBinding(state.binding, frame.binding)) return Result.err(bindingInvalid());
		const added = addRequest(state, frame.requestId, frame.type);
		if (!added.ok) return added;
		const initialized = withState(added.value, { binding: cloneBinding(frame.binding), initializedRequestId: frame.requestId, phase: "initializing" });
		return Result.ok(mutation(initialized, frame));
	}
	if (state.binding === undefined || state.initializedRequestId === undefined) return Result.err(bindingInvalid());
	if (frame.type !== "execute" && frame.workerId !== state.binding.workerId) return Result.err(bindingInvalid());
	if (frame.type === "execute") {
		if (frame.workerId !== state.binding.workerId || !bindingMatchesRequest(state.binding, frame.request)) return Result.err(bindingInvalid());
		if (state.phase !== "ready" || state.reclaimRequested || state.operations.some((operation) => operationBlocksNewExecute(state, operation))) return Result.err(conflict());
		if (findOperation(state, frame.operationId) !== undefined) return Result.err(conflict());
		const added = addRequest(state, frame.requestId, frame.type, frame.operationId, requestIdentity(frame.request));
		if (!added.ok) return added;
		const operations = [...added.value.operations, freezeOperation({ operationId: frame.operationId, requestId: frame.requestId, started: false, terminal: false, completed: false, receiptReceived: false, dataBytes: 0, dataEvents: 0, dataTruncated: false })];
		return Result.ok(mutation(withState(added.value, { operations, phase: "ready" }), frame));
	}
	if (state.phase !== "ready" && state.phase !== "running" && state.phase !== "cancelling") return Result.err(conflict());
	if (frame.type === "credential.project" || frame.type === "credential.renew") {
		if (!bindingMatchesLease(state.binding, frame.lease.bindingId)) return Result.err(bindingInvalid());
		const added = addRequest(state, frame.requestId, frame.type);
		return added.ok ? Result.ok(mutation(added.value, frame)) : added;
	}
	if (frame.type === "credential.revoke") {
		if (!bindingMatchesLease(state.binding, frame.leaseRef.bindingId)) return Result.err(bindingInvalid());
		const added = addRequest(state, frame.requestId, frame.type);
		return added.ok ? Result.ok(mutation(added.value, frame)) : added;
	}
	if (frame.type === "cancel") {
		if (frame.operationId !== undefined) {
			const operation = findOperation(state, frame.operationId);
			if (operation === undefined || operation.terminal) return Result.err(conflict());
		}
		const added = addRequest(state, frame.requestId, frame.type, frame.operationId);
		return added.ok ? Result.ok(mutation(withState(added.value, { phase: "cancelling" }), frame)) : added;
	}
	if (frame.type === "reclaim") {
		if (state.reclaimRequested) return Result.err(conflict());
		const added = addRequest(state, frame.requestId, frame.type);
		return added.ok ? Result.ok(mutation(withState(added.value, { reclaimRequested: true, phase: "terminal" }), frame)) : added;
	}
	if (frame.type === "ping" && state.phase !== "ready" && state.phase !== "running") return Result.err(conflict());
	const added = addRequest(state, frame.requestId, frame.type);
	return added.ok ? Result.ok(mutation(added.value, frame)) : added;
}

function operationForFrame(state: WorkerProtocolStateV1, requestId: string, operationId: string): ProtocolResult<WorkerProtocolOperationStateV1> {
	const request = findRequest(state, requestId);
	if (request === undefined || request.type !== "execute" || request.operationId !== operationId) return Result.err(bindingInvalid());
	const operation = findOperation(state, operationId);
	return operation === undefined ? Result.err(bindingInvalid()) : Result.ok(operation);
}

function normalizeDataFrame(frame: Extract<WorkerEventFrameV1, { type: "operation.data" }>, operation: WorkerProtocolOperationStateV1): { readonly frame: WorkerEventFrameV1; readonly bytes: number; readonly truncated: boolean } {
	const remainingBytes = Math.max(0, WORKER_PROTOCOL_MAX_OPERATION_DATA_BYTES - operation.dataBytes);
	const chunk = truncateUtf8(frame.data, WORKER_PROTOCOL_MAX_DATA_CHUNK_BYTES);
	const total = truncateUtf8(chunk.value, remainingBytes);
	const truncated = frame.truncated === true || chunk.truncated || total.truncated;
	const data = total.value;
	const bytes = total.bytes;
	return {
		frame: Object.freeze({
			...frame,
			data,
			...(truncated ? { truncated: true } : {}),
		}),
		bytes,
		truncated,
	};
}

export function applyWorkerEventFrameV1(stateValue: WorkerProtocolStateV1, value: unknown): ProtocolResult<WorkerProtocolMutationV1> {
	if (!protocolStateValid(stateValue)) return Result.err(operationInvalid());
	const state = freezeState(stateValue);
	const checked = validateEventResult(value);
	if (!checked.ok) return checked;
	const frame = checked.value;
	if (state.disconnected || state.phase === "lost") return Result.err(workerLost());
	if (frame.type !== "ready" && frame.type !== "receipt") {
		if (state.binding === undefined || frame.workerId !== state.binding.workerId) return Result.err(bindingInvalid());
	}
	if (frame.type === "ready") {
		if (state.binding === undefined || frame.workerId !== state.binding.workerId || state.phase !== "initializing" || state.initializedRequestId !== frame.requestId) return Result.err(bindingInvalid());
		if (frame.providerId !== state.binding.providerId || frame.requestFingerprint !== state.binding.requestFingerprint) return Result.err(bindingInvalid());
		if (!sameStringSequence(frame.capabilities, state.binding.capabilitySummary)) return Result.err(bindingInvalid());
		const request = findRequest(state, frame.requestId);
		if (request === undefined || request.responseCount > 0) return Result.err(conflict());
		const updated = updateRequest(state, frame.requestId, frame.type);
		return updated.ok ? Result.ok(mutation(withState(updated.value, { readyRequestId: frame.requestId, phase: "ready" }), frame)) : updated;
	}
	if (frame.type === "heartbeat") {
		if (state.binding === undefined || state.phase === "new" || state.phase === "terminal") return Result.err(conflict());
		if (state.heartbeatSequence !== undefined && frame.sequence <= state.heartbeatSequence) return Result.err(conflict());
		if (state.lastHeartbeatAt !== undefined && frame.at < state.lastHeartbeatAt) return Result.err(conflict());
		const next = withState(state, { heartbeatSequence: frame.sequence, lastHeartbeatAt: frame.at });
		return Result.ok(mutation(next, frame));
	}
	if (frame.type === "error") {
		if (frame.requestId === undefined) return Result.ok(mutation(state, frame));
		const request = findRequest(state, frame.requestId);
		if (request === undefined || request.responseCount > 0) return Result.err(conflict());
		if (request.type === "execute" && request.operationId !== undefined) {
			const operation = findOperation(state, request.operationId);
			if (operation === undefined || operation.terminal) return Result.err(conflict());
			const updatedOperation = updateOperation(state, request.operationId, { terminal: true });
			if (!updatedOperation.ok) return updatedOperation;
			const updatedRequest = updateRequest(updatedOperation.value, frame.requestId, frame.type);
			return updatedRequest.ok ? Result.ok(mutation(withState(updatedRequest.value, { phase: "ready" }), frame)) : updatedRequest;
		}
		const updated = updateRequest(state, frame.requestId, frame.type);
		return updated.ok ? Result.ok(mutation(updated.value, frame)) : updated;
	}
	if (frame.type === "pong") {
		const request = findRequest(state, frame.requestId);
		if (request === undefined || request.type !== "ping" || request.responseCount > 0) return Result.err(conflict());
		const updated = updateRequest(state, frame.requestId, frame.type);
		return updated.ok ? Result.ok(mutation(updated.value, frame)) : updated;
	}
	if (frame.type === "operation.started") {
		const operationResult = operationForFrame(state, frame.requestId, frame.operationId);
		if (!operationResult.ok) return operationResult;
		if (operationResult.value.started || operationResult.value.terminal || (state.phase !== "ready" && state.phase !== "running")) return Result.err(conflict());
		const updated = updateOperation(state, frame.operationId, { started: true });
		return updated.ok ? Result.ok(mutation(withState(updated.value, { phase: "running" }), frame)) : updated;
	}
	if (frame.type === "operation.data") {
		const operationResult = operationForFrame(state, frame.requestId, frame.operationId);
		if (!operationResult.ok) return operationResult;
		const operation = operationResult.value;
		if (!operation.started) return Result.err(operationInvalid());
		if (operation.terminal) return Result.err(conflict());
		if (operation.dataEvents >= WORKER_PROTOCOL_MAX_OPERATION_DATA_EVENTS || operation.dataBytes >= WORKER_PROTOCOL_MAX_OPERATION_DATA_BYTES) return Result.err(conflict());
		const bounded = normalizeDataFrame(frame, operation);
		const updated = updateOperation(state, frame.operationId, {
			dataBytes: operation.dataBytes + bounded.bytes,
			dataEvents: Math.min(WORKER_PROTOCOL_MAX_OPERATION_DATA_EVENTS, operation.dataEvents + (operation.dataEvents >= WORKER_PROTOCOL_MAX_OPERATION_DATA_EVENTS ? 0 : 1)),
			dataTruncated: operation.dataTruncated || bounded.truncated,
		});
		return updated.ok ? Result.ok(mutation(updated.value, bounded.frame, bounded.truncated)) : updated;
	}
	if (frame.type === "operation.completed") {
		const operationResult = operationForFrame(state, frame.requestId, frame.operationId);
		if (!operationResult.ok) return operationResult;
		const operation = operationResult.value;
		if (!operation.started) return Result.err(operationInvalid());
		if (operation.terminal) return Result.err(conflict());
		const updated = updateOperation(state, frame.operationId, { terminal: true, completed: true });
		return updated.ok ? Result.ok(mutation(withState(updated.value, { phase: "ready" }), frame)) : updated;
	}
	const receiptFrame = frame;
	if (state.binding === undefined) return Result.err(bindingInvalid());
	const receiptCheck = validatePrivateWorkerReceipt(receiptFrame.receipt);
	if (!receiptCheck) return Result.err(receiptInvalid());
	const request = findRequest(state, receiptFrame.requestId);
	if (request === undefined || request.type !== "execute" || request.operationId === undefined || request.responseCount > 0) return Result.err(conflict());
	const operation = findOperation(state, receiptFrame.receipt.operationId);
	if (operation === undefined || operation.requestId !== receiptFrame.requestId) return Result.err(bindingInvalid());
	if (operation.receiptReceived) return Result.err(conflict());
	if (!operation.terminal) return Result.err(receiptInvalid());
	if (!receiptMatchesRequestAndBinding(receiptFrame.receipt, request, state.binding)) return Result.err(bindingInvalid());
	const updatedOperation = updateOperation(state, operation.operationId, { receiptReceived: true });
	if (!updatedOperation.ok) return updatedOperation;
	const updatedRequest = updateRequest(updatedOperation.value, receiptFrame.requestId, receiptFrame.type);
	return updatedRequest.ok ? Result.ok(mutation(withState(updatedRequest.value, { phase: "ready" }), receiptFrame)) : updatedRequest;
}

export function applyWorkerProtocolFrameV1(state: WorkerProtocolStateV1, direction: WorkerProtocolDirectionV1, value: unknown): ProtocolResult<WorkerProtocolMutationV1> {
	return direction === "host" ? applyWorkerRequestFrameV1(state, value) : applyWorkerEventFrameV1(state, value);
}

export const applyWorkerRequestFrame = applyWorkerRequestFrameV1;
export const applyWorkerEventFrame = applyWorkerEventFrameV1;
export const applyWorkerProtocolFrame = applyWorkerProtocolFrameV1;

export function applyWorkerRequestLineV1(state: WorkerProtocolStateV1, text: string): ProtocolResult<WorkerProtocolMutationV1> {
	const parsed = parseWorkerFrameV1(text);
	if (!parsed.ok) return parsed;
	return applyWorkerRequestFrameV1(state, parsed.value);
}

export function applyWorkerEventLineV1(state: WorkerProtocolStateV1, text: string): ProtocolResult<WorkerProtocolMutationV1> {
	const parsed = parseWorkerFrameV1(text);
	if (!parsed.ok) return parsed;
	return applyWorkerEventFrameV1(state, parsed.value);
}

export function disconnectWorkerProtocolV1(stateValue: WorkerProtocolStateV1): WorkerProtocolStateV1 {
	if (!protocolStateValid(stateValue)) return freezeState({ schemaVersion: WORKER_PROTOCOL_SCHEMA_VERSION, phase: "lost", requests: [], operations: [], reclaimRequested: false, disconnected: true });
	return withState(stateValue, { phase: "lost", disconnected: true });
}

export function applyWorkerDisconnectV1(stateValue: WorkerProtocolStateV1): ProtocolResult<WorkerProtocolMutationV1> {
	if (!protocolStateValid(stateValue)) return Result.err(workerLost());
	if (stateValue.disconnected || stateValue.phase === "lost") return Result.err(workerLost());
	const state = disconnectWorkerProtocolV1(stateValue);
	return Result.ok(Object.freeze({ state, idempotent: false }));
}

export class WorkerProtocolSessionV1 {
	private currentState: WorkerProtocolStateV1;

	constructor(binding?: WorkerBindingV1) {
		this.currentState = createWorkerProtocolStateV1(binding);
	}

	get state(): WorkerProtocolStateV1 {
		return this.currentState;
	}

	receiveHostFrame(value: unknown): ProtocolResult<WorkerProtocolMutationV1> {
		const result = applyWorkerRequestFrameV1(this.currentState, value);
		if (result.ok) this.currentState = result.value.state;
		return result;
	}

	receiveWorkerFrame(value: unknown): ProtocolResult<WorkerProtocolMutationV1> {
		const result = applyWorkerEventFrameV1(this.currentState, value);
		if (result.ok) this.currentState = result.value.state;
		return result;
	}

	acceptHostFrame(value: unknown): ProtocolResult<WorkerProtocolMutationV1> {
		return this.receiveHostFrame(value);
	}

	acceptWorkerFrame(value: unknown): ProtocolResult<WorkerProtocolMutationV1> {
		return this.receiveWorkerFrame(value);
	}

	disconnect(): FoundationError {
		this.currentState = disconnectWorkerProtocolV1(this.currentState);
		return workerLost();
	}
}

export const WorkerProtocolState = WorkerProtocolSessionV1;
export const WorkerProtocolSession = WorkerProtocolSessionV1;
