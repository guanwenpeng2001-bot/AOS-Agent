/**
 * Remote-neutral operation contract.
 *
 * This is a control-plane contract only. It carries operation identity,
 * cancellation, deadlines, leases, and safe artifact references without
 * choosing a transport, provider, worker, or persistence mechanism. A
 * Run/Policy/Binding/Audit/Receipt remains authoritative for the associated
 * Agent execution; this operation receipt is only the provider boundary.
 *
 * Task Lease correlation: an operation may carry an optional safe
 * `TaskLeaseReference` (leaseId/grantId/bindingId only). Before start an
 * injected read-only verifier must confirm the referenced Task Credential
 * lease is live and that its binding, scope, and target correlate with the
 * request binding references; the verification never calls the credential
 * provider. The operation identity, deadline, cancellation, heartbeat, and
 * side-effect state stay fully independent of the Task Lease identity,
 * sequence, expiry, and terminal status: task lease expiry never terminates
 * an operation, operation heartbeats never advance the task lease sequence,
 * and a task revoke never fakes an operation terminal.
 *
 * Erasable TypeScript only (no enums, namespaces, or parameter properties).
 */

import type { RunId, RunStatus, RunTerminalStatus, SessionId } from "../session/run-lifecycle.ts";

export const REMOTE_OPERATION_SCHEMA_VERSION = 1 as const;
export const REMOTE_OPERATION_CUSTOM_TYPE = "remote.operation" as const;
export const REMOTE_OPERATION_LEDGER_SCHEMA_VERSION = 1 as const;

/** The operation states mirror the existing Run state vocabulary. */
export const REMOTE_OPERATION_STATUSES = ["accepted", "running", "completed", "failed", "cancelled"] as const;
export type RemoteOperationStatus = (typeof REMOTE_OPERATION_STATUSES)[number];
const REMOTE_OPERATION_TERMINAL_STATUSES = ["completed", "failed", "cancelled"] as const;
export type RemoteOperationTerminalStatus = RunTerminalStatus;
export type RemoteOperationId = string;
export type OperationId = RemoteOperationId;
export type RemoteOperationLeaseId = string;

/**
 * Error categories are deliberately small. Unknown provider failures are
 * mapped to `side-effect-unknown` so callers never retry an unproven result.
 */
export const REMOTE_OPERATION_ERROR_CATEGORIES = [
	"transient",
	"rejected",
	"invalid",
	"side-effect-unknown",
	"cancelled",
	"deadline",
] as const;
export type RemoteOperationErrorCategory = (typeof REMOTE_OPERATION_ERROR_CATEGORIES)[number];
export type RemoteOperationErrorCode = RemoteOperationErrorCategory;

export const REMOTE_OPERATION_SIDE_EFFECT_STATES = ["none", "associated", "unknown"] as const;
export type RemoteOperationSideEffectState = (typeof REMOTE_OPERATION_SIDE_EFFECT_STATES)[number];

export const REMOTE_ARTIFACT_KINDS = ["input", "output", "log", "checkpoint"] as const;
export type RemoteArtifactKind = (typeof REMOTE_ARTIFACT_KINDS)[number];

const SAFE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SAFE_ARTIFACT_DIGEST_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SAFE_MEDIA_TYPE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}$/;
const SAFE_RECEIPT_INPUT_ERROR_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
/** Scope fingerprints use `sha256:` plus 64 lowercase hex characters. */
const TASK_LEASE_SCOPE_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;

/** A portable reference; it contains no local path, URL, payload, or secret. */
export interface RemoteArtifactReference {
	readonly id: string;
	readonly kind: RemoteArtifactKind;
	readonly digest?: string;
	readonly sizeBytes?: number;
	readonly mediaType?: string;
}

/** Short aliases for callers that use the wording from the remote plan. */
export type ArtifactReference = RemoteArtifactReference;
export type RemoteArtifactRef = RemoteArtifactReference;

export interface RemoteOperationLease {
	readonly leaseId: RemoteOperationLeaseId;
	readonly expiresAt: string;
}

/**
 * Optional Task Credential Lease correlation. Only the three stable
 * identities cross the provider boundary; scope, target, and binding facts
 * stay inside the store and are only checked by the injected read-only
 * verifier before start. The reference never carries an expiry, a sequence,
 * or a status, so it cannot drive operation deadline, cancel, or heartbeat
 * behavior.
 */
export interface TaskLeaseReference {
	readonly leaseId: string;
	readonly grantId: string;
	readonly bindingId: string;
}

/**
 * The safe facts returned by the injected Task Lease verifier and recorded
 * on the terminal receipt. `status` is the live status observed at start
 * (`active` or `renewing`); unknown, expired, revoked, settled, and
 * quarantined (`revocation_unknown`) leases never produce a result, so a
 * task revoke can never manufacture an operation terminal and a
 * `revocation_unknown` lease coexists with an operation `side-effect-unknown`
 * outcome without faking one.
 */
export interface TaskLeaseVerificationResult {
	readonly status: "active" | "renewing";
	readonly scopeDigest: string;
	readonly targetId: string;
}

export interface RemoteOperationHeartbeat {
	readonly operationId: RemoteOperationId;
	readonly leaseId: RemoteOperationLeaseId;
	readonly sequence: number;
	readonly sentAt: string;
}

/**
 * Only stable identities cross the provider boundary. Full Run, Policy,
 * Capability, and ModelBroker objects remain owned by their existing layers.
 */
export interface RemoteOperationBindingRefs {
	readonly runId?: RunId;
	readonly sessionId?: SessionId;
	readonly capabilityBindingId?: string;
	readonly modelBindingId?: string;
	readonly policyBindingId?: string;
}

export interface RemoteOperationRequest extends RemoteOperationBindingRefs {
	readonly operationId: RemoteOperationId;
	/** Inclusive operation deadline. A missing deadline means no operation deadline. */
	readonly deadlineAt?: string;
	/** A lease is optional for local execution and required by lease-aware providers. */
	readonly lease?: RemoteOperationLease;
	/**
	 * Optional Task Lease correlation. When present, the injected
	 * `taskLeaseVerifier` must confirm a live lease and binding/scope/target
	 * correlation before the operation starts; a credential-dependent
	 * operation without a verifier fails closed as `invalid`.
	 */
	readonly taskLease?: TaskLeaseReference;
	/** Input artifacts are references only; bytes are exchanged by a provider-specific mechanism. */
	readonly artifactRefs?: ReadonlyArray<RemoteArtifactReference>;
}

export interface RemoteOperationResult {
	readonly artifactRefs?: ReadonlyArray<RemoteArtifactReference>;
	readonly sideEffects?: RemoteOperationSideEffectState;
}

export interface RemoteOperationErrorInfo {
	readonly category: RemoteOperationErrorCategory;
	readonly code: RemoteOperationErrorCode;
	readonly retryable: boolean;
	readonly sideEffects: RemoteOperationSideEffectState;
}

export interface RemoteOperationReceipt extends RemoteOperationBindingRefs {
	readonly schemaVersion: typeof REMOTE_OPERATION_SCHEMA_VERSION;
	readonly operationId: RemoteOperationId;
	readonly status: RemoteOperationTerminalStatus;
	readonly startedAt?: string;
	readonly endedAt: string;
	readonly artifactRefs: ReadonlyArray<RemoteArtifactReference>;
	readonly sideEffects: RemoteOperationSideEffectState;
	readonly error?: RemoteOperationErrorInfo;
	readonly lease?: RemoteOperationLease;
	readonly heartbeatSequence?: number;
	/**
	 * Task Lease correlation carried from a safe request; present whenever
	 * the request carried a valid reference. Correlation evidence only, never
	 * a second lease or a Run/Policy authority.
	 */
	readonly taskLease?: TaskLeaseReference;
	/**
	 * The live lease facts confirmed by the injected read-only verifier at
	 * start; only ever present together with `taskLease`. Terminal and
	 * quarantined (`revocation_unknown`) leases never appear here.
	 */
	readonly taskLeaseVerified?: TaskLeaseVerificationResult;
}

export interface RemoteOperationLedgerSession {
	getSessionId(): SessionId;
	appendCustomEntry(customType: string, data?: unknown): string;
}

export interface RemoteOperationLedger {
	record(receipt: RemoteOperationReceipt): void;
}

export interface RemoteOperationExecutionContext {
	readonly operationId: RemoteOperationId;
	readonly signal: AbortSignal;
	readonly deadlineAt?: string;
	readonly lease?: RemoteOperationLease;
	/** Providers must call this before exposing a side effect. */
	recordSideEffect(artifacts?: ReadonlyArray<RemoteArtifactReference>): void;
}

/**
 * The provider and transport contracts intentionally share one shape. A
 * transport adapter can therefore be tested in-process without introducing a
 * wire format or requiring the Agent loop to know which boundary it crossed.
 */
export interface RemoteOperationInvoker {
	execute(request: RemoteOperationRequest, context: RemoteOperationExecutionContext): Promise<RemoteOperationResult>;
	cancel(operationId: RemoteOperationId): Promise<void>;
	heartbeat(heartbeat: RemoteOperationHeartbeat): Promise<RemoteOperationLease>;
}

export interface RemoteOperationProvider extends RemoteOperationInvoker {
	readonly id: string;
}

export type RemoteOperationTransport = RemoteOperationInvoker;

export interface RemoteOperationStartOptions {
	readonly signal?: AbortSignal;
	/** Used for deterministic receipts and contract tests. */
	readonly now?: () => string;
	/** Optional durable sink shared by local and future remote providers. */
	readonly ledger?: RemoteOperationLedger;
	/** Receives ledger failures without exposing provider details to callers. */
	readonly onLedgerError?: (error: unknown) => void;
	/**
	 * Read-only Task Lease safety check for credential-dependent operations.
	 * It must not call the credential provider and must not append or mutate
	 * anything; the Host wires a read-only store lookup behind it. It must
	 * confirm the referenced lease is live (`active` or `renewing`, not
	 * expired) and that its binding, scope, and target correlate with the
	 * request's binding references. Returning `undefined` or throwing fails
	 * the operation closed as `invalid` before any provider execution.
	 */
	readonly taskLeaseVerifier?: RemoteOperationTaskLeaseVerifier;
}

/**
 * Injected read-only Task Lease verifier used before start. The check runs
 * exactly once per operation, before the provider is invoked, and never
 * participates in cancellation, deadlines, or heartbeats: those stay driven
 * by the operation's own identity, deadline, and lease only.
 */
export type RemoteOperationTaskLeaseVerifier = (
	reference: TaskLeaseReference,
	request: RemoteOperationRequest,
) => TaskLeaseVerificationResult | undefined;

export interface RemoteOperationHandle {
	readonly operationId: RemoteOperationId;
	readonly receipt: Promise<RemoteOperationReceipt>;
	/** Cancellation is idempotent and does not create a second terminal receipt. */
	cancel(): Promise<void>;
	/** Renew the current lease; calling this without a lease is rejected. */
	heartbeat(): Promise<RemoteOperationLease>;
}

/** An exception carrying a stable operation error category and no raw provider detail. */
export class RemoteOperationError extends Error implements RemoteOperationErrorInfo {
	readonly category: RemoteOperationErrorCategory;
	readonly code: RemoteOperationErrorCode;
	readonly retryable: boolean;
	readonly sideEffects: RemoteOperationSideEffectState;

	constructor(
		category: RemoteOperationErrorCategory,
		options: {
			readonly retryable?: boolean;
			readonly sideEffects?: RemoteOperationSideEffectState;
		} = {},
	) {
		super(category);
		this.name = "RemoteOperationError";
		this.category = category;
		this.code = category;
		this.sideEffects = options.sideEffects ?? (category === "side-effect-unknown" ? "unknown" : "none");
		this.retryable =
			category === "transient" &&
			this.sideEffects === "none" &&
			(options.retryable ?? true);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSafeIdentifier(value: unknown): value is string {
	return typeof value === "string" && SAFE_IDENTIFIER_PATTERN.test(value) && !value.includes("//");
}

function isCanonicalTimestamp(value: unknown): value is string {
	if (typeof value !== "string" || !TIMESTAMP_PATTERN.test(value)) return false;
	const parsed = new Date(value);
	return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function isSafeArtifactReference(value: unknown): value is RemoteArtifactReference {
	if (
		!isRecord(value) ||
		!isSafeIdentifier(value.id) ||
		!REMOTE_ARTIFACT_KINDS.includes(value.kind as RemoteArtifactKind)
	)
		return false;
	if (
		value.digest !== undefined &&
		(typeof value.digest !== "string" || !SAFE_ARTIFACT_DIGEST_PATTERN.test(value.digest))
	)
		return false;
	if (
		value.sizeBytes !== undefined &&
		(typeof value.sizeBytes !== "number" || !Number.isSafeInteger(value.sizeBytes) || value.sizeBytes < 0)
	)
		return false;
	if (
		value.mediaType !== undefined &&
		(typeof value.mediaType !== "string" || !SAFE_MEDIA_TYPE_PATTERN.test(value.mediaType))
	)
		return false;
	return Object.keys(value).every(
		(key) => key === "id" || key === "kind" || key === "digest" || key === "sizeBytes" || key === "mediaType",
	);
}

/** Public guard for the portable artifact reference allowlist. */
export const isRemoteArtifactReference = isSafeArtifactReference;

function isSafeArtifactReferenceList(value: unknown): value is ReadonlyArray<RemoteArtifactReference> {
	return Array.isArray(value) && value.every(isSafeArtifactReference);
}

function cloneArtifactReference(value: RemoteArtifactReference): RemoteArtifactReference {
	return {
		id: value.id,
		kind: value.kind,
		...(value.digest === undefined ? {} : { digest: value.digest }),
		...(value.sizeBytes === undefined ? {} : { sizeBytes: value.sizeBytes }),
		...(value.mediaType === undefined ? {} : { mediaType: value.mediaType }),
	};
}

function cloneLease(value: RemoteOperationLease): RemoteOperationLease {
	return { leaseId: value.leaseId, expiresAt: value.expiresAt };
}

/** Public guard for the safe Task Lease reference allowlist. */
export function isTaskLeaseReference(value: unknown): value is TaskLeaseReference {
	return (
		isRecord(value) &&
		isSafeIdentifier(value.leaseId) &&
		isSafeIdentifier(value.grantId) &&
		isSafeIdentifier(value.bindingId) &&
		Object.keys(value).every((key) => key === "leaseId" || key === "grantId" || key === "bindingId")
	);
}

function isTaskLeaseVerificationResult(value: unknown): value is TaskLeaseVerificationResult {
	return (
		isRecord(value) &&
		(value.status === "active" || value.status === "renewing") &&
		typeof value.scopeDigest === "string" &&
		TASK_LEASE_SCOPE_DIGEST_PATTERN.test(value.scopeDigest) &&
		isSafeIdentifier(value.targetId) &&
		Object.keys(value).every((key) => key === "status" || key === "scopeDigest" || key === "targetId")
	);
}

function cloneTaskLeaseReference(value: TaskLeaseReference): TaskLeaseReference {
	return { leaseId: value.leaseId, grantId: value.grantId, bindingId: value.bindingId };
}

function cloneTaskLeaseVerificationResult(value: TaskLeaseVerificationResult): TaskLeaseVerificationResult {
	return { status: value.status, scopeDigest: value.scopeDigest, targetId: value.targetId };
}

function safeBindingRefs(request: unknown): RemoteOperationBindingRefs {
	if (!isRecord(request)) return {};
	return {
		...(isSafeIdentifier(request.runId) ? { runId: request.runId } : {}),
		...(isSafeIdentifier(request.sessionId) ? { sessionId: request.sessionId } : {}),
		...(isSafeIdentifier(request.capabilityBindingId) ? { capabilityBindingId: request.capabilityBindingId } : {}),
		...(isSafeIdentifier(request.modelBindingId) ? { modelBindingId: request.modelBindingId } : {}),
		...(isSafeIdentifier(request.policyBindingId) ? { policyBindingId: request.policyBindingId } : {}),
	};
}

function validateLease(value: unknown): value is RemoteOperationLease {
	return (
		isRecord(value) &&
		isSafeIdentifier(value.leaseId) &&
		isCanonicalTimestamp(value.expiresAt) &&
		Object.keys(value).every((key) => key === "leaseId" || key === "expiresAt")
	);
}

function safeNow(now: (() => string) | undefined): string {
	try {
		const value = now?.();
		if (value !== undefined && isCanonicalTimestamp(value)) return value;
	} catch {
		// The receipt clock is an implementation detail; use a canonical fallback.
	}
	return new Date().toISOString();
}

function safeDateMs(value: string): number {
	return Date.parse(value);
}

function mergeSideEffectState(
	current: RemoteOperationSideEffectState,
	requested: RemoteOperationSideEffectState | undefined,
): RemoteOperationSideEffectState {
	if (requested === "unknown" || current === "unknown") return "unknown";
	if (requested === "associated" || current === "associated") return "associated";
	return "none";
}

function errorInfo(
	category: RemoteOperationErrorCategory,
	operationSideEffects: RemoteOperationSideEffectState,
	providerError?: RemoteOperationErrorInfo,
): RemoteOperationErrorInfo {
	const sideEffects = mergeSideEffectState(operationSideEffects, providerError?.sideEffects);
	if (category === "side-effect-unknown") {
		return { category, code: category, retryable: false, sideEffects: "unknown" };
	}
	if (sideEffects === "unknown" && category !== "cancelled" && category !== "deadline") {
		return { category: "side-effect-unknown", code: "side-effect-unknown", retryable: false, sideEffects };
	}
	if (sideEffects !== "none" && (category === "cancelled" || category === "deadline")) {
		return { category: "side-effect-unknown", code: "side-effect-unknown", retryable: false, sideEffects: "unknown" };
	}
	return {
		category,
		code: category,
		retryable: category === "transient" && sideEffects === "none" && (providerError?.retryable ?? true),
		sideEffects,
	};
}

function errorCategory(value: unknown): RemoteOperationErrorCategory | undefined {
	if (value instanceof RemoteOperationError) return value.category;
	if (!isRecord(value) || typeof value.category !== "string") return undefined;
	return (REMOTE_OPERATION_ERROR_CATEGORIES as readonly string[]).includes(value.category)
		? (value.category as RemoteOperationErrorCategory)
		: undefined;
}

function errorInfoFromUnknown(value: unknown, sideEffects: RemoteOperationSideEffectState): RemoteOperationErrorInfo {
	if (value instanceof RemoteOperationError) return errorInfo(value.category, sideEffects, value);
	if (isRecord(value) && errorCategory(value) !== undefined) {
		const category = errorCategory(value) as RemoteOperationErrorCategory;
		const providerError: RemoteOperationErrorInfo = {
			category,
			code: category,
			retryable: value.retryable === true && category === "transient",
			sideEffects: value.sideEffects === "associated" || value.sideEffects === "unknown" ? value.sideEffects : "none",
		};
		return errorInfo(category, sideEffects, providerError);
	}
	return errorInfo("side-effect-unknown", "unknown");
}

function invalidRequestError(): RemoteOperationErrorInfo {
	return { category: "invalid", code: "invalid", retryable: false, sideEffects: "none" };
}

/**
 * Run the injected read-only Task Lease check exactly once, fail-closed.
 * A thrown verifier or any result that is not the exact safe verified
 * snapshot counts as a failed verification; the provider is never touched.
 */
function verifyTaskLease(
	verifier: RemoteOperationTaskLeaseVerifier,
	reference: TaskLeaseReference,
	request: RemoteOperationRequest,
): TaskLeaseVerificationResult | undefined {
	try {
		const result = verifier(reference, request);
		return isTaskLeaseVerificationResult(result) ? cloneTaskLeaseVerificationResult(result) : undefined;
	} catch {
		return undefined;
	}
}

function isRemoteOperationErrorInfo(value: unknown): value is RemoteOperationErrorInfo {
	return (
		isRecord(value) &&
		REMOTE_OPERATION_ERROR_CATEGORIES.includes(value.category as RemoteOperationErrorCategory) &&
		value.code === value.category &&
		typeof value.retryable === "boolean" &&
		REMOTE_OPERATION_SIDE_EFFECT_STATES.includes(value.sideEffects as RemoteOperationSideEffectState) &&
		Object.keys(value).every(
			(key) => key === "category" || key === "code" || key === "retryable" || key === "sideEffects",
		)
	);
}

/** Return true when a value has the exact safe request shape. */
export function isRemoteOperationRequest(value: unknown): value is RemoteOperationRequest {
	if (!isRecord(value) || !isSafeIdentifier(value.operationId)) return false;
	if (value.runId !== undefined && !isSafeIdentifier(value.runId)) return false;
	if (value.sessionId !== undefined && !isSafeIdentifier(value.sessionId)) return false;
	if (value.capabilityBindingId !== undefined && !isSafeIdentifier(value.capabilityBindingId)) return false;
	if (value.modelBindingId !== undefined && !isSafeIdentifier(value.modelBindingId)) return false;
	if (value.policyBindingId !== undefined && !isSafeIdentifier(value.policyBindingId)) return false;
	if (value.deadlineAt !== undefined && !isCanonicalTimestamp(value.deadlineAt)) return false;
	if (value.lease !== undefined && !validateLease(value.lease)) return false;
	if (value.taskLease !== undefined && !isTaskLeaseReference(value.taskLease)) return false;
	if (value.artifactRefs !== undefined && !isSafeArtifactReferenceList(value.artifactRefs)) return false;
	return Object.keys(value).every(
		(key) =>
			key === "operationId" ||
			key === "runId" ||
			key === "sessionId" ||
			key === "capabilityBindingId" ||
			key === "modelBindingId" ||
			key === "policyBindingId" ||
			key === "deadlineAt" ||
			key === "lease" ||
			key === "taskLease" ||
			key === "artifactRefs",
	);
}

function cloneRequest(request: RemoteOperationRequest): RemoteOperationRequest {
	return {
		operationId: request.operationId,
		...(request.runId === undefined ? {} : { runId: request.runId }),
		...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
		...(request.capabilityBindingId === undefined ? {} : { capabilityBindingId: request.capabilityBindingId }),
		...(request.modelBindingId === undefined ? {} : { modelBindingId: request.modelBindingId }),
		...(request.policyBindingId === undefined ? {} : { policyBindingId: request.policyBindingId }),
		...(request.deadlineAt === undefined ? {} : { deadlineAt: request.deadlineAt }),
		...(request.lease === undefined ? {} : { lease: cloneLease(request.lease) }),
		...(request.taskLease === undefined ? {} : { taskLease: cloneTaskLeaseReference(request.taskLease) }),
		...(request.artifactRefs === undefined ? {} : { artifactRefs: request.artifactRefs.map(cloneArtifactReference) }),
	};
}

/** Return true when a value is the safe terminal receipt emitted by an operation. */
export function isRemoteOperationReceipt(value: unknown): value is RemoteOperationReceipt {
	if (!isRecord(value) || value.schemaVersion !== REMOTE_OPERATION_SCHEMA_VERSION) return false;
	if (
		!isSafeIdentifier(value.operationId) ||
		!REMOTE_OPERATION_TERMINAL_STATUSES.includes(value.status as RemoteOperationTerminalStatus)
	)
		return false;
	if (value.startedAt !== undefined && !isCanonicalTimestamp(value.startedAt)) return false;
	if (!isCanonicalTimestamp(value.endedAt) || !isSafeArtifactReferenceList(value.artifactRefs)) return false;
	if (!REMOTE_OPERATION_SIDE_EFFECT_STATES.includes(value.sideEffects as RemoteOperationSideEffectState)) return false;
	if (value.error !== undefined && !isRemoteOperationErrorInfo(value.error)) return false;
	if (value.lease !== undefined && !validateLease(value.lease)) return false;
	if (value.taskLease !== undefined && !isTaskLeaseReference(value.taskLease)) return false;
	if (value.taskLeaseVerified !== undefined && !isTaskLeaseVerificationResult(value.taskLeaseVerified)) return false;
	if (value.taskLeaseVerified !== undefined && value.taskLease === undefined) return false;
	if (
		value.heartbeatSequence !== undefined &&
		(typeof value.heartbeatSequence !== "number" ||
			!Number.isSafeInteger(value.heartbeatSequence) ||
			value.heartbeatSequence < 1)
	)
		return false;
	if (value.runId !== undefined && !isSafeIdentifier(value.runId)) return false;
	if (value.sessionId !== undefined && !isSafeIdentifier(value.sessionId)) return false;
	if (value.capabilityBindingId !== undefined && !isSafeIdentifier(value.capabilityBindingId)) return false;
	if (value.modelBindingId !== undefined && !isSafeIdentifier(value.modelBindingId)) return false;
	if (value.policyBindingId !== undefined && !isSafeIdentifier(value.policyBindingId)) return false;
	return Object.keys(value).every(
		(key) =>
			key === "schemaVersion" ||
			key === "operationId" ||
			key === "status" ||
			key === "runId" ||
			key === "sessionId" ||
			key === "capabilityBindingId" ||
			key === "modelBindingId" ||
			key === "policyBindingId" ||
			key === "startedAt" ||
			key === "endedAt" ||
			key === "artifactRefs" ||
			key === "sideEffects" ||
			key === "error" ||
			key === "lease" ||
			key === "heartbeatSequence" ||
			key === "taskLease" ||
			key === "taskLeaseVerified",
	);
}

function addArtifacts(
	target: Map<string, RemoteArtifactReference>,
	artifacts: ReadonlyArray<RemoteArtifactReference> | undefined,
): void {
	if (artifacts === undefined) return;
	for (const artifact of artifacts) target.set(`${artifact.kind}:${artifact.id}`, cloneArtifactReference(artifact));
}

function timerFor(timestamp: string, now: string): number {
	return Math.max(0, safeDateMs(timestamp) - safeDateMs(now));
}

/**
 * Start one operation using either a local or remote-neutral invoker. The
 * returned receipt always settles to a terminal status; expected provider
 * failures are never exposed as unclassified exceptions.
 */
export function startRemoteOperation(
	invoker: RemoteOperationInvoker,
	request: RemoteOperationRequest,
	options: RemoteOperationStartOptions = {},
): RemoteOperationHandle {
	const operationId = isSafeIdentifier(request?.operationId) ? request.operationId : "invalid-operation";
	const controller = new AbortController();
	let startedAt: string | undefined;
	let ended = false;
	let sideEffects: RemoteOperationSideEffectState = "none";
	let cancellation: "cancelled" | "deadline" | undefined;
	let cancellationFailed = false;
	let providerStarted = false;
	let lease = request?.lease === undefined || !validateLease(request.lease) ? undefined : cloneLease(request.lease);
	let taskLeaseVerified: TaskLeaseVerificationResult | undefined;
	let heartbeatSequence = 0;
	const artifacts = new Map<string, RemoteArtifactReference>();
	let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
	let leaseTimer: ReturnType<typeof setTimeout> | undefined;
	let cancelPromise: Promise<void> | undefined;

	const setTimer = (callback: () => void, delay: number): ReturnType<typeof setTimeout> => {
		const timer = setTimeout(callback, delay);
		if (typeof timer === "object" && "unref" in timer && typeof timer.unref === "function") timer.unref();
		return timer;
	};

	const requestCancellation = (kind: "cancelled" | "deadline"): Promise<void> => {
		if (ended) return Promise.resolve();
		if (cancellation === undefined || kind === "deadline") cancellation = kind;
		if (!controller.signal.aborted) controller.abort();
		if (!providerStarted || cancelPromise !== undefined) return cancelPromise ?? Promise.resolve();
		cancelPromise = invoker.cancel(operationId).catch(() => {
			cancellationFailed = true;
		});
		return cancelPromise;
	};

	const context: RemoteOperationExecutionContext = {
		operationId,
		signal: controller.signal,
		get deadlineAt() {
			return request.deadlineAt;
		},
		get lease() {
			return lease;
		},
		recordSideEffect: (reportedArtifacts) => {
			if (controller.signal.aborted || cancellation !== undefined) {
				sideEffects = "unknown";
			} else if (reportedArtifacts !== undefined && !isSafeArtifactReferenceList(reportedArtifacts)) {
				sideEffects = "unknown";
			} else {
				sideEffects = mergeSideEffectState(sideEffects, "associated");
			}
			if (reportedArtifacts === undefined || isSafeArtifactReferenceList(reportedArtifacts))
				addArtifacts(artifacts, reportedArtifacts);
		},
	};

	const complete = (
		result: RemoteOperationResult | undefined,
		error: RemoteOperationErrorInfo | undefined,
	): RemoteOperationReceipt => {
		if (ended) {
			return {
				schemaVersion: REMOTE_OPERATION_SCHEMA_VERSION,
				operationId,
				status: "failed",
				endedAt: safeNow(options.now),
				artifactRefs: [...artifacts.values()],
				sideEffects,
				error: errorInfo("side-effect-unknown", "unknown"),
			};
		}
		ended = true;
		if (result !== undefined) {
			if (result.artifactRefs !== undefined && !isSafeArtifactReferenceList(result.artifactRefs)) {
				sideEffects = "unknown";
			} else {
				addArtifacts(artifacts, result.artifactRefs);
				const resultSideEffects = result.sideEffects === undefined || REMOTE_OPERATION_SIDE_EFFECT_STATES.includes(result.sideEffects)
					? result.sideEffects
					: "unknown";
				sideEffects = mergeSideEffectState(sideEffects, resultSideEffects);
				if (result.artifactRefs !== undefined && result.artifactRefs.length > 0 && sideEffects === "none") sideEffects = "associated";
			}
		}
		const finalError = error === undefined
			? sideEffects === "unknown"
				? errorInfo("side-effect-unknown", sideEffects)
				: undefined
			: errorInfo(error.category, sideEffects, error);
		const finalStatus: RemoteOperationTerminalStatus =
			finalError?.category === "cancelled" || finalError?.category === "deadline" ? "cancelled" : finalError === undefined ? "completed" : "failed";
		const receipt: RemoteOperationReceipt = {
			schemaVersion: REMOTE_OPERATION_SCHEMA_VERSION,
			operationId,
			status: finalStatus,
			...safeBindingRefs(request),
			...(startedAt === undefined ? {} : { startedAt }),
			endedAt: safeNow(options.now),
			artifactRefs: [...artifacts.values()],
			sideEffects: finalError?.sideEffects ?? sideEffects,
			...(finalError === undefined ? {} : { error: finalError }),
			...(lease === undefined ? {} : { lease: cloneLease(lease) }),
			...(heartbeatSequence === 0 ? {} : { heartbeatSequence }),
			...(isRecord(request) && isTaskLeaseReference(request.taskLease)
				? { taskLease: cloneTaskLeaseReference(request.taskLease) }
				: {}),
			...(taskLeaseVerified === undefined
				? {}
				: { taskLeaseVerified: cloneTaskLeaseVerificationResult(taskLeaseVerified) }),
		};
		const frozenReceipt = Object.freeze(receipt);
		if (options.ledger !== undefined) {
			try {
				options.ledger.record(frozenReceipt);
			} catch (ledgerError) {
				try {
					options.onLedgerError?.(ledgerError);
				} catch {
					// A ledger observer must not change the provider receipt.
				}
			}
		}
		return frozenReceipt;
	};

	const run = async (): Promise<RemoteOperationReceipt> => {
		if (!isRemoteOperationRequest(request)) return complete(undefined, invalidRequestError());
		const requestCopy = cloneRequest(request);
		addArtifacts(artifacts, requestCopy.artifactRefs);
		// Credential-dependent operations are gated before any deadline or
		// cancellation check: an unverified, unknown, terminal, expired, or
		// quarantined (`revocation_unknown`) lease refuses the operation with
		// `invalid` and zero provider invocations. The check is read-only and
		// runs exactly once; it never drives deadline, cancel, or heartbeat.
		if (requestCopy.taskLease !== undefined) {
			const verified = options.taskLeaseVerifier === undefined
				? undefined
				: verifyTaskLease(options.taskLeaseVerifier, requestCopy.taskLease, requestCopy);
			if (verified === undefined) return complete(undefined, invalidRequestError());
			taskLeaseVerified = verified;
		}
		const current = safeNow(options.now);
		if (options.signal?.aborted) {
			cancellation = "cancelled";
			return complete(undefined, errorInfo("cancelled", sideEffects));
		}
		if (requestCopy.deadlineAt !== undefined && safeDateMs(requestCopy.deadlineAt) <= safeDateMs(current)) {
			cancellation = "deadline";
			return complete(undefined, errorInfo("deadline", sideEffects));
		}
		if (requestCopy.lease !== undefined && safeDateMs(requestCopy.lease.expiresAt) <= safeDateMs(current)) {
			cancellation = "deadline";
			return complete(undefined, errorInfo("deadline", sideEffects));
		}

		const signalListener = (): void => {
			void requestCancellation("cancelled");
		};
		options.signal?.addEventListener("abort", signalListener, { once: true });
		if (requestCopy.deadlineAt !== undefined) {
			deadlineTimer = setTimer(
				() => void requestCancellation("deadline"),
				timerFor(requestCopy.deadlineAt as string, safeNow(options.now)),
			);
		}
		if (lease !== undefined) {
			leaseTimer = setTimer(
				() => void requestCancellation("deadline"),
				timerFor(lease.expiresAt, safeNow(options.now)),
			);
		}

		if (controller.signal.aborted || cancellation !== undefined) {
			options.signal?.removeEventListener("abort", signalListener);
			return complete(undefined, errorInfo(cancellation ?? "cancelled", sideEffects));
		}
		startedAt = safeNow(options.now);
		providerStarted = true;
		try {
			const result = await invoker.execute(requestCopy, context);
			if (controller.signal.aborted || cancellation !== undefined || cancellationFailed) {
				if (cancellationFailed) return complete(undefined, errorInfo("side-effect-unknown", "unknown"));
				return complete(undefined, errorInfo(cancellation ?? "cancelled", sideEffects));
			}
			return complete(result, undefined);
		} catch (error) {
			const providerInfo = error instanceof RemoteOperationError ? error : undefined;
			if (controller.signal.aborted || cancellation !== undefined || cancellationFailed) {
				if (cancellationFailed) return complete(undefined, errorInfo("side-effect-unknown", "unknown"));
				return complete(undefined, errorInfo(cancellation ?? "cancelled", sideEffects, providerInfo));
			}
			return complete(undefined, errorInfoFromUnknown(error, sideEffects));
		} finally {
			options.signal?.removeEventListener("abort", signalListener);
			if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
			if (leaseTimer !== undefined) clearTimeout(leaseTimer);
		}
	};

	const receipt = run();

	return {
		operationId,
		receipt,
		cancel: () => requestCancellation("cancelled"),
		heartbeat: async () => {
			if (ended || !isRemoteOperationRequest(request) || lease === undefined) {
				throw new RemoteOperationError("invalid");
			}
			if (controller.signal.aborted || cancellation !== undefined) {
				throw new RemoteOperationError(cancellation ?? "cancelled");
			}
			heartbeatSequence += 1;
			// Operation heartbeats renew only the operation lease and never
			// advance a Task Lease sequence; the Task Lease has its own store
			// heartbeat contract that this boundary never calls.
			const refreshed = await invoker.heartbeat({
				operationId,
				leaseId: lease.leaseId,
				sequence: heartbeatSequence,
				sentAt: safeNow(options.now),
			});
			if (!validateLease(refreshed) || safeDateMs(refreshed.expiresAt) <= safeDateMs(safeNow(options.now))) {
				throw new RemoteOperationError("invalid");
			}
			lease = cloneLease(refreshed);
			if (leaseTimer !== undefined) clearTimeout(leaseTimer);
			leaseTimer = setTimer(
				() => void requestCancellation("deadline"),
				timerFor(lease.expiresAt, safeNow(options.now)),
			);
			return cloneLease(lease);
		},
	};
}

/** Await the terminal operation receipt. */
export async function executeRemoteOperation(
	invoker: RemoteOperationInvoker,
	request: RemoteOperationRequest,
	options: RemoteOperationStartOptions = {},
): Promise<RemoteOperationReceipt> {
	return startRemoteOperation(invoker, request, options).receipt;
}

/**
 * Adapt a Session ledger to the remote-neutral operation contract. The entry
 * contains only the validated terminal receipt; the Session supplies its id
 * when the request did not carry one.
 */
export function createSessionRemoteOperationLedger(session: RemoteOperationLedgerSession): RemoteOperationLedger {
	return {
		record: (receipt) => {
			if (!isRemoteOperationReceipt(receipt)) throw new RemoteOperationError("invalid");
			const sessionId = session.getSessionId();
			if (!isSafeIdentifier(sessionId)) throw new RemoteOperationError("invalid");
			if (receipt.sessionId !== undefined && receipt.sessionId !== sessionId)
				throw new RemoteOperationError("invalid");
			const persistedReceipt: RemoteOperationReceipt = {
				...receipt,
				sessionId,
				artifactRefs: receipt.artifactRefs.map(cloneArtifactReference),
				...(receipt.taskLease === undefined ? {} : { taskLease: cloneTaskLeaseReference(receipt.taskLease) }),
				...(receipt.taskLeaseVerified === undefined
					? {}
					: { taskLeaseVerified: cloneTaskLeaseVerificationResult(receipt.taskLeaseVerified) }),
			};
			session.appendCustomEntry(REMOTE_OPERATION_CUSTOM_TYPE, {
				schemaVersion: REMOTE_OPERATION_LEDGER_SCHEMA_VERSION,
				receipt: persistedReceipt,
			});
		},
	};
}

/** Exported for contract fixtures and adapters that need a generic safe error mapping. */
export function toRemoteOperationErrorInfo(
	error: unknown,
	operationSideEffects: RemoteOperationSideEffectState = "unknown",
): RemoteOperationErrorInfo {
	return errorInfoFromUnknown(error, operationSideEffects);
}

/**
 * Bounded external terminal facts that may be mapped into the safe Remote
 * Operation receipt contract. Only the terminal status, canonical endedAt,
 * safe artifact references, the Remote Operation side-effect vocabulary, a
 * bounded stable error code, and safe binding refs are accepted. Prompts,
 * transcripts, credentials, paths, URLs,
 * headers, and raw protocol objects are rejected by the exact-shape guard.
 */
export interface RemoteOperationReceiptInput {
	readonly operationId: RemoteOperationId;
	readonly status: "completed" | "failed" | "cancelled";
	readonly endedAt: string;
	readonly artifactRefs: ReadonlyArray<RemoteArtifactReference>;
	readonly sideEffects: RemoteOperationSideEffectState;
	readonly error?: {
		readonly code: string;
		readonly retryable: boolean;
		readonly sideEffects: RemoteOperationSideEffectState;
	};
	readonly runId?: RunId;
	readonly sessionId?: SessionId;
	readonly capabilityBindingId?: string;
	readonly modelBindingId?: string;
	readonly policyBindingId?: string;
}

const REMOTE_OPERATION_RECEIPT_INPUT_KEYS = new Set([
	"operationId",
	"status",
	"endedAt",
	"artifactRefs",
	"sideEffects",
	"error",
	"runId",
	"sessionId",
	"capabilityBindingId",
	"modelBindingId",
	"policyBindingId",
]);
const REMOTE_OPERATION_RECEIPT_INPUT_ERROR_KEYS = new Set(["code", "retryable", "sideEffects"]);

function isRemoteOperationReceiptInputError(value: unknown): boolean {
	if (!isRecord(value) || Object.keys(value).some((key) => !REMOTE_OPERATION_RECEIPT_INPUT_ERROR_KEYS.has(key)))
		return false;
	return (
		typeof value.code === "string" &&
		SAFE_RECEIPT_INPUT_ERROR_CODE_PATTERN.test(value.code) &&
		typeof value.retryable === "boolean" &&
		REMOTE_OPERATION_SIDE_EFFECT_STATES.includes(value.sideEffects as RemoteOperationSideEffectState)
	);
}

/** Exact-shape guard for bounded external terminal facts entering the receipt contract. */
export function isRemoteOperationReceiptInput(value: unknown): value is RemoteOperationReceiptInput {
	if (!isRecord(value) || Object.keys(value).some((key) => !REMOTE_OPERATION_RECEIPT_INPUT_KEYS.has(key)))
		return false;
	if (!isSafeIdentifier(value.operationId)) return false;
	if (!REMOTE_OPERATION_TERMINAL_STATUSES.includes(value.status as RemoteOperationTerminalStatus)) return false;
	if (!isCanonicalTimestamp(value.endedAt) || !isSafeArtifactReferenceList(value.artifactRefs)) return false;
	if (!REMOTE_OPERATION_SIDE_EFFECT_STATES.includes(value.sideEffects as RemoteOperationSideEffectState))
		return false;
	if (value.error !== undefined && !isRemoteOperationReceiptInputError(value.error)) return false;
	if (value.runId !== undefined && !isSafeIdentifier(value.runId)) return false;
	if (value.sessionId !== undefined && !isSafeIdentifier(value.sessionId)) return false;
	if (value.capabilityBindingId !== undefined && !isSafeIdentifier(value.capabilityBindingId)) return false;
	if (value.modelBindingId !== undefined && !isSafeIdentifier(value.modelBindingId)) return false;
	if (value.policyBindingId !== undefined && !isSafeIdentifier(value.policyBindingId)) return false;
	return true;
}

/**
 * Map bounded external terminal facts into a safe Remote Operation receipt.
 *
 * The mapping fails closed exactly like the operation machinery: unknown side
 * effects, and cancelled receipts that may carry side effects, become a
 * failed side-effect-unknown receipt that can never be retried. A reported
 * failure maps to the stable `invalid` category; the external stable error
 * code is not representable in the receipt error category and is never
 * copied. Error detail is dropped from completed and cancelled projections.
 * Returns undefined for malformed or identity-unsafe input.
 */
export function toRemoteOperationReceipt(value: unknown): RemoteOperationReceipt | undefined {
	if (!isRemoteOperationReceiptInput(value)) return undefined;
	const sideEffects = mergeSideEffectState(value.sideEffects, value.error?.sideEffects);
	const failClosed = sideEffects === "unknown" || (value.status === "cancelled" && sideEffects !== "none");
	const receipt: RemoteOperationReceipt = {
		schemaVersion: REMOTE_OPERATION_SCHEMA_VERSION,
		operationId: value.operationId,
		status: failClosed ? "failed" : value.status,
		...safeBindingRefs(value),
		endedAt: value.endedAt,
		artifactRefs: value.artifactRefs.map(cloneArtifactReference),
		sideEffects: failClosed ? "unknown" : sideEffects,
		...(failClosed
			? { error: errorInfo("side-effect-unknown", "unknown") }
			: value.status === "failed"
				? { error: { category: "invalid", code: "invalid", retryable: false, sideEffects } }
				: {}),
	};
	return isRemoteOperationReceipt(receipt) ? receipt : undefined;
}

/** Keep Run status vocabulary visible to consumers without creating a second status union. */
export type RemoteOperationRunStatus = RunStatus;
